import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readLastConnectRemoteError } from "#e2e/helpers/connect-remote-error-log";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import {
  installRemoteServerArchive,
  isRemotePidAlive,
  readRemoteDaemonFiles,
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

// 两台主机共享 home 时的真实 SSH 验证（本机 Docker runner --systemd）：同一容器里再注册一个 user service，
// 用独立的 user + PID 命名空间启动 Supervisor，模拟“另一台主机”——它看不到本机进程，会把本机活着的锁判为
// stale 并接管（Issue 04 的机制）。被接管的一方必须以 0 退出，服务管理器不重启它；以 1 退出时两边的
// Restart=on-failure 会轮流重启、互相接管，每轮都停掉 Core。
const MARKER = "E2E_REMOTE_SHARED_ROOT_PEER_HOST_SSH";
const DEV: RemoteAccount = { user: "dev", home: "/home/dev" };
const SERVER_ROOT = '"$HOME/.zcode/server"';
const SERVER_BIN = '"$HOME/.zcode/server/bin/zcode"';
const PEER_UNIT = "zcode-peer-host.service";
// 与产品 unit 相同的 ExecStart 和 Restart=on-failure，只多一层命名空间。unit 写进共享 home 的 ~/.config，
// 与真实共享 home 下另一台主机的 user manager 读到的位置相同。
const PEER_UNIT_CONTENT = [
  "[Unit]",
  "Description=ZCode Server on a peer host sharing this home",
  "[Service]",
  `ExecStart=/usr/bin/unshare --user --map-root-user --pid --fork --kill-child --mount-proc ${DEV.home}/.zcode/server/bin/zcode serve --supervisor --service-entry --server-root ${DEV.home}/.zcode/server`,
  "Restart=on-failure",
  "",
].join("\n");
// Core heartbeat 周期是 10 秒。被接管方在下一次 heartbeat 时发现锁换了 owner；以 1 退出的旧实现会被
// 立即重启并反过来接管，30 秒内至少再来回一轮。
const OBSERVE_MS = 30_000;
const desktopRoot = process.cwd();
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-shared-root-peer-host-ssh",
);

/** 以 dev 身份执行，带 user manager 的 bus，等同于 SSH 会话里的 systemctl --user。 */
async function devShell(container: string, script: string): Promise<string> {
  return (
    await execInRemoteContainer(
      container,
      ["env", `HOME=${DEV.home}`, "XDG_RUNTIME_DIR=/run/user/1000", "sh", "-c", script],
      { user: DEV.user },
    )
  ).stdout;
}

/** 按确切 unit 名读取；通配符只匹配 active 的 unit，读不到已退出的 inactive unit。 */
async function readUnit(container: string, unit: string): Promise<Record<string, string>> {
  const output = await devShell(
    container,
    `systemctl --user show '${unit}' -p Id -p ActiveState -p MainPID -p NRestarts -p Result -p ExecMainStatus -p ExecMainExitTimestampMonotonic`,
  );
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

async function readLockOwnerToken(container: string): Promise<unknown> {
  return (await readRemoteDaemonFiles(container, DEV)).lock?.ownerToken;
}

describe(`${MARKER}: 共享 home 的另一台主机接管锁后不互相重启`, () => {
  const facts: Record<string, unknown> = {};
  let container: string | undefined;

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "shared-root-peer-host-ssh.json"),
      JSON.stringify(facts, null, 2),
    );
    // 命名空间里的 Supervisor 是 PID 1，不处理 SIGTERM；直接 SIGKILL 收口，容器随后由 runner 删除。
    if (container) {
      await devShell(
        container,
        `systemctl --user kill -s KILL ${PEER_UNIT} 2>/dev/null; systemctl --user stop ${PEER_UNIT} 2>/dev/null; true`,
      ).catch(() => undefined);
    }
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("另一台主机接管锁：本机 Supervisor 以 0 退出不被重启，对方保持运行，SSH 连接上线", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    container = readRemoteDockerContainer(MARKER);
    const appVersion = (
      JSON.parse(readFileSync(resolve(desktopRoot, "../../package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    await prepareV4ConversationE2E({ skipProvider: true });

    // 前提：E-SVC 目标，本机 daemon 由 OS 用户服务持有。
    await installRemoteServerArchive(container, DEV, { desktopRoot, appVersion });
    const served = JSON.parse(
      (
        await devShell(
          container,
          `${SERVER_BIN} serve --daemon --server-root ${SERVER_ROOT} --json`,
        )
      )
        .trim()
        .split("\n")
        .at(-1) ?? "{}",
    ) as Record<string, unknown>;
    const before = await readRemoteDaemonFiles(container, DEV);
    const localBefore = await readUnit(container, "com.zhipu.zcode.server.*.service");
    const localUnit = localBefore.Id ?? "";
    facts.before = { served, files: before, localUnit: localBefore };
    expect(served).toMatchObject({ state: "ready", serviceRegistered: true });
    expect(localBefore.ActiveState).toBe("active");
    expect(localUnit).toMatch(/^com\.zhipu\.zcode\.server\..+\.service$/);
    const localSupervisorPid = Number(localBefore.MainPID);
    const localCorePid = before.status?.pid as number;
    expect(await isRemotePidAlive(container, DEV, localCorePid)).toBe(true);

    // 触发：另一台主机的 user manager 启动同一 server root 的服务，接管本机活着的锁。
    await devShell(
      container,
      [
        "set -eu",
        "mkdir -p ~/.config/systemd/user",
        `cat > ~/.config/systemd/user/${PEER_UNIT} <<'EOF'\n${PEER_UNIT_CONTENT}EOF`,
        "systemctl --user daemon-reload",
        `systemctl --user start ${PEER_UNIT}`,
      ].join("\n"),
    );
    const takeoverDeadline = Date.now() + 15_000;
    let peerOwnerToken = await readLockOwnerToken(container);
    while (peerOwnerToken === before.lock?.ownerToken && Date.now() < takeoverDeadline) {
      await new Promise<void>((done) => setTimeout(done, 200));
      peerOwnerToken = await readLockOwnerToken(container);
    }
    facts.takeover = { peerOwnerToken, peerUnit: await readUnit(container, PEER_UNIT) };
    expect(peerOwnerToken).toBeDefined();
    expect(peerOwnerToken).not.toBe(before.lock?.ownerToken);

    await new Promise<void>((done) => setTimeout(done, OBSERVE_MS));
    const observed = {
      localUnit: await readUnit(container, localUnit),
      peerUnit: await readUnit(container, PEER_UNIT),
      lockOwnerToken: await readLockOwnerToken(container),
      localSupervisorAlive: await isRemotePidAlive(container, DEV, localSupervisorPid),
      localCoreAlive: await isRemotePidAlive(container, DEV, localCorePid),
      localStepDownLog: (
        await devShell(
          container,
          `journalctl --user -u '${localUnit}' --no-pager 2>/dev/null | grep 'data-root lock' | tail -n 1 || true`,
        )
      ).trim(),
    };
    facts.observed = observed;

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
    const afterConnect = {
      files: await readRemoteDaemonFiles(container, DEV),
      localUnit: await readUnit(container, localUnit),
      peerUnit: await readUnit(container, PEER_UNIT),
      tokenReadable: (
        await devShell(container, `test -s ${SERVER_ROOT}/run/ingress-token && echo yes || echo no`)
      ).trim(),
    };
    facts.afterConnect = afterConnect;

    // 被接管的本机 Supervisor 停掉 Core 后以 0 退出，服务管理器没有重启它。退出时间戳非 0 说明读到的是
    // 这次退出留下的状态，而不是 unit 重新装载后的默认值。
    expect(observed.localSupervisorAlive).toBe(false);
    expect(observed.localCoreAlive).toBe(false);
    expect(observed.localUnit).toMatchObject({
      ActiveState: "inactive",
      Result: "success",
      ExecMainStatus: "0",
      NRestarts: "0",
    });
    expect(Number(observed.localUnit.ExecMainExitTimestampMonotonic)).toBeGreaterThan(0);
    // 接管方一直持有锁，没有被反过来接管。
    expect(observed.peerUnit).toMatchObject({ ActiveState: "active", NRestarts: "0" });
    expect(observed.lockOwnerToken).toBe(peerOwnerToken);
    if (connectError) throw connectError;
    expect(facts.flow).toBe("directory");
    expect(afterConnect.files.lock?.ownerToken).toBe(peerOwnerToken);
    expect(afterConnect.files.status).toMatchObject({ state: "ready" });
    expect(afterConnect.peerUnit).toMatchObject({ ActiveState: "active", NRestarts: "0" });
    expect(afterConnect.tokenReadable).toBe("yes");
  });
});
