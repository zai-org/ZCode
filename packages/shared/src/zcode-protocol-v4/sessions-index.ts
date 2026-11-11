// sessions-index topic：列表活性数据源；conflated 最新态，永不溢出。
import { z } from "zod";
import { timestampSchema } from "./core.js";
import { sessionWorkflowActivitySchema } from "./sessions-index-workflow-activity.js";
import {
  goalStateSchema,
  interactionAutoResolutionSchema,
  sessionMetaStateSchema,
  sessionPhaseSchema,
} from "./snapshot.js";

export const sessionPendingInteractionSummarySchema = z.object({
  interactionId: z.string(),
  kind: z.enum(["permission", "userInput"]),
  // 只下发轻量工具身份，侧栏据此区分 AskUserQuestion 与其他阻塞确认；不携带问题或答案。
  toolName: z.string().optional(),
  autoResolution: interactionAutoResolutionSchema.optional(),
});
export type SessionPendingInteractionSummary = z.infer<
  typeof sessionPendingInteractionSummarySchema
>;

export const pendingInteractionSummarySchema = z.object({
  permissionCount: z.number().int().nonnegative(),
  userInputCount: z.number().int().nonnegative(),
});
export type PendingInteractionSummary = z.infer<typeof pendingInteractionSummarySchema>;

export const sessionSummarySchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  // fork 树。
  parentSessionId: z.string().optional(),
  title: z.string(),
  // custom = 用户显式重命名；default/generated 都不是产品语义上的手动标题。
  // optional 是为了兼容旧 sessions-index frame / 旧持久化摘要。
  titleSource: sessionMetaStateSchema.shape.titleSource.optional(),
  lastOutcome: z.enum(["completed", "error", "interrupted"]).optional(),
  phase: sessionPhaseSchema,
  sessionEnded: z.boolean(),
  // 列表小圆点用（此处保留布尔，避免为侧栏订阅整个 backgroundWorks）。
  hasBackgroundWork: z.boolean(),
  // 侧栏工作流运行行：有界的 run 摘要，
  // 只装画迷你轨道要的字段；会话没有任何 run 时缺席。optional 兼容旧 frame / 旧 CLI。
  workflowActivity: sessionWorkflowActivitySchema.optional(),
  pendingInteraction: sessionPendingInteractionSummarySchema.optional(),
  // 侧栏只需要 kind/count，不下发问题、命令或答案等敏感 payload。
  // optional 兼容旧 sessions-index frame / stored summary。
  pendingInteractionSummary: pendingInteractionSummarySchema.optional(),
  goalStatus: goalStateSchema.shape.status.optional(),
  // 未读推导：客户端本地记 lastSeenActivityAt 比较（不用 seq，epoch 会重置）。
  lastActivityAt: timestampSchema,
  // ≤120 字符。
  lastAssistantPreview: z.string().optional(),
  createdAt: timestampSchema,
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionsIndexSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  workspaceId: z.string(),
  // host 级列表日志代际（与各 session 的 logEpoch 无关）。
  logEpoch: z.string(),
  // 无序；排序是客户端展示逻辑。
  sessions: z.array(sessionSummarySchema),
});
export type SessionsIndexSnapshot = z.infer<typeof sessionsIndexSnapshotSchema>;

export const sessionsIndexDeltaSchema = z.discriminatedUnion("op", [
  // conflation key = sessionId。
  z.object({ op: z.literal("session.upserted"), session: sessionSummarySchema }),
  z.object({ op: z.literal("session.removed"), sessionId: z.string() }),
]);
export type SessionsIndexDelta = z.infer<typeof sessionsIndexDeltaSchema>;

/** snapshot 缺席不是删除；按明确 ID 查询持久事实，不会创建或恢复运行实例。 */
export const sessionsIndexReconcileParamsSchema = z
  .object({
    workspaceId: z.string().min(1),
    sessionIds: z.array(z.string().min(1)).max(256),
  })
  .strict();
export type SessionsIndexReconcileParams = z.infer<typeof sessionsIndexReconcileParamsSchema>;
export const sessionsIndexReconcileResultSchema = z
  .object({
    sessions: z
      .array(
        z.discriminatedUnion("exists", [
          z
            .object({ sessionId: z.string(), exists: z.literal(false), deleted: z.literal(false) })
            .strict(),
          z
            .object({
              sessionId: z.string(),
              exists: z.literal(true),
              parentSessionId: z.string().optional(),
              deleted: z.boolean(),
              title: z.string(),
              titleSource: sessionMetaStateSchema.shape.titleSource,
              createdAt: timestampSchema,
              updatedAt: timestampSchema,
              lastOutcome: z.enum(["completed", "error", "interrupted"]).optional(),
            })
            .strict(),
        ]),
      )
      .max(256),
  })
  .strict();
export type SessionsIndexReconcileResult = z.infer<typeof sessionsIndexReconcileResultSchema>;

/** sessions-index topic key 构造（与 parseSessionsIndexTopic 对偶）。 */
export function sessionsIndexTopic(workspaceId: string): string {
  return `sessions-index/${workspaceId}`;
}

/** sessions-index topic key 解析（"sessions-index/<workspaceId>"）。 */
export function parseSessionsIndexTopic(topic: string): string | null {
  if (!topic.startsWith("sessions-index/")) return null;
  const workspaceId = topic.slice("sessions-index/".length);
  return workspaceId.length > 0 ? workspaceId : null;
}
