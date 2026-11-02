/**
 * Solid stores over the reducers. Framework-agnostic: no renderer imports, so
 * the TUI, the CLI and tests share them.
 *
 * Each store keeps the reducer output in a `solid-js/store` store. Updates are
 * committed entity by entity (`commit`), so a UI reading `state.turnItems[id]`
 * only re-renders for that item. Derived values (`transcript`, `pendingRequests`,
 * ...) are memos over a revision signal that every commit bumps.
 */
import type {
  OrchestrationV2Run,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import { type Accessor, batch, createMemo, createRoot, createSignal, untrack } from "solid-js";
import { createStore, produce, type SetStoreFunction, unwrap } from "solid-js/store";

import type { ConnectionStatus } from "../connection/connection.ts";
import {
  applyConnectionStatus,
  applyShellStreamItem,
  initialShellState,
} from "./reducers/shell.ts";
import {
  applyThreadStreamItem,
  closedThreadView,
  failedThreadView,
  loadingThreadView,
} from "./reducers/thread.ts";
import {
  selectActiveRun,
  selectPendingRequests,
  selectProjectGroups,
  selectQueue,
  selectTranscript,
} from "./selectors.ts";
import type {
  DisplayItem,
  PendingRequest,
  ProjectGroup,
  QueuedRun,
  ShellState,
  ThreadSummary,
  ThreadViewState,
} from "./types.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Writes `next` into the store, replacing only what changed by identity. Keys
 * listed in `maps` are id-keyed records and are diffed entry by entry; other
 * keys are replaced whole. `produce` is used because a plain `setState(path,
 * object)` merges into the existing object instead of replacing it.
 */
function commit<T extends object>(
  setState: SetStoreFunction<T>,
  previous: T,
  next: T,
  maps: ReadonlyArray<keyof T>,
): boolean {
  if (previous === next) return false;
  const mapKeys = new Set<keyof T>(maps);
  setState(
    produce((draft) => {
      const target = draft as Mutable<T>;
      for (const key of Object.keys(next) as Array<keyof T>) {
        const before = previous[key];
        const after = next[key];
        if (before === after) continue;
        if (!mapKeys.has(key)) {
          target[key] = after;
          continue;
        }
        const draftMap = target[key] as Record<string, unknown>;
        const beforeMap = before as Record<string, unknown>;
        const afterMap = after as Record<string, unknown>;
        for (const id of Object.keys(afterMap)) {
          if (beforeMap[id] !== afterMap[id]) draftMap[id] = afterMap[id];
        }
        for (const id of Object.keys(beforeMap)) {
          if (!(id in afterMap)) delete draftMap[id];
        }
      }
    }),
  );
  return true;
}

/**
 * A copy whose map records the store may mutate: `commit` updates records in
 * place, so the store must not share them with module-level initial states.
 */
function ownMaps<T extends object>(state: T, maps: ReadonlyArray<keyof T>): T {
  const copy = { ...state };
  for (const key of maps) copy[key] = { ...copy[key] };
  return copy;
}

// ---------------------------------------------------------------------------
// Shell store

export interface ShellStore {
  readonly state: ShellState;
  /** Non-archived threads grouped by project, newest activity first. */
  readonly groups: Accessor<ReadonlyArray<ProjectGroup>>;
  readonly thread: (id: string) => ThreadSummary | undefined;
  /** Applies a shell stream item; returns whether anything changed. */
  readonly apply: (item: OrchestrationV2ShellStreamItem) => boolean;
  readonly setConnection: (status: ConnectionStatus) => boolean;
  readonly dispose: () => void;
}

const SHELL_MAPS = ["projects", "threads"] as const satisfies ReadonlyArray<keyof ShellState>;

export function createShellStore(initial: ShellState = initialShellState): ShellStore {
  return createRoot((dispose) => {
    const [state, setState] = createStore<ShellState>(ownMaps(initial, SHELL_MAPS));
    const [revision, setRevision] = createSignal(0);
    const update = (reduce: (current: ShellState) => ShellState) =>
      batch(() => {
        const previous = unwrap(state);
        const changed = commit(setState, previous, reduce(previous), SHELL_MAPS);
        if (changed) setRevision((n) => n + 1);
        return changed;
      });
    const groups = createMemo(() => {
      revision();
      return untrack(() => selectProjectGroups(unwrap(state)));
    });
    return {
      state,
      groups,
      thread: (id) => state.threads[id],
      apply: (item) => update((current) => applyShellStreamItem(current, item)),
      setConnection: (status) => update((current) => applyConnectionStatus(current, status)),
      dispose,
    };
  });
}

// ---------------------------------------------------------------------------
// Thread store

export interface ThreadStore {
  readonly state: ThreadViewState;
  /** Display items in order, checkpoints left out. */
  readonly transcript: Accessor<ReadonlyArray<DisplayItem>>;
  readonly pendingRequests: Accessor<ReadonlyArray<PendingRequest>>;
  readonly activeRun: Accessor<OrchestrationV2Run | null>;
  readonly queue: Accessor<ReadonlyArray<QueuedRun>>;
  /** Bumped on every change; handy for coarse subscribers. */
  readonly revision: Accessor<number>;
  /** Applies a thread stream item; returns whether anything changed. */
  readonly apply: (item: OrchestrationV2ThreadStreamItem) => boolean;
  /** Empties the view: loading `threadId`, or closed for null. */
  readonly reset: (threadId: ThreadId | null) => void;
  /** Empties the view and records why `threadId` could not be loaded (phase `error`). */
  readonly fail: (threadId: ThreadId, error: string) => void;
  readonly dispose: () => void;
}

const THREAD_MAPS = [
  "runs",
  "attempts",
  "nodes",
  "subagents",
  "turnItems",
  "messages",
  "runtimeRequests",
  "plans",
] as const satisfies ReadonlyArray<keyof ThreadViewState>;

export function createThreadStore(initial: ThreadViewState = closedThreadView): ThreadStore {
  return createRoot((dispose) => {
    const [state, setState] = createStore<ThreadViewState>(ownMaps(initial, THREAD_MAPS));
    const [revision, setRevision] = createSignal(0);
    const update = (reduce: (current: ThreadViewState) => ThreadViewState) =>
      batch(() => {
        const previous = unwrap(state);
        const changed = commit(setState, previous, reduce(previous), THREAD_MAPS);
        if (changed) setRevision((n) => n + 1);
        return changed;
      });
    const derive = <A>(select: (current: ThreadViewState) => A): Accessor<A> =>
      createMemo(() => {
        revision();
        return untrack(() => select(unwrap(state)));
      });
    return {
      state,
      transcript: derive((current) => selectTranscript(current)),
      pendingRequests: derive(selectPendingRequests),
      activeRun: derive(selectActiveRun),
      queue: derive(selectQueue),
      revision,
      apply: (item) => update((current) => applyThreadStreamItem(current, item)),
      reset: (threadId) => {
        update(() => (threadId === null ? closedThreadView : loadingThreadView(threadId)));
      },
      fail: (threadId, error) => {
        update(() => failedThreadView(threadId, error));
      },
      dispose,
    };
  });
}
