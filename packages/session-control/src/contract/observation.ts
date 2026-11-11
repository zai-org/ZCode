import { z } from "zod";
import {
  appSessionRefSchema,
  cliSessionRefSchema,
  identifierSchema,
  sessionIdSchema,
  sessionRefSchema,
  type AccessGrant,
  type Scope,
  type SessionRef,
  type TrustedContext,
} from "#session-control/contract/common";

/**
 * 规格 0.14：回执里的 operation 必须能被原样放进 WaitSessions 的 operations[]。
 * 为此它同时携带 `sessionId`（模型用）与完整 `session`（跨层路由与展示用）。
 */
export const operationRefSchema = z.strictObject({
  session: sessionRefSchema,
  sessionId: sessionIdSchema.describe("The session this operation belongs to."),
  commandId: identifierSchema.describe(
    "Pass this operation straight back as one WaitSessions operation; do not rebuild it.",
  ),
});
export const cliOperationRefSchema = operationRefSchema.extend({ session: cliSessionRefSchema });
export const appOperationRefSchema = operationRefSchema.extend({ session: appSessionRefSchema });
export type OperationRef<R extends SessionRef = SessionRef> = {
  session: R;
  sessionId: string;
  commandId: string;
};
export type CliOperationRef = z.infer<typeof cliOperationRefSchema>;
export type AppOperationRef = z.infer<typeof appOperationRefSchema>;
export const operationStatusSchema = z.enum([
  "unknown",
  "idle",
  "accepted",
  "queued",
  "running",
  "completed",
  "interrupted",
  "failed",
  "needs_attention",
]);
export type OperationStatus = z.infer<typeof operationStatusSchema>;
export const operationSnapshotSchema = z.strictObject({
  operation: operationRefSchema,
  epoch: identifierSchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  status: operationStatusSchema,
  executionId: identifierSchema.optional(),
  reason: z.string().optional(),
  attention: z
    .strictObject({
      kind: z.enum(["approval", "question"]),
      message: z.string().optional(),
      url: z.string().url().optional(),
    })
    .optional(),
});
export type OperationSnapshot<R extends SessionRef = SessionRef> = Omit<
  z.infer<typeof operationSnapshotSchema>,
  "operation"
> & { operation: OperationRef<R> };
export const operationUpdateSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("snapshot"), snapshot: operationSnapshotSchema }),
  z.strictObject({
    type: z.literal("invalidated"),
    operation: operationRefSchema,
    reason: z.string(),
  }),
]);
export type OperationUpdate<R extends SessionRef = SessionRef> =
  | { type: "snapshot"; snapshot: OperationSnapshot<R> }
  | { type: "invalidated"; operation: OperationRef<R>; reason: string };

// initial 与 updates 必须来自同一水位；adapter 去重后只交付同 epoch 且严格递增 revision。
// 断连、换代或丢失事件必须显式 invalidated。close 必须幂等、及时释放，并使待取更新结束。
export interface OperationFeed<R extends SessionRef = SessionRef> {
  initial: OperationSnapshot<R>;
  updates: AsyncIterable<OperationUpdate<R>>;
  close(): Promise<void>;
}
export interface OperationObservationPort<R extends SessionRef, S extends Scope> {
  open(
    context: TrustedContext<R, S>,
    operation: OperationRef<R>,
    signal: AbortSignal,
    grant: AccessGrant<S>,
  ): Promise<OperationFeed<R>>;
}
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MAX_WAIT_TIMEOUT_MS = 300_000;
export const waitOptionsShape = {
  mode: z.enum(["any", "all"]),
  timeoutMs: z.number().int().min(0).max(MAX_WAIT_TIMEOUT_MS).default(DEFAULT_WAIT_TIMEOUT_MS),
};
/**
 * wait 的每个 operation：工具层只收 sessionId（规格 0.11）。
 *
 * 端口这边不能再用「二选一」：规格 0.14 之后回执里的 operation 同时带完整 `session`（跨层路由用）
 * 与裸 `sessionId`（模型用），而原样回放这个对象正是我们要支持的用法。改为「至少给一个，两个都
 * 给则必须指向同一会话」——既接受回放，也挡住自相矛盾的输入。
 */
function waitTarget<R extends z.ZodType>(ref: R) {
  return z
    .strictObject({
      session: ref.optional(),
      sessionId: sessionIdSchema.optional(),
      commandId: identifierSchema,
    })
    .refine((value) => value.session !== undefined || value.sessionId !== undefined, {
      message: "Provide session or sessionId",
    })
    .refine(
      (value) => {
        const session = value.session as { sessionId?: string } | undefined;
        return !session || !value.sessionId || session.sessionId === value.sessionId;
      },
      { message: "session and sessionId must point at the same session" },
    );
}
/**
 * 规格 0.14：刻意不用 strictObject——回执里的 operation 还带着一个完整 `session`（跨层路由用），
 * 这里把它剥掉即可，好让模型能把整个 operation 原样放回来。能被忽略的只有我们自己回执里的字段。
 */
const waitToolTarget = z.object({
  sessionId: sessionIdSchema.describe(
    "The id of the session that returned this operation, as given in its result.",
  ),
  commandId: identifierSchema.describe(
    "Replay the whole `operation` object from the create or send result; do not rebuild it.",
  ),
});
const waitToolInputSchema = z.strictObject({
  operations: z.array(waitToolTarget).min(1).max(100),
  ...waitOptionsShape,
});
export const cliWaitSessionsInputSchema = Object.assign(
  z.strictObject({
    operations: z.array(waitTarget(cliSessionRefSchema)).min(1).max(100),
    ...waitOptionsShape,
  }),
  { tool: waitToolInputSchema },
);
export const appWaitSessionsInputSchema = Object.assign(
  z.strictObject({
    operations: z.array(waitTarget(appSessionRefSchema)).min(1).max(100),
    ...waitOptionsShape,
  }),
  { tool: waitToolInputSchema },
);
export type CliWaitSessionsInput = z.input<typeof cliWaitSessionsInputSchema>;
export type AppWaitSessionsInput = z.input<typeof appWaitSessionsInputSchema>;
export const waitSessionsResultSchema = z.strictObject({
  status: z.enum(["completed", "timed_out", "cancelled", "unknown"]),
  operations: z.array(operationSnapshotSchema),
});
export type WaitSessionsResult<R extends SessionRef = SessionRef> = Omit<
  z.infer<typeof waitSessionsResultSchema>,
  "operations"
> & { operations: OperationSnapshot<R>[] };
