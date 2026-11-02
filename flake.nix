{
  description = "t8 - terminal UI client for the T3 Code server";

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
        t8 = pkgs.callPackage ./nix/package.nix { };
        default = t8;
      });

      apps = forPackageSystems (pkgs: rec {
        t8 = {
          type = "app";
          program = pkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.t8;
          meta.description = "Terminal UI client for the T3 Code server";
        };
        default = t8;
      });

      checks = forPackageSystems (pkgs: {
        t8 = self.packages.${pkgs.stdenv.hostPlatform.system}.t8;

        formatting = pkgs.runCommand "t8-nix-formatting" { nativeBuildInputs = [ pkgs.nixfmt ]; } ''
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
