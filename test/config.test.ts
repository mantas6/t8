import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  type ConfigFile,
  configDirFor,
  DEFAULT_SERVER_URL,
  deriveWsUrl,
  isExpired,
  normalizeServerUrl,
  parseConfigFile,
  planProfile,
  readConfigFile,
  resolveConfig,
  serializeConfigFile,
  slugify,
  storedTokenPath,
  withoutProfile,
  withProfile,
  writeConfigFile,
  writePrivateFile,
} from "../src/config.ts";
import { describeExpiry, profileEntries } from "../src/connect.ts";
import { rejectedTokenAdvice } from "../src/connection/connection.ts";

const HOME = "/home/user";

/** A flat (pre-profile) config, as parsed. */
const legacy = (fields: { server?: string; tokenFile?: string }): ConfigFile =>
  parseConfigFile(fields, "config.json");

describe("deriveWsUrl", () => {
  test("maps http to ws and appends the protocol param", () => {
    expect(deriveWsUrl("http://localhost:3773")).toBe(
      "ws://localhost:3773/ws?orchestrationProtocol=2",
    );
  });

  test("maps https to wss and keeps a base path", () => {
    expect(deriveWsUrl("https://example.com/t3/")).toBe(
      "wss://example.com/t3/ws?orchestrationProtocol=2",
    );
    expect(deriveWsUrl("https://example.com/t3")).toBe(
      "wss://example.com/t3/ws?orchestrationProtocol=2",
    );
  });

  test("drops query, fragment and credentials", () => {
    expect(deriveWsUrl("http://user:pw@host:1/?a=1#x")).toBe(
      "ws://host:1/ws?orchestrationProtocol=2",
    );
  });
});

describe("normalizeServerUrl", () => {
  test("accepts ws(s) and normalises to http(s)", () => {
    expect(normalizeServerUrl("ws://host:3773")).toBe("http://host:3773/");
    expect(normalizeServerUrl("wss://host")).toBe("https://host/");
  });

  test("rejects other schemes and garbage", () => {
    expect(() => normalizeServerUrl("ftp://host")).toThrow(ConfigError);
    expect(() => normalizeServerUrl("not a url")).toThrow(ConfigError);
  });
});

describe("configDirFor", () => {
  test("uses XDG_CONFIG_HOME when absolute", () => {
    expect(configDirFor({ XDG_CONFIG_HOME: "/xdg" }, HOME)).toBe("/xdg/t8");
  });

  test("ignores empty or relative XDG_CONFIG_HOME", () => {
    expect(configDirFor({}, HOME)).toBe("/home/user/.config/t8");
    expect(configDirFor({ XDG_CONFIG_HOME: "" }, HOME)).toBe("/home/user/.config/t8");
    expect(configDirFor({ XDG_CONFIG_HOME: "rel" }, HOME)).toBe("/home/user/.config/t8");
  });
});

describe("resolveConfig", () => {
  test("defaults", () => {
    const config = resolveConfig({ flags: {}, env: {}, homeDir: HOME });
    expect(config.serverUrl).toBe(`${DEFAULT_SERVER_URL}/`);
    expect(config.wsUrl).toBe("ws://localhost:3773/ws?orchestrationProtocol=2");
    expect(config.token).toEqual({ kind: "file", path: "/home/user/.config/t8/token" });
  });

  test("config file values, relative tokenFile resolves against the config dir", () => {
    const config = resolveConfig({
      flags: {},
      env: { XDG_CONFIG_HOME: "/xdg" },
      homeDir: HOME,
      file: legacy({ server: "https://file.example", tokenFile: "secrets/tok" }),
    });
    expect(config.serverUrl).toBe("https://file.example/");
    expect(config.token).toEqual({ kind: "file", path: "/xdg/t8/secrets/tok" });
  });

  test("config file tokenFile may use ~ or be absolute", () => {
    const tilde = resolveConfig({
      flags: {},
      env: {},
      homeDir: HOME,
      file: legacy({ tokenFile: "~/t" }),
    });
    expect(tilde.token).toEqual({ kind: "file", path: "/home/user/t" });
    const abs = resolveConfig({
      flags: {},
      env: {},
      homeDir: HOME,
      file: legacy({ tokenFile: "/abs/t" }),
    });
    expect(abs.token).toEqual({ kind: "file", path: "/abs/t" });
  });

  test("env beats config file", () => {
    const config = resolveConfig({
      flags: {},
      env: { T8_SERVER: "http://env:1", T8_TOKEN_FILE: "/env/token" },
      homeDir: HOME,
      file: legacy({ server: "http://file:2", tokenFile: "file-token" }),
    });
    expect(config.serverUrl).toBe("http://env:1/");
    expect(config.token).toEqual({ kind: "file", path: "/env/token" });
  });

  test("T8_TOKEN beats T8_TOKEN_FILE", () => {
    const config = resolveConfig({
      flags: {},
      env: { T8_TOKEN: " secret ", T8_TOKEN_FILE: "/env/token" },
      homeDir: HOME,
    });
    expect(config.token).toEqual({ kind: "env", token: "secret" });
  });

  test("flags beat env and config file", () => {
    const config = resolveConfig({
      flags: { server: "https://flag:3", tokenFile: "/flag/token" },
      env: { T8_SERVER: "http://env:1", T8_TOKEN: "secret" },
      homeDir: HOME,
      file: legacy({ server: "http://file:2", tokenFile: "file-token" }),
    });
    expect(config.serverUrl).toBe("https://flag:3/");
    expect(config.wsUrl).toBe("wss://flag:3/ws?orchestrationProtocol=2");
    expect(config.token).toEqual({ kind: "file", path: "/flag/token" });
  });

  test("blank values fall through", () => {
    const config = resolveConfig({
      flags: { server: "  " },
      env: { T8_SERVER: "" },
      homeDir: HOME,
      file: legacy({ server: "http://file:2" }),
    });
    expect(config.serverUrl).toBe("http://file:2/");
  });
});

describe("parseConfigFile", () => {
  test("reads the flat shape as a profile named default", () => {
    expect(parseConfigFile({ server: "http://x", tokenFile: "t", extra: 1 }, "c.json")).toEqual({
      default: "default",
      servers: { default: { server: "http://x", tokenFile: "t" } },
      legacy: true,
    });
    expect(parseConfigFile({}, "c.json")).toEqual({ servers: {} });
  });

  test("reads profiles and ignores unknown keys", () => {
    expect(
      parseConfigFile(
        {
          default: "home",
          servers: { home: { server: "http://h", tokenFile: "home.token", label: "ag", x: 1 } },
        },
        "c.json",
      ),
    ).toEqual({
      default: "home",
      servers: { home: { server: "http://h", tokenFile: "home.token", label: "ag" } },
    });
  });

  test("rejects non-objects and wrong types", () => {
    expect(() => parseConfigFile([], "c.json")).toThrow(ConfigError);
    expect(() => parseConfigFile({ server: 1 }, "c.json")).toThrow(ConfigError);
    expect(() => parseConfigFile({ servers: [] }, "c.json")).toThrow(ConfigError);
    expect(() => parseConfigFile({ servers: { a: { server: 2 } } }, "c.json")).toThrow(ConfigError);
    expect(() => parseConfigFile({ servers: {}, default: 3 }, "c.json")).toThrow(ConfigError);
  });

  test("the written shape reads back the same", () => {
    const file: ConfigFile = {
      default: "b",
      servers: { b: { server: "http://b/", tokenFile: "b.token" }, a: { server: "http://a/" } },
    };
    const text = serializeConfigFile(file);
    expect(Object.keys(JSON.parse(text).servers)).toEqual(["a", "b"]);
    expect(parseConfigFile(JSON.parse(text), "c.json")).toEqual(file);
  });
});

describe("profiles", () => {
  const file: ConfigFile = {
    default: "home",
    servers: {
      home: { server: "http://home:3773/", tokenFile: "home.token", label: "ag" },
      work: {
        server: "https://work.example/",
        tokenFile: "/secrets/work",
        environmentId: "env-work",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    },
  };

  test("the default profile is used when none is named", () => {
    const config = resolveConfig({
      flags: {},
      env: { XDG_CONFIG_HOME: "/xdg" },
      homeDir: HOME,
      file,
    });
    expect(config.serverUrl).toBe("http://home:3773/");
    expect(config.token).toEqual({ kind: "file", path: "/xdg/t8/home.token" });
    expect(config.profile).toEqual({ name: "home", label: "ag" });
  });

  test("--profile beats T8_PROFILE beats the default", () => {
    const byEnv = resolveConfig({ flags: {}, env: { T8_PROFILE: "work" }, homeDir: HOME, file });
    expect(byEnv.serverUrl).toBe("https://work.example/");
    expect(byEnv.token).toEqual({ kind: "file", path: "/secrets/work" });
    expect(byEnv.profile?.expiresAt).toBe("2030-01-01T00:00:00.000Z");
    const byFlag = resolveConfig({
      flags: { profile: "home" },
      env: { T8_PROFILE: "work" },
      homeDir: HOME,
      file,
    });
    expect(byFlag.profile?.name).toBe("home");
  });

  test("flags and env still override the profile's server and token", () => {
    const config = resolveConfig({
      flags: { profile: "work", server: "http://flag:1" },
      env: { T8_TOKEN: "secret" },
      homeDir: HOME,
      file,
    });
    expect(config.serverUrl).toBe("http://flag:1/");
    expect(config.token).toEqual({ kind: "env", token: "secret" });
    expect(config.profile?.name).toBe("work");
  });

  test("an unknown profile is an error naming the saved ones", () => {
    expect(() =>
      resolveConfig({ flags: { profile: "nope" }, env: {}, homeDir: HOME, file }),
    ).toThrow('unknown profile "nope" (saved: home, work)');
    expect(() =>
      resolveConfig({ flags: {}, env: {}, homeDir: HOME, file: { default: "gone", servers: {} } }),
    ).toThrow(ConfigError);
  });

  test("a single profile without a default is used; none means the defaults", () => {
    const single = resolveConfig({
      flags: {},
      env: {},
      homeDir: HOME,
      file: { servers: { only: { server: "http://only/", tokenFile: "only.token" } } },
    });
    expect(single.profile?.name).toBe("only");
    const none = resolveConfig({ flags: {}, env: {}, homeDir: HOME, file: { servers: {} } });
    expect(none.profile).toBeNull();
    expect(none.serverUrl).toBe(`${DEFAULT_SERVER_URL}/`);
  });

  test("planProfile: slug of the label, reuse by environment, numbered on clash", () => {
    expect(planProfile(undefined, { environmentId: "e1", label: "My Mac Studio!" })).toEqual({
      name: "my-mac-studio",
      created: true,
      becomesDefault: true,
    });
    expect(planProfile(file, { environmentId: "env-work", label: "renamed" })).toEqual({
      name: "work",
      created: false,
      becomesDefault: false,
    });
    expect(planProfile(file, { environmentId: "e9", label: "Home" }).name).toBe("home-2");
    expect(planProfile(file, { environmentId: "e9", label: "x", makeDefault: true })).toEqual({
      name: "x",
      created: true,
      becomesDefault: true,
    });
    expect(planProfile(file, { name: "home", environmentId: "e9", label: "x" })).toEqual({
      name: "home",
      created: false,
      becomesDefault: true,
    });
    expect(() => planProfile(file, { name: "../evil", environmentId: "e", label: "x" })).toThrow(
      ConfigError,
    );
  });

  test("the legacy profile keeps working next to a new one", () => {
    const old = legacy({ server: "http://localhost:3773", tokenFile: "token" });
    const plan = planProfile(old, { environmentId: "e1", label: "ag" });
    expect(plan).toEqual({ name: "ag", created: true, becomesDefault: false });
    const next = withProfile(old, plan.name, { server: "http://h/", tokenFile: "ag.token" }, false);
    expect(next.default).toBe("default");
    const config = resolveConfig({ flags: {}, env: {}, homeDir: HOME, file: next });
    expect(config.token).toEqual({ kind: "file", path: "/home/user/.config/t8/token" });
    expect(parseConfigFile(JSON.parse(serializeConfigFile(next)), "c").legacy).toBeUndefined();
  });

  test("withoutProfile moves the default to the only remaining profile", () => {
    expect(withoutProfile(file, "home")).toEqual({
      default: "work",
      servers: { work: file.servers.work ?? {} },
    });
    expect(withoutProfile(file, "work").default).toBe("home");
    const three = withProfile(file, "c", { server: "http://c/" }, false);
    expect(withoutProfile(three, "home").default).toBeUndefined();
  });

  test("slugify", () => {
    expect(slugify("Ägir's  Box (2)")).toBe("agir-s-box-2");
    expect(slugify("!!!")).toBe("server");
    expect(slugify("a".repeat(50))).toHaveLength(32);
  });

  test("storedTokenPath is relative inside the config dir", () => {
    expect(storedTokenPath("/c/t8", "/c/t8/home.token")).toBe("home.token");
    expect(storedTokenPath("/c/t8", "/elsewhere/t")).toBe("/elsewhere/t");
  });

  test("expiry helpers", () => {
    const now = Date.parse("2026-11-02T00:00:00.000Z");
    expect(isExpired("2026-11-01T00:00:00.000Z", now)).toBe(true);
    expect(isExpired("2026-12-01T00:00:00.000Z", now)).toBe(false);
    expect(isExpired(undefined, now)).toBe(false);
    expect(describeExpiry("2026-12-02T00:00:00.000Z", now)).toBe("2026-12-02 (in 30 days)");
    expect(describeExpiry("2026-11-01T00:00:00.000Z", now)).toBe("expired 2026-11-01");
    expect(describeExpiry(undefined, now)).toBe("-");
    const entries = profileEntries({
      servers: { a: { expiresAt: "2000-01-01T00:00:00.000Z" }, b: {} },
    });
    expect(entries.map((entry) => [entry.name, entry.isDefault, entry.expired])).toEqual([
      ["a", false, true],
      ["b", false, false],
    ]);
  });

  test("a rejected token points at t8 connect", () => {
    const now = Date.parse("2026-11-02T00:00:00.000Z");
    expect(rejectedTokenAdvice({ profile: null }, now)).toContain("t8 connect");
    expect(
      rejectedTokenAdvice(
        { profile: { name: "home", expiresAt: "2026-10-01T00:00:00.000Z" } },
        now,
      ),
    ).toBe(
      'the token saved for profile "home" expired on 2026-10-01; run `t8 connect` with a new pairing link',
    );
  });
});

describe("config files on disk", () => {
  const directory = mkdtempSync(join(tmpdir(), "t8-config-test-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  test("writes atomically with mode 600 and reads back", async () => {
    const configDir = join(directory, "t8");
    await writeConfigFile(configDir, { default: "a", servers: { a: { server: "http://a/" } } });
    const path = join(configDir, "config.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(await readConfigFile(path)).toEqual({
      default: "a",
      servers: { a: { server: "http://a/" } },
    });
    await writePrivateFile(join(configDir, "a.token"), "tok\n");
    expect(statSync(join(configDir, "a.token")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(configDir, "a.token"), "utf8")).toBe("tok\n");
  });

  test("a flat config file still loads", async () => {
    const path = join(directory, "flat.json");
    writeFileSync(path, JSON.stringify({ server: "http://localhost:3773", tokenFile: "token" }));
    const file = await readConfigFile(path);
    expect(file?.servers.default).toEqual({ server: "http://localhost:3773", tokenFile: "token" });
    expect(await readConfigFile(join(directory, "missing.json"))).toBeUndefined();
  });
});
