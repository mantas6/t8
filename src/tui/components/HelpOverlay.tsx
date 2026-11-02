/**
 * `?` help: every keymap layer and the commands as a cheat sheet, with a
 * filter line on top. Typing filters (fuzzy, on key, action and
 * description); j/k scroll while the filter is empty, Esc clears it, then
 * closes. Keys are handled in `App.tsx` (`helpKey`).
 */
import type { ScrollBoxRenderable } from "@opentui/core";
import { type Accessor, For, Show } from "solid-js";

import type { HelpSection } from "../help.ts";
import { fit } from "../picker.ts";
import { colors } from "../theme.ts";

const ACTION_WIDTH = 24;

export function HelpOverlay(props: {
  readonly ref: (element: ScrollBoxRenderable) => void;
  readonly sections: Accessor<ReadonlyArray<HelpSection>>;
  readonly filter: Accessor<string>;
  readonly focused: Accessor<boolean>;
  /** Width of the key column (kept while filtering, so rows do not jump). */
  readonly keyWidth: number;
}) {
  const title = () =>
    props.focused() || props.filter() !== ""
      ? " Keys · type to filter · ↑↓ scroll · Esc clear "
      : " Keys · type or / to filter · j/k scroll · Esc close ";
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
      title={title()}
      titleColor={colors.accent}
      backgroundColor={colors.overlayBg}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
    >
      <text wrapMode="none" flexShrink={0}>
        <span style={{ fg: colors.accent }}>{"> "}</span>
        <Show
          when={props.filter() !== "" || props.focused()}
          fallback={<span style={{ fg: colors.faint }}>type to filter</span>}
        >
          <span style={{ fg: colors.fg }}>{props.filter()}</span>
          <span style={{ fg: colors.accent }}>{props.focused() ? "▏" : ""}</span>
        </Show>
      </text>
      <scrollbox ref={props.ref} flexGrow={1} focusable={false}>
        <Show
          when={props.sections().length > 0}
          fallback={<text fg={colors.dim}>{`no keys or commands match "${props.filter()}"`}</text>}
        >
          <For each={props.sections()}>
            {(section) => (
              <box flexDirection="column" marginBottom={1} flexShrink={0}>
                <text fg={colors.accent}>{section.title}</text>
                <For each={section.rows}>
                  {(row) => (
                    <text wrapMode="none">
                      <span
                        style={{ fg: colors.code }}
                      >{`${fit(row.keys, props.keyWidth - 1)} `}</span>
                      <span style={{ fg: colors.faint }}>
                        {`${fit(row.action, ACTION_WIDTH - 1)} `}
                      </span>
                      <span style={{ fg: colors.fg }}>{row.description}</span>
                    </text>
                  )}
                </For>
              </box>
            )}
          </For>
        </Show>
      </scrollbox>
    </box>
  );
}
