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
reconnect), typed command helpers, a client state layer (Solid stores fed by
pure reducers over the server's event stream), a headless CLI, and the core of
the TUI: a full-screen transcript of one thread with vim-style keys, a
message input, approval prompts, a `:` command line and fuzzy pickers for
threads, projects, models, runtime modes and the message queue. Targets T3
Code server **v0.1.2** (orchestration protocol 2).

## Running

Requirements: Bun (the Nix flake provides it: `nix develop`, or `direnv allow`
with the included `.envrc`).

```sh
bun install

# Check that a server is reachable and speaks a compatible protocol
bun run probe                         # defaults to http://localhost:3773
bun run probe http://host:3773

# Start the TUI
bun run dev                           # then :t to pick a thread
bun run dev --thread <threadId>       # also --server <url>, --token-file <path>
```

### The TUI

One full-screen surface: a status line on top (mode, project, branch, thread,
model, run status, connection), the transcript in the middle, and the message
input at the bottom with a hint line under it. When the agent asks for an
approval or has a question, the input is replaced by the request so it cannot
be missed. A banner appears under the status line while disconnected.

Keys are modal, like vim. Counts work (`5j`, `3<C-f>`), as do two-key
sequences (`gg`, `]]`, `za`) with a 500 ms timeout. `?` shows the full list.

| NORMAL (transcript)         |                                                   |
| --------------------------- | ------------------------------------------------- |
| `j` `k` / `Ctrl-e` `Ctrl-y` | scroll one line                                   |
| `Ctrl-d` `Ctrl-u`           | scroll half a page (`Ctrl-d` never quits)         |
| `Ctrl-f` `Ctrl-b`           | scroll a page                                     |
| `gg` / `G`                  | top / bottom (`G` turns tail-follow back on)      |
| `]]` `[[`                   | next / previous message                           |
| `]t` `[t`                   | next / previous tool call                         |
| `za` or `Tab` / `zM` / `zR` | fold the focused item / fold all / unfold all     |
| `i` `a` / `o`               | write a message (keep draft / start empty)        |
| `y`                         | copy the focused message (OSC 52, works over SSH) |
| `x`                         | interrupt the run                                 |
| `gt` `gT`                   | next / previous thread in the project             |
| `/` then `n` `N`            | search the transcript, next / previous match      |
| `:`                         | command line (see below)                          |
| `?`                         | help                                              |
| `Ctrl-c`                    | interrupt the run; twice within a second quits    |

| INSERT (message input)               |                                              |
| ------------------------------------ | -------------------------------------------- |
| `Enter`                              | send                                         |
| `Shift-Enter`, `Ctrl-j`, `Alt-Enter` | newline                                      |
| `Ctrl-s`                             | send as steer (into the running turn)        |
| `Ctrl-q`                             | send queued (runs after the active run)      |
| `Esc` / `Ctrl-c`                     | back to NORMAL / clear the draft and go back |
| `Ctrl-d` `Ctrl-u` `Ctrl-f` `Ctrl-b`  | scroll the transcript                        |

| Pending request |                                                      |
| --------------- | ---------------------------------------------------- |
| `y` / `n`       | approve / deny                                       |
| `1`-`9`         | pick an option or answer                             |
| `i`             | type the answer (free-text questions, own answers)   |
| `Esc` / `Enter` | leave the request (it stays visible) / go back to it |

A request that appears (or whose options change) ignores `y`, `n` and `1`-`9`
for half a second, so keys meant for something else cannot answer it unseen;
each request is answered once. If it appears while you are typing a message,
the input keeps the keyboard and the request shows above it: `Esc`, then
`Enter` to answer it. A question without options, or one that allows its own
answer, is answered by typing (`i`, then `Enter`); a request the provider wants
answered by message (`responseCapability: message`) takes a normal message.

Sending keeps the draft in the input until the server has accepted it. While
disconnected, a command waits up to 3 seconds for the connection and then
fails with "not connected"; sending the same draft again reuses its message
and command ids, so the server drops a duplicate if the first try did arrive.

#### Commands

`Tab` completes command names, and thread titles or project names where a
command takes one (press it again to cycle). `Up` / `Down` walk the history of
this session. An unknown command says so in the status line.

| Command                 | What it does                                                   |
| ----------------------- | -------------------------------------------------------------- |
| `:t` `:threads [text]`  | thread picker, optionally pre-filtered                         |
| `:p` `:projects [name]` | project switcher; with a name, that project's threads          |
| `:n` `:new [title]`     | new thread: pick the project, then the title (empty: untitled) |
| `:m` `:model`           | model picker for the open thread                               |
| `:mode`                 | runtime mode picker for the open thread                        |
| `:b` `:thread <n>`      | open thread number `n` from `:t` (a title works too)           |
| `:bn` `:bp`             | next / previous thread in the project (like `gt` / `gT`)       |
| `:queue`                | queued messages of the open thread                             |
| `:archive`              | archive the open thread (asks first)                           |
| `:a` `:approve`         | approve the pending request                                    |
| `:d` `:deny`            | deny the pending request                                       |
| `:reconnect`            | reconnect now; after a fatal error, try again (token re-read)  |
| `:h` `:help`            | keys and commands                                              |
| `:q`                    | quit; refused while a run is active in the open thread         |
| `:qa` `:q!`             | quit anyway                                                    |
| `:w`                    | nothing to save                                                |

#### Pickers

Pickers open as a box over the transcript, which keeps streaming underneath.
Typing filters (fuzzy: `t3t` finds "t3tui"); the best match gets the cursor.

| Picker keys                     |                                                          |
| ------------------------------- | -------------------------------------------------------- |
| `Up` `Down` / `Ctrl-n` `Ctrl-p` | move (also `j` `k` while the filter is empty)            |
| `Enter`                         | open / choose                                            |
| `Esc`                           | clear the filter, then close (`Ctrl-c` closes at once)   |
| `dd`                            | thread picker: archive; queue: cancel (both ask `y`/`n`) |
| `J` `K`                         | queue: move the message down / up                        |
| `Ctrl-a`                        | thread picker: show / hide archived threads              |

The thread picker groups threads by project, newest activity first. Each row
has its number (what `:b <n>` takes), a status glyph (`●` running, `?` waiting
for an approval or answer, `·` idle, `✕` failed, `×` archived), the title, the
project and how long ago it was active. `:n` creates the thread with the
project's default model, else the model picked last in this session, else the
model of the project's newest thread, else the server's default (asking with
the model picker if there is none), and the server's default runtime mode;
the new thread opens in INSERT. The model picker lists the server's enabled
provider instances and their models (`server.getConfig`, cached); the current
model is marked `●`.

The transcript follows new output while you are at the bottom; scrolling up
stops that, and reaching the bottom again (or `G`, or sending) resumes it.
Tool calls and reasoning are folded to one line; unfolding a tool call whose
output the server did not stream fetches it. `Shift-Enter` needs a terminal
with the kitty keyboard protocol (kitty, foot, WezTerm, Ghostty, Alacritty);
elsewhere use `Ctrl-j` or `Alt-Enter`. Inside tmux, OSC 52 needs
`set -g set-clipboard on` (or `allow-passthrough on`).

#### Code blocks

Fenced code blocks in messages and plans are syntax highlighted with
tree-sitter. Besides the grammars OpenTUI bundles (JavaScript, TypeScript,
JSX/TSX, Markdown, Zig), t3tui registers these (`src/tui/parsers.ts`):

| Language | Fence info strings                                 |
| -------- | -------------------------------------------------- |
| Bash     | `bash`, `sh`, `shell`, `zsh`                       |
| PHP      | `php` (with or without `<?php`)                    |
| Nix      | `nix` (build phases, shell scripts as Bash)        |
| Go       | `go`, `golang`                                     |
| Python   | `python`, `py`                                     |
| JSON     | `json`, `jsonc`                                    |
| YAML     | `yaml`, `yml`                                      |
| TOML     | `toml`                                             |
| SQL      | `sql`, `postgresql`, `postgres`, `mysql`, `sqlite` |
| HTML     | `html`, `htm`, `xhtml` (`<script>` as JavaScript)  |
| CSS      | `css`                                              |
| Diff     | `diff`, `patch`, `udiff`                           |

A block in any other language is shown as plain code. The grammars are local
files (pinned npm packages, and `vendor/grammars` for Nix, SQL and Diff, which
have no npm build); nothing is downloaded at runtime.

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

The token is never accepted as a command-line argument. It is read again on
every connection attempt: after the server rejected it (the status line says
`failed`), fix the token file and run `:reconnect`.

### Headless CLI

```sh
bun run cli env                         # server version and protocol check
bun run cli shell                       # projects + threads, then live shell events
bun run cli tail <threadId>             # thread snapshot, then live events
bun run cli tail <threadId> --until-idle
bun run cli watch <threadId>            # client-side transcript + pending requests, live
bun run cli send <threadId> "text"      # --intent auto|steer|restart|queue
bun run cli respond <threadId> <requestId> --decision accept   # or --answers '{"q1":"yes"}'
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

## Install with Nix

The flake builds a `t3tui` command that runs the sources with Bun from
nixpkgs (currently for `x86_64-linux`). Replace `<owner>` with the GitHub
owner of this repository.

```sh
# Run without installing
nix run github:<owner>/t3tui -- --server http://localhost:3773 --thread <threadId>

# Install into your profile
nix profile install github:<owner>/t3tui
```

As a flake input of a NixOS or home-manager configuration:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    t3tui = {
      url = "github:<owner>/t3tui";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, t3tui, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ({ pkgs, ... }: {
          # NixOS; for home-manager use home.packages instead
          environment.systemPackages = [
            t3tui.packages.${pkgs.stdenv.hostPlatform.system}.default
          ];
        })
      ];
    };
  };
}
```

From a checkout: `nix build` (the result is `./result/bin/t3tui`), `nix run . -- --help`,
and `nix flake check` (builds the package and checks the Nix formatting).

### Updating the dependency hash

The Nix build installs the dependencies in a fixed-output derivation whose hash
is recorded in `nix/deps-hash.txt`. The hash is the same on every system. When
it is stale (after changing `bun.lock`, or when a `nix flake update` brings a
new Bun), the build fails with a hash mismatch; put the new hash in the file:

```sh
nix build .#t3tui.node_modules 2>&1 | grep 'got:'
#          got:    sha256-...
echo 'sha256-...' > nix/deps-hash.txt
nix build
```

## Third-party code

The vendored contracts in `vendor/contracts` are MIT licensed by
T3 Tools Inc.; see `vendor/contracts/LICENSE`.

The tree-sitter grammars and queries in `vendor/grammars` are MIT licensed by
their authors; each directory has its `LICENSE` and a `VENDORED.md` with the
source and version.
