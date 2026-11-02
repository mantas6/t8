/**
 * Client configuration: which server to talk to and where the bearer token
 * lives.
 *
 * Resolution order, highest priority first:
 *   1. CLI flags `--server <url>` and `--token-file <path>`
 *   2. Environment: `T3TUI_SERVER`, `T3TUI_TOKEN` (the token itself),
 *      `T3TUI_TOKEN_FILE`
 *   3. `$XDG_CONFIG_HOME/t3tui/config.json` (default `~/.config/t3tui/config.json`),
 *      shape `{ "server": "http://localhost:3773", "tokenFile": "token" }`.
 *      A relative `tokenFile` resolves against the config directory.
 *   4. Defaults: `http://localhost:3773` and `<config dir>/token`.
 *
 * The token is deliberately never accepted as a CLI argument: argv is visible
 * to other users through the process table and ends up in shell history.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";

export const DEFAULT_SERVER_URL = "http://localhost:3773";
export const CONFIG_FILE_NAME = "config.json";
export const DEFAULT_TOKEN_FILE_NAME = "token";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Values given on the command line. */
export interface ConfigFlags {
  readonly server?: string | undefined;
  readonly tokenFile?: string | undefined;
}

/** Contents of `config.json`. Unknown keys are ignored. */
export interface ConfigFile {
  readonly server?: string | undefined;
  readonly tokenFile?: string | undefined;
}

export type TokenSource =
  | { readonly kind: "env"; readonly token: string }
  | { readonly kind: "file"; readonly path: string };

export interface ResolvedConfig {
  /** Normalised http(s) base URL of the server, always ending in `/`. */
  readonly serverUrl: string;
  /** WebSocket RPC endpoint including the orchestration protocol query param. */
  readonly wsUrl: string;
  readonly token: TokenSource;
  readonly configDir: string;
}

export interface ResolveInput {
  readonly flags: ConfigFlags;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  /** Parsed `config.json`, or undefined when the file does not exist. */
  readonly file?: ConfigFile | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** `$XDG_CONFIG_HOME/t3tui`, falling back to `~/.config/t3tui`. */
export function configDirFor(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string {
  const xdg = nonEmpty(env.XDG_CONFIG_HOME);
  // The XDG spec says relative values are invalid and must be ignored.
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homeDir, ".config");
  return join(base, "t3tui");
}

function expandHome(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return join(homeDir, path.slice(2));
  return path;
}

/**
 * Normalises a server URL to an http(s) base URL ending in `/`. `ws(s)://`
 * inputs are accepted and mapped to their http(s) equivalent. Query and
 * fragment are dropped.
 */
export function normalizeServerUrl(input: string): string {
  const url = URL.parse(input.trim());
  if (url === null) throw new ConfigError(`invalid server URL: ${input}`);
  switch (url.protocol) {
    case "http:":
    case "https:":
      break;
    case "ws:":
      url.protocol = "http:";
      break;
    case "wss:":
      url.protocol = "https:";
      break;
    default:
      throw new ConfigError(`server URL must use http or https, got ${url.protocol} (${input})`);
  }
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.toString();
}

/**
 * Derives the WebSocket RPC endpoint from the server's http(s) URL:
 * `http://host:port/base/` becomes `ws://host:port/base/ws?orchestrationProtocol=N`.
 */
export function deriveWsUrl(serverUrl: string): string {
  const url = new URL("ws", normalizeServerUrl(serverUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  return url.toString();
}

/** Pure resolution step; no I/O, so it can be unit tested. */
export function resolveConfig(input: ResolveInput): ResolvedConfig {
  const { flags, env, homeDir, file } = input;
  const configDir = configDirFor(env, homeDir);

  const server =
    nonEmpty(flags.server) ??
    nonEmpty(env.T3TUI_SERVER) ??
    nonEmpty(file?.server) ??
    DEFAULT_SERVER_URL;
  const serverUrl = normalizeServerUrl(server);

  let token: TokenSource;
  const flagTokenFile = nonEmpty(flags.tokenFile);
  const envToken = nonEmpty(env.T3TUI_TOKEN);
  const envTokenFile = nonEmpty(env.T3TUI_TOKEN_FILE);
  const fileTokenFile = nonEmpty(file?.tokenFile);
  if (flagTokenFile !== undefined) {
    token = { kind: "file", path: resolve(expandHome(flagTokenFile, homeDir)) };
  } else if (envToken !== undefined) {
    token = { kind: "env", token: envToken };
  } else if (envTokenFile !== undefined) {
    token = { kind: "file", path: resolve(expandHome(envTokenFile, homeDir)) };
  } else if (fileTokenFile !== undefined) {
    token = { kind: "file", path: resolve(configDir, expandHome(fileTokenFile, homeDir)) };
  } else {
    token = { kind: "file", path: join(configDir, DEFAULT_TOKEN_FILE_NAME) };
  }

  return { serverUrl, wsUrl: deriveWsUrl(serverUrl), token, configDir };
}

/** Validates the parsed JSON of `config.json`. */
export function parseConfigFile(raw: unknown, path: string): ConfigFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${path}: expected a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of ["server", "tokenFile"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      throw new ConfigError(`${path}: "${key}" must be a string`);
    }
  }
  return {
    server: record.server as string | undefined,
    tokenFile: record.tokenFile as string | undefined,
  };
}

async function readConfigFile(path: string): Promise<ConfigFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(`could not read ${path}: ${(cause as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(`${path}: invalid JSON: ${(cause as Error).message}`);
  }
  return parseConfigFile(raw, path);
}

/** Resolves configuration from flags, the process environment and `config.json`. */
export async function loadConfig(
  flags: ConfigFlags = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ResolvedConfig> {
  const homeDir = homedir();
  const file = await readConfigFile(join(configDirFor(env, homeDir), CONFIG_FILE_NAME));
  return resolveConfig({ flags, env, homeDir, file });
}

/** Reads the bearer token. Called per connection attempt so a rotated token file is picked up. */
export async function readToken(source: TokenSource): Promise<string> {
  if (source.kind === "env") return source.token;
  let text: string;
  try {
    text = await readFile(source.path, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    throw new ConfigError(
      code === "ENOENT"
        ? `token file not found: ${source.path}`
        : `could not read token file ${source.path}: ${(cause as Error).message}`,
    );
  }
  const token = text.trim();
  if (token.length === 0) throw new ConfigError(`token file is empty: ${source.path}`);
  return token;
}
