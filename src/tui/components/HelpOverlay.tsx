/** `?` help: the keymap tables as a cheat sheet. j/k scroll, Esc closes. */
import type { ScrollBoxRenderable } from "@opentui/core";
import { For } from "solid-js";

import { COMMAND_SPECS } from "../cmdline.ts";
import { DEFAULT_KEYMAPS, helpRows } from "../keymap.ts";
import { colors } from "../theme.ts";

const SECTIONS = [
  { title: "NORMAL (transcript)", rows: helpRows(DEFAULT_KEYMAPS.normal) },
  { title: "Pending request", rows: helpRows(DEFAULT_KEYMAPS.prompt) },
  { title: "INSERT (message input)", rows: helpRows(DEFAULT_KEYMAPS.insert) },
  { title: "Command / search line", rows: helpRows(DEFAULT_KEYMAPS.line) },
  {
    title: "Pickers (j k dd J K only while the filter is empty)",
    rows: helpRows([...DEFAULT_KEYMAPS.picker, ...DEFAULT_KEYMAPS.pickerList]),
  },
  { title: "Confirm (y/n line)", rows: helpRows(DEFAULT_KEYMAPS.confirm) },
  {
    title: "Commands (Tab completes)",
    rows: COMMAND_SPECS.filter((spec) => spec.usage !== "").map((spec) => ({
      keys: spec.usage,
      description: spec.description,
    })),
  },
];

const KEY_WIDTH = 22;

export function HelpOverlay(props: { ref: (element: ScrollBoxRenderable) => void }) {
  return (
    <box
      position="absolute"
      top={1}
      left={2}
      right={2}
      bottom={1}
      zIndex={10}
      border
      borderStyle="rounded"
      borderColor={colors.accent}
      title=" Keys · j/k scroll · Esc close "
      titleColor={colors.accent}
      backgroundColor="#16181d"
      paddingLeft={1}
      paddingRight={1}
    >
      <scrollbox ref={props.ref} flexGrow={1} focusable={false}>
        <For each={SECTIONS}>
          {(section) => (
            <box flexDirection="column" marginBottom={1} flexShrink={0}>
              <text fg={colors.accent}>{section.title}</text>
              <For each={section.rows}>
                {(row) => (
                  <text wrapMode="none">
                    <span style={{ fg: colors.code }}>{row.keys.padEnd(KEY_WIDTH)}</span>
                    <span style={{ fg: colors.fg }}>{row.description}</span>
                  </text>
                )}
              </For>
            </box>
          )}
        </For>
      </scrollbox>
    </box>
  );
}
