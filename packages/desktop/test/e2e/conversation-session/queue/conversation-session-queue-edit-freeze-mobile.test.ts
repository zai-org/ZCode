// B09j/B09l/B09m 排队消息冻结编辑的多端边界（docs/ui/composer-edit-mode.md）。
// 证据层 L3：真实 Desktop + 真实手机 Web 配对，同一 CLI 队列投影。
// 1) 手机端编辑：手机 composer 进入编辑态，桌面同一项显示「正在其他窗口或设备编辑」与「解除」；
// 2) 队首冻结且空闲时，桌面新输入直接入队尾，不弹暂停队列确认（B09m）；
// 3) 桌面解除后，在线的手机端进入失效态（editLockLost），续跑从冻结项继续（B09j 在线）；
// 4) 暂停队列「清空队列并发送」删除冻结项，手机端进入失效态（queueItemRemoved）（B09l）；
// 5) 手机断开后锁保留，桌面手动解除，不依赖超时（B09j 离线）。
// 6) 断开前刷新手机页面：沿用同一 editorId 并自动释放遗留锁；复制手机标签页：复制页经 Web Lock
//    换新 editorId，不释放原页面的锁（B09k）。
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import {
  TID_TASK_ITEM,
  TID_V4_COMPOSER_EDIT_BAR,
  TID_V4_COMPOSER_EDIT_CANCEL,
  TID_V4_QUEUE_ITEM_EDIT,
  TID_V4_QUEUE_ITEM_EDIT_LOCK,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl } from "#e2e/helpers/web-remote-unread";
import { expectNoUpstreamRequestForTextWithin } from "#e2e/helpers/conversation-session-network";
import {
  clickV4QueueItemReleaseEdit,
  waitForV4QueueItemEditLock,
} from "#e2e/helpers/v4-composer-edit";
import {
  clickV4PausedQueueResume,
  clickV4Stop,
  getV4PaneSnapshot,
  getV4QueueItems,
  hasV4PausedQueueSendDialog,
  prepareV4ConversationE2E,
  sendV4PausedQueueClear,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
  waitForV4PausedQueueBanner,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "B09-MOBILE";

interface MobileEditBar {
  kind: string | null;
  targetId: string | null;
  state: string | null;
  invalidReason: string | null;
}

describe("B09 排队消息冻结编辑：桌面与手机", () => {
  let webBrowser: Browser | undefined;
  let mobileContext: BrowserContext | undefined;
  let mobile: Page | undefined;

  after(async () => {
    if (mobile && process.env.ZCODE_E2E_ARTIFACT_DIR)
      await mobile
        .screenshot({ path: join(process.env.ZCODE_E2E_ARTIFACT_DIR, "B09-mobile.png") })
        .catch(() => undefined);
    await webBrowser?.close();
    const pane = await getV4PaneSnapshot().catch(() => null);
    if (pane?.canStop) await clickV4Stop().catch(() => undefined);
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("手机编辑冻结 → 桌面入队尾 → 桌面解除 → 清空删除冻结项 → 手机断开后手动解除", async function () {
    this.timeout(360_000);
    await prepareV4ConversationE2E();
    await startNewV4Draft();

    await sendV4Prompt("E2E_QEFM_SLOW_1 慢慢回答");
    await waitForV4TimelineContaining("QEFM_1_STREAMING", 45_000);
    const running = await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== null && s.sessionId !== "draft",
      "首轮没有进入 running",
      45_000,
    );
    const taskId = running.sessionId!;
    await sendV4Prompt("E2E_QEFM_C 手机编辑的一条");
    await waitForV4QueueCount(1, 30_000);
    await sendV4Prompt("E2E_QEFM_D 之后的一条");
    await waitForV4QueueCount(2, 30_000);
    const [itemC, itemD] = await getV4QueueItems();
    if (!itemC || !itemD) throw new Error("队列项不完整");

    mobile = await openMobileTask(taskId);

    // 手机端编辑：手机进入编辑态，桌面显示其他设备持有的锁与「解除」。
    await mobileClick(mobile, testId(TID_V4_QUEUE_ITEM_EDIT, itemC.queueItemId));
    await waitForMobileEditBar(
      mobile,
      (bar) =>
        bar?.kind === "queueItem" && bar.targetId === itemC.queueItemId && bar.state === "editing",
      "手机端没有进入排队消息编辑态",
    );
    const remoteLock = await waitForV4QueueItemEditLock(
      itemC.queueItemId,
      (state) => state.locked && state.owner === "other",
      "桌面没有显示其他设备持有的编辑锁",
    );
    expect(remoteLock).toMatchObject({ releasable: true, editAction: false, deleteAction: false });

    // B09m：当前轮结束后队首冻结且空闲；桌面新输入直接入队尾，不弹暂停队列确认。
    await releaseControlledReplay("qefm-slow-1");
    await waitForV4Pane((s) => !s.canStop, "首轮结束后没有停在冻结队首前", 45_000);
    await expectNoUpstreamRequestForTextWithin("E2E_QEFM_C", 1_500);
    await sendV4Prompt("E2E_QEFM_E 冻结时的新输入");
    await waitForV4QueueCount(3, 30_000);
    expect(await hasV4PausedQueueSendDialog()).toBe(false);
    expect((await getV4QueueItems()).map((item) => item.queueItemId).slice(0, 2)).toEqual([
      itemC.queueItemId,
      itemD.queueItemId,
    ]);

    // B09j 在线：桌面解除后手机进入失效态，续跑从 C 继续，然后 D、E。
    await clickV4QueueItemReleaseEdit(itemC.queueItemId);
    // 解除后队首 C 立即被自动续跑提升并离开队列。手机只按当前投影派生失效原因：
    // 先收到解锁投影时为 editLockLost，解锁与提升合并到达时直接为 queueItemRemoved。
    // 两者都是正确终态（编辑失效、发送作为新消息），不断言中间态。
    await waitForMobileEditBar(
      mobile,
      (bar) =>
        bar?.state === "invalid" &&
        (bar.invalidReason === "editLockLost" || bar.invalidReason === "queueItemRemoved"),
      "桌面解除后手机端没有进入失效态",
    );
    await waitForV4TimelineContaining("QEFM_C_REPLY", 45_000);
    await waitForV4TimelineContaining("QEFM_D_REPLY", 45_000);
    await waitForV4TimelineContaining("QEFM_E_REPLY", 45_000);
    await waitForV4QueueCount(0, 30_000);
    await mobileClick(mobile, TID_V4_COMPOSER_EDIT_CANCEL);
    await waitForMobileEditBar(mobile, (bar) => bar === null, "手机端取消后没有退出编辑态");

    // B09l：Stop 形成暂停队列；手机编辑 F，桌面「清空队列并发送」删除 F，手机进入失效态。
    await sendV4Prompt("E2E_QEFM_SLOW_2 慢慢回答");
    await waitForV4TimelineContaining("QEFM_2_STREAMING", 45_000);
    await waitForV4Pane((s) => s.canStop, "第二轮没有进入 running", 45_000);
    await sendV4Prompt("E2E_QEFM_F 将被清空的一条");
    await waitForV4QueueCount(1, 30_000);
    const [itemF] = await getV4QueueItems();
    if (!itemF) throw new Error("F 队列项不存在");
    await clickV4Stop();
    await waitForV4Pane((s) => !s.canStop, "Stop 后没有收口", 30_000);
    await mobileClick(mobile, testId(TID_V4_QUEUE_ITEM_EDIT, itemF.queueItemId));
    await waitForMobileEditBar(
      mobile,
      (bar) => bar?.targetId === itemF.queueItemId && bar.state === "editing",
      "手机端没有进入 F 的编辑态",
    );
    await waitForV4QueueItemEditLock(
      itemF.queueItemId,
      (state) => state.locked && state.owner === "other",
      "桌面没有显示 F 的远端编辑锁",
    );
    await sendV4PausedQueueClear("E2E_QEFM_H 清空后发送");
    await waitForV4TimelineContaining("QEFM_H_REPLY", 45_000);
    await waitForV4QueueCount(0, 30_000);
    await waitForMobileEditBar(
      mobile,
      (bar) => bar?.state === "invalid" && bar.invalidReason === "queueItemRemoved",
      "冻结项被清空后手机端没有进入失效态",
    );
    await mobileClick(mobile, TID_V4_COMPOSER_EDIT_CANCEL);
    await waitForMobileEditBar(mobile, (bar) => bar === null, "手机端取消后没有退出编辑态");

    // B09j 离线：手机编辑 J 后断开，锁保留；桌面手动解除后续跑继续。
    await sendV4Prompt("E2E_QEFM_SLOW_3 慢慢回答");
    await waitForV4TimelineContaining("QEFM_3_STREAMING", 45_000);
    await waitForV4Pane((s) => s.canStop, "第三轮没有进入 running", 45_000);
    await sendV4Prompt("E2E_QEFM_J 断开时冻结的一条");
    await waitForV4QueueCount(1, 30_000);
    const [itemJ] = await getV4QueueItems();
    if (!itemJ) throw new Error("J 队列项不存在");
    await mobileClick(mobile, testId(TID_V4_QUEUE_ITEM_EDIT, itemJ.queueItemId));
    await waitForV4QueueItemEditLock(
      itemJ.queueItemId,
      (state) => state.locked && state.owner === "other",
      "桌面没有显示 J 的远端编辑锁",
    );
    // B09k（刷新）：手机页面刷新后沿用同一 editorId（Web Lock 随旧文档卸载释放，新文档能重新取得），
    // 发现自己的遗留锁并自动释放；随后重新进入编辑，供下面的复制标签页与断开步骤使用。
    const editorIdKey = "zcode-v4-editor-id:v1";
    const editorIdBeforeReload = await mobile!.evaluate(
      (key) => sessionStorage.getItem(key),
      editorIdKey,
    );
    await mobile!.reload();
    // 刷新可能直接恢复到原任务，也可能回到任务首页；回到首页时点进同一任务。
    const reloadedSession = mobile!.locator(`[data-session-id="${taskId}"]`);
    const reloadedTaskItem = mobile!.getByTestId(testId(TID_TASK_ITEM, taskId)).first();
    await reloadedSession.or(reloadedTaskItem).first().waitFor({ timeout: 45_000 });
    if (!(await reloadedSession.isVisible())) {
      await reloadedTaskItem.tap();
      await reloadedSession.waitFor();
    }
    await waitForV4QueueItemEditLock(
      itemJ.queueItemId,
      (state) => state.exists && !state.locked,
      "手机刷新后没有自动释放自己的遗留锁",
    );
    expect(await mobile!.evaluate((key) => sessionStorage.getItem(key), editorIdKey)).toBe(
      editorIdBeforeReload,
    );
    await mobileClick(mobile!, testId(TID_V4_QUEUE_ITEM_EDIT, itemJ.queueItemId));
    await waitForV4QueueItemEditLock(
      itemJ.queueItemId,
      (state) => state.locked && state.owner === "other",
      "手机刷新后重新编辑 J 没有加锁",
    );
    // B09k（复制标签页）：浏览器复制标签页会连同 sessionStorage 复制 editorId。复制页不能把原页面
    // 正在编辑的锁当成自己的遗留锁释放；它经 Web Lock 查重后换新 id，并把该锁显示为可解除的其他端锁。
    // 远控同一设备只保留一个在线控制端，复制页会接管连接；原页面随后在本步骤断开，不再对它断言。
    const sharedEditorId = await mobile!.evaluate(
      (key) => sessionStorage.getItem(key),
      editorIdKey,
    );
    expect(sharedEditorId).toBeTruthy();
    const duplicate = await mobileContext!.newPage();
    await duplicate.addInitScript(
      ([key, value]) => {
        if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value);
      },
      [editorIdKey, sharedEditorId!] as const,
    );
    // 手机 URL 不含任务路由（任务由页内点击打开），复制页与原页一样从任务首页点进同一任务。
    await duplicate.goto(mobile!.url());
    await duplicate.getByTestId(testId(TID_TASK_ITEM, taskId)).first().tap();
    const duplicateLock = duplicate.getByTestId(
      testId(TID_V4_QUEUE_ITEM_EDIT_LOCK, itemJ.queueItemId),
    );
    await duplicateLock.waitFor({ timeout: 45_000 });
    expect(await duplicateLock.getAttribute("data-edit-lock-owner")).toBe("other");
    await duplicate.waitForFunction(
      ([key, shared]) => {
        const current = sessionStorage.getItem(key);
        return current !== null && current !== shared;
      },
      [editorIdKey, sharedEditorId!] as const,
    );
    await mobileContext?.close();
    mobileContext = undefined;
    mobile = undefined;

    // B09l 的 Stop 让 autoDrain=false，「清空队列并发送」不改变它；第三轮结束后队列暂停。
    await releaseControlledReplay("qefm-slow-3");
    await waitForV4Pane((s) => !s.canStop, "第三轮没有收口", 45_000);
    await waitForV4PausedQueueBanner(30_000);
    await expectNoUpstreamRequestForTextWithin("E2E_QEFM_J", 1_500);
    // 不使用超时释放：手机断开后锁仍在，必须由用户手动解除。
    const stillLocked = await waitForV4QueueItemEditLock(
      itemJ.queueItemId,
      (state) => state.locked && state.owner === "other" && state.releasable,
      "手机断开后锁没有保留",
    );
    expect(stillLocked.lockText.length).toBeGreaterThan(0);
    await clickV4QueueItemReleaseEdit(itemJ.queueItemId);
    await waitForV4QueueItemEditLock(
      itemJ.queueItemId,
      (state) => state.exists && !state.locked && state.editAction,
      "桌面手动解除后锁没有消失",
    );
    await clickV4PausedQueueResume();
    await waitForV4TimelineContaining("QEFM_J_REPLY", 45_000);
    await waitForV4QueueCount(0, 30_000);
  });

  async function openMobileTask(taskId: string): Promise<Page> {
    const pairingUrl = await obtainUnreadPairingUrl(
      new URL(process.env.ZCODE_WEB_REMOTE_CONTROL_URL!).origin,
    );
    webBrowser = await chromium.launch({
      ...(process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
      headless: true,
      args: process.env.ZCODE_E2E_BROWSER_NO_PROXY === "1" ? ["--no-proxy-server"] : [],
    });
    mobileContext = await webBrowser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
    });
    await seedMobileFixtureLogin(mobileContext);
    const page = await mobileContext.newPage();
    await openMobilePairingPage(page, pairingUrl, {
      artifactDir: process.env.ZCODE_E2E_ARTIFACT_DIR!,
      caseMarker: CASE_MARKER,
      phase: "pair",
      readySelector: `[data-testid="${testId(TID_TASK_ITEM, taskId)}"]`,
    });
    await page.getByTestId(testId(TID_TASK_ITEM, taskId)).first().tap();
    await page.locator(`[data-session-id="${taskId}"]`).waitFor();
    return page;
  }
});

/** 队列行操作在触屏上常显；DOM click 与桌面 clickTestIdByDom 一样走 React onClick。 */
async function mobileClick(page: Page, testIdValue: string) {
  await page.waitForFunction(
    (value) => {
      const button = document.querySelector<HTMLButtonElement>(`[data-testid="${value}"]`);
      if (!button || button.disabled) return false;
      button.click();
      return true;
    },
    testIdValue,
    { timeout: 30_000 },
  );
}

function readMobileEditBar(page: Page): Promise<MobileEditBar | null> {
  return page.evaluate((barTestId) => {
    const bar = document.querySelector<HTMLElement>(`[data-testid="${barTestId}"]`);
    if (!bar) return null;
    return {
      kind: bar.getAttribute("data-edit-target-kind"),
      targetId: bar.getAttribute("data-edit-target-id"),
      state: bar.getAttribute("data-edit-state"),
      invalidReason: bar.getAttribute("data-edit-invalid-reason"),
    };
  }, TID_V4_COMPOSER_EDIT_BAR);
}

async function waitForMobileEditBar(
  page: Page,
  predicate: (bar: MobileEditBar | null) => boolean,
  timeoutMsg: string,
) {
  let latest: MobileEditBar | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await readMobileEditBar(page);
        return predicate(latest);
      },
      { timeout: 30_000, timeoutMsg },
    );
  } catch (error) {
    throw new Error(`${timeoutMsg}: ${JSON.stringify(latest)}`, { cause: error });
  }
}
