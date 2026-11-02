<img src="assets/icon.svg" width="64" height="64" alt="">

# t3tui

A terminal UI client for the [T3 Code](https://t3.codes) server
([upstream](https://github.com/pingdotgg/t3code)). It talks to the server over
the same Effect RPC WebSocket API the web and desktop apps use, using the
server's own contract definitions (vendored in `vendor/contracts`).

Built with [Bun](https://bun.com), [Effect](https://effect.website),
[OpenTUI](https://github.com/anomalyco/opentui) and Solid.

## Status

Early scaffolding. Nothing useful yet: there is a connectivity probe and an
OpenTUI smoke test. Targets T3 Code server **v0.1.2** (orchestration protocol 2).

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

Development:

```sh
bun run typecheck
bun run lint
bun run format
```

### NixOS

OpenTUI ships a prebuilt native library (`libopentui.so`) that is loaded via
Bun FFI. It only links against glibc (`libc`, `libm`, `libpthread`, `libdl`),
which Bun has already loaded, so it works on NixOS without `nix-ld` or
patching.

## Third-party code

The vendored contracts in `vendor/contracts` are MIT licensed by
T3 Tools Inc.; see `vendor/contracts/LICENSE`.
