import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readConnectRemoteFailures } from "#e2e/helpers/connect-remote-error-log";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import {
  installAndStartRemoteDaemon,
  isRemotePidAlive,
  isRemoteSystemdTarget,
  killRemoteDaemon,
  pointStaleDaemonFilesAt,
  readRemoteDaemonFiles,
  readRemoteProcessIdentity,
  spawnPidReuseHolder,
  type RemoteAccount,
} from "#e2e/helpers/remote-restart-stale-daemon";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readSSHRuntimeConfig,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// R3-ISSUE-035（ZCT-2117253090228297728 等）的真实 SSH 验证（本机 Docker runner）：Supervisor 在写出第一份
// 状态前失败时，连接错误过去只有 "Timed out waiting for Server ready" / "exited before ready (code=1)"，
// 原因留在远端 journal 或被 stdio:ignore 丢掉，工单无从定位。修复后错误必须带出 Supervisor 的失败摘要；
// OS service 启动方式（run-local-docker.mjs --systemd）还要带出 unit 状态。
// 注入方式：结束原 daemon，残留锁改指向一个同用户存活、身份一致但不应答 control 的进程，快照指向已死 PID，
// 新 Supervisor 取锁时报 "Another ZCode Server instance is already running"。不结束该进程。
const MARKER = "E2E_SSH_REMOTE_SUPERVISOR_LOCK_FAILURE";
const DEV: RemoteAccount = { user: "dev", home: "/home/dev" };
// 远高于容器内实际分配的 PID，保证快照里的 Core PID 已不存在，probe 直接执行 serve --daemon。
const DEAD_PID = 4_000_000;
const desktopRoot = process.cwd();
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-remote-supervisor-lock-failure",
);

describe(`${MARKER}: Supervisor 写状态前失败时连接错误带出原因`, () => {
  const facts: Record<string, unknown> = {};
  let container: string | undefined;
  let holderPid: number | undefined;

  after(async () => {
    // 结束持锁进程，残留锁随之成为 stale，同一容器的后续用例可以正常启动 daemon。
    if (container && holderPid) {
      await execInRemoteContainer(container, ["kill", "-9", String(holderPid)], {
        user: "0",
      }).catch(() => undefined);
    }
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "ssh-remote-supervisor-lock-failure.json"),
      JSON.stringify(facts, null, 2),
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("残留锁被不应答 control 的存活进程持有时，连接失败信息包含 Supervisor 的取锁失败原因", async function () {
    this.timeout(10 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    container = readRemoteDockerContainer(MARKER);
    const serviceMode = await isRemoteSystemdTarget(container);
    facts.serviceMode = serviceMode;
    const appVersion = (
      JSON.parse(readFileSync(resolve(desktopRoot, "../../package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    await prepareV4ConversationE2E({ skipProvider: true });

    await installAndStartRemoteDaemon(container, DEV, { desktopRoot, appVersion });
    await killRemoteDaemon(container, DEV);
    holderPid = await spawnPidReuseHolder(container, DEV);
    const holderIdentity = await readRemoteProcessIdentity(container, DEV, holderPid);
    await pointStaleDaemonFilesAt(container, DEV, {
      lockPid: holderPid,
      lockIdentity: holderIdentity,
      statusPid: DEAD_PID,
    });
    facts.holderPid = holderPid;
    facts.staleFiles = await readRemoteDaemonFiles(container, DEV);

    await openSSHRemoteDialog(MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(MARKER);
    let connectError: unknown;
    try {
      facts.flow = await waitForSSHDirectoryStep(MARKER);
    } catch (error) {
      connectError = error;
      facts.connectError = error instanceof Error ? error.message : String(error);
    }
    const failure = (await readConnectRemoteFailures()).at(-1);
    const rawError = failure?.message ?? "";
    facts.failure = failure;
    facts.remoteFiles = await readRemoteDaemonFiles(container, DEV);
    facts.holderAliveAfterConnect = await isRemotePidAlive(container, DEV, holderPid);

    // 锁被身份一致的存活进程持有，连接必须失败；原首句保留，括号内带出 Supervisor 的取锁失败摘要。
    expect(connectError).toBeDefined();
    expect(rawError).toContain("supervisor: Another ZCode Server instance is already running");
    if (serviceMode) {
      // OS service：每个新 Supervisor 都在取锁时退出，systemd 按 Restart=on-failure 重启直至放弃，CLI 等满预算。
      expect(rawError).toMatch(/^Timed out waiting for Server ready \(/);
      expect(rawError).toMatch(/service: ActiveState=\S+ SubState=\S+ Result=\S+/);
      expect(failure?.code).toBe("remote-connection-timeout");
    } else {
      // detached fallback：CLI fork 的 Supervisor 早退，原来的 "; check …status.json" 由失败摘要替代。
      expect(rawError).toMatch(
        /^ZCode Server daemon exited before ready \(code=1 signal=none\) \(/,
      );
      expect(rawError).not.toContain("service:");
      expect(failure?.code).toBe("remote-connection-unknown");
    }
    // 详情只用于展示：不结束持锁进程，也不改写它持有的锁。
    expect(facts.holderAliveAfterConnect).toBe(true);
    expect((facts.remoteFiles as { lock?: { pid?: number } }).lock?.pid).toBe(holderPid);
  });
});
