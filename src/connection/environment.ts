/**
 * Startup version gate: fetch the server's public environment descriptor and
 * check it speaks the orchestration protocol of the vendored contracts.
 */
import { ExecutionEnvironmentDescriptor, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const DESCRIPTOR_PATH = ".well-known/t3/environment";

/** The descriptor could not be fetched or decoded. Usually transient (server down). */
export class EnvironmentUnreachableError extends Data.TaggedError("EnvironmentUnreachableError")<{
  readonly url: string;
  readonly message: string;
}> {}

/** The server speaks a different orchestration protocol. Not retryable. */
export class ProtocolMismatchError extends Data.TaggedError("ProtocolMismatchError")<{
  readonly serverProtocol: number;
  readonly clientProtocol: number;
  readonly serverVersion: string;
  readonly message: string;
}> {}

export function descriptorUrl(serverUrl: string): string {
  return new URL(DESCRIPTOR_PATH, serverUrl).toString();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const fetchEnvironment = (
  serverUrl: string,
  options: { readonly timeoutMs?: number } = {},
): Effect.Effect<ExecutionEnvironmentDescriptor, EnvironmentUnreachableError> => {
  const url = descriptorUrl(serverUrl);
  const unreachable = (message: string) => new EnvironmentUnreachableError({ url, message });
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]),
        }),
      catch: (cause) => unreachable(`could not reach ${url}: ${errorMessage(cause)}`),
    });
    if (!response.ok) {
      return yield* unreachable(
        `${url} responded with HTTP ${response.status} ${response.statusText}`,
      );
    }
    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => unreachable(`${url} did not return valid JSON`),
    });
    return yield* Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor)(body).pipe(
      Effect.mapError((cause) =>
        unreachable(
          `environment descriptor does not match the vendored schema:\n${errorMessage(cause)}`,
        ),
      ),
    );
  });
};

/** Servers that predate negotiation do not report a version and speak protocol 1. */
export function serverProtocolOf(descriptor: ExecutionEnvironmentDescriptor): number {
  return descriptor.orchestrationProtocolVersion ?? 1;
}

export function checkProtocol(
  descriptor: ExecutionEnvironmentDescriptor,
): ProtocolMismatchError | undefined {
  const serverProtocol = serverProtocolOf(descriptor);
  if (serverProtocol === ORCHESTRATION_PROTOCOL_VERSION) return undefined;
  const direction =
    serverProtocol > ORCHESTRATION_PROTOCOL_VERSION
      ? "The server is newer than this client; refresh vendor/contracts (see vendor/contracts/VENDORED.md)."
      : "The server is older than this client; update T3 Code on the server.";
  return new ProtocolMismatchError({
    serverProtocol,
    clientProtocol: ORCHESTRATION_PROTOCOL_VERSION,
    serverVersion: descriptor.serverVersion,
    message:
      `orchestration protocol mismatch: server ${descriptor.serverVersion} speaks ${serverProtocol}, ` +
      `this client speaks ${ORCHESTRATION_PROTOCOL_VERSION}. ${direction}`,
  });
}

/** Fetches the descriptor and fails with `ProtocolMismatchError` when incompatible. */
export const versionGate = (
  serverUrl: string,
): Effect.Effect<
  ExecutionEnvironmentDescriptor,
  EnvironmentUnreachableError | ProtocolMismatchError
> =>
  fetchEnvironment(serverUrl).pipe(
    Effect.flatMap((descriptor) => {
      const mismatch = checkProtocol(descriptor);
      return mismatch === undefined ? Effect.succeed(descriptor) : Effect.fail(mismatch);
    }),
  );

/** A compact, JSON-friendly summary of a descriptor. */
export function summarizeEnvironment(
  serverUrl: string,
  descriptor: ExecutionEnvironmentDescriptor,
) {
  const mismatch = checkProtocol(descriptor);
  return {
    server: new URL(serverUrl).origin,
    serverVersion: descriptor.serverVersion,
    serverProtocol: descriptor.orchestrationProtocolVersion ?? null,
    clientProtocol: ORCHESTRATION_PROTOCOL_VERSION,
    compatible: mismatch === undefined,
    environment: { id: descriptor.environmentId, label: descriptor.label },
    platform: `${descriptor.platform.os}/${descriptor.platform.arch}`,
  };
}
