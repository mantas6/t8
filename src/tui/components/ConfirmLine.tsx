/** A y/n question in the bottom line (replaces the hint line while it is open). */
import type { Accessor } from "solid-js";

import { colors } from "../theme.ts";

export function ConfirmLine(props: { readonly message: Accessor<string> }) {
  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <text fg={colors.warn} wrapMode="none" flexShrink={0}>
        {` ${props.message()} `}
      </text>
      <text fg={colors.dim} wrapMode="none">
        [y/n]
      </text>
    </box>
  );
}
