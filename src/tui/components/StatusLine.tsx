/**
 * Top status line: mode block, then project · branch · thread · model · run
 * status (dim), and on the right the notice / pending keys, the
 * connection state and the server (profile name). When not connected a banner row is added below it.
 */
import { type Accessor, Show } from "solid-js";

import type { ConnectionView } from "../../state/types.ts";
import { colors } from "../theme.ts";
import type { Mode, Notice } from "../view.ts";

export interface StatusInfo {
  readonly project: string | null;
  readonly branch: string | null;
  readonly title: string | null;
  readonly model: string | null;
  readonly runStatus: string | null;
}

const MODE_LABEL: Readonly<Record<Mode, string>> = {
  normal: " NORMAL ",
  insert: " INSERT ",
  command: " COMMAND ",
  picker: " PICKER ",
};

const MODE_COLOR: Readonly<Record<Mode, string>> = {
  normal: colors.modeNormal,
  insert: colors.modeInsert,
  command: colors.modeCommand,
  picker: colors.accent,
};

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

export function connectionLabel(connection: ConnectionView, now: number): string {
  switch (connection.state) {
    case "connected":
      return "● connected";
    case "connecting":
      return connection.attempt > 1
        ? `○ connecting (attempt ${connection.attempt})`
        : "○ connecting";
    case "disconnected": {
      const seconds = Math.max(0, Math.ceil((connection.retryAt - now) / 1000));
      return `○ reconnecting in ${seconds}s`;
    }
    case "failed":
      return "✕ connection failed";
  }
}

export function StatusLine(props: {
  mode: Accessor<Mode>;
  info: Accessor<StatusInfo>;
  connection: Accessor<ConnectionView>;
  /** Name of the server (profile); empty to leave it out. */
  server?: Accessor<string>;
  notice: Accessor<Notice | null>;
  pendingKeys: Accessor<string>;
  width: Accessor<number>;
  now: Accessor<number>;
}) {
  const right = () => {
    const label = connectionLabel(props.connection(), props.now());
    const server = props.server?.() ?? "";
    return server === "" ? label : `${label} · ${truncate(server, 32)}`;
  };
  const rightColor = () => {
    switch (props.connection().state) {
      case "connected":
        return colors.ok;
      case "failed":
        return colors.error;
      default:
        return colors.warn;
    }
  };
  const message = () => {
    const keys = props.pendingKeys();
    if (keys !== "") return keys;
    return props.notice()?.text ?? "";
  };
  const messageColor = () => {
    if (props.pendingKeys() !== "") return colors.fg;
    const level = props.notice()?.level;
    return level === "error" ? colors.error : level === "warn" ? colors.warn : colors.fg;
  };
  const center = () => {
    const info = props.info();
    const parts = [info.project, info.branch, info.title, info.model, info.runStatus].filter(
      (part): part is string => part !== null && part !== "",
    );
    const used = MODE_LABEL[props.mode()].length + right().length + 4;
    const notice = message();
    const room = props.width() - used - (notice === "" ? 0 : Math.min(notice.length, 48) + 2);
    return truncate(` ${parts.join(" · ")}`, room);
  };
  const banner = () => {
    const connection = props.connection();
    switch (connection.state) {
      case "connected":
        return null;
      case "connecting":
        return { text: "connecting to the server…", bg: colors.bannerWarnBg };
      case "disconnected": {
        const seconds = Math.max(0, Math.ceil((connection.retryAt - props.now()) / 1000));
        return {
          text: `disconnected: ${connection.reason} · reconnecting in ${seconds}s (attempt ${connection.attempt})`,
          bg: colors.bannerBg,
        };
      }
      case "failed":
        return { text: `connection failed: ${connection.message}`, bg: colors.bannerBg };
    }
  };
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" height={1}>
        <text bg={MODE_COLOR[props.mode()]} fg={colors.modeFg} flexShrink={0}>
          {MODE_LABEL[props.mode()]}
        </text>
        <text fg={colors.dim} flexGrow={1} wrapMode="none">
          {center()}
        </text>
        <Show when={message() !== ""}>
          <text fg={messageColor()} flexShrink={0} wrapMode="none">
            {truncate(message(), 48)}{" "}
          </text>
        </Show>
        <text fg={rightColor()} flexShrink={0} wrapMode="none">
          {right()}{" "}
        </text>
      </box>
      <Show when={banner()}>
        {(value: Accessor<{ text: string; bg: string }>) => (
          <box height={1} backgroundColor={value().bg}>
            <text fg={colors.fg} wrapMode="none">
              {truncate(` ${value().text}`, props.width())}
            </text>
          </box>
        )}
      </Show>
    </box>
  );
}
