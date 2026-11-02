import { describe, expect, test } from "bun:test";
import {
  type ModelSelection,
  ORCHESTRATION_V2_WS_METHODS,
  type ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { reorderQueuedRun } from "../src/commands.ts";
import { Connection, type Session } from "../src/connection/connection.ts";

import type { ProjectGroup, ThreadSummary } from "../src/state/types.ts";
import { buildModelRows } from "../src/tui/components/ModelPicker.tsx";
import { buildModeRows } from "../src/tui/components/ModePicker.tsx";
import { buildProjectRows } from "../src/tui/components/ProjectPicker.tsx";
import { buildQueueRows } from "../src/tui/components/QueueView.tsx";
import { buildThreadRows, threadGlyph, threadIndex } from "../src/tui/components/ThreadPicker.tsx";
import { fuzzyFilter, fuzzyMatch } from "../src/tui/fuzzy.ts";
import {
  clampCursor,
  highlight,
  moveCursor,
  relativeTime,
  reorderTarget,
  selectableIndices,
  windowStart,
} from "../src/tui/picker.ts";

describe("fuzzyMatch", () => {
  test("subsequence, case-insensitive", () => {
    expect(fuzzyMatch("t3t", "T3 TUI")).not.toBeNull();
    expect(fuzzyMatch("abc", "a-b-c")?.positions).toEqual([0, 2, 4]);
    expect(fuzzyMatch("xyz", "t3tui")).toBeNull();
    expect(fuzzyMatch("toolong", "short")).toBeNull();
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
    // Spaces in the query are ignored.
    expect(fuzzyMatch("t3 tui", "t3tui")).not.toBeNull();
  });

  test("prefers consecutive and word-start matches", () => {
    const consecutive = fuzzyMatch("tui", "t3tui smoke")?.score ?? 0;
    const scattered = fuzzyMatch("tui", "the big unit")?.score ?? 0;
    expect(consecutive).toBeGreaterThan(scattered);

    const boundary = fuzzyMatch("st", "smoke test")?.score ?? 0;
    const inside = fuzzyMatch("st", "mistake")?.score ?? 0;
    expect(boundary).toBeGreaterThan(inside);

    // The best placement wins, not the first one found.
    expect(fuzzyMatch("test", "the test")?.positions).toEqual([4, 5, 6, 7]);
    // camelCase humps count as boundaries.
    expect(fuzzyMatch("mp", "modelPicker")?.positions).toEqual([0, 5]);
  });

  test("fuzzyFilter ranks best first and keeps order for an empty query", () => {
    const items = ["mistake", "smoke test", "nothing"];
    expect(fuzzyFilter(items, "st", (item) => item).map((ranked) => ranked.item)).toEqual([
      "smoke test",
      "mistake",
    ]);
    expect(fuzzyFilter(items, "", (item) => item).map((ranked) => ranked.item)).toEqual(items);
  });
});

describe("picker navigation", () => {
  test("cursor moves are clamped", () => {
    expect(moveCursor(0, -1, 5)).toBe(0);
    expect(moveCursor(3, 1, 5)).toBe(4);
    expect(moveCursor(4, 1, 5)).toBe(4);
    expect(moveCursor(2, 10, 5)).toBe(4);
    expect(moveCursor(2, 1, 0)).toBe(0);
    expect(clampCursor(9, 3)).toBe(2);
  });

  test("selectable rows skip headers", () => {
    const rows = [
      { key: "h", kind: "header" as const, segments: [] },
      { key: "a", kind: "item" as const, segments: [] },
      { key: "b", kind: "item" as const, segments: [] },
      { key: "h2", kind: "header" as const, segments: [] },
      { key: "c", kind: "item" as const, segments: [] },
    ];
    expect(selectableIndices(rows)).toEqual([1, 2, 4]);
  });

  test("the window scrolls as little as possible and shows the header above", () => {
    expect(windowStart(0, 3, 5, 10)).toBe(0);
    expect(windowStart(0, 12, 30, 10)).toBe(3);
    expect(windowStart(3, 8, 30, 10)).toBe(3);
    expect(windowStart(5, 5, 30, 10)).toBe(4);
    expect(windowStart(0, 29, 30, 10)).toBe(20);
    expect(windowStart(25, 29, 30, 10)).toBe(20);
  });

  test("reorder targets for queued-run.reorder", () => {
    const ids = ["a", "b", "c", "d"];
    expect(reorderTarget(ids, 2, -1)).toEqual({ runId: "c", beforeRunId: "b" });
    expect(reorderTarget(ids, 1, 1)).toEqual({ runId: "b", beforeRunId: "d" });
    expect(reorderTarget(ids, 2, 1)).toEqual({ runId: "c", beforeRunId: null });
    expect(reorderTarget(ids, 0, -1)).toBeNull();
    expect(reorderTarget(ids, 3, 1)).toBeNull();
  });

  test("queue ends: the commands sent for moves at the top and bottom", async () => {
    const dispatched: Array<Record<string, unknown>> = [];
    const session = {
      generation: 1,
      environment: { label: "test", serverVersion: "0.0.0", capabilities: {} },
      client: {
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: Record<string, unknown>) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: 1 };
          }),
      },
    } as unknown as Session;
    const connection = Layer.succeed(Connection)(
      Connection.of({
        target: {} as never,
        setTarget: () => Effect.void,
        status: {} as never,
        session: Effect.succeed(session),
        client: Effect.succeed(session.client),
        sessions: {} as never,
        subscribe: () => ({}) as never,
        reconnectNow: Effect.void,
        forceReconnect: Effect.void,
      }),
    );
    const queue = ["r1", "r2", "r3"].map((id) => RunId.make(id));
    const move = async (index: number, delta: -1 | 1) => {
      const target = reorderTarget(queue, index, delta);
      if (target === null) return null;
      await Effect.runPromise(
        reorderQueuedRun(ThreadId.make("thread-1"), target.runId, target.beforeRunId).pipe(
          Effect.provide(connection),
        ),
      );
      const { type, runId, beforeRunId } = dispatched.at(-1) ?? {};
      return { type, runId, beforeRunId };
    };
    // Down from the second-to-last: to the end of the queue.
    expect(await move(1, 1)).toEqual({
      type: "queued-run.reorder",
      runId: "r2",
      beforeRunId: null,
    });
    // Up from the last: before the one above it.
    expect(await move(2, -1)).toEqual({
      type: "queued-run.reorder",
      runId: "r3",
      beforeRunId: "r2",
    });
    // Up from the second: to the front.
    expect(await move(1, -1)).toEqual({
      type: "queued-run.reorder",
      runId: "r2",
      beforeRunId: "r1",
    });
    // Past either end: nothing is sent.
    expect(await move(0, -1)).toBeNull();
    expect(await move(2, 1)).toBeNull();
    expect(dispatched).toHaveLength(3);
    expect(reorderTarget([RunId.make("only")], 0, 1)).toBeNull();
    expect(reorderTarget([RunId.make("only")], 0, -1)).toBeNull();
  });

  test("relative time and highlighting", () => {
    const now = 10_000_000_000;
    expect(relativeTime(now - 5_000, now)).toBe("now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d");
    expect(highlight("abc", [1], "f", "m")).toEqual([
      { text: "a", fg: "f" },
      { text: "b", fg: "m" },
      { text: "c", fg: "f" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Row builders

const NOW = Date.parse("2026-06-01T12:00:00Z");
const selection = { instanceId: "claudeAgent", model: "claude-test" } as unknown as ModelSelection;

function summary(id: string, projectId: string, title: string, extra: Partial<ThreadSummary> = {}) {
  return {
    id: id as ThreadId,
    projectId: projectId as ProjectId,
    title,
    status: "idle",
    activeRunId: null,
    pendingRequest: null,
    model: "claudeAgent/claude-test",
    modelSelection: selection,
    branch: null,
    lastError: null,
    latestMessage: null,
    parentThreadId: null,
    relationshipToParent: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    lastActivityAt: NOW - 60_000,
    archived: false,
    pinned: false,
    pinOrderKey: null,
    ...extra,
  } satisfies ThreadSummary;
}

const groups: ReadonlyArray<ProjectGroup> = [
  {
    projectId: "p1" as ProjectId,
    project: null,
    title: "t8",
    lastActivityAt: NOW,
    threads: [
      summary("a", "p1", "t3tui step4 live", { status: "running" }),
      summary("b", "p1", "Fix the build", { archived: true }),
      summary("c", "p1", "t3tui smoke test"),
    ],
  },
  {
    projectId: "p2" as ProjectId,
    project: null,
    title: "website",
    lastActivityAt: NOW - 1000,
    threads: [summary("d", "p2", "Landing page copy")],
  },
];

describe("thread picker rows", () => {
  test("indices skip archived threads and stay stable under filtering", () => {
    expect(threadIndex(groups).map((thread) => String(thread.id))).toEqual(["a", "c", "d"]);
    const all = buildThreadRows(groups, {
      query: "",
      projectId: null,
      now: NOW,
      width: 80,
      openThreadId: null,
    });
    expect(all.rows.map((row) => `${row.kind}:${row.key}`)).toEqual([
      "header:project:p1",
      "item:a",
      "item:b",
      "item:c",
      "header:project:p2",
      "item:d",
    ]);
    const text = (index: number) =>
      (all.rows[index]?.segments ?? []).map((segment) => segment.text).join("");
    expect(text(1)).toMatch(/^1 ● t3tui step4 live/);
    expect(text(2)).toMatch(/^- × Fix the build/);
    expect(text(3)).toMatch(/^2 · t3tui smoke test/);
    expect(text(3)).toContain("1m");

    const filtered = buildThreadRows(groups, {
      query: "smoke",
      projectId: null,
      now: NOW,
      width: 80,
      openThreadId: null,
    });
    expect(filtered.rows.map((row) => row.key)).toEqual(["project:p1", "c"]);
    const row = filtered.rows[1]?.segments.map((segment) => segment.text).join("") ?? "";
    expect(row).toMatch(/^2 /);
  });

  test("with archived threads listed, numbers still follow :b <n>", () => {
    // Listing archived threads can reorder the groups (an archived thread was
    // active more recently) and adds groups that only hold archived threads.
    const withArchived: ReadonlyArray<ProjectGroup> = [
      {
        projectId: "p3" as ProjectId,
        project: null,
        title: "old",
        lastActivityAt: NOW + 2000,
        threads: [summary("x", "p3", "Old idea", { archived: true })],
      },
      { ...(groups[1] as ProjectGroup), lastActivityAt: NOW + 1000 },
      groups[0] as ProjectGroup,
    ];
    const built = buildThreadRows(withArchived, {
      numbering: groups,
      query: "",
      projectId: null,
      now: NOW,
      width: 80,
      openThreadId: null,
    });
    const numbers = Object.fromEntries(
      built.rows
        .filter((row) => row.kind === "item")
        .map((row) => [row.key, row.segments[0]?.text.trim()]),
    );
    expect(numbers).toEqual({ x: "-", d: "3", a: "1", b: "-", c: "2" });
    expect(threadIndex(groups).map((thread) => String(thread.id))).toEqual(["a", "c", "d"]);
  });

  test("the best match gets the cursor; project narrowing", () => {
    const built = buildThreadRows(groups, {
      query: "landing",
      projectId: null,
      now: NOW,
      width: 80,
      openThreadId: null,
    });
    expect(built.rows.filter((row) => row.kind === "item")[built.best]?.key).toBe("d");
    const narrowed = buildThreadRows(groups, {
      query: "",
      projectId: "p2",
      now: NOW,
      width: 80,
      openThreadId: null,
    });
    expect(narrowed.rows.map((row) => row.key)).toEqual(["project:p2", "d"]);
  });

  test("glyphs", () => {
    expect(threadGlyph(summary("x", "p", "t", { status: "running" })).text).toBe("●");
    expect(threadGlyph(summary("x", "p", "t", { archived: true })).text).toBe("×");
    expect(threadGlyph(summary("x", "p", "t")).text).toBe("·");
    const pending = summary("x", "p", "t", {
      status: "waiting",
      pendingRequest: {} as ThreadSummary["pendingRequest"],
    });
    expect(threadGlyph(pending).text).toBe("?");
  });
});

describe("other picker rows", () => {
  test("projects filter by title", () => {
    const rows = buildProjectRows(groups, { query: "web", now: NOW, width: 80 });
    expect(rows.map((row) => row.key)).toEqual(["p2"]);
  });

  test("models: grouped by provider, current marked and preselected", () => {
    const catalog = {
      providers: [
        {
          instanceId: "codex",
          name: "Codex",
          models: [{ slug: "gpt-x", name: "GPT X", isDefault: true }],
          supportedRuntimeModes: null,
        },
        {
          instanceId: "claudeAgent",
          name: "Claude",
          models: [
            { slug: "claude-big", name: "Claude Big", isDefault: false },
            { slug: "claude-test", name: "Claude Test", isDefault: false },
          ],
          supportedRuntimeModes: null,
        },
      ],
      defaultModelSelection: null,
      defaultRuntimeMode: "full-access",
    } as unknown as Parameters<typeof buildModelRows>[0];
    const built = buildModelRows(catalog, { query: "", current: selection, width: 80 });
    expect(built.rows.map((row) => row.key)).toEqual([
      "provider:codex",
      "codex/gpt-x",
      "provider:claudeAgent",
      "claudeAgent/claude-big",
      "claudeAgent/claude-test",
    ]);
    expect(built.initial).toBe(2);
    expect(built.rows[4]?.segments[0]?.text).toBe("● ");
    const filtered = buildModelRows(catalog, { query: "big", current: selection, width: 80 });
    expect(filtered.rows.map((row) => row.key)).toEqual([
      "provider:claudeAgent",
      "claudeAgent/claude-big",
    ]);
  });

  test("modes come from the contract, current marked", () => {
    const rows = buildModeRows({ current: "auto", supported: ["approval-required", "auto"] });
    expect(rows.map((row) => row.value)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    expect(rows[2]?.segments[0]?.text).toBe("● ");
    expect(rows[1]?.segments.map((segment) => segment.text).join("")).toContain("not supported");
  });

  test("queue rows", () => {
    const rows = buildQueueRows(
      [
        { runId: "r1", ordinal: 2, queuePosition: 0, held: false, text: "second message" },
        { runId: "r2", ordinal: 3, queuePosition: 1, held: true, text: null },
      ] as never,
      60,
    );
    expect(rows.map((row) => row.key)).toEqual(["r1", "r2"]);
    expect(rows[1]?.segments.map((segment) => segment.text).join("")).toContain("held");
  });
});
