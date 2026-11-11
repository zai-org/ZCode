/**
 * Provider 内置工具轮次的公开入口（docs/design/v2/model/anthropic-stream-compat.md
 * 「Provider 内置工具多轮回放」）。
 * 流中切轮与卡片只由 runModelTextRequest 调用；回放 entries 由成功/取消提交路径生成；
 * 冷恢复用 isProviderExecutedToolPartMetadata 识别轮次边界。
 * 同一条持久化 assistant 拆出的 entry 用 withCompactGroupKey 打分组键，compact 才与持久化边界一致。
 */
export {
  createProviderToolRoundEntries,
  hasProviderToolRoundContent,
  isProviderExecutedToolPartMetadata,
  orderedAssistantHistoryBlocks,
  providerToolOutputText,
  providerToolRoundsCompactGroupKey,
} from "./rounds.js";
export { withCompactGroupKey } from "../../agent/message-history.js";
export type { ProviderToolRound } from "./rounds.js";
export {
  PROVIDER_TOOL_INTERRUPTED_RESULT,
  finishProviderToolCard,
  persistProviderToolRoundContent,
  settleUnfinishedProviderToolCards,
  startProviderToolCard,
} from "./cards.js";
