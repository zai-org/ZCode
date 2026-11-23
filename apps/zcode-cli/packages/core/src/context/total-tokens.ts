/**
 * token 预算提醒默认关闭：system 不带预算行，输入收集也不追加倒数提醒。
 * 每个 runtime 创建时读一次 `AgentRuntimeConfig.totalTokensReminder.enabled`（CLI 参数或 App 设置），
 * 运行中不变；存档里已有的提醒照常回放。
 */

/** 模型可见的 token 预算；固定值，只有开关可配置。 */
export const TOTAL_TOKENS_BUDGET = 15_000_000;

export function formatTotalTokensReminder(remaining: number): string {
  return `<total_tokens>${remaining} tokens left</total_tokens>`;
}

/** system 末尾的固定行；每次请求的倒数由 total_tokens_reminder 附件表达。 */
export const TOTAL_TOKENS_SYSTEM_LINE = formatTotalTokensReminder(TOTAL_TOKENS_BUDGET);
