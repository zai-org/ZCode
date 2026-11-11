import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { TID_DOCKER_CONTAINER_INPUT, TID_REMOTE_KIND_DOCKER } from "@zcode/shared/test-ids";
import { readLastConnectRemoteError } from "#e2e/helpers/connect-remote-error-log";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
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
  openRemoteProjectSelection,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// 3.16.2 远端回归 R7（#13）的真实 Docker transport 验证（本机 Docker runner）：容器重启后
// server.lock 残留，锁里的 PID 被同用户的其他进程复用，快照里的 Core PID 已不存在。
// probe 判定未就绪，Desktop 执行 serve --daemon；新 Supervisor 必须按进程身份把残留锁判为
// stale 并接管，不能报 "daemon exited before ready (code=1)"，且不碰占用旧 PID 的进程。
const MARKER = "E2E_REMOTE_RESTART_STALE_LOCK_DOCKER";
// Desktop 的 Docker transport 以容器默认用户执行，本镜像为 root。
const ROOT: RemoteAccount = { user: "root", home: "/root" };
// 远高于容器内实际分配的 PID，保证快照里的 Core PID 已不存在。
const DEAD_PID = 4_000_000;
const desktopRoot = process.cwd();
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-restart-stale-lock-docker",
);

describe(`${MARKER}: 容器重启后接管残留锁`, () => {
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "restart-stale-lock-docker.json"),
      JSON.stringify(facts, null, 2),
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R7 锁的 PID 被复用时，Docker 连接的 serve --daemon 接管残留锁", async function () {
    this.timeout(15 * 60_000);
    const container = readRemoteDockerContainer(MARKER);
    const appVersion = (
      JSON.parse(readFileSync(resolve(desktopRoot, "../../package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    await prepareV4ConversationE2E({ skipProvider: true });

    await installAndStartRemoteDaemon(container, ROOT, { desktopRoot, appVersion });
    const beforeRestart = await readRemoteDaemonFiles(container, ROOT);
    facts.beforeRestart = beforeRestart;
    expect(beforeRestart.status).toMatchObject({ state: "ready" });

    await restartRemoteContainer(container);
    const holderPid = await spawnPidReuseHolder(container, ROOT);
    await pointStaleDaemonFilesAt(container, ROOT, { lockPid: holderPid, statusPid: DEAD_PID });
    const staleFiles = await readRemoteDaemonFiles(container, ROOT);
    facts.holderPid = holderPid;
    facts.staleFiles = staleFiles;
    expect(staleFiles.lock).toMatchObject({ pid: holderPid });
    expect(await isRemotePidAlive(container, ROOT, DEAD_PID)).toBe(false);

    await openRemoteProjectSelection();
    await clickTestIdByDom(TID_REMOTE_KIND_DOCKER, {
      timeout: 30_000,
      timeoutMsg: `${MARKER}: 无法选择 Docker transport`,
    });
    const input = $(`[data-testid="${TID_DOCKER_CONTAINER_INPUT}"]`);
    await input.waitForDisplayed({ timeout: 30_000 });
    await input.setValue(container);
    await clickLastEnabledSSHDialogButton(MARKER);
    let connectError: unknown;
    try {
      facts.flow = await waitForSSHDirectoryStep(MARKER);
    } catch (error) {
      connectError = error;
      facts.connectError = error instanceof Error ? error.message : String(error);
      facts.rawError = await readLastConnectRemoteError();
    }
    const afterConnect = await readRemoteDaemonFiles(container, ROOT);
    facts.afterConnect = afterConnect;
    facts.holderAliveAfterConnect = await isRemotePidAlive(container, ROOT, holderPid);
    if (connectError) throw connectError;

    expect(facts.flow).toBe("directory");
    expect(afterConnect.lock?.pid).not.toBe(holderPid);
    expect(typeof afterConnect.lock?.processIdentity).toBe("string");
    expect(await isRemotePidAlive(container, ROOT, afterConnect.lock?.pid as number)).toBe(true);
    expect(afterConnect.status).toMatchObject({ state: "ready" });
    expect(facts.holderAliveAfterConnect).toBe(true);
  });
});
