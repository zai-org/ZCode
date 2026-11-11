import { reconnectRemoteProject } from "#e2e/helpers/remote-project-actions";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  listRemoteZCodeServerPids,
  prepareSSHLifecycle,
  readTaskRowInProject,
  sendSSHFollowTurn,
  stopOwnedSSHServer,
  waitForRemoteWorkspaceFaultSettled,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  readHostProcesses,
  readRemoteTabSnapshot,
  runSSHCommand,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_SSH_P0_SERVER_FAULT";

describe(`${CASE_MARKER}: SSH zcode-server fault and grouped reconnect`, () => {
  let provider: SSHLifecycleProvider | null = null;

  after(async () => {
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-P0-LIFE-02 只终止本 case 新建的 zcode-server 后，重连 A 恢复 A/B", async function () {
    this.timeout(35 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER);
    provider = prepared.provider;
    const [workspaceA, workspaceB] = prepared.config.workspacePaths;
    const serverPidsBefore = await listRemoteZCodeServerPids(prepared.config);
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const taskB = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "B",
      provider,
      workspacePath: workspaceB,
    });
    const hostBeforeFault = await readHostProcesses();
    expect(await listRemoteZCodeServerPids(prepared.config)).toEqual(
      expect.arrayContaining(serverPidsBefore),
    );

    // 故障注入前先记下两个 tab 的 sessionId：只有和超时时的值对比，才能区分
    // "产品没检测到远端 server 挂了"和"产品已经自愈重连（换了新 session）"。
    const sessionsBeforeFault = {
      A: (await readRemoteTabSnapshot(taskA.identity).catch(() => null))?.remoteSessionId ?? null,
      B: (await readRemoteTabSnapshot(taskB.identity).catch(() => null))?.remoteSessionId ?? null,
    };
    await stopOwnedSSHServer(prepared.config, serverPidsBefore, CASE_MARKER);
    const faultContext = async () => ({
      sessionsBeforeFault,
      remoteServerPids: await listRemoteZCodeServerPids(prepared.config).catch(
        () => "probe-failed",
      ),
      remoteServerStatus:
        (
          await runSSHCommand(
            prepared.config,
            'cat "$HOME/.zcode/server/run/status.json" 2>/dev/null | tr -d "\\n " | cut -c1-200',
          ).catch(() => null)
        )?.stdout.trim() ?? null,
    });
    const settledA = await waitForRemoteWorkspaceFaultSettled(
      taskA.identity,
      CASE_MARKER,
      sessionsBeforeFault.A,
      faultContext,
    );
    const settledB = await waitForRemoteWorkspaceFaultSettled(
      taskB.identity,
      CASE_MARKER,
      sessionsBeforeFault.B,
      faultContext,
    );

    // 自愈路径下 workspace 已经重新在线，侧栏没有"重连"入口；手动重连只适用于保留态。
    // 两条路径都要落到下面同一组断言：session 必须换新、宿主进程数不变、任务可续。
    const manuallyReconnected =
      settledA === "retained-disconnected" || settledB === "retained-disconnected";
    if (manuallyReconnected) {
      await reconnectRemoteProject(taskA.identity, CASE_MARKER);
    }
    const reconnectedA = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
      // "A 是活动 tab"只是手动重连的副作用；自愈路径下活动 tab 仍是最后打开的 B
      // （现场 activeWorkspaceIdentity 指向 workspace-b）。本 case 的验收点是两个 tab
      // 都恢复且 session 换新，不是谁在前台。
      requireActive: manuallyReconnected,
    });
    const reconnectedB = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskB.identity,
      expectedPath: workspaceB,
      requireActive: false,
    });
    expect(reconnectedA.remoteSessionId).not.toBe(taskA.remoteSessionId);
    expect(reconnectedB.remoteSessionId).not.toBe(taskB.remoteSessionId);
    expect(await readHostProcesses()).toEqual(hostBeforeFault);
    // 恢复后仍停留远程项目；下方按 task identity 验证 A/B，不能等待从未切换的本地项目。

    const resumedA: SSHLifecycleTask = {
      ...taskA,
      remoteSessionId: reconnectedA.remoteSessionId!,
    };
    const resumedB: SSHLifecycleTask = {
      ...taskB,
      remoteSessionId: reconnectedB.remoteSessionId!,
    };
    await readTaskRowInProject(resumedA, CASE_MARKER);
    await readTaskRowInProject(resumedB, CASE_MARKER);
    await sendSSHFollowTurn(resumedB, CASE_MARKER, taskA.firstPrompt);
    await sendSSHFollowTurn(resumedA, CASE_MARKER, taskB.firstPrompt);
    await readTaskRowInProject(resumedA, CASE_MARKER);
    await readTaskRowInProject(resumedB, CASE_MARKER);
  });
});
