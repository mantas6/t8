/**
 * The `?` help overlay's content and key handling, pure: the sections come
 * from the keymap tables (with `ACTION_DESCRIPTIONS`) and the command table,
 * so a new binding or command shows up without touching the overlay. Typing
 * filters the rows fuzzily on key, action name and description.
 */
import { COMMAND_SPECS } from "./cmdline.ts";
import { fuzzyMatch } from "./fuzzy.ts";
import {
  type CompiledKeymaps,
  DEFAULT_KEYMAPS,
  type HelpRow,
  helpRows,
  type KeyBinding,
  type Layer,
} from "./keymap.ts";

export interface HelpSection {
  readonly title: string;
  readonly rows: ReadonlyArray<HelpRow>;
}

/** Every layer's bindings plus the commands, in the order the overlay lists them. */
export function helpSections(
  keymaps: Readonly<Record<Layer, ReadonlyArray<KeyBinding>>> = DEFAULT_KEYMAPS,
): ReadonlyArray<HelpSection> {
  return [
    { title: "NORMAL (transcript)", rows: helpRows(keymaps.normal) },
    { title: "Pending request", rows: helpRows(keymaps.prompt) },
    { title: "INSERT (message input)", rows: helpRows(keymaps.insert) },
    { title: "Command / search line", rows: helpRows(keymaps.line) },
    {
      title: "Pickers (j k dd ds dz J K only while the filter is empty)",
      rows: helpRows([...keymaps.picker, ...keymaps.pickerList]),
    },
    { title: "Confirm (y/n line)", rows: helpRows(keymaps.confirm) },
    {
      title: "Help (this list; j k q ? / only while the filter is empty)",
      rows: helpRows([...keymaps.help, ...keymaps.helpList]),
    },
    {
      title: "Commands (Tab completes)",
      rows: COMMAND_SPECS.filter((spec) => spec.usage !== "").map((spec) => ({
        keys: spec.usage,
        action: spec.names.map((name) => `:${name}`).join(" "),
        description: spec.description,
      })),
    },
  ];
}

const haystack = (row: HelpRow) => `${row.keys} ${row.action} ${row.description}`;

/**
 * The sections with only the rows matching `query`, best match first;
 * sections left empty are dropped. Rows that contain every word of the query
 * (case-insensitive, in key, action or description) win: when there are any,
 * only they are shown. Otherwise the match is fuzzy, so `tglay` still finds
 * `picker.toggleLayout`.
 */
export function filterHelp(
  sections: ReadonlyArray<HelpSection>,
  query: string,
): ReadonlyArray<HelpSection> {
  if (query.trim() === "") return sections;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const contains = (row: HelpRow) => {
    const text = haystack(row).toLowerCase();
    return words.every((word) => text.includes(word));
  };
  const strict = sections.some((section) => section.rows.some(contains));
  const result: HelpSection[] = [];
  for (const section of sections) {
    const ranked: Array<{ row: HelpRow; score: number; index: number }> = [];
    section.rows.forEach((row, index) => {
      if (strict && !contains(row)) return;
      const match = fuzzyMatch(query, haystack(row));
      if (match !== null) ranked.push({ row, score: match.score, index });
      else if (strict) ranked.push({ row, score: Number.NEGATIVE_INFINITY, index });
    });
    if (ranked.length === 0) continue;
    ranked.sort((a, b) => b.score - a.score || a.index - b.index);
    result.push({ title: section.title, rows: ranked.map((entry) => entry.row) });
  }
  return result;
}

/** Width of the key column: the longest key list, within bounds. */
export function helpKeyWidth(sections: ReadonlyArray<HelpSection>): number {
  const longest = Math.max(
    0,
    ...sections.flatMap((section) => section.rows.map((row) => row.keys.length)),
  );
  return Math.min(30, Math.max(16, longest) + 1);
}

export interface HelpState {
  readonly filter: string;
  /** The filter has the keyboard (after `/` or typing): `j`, `k`, `q` type. */
  readonly focused: boolean;
}

export const INITIAL_HELP_STATE: HelpState = { filter: "", focused: false };

export type HelpEffect =
  | { readonly type: "none" }
  | { readonly type: "close" }
  /** Scroll by lines, or by a fraction of the viewport. */
  | { readonly type: "scroll"; readonly amount: number; readonly unit: "line" | "viewport" };

const NONE: HelpEffect = { type: "none" };

/** What a key does in the help overlay. */
export function helpKey(
  state: HelpState,
  token: string,
  keymaps: Pick<CompiledKeymaps, "help" | "helpList">,
): { readonly state: HelpState; readonly effect: HelpEffect } {
  const typing = state.focused || state.filter !== "";
  const binding = (typing ? keymaps.help : keymaps.helpList).exact.get(token);
  switch (binding?.action) {
    case "help.down":
      return { state, effect: { type: "scroll", amount: 1, unit: "line" } };
    case "help.up":
      return { state, effect: { type: "scroll", amount: -1, unit: "line" } };
    case "help.halfDown":
      return { state, effect: { type: "scroll", amount: 0.5, unit: "viewport" } };
    case "help.halfUp":
      return { state, effect: { type: "scroll", amount: -0.5, unit: "viewport" } };
    case "help.filter":
      return { state: { ...state, focused: true }, effect: NONE };
    case "help.cancel":
      return typing
        ? { state: INITIAL_HELP_STATE, effect: NONE }
        : { state, effect: { type: "close" } };
    case "help.close":
      return { state, effect: { type: "close" } };
  }
  if (token === "<BS>") {
    return { state: { ...state, filter: [...state.filter].slice(0, -1).join("") }, effect: NONE };
  }
  if (token === "<C-w>") {
    return { state: { ...state, filter: state.filter.replace(/\S*\s*$/, "") }, effect: NONE };
  }
  const text = token === "<Space>" ? " " : [...token].length === 1 ? token : null;
  if (text === null) return { state, effect: NONE };
  return { state: { filter: state.filter + text, focused: true }, effect: NONE };
}
