/**
 * UI-agnostic connection to a T3 Code server.
 *
 * - Auth: `Authorization: Bearer <token>` on the WebSocket upgrade request
 *   (Bun's WebSocket accepts handshake headers). The token is re-read from its
 *   source on every attempt, so rotating the token file needs no restart.
 * - Version gate: before each attempt the public environment descriptor is
 *   fetched and its orchestration protocol compared with the vendored
 *   contracts. A mismatch is fatal.
 * - Liveness: effect/rpc pings every 5s; no frame for 15s drops the socket.
 * - Reconnect: one RPC session per socket (like upstream, the protocol itself
 *   never retries). When a session ends the supervisor waits 1s, 2s, 4s, ...
 *   up to 30s and dials again; a session that reached "connected" resets the
 *   backoff.
 * - Fatal errors: when the socket closes before it opened, the endpoint is
 *   probed with a plain HTTP GET carrying the same credentials. The server
 *   checks the protocol param and the credential before upgrading, so 426
 *   means protocol mismatch and 401/403 means a bad or under-scoped token.
 *   Those stop the supervisor with a `failed` status instead of retrying.
 */
import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/socket/Socket";

import { ConfigError, type ResolvedConfig, readToken } from "../config.ts";
import { versionGate } from "./environment.ts";
import {
  makeWsRpcProtocolClient,
  PING_INTERVAL,
  PING_TIMEOUT,
  SOCKET_OPEN_TIMEOUT,
  type WsRpcProtocolClient,
} from "./protocol.ts";

export const BACKOFF_INITIAL_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** Pause before reconnecting after `forceReconnect` closed the socket. */
const REQUESTED_RECONNECT_DELAY_MS = 250;

export type FatalReason = "protocol-mismatch" | "unauthorized" | "forbidden" | "config";

/** A connection problem retrying will not fix. */
export class ConnectionFatalError extends Data.TaggedError("ConnectionFatalError")<{
  readonly reason: FatalReason;
  readonly message: string;
}> {}

export interface Session {
  /** Increments with every successful connection. */
  readonly generation: number;
  readonly client: WsRpcProtocolClient;
  readonly environment: ExecutionEnvironmentDescriptor;
}

export type ConnectionStatus =
  | { readonly _tag: "connecting"; readonly attempt: number }
  | { readonly _tag: "connected"; readonly session: Session }
  | {
      readonly _tag: "disconnected";
      readonly reason: string;
      readonly attempt: number;
      /** Epoch ms of the next attempt. */
      readonly retryAt: number;
    }
  | { readonly _tag: "failed"; readonly error: ConnectionFatalError };

export class Connection extends Context.Service<
  Connection,
  {
    readonly config: ResolvedConfig;
    /** Current status; `SubscriptionRef.changes` streams it, starting with the current value. */
    readonly status: SubscriptionRef.SubscriptionRef<ConnectionStatus>;
    /** Waits for a connected session. Fails if the connection failed fatally. */
    readonly session: Effect.Effect<Session, ConnectionFatalError>;
    /** Shorthand for `session` mapped to its client. */
    readonly client: Effect.Effect<WsRpcProtocolClient, ConnectionFatalError>;
    /** Emits each new session as it connects. Fails if the connection failed fatally. */
    readonly sessions: Stream.Stream<Session, ConnectionFatalError>;
    /**
     * Runs `f` against every session in turn: the stream it returns is
     * restarted when the connection comes back. Transport errors end the
     * current inner stream quietly; other errors propagate.
     */
    readonly subscribe: <A, E>(
      f: (session: Session) => Stream.Stream<A, E>,
    ) => Stream.Stream<A, Exclude<E, RpcClientError.RpcClientError> | ConnectionFatalError>;
    /** Skips the remaining backoff delay, if the supervisor is waiting. */
    readonly reconnectNow: Effect.Effect<void>;
    /**
     * Reconnects now: closes the open socket (streams fail over to the next
     * session as on any drop, and the retry skips the backoff), or skips the
     * backoff when already disconnected.
     */
    readonly forceReconnect: Effect.Effect<void>;
  }
>()("t3tui/Connection") {}

/** Transport-level failures, i.e. the socket went away. */
export function isTransportError(error: unknown): error is RpcClientError.RpcClientError {
  return (
    error instanceof RpcClientError.RpcClientError &&
    Schema.is(Socket.SocketErrorReason)(error.reason)
  );
}

type AttemptOutcome =
  | { readonly _tag: "fatal"; readonly error: ConnectionFatalError }
  | { readonly _tag: "lost"; readonly reason: string; readonly wasConnected: boolean };

/**
 * Bun's WebSocket accepts `{ headers, protocols }`; the global constructor
 * layer rejects it. `onOpen` receives each socket so it can be closed on
 * request (`forceReconnect`).
 */
const bunWebSocketConstructor = (onOpen: (socket: WebSocket) => void) =>
  Layer.succeed(Socket.WebSocketConstructor)((url, options) => {
    const socket = new WebSocket(url, options as ConstructorParameters<typeof WebSocket>[1]);
    onOpen(socket);
    return socket as unknown as Socket.WebSocketLike;
  });

/** Close code for a reconnect the user asked for (4000-4999 is for applications). */
const RECONNECT_CLOSE_CODE = 4000;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Classifies a handshake failure by repeating the request as plain HTTP. The
 * server validates the protocol param and credentials before upgrading, so it
 * answers 426 or 401/403 exactly as it would for the upgrade; anything else
 * (typically 400 "not an upgrade") means the handshake itself was fine.
 */
export const diagnoseHandshake = (
  wsUrl: string,
  token: string,
): Effect.Effect<ConnectionFatalError | string> =>
  Effect.tryPromise({
    try: async (signal) => {
      const url = new URL(wsUrl);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      });
      const body = await response.text().catch(() => "");
      return { status: response.status, body };
    },
    catch: (cause) => `server unreachable: ${errorMessage(cause)}`,
  }).pipe(
    Effect.map(({ status, body }): ConnectionFatalError | string => {
      let detail = "";
      try {
        const json = JSON.parse(body) as { code?: unknown; reason?: unknown; message?: unknown };
        detail = [json.code, json.reason, json.message]
          .filter((part) => typeof part === "string")
          .join(": ");
      } catch {
        // not JSON
      }
      switch (status) {
        case 426:
          return new ConnectionFatalError({
            reason: "protocol-mismatch",
            message: `server rejected the orchestration protocol (HTTP 426${detail ? `, ${detail}` : ""})`,
          });
        case 401:
          return new ConnectionFatalError({
            reason: "unauthorized",
            message: `server rejected the token (HTTP 401${detail ? `, ${detail}` : ""}); check the token file`,
          });
        case 403:
          return new ConnectionFatalError({
            reason: "forbidden",
            message: `token lacks the required access (HTTP 403${detail ? `, ${detail}` : ""})`,
          });
        default:
          return `WebSocket handshake failed (HTTP probe answered ${status})`;
      }
    }),
    Effect.catch((message) => Effect.succeed(message)),
  );

export const make = Effect.fn("Connection.make")(function* (config: ResolvedConfig) {
  const status = yield* SubscriptionRef.make<ConnectionStatus>({ _tag: "connecting", attempt: 1 });
  const wake = yield* Ref.make(yield* Deferred.make<void>());
  let generation = 0;
  let currentSocket: WebSocket | undefined;
  let reconnectRequested = false;

  // Each connected session lives in its own scope. It is closed at the start
  // of the next attempt rather than as soon as the socket drops: closing it
  // right away would interrupt in-flight streams before the protocol has
  // failed them with the transport error, and consumers could not tell a lost
  // connection from a deliberate interruption.
  let sessionScope: Scope.Closeable | undefined;
  const closeSessionScope = Effect.suspend(() => {
    const scope = sessionScope;
    sessionScope = undefined;
    return scope === undefined ? Effect.void : Scope.close(scope, Exit.void);
  });
  yield* Effect.addFinalizer(() => closeSessionScope);

  const connectOnce: Effect.Effect<AttemptOutcome, never, Scope.Scope> = Effect.gen(function* () {
    const token = yield* Effect.tryPromise({
      try: () => readToken(config.token),
      catch: (cause) => cause,
    }).pipe(Effect.result);
    if (token._tag === "Failure") {
      const cause = token.failure;
      return {
        _tag: "fatal",
        error: new ConnectionFatalError({
          reason: "config",
          message: cause instanceof ConfigError ? cause.message : errorMessage(cause),
        }),
      } as const;
    }

    const gate = yield* versionGate(config.serverUrl).pipe(Effect.result);
    if (gate._tag === "Failure") {
      const error = gate.failure;
      return error._tag === "ProtocolMismatchError"
        ? ({
            _tag: "fatal",
            error: new ConnectionFatalError({
              reason: "protocol-mismatch",
              message: error.message,
            }),
          } as const)
        : ({ _tag: "lost", reason: error.message, wasConnected: false } as const);
    }
    const environment = gate.success;

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<void>();
    const pingTimedOut = yield* Ref.make(false);
    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onDisconnect: Deferred.succeed(disconnected, undefined).pipe(Effect.asVoid),
    });
    const layerSocket = Socket.layerWebSocket(config.wsUrl, {
      openTimeout: SOCKET_OPEN_TIMEOUT,
      headers: { authorization: `Bearer ${token.success}` },
    }).pipe(
      Layer.provide(
        bunWebSocketConstructor((socket) => {
          currentSocket = socket;
        }),
      ),
    );
    const layerProtocol = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        pingInterval: PING_INTERVAL,
        pingTimeout: PING_TIMEOUT,
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
        onPingTimeout: Ref.set(pingTimedOut, true),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          layerSocket,
          RpcSerialization.layerJson,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );
    const protocolContext = yield* Layer.build(layerProtocol);
    const client = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));

    const opened = yield* Deferred.await(connected).pipe(
      Effect.as(true),
      Effect.raceFirst(Deferred.await(disconnected).pipe(Effect.as(false))),
    );
    if (!opened) {
      const diagnosis = yield* diagnoseHandshake(config.wsUrl, token.success);
      return typeof diagnosis === "string"
        ? ({ _tag: "lost", reason: diagnosis, wasConnected: false } as const)
        : ({ _tag: "fatal", error: diagnosis } as const);
    }

    generation += 1;
    yield* SubscriptionRef.set(status, {
      _tag: "connected",
      session: { generation, client, environment },
    });
    yield* Deferred.await(disconnected);
    const timedOut = yield* Ref.get(pingTimedOut);
    return {
      _tag: "lost",
      reason: timedOut
        ? `server stopped responding (no frame for ${Duration.toSeconds(PING_TIMEOUT)}s)`
        : reconnectRequested
          ? "reconnect requested"
          : "connection closed",
      wasConnected: true,
    } as const;
  });

  const attempt: Effect.Effect<AttemptOutcome> = Effect.gen(function* () {
    yield* closeSessionScope;
    const scope = yield* Scope.make();
    // Registered before use so the layer finalizer also closes an attempt
    // that is interrupted half-way (e.g. on shutdown).
    sessionScope = scope;
    const outcome = yield* Scope.provide(connectOnce, scope);
    if (outcome._tag === "fatal" || !outcome.wasConnected) yield* closeSessionScope;
    return outcome;
  });

  const supervisor = Effect.gen(function* () {
    let attemptNumber = 0;
    let delayMs = BACKOFF_INITIAL_MS;
    while (true) {
      attemptNumber += 1;
      yield* SubscriptionRef.set(status, { _tag: "connecting", attempt: attemptNumber });
      const outcome = yield* attempt;
      if (outcome._tag === "fatal") {
        yield* SubscriptionRef.set(status, { _tag: "failed", error: outcome.error });
        return;
      }
      if (outcome.wasConnected) {
        attemptNumber = 0;
        delayMs = BACKOFF_INITIAL_MS;
      }
      const signal = yield* Deferred.make<void>();
      yield* Ref.set(wake, signal);
      yield* SubscriptionRef.set(status, {
        _tag: "disconnected",
        reason: outcome.reason,
        attempt: attemptNumber,
        retryAt: Date.now() + delayMs,
      });
      // A requested reconnect still pauses briefly: the old session's streams
      // must fail with the transport error before its scope is closed (see
      // `sessionScope`), or consumers would see an interruption instead.
      const wait = reconnectRequested ? REQUESTED_RECONNECT_DELAY_MS : delayMs;
      reconnectRequested = false;
      yield* Effect.sleep(Duration.millis(wait)).pipe(Effect.raceFirst(Deferred.await(signal)));
      delayMs = Math.min(delayMs * 2, BACKOFF_MAX_MS);
    }
  });
  yield* Effect.forkScoped(supervisor);

  const sessions: Stream.Stream<Session, ConnectionFatalError> = SubscriptionRef.changes(
    status,
  ).pipe(
    Stream.mapEffect((current) =>
      current._tag === "failed" ? Effect.fail(current.error) : Effect.succeed(current),
    ),
    Stream.filterMap((current) =>
      current._tag === "connected" ? Result.succeed(current.session) : Result.failVoid,
    ),
    Stream.changesWith((a, b) => a.generation === b.generation),
  );

  // `sessions` only ends by failing, so the head is always present.
  const session = sessions.pipe(
    Stream.runHead,
    Effect.flatMap(Option.match({ onNone: () => Effect.never, onSome: Effect.succeed })),
  );

  const subscribe = <A, E>(f: (session: Session) => Stream.Stream<A, E>) =>
    sessions.pipe(
      Stream.switchMap((current) =>
        f(current).pipe(Stream.catchIf(isTransportError, () => Stream.empty)),
      ),
    ) as Stream.Stream<A, Exclude<E, RpcClientError.RpcClientError> | ConnectionFatalError>;

  const reconnectNow = Ref.get(wake).pipe(
    Effect.flatMap((signal) => Deferred.succeed(signal, undefined)),
    Effect.asVoid,
  );

  return Connection.of({
    config,
    status,
    session,
    client: Effect.map(session, (current) => current.client),
    sessions,
    subscribe,
    reconnectNow,
    forceReconnect: SubscriptionRef.get(status).pipe(
      Effect.flatMap((current) => {
        const socket = currentSocket;
        if (current._tag !== "connected" || socket === undefined) return reconnectNow;
        return Effect.sync(() => {
          reconnectRequested = true;
          socket.close(RECONNECT_CLOSE_CODE, "reconnect requested");
        });
      }),
    ),
  });
});

export const layer = (config: ResolvedConfig): Layer.Layer<Connection> =>
  Layer.effect(Connection, make(config));

/** One-line human description of a status. */
export function describeStatus(current: ConnectionStatus): string {
  switch (current._tag) {
    case "connecting":
      return current.attempt > 1 ? `connecting (attempt ${current.attempt})` : "connecting";
    case "connected":
      return `connected to ${current.session.environment.label} (server ${current.session.environment.serverVersion})`;
    case "disconnected": {
      const seconds = Math.max(0, Math.round((current.retryAt - Date.now()) / 1000));
      return `disconnected: ${current.reason}; retrying in ${seconds}s`;
    }
    case "failed":
      return `failed (${current.error.reason}): ${current.error.message}`;
  }
}
