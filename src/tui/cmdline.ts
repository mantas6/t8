/**
 * The `:` command line: the command table, the parser, Tab completion (on
 * command names, and on thread titles / project names where a command takes
 * one) and the session history behind `Up` / `Down`. Pure; `App.tsx` runs
 * the parsed commands.
 */
import { fuzzyFilter } from "./fuzzy.ts";

export type Command =
  | { readonly type: "noop" }
  /** `force` (`:qa`, `:q!`) quits even while a run is active. */
  | { readonly type: "quit"; readonly force: boolean }
  | { readonly type: "write" }
  | { readonly type: "approve" }
  | { readonly type: "deny" }
  /** Thread picker, optionally pre-filtered. */
  | { readonly type: "threads"; readonly filter: string }
  /** Project switcher; with a name, narrows the thread picker to that project directly. */
  | { readonly type: "projects"; readonly name: string }
  /** New thread; null title prompts for one. */
  | { readonly type: "new"; readonly title: string | null }
  | { readonly type: "model" }
  | { readonly type: "mode" }
  /** Jump to a thread by picker index (a number) or title. */
  | { readonly type: "thread"; readonly target: number | string }
  | { readonly type: "threadNext" }
  | { readonly type: "threadPrev" }
  | { readonly type: "queue" }
  | { readonly type: "help" }
  | { readonly type: "archive" }
  | { readonly type: "reconnect" }
  /** Pair with a server by link; null asks for the link. */
  | { readonly type: "connect"; readonly link: string | null }
  | { readonly type: "servers" }
  | { readonly type: "usage"; readonly message: string }
  | { readonly type: "unknown"; readonly name: string };

type ArgKind = "none" | "thread" | "project" | "text" | "index";

interface CommandSpec {
  /** First name is the canonical one; the rest are aliases. */
  readonly names: ReadonlyArray<string>;
  readonly arg: ArgKind;
  /** For the help overlay and README. */
  readonly usage: string;
  readonly description: string;
  readonly parse: (arg: string, name: string) => Command;
}

export const COMMAND_SPECS: ReadonlyArray<CommandSpec> = [
  {
    names: ["threads", "t"],
    arg: "thread",
    usage: ":t [filter]",
    description: "thread picker",
    parse: (arg) => ({ type: "threads", filter: arg }),
  },
  {
    names: ["projects", "p"],
    arg: "project",
    usage: ":p [project]",
    description: "project switcher",
    parse: (arg) => ({ type: "projects", name: arg }),
  },
  {
    names: ["new", "n"],
    arg: "text",
    usage: ":n [title]",
    description: "new thread (asks for the project, then the title)",
    parse: (arg) => ({ type: "new", title: arg === "" ? null : arg }),
  },
  {
    names: ["model", "m"],
    arg: "none",
    usage: ":m",
    description: "model picker for the open thread",
    parse: () => ({ type: "model" }),
  },
  {
    names: ["mode"],
    arg: "none",
    usage: ":mode",
    description: "runtime mode picker for the open thread",
    parse: () => ({ type: "mode" }),
  },
  {
    names: ["thread", "b"],
    arg: "index",
    usage: ":b <n|title>",
    description: "open thread number n from the picker (or by title)",
    parse: (arg) => {
      if (arg === "") return { type: "usage", message: "usage: :b <n> (the number in :t)" };
      return /^[0-9]+$/.test(arg)
        ? { type: "thread", target: Number.parseInt(arg, 10) }
        : { type: "thread", target: arg };
    },
  },
  {
    names: ["bnext", "bn"],
    arg: "none",
    usage: ":bn  :bp",
    description: "next / previous thread in the project",
    parse: () => ({ type: "threadNext" }),
  },
  {
    names: ["bprevious", "bp", "bprev", "bN"],
    arg: "none",
    usage: "",
    description: "",
    parse: () => ({ type: "threadPrev" }),
  },
  {
    names: ["queue"],
    arg: "none",
    usage: ":queue",
    description: "queued messages of the open thread",
    parse: () => ({ type: "queue" }),
  },
  {
    names: ["archive"],
    arg: "none",
    usage: ":archive",
    description: "archive the open thread (asks first)",
    parse: () => ({ type: "archive" }),
  },
  {
    names: ["approve", "a"],
    arg: "none",
    usage: ":a  :approve",
    description: "approve the pending request",
    parse: () => ({ type: "approve" }),
  },
  {
    names: ["deny", "d"],
    arg: "none",
    usage: ":d  :deny",
    description: "deny the pending request",
    parse: () => ({ type: "deny" }),
  },
  {
    names: ["reconnect"],
    arg: "none",
    usage: ":reconnect",
    description: "drop the connection and reconnect now",
    parse: () => ({ type: "reconnect" }),
  },
  {
    names: ["connect"],
    arg: "text",
    usage: ":connect [link]",
    description: "pair with a server by its pairing link, save it and switch to it",
    parse: (arg) => ({ type: "connect", link: arg === "" ? null : arg }),
  },
  {
    names: ["servers"],
    arg: "none",
    usage: ":servers",
    description: "saved servers; Enter switches",
    parse: () => ({ type: "servers" }),
  },
  {
    names: ["help", "h"],
    arg: "none",
    usage: ":h  :help",
    description: "keys and commands",
    parse: () => ({ type: "help" }),
  },
  {
    names: ["quit", "q", "wq", "x"],
    arg: "none",
    usage: ":q",
    description: "quit (refused while a run is active in the open thread)",
    parse: () => ({ type: "quit", force: false }),
  },
  {
    names: ["qa", "q!", "qa!", "qall", "quitall", "wqa", "xa"],
    arg: "none",
    usage: ":qa  :q!",
    description: "quit, even with a run active",
    parse: () => ({ type: "quit", force: true }),
  },
  {
    names: ["write", "w"],
    arg: "none",
    usage: ":w",
    description: "nothing to save",
    parse: () => ({ type: "write" }),
  },
];

const BY_NAME = new Map<string, CommandSpec>();
for (const spec of COMMAND_SPECS) for (const name of spec.names) BY_NAME.set(name, spec);

/** Every command name, aliases included, for completion. */
export const COMMAND_NAMES: ReadonlyArray<string> = COMMAND_SPECS.flatMap((spec) => spec.names);

/** Splits `:name rest` into the name and the trimmed argument text. */
function split(input: string): { name: string; arg: string; argStart: number } {
  const leading = input.match(/^[\s:]*/)?.[0].length ?? 0;
  const body = input.slice(leading);
  const nameLength = body.match(/^\S*/)?.[0].length ?? 0;
  const name = body.slice(0, nameLength);
  const rest = body.slice(nameLength);
  const gap = rest.match(/^\s*/)?.[0].length ?? 0;
  return { name, arg: rest.trim(), argStart: leading + nameLength + gap };
}

/**
 * Whether a command line may be kept in the history: not `:connect <link>`,
 * whose link carries a credential.
 */
export function keepInHistory(input: string): boolean {
  const { name, arg } = split(input);
  return !(BY_NAME.get(name)?.names[0] === "connect" && arg !== "");
}

export function parseCommandLine(input: string): Command {
  const { name, arg } = split(input);
  if (name === "") return { type: "noop" };
  const spec = BY_NAME.get(name);
  if (spec === undefined) return { type: "unknown", name };
  if (spec.arg === "none" && arg !== "") {
    return { type: "usage", message: `:${name} takes no argument` };
  }
  return spec.parse(arg, name);
}

/**
 * Why `:q` should not quit, or null to go ahead: a plain `:q` refuses while
 * a run is active in the open thread (quitting would not stop it, and the
 * user might expect it to); `:qa` / `:q!` always quit.
 */
export function quitBlocker(force: boolean, runActive: boolean): string | null {
  if (force || !runActive) return null;
  return "a run is active in this thread: x interrupts it, :qa quits anyway";
}

/** What `:w` says: there is nothing to save. */
export const WRITE_MESSAGE = "Nothing to write: the server already saved everything. Try :q";

// ---------------------------------------------------------------------------
// Completion

export interface CompletionSources {
  readonly threads: ReadonlyArray<string>;
  readonly projects: ReadonlyArray<string>;
}

export interface CompletionSet {
  /** Where the completed word starts in the input. */
  readonly start: number;
  readonly candidates: ReadonlyArray<string>;
  /** Append a space after a unique completion (a command that takes an argument). */
  readonly addSpace: ReadonlyArray<boolean>;
}

const unique = (values: ReadonlyArray<string>) => [...new Set(values)];

/** Candidates for the word under the cursor (the cursor is assumed at the end). */
export function completionCandidates(input: string, sources: CompletionSources): CompletionSet {
  const { name, arg, argStart } = split(input);
  if (!/^[\s:]*\S+\s/.test(input)) {
    const start = input.length - name.length;
    const candidates = COMMAND_NAMES.filter((candidate) => candidate.startsWith(name));
    // Shortest first so `:t<Tab>` offers `t` then `threads`, `thread`.
    const sorted = unique(candidates).sort((a, b) => a.length - b.length || a.localeCompare(b));
    return {
      start,
      candidates: sorted,
      addSpace: sorted.map((candidate) => (BY_NAME.get(candidate)?.arg ?? "none") !== "none"),
    };
  }
  const spec = BY_NAME.get(name);
  const kind = spec?.arg ?? "none";
  const pool =
    kind === "thread" || kind === "index"
      ? sources.threads
      : kind === "project"
        ? sources.projects
        : [];
  const lowered = arg.toLowerCase();
  const prefixed = pool.filter((candidate) => candidate.toLowerCase().startsWith(lowered));
  const fuzzy = fuzzyFilter(pool, arg, (candidate) => candidate).map((ranked) => ranked.item);
  const candidates = unique([...prefixed, ...fuzzy]);
  return { start: argStart, candidates, addSpace: candidates.map(() => false) };
}

function commonPrefix(values: ReadonlyArray<string>): string {
  const first = values[0];
  if (first === undefined) return "";
  let length = first.length;
  for (const value of values) {
    let i = 0;
    while (i < length && i < value.length && value[i] === first[i]) i++;
    length = i;
  }
  return first.slice(0, length);
}

export interface CompletionResult {
  readonly text: string;
  readonly candidates: ReadonlyArray<string>;
  /** The selected candidate while cycling, else -1. */
  readonly index: number;
}

/**
 * Tab completion with cycling. A unique candidate completes at once; several
 * first complete to their common prefix, then each further Tab cycles
 * through them. Typing anything else starts over.
 */
export class Completer {
  private cycle: {
    readonly base: string;
    readonly set: CompletionSet;
    index: number;
    last: string;
  } | null = null;

  reset(): void {
    this.cycle = null;
  }

  complete(input: string, sources: CompletionSources): CompletionResult | null {
    const cycle = this.cycle;
    if (cycle !== null && cycle.last === input && cycle.set.candidates.length > 1) {
      cycle.index = (cycle.index + 1) % cycle.set.candidates.length;
      const text = cycle.base + (cycle.set.candidates[cycle.index] ?? "");
      cycle.last = text;
      return { text, candidates: cycle.set.candidates, index: cycle.index };
    }
    this.cycle = null;
    const set = completionCandidates(input, sources);
    if (set.candidates.length === 0) return null;
    const base = input.slice(0, set.start);
    const typed = input.slice(set.start);
    if (set.candidates.length === 1) {
      const only = set.candidates[0] ?? "";
      const text = base + only + (set.addSpace[0] === true ? " " : "");
      return { text, candidates: set.candidates, index: 0 };
    }
    const prefix = commonPrefix(set.candidates);
    if (prefix.length > typed.length && prefix.toLowerCase().startsWith(typed.toLowerCase())) {
      const text = base + prefix;
      this.cycle = { base, set, index: -1, last: text };
      return { text, candidates: set.candidates, index: -1 };
    }
    const text = base + (set.candidates[0] ?? "");
    this.cycle = { base, set, index: 0, last: text };
    return { text, candidates: set.candidates, index: 0 };
  }
}

// ---------------------------------------------------------------------------
// History

/** Command-line history for one session, like vim's: `Up` older, `Down` newer. */
export class LineHistory {
  private readonly entries: string[] = [];
  private readonly limit: number;
  private position = 0;
  private draft = "";

  constructor(limit = 100) {
    this.limit = limit;
  }

  /** Records a submitted line (skipping blanks and immediate repeats) and resets browsing. */
  push(line: string): void {
    const text = line.trim();
    if (text !== "" && this.entries[this.entries.length - 1] !== text) {
      this.entries.push(text);
      if (this.entries.length > this.limit) this.entries.shift();
    }
    this.position = this.entries.length;
    this.draft = "";
  }

  /** Starts browsing from the newest entry; call when the line opens. */
  reset(): void {
    this.position = this.entries.length;
    this.draft = "";
  }

  /** The previous (older) entry, or null at the oldest. `current` is kept as the draft. */
  older(current: string): string | null {
    if (this.position === 0) return null;
    if (this.position === this.entries.length) this.draft = current;
    this.position -= 1;
    return this.entries[this.position] ?? null;
  }

  /** The next (newer) entry; past the newest, the draft typed before browsing. */
  newer(): string | null {
    if (this.position >= this.entries.length) return null;
    this.position += 1;
    return this.position === this.entries.length
      ? this.draft
      : (this.entries[this.position] ?? null);
  }
}
