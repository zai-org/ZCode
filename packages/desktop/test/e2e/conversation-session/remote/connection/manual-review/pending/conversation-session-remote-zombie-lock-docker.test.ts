import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { TID_DOCKER_CONTAINER_INPUT, TID_REMOTE_KIND_DOCKER } from "@zcode/shared/test-ids";
import { readLastConnectRemoteError } from "#e2e/helpers/connect-remote-error-log";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import {
  installAndStartRemoteDaemon,
  isRemotePidAlive,
  killRemoteDaemon,
  pointStaleDaemonFilesAt,
  readRemoteDaemonFiles,
  readRemoteProcessIdentity,
  spawnZombieProcess,
  type RemoteAccount,
} from "#e2e/helpers/remote-restart-stale-daemon";
import {
  clickLastEnabledSSHDialogButton,
  openRemoteProjectSelection,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// R3-ISSUE-034（ZCT-2117275161536565248）的真实 Docker transport 验证（本机 Docker runner）：容器 PID 1
// 不回收子进程时，Supervisor 与 Core 非正常死亡后成为僵尸，/proc/<pid>/stat 仍在、starttime 不变。
// 残留锁指向僵尸 Supervisor（身份一致），ready 快照指向僵尸 Core，probe 的 kill -0 判定存活并复用旧端口；
// 握手失败后 Desktop 执行 serve --daemon，新 Supervisor 必须把僵尸锁判为 stale 并接管，进入目录选择，
// 不能报 "daemon exited before ready (code=1)"。runner 的 PID 1 是会回收子进程的 sshd，用例让不回收子进程的
// sleep 做僵尸的父进程，锁与快照的字段形状与真实僵尸 Supervisor/Core 相同。
const MARKER = "E2E_REMOTE_ZOMBIE_LOCK_DOCKER";
// Desktop 的 Docker transport 以容器默认用户执行，本镜像为 root。
const ROOT: RemoteAccount = { user: "root", home: "/root" };
const desktopRoot = process.cwd();
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-zombie-lock-docker",
);

async function readProcessState(container: string, pid: number): Promise<string> {
  return (
    await execInRemoteContainer(
      container,
      ["sh", "-c", `awk '{print $3}' /proc/${pid}/stat 2>/dev/null || echo gone`],
      { user: "0" },
    )
  ).stdout.trim();
}

describe(`${MARKER}: 僵尸持锁时 Docker 连接接管残留锁`, () => {
  const facts: Record<string, unknown> = {};
  let container: string | undefined;
  let zombiePid: number | undefined;

  after(async () => {
    // 结束僵尸的父进程，僵尸转交给 PID 1（sshd）回收，不留给同一容器的后续用例。
    if (container && zombiePid) {
      await execInRemoteContainer(
        container,
        ["sh", "-c", `kill -9 "$(awk '{print $4}' /proc/${zombiePid}/stat)" 2>/dev/null || true`],
        { user: "0" },
      ).catch(() => undefined);
    }
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "remote-zombie-lock-docker.json"),
      JSON.stringify(facts, null, 2),
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("锁的持有者与快照的 Core 都是僵尸时，serve --daemon 接管残留锁并进入目录选择", async function () {
    this.timeout(15 * 60_000);
    container = readRemoteDockerContainer(MARKER);
    const appVersion = (
      JSON.parse(readFileSync(resolve(desktopRoot, "../../package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    await prepareV4ConversationE2E({ skipProvider: true });

    await installAndStartRemoteDaemon(container, ROOT, { desktopRoot, appVersion });
    const beforeKill = await readRemoteDaemonFiles(container, ROOT);
    facts.beforeKill = beforeKill;
    expect(beforeKill.status).toMatchObject({ state: "ready" });

    await killRemoteDaemon(container, ROOT);
    zombiePid = await spawnZombieProcess(container, ROOT);
    const zombieIdentity = await readRemoteProcessIdentity(container, ROOT, zombiePid);
    await pointStaleDaemonFilesAt(container, ROOT, {
      lockPid: zombiePid,
      lockIdentity: zombieIdentity,
      statusPid: zombiePid,
    });
    const staleFiles = await readRemoteDaemonFiles(container, ROOT);
    facts.zombiePid = zombiePid;
    facts.zombieIdentity = zombieIdentity;
    facts.staleFiles = staleFiles;
    expect(await readProcessState(container, zombiePid)).toBe("Z");
    expect(staleFiles.lock).toMatchObject({ pid: zombiePid, processIdentity: zombieIdentity });
    expect(staleFiles.status).toMatchObject({ state: "ready", pid: zombiePid });
    // kill -0 对僵尸同样成功：probe 会复用快照里的旧端口，握手失败后才回退 serve --daemon。
    expect(await isRemotePidAlive(container, ROOT, zombiePid)).toBe(true);

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
    facts.zombieStateAfterConnect = await readProcessState(container, zombiePid);
    if (connectError) throw connectError;

    expect(facts.flow).toBe("directory");
    expect(afterConnect.lock?.pid).not.toBe(zombiePid);
    expect(typeof afterConnect.lock?.processIdentity).toBe("string");
    expect(await isRemotePidAlive(container, ROOT, afterConnect.lock?.pid as number)).toBe(true);
    expect(afterConnect.status).toMatchObject({ state: "ready" });
    expect(afterConnect.status?.pid).not.toBe(zombiePid);
    // 接管只换掉锁文件，不碰僵尸及其父进程。
    expect(facts.zombieStateAfterConnect).toBe("Z");
  });
});
