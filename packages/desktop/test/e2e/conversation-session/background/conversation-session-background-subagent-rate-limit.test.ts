import { TID_V4_SUBAGENT_OPEN_SIDE_PANE } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  expandAssistantHistoriesWithContent,
  waitForToolCallBlockByToolCallId,
} from "#e2e/helpers/conversation-session-tool";
import { getToolCallDiagnostics } from "#e2e/helpers/conversation-session-tool-diagnostics";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import {
  beginConversationTelemetryCapture,
  readConversationReportRequests,
  waitForConversationReportInventory,
} from "#e2e/helpers/conversation-telemetry-parity-capture";

const BG26_TIMEOUT_MS = 240000;
const PARENT_MARKER = "E2E_BACKGROUND_SUBAGENT_RATE_LIMIT_PARENT";
const PARENT_DONE = "E2E_BACKGROUND_SUBAGENT_RATE_LIMIT_PARENT_DONE";
const CHILD_MARKER = "E2E_BACKGROUND_SUBAGENT_RATE_LIMIT_CHILD";
const TOOL_CALL_ID = "toolu_e2e_background_subagent_rate_limit_agent";
const RATE_LIMIT_ERROR_PREFIX =
  "Requests are too frequent. Please reduce your request frequency, wait a short moment, and retry your request. Request id: ";
const PROVIDER_ERROR = `${RATE_LIMIT_ERROR_PREFIX}e2e-background-subagent-rate-limit`;
const MERGED_PARENT_MARKER = "E2E_BG26_MERGED_PARENT";
const MERGED_PARENT_DONE = "E2E_BG26_MERGED_PARENT_DONE";
const MERGED_COMPLETED_RESULT = "E2E_BG26_MERGED_COMPLETED_RESULT";
const MERGED_COMPLETED_TOOL_CALL_ID = "toolu_e2e_bg26_merged_completing_agent";
const MERGED_FIRST_FAILED_AGENT = {
  toolCallId: "toolu_e2e_bg26_merged_first_failing_agent",
  providerError: `${RATE_LIMIT_ERROR_PREFIX}e2e-bg26-merged-first-failure`,
};
const MERGED_LAST_FAILED_AGENT = {
  toolCallId: "toolu_e2e_bg26_merged_last_failing_agent",
  providerError: `${RATE_LIMIT_ERROR_PREFIX}e2e-bg26-merged-last-failure`,
};
/** 第一个失败 child 在 429 之前写出的正文，失败通知把它作为部分报告放进 `<result>`。 */
const MERGED_FIRST_PARTIAL_REPORT = "E2E_BG26_MERGED_FIRST_PARTIAL_REPORT";

interface FailedAgentExpectation {
  toolCallId: string;
  providerError: string;
  /** 不能出现在这张卡失败 hover 里的文字：同批其他通知的结果或原因，以及本任务只给模型的部分报告。 */
  foreignTexts?: readonly string[];
  /** 单条通知的轮次：hover 只显示 provider 原文，不带 `Agent "…" failed:` 前缀。 */
  exactTooltip?: boolean;
}

describe("会话区 background subagent 429 错误展示 E2E", () => {
  before(async function () {
    this.timeout(BG26_TIMEOUT_MS);
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BG26: 429 原始错误进入 subagent result、失败 hover 和 restore snapshot", async function () {
    this.timeout(BG26_TIMEOUT_MS);

    const telemetryCapture = await beginConversationTelemetryCapture();
    const prompt = `${PARENT_MARKER}: launch one background Agent and finish after its failed task notification with ${PARENT_DONE}.`;
    // Bug 原因：v4 已删除 chat-input/chat-view，旧 formal case 在 before hook 等待
    // legacy composer，真实场景从未执行。发送、timeline、session 切换统一走 v4 contract。
    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(PARENT_MARKER, 60000);
    await waitForToolCallBlockByToolCallId(TOOL_CALL_ID, 60000);

    // Bug 根因：旧断言直接等待 parent notification；失败时无法判断 child 物理请求
    // 是否到达 replay server。先建立 child request 屏障，让 shard 日志明确区分网络
    // 发送停滞与 429 terminal/notification 投影停滞。
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [CHILD_MARKER] },
      "background subagent child 请求没有到达 replay server",
      60000,
    );
    await waitForUpstreamRequest(
      {
        includes: [
          `<tool-use-id>${TOOL_CALL_ID}</tool-use-id>`,
          "<status>failed</status>",
          // 失败原因只在 summary 的 "failed: " 后面，不再有 <error>。
          `failed: ${PROVIDER_ERROR}</summary>`,
        ],
      },
      "background subagent failed notification 没有透传 provider 原始错误",
      90000,
    );
    // 本任务的通知块不再带 <error>；请求其他位置的同名标签不影响判断。
    const [notificationRequest] = await getUpstreamRequestEvidence({
      includes: [`<tool-use-id>${TOOL_CALL_ID}</tool-use-id>`, "<status>failed</status>"],
    });
    const notificationBlock = taskNotificationBlocks(notificationRequest!.requestJson).find(
      (block) => block.includes(`<tool-use-id>${TOOL_CALL_ID}</tool-use-id>`),
    );
    expect(notificationBlock).toContain(`failed: ${PROVIDER_ERROR}</summary>`);
    expect(notificationBlock).not.toContain("<error>");
    await waitForV4TimelineContaining(PARENT_DONE, 90000);
    await waitForConversationReportInventory(telemetryCapture, {
      message_completion: 2,
    });
    const reports = await readConversationReportRequests(telemetryCapture);
    // 早期 staging 断言没有后台 step；后续首终态结算已要求失败也报告零用量 Agent 汇总。
    // 请求返回 429 没有 usage，不能把失败调用计成已确认的计费用量。
    expect(
      reports.filter(
        (report) =>
          report.element_name === "agent_step" &&
          (report.event_extra_detail as Record<string, unknown> | undefined)?.agent_role ===
            "background subagent",
      ),
    ).toEqual([
      expect.objectContaining({
        event_extra_detail: expect.objectContaining({
          agent_role: "background subagent",
          tool_name: "Agent",
          status: "fail",
          // 上报按隐私契约移除错误正文；下方 UI/restore 仍验证同一 provider 原文。
          error_msg: "[redacted]",
          error_type: "TOOL_EXEC_ERROR",
          model_request_count: "0",
          token_usage_scope: "",
          total_tokens: "0",
        }),
      }),
    ]);
    expect(
      reports.filter(
        (report) =>
          report.element_name === "message_completion" &&
          ["child_session_id", "parent_tool_call_id"].some((key) =>
            Object.hasOwn(
              (report.event_extra_detail as Record<string, unknown> | undefined) ?? {},
              key,
            ),
          ),
      ),
    ).toHaveLength(0);
    const idleSnapshot = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "background subagent 429 notification 后父会话没有回到 idle",
      60000,
    );
    if (!idleSnapshot.sessionId || idleSnapshot.sessionId === "draft") {
      throw new Error(`background subagent 429 case 缺少 taskId: ${JSON.stringify(idleSnapshot)}`);
    }

    const sourceTaskId = idleSnapshot.sessionId;
    const failedAgent = {
      toolCallId: TOOL_CALL_ID,
      providerError: PROVIDER_ERROR,
      exactTooltip: true,
    };
    await assertFailedAgentSurface("live", failedAgent);

    await switchAwayAndBack(sourceTaskId, PARENT_DONE);

    await assertFailedAgentSurface("restored", failedAgent);
  });

  it("BG26 合并通知：失败、完成、失败三条通知同批回传，各卡显示自己的终态", async function () {
    this.timeout(BG26_TIMEOUT_MS);

    await startNewV4Draft();
    await sendV4Prompt(
      `${MERGED_PARENT_MARKER}: launch three background Agents and finish after their task notifications with ${MERGED_PARENT_DONE}.`,
    );
    await waitForV4TimelineContaining(MERGED_PARENT_MARKER, 60000);
    for (const toolCallId of [
      MERGED_FIRST_FAILED_AGENT.toolCallId,
      MERGED_COMPLETED_TOOL_CALL_ID,
      MERGED_LAST_FAILED_AGENT.toolCallId,
    ]) {
      await waitForToolCallBlockByToolCallId(toolCallId, 60000);
    }
    // 三条通知必须进入同一个 provider request，否则测不到合并通知的投影。
    await waitForUpstreamRequest(
      {
        lastUserMessageIncludes: [
          `failed: ${MERGED_FIRST_FAILED_AGENT.providerError}</summary>`,
          MERGED_COMPLETED_RESULT,
          `failed: ${MERGED_LAST_FAILED_AGENT.providerError}</summary>`,
        ],
      },
      "三条 background Agent notification 没有合并到同一个 provider request",
      90000,
    );
    // 第一个失败 child 在 429 前写过正文：它的失败通知带部分报告，父模型可以据此续接；
    // 最后一个失败 child 没写过正文，不带 <result>。
    const [mergedNotificationRequest] = await getUpstreamRequestEvidence({
      lastUserMessageIncludes: [
        `<tool-use-id>${MERGED_FIRST_FAILED_AGENT.toolCallId}</tool-use-id>`,
        `<tool-use-id>${MERGED_LAST_FAILED_AGENT.toolCallId}</tool-use-id>`,
      ],
    });
    const mergedBlocks = taskNotificationBlocks(mergedNotificationRequest!.requestJson);
    const firstFailedBlock = mergedBlocks.find((block) =>
      block.includes(`<tool-use-id>${MERGED_FIRST_FAILED_AGENT.toolCallId}</tool-use-id>`),
    );
    const lastFailedBlock = mergedBlocks.find((block) =>
      block.includes(`<tool-use-id>${MERGED_LAST_FAILED_AGENT.toolCallId}</tool-use-id>`),
    );
    expect(firstFailedBlock).toContain(`<result>${MERGED_FIRST_PARTIAL_REPORT}</result>`);
    expect(lastFailedBlock).not.toContain("<result>");
    await waitForV4TimelineContaining(MERGED_PARENT_DONE, 90000);
    const idleSnapshot = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "合并通知消费后父会话没有回到 idle",
      60000,
    );
    if (!idleSnapshot.sessionId || idleSnapshot.sessionId === "draft") {
      throw new Error(`合并通知 case 缺少 taskId: ${JSON.stringify(idleSnapshot)}`);
    }

    const sourceTaskId = idleSnapshot.sessionId;
    await assertMergedAgentSurfaces("merged live");

    await switchAwayAndBack(sourceTaskId, MERGED_PARENT_DONE);

    await assertMergedAgentSurfaces("merged restored");
  });
});

async function switchAwayAndBack(sourceTaskId: string, doneMarker: string) {
  await startNewV4Draft();
  await selectV4TaskById(sourceTaskId);
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sourceTaskId && !snapshot.canStop,
    "background subagent 429 case 切回后没有完成原 task snapshot restore",
    30000,
  );
  await waitForV4TimelineContaining(doneMarker, 60000);
}

async function assertMergedAgentSurfaces(stage: string) {
  // Bug 原因：合并通知曾跨块读取标签。第一张失败卡的原因取到同批完成任务的 <result>；
  // 后面的通知块不更新卡片，最后一张失败卡停在 launch ACK 的 completed。
  // 失败通知的 <result> 是只给模型的部分报告；合并轮没有结构化原因，App 不丢弃它时
  // 失败原因会退到这段正文，hover 就不再是失败原因。
  await assertFailedAgentSurface(stage, {
    ...MERGED_FIRST_FAILED_AGENT,
    foreignTexts: [
      MERGED_COMPLETED_RESULT,
      MERGED_LAST_FAILED_AGENT.providerError,
      MERGED_FIRST_PARTIAL_REPORT,
    ],
  });
  await assertFailedAgentSurface(stage, {
    ...MERGED_LAST_FAILED_AGENT,
    foreignTexts: [MERGED_COMPLETED_RESULT, MERGED_FIRST_FAILED_AGENT.providerError],
  });
  await waitForAgentCardStatus(MERGED_COMPLETED_TOOL_CALL_ID, "completed", stage);
}

async function waitForAgentCardStatus(toolCallId: string, status: string, stage: string) {
  let latestDiagnostics: Awaited<ReturnType<typeof getToolCallDiagnostics>> | null = null;
  try {
    await browser.waitUntil(
      async () => {
        // Bug 根因：恢复后的 completed turn 默认折叠，失败 Agent 行尚未挂载；旧断言
        // 先查 block 再展开 history，因而把已持久化的 429 状态误报为 restore 丢失。
        await expandAssistantHistoriesWithContent();
        latestDiagnostics = await getToolCallDiagnostics({
          type: "toolCallId",
          value: toolCallId,
        });
        return latestDiagnostics.matchedBlock?.status === status;
      },
      {
        timeout: 30000,
        timeoutMsg: `${stage} Agent 卡没有进入 ${status}: ${toolCallId}`,
      },
    );
  } catch (error) {
    throw new Error(
      `${stage} Agent 卡没有进入 ${status}: ${toolCallId}; latest=${JSON.stringify(latestDiagnostics)}`,
      { cause: error },
    );
  }
}

async function assertFailedAgentSurface(stage: string, agent: FailedAgentExpectation) {
  // Bug 原因：child 429 与 parent failed notification 已持久化成功，但 v4 Agent
  // 卡片投影仍保留 completed。这里直接约束用户可见状态，避免继续依赖已删除的
  // legacy renderer store 投影而掩盖真实产品回归。
  await waitForAgentCardStatus(agent.toolCallId, "failed", stage);

  const blockSnapshot = await waitForToolCallBlockByToolCallId(agent.toolCallId, 30000);
  // Bug 根因：Agent 卡产品合同已改成“父对话单行摘要 + 右侧 child session”，
  // canToggle=false，不再渲染可展开的 tool-summary-trigger。旧 E2E 继续展开必然
  // 假失败；429 原始错误由 provider request 与失败状态 tooltip 两层证据约束。
  const sidePaneAction = await $(`[data-testid="${blockSnapshot.testId}"]`).$(
    `[data-testid^="${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-"]`,
  );
  await sidePaneAction.waitForDisplayed({
    timeout: 10000,
    timeoutMsg: `${stage} Agent 卡没有右侧 child session 入口`,
  });
  // tooltip trigger 可能只渲染图标而没有可读文本；可见文案以整张 Agent 卡为准。
  expect(["执行失败", "Failed"].some((label) => blockSnapshot.text.includes(label))).toBe(true);
  const block = await $(`[data-testid="${blockSnapshot.testId}"]`);
  const failedStatus = await block.$('[data-slot="tooltip-trigger"]');
  await failedStatus.waitForDisplayed({
    timeout: 10000,
    timeoutMsg: `${stage} Agent 卡没有失败 tooltip trigger`,
  });
  // E2E 的系统语言跟随 runner；两种受支持语言都必须保留既有失败文案与同一 hover 交互。
  await hoverFailedAgentStatus(blockSnapshot.testId, stage, agent);
  await $('[data-testid^="v4-session-pane-"]').moveTo({
    xOffset: 20,
    yOffset: 20,
  });

  const current = await getV4PaneSnapshot();
  expect(current.canStop).toBe(false);
}

async function hoverFailedAgentStatus(
  blockTestId: string,
  stage: string,
  agent: FailedAgentExpectation,
  attempt = 1,
): Promise<void> {
  // Bug 根因：卡片展开和流式收口会让 Radix trigger 重挂载；长批次里单次 moveTo
  // 可能落在旧节点上，或者指针仍在相同坐标而没有新的 pointerenter。每次都从当前
  // DOM 重新取 trigger，先移出卡片再做真实 hover，并只接受当前可见的 tooltip。
  const pane = await $('[data-testid^="v4-session-pane-"]');
  await pane.moveTo({ xOffset: 20, yOffset: 20 });
  const currentBlock = await $(`[data-testid="${blockTestId}"]`);
  const currentTrigger = await currentBlock.$('[data-slot="tooltip-trigger"]');
  await currentTrigger.waitForDisplayed({ timeout: 3000 });
  await currentTrigger.moveTo();

  let latestTooltipText: string | null = null;
  const opened = await browser
    .waitUntil(
      async () => {
        latestTooltipText = await browser.execute(() => {
          const visibleTooltip = Array.from(
            document.querySelectorAll<HTMLElement>('[data-slot="tooltip-content"]'),
          ).find((element) => {
            const style = window.getComputedStyle(element);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0 &&
              element.getClientRects().length > 0
            );
          });
          return visibleTooltip?.innerText ?? null;
        });
        // Radix 会同时维护展示内容和可访问性镜像，innerText 在部分 Chromium
        // 时序下会返回两份相同文案；产品约束是可见 tooltip 完整包含原始错误。
        return normalizeText(latestTooltipText ?? "").includes(normalizeText(agent.providerError));
      },
      {
        interval: 100,
        timeout: 3000,
        timeoutMsg: `${stage} 执行失败 hover 没有显示匹配的可见 tooltip`,
      },
    )
    .then(() => true)
    .catch(() => false);
  if (opened) {
    for (const foreignText of agent.foreignTexts ?? []) {
      expect(normalizeText(latestTooltipText ?? "")).not.toContain(normalizeText(foreignText));
    }
    if (agent.exactTooltip) {
      expect(collapseMirroredText(normalizeText(latestTooltipText ?? ""))).toBe(
        normalizeText(agent.providerError),
      );
    }
    return;
  }
  if (attempt >= 3) {
    throw new Error(
      `${stage} 执行失败 hover 没有显示可见 tooltip; latest=${JSON.stringify(latestTooltipText)}`,
    );
  }
  await hoverFailedAgentStatus(blockTestId, stage, agent, attempt + 1);
}

// Radix 的可访问性镜像会让 innerText 返回两份相同文案；精确比较前合成一份。
function collapseMirroredText(value: string) {
  const half = value.slice(0, Math.floor((value.length - 1) / 2));
  return value === `${half} ${half}` ? half : value;
}

// 按 <task-notification> 块拆出请求里的通知，只看文本块。
function taskNotificationBlocks(requestJson: unknown): string[] {
  const messages = (requestJson as { messages?: Array<{ content?: unknown }> }).messages ?? [];
  const text = messages
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content.flatMap((block) => {
              const item = block as { text?: unknown; content?: unknown };
              if (typeof item.text === "string") return [item.text];
              return typeof item.content === "string" ? [item.content] : [];
            })
          : [],
    )
    .join("\n");
  return text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? [];
}

function normalizeText(value: string) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
