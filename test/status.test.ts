import { describe, expect, test } from "bun:test";
import { OrchestrationV2ShellStreamItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { applyShellStreamItem, initialShellState } from "../src/state/reducers/shell.ts";
import {
  isEffectivelySnoozed,
  pendingSubagentRequestsByThread,
  resolveRowThreadId,
  selectProjectGroups,
  selectThreadSection,
  selectThreadStatus,
  subagentDepth,
  timeUntil,
} from "../src/state/selectors.ts";
import type { ShellState, ThreadSummary } from "../src/state/types.ts";
import { projectShell, shellSnapshot, threadShell } from "./fixtures/shell.ts";

type Json = Record<string, unknown>;

const decode = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ShellStreamItem));
const NOW = Date.parse("2026-11-02T08:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A thread summary as the shell reducer builds it from a wire thread shell. */
function summaryOf(overrides: Json = {}, location: "active" | "archive" = "active"): ThreadSummary {
  const state = applyShellStreamItem(
    initialShellState,
    shellSnapshot(
      [projectShell("p1", "t8")],
      location === "active" ? [threadShell("t1", "p1", overrides)] : [],
      location === "archive" ? [threadShell("t1", "p1", overrides)] : [],
    ),
  );
  const summary = state.threads.t1;
  if (summary === undefined) throw new Error("no summary");
  return summary;
}

function prLink(number: number, snapshot: Json | null, extra: Json = {}): Json {
  return {
    host: "github.com",
    repository: "acme/t8",
    number,
    url: `https://github.com/acme/t8/pull/${number}`,
    source: "created",
    linkedAt: "2026-11-01T10:00:00.000Z",
    snapshot:
      snapshot === null
        ? null
        : {
            state: "open",
            title: `PR ${number}`,
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: "2026-11-01T12:00:00.000Z",
            syncedAt: "2026-11-01T12:00:00.000Z",
            ...snapshot,
          },
    stack: null,
    ...extra,
  };
}

const status = (overrides: Json = {}, location: "active" | "archive" = "active") => {
  const value = selectThreadStatus(summaryOf(overrides, location), NOW);
  return `${value.kind}|${value.label}|${value.tone}`;
};

const pendingRequest = (kind: string) => ({
  id: "request-1",
  kind,
  createdAt: iso(NOW - 1000),
});

describe("selectThreadStatus", () => {
  test("working, approval, queued, failed, idle, archived", () => {
    expect(status({ status: "running", activeRunId: "run-1" })).toBe("working|working|ok");
    expect(status({ status: "preparing" })).toBe("working|working|ok");
    expect(status({ status: "waiting", pendingRuntimeRequest: pendingRequest("command") })).toBe(
      "approval|approval|warn",
    );
    expect(status({ status: "waiting", pendingRuntimeRequest: pendingRequest("user_input") })).toBe(
      "approval|question|warn",
    );
    expect(status({ status: "queued" })).toBe("queued|queued|ok");
    expect(status({ status: "failed" })).toBe("failed|failed|error");
    expect(status({ status: "completed" })).toBe("idle|idle|dim");
    expect(status({ status: "interrupted" })).toBe("idle|interrupted|dim");
    expect(status({ status: "running" }, "archive")).toBe("archived|archived|dim");
  });

  test("settled and snoozed", () => {
    expect(status({ settledOverride: "settled", settledAt: iso(NOW - HOUR) })).toBe(
      "settled|settled|dim",
    );
    // An explicit un-settle keeps the thread active.
    expect(status({ settledOverride: "active", settledAt: null })).toBe("idle|idle|dim");
    expect(status({ snoozedUntil: iso(NOW + 3 * HOUR), snoozedAt: iso(NOW - HOUR) })).toBe(
      "snoozed|snoozed until 3h|dim",
    );
    // Snoozed wins over settled.
    expect(
      status({
        settledOverride: "settled",
        settledAt: iso(NOW - HOUR),
        snoozedUntil: iso(NOW + 30 * 60_000),
        snoozedAt: iso(NOW - HOUR),
      }),
    ).toBe("snoozed|snoozed until 30m|dim");
    // The wake time passed.
    expect(status({ snoozedUntil: iso(NOW - 1), snoozedAt: iso(NOW - HOUR) })).toBe(
      "idle|idle|dim",
    );
    // A request ends the snooze early.
    expect(
      status({
        status: "waiting",
        pendingRuntimeRequest: pendingRequest("command"),
        snoozedUntil: iso(NOW + HOUR),
        snoozedAt: iso(NOW - HOUR),
      }),
    ).toBe("approval|approval|warn");
    // So does a failure after the snooze started, but not one before it.
    expect(
      status({
        status: "failed",
        latestRunCompletedAt: iso(NOW - 10 * 60_000),
        snoozedUntil: iso(NOW + HOUR),
        snoozedAt: iso(NOW - HOUR),
      }),
    ).toBe("failed|failed|error");
    expect(
      status({
        status: "failed",
        latestRunCompletedAt: iso(NOW - 2 * HOUR),
        snoozedUntil: iso(NOW + HOUR),
        snoozedAt: iso(NOW - HOUR),
      }),
    ).toBe("snoozed|snoozed until 1h|dim");
  });

  test("pull requests: state and checks", () => {
    const pr = (snapshot: Json | null, extra: Json = {}) =>
      status({ pullRequests: [prLink(42, snapshot, extra)] });
    expect(pr({ checksState: "pending" })).toBe("pr|PR #42 …|info");
    expect(pr({ checksState: "passing" })).toBe("pr|PR #42 ✓|info");
    expect(pr({ checksState: "failing" })).toBe("pr|PR #42 ✕|error");
    expect(pr({})).toBe("pr|PR #42|info");
    expect(pr({ isDraft: true, checksState: "passing" })).toBe("pr|PR #42 draft ✓|info");
    expect(pr({ state: "merged", checksState: "passing" })).toBe("pr|PR #42 merged|merged");
    expect(pr({ state: "closed" })).toBe("pr|PR #42 closed|dim");
    // Not synced yet.
    expect(pr(null)).toBe("pr|PR #42|info");
    // A dismissed stack member is hidden.
    expect(pr({}, { source: "stack-dismissed" })).toBe("idle|idle|dim");
    // The legacy single link, without state.
    expect(
      status({
        linkedPullRequest: {
          projectId: "p1",
          repository: "acme/t8",
          number: 7,
          url: "https://github.com/acme/t8/pull/7",
        },
      }),
    ).toBe("pr|PR #7|info");
    // Working and settled come before the pull request.
    expect(status({ status: "running", pullRequests: [prLink(42, {})] })).toBe(
      "working|working|ok",
    );
    expect(
      status({
        settledOverride: "settled",
        settledAt: iso(NOW),
        pullRequests: [prLink(42, { state: "merged" })],
      }),
    ).toBe("settled|settled|dim");
  });

  test("an open pull request wins over a merged one", () => {
    const summary = summaryOf({
      pullRequests: [
        prLink(1, { state: "merged" }, { linkedAt: "2026-11-01T11:00:00.000Z" }),
        prLink(2, { checksState: "failing" }, { linkedAt: "2026-11-01T09:00:00.000Z" }),
      ],
    });
    expect(summary.pullRequest).toMatchObject({ number: 2, state: "open", others: 1 });
    expect(selectThreadStatus(summary, NOW).label).toBe("PR #2 ✕");
  });
});

describe("sections", () => {
  test("snoozed wins over settled; everything else is active", () => {
    expect(selectThreadSection(summaryOf(), NOW)).toBe("active");
    expect(
      selectThreadSection(summaryOf({ settledOverride: "settled", settledAt: iso(NOW) }), NOW),
    ).toBe("settled");
    const snoozed = summaryOf({
      settledOverride: "settled",
      settledAt: iso(NOW),
      snoozedUntil: iso(NOW + HOUR),
      snoozedAt: iso(NOW - HOUR),
    });
    expect(isEffectivelySnoozed(snoozed, NOW)).toBe(true);
    expect(selectThreadSection(snoozed, NOW)).toBe("snoozed");
    expect(selectThreadSection(snoozed, NOW + 2 * HOUR)).toBe("settled");
  });

  test("timeUntil rounds up like the web app", () => {
    expect(timeUntil(NOW + 30_000, NOW)).toBe("1m");
    expect(timeUntil(NOW + 59 * 60_000, NOW)).toBe("59m");
    expect(timeUntil(NOW + 90 * 60_000, NOW)).toBe("2h");
    expect(timeUntil(NOW + 30 * HOUR, NOW)).toBe("2d");
    expect(timeUntil(NOW - 1, NOW)).toBe("now");
  });
});

describe("shell reducer keeps settled, snoozed and pull request fields current", () => {
  test("thread.updated after settle, snooze, unsettle and a linked pull request", () => {
    let state: ShellState = applyShellStreamItem(
      initialShellState,
      shellSnapshot([projectShell("p1", "t8")], [threadShell("t1", "p1")]),
    );
    const update = (sequence: number, overrides: Json) => {
      state = applyShellStreamItem(
        state,
        decode({
          kind: "thread.updated",
          sequence,
          location: "active",
          thread: threadShell("t1", "p1", overrides),
        }),
      );
      return state.threads.t1 as ThreadSummary;
    };
    expect(state.threads.t1).toMatchObject({
      settled: false,
      settledAt: null,
      snoozedUntil: null,
      pullRequest: null,
    });

    const settled = update(101, { settledOverride: "settled", settledAt: iso(NOW) });
    expect(settled.settled).toBe(true);
    expect(settled.settledAt).toBe(NOW);

    const snoozed = update(102, {
      settledOverride: null,
      snoozedUntil: iso(NOW + HOUR),
      snoozedAt: iso(NOW),
    });
    expect(snoozed).toMatchObject({ settled: false, snoozedUntil: NOW + HOUR, snoozedAt: NOW });

    const unsettled = update(103, { settledOverride: "active", unsettledAt: iso(NOW) });
    expect(unsettled).toMatchObject({ settled: false, snoozedUntil: null });

    const linked = update(104, { pullRequests: [prLink(9, { checksState: "passing" })] });
    expect(linked.pullRequest).toEqual({
      number: 9,
      url: "https://github.com/acme/t8/pull/9",
      repository: "acme/t8",
      state: "open",
      draft: false,
      checks: "passing",
      others: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Subagent threads

const subagentOf = (parent: string, overrides: Json = {}): Json => ({
  creationSource: "mcp",
  lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
  ...overrides,
});

/** A subagent waiting for the user: live run, pending request of `kind`. */
const asking = (parent: string, kind: string, overrides: Json = {}): Json =>
  subagentOf(parent, {
    status: "waiting",
    activeRunId: "run-1",
    pendingRuntimeRequest: pendingRequest(kind),
    ...overrides,
  });

function shellOf(threads: ReadonlyArray<Json>, archived: ReadonlyArray<Json> = []): ShellState {
  return applyShellStreamItem(
    initialShellState,
    shellSnapshot([projectShell("p1", "t8")], threads, archived),
  );
}

const requestsOf = (state: ShellState) =>
  Object.fromEntries(
    Object.values(state.threads)
      .filter((thread) => thread.pendingSubagentRequest !== null)
      .map((thread) => [thread.id, thread.pendingSubagentRequest]),
  );

describe("subagent requests bubble up to the parent", () => {
  test("single level: the parent shows ↳ approval / ↳ question", () => {
    const approval = shellOf([
      threadShell("parent", "p1", { status: "running" }),
      threadShell("child", "p1", asking("parent", "command")),
    ]);
    expect(requestsOf(approval)).toEqual({ parent: "approval" });
    const parent = approval.threads.parent as ThreadSummary;
    expect(selectThreadStatus(parent, NOW)).toEqual({
      kind: "approval",
      label: "↳ approval",
      tone: "warn",
    });
    // The child itself shows its own request.
    expect(selectThreadStatus(approval.threads.child as ThreadSummary, NOW).label).toBe("approval");

    const question = shellOf([
      threadShell("parent", "p1"),
      threadShell("child", "p1", asking("parent", "user_input")),
    ]);
    expect(selectThreadStatus(question.threads.parent as ThreadSummary, NOW).label).toBe(
      "↳ question",
    );
  });

  test("the parent's own request comes first", () => {
    const state = shellOf([
      threadShell("parent", "p1", {
        status: "waiting",
        pendingRuntimeRequest: pendingRequest("user_input"),
      }),
      threadShell("child", "p1", asking("parent", "command")),
    ]);
    expect(selectThreadStatus(state.threads.parent as ThreadSummary, NOW).label).toBe("question");
  });

  test("a chain marks every ancestor; a fork is not a link", () => {
    const state = shellOf([
      threadShell("root", "p1"),
      threadShell("middle", "p1", subagentOf("root", { status: "running" })),
      threadShell("leaf", "p1", asking("middle", "file-change")),
      threadShell("fork", "p1", {
        lineage: { parentThreadId: "root", relationshipToParent: "fork", rootThreadId: "root" },
      }),
      threadShell("forked-child", "p1", asking("fork", "command")),
    ]);
    expect(requestsOf(state)).toEqual({ root: "approval", middle: "approval", fork: "approval" });
    // A fork's subagent bubbles to the fork, not past it.
    const fork = state.threads.fork as ThreadSummary;
    expect(fork.relationshipToParent).toBe("fork");
  });

  test("a cycle stops the walk", () => {
    const state = shellOf([
      threadShell("a", "p1", asking("b", "command")),
      threadShell("b", "p1", subagentOf("a")),
    ]);
    expect(requestsOf(state)).toEqual({ b: "approval" });
    expect(resolveRowThreadId("a", state.threads)).toBe("a");
    expect(subagentDepth(state.threads.a as ThreadSummary, state.threads)).toBe(2);
  });

  test("ignored: archived child, auth refresh, provider-native, no live run", () => {
    const ignored = shellOf(
      [
        threadShell("parent", "p1"),
        threadShell("auth", "p1", asking("parent", "auth_refresh")),
        threadShell("native", "p1", asking("parent", "command", { creationSource: "provider" })),
        threadShell("ended", "p1", asking("parent", "user_input", { status: "completed" })),
        threadShell(
          "blocked",
          "p1",
          // The server says no activity run, whatever the status.
          asking("parent", "command", { status: "running", activityRunStatus: null }),
        ),
      ],
      [threadShell("archived", "p1", asking("parent", "command"))],
    );
    expect(requestsOf(ignored)).toEqual({});
    expect(ignored.threads.native?.providerNativeSubagent).toBe(true);
    expect(ignored.threads.ended?.liveRun).toBe(false);
    expect(ignored.threads.blocked?.liveRun).toBe(false);
    // The activity run counts even when the shell status says otherwise.
    const queuedBehind = shellOf([
      threadShell("parent", "p1"),
      threadShell(
        "child",
        "p1",
        asking("parent", "command", { status: "queued", activityRunStatus: "waiting" }),
      ),
    ]);
    expect(requestsOf(queuedBehind)).toEqual({ parent: "approval" });
  });

  test("approval beats user_input, whatever the order", () => {
    for (const order of [
      ["user_input", "command"],
      ["command", "user_input"],
    ] as const) {
      const state = shellOf([
        threadShell("parent", "p1"),
        threadShell("c1", "p1", asking("parent", order[0])),
        threadShell("c2", "p1", asking("parent", order[1])),
      ]);
      expect(requestsOf(state)).toEqual({ parent: "approval" });
    }
    // Over a chain too: the leaf's question does not replace the middle's approval.
    const chain = shellOf([
      threadShell("root", "p1"),
      threadShell("middle", "p1", asking("root", "command")),
      threadShell("leaf", "p1", asking("middle", "user_input")),
    ]);
    expect(requestsOf(chain)).toEqual({ root: "approval", middle: "user_input" });
  });

  test("events keep it current; unchanged threads keep their identity", () => {
    let state = shellOf([
      threadShell("parent", "p1"),
      threadShell("child", "p1", asking("parent", "command")),
      threadShell("other", "p1"),
    ]);
    const other = state.threads.other;
    const event = (item: Json) => {
      state = applyShellStreamItem(state, decode(item));
    };
    event({
      kind: "thread.updated",
      sequence: 101,
      location: "active",
      thread: threadShell("child", "p1", subagentOf("parent", { status: "running" })),
    });
    expect(requestsOf(state)).toEqual({});
    expect(state.threads.other).toBe(other);
    event({
      kind: "thread.updated",
      sequence: 102,
      location: "active",
      thread: threadShell("child", "p1", asking("parent", "user_input")),
    });
    expect(requestsOf(state)).toEqual({ parent: "user_input" });
    event({ kind: "thread.removed", sequence: 103, location: "active", threadId: "child" });
    expect(requestsOf(state)).toEqual({});
    expect(state.threads.other).toBe(other);
  });

  test("a request below wakes a snoozed parent", () => {
    const state = shellOf([
      threadShell("parent", "p1", {
        snoozedUntil: iso(NOW + HOUR),
        snoozedAt: iso(NOW - HOUR),
      }),
      threadShell("child", "p1", asking("parent", "command")),
    ]);
    const parent = state.threads.parent as ThreadSummary;
    expect(isEffectivelySnoozed(parent, NOW)).toBe(false);
    expect(selectThreadSection(parent, NOW)).toBe("active");
  });

  test("pendingSubagentRequestsByThread works on plain summaries", () => {
    const state = shellOf([
      threadShell("parent", "p1"),
      threadShell("child", "p1", asking("parent", "command")),
    ]);
    expect([...pendingSubagentRequestsByThread(state.threads)]).toEqual([["parent", "approval"]]);
    expect(pendingSubagentRequestsByThread({}).size).toBe(0);
  });
});

describe("subagent threads in the thread groups", () => {
  test("hidden by default, forks listed; the project's activity ignores subagents", () => {
    const state = shellOf([
      threadShell("parent", "p1", { latestUserMessageAt: iso(NOW - HOUR) }),
      threadShell("child", "p1", subagentOf("parent", { latestUserMessageAt: iso(NOW) })),
      threadShell("fork", "p1", {
        lineage: { parentThreadId: "parent", relationshipToParent: "fork", rootThreadId: "parent" },
      }),
    ]);
    const ids = (groups: ReturnType<typeof selectProjectGroups>) =>
      groups.flatMap((group) => group.threads.map((thread) => String(thread.id))).sort();
    const groups = selectProjectGroups(state);
    expect(ids(groups)).toEqual(["fork", "parent"]);
    const withSubagents = selectProjectGroups(state, { includeSubagents: true });
    expect(ids(withSubagents)).toEqual(["child", "fork", "parent"]);
    expect(withSubagents[0]?.lastActivityAt).toBe(groups[0]?.lastActivityAt);
    expect(resolveRowThreadId("child", state.threads)).toBe("parent");
    expect(resolveRowThreadId("fork", state.threads)).toBe("fork");
    expect(resolveRowThreadId("unknown", state.threads)).toBe("unknown");
  });
});
