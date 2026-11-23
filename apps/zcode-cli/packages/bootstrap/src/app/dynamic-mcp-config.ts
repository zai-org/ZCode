import { join } from "node:path";
import {
  createDynamicMcpConfigSource,
  type McpConfigurationSourceOptions,
} from "@zcode/adapters/mcp";
import { resolvePath, type ConfigResult } from "@zcode/adapters/config";
import { discoverWorkspaceHookConfigPathsAsync } from "@zcode/shared/workspace-hook-discovery";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { Logger, McpServerConfig, PluginLoadOutcome } from "@zcode/contracts";
import type { ZCodeAppOptions } from "./types.js";
import { getPluginStorageRoot } from "./paths.js";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS } from "./official-plugin-definitions.js";
import { resolveEffectiveMcpConfiguration } from "../mcp-config.js";
import {
  injectNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./node-repl-browser-broker.js";

export async function createAppMcpConfigurationSource(input: {
  options: ZCodeAppOptions;
  configResult: ConfigResult;
  runtimeFeatures: AgentRuntimeConfig["runtimeFeatures"];
  pluginOutcome: PluginLoadOutcome;
  builtInMcpServers: Record<string, McpServerConfig>;
  cliStorageRoot: string;
  workingDirectory: string;
  getNodeReplBrowserBroker?: () => NodeReplBrowserBroker | undefined;
  logger: Logger;
}) {
  const { options, workingDirectory, configResult } = input;
  // app（包括 fork）拥有自己的连接；借用 child 由 runtime 工厂装配，不经过此入口。
  const projectPaths = await discoverWorkspaceHookConfigPathsAsync({
    workingDirectory,
    explicitProjectConfigPath: options.projectConfigPath,
    includeMissing: true,
  });
  const userPath = options.skipUserConfig ? undefined : configResult.sources.user.path;
  const paths = projectPaths.map((ref) => ref.path);
  // MCP 的既有专用优先级是 user 覆盖 project，与配置来源标记无关。
  if (userPath) paths.push(userPath);
  const sourceOptions: McpConfigurationSourceOptions = {
    configPaths: paths,
    userConfigPath: userPath,
    fallbackPaths: {
      ...(userPath ? { [userPath]: join(resolvePath("~/"), ".agents", "mcp.json") } : {}),
      [join(workingDirectory, ".zcode", "config.json")]: join(
        workingDirectory,
        ".agents",
        "mcp.json",
      ),
    },
    pluginStorageRoot: options.pluginStorageRoot ?? getPluginStorageRoot(input.cliStorageRoot),
    pluginRoots: input.pluginOutcome.plugins,
    explicitServers: options.runtimeConfig?.mcp?.servers,
    workingDirectory,
    env: options.env,
    defaultEnabledPlugins: new Set(DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS),
    logger: input.logger,
    prepare(servers, pluginServers, enabled) {
      const effective = resolveEffectiveMcpConfiguration({
        enabled,
        servers,
        pluginServers,
        explicit: options.runtimeConfig?.mcp,
        builtInServers: input.builtInMcpServers,
        computerUse: input.runtimeFeatures?.computerUse === true,
      });
      const broker =
        effective.mcp.servers.node_repl?.type === "stdio"
          ? input.getNodeReplBrowserBroker?.()
          : undefined;
      return broker
        ? { ...effective.mcp, servers: injectNodeReplBrowserBroker(effective.mcp.servers, broker) }
        : effective.mcp;
    },
  };
  // 同一进程内输入相同的会话共用一组 watcher 与读盘结果；prepare 仍按会话执行。
  return options.mcpConfigSourceRegistry
    ? options.mcpConfigSourceRegistry.acquire(sourceOptions)
    : createDynamicMcpConfigSource(sourceOptions);
}
