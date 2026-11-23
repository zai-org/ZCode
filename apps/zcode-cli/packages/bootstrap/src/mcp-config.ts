import type {
  McpPort,
  McpConfigurationSnapshot,
  McpServerConfig,
  McpServerStatus,
  McpStdioServerConfig,
} from "@zcode/contracts";
import {
  getCapturedZCodeCuaBrokerCredentials,
  isZCodeCuaMcpCommand,
  isZCodeCuaMcpPackageArg,
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";

export { ZCODE_CUA_BROKER_SOCKET_ENV_KEY as ZCODE_CUA_BROKER_SOCKET_ENV } from "@zcode/shared";
// 保留环境变量名供旧诊断脚本读取；迁移后的配置路径不会据此启动独立 CUA MCP。
export const ZCODE_CUA_BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";
// CLI 入口会先清理 broker 凭据；shared node_repl 的可信配置随后从进程内捕获快照恢复它们。
function resolveZCodeCuaBrokerSocket(): string | undefined {
  // captured 优先；运行时残留的 stale socket 不能覆盖可信快照。
  return (
    getCapturedZCodeCuaBrokerCredentials().socket ||
    process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY]?.trim()
  );
}

function resolveZCodeCuaBrokerToken(): string | undefined {
  return undefined;
}

const NODE_REPL_SERVER_NAME = "node_repl";
const REFRESH_MARKER_ENV = "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER";

/**
 * Derive official CUA provenance from the in-memory plugin registry rather than
 * from serializable MCP fields. A user/project override replaces the config
 * object in `configuredServers`, so copied names, commands, and env values do
 * not inherit the bundled plugin's authority.
 */
export function resolveTrustedOfficialCuaServerNames(
  configuredServers: Record<string, McpServerConfig>,
  pluginServers: Record<string, McpServerConfig>,
): Set<string> {
  return new Set(
    Object.entries(pluginServers)
      .filter(
        ([name, config]) =>
          configuredServers[name] === config &&
          config.type === "stdio" &&
          config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() ===
            ZCODE_CUA_OFFICIAL_PLUGIN_ID,
      )
      .map(([name]) => name),
  );
}

export async function listMcpServerStatuses(
  mcpPort: McpPort | undefined,
  servers: Record<string, McpServerConfig>,
  untrustedServerNames: ReadonlySet<string> = new Set(),
): Promise<Record<string, McpServerStatus>> {
  const liveStatuses = mcpPort ? await mcpPort.status() : {};
  const updatedAt = new Date().toISOString();
  const statuses: Record<string, McpServerStatus> = {};

  for (const [name, config] of Object.entries(servers)) {
    // 迁移后旧的 zcode-cua MCP 只是历史配置，不再进入状态投影；CUA
    // 由 shared node_repl 承载，避免设置页继续把已删除的 server 显示为可用。
    if (isRetiredCuaMcpServer(name, config)) continue;
    const configuredStatus = getConfiguredServerStatus(name, config, untrustedServerNames);
    statuses[name] = liveStatuses[name] ?? {
      status: configuredStatus,
      transport: config.type,
      toolCount: 0,
      updatedAt,
    };
  }

  for (const [name, status] of Object.entries(liveStatuses)) {
    if (!(name in statuses) && !isRetiredCuaMcpServer(name, servers[name])) statuses[name] = status;
  }

  return statuses;
}

export function omitMcpServers(
  servers: Record<string, McpServerConfig>,
  omittedNames: ReadonlySet<string>,
  trustedOfficialCuaServerNames: ReadonlySet<string> = new Set(),
): Record<string, McpServerConfig> {
  const kept = Object.fromEntries(
    Object.entries(servers).filter(
      ([name, config]) => !omittedNames.has(name) && !isRetiredCuaMcpServer(name, config),
    ),
  );

  return injectZCodeCuaBrokerMcpServers(
    kept,
    resolveZCodeCuaBrokerSocket(),
    resolveZCodeCuaBrokerToken(),
    trustedOfficialCuaServerNames,
  );
}

export function injectZCodeCuaBrokerMcpServers(
  servers: Record<string, McpServerConfig>,
  socketPath: string | undefined,
  token: string | undefined = undefined,
  trustedOfficialCuaServerNames: ReadonlySet<string> = new Set(),
): Record<string, McpServerConfig> {
  const normalizedSocketPath = socketPath?.trim();
  const normalizedToken = token?.trim();

  let changed = false;
  const next: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (isRetiredCuaMcpServer(name, config)) {
      changed = true;
      continue;
    }
    if (
      name !== NODE_REPL_SERVER_NAME ||
      !normalizedSocketPath ||
      !trustedOfficialCuaServerNames.has(name)
    ) {
      next[name] = config;
      continue;
    }
    const injected = injectCuaCredentialsIntoNodeRepl(
      config,
      normalizedSocketPath,
      normalizedToken,
    );
    next[name] = injected;
    changed ||= injected !== config;
  }

  return changed ? next : servers;
}

function injectCuaCredentialsIntoNodeRepl(
  config: McpServerConfig,
  socketPath: string,
  token: string | undefined,
): McpServerConfig {
  if (config.type !== "stdio") return config;
  const captured = getCapturedZCodeCuaBrokerCredentials();
  const pluginAuthority = captured.pluginAuthority;
  // CLI runtime env 会在 bootstrap 前被清理。marker 必须和 socket/token 一样取自私有凭据快照，
  // 否则 SDK 迁移后 broker 虽然存活，权限刷新仍会静默停止。
  const refreshMarker = captured.refreshMarker || process.env[REFRESH_MARKER_ENV]?.trim();
  return {
    ...config,
    env: {
      ...config.env,
      [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: socketPath,
      ...(refreshMarker ? { [REFRESH_MARKER_ENV]: refreshMarker } : {}),
      ...(pluginAuthority ? { [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: pluginAuthority } : {}),
      [ZCODE_CUA_NODE_REPL_HOST_ENV_KEY]: "1",
      [ZCODE_PLUGIN_ID_ENV_KEY]: ZCODE_CUA_OFFICIAL_PLUGIN_ID,
    },
  };
}

function isZCodeCuaStdioServer(
  name: string,
  config: McpServerConfig,
): config is McpStdioServerConfig {
  if (config.type !== "stdio") return false;
  if (name === "computer-use") return true;
  // 内置 official zcode-cua plugin 的 MCP server 走 __zcode-plugin-host，command 是 Helper
  // (非 zcode-cua)、args 是 [zcode.cjs, __zcode-plugin-host, server.js]（非 zcode-cua package arg），
  // 上面的 name/command/args 三条都匹配不到。_plugin id 由 adapters resolver 权威写入 env
  // （manifest/user env 不可覆盖），用它识别 official plugin server。
  if (
    config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() === ZCODE_CUA_OFFICIAL_PLUGIN_ID
  ) {
    return true;
  }
  // 判定与 desktop/services 共用 @zcode/shared 的单一事实源，避免两条注入入口漂移。
  if (isZCodeCuaMcpCommand(config.command)) return true;
  return (config.args ?? []).some(isZCodeCuaMcpPackageArg);
}

function isRetiredCuaMcpServer(name: string, config: McpServerConfig | undefined): boolean {
  // node_repl is the single supported CUA host and may share the CUA plugin's
  // authority marker; all other CUA-shaped MCP entries are retired.
  return (
    name !== NODE_REPL_SERVER_NAME && config !== undefined && isZCodeCuaStdioServer(name, config)
  );
}

function getConfiguredServerStatus(
  name: string,
  config: McpServerConfig,
  untrustedServerNames: ReadonlySet<string>,
): McpServerStatus["status"] {
  if (config.enabled === false) return "disabled";
  return untrustedServerNames.has(name) ? "untrusted" : "disconnected";
}

function getConfiguredServerError(
  name: string,
  config: McpServerConfig,
  untrustedServerNames: ReadonlySet<string>,
): string | undefined {
  if (config.enabled === false || !untrustedServerNames.has(name)) return undefined;
  return "Project MCP server requires explicit connection before use.";
}

/** 用户覆盖插件，宿主身份最后合并；首次加载和热更新共用。 */
export function resolveEffectiveMcpConfiguration(input: {
  enabled: boolean;
  servers: Record<string, McpServerConfig>;
  pluginServers?: Record<string, McpServerConfig>;
  explicit?: Partial<McpConfigurationSnapshot>;
  builtInServers?: Record<string, McpServerConfig>;
  computerUse?: boolean;
}): { configuredServers: Record<string, McpServerConfig>; mcp: McpConfigurationSnapshot } {
  const configured = {
    ...input.pluginServers,
    ...(input.explicit?.servers ?? input.servers),
    ...input.builtInServers,
  };
  const trusted = resolveTrustedOfficialCuaServerNames(configured, input.pluginServers ?? {});
  const bridgeNames = new Set(trusted);
  if (input.computerUse && configured.node_repl) bridgeNames.add("node_repl");
  return {
    configuredServers: configured,
    mcp: {
      enabled: input.explicit?.enabled ?? input.enabled,
      servers: omitMcpServers(configured, new Set(), bridgeNames),
      trustedOfficialCuaServerNames: [...trusted],
    },
  };
}
