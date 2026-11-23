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

// A4（ZCT-2112854001415753728）的真实 SSH 验证（本机 Docker runner --systemd）：daemon 以 OS 用户服务运行时
// 删除 ~/.zcode/server 再重装。旧 Supervisor 的锁、control socket 与 ingress-token 随旧目录消失；
// 它不能再把 ready 与旧端口写进新 root。连接必须拉起新的 Supervisor 并读到 token，不能报 `cat: …ingress-token`。
const MARKER = "E2E_REMOTE_SERVER_ROOT_REPLACED_SSH";
const DEV: RemoteAccount = { user: "dev", home: "/home/dev" };
const SERVER_ROOT = '"$HOME/.zcode/server"';
const SERVER_BIN = '"$HOME/.zcode/server/bin/zcode"';
// Core heartbeat 周期是 10 秒；等 1.5 个周期，旧实现此时已把旧快照写进新 root。
const AFTER_HEARTBEAT_MS = 15_000;
const desktopRoot = process.cwd();
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-server-root-replaced-ssh",
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

/** 当前 server root 的 unit 状态；unit 名与注册时相同（按 root 路径哈希，重装后不变）。 */
async function readUnit(container: string): Promise<Record<string, string>> {
  const output = await devShell(
    container,
    "systemctl --user show 'com.zhipu.zcode.server.*.service' -p Id -p ActiveState -p MainPID -p NRestarts",
  );
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

async function readRunEntries(container: string): Promise<string[]> {
  return (await devShell(container, `ls -A ${SERVER_ROOT}/run 2>/dev/null || true`))
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
}

describe(`${MARKER}: server root 被删除并重装后重连`, () => {
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "server-root-replaced-ssh.json"),
      JSON.stringify(facts, null, 2),
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("A4 OS 服务运行中删除并重装 server root：旧 Supervisor 退出，连接拉起新实例并上线", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    const container = readRemoteDockerContainer(MARKER);
    const appVersion = (
      JSON.parse(readFileSync(resolve(desktopRoot, "../../package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    await prepareV4ConversationE2E({ skipProvider: true });

    // 前提：E-SVC 目标，daemon 由 OS 用户服务持有，否则场景退化成 detached。
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
    const unitBefore = await readUnit(container);
    facts.before = { served, files: before, unit: unitBefore };
    expect(served).toMatchObject({ state: "ready", serviceRegistered: true });
    expect(unitBefore.ActiveState).toBe("active");
    const oldSupervisorPid = Number(unitBefore.MainPID);
    const oldCorePid = before.status?.pid as number;
    expect(oldSupervisorPid).toBeGreaterThan(0);
    expect(await isRemotePidAlive(container, DEV, oldCorePid)).toBe(true);

    // 触发：daemon 运行中删除 server root，再按同一 archive 重装（重装会建出空的 run/），不启动 daemon。
    await devShell(container, `rm -rf ${SERVER_ROOT}`);
    await installRemoteServerArchive(container, DEV, { desktopRoot, appVersion });
    await new Promise<void>((done) => setTimeout(done, AFTER_HEARTBEAT_MS));
    const replaced = {
      runEntries: await readRunEntries(container),
      files: await readRemoteDaemonFiles(container, DEV),
      unit: await readUnit(container),
      oldSupervisorAlive: await isRemotePidAlive(container, DEV, oldSupervisorPid),
      oldCoreAlive: await isRemotePidAlive(container, DEV, oldCorePid),
    };
    facts.replaced = replaced;

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
      runEntries: await readRunEntries(container),
      files: await readRemoteDaemonFiles(container, DEV),
      unit: await readUnit(container),
      tokenReadable: (
        await devShell(container, `test -s ${SERVER_ROOT}/run/ingress-token && echo yes || echo no`)
      ).trim(),
    };
    facts.afterConnect = afterConnect;
    if (connectError) throw connectError;

    expect(facts.flow).toBe("directory");
    // 失去 server root 的旧 Supervisor 与旧 Core 已退出，没有把旧快照写进新 root。
    expect(replaced.oldSupervisorAlive).toBe(false);
    expect(replaced.oldCoreAlive).toBe(false);
    expect(replaced.files.status?.pid ?? null).not.toBe(oldCorePid);
    // 连接拉起的是新的 OS service 实例：锁、token、快照属于同一个新 daemon。
    expect(afterConnect.unit.ActiveState).toBe("active");
    expect(Number(afterConnect.unit.MainPID)).not.toBe(oldSupervisorPid);
    expect(afterConnect.files.lock?.pid).toBe(Number(afterConnect.unit.MainPID));
    expect(afterConnect.files.status).toMatchObject({ state: "ready", serviceRegistered: true });
    expect(afterConnect.files.status?.pid).not.toBe(oldCorePid);
    expect(await isRemotePidAlive(container, DEV, afterConnect.files.status?.pid as number)).toBe(
      true,
    );
    expect(afterConnect.tokenReadable).toBe("yes");
  });
});
