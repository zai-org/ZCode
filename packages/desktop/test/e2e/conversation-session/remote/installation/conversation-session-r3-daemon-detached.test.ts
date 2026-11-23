import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";
import {
  disconnectRemoteSource,
  reconnectRemoteProject,
} from "#e2e/helpers/remote-project-actions";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  readRemoteCoreIdentity,
  readTaskRowInProject,
  sendSSHFollowTurn,
  terminateRemoteProcess,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  readHostProcesses,
  readRemoteTabSnapshot,
  runSSHCommand,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_R3_DAEMON_DETACHED";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-daemon-detached",
);

describe(`${CASE_MARKER}: 无 user service manager 目标的 daemon 生命周期`, () => {
  let provider: SSHLifecycleProvider | null = null;
  let restoreRemoteEnvironment: (() => Promise<void>) | undefined;

  after(async () => {
    await restoreRemoteEnvironment?.();
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-BLD-07 detached daemon：断开不杀 daemon，离线探测被跳过时重连仍能拉起", async function () {
    this.timeout(30 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER);
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    const facts: Record<string, unknown> = {};

    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const core0 = await readRemoteCoreIdentity(prepared.config, CASE_MARKER);
    const status0 = JSON.parse(
      (await runSSHCommand(prepared.config, 'cat "$HOME/.zcode/server/run/status.json"')).stdout,
    ) as { serviceRegistered: boolean; state: string };
    // 容器没有 systemd user manager：只能是 detached daemon，且不得伪装成已注册服务。
    expect(status0.serviceRegistered).toBe(false);
    expect(status0.state).toBe("ready");
    const systemd = await runSSHCommand(
      prepared.config,
      'command -v systemctl >/dev/null 2>&1 && systemctl --user is-system-running 2>&1 || echo "no-user-manager"',
    );
    facts.remoteUserManager = systemd.stdout.trim();
    facts.core0 = core0;

    // 1. 桌面普通断开：Core 与 Supervisor 必须存活（普通断开不杀 daemon）。
    const sourceId = parseRemoteWorkspaceIdentity(taskA.identity)?.sourceServerId;
    expect(sourceId).toBeTruthy();
    await selectTaskOrganizeMode(["项目", "Project"]);

    await disconnectRemoteSource(sourceId!, CASE_MARKER, { workspaceIdentities: [taskA.identity] });

    await browser.pause(3000);
    const coreAfterDisconnect = await readRemoteCoreIdentity(prepared.config, CASE_MARKER);
    expect(coreAfterDisconnect.pid).toBe(core0.pid);
    expect(coreAfterDisconnect.startTicks).toBe(core0.startTicks);
    expect(coreAfterDisconnect.supervisorPid).toBe(core0.supervisorPid);
    facts.coreAfterDisconnect = coreAfterDisconnect;

    // 2. 模拟环境重启后 daemon 不存在：先 SIGKILL Supervisor（避免其重启 Core），再终止 Core。
    const supervisorStart = await runSSHCommand(
      prepared.config,
      `awk '{print $22}' /proc/${core0.supervisorPid}/stat`,
    );
    await terminateRemoteProcess(
      prepared.config,
      { pid: core0.supervisorPid, startTicks: Number.parseInt(supervisorStart.stdout.trim(), 10) },
      CASE_MARKER,
    );
    const coreStillThere = await runSSHCommand(
      prepared.config,
      `awk '{print $22}' /proc/${core0.pid}/stat 2>/dev/null || echo gone`,
    );
    if (coreStillThere.stdout.trim() === String(core0.startTicks)) {
      await terminateRemoteProcess(prepared.config, core0, CASE_MARKER);
    }
    const daemonGone = await runSSHCommand(
      prepared.config,
      // pgrep -f 会匹配到承载模式串的 shell 自身；用 glob 括号切断字面匹配。
      'r=gone; for d in /proc/[0-9]*; do c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue; case "$c" in *runtime/server-cor[e].js*|*"serve --superviso"[r]*) r=alive;; esac; done; echo $r',
    );
    expect(daemonGone.stdout.trim()).toBe("gone");
    facts.daemonAfterKill = daemonGone.stdout.trim();

    // Bug 原因：systemd offline 会跳过探测并返回 0；旧代码误判可用，在 enable --now 报 user bus 错误。
    // 在独立 SSH 目标的非交互 shell 注入真实 offline 环境，不替换 systemctl 或伪造探测结果。
    const fixtureRoot = `'${`${workspaceA}/.zcode-e2e/${CASE_MARKER}`.replaceAll("'", "'\\''")}'`;
    const backup = `${fixtureRoot}/bashrc.original`;
    const setup = await runSSHCommand(
      prepared.config,
      `mkdir -p ${fixtureRoot} && test ! -e ${backup} && cp -p "$HOME/.bashrc" ${backup}`,
    );
    expect(setup.code).toBe(0);
    restoreRemoteEnvironment = async () => {
      const restored = await runSSHCommand(prepared.config, `mv ${backup} "$HOME/.bashrc"`);
      expect(restored.code).toBe(0);
    };
    const configured = await runSSHCommand(
      prepared.config,
      `{ printf '%s\\n' 'export SYSTEMD_OFFLINE=1'; cat ${backup}; } > ${fixtureRoot}/bashrc.offline && mv ${fixtureRoot}/bashrc.offline "$HOME/.bashrc"`,
    );
    expect(configured.code).toBe(0);
    const skippedProbe = await runSSHCommand(
      prepared.config,
      'test "$SYSTEMD_OFFLINE" = 1 && test "${ZCODE_SERVER_SKIP_SERVICE_REGISTRATION-}" != 1 && systemctl --user show --property=Version',
    );
    expect(skippedProbe.code).toBe(0);
    expect(skippedProbe.stdout.trim()).toBe("");
    facts.skippedProbe = skippedProbe;

    // 3. 用户点击重连：ensureDaemon 必须拉起全新 Supervisor/Core 并恢复 workspace。
    // 用户显式断开的是设备，恢复入口是设备行的"重连"按钮（与冷恢复 case 的合同一致）。
    await reconnectRemoteProject(taskA.identity, CASE_MARKER);
    // 设备重连后 active tab 是设备 conversation；项目 A 以非 active 方式恢复。
    const reconnected = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
      requireActive: false,
    });
    expect(reconnected.remoteSessionId).not.toBe(taskA.remoteSessionId);
    const core1 = await readRemoteCoreIdentity(prepared.config, CASE_MARKER);
    expect(core1.pid).not.toBe(core0.pid);
    expect(core1.supervisorPid).not.toBe(core0.supervisorPid);
    expect(core1.state).toBe("ready");
    const status1 = JSON.parse(
      (await runSSHCommand(prepared.config, 'cat "$HOME/.zcode/server/run/status.json"')).stdout,
    ) as { serviceRegistered: boolean };
    expect(status1.serviceRegistered).toBe(false);
    facts.core1 = core1;
    expect(await readHostProcesses()).toEqual(prepared.initialHosts);

    const resumed: SSHLifecycleTask = { ...taskA, remoteSessionId: reconnected.remoteSessionId! };
    await readTaskRowInProject(resumed, CASE_MARKER);
    await sendSSHFollowTurn(resumed, CASE_MARKER);
    expect((await readRemoteTabSnapshot(taskA.identity)).secretPersistedInTab).toBe(false);

    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "daemon-detached.json"), JSON.stringify(facts, null, 2));
  });
});
