/** Builds decoded shell snapshots for tests from a few thread fields. */
import { OrchestrationV2ShellStreamItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

type Json = Record<string, unknown>;

const decode = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ShellStreamItem));

const NOW = "2026-11-02T06:44:00.000Z";

export function threadShell(id: string, projectId: string, overrides: Json = {}): Json {
  return {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId,
    title: `thread ${id}`,
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  };
}

export function projectShell(id: string, title: string, overrides: Json = {}): Json {
  return {
    id,
    title,
    workspaceRoot: `/workspace/${title}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function shellSnapshot(
  projects: ReadonlyArray<Json>,
  threads: ReadonlyArray<Json>,
  archivedThreads: ReadonlyArray<Json> = [],
) {
  return decode({
    kind: "snapshot",
    snapshot: { schemaVersion: 1, snapshotSequence: 100, projects, threads, archivedThreads },
  });
}
