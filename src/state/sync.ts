/**
 * Keeps the stores in sync with the server over a `Connection`.
 *
 * - Shell: subscribed for the lifetime of the scope. After a reconnect the
 *   subscription resumes from the last applied sequence.
 * - Thread: `openThread` (re)subscribes one thread; the view is emptied right
 *   away and filled by the snapshot. Switching cancels the previous
 *   subscription, and a generation counter drops anything a cancelled
 *   subscription still delivers, so rapid switching is safe.
 * - Connection status is mirrored into the shell store.
 *
 * A failing reducer or subscription is reported through `onError` and never
 * takes the sync down; subscriptions retry unless the connection failed fatally.
 */
import {
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { Connection, ConnectionFatalError } from "../connection/connection.ts";
import { createShellStore, createThreadStore, type ShellStore, type ThreadStore } from "./store.ts";

const RETRY_DELAY = "2 seconds";

export interface SyncOptions {
  /** Called with a description of a non-fatal problem (bad item, stream error). */
  readonly onError?: (message: string) => void;
}

export class StateSync extends Context.Service<
  StateSync,
  {
    readonly shell: ShellStore;
    readonly thread: ThreadStore;
    /** Shows `threadId` in the thread store, replacing whatever was open. */
    readonly openThread: (threadId: ThreadId) => Effect.Effect<void>;
    /** Stops the thread subscription and empties the thread store. */
    readonly closeThread: Effect.Effect<void>;
  }
>()("t3tui/StateSync") {}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    const tagged = cause as { _tag: unknown; message?: unknown };
    return typeof tagged.message === "string"
      ? `${String(tagged._tag)}: ${tagged.message}`
      : String(tagged._tag);
  }
  return String(cause);
}

export const make = Effect.fn("StateSync.make")(function* (options: SyncOptions = {}) {
  const connection = yield* Connection;
  const report = (message: string) => options.onError?.(message);
  const shell = createShellStore();
  const thread = createThreadStore();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      shell.dispose();
      thread.dispose();
    }),
  );

  const safely = (what: string, apply: () => void) => {
    try {
      apply();
    } catch (cause) {
      report(`${what}: ${describe(cause)}`);
    }
  };

  /** Reports stream failures and resubscribes after a delay, unless the connection is dead. */
  const resilient = <E>(what: string, effect: Effect.Effect<void, E>) =>
    effect.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.sync(() => report(`${what}: ${describe(Cause.squash(cause))}`)),
      ),
      Effect.retry({
        while: (error) => !(error instanceof ConnectionFatalError),
        schedule: Schedule.spaced(RETRY_DELAY),
      }),
      Effect.ignore,
    );

  yield* SubscriptionRef.changes(connection.status).pipe(
    Stream.runForEach((status) => Effect.sync(() => shell.setConnection(status))),
    Effect.forkScoped,
  );

  yield* connection
    .subscribe(({ client }) => {
      const after = shell.state.sequence;
      return client[ORCHESTRATION_V2_WS_METHODS.subscribeShell](
        after === null ? {} : { afterSequence: after },
      );
    })
    .pipe(
      Stream.runForEach((item: OrchestrationV2ShellStreamItem) =>
        Effect.sync(() => safely(`shell ${item.kind}`, () => shell.apply(item))),
      ),
      (effect) => resilient("shell subscription", effect),
      Effect.forkScoped,
    );

  const threadFiber = yield* FiberHandle.make<void, never>();
  let generation = 0;

  const openThread = (threadId: ThreadId) =>
    Effect.suspend(() => {
      generation += 1;
      const current = generation;
      thread.reset(threadId);
      const subscription = connection
        .subscribe(({ client }) => {
          const { state } = thread;
          const resume =
            state.threadId === threadId && state.sequence !== null
              ? { afterSequence: state.sequence }
              : {};
          return client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId, ...resume });
        })
        .pipe(
          Stream.runForEach((item: OrchestrationV2ThreadStreamItem) =>
            Effect.sync(() => {
              // A superseded subscription may still deliver a few items.
              if (current !== generation) return;
              safely(`thread ${item.kind}`, () => thread.apply(item));
            }),
          ),
        );
      return FiberHandle.run(
        threadFiber,
        resilient(`thread ${threadId} subscription`, subscription),
      );
    }).pipe(Effect.asVoid);

  const closeThread = Effect.suspend(() => {
    generation += 1;
    thread.reset(null);
    return FiberHandle.clear(threadFiber);
  });

  return StateSync.of({ shell, thread, openThread, closeThread });
});

export const layer = (options: SyncOptions = {}): Layer.Layer<StateSync, never, Connection> =>
  Layer.effect(StateSync, make(options));
