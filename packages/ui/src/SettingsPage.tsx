import { useSetInterfaceModeWithTelemetry } from "@/lib/appTelemetry.js";
import { DataSyncSection } from "@/data-sync/index.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
/* oxlint-disable eslint(max-lines) */
import { ArrowLeft, type LucideIcon } from "lucide-react";
import { useStore } from "zustand";
import {
  marketingNavigation,
  finishMarketingNavigation,
  marketingSettingsSections,
} from "@/lib/marketingNavigation.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import type {
  AppSettings,
  DesktopCloseToTrayCapability,
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
  UsageEntitlementSnapshot,
  UserInfo,
  ZCodeInteractionBehavior,
} from "@zcode/shared";
import { BUILTIN_MODEL_PROVIDER_IDS, isLocale } from "@zcode/shared";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_USAGE_TAB,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import { getPathLeaf } from "@/lib/path.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import {
  addPendingSettingsSectionListener,
  clearPendingSettingsPluginOrigin,
  clearPendingSettingsPluginScopeKey,
  consumeInitialSettingsSection,
  consumePendingSettingsSourceServerId,
  consumePendingSettingsSourceServerDetails,
  consumePendingSettingsPluginOrigin,
  consumePendingSettingsPluginScopeKey,
  consumePendingSettingsPluginTab,
  consumePendingSettingsModelProviderTarget,
  consumePendingSettingsUsageTab,
  resolveSettingsSection,
  setPendingSettingsSectionIntent,
  shouldFallbackSettingsUsageTabToApp,
  writeLastSettingsSectionPreference,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import { readSidebarUsageCodingPlanSourcePreference } from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
import {
  resolveEntitledAccountProviderAccess,
  resolveEntitledAccountProviderAccessFingerprint,
} from "@/lib/accountProviderAccess.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";
import {
  ArchiveManagement,
  ProjectManagement,
  useOptionalProjectDirectory,
} from "@/project-sidebar/index.js";
import { resolveRecentRemoteProjectPreference } from "@/project-sidebar/remote-project-connection.js";
import {
  SettingsShareManagement,
  type SettingsShareTaskTarget,
} from "@/conversation-share-interaction/SettingsShareManagement.js";
import { ModelProviderSection } from "@/settings/ModelProviderSection.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";
import { UsageStatsSection, type UsageStatsSectionTab } from "@/settings/UsageStatsSection.js";
import {
  buildCodingPlanUsageSources,
  type CodingPlanUsageSource,
} from "@/settings/usage-stats/CodingPlanUsagePanel.js";
import { buildPersonalCodingPlanUsageSource } from "@/lib/codingPlanUsageSources.js";
import { SubagentsSection } from "@/settings/SubagentsSection.js";
import { AutomationsSection } from "@/settings/AutomationsSection.js";
import { SegmentPill } from "@/settings/PluginStoreListView.js";
import { PluginsSection } from "@/settings/PluginsSection.js";
import { HooksSection } from "@/settings/HooksSection.js";
import { WorkspaceFileSearchSection } from "@/settings/WorkspaceFileSearchSection.js";
import { MemorySettingsPage } from "@/settings/MemorySettingsSection.js";
import { PersonalizationSection } from "@/settings/PersonalizationSection.js";
import { BrowserSettingsSection } from "@/settings/BrowserSettingsSection.js";
import { ComputerUseSection } from "@/settings/ComputerUseSection.js";
import { ShortcutSettingsSection } from "@/settings/ShortcutSettingsSection.js";
import {
  SettingsSearch,
  SettingsSearchTargetContext,
  type SettingsSearchId,
} from "@/settings-search/index.js";
import { resolveComputerUseAvailability } from "@/settings/computerUseAvailability.js";
import { MigrationSection } from "@/settings/MigrationSection.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import type { Theme } from "@/useTheme.js";
import { WindowsTopLeftLogo } from "@/WindowsTopLeftLogo.js";

import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { useSelectDirectory } from "@/hooks/usePlatform.js";
import { ServiceProvider, useServices } from "@/hooks/useServices.js";
import { DEFAULT_APP_TOOL_SEARCH_MODE, type AppToolSearchMode } from "@zcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import type { CreateTaskRequest, RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveModelProviderConnectivityWorkspacePath } from "@/lib/modelProviderConnectivityTarget.js";
import {
  createSettingsPageConfig,
  GeneralSectionContent,
  AgentBehaviorSectionContent,
  TaskAutoArchiveSettings,
  isSettingsSectionAvailable,
  resolveSettingsSectionForPlatform,
} from "@/settingsPageHelpers.js";
import { SourceServerManagementPanel } from "@/settings/SourceServerManagementPanel.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { useOptionalRemoteWorkspaceController } from "@/remote/useRemoteWorkspaceController.js";
import { AppearanceSectionContent } from "./settingsCodePreview.js";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import {
  runUserAction,
  runUserActionAsync,
  type UserActionResult,
  type UserActionTrigger,
} from "@/lib/userActionTelemetry.js";
import type { SettingsUserActionFeatureId } from "@/lib/userActionTraceCatalog.js";

function runSettingsActionAsync<T>(options: {
  featureId: SettingsUserActionFeatureId;
  action: string;
  trigger: UserActionTrigger;
  operation: () => Promise<T>;
  completed: UserActionResult;
  failureStage?: string;
}): Promise<T> {
  return runUserActionAsync({
    input: {
      featureId: options.featureId,
      action: options.action,
      trigger: options.trigger,
    },
    operation: options.operation,
    completed: options.completed,
    failureStage: options.failureStage ?? "settings_commit",
  });
}

function SettingsUsageProviderTabs({
  activeTab,
  codingPlanSources,
  onTabChange,
}: {
  activeTab: UsageStatsSectionTab;
  codingPlanSources: CodingPlanUsageSource[];
  onTabChange: (tab: UsageStatsSectionTab) => void;
}) {
  const { intl } = useZCodeIntl();
  const tabItems = [
    {
      id: "app" as const,
      label: intl.formatMessage({ id: "settings.usage.tab.appUsage" }),
    },
    ...codingPlanSources.map((source, index) => ({
      id: createSettingsUsageCodingPlanTabId(source.id),
      label: resolveSettingsUsageCodingPlanTabLabel({
        defaultLabel: intl.formatMessage({
          id: "settings.usage.tab.codingPlan",
        }),
        hasMultiplePersonalSources:
          codingPlanSources.filter((item) => !isTeamCodingPlanUsageSource(item)).length > 1,
        index,
        source,
      }),
    })),
  ];
  const visibleActiveTab =
    activeTab === "codingPlan" && codingPlanSources[0]
      ? createSettingsUsageCodingPlanTabId(codingPlanSources[0].id)
      : activeTab;

  return (
    <div className="flex items-center gap-1.5">
      {tabItems.map((item) => (
        <SegmentPill
          key={item.id}
          active={visibleActiveTab === item.id}
          label={item.label}
          testId={testId(TID_SETTINGS_USAGE_TAB, item.id)}
          onClick={() => onTabChange(item.id)}
        />
      ))}
    </div>
  );
}

function isTeamCodingPlanUsageSource(source: CodingPlanUsageSource): boolean {
  return "planKind" in source.accountAccess && source.accountAccess.planKind === "team-coding-plan";
}

function createSettingsUsageCodingPlanTabId(sourceId: string): UsageStatsSectionTab {
  return `codingPlan:${sourceId}`;
}

function resolveSettingsUsageCodingPlanSourceId(tab: UsageStatsSectionTab): string | null {
  return tab.startsWith("codingPlan:") ? tab.slice("codingPlan:".length) : null;
}

function resolveSettingsUsageCodingPlanTabLabel({
  defaultLabel,
  hasMultiplePersonalSources,
  source,
}: {
  defaultLabel: string;
  hasMultiplePersonalSources: boolean;
  index: number;
  source: CodingPlanUsageSource;
}): string {
  if (isTeamCodingPlanUsageSource(source)) {
    return source.label.replace(/^BigModel\s*-\s*/i, "").trim() || source.label;
  }
  if (hasMultiplePersonalSources) {
    return source.label.replace(/\s*-\s*Coding Plan$/i, "").trim() || source.label;
  }
  return defaultLabel;
}

function hasActiveCodingPlanSnapshot(
  snapshot: UsageEntitlementSnapshot | null,
  providerId: string,
): boolean {
  return (
    snapshot?.provider?.id === providerId &&
    snapshot.unavailableReason !== "no_plan" &&
    (Boolean(snapshot.subscription?.details.length) ||
      // quota 暂时失败时服务仍能确认当前 provider，但旧过滤条件会把
      // Coding Plan tab 当成未开通套餐删除。只有明确 no_plan 才应隐藏入口。
      snapshot.unavailableReason === "unavailable")
  );
}

function SettingsSidebarButton({
  icon: Icon,
  label,
  active,
  children,
  className,
  ...buttonProps
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  children?: ReactNode;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <ControlHintTooltip title={label} side="right" align="center">
      <button
        {...buttonProps}
        type={buttonProps.type ?? "button"}
        aria-label={label}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-left transition-colors",
          "max-lg:mx-auto max-lg:size-10 max-lg:justify-center max-lg:px-0",
          "compact-web:mx-0 compact-web:h-8 compact-web:w-auto compact-web:shrink-0 compact-web:px-2.5",
          active
            ? "bg-surface-hover text-foreground"
            : "text-remote-foreground-muted hover:bg-surface-hover hover:text-foreground",
          className,
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-current">
          <Icon className="size-4 text-foreground" />
        </span>
        <span className="min-w-0 flex-1 max-lg:sr-only compact-web:not-sr-only">
          {children ?? <span className="truncate text-ui-base text-foreground">{label}</span>}
        </span>
      </button>
    </ControlHintTooltip>
  );
}

export function SettingsPage({
  isDesktop,
  isWindowsDesktop,
  isMacDesktop,
  isWebRemoteControl = false,
  windowsWindowControlsRightPaddingPx: _windowsWindowControlsRightPaddingPx,
  captionWorkspacePath,
  onBack,
  onOpenTask,
  onCreateTask,
  onOpenWorkspace,
  onOpenRemoteWorkspace,
  allowOpenWorkspace = true,
  onLogin,
  onLogout,
  user,
}: {
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isMacDesktop?: boolean;
  isWebRemoteControl?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  captionWorkspacePath?: string | null;
  onBack?: () => void;
  /** 设置页内跳转到指定会话（分享管理「跳转对话」）；Root 注入。 */
  onOpenTask?: (target: SettingsShareTaskTarget) => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenWorkspace?: () => void;
  onOpenRemoteWorkspace?: (preference?: RemoteConnectionOpenPreference) => void;
  /** 远程设备卡「新任务」：激活该设备已打开的 tab 并开新草稿（Root 注入）。 */
  allowOpenWorkspace?: boolean;
  onLogin?: () => void;
  onLogout?: () => void;
  user?: UserInfo | null;
}) {
  const { intl, localePreference, setLocalePreference } = useZCodeIntl();
  const { settingsSectionGroups, settingsSections } = useMemo(
    () =>
      createSettingsPageConfig({
        isDesktop: Boolean(isDesktop),
        isMacDesktop: Boolean(isMacDesktop),
        isWindowsDesktop: Boolean(isWindowsDesktop),
      }),
    [isDesktop, isMacDesktop, isWindowsDesktop],
  );
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const usesInlineWindowControls = Boolean(isWindowsDesktop || isLinuxDesktop);
  const platform = usePlatform();
  const remoteWorkspaceController = useOptionalRemoteWorkspaceController();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() => {
    const initialSection = consumeInitialSettingsSection("general");
    const visibleInitialSection = resolveSettingsSectionForPlatform(
      initialSection,
      settingsSections,
    );
    // 设置页首次挂载时也要写入当前落点。否则用户直接打开再退出，
    // 下一次仍可能因为没有偏好记录而回到旧默认入口。
    writeLastSettingsSectionPreference(visibleInitialSection);
    return visibleInitialSection;
  });
  const [targetSourceServerId, setTargetSourceServerId] = useState(
    consumePendingSettingsSourceServerId,
  );
  const [searchTarget, setSearchTarget] = useState<{ id: SettingsSearchId } | null>(null);
  const [targetSourceServerDetails, setTargetSourceServerDetails] = useState(
    consumePendingSettingsSourceServerDetails,
  );
  const [pluginTab, setPluginTab] = useState(() => consumePendingSettingsPluginTab());
  const settingsNavRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = settingsNavRef.current;
    // 只有 compact-web 横向导航会横向溢出；从其他入口直达某个分区时，把当前项滚进可见区域。
    // 桌面竖向导航没有横向溢出，不进入该分支。
    if (!nav || nav.scrollWidth <= nav.clientWidth) {
      return;
    }
    nav
      .querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeSection]);

  // Linux 关闭驻留托盘能力查询（spec：docs/desktop/linux-close-to-tray.md）：打开设置页时
  // 经 platform IPC 触发 main 侧探测（带 stale 缓存），用户装完 AppIndicator 扩展重开
  // 设置页即可解除置灰；Web/远控无桥不查询。
  const [linuxCloseToTrayCapability, setLinuxCloseToTrayCapability] =
    useState<DesktopCloseToTrayCapability | null>(null);
  useEffect(() => {
    if (!isLinuxDesktop) {
      return;
    }
    let cancelled = false;
    platform
      .getCloseToTrayCapability?.()
      .then((capability) => {
        if (!cancelled) {
          setLinuxCloseToTrayCapability(capability);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isLinuxDesktop, platform]);
  const linuxCloseToTray = isLinuxDesktop
    ? {
        // 探测中按不可用锁定，防止查询完成前误开导致关窗失联
        disabled: linuxCloseToTrayCapability === null || !linuxCloseToTrayCapability.supported,
        unavailable: linuxCloseToTrayCapability?.supported === false,
        gnomeLikeHint:
          linuxCloseToTrayCapability?.supported === false &&
          linuxCloseToTrayCapability.gnomeLikeWithoutTray,
      }
    : undefined;
  const marketingRequest = useStore(marketingNavigation, (state) => state.request);
  useEffect(() => {
    if (marketingRequest?.target.page !== "settings") return;
    const target = marketingRequest.target;
    const section = target.section ? marketingSettingsSections[target.section] : activeSection;
    if (!settingsSections.some((item) => item.id === section)) {
      finishMarketingNavigation(marketingRequest.id, new Error("marketing_navigation_unavailable"));
    } else if (activeSection === section && !target.provider_id) {
      finishMarketingNavigation(marketingRequest.id);
    }
  }, [activeSection, marketingRequest, settingsSections]);
  const [pluginNavigationOrigin, setPluginNavigationOrigin] = useState(() =>
    consumePendingSettingsPluginOrigin(),
  );
  const [pluginScopeKey, setPluginScopeKey] = useState(() =>
    consumePendingSettingsPluginScopeKey(),
  );
  const [settingsSectionNavigationVersion, setSettingsSectionNavigationVersion] = useState(0);
  useEffect(() => {
    // React Strict Mode 会双执行 state initializer；来源和 scopeKey 都在挂载完成后再清理，
    // Marketplace 只返回 User 已安装视图；Workspace 仍通过设置页自身的配置层切换进入。
    clearPendingSettingsPluginOrigin();
    clearPendingSettingsPluginScopeKey();
  }, []);
  const [settingsBreadcrumbItems, setSettingsBreadcrumbItems] = useState<
    readonly SettingsBreadcrumbItem[]
  >([]);
  const interfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useSetInterfaceModeWithTelemetry(platform, "app.setting");
  const theme = useZCodeStore((state) => state.theme);
  const setTheme = useZCodeStore((state) => state.setTheme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const setCodePreviewSettings = useZCodeStore((state) => state.setCodePreviewSettings);
  const fontSmoothingEnabled = useZCodeStore((state) => state.fontSmoothingEnabled);
  const setFontSmoothingEnabled = useZCodeStore((state) => state.setFontSmoothingEnabled);
  const uiFontSizePx = useZCodeStore((state) => state.uiFontSizePx);
  const setUiFontSizePx = useZCodeStore((state) => state.setUiFontSizePx);
  const hideProjectDeviceNames = useZCodeStore((state) => state.hideProjectDeviceNames);
  const setHideProjectDeviceNames = useZCodeStore((state) => state.setHideProjectDeviceNames);
  const notificationEnabled = useZCodeStore((state) => state.notificationEnabled);
  const setNotificationEnabled = useZCodeStore((state) => state.setNotificationEnabled);
  const notificationSoundEnabled = useZCodeStore((state) => state.notificationSoundEnabled);
  const setNotificationSoundEnabled = useZCodeStore((state) => state.setNotificationSoundEnabled);
  const usageProviderSettingsRead = useProviderSettingsView();
  const usageProviderSettingsView =
    usageProviderSettingsRead.state.status === "ready"
      ? usageProviderSettingsRead.state.view
      : null;
  const usageProviderSettingsLoading = usageProviderSettingsRead.state.status !== "ready";
  const usageZaiProvider = usageProviderSettingsView?.providers.find(
    (provider) => provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  );
  const usageBigmodelProvider = usageProviderSettingsView?.providers.find(
    (provider) => provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  );
  const usageZaiProviderAccess = resolveEntitledAccountProviderAccess(
    usageProviderSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  );
  const usageBigmodelProviderAccess = resolveEntitledAccountProviderAccess(
    usageProviderSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  );
  const usageZaiProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    usageProviderSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  );
  const usageBigmodelProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    usageProviderSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  );
  const usageZaiTeamProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    usageProviderSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
  );
  const usageBigmodelTeamProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    usageProviderSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
  );
  const usageZaiEntitlement = useUsageEntitlement({
    enabled:
      activeSection === "usage" &&
      !usageProviderSettingsLoading &&
      Boolean(usageZaiProviderFingerprint),
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    accountAccess: usageZaiProviderAccess?.access,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      providerFingerprint: usageZaiProviderFingerprint,
    }),
    // 个人 Usage source 依赖 entitlement snapshot；冷启动无缓存时若不先探测，
    // source 不会渲染，子面板也无法触发 access 刷新。共享 freshness window 继续负责限频。
    refreshOnMount: true,
  });
  const usageBigmodelEntitlement = useUsageEntitlement({
    enabled:
      activeSection === "usage" &&
      !usageProviderSettingsLoading &&
      Boolean(usageBigmodelProviderFingerprint),
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: usageBigmodelProviderAccess?.access,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      providerFingerprint: usageBigmodelProviderFingerprint,
    }),
    refreshOnMount: true,
  });
  // 原只拉 bigmodel family 的企业 pricing，zai team plan 在使用统计页
  // 永远拿不到 team project 上下文；后续又误用 Individual Provider 的权益作为 Team
  // 商品门禁，导致仅有 Team Plan 的账号仍然没有 Usage 来源。企业商品只依赖对应的
  // Team Account Provider，个人额度继续依赖 Individual Provider，避免两个产品身份串线。
  const usageBigmodelEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled: !usageProviderSettingsLoading && Boolean(usageBigmodelTeamProviderFingerprint),
    authenticated: true,
    family: "bigmodel",
  });
  const usageZaiEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled: !usageProviderSettingsLoading && Boolean(usageZaiTeamProviderFingerprint),
    authenticated: true,
    family: "zai",
  });
  const usageSubscribedTeamProducts = useMemo(
    () => [
      ...(usageBigmodelEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
      ...(usageZaiEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
    ],
    [
      usageBigmodelEnterpriseProducts.snapshot?.productList,
      usageZaiEnterpriseProducts.snapshot?.productList,
    ],
  );
  const [usageActiveTab, setUsageActiveTab] = useState<UsageStatsSectionTab>(() => {
    const pendingTab = consumePendingSettingsUsageTab();
    return pendingTab === "codingPlan" ? "codingPlan" : (pendingTab ?? "app");
  });
  const usagePersonalCodingPlanSources = useMemo(() => {
    const sources: CodingPlanUsageSource[] = [];
    if (
      usageZaiProviderAccess &&
      hasActiveCodingPlanSnapshot(
        usageZaiEntitlement.snapshot,
        BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      )
    ) {
      sources.push(
        buildPersonalCodingPlanUsageSource({
          providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          accountAccess: usageZaiProviderAccess.access,
          label: usageZaiProvider?.providerName,
        }),
      );
    }
    if (
      usageBigmodelProviderAccess &&
      hasActiveCodingPlanSnapshot(
        usageBigmodelEntitlement.snapshot,
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      )
    ) {
      sources.push(
        buildPersonalCodingPlanUsageSource({
          providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          accountAccess: usageBigmodelProviderAccess.access,
          label: usageBigmodelProvider?.providerName,
        }),
      );
    }
    return sources;
  }, [
    usageBigmodelEntitlement.snapshot,
    usageBigmodelProvider,
    usageBigmodelProviderAccess,
    usageZaiEntitlement.snapshot,
    usageZaiProvider,
    usageZaiProviderAccess,
  ]);
  const usageTeamCodingPlanSources = useMemo(
    () =>
      buildCodingPlanUsageSources({
        accountAccesses: {
          ...(resolveEntitledAccountProviderAccess(
            usageProviderSettingsView,
            BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
          )?.access
            ? {
                zai: resolveEntitledAccountProviderAccess(
                  usageProviderSettingsView,
                  BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
                )!.access,
              }
            : {}),
          ...(resolveEntitledAccountProviderAccess(
            usageProviderSettingsView,
            BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
          )?.access
            ? {
                bigmodel: resolveEntitledAccountProviderAccess(
                  usageProviderSettingsView,
                  BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
                )!.access,
              }
            : {}),
        },
        subscribedTeamProducts: usageSubscribedTeamProducts,
      }),
    [usageProviderSettingsView, usageSubscribedTeamProducts],
  );
  const usageCodingPlanSources = useMemo(
    () => [...usagePersonalCodingPlanSources, ...usageTeamCodingPlanSources],
    [usagePersonalCodingPlanSources, usageTeamCodingPlanSources],
  );
  const selectedUsageCodingPlanSourceId =
    usageActiveTab === "codingPlan"
      ? (usageCodingPlanSources[0]?.id ?? null)
      : resolveSettingsUsageCodingPlanSourceId(usageActiveTab);
  const selectedUsageCodingPlanSource =
    usageCodingPlanSources.find((source) => source.id === selectedUsageCodingPlanSourceId) ?? null;
  const showUsageCodingPlanTab = usageCodingPlanSources.length > 0;
  const checkingUsageZaiCodingPlanTab = Boolean(
    usageZaiProviderFingerprint &&
    (usageZaiEntitlement.loading || (!usageZaiEntitlement.snapshot && !usageZaiEntitlement.error)),
  );
  const checkingUsageBigmodelCodingPlanTab = Boolean(
    usageBigmodelProviderFingerprint &&
    (usageBigmodelEntitlement.loading ||
      (!usageBigmodelEntitlement.snapshot && !usageBigmodelEntitlement.error)),
  );
  const checkingUsageCodingPlanTab =
    usageProviderSettingsLoading ||
    checkingUsageZaiCodingPlanTab ||
    checkingUsageBigmodelCodingPlanTab ||
    usageBigmodelEnterpriseProducts.loading ||
    usageZaiEnterpriseProducts.loading;
  const [initialModelProviderTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const [pendingModelProviderTarget, setPendingModelProviderTarget] = useState<
    SettingsModelProviderTarget | undefined
  >(() => initialModelProviderTarget);
  const handleUsageTabSelect = useCallback((tab: UsageStatsSectionTab) => {
    setUsageActiveTab(tab);
  }, []);
  /*
   * 使用统计是账号级 sources，不再绑定当前 workspace 连接方式。
   * 旧入口只会写入 "codingPlan" 意图；等 sources 加载后需要落到真实来源。
   * 剩余额度「更多」等入口会先写入来源偏好（当前 coding plan 类型/团队项目），
   * 解析时优先选中该来源，缺失或已不可用时回退第一份真实来源。
   */
  useEffect(() => {
    if (usageActiveTab !== "codingPlan" || !usageCodingPlanSources[0]) {
      return;
    }
    const preferredSourceId = readSidebarUsageCodingPlanSourcePreference();
    const preferredSource = preferredSourceId
      ? usageCodingPlanSources.find((source) => source.id === preferredSourceId)
      : undefined;
    setUsageActiveTab(
      createSettingsUsageCodingPlanTabId((preferredSource ?? usageCodingPlanSources[0]).id),
    );
  }, [usageActiveTab, usageCodingPlanSources]);
  useEffect(() => {
    if (
      usageActiveTab === "app" ||
      usageActiveTab === "codingPlan" ||
      selectedUsageCodingPlanSource
    ) {
      return;
    }
    setUsageActiveTab(
      usageCodingPlanSources[0]
        ? createSettingsUsageCodingPlanTabId(usageCodingPlanSources[0].id)
        : "app",
    );
  }, [selectedUsageCodingPlanSource, usageActiveTab, usageCodingPlanSources]);
  const setNewUserOnboardingOpen = useZCodeStore((state) => state.setNewUserOnboardingOpen);
  // 「通用」页「打开引导」打开职业引导；迁移向导只从数据同步页「迁移」进入。
  const openOccupationOnboarding = () => setNewUserOnboardingOpen(true);
  const requestMigrationDialog = useZCodeStore((state) => state.requestOnboardingDialog);
  const setActiveSettingsSection = useCallback(
    (section: SettingsSectionId, fallbackSection: SettingsSectionId = activeSection) => {
      const resolvedSection = resolveSettingsSection(section, fallbackSection);
      setSearchTarget(null);
      setActiveSection(resolvedSection);
      writeLastSettingsSectionPreference(resolvedSection);
    },
    [activeSection],
  );
  const navigateToSettingsSection = (section: SettingsSectionId, setting?: SettingsSearchId) => {
    setPluginNavigationOrigin(undefined);
    setTargetSourceServerId(undefined);
    setSettingsSectionNavigationVersion((version) => version + 1);
    setActiveSettingsSection(section);
    if (setting) setSearchTarget({ id: setting });
  };
  useEffect(() => {
    if (!isSettingsSectionAvailable(activeSection, Boolean(isDesktop))) {
      setActiveSettingsSection("general");
    }
  }, [activeSection, isDesktop, setActiveSettingsSection]);
  const handleOpenCodingPlanUpgradeSettings = useCallback(
    (
      providerId: string,
      funnelContext?: import("@/lib/codingPlanFunnelTelemetry.js").CodingPlanFunnelContext,
    ) => {
      openCodingPlanUpgrade({
        providerId,
        funnelContext,
      });
    },
    [openCodingPlanUpgrade],
  );
  const handleOpenModelProviderSettings = useCallback(() => {
    setActiveSettingsSection("modelProvider");
  }, [setActiveSettingsSection]);
  const handleOpenUsageSettings = useCallback(() => {
    // 设置页 sidebar footer 里的齿轮/返回按钮复用 onBack，
    // 但头像菜单的“使用统计”应该停留在设置页并切到 Usage，不能跟着返回工作区。
    setActiveSettingsSection("usage");
  }, [setActiveSettingsSection]);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activateTab = useTabStore((state) => state.activateTab);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  // Settings 打开后 activeTab 会变成 settings，本地反查 activeTab 读 identity 会稳定丢失。
  // 这里改为读取 tabStore 维护的“最近激活 workspace identity”，让插件管理继续命中正确远端。
  const activeWorkspaceIdentity = useTabStore(
    (state) => state.activeWorkspaceIdentity ?? undefined,
  );
  const activeWorkspaceTab = useTabStore((state) => {
    const workspacePath = state.activeWorkspacePath;
    if (!workspacePath) {
      return null;
    }
    const workspaceIdentity = state.activeWorkspaceIdentity ?? undefined;
    const matchingTabs = state.tabs
      .filter(isWorkspaceTab)
      .filter((tab) => tab.workspacePath === workspacePath);
    return (
      matchingTabs.find((tab) =>
        workspaceIdentity ? tab.workspaceIdentity === workspaceIdentity : !tab.workspaceIdentity,
      ) ??
      matchingTabs[0] ??
      null
    );
  });
  const localModelProviderConnectivityWorkspacePath = useMemo(
    () =>
      resolveModelProviderConnectivityWorkspacePath({
        activeWorkspacePath,
        activeWorkspaceIdentity,
        activeWorkspaceTab,
        workspaceTabs,
      }),
    [activeWorkspaceIdentity, activeWorkspacePath, activeWorkspaceTab, workspaceTabs],
  );
  const isRemoteModelProviderWorkspace = Boolean(
    activeWorkspaceIdentity?.trim() ||
    activeWorkspaceTab?.remoteSessionId?.trim() ||
    activeWorkspaceTab?.remoteTarget,
  );
  const selectDirectory = useSelectDirectory();
  const services = useServices();
  const localHostServices = useBaseWorkspaceServices();
  const projectDirectory = useOptionalProjectDirectory();
  // SettingsPage 可能挂在远端 workspace 的 ServiceProvider 下；共享设置属于本机 Host，
  // 读写必须固定走本机 settingService，否则会写进远端 setting。
  const { settings: sharedSettings, update: updateSharedSettings } = useSettings({
    services: localHostServices,
  });
  const sourceManagement = localHostServices.sourceServerManagementService;
  const { snapshot: sourceManagementSnapshot } = useSourceServerManagementSnapshot(
    sourceManagement,
    {
      onError: (error) =>
        logger.warn("[SettingsPage] 读取 Source 状态失败", {
          error: error instanceof Error ? error.message : String(error),
        }),
    },
  );
  const memoryWorkspaceDisplayNames = useMemo(() => {
    const names = new Set<string>();
    // Memory Scope 的项目顺序以 settings.json recentProjects 为准；打开中的
    // Workspace 只补充尚未持久化的项目，不能抢占最近项目排序。
    for (const path of sharedSettings?.recentProjects ?? []) {
      const name = getPathLeaf(path).trim();
      if (name) names.add(name);
    }
    for (const tab of workspaceTabs) {
      const name = tab.label.trim() || getPathLeaf(tab.workspacePath).trim();
      if (name) names.add(name);
    }
    return [...names];
  }, [sharedSettings?.recentProjects, workspaceTabs]);
  const toolSearchMode = sharedSettings?.toolSearchMode ?? DEFAULT_APP_TOOL_SEARCH_MODE;
  const nativeSearchEnhancementsEnabled = sharedSettings?.nativeSearchEnhancementsEnabled !== false;
  const askUserQuestionAutoResolutionEnabled =
    sharedSettings?.askUserQuestionAutoResolutionEnabled !== false;
  const modelIoFullRetentionEnabled = sharedSettings?.modelIoFullRetentionEnabled === true;
  const [dataBaseDir, setDataBaseDir] = useState("");
  const [terminalInheritSystemProfile, setTerminalInheritSystemProfile] = useState(true);
  const [terminalFontFamily, setTerminalFontFamily] = useState("");
  const [integratedTerminalShell, setIntegratedTerminalShell] =
    useState<IntegratedTerminalShellSelection>({ mode: "auto" });
  const [integratedTerminalShellOptions, setIntegratedTerminalShellOptions] = useState<
    IntegratedTerminalShellOption[]
  >([]);
  const [httpProxy, setHttpProxy] = useState("");
  const [httpProxyNoProxy, setHttpProxyNoProxy] = useState("");
  const [httpProxyCaCertPath, setHttpProxyCaCertPath] = useState("");
  const [embeddedBrowserAllowInsecureCertificates, setEmbeddedBrowserAllowInsecureCertificates] =
    useState(false);
  const [taskAutoArchiveEnabled, setTaskAutoArchiveEnabled] = useState(false);
  const [taskAutoArchiveOlderThanDays, setTaskAutoArchiveOlderThanDays] = useState(30);
  const [closeToTrayOnWindows, setCloseToTrayOnWindows] = useState(Boolean(isWindowsDesktop));
  const [
    desktopChromiumHardwareAccelerationEnabled,
    setDesktopChromiumHardwareAccelerationEnabled,
  ] = useState(true);
  const [receivePreviewUpdates, setReceivePreviewUpdates] = useState(false);
  const [autoDownloadAndInstallUpdates, setAutoDownloadAndInstallUpdates] = useState(false);
  const [messageStreamShowReasoning, setMessageStreamShowReasoning] = useState(true);
  const [messageStreamShowTodos, setMessageStreamShowTodos] = useState(false);
  const [zcodeInteractionBehavior, setZCodeInteractionBehavior] =
    useState<ZCodeInteractionBehavior>("queue");
  const [defaultHomeDir, setDefaultHomeDir] = useState("");
  const [hostPlatform, setHostPlatform] = useState("");

  useEffect(() => {
    if (
      !shouldFallbackSettingsUsageTabToApp({
        activeTab: usageActiveTab === "app" ? "app" : "codingPlan",
        checkingCodingPlanTab: checkingUsageCodingPlanTab,
        loadingModelProviders: usageProviderSettingsLoading,
        showCodingPlanTab: showUsageCodingPlanTab,
      })
    ) {
      return;
    }

    // 剩余额度入口会先写入 Coding Plan tab 意图，再打开设置页。
    // 如果首帧 provider/entitlement 仍在加载就立刻回退，会让“更多”看起来只打开了 App Usage。
    // 这里等数据确认没有套餐后再回退，避免空入口误导用户。
    setUsageActiveTab("app");
  }, [
    checkingUsageCodingPlanTab,
    showUsageCodingPlanTab,
    usageSubscribedTeamProducts.length,
    usageActiveTab,
    usageProviderSettingsLoading,
  ]);

  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        // SettingsPage 已打开时再次从 quickpick 点“个性化/MCP”等设置入口，
        // 页面不会重新挂载，之前写入的 pending section 无人消费，看起来像点击没反应。
        // 这里订阅同窗口跳转意图，立即切换当前设置分区。
        setActiveSettingsSection(section, activeSection);
        // 设置入口是一级路由边界。即使仍落在同一 section，也必须销毁旧的 New/Edit/Detail 子状态。
        setSettingsSectionNavigationVersion((version) => version + 1);
        setTargetSourceServerId(section === "remoteDevices" ? detail?.sourceServerId : undefined);
        setTargetSourceServerDetails(
          section === "remoteDevices" && detail?.sourceServerDetails === true,
        );
        if (section === "usage" && detail?.usageTab) {
          setUsageActiveTab(detail.usageTab);
        }
        // MCP 独立分区也接收工作区意图，否则会话内审核会误落到用户配置。
        setPluginScopeKey(detail?.pluginScopeKey);
        if (resolveSettingsSection(section) === "plugin" && detail?.pluginTab) {
          setPluginTab(detail.pluginTab);
          setPluginNavigationOrigin(detail.pluginOrigin);
        } else if (resolveSettingsSection(section) !== "plugin") {
          setPluginNavigationOrigin(undefined);
        }
        if (section === "modelProvider" && detail?.modelProviderId) {
          setPendingModelProviderTarget({
            providerId: detail.modelProviderId,
          });
        }
      }),
    [activeSection, setActiveSettingsSection],
  );

  useEffect(() => {
    let active = true;
    // 修复原因：远程 tab 的 services 属于 Source，但 Main 启动、native picker 和
    // 本机 shell 枚举都使用 Desktop 配置；读写必须同属 base Host，不能随 tab 切换。
    localHostServices.settingService
      .get()
      .then((settings: AppSettings) => {
        if (!active) return;
        setDataBaseDir(settings.dataBaseDir ?? "");
        setIntegratedTerminalShell(settings.integratedTerminalShell ?? { mode: "auto" });
        setHttpProxy(settings.httpProxy ?? "");
        setHttpProxyNoProxy(settings.httpProxyNoProxy ?? "");
        setHttpProxyCaCertPath(settings.httpProxyCaCertPath ?? "");
        setEmbeddedBrowserAllowInsecureCertificates(
          settings.embeddedBrowserAllowInsecureCertificates ?? false,
        );
        setCloseToTrayOnWindows(settings.closeToTrayOnWindows ?? Boolean(isWindowsDesktop));
        setDesktopChromiumHardwareAccelerationEnabled(
          settings.desktopChromiumHardwareAccelerationEnabled ?? true,
        );
      })
      .catch(() => {});
    localHostServices.systemService
      .info()
      .then((info) => {
        if (!active) return;
        setDefaultHomeDir(info.homedir);
        setHostPlatform(info.platform);
        if (info.platform !== "win32") {
          setIntegratedTerminalShellOptions([]);
          return;
        }
        void localHostServices.systemService
          .listIntegratedTerminalShells()
          .then((options) => {
            if (active) setIntegratedTerminalShellOptions(options);
          })
          .catch(() => {
            if (active) setIntegratedTerminalShellOptions([]);
          });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [localHostServices.systemService, localHostServices.settingService, isWindowsDesktop]);

  useEffect(() => {
    let active = true;
    // 终端 Profile 与任务归档由目标 Environment 消费，仍读 Source；切换后丢弃旧响应。
    services.settingService
      .get()
      .then((settings: AppSettings) => {
        if (!active) return;
        setTerminalInheritSystemProfile(settings.terminalInheritSystemProfile ?? true);
        setTerminalFontFamily(settings.terminalFontFamily ?? "");
        setTaskAutoArchiveEnabled(settings.taskAutoArchiveEnabled ?? false);
        setTaskAutoArchiveOlderThanDays(settings.taskAutoArchiveOlderThanDays ?? 30);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [services.settingService]);

  useEffect(() => {
    if (!sharedSettings) {
      return;
    }
    setMessageStreamShowReasoning(sharedSettings.messageStreamShowReasoning ?? true);
    setMessageStreamShowTodos(sharedSettings.messageStreamShowTodos ?? false);
    setZCodeInteractionBehavior(sharedSettings.zcodeInteractionBehavior ?? "queue");
    setReceivePreviewUpdates(sharedSettings.receivePreviewUpdates ?? false);
    setAutoDownloadAndInstallUpdates(sharedSettings.autoDownloadAndInstallUpdates ?? false);
  }, [sharedSettings]);
  const handleTerminalInheritSystemProfileChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "toggle_system_profile",
        trigger: "switch",
        operation: () => services.settingService.update({ terminalInheritSystemProfile: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setTerminalInheritSystemProfile(enabled);
    },
    [services.settingService],
  );
  const handleTerminalFontFamilyChange = useCallback(
    async (fontFamily: string) => {
      const normalizedFontFamily = fontFamily.trim();
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "save_font_family",
        trigger: "button",
        operation: () =>
          services.settingService.update({ terminalFontFamily: normalizedFontFamily }),
        completed: { resultSource: "setting_service", configured: normalizedFontFamily.length > 0 },
      });
      setTerminalFontFamily(normalizedFontFamily);
    },
    [services.settingService],
  );
  const handleIntegratedTerminalShellChange = useCallback(
    async (selection: IntegratedTerminalShellSelection) => {
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "change_shell",
        trigger: "select",
        operation: () =>
          localHostServices.settingService.update({ integratedTerminalShell: selection }),
        completed: {
          resultSource: "setting_service",
          valueAfter: selection.mode === "auto" ? "auto" : "explicit",
        },
      });
      setIntegratedTerminalShell(selection);
    },
    [localHostServices.settingService],
  );
  const handleToolSearchModeChange = useCallback(
    async (mode: AppToolSearchMode) => {
      await runSettingsActionAsync({
        featureId: "settings.search",
        action: "change_tool_search_mode",
        trigger: "select",
        operation: () => updateSharedSettings({ toolSearchMode: mode }),
        completed: { resultSource: "shared_settings", valueAfter: mode },
      });
    },
    [updateSharedSettings],
  );
  const handleNativeSearchEnhancementsEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.search",
        action: "toggle_native_search",
        trigger: "switch",
        operation: () => updateSharedSettings({ nativeSearchEnhancementsEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleAskUserQuestionAutoResolutionEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_ask_user_auto_resolution",
        trigger: "switch",
        operation: () => updateSharedSettings({ askUserQuestionAutoResolutionEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleModelIoFullRetentionEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_model_io_retention",
        trigger: "switch",
        operation: () => updateSharedSettings({ modelIoFullRetentionEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleHttpProxyChange = useCallback(
    async (proxy: string) => {
      const normalizedProxy = proxy.trim();
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_http_proxy",
        trigger: "button",
        operation: () =>
          localHostServices.settingService.update({
            // Bugfix: RPC 会丢弃 undefined；清空代理必须传空串，由服务层删除旧字段。
            httpProxy: normalizedProxy,
          }),
        completed: {
          resultSource: "setting_service",
          configured: normalizedProxy.length > 0,
          requiresRestart: true,
        },
      });
      setHttpProxy(normalizedProxy);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl],
  );
  const handleHttpProxyNoProxyChange = useCallback(
    async (noProxy: string) => {
      const normalizedNoProxy = noProxy
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
        .join(",");
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_no_proxy",
        trigger: "button",
        operation: () =>
          localHostServices.settingService.update({
            // Bugfix: 清空 No Proxy 必须传空串，否则旧绕过规则会继续影响下次启动。
            httpProxyNoProxy: normalizedNoProxy,
          }),
        completed: { resultSource: "setting_service", configured: normalizedNoProxy.length > 0 },
      });
      setHttpProxyNoProxy(normalizedNoProxy);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl],
  );
  const handleHttpProxyCaCertPathChange = useCallback(
    async (caCertPath: string) => {
      const normalizedCaCertPath = caCertPath.trim();
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_ca_certificate",
        trigger: "button",
        operation: () =>
          localHostServices.settingService.update({
            // Bugfix: 清空自定义 CA 必须传空串，否则旧 NODE_EXTRA_CA_CERTS 路径会残留。
            httpProxyCaCertPath: normalizedCaCertPath,
          }),
        completed: {
          resultSource: "setting_service",
          configured: normalizedCaCertPath.length > 0,
          requiresRestart: true,
        },
      });
      setHttpProxyCaCertPath(normalizedCaCertPath);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl],
  );
  const handleDataBaseDirChange = useCallback(
    async (dir: string) => {
      await runSettingsActionAsync({
        featureId: "settings.storage",
        action: "change_data_directory",
        trigger: "button",
        operation: () => localHostServices.settingService.updateDataBaseDir(dir || undefined),
        completed: { resultSource: "setting_service", requiresRestart: true },
        failureStage: "data_directory_update",
      });
      // Bugfix: 迁移失败时不能先把本地状态改成失败路径，否则设置页会误显示为已切换。
      setDataBaseDir(dir);
    },
    [localHostServices.settingService],
  );
  const handleTaskAutoArchiveEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.task",
        action: "toggle_auto_archive",
        trigger: "switch",
        operation: () => services.settingService.update({ taskAutoArchiveEnabled: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setTaskAutoArchiveEnabled(enabled);
    },
    [services.settingService],
  );
  const handleTaskAutoArchiveOlderThanDaysChange = useCallback(
    async (days: number) => {
      await runSettingsActionAsync({
        featureId: "settings.task",
        action: "change_auto_archive_days",
        trigger: "select",
        operation: () => services.settingService.update({ taskAutoArchiveOlderThanDays: days }),
        completed: { resultSource: "setting_service", valueAfter: String(days) },
      });
      setTaskAutoArchiveOlderThanDays(days);
    },
    [services.settingService],
  );
  const handleCloseToTrayOnWindowsChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_close_to_tray",
        trigger: "switch",
        operation: () => localHostServices.settingService.update({ closeToTrayOnWindows: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      platform.syncAppSettings?.({ closeToTrayOnWindows: enabled });
      setCloseToTrayOnWindows(enabled);
    },
    [localHostServices.settingService, platform],
  );
  // keep-awake：走 useSettings 统一写盘 + syncAppSettings，和 Automations/创建页入口共享同一状态源。
  const handleKeepAwakeWhileRunningChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_keep_awake",
        trigger: "switch",
        operation: () => updateSharedSettings({ keepAwakeWhileRunning: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  // 本机 offline push 开关：设置文件是唯一数据源，Main 每次上报前读取，不需要额外通知 Main。
  const handleMobilePushEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.notification",
        action: "toggle_mobile_push",
        trigger: "switch",
        operation: () => updateSharedSettings({ mobilePushEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleDesktopChromiumHardwareAccelerationChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_hardware_acceleration",
        trigger: "switch",
        operation: () =>
          localHostServices.settingService.update({
            desktopChromiumHardwareAccelerationEnabled: enabled,
          }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
          requiresRestart: true,
        },
      });
      setDesktopChromiumHardwareAccelerationEnabled(enabled);
      toast(
        intl.formatMessage({
          id: "settings.desktopChromiumHardwareAccelerationSavedHint",
        }),
      );
    },
    [localHostServices.settingService, intl],
  );
  const handleEmbeddedBrowserAllowInsecureCertificatesChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.browser",
        action: "toggle_insecure_certificates",
        trigger: "switch",
        operation: () =>
          localHostServices.settingService.update({
            embeddedBrowserAllowInsecureCertificates: enabled,
          }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
          requiresRestart: true,
        },
      });
      setEmbeddedBrowserAllowInsecureCertificates(enabled);
      // 证书策略在 main 启动时装到 Session 上，改完必须重启才会换掉 verifyProc。
      toast(
        intl.formatMessage({
          id: "settings.embeddedBrowserAllowInsecureCertificatesSavedHint",
        }),
      );
    },
    [localHostServices.settingService, intl],
  );
  const handleReceivePreviewUpdatesChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.update",
        action: "toggle_preview_updates",
        trigger: "switch",
        operation: () => updateSharedSettings({ receivePreviewUpdates: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setReceivePreviewUpdates(enabled);
    },
    [updateSharedSettings],
  );
  const handleAutoDownloadAndInstallUpdatesChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.update",
        action: "toggle_auto_update",
        trigger: "switch",
        operation: () => updateSharedSettings({ autoDownloadAndInstallUpdates: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setAutoDownloadAndInstallUpdates(enabled);
    },
    [updateSharedSettings],
  );
  const handleMessageStreamShowReasoningChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_show_reasoning",
        trigger: "switch",
        operation: () => updateSharedSettings({ messageStreamShowReasoning: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setMessageStreamShowReasoning(enabled);
    },
    [updateSharedSettings],
  );
  const handleMessageStreamShowTodosChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_show_todos",
        trigger: "switch",
        operation: () => updateSharedSettings({ messageStreamShowTodos: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setMessageStreamShowTodos(enabled);
    },
    [updateSharedSettings],
  );
  const handleZCodeInteractionBehaviorChange = useCallback(
    async (behavior: ZCodeInteractionBehavior) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "change_interaction_behavior",
        trigger: "select",
        operation: () => updateSharedSettings({ zcodeInteractionBehavior: behavior }),
        completed: { resultSource: "shared_settings", valueAfter: behavior },
      });
      setZCodeInteractionBehavior(behavior);
    },
    [updateSharedSettings],
  );
  const handleFooterLocaleChange = useCallback(
    (value: string) => {
      if (value === "system") {
        runUserAction({
          input: { featureId: "settings.locale", action: "change_locale", trigger: "select" },
          operation: () => setLocalePreference("system"),
          completed: { resultSource: "local_commit", valueAfter: "system" },
          failureStage: "local_commit",
        });
        return;
      }
      if (isLocale(value)) {
        runUserAction({
          input: { featureId: "settings.locale", action: "change_locale", trigger: "select" },
          operation: () => setLocalePreference(value),
          completed: { resultSource: "local_commit", valueAfter: value },
          failureStage: "local_commit",
        });
      }
    },
    [setLocalePreference],
  );
  const handleFooterThemeChange = useCallback(
    (value: string) => {
      if (
        value === "light" ||
        value === "dark" ||
        value === "zai-light" ||
        value === "zai-dark" ||
        value === "system"
      ) {
        runUserAction({
          input: { featureId: "settings.appearance", action: "change_theme", trigger: "select" },
          operation: () => setTheme(value as Theme),
          completed: { resultSource: "local_commit", valueAfter: value },
          failureStage: "local_commit",
        });
      }
    },
    [setTheme],
  );
  const handleCodePreviewSettingsChange = useCallback(
    (patch: Parameters<typeof setCodePreviewSettings>[0]) => {
      const [key] = Object.keys(patch);
      const action =
        key === "lightTheme"
          ? "change_code_light_theme"
          : key === "darkTheme"
            ? "change_code_dark_theme"
            : key === "showLineNumbers"
              ? "toggle_code_line_numbers"
              : key === "wrapLongLines"
                ? "toggle_code_line_wrap"
                : "change_code_font_size";
      const value = Object.values(patch)[0];
      return runUserAction({
        input: { featureId: "settings.appearance", action, trigger: "select" },
        operation: () => setCodePreviewSettings(patch),
        completed: {
          resultSource: "local_commit",
          ...(typeof value === "boolean"
            ? { stateAfter: value ? ("enabled" as const) : ("disabled" as const) }
            : { valueAfter: String(value) }),
        },
        failureStage: "local_commit",
      });
    },
    [setCodePreviewSettings],
  );
  const activeSectionMeta = settingsSections.find((section) => section.id === activeSection);
  // 灰度裁决异步到达：sections 列表可能在挂载后变化（如 computerUse 区被灰度移除）。
  // 若用户正停留在被移除的 section，回落到第一个可见区，避免整页 return null。
  useEffect(() => {
    setActiveSection((current) => resolveSettingsSectionForPlatform(current, settingsSections));
  }, [settingsSections]);
  if (!activeSectionMeta) {
    return null;
  }

  const activeSectionLabel = intl.formatMessage({
    id: activeSectionMeta.contentTitleId ?? activeSectionMeta.titleId,
  });
  const settingsBreadcrumbSectionLabel =
    activeSection === "plugin" && pluginNavigationOrigin === "plugin-store"
      ? intl.formatMessage({ id: "workspace.openPluginsSettings" })
      : activeSectionLabel;
  const visibleSettingsBreadcrumbItems =
    settingsBreadcrumbItems[0]?.label === settingsBreadcrumbSectionLabel
      ? settingsBreadcrumbItems
      : [];
  const hasVisibleSettingsBreadcrumb = visibleSettingsBreadcrumbItems.length >= 2;
  const showActiveSectionTitle =
    !hasVisibleSettingsBreadcrumb ||
    (activeSection === "plugin" && pluginNavigationOrigin === "plugin-store");

  return (
    <SettingsSearchTargetContext.Provider value={searchTarget}>
      <DesktopWindowFrame
        title={intl.formatMessage({ id: "settings.title" })}
        isDesktop={isDesktop}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        <div
          data-testid={TID_SETTINGS_PAGE}
          data-active-section={activeSection}
          // 隐式 auto 行会按 Memory viewer 的内容高度撑出窗口，随后被 DesktopWindowFrame 裁切且没有滚动条。
          // 固定为单个 minmax(0, 1fr) 行，让普通设置页和内部滚动 viewer 都以窗口剩余高度为边界。
          className="relative grid h-screen min-h-full w-full grid-cols-[68px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] lg:grid-cols-[268px_minmax(0,1fr)] compact-web:grid-cols-1 compact-web:grid-rows-[auto_minmax(0,1fr)]"
        >
          {isWindowsDesktop ? <WindowsTopLeftLogo /> : null}

          {usesInlineWindowControls ? (
            <div
              className={cn(
                "absolute z-30 mt-px mr-px flex h-12 items-center gap-0.5 px-2 pointer-events-auto [app-region:no-drag]",
                // 外沿留白变化后，悬浮操作组也必须同步，否则与内容 Header 错位。
                isWindowsDesktop ? "right-1.5 top-1.5" : "right-1 top-1",
              )}
            >
              {/* Bug 原因：Windows/Linux 设置页仍保留旧 caption 下箭头，与主界面和 macOS 的帮助入口不一致。
                  统一复用问号帮助按钮，并让它在普通 flex 流中紧邻自绘窗控。
                  Settings 的独立标题层还需计入 4px 外层留白和 1px 边框，才能与 Workspace 控制组对齐。 */}
              <WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} />
              <DesktopWindowControls />
            </div>
          ) : null}
          {/* 手机窄屏 Web 下 68px 图标栏会挤占内容宽度，compact-web 下改成顶部横向滚动导航条。
              spec：docs/settings-narrow-layout.md */}
          <aside className="min-w-0">
            <div className="flex h-full flex-col compact-web:flex-row compact-web:items-center">
              <div className="h-12 [app-region:drag] compact-web:hidden"></div>
              <div className="px-2 pb-3 pt-3 compact-web:shrink-0 compact-web:py-1.5 compact-web:pr-0">
                {onBack ? (
                  <ControlHintTooltip
                    title={intl.formatMessage({
                      id: "workspace.backToWorkspace",
                    })}
                    side="right"
                    align="center"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="lg"
                      data-testid={TID_SETTINGS_BACK_BUTTON}
                      aria-label={intl.formatMessage({
                        id: "workspace.backToWorkspace",
                      })}
                      className="m-1 w-[calc(100%-0.5rem)] justify-start gap-2 rounded-xl bg-surface px-1.5 text-remote-foreground-muted hover:bg-surface-hover hover:text-foreground max-lg:m-1 max-lg:size-10 max-lg:justify-center max-lg:px-0"
                      onClick={() => {
                        runUserAction({
                          input: {
                            featureId: "settings.navigation",
                            action: "back_to_workspace",
                            trigger: "button",
                          },
                          operation: () => {
                            if (pluginNavigationOrigin === "plugin-store") {
                              requestPluginStoreOpen("user");
                            }
                            onBack?.();
                          },
                          completed: { resultSource: "local_commit" },
                          failureStage: "navigation_commit",
                        });
                      }}
                    >
                      <ArrowLeft className="size-4" />
                      <span className="max-lg:sr-only">
                        {intl.formatMessage({
                          id: "workspace.backToWorkspace",
                        })}
                      </span>
                    </Button>
                  </ControlHintTooltip>
                ) : null}
              </div>

              <div className="px-3 pb-3 max-lg:flex max-lg:justify-center compact-web:shrink-0 compact-web:px-1 compact-web:pb-0">
                <SettingsSearch
                  sections={settingsSections}
                  availability={{
                    desktop: Boolean(isDesktop),
                    windowsHost: hostPlatform === "win32",
                    tray: Boolean(isWindowsDesktop || isLinuxDesktop),
                    notWindows: !isWindowsDesktop,
                    macDesktop: Boolean(isDesktop && isMacDesktop),
                    computerUse: resolveComputerUseAvailability({
                      isDesktop: Boolean(isDesktop),
                      isMacDesktop: Boolean(isMacDesktop),
                      isWindowsDesktop: Boolean(isWindowsDesktop),
                      remoteSessionId: activeWorkspaceTab?.remoteSessionId,
                      remoteTarget: activeWorkspaceTab?.remoteTarget,
                      workspaceIdentity: activeWorkspaceIdentity,
                    }).supported,
                  }}
                  onSelect={({ section, setting }) => navigateToSettingsSection(section, setting)}
                />
              </div>

              <nav
                ref={settingsNavRef}
                aria-label={intl.formatMessage({ id: "settings.navLabel" })}
                className="flex-1 overflow-y-auto px-2 pb-3 compact-web:min-w-0 compact-web:overflow-x-auto compact-web:overflow-y-hidden compact-web:py-1.5"
              >
                <div className="space-y-4 compact-web:flex compact-web:items-center compact-web:gap-2 compact-web:space-y-0">
                  {settingsSectionGroups.map((group, groupIndex) => {
                    const groupLabel = intl.formatMessage({
                      id: group.titleId,
                    });
                    const groupLabelId = `settings-sidebar-group-${group.id}`;

                    return (
                      <div
                        key={group.id}
                        role="group"
                        aria-labelledby={groupLabelId}
                        className={cn(
                          "space-y-1 compact-web:flex compact-web:shrink-0 compact-web:items-center compact-web:gap-1 compact-web:space-y-0",
                          groupIndex > 0 &&
                            "max-lg:border-t max-lg:border-border max-lg:pt-3 compact-web:border-t-0 compact-web:border-l compact-web:pt-0 compact-web:pl-2",
                        )}
                      >
                        <div
                          id={groupLabelId}
                          className="px-2.5 pb-1 text-ui-sm font-medium text-remote-foreground-muted max-lg:sr-only"
                        >
                          {groupLabel}
                        </div>
                        {group.sections
                          .filter(({ id }) => isSettingsSectionAvailable(id, Boolean(isDesktop)))
                          .map(({ id, icon: Icon, titleId }) => {
                            const isActive = activeSection === id;
                            const label = intl.formatMessage({ id: titleId });

                            return (
                              <SettingsSidebarButton
                                key={id}
                                icon={Icon}
                                label={label}
                                active={isActive}
                                aria-current={isActive ? "page" : undefined}
                                data-testid={testId(TID_SETTINGS_SECTION_NAV, id)}
                                data-settings-section-nav={id}
                                onClick={() => {
                                  runUserAction({
                                    input: {
                                      featureId: "settings.navigation",
                                      action: "open_section",
                                      trigger: "button",
                                    },
                                    operation: () => navigateToSettingsSection(id),
                                    completed: { resultSource: "local_commit", sectionId: id },
                                    failureStage: "navigation_commit",
                                  });
                                }}
                              >
                                <span className="flex min-w-0 flex-1 items-center gap-2">
                                  <span className="truncate text-ui-base text-foreground">
                                    {label}
                                  </span>
                                </span>
                              </SettingsSidebarButton>
                            );
                          })}
                      </div>
                    );
                  })}
                </div>
              </nav>

              <div className="max-lg:hidden">
                <WorkspaceSidebarFooter
                  theme={theme}
                  localeMenuValue={localePreference}
                  onLocaleChange={handleFooterLocaleChange}
                  onThemeChange={handleFooterThemeChange}
                  onSettingsButtonClick={onBack}
                  onUsageClick={handleOpenUsageSettings}
                  onUpgradeClick={handleOpenCodingPlanUpgradeSettings}
                  onLogin={onLogin}
                  onLogout={onLogout}
                  settingsButtonMode="back"
                  user={user}
                  // 头像菜单是 WorkspaceSidebarFooter 的共享菜单，Settings 场景不能丢失桌面平台能力。
                  // 之前这里没透传 isDesktop，导致同一个头像菜单在设置页缺少界面缩放入口。
                  isDesktop={isDesktop}
                />
              </div>
            </div>
          </aside>

          <section
            data-settings-content-frame="true"
            className={cn(
              "flex min-h-0 flex-col",
              // 桌面平台统一复用主工作区的面板 inset；左侧仍与导航相接，顶部由独立拖拽留白承接。
              isDesktop ? (isWindowsDesktop ? "pr-1.5 pb-1.5" : "pr-1 pb-1") : "p-0",
            )}
          >
            <div
              data-settings-top-inset={isDesktop ? "true" : undefined}
              // 下方面板使用 h-full；顶部留白不能参与 flex 收缩，否则 6px 会变成小数像素。
              className={cn(
                "shrink-0 [app-region:drag]",
                isDesktop && (isWindowsDesktop ? "h-1.5" : "h-1"),
                isMacDesktop && "max-lg:h-16",
              )}
            />
            <div
              data-settings-panel-frame="true"
              className={cn(
                "relative flex flex-col min-h-0 h-full border border-border bg-background",
                // 直接写像素圆角会绕过设计 token；设置页与工作区统一复用 rounded-md（默认 6px）。
                isWindowsDesktop ? "rounded-md" : "rounded-xl",
              )}
            >
              {!usesInlineWindowControls ? (
                <div
                  className={cn(
                    // Settings 使用和 new task 一致的问号定位：在内容面板内定位，外层让出自绘窗口按钮区，内层保持 top-2.5/right-2.5。
                    "absolute top-0 z-50 h-10 w-10 pointer-events-auto [app-region:no-drag]",
                    "right-0",
                  )}
                >
                  <div className="absolute right-2.5 top-2.5 pointer-events-auto [app-region:no-drag]">
                    <WorkspaceHelpMenuButton
                      className="relative z-50 [app-region:no-drag]"
                      isDesktop={Boolean(isDesktop)}
                    />
                  </div>
                </div>
              ) : null}
              <SettingsBreadcrumbProvider
                onItemsChange={setSettingsBreadcrumbItems}
                sectionLabel={settingsBreadcrumbSectionLabel}
              >
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex h-12 shrink-0">
                    <div
                      // Settings 窄布局会像左侧导航一样在 max-lg 收成 icon rail。
                      // 此时外层已经提供 max-lg:h-16 的顶部拖拽/避让区，内层 h-10 再保留会把内容额外压低。
                      // Electron 的 drag 区不能和右上角帮助/窗口按钮命中区域重叠；
                      // 这里把右侧按钮区域从拖拽条里让出来，避免真实鼠标点击被标题栏拖拽吞掉。
                      // Windows/Linux 设置页共同避开右上角菜单与内联窗控组。

                      className={cn(
                        "min-w-0 flex-1 [app-region:drag]",
                        // 四个 28px 按钮、组内 2px 间距和左右 8px padding，共 134px。
                        usesInlineWindowControls ? "mr-[134px]" : "mr-12",
                      )}
                    >
                      <SettingsHeaderBreadcrumb
                        ariaLabel={intl.formatMessage({
                          id: "settings.breadcrumbLabel",
                        })}
                        items={visibleSettingsBreadcrumbItems}
                      />
                    </div>
                  </div>
                  <>
                    <main className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                      <div
                        className={cn(
                          SETTINGS_FRAME_CONTENT_CLASSNAME,
                          "flex flex-col gap-8",
                          isMacDesktop && "pt-0",
                          // isWindowsDesktop && "pt-12",
                        )}
                      >
                        {/* 数据同步自带标题与迁移入口，避免公共页头重复显示标题和间距。 */}
                        {activeSection !== "dataSync" ? (
                          <div>
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div className="flex min-w-0 flex-wrap items-center gap-3">
                                {showActiveSectionTitle ? (
                                  <h2 className="text-ui-settings-title font-semibold tracking-tight text-foreground lg:text-ui-settings-title-lg">
                                    {activeSectionLabel}
                                  </h2>
                                ) : null}
                                {!hasVisibleSettingsBreadcrumb && activeSectionMeta.titleBadgeId ? (
                                  <span className="inline-flex h-6 items-center rounded-md border border-border px-2 text-ui-xs font-semibold tracking-normal text-foreground">
                                    {intl.formatMessage({
                                      id: activeSectionMeta.titleBadgeId,
                                    })}
                                  </span>
                                ) : null}
                                {activeSection === "usage" ? (
                                  <SettingsUsageProviderTabs
                                    activeTab={usageActiveTab}
                                    codingPlanSources={usageCodingPlanSources}
                                    onTabChange={handleUsageTabSelect}
                                  />
                                ) : null}
                              </div>
                            </div>
                            {activeSection === "projects" ? (
                              <p className="mt-2 max-w-2xl text-ui-base text-foreground-subtle">
                                {intl.formatMessage({ id: "projectManagement.intro" })}
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="space-y-8">
                          {activeSection === "general" ? (
                            <GeneralSectionContent
                              localePreference={localePreference}
                              interfaceMode={interfaceMode}
                              setInterfaceMode={setInterfaceMode}
                              isDesktop={isDesktop}
                              isWindowsDesktop={isWindowsDesktop}
                              isLinuxDesktop={isLinuxDesktop}
                              linuxCloseToTray={linuxCloseToTray}
                              platform={platform}
                              notificationEnabled={notificationEnabled}
                              notificationSoundEnabled={notificationSoundEnabled}
                              closeToTrayOnWindows={closeToTrayOnWindows}
                              keepAwakeWhileRunning={sharedSettings?.keepAwakeWhileRunning ?? false}
                              mobilePushEnabled={sharedSettings?.mobilePushEnabled ?? true}
                              onMobilePushEnabledChange={handleMobilePushEnabledChange}
                              desktopChromiumHardwareAccelerationEnabled={
                                desktopChromiumHardwareAccelerationEnabled
                              }
                              receivePreviewUpdates={receivePreviewUpdates}
                              autoDownloadAndInstallUpdates={autoDownloadAndInstallUpdates}
                              dataBaseDir={dataBaseDir}
                              terminalInheritSystemProfile={terminalInheritSystemProfile}
                              terminalFontFamily={terminalFontFamily}
                              integratedTerminalShell={integratedTerminalShell}
                              integratedTerminalShellOptions={integratedTerminalShellOptions}
                              httpProxy={httpProxy}
                              httpProxyNoProxy={httpProxyNoProxy}
                              httpProxyCaCertPath={httpProxyCaCertPath}
                              defaultHomeDir={defaultHomeDir}
                              showIntegratedTerminalShell={hostPlatform === "win32"}
                              setLocalePreference={handleFooterLocaleChange}
                              setNotificationEnabled={(enabled) =>
                                runUserAction({
                                  input: {
                                    featureId: "settings.notification",
                                    action: "toggle_notification",
                                    trigger: "switch",
                                  },
                                  operation: () => setNotificationEnabled(enabled),
                                  completed: {
                                    resultSource: "local_commit",
                                    stateAfter: enabled ? "enabled" : "disabled",
                                  },
                                  failureStage: "local_commit",
                                })
                              }
                              setNotificationSoundEnabled={(enabled) =>
                                runUserAction({
                                  input: {
                                    featureId: "settings.notification",
                                    action: "toggle_notification_sound",
                                    trigger: "switch",
                                  },
                                  operation: () => setNotificationSoundEnabled(enabled),
                                  completed: {
                                    resultSource: "local_commit",
                                    stateAfter: enabled ? "enabled" : "disabled",
                                  },
                                  failureStage: "local_commit",
                                })
                              }
                              onDataBaseDirChange={handleDataBaseDirChange}
                              onSelectDataBaseDir={selectDirectory}
                              onTerminalInheritSystemProfileChange={
                                handleTerminalInheritSystemProfileChange
                              }
                              onTerminalFontFamilyChange={handleTerminalFontFamilyChange}
                              onIntegratedTerminalShellChange={handleIntegratedTerminalShellChange}
                              onHttpProxyChange={handleHttpProxyChange}
                              onHttpProxyNoProxyChange={handleHttpProxyNoProxyChange}
                              onHttpProxyCaCertPathChange={handleHttpProxyCaCertPathChange}
                              onCloseToTrayOnWindowsChange={handleCloseToTrayOnWindowsChange}
                              onKeepAwakeWhileRunningChange={handleKeepAwakeWhileRunningChange}
                              onDesktopChromiumHardwareAccelerationChange={
                                handleDesktopChromiumHardwareAccelerationChange
                              }
                              onReceivePreviewUpdatesChange={handleReceivePreviewUpdatesChange}
                              onAutoDownloadAndInstallUpdatesChange={
                                handleAutoDownloadAndInstallUpdatesChange
                              }
                              onOpenOnboardingDialog={() =>
                                runUserAction({
                                  input: {
                                    featureId: "settings.navigation",
                                    action: "open_onboarding",
                                    trigger: "button",
                                  },
                                  operation: openOccupationOnboarding,
                                  completed: { resultSource: "local_commit" },
                                  failureStage: "dialog_open",
                                })
                              }
                            />
                          ) : activeSection === "agentBehavior" ? (
                            <AgentBehaviorSectionContent
                              toolSearchMode={toolSearchMode}
                              onToolSearchModeChange={handleToolSearchModeChange}
                              nativeSearchEnhancementsEnabled={nativeSearchEnhancementsEnabled}
                              onNativeSearchEnhancementsEnabledChange={
                                handleNativeSearchEnhancementsEnabledChange
                              }
                              messageStreamShowReasoning={messageStreamShowReasoning}
                              messageStreamShowTodos={messageStreamShowTodos}
                              zcodeInteractionBehavior={zcodeInteractionBehavior}
                              askUserQuestionAutoResolutionEnabled={
                                askUserQuestionAutoResolutionEnabled
                              }
                              modelIoFullRetentionEnabled={modelIoFullRetentionEnabled}
                              onMessageStreamShowReasoningChange={
                                handleMessageStreamShowReasoningChange
                              }
                              onMessageStreamShowTodosChange={handleMessageStreamShowTodosChange}
                              onZCodeInteractionBehaviorChange={
                                handleZCodeInteractionBehaviorChange
                              }
                              onAskUserQuestionAutoResolutionEnabledChange={
                                handleAskUserQuestionAutoResolutionEnabledChange
                              }
                              onModelIoFullRetentionEnabledChange={
                                handleModelIoFullRetentionEnabledChange
                              }
                            />
                          ) : activeSection === "dataSync" ? (
                            isDesktop ? (
                              <DataSyncSection
                                snapshot={sourceManagementSnapshot}
                                deviceSyncStateService={localHostServices.deviceSyncStateService}
                                onOpenRemoteConnection={onOpenRemoteWorkspace}
                                onOpenMigration={requestMigrationDialog}
                              />
                            ) : null
                          ) : activeSection === "remoteDevices" ? (
                            sharedSettings && isDesktop && sourceManagement ? (
                              <SourceServerManagementPanel
                                key={`remote:${settingsSectionNavigationVersion}`}
                                targetSourceServerId={targetSourceServerId}
                                targetSourceServerDetails={targetSourceServerDetails}
                                onTargetSourceServerFocused={() => {
                                  setTargetSourceServerId(undefined);
                                  setTargetSourceServerDetails(false);
                                }}
                                management={sourceManagement}
                                onCreateConnection={
                                  onOpenRemoteWorkspace
                                    ? () =>
                                        onOpenRemoteWorkspace({ completion: "device-management" })
                                    : undefined
                                }
                                onConnectProfile={
                                  remoteWorkspaceController
                                    ? (profileId) =>
                                        remoteWorkspaceController.dispatch({
                                          type: "connect-device",
                                          profileId,
                                          effect: "device-management",
                                        })
                                    : onOpenRemoteWorkspace
                                      ? (profileId) =>
                                          onOpenRemoteWorkspace({
                                            preferredProfileId: profileId,
                                            completion: "device-management",
                                          })
                                      : undefined
                                }
                                onDisconnectSource={
                                  remoteWorkspaceController
                                    ? (sourceServerId) =>
                                        remoteWorkspaceController.dispatch({
                                          type: "disconnect-device",
                                          sourceServerId,
                                        })
                                    : undefined
                                }
                                onOpenProject={
                                  onOpenRemoteWorkspace
                                    ? async (sourceServerId, path, profileId) => {
                                        // 仅传目录会被 Root 当成新建；复用侧栏唯一目录 owner，同步固定原入口。
                                        const preference =
                                          projectDirectory &&
                                          resolveRecentRemoteProjectPreference(
                                            projectDirectory.directory,
                                            {
                                              sourceServerId,
                                              path,
                                              profileId,
                                            },
                                          );
                                        if (!preference) {
                                          throw Object.assign(
                                            new Error("remote-project.entry-not-found"),
                                            {
                                              code: "recent-project-unresolved",
                                            },
                                          );
                                        }
                                        onBack?.();
                                        onOpenRemoteWorkspace(preference);
                                      }
                                    : undefined
                                }
                                onShowUpdateDetails={(sourceServerId) => {
                                  setPendingSettingsSectionIntent("remoteDevices", {
                                    sourceServerId,
                                    sourceServerDetails: true,
                                  });
                                  openSettingsTab();
                                }}
                                workspaceTabs={workspaceTabs}
                                onShowInSidebar={(sourceServerId) => {
                                  const target = workspaceTabs.find(
                                    (tab) =>
                                      getWorkspaceSourceServerId(tab, {
                                        workspaceHistory:
                                          sourceManagementSnapshot?.workspaceHistory,
                                      }) === sourceServerId,
                                  );
                                  onBack?.();
                                  if (target) {
                                    activateTab(target.id);
                                    requestAnimationFrame(() => {
                                      const row = Array.from(
                                        document.querySelectorAll<HTMLElement>(
                                          "[data-remote-project-identity]",
                                        ),
                                      ).find(
                                        (element) =>
                                          element.dataset.remoteProjectIdentity ===
                                          target.workspaceIdentity,
                                      );
                                      row?.scrollIntoView({ block: "center" });
                                      row
                                        ?.querySelector<HTMLElement>('[role="button"]')
                                        ?.focus({ preventScroll: true });
                                    });
                                  }
                                }}
                                settings={sharedSettings}
                                onUpdateSettings={updateSharedSettings}
                                hideProjectDeviceNames={hideProjectDeviceNames}
                                onHideProjectDeviceNamesChange={setHideProjectDeviceNames}
                              />
                            ) : (
                              <p className="text-ui-sm text-remote-foreground-muted">
                                {intl.formatMessage({
                                  id: sharedSettings ? "settings.source.empty" : "common.loading",
                                })}
                              </p>
                            )
                          ) : activeSection === "appearance" ? (
                            <AppearanceSectionContent
                              isMacDesktop={Boolean(isDesktop && isMacDesktop)}
                              fontSmoothingEnabled={fontSmoothingEnabled}
                              setFontSmoothingEnabled={setFontSmoothingEnabled}
                              codePreviewSettings={codePreviewSettings}
                              setCodePreviewSettings={handleCodePreviewSettingsChange}
                              theme={theme}
                              setTheme={(nextTheme) => handleFooterThemeChange(nextTheme)}
                              uiFontSizePx={uiFontSizePx}
                              setUiFontSizePx={(fontSizePx) =>
                                runUserAction({
                                  input: {
                                    featureId: "settings.appearance",
                                    action: "change_ui_font_size",
                                    trigger: "keyboard",
                                  },
                                  operation: () => setUiFontSizePx(fontSizePx),
                                  completed: {
                                    resultSource: "local_commit",
                                    valueAfter: String(fontSizePx),
                                  },
                                  failureStage: "local_commit",
                                })
                              }
                            />
                          ) : activeSection === "shortcuts" ? (
                            <ShortcutSettingsSection isDesktop={Boolean(isDesktop)} />
                          ) : activeSection === "modelProvider" ? (
                            <ServiceProvider services={localHostServices}>
                              {/* 模型配置属于本机全局事实源；激活远端 workspace 时也不能注入远端 Host。 */}
                              <ModelProviderSection
                                workspacePath={activeWorkspacePath ?? captionWorkspacePath ?? ""}
                                connectivityWorkspacePath={
                                  localModelProviderConnectivityWorkspacePath
                                }
                                connectivityWorkspaceRequired={isRemoteModelProviderWorkspace}
                                pendingModelProviderTarget={pendingModelProviderTarget}
                                onConsumePendingModelProviderTarget={() =>
                                  setPendingModelProviderTarget(undefined)
                                }
                              />
                            </ServiceProvider>
                          ) : activeSection === "personalization" ? (
                            // 个性化指令编辑的是本机 ~/.zcode/AGENTS.md（Agent 实际读取的文件）。
                            // 仅桌面本地入口可编辑：手机远控的 base services 可能归属远程
                            // Source（remoteWorkspaceServiceCollection 注册的是远端 settingService），
                            // 编辑会写错机器；Web 端只显示本地桌面端指引。
                            <PersonalizationSection
                              settingService={localHostServices.settingService}
                              isDesktop={Boolean(isDesktop)}
                            />
                          ) : activeSection === "memory" ? (
                            <MemorySettingsPage
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              isDesktop={Boolean(isDesktop)}
                              workspaceDisplayNames={memoryWorkspaceDisplayNames}
                            />
                          ) : activeSection === "plugin" ? (
                            <PluginsSection
                              key={`plugin:${settingsSectionNavigationVersion}`}
                              isDesktop={Boolean(isDesktop)}
                              isMacDesktop={Boolean(isMacDesktop)}
                              isWindowsDesktop={Boolean(isWindowsDesktop)}
                              isWebRemoteControl={isWebRemoteControl}
                              initialTab={pluginTab}
                              initialScopeKey={pluginScopeKey}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              showMarketplaceBreadcrumb={pluginNavigationOrigin === "plugin-store"}
                              onCreateTask={onCreateTask}
                              onOpenPluginStore={(_returnScopeKey, intent) => {
                                // 添加市场与浏览插件都先离开设置层，再显示商店。
                                requestPluginStoreOpen({ returnScopeKey: "user", intent });
                                onBack?.();
                              }}
                            />
                          ) : activeSection === "mcp" ? (
                            <PluginsSection
                              key={`mcp:${settingsSectionNavigationVersion}`}
                              mode="mcp"
                              initialScopeKey={pluginScopeKey}
                              isWebRemoteControl={isWebRemoteControl}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              onCreateTask={onCreateTask}
                              onOpenPluginStore={(_returnScopeKey, intent) => {
                                // 添加市场与浏览插件都先离开设置层，再显示商店。
                                requestPluginStoreOpen({ returnScopeKey: "user", intent });
                                onBack?.();
                              }}
                            />
                          ) : activeSection === "skill" ? (
                            <PluginsSection
                              key={`skill:${settingsSectionNavigationVersion}`}
                              mode="skill"
                              isWebRemoteControl={isWebRemoteControl}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              onCreateTask={onCreateTask}
                              onOpenPluginStore={(_returnScopeKey, intent) => {
                                // 添加市场与浏览插件都先离开设置层，再显示商店。
                                requestPluginStoreOpen({ returnScopeKey: "user", intent });
                                onBack?.();
                              }}
                            />
                          ) : activeSection === "migration" ? (
                            <MigrationSection
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              isDesktop={isDesktop}
                            />
                          ) : activeSection === "projects" ? (
                            <ProjectManagement />
                          ) : activeSection === "archives" ? (
                            <div className="min-w-0 space-y-6">
                              <TaskAutoArchiveSettings
                                taskAutoArchiveEnabled={taskAutoArchiveEnabled}
                                taskAutoArchiveOlderThanDays={taskAutoArchiveOlderThanDays}
                                onTaskAutoArchiveEnabledChange={handleTaskAutoArchiveEnabledChange}
                                onTaskAutoArchiveOlderThanDaysChange={
                                  handleTaskAutoArchiveOlderThanDaysChange
                                }
                              />
                              <ArchiveManagement />
                            </div>
                          ) : activeSection === "shares" ? (
                            <SettingsShareManagement
                              signedIn={Boolean(user)}
                              onLogin={onLogin}
                              onOpenTask={onOpenTask}
                            />
                          ) : activeSection === "usage" ? (
                            <UsageStatsSection
                              activeTab={usageActiveTab}
                              providerSourcesLoading={usageProviderSettingsLoading}
                              selectedCodingPlanSource={selectedUsageCodingPlanSource}
                              workspaceIdentity={activeWorkspaceIdentity}
                              workspacePath={activeWorkspacePath ?? undefined}
                            />
                          ) : activeSection === "subagents" ? (
                            <SubagentsSection
                              onManageModels={handleOpenModelProviderSettings}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          ) : activeSection === "automations" ? (
                            <AutomationsSection
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          ) : activeSection === "commands" ? (
                            <PluginsSection
                              mode="command"
                              isWebRemoteControl={isWebRemoteControl}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              onCreateTask={onCreateTask}
                              onOpenPluginStore={(_returnScopeKey, intent) => {
                                // 添加市场与浏览插件都先离开设置层，再显示商店。
                                requestPluginStoreOpen({ returnScopeKey: "user", intent });
                                onBack?.();
                              }}
                            />
                          ) : activeSection === "hooks" ? (
                            <HooksSection
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          ) : activeSection === "workspaceFileSearch" ? (
                            <WorkspaceFileSearchSection
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          ) : activeSection === "browser" ? (
                            <BrowserSettingsSection
                              isDesktop={Boolean(isDesktop)}
                              isWindowsDesktop={isWindowsDesktop}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              embeddedBrowserAllowInsecureCertificates={
                                embeddedBrowserAllowInsecureCertificates
                              }
                              onEmbeddedBrowserAllowInsecureCertificatesChange={
                                handleEmbeddedBrowserAllowInsecureCertificatesChange
                              }
                            />
                          ) : activeSection === "computerUse" ? (
                            <ComputerUseSection
                              isDesktop={Boolean(isDesktop)}
                              isMacDesktop={Boolean(isMacDesktop)}
                              isWindowsDesktop={Boolean(isWindowsDesktop)}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              remoteSessionId={activeWorkspaceTab?.remoteSessionId}
                              remoteTarget={activeWorkspaceTab?.remoteTarget}
                              localWorkspacePath={activeWorkspaceTab?.localWorkspacePath}
                            />
                          ) : null}
                        </div>
                      </div>
                    </main>
                  </>
                </div>
              </SettingsBreadcrumbProvider>
            </div>
          </section>
        </div>
      </DesktopWindowFrame>
    </SettingsSearchTargetContext.Provider>
  );
}
