/**
 * One transcript row per display item. Rows are keyed by item id by the
 * parent; each row reads its item through an accessor, so a streaming
 * message updates its own `<markdown>` node in place.
 */
import type { SyntaxStyle } from "@opentui/core";
import { type Accessor, createEffect, For, Match, Show, Switch } from "solid-js";

import type {
  AssistantMessageDisplayItem,
  DisplayItem,
  ErrorDisplayItem,
  NoticeDisplayItem,
  PlanDisplayItem,
  ReasoningDisplayItem,
  RequestDisplayItem,
  SubagentDisplayItem,
  ToolCallDisplayItem,
  UserMessageDisplayItem,
} from "../../state/types.ts";
import { oneLine } from "../nav.ts";
import { colors } from "../theme.ts";

/** Output fetched on demand for a tool call whose result the stream omitted. */
export type ToolResultState =
  | { readonly state: "loading" }
  | { readonly state: "loaded"; readonly text: string | null }
  | { readonly state: "error"; readonly message: string };

export interface RowContext {
  readonly syntax: SyntaxStyle;
  /** Current spinner frame. */
  readonly spinner: Accessor<string>;
  readonly width: Accessor<number>;
  readonly isOpen: (id: string) => boolean;
  readonly toolResult: (id: string) => ToolResultState | undefined;
  readonly loadToolResult: (item: ToolCallDisplayItem) => void;
}

const MAX_RESULT_LINES = 60;

const ACTIVE = new Set(["running", "pending", "waiting"]);

function statusGlyph(status: DisplayItem["status"], spinner: string): { text: string; fg: string } {
  switch (status) {
    case "running":
      return { text: spinner, fg: colors.warn };
    case "pending":
    case "waiting":
      return { text: "…", fg: colors.warn };
    case "completed":
      return { text: "✓", fg: colors.ok };
    case "failed":
      return { text: "✗", fg: colors.error };
    case "cancelled":
    case "interrupted":
      return { text: "⊘", fg: colors.dim };
    case "idle":
      return { text: "·", fg: colors.dim };
  }
}

function clampLines(text: string, max: number): { text: string; hidden: number } {
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines.length <= max) return { text: lines.join("\n"), hidden: 0 };
  return { text: lines.slice(0, max).join("\n"), hidden: lines.length - max };
}

function UserMessage(props: { item: UserMessageDisplayItem }) {
  const intent = () =>
    props.item.inputIntent === "steer" || props.item.inputIntent === "promoted_queued_to_steer"
      ? "steer"
      : props.item.inputIntent === "queued_turn"
        ? "queued"
        : null;
  return (
    <box border={["left"]} borderColor={colors.userBar} paddingLeft={1} flexDirection="column">
      <text fg={colors.user}>{props.item.text}</text>
      <Show when={intent() !== null || props.item.attachmentCount > 0}>
        <text fg={colors.dim}>
          {[
            intent(),
            props.item.attachmentCount > 0 ? `+${props.item.attachmentCount} attachment(s)` : null,
          ]
            .filter((part) => part !== null)
            .join(" · ")}
        </text>
      </Show>
    </box>
  );
}

function AssistantMessage(props: { item: AssistantMessageDisplayItem; ctx: RowContext }) {
  return (
    <box paddingLeft={1} flexDirection="column">
      <markdown
        content={props.item.text}
        streaming={props.item.streaming}
        syntaxStyle={props.ctx.syntax}
        conceal
        fg={colors.fg}
      />
    </box>
  );
}

function ToolCall(props: { item: ToolCallDisplayItem; ctx: RowContext }) {
  const open = () => props.ctx.isOpen(props.item.id);
  const glyph = () => statusGlyph(props.item.status, props.ctx.spinner());
  const fetched = () => props.ctx.toolResult(props.item.id);
  const result = () => {
    if (props.item.result !== null) return props.item.result;
    const state = fetched();
    return state?.state === "loaded" ? state.text : null;
  };
  createEffect(() => {
    if (
      open() &&
      props.item.resultOmitted &&
      props.item.result === null &&
      !ACTIVE.has(props.item.status) &&
      fetched() === undefined
    ) {
      props.ctx.loadToolResult(props.item);
    }
  });
  const header = () => {
    const room = Math.max(10, props.ctx.width() - props.item.name.length - 8);
    return oneLine(props.item.args, room);
  };
  const clamped = () => {
    const text = result();
    return text === null ? null : clampLines(text, MAX_RESULT_LINES);
  };
  const missing = () => {
    if (result() !== null) return null;
    const state = fetched();
    if (state?.state === "loading") return "loading output…";
    if (state?.state === "error") return `output not loaded: ${state.message}`;
    if (props.item.resultOmitted) return "output not loaded";
    return ACTIVE.has(props.item.status) ? null : "no output";
  };
  return (
    <box flexDirection="column">
      <text wrapMode="none">
        <span style={{ fg: colors.faint }}>{open() ? "▾ " : "▸ "}</span>
        <span style={{ fg: glyph().fg }}>{glyph().text} </span>
        <span style={{ fg: colors.accent }}>{props.item.name}</span>
        <span style={{ fg: colors.dim }}> {header()}</span>
        <Show when={props.item.exitCode !== null && props.item.exitCode !== 0}>
          <span style={{ fg: colors.error }}> exit {props.item.exitCode}</span>
        </Show>
      </text>
      <Show when={open()}>
        <box paddingLeft={4} flexDirection="column">
          <text fg={colors.fg}>{props.item.args}</text>
          <Show when={props.item.files.length > 0}>
            <text fg={colors.dim}>{props.item.files.join("\n")}</text>
          </Show>
          <Show when={clamped()}>
            {(value: Accessor<{ text: string; hidden: number }>) => (
              <box flexDirection="column">
                <text fg={colors.dim}>{value().text}</text>
                <Show when={value().hidden > 0}>
                  <text fg={colors.faint}>… {value().hidden} more lines (y copies all)</text>
                </Show>
              </box>
            )}
          </Show>
          <Show when={missing()}>
            {(text: Accessor<string>) => <text fg={colors.faint}>{text()}</text>}
          </Show>
        </box>
      </Show>
    </box>
  );
}

function Reasoning(props: { item: ReasoningDisplayItem; ctx: RowContext }) {
  const open = () => props.ctx.isOpen(props.item.id);
  return (
    <box flexDirection="column">
      <text wrapMode="none" fg={colors.dim}>
        <span style={{ fg: colors.faint }}>{open() ? "▾ " : "▸ "}</span>
        {props.item.streaming ? `${props.ctx.spinner()} thinking…` : "thinking…"}
        <Show when={!open() && !props.item.streaming && props.item.text.trim() !== ""}>
          <span style={{ fg: colors.faint }}>
            {" "}
            {oneLine(props.item.text, Math.max(10, props.ctx.width() - 16))}
          </span>
        </Show>
      </text>
      <Show when={open()}>
        <box paddingLeft={4}>
          <text fg={colors.dim}>{props.item.text}</text>
        </box>
      </Show>
    </box>
  );
}

function Plan(props: { item: PlanDisplayItem; ctx: RowContext }) {
  const mark = (status: string) =>
    status === "completed" ? "[x]" : status === "running" ? "[~]" : "[ ]";
  return (
    <box flexDirection="column">
      <text fg={colors.accent}>
        ◆ {props.item.planKind === "todo_list" ? "Todo" : "Plan"}
        {props.item.title === null ? "" : `: ${props.item.title}`}
      </text>
      <box paddingLeft={2} flexDirection="column">
        <Show when={props.item.explanation}>
          {(text: Accessor<string>) => <text fg={colors.dim}>{text()}</text>}
        </Show>
        <Show
          when={props.item.markdown}
          fallback={
            <For each={props.item.steps}>
              {(step) => (
                <text fg={step.status === "completed" ? colors.dim : colors.fg}>
                  {mark(step.status)} {step.text}
                </text>
              )}
            </For>
          }
        >
          {(markdown: Accessor<string>) => (
            <markdown
              content={markdown()}
              streaming={props.item.streaming}
              syntaxStyle={props.ctx.syntax}
              conceal
              fg={colors.fg}
            />
          )}
        </Show>
      </box>
    </box>
  );
}

function Subagent(props: { item: SubagentDisplayItem; ctx: RowContext }) {
  const detail = () => props.item.result ?? props.item.progress;
  return (
    <box flexDirection="column">
      <text wrapMode="none">
        <span style={{ fg: colors.accent }}>⇢ subagent </span>
        <span style={{ fg: colors.dim }}>
          {oneLine(props.item.prompt, Math.max(10, props.ctx.width() - 14))}
        </span>
      </text>
      <Show when={detail()}>
        {(text: Accessor<string>) => (
          <box paddingLeft={4}>
            <text fg={colors.faint}>{oneLine(text(), Math.max(10, props.ctx.width() - 6))}</text>
          </box>
        )}
      </Show>
    </box>
  );
}

function Request(props: { item: RequestDisplayItem; ctx: RowContext }) {
  return (
    <text wrapMode="none" fg={props.item.open ? colors.warn : colors.dim}>
      ? {props.item.requestType === "approval" ? "approval" : "question"} ({props.item.requestKind})
      {props.item.prompt === null
        ? ""
        : `: ${oneLine(props.item.prompt, Math.max(10, props.ctx.width() - 40))}`}
      {" — "}
      {props.item.open ? "pending" : (props.item.resolution ?? "resolved")}
    </text>
  );
}

function ErrorRow(props: { item: ErrorDisplayItem }) {
  return (
    <text fg={colors.error}>
      ✗ {props.item.label}: {props.item.message}
    </text>
  );
}

function NoticeRow(props: { item: NoticeDisplayItem }) {
  return <text fg={colors.dim}>· {props.item.text}</text>;
}

export function TranscriptItem(props: { item: DisplayItem; ctx: RowContext }) {
  const item = () => props.item;
  return (
    <Switch>
      <Match when={item().kind === "user_message" && (item() as UserMessageDisplayItem)}>
        {(value: Accessor<UserMessageDisplayItem>) => <UserMessage item={value()} />}
      </Match>
      <Match when={item().kind === "assistant_message" && (item() as AssistantMessageDisplayItem)}>
        {(value: Accessor<AssistantMessageDisplayItem>) => (
          <AssistantMessage item={value()} ctx={props.ctx} />
        )}
      </Match>
      <Match when={item().kind === "tool_call" && (item() as ToolCallDisplayItem)}>
        {(value: Accessor<ToolCallDisplayItem>) => <ToolCall item={value()} ctx={props.ctx} />}
      </Match>
      <Match when={item().kind === "reasoning" && (item() as ReasoningDisplayItem)}>
        {(value: Accessor<ReasoningDisplayItem>) => <Reasoning item={value()} ctx={props.ctx} />}
      </Match>
      <Match when={item().kind === "plan" && (item() as PlanDisplayItem)}>
        {(value: Accessor<PlanDisplayItem>) => <Plan item={value()} ctx={props.ctx} />}
      </Match>
      <Match when={item().kind === "subagent" && (item() as SubagentDisplayItem)}>
        {(value: Accessor<SubagentDisplayItem>) => <Subagent item={value()} ctx={props.ctx} />}
      </Match>
      <Match when={item().kind === "request" && (item() as RequestDisplayItem)}>
        {(value: Accessor<RequestDisplayItem>) => <Request item={value()} ctx={props.ctx} />}
      </Match>
      <Match when={item().kind === "error" && (item() as ErrorDisplayItem)}>
        {(value: Accessor<ErrorDisplayItem>) => <ErrorRow item={value()} />}
      </Match>
      <Match when={item().kind === "notice" && (item() as NoticeDisplayItem)}>
        {(value: Accessor<NoticeDisplayItem>) => <NoticeRow item={value()} />}
      </Match>
    </Switch>
  );
}
