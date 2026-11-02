/**
 * What the TUI needs from the outside world: the stores, and promise-based
 * commands. `makeBackend` implements it over an Effect runtime holding
 * `Connection` and `StateSync`; tests pass a fake.
 *
 * Commands do not wait for a connection: unless one comes up within
 * `CONNECT_GRACE`, they fail with `NotConnectedError` so the UI can say so
 * (and keep the draft) instead of running them much later.
 */

import {
  type CommandId,
  isProviderAvailable,
  type MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type RunId,
  type RuntimeMode,
  type RuntimeRequestId,
  type ServerConfig,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { type Accessor, createSignal } from "solid-js";
import {
  archiveThread,
  type Capability,
  cancelQueuedRun,
  createThread,
  type DeliveryIntent,
  fetchTurnItem,
  getArchivedThreads,
  getServerConfig,
  interruptRun,
  type RuntimeRequestResponse,
  reorderQueuedRun,
  respondToRequest,
  sendMessage,
  setAutoSettle,
  setModelSelection,
  setRuntimeMode,
  settleThread,
  snoozeThread,
  supportsCapability,
  unsettleThread,
  unsnoozeThread,
} from "../commands.ts";
import { loadProfileConfig, type ResolvedConfig } from "../config.ts";
import {
  connectAndSave,
  listProfiles,
  type ProfileEntry,
  type SavedConnection,
} from "../connect.ts";
import { Connection, describeStatus, type Session } from "../connection/connection.ts";
import { toThreadSummary } from "../state/reducers/shell.ts";
import { toDisplayItem } from "../state/selectors.ts";
import type { ShellStore, ThreadStore } from "../state/store.ts";
import { StateSync } from "../state/sync.ts";
import type { ThreadSummary } from "../state/types.ts";

export interface CatalogModel {
  readonly slug: string;
  readonly name: string;
  readonly isDefault: boolean;
}

/** A provider instance that can run turns, with its models. */
export interface CatalogProvider {
  readonly instanceId: ProviderInstanceId;
  readonly name: string;
  readonly models: ReadonlyArray<CatalogModel>;
  /** Null when the provider does not say (all modes). */
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | null;
}

/** What the model picker and new threads need from the server config. */
export interface ModelCatalog {
  readonly providers: ReadonlyArray<CatalogProvider>;
  /** The server's default for new threads (settings), if set. */
  readonly defaultModelSelection: ModelSelection | null;
  readonly defaultRuntimeMode: RuntimeMode;
}

/** Usable providers from a server config: enabled, installed, available, with models. */
export function toModelCatalog(config: ServerConfig): ModelCatalog {
  return {
    providers: config.providers
      .filter(
        (provider) =>
          provider.enabled &&
          provider.installed &&
          isProviderAvailable(provider) &&
          provider.models.length > 0,
      )
      .map((provider) => ({
        instanceId: provider.instanceId,
        name: provider.displayName ?? provider.instanceId,
        models: provider.models.map((model) => ({
          slug: model.slug,
          name: model.name,
          isDefault: model.isDefault === true,
        })),
        supportedRuntimeModes: provider.supportedRuntimeModes ?? null,
      })),
    defaultModelSelection: config.settings.defaultModelSelection,
    defaultRuntimeMode: config.settings.defaultRuntimeMode,
  };
}

export interface NewThread {
  readonly projectId: ProjectId;
  /** Empty for the server's placeholder title. */
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}

export interface SendOptions {
  /** Lets the server title a fresh, untitled thread from its first message. */
  readonly titleSeed?: string;
  /**
   * Ids for the message and its command. Reuse them when resending the same
   * draft after a failure: the server dedupes on them, so a send that did
   * arrive despite the error is not delivered twice.
   */
  readonly commandId?: CommandId;
  readonly messageId?: MessageId;
}

/** How long a command waits for the connection to come up before failing. */
export const CONNECT_GRACE: Duration.Input = "3 seconds";

/** A command was refused because there is no connection. */
export class NotConnectedError extends Data.TaggedError("NotConnectedError")<{
  readonly message: string;
}> {}

/**
 * Waits up to `grace` for a connected session, then fails with
 * `NotConnectedError` describing the connection status.
 */
export const awaitConnected = (grace: Duration.Input = CONNECT_GRACE) =>
  Effect.gen(function* () {
    const connection = yield* Connection;
    const session = yield* connection.session.pipe(
      Effect.timeoutOption(grace),
      // A fatal failure: no point in waiting.
      Effect.catch(() => Effect.succeed(Option.none<Session>())),
    );
    if (session._tag === "Some") return session.value;
    const status = yield* SubscriptionRef.get(connection.status);
    return yield* new NotConnectedError({ message: `not connected (${describeStatus(status)})` });
  });

/** The server the TUI is pointed at, for the status line. */
export interface ServerView {
  /** Profile name; null when the server came from flags or the environment only. */
  readonly profile: string | null;
  readonly label: string | null;
  readonly server: string;
}

export function toServerView(config: ResolvedConfig): ServerView {
  return {
    profile: config.profile?.name ?? null,
    label: config.profile?.label ?? null,
    server: config.serverUrl,
  };
}

export interface Backend {
  readonly shell: ShellStore;
  readonly thread: ThreadStore;
  /** The server currently targeted. */
  readonly server: Accessor<ServerView>;
  /** Saved profiles (`config.json`), read fresh on every call. */
  servers(): Promise<ReadonlyArray<ProfileEntry>>;
  /**
   * Pairs with the server of a pairing link, saves it as a profile and
   * switches to it. Rejects (with a readable message) without switching.
   */
  connectLink(link: string): Promise<SavedConnection>;
  /** Switches to a saved profile: the stores are emptied and the connection re-dials. */
  switchProfile(name: string): Promise<void>;
  /** Shows a thread in the thread store, replacing the open one. */
  openThread(threadId: ThreadId): void;
  send(
    threadId: ThreadId,
    text: string,
    intent: DeliveryIntent,
    options?: SendOptions,
  ): Promise<void>;
  interrupt(threadId: ThreadId): Promise<void>;
  respond(
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    response: RuntimeRequestResponse,
  ): Promise<void>;
  /** The full output of a tool call whose result the stream omitted; null when it has none. */
  fetchToolResult(threadId: ThreadId, itemId: string): Promise<string | null>;
  /** Providers and models (`server.getConfig`), cached after the first call unless `refresh`. */
  modelCatalog(refresh?: boolean): Promise<ModelCatalog>;
  createThread(input: NewThread): Promise<ThreadId>;
  setModel(threadId: ThreadId, modelSelection: ModelSelection): Promise<void>;
  setRuntimeMode(threadId: ThreadId, runtimeMode: RuntimeMode): Promise<void>;
  archive(threadId: ThreadId): Promise<void>;
  /** Whether the connected server advertises a capability (false when it does not say). */
  supports(capability: Capability): Promise<boolean>;
  settle(threadId: ThreadId): Promise<void>;
  unsettle(threadId: ThreadId): Promise<void>;
  snooze(threadId: ThreadId, until: Date): Promise<void>;
  unsnooze(threadId: ThreadId): Promise<void>;
  setAutoSettle(threadId: ThreadId, enabled: boolean): Promise<void>;
  /** Archived threads, fetched on demand (`getArchivedShellSnapshot`). */
  archivedThreads(): Promise<ReadonlyArray<ThreadSummary>>;
  cancelQueued(threadId: ThreadId, runId: RunId): Promise<void>;
  reorderQueued(threadId: ThreadId, runId: RunId, beforeRunId: RunId | null): Promise<void>;
  /** Skips the reconnect backoff. */
  reconnectNow(): void;
  /** Drops the connection (if up) and reconnects right away. */
  reconnect(): void;
}

/** A readable one-liner for a failed command. */
export function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as { _tag?: unknown; message?: unknown };
    const message =
      typeof record.message === "string" && record.message !== "" ? record.message : String(error);
    return typeof record._tag === "string" && !message.includes(record._tag)
      ? `${record._tag}: ${message}`
      : message;
  }
  return String(error);
}

const NO_CONTEXT = { messages: {}, runtimeRequests: {} };

export async function makeBackend(
  runtime: ManagedRuntime.ManagedRuntime<Connection | StateSync, never>,
): Promise<Backend> {
  const sync = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* StateSync;
    }),
  );
  const connection = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* Connection;
    }),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, Connection>): Promise<A> =>
    runtime.runPromise(awaitConnected().pipe(Effect.andThen(effect)));
  let catalog: Promise<ModelCatalog> | undefined;
  const initialTarget = await runtime.runPromise(SubscriptionRef.get(connection.target));
  const [server, setServer] = createSignal<ServerView>(toServerView(initialTarget));
  const switchTo = async (config: ResolvedConfig) => {
    catalog = undefined;
    await runtime.runPromise(sync.switchServer(config));
    setServer(toServerView(config));
  };
  return {
    shell: sync.shell,
    thread: sync.thread,
    server,
    servers: () => listProfiles(),
    connectLink: async (link) => {
      const saved = await connectAndSave({ pairingUrl: link });
      await switchTo(await loadProfileConfig(saved.name));
      return saved;
    },
    switchProfile: async (name) => {
      await switchTo(await loadProfileConfig(name));
    },
    openThread: (threadId) => {
      runtime.runFork(sync.openThread(threadId));
    },
    send: async (threadId, text, intent, options = {}) => {
      await run(
        sendMessage(threadId, text, intent, {
          ...(options.titleSeed === undefined ? {} : { titleSeed: options.titleSeed }),
          ...(options.commandId === undefined ? {} : { commandId: options.commandId }),
          ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
        }),
      );
    },
    interrupt: async (threadId) => {
      await run(interruptRun(threadId));
    },
    respond: async (threadId, requestId, response) => {
      await run(respondToRequest(threadId, requestId, response));
    },
    fetchToolResult: async (threadId, itemId) => {
      const item = await run(fetchTurnItem(threadId, TurnItemId.make(itemId)));
      if (item === null) return null;
      const display = toDisplayItem(item, "local", NO_CONTEXT);
      return display.kind === "tool_call" ? display.result : null;
    },
    modelCatalog: (refresh = false) => {
      if (catalog === undefined || refresh) {
        const pending = run(getServerConfig()).then(toModelCatalog);
        catalog = pending;
        // A failure is not cached: the next call tries again.
        pending.catch(() => {
          if (catalog === pending) catalog = undefined;
        });
      }
      return catalog;
    },
    createThread: async (input) => {
      const result = await run(
        createThread(input.projectId, {
          ...(input.title.trim() === "" ? {} : { title: input.title }),
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
        }),
      );
      return result.threadId;
    },
    setModel: async (threadId, modelSelection) => {
      await run(setModelSelection(threadId, modelSelection));
    },
    setRuntimeMode: async (threadId, runtimeMode) => {
      await run(setRuntimeMode(threadId, runtimeMode));
    },
    archive: async (threadId) => {
      await run(archiveThread(threadId));
    },
    supports: (capability) => run(supportsCapability(capability)),
    settle: async (threadId) => {
      await run(settleThread(threadId));
    },
    unsettle: async (threadId) => {
      await run(unsettleThread(threadId));
    },
    snooze: async (threadId, until) => {
      await run(snoozeThread(threadId, until));
    },
    unsnooze: async (threadId) => {
      await run(unsnoozeThread(threadId));
    },
    setAutoSettle: async (threadId, enabled) => {
      await run(setAutoSettle(threadId, enabled));
    },
    archivedThreads: async () => {
      const threads = await run(getArchivedThreads());
      return threads.map((thread) => toThreadSummary(thread, "archive"));
    },
    cancelQueued: async (threadId, runId) => {
      await run(cancelQueuedRun(threadId, runId));
    },
    reorderQueued: async (threadId, runId, beforeRunId) => {
      await run(reorderQueuedRun(threadId, runId, beforeRunId));
    },
    reconnectNow: () => {
      runtime.runFork(connection.reconnectNow);
    },
    reconnect: () => {
      runtime.runFork(connection.forceReconnect);
    },
  };
}
