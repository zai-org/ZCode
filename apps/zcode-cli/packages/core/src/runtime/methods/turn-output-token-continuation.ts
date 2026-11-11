import type { RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { toTokenUsageInfo } from "../helpers/index.js";
import {
  buildAssistantEntries,
  countContextPrefixMessages,
  createRuntimeAssistantEntry,
  createRuntimeUserEntry,
  hasAssistantReasoningContent,
  withSignedReasoningReset,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import {
  createProviderToolRoundEntries,
  hasProviderToolRoundContent,
  orderedAssistantHistoryBlocks,
  providerToolRoundsCompactGroupKey,
  withCompactGroupKey,
} from "../provider-tool-rounds/contract.js";
import type { RegularTurnLoopState, TurnRequestState } from "./turn-loop-state.js";

export const OUTPUT_TOKEN_CONTINUE_PROMPT =
  "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";

export const OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE =
  "The model's response exceeded the output token maximum.";

const MAX_OUTPUT_TOKEN_CONTINUATIONS = 3;
const OUTPUT_LIMIT_RAW_REASONS = new Set([
  "max_tokens",
  "max_output_tokens",
  "model_context_window_exceeded",
]);

type OutputTokenContinuationDecision = "continue" | "exhausted" | "none";

export function classifyOutputTokenContinuation(input: {
  finishReason: string | undefined;
  rawFinishReason: string | undefined;
  toolCallCount: number;
  continuationCount: number;
}): OutputTokenContinuationDecision {
  if (input.toolCallCount > 0) return "none";
  if (!isOutputTokenLimitFinishReason(input.finishReason, input.rawFinishReason)) {
    return "none";
  }
  return input.continuationCount < MAX_OUTPUT_TOKEN_CONTINUATIONS ? "continue" : "exhausted";
}

export function isOutputTokenLimitFinishReason(
  finishReason: string | undefined,
  rawFinishReason: string | undefined,
): boolean {
  // 有意设计（非 Bug）：成功响应的 model_context_window_exceeded 属于 Continue。

  // 即使 content 全空也共享最多 3 次恢复;
  // Anthropic 允许 input 未超窗但 input + max_tokens 超窗；生成填满窗口会截断成功响应，
  // 这不等同于 input 本身超窗导致的请求失败，不能仅按名称转成异常并抢先 Reactive Compact。
  // 行为差异：之前见该成功 stop reason 就尝试 Reactive Compact；现在先保存 partial、
  // 追加 Continue，再回到 outer loop 检查 Micro/Auto Compact，需要时压缩后发起续写。
  // 续写若抛出真实超窗异常，Reactive Compact 成功后重试当前续写，无法恢复则报错；
  // 压缩既不额外追加 Continue，也不重置已用次数，三次限制不包含压缩请求和异常重试。
  // 第四次仍为成功截断时按输出上限报错，不再额外尝试一次 Reactive Compact。
  // 因此，若服务端持续返回该标记而本地自动压缩未触发，可能多次无效续写后耗尽；
  // 此取舍保留了先续写、按需压缩的原约定，不保证下一次续写一定成功。
  return finishReason === "length" || OUTPUT_LIMIT_RAW_REASONS.has(rawFinishReason ?? "");
}

function createOutputTokenContinuationEntry(): RuntimeMessageEntry {
  return {
    ...createRuntimeUserEntry(OUTPUT_TOKEN_CONTINUE_PROMPT),
    queryScope: "output_token_continuation",
  };
}

function isOutputTokenContinuationEntry(entry: RuntimeMessageEntry): boolean {
  return entry.kind !== "attachment" && entry.queryScope === "output_token_continuation";
}

export function filterOutputTokenContinuationEntries(
  entries: readonly RuntimeMessageEntry[],
): readonly RuntimeMessageEntry[] {
  const firstContinuation = entries.findIndex(isOutputTokenContinuationEntry);
  if (firstContinuation < 0) return entries;
  return entries.filter((entry) => !isOutputTokenContinuationEntry(entry));
}

export function preserveCanonicalContextPrefix(
  currentCanonicalEntries: readonly RuntimeMessageEntry[],
  turnLocalEntries: readonly RuntimeMessageEntry[],
): readonly RuntimeMessageEntry[] {
  // 配置刷新会立即替换 canonical prefix，而恢复链继续持有原子 Turn 的旧
  // prefix。turn-local Compact 若整体回写会撤销刷新，因此只提交转换后的 conversation tail。
  return [
    ...currentCanonicalEntries.slice(0, countContextPrefixMessages(currentCanonicalEntries)),
    ...turnLocalEntries.slice(countContextPrefixMessages(turnLocalEntries)),
  ];
}

export function appendTurnRequestEntries(
  state: TurnRequestState,
  entries: readonly RuntimeMessageEntry[],
): void {
  if (entries.length === 0) return;
  state.entries = [...state.entries, ...entries];
}

export function commitTurnRequestEntries(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  entries: readonly RuntimeMessageEntry[],
): void {
  if (entries.length === 0) return;
  runtime.messageHistory.addEntries(entries);
  appendTurnRequestEntries(state, entries);
}

export function commitAssistantToTurnRequest(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  result: RuntimeModelTextResult,
  toolCalls: Parameters<typeof createRuntimeAssistantEntry>[1],
): boolean {
  // provider result metadata 可能报告别的模型；assistant 归因必须使用
  // Turn 已绑定的 Model，避免恢复链重新引入旧的 provider-owned 模型身份。
  const modelRef = { providerId: state.model.providerId, modelId: state.model.modelId };
  const orderedBlocks = orderedAssistantHistoryBlocks(result, toolCalls);
  if (orderedBlocks) {
    // 有序结果与冷恢复共用 buildAssistantEntries，live 与冷恢复的条目相同。
    const entries = buildAssistantEntries({
      blocks: orderedBlocks,
      model: modelRef,
      tokens: toTokenUsageInfo(result.usage),
      groupKey: providerToolRoundsCompactGroupKey(result.providerToolRounds),
    });
    // 签名修复后成功的请求同样在第一条 assistant 上记标记；冷恢复的有序分支按消息 metadata
    // 对 buildAssistantEntries 的结果做同样处理，两边条目一致。
    commitTurnRequestEntries(runtime, state.turnRequestState, markRepairedStep(entries, result));
    return entries.length > 0;
  }
  const reasoning = result.reasoning?.filter(hasAssistantReasoningContent);
  const hasFinalRoundContent =
    state.modelResponse.length > 0 || (reasoning?.length ?? 0) > 0 || (toolCalls?.length ?? 0) > 0;
  const hasProviderRounds = hasProviderToolRoundContent(result.providerToolRounds);
  if (!hasFinalRoundContent && !hasProviderRounds) return false;
  // 服务端内置工具切出的前序轮次排在最后一轮之前，每轮自带调用与结果。
  const providerRoundEntries = createProviderToolRoundEntries(
    result.providerToolRounds,
    modelRef,
    hasAssistantReasoningContent,
  );
  // 前序轮次与最后一轮同属一条持久化 assistant，compact 必须把它们算作一组。
  const compactGroupKey = providerToolRoundsCompactGroupKey(result.providerToolRounds);
  // 有服务端内置工具轮次时，provider usage 是服务端内部多轮请求的合计（约为单次上下文的轮数倍），
  // 不能当作上下文估算锚点；不挂 tokens，估算回落到上一个真实锚点加本地增量。冷恢复同样不挂。
  const contextUsage = compactGroupKey ? undefined : toTokenUsageInfo(result.usage);
  const stepEntries = hasFinalRoundContent
    ? [
        ...providerRoundEntries,
        createRuntimeAssistantEntry(
          state.modelResponse,
          toolCalls,
          reasoning,
          modelRef,
          contextUsage,
        ),
      ]
    : providerRoundEntries;
  commitTurnRequestEntries(
    runtime,
    state.turnRequestState,
    withCompactGroupKey(markRepairedStep(stepEntries, result), compactGroupKey),
  );
  return true;
}

/** 签名修复后成功的请求：在这一步产出的第一条 assistant 上记标记（见 withSignedReasoningReset）。 */
export function markRepairedStep(
  entries: readonly RuntimeMessageEntry[],
  result: Pick<RuntimeModelTextResult, "signedReasoningReset">,
): RuntimeMessageEntry[] {
  return result.signedReasoningReset ? withSignedReasoningReset(entries) : [...entries];
}

export { hasAssistantReasoningContent };

export function appendOutputTokenContinuation(state: TurnRequestState): void {
  appendTurnRequestEntries(state, [createOutputTokenContinuationEntry()]);
  state.outputTokenContinuationCount += 1;
}

export function completeOutputTokenRecovery(state: TurnRequestState): void {
  state.outputTokenContinuationCount = 0;
}

export function finishOutputTokenRecovery(state: TurnRequestState): void {
  completeOutputTokenRecovery(state);
}
