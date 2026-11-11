import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { ServiceChannels, parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_TASK_ITEM,
  TID_TASK_NEW_BUTTON,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_V4_STOP,
  testId,
} from "@zcode/shared/test-ids";
import type { ProjectTask, ProjectTree } from "@zcode/services";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { openMobilePairingPage, redactMobileDiagnosticText } from "#e2e/helpers/mobile-pairing";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  createSSHLifecycleProvider,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  prepareSSHConnectionPage,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import {
  ensureUpstreamProviderForE2E,
  selectUpstreamModel,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  getV4ConversationState,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";
import { WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS } from "#e2e/helpers/web-remote-control-session-events-fixture";
import {
  obtainUnreadPairingUrl,
  readMobileTaskView,
  replayStaleBootstrapAfterReconnect,
  showMobileTaskHome,
  waitMobileTaskView,
  type UnreadTaskAddress,
} from "#e2e/helpers/web-remote-unread";
import { createWebRemoteVisibilityBrowser } from "#e2e/helpers/web-remote-visibility-browser";

const CASE = "E2E_MRO03";
const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
const evidence: Record<string, unknown> = {};

async function readTask(address: UnreadTaskAddress): Promise<ProjectTask> {
  const identity = address.workspaceIdentity
    ? parseRemoteWorkspaceIdentity(address.workspaceIdentity)
    : null;
  const tree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
    identity?.kind === "server" ? { hostId: `remote:server:${identity.sourceServerId}` } : {},
  ]);
  const task = tree.tasks.find(
    (item) =>
      item.taskId === address.taskId &&
      (item.workspaceIdentity || item.workspacePath) ===
        (address.workspaceIdentity || address.workspacePath),
  );
  if (!task) throw new Error(`MRO03 task not in persisted project tree: ${address.taskId}`);
  return task;
}

async function waitMarker(address: UnreadTaskAddress, unread: boolean) {
  let task: ProjectTask | undefined;
  await browser.waitUntil(
    async () => {
      task = await readTask(address);
      return (typeof task.unreadAt === "number") === unread;
    },
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `MRO03 persisted unread must be ${unread}: ${address.taskId}`,
    },
  );
  const row = $(`[data-testid=${JSON.stringify(testId(TID_TASK_ITEM, address.taskId))}]`);
  await row.waitForExist({ timeout: 30_000 });
  await browser.waitUntil(
    async () => (await row.$('[data-unread-indicator="true"]').isExisting()) === unread,
    { timeout: 30_000, interval: 100, timeoutMsg: "MRO03 sidebar marker differs from Host" },
  );
  return task?.unreadAt ?? null;
}

async function openWebTask(page: Page, address: UnreadTaskAddress) {
  await showMobileTaskHome(page);
  const toggles = page.getByTestId("virtual-project-toggle");
  for (const toggle of await toggles.all()) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  }
  await page.getByTestId(testId(TID_TASK_ITEM, address.taskId)).first().click();
  await page.locator(`[data-session-id=${JSON.stringify(address.taskId)}]`).waitFor();
  await waitMobileTaskView(address);
}

async function sendWeb(page: Page, marker: string) {
  const input = page.getByTestId(TID_V4_COMPOSER_INPUT).first();
  await input.click();
  await page.keyboard.type(`${marker}: 只回复受控回放内容。`);
  const send = page.getByTestId(TID_V4_COMPOSER_SEND).first();
  await send.click();
  await page
    .getByText(marker.replace("E2E_", "") + "_STREAMING", { exact: false })
    .first()
    .waitFor({ timeout: 90_000 });
}

async function beginDesktopTurn(address: UnreadTaskAddress, marker: string) {
  await selectV4TaskById(address.taskId, 30_000);
  await sendV4Prompt(`${marker}: 只回复受控回放内容。`);
  await waitForV4AssistantMessageContaining(marker.replace("E2E_", "") + "_STREAMING", 90_000);
  await startNewV4Draft();
  expect((await getV4ConversationState()).taskId).not.toBe(address.taskId);
}

async function completeViewed(
  page: Page,
  address: UnreadTaskAddress,
  gate: string,
  response: string,
) {
  await waitMobileTaskView(address);
  await releaseControlledReplay(gate);
  await page.getByText(response, { exact: false }).first().waitFor({ timeout: 90_000 });
  await page.getByTestId(TID_V4_STOP).waitFor({ state: "hidden", timeout: 60_000 });
  const row = $(`[data-testid=${JSON.stringify(testId(TID_TASK_ITEM, address.taskId))}]`);
  await browser.waitUntil(async () => !(await row.$(".animate-spin").isExisting()), {
    timeout: 60_000,
    interval: 100,
  });
  expect((await readTask(address)).unreadAt).toBeUndefined();
  await waitMarker(address, false);
}

describe(`${CASE}: 实际 Web 查看与桌面唯一未读写者`, () => {
  let webBrowser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let pairingUrl = "";
  let provider: SSHLifecycleProvider | undefined;
  let backgroundAddress: UnreadTaskAddress | undefined;
  let bootstrapReplay: Awaited<ReturnType<typeof replayStaleBootstrapAfterReconnect>> | undefined;
  const newPage = async (phase: string) => {
    if (!context || !artifacts) throw new Error("MRO03 isolated browser context required");
    page = await context.newPage();
    await openMobilePairingPage(page, pairingUrl, {
      artifactDir: artifacts,
      caseMarker: CASE,
      phase,
      readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
    });
    return page;
  };
  const newContext = async (width: number, phase: string, staleBootstrap = false) => {
    await context?.close();
    context = await webBrowser!.newContext({
      viewport: { width, height: 900 },
      isMobile: width < 768,
      hasTouch: width < 768,
      locale: "zh-CN",
    });
    if (staleBootstrap) {
      bootstrapReplay = await replayStaleBootstrapAfterReconnect(context);
      evidence[`${width}-bootstrap`] = bootstrapReplay;
    }
    await context.addInitScript((credentials) => {
      if (sessionStorage.getItem("mro03-seeded")) return;
      sessionStorage.setItem("mro03-seeded", "1");
      for (const [key, value] of Object.entries(credentials)) localStorage.setItem(key, value);
    }, WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS);
    return newPage(phase);
  };

  after(async () => {
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await page
        ?.screenshot({ path: join(artifacts, "MRO03-last-page.png") })
        .catch(() => undefined);
      evidence.finalView = await readMobileTaskView().catch(() => null);
      await writeFile(join(artifacts, "MRO03-unread.json"), JSON.stringify(evidence, null, 2));
    }
    await context?.close();
    await webBrowser?.close();
    await provider?.tunnel.close();
    await restoreHandoffProbes();
    await clearAppData();
  });

  it("MRO03 本地：宽窄屏前台完成不未读，Home/断线完成后回看清除，Web首发晋升立即查看", async function () {
    this.timeout(15 * 60_000);
    if (!artifacts || !process.env.ZCODE_E2E_HOME_DIR)
      throw new Error("MRO03 isolated runner required");
    await prepareSSHConnectionPage(CASE);
    await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
    await startNewV4Draft();
    // 回放种子声明 high/max；未读断言不依赖档位，显式选目录中的 high。
    await selectUpstreamModel();
    await selectUpstreamThoughtLevelValue("high");
    await installHandoffRpcProbe();
    webBrowser = await chromium.launch({
      ...(process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE || process.env.R3_MOBILE_CHROME
        ? {
            executablePath:
              process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE || process.env.R3_MOBILE_CHROME,
          }
        : { channel: "chrome" }),
      headless: true,
    });
    for (const width of [1440, 390]) {
      if (width === 390) {
        await startNewV4Draft();
        await selectUpstreamModel();
        await selectUpstreamThoughtLevelValue("high");
      }
      await sendV4Prompt(`${CASE}_SEED: 只回复 MRO03_SEED_DONE`);
      await waitForV4AssistantMessageContaining("MRO03_SEED_DONE", 90_000);
      await waitForV4ConversationState(
        (state) => state.state === "idle" && Boolean(state.taskId),
        "MRO03 seed incomplete",
        90_000,
      );
      const state = await getV4ConversationState();
      const tab = await readRemoteTabSnapshot();
      const address: UnreadTaskAddress = {
        taskId: state.taskId!,
        workspacePath: tab.activeWorkspacePath!,
        ...(tab.activeWorkspaceIdentity ? { workspaceIdentity: tab.activeWorkspaceIdentity } : {}),
      };
      backgroundAddress = address;
      if (!pairingUrl) pairingUrl = await obtainUnreadPairingUrl();
      page = await newContext(width, `local-${width}`, true);
      await openWebTask(page, address);
      expect(bootstrapReplay).toMatchObject({
        replayed: true,
        epochChanged: true,
        staleReports: 0,
      });
      expect(bootstrapReplay!.droppedRequests).toBeGreaterThan(0);
      await beginDesktopTurn(address, `${CASE}_VISIBLE`);
      await completeViewed(page, address, "mro03-visible", "MRO03_VISIBLE_DONE");
      evidence[`${width}-visible`] = {
        address,
        marker: await waitMarker(address, false),
        view: await readMobileTaskView(),
      };

      if (width === 390) {
        // 桌面手动未读是用户提醒；Web 持续查看同一任务时，断点变化不能伪造离开和返回。
        const row = $(`[data-testid=${JSON.stringify(testId(TID_TASK_ITEM, address.taskId))}]`);
        await row.click({ button: "right" });
        let marked = false;
        for (const item of await $$('[role="menuitem"]')) {
          if (!/^(标记为未读|Mark as unread)$/u.test((await item.getText()).trim())) continue;
          await item.click();
          marked = true;
          break;
        }
        if (!marked) throw new Error("MRO03 mark-unread menu missing");
        const manualMarker = await waitMarker(address, true);
        for (const nextWidth of [1024, 390]) {
          await page.setViewportSize({ width: nextWidth, height: 900 });
          await page.locator(`[data-session-id=${JSON.stringify(address.taskId)}]`).waitFor();
          await page.waitForFunction(
            (narrow) => Boolean(document.querySelector('[data-mobile-page="chat"]')) === narrow,
            nextWidth < 768,
          );
          // 对持久 marker 做有界稳定性断言，捕获 resize 后异步到达的错误已读命令。
          const start = Date.now();
          await browser.waitUntil(
            async () => {
              expect((await readTask(address)).unreadAt).toBe(manualMarker);
              expect((await readMobileTaskView()).view?.taskId).toBe(address.taskId);
              return Date.now() - start >= 1_000;
            },
            { timeout: 5_000, interval: 100, timeoutMsg: "MRO03 resize cleared manual unread" },
          );
          await waitMarker(address, true);
        }
        await showMobileTaskHome(page);
        await waitMobileTaskView(null);
        await openWebTask(page, address);
        await waitMarker(address, false);
        evidence.resize = { manualMarker, retainedAcrossBreakpoint: true, clearedAfterHome: true };
      }

      await beginDesktopTurn(address, `${CASE}_HOME`);
      // 窄屏返回首页；宽屏通过插件市场离开会话，不能仅用聊天已挂载判断正在查看。
      if (width < 768) await showMobileTaskHome(page);
      else await page.getByRole("button", { name: /^(插件市场|Plugin Store)$/u }).click();
      await waitMobileTaskView(null);
      await releaseControlledReplay("mro03-home");
      const homeMarker = await waitMarker(address, true);
      await openWebTask(page, address);
      await waitMarker(address, false);
      evidence[`${width}-home`] = { marker: homeMarker, cleared: true };

      await beginDesktopTurn(address, `${CASE}_RECONNECT`);
      // 离开原页会真正关闭relay；返回保留该条浏览器history，不点击任务来代替自动已读。
      await page.goto("about:blank");
      await waitMobileTaskView(null);
      await releaseControlledReplay("mro03-reconnect");
      const disconnectedMarker = await waitMarker(address, true);
      await page.goBack({ waitUntil: "domcontentloaded" });
      await page
        .locator(`[data-session-id=${JSON.stringify(address.taskId)}]`)
        .waitFor({ timeout: 60_000 });
      await waitMobileTaskView(address);
      await waitMarker(address, false);
      evidence[`${width}-reconnect`] = { marker: disconnectedMarker, cleared: true };

      await showMobileTaskHome(page);
      await page.getByTestId(TID_TASK_NEW_BUTTON).first().click();
      await page.locator('[data-session-id="draft"]').waitFor();
      await waitMobileTaskView(null);
      await sendWeb(page, `${CASE}_PROMOTION`);
      const promotedId = await page
        .locator('[data-session-id]:not([data-session-id="draft"])')
        .first()
        .getAttribute("data-session-id");
      if (!promotedId) throw new Error("MRO03 Web draft did not become a task");
      // 新未归类草稿可由Host分配新目录，不能复用上一个任务的cwd冒充完整身份。
      const promoted: UnreadTaskAddress = await page.evaluate((taskId) => {
        const tabs = (
          window as Window & {
            __zcodeTabStoreE2E?: {
              getState(): {
                activeWorkspacePath: string | null;
                activeWorkspaceIdentity?: string | null;
              };
            };
          }
        ).__zcodeTabStoreE2E?.getState();
        if (!tabs?.activeWorkspacePath) throw new Error("MRO03 promoted workspace missing");
        return {
          taskId,
          workspacePath: tabs.activeWorkspacePath,
          ...(tabs.activeWorkspaceIdentity
            ? { workspaceIdentity: tabs.activeWorkspaceIdentity }
            : {}),
        };
      }, promotedId);
      await completeViewed(page, promoted, "mro03-promotion", "MRO03_PROMOTION_DONE");
      evidence[`${width}-promotion`] = {
        address: promoted,
        marker: await waitMarker(promoted, false),
      };
      await page.screenshot({ path: join(artifacts, `MRO03-local-${width}.png`) });
      await context!.close();
      context = undefined;
      page = undefined;
    }
  });

  it("MRO03 后台：原生Chrome实际hidden时完成写未读，visible后真实Reporter触发清除", async function () {
    this.timeout(5 * 60_000);
    if (!artifacts) throw new Error("MRO03 isolated artifacts required");
    if (!backgroundAddress) {
      // 允许用现有mocha grep单独定位真实可见性场景，仍通过UI建立自己的任务前置。
      await prepareSSHConnectionPage(CASE);
      await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
      await startNewV4Draft();
      await selectUpstreamModel();
      await selectUpstreamThoughtLevelValue("high");
      await installHandoffRpcProbe();
      await sendV4Prompt(`${CASE}_SEED: 只回复 MRO03_SEED_DONE`);
      await waitForV4AssistantMessageContaining("MRO03_SEED_DONE", 90_000);
      await waitForV4ConversationState(
        (state) => state.state === "idle" && Boolean(state.taskId),
        "MRO03 background seed incomplete",
        90_000,
      );
      const state = await getV4ConversationState();
      const tab = await readRemoteTabSnapshot();
      backgroundAddress = { taskId: state.taskId!, workspacePath: tab.activeWorkspacePath! };
      pairingUrl = await obtainUnreadPairingUrl();
    }
    await context?.close();
    context = undefined;
    page = undefined;
    const address = backgroundAddress;
    const native = await createWebRemoteVisibilityBrowser(artifacts);
    try {
      await native.navigate(pairingUrl, WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS);
      await browser.waitUntil(
        () =>
          native.evaluate<boolean>(
            'Boolean(document.querySelector(\'[data-testid="sidebar"], [data-testid="onboarding-page"], [data-mobile-page="chat"]\'))',
          ),
        { timeout: 60_000 },
      );
      if (
        await native.evaluate<boolean>(
          "Boolean(document.querySelector('[data-testid=\"onboarding-page\"]'))",
        )
      )
        await native.escape();
      const homeButton =
        'button[aria-label="返回任务首页"], button[aria-label="Back to task home"]';
      if (
        await native.evaluate<boolean>(
          `Boolean(document.querySelector(${JSON.stringify(homeButton)}))`,
        )
      )
        await native.click(homeButton);
      const row = `[data-testid=${JSON.stringify(testId(TID_TASK_ITEM, address.taskId))}]`;
      await browser.waitUntil(
        () => native.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(row)}))`),
        { timeout: 60_000 },
      );
      await native.click(row);
      await waitMobileTaskView(address);
      await beginDesktopTurn(address, `${CASE}_BACKGROUND`);
      await native.hide();
      await browser.waitUntil(
        async () => (await native.evaluate<string>("document.visibilityState")) === "hidden",
        { timeout: 15_000 },
      );
      await waitMobileTaskView(null);
      evidence.backgroundHidden = {
        visibility: await native.evaluate("document.visibilityState"),
        view: await readMobileTaskView(),
      };
      await releaseControlledReplay("mro03-background");
      const marker = await waitMarker(address, true);
      await native.show();
      await browser.waitUntil(
        async () => (await native.evaluate<string>("document.visibilityState")) === "visible",
        { timeout: 15_000 },
      );
      await waitMobileTaskView(address);
      await waitMarker(address, false);
      evidence.backgroundVisible = {
        marker,
        cleared: true,
        visibility: await native.evaluate("document.visibilityState"),
        view: await readMobileTaskView(),
      };
      await native.screenshot("MRO03-foreground-return.png");
    } catch (error) {
      const text = await native
        .evaluate<string>("document.body?.innerText ?? ''")
        .catch(() => "unavailable");
      evidence.backgroundFailure = {
        text: redactMobileDiagnosticText(text, pairingUrl),
        view: await readMobileTaskView(),
      };
      await native.screenshot("MRO03-background-failure.png").catch(() => undefined);
      throw error;
    } finally {
      await native.close();
    }
  });

  it("MRO03 SSH：前台远端完成不未读，离开完成后回看清除所属Source marker", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(`${CASE}_SSH`);
    provider = await createSSHLifecycleProvider(config, `${CASE}_SSH`, {
      apiType: "anthropic-messages",
    });
    const task = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: `${CASE}_SSH`,
      config,
      provider,
      label: "A",
      workspacePath: config.workspacePaths[0],
    });
    const address: UnreadTaskAddress = {
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      workspaceIdentity: task.identity,
      remoteSessionId: task.remoteSessionId,
    };
    page = await newContext(390, "ssh");
    await openWebTask(page, address);
    await beginDesktopTurn(address, `${CASE}_SSH_VISIBLE`);
    await completeViewed(page, address, "mro03-ssh-visible", "MRO03_SSH_VISIBLE_DONE");
    await beginDesktopTurn(address, `${CASE}_SSH_HOME`);
    await showMobileTaskHome(page);
    await waitMobileTaskView(null);
    await releaseControlledReplay("mro03-ssh-home");
    const marker = await waitMarker(address, true);
    await openWebTask(page, address);
    await waitMarker(address, false);
    evidence.ssh = { address, marker, cleared: true, view: await readMobileTaskView() };
    await page.screenshot({ path: join(artifacts!, "MRO03-ssh.png") });
  });
});
