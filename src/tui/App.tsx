/**
 * The full-screen TUI: status line, transcript, and the input (or the
 * pending request prompt) with a hint line. All keys go through one global
 * handler that runs the vim-style keymaps (`keymap.ts`) through the
 * prefix/count state machine (`keys.ts`) and dispatches actions.
 */
import type {
  InputRenderable,
  KeyEvent,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import type { ThreadId } from "@t3tools/contracts";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";

import type { DeliveryIntent } from "../commands.ts";
import type {
  DisplayItem,
  PendingApproval,
  PendingOtherRequest,
  PendingUserInput,
  ToolCallDisplayItem,
} from "../state/types.ts";
import { type Backend, describeError } from "./backend.ts";
import { copyToClipboard } from "./clipboard.ts";
import { type Command, parseCommandLine, WRITE_MESSAGE } from "./cmdline.ts";
import { Composer } from "./components/Composer.tsx";
import { HelpOverlay } from "./components/HelpOverlay.tsx";
import { PromptLine } from "./components/PromptLine.tsx";
import {
  approveOptionIndex,
  denyOptionIndex,
  RequestPrompt,
  type UserInputProgress,
} from "./components/RequestPrompt.tsx";
import { type StatusInfo, StatusLine } from "./components/StatusLine.tsx";
import { Transcript, type TranscriptController } from "./components/Transcript.tsx";
import type { RowContext, ToolResultState } from "./components/TranscriptItem.tsx";
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
  stepThread,
} from "./nav.ts";
import { colors, createSyntaxStyle, SPINNER_FRAMES } from "./theme.ts";
import { createUiState, type Mode } from "./view.ts";

export const NO_THREAD_PLACEHOLDER = "No thread open. Press : then t to pick a thread";

const DOUBLE_CTRL_C_MS = 1_000;

export interface AppProps {
  readonly backend: Backend;
  readonly initialThreadId?: ThreadId | null;
  readonly onQuit: () => void;
  readonly keymaps?: CompiledKeymaps;
  /** Background problems (sync errors) to show in the status line; returns an unsubscribe. */
  readonly subscribeErrors?: (listener: (message: string) => void) => () => void;
}

type AnswerableRequest = PendingApproval | PendingUserInput;

interface InputProgressState extends UserInputProgress {
  readonly answers: Readonly<Record<string, unknown>>;
}

const EMPTY_PROGRESS: InputProgressState = { question: 0, selected: [], answers: {} };

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
  let helpScroll: ScrollBoxRenderable | undefined;
  let sequenceTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCtrlC = 0;

  const unsubscribeErrors = props.subscribeErrors?.((message) =>
    ui.setNotice(message, "error", 6_000),
  );
  onCleanup(() => {
    unsubscribeErrors?.();
    ui.dispose();
    if (sequenceTimer !== undefined) clearTimeout(sequenceTimer);
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
    return view === "command" || view === "search" ? view : null;
  };
  const mode = (): Mode => (lineKind() !== null ? "command" : ui.mode());

  const [progress, setProgress] = createSignal<InputProgressState>(EMPTY_PROGRESS);
  createEffect(
    on(
      () => answerable()?.requestId,
      (id, previous) => {
        if (id === undefined || id === previous) return;
        // A new request takes the keyboard; the draft stays in the hidden input.
        setProgress(EMPTY_PROGRESS);
        ui.setPromptFocused(true);
        if (ui.mode() === "insert") ui.setMode("normal");
      },
    ),
  );

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
    if (mode() === "insert") {
      return "Enter send · Shift-Enter/Ctrl-J newline · Ctrl-S steer · Esc normal · Ctrl-C clear";
    }
    const request = answerable();
    if (request !== undefined && promptActive()) {
      return request.type === "approval"
        ? `y approve · n deny · 1-${request.options.length} pick · Esc back to the transcript`
        : "1-9 answer · y submit selection · Esc back to the transcript";
    }
    if (request !== undefined) return "Enter back to the request · :a approve · :d deny · ? help";
    if (threadId() === null) return ": command · ? help · Ctrl-C twice to quit";
    return "i write · j/k scroll · ]] [[ messages · ]t [t tools · za fold · y yank · / search · : cmd · ? help";
  };

  // -------------------------------------------------------------------------
  // Actions

  const notice = ui.setNotice;

  const openThread = (id: ThreadId) => {
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
    if (promptShown()) {
      notice("answer the request first: y / n, or :a / :d", "warn");
      return;
    }
    if (empty) textarea?.setText("");
    ui.setMode("insert");
  };

  const send = (intent: DeliveryIntent) => {
    const id = threadId();
    const text = (textarea?.plainText ?? "").trim();
    if (text === "") return;
    if (id === null) {
      notice("no thread open", "warn");
      return;
    }
    textarea?.setText("");
    transcript?.toBottom();
    backend.send(id, text, intent).then(
      () => {
        if (intent === "steer") notice("steered");
      },
      (error) => {
        if (textarea !== undefined && textarea.plainText === "") textarea.setText(text);
        notice(`send failed: ${describeError(error)}`, "error", 6_000);
      },
    );
  };

  const respond = (
    request: AnswerableRequest,
    response: Parameters<Backend["respond"]>[2],
    label: string,
  ) => {
    const id = threadId();
    if (id === null) return;
    backend.respond(id, request.requestId, response).then(
      () => notice(label),
      (error) => notice(`response failed: ${describeError(error)}`, "error", 6_000),
    );
  };

  const decide = (request: PendingApproval, index: number) => {
    const option = request.options[index];
    if (option === undefined) {
      notice(`no option ${index + 1}`, "warn");
      return;
    }
    respond(request, { decision: option.decision }, option.label);
  };

  /** Records an answer for the current question; responds once all are answered. */
  const answer = (request: PendingUserInput, value: unknown) => {
    const current = progress();
    const question = request.questions[current.question];
    if (question === undefined) return;
    const answers = { ...current.answers, [question.id]: value };
    if (current.question + 1 < request.questions.length) {
      setProgress({ question: current.question + 1, selected: [], answers });
      return;
    }
    setProgress(EMPTY_PROGRESS);
    respond(request, { answers }, "answered");
  };

  const optionValue = (option: { readonly label: string; readonly value?: string | undefined }) =>
    option.value ?? option.label;

  const approve = () => {
    const request = answerable();
    if (request === undefined) {
      notice("no pending request", "warn");
      return;
    }
    if (request.type === "approval") {
      decide(request, Math.max(0, approveOptionIndex(request)));
      return;
    }
    const question = request.questions[progress().question];
    if (question?.multiSelect === true && progress().selected.length > 0) {
      const values = progress()
        .selected.map((n) => question.options[n - 1])
        .filter((option) => option !== undefined)
        .map(optionValue);
      answer(request, values);
      return;
    }
    notice(`pick an answer with 1-${question?.options.length ?? 9}`, "warn");
  };

  const deny = () => {
    const request = answerable();
    if (request === undefined) {
      notice("no pending request", "warn");
      return;
    }
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
    answer(request, optionValue(option));
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

  const openLine = (kind: "command" | "search") => ui.setView(kind);
  const closeLine = () => ui.setView("transcript");

  const runCommand = (command: Command) => {
    switch (command.type) {
      case "noop":
        return;
      case "quit":
        props.onQuit();
        return;
      case "write":
        notice(WRITE_MESSAGE);
        return;
      case "approve":
        approve();
        return;
      case "deny":
        deny();
        return;
      case "unknown":
        notice(`unknown command: ${command.name}`, "error");
        return;
    }
  };

  const submitLine = () => {
    const kind = lineKind();
    const text = lineInput?.value ?? "";
    closeLine();
    if (kind === "command") {
      runCommand(parseCommandLine(text));
    } else if (kind === "search") {
      if (text !== "") ui.setSearchQuery(text);
      searchStep(1);
    }
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
    }
  };

  // -------------------------------------------------------------------------
  // Keyboard

  const currentLayer = (): Layer => {
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

  useKeyboard((event: KeyEvent) => {
    if (event.eventType === "release") return;
    const token = keyToken(event);
    if (ui.view() === "help") {
      event.preventDefault();
      handleHelpKey(token);
      return;
    }
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
          const late = sequencer.timeout(keymaps[currentLayer()]);
          ui.setPendingKeys("");
          if (late?.type === "action") runAction(late.binding, late.count);
        }, sequencer.timeoutMs);
        return;
      case "action":
        event.preventDefault();
        runAction(result.binding, result.count);
        return;
      case "unbound":
        event.preventDefault();
        return;
      case "passthrough":
        // Typing goes to the focused input; elsewhere unbound keys do nothing.
        if (layer === "normal" || layer === "prompt") event.preventDefault();
        return;
    }
  });

  // -------------------------------------------------------------------------
  // Layout

  return (
    <box flexDirection="column" width="100%" height="100%">
      <StatusLine
        mode={mode}
        info={info}
        connection={() => shell.state.connection}
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
        visible={() => !promptShown()}
        focused={() => mode() === "insert" && !promptShown()}
        ref={(element) => {
          textarea = element;
        }}
      />
      <Show when={answerable()}>
        {(request: Accessor<AnswerableRequest>) => (
          <RequestPrompt request={request} focused={promptActive} progress={progress} />
        )}
      </Show>
      <Show
        when={lineKind()}
        fallback={
          <text fg={colors.faint} flexShrink={0} wrapMode="none">
            {` ${hint()}`}
          </text>
        }
      >
        {(kind: Accessor<"command" | "search">) => (
          <PromptLine
            prefix={() => (kind() === "command" ? ":" : "/")}
            ref={(element) => {
              lineInput = element;
            }}
          />
        )}
      </Show>
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
