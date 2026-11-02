/**
 * Pairing: turn a pairing link from the T3 Code app (Settings → Connections,
 * or `t3 pair` on the host) into a bearer token.
 *
 * Accepted input (ported from upstream `packages/shared/src/remote.ts`):
 * - direct link: `http(s)://host[:port]/pair#token=<credential>`; the server
 *   is the link's origin. `?token=` is accepted when the hash has none.
 * - hosted link: `https://app.t3.codes/pair?host=<server>[&label=..]#token=..`;
 *   the server is the `host` parameter.
 * - a server (`--host`) and a pairing code (`--code`) given separately.
 * A server given without a scheme (`host:3773`) is taken as https, like
 * upstream; `ws(s)://` maps to `http(s)://`.
 *
 * The credential is one-time, so the server's environment descriptor is
 * fetched first and the credential is only redeemed (`POST /oauth/token`,
 * an OAuth token exchange) when the server is reachable and speaks this
 * client's orchestration protocol, like upstream's `preparePairingRegistration`.
 */
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  type AuthClientMetadataDeviceType,
  AuthEnvironmentBootstrapTokenType,
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
  type AuthTokenExchangeRequest,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentRequestInvalidError,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { checkProtocol, fetchEnvironment } from "./connection/environment.ts";

const PAIRING_TOKEN_PARAM = "token";
const HOSTED_PAIRING_HOST_PARAM = "host";
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

/** What t3tui asks for: reading threads, and operating them (send, approve, ...). */
export const PAIRING_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
];
export const CLIENT_LABEL = "t3tui";
/** A terminal client runs on a computer; "desktop" is the closest device type. */
export const CLIENT_DEVICE_TYPE: AuthClientMetadataDeviceType = "desktop";

const REDEEM_TIMEOUT_MS = 10_000;

const WHERE_TO_GET_A_LINK =
  "Create a new pairing link in the T3 Code app (Settings → Connections) or with `t3 pair` on the server's host.";

export type PairingFailure =
  /** The link or the --host/--code pair could not be parsed. */
  | "invalid-input"
  /** The server could not be reached (nothing was redeemed). */
  | "unreachable"
  /** The server speaks another orchestration protocol (nothing was redeemed). */
  | "incompatible"
  /** The server did not accept the credential: expired, used, revoked or unknown. */
  | "rejected"
  /** The link does not grant the scopes t3tui needs. */
  | "scope"
  /** The server failed, or answered something unexpected. */
  | "server";

export class PairingError extends Data.TaggedError("PairingError")<{
  readonly reason: PairingFailure;
  readonly message: string;
}> {}

const invalid = (message: string) => new PairingError({ reason: "invalid-input", message });

export interface PairingInput {
  readonly pairingUrl?: string | undefined;
  readonly host?: string | undefined;
  readonly code?: string | undefined;
}

export interface PairingTarget {
  /** The one-time pairing credential. */
  readonly credential: string;
  /** http(s) base URL of the server, ending in `/`. */
  readonly serverUrl: string;
}

const readHashParams = (url: URL): URLSearchParams =>
  new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);

/** The `token` from the hash parameters, else from the query. */
export function pairingTokenFromUrl(url: URL): string | null {
  const hash = readHashParams(url).get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  if (hash !== "") return hash;
  const query = url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  return query === "" ? null : query;
}

/** http(s) base URL (path `/`) of a server URL as `toHttpBaseUrl` does upstream. */
function toHttpBase(url: URL): string {
  const next = new URL(url.toString());
  if (next.protocol === "ws:") next.protocol = "http:";
  else if (next.protocol === "wss:") next.protocol = "https:";
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  next.username = "";
  next.password = "";
  return next.toString();
}

/** Upstream's `normalizeRemoteBaseUrl`: a bare `host[:port]` means https. */
export function normalizeBackendUrl(raw: string, what: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw invalid(`${what} is empty`);
  const withoutLeadingSlashes = trimmed.replace(/^\/+/, "");
  const input = /^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(withoutLeadingSlashes)
    ? withoutLeadingSlashes
    : `https://${withoutLeadingSlashes}`;
  const url = URL.parse(input);
  if (url === null || url.hostname === "") throw invalid(`${what} is not a valid URL: ${raw}`);
  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw invalid(`${what} must use http or https, got ${url.protocol}`);
  }
  return toHttpBase(url);
}

/**
 * Parses a pairing link, or a server plus pairing code, into the server's
 * base URL and the credential. Pure; throws `PairingError` (`invalid-input`).
 * The messages never include the credential.
 */
export function parsePairingTarget(input: PairingInput): PairingTarget {
  const pairingUrl = input.pairingUrl?.trim() ?? "";
  if (pairingUrl !== "") {
    if (input.host !== undefined || input.code !== undefined) {
      throw invalid("give either a pairing link or --host with --code, not both");
    }
    const url = URL.parse(pairingUrl);
    if (url === null) throw invalid("the pairing link is not a valid URL");
    if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
      throw invalid(`the pairing link must be an http(s) URL, got ${url.protocol}`);
    }
    const token = pairingTokenFromUrl(url);
    const hostedHost = url.searchParams.get(HOSTED_PAIRING_HOST_PARAM)?.trim() ?? "";
    if (hostedHost !== "" && token !== null) {
      return {
        credential: token,
        serverUrl: normalizeBackendUrl(hostedHost, "the link's host parameter"),
      };
    }
    if (token === null) {
      throw invalid(
        `the pairing link has no token (expected .../pair#token=...); copy the whole link. ${WHERE_TO_GET_A_LINK}`,
      );
    }
    return { credential: token, serverUrl: toHttpBase(url) };
  }

  const host = input.host?.trim() ?? "";
  const code = input.code?.trim() ?? "";
  if (host === "" && code === "") throw invalid("give a pairing link, or --host and --code");
  if (host === "") throw invalid("--code needs --host <server url>");
  const serverUrl = normalizeBackendUrl(host, "--host");
  if (code === "") throw invalid("--host needs --code <pairing code> (or give the pairing link)");
  return { credential: code, serverUrl };
}

/** The form fields of the token exchange (`AuthTokenExchangeRequest`). */
export function tokenExchangeRequest(
  credential: string,
  options: { readonly scopes?: ReadonlyArray<AuthEnvironmentScope>; readonly os?: string } = {},
): AuthTokenExchangeRequest {
  const scopes = options.scopes ?? PAIRING_SCOPES;
  return {
    grant_type: AuthTokenExchangeGrantType,
    subject_token: credential,
    subject_token_type: AuthEnvironmentBootstrapTokenType,
    requested_token_type: AuthAccessTokenType,
    // OAuth scope syntax (RFC 6749 §3.3): space separated, as upstream's encodeOAuthScope.
    ...(scopes.length === 0 ? {} : { scope: [...new Set(scopes)].join(" ") }),
    client_label: CLIENT_LABEL,
    client_device_type: CLIENT_DEVICE_TYPE,
    ...(options.os === undefined || options.os === "" ? {} : { client_os: options.os }),
  };
}

const TokenExchangeError = Schema.Union([
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
]);
const decodeTokenExchangeError = Schema.decodeUnknownOption(TokenExchangeError);
const decodeAccessToken = Schema.decodeUnknownEffect(AuthAccessTokenResult);

/** A clear message for an error answer of `POST /oauth/token`. */
export function describeTokenExchangeFailure(status: number, body: unknown): PairingError {
  const decoded = decodeTokenExchangeError(body);
  if (decoded._tag === "Some") {
    const error = decoded.value;
    switch (error._tag) {
      case "EnvironmentAuthInvalidError":
        return new PairingError({
          reason: "rejected",
          message:
            error.reason === "missing_credential"
              ? `the server got no pairing credential. ${WHERE_TO_GET_A_LINK}`
              : `the server did not accept the pairing link: it has expired, was already used, or was revoked (links work once). ${WHERE_TO_GET_A_LINK}`,
        });
      case "EnvironmentRequestInvalidError":
        return new PairingError({
          reason: "scope",
          message:
            error.reason === "scope_not_granted"
              ? `the pairing link does not grant orchestration access (t3tui needs orchestration:read, and orchestration:operate to send messages); the link was not used up. Create one with those scopes, e.g. \`t3 pair --scope orchestration:read --scope orchestration:operate\`.`
              : `the server rejected the request (${error.reason}).`,
        });
      case "EnvironmentInternalError":
        return new PairingError({
          reason: "server",
          message: `the server failed to issue a token (${error.reason}); try again, or create a new link.`,
        });
    }
  }
  return new PairingError({
    reason: status === 401 || status === 403 ? "rejected" : "server",
    message:
      status === 401 || status === 403
        ? `the server did not accept the pairing link (HTTP ${status}). ${WHERE_TO_GET_A_LINK}`
        : `unexpected answer from the server's token endpoint (HTTP ${status}).`,
  });
}

export interface IssuedToken {
  readonly token: string;
  /** Space separated scopes the server granted. */
  readonly scope: string;
  /** ISO 8601 expiry computed from `expires_in`. */
  readonly expiresAt: string;
  readonly expiresInSeconds: number;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Redeems the credential: `POST <server>/oauth/token`. */
export const redeemPairingCredential = (
  target: PairingTarget,
  options: { readonly os?: string; readonly timeoutMs?: number } = {},
): Effect.Effect<IssuedToken, PairingError> =>
  Effect.gen(function* () {
    const url = new URL("oauth/token", target.serverUrl).toString();
    const fields = tokenExchangeRequest(target.credential, {
      ...(options.os === undefined ? {} : { os: options.os }),
    });
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams(
            Object.entries(fields).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ).toString(),
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(options.timeoutMs ?? REDEEM_TIMEOUT_MS),
          ]),
        }),
      catch: (cause) =>
        new PairingError({
          reason: "unreachable",
          message: `could not reach ${url}: ${errorMessage(cause)} (the link may or may not have been used)`,
        }),
    });
    const text = yield* Effect.promise(() => response.text().catch(() => ""));
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!response.ok) return yield* describeTokenExchangeFailure(response.status, body);
    const result = yield* decodeAccessToken(body).pipe(
      Effect.mapError(
        () =>
          new PairingError({
            reason: "server",
            message: "the server's token endpoint returned an unexpected answer.",
          }),
      ),
    );
    if (result.token_type !== "Bearer") {
      return yield* new PairingError({
        reason: "server",
        message: `the server issued a ${result.token_type} token; t3tui only supports bearer tokens.`,
      });
    }
    return {
      token: result.access_token,
      scope: result.scope,
      expiresInSeconds: result.expires_in,
      expiresAt: new Date(Date.now() + result.expires_in * 1000).toISOString(),
    };
  });

export interface PairingResult {
  readonly serverUrl: string;
  readonly environment: ExecutionEnvironmentDescriptor;
  readonly issued: IssuedToken;
}

/** The OS name sent as `client_os` (shown in the server's connections list). */
export function clientOs(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return platform;
  }
}

/**
 * The whole pairing: parse, check the server (without spending the link),
 * then redeem the credential.
 */
export const pair = (input: PairingInput): Effect.Effect<PairingResult, PairingError> =>
  Effect.gen(function* () {
    const target = yield* Effect.try({
      try: () => parsePairingTarget(input),
      catch: (cause) => (cause instanceof PairingError ? cause : invalid(errorMessage(cause))),
    });
    const environment = yield* fetchEnvironment(target.serverUrl).pipe(
      Effect.mapError(
        (error) =>
          new PairingError({
            reason: "unreachable",
            message: `${error.message} (the pairing link was not used)`,
          }),
      ),
    );
    const mismatch = checkProtocol(environment);
    if (mismatch !== undefined) {
      return yield* new PairingError({
        reason: "incompatible",
        message: `${mismatch.message} (The pairing link was not used.)`,
      });
    }
    const issued = yield* redeemPairingCredential(target, { os: clientOs() });
    return { serverUrl: target.serverUrl, environment, issued };
  });

/** Whether the granted scopes include sending commands. */
export function canOperate(scope: string): boolean {
  return scope.split(" ").includes(AuthOrchestrationOperateScope);
}
