import type {
  PluginCommand,
  McpServerStatus,
  SkillSummary,
  UserCommand,
  ZCodeCommand,
  ZCodeMcpServer,
  ZCodeMcpServerStatusSnapshot,
  ZCodePluginInfo,
  ZCodePluginComponentKind,
  ZCodePluginsDescribeResult,
} from "@zcode/shared";
import { isPluginCommand, isUserCommand, ZCODE_COMMAND_AGENT_SOURCE } from "@zcode/shared";
import type { PluginComponentDisplayGroup } from "@/settings/PluginComponentGroups.js";

export interface ResourceGroups<TLocal, TPlugin> {
  local: TLocal[];
  plugin: TPlugin[];
}

/** 详情分组的展示顺序，与 describeResultToDisplayGroups / buildInstalledPluginDisplayGroups 一致。 */
const COMPONENT_KIND_ORDER: ZCodePluginComponentKind[] = [
  "agent",
  "command",
  "skill",
  "hook",
  "mcp",
];

/**
 * 把 plugins/describe 的按需结果映射为共享展示分组（名称+描述），并按固定顺序排序、
 * 省略空分组。数量取 items.length（describe 已是权威枚举）。
 */
export function describeResultToDisplayGroups(
  result: ZCodePluginsDescribeResult,
): PluginComponentDisplayGroup[] {
  const byKind = new Map<ZCodePluginComponentKind, PluginComponentDisplayGroup>();
  for (const group of result.components) {
    if (group.items.length === 0) continue;
    byKind.set(group.kind, {
      kind: group.kind,
      count: group.items.length,
      items: group.items.map((item) => ({
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      })),
    });
  }
  return COMPONENT_KIND_ORDER.map((kind) => byKind.get(kind)).filter(
    (group): group is PluginComponentDisplayGroup => group !== undefined,
  );
}

/**
 * 把 plugins/list 下发的权威 components（名称+描述）映射为共享展示分组，逻辑与
 * describeResultToDisplayGroups 一致：按固定顺序排序、省略空分组、数量取 items.length。
 *
 * 已安装详情弹窗过去用 buildPluginComponentGroups —— 数量取协议 skillCount、名称靠
 * UI 侧 join（skillsService 结果按 pluginName 过滤）。两数据源分离导致停用插件整组消失、
 * 启用插件只有数量没有名称。现在 CLI 已对插件根目录做权威枚举并随 list 下发 components，
 * 这里直接用它，彻底去掉脆弱的 join。
 */
export function buildInstalledPluginDisplayGroups(
  plugin: ZCodePluginInfo,
): PluginComponentDisplayGroup[] {
  const byKind = new Map<ZCodePluginComponentKind, PluginComponentDisplayGroup>();
  for (const group of plugin.components ?? []) {
    if (group.items.length === 0) continue;
    byKind.set(group.kind, {
      kind: group.kind,
      count: group.items.length,
      items: group.items.map((item) => ({
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      })),
    });
  }
  return COMPONENT_KIND_ORDER.map((kind) => byKind.get(kind)).filter(
    (group): group is PluginComponentDisplayGroup => group !== undefined,
  );
}

export interface PluginMcpServerItem {
  active: boolean;
  authorization?: ZCodeMcpServerStatusSnapshot["authorization"];
  error?: string;
  failureKind?: ZCodeMcpServerStatusSnapshot["failureKind"];
  id: string;
  name: string;
  pluginEnabled: boolean;
  pluginId: string;
  pluginMarketplace: string;
  pluginName: string;
  runtimeServerName: string;
  serverRequestId?: string;
  status?: McpServerStatus;
  toolCount?: number;
}

export interface PluginMcpServerGroup {
  items: PluginMcpServerItem[];
  pluginId: string;
  pluginName: string;
}

export function groupPluginMcpServersByPlugin(
  items: readonly PluginMcpServerItem[],
): PluginMcpServerGroup[] {
  const groups = new Map<string, PluginMcpServerGroup>();
  for (const item of items) {
    const group = groups.get(item.pluginId) ?? {
      items: [],
      pluginId: item.pluginId,
      pluginName: item.pluginName,
    };
    group.items.push(item);
    groups.set(item.pluginId, group);
  }
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      items: group.items
        .map((item, index) => ({ index, item }))
        .toSorted((left, right) => {
          const leftAttention = Boolean(
            left.item.authorization?.authorizationUrl || left.item.status === "error",
          );
          const rightAttention = Boolean(
            right.item.authorization?.authorizationUrl || right.item.status === "error",
          );
          return Number(rightAttention) - Number(leftAttention) || left.index - right.index;
        })
        .map(({ item }) => item),
    }))
    .toSorted((left, right) =>
      left.pluginName.localeCompare(right.pluginName, undefined, {
        sensitivity: "base",
      }),
    );
}

function normalizedQueryMatches(query: string, values: readonly (string | undefined)[]): boolean {
  const keyword = query.trim().toLowerCase();
  if (!keyword) {
    return true;
  }
  return values.some((value) => value?.toLowerCase().includes(keyword));
}

export function groupSkillsByPlugin(
  skills: SkillSummary[],
  query: string,
): ResourceGroups<SkillSummary, SkillSummary> {
  const seenPaths = new Set<string>();
  const local: SkillSummary[] = [];
  const plugin: SkillSummary[] = [];
  for (const skill of skills) {
    const normalizedPath = skill.path.replaceAll("\\", "/").toLowerCase();
    if (seenPaths.has(normalizedPath)) {
      continue;
    }
    seenPaths.add(normalizedPath);
    if (!normalizedQueryMatches(query, [skill.name, skill.description, skill.pluginName])) {
      continue;
    }
    if (skill.scope === "plugin") {
      plugin.push(skill);
    } else {
      local.push(skill);
    }
  }
  return { local, plugin };
}

export function groupCommandsByPlugin(
  commands: ZCodeCommand[],
  query: string,
): ResourceGroups<UserCommand, PluginCommand> {
  const local: UserCommand[] = [];
  const plugin: PluginCommand[] = [];
  for (const command of commands) {
    if (
      isUserCommand(command) &&
      command.agentSource === ZCODE_COMMAND_AGENT_SOURCE &&
      normalizedQueryMatches(query, [command.name, command.description, command.prompt])
    ) {
      local.push(command);
      continue;
    }
    if (
      isPluginCommand(command) &&
      normalizedQueryMatches(query, [
        command.name,
        command.description,
        command.prompt,
        command.pluginName,
      ])
    ) {
      plugin.push(command);
    }
  }
  return { local, plugin };
}

export function filterLocalMcpServers(servers: ZCodeMcpServer[], query: string): ZCodeMcpServer[] {
  return servers.filter((server) => {
    if (server.source !== "zcodeagentmcp") {
      return false;
    }
    return normalizedQueryMatches(query, [server.name, server.config.url, server.config.command]);
  });
}

export function buildPluginMcpServerItems(
  plugins: ZCodePluginInfo[],
  query: string,
  statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot> = {},
): PluginMcpServerItem[] {
  return plugins.flatMap((plugin) => {
    const activeNames = new Set(plugin.mcpServerNames);
    const activeDisplayNames = new Set(
      plugin.mcpServerNames.flatMap((serverName) => [
        serverName,
        toPluginMcpServerDisplayName(plugin, serverName),
      ]),
    );
    const declaredNames = (plugin.declaredMcpServerNames ?? plugin.mcpServerNames).map(
      (serverName) => toPluginMcpServerDisplayName(plugin, serverName),
    );
    // MCP 管理页要展示插件内置 MCP，即使插件当前未启用也应能看出来源。
    // mcpServerNames 仍表示 runtime 已注入的 MCP；declaredMcpServerNames 只用于只读展示。
    // 插件 MCP 注入 runtime 时会加 plugin:<插件名>: 前缀，展示层需要用声明名判定 active，避免误报“未加载”。
    const serverNames = Array.from(
      new Set([
        ...declaredNames,
        ...plugin.mcpServerNames.map((serverName) =>
          toPluginMcpServerDisplayName(plugin, serverName),
        ),
      ]),
    );
    return serverNames
      .filter((serverName) => normalizedQueryMatches(query, [serverName, plugin.name, plugin.id]))
      .map((serverName) => {
        const runtimeServerName = resolvePluginMcpRuntimeServerName(plugin, serverName);
        const mappedStatus = plugin.enabled
          ? mapPluginRuntimeStatus(statusSnapshots[runtimeServerName])
          : {};
        return {
          ...mappedStatus,
          active: activeNames.has(serverName) || activeDisplayNames.has(serverName),
          id: `${plugin.id}:${serverName}`,
          name: serverName,
          pluginEnabled: plugin.enabled,
          pluginId: plugin.id,
          pluginMarketplace: plugin.marketplace,
          pluginName: plugin.name,
          runtimeServerName,
        };
      });
  });
}

function toPluginMcpServerDisplayName(plugin: ZCodePluginInfo, serverName: string): string {
  const namespacePrefix = `plugin:${plugin.name}:`;
  return serverName.startsWith(namespacePrefix)
    ? serverName.slice(namespacePrefix.length)
    : serverName;
}

function resolvePluginMcpRuntimeServerName(plugin: ZCodePluginInfo, displayName: string): string {
  const activeName = plugin.mcpServerNames.find(
    (serverName) =>
      serverName === displayName ||
      toPluginMcpServerDisplayName(plugin, serverName) === displayName,
  );
  return activeName ?? `plugin:${plugin.name}:${displayName}`;
}

function mapPluginRuntimeStatus(
  snapshot: ZCodeMcpServerStatusSnapshot | undefined,
): Pick<
  PluginMcpServerItem,
  "authorization" | "error" | "failureKind" | "serverRequestId" | "status" | "toolCount"
> {
  if (!snapshot) {
    return {};
  }

  switch (snapshot.status) {
    case "connected":
    case "connecting":
      return {
        authorization: snapshot.authorization,
        status: snapshot.status,
        toolCount: snapshot.toolCount,
      };
    case "disconnected":
      return {
        authorization: snapshot.authorization,
        error: snapshot.error,
        failureKind: snapshot.failureKind,
        serverRequestId: snapshot.serverRequestId,
        status: snapshot.status,
        toolCount: snapshot.toolCount,
      };
    case "failed":
      return {
        error: snapshot.error ?? "MCP server failed",
        failureKind: snapshot.failureKind ?? "connection_failed",
        serverRequestId: snapshot.serverRequestId,
        status: "error",
        toolCount: snapshot.toolCount,
      };
    case "disabled":
      return {
        error: snapshot.error,
        failureKind: snapshot.failureKind,
        serverRequestId: snapshot.serverRequestId,
        status: "unknown",
        toolCount: snapshot.toolCount,
      };
    case "untrusted":
      return {
        error: snapshot.error ?? "Project MCP server requires explicit connection before use.",
        failureKind: snapshot.failureKind ?? "status_unavailable",
        serverRequestId: snapshot.serverRequestId,
        status: "unknown",
        toolCount: snapshot.toolCount,
      };
  }
}
