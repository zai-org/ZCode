import type { ContextUsageCategory, ContextUsageMetric } from "../types.js";

type ContextUsageContributorKind = "context_section" | "tool_schema" | "skill" | "message_role";

/**
 * context_usage_snapshot 调试日志里每个粗类别的贡献者。
 * 贡献者由 context-composition 分类的细类别条目生成（methods/context-usage.ts），只进 debug 日志。
 */
export interface ContextUsageContributor extends ContextUsageMetric {
  cacheHint?: string;
  categorySource: ContextUsageCategory["source"];
  count?: number;
  injectionTarget?: string;
  kind: ContextUsageContributorKind;
  label: string;
  name?: string;
  path?: string;
  readOnly?: boolean;
  role?: string;
  scope?: string;
  serverName?: string;
  sideEffectScope?: string;
  source?: string;
}
