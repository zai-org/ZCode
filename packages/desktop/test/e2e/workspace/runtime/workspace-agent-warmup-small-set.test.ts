import { dirname } from "node:path";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import {
  SMALL_AGENT_WARMUP_SCENARIO,
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

describe("少量候选 workspace 恢复", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("TSL29: 只有 2 个候选时也只预热上次活动的 1 个，不凑数", async function () {
    this.timeout(90_000);
    const workspacePaths = getPassiveAgentStartupWorkspacePaths(
      dirname(DEFAULT_WORKSPACE),
      SMALL_AGENT_WARMUP_SCENARIO.workspaceCount,
    );
    const activeWorkspacePath = workspacePaths[SMALL_AGENT_WARMUP_SCENARIO.activeWorkspaceIndex];
    if (!activeWorkspacePath) throw new Error("small-set fixture 缺少 active workspace");
    const expectedWarmupWorkspacePaths = pickWorkspacePaths(
      workspacePaths,
      SMALL_AGENT_WARMUP_SCENARIO.expectedWarmupWorkspaceIndexes,
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
