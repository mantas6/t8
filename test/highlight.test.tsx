import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CapturedFrame } from "@opentui/core";
import { testRender, useRenderer } from "@opentui/solid";

import { registerParsers } from "../src/tui/parsers.ts";
import { colors, createSyntaxStyle } from "../src/tui/theme.ts";

// Before the first render: the tree-sitter client reads the parser list once.
registerParsers();

const hex = (ints: readonly number[]) =>
  `#${ints
    .slice(0, 3)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;

const KEYWORD = "#c678dd";
const STRING = "#98c379";
const FUNCTION = "#61afef";
const PROPERTY = "#e06c75";

/** Fence language, code, and a token with the color it must get. */
const BLOCKS: ReadonlyArray<readonly [lang: string, code: string, token: string, fg: string]> = [
  ["php", "<?php\nfunction add(int $a): int { return $a; }", "function", KEYWORD],
  ["nix", '{ pkgs }:\nlet name = "t8"; in name', "let", KEYWORD],
  ["bash", 'if [ -n "$x" ]; then echo hi; fi', "then", KEYWORD],
  ["sh", "printf '%s' ok", "printf", FUNCTION],
  ["go", 'package main\nfunc main() { println("go") }', "func", KEYWORD],
  ["python", "def greet(name):\n    return name", "def", KEYWORD],
  ["json", '{ "key": "json-value" }', '"json-value"', STRING],
  ["yaml", 'name: "yaml-value"', '"yaml-value"', STRING],
  ["sql", "SELECT id FROM users;", "SELECT", KEYWORD],
  ["toml", 'title = "toml-value"', '"toml-value"', STRING],
  ["css", "a { color: red; }", "color", PROPERTY],
  // The <script> body goes through the JavaScript grammar (an injection).
  ["html", "<p>hi</p>\n<script>\nconst x = 1;\n</script>", "const", KEYWORD],
  ["diff", "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old line\n+new line", "new line", colors.ok],
];

const MARKDOWN = [
  ...BLOCKS.map(([lang, code]) => `\`\`\`${lang}\n${code}\n\`\`\``),
  "```klingon\nqapla unknown-lang\n```",
].join("\n\n");

function View() {
  const renderer = useRenderer();
  const syntax = createSyntaxStyle(renderer.nativeScene);
  return <markdown content={MARKDOWN} syntaxStyle={syntax} conceal fg={colors.fg} />;
}

/** Color of the first span that contains `token`, or null. */
function colorOf(frame: CapturedFrame, token: string): string | null {
  for (const line of frame.lines) {
    for (const span of line.spans) {
      if (span.text.includes(token)) return hex(span.fg.toInts());
    }
  }
  return null;
}

describe("code block highlighting", () => {
  let setup: Awaited<ReturnType<typeof testRender>>;
  let frame: CapturedFrame;

  beforeAll(async () => {
    setup = await testRender(() => <View />, { width: 80, height: 70 });
    // The grammars load and highlight in a worker; render until all are in.
    const deadline = Date.now() + 8_000;
    do {
      await setup.renderOnce();
      frame = setup.captureSpans();
      if (BLOCKS.every(([, , token, fg]) => colorOf(frame, token) === fg)) break;
      await Bun.sleep(25);
    } while (Date.now() < deadline);
  }, 10_000);

  afterAll(() => {
    setup.renderer.destroy();
  });

  for (const [lang, , token, fg] of BLOCKS) {
    test(`${lang}: ${token} is highlighted`, () => {
      expect(colorOf(frame, token)).toBe(fg);
    });
  }

  test("a fence in an unknown language renders as plain code", () => {
    expect(setup.captureCharFrame()).toContain("qapla unknown-lang");
    expect(colorOf(frame, "qapla unknown-lang")).toBe(colors.fg);
  });
});
