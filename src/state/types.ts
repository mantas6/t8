/**
 * State shapes for the client stores. Plain data, framework-agnostic: the
 * reducers produce these, the Solid stores in `store.ts` hold them, and the
 * selectors in `selectors.ts` derive display data from them.
 *
 * Entity maps are `Record`s keyed by id so a store can update one entity
 * without touching the others. Contract objects are stored as decoded (their
 * timestamps are `DateTime.Utc` values); derived display data uses ISO strings
 * and epoch milliseconds instead.
 */
import type {
  ModelSelection,
  OrchestrationProjectShell,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2PendingRuntimeRequestSummary,
  OrchestrationV2PlanArtifact,
  OrchestrationV2PlanStep,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ShellThreadStatus,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemStatus,
  OrchestrationV2UserInputQuestion,
  OrchestrationV2UserMessageInputIntent,
  ProjectId,
  ProviderApprovalOption,
  ProviderRequestKind,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";

import type { FatalReason } from "../connection/connection.ts";

// ---------------------------------------------------------------------------
// Connection

export type ConnectionView =
  | { readonly state: "connecting"; readonly attempt: number }
  | {
      readonly state: "connected";
      readonly generation: number;
      readonly serverVersion: string;
      readonly environmentLabel: string;
    }
  | {
      readonly state: "disconnected";
      readonly reason: string;
      readonly attempt: number;
      /** Epoch ms of the next attempt. */
      readonly retryAt: number;
    }
  | { readonly state: "failed"; readonly reason: FatalReason; readonly message: string };

// ---------------------------------------------------------------------------
// Shell

export interface ThreadSummary {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly status: OrchestrationV2ShellThreadStatus;
  readonly activeRunId: RunId | null;
  readonly pendingRequest: OrchestrationV2PendingRuntimeRequestSummary | null;
  /** `instanceId/model` */
  readonly model: string;
  readonly modelSelection: ModelSelection;
  readonly branch: string | null;
  readonly lastError: string | null;
  readonly latestMessage: { readonly role: string; readonly preview: string } | null;
  readonly parentThreadId: ThreadId | null;
  readonly relationshipToParent: "fork" | "subagent" | null;
  /** Epoch ms. */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Latest user message, else last update: what the thread list sorts by. */
  readonly lastActivityAt: number;
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly pinOrderKey: string | null;
}

export interface ShellState {
  readonly connection: ConnectionView;
  /** The server has replayed everything up to now at least once. */
  readonly synchronized: boolean;
  /** Last applied shell sequence; null before the first snapshot. */
  readonly sequence: number | null;
  readonly projects: Readonly<Record<string, OrchestrationProjectShell>>;
  readonly threads: Readonly<Record<string, ThreadSummary>>;
}

export interface ProjectGroup {
  readonly projectId: ProjectId;
  /** Null when a thread references a project the shell has not listed. */
  readonly project: OrchestrationProjectShell | null;
  readonly title: string;
  /** Pinned first, then most recent activity first. */
  readonly threads: ReadonlyArray<ThreadSummary>;
  /** Epoch ms; the newest thread's activity, else the project's last update. */
  readonly lastActivityAt: number;
}

// ---------------------------------------------------------------------------
// Thread view

export type ThreadViewPhase = "closed" | "loading" | "ready";

export interface ThreadViewState {
  readonly threadId: ThreadId | null;
  readonly phase: ThreadViewPhase;
  /** Last applied sequence (snapshot or event); null before the snapshot. */
  readonly sequence: number | null;
  readonly thread: OrchestrationV2AppThread | null;
  readonly runs: Readonly<Record<string, OrchestrationV2Run>>;
  readonly attempts: Readonly<Record<string, OrchestrationV2RunAttempt>>;
  readonly nodes: Readonly<Record<string, OrchestrationV2ExecutionNode>>;
  readonly subagents: Readonly<Record<string, OrchestrationV2Subagent>>;
  /** This thread's own turn items. */
  readonly turnItems: Readonly<Record<string, OrchestrationV2TurnItem>>;
  /**
   * Rows the server projects into this thread from elsewhere (history
   * inherited from a fork source, plus the synthetic fork marker). They always
   * precede the thread's own items and only change with a new snapshot.
   */
  readonly inheritedItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly messages: Readonly<Record<string, OrchestrationV2ConversationMessage>>;
  readonly runtimeRequests: Readonly<Record<string, OrchestrationV2RuntimeRequest>>;
  readonly plans: Readonly<Record<string, OrchestrationV2PlanArtifact>>;
  /** The snapshot was a bounded window; older history exists on the server. */
  readonly hasMoreHistory: boolean;
}

// ---------------------------------------------------------------------------
// Display items (the transcript)

interface DisplayItemBase {
  /** Stable key: the turn item id (`message:<id>` for a provisional assistant message). */
  readonly id: string;
  readonly runId: RunId | null;
  readonly status: OrchestrationV2TurnItemStatus;
  readonly origin: OrchestrationV2ProjectedTurnItem["visibility"];
  /** Bookkeeping rows (checkpoints) a transcript normally leaves out. */
  readonly hidden: boolean;
  readonly title: string | null;
  /** ISO timestamps. */
  readonly startedAt: string | null;
  readonly updatedAt: string;
}

export interface UserMessageDisplayItem extends DisplayItemBase {
  readonly kind: "user_message";
  readonly messageId: string;
  readonly text: string;
  readonly attachmentCount: number;
  readonly inputIntent: OrchestrationV2UserMessageInputIntent;
}

export interface AssistantMessageDisplayItem extends DisplayItemBase {
  readonly kind: "assistant_message";
  readonly messageId: string;
  readonly text: string;
  readonly streaming: boolean;
}

export type ToolKind = "command" | "file_change" | "file_search" | "web_search" | "dynamic_tool";

export interface ToolCallDisplayItem extends DisplayItemBase {
  readonly kind: "tool_call";
  readonly tool: ToolKind;
  /** Short tool name, e.g. `Bash`, `Edit`, an MCP tool name. */
  readonly name: string;
  /** One-line rendering of the input (command line, file, pattern, JSON args). */
  readonly args: string;
  /** Output, when the server sent it. */
  readonly result: string | null;
  /** The server withheld the output; fetch it with `getTurnItem`. */
  readonly resultOmitted: boolean;
  readonly failed: boolean;
  readonly exitCode: number | null;
  readonly files: ReadonlyArray<string>;
  readonly collapsedByDefault: true;
}

export interface ReasoningDisplayItem extends DisplayItemBase {
  readonly kind: "reasoning";
  readonly text: string;
  readonly streaming: boolean;
}

export interface PlanDisplayItem extends DisplayItemBase {
  readonly kind: "plan";
  readonly planId: string;
  readonly planKind: "proposed_plan" | "todo_list";
  readonly markdown: string | null;
  readonly steps: ReadonlyArray<OrchestrationV2PlanStep>;
  readonly explanation: string | null;
  readonly streaming: boolean;
}

export interface SubagentDisplayItem extends DisplayItemBase {
  readonly kind: "subagent";
  readonly subagentId: string;
  readonly childThreadId: ThreadId | null;
  readonly prompt: string;
  readonly progress: string | null;
  readonly result: string | null;
}

/** An approval or question as it appears in the transcript (see `PendingRequest` to answer one). */
export interface RequestDisplayItem extends DisplayItemBase {
  readonly kind: "request";
  readonly requestId: RuntimeRequestId;
  readonly requestType: "approval" | "user_input";
  readonly requestKind: string;
  readonly prompt: string | null;
  /** The runtime request is still pending. */
  readonly open: boolean;
  readonly resolution: string | null;
}

export interface CheckpointDisplayItem extends DisplayItemBase {
  readonly kind: "checkpoint";
  readonly files: ReadonlyArray<string>;
}

export interface ErrorDisplayItem extends DisplayItemBase {
  readonly kind: "error";
  readonly label: string;
  readonly message: string;
}

export interface NoticeDisplayItem extends DisplayItemBase {
  readonly kind: "notice";
  readonly noticeType: OrchestrationV2TurnItem["type"];
  readonly text: string;
}

export type DisplayItem =
  | UserMessageDisplayItem
  | AssistantMessageDisplayItem
  | ToolCallDisplayItem
  | ReasoningDisplayItem
  | PlanDisplayItem
  | SubagentDisplayItem
  | RequestDisplayItem
  | CheckpointDisplayItem
  | ErrorDisplayItem
  | NoticeDisplayItem;

// ---------------------------------------------------------------------------
// Pending requests

export type ResponseCapability = OrchestrationV2RuntimeRequest["responseCapability"]["type"];

export interface PendingApproval {
  readonly type: "approval";
  readonly requestId: RuntimeRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly runId: RunId | null;
  /** ISO timestamp. */
  readonly createdAt: string;
  /** What is being approved (e.g. the command line), from the approval turn item. */
  readonly prompt: string | null;
  readonly reason: string | null;
  readonly title: string | null;
  /**
   * The tool call awaiting approval, matched by native item id. Its `args`
   * (e.g. the command line) is usually more telling than `prompt`, which
   * Claude fills with the model's own description of the action.
   */
  readonly toolCallId: string | null;
  readonly subject: string | null;
  /** Decisions to offer; a default set when the provider sent none. */
  readonly options: ReadonlyArray<ProviderApprovalOption>;
  readonly responseCapability: ResponseCapability;
  readonly turnItemId: string | null;
}

export interface PendingUserInput {
  readonly type: "user_input";
  readonly requestId: RuntimeRequestId;
  readonly runId: RunId | null;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  readonly responseCapability: ResponseCapability;
  /** Answering by sending a normal message also works. */
  readonly answerableByMessage: boolean;
  readonly turnItemId: string | null;
}

/** Requests the client can show but not answer itself (dynamic tool callbacks, auth refresh). */
export interface PendingOtherRequest {
  readonly type: "other";
  readonly requestId: RuntimeRequestId;
  readonly requestKind: "dynamic_tool_call" | "auth_refresh";
  readonly createdAt: string;
  readonly responseCapability: ResponseCapability;
}

export type PendingRequest = PendingApproval | PendingUserInput | PendingOtherRequest;

export interface QueuedRun {
  readonly runId: RunId;
  readonly ordinal: number;
  readonly queuePosition: number | null;
  readonly held: boolean;
  /** The queued message's text, when known. */
  readonly text: string | null;
}
