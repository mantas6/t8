/**
 * t3tui entry point: parses flags, connects (`Connection` + `StateSync` in an
 * Effect runtime), mounts the Solid app and owns shutdown. The terminal is
 * restored on every exit path: `:q` / double Ctrl-C, signals (the renderer
 * handles SIGTERM, SIGHUP, ... by destroying itself, which lands here), and
 * uncaught errors.
 *
 * Usage: t3tui [--server <url>] [--token-file <path>] [--thread <id>]
 */
import { parseArgs } from "node:util";
import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { ThreadId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { ConfigError, loadConfig } from "./config.ts";
import * as ConnectionModule from "./connection/connection.ts";
import * as StateSyncModule from "./state/sync.ts";
import { App } from "./tui/App.tsx";
import { describeError, makeBackend } from "./tui/backend.ts";

const USAGE = `t3tui: terminal client for a T3 Code server

Usage: t3tui [options]  (from a checkout: bun run dev [options])

Options:
  --server <url>        Server URL (default http://localhost:3773)
  --token-file <path>   File holding the bearer token
  --thread <id>         Open this thread on start
  -h, --help            Show this help

Press ? inside the app for the keys.
`;

/** How long shutdown waits for the connection to close before exiting anyway. */
const DISPOSE_TIMEOUT_MS = 2_000;

function parse(argv: ReadonlyArray<string>) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      server: { type: "string" },
      "token-file": { type: "string" },
      token: { type: "string" },
      thread: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.token !== undefined) {
    throw new Error(
      "--token is not supported: argv is visible to other processes. Use --token-file or T3TUI_TOKEN.",
    );
  }
  return values;
}

async function main(): Promise<void> {
  let values: ReturnType<typeof parse>;
  try {
    values = parse(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`t3tui: ${(cause as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig({ server: values.server, tokenFile: values["token-file"] });
  } catch (cause) {
    process.stderr.write(`t3tui: ${(cause as Error).message}\n`);
    process.exit(cause instanceof ConfigError ? 2 : 1);
  }

  // Sync problems (a bad stream item, a resubscribe) are shown in the status line.
  const errorListeners = new Set<(message: string) => void>();
  const layer = StateSyncModule.layer({
    onError: (message) => {
      for (const listener of errorListeners) listener(message);
    },
  }).pipe(Layer.provideMerge(ConnectionModule.layer(config)));
  const runtime = ManagedRuntime.make(layer);
  const backend = await makeBackend(runtime);

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
    targetFps: 60,
  });

  let shuttingDown = false;
  const shutdown = async (code: number, error?: unknown) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (!renderer.isDestroyed) renderer.destroy();
      await renderer.closed.catch(() => {});
    } catch {
      // the terminal is gone; nothing left to restore
    }
    if (error !== undefined) {
      const detail = error instanceof Error && error.stack ? error.stack : describeError(error);
      process.stderr.write(`t3tui: ${detail}\n`);
    }
    await Promise.race([
      runtime.dispose().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, DISPOSE_TIMEOUT_MS)),
    ]);
    process.exit(code);
  };

  renderer.once("destroy", () => void shutdown(0));
  process.on("uncaughtException", (error) => void shutdown(1, error));
  process.on("unhandledRejection", (error) => void shutdown(1, error));

  const initialThreadId = values.thread === undefined ? null : ThreadId.make(values.thread);
  await render(
    () => (
      <App
        backend={backend}
        initialThreadId={initialThreadId}
        onQuit={() => void shutdown(0)}
        subscribeErrors={(listener) => {
          errorListeners.add(listener);
          return () => errorListeners.delete(listener);
        }}
      />
    ),
    renderer,
  );
}

await main();
