/**
 * `:t` thread picker: threads grouped by project (newest activity first),
 * one row each with its picker index (for `:b <n>`), a status glyph, title,
 * project and relative time. Typing filters fuzzily on title and project;
 * the groups keep their order and the best match gets the cursor.
 */
import type { InputRenderable } from "@opentui/core";
import type { Accessor } from "solid-js";

import type { ProjectGroup, ThreadSummary } from "../../state/types.ts";
import { fuzzyMatch } from "../fuzzy.ts";
import { fit, highlight, type PickerRow, relativeTime, type Segment } from "../picker.ts";
import { colors } from "../theme.ts";
import { Picker } from "./Picker.tsx";

const ACTIVE = new Set(["preparing", "starting", "running", "waiting"]);

/** Status glyph: awaiting approval, running, failed, archived, or idle. */
export function threadGlyph(thread: ThreadSummary): { readonly text: string; readonly fg: string } {
  if (thread.archived) return { text: "×", fg: colors.faint };
  if (thread.pendingRequest !== null) return { text: "?", fg: colors.warn };
  if (ACTIVE.has(thread.status)) return { text: "●", fg: colors.ok };
  if (thread.status === "queued") return { text: "◌", fg: colors.ok };
  if (thread.status === "failed") return { text: "✕", fg: colors.error };
  return { text: "·", fg: colors.dim };
}

/**
 * Non-archived threads in picker order: what `:b <n>` counts. Indices are
 * 1-based and do not change with the filter or project narrowing.
 */
export function threadIndex(groups: ReadonlyArray<ProjectGroup>): ReadonlyArray<ThreadSummary> {
  return groups.flatMap((group) => group.threads.filter((thread) => !thread.archived));
}

export interface ThreadRowsOptions {
  /**
   * The groups row numbers are counted in (what `:b <n>` uses), when the rows
   * come from a different list, e.g. one that also holds archived threads.
   * Defaults to the groups being listed.
   */
  readonly numbering?: ReadonlyArray<ProjectGroup>;
  readonly query: string;
  /** Only this project's threads. */
  readonly projectId: string | null;
  readonly now: number;
  /** Inner width of the picker, for the columns. */
  readonly width: number;
  readonly openThreadId: string | null;
}

export interface ThreadRows {
  readonly rows: ReadonlyArray<PickerRow<ThreadSummary>>;
  /** Selectable index of the best match (0 without a query). */
  readonly best: number;
}

const PROJECT_WIDTH = 16;
const TIME_WIDTH = 4;

export function buildThreadRows(
  groups: ReadonlyArray<ProjectGroup>,
  options: ThreadRowsOptions,
): ThreadRows {
  const numbers = new Map<string, number>();
  threadIndex(options.numbering ?? groups).forEach((thread, index) => {
    numbers.set(thread.id, index + 1);
  });
  const digits = Math.max(1, String(numbers.size).length);
  const titleWidth = Math.max(
    10,
    options.width - (digits + 1) - 2 - 1 - PROJECT_WIDTH - 1 - TIME_WIDTH,
  );
  const query = options.query.trim();
  const rows: PickerRow<ThreadSummary>[] = [];
  let best = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  let selectable = 0;
  for (const group of groups) {
    if (options.projectId !== null && group.projectId !== options.projectId) continue;
    const matches: Array<{ thread: ThreadSummary; positions: ReadonlyArray<number> }> = [];
    for (const thread of group.threads) {
      const match = fuzzyMatch(query, `${thread.title} ${group.title}`);
      if (match === null) continue;
      if (query !== "" && match.score > bestScore) {
        bestScore = match.score;
        best = selectable + matches.length;
      }
      matches.push({ thread, positions: match.positions });
    }
    if (matches.length === 0) continue;
    rows.push({
      key: `project:${group.projectId}`,
      kind: "header",
      segments: [{ text: `${group.title}` }, { text: `  ${matches.length}`, fg: colors.faint }],
    });
    for (const { thread, positions } of matches) {
      const number = numbers.get(thread.id);
      const glyph = threadGlyph(thread);
      const open = thread.id === options.openThreadId;
      const title = fit(thread.title, titleWidth);
      const shown = thread.title.length > titleWidth ? titleWidth - 1 : thread.title.length;
      const segments: Segment[] = [
        {
          text: `${(number === undefined ? "-" : String(number)).padStart(digits)} `,
          fg: colors.faint,
        },
        { text: `${glyph.text} `, fg: glyph.fg },
        ...highlight(
          title,
          positions.filter((position) => position < shown),
          thread.archived ? colors.dim : open ? colors.user : colors.fg,
          colors.match,
        ),
        { text: ` ${fit(group.title, PROJECT_WIDTH)}`, fg: colors.dim },
        {
          text: ` ${relativeTime(thread.lastActivityAt, options.now).padStart(TIME_WIDTH)}`,
          fg: colors.dim,
        },
      ];
      rows.push({ key: thread.id, kind: "item", segments, value: thread });
    }
    selectable += matches.length;
  }
  return { rows, best };
}

export function ThreadPicker(props: {
  readonly rows: Accessor<ReadonlyArray<PickerRow>>;
  readonly cursorRow: Accessor<number>;
  readonly projectTitle: Accessor<string | null>;
  readonly showArchived: Accessor<boolean>;
  readonly initialFilter: string;
  readonly onFilter: (value: string) => void;
  readonly inputRef: (element: InputRenderable) => void;
  readonly width: Accessor<number>;
  readonly height: Accessor<number>;
}) {
  const title = () => {
    const project = props.projectTitle();
    return project === null ? "Threads" : `Threads · ${project}`;
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
      footer={() => (props.showArchived() ? "archived threads shown (Ctrl-A hides them)" : null)}
    />
  );
}
