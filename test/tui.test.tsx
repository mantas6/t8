import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { OrchestrationV2ThreadStreamItem, type ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { createShellStore, createThreadStore } from "../src/state/store.ts";
import type { DisplayItem, ProjectGroup } from "../src/state/types.ts";
import { App, NO_THREAD_PLACEHOLDER } from "../src/tui/App.tsx";
import type { Backend } from "../src/tui/backend.ts";
import { copyToClipboard, osc52Sequence } from "../src/tui/clipboard.ts";
import { findItem, findMatch, isMessage, itemText, oneLine, stepThread } from "../src/tui/nav.ts";

const decode = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));
const fixture = readFileSync(join(import.meta.dir, "fixtures/thread-lifecycle.ndjson"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => decode(JSON.parse(line)));
const first = fixture[0];
if (first?.kind !== "snapshot") throw new Error("fixture must start with a snapshot");
const THREAD_ID = first.projection.thread.id;

function fakeBackend() {
  const shell = createShellStore();
  const thread = createThreadStore();
  const calls = {
    opened: [] as string[],
    sent: [] as Array<{ text: string; intent: string }>,
    interrupts: 0,
  };
  const backend: Backend = {
    shell,
    thread,
    openThread: (threadId) => {
      calls.opened.push(threadId);
      thread.reset(threadId);
      if (threadId === THREAD_ID) for (const item of fixture) thread.apply(item);
    },
    send: async (_threadId, text, intent) => {
      calls.sent.push({ text, intent });
    },
    interrupt: async () => {
      calls.interrupts += 1;
    },
    respond: async () => {},
    fetchToolResult: async () => null,
    reconnectNow: () => {},
  };
  const dispose = () => {
    shell.dispose();
    thread.dispose();
  };
  return { backend, calls, dispose };
}

let cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

async function mount(threadId: ThreadId | null) {
  const fake = fakeBackend();
  let quits = 0;
  const setup = await testRender(
    () => <App backend={fake.backend} initialThreadId={threadId} onQuit={() => (quits += 1)} />,
    { width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false },
  );
  cleanup.push(fake.dispose, () => setup.dispose());
  const frame = async () => {
    await setup.renderOnce();
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  return { ...setup, ...fake, frame, quits: () => quits };
}

describe("App", () => {
  test("shows the placeholder when no thread is open", async () => {
    const app = await mount(null);
    const frame = await app.frame();
    expect(frame).toContain(NO_THREAD_PLACEHOLDER);
    expect(frame).toContain("NORMAL");
  });

  test("renders a thread transcript", async () => {
    const app = await mount(THREAD_ID);
    expect(app.calls.opened).toEqual([THREAD_ID]);
    const frame = await app.frame();
    expect(frame).toContain("Reply with the single word OK.");
    expect(frame).toContain("t3tui smoke test");
    expect(frame).not.toContain(NO_THREAD_PLACEHOLDER);
  });

  test("modes, the command line and help", async () => {
    const app = await mount(THREAD_ID);
    await app.frame();

    app.mockInput.pressKey("?");
    expect(await app.frame()).toContain("Esc close");
    app.mockInput.pressEscape();
    expect(await app.frame()).not.toContain("Esc close");

    app.mockInput.pressKey(":");
    expect(await app.frame()).toContain("COMMAND");
    await app.mockInput.typeText("frob");
    app.mockInput.pressEnter();
    const afterCommand = await app.frame();
    expect(afterCommand).toContain("unknown command: frob");
    expect(afterCommand).toContain("NORMAL");

    app.mockInput.pressKey("i");
    expect(await app.frame()).toContain("INSERT");
    await app.mockInput.typeText("hello there");
    app.mockInput.pressEnter();
    await app.frame();
    expect(app.calls.sent).toEqual([{ text: "hello there", intent: "auto" }]);

    app.mockInput.pressEscape();
    expect(await app.frame()).toContain("NORMAL");
  });

  test("Ctrl-D scrolls, Ctrl-C twice quits", async () => {
    const app = await mount(THREAD_ID);
    await app.frame();
    app.mockInput.pressKey("d", { ctrl: true });
    app.mockInput.pressKey("d", { ctrl: true });
    await app.frame();
    expect(app.quits()).toBe(0);
    app.mockInput.pressCtrlC();
    expect(await app.frame()).toContain("Ctrl-C again to quit");
    expect(app.quits()).toBe(0);
    app.mockInput.pressCtrlC();
    expect(app.quits()).toBe(1);
  });

  test(":q quits", async () => {
    const app = await mount(null);
    await app.frame();
    app.mockInput.pressKey(":");
    await app.frame();
    await app.mockInput.typeText("q");
    app.mockInput.pressEnter();
    await app.frame();
    expect(app.quits()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers

const base = {
  runId: null,
  status: "completed",
  origin: "local",
  hidden: false,
  title: null,
  startedAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

const items: ReadonlyArray<DisplayItem> = [
  {
    ...base,
    id: "u1",
    kind: "user_message",
    messageId: "m1",
    text: "List files",
    attachmentCount: 0,
    inputIntent: "turn_start",
  },
  {
    ...base,
    id: "t1",
    kind: "tool_call",
    tool: "command",
    name: "Bash",
    args: "ls -la",
    result: "README.md",
    resultOmitted: false,
    failed: false,
    exitCode: 0,
    files: [],
    collapsedByDefault: true,
  },
  {
    ...base,
    id: "a1",
    kind: "assistant_message",
    messageId: "m2",
    text: "There is a README.",
    streaming: false,
  },
];

describe("nav", () => {
  test("findItem walks in both directions", () => {
    expect(findItem(items, -1, 1, isMessage)).toBe(0);
    expect(findItem(items, 0, 1, isMessage)).toBe(2);
    expect(findItem(items, 2, 1, isMessage)).toBe(-1);
    expect(findItem(items, items.length, -1, isMessage)).toBe(2);
  });

  test("findMatch is smartcase and wraps", () => {
    expect(findMatch(items, "readme", -1, 1)).toBe(1);
    expect(findMatch(items, "readme", 1, 1)).toBe(2);
    expect(findMatch(items, "readme", 2, 1)).toBe(1);
    expect(findMatch(items, "README.", -1, 1)).toBe(1);
    expect(findMatch(items, "Readme", -1, 1)).toBe(-1);
    expect(findMatch(items, "bash", -1, 1)).toBe(1);
  });

  test("itemText", () => {
    expect(itemText(items[1] as DisplayItem)).toBe("ls -la\n\nREADME.md");
    expect(itemText(items[2] as DisplayItem)).toBe("There is a README.");
  });

  test("stepThread cycles within the project", () => {
    const thread = (id: string) => ({ id }) as ProjectGroup["threads"][number];
    const groups = [
      { threads: [thread("a"), thread("b"), thread("c")] },
      { threads: [thread("x")] },
    ] as unknown as ReadonlyArray<ProjectGroup>;
    expect(stepThread(groups, "a", 1)).toBe("b");
    expect(stepThread(groups, "a", -1)).toBe("c");
    expect(stepThread(groups, "c", 1)).toBe("a");
    expect(stepThread(groups, "x", 1)).toBeNull();
    expect(stepThread(groups, null, 1)).toBeNull();
  });

  test("oneLine", () => {
    expect(oneLine("\n  first line \nsecond")).toBe("first line");
    expect(oneLine("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("clipboard", () => {
  test("OSC 52 sequence", () => {
    expect(osc52Sequence("hi", {})).toBe("\x1b]52;c;aGk=\x07");
    expect(osc52Sequence("hi", { TMUX: "1" })).toBe("\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\");
  });

  test("falls back to writing the sequence when the renderer refuses", () => {
    const written: string[] = [];
    const ok = copyToClipboard("hi", { copyToClipboardOSC52: () => false }, (data) => {
      written.push(data);
      return true;
    });
    expect(ok).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("aGk=");
  });

  test("uses the renderer when it accepts", () => {
    const written: string[] = [];
    const copied: string[] = [];
    copyToClipboard(
      "a\0b",
      {
        copyToClipboardOSC52: (text) => {
          copied.push(text);
          return true;
        },
      },
      (data) => written.push(data) > 0,
    );
    expect(copied).toEqual(["ab"]);
    expect(written).toEqual([]);
  });
});
