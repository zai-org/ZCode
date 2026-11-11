import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import {
  expectQueueFreezeEditWithoutFlash,
  finishQueueEditVisualProbe,
  startQueueEditVisualProbe,
} from "#e2e/helpers/queue-edit-visual";
// M4 门禁：queue 单项管理 + B09 冻结编辑（docs/ui/composer-edit-mode.md）。
// 证据层 L3：running turn 期间 sendText 入队 → QueuePanel → 编辑时 lockQueueItemEdit 原位冻结 →
// composer 暂存原草稿并载入 text + AttachmentRef[] → 发送走 editQueueItem 原地替换（ID 不变）
// 或取消解锁；两条路径都恢复原草稿。删除与重排仍回到 CLI 权威投影。
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  clickV4ComposerEditCancel,
  getV4QueueItemEditLock,
  waitForV4ComposerEditClosed,
  waitForV4ComposerEditState,
  waitForV4QueueItemEditLock,
} from "#e2e/helpers/v4-composer-edit";
import {
  clickV4Stop,
  clickV4QueueItemDelete,
  dragV4QueueItemOnto,
  clickV4QueueItemEdit,
  getV4ComposerAttachments,
  getV4ComposerText,
  getV4PaneSnapshot,
  getV4QueueItems,
  isV4ComposerFocused,
  prepareV4ConversationE2E,
  pasteV4ComposerImageAttachment,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4ComposerText,
  waitForV4Pane,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("v4 M4/B09 门禁：queue 单项管理与冻结编辑", () => {
  afterEach(async () => {
    const snapshot = await getV4PaneSnapshot();
    if (!snapshot.canStop) return;
    // 修复原因：controlled stream 会跨 case 存活 45 秒；不主动 stop 会让上一条
    // active runtime 与下一条 draft 并行，并在结尾 drain 残留 queue，污染模型/fixture。
    await clickV4Stop();
    await waitForV4Pane((next) => !next.canStop, "queue operation case 收尾 stop 没有完成", 30000);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("running 中入队一条 → QueuePanel 显示 → 删除 → 队列清空", async () => {
    await prepareV4ConversationE2E();

    // 首轮：可控慢流，保持 running
    await sendV4Prompt("E2E_V4_QUEUE_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有进入 running（canStop）",
      45000,
    );

    // running 中发第二条 → 入队
    await sendV4Prompt("E2E_V4_QUEUE_ITEM 排队的问题");
    await waitForV4QueueCount(1, 30000);
    const before = await getV4QueueItems();
    expect(before).toHaveLength(1);
    expect(before[0]!.text).toContain("E2E_V4_QUEUE_ITEM");

    // 删除该队列项 → 队列清空
    const clicked = await clickV4QueueItemDelete(before[0]!.queueItemId);
    expect(clicked).toBe(true);
    await waitForV4QueueCount(0, 30000);
    expect(await getV4QueueItems()).toHaveLength(0);
  });

  it("B09/B09b/B09e：带图片入队 → 有草稿时编辑 → 原位冻结 → 修改后发送原地替换并恢复草稿", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_QUEUE_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有进入 running（canStop）",
      45000,
    );

    await pasteV4ComposerImageAttachment("e2e-queue-edit.png");
    await sendV4Prompt("E2E_V4_QUEUE_ITEM 排队原文");
    await waitForV4QueueCount(1, 30000);
    const before = await getV4QueueItems();
    expect(before[0]!.text).toContain("排队原文");
    const queueItemId = before[0]!.queueItemId;

    // B09：composer 已有草稿也可以编辑；草稿由编辑态暂存，不再提示冲突。
    await setV4ComposerText("保留现有草稿");

    // 同一事件循环连点两次，验证 lock 请求期间的 operation lock 在 React 重渲染前生效，
    // 只进入一次编辑态。
    // B09g：单次点击前启动逐帧采样，验证加锁中 → 本端占位之间不回到普通行、不重挂队列。
    await browser.execute(startQueueEditVisualProbe, queueItemId);
    const clicked = await clickV4QueueItemEdit(queueItemId, 2);
    expect(clicked).toBe(true);
    await waitForV4ComposerEditState(
      (state) =>
        state?.kind === "queueItem" &&
        state.targetId === queueItemId &&
        state.state === "editing" &&
        state.hasCancel,
      "queue 项没有进入 composer 编辑态",
      30000,
    );
    // 队列项留在原位，显示「正在下方编辑」，并隐藏本行操作。
    const locked = await waitForV4QueueItemEditLock(
      queueItemId,
      (state) => state.locked && state.owner === "self",
      "queue 项没有原位冻结",
    );
    expect(locked.lockText.length).toBeGreaterThan(0);
    expect(locked.editAction).toBe(false);
    expect(locked.deleteAction).toBe(false);
    expect(locked.sendNowAction).toBe(false);
    expect(await getV4QueueItems()).toHaveLength(1);

    await browser.waitUntil(
      async () => {
        const text = await getV4ComposerText();
        const attachments = await getV4ComposerAttachments();
        return (
          text === "E2E_V4_QUEUE_ITEM 排队原文" &&
          attachments.length === 1 &&
          // Bug 原因：从 queue 载入的媒体 ref 不重建本地 object URL，缩略图可能只显示
          // image fallback icon；用 innerText 验证 filename 会误判已载入且 ready 的附件。
          attachments[0]?.uploadStatus === "ready"
        );
      },
      { timeout: 30000, timeoutMsg: "编辑态没有完整载入队列项文本与附件" },
    );
    const visual = await browser.execute(finishQueueEditVisualProbe);
    await saveVisualEvidence("attachment", visual);
    expectQueueFreezeEditWithoutFlash(visual, {
      initialComposerText: "保留现有草稿",
      loadedText: "E2E_V4_QUEUE_ITEM 排队原文",
    });
    expect(await isV4ComposerFocused()).toBe(true);

    await sendV4Prompt("E2E_V4_QUEUE_ITEM 编辑后重新提交");
    await waitForV4ComposerEditClosed("editQueueItem 成功后没有退出编辑态", 30000);
    await browser.waitUntil(
      async () => {
        const items = await getV4QueueItems();
        return items.length === 1 && items[0]!.text.includes("编辑后重新提交");
      },
      { timeout: 30000, timeoutMsg: "editQueueItem 没有原地替换队列项内容" },
    );
    const after = await getV4QueueItems();
    // B09e：原地替换，queueItemId 与位置不变。
    expect(after[0]?.queueItemId).toBe(queueItemId);
    expect((await getV4QueueItemEditLock(queueItemId)).locked).toBe(false);
    // 退出编辑态后恢复进入前的原草稿。
    await waitForV4ComposerText("保留现有草稿", "editQueueItem 成功后没有恢复原草稿", 15000);
    expect(await getV4ComposerAttachments()).toHaveLength(0);
  });

  for (const [label, text, theme, held] of [
    ["short", "E2E_V4_QUEUE_ITEM 排队原文", "zai-light", false],
    ["multiline", "E2E_V4_QUEUE_ITEM 第一行\n第二行\n第三行\n第四行\n第五行", "zai-dark", true],
  ] as const) {
    it(`B09g：单条队列冻结编辑不闪动：${label} / ${theme} / ${held ? "held" : "running"}`, async () => {
      await prepareV4ConversationE2E();
      await browser.execute(setQueueTestTheme, theme);
      await sendV4Prompt("E2E_V4_QUEUE_SLOW 慢慢回答");
      await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
      await sendV4Prompt(text);
      await waitForV4QueueCount(1, 30000);
      if (held) {
        await clickV4Stop();
        await waitForV4Pane((snapshot) => !snapshot.canStop, "held queue stop", 30000);
      }
      const [item] = await getV4QueueItems();
      await browser.execute(startQueueEditVisualProbe, item!.queueItemId);
      expect(await clickV4QueueItemEdit(item!.queueItemId)).toBe(true);
      await waitForV4QueueItemEditLock(
        item!.queueItemId,
        (state) => state.locked && state.owner === "self",
        "单条队列项没有原位冻结",
      );
      await waitForV4ComposerText(text, "单条队列编辑态没有载入原文");
      const visual = await browser.execute(finishQueueEditVisualProbe);
      await saveVisualEvidence(label, visual);
      expectQueueFreezeEditWithoutFlash(visual, { initialComposerText: "", loadedText: text });
      expect(await isV4ComposerFocused()).toBe(true);
      expect(await getV4QueueItems()).toHaveLength(1);
      // 取消后解锁并恢复空草稿，afterEach 才能停止慢流。
      await clickV4ComposerEditCancel();
      await waitForV4ComposerEditClosed("单条队列取消编辑后没有退出编辑态");
    });
  }

  it("B09g：手机单条队列冻结编辑不闪动，深浅主题及桌面草稿隔离", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E();
    await sendV4Prompt("E2E_V4_QUEUE_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    const taskId = (await getV4PaneSnapshot()).sessionId;
    await clickV4Stop();
    await waitForV4Pane((snapshot) => !snapshot.canStop, "手机配对前停止首轮", 30000);
    const endpoint = process.env.ZCODE_WEB_REMOTE_CONTROL_URL;
    if (!endpoint || !taskId) throw new Error("缺少手机 fixture / task");
    const pairingUrl = await obtainUnreadPairingUrl(new URL(endpoint).origin);
    const executablePath = process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE;
    const chrome = await chromium.launch({
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
      headless: true,
    });
    try {
      const context = await chrome.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: "zh-CN",
      });
      // WDIO 自动注入此构建辅助函数，Playwright 没有；让共享采样函数中的嵌套回调可序列化运行。
      await context.addInitScript({
        content:
          'globalThis.__name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });',
      });
      await seedMobileFixtureLogin(context);
      const page = await context.newPage();
      await openMobilePairingPage(page, pairingUrl, {
        artifactDir,
        caseMarker: "B09g",
        phase: "pairing",
        readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
      });
      await showMobileTaskHome(page);
      const toggles = page.getByTestId("virtual-project-toggle");
      for (let i = 0; i < (await toggles.count()); i++) {
        const toggle = toggles.nth(i);
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      }
      await page.getByTestId(`task-item-${taskId}`).first().click();
      // 配对耗时不应消耗 controlled stream 的运行窗口。
      await sendV4Prompt("E2E_V4_QUEUE_SLOW 慢慢回答");
      await waitForV4Pane((snapshot) => snapshot.canStop, "手机编辑前启动慢流", 30000);
      for (const theme of ["zai-light", "zai-dark"] as const) {
        await page.evaluate(setQueueTestTheme, theme);
        const text = `E2E_V4_QUEUE_ITEM ${theme}\n第二行\n第三行`;
        await sendV4Prompt(text);
        await waitForV4QueueCount(1, 30000);
        const [item] = await getV4QueueItems();
        const edit = page.getByTestId(`v4-queue-item-edit-${item!.queueItemId}`);
        await edit.waitFor();
        // 手机发起的冻结编辑只进入手机 composer；桌面原草稿不得被覆盖。
        await setV4ComposerText("desktop draft stays local");
        await page.evaluate(startQueueEditVisualProbe, item!.queueItemId);
        await edit.click();
        await page.waitForFunction((expected) => {
          const element = document.querySelector<HTMLElement>(
            '[data-testid="v4-composer-input"]',
          ) as (HTMLElement & { __zcodeLexicalInputE2E?: { getText(): string } }) | null;
          return element?.__zcodeLexicalInputE2E?.getText() === expected;
        }, text);
        await page
          .locator(`[data-queue-item-id="${item!.queueItemId}"][data-edit-locked="true"]`)
          .waitFor();
        const visual = await page.evaluate(finishQueueEditVisualProbe);
        await saveVisualEvidence(`mobile-${theme}`, visual);
        expectQueueFreezeEditWithoutFlash(visual, { initialComposerText: "", loadedText: text });
        // 桌面看到其他设备持有的锁，自己的草稿不变。
        await waitForV4QueueItemEditLock(
          item!.queueItemId,
          (state) => state.locked && state.owner === "other",
          "桌面没有显示手机持有的编辑锁",
        );
        expect(await getV4ComposerText()).toBe("desktop draft stays local");
        // 手机取消编辑释放锁，再删除本轮队列项，下一主题从单条队列重新开始。
        await page.getByTestId("v4-composer-edit-cancel").click();
        await waitForV4QueueItemEditLock(
          item!.queueItemId,
          (state) => state.exists && !state.locked,
          "手机取消后锁没有释放",
        );
        expect(await clickV4QueueItemDelete(item!.queueItemId)).toBe(true);
        await waitForV4QueueCount(0, 30000);
        await setV4ComposerText("");
      }
    } finally {
      await chrome.close();
    }
  });

  it("B09n：编辑中点取消 → 解锁并恢复原草稿，队列内容与位置不变", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_QUEUE_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有进入 running（canStop）",
      45000,
    );

    await sendV4Prompt("E2E_V4_QUEUE_ITEM 第一条问题");
    await waitForV4QueueCount(1, 30000);
    await sendV4Prompt("E2E_V4_QUEUE_ITEM 取消编辑的问题");
    await waitForV4QueueCount(2, 30000);
    const before = await getV4QueueItems();
    const target = before[1]!;
    await setV4ComposerText("保留现有草稿");

    expect(await clickV4QueueItemEdit(target.queueItemId)).toBe(true);
    await waitForV4ComposerEditState(
      (state) => state?.kind === "queueItem" && state.targetId === target.queueItemId,
      "queue 项没有进入 composer 编辑态",
      30000,
    );
    await waitForV4ComposerText(
      "E2E_V4_QUEUE_ITEM 取消编辑的问题",
      "编辑态没有载入队列项原文",
      15000,
    );
    await setV4ComposerText("E2E_V4_QUEUE_ITEM 改了但取消");

    await clickV4ComposerEditCancel();
    await waitForV4ComposerEditClosed("取消后没有退出编辑态");
    await waitForV4ComposerText("保留现有草稿", "取消后没有恢复原草稿", 15000);
    await waitForV4QueueItemEditLock(
      target.queueItemId,
      (state) => !state.locked && state.editAction && state.deleteAction,
      "取消后队列项没有解锁",
    );
    const after = await getV4QueueItems();
    expect(after.map((item) => item.queueItemId)).toEqual(before.map((item) => item.queueItemId));
    expect(after[1]!.text).toContain("取消编辑的问题");
    expect(after[1]!.text).not.toContain("改了但取消");
  });

  it("running 中入队两条 → 拖拽第二条到第一条 → 顺序互换（reorderQueueItem）", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_QUEUE_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有进入 running（canStop）",
      45000,
    );

    // running 中依次入队两条
    await sendV4Prompt("E2E_V4_QUEUE_ITEM 第一条问题");
    await waitForV4QueueCount(1, 30000);
    await sendV4Prompt("E2E_V4_QUEUE_ITEM 第二条问题");
    await waitForV4QueueCount(2, 30000);

    const before = await getV4QueueItems();
    expect(before).toHaveLength(2);
    expect(before[0]!.text).toContain("第一条问题");
    expect(before[1]!.text).toContain("第二条问题");
    const secondId = before[1]!.queueItemId;

    // 拖拽只发 reorderQueueItem；顺序更新必须来自 CLI projection 回流。
    await dragV4QueueItemOnto(secondId, before[0]!.queueItemId);
    await browser.waitUntil(
      async () => {
        const items = await getV4QueueItems();
        return items.length === 2 && items[0]!.queueItemId === secondId;
      },
      { timeout: 30000, timeoutMsg: "第二条没有拖拽到队首" },
    );
    const after = await getV4QueueItems();
    expect(after).toHaveLength(2);
    expect(after[0]!.queueItemId).toBe(secondId);
    expect(after[0]!.text).toContain("第二条问题");
    expect(after[1]!.text).toContain("第一条问题");
  });
});

const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/queue-edit");

async function saveVisualEvidence(label: string, samples: unknown) {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    resolve(artifactDir, `queue-edit-${label}.json`),
    JSON.stringify(samples, null, 2),
  );
}

function setQueueTestTheme(theme: string) {
  const actions = (window as Window & { __testActions?: { setTheme(theme: string): void } })
    .__testActions;
  if (!actions) throw new Error("缺少主题测试入口");
  actions.setTheme(theme);
}
