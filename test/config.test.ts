import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  configDirFor,
  DEFAULT_SERVER_URL,
  deriveWsUrl,
  normalizeServerUrl,
  parseConfigFile,
  resolveConfig,
} from "../src/config.ts";

const HOME = "/home/user";

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
    expect(configDirFor({ XDG_CONFIG_HOME: "/xdg" }, HOME)).toBe("/xdg/t3tui");
  });

  test("ignores empty or relative XDG_CONFIG_HOME", () => {
    expect(configDirFor({}, HOME)).toBe("/home/user/.config/t3tui");
    expect(configDirFor({ XDG_CONFIG_HOME: "" }, HOME)).toBe("/home/user/.config/t3tui");
    expect(configDirFor({ XDG_CONFIG_HOME: "rel" }, HOME)).toBe("/home/user/.config/t3tui");
  });
});

describe("resolveConfig", () => {
  test("defaults", () => {
    const config = resolveConfig({ flags: {}, env: {}, homeDir: HOME });
    expect(config.serverUrl).toBe(`${DEFAULT_SERVER_URL}/`);
    expect(config.wsUrl).toBe("ws://localhost:3773/ws?orchestrationProtocol=2");
    expect(config.token).toEqual({ kind: "file", path: "/home/user/.config/t3tui/token" });
  });

  test("config file values, relative tokenFile resolves against the config dir", () => {
    const config = resolveConfig({
      flags: {},
      env: { XDG_CONFIG_HOME: "/xdg" },
      homeDir: HOME,
      file: { server: "https://file.example", tokenFile: "secrets/tok" },
    });
    expect(config.serverUrl).toBe("https://file.example/");
    expect(config.token).toEqual({ kind: "file", path: "/xdg/t3tui/secrets/tok" });
  });

  test("config file tokenFile may use ~ or be absolute", () => {
    const tilde = resolveConfig({ flags: {}, env: {}, homeDir: HOME, file: { tokenFile: "~/t" } });
    expect(tilde.token).toEqual({ kind: "file", path: "/home/user/t" });
    const abs = resolveConfig({ flags: {}, env: {}, homeDir: HOME, file: { tokenFile: "/abs/t" } });
    expect(abs.token).toEqual({ kind: "file", path: "/abs/t" });
  });

  test("env beats config file", () => {
    const config = resolveConfig({
      flags: {},
      env: { T3TUI_SERVER: "http://env:1", T3TUI_TOKEN_FILE: "/env/token" },
      homeDir: HOME,
      file: { server: "http://file:2", tokenFile: "file-token" },
    });
    expect(config.serverUrl).toBe("http://env:1/");
    expect(config.token).toEqual({ kind: "file", path: "/env/token" });
  });

  test("T3TUI_TOKEN beats T3TUI_TOKEN_FILE", () => {
    const config = resolveConfig({
      flags: {},
      env: { T3TUI_TOKEN: " secret ", T3TUI_TOKEN_FILE: "/env/token" },
      homeDir: HOME,
    });
    expect(config.token).toEqual({ kind: "env", token: "secret" });
  });

  test("flags beat env and config file", () => {
    const config = resolveConfig({
      flags: { server: "https://flag:3", tokenFile: "/flag/token" },
      env: { T3TUI_SERVER: "http://env:1", T3TUI_TOKEN: "secret" },
      homeDir: HOME,
      file: { server: "http://file:2", tokenFile: "file-token" },
    });
    expect(config.serverUrl).toBe("https://flag:3/");
    expect(config.wsUrl).toBe("wss://flag:3/ws?orchestrationProtocol=2");
    expect(config.token).toEqual({ kind: "file", path: "/flag/token" });
  });

  test("blank values fall through", () => {
    const config = resolveConfig({
      flags: { server: "  " },
      env: { T3TUI_SERVER: "" },
      homeDir: HOME,
      file: { server: "http://file:2" },
    });
    expect(config.serverUrl).toBe("http://file:2/");
  });
});

describe("parseConfigFile", () => {
  test("accepts the documented shape and ignores unknown keys", () => {
    expect(parseConfigFile({ server: "http://x", tokenFile: "t", extra: 1 }, "c.json")).toEqual({
      server: "http://x",
      tokenFile: "t",
    });
  });

  test("rejects non-objects and wrong types", () => {
    expect(() => parseConfigFile([], "c.json")).toThrow(ConfigError);
    expect(() => parseConfigFile({ server: 1 }, "c.json")).toThrow(ConfigError);
  });
});
