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
 * - `switchServer` points the connection at another server: both stores are
 *   emptied first, and an epoch counter drops whatever the old server's
 *   subscriptions still deliver.
 *
 * A failing reducer or subscription is reported through `onError` and never
 * takes the sync down. A failed subscription is retried after a delay; one
 * that ended with a defect (effect/rpc ends a stream with one when an item
 * fails to decode) resubscribes from a fresh snapshot, since items may have
 * been lost. When the connection fails fatally the subscriptions wait for it
 * to be restarted (`:reconnect`) and then resubscribe. A thread the server
 * cannot serve (unknown, deleted, not authorized) is not retried: the thread
 * view shows the error instead.
 */
import {
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ResolvedConfig } from "../config.ts";
import { Connection, ConnectionFatalError } from "../connection/connection.ts";
import { createShellStore, createThreadStore, type ShellStore, type ThreadStore } from "./store.ts";

const RETRY_DELAY: Duration.Input = "2 seconds";

/** Typed `subscribeThread` failures retrying will not fix (`rpc.ts`). */
const TERMINAL_THREAD_ERRORS: ReadonlySet<string> = new Set([
  "OrchestrationV2GetThreadProjectionError",
  "EnvironmentAuthorizationError",
]);

export interface SyncOptions {
  /** Called with a description of a non-fatal problem (bad item, stream error). */
  readonly onError?: (message: string) => void;
  /** Pause before a failed subscription is retried. Default 2 seconds. */
  readonly retryDelay?: Duration.Input;
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
    /** Empties both stores and reconnects to another server. */
    readonly switchServer: (target: ResolvedConfig) => Effect.Effect<void>;
  }
>()("t8/StateSync") {}

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

function errorTag(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return undefined;
  const tag = (error as { _tag: unknown })._tag;
  return typeof tag === "string" ? tag : undefined;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return describe(error);
}

export const make = Effect.fn("StateSync.make")(function* (options: SyncOptions = {}) {
  const connection = yield* Connection;
  const report = (message: string) => options.onError?.(message);
  const retryDelay = options.retryDelay ?? RETRY_DELAY;
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

  /** Waits until the connection is no longer in the fatal `failed` state. */
  const awaitRestart = SubscriptionRef.changes(connection.status).pipe(
    Stream.filter((status) => status._tag !== "failed"),
    Stream.runHead,
    Effect.asVoid,
  );

  /**
   * Runs `subscribe` until it is interrupted or fails terminally.
   * - typed failure: reported, retried after `retryDelay`
   * - `terminal(error)` returns true: handled by the caller, not retried
   * - defect (e.g. an undecodable item): reported, retried from a fresh snapshot
   * - `ConnectionFatalError`: waits for the connection to be restarted, then resubscribes
   * - interruption: ends quietly
   * `subscribe(fresh)` must ignore any resume cursor when `fresh` is true.
   */
  const resilient = <E>(
    what: string,
    subscribe: (fresh: boolean) => Effect.Effect<void, E | ConnectionFatalError>,
    terminal: (error: E) => boolean = () => false,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      let fresh = false;
      while (true) {
        const exit = yield* Effect.exit(subscribe(fresh));
        fresh = false;
        if (Exit.isSuccess(exit)) return;
        const { cause } = exit;
        if (Cause.hasInterruptsOnly(cause)) return;
        const error = Cause.findErrorOption(cause);
        if (Option.isSome(error)) {
          if (error.value instanceof ConnectionFatalError) {
            // The status line shows why; resubscribe once the connection is restarted.
            yield* awaitRestart;
            continue;
          }
          if (terminal(error.value as E)) return;
          report(`${what}: ${describe(error.value)}`);
        } else {
          fresh = true;
          report(`${what}: ${describe(Cause.squash(cause))}; resubscribing from a fresh snapshot`);
        }
        yield* Effect.sleep(retryDelay);
      }
    });

  yield* SubscriptionRef.changes(connection.status).pipe(
    Stream.runForEach((status) => Effect.sync(() => shell.setConnection(status))),
    Effect.forkScoped,
  );

  /** Bumped by `switchServer`; shell items from an earlier server are dropped. */
  let serverEpoch = 0;

  const shellSubscription = (fresh: boolean) => {
    let skipResume = fresh;
    return connection
      .subscribe(({ client }) => {
        const epoch = serverEpoch;
        const after = skipResume ? null : shell.state.sequence;
        skipResume = false;
        return client[ORCHESTRATION_V2_WS_METHODS.subscribeShell](
          after === null ? {} : { afterSequence: after },
        ).pipe(Stream.map((item) => ({ epoch, item })));
      })
      .pipe(
        Stream.runForEach(
          ({ epoch, item }: { epoch: number; item: OrchestrationV2ShellStreamItem }) =>
            Effect.sync(() => {
              if (epoch !== serverEpoch) return;
              safely(`shell ${item.kind}`, () => shell.apply(item));
            }),
        ),
      );
  };
  yield* resilient("shell subscription", shellSubscription).pipe(Effect.forkScoped);

  const threadFiber = yield* FiberHandle.make<void, never>();
  let generation = 0;

  const openThread = (threadId: ThreadId) =>
    Effect.suspend(() => {
      generation += 1;
      const current = generation;
      thread.reset(threadId);
      const subscription = (fresh: boolean) => {
        let skipResume = fresh;
        return connection
          .subscribe(({ client }) => {
            const { state } = thread;
            const resume =
              !skipResume && state.threadId === threadId && state.sequence !== null
                ? { afterSequence: state.sequence }
                : {};
            skipResume = false;
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
      };
      const terminal = (error: unknown) => {
        const tag = errorTag(error);
        if (tag === undefined || !TERMINAL_THREAD_ERRORS.has(tag)) return false;
        if (current === generation) thread.fail(threadId, errorMessage(error));
        return true;
      };
      return FiberHandle.run(
        threadFiber,
        resilient(`thread ${threadId} subscription`, subscription, terminal),
      );
    }).pipe(Effect.asVoid);

  const closeThread = Effect.suspend(() => {
    generation += 1;
    thread.reset(null);
    return FiberHandle.clear(threadFiber);
  });

  const switchServer = (target: ResolvedConfig) =>
    Effect.suspend(() => {
      serverEpoch += 1;
      shell.reset();
      return closeThread;
    }).pipe(Effect.andThen(connection.setTarget(target)));

  return StateSync.of({ shell, thread, openThread, closeThread, switchServer });
});

export const layer = (options: SyncOptions = {}): Layer.Layer<StateSync, never, Connection> =>
  Layer.effect(StateSync, make(options));
