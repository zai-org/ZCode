import type { ConfigResult } from "@zcode/adapters/config";
import type { PluginLoadOutcome } from "@zcode/contracts";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import {
  listZCodePlugins,
  setZCodePluginEnabled,
  uninstallZCodeMarketplacePlugin,
} from "../plugins.js";
import type {
  ZCodeApp,
  ZCodeAppOptions,
  ZCodePluginSetResult,
  ZCodePluginUninstallResult,
} from "./types.js";

type PluginFacade = Pick<ZCodeApp, "listPlugins" | "setPluginEnabled" | "uninstallPlugin">;

interface CreatePluginFacadeOptions {
  workspaceIdentity?: string;
  remoteSessionId?: string;
  pluginPreparation?: ZCodeAppOptions["pluginPreparation"];
  pluginDiscovery?: ZCodeAppOptions["pluginDiscovery"];
  configResult: ConfigResult;
  env?: NodeJS.ProcessEnv;
  officialPluginRoots?: string[];
  pluginStorageRoot?: string;
  workingDirectory: string;
}

function createPluginFacade(options: CreatePluginFacadeOptions): PluginFacade {
  let enabledPlugins = { ...options.configResult.config.plugins.enabledPlugins };
  // 会话内还要镜像 suppressedBuiltins：卸载内置插件后若沿用启动时的旧抑制集合，后续 list
  // 会把它重新解析出来。和 enabledPlugins 同样维护本地副本，随卸载更新。
  let suppressedBuiltins = [...options.configResult.config.plugins.suppressedBuiltins];
  const commonOptions = () => ({
    configResult: currentConfigResult(options.configResult, enabledPlugins, suppressedBuiltins),
    env: options.env,
    officialPluginRoots: options.officialPluginRoots,
    pluginStorageRoot: options.pluginStorageRoot,
    pluginPreparation: options.pluginPreparation,
    pluginDiscovery: options.pluginDiscovery,
    workspaceIdentity: options.workspaceIdentity,
    remoteSessionId: options.remoteSessionId,
    workingDirectory: options.workingDirectory,
  });

  return {
    listPlugins: async (): Promise<PluginLoadOutcome> => listZCodePlugins(commonOptions()),
    setPluginEnabled: async (plugin: string, enabled: boolean): Promise<ZCodePluginSetResult> => {
      const result = await setZCodePluginEnabled({
        ...commonOptions(),
        enabled,
        plugin,
      });
      enabledPlugins = {
        ...enabledPlugins,
        [result.plugin.id]: result.enabled,
      };
      return result;
    },
    uninstallPlugin: async (plugin: string): Promise<ZCodePluginUninstallResult> => {
      const removed = await uninstallZCodeMarketplacePlugin({
        ...commonOptions(),
        pluginId: plugin,
      });
      if (removed) {
        // 卸载会清掉 user config 里的 enabledPlugins[id]；同步本地缓存，避免后续 list 仍按旧值解析启用态。
        const next = { ...enabledPlugins };
        delete next[removed.id];
        enabledPlugins = next;
        // 内置（官方）插件卸载是写 suppressedBuiltins 标记；同步本地抑制集合，
        // 否则同一会话内后续 list 会用启动时的旧集合，把它重新解析出来。
        if (removed.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
          if (!suppressedBuiltins.includes(removed.id)) {
            suppressedBuiltins = [...suppressedBuiltins, removed.id];
          }
        }
      }
      return { removed };
    },
  };
}

export function createPluginFacadeForApp(input: {
  configResult: ConfigResult;
  options: ZCodeAppOptions;
  workingDirectory: string;
}): PluginFacade {
  return createPluginFacade({
    configResult: input.configResult,
    env: input.options.env,
    officialPluginRoots: input.options.officialPluginRoots,
    pluginStorageRoot: input.options.pluginStorageRoot,
    pluginPreparation: input.options.pluginPreparation,
    pluginDiscovery: input.options.pluginDiscovery,
    workspaceIdentity: input.options.runtimeConfig?.memory?.workspaceIdentity,
    remoteSessionId: input.options.runtimeConfig?.remoteSessionId,
    workingDirectory: input.workingDirectory,
  });
}

function currentConfigResult(
  configResult: ConfigResult,
  enabledPlugins: Record<string, boolean>,
  suppressedBuiltins: string[],
): ConfigResult {
  return {
    ...configResult,
    config: {
      ...configResult.config,
      plugins: {
        ...configResult.config.plugins,
        enabledPlugins,
        suppressedBuiltins,
      },
    },
  };
}
