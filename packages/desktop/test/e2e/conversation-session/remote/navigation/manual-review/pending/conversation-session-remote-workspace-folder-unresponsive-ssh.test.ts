import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { TID_SSH_DIALOG, TID_SSH_ERROR } from "@zcode/shared/test-ids";
import { readConnectRemoteFailures } from "#e2e/helpers/connect-remote-error-log";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
  writeRemoteContainerFile,
} from "#e2e/helpers/remote-docker-target";
import {
  disconnectRemoteSource,
  requestRemoteProjectConnection,
} from "#e2e/helpers/remote-project-actions";
import { installAndStartRemoteDaemon } from "#e2e/helpers/remote-restart-stale-daemon";
import {
  connectSSHWorkspace,
  readSSHRuntimeConfig,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// 3.16.2 远端回归 R8（#12）的真实 SSH 验证（本机 Docker runner）：远端读取项目目录永不返回时，
// 带目录的连接必须在 30 秒后以“远端读取项目目录没有响应”结束，连接屏把“打开项目目录”标为失败；
// 远端恢复后重试可以打开同一项目。测试接缝只作用于远端 Core 读取该目录的 admission 调用。
const MARKER = "E2E_REMOTE_WORKSPACE_FOLDER_UNRESPONSIVE_SSH";
const HANG_DIR = "/home/dev/e2e-hang-project";
const HANG_FLAG = "/home/dev/.e2e-hang-on";
const SEAM_SCRIPT = "/home/dev/.e2e-hang-readdir.cjs";
const DEADLINE_MS = 30_000;
const desktopRoot = process.cwd();
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-workspace-folder-unresponsive-ssh",
);

// 标记文件存在时，Core 读取 HANG_DIR/.（Host admission 的探测路径）不返回；目录浏览器读取
// HANG_DIR 本身不受影响。远端恢复时被挂起的系统调用随之返回：标记删除后，挂起的读取继续执行真实读取
// （同一路径未返回的读取会被复用，见 ZCT-2113660144497782784）。ESM 内置模块的具名导出需要
// syncBuiltinESMExports 才能看到替换。
const SEAM = `if (/server-core\\.js$/.test(process.argv[1] || "")) {
  const fs = require("node:fs");
  const fsp = require("node:fs/promises");
  const original = fsp.readdir;
  fsp.readdir = function (path, ...rest) {
    if (String(path) === ${JSON.stringify(`${HANG_DIR}/.`)} && fs.existsSync(${JSON.stringify(HANG_FLAG)})) {
      return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (fs.existsSync(${JSON.stringify(HANG_FLAG)})) return;
          clearInterval(timer);
          original.call(this, path, ...rest).then(resolve, reject);
        }, 200);
      });
    }
    return original.call(this, path, ...rest);
  };
  require("node:module").syncBuiltinESMExports();
}
`;

async function readStages(): Promise<Array<{ text: string; failed: boolean; active: boolean }>> {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="remote-connection-stages"] > li'),
    ).map((item) => ({
      text: item.innerText.trim(),
      failed: Boolean(item.querySelector(".text-destructive, .border-destructive")),
      active: item.classList.contains("bg-surface"),
    })),
  );
}

async function clickDialogRetry(): Promise<void> {
  const clicked = await browser.execute((errorTestId) => {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>(`[data-testid="${errorTestId}"] button`),
    ).find((item) => /^(重试|Retry)$/u.test(item.innerText.trim()) && !item.disabled);
    button?.click();
    return Boolean(button);
  }, TID_SSH_ERROR);
  if (!clicked) throw new Error(`${MARKER}: 错误块里没有可用的重试按钮`);
}

describe(`${MARKER}: 远端读取项目目录无响应`, () => {
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "workspace-folder-unresponsive.json"),
      JSON.stringify(facts, null, 2),
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R8 目录无响应时 30 秒后在“打开项目目录”报错，恢复后重试可以打开", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    const container = readRemoteDockerContainer(MARKER);
    const appVersion = (
      JSON.parse(readFileSync(resolve(desktopRoot, "../../package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    await prepareV4ConversationE2E({ skipProvider: true });
    await execInRemoteContainer(container, ["mkdir", "-p", HANG_DIR]);
    await writeRemoteContainerFile(container, SEAM_SCRIPT, SEAM);
    await installAndStartRemoteDaemon(
      container,
      { user: "dev", home: "/home/dev" },
      { desktopRoot, appVersion, nodeOptions: `--require=${SEAM_SCRIPT}` },
    );

    // 1. 接缝未启用：正常建好项目并打开。
    const tab = await connectSSHWorkspace({ config, caseMarker: MARKER, workspacePath: HANG_DIR });
    const identity = tab.workspaceIdentity!;
    const sourceServerId = parseRemoteWorkspaceIdentity(identity)?.sourceServerId;
    if (!sourceServerId) throw new Error(`${MARKER}: 项目身份里没有 sourceServerId`);
    await disconnectRemoteSource(sourceServerId, MARKER, { workspaceIdentities: [identity] });

    // 2. 启用接缝后从项目行重连：设备很快上线，带目录的连接在截止时间后失败，不再一直挂着。
    //    项目行的 data-connection-state 是设备状态，这里以这次连接请求的结果为准。
    await execInRemoteContainer(container, ["touch", HANG_FLAG]);
    const failuresBefore = (await readConnectRemoteFailures()).length;
    const reconnectStartedAt = Date.now();
    await requestRemoteProjectConnection(identity, MARKER);
    let reconnectFailure: Awaited<ReturnType<typeof readConnectRemoteFailures>>[number] | undefined;
    try {
      await browser.waitUntil(
        async () => {
          reconnectFailure = (await readConnectRemoteFailures()).slice(failuresBefore).at(-1);
          return Boolean(reconnectFailure);
        },
        { timeout: DEADLINE_MS + 45_000, interval: 500 },
      );
    } finally {
      facts.reconnectFailure = reconnectFailure ?? null;
      facts.reconnectElapsedMs = Date.now() - reconnectStartedAt;
    }
    expect(reconnectFailure?.code).toBe("remote-workspace-directory-unresponsive");
    expect(facts.reconnectElapsedMs as number).toBeGreaterThanOrEqual(DEADLINE_MS - 1_000);
    // 项目页签的断线横幅给出项目级原因（项目行的状态是设备状态，设备此时在线）。
    const banner = $('[data-testid="remote-conversation-banner"]');
    await browser.waitUntil(
      async () =>
        (await banner.isDisplayed()) && (await banner.getText()).includes("远端读取项目目录"),
      { timeout: 30_000, timeoutMsg: `${MARKER}: 断线横幅没有显示目录无响应` },
    );
    facts.bannerText = await banner.getText();
    facts.bannerState = await banner.getAttribute("data-connection-state");
    expect(facts.bannerText).toContain("远端读取项目目录 30 秒没有响应");
    await browser.saveScreenshot(resolve(artifactDir, "banner-failed.png"));

    // 3. 横幅“重新连接”把失败项目交给向导：连接屏有“打开项目目录”这一步且已失败。
    await banner
      .$('.//button[normalize-space(.)="重新连接" or normalize-space(.)="Reconnect"]')
      .click();
    await $(`[data-testid="${TID_SSH_DIALOG}"]`).waitForDisplayed({ timeout: 30_000 });
    await $('[data-testid="remote-connection-stages"]').waitForDisplayed({ timeout: 30_000 });
    facts.handoffStages = await readStages();
    expect((facts.handoffStages as Array<{ text: string; failed: boolean }>).at(-1)).toMatchObject({
      failed: true,
    });
    expect((facts.handoffStages as Array<{ text: string }>).at(-1)?.text).toMatch(/打开项目目录/u);
    await browser.saveScreenshot(resolve(artifactDir, "handoff-failed.png"));

    // 4. 仍然卡住时在向导里重试：第 ⑤ 步先进行中，截止后标为失败并显示具体原因。
    await clickDialogRetry();
    await browser.waitUntil(
      async () => {
        const stages = await readStages();
        return stages.length === 5 && stages[4]!.active && !stages[4]!.failed;
      },
      { timeout: 30_000, timeoutMsg: `${MARKER}: 重试后“打开项目目录”没有进入进行中` },
    );
    const wizardStartedAt = Date.now();
    facts.activeStages = await readStages();
    expect((facts.activeStages as Array<{ text: string }>)[4]?.text).toContain(HANG_DIR);
    await browser.saveScreenshot(resolve(artifactDir, "workspace-active.png"));
    const error = $(`[data-testid="${TID_SSH_DIALOG}"] [data-testid="${TID_SSH_ERROR}"]`);
    await error.waitForDisplayed({ timeout: DEADLINE_MS + 15_000 });
    facts.wizardElapsedMs = Date.now() - wizardStartedAt;
    facts.wizardError = await error.getText();
    facts.failedStages = await readStages();
    await browser.saveScreenshot(resolve(artifactDir, "workspace-failed.png"));
    expect(facts.wizardError).toContain("远端读取项目目录 30 秒没有响应");
    expect((facts.failedStages as Array<{ failed: boolean }>)[4]?.failed).toBe(true);

    // 5. 远端恢复后重试：打开同一项目。
    await execInRemoteContainer(container, ["rm", "-f", HANG_FLAG]);
    await clickDialogRetry();
    const restored = await waitForRemoteTab({
      caseMarker: MARKER,
      expectedIdentity: identity,
      expectedPath: HANG_DIR,
      timeoutMs: 120_000,
    });
    facts.restored = { remoteSessionId: restored.remoteSessionId };
    expect(restored.remoteSessionId).toBeTruthy();
  });
});
