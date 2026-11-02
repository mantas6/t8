/**
 * The message input: a multi-line `<textarea>`. Keys it should not see
 * (Enter, Esc, Ctrl-S, scrolling) are intercepted by the global key handler
 * first; everything else is ordinary editing. It stays mounted while hidden
 * (e.g. behind an approval prompt) so the draft survives.
 */
import type { TextareaRenderable } from "@opentui/core";
import type { Accessor } from "solid-js";

import { colors } from "../theme.ts";

export function Composer(props: {
  visible: Accessor<boolean>;
  focused: Accessor<boolean>;
  ref: (element: TextareaRenderable) => void;
}) {
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      visible={props.visible()}
      border={["top"]}
      borderColor={props.focused() ? colors.modeInsert : colors.faint}
    >
      <text fg={props.focused() ? colors.modeInsert : colors.faint} flexShrink={0}>
        {"› "}
      </text>
      <textarea
        ref={props.ref}
        flexGrow={1}
        minHeight={1}
        maxHeight={10}
        wrapMode="word"
        focused={props.focused()}
        textColor={colors.fg}
        focusedTextColor={colors.fg}
        placeholder="press i to write a message"
        placeholderColor={colors.faint}
      />
    </box>
  );
}
