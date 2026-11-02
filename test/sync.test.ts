import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2GetThreadProjectionError,
  type OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  Connection,
  ConnectionFatalError,
  type ConnectionStatus,
  type Session,
} from "../src/connection/connection.ts";
import { selectTranscript } from "../src/state/selectors.ts";
import * as StateSync from "../src/state/sync.ts";
import { projectShell, shellSnapshot, threadShell } from "./fixtures/shell.ts";

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

type ShellItem = OrchestrationV2ShellStreamItem;
type ThreadItem = OrchestrationV2ThreadStreamItem;

interface FakeStreams {
  readonly shell?: (input: { afterSequence?: number }) => Stream.Stream<ShellItem, unknown>;
  readonly thread?: Record<
    string,
    | Stream.Stream<ThreadItem, unknown>
    | ((input: { afterSequence?: number }) => Stream.Stream<ThreadItem, unknown>)
  >;
}

/**
 * A connection serving canned streams. Like the real one, `sessions` follows
 * the status (failing while it is `failed`) and `subscribe` restarts the
 * stream for every new session.
 */
function fakeConnection(streams: FakeStreams) {
  const calls = { shell: [] as unknown[], thread: [] as unknown[] };
  let status: SubscriptionRef.SubscriptionRef<ConnectionStatus> | undefined;
  const makeSession = (generation: number) =>
    ({
      generation,
      environment: { label: "test", serverVersion: "0.0.0" },
      client: {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input: { afterSequence?: number }) => {
          calls.shell.push(input);
          return streams.shell?.(input) ?? Stream.never;
        },
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: {
          threadId: string;
          afterSequence?: number;
        }) => {
          calls.thread.push(input);
          const entry = streams.thread?.[input.threadId];
          if (entry === undefined) return Stream.never;
          return typeof entry === "function" ? entry(input) : entry;
        },
      },
    }) as unknown as Session;
  const layer = Layer.effect(
    Connection,
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<ConnectionStatus>({
        _tag: "connected",
        session: makeSession(1),
      });
      status = ref;
      const sessions = SubscriptionRef.changes(ref).pipe(
        Stream.mapEffect((current) =>
          current._tag === "failed" ? Effect.fail(current.error) : Effect.succeed(current),
        ),
        Stream.filterMap((current) =>
          current._tag === "connected" ? Result.succeed(current.session) : Result.failVoid,
        ),
        Stream.changesWith((a, b) => a.generation === b.generation),
      );
      return Connection.of({
        target: {} as never,
        setTarget: () => Effect.void,
        status: ref,
        session: Effect.succeed(makeSession(1)),
        client: Effect.succeed(makeSession(1).client),
        sessions,
        subscribe: (f) => sessions.pipe(Stream.switchMap((session) => f(session))) as never,
        reconnectNow: Effect.void,
        forceReconnect: Effect.void,
      });
    }),
  );
  const setStatus = (next: ConnectionStatus) =>
    Effect.suspend(() => (status === undefined ? Effect.void : SubscriptionRef.set(status, next)));
  return { layer, calls, setStatus, makeSession };
}

const run = <A, E>(
  program: Effect.Effect<A, E, Connection | Scope.Scope>,
  fake: ReturnType<typeof fakeConnection>,
) => Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(fake.layer)));

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
    });

    await run(
      program,
      fakeConnection({
        thread: {
          [THREAD_A]: Stream.concat(
            Stream.fromEffect(Effect.sleep("30 millis")).pipe(Stream.drain),
            Stream.fromIterable(fixture),
          ),
          [THREAD_B]: Stream.make(snapshotOfB()),
        },
      }),
    );
  });

  const SHELL = shellSnapshot(
    [projectShell("project-1", "t8")],
    [threadShell("thread-1", "project-1", { title: "first" })],
  );

  test("an undecodable item resubscribes from a fresh snapshot", async () => {
    const errors: string[] = [];
    let shellCalls = 0;
    let threadCalls = 0;
    // effect/rpc ends a stream with a defect when an item fails to decode.
    const decodeDefect = () => Stream.die(new Error("Expected string, got 42"));
    const fake = fakeConnection({
      shell: () => {
        shellCalls += 1;
        return shellCalls === 1
          ? Stream.concat(Stream.make(SHELL), decodeDefect())
          : Stream.concat(Stream.make(SHELL), Stream.never);
      },
      thread: {
        [THREAD_A]: () => {
          threadCalls += 1;
          return threadCalls === 1
            ? Stream.concat(Stream.fromIterable(fixture.slice(0, 5)), decodeDefect())
            : Stream.concat(Stream.fromIterable(fixture), Stream.never);
        },
      },
    });
    await run(
      Effect.gen(function* () {
        const sync = yield* StateSync.make({
          onError: (message) => errors.push(message),
          retryDelay: "10 millis",
        });
        yield* sync.openThread(THREAD_A);
        yield* Effect.sleep("150 millis");
        // Both resubscribed without a resume cursor, although one was known.
        expect(fake.calls.shell).toEqual([{}, {}]);
        expect(fake.calls.thread).toEqual([{ threadId: THREAD_A }, { threadId: THREAD_A }]);
        expect(sync.shell.state.threads["thread-1"]?.title).toBe("first");
        expect(sync.thread.transcript().map((item) => item.kind)).toEqual([
          "user_message",
          "assistant_message",
        ]);
        expect(errors.filter((message) => message.includes("fresh snapshot"))).toHaveLength(2);
      }),
      fake,
    );
  });

  test("a typed stream error retries and resumes after the last sequence", async () => {
    let threadCalls = 0;
    const fake = fakeConnection({
      thread: {
        [THREAD_A]: () => {
          threadCalls += 1;
          return threadCalls === 1
            ? Stream.concat(Stream.make(fixture[0] as ThreadItem), Stream.fail("boom"))
            : Stream.never;
        },
      },
    });
    await run(
      Effect.gen(function* () {
        const sync = yield* StateSync.make({ retryDelay: "10 millis" });
        yield* sync.openThread(THREAD_A);
        yield* Effect.sleep("80 millis");
        const sequence = fixture[0]?.kind === "snapshot" ? fixture[0].snapshotSequence : -1;
        expect(fake.calls.thread).toEqual([
          { threadId: THREAD_A },
          { threadId: THREAD_A, afterSequence: sequence },
        ]);
      }),
      fake,
    );
  });

  test("an unknown thread is not retried and shows the error", async () => {
    const errors: string[] = [];
    const fake = fakeConnection({
      thread: {
        [THREAD_B]: Stream.fail(
          new OrchestrationV2GetThreadProjectionError({
            threadId: THREAD_B,
            message: "thread not found",
          }),
        ),
      },
    });
    await run(
      Effect.gen(function* () {
        const sync = yield* StateSync.make({
          onError: (message) => errors.push(message),
          retryDelay: "10 millis",
        });
        yield* sync.openThread(THREAD_B);
        yield* Effect.sleep("100 millis");
        expect(fake.calls.thread).toHaveLength(1);
        expect(sync.thread.state.phase).toBe("error");
        expect(sync.thread.state.threadId).toBe(THREAD_B);
        expect(sync.thread.state.error).toBe("thread not found");
        expect(errors).toEqual([]);
      }),
      fake,
    );
  });

  test("after a fatal failure the subscriptions resume once the connection is restarted", async () => {
    const errors: string[] = [];
    const fake = fakeConnection({
      shell: () => Stream.concat(Stream.make(SHELL), Stream.never),
      thread: {
        [THREAD_A]: () => Stream.concat(Stream.make(fixture[0] as ThreadItem), Stream.never),
      },
    });
    await run(
      Effect.gen(function* () {
        const sync = yield* StateSync.make({
          onError: (message) => errors.push(message),
          retryDelay: "10 millis",
        });
        yield* sync.openThread(THREAD_A);
        yield* Effect.sleep("30 millis");
        expect(fake.calls.shell).toHaveLength(1);

        yield* fake.setStatus({
          _tag: "failed",
          error: new ConnectionFatalError({ reason: "unauthorized", message: "bad token" }),
        });
        yield* Effect.sleep("50 millis");
        expect(sync.shell.state.connection.state).toBe("failed");
        // Parked, not retrying.
        expect(fake.calls.shell).toHaveLength(1);

        yield* fake.setStatus({ _tag: "connecting", attempt: 1 });
        yield* fake.setStatus({ _tag: "connected", session: fake.makeSession(2) });
        yield* Effect.sleep("50 millis");
        expect(fake.calls.shell).toEqual([{}, { afterSequence: 100 }]);
        expect(fake.calls.thread).toHaveLength(2);
        expect(sync.shell.state.connection.state).toBe("connected");
        expect(errors).toEqual([]);
      }),
      fake,
    );
  });
});
