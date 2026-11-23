import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TOOL_SEARCH_NAME = "ToolSearch";
export const LOCAL_TOOL_SEARCH_NAME = "LocalToolSearch";
export const ToolSearchModeSchema = z.enum(["auto", "native", "local", "off"]);
export type ToolSearchMode = z.infer<typeof ToolSearchModeSchema>;
export type ResolvedToolSearchMode = Exclude<ToolSearchMode, "auto">;
export function toolSearchNameForMode(mode: ResolvedToolSearchMode): string {
  return mode === "local" ? LOCAL_TOOL_SEARCH_NAME : TOOL_SEARCH_NAME;
}
export function isToolSearchName(name: string | undefined): boolean {
  return name === TOOL_SEARCH_NAME || name === LOCAL_TOOL_SEARCH_NAME;
}
export const TOOL_SEARCH_DEFAULT_RESULTS = 5;
export const TOOL_SEARCH_BETA = "advanced-tool-use-2025-11-20";
/** 写入方使用的撤销原因。读取历史时接受任意字符串：未知原因按“已撤销”处理，compact 不携带。 */
export type ToolSearchRetractionCause =
  | "policy_blocked"
  | "org_blocked"
  | "denied"
  | "disabled"
  | "switched_off"
  | "not_configured";
// MCP 状态扩展读取时丢弃未知字段：开发期写入过的字段（willRetry、blocked、revoked、sources 等）不能让整条公告失效。
export const ToolSearchMcpFailureSchema = z.object({
  name: z.string(),
  errorCode: z.string().optional(),
  error: z.string().optional(),
});
export const ToolSearchMcpStateSchema = z.object({
  pending: z.array(z.string()),
  /** 需要用户授权后才能使用的 server；缺席等同空列表。 */
  needsAuth: z.array(z.string()).optional(),
  failed: z.array(ToolSearchMcpFailureSchema),
});
export type ToolSearchMcpState = z.infer<typeof ToolSearchMcpStateSchema>;
export const ToolSearchAnnouncementSchema = z
  .object({
    addedNames: z.array(z.string().min(1)),
    removedNames: z.array(z.string().min(1)),
    readdedNames: z.array(z.string().min(1)),
  })
  .strict()
  .refine((delta) => delta.readdedNames.every((name) => delta.addedNames.includes(name)), {
    message: "Readded tool names must be included in addedNames",
  });
export type ToolSearchAnnouncement = z.infer<typeof ToolSearchAnnouncementSchema>;
// 新状态放在独立 metadata 扩展键，旧读取器仍能校验三数组公告。
// 原因不用封闭枚举：新版本增加的原因不能让降级读取丢掉整条撤销事实。
export const ToolSearchMcpDeltaSchema = z.object({
  mcp: ToolSearchMcpStateSchema.optional(),
  retractedTools: z.array(z.object({ name: z.string(), cause: z.string() })).optional(),
  restoredNames: z.array(z.string()).optional(),
});
export type ToolSearchMcpDelta = z.infer<typeof ToolSearchMcpDeltaSchema>;
// 只保存模型定义，不能持久化 execute、权限或连接等执行能力（由写入方只写这些字段保证）。
// 读取时丢弃未知字段而不是拒绝：修复前 strict 让新版本写入的记录在降级读取时整条被丢弃。
export const ToolSearchDeliverySchema = z.object({
  definitions: z.array(
    z.object({
      tool: z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        inputSchema: z.record(z.string(), z.unknown()),
        strict: z.boolean().optional(),
      }),
      mcp: z.object({ serverName: z.string(), toolName: z.string() }).optional(),
    }),
  ),
  strippedReferences: z.array(z.object({ toolCallId: z.string(), toolName: z.string() })),
});
export type ToolSearchDelivery = z.infer<typeof ToolSearchDeliverySchema>;
export const ToolReferenceContentSchema = z
  .object({
    type: z.literal("tool_reference"),
    toolName: z.string().min(1),
  })
  .strict();
export type ModelToolReferenceContentBlock = z.infer<typeof ToolReferenceContentSchema>;
export const PersistedToolSearchContentSchema = z
  .array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }).strict(),
      ToolReferenceContentSchema,
    ]),
  )
  .min(1);
export const ToolSearchInputSchema = z.object({
  query: z
    .string()
    .describe(
      'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search. Regular expressions are not supported.',
    ),
  max_results: z
    .number()
    .optional()
    .default(TOOL_SEARCH_DEFAULT_RESULTS)
    .describe("Maximum number of results to return (default: 5)"),
});
export const ToolSearchOutputSchema = z.object({
  matches: z.array(z.string()),
  query: z.string(),
  total_deferred_tools: z.number(),
  pending_mcp_servers: z.array(z.string()).optional(),
  failed_mcp_servers: z.array(ToolSearchMcpFailureSchema).optional(),
});
export const ToolSearchInputJsonSchema = toToolJsonSchema(ToolSearchInputSchema);
export const ToolSearchOutputJsonSchema = toToolJsonSchema(ToolSearchOutputSchema);
export interface ToolSearchCapability {
  readonly protocolSupported: boolean;
  readonly defaultEnabled: boolean;
}
export interface ToolSearchCandidate {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly mcp?: { readonly serverName: string; readonly toolName: string };
  readonly description?: string;
  readonly searchHint?: string;
  readonly deferred: boolean;
}
export interface ToolSearchLiveView {
  readonly catalog: readonly ToolSearchCandidate[];
  readonly pending: readonly string[];
  readonly failed: ToolSearchMcpState["failed"];
}
export interface ToolSearchExecutionContext {
  readonly mode: ResolvedToolSearchMode;
  readonly enabled: boolean;
  readonly catalog: readonly ToolSearchCandidate[];
  readonly discovered: ReadonlySet<string>;
  readonly readLatest?: () => ToolSearchLiveView;
  readonly waitForPending?: (
    servers: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<void>;
}
