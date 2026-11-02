/**
 * Pure reducers for the shell (project and thread list) state.
 *
 * Semantics follow upstream `packages/client-runtime/src/state/shellReducer.ts`:
 * - A plain snapshot is authoritative and replaces projects and threads.
 * - A snapshot carrying `resolvedRepositoryIdentityRoots` is only an
 *   enrichment: it patches repository identity onto known projects. Its thread
 *   lists are empty and its sequence must not move the cursor.
 * - Events at or below the current sequence are replays and are dropped.
 */
import type {
  OrchestrationProjectShell,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadShell,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ConnectionStatus } from "../../connection/connection.ts";
import type {
  ConnectionView,
  ShellState,
  ThreadPullRequestSummary,
  ThreadSummary,
} from "../types.ts";

export type ShellSnapshotItem = Extract<OrchestrationV2ShellStreamItem, { kind: "snapshot" }>;
export type ShellEventItem = Exclude<
  OrchestrationV2ShellStreamItem,
  { kind: "snapshot" } | { kind: "synchronized" }
>;

export const initialShellState: ShellState = {
  connection: { state: "connecting", attempt: 1 },
  synchronized: false,
  sequence: null,
  projects: {},
  threads: {},
};

const PREVIEW_LENGTH = 200;

function epochMs(value: DateTime.Utc | null | undefined): number | null {
  return value == null ? null : DateTime.toEpochMillis(value);
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…` : flat;
}

function parseMs(value: string | null | undefined): number {
  const ms = value == null ? Number.NaN : Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

const isOpenLink = (link: ThreadPullRequestLink) =>
  link.snapshot === null || link.snapshot.state === "open";

/**
 * The pull request to show for a thread. Follows upstream
 * `resolveThreadCurrentPullRequest` (`packages/shared/src/threadPullRequests.ts`)
 * without its stack ordering: dismissed stack members are hidden; an open one
 * wins (the most recently linked), else the most recently updated. Falls back
 * to the legacy `linkedPullRequest`, whose state is unknown.
 */
export function currentPullRequest(
  thread: Pick<OrchestrationV2ThreadShell, "pullRequests" | "linkedPullRequest">,
): ThreadPullRequestSummary | null {
  const visible = (thread.pullRequests ?? []).filter((link) => link.source !== "stack-dismissed");
  if (visible.length === 0) {
    const legacy = thread.linkedPullRequest ?? null;
    if (legacy === null) return null;
    return {
      number: legacy.number,
      url: legacy.url,
      repository: legacy.repository,
      state: null,
      draft: false,
      checks: null,
      others: 0,
    };
  }
  const open = visible.filter(isOpenLink);
  const pool = open.length > 0 ? open : visible;
  const when = (link: ThreadPullRequestLink) =>
    open.length > 0 ? parseMs(link.linkedAt) : parseMs(link.snapshot?.updatedAt ?? link.linkedAt);
  const link = pool.reduce((best, candidate) => (when(candidate) > when(best) ? candidate : best));
  return {
    number: link.number,
    url: link.url,
    repository: link.repository,
    state: link.snapshot?.state ?? null,
    draft: link.snapshot?.isDraft === true,
    checks: link.snapshot?.checksState ?? null,
    others: visible.length - 1,
  };
}

export function toThreadSummary(
  thread: OrchestrationV2ThreadShell,
  location: "active" | "archive",
): ThreadSummary {
  const updatedAt = DateTime.toEpochMillis(thread.updatedAt);
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    status: thread.status,
    activeRunId: thread.activeRunId,
    pendingRequest: thread.pendingRuntimeRequest,
    model: `${thread.modelSelection.instanceId}/${thread.modelSelection.model}`,
    modelSelection: thread.modelSelection,
    branch: thread.branch,
    lastError: thread.lastError ?? null,
    latestMessage:
      thread.latestVisibleMessage === null
        ? null
        : {
            role: thread.latestVisibleMessage.role,
            preview: preview(thread.latestVisibleMessage.text),
          },
    parentThreadId: thread.lineage.parentThreadId,
    relationshipToParent: thread.lineage.relationshipToParent,
    createdAt: DateTime.toEpochMillis(thread.createdAt),
    updatedAt,
    // Upstream sorts by the latest user message, falling back to the last update.
    lastActivityAt: epochMs(thread.latestUserMessageAt) ?? updatedAt,
    archived: location === "archive" || thread.archivedAt !== null,
    pinned: thread.pinnedAt != null,
    pinOrderKey: thread.pinOrderKey ?? null,
    settled: thread.settledOverride === "settled",
    settledAt: epochMs(thread.settledAt),
    snoozedUntil: epochMs(thread.snoozedUntil),
    snoozedAt: epochMs(thread.snoozedAt),
    latestRunCompletedAt: epochMs(thread.latestRunCompletedAt),
    pullRequest: currentPullRequest(thread),
  };
}

/** Keeps a resolved repository identity when an update arrives without one (same root). */
function retainRepositoryIdentity(
  previous: OrchestrationProjectShell | undefined,
  next: OrchestrationProjectShell,
): OrchestrationProjectShell {
  if (
    next.repositoryIdentity == null &&
    previous?.repositoryIdentity != null &&
    previous.workspaceRoot === next.workspaceRoot
  ) {
    return { ...next, repositoryIdentity: previous.repositoryIdentity };
  }
  return next;
}

function enrichProjects(
  state: ShellState,
  snapshot: OrchestrationV2ShellSnapshot,
  resolvedRoots: ReadonlyArray<string>,
): ShellState {
  const roots = new Set(resolvedRoots);
  let projects: Record<string, OrchestrationProjectShell> | null = null;
  for (const candidate of snapshot.projects) {
    const project = state.projects[candidate.id];
    if (project === undefined || project.workspaceRoot !== candidate.workspaceRoot) continue;
    const accept =
      roots.has(project.workspaceRoot) ||
      (project.repositoryIdentity == null && candidate.repositoryIdentity != null);
    if (!accept || project.repositoryIdentity === candidate.repositoryIdentity) continue;
    projects ??= { ...state.projects };
    projects[project.id] = { ...project, repositoryIdentity: candidate.repositoryIdentity ?? null };
  }
  return projects === null ? state : { ...state, projects };
}

export function applyShellSnapshot(state: ShellState, item: ShellSnapshotItem): ShellState {
  const { snapshot } = item;
  if (item.resolvedRepositoryIdentityRoots !== undefined) {
    return enrichProjects(state, snapshot, item.resolvedRepositoryIdentityRoots);
  }
  const projects: Record<string, OrchestrationProjectShell> = {};
  for (const project of snapshot.projects) {
    projects[project.id] = retainRepositoryIdentity(state.projects[project.id], project);
  }
  const threads: Record<string, ThreadSummary> = {};
  for (const thread of snapshot.archivedThreads) {
    threads[thread.id] = toThreadSummary(thread, "archive");
  }
  for (const thread of snapshot.threads) threads[thread.id] = toThreadSummary(thread, "active");
  return { ...state, sequence: snapshot.snapshotSequence, projects, threads };
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export function applyShellEvent(state: ShellState, item: ShellEventItem): ShellState {
  if (state.sequence !== null && item.sequence <= state.sequence) return state;
  const base = { ...state, sequence: item.sequence };
  switch (item.kind) {
    case "project.updated":
      return {
        ...base,
        projects: {
          ...state.projects,
          [item.project.id]: retainRepositoryIdentity(
            state.projects[item.project.id],
            item.project,
          ),
        },
      };
    case "project.removed":
      return { ...base, projects: without(state.projects, item.projectId) };
    case "thread.updated":
      return {
        ...base,
        threads: {
          ...state.threads,
          [item.thread.id]: toThreadSummary(item.thread, item.location),
        },
      };
    case "thread.removed": {
      // Archiving can arrive as "removed from active" next to "updated in
      // archive"; only drop the entry if it is in the list being removed from.
      const existing = state.threads[item.threadId];
      if (existing !== undefined && (existing.archived ? "archive" : "active") !== item.location) {
        return base;
      }
      return { ...base, threads: without(state.threads, item.threadId) };
    }
    default:
      item satisfies never;
      return state;
  }
}

/** Applies any shell stream item. Never throws on unexpected input. */
export function applyShellStreamItem(
  state: ShellState,
  item: OrchestrationV2ShellStreamItem,
): ShellState {
  switch (item.kind) {
    case "synchronized":
      return state.synchronized ? state : { ...state, synchronized: true };
    case "snapshot":
      return applyShellSnapshot(state, item);
    case "project.updated":
    case "project.removed":
    case "thread.updated":
    case "thread.removed":
      return applyShellEvent(state, item);
    default:
      item satisfies never;
      return state;
  }
}

export function toConnectionView(status: ConnectionStatus): ConnectionView {
  switch (status._tag) {
    case "connecting":
      return { state: "connecting", attempt: status.attempt };
    case "connected":
      return {
        state: "connected",
        generation: status.session.generation,
        serverVersion: status.session.environment.serverVersion,
        environmentLabel: status.session.environment.label,
      };
    case "disconnected":
      return {
        state: "disconnected",
        reason: status.reason,
        attempt: status.attempt,
        retryAt: status.retryAt,
      };
    case "failed":
      return { state: "failed", reason: status.error.reason, message: status.error.message };
  }
}

export function applyConnectionStatus(state: ShellState, status: ConnectionStatus): ShellState {
  const connection = toConnectionView(status);
  // A new session replays the shell; "synchronized" is reported again for it.
  return {
    ...state,
    connection,
    synchronized: connection.state === "connected" ? state.synchronized : false,
  };
}
