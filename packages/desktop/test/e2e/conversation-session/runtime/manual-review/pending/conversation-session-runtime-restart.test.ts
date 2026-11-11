import { chromium, type Browser, type Page } from "playwright-core";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import {
  TID_WORKSPACE_MORE_BUTTON,
  TID_TASK_ITEM,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import {
  getUpstreamRequestRecordCount,
  getUpstreamRequestEvidence,
} from "#e2e/helpers/conversation-session-network";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl } from "#e2e/helpers/web-remote-unread";
import { DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  waitForUpstreamNetworkCapture,
  waitForUpstreamNetworkRequestStarted,
} from "#e2e/helpers/upstream-capture";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ConversationState,
  waitForV4ComposerText,
  getV4ConversationState,
  setV4ComposerText,
  getV4Messages,
  getV4ComposerAttachments,
  getV4ComposerBackgroundWorkCounts,
  pasteV4ComposerImageAttachment,
  E2E_REPLY_TOKEN,
  waitForV4AssistantMessageContaining,
  waitForV4PermissionDialog,
  approveV4Permission,
} from "#e2e/helpers/v4-conversation";

describe("单任务运行实例重启", () => {
  let webBrowser: Browser | undefined;
  let mobile: Page | undefined;
  let fixtureServer: Server;
  let fixtureUrl: string;
  before(async () => {
    fixtureServer = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        '<!doctype html><title>Session Browser Restart</title><label>State <input id="state"></label>',
      );
    });
    await new Promise<void>((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
    fixtureUrl = `http://127.0.0.1:${(fixtureServer.address() as AddressInfo).port}/restart`;
  });
  after(async () => {
    if (mobile && process.env.ZCODE_E2E_ARTIFACT_DIR)
      await mobile
        .screenshot({ path: join(process.env.ZCODE_E2E_ARTIFACT_DIR, "SLR-mobile.png") })
        .catch(() => undefined);
    await webBrowser?.close();
    await browser.electron.execute((electron, url) => {
      for (const guest of electron.webContents.getAllWebContents()) {
        if (!guest.isDestroyed() && guest.getURL() === url)
          guest.close({ waitForBeforeUnload: false });
      }
    }, fixtureUrl);
    if (fixtureServer?.listening)
      await new Promise<void>((resolve, reject) =>
        fixtureServer.close((error) => (error ? reject(error) : resolve())),
      );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("SLR01–03/05/06/09–11 菜单、/reload 与手机重启保留历史和网页，关闭所属工作", async function () {
    this.timeout(480000);
    await prepareV4ConversationE2E();
    const marker = `E2E_SESSION_RESTART_${Date.now()}`;
    await sendV4Prompt(`${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`);
    await waitForUpstreamNetworkCapture(marker);
    await waitForV4ConversationState((s) => s.state === "idle", "首轮未完成", 90000);
    const sessionId = (await getV4ConversationState()).taskId;
    if (!sessionId) throw new Error("缺少持久任务身份");
    const selector = `[data-session-id="${sessionId}"]`;
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
    const project = `[data-project-name="${basename(DEFAULT_WORKSPACE)}"]`;
    await openMobilePairingPage(mobile, pairingUrl, {
      artifactDir: process.env.ZCODE_E2E_ARTIFACT_DIR!,
      caseMarker: "SLR03",
      phase: "restart",
      readySelector: project,
    });
    const toggle = mobile.locator(project).getByTestId("virtual-project-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.tap();
    await mobile.getByTestId(testId(TID_TASK_ITEM, sessionId)).first().tap();
    await mobile.locator(selector).waitFor();
    await browser.execute(observeLifecycleBanners);
    await mobile.evaluate(observeLifecycleBanners);
    // 标题入口保留已有草稿；两个真实客户端都必须切到新实例。
    await setV4ComposerText("重启期间保留的草稿");
    await $(`[data-testid="${TID_WORKSPACE_MORE_BUTTON}"]`).click();
    // 必须确实命中标题仍在飞的窗口，不能把正常结束后的重启算作取消覆盖。
    const titleRequests = await getUpstreamRequestEvidence({
      includeTitle: true,
      includes: [marker, "Generate a concise title"],
    });
    expect(titleRequests).toHaveLength(1);
    expect(titleRequests[0]?.status).toBe("pending");
    expect(titleRequests[0]?.fixtureId).toBe("conversation-session-stop-empty-title-sidecar");
    await $('[data-testid="task-restart"]').click();
    await browser.waitUntil(
      async () =>
        (await $(selector).getAttribute("data-session-lifecycle")) === "ready" &&
        Number(await $(selector).getAttribute("data-session-generation")) >= 2,
      { timeout: 60000 },
    );
    await waitForV4ComposerText("重启期间保留的草稿", "菜单重启丢失草稿");
    await mobile.waitForFunction((query) => {
      const pane = document.querySelector(query);
      return (
        pane?.getAttribute("data-session-lifecycle") === "ready" &&
        Number(pane.getAttribute("data-session-generation")) >= 2
      );
    }, selector);
    // AppSlashCommand 是操作菜单：正文与附件不作为参数，不应隐藏重启选项。
    const userRows = await getV4Messages("user");
    const requestsBeforeReload = await getUpstreamRequestRecordCount();
    await pasteV4ComposerImageAttachment("e2e-reload-draft.png");
    await browser.waitUntil(
      async () => (await getV4ComposerAttachments())[0]?.uploadStatus === "ready",
      { timeout: 30000 },
    );
    const attachments = await getV4ComposerAttachments();
    await setV4ComposerText("保留正文 /reload");
    const reloadOption = $('[data-option-id="app-slash:reload"]');
    await reloadOption.waitForDisplayed({ timeout: 10000 });
    expect(await reloadOption.getText()).toContain("/reload");
    expect(await reloadOption.getText()).toContain(
      "Reload the task runtime, preserving history and stopping current execution.",
    );
    await reloadOption.click();
    await browser.waitUntil(
      async () =>
        (await $(selector).getAttribute("data-session-lifecycle")) === "ready" &&
        Number(await $(selector).getAttribute("data-session-generation")) >= 3,
      { timeout: 60000 },
    );
    await waitForV4ComposerText("保留正文 ", "面板重启没有保留正文");
    expect(await getV4ComposerAttachments()).toEqual(attachments);
    expect(await getV4Messages("user")).toEqual(userRows);
    await setV4ComposerText("键盘保留正文 /reload");
    await reloadOption.waitForDisplayed({ timeout: 10000 });
    await browser.keys("Enter");
    await browser.waitUntil(
      async () =>
        (await $(selector).getAttribute("data-session-lifecycle")) === "ready" &&
        Number(await $(selector).getAttribute("data-session-generation")) >= 4,
      { timeout: 60000 },
    );
    await waitForV4ComposerText("键盘保留正文 ", "键盘选择重启没有保留正文");
    expect(await getV4ComposerAttachments()).toEqual(attachments);
    await $("[data-composer-attachment-remove]").click();
    await setV4ComposerText("");
    await sendV4Prompt("/reload");
    await waitForV4ComposerText("", "本地重启命令未消费");
    await browser.waitUntil(
      async () => {
        const current = await $(selector);
        return (
          (await current.getAttribute("data-session-id")) === sessionId &&
          (await current.getAttribute("data-session-lifecycle")) === "ready" &&
          Number(await current.getAttribute("data-session-generation")) >= 5
        );
      },
      { timeout: 60000, timeoutMsg: "同一任务的新实例没有就绪" },
    );
    await mobile.waitForFunction((query) => {
      const pane = document.querySelector(query);
      return (
        pane?.getAttribute("data-session-lifecycle") === "ready" &&
        Number(pane.getAttribute("data-session-generation")) >= 5
      );
    }, selector);
    // 手机使用真实触屏选择同一 AppSlashCommand；草稿属于手机，不应同步到桌面。
    const mobileInput = mobile.getByTestId(TID_V4_COMPOSER_INPUT);
    await mobileInput.fill("手机保留正文 /reload");
    const mobileReload = mobile.locator('[data-option-id="app-slash:reload"]');
    await mobileReload.waitFor();
    expect(await mobileReload.innerText()).toContain("/reload");
    expect(await mobileReload.innerText()).toContain(
      "Reload the task runtime, preserving history and stopping current execution.",
    );
    await mobileReload.tap();
    await mobile.waitForFunction((query) => {
      const pane = document.querySelector(query);
      return (
        pane?.getAttribute("data-session-lifecycle") === "ready" &&
        Number(pane.getAttribute("data-session-generation")) >= 6
      );
    }, selector);
    expect(await mobileInput.innerText()).toBe("手机保留正文 ");
    await mobileInput.fill("");
    await browser.waitUntil(
      async () =>
        (await $(selector).getAttribute("data-session-lifecycle")) === "ready" &&
        Number(await $(selector).getAttribute("data-session-generation")) >= 6,
      { timeout: 60000 },
    );
    expect(await getV4Messages("user")).toEqual(userRows);
    expect(await getUpstreamRequestRecordCount()).toBe(requestsBeforeReload);
    // 真实运行中的模型流和队列都属于旧实例；由手机发起重启，桌面被动恢复。
    await sendV4Prompt(`E2E_SESSION_RESTART_RUNNING: Keep streaming until cancelled.`);
    await waitForUpstreamNetworkRequestStarted("E2E_SESSION_RESTART_RUNNING");
    await waitForV4ConversationState((s) => s.state === "streaming", "没有进入生成中", 30000);
    await sendV4Prompt("E2E_SESSION_RESTART_QUEUED: this input must be discarded by restart.");
    await waitForV4ConversationState((s) => s.queueCount === 1, "输入没有排队", 30000);
    await mobile.getByTestId(TID_WORKSPACE_MORE_BUTTON).tap();
    await mobile.getByTestId("task-restart").tap();
    await browser.waitUntil(
      async () =>
        (await $(selector).getAttribute("data-session-lifecycle")) === "ready" &&
        Number(await $(selector).getAttribute("data-session-generation")) >= 7,
      { timeout: 60000 },
    );
    await waitForV4ConversationState(
      (s) => s.state === "idle" && s.queueCount === 0,
      "重启后旧执行或队列仍然活跃",
      30000,
    );
    await mobile.waitForFunction((query) => {
      const pane = document.querySelector(query);
      return (
        pane?.getAttribute("data-session-lifecycle") === "ready" &&
        Number(pane.getAttribute("data-session-generation")) >= 7
      );
    }, selector);
    const next = `${marker}_NEXT`;
    await sendV4Prompt(`${next}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`);
    const nextRequest = await waitForUpstreamNetworkCapture(next);
    expect(JSON.stringify(nextRequest.requestJson)).not.toContain("/reload");
    expect(JSON.stringify(nextRequest.requestJson)).not.toContain("E2E_SESSION_RESTART_QUEUED");
    await waitForV4ConversationState((s) => s.state === "idle", "重启后续发失败", 90000);
    await expect($("body")).toHaveText(expect.stringContaining(marker));
    // 父 turn 已结束不代表后台子代理已结束；两种客户端入口都必须关闭它。
    for (const [index, source] of ["desktop", "mobile"].entries()) {
      const ownerMarker = `E2E_OWNED_RESTART_${source.toUpperCase()}`;
      await sendV4Prompt(`${ownerMarker}: start the requested background agent.`);
      await waitForUpstreamNetworkRequestStarted(`${ownerMarker}_CHILD`);
      await waitForV4ConversationState((state) => state.state === "idle", "父任务未结束", 60000);
      await browser.waitUntil(
        async () => (await getV4ComposerBackgroundWorkCounts())?.subagentCount === 1,
        { timeout: 30000, timeoutMsg: "后台子代理未保持运行" },
      );
      // row id 是投影序号，重建快照后可变化；验证用户可见正文及顺序。
      const history = (await getV4Messages("user")).map(({ text }) => text);
      if (source === "desktop") {
        await $(`[data-testid="${TID_WORKSPACE_MORE_BUTTON}"]`).click();
        await $('[data-testid="task-restart"]').click();
      } else {
        await mobile.getByTestId(TID_WORKSPACE_MORE_BUTTON).tap();
        await mobile.getByTestId("task-restart").tap();
      }
      const generation = 8 + index;
      await browser.waitUntil(
        async () =>
          (await $(selector).getAttribute("data-session-lifecycle")) === "ready" &&
          Number(await $(selector).getAttribute("data-session-generation")) >= generation,
        { timeout: 60000, timeoutMsg: "所属工作关闭后未恢复" },
      );
      await browser.waitUntil(
        async () => ((await getV4ComposerBackgroundWorkCounts())?.subagentCount ?? 0) === 0,
        { timeout: 30000, timeoutMsg: "重启后仍显示运行中的子代理" },
      );
      await mobile.waitForFunction(
        ({ query, generation }) => {
          const pane = document.querySelector(query);
          const counter = pane?.querySelector("[data-background-subagent-count]");
          return (
            pane?.getAttribute("data-session-lifecycle") === "ready" &&
            Number(pane.getAttribute("data-session-generation")) >= generation &&
            Number(counter?.getAttribute("data-background-subagent-count") ?? 0) === 0
          );
        },
        { query: selector, generation },
      );
      expect((await getV4Messages("user")).map(({ text }) => text)).toEqual(history);
      const previousReply = (await getV4Messages("assistant")).at(-1)?.id;
      await sendV4Prompt(`${marker}_NEXT: Reply with exactly "${E2E_REPLY_TOKEN}".`);
      // 发送入队之前也可能短暂 idle；必须观察新回复，不能把旧 idle 当作续发完成。
      await browser.waitUntil(
        async () => {
          const reply = (await getV4Messages("assistant")).at(-1);
          return Boolean(
            reply && reply.id !== previousReply && reply.text.includes(E2E_REPLY_TOKEN),
          );
        },
        { timeout: 60000, timeoutMsg: "关闭子代理后没有收到新回复" },
      );
      await waitForV4ConversationState(
        (state) => state.state === "idle",
        "关闭子代理后不能续发",
        60000,
      );
    }
    // 三次真实 Browser JS 调用跨过桌面、手机重启，证明网页保留且新实例能继续控制。
    let guestId: number | undefined;
    for (const source of ["desktop", "mobile", "after"] as const) {
      const browserMarker = `E2E_BROWSER_RESTART_${source.toUpperCase()}`;
      await sendV4Prompt(
        `${browserMarker}: use the browser. E2E_BROWSER_FIXTURE_URL:${fixtureUrl}`,
      );
      await waitForV4PermissionDialog();
      await approveV4Permission();
      await waitForV4AssistantMessageContaining(`${browserMarker}_DONE`, 90000);
      await waitForV4ConversationState(
        (state) => state.state === "idle",
        "浏览器操作未完成",
        60000,
      );
      const before = await readRestartBrowser(fixtureUrl);
      expect(before).toHaveLength(1);
      expect(before[0]?.value).toBe(source);
      if (guestId !== undefined) expect(before[0]?.id).toBe(guestId);
      guestId = before[0]?.id;
      if (source === "desktop") {
        // 必须在重启/释放之前续发；显式重新认领 user tab 无法覆盖受控页的 ambient 查询。
        const ambientMarker = "E2E_BROWSER_AMBIENT_NEXT";
        await sendV4Prompt(`${ambientMarker}: report browser context.`);
        await waitForV4AssistantMessageContaining(`${ambientMarker}_DONE`, 60000);
        await waitForV4ConversationState(
          (state) => state.state === "idle",
          "ambient 续发未完成",
          60000,
        );
        await waitForUpstreamNetworkCapture(ambientMarker);
        const requests = await getUpstreamRequestEvidence({
          lastUserMessageIncludes: [ambientMarker],
        });
        const request = requests.find((entry) => entry.fixtureId === "browser-ambient-next");
        expect(request).toBeDefined();
        const wire = JSON.stringify(request!.requestJson);
        expect(wire).toContain("ambient-ui-state");
        expect(wire).toContain("browser open with 1 tab");
        expect(wire).toContain(`Current URL: ${fixtureUrl}`);
        expect(await readRestartBrowser(fixtureUrl)).toEqual(before);
      }
      if (source === "after") break;
      const generation = Number(await $(selector).getAttribute("data-session-generation"));
      if (source === "desktop") {
        await $(`[data-testid="${TID_WORKSPACE_MORE_BUTTON}"]`).click();
        await $('[data-testid="task-restart"]').click();
      } else {
        await mobile.getByTestId(TID_WORKSPACE_MORE_BUTTON).tap();
        await mobile.getByTestId("task-restart").tap();
      }
      await browser.waitUntil(
        async () =>
          (await $(selector).getAttribute("data-session-lifecycle")) === "ready" &&
          Number(await $(selector).getAttribute("data-session-generation")) > generation,
        { timeout: 60000, timeoutMsg: "浏览器控制资源释放失败" },
      );
      await mobile.waitForFunction(
        ({ query, generation }) => {
          const pane = document.querySelector(query);
          return (
            pane?.getAttribute("data-session-lifecycle") === "ready" &&
            Number(pane.getAttribute("data-session-generation")) > generation
          );
        },
        { query: selector, generation },
      );
      expect(await readRestartBrowser(fixtureUrl)).toEqual(before);
    }
    await setV4ComposerText("/plan");
    const planOption = $('[data-option-id="app-slash:plan"]');
    await planOption.waitForDisplayed();
    expect(await planOption.getText()).toContain("/plan");
    await browser.keys("Escape");
    await setV4ComposerText("");
    expect(await browser.execute(readLifecycleBannerCount)).toBe(0);
    expect(await mobile.evaluate(readLifecycleBannerCount)).toBe(0);
    for (const theme of ["light", "dark"]) {
      await browser.execute((value) => {
        const actions = (
          window as typeof window & { __testActions?: { setTheme?: (theme: string) => void } }
        ).__testActions;
        if (!actions?.setTheme) throw new Error("缺少主题测试入口");
        actions.setTheme(value);
      }, theme);
      await $(`[data-testid="${TID_WORKSPACE_MORE_BUTTON}"]`).click();
      await $('[data-testid="task-restart"]').waitForDisplayed();
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `SLR-menu-${theme}.png`),
      );
      // 模态菜单会禁用页面命中；通过真实指针点击菜单外关闭，再等待关闭状态。
      await browser.action("pointer").move({ x: 1100, y: 400 }).down().up().perform();
      await $('[data-testid="task-restart"]').waitForDisplayed({ reverse: true });
      await setV4ComposerText("/reload");
      await reloadOption.waitForDisplayed();
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `SLR-reload-${theme}.png`),
      );
      await browser.keys("Escape");
      await setV4ComposerText("");
    }
  });
});

// 观察整个真实重启过程，不能只在 ready 后断言提示已消失。
function observeLifecycleBanners() {
  const target = window as typeof window & { __lifecycleBannerCount?: number };
  target.__lifecycleBannerCount = 0;
  new MutationObserver(() => {
    if (document.querySelector('[data-testid="session-restarting"]'))
      target.__lifecycleBannerCount! += 1;
  }).observe(document.body, { childList: true, subtree: true });
  if (document.querySelector('[data-testid="session-restarting"]'))
    target.__lifecycleBannerCount! += 1;
}
function readLifecycleBannerCount() {
  return (window as typeof window & { __lifecycleBannerCount?: number }).__lifecycleBannerCount;
}

function readRestartBrowser(url: string): Promise<Array<{ id: number; value: string }>> {
  return browser.electron.execute(async (electron, targetUrl) => {
    const guests = electron.webContents
      .getAllWebContents()
      .filter((guest) => !guest.isDestroyed() && guest.getURL() === targetUrl);
    return await Promise.all(
      guests.map(async (guest) => ({
        id: guest.id,
        value: (await guest.executeJavaScript("document.querySelector('#state')?.value")) as string,
      })),
    );
  }, url) as unknown as Promise<Array<{ id: number; value: string }>>;
}
