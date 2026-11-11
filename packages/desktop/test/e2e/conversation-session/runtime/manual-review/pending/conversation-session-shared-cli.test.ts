import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  testId,
  TID_TASK_ITEM,
  TID_WORKSPACE_MORE_BUTTON,
  TID_CONFIRM_DIALOG_CONFIRM,
} from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl } from "#e2e/helpers/web-remote-unread";
import { waitForUpstreamNetworkRequestStarted } from "#e2e/helpers/upstream-capture";
import {
  getV4ConversationState,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4TimelineContaining,
  waitForV4ConversationState,
  getV4Messages,
  clickV4Stop,
  waitForV4PermissionDialog,
  approveV4Permission,
  hasV4PermissionDialog,
} from "#e2e/helpers/v4-conversation";
import {
  isMainRendererUrl,
  isResourceManagerUrl,
  listAgentProcessIdentities,
  openResourceManagerFromHelpMenu,
  switchToElectronRendererTarget,
  waitForResourceManagerReady,
} from "#e2e/helpers/resource-manager";

async function readAgents() {
  await openResourceManagerFromHelpMenu();
  await switchToElectronRendererTarget(isResourceManagerUrl);
  await waitForResourceManagerReady();
  const agents = await listAgentProcessIdentities();
  await switchToElectronRendererTarget(isMainRendererUrl);
  return agents;
}

async function currentDirectory() {
  return browser.execute(
    () =>
      (
        window as Window & {
          __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath?: string | null } };
        }
      ).__zcodeTabStoreE2E?.getState().activeWorkspacePath,
  );
}

async function sendAndFinish(marker: string) {
  const before = (await getV4Messages("assistant")).at(-1)?.id;
  await sendV4Prompt(`${marker} reply briefly`);
  // 虚拟列表收到新回复后可能移除旧行，可见数量不增长；用末条回复身份确认本轮结果。
  await browser.waitUntil(
    async () => {
      const latest = (await getV4Messages("assistant")).at(-1);
      return Boolean(latest && latest.id !== before && latest.text.includes("shared-cli-ok"));
    },
    { timeout: 60_000, timeoutMsg: `${marker} 没有独立回复` },
  );
  await waitForV4ConversationState((s) => s.state === "idle", `${marker} 未完成`);
}

describe("无项目工作区共享 CLI", () => {
  let webBrowser: Browser | undefined;
  let mobile: Page | undefined;
  after(async () => {
    if (mobile && process.env.ZCODE_E2E_ARTIFACT_DIR)
      await mobile
        .screenshot({ path: join(process.env.ZCODE_E2E_ARTIFACT_DIR, "STCLI-mobile.png") })
        .catch(() => undefined);
    await webBrowser?.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("STCLI01–07 共享、草稿释放、单任务重启、移动与进程退出恢复保持身份隔离", async function () {
    this.timeout(360_000);
    await prepareV4ConversationE2E();
    await startNewV4Draft();
    await sendV4Prompt("E2E_SHARED_CLI_A reply briefly");
    await waitForV4TimelineContaining("shared-cli-ok", 60_000);
    await waitForV4ConversationState((s) => s.state === "idle", "A 未完成");
    const taskA = (await getV4ConversationState()).taskId;
    const cwdA = await currentDirectory();
    const agentsA = await readAgents();
    const shared = agentsA.find((agent) => agent.name.endsWith("-zcode"));
    expect(shared).toBeDefined();
    expect(agentsA.some((agent) => agent.name.endsWith("-zcodeproject"))).toBe(true);

    await startNewV4Draft();
    await sendV4Prompt("E2E_SHARED_CLI_B reply briefly");
    await waitForV4TimelineContaining("shared-cli-ok", 60_000);
    await waitForV4ConversationState((s) => s.state === "idle", "B 未完成");
    const taskB = (await getV4ConversationState()).taskId;
    const cwdB = await currentDirectory();
    expect(cwdB).toBeTruthy();
    expect(cwdB).not.toBe(cwdA);
    expect(taskA).toBeTruthy();
    expect(taskB).toBeTruthy();
    expect(taskB).not.toBe(taskA);
    expect(await readAgents()).toEqual(agentsA);

    // 同一个工具调用 ID 在两个 session 中分别审批，文件必须落在各自目录。
    await $(`[data-testid="${testId(TID_TASK_ITEM, taskA!)}"]`).click();
    await sendV4Prompt("E2E_SHARED_CLI_TOOL_A");
    await waitForV4PermissionDialog();
    await $(`[data-testid="${testId(TID_TASK_ITEM, taskB!)}"]`).click();
    expect(await hasV4PermissionDialog()).toBe(false);
    await sendV4Prompt("E2E_SHARED_CLI_TOOL_B");
    await waitForV4PermissionDialog();
    await approveV4Permission();
    await waitForV4ConversationState((s) => s.state === "idle", "B 工具未完成");
    expect(await readFile(join(cwdB!, "shared-cli-proof.txt"), "utf8")).toBe(cwdB);
    await $(`[data-testid="${testId(TID_TASK_ITEM, taskA!)}"]`).click();
    await waitForV4PermissionDialog();
    await approveV4Permission();
    await waitForV4ConversationState((s) => s.state === "idle", "A 工具未完成");
    expect(await readFile(join(cwdA!, "shared-cli-proof.txt"), "utf8")).toBe(cwdA);

    await startNewV4Draft();
    await $(`[data-testid="${testId(TID_TASK_ITEM, taskB!)}"]`).click();
    await sendAndFinish("E2E_SHARED_CLI_B_CONTINUE");
    expect((await getV4ConversationState()).taskId).toBe(taskB);
    expect(await readAgents()).toEqual(agentsA);

    // 用上游请求已开始作屏障；A 流式执行期间，B 仍可完成自己的发送。
    await $(`[data-testid="${testId(TID_TASK_ITEM, taskA!)}"]`).click();
    await sendV4Prompt("E2E_SHARED_CLI_RUNNING");
    await waitForUpstreamNetworkRequestStarted("E2E_SHARED_CLI_RUNNING");
    await $(`[data-testid="${testId(TID_TASK_ITEM, taskB!)}"]`).click();
    await sendAndFinish("E2E_SHARED_CLI_B_PARALLEL");
    await $(`[data-testid="${testId(TID_TASK_ITEM, taskA!)}"]`).click();
    await waitForV4ConversationState((s) => s.state === "streaming", "B 完成前 A 已意外结束");
    await clickV4Stop();
    await waitForV4ConversationState((s) => s.state === "idle", "停止 A 未完成");

    await $(`[data-testid="${testId(TID_TASK_ITEM, taskA!)}"]`).click();
    const paneA = `[data-session-id="${taskA}"]`;
    const generation = Number(await $(paneA).getAttribute("data-session-generation"));
    await $(`[data-testid="${TID_WORKSPACE_MORE_BUTTON}"]`).click();
    await $('[data-testid="task-restart"]').click();
    await browser.waitUntil(
      async () =>
        (await $(paneA).getAttribute("data-session-lifecycle")) === "ready" &&
        Number(await $(paneA).getAttribute("data-session-generation")) > generation,
      { timeout: 60_000 },
    );
    expect(await readAgents()).toEqual(agentsA);
    await sendAndFinish("E2E_SHARED_CLI_A_RESTARTED");

    const pairingUrl = await obtainUnreadPairingUrl(
      new URL(process.env.ZCODE_WEB_REMOTE_CONTROL_URL!).origin,
    );
    webBrowser = await chromium.launch({
      executablePath: process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE,
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await webBrowser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
    });
    await seedMobileFixtureLogin(context);
    mobile = await context.newPage();
    await openMobilePairingPage(mobile, pairingUrl, {
      artifactDir: process.env.ZCODE_E2E_ARTIFACT_DIR!,
      caseMarker: "STCLI07",
      phase: "shared",
      readySelector: `[data-testid="${testId(TID_TASK_ITEM, taskB!)}"]`,
    });
    await mobile.getByTestId(testId(TID_TASK_ITEM, taskB!)).first().tap();
    await mobile.locator(`[data-session-id="${taskB}"]`).waitFor();
    await mobile.getByText("E2E_SHARED_CLI_B_CONTINUE reply briefly", { exact: true }).waitFor();
    expect(
      await mobile.getByText("E2E_SHARED_CLI_A_RESTARTED reply briefly", { exact: true }).count(),
    ).toBe(0);
    await mobile.reload();
    await mobile.getByText("E2E_SHARED_CLI_B_CONTINUE reply briefly", { exact: true }).waitFor();
    expect(await readAgents()).toEqual(agentsA);

    // 移动只更改项目归属，既有运行实例和 cwd 保持稳定。
    const project = $(`[data-project-name="${basename(DEFAULT_WORKSPACE)}"]`);
    await $(`[data-testid="${testId(TID_TASK_ITEM, taskA!)}"]`).dragAndDrop(
      project.$('[data-testid="virtual-project-toggle"]'),
      { duration: 700 },
    );
    const confirm = $(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`);
    await confirm.waitForDisplayed();
    await confirm.click();
    await project.$(`[data-testid="${testId(TID_TASK_ITEM, taskA!)}"]`).waitForDisplayed();
    expect(await currentDirectory()).toBe(cwdA);
    await sendAndFinish("E2E_SHARED_CLI_A_MOVED");
    expect(await readAgents()).toEqual(agentsA);
    const aUsers = (await getV4Messages("user")).length;

    // 只终止本用例观察到的共享 PID；真实退出用于验证全部订阅失效与下一次重新分配。
    process.kill(shared!.pid, "SIGKILL");
    await $(`[data-testid="${testId(TID_TASK_ITEM, taskB!)}"]`).click();
    await waitForV4TimelineContaining("E2E_SHARED_CLI_B_CONTINUE", 60_000);
    await sendAndFinish("E2E_SHARED_CLI_B_RECOVERED");
    const afterB = await readAgents();
    expect(afterB.some((agent) => agent.pid === shared!.pid)).toBe(false);
    const nextShared = afterB.find((agent) => agent.name.endsWith("-zcode"));
    expect(nextShared).toBeDefined();
    await $(`[data-testid="${testId(TID_TASK_ITEM, taskA!)}"]`).click();
    await waitForV4TimelineContaining("E2E_SHARED_CLI_A_MOVED", 60_000);
    expect((await getV4Messages("user")).length).toBe(aUsers);
    await sendAndFinish("E2E_SHARED_CLI_A_RECOVERED");
    expect(await currentDirectory()).toBe(cwdA);
    const afterA = await readAgents();
    expect(afterA.some((agent) => agent.pid === nextShared!.pid)).toBe(true);
    // 资源管理器显示名截断长目录；真实 cwd 已通过页面身份与 Host 日志独立核验。
    expect(
      afterA.some((agent) => agent.pid !== nextShared!.pid && agent.name.includes("-draft-")),
    ).toBe(true);
    expect(afterA.length).toBeGreaterThan(agentsA.length);
    // 清理与换代只恢复订阅，手机不能重放原输入，也不能订阅到移入项目的 A。
    await mobile.reload();
    await mobile.getByText("E2E_SHARED_CLI_B_RECOVERED reply briefly", { exact: true }).waitFor();
    expect(
      await mobile.getByText("E2E_SHARED_CLI_B_RECOVERED reply briefly", { exact: true }).count(),
    ).toBe(1);
    expect(
      await mobile.getByText("E2E_SHARED_CLI_A_RECOVERED reply briefly", { exact: true }).count(),
    ).toBe(0);
  });
});
