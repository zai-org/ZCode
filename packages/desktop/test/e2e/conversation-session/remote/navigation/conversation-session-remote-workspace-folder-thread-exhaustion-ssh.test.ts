import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { TID_SSH_DIALOG, TID_SSH_ERROR } from "@zcode/shared/test-ids";
import {
  countRemoteWorkspaceUnresponsiveFailures,
  readConnectRemoteFailures,
} from "#e2e/helpers/connect-remote-error-log";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
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
  clickLastEnabledSSHDialogButton,
  connectSSHWorkspace,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  openSSHSourceDirectory,
  readSSHRuntimeConfig,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// ZCT-2113660144497782784 的真实 SSH 验证（本机 Docker runner）：远端读取项目目录卡住，且每个卡住的调用真实占住
// Core 的一个 libuv 线程（Node 默认 4 个，文件调用不能取消）。修复前，卡住项目重试几次后线程池占满，同设备所有
// 文件操作都不再返回：其他项目打不开，侧栏一直“连接中”，新建任务一直转圈。修复后同一路径未返回的调用被复用，
// 主目录检查 30 秒后按“无法访问”返回；其他项目照常打开，远端恢复后卡住项目可以重新打开。
const MARKER = "E2E_REMOTE_WORKSPACE_FOLDER_THREAD_EXHAUSTION_SSH";
const HANG_DIR = "/home/dev/e2e-exhaust-hang";
const OK_DIR = "/home/dev/e2e-exhaust-ok";
const LATE_DIR = "/home/dev/e2e-exhaust-late";
const HANG_FLAG = "/home/dev/.e2e-exhaust-hang-on";
const HANG_FIFO = "/home/dev/.e2e-exhaust-hang.fifo";
const SEAM_SCRIPT = "/home/dev/.e2e-exhaust-seam.cjs";
const HUNG_ATTEMPTS = 4;
const DEADLINE_MS = 30_000;
const desktopRoot = process.cwd();
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ??
    ".e2e-artifacts/remote-workspace-folder-thread-exhaustion-ssh",
);

// 标记文件存在时，Core 对 HANG_DIR/.（admission 探测）的 readdir 和对 HANG_DIR（主目录检查）的 stat 先对没有
// 写端的 FIFO 调用 open()：这会在 libuv 线程池里真实阻塞一个线程，与远端等待授权、网络盘无响应时一致。
// 恢复时测试打开 FIFO 写端放行挂起的调用，随后执行真实的文件调用。只作用于 server-core 进程。
const SEAM = `if (/server-core\\.js$/.test(process.argv[1] || "")) {
  const fs = require("node:fs");
  const fsp = require("node:fs/promises");
  const flag = ${JSON.stringify(HANG_FLAG)};
  const fifo = ${JSON.stringify(HANG_FIFO)};
  const gate = (name, matches) => {
    const original = fsp[name];
    fsp[name] = function (path, ...rest) {
      if (matches(String(path)) && fs.existsSync(flag)) {
        return fsp.open(fifo, "r").then(async (handle) => {
          await handle.close();
          return original.call(this, path, ...rest);
        });
      }
      return original.call(this, path, ...rest);
    };
  };
  gate("readdir", (path) => path === ${JSON.stringify(`${HANG_DIR}/.`)});
  gate("stat", (path) => path === ${JSON.stringify(HANG_DIR)});
  require("node:module").syncBuiltinESMExports();
}
`;

/** 等到这次连接以“目录无响应”结束：新建连接与已有连接上的重试走不同路径，统一按失败次数增加判断。 */
async function waitForUnresponsiveFailure(before: number, label: string): Promise<void> {
  await browser.waitUntil(async () => (await countRemoteWorkspaceUnresponsiveFailures()) > before, {
    timeout: DEADLINE_MS + 45_000,
    interval: 500,
    timeoutMsg: `${MARKER}: ${label} 没有以目录无响应结束`,
  });
}

async function clickDialogRetry(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((errorTestId) => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>(`[data-testid="${errorTestId}"] button`),
        ).find((item) => /^(重试|Retry)$/u.test(item.innerText.trim()) && !item.disabled);
        button?.click();
        return Boolean(button);
      }, TID_SSH_ERROR),
    { timeout: 30_000, timeoutMsg: `${MARKER}: 错误块里没有可用的重试按钮` },
  );
}

async function closeDialog(): Promise<void> {
  const dialog = $(`[data-testid="${TID_SSH_DIALOG}"]`);
  if (!(await dialog.isDisplayed())) return;
  await browser.keys("Escape");
  await dialog.waitForDisplayed({ reverse: true, timeout: 15_000 });
}

/** 同一设备追加一个项目：向导收起时从已注册设备进入目录选择。 */
async function addProjectOnSameDevice(
  config: ReturnType<typeof readSSHRuntimeConfig>,
  workspacePath: string,
) {
  await openSSHRemoteDialog(MARKER);
  await fillSSHPasswordSettings(config);
  await clickLastEnabledSSHDialogButton(MARKER);
  if ((await waitForSSHDirectoryStep(MARKER)) === "closed")
    await openSSHSourceDirectory(config, MARKER);
  await selectSSHRemoteDirectory(workspacePath, MARKER);
  return waitForRemoteTab({ caseMarker: MARKER, expectedPath: workspacePath });
}

function projectRowSelector(identity: string): string {
  return `[data-project-workspace-identity=${JSON.stringify(identity)}]`;
}

async function readProjectRow(identity: string) {
  return browser.execute((selector) => {
    const row = document.querySelector<HTMLElement>(selector);
    return {
      exists: Boolean(row),
      primaryRootStatus: row?.dataset.primaryRootStatus ?? null,
      connectionState: row?.dataset.connectionState ?? null,
      statusLabel:
        row?.querySelector<HTMLElement>('[data-testid="project-status-label"]')?.innerText.trim() ??
        null,
      createTaskDisabled:
        row?.querySelector<HTMLButtonElement>('[data-testid="virtual-project-create-task"]')
          ?.disabled ?? null,
    };
  }, projectRowSelector(identity));
}

async function releaseHungCalls(container: string): Promise<void> {
  await execInRemoteContainer(container, ["rm", "-f", HANG_FLAG]);
  // 打开写端放行所有阻塞在读端 open() 的调用；没有读端时 timeout 结束本次写端等待。
  await execInRemoteContainer(container, [
    "sh",
    "-c",
    `for i in $(seq 1 40); do timeout 0.2 sh -c ': > ${HANG_FIFO}' 2>/dev/null; done; true`,
  ]);
}

describe(`${MARKER}: 卡住的远端目录不能占满 Core 线程池`, () => {
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "workspace-folder-thread-exhaustion.json"),
      JSON.stringify(facts, null, 2),
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("卡住项目反复重试后，同设备其他项目照常打开，侧栏标为无法访问，恢复后可重新打开", async function () {
    this.timeout(25 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    const container = readRemoteDockerContainer(MARKER);
    const appVersion = (
      JSON.parse(readFileSync(resolve(desktopRoot, "../../package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    await prepareV4ConversationE2E({ skipProvider: true });
    await execInRemoteContainer(container, ["mkdir", "-p", HANG_DIR, OK_DIR]);
    await execInRemoteContainer(container, [
      "sh",
      "-c",
      `rm -f ${HANG_FIFO} && mkfifo ${HANG_FIFO}`,
    ]);
    await writeRemoteContainerFile(container, SEAM_SCRIPT, SEAM);
    await installAndStartRemoteDaemon(
      container,
      { user: "dev", home: "/home/dev" },
      { desktopRoot, appVersion, nodeOptions: `--require=${SEAM_SCRIPT}` },
    );

    // 1. 接缝未启用：同一设备建好两个项目；卡住项目最后打开，保持为当前页签。
    const ok = await connectSSHWorkspace({ config, caseMarker: MARKER, workspacePath: OK_DIR });
    const hung = await addProjectOnSameDevice(config, HANG_DIR);
    const hungIdentity = hung.workspaceIdentity!;
    const okIdentity = ok.workspaceIdentity!;
    const sourceServerId = parseRemoteWorkspaceIdentity(hungIdentity)?.sourceServerId;
    if (!sourceServerId) throw new Error(`${MARKER}: 项目身份里没有 sourceServerId`);
    expect(parseRemoteWorkspaceIdentity(okIdentity)?.sourceServerId).toBe(sourceServerId);
    await disconnectRemoteSource(sourceServerId, MARKER, {
      workspaceIdentities: [hungIdentity, okIdentity],
    });

    // 2. 启用接缝后反复打开卡住项目：每次 30 秒后报无响应，设备保持在线。
    //    第 1 次从项目行连接；之后从该项目页签的横幅进入原向导重试，与用户反复点击一致。
    await execInRemoteContainer(container, ["touch", HANG_FLAG]);
    const attempts: number[] = [];
    for (let attempt = 1; attempt <= HUNG_ATTEMPTS; attempt++) {
      const before = await countRemoteWorkspaceUnresponsiveFailures();
      const startedAt = Date.now();
      if (attempt === 1) {
        await requestRemoteProjectConnection(hungIdentity, MARKER);
      } else {
        if (!(await $(`[data-testid="${TID_SSH_DIALOG}"]`).isDisplayed())) {
          // 横幅属于当前页签（卡住项目）；“重新连接”把失败项目交给向导，向导里的重试读取该项目目录。
          const banner = $('[data-testid="remote-conversation-banner"]');
          await banner.waitForDisplayed({ timeout: 30_000, timeoutMsg: `${MARKER}: 没有断线横幅` });
          await banner
            .$('.//button[normalize-space(.)="重新连接" or normalize-space(.)="Reconnect"]')
            .click();
          await $(`[data-testid="${TID_SSH_DIALOG}"]`).waitForDisplayed({ timeout: 30_000 });
        }
        await clickDialogRetry();
      }
      await waitForUnresponsiveFailure(before, `卡住项目第 ${attempt} 次连接`);
      attempts.push(Date.now() - startedAt);
    }
    // 每次都按 R8 在截止时间结束，而不是立即失败或一直挂着。
    facts.hungAttemptElapsedMs = attempts;
    expect(attempts.every((elapsedMs) => elapsedMs >= DEADLINE_MS - 1_000)).toBe(true);
    await browser.saveScreenshot(resolve(artifactDir, "hung-attempts.png"));
    await closeDialog();

    // 3. 同设备新增项目：目录选择器读取目录、项目 admission 都照常完成。
    //    修复前：线程池已被卡住的调用占满，读目录同样不再返回，新项目打不开。
    await execInRemoteContainer(container, ["mkdir", "-p", LATE_DIR]);
    const lateFailuresBefore = (await readConnectRemoteFailures()).length;
    const lateUnresponsiveBefore = await countRemoteWorkspaceUnresponsiveFailures();
    try {
      const late = await addProjectOnSameDevice(config, LATE_DIR);
      facts.lateProject = {
        workspaceIdentity: late.workspaceIdentity,
        remoteSessionId: late.remoteSessionId,
      };
    } finally {
      facts.lateFailures = (await readConnectRemoteFailures()).slice(lateFailuresBefore);
      facts.lateUnresponsive =
        (await countRemoteWorkspaceUnresponsiveFailures()) - lateUnresponsiveBefore;
      await browser.saveScreenshot(resolve(artifactDir, "late-project.png"));
    }
    expect(facts.lateFailures).toEqual([]);
    expect(facts.lateUnresponsive).toBe(0);

    // 4. 侧栏不再一直“连接中”：卡住项目标为无法访问并禁用新建，其他项目正常可用。
    let rows:
      | {
          hung: Awaited<ReturnType<typeof readProjectRow>>;
          ok: Awaited<ReturnType<typeof readProjectRow>>;
        }
      | undefined;
    try {
      await browser.waitUntil(
        async () => {
          rows = { hung: await readProjectRow(hungIdentity), ok: await readProjectRow(okIdentity) };
          return (
            rows.hung.primaryRootStatus === "unavailable" &&
            rows.hung.createTaskDisabled === true &&
            rows.ok.primaryRootStatus === "available" &&
            rows.ok.statusLabel === null
          );
        },
        { timeout: DEADLINE_MS + 45_000, interval: 1000 },
      );
    } finally {
      facts.sidebarRows = rows ?? null;
    }
    await browser.saveScreenshot(resolve(artifactDir, "sidebar-unavailable.png"));

    // 5. 远端恢复：放行挂起的调用；用户切回窗口时侧栏重新读取（focus 刷新），卡住项目恢复可用，
    //    从侧栏新建任务可以进入该项目（prepareSession 复检主目录、项目 admission 都完成）。
    await releaseHungCalls(container);
    await browser.waitUntil(
      async () => {
        await browser.execute(() => window.dispatchEvent(new Event("focus")));
        return (await readProjectRow(hungIdentity)).primaryRootStatus === "available";
      },
      { timeout: 60_000, interval: 2000, timeoutMsg: `${MARKER}: 恢复后主目录仍不可用` },
    );
    await startDraftFromProject(HANG_DIR, { workspaceIdentity: hungIdentity });
    const restored = await waitForRemoteTab({
      caseMarker: MARKER,
      expectedIdentity: hungIdentity,
      expectedPath: HANG_DIR,
      timeoutMs: 120_000,
    });
    facts.hungRestored = { remoteSessionId: restored.remoteSessionId };
    expect(restored.remoteSessionId).toBeTruthy();
    await browser.saveScreenshot(resolve(artifactDir, "restored.png"));
  });
});
