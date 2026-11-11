import {
  SettingsScopeDeviceProvider,
  SettingsScopeBlockedNotice,
  resolveSettingsScopeBlock,
  useSettingsScope,
} from "@/settings-scope/index.js";
/* eslint-disable max-lines -- 共享能力外壳聚合 Scope，并承载 Plugin tabs 与独立 Commands 入口。 */
import { PluginAddMenu } from "@/conversation-workspace-target/PluginAddMenu.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Monitor, Plus, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmExtensionEnable } from "@/extension-slots/index.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { TID_PLUGIN_STORE_BROWSE } from "@zcode/shared/test-ids";
import type { ZCodePluginInfo, ZCodePluginScope, ZCodePluginUserConfigOption } from "@zcode/shared";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import type { IServiceAccessor } from "@zcode/services";
import { useConfigWorkspaceServicesResolution as useWorkspaceServicesResolution } from "@/workspace-config-catalog/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { McpSettingsSection } from "@/settings/McpSettingsSection.js";
import { SkillsSection } from "@/settings/SkillsSection.js";
import { CommandsSection } from "@/settings/CommandsSection.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { PluginUninstallConfirmDialog } from "@/settings/PluginUninstallConfirmDialog.js";
import { PluginInstallEmptyState, PluginLoadingState } from "@/settings/PluginInstallEmptyState.js";
import {
  PluginDetailRow,
  PluginHookDetails,
  PluginWarningList,
} from "@/settings/InstalledPluginManagement.js";
import { PluginConfigControls } from "@/settings/PluginConfigControls.js";
import {
  PluginStoreAdvancedSection,
  PluginStoreDetailView,
} from "@/settings/PluginStoreDetailView.js";
import {
  PluginStoreCard,
  PluginUpdateAllButton,
  type PluginStoreActions,
} from "@/settings/PluginStoreCard.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import {
  buildPluginConfigPatch,
  type PluginOptionDraftValue,
} from "@/settings/pluginConfigPatch.js";
import {
  buildPluginStoreTryMention,
  buildPluginStoreTryPrompt,
} from "@/settings/pluginStoreTryPrompt.js";
import { usePluginUninstall } from "@/settings/usePluginUninstall.js";
import {
  buildStoreItems,
  type StorePluginItem,
  resolveManagedPluginDisplay,
  needsPluginUpdate,
  resolvePluginDisplayName,
  updatePluginsSerially,
} from "@/settings/pluginStoreListing.js";
import { useScopedPluginManagementStore } from "@/store/pluginManagementStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";
import {
  filterPluginsByQuery,
  partitionPluginsForSettings,
  selectBuiltInPlugins,
  selectPluginsForScope,
} from "@/settings/pluginCapabilityProjection.js";
import {
  isComputerUseRemoteOrLinux,
  matchesComputerUseSearch,
  resolveComputerUseAvailability,
} from "@/settings/computerUseAvailability.js";
import { PluginScopeMenu, getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import {
  formatRemoteSyncTargetLabel,
  shouldShowRemoteSyncActions,
  useSettingsDataSyncEntry,
} from "@/data-sync/index.js";

type PluginTabTarget = "plugins" | "mcps" | "skills" | "commands";
type PluginTab = Exclude<PluginTabTarget, "commands">;

function normalizePluginTab(tab: PluginTabTarget): PluginTab {
  return tab === "commands" ? "plugins" : tab;
}

function getPluginTabCountClass(tab: PluginTabTarget, selectedTab: PluginTabTarget): string {
  return tab === selectedTab
    ? "text-ui-sm text-foreground-subtle"
    : "text-ui-sm text-foreground-subtlest";
}

type PluginScope =
  | { kind: "user"; key: "user" }
  | { kind: "workspace"; key: string; tab: ConfigWorkspaceTarget };

interface PluginsSectionProps {
  onScopeChange?: (scopeKey: string) => void;
  onOpenUi?: (
    item: StorePluginItem,
    target: ConfigWorkspaceTarget | null,
    enable?: () => Promise<boolean>,
  ) => void;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isWebRemoteControl?: boolean;
  initialTab?: PluginTabTarget;
  initialScopeKey?: string;
  mode?: "plugin" | "market" | "mcp" | "skill" | "command";
  workspacePath?: string | null;
  workspaceIdentity?: string;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenPluginStore: (returnScopeKey?: string, intent?: "add-marketplace") => void;
  showMarketplaceBreadcrumb?: boolean;
}

function workspaceKey(tab: ConfigWorkspaceTarget): string {
  return getPluginWorkspaceKey(tab);
}

function PluginList({
  inMarketplace = false,
  onOpenUi,
  target,
  configScope,
  searchQuery,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  isWebRemoteControl,
  onAdd,
  onCreateTask,
  onDetailOpenChange,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
  onVisibleCountChange,
  dataSyncSourceServerId,
  unscopedServices,
  cacheAuthorityKey,
}: {
  inMarketplace?: boolean;
  onOpenUi?: PluginsSectionProps["onOpenUi"];
  target: ConfigWorkspaceTarget | null;
  configScope: ZCodePluginScope;
  searchQuery: string;
  isDesktop: boolean;
  isMacDesktop: boolean;
  isWindowsDesktop: boolean;
  isWebRemoteControl: boolean;
  onAdd?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onDetailOpenChange?: (open: boolean) => void;
  onOpenPluginStore: (returnScopeKey?: string, intent?: "add-marketplace") => void;
  showMarketplaceBreadcrumb?: boolean;
  onVisibleCountChange?: (count: number) => void;
  /** Scope 选中在线远端设备的「用户」时为该设备；同步按钮只在此时显示。 */
  dataSyncSourceServerId?: string | null;
  unscopedServices?: IServiceAccessor;
  cacheAuthorityKey?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  // 「用户」由 Scope 显式给出服务（本机 base / 远端 source-settings），不按路径推断 Host：
  // 本机项目路径可能与远程 tab 路径相同，推断会把本机「用户」路由到远端。
  const targetServiceResolution = useWorkspaceServicesResolution(
    target?.workspacePath,
    target?.remoteSessionId,
    target?.workspaceIdentity,
    target?.remoteTarget,
    { unscopedServices, forceUnscoped: Boolean(cacheAuthorityKey || unscopedServices) },
  );
  // Scope 可选择非激活 workspace，若继续从当前 ServiceProvider 取服务，
  // 会把 B 的路径发往 A 的 host。插件读写必须和 Scope target 共用同一服务解析结果。
  const { pluginManagementService } = targetServiceResolution.services;
  const usePluginManagementStore = useScopedPluginManagementStore(pluginManagementService);
  const plugins = usePluginManagementStore((state) => state.plugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const marketplaces = usePluginManagementStore((state) => state.marketplaces);
  const marketplaceAvailabilityKnown = usePluginManagementStore(
    (state) => state.marketplaceAvailabilityKnown,
  );
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const restorableBuiltins = usePluginManagementStore((state) => state.restorableBuiltins);
  const loading = usePluginManagementStore((state) => state.loading);
  const pluginDiagnostics = usePluginManagementStore((state) => state.diagnostics);
  const currentWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const currentWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const initialize = usePluginManagementStore((state) => state.initialize);
  const setEnabled = usePluginManagementStore((state) => state.setEnabled);
  const updatePlugin = usePluginManagementStore((state) => state.updatePlugin);
  const configurePlugin = usePluginManagementStore((state) => state.configurePlugin);
  const currentAuthorityKey = usePluginManagementStore((state) => state.authorityKey);
  const currentConfigScope = usePluginManagementStore((state) => state.configScope);
  const resetPluginConfig = usePluginManagementStore((state) => state.resetPluginConfig);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const activeOperations = usePluginManagementStore((state) => state.activeOperations);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [pluginOptionsDrafts, setPluginOptionsDrafts] = useState<
    Record<string, Record<string, PluginOptionDraftValue>>
  >({});
  // 设置页重构后只保留了 Plugin 管理列表，漏掉了旧版插件页的远端同步入口。
  // 同步目标必须沿用当前 Scope 的 target services，不能回退到激活 workspace 的 host。
  const connectedRemoteSyncTarget =
    targetServiceResolution.rpcReady &&
    shouldShowRemoteSyncActions({
      remoteSessionId: target?.remoteSessionId,
      remoteTarget: target?.remoteTarget,
      isWebRemoteControl,
    }) &&
    target?.workspacePath
      ? target.remoteTarget
      : null;
  // 设置页重构时只迁移了插件远程同步操作，遗漏了当前远端工作区提示，
  // 用户无法确认插件列表实际对应的是哪个远程目标。
  const remotePluginSyncTargetLabel = connectedRemoteSyncTarget
    ? formatRemoteSyncTargetLabel(connectedRemoteSyncTarget, target?.workspacePath ?? "")
    : "";
  const targetKey = target ? workspaceKey(target) : "";
  const storeKey = currentWorkspaceIdentity?.trim() || currentWorkspacePath || "";
  const storeMatchesTarget =
    storeKey === targetKey &&
    currentAuthorityKey === (cacheAuthorityKey?.trim() || null) &&
    currentConfigScope === configScope;
  const storeItemById = useMemo(
    () =>
      new Map(
        buildStoreItems({
          marketplaces,
          marketplaceAvailabilityKnown,
          availablePlugins,
          installedPlugins,
          plugins,
          restorableBuiltins,
        }).map((item) => [item.id, item]),
      ),
    [
      availablePlugins,
      installedPlugins,
      marketplaceAvailabilityKnown,
      marketplaces,
      plugins,
      restorableBuiltins,
    ],
  );
  const visiblePlugins = useMemo(() => {
    if (!storeMatchesTarget) return [];
    return filterPluginsByQuery(
      selectPluginsForScope(plugins, installedPlugins, configScope),
      searchQuery,
      storeItemById,
      locale,
    );
  }, [
    configScope,
    installedPlugins,
    locale,
    plugins,
    searchQuery,
    storeItemById,
    storeMatchesTarget,
  ]);
  const scopedPlugins = useMemo(
    () => (storeMatchesTarget ? selectPluginsForScope(plugins, installedPlugins, configScope) : []),
    [configScope, installedPlugins, plugins, storeMatchesTarget],
  );
  const builtInPluginIds = useMemo(
    () => new Set(selectBuiltInPlugins(plugins, installedPlugins).map((plugin) => plugin.id)),
    [installedPlugins, plugins],
  );
  const visiblePluginGroups = useMemo(
    () => partitionPluginsForSettings(visiblePlugins, builtInPluginIds),
    [builtInPluginIds, visiblePlugins],
  );
  const scopedPluginGroups = useMemo(
    () => partitionPluginsForSettings(scopedPlugins, builtInPluginIds),
    [builtInPluginIds, scopedPlugins],
  );
  const visibleBuiltInPlugins = visiblePluginGroups.builtIn;
  const visibleInstalledPlugins = visiblePluginGroups.installed;
  const installedPluginCount = scopedPluginGroups.installed.length;
  const computerUseAvailability = resolveComputerUseAvailability({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    remoteSessionId: target?.remoteSessionId,
    remoteTarget: target?.remoteTarget,
    workspaceIdentity: target?.workspaceIdentity,
  });
  const showUnavailableComputerUse = Boolean(
    configScope === "user" &&
    target &&
    !loading &&
    isComputerUseRemoteOrLinux(computerUseAvailability) &&
    matchesComputerUseSearch(searchQuery),
  );
  const hasEmptySearchResult = Boolean(
    target &&
    !loading &&
    searchQuery.trim() &&
    visibleInstalledPlugins.length === 0 &&
    visibleBuiltInPlugins.length === 0 &&
    !showUnavailableComputerUse,
  );
  const hideInstalledGroup = Boolean(searchQuery.trim() && visibleInstalledPlugins.length === 0);
  useEffect(() => {
    onVisibleCountChange?.(visibleInstalledPlugins.length + visibleBuiltInPlugins.length);
  }, [onVisibleCountChange, visibleBuiltInPlugins.length, visibleInstalledPlugins.length]);
  const refreshAfterPluginChange = useCallback(async () => {
    if (!target || !targetServiceResolution.rpcReady) return;
    await initialize({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      authorityKey: cacheAuthorityKey,
      configScope,
      pluginService: pluginManagementService,
    });
  }, [
    initialize,
    cacheAuthorityKey,
    configScope,
    pluginManagementService,
    target,
    targetServiceResolution.rpcReady,
  ]);
  // 同步按钮打开数据同步弹窗的插件分类；设置页入口不传 workspace 映射。推送后刷新本页插件列表。
  const dataSync = useSettingsDataSyncEntry({
    category: "plugins",
    sourceServerId: dataSyncSourceServerId,
    onPushFinished: refreshAfterPluginChange,
  });
  // 启用确认（docs/plugins/extension-host.md §17.7）：只看本机 user 层的启用。扩展只认 user 层（§13），
  // 远程目标的插件不在本机扩展进程里运行。是否需要确认由 Window Host 判断（已有扩展持有会话权限、
  // 且这个插件带扩展代码）。
  const confirmExtensionEnable = useConfirmExtensionEnable();
  const extensionEnableApplies =
    configScope === "user" && !target?.remoteTarget && !target?.remoteSessionId;
  const confirmEnable = useCallback(
    (pluginId: string, pluginLabel: string) =>
      extensionEnableApplies
        ? confirmExtensionEnable(pluginId, pluginLabel)
        : Promise.resolve(true),
    [confirmExtensionEnable, extensionEnableApplies],
  );
  const handleSetEnabled = useCallback(
    async (pluginId: string, enabled: boolean) => {
      const plugin = plugins.find((candidate) => candidate.id === pluginId);
      const pluginLabel = plugin
        ? resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale).name
        : pluginId;
      if (enabled && !(await confirmEnable(pluginId, pluginLabel))) return;
      const succeeded = await setEnabled(pluginId, enabled, pluginManagementService, configScope);
      if (!succeeded) {
        toast(
          usePluginManagementStore.getState().error ??
            intl.formatMessage({ id: "settings.plugins.toggle.failed" }, { plugin: pluginLabel }),
          { variant: "warning" },
        );
        return;
      }
      const messageId =
        configScope === "workspace"
          ? enabled
            ? "settings.plugins.toggle.workspaceEnabled"
            : "settings.plugins.toggle.workspaceDisabled"
          : enabled
            ? "settings.plugins.toggle.enabled"
            : "settings.plugins.toggle.disabled";
      toast(intl.formatMessage({ id: messageId }, { plugin: pluginLabel }));
    },
    [
      configScope,
      confirmEnable,
      intl,
      locale,
      pluginManagementService,
      plugins,
      setEnabled,
      storeItemById,
    ],
  );
  const handleResetPluginConfig = useCallback(
    async (pluginId: string) => {
      const plugin = plugins.find((candidate) => candidate.id === pluginId);
      const pluginLabel = plugin
        ? resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale).name
        : pluginId;
      const restored = await resetPluginConfig(pluginId, pluginManagementService, "workspace");
      if (!restored) {
        toast(
          usePluginManagementStore.getState().error ??
            intl.formatMessage({ id: "settings.plugins.toggle.failed" }, { plugin: pluginLabel }),
          { variant: "warning" },
        );
        return;
      }
      toast(intl.formatMessage({ id: "settings.plugins.scope.restored" }, { plugin: pluginLabel }));
    },
    [intl, locale, pluginManagementService, plugins, resetPluginConfig, storeItemById],
  );
  const uninstall = usePluginUninstall({
    store: usePluginManagementStore,
    pluginService: pluginManagementService,
    installedPlugins,
    plugins,
    activeOperations,
    onAfterUninstall: refreshAfterPluginChange,
  });
  const handleUpdatePlugin = useCallback(
    async (pluginId: string) => {
      await updatePlugin(pluginId, pluginManagementService);
      if (usePluginManagementStore.getState().error) return;
      await refreshAfterPluginChange();
    },
    [pluginManagementService, refreshAfterPluginChange, updatePlugin],
  );
  const [updatingAll, setUpdatingAll] = useState(false);
  const updateAllAbortRef = useRef<AbortController | null>(null);
  // 服务替换后旧 store 的字段不会变化；提交新上下文或卸载时使旧批次永久失效，防止继续写旧目标。
  useLayoutEffect(
    () => () => updateAllAbortRef.current?.abort(),
    [
      usePluginManagementStore,
      targetKey,
      cacheAuthorityKey,
      configScope,
      targetServiceResolution.rpcReady,
    ],
  );
  // 「全部更新」与已安装、内置分组的展示顺序一致，且不受搜索过滤影响。
  const updateAllItems = useMemo(
    () =>
      [...scopedPluginGroups.installed, ...scopedPluginGroups.builtIn].flatMap((plugin) => {
        const item = storeItemById.get(plugin.id);
        return item ? [item] : [];
      }),
    [scopedPluginGroups, storeItemById],
  );
  const handleUpdateAll = useCallback(
    async (pluginIds: string[]) => {
      // 批量期间切换 Scope 时，store 会被新 Scope 重新 initialize；以点击时的 store 上下文为准，
      // 变化即中止。结尾不再调用 refreshAfterPluginChange：每次 updatePlugin 已按当前上下文重载，
      // 旧闭包再 initialize 会把 store 写回旧 Scope，导致列表变空。
      const contextKey = (state: ReturnType<typeof usePluginManagementStore.getState>) =>
        [state.workspacePath, state.workspaceIdentity, state.authorityKey, state.configScope].join(
          "\0",
        );
      const startKey = contextKey(usePluginManagementStore.getState());
      const batch = new AbortController();
      updateAllAbortRef.current = batch;
      setUpdatingAll(true);
      try {
        const { succeeded, failed, aborted } = await updatePluginsSerially(
          pluginIds,
          (pluginId) => updatePlugin(pluginId, pluginManagementService),
          {
            isCurrent: () =>
              !batch.signal.aborted && contextKey(usePluginManagementStore.getState()) === startKey,
            // 行内已更新或正在更新的插件不再重复调用 plugins/update。
            needsUpdate: (pluginId) =>
              needsPluginUpdate(usePluginManagementStore.getState(), pluginId),
          },
        );
        if (aborted) {
          toast(
            intl.formatMessage(
              { id: "settings.plugins.updateAll.aborted" },
              { count: String(succeeded.length) },
            ),
          );
          return;
        }
        toast(
          failed.length === 0
            ? intl.formatMessage(
                { id: "settings.plugins.updateAll.done" },
                { count: String(succeeded.length) },
              )
            : intl.formatMessage(
                { id: "settings.plugins.updateAll.partial" },
                {
                  succeeded: String(succeeded.length),
                  failed: String(failed.length),
                  plugins: failed
                    .map((pluginId) =>
                      resolvePluginDisplayName(
                        storeItemById.get(pluginId) ?? { name: pluginId },
                        locale,
                      ),
                    )
                    .join(", "),
                },
              ),
          failed.length === 0 ? undefined : { variant: "warning" },
        );
      } finally {
        setUpdatingAll(false);
      }
    },
    [intl, locale, pluginManagementService, storeItemById, updatePlugin, usePluginManagementStore],
  );
  const selectedPlugin = plugins.find((plugin) => plugin.id === selectedPluginId) ?? null;
  // 插件自身 warning 诊断（如声明的技能路径扫描为空）：详情高级区展示，避免静默失败。
  const pluginWarningsForSelected = selectedPlugin
    ? pluginDiagnostics.filter(
        (diagnostic) =>
          diagnostic.pluginId === selectedPlugin.id && diagnostic.severity === "warning",
      )
    : [];
  const selectedStoreItem = selectedPluginId ? storeItemById.get(selectedPluginId) : undefined;
  const closeDetail = useCallback(() => {
    setSelectedPluginId(null);
    onDetailOpenChange?.(false);
  }, [onDetailOpenChange]);
  useEffect(() => {
    closeDetail();
  }, [closeDetail, targetKey]);
  useEffect(() => {
    if (selectedPluginId && !selectedPlugin) closeDetail();
  }, [closeDetail, selectedPlugin, selectedPluginId]);
  const setPluginOptionDraft = (
    pluginId: string,
    key: string,
    value: string | number | boolean,
  ) => {
    setPluginOptionsDrafts((current) => ({
      ...current,
      [pluginId]: { ...current[pluginId], [key]: value },
    }));
  };
  const getPluginOptionValue = (
    plugin: ZCodePluginInfo,
    key: string,
    option: ZCodePluginUserConfigOption,
  ): string | number | boolean => {
    const draft = pluginOptionsDrafts[plugin.id]?.[key];
    if (draft === null) return "";
    return (
      draft ??
      plugin.configuredOptions?.[key] ??
      option.default ??
      (option.type === "boolean" ? false : "")
    );
  };
  const savePluginOptions = async (plugin: ZCodePluginInfo) => {
    const { options, clearOptionKeys } = buildPluginConfigPatch(
      plugin,
      pluginOptionsDrafts[plugin.id] ?? {},
    );
    // 没有显式修改时不写入空的 Workspace 配置，避免无操作保存制造配置足迹。
    if (Object.keys(options).length === 0 && clearOptionKeys.length === 0) return;
    const configured = await configurePlugin(
      plugin.id,
      options,
      pluginManagementService,
      configScope,
      clearOptionKeys,
    );
    // 保存失败时保留用户输入和敏感字段清除意图，避免 RPC 错误后 UI 看起来像已提交。
    if (!configured) return;
    setPluginOptionsDrafts((current) => {
      const next = { ...current };
      delete next[plugin.id];
      return next;
    });
  };
  const actions: PluginStoreActions = useMemo(
    () => ({
      onOpenDetail: (pluginId) => {
        setSelectedPluginId(pluginId);
        onDetailOpenChange?.(true);
      },
      onOpenUi: onOpenUi
        ? (item) =>
            onOpenUi(
              item,
              target,
              item.info?.enabled
                ? undefined
                : async () =>
                    (await confirmEnable(item.id, resolvePluginDisplayName(item, locale))) &&
                    setEnabled(item.id, true, pluginManagementService, configScope),
            )
        : undefined,
      onInstall: () => onOpenPluginStore(),
      onUninstall: uninstall.requestUninstall,
      onSetEnabled: (pluginId, enabled) => void handleSetEnabled(pluginId, enabled),
      onResetConfig:
        configScope === "workspace"
          ? (pluginId) => void handleResetPluginConfig(pluginId)
          : undefined,
      onUpdate: (pluginId) => void handleUpdatePlugin(pluginId),
      activeOperations,
      togglingPluginId,
    }),
    [
      configScope,
      handleResetPluginConfig,
      handleSetEnabled,
      handleUpdatePlugin,
      onDetailOpenChange,
      onOpenPluginStore,
      activeOperations,
      togglingPluginId,
      uninstall.requestUninstall,
      onOpenUi,
      target,
      setEnabled,
      pluginManagementService,
      confirmEnable,
      locale,
    ],
  );
  useEffect(() => {
    if (!target || !targetServiceResolution.rpcReady) return;
    void initialize({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      authorityKey: cacheAuthorityKey,
      configScope,
      pluginService: pluginManagementService,
    });
  }, [
    initialize,
    cacheAuthorityKey,
    configScope,
    pluginManagementService,
    target,
    targetServiceResolution.rpcReady,
  ]);

  const renderPluginRows = (items: ZCodePluginInfo[]) => (
    <div className="grid grid-cols-1 gap-y-1">
      {items.map((plugin) => (
        <div key={plugin.id} data-testid="plugin-settings-plugin-row" data-plugin-id={plugin.id}>
          {/* 共用市场卡片，避免管理列表额外标签行和图标尺寸导致两处行高不一致。 */}
          <PluginStoreCard
            management
            item={
              storeItemById.get(plugin.id) ?? {
                id: plugin.id,
                name: plugin.name,
                marketplace: "",
                installed: true,
                restorable: false,
                orphaned: false,
                info: plugin,
              }
            }
            actions={actions}
            locale={locale}
          />
        </div>
      ))}
    </div>
  );

  const renderUnavailableComputerUse = () => (
    <div className="overflow-hidden rounded-xl bg-surface">
      <div className="flex min-w-0 items-center gap-3 px-4 py-3 text-foreground-subtle">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-foreground-subtle">
          <Monitor className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.computerUse.title" })}
          </div>
          <div className="mt-0.5 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({
              id:
                computerUseAvailability.kind === "local-linux"
                  ? "settings.computerUse.unsupported.linuxDescription"
                  : "settings.computerUse.unsupported.remoteDescription",
            })}
          </div>
        </div>
        <span className="shrink-0 rounded-md bg-background px-2 py-1 text-ui-xs font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.computerUse.unsupported.badge" })}
        </span>
      </div>
    </div>
  );

  if (selectedPlugin && selectedStoreItem && targetServiceResolution.rpcReady) {
    const pluginBreadcrumbLabel = resolvePluginDisplayName(selectedStoreItem, locale);
    const pluginsBreadcrumbLabel = intl.formatMessage({ id: "settings.plugins.title" });
    // Plugin 不打开仅含管理字段的简化弹窗：那会与插件商店详情形成两套内容模型，
    // 导致介绍、Hero、示例提示词与能力清单缺失。这里直接复用权威商店详情页，只注入已安装态高级配置。
    return (
      <section className="space-y-5">
        <Button variant="ghost" data-testid="plugin-settings-detail-back" onClick={closeDetail}>
          {intl.formatMessage({ id: "common.back" })}
        </Button>
        {!inMarketplace ? (
          <SettingsBreadcrumbReporter
            items={
              showMarketplaceBreadcrumb
                ? [
                    { label: pluginsBreadcrumbLabel, onSelect: closeDetail },
                    { label: pluginBreadcrumbLabel },
                  ]
                : [{ label: pluginBreadcrumbLabel }]
            }
            onSectionSelect={showMarketplaceBreadcrumb ? onOpenPluginStore : closeDetail}
          />
        ) : null}
        <PluginStoreDetailView
          item={selectedStoreItem}
          actions={actions}
          onRetryDescribe={() => {}}
          onUsePrompt={(item, prompt) => {
            if (!onCreateTask) return;
            onCreateTask({
              initialPrompt: buildPluginStoreTryPrompt({
                item,
                locale,
                prompt,
              }),
              initialPromptMention: buildPluginStoreTryMention({
                item,
                locale,
              }),
            });
          }}
          advanced={
            selectedPlugin.packageStatus === "missing" ? undefined : (
              <PluginStoreAdvancedSection>
                {pluginWarningsForSelected.length > 0 ? (
                  <div>
                    <div className="mb-2 text-ui-xs font-medium text-foreground">
                      {intl.formatMessage({ id: "settings.plugins.detail.warnings" })}
                    </div>
                    <PluginWarningList warnings={pluginWarningsForSelected} />
                  </div>
                ) : null}
                <PluginDetailRow
                  label={intl.formatMessage({
                    id: "settings.plugins.detail.rootPath",
                  })}
                  value={selectedPlugin.rootPath}
                />
                {(selectedPlugin.hookDetails ?? []).length > 0 ? (
                  <PluginHookDetails hooks={selectedPlugin.hookDetails ?? []} />
                ) : null}
                <PluginConfigControls
                  getValue={getPluginOptionValue}
                  isOptionClearPending={(pluginId, key) =>
                    pluginOptionsDrafts[pluginId]?.[key] === null
                  }
                  onClearOption={(pluginId, key, clear) =>
                    setPluginOptionsDrafts((current) => {
                      const nextPluginDrafts = { ...current[pluginId] };
                      if (clear) nextPluginDrafts[key] = null;
                      else delete nextPluginDrafts[key];
                      return {
                        ...current,
                        [pluginId]: nextPluginDrafts,
                      };
                    })
                  }
                  onSave={(plugin) => void savePluginOptions(plugin)}
                  onSetDraft={setPluginOptionDraft}
                  activeOperations={activeOperations}
                  plugin={selectedPlugin}
                  scope={configScope}
                />
              </PluginStoreAdvancedSection>
            )
          }
        />
        <PluginUninstallConfirmDialog
          open={uninstall.pendingPlugin !== null}
          pluginName={
            uninstall.pendingPlugin
              ? resolvePluginDisplayName(
                  storeItemById.get(uninstall.pendingPlugin.id) ?? {
                    name: uninstall.pendingPlugin.name,
                  },
                  locale,
                )
              : ""
          }
          pending={uninstall.uninstalling}
          onCancel={uninstall.cancelUninstall}
          onConfirm={() => void uninstall.confirmUninstall()}
        />
      </section>
    );
  }

  return (
    <section className="space-y-6" aria-labelledby="plugin-installed-title">
      {hasEmptySearchResult ? (
        <EmptyState
          message={intl.formatMessage({
            id: "settings.plugin.plugins.empty",
          })}
        />
      ) : null}
      <div className={hideInstalledGroup ? "hidden" : "space-y-4"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3
            id="plugin-installed-title"
            className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground"
          >
            {intl.formatMessage({ id: "settings.plugin.plugins.installed" })}
            <span className="text-ui-sm font-normal text-foreground-subtle">
              {visibleInstalledPlugins.length}
            </span>
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {dataSync.visible ? (
              <ControlHintTooltip
                title={intl.formatMessage({
                  id: "settings.plugins.remoteSync.open",
                })}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="icon-md"
                  data-testid="data-sync-entry-plugins"
                  disabled={dataSync.disabled}
                  aria-label={intl.formatMessage({
                    id: "settings.plugins.remoteSync.open",
                  })}
                  onClick={dataSync.open}
                >
                  <UploadCloud className="size-3.5" aria-hidden="true" />
                </Button>
              </ControlHintTooltip>
            ) : null}
            <PluginUpdateAllButton
              items={updateAllItems}
              actions={actions}
              pending={updatingAll}
              onUpdateAll={(pluginIds) => void handleUpdateAll(pluginIds)}
            />
            <SettingsResourceHeaderActions onRefresh={() => void refreshAfterPluginChange()} />
            {configScope === "user" && onAdd ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  data-testid={TID_PLUGIN_STORE_BROWSE}
                  onClick={onAdd}
                >
                  {intl.formatMessage({ id: "chat.plugins.browseMarketplace" })}
                </Button>
                <PluginAddMenu
                  testId="plugin-settings-add"
                  onCreateTask={onCreateTask}
                  isWebRemoteControl={isWebRemoteControl}
                  onAddMarketplace={() => onOpenPluginStore(undefined, "add-marketplace")}
                />
              </>
            ) : null}
          </div>
        </div>
        {configScope === "workspace" && target ? (
          <div
            className="rounded-lg border border-border bg-card px-3 py-2 text-ui-sm text-foreground-subtle"
            data-testid="plugin-settings-workspace-scope-hint"
          >
            {intl.formatMessage({ id: "settings.plugins.scope.workspaceHint" })}
          </div>
        ) : null}
        {connectedRemoteSyncTarget ? (
          <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.plugins.remoteContext" },
              { target: remotePluginSyncTargetLabel },
            )}
          </div>
        ) : null}
        {!target ? (
          <EmptyState
            message={intl.formatMessage({
              id: "settings.plugin.noWorkspace",
            })}
          />
        ) : !targetServiceResolution.rpcReady ? (
          <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
        ) : loading && visiblePlugins.length === 0 ? (
          <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
        ) : visibleInstalledPlugins.length > 0 ? (
          renderPluginRows(visibleInstalledPlugins)
        ) : installedPluginCount === 0 && !showUnavailableComputerUse ? (
          <PluginInstallEmptyState
            title={intl.formatMessage({
              id: "settings.plugin.plugins.emptyInstalledTitle",
            })}
            description={intl.formatMessage({
              id: "settings.plugin.plugins.emptyInstalledDescription",
            })}
            actions={
              onAdd ? (
                <Button type="button" variant="default" size="lg" onClick={onAdd}>
                  <Plus aria-hidden="true" data-icon="inline-start" />
                  {intl.formatMessage({
                    id: "chat.plugins.browseMarketplace",
                  })}
                </Button>
              ) : undefined
            }
          />
        ) : null}
      </div>
      {!hasEmptySearchResult && visibleBuiltInPlugins.length > 0 ? (
        <div className="space-y-4">
          <h3 className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.plugin.plugins.builtIn" })}
            <span className="text-ui-sm font-normal text-foreground-subtle">
              {visibleBuiltInPlugins.length}
            </span>
          </h3>
          {renderPluginRows(visibleBuiltInPlugins)}
        </div>
      ) : null}
      {showUnavailableComputerUse ? (
        <div className="space-y-4">
          <h3 className="flex h-7 items-center text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.computerUse.unsupported.group" })}
          </h3>
          {renderUnavailableComputerUse()}
        </div>
      ) : null}
      <PluginUninstallConfirmDialog
        open={uninstall.pendingPlugin !== null}
        pluginName={
          uninstall.pendingPlugin
            ? resolvePluginDisplayName(
                storeItemById.get(uninstall.pendingPlugin.id) ?? {
                  name: uninstall.pendingPlugin.name,
                },
                locale,
              )
            : ""
        }
        pending={uninstall.uninstalling}
        onCancel={uninstall.cancelUninstall}
        onConfirm={() => void uninstall.confirmUninstall()}
      />
      {dataSync.dialog}
    </section>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-ui-base text-foreground-subtle">
      {message}
    </div>
  );
}

export function PluginsSection({
  onScopeChange,
  onOpenUi,
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  isWebRemoteControl = false,
  initialTab = "plugins",
  initialScopeKey,
  mode = "plugin",
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
}: PluginsSectionProps) {
  const { intl } = useZCodeIntl();
  const storeActiveWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const storeActiveWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activeWorkspacePath = workspacePath ?? storeActiveWorkspacePath;
  const activeWorkspaceIdentity = workspaceIdentity ?? storeActiveWorkspaceIdentity ?? undefined;
  const handleScopeFallback = useCallback(() => {
    // 市场返回记录的是具体 workspace identity；目标已关闭或断连时，
    // 静默选中 User 会让用户误以为 Workspace 配置仍在展示，因此提示并显式切换。
    toast(intl.formatMessage({ id: "settings.plugin.scopeUnavailableFallback" }));
  }, [intl]);
  // Scope 状态唯一 owner：按设备分组、默认选中当前 workspace 所在设备的「用户」，
  // 远端「用户」经该设备的 source-settings attachment 读写，离线时 fail-closed。
  const scope = useSettingsScope({
    workspacePath: activeWorkspacePath,
    workspaceIdentity: activeWorkspaceIdentity,
    initialScopeKey,
    onFallback: handleScopeFallback,
  });
  const selectedScopeKey = scope.selectedScopeKey;
  useEffect(() => {
    onScopeChange?.(selectedScopeKey);
  }, [onScopeChange, selectedScopeKey]);
  // 分区与表单只看到选中设备的项目；设备内「用户」统一写作 "user"。
  const workspaceTabs = scope.deviceTargets;
  const localScopeKey = scope.toLocalScopeKey(selectedScopeKey);
  const userScope = scope.user;
  const userScopeTarget = userScope.status === "ready" ? userScope.target : null;
  const userScopeServices = userScope.status === "ready" ? userScope.unscopedServices : undefined;
  const userScopeAuthorityKey =
    userScope.status === "ready" ? userScope.cacheAuthorityKey : undefined;
  const fixedTab: PluginTabTarget | null =
    mode === "market"
      ? "plugins"
      : mode === "mcp"
        ? "mcps"
        : mode === "skill"
          ? "skills"
          : mode === "command"
            ? "commands"
            : null;
  const [interactiveTab, setInteractiveTab] = useState<PluginTab>(() =>
    normalizePluginTab(initialTab),
  );
  useEffect(() => setInteractiveTab(normalizePluginTab(initialTab)), [initialTab]);
  const selectedTab = fixedTab ?? interactiveTab;
  const [searchQueries, setSearchQueries] = useState<Record<PluginTabTarget, string>>({
    plugins: "",
    mcps: "",
    skills: "",
    commands: "",
  });
  const [capabilityCounts, setCapabilityCounts] = useState<Record<PluginTabTarget, number>>({
    plugins: 0,
    mcps: 0,
    skills: 0,
    commands: 0,
  });
  const [mcpEditorOpen, setMcpEditorOpen] = useState(false);
  const [skillDetailOpen, setSkillDetailOpen] = useState(false);
  const [mcpFormScopeKey, setMcpFormScopeKey] = useState<string | null>(null);
  const [pluginDetailOpen, setPluginDetailOpen] = useState(false);
  const [commandEditorOpen, setCommandEditorOpen] = useState(false);
  const [commandFormScopeKey, setCommandFormScopeKey] = useState<string | null>(null);
  const activeSearchQuery = searchQueries[selectedTab];
  const selectedScope: PluginScope = useMemo(() => {
    const resolution = scope.resolution;
    return resolution.status === "ready" && resolution.kind === "workspace"
      ? { kind: "workspace", key: resolution.key, tab: resolution.target }
      : { kind: "user", key: "user" };
  }, [scope.resolution]);
  // 插件商店作用于当前 workspace 的 Host；只有选中当前 workspace 所在设备的「用户」时提供入口，
  // 否则在商店里安装会写到另一台设备。
  const marketplaceAvailable = selectedScope.kind === "user" && scope.isActiveWorkspaceDevice;
  const openPluginStoreForSelectedScope = useCallback(
    (_returnScopeKey?: string, intent?: "add-marketplace") => {
      // Workspace 是已安装 Plugin 的配置视图，不提供 Marketplace 入口；市场只在 User
      // 视图中负责 package/cache 生命周期。
      if (!marketplaceAvailable) return;
      onOpenPluginStore("user", intent);
    },
    [marketplaceAvailable, onOpenPluginStore],
  );
  const target = selectedScope.kind === "workspace" ? selectedScope.tab : userScopeTarget;
  const effectiveMcpScopeKey = mcpEditorOpen && mcpFormScopeKey ? mcpFormScopeKey : localScopeKey;
  const effectiveMcpWorkspace = workspaceTabs.find(
    (tab) => workspaceKey(tab) === effectiveMcpScopeKey,
  );
  // 编辑器锁定的 Workspace 断连后，回退 preferredHost 会把保存请求发到
  // 另一个项目。失效当帧先移除写入目标，随后 effect 关闭编辑器，避免配置写错位置。
  const mcpEditorWorkspaceMissing = Boolean(
    mcpEditorOpen && mcpFormScopeKey && mcpFormScopeKey !== "user" && !effectiveMcpWorkspace,
  );
  const mcpTarget = mcpEditorWorkspaceMissing ? null : (effectiveMcpWorkspace ?? userScopeTarget);
  const effectiveCommandScopeKey =
    commandEditorOpen && commandFormScopeKey ? commandFormScopeKey : localScopeKey;
  const effectiveCommandWorkspace = workspaceTabs.find(
    (tab) => workspaceKey(tab) === effectiveCommandScopeKey,
  );
  const commandEditorWorkspaceMissing = Boolean(
    commandEditorOpen &&
    commandFormScopeKey &&
    commandFormScopeKey !== "user" &&
    !effectiveCommandWorkspace,
  );
  const commandTarget = commandEditorWorkspaceMissing
    ? null
    : (effectiveCommandWorkspace ?? userScopeTarget);

  useEffect(() => {
    if (!mcpEditorWorkspaceMissing) return;
    setMcpEditorOpen(false);
    setMcpFormScopeKey(null);
  }, [mcpEditorWorkspaceMissing]);

  useEffect(() => {
    if (!commandEditorWorkspaceMissing) return;
    setCommandEditorOpen(false);
    setCommandFormScopeKey(null);
  }, [commandEditorWorkspaceMissing]);

  const selectedTargetKey = target ? workspaceKey(target) : "";
  // 选中设备离线或 attachment 未就绪时不渲染任何列表：读写一律失败并提示，不显示旧快照。
  const scopeBlocked = resolveSettingsScopeBlock(scope, selectedScope.kind === "user");
  const blockedNotice = scopeBlocked ? (
    <SettingsScopeBlockedNotice state={scopeBlocked} device={scope.device} />
  ) : null;

  const updatePluginCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.plugins === count ? current : { ...current, plugins: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateMcpCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.mcps === count ? current : { ...current, mcps: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateSkillCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.skills === count ? current : { ...current, skills: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateCommandCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.commands === count ? current : { ...current, commands: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const handleMcpEditorOpenChange = useCallback((open: boolean) => {
    setMcpEditorOpen(open);
    if (!open) setMcpFormScopeKey(null);
  }, []);

  return (
    <SettingsScopeDeviceProvider
      device={scope.device}
      userAvailable={scope.user.status !== "unavailable"}
    >
      <div className="space-y-6">
        {mode === "plugin" &&
        showMarketplaceBreadcrumb &&
        !pluginDetailOpen &&
        !mcpEditorOpen &&
        !skillDetailOpen ? (
          <SettingsBreadcrumbReporter
            items={[
              {
                label: intl.formatMessage({
                  id: "settings.plugins.title",
                }),
              },
            ]}
            onSectionSelect={openPluginStoreForSelectedScope}
          />
        ) : null}
        <Tabs
          value={selectedTab}
          onValueChange={(value) => {
            if (mode === "plugin") {
              setInteractiveTab(normalizePluginTab(value as PluginTabTarget));
            }
          }}
        >
          {!mcpEditorOpen && !pluginDetailOpen && !commandEditorOpen ? (
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <PluginScopeMenu
                  align="start"
                  groups={scope.groups}
                  selectedScopeKey={selectedScopeKey}
                  selectedDevice={scope.device}
                  triggerTestId="plugin-settings-scope-trigger"
                  userOptionTestId="plugin-settings-scope-user-option"
                  workspaceOptionTestIdPrefix="plugin-settings-scope-option"
                  onScopeKeyChange={scope.setSelectedScopeKey}
                />
                <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
                {mode === "plugin" ? (
                  <TabsList variant="line" className="h-7 max-w-full gap-1 overflow-x-auto p-0">
                    <TabsTrigger
                      value="plugins"
                      className="h-7 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
                    >
                      {intl.formatMessage({
                        id: "settings.plugin.tab.plugins",
                      })}
                      <span className={getPluginTabCountClass("plugins", selectedTab)}>
                        {capabilityCounts.plugins}
                      </span>
                    </TabsTrigger>
                    <TabsTrigger
                      value="mcps"
                      className="h-7 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
                    >
                      {intl.formatMessage({
                        id: "settings.plugin.tab.mcps",
                      })}
                      <span className={getPluginTabCountClass("mcps", selectedTab)}>
                        {capabilityCounts.mcps}
                      </span>
                    </TabsTrigger>
                    <TabsTrigger
                      value="skills"
                      className="h-7 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
                    >
                      {intl.formatMessage({
                        id: "settings.plugin.tab.skills",
                      })}
                      <span className={getPluginTabCountClass("skills", selectedTab)}>
                        {capabilityCounts.skills}
                      </span>
                    </TabsTrigger>
                  </TabsList>
                ) : (
                  <div
                    data-independent-capability-count="true"
                    className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground"
                  >
                    <span>
                      {intl.formatMessage({
                        id:
                          mode === "market"
                            ? "settings.plugin.tab.plugins"
                            : mode === "mcp"
                              ? "settings.plugin.tab.mcps"
                              : mode === "skill"
                                ? "settings.plugin.tab.skills"
                                : "settings.plugin.tab.commands",
                      })}
                    </span>
                    <span className="text-ui-sm text-foreground-subtle">
                      {mode === "market"
                        ? capabilityCounts.plugins
                        : mode === "mcp"
                          ? capabilityCounts.mcps
                          : mode === "skill"
                            ? capabilityCounts.skills
                            : capabilityCounts.commands}
                    </span>
                  </div>
                )}
              </div>
              <SettingsSearchInput
                data-testid="plugin-settings-search"
                containerClassName="w-full sm:ml-auto sm:w-64"
                clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
                value={activeSearchQuery}
                onClear={() => {
                  setSearchQueries((current) => ({
                    ...current,
                    [selectedTab]: "",
                  }));
                }}
                onChange={(event) => {
                  const value = event.target.value;
                  setSearchQueries((current) => ({
                    ...current,
                    [selectedTab]: value,
                  }));
                }}
                placeholder={intl.formatMessage({
                  id:
                    selectedTab === "plugins"
                      ? "settings.plugin.plugins.searchPlaceholder"
                      : selectedTab === "mcps"
                        ? "settings.mcp.searchPlaceholder"
                        : selectedTab === "skills"
                          ? "settings.skills.searchPlaceholder"
                          : "settings.commands.searchPlaceholder",
                })}
              />
            </div>
          ) : null}
          {mode === "plugin" || mode === "market" ? (
            <TabsContent
              forceMount
              value="plugins"
              className={
                pluginDetailOpen
                  ? "data-[state=inactive]:hidden"
                  : "mt-6 data-[state=inactive]:hidden"
              }
            >
              {blockedNotice ?? (
                <PluginList
                  inMarketplace={mode === "market"}
                  onOpenUi={onOpenUi}
                  target={target}
                  configScope={selectedScope.kind === "user" ? "user" : "workspace"}
                  isDesktop={isDesktop}
                  isMacDesktop={isMacDesktop}
                  isWindowsDesktop={isWindowsDesktop}
                  isWebRemoteControl={isWebRemoteControl}
                  searchQuery={searchQueries.plugins}
                  onAdd={marketplaceAvailable ? openPluginStoreForSelectedScope : undefined}
                  onCreateTask={onCreateTask}
                  onDetailOpenChange={setPluginDetailOpen}
                  onOpenPluginStore={openPluginStoreForSelectedScope}
                  showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
                  onVisibleCountChange={updatePluginCount}
                  dataSyncSourceServerId={scope.syncSourceServerId}
                  unscopedServices={selectedScope.kind === "user" ? userScopeServices : undefined}
                  cacheAuthorityKey={
                    selectedScope.kind === "user" ? userScopeAuthorityKey : undefined
                  }
                />
              )}
            </TabsContent>
          ) : null}
          {mode === "plugin" || mode === "mcp" ? (
            <TabsContent
              forceMount
              value="mcps"
              className={
                mcpEditorOpen ? "data-[state=inactive]:hidden" : "mt-6 data-[state=inactive]:hidden"
              }
            >
              {blockedNotice ??
                (mcpTarget ? (
                  <McpSettingsSection
                    workspacePath={mcpTarget.workspacePath}
                    workspaceIdentity={mcpTarget.workspaceIdentity}
                    remoteSessionId={mcpTarget.remoteSessionId}
                    remoteTarget={mcpTarget.remoteTarget}
                    isWebRemoteControl={isWebRemoteControl}
                    scopeFilter={effectiveMcpScopeKey === "user" ? "user" : "workspace"}
                    parentScopeKey={localScopeKey}
                    workspaceTabs={workspaceTabs}
                    searchQuery={searchQueries.mcps}
                    onVisibleCountChange={updateMcpCount}
                    onEditorOpenChange={handleMcpEditorOpenChange}
                    onFormScopeKeyChange={setMcpFormScopeKey}
                    onOpenPluginStore={
                      marketplaceAvailable ? openPluginStoreForSelectedScope : undefined
                    }
                    showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
                    dataSyncSourceServerId={
                      effectiveMcpScopeKey === "user" ? scope.syncSourceServerId : null
                    }
                    unscopedServices={
                      effectiveMcpScopeKey === "user" ? userScopeServices : undefined
                    }
                    cacheAuthorityKey={
                      effectiveMcpScopeKey === "user" ? userScopeAuthorityKey : undefined
                    }
                  />
                ) : (
                  <EmptyState
                    message={intl.formatMessage({
                      id: "settings.plugin.noWorkspace",
                    })}
                  />
                ))}
            </TabsContent>
          ) : null}
          {mode === "plugin" || mode === "skill" ? (
            <TabsContent forceMount value="skills" className="mt-6 data-[state=inactive]:hidden">
              {blockedNotice ??
                (target ? (
                  <SkillsSection
                    workspacePath={target.workspacePath}
                    workspaceIdentity={target.workspaceIdentity}
                    remoteSessionId={target.remoteSessionId}
                    remoteTarget={target.remoteTarget}
                    isWebRemoteControl={isWebRemoteControl}
                    scopeFilter={selectedScope.kind === "user" ? "user" : "workspace"}
                    searchQuery={searchQueries.skills}
                    onCreateTask={onCreateTask}
                    onDetailOpenChange={setSkillDetailOpen}
                    onOpenPluginStore={
                      marketplaceAvailable ? openPluginStoreForSelectedScope : undefined
                    }
                    showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
                    reportDetailBreadcrumb={mode === "plugin"}
                    onVisibleCountChange={updateSkillCount}
                    dataSyncSourceServerId={scope.syncSourceServerId}
                    unscopedServices={selectedScope.kind === "user" ? userScopeServices : undefined}
                    cacheAuthorityKey={
                      selectedScope.kind === "user" ? userScopeAuthorityKey : undefined
                    }
                  />
                ) : (
                  <EmptyState
                    message={intl.formatMessage({
                      id: "settings.plugin.noWorkspace",
                    })}
                  />
                ))}
            </TabsContent>
          ) : null}
          {mode === "command" ? (
            <TabsContent
              forceMount
              value="commands"
              className={
                commandEditorOpen
                  ? "data-[state=inactive]:hidden"
                  : "mt-6 data-[state=inactive]:hidden"
              }
            >
              {blockedNotice ??
                (commandTarget ? (
                  <CommandsSection
                    workspacePath={commandTarget.workspacePath}
                    workspaceIdentity={commandTarget.workspaceIdentity}
                    scopeFilter={effectiveCommandScopeKey === "user" ? "user" : "workspace"}
                    parentScopeKey={localScopeKey}
                    workspaceTabs={workspaceTabs}
                    searchQuery={searchQueries.commands}
                    onVisibleCountChange={updateCommandCount}
                    onEditorOpenChange={setCommandEditorOpen}
                    onFormScopeKeyChange={setCommandFormScopeKey}
                    unscopedServices={
                      effectiveCommandScopeKey === "user" ? userScopeServices : undefined
                    }
                    cacheAuthorityKey={
                      effectiveCommandScopeKey === "user" ? userScopeAuthorityKey : undefined
                    }
                  />
                ) : (
                  <EmptyState
                    message={intl.formatMessage({
                      id: "settings.plugin.noWorkspace",
                    })}
                  />
                ))}
            </TabsContent>
          ) : null}
        </Tabs>
      </div>
    </SettingsScopeDeviceProvider>
  );
}
