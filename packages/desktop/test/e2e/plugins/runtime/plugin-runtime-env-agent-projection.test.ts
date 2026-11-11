import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SUBAGENT_ROW,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, waitForTestIdByDom } from "#e2e/helpers/desktop-app";
import {
  ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
  startElectronWindowRecording,
} from "#e2e/helpers/electron-window-recorder";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  captureArtifactAdvertisesToolName,
  findUpstreamRequestContaining,
} from "#e2e/helpers/plugin-mcp-skill";
import {
  addMarketplaceSourceThroughUi,
  capturePluginManualReview,
  clickPluginControl,
  hasPluginControl,
  installPluginThroughUi,
  openPluginCard,
  openPluginSettings,
  requirePluginManualReview,
  setPluginEnabledThroughUi,
  waitForPluginControl,
  waitUntilPluginOverview,
} from "#e2e/helpers/plugin-management-lifecycle";
import {
  PLUGIN_RUNTIME_ENV_AGENT_BARE_NAME,
  PLUGIN_RUNTIME_ENV_AGENT_NAME,
  PLUGIN_RUNTIME_ENV_ID,
  PLUGIN_RUNTIME_ENV_MARKETPLACE_ID,
  PLUGIN_RUNTIME_ENV_RESOLVED_MARKER,
  PLUGIN_RUNTIME_ENV_TOOL_NAME,
  PLUGIN_RUNTIME_ENV_VARIABLE,
  createPluginRuntimeEnvFixture,
} from "#e2e/helpers/plugin-runtime-env-agent";

const CASE_TIMEOUT_MS = 240000;
const VIDEO_ARTIFACT_DIR = join(process.cwd(), ".e2e-artifacts", "plugin-management", "plm-lc-010");
const VIDEO_ARTIFACT_PATH = join(VIDEO_ARTIFACT_DIR, "plugin-runtime-env-agent-projection.webm");
const VIDEO_MANIFEST_PATH = join(
  VIDEO_ARTIFACT_DIR,
  "plugin-runtime-env-agent-projection.recording.json",
);

describe("PLM-LC-010 插件 secret env 与 agent 资源投影 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("安装后 MCP 读取任意环境变量且 Subagents 只展示一个规范资源", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    requirePluginManualReview();
    const secret = process.env[PLUGIN_RUNTIME_ENV_VARIABLE]?.trim();
    if (!secret) {
      throw new Error(`${PLUGIN_RUNTIME_ENV_VARIABLE} must be injected by the E2E runner`);
    }

    const fixture = await createPluginRuntimeEnvFixture(secret);
    const recording = await startElectronWindowRecording({
      frameIntervalMs: 250,
      outputPath: VIDEO_ARTIFACT_PATH,
      preRollDurationMs: 500,
    });

    try {
      await openPluginSettings();
      await addMarketplaceSourceThroughUi(fixture.marketplaceRoot);
      // 新市场提交后还会异步持久化并刷新列表，必须等弹窗关闭后再操作下层页面。
      await waitUntilPluginOverview(
        (overview) =>
          overview.marketplaces.some(
            (marketplace) => marketplace.id === PLUGIN_RUNTIME_ENV_MARKETPLACE_ID,
          ),
        "Plugin runtime env marketplace was not persisted after the UI submission",
        60000,
      );
      await browser.waitUntil(
        async () => !(await hasPluginControl("plugin-store-add-source-dialog")),
        {
          timeout: 60000,
          timeoutMsg:
            "Plugin runtime env marketplace completed but the source dialog remained open",
        },
      );
      await clickPluginControl("plugin-store-segment-personal");
      await openPluginCard(PLUGIN_RUNTIME_ENV_ID);
      await waitForPluginControl("plugin-store-component-section", {
        componentKind: "mcp",
      });
      await waitForPluginControl("plugin-store-component-section", {
        componentKind: "agent",
      });
      await installPluginThroughUi(PLUGIN_RUNTIME_ENV_ID);
      await setPluginEnabledThroughUi(PLUGIN_RUNTIME_ENV_ID, true, "detail");
      await capturePluginManualReview("PLM-LC-010", "installed-mcp-and-agent");

      // Plugin 商店是 workspace 主视图而不是设置页分区，subagent 投影断言必须自己打开设置页。
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 15000 });
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "subagents"));
      await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, PLUGIN_RUNTIME_ENV_AGENT_NAME), {
        timeout: 30000,
      });
      const agentRows = await browser.execute(
        (canonicalTestId, bareTestId) => ({
          bare: document.querySelectorAll(`[data-testid="${bareTestId}"]`).length,
          canonical: document.querySelectorAll(`[data-testid="${canonicalTestId}"]`).length,
        }),
        testId(TID_SUBAGENT_ROW, PLUGIN_RUNTIME_ENV_AGENT_NAME),
        testId(TID_SUBAGENT_ROW, PLUGIN_RUNTIME_ENV_AGENT_BARE_NAME),
      );
      expect(agentRows).toEqual({ bare: 0, canonical: 1 });
      await capturePluginManualReview("PLM-LC-010", "single-plugin-agent-resource");

      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
      await prepareV4ConversationE2E();
      const runMarker = `E2E_PLUGIN_SECRET_ENV_CASE_${Date.now()}`;
      await sendV4Prompt(
        `${runMarker}: Call ${PLUGIN_RUNTIME_ENV_TOOL_NAME} once, then reply with exactly upstream-e2e-ok.`,
      );

      const initialRequest = await findUpstreamRequestContaining(runMarker, 60000, {
        advertisedToolName: PLUGIN_RUNTIME_ENV_TOOL_NAME,
      });
      expect(initialRequest).not.toBeNull();
      expect(
        captureArtifactAdvertisesToolName(
          initialRequest?.requestJson,
          PLUGIN_RUNTIME_ENV_TOOL_NAME,
        ),
      ).toBe(true);
      expect(await approveV4Permission()).toBe(true);

      const finalRequest = await findUpstreamRequestContaining(
        PLUGIN_RUNTIME_ENV_RESOLVED_MARKER,
        60000,
      );
      expect(finalRequest).not.toBeNull();
      expect(JSON.stringify(finalRequest?.requestJson)).not.toContain(secret);
      await waitForV4Pane(
        (snapshot) => !snapshot.canStop && snapshot.timelineText.includes("upstream-e2e-ok"),
        "Plugin secret env case did not visibly reach the deterministic final response",
        60000,
      );
      await capturePluginManualReview("PLM-LC-010", "mcp-secret-env-resolved");
    } finally {
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
            caseName: "plugin-runtime-env-agent-projection",
            frameCount: recordingResult.frameCount,
            video_capture_mode: recordingResult.captureMode,
            videoPath: recordingResult.videoPath,
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
    }
  });
});
