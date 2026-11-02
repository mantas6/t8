import { describe, expect, test } from "bun:test";

import { compileKeymaps, DEFAULT_KEYMAPS, helpRows } from "../src/tui/keymap.ts";
import {
  compileKeymap,
  type KeyLike,
  KeySequencer,
  keyToken,
  parseKeys,
  type Resolution,
} from "../src/tui/keys.ts";

const key = (overrides: Partial<KeyLike>): KeyLike => ({
  name: "",
  ctrl: false,
  meta: false,
  shift: false,
  sequence: "",
  ...overrides,
});

describe("keyToken", () => {
  test("printable characters are themselves", () => {
    expect(keyToken(key({ name: "j", sequence: "j" }))).toBe("j");
    expect(keyToken(key({ name: "?", sequence: "?" }))).toBe("?");
    expect(keyToken(key({ name: ":", sequence: ":" }))).toBe(":");
    expect(keyToken(key({ name: "]", sequence: "]" }))).toBe("]");
  });

  test("shifted letters, raw and kitty", () => {
    expect(keyToken(key({ name: "g", shift: true, sequence: "G" }))).toBe("G");
    expect(keyToken(key({ name: "G", sequence: "G" }))).toBe("G");
    expect(keyToken(key({ name: "g", shift: true, sequence: "\x1b[103;2u" }))).toBe("G");
  });

  test("control keys", () => {
    expect(keyToken(key({ name: "d", ctrl: true, sequence: "\x04" }))).toBe("<C-d>");
    // kitty reports the letter as the sequence
    expect(keyToken(key({ name: "d", ctrl: true, sequence: "d" }))).toBe("<C-d>");
    expect(keyToken(key({ name: "c", ctrl: true, sequence: "\x03" }))).toBe("<C-c>");
  });

  test("enter variants", () => {
    expect(keyToken(key({ name: "return", sequence: "\r" }))).toBe("<CR>");
    expect(keyToken(key({ name: "return", shift: true, sequence: "\x1b[13;2u" }))).toBe("<S-CR>");
    expect(keyToken(key({ name: "return", meta: true, sequence: "\x1b\r" }))).toBe("<M-CR>");
    // raw-mode Ctrl-J is a bare line feed
    expect(keyToken(key({ name: "linefeed", sequence: "\n" }))).toBe("<C-j>");
    expect(keyToken(key({ name: "j", ctrl: true, sequence: "j" }))).toBe("<C-j>");
  });

  test("named keys", () => {
    expect(keyToken(key({ name: "escape", sequence: "\x1b" }))).toBe("<Esc>");
    expect(keyToken(key({ name: "tab", sequence: "\t" }))).toBe("<Tab>");
    expect(keyToken(key({ name: "space", sequence: " " }))).toBe("<Space>");
    expect(keyToken(key({ name: "up", sequence: "\x1b[A" }))).toBe("<Up>");
  });
});

describe("parseKeys", () => {
  test("splits bindings into tokens", () => {
    expect(parseKeys("gg")).toEqual(["g", "g"]);
    expect(parseKeys("]t")).toEqual(["]", "t"]);
    expect(parseKeys("<C-d>")).toEqual(["<C-d>"]);
    expect(parseKeys("3<C-f>")).toEqual(["3", "<C-f>"]);
    expect(parseKeys("<")).toEqual(["<"]);
  });
});

describe("KeySequencer", () => {
  const keymap = compileKeymap([
    { keys: "j", action: "down" },
    { keys: "gg", action: "top" },
    { keys: "gt", action: "nextThread" },
    { keys: "G", action: "bottom" },
    { keys: "]]", action: "nextMessage" },
    { keys: "]t", action: "nextTool" },
    { keys: "za", action: "toggle" },
    { keys: "<C-f>", action: "page" },
    { keys: "d", action: "short" },
    { keys: "dd", action: "long" },
  ]);
  const feedAll = (sequencer: KeySequencer, tokens: ReadonlyArray<string>, now = 0) => {
    const results: Resolution[] = [];
    for (const token of tokens) results.push(sequencer.feed(token, keymap, { now }));
    return results;
  };
  const action = (result: Resolution | null | undefined) =>
    result?.type === "action" ? [result.binding.action, result.count] : result?.type;

  test("single keys", () => {
    const sequencer = new KeySequencer();
    expect(action(sequencer.feed("j", keymap, { now: 0 }))).toEqual(["down", null]);
    expect(action(sequencer.feed("G", keymap, { now: 0 }))).toEqual(["bottom", null]);
  });

  test("prefixes", () => {
    const sequencer = new KeySequencer();
    expect(feedAll(sequencer, ["g", "g"]).map(action)).toEqual(["pending", ["top", null]]);
    expect(feedAll(sequencer, ["]", "]"]).map(action)).toEqual(["pending", ["nextMessage", null]]);
    expect(feedAll(sequencer, ["]", "t"]).map(action)).toEqual(["pending", ["nextTool", null]]);
    expect(feedAll(sequencer, ["g", "t"]).map(action)).toEqual(["pending", ["nextThread", null]]);
    expect(feedAll(sequencer, ["z", "a"]).map(action)).toEqual(["pending", ["toggle", null]]);
  });

  test("pending keys are shown", () => {
    const sequencer = new KeySequencer();
    sequencer.feed("5", keymap, { now: 0 });
    sequencer.feed("g", keymap, { now: 0 });
    expect(sequencer.pending).toBe("5g");
    sequencer.feed("g", keymap, { now: 0 });
    expect(sequencer.pending).toBe("");
  });

  test("counts", () => {
    const sequencer = new KeySequencer();
    expect(feedAll(sequencer, ["5", "j"]).map(action)).toEqual(["pending", ["down", 5]]);
    expect(feedAll(sequencer, ["1", "2", "j"]).map(action).at(-1)).toEqual(["down", 12]);
    expect(feedAll(sequencer, ["3", "<C-f>"]).map(action).at(-1)).toEqual(["page", 3]);
    expect(feedAll(sequencer, ["2", "]", "]"]).map(action).at(-1)).toEqual(["nextMessage", 2]);
    expect(feedAll(sequencer, ["1", "0", "j"]).map(action).at(-1)).toEqual(["down", 10]);
  });

  test("0 alone is not a count", () => {
    const sequencer = new KeySequencer();
    expect(sequencer.feed("0", keymap, { now: 0 }).type).toBe("passthrough");
  });

  test("counts can be disabled (typing)", () => {
    const sequencer = new KeySequencer();
    expect(sequencer.feed("5", keymap, { now: 0, allowCount: false }).type).toBe("passthrough");
  });

  test("bound digits are not counts", () => {
    const withDigits = compileKeymap([
      { keys: "1", action: "pick" },
      { keys: "j", action: "down" },
    ]);
    const sequencer = new KeySequencer();
    expect(action(sequencer.feed("1", withDigits, { now: 0 }))).toEqual(["pick", null]);
    expect(sequencer.feed("2", withDigits, { now: 0 }).type).toBe("pending");
  });

  test("an unknown continuation drops the sequence", () => {
    const sequencer = new KeySequencer();
    expect(feedAll(sequencer, ["g", "x"]).map((r) => r.type)).toEqual(["pending", "unbound"]);
    expect(sequencer.isPending).toBe(false);
    expect(feedAll(sequencer, ["3", "x"]).at(-1)).toEqual({ type: "unbound", keys: "3x" });
  });

  test("unbound single keys pass through", () => {
    const sequencer = new KeySequencer();
    expect(sequencer.feed("q", keymap, { now: 0 }).type).toBe("passthrough");
  });

  test("a stale prefix is dropped after the timeout", () => {
    const sequencer = new KeySequencer({ timeoutMs: 500 });
    expect(sequencer.feed("g", keymap, { now: 0 }).type).toBe("pending");
    // 600 ms later the `g` is gone, so this `g` starts a new sequence
    expect(sequencer.feed("g", keymap, { now: 600 }).type).toBe("pending");
    expect(action(sequencer.feed("g", keymap, { now: 700 }))).toEqual(["top", null]);
  });

  test("timeout fires a binding that is also a prefix", () => {
    const sequencer = new KeySequencer();
    expect(sequencer.feed("d", keymap, { now: 0 }).type).toBe("pending");
    expect(action(sequencer.timeout(keymap))).toEqual(["short", null]);
    expect(feedAll(sequencer, ["d", "d"]).map(action).at(-1)).toEqual(["long", null]);
  });

  test("timeout drops an incomplete prefix", () => {
    const sequencer = new KeySequencer();
    sequencer.feed("g", keymap, { now: 0 });
    expect(sequencer.timeout(keymap)).toEqual({ type: "unbound", keys: "g" });
    expect(sequencer.timeout(keymap)).toBeNull();
  });
});

describe("default keymaps", () => {
  const keymaps = compileKeymaps();
  const resolve = (layer: keyof typeof keymaps, tokens: ReadonlyArray<string>) => {
    const sequencer = new KeySequencer();
    let result: Resolution | undefined;
    for (const token of tokens) result = sequencer.feed(token, keymaps[layer], { now: 0 });
    return result?.type === "action" ? result.binding.action : result?.type;
  };

  test("NORMAL", () => {
    expect(resolve("normal", ["g", "g"])).toBe("scroll.top");
    expect(resolve("normal", ["G"])).toBe("scroll.bottom");
    expect(resolve("normal", ["<C-d>"])).toBe("scroll.halfDown");
    expect(resolve("normal", ["]", "t"])).toBe("focus.nextTool");
    expect(resolve("normal", ["[", "["])).toBe("focus.prevMessage");
    expect(resolve("normal", ["z", "M"])).toBe("fold.closeAll");
    expect(resolve("normal", ["g", "T"])).toBe("thread.prev");
    expect(resolve("normal", ["y"])).toBe("item.yank");
    expect(resolve("normal", ["n"])).toBe("search.next");
    expect(resolve("normal", ["u"])).toBe("passthrough");
  });

  test("Ctrl-D never quits", () => {
    for (const layer of ["normal", "prompt", "insert"] as const) {
      const action = resolve(layer, ["<C-d>"]);
      expect(action).toBe("scroll.halfDown");
    }
  });

  test("the prompt layer overrides y/n and binds digits", () => {
    expect(resolve("prompt", ["y"])).toBe("request.approve");
    expect(resolve("prompt", ["n"])).toBe("request.deny");
    expect(resolve("prompt", ["3"])).toBe("request.pick");
    expect(resolve("prompt", ["<Esc>"])).toBe("request.blur");
    // NORMAL bindings still work underneath
    expect(resolve("prompt", ["g", "g"])).toBe("scroll.top");
  });

  test("INSERT", () => {
    expect(resolve("insert", ["<CR>"])).toBe("input.send");
    expect(resolve("insert", ["<S-CR>"])).toBe("input.newline");
    expect(resolve("insert", ["<C-j>"])).toBe("input.newline");
    expect(resolve("insert", ["<M-CR>"])).toBe("input.newline");
    expect(resolve("insert", ["<C-s>"])).toBe("input.steer");
    expect(resolve("insert", ["<C-c>"])).toBe("input.clear");
    expect(resolve("insert", ["<Esc>"])).toBe("mode.normal");
    expect(resolve("insert", ["j"])).toBe("passthrough");
  });

  test("overrides win over defaults", () => {
    const custom = compileKeymaps({ normal: [{ keys: "j", action: "scroll.lineUp" }] });
    const sequencer = new KeySequencer();
    const result = sequencer.feed("j", custom.normal, { now: 0 });
    expect(result.type === "action" && result.binding.action).toBe("scroll.lineUp");
  });

  test("help rows group keys by action", () => {
    const rows = helpRows(DEFAULT_KEYMAPS.normal);
    expect(rows.find((row) => row.description === "scroll down one line")?.keys).toBe(
      "j <Down> <C-e>",
    );
    expect(helpRows(DEFAULT_KEYMAPS.prompt).find((row) => row.keys === "1-9")).toBeDefined();
  });
});
