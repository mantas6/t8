/**
 * `:p` project switcher (and the first step of `:n`): projects by last
 * activity with their thread count and workspace path. Typing filters
 * fuzzily on the title and path, best match first.
 */
import type { InputRenderable } from "@opentui/core";
import type { Accessor } from "solid-js";

import type { ProjectGroup } from "../../state/types.ts";
import { fuzzyFilter } from "../fuzzy.ts";
import { fit, highlight, type PickerRow, relativeTime } from "../picker.ts";
import { colors } from "../theme.ts";
import { Picker } from "./Picker.tsx";

export interface ProjectRowsOptions {
  readonly query: string;
  readonly now: number;
  readonly width: number;
  /** Shortens paths for display, e.g. the home directory to `~`. */
  readonly displayPath?: (path: string) => string;
}

const COUNT_WIDTH = 4;
const TIME_WIDTH = 4;

export function buildProjectRows(
  groups: ReadonlyArray<ProjectGroup>,
  options: ProjectRowsOptions,
): ReadonlyArray<PickerRow<ProjectGroup>> {
  const show = options.displayPath ?? ((path: string) => path);
  const titleWidth = Math.max(10, Math.min(28, Math.floor(options.width * 0.35)));
  const pathWidth = Math.max(8, options.width - titleWidth - 1 - COUNT_WIDTH - 1 - TIME_WIDTH - 1);
  return fuzzyFilter(groups, options.query, (group) => {
    const root = group.project?.workspaceRoot ?? "";
    return `${group.title} ${show(root)}`;
  }).map(({ item: group, match }) => {
    const shown = group.title.length > titleWidth ? titleWidth - 1 : group.title.length;
    const count = group.threads.filter((thread) => !thread.archived).length;
    return {
      key: group.projectId,
      kind: "item" as const,
      value: group,
      segments: [
        ...highlight(
          fit(group.title, titleWidth),
          match.positions.filter((position) => position < shown),
          colors.fg,
          colors.match,
        ),
        { text: ` ${fit(show(group.project?.workspaceRoot ?? ""), pathWidth)}`, fg: colors.dim },
        { text: ` ${String(count).padStart(COUNT_WIDTH)}`, fg: colors.faint },
        {
          text: ` ${relativeTime(group.lastActivityAt, options.now).padStart(TIME_WIDTH)}`,
          fg: colors.dim,
        },
      ],
    };
  });
}

export function ProjectPicker(props: {
  readonly title: Accessor<string>;
  readonly rows: Accessor<ReadonlyArray<PickerRow>>;
  readonly cursorRow: Accessor<number>;
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
      empty={() => " no matching projects"}
      width={props.width}
      height={props.height}
      filter={{ ref: props.inputRef, onInput: props.onFilter, initial: props.initialFilter }}
    />
  );
}
