/**
 * Pure picker logic shared by every overlay list: rows, cursor movement over
 * the selectable rows, the scroll window, and the queue reorder target.
 * Components render `PickerRow`s; `App.tsx` owns the cursor and filter.
 */

/** A styled run of text in a row. */
export interface Segment {
  readonly text: string;
  readonly fg?: string;
  readonly bold?: boolean;
}

export interface PickerRow<T = unknown> {
  readonly key: string;
  /** Headers group items and cannot be selected. */
  readonly kind: "header" | "item";
  readonly segments: ReadonlyArray<Segment>;
  readonly value?: T;
}

/** Indices of the selectable rows. */
export function selectableIndices(rows: ReadonlyArray<PickerRow>): ReadonlyArray<number> {
  const indices: number[] = [];
  rows.forEach((row, index) => {
    if (row.kind === "item") indices.push(index);
  });
  return indices;
}

/** Moves a cursor (an index into the selectable rows) by `delta`, clamped to the list. */
export function moveCursor(cursor: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, cursor + delta));
}

/** Keeps a cursor inside a list that may have shrunk. */
export function clampCursor(cursor: number, count: number): number {
  return moveCursor(cursor, 0, count);
}

/**
 * First visible row so that `row` stays on screen, scrolling as little as
 * possible from `start`. A header right above the row is kept in view too.
 */
export function windowStart(start: number, row: number, total: number, height: number): number {
  if (height <= 0 || total <= height) return 0;
  let next = Math.min(Math.max(0, start), total - height);
  const top = Math.max(0, row - 1);
  if (top < next) next = top;
  if (row >= next + height) next = row - height + 1;
  return Math.min(Math.max(0, next), total - height);
}

/**
 * For moving queued run `index` by `delta` (-1 up, +1 down): the run to move
 * and the run it should end up before (null for the end of the queue), as
 * `queued-run.reorder` expects. Null when the move goes nowhere.
 */
export function reorderTarget<Id>(
  ids: ReadonlyArray<Id>,
  index: number,
  delta: -1 | 1,
): { readonly runId: Id; readonly beforeRunId: Id | null } | null {
  const runId = ids[index];
  if (runId === undefined) return null;
  const target = index + delta;
  if (target < 0 || target >= ids.length) return null;
  if (delta === -1) return { runId, beforeRunId: ids[target] ?? null };
  // Moving down one: end up before the run that is two below now.
  return { runId, beforeRunId: ids[index + 2] ?? null };
}

/** Compact relative time: `now`, `5m`, `3h`, `2d`, `6w`, `1y`. */
export function relativeTime(epochMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 365)}y`;
}

/** Splits `text` into segments, colouring the characters at `positions`. */
export function highlight(
  text: string,
  positions: ReadonlyArray<number>,
  fg: string | undefined,
  matchFg: string,
): ReadonlyArray<Segment> {
  if (positions.length === 0) return [{ text, ...(fg === undefined ? {} : { fg }) }];
  const marked = new Set(positions);
  const segments: Segment[] = [];
  let run = "";
  let runMarked = false;
  const flush = () => {
    if (run === "") return;
    const color = runMarked ? matchFg : fg;
    segments.push({ text: run, ...(color === undefined ? {} : { fg: color }) });
    run = "";
  };
  for (let index = 0; index < text.length; index++) {
    const isMarked = marked.has(index);
    if (isMarked !== runMarked) {
      flush();
      runMarked = isMarked;
    }
    run += text[index];
  }
  flush();
  return segments;
}

/** Pads or cuts `text` to exactly `width` columns (cut with an ellipsis). */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length > width) return `${text.slice(0, Math.max(0, width - 1))}…`;
  return text.padEnd(width);
}
