/**
 * Saved server profiles: `connect` (pair with a server and save it),
 * `servers` (list) and `forget` (remove). Shared by `t3tui` (`main.tsx`), the
 * headless CLI (`cli.ts`) and the TUI's `:connect` / `:servers`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as Effect from "effect/Effect";

import {
  ConfigError,
  type ConfigFile,
  configDirFor,
  configFilePath,
  isExpired,
  isInsideConfigDir,
  type Profile,
  planProfile,
  profileTokenPath,
  readConfigFile,
  storedTokenPath,
  validateProfileName,
  withoutProfile,
  withProfile,
  writeConfigFile,
  writePrivateFile,
} from "./config.ts";
import {
  canOperate,
  PairingError,
  type PairingInput,
  pair,
  parsePairingTarget,
} from "./pairing.ts";

type Env = Readonly<Record<string, string | undefined>>;

export const PROFILE_COMMANDS: ReadonlySet<string> = new Set(["connect", "servers", "forget"]);

export const PROFILE_USAGE = `  connect <pairing-link>       Pair with a server and save it as a profile
       [--host <url> --code <code>]  (instead of the link)
       [--name <profile>]      Profile name (default: from the server's label)
       [--default]             Make it the default profile
  servers                      List saved profiles
  forget <profile>             Remove a profile and its token file`;

export interface SavedConnection {
  readonly name: string;
  readonly created: boolean;
  readonly isDefault: boolean;
  readonly defaultName: string | undefined;
  readonly server: string;
  readonly label: string;
  readonly environmentId: string;
  readonly tokenPath: string;
  readonly expiresAt: string;
  readonly expiresInSeconds: number;
  readonly scope: string;
  readonly migrated: boolean;
}

export interface ConnectOptions {
  readonly name?: string | undefined;
  readonly makeDefault?: boolean | undefined;
}

/**
 * Pairs with the server and saves the token and profile. The token goes to
 * `<config dir>/<profile>.token` (mode 600) before the config is written, so
 * a profile never points at a missing token.
 */
export async function connectAndSave(
  input: PairingInput,
  options: ConnectOptions = {},
  env: Env = process.env,
): Promise<SavedConnection> {
  if (options.name !== undefined) validateProfileName(options.name.trim());
  const homeDir = homedir();
  const configDir = configDirFor(env, homeDir);
  // Read (and validate) the config before spending the one-time link.
  const file = await readConfigFile(configFilePath(configDir));
  const result = await Effect.runPromise(pair(input));
  const { environment, issued, serverUrl } = result;
  const plan = planProfile(file, {
    name: options.name,
    environmentId: environment.environmentId,
    label: environment.label,
    makeDefault: options.makeDefault,
  });
  const tokenPath = join(configDir, `${plan.name}.token`);
  await writePrivateFile(tokenPath, `${issued.token}\n`);
  const profile: Profile = {
    server: serverUrl,
    tokenFile: storedTokenPath(configDir, tokenPath),
    environmentId: environment.environmentId,
    label: environment.label,
    expiresAt: issued.expiresAt,
    scope: issued.scope,
  };
  const next = withProfile(file, plan.name, profile, plan.becomesDefault);
  await writeConfigFile(configDir, next);
  return {
    name: plan.name,
    created: plan.created,
    isDefault: next.default === plan.name,
    defaultName: next.default,
    server: serverUrl,
    label: environment.label,
    environmentId: environment.environmentId,
    tokenPath,
    expiresAt: issued.expiresAt,
    expiresInSeconds: issued.expiresInSeconds,
    scope: issued.scope,
    migrated: file?.legacy === true,
  };
}

export interface ProfileEntry {
  readonly name: string;
  readonly profile: Profile;
  readonly isDefault: boolean;
  readonly expired: boolean;
}

/** The saved profiles, sorted by name. */
export async function listProfiles(env: Env = process.env): Promise<ReadonlyArray<ProfileEntry>> {
  const configDir = configDirFor(env, homedir());
  const file = await readConfigFile(configFilePath(configDir));
  return profileEntries(file);
}

export function profileEntries(file: ConfigFile | undefined): ReadonlyArray<ProfileEntry> {
  if (file === undefined) return [];
  const names = Object.keys(file.servers);
  const defaultName = file.default ?? (names.length === 1 ? names[0] : undefined);
  return names.sort().map((name) => {
    const profile = file.servers[name] ?? {};
    return {
      name,
      profile,
      isDefault: name === defaultName,
      expired: isExpired(profile.expiresAt),
    };
  });
}

/** `2026-12-02 (in 30 days)`, `expired 2026-10-01`, or `-`. */
export function describeExpiry(expiresAt: string | undefined, now: number = Date.now()): string {
  if (expiresAt === undefined) return "-";
  const time = Date.parse(expiresAt);
  if (!Number.isFinite(time)) return expiresAt;
  const date = new Date(time).toISOString().slice(0, 10);
  if (time <= now) return `expired ${date}`;
  const days = Math.round((time - now) / 86_400_000);
  const hours = Math.max(1, Math.round((time - now) / 3_600_000));
  const left = days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : `${hours} h`;
  return `${date} (in ${left})`;
}

export interface ForgetResult {
  readonly name: string;
  readonly tokenPath: string;
  /** What happened to the token file. */
  readonly token: "trashed" | "deleted" | "kept" | "missing";
  readonly newDefault: string | undefined;
}

async function disposeTokenFile(
  path: string,
  env: Env,
): Promise<"trashed" | "deleted" | "missing"> {
  if (!(await Bun.file(path).exists())) return "missing";
  const trash = Bun.which("trash", { PATH: env.PATH ?? "" });
  if (trash !== null) {
    const child = Bun.spawn([trash, path], { stdout: "ignore", stderr: "ignore" });
    if ((await child.exited) === 0) return "trashed";
  }
  const { unlink } = await import("node:fs/promises");
  await unlink(path);
  return "deleted";
}

/**
 * Removes a profile. Its token file is moved to the trash (or deleted when
 * there is no `trash` command) if it lives in the config directory; a token
 * file elsewhere is left alone.
 */
export async function forgetProfile(name: string, env: Env = process.env): Promise<ForgetResult> {
  const homeDir = homedir();
  const configDir = configDirFor(env, homeDir);
  const file = await readConfigFile(configFilePath(configDir));
  const profile = file?.servers[name];
  if (file === undefined || profile === undefined) {
    const known = file === undefined ? [] : Object.keys(file.servers);
    throw new ConfigError(
      `unknown profile "${name}" (${known.length === 0 ? "none saved" : `saved: ${known.join(", ")}`})`,
    );
  }
  const tokenPath = profileTokenPath(profile, configDir, homeDir);
  const sharedToken = Object.entries(file.servers).some(
    ([other, entry]) => other !== name && profileTokenPath(entry, configDir, homeDir) === tokenPath,
  );
  const next = withoutProfile(file, name);
  await writeConfigFile(configDir, next);
  const token =
    sharedToken || !isInsideConfigDir(configDir, tokenPath)
      ? "kept"
      : await disposeTokenFile(tokenPath, env);
  return { name, tokenPath, token, newDefault: next.default };
}

// ---------------------------------------------------------------------------
// Command line

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function err(text: string): void {
  process.stderr.write(`${text}\n`);
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

const homeDirectory = homedir();
const displayPath = (path: string) =>
  path === homeDirectory || path.startsWith(`${homeDirectory}/`)
    ? `~${path.slice(homeDirectory.length)}`
    : path;

/** Lines describing a saved connection; never includes the token. */
export function describeSaved(saved: SavedConnection): ReadonlyArray<string> {
  const lines = [
    `${saved.created ? "Saved" : "Updated"} profile "${saved.name}"${saved.isDefault ? " (default)" : ""}`,
    `  server:      ${saved.server}`,
    `  environment: ${saved.label} (${saved.environmentId})`,
    `  token file:  ${displayPath(saved.tokenPath)}`,
    `  scopes:      ${saved.scope}`,
    `  expires:     ${describeExpiry(saved.expiresAt)}`,
  ];
  if (!canOperate(saved.scope)) {
    lines.push("Read-only: the link did not grant orchestration:operate, so sending will fail.");
  }
  if (saved.migrated) {
    lines.push(`The old config was converted to profiles; it is now profile "default".`);
  }
  if (!saved.isDefault && saved.defaultName !== undefined) {
    lines.push(
      `The default profile is still "${saved.defaultName}": run t3tui -p ${saved.name}, or connect again with --default.`,
    );
  }
  return lines;
}

/** Reads one line (a pasted pairing link) from stdin. */
async function readLinkFromStdin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write("Paste the pairing link: ");
  for await (const line of console) return line.trim();
  return "";
}

/**
 * Runs `connect`, `servers` or `forget` with their own flags. Returns the
 * exit code. `program` names the command in messages.
 */
export async function runProfileCommand(
  argv: ReadonlyArray<string>,
  program: string,
  env: Env = process.env,
): Promise<number> {
  let parsed: ReturnType<typeof parseProfileArgs>;
  try {
    parsed = parseProfileArgs(argv);
  } catch (cause) {
    err(`${program}: ${(cause as Error).message}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;
  try {
    switch (command) {
      case "connect": {
        if (args.length > 1) throw new ConfigError("connect takes one pairing link");
        let link = args[0];
        if (link === undefined && values.host === undefined && values.code === undefined) {
          link = await readLinkFromStdin();
          if (link === "") throw new ConfigError("no pairing link given");
        }
        // Report a malformed link before contacting anything.
        parsePairingTarget({ pairingUrl: link, host: values.host, code: values.code });
        err("Checking the server…");
        const saved = await connectAndSave(
          { pairingUrl: link, host: values.host, code: values.code },
          { name: values.name, makeDefault: values.default },
          env,
        );
        if (values.json) {
          out(JSON.stringify(saved));
        } else {
          for (const line of describeSaved(saved)) out(line);
        }
        return 0;
      }
      case "servers": {
        const entries = await listProfiles(env);
        if (values.json) {
          for (const entry of entries) {
            out(
              JSON.stringify({
                name: entry.name,
                default: entry.isDefault,
                server: entry.profile.server ?? null,
                label: entry.profile.label ?? null,
                environmentId: entry.profile.environmentId ?? null,
                expiresAt: entry.profile.expiresAt ?? null,
                expired: entry.expired,
              }),
            );
          }
          return 0;
        }
        if (entries.length === 0) {
          out(`No saved servers. Run: ${program} connect '<pairing link>'`);
          return 0;
        }
        const rows = entries.map((entry) => [
          entry.isDefault ? "*" : " ",
          entry.name,
          entry.profile.server ?? "(default server)",
          entry.profile.label ?? "-",
          describeExpiry(entry.profile.expiresAt),
        ]);
        const header = [" ", "NAME", "SERVER", "LABEL", "EXPIRES"];
        const widths = header.map((_, column) =>
          Math.max(...[header, ...rows].map((row) => (row[column] ?? "").length)),
        );
        for (const row of [header, ...rows]) {
          out(
            row
              .map((cell, column) =>
                column === row.length - 1 ? cell : pad(cell, widths[column] ?? 0),
              )
              .join("  ")
              .trimEnd(),
          );
        }
        if (entries.some((entry) => entry.expired)) {
          out(`Expired tokens: run ${program} connect with a new pairing link.`);
        }
        return 0;
      }
      case "forget": {
        const name = args[0];
        if (name === undefined || args.length > 1) {
          throw new ConfigError("usage: forget <profile>");
        }
        const result = await forgetProfile(name, env);
        out(`Removed profile "${result.name}".`);
        switch (result.token) {
          case "trashed":
            out(`Moved its token file to the trash: ${displayPath(result.tokenPath)}`);
            break;
          case "deleted":
            out(`Deleted its token file: ${displayPath(result.tokenPath)}`);
            break;
          case "kept":
            out(
              `Kept its token file (outside the config dir or shared): ${displayPath(result.tokenPath)}`,
            );
            break;
          case "missing":
            break;
        }
        if (result.newDefault !== undefined) out(`Default profile: ${result.newDefault}`);
        out(
          "The session stays valid on the server until it expires; revoke it in Settings → Connections or with `t3 auth session revoke`.",
        );
        return 0;
      }
      default:
        err(`${program}: unknown command: ${command ?? ""}`);
        return 2;
    }
  } catch (cause) {
    err(`${program}: ${(cause as Error).message}`);
    return cause instanceof ConfigError ||
      (cause instanceof PairingError && cause.reason === "invalid-input")
      ? 2
      : 1;
  }
}

function parseProfileArgs(argv: ReadonlyArray<string>) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      name: { type: "string" },
      default: { type: "boolean", default: false },
      host: { type: "string" },
      code: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
}
