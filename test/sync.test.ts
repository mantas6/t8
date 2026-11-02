import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { Connection, type ConnectionStatus, type Session } from "../src/connection/connection.ts";
import { selectTranscript } from "../src/state/selectors.ts";
import * as StateSync from "../src/state/sync.ts";

const decode = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));
const lines = readFileSync(join(import.meta.dir, "fixtures/thread-lifecycle.ndjson"), "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Record<string, unknown>);
const fixture = lines.map((line) => decode(line));
const THREAD_A = (fixture[0]?.kind === "snapshot" && fixture[0].projection.thread.id) as ThreadId;
const THREAD_B = ThreadId.make("thread-b");

/** The recorded snapshot, re-labelled as an empty thread B. */
function snapshotOfB() {
  const raw = structuredClone(lines[0]) as { projection: { thread: Record<string, unknown> } };
  raw.projection.thread.id = THREAD_B;
  raw.projection.thread.title = "thread b";
  raw.projection.thread.lineage = {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: THREAD_B,
  };
  return decode(raw);
}

/** A connection whose single session serves canned thread streams. */
function fakeConnection(streams: Record<string, Stream.Stream<OrchestrationV2ThreadStreamItem>>) {
  return Layer.effect(
    Connection,
    Effect.gen(function* () {
      const session = {
        generation: 1,
        environment: { label: "test", serverVersion: "0.0.0" },
        client: {
          [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.never,
          [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: ({ threadId }: { threadId: string }) =>
            streams[threadId] ?? Stream.never,
        },
      } as unknown as Session;
      const status = yield* SubscriptionRef.make<ConnectionStatus>({
        _tag: "connected",
        session,
      });
      return Connection.of({
        config: {} as never,
        status,
        session: Effect.succeed(session),
        client: Effect.succeed(session.client),
        sessions: Stream.make(session),
        subscribe: (f) => f(session) as never,
        reconnectNow: Effect.void,
        forceReconnect: Effect.void,
      });
    }),
  );
}

describe("StateSync", () => {
  test("switching threads drops the previous subscription", async () => {
    const program = Effect.gen(function* () {
      const sync = yield* StateSync.make();
      yield* Effect.sleep("1 millis");
      expect(sync.shell.state.connection.state).toBe("connected");

      // A's stream is slow; B's answers at once. Open A, then B before A delivers.
      yield* sync.openThread(THREAD_A);
      expect(sync.thread.state.phase).toBe("loading");
      yield* sync.openThread(THREAD_B);
      yield* Effect.sleep("80 millis");

      expect(sync.thread.state.threadId).toBe(THREAD_B);
      expect(sync.thread.state.phase).toBe("ready");
      expect(sync.thread.state.thread?.title).toBe("thread b");
      expect(sync.thread.transcript()).toEqual([]);

      // Back to A: its full recorded lifecycle lands.
      yield* sync.openThread(THREAD_A);
      yield* Effect.sleep("80 millis");
      expect(sync.thread.state.threadId).toBe(THREAD_A);
      expect(sync.thread.transcript().map((item) => item.kind)).toEqual([
        "user_message",
        "assistant_message",
      ]);
      expect(sync.thread.transcript()).toEqual(selectTranscript(sync.thread.state));

      yield* sync.closeThread;
      expect(sync.thread.state.phase).toBe("closed");
      expect(Object.keys(sync.thread.state.turnItems)).toEqual([]);
    }).pipe(Effect.scoped);

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          fakeConnection({
            [THREAD_A]: Stream.concat(
              Stream.fromEffect(Effect.sleep("30 millis")).pipe(Stream.drain),
              Stream.fromIterable(fixture),
            ),
            [THREAD_B]: Stream.make(snapshotOfB()),
          }),
        ),
      ),
    );
  });
});
