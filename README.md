<img src="assets/icon.svg" width="64" height="64" alt="">

# t3tui

A terminal UI client for the [T3 Code](https://t3.codes) server
([upstream](https://github.com/pingdotgg/t3code)). It talks to the server over
the same Effect RPC WebSocket API the web and desktop apps use, using the
server's own contract definitions (vendored in `vendor/contracts`).

Built with [Bun](https://bun.com), [Effect](https://effect.website),
[OpenTUI](https://github.com/anomalyco/opentui) and Solid.

## Status

Early development. There is a connection layer (auth, version gate, pings,
reconnect), typed command helpers and a headless CLI; the TUI itself is still a
smoke test. Targets T3 Code server **v0.1.2** (orchestration protocol 2).

## Running

Requirements: Bun (the Nix flake provides it: `nix develop`, or `direnv allow`
with the included `.envrc`).

```sh
bun install

# Check that a server is reachable and speaks a compatible protocol
bun run probe                         # defaults to http://localhost:3773
bun run probe http://host:3773

# Start the TUI (currently a smoke test; press q or Ctrl-C to quit)
bun run dev
```

### Configuration

The client authenticates with a bearer token issued by the server (it needs the
`orchestration:read` scope, plus `orchestration:operate` to send commands). Put
it in a file readable only by you, by default `~/.config/t3tui/token`.

Settings are resolved in this order (first wins):

1. Flags: `--server <url>`, `--token-file <path>`
2. Environment: `T3TUI_SERVER`, `T3TUI_TOKEN` (the token itself), `T3TUI_TOKEN_FILE`
3. `$XDG_CONFIG_HOME/t3tui/config.json` (default `~/.config/t3tui/config.json`):

   ```json
   { "server": "http://localhost:3773", "tokenFile": "token" }
   ```

   A relative `tokenFile` is resolved against the config directory.
4. Defaults: `http://localhost:3773` and `~/.config/t3tui/token`

The token is never accepted as a command-line argument.

### Headless CLI

```sh
bun run cli env                         # server version and protocol check
bun run cli shell                       # projects + threads, then live shell events
bun run cli tail <threadId>             # thread snapshot, then live events
bun run cli tail <threadId> --until-idle
bun run cli send <threadId> "text"      # --intent auto|steer|restart|queue
bun run cli interrupt <threadId>        # --run <runId> for one run
bun run cli create <projectId> --title "..." --provider <instanceId> --model <model>
bun run cli archive <threadId>
```

Add `--json` for one JSON summary per line or `--raw` for the full decoded
stream items. Connection status goes to stderr.

Development:

```sh
bun run typecheck
bun run lint
bun run format
bun test
```

### NixOS

OpenTUI ships a prebuilt native library (`libopentui.so`) that is loaded via
Bun FFI. It only links against glibc (`libc`, `libm`, `libpthread`, `libdl`),
which Bun has already loaded, so it works on NixOS without `nix-ld` or
patching.

## Third-party code

The vendored contracts in `vendor/contracts` are MIT licensed by
T3 Tools Inc.; see `vendor/contracts/LICENSE`.
