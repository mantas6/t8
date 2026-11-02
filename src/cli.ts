/**
 * Headless CLI over the connection and command layers.
 *
 * Usage: bun run cli <command> [args] [--server <url>] [--token-file <path>] [--json | --raw]
 * Run `bun run cli --help` for the command list.
 */
import { parseArgs } from "node:util";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  archiveThread,
  createThread,
  type DeliveryIntent,
  interruptRun,
  sendMessage,
} from "./commands.ts";
import { ConfigError, loadConfig, type ResolvedConfig } from "./config.ts";
import * as ConnectionModule from "./connection/connection.ts";
import { Connection, describeStatus } from "./connection/connection.ts";
import { fetchEnvironment, summarizeEnvironment } from "./connection/environment.ts";

const USAGE = `t3tui-cli: headless client for a T3 Code server

Usage: bun run cli <command> [args] [options]

Commands:
  env                          Check the server and its protocol version
  shell                        Print projects and threads, then stream shell events
  tail <threadId>              Print a thread snapshot, then stream its events
       [--until-idle]          Exit once an active run has finished
  send <threadId> <text...>    Send a message
       [--intent auto|steer|restart|queue]
  interrupt <threadId>         Stop the thread's active work
       [--run <runId>]         Interrupt one specific run instead
  create <projectId>           Create an empty thread, print its id
       [--title <title>] [--provider <instanceId> --model <model>]
       [--runtime-mode approval-required|auto-accept-edits|auto|full-access]
  archive <threadId>           Archive a thread

Options:
  --server <url>               Server URL (env T3TUI_SERVER, default http://localhost:3773)
  --token-file <path>          Bearer token file (env T3TUI_TOKEN / T3TUI_TOKEN_FILE)
  --json                       Print one JSON object per line (summaries)
  --raw                        Print one JSON object per line (full decoded stream items)
  -h, --help                   Show this help

Config file: $XDG_CONFIG_HOME/t3tui/config.json ({ "server": ..., "tokenFile": ... })
`;

const CONNECT_TIMEOUT = "20 seconds";

type OutputMode = "text" | "json" | "raw";

class UsageError extends Error {
  override readonly name = "UsageError";
}

// ---------------------------------------------------------------------------
// Output helpers

function snippet(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function line(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function info(message: string): void {
  process.stderr.write(`${message}\n`);
}

function threadSummary(thread: OrchestrationV2ThreadShell) {
  return {
    id: thread.id,
    title: thread.title,
    status: thread.status,
    projectId: thread.projectId,
    model: `${thread.modelSelection.instanceId}/${thread.modelSelection.model}`,
    pendingRequest: thread.pendingRuntimeRequest?.kind ?? null,
    archived: thread.archivedAt !== null,
  };
}

function turnItemSummary(item: OrchestrationV2TurnItem) {
  const base = { id: item.id, type: item.type, status: item.status, runId: item.runId };
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return {
        ...base,
        text: snippet(item.text),
        ...("streaming" in item ? { streaming: item.streaming } : {}),
      };
    case "command_execution":
      return { ...base, input: snippet(item.input), exitCode: item.exitCode ?? null };
    case "file_change":
      return { ...base, fileName: item.fileName };
    default:
      return { ...base, title: item.title };
  }
}

function eventSummary(event: OrchestrationV2DomainEvent): Record<string, unknown> {
  const base = { type: event.type, runId: event.runId ?? null };
  switch (event.type) {
    case "run.created":
    case "run.updated":
      return {
        ...base,
        run: event.payload.id,
        ordinal: event.payload.ordinal,
        status: event.payload.status,
      };
    case "run-attempt.created":
    case "run-attempt.updated":
      return { ...base, attempt: event.payload.id, status: event.payload.status };
    case "node.updated":
      return {
        ...base,
        node: event.payload.id,
        kind: event.payload.kind,
        status: event.payload.status,
      };
    case "turn-item.updated":
      return { ...base, item: turnItemSummary(event.payload) };
    case "message.updated":
      return {
        ...base,
        message: event.payload.id,
        role: event.payload.role,
        streaming: event.payload.streaming,
        text: snippet(event.payload.text),
      };
    case "runtime-request.updated":
      return {
        ...base,
        request: event.payload.id,
        kind: event.payload.kind,
        status: event.payload.status,
      };
    case "provider-session.attached":
    case "provider-session.updated":
    case "provider-thread.updated":
    case "provider-turn.updated":
      return { ...base, id: event.payload.id, status: event.payload.status };
    default:
      if ("payload" in event && typeof event.payload === "object" && "title" in event.payload) {
        return { ...base, title: event.payload.title };
      }
      return base;
  }
}

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([key, value]) => key !== "type" && value !== null && value !== undefined)
    .map(([key, value]) =>
      typeof value === "object"
        ? `${key}={${formatFields(value as Record<string, unknown>)}}`
        : `${key}=${String(value)}`,
    )
    .join(" ");
}

function projectionSummary(projection: OrchestrationV2ThreadProjection) {
  return {
    thread: {
      id: projection.thread.id,
      title: projection.thread.title,
      projectId: projection.thread.projectId,
      model: `${projection.thread.modelSelection.instanceId}/${projection.thread.modelSelection.model}`,
      runtimeMode: projection.thread.runtimeMode,
      archived: projection.thread.archivedAt !== null,
    },
    runs: projection.runs.map((run) => ({ id: run.id, ordinal: run.ordinal, status: run.status })),
    turnItems: projection.turnItems.map(turnItemSummary),
    pendingRequests: projection.runtimeRequests
      .filter((request) => request.status === "pending")
      .map((request) => ({ id: request.id, kind: request.kind, createdAt: request.createdAt })),
  };
}

// ---------------------------------------------------------------------------
// Connection helpers

/** Logs status transitions to stderr until the surrounding scope ends. */
const logStatus = Effect.gen(function* () {
  const connection = yield* Connection;
  yield* SubscriptionRef.changes(connection.status).pipe(
    Stream.map(describeStatus),
    Stream.changes,
    Stream.runForEach((status) => Effect.sync(() => info(`[connection] ${status}`))),
    Effect.forkScoped,
  );
});

/** Waits for a session with a deadline, for one-shot commands. */
const sessionWithTimeout = Effect.gen(function* () {
  const connection = yield* Connection;
  return yield* connection.session.pipe(
    Effect.timeoutOrElse({
      duration: CONNECT_TIMEOUT,
      orElse: () =>
        SubscriptionRef.get(connection.status).pipe(
          Effect.flatMap((status) =>
            Effect.fail(new Error(`could not connect: ${describeStatus(status)}`)),
          ),
        ),
    }),
  );
});

// ---------------------------------------------------------------------------
// Commands

const envCommand = (config: ResolvedConfig, mode: OutputMode) =>
  fetchEnvironment(config.serverUrl).pipe(
    Effect.flatMap((descriptor) =>
      Effect.sync(() => {
        const summary = summarizeEnvironment(config.serverUrl, descriptor);
        if (mode === "raw") line(descriptor);
        else if (mode === "json") line(summary);
        else {
          line(`server:        ${summary.server}`);
          line(`serverVersion: ${summary.serverVersion}`);
          line(
            `protocol:      ${summary.serverProtocol ?? "(not reported)"} (client: ${summary.clientProtocol})`,
          );
          line(`environment:   ${summary.environment.label} (${summary.environment.id})`);
          line(`platform:      ${summary.platform}`);
          line(summary.compatible ? "ok: protocol versions match" : "error: protocol mismatch");
        }
        return summary.compatible;
      }),
    ),
    Effect.flatMap((compatible) =>
      compatible ? Effect.void : Effect.fail(new Error("orchestration protocol mismatch")),
    ),
  );

const shellCommand = (mode: OutputMode) =>
  Effect.gen(function* () {
    const connection = yield* Connection;
    yield* logStatus;
    let lastSequence: number | undefined;
    const projectTitles = new Map<string, string>();
    const print = (item: OrchestrationV2ShellStreamItem) =>
      Effect.sync(() => {
        if (mode === "raw") return line(item);
        switch (item.kind) {
          case "synchronized":
            return mode === "json" ? line({ kind: item.kind }) : info("[shell] synchronized");
          case "snapshot": {
            const { snapshot } = item;
            for (const project of snapshot.projects) projectTitles.set(project.id, project.title);
            // A snapshot carrying resolvedRepositoryIdentityRoots is not authoritative: it only
            // patches repository identity onto the listed projects (threads are always empty).
            if (item.resolvedRepositoryIdentityRoots !== undefined) {
              return mode === "json"
                ? line({
                    kind: "snapshot-enrichment",
                    snapshotSequence: snapshot.snapshotSequence,
                    projectIds: snapshot.projects.map((p) => p.id),
                  })
                : info(
                    `[shell] repository identity resolved for ${snapshot.projects.length} project(s)`,
                  );
            }
            if (mode === "json") {
              return line({
                kind: "snapshot",
                snapshotSequence: snapshot.snapshotSequence,
                projects: snapshot.projects.map((p) => ({
                  id: p.id,
                  title: p.title,
                  workspaceRoot: p.workspaceRoot,
                })),
                threads: snapshot.threads.map(threadSummary),
                archivedThreadCount: snapshot.archivedThreads.length,
              });
            }
            line(`projects (${snapshot.projects.length}):`);
            for (const p of snapshot.projects) line(`  ${p.id}  ${p.title}  ${p.workspaceRoot}`);
            line(
              `threads (${snapshot.threads.length} active, ${snapshot.archivedThreads.length} archived):`,
            );
            for (const t of snapshot.threads) {
              const project = projectTitles.get(t.projectId) ?? t.projectId;
              line(`  ${t.id}  ${t.status.padEnd(9)}  [${project}]  ${t.title}`);
            }
            return line(
              `-- snapshot at sequence ${snapshot.snapshotSequence}; streaming events --`,
            );
          }
          case "project.updated":
            projectTitles.set(item.project.id, item.project.title);
            return mode === "json"
              ? line({
                  kind: item.kind,
                  sequence: item.sequence,
                  id: item.project.id,
                  title: item.project.title,
                })
              : line(`#${item.sequence} project.updated ${item.project.id} ${item.project.title}`);
          case "project.removed":
            return mode === "json"
              ? line({ kind: item.kind, sequence: item.sequence, id: item.projectId })
              : line(`#${item.sequence} project.removed ${item.projectId}`);
          case "thread.updated":
            return mode === "json"
              ? line({
                  kind: item.kind,
                  sequence: item.sequence,
                  location: item.location,
                  thread: threadSummary(item.thread),
                })
              : line(
                  `#${item.sequence} thread.updated (${item.location}) ${item.thread.id} status=${item.thread.status} title=${JSON.stringify(item.thread.title)}`,
                );
          case "thread.removed":
            return mode === "json"
              ? line({
                  kind: item.kind,
                  sequence: item.sequence,
                  location: item.location,
                  id: item.threadId,
                })
              : line(`#${item.sequence} thread.removed (${item.location}) ${item.threadId}`);
        }
      });
    yield* connection
      .subscribe(({ client }) =>
        client[ORCHESTRATION_V2_WS_METHODS.subscribeShell](
          lastSequence === undefined ? {} : { afterSequence: lastSequence },
        ),
      )
      .pipe(
        Stream.filter((item) => {
          // Replays after a reconnect can overlap; dedupe by sequence.
          if ("sequence" in item) {
            if (lastSequence !== undefined && item.sequence <= lastSequence) return false;
            lastSequence = item.sequence;
          } else if (item.kind === "snapshot") {
            lastSequence = item.snapshot.snapshotSequence;
          }
          return true;
        }),
        Stream.runForEach(print),
      );
  }).pipe(Effect.scoped);

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const tailCommand = (threadId: ThreadId, mode: OutputMode, untilIdle: boolean) =>
  Effect.gen(function* () {
    const connection = yield* Connection;
    yield* logStatus;
    let lastSequence: number | undefined;
    const runStatus = new Map<string, string>();
    let sawActiveRun = false;
    const isIdle = () =>
      sawActiveRun && [...runStatus.values()].every((status) => TERMINAL_RUN_STATUSES.has(status));

    const print = (item: OrchestrationV2ThreadStreamItem) =>
      Effect.sync(() => {
        if (mode === "raw") return line(item);
        switch (item.kind) {
          case "synchronized":
            return mode === "json" ? line({ kind: item.kind }) : info("[thread] synchronized");
          case "snapshot": {
            const summary = projectionSummary(item.projection);
            if (mode === "json") {
              return line({
                kind: "snapshot",
                snapshotSequence: item.snapshotSequence,
                ...summary,
              });
            }
            const t = summary.thread;
            line(
              `thread ${t.id}  ${JSON.stringify(t.title)}  model=${t.model}  runtimeMode=${t.runtimeMode}${t.archived ? "  (archived)" : ""}`,
            );
            line(`runs (${summary.runs.length}):`);
            for (const run of summary.runs) line(`  #${run.ordinal} ${run.id} ${run.status}`);
            line(`turn items (${summary.turnItems.length}):`);
            for (const turnItem of summary.turnItems)
              line(`  ${turnItem.type} ${formatFields(turnItem)}`);
            line(`pending requests (${summary.pendingRequests.length}):`);
            for (const request of summary.pendingRequests) line(`  ${request.id} ${request.kind}`);
            return line(`-- snapshot at sequence ${item.snapshotSequence}; streaming events --`);
          }
          case "event": {
            const summary = eventSummary(item.event);
            return mode === "json"
              ? line({ kind: "event", sequence: item.sequence, ...summary })
              : line(`#${item.sequence} ${item.event.type} ${formatFields(summary)}`);
          }
          case "unknown-event":
            return mode === "json"
              ? line(item)
              : line(`#${item.sequence} ${item.eventType} (unknown to this client)`);
        }
      });

    const track = (item: OrchestrationV2ThreadStreamItem) => {
      if (item.kind === "snapshot") {
        runStatus.clear();
        for (const run of item.projection.runs) runStatus.set(run.id, run.status);
      } else if (
        item.kind === "event" &&
        (item.event.type === "run.created" || item.event.type === "run.updated")
      ) {
        runStatus.set(item.event.payload.id, item.event.payload.status);
      }
      for (const status of runStatus.values()) {
        if (!TERMINAL_RUN_STATUSES.has(status)) sawActiveRun = true;
      }
    };

    yield* connection
      .subscribe(({ client }) =>
        client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
          threadId,
          ...(lastSequence === undefined ? {} : { afterSequence: lastSequence }),
        }),
      )
      .pipe(
        Stream.filter((item) => {
          if (item.kind === "event" || item.kind === "unknown-event") {
            if (lastSequence !== undefined && item.sequence <= lastSequence) return false;
            lastSequence = item.sequence;
          } else if (item.kind === "snapshot") {
            lastSequence = item.snapshotSequence;
          }
          return true;
        }),
        Stream.tap((item) =>
          Effect.andThen(
            print(item),
            Effect.sync(() => track(item)),
          ),
        ),
        Stream.takeUntil(() => untilIdle && isIdle()),
        Stream.runDrain,
      );
  }).pipe(Effect.scoped);

const oneShot = <A, E>(
  effect: Effect.Effect<A, E, Connection>,
  render: (result: A) => unknown,
  mode: OutputMode,
) =>
  Effect.gen(function* () {
    yield* sessionWithTimeout;
    const result = yield* effect;
    const rendered = render(result);
    line(mode === "text" ? formatFields(rendered as Record<string, unknown>) : rendered);
  });

// ---------------------------------------------------------------------------
// Entry point

function parse(argv: ReadonlyArray<string>) {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      server: { type: "string" },
      "token-file": { type: "string" },
      token: { type: "string" },
      json: { type: "boolean", default: false },
      raw: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      "until-idle": { type: "boolean", default: false },
      intent: { type: "string", default: "auto" },
      run: { type: "string" },
      title: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "runtime-mode": { type: "string" },
    },
  });
  if (values.token !== undefined) {
    throw new UsageError(
      "--token is not supported: argv is visible to other processes. Use --token-file or T3TUI_TOKEN.",
    );
  }
  return { values, positionals };
}

function requireArg(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) throw new UsageError(`missing <${name}>`);
  return value;
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(process.argv.slice(2));
  } catch (cause) {
    info(`t3tui-cli: ${(cause as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;
  if (values.help || command === undefined) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }
  const mode: OutputMode = values.raw ? "raw" : values.json ? "json" : "text";

  let config: ResolvedConfig;
  try {
    config = await loadConfig({ server: values.server, tokenFile: values["token-file"] });
  } catch (cause) {
    info(`t3tui-cli: ${(cause as Error).message}`);
    return cause instanceof ConfigError ? 2 : 1;
  }

  let program: Effect.Effect<void, unknown, Connection>;
  try {
    switch (command) {
      case "env":
        program = envCommand(config, mode);
        break;
      case "shell":
        program = shellCommand(mode);
        break;
      case "tail":
        program = tailCommand(
          ThreadId.make(requireArg(args[0], "threadId")),
          mode,
          values["until-idle"],
        );
        break;
      case "send": {
        const threadId = ThreadId.make(requireArg(args[0], "threadId"));
        const text = requireArg(args.slice(1).join(" "), "text");
        const intent = values.intent as DeliveryIntent;
        if (!["auto", "steer", "restart", "queue"].includes(intent)) {
          throw new UsageError(`invalid --intent: ${intent}`);
        }
        program = oneShot(
          sendMessage(threadId, text, intent),
          (r) => ({ sequence: r.sequence, messageId: r.messageId }),
          mode,
        );
        break;
      }
      case "interrupt": {
        const threadId = ThreadId.make(requireArg(args[0], "threadId"));
        const runId = values.run === undefined ? undefined : RunId.make(values.run);
        program = oneShot(interruptRun(threadId, runId), (r) => r, mode);
        break;
      }
      case "create": {
        const projectId = ProjectId.make(requireArg(args[0], "projectId"));
        if ((values.provider === undefined) !== (values.model === undefined)) {
          throw new UsageError("--provider and --model must be given together");
        }
        const runtimeMode =
          values["runtime-mode"] === undefined
            ? undefined
            : Schema.decodeUnknownSync(RuntimeMode)(values["runtime-mode"]);
        program = oneShot(
          createThread(projectId, {
            ...(values.title === undefined ? {} : { title: values.title }),
            ...(values.provider === undefined || values.model === undefined
              ? {}
              : {
                  modelSelection: {
                    instanceId: ProviderInstanceId.make(values.provider),
                    model: values.model,
                  },
                }),
            ...(runtimeMode === undefined ? {} : { runtimeMode }),
          }),
          (r) => ({ threadId: r.threadId, sequence: r.sequence }),
          mode,
        );
        break;
      }
      case "archive": {
        const threadId = ThreadId.make(requireArg(args[0], "threadId"));
        program = oneShot(archiveThread(threadId), (r) => r, mode);
        break;
      }
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (cause) {
    info(`t3tui-cli: ${(cause as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const runnable =
    command === "env"
      ? (program as Effect.Effect<void, unknown>)
      : program.pipe(Effect.provide(ConnectionModule.layer(config)));
  const fiber = Effect.runFork(runnable);
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    Effect.runFork(Fiber.interrupt(fiber));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const exit = await Effect.runPromise(Fiber.await(fiber));
  if (Exit.isSuccess(exit)) return 0;
  if (interrupted && Cause.hasInterruptsOnly(exit.cause)) return 130;
  const error = Cause.squash(exit.cause);
  info(`t3tui-cli: ${errorText(error)}`);
  return 1;
}

function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as { _tag?: unknown; message?: unknown };
    const message =
      typeof record.message === "string" && record.message.length > 0
        ? record.message
        : String(error);
    return typeof record._tag === "string" ? `${record._tag}: ${message}` : message;
  }
  return String(error);
}

process.exitCode = await main();
