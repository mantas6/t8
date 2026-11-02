/**
 * The full-screen TUI: status line, transcript, and the input (or the
 * pending request prompt) with a hint line, plus the picker overlays (`:t`,
 * `:p`, `:m`, `:mode`, `:queue`, `:servers`) drawn over the transcript. All keys go
 * through one global handler that picks the keymap layer for the current
 * view (`keymap.ts`), runs it through the prefix/count state machine
 * (`keys.ts`) and dispatches actions.
 */
import type {
  InputRenderable,
  KeyEvent,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
  type CommandId,
  DEFAULT_RUNTIME_MODE,
  type MessageId,
  type ModelSelection,
  type ProjectId,
  type RunId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";

import { type DeliveryIntent, newCommandId, newMessageId } from "../commands.ts";
import type { ProfileEntry } from "../connect.ts";
import { canOperate } from "../pairing.ts";
import { selectProjectGroups } from "../state/selectors.ts";
import type {
  DisplayItem,
  PendingApproval,
  PendingOtherRequest,
  PendingUserInput,
  ProjectGroup,
  QueuedRun,
  ThreadSummary,
  ToolCallDisplayItem,
} from "../state/types.ts";
import { type Backend, describeError, type ModelCatalog, type ServerView } from "./backend.ts";
import { copyToClipboard } from "./clipboard.ts";
import {
  type Command,
  Completer,
  type CompletionSources,
  keepInHistory,
  LineHistory,
  parseCommandLine,
  quitBlocker,
  WRITE_MESSAGE,
} from "./cmdline.ts";
import { Composer } from "./components/Composer.tsx";
import { ConfirmLine } from "./components/ConfirmLine.tsx";
import { HelpOverlay } from "./components/HelpOverlay.tsx";
import { buildModelRows, type ModelChoice, ModelPicker } from "./components/ModelPicker.tsx";
import { buildModeRows, ModePicker } from "./components/ModePicker.tsx";
import { buildProjectRows, ProjectPicker } from "./components/ProjectPicker.tsx";
import { PromptLine } from "./components/PromptLine.tsx";
import { buildQueueRows, QueueView } from "./components/QueueView.tsx";
import {
  approveOptionIndex,
  denyOptionIndex,
  RequestPrompt,
  type UserInputProgress,
} from "./components/RequestPrompt.tsx";
import { buildServerRows, ServerPicker } from "./components/ServerPicker.tsx";
import { type StatusInfo, StatusLine } from "./components/StatusLine.tsx";
import { buildThreadRows, ThreadPicker, threadIndex } from "./components/ThreadPicker.tsx";
import { Transcript, type TranscriptController } from "./components/Transcript.tsx";
import type { RowContext, ToolResultState } from "./components/TranscriptItem.tsx";
import { fuzzyFilter } from "./fuzzy.ts";
import { type ActionId, type CompiledKeymaps, compileKeymaps, type Layer } from "./keymap.ts";
import { type Binding, KeySequencer, keyToken } from "./keys.ts";
import {
  findItem,
  findMatch,
  isFoldable,
  isMessage,
  isTool,
  itemText,
  matchesQuery,
  oneLine,
  stepThread,
} from "./nav.ts";
import {
  clampCursor,
  moveCursor,
  type PickerRow,
  reorderTarget,
  selectableIndices,
} from "./picker.ts";
import { colors, createSyntaxStyle, SPINNER_FRAMES } from "./theme.ts";
import {
  type Confirm,
  createUiState,
  isPickerView,
  type Mode,
  type PickerView,
  type View,
} from "./view.ts";

export const NO_THREAD_PLACEHOLDER = "No thread open. Press : then t to pick a thread";

const DOUBLE_CTRL_C_MS = 1_000;

/**
 * A new runtime request (or one whose options changed) ignores y/n/1-9 for
 * this long, so keys typed for something else do not answer it unseen.
 */
export const REQUEST_ARM_MS = 500;

export interface AppProps {
  readonly backend: Backend;
  readonly initialThreadId?: ThreadId | null;
  readonly onQuit: () => void;
  readonly keymaps?: CompiledKeymaps;
  /** Background problems (sync errors) to show in the status line; returns an unsubscribe. */
  readonly subscribeErrors?: (listener: (message: string) => void) => () => void;
  /** Overrides `REQUEST_ARM_MS` (tests). */
  readonly requestArmMs?: number;
}

type AnswerableRequest = PendingApproval | PendingUserInput;

interface InputProgressState extends UserInputProgress {
  readonly answers: Readonly<Record<string, unknown>>;
}

const EMPTY_PROGRESS: InputProgressState = { question: 0, selected: [], answers: {} };

/** A message draft and the ids it was first sent with, reused when it is resent. */
interface SendAttempt {
  readonly text: string;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
}

/**
 * How typed text can answer a user-input request: as the answer to the
 * current question (`answer`: free-text questions and custom answers), as a
 * normal message (`message`), or not at all.
 */
export function textAnswerMode(
  request: PendingApproval | PendingUserInput | undefined,
  questionIndex: number,
): "answer" | "message" | null {
  if (request?.type !== "user_input") return null;
  const question = request.questions[questionIndex];
  if (
    question !== undefined &&
    request.responseCapability !== "message" &&
    (question.options.length === 0 || question.allowCustomAnswer === true)
  ) {
    return "answer";
  }
  return request.answerableByMessage ? "message" : null;
}

/** Identity of what a request offers; a change re-arms the prompt. */
function requestKey(request: PendingApproval | PendingUserInput): string {
  const offered =
    request.type === "approval"
      ? request.options.map((option) => `${option.decision}:${option.label}`)
      : request.questions.map(
          (question) =>
            `${question.id}:${question.options.map((option) => option.label).join("/")}`,
        );
  return `${request.requestId}\n${offered.join("\n")}`;
}

/** Pickers with a filter input; the others (modes, queue) are plain lists. */
const FILTERED_PICKERS: ReadonlySet<View> = new Set<View>(["threads", "projects", "models"]);

const PICKER_HINTS: Readonly<Record<PickerView, string>> = {
  threads:
    "type to filter · ↑↓ C-n C-p (j k) move · Enter open · dd archive · C-a archived · Esc clear/close",
  projects: "type to filter · ↑↓ C-n C-p (j k) move · Enter choose · Esc clear/close",
  models: "type to filter · ↑↓ C-n C-p (j k) move · Enter choose · Esc clear/close",
  modes: "j k move · Enter set the mode · Esc close",
  queue: "j k move · dd cancel · J K reorder · Esc close",
  servers: "j k move · Enter switch to it · Esc close",
};

/** A text prompt in the bottom line (the `input` view), e.g. a new thread's title. */
interface InputPrompt {
  readonly prefix: string;
  readonly hint: string;
  readonly onSubmit: (text: string) => void;
}

/** A thread being created by `:n`, waiting for its project, title or model. */
interface NewThreadDraft {
  readonly projectId: ProjectId | null;
  readonly title: string | null;
}

/** How the status line names the server: profile (and label), else the environment or host. */
export function serverDisplayName(server: ServerView, environmentLabel: string | null): string {
  if (server.profile !== null) {
    return server.label !== null && server.label !== server.profile
      ? `${server.profile} (${server.label})`
      : server.profile;
  }
  if (environmentLabel !== null) return environmentLabel;
  return URL.parse(server.server)?.host ?? server.server;
}

const homeDirectory = process.env.HOME ?? "";
const displayPath = (path: string) =>
  homeDirectory !== "" && (path === homeDirectory || path.startsWith(`${homeDirectory}/`))
    ? `~${path.slice(homeDirectory.length)}`
    : path;

export function App(props: AppProps) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const ui = createUiState();
  const syntax = createSyntaxStyle(renderer.nativeScene);
  const keymaps = props.keymaps ?? compileKeymaps();
  const sequencer = new KeySequencer();
  const { backend } = props;
  const { shell, thread } = backend;

  let transcript: TranscriptController | undefined;
  let textarea: TextareaRenderable | undefined;
  let lineInput: InputRenderable | undefined;
  let filterInput: InputRenderable | undefined;
  let helpScroll: ScrollBoxRenderable | undefined;
  let sequenceTimer: ReturnType<typeof setTimeout> | undefined;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCtrlC = 0;

  const unsubscribeErrors = props.subscribeErrors?.((message) =>
    ui.setNotice(message, "error", 6_000),
  );
  onCleanup(() => {
    unsubscribeErrors?.();
    ui.dispose();
    if (sequenceTimer !== undefined) clearTimeout(sequenceTimer);
    if (armTimer !== undefined) clearTimeout(armTimer);
  });

  // -------------------------------------------------------------------------
  // Derived state

  const threadId = () => thread.state.threadId;
  const items = thread.transcript;
  const summary = () => {
    const id = threadId();
    return id === null ? undefined : shell.thread(id);
  };
  const answerable = createMemo((): AnswerableRequest | undefined =>
    thread
      .pendingRequests()
      .find((request): request is AnswerableRequest => request.type !== "other"),
  );
  const otherRequest = createMemo(() =>
    thread.pendingRequests().find((request) => request.type === "other"),
  );
  const promptShown = () => answerable() !== undefined;
  const promptActive = () => promptShown() && ui.promptFocused() && ui.view() === "transcript";
  const lineKind = () => {
    const view = ui.view();
    return view === "command" || view === "search" || view === "input" ? view : null;
  };
  const mode = (): Mode => {
    if (isPickerView(ui.view())) return "picker";
    return lineKind() !== null ? "command" : ui.mode();
  };

  const [progress, setProgress] = createSignal<InputProgressState>(EMPTY_PROGRESS);
  /** Typed text can answer the current request (see `textAnswerMode`). */
  const textMode = () => textAnswerMode(answerable(), progress().question);
  createEffect(
    on(
      () => answerable()?.requestId,
      (id, previous) => {
        if (id === undefined || id === previous) return;
        setProgress(EMPTY_PROGRESS);
        if (ui.mode() === "insert" && (textarea?.plainText ?? "").trim() !== "") {
          // Mid-sentence: keep typing; the request shows, unfocused.
          ui.setPromptFocused(false);
          const what = answerable()?.type === "approval" ? "approval needed" : "input requested";
          notice(`${what} · Esc, then Enter to answer`, "warn", 6_000);
          return;
        }
        // A new request takes the keyboard; the draft stays in the hidden input.
        ui.setPromptFocused(true);
        if (ui.mode() === "insert") ui.setMode("normal");
      },
    ),
  );

  // y/n/1-9 only act once the request has been on screen, unchanged, for a moment.
  const [armed, setArmed] = createSignal(false);
  createEffect(
    on(
      () => {
        const request = answerable();
        return request === undefined ? null : requestKey(request);
      },
      (key) => {
        if (armTimer !== undefined) clearTimeout(armTimer);
        armTimer = undefined;
        setArmed(false);
        if (key === null) return;
        armTimer = setTimeout(() => {
          armTimer = undefined;
          setArmed(true);
        }, props.requestArmMs ?? REQUEST_ARM_MS);
      },
    ),
  );
  /** Request ids answered or being answered: a second answer is not sent. */
  const answered = new Set<string>();

  // Spinner frames only tick while something is running.
  const [tick, setTick] = createSignal(0);
  const busy = createMemo(
    () =>
      thread.activeRun() !== null ||
      items().some(
        (item) =>
          item.status === "running" ||
          ((item.kind === "reasoning" || item.kind === "assistant_message") && item.streaming),
      ),
  );
  createEffect(() => {
    if (!busy()) return;
    const timer = setInterval(() => setTick((n) => n + 1), 100);
    onCleanup(() => clearInterval(timer));
  });
  const spinner = () => SPINNER_FRAMES[tick() % SPINNER_FRAMES.length] ?? "*";

  // A clock for the reconnect countdown, only while disconnected.
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (shell.state.connection.state !== "disconnected") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => clearInterval(timer));
  });

  const [toolResults, setToolResults] = createStore<Record<string, ToolResultState>>({});
  const loadToolResult = (item: ToolCallDisplayItem) => {
    const id = threadId();
    if (id === null || toolResults[item.id] !== undefined) return;
    setToolResults(item.id, { state: "loading" });
    backend.fetchToolResult(id, item.id).then(
      (text) => setToolResults(item.id, { state: "loaded", text }),
      (error) => setToolResults(item.id, { state: "error", message: describeError(error) }),
    );
  };

  const rowContext: RowContext = {
    syntax,
    spinner,
    width: () => Math.max(20, dimensions().width - 4),
    isOpen: ui.isOpen,
    toolResult: (id) => toolResults[id],
    loadToolResult,
  };

  const info = (): StatusInfo => {
    const current = summary();
    const view = thread.state.thread;
    const projectId = view?.projectId ?? current?.projectId;
    const worktree = view?.worktreePath ?? null;
    const activeRun = thread.activeRun();
    let runStatus: string | null = null;
    if (threadId() !== null) {
      if (answerable() !== undefined) runStatus = "awaiting approval";
      else if (activeRun !== null) runStatus = activeRun.status;
      else if (thread.state.phase === "loading") runStatus = "loading";
      else if (thread.state.phase === "error") runStatus = "error";
      else runStatus = current?.status ?? null;
    }
    return {
      project: projectId === undefined ? null : (shell.state.projects[projectId]?.title ?? null),
      branch:
        view?.branch ??
        current?.branch ??
        (worktree === null ? null : (worktree.split("/").filter(Boolean).pop() ?? null)),
      title: view?.title ?? current?.title ?? null,
      model: current?.model ?? null,
      runStatus,
    };
  };

  const hint = () => {
    const view = ui.view();
    if (isPickerView(view)) return PICKER_HINTS[view];
    if (mode() === "insert") {
      if (promptShown()) {
        const text = textMode();
        if (text === "answer")
          return "Enter answer the question · Shift-Enter/Ctrl-J newline · Esc normal";
        if (text === "message")
          return "Enter send as the answer · Shift-Enter/Ctrl-J newline · Esc normal";
        return "Enter send · Esc, then Enter: back to the request";
      }
      return "Enter send · Shift-Enter/Ctrl-J newline · Ctrl-S steer · Ctrl-Q queue · Esc normal · Ctrl-C clear";
    }
    const request = answerable();
    if (request !== undefined && promptActive()) {
      if (request.type === "approval") {
        return `y approve · n deny · 1-${request.options.length} pick · Esc back to the transcript`;
      }
      const typing = textMode() === null ? "" : " · i type";
      return `1-9 answer · y submit selection${typing} · Esc back to the transcript`;
    }
    if (request !== undefined) return "Enter back to the request · :a approve · :d deny · ? help";
    if (threadId() === null)
      return ":t threads · :n new thread · : command · ? help · Ctrl-C twice to quit";
    return "i write · j/k scroll · ]] [[ messages · ]t [t tools · za fold · y yank · / search · : cmd · ? help";
  };

  // -------------------------------------------------------------------------
  // Actions

  const notice = ui.setNotice;

  const openThread = (id: ThreadId) => {
    if (ui.mode() === "insert") ui.setMode("normal");
    ui.setFocusedId(null);
    ui.foldAll(false);
    ui.setFollow(true);
    setToolResults(reconcile({}));
    backend.openThread(id);
  };

  onMount(() => {
    if (props.initialThreadId != null) openThread(props.initialThreadId);
  });

  const focusedIndex = (list: ReadonlyArray<DisplayItem>) => {
    const id = ui.focusedId();
    return id === null ? -1 : list.findIndex((item) => item.id === id);
  };

  /** Moves the focused-item cursor `count` matches in `direction` and scrolls to it. */
  const moveFocus = (
    direction: 1 | -1,
    predicate: (item: DisplayItem) => boolean,
    count: number,
    align: "start" | "nearest",
    what: string,
  ) => {
    const list = items();
    let index = focusedIndex(list);
    if (index === -1) {
      // No cursor yet: start from the edge of what is on screen, inclusive.
      const range = transcript?.visibleRange() ?? null;
      index =
        direction === 1
          ? range === null
            ? -1
            : range.first - 1
          : (range?.last ?? list.length) + 1;
    }
    let target = -1;
    for (let step = 0; step < count; step++) {
      const next = findItem(list, index, direction, predicate);
      if (next === -1) break;
      target = next;
      index = next;
    }
    const item = target === -1 ? undefined : list[target];
    if (item === undefined) {
      notice(direction === 1 ? `no next ${what}` : `no previous ${what}`, "warn");
      return;
    }
    ui.setFocusedId(item.id);
    transcript?.reveal(item.id, align);
  };

  const toggleFold = () => {
    const list = items();
    let item = list[focusedIndex(list)];
    if (item === undefined || !isFoldable(item)) {
      // Nothing foldable focused: take the last foldable item on screen.
      const range = transcript?.visibleRange() ?? null;
      const found = range === null ? -1 : findItem(list, range.last + 1, -1, isFoldable);
      item = found !== -1 && range !== null && found >= range.first ? list[found] : undefined;
      if (item === undefined) {
        notice("nothing to fold here", "warn");
        return;
      }
      ui.setFocusedId(item.id);
    }
    ui.toggleFold(item.id);
  };

  const yank = () => {
    const list = items();
    let item = list[focusedIndex(list)];
    if (item === undefined) {
      const last = findItem(
        list,
        list.length,
        -1,
        (candidate) => candidate.kind === "assistant_message",
      );
      item = list[last];
    }
    if (item === undefined) {
      notice("nothing to yank", "warn");
      return;
    }
    let text = itemText(item);
    if (item.kind === "tool_call" && item.result === null) {
      const fetched = toolResults[item.id];
      if (fetched?.state === "loaded" && fetched.text !== null)
        text = `${item.args}\n\n${fetched.text}`;
    }
    if (copyToClipboard(text, renderer)) {
      const lines = text.split("\n").length;
      notice(`yanked ${lines} line${lines === 1 ? "" : "s"}`);
    } else {
      notice("could not write to the clipboard", "error");
    }
  };

  const interrupt = () => {
    const id = threadId();
    if (id === null) {
      notice("no thread open", "warn");
      return;
    }
    if (thread.activeRun() === null) {
      notice("nothing to interrupt", "warn");
      return;
    }
    backend.interrupt(id).then(
      () => notice("interrupt requested"),
      (error) => notice(`interrupt failed: ${describeError(error)}`, "error", 6_000),
    );
  };

  const cycleThread = (delta: number) => {
    const next = stepThread(shell.groups(), threadId(), delta);
    if (next === null) {
      notice("no other thread in this project", "warn");
      return;
    }
    openThread(next as ThreadId);
  };

  const enterInsert = (empty: boolean) => {
    if (threadId() === null) {
      notice("no thread open", "warn");
      return;
    }
    if (promptShown() && textMode() === null) {
      notice(
        answerable()?.type === "approval"
          ? "answer the request first: y / n, or :a / :d"
          : "answer the question first: pick with 1-9",
        "warn",
      );
      return;
    }
    if (empty) textarea?.setText("");
    ui.setMode("insert");
  };

  /** Empties the input if it still holds `text` (the user may have typed on). */
  const clearDraft = (text: string) => {
    if (textarea !== undefined && textarea.plainText.trim() === text) textarea.setText("");
  };

  /** The last draft sent, with its ids; resending the same text reuses them. */
  let lastAttempt: SendAttempt | null = null;
  let sending = false;

  /** Sends the input. The draft stays in the input until the server accepted it. */
  const send = (intent: DeliveryIntent) => {
    const id = threadId();
    const text = (textarea?.plainText ?? "").trim();
    if (text === "") return;
    if (id === null) {
      notice("no thread open", "warn");
      return;
    }
    if (promptShown() && textMode() === "answer") {
      answerWithText(text);
      return;
    }
    if (sending) {
      notice("still sending the previous message", "warn");
      return;
    }
    const attempt: SendAttempt =
      lastAttempt?.text === text
        ? lastAttempt
        : { text, commandId: newCommandId(), messageId: newMessageId() };
    lastAttempt = attempt;
    sending = true;
    transcript?.toBottom();
    if (shell.state.connection.state !== "connected") notice("not connected · waiting briefly…");
    const titleSeed = untitled.has(id) ? text : undefined;
    backend
      .send(id, text, intent, {
        ...(titleSeed === undefined ? {} : { titleSeed }),
        commandId: attempt.commandId,
        messageId: attempt.messageId,
      })
      .then(
        () => {
          sending = false;
          if (lastAttempt === attempt) lastAttempt = null;
          untitled.delete(id);
          clearDraft(text);
          if (intent === "steer") notice("steered");
          else if (intent === "queue" && thread.activeRun() !== null)
            notice("queued · :queue to manage");
          else if (shell.state.connection.state !== "connected") notice("sent");
        },
        (error) => {
          sending = false;
          notice(`send failed: ${describeError(error)} · the draft is kept`, "error", 6_000);
        },
      );
  };

  /** Sends the response once per request; resolves whether it was accepted. */
  const respond = (
    request: AnswerableRequest,
    response: Parameters<Backend["respond"]>[2],
    label: string,
  ): Promise<boolean> => {
    const id = threadId();
    if (id === null) return Promise.resolve(false);
    if (answered.has(request.requestId)) {
      notice("already answered · waiting for the server", "warn");
      return Promise.resolve(false);
    }
    answered.add(request.requestId);
    return backend.respond(id, request.requestId, response).then(
      () => {
        notice(label);
        return true;
      },
      (error) => {
        answered.delete(request.requestId);
        notice(`response failed: ${describeError(error)}`, "error", 6_000);
        return false;
      },
    );
  };

  /** False (with a notice) while the request is too new to answer by key. */
  const checkArmed = () => {
    if (armed()) return true;
    notice("the request just appeared or changed · read it, then answer", "warn");
    return false;
  };

  const decide = (request: PendingApproval, index: number) => {
    const option = request.options[index];
    if (option === undefined) {
      notice(`no option ${index + 1}`, "warn");
      return;
    }
    void respond(request, { decision: option.decision }, option.label);
  };

  /**
   * Records an answer for the current question; responds once all are
   * answered. Resolves whether the answer was taken; the progress is kept
   * when the response fails, so picking again retries.
   */
  const answer = (request: PendingUserInput, value: unknown): Promise<boolean> => {
    const current = progress();
    const question = request.questions[current.question];
    if (question === undefined) return Promise.resolve(false);
    const answers = { ...current.answers, [question.id]: value };
    if (current.question + 1 < request.questions.length) {
      setProgress({ question: current.question + 1, selected: [], answers });
      return Promise.resolve(true);
    }
    setProgress({ ...current, answers });
    return respond(request, { answers }, "answered").then((ok) => {
      if (ok && answerable()?.requestId === request.requestId) setProgress(EMPTY_PROGRESS);
      return ok;
    });
  };

  /** Typed text as the answer to the current question (free text or a custom answer). */
  const answerWithText = (text: string) => {
    const request = answerable();
    if (request?.type !== "user_input") return;
    void answer(request, text).then((ok) => {
      if (!ok) return;
      clearDraft(text);
      if (answerable()?.requestId === request.requestId && textMode() !== "answer") {
        // The next question wants a pick.
        ui.setMode("normal");
        ui.setPromptFocused(true);
      }
    });
  };

  const optionValue = (option: { readonly label: string; readonly value?: string | undefined }) =>
    option.value ?? option.label;

  const approve = () => {
    const request = answerable();
    if (request === undefined) {
      notice("no pending request", "warn");
      return;
    }
    if (!checkArmed()) return;
    if (request.type === "approval") {
      const index = approveOptionIndex(request);
      if (index === -1) {
        notice(
          `this request has no approve option: pick one with 1-${request.options.length}`,
          "warn",
        );
        return;
      }
      decide(request, index);
      return;
    }
    const question = request.questions[progress().question];
    if (question === undefined) {
      if (request.questions.length === 0 && request.responseCapability !== "message") {
        // Nothing to answer: acknowledge it so the run can go on.
        void respond(request, { answers: {} }, "continued");
      } else {
        notice("answer with a normal message: i", "warn");
      }
      return;
    }
    if (question.multiSelect === true && progress().selected.length > 0) {
      const values = progress()
        .selected.map((n) => question.options[n - 1])
        .filter((option) => option !== undefined)
        .map(optionValue);
      void answer(request, values);
      return;
    }
    if (question.options.length === 0) {
      notice("type the answer: i", "warn");
      return;
    }
    notice(`pick an answer with 1-${question.options.length}`, "warn");
  };

  const deny = () => {
    const request = answerable();
    if (request === undefined) {
      notice("no pending request", "warn");
      return;
    }
    if (!checkArmed()) return;
    if (request.type === "approval") {
      const index = denyOptionIndex(request);
      if (index === -1) notice("this request has no deny option", "warn");
      else decide(request, index);
      return;
    }
    notice("questions cannot be denied: pick an answer, or interrupt with x", "warn");
  };

  const pick = (n: number) => {
    const request = answerable();
    if (request === undefined) return;
    if (!checkArmed()) return;
    if (request.type === "approval") {
      decide(request, n - 1);
      return;
    }
    const question = request.questions[progress().question];
    const option = question?.options[n - 1];
    if (question === undefined || option === undefined) {
      notice(`no option ${n}`, "warn");
      return;
    }
    if (question.multiSelect === true) {
      const current = progress();
      const selected = current.selected.includes(n)
        ? current.selected.filter((value) => value !== n)
        : [...current.selected, n];
      setProgress({ ...current, selected });
      return;
    }
    void answer(request, optionValue(option));
  };

  const searchStep = (direction: 1 | -1) => {
    const query = ui.searchQuery();
    if (query === "") {
      notice("no previous search", "warn");
      return;
    }
    const list = items();
    let from = focusedIndex(list);
    if (from === -1) {
      const range = transcript?.visibleRange() ?? null;
      from =
        direction === 1
          ? range === null
            ? -1
            : range.first - 1
          : (range?.last ?? list.length) + 1;
    }
    const index = findMatch(list, query, from, direction);
    const item = list[index];
    if (item === undefined) {
      notice(`pattern not found: ${query}`, "error");
      return;
    }
    let position = 0;
    let total = 0;
    for (let i = 0; i < list.length; i++) {
      const candidate = list[i];
      if (candidate === undefined) continue;
      const text =
        candidate.kind === "tool_call"
          ? `${candidate.name} ${itemText(candidate)}`
          : itemText(candidate);
      if (!matchesQuery(text, query)) continue;
      total += 1;
      if (i === index) position = total;
    }
    ui.setFocusedId(item.id);
    transcript?.reveal(item.id, "start");
    notice(`/${query} [${position}/${total}]`);
  };

  // -------------------------------------------------------------------------
  // Command line, text prompt and pickers

  const histories = { command: new LineHistory(), search: new LineHistory() };
  const completer = new Completer();
  const [inputPrompt, setInputPrompt] = createSignal<InputPrompt | null>(null);
  /** Threads created untitled here; their first message seeds the server's auto-title. */
  const untitled = new Set<string>();

  const openLine = (kind: "command" | "search") => {
    histories[kind].reset();
    completer.reset();
    ui.setView(kind);
  };
  const closeLine = () => {
    setInputPrompt(null);
    ui.setView("transcript");
  };
  const setLine = (text: string) => {
    if (lineInput === undefined) return;
    lineInput.value = text;
    lineInput.gotoBufferEnd();
  };

  const askText = (prompt: InputPrompt) => {
    setInputPrompt(prompt);
    ui.setView("input");
  };

  const ask = (message: string, onYes: () => void) => ui.setConfirm({ message, onYes });

  // Picker state. The cursor is remembered by row key so it stays on the same
  // entry while the list changes underneath (streaming status, new threads).
  const [pickerFilter, setPickerFilter] = createSignal("");
  const [cursorIndex, setCursorIndex] = createSignal(0);
  const [cursorKey, setCursorKey] = createSignal<string | null>(null);
  const [threadProject, setThreadProject] = createSignal<ProjectId | null>(null);
  const [showArchived, setShowArchived] = createSignal(false);
  const [projectPurpose, setProjectPurpose] = createSignal<"narrow" | "new">("narrow");
  const [modelPurpose, setModelPurpose] = createSignal<"set" | "new">("set");
  const [draft, setDraft] = createSignal<NewThreadDraft | null>(null);
  const [catalog, setCatalog] = createSignal<ModelCatalog | null>(null);
  /** The model picked last in this session; new threads prefer it over the server default. */
  const [lastModel, setLastModel] = createSignal<ModelSelection | null>(null);

  const pickerWidth = () => Math.max(20, Math.min(110, dimensions().width - 4)) - 4;

  const [archived, setArchived] = createSignal<ReadonlyArray<ThreadSummary>>([]);
  /** Saved profiles for `:servers`; null while loading. */
  const [serverEntries, setServerEntries] = createSignal<ReadonlyArray<ProfileEntry> | null>(null);
  const pickerGroups = createMemo((): ReadonlyArray<ProjectGroup> => {
    const groups = shell.groups();
    if (!showArchived()) return groups;
    const extra = archived();
    return untrack(() => {
      const state = unwrap(shell.state);
      const threads: Record<string, ThreadSummary> = { ...state.threads };
      for (const entry of extra) threads[entry.id] ??= entry;
      return selectProjectGroups({ ...state, threads }, { includeArchived: true });
    });
  });

  const toggleArchived = () => {
    if (showArchived()) {
      setShowArchived(false);
      return;
    }
    setShowArchived(true);
    backend
      .archivedThreads()
      .then(setArchived, (error) =>
        notice(`could not load archived threads: ${describeError(error)}`, "error", 6_000),
      );
  };

  const currentModel = (): ModelSelection | null =>
    thread.state.thread?.modelSelection ?? summary()?.modelSelection ?? null;

  const pickerList = createMemo((): { rows: ReadonlyArray<PickerRow>; initial: number } => {
    const view = ui.view();
    const query = pickerFilter();
    switch (view) {
      case "threads": {
        const built = buildThreadRows(pickerGroups(), {
          numbering: shell.groups(),
          query,
          projectId: threadProject(),
          now: Date.now(),
          width: pickerWidth(),
          openThreadId: threadId(),
        });
        return { rows: built.rows, initial: built.best };
      }
      case "projects":
        return {
          rows: buildProjectRows(shell.groups(), {
            query,
            now: Date.now(),
            width: pickerWidth(),
            displayPath,
          }),
          initial: 0,
        };
      case "models": {
        const loaded = catalog();
        if (loaded === null) return { rows: [], initial: 0 };
        const built = buildModelRows(loaded, {
          query,
          current: modelPurpose() === "set" ? currentModel() : null,
          width: pickerWidth(),
        });
        return { rows: built.rows, initial: built.initial };
      }
      case "modes": {
        const current = thread.state.thread?.runtimeMode ?? null;
        const instanceId = currentModel()?.instanceId;
        const provider = catalog()?.providers.find((entry) => entry.instanceId === instanceId);
        const rows = buildModeRows({ current, supported: provider?.supportedRuntimeModes ?? null });
        return {
          rows,
          initial: Math.max(
            0,
            rows.findIndex((row) => row.value === current),
          ),
        };
      }
      case "queue":
        return { rows: buildQueueRows(thread.queue(), pickerWidth()), initial: 0 };
      case "servers": {
        const current = backend.server().profile;
        const rows = buildServerRows(serverEntries() ?? [], {
          current,
          width: pickerWidth(),
          now: Date.now(),
        });
        return {
          rows,
          initial: Math.max(
            0,
            rows.findIndex((row) => row.key === current),
          ),
        };
      }
      default:
        return { rows: [], initial: 0 };
    }
  });
  const pickerSelectable = createMemo(() => selectableIndices(pickerList().rows));
  /** Index into the selectable rows. */
  const pickerCursor = createMemo(() => {
    const rows = pickerList().rows;
    const selectable = pickerSelectable();
    const key = cursorKey();
    if (key !== null) {
      const found = selectable.findIndex((index) => rows[index]?.key === key);
      if (found !== -1) return found;
    }
    return clampCursor(cursorIndex(), selectable.length);
  });
  const pickerCursorRow = () => pickerSelectable()[pickerCursor()] ?? -1;
  const pickerSelected = (): PickerRow | undefined => pickerList().rows[pickerCursorRow()];

  const setCursor = (index: number) => {
    const selectable = pickerSelectable();
    const next = clampCursor(index, selectable.length);
    setCursorIndex(next);
    setCursorKey(pickerList().rows[selectable[next] ?? -1]?.key ?? null);
  };

  const openPicker = (view: PickerView, filter = "", cursorOn: string | null = null) => {
    setPickerFilter(filter);
    setCursorKey(null);
    setCursorIndex(0);
    ui.setView(view);
    if (cursorOn !== null && filter === "") {
      const rows = pickerList().rows;
      const found = pickerSelectable().findIndex((index) => rows[index]?.key === cursorOn);
      if (found !== -1) {
        setCursor(found);
        return;
      }
    }
    setCursor(pickerList().initial);
  };

  const closePicker = () => {
    ui.setView("transcript");
    setPickerFilter("");
    setDraft(null);
  };

  const onFilter = (value: string) => {
    setPickerFilter(value);
    setCursorKey(null);
    setCursor(pickerList().initial);
  };

  /** Types text into the picker filter (keys a list binding swallowed). */
  const typeIntoFilter = (text: string) => {
    if (!FILTERED_PICKERS.has(ui.view()) || filterInput === undefined) return;
    filterInput.insertText(text);
    onFilter(filterInput.value);
  };

  const loadCatalog = (refresh = false): Promise<ModelCatalog | null> =>
    backend.modelCatalog(refresh).then(
      (loaded) => {
        setCatalog(loaded);
        return loaded;
      },
      (error) => {
        notice(`could not load models: ${describeError(error)}`, "error", 6_000);
        return null;
      },
    );

  const openThreadPicker = (filter = "", projectId: ProjectId | null = null) => {
    setThreadProject(projectId);
    openPicker("threads", filter, threadId());
  };

  const openProjectPicker = (purpose: "narrow" | "new") => {
    setProjectPurpose(purpose);
    const projectId = thread.state.thread?.projectId ?? summary()?.projectId ?? null;
    openPicker("projects", "", projectId);
  };

  const openModelPicker = (purpose: "set" | "new") => {
    if (purpose === "set" && threadId() === null) {
      notice("no thread open", "warn");
      return;
    }
    setModelPurpose(purpose);
    const current = purpose === "set" ? currentModel() : null;
    openPicker("models");
    void loadCatalog().then((loaded) => {
      if (loaded === null) {
        if (ui.view() === "models") closePicker();
        return;
      }
      if (ui.view() !== "models" || pickerFilter() !== "") return;
      setCursorKey(current === null ? null : `${current.instanceId}/${current.model}`);
      if (current === null) setCursor(pickerList().initial);
    });
  };

  const openModePicker = () => {
    if (threadId() === null) {
      notice("no thread open", "warn");
      return;
    }
    openPicker("modes");
    if (catalog() === null) void loadCatalog();
  };

  const openQueue = () => {
    if (threadId() === null) {
      notice("no thread open", "warn");
      return;
    }
    openPicker("queue");
  };

  // New threads ------------------------------------------------------------

  /** Project default, then the model last picked here, then the project's newest thread, then the server's default. */
  const defaultModelFor = (projectId: ProjectId, loaded: ModelCatalog | null) => {
    const project = shell.state.projects[projectId];
    if (project?.defaultModelSelection != null) return project.defaultModelSelection;
    const last = lastModel();
    if (last !== null) return last;
    const newest = shell.groups().find((group) => group.projectId === projectId)?.threads[0];
    if (newest !== undefined) return newest.modelSelection;
    if (loaded?.defaultModelSelection != null) return loaded.defaultModelSelection;
    for (const provider of loaded?.providers ?? []) {
      const model = provider.models.find((candidate) => candidate.isDefault);
      if (model !== undefined) return { instanceId: provider.instanceId, model: model.slug };
    }
    return null;
  };

  const createNewThread = async (
    projectId: ProjectId,
    title: string,
    chosen: ModelSelection | null,
  ) => {
    const loaded = catalog() ?? (await loadCatalog());
    const modelSelection = chosen ?? defaultModelFor(projectId, loaded);
    if (modelSelection === null) {
      // Nothing to go on: ask for the model first.
      setDraft({ projectId, title });
      notice("pick a model for the new thread");
      setModelPurpose("new");
      openPicker("models");
      return;
    }
    const runtimeMode: RuntimeMode = loaded?.defaultRuntimeMode ?? DEFAULT_RUNTIME_MODE;
    notice("creating thread…");
    try {
      const id = await backend.createThread({ projectId, title, modelSelection, runtimeMode });
      if (title.trim() === "") untitled.add(id);
      openThread(id);
      ui.setView("transcript");
      ui.setMode("insert");
      notice(`created ${title.trim() === "" ? "an untitled thread" : `"${title.trim()}"`}`);
    } catch (error) {
      notice(`could not create the thread: ${describeError(error)}`, "error", 6_000);
    }
  };

  const continueNewThread = (projectId: ProjectId) => {
    const title = draft()?.title ?? null;
    setDraft(null);
    if (title !== null) {
      ui.setView("transcript");
      void createNewThread(projectId, title, null);
      return;
    }
    const projectTitle = shell.state.projects[projectId]?.title ?? "project";
    askText({
      prefix: `title for a new thread in ${projectTitle} (empty: untitled): `,
      hint: "Enter create · Esc cancel",
      onSubmit: (text) => void createNewThread(projectId, text.trim(), null),
    });
  };

  const startNewThread = (title: string | null) => {
    setDraft({ projectId: null, title });
    openProjectPicker("new");
  };

  // Picker actions ---------------------------------------------------------

  const pickerSelect = () => {
    const view = ui.view();
    const row = pickerSelected();
    if (row === undefined || row.kind !== "item") {
      if (view === "queue" || pickerList().rows.length === 0) closePicker();
      return;
    }
    switch (view) {
      case "threads": {
        const target = row.value as ThreadSummary;
        closePicker();
        if (target.id !== threadId()) openThread(target.id);
        return;
      }
      case "projects": {
        const group = row.value as ProjectGroup;
        if (projectPurpose() === "new") {
          continueNewThread(group.projectId);
          return;
        }
        setPickerFilter("");
        openThreadPicker("", group.projectId);
        return;
      }
      case "models": {
        const choice = row.value as ModelChoice;
        const selection: ModelSelection = { instanceId: choice.instanceId, model: choice.model };
        setLastModel(selection);
        if (modelPurpose() === "new") {
          const pending = draft();
          closePicker();
          if (pending?.projectId != null) {
            void createNewThread(pending.projectId, pending.title ?? "", selection);
          }
          return;
        }
        const id = threadId();
        closePicker();
        if (id === null) return;
        backend.setModel(id, selection).then(
          () => notice(`model: ${choice.label}`),
          (error) => notice(`could not set the model: ${describeError(error)}`, "error", 6_000),
        );
        return;
      }
      case "modes": {
        const runtimeMode = row.value as RuntimeMode;
        const id = threadId();
        closePicker();
        if (id === null) return;
        backend.setRuntimeMode(id, runtimeMode).then(
          () => notice(`runtime mode: ${runtimeMode}`),
          (error) => notice(`could not set the mode: ${describeError(error)}`, "error", 6_000),
        );
        return;
      }
      case "queue":
        closePicker();
        return;
      case "servers": {
        const entry = row.value as ProfileEntry;
        closePicker();
        if (entry.name === backend.server().profile) {
          notice(`already on ${entry.name}`);
          return;
        }
        switchServer(entry.name, () => backend.switchProfile(entry.name).then(() => undefined));
        return;
      }
    }
  };

  const archiveThread = (target: { readonly id: ThreadId; readonly title: string }) => {
    ask(`archive "${target.title}"?`, () => {
      backend.archive(target.id).then(
        () => notice(`archived "${target.title}"`),
        (error) => notice(`could not archive: ${describeError(error)}`, "error", 6_000),
      );
    });
  };

  const pickerDelete = () => {
    const view = ui.view();
    const row = pickerSelected();
    if (view === "threads") {
      if (row?.kind !== "item") return;
      const target = row.value as ThreadSummary;
      if (target.archived) {
        notice("already archived", "warn");
        return;
      }
      archiveThread(target);
      return;
    }
    if (view === "queue") {
      const id = threadId();
      if (row?.kind !== "item" || id === null) return;
      const run = row.value as QueuedRun;
      const label = oneLine(run.text ?? "queued message", 40);
      ask(`cancel queued "${label}"?`, () => {
        backend.cancelQueued(id, run.runId).then(
          () => notice("queued message cancelled"),
          (error) => notice(`could not cancel: ${describeError(error)}`, "error", 6_000),
        );
      });
      return;
    }
    typeIntoFilter("dd");
  };

  const pickerMove = (delta: -1 | 1, key: string) => {
    if (ui.view() !== "queue") {
      typeIntoFilter(key);
      return;
    }
    const id = threadId();
    const queue = thread.queue();
    const target = reorderTarget(
      queue.map((run) => run.runId),
      pickerCursor(),
      delta,
    );
    if (id === null || target === null) return;
    backend
      .reorderQueued(id, target.runId as RunId, target.beforeRunId as RunId | null)
      .catch((error) => notice(`could not reorder: ${describeError(error)}`, "error", 6_000));
  };

  const pickerCancel = () => {
    if (FILTERED_PICKERS.has(ui.view()) && pickerFilter() !== "") {
      if (filterInput !== undefined) filterInput.value = "";
      onFilter("");
      return;
    }
    closePicker();
  };

  // Servers ----------------------------------------------------------------

  const openServerPicker = () => {
    setServerEntries(null);
    openPicker("servers");
    backend.servers().then(
      (entries) => {
        setServerEntries(entries);
        if (ui.view() === "servers") setCursor(pickerList().initial);
      },
      (error) => {
        if (ui.view() === "servers") closePicker();
        notice(`could not read the saved servers: ${describeError(error)}`, "error", 8_000);
      },
    );
  };

  /** Forgets everything that belonged to the previous server. */
  const resetForNewServer = () => {
    if (ui.mode() === "insert") ui.setMode("normal");
    ui.setFocusedId(null);
    ui.setFollow(true);
    setToolResults(reconcile({}));
    setCatalog(null);
    setLastModel(null);
    setArchived([]);
    setShowArchived(false);
    untitled.clear();
    answered.clear();
  };

  let switching = false;
  const switchServer = (what: string, run: () => Promise<string | undefined>) => {
    if (switching) {
      notice("already switching servers", "warn");
      return;
    }
    switching = true;
    notice(`connecting to ${what}…`, "info", 30_000);
    run().then(
      (message) => {
        switching = false;
        resetForNewServer();
        notice(typeof message === "string" ? message : `switched to ${what}`, "info", 8_000);
      },
      (error) => {
        switching = false;
        notice(describeError(error), "error", 15_000);
      },
    );
  };

  const connectLink = (link: string) => {
    switchServer("the server", async () => {
      const saved = await backend.connectLink(link);
      const readOnly = canOperate(saved.scope) ? "" : " (read-only)";
      return `${saved.created ? "saved" : "updated"} profile ${saved.name}${readOnly}; switched to it`;
    });
  };

  // Commands ---------------------------------------------------------------

  const jumpToThread = (target: number | string) => {
    const list = threadIndex(shell.groups());
    let found: ThreadSummary | undefined;
    if (typeof target === "number") {
      found = list[target - 1];
      if (found === undefined) {
        notice(`no thread ${target} (1-${list.length})`, "error");
        return;
      }
    } else {
      const lowered = target.toLowerCase();
      found =
        list.find((candidate) => candidate.title.toLowerCase() === lowered) ??
        fuzzyFilter(list, target, (candidate) => candidate.title)[0]?.item;
      if (found === undefined) {
        notice(`no thread matches "${target}"`, "error");
        return;
      }
    }
    if (found.id !== threadId()) openThread(found.id);
  };

  const narrowToProject = (name: string) => {
    const groups = shell.groups();
    const lowered = name.toLowerCase();
    const group =
      groups.find((candidate) => candidate.title.toLowerCase() === lowered) ??
      fuzzyFilter(groups, name, (candidate) => candidate.title)[0]?.item;
    if (group === undefined) {
      notice(`no project matches "${name}"`, "error");
      return;
    }
    openThreadPicker("", group.projectId);
  };

  const completionSources = (): CompletionSources => ({
    threads: threadIndex(shell.groups()).map((candidate) => candidate.title),
    projects: shell.groups().map((group) => group.title),
  });

  const completeLine = () => {
    if (lineKind() !== "command" || lineInput === undefined) return;
    const result = completer.complete(lineInput.value, completionSources());
    if (result === null) {
      notice("no completions", "warn");
      return;
    }
    setLine(result.text);
    if (result.candidates.length > 1) {
      const shown = result.candidates
        .map((candidate, index) => (index === result.index ? `[${candidate}]` : candidate))
        .join(" ");
      notice(shown, "info", 6_000);
    }
  };

  const browseHistory = (direction: "older" | "newer") => {
    const kind = lineKind();
    if ((kind !== "command" && kind !== "search") || lineInput === undefined) return;
    const history = histories[kind];
    const text = direction === "older" ? history.older(lineInput.value) : history.newer();
    if (text !== null) setLine(text);
    completer.reset();
  };

  const runCommand = (command: Command) => {
    switch (command.type) {
      case "noop":
        return;
      case "quit": {
        const blocker = quitBlocker(
          command.force,
          threadId() !== null && thread.activeRun() !== null,
        );
        if (blocker !== null) {
          notice(blocker, "warn", 6_000);
          return;
        }
        props.onQuit();
        return;
      }
      case "write":
        notice(WRITE_MESSAGE);
        return;
      case "approve":
        approve();
        return;
      case "deny":
        deny();
        return;
      case "threads":
        openThreadPicker(command.filter);
        return;
      case "projects":
        if (command.name === "") openProjectPicker("narrow");
        else narrowToProject(command.name);
        return;
      case "new":
        startNewThread(command.title);
        return;
      case "model":
        openModelPicker("set");
        return;
      case "mode":
        openModePicker();
        return;
      case "thread":
        jumpToThread(command.target);
        return;
      case "threadNext":
        cycleThread(1);
        return;
      case "threadPrev":
        cycleThread(-1);
        return;
      case "queue":
        openQueue();
        return;
      case "help":
        ui.setView("help");
        return;
      case "archive": {
        const id = threadId();
        if (id === null) {
          notice("no thread open", "warn");
          return;
        }
        archiveThread({ id, title: info().title ?? id });
        return;
      }
      case "reconnect":
        backend.reconnect();
        notice(
          shell.state.connection.state === "failed"
            ? "restarting the connection…"
            : "reconnecting…",
        );
        return;
      case "connect":
        if (command.link === null) {
          notice(
            "paste a pairing link (Settings → Connections, or `t3 pair` on the host)",
            "info",
            15_000,
          );
          askText({
            prefix: "pairing link: ",
            hint: "paste the link from Settings → Connections (or `t3 pair`) · Enter connect · Esc cancel",
            onSubmit: (text) => {
              if (text.trim() !== "") connectLink(text.trim());
            },
          });
        } else {
          connectLink(command.link);
        }
        return;
      case "servers":
        openServerPicker();
        return;
      case "usage":
        notice(command.message, "warn");
        return;
      case "unknown":
        notice(`unknown command: ${command.name}`, "error");
        return;
    }
  };

  const submitLine = () => {
    const kind = lineKind();
    const text = lineInput?.value ?? "";
    const prompt = inputPrompt();
    closeLine();
    if (kind === "command") {
      if (keepInHistory(text)) histories.command.push(text);
      runCommand(parseCommandLine(text));
    } else if (kind === "search") {
      histories.search.push(text);
      if (text !== "") ui.setSearchQuery(text);
      searchStep(1);
    } else if (kind === "input" && prompt !== null) {
      prompt.onSubmit(text);
    }
  };

  const confirmAnswer = (yes: boolean) => {
    const pending = ui.confirm();
    ui.setConfirm(null);
    if (pending === null) return;
    if (yes) pending.onYes();
    else notice("cancelled");
  };

  const ctrlC = () => {
    const at = Date.now();
    if (at - lastCtrlC <= DOUBLE_CTRL_C_MS) {
      props.onQuit();
      return;
    }
    lastCtrlC = at;
    if (threadId() !== null && thread.activeRun() !== null) {
      interrupt();
      notice("interrupting · Ctrl-C again to quit", "warn", DOUBLE_CTRL_C_MS);
    } else {
      notice("press Ctrl-C again to quit", "warn", DOUBLE_CTRL_C_MS);
    }
  };

  const runAction = (binding: Binding<ActionId>, count: number | null) => {
    const n = Math.max(1, count ?? 1);
    switch (binding.action) {
      case "scroll.lineDown":
        return transcript?.scrollLines(n);
      case "scroll.lineUp":
        return transcript?.scrollLines(-n);
      case "scroll.halfDown":
        return transcript?.scrollPages(0.5 * n);
      case "scroll.halfUp":
        return transcript?.scrollPages(-0.5 * n);
      case "scroll.pageDown":
        return transcript?.scrollPages(n);
      case "scroll.pageUp":
        return transcript?.scrollPages(-n);
      case "scroll.top":
        return transcript?.toTop();
      case "scroll.bottom":
        ui.setFocusedId(null);
        return transcript?.toBottom();
      case "focus.nextMessage":
        return moveFocus(1, isMessage, n, "start", "message");
      case "focus.prevMessage":
        return moveFocus(-1, isMessage, n, "start", "message");
      case "focus.nextTool":
        return moveFocus(1, isTool, n, "nearest", "tool call");
      case "focus.prevTool":
        return moveFocus(-1, isTool, n, "nearest", "tool call");
      case "fold.toggle":
        return toggleFold();
      case "fold.closeAll":
        return ui.foldAll(false);
      case "fold.openAll":
        return ui.foldAll(true);
      case "mode.insert":
        return enterInsert(false);
      case "mode.insertEmpty":
        return enterInsert(true);
      case "mode.normal":
        return ui.setMode("normal");
      case "item.yank":
        return yank();
      case "run.interrupt":
        return interrupt();
      case "thread.next":
        return cycleThread(n);
      case "thread.prev":
        return cycleThread(-n);
      case "search.open":
        return openLine("search");
      case "search.next":
        return searchStep(1);
      case "search.prev":
        return searchStep(-1);
      case "command.open":
        return openLine("command");
      case "help.open":
        return ui.setView("help");
      case "app.ctrlC":
        return ctrlC();
      case "request.approve":
        return approve();
      case "request.deny":
        return deny();
      case "request.pick":
        return pick(binding.arg ?? 1);
      case "request.blur":
        return ui.setPromptFocused(false);
      case "request.focus":
        if (promptShown()) ui.setPromptFocused(true);
        return;
      case "input.send":
        return send("auto");
      case "input.steer":
        return send("steer");
      case "input.queue":
        return send("queue");
      case "input.newline":
        textarea?.newLine();
        return;
      case "input.clear":
        textarea?.setText("");
        return ui.setMode("normal");
      case "line.submit":
        return submitLine();
      case "line.cancel":
        return closeLine();
      case "line.complete":
        return completeLine();
      case "line.older":
        return browseHistory("older");
      case "line.newer":
        return browseHistory("newer");
      case "picker.down":
        return setCursor(moveCursor(pickerCursor(), n, pickerSelectable().length));
      case "picker.up":
        return setCursor(moveCursor(pickerCursor(), -n, pickerSelectable().length));
      case "picker.pageDown":
        return setCursor(moveCursor(pickerCursor(), 10 * n, pickerSelectable().length));
      case "picker.pageUp":
        return setCursor(moveCursor(pickerCursor(), -10 * n, pickerSelectable().length));
      case "picker.select":
        return pickerSelect();
      case "picker.cancel":
        return pickerCancel();
      case "picker.close":
        return closePicker();
      case "picker.delete":
        return pickerDelete();
      case "picker.moveDown":
        return pickerMove(1, "J");
      case "picker.moveUp":
        return pickerMove(-1, "K");
      case "picker.toggleArchived":
        if (ui.view() === "threads") toggleArchived();
        return;
      case "confirm.yes":
        return confirmAnswer(true);
      case "confirm.no":
        return confirmAnswer(false);
    }
  };

  // -------------------------------------------------------------------------
  // Keyboard

  const currentLayer = (): Layer => {
    if (ui.confirm() !== null) return "confirm";
    const view = ui.view();
    if (isPickerView(view)) {
      return FILTERED_PICKERS.has(view) && pickerFilter() !== "" ? "picker" : "pickerList";
    }
    if (lineKind() !== null) return "line";
    if (ui.mode() === "insert") return "insert";
    return promptActive() ? "prompt" : "normal";
  };

  const handleHelpKey = (token: string) => {
    switch (token) {
      case "<Esc>":
      case "q":
      case "?":
      case "<C-c>":
        ui.setView("transcript");
        return;
      case "j":
      case "<Down>":
        helpScroll?.scrollBy(1);
        return;
      case "k":
      case "<Up>":
        helpScroll?.scrollBy(-1);
        return;
      case "<C-d>":
      case "<C-f>":
        helpScroll?.scrollBy(0.5, "viewport");
        return;
      case "<C-u>":
      case "<C-b>":
        helpScroll?.scrollBy(-0.5, "viewport");
        return;
    }
  };

  /** Keys a picker list binding held back (`d` waiting for `dd`) that turned out to be typing. */
  const retypeDropped = (layer: Layer, keys: string) => {
    if (layer !== "pickerList" || keys === "" || keys.includes("<")) return;
    typeIntoFilter(keys);
  };

  const feed = (event: KeyEvent, token: string, retry: boolean) => {
    const layer = currentLayer();
    const result = sequencer.feed(token, keymaps[layer], {
      allowCount: layer === "normal" || layer === "prompt",
    });
    if (sequenceTimer !== undefined) clearTimeout(sequenceTimer);
    sequenceTimer = undefined;
    ui.setPendingKeys(sequencer.pending);
    switch (result.type) {
      case "pending":
        event.preventDefault();
        sequenceTimer = setTimeout(() => {
          sequenceTimer = undefined;
          const lateLayer = currentLayer();
          const late = sequencer.timeout(keymaps[lateLayer]);
          ui.setPendingKeys("");
          if (late?.type === "action") runAction(late.binding, late.count);
          else if (late?.type === "unbound") retypeDropped(lateLayer, late.keys);
        }, sequencer.timeoutMs);
        return;
      case "action":
        event.preventDefault();
        runAction(result.binding, result.count);
        return;
      case "unbound":
        event.preventDefault();
        // In a picker, a held-back prefix plus a key that completes nothing
        // was typing: put the prefix into the filter and handle the key anew.
        if (layer === "pickerList" && !retry) {
          retypeDropped(layer, result.keys.slice(0, result.keys.length - token.length));
          feed(event, token, true);
        }
        return;
      case "passthrough": {
        // Typing goes to the focused input; elsewhere unbound keys do nothing.
        const typing =
          layer === "insert" ||
          layer === "line" ||
          ((layer === "picker" || layer === "pickerList") && FILTERED_PICKERS.has(ui.view()));
        if (!typing) {
          event.preventDefault();
          return;
        }
        if (retry) {
          // The event was already marked handled; type the key ourselves.
          const text = token === "<Space>" ? " " : token.length === 1 ? token : null;
          if (text !== null) typeIntoFilter(text);
        }
        return;
      }
    }
  };

  useKeyboard((event: KeyEvent) => {
    if (event.eventType === "release") return;
    const token = keyToken(event);
    if (ui.view() === "help" && ui.confirm() === null) {
      event.preventDefault();
      handleHelpKey(token);
      return;
    }
    feed(event, token, false);
  });

  // -------------------------------------------------------------------------
  // Layout

  return (
    <box flexDirection="column" width="100%" height="100%">
      <StatusLine
        mode={mode}
        info={info}
        connection={() => shell.state.connection}
        server={() => {
          const connection = shell.state.connection;
          return serverDisplayName(
            backend.server(),
            connection.state === "connected" ? connection.environmentLabel : null,
          );
        }}
        notice={ui.notice}
        pendingKeys={ui.pendingKeys}
        width={() => dimensions().width}
        now={now}
      />
      <Show
        when={threadId() !== null}
        fallback={
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={colors.dim}>{NO_THREAD_PLACEHOLDER}</text>
          </box>
        }
      >
        <Show when={thread.state.phase === "loading" && items().length === 0}>
          <text fg={colors.dim}> loading thread…</text>
        </Show>
        <Show when={thread.state.phase === "error"}>
          <text
            fg={colors.error}
          >{` could not load this thread: ${thread.state.error ?? "unknown error"}`}</text>
        </Show>
        <Transcript
          items={items}
          hasMoreHistory={() => thread.state.hasMoreHistory}
          ui={ui}
          ctx={rowContext}
          controller={(controller) => {
            transcript = controller;
          }}
        />
      </Show>
      <Show when={otherRequest()}>
        {(request: Accessor<PendingOtherRequest>) => (
          <text fg={colors.warn} flexShrink={0}>
            {` pending ${request().requestKind} request (cannot be answered from t3tui)`}
          </text>
        )}
      </Show>
      <Composer
        visible={() => !promptShown() || mode() === "insert"}
        focused={() => mode() === "insert"}
        ref={(element) => {
          textarea = element;
        }}
      />
      <Show when={answerable()}>
        {(request: Accessor<AnswerableRequest>) => (
          <RequestPrompt
            request={request}
            focused={() => promptActive() && armed()}
            progress={progress}
            textMode={textMode}
          />
        )}
      </Show>
      <Show
        when={ui.confirm()}
        fallback={
          <Show
            when={lineKind()}
            fallback={
              <text fg={colors.faint} flexShrink={0} wrapMode="none">
                {` ${hint()}`}
              </text>
            }
          >
            {(kind: Accessor<"command" | "search" | "input">) => (
              <PromptLine
                prefix={() =>
                  kind() === "command"
                    ? ":"
                    : kind() === "search"
                      ? "/"
                      : (inputPrompt()?.prefix ?? "> ")
                }
                ref={(element) => {
                  lineInput = element;
                }}
              />
            )}
          </Show>
        }
      >
        {(pending: Accessor<Confirm>) => <ConfirmLine message={() => pending().message} />}
      </Show>
      <Switch>
        <Match when={ui.view() === "threads"}>
          <ThreadPicker
            rows={() => pickerList().rows}
            cursorRow={pickerCursorRow}
            projectTitle={() => {
              const projectId = threadProject();
              return projectId === null
                ? null
                : (shell.state.projects[projectId]?.title ?? projectId);
            }}
            showArchived={showArchived}
            initialFilter={untrack(pickerFilter)}
            onFilter={onFilter}
            inputRef={(element) => {
              filterInput = element;
            }}
            width={() => dimensions().width}
            height={() => dimensions().height}
          />
        </Match>
        <Match when={ui.view() === "projects"}>
          <ProjectPicker
            title={() => (projectPurpose() === "new" ? "New thread · project" : "Projects")}
            rows={() => pickerList().rows}
            cursorRow={pickerCursorRow}
            initialFilter={untrack(pickerFilter)}
            onFilter={onFilter}
            inputRef={(element) => {
              filterInput = element;
            }}
            width={() => dimensions().width}
            height={() => dimensions().height}
          />
        </Match>
        <Match when={ui.view() === "models"}>
          <ModelPicker
            title={() => (modelPurpose() === "new" ? "New thread · model" : "Model")}
            rows={() => pickerList().rows}
            cursorRow={pickerCursorRow}
            loading={() => catalog() === null}
            initialFilter={untrack(pickerFilter)}
            onFilter={onFilter}
            inputRef={(element) => {
              filterInput = element;
            }}
            width={() => dimensions().width}
            height={() => dimensions().height}
          />
        </Match>
        <Match when={ui.view() === "modes"}>
          <ModePicker
            rows={() => pickerList().rows}
            cursorRow={pickerCursorRow}
            width={() => dimensions().width}
            height={() => dimensions().height}
          />
        </Match>
        <Match when={ui.view() === "servers"}>
          <ServerPicker
            rows={() => pickerList().rows}
            cursorRow={pickerCursorRow}
            loading={() => serverEntries() === null}
            width={() => dimensions().width}
            height={() => dimensions().height}
          />
        </Match>
        <Match when={ui.view() === "queue"}>
          <QueueView
            rows={() => pickerList().rows}
            cursorRow={pickerCursorRow}
            width={() => dimensions().width}
            height={() => dimensions().height}
          />
        </Match>
      </Switch>
      <Show when={ui.view() === "help"}>
        <HelpOverlay
          ref={(element) => {
            helpScroll = element;
          }}
        />
      </Show>
    </box>
  );
}
