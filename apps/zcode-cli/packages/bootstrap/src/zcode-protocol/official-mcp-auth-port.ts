/* Agent 侧的官方 MCP 身份头端口。
   Agent 进程不是身份权威：经 interaction/requestOfficialMcpAuthHeaders 反向请求 host，
   由 host 解析当前 Coding Plan 凭证后回传本次请求的身份头。凭证不落 runtime config、
   不持久化、不进日志。 */
import {
  zcodeOfficialMcpAuthHeadersResponseSchema,
  zcodeProtocolMethods,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type {
  Logger,
  OfficialMcpAuthHeadersPort,
  OfficialMcpAuthHeadersResult,
} from "@zcode/contracts";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

let requestSequence = 0;

/** 端口只需要发反向请求的能力，不需要整个 server context。 */
export type OfficialMcpAuthRequestContext = Pick<ZCodeProtocolAgentServerContext, "requestClient">;

/**
 * 构造经协议反向请求取身份头的端口。
 *
 * `resolveContext` 是惰性的：MCP 连接池的构造早于 ZCodeProtocolAgentServer，
 * server 就绪前返回 undefined，此时按不可用处理（不降级为匿名请求）。
 *
 * 失败一律走返回值（ok:false + 可枚举 reason），不抛异常：
 * 传输层异常统一归为 official_auth_unavailable，由 MCP adapter 置该 server 为 failed。
 *
 * workspace 的用途与已知缺口：
 * - host 侧**不**用它路由响应——响应经 `client.respond(request.id, ...)` 回到发起请求的
 *   那条 stdio 连接，路由由连接本身决定。该字段仅作请求上下文/审计用；
 * - 但仍必须遵守仓库约定 `workspaceKey = workspaceIdentity?.trim() || workspacePath`，
 *   否则同路径不同 identity 的远端 workspace 在审计上下文里无法区分；
 * - **剩余缺口**：CLI agent 进程当前没有 workspaceIdentity 来源
 *   （`RunZCodeProtocolAgentOptions` 只有 cwd/env/…，也无对应环境变量），因此该字段实际
 *   退化为 workspacePath。这里保证的是"拿到 identity 就正确透传"，而不是"identity 一定存在"。
 *   若将来审计需要真实远端身份，需在 spawn 或协议层把 identity 传给 agent，不在本阶段范围。
 */
export function createOfficialMcpAuthHeadersPort(input: {
  resolveContext: () => OfficialMcpAuthRequestContext | undefined;
  resolveWorkspace: (input: {
    workspaceIdentity?: string;
    workspacePath?: string;
    workspaceKey?: string;
  }) => ZCodeWorkspaceRef | undefined;
}): OfficialMcpAuthHeadersPort {
  return {
    async resolveHeaders(request) {
      const context = input.resolveContext();
      const workspace = input.resolveWorkspace({
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
        ...(request.workspacePath ? { workspacePath: request.workspacePath } : {}),
        ...(request.workspaceKey ? { workspaceKey: request.workspaceKey } : {}),
      });
      if (!context || !workspace) {
        return { ok: false, reason: "official_auth_unavailable" };
      }
      requestSequence += 1;
      try {
        return await context.requestClient(
          zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders,
          {
            mcpKey: request.mcpKey,
            pluginId: request.pluginId,
            requestId: `official-mcp-auth:${requestSequence}`,
            targetOrigin: request.targetOrigin,
            workspace,
          },
          zcodeOfficialMcpAuthHeadersResponseSchema,
          request.signal ? { signal: request.signal } : {},
        );
      } catch {
        // host 不可达/协议错误：按不可用处理。错误详情不带出（可能含请求上下文），
        // host 侧已记录不含秘密的分类日志。
        return { ok: false, reason: "official_auth_unavailable" };
      }
    },
  };
}

/**
 * 官方插件命令进程的身份头端口（技术方案 5.8）：给 agent 侧代理端点用，
 * 请求带 consumer=plugin-command、不带 mcpKey，host 按「套餐可选」解析。
 * workspace 取发起命令的会话自己的工作区（端点按 session 记录），不取 agent 进程 cwd。
 * 和 MCP 端口一样，失败一律走返回值；host 拒绝或传输异常额外记 warn，避免被误判为未登录。
 */
export function createOfficialCommandAuthHeadersPort(input: {
  resolveContext: () => OfficialMcpAuthRequestContext | undefined;
  logger?: Pick<Logger, "warn">;
}): {
  resolveHeaders(request: {
    pluginId: string;
    targetOrigin: string;
    workspace: { workspacePath: string; workspaceIdentity?: string };
    signal?: AbortSignal;
  }): Promise<OfficialMcpAuthHeadersResult>;
} {
  return {
    async resolveHeaders(request) {
      const context = input.resolveContext();
      if (!context) {
        return { ok: false, reason: "official_auth_unavailable" };
      }
      const identity = request.workspace.workspaceIdentity?.trim();
      const workspace: ZCodeWorkspaceRef = {
        ...(identity ? { workspaceIdentity: identity } : {}),
        workspaceKey: identity || request.workspace.workspacePath,
        workspacePath: request.workspace.workspacePath,
      };
      requestSequence += 1;
      try {
        return await context.requestClient(
          zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders,
          {
            consumer: "plugin-command",
            pluginId: request.pluginId,
            requestId: `official-command-auth:${requestSequence}`,
            targetOrigin: request.targetOrigin,
            workspace,
          },
          zcodeOfficialMcpAuthHeadersResponseSchema,
          request.signal ? { signal: request.signal } : {},
        );
      } catch (error: unknown) {
        input.logger?.warn("Official command auth request failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "zcode_protocol.official_command_endpoint.auth_request_failed",
          pluginId: request.pluginId,
          workspaceKey: workspace.workspaceKey,
        });
        return { ok: false, reason: "official_auth_unavailable" };
      }
    },
  };
}
