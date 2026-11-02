# tree-sitter-nix

- Source: https://github.com/nix-community/tree-sitter-nix, tag `v0.3.0`
  (commit `ea1d87f7996be1329ef6555dcacfa63a69bd55c6`)
- License: MIT (`LICENSE`, copied from the tag)
- `tree-sitter-nix.wasm`: built from the tag's sources (there is no published
  Wasm build or npm package with one) with tree-sitter CLI 0.26.11 from
  nixpkgs: `tree-sitter build --wasm -o tree-sitter-nix.wasm <checkout>`
  (the CLI downloads wasi-sdk 29 for this). Language ABI 13.
  sha256 `8b957d1ff521edda5606a5b6008e58489acbb1b3a7cf7ee2d16b7f0016a3d56a`
- `highlights.scm`: `queries/highlights.scm` from the tag, unchanged.
- `injections.scm`: `queries/injections.scm` from the tag without its first
  pattern (see the comment at the top of the file).
