#!/usr/bin/env bash
# Installs t8 without Nix: Bun (if it is missing), the t8 sources with their
# dependencies, and a `t8` launcher. Running it again updates t8.
#
#   curl -fsSL https://raw.githubusercontent.com/mantas6/t8/main/install.sh | bash
#
# Environment:
#   T8_HOME  where the sources go      (default: ~/.local/share/t8)
#   T8_BIN   where the launcher goes   (default: ~/.local/bin)
#   T8_REPO  GitHub repository         (default: mantas6/t8)
#   T8_REF   branch, tag or commit     (default: main)
set -euo pipefail

T8_HOME="${T8_HOME:-$HOME/.local/share/t8}"
T8_BIN="${T8_BIN:-$HOME/.local/bin}"
T8_REPO="${T8_REPO:-mantas6/t8}"
T8_REF="${T8_REF:-main}"
tmp=""

log() { printf 't8 install: %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    return
  fi
  local bun_dir="${BUN_INSTALL:-$HOME/.bun}"
  if [ ! -x "$bun_dir/bin/bun" ]; then
    log "Bun not found, installing it from https://bun.sh into $bun_dir"
    curl -fsSL https://bun.sh/install -o "$tmp/bun-install.sh"
    BUN_INSTALL="$bun_dir" bash "$tmp/bun-install.sh" </dev/null
  fi
  export PATH="$bun_dir/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "Bun is still not on PATH after installing it"
}

# Only replace a directory that is an earlier install (or empty).
check_target() {
  [ -e "$T8_HOME" ] || return 0
  [ -d "$T8_HOME" ] || die "$T8_HOME exists and is not a directory"
  if [ -n "$(ls -A "$T8_HOME")" ] && ! grep -q '"name": "t8"' "$T8_HOME/package.json" 2>/dev/null; then
    die "$T8_HOME exists and does not look like a t8 install; set T8_HOME to another directory"
  fi
}

main() {
  check_target
  mkdir -p "$(dirname "$T8_HOME")" "$T8_BIN"
  tmp=$(mktemp -d "$(dirname "$T8_HOME")/.t8-install.XXXXXX")
  trap 'rm -rf "$tmp" "$tmp.old"' EXIT

  ensure_bun
  log "using Bun $(bun --version) at $(command -v bun)"

  log "downloading $T8_REPO@$T8_REF"
  curl -fsSL "https://github.com/$T8_REPO/archive/$T8_REF.tar.gz" |
    tar -xzf - -C "$tmp" --strip-components=1
  [ -f "$tmp/src/main.tsx" ] || die "the download does not contain t8"

  log "installing dependencies"
  (cd "$tmp" && bun install --frozen-lockfile --omit=dev --omit=peer --no-progress </dev/null)

  # Bun resolves bunfig.toml preloads against the working directory, so the
  # launcher uses its own config with the preload's absolute path.
  local preload
  preload=$(cd "$tmp" && bun --print 'Bun.resolveSync("@opentui/solid/preload", process.cwd())')
  preload="$T8_HOME${preload#"$tmp"}"
  printf 'preload = ["%s"]\n' "$preload" >"$tmp/launcher.bunfig.toml"

  if [ -d "$T8_HOME" ]; then
    mv "$T8_HOME" "$tmp.old"
  fi
  mv "$tmp" "$T8_HOME"
  [ -f "$preload" ] || die "preload script missing after install: $preload"

  # Prefer the bun on PATH at run time; fall back to the one found now.
  local bun_now
  bun_now=$(command -v bun)
  cat >"$T8_BIN/t8" <<LAUNCHER
#!/bin/sh
# t8 launcher, written by install.sh; re-run the installer to update.
T8_HOME="$T8_HOME"
if command -v bun >/dev/null 2>&1; then bun=bun; else bun="$bun_now"; fi
exec "\$bun" --config="\$T8_HOME/launcher.bunfig.toml" --no-install "\$T8_HOME/src/main.tsx" "\$@"
LAUNCHER
  chmod +x "$T8_BIN/t8"

  "$T8_BIN/t8" --help </dev/null | grep -q '^Usage:' || die "the installed t8 does not start"

  log "installed t8 to $T8_BIN/t8 (sources in $T8_HOME)"
  case ":$PATH:" in
    *":$T8_BIN:"*) ;;
    *)
      log "$T8_BIN is not on your PATH; add this to your shell profile:"
      log "  export PATH=\"$T8_BIN:\$PATH\""
      ;;
  esac
  log "next: t8 connect '<pairing link>', then t8"
}

main "$@"
