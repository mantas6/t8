/**
 * Keymaps, one plain table per layer, so user overrides can be merged in
 * later (`compileKeymap([...overrides, ...defaults])`). Keys use the token
 * syntax of `keys.ts`: `j`, `G`, `gg`, `]t`, `<C-d>`, `<S-CR>`, `<Esc>`.
 *
 * Layers:
 * - `normal`: transcript focus (the default).
 * - `prompt`: a pending runtime request has focus; consulted before `normal`.
 * - `insert`: the message input has focus; unbound keys go to the input.
 * - `line`: the `:` command line, `/` search prompt or a text prompt has focus.
 * - `picker`: a picker overlay whose filter has text; typing goes to the filter.
 * - `pickerList`: a picker with an empty filter (or none): `picker` plus `j`/`k`
 *   and the list commands (`dd`, `ds`, `dz`, `J`/`K`).
 * - `confirm`: a y/n question in the bottom line.
 * - `help`: the `?` overlay while its filter has text or focus; typing goes to
 *   the filter.
 * - `helpList`: the `?` overlay with an empty, unfocused filter: `help` plus
 *   `j`/`k`, `q`, `?` and `/`.
 */
import { type Binding, type CompiledKeymap, compileKeymap } from "./keys.ts";

export type Layer =
  | "normal"
  | "prompt"
  | "insert"
  | "line"
  | "picker"
  | "pickerList"
  | "confirm"
  | "help"
  | "helpList";

export type ActionId =
  | "scroll.lineDown"
  | "scroll.lineUp"
  | "scroll.halfDown"
  | "scroll.halfUp"
  | "scroll.pageDown"
  | "scroll.pageUp"
  | "scroll.top"
  | "scroll.bottom"
  | "focus.nextMessage"
  | "focus.prevMessage"
  | "focus.nextTool"
  | "focus.prevTool"
  | "fold.toggle"
  | "fold.closeAll"
  | "fold.openAll"
  | "mode.insert"
  | "mode.insertEmpty"
  | "mode.normal"
  | "item.yank"
  | "run.interrupt"
  | "thread.next"
  | "thread.prev"
  | "search.open"
  | "search.next"
  | "search.prev"
  | "command.open"
  | "help.open"
  | "app.ctrlC"
  | "request.approve"
  | "request.deny"
  | "request.pick"
  | "request.blur"
  | "request.focus"
  | "input.send"
  | "input.steer"
  | "input.queue"
  | "input.newline"
  | "input.clear"
  | "line.submit"
  | "line.cancel"
  | "line.complete"
  | "line.older"
  | "line.newer"
  | "picker.down"
  | "picker.up"
  | "picker.pageDown"
  | "picker.pageUp"
  | "picker.select"
  | "picker.cancel"
  | "picker.close"
  | "picker.delete"
  | "picker.settle"
  | "picker.snooze"
  | "picker.moveDown"
  | "picker.moveUp"
  | "picker.toggleArchived"
  | "picker.toggleSettled"
  | "picker.toggleLayout"
  | "picker.toggleSubagents"
  | "confirm.yes"
  | "confirm.no"
  | "help.down"
  | "help.up"
  | "help.halfDown"
  | "help.halfUp"
  | "help.filter"
  | "help.cancel"
  | "help.close";

export type KeyBinding = Binding<ActionId>;

/** One-line descriptions, used by the help overlay. */
export const ACTION_DESCRIPTIONS: Readonly<Record<ActionId, string>> = {
  "scroll.lineDown": "scroll down one line",
  "scroll.lineUp": "scroll up one line",
  "scroll.halfDown": "scroll down half a page",
  "scroll.halfUp": "scroll up half a page",
  "scroll.pageDown": "scroll down a page",
  "scroll.pageUp": "scroll up a page",
  "scroll.top": "go to the top",
  "scroll.bottom": "go to the bottom and follow new output",
  "focus.nextMessage": "next message",
  "focus.prevMessage": "previous message",
  "focus.nextTool": "next tool call",
  "focus.prevTool": "previous tool call",
  "fold.toggle": "fold/unfold the focused item",
  "fold.closeAll": "fold everything",
  "fold.openAll": "unfold everything",
  "mode.insert": "write a message (keeps the draft)",
  "mode.insertEmpty": "write a new message (discards the draft)",
  "mode.normal": "back to NORMAL",
  "item.yank": "copy the focused message (OSC 52)",
  "run.interrupt": "interrupt the current run",
  "thread.next": "next thread in this project",
  "thread.prev": "previous thread in this project",
  "search.open": "search the transcript",
  "search.next": "next match",
  "search.prev": "previous match",
  "command.open": "command line",
  "help.open": "this help",
  "app.ctrlC": "interrupt the run; twice to quit",
  "request.approve": "approve the pending request",
  "request.deny": "deny the pending request",
  "request.pick": "pick option N",
  "request.blur": "leave the request (it stays visible)",
  "request.focus": "back to the pending request",
  "input.send": "send",
  "input.steer": "send as steer (into the active run)",
  "input.queue": "send queued (runs after the active run)",
  "input.newline": "insert a newline",
  "input.clear": "clear the draft and leave INSERT",
  "line.submit": "run",
  "line.cancel": "cancel",
  "line.complete": "complete the command, thread or project name",
  "line.older": "older command from history",
  "line.newer": "newer command from history",
  "picker.down": "next entry",
  "picker.up": "previous entry",
  "picker.pageDown": "a page down",
  "picker.pageUp": "a page up",
  "picker.select": "open / choose",
  "picker.cancel": "clear the filter, then close",
  "picker.close": "close",
  "picker.delete": "archive the thread / cancel the queued message (asks first)",
  "picker.settle": "thread picker: settle the thread (un-settle if settled)",
  "picker.snooze": "thread picker: snooze the thread (presets; wake it if snoozed)",
  "picker.moveDown": "move the queued message down",
  "picker.moveUp": "move the queued message up",
  "picker.toggleArchived": "thread picker: show / hide archived threads",
  "picker.toggleSettled": "thread picker: show / hide settled and snoozed threads",
  "picker.toggleLayout": "thread picker: group by project / flat, most recent first",
  "picker.toggleSubagents": "thread picker: show / hide subagent threads",
  "confirm.yes": "yes",
  "confirm.no": "no",
  "help.down": "scroll down",
  "help.up": "scroll up",
  "help.halfDown": "scroll down half a page",
  "help.halfUp": "scroll up half a page",
  "help.filter": "filter (typing anything else filters too)",
  "help.cancel": "clear the filter, then close",
  "help.close": "close",
};

const scrollWhileTyping: ReadonlyArray<KeyBinding> = [
  { keys: "<C-d>", action: "scroll.halfDown" },
  { keys: "<C-u>", action: "scroll.halfUp" },
  { keys: "<C-f>", action: "scroll.pageDown" },
  { keys: "<C-b>", action: "scroll.pageUp" },
];

export const DEFAULT_KEYMAPS: Readonly<Record<Layer, ReadonlyArray<KeyBinding>>> = {
  normal: [
    { keys: "j", action: "scroll.lineDown" },
    { keys: "k", action: "scroll.lineUp" },
    { keys: "<Down>", action: "scroll.lineDown" },
    { keys: "<Up>", action: "scroll.lineUp" },
    { keys: "<C-e>", action: "scroll.lineDown" },
    { keys: "<C-y>", action: "scroll.lineUp" },
    { keys: "<C-d>", action: "scroll.halfDown" },
    { keys: "<C-u>", action: "scroll.halfUp" },
    { keys: "<C-f>", action: "scroll.pageDown" },
    { keys: "<C-b>", action: "scroll.pageUp" },
    { keys: "<PageDown>", action: "scroll.pageDown" },
    { keys: "<PageUp>", action: "scroll.pageUp" },
    { keys: "gg", action: "scroll.top" },
    { keys: "go", action: "scroll.top" },
    { keys: "G", action: "scroll.bottom" },
    { keys: "]]", action: "focus.nextMessage" },
    { keys: "[[", action: "focus.prevMessage" },
    { keys: "]t", action: "focus.nextTool" },
    { keys: "[t", action: "focus.prevTool" },
    { keys: "za", action: "fold.toggle" },
    { keys: "<Tab>", action: "fold.toggle" },
    { keys: "zM", action: "fold.closeAll" },
    { keys: "zR", action: "fold.openAll" },
    { keys: "i", action: "mode.insert" },
    { keys: "a", action: "mode.insert" },
    { keys: "o", action: "mode.insertEmpty" },
    { keys: "y", action: "item.yank" },
    { keys: "x", action: "run.interrupt" },
    { keys: "gt", action: "thread.next" },
    { keys: "gT", action: "thread.prev" },
    { keys: "/", action: "search.open" },
    { keys: "n", action: "search.next" },
    { keys: "N", action: "search.prev" },
    { keys: ":", action: "command.open" },
    { keys: "?", action: "help.open" },
    { keys: "<C-c>", action: "app.ctrlC" },
    { keys: "<CR>", action: "request.focus" },
  ],
  prompt: [
    { keys: "y", action: "request.approve" },
    { keys: "n", action: "request.deny" },
    { keys: "<Esc>", action: "request.blur" },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(
      (n): KeyBinding => ({ keys: String(n), action: "request.pick", arg: n }),
    ),
  ],
  insert: [
    { keys: "<Esc>", action: "mode.normal" },
    { keys: "<CR>", action: "input.send" },
    { keys: "<S-CR>", action: "input.newline" },
    { keys: "<C-j>", action: "input.newline" },
    { keys: "<M-CR>", action: "input.newline" },
    { keys: "<C-s>", action: "input.steer" },
    { keys: "<C-q>", action: "input.queue" },
    { keys: "<C-c>", action: "input.clear" },
    ...scrollWhileTyping,
  ],
  line: [
    { keys: "<Esc>", action: "line.cancel" },
    { keys: "<C-c>", action: "line.cancel" },
    { keys: "<CR>", action: "line.submit" },
    { keys: "<Tab>", action: "line.complete" },
    { keys: "<Up>", action: "line.older" },
    { keys: "<Down>", action: "line.newer" },
  ],
  picker: [
    { keys: "<Down>", action: "picker.down" },
    { keys: "<Up>", action: "picker.up" },
    { keys: "<C-n>", action: "picker.down" },
    { keys: "<C-p>", action: "picker.up" },
    { keys: "<PageDown>", action: "picker.pageDown" },
    { keys: "<PageUp>", action: "picker.pageUp" },
    { keys: "<CR>", action: "picker.select" },
    { keys: "<Esc>", action: "picker.cancel" },
    { keys: "<C-c>", action: "picker.close" },
    { keys: "<C-a>", action: "picker.toggleArchived" },
    { keys: "<C-s>", action: "picker.toggleSettled" },
    { keys: "<C-g>", action: "picker.toggleLayout" },
    { keys: "<C-x>", action: "picker.toggleSubagents" },
  ],
  pickerList: [
    { keys: "j", action: "picker.down" },
    { keys: "k", action: "picker.up" },
    { keys: "dd", action: "picker.delete" },
    { keys: "ds", action: "picker.settle" },
    { keys: "dz", action: "picker.snooze" },
    { keys: "J", action: "picker.moveDown" },
    { keys: "K", action: "picker.moveUp" },
  ],
  confirm: [
    { keys: "y", action: "confirm.yes" },
    { keys: "Y", action: "confirm.yes" },
    { keys: "n", action: "confirm.no" },
    { keys: "N", action: "confirm.no" },
    { keys: "<Esc>", action: "confirm.no" },
    { keys: "<C-c>", action: "confirm.no" },
  ],
  help: [
    { keys: "<Down>", action: "help.down" },
    { keys: "<Up>", action: "help.up" },
    { keys: "<C-n>", action: "help.down" },
    { keys: "<C-p>", action: "help.up" },
    { keys: "<C-d>", action: "help.halfDown" },
    { keys: "<C-u>", action: "help.halfUp" },
    { keys: "<C-f>", action: "help.halfDown" },
    { keys: "<C-b>", action: "help.halfUp" },
    { keys: "<PageDown>", action: "help.halfDown" },
    { keys: "<PageUp>", action: "help.halfUp" },
    { keys: "<Esc>", action: "help.cancel" },
    { keys: "<C-c>", action: "help.close" },
  ],
  helpList: [
    { keys: "j", action: "help.down" },
    { keys: "k", action: "help.up" },
    { keys: "/", action: "help.filter" },
    { keys: "q", action: "help.close" },
    { keys: "?", action: "help.close" },
  ],
};

export type CompiledKeymaps = Readonly<{
  normal: CompiledKeymap<ActionId>;
  /** `prompt` layered over `normal`. */
  prompt: CompiledKeymap<ActionId>;
  insert: CompiledKeymap<ActionId>;
  line: CompiledKeymap<ActionId>;
  picker: CompiledKeymap<ActionId>;
  /** `pickerList` layered over `picker`. */
  pickerList: CompiledKeymap<ActionId>;
  confirm: CompiledKeymap<ActionId>;
  help: CompiledKeymap<ActionId>;
  /** `helpList` layered over `help`. */
  helpList: CompiledKeymap<ActionId>;
}>;

/** Compiles the keymaps; `overrides` bindings take precedence over the defaults. */
export function compileKeymaps(
  overrides: Partial<Record<Layer, ReadonlyArray<KeyBinding>>> = {},
): CompiledKeymaps {
  const layer = (name: Layer) => [...(overrides[name] ?? []), ...DEFAULT_KEYMAPS[name]];
  return {
    normal: compileKeymap(layer("normal")),
    prompt: compileKeymap([...layer("prompt"), ...layer("normal")]),
    insert: compileKeymap(layer("insert")),
    line: compileKeymap(layer("line")),
    picker: compileKeymap(layer("picker")),
    pickerList: compileKeymap([...layer("pickerList"), ...layer("picker")]),
    confirm: compileKeymap(layer("confirm")),
    help: compileKeymap(layer("help")),
    helpList: compileKeymap([...layer("helpList"), ...layer("help")]),
  };
}

export interface HelpRow {
  readonly keys: string;
  /** The action id (or the command name, for commands). */
  readonly action: string;
  readonly description: string;
}

/** Help overlay rows: keys grouped by action, in table order. */
export function helpRows(bindings: ReadonlyArray<KeyBinding>): ReadonlyArray<HelpRow> {
  const byAction = new Map<string, { action: string; keys: string[]; description: string }>();
  for (const binding of bindings) {
    const id = binding.action === "request.pick" ? "request.pick" : binding.action;
    const entry = byAction.get(id);
    const keys = binding.action === "request.pick" ? "1-9" : binding.keys;
    if (entry === undefined) {
      byAction.set(id, {
        action: binding.action,
        keys: [keys],
        description: ACTION_DESCRIPTIONS[binding.action],
      });
    } else if (!entry.keys.includes(keys)) {
      entry.keys.push(keys);
    }
  }
  return [...byAction.values()].map((entry) => ({
    keys: entry.keys.join(" "),
    action: entry.action,
    description: entry.description,
  }));
}
