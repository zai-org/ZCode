// Provider 内置工具轮次（GLM 的 analyze_image / webReader 等）。
//
// 服务端执行内置工具后把多轮结果合成一次响应下发。这里按服务端工具把一次响应切成「轮」：
// 每轮是该工具之前的 reasoning/text 加这次调用与结果；最后一轮（客户端工具或最终回答）照旧。
// 回放时每轮写成 assistant(text, toolCalls=[服务端工具]) + tool(结果)，与服务端内部拼接的多轮一致，
// 不能再把多轮正文拼进一条 assistant（模型会照着服务端渲染的文字假装调用工具）。
import type {
  Model,
  ModelReasoningContentBlock,
  ModelTextContentBlock,
  ModelToolCall,
} from "@zcode/contracts";
import {
  createRuntimeAssistantEntry,
  createRuntimeToolResultEntry,
  hasOrderedAssistantHistoryBlocks,
  type AssistantHistoryBlock,
  type RuntimeMessageEntry,
  type ToolCallInput,
} from "../../agent/message-history.js";

export interface ProviderToolRound {
  /**
   * 这一轮落盘所在的持久化 assistant 消息 id。compact 分组键用它：工具调用 id 只保证在单次响应内
   * 配对，不保证会话内唯一（有的实现每次响应都从 call_1 编号），不能代替响应身份。
   */
  messageId: string;
  reasoning: ModelReasoningContentBlock[];
  text: string;
  /** 这一轮按到达顺序的文字块；`text` 是它们的直接拼接。 */
  textBlocks?: ModelTextContentBlock[];
  toolCall: ModelToolCall;
  /** 正常由 provider_tool_result 或中断收口填入；仍缺失时（收口失败）只回放正文，不留下没有结果的调用。 */
  result?: { output: string; isError: boolean };
}

/** SDK 下发的结果是 `[{type:"text", text}]` 数组；统一成模型和界面都能读的文本。 */
export function providerToolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((item) =>
        item &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string"
          ? (item as { text: string }).text
          : JSON.stringify(item),
      )
      .join("");
  }
  if (output instanceof Error) return output.message;
  return output === undefined ? "" : JSON.stringify(output);
}

export function createProviderToolRoundEntries(
  rounds: readonly ProviderToolRound[] | undefined,
  model?: Pick<Model, "providerId" | "modelId">,
  hasReasoningContent: (block: ModelReasoningContentBlock) => boolean = () => true,
): RuntimeMessageEntry[] {
  const entries: RuntimeMessageEntry[] = [];
  for (const round of rounds ?? []) {
    const reasoning = round.reasoning.filter(hasReasoningContent);
    const toolCalls = round.result
      ? [{ id: round.toolCall.id, name: round.toolCall.name, input: round.toolCall.input }]
      : undefined;
    if (round.text.length === 0 && reasoning.length === 0 && !toolCalls) continue;
    entries.push(
      createRuntimeAssistantEntry(
        round.text,
        toolCalls,
        reasoning.length > 0 ? reasoning : undefined,
        model,
      ),
    );
    if (round.result) {
      entries.push(
        createRuntimeToolResultEntry(
          round.toolCall.id,
          round.toolCall.name,
          round.result.output,
          round.result.isError,
        ),
      );
    }
  }
  return entries;
}

/**
 * 把一次模型输出（含服务端工具轮次）转成有序块。任何块缺少 blockIndex 时返回 undefined，
 * 调用方按旧逻辑处理（见 docs/design/v2/model/assistant-block-order.md）。
 */
export function orderedAssistantHistoryBlocks(
  output: {
    reasoning?: readonly ModelReasoningContentBlock[];
    textBlocks?: readonly ModelTextContentBlock[];
    providerToolRounds?: readonly ProviderToolRound[];
  },
  localToolCalls?: readonly ToolCallInput[],
): AssistantHistoryBlock[] | undefined {
  if (!output.textBlocks) return undefined;
  const blocks: AssistantHistoryBlock[] = [];
  for (const round of output.providerToolRounds ?? []) {
    if (!round.textBlocks) return undefined;
    blocks.push(...contentHistoryBlocks(round.reasoning, round.textBlocks), {
      kind: "provider_tool",
      call: round.toolCall,
      ...(round.result ? { result: round.result } : {}),
    });
  }
  blocks.push(
    ...contentHistoryBlocks(output.reasoning ?? [], output.textBlocks),
    ...(localToolCalls ?? []).map((call): AssistantHistoryBlock => ({ kind: "tool", call })),
  );
  return hasOrderedAssistantHistoryBlocks(blocks) ? blocks : undefined;
}

function contentHistoryBlocks(
  reasoning: readonly ModelReasoningContentBlock[],
  textBlocks: readonly ModelTextContentBlock[],
): AssistantHistoryBlock[] {
  return [...reasoning, ...textBlocks].map((block) => ({ kind: "content", block }));
}

export function hasProviderToolRoundContent(
  rounds: readonly ProviderToolRound[] | undefined,
): boolean {
  return (rounds ?? []).some(
    (round) => round.text.length > 0 || round.reasoning.length > 0 || round.result !== undefined,
  );
}

/**
 * 一次响应切出的轮次与最后一轮在数据库里是同一条 assistant 消息，但在 runtime 里是多条 assistant entry。
 * compact 按「assistant 开头的组」选保留区间，持久化边界按数据库消息算；给这些 entry 打同一个分组键，
 * 两边的组数才一致（否则冷恢复会带回已进入摘要的服务端工具结果）。键就是持久化消息 id，与冷恢复取值相同；
 * 相邻两次响应的键因此一定不同。没有轮次时返回 undefined，不改原行为。
 */
export function providerToolRoundsCompactGroupKey(
  rounds: readonly ProviderToolRound[] | undefined,
): string | undefined {
  return rounds?.[0]?.messageId;
}

/** 持久化 ToolPart 上的标记：provider 已在服务端执行，客户端不执行、冷恢复按轮回放。 */
export const PROVIDER_EXECUTED_TOOL_PART_METADATA_KEY = "providerExecuted";

export function isProviderExecutedToolPartMetadata(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return metadata?.[PROVIDER_EXECUTED_TOOL_PART_METADATA_KEY] === true;
}
