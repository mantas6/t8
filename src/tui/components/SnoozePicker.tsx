/**
 * The snooze preset picker (`:snooze` without a time, `dz` in the thread
 * picker): upstream's presets with their wake times, then "custom…", which
 * asks for a `<when>` (`when.ts`).
 */
import type { Accessor } from "solid-js";

import { fit, type PickerRow } from "../picker.ts";
import { colors } from "../theme.ts";
import { formatWake, type SnoozePreset } from "../when.ts";
import { Picker } from "./Picker.tsx";

/** A preset's wake time, or `custom` for the row that asks for one. */
export type SnoozeChoice =
  | { readonly kind: "preset"; readonly until: Date }
  | { readonly kind: "custom" };

export function buildSnoozeRows(
  presets: ReadonlyArray<SnoozePreset>,
  now: Date,
): ReadonlyArray<PickerRow<SnoozeChoice>> {
  const rows: PickerRow<SnoozeChoice>[] = presets.map((preset) => ({
    key: preset.id,
    kind: "item" as const,
    value: { kind: "preset" as const, until: preset.until },
    segments: [
      { text: ` ${fit(preset.label, 18)}`, fg: colors.fg },
      { text: ` ${formatWake(preset.until, now)}`, fg: colors.dim },
    ],
  }));
  rows.push({
    key: "custom",
    kind: "item",
    value: { kind: "custom" },
    segments: [
      { text: ` ${fit("custom…", 18)}`, fg: colors.fg },
      { text: " 30m 2h 3d 1w · 18:00 · tomorrow · mon..sun · ISO", fg: colors.dim },
    ],
  });
  return rows;
}

export function SnoozePicker(props: {
  readonly title: Accessor<string>;
  readonly rows: Accessor<ReadonlyArray<PickerRow>>;
  readonly cursorRow: Accessor<number>;
  readonly width: Accessor<number>;
  readonly height: Accessor<number>;
}) {
  return (
    <Picker
      title={props.title}
      rows={props.rows}
      cursorRow={props.cursorRow}
      empty={() => " no presets"}
      width={props.width}
      height={props.height}
    />
  );
}
