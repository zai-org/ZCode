import { dirname } from "node:path";
import {
  TID_MODEL_PROVIDER_API_KEY_INPUT,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  readModelProviders,
  setInputValueByTestIdDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { UPSTREAM_PROVIDER_ID, UPSTREAM_PROVIDER_NAV_KEY } from "#e2e/helpers/upstream-provider";
import {
  PASSIVE_AGENT_STARTUP_SCENARIO,
  getPassiveAgentStartupWorkspacePaths,
} from "#e2e/helpers/passive-agent-startup-fixture";
import {
  isMainRendererUrl,
  isResourceManagerUrl,
  openResourceManager,
  switchToElectronRendererTarget,
  waitForResourceManagerReady,
} from "#e2e/helpers/resource-manager";
import { sel } from "#e2e/helpers/selectors";
import {
  assertStableAgentSelection,
  pickWorkspacePaths,
  waitForActiveWorkspacePath,
  waitForRestoredProjects,
} from "#e2e/helpers/workspace-agent-warmup";

describe("provider 保存不启动 dormant workspace Agent", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("TSL36: 9 个 restored workspace 保存一次 provider 后仍只保留原 1 个 Agent PID", async function () {
    this.timeout(150_000);
    const workspacePaths = getPassiveAgentStartupWorkspacePaths(
      dirname(DEFAULT_WORKSPACE),
      PASSIVE_AGENT_STARTUP_SCENARIO.workspaceCount,
    );
    const activeWorkspacePath = workspacePaths[PASSIVE_AGENT_STARTUP_SCENARIO.activeWorkspaceIndex];
    if (!activeWorkspacePath) throw new Error("启动 fixture 缺少 active workspace");
    const expectedWarmupWorkspacePaths = pickWorkspacePaths(
      workspacePaths,
      PASSIVE_AGENT_STARTUP_SCENARIO.expectedWarmupWorkspaceIndexes,
    );

    await waitForWorkspaceApp(activeWorkspacePath, 30_000);
    await waitForActiveWorkspacePath(activeWorkspacePath);
    await waitForRestoredProjects(workspacePaths);

    await openResourceManager();
    await switchToElectronRendererTarget(isResourceManagerUrl);
    await waitForResourceManagerReady();
    const beforeSave = await assertStableAgentSelection(
      workspacePaths,
      expectedWarmupWorkspacePaths,
    );

    await switchToElectronRendererTarget(isMainRendererUrl);
    await saveUpstreamApiKeyThroughSettings(`e2e-provider-save-${Date.now()}`);

    await switchToElectronRendererTarget(isResourceManagerUrl);
    // Bug 回归：旧 provider 同步会串行启动 6 个 dormant workspace；观察窗口必须覆盖
    // 实测的 10 秒启动风暴，不能只读取保存按钮点击后的瞬时进程数。
    await browser.pause(10_000);
    const afterSave = await assertStableAgentSelection(
      workspacePaths,
      expectedWarmupWorkspacePaths,
    );
    expect(afterSave).toEqual(beforeSave);
  });
});

async function saveUpstreamApiKeyThroughSettings(nextApiKey: string): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有出现模型供应商分区入口",
  });
  await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, UPSTREAM_PROVIDER_NAV_KEY), {
    timeout: 30_000,
    timeoutMsg: "设置页没有出现 上游 E2E provider",
  });

  await setInputValueByTestIdDom(TID_MODEL_PROVIDER_API_KEY_INPUT, nextApiKey, {
    timeout: 15_000,
    timeoutMsg: "Upstream E2E provider API Key 输入框没有出现",
  });
  await browser.waitUntil(
    async () =>
      (await readModelProviders()).some(
        (provider) => provider.id === UPSTREAM_PROVIDER_ID && provider.apiKey === nextApiKey,
      ),
    {
      timeout: 30_000,
      timeoutMsg: "provider API Key 保存没有持久化",
    },
  );
}
