/** The `:` command line / `/` search prompt, one row at the bottom. */
import type { InputRenderable } from "@opentui/core";
import type { Accessor } from "solid-js";

import { colors } from "../theme.ts";

export function PromptLine(props: {
  prefix: Accessor<string>;
  ref: (element: InputRenderable) => void;
}) {
  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <text fg={colors.modeCommand} flexShrink={0}>
        {props.prefix()}
      </text>
      <input
        ref={props.ref}
        flexGrow={1}
        focused
        textColor={colors.fg}
        focusedTextColor={colors.fg}
      />
    </box>
  );
}
