import { SessionEventType, createEventId } from "@zcode/contracts";
import {
  zcodeMcpReadResourceParamsSchema,
  zcodeMcpUiCallToolParamsSchema,
  zcodeMcpUiCancelCallParamsSchema,
  zcodeMcpUiCloseInstanceParamsSchema,
  zcodeMcpUiListResourcesParamsSchema,
  zcodeMcpUiOpenInstanceParamsSchema,
  zcodeMcpUiReadResourceParamsSchema,
  zcodeMcpUiResourceSubscriptionParamsSchema,
  type ZCodeMcpReadResourceResult,
  type ZCodeMcpUiCallToolResult,
  type ZCodeMcpUiCancelCallResult,
  type ZCodeMcpUiListResourceTemplatesResult,
  type ZCodeMcpUiListResourcesResult,
  type ZCodeMcpUiReadResourceResult,
} from "@zcode/shared";
import {
  ProtocolRequestError,
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "../server-types.js";
import { getSessionLifecycle } from "../session-residency.js";
import { getMcpUiAppToolRegistry } from "./appToolsProtocol.js";
import {
  McpUiNotSupportedError,
  McpUiResourceRejectedError,
  McpUiServerScopeError,
  McpUiToolAccessError,
} from "./contract.js";
import { clearMcpUiInstanceCalls, createMcpUiHandlers } from "./handlers.js";
import { mcpUiInstances } from "./instances.js";
import { createMcpUiSessionAccess } from "./sessionAccess.js";

/** `mcp/readResource`：插件 UI 的 `ui://` 资源读取，走 session 自己的 mcpPort。 */
export async function readMcpUiResource(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<ZCodeMcpReadResourceResult> {
  const params = parseParams(zcodeMcpReadResourceParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, { operation: "mcp/readResource" });
  const active = mcpUiInstances.validate(
    params.instance,
    params,
    record.app.getMcpAppConnectionSnapshot(params.serverName),
  );
  if (active.binding.resourceUri !== params.uri)
    throw new ProtocolRequestError(-32602, "MCP App resource binding mismatch");
  return translateScopeError(() =>
    createMcpUiHandlers({ logger: context.logger }).readResource(
      createMcpUiSessionAccess(record, params),
      params,
      { signal },
    ),
  );
}

/** `mcp/uiCallTool`：插件 UI 回调本插件工具；复用工具授权路径，不产生 transcript row。 */
export async function callMcpUiTool(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<ZCodeMcpUiCallToolResult> {
  const params = parseParams(zcodeMcpUiCallToolParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiCallTool" });
  return translateScopeError(() =>
    createMcpUiHandlers({ logger: context.logger }).callTool(
      createMcpUiSessionAccess(record, params),
      params,
      { signal },
    ),
  );
}

/** `mcp/uiCancelCall`（）：取消 `mcp/uiCallTool` 带 callId 的进行中调用；同样 fail closed 校验归属。 */
export async function cancelMcpUiToolCall(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpUiCancelCallResult> {
  const params = parseParams(zcodeMcpUiCancelCallParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiCancelCall" });
  return translateScopeError(async () =>
    createMcpUiHandlers({ logger: context.logger }).cancelToolCall(
      createMcpUiSessionAccess(record, params),
      params,
    ),
  );
}

/** `mcp/uiListResources` / `mcp/uiListResourceTemplates`（同插件服务器，分页游标透传）。 */
export async function listMcpUiResources(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<ZCodeMcpUiListResourcesResult> {
  const params = parseParams(zcodeMcpUiListResourcesParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiListResources" });
  return translateScopeError(() =>
    createMcpUiHandlers({ logger: context.logger }).listResources(
      createMcpUiSessionAccess(record, params),
      params,
      { signal },
    ),
  );
}

export async function listMcpUiResourceTemplates(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<ZCodeMcpUiListResourceTemplatesResult> {
  const params = parseParams(zcodeMcpUiListResourcesParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    operation: "mcp/uiListResourceTemplates",
  });
  return translateScopeError(() =>
    createMcpUiHandlers({ logger: context.logger }).listResourceTemplates(
      createMcpUiSessionAccess(record, params),
      params,
      { signal },
    ),
  );
}

/** `mcp/uiSubscribeResource` / `mcp/uiUnsubscribeResource`；订阅者 = sessionId + scopeId + generation。 */
export async function subscribeMcpUiResource(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<Record<string, never>> {
  const params = parseParams(zcodeMcpUiResourceSubscriptionParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    operation: "mcp/uiSubscribeResource",
  });
  await translateScopeError(() =>
    createMcpUiHandlers({ logger: context.logger }).subscribeResource(
      createMcpUiSessionAccess(record, params),
      params,
      { signal },
    ),
  );
  return {};
}

export async function unsubscribeMcpUiResource(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<Record<string, never>> {
  const params = parseParams(zcodeMcpUiResourceSubscriptionParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    operation: "mcp/uiUnsubscribeResource",
  });
  await translateScopeError(() =>
    createMcpUiHandlers({ logger: context.logger }).unsubscribeResource(
      createMcpUiSessionAccess(record, params),
      params,
      { signal },
    ),
  );
  return {};
}

/** `mcp/uiReadResource`：插件页面发起的 resources/read（A7）；限同插件服务器、8 MiB、mimeType 白名单。 */
export async function readMcpUiResourceForUi(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<ZCodeMcpUiReadResourceResult> {
  const params = parseParams(zcodeMcpUiReadResourceParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiReadResource" });
  return translateScopeError(() =>
    createMcpUiHandlers({ logger: context.logger }).readResourceForUi(
      createMcpUiSessionAccess(record, params),
      params,
      { signal },
    ),
  );
}

async function translateScopeError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpUiServerScopeError) {
      throw new ProtocolRequestError(error.code, error.message, {
        serverName: error.serverName,
      });
    }
    if (error instanceof McpUiToolAccessError) {
      throw new ProtocolRequestError(error.code, error.message, {
        reason: error.reason,
        serverName: error.serverName,
        toolName: error.toolName,
      });
    }
    if (error instanceof McpUiNotSupportedError) {
      throw new ProtocolRequestError(error.code, error.message, {
        reason: error.reason,
        serverName: error.serverName,
        operation: error.operation,
      });
    }
    if (error instanceof McpUiResourceRejectedError) {
      throw new ProtocolRequestError(error.code, error.message, {
        reason: error.reason,
        uri: error.uri,
        ...error.detail,
      });
    }
    throw error;
  }
}

export async function openMcpUiInstance(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeMcpUiOpenInstanceParamsSchema, rawParams);
  // 冷打开时历史订阅已建立，但 session 可能仍在恢复；直接 requireSession 会让面板停在错误页。
  // 复用生命周期 owner 的恢复 Promise，等 ready 后再签发实例，不靠延时或重复初始化。
  await getSessionLifecycle(context).ensureReady(params.sessionId);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiOpenInstance" });
  // session ready 不代表目标 MCP ready；首次签发等待连接，已有凭证校验仍保持同步拒绝失效来源。
  const source = await record.app.waitForMcpAppConnection(params.serverName);
  const current = record.app.getMcpAppConnectionSnapshot(params.serverName);
  if (
    context.sessions.get(params.sessionId) !== record ||
    !source ||
    current?.identity !== source.identity ||
    current.generation !== source.generation
  )
    throw new ProtocolRequestError(-32001, "MCP App connection is unavailable");
  const lease = mcpUiInstances.open(
    {
      workspace: params.workspace.workspaceIdentity?.trim() || params.workspace.workspacePath,
      accountContext: params.accountContext,
      sessionId: params.sessionId,
      pluginId: params.pluginId,
      serverName: params.serverName,
      scopeId: params.scopeId,
      resourceUri: params.resourceUri,
      ownerWebContentsId: params.ownerWebContentsId,
    },
    source,
  );
  const active = mcpUiInstances.validate(lease, params, source);
  if (active.watched) return lease;
  active.watched = true;
  active.onActivity = (callId, activity) =>
    context.v4Gateway?.ingest(params.sessionId, {
      id: createEventId(),
      sessionId: params.sessionId as never,
      type: SessionEventType.PluginUiAppToolCallRequested,
      timestamp: new Date(),
      traceId: String(record.traceContext.traceId) as never,
      sequenceNumber: 0,
      payload: {
        pluginId: params.pluginId,
        serverName: params.serverName,
        subscribers: [{ scopeId: lease.token, generation: lease.generation, instance: lease }],
        callId,
        toolName: "",
        arguments: {},
        activity,
      },
    });
  const off = record.app.onMcpAppConnectionInvalidated(params.serverName, () =>
    mcpUiInstances.close(lease),
  );
  active.cancel.signal.addEventListener(
    "abort",
    () => {
      off();
      clearMcpUiInstanceCalls(params.sessionId, lease.token);
      getMcpUiAppToolRegistry(context).unregister(params.sessionId, {
        scopeId: lease.token,
        generation: lease.generation,
      });
      void record.app
        .unsubscribeMcpResourcesForUi(`${params.sessionId}|${lease.token}|`)
        .catch(() => undefined);
      context.v4Gateway?.ingest(params.sessionId, {
        id: createEventId(),
        sessionId: params.sessionId as never,
        type: SessionEventType.PluginUiInstanceClosed,
        timestamp: new Date(),
        traceId: String(record.traceContext.traceId) as never,
        sequenceNumber: 0,
        payload: {
          pluginId: params.pluginId,
          serverName: params.serverName,
          subscribers: [{ scopeId: lease.token, generation: lease.generation, instance: lease }],
        },
      });
    },
    { once: true },
  );
  return lease;
}
export async function closeMcpUiInstance(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeMcpUiCloseInstanceParamsSchema, rawParams);
  const active = mcpUiInstances.find(params.instance.token);
  // 清理允许连接已经断开，但不能用另一来源或会话的凭证撤销当前实例。
  if (active) mcpUiInstances.validate(params.instance, params, active.source);
  if (params.onlyIfIdle && mcpUiInstances.isBusy(params.instance)) return { closed: false };
  if (mcpUiInstances.close(params.instance)) {
    getMcpUiAppToolRegistry(context).unregister(params.sessionId, {
      scopeId: params.instance.token,
      generation: params.instance.generation,
    });
    await context.sessions
      .get(params.sessionId)
      ?.app.unsubscribeMcpResourcesForUi(`${params.sessionId}|${params.instance.token}|`);
  }
  return { closed: true };
}

export async function validateMcpUiInstance(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeMcpUiCloseInstanceParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiValidateInstance" });
  mcpUiInstances.validate(
    params.instance,
    params,
    record.app.getMcpAppConnectionSnapshot(params.serverName),
  );
  return {};
}
