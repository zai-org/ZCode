import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  disconnectRemoteSource,
  reconnectRemoteProject,
} from "#e2e/helpers/remote-project-actions";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { clearAppData, readSettings, seedSettings } from "#e2e/helpers/desktop-app";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  waitForRendererAfterColdRestart,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  readHostProcesses,
  readRemoteTabSnapshot,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_R3_RECOVERY_GUARDS";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-recovery-guards",
);
const EIGHT_DAYS_MS = 8 * 24 * 60 * 60_000;

async function disconnectDevice(sourceId: string, workspaceIdentity: string): Promise<void> {
  await disconnectRemoteSource(sourceId, CASE_MARKER, { workspaceIdentities: [workspaceIdentity] });
}

describe(`${CASE_MARKER}: 显式断开收口与旧 Source 冷启动恢复`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "recovery-guards.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-REC-02/05 用户显式断开后不重开且历史保留；Source 超过 7 天仍参加冷启动静默恢复、无未授权交互", async function () {
    this.timeout(25 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, { tunnelUsername: "tunnel" });
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const sourceId = parseRemoteWorkspaceIdentity(taskA.identity)?.sourceServerId;
    if (!sourceId) throw new Error(`${CASE_MARKER}: 缺少 Source 身份`);

    // REC-02：显式断开 → offline 收口；等待 30 秒确认没有自动重开（迟到快照不重开）；open history 保留。
    await disconnectDevice(sourceId, taskA.identity);
    await browser.pause(30_000);
    // 现行项目导航保留离线项目行，但不得自动建立新 attachment。
    const disconnectedState = await browser.execute(
      (groupKey, projectName) => {
        const group = document.querySelector<HTMLElement>(
          `[data-project-workspace-identity="${groupKey}"]`,
        );
        return {
          group: Boolean(group),
          projectVisible: (document.body?.innerText ?? "").includes(projectName),
          sourceStatus: group?.dataset.connectionState ?? null,
        };
      },
      taskA.identity,
      "r3-workspace-a",
    );
    const openEntryKeptAfterDisconnect =
      (await readSettings()).lastWorkspaceSession?.some(
        (entry) => entry.kind === "remote" && entry.workspacePath === workspaceA,
      ) ?? false;
    const afterDisconnect = await readRemoteTabSnapshot(taskA.identity).catch(() => null);
    facts.explicitDisconnect = {
      ...disconnectedState,
      openEntryKeptInSettings: openEntryKeptAfterDisconnect,
      remoteSessionId: afterDisconnect?.remoteSessionId ?? null,
    };
    expect(disconnectedState.group).toBe(true);
    expect(disconnectedState.projectVisible).toBe(true);
    expect(disconnectedState.sourceStatus).toBe("offline");
    expect(openEntryKeptAfterDisconnect).toBe(true);
    expect(afterDisconnect?.remoteSessionId ?? null).toBeNull();
    expect(await readHostProcesses()).toEqual(prepared.initialHosts);

    // REC-05：当前合同只按最近在线排序，不再按七天过滤。种子必须在旧进程退出后写入，
    // 避免正常退出的最后一次设置写回覆盖测试时间；后续必须真实静默恢复。
    const staleAt = Date.now() - EIGHT_DAYS_MS;
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        const settings = await readSettings();
        const servers = settings.sourceServers ?? [];
        expect(servers.some((server) => server.sourceServerId === sourceId)).toBe(true);
        await seedSettings({
          sourceServers: servers.map((server) =>
            server.sourceServerId === sourceId ? { ...server, lastOnlineAt: staleAt } : server,
          ),
        });
      },
    });
    await waitForRendererAfterColdRestart(CASE_MARKER);
    const afterCold = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
      requireActive: false,
      timeoutMs: 120_000,
    });
    const hasDialog = await browser.execute(() =>
      Boolean(document.querySelector('[role="dialog"], [role="alertdialog"]')),
    );
    // 冷启动后侧栏默认组织方式可能不是"项目"，先切到项目视图再读取 open history。
    const coldSidebar = await browser.execute(() => document.body?.innerText ?? "");
    const coldSettings = await readSettings();
    const openEntryKept =
      coldSettings.lastWorkspaceSession?.some(
        (entry) => entry.kind === "remote" && entry.workspacePath === workspaceA,
      ) ?? false;
    facts.staleColdStart = {
      staleAt,
      remoteSessionIdAfterCold: afterCold?.remoteSessionId ?? null,
      workspaceStillListed: coldSidebar.includes("r3-workspace-a"),
      openEntryKeptInSettings: openEntryKept,
      dialogShown: hasDialog,
      hostCount: (await readHostProcesses()).length,
    };
    expect(afterCold.remoteSessionId).toBeTruthy();
    expect(hasDialog).toBe(false);
    expect(openEntryKept).toBe(true);
    // 旧 Source 静默恢复后，项目入口和原历史仍应保留。
    facts.staleColdStartDeviceRowShown = coldSidebar.includes("r3-workspace-a");
    expect(facts.staleColdStartDeviceRowShown).toBe(true);
    expect((await readHostProcesses()).length).toBe(1);

    // 同一窗口主动断开仍是终止意图；用户再次操作后恢复原目录。
    await disconnectDevice(sourceId, taskA.identity);
    await reconnectRemoteProject(taskA.identity, CASE_MARKER);
    await browser.waitUntil(
      async () =>
        Boolean((await readRemoteTabSnapshot(taskA.identity).catch(() => null))?.remoteSessionId),
      { timeout: 120_000, interval: 1000, timeoutMsg: `${CASE_MARKER}: 用户点击重连后没有恢复` },
    );
    facts.manualRecoveryAfterGuard = true;
    const recoveredSidebar = await browser.execute(() => document.body?.innerText ?? "");
    facts.workspaceListedAfterManualRecovery = recoveredSidebar.includes("r3-workspace-a");
    facts.taskListedAfterManualRecovery = recoveredSidebar.includes(taskA.firstPrompt.slice(0, 30));
    expect(recoveredSidebar).toContain("r3-workspace-a");
  });
});
