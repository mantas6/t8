/**
 * The pending runtime request, shown in place of the input so it cannot be
 * missed: an approval with its options, or the current user-input question.
 */
import { type Accessor, For, Match, Show, Switch } from "solid-js";

import type { PendingApproval, PendingUserInput } from "../../state/types.ts";
import { colors } from "../theme.ts";

export interface UserInputProgress {
  /** Index of the question being answered. */
  readonly question: number;
  /** Option numbers (1-based) toggled on for a multi-select question. */
  readonly selected: ReadonlyArray<number>;
}

/** Index of the option `y` picks: the first accept-like decision. */
export function approveOptionIndex(request: PendingApproval): number {
  return request.options.findIndex((option) => option.decision.startsWith("accept"));
}

/** Index of the option `n` picks: decline, else cancel. */
export function denyOptionIndex(request: PendingApproval): number {
  const decline = request.options.findIndex((option) => option.decision === "decline");
  return decline !== -1
    ? decline
    : request.options.findIndex((option) => option.decision === "cancel");
}

function ApprovalBody(props: { request: PendingApproval }) {
  const subject = () => props.request.subject ?? props.request.prompt ?? props.request.requestKind;
  const detail = () => {
    const prompt = props.request.prompt;
    const lines = [prompt !== null && prompt !== subject() ? prompt : null, props.request.reason];
    return lines.filter((line): line is string => line !== null && line.trim() !== "").join("\n");
  };
  const approve = () => approveOptionIndex(props.request);
  const deny = () => denyOptionIndex(props.request);
  return (
    <box flexDirection="column">
      <text fg={colors.fg}>{subject()}</text>
      <Show when={detail() !== ""}>
        <text fg={colors.dim}>{detail()}</text>
      </Show>
      <text wrapMode="word">
        <For each={props.request.options}>
          {(option, index) => (
            <span
              style={{
                fg:
                  index() === approve() ? colors.ok : index() === deny() ? colors.error : colors.fg,
              }}
            >
              {`[${index() + 1}] ${option.label}${index() === approve() ? " (y)" : index() === deny() ? " (n)" : ""}   `}
            </span>
          )}
        </For>
      </text>
    </box>
  );
}

/** How typed text answers the request: see `textAnswerMode` in `App.tsx`. */
export type TextAnswerMode = "answer" | "message" | null;

function UserInputBody(props: {
  request: PendingUserInput;
  progress: UserInputProgress;
  textMode: TextAnswerMode;
}) {
  const question = () => props.request.questions[props.progress.question];
  const total = () => props.request.questions.length;
  return (
    <Show
      when={question()}
      fallback={
        <text fg={colors.dim}>
          {props.textMode === "message"
            ? "The provider asked for input without questions. Answer with a normal message (i)."
            : "The provider asked for input without questions. y continues."}
        </text>
      }
    >
      {(current: Accessor<PendingUserInput["questions"][number]>) => (
        <box flexDirection="column">
          <text fg={colors.dim}>
            {total() > 1 ? `Question ${props.progress.question + 1}/${total()} · ` : ""}
            {current().header}
            {current().multiSelect === true ? " · pick several, then y" : ""}
          </text>
          <text fg={colors.fg}>{current().question}</text>
          <For each={current().options}>
            {(option, index) => {
              const selected = () => props.progress.selected.includes(index() + 1);
              return (
                <text fg={selected() ? colors.ok : colors.fg}>
                  {`[${index() + 1}]${selected() ? "*" : " "} ${option.label}`}
                  <span style={{ fg: colors.dim }}>
                    {option.description ? ` — ${option.description}` : ""}
                  </span>
                </text>
              );
            }}
          </For>
          <Show when={props.textMode !== null}>
            <text fg={colors.faint}>
              {props.textMode === "answer"
                ? current().options.length === 0
                  ? "Press i to type the answer."
                  : "Or press i to type your own answer."
                : "You can also answer with a normal message (i)."}
            </text>
          </Show>
        </box>
      )}
    </Show>
  );
}

export function RequestPrompt(props: {
  request: Accessor<PendingApproval | PendingUserInput>;
  focused: Accessor<boolean>;
  progress: Accessor<UserInputProgress>;
  textMode: Accessor<TextAnswerMode>;
}) {
  const title = () => {
    const request = props.request();
    return request.type === "approval"
      ? ` Approval needed · ${request.title ?? request.requestKind} `
      : " Input requested ";
  };
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={props.focused() ? colors.promptBorder : colors.faint}
      title={title()}
      titleColor={props.focused() ? colors.promptBorder : colors.dim}
      paddingLeft={1}
      paddingRight={1}
    >
      <Switch>
        <Match when={props.request().type === "approval" && (props.request() as PendingApproval)}>
          {(request: Accessor<PendingApproval>) => <ApprovalBody request={request()} />}
        </Match>
        <Match
          when={props.request().type === "user_input" && (props.request() as PendingUserInput)}
        >
          {(request: Accessor<PendingUserInput>) => (
            <UserInputBody
              request={request()}
              progress={props.progress()}
              textMode={props.textMode()}
            />
          )}
        </Match>
      </Switch>
    </box>
  );
}
