// D21–D28 composer 编辑态（docs/ui/composer-edit-mode.md）：编辑 latest user query 复用底部 composer。
// 证据层 L3：
// 1) 进入编辑态前暂存原草稿；取消、提交成功、失效后普通发送成功都恢复原草稿；取消恢复工具栏配置，
//    提交成功保留提交的模型与 mode、Plan 回到草稿值；
// 2) 原消息位置显示「正在下方编辑」，点击只聚焦 composer，不滚动；Esc 不取消编辑态；
// 3) 编辑态能力与普通 composer 完全一致：新增附件、工具栏配置随 editUserQuery 提交；
// 4) 目标失效只依据投影 canEdit：队列续跑后发送走普通 sendText；
// 5) 切换 task 保持编辑态，刷新只恢复原草稿；切换编辑目标时有改动先确认。
import { TID_V4_EDIT, testId } from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  countUpstreamRequestsContaining,
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
  clickV4ComposerEditCancel,
  clickV4UserRowEditHint,
  confirmV4ComposerEditSwitch,
  getV4ComposerEditState,
  getV4QueueItemEditLock,
  waitForV4QueueItemEditLock,
  getV4UserRowEditHint,
  hasV4ComposerEditSwitchDialog,
  openLatestV4UserQueryEditInComposer,
  openV4QueueItemEditInComposer,
  waitForV4ComposerEditClosed,
  waitForV4ComposerEditState,
} from "#e2e/helpers/v4-composer-edit";
import {
  clickV4Send,
  clickV4Stop,
  getV4ComposerAttachments,
  getV4ComposerText,
  getV4ConfigProjection,
  getV4ModelConfig,
  getV4PaneSnapshot,
  getV4QueueItems,
  getV4TimelineScrollState,
  isV4ComposerFocused,
  pasteV4ComposerFileAttachment,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  setV4ComposerText,
  startNewV4Draft,
  switchV4Mode,
  waitForV4ComposerText,
  waitForV4Pane,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const DRAFT_TEXT = "E2E_CEM_DRAFT 保留的原草稿";
const DRAFT_FILE = "e2e-cem-draft.txt";
const ADDED_FILE = "e2e-cem-added.txt";
const ADDED_FILE_CONTENT = "E2E_CEM_ADDED_ATTACHMENT_CONTENT";

describe("D21–D28 composer 编辑态：编辑 latest user query", () => {
  afterEach(async () => {
    const pane = await getV4PaneSnapshot();
    if (!pane.canStop) return;
    // controlled stream 跨 case 存活时会与下一条 case 并行；主动 stop 并等待收口。
    await clickV4Stop();
    await waitForV4Pane((next) => !next.canStop, "composer 编辑态 case 收尾 stop 没有完成", 30000);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("D21/D26：有草稿时编辑 → 占位与状态条 → Esc 不取消、点占位只聚焦 → 取消恢复原草稿", async () => {
    await prepareV4ConversationE2E();
    await startNewV4Draft();
    await sendV4Prompt("E2E_CEM_ORIGINAL D21 原始问题");
    await waitForV4TimelineContaining("CEM_ORIGINAL_REPLY", 45000);
    await waitForV4Pane((s) => !s.canStop, "D21 首轮没有收口", 45000);

    await writeDraftWithAttachment();
    const rowId = await openLatestV4UserQueryEditInComposer();
    const editing = await getV4ComposerEditState();
    expect(editing).toMatchObject({ kind: "userQuery", state: "editing", hasCancel: true });
    expect(editing?.text.length).toBeGreaterThan(0);
    await waitForV4ComposerText("E2E_CEM_ORIGINAL D21 原始问题", "编辑态没有载入原消息正文");
    expect(await getV4ComposerAttachments()).toHaveLength(0);

    // 原位置显示占位并隐藏编辑入口。
    await browser.waitUntil(async () => (await getV4UserRowEditHint(rowId)).hint, {
      timeout: 15000,
      timeoutMsg: "原消息位置没有出现「正在下方编辑」占位",
    });
    const hint = await getV4UserRowEditHint(rowId);
    expect(hint.hintText.length).toBeGreaterThan(0);
    expect(hint.editAction).toBe(false);

    // D26：Esc 不取消编辑态。
    await browser.keys(["Escape"]);
    expect(await getV4ComposerEditState()).toMatchObject({ kind: "userQuery", state: "editing" });

    // D26：点击占位只聚焦 composer，不滚动时间线。
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    const scrollBefore = await getV4TimelineScrollState();
    await clickV4UserRowEditHint(rowId);
    await browser.waitUntil(() => isV4ComposerFocused(), {
      timeout: 5000,
      timeoutMsg: "点击占位后 composer 没有获得焦点",
    });
    expect((await getV4TimelineScrollState()).scrollTop).toBe(scrollBefore.scrollTop);

    await setV4ComposerText("E2E_CEM_ORIGINAL 改了但取消");
    const editRequestsBefore = await countUpstreamRequestsContaining("改了但取消");
    await clickV4ComposerEditCancel();
    await waitForV4ComposerEditClosed("取消后没有退出编辑态");
    await assertDraftRestored();
    expect((await getV4UserRowEditHint(rowId)).hint).toBe(false);
    expect(await countUpstreamRequestsContaining("改了但取消")).toBe(editRequestsBefore);
  });

  it("D27/D28/C07：编辑态载入原配置 → 新增附件后发送 → 请求携带新附件与编辑态模型 → 退出后恢复原草稿、保留模型与 mode → 下一条沿用", async () => {
    await prepareV4ConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    await startNewV4Draft();
    await sendV4Prompt("E2E_CEM_ORIGINAL D27 原始问题");
    await waitForV4TimelineContaining("CEM_ORIGINAL_REPLY", 45000);
    await waitForV4Pane((s) => !s.canStop, "D27 首轮没有收口", 45000);

    // 原消息以模型 A、原 mode、Plan 关闭提交；之后草稿工具栏切到模型 B、另一个 mode 并打开 Plan。
    const submittedConfig = await getV4ModelConfig();
    const submittedMode = await getV4ConfigProjection();
    expect(submittedConfig.model).not.toBe(UPSTREAM_SECONDARY_MODEL);
    expect(submittedMode.planEnabled).toBe(false);
    await writeDraftWithAttachment();
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL, {
      includePlainModelFallback: false,
      providerId: UPSTREAM_PROVIDER_ID,
    });
    const draftMode = submittedMode.mode === "guarded" ? "build" : "guarded";
    await switchV4Mode(draftMode);
    await switchV4Mode("plan");
    const configBefore = await getV4ModelConfig();
    const draftModeBefore = await getV4ConfigProjection();
    expect(configBefore.model).toBe(UPSTREAM_SECONDARY_MODEL);
    expect(draftModeBefore).toMatchObject({ mode: draftMode, planEnabled: true });

    await openLatestV4UserQueryEditInComposer();
    // D28：编辑态载入该消息提交时的配置（模型 A），与排队消息编辑同一规则。
    await browser.waitUntil(
      async () => (await getV4ModelConfig()).model === submittedConfig.model,
      { timeout: 15000, timeoutMsg: "编辑态没有载入原消息提交时的模型" },
    );
    // mode 与 Plan 同样载入原提交值，不沿用草稿的 guarded/build 与 Plan。
    expect(await getV4ConfigProjection()).toMatchObject({
      mode: submittedMode.mode,
      planEnabled: false,
    });
    await setV4ComposerText("E2E_CEM_EDITED 编辑后的问题");
    // D27：编辑态新增附件与普通 composer 走同一上传事务。
    await pasteV4ComposerFileAttachment(ADDED_FILE, {
      base64: Buffer.from(ADDED_FILE_CONTENT).toString("base64"),
      mimeType: "text/plain",
    });
    await browser.waitUntil(
      async () => {
        const attachments = await getV4ComposerAttachments();
        return attachments.length === 1 && attachments[0]?.uploadStatus === "ready";
      },
      { timeout: 30000, timeoutMsg: "编辑态新增附件没有上传完成" },
    );
    // D28：编辑态保持载入的模型 A 提交；草稿是模型 B，重跑用 A 才说明提交的是编辑态配置。
    expect((await getV4ModelConfig()).model).toBe(submittedConfig.model);

    await clickV4Send();
    await waitForUpstreamRequest(
      { includes: ["E2E_CEM_EDITED", ADDED_FILE_CONTENT] },
      "编辑态提交的重跑请求没有携带新附件",
      45000,
    );
    const [rerun] = await getUpstreamRequestEvidence({ includes: ["E2E_CEM_EDITED"] });
    expect(rerun?.requestJson).toMatchObject({ model: submittedConfig.model });

    await waitForV4TimelineContaining("CEM_EDITED_REPLY", 45000);
    const snapshot = await waitForV4Pane(
      (s) => !s.canStop && s.timelineText.includes("CEM_EDITED_REPLY"),
      "编辑重跑没有完成",
      45000,
    );
    expect(snapshot.timelineText).not.toContain("D27 原始问题");

    // C07/D28：提交成功后退出编辑态，恢复原草稿正文与附件；工具栏保留提交的模型 A 与原 mode，
    // Plan 回到草稿值（开）。三项都与草稿不同，能区分「保留」与「恢复」。
    await waitForV4ComposerEditClosed("editUserQuery 成功后没有退出编辑态", 30000);
    await assertDraftRestored();
    expect(await getV4ModelConfig()).toMatchObject({
      provider: submittedConfig.provider,
      model: submittedConfig.model,
    });
    expect(submittedConfig.model).not.toBe(configBefore.model);
    expect(await getV4ConfigProjection()).toMatchObject({
      mode: submittedMode.mode,
      planEnabled: true,
    });

    // 下一条消息沿用保留的模型，不悄悄回到草稿里的模型 B。
    await setV4ComposerText("E2E_CEM_NEXT 编辑后的下一条");
    await clickV4Send();
    await waitForUpstreamRequest(
      { includes: ["E2E_CEM_NEXT"] },
      "编辑提交后的下一条消息没有发出",
      45000,
    );
    const [next] = await getUpstreamRequestEvidence({ includes: ["E2E_CEM_NEXT"] });
    expect(next?.requestJson).toMatchObject({ model: submittedConfig.model });
    await waitForV4TimelineContaining("CEM_NEXT_REPLY", 45000);
  });

  it("D23：编辑中队列续跑使原消息不再是最后一条 → 失效态发送作为普通新消息", async () => {
    await prepareV4ConversationE2E();
    await startNewV4Draft();
    await sendV4Prompt("E2E_CEM_SLOW_D22 慢慢回答");
    await waitForV4TimelineContaining("CEM_D22_STREAMING", 45000);
    await waitForV4Pane((s) => s.canStop, "D23 首轮没有进入 running", 45000);
    await sendV4Prompt("E2E_CEM_QUEUED_D22 排队的问题");
    await waitForV4QueueCount(1, 30000);

    await setV4ComposerText(DRAFT_TEXT);
    const rowId = await openLatestV4UserQueryEditInComposer();
    await waitForV4ComposerText("E2E_CEM_SLOW_D22 慢慢回答", "编辑态没有载入 running 中的原消息");

    // 当前轮结束后队列续跑，产生新的 real-user 输入，原 row canEdit=false。
    await releaseControlledReplay("cem-slow-d22");
    await waitForV4TimelineContaining("CEM_D22_QUEUED_REPLY", 45000);
    const invalid = await waitForV4ComposerEditState(
      (state) =>
        state?.kind === "userQuery" &&
        state.targetId === rowId &&
        state.state === "invalid" &&
        state.invalidReason === "notLatest",
      "原消息不再是最后一条后，编辑态没有进入失效态",
      30000,
    );
    expect(invalid?.hasCancel).toBe(true);

    // 失效态发送走普通 sendText：原消息与新消息都保留。
    await setV4ComposerText("E2E_CEM_AS_NEW 作为新消息发送");
    await clickV4Send();
    await waitForV4TimelineContaining("CEM_AS_NEW_REPLY", 45000);
    const snapshot = await waitForV4Pane(
      (s) => !s.canStop && s.timelineText.includes("CEM_AS_NEW_REPLY"),
      "失效态发送的新消息没有完成",
      45000,
    );
    expect(snapshot.timelineText).toContain("E2E_CEM_SLOW_D22 慢慢回答");
    expect(snapshot.timelineText).toContain("E2E_CEM_QUEUED_D22 排队的问题");
    expect(snapshot.timelineText).toContain("E2E_CEM_AS_NEW 作为新消息发送");
    await waitForV4ComposerEditClosed("失效态普通发送成功后没有退出编辑态", 30000);
    await waitForV4ComposerText(DRAFT_TEXT, "失效态普通发送成功后没有恢复原草稿", 15000);
  });

  it("D25：切换编辑目标：未改动直接切换（先释放旧锁），已改动先确认；暂存的始终是原草稿", async () => {
    await prepareV4ConversationE2E();
    await startNewV4Draft();
    await sendV4Prompt("E2E_CEM_SLOW_D24 慢慢回答");
    await waitForV4TimelineContaining("CEM_D24_STREAMING", 45000);
    await waitForV4Pane((s) => s.canStop, "D25 首轮没有进入 running", 45000);
    await sendV4Prompt("E2E_CEM_QUEUED_D24 排队的问题");
    await waitForV4QueueCount(1, 30000);
    const [queued] = await getV4QueueItems();
    if (!queued) throw new Error("D25 队列项不存在");

    await setV4ComposerText(DRAFT_TEXT);
    const rowId = await openLatestV4UserQueryEditInComposer();

    // 未改动：直接切到排队消息，不弹确认。
    await openV4QueueItemEditInComposer(queued.queueItemId);
    expect(await hasV4ComposerEditSwitchDialog()).toBe(false);
    await waitForV4ComposerText("E2E_CEM_QUEUED_D24 排队的问题", "切换后没有载入排队消息");
    // 编辑态在 lock ACK 后进入；editLock 随后经投影到达。
    await waitForV4QueueItemEditLock(
      queued.queueItemId,
      (state) => state.locked && state.owner === "self",
      "切换后排队消息没有显示本端编辑锁",
    );

    // 已改动：切回 latest query 先确认，确认后释放排队消息的锁。
    await setV4ComposerText("E2E_CEM_QUEUED_D24 改动未保存");
    await clickTestIdByDom(testId(TID_V4_EDIT, rowId), {
      timeout: 15000,
      timeoutMsg: "latest query 编辑入口不可点击",
    });
    await browser.waitUntil(() => hasV4ComposerEditSwitchDialog(), {
      timeout: 15000,
      timeoutMsg: "已改动时切换编辑目标没有弹出确认",
    });
    expect(await getV4ComposerEditState()).toMatchObject({
      kind: "queueItem",
      targetId: queued.queueItemId,
    });
    await confirmV4ComposerEditSwitch();
    await waitForV4ComposerEditState(
      (state) => state?.kind === "userQuery" && state.targetId === rowId,
      "确认后没有切换到 latest query 编辑态",
    );
    await waitForV4ComposerText("E2E_CEM_SLOW_D24 慢慢回答", "切换后没有载入 latest query");
    await browser.waitUntil(
      async () => !(await getV4QueueItemEditLock(queued.queueItemId)).locked,
      { timeout: 30000, timeoutMsg: "切换目标后排队消息的锁没有释放" },
    );
    expect((await getV4QueueItems())[0]?.text).toContain("排队的问题");

    await clickV4ComposerEditCancel();
    await waitForV4ComposerEditClosed("取消后没有退出编辑态");
    await waitForV4ComposerText(DRAFT_TEXT, "多次切换目标后没有恢复进入编辑态前的原草稿", 15000);
  });

  it("D24：切换 task 后切回保持编辑态；刷新后丢弃编辑态、只恢复原草稿", async () => {
    await prepareV4ConversationE2E();
    await startNewV4Draft();
    await sendV4Prompt("E2E_CEM_ORIGINAL D24 原始问题");
    await waitForV4TimelineContaining("CEM_ORIGINAL_REPLY", 45000);
    const settled = await waitForV4Pane(
      (s) => !s.canStop && s.sessionId !== null && s.sessionId !== "draft",
      "D24 首轮没有收口",
      45000,
    );
    const sessionId = settled.sessionId!;

    await setV4ComposerText(DRAFT_TEXT);
    const rowId = await openLatestV4UserQueryEditInComposer();
    await setV4ComposerText("E2E_CEM_ORIGINAL D24 编辑中的内容");

    await startNewV4Draft();
    expect(await getV4ComposerEditState()).toBeNull();
    await selectV4TaskById(sessionId);
    await waitForV4ComposerEditState(
      (state) =>
        state?.kind === "userQuery" && state.targetId === rowId && state.state === "editing",
      "切回 task 后编辑态没有保持",
    );
    await waitForV4ComposerText("E2E_CEM_ORIGINAL D24 编辑中的内容", "切回 task 后编辑内容丢失");

    await browser.execute(() => window.location.reload());
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await selectV4TaskById(sessionId);
    await waitForV4Pane((s) => s.sessionId === sessionId, "刷新后没有恢复 session", 30000);
    await browser.waitUntil(async () => (await getV4ComposerText()) !== null, {
      timeout: 15000,
      timeoutMsg: "刷新后 composer 没有挂载",
    });
    // 编辑内容不写持久化草稿：刷新后只剩进入编辑态前的原草稿。
    await waitForV4ComposerText(DRAFT_TEXT, "刷新后没有恢复进入编辑态前的原草稿", 15000);
    expect(await getV4ComposerEditState()).toBeNull();
    expect((await getV4UserRowEditHint(rowId)).hint).toBe(false);
  });
});

async function writeDraftWithAttachment() {
  await setV4ComposerText(DRAFT_TEXT);
  await pasteV4ComposerFileAttachment(DRAFT_FILE, {
    base64: Buffer.from("E2E_CEM_DRAFT_ATTACHMENT").toString("base64"),
    mimeType: "text/plain",
  });
  await browser.waitUntil(
    async () => {
      const attachments = await getV4ComposerAttachments();
      return attachments.length === 1 && attachments[0]?.uploadStatus === "ready";
    },
    { timeout: 30000, timeoutMsg: "原草稿附件没有上传完成" },
  );
}

async function assertDraftRestored() {
  await waitForV4ComposerText(DRAFT_TEXT, "退出编辑态后没有恢复原草稿正文", 15000);
  const attachments = await getV4ComposerAttachments();
  expect(attachments).toHaveLength(1);
  expect(attachments[0]?.text).toContain(DRAFT_FILE);
  expect(attachments[0]?.uploadStatus).toBe("ready");
}
