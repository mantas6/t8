# t8: runs the TypeScript/JSX sources directly with Bun (no bundling).
#
# Dependencies come from a fixed-output derivation (`node_modules`) that runs
# `bun install --frozen-lockfile` for the runtime dependencies. It installs the
# optional native packages of every platform (`--os=* --cpu=*`), so its hash is
# the same on all systems; the final package keeps only the host's OpenTUI
# native library.
#
# After changing `bun.lock` (or a workspace `package.json`), update
# `nix/deps-hash.txt`; see "Install with Nix" in the README.
{
  lib,
  stdenvNoCC,
  bun,
  makeBinaryWrapper,
  writableTmpDirAsHomeHook,
}:

let
  root = ../.;
  fs = lib.fileset;

  packageJson = lib.importJSON (root + "/package.json");
  pname = packageJson.name;
  inherit (packageJson) version;

  # Only what `bun install` reads, so source edits never touch the deps.
  depsFiles = [
    (root + "/package.json")
    (root + "/bun.lock")
    (root + "/vendor/contracts/package.json")
  ];
  depsSrc = fs.toSource {
    inherit root;
    fileset = fs.unions depsFiles;
  };
  # A fixed-output path depends only on its name and hash, so a stale hash
  # would silently reuse old deps. Putting a fingerprint of the inputs (and of
  # the Bun version) in the name makes any change to them rebuild, and fail
  # loudly if the hash is stale.
  depsFingerprint = builtins.substring 0 8 (
    builtins.hashString "sha256" (bun.version + lib.concatMapStrings builtins.readFile depsFiles)
  );

  src = fs.toSource {
    inherit root;
    fileset = fs.unions [
      (root + "/package.json")
      (root + "/bunfig.toml")
      (root + "/tsconfig.json")
      (root + "/src")
      (root + "/vendor")
    ];
  };

  node_modules = stdenvNoCC.mkDerivation {
    pname = "${pname}-node_modules";
    version = "${version}-${depsFingerprint}";
    src = depsSrc;

    nativeBuildInputs = [
      bun
      writableTmpDirAsHomeHook
    ];

    impureEnvVars = lib.fetchers.proxyImpureEnvVars;

    dontConfigure = true;

    buildPhase = ''
      runHook preBuild

      export BUN_INSTALL_CACHE_DIR=$(mktemp -d)
      # --omit=peer drops typescript (a types-only peer of bun-ffi-structs,
      # with a native binary per platform); --linker=hoisted gives a flat
      # node_modules so non-host native packages are easy to drop below.
      bun install \
        --frozen-lockfile \
        --omit=dev \
        --omit=peer \
        --linker=hoisted \
        --ignore-scripts \
        --no-progress \
        --os='*' \
        --cpu='*'

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out
      find . -type d -name node_modules -prune -exec cp -R --parents {} $out \;

      runHook postInstall
    '';

    # A fixed-output derivation must not reference store paths, and the
    # prebuilt native libraries must stay untouched.
    dontFixup = true;

    outputHash = lib.fileContents ./deps-hash.txt;
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };

  # The host's OpenTUI native package (glibc build on Linux).
  opentuiNative =
    let
      platform = stdenvNoCC.hostPlatform;
      os =
        if platform.isLinux then
          "linux"
        else if platform.isDarwin then
          "darwin"
        else
          throw "${pname}: unsupported OS ${platform.system}";
      cpu =
        if platform.isx86_64 then
          "x64"
        else if platform.isAarch64 then
          "arm64"
        else
          throw "${pname}: unsupported CPU ${platform.system}";
    in
    "core-${os}-${cpu}";
in
stdenvNoCC.mkDerivation {
  inherit pname version src;

  nativeBuildInputs = [
    bun
    makeBinaryWrapper
  ];

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    share=$out/share/${pname}
    mkdir -p $share
    cp -R package.json bunfig.toml tsconfig.json src vendor $share/
    cp -R ${node_modules}/. $share/
    chmod -R u+w $share

    # Keep only the host's OpenTUI native library.
    for dir in $share/node_modules/@opentui/core-*; do
      if [ "$(basename "$dir")" != "${opentuiNative}" ]; then
        rm -r "$dir"
      fi
    done
    test -e $share/node_modules/@opentui/${opentuiNative}/package.json

    # The tree-sitter grammar packages are only used for their .wasm files and
    # queries (see src/tui/parsers.ts); drop the C sources and Node bindings.
    for dir in $share/node_modules/tree-sitter-* $share/node_modules/@tree-sitter-grammars/*; do
      find "$dir" -mindepth 1 -maxdepth 1 \
        ! -name '*.wasm' ! -name queries ! -name package.json ! -name LICENSE \
        -exec rm -r {} +
    done

    # Bun resolves bunfig.toml preloads against the working directory, so
    # point the Solid JSX preload at its absolute path in the store.
    preload=$(cd $share && bun --print 'Bun.resolveSync("@opentui/solid/preload", process.cwd())')
    test -f "$preload"
    substituteInPlace $share/bunfig.toml \
      --replace-fail '"@opentui/solid/preload"' "\"$preload\""

    # Run the sources with that bunfig.toml from any working directory (the
    # user's own bunfig.toml is not loaded), without auto-install.
    makeWrapper ${lib.getExe bun} $out/bin/${pname} \
      --add-flags "--config=$share/bunfig.toml" \
      --add-flags "--no-install" \
      --add-flags "$share/src/main.tsx"

    runHook postInstall
  '';

  # Leave the prebuilt native library alone (no strip, no patchelf).
  dontFixup = true;

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck

    HOME=$(mktemp -d) $out/bin/${pname} --help | grep -q "Usage:"

    # Every grammar file the TUI registers is in the package.
    (cd $out/share/${pname} && HOME=$(mktemp -d) bun -e '
      const { existsSync } = await import("node:fs");
      const { extraParsers } = await import("./src/tui/parsers.ts");
      const files = extraParsers().flatMap((p) => [p.wasm, ...p.queries.highlights, ...(p.queries.injections ?? [])]);
      const missing = files.filter((file) => !existsSync(file));
      if (missing.length > 0) throw new Error(`missing grammar files: ''${missing.join(" ")}`);
    ')

    runHook postInstallCheck
  '';

  passthru = {
    inherit node_modules;
  };

  meta = {
    description = "Terminal UI client for the T3 Code server";
    mainProgram = pname;
    # Only tested here so far; `opentuiNative` above already maps the others.
    platforms = [ "x86_64-linux" ];
  };
}
