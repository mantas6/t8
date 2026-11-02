/**
 * UI state that is not server state: the input mode, which surface has the
 * keyboard (`view`), transcript cursor/fold/follow state, the status-line
 * notice and the pending key sequence. Plain Solid signals and a store; the
 * components and the key dispatcher in `App.tsx` read and write them.
 */
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

export type Mode = "normal" | "insert" | "command" | "picker";

/**
 * What has the keyboard: the transcript (with the message input), a line at
 * the bottom (`:` command, `/` search, or a text `input` such as a new
 * thread's title), the help overlay, or one of the picker overlays.
 */
export type View =
  | "transcript"
  | "command"
  | "search"
  | "input"
  | "help"
  | "threads"
  | "projects"
  | "models"
  | "modes"
  | "queue";

export type PickerView = Extract<View, "threads" | "projects" | "models" | "modes" | "queue">;

export const PICKER_VIEWS: ReadonlySet<View> = new Set<View>([
  "threads",
  "projects",
  "models",
  "modes",
  "queue",
]);

export const isPickerView = (view: View): view is PickerView => PICKER_VIEWS.has(view);

/** A y/n question in the bottom line; it takes the keyboard over whatever view is open. */
export interface Confirm {
  readonly message: string;
  readonly onYes: () => void;
}

export type NoticeLevel = "info" | "warn" | "error";

export interface Notice {
  readonly text: string;
  readonly level: NoticeLevel;
}

export const NOTICE_MS = 3_000;

export function createUiState() {
  const [mode, setMode] = createSignal<Mode>("normal");
  const [view, setView] = createSignal<View>("transcript");
  const [confirm, setConfirm] = createSignal<Confirm | null>(null);
  const [notice, setNoticeSignal] = createSignal<Notice | null>(null);
  /** Keep the transcript pinned to the tail. Off after scrolling up, on again at the bottom. */
  const [follow, setFollow] = createSignal(true);
  /** The transcript item `]]`, `]t`, search and `y` act on. */
  const [focusedId, setFocusedId] = createSignal<string | null>(null);
  const [searchQuery, setSearchQuery] = createSignal("");
  /** A pending runtime request has the keyboard (y/n/1-9). */
  const [promptFocused, setPromptFocused] = createSignal(true);
  /** Pending count/prefix keys, shown in the status line. */
  const [pendingKeys, setPendingKeys] = createSignal("");
  const [folds, setFolds] = createStore<{
    /** Whether foldable items start expanded (`zR`) or folded (`zM`, the default). */
    openByDefault: boolean;
    overrides: Record<string, boolean>;
  }>({ openByDefault: false, overrides: {} });

  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const setNotice = (text: string, level: NoticeLevel = "info", ms = NOTICE_MS) => {
    if (noticeTimer !== undefined) clearTimeout(noticeTimer);
    setNoticeSignal({ text, level });
    noticeTimer = setTimeout(() => {
      noticeTimer = undefined;
      setNoticeSignal(null);
    }, ms);
  };

  const isOpen = (id: string): boolean => folds.overrides[id] ?? folds.openByDefault;
  const toggleFold = (id: string) => setFolds("overrides", id, !isOpen(id));
  const foldAll = (open: boolean) => setFolds({ openByDefault: open, overrides: {} });

  return {
    mode,
    setMode,
    view,
    setView,
    confirm,
    setConfirm,
    notice,
    setNotice,
    clearNotice: () => setNoticeSignal(null),
    follow,
    setFollow,
    focusedId,
    setFocusedId,
    searchQuery,
    setSearchQuery,
    promptFocused,
    setPromptFocused,
    pendingKeys,
    setPendingKeys,
    isOpen,
    toggleFold,
    foldAll,
    dispose: () => {
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
    },
  };
}

export type UiState = ReturnType<typeof createUiState>;
