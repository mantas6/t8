/**
 * The `:` command line parser. A stub for now: quitting, approving and
 * denying. Unknown commands are reported back to the user.
 */

export type Command =
  | { readonly type: "noop" }
  | { readonly type: "quit" }
  | { readonly type: "write" }
  | { readonly type: "approve" }
  | { readonly type: "deny" }
  | { readonly type: "unknown"; readonly name: string };

const COMMANDS: Readonly<Record<string, Command["type"]>> = {
  q: "quit",
  quit: "quit",
  "q!": "quit",
  qa: "quit",
  "qa!": "quit",
  qall: "quit",
  quitall: "quit",
  wq: "quit",
  x: "quit",
  w: "write",
  write: "write",
  a: "approve",
  approve: "approve",
  d: "deny",
  deny: "deny",
};

export function parseCommandLine(input: string): Command {
  const text = input.trim().replace(/^:+/, "").trim();
  if (text === "") return { type: "noop" };
  const name = text.split(/\s+/, 1)[0] ?? "";
  const type = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (type === undefined || type === "unknown" || type === "noop") return { type: "unknown", name };
  return { type } as Command;
}

/** What `:w` says: there is nothing to save. */
export const WRITE_MESSAGE = "Nothing to write: the server already saved everything. Try :q";
