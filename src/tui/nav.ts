/**
 * Pure transcript navigation helpers: item classification, cursor motions,
 * search, text extraction for yanking, and thread cycling.
 */
import type { DisplayItem, ProjectGroup } from "../state/types.ts";

export const isMessage = (item: DisplayItem): boolean =>
  item.kind === "user_message" || item.kind === "assistant_message";

export const isTool = (item: DisplayItem): boolean => item.kind === "tool_call";

/** Items that render collapsed by default and can be expanded. */
export const isFoldable = (item: DisplayItem): boolean =>
  item.kind === "tool_call" || item.kind === "reasoning";

/**
 * Index of the next item matching `predicate`, strictly after (`direction`
 * 1) or before (-1) `from`. `from` may be -1 or `items.length` to search from
 * either end. Returns -1 when there is none.
 */
export function findItem(
  items: ReadonlyArray<DisplayItem>,
  from: number,
  direction: 1 | -1,
  predicate: (item: DisplayItem) => boolean,
): number {
  for (let index = from + direction; index >= 0 && index < items.length; index += direction) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return index;
  }
  return -1;
}

/** The text a user would want to copy or search for. */
export function itemText(item: DisplayItem): string {
  switch (item.kind) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "tool_call":
      return item.result === null ? item.args : `${item.args}\n\n${item.result}`;
    case "plan":
      return (
        item.markdown ??
        [item.explanation, ...item.steps.map((step) => `- ${step.text}`)]
          .filter((line) => line !== null && line !== "")
          .join("\n")
      );
    case "subagent":
      return [item.prompt, item.progress, item.result].filter((part) => part !== null).join("\n");
    case "request":
      return item.prompt ?? item.requestKind;
    case "error":
      return `${item.label}: ${item.message}`;
    case "notice":
      return item.text;
    case "checkpoint":
      return item.files.join("\n");
  }
}

/** Vim smartcase: case-insensitive unless the query has an uppercase letter. */
export function matchesQuery(text: string, query: string): boolean {
  if (query === "") return false;
  return /[A-Z]/.test(query)
    ? text.includes(query)
    : text.toLowerCase().includes(query.toLowerCase());
}

/** Searchable text: the tool name is part of a tool call's text. */
function searchText(item: DisplayItem): string {
  return item.kind === "tool_call" ? `${item.name} ${itemText(item)}` : itemText(item);
}

/**
 * The next item matching `query` after (`direction` 1) or before (-1)
 * `from`, wrapping around. Returns -1 when nothing matches.
 */
export function findMatch(
  items: ReadonlyArray<DisplayItem>,
  query: string,
  from: number,
  direction: 1 | -1,
): number {
  const predicate = (item: DisplayItem) => matchesQuery(searchText(item), query);
  const found = findItem(items, from, direction, predicate);
  if (found !== -1) return found;
  return findItem(items, direction === 1 ? -1 : items.length, direction, predicate);
}

/** The thread `delta` steps from `threadId` within its project (wrapping), or null. */
export function stepThread(
  groups: ReadonlyArray<ProjectGroup>,
  threadId: string | null,
  delta: number,
): string | null {
  if (threadId === null) return null;
  for (const group of groups) {
    const index = group.threads.findIndex((thread) => thread.id === threadId);
    if (index === -1) continue;
    const count = group.threads.length;
    if (count < 2) return null;
    const next = group.threads[(((index + delta) % count) + count) % count];
    return next?.id ?? null;
  }
  return null;
}

/** First non-empty line of `text`, cut to `width` characters with an ellipsis. */
export function oneLine(text: string, width = 200): string {
  const line =
    text
      .split("\n")
      .find((candidate) => candidate.trim() !== "")
      ?.trim() ?? "";
  return line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line;
}
