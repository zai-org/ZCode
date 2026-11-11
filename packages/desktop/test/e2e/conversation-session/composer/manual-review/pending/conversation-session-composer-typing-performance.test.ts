import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ServiceChannels } from "@zcode/shared";
import { TID_V4_COMPOSER_INPUT, TID_V4_COMPOSER_SEND } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, setInputValueByTestIdDom } from "#e2e/helpers/desktop-app";
import { getV4ComposerDraftScopeSnapshot } from "#e2e/helpers/conversation-session-store";
import {
  getV4ComposerText,
  prepareV4ConversationE2E,
  selectV4TaskById,
} from "#e2e/helpers/v4-conversation";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";

interface TypingBatchMetrics {
  initialText: string;
  initialLength: number;
  expectedKeyEvents: number;
  observedKeyEvents: number;
  observedInputEvents: number;
  textAfterInput: string;
  finalText: string;
  latenciesMs: number[];
  frameGapsMs: number[];
  longTasksMs: number[];
  p95LatencyMs: number;
  maxFrameGapMs: number;
  maxLongTaskMs: number;
}

interface CompositionProbe {
  originalSetItem: typeof Storage.prototype.setItem;
  events: string[];
  onEvent: (event: Event) => void;
  writes: string[];
}

interface TypingProbe {
  dispose: () => Omit<TypingBatchMetrics, "initialText" | "textAfterInput">;
  frame: number;
  frameGapsMs: number[];
  inputEvents: number;
  keyEvents: number;
  latenciesMs: number[];
  longTasksMs: number[];
  observer: PerformanceObserver | null;
  onInput: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  pendingFrames: number;
  previousFrameAt: number;
}

declare global {
  interface Window {
    __zcodeComposerCompositionProbe?: CompositionProbe;
    __zcodeComposerTypingProbe?: TypingProbe;
  }
}

const INPUT_SEQUENCE = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(3).slice(0, 96);
const INPUT_CHARS = INPUT_SEQUENCE.length;
const DELETE_CHARS = 32;
const EXPECTED_KEY_EVENTS = INPUT_CHARS + DELETE_CHARS;
const SHORT_DRAFT = "";
const LONG_DRAFT = "长草稿输入基线".repeat(1_024);
const DRAFT_STORAGE_PREFIX = "zcode-v4-composer-project-drafts:v1:";
const STRESS_SCOPE_COUNT = 128;
const STRESS_SCOPE_TEXT = "草稿存储负载".repeat(2_048);
let originalDraftStorage: { key: string; value: string | null } | null = null;

const percentile = (values: readonly number[], ratio: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
};

const median = (values: readonly number[]) => percentile(values, 0.5);

async function createImportedSession(title: string) {
  const result = await callHandoffHost<{ session: { sessionId: string } }>(
    ServiceChannels.ZCodeAgent,
    "createSession",
    [
      {
        workspacePath: DEFAULT_WORKSPACE,
        persistence: "immediate",
        titleGenerationEnabled: false,
        importedHistory: {
          source: "claudeCode",
          title,
          messages: [
            { role: "user", content: `${title} fixture` },
            { role: "assistant", content: "fixture history" },
          ],
        },
      },
    ],
  );
  const sessionId = result.session.sessionId;
  await callHandoffHost(ServiceChannels.ZCodeTask, "resumeTask", [
    { taskId: sessionId, workspacePath: DEFAULT_WORKSPACE },
  ]);
  return sessionId;
}

async function installDraftStorageStress() {
  originalDraftStorage = await browser.execute(
    (prefix, scopeCount, scopeText) => {
      type WorkspaceState = { draftProjectId?: string | null };
      const e2eWindow = window as Window & {
        __zcodeTabStoreE2E?: {
          getState(): {
            activeWorkspaceIdentity?: string | null;
            activeWorkspacePath?: string | null;
          };
        };
        __zcodeSessionStoreE2E?: {
          getState(): {
            getWorkspaceState(path: string, identity?: string): WorkspaceState;
          };
        };
      };
      const tabState = e2eWindow.__zcodeTabStoreE2E?.getState();
      const workspacePath = tabState?.activeWorkspacePath ?? "";
      const workspaceIdentity = tabState?.activeWorkspaceIdentity?.trim() || undefined;
      const workspace = e2eWindow.__zcodeSessionStoreE2E
        ?.getState()
        .getWorkspaceState(workspacePath, workspaceIdentity);
      const scopeKey = JSON.stringify([
        "desktop",
        workspaceIdentity ?? "local",
        workspace?.draftProjectId ?? null,
      ]);
      const targetKey = `${prefix}${scopeKey}`;
      const original = { key: targetKey, value: localStorage.getItem(targetKey) };
      const scopes = Object.fromEntries(
        Array.from({ length: scopeCount }, (_, index) => [
          `stress-${index}`,
          {
            text: `${scopeText}-${index}`,
            mode: "build",
            planEnabled: false,
            updatedAt: index,
          },
        ]),
      );
      if (original.value !== null) {
        try {
          const parsed = JSON.parse(original.value) as { scopes?: Record<string, unknown> };
          Object.assign(scopes, parsed.scopes ?? {});
        } catch {
          /* invalid old data is replaced only for this isolated performance run */
        }
      }
      localStorage.setItem(targetKey, JSON.stringify({ version: 1, scopes }));
      return original;
    },
    DRAFT_STORAGE_PREFIX,
    STRESS_SCOPE_COUNT,
    STRESS_SCOPE_TEXT,
  );
}

async function restoreDraftStorage() {
  if (!originalDraftStorage) return;
  await browser.execute((original) => {
    if (original.value === null) localStorage.removeItem(original.key);
    else localStorage.setItem(original.key, original.value);
  }, originalDraftStorage);
}

async function installTypingProbe(initialLength: number) {
  await browser.execute(
    (inputTestId, initialLength, expectedKeyEvents) => {
      const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
      if (!input) throw new Error("Composer input is unavailable");
      input.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const latenciesMs: number[] = [];
      const frameGapsMs: number[] = [];
      const longTasksMs: number[] = [];
      let previousFrameAt = performance.now();
      let frame = 0;
      let pendingFrames = 0;
      let inputEvents = 0;
      let keyEvents = 0;
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key.length !== 1 && event.key !== "Backspace") return;
        keyEvents += 1;
        pendingFrames += 1;
        const startedAt = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            latenciesMs.push(performance.now() - startedAt);
            pendingFrames -= 1;
          }),
        );
      };
      const onInput = () => {
        inputEvents += 1;
      };
      const tick = (now: number) => {
        frameGapsMs.push(now - previousFrameAt);
        previousFrameAt = now;
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      input.addEventListener("keydown", onKeyDown, true);
      input.addEventListener("input", onInput, true);
      const observer =
        typeof PerformanceObserver === "undefined"
          ? null
          : new PerformanceObserver((list) => {
              longTasksMs.push(...list.getEntries().map((entry) => entry.duration));
            });
      observer?.observe({ type: "longtask" });
      window.__zcodeComposerTypingProbe = {
        frame,
        frameGapsMs,
        inputEvents,
        keyEvents,
        latenciesMs,
        longTasksMs,
        observer,
        onInput,
        onKeyDown,
        pendingFrames,
        previousFrameAt,
        dispose: () => {
          cancelAnimationFrame(frame);
          if (observer) longTasksMs.push(...observer.takeRecords().map((entry) => entry.duration));
          observer?.disconnect();
          input.removeEventListener("keydown", onKeyDown, true);
          input.removeEventListener("input", onInput, true);
          const finalText = (input.innerText || input.textContent || "").replace(/\u00a0/g, " ");
          const sortedLatencies = [...latenciesMs].sort((left, right) => left - right);
          const p95Index = Math.min(
            sortedLatencies.length - 1,
            Math.ceil(sortedLatencies.length * 0.95) - 1,
          );
          return {
            initialLength,
            expectedKeyEvents,
            observedKeyEvents: keyEvents,
            observedInputEvents: inputEvents,
            finalText,
            latenciesMs,
            frameGapsMs,
            longTasksMs,
            p95LatencyMs: p95Index >= 0 ? sortedLatencies[p95Index]! : 0,
            maxFrameGapMs: Math.max(0, ...frameGapsMs),
            maxLongTaskMs: Math.max(0, ...longTasksMs),
          };
        },
      };
      Object.defineProperties(window.__zcodeComposerTypingProbe, {
        inputEvents: { get: () => inputEvents },
        keyEvents: { get: () => keyEvents },
        pendingFrames: { get: () => pendingFrames },
      });
    },
    TID_V4_COMPOSER_INPUT,
    initialLength,
    EXPECTED_KEY_EVENTS,
  );
}

async function finishTypingProbe() {
  let latest = { keyEvents: 0, pendingFrames: 0 };
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(() => ({
        keyEvents: window.__zcodeComposerTypingProbe?.keyEvents ?? 0,
        pendingFrames: window.__zcodeComposerTypingProbe?.pendingFrames ?? 0,
      }));
      return latest.keyEvents === EXPECTED_KEY_EVENTS && latest.pendingFrames === 0;
    },
    {
      timeout: 30_000,
      timeoutMsg: `Composer typing probe did not reach a painted terminal state; latest=${JSON.stringify(latest)}`,
    },
  );
  return browser.execute(() => {
    const probe = window.__zcodeComposerTypingProbe;
    if (!probe) throw new Error("Composer typing probe is unavailable");
    const result = probe.dispose();
    delete window.__zcodeComposerTypingProbe;
    return result;
  });
}

async function sendKeySequence(values: readonly string[], actionId: string) {
  const actions: Array<
    { type: "keyDown" | "keyUp"; value: string } | { type: "pause"; duration: number }
  > = [];
  for (const value of values) {
    actions.push(
      { type: "keyDown", value },
      { type: "pause", duration: 8 },
      { type: "keyUp", value },
    );
  }
  await browser.performActions([{ type: "key", id: actionId, actions }]);
  await browser.releaseActions();
}

async function readComposerText() {
  return browser.execute((inputTestId) => {
    const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    if (!input) throw new Error("Composer input is unavailable");
    return (input.innerText || input.textContent || "").replace(/\u00a0/g, " ");
  }, TID_V4_COMPOSER_INPUT);
}

async function runTypingBatch(initialText: string) {
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, initialText, {
    stabilizeLexicalCaretAtEnd: true,
    timeout: 15_000,
  });
  // 性能采样必须从草稿静默窗口之后开始；这里只建立测试前置，不参与测量区间。
  await browser.pause(450);
  await installTypingProbe(initialText.length);
  await sendKeySequence([...INPUT_SEQUENCE], "composer-input");
  const textAfterInput = await readComposerText();
  await sendKeySequence(
    Array.from({ length: DELETE_CHARS }, () => "\uE003"),
    "composer-delete",
  );
  const metrics = await finishTypingProbe();
  return { ...metrics, initialText, textAfterInput };
}

async function beginChromiumImeComposition() {
  await browser.execute(
    (inputTestId, prefixes) => {
      const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
      if (!input) throw new Error("Composer input is unavailable");
      input.focus();
      const originalSetItem = Storage.prototype.setItem;
      const events: string[] = [];
      const onEvent = (event: Event) => {
        const inputEvent = event as InputEvent;
        const compositionEvent = event as CompositionEvent;
        events.push(
          [
            event.type,
            inputEvent.inputType ?? "",
            inputEvent.data ?? compositionEvent.data ?? "",
          ].join(":"),
        );
      };
      const probe: CompositionProbe = { originalSetItem, events, onEvent, writes: [] };
      window.__zcodeComposerCompositionProbe = probe;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (prefixes.some((prefix) => key.startsWith(prefix))) probe.writes.push(value);
        return originalSetItem.call(this, key, value);
      };
      for (const eventName of [
        "compositionstart",
        "compositionupdate",
        "beforeinput",
        "input",
        "compositionend",
      ]) {
        input.addEventListener(eventName, onEvent, true);
      }
    },
    TID_V4_COMPOSER_INPUT,
    [DRAFT_STORAGE_PREFIX, "zcode-v4-composer-drafts:v1:"],
  );
  await browser.electron.execute(async (electron) => {
    const window = electron.BrowserWindow.getAllWindows().find(
      (candidate) =>
        !candidate.isDestroyed() && candidate.webContents.getURL().includes("/renderer/index.html"),
    );
    if (!window) throw new Error("没有找到可输入 IME 的 renderer BrowserWindow");
    const devtools = window.webContents.debugger;
    if (!devtools.isAttached()) devtools.attach("1.3");
    try {
      for (const text of ["n", "ni", "你"]) {
        await devtools.sendCommand("Input.imeSetComposition", {
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
        });
      }
    } catch (error) {
      if (devtools.isAttached()) devtools.detach();
      throw error;
    }
  });
  return browser.execute(
    (inputTestId, sendTestId) => {
      const probe = window.__zcodeComposerCompositionProbe;
      const input = document.querySelector<
        HTMLElement & { __zcodeLexicalInputE2E?: { getText(): string } }
      >(`[data-testid="${inputTestId}"]`);
      const sendButton = document.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
      if (!sendButton) throw new Error("Composer send button is unavailable");
      return {
        events: [...(probe?.events ?? [])],
        sendEnabled: !sendButton.hasAttribute("disabled"),
        writes: probe?.writes.length ?? -1,
        text: input?.__zcodeLexicalInputE2E?.getText() ?? "",
      };
    },
    TID_V4_COMPOSER_INPUT,
    TID_V4_COMPOSER_SEND,
  );
}

async function cleanupChromiumImeComposition() {
  await browser.electron.execute((electron) => {
    const window = electron.BrowserWindow.getAllWindows().find(
      (candidate) =>
        !candidate.isDestroyed() && candidate.webContents.getURL().includes("/renderer/index.html"),
    );
    if (window?.webContents.debugger.isAttached()) window.webContents.debugger.detach();
  });
  return browser.execute((inputTestId) => {
    const probe = window.__zcodeComposerCompositionProbe;
    const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    if (!probe) return { events: [], writes: -1 };
    Storage.prototype.setItem = probe.originalSetItem;
    for (const eventName of [
      "compositionstart",
      "compositionupdate",
      "beforeinput",
      "input",
      "compositionend",
    ]) {
      input?.removeEventListener(eventName, probe.onEvent, true);
    }
    delete window.__zcodeComposerCompositionProbe;
    return { events: probe.events, writes: probe.writes.length };
  }, TID_V4_COMPOSER_INPUT);
}

async function finishChromiumImeComposition() {
  await browser.electron.execute(async (electron) => {
    const window = electron.BrowserWindow.getAllWindows().find(
      (candidate) =>
        !candidate.isDestroyed() && candidate.webContents.getURL().includes("/renderer/index.html"),
    );
    if (!window) throw new Error("没有找到可提交 IME 的 renderer BrowserWindow");
    const devtools = window.webContents.debugger;
    if (!devtools.isAttached()) devtools.attach("1.3");
    try {
      await devtools.sendCommand("Input.insertText", { text: "你" });
    } finally {
      if (devtools.isAttached()) devtools.detach();
    }
  });
  await browser.pause(450);
  return browser.execute((inputTestId) => {
    const probe = window.__zcodeComposerCompositionProbe;
    const input = document.querySelector<
      HTMLElement & { __zcodeLexicalInputE2E?: { getText(): string } }
    >(`[data-testid="${inputTestId}"]`);
    if (!probe) {
      return { events: [], writes: -1, text: input?.__zcodeLexicalInputE2E?.getText() ?? "" };
    }
    Storage.prototype.setItem = probe.originalSetItem;
    for (const eventName of [
      "compositionstart",
      "compositionupdate",
      "beforeinput",
      "input",
      "compositionend",
    ]) {
      input?.removeEventListener(eventName, probe.onEvent, true);
    }
    delete window.__zcodeComposerCompositionProbe;
    return {
      events: probe.events,
      writes: probe.writes.length,
      text: input?.__zcodeLexicalInputE2E?.getText() ?? "",
    };
  }, TID_V4_COMPOSER_INPUT);
}

async function startRendererCpuProfile() {
  await sendRendererProfilerCommand({ command: "start" });
  return async () => {
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!artifactDir) return;
    const serialized = await sendRendererProfilerCommand({ command: "stop" });
    expect(serialized.length).toBeGreaterThan(100);
    await writeFile(join(artifactDir, "composer-typing.cpuprofile"), serialized);
  };
}

async function sendRendererProfilerCommand(input: { command: "start" | "stop" }) {
  return browser.electron.execute(async (electron, request) => {
    const window = electron.BrowserWindow.getAllWindows().find(
      (candidate) =>
        !candidate.isDestroyed() && candidate.webContents.getURL().includes("/renderer/index.html"),
    );
    if (!window) throw new Error("没有找到可采样的 renderer BrowserWindow");
    const devtools = window.webContents.debugger;
    if (request.command === "start") {
      if (!devtools.isAttached()) devtools.attach("1.3");
      await devtools.sendCommand("Profiler.enable");
      await devtools.sendCommand("Profiler.start");
      return "started";
    }
    try {
      const result = await devtools.sendCommand("Profiler.stop");
      return JSON.stringify(result.profile ?? result);
    } finally {
      if (devtools.isAttached()) devtools.detach();
    }
  }, input);
}

async function writeJsonArtifact(fileName: string, value: unknown) {
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!artifactDir) return;
  await writeFile(join(artifactDir, fileName), JSON.stringify(value, null, 2));
}

async function writeMetrics(metrics: unknown) {
  await writeJsonArtifact("composer-typing-performance.json", metrics);
}

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("CTP02 Windows composer typing performance", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await installHandoffRpcProbe();
    await installDraftStorageStress();
  });

  after(async () => {
    await browser.pause(450);
    await cleanupChromiumImeComposition();
    await restoreDraftStorage();
    await restoreHandoffProbes();
  });

  it("publishes only the final Chromium IME composition value", async () => {
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", { timeout: 15_000 });
    await browser.pause(450);
    const during = await beginChromiumImeComposition();
    const committed = await finishChromiumImeComposition();
    await writeJsonArtifact("composer-ime-events.json", { during, committed });
    expect(during.writes).toBe(0);
    expect(during.text).toBe("你");
    expect(during.sendEnabled).toBe(true);
    expect(during.events.some((event) => event.startsWith("compositionstart:"))).toBe(true);
    expect(during.events.some((event) => event.startsWith("compositionupdate:"))).toBe(true);
    expect(during.events.some((event) => event.startsWith("input:insertCompositionText:"))).toBe(
      true,
    );
    expect(committed.writes).toBe(1);
    expect(committed.text).toBe("你");
    expect(committed.events.some((event) => event.startsWith("compositionend:"))).toBe(true);
  });

  it("keeps real character and backspace input responsive for short and long drafts", async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    if (process.env.ZCODE_E2E_COMPOSER_CPU_PROFILE === "1") {
      const stopProfile = await startRendererCpuProfile();
      try {
        await writeMetrics({ profileBatch: await runTypingBatch(LONG_DRAFT) });
      } finally {
        await stopProfile();
      }
      return;
    }
    const shortBatches: TypingBatchMetrics[] = [];
    const longBatches: TypingBatchMetrics[] = [];
    for (let index = 0; index < 3; index += 1) {
      shortBatches.push(await runTypingBatch(SHORT_DRAFT));
      longBatches.push(await runTypingBatch(LONG_DRAFT));
    }
    const result = {
      shortBatches,
      longBatches,
      shortMedianP95: median(shortBatches.map((batch) => batch.p95LatencyMs)),
      longMedianP95: median(longBatches.map((batch) => batch.p95LatencyMs)),
    };
    await writeMetrics(result);

    for (const batch of [...shortBatches, ...longBatches]) {
      expect(batch.observedKeyEvents).toBe(EXPECTED_KEY_EVENTS);
      expect(batch.textAfterInput).toBe(`${batch.initialText}${INPUT_SEQUENCE}`);
      expect(batch.finalText).toBe(
        `${batch.initialText}${INPUT_SEQUENCE.slice(0, INPUT_CHARS - DELETE_CHARS)}`,
      );
      expect(batch.p95LatencyMs).toBeLessThanOrEqual(150);
      expect(batch.maxLongTaskMs).toBeLessThan(200);
    }
    expect(result.shortMedianP95).toBeLessThanOrEqual(100);
    expect(result.longMedianP95).toBeLessThanOrEqual(100);
    expect(median(longBatches.map((batch) => batch.maxFrameGapMs))).toBeLessThan(100);
  });

  it("keeps an unfinished IME draft in the previous task scope", async () => {
    const sessionA = await createImportedSession("E2E_CTP02_IME_SCOPE_A");
    const sessionB = await createImportedSession("E2E_CTP02_IME_SCOPE_B");
    await selectV4TaskById(sessionA, 30_000);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", { timeout: 15_000 });
    await browser.pause(450);

    const during = await beginChromiumImeComposition();
    expect(during.text).toBe("你");
    expect(during.writes).toBe(0);
    expect(during.events.some((event) => event.startsWith("compositionend:"))).toBe(false);

    try {
      await selectV4TaskById(sessionB, 30_000);
      await browser.waitUntil(
        async () => {
          const draft = await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, sessionA);
          return draft.text === "你" && Boolean(draft.editorStateJson?.includes("你"));
        },
        {
          timeout: 15_000,
          timeoutMsg: "IME 候选正文没有写回旧 task scope",
        },
      );
      await browser.waitUntil(async () => (await getV4ComposerText()) === "", {
        timeout: 15_000,
        timeoutMsg: "切到 B task 后 Composer 没有清空旧 scope 的 IME 候选正文",
      });
      const draftA = await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, sessionA);
      const draftB = await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, sessionB);
      expect(draftA).toMatchObject({ exists: true, text: "你" });
      expect(draftA.editorStateJson).toContain("你");
      expect(draftB.exists).toBe(false);
      expect(await getV4ComposerText()).toBe("");
    } finally {
      await cleanupChromiumImeComposition();
    }
  });
});
