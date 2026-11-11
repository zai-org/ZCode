import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { readLastConnectRemoteError } from "#e2e/helpers/connect-remote-error-log";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { readRemoteDockerContainer } from "#e2e/helpers/remote-docker-target";
import {
  installAndStartRemoteDaemon,
  isRemotePidAlive,
  pointStaleDaemonFilesAt,
  readRemoteDaemonFiles,
  restartRemoteContainer,
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

// 3.16.2 远端回归 R7（#14–#16）的真实 SSH 验证（本机 Docker runner）：远端环境重启后，
// status.json 残留 ready 快照，快照与 server.lock 里的 PID 都被同用户的其他进程复用。
// probe 据快照复用旧端口，握手失败后 Desktop 必须回退执行一次 serve --daemon；
// 新 Supervisor 必须按进程身份把残留锁判为 stale 并接管，连接成功，且不碰占用旧 PID 的进程。
const MARKER = "E2E_REMOTE_RESTART_STALE_DAEMON_SSH";
const DEV: RemoteAccount = { user: "dev", home: "/home/dev" };
const desktopRoot = process.cwd();
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-restart-stale-daemon-ssh",
);

describe(`${MARKER}: 远端重启后复用残留 ready 快照`, () => {
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "restart-stale-daemon-ssh.json"),
      JSON.stringify(facts, null, 2),
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R7 快照与锁的 PID 被复用时，SSH 连接回退 serve --daemon 并接管残留锁", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    const container = readRemoteDockerContainer(MARKER);
    const appVersion = (
      JSON.parse(readFileSync(resolve(desktopRoot, "../../package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    await prepareV4ConversationE2E({ skipProvider: true });

    await installAndStartRemoteDaemon(container, DEV, { desktopRoot, appVersion });
    const beforeRestart = await readRemoteDaemonFiles(container, DEV);
    facts.beforeRestart = beforeRestart;
    expect(beforeRestart.status).toMatchObject({ state: "ready" });

    await restartRemoteContainer(container);
    const holderPid = await spawnPidReuseHolder(container, DEV);
    await pointStaleDaemonFilesAt(container, DEV, { lockPid: holderPid, statusPid: holderPid });
    const staleFiles = await readRemoteDaemonFiles(container, DEV);
    facts.holderPid = holderPid;
    facts.staleFiles = staleFiles;
    // probe 的复用前提：快照 ready，快照里的 PID 存活。
    expect(staleFiles.status).toMatchObject({ state: "ready", pid: holderPid });
    expect(staleFiles.lock).toMatchObject({ pid: holderPid });

    await openSSHRemoteDialog(MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(MARKER);
    let connectError: unknown;
    try {
      facts.flow = await waitForSSHDirectoryStep(MARKER);
    } catch (error) {
      connectError = error;
      facts.connectError = error instanceof Error ? error.message : String(error);
      facts.rawError = await readLastConnectRemoteError();
    }
    const afterConnect = await readRemoteDaemonFiles(container, DEV);
    facts.afterConnect = afterConnect;
    facts.holderAliveAfterConnect = await isRemotePidAlive(container, DEV, holderPid);
    if (connectError) throw connectError;

    expect(facts.flow).toBe("directory");
    // 新 Supervisor 接管了残留锁：锁换成新 PID 并带进程身份，Core 换了新端口。
    expect(afterConnect.lock?.pid).not.toBe(holderPid);
    expect(typeof afterConnect.lock?.processIdentity).toBe("string");
    expect(await isRemotePidAlive(container, DEV, afterConnect.lock?.pid as number)).toBe(true);
    expect(afterConnect.status).toMatchObject({ state: "ready" });
    expect(afterConnect.status?.port).not.toBe(staleFiles.status?.port);
    // 占用旧 PID 的无关进程不能被误杀。
    expect(facts.holderAliveAfterConnect).toBe(true);
  });
});
