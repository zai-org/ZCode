import { z } from "zod";
import { workspaceRefSchema } from "#src/extension-host/slots.js";

// 生成速率（docs/plugins/extension-host.md §10）。唯一聚合点是 Window Host：
// 流式阶段按 stream.chunk 字符数估算，请求结束后按服务商 usage 给准确值。只统计主轮请求。

/** 流式估算每个请求最多每 500ms 推一次。 */
export const GENERATION_STREAMING_PUSH_INTERVAL_MS = 500;

export const generationMetricsSchema = z.strictObject({
  sessionId: z.string().min(1),
  workspace: workspaceRefSchema,
  requestId: z.string().min(1),
  model: z.strictObject({ providerId: z.string(), modelId: z.string() }),
  phase: z.enum(["streaming", "final"]),
  outputTokensPerSecond: z.number().nonnegative(),
  /** final 时为服务商报告值。 */
  outputTokens: z.number().nonnegative().optional(),
  /** final 时提供。 */
  timeToFirstTokenMs: z.number().nonnegative().optional(),
});
export type GenerationMetrics = z.infer<typeof generationMetricsSchema>;
