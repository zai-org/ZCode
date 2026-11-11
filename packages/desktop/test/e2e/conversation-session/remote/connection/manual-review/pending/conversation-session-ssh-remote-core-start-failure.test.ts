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

// 3.16.2 远端超时工单的真实 SSH 验证（本机 Docker runner）：远端 Core 启动失败时，连接错误只有
// "Timed out waiting for Server ready" / "exited before ready"，Core 自己报告的原因被丢掉，工单
// 无从判断 Core 为什么起不来。修复后连接错误必须带出 Core 的 fatal 原因。
// 注入方式：预装 release 并停掉 daemon，再把 ~/.zcode/v2 换成 dev 不可写的目录，Core 启动时
// 物化内置 Provider 配置失败（EACCES）并退出。
const MARKER = "E2E_SSH_REMOTE_CORE_START_FAILURE";
const DEV: RemoteAccount = { user: "dev", home: "/home/dev" };
const CONFIG_ROOT = `${DEV.home}/.zcode/v2`;
const desktopRoot = process.cwd();
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-remote-core-start-failure",
);

async function runAsRoot(container: string, script: string): Promise<void> {
  await execInRemoteContainer(container, ["sh", "-c", script], { user: "0" });
}

describe(`${MARKER}: 远端 Core 启动失败时连接错误带出原因`, () => {
  const facts: Record<string, unknown> = {};
  let container: string | undefined;

  after(async () => {
    // 恢复配置根的属主，避免影响同一容器后续用例。
    if (container) {
      await runAsRoot(container, `chown -R ${DEV.user}:${DEV.user} ${CONFIG_ROOT}`).catch(
        () => undefined,
      );
    }
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "ssh-remote-core-start-failure.json"),
      JSON.stringify(facts, null, 2),
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Core 因配置根不可写退出时，连接失败信息包含 Core 的 EACCES 原因", async function () {
    this.timeout(10 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    container = readRemoteDockerContainer(MARKER);
    const appVersion = (
      JSON.parse(readFileSync(resolve(desktopRoot, "../../package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    await prepareV4ConversationE2E({ skipProvider: true });

    await installAndStartRemoteDaemon(container, DEV, { desktopRoot, appVersion });
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
    );
    await runAsRoot(
      container,
      `rm -rf ${CONFIG_ROOT} && mkdir -p ${CONFIG_ROOT} && chown root:root ${CONFIG_ROOT} && chmod 755 ${CONFIG_ROOT}`,
    );

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
    const rawError = failure?.message ?? null;
    facts.failure = failure;
    facts.remoteFiles = await readRemoteDaemonFiles(container, DEV);

    // 配置根不可写，连接必须失败；失败信息除了原有首句，还要带出 Core 报告的原因。
    expect(connectError).toBeDefined();
    expect(rawError ?? "").toMatch(
      /Timed out waiting for Server ready|ZCode Server daemon exited before ready/,
    );
    expect(rawError ?? "").toContain("last exit: core exited code=1");
    expect(rawError ?? "").toMatch(/EACCES|permission denied/i);
    // 追加的原因只用于展示：错误类别仍按原首句判定，不能因 permission denied 改报“没有远端写入权限”。
    expect(failure?.code).toBe(
      (rawError ?? "").startsWith("Timed out")
        ? "remote-connection-timeout"
        : "remote-connection-unknown",
    );
  });
});
