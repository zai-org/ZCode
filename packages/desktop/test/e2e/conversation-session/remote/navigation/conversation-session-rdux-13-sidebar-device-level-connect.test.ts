import { createStallableTcpProxy } from "#e2e/helpers/ssh-stallable-proxy";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { clearAppData, readSettings } from "#e2e/helpers/desktop-app";
import {
  disconnectRemoteSource,
  requestRemoteProjectConnection,
} from "#e2e/helpers/remote-project-actions";
import {
  connectSSHWorkspace,
  openSSHSourceDirectory,
  readSSHRuntimeConfig,
  readHostProcesses,
  selectSSHRemoteDirectory,
  waitForSSHDirectoryStep,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
const CASE_MARKER = "E2E_RDUX_13_SIDEBAR_DEVICE_CONNECT";

describe(`${CASE_MARKER}: 平铺项目入口重连同设备已打开项目`, () => {
  let proxy: Awaited<ReturnType<typeof createStallableTcpProxy>> | undefined;
  after(async () => {
    try {
      await browser.electron.restoreAllMocks();
      await clearAppData();
    } finally {
      await proxy?.close();
    }
  });
  it("RDUX-13/RPN-06 已有项目重连保持目录意图，重复点击只有一个向导，A/B 获得独立新 session", async function () {
    this.timeout(10 * 60_000);
    const direct = readSSHRuntimeConfig(CASE_MARKER);
    proxy = await createStallableTcpProxy(direct);
    const config = { ...direct, host: "127.0.0.1", port: proxy.port };
    await prepareV4ConversationE2E({ skipProvider: true });
    const hosts = await readHostProcesses();
    const [pathA, pathB] = config.workspacePaths;
    const a = await connectSSHWorkspace({ config, caseMarker: CASE_MARKER, workspacePath: pathA });
    await openSSHSourceDirectory(config, CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(pathB, CASE_MARKER);
    const b = await waitForRemoteTab({ caseMarker: CASE_MARKER, expectedPath: pathB });
    const sourceId = parseRemoteWorkspaceIdentity(a.workspaceIdentity!)?.sourceServerId;
    if (!sourceId) throw new Error("首连缺少 Source 身份");
    const before = await readSettings();
    await disconnectRemoteSource(sourceId, CASE_MARKER);
    const row = $(`[data-project-workspace-identity="${a.workspaceIdentity}"]`);
    await browser.waitUntil(
      async () =>
        ["offline", "failed"].includes((await row.getAttribute("data-connection-state")) ?? ""),
      { timeout: 30_000 },
    );
    // 标题现为折叠按钮；用真实项目连接动作重复请求，握手闸门保证第二次发生在 pending 期间。
    proxy.setStall(true);
    const connectionsBefore = proxy.acceptedCount();
    await requestRemoteProjectConnection(a.workspaceIdentity!, CASE_MARKER);
    await browser.waitUntil(() => proxy!.pendingCount() === 1, { timeout: 15_000 });
    await requestRemoteProjectConnection(a.workspaceIdentity!, CASE_MARKER);
    proxy.setStall(false);
    expect(proxy.release()).toBe(1);
    expect(await $$('[data-testid="ssh-dialog"]').length).toBeLessThanOrEqual(1);
    const phase = await waitForSSHDirectoryStep(CASE_MARKER);
    expect(phase).toBe("closed");
    const restoredA = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: a.workspaceIdentity!,
      expectedPath: pathA,
      // 现行项目导航 §2.2：恢复使目标项目就绪，不改变正在查看的 B 页面。
      requireActive: false,
    });
    const restoredB = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: b.workspaceIdentity!,
      expectedPath: pathB,
      requireActive: false,
    });
    expect(restoredA.remoteSessionId).not.toBe(a.remoteSessionId);
    expect(restoredB.remoteSessionId).not.toBe(b.remoteSessionId);
    expect(restoredA.remoteSessionId).not.toBe(restoredB.remoteSessionId);
    expect((await readSettings()).connectionProfiles?.length).toBe(
      before.connectionProfiles?.length,
    );
    expect(proxy.acceptedCount() - connectionsBefore).toBe(1);
    expect(await readHostProcesses()).toEqual(hosts);
  });
});
