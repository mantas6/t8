/**
 * `:t` thread picker. Two layouts, remembered for the session:
 *
 * - `grouped`: threads grouped by project (newest activity first); inside a
 *   project the active threads come first, then a dim "settled / snoozed"
 *   section, then archived threads (when shown).
 * - `flat`: every project's threads in one list, most recent first, with the
 *   same settled / snoozed and archived sections at the bottom.
 *
 * One row per thread: its number (what `:b <n>` takes, counted in the order
 * shown), a status glyph, the title, a status label, the project and the
 * relative time. Typing filters fuzzily on title and project; the order stays
 * and the best match gets the cursor.
 *
 * Subagent threads (delegated child tasks) are hidden by default, like in the
 * web app; a request waiting in one shows on its parent (`↳ approval`). When
 * shown they never get a number: grouped, they sit indented under their parent;
 * flat, they carry a dim `↳ <parent>` hint.
 */
import type { InputRenderable } from "@opentui/core";
import type { Accessor } from "solid-js";

import {
  compareSettledThreads,
  isSubagentThread,
  resolveRowThreadId,
  SUBAGENT_MARK,
  selectThreadSection,
  selectThreadStatus,
} from "../../state/selectors.ts";
import type { ProjectGroup, StatusTone, ThreadSummary } from "../../state/types.ts";
import { fuzzyMatch } from "../fuzzy.ts";
import { fit, highlight, type PickerRow, relativeTime, type Segment } from "../picker.ts";
import { colors } from "../theme.ts";
import { Picker } from "./Picker.tsx";

const ACTIVE = new Set(["preparing", "starting", "running", "waiting"]);

/** Status glyph: awaiting approval, running, failed, archived, or idle. */
export function threadGlyph(thread: ThreadSummary): { readonly text: string; readonly fg: string } {
  if (thread.archived) return { text: "×", fg: colors.faint };
  if (thread.pendingRequest !== null || thread.pendingSubagentRequest !== null) {
    return { text: "?", fg: colors.warn };
  }
  if (ACTIVE.has(thread.status)) return { text: "●", fg: colors.ok };
  if (thread.status === "queued") return { text: "◌", fg: colors.ok };
  if (thread.status === "failed") return { text: "✕", fg: colors.error };
  return { text: "·", fg: colors.dim };
}

/** The colour for a status tone. */
export function toneColor(tone: StatusTone): string {
  switch (tone) {
    case "ok":
      return colors.ok;
    case "warn":
      return colors.warn;
    case "error":
      return colors.error;
    case "info":
      return colors.info;
    case "merged":
      return colors.accent;
    case "dim":
      return colors.dim;
  }
}

export type ThreadLayout = "grouped" | "flat";

export interface ThreadListOptions {
  readonly layout: ThreadLayout;
  /** List settled and snoozed threads (in their own section). */
  readonly showSettled: boolean;
  /** List subagent threads (never numbered). Default false. */
  readonly showSubagents?: boolean;
  /** Epoch ms: decides whether a snooze is still on. */
  readonly now: number;
}

export interface ThreadBlock {
  readonly key: string;
  /** `project`: a project's active threads; `recent`: everything active, flat. */
  readonly kind: "project" | "recent" | "settled" | "archived";
  readonly title: string;
  /** The project a grouped block belongs to; null in the flat layout. */
  readonly projectId: string | null;
  readonly threads: ReadonlyArray<ThreadSummary>;
  /** Grouped layout: how deep each listed subagent sits under its parent row. */
  readonly depths?: ReadonlyMap<string, number>;
}

const byActivity = (a: ThreadSummary, b: ThreadSummary) =>
  b.lastActivityAt - a.lastActivityAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Splits threads (already in display order) into active, settled / snoozed and archived. */
function partition(
  threads: ReadonlyArray<ThreadSummary>,
  options: ThreadListOptions,
): { active: ThreadSummary[]; settled: ThreadSummary[]; archived: ThreadSummary[] } {
  const active: ThreadSummary[] = [];
  const settled: ThreadSummary[] = [];
  const archived: ThreadSummary[] = [];
  for (const thread of threads) {
    if (thread.archived) archived.push(thread);
    else if (selectThreadSection(thread, options.now) === "active") active.push(thread);
    else if (options.showSettled) settled.push(thread);
  }
  settled.sort((a, b) => compareSettledThreads(a, b, options.now));
  return { active, settled, archived };
}

/**
 * Grouped layout: a project's threads with each subagent moved under its
 * parent. The parent's row decides the section; a subagent whose parent is not
 * listed (archived and hidden, unknown, a cycle) stands on its own.
 */
function nestSubagents(threads: ReadonlyArray<ThreadSummary>): {
  readonly roots: ReadonlyArray<ThreadSummary>;
  readonly expand: (list: ReadonlyArray<ThreadSummary>) => {
    threads: ThreadSummary[];
    depths: Map<string, number>;
  };
} {
  const byId: Record<string, ThreadSummary> = {};
  for (const thread of threads) byId[thread.id] = thread;
  const isRoot = (thread: ThreadSummary) => {
    if (!isSubagentThread(thread)) return true;
    const row = resolveRowThreadId(thread.id, byId);
    return row === thread.id || byId[row] === undefined;
  };
  const roots: ThreadSummary[] = [];
  const children = new Map<string, ThreadSummary[]>();
  for (const thread of threads) {
    if (isRoot(thread)) {
      roots.push(thread);
      continue;
    }
    const parentId = thread.parentThreadId as string;
    const list = children.get(parentId) ?? [];
    list.push(thread);
    children.set(parentId, list);
  }
  for (const list of children.values()) list.sort(byActivity);
  const expand = (list: ReadonlyArray<ThreadSummary>) => {
    const out: ThreadSummary[] = [];
    const depths = new Map<string, number>();
    const emitted = new Set<string>();
    const visit = (thread: ThreadSummary, depth: number) => {
      if (emitted.has(thread.id)) return;
      emitted.add(thread.id);
      out.push(thread);
      if (depth > 0) depths.set(thread.id, depth);
      for (const child of children.get(thread.id) ?? []) visit(child, depth + 1);
    };
    for (const thread of list) visit(thread, 0);
    return { threads: out, depths };
  };
  return { roots, expand };
}

/** The thread list in display order, as blocks (each gets a header row). */
export function threadBlocks(
  groups: ReadonlyArray<ProjectGroup>,
  options: ThreadListOptions,
): ReadonlyArray<ThreadBlock> {
  const blocks: ThreadBlock[] = [];
  const push = (block: ThreadBlock) => {
    if (block.threads.length > 0) blocks.push(block);
  };
  const listed = (threads: ReadonlyArray<ThreadSummary>) =>
    options.showSubagents === true
      ? threads
      : threads.filter((thread) => !isSubagentThread(thread));
  if (options.layout === "flat") {
    const all = groups.flatMap((group) => listed(group.threads)).sort(byActivity);
    const { active, settled, archived } = partition(all, options);
    push({
      key: "recent",
      kind: "recent",
      title: "All projects",
      projectId: null,
      threads: active,
    });
    push({
      key: "settled",
      kind: "settled",
      title: "settled / snoozed",
      projectId: null,
      threads: settled,
    });
    push({
      key: "archived",
      kind: "archived",
      title: "archived",
      projectId: null,
      threads: archived,
    });
    return blocks;
  }
  for (const group of groups) {
    const { roots, expand } = nestSubagents(listed(group.threads));
    const sections = partition(roots, options);
    const active = expand(sections.active);
    const settled = expand(sections.settled);
    const archived = expand(sections.archived);
    const id = group.projectId;
    // A project header even when only its settled / archived sections have threads.
    if (active.threads.length > 0 || settled.threads.length > 0 || archived.threads.length > 0) {
      blocks.push({
        key: `project:${id}`,
        kind: "project",
        title: group.title,
        projectId: id,
        threads: active.threads,
        depths: active.depths,
      });
    }
    push({
      key: `settled:${id}`,
      kind: "settled",
      title: "settled / snoozed",
      projectId: id,
      threads: settled.threads,
      depths: settled.depths,
    });
    push({
      key: `archived:${id}`,
      kind: "archived",
      title: "archived",
      projectId: id,
      threads: archived.threads,
      depths: archived.depths,
    });
  }
  return blocks;
}

/**
 * Non-archived, non-subagent threads in the order the picker shows them: what
 * `:b <n>` counts. Indices are 1-based and do not change with the filter,
 * project narrowing or whether subagents are shown, only with the layout and
 * whether settled threads are shown.
 */
export function threadIndex(
  groups: ReadonlyArray<ProjectGroup>,
  options: ThreadListOptions,
): ReadonlyArray<ThreadSummary> {
  return threadBlocks(groups, { ...options, showSubagents: false }).flatMap((block) =>
    block.threads.filter((thread) => !thread.archived),
  );
}

export interface ThreadRowsOptions extends ThreadListOptions {
  /**
   * The groups row numbers are counted in (what `:b <n>` uses), when the rows
   * come from a different list, e.g. one that also holds archived threads.
   * Defaults to the groups being listed.
   */
  readonly numbering?: ReadonlyArray<ProjectGroup>;
  readonly query: string;
  /** Only this project's threads. */
  readonly projectId: string | null;
  /** Inner width of the picker, for the columns. */
  readonly width: number;
  readonly openThreadId: string | null;
}

export interface ThreadRows {
  readonly rows: ReadonlyArray<PickerRow<ThreadSummary>>;
  /** Selectable index of the best match (0 without a query). */
  readonly best: number;
  /** Settled / snoozed threads left out because the section is hidden. */
  readonly hiddenSettled: number;
  /** Subagent threads left out because they are hidden. */
  readonly hiddenSubagents: number;
}

const PROJECT_WIDTH = 16;
const TIME_WIDTH = 4;
const MAX_STATUS_WIDTH = 18;

interface Match {
  readonly thread: ThreadSummary;
  readonly projectTitle: string;
  readonly positions: ReadonlyArray<number>;
  readonly score: number;
}

export function buildThreadRows(
  groups: ReadonlyArray<ProjectGroup>,
  options: ThreadRowsOptions,
): ThreadRows {
  const blocks = threadBlocks(groups, options);
  const numbers = new Map<string, number>();
  const numbered = threadIndex(options.numbering ?? groups, options);
  numbered.forEach((thread, index) => {
    numbers.set(thread.id, index + 1);
  });
  const count = numbered.length;
  const projectTitles = new Map(groups.map((group) => [group.projectId as string, group.title]));
  const titles = new Map<string, string>();
  for (const group of groups)
    for (const thread of group.threads) titles.set(thread.id, thread.title);
  const query = options.query.trim();

  // Filter first, so the columns fit what is shown.
  const matched: Array<{ block: ThreadBlock; matches: Match[] }> = [];
  for (const block of blocks) {
    if (
      options.projectId !== null &&
      block.projectId !== null &&
      block.projectId !== options.projectId
    ) {
      continue;
    }
    const matches: Match[] = [];
    for (const thread of block.threads) {
      if (options.projectId !== null && thread.projectId !== options.projectId) continue;
      const projectTitle = projectTitles.get(thread.projectId) ?? thread.projectId;
      const match = fuzzyMatch(query, `${thread.title} ${projectTitle}`);
      if (match === null) continue;
      matches.push({ thread, projectTitle, positions: match.positions, score: match.score });
    }
    matched.push({ block, matches });
  }

  const statuses = new Map(
    matched.flatMap(({ matches }) =>
      matches.map(({ thread }) => [thread.id, selectThreadStatus(thread, options.now)] as const),
    ),
  );
  const statusWidth = Math.min(
    MAX_STATUS_WIDTH,
    Math.max(6, ...[...statuses.values()].map((status) => status.label.length)),
  );
  const digits = Math.max(1, String(count).length);
  const titleWidth = Math.max(
    10,
    options.width - (digits + 1) - 2 - 1 - statusWidth - 1 - PROJECT_WIDTH - 1 - TIME_WIDTH,
  );

  const rows: PickerRow<ThreadSummary>[] = [];
  let best = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  let selectable = 0;
  // Grouped: a project header only when the project has a match somewhere.
  const projectHasMatches = new Map<string, number>();
  for (const { block, matches } of matched) {
    if (block.projectId === null) continue;
    projectHasMatches.set(
      block.projectId,
      (projectHasMatches.get(block.projectId) ?? 0) + matches.length,
    );
  }
  for (const { block, matches } of matched) {
    const isProject = block.kind === "project";
    if (isProject) {
      const total = projectHasMatches.get(block.projectId ?? "") ?? 0;
      if (total === 0) continue;
      rows.push({
        key: block.key,
        kind: "header",
        segments: [{ text: block.title }, { text: `  ${total}`, fg: colors.faint }],
      });
    } else {
      if (matches.length === 0) continue;
      const indent = block.projectId === null ? "" : "  ";
      rows.push({
        key: block.key,
        kind: "header",
        segments: [
          {
            text: `${indent}${block.title}`,
            fg: block.kind === "recent" ? colors.accent : colors.dim,
          },
          { text: `  ${matches.length}`, fg: colors.faint },
        ],
      });
    }
    const quiet = block.kind === "settled" || block.kind === "archived";
    for (const { thread, projectTitle, positions, score } of matches) {
      if (query !== "" && score > bestScore) {
        bestScore = score;
        best = selectable;
      }
      selectable += 1;
      const number = numbers.get(thread.id);
      const glyph = threadGlyph(thread);
      const status = statuses.get(thread.id) ?? selectThreadStatus(thread, options.now);
      const open = thread.id === options.openThreadId;
      const subagent = isSubagentThread(thread);
      // Grouped: indented under the parent. Flat: a dim hint naming the parent.
      const depth = block.depths?.get(thread.id) ?? 0;
      const prefix = depth > 0 ? `${"  ".repeat(depth - 1)}${SUBAGENT_MARK} ` : "";
      const parentTitle =
        thread.parentThreadId === null ? undefined : titles.get(thread.parentThreadId);
      const hintText =
        subagent && depth === 0 ? ` ${SUBAGENT_MARK} ${parentTitle ?? "subagent"}` : "";
      const room = Math.max(1, titleWidth - prefix.length);
      // The hint takes what the title leaves, but never more than half.
      const hintWidth = Math.min(
        hintText.length,
        Math.max(room - thread.title.length, Math.floor(room / 2)),
      );
      const hint = hintText === "" ? "" : fit(hintText, hintWidth);
      const titleRoom = room - hint.length;
      const title = fit(thread.title, titleRoom);
      const shown = thread.title.length > titleRoom ? titleRoom - 1 : thread.title.length;
      const segments: Segment[] = [
        {
          text: `${(number === undefined ? "-" : String(number)).padStart(digits)} `,
          fg: colors.faint,
        },
        { text: `${glyph.text} `, fg: glyph.fg },
        ...(prefix === "" ? [] : [{ text: prefix, fg: colors.faint }]),
        ...highlight(
          hint === "" ? title : title.trimEnd(),
          positions.filter((position) => position < shown),
          open ? colors.user : quiet ? colors.dim : colors.fg,
          colors.match,
        ),
        ...(hint === ""
          ? []
          : [
              {
                text: `${hint}${" ".repeat(Math.max(0, titleRoom - title.trimEnd().length))}`,
                fg: colors.faint,
              },
            ]),
        { text: ` ${fit(status.label, statusWidth)}`, fg: toneColor(status.tone) },
        { text: ` ${fit(projectTitle, PROJECT_WIDTH)}`, fg: colors.dim },
        {
          text: ` ${relativeTime(thread.lastActivityAt, options.now).padStart(TIME_WIDTH)}`,
          fg: colors.dim,
        },
      ];
      rows.push({ key: thread.id, kind: "item", segments, value: thread });
    }
  }

  let hiddenSettled = 0;
  if (!options.showSettled) {
    for (const group of groups) {
      if (options.projectId !== null && group.projectId !== options.projectId) continue;
      for (const thread of group.threads) {
        if (!thread.archived && selectThreadSection(thread, options.now) !== "active") {
          hiddenSettled += 1;
        }
      }
    }
  }
  let hiddenSubagents = 0;
  if (options.showSubagents !== true) {
    for (const group of groups) {
      if (options.projectId !== null && group.projectId !== options.projectId) continue;
      for (const thread of group.threads) {
        if (!thread.archived && isSubagentThread(thread)) hiddenSubagents += 1;
      }
    }
  }
  return { rows, best, hiddenSettled, hiddenSubagents };
}

/** The dim line under the thread list: what is hidden or shown, and the keys for it. */
export function threadPickerFooter(state: {
  readonly layout: ThreadLayout;
  readonly showSettled: boolean;
  readonly showArchived: boolean;
  readonly hiddenSettled: number;
  readonly showSubagents?: boolean;
  readonly hiddenSubagents?: number;
}): string {
  const parts = [state.layout === "flat" ? "recent first (C-g groups)" : "by project (C-g flat)"];
  if (!state.showSettled) {
    parts.push(
      state.hiddenSettled > 0
        ? `${state.hiddenSettled} settled/snoozed hidden (C-s shows)`
        : "settled hidden (C-s shows)",
    );
  }
  if (state.showSubagents === true) parts.push("subagents shown (C-x hides)");
  else if ((state.hiddenSubagents ?? 0) > 0) {
    const count = state.hiddenSubagents ?? 0;
    parts.push(`${count} subagent${count === 1 ? "" : "s"} hidden (C-x shows)`);
  }
  if (state.showArchived) parts.push("archived shown (C-a hides)");
  return parts.join(" · ");
}

export function ThreadPicker(props: {
  readonly rows: Accessor<ReadonlyArray<PickerRow>>;
  readonly cursorRow: Accessor<number>;
  readonly projectTitle: Accessor<string | null>;
  readonly layout: Accessor<ThreadLayout>;
  readonly footer: Accessor<string>;
  readonly initialFilter: string;
  readonly onFilter: (value: string) => void;
  readonly inputRef: (element: InputRenderable) => void;
  readonly width: Accessor<number>;
  readonly height: Accessor<number>;
}) {
  const title = () => {
    const base = props.layout() === "flat" ? "Threads · recent" : "Threads";
    const project = props.projectTitle();
    return project === null ? base : `${base} · ${project}`;
  };
  return (
    <Picker
      title={title}
      rows={props.rows}
      cursorRow={props.cursorRow}
      empty={() => " no matching threads"}
      width={props.width}
      height={props.height}
      filter={{ ref: props.inputRef, onInput: props.onFilter, initial: props.initialFilter }}
      footer={props.footer}
    />
  );
}
