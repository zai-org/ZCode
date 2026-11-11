// `plugins/mentionItems`：输入框 `@` 面板里 `tool` target 的候选项。
// 规格：docs/design/v2/plugin-compat.md「Composer Mention Items」；总设计 extension-host.md §16.6。
// 只在内存里的会话上执行：不启动、不恢复会话，也不新建 MCP 连接。不设计取消（App 只采用最新 seq）。
// 工具调用走与 MCP App 页面（mcp/uiCallTool）相同的授权链 callMcpToolForUi：schema 校验 →
// PreToolUse hook → 权限规则 / 审批 → 连接代际复验。没有另开绕过审批的宿主调用路径。
import { CoreErrorType, isCoreError } from "@zcode/contracts";
import { findPluginReferenceCatalogEntry } from "@zcode/core";
import {
  ZCODE_PLUGIN_MENTION_ERROR_CODES,
  zcodePluginMentionItemsSchema,
  zcodePluginsMentionItemsParamsSchema,
  type ZCodePluginMentionErrorCode,
  type ZCodePluginsMentionItemsResult,
} from "@zcode/shared";
import {
  ProtocolRequestError,
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";

const OPERATION = "plugins/mentionItems";
const LOG_EVENT = "plugins.mention_items";
const LOG_MODULE = "bootstrap.plugins.mention";
const APP_VISIBILITY = "app";
const INVALID_PARAMS_CODE = -32602;
const SERVER_ERROR_CODE = -32000;
/** result_invalid 的错误信息里最多列出这么多条 schema 路径（只给路径，不给内容）。 */
const MAX_REPORTED_ISSUE_PATHS = 5;

export async function getPluginMentionItems(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsMentionItemsResult> {
  const params = parseParams(zcodePluginsMentionItemsParamsSchema, rawParams);
  // 会话不在内存 → -32004（sessionUnavailable）；不为候选项冷恢复会话。
  const record = requireSession(context, params.sessionId, { operation: OPERATION });
  const startedAt = Date.now();
  const logBase = {
    event: LOG_EVENT,
    module: LOG_MODULE,
    pluginId: params.pluginId,
    tool: params.tool,
  };
  let serverName: string | undefined;
  try {
    serverName = await resolveMentionToolServer(record, params.pluginId, params.tool);
    const items = await callMentionTool(record, serverName, params.tool, params.query);
    // 按键级频率，只记 debug；不记 query 与结果内容。
    context.logger?.debug("Plugin mention items resolved", {
      ...logBase,
      serverName,
      durationMs: Date.now() - startedAt,
      itemCount: items.length,
    });
    return { items };
  } catch (error) {
    context.logger?.debug("Plugin mention items failed", {
      ...logBase,
      ...(serverName ? { serverName } : {}),
      durationMs: Date.now() - startedAt,
      code: readMentionErrorCode(error),
    });
    throw error;
  }
}

/** 按会话冻结的 catalog 找插件，再按排序后的 server 名找第一个提供该工具的 server。 */
async function resolveMentionToolServer(
  record: ZCodeProtocolSessionRecord,
  pluginId: string,
  tool: string,
): Promise<string> {
  const entry = findPluginReferenceCatalogEntry(record.app.getPluginReferenceCatalog(), pluginId);
  // 同名插件冲突时 MCP server 名字空间（plugin:<name>:…）有歧义，按不可用处理。
  if (!entry || !entry.enabled || entry.conflictingPluginIds.length > 0) {
    throw mentionError(
      INVALID_PARAMS_CODE,
      ZCODE_PLUGIN_MENTION_ERROR_CODES.pluginUnavailable,
      `Plugin is not available in this session: ${pluginId}`,
    );
  }
  for (const serverName of [...entry.mcpServerNames].sort()) {
    const visibility = await record.app.getMcpToolVisibility(serverName, tool);
    if (!visibility) continue;
    // 只给模型的工具不给宿主调（与 mcp/uiCallTool 的 app 可见性规则一致）。
    if (!visibility.includes(APP_VISIBILITY)) {
      throw mentionError(
        INVALID_PARAMS_CODE,
        ZCODE_PLUGIN_MENTION_ERROR_CODES.toolNotAppVisible,
        `Plugin tool is not visible to the app: ${serverName}/${tool}`,
      );
    }
    return serverName;
  }
  throw mentionError(
    INVALID_PARAMS_CODE,
    ZCODE_PLUGIN_MENTION_ERROR_CODES.toolNotFound,
    `Plugin tool not found: ${pluginId}/${tool}`,
  );
}

async function callMentionTool(
  record: ZCodeProtocolSessionRecord,
  serverName: string,
  tool: string,
  query: string,
): Promise<ZCodePluginsMentionItemsResult["items"]> {
  let result: Awaited<ReturnType<ZCodeProtocolSessionRecord["app"]["callMcpToolForUi"]>>;
  try {
    // 参数固定为 { query }。审批等待中请求就一直等；用户选「始终允许」后后续调用不再询问。
    result = await record.app.callMcpToolForUi(serverName, tool, { query });
  } catch (error) {
    // 授权链的拒绝带稳定类型（authorizeAppTool 抛 CoreError，见 00-tool-change-chain.md）；
    // 拒绝原因可能是用户反馈或 hook 文本，不转进错误信息。
    if (isAuthorizationDenied(error)) {
      throw mentionError(
        SERVER_ERROR_CODE,
        ZCODE_PLUGIN_MENTION_ERROR_CODES.toolDenied,
        `Plugin tool call was denied: ${serverName}/${tool}`,
        error,
      );
    }
    throw mentionError(
      SERVER_ERROR_CODE,
      ZCODE_PLUGIN_MENTION_ERROR_CODES.toolFailed,
      `Plugin tool call failed: ${serverName}/${tool}`,
      error,
    );
  }
  // 工具返回的错误文本可能带用户内容，不转进错误信息。
  if (result.isError === true) {
    throw mentionError(
      SERVER_ERROR_CODE,
      ZCODE_PLUGIN_MENTION_ERROR_CODES.toolFailed,
      `Plugin tool returned an error: ${serverName}/${tool}`,
    );
  }
  const structured = result.structuredContent;
  const parsed = zcodePluginMentionItemsSchema.safeParse(
    typeof structured === "object" && structured !== null && "items" in structured
      ? (structured as { items: unknown }).items
      : undefined,
  );
  if (!parsed.success) {
    // 只报 schema 路径，不报值：值来自工具结果，可能是用户内容。
    const paths = parsed.error.issues
      .slice(0, MAX_REPORTED_ISSUE_PATHS)
      .map((issue) => ["items", ...issue.path].join("."));
    throw mentionError(
      SERVER_ERROR_CODE,
      ZCODE_PLUGIN_MENTION_ERROR_CODES.resultInvalid,
      `Plugin tool returned invalid mention items: ${serverName}/${tool} (${paths.join(", ")})`,
    );
  }
  return parsed.data;
}

function mentionError(
  jsonRpcCode: number,
  code: ZCodePluginMentionErrorCode,
  message: string,
  cause?: unknown,
): ProtocolRequestError {
  const error = new ProtocolRequestError(jsonRpcCode, message, { code });
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isAuthorizationDenied(error: unknown): boolean {
  return (
    isCoreError(error) &&
    (error.type === CoreErrorType.PermissionDenied ||
      error.type === CoreErrorType.PermissionEscalation)
  );
}

function readMentionErrorCode(error: unknown): string | number | undefined {
  if (!(error instanceof ProtocolRequestError)) return undefined;
  const data = error.data;
  if (typeof data === "object" && data !== null && "code" in data) {
    const code = (data as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error.code;
}
