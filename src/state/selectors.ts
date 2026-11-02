/**
 * Pure selectors that derive display data from the state shapes in
 * `types.ts`. Display items are cached per turn item object, so an unchanged
 * item keeps the same display object across recomputations and a UI can key
 * on identity as well as on `id`.
 */
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  ProviderApprovalOption,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type {
  AssistantMessageDisplayItem,
  DisplayItem,
  PendingRequest,
  ProjectGroup,
  QueuedRun,
  ShellState,
  ThreadSection,
  ThreadStatus,
  ThreadSummary,
  ThreadViewState,
  ToolCallDisplayItem,
} from "./types.ts";

type Origin = OrchestrationV2ProjectedTurnItem["visibility"];

const iso = (value: DateTime.Utc): string => DateTime.formatIso(value);
const isoOrNull = (value: DateTime.Utc | null): string | null =>
  value === null ? null : DateTime.formatIso(value);

// ---------------------------------------------------------------------------
// Visibility

/**
 * Which of the thread's own turn items belong in the transcript. Ported from
 * upstream `packages/shared/src/orchestrationV2Timeline.ts`
 * (`createOrchestrationV2TurnItemVisibility`).
 */
export function createTurnItemVisibility(
  state: Pick<ThreadViewState, "runs" | "attempts" | "turnItems">,
): (item: OrchestrationV2TurnItem) => boolean {
  const supersededRoots = new Map<string, Set<string>>();
  for (const attempt of Object.values(state.attempts)) {
    if (attempt.status !== "superseded") continue;
    let roots = supersededRoots.get(attempt.runId);
    if (roots === undefined) {
      roots = new Set();
      supersededRoots.set(attempt.runId, roots);
    }
    roots.add(attempt.rootNodeId);
  }
  const interruptRuns = new Set<string | null>();
  for (const item of Object.values(state.turnItems)) {
    if (item.type === "run_interrupt_request") interruptRuns.add(item.runId);
  }
  return (item) => {
    const status = item.runId === null ? undefined : state.runs[item.runId]?.status;
    if (status === "rolled_back") return false;
    // A cancelled queued message never reached the provider: composer state, not history.
    if (
      status === "cancelled" &&
      item.type === "user_message" &&
      item.inputIntent === "queued_turn"
    )
      return false;
    return !(
      item.type === "run_interrupt_result" &&
      item.runId !== null &&
      item.nodeId !== null &&
      supersededRoots.get(item.runId)?.has(item.nodeId) === true &&
      !interruptRuns.has(item.runId)
    );
  };
}

// ---------------------------------------------------------------------------
// Display items

function compactJson(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** The most telling argument of a dynamic tool call, else its JSON input. */
function dynamicToolArgs(input: unknown): string {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "pattern", "query", "url"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return compactJson(input);
}

interface ItemContext {
  readonly messages: ThreadViewState["messages"];
  readonly runtimeRequests: ThreadViewState["runtimeRequests"];
}

function base(item: OrchestrationV2TurnItem, origin: Origin) {
  return {
    id: item.id as string,
    runId: item.runId,
    status: item.status,
    origin,
    hidden: false,
    title: item.title?.trim() || null,
    startedAt: isoOrNull(item.startedAt),
    updatedAt: iso(item.updatedAt),
  };
}

function tool(
  item: OrchestrationV2TurnItem,
  origin: Origin,
  fields: Pick<ToolCallDisplayItem, "tool" | "name" | "args"> &
    Partial<
      Pick<ToolCallDisplayItem, "result" | "resultOmitted" | "failed" | "exitCode" | "files">
    >,
): ToolCallDisplayItem {
  return {
    ...base(item, origin),
    kind: "tool_call",
    result: null,
    resultOmitted: false,
    failed: item.status === "failed",
    exitCode: null,
    files: [],
    collapsedByDefault: true,
    ...fields,
  };
}

function notice(item: OrchestrationV2TurnItem, origin: Origin, text: string): DisplayItem {
  return { ...base(item, origin), kind: "notice", noticeType: item.type, text };
}

function requestResolution(request: OrchestrationV2RuntimeRequest | undefined): string | null {
  if (request === undefined || request.status === "pending") return null;
  if (request.decision !== undefined) return request.decision;
  if (request.answers !== undefined) return "answered";
  return request.status;
}

/** Shapes one turn item for display. Exported for tests; use `selectTranscript`. */
export function toDisplayItem(
  item: OrchestrationV2TurnItem,
  origin: Origin,
  context: ItemContext,
): DisplayItem {
  switch (item.type) {
    case "user_message":
      return {
        ...base(item, origin),
        kind: "user_message",
        messageId: item.messageId,
        text: item.text,
        attachmentCount: item.attachments.length,
        inputIntent: item.inputIntent,
      };
    case "assistant_message": {
      // `message.updated` can run ahead of the turn item while text streams;
      // show whichever was updated last.
      const message = context.messages[item.messageId];
      const fresher =
        message !== undefined &&
        DateTime.toEpochMillis(message.updatedAt) > DateTime.toEpochMillis(item.updatedAt);
      return {
        ...base(item, origin),
        kind: "assistant_message",
        messageId: item.messageId,
        text: fresher ? message.text : item.text,
        streaming: fresher ? message.streaming : item.streaming,
      };
    }
    case "reasoning":
      return {
        ...base(item, origin),
        kind: "reasoning",
        text: item.text,
        streaming: item.streaming,
      };
    case "proposed_plan":
      return {
        ...base(item, origin),
        kind: "plan",
        planId: item.planId,
        planKind: "proposed_plan",
        markdown: item.markdown,
        steps: [],
        explanation: null,
        streaming: item.streaming,
      };
    case "todo_list":
      return {
        ...base(item, origin),
        kind: "plan",
        planId: item.planId,
        planKind: "todo_list",
        markdown: null,
        steps: item.steps,
        explanation: item.explanation ?? null,
        streaming: false,
      };
    case "command_execution":
      return tool(item, origin, {
        tool: "command",
        name: item.title?.trim() || "command",
        args: item.input,
        result: item.output ?? null,
        resultOmitted: item.outputOmitted === true,
        failed:
          item.status === "failed" ||
          item.outputIndicatesFailure === true ||
          (item.exitCode !== undefined && item.exitCode !== 0),
        exitCode: item.exitCode ?? null,
      });
    case "file_change": {
      const files = item.changes?.map((change) => change.path) ?? [item.fileName];
      const counts =
        item.additions === undefined && item.deletions === undefined
          ? null
          : `+${item.additions ?? 0} -${item.deletions ?? 0}`;
      return tool(item, origin, {
        tool: "file_change",
        name: item.title?.trim() || "edit",
        args: files.join(", "),
        result: item.diffStr ?? counts,
        files,
      });
    }
    case "file_search":
      return tool(item, origin, {
        tool: "file_search",
        name: item.title?.trim() || "search",
        args: item.pattern ?? "",
        result:
          item.results === undefined
            ? null
            : item.results
                .map((r) => (r.line === undefined ? r.fileName : `${r.fileName}:${r.line}`))
                .join("\n"),
        files: item.results?.map((r) => r.fileName) ?? [],
      });
    case "web_search":
      return tool(item, origin, {
        tool: "web_search",
        name: item.title?.trim() || "web search",
        args: item.patterns?.join(", ") ?? "",
        result:
          item.results === undefined
            ? null
            : item.results.map((r) => [r.title, r.url].filter(Boolean).join(" ")).join("\n"),
      });
    case "dynamic_tool":
      return tool(item, origin, {
        tool: "dynamic_tool",
        name: item.toolName ?? (item.title?.trim() || "tool"),
        args: dynamicToolArgs(item.input),
        result: item.output === undefined ? null : compactJson(item.output),
        resultOmitted: item.outputOmitted === true,
      });
    case "approval_request": {
      const request = context.runtimeRequests[item.requestId];
      return {
        ...base(item, origin),
        kind: "request",
        requestId: item.requestId,
        requestType: "approval",
        requestKind: item.requestKind,
        prompt: item.prompt ?? item.reason ?? null,
        open: request?.status === "pending",
        resolution: requestResolution(request),
      };
    }
    case "user_input_request": {
      const request = context.runtimeRequests[item.requestId];
      return {
        ...base(item, origin),
        kind: "request",
        requestId: item.requestId,
        requestType: "user_input",
        requestKind: "user_input",
        prompt: item.questions.map((question) => question.question).join("\n") || null,
        open: request?.status === "pending",
        resolution: item.questionAnswer !== undefined ? "answered" : requestResolution(request),
      };
    }
    case "subagent":
      return {
        ...base(item, origin),
        kind: "subagent",
        subagentId: item.subagentId,
        childThreadId: item.childThreadId,
        prompt: item.prompt,
        progress: item.progress ?? null,
        result: item.result,
      };
    case "checkpoint":
      return {
        ...base(item, origin),
        kind: "checkpoint",
        hidden: true,
        files: item.files.map((file) => file.path),
      };
    case "error":
      return {
        ...base(item, origin),
        kind: "error",
        label:
          item.failure.class === "usage_limit"
            ? "Usage limit reached"
            : item.title?.trim() || "Provider error",
        message: item.failure.message,
      };
    case "notification":
      return notice(item, origin, item.summary);
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return notice(item, origin, item.message);
    case "compaction":
      return notice(item, origin, item.summary ?? "Context compacted");
    case "handoff":
      return notice(item, origin, item.summary ?? `Context handed off (${item.strategy})`);
    case "fork":
      return notice(item, origin, item.title?.trim() || "Forked");
    case "thread_created":
      return notice(item, origin, `Created thread (${item.targetModel})`);
    case "secret_request":
      return notice(item, origin, `Secret requested: ${item.label} (${item.secretStatus})`);
    default:
      item satisfies never;
      return notice(item, origin, (item as { type: string }).type);
  }
}

interface CacheEntry {
  readonly origin: Origin;
  readonly message: OrchestrationV2ConversationMessage | undefined;
  readonly request: OrchestrationV2RuntimeRequest | undefined;
  readonly value: DisplayItem;
}

const displayCache = new WeakMap<OrchestrationV2TurnItem, CacheEntry>();

function cachedDisplayItem(
  item: OrchestrationV2TurnItem,
  origin: Origin,
  context: ItemContext,
): DisplayItem {
  const message = item.type === "assistant_message" ? context.messages[item.messageId] : undefined;
  const request =
    item.type === "approval_request" || item.type === "user_input_request"
      ? context.runtimeRequests[item.requestId]
      : undefined;
  const cached = displayCache.get(item);
  if (
    cached !== undefined &&
    cached.origin === origin &&
    cached.message === message &&
    cached.request === request
  ) {
    return cached.value;
  }
  const value = toDisplayItem(item, origin, context);
  displayCache.set(item, { origin, message, request, value });
  return value;
}

const provisionalCache = new WeakMap<
  OrchestrationV2ConversationMessage,
  AssistantMessageDisplayItem
>();

/** A streaming assistant message whose turn item has not arrived yet. */
function provisionalAssistantItem(
  message: OrchestrationV2ConversationMessage,
): AssistantMessageDisplayItem {
  const cached = provisionalCache.get(message);
  if (cached !== undefined) return cached;
  const value: AssistantMessageDisplayItem = {
    id: `message:${message.id}`,
    kind: "assistant_message",
    runId: message.runId,
    status: "running",
    origin: "local",
    hidden: false,
    title: null,
    startedAt: iso(message.createdAt),
    updatedAt: iso(message.updatedAt),
    messageId: message.id,
    text: message.text,
    streaming: true,
  };
  provisionalCache.set(message, value);
  return value;
}

export function compareTurnItems(a: OrchestrationV2TurnItem, b: OrchestrationV2TurnItem): number {
  return a.ordinal - b.ordinal || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface TranscriptOptions {
  /** Include bookkeeping rows (checkpoints). Default false. */
  readonly includeHidden?: boolean;
}

/**
 * The transcript in display order: inherited rows (fork history) first, then
 * the thread's own visible items by ordinal, then any streaming assistant
 * message the server has not yet attached to a turn item.
 */
export function selectTranscript(
  state: ThreadViewState,
  options: TranscriptOptions = {},
): ReadonlyArray<DisplayItem> {
  const context: ItemContext = { messages: state.messages, runtimeRequests: state.runtimeRequests };
  const items: DisplayItem[] = [];
  const push = (item: DisplayItem) => {
    if (options.includeHidden === true || !item.hidden) items.push(item);
  };
  for (const row of state.inheritedItems)
    push(cachedDisplayItem(row.item, row.visibility, context));

  const isVisible = createTurnItemVisibility(state);
  const local = Object.values(state.turnItems).filter(isVisible).sort(compareTurnItems);
  const attachedMessages = new Set<string>();
  for (const item of local) {
    if (item.type === "assistant_message") attachedMessages.add(item.messageId);
    push(cachedDisplayItem(item, "local", context));
  }
  for (const message of Object.values(state.messages)) {
    if (message.role === "assistant" && message.streaming && !attachedMessages.has(message.id)) {
      const runStatus = message.runId === null ? undefined : state.runs[message.runId]?.status;
      if (runStatus !== "rolled_back") push(provisionalAssistantItem(message));
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Runs, requests, queue

export const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/** The newest run that is preparing, starting, running or waiting, if any. */
export function selectActiveRun(state: ThreadViewState): OrchestrationV2Run | null {
  let active: OrchestrationV2Run | null = null;
  for (const run of Object.values(state.runs)) {
    if (ACTIVE_RUN_STATUSES.has(run.status) && (active === null || run.ordinal > active.ordinal)) {
      active = run;
    }
  }
  return active;
}

export function selectQueue(state: ThreadViewState): ReadonlyArray<QueuedRun> {
  return Object.values(state.runs)
    .filter((run) => run.status === "queued")
    .sort(
      (a, b) =>
        (a.queuePosition ?? Number.MAX_SAFE_INTEGER) -
          (b.queuePosition ?? Number.MAX_SAFE_INTEGER) || a.ordinal - b.ordinal,
    )
    .map((run) => ({
      runId: run.id,
      ordinal: run.ordinal,
      queuePosition: run.queuePosition ?? null,
      held: run.queueHeld === true,
      text: state.messages[run.userMessageId]?.text ?? null,
    }));
}

const TOOL_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
]);

/** What to offer when an approval carries no options of its own. */
export const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Approve" },
  { decision: "acceptForSession", label: "Approve for this session" },
  { decision: "decline", label: "Decline" },
];

/**
 * Open runtime requests, oldest first, joined with the turn item that
 * describes them. Follows upstream `derivePendingThreadRequests`
 * (`packages/client-runtime/src/state/threadRequests.ts`).
 */
export function selectPendingRequests(state: ThreadViewState): ReadonlyArray<PendingRequest> {
  const describing = new Map<string, OrchestrationV2TurnItem>();
  for (const item of Object.values(state.turnItems)) {
    if (item.type !== "approval_request" && item.type !== "user_input_request") continue;
    const previous = describing.get(item.requestId);
    if (previous === undefined || compareTurnItems(previous, item) < 0) {
      describing.set(item.requestId, item);
    }
  }
  // Approvals share the native item id of the tool call they gate.
  const toolByNativeId = new Map<string, OrchestrationV2TurnItem>();
  for (const item of Object.values(state.turnItems)) {
    const nativeId = item.nativeItemRef?.nativeId;
    if (nativeId != null && TOOL_ITEM_TYPES.has(item.type)) toolByNativeId.set(nativeId, item);
  }
  const context: ItemContext = { messages: state.messages, runtimeRequests: state.runtimeRequests };
  const pending = Object.values(state.runtimeRequests)
    .filter((request) => request.status === "pending")
    .sort(
      (a, b) =>
        DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
        (a.id < b.id ? -1 : 1),
    );
  const result: PendingRequest[] = [];
  for (const request of pending) {
    const createdAt = iso(request.createdAt);
    const responseCapability = request.responseCapability.type;
    const item = describing.get(request.id);
    const runId = item?.runId ?? state.nodes[request.nodeId]?.runId ?? null;
    switch (request.kind) {
      case "user_input": {
        const questions = item?.type === "user_input_request" ? item.questions : [];
        result.push({
          type: "user_input",
          requestId: request.id,
          runId,
          createdAt,
          questions,
          responseCapability,
          answerableByMessage:
            responseCapability === "message" ||
            (item?.type === "user_input_request" && item.responseMode === "message"),
          turnItemId: item?.id ?? null,
        });
        break;
      }
      case "dynamic_tool_call":
      case "auth_refresh":
        result.push({
          type: "other",
          requestId: request.id,
          requestKind: request.kind,
          createdAt,
          responseCapability,
        });
        break;
      default: {
        const approval = item?.type === "approval_request" ? item : undefined;
        const nativeId =
          request.nativeRequestRef?.nativeId ?? approval?.nativeItemRef?.nativeId ?? null;
        const toolItem = nativeId === null ? undefined : toolByNativeId.get(nativeId);
        const toolCall =
          toolItem === undefined ? undefined : cachedDisplayItem(toolItem, "local", context);
        result.push({
          type: "approval",
          requestId: request.id,
          requestKind: request.kind,
          runId,
          createdAt,
          prompt: approval?.prompt ?? null,
          reason: approval?.reason ?? null,
          title: approval?.title?.trim() || null,
          toolCallId: toolItem?.id ?? null,
          subject: toolCall?.kind === "tool_call" ? toolCall.args || null : null,
          options:
            approval?.options !== undefined && approval.options.length > 0
              ? approval.options
              : DEFAULT_APPROVAL_OPTIONS,
          responseCapability,
          turnItemId: approval?.id ?? null,
        });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Shell

function compareThreads(a: ThreadSummary, b: ThreadSummary): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.pinned && b.pinned && a.pinOrderKey !== b.pinOrderKey) {
    if (a.pinOrderKey === null) return 1;
    if (b.pinOrderKey === null) return -1;
    return a.pinOrderKey < b.pinOrderKey ? -1 : 1;
  }
  return b.lastActivityAt - a.lastActivityAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface ThreadGroupOptions {
  /** Include archived threads. Default false. */
  readonly includeArchived?: boolean;
  /** Include projects without (matching) threads. Default true. */
  readonly includeEmptyProjects?: boolean;
}

/** Threads grouped by project; groups and threads ordered by last activity, newest first. */
export function selectProjectGroups(
  state: ShellState,
  options: ThreadGroupOptions = {},
): ReadonlyArray<ProjectGroup> {
  const byProject = new Map<string, ThreadSummary[]>();
  for (const thread of Object.values(state.threads)) {
    if (thread.archived && options.includeArchived !== true) continue;
    let list = byProject.get(thread.projectId);
    if (list === undefined) {
      list = [];
      byProject.set(thread.projectId, list);
    }
    list.push(thread);
  }
  const groups: ProjectGroup[] = [];
  const seen = new Set<string>();
  const addGroup = (projectId: string) => {
    seen.add(projectId);
    const project = state.projects[projectId] ?? null;
    const threads = (byProject.get(projectId) ?? []).sort(compareThreads);
    if (threads.length === 0 && options.includeEmptyProjects === false) return;
    const newest = threads.reduce((max, thread) => Math.max(max, thread.lastActivityAt), -Infinity);
    const projectUpdated = project === null ? Number.NaN : Date.parse(project.updatedAt);
    groups.push({
      projectId: (project?.id ?? threads[0]?.projectId) as ProjectGroup["projectId"],
      project,
      title: project?.title ?? projectId,
      threads,
      lastActivityAt: Number.isFinite(newest)
        ? newest
        : Number.isFinite(projectUpdated)
          ? projectUpdated
          : 0,
    });
  };
  for (const projectId of Object.keys(state.projects)) addGroup(projectId);
  for (const projectId of byProject.keys()) if (!seen.has(projectId)) addGroup(projectId);
  return groups.sort(
    (a, b) => b.lastActivityAt - a.lastActivityAt || (a.projectId < b.projectId ? -1 : 1),
  );
}

// ---------------------------------------------------------------------------
// Thread status, settled and snoozed

const ACTIVE_SHELL_STATUSES: ReadonlySet<ThreadSummary["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/**
 * A request for the user or a fresh failure ends a snooze early; finished runs
 * do not. Upstream `threadRaisedHandWhileSnoozed`
 * (`packages/client-runtime/src/state/threadSettled.ts`).
 */
function raisedHandWhileSnoozed(thread: ThreadSummary): boolean {
  if (thread.pendingRequest !== null) return true;
  if (thread.status !== "failed") return false;
  const failedAt = thread.latestRunCompletedAt;
  return thread.snoozedAt === null || (failedAt !== null && failedAt > thread.snoozedAt);
}

/** Snoozed right now: the wake time is ahead and nothing woke it early (upstream `effectiveSnoozed`). */
export function isEffectivelySnoozed(thread: ThreadSummary, now: number): boolean {
  if (thread.snoozedUntil === null || thread.snoozedUntil <= now) return false;
  return !raisedHandWhileSnoozed(thread);
}

/**
 * Which part of the thread list a thread belongs in. Like the web sidebar
 * (`resolveSidebarThreadSection`): snoozed wins over settled; everything else
 * is active.
 */
export function selectThreadSection(thread: ThreadSummary, now: number): ThreadSection {
  if (isEffectivelySnoozed(thread, now)) return "snoozed";
  if (thread.settled) return "settled";
  return "active";
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Time left until `wakeAt`: `5m`, `3h`, `2d` (rounded up, like upstream `snoozeWakeLabel`). */
export function timeUntil(wakeAt: number, now: number): string {
  const remaining = wakeAt - now;
  if (remaining <= 0) return "now";
  if (remaining < HOUR_MS) return `${Math.max(1, Math.ceil(remaining / MINUTE_MS))}m`;
  if (remaining < DAY_MS) return `${Math.ceil(remaining / HOUR_MS)}h`;
  return `${Math.ceil(remaining / DAY_MS)}d`;
}

function pullRequestStatus(pr: NonNullable<ThreadSummary["pullRequest"]>): ThreadStatus {
  const base = `PR #${pr.number}`;
  if (pr.state === "merged") return { kind: "pr", label: `${base} merged`, tone: "merged" };
  if (pr.state === "closed") return { kind: "pr", label: `${base} closed`, tone: "dim" };
  const draft = pr.draft ? " draft" : "";
  switch (pr.checks) {
    case "failing":
      return { kind: "pr", label: `${base}${draft} ✕`, tone: "error" };
    case "pending":
      return { kind: "pr", label: `${base}${draft} …`, tone: "info" };
    case "passing":
      return { kind: "pr", label: `${base}${draft} ✓`, tone: "info" };
    default:
      return { kind: "pr", label: `${base}${draft}`, tone: "info" };
  }
}

/**
 * The status label for a thread, most pressing first: archived, waiting for
 * the user (approval / question), working, queued, snoozed, failed, settled,
 * a linked pull request, idle. `now` (epoch ms) decides whether a snooze is
 * still on.
 */
export function selectThreadStatus(thread: ThreadSummary, now: number): ThreadStatus {
  if (thread.archived) return { kind: "archived", label: "archived", tone: "dim" };
  const request = thread.pendingRequest;
  if (request !== null) {
    const label =
      request.kind === "user_input"
        ? "question"
        : request.kind === "dynamic_tool_call" || request.kind === "auth_refresh"
          ? "request"
          : "approval";
    return { kind: "approval", label, tone: "warn" };
  }
  if (ACTIVE_SHELL_STATUSES.has(thread.status)) {
    return { kind: "working", label: "working", tone: "ok" };
  }
  if (thread.status === "queued") return { kind: "queued", label: "queued", tone: "ok" };
  if (isEffectivelySnoozed(thread, now) && thread.snoozedUntil !== null) {
    return {
      kind: "snoozed",
      label: `snoozed until ${timeUntil(thread.snoozedUntil, now)}`,
      tone: "dim",
    };
  }
  if (thread.status === "failed") return { kind: "failed", label: "failed", tone: "error" };
  if (thread.settled) return { kind: "settled", label: "settled", tone: "dim" };
  if (thread.pullRequest !== null) return pullRequestStatus(thread.pullRequest);
  return {
    kind: "idle",
    label: thread.status === "interrupted" ? "interrupted" : "idle",
    tone: "dim",
  };
}

/**
 * Order inside the settled / snoozed section: snoozed threads first, soonest
 * wake first; then settled threads, most recently settled first (upstream
 * sorts the two shelves the same way).
 */
export function compareSettledThreads(a: ThreadSummary, b: ThreadSummary, now: number): number {
  const aSnoozed = isEffectivelySnoozed(a, now);
  const bSnoozed = isEffectivelySnoozed(b, now);
  if (aSnoozed !== bSnoozed) return aSnoozed ? -1 : 1;
  if (aSnoozed) {
    return (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0) || (a.id < b.id ? -1 : 1);
  }
  const aAt = a.settledAt ?? a.lastActivityAt;
  const bAt = b.settledAt ?? b.lastActivityAt;
  return bAt - aAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
