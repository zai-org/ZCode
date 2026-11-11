import type { ConfigResult } from "@zcode/adapters/config";
import { discoverNodePlugins } from "@zcode/adapters/plugins";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { Logger, McpServerConfig, PluginLoadOutcome } from "@zcode/contracts";
import { resolvePluginSecretsPath, withPluginSecrets } from "../plugin-secrets.js";
import type { StartupTimer } from "../startup-logging.js";
import { resolveOfficialPluginRoots } from "./bundled-plugins.js";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS } from "./official-plugin-definitions.js";
import { getPluginStorageRoot } from "./paths.js";
import type { ZCodeAppOptions } from "./types.js";
import { filterVisualizeSkillRoots } from "./visualize-skill-gate.js";

export async function resolveStartupPlugins(input: {
  cliStorageRoot: string;
  configResult: ConfigResult;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  options: Pick<
    ZCodeAppOptions,
    | "officialPluginRoots"
    | "pluginStorageRoot"
    | "pluginPreparation"
    | "pluginDiscovery"
    | "runtimeConfig"
    | "includeVisualize"
  >;
  startupTimer: StartupTimer;
  workingDirectory: string;
}): Promise<PluginLoadOutcome> {
  const pluginStorageRoot =
    input.options.pluginStorageRoot ?? getPluginStorageRoot(input.cliStorageRoot);
  const resolve = async (): Promise<PluginLoadOutcome> => {
    // 会话运行时的 MCP 展开也要读到私有文件里的敏感值（与 resolveZCodePlugins 同一叠加）。
    const secrets = await withPluginSecrets(
      input.configResult,
      resolvePluginSecretsPath(pluginStorageRoot),
      input.logger,
    );
    const outcome = await (
      input.options.pluginDiscovery
        ? input.options.pluginDiscovery.discoverPlugins.bind(input.options.pluginDiscovery)
        : discoverNodePlugins
    )(
      {
        workspaceIdentity: input.options.runtimeConfig?.memory?.workspaceIdentity,
        remoteSessionId: input.options.runtimeConfig?.remoteSessionId,
        config: secrets.configResult.config.plugins,
        env: input.env ?? process.env,
        officialPluginRoots: await resolveOfficialPluginRoots({
          preparation: input.options.pluginPreparation,
          extraRoots: input.options.officialPluginRoots,
          logger: input.logger,
          storageRoot: pluginStorageRoot,
          suppressedBuiltins: new Set(input.configResult.config.plugins.suppressedBuiltins),
        }),
        // defaultEnabled 的 official plugin (如 skill-creator) 只有在这里
        // 把名单传给 discoverNodePlugins 才会真正默认开启。CLI 子命令路径
        // (resolveZCodePlugins) 和应用启动路径都要传，否则 `/skill skill-creator` 在会话里
        // 报 "Skill not found: skill-creator"，但 `zcode plugins list` 却显示它是 enabled。
        officialPluginsEnabledByDefault: DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
        storageRoot: pluginStorageRoot,
        workingDirectory: input.workingDirectory,
      },
      { signal: input.options.pluginPreparation?.signal },
    );
    return secrets.diagnostics.length > 0
      ? { ...outcome, diagnostics: [...outcome.diagnostics, ...secrets.diagnostics] }
      : outcome;
  };
  const pluginOutcome = await (input.options.pluginPreparation
    ? input.options.pluginPreparation.resolvePlugins(resolve)
    : resolve());
  pluginOutcome.skillRoots = filterVisualizeSkillRoots(
    pluginOutcome.skillRoots,
    input.options.includeVisualize,
  );
  input.startupTimer.mark("ZCode plugins resolved", {
    context: {
      commandRootCount: pluginOutcome.commandRoots.length,
      diagnosticCount: pluginOutcome.diagnostics.length,
      enabledPluginCount: pluginOutcome.plugins.filter((plugin) => plugin.enabled).length,
      hookCount: Object.values(pluginOutcome.hooks ?? {}).reduce(
        (sum, matchers) =>
          sum + (matchers ?? []).reduce((inner, matcher) => inner + matcher.hooks.length, 0),
        0,
      ),
      mcpServerCount: Object.keys(pluginOutcome.mcpServers).length,
      pluginCount: pluginOutcome.plugins.length,
      pluginStorageRoot,
      skillRootCount: pluginOutcome.skillRoots.length,
    },
    event: "bootstrap.app.startup.plugins.completed",
    stage: "resolve_plugins",
  });
  return pluginOutcome;
}

export function startAppStartup(input: {
  hasInjectedModelAdapter: boolean;
  resume: boolean;
  startupTimer: StartupTimer;
}): void {
  input.startupTimer.start("ZCode app startup started", {
    context: {
      hasInjectedModelAdapter: input.hasInjectedModelAdapter,
      resume: input.resume,
    },
    event: "bootstrap.app.startup.started",
    stage: "start",
  });
}

export function markConfigurationLoaded(input: {
  configResult: ConfigResult;
  startupTimer: StartupTimer;
}): void {
  input.startupTimer.mark("ZCode app configuration loaded", {
    context: {
      configSourceEnv: input.configResult.sources.env,
      configSourceProject: input.configResult.sources.project.loaded,
      configSourceUser: input.configResult.sources.user.loaded,
    },
    event: "bootstrap.app.startup.config.completed",
    stage: "load_config",
  });
}

export function markStorageAdaptersInitialized(input: {
  cliStorageRoot: string;
  hasInjectedArtifactStore: boolean;
  hasInjectedSessionStore: boolean;
  startupTimer: StartupTimer;
  storageRoot: string;
}): void {
  input.startupTimer.mark("ZCode storage adapters initialized", {
    context: {
      hasInjectedArtifactStore: input.hasInjectedArtifactStore,
      hasInjectedSessionStore: input.hasInjectedSessionStore,
      cliStorageRoot: input.cliStorageRoot,
      storageRoot: input.storageRoot,
    },
    event: "bootstrap.app.startup.storage.completed",
    stage: "initialize_storage",
  });
}

export function markMcpAdapterInitialized(input: {
  configuredMcpServers: Record<string, McpServerConfig>;
  hasInjectedMcpPort: boolean;
  mcpEnabled: boolean;
  startupTimer: StartupTimer;
  trustedMcpServerCount: number;
}): void {
  input.startupTimer.mark("ZCode MCP adapter initialized", {
    context: {
      hasInjectedMcpPort: input.hasInjectedMcpPort,
      mcpEnabled: input.mcpEnabled,
      mcpServerCount: Object.keys(input.configuredMcpServers).length,
      trustedMcpServerCount: input.trustedMcpServerCount,
    },
    event: "bootstrap.app.startup.mcp.completed",
    stage: "initialize_mcp",
  });
}

export function markRuntimeConstructed(input: {
  hasInjectedModelAdapter: boolean;
  sessionId: string;
  startupTimer: StartupTimer;
}): void {
  input.startupTimer.mark("ZCode runtime constructed", {
    context: {
      hasInjectedModelAdapter: input.hasInjectedModelAdapter,
      sessionId: input.sessionId,
    },
    event: "bootstrap.app.startup.runtime.completed",
    stage: "create_runtime",
  });
}

export function completeAppStartup(input: {
  sessionId: string;
  startupTimer: StartupTimer;
  workingDirectory: string;
}): void {
  input.startupTimer.complete("ZCode app startup completed", {
    context: {
      sessionId: input.sessionId,
      workingDirectory: input.workingDirectory,
    },
    event: "bootstrap.app.startup.completed",
    stage: "total",
  });
}

export function debugRuntimeConfigResolved(input: {
  configResult: ConfigResult;
  logger: Logger;
  runtimeConfig: AgentRuntimeConfig;
}): void {
  input.logger.debug("Runtime config resolved", {
    mode: input.runtimeConfig.mode,
    module: "bootstrap",
    permissionAllowedToolCount: input.configResult.config.permission.allowedTools.length,
    permissionDisallowedToolCount: input.configResult.config.permission.disallowedTools.length,
    permissionSourceEnv: input.configResult.sources.env,
    permissionSourceUserConfig: input.configResult.sources.user.loaded,
  });
}
