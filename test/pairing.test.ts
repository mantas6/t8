import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

import { readConfigFile } from "../src/config.ts";
import { connectAndSave, forgetProfile } from "../src/connect.ts";
import {
  describeTokenExchangeFailure,
  PAIRING_SCOPES,
  PairingError,
  pair,
  parsePairingTarget,
  tokenExchangeRequest,
} from "../src/pairing.ts";

describe("parsePairingTarget", () => {
  test("direct link: token in the hash, server is the origin", () => {
    expect(parsePairingTarget({ pairingUrl: "https://host.example:3773/pair#token=abc" })).toEqual({
      credential: "abc",
      serverUrl: "https://host.example:3773/",
    });
    expect(parsePairingTarget({ pairingUrl: "  http://10.0.0.2:3773/pair#token=x%20y  " })).toEqual(
      { credential: "x y", serverUrl: "http://10.0.0.2:3773/" },
    );
  });

  test("direct link: ?token= when the hash has none; the hash wins otherwise", () => {
    expect(parsePairingTarget({ pairingUrl: "http://h:1/pair?token=q" }).credential).toBe("q");
    expect(parsePairingTarget({ pairingUrl: "http://h:1/pair?token=q#token=h" }).credential).toBe(
      "h",
    );
  });

  test("hosted link: the server is the host parameter", () => {
    expect(
      parsePairingTarget({
        pairingUrl:
          "https://app.t3.codes/pair?host=https%3A%2F%2Fbox.tailnet.ts.net%2F&label=Box#token=tok",
      }),
    ).toEqual({ credential: "tok", serverUrl: "https://box.tailnet.ts.net/" });
    expect(
      parsePairingTarget({ pairingUrl: "https://app.t3.codes/pair?host=box:3773#token=tok" })
        .serverUrl,
    ).toBe("https://box:3773/");
    expect(
      parsePairingTarget({ pairingUrl: "https://app.t3.codes/pair?host=ws://box:3773/ws#token=t" })
        .serverUrl,
    ).toBe("http://box:3773/");
  });

  test("--host and --code: a bare host:port means https; the path is dropped", () => {
    expect(parsePairingTarget({ host: "box:3773", code: "c" })).toEqual({
      credential: "c",
      serverUrl: "https://box:3773/",
    });
    expect(parsePairingTarget({ host: "http://localhost:3773/some/path", code: " c " })).toEqual({
      credential: "c",
      serverUrl: "http://localhost:3773/",
    });
    expect(parsePairingTarget({ host: "wss://box", code: "c" }).serverUrl).toBe("https://box/");
  });

  test("errors are PairingError(invalid-input) and never echo the credential", () => {
    const cases = [
      { pairingUrl: "not a url" },
      { pairingUrl: "ftp://h/pair#token=secret" },
      { pairingUrl: "https://h/pair" },
      { pairingUrl: "https://h/pair#token=" },
      { pairingUrl: "https://h/pair#token=secret", code: "c" },
      { host: "box" },
      { code: "secret" },
      { host: "ftp://box", code: "secret" },
      {},
    ];
    for (const input of cases) {
      let caught: unknown;
      try {
        parsePairingTarget(input);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PairingError);
      expect((caught as PairingError).reason).toBe("invalid-input");
      expect((caught as PairingError).message).not.toContain("secret");
    }
  });
});

describe("token exchange", () => {
  test("request fields", () => {
    expect(tokenExchangeRequest("cred", { os: "Linux" })).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "cred",
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "orchestration:read orchestration:operate",
      client_label: "t3tui",
      client_device_type: "desktop",
      client_os: "Linux",
    });
    expect(PAIRING_SCOPES).toEqual(["orchestration:read", "orchestration:operate"]);
  });

  test("error answers map to clear messages", () => {
    const used = describeTokenExchangeFailure(401, {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "t",
    });
    expect(used.reason).toBe("rejected");
    expect(used.message).toContain("expired, was already used, or was revoked");
    const scope = describeTokenExchangeFailure(400, {
      _tag: "EnvironmentRequestInvalidError",
      code: "invalid_request",
      reason: "scope_not_granted",
      traceId: "t",
    });
    expect(scope.reason).toBe("scope");
    expect(scope.message).toContain("not used up");
    expect(describeTokenExchangeFailure(500, "nonsense").reason).toBe("server");
    expect(describeTokenExchangeFailure(401, undefined).reason).toBe("rejected");
  });
});

// A fake T3 server: the environment descriptor and the token endpoint.
const redeemed: Array<Record<string, string>> = [];
let protocol = 2;
const used = new Set<string>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/t3/environment") {
      return Response.json({
        environmentId: "env-fake",
        label: "Fake Box",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.1.2",
        orchestrationProtocolVersion: protocol,
        capabilities: {},
      });
    }
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
      const form = Object.fromEntries(new URLSearchParams(await request.text()));
      redeemed.push(form);
      const credential = form.subject_token ?? "";
      if (credential === "readonly-scope") {
        return Response.json(
          {
            _tag: "EnvironmentRequestInvalidError",
            code: "invalid_request",
            reason: "scope_not_granted",
            traceId: "t",
          },
          { status: 400 },
        );
      }
      if (used.has(credential) || !credential.startsWith("good")) {
        return Response.json(
          {
            _tag: "EnvironmentAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_credential",
            traceId: "t",
          },
          { status: 401 },
        );
      }
      used.add(credential);
      return Response.json({
        access_token: `access-for-${credential}`,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 2_592_000,
        scope: "orchestration:read orchestration:operate",
      });
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
const directory = mkdtempSync(join(tmpdir(), "t3tui-pairing-test-"));
afterAll(() => {
  server.stop(true);
  rmSync(directory, { recursive: true, force: true });
});

const run = <A>(effect: Effect.Effect<A, PairingError>) => Effect.runPromise(Effect.result(effect));

describe("pair", () => {
  test("redeems a link once; the second try says the link is used", async () => {
    const first = await run(pair({ pairingUrl: `${base}/pair#token=good-1` }));
    expect(first._tag).toBe("Success");
    if (first._tag === "Success") {
      expect(first.success.serverUrl).toBe(`${base}/`);
      expect(first.success.environment.label).toBe("Fake Box");
      expect(first.success.issued.token).toBe("access-for-good-1");
      const days = (Date.parse(first.success.issued.expiresAt) - Date.now()) / 86_400_000;
      expect(Math.round(days)).toBe(30);
    }
    expect(redeemed.at(-1)).toMatchObject({
      subject_token: "good-1",
      scope: "orchestration:read orchestration:operate",
      client_label: "t3tui",
      client_device_type: "desktop",
    });
    const second = await run(pair({ pairingUrl: `${base}/pair#token=good-1` }));
    expect(second._tag === "Failure" && second.failure.reason).toBe("rejected");
  });

  test("an incompatible or unreachable server is not sent the credential", async () => {
    const before = redeemed.length;
    protocol = 3;
    const mismatch = await run(pair({ host: base, code: "good-2" }));
    protocol = 2;
    expect(mismatch._tag === "Failure" && mismatch.failure.reason).toBe("incompatible");
    expect(mismatch._tag === "Failure" && mismatch.failure.message).toContain("was not used");
    const down = await run(pair({ host: "http://127.0.0.1:1", code: "good-2" }));
    expect(down._tag === "Failure" && down.failure.reason).toBe("unreachable");
    expect(redeemed.length).toBe(before);
  });

  test("a link without the needed scopes says so", async () => {
    const result = await run(pair({ host: base, code: "readonly-scope" }));
    expect(result._tag === "Failure" && result.failure.reason).toBe("scope");
  });
});

describe("connectAndSave", () => {
  const env = { XDG_CONFIG_HOME: directory };

  test("saves the token (600) and the profile, updates it on re-pairing, forgets it", async () => {
    const saved = await connectAndSave({ pairingUrl: `${base}/pair#token=good-3` }, {}, env);
    expect(saved).toMatchObject({
      name: "fake-box",
      created: true,
      isDefault: true,
      server: `${base}/`,
      label: "Fake Box",
      environmentId: "env-fake",
    });
    const tokenPath = join(directory, "t3tui", "fake-box.token");
    expect(saved.tokenPath).toBe(tokenPath);
    expect(readFileSync(tokenPath, "utf8")).toBe("access-for-good-3\n");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    const file = await readConfigFile(join(directory, "t3tui", "config.json"));
    expect(file?.default).toBe("fake-box");
    expect(file?.servers["fake-box"]).toMatchObject({
      server: `${base}/`,
      tokenFile: "fake-box.token",
      environmentId: "env-fake",
      label: "Fake Box",
    });
    expect(JSON.stringify(file)).not.toContain("access-for");

    // Same environment again: the profile is updated, not duplicated.
    const again = await connectAndSave({ host: base, code: "good-4" }, {}, env);
    expect(again).toMatchObject({ name: "fake-box", created: false, isDefault: true });
    expect(readFileSync(tokenPath, "utf8")).toBe("access-for-good-4\n");

    // An explicit name adds a second profile; --default moves the default.
    const named = await connectAndSave(
      { host: base, code: "good-5" },
      { name: "second", makeDefault: true },
      env,
    );
    expect(named).toMatchObject({ name: "second", created: true, isDefault: true });

    // A failed pairing leaves the config alone.
    await expect(connectAndSave({ host: base, code: "good-5" }, {}, env)).rejects.toThrow(
      "already used",
    );

    const forgotten = await forgetProfile("second", { ...env, PATH: "" });
    expect(forgotten).toMatchObject({ token: "deleted", newDefault: "fake-box" });
    const after = await readConfigFile(join(directory, "t3tui", "config.json"));
    expect(Object.keys(after?.servers ?? {})).toEqual(["fake-box"]);
  });
});
