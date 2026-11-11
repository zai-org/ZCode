import { z } from "zod";
import {
  actionSchema,
  identifierSchema,
  messageSchema,
  sessionRefSchema,
  type SessionRef,
} from "#session-control/contract/common";
import { operationRefSchema } from "#session-control/contract/observation";

export const sessionSummarySchema = z.strictObject({
  session: sessionRefSchema,
  title: z.string(),
  status: z.enum(["unknown", "idle", "running", "needs_attention"]),
  availableActions: z.array(actionSchema),
  updatedAt: z.string().optional(),
  executionId: identifierSchema.optional(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
});
export type SessionSummary<R extends SessionRef = SessionRef> = Omit<
  z.infer<typeof sessionSummarySchema>,
  "session"
> & { session: R };
export const listSessionsResultSchema = z.strictObject({
  sessions: z.array(sessionSummarySchema),
  nextCursor: identifierSchema.optional(),
});
export type ListSessionsResult<R extends SessionRef = SessionRef> = {
  sessions: SessionSummary<R>[];
  nextCursor?: string;
};
export const readSessionResultSchema = z.discriminatedUnion("view", [
  z.strictObject({ view: z.literal("summary"), summary: sessionSummarySchema }),
  z.strictObject({
    view: z.literal("messages"),
    session: sessionRefSchema,
    messages: z.array(messageSchema),
    nextCursor: identifierSchema.optional(),
  }),
]);
export type ReadSessionResult<R extends SessionRef = SessionRef> =
  | { view: "summary"; summary: SessionSummary<R> }
  | {
      view: "messages";
      session: R;
      messages: z.infer<typeof messageSchema>[];
      nextCursor?: string;
    };
export const admissionSchema = z.enum(["accepted", "rejected", "unknown"]);
export const deliverySchema = z.enum(["start_now", "queued", "none", "unknown"]);
export const sendToSessionResultSchema = z
  .strictObject({
    // 规格 0.14：重试身份由回执给出，模型不发明 id。
    requestId: identifierSchema.describe(
      "This request's identity. Pass it as `retryOf` only if you must retry this exact request.",
    ),
    session: sessionRefSchema,
    operation: operationRefSchema,
    admission: admissionSchema,
    delivery: deliverySchema,
    reason: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (!validDelivery(value.admission, value.delivery))
      ctx.addIssue({ code: "custom", message: "Admission and delivery disagree" });
  });
function validDelivery(
  admission: z.infer<typeof admissionSchema>,
  delivery: z.infer<typeof deliverySchema>,
): boolean {
  if (admission === "accepted")
    return delivery === "start_now" || delivery === "queued" || delivery === "unknown";
  if (admission === "rejected") return delivery === "none";
  return delivery === "unknown";
}
export type SendToSessionResult<R extends SessionRef = SessionRef> = Omit<
  z.infer<typeof sendToSessionResultSchema>,
  "session" | "operation"
> & { session: R; operation: { session: R; sessionId: string; commandId: string } };
export const createSessionResultSchema = z
  .strictObject({
    // 规格 0.14：重试身份由回执给出，模型不发明 id。
    requestId: identifierSchema.describe(
      "This request's identity. Pass it as `retryOf` only if you must retry this exact request.",
    ),
    creation: z.enum(["created", "rejected", "unknown"]),
    firstInput: admissionSchema,
    delivery: deliverySchema,
    session: sessionRefSchema.optional(),
    operation: operationRefSchema.optional(),
    reason: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (!validDelivery(value.firstInput, value.delivery))
      ctx.addIssue({ code: "custom", message: "First-input admission and delivery disagree" });
    if (value.creation === "created" && !value.session)
      ctx.addIssue({ code: "custom", message: "Created session requires a session reference" });
    if (value.firstInput === "accepted" && (value.creation !== "created" || !value.operation))
      ctx.addIssue({
        code: "custom",
        message: "Accepted input requires created session and operation",
      });
    if (value.operation && !value.session)
      ctx.addIssue({ code: "custom", message: "Operation requires session" });
  });
// operation 与 schema（operationRefSchema）一致带 sessionId：facade 按 schema 解析输出，类型曾少写这一项，
// 扩展的能力表按 schema 推导返回类型时对不上（P3c）。
export type CreateSessionResult<R extends SessionRef = SessionRef> = Omit<
  z.infer<typeof createSessionResultSchema>,
  "session" | "operation"
> & { session?: R; operation?: { session: R; sessionId: string; commandId: string } };
export const forkSessionResultSchema = z
  .strictObject({
    status: z.enum(["created", "rejected", "unknown"]),
    session: sessionRefSchema.optional(),
    // 规格 0.14：重试身份由回执给出；fork 没有 operation，所以直接挂在结果上。
    requestId: identifierSchema.describe(
      "This request's identity. Pass it as `retryOf` only if you must retry this exact request.",
    ),
    reason: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "created" && !value.session)
      ctx.addIssue({ code: "custom", message: "Created fork requires session" });
  });
export type ForkSessionResult<R extends SessionRef = SessionRef> = Omit<
  z.infer<typeof forkSessionResultSchema>,
  "session"
> & { session?: R };
