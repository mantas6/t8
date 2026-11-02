/**
 * `:mode` runtime mode picker: the contract's `RuntimeMode` values with
 * upstream's labels. The current mode is marked `●`; modes the thread's
 * provider does not list are shown dim.
 */
import { RuntimeMode } from "@t3tools/contracts";
import type { Accessor } from "solid-js";

import { fit, type PickerRow } from "../picker.ts";
import { colors } from "../theme.ts";
import { Picker } from "./Picker.tsx";

/** Same wording as upstream's web app. */
export const RUNTIME_MODE_LABELS: Readonly<
  Record<RuntimeMode, { readonly label: string; readonly description: string }>
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
};

export const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = RuntimeMode.literals;

export function buildModeRows(options: {
  readonly current: RuntimeMode | null;
  /** Null when the provider does not restrict modes. */
  readonly supported: ReadonlyArray<RuntimeMode> | null;
}): ReadonlyArray<PickerRow<RuntimeMode>> {
  return RUNTIME_MODES.map((mode) => {
    const current = mode === options.current;
    const supported = options.supported === null || options.supported.includes(mode);
    const info = RUNTIME_MODE_LABELS[mode];
    return {
      key: mode,
      kind: "item" as const,
      value: mode,
      segments: [
        { text: current ? "● " : "  ", fg: colors.ok },
        { text: fit(mode, 19), fg: supported ? (current ? colors.user : colors.fg) : colors.faint },
        { text: ` ${fit(info.label, 18)}`, fg: supported ? colors.accent : colors.faint },
        {
          text: ` ${info.description}${supported ? "" : " (not supported by this provider)"}`,
          fg: colors.dim,
        },
      ],
    };
  });
}

export function ModePicker(props: {
  readonly rows: Accessor<ReadonlyArray<PickerRow>>;
  readonly cursorRow: Accessor<number>;
  readonly width: Accessor<number>;
  readonly height: Accessor<number>;
}) {
  return (
    <Picker
      title={() => "Runtime mode"}
      rows={props.rows}
      cursorRow={props.cursorRow}
      empty={() => " no modes"}
      width={props.width}
      height={props.height}
    />
  );
}
