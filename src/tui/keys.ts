/**
 * Key handling primitives, independent of the renderer:
 *
 * - `keyToken` turns a parsed key event into a vim-style token (`j`, `G`,
 *   `<C-d>`, `<CR>`, `<S-CR>`, `<Esc>`, ...), so keymaps can be written as
 *   plain strings.
 * - `parseKeys` splits a binding like `gg`, `]t` or `<C-d>` into tokens.
 * - `KeySequencer` is the prefix/count state machine: it accumulates a count
 *   (`5j`, `3<C-f>`) and multi-key prefixes (`gg`, `]]`, `za`) with a timeout.
 */

/** The subset of OpenTUI's `KeyEvent` this module reads. */
export interface KeyLike {
  readonly name: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly sequence: string;
  readonly super?: boolean | undefined;
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  return: "CR",
  enter: "CR",
  kpenter: "CR",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "BS",
  delete: "Del",
  insert: "Insert",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

function isPrintable(text: string): boolean {
  if ([...text].length !== 1) return false;
  const code = text.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}

/**
 * Vim-style token for a key event. Printable characters are themselves
 * (`G`, `?`, `:`); everything else is bracketed with modifiers in `C-`, `M-`,
 * `S-` order (`<C-d>`, `<S-CR>`, `<M-CR>`). A raw-mode Ctrl-J arrives as a
 * bare line feed and maps to `<C-j>`, like a kitty-protocol Ctrl-J.
 */
export function keyToken(key: KeyLike): string {
  if (key.name === "linefeed") return key.meta ? "<M-C-j>" : "<C-j>";
  if (!key.ctrl && !key.meta && key.name !== "space" && isPrintable(key.sequence)) {
    return key.sequence;
  }
  let base = NAMED_KEYS[key.name] ?? key.name;
  let shift = key.shift;
  if (base.length === 1 && /[a-z]/.test(base) && shift && !key.ctrl) {
    base = base.toUpperCase();
    shift = false;
  }
  const mods = `${key.ctrl ? "C-" : ""}${key.meta ? "M-" : ""}${shift ? "S-" : ""}`;
  if (mods === "" && base.length === 1) return base;
  return `<${mods}${base}>`;
}

/** Splits a binding into tokens: `gg` → [g, g], `]t` → [], t], `3<C-f>` → [3, <C-f>]. */
export function parseKeys(binding: string): ReadonlyArray<string> {
  const tokens: string[] = [];
  let index = 0;
  while (index < binding.length) {
    if (binding[index] === "<") {
      const close = binding.indexOf(">", index + 1);
      if (close > index + 1) {
        tokens.push(binding.slice(index, close + 1));
        index = close + 1;
        continue;
      }
    }
    const char = String.fromCodePoint(binding.codePointAt(index) ?? 0);
    tokens.push(char);
    index += char.length;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Prefix / count state machine

export interface Binding<A extends string = string> {
  readonly keys: string;
  readonly action: A;
  /** Extra argument for the action, e.g. the option number for `request.pick`. */
  readonly arg?: number;
}

export interface CompiledKeymap<A extends string = string> {
  readonly exact: ReadonlyMap<string, Binding<A>>;
  /** Every proper prefix of a binding. */
  readonly prefixes: ReadonlySet<string>;
}

const SEPARATOR = " ";
const joinKeys = (tokens: ReadonlyArray<string>) => tokens.join(SEPARATOR);

/**
 * Compiles bindings (highest priority first) into lookup tables. When the
 * same keys are bound twice the first binding wins, so layering is
 * `compileKeymap([...overlay, ...base])`.
 */
export function compileKeymap<A extends string>(
  bindings: ReadonlyArray<Binding<A>>,
): CompiledKeymap<A> {
  const exact = new Map<string, Binding<A>>();
  const prefixes = new Set<string>();
  for (const binding of bindings) {
    const tokens = parseKeys(binding.keys);
    if (tokens.length === 0) continue;
    const key = joinKeys(tokens);
    if (!exact.has(key)) exact.set(key, binding);
    for (let length = 1; length < tokens.length; length++) {
      prefixes.add(joinKeys(tokens.slice(0, length)));
    }
  }
  return { exact, prefixes };
}

export type Resolution<A extends string = string> =
  /** More keys are needed (a count or a prefix is pending). */
  | { readonly type: "pending" }
  /** A binding matched. `count` is null when none was typed. */
  | { readonly type: "action"; readonly binding: Binding<A>; readonly count: number | null }
  /** A count or prefix was pending and the sequence matched nothing; it is dropped. */
  | { readonly type: "unbound"; readonly keys: string }
  /** A single unbound key with nothing pending: let the focused widget have it. */
  | { readonly type: "passthrough" };

export interface KeySequencerOptions {
  /** How long a pending prefix waits for the next key. Default 500 ms. */
  readonly timeoutMs?: number;
}

export const DEFAULT_SEQUENCE_TIMEOUT_MS = 500;

export class KeySequencer {
  readonly timeoutMs: number;
  private keys: string[] = [];
  private countText = "";
  private lastAt = 0;

  constructor(options: KeySequencerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
  }

  /** What is pending, for display (`5`, `g`, `2z`); empty when idle. */
  get pending(): string {
    return this.countText + this.keys.join("");
  }

  get isPending(): boolean {
    return this.countText !== "" || this.keys.length > 0;
  }

  reset(): void {
    this.keys = [];
    this.countText = "";
  }

  /**
   * Feeds one token. `allowCount` enables the count prefix (off while typing
   * text). A pending sequence older than the timeout is dropped first, in
   * case the caller's timer has not fired yet.
   */
  feed<A extends string>(
    token: string,
    keymap: CompiledKeymap<A>,
    options: { readonly now?: number; readonly allowCount?: boolean } = {},
  ): Resolution<A> {
    const now = options.now ?? Date.now();
    if (this.isPending && now - this.lastAt > this.timeoutMs) this.reset();
    this.lastAt = now;

    if (options.allowCount !== false && this.keys.length === 0 && /^[0-9]$/.test(token)) {
      const startsCount = token !== "0" || this.countText !== "";
      const bound = keymap.exact.has(token) || keymap.prefixes.has(token);
      if (startsCount && !(bound && this.countText === "")) {
        this.countText += token;
        return { type: "pending" };
      }
    }

    const tokens = [...this.keys, token];
    const key = joinKeys(tokens);
    if (keymap.prefixes.has(key)) {
      this.keys = tokens;
      return { type: "pending" };
    }
    const binding = keymap.exact.get(key);
    if (binding !== undefined) {
      const count = this.countText === "" ? null : Number.parseInt(this.countText, 10);
      this.reset();
      return { type: "action", binding, count };
    }
    const hadPending = this.isPending;
    const dropped = this.pending + token;
    this.reset();
    return hadPending ? { type: "unbound", keys: dropped } : { type: "passthrough" };
  }

  /**
   * The timeout fired: a pending sequence that is itself bound (it is also a
   * prefix of a longer binding) runs now; anything else is dropped.
   */
  timeout<A extends string>(keymap: CompiledKeymap<A>): Resolution<A> | null {
    if (!this.isPending) return null;
    const binding = this.keys.length > 0 ? keymap.exact.get(joinKeys(this.keys)) : undefined;
    const count = this.countText === "" ? null : Number.parseInt(this.countText, 10);
    const dropped = this.pending;
    this.reset();
    if (binding !== undefined) return { type: "action", binding, count };
    return { type: "unbound", keys: dropped };
  }
}
