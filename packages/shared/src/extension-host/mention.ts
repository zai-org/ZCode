import { z } from "zod";
import {
  ZCODE_PLUGIN_MENTION_LIMITS,
  zcodePluginMentionItemsSchema,
} from "#src/zcode-protocol/plugin-host-queries/contract.js";
import { resolvedScopeSchema } from "#src/extension-host/slots.js";

// composer.mention 的候选项查询（docs/plugins/extension-host.md §16.6）：Renderer → Window Host。
// command 条目由扩展命令提供候选项，tool 条目由 CLI 在会话里调插件工具（plugins/mentionItems）。
// 不设计取消：Renderer 每次查询带递增的 seq，结果原样带回，只采用最新一次。

/** composer.mention 命令收到的参数（CommandCall.args）。 */
export interface MentionCommandArgs {
  query: string;
}

export const provideMentionItemsInputSchema = z.strictObject({
  /** 条目全局 id `<pluginId>/<itemId>`：必须是静态表里 composer.mention 的可用条目。 */
  entry: z.string().min(1),
  /** `@` 后的输入，可以是空串。 */
  query: z.string().max(ZCODE_PLUGIN_MENTION_LIMITS.queryMaxChars),
  /** 当前会话（草稿为预热会话）；没有会话时为工作区。tool 条目要求会话。 */
  scope: resolvedScopeSchema,
  seq: z.number().int().nonnegative(),
});
export type ProvideMentionItemsInput = z.infer<typeof provideMentionItemsInputSchema>;

/**
 * Window Host 产生的错误码。tool 条目另有 CLI 的稳定码（`plugin_mention_*`，见
 * ZCODE_PLUGIN_MENTION_ERROR_CODES），原样带回。Renderer 只按码分支，不读错误文本。
 */
export const MENTION_ITEMS_ERROR_CODES = {
  /** 条目不在静态表里，或不是 composer.mention 的条目（清单刚变）。 */
  notDeclared: "not-declared",
  /** 扩展进程没有连上（重启中或已停止）。 */
  hostUnavailable: "host-unavailable",
  /** 扩展命令抛错。原因在扩展日志里。 */
  commandFailed: "command-failed",
  /** 命令返回值不合插槽的 schema。 */
  invalidResult: "invalid-result",
  /** tool 条目要求会话作用域。 */
  noSession: "no-session",
  /** 会话不在 CLI 内存里，或没有运行中的 CLI。 */
  sessionUnavailable: "session-unavailable",
  /** 其他内部错误，原因进日志。 */
  internal: "internal",
} as const;

const seqSchema = z.number().int().nonnegative();

/**
 * 查询结果。错误不抛给 Renderer：@zcode/rpc 跨进程只带错误文本，Renderer 要按码分支。
 * - ok：候选项（最多 50 项，已按 schema 校验）。
 * - unsupported：旧 CLI 没有 plugins/mentionItems，这一组不显示。
 * - error：组内显示一行小字，不影响别的组。
 */
export const mentionItemsResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ seq: seqSchema, status: z.literal("ok"), items: zcodePluginMentionItemsSchema }),
  z.strictObject({ seq: seqSchema, status: z.literal("unsupported") }),
  z.strictObject({ seq: seqSchema, status: z.literal("error"), code: z.string().min(1) }),
]);
export type MentionItemsResult = z.infer<typeof mentionItemsResultSchema>;
