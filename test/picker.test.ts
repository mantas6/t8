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
import {
  buildThreadRows,
  threadGlyph,
  threadIndex,
  threadPickerFooter,
} from "../src/tui/components/ThreadPicker.tsx";
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
import { colors } from "../src/tui/theme.ts";

describe("fuzzyMatch", () => {
  test("subsequence, case-insensitive", () => {
    expect(fuzzyMatch("t3t", "T3 Tui")).not.toBeNull();
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
    providerNativeSubagent: false,
    liveRun: false,
    pendingSubagentRequest: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    lastActivityAt: NOW - 60_000,
    archived: false,
    pinned: false,
    pinOrderKey: null,
    settled: false,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    latestRunCompletedAt: null,
    pullRequest: null,
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
      summary("a", "p1", "t8 step4 live", { status: "running" }),
      summary("b", "p1", "Fix the build", { archived: true }),
      summary("c", "p1", "t8 smoke test"),
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

const LIST = { layout: "grouped", showSettled: true, now: NOW } as const;
const rowsOf = (built: { rows: ReadonlyArray<{ kind: string; key: string }> }) =>
  built.rows.map((row) => `${row.kind}:${row.key}`);
const textOf = (row: { segments: ReadonlyArray<{ text: string }> } | undefined) =>
  (row?.segments ?? []).map((segment) => segment.text).join("");

describe("thread picker rows", () => {
  test("indices skip archived threads and stay stable under filtering", () => {
    expect(threadIndex(groups, LIST).map((thread) => String(thread.id))).toEqual(["a", "c", "d"]);
    const all = buildThreadRows(groups, {
      ...LIST,
      query: "",
      projectId: null,
      width: 80,
      openThreadId: null,
    });
    expect(rowsOf(all)).toEqual([
      "header:project:p1",
      "item:a",
      "item:c",
      "header:archived:p1",
      "item:b",
      "header:project:p2",
      "item:d",
    ]);
    expect(textOf(all.rows[1])).toMatch(/^1 ● t8 step4 live\s+working/);
    expect(textOf(all.rows[2])).toMatch(/^2 · t8 smoke test\s+idle/);
    expect(textOf(all.rows[2])).toContain("1m");
    expect(textOf(all.rows[4])).toMatch(/^- × Fix the build\s+archived/);

    const filtered = buildThreadRows(groups, {
      ...LIST,
      query: "smoke",
      projectId: null,
      width: 80,
      openThreadId: null,
    });
    expect(filtered.rows.map((row) => row.key)).toEqual(["project:p1", "c"]);
    expect(textOf(filtered.rows[1])).toMatch(/^2 /);
  });

  test("with archived threads listed, numbers still follow :b <n>", () => {
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
      ...LIST,
      numbering: groups,
      query: "",
      projectId: null,
      width: 80,
      openThreadId: null,
    });
    const numbers = Object.fromEntries(
      built.rows
        .filter((row) => row.kind === "item")
        .map((row) => [row.key, row.segments[0]?.text.trim()]),
    );
    expect(numbers).toEqual({ x: "-", d: "3", a: "1", b: "-", c: "2" });
  });

  test("the best match gets the cursor; project narrowing", () => {
    const built = buildThreadRows(groups, {
      ...LIST,
      query: "landing",
      projectId: null,
      width: 80,
      openThreadId: null,
    });
    expect(built.rows.filter((row) => row.kind === "item")[built.best]?.key).toBe("d");
    const narrowed = buildThreadRows(groups, {
      ...LIST,
      query: "",
      projectId: "p2",
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

// Settled / snoozed sections, the flat layout and numbering.
const HOUR = 3_600_000;
const sectioned: ReadonlyArray<ProjectGroup> = [
  {
    projectId: "p1" as ProjectId,
    project: null,
    title: "t8",
    lastActivityAt: NOW,
    threads: [
      summary("a1", "p1", "Active one", { lastActivityAt: NOW - 1000 }),
      summary("s1", "p1", "Settled long ago", {
        settled: true,
        settledAt: NOW - 5 * HOUR,
        lastActivityAt: NOW - 2000,
      }),
      summary("z1", "p1", "Snoozed", {
        snoozedUntil: NOW + 3 * HOUR,
        snoozedAt: NOW - HOUR,
        lastActivityAt: NOW - 3000,
      }),
      summary("s2", "p1", "Settled recently", {
        settled: true,
        settledAt: NOW - HOUR,
        lastActivityAt: NOW - 9000,
      }),
      summary("a2", "p1", "Active two", { lastActivityAt: NOW - 10_000 }),
    ],
  },
  {
    projectId: "p2" as ProjectId,
    project: null,
    title: "website",
    lastActivityAt: NOW - 1500,
    threads: [
      summary("w1", "p2", "Landing page", { lastActivityAt: NOW - 1500 }),
      summary("w2", "p2", "Old copy", { settled: true, lastActivityAt: NOW - 20_000 }),
    ],
  },
];
const base = { query: "", projectId: null, width: 100, openThreadId: null } as const;

describe("thread picker sections and layouts", () => {
  test("grouped: active first, then a dim settled / snoozed section per project", () => {
    const built = buildThreadRows(sectioned, { ...LIST, ...base });
    expect(rowsOf(built)).toEqual([
      "header:project:p1",
      "item:a1",
      "item:a2",
      "header:settled:p1",
      "item:z1",
      "item:s2",
      "item:s1",
      "header:project:p2",
      "item:w1",
      "header:settled:p2",
      "item:w2",
    ]);
    expect(textOf(built.rows[0])).toBe("t8  5");
    expect(textOf(built.rows[3])).toBe("  settled / snoozed  3");
    expect(built.rows[3]?.segments[0]?.fg).toBe(colors.dim);
    expect(textOf(built.rows[4])).toMatch(/^3 · Snoozed\s+snoozed until 3h /);
    expect(textOf(built.rows[5])).toMatch(/^4 · Settled recently\s+settled /);
    // :b numbers follow the rows.
    expect(threadIndex(sectioned, LIST).map((thread) => String(thread.id))).toEqual([
      "a1",
      "a2",
      "z1",
      "s2",
      "s1",
      "w1",
      "w2",
    ]);
    const numbers = built.rows
      .filter((row) => row.kind === "item")
      .map((row) => row.segments[0]?.text.trim());
    expect(numbers).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(built.hiddenSettled).toBe(0);
  });

  test("hiding settled / snoozed drops them from the rows and the numbering", () => {
    const options = { ...LIST, showSettled: false };
    const built = buildThreadRows(sectioned, { ...options, ...base });
    expect(rowsOf(built)).toEqual([
      "header:project:p1",
      "item:a1",
      "item:a2",
      "header:project:p2",
      "item:w1",
    ]);
    expect(built.hiddenSettled).toBe(4);
    expect(threadIndex(sectioned, options).map((thread) => String(thread.id))).toEqual([
      "a1",
      "a2",
      "w1",
    ]);
    expect(textOf(built.rows[4])).toMatch(/^3 /);
    expect(
      threadPickerFooter({
        layout: "grouped",
        showSettled: false,
        showArchived: false,
        hiddenSettled: 4,
      }),
    ).toBe("by project (C-g flat) · 4 settled/snoozed hidden (C-s)");
  });

  test("flat: most recent first across projects, settled / snoozed at the bottom", () => {
    const options = { ...LIST, layout: "flat" } as const;
    const built = buildThreadRows(sectioned, { ...options, ...base });
    expect(rowsOf(built)).toEqual([
      "header:recent",
      "item:a1",
      "item:w1",
      "item:a2",
      "header:settled",
      "item:z1",
      // Never given a settle time: ordered by its last activity.
      "item:w2",
      "item:s2",
      "item:s1",
    ]);
    expect(textOf(built.rows[2])).toMatch(/^2 · Landing page\s+idle\s+website /);
    expect(threadIndex(sectioned, options).map((thread) => String(thread.id))).toEqual([
      "a1",
      "w1",
      "a2",
      "z1",
      "w2",
      "s2",
      "s1",
    ]);
    // Narrowing and filtering keep the numbers.
    const narrowed = buildThreadRows(sectioned, { ...options, ...base, projectId: "p2" });
    expect(rowsOf(narrowed)).toEqual(["header:recent", "item:w1", "header:settled", "item:w2"]);
    expect(narrowed.rows.map((row) => row.segments[0]?.text.trim())).toEqual([
      "All projects",
      "2",
      "settled / snoozed",
      "5",
    ]);
    expect(
      threadPickerFooter({
        layout: "flat",
        showSettled: true,
        showArchived: true,
        hiddenSettled: 0,
      }),
    ).toBe("recent first (C-g groups) · archived shown (C-a)");
  });

  test("a snooze that ran out or was broken by a request puts the thread back", () => {
    const woken: ReadonlyArray<ProjectGroup> = [
      {
        projectId: "p1" as ProjectId,
        project: null,
        title: "t8",
        lastActivityAt: NOW,
        threads: [
          summary("expired", "p1", "Expired", { snoozedUntil: NOW - 1, snoozedAt: NOW - HOUR }),
          summary("asked", "p1", "Asked", {
            snoozedUntil: NOW + HOUR,
            snoozedAt: NOW - HOUR,
            status: "waiting",
            pendingRequest: { kind: "command" } as ThreadSummary["pendingRequest"],
          }),
        ],
      },
    ];
    const built = buildThreadRows(woken, { ...LIST, ...base });
    expect(rowsOf(built)).toEqual(["header:project:p1", "item:expired", "item:asked"]);
    expect(textOf(built.rows[2])).toContain("approval");
  });
});

// Subagent threads: hidden by default, never numbered, nested when shown.
const sub = (parent: string) =>
  ({ parentThreadId: parent as ThreadId, relationshipToParent: "subagent" }) as const;
const withSubagents: ReadonlyArray<ProjectGroup> = [
  {
    projectId: "p1" as ProjectId,
    project: null,
    title: "t8",
    lastActivityAt: NOW,
    threads: [
      summary("kid", "p1", "Child task", { ...sub("par"), lastActivityAt: NOW - 500 }),
      summary("par", "p1", "Parent work", {
        lastActivityAt: NOW - 1000,
        status: "running",
        pendingSubagentRequest: "approval",
      }),
      summary("grandkid", "p1", "Grandchild", { ...sub("kid"), lastActivityAt: NOW - 600 }),
      summary("fork", "p1", "Forked idea", {
        parentThreadId: "par" as ThreadId,
        relationshipToParent: "fork",
        lastActivityAt: NOW - 2000,
      }),
      summary("orphan", "p1", "Lost child", { ...sub("gone"), lastActivityAt: NOW - 3000 }),
      summary("other", "p1", "Other thread", { lastActivityAt: NOW - 4000 }),
    ],
  },
  {
    projectId: "p2" as ProjectId,
    project: null,
    title: "website",
    lastActivityAt: NOW - 5000,
    threads: [
      summary("w1", "p2", "Landing page", { lastActivityAt: NOW - 5000 }),
      summary("wkid", "p2", "Site helper", { ...sub("w1"), lastActivityAt: NOW - 100 }),
    ],
  },
];

describe("thread picker: subagent threads", () => {
  test("hidden by default: no rows, no numbers, counted in the footer", () => {
    const built = buildThreadRows(withSubagents, { ...LIST, ...base });
    expect(rowsOf(built)).toEqual([
      "header:project:p1",
      "item:par",
      "item:fork",
      "item:other",
      "header:project:p2",
      "item:w1",
    ]);
    // The project header counts the listed threads only.
    expect(textOf(built.rows[0])).toBe("t8  3");
    expect(built.hiddenSubagents).toBe(4);
    // The parent shows the request bubbled up from its subagent.
    expect(textOf(built.rows[1])).toMatch(/^1 \? Parent work\s+↳ approval /);
    expect(textOf(built.rows[2])).toMatch(/^2 · Forked idea /);
    expect(threadIndex(withSubagents, LIST).map((thread) => String(thread.id))).toEqual([
      "par",
      "fork",
      "other",
      "w1",
    ]);
    expect(
      threadPickerFooter({
        layout: "grouped",
        showSettled: true,
        showArchived: false,
        hiddenSettled: 0,
        showSubagents: false,
        hiddenSubagents: 4,
      }),
    ).toBe("by project (C-g flat) · 4 subagents hidden (C-x)");
    expect(
      threadPickerFooter({
        layout: "grouped",
        showSettled: true,
        showArchived: false,
        hiddenSettled: 0,
        hiddenSubagents: 1,
      }),
    ).toBe("by project (C-g flat) · 1 subagent hidden (C-x)");
    // Narrowed to a project: only its subagents are counted.
    expect(
      buildThreadRows(withSubagents, { ...LIST, ...base, projectId: "p2" }).hiddenSubagents,
    ).toBe(1);
  });

  test("grouped and shown: indented under the parent, numbers unchanged", () => {
    const options = { ...LIST, showSubagents: true };
    const built = buildThreadRows(withSubagents, { ...options, ...base });
    expect(rowsOf(built)).toEqual([
      "header:project:p1",
      "item:par",
      "item:kid",
      "item:grandkid",
      "item:fork",
      "item:orphan",
      "item:other",
      "header:project:p2",
      "item:w1",
      "item:wkid",
    ]);
    const text = (key: string) => textOf(built.rows.find((row) => row.key === key));
    expect(text("par")).toMatch(/^1 \? Parent work/);
    expect(text("kid")).toMatch(/^- · ↳ Child task\s+idle /);
    expect(text("grandkid")).toMatch(/^- · {3}↳ Grandchild\s+idle /);
    expect(text("fork")).toMatch(/^2 · Forked idea/);
    // A subagent whose parent is not listed stands on its own, with a hint.
    expect(text("orphan")).toMatch(/^- · Lost child ↳ subagent\s+idle /);
    expect(text("other")).toMatch(/^3 · Other thread/);
    expect(text("wkid")).toMatch(/^- · ↳ Site helper/);
    expect(built.hiddenSubagents).toBe(0);
    // Numbering does not move with the toggle.
    expect(threadIndex(withSubagents, options).map((thread) => String(thread.id))).toEqual([
      "par",
      "fork",
      "other",
      "w1",
    ]);
    expect(
      threadPickerFooter({
        layout: "grouped",
        showSettled: true,
        showArchived: false,
        hiddenSettled: 0,
        showSubagents: true,
        hiddenSubagents: 0,
      }),
    ).toBe("by project (C-g flat) · subagents shown (C-x)");
  });

  test("the parent's section decides: a settled parent takes its subagents along", () => {
    const groups: ReadonlyArray<ProjectGroup> = [
      {
        projectId: "p1" as ProjectId,
        project: null,
        title: "t8",
        lastActivityAt: NOW,
        threads: [
          summary("kid", "p1", "Child task", { ...sub("par"), lastActivityAt: NOW }),
          summary("par", "p1", "Parent work", { settled: true, settledAt: NOW - 1000 }),
          summary("a", "p1", "Active"),
        ],
      },
    ];
    const shown = buildThreadRows(groups, { ...LIST, ...base, showSubagents: true });
    expect(rowsOf(shown)).toEqual([
      "header:project:p1",
      "item:a",
      "header:settled:p1",
      "item:par",
      "item:kid",
    ]);
    const hidden = buildThreadRows(groups, {
      ...LIST,
      ...base,
      showSubagents: true,
      showSettled: false,
    });
    expect(rowsOf(hidden)).toEqual(["header:project:p1", "item:a"]);
  });

  test("flat and shown: in activity order with a dim ↳ parent hint", () => {
    const options = { ...LIST, layout: "flat", showSubagents: true } as const;
    const built = buildThreadRows(withSubagents, { ...options, ...base });
    expect(rowsOf(built)).toEqual([
      "header:recent",
      "item:wkid",
      "item:kid",
      "item:grandkid",
      "item:par",
      "item:fork",
      "item:orphan",
      "item:other",
      "item:w1",
    ]);
    const kid = built.rows.find((row) => row.key === "kid");
    expect(textOf(kid)).toMatch(/^- · Child task ↳ Parent work\s+idle\s+t8 /);
    expect(kid?.segments.find((segment) => segment.text.startsWith(" ↳"))?.fg).toBe(colors.faint);
    expect(textOf(built.rows.find((row) => row.key === "grandkid"))).toContain(
      "Grandchild ↳ Child task",
    );
    // Row widths stay the same as for other rows.
    expect(textOf(kid).length).toBe(textOf(built.rows.find((row) => row.key === "par")).length);
    expect(threadIndex(withSubagents, options).map((thread) => String(thread.id))).toEqual([
      "par",
      "fork",
      "other",
      "w1",
    ]);
    // Hidden in flat too.
    const hidden = buildThreadRows(withSubagents, { ...options, ...base, showSubagents: false });
    expect(rowsOf(hidden)).toEqual([
      "header:recent",
      "item:par",
      "item:fork",
      "item:other",
      "item:w1",
    ]);
  });

  test("a waiting subagent below gives the parent the ? glyph", () => {
    expect(threadGlyph(summary("x", "p", "t", { pendingSubagentRequest: "user_input" })).text).toBe(
      "?",
    );
  });

  test("project picker counts leave subagents out", () => {
    const text = buildProjectRows(withSubagents, { query: "", now: NOW, width: 80 }).map(textOf);
    expect(text[0]).toMatch(/^t8\s+3 /);
    expect(text[1]).toMatch(/^website\s+1 /);
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
