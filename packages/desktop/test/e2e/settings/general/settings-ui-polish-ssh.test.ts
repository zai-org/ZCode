import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import {
  assertNoRemoteModelProviderSyncAction,
  openModelProviderSettings,
} from "#e2e/helpers/settings-model-provider-boundary";
import { connectSSHWorkspace, readSSHRuntimeConfig } from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// Linux 队列按 spec 分配隔离 SSH 目标；本地用例另有入口，默认回归无需该目标。
describe("设置页 UI polish E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  beforeEach(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
  });

  it("MP-UI-05-remote: 远程 workspace 下也不显示配置同步入口", async function () {
    this.timeout(10 * 60_000);
    const config = readSSHRuntimeConfig("MP-UI-05-remote");
    await connectSSHWorkspace({
      caseMarker: "MP-UI-05-remote",
      config,
      workspacePath: config.workspacePaths[0],
    });
    await openModelProviderSettings();

    await assertNoRemoteModelProviderSyncAction();
  });
});
