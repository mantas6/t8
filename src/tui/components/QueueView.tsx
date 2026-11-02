/**
 * `:queue`: the open thread's queued messages in run order, from the thread
 * store's `queue()`. `dd` cancels one (after a confirm), `J`/`K` reorder
 * (`queued-run.reorder`).
 */
import type { Accessor } from "solid-js";

import type { QueuedRun } from "../../state/types.ts";
import { oneLine } from "../nav.ts";
import { fit, type PickerRow } from "../picker.ts";
import { colors } from "../theme.ts";
import { Picker } from "./Picker.tsx";

export function buildQueueRows(
  queue: ReadonlyArray<QueuedRun>,
  width: number,
): ReadonlyArray<PickerRow<QueuedRun>> {
  const digits = Math.max(1, String(queue.length).length);
  return queue.map((run, index) => ({
    key: run.runId,
    kind: "item" as const,
    value: run,
    segments: [
      { text: `${String(index + 1).padStart(digits)} `, fg: colors.faint },
      ...(run.held ? [{ text: "held ", fg: colors.warn }] : []),
      {
        text: fit(
          oneLine(run.text ?? "(message not loaded)"),
          width - digits - 1 - (run.held ? 5 : 0),
        ),
        fg: run.text === null ? colors.dim : colors.fg,
      },
    ],
  }));
}

export function QueueView(props: {
  readonly rows: Accessor<ReadonlyArray<PickerRow>>;
  readonly cursorRow: Accessor<number>;
  readonly width: Accessor<number>;
  readonly height: Accessor<number>;
}) {
  return (
    <Picker
      title={() => "Queue"}
      rows={props.rows}
      cursorRow={props.cursorRow}
      empty={() => " nothing queued"}
      width={props.width}
      height={props.height}
      footer={() => (props.rows().length > 0 ? "runs top to bottom after the active run" : null)}
    />
  );
}
