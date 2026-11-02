import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadStreamItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { applyShellStreamItem, initialShellState } from "../src/state/reducers/shell.ts";
import {
  applyThreadEvent,
  applyThreadStreamItem,
  closedThreadView,
  type ThreadEventItem,
} from "../src/state/reducers/thread.ts";
import {
  selectActiveRun,
  selectPendingRequests,
  selectProjectGroups,
  selectTranscript,
} from "../src/state/selectors.ts";
import { createShellStore, createThreadStore } from "../src/state/store.ts";
import type { ThreadViewState } from "../src/state/types.ts";

// ---------------------------------------------------------------------------
// Fixture: one real turn recorded from a live server ("Reply with the single
// word OK."), then the thread archived. Wire JSON, one stream item per line.

type Json = Record<string, unknown>;

const rawLines: ReadonlyArray<Json> = readFileSync(
  join(import.meta.dir, "fixtures/thread-lifecycle.ndjson"),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Json);

const decodeThreadItem = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadStreamItem),
);
const decodeShellItem = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ShellStreamItem),
);

const items = rawLines.map((line) => decodeThreadItem(line));
const snapshot = items[0];
if (snapshot?.kind !== "snapshot") throw new Error("fixture must start with a snapshot");
const THREAD_ID = snapshot.projection.thread.id;
const events = items.slice(1) as ReadonlyArray<ThreadEventItem>;

function replay(
  stream: ReadonlyArray<OrchestrationV2ThreadStreamItem>,
  from: ThreadViewState = closedThreadView,
): ThreadViewState {
  return stream.reduce(applyThreadStreamItem, from);
}

function rawEvent(type: string, predicate: (payload: Json) => boolean = () => true): Json {
  const line = rawLines.find((candidate) => {
    const event = candidate.event as Json | undefined;
    return event?.type === type && predicate(event.payload as Json);
  });
  if (line === undefined) throw new Error(`fixture has no ${type}`);
  return line;
}

/** A copy of a recorded event with a new sequence and payload changes. */
function variant(line: Json, sequence: number, payload: Json): OrchestrationV2ThreadStreamItem {
  const event = line.event as Json;
  return decodeThreadItem({
    ...line,
    sequence,
    event: {
      ...event,
      id: `${String(event.id)}:${sequence}`,
      payload: { ...(event.payload as Json), ...payload },
    },
  });
}

const ASSISTANT_MESSAGE = rawEvent("message.updated", (p) => p.role === "assistant");
const ASSISTANT_ITEM = rawEvent("turn-item.updated", (p) => p.type === "assistant_message");
const ASSISTANT_SEQUENCE = (ASSISTANT_MESSAGE.sequence as number) - 0;

// ---------------------------------------------------------------------------

describe("thread reducers: recorded lifecycle", () => {
  const final = replay(items);

  test("transcript after the full replay", () => {
    const transcript = selectTranscript(final);
    expect(transcript.map((item) => item.kind)).toEqual(["user_message", "assistant_message"]);
    const [user, assistant] = transcript;
    expect(user?.kind === "user_message" && user.text).toBe("Reply with the single word OK.");
    expect(assistant?.kind === "assistant_message" && assistant.text).toBe("OK");
    expect(assistant?.kind === "assistant_message" && assistant.streaming).toBe(false);
    // Ids are the turn item ids.
    for (const item of transcript) expect(final.turnItems[item.id]).toBeDefined();
  });

  test("checkpoints are hidden unless asked for", () => {
    const all = selectTranscript(final, { includeHidden: true });
    expect(all.map((item) => item.kind)).toEqual([
      "user_message",
      "assistant_message",
      "checkpoint",
    ]);
    expect(all[2]?.hidden).toBe(true);
  });

  test("run completed, nothing pending, thread archived", () => {
    const runs = Object.values(final.runs);
    expect(runs.map((run) => run.status)).toEqual(["completed"]);
    expect(selectActiveRun(final)).toBeNull();
    expect(selectPendingRequests(final)).toEqual([]);
    expect(final.thread?.archivedAt).not.toBeNull();
    expect(final.sequence).toBe(events.at(-1)?.sequence ?? -1);
  });

  test("the run is active mid-turn", () => {
    const midTurn = replay(
      items.filter((item) => item.kind !== "event" || item.sequence <= 166625),
    );
    expect(selectActiveRun(midTurn)?.status).toBe("running");
  });
});

describe("thread reducers: streaming", () => {
  const beforeAssistant = replay(
    items.filter((item) => item.kind !== "event" || item.sequence < ASSISTANT_SEQUENCE),
  );
  const chunks = ["Hel", "Hello, wor", "Hello, world"];
  const streamed = chunks.map((text, index) =>
    variant(ASSISTANT_MESSAGE, ASSISTANT_SEQUENCE + 1000 + index, {
      text,
      streaming: true,
      updatedAt: `2026-11-02T06:44:09.${String(341 + index).padStart(3, "0")}Z`,
    }),
  );

  test("message.updated with streaming=true shows a provisional assistant item", () => {
    let state = beforeAssistant;
    const seen: string[] = [];
    for (const item of streamed) {
      state = applyThreadStreamItem(state, item);
      const last = selectTranscript(state).at(-1);
      expect(last?.kind).toBe("assistant_message");
      if (last?.kind === "assistant_message") {
        expect(last.streaming).toBe(true);
        seen.push(last.text);
      }
    }
    expect(seen).toEqual(chunks);
    // One item with a stable id throughout.
    const ids = new Set(
      streamed.map(
        (_, index) =>
          selectTranscript(replay(streamed.slice(0, index + 1), beforeAssistant)).at(-1)?.id,
      ),
    );
    expect(ids.size).toBe(1);
  });

  test("the turn item takes over without duplicating the message", () => {
    let state = streamed.reduce(applyThreadStreamItem, beforeAssistant);
    state = applyThreadStreamItem(
      state,
      variant(ASSISTANT_ITEM, ASSISTANT_SEQUENCE + 2000, {
        text: "Hello, world",
        streaming: true,
        status: "running",
        completedAt: null,
        updatedAt: "2026-11-02T06:44:09.343Z",
      }),
    );
    let assistants = selectTranscript(state).filter((item) => item.kind === "assistant_message");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.id).toBe(
      (ASSISTANT_ITEM.event as { payload: { id: string } }).payload.id,
    );

    // A newer message chunk wins over the older turn item text.
    state = applyThreadStreamItem(
      state,
      variant(ASSISTANT_MESSAGE, ASSISTANT_SEQUENCE + 3000, {
        text: "Hello, world!",
        streaming: true,
        updatedAt: "2026-11-02T06:44:09.400Z",
      }),
    );
    assistants = selectTranscript(state).filter((item) => item.kind === "assistant_message");
    expect(assistants.map((item) => item.kind === "assistant_message" && item.text)).toEqual([
      "Hello, world!",
    ]);

    // Completion.
    state = applyThreadStreamItem(
      state,
      variant(ASSISTANT_ITEM, ASSISTANT_SEQUENCE + 4000, {
        text: "Hello, world!",
        streaming: false,
        updatedAt: "2026-11-02T06:44:09.500Z",
      }),
    );
    const done = selectTranscript(state).filter((item) => item.kind === "assistant_message");
    expect(done).toHaveLength(1);
    expect(done[0]?.kind === "assistant_message" && done[0].streaming).toBe(false);
    expect(done[0]?.kind === "assistant_message" && done[0].text).toBe("Hello, world!");
  });
});

describe("thread reducers: sequences", () => {
  const final = replay(items);

  test("replayed events are dropped", () => {
    expect(replay(events, final)).toBe(final);
    expect(selectTranscript(replay([...items, ...events]))).toEqual(selectTranscript(final));
  });

  test("events at or below the snapshot sequence are dropped", () => {
    const afterSnapshot = replay([snapshot]);
    const stale = variant(ASSISTANT_ITEM, snapshot.snapshotSequence, {});
    expect(applyThreadStreamItem(afterSnapshot, stale)).toBe(afterSnapshot);
  });

  test("events before the snapshot are ignored", () => {
    const [first] = events;
    if (first === undefined) throw new Error("no events");
    expect(applyThreadEvent(closedThreadView, first)).toBe(closedThreadView);
  });

  test("unknown events advance the cursor and change nothing else", () => {
    const afterSnapshot = replay([snapshot]);
    const unknown = decodeThreadItem({
      kind: "event",
      sequence: snapshot.snapshotSequence + 1,
      event: { type: "thread.some-future-event", payload: { anything: true } },
    });
    expect(unknown.kind).toBe("unknown-event");
    const next = applyThreadStreamItem(afterSnapshot, unknown);
    expect(next.sequence).toBe(snapshot.snapshotSequence + 1);
    expect(next.turnItems).toBe(afterSnapshot.turnItems);
  });

  test("an unexpected event type at runtime does not throw", () => {
    const afterSnapshot = replay([snapshot]);
    const bogus = {
      kind: "event",
      sequence: snapshot.snapshotSequence + 1,
      event: { type: "bogus", threadId: THREAD_ID, payload: {} },
    } as unknown as ThreadEventItem;
    expect(() => applyThreadStreamItem(afterSnapshot, bogus)).not.toThrow();
  });

  test("a snapshot for another thread is ignored", () => {
    const loading = {
      ...closedThreadView,
      threadId: "other" as ThreadId,
      phase: "loading" as const,
    };
    expect(applyThreadStreamItem(loading, snapshot)).toBe(loading);
  });
});

describe("thread reducers: tool calls and requests", () => {
  const base = replay(items.filter((item) => item.kind !== "event" || item.sequence <= 166626));
  const turnItem = ASSISTANT_ITEM.event as Json;
  const common = turnItem.payload as Json;
  const requestId = "runtime-request:test:1";
  let sequence = 170000;
  const event = (type: string, payload: Json) =>
    decodeThreadItem({
      kind: "event",
      sequence: ++sequence,
      event: { ...turnItem, id: `event:test:${sequence}`, type, payload },
    });
  const commandItem = (status: string, output?: string) =>
    event("turn-item.updated", {
      ...common,
      id: "turn-item:test:command",
      type: "command_execution",
      text: undefined,
      messageId: undefined,
      streaming: undefined,
      ordinal: 1000003,
      title: "Bash",
      status,
      input: "ls",
      ...(output === undefined ? {} : { output, exitCode: 0 }),
    });
  const approvalItem = () =>
    event("turn-item.updated", {
      ...common,
      id: "turn-item:test:approval",
      type: "approval_request",
      text: undefined,
      messageId: undefined,
      streaming: undefined,
      ordinal: 1000004,
      title: "Run command",
      status: "waiting",
      requestId,
      requestKind: "command",
      prompt: "List the files in the repo root",
    });
  const request = (status: string, decision?: string) =>
    event("runtime-request.updated", {
      id: requestId,
      nodeId: common.nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "command",
      status,
      responseCapability: { type: "live", providerSessionId: "provider-session:test" },
      createdAt: "2026-11-02T06:44:09.400Z",
      resolvedAt: status === "pending" ? null : "2026-11-02T06:44:10.000Z",
      ...(decision === undefined ? {} : { decision }),
    });

  test("a pending approval is listed and joined with its turn item", () => {
    const state = replay([commandItem("pending"), approvalItem(), request("pending")], base);
    const pending = selectPendingRequests(state);
    expect(pending).toHaveLength(1);
    const [approval] = pending;
    expect(approval?.type).toBe("approval");
    if (approval?.type === "approval") {
      expect(approval.requestKind).toBe("command");
      expect(approval.prompt).toBe("List the files in the repo root");
      // Matched to the gated tool call by native item id, as Claude reports it.
      expect([approval.subject, approval.toolCallId]).toEqual(["ls", "turn-item:test:command"]);
      expect(approval.options.map((option) => option.decision)).toContain("accept");
    }
    const tool = selectTranscript(state).find((item) => item.kind === "tool_call");
    expect(tool?.kind === "tool_call" && [tool.name, tool.args, tool.collapsedByDefault]).toEqual([
      "Bash",
      "ls",
      true,
    ]);
    const shown = selectTranscript(state).find((item) => item.kind === "request");
    expect(shown?.kind === "request" && shown.open).toBe(true);
  });

  test("resolving the request clears it; the tool result lands", () => {
    const state = replay(
      [
        commandItem("pending"),
        approvalItem(),
        request("pending"),
        request("resolved", "accept"),
        commandItem("completed", "README.md\nsrc"),
      ],
      base,
    );
    expect(selectPendingRequests(state)).toEqual([]);
    const tool = selectTranscript(state).find((item) => item.kind === "tool_call");
    expect(tool?.kind === "tool_call" && [tool.status, tool.result, tool.exitCode]).toEqual([
      "completed",
      "README.md\nsrc",
      0,
    ]);
    const shown = selectTranscript(state).find((item) => item.kind === "request");
    expect(shown?.kind === "request" && [shown.open, shown.resolution]).toEqual([false, "accept"]);
  });

  test("items of a rolled-back run disappear", () => {
    const run = rawEvent("run.updated", (p) => p.status === "completed");
    const state = applyThreadStreamItem(
      replay(items),
      variant(run, 180000, { status: "rolled_back" }),
    );
    expect(selectTranscript(state)).toEqual([]);
  });
});

describe("thread store", () => {
  test("derived values follow applied items; unchanged items keep identity", () => {
    const store = createThreadStore();
    store.reset(THREAD_ID);
    expect(store.state.phase).toBe("loading");
    store.apply(snapshot);
    expect(store.state.phase).toBe("ready");
    expect(store.transcript()).toEqual([]);

    const midway = items
      .slice(1)
      .filter((item) => item.kind === "event" && item.sequence <= 166617);
    for (const item of midway) store.apply(item);
    const userItem = store.transcript()[0];
    expect(userItem?.kind).toBe("user_message");
    expect(store.activeRun()?.status).toBe("starting");

    for (const item of items.slice(1 + midway.length)) store.apply(item);
    expect(store.transcript().map((item) => item.kind)).toEqual([
      "user_message",
      "assistant_message",
    ]);
    expect(store.transcript()[0]).toBe(userItem as never);
    expect(store.activeRun()).toBeNull();
    expect(store.pendingRequests()).toEqual([]);

    // Replays change nothing.
    const revision = store.revision();
    for (const item of events) expect(store.apply(item)).toBe(false);
    expect(store.revision()).toBe(revision);

    // Fine-grained reads go through the store.
    expect(store.state.turnItems[userItem?.id ?? ""]?.type).toBe("user_message");

    store.reset(null);
    expect(store.state.phase).toBe("closed");
    expect(Object.keys(store.state.turnItems)).toEqual([]);
    expect(Object.keys(closedThreadView.turnItems)).toEqual([]);
    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// Shell

const PROJECT_ID = snapshot.projection.thread.projectId;
const NOW = "2026-11-02T06:44:00.000Z";

function threadShell(id: string, overrides: Json = {}): Json {
  return {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: PROJECT_ID,
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

const project = (overrides: Json = {}): Json => ({
  id: PROJECT_ID,
  title: "t8",
  workspaceRoot: "/workspace/t8",
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const fullSnapshot = decodeShellItem({
  kind: "snapshot",
  snapshot: {
    schemaVersion: 1,
    snapshotSequence: 100,
    projects: [project()],
    threads: [
      threadShell("thread-a", { latestUserMessageAt: "2026-11-02T07:00:00.000Z" }),
      threadShell("thread-b", { updatedAt: "2026-11-02T08:00:00.000Z" }),
      threadShell("thread-pinned", { pinnedAt: NOW }),
    ],
    archivedThreads: [threadShell("thread-old", { archivedAt: NOW })],
  },
});

const enrichment = decodeShellItem({
  kind: "snapshot",
  snapshot: {
    schemaVersion: 1,
    snapshotSequence: 50,
    projects: [
      project({
        repositoryIdentity: {
          canonicalKey: "example.com/acme/t8",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://example.com/acme/t8.git",
          },
        },
      }),
    ],
    threads: [],
    archivedThreads: [],
  },
  resolvedRepositoryIdentityRoots: ["/workspace/t8"],
});

describe("shell reducers", () => {
  const afterSnapshot = applyShellStreamItem(initialShellState, fullSnapshot);

  test("a full snapshot lists projects and threads", () => {
    expect(afterSnapshot.sequence).toBe(100);
    expect(Object.keys(afterSnapshot.threads).sort()).toEqual([
      "thread-a",
      "thread-b",
      "thread-old",
      "thread-pinned",
    ]);
    expect(afterSnapshot.threads["thread-old"]?.archived).toBe(true);
  });

  test("an enrichment snapshot is merged, not applied as a replacement", () => {
    const merged = applyShellStreamItem(afterSnapshot, enrichment);
    expect(merged.threads).toBe(afterSnapshot.threads);
    expect(merged.sequence).toBe(100);
    expect(merged.projects[PROJECT_ID]?.repositoryIdentity?.canonicalKey).toBe(
      "example.com/acme/t8",
    );
    expect(merged.projects[PROJECT_ID]?.title).toBe("t8");
  });

  test("groups sort pinned first, then by last activity", () => {
    const [group] = selectProjectGroups(afterSnapshot);
    expect(group?.threads.map((thread) => String(thread.id))).toEqual([
      "thread-pinned",
      "thread-b",
      "thread-a",
    ]);
    expect(
      selectProjectGroups(afterSnapshot, { includeArchived: true })[0]?.threads.map((t) =>
        String(t.id),
      ),
    ).toContain("thread-old");
  });

  test("events update threads and replays are dropped", () => {
    const updated = decodeShellItem({
      kind: "thread.updated",
      sequence: 101,
      location: "active",
      thread: threadShell("thread-a", {
        title: "renamed",
        status: "running",
        latestUserMessageAt: "2026-11-02T09:00:00.000Z",
      }),
    });
    const next = applyShellStreamItem(afterSnapshot, updated);
    expect(next.threads["thread-a"]?.title).toBe("renamed");
    expect(String(selectProjectGroups(next)[0]?.threads[1]?.id)).toBe("thread-a");
    expect(applyShellStreamItem(next, updated)).toBe(next);

    const stale = decodeShellItem({
      kind: "thread.removed",
      sequence: 99,
      location: "active",
      threadId: "thread-b",
    });
    expect(applyShellStreamItem(next, stale)).toBe(next);

    const removed = decodeShellItem({
      kind: "thread.removed",
      sequence: 102,
      location: "active",
      threadId: "thread-b",
    });
    expect(applyShellStreamItem(next, removed).threads["thread-b"]).toBeUndefined();

    const archived = decodeShellItem({
      kind: "thread.updated",
      sequence: 103,
      location: "archive",
      thread: threadShell("thread-a", { archivedAt: NOW }),
    });
    expect(applyShellStreamItem(next, archived).threads["thread-a"]?.archived).toBe(true);
  });
});

describe("shell store", () => {
  test("applies items and reflects connection status", () => {
    const store = createShellStore();
    expect(store.state.connection.state).toBe("connecting");
    store.apply(fullSnapshot);
    store.apply(enrichment);
    expect(store.groups()[0]?.threads).toHaveLength(3);
    expect(store.state.projects[PROJECT_ID]?.repositoryIdentity?.canonicalKey).toBe(
      "example.com/acme/t8",
    );
    store.setConnection({
      _tag: "disconnected",
      reason: "connection closed",
      attempt: 1,
      retryAt: 0,
    });
    expect(store.state.connection).toEqual({
      state: "disconnected",
      reason: "connection closed",
      attempt: 1,
      retryAt: 0,
    });
    expect(Object.keys(initialShellState.threads)).toEqual([]);
    store.dispose();
  });
});
