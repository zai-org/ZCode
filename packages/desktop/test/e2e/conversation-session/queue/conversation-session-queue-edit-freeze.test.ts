// B09h/B09i/B09k/B09o/B09p 排队消息冻结编辑（docs/ui/composer-edit-mode.md）。
// 证据层 L3：
// 1) 编辑期间该项在 CLI 冻结（queueItem.editLock 进入投影）；自动续跑到冻结项暂停，后面的项等待；
// 2) 冻结项不能删除、立即发送，其他项不受影响；
// 3) 工具栏载入队列项配置，修改后随 editQueueItem 原地写回，消费时按新配置执行；提交后工具栏保留新模型；
//    其他排队项配置不同时提示是否一并应用，选应用后它们也按新配置消费；
// 4) 发起端刷新后发现自己的锁但本地无编辑态，立即释放，不使用超时。
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  expectNoUpstreamRequestForTextWithin,
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  ensureUpstreamModelForE2E,
  selectUpstreamModelById,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_SECONDARY_MODEL,
} from "#e2e/helpers/upstream-provider";
import {
  confirmV4ComposerEditApplyQueue,
  getV4ComposerEditState,
  getV4QueueItemEditLock,
  openV4QueueItemEditInComposer,
  waitForV4ComposerEditApplyQueueDialog,
  waitForV4ComposerEditClosed,
  waitForV4QueueItemEditLock,
} from "#e2e/helpers/v4-composer-edit";
import {
  clickV4QueueItemDelete,
  clickV4QueueItemSendNow,
  clickV4Send,
  clickV4Stop,
  getV4ComposerText,
  getV4ModelConfig,
  getV4PaneSnapshot,
  getV4QueueItems,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  setV4ComposerText,
  startNewV4Draft,
  waitForV4ComposerText,
  waitForV4Pane,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const DRAFT_TEXT = "E2E_QEF_DRAFT 保留的原草稿";

describe("B09 排队消息冻结编辑", () => {
  afterEach(async () => {
    const pane = await getV4PaneSnapshot();
    if (!pane.canStop) return;
    await clickV4Stop();
    await waitForV4Pane((next) => !next.canStop, "冻结编辑 case 收尾 stop 没有完成", 30000);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("B09h/B09i/B09o/B09p：续跑在冻结项前暂停 → 冻结项操作被禁用 → 改配置提交后按新配置原地消费 → 应用到后面的排队项", async () => {
    await prepareV4ConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    await startNewV4Draft();

    await sendV4Prompt("E2E_QEF_SLOW_G 慢慢回答");
    await waitForV4TimelineContaining("QEF_G_STREAMING", 45000);
    await waitForV4Pane((s) => s.canStop, "B09h 首轮没有进入 running", 45000);
    await sendV4Prompt("E2E_QEF_A 第一条");
    await waitForV4QueueCount(1, 30000);
    await sendV4Prompt("E2E_QEF_C 冻结的一条");
    await waitForV4QueueCount(2, 30000);
    await sendV4Prompt("E2E_QEF_D 冻结项之后的一条");
    await waitForV4QueueCount(3, 30000);
    const [itemA, itemC, itemD] = await getV4QueueItems();
    if (!itemA || !itemC || !itemD) throw new Error("B09h 队列项不完整");
    // 新草稿的模型在首发后才完成初始化；入队时记录的是此刻工具栏的默认模型。
    const configBefore = await getV4ModelConfig();
    expect(configBefore.model).not.toBe(UPSTREAM_SECONDARY_MODEL);

    await setV4ComposerText(DRAFT_TEXT);
    await openV4QueueItemEditInComposer(itemC.queueItemId);
    await waitForV4ComposerText("E2E_QEF_C 冻结的一条", "编辑态没有载入冻结项原文");
    // B09o：工具栏载入队列项记录的配置（入队时为默认模型）。
    expect((await getV4ModelConfig()).model).toBe(configBefore.model);

    // B09i：冻结项的编辑、删除、立即发送都不可用；其他项不受影响。
    const locked = await waitForV4QueueItemEditLock(
      itemC.queueItemId,
      (state) => state.locked && state.owner === "self",
      "冻结项没有显示本端编辑锁",
    );
    expect(locked).toMatchObject({ editAction: false, deleteAction: false, sendNowAction: false });
    // 即使入口仍渲染为 disabled，点击也不能删除或提升冻结项。
    await clickV4QueueItemDelete(itemC.queueItemId);
    await clickV4QueueItemSendNow(itemC.queueItemId);
    expect((await getV4QueueItems()).map((item) => item.queueItemId)).toEqual([
      itemA.queueItemId,
      itemC.queueItemId,
      itemD.queueItemId,
    ]);
    const other = await getV4QueueItemEditLock(itemD.queueItemId);
    expect(other).toMatchObject({ locked: false, deleteAction: true, sendNowAction: true });

    // B09h：A 正常消费；到冻结项 C 时暂停，D 保持等待。
    await releaseControlledReplay("qef-slow-g");
    await waitForV4TimelineContaining("QEF_A_REPLY", 45000);
    await waitForV4Pane((s) => !s.canStop, "A 消费后没有停在冻结项前", 45000);
    await expectNoUpstreamRequestForTextWithin("E2E_QEF_D", 1500);
    expect((await getV4QueueItems()).map((item) => item.queueItemId)).toEqual([
      itemC.queueItemId,
      itemD.queueItemId,
    ]);
    expect(await getV4ComposerEditState()).toMatchObject({ kind: "queueItem", state: "editing" });

    // B09o：修改模型与正文后提交，editQueueItem 原地写回，解锁后 C 按新配置消费，随后 D。
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL, {
      includePlainModelFallback: false,
      providerId: UPSTREAM_PROVIDER_ID,
    });
    await setV4ComposerText("E2E_QEF_C_EDITED 改过的冻结项");
    await clickV4Send();
    await waitForV4ComposerEditClosed("editQueueItem 成功后没有退出编辑态", 30000);
    await waitForV4ComposerText(DRAFT_TEXT, "editQueueItem 成功后没有恢复原草稿", 15000);
    // B09o：正文恢复原草稿，工具栏保留提交的新模型，下一条消息不悄悄回到旧模型。
    expect((await getV4ModelConfig()).model).toBe(UPSTREAM_SECONDARY_MODEL);

    // B09p：D 仍按旧模型排队 → 发起端提示是否一并应用；文案写出新模型，不写条数。
    const applyDialogText = await waitForV4ComposerEditApplyQueueDialog();
    expect(applyDialogText).toContain(UPSTREAM_SECONDARY_MODEL);
    expect(applyDialogText).not.toMatch(/\d+\s*条/u);
    await confirmV4ComposerEditApplyQueue();

    await waitForUpstreamRequest(
      { lastUserMessageIncludes: ["E2E_QEF_C_EDITED"] },
      "解锁后冻结项没有按新内容消费",
      45000,
    );
    const [consumedC] = await getUpstreamRequestEvidence({
      lastUserMessageIncludes: ["E2E_QEF_C_EDITED"],
    });
    expect(consumedC?.requestJson).toMatchObject({ model: UPSTREAM_SECONDARY_MODEL });
    // C 是慢流：确认应用时 D 仍在排队；释放后 D 按应用的新模型消费。
    await releaseControlledReplay("qef-c");
    await waitForV4TimelineContaining("QEF_C_REPLY", 45000);
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: ["E2E_QEF_D"] },
      "应用到排队消息后 D 没有被消费",
      45000,
    );
    const [consumedD] = await getUpstreamRequestEvidence({
      lastUserMessageIncludes: ["E2E_QEF_D"],
    });
    expect(consumedD?.requestJson).toMatchObject({ model: UPSTREAM_SECONDARY_MODEL });
    await waitForV4TimelineContaining("QEF_D_REPLY", 45000);
    const finalSnapshot = await waitForV4Pane(
      (s) => !s.canStop && s.timelineText.includes("QEF_D_REPLY"),
      "解锁后队列没有按顺序消费完",
      45000,
    );
    expect(finalSnapshot.timelineText).not.toContain("E2E_QEF_C 冻结的一条");
    expect(finalSnapshot.timelineText.indexOf("QEF_C_REPLY")).toBeLessThan(
      finalSnapshot.timelineText.indexOf("QEF_D_REPLY"),
    );
    expect(await getV4QueueItems()).toHaveLength(0);
  });

  it("B09k：发起端刷新后自动释放自己的锁，composer 只恢复原草稿，队列继续消费", async () => {
    await prepareV4ConversationE2E();
    await startNewV4Draft();
    await sendV4Prompt("E2E_QEF_SLOW_J 慢慢回答");
    await waitForV4TimelineContaining("QEF_J_STREAMING", 45000);
    const running = await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== null && s.sessionId !== "draft",
      "B09k 首轮没有进入 running",
      45000,
    );
    const sessionId = running.sessionId!;
    await sendV4Prompt("E2E_QEF_J 刷新时冻结的一条");
    await waitForV4QueueCount(1, 30000);
    const [itemJ] = await getV4QueueItems();
    if (!itemJ) throw new Error("B09k 队列项不存在");

    await setV4ComposerText(DRAFT_TEXT);
    await openV4QueueItemEditInComposer(itemJ.queueItemId);
    await setV4ComposerText("E2E_QEF_J 编辑中的内容");

    await browser.execute(() => window.location.reload());
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await selectV4TaskById(sessionId);
    await waitForV4Pane((s) => s.sessionId === sessionId, "刷新后没有恢复 session", 30000);
    await waitForV4QueueItemEditLock(
      itemJ.queueItemId,
      (state) => state.exists && !state.locked,
      "刷新后发起端没有释放自己的锁",
    );
    expect(await getV4ComposerEditState()).toBeNull();
    await browser.waitUntil(async () => (await getV4ComposerText()) === DRAFT_TEXT, {
      timeout: 15000,
      timeoutMsg: "刷新后没有恢复进入编辑态前的原草稿",
    });
    expect((await getV4QueueItems())[0]?.text).toContain("刷新时冻结的一条");

    await releaseControlledReplay("qef-slow-j");
    await waitForV4TimelineContaining("QEF_J_REPLY", 45000);
    await waitForV4QueueCount(0, 30000);
  });
});
