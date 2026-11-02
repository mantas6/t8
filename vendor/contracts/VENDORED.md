# Vendored: `@t3tools/contracts`

The wire contract (schemas, RPC groups, HTTP API definitions) of the T3 Code
server. Upstream publishes it only as a private workspace package, so it is
copied here verbatim and exposed to this project as `@t3tools/contracts`
(plus the `/settings` and `/relay` subpaths) via the workspace package in this
directory and `paths` in the root `tsconfig.json`.

| Field    | Value                                                     |
| -------- | --------------------------------------------------------- |
| Upstream | https://github.com/pingdotgg/t3code                       |
| Path     | `packages/contracts/src`                                  |
| Tag      | `v0.1.2`                                                  |
| Commit   | `044f07257c9684ae4543bd1e1ebf9c394e9e3830`                |
| Vendored | 2026-11-02                                                |
| License  | MIT, Copyright (c) 2026 T3 Tools Inc. (see `LICENSE`)     |
| Runtime  | `effect` 4.0.5 (must match the root `package.json` exactly) |

## Local changes

None. Files are byte-identical to upstream except that `*.test.ts` files are
excluded (they depend on upstream test tooling). `package.json` in this
directory is written by hand: same `exports` as upstream, no scripts or dev
dependencies, version bumped to match the tag.

## Refreshing

From the repository root, with `TAG` set to the server version you target:

```sh
TAG=v0.1.2
SRC="$(mktemp -d)"
git clone --depth 1 --branch "$TAG" https://github.com/pingdotgg/t3code.git "$SRC"
git -C "$SRC" rev-parse HEAD   # record this commit above
rsync -a --delete --exclude='*.test.ts' "$SRC/packages/contracts/src/" vendor/contracts/src/
cp "$SRC/LICENSE" vendor/contracts/LICENSE
grep -E '^\s+effect:' "$SRC/pnpm-workspace.yaml"   # pin this exact version in both package.json files
```

Then update the table above, align the `effect` version in the root and
vendored `package.json`, run `bun install`, `bun run typecheck` and
`bun run probe` against a server of the new version.
