/**
 * The generic picker modal every overlay list uses: a centered box over the
 * transcript (which keeps streaming underneath) with an optional filter input
 * on top and a windowed list of rows below. It only renders; the cursor,
 * filter and keys live in `App.tsx`.
 */
import { type InputRenderable, TextAttributes } from "@opentui/core";
import { type Accessor, createMemo, For, Show } from "solid-js";

import type { PickerRow } from "../picker.ts";
import { windowStart } from "../picker.ts";
import { colors } from "../theme.ts";

export interface PickerProps {
  readonly title: Accessor<string>;
  readonly rows: Accessor<ReadonlyArray<PickerRow>>;
  /** Index into `rows` of the selected row; -1 for none. */
  readonly cursorRow: Accessor<number>;
  /** Shown when there are no rows. */
  readonly empty: Accessor<string>;
  /** Terminal size. */
  readonly width: Accessor<number>;
  readonly height: Accessor<number>;
  /** A filter input on top; typing filters. */
  readonly filter?: {
    readonly ref: (element: InputRenderable) => void;
    readonly onInput: (value: string) => void;
    readonly initial: string;
    readonly placeholder?: string;
  };
  /** One dim line under the list (e.g. "narrowed to project x"). */
  readonly footer?: Accessor<string | null>;
}

const MAX_WIDTH = 110;

export function Picker(props: PickerProps) {
  const boxWidth = () => Math.max(20, Math.min(MAX_WIDTH, props.width() - 4));
  const innerWidth = () => boxWidth() - 4;
  const chrome = () => 2 + (props.filter === undefined ? 0 : 2) + (props.footer?.() ? 1 : 0);
  const maxList = () => Math.max(3, props.height() - 4 - chrome());
  const listHeight = () => Math.max(1, Math.min(maxList(), props.rows().length));
  const boxHeight = () => listHeight() + chrome();
  let start = 0;
  const first = createMemo(() => {
    start = windowStart(start, Math.max(0, props.cursorRow()), props.rows().length, listHeight());
    return start;
  });
  const visible = createMemo(() =>
    props
      .rows()
      .slice(first(), first() + listHeight())
      .map((row, offset) => ({ row, index: first() + offset })),
  );
  const pad = (row: PickerRow) => {
    const used = row.segments.reduce((sum, segment) => sum + segment.text.length, 0);
    return " ".repeat(Math.max(0, innerWidth() - used));
  };

  return (
    <box
      position="absolute"
      top={Math.max(1, Math.floor((props.height() - boxHeight()) / 2))}
      left={Math.max(0, Math.floor((props.width() - boxWidth()) / 2))}
      width={boxWidth()}
      height={boxHeight()}
      zIndex={20}
      border
      borderStyle="rounded"
      borderColor={colors.accent}
      title={` ${props.title()} `}
      titleColor={colors.accent}
      backgroundColor={colors.overlayBg}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
    >
      <Show when={props.filter}>
        {(filter: Accessor<NonNullable<PickerProps["filter"]>>) => (
          <>
            <box flexDirection="row" height={1} flexShrink={0}>
              <text fg={colors.accent} flexShrink={0}>
                {"> "}
              </text>
              <input
                ref={filter().ref}
                flexGrow={1}
                focused
                value={filter().initial}
                placeholder={filter().placeholder ?? "type to filter"}
                textColor={colors.fg}
                focusedTextColor={colors.fg}
                backgroundColor={colors.overlayBg}
                focusedBackgroundColor={colors.overlayBg}
                onInput={(value: string) => filter().onInput(value)}
              />
            </box>
            <text fg={colors.faint} flexShrink={0} wrapMode="none">
              {"─".repeat(innerWidth())}
            </text>
          </>
        )}
      </Show>
      <Show
        when={props.rows().length > 0}
        fallback={
          <text fg={colors.dim} wrapMode="none">
            {props.empty()}
          </text>
        }
      >
        <box flexDirection="column" height={listHeight()} flexShrink={0}>
          <For each={visible()}>
            {(entry) => {
              const selected = () => entry.index === props.cursorRow();
              const bg = () => (selected() ? colors.focusBg : undefined);
              return (
                <text wrapMode="none" height={1}>
                  <For each={entry.row.segments}>
                    {(segment) => (
                      <span
                        style={{
                          fg:
                            segment.fg ?? (entry.row.kind === "header" ? colors.accent : colors.fg),
                          bg: bg(),
                          attributes:
                            segment.bold === true || entry.row.kind === "header"
                              ? TextAttributes.BOLD
                              : 0,
                        }}
                      >
                        {segment.text}
                      </span>
                    )}
                  </For>
                  <span style={{ bg: bg() }}>{pad(entry.row)}</span>
                </text>
              );
            }}
          </For>
        </box>
      </Show>
      <Show when={props.footer?.()}>
        {(footer: Accessor<string>) => (
          <text fg={colors.dim} wrapMode="none" flexShrink={0}>
            {footer()}
          </text>
        )}
      </Show>
    </box>
  );
}
