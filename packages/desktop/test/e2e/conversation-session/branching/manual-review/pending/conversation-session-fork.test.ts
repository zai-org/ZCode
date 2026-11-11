import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TID_V4_FORK } from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import {
  waitForUpstreamNetworkCapture,
  waitForUpstreamNetworkRequestStarted,
} from "#e2e/helpers/upstream-capture";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  assertVisibleV4UserMessagesNotContaining,
  getV4ConversationState,
  getV4Messages,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
  waitForLatestV4CommandAck,
} from "#e2e/helpers/v4-conversation";
import { forkV4AssistantContaining as clickForkButtonForAssistantContaining } from "#e2e/helpers/v4-message-actions";
import { getV4MessageAction, waitForV4MessageAction } from "#e2e/helpers/v4-message-actions";
import { editV4UserMessageContaining as editUserMessageContaining } from "#e2e/helpers/v4-message-actions";

import {
  getQueueItems,
  waitForQueueContaining,
  waitForQueueCount,
} from "#e2e/helpers/conversation-session-queue";

import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";

describe("会话区 Fork E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("完成后的 assistant 消息应允许 fork 并切换到派生 session", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    // 修复原因：FK/E01 只验证 completed assistant 的 fork 边界。
    // 这里混入 Read 工具会触发 auto compact，让基础 fork case 被 compact 稳定性干扰。
    const prompt = buildReplyPrompt(`E2E_FORK_SOURCE_${runId}`);
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "首发后输入框没有清空");
    await waitForV4UserMessageContaining(prompt);
    const sourceSnapshot = await waitForV4ConversationState(
      (snapshot) => Boolean(snapshot.sessionId || snapshot.taskId),
      "首发后 chat-view 没有回填 session/task id",
      30000,
    );
    await waitForUpstreamNetworkCapture(`E2E_FORK_SOURCE_${runId}`);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.state === "idle" && isRuntimeCompleted(snapshot) && snapshot.queueCount === 0,
      "fork 前会话没有回到 idle",
      90000,
    );

    const userForkButton = await getV4MessageAction("user", "fork", prompt);
    expect(userForkButton?.exists).not.toBe(true);

    const forkButton = await waitForV4MessageAction("assistant", "fork", E2E_REPLY_TOKEN);
    expect(forkButton.exists).toBe(true);
    expect(forkButton.disabled || forkButton.ariaDisabled).toBe(false);

    await clickForkButtonForAssistantContaining(E2E_REPLY_TOKEN);
    const forkedSnapshot = await waitForV4ConversationState(
      (snapshot) =>
        Boolean(snapshot.sessionId || snapshot.taskId) &&
        (snapshot.sessionId || snapshot.taskId) !==
          (sourceSnapshot.sessionId || sourceSnapshot.taskId),
      "点击 fork 后没有切换到新的 session/task",
      30000,
    );

    expect(forkedSnapshot.queueCount).toBe(0);
    expect(forkedSnapshot.sessionId || forkedSnapshot.taskId).not.toBe(
      sourceSnapshot.sessionId || sourceSnapshot.taskId,
    );
    await waitForV4UserMessageContaining(prompt);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);

    const finalSnapshot = await getV4ConversationState();
    expect(finalSnapshot.sessionId || finalSnapshot.taskId).toBe(
      forkedSnapshot.sessionId || forkedSnapshot.taskId,
    );
  });

  it("父 session 有 goal 时 fork 已完成 assistant 应继承目标但不复制 queue", async function () {
    this.timeout(240000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const goalMarker = `E2E_FORK_GOAL_${runId}`;
    const goalObjective = `${goalMarker}: keep this marker on forked child session target.`;

    const seedMarker = `E2E_FORK_GOAL_SEED_${runId}`;
    const seedPrompt = buildReplyPrompt(seedMarker);
    await sendV4Prompt(seedPrompt);
    await waitForV4ComposerText("", "goal fork seed 发送后输入框没有清空");
    await waitForV4UserMessageContaining(seedPrompt);
    await waitForUpstreamNetworkCapture(seedMarker);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    const seededSnapshot = await waitForV4ConversationState(
      (snapshot) =>
        Boolean(snapshot.sessionId || snapshot.taskId) &&
        snapshot.state === "idle" &&
        isRuntimeCompleted(snapshot) &&
        snapshot.queueCount === 0,
      "goal fork seed 完成后没有进入可设置 target 的 idle 状态",
      90000,
    );
    const sourceSessionId = getSnapshotSessionId(seededSnapshot);
    expect(sourceSessionId).toBeTruthy();
    // V4 由 CLI snapshot 持有 target；旧 renderer store 注入不会进入真实 fork 状态。
    // 在进程退出屏障后写入夹具，再冷启动读取，避免退出持久化覆盖新 target。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () =>
        setSessionTargetForE2E(sourceSessionId ?? "", goalObjective, "paused"),
    });
    await selectV4TaskById(sourceSessionId ?? "");
    await assertVisibleV4UserMessagesNotContaining(goalMarker);

    const sourceMarker = `E2E_FORK_GOAL_SOURCE_${runId}`;
    const sourcePrompt = buildReplyPrompt(sourceMarker);
    await sendV4Prompt(sourcePrompt);
    await waitForV4ComposerText("", "goal fork source 发送后输入框没有清空");
    await waitForV4UserMessageContaining(sourcePrompt);
    await waitForUpstreamNetworkCapture(sourceMarker);
    const sourceAssistantMessageId = await waitForAssistantMessageIdAfterUser(
      sourceMarker,
      E2E_REPLY_TOKEN,
    );
    await waitForV4ConversationState(
      (snapshot) =>
        getSnapshotSessionId(snapshot) === sourceSessionId &&
        snapshot.state === "idle" &&
        isRuntimeCompleted(snapshot) &&
        snapshot.queueCount === 0 &&
        snapshot.targetObjective?.includes(goalMarker) === true &&
        snapshot.targetStatus === "paused",
      "fork goal source 完成后 renderer 没有同步父 target",
      90000,
    );

    const queuedMarker = `E2E_FORK_GOAL_HELD_QUEUE_${runId}`;
    const queuedPrompt = `${queuedMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const runningMarker = `E2E_FORK_GOAL_RUNNING_${runId}`;
    await sendV4Prompt(buildReplyPrompt(runningMarker));
    // 这里需要保持运行态来建立真实队列；等待响应结束会耗尽受控流窗口。
    await waitForUpstreamNetworkRequestStarted(runningMarker);
    await waitForV4ConversationState(
      // V4 的 Stop projection 与已捕获请求证明运行态；旧 store 的 activeInputId 不再同步。
      (snapshot) => snapshot.state === "streaming",
      "创建父队列前主轮没有处于实际运行中",
      30000,
    );
    await sendV4Prompt(queuedPrompt);
    await waitForQueueContaining(queuedMarker);
    const parentQueue = await waitForQueueCount(1);
    const parentQueueItemId = parentQueue[0]?.id;
    expect(parentQueueItemId).toBeTruthy();
    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) =>
        getSnapshotSessionId(snapshot) === sourceSessionId &&
        snapshot.state === "idle" &&
        snapshot.activeInputId === null &&
        snapshot.queueCount === 1 &&
        !snapshot.stopRequested &&
        snapshot.targetObjective?.includes(goalMarker) === true &&
        snapshot.targetStatus === "paused",
      "停止后父会话没有保留目标和 held queue",
      30000,
    );
    const parentTargetBeforeFork = readSessionTargetForE2E(sourceSessionId ?? "");
    expect(parentTargetBeforeFork?.objective).toContain(goalMarker);
    expect(parentTargetBeforeFork?.status).toBe("paused");

    const forkButton = await waitForForkButtonForAssistantMessageId(sourceAssistantMessageId);
    expect(forkButton.exists).toBe(true);
    expect(forkButton.disabled || forkButton.ariaDisabled).toBe(false);

    await clickForkButtonForAssistantMessageId(sourceAssistantMessageId);
    const forkedSnapshot = await waitForV4ConversationState(
      (snapshot) =>
        Boolean(snapshot.sessionId || snapshot.taskId) &&
        (snapshot.sessionId || snapshot.taskId) !== sourceSessionId &&
        snapshot.queueCount === 0 &&
        snapshot.targetObjective?.includes(goalMarker) === true &&
        snapshot.targetStatus === "paused",
      "goal 父会话 fork 后 child 没有继承 target 或 queue 不为空",
      30000,
    );

    expect(forkedSnapshot.sessionId || forkedSnapshot.taskId).not.toBe(sourceSessionId);
    expect(forkedSnapshot.queueCount).toBe(0);
    expect(await getQueueItems()).toHaveLength(0);
    expect(forkedSnapshot.targetObjective).toContain(goalMarker);
    expect(forkedSnapshot.targetStatus).toBe("paused");

    await selectV4TaskById(sourceSessionId ?? "");
    await waitForV4ConversationState(
      (snapshot) =>
        getSnapshotSessionId(snapshot) === sourceSessionId &&
        snapshot.targetObjective?.includes(goalMarker) === true &&
        snapshot.targetStatus === "paused",
      "切回父 session 后 goal target 没有保留",
      30000,
    );
    const restoredParentQueue = await waitForQueueCount(1);
    expect(restoredParentQueue[0]?.id).toBe(parentQueueItemId);
    expect(restoredParentQueue[0]?.content).toContain(queuedMarker);
  });

  it("edit 重跑后的 assistant fork 应只复制编辑后的 active branch", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const originalMarker = `E2E_FORK_EDIT_OLD_${runId}`;
    const originalPrompt = buildReplyPrompt(originalMarker);
    await sendV4Prompt(originalPrompt);
    await waitForV4ComposerText("", "fork edit 原始消息发送后输入框没有清空");
    await waitForV4UserMessageContaining(originalPrompt);
    const originalSourceSnapshot = await waitForV4ConversationState(
      (snapshot) => Boolean(snapshot.sessionId || snapshot.taskId),
      "fork edit 原始消息发送后没有绑定 source session",
      30000,
    );
    const sourceSessionId = getSnapshotSessionId(originalSourceSnapshot);
    expect(sourceSessionId).toBeTruthy();
    await waitForUpstreamNetworkCapture(originalMarker);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) =>
        getSnapshotSessionId(snapshot) === sourceSessionId &&
        snapshot.state === "idle" &&
        isRuntimeCompleted(snapshot) &&
        snapshot.queueCount === 0,
      "fork edit 原始消息完成后没有回到 idle",
      90000,
    );
    await waitForV4UserMessageContaining(originalPrompt);

    const editedMarker = `E2E_FORK_EDIT_ACTIVE_${runId}`;
    const editedPrompt = buildReplyPrompt(editedMarker);
    await editUserMessageContaining(originalMarker, editedPrompt);
    // 失败现场已点击提交且 RPC 返回，但没有 Provider 请求；先保留命令拒绝原因，
    // 避免仅等待网络后把 admission 失败误报为缺失模型响应，不重发编辑命令。
    const editAck = await waitForLatestV4CommandAck("editUserQuery");
    if (editAck.status !== "accepted") {
      throw new Error(`fork edit 提交未接纳: ${JSON.stringify(editAck)}`);
    }
    await waitForUpstreamNetworkCapture(editedMarker);
    await waitForV4UserMessageContaining(editedPrompt);
    await waitForV4ConversationState(
      (snapshot) =>
        getSnapshotSessionId(snapshot) === sourceSessionId &&
        snapshot.state === "idle" &&
        isRuntimeCompleted(snapshot) &&
        snapshot.queueCount === 0 &&
        Boolean(snapshot.sessionId || snapshot.taskId),
      "fork edit 重跑完成后没有回到可 fork 状态",
      90000,
    );
    await waitForVisibleUserMessagesNotContaining(originalMarker);

    const assistantMessageId = await waitForAssistantMessageIdAfterUser(
      editedMarker,
      E2E_REPLY_TOKEN,
    );

    await clickForkButtonForAssistantMessageId(assistantMessageId);
    const forkedSnapshot = await waitForV4ConversationState(
      (snapshot) =>
        Boolean(snapshot.sessionId || snapshot.taskId) &&
        getSnapshotSessionId(snapshot) !== sourceSessionId &&
        snapshot.queueCount === 0,
      "edit 后 fork 没有切换到空队列 child session",
      30000,
    );

    expect(getSnapshotSessionId(forkedSnapshot)).not.toBe(sourceSessionId);
    await waitForV4UserMessageContaining(editedPrompt);
    await assertVisibleV4UserMessagesNotContaining(originalMarker);
    expect((await getV4Messages()).map((message) => message.text).join("\n")).toContain(
      editedMarker,
    );
  });
});

type ChatSnapshot = Awaited<ReturnType<typeof getV4ConversationState>>;

function getSnapshotSessionId(snapshot: ChatSnapshot): string | null {
  return snapshot.sessionId || snapshot.taskId;
}

function isRuntimeCompleted(snapshot: ChatSnapshot): boolean {
  return snapshot.state === "idle";
}

async function setSessionTargetForE2E(
  sessionId: string,
  objective: string,
  status: "active" | "paused" | "budget_limited" | "complete",
) {
  const dbPath = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
  const db = new DatabaseSync(dbPath);
  const now = Date.now();
  const targetId = `target_e2e_${randomUUID()}`;
  try {
    // 修复原因：FK/E07 只需要“父 session 已有 target”这个前置状态。
    // 通过聊天输入发送 /goal 会额外制造一条可见 user query，污染 fork 历史边界。
    // 这里不能写 active target；UI 会把 active target 当作自动续跑中的目标，
    // 普通 source prompt 会进入未来队列而不是启动父 session active turn。
    db.prepare(
      `
      insert into session_target (
        session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated
      ) values (?, ?, ?, null, ?, null, 0, 0, ?, ?)
      on conflict(session_id) do update set
        target_id = excluded.target_id,
        objective = excluded.objective,
        summary_title = excluded.summary_title,
        status = excluded.status,
        token_budget = excluded.token_budget,
        tokens_used = excluded.tokens_used,
        time_used_seconds = excluded.time_used_seconds,
        active_input_id = null,
        active_run_started_at = null,
        active_run_last_seen_at = null,
        time_created = excluded.time_created,
        time_updated = excluded.time_updated
      `,
    ).run(sessionId, targetId, objective, status, now, now);
    db.prepare("update session set time_updated = max(time_updated, ?) where id = ?").run(
      now,
      sessionId,
    );
  } finally {
    db.close();
  }
}

function readSessionTargetForE2E(sessionId: string): { objective: string; status: string } | null {
  const dbPath = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return (
      (db
        .prepare("select objective, status from session_target where session_id = ?")
        .get(sessionId) as { objective: string; status: string } | undefined) ?? null
    );
  } finally {
    db.close();
  }
}

function buildReplyPrompt(marker: string): string {
  return `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

async function waitForAssistantMessageIdAfterUser(
  userMarker: string,
  assistantText: string,
): Promise<string> {
  let latestMessages: Awaited<ReturnType<typeof getV4Messages>> = [];
  let matchedId: string | null = null;
  await browser.waitUntil(
    async () => {
      latestMessages = await getV4Messages();
      const userIndex = findLastMessageIndex(latestMessages, "user", userMarker);
      if (userIndex < 0) {
        return false;
      }
      const assistant = latestMessages
        .slice(userIndex + 1)
        .find(
          (message) =>
            message.role === "assistant" &&
            message.text.includes(assistantText) &&
            Boolean(message.id),
        );
      matchedId = assistant?.id ?? null;
      if (!matchedId) return false;
      const action = await getForkButtonForAssistantMessageId(matchedId);
      return action.exists && !action.disabled && !action.ariaDisabled;
    },
    {
      timeout: 90000,
      timeoutMsg: `没有找到 ${userMarker} 之后包含 ${assistantText} 的 assistant 消息; latest=${JSON.stringify(
        latestMessages,
      )}`,
    },
  );
  if (!matchedId) {
    throw new Error(`assistant message id 缺失: ${userMarker}`);
  }
  return matchedId;
}

async function waitForVisibleUserMessagesNotContaining(text: string) {
  let latestMessages: Awaited<ReturnType<typeof getV4Messages>> = [];
  await browser.waitUntil(
    async () => {
      latestMessages = await getV4Messages("user");
      return !latestMessages.some((message) => message.text.includes(text));
    },
    {
      timeout: 30000,
      timeoutMsg: `可见 user 消息仍包含 ${text}; latest=${JSON.stringify(latestMessages)}`,
    },
  );
}

function findLastMessageIndex(
  messages: Awaited<ReturnType<typeof getV4Messages>>,
  role: string,
  text: string,
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === role && message.text.includes(text)) {
      return index;
    }
  }
  return -1;
}

async function waitForForkButtonForAssistantMessageId(messageId: string) {
  let latestSummary = "null";
  await browser.waitUntil(
    async () => {
      const latest = await getForkButtonForAssistantMessageId(messageId);
      latestSummary = JSON.stringify(latest);
      return latest.exists && !latest.disabled && !latest.ariaDisabled;
    },
    {
      timeout: 30000,
      timeoutMsg: `assistant 消息没有出现可用 fork 按钮: ${messageId}; latest=${JSON.stringify(
        latestSummary,
      )}`,
    },
  );
  const button = await getForkButtonForAssistantMessageId(messageId);
  if (!button.exists || button.disabled || button.ariaDisabled) {
    throw new Error(
      `assistant fork 按钮在等待后仍不可用: ${messageId}; latest=${JSON.stringify(button)}`,
    );
  }
  return button;
}

function getForkButtonForAssistantMessageId(messageId: string): Promise<{
  ariaDisabled: boolean;
  disabled: boolean;
  exists: boolean;
  testId: string;
}> {
  return browser.execute(
    (forkButtonPrefix, targetMessageId) => {
      // V4 使用 canonical rowId 与 v4-fork 按钮；旧 msg_* 和 data-message-id 会漏掉已完成消息。
      const button = document.querySelector<HTMLButtonElement>(
        `[data-testid="v4-session-pane-workspace-main"] [data-testid="${forkButtonPrefix}-${targetMessageId}"]`,
      );
      return {
        ariaDisabled: button?.getAttribute("aria-disabled") === "true",
        disabled: button?.disabled ?? false,
        exists: Boolean(button),
        testId: button?.getAttribute("data-testid") ?? `${forkButtonPrefix}-${targetMessageId}`,
      };
    },
    TID_V4_FORK,
    messageId,
  );
}

async function clickForkButtonForAssistantMessageId(messageId: string) {
  const button = await waitForForkButtonForAssistantMessageId(messageId);
  await clickTestIdByDom(button.testId, {
    timeout: 15000,
    timeoutMsg: `assistant fork 按钮不可点击: ${messageId}`,
  });
}
