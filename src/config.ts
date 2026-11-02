/**
 * Client configuration: which server to talk to and where the bearer token
 * lives.
 *
 * `$XDG_CONFIG_HOME/t3tui/config.json` (default `~/.config/t3tui/config.json`)
 * holds named server profiles:
 *
 *   { "default": "home",
 *     "servers": { "home": { "server": "http://localhost:3773", "tokenFile": "home.token",
 *                            "environmentId": "...", "label": "...", "expiresAt": "..." } } }
 *
 * The older flat shape `{ "server": ..., "tokenFile": ... }` is read as a
 * single profile named `default`, and rewritten in the new shape the first
 * time a profile is saved. A relative `tokenFile` resolves against the config
 * directory.
 *
 * Resolution order, highest priority first:
 *   1. CLI flags `--server <url>` and `--token-file <path>`
 *   2. Environment: `T3TUI_SERVER`, `T3TUI_TOKEN` (the token itself),
 *      `T3TUI_TOKEN_FILE`
 *   3. The selected profile: `--profile <name>`, else `T3TUI_PROFILE`, else
 *      the file's `default`, else the only profile there is.
 *   4. Defaults: `http://localhost:3773` and `<config dir>/token`.
 *
 * The token is deliberately never accepted as a CLI argument: argv is visible
 * to other users through the process table and ends up in shell history.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  readonly profile?: string | undefined;
}

/** One saved server. Unknown keys are ignored. */
export interface Profile {
  /** Server URL; the default server when absent (only in migrated flat configs). */
  readonly server?: string | undefined;
  /** Token file; relative to the config directory unless absolute or `~/...`. */
  readonly tokenFile?: string | undefined;
  /** The server's environment id, from its descriptor at pairing time. */
  readonly environmentId?: string | undefined;
  /** The server's environment label, from its descriptor at pairing time. */
  readonly label?: string | undefined;
  /** When the saved token expires (ISO 8601), as reported by the server. */
  readonly expiresAt?: string | undefined;
  /** Scopes the server granted to the saved token (space separated). */
  readonly scope?: string | undefined;
}

/** Contents of `config.json`, normalised to the profile shape. */
export interface ConfigFile {
  /** Name of the profile used when none is selected. */
  readonly default?: string | undefined;
  readonly servers: Readonly<Record<string, Profile>>;
  /** True when the file had the old flat shape (read as profile `default`). */
  readonly legacy?: boolean | undefined;
}

/** The name of the profile a flat (pre-profile) config is read as. */
export const LEGACY_PROFILE_NAME = "default";

/** The profile a resolved configuration came from. */
export interface ResolvedProfile {
  readonly name: string;
  readonly label?: string | undefined;
  readonly environmentId?: string | undefined;
  readonly expiresAt?: string | undefined;
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
  /** The profile the server and token came from; null when none was used. */
  readonly profile: ResolvedProfile | null;
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

/**
 * Picks the profile: `--profile`, else `T3TUI_PROFILE`, else the file's
 * default, else the only profile. Undefined when there is nothing to pick.
 * An explicitly named profile that does not exist is an error.
 */
export function selectProfile(
  file: ConfigFile | undefined,
  flags: ConfigFlags,
  env: Readonly<Record<string, string | undefined>>,
): { readonly name: string; readonly profile: Profile } | undefined {
  const servers = file?.servers ?? {};
  const names = Object.keys(servers);
  const known = names.length === 0 ? "none saved" : `saved: ${names.join(", ")}`;
  const explicit = nonEmpty(flags.profile) ?? nonEmpty(env.T3TUI_PROFILE);
  if (explicit !== undefined) {
    const profile = servers[explicit];
    if (profile === undefined) throw new ConfigError(`unknown profile "${explicit}" (${known})`);
    return { name: explicit, profile };
  }
  const fallback = nonEmpty(file?.default);
  if (fallback !== undefined) {
    const profile = servers[fallback];
    if (profile === undefined) {
      throw new ConfigError(`the default profile "${fallback}" does not exist (${known})`);
    }
    return { name: fallback, profile };
  }
  const [only] = names;
  if (names.length === 1 && only !== undefined) {
    const profile = servers[only];
    if (profile !== undefined) return { name: only, profile };
  }
  return undefined;
}

/** Absolute path of a profile's token file. */
export function profileTokenPath(profile: Profile, configDir: string, homeDir: string): string {
  const file = nonEmpty(profile.tokenFile);
  return file === undefined
    ? join(configDir, DEFAULT_TOKEN_FILE_NAME)
    : resolve(configDir, expandHome(file, homeDir));
}

/** Pure resolution step; no I/O, so it can be unit tested. */
export function resolveConfig(input: ResolveInput): ResolvedConfig {
  const { flags, env, homeDir, file } = input;
  const configDir = configDirFor(env, homeDir);
  const selected = selectProfile(file, flags, env);
  const profile = selected?.profile;

  const server =
    nonEmpty(flags.server) ??
    nonEmpty(env.T3TUI_SERVER) ??
    nonEmpty(profile?.server) ??
    DEFAULT_SERVER_URL;
  const serverUrl = normalizeServerUrl(server);

  let token: TokenSource;
  const flagTokenFile = nonEmpty(flags.tokenFile);
  const envToken = nonEmpty(env.T3TUI_TOKEN);
  const envTokenFile = nonEmpty(env.T3TUI_TOKEN_FILE);
  if (flagTokenFile !== undefined) {
    token = { kind: "file", path: resolve(expandHome(flagTokenFile, homeDir)) };
  } else if (envToken !== undefined) {
    token = { kind: "env", token: envToken };
  } else if (envTokenFile !== undefined) {
    token = { kind: "file", path: resolve(expandHome(envTokenFile, homeDir)) };
  } else if (profile !== undefined) {
    token = { kind: "file", path: profileTokenPath(profile, configDir, homeDir) };
  } else {
    token = { kind: "file", path: join(configDir, DEFAULT_TOKEN_FILE_NAME) };
  }

  return {
    serverUrl,
    wsUrl: deriveWsUrl(serverUrl),
    token,
    configDir,
    profile:
      selected === undefined
        ? null
        : {
            name: selected.name,
            ...(profile?.label === undefined ? {} : { label: profile.label }),
            ...(profile?.environmentId === undefined
              ? {}
              : { environmentId: profile.environmentId }),
            ...(profile?.expiresAt === undefined ? {} : { expiresAt: profile.expiresAt }),
          },
  };
}

const PROFILE_KEYS = [
  "server",
  "tokenFile",
  "environmentId",
  "label",
  "expiresAt",
  "scope",
] as const satisfies ReadonlyArray<keyof Profile>;

function parseProfile(raw: unknown, where: string): Profile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${where}: expected a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  const profile: Record<string, string> = {};
  for (const key of PROFILE_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new ConfigError(`${where}: "${key}" must be a string`);
    profile[key] = value;
  }
  return profile as Profile;
}

/** Profile names are used in file names, so they are kept to a safe alphabet. */
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateProfileName(name: string): string {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new ConfigError(
      `invalid profile name "${name}": use letters, digits, ".", "_" or "-" (up to 64, starting with a letter or digit)`,
    );
  }
  return name;
}

/**
 * Validates the parsed JSON of `config.json`. The flat pre-profile shape
 * `{ "server", "tokenFile" }` becomes a single profile named `default`.
 */
export function parseConfigFile(raw: unknown, path: string): ConfigFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${path}: expected a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  if (record.servers === undefined) {
    const legacy = parseProfile({ server: record.server, tokenFile: record.tokenFile }, path);
    if (legacy.server === undefined && legacy.tokenFile === undefined) return { servers: {} };
    return {
      default: LEGACY_PROFILE_NAME,
      servers: { [LEGACY_PROFILE_NAME]: legacy },
      legacy: true,
    };
  }
  const { servers } = record;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new ConfigError(`${path}: "servers" must be an object`);
  }
  const parsed: Record<string, Profile> = {};
  for (const [name, value] of Object.entries(servers)) {
    parsed[name] = parseProfile(value, `${path}: servers.${name}`);
  }
  if (record.default !== undefined && typeof record.default !== "string") {
    throw new ConfigError(`${path}: "default" must be a string`);
  }
  return {
    ...(record.default === undefined ? {} : { default: record.default as string }),
    servers: parsed,
  };
}

/** The JSON written to `config.json` (always the profile shape). */
export function serializeConfigFile(file: ConfigFile): string {
  const servers: Record<string, Profile> = {};
  for (const name of Object.keys(file.servers).sort()) {
    const profile = file.servers[name];
    if (profile === undefined) continue;
    const clean: Record<string, string> = {};
    for (const key of PROFILE_KEYS) {
      const value = profile[key];
      if (value !== undefined) clean[key] = value;
    }
    servers[name] = clean as Profile;
  }
  const out = file.default === undefined ? { servers } : { default: file.default, servers };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Lowercase `a-z0-9-` slug of a label, for a profile name. */
export function slugify(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug === "" ? "server" : slug;
}

export interface SaveProfileInput {
  /** Explicit name (`--name`); otherwise derived from the environment. */
  readonly name?: string | undefined;
  readonly environmentId: string;
  readonly label: string;
  /** Make it the default even when another default exists. */
  readonly makeDefault?: boolean | undefined;
}

export interface ProfilePlan {
  readonly name: string;
  /** False when an existing profile is updated. */
  readonly created: boolean;
  readonly becomesDefault: boolean;
}

/**
 * Decides the profile a new pairing is saved as: the explicit name, else an
 * existing profile for the same environment, else the slugified label (with
 * `-2`, `-3`, ... when another environment already has that name). It becomes
 * the default when asked to, when there is no (valid) default yet, or when it
 * already was the default.
 */
export function planProfile(file: ConfigFile | undefined, input: SaveProfileInput): ProfilePlan {
  const servers = file?.servers ?? {};
  let name: string;
  if (input.name !== undefined) {
    name = validateProfileName(input.name.trim());
  } else {
    const existing = Object.entries(servers).find(
      ([, profile]) => profile.environmentId === input.environmentId,
    );
    if (existing !== undefined) {
      name = existing[0];
    } else {
      const base = slugify(input.label);
      name = base;
      for (let n = 2; servers[name] !== undefined; n++) name = `${base}-${n}`;
    }
  }
  const currentDefault = file?.default;
  const hasValidDefault = currentDefault !== undefined && servers[currentDefault] !== undefined;
  return {
    name,
    created: servers[name] === undefined,
    becomesDefault: input.makeDefault === true || !hasValidDefault || currentDefault === name,
  };
}

/** `file` with `profile` stored under `name` (and made the default if asked). */
export function withProfile(
  file: ConfigFile | undefined,
  name: string,
  profile: Profile,
  makeDefault: boolean,
): ConfigFile {
  const servers = { ...(file?.servers ?? {}), [name]: profile };
  const fallback = file?.default;
  const defaultName = makeDefault ? name : fallback;
  return defaultName === undefined ? { servers } : { default: defaultName, servers };
}

/**
 * `file` without the profile `name`. When it was the default, the default
 * moves to the only remaining profile, or is dropped.
 */
export function withoutProfile(file: ConfigFile, name: string): ConfigFile {
  const servers = { ...file.servers };
  delete servers[name];
  let defaultName = file.default;
  if (defaultName === name) {
    const remaining = Object.keys(servers);
    defaultName = remaining.length === 1 ? remaining[0] : undefined;
  }
  return defaultName === undefined ? { servers } : { default: defaultName, servers };
}

/** Reads and validates `config.json`; undefined when it does not exist. */
export async function readConfigFile(path: string): Promise<ConfigFile | undefined> {
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

/**
 * Writes `contents` to `path` atomically (a temporary file in the same
 * directory, then a rename) with mode 600. The directory is created with
 * mode 700 if missing.
 */
export async function writePrivateFile(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    // The mode given to writeFile is subject to the umask.
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (cause) {
    await unlink(temporary).catch(() => {});
    throw new ConfigError(`could not write ${path}: ${(cause as Error).message}`);
  }
}

export function configFilePath(configDir: string): string {
  return join(configDir, CONFIG_FILE_NAME);
}

export async function writeConfigFile(configDir: string, file: ConfigFile): Promise<void> {
  await writePrivateFile(configFilePath(configDir), serializeConfigFile(file));
}

/** A token file path as stored in a profile: relative when inside the config dir. */
export function storedTokenPath(configDir: string, path: string): string {
  return isInsideConfigDir(configDir, path) ? relative(configDir, path) : path;
}

/** Whether `path` lies inside the config directory (and may be removed with its profile). */
export function isInsideConfigDir(configDir: string, path: string): boolean {
  const inside = relative(configDir, path);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

/** Resolves configuration from flags, the process environment and `config.json`. */
export async function loadConfig(
  flags: ConfigFlags = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ResolvedConfig> {
  const homeDir = homedir();
  const file = await readConfigFile(configFilePath(configDirFor(env, homeDir)));
  return resolveConfig({ flags, env, homeDir, file });
}

/**
 * The configuration for one saved profile alone: the server and token
 * overrides from flags and the environment are ignored, since the profile
 * was picked explicitly (the TUI's `:servers` and `:connect`).
 */
export async function loadProfileConfig(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ResolvedConfig> {
  const homeDir = homedir();
  const configDir = configDirFor(env, homeDir);
  const file = await readConfigFile(configFilePath(configDir));
  return resolveConfig({
    flags: { profile: name },
    env: env.XDG_CONFIG_HOME === undefined ? {} : { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME },
    homeDir,
    file,
  });
}

/** Whether an ISO timestamp lies in the past (false when absent or unparsable). */
export function isExpired(expiresAt: string | undefined, now: number = Date.now()): boolean {
  if (expiresAt === undefined) return false;
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time <= now;
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
