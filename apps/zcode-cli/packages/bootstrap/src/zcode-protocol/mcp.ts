import { createWorkspaceMcpTrust } from "../workspace-mcp-trust/index.js";
import {
  zcodeWorkspaceMcpTrustParamsSchema,
  type ZCodeWorkspaceMcpTrustResult,
} from "@zcode/shared";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import type { Logger, McpConnectionSnapshot, McpPort, McpServerStatus } from "@zcode/contracts";
import {
  zcodeMcpListParamsSchema,
  zcodeMcpListResultSchema,
  type ZCodeMcpListResult,
} from "@zcode/shared";
import {
  listMcpServerStatuses,
  omitMcpServers,
  resolveTrustedOfficialCuaServerNames,
} from "../mcp-config.js";
import { StartupTimer, startupNow } from "../startup-logging.js";
import { getCliStorageRoot } from "../app/paths.js";
import { resolveStartupPlugins } from "../app/startup-marks.js";
import { protocolMcpServersToRuntimeMcpConfig } from "./protocol-mcp-config.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

const MCP_OAUTH_AUTHORIZATION_STATUS_WAIT_MS = 5_000;
const MCP_OAUTH_AUTHORIZATION_STATUS_POLL_MS = 100;

export async function listMcpServers(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpListResult> {
  const params = parseParams(zcodeMcpListParamsSchema, rawParams);
  const workingDirectory = params.workspace.workspacePath;
  const configResult = createConfig({
    env: context.deps.env,
    workingDirectory,
  });
  const cliStorageRoot = getCliStorageRoot(resolvePath(configResult.config.storage.dir));
  const startupTimer = new StartupTimer(
    context.logger ?? noopLogger,
    {
      module: "bootstrap.zcode_protocol.mcp",
      workspaceKey: params.workspace.workspaceKey,
      workspacePath: params.workspace.workspacePath,
    },
    startupNow(),
  );
  const pluginOutcome = await resolveStartupPlugins({
    cliStorageRoot,
    configResult,
    env: context.deps.env,
    logger: context.logger,
    options: {
      pluginPreparation: context.deps?.pluginPreparation,
      pluginDiscovery: context.deps?.pluginDiscovery,
      runtimeConfig: {
        memory: { workspaceIdentity: params.workspace.workspaceIdentity },
        remoteSessionId: params.workspace.remoteSessionId,
      },
    },
    startupTimer,
    workingDirectory,
  });
  const explicitMcpServersProvided = params.mcpServers !== undefined;
  const explicitRuntimeMcp = protocolMcpServersToRuntimeMcpConfig(params.mcpServers);
  const configuredMcpServers = {
    ...pluginOutcome.mcpServers,
    // 设置页的本地 MCP 列表由 desktop main 解析 `.zcode` / `.agents` fallback，
    // session runtime 也使用这批 params.mcpServers。mcp/list 不能再只靠 agent createConfig，
    // 否则 `.agents` fallback 行会缺少 status snapshot 并被 UI 误标红。
    ...(explicitMcpServersProvided
      ? (explicitRuntimeMcp?.servers ?? {})
      : configResult.config.mcp.servers),
  };
  const trustedOfficialCuaServerNames = resolveTrustedOfficialCuaServerNames(
    configuredMcpServers,
    pluginOutcome.mcpServers,
  );
  const authority = createWorkspaceMcpTrust({
    workingDirectory,
    workspaceIdentity: params.workspace.workspaceIdentity,
    env: context.deps.env,
  });
  const reviews = await authority.inspect();
  const untrustedProjectMcpServers = new Set(
    Object.entries(reviews)
      .filter(([, review]) => !review.trusted)
      .map(([name]) => name),
  );
  for (const [name, config] of Object.entries(configuredMcpServers)) {
    if (!config.source && configResult.sources.mcp.serverSources[name] === "project") {
      configuredMcpServers[name] = { ...config, source: { kind: "workspace" } };
    } else if (!config.source && configResult.sources.mcp.serverSources[name] === "user") {
      configuredMcpServers[name] = { ...config, source: { kind: "user" } };
    }
  }
  const withReviews = async (statuses: Record<string, McpServerStatus>) => {
    for (const [name, review] of Object.entries(await authority.inspect())) {
      const config = configuredMcpServers[name];
      if (
        config?.source?.kind === "user" ||
        config?.source?.kind === "plugin" ||
        config?.source?.kind === "builtin"
      )
        continue;
      statuses[name] = {
        ...(statuses[name] ?? {
          status: "disconnected",
          transport: review.transport,
          toolCount: 0,
          updatedAt: new Date().toISOString(),
        }),
        ...(!review.configuredEnabled
          ? { status: "disabled" as const, toolCount: 0 }
          : !review.trusted
            ? { status: "untrusted" as const, toolCount: 0 }
            : {}),
        workspaceTrust: review,
      };
    }
    return statuses;
  };
  if (params.mode === "status") {
    // 只读轮询曾接管共享 lease，取消其他工作区的 OAuth；仅显式连接允许切换 owner。
    const cached = context.deps.mcpPort && settingsPorts.get(context.deps.mcpPort);
    const current = cached?.workspaceKey === params.workspace.workspaceKey ? cached : undefined;
    await current?.ready;
    let statuses = await listMcpServerStatuses(
      current && !current.controller.signal.aborted ? current.port : undefined,
      configuredMcpServers,
      untrustedProjectMcpServers,
    );
    // 读取期间被显式切换时，丢弃共享 lease 的迟到快照，避免串入新 owner 的状态。
    if (current?.controller.signal.aborted) {
      statuses = await listMcpServerStatuses(
        undefined,
        configuredMcpServers,
        untrustedProjectMcpServers,
      );
    }
    return zcodeMcpListResultSchema.parse({ statuses: await withReviews(statuses) });
  }

  const mcpPort = context.deps.mcpPort
    ? await settingsPort(context.deps.mcpPort, params.workspace.workspaceKey, authority)
    : undefined;
  if (mcpPort) {
    // OAuth 轮询已由 mode=status 隔离；默认/connect 必须继续执行 replace 收敛，
    // 否则任一 server 待授权时，配置新增/删除和 stale MCP 清理都会被跳过。
    // 默认/connect 模式服务的是设置页刷新这类"重新探测"诉求，而 mcpPort 是进程级
    // `protocol-settings` lease；不带 revalidate 时连接池会直接复用旧 entry 并返回陈旧快照，
    // 停掉的 HTTP MCP 会永远显示已连接（见 adapters/src/mcp/pool.ts revalidateEntry）。
    const connectPromise = mcpPort.connectConfiguredServers(
      omitMcpServers(
        configuredMcpServers,
        untrustedProjectMcpServers,
        trustedOfficialCuaServerNames,
      ),
      {
        revalidate: true,
        workingDirectory,
        workspaceIdentity: params.workspace.workspaceIdentity,
      },
    );
    const pendingAuthorizationSnapshot = await waitForOAuthAuthorizationSnapshot(
      mcpPort,
      connectPromise,
    );
    if (pendingAuthorizationSnapshot) {
      void connectPromise.catch((error) => {
        context.logger?.warn("MCP background authorization connection failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.authorization.background.failed",
          workspaceKey: params.workspace.workspaceKey,
          workspacePath: params.workspace.workspacePath,
        });
      });
      return zcodeMcpListResultSchema.parse({
        statuses: await withReviews(pendingAuthorizationSnapshot.statuses),
      });
    }

    await connectPromise;
  }
  const statuses = await listMcpServerStatuses(
    mcpPort,
    configuredMcpServers,
    untrustedProjectMcpServers,
  );
  return zcodeMcpListResultSchema.parse({ statuses: await withReviews(statuses) });
}

async function waitForOAuthAuthorizationSnapshot(
  mcpPort: McpPort,
  connectPromise: Promise<McpConnectionSnapshot>,
): Promise<McpConnectionSnapshot | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MCP_OAUTH_AUTHORIZATION_STATUS_WAIT_MS) {
    const race = await Promise.race([
      connectPromise.then(
        (snapshot) => ({ kind: "completed" as const, snapshot }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      delay(MCP_OAUTH_AUTHORIZATION_STATUS_POLL_MS).then(() => ({ kind: "poll" as const })),
    ]);

    if (race.kind === "completed") {
      return undefined;
    }
    if (race.kind === "failed") {
      throw race.error;
    }

    const statuses = await mcpPort.status();
    if (hasPendingOAuthAuthorization(statuses)) {
      return {
        statuses,
        tools: await mcpPort.listTools(),
      };
    }
  }

  return undefined;
}

function hasPendingOAuthAuthorization(statuses: Record<string, McpServerStatus>): boolean {
  return Object.values(statuses).some((status) => Boolean(status.authorization?.authorizationUrl));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const settingsPorts = new WeakMap<
  McpPort,
  { workspaceKey: string; port: McpPort; controller: AbortController; ready: Promise<void> }
>();
async function settingsPort(
  raw: McpPort,
  workspaceKey: string,
  authority: ReturnType<typeof createWorkspaceMcpTrust>,
): Promise<McpPort> {
  const previous = settingsPorts.get(raw);
  if (previous?.workspaceKey === workspaceKey) {
    await previous.ready;
    return previous.port;
  }
  // 旧 OAuth 可在切换后才完成；先使旧 gate 失效，禁止它继续向共享 lease 写入连接。
  previous?.controller.abort();
  const controller = new AbortController();
  const port = authority.guard(raw, controller.signal);
  // 清理只串行等待前次清理，不等待 OAuth；并发切换不能迟到断开新 workspace 的连接。
  const ready = (previous?.ready ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      for (const name of Object.keys(await raw.status())) {
        if (controller.signal.aborted) return;
        await raw.disconnectServer(name);
      }
    });
  settingsPorts.set(raw, { workspaceKey, port, controller, ready });
  try {
    await ready;
  } catch (error) {
    // 清理失败不缓存永久 rejected 的 gate；只撤销自己，不能删除已接管的新目标。
    controller.abort();
    if (settingsPorts.get(raw)?.port === port) settingsPorts.delete(raw);
    throw error;
  }
  return port;
}

export async function setWorkspaceMcpTrust(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkspaceMcpTrustResult> {
  const params = parseParams(zcodeWorkspaceMcpTrustParamsSchema, rawParams);
  try {
    await createWorkspaceMcpTrust({
      workingDirectory: params.workspace.workspacePath,
      workspaceIdentity: params.workspace.workspaceIdentity,
      env: context.deps.env,
    }).decide(params.serverName, params.declarationDigest, params.trusted);
    // 与 Hooks 一样按 workspace 通知活跃会话；不能把已落盘的决定误报为授权失败。
    const refreshes = await Promise.allSettled(
      [...context.sessions.values()]
        .filter((record) => record.workspace.workspaceKey === params.workspace.workspaceKey)
        .map((record) => record.app.reloadWorkspaceMcpTrust?.()),
    );
    if (refreshes.some((result) => result.status === "rejected")) {
      context.logger?.warn("MCP trust admission refresh failed", {
        event: "mcp.trust.admission.refresh.failed",
        workspaceKey: params.workspace.workspaceKey,
      });
    }
    return { accepted: true };
  } catch (error) {
    return {
      accepted: false,
      reasonCode:
        error instanceof Error && error.message === "workspace_mcp_declaration_changed"
          ? "workspace_mcp_declaration_changed"
          : "workspace_mcp_trust_unavailable",
    };
  }
}
