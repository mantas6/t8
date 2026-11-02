/**
 * `:servers`: the saved server profiles (`config.json`). The one in use is
 * marked `●`, the default `*`; Enter switches to the selected one.
 */
import type { Accessor } from "solid-js";

import { describeExpiry, type ProfileEntry } from "../../connect.ts";
import { fit, type PickerRow } from "../picker.ts";
import { colors } from "../theme.ts";
import { Picker } from "./Picker.tsx";

export function buildServerRows(
  entries: ReadonlyArray<ProfileEntry>,
  options: { readonly current: string | null; readonly width: number; readonly now: number },
): ReadonlyArray<PickerRow<ProfileEntry>> {
  const nameWidth = Math.min(20, Math.max(4, ...entries.map((entry) => entry.name.length)));
  const labelWidth = Math.min(
    16,
    Math.max(1, ...entries.map((e) => (e.profile.label ?? "").length)),
  );
  return entries.map((entry) => {
    const current = entry.name === options.current;
    const expiry = describeExpiry(entry.profile.expiresAt, options.now);
    const server = entry.profile.server ?? "(default server)";
    const used = 4 + nameWidth + 1 + labelWidth + 1 + expiry.length + 1;
    return {
      key: entry.name,
      kind: "item" as const,
      value: entry,
      segments: [
        { text: current ? "● " : "  ", fg: colors.ok },
        { text: entry.isDefault ? "* " : "  ", fg: colors.accent },
        { text: fit(entry.name, nameWidth), fg: current ? colors.user : colors.fg },
        { text: ` ${fit(entry.profile.label ?? "", labelWidth)}`, fg: colors.accent },
        { text: ` ${fit(server, Math.max(8, options.width - used))}`, fg: colors.dim },
        { text: ` ${expiry}`, fg: entry.expired ? colors.error : colors.faint },
      ],
    };
  });
}

export function ServerPicker(props: {
  readonly rows: Accessor<ReadonlyArray<PickerRow>>;
  readonly cursorRow: Accessor<number>;
  readonly loading: Accessor<boolean>;
  readonly width: Accessor<number>;
  readonly height: Accessor<number>;
}) {
  return (
    <Picker
      title={() => "Servers"}
      rows={props.rows}
      cursorRow={props.cursorRow}
      empty={() =>
        props.loading() ? " loading…" : " no saved servers: :connect <pairing link> adds one"
      }
      width={props.width}
      height={props.height}
    />
  );
}
