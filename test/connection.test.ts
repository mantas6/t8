import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { deriveWsUrl, type ResolvedConfig } from "../src/config.ts";
import * as ConnectionModule from "../src/connection/connection.ts";
import { Connection, type ConnectionStatus } from "../src/connection/connection.ts";
import { awaitConnected, NotConnectedError } from "../src/tui/backend.ts";

// A local HTTP server without the T3 API: the version gate fails as "unreachable".
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("not here", { status: 404 }),
});
const directory = mkdtempSync(join(tmpdir(), "t3tui-connection-test-"));
afterAll(() => {
  server.stop(true);
  rmSync(directory, { recursive: true, force: true });
});

function config(tokenFile: string): ResolvedConfig {
  const serverUrl = `http://127.0.0.1:${server.port}/`;
  return {
    serverUrl,
    wsUrl: deriveWsUrl(serverUrl),
    token: { kind: "file", path: join(directory, tokenFile) },
    configDir: directory,
  };
}

const waitFor = (
  status: SubscriptionRef.SubscriptionRef<ConnectionStatus>,
  predicate: (current: ConnectionStatus) => boolean,
) =>
  SubscriptionRef.changes(status).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.timeout("5 seconds"),
  );

describe("Connection", () => {
  test(":reconnect restarts the supervisor after a fatal failure and re-reads the token", async () => {
    const program = Effect.gen(function* () {
      const connection = yield* ConnectionModule.make(config("token-a"));
      const failed = yield* waitFor(connection.status, (current) => current._tag === "failed");
      expect(
        failed._tag === "Some" && failed.value._tag === "failed" && failed.value.error.reason,
      ).toBe("config");
      // While failed, commands are refused at once.
      const refused = yield* awaitConnected("2 seconds").pipe(
        Effect.provideService(Connection, connection),
        Effect.flip,
        Effect.timeout("500 millis"),
      );
      expect(refused).toBeInstanceOf(NotConnectedError);
      expect(refused.message).toContain("token file not found");

      writeFileSync(join(directory, "token-a"), "test-token\n");
      yield* connection.forceReconnect;
      const next = yield* waitFor(connection.status, (current) => current._tag === "disconnected");
      expect(
        next._tag === "Some" && next.value._tag === "disconnected" && next.value.reason,
      ).toContain("404");
    }).pipe(Effect.scoped);
    await Effect.runPromise(program);
  });

  test("commands fail fast while disconnected", async () => {
    const status = await Effect.runPromise(
      SubscriptionRef.make<ConnectionStatus>({
        _tag: "disconnected",
        reason: "connection closed",
        attempt: 1,
        retryAt: Date.now() + 10_000,
      }),
    );
    const connection = Layer.succeed(Connection)(
      Connection.of({
        config: config("unused"),
        status,
        session: Effect.never,
        client: Effect.never,
        sessions: Stream.never,
        subscribe: () => Stream.never,
        reconnectNow: Effect.void,
        forceReconnect: Effect.void,
      }),
    );
    const started = Date.now();
    const error = await Effect.runPromise(
      awaitConnected("50 millis").pipe(Effect.flip, Effect.provide(connection)),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error).toBeInstanceOf(NotConnectedError);
    expect(error.message).toContain("disconnected: connection closed");
  });
});
