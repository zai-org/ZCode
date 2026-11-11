import { dirname } from "node:path";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
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
import {
  assertStableAgentSelection,
  pickWorkspacePaths,
  waitForActiveWorkspacePath,
  waitForRestoredProjects,
} from "#e2e/helpers/workspace-agent-warmup";

describe("恢复 workspace 只预热 active 1 个 Agent", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("TSL29: 9 个 restored workspace 启动只预热上次活动的 05，不按 recent 补位", async function () {
    this.timeout(120_000);
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
    await assertStableAgentSelection(workspacePaths, expectedWarmupWorkspacePaths);
  });
});
