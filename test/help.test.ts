import { describe, expect, test } from "bun:test";

import {
  filterHelp,
  type HelpState,
  helpKey,
  helpSections,
  INITIAL_HELP_STATE,
} from "../src/tui/help.ts";
import { compileKeymaps, DEFAULT_KEYMAPS } from "../src/tui/keymap.ts";

const keymaps = compileKeymaps();

describe("help sections", () => {
  test("every layer and the commands, built from the tables", () => {
    const sections = helpSections();
    expect(sections.map((section) => section.title.split(" ")[0])).toEqual([
      "NORMAL",
      "Pending",
      "INSERT",
      "Command",
      "Pickers",
      "Confirm",
      "Help",
      "Commands",
    ]);
    const normal = sections[0]?.rows ?? [];
    expect(normal.find((row) => row.action === "scroll.top")?.keys).toBe("gg go");
    const commands = sections.at(-1)?.rows ?? [];
    expect(commands.find((row) => row.keys === ":r [filter]")?.action).toBe(":recent :r");
  });

  test("a new binding shows up without touching the overlay", () => {
    const sections = helpSections({
      ...DEFAULT_KEYMAPS,
      normal: [...DEFAULT_KEYMAPS.normal, { keys: "<C-t>", action: "thread.next" }],
    });
    expect(sections[0]?.rows.find((row) => row.action === "thread.next")?.keys).toBe("gt <C-t>");
  });
});

describe("help filter", () => {
  const sections = helpSections();

  test("matches key, action name and description; drops empty sections", () => {
    const byKey = filterHelp(sections, "<C-g>");
    const pickers = byKey.find((section) => section.title.startsWith("Pickers"));
    expect(pickers?.rows[0]?.action).toBe("picker.toggleLayout");
    expect(byKey.some((section) => section.title.startsWith("INSERT"))).toBe(false);

    const byAction = filterHelp(sections, "toggleSettled");
    expect(byAction.flatMap((section) => section.rows.map((row) => row.action))).toEqual([
      "picker.toggleSettled",
    ]);

    const byDescription = filterHelp(sections, "most recent first");
    const actions = byDescription.flatMap((section) => section.rows.map((row) => row.action));
    expect(actions).toContain("picker.toggleLayout");
    expect(actions).toContain(":recent :r");

    expect(filterHelp(sections, "zzzzqqq")).toEqual([]);
    expect(filterHelp(sections, "  ")).toBe(sections);
  });

  test("rows containing the words win over loose fuzzy matches", () => {
    const flat = filterHelp(sections, "flat");
    const actions = flat.flatMap((section) => section.rows.map((row) => row.action));
    expect(actions).toEqual(["picker.toggleLayout"]);
    // No row contains it: fuzzy.
    const fuzzy = filterHelp(sections, "tglayout");
    expect(fuzzy.flatMap((section) => section.rows.map((row) => row.action))).toContain(
      "picker.toggleLayout",
    );
    // Several words, each anywhere in the row.
    const words = filterHelp(sections, "archived show");
    expect(words.flatMap((section) => section.rows.map((row) => row.action))).toEqual([
      "picker.toggleArchived",
    ]);
  });

  test("the best match comes first within a section", () => {
    const rows = filterHelp(sections, "top")[0]?.rows ?? [];
    expect(rows[0]?.action).toBe("scroll.top");
  });
});

describe("help keys", () => {
  const press = (state: HelpState, ...tokens: string[]) => {
    let current = state;
    const effects: string[] = [];
    for (const token of tokens) {
      const result = helpKey(current, token, keymaps);
      current = result.state;
      effects.push(
        result.effect.type === "scroll"
          ? `scroll ${result.effect.amount} ${result.effect.unit}`
          : result.effect.type,
      );
    }
    return { state: current, effects };
  };

  test("j/k scroll while the filter is empty; other keys start filtering", () => {
    expect(press(INITIAL_HELP_STATE, "j", "k").effects).toEqual([
      "scroll 1 line",
      "scroll -1 line",
    ]);
    const typed = press(INITIAL_HELP_STATE, "t", "o", "g", "j");
    expect(typed.state).toEqual({ filter: "togj", focused: true });
    expect(typed.effects).toEqual(["none", "none", "none", "none"]);
    expect(press(typed.state, "<BS>", "<Down>")).toEqual({
      state: { filter: "tog", focused: true },
      effects: ["none", "scroll 1 line"],
    });
  });

  test("/ focuses the filter so j and q type", () => {
    const result = press(INITIAL_HELP_STATE, "/", "j", "q", "<Space>", "?");
    expect(result.state).toEqual({ filter: "jq ?", focused: true });
  });

  test("Esc clears the filter first, then closes", () => {
    const typed = press(INITIAL_HELP_STATE, "a", "b");
    const cleared = press(typed.state, "<Esc>");
    expect(cleared.state).toEqual(INITIAL_HELP_STATE);
    expect(cleared.effects).toEqual(["none"]);
    expect(press(cleared.state, "<Esc>").effects).toEqual(["close"]);
    expect(press(INITIAL_HELP_STATE, "q").effects).toEqual(["close"]);
    expect(press(typed.state, "<C-c>").effects).toEqual(["close"]);
  });
});
