/**
 * The transcript: a `<scrollbox>` with one row per display item.
 *
 * - Rows are keyed by item id (a `<For>` over the id strings), so an update
 *   to one item touches only its row, and a streaming message keeps its
 *   `<markdown>` node.
 * - Tail-follow: OpenTUI's sticky scroll keeps the view at the bottom while
 *   content grows, but only while the offset is at the bottom. The `follow`
 *   signal mirrors that for the UI and the controller: user scrolls set it
 *   from the position afterwards, and `G` (or sending) jumps to the end and
 *   turns it back on.
 * - The controller exposes scrolling, revealing an item, and the range of
 *   items in view, for the key dispatcher.
 */
import type { ScrollBoxRenderable } from "@opentui/core";
import { type Accessor, createEffect, createMemo, For, onCleanup, Show } from "solid-js";

import type { DisplayItem } from "../../state/types.ts";
import { isMessage } from "../nav.ts";
import { colors } from "../theme.ts";
import type { UiState } from "../view.ts";
import { type RowContext, TranscriptItem } from "./TranscriptItem.tsx";

export interface TranscriptController {
  /** Scrolls by lines (positive is down). */
  scrollLines(lines: number): void;
  /** Scrolls by viewport heights (0.5 is half a page). */
  scrollPages(pages: number): void;
  toTop(): void;
  /** Jumps to the end and turns tail-follow on. */
  toBottom(): void;
  /** Scrolls an item into view. */
  reveal(id: string, align: "start" | "nearest"): void;
  /** Indexes (into `items`) of the first and last item at least partly in view. */
  visibleRange(): { readonly first: number; readonly last: number } | null;
}

export const rowId = (itemId: string) => `item:${itemId}`;

export function Transcript(props: {
  items: Accessor<ReadonlyArray<DisplayItem>>;
  hasMoreHistory: Accessor<boolean>;
  ui: UiState;
  ctx: RowContext;
  controller: (controller: TranscriptController) => void;
}) {
  let scroll: ScrollBoxRenderable | undefined;
  const live = () => scroll !== undefined && !scroll.isDestroyed;

  const ids = createMemo(() => props.items().map((item) => item.id));
  const byId = createMemo(() => {
    const map = new Map<string, { item: DisplayItem; gap: number }>();
    let previous: DisplayItem | undefined;
    for (const item of props.items()) {
      // Messages get a blank line above; runs of tool calls and notices stay compact.
      const gap = previous === undefined ? 0 : isMessage(item) || isMessage(previous) ? 1 : 0;
      map.set(item.id, { item, gap });
      previous = item;
    }
    return map;
  });

  const atBottom = () => {
    if (!live() || scroll === undefined) return true;
    const max = Math.max(0, scroll.scrollHeight - scroll.viewport.height);
    return scroll.scrollTop >= max - 1;
  };
  const syncFollow = () => props.ui.setFollow(atBottom());
  const syncFollowAfterLayout = () => {
    if (!live() || scroll === undefined) return;
    const box = scroll;
    box.afterLayout(() => {
      if (!box.isDestroyed) syncFollow();
    });
  };

  createEffect(() => {
    const follow = props.ui.follow();
    if (live() && scroll !== undefined) scroll.stickyScroll = follow;
  });

  const controller: TranscriptController = {
    scrollLines(lines) {
      if (!live() || scroll === undefined) return;
      scroll.scrollBy(lines);
      syncFollow();
    },
    scrollPages(pages) {
      if (!live() || scroll === undefined) return;
      scroll.scrollBy(pages, "viewport");
      syncFollow();
    },
    toTop() {
      if (!live() || scroll === undefined) return;
      props.ui.setFollow(false);
      scroll.scrollTo(0);
      syncFollowAfterLayout();
    },
    toBottom() {
      props.ui.setFollow(true);
      if (!live() || scroll === undefined) return;
      scroll.stickyScroll = true;
      scroll.scrollTo(Number.POSITIVE_INFINITY);
    },
    reveal(id, align) {
      if (!live() || scroll === undefined) return;
      props.ui.setFollow(false);
      scroll.scrollChildIntoView(rowId(id), { align });
      syncFollowAfterLayout();
    },
    visibleRange() {
      if (!live() || scroll === undefined) return null;
      const top = scroll.viewport.y;
      const bottom = top + scroll.viewport.height;
      let first = -1;
      let last = -1;
      const list = ids();
      for (let index = 0; index < list.length; index++) {
        const id = list[index];
        const node = id === undefined ? undefined : scroll.getRenderable(rowId(id));
        if (node === undefined) continue;
        if (node.y + node.height > top && node.y < bottom) {
          if (first === -1) first = index;
          last = index;
        } else if (first !== -1) {
          break;
        }
      }
      return first === -1 ? null : { first, last };
    },
  };
  props.controller(controller);
  onCleanup(() => {
    scroll = undefined;
  });

  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <scrollbox
        ref={(element: ScrollBoxRenderable) => {
          scroll = element;
        }}
        flexGrow={1}
        focusable={false}
        stickyScroll
        stickyStart="bottom"
        viewportOptions={{ paddingLeft: 1, paddingRight: 1 }}
        verticalScrollbarOptions={{
          trackOptions: { backgroundColor: "transparent", foregroundColor: colors.faint },
        }}
        onMouseScroll={() => syncFollowAfterLayout()}
      >
        <Show when={props.hasMoreHistory()}>
          <text fg={colors.faint}>… older history not loaded</text>
        </Show>
        <For each={ids()}>
          {(id) => {
            // Memos compare by identity: unchanged items keep their display object.
            const item = createMemo(() => byId().get(id)?.item);
            const gap = createMemo(() => byId().get(id)?.gap ?? 0);
            const focused = () => props.ui.focusedId() === id;
            return (
              <box
                id={rowId(id)}
                flexDirection="column"
                flexShrink={0}
                marginTop={gap()}
                backgroundColor={focused() ? colors.focusBg : "transparent"}
              >
                <Show when={item()}>
                  {(value: Accessor<DisplayItem>) => (
                    <TranscriptItem item={value()} ctx={props.ctx} />
                  )}
                </Show>
              </box>
            );
          }}
        </For>
      </scrollbox>
    </box>
  );
}
