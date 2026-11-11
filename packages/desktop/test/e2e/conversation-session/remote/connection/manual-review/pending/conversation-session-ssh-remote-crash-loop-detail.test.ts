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
  driveRemoteCrashLoop,
  installAndStartRemoteDaemon,
  isRemoteSystemdTarget,
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

// R3-ISSUE-031 / R3-ISSUE-035 的真实 SSH 验证（本机 Docker runner）：Core 在 ready 后被连续结束，Supervisor 耗尽
// 崩溃预算进入 crash-loop-stopped，仍持有锁与 control。serve --daemon 不复用它，新 Supervisor 取锁失败；
// 状态快照早于本次启动，过去的错误只有原首句。修复后错误必须带出 control 报告的现有 Supervisor 状态。
// 自动恢复是否应停止、UI 如何映射仍按 R3-ISSUE-031 待产品决策，本用例只断言失败信息。
const MARKER = "E2E_SSH_REMOTE_CRASH_LOOP_DETAIL";
const DEV: RemoteAccount = { user: "dev", home: "/home/dev" };
const desktopRoot = process.cwd();
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-remote-crash-loop-detail",
);

describe(`${MARKER}: crash-loop-stopped 时连接错误带出现有 Supervisor 状态`, () => {
  const facts: Record<string, unknown> = {};
  let container: string | undefined;

  after(async () => {
    // 停掉 crash-loop-stopped 的 Supervisor 并释放锁，同一容器的后续用例可以正常启动 daemon。
    if (container) {
      await execInRemoteContainer(
        container,
        [
          "env",
          `HOME=${DEV.home}`,
          "sh",
          "-c",
          '"$HOME/.zcode/server/bin/zcode" stop --wait --server-root "$HOME/.zcode/server" --json',
        ],
        { user: DEV.user },
      ).catch(() => undefined);
    }
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "ssh-remote-crash-loop-detail.json"),
      JSON.stringify(facts, null, 2),
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("现有 Supervisor 处于 crash-loop-stopped 时，连接失败信息包含它的状态", async function () {
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
    const crashLoop = await driveRemoteCrashLoop(container, DEV);
    facts.crashLoopStatus = crashLoop;
    expect(crashLoop).toMatchObject({ state: "crash-loop-stopped", pid: null });

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

    expect(connectError).toBeDefined();
    expect(rawError).toContain(
      "running supervisor: state=crash-loop-stopped, last exit: core exited",
    );
    // 新 Supervisor 被 crash-loop-stopped 的实例挡在锁外，取锁失败摘要一并带出。
    expect(rawError).toContain("supervisor: Another ZCode Server instance is already running");
    if (serviceMode) {
      expect(rawError).toMatch(/^Timed out waiting for Server ready \(/);
      expect(failure?.code).toBe("remote-connection-timeout");
    } else {
      expect(rawError).toMatch(
        /^ZCode Server daemon exited before ready \(code=1 signal=none\) \(/,
      );
      expect(failure?.code).toBe("remote-connection-unknown");
    }
    // 只增加诊断详情：crash-loop-stopped 的实例保持原状，不被连接流程停止或替换。
    expect((facts.remoteFiles as { status?: { state?: string } }).status?.state).toBe(
      "crash-loop-stopped",
    );
  });
});
