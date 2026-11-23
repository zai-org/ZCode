import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { disconnectRemoteSource } from "#e2e/helpers/remote-project-actions";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { clearAppData, readSettings, seedSettings } from "#e2e/helpers/desktop-app";
import { waitForRendererAfterColdRestart } from "#e2e/helpers/ssh-remote-lifecycle";
import {
  connectSSHWorkspace,
  openSSHSourceDirectory,
  readHostProcesses,
  readSSHRuntimeConfig,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_RDUX_14_DEVICE_ONLINE_RESTORES_STALE_TABS";
const STALE_AGE_MS = 20 * 24 * 60 * 60_000;
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/rdux-14-device-online-restores-stale-tabs",
);

describe(`${CASE_MARKER}: 设备上线后挂回不再按工作区年龄过滤`, () => {
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "rdux-14.json"), JSON.stringify(facts, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  // 新版只恢复活动 B；直接设置权威活动字段的年龄，不能只修改旧兼容投影。
  it("RDUX-14 活动目录早于 7 天仍自动恢复，其他项目按需打开", async function () {
    this.timeout(25 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const [workspaceA, workspaceB] = config.workspacePaths;
    await prepareV4ConversationE2E({ skipProvider: true });

    const tabA = await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config,
      workspacePath: workspaceA,
    });
    await openSSHSourceDirectory(config, CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(workspaceB, CASE_MARKER);
    const tabB = await waitForRemoteTab({ caseMarker: CASE_MARKER, expectedPath: workspaceB });
    const sourceId = parseRemoteWorkspaceIdentity(tabA.workspaceIdentity!)?.sourceServerId ?? "";
    expect(sourceId).toBeTruthy();
    await disconnectRemoteSource(sourceId, CASE_MARKER, {
      workspaceIdentities: [tabA.workspaceIdentity!, tabB.workspaceIdentity!],
    });

    // 真实 UI 断开并落盘后再退出，把 B 的 lastOpenedAt 改到 20 天前。
    // Host/Renderer 恢复均不应因工作区年龄把 B 留在未连接。
    // 重启 helper 先用 CDP 读取 profile 并刷盘，再结束旧进程；不能预先 quit，
    // 否则在构造过期工作区前就断开测试桥。退出屏障内播种也避免 Host 覆盖测试设置。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        const before = await readSettings();
        const lastWorkspaceSession = (before.lastWorkspaceSession ?? []).map((entry) =>
          entry.kind === "remote" && entry.workspacePath === workspaceB
            ? { ...entry, lastOpenedAt: Date.now() - STALE_AGE_MS }
            : entry,
        );
        expect(
          lastWorkspaceSession.some(
            (entry) =>
              entry.kind === "remote" &&
              entry.workspacePath === workspaceB &&
              entry.lastOpenedAt < Date.now() - 7 * 24 * 60 * 60_000,
          ),
        ).toBe(true);
        const active = before.lastActiveWorkspace;
        if (active?.kind !== "remote" || active.workspacePath !== workspaceB)
          throw new Error("缺少活动远程目录 B");
        const lastActiveWorkspace = { ...active, lastOpenedAt: Date.now() - STALE_AGE_MS };
        await seedSettings({ lastWorkspaceSession, lastActiveWorkspace });
        facts.activeSeeded = lastActiveWorkspace;
        facts.seeded = lastWorkspaceSession;
      },
    });
    await waitForRendererAfterColdRestart(CASE_MARKER);

    const restoredB = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: tabB.workspaceIdentity!,
      expectedPath: workspaceB,
      requireActive: false,
    });
    // B 的自动恢复已完成，A 的后续打开不能冒充自动恢复证据。
    await openWorkspaceDraftFromSidebar(workspaceA);
    const restoredA = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: tabA.workspaceIdentity!,
      expectedPath: workspaceA,
      requireActive: false,
    });
    facts.restored = { restoredA, restoredB };
    expect(restoredA.remoteSessionId).not.toBe(tabA.remoteSessionId);
    expect(restoredB.remoteSessionId).not.toBe(tabB.remoteSessionId);
    expect(await readHostProcesses()).toHaveLength(1);
  });
});
