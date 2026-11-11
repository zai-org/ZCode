// R3A-TRN-02：本机 Docker daemon 不可用（socket 不存在、socket 没有权限）时连接 Docker 容器。
// 连接屏报“连接失败”，详细信息保留 docker CLI 原因；不报容器环境检查失败或没有容器写入权限。
// daemon 恢复后同一容器正常进入安装确认，说明成功路径不受影响。
//
// 只改应用 HOME 下的 docker context：WDIO 与应用共用隔离的 E2E HOME，不影响本机其他 docker 调用。
import { execFile } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  TID_DOCKER_CONTAINER_INPUT,
  TID_REMOTE_KIND_DOCKER,
  TID_SSH_DIALOG,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { readRemoteDockerContainer } from "#e2e/helpers/remote-docker-target";
import {
  clickLastEnabledSSHDialogButton,
  openRemoteConnectionSelection,
  waitForSSHError,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_R3_DOCKER_DAEMON_UNAVAILABLE";
const CONTEXT_NAME = `zcode-e2e-daemon-down-${process.pid}`;
const MISSING_SOCKET = `/tmp/zcode-e2e-docker-missing-${process.pid}.sock`;
const DENIED_SOCKET = `/tmp/zcode-e2e-docker-denied-${process.pid}.sock`;
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-docker-daemon-unavailable",
);
const run = promisify(execFile);

interface DaemonCase {
  name: string;
  socket: string;
  /** 详细信息里必须保留的 docker CLI 原因片段。 */
  details: readonly string[];
}

const CASES: DaemonCase[] = [
  {
    name: "socket-missing",
    socket: MISSING_SOCKET,
    details: [
      "check if the path is correct and if the daemon is running",
      // 第二处裸 socket 路径后的系统诊断也必须保留，不能只断言第一处 URL 后的说明。
      "dial unix [redacted-path]: connect: no such file or directory",
    ],
  },
  {
    name: "socket-denied",
    socket: DENIED_SOCKET,
    details: ["permission denied while trying to connect to the docker API at [redacted-url]"],
  },
];

/** docker context 写在应用 HOME 的 .docker 下；应用 spawn 的 docker CLI 与这里读同一份配置。 */
function dockerInAppHome(args: string[]) {
  return run("docker", args, { env: { ...process.env, HOME: getE2EAppDataPaths().homeDir } });
}

async function pointAppDockerAt(socket: string | null): Promise<void> {
  if (socket === null) {
    await dockerInAppHome(["context", "use", "default"]);
    await dockerInAppHome(["context", "rm", "--force", CONTEXT_NAME]).catch(() => undefined);
    return;
  }
  await dockerInAppHome(["context", "rm", "--force", CONTEXT_NAME]).catch(() => undefined);
  await dockerInAppHome(["context", "create", CONTEXT_NAME, "--docker", `host=unix://${socket}`]);
  await dockerInAppHome(["context", "use", CONTEXT_NAME]);
}

/** 有监听但当前用户无权连接的 socket：connect 得到 EACCES，与 docker 组外用户相同。 */
async function startDeniedSocket(): Promise<Server> {
  await rm(DENIED_SOCKET, { force: true });
  const server = createServer();
  await new Promise<void>((done) => server.listen(DENIED_SOCKET, done));
  await chmod(DENIED_SOCKET, 0o000);
  return server;
}

async function connectDockerContainer(container: string): Promise<void> {
  await openRemoteConnectionSelection();
  await clickTestIdByDom(TID_REMOTE_KIND_DOCKER, {
    timeout: 30_000,
    timeoutMsg: `${MARKER}: 无法选择 Docker transport`,
  });
  const input = $(`[data-testid="${TID_DOCKER_CONTAINER_INPUT}"]`);
  await input.waitForDisplayed({ timeout: 30_000 });
  await input.setValue(container);
  await clickLastEnabledSSHDialogButton(MARKER);
}

async function closeConnectionDialog(): Promise<void> {
  await browser.keys("Escape");
  await $(`[data-testid="${TID_SSH_DIALOG}"]`).waitForExist({ reverse: true, timeout: 15_000 });
}

describe(`${MARKER}: 本机 Docker daemon 不可用`, () => {
  let deniedSocket: Server | undefined;
  const facts: Record<string, unknown> = {};
  after(async () => {
    await pointAppDockerAt(null).catch(() => undefined);
    await new Promise<void>((done) => (deniedSocket ? deniedSocket.close(() => done()) : done()));
    await rm(DENIED_SOCKET, { force: true });
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "daemon-unavailable.json"),
      JSON.stringify(facts, null, 2),
    );
    await clearAppData();
  });

  it("R3A-TRN-02 daemon 不可用时显示 docker CLI 原因且不误分类，恢复后正常进入安装确认", async function () {
    this.timeout(10 * 60_000);
    // 这些环境变量会覆盖 docker context，用例无法只让应用看到不可用的 daemon。
    for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) {
      if (process.env[name]) throw new Error(`${MARKER}: 需要在未设置 ${name} 的环境运行`);
    }
    const container = readRemoteDockerContainer(MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    deniedSocket = await startDeniedSocket();

    for (const item of CASES) {
      await pointAppDockerAt(item.socket);
      await connectDockerContainer(container);
      const errorText = await waitForSSHError(`${MARKER} ${item.name}`);
      const details = await browser.execute(
        () => document.querySelector('[data-testid="ssh-error"] details pre')?.textContent ?? "",
      );
      facts[item.name] = { errorText, details };
      const detailsPanel = $('[data-testid="ssh-error"] details');
      if ((await detailsPanel.getAttribute("open")) === null) {
        await detailsPanel.$("summary").click();
      }
      await mkdir(artifactDir, { recursive: true });
      await browser.saveScreenshot(resolve(artifactDir, `${item.name}.png`));
      // 修复前：socket 不存在报“容器环境检查失败”，没有权限报“没有容器写入权限”，原因截断成 uni[redacted-path]。
      expect(errorText).toContain("连接失败");
      expect(errorText).not.toContain("容器环境检查失败");
      expect(errorText).not.toContain("没有容器写入权限");
      expect(details).toContain("当前系统未检测到可用的 Docker 环境");
      for (const detail of item.details) expect(details).toContain(detail);
      expect(details).not.toMatch(/\buni\[redacted-path\]/u);
      await closeConnectionDialog();
    }

    await pointAppDockerAt(null);
    await connectDockerContainer(container);
    await browser.waitUntil(
      () =>
        browser.execute((dialogTestId) => {
          const dialog = document.querySelector(`[data-testid="${dialogTestId}"]`);
          return Array.from(dialog?.querySelectorAll("button") ?? []).some((button) =>
            /安装并继续|Install and continue/u.test(button.textContent ?? ""),
          );
        }, TID_SSH_DIALOG),
      {
        timeout: 120_000,
        interval: 500,
        timeoutMsg: `${MARKER}: daemon 恢复后没有进入安装确认`,
      },
    );
    facts.recoveredToInstallConfirmation = true;
    await browser.saveScreenshot(resolve(artifactDir, "daemon-recovered.png"));
    await closeConnectionDialog();
  });
});
