/**
 * Thin typed helpers over `orchestration.dispatchCommand`.
 *
 * Mirrors upstream `packages/client-runtime/src/operations/commands.ts`:
 * every command gets a fresh random UUID `commandId` (the server dedupes on
 * it), `createdBy: "user"` and a `creationSource`. Servers that advertise
 * `serverResolvedCommandContext` pick the active run themselves, so
 * `message.dispatch` only states the intent (`deliveryIntent`) and uses
 * `start_immediately` / `queue_after_active` as the dispatch mode.
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ExecutionEnvironmentDescriptor,
  MessageId,
  type ModelSelection,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2CreationSource,
  type ProjectId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderUserInputAnswers,
  type RunId,
  type RuntimeMode,
  type RuntimeRequestId,
  ThreadId,
  type TurnItemId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { Connection, type Session } from "./connection/connection.ts";

/** Upstream clients send "web" or "mobile"; this terminal client is closest to "web". */
export const CREATION_SOURCE: OrchestrationV2CreationSource = "web";

export const DEFAULT_THREAD_TITLE = "New thread";

/** The server lacks a capability this helper relies on. */
export class UnsupportedServerError extends Data.TaggedError("UnsupportedServerError")<{
  readonly capability: string;
  readonly message: string;
}> {}

export const newCommandId = (): CommandId => CommandId.make(crypto.randomUUID());
export const newMessageId = (): MessageId => MessageId.make(crypto.randomUUID());
export const newThreadId = (): ThreadId => ThreadId.make(crypto.randomUUID());

export type Capability = keyof ExecutionEnvironmentDescriptor["capabilities"];

function hasCapability(session: Session, capability: Capability): boolean {
  return session.environment.capabilities[capability] === true;
}

/** Fails with `UnsupportedServerError` unless the server advertises `capability`; `what` names it for people. */
function requireCapability(session: Session, capability: Capability, what: string = capability) {
  return hasCapability(session, capability)
    ? Effect.void
    : Effect.fail(
        new UnsupportedServerError({
          capability,
          message: `server ${session.environment.serverVersion} does not support ${what}`,
        }),
      );
}

/** Whether the connected server advertises a capability. Waits for a connection. */
export const supportsCapability = Effect.fn("commands.supportsCapability")(function* (
  capability: Capability,
) {
  return hasCapability(yield* (yield* Connection).session, capability);
});

/** Dispatches a command after checking the server advertises `capability`. */
const dispatchGated = Effect.fn("commands.dispatchGated")(function* (
  capability: Capability,
  what: string,
  command: OrchestrationV2Command,
) {
  const session = yield* (yield* Connection).session;
  yield* requireCapability(session, capability, what);
  return yield* session.client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);
});

/** Dispatches a raw command on the current session. Waits for a connection. */
export const dispatch = Effect.fn("commands.dispatch")(function* (command: OrchestrationV2Command) {
  const { client } = yield* (yield* Connection).session;
  return yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);
});

/**
 * How a message relates to a run that is already active:
 * - `auto`: let the server choose (steer if the provider supports it, else queue)
 * - `steer`: inject into the active run
 * - `restart`: interrupt the active run and restart with this message
 * - `queue`: run after the active run finishes
 * With no active run all of them start a new run.
 */
export type DeliveryIntent = "auto" | "steer" | "restart" | "queue";

export interface SendMessageOptions {
  readonly modelSelection?: ModelSelection;
  /** Used to auto-title a fresh thread. */
  readonly titleSeed?: string;
  readonly messageId?: MessageId;
  readonly commandId?: CommandId;
}

export const sendMessage = Effect.fn("commands.sendMessage")(function* (
  threadId: ThreadId,
  text: string,
  deliveryIntent: DeliveryIntent = "auto",
  options: SendMessageOptions = {},
) {
  const connection = yield* Connection;
  const session = yield* connection.session;
  yield* requireCapability(session, "serverResolvedCommandContext");
  const messageId = options.messageId ?? newMessageId();
  const result = yield* session.client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
    type: "message.dispatch",
    commandId: options.commandId ?? newCommandId(),
    createdBy: "user",
    creationSource: CREATION_SOURCE,
    threadId,
    messageId,
    text,
    attachments: [],
    ...(options.titleSeed === undefined ? {} : { titleSeed: options.titleSeed }),
    ...(options.modelSelection === undefined ? {} : { modelSelection: options.modelSelection }),
    ...(deliveryIntent === "queue" ? {} : { deliveryIntent }),
    dispatchMode:
      deliveryIntent === "queue" ? { type: "queue_after_active" } : { type: "start_immediately" },
  });
  return { ...result, messageId };
});

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

/**
 * Stops the thread's work. With a `runId`, interrupts that run (holding the
 * queue, like upstream). Without one, uses `thread.stop` when the server
 * supports it, which also stops background work; otherwise interrupts the
 * latest active run. Resolves to `{ sequence: 0 }` when nothing was running.
 */
export const interruptRun = Effect.fn("commands.interruptRun")(function* (
  threadId: ThreadId,
  runId?: RunId,
) {
  const connection = yield* Connection;
  const session = yield* connection.session;
  const { client } = session;
  if (runId === undefined && hasCapability(session, "threadStop")) {
    return yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
      type: "thread.stop",
      commandId: newCommandId(),
      threadId,
    });
  }
  let target = runId;
  if (target === undefined) {
    const projection = yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId });
    target = projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status))?.id;
  }
  if (target === undefined) return { sequence: 0 };
  return yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
    type: "run.interrupt",
    commandId: newCommandId(),
    threadId,
    runId: target,
    holdQueue: true,
  });
});

/** Answer to a pending runtime request: an approval decision or user-input answers. */
export type RuntimeRequestResponse =
  | { readonly decision: ProviderApprovalDecision }
  | { readonly answers: ProviderUserInputAnswers };

export const respondToRequest = Effect.fn("commands.respondToRequest")(function* (
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  response: RuntimeRequestResponse,
) {
  return yield* dispatch({
    type: "runtime-request.respond",
    commandId: newCommandId(),
    threadId,
    requestId,
    ...("decision" in response ? { decision: response.decision } : { answers: response.answers }),
  });
});

export interface CreateThreadOptions {
  readonly title?: string;
  /** Defaults to the project's default model selection. Required if the project has none. */
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly threadId?: ThreadId;
}

/** Thrown when no model selection was given and the project has no default. */
export class MissingModelSelectionError extends Data.TaggedError("MissingModelSelectionError")<{
  readonly projectId: ProjectId;
  readonly message: string;
}> {}

/** Looks up a project's default model selection from the first shell snapshot. */
export const projectDefaultModelSelection = Effect.fn("commands.projectDefaultModelSelection")(
  function* (projectId: ProjectId) {
    const { client } = yield* (yield* Connection).session;
    const first = yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
      Stream.filter((item) => item.kind === "snapshot"),
      Stream.runHead,
    );
    if (Option.isNone(first) || first.value.kind !== "snapshot") return null;
    const project = first.value.snapshot.projects.find((candidate) => candidate.id === projectId);
    return project?.defaultModelSelection ?? null;
  },
);

/**
 * Creates an empty thread in a project (worktree-less, on the project root).
 * Send it a message with `sendMessage` to start a run.
 */
export const createThread = Effect.fn("commands.createThread")(function* (
  projectId: ProjectId,
  options: CreateThreadOptions = {},
) {
  const threadId = options.threadId ?? newThreadId();
  const modelSelection =
    options.modelSelection ?? (yield* projectDefaultModelSelection(projectId)) ?? undefined;
  if (modelSelection === undefined) {
    return yield* new MissingModelSelectionError({
      projectId,
      message: `project ${projectId} has no default model; pass a model selection`,
    });
  }
  const result = yield* dispatch({
    type: "thread.create",
    commandId: newCommandId(),
    createdBy: "user",
    creationSource: CREATION_SOURCE,
    threadId,
    projectId,
    title: options.title?.trim() || DEFAULT_THREAD_TITLE,
    modelSelection,
    runtimeMode: options.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: options.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
  });
  return { ...result, threadId };
});

export const setModelSelection = Effect.fn("commands.setModelSelection")(function* (
  threadId: ThreadId,
  modelSelection: ModelSelection,
) {
  return yield* dispatch({
    type: "thread.model-selection.set",
    commandId: newCommandId(),
    threadId,
    modelSelection,
  });
});

export const setRuntimeMode = Effect.fn("commands.setRuntimeMode")(function* (
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
) {
  return yield* dispatch({
    type: "thread.runtime-mode.set",
    commandId: newCommandId(),
    threadId,
    runtimeMode,
  });
});

export const archiveThread = Effect.fn("commands.archiveThread")(function* (threadId: ThreadId) {
  return yield* dispatch({ type: "thread.archive", commandId: newCommandId(), threadId });
});

/**
 * Settles a thread: it leaves the active list until something new happens.
 * The server refuses while a run is active, a request waits, or a message is
 * queued. `settledAt` is left to the server, like upstream.
 */
export const settleThread = Effect.fn("commands.settleThread")(function* (threadId: ThreadId) {
  return yield* dispatchGated("threadSettlement", "settling threads", {
    type: "thread.settle",
    commandId: newCommandId(),
    threadId,
  });
});

/** Un-settles a thread; `reason: "user"` pins it active, so auto-settle leaves it alone. */
export const unsettleThread = Effect.fn("commands.unsettleThread")(function* (threadId: ThreadId) {
  return yield* dispatchGated("threadSettlement", "settling threads", {
    type: "thread.unsettle",
    commandId: newCommandId(),
    threadId,
    reason: "user",
  });
});

/** Hides a thread until `until` (or until it asks for the user or fails). */
export const snoozeThread = Effect.fn("commands.snoozeThread")(function* (
  threadId: ThreadId,
  until: Date,
) {
  return yield* dispatchGated("threadSnooze", "snoozing threads", {
    type: "thread.snooze",
    commandId: newCommandId(),
    threadId,
    snoozedUntil: until.toISOString(),
  });
});

export const unsnoozeThread = Effect.fn("commands.unsnoozeThread")(function* (threadId: ThreadId) {
  return yield* dispatchGated("threadSnooze", "snoozing threads", {
    type: "thread.unsnooze",
    commandId: newCommandId(),
    threadId,
    reason: "user",
  });
});

/** Turns automatic settling on or off for one thread. */
export const setAutoSettle = Effect.fn("commands.setAutoSettle")(function* (
  threadId: ThreadId,
  enabled: boolean,
) {
  return yield* dispatchGated("threadAutoSettleOptOut", "turning auto-settle off per thread", {
    type: "thread.auto-settle.set",
    commandId: newCommandId(),
    threadId,
    enabled,
  });
});

/** Fetches one turn item in full, including output the stream withheld (`resultOmitted`). */
export const fetchTurnItem = Effect.fn("commands.fetchTurnItem")(function* (
  threadId: ThreadId,
  itemId: TurnItemId,
) {
  const { client } = yield* (yield* Connection).session;
  const result = yield* client[ORCHESTRATION_V2_WS_METHODS.getTurnItem]({ threadId, itemId });
  return result.item;
});

/** Drops a queued run (its message is never sent). */
export const cancelQueuedRun = Effect.fn("commands.cancelQueuedRun")(function* (
  threadId: ThreadId,
  runId: RunId,
) {
  return yield* dispatch({ type: "queued-run.cancel", commandId: newCommandId(), threadId, runId });
});

/** Moves a queued run before `beforeRunId`, or to the end of the queue for null. */
export const reorderQueuedRun = Effect.fn("commands.reorderQueuedRun")(function* (
  threadId: ThreadId,
  runId: RunId,
  beforeRunId: RunId | null,
) {
  return yield* dispatch({
    type: "queued-run.reorder",
    commandId: newCommandId(),
    threadId,
    runId,
    beforeRunId,
  });
});

/**
 * The server config: provider instances with their models (what upstream's
 * model picker lists) and the settings holding the default model selection
 * and runtime mode.
 */
export const getServerConfig = Effect.fn("commands.getServerConfig")(function* () {
  const { client } = yield* (yield* Connection).session;
  return yield* client[WS_METHODS.serverGetConfig]({});
});

/** Archived threads (the shell stream only carries active ones). */
export const getArchivedThreads = Effect.fn("commands.getArchivedThreads")(function* () {
  const { client } = yield* (yield* Connection).session;
  const snapshot = yield* client[ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]({});
  return snapshot.threads;
});
