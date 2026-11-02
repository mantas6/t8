{
  description = "t3tui - terminal UI client for the T3 Code server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs, ... }:
    let
      # Systems with a dev shell.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      # Systems the package is built and tested on. The deps hash is the same
      # everywhere, so adding one here (and to meta.platforms) should be enough.
      packageSystems = [ "x86_64-linux" ];

      forSystems = list: f: nixpkgs.lib.genAttrs list (system: f nixpkgs.legacyPackages.${system});
      forAllSystems = forSystems systems;
      forPackageSystems = forSystems packageSystems;
    in
    {
      packages = forPackageSystems (pkgs: rec {
        t3tui = pkgs.callPackage ./nix/package.nix { };
        default = t3tui;
      });

      apps = forPackageSystems (pkgs: rec {
        t3tui = {
          type = "app";
          program = pkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.t3tui;
          meta.description = "Terminal UI client for the T3 Code server";
        };
        default = t3tui;
      });

      checks = forPackageSystems (pkgs: {
        t3tui = self.packages.${pkgs.stdenv.hostPlatform.system}.t3tui;

        formatting = pkgs.runCommand "t3tui-nix-formatting" { nativeBuildInputs = [ pkgs.nixfmt ]; } ''
          nixfmt --check ${./flake.nix} ${./nix}/*.nix
          touch $out
        '';
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.bun ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
