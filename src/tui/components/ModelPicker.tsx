/**
 * `:m` model picker: the server's provider instances (enabled, installed,
 * available) and their models, grouped by provider. The current selection
 * is marked `●`, the server's default for new threads `default`.
 */
import type { InputRenderable } from "@opentui/core";
import type { ModelSelection } from "@t3tools/contracts";
import type { Accessor } from "solid-js";

import type { ModelCatalog } from "../backend.ts";
import { fuzzyMatch } from "../fuzzy.ts";
import { fit, highlight, type PickerRow, type Segment } from "../picker.ts";
import { colors } from "../theme.ts";
import { Picker } from "./Picker.tsx";

export interface ModelChoice {
  readonly instanceId: ModelSelection["instanceId"];
  readonly model: string;
  readonly label: string;
}

export interface ModelRows {
  readonly rows: ReadonlyArray<PickerRow<ModelChoice>>;
  /** Selectable index to start on: the best match, else the current model. */
  readonly initial: number;
}

const sameModel = (a: ModelSelection | null | undefined, instanceId: string, model: string) =>
  a != null && a.instanceId === instanceId && a.model === model;

export function buildModelRows(
  catalog: ModelCatalog,
  options: {
    readonly query: string;
    readonly current: ModelSelection | null;
    readonly width: number;
  },
): ModelRows {
  const query = options.query.trim();
  const nameWidth = Math.max(12, Math.min(40, Math.floor(options.width * 0.45)));
  const rows: PickerRow<ModelChoice>[] = [];
  let selectable = 0;
  let initial = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const provider of catalog.providers) {
    const items: PickerRow<ModelChoice>[] = [];
    for (const model of provider.models) {
      const match = fuzzyMatch(query, `${model.name} ${model.slug} ${provider.name}`);
      if (match === null) continue;
      const index = selectable + items.length;
      const current = sameModel(options.current, provider.instanceId, model.slug);
      if (query !== "" && match.score > bestScore) {
        bestScore = match.score;
        initial = index;
      } else if (query === "" && current) {
        initial = index;
      }
      const isServerDefault = sameModel(
        catalog.defaultModelSelection,
        provider.instanceId,
        model.slug,
      );
      const shown = model.name.length > nameWidth ? nameWidth - 1 : model.name.length;
      const segments: Segment[] = [
        { text: current ? "● " : "  ", fg: colors.ok },
        ...highlight(
          fit(model.name, nameWidth),
          match.positions.filter((position) => position < shown),
          current ? colors.user : colors.fg,
          colors.match,
        ),
        { text: ` ${model.slug}`, fg: colors.dim },
        ...(isServerDefault ? [{ text: "  default", fg: colors.faint }] : []),
      ];
      items.push({
        key: `${provider.instanceId}/${model.slug}`,
        kind: "item",
        segments,
        value: {
          instanceId: provider.instanceId,
          model: model.slug,
          label: `${model.name} (${provider.instanceId})`,
        },
      });
    }
    if (items.length === 0) continue;
    rows.push({
      key: `provider:${provider.instanceId}`,
      kind: "header",
      segments: [{ text: provider.name }, { text: `  ${provider.instanceId}`, fg: colors.faint }],
    });
    rows.push(...items);
    selectable += items.length;
  }
  return { rows, initial: Math.max(0, initial) };
}

export function ModelPicker(props: {
  readonly title: Accessor<string>;
  readonly rows: Accessor<ReadonlyArray<PickerRow>>;
  readonly cursorRow: Accessor<number>;
  readonly loading: Accessor<boolean>;
  readonly initialFilter: string;
  readonly onFilter: (value: string) => void;
  readonly inputRef: (element: InputRenderable) => void;
  readonly width: Accessor<number>;
  readonly height: Accessor<number>;
}) {
  return (
    <Picker
      title={props.title}
      rows={props.rows}
      cursorRow={props.cursorRow}
      empty={() => (props.loading() ? " loading models…" : " no matching models")}
      width={props.width}
      height={props.height}
      filter={{ ref: props.inputRef, onInput: props.onFilter, initial: props.initialFilter }}
    />
  );
}
