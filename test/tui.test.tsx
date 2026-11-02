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
import { createSignal } from "solid-js";

import { createShellStore, createThreadStore } from "../src/state/store.ts";
import type { DisplayItem, ProjectGroup } from "../src/state/types.ts";
import { App, NO_THREAD_PLACEHOLDER } from "../src/tui/App.tsx";
import type {
  Backend,
  ModelCatalog,
  NewThread,
  SendOptions,
  ServerView,
} from "../src/tui/backend.ts";
import { copyToClipboard, osc52Sequence } from "../src/tui/clipboard.ts";
import { findItem, findMatch, isMessage, itemText, oneLine, stepThread } from "../src/tui/nav.ts";
import { question, requestEvents } from "./fixtures/requests.ts";
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
      title: "t8 smoke test",
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
    switched: [] as string[],
    links: [] as string[],
    sendOptions: [] as SendOptions[],
    responses: [] as Array<{ requestId: string; response: unknown }>,
  };
  /** How many of the next sends / responses fail. */
  const failures = { send: 0, respond: 0 };
  const [server, setServer] = createSignal<ServerView>({
    profile: "home",
    label: "home",
    server: "http://localhost:3773/",
  });
  const profiles = [
    { name: "home", profile: { server: "http://localhost:3773/", label: "home" } },
    { name: "work", profile: { server: "https://work.example/", label: "build box" } },
  ].map((entry) => ({ ...entry, isDefault: entry.name === "home", expired: false }));
  const backend: Backend = {
    shell,
    thread,
    server,
    servers: async () => profiles,
    connectLink: async (link) => {
      calls.links.push(link);
      setServer({ profile: "lab", label: "lab", server: "http://lab:3773/" });
      return {
        name: "lab",
        created: true,
        isDefault: false,
        defaultName: "home",
        server: "http://lab:3773/",
        label: "lab",
        environmentId: "env-lab",
        tokenPath: "/tmp/lab.token",
        expiresAt: "2026-12-02T00:00:00.000Z",
        expiresInSeconds: 2_592_000,
        scope: "orchestration:read orchestration:operate",
        migrated: false,
      };
    },
    switchProfile: async (name) => {
      calls.switched.push(name);
      const entry = profiles.find((candidate) => candidate.name === name);
      setServer({
        profile: name,
        label: entry?.profile.label ?? null,
        server: entry?.profile.server ?? "",
      });
    },
    openThread: (threadId) => {
      calls.opened.push(threadId);
      thread.reset(threadId);
      if (threadId === THREAD_ID) for (const item of fixture) thread.apply(item);
    },
    send: async (_threadId, text, intent, options = {}) => {
      calls.sendOptions.push(options);
      if (failures.send > 0) {
        failures.send -= 1;
        throw new Error("not connected");
      }
      calls.sent.push({ text, intent });
    },
    interrupt: async () => {
      calls.interrupts += 1;
    },
    respond: async (_threadId, requestId, response) => {
      calls.responses.push({ requestId, response });
      if (failures.respond > 0) {
        failures.respond -= 1;
        throw new Error("response rejected");
      }
    },
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
  return { backend, calls, failures, dispose };
}

let cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

const ARM_MS = 40;

async function mount(threadId: ThreadId | null) {
  const fake = fakeBackend();
  let quits = 0;
  const setup = await testRender(
    () => (
      <App
        backend={fake.backend}
        initialThreadId={threadId}
        onQuit={() => (quits += 1)}
        requestArmMs={ARM_MS}
      />
    ),
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
    expect(frame).toContain("t8 smoke test");
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
    expect(picker).toMatch(/1 · t8 smoke test/);
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
    expect(await command(app, "archive")).toContain('archive "t8 smoke test"?');
    app.mockInput.pressKey("y");
    await app.frame();
    expect(app.calls.archived).toEqual([THREAD_ID]);
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("App: runtime requests", () => {
  test("a request arriving mid-sentence does not take the keyboard", async () => {
    const app = await mount(THREAD_ID);
    await app.frame();
    app.mockInput.pressKey("i");
    await app.mockInput.typeText("draft");
    await app.frame();
    const events = requestEvents();
    app.backend.thread.apply(events.approvalItem("req-1"));
    app.backend.thread.apply(events.request("req-1", "command"));
    const shown = await app.frame();
    expect(shown).toContain("Approval needed");
    expect(shown).toContain("INSERT");
    expect(shown).toContain("Esc, then Enter to answer");
    // y and n keep going into the draft.
    await app.mockInput.typeText(" yn");
    await sleep(ARM_MS * 2);
    await app.mockInput.typeText("y");
    const typed = await app.frame();
    expect(typed).toContain("draft yny");
    expect(app.calls.responses).toEqual([]);

    // Esc, Enter focuses the prompt; then y approves.
    app.mockInput.pressEscape();
    app.mockInput.pressEnter();
    await app.frame();
    app.mockInput.pressKey("y");
    await app.frame();
    expect(app.calls.responses).toEqual([{ requestId: "req-1", response: { decision: "accept" } }]);
  });

  test("keys are ignored until the prompt is armed, and a request is answered once", async () => {
    const app = await mount(THREAD_ID);
    await app.frame();
    const events = requestEvents();
    app.backend.thread.apply(events.approvalItem("req-1"));
    app.backend.thread.apply(events.request("req-1", "command"));
    await app.frame();
    app.mockInput.pressKey("y");
    expect(await app.frame()).toContain("just appeared or changed");
    expect(app.calls.responses).toEqual([]);

    await sleep(ARM_MS * 2);
    app.mockInput.pressKey("y");
    await app.frame();
    app.mockInput.pressKey("n");
    expect(await app.frame()).toContain("already answered");
    expect(app.calls.responses).toEqual([{ requestId: "req-1", response: { decision: "accept" } }]);
  });

  test("changed options re-arm the prompt; y without an approve option is refused", async () => {
    const app = await mount(THREAD_ID);
    await app.frame();
    const events = requestEvents();
    // The request lands before the turn item: the default options show.
    app.backend.thread.apply(events.request("req-2", "command"));
    expect(await app.frame()).toContain("Approve for this session");
    await sleep(ARM_MS * 2);
    // Its describing item arrives with options of its own, none accept-like.
    app.backend.thread.apply(
      events.approvalItem("req-2", [
        { decision: "decline", label: "Skip it" },
        { decision: "cancel", label: "Stop the run" },
      ]),
    );
    expect(await app.frame()).toContain("Skip it");
    app.mockInput.pressKey("1");
    expect(await app.frame()).toContain("just appeared or changed");
    await sleep(ARM_MS * 2);
    app.mockInput.pressKey("y");
    expect(await app.frame()).toContain("no approve option");
    expect(app.calls.responses).toEqual([]);
    await command(app, "a");
    expect(app.calls.responses).toEqual([]);
    app.mockInput.pressKey("2");
    await app.frame();
    expect(app.calls.responses).toEqual([{ requestId: "req-2", response: { decision: "cancel" } }]);
  });

  test("a free-text question is answered by typing", async () => {
    const app = await mount(THREAD_ID);
    await app.frame();
    const events = requestEvents();
    app.backend.thread.apply(events.userInputItem("req-3", [question("name", [])]));
    app.backend.thread.apply(events.request("req-3", "user_input"));
    expect(await app.frame()).toContain("Press i to type the answer");
    await sleep(ARM_MS * 2);
    app.mockInput.pressKey("i");
    expect(await app.frame()).toContain("INSERT");
    await app.mockInput.typeText("Ada");
    app.mockInput.pressEnter();
    await app.frame();
    expect(app.calls.responses).toEqual([
      { requestId: "req-3", response: { answers: { name: "Ada" } } },
    ]);
    expect(app.calls.sent).toEqual([]);
  });

  test("a custom answer next to options", async () => {
    const app = await mount(THREAD_ID);
    await app.frame();
    const events = requestEvents();
    app.backend.thread.apply(
      events.userInputItem("req-4", [
        question("color", ["red", "blue"], { allowCustomAnswer: true }),
      ]),
    );
    app.backend.thread.apply(events.request("req-4", "user_input"));
    expect(await app.frame()).toContain("type your own answer");
    await sleep(ARM_MS * 2);
    app.mockInput.pressKey("i");
    await app.mockInput.typeText("green");
    app.mockInput.pressEnter();
    await app.frame();
    expect(app.calls.responses).toEqual([
      { requestId: "req-4", response: { answers: { color: "green" } } },
    ]);
  });

  test("a request answered by message sends a normal message", async () => {
    const app = await mount(THREAD_ID);
    await app.frame();
    const events = requestEvents();
    app.backend.thread.apply(events.userInputItem("req-5", [question("plan", ["yes", "no"])]));
    app.backend.thread.apply(events.request("req-5", "user_input", "pending", "message"));
    expect(await app.frame()).toContain("answer with a normal message (i)");
    await sleep(ARM_MS * 2);
    app.mockInput.pressKey("i");
    await app.mockInput.typeText("go ahead");
    app.mockInput.pressEnter();
    await app.frame();
    expect(app.calls.sent).toEqual([{ text: "go ahead", intent: "auto" }]);
    expect(app.calls.responses).toEqual([]);
  });

  test("an approval still refuses INSERT", async () => {
    const app = await mount(THREAD_ID);
    await app.frame();
    const events = requestEvents();
    app.backend.thread.apply(events.approvalItem("req-6"));
    app.backend.thread.apply(events.request("req-6", "command"));
    await app.frame();
    app.mockInput.pressKey("i");
    const frame = await app.frame();
    expect(frame).toContain("answer the request first");
    expect(frame).not.toContain("INSERT");
  });

  test("a failed answer keeps the progress, so picking again retries", async () => {
    const app = await mount(THREAD_ID);
    await app.frame();
    const events = requestEvents();
    app.backend.thread.apply(
      events.userInputItem("req-7", [
        question("a", ["one", "two"]),
        question("b", ["three", "four"]),
      ]),
    );
    app.backend.thread.apply(events.request("req-7", "user_input"));
    await app.frame();
    await sleep(ARM_MS * 2);
    app.failures.respond = 1;
    app.mockInput.pressKey("2");
    expect(await app.frame()).toContain("Question b?");
    app.mockInput.pressKey("1");
    await app.frame();
    expect(await app.frame()).toContain("response failed");
    expect(await app.frame()).toContain("Question b?");
    app.mockInput.pressKey("1");
    await app.frame();
    expect(app.calls.responses.map((call) => call.response)).toEqual([
      { answers: { a: "two", b: "three" } },
      { answers: { a: "two", b: "three" } },
    ]);
  });
});

describe("App: sending", () => {
  test("a failed send keeps the draft; resending reuses its ids", async () => {
    const app = await mount(THREAD_ID);
    await app.frame();
    app.failures.send = 1;
    app.mockInput.pressKey("i");
    await app.mockInput.typeText("hello");
    app.mockInput.pressEnter();
    await app.frame();
    const failed = await app.frame();
    expect(failed).toContain("send failed");
    expect(failed).toContain("hello");
    expect(app.calls.sent).toEqual([]);

    app.mockInput.pressEnter();
    await app.frame();
    expect(app.calls.sent).toEqual([{ text: "hello", intent: "auto" }]);
    const [first, second] = app.calls.sendOptions;
    expect(first?.commandId).toBeDefined();
    expect(second?.commandId).toBe(first?.commandId);
    expect(second?.messageId).toBe(first?.messageId);
    expect(await app.frame()).not.toContain("hello");

    // A new draft gets new ids.
    await app.mockInput.typeText("again");
    app.mockInput.pressEnter();
    await app.frame();
    expect(app.calls.sendOptions[2]?.commandId).not.toBe(first?.commandId);
  });

  test("a thread the server refuses shows the error", async () => {
    const app = await mount(THREAD_ID);
    await app.frame();
    app.backend.thread.fail(THREAD_ID, "thread not found");
    expect(await app.frame()).toContain("could not load this thread: thread not found");
  });

  test("a space after a held-back d in a picker is typed", async () => {
    const app = await mount(null);
    await app.frame();
    await command(app, "t");
    app.mockInput.pressKey("d");
    app.mockInput.pressKey(" ");
    app.mockInput.pressKey("x");
    expect(await app.frame()).toContain("> d x");
  });
});

describe("servers", () => {
  test(":servers lists the profiles and Enter switches; the status line names the server", async () => {
    const app = await mount(null);
    expect(await app.frame()).toContain("· home");
    await command(app, "servers");
    const picker = await app.frame();
    expect(picker).toContain("Servers");
    expect(picker).toContain("build box");
    expect(picker).toContain("https://work.example/");
    app.mockInput.pressKey("j");
    app.mockInput.pressEnter();
    await app.frame();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(app.calls.switched).toEqual(["work"]);
    const after = await app.frame();
    expect(after).toContain("work (build box)");
    expect(after).toContain("switched to work");
  });

  test(":connect pairs, switches, and keeps the link out of the history", async () => {
    const app = await mount(null);
    await app.frame();
    await command(app, "connect http://lab:3773/pair#token=secret-credential");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(app.calls.links).toEqual(["http://lab:3773/pair#token=secret-credential"]);
    const after = await app.frame();
    expect(after).toContain("saved profile lab");
    expect(after).toContain("· lab");

    app.mockInput.pressKey(":");
    await app.frame();
    app.mockInput.pressArrow("up");
    expect(await app.frame()).not.toContain("secret-credential");
    app.mockInput.pressEscape();
    await app.frame();
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
