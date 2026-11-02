/**
 * Colors and the syntax style used for markdown and code. Tuned for dark
 * terminals.
 */
import { type NativeResourceOwner, type StyleDefinitionInput, SyntaxStyle } from "@opentui/core";

export const colors = {
  fg: "#c8ccd4",
  dim: "#7f8796",
  faint: "#4b5263",
  user: "#8fb4ff",
  userBar: "#4a6bbf",
  accent: "#c3a6ff",
  code: "#e5c07b",
  ok: "#98c379",
  warn: "#e5c07b",
  error: "#ef7b8a",
  focusBg: "#232838",
  promptBorder: "#e5c07b",
  bannerBg: "#5a1f2a",
  bannerWarnBg: "#4d3d12",
  modeNormal: "#61afef",
  modeInsert: "#98c379",
  modeCommand: "#e5c07b",
  modeFg: "#1b1d23",
} as const;

const SYNTAX: Readonly<Record<string, StyleDefinitionInput>> = {
  default: { fg: colors.fg },
  conceal: { fg: colors.faint },
  "markup.heading": { fg: colors.accent, bold: true },
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.strikethrough": { dim: true },
  "markup.raw": { fg: colors.code },
  "markup.raw.block": { fg: colors.fg },
  "markup.link": { fg: colors.user, underline: true },
  "markup.link.url": { fg: colors.user, underline: true },
  "markup.link.label": { fg: colors.user },
  "markup.list": { fg: colors.accent },
  "markup.quote": { fg: colors.dim, italic: true },
  keyword: { fg: "#c678dd" },
  "keyword.function": { fg: "#c678dd" },
  "keyword.return": { fg: "#c678dd" },
  operator: { fg: "#56b6c2" },
  string: { fg: "#98c379" },
  "string.special": { fg: "#98c379" },
  comment: { fg: colors.dim, italic: true },
  number: { fg: "#d19a66" },
  boolean: { fg: "#d19a66" },
  constant: { fg: "#d19a66" },
  "constant.builtin": { fg: "#d19a66" },
  function: { fg: "#61afef" },
  "function.call": { fg: "#61afef" },
  "function.method": { fg: "#61afef" },
  "function.builtin": { fg: "#56b6c2" },
  type: { fg: "#e5c07b" },
  "type.builtin": { fg: "#e5c07b" },
  constructor: { fg: "#e5c07b" },
  variable: { fg: colors.fg },
  "variable.parameter": { fg: "#e06c75" },
  "variable.builtin": { fg: "#e06c75" },
  property: { fg: "#e06c75" },
  punctuation: { fg: colors.dim },
  "punctuation.bracket": { fg: colors.dim },
  "punctuation.delimiter": { fg: colors.dim },
  tag: { fg: "#e06c75" },
  attribute: { fg: "#d19a66" },
};

/** `owner` is the renderer's native scene (`renderer.nativeScene`). */
export function createSyntaxStyle(owner: NativeResourceOwner): SyntaxStyle {
  return SyntaxStyle.fromStyles({ ...SYNTAX }, owner);
}

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
