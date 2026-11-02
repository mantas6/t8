# tree-sitter-sql

- Source: https://github.com/DerekStride/tree-sitter-sql, tag `v0.3.11`
  (commit `7b51ecda191d36b92f5a90a8d1bc3faef1c7b8b8`)
- License: MIT (`LICENSE`, copied from the release)
- `tree-sitter-sql.wasm`: built from the release tarball
  `tree-sitter-sql-v0.3.11.tar.gz` (it has the generated `src/parser.c`; the
  npm package `@derekstride/tree-sitter-sql` ships no Wasm) with tree-sitter
  CLI 0.26.11 from nixpkgs: `tree-sitter build --wasm -o tree-sitter-sql.wasm
  <unpacked tarball>` (the CLI downloads wasi-sdk 29 for this). Language ABI 15.
  sha256 `72299c94f54c3510f80739977821e0072641d7ffcca0222ff0b6fa3efb648df1`
- `highlights.scm`: `queries/highlights.scm` from the release, unchanged.
