// Context 组成的 v4 线格式（扩展进程 P1）。
// 规格：apps/zcode-cli/docs/design/v2/model/context-composition.md。
//
// 本文件是线格式的唯一定义：CLI 产出前校验，App 收到后校验，用的是同一组 schema。
// 本包纪律：只放 schema 与纯函数，不做 IO。
import { z } from "zod";
import { modelSelectionSchema } from "../../model-selection.js";
import { zcodeContextUsageBreakdownSourceSchema } from "../../zcode-protocol-legacy-types.js";

/** 细类别；顺序即展示顺序。 */
export const CONTEXT_COMPOSITION_CATEGORY_IDS = [
  "system_prompt",
  "meta_user_context",
  "skills",
  "tool_prompt",
  "system_tool_schemas",
  "mcp_tool_schemas",
  "app_tool_schemas",
  "deferred_tool_schemas",
  "reminders",
  "compact_summary",
  "messages",
] as const;
export type ContextCompositionCategoryId = (typeof CONTEXT_COMPOSITION_CATEGORY_IDS)[number];

/** 每个类别最多返回的条目数。 */
export const CONTEXT_COMPOSITION_MAX_ITEMS = 50;
/** 条目名最长字符数，超出截断。 */
export const CONTEXT_COMPOSITION_MAX_ITEM_NAME_CHARS = 200;

/**
 * 圆环线格式的 7 个粗类别。与 `zcodeContextUsageBreakdownSourceSchema` 是同一个枚举：
 * 远程工作区的 CLI 可以比 App 新，往严格枚举加值会让旧的一方解析失败，所以这里只引用、不扩展。
 */
export type ContextCompositionUsageSource = z.infer<typeof zcodeContextUsageBreakdownSourceSchema>;

/** 延迟加载工具投影到圆环时，按工具本身的来源归类。 */
export type ContextCompositionToolOrigin = "system" | "mcp";

const USAGE_SOURCE_BY_CATEGORY: Record<
  Exclude<ContextCompositionCategoryId, "deferred_tool_schemas">,
  ContextCompositionUsageSource
> = {
  system_prompt: "system_prompt",
  meta_user_context: "meta_user_context",
  skills: "skills",
  tool_prompt: "tool_prompt",
  system_tool_schemas: "system_tool_schemas",
  mcp_tool_schemas: "mcp_tool_schemas",
  // 页面工具在改前被算作内置工具；圆环保持原来的归类。
  app_tool_schemas: "system_tool_schemas",
  // 提醒在圆环里属于「其他」。
  reminders: "meta_user_context",
  compact_summary: "messages",
  messages: "messages",
};

/** 细类别 → 圆环粗类别的唯一映射（纯函数）。 */
export function contextCompositionUsageSource(
  id: ContextCompositionCategoryId,
  toolOrigin: ContextCompositionToolOrigin = "system",
): ContextCompositionUsageSource {
  if (id === "deferred_tool_schemas") {
    return toolOrigin === "mcp" ? "mcp_tool_schemas" : "system_tool_schemas";
  }
  return USAGE_SOURCE_BY_CATEGORY[id];
}

const countSchema = z.number().int().nonnegative();

export const contextCompositionCategoryIdSchema = z.enum(CONTEXT_COMPOSITION_CATEGORY_IDS);

export const contextCompositionItemSchema = z
  .object({
    name: z.string().min(1).max(CONTEXT_COMPOSITION_MAX_ITEM_NAME_CHARS),
    tokens: countSchema,
  })
  .strict();
export type ContextCompositionItem = z.infer<typeof contextCompositionItemSchema>;

export const contextCompositionCategorySchema = z
  .object({
    id: contextCompositionCategoryIdSchema,
    tokens: countSchema,
    chars: countSchema,
    // 按 token 降序，最多 CONTEXT_COMPOSITION_MAX_ITEMS 条；只有名字和大小，不带正文。
    items: z.array(contextCompositionItemSchema).max(CONTEXT_COMPOSITION_MAX_ITEMS).optional(),
  })
  .strict();
export type ContextCompositionCategory = z.infer<typeof contextCompositionCategorySchema>;

export const contextCompositionPhaseSchema = z.enum(["request", "draft-preview"]);
export type ContextCompositionPhase = z.infer<typeof contextCompositionPhaseSchema>;

export const contextCompositionSchema = z
  .object({
    sessionId: z.string().min(1),
    // 每会话单调递增；owner 是 CLI 协议层的 tracker。
    revision: countSchema,
    phase: contextCompositionPhaseSchema,
    measuredAt: countSchema,
    model: z
      .object({
        providerId: z.string().min(1),
        modelId: z.string().min(1),
        contextWindow: z.number().int().positive().nullable(),
      })
      .strict(),
    tokenMethod: z.literal("estimated"),
    estimatedTokens: countSchema,
    // 只在 phase=request：该请求服务商报告的 input tokens，供对照估算值。
    providerInputTokens: countSchema.optional(),
    // 只在 phase=request：与输入框用量圆环（V4 状态 usage.contextWindow.usedTokens）同一函数、同一份 usage
    // 算出的值，即 input + 这次回复的 output。消费方要和圆环对齐时用它，不要自己相加。
    providerContextTokens: countSchema.optional(),
    // contextWindow 未知时为 null。
    freeTokens: countSchema.nullable(),
    categories: z
      .array(contextCompositionCategorySchema)
      .max(CONTEXT_COMPOSITION_CATEGORY_IDS.length),
  })
  .strict();
export type ContextComposition = z.infer<typeof contextCompositionSchema>;

/** `v4/conversation/contextComposition` 请求参数。 */
export const v4ConversationContextCompositionParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    // 完整模型选择（含思考档位）；省略时用会话当前模型。
    modelSelection: modelSelectionSchema.optional(),
  })
  .strict();
export type V4ConversationContextCompositionParams = z.infer<
  typeof v4ConversationContextCompositionParamsSchema
>;

/** `v4/conversation/contextComposition` 结果：会话不在内存或没有可用模型时为 null。 */
export const v4ConversationContextCompositionResultSchema = z
  .object({ composition: contextCompositionSchema.nullable() })
  .strict();
export type V4ConversationContextCompositionResult = z.infer<
  typeof v4ConversationContextCompositionResultSchema
>;

/** `v4/conversation/contextCompositionChanged` 通知参数：只带修订号，消费方按需拉取。 */
export const v4ConversationContextCompositionChangedSchema = z
  .object({
    sessionId: z.string().min(1),
    revision: countSchema,
  })
  .strict();
export type ContextCompositionChangedEvent = z.infer<
  typeof v4ConversationContextCompositionChangedSchema
>;

/** 条目名截断到线格式上限。 */
export function truncateContextCompositionItemName(name: string): string {
  return name.length > CONTEXT_COMPOSITION_MAX_ITEM_NAME_CHARS
    ? name.slice(0, CONTEXT_COMPOSITION_MAX_ITEM_NAME_CHARS)
    : name;
}
