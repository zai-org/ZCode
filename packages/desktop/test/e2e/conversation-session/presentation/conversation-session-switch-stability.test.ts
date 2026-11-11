import { chromium } from "playwright-core";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  selectV4TaskById,
  startNewV4Draft,
  waitForV4ConversationState,
  waitForV4ComposerText,
  setV4ComposerText,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  startElectronWindowRecording,
  ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
} from "#e2e/helpers/electron-window-recorder";

import {
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_PROVIDER_NAME,
  UPSTREAM_MODEL,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_SECONDARY_THOUGHT_LEVEL,
  selectUpstreamModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
const evidence: unknown[] = [];
const out = process.env.ZCODE_E2E_ARTIFACT_DIR!;

async function installProbe() {
  await browser.execute(() => {
    const w = window as any;
    const ids = new WeakMap<Element, number>();
    let nextId = 0;
    let frame = 0;
    let stopped = false;
    const samples: any[] = [];
    const marks: any[] = [];
    let lastMutation = "";
    const read = (source: string) => {
      const pane = document.querySelector<HTMLElement>(
        '[data-testid="v4-session-pane-workspace-main"]',
      );
      const composer = pane?.querySelector<HTMLElement>('[data-testid="v4-composer"]');
      const editor = pane?.querySelector<HTMLElement>('[data-testid="v4-composer-input"]');
      const id = (el: Element | null | undefined) => {
        if (!el) return null;
        if (!ids.has(el)) ids.set(el, ++nextId);
        return ids.get(el);
      };
      const rect = composer?.getBoundingClientRect();
      const sample = {
        source,
        headerTitle:
          document.querySelector<HTMLElement>('[data-testid="workspace-title"]')?.innerText ?? "",
        sessionId: pane?.dataset.sessionId,
        seq: pane?.dataset.projectionSeq,
        lifecycle: pane?.dataset.sessionLifecycle,
        composer: id(composer),
        editor: id(editor),
        text: editor?.textContent,
        placeholder:
          editor?.parentElement?.querySelector<HTMLElement>('[aria-hidden="true"]')?.innerText,
        routing: composer?.dataset.inputRouting,
        editable: editor?.contentEditable,
        composerText: composer?.innerText,
        initializing: pane?.querySelector<HTMLElement>('[data-testid="v4-session-initialization"]')
          ?.innerText,
        modelText: pane?.querySelector<HTMLElement>('[data-testid="chat-model-select-trigger"]')
          ?.innerText,
        markers: Array.from(
          pane?.querySelectorAll<HTMLElement>('[data-marker-type="modelChange"]') ?? [],
          (node) => node.innerText,
        ),
        rowCount: pane?.querySelectorAll("[data-row-id]").length,
        activeWorkspace: w.__zcodeTabStoreE2E?.getState().activeWorkspacePath,
        centered: composer?.classList.contains("max-w-2xl"),
        stop: Boolean(pane?.querySelector('[data-testid="v4-stop"]')),
        x: rect?.x,
        y: rect?.y,
        width: rect?.width,
        height: rect?.height,
        visibility: composer ? getComputedStyle(composer).visibility : null,
      };
      const signature = JSON.stringify(sample);
      if (source === "raf" || signature !== lastMutation) {
        samples.push({ t: performance.now(), ...sample });
        if (source !== "raf") lastMutation = signature;
      }
    };
    const observer = new MutationObserver(() => read("mutation"));
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "data-session-id",
        "data-projection-seq",
        "data-input-routing",
        "contenteditable",
      ],
    });
    const tick = () => {
      if (stopped) return;
      read("raf");
      frame = requestAnimationFrame(tick);
    };
    tick();
    w.__composerSwitchProbe = {
      samples,
      marks,
      mark(label: string) {
        marks.push({ t: performance.now(), label });
      },
      stop() {
        stopped = true;
        cancelAnimationFrame(frame);
        observer.disconnect();
        return { samples, marks };
      },
    };
  });
}
async function mark(label: string) {
  await browser.execute((label) => (window as any).__composerSwitchProbe.mark(label), label);
}

async function verifyMobileSwitch(taskId: string, expectedTitle: string) {
  const pairingUrl = await obtainUnreadPairingUrl(
    new URL(process.env.ZCODE_WEB_REMOTE_CONTROL_URL!).origin,
  );
  const mobile = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await mobile.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await seedMobileFixtureLogin(context);
    const page = await context.newPage();
    await openMobilePairingPage(page, pairingUrl, {
      artifactDir: out,
      caseMarker: "SSV01",
      phase: "switch",
      readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
    });
    for (const theme of ["zai-light", "zai-dark"]) {
      await page.evaluate((theme) => (window as any).__testActions.setTheme(theme), theme);
      await page.evaluate(
        (locale) => (window as any).__testActions.setLocale(locale),
        theme === "zai-light" ? "zh-CN" : "en-US",
      );
      await showMobileTaskHome(page);
      await page.getByTestId("virtual-project-new-task").click();
      await page.getByTestId("v4-composer-input").waitFor();
      const newPlaceholder = await page
        .getByTestId("v4-composer-input")
        .locator("..")
        .locator('[aria-hidden="true"]')
        .innerText();
      await showMobileTaskHome(page);
      await page.evaluate((taskId) => {
        const samples: Array<{ placeholder: string | null; stop: boolean; headerTitle: string }> =
          [];
        const observer = new MutationObserver(() => {
          const pane = document.querySelector(`[data-session-id="${taskId}"]`);
          if (!pane) return;
          const editor = pane.querySelector('[data-testid="v4-composer-input"]');
          samples.push({
            placeholder:
              editor?.parentElement?.querySelector<HTMLElement>('[aria-hidden="true"]')
                ?.innerText ?? null,
            stop: Boolean(pane.querySelector('[data-testid="v4-stop"]')),
            headerTitle:
              document.querySelector<HTMLElement>('[data-testid="workspace-title"]')?.innerText ??
              "",
          });
        });
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["data-session-id"],
        });
        Object.assign(window, { __mobileSwitchSamples: samples, __mobileSwitchObserver: observer });
      }, taskId);
      await page.getByTestId(`task-item-${taskId}`).click();
      await page.getByTestId("v4-stop").waitFor();
      await page.getByTestId("workspace-title").filter({ hasText: expectedTitle }).waitFor();
      const samples = await page.evaluate(() => {
        (window as any).__mobileSwitchObserver.disconnect();
        return (window as any).__mobileSwitchSamples as Array<{
          placeholder: string | null;
          stop: boolean;
          headerTitle: string;
        }>;
      });
      await writeFile(
        join(out, `mobile-switch-${theme}.json`),
        JSON.stringify({ newPlaceholder, samples }, null, 2),
      );
      await page.screenshot({ path: join(out, `mobile-switch-${theme}.png`) });
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.some((sample) => sample.placeholder === newPlaceholder)).toBe(false);
      expect(samples.filter((sample) => /^(新建任务|New task)$/i.test(sample.headerTitle))).toEqual(
        [],
      );
    }
  } finally {
    await mobile.close();
  }
}

describe("SSV01/02/04 后台运行 session 的切换稳定性", () => {
  before(async () => {
    await mkdir(out, { recursive: true });
    await prepareV4ConversationE2E();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("切换期间不误显新任务提示或原始 Provider ID，草稿与编辑器保留", async function () {
    this.timeout(180_000);
    const runId = Date.now();
    await sendV4Prompt(
      `E2E_COMPOSER_DRAFT_COMPLETED_SEED_${runId}: Reply exactly upstream-e2e-ok.`,
    );
    await waitForV4TimelineContaining("upstream-e2e-ok");
    const completed = await waitForV4ConversationState(
      (s) => Boolean(s.taskId) && s.state === "idle",
      "completed seed",
      30000,
    );
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await sendV4Prompt(
      `E2E_COMPOSER_DRAFT_COMPLETED_SEED_SECOND_${runId}: Reply exactly upstream-e2e-ok.`,
    );
    await waitForV4TimelineContaining("upstream-e2e-ok");
    await waitForV4ConversationState(
      (s) => Boolean(s.taskId) && s.state === "idle",
      "second seed completed",
      30000,
    );
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    await sendV4Prompt(
      `E2E_SLOW_STREAM E2E_MODEL_SWITCH_HELD_RUNNING_${runId}: Reply exactly upstream-e2e-ok.`,
    );
    const running = await waitForV4ConversationState(
      (s) => Boolean(s.taskId) && s.state === "streaming",
      "running seed",
      30000,
    );
    await waitForV4ComposerText("", "submitted text cleared");
    await browser.waitUntil(
      async () => (await $('[data-testid="workspace-title"]').getText()) === "Upstream E2E Fixture",
      { timeout: 10_000, timeoutMsg: "authoritative title ready before switching" },
    );
    const expectedTitle = await $('[data-testid="workspace-title"]').getText();
    expect(expectedTitle.trim().length).toBeGreaterThan(0);
    expect(/^(新建任务|New task)$/i.test(expectedTitle)).toBe(false);
    await installProbe();
    const recording = await startElectronWindowRecording({
      outputPath: join(out, "composer-switch.webm"),
      frameDir: join(out, "composer-frames"),
      cleanupFrames: false,
      frameIntervalMs: 40,
      preRollDurationMs: 300,
    });
    try {
      evidence.push({ runId, completedTaskId: completed.taskId, runningTaskId: running.taskId });
      // 采样窗口只用于观测绘制；运行态由受控真实 Provider 流保持，不改业务时钟。
      for (let i = 0; i < 2; i++) {
        await browser.execute((iteration) => {
          (window as any).__testActions.setTheme(iteration === 0 ? "zai-light" : "zai-dark");
          (window as any).__testActions.setLocale(iteration === 0 ? "zh-CN" : "en-US");
        }, i);
        await mark(`draft-${i}:start`);
        await startDraftFromProject(DEFAULT_WORKSPACE);
        await browser.pause(1400);
        await mark(`draft-${i}:click-running`);
        await selectV4TaskById(running.taskId!);
        await waitForV4ConversationState(
          (s) => s.taskId === running.taskId && s.state === "streaming",
          "returned running",
          10000,
        );
        await browser.pause(700);
        await mark(`draft-${i}:settled`);
        await browser.saveScreenshot(join(out, `draft-return-${i}.png`));
      }
      for (let i = 0; i < 2; i++) {
        await selectV4TaskById(completed.taskId!);
        await browser.pause(1400);
        await mark(`session-${i}:click-running`);
        await selectV4TaskById(running.taskId!);
        await waitForV4ConversationState(
          (s) => s.taskId === running.taskId && s.state === "streaming",
          "returned running",
          10000,
        );
        await browser.pause(700);
        await mark(`session-${i}:settled`);
      }
      await startNewV4Draft();
      await browser.pause(1400);
      await mark("workspace:click-running");
      await selectV4TaskById(running.taskId!);
      await waitForV4ConversationState(
        (s) => s.taskId === running.taskId && s.state === "streaming",
        "returned from another workspace",
        10000,
      );
      await browser.pause(700);
      await mark("workspace:settled");
      await setV4ComposerText("E2E_UNSENT_RUNNING_DRAFT");
      await selectV4TaskById(completed.taskId!);
      await browser.pause(1400);
      await mark("text:click-running");
      await selectV4TaskById(running.taskId!);
      await waitForV4ComposerText("E2E_UNSENT_RUNNING_DRAFT", "running draft recovered");
      await browser.pause(700);
      await mark("text:settled");
      await verifyMobileSwitch(running.taskId!, expectedTitle);
    } finally {
      const trace = await browser.execute(() => (window as any).__composerSwitchProbe.stop());
      evidence.push(trace);
      await writeFile(join(out, "composer-switch-trace.json"), JSON.stringify(evidence, null, 2));
      const result = await recording.stop({ tailDurationMs: 300 });
      await writeFile(
        join(out, "composer-switch-video.json"),
        JSON.stringify(
          { video_capture_mode: ELECTRON_WINDOW_RECORDING_CAPTURE_MODE, ...result },
          null,
          2,
        ),
      );
      await releaseControlledReplay("upstream-model-switch-held-running-slow");
      const returned = trace.samples.filter((sample: any) => sample.sessionId === running.taskId);
      expect(returned.length).toBeGreaterThan(0);
      expect(
        trace.samples.filter((sample: any) => /^(新建任务|New task)$/i.test(sample.headerTitle)),
      ).toEqual([]);
      expect(returned.at(-1)?.headerTitle).toBe(expectedTitle);
      expect(returned.some((sample: any) => sample.stop)).toBe(true);
      expect(
        returned.filter((sample: any) =>
          /询问任何|Ask (?:ZCode )?anything|开始新|新任务/.test(sample.placeholder ?? ""),
        ),
      ).toEqual([]);
      expect(new Set(returned.map((sample: any) => sample.editor)).size).toBe(1);
      expect(
        returned.filter(
          (sample: any) =>
            (sample.modelText ?? "").includes("Choose model") ||
            (sample.modelText ?? "").includes(UPSTREAM_MODEL),
        ),
      ).toEqual([]);
      expect(returned.at(-1)?.text).toBe("E2E_UNSENT_RUNNING_DRAFT");
      // 同一个 marker 的已知名称不能在切换窗口闪回内部 ID。
      const markerTexts = returned.flatMap((sample: any) => sample.markers as string[]);
      expect(markerTexts.some((text: string) => text.includes(UPSTREAM_PROVIDER_NAME))).toBe(true);
      expect(
        markerTexts.filter((text: string) => text.includes(`${UPSTREAM_PROVIDER_ID}/`)),
      ).toEqual([]);
    }
  });
});
