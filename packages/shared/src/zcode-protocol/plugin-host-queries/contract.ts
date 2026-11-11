// 扩展进程 P2 的 App → CLI 插件只读查询。规格：
// apps/zcode-cli/docs/design/v2/plugin-compat.md「App 读取扩展设置」「Composer Mention Items」。
// App（services）与 CLI（bootstrap）共用这里的严格 schema；index.ts 统一导出。
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
const pluginOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * 查询失败时 `ProtocolRequestError.data` 的形状。App 只按 `code` 分支，不读错误文本；
 * 错误里不带选项值。
 */
export const zcodePluginQueryErrorDataSchema = z.object({ code: nonEmptyString }).strict();
export type ZCodePluginQueryErrorData = z.infer<typeof zcodePluginQueryErrorDataSchema>;

// ── plugins/readUserOptions ──
// 本插件 user 层的有效值（清单默认值 ⊕ user 层选项，含敏感值）。只给 App 的扩展 settings 能力用。
export const ZCODE_PLUGIN_READ_USER_OPTIONS_ERROR_CODES = {
  /** 插件不在 user 视图的发现结果里（JSON-RPC -32602）。 */
  pluginNotFound: "plugin_not_found",
} as const;

export const zcodePluginsReadUserOptionsParamsSchema = z
  .object({ pluginId: nonEmptyString })
  .strict();
export type ZCodePluginsReadUserOptionsParams = z.infer<
  typeof zcodePluginsReadUserOptionsParamsSchema
>;
export const zcodePluginsReadUserOptionsResultSchema = z
  .object({ values: z.record(z.string(), pluginOptionValueSchema) })
  .strict();
export type ZCodePluginsReadUserOptionsResult = z.infer<
  typeof zcodePluginsReadUserOptionsResultSchema
>;

// ── plugins/mentionItems ──
// 输入框 `@` 面板里 `tool` target 的候选项：CLI 在会话现有的 MCP 连接上调插件工具，
// 按下面的严格 schema 校验 `structuredContent.items`。不设计取消，App 只采用最新 seq 的结果。
export const ZCODE_PLUGIN_MENTION_LIMITS = {
  maxItems: 50,
  idMaxChars: 200,
  labelMaxChars: 120,
  descriptionMaxChars: 500,
  iconMaxChars: 100,
  insertTextMaxChars: 4000,
  queryMaxChars: 1000,
  toolNameMaxChars: 200,
} as const;

/**
 * 稳定错误码。引用类（插件、工具找不到或不可调）用 JSON-RPC -32602；
 * 执行类（授权被拒、工具报错、结果不合 schema）用 -32000。会话不在内存用 -32004（sessionUnavailable）。
 */
export const ZCODE_PLUGIN_MENTION_ERROR_CODES = {
  pluginUnavailable: "plugin_mention_plugin_unavailable",
  toolNotFound: "plugin_mention_tool_not_found",
  toolNotAppVisible: "plugin_mention_tool_not_app_visible",
  /** 会话的 MCP App 授权链拒绝了这次调用（deny 规则、用户拒绝、hook 拒绝）。 */
  toolDenied: "plugin_mention_tool_denied",
  toolFailed: "plugin_mention_tool_failed",
  resultInvalid: "plugin_mention_result_invalid",
} as const;
export type ZCodePluginMentionErrorCode =
  (typeof ZCODE_PLUGIN_MENTION_ERROR_CODES)[keyof typeof ZCODE_PLUGIN_MENTION_ERROR_CODES];

export const zcodePluginMentionItemSchema = z
  .object({
    id: z.string().min(1).max(ZCODE_PLUGIN_MENTION_LIMITS.idMaxChars),
    label: z.string().min(1).max(ZCODE_PLUGIN_MENTION_LIMITS.labelMaxChars),
    description: z.string().max(ZCODE_PLUGIN_MENTION_LIMITS.descriptionMaxChars).optional(),
    icon: z.string().min(1).max(ZCODE_PLUGIN_MENTION_LIMITS.iconMaxChars).optional(),
    // 选中后按原文插入提及块并随消息发给模型（extension-host.md §16.6）。
    insertText: z.string().min(1).max(ZCODE_PLUGIN_MENTION_LIMITS.insertTextMaxChars),
  })
  .strict();
export type ZCodePluginMentionItem = z.infer<typeof zcodePluginMentionItemSchema>;
export const zcodePluginMentionItemsSchema = z
  .array(zcodePluginMentionItemSchema)
  .max(ZCODE_PLUGIN_MENTION_LIMITS.maxItems);

export const zcodePluginsMentionItemsParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    pluginId: nonEmptyString,
    /** 插件 MCP server 上的原始工具名，不是模型可见的 `mcp__…` 名。 */
    tool: nonEmptyString.max(ZCODE_PLUGIN_MENTION_LIMITS.toolNameMaxChars),
    /** `@` 后的输入，可以是空串。 */
    query: z.string().max(ZCODE_PLUGIN_MENTION_LIMITS.queryMaxChars),
  })
  .strict();
export type ZCodePluginsMentionItemsParams = z.infer<typeof zcodePluginsMentionItemsParamsSchema>;
export const zcodePluginsMentionItemsResultSchema = z
  .object({ items: zcodePluginMentionItemsSchema })
  .strict();
export type ZCodePluginsMentionItemsResult = z.infer<typeof zcodePluginsMentionItemsResultSchema>;
