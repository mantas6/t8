/**
 * Pure reducers for the open thread's view state.
 *
 * Event handling mirrors upstream
 * `packages/client-runtime/src/state/orchestrationV2Projection.ts`, but keeps
 * entities in maps and derives transcript order in the selectors instead of
 * maintaining `visibleTurnItems` incrementally.
 *
 * Sequences are global across threads, so gaps are normal. Anything at or
 * below the last applied sequence is a replay and is dropped.
 */
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";

import type { ThreadViewState } from "../types.ts";

export type ThreadSnapshotItem = Extract<OrchestrationV2ThreadStreamItem, { kind: "snapshot" }>;
export type ThreadEventItem = Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }>;
export type ThreadUnknownEventItem = Extract<
  OrchestrationV2ThreadStreamItem,
  { kind: "unknown-event" }
>;

const EMPTY = {} as const;

export const closedThreadView: ThreadViewState = {
  threadId: null,
  phase: "closed",
  error: null,
  sequence: null,
  thread: null,
  runs: EMPTY,
  attempts: EMPTY,
  nodes: EMPTY,
  subagents: EMPTY,
  turnItems: EMPTY,
  inheritedItems: [],
  messages: EMPTY,
  runtimeRequests: EMPTY,
  plans: EMPTY,
  hasMoreHistory: false,
};

/** An empty view waiting for the snapshot of `threadId`. */
export function loadingThreadView(threadId: ThreadId): ThreadViewState {
  return { ...closedThreadView, threadId, phase: "loading" };
}

function byId<T extends { readonly id: string }>(items: ReadonlyArray<T>): Record<string, T> {
  const record: Record<string, T> = {};
  for (const item of items) record[item.id] = item;
  return record;
}

function upsert<T extends { readonly id: string }>(
  record: Readonly<Record<string, T>>,
  item: T,
): Readonly<Record<string, T>> {
  return record[item.id] === item ? record : { ...record, [item.id]: item };
}

/** The server refused `threadId`: an empty view carrying the error. */
export function failedThreadView(threadId: ThreadId, error: string): ThreadViewState {
  return { ...closedThreadView, threadId, phase: "error", error };
}

/** Replaces the view with a snapshot. A snapshot for another thread is ignored. */
export function applyThreadSnapshot(
  state: ThreadViewState,
  item: ThreadSnapshotItem,
): ThreadViewState {
  const { projection } = item;
  if (state.threadId !== null && projection.thread.id !== state.threadId) return state;
  return {
    threadId: projection.thread.id,
    phase: "ready",
    error: null,
    sequence: item.snapshotSequence,
    thread: projection.thread,
    runs: byId(projection.runs),
    attempts: byId(projection.attempts),
    nodes: byId(projection.nodes),
    subagents: byId(projection.subagents),
    turnItems: byId(projection.turnItems),
    inheritedItems: projection.visibleTurnItems.filter((row) => row.visibility !== "local"),
    messages: byId(projection.messages),
    runtimeRequests: byId(projection.runtimeRequests),
    plans: byId(projection.plans),
    hasMoreHistory: item.hasMoreHistory === true,
  };
}

function reduceEvent(state: ThreadViewState, event: OrchestrationV2DomainEvent): ThreadViewState {
  switch (event.type) {
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.pinned":
    case "thread.auto-settle-set":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.active-reordered":
    case "thread.visited":
    case "thread.marked-unread":
    case "thread.metadata-updated":
    case "thread.pull-request-synced":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
      return { ...state, thread: event.payload };
    case "run.created":
    case "run.updated":
      return { ...state, runs: upsert(state.runs, event.payload) };
    case "run.background-work-cancelled": {
      const run = state.runs[event.payload.runId];
      if (run === undefined) return state;
      return {
        ...state,
        runs: upsert(state.runs, {
          ...run,
          restartCancelledBackgroundWork: event.payload.restartCancelledBackgroundWork,
        }),
      };
    }
    case "run-attempt.created":
    case "run-attempt.updated":
      return { ...state, attempts: upsert(state.attempts, event.payload) };
    case "node.updated":
      return { ...state, nodes: upsert(state.nodes, event.payload) };
    case "subagent.updated":
      return { ...state, subagents: upsert(state.subagents, event.payload) };
    case "runtime-request.updated":
      return { ...state, runtimeRequests: upsert(state.runtimeRequests, event.payload) };
    case "message.updated":
      return { ...state, messages: upsert(state.messages, event.payload) };
    case "turn-item.updated":
      return { ...state, turnItems: upsert(state.turnItems, event.payload) };
    case "plan.updated":
      return { ...state, plans: upsert(state.plans, event.payload) };
    // Not part of the view (yet): provider bookkeeping, checkpoints (their turn
    // items carry what the transcript needs), context transfers, PR links.
    case "thread.pull-request-link-updated":
    case "provider-session.attached":
    case "provider-session.updated":
    case "provider-session.detached":
    case "provider-thread.updated":
    case "provider-turn.updated":
    case "checkpoint-scope.created":
    case "checkpoint.captured":
    case "checkpoint.rollback-requested":
    case "context-handoff.updated":
    case "context-transfer.created":
    case "context-transfer.updated":
      return state;
    default:
      // A contract bump that adds an event type fails to compile here.
      event satisfies never;
      return state;
  }
}

/**
 * Applies one domain event. Replays (sequence at or below the cursor) and
 * events for another thread are dropped; events before the snapshot too.
 */
export function applyThreadEvent(state: ThreadViewState, item: ThreadEventItem): ThreadViewState {
  if (state.phase !== "ready" || state.sequence === null) return state;
  if (item.sequence <= state.sequence) return state;
  if (item.event.threadId !== state.threadId) return { ...state, sequence: item.sequence };
  return { ...reduceEvent(state, item.event), sequence: item.sequence };
}

/** Applies any thread stream item. Never throws on unexpected input. */
export function applyThreadStreamItem(
  state: ThreadViewState,
  item: OrchestrationV2ThreadStreamItem,
): ThreadViewState {
  switch (item.kind) {
    case "snapshot":
      return applyThreadSnapshot(state, item);
    case "event":
      return applyThreadEvent(state, item);
    case "unknown-event":
      // Newer server: skip it but advance the cursor, as the contract intends.
      if (state.phase !== "ready" || state.sequence === null || item.sequence <= state.sequence) {
        return state;
      }
      return { ...state, sequence: item.sequence };
    case "synchronized":
      return state;
    default:
      item satisfies never;
      return state;
  }
}
