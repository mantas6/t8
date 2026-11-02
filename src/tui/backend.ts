/**
 * What the TUI needs from the outside world: the stores, and promise-based
 * commands. `makeBackend` implements it over an Effect runtime holding
 * `Connection` and `StateSync`; tests pass a fake.
 */

import { type RuntimeRequestId, type ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import {
  type DeliveryIntent,
  fetchTurnItem,
  interruptRun,
  type RuntimeRequestResponse,
  respondToRequest,
  sendMessage,
} from "../commands.ts";
import { Connection } from "../connection/connection.ts";
import { toDisplayItem } from "../state/selectors.ts";
import type { ShellStore, ThreadStore } from "../state/store.ts";
import { StateSync } from "../state/sync.ts";

export interface Backend {
  readonly shell: ShellStore;
  readonly thread: ThreadStore;
  /** Shows a thread in the thread store, replacing the open one. */
  openThread(threadId: ThreadId): void;
  send(threadId: ThreadId, text: string, intent: DeliveryIntent): Promise<void>;
  interrupt(threadId: ThreadId): Promise<void>;
  respond(
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    response: RuntimeRequestResponse,
  ): Promise<void>;
  /** The full output of a tool call whose result the stream omitted; null when it has none. */
  fetchToolResult(threadId: ThreadId, itemId: string): Promise<string | null>;
  /** Skips the reconnect backoff. */
  reconnectNow(): void;
}

/** A readable one-liner for a failed command. */
export function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as { _tag?: unknown; message?: unknown };
    const message =
      typeof record.message === "string" && record.message !== "" ? record.message : String(error);
    return typeof record._tag === "string" && !message.includes(record._tag)
      ? `${record._tag}: ${message}`
      : message;
  }
  return String(error);
}

const NO_CONTEXT = { messages: {}, runtimeRequests: {} };

export async function makeBackend(
  runtime: ManagedRuntime.ManagedRuntime<Connection | StateSync, never>,
): Promise<Backend> {
  const sync = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* StateSync;
    }),
  );
  const connection = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* Connection;
    }),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, Connection>): Promise<A> =>
    runtime.runPromise(effect);
  return {
    shell: sync.shell,
    thread: sync.thread,
    openThread: (threadId) => {
      runtime.runFork(sync.openThread(threadId));
    },
    send: async (threadId, text, intent) => {
      await run(sendMessage(threadId, text, intent));
    },
    interrupt: async (threadId) => {
      await run(interruptRun(threadId));
    },
    respond: async (threadId, requestId, response) => {
      await run(respondToRequest(threadId, requestId, response));
    },
    fetchToolResult: async (threadId, itemId) => {
      const item = await run(fetchTurnItem(threadId, TurnItemId.make(itemId)));
      if (item === null) return null;
      const display = toDisplayItem(item, "local", NO_CONTEXT);
      return display.kind === "tool_call" ? display.result : null;
    },
    reconnectNow: () => {
      runtime.runFork(connection.reconnectNow);
    },
  };
}
