import { describe, expect, test } from "bun:test";
import { ORCHESTRATION_V2_WS_METHODS, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  setAutoSettle,
  settleThread,
  snoozeThread,
  supportsCapability,
  UnsupportedServerError,
  unsettleThread,
  unsnoozeThread,
} from "../src/commands.ts";
import { Connection, type Session } from "../src/connection/connection.ts";

/** A connection whose session records dispatched commands and advertises `capabilities`. */
function fakeConnection(capabilities: Record<string, boolean>) {
  const dispatched: Array<Record<string, unknown>> = [];
  const session = {
    generation: 1,
    environment: { label: "test", serverVersion: "0.0.0", capabilities },
    client: {
      [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: Record<string, unknown>) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
    },
  } as unknown as Session;
  const layer = Layer.succeed(Connection)(
    Connection.of({
      target: {} as never,
      setTarget: () => Effect.void,
      status: {} as never,
      session: Effect.succeed(session),
      client: Effect.succeed(session.client),
      sessions: {} as never,
      subscribe: () => ({}) as never,
      reconnectNow: Effect.void,
      forceReconnect: Effect.void,
    }),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, Connection>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  return { dispatched, run };
}

const THREAD = ThreadId.make("thread-1");
const ALL = { threadSettlement: true, threadSnooze: true, threadAutoSettleOptOut: true };

/** The payload without its random command id (checked to be a UUID). */
function payload(command: Record<string, unknown> | undefined) {
  const { commandId, ...rest } = command ?? {};
  expect(String(commandId)).toMatch(/^[0-9a-f-]{36}$/);
  return rest;
}

describe("settle and snooze commands", () => {
  test("payloads", async () => {
    const fake = fakeConnection(ALL);
    await fake.run(settleThread(THREAD));
    await fake.run(unsettleThread(THREAD));
    await fake.run(snoozeThread(THREAD, new Date(Date.UTC(2026, 10, 3, 8, 0))));
    await fake.run(unsnoozeThread(THREAD));
    await fake.run(setAutoSettle(THREAD, false));
    await fake.run(setAutoSettle(THREAD, true));
    expect(fake.dispatched.map(payload)).toEqual([
      { type: "thread.settle", threadId: "thread-1" },
      { type: "thread.unsettle", threadId: "thread-1", reason: "user" },
      { type: "thread.snooze", threadId: "thread-1", snoozedUntil: "2026-11-03T08:00:00.000Z" },
      { type: "thread.unsnooze", threadId: "thread-1", reason: "user" },
      { type: "thread.auto-settle.set", threadId: "thread-1", enabled: false },
      { type: "thread.auto-settle.set", threadId: "thread-1", enabled: true },
    ]);
    // Every command gets its own id.
    expect(new Set(fake.dispatched.map((command) => command.commandId)).size).toBe(6);
  });

  test("a server without the capability is not sent the command", async () => {
    const fake = fakeConnection({ threadSnooze: true });
    const settle = await fake.run(Effect.flip(settleThread(THREAD)));
    expect(settle).toBeInstanceOf(UnsupportedServerError);
    expect((settle as UnsupportedServerError).capability).toBe("threadSettlement");
    expect(settle.message).toBe("server 0.0.0 does not support settling threads");
    const unsettle = await fake.run(Effect.flip(unsettleThread(THREAD)));
    expect((unsettle as UnsupportedServerError).capability).toBe("threadSettlement");
    const autoSettle = await fake.run(Effect.flip(setAutoSettle(THREAD, false)));
    expect(autoSettle.message).toContain("does not support turning auto-settle off per thread");
    expect(fake.dispatched).toEqual([]);

    const none = fakeConnection({});
    const snooze = await none.run(Effect.flip(snoozeThread(THREAD, new Date())));
    expect(snooze.message).toBe("server 0.0.0 does not support snoozing threads");
    const unsnooze = await none.run(Effect.flip(unsnoozeThread(THREAD)));
    expect(unsnooze).toBeInstanceOf(UnsupportedServerError);
    expect(none.dispatched).toEqual([]);
  });

  test("supportsCapability reads the environment descriptor", async () => {
    const fake = fakeConnection({ threadSnooze: true, threadSettlement: false });
    expect(await fake.run(supportsCapability("threadSnooze"))).toBe(true);
    expect(await fake.run(supportsCapability("threadSettlement"))).toBe(false);
    expect(await fake.run(supportsCapability("threadAutoSettleOptOut"))).toBe(false);
  });
});
