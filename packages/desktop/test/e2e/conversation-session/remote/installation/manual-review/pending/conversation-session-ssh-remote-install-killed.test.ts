import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { readLastConnectRemoteError } from "#e2e/helpers/connect-remote-error-log";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  readRemoteContainerFile,
  readRemoteDockerContainer,
  writeRemoteContainerFile,
} from "#e2e/helpers/remote-docker-target";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readSSHRuntimeConfig,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// 3.16.2 远端回归 R1 的真实 SSH 验证（本机 Docker runner）：远端安装命令被信号杀死时，
// SSH exec 必须报告失败退出码，Desktop 报安装失败；不能把信号退出记成 0，
// 再在下游报出误导性的 "Remote command returned no JSON result"。
const MARKER = "E2E_SSH_INSTALL_KILLED";
const KILLER_SCRIPT = "/home/dev/.e2e-install-killer.sh";
const KILLER_LOG = "/tmp/e2e-install-killer.log";
const NO_JSON_MESSAGE = "Remote command returned no JSON result";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-install-killed",
);
const execFileAsync = promisify(execFile);

describe(`${MARKER}: 远端安装命令被信号杀死`, () => {
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "install-killed.json"), JSON.stringify(facts, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R1 安装 shell 被 SIGKILL 时 Desktop 报安装失败，而不是 no JSON result", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    const container = readRemoteDockerContainer(MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });

    // 只杀 sshd 直接拉起的安装 shell，让 sshd 向客户端发送 exit-signal。
    await writeRemoteContainerFile(
      container,
      KILLER_SCRIPT,
      [
        `end=$(( $(date +%s) + 600 ))`,
        `while [ "$(date +%s)" -lt "$end" ]; do`,
        `  for p in $(pgrep -f 'update --from-archive'); do`,
        `    pp=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')`,
        `    [ -n "$pp" ] || continue`,
        `    if [ "$(ps -o comm= -p "$pp" 2>/dev/null)" = "sshd" ] && ps -o args= -p "$p" | grep -q 'tar -xzf'; then`,
        `      comm=$(ps -o comm= -p "$p" 2>/dev/null)`,
        `      kill -KILL "$p" && echo "$(date +%s%3N) killed pid=$p comm=$comm" >> ${KILLER_LOG}`,
        `      exit 0`,
        `    fi`,
        `  done`,
        `  sleep 0.02`,
        `done`,
        "",
      ].join("\n"),
    );
    await execFileAsync("docker", ["exec", "-d", "--user", "dev", container, "sh", KILLER_SCRIPT]);

    await openSSHRemoteDialog(MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(MARKER);
    let connectError: unknown;
    try {
      // 新容器会弹出安装确认，helper 自动确认后开始上传与远端安装。
      await waitForSSHDirectoryStep(MARKER);
    } catch (error) {
      connectError = error;
    }
    facts.connectError = connectError instanceof Error ? connectError.message : connectError;
    facts.killer = await readRemoteContainerFile(container, KILLER_LOG).catch(() => "");
    facts.rawError = await readLastConnectRemoteError();

    expect(facts.killer).toMatch(/killed pid=\d+/u);
    expect(connectError).toBeInstanceOf(Error);
    expect(facts.rawError).not.toBe(NO_JSON_MESSAGE);
    expect(facts.rawError).toMatch(/archive installation failed/u);
  });
});
