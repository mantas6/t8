import { describe, expect, test } from "bun:test";

import {
  COMMAND_NAMES,
  Completer,
  completionCandidates,
  LineHistory,
  parseCommandLine,
  quitBlocker,
} from "../src/tui/cmdline.ts";

describe("parseCommandLine", () => {
  test("quit variants", () => {
    for (const input of ["q", ":q", "quit", " :q ", "wq", "x"]) {
      expect(parseCommandLine(input)).toEqual({ type: "quit", force: false });
    }
    for (const input of ["qa", ":qa!", "q!", "qall", "quitall"]) {
      expect(parseCommandLine(input)).toEqual({ type: "quit", force: true });
    }
  });

  test("write, approve, deny", () => {
    expect(parseCommandLine("w")).toEqual({ type: "write" });
    expect(parseCommandLine("a")).toEqual({ type: "approve" });
    expect(parseCommandLine("approve")).toEqual({ type: "approve" });
    expect(parseCommandLine("d")).toEqual({ type: "deny" });
    expect(parseCommandLine("deny")).toEqual({ type: "deny" });
  });

  test("pickers and thread commands", () => {
    expect(parseCommandLine("t")).toEqual({ type: "threads", filter: "", layout: null });
    expect(parseCommandLine("r")).toEqual({ type: "threads", filter: "", layout: "flat" });
    expect(parseCommandLine("recent web")).toEqual({
      type: "threads",
      filter: "web",
      layout: "flat",
    });
    expect(parseCommandLine("threads t8")).toEqual({ type: "threads", filter: "t8", layout: null });
    expect(parseCommandLine("p")).toEqual({ type: "projects", name: "" });
    expect(parseCommandLine("projects  my app ")).toEqual({ type: "projects", name: "my app" });
    expect(parseCommandLine("n")).toEqual({ type: "new", title: null });
    expect(parseCommandLine("new fix the build")).toEqual({ type: "new", title: "fix the build" });
    expect(parseCommandLine("m")).toEqual({ type: "model" });
    expect(parseCommandLine("model")).toEqual({ type: "model" });
    expect(parseCommandLine("mode")).toEqual({ type: "mode" });
    expect(parseCommandLine("queue")).toEqual({ type: "queue" });
    expect(parseCommandLine("h")).toEqual({ type: "help" });
    expect(parseCommandLine("help")).toEqual({ type: "help" });
    expect(parseCommandLine("archive")).toEqual({ type: "archive" });
    expect(parseCommandLine("reconnect")).toEqual({ type: "reconnect" });
    expect(parseCommandLine("bn")).toEqual({ type: "threadNext" });
    expect(parseCommandLine("bp")).toEqual({ type: "threadPrev" });
  });

  test(":b takes an index or a title", () => {
    expect(parseCommandLine("b 3")).toEqual({ type: "thread", target: 3 });
    expect(parseCommandLine("thread 12")).toEqual({ type: "thread", target: 12 });
    expect(parseCommandLine("b smoke test")).toEqual({ type: "thread", target: "smoke test" });
    expect(parseCommandLine("b").type).toBe("usage");
  });

  test("empty, unknown, stray arguments", () => {
    expect(parseCommandLine("")).toEqual({ type: "noop" });
    expect(parseCommandLine(":")).toEqual({ type: "noop" });
    expect(parseCommandLine("frobnicate now")).toEqual({ type: "unknown", name: "frobnicate" });
    expect(parseCommandLine("toString")).toEqual({ type: "unknown", name: "toString" });
    expect(parseCommandLine("q now")).toEqual({ type: "usage", message: ":q takes no argument" });
  });
});

describe("quitBlocker", () => {
  test(":q refuses while a run is active; :qa does not", () => {
    expect(quitBlocker(false, false)).toBeNull();
    expect(quitBlocker(false, true)).toContain(":qa");
    expect(quitBlocker(true, true)).toBeNull();
  });
});

const sources = {
  threads: ["t3tui smoke test", "Fix the build", "t3tui step5 live test"],
  projects: ["t8", "website", "t3code"],
};

describe("completion", () => {
  test("command names, shortest first", () => {
    const set = completionCandidates("th", sources);
    expect(set.start).toBe(0);
    expect(set.candidates).toEqual(["thread", "threads"]);
    expect(completionCandidates(":qa", sources).candidates).toContain("qall");
    expect(completionCandidates("zz", sources).candidates).toEqual([]);
    expect(COMMAND_NAMES).toContain("reconnect");
  });

  test("thread titles and project names as arguments", () => {
    const threads = completionCandidates(":t t3", sources);
    expect(threads.start).toBe(3);
    expect(threads.candidates.slice(0, 2)).toEqual(["t3tui smoke test", "t3tui step5 live test"]);
    expect(completionCandidates("b fix", sources).candidates[0]).toBe("Fix the build");
    expect(completionCandidates("p web", sources).candidates).toEqual(["website"]);
    // Fuzzy, after the prefix matches.
    expect(completionCandidates("p tcd", sources).candidates).toEqual(["t3code"]);
    // Commands without an argument complete nothing.
    expect(completionCandidates("q x", sources).candidates).toEqual([]);
  });

  test("Completer: unique, common prefix, then cycling", () => {
    const completer = new Completer();
    expect(completer.complete("reco", sources)?.text).toBe("reconnect");
    // A command taking an argument gets a trailing space.
    expect(completer.complete("proj", sources)?.text).toBe("projects ");

    // No longer common prefix: cycling starts with the first candidate.
    completer.reset();
    const a = completer.complete(":p t", sources);
    expect(a?.text).toBe(":p t8");
    const b = completer.complete(a?.text ?? "", sources);
    expect(b?.text).toBe(":p t3code");
    // Prefix matches first, then fuzzy ones.
    const c = completer.complete(b?.text ?? "", sources);
    expect(c?.text).toBe(":p website");
    expect(completer.complete(c?.text ?? "", sources)?.text).toBe(":p t8");

    // Common prefix first.
    completer.reset();
    const prefix = completer.complete(":t t3t", sources);
    expect(prefix?.text).toBe(":t t3tui s");
    expect(prefix?.index).toBe(-1);
    const cycled = completer.complete(prefix?.text ?? "", sources);
    expect(cycled?.text).toBe(":t t3tui smoke test");
    // Typing something else starts over.
    expect(completer.complete("wri", sources)?.text).toBe("write");
  });
});

describe("LineHistory", () => {
  test("Up / Down browse, keeping the draft", () => {
    const history = new LineHistory();
    history.push("t");
    history.push("t");
    history.push("mode");
    history.push("  ");
    history.reset();
    expect(history.older("dra")).toBe("mode");
    expect(history.older("ignored")).toBe("t");
    expect(history.older("x")).toBeNull();
    expect(history.newer()).toBe("mode");
    expect(history.newer()).toBe("dra");
    expect(history.newer()).toBeNull();
  });
});
