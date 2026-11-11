/** 模型可见的 token 预算；固定值，不提供模式或配置。 */
export const TOTAL_TOKENS_BUDGET = 15_000_000;

export function formatTotalTokensReminder(remaining: number): string {
  return `<total_tokens>${remaining} tokens left</total_tokens>`;
}

/** system 末尾的固定行；每次请求的倒数由 total_tokens_reminder 附件表达。 */
export const TOTAL_TOKENS_SYSTEM_LINE = formatTotalTokensReminder(TOTAL_TOKENS_BUDGET);
