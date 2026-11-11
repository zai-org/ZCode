import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, setInputValueByTestIdDom } from "#e2e/helpers/desktop-app";
import {
  ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
  isElectronRecordingEncoderAvailable,
  startElectronWindowRecording,
} from "#e2e/helpers/electron-window-recorder";
import {
  getV4ComposerText,
  waitForV4MentionOptionPrefix,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  PLUGIN_LIFECYCLE_EXAMPLE_PROMPT,
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  capturePluginManualReview,
  clickPluginControl,
  createPluginLifecycleFixture,
  openPluginCard,
  openPluginSettings,
  pluginStoragePath,
  requirePluginManualReview,
  getPluginList,
  waitUntilPluginList,
  waitForPluginControl,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_TIMEOUT_MS = 300_000;
const CASE_ID = "PLG12-TRY-STATES";
const ARTIFACT_DIR = join(
  process.cwd(),
  ".e2e-artifacts",
  "plugin-management",
  CASE_ID.toLowerCase(),
);
const VIDEO_PATH = join(ARTIFACT_DIR, "plugin-store-try-states.webm");
const VIDEO_MANIFEST_PATH = join(ARTIFACT_DIR, "plugin-store-try-states.recording.json");

describe("PLG12 Plugin 商店试用状态视觉验收", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("覆盖未安装、enabled、disabled 与保留的 @ Plugin 候选面板", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    requirePluginManualReview();

    const fixture = await createPluginLifecycleFixture("1.0.0");
    await seedLifecycleMarketplaceCache(fixture.marketplaceRoot);
    await openPluginSettings();
    await clickPluginControl("plugin-store-segment-personal");
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await waitForPluginControl("plugin-store-example-prompt", {
      pluginId: PLUGIN_LIFECYCLE_ID,
    });

    // 修复原因：录屏只是视觉复核证据，runner 缺 ffmpeg 时 stop() 编码会报 spawn ENOENT，
    // 把证据通道失败记成行为失败。编码器不可用时跳过录屏，行为断言与截图保持不变。
    const recording = (await isElectronRecordingEncoderAvailable())
      ? await startElectronWindowRecording({
          frameIntervalMs: 250,
          outputPath: VIDEO_PATH,
          preRollDurationMs: 500,
        })
      : null;
    if (!recording) {
      console.warn(`[${CASE_ID}] ffmpeg unavailable; skip window recording evidence`);
    }

    try {
      await capturePluginManualReview(CASE_ID, "01-uninstalled-detail");

      // 未安装：点击示例提示词只安装并留在详情页，不能提前创建对话草稿。
      await clickPluginControl("plugin-store-example-prompt", {
        pluginId: PLUGIN_LIFECYCLE_ID,
      });
      await waitForPluginControl(
        "plugin-store-item-menu",
        { pluginId: PLUGIN_LIFECYCLE_ID },
        120_000,
      );
      expect(await isPluginSettingsVisible()).toBe(true);
      await waitForEnabledState(true);
      await capturePluginManualReview(CASE_ID, "02-installed-stays-detail");

      // enabled：再次点击才进入标准新草稿；canonical + prompt 只预填，不发送。
      await clickPluginControl("plugin-store-example-prompt", {
        pluginId: PLUGIN_LIFECYCLE_ID,
      });
      await expectTryDraft("enabled");
      await capturePluginManualReview(CASE_ID, "03-enabled-try-draft");
      expect(await countCapturedRequestsContaining(PLUGIN_LIFECYCLE_EXAMPLE_PROMPT)).toBe(0);

      // disabled：仍允许生成同形草稿；disabled_in_session 只在真正发送时由 Agent 判定。
      await openPluginSettings();
      await clickPluginControl("plugin-store-segment-personal");
      await openPluginCard(PLUGIN_LIFECYCLE_ID);
      // 详情页启停已进入真实菜单，旧独立开关仅保留在管理页。
      await clickPluginControl("plugin-store-item-menu", { pluginId: PLUGIN_LIFECYCLE_ID });
      await clickPluginControl("plugin-store-menu-enabled", { pluginId: PLUGIN_LIFECYCLE_ID });
      await waitForEnabledSwitchState(false);
      await capturePluginManualReview(CASE_ID, "04-disabled-detail");
      await clickPluginControl("plugin-store-example-prompt", {
        pluginId: PLUGIN_LIFECYCLE_ID,
      });
      await expectTryDraft("disabled");
      await capturePluginManualReview(CASE_ID, "05-disabled-try-draft");
      expect(await countCapturedRequestsContaining(PLUGIN_LIFECYCLE_EXAMPLE_PROMPT)).toBe(0);

      // 试用入口不能替代或关闭旧能力：返回 composer 后 @ Plugin 候选仍可打开。
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "@", {
        timeout: 15_000,
        timeoutMsg: "PLG12 visual review could not edit the v4 composer",
      });
      const optionId = await waitForV4MentionOptionPrefix("plugin:", 30_000);
      expect(optionId.startsWith("plugin:")).toBe(true);
      await capturePluginManualReview(CASE_ID, "06-at-plugin-picker-retained");
    } finally {
      // 不能在 finally 里 return：会吞掉 try 中的断言错误。
      if (recording) {
        const recordingResult = await recording.stop({
          tailDurationMs: 1_000,
          timeoutMs: 60_000,
        });
        expect(recordingResult.captureMode).toBe(ELECTRON_WINDOW_RECORDING_CAPTURE_MODE);
        expect(recordingResult.frameCount).toBeGreaterThan(1);
        expect(recordingResult.captureError).toBeUndefined();
        await writeFile(
          VIDEO_MANIFEST_PATH,
          `${JSON.stringify(
            {
              caseId: CASE_ID,
              frameCount: recordingResult.frameCount,
              states: [
                "uninstalled-install-only",
                "installed-enabled-canonical-draft",
                "installed-disabled-canonical-draft",
                "composer-at-plugin-picker-retained",
              ],
              video_capture_mode: recordingResult.captureMode,
              videoPath: recordingResult.videoPath,
            },
            null,
            2,
          )}\n`,
          "utf-8",
        );
      }
    }
  });
});

async function expectTryDraft(pluginState: "enabled" | "disabled"): Promise<void> {
  await waitForV4Pane(
    (state) => state.sessionId === "draft" && !state.canStop,
    `Plugin Store try did not enter an idle draft for ${pluginState} Plugin`,
    30_000,
  );
  await browser.waitUntil(
    async () => {
      const composerText = (await getV4ComposerText()) ?? "";
      return (
        composerText.includes(`plugin://${PLUGIN_LIFECYCLE_ID}`) &&
        composerText.endsWith(` ${PLUGIN_LIFECYCLE_EXAMPLE_PROMPT}`)
      );
    },
    {
      timeout: 30_000,
      timeoutMsg: `Plugin Store try did not prefill canonical Plugin reference and prompt for ${pluginState} Plugin`,
    },
  );
}

async function isPluginSettingsVisible(): Promise<boolean> {
  return browser.execute(() =>
    Boolean(document.querySelector('[data-testid="plugin-store-root"]')),
  );
}

async function seedLifecycleMarketplaceCache(marketplaceRoot: string): Promise<void> {
  const managedMarketplaceRoot = pluginStoragePath("marketplaces", PLUGIN_LIFECYCLE_MARKETPLACE_ID);
  await mkdir(dirname(managedMarketplaceRoot), { recursive: true });
  await cp(marketplaceRoot, managedMarketplaceRoot, {
    force: true,
    recursive: true,
  });
  // 插件运行时读取的是托管缓存根目录的 marketplace.json；fixture 原始目录使用
  // Claude marketplace 的 .claude-plugin/marketplace.json 布局，直接复制目录会让
  // known record 存在但商店无法加载 manifest，因此这里补齐运行时缓存形态。
  await writeFile(
    join(managedMarketplaceRoot, "marketplace.json"),
    await readFile(join(marketplaceRoot, ".claude-plugin", "marketplace.json"), "utf-8"),
    "utf-8",
  );
  await writeFile(
    pluginStoragePath("known_marketplaces.json"),
    `${JSON.stringify(
      {
        version: 1,
        marketplaces: [
          // Settings 首次进入会按需刷新两个官方市场；若不预置成功时间，Claude
          // marketplace 的 git clone 会占用插件协议串行锁 90 秒，令本地 fixture 的
          // install/enable 操作看似卡死。该隔离 HOME 只需声明已刷新，PLG12 不验证公网目录。
          {
            addedAt: "2026-07-31T00:00:00.000Z",
            description: "Deterministic offline ZCode marketplace marker",
            id: "zcode-plugins-official",
            lastUpdated: "2099-01-01T00:00:00.000Z",
            name: "zcode-plugins-official",
            pluginCount: 1,
            source: {
              source: "url",
              url: "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
            },
          },
          {
            addedAt: "2026-07-31T00:00:00.000Z",
            description: "Deterministic offline Claude marketplace marker",
            id: "claude-plugins-official",
            lastUpdated: "2099-01-01T00:00:00.000Z",
            name: "claude-plugins-official",
            pluginCount: 1,
            source: {
              repo: "anthropics/claude-plugins-official",
              source: "github",
            },
          },
          {
            addedAt: "2026-07-31T00:00:00.000Z",
            description: "Deterministic PLG12 visual review marketplace",
            id: PLUGIN_LIFECYCLE_MARKETPLACE_ID,
            name: PLUGIN_LIFECYCLE_MARKETPLACE_ID,
            pluginCount: 8,
            source: {
              path: marketplaceRoot,
              source: "directory",
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

async function waitForEnabledState(enabled: boolean): Promise<void> {
  await waitUntilPluginList(
    (list) =>
      list.plugins.some(
        (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID && plugin.enabled === enabled,
      ),
    `Plugin enabled state did not become ${enabled}`,
  );
}

async function waitForEnabledSwitchState(enabled: boolean): Promise<void> {
  // 试用入口创建未归类草稿，市场启停写入当前 workspace；不能再查询初始项目的覆盖值。
  // 商店替换主区域时 workspace badge 不挂载，读取当前 Tab 的只读身份。
  const workspacePath = await browser.execute(
    () =>
      (
        window as Window & {
          __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath?: string | null } };
        }
      ).__zcodeTabStoreE2E?.getState().activeWorkspacePath,
  );
  if (!workspacePath) throw new Error("Plugin 试用没有当前 workspace");
  await browser.waitUntil(
    async () =>
      (await getPluginList(workspacePath)).plugins.some(
        (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID && plugin.enabled === enabled,
      ),
    {
      timeout: 30000,
      timeoutMsg: `Plugin enabled state did not become ${enabled} in ${workspacePath}`,
    },
  );
}

async function countCapturedRequestsContaining(marker: string): Promise<number> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) return 0;
  try {
    const artifact = JSON.parse(await readFile(capturePath, "utf-8")) as {
      records?: Array<{ requestJson?: unknown }>;
    };
    return (artifact.records ?? []).filter((record) =>
      JSON.stringify(record.requestJson).includes(marker),
    ).length;
  } catch {
    return 0;
  }
}
