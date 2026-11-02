import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import {
  OrchestrationV2ThreadStreamItem,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { createShellStore, createThreadStore } from "../src/state/store.ts";
import type { DisplayItem, ProjectGroup } from "../src/state/types.ts";
import { App, NO_THREAD_PLACEHOLDER } from "../src/tui/App.tsx";
import type { Backend, ModelCatalog, NewThread } from "../src/tui/backend.ts";
import { copyToClipboard, osc52Sequence } from "../src/tui/clipboard.ts";
import { findItem, findMatch, isMessage, itemText, oneLine, stepThread } from "../src/tui/nav.ts";
import { projectShell, shellSnapshot, threadShell } from "./fixtures/shell.ts";

const decode = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));
const fixture = readFileSync(join(import.meta.dir, "fixtures/thread-lifecycle.ndjson"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => decode(JSON.parse(line)));
const first = fixture[0];
if (first?.kind !== "snapshot") throw new Error("fixture must start with a snapshot");
const THREAD_ID = first.projection.thread.id;

const PROJECT_ID = first.projection.thread.projectId;

const SHELL = shellSnapshot(
  [projectShell(PROJECT_ID, "t8"), projectShell("project-web", "website")],
  [
    threadShell(THREAD_ID, PROJECT_ID, {
      title: "t3tui smoke test",
      latestUserMessageAt: "2026-11-02T07:00:00.000Z",
    }),
    threadShell("thread-build", PROJECT_ID, { title: "Fix the build", status: "running" }),
    threadShell("thread-landing", "project-web", { title: "Landing page copy" }),
  ],
);

const CATALOG: ModelCatalog = {
  providers: [
    {
      instanceId: "claudeAgent" as ProviderInstanceId,
      name: "Claude",
      models: [
        { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5", isDefault: false },
        { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isDefault: true },
      ],
      supportedRuntimeModes: null,
    },
  ],
  defaultModelSelection: null,
  defaultRuntimeMode: "full-access",
};

function fakeBackend() {
  const shell = createShellStore();
  const thread = createThreadStore();
  shell.apply(SHELL);
  const calls = {
    opened: [] as string[],
    sent: [] as Array<{ text: string; intent: string }>,
    interrupts: 0,
    created: [] as NewThread[],
    models: [] as string[],
    modes: [] as string[],
    archived: [] as string[],
    reconnects: 0,
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
    modelCatalog: async () => CATALOG,
    createThread: async (input) => {
      calls.created.push(input);
      return "thread-new" as ThreadId;
    },
    setModel: async (_threadId, selection) => {
      calls.models.push(`${selection.instanceId}/${selection.model}`);
    },
    setRuntimeMode: async (_threadId, mode) => {
      calls.modes.push(mode);
    },
    archive: async (threadId) => {
      calls.archived.push(threadId);
    },
    archivedThreads: async () => [],
    cancelQueued: async () => {},
    reorderQueued: async () => {},
    reconnectNow: () => {},
    reconnect: () => {
      calls.reconnects += 1;
    },
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
    await command(app, "q");
    expect(app.quits()).toBe(1);
  });

  test(":q refuses while a run is active, :qa quits", async () => {
    const app = await mount(null);
    await app.frame();
    // Replay the fixture up to the middle of its run.
    app.backend.thread.reset(THREAD_ID);
    for (const item of fixture.slice(0, 20)) app.backend.thread.apply(item);
    expect(app.backend.thread.activeRun()).not.toBeNull();
    const frame = await command(app, "q");
    expect(app.quits()).toBe(0);
    expect(frame).toContain("a run is active");
    await command(app, "qa");
    expect(app.quits()).toBe(1);
  });

  test(":t lists threads with indices and glyphs; filter, move, Enter opens", async () => {
    const app = await mount(null);
    await app.frame();
    const picker = await command(app, "t");
    expect(picker).toContain("Threads");
    expect(picker).toContain("PICKER");
    expect(picker).toMatch(/1 · t3tui smoke test/);
    expect(picker).toMatch(/2 ● Fix the build/);
    expect(picker).toMatch(/3 · Landing page copy/);
    expect(picker).toContain("website");
    expect(picker).toContain("Enter open");

    // j/k move while the filter is empty; Enter opens the thread under the cursor.
    app.mockInput.pressKey("j");
    app.mockInput.pressEnter();
    await app.frame();
    expect(app.calls.opened).toEqual(["thread-build"]);

    await command(app, "t");
    await app.mockInput.typeText("landing");
    const filtered = await app.frame();
    expect(filtered).toContain("Landing page copy");
    expect(filtered).not.toMatch(/2 ● Fix the build/);
    app.mockInput.pressEnter();
    await app.frame();
    expect(app.calls.opened).toEqual(["thread-build", "thread-landing"]);

    // Esc clears the filter first, then closes.
    await command(app, "t");
    await app.mockInput.typeText("zzz");
    expect(await app.frame()).toContain("no matching threads");
    app.mockInput.pressEscape();
    expect(await app.frame()).toContain("Fix the build");
    app.mockInput.pressEscape();
    expect(await app.frame()).not.toContain("Threads");
  });

  test("a held-back d becomes filter text; dd archives after a confirm", async () => {
    const app = await mount(null);
    await app.frame();
    await command(app, "t");
    await app.mockInput.typeText("de");
    // "de" was typing, not a dd: the filter has it and narrows the list.
    const typed = await app.frame();
    expect(typed).toContain("> de");

    app.mockInput.pressEscape();
    await app.frame();
    app.mockInput.pressKey("j");
    app.mockInput.pressKey("d");
    app.mockInput.pressKey("d");
    expect(await app.frame()).toContain('archive "Fix the build"?');
    app.mockInput.pressKey("n");
    await app.frame();
    expect(app.calls.archived).toEqual([]);
    app.mockInput.pressKey("d");
    app.mockInput.pressKey("d");
    await app.frame();
    app.mockInput.pressKey("y");
    await app.frame();
    expect(app.calls.archived).toEqual(["thread-build"]);
  });

  test(":b <n>, :bn, Tab completion and history", async () => {
    const app = await mount(null);
    await app.frame();
    await command(app, "b 3");
    expect(app.calls.opened).toEqual(["thread-landing"]);
    await command(app, "b 9");
    await command(app, "b fix");
    expect(app.calls.opened).toEqual(["thread-landing", "thread-build"]);
    await command(app, "bn");
    expect(app.calls.opened.at(-1)).toBe(THREAD_ID);

    app.mockInput.pressKey(":");
    await app.frame();
    await app.mockInput.typeText("reco");
    app.mockInput.pressTab();
    expect(await app.frame()).toContain(":reconnect");
    app.mockInput.pressEnter();
    await app.frame();
    expect(app.calls.reconnects).toBe(1);

    app.mockInput.pressKey(":");
    await app.frame();
    app.mockInput.pressArrow("up");
    expect(await app.frame()).toContain(":reconnect");
    app.mockInput.pressArrow("up");
    expect(await app.frame()).toContain(":bn");
    app.mockInput.pressEscape();
    await app.frame();
  });

  test(":n picks a project, asks for a title, creates and opens in INSERT", async () => {
    const app = await mount(null);
    await app.frame();
    const projects = await command(app, "n");
    expect(projects).toContain("New thread · project");
    await app.mockInput.typeText("t8");
    app.mockInput.pressEnter();
    expect(await app.frame()).toContain("title for a new thread in t8");
    await app.mockInput.typeText("my new thread");
    app.mockInput.pressEnter();
    await app.frame();
    await app.frame();
    expect(app.calls.created).toHaveLength(1);
    const created = app.calls.created[0];
    expect(created?.title).toBe("my new thread");
    expect(created?.projectId).toBe(PROJECT_ID);
    // The project's newest thread's model, and the server's default mode.
    expect(created?.modelSelection.model).toBe("claude-haiku-5-5");
    expect(created?.runtimeMode).toBe("full-access");
    expect(app.calls.opened).toEqual(["thread-new"]);
    expect(await app.frame()).toContain("INSERT");
  });

  test(":m and :mode set the open thread's model and runtime mode", async () => {
    const app = await mount(THREAD_ID);
    await app.frame();
    const models = await command(app, "m");
    await app.frame();
    expect(await app.frame()).toContain("Claude Opus 5.5");
    expect(models).toContain("Model");
    await app.mockInput.typeText("opus");
    app.mockInput.pressEnter();
    await app.frame();
    await app.frame();
    expect(app.calls.models).toEqual(["claudeAgent/claude-opus-5-5"]);

    const modes = await command(app, "mode");
    expect(modes).toContain("approval-required");
    expect(modes).toContain("full-access");
    app.mockInput.pressKey("k");
    app.mockInput.pressKey("k");
    app.mockInput.pressKey("k");
    app.mockInput.pressEnter();
    await app.frame();
    await app.frame();
    expect(app.calls.modes).toEqual(["approval-required"]);
  });

  test(":archive asks first", async () => {
    const app = await mount(THREAD_ID);
    await app.frame();
    expect(await command(app, "archive")).toContain('archive "t3tui smoke test"?');
    app.mockInput.pressKey("y");
    await app.frame();
    expect(app.calls.archived).toEqual([THREAD_ID]);
  });
});

async function command(app: Awaited<ReturnType<typeof mount>>, text: string) {
  app.mockInput.pressKey(":");
  await app.frame();
  await app.mockInput.typeText(text);
  app.mockInput.pressEnter();
  return app.frame();
}

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
