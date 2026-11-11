import { z } from "zod";
import { appSessionRefSchema, sessionSummarySchema } from "@zcode/session-control/contracts";
import { displayConversationRowSchema } from "#src/zcode-protocol-v4/rows.js";
import { sessionPhaseSchema } from "#src/zcode-protocol-v4/snapshot.js";

// 会话读连接的投影（docs/plugins/extension-host.md §17.3、§17.5、§17.6，P3b）：
// 列表行 v1、会话状态、完整行与 readRows。只加字段不升版；删字段或改含义才升版（§17.6）。

/** 每个插件同时订阅的不同会话数（会话状态与行合计，§17.5）。 */
export const MAX_SESSION_SUBSCRIPTIONS_PER_PLUGIN = 8;
/** 全局同时镜像的会话数（镜像在插件之间共享）。 */
export const MAX_SESSION_MIRRORS = 32;
/** 每个镜像窗口里各行 JSON 的字节预算；超出时从最旧的行丢起。 */
export const SESSION_MIRROR_MAX_BYTES = 8 * 1024 * 1024;
/** 单个事件的 JSON 字节上限；超出时改推 stale。 */
export const SESSION_EVENT_MAX_BYTES = 1024 * 1024;
/** readRows 每页最多的行数。 */
export const SESSION_READ_ROWS_MAX_LIMIT = 200;
/** 列表快照最多的行数；多出时带 truncated。 */
export const SESSION_LIST_MAX_ROWS = 1000;

const sessionIdSchema = z.string().min(1).max(200);

/**
 * 列表行 v1：从 session-control 的摘要派生，去掉只对模型有意义的 availableActions 与 executionId，
 * 加上来源在线状态。session 与写操作的会话引用同一格式，读出来就能直接传给写操作。
 */
export const sessionListRowSchema = sessionSummarySchema
  .omit({ session: true, availableActions: true, executionId: true })
  .extend({
    session: appSessionRefSchema,
    sourceAvailability: z.enum(["online", "offline"]),
  });
export type SessionListRow = z.infer<typeof sessionListRowSchema>;

export const sessionListEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("snapshot"),
    rev: z.number().int().nonnegative(),
    sessions: z.array(sessionListRowSchema),
    /** 超过 SESSION_LIST_MAX_ROWS 行时为 true，只给按 updatedAt 降序的前若干行。 */
    truncated: z.literal(true).optional(),
  }),
  z.strictObject({
    kind: z.literal("delta"),
    rev: z.number().int().nonnegative(),
    upserted: z.array(sessionListRowSchema),
    removed: z.array(appSessionRefSchema),
  }),
]);
export type SessionListEvent = z.infer<typeof sessionListEventSchema>;

export const sessionTargetInputSchema = z.strictObject({ sessionId: sessionIdSchema });
export type SessionTargetInput = z.infer<typeof sessionTargetInputSchema>;

/** 会话状态：只带修订号与阶段，正文按需经 readRows 或 onDidChangeRows 读。 */
export const sessionConversationEventSchema = z.strictObject({
  sessionId: sessionIdSchema,
  logEpoch: z.string(),
  revision: z.number(),
  phase: sessionPhaseSchema,
});
export type SessionConversationEvent = z.infer<typeof sessionConversationEventSchema>;

/** 完整行：v4 的 WireConversationRow 加读不懂时的占位行（protocols.rows）。 */
export const sessionRowSchema = displayConversationRowSchema;
export type SessionRow = z.infer<typeof sessionRowSchema>;

const rowsWatermark = { logEpoch: z.string(), revision: z.number() };

export const sessionRowsEventSchema = z.discriminatedUnion("kind", [
  /** 镜像的整个窗口（rowId 升序）。订阅后、重同步后、行被删除时推。 */
  z.strictObject({ kind: z.literal("reset"), ...rowsWatermark, rows: z.array(sessionRowSchema) }),
  /** 新增或变化的行（apply 之后的整行）。 */
  z.strictObject({
    kind: z.literal("rows"),
    ...rowsWatermark,
    upserted: z.array(sessionRowSchema),
  }),
  /** 事件超过 SESSION_EVENT_MAX_BYTES：插件改用 readRows 补读。 */
  z.strictObject({ kind: z.literal("stale"), ...rowsWatermark }),
]);
export type SessionRowsEvent = z.infer<typeof sessionRowsEventSchema>;

export const sessionReadRowsInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  /** 取 rowId < beforeRowId 的行；缺省从尾部往前。 */
  beforeRowId: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(SESSION_READ_ROWS_MAX_LIMIT),
});
export type SessionReadRowsInput = z.infer<typeof sessionReadRowsInputSchema>;

export const sessionReadRowsResultSchema = z.strictObject({
  logEpoch: z.string(),
  revision: z.number(),
  /** rowId 升序。 */
  rows: z.array(sessionRowSchema),
  hasMore: z.boolean(),
});
export type SessionReadRowsResult = z.infer<typeof sessionReadRowsResultSchema>;
