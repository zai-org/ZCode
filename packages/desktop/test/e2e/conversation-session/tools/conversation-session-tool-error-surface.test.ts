import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import { waitForFoldedToolCallBlockByToolCallId } from "#e2e/helpers/conversation-session-tool";
import { getToolCallDiagnostics } from "#e2e/helpers/conversation-session-tool-diagnostics";

const PARENT_MARKER = "E2E_TOOL_ERROR_SURFACE_PARENT";
const STALE_CHILD_MARKER = "E2E_TOOL_ERROR_SURFACE_STALE_CHILD";
const HEALTHY_CHILD_MARKER = "E2E_TOOL_ERROR_SURFACE_HEALTHY_CHILD";
const HEALTHY_CHILD_DONE = "E2E_TOOL_ERROR_SURFACE_HEALTHY_OK";
const PARENT_DONE = "E2E_TOOL_ERROR_SURFACE_PARENT_DONE";
const STALE_AGENT_TYPE = "e2e-stale-error-reviewer";
const HEALTHY_AGENT_TYPE = "e2e-healthy-error-reviewer";
const STALE_PROVIDER_ID = "e2e-stale-provider";
const STALE_MODEL_ID = "e2e-stale-model";
const STALE_ERROR_TEXT = `reason=provider-not-found; selection=${STALE_PROVIDER_ID}/${STALE_MODEL_ID}`;
const GENERIC_TURN_ERROR_TEXT = "Turn execution failed";
const STALE_AGENT_TOOL_CALL_ID = "toolu_e2e_tool_error_surface_stale_agent";
const HEALTHY_AGENT_TOOL_CALL_ID = "toolu_e2e_tool_error_surface_healthy_agent";

describe("会话区 toolcall 错误展示 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Z01: Agent 失败工具卡展示真实 provider 根因且不阻断同轮 sibling Agent", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const marker = `${PARENT_MARKER}_${runId}`;
    const prompt = [
      `${marker}: launch two Agent tools in the same assistant response.`,
      `One must use subagent_type "${STALE_AGENT_TYPE}" for ${STALE_CHILD_MARKER}.`,
      `The other must use subagent_type "${HEALTHY_AGENT_TYPE}" for ${HEALTHY_CHILD_MARKER}.`,
      `After both tool results return, reply with exactly ${PARENT_DONE}.`,
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "tool error surface 首发后输入框没有清空");
    await waitForV4UserMessageContaining(marker);

    // 最终回复会收起工具历史；先确认回合完成，再由公共 helper 展开历史检查两张卡。
    await waitForV4AssistantMessageContaining(PARENT_DONE);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "tool error surface case 完成后没有回到 idle",
      60000,
    );

    // 修复原因：最后一轮结束后保持同一组件实例，约 0.3 秒后工具卡才收进工作记录并重挂；
    // 通用等待器可能命中收起前的旧卡，悬停随后落在已卸载的状态文字上，tooltip 不出现。
    await waitForFoldedToolCallBlockByToolCallId(STALE_AGENT_TOOL_CALL_ID, 60000);
    await waitForFoldedToolCallBlockByToolCallId(HEALTHY_AGENT_TOOL_CALL_ID, 60000);

    await waitForToolBlockStatus(STALE_AGENT_TOOL_CALL_ID, "failed");
    await waitForToolBlockStatus(HEALTHY_AGENT_TOOL_CALL_ID, "completed");

    // V4 不写旧 taskMessagesByTaskId；读取真实失败卡的 hover，避免把旧 Store 空数组
    // 误判成错误丢失。Registry 在启动前拒绝失效 Provider，根因包含完整模型身份。
    const failureStatus = $(`[data-tool-call-id="${STALE_AGENT_TOOL_CALL_ID}"] .cursor-help`);
    await failureStatus.waitForDisplayed({ timeout: 15000 });
    // Radix 的 role=tooltip 是屏幕阅读器副本；可见内容在 tooltip-content。
    const tooltip = $('[data-slot="tooltip-content"]');
    await hoverUntilTooltipDisplayed(failureStatus, tooltip);
    const errorText = await tooltip.getText();
    expect(errorText).toContain(STALE_ERROR_TEXT);
    expect(errorText).not.toContain(GENERIC_TURN_ERROR_TEXT);

    await waitForUpstreamRequest(
      {
        excludes: [GENERIC_TURN_ERROR_TEXT],
        includes: [
          marker,
          STALE_AGENT_TOOL_CALL_ID,
          HEALTHY_AGENT_TOOL_CALL_ID,
          STALE_ERROR_TEXT,
          HEALTHY_CHILD_DONE,
        ],
      },
      "父 continuation 没有同时收到真实失败 tool_result 和 sibling Agent 成功结果",
      60000,
    );
  });
});

async function waitForToolBlockStatus(toolCallId: string, status: string, timeout = 60000) {
  let latestStatus: string | null = null;
  await browser.waitUntil(
    async () => {
      const diagnostics = await getToolCallDiagnostics({
        type: "toolCallId",
        value: toolCallId,
      });
      latestStatus = diagnostics.matchedBlock?.status ?? null;
      return latestStatus === status;
    },
    {
      timeout,
      timeoutMsg: `toolCallId=${toolCallId} 没有进入 ${status}; latestStatus=${latestStatus}`,
    },
  );
}

/**
 * 悬停状态文字，直到 tooltip 可见。
 * 修复原因：工具卡收进工作记录后，展开的工作记录内容约 250ms 内仍在滚动（scrollTop 动画到 0）；
 * Radix Tooltip 在祖先滚动时关闭（运行时记录：60ms delayed-open，72ms scroll，77ms closed）。
 * 指针停在原地不会再触发打开，Radix 要先收到 pointerleave 才重新响应 pointermove。
 * 每轮先把指针移到状态文字左侧 3px（与失败图标之间的间隙，不落在其他 tooltip 触发器上），
 * 再移回状态文字，等滚动停下后的那次悬停打开 tooltip。
 */
async function hoverUntilTooltipDisplayed(
  trigger: ReturnType<typeof $>,
  tooltip: ReturnType<typeof $>,
  timeout = 15000,
) {
  await browser.waitUntil(
    async () => {
      const element = await trigger;
      const { width } = await element.getSize();
      await browser
        .action("pointer", { parameters: { pointerType: "mouse" } })
        .move({ origin: element, x: -(Math.floor(width / 2) + 3), y: 0 })
        .perform();
      await element.moveTo();
      return tooltip
        .waitForDisplayed({ timeout: 1000 })
        .then(() => true)
        .catch(() => false);
    },
    { timeout, interval: 0, timeoutMsg: "失败状态文字悬停后 tooltip 没有显示" },
  );
}
