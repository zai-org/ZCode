import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_BACK_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  getE2EAppDataPaths,
  DEFAULT_WORKSPACE,
  clickTestIdByDom,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  getV4ConversationState,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  setV4ComposerText,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  capturePluginManualReview,
  getPluginList,
  getPluginOverview,
  openInstalledPluginSettingsDetail,
  openPluginManagementSettings,
  selectPluginSettingsScope,
  requirePluginManualReview,
  setPluginPresentation,
  waitForPluginControl,
} from "#e2e/helpers/plugin-management-lifecycle";
import { PLUGIN_CDN_ZIP_ID } from "#e2e/helpers/plugin-cdn-zip-marketplace";
import {
  buildElectronRecordingFfmpegArgs,
  ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
  startElectronWindowRecording,
} from "#e2e/helpers/electron-window-recorder";
import { runElectronRecordingCommand } from "#e2e/helpers/electron-window-recorder-timeout";

import { getUpstreamRequestEvidence } from "#e2e/helpers/conversation-session-network";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";

const CASE_ID = "PLM-LC-021";
const ARTIFACT_DIR = join(process.cwd(), ".e2e-artifacts", "plugin-management", "plm-lc-021");
const SKIP_PROMPT = "帮我查找一个能处理 ZIP 归档的官方插件。\nE2E_AGENT_PLUGIN_SKIP";
const INSTALL_PROMPT = "帮我查找并安装能处理 ZIP 归档的官方插件。\nE2E_AGENT_PLUGIN_INSTALL";

async function startWorkspaceDraft() {
  // 全局新建会分配独立 cwd；配置与安装断言必须始终指向同一个测试工程。
  const hidden = !(await browser.$('[data-testid="task-settings-button"]').isDisplayed());
  if (hidden) await browser.$('button[aria-label="切换侧边栏"]').click();
  await startDraftFromProject(DEFAULT_WORKSPACE);
  if (hidden) await browser.$('button[aria-label="切换侧边栏"]').click();
}

async function seedDisabledPlugin() {
  const { homeDir, workspace } = getE2EAppDataPaths();
  const paths = [
    join(homeDir, ".zcode", "cli", "config.json"),
    join(workspace, ".zcode", "config.json"),
    join(homeDir, "other-workspace", ".zcode", "config.json"),
  ];
  for (const path of paths) {
    const raw = await readFile(path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    });
    const current = JSON.parse(raw);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        ...current,
        plugins: {
          ...current.plugins,
          enabledPlugins: {
            ...current.plugins?.enabledPlugins,
            [PLUGIN_CDN_ZIP_ID]: false,
          },
        },
      }),
    );
  }
  return async () =>
    Promise.all(
      paths.map(async (path) => {
        const config = JSON.parse(await readFile(path, "utf8"));
        return config.plugins.enabledPlugins[PLUGIN_CDN_ZIP_ID];
      }),
    );
}

const SETTING_ID = "settings-plugin-auto-recommendation";
const DISABLED_PROMPT = "帮我查找并推荐一个官方插件。E2E_PLUGIN_RECOMMENDATIONS_DISABLED";
async function expectDiscoveryTools(marker: string, enabled: boolean) {
  const requests = await getUpstreamRequestEvidence({ includes: [marker] });
  const body = requests.at(-1)?.requestJson as
    | {
        tools?: Array<{ name?: string; function?: { name?: string } }>;
      }
    | undefined;
  const names = body?.tools?.map((tool) => tool.name ?? tool.function?.name) ?? [];
  expect(body).toBeDefined();
  expect(names.includes("SearchPlugins")).toBe(enabled);
  expect(names.includes("SuggestPluginInstall")).toBe(enabled);
}
async function checkDisabledRequest() {
  await sendV4PromptAndWaitAccepted(
    DISABLED_PROMPT,
    "E2E_PLUGIN_RECOMMENDATIONS_DISABLED",
    "Disabled request was not accepted",
  );
  await waitForV4AssistantMessageContaining("E2E_PLUGIN_RECOMMENDATIONS_DISABLED_DONE");
  await expectDiscoveryTools("E2E_PLUGIN_RECOMMENDATIONS_DISABLED", false);
}
async function checkRecommendationSetting(expected: boolean, next?: boolean, checkNarrow = false) {
  const restoreHiddenSidebar = !(await browser
    .$('[data-testid="task-settings-button"]')
    .isDisplayed());
  if (restoreHiddenSidebar) await browser.$('button[aria-label="切换侧边栏"]').click();
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"));
  await waitForTestIdByDom(SETTING_ID);
  const toggle = browser.$(`[data-testid="${SETTING_ID}"]`);
  expect(await toggle.getAttribute("aria-checked")).toBe(String(expected));
  if (next !== undefined) {
    await toggle.click();
    await browser.waitUntil(
      async () => (await toggle.getAttribute("aria-checked")) === String(next),
    );
    await browser.waitUntil(async () => (await toggle.getAttribute("disabled")) === null);
  }
  await browser.execute(() => {
    document
      .querySelector('[data-testid="settings-plugin-auto-recommendation"]')
      ?.scrollIntoView({ block: "center" });
  });
  await capturePluginManualReview("plm-lc-021", `setting-${next ?? expected}`);
  if (checkNarrow) {
    const rendererUrl = await browser.getUrl();
    await browser.electron.execute((electron, url) => {
      electron.BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === url)
        ?.setMinimumSize(320, 480);
    }, rendererUrl);
    await setPluginPresentation({ locale: "en-US", theme: "zai-light", width: 390, height: 844 });
    await browser.execute(() => {
      document
        .querySelector('[data-testid="settings-plugin-auto-recommendation"]')
        ?.scrollIntoView({ block: "center" });
    });
    expect(await toggle.isDisplayed()).toBe(true);
    expect(await toggle.getAttribute("aria-label")).toBe("Automatic plugin recommendations");
    expect(
      await browser.execute(() => {
        const element = document.querySelector(
          '[data-testid="settings-plugin-auto-recommendation"]',
        )!;
        const bounds = element.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= window.innerWidth;
      }),
    ).toBe(true);
    await capturePluginManualReview("plm-lc-021", "setting-default-light-narrow");
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-dark", width: 1200, height: 900 });
  }
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  if (restoreHiddenSidebar) await browser.$('button[aria-label="切换侧边栏"]').click();
}

describe("PLM-LC-021 Agent official plugin discovery", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("queries the official catalog, skips without installation, then reloads the same session before an explicit Skill call", async function () {
    this.timeout(240_000);
    requirePluginManualReview();
    const readEnabledScopes = await seedDisabledPlugin();
    await prepareV4ConversationE2E();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-dark", width: 1200, height: 900 });
    await checkRecommendationSetting(false, undefined, true);
    await checkDisabledRequest();
    await checkRecommendationSetting(false, true);
    await checkRecommendationSetting(true);
    await startWorkspaceDraft();
    const startedAt = Date.now();
    const steps: Array<{ label: string; screenshot: string; offsetMs: number }> = [];
    const recording = await startElectronWindowRecording({
      outputPath: join(ARTIFACT_DIR, "full-flow.webm"),
      frameIntervalMs: 200,
      preRollDurationMs: 500,
      encodeVideo: async (input) => {
        const args = buildElectronRecordingFfmpegArgs(input);
        // 窄屏检查会改变窗口尺寸；编码统一画布并保留比例，不能拉伸或裁掉真实界面。
        args[args.indexOf("-vf") + 1] =
          "scale=1600:1200:force_original_aspect_ratio=decrease,pad=1600:1200:(ow-iw)/2:(oh-ih)/2";
        await runElectronRecordingCommand(input.ffmpegPath, args, {
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        });
      },
    });
    const captureStep = async (label: string) => {
      const screenshot = await capturePluginManualReview(CASE_ID, label);
      steps.push({ label, screenshot, offsetMs: Date.now() - startedAt });
      // 仅为人工看录屏留出阅读时间；业务断言仍由状态等待完成，不依赖这段停顿。
      await browser.pause(1_200);
    };
    let passed = false;
    try {
      await captureStep("01-new-task");
      await setV4ComposerText(SKIP_PROMPT);
      await captureStep("02-enter-request");
      await sendV4PromptAndWaitAccepted(
        SKIP_PROMPT,
        "E2E_AGENT_PLUGIN_SKIP",
        "Discovery prompt was not accepted",
      );
      await waitForTestIdByDom("plugin-install-card", { timeout: 60_000 });
      expect(
        (await getPluginOverview()).installedPlugins.some(
          (plugin) => plugin.id === PLUGIN_CDN_ZIP_ID,
        ),
      ).toBe(false);
      await captureStep("03-official-search-and-confirm");
      await browser.$('button[aria-label="切换侧边栏"]').click();
      // 窄屏验收只放开隔离测试窗口的最小尺寸，不改变产品桌面窗口约束。
      const rendererUrl = await browser.getUrl();
      await browser.electron.execute((electron, url) => {
        electron.BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === url)
          ?.setMinimumSize(320, 480);
      }, rendererUrl);
      await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 390, height: 844 });
      await waitForTestIdByDom("plugin-install-card", { timeout: 15_000 });
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const card = document.querySelector<HTMLElement>(
              '[data-testid="plugin-install-card"]',
            )!;
            const bounds = card.getBoundingClientRect();
            return (
              bounds.left >= 0 &&
              bounds.right <= window.innerWidth &&
              card.scrollWidth <= card.clientWidth
            );
          }),
        { timeout: 10_000, timeoutMsg: "Narrow plugin card extends beyond the visible viewport" },
      );
      const card = await browser.$('[data-testid="plugin-install-card"]');
      expect(await card.getText()).toContain("跳过");
      expect(await card.getText()).toContain("安装并在当前工作区启用");
      expect(await card.getText()).toContain("ZIP 归档助手");
      expect(await card.getText()).toContain("用于验证大翻译表的本地插件");
      expect(
        await browser.execute(() => {
          const element = document.querySelector<HTMLElement>(
            '[data-testid="plugin-install-card"]',
          )!;
          return element.scrollWidth <= element.clientWidth;
        }),
      ).toBe(true);
      await captureStep("04-narrow-light-confirm");
      await clickTestIdByDom("plugin-install-skip");
      await waitForV4AssistantMessageContaining("E2E_AGENT_PLUGIN_SKIPPED");
      expect(
        (await getPluginOverview()).installedPlugins.some(
          (plugin) => plugin.id === PLUGIN_CDN_ZIP_ID,
        ),
      ).toBe(false);
      expect(await readEnabledScopes()).toEqual([false, false, false]);
      await captureStep("05-skipped-no-installation");
      await expectDiscoveryTools("E2E_AGENT_PLUGIN_SKIP", true);

      await setPluginPresentation({ locale: "zh-CN", theme: "zai-dark", width: 1200, height: 900 });
      await checkRecommendationSetting(true);
      await startWorkspaceDraft();
      await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1200, height: 900 });
      await setV4ComposerText(INSTALL_PROMPT);
      await captureStep("06-new-install-request");
      await sendV4PromptAndWaitAccepted(
        INSTALL_PROMPT,
        "E2E_AGENT_PLUGIN_INSTALL",
        "Install prompt was not accepted",
      );
      await waitForTestIdByDom("plugin-install-card", { timeout: 60_000 });
      expect(await (await browser.$('[data-testid="plugin-install-card"]')).getText()).toContain(
        "ZIP Archive Helper",
      );
      expect(await (await browser.$('[data-testid="plugin-install-card"]')).getText()).toContain(
        "Local plugin with a large translation catalog",
      );
      expect(await (await browser.$('[data-testid="plugin-install-confirm"]')).getText()).toBe(
        "Install and enable in this workspace",
      );
      await captureStep("07-install-confirmation");
      await setPluginPresentation({ locale: "en-US", theme: "zai-light", width: 390, height: 844 });
      expect(
        await browser.execute(() => {
          const button = document.querySelector<HTMLElement>(
            '[data-testid="plugin-install-confirm"]',
          )!;
          const bounds = button.getBoundingClientRect();
          return (
            bounds.left >= 0 &&
            bounds.right <= window.innerWidth &&
            button.scrollWidth <= button.clientWidth
          );
        }),
      ).toBe(true);
      await captureStep("07b-narrow-install-confirmation");
      await setPluginPresentation({ locale: "zh-CN", theme: "zai-dark", width: 1200, height: 900 });
      const sessionId = (await getV4ConversationState()).taskId;
      if (!sessionId) throw new Error("安装确认时缺少 sessionId");
      const pane = browser.$(`[data-session-id="${sessionId}"][data-session-generation]`);
      const generation = Number(await pane.getAttribute("data-session-generation"));
      await clickTestIdByDom("plugin-install-confirm");
      await captureStep("08-confirmed-installation");
      // fixture 仅在真实工具结果包含 installed + refreshRequired 时返回完成 marker。
      await waitForV4AssistantMessageContaining("E2E_AGENT_PLUGIN_INSTALLED_REFRESH_REQUIRED");
      expect(
        (await getPluginList()).plugins.find((plugin) => plugin.id === PLUGIN_CDN_ZIP_ID),
      ).toMatchObject({ enabled: true, skillRootCount: 1 });
      await browser.waitUntil(
        async () =>
          (await pane.getAttribute("data-session-lifecycle")) === "ready" &&
          Number(await pane.getAttribute("data-session-generation")) === generation + 1,
        { timeout: 60_000, timeoutMsg: "同一任务没有自动重载，或重载多次" },
      );
      expect((await getV4ConversationState()).taskId).toBe(sessionId);
      // 三步均为安装轮：搜索、确认和最终答复。重载本身不能合成第四个请求。
      expect(
        (await getUpstreamRequestEvidence({ includes: ["E2E_AGENT_PLUGIN_INSTALL"] })).map(
          (request) => request.fixtureId,
        ),
      ).toEqual(["apd-install-search", "apd-install-suggest", "apd-install-complete"]);
      await sendV4PromptAndWaitAccepted(
        "使用刚安装的 zip-skill。E2E_USE_ZIP_SKILL",
        "E2E_USE_ZIP_SKILL",
        "重载后未接受用户的下一条输入",
      );
      await waitForV4AssistantMessageContaining("E2E_LOADED_INSTALLED_SKILL");
      expect((await getV4ConversationState()).taskId).toBe(sessionId);
      expect(await readEnabledScopes()).toEqual([false, true, false]);
      await captureStep("09-same-session-skill-executed");
      await expectDiscoveryTools("E2E_AGENT_PLUGIN_INSTALL", true);
      await checkRecommendationSetting(true, false);
      await checkRecommendationSetting(false);
      await checkDisabledRequest();
      await browser.$('button[aria-label="切换侧边栏"]').click();
      await openPluginManagementSettings();
      await selectPluginSettingsScope("workspace");
      await waitForPluginControl("plugin-settings-plugin-row", { pluginId: PLUGIN_CDN_ZIP_ID });
      await expect(
        browser.$(
          `[data-testid="plugin-settings-enabled-switch"][data-plugin-id="${PLUGIN_CDN_ZIP_ID}"]`,
        ),
      ).toHaveAttribute("aria-checked", "true");
      await captureStep("10-installed-plugin-settings");
      await openInstalledPluginSettingsDetail(PLUGIN_CDN_ZIP_ID);
      await waitForPluginControl("plugin-store-description", {});
      await captureStep("11-installed-plugin-detail");
      passed = true;
    } finally {
      const result = await recording.stop({ tailDurationMs: 1_200 });
      await writeFile(
        join(ARTIFACT_DIR, "full-flow.json"),
        JSON.stringify(
          {
            passed,
            video_capture_mode: ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
            ...result,
            provider: "case-local synthetic replay",
            steps,
          },
          null,
          2,
        ),
      );
      expect(result.captureError).toBeUndefined();
      expect(result.frameCount).toBeGreaterThan(10);
    }
  });
});
