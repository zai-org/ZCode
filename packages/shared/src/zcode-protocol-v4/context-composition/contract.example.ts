/**
 * context-composition 标准调用示例：App 收到查询结果后校验，按细类别展示，或投影回圆环的 7 个粗类别。
 */
import {
  contextCompositionUsageSource,
  v4ConversationContextCompositionResultSchema,
  type ContextCompositionUsageSource,
} from "./contract.js";

export function exampleContextCompositionUsage(
  raw: unknown,
): Map<ContextCompositionUsageSource, number> | null {
  const { composition } = v4ConversationContextCompositionResultSchema.parse(raw);
  // null：会话不在内存或没有可用模型；调用方显示空态，不重试。
  if (!composition) return null;
  const tokensBySource = new Map<ContextCompositionUsageSource, number>();
  for (const category of composition.categories) {
    // 线格式不带工具来源；延迟加载工具在这里按默认来源归类，只用于示意投影规则。
    const source = contextCompositionUsageSource(category.id);
    tokensBySource.set(source, (tokensBySource.get(source) ?? 0) + category.tokens);
  }
  return tokensBySource;
}
