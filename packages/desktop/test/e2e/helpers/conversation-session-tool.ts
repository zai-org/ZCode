import {
  TID_CHAT_ASSISTANT_HISTORY_CONTENT,
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_CHAT_ASSISTANT_MESSAGE,
  TID_CHAT_TOOL_CALL_BLOCK,
  testId,
} from "@zcode/shared/test-ids";
import {
  getLatestUpstreamToolResultByToolCallId,
  type UpstreamToolResultSnapshot,
} from "./conversation-session-network.js";
import {
  expandAssistantHistoriesWithContent,
  expandVisibleSummaryGroups,
  getToolCallDiagnostics,
  type ToolCallBlockSnapshot,
  type ToolCallDiagnostics,
  type ToolCallMatcher,
} from "./conversation-session-tool-diagnostics.js";

export { expandAssistantHistoriesWithContent } from "./conversation-session-tool-diagnostics.js";

interface AssistantHistoryOpenSnapshot {
  assistantText: string;
  contentExists: boolean;
  contentOpen: string | null;
  expanded: boolean;
  reason: string | null;
  triggerTestId: string | null;
}

export async function waitForToolCallBlockContaining(
  text: string,
  timeout = 20000,
): Promise<ToolCallBlockSnapshot> {
  return waitForToolCallBlock({ type: "text", value: text }, timeout);
}

export async function waitForToolCallBlockByToolName(
  toolName: string,
  timeout = 20000,
): Promise<ToolCallBlockSnapshot> {
  return waitForToolCallBlock({ type: "toolName", value: toolName }, timeout);
}

export async function waitForToolCallBlockByToolCallId(
  toolCallId: string,
  timeout = 20000,
): Promise<ToolCallBlockSnapshot> {
  return waitForToolCallBlock({ type: "toolCallId", value: toolCallId }, timeout);
}

/**
 * 等已结束轮次的工具卡片收进“工作记录”后再返回。
 * Bug 根因：轮次结束（canStop=false）约 0.3 秒后，卡片才从展开区收进工作记录并重新挂载；
 * waitForToolCallBlockByToolCallId 可能在收起前命中旧节点，调用方随后按 testid 再查 DOM
 * 会落空（运行时采样：命中后 213ms 仍在、319ms 消失，展开工作记录后卡片恢复且文案正确）。
 * 修复：以“卡片位于展开的工作记录内容里”作为收起完成的信号，再交给通用等待器取快照。
 * 只用于以正文结束的轮次（已在 TS11/TS14 运行时验证）；进行中或已停止的卡片沿用通用等待器。
 */
export async function waitForFoldedToolCallBlockByToolCallId(
  toolCallId: string,
  timeout = 20000,
): Promise<ToolCallBlockSnapshot> {
  await browser.waitUntil(
    async () => {
      await expandAssistantHistoriesWithContent();
      await expandVisibleSummaryGroups();
      return browser.execute(
        (contentPrefix, blockTestId) =>
          document.querySelector(
            `[data-testid^="${contentPrefix}-"] [data-testid="${blockTestId}"]`,
          ) !== null,
        TID_CHAT_ASSISTANT_HISTORY_CONTENT,
        testId(TID_CHAT_TOOL_CALL_BLOCK, toolCallId),
      );
    },
    { timeout, timeoutMsg: `工具卡片没有收进工作记录: ${toolCallId}` },
  );
  return waitForToolCallBlockByToolCallId(toolCallId, timeout);
}

/**
 * 展开已完成回合里某个工具卡的详情，直到触发器真的是展开态。
 *
 * 失败原因：回合结束后，已完成回合会把工具块收进折叠的 assistant history，折叠内容不挂载。
 * 先找到块、再点击的两步写法，可能在收起前一刻看到块，随后点击落在已卸载的节点上，
 * 而 history 之后保持收起。这里每轮都先展开 history 与摘要组，再点工具卡，
 * 直到 `aria-expanded="true"`，不依赖收起发生的时刻。
 */
export async function expandToolCallDetails(toolCallId: string, timeout = 30000): Promise<void> {
  const trigger = `[data-tool-call-id="${toolCallId}"] [role="button"][aria-expanded]`;
  await browser.waitUntil(
    async () => {
      await expandAssistantHistoriesWithContent();
      await expandVisibleSummaryGroups();
      return browser.execute((selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return false;
        if (element.getAttribute("aria-expanded") === "true") return true;
        element.click();
        return false;
      }, trigger);
    },
    { timeout, interval: 250, timeoutMsg: `工具卡没有展开：${toolCallId}` },
  );
}

export async function listToolCallBlocks(): Promise<ToolCallBlockSnapshot[]> {
  const diagnostics = await getToolCallDiagnostics(null);
  return diagnostics.blocks;
}

export interface SuccessfulToolCallSnapshot {
  output: string;
  status: "completed";
  toolCallId: string;
  toolName: string | null;
}

export async function assertToolCallNotFailedByToolCallId(toolCallId: string): Promise<void> {
  const diagnostics = await getToolCallDiagnostics({
    type: "toolCallId",
    value: toolCallId,
  });
  const toolCall = findRendererStoreToolCall(diagnostics, toolCallId);
  if (toolCall?.status === "failed" || diagnostics.matchedBlock?.status === "failed") {
    throw createToolCallFailure(toolCallId, toolCall, diagnostics.matchedBlock);
  }
  const providerResult = await getLatestUpstreamToolResultByToolCallId(toolCallId);
  if (providerResult?.isError) {
    // Bug 根因：V4 历史投影可能在工具已经返回 is_error 后仍短暂显示 pending，
    // 直接读取模型实际收到的 tool_result，避免错误再次退化为 guest/UI 超时。
    throw createProviderToolResultFailure(providerResult);
  }
}

export async function waitForSuccessfulToolCallByToolCallId(
  toolCallId: string,
  expectedOutputIncludes: readonly string[] = [],
  timeout = 20000,
): Promise<SuccessfulToolCallSnapshot> {
  const deadline = Date.now() + timeout;
  let latest: ReturnType<typeof findRendererStoreToolCall> = null;
  while (Date.now() <= deadline) {
    const diagnostics = await getToolCallDiagnostics({
      type: "toolCallId",
      value: toolCallId,
    });
    latest = findRendererStoreToolCall(diagnostics, toolCallId);
    const block = diagnostics.matchedBlock;
    if (latest?.status === "failed" || block?.status === "failed") {
      // Bug 根因：Browser 无状态化后旧 fixture 的跨 cell binding 会直接令工具失败，
      // 但旧 E2E 继续等待 guest/UI，最终只报焦点超时。工具错误必须在真实边界立即暴露。
      throw createToolCallFailure(toolCallId, latest, block);
    }
    const providerResult = await getLatestUpstreamToolResultByToolCallId(toolCallId);
    if (providerResult?.isError) {
      throw createProviderToolResultFailure(providerResult);
    }
    if (latest?.status === "completed") {
      const output = latest.output ?? "";
      assertToolResultContains(toolCallId, output, expectedOutputIncludes);
      return {
        output,
        status: "completed",
        toolCallId: latest.toolId ?? toolCallId,
        toolName: latest.toolName,
      };
    }
    if (providerResult) {
      assertToolResultContains(toolCallId, providerResult.content, expectedOutputIncludes);
      return {
        output: providerResult.content,
        status: "completed",
        toolCallId,
        toolName: block?.toolName ?? latest?.toolName ?? null,
      };
    }
    if (block?.status === "completed" && expectedOutputIncludes.length === 0) {
      // V4 history case 的 renderer-store 旧消息投影可能为空，但 DOM tool block 是
      // 真实执行终态；要求 marker 时必须继续等模型实际收到的 provider tool_result。
      return {
        output: block.text,
        status: "completed",
        toolCallId: block.toolCallId ?? toolCallId,
        toolName: block.toolName,
      };
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(
    `toolCallId=${toolCallId} 没有在 ${timeout}ms 内成功完成; latest=${JSON.stringify(latest)}`,
  );
}

export async function openAssistantHistoryForAssistantContaining(
  text: string,
  timeout = 15000,
): Promise<AssistantHistoryOpenSnapshot> {
  let latest: AssistantHistoryOpenSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await clickAssistantHistoryForAssistantContaining(text);
        return latest.expanded;
      },
      {
        timeout,
        timeoutMsg: `没有展开包含指定内容的 assistant history: ${text}`,
      },
    );
  } catch {
    latest = await safeClickAssistantHistoryForAssistantContaining(text, latest);
    throw new Error(
      `没有展开包含指定内容的 assistant history: ${text}; latest=${JSON.stringify(latest)}`,
    );
  }
  const result = await clickAssistantHistoryForAssistantContaining(text);
  if (!result.expanded) {
    throw new Error(`assistant history 等待后仍未展开: ${text}; latest=${JSON.stringify(result)}`);
  }
  return result;
}

export function getToolCallBlockContaining(text: string): Promise<ToolCallBlockSnapshot | null> {
  return getMatchingToolCallBlock({ type: "text", value: text });
}

export function getToolCallBlockByToolName(
  toolName: string,
): Promise<ToolCallBlockSnapshot | null> {
  return getMatchingToolCallBlock({ type: "toolName", value: toolName });
}

export function getToolCallBlockByToolCallId(
  toolCallId: string,
): Promise<ToolCallBlockSnapshot | null> {
  return getMatchingToolCallBlock({ type: "toolCallId", value: toolCallId });
}

async function waitForToolCallBlock(
  matcher: ToolCallMatcher,
  timeout: number,
): Promise<ToolCallBlockSnapshot> {
  let latest: ToolCallDiagnostics | null = null;
  let matchedBlock: ToolCallBlockSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getToolCallDiagnostics(matcher);
        if (latest.matchedBlock?.exists === true) {
          matchedBlock = latest.matchedBlock;
          return true;
        }
        await expandAssistantHistoriesWithContent();
        await expandVisibleSummaryGroups();
        return false;
      },
      {
        timeout,
        timeoutMsg: `没有出现匹配的 tool call block: ${JSON.stringify(matcher)}`,
      },
    );
  } catch {
    latest = await safeGetToolCallDiagnostics(matcher, latest);
    throw new Error(
      `没有出现匹配的 tool call block: ${JSON.stringify(
        matcher,
      )}; diagnostics=${JSON.stringify(latest)}`,
    );
  }
  if (!matchedBlock) {
    latest = await safeGetToolCallDiagnostics(matcher, latest);
    throw new Error(
      `tool call block 等待后仍不存在: ${JSON.stringify(
        matcher,
      )}; diagnostics=${JSON.stringify(latest)}`,
    );
  }
  // 修复原因：tool block 命中后可能立即被折叠进 assistant history。重新查询 DOM
  // 会把已经成功观察到的短生命周期节点误判为不存在，应返回成功轮询捕获的快照。
  return matchedBlock;
}

async function getMatchingToolCallBlock(
  matcher: ToolCallMatcher,
): Promise<ToolCallBlockSnapshot | null> {
  const diagnostics = await getToolCallDiagnostics(matcher);
  return diagnostics.matchedBlock;
}

function findRendererStoreToolCall(diagnostics: ToolCallDiagnostics, toolCallId: string) {
  for (const message of diagnostics.rendererStore.messages) {
    const match = message.toolCalls.find(
      (toolCall) =>
        toolCall.toolId === toolCallId || toolCall.toolId?.startsWith(`${toolCallId}:`) === true,
    );
    if (match) return match;
  }
  return null;
}

function createToolCallFailure(
  toolCallId: string,
  toolCall: ReturnType<typeof findRendererStoreToolCall>,
  block: ToolCallBlockSnapshot | null,
): Error {
  return new Error(
    `toolCallId=${toolCallId} 执行失败; error=${JSON.stringify(toolCall?.error)}; ` +
      `rawError=${JSON.stringify(toolCall?.rawErrorMessage ?? toolCall?.rawErrorDetail)}; ` +
      `output=${JSON.stringify(toolCall?.output)}; block=${JSON.stringify(block)}`,
  );
}

function createProviderToolResultFailure(result: UpstreamToolResultSnapshot): Error {
  return new Error(
    `toolCallId=${result.toolCallId} 执行失败; providerToolResult=${JSON.stringify(
      result.content,
    )}; isError=true`,
  );
}

function assertToolResultContains(
  toolCallId: string,
  output: string,
  expectedOutputIncludes: readonly string[],
): void {
  const missing = expectedOutputIncludes.filter((value) => !output.includes(value));
  if (missing.length > 0) {
    throw new Error(
      `toolCallId=${toolCallId} 已返回 tool_result，但结果缺少 ${JSON.stringify(
        missing,
      )}; output=${output}`,
    );
  }
}

async function safeGetToolCallDiagnostics(
  matcher: ToolCallMatcher,
  fallback: ToolCallDiagnostics | null,
): Promise<ToolCallDiagnostics | null> {
  try {
    return await getToolCallDiagnostics(matcher);
  } catch {
    return fallback;
  }
}

function clickAssistantHistoryForAssistantContaining(
  text: string,
): Promise<AssistantHistoryOpenSnapshot> {
  return browser.execute(
    (assistantMessagePrefix, historyTriggerPrefix, historyContentPrefix, expectedText) => {
      const normalizeText = (value: string) => value.replace(/\u00a0/g, " ").trim();
      const assistantMessages = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${assistantMessagePrefix}-"]`),
      );
      const assistantMessage = assistantMessages.find((message) =>
        normalizeText(message.innerText).includes(expectedText),
      );
      if (!assistantMessage) {
        return {
          assistantText: assistantMessages
            .map((message) => normalizeText(message.innerText))
            .join("\n---\n"),
          contentExists: false,
          contentOpen: null,
          expanded: false,
          reason: "assistant-not-found",
          triggerTestId: null,
        };
      }

      const trigger = assistantMessage.querySelector<HTMLElement>(
        `[data-testid^="${historyTriggerPrefix}-"]`,
      );
      if (!trigger) {
        return {
          assistantText: normalizeText(assistantMessage.innerText),
          contentExists: false,
          contentOpen: null,
          expanded: false,
          reason: "history-trigger-not-found",
          triggerTestId: null,
        };
      }

      const stateKey = trigger.getAttribute("data-history-state-key");
      const content =
        stateKey !== null
          ? document.querySelector<HTMLElement>(
              `[data-testid^="${historyContentPrefix}-"][data-history-state-key="${stateKey}"]`,
            )
          : null;
      const expanded =
        trigger.getAttribute("aria-expanded") === "true" ||
        trigger.getAttribute("data-history-open") === "true";
      if (!expanded) {
        trigger.click();
      }

      return {
        assistantText: normalizeText(assistantMessage.innerText),
        contentExists: Boolean(content),
        contentOpen: content?.getAttribute("data-history-open") ?? null,
        expanded,
        reason: expanded ? null : "clicked-history-trigger",
        triggerTestId: trigger.getAttribute("data-testid"),
      };
    },
    TID_CHAT_ASSISTANT_MESSAGE,
    TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
    TID_CHAT_ASSISTANT_HISTORY_CONTENT,
    text,
  );
}

async function safeClickAssistantHistoryForAssistantContaining(
  text: string,
  fallback: AssistantHistoryOpenSnapshot | null,
): Promise<AssistantHistoryOpenSnapshot | null> {
  try {
    return await clickAssistantHistoryForAssistantContaining(text);
  } catch {
    return fallback;
  }
}
