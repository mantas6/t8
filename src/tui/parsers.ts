/**
 * Tree-sitter grammars for fenced code blocks beyond the ones OpenTUI bundles
 * (JavaScript, TypeScript, JSX/TSX, Markdown, Zig). Everything is loaded from
 * local files: the grammar npm packages (pinned in package.json, they ship the
 * `.wasm` and `queries/`) and `vendor/grammars/` for the grammars without an
 * npm build (see the `VENDORED.md` files there). Nothing is downloaded.
 *
 * `<markdown>` maps a fence's info string to a filetype with OpenTUI's
 * `infoStringToFiletype` (`sh`/`zsh` -> bash, `py` -> python, `yml` -> yaml,
 * `patch` -> diff, ...); the aliases below cover the rest. A fence in any other
 * language renders as a plain code block.
 */
import { join } from "node:path";
import { addDefaultParsers, type FiletypeParserOptions } from "@opentui/core";

const VENDOR = join(import.meta.dir, "../../vendor/grammars");

/** Absolute path of a file inside an installed npm package. */
function pkg(path: string): string {
  return Bun.resolveSync(path, import.meta.dir);
}

type Meta = Pick<FiletypeParserOptions, "filetype" | "aliases" | "injectionMapping">;

/**
 * A grammar npm package that ships `<wasm>` and `queries/highlights.scm`;
 * `injections` is a query file of ours, if any.
 */
function fromPackage(name: string, wasm: string, meta: Meta, injections?: string) {
  return {
    ...meta,
    wasm: pkg(`${name}/${wasm}`),
    queries: {
      highlights: [pkg(`${name}/queries/highlights.scm`)],
      ...(injections === undefined ? {} : { injections: [injections] }),
    },
  } satisfies FiletypeParserOptions;
}

/** A grammar in `vendor/grammars/<dir>/`, optionally with `injections.scm`. */
function vendored(dir: string, meta: Meta, injections = false) {
  return {
    ...meta,
    wasm: join(VENDOR, dir, `tree-sitter-${dir}.wasm`),
    queries: {
      highlights: [join(VENDOR, dir, "highlights.scm")],
      ...(injections ? { injections: [join(VENDOR, dir, "injections.scm")] } : {}),
    },
  } satisfies FiletypeParserOptions;
}

export function extraParsers(): FiletypeParserOptions[] {
  return [
    fromPackage("tree-sitter-bash", "tree-sitter-bash.wasm", {
      filetype: "bash",
      aliases: ["sh", "shell", "zsh"],
    }),
    // php_only: plain PHP, with or without the `<?php` tag (the full `php`
    // grammar treats code before `<?php` as HTML text).
    fromPackage("tree-sitter-php", "tree-sitter-php_only.wasm", { filetype: "php" }),
    fromPackage("tree-sitter-go", "tree-sitter-go.wasm", { filetype: "go", aliases: ["golang"] }),
    fromPackage("tree-sitter-python", "tree-sitter-python.wasm", {
      filetype: "python",
      aliases: ["py"],
    }),
    fromPackage("tree-sitter-json", "tree-sitter-json.wasm", {
      filetype: "json",
      aliases: ["jsonc"],
    }),
    fromPackage("@tree-sitter-grammars/tree-sitter-yaml", "tree-sitter-yaml.wasm", {
      filetype: "yaml",
      aliases: ["yml"],
    }),
    fromPackage("@tree-sitter-grammars/tree-sitter-toml", "tree-sitter-toml.wasm", {
      filetype: "toml",
    }),
    fromPackage("tree-sitter-css", "tree-sitter-css.wasm", { filetype: "css" }),
    // OpenTUI picks an injected language by node type, so <script> only.
    fromPackage(
      "tree-sitter-html",
      "tree-sitter-html.wasm",
      {
        filetype: "html",
        aliases: ["htm", "xhtml"],
        injectionMapping: { nodeTypes: { raw_text: "javascript" } },
      },
      join(VENDOR, "html", "injections.scm"),
    ),
    // Indented strings of build phases and shell-script helpers are bash.
    vendored(
      "nix",
      { filetype: "nix", injectionMapping: { nodeTypes: { string_fragment: "bash" } } },
      true,
    ),
    vendored("sql", { filetype: "sql", aliases: ["postgresql", "postgres", "mysql", "sqlite"] }),
    vendored("diff", { filetype: "diff", aliases: ["patch", "udiff"] }),
  ];
}

let registered = false;

/** Registers the grammars with OpenTUI; call before the first render. */
export function registerParsers(): void {
  if (registered) return;
  registered = true;
  addDefaultParsers(extraParsers());
}
