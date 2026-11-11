import {
  SuggestPluginInstallOutputSchema,
  type PluginActivationPort,
  type PluginActivationStatus,
  type PluginDiscoveryCandidate,
  type PluginDiscoveryPort,
  type SessionId,
} from "@zcode/contracts";
import { boundPluginLocalizedText } from "@zcode/shared/zcode-protocol-v4";
import { buildPluginReferenceCatalog } from "@zcode/core";
import {
  createConfig,
  createConfigWithPluginMigrations,
  resolvePath,
} from "@zcode/adapters/config";
import {
  isDiscoverableOfficialPlugin,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import {
  getZCodePluginsOverview,
  resolveZCodePlugins,
  installZCodeMarketplacePlugin,
  setZCodePluginEnabled,
  updateZCodePluginMarketplace,
} from "../plugins.js";
import { getCliStorageRoot, getPluginStorageRoot } from "../app/paths.js";
import { type PluginStorageLock, withPluginStorageLock } from "../lib/plugin-storage-lock.js";
import { createPluginDiscoveryPort } from "../plugin-discovery/port.js";
import { officialPluginCatalogRefresh } from "../plugin-discovery/refresh.js";
import { requestPluginSessionReload } from "./session-residency.js";
import { confirmPluginInstall } from "./plugin-install-interaction.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

const DESCRIPTION_LIMIT = 4_000;
const boundText = (value?: string) => value?.slice(0, DESCRIPTION_LIMIT);

/** 发现、安装与会话初始化使用同一 Host 身份及插件准备缓存。 */
export function createProtocolPluginDiscoveryPort(
  server: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
  sessionId: string,
  activationPort?: PluginActivationPort,
  owner?: () => ZCodeProtocolSessionRecord | undefined,
): PluginDiscoveryPort {
  const options = {
    workingDirectory: workspace.workspacePath,
    logger: server.logger,
    workspaceIdentity: workspace.workspaceIdentity,
    remoteSessionId: workspace.remoteSessionId,
    pluginDiscovery: server.deps.pluginDiscovery,
    pluginPreparation: server.deps.pluginPreparation,
  };
  function invalidate() {
    options.pluginPreparation?.invalidate();
    options.pluginDiscovery?.invalidate?.();
  }
  const storageRoot = getPluginStorageRoot(
    getCliStorageRoot(resolvePath(createConfig(options).config.storage.dir)),
  );
  async function catalog(
    pluginStorageLock?: PluginStorageLock,
  ): Promise<PluginDiscoveryCandidate[]> {
    const configResult = await createConfigWithPluginMigrations(options);
    const overview = await getZCodePluginsOverview({
      ...options,
      configResult,
      pluginStorageRoot: storageRoot,
      pluginStorageLock,
    });
    const outcome = await resolveZCodePlugins({
      ...options,
      configResult,
      pluginStorageRoot: storageRoot,
    });
    const references = buildPluginReferenceCatalog(outcome.plugins).plugins;
    const loaded = new Map(outcome.plugins.map((plugin) => [plugin.id, plugin]));
    const entries = new Map(
      [...overview.availablePlugins, ...overview.restorableBuiltins].map((entry) => [
        entry.id,
        entry,
      ]),
    );
    return [...entries.values()]
      .filter((entry) => isDiscoverableOfficialPlugin(entry.id))
      .flatMap((entry) => {
        const reference = references.find((plugin) => plugin.pluginId === entry.id);
        if (reference?.conflictingPluginIds.length) return [];
        const plugin = loaded.get(entry.id);
        if (
          outcome.plugins.some(
            (other) => other.enabled && other.name === entry.name && other.id !== entry.id,
          )
        )
          return [];
        const installed = Boolean(plugin) || entry.installed;
        const enabled = plugin?.enabled ?? false;
        const listing = entry.listing;
        return [
          {
            pluginId: entry.id,
            name: entry.name,
            displayName: listing?.displayName,
            displayNameI18n: boundPluginLocalizedText(listing?.displayNameI18n),
            description: boundText(entry.description ?? plugin?.description),
            descriptionI18n: boundPluginLocalizedText(listing?.descriptionI18n),
            category: listing?.category,
            icon: listing?.icon,
            examplePrompts: [
              ...(listing?.examplePrompts ?? []),
              ...Object.values(listing?.examplePromptsI18n ?? {}).flat(),
            ]
              .slice(0, 20)
              .map((text) => text.slice(0, 1_000)),
            installed,
            enabled,
            action: !installed
              ? ("install" as const)
              : enabled
                ? ("none" as const)
                : ("enable" as const),
            // 会话确认只授权当前工作区；用户级禁用与其他工作区覆盖保持不变。
            scope: "workspace" as const,
          },
        ];
      });
  }
  async function resolve(pluginId: string, lock?: PluginStorageLock) {
    return (await catalog(lock)).find((entry) => entry.pluginId === pluginId);
  }
  return createPluginDiscoveryPort({
    list: () => catalog(),
    resolve,
    refresh: async (request) => {
      const lastUpdated = (await getZCodePluginsOverview(options)).marketplaces.find(
        (market) => market.id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
      )?.lastUpdated;
      return officialPluginCatalogRefresh.ensure(
        storageRoot,
        lastUpdated,
        async (signal) => {
          const result = await updateZCodePluginMarketplace({
            ...options,
            pluginStorageRoot: storageRoot,
            marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
            abortSignal: signal,
          });
          invalidate();
          if (result.diagnostics.some((item) => item.severity === "error"))
            throw new Error("official_marketplace_refresh_failed");
        },
        request,
      );
    },
    confirm: (plugin, reason, context) => confirmPluginInstall(server, plugin, reason, context),
    async apply(expected, context) {
      return withPluginStorageLock(
        storageRoot,
        async (lock) => {
          context.signal.throwIfAborted();
          const current = await resolve(expected.pluginId, lock);
          if (!current) throw new Error("plugin_no_longer_available");
          if (current.action === "none") return false;
          if (current.action !== expected.action || current.scope !== expected.scope)
            throw new Error("plugin_state_changed");
          if (current.action === "install") {
            const result = await installZCodeMarketplacePlugin({
              ...options,
              pluginStorageRoot: lock.root,
              pluginStorageLock: lock,
              pluginName: current.name,
              marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
              scope: "user",
              abortSignal: context.signal,
            });
            const error = result.diagnostics.find((item) => item.severity === "error");
            if (error || result.installedPlugins.length === 0)
              throw new Error(error?.message ?? "plugin_install_empty");
            invalidate();
          }
          try {
            // 旧流程只写用户安装，工作区残留 false 会压过它；确认现在同时授权当前工作区启用。
            await setZCodePluginEnabled({
              ...options,
              pluginStorageRoot: lock.root,
              pluginStorageLock: lock,
              plugin: current.pluginId,
              abortSignal: context.signal,
              enabled: true,
              scope: current.scope,
            });
          } catch (error) {
            if (current.action !== "install") throw error;
            throw new Error(
              `Plugin is installed, but could not enable it in this workspace: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }
          invalidate();
          const installed = await resolve(current.pluginId, lock);
          if (!installed?.installed || !installed.enabled)
            throw new Error("plugin_install_verification_failed");
          return true;
        },
        undefined,
        context.signal,
      );
    },
    async activate(pluginId, context, changed) {
      // 安装落盘即登记重载；缺配置及 OAuth 不等同于安装失败。
      let status: PluginActivationStatus = "refreshRequired";
      if (changed) {
        if (activationPort)
          status = await activationPort.activate({ sessionId, pluginId, ...workspace }, context);
        else {
          const record = owner?.();
          if (record) requestPluginSessionReload(server, record);
        }
      }
      const plugin = (await resolveZCodePlugins(options)).plugins.find(
        (entry) => entry.id === pluginId,
      );
      if (plugin && !plugin.enabled) return "disabled";
      if (!plugin) return "needsConfiguration";
      if (
        plugin?.userConfig &&
        Object.entries(plugin.userConfig).some(([key, option]) => {
          const value = plugin.configuredOptions?.[key] ?? option.default;
          return option.required === true && (value === undefined || value === "");
        })
      ) {
        return "needsConfiguration";
      }
      return status;
    },
    async readSkipped() {
      const skipped = new Map<string, string | undefined>();
      const messages =
        (await server.deps.sessionStore?.messages({ sessionID: sessionId as SessionId })) ?? [];
      for (const message of messages)
        for (const part of message.parts) {
          if (
            part.type !== "tool" ||
            part.tool !== "SuggestPluginInstall" ||
            part.state.status !== "completed"
          )
            continue;
          try {
            const result = SuggestPluginInstallOutputSchema.safeParse(
              JSON.parse(part.state.output),
            );
            if (result.success && result.data.status === "skipped")
              skipped.set(result.data.pluginId, message.info.anchor?.turnId);
            else if (
              result.success &&
              ["installed", "enabled", "alreadyAvailable"].includes(result.data.status)
            )
              skipped.delete(result.data.pluginId);
          } catch {
            /* 历史工具输出可非 JSON；不可从任意正文推导安装意图。 */
          }
        }
      return skipped;
    },
  });
}
