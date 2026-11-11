import { useInterfaceModeTelemetry } from "@/lib/appTelemetry.js";
import { ProjectDirectoryProvider } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { DataSyncDialogProvider } from "@/data-sync/index.js";
import { RemoteProjectPicker } from "@/project-sidebar/RemoteProjectPicker.js";
import {
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import type { RemoteProjectHost } from "@zcode/services";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { RemoteConnectionProgressProvider } from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";
/* eslint-disable max-lines -- Root 当前集中编排启动、workspace shell wiring 和 Web 远控同步，先保持入口收口避免跨层状态拆散。 */
import { RemoteProjectPresentationProvider } from "@/hooks/RemoteProjectPresentationContext.js";
import {
  RequestSecurityHost,
  RequestSecurityWorkspaceBridge,
  setRequestSecurityReporter,
} from "@/request-security-edition/index.js";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LucideProvider, RefreshCw } from "lucide-react";
import {
  APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
  DesktopCommandIds,
  appRuntimePreferencesChangedBroadcastPayloadSchema,
} from "@zcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { Button } from "@/components/ui/button.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider, useComposerClientNamespace } from "@/hooks/useServices.js";
import {
  readComposerWorkspaceScope,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import {
  useDynamicWorkflowAvailabilityLoader,
  useDynamicWorkflowUserModeSync,
} from "@/hooks/useDynamicWorkflowAvailability.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import {
  attachRemoteProjectWorkspace,
  resolveEntryProject,
  useRemoteWorkspaceConnectionGate,
  useWebRemoteControlRendererActions,
} from "@/project-sidebar/index.js";
import { useTabPersistence, type WorkspacePersistenceGate } from "@/hooks/useTabPersistence.js";
import { useTokenRefresh } from "@/hooks/useTokenRefresh.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SSHDialog } from "@/SSHDialog.js";
import { SettingsPage } from "@/SettingsPage.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { CodingPlanUpgradeDialogProvider } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { RewardsProvider } from "@/rewards/RewardsProvider.js";
import {
  CredentialStoreRecovery,
  WelcomeScreen,
  type LoginCompleteReason,
} from "@/WelcomeScreen.js";
import { useCredentialStoreRecovery } from "@/hooks/useCredentials.js";
import { setDefaultFileDisplayBasePath } from "@/lib/fileDisplay.js";
import { readRendererLaunchTimings, shouldReportLaunchToInput } from "@/lib/launchToInputReport.js";
import { reportUiLaunchToInput } from "@/lib/uiPerfArmsTelemetry.js";
import {
  isProviderStartupSyncPending,
  shouldEnableProviderAvailabilityLoginEntryGuard,
  shouldResolveProviderStartupState,
  shouldBlockRootRender,
  shouldShowRootStartupLoading,
  shouldOpenFallbackWorkspaceAfterCreate,
} from "@/lib/rootStartupGate.js";
import { StoreProvider, useZCodeStore } from "@/store/StoreProvider.js";
import { setMcpStorePlatform } from "@/store/mcpStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { TabStoreProvider, useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isSettingsTab, isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";
import { RootShell } from "@/root/RootShell.js";
import { RootWorkspaceContent } from "@/root/RootWorkspaceContent.js";
import { resolveConversationWorkspaceTarget } from "@/conversation-workspace-target/index.js";
import { resolveRootWorkspaceShellTarget } from "@/root/rootWorkspaceShellTarget.js";
import { OccupationOnboarding } from "@/onboarding/OccupationOnboarding.js";
import { OnboardingDialog } from "@/onboarding/OnboardingDialog.js";
import { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import { useRemoteWorkspaceTabLifecycle } from "@/root/useRemoteWorkspaceTabLifecycle.js";
import { RemoteWorkspaceControllerProvider } from "@/remote/useRemoteWorkspaceController.js";
import { useRootProviderStateRefresh } from "@/root/useRootProviderStateRefresh.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useRootProviderSettingsSnapshot } from "@/root/useRootProviderSettingsSnapshot.js";
import { useWebRemoteControlAuthSync } from "@/web-remote-control/app/useWebRemoteControlAuthSync.js";
import { useRootOAuthEffects } from "@/root/useRootOAuthEffects.js";
import { consumeZcodeJwtInvalidRestartMarker } from "@/root/zcodeJwtInvalidRestartMarker.js";
import { useDesktopNativeThemeSync } from "@/root/useDesktopNativeThemeSync.js";
import { useRootPlatformEffects } from "@/root/useRootPlatformEffects.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import { useBotBroadcastEffects } from "@/root/useBotBroadcastEffects.js";
import { registerBaseWorkspaceServices } from "@/store/remoteWorkspaceSessionStore.js";
import type { RootProps } from "@/root/types.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import {
  WebRemoteControlFeatureProvider,
  useWebRemoteControlFeatureEnabled,
} from "@/WebRemoteControlFeatureProvider.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import { useWebRemoteControlStatus } from "@/hooks/useWebRemoteControlStatus.js";
import {
  CODE_COMMENT_REMOVE_BROADCAST_CHANNEL,
  CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL,
  isCodeCommentPayload,
  isCodeCommentRemovePayload,
  markCodeCommentRemoved,
} from "@/lib/codeCommentContext.js";
import { useCodeCommentPreviewStore } from "@/store/codeCommentPreviewStore.js";
import { MarketingTouchProvider } from "@/components/marketing-touch/MarketingTouchProvider.js";
import { setUiPerfArmsReporter } from "@/lib/uiPerfArmsTelemetry.js";
import { setSessionOpenArmsReporter } from "@/lib/sessionOpenArmsTelemetry.js";
import { setSendFunnelArmsReporter } from "@/lib/sendFunnelArmsTelemetry.js";
import { RootStartupLoading } from "@/root/RootStartupLoading.js";
import { resolveProviderAvailabilityState } from "@/lib/modelProviderAvailability.js";
import { useProviderAvailabilityLoginEntryGuard } from "@/root/useProviderAvailabilityLoginEntryGuard.js";
import { ensureProviderFamilyDomainMigration } from "@/lib/providerFamilyDomainMigration.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT } from "@/lib/closeActiveContext.js";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  disposeConversationTelemetrySupervisors,
  reconcileConversationTelemetryWorkspaceScopes,
} from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import { installConversationTelemetryParityE2EBridge } from "@/v4/telemetry/conversationTelemetryParityE2E.js";
import { useSourceServerUpdateNotifications } from "@/root/sourceServerUpdateNotifications.js";
import type {
  DeviceAdditionResult,
  DeviceAdditionReturnTarget,
  RemoteConnectionOpenPreference,
} from "@/app-shell/types.js";
import { DEFAULT_LUCIDE_STROKE_WIDTH } from "@/components/icons/windowIcons.js";

type WelcomeScreenOpenReason =
  | "startup-provider-required"
  | "manual-login"
  | "provider-request"
  | "logout-provider-required"
  | "session-expired";

/**
 * Root —— 应用根组件
 *
 * 外层挂载 StoreProvider（连接广播服务）+ TabStoreProvider，内层处理认证和路由。
 */
export function Root(props: RootProps) {
  return (
    <LucideProvider strokeWidth={DEFAULT_LUCIDE_STROKE_WIDTH}>
      {/*
       * 之前通过 lucide.tsx 包装每个图标，把默认 strokeWidth 固定成 1.5。
       * 现在移除包装文件后，如果不在根层统一注入，按钮、列表和工具栏里的 Lucide 图标会回退到 2，
       * 导致同一套 size class 下视觉显得更粗、更挤。这里改用官方 LucideProvider 保持默认值，
       * 同时保留个别图标显式传入 strokeWidth 时的覆盖能力。
       */}
      <TooltipProvider>
        {/*
         * 大会话消息动作里会出现大量 tooltip。Provider 如果跟随每个 tooltip 实例创建，
         * React 点击切换任务时会同步构造数量级相同的 Radix 上下文树；根层共享一次即可保留零延迟配置。
         */}
        <ServiceProvider
          services={props.services}
          composerClientNamespace={props.composerClientNamespace}
          terminalOwnerId={props.terminalOwnerId}
        >
          <PlatformProvider platform={props.platform}>
            <StoreProvider
              broadcastService={props.services.broadcastService}
              initialIsRestoringOAuthSession
            >
              <TabStoreProvider>
                <ProjectDirectoryProvider isDesktop={props.isDesktop}>
                  <DiffsWorkerPoolProvider>
                    <WebRemoteControlFeatureProvider enabled={props.webRemoteControlFeatureEnabled}>
                      <AssistantCodeCommentFeatureProvider
                        enabled={props.assistantCodeCommentCardsEnabled}
                      >
                        <CodingPlanUpgradeDialogProvider>
                          <RewardsProvider desktop={props.isDesktop === true}>
                            <RequestSecurityHost />
                            <MarketingTouchProvider desktop={props.isDesktop === true}>
                              <RemoteConnectionProgressProvider>
                                <DataSyncDialogProvider>
                                  <RootInner {...props} />
                                </DataSyncDialogProvider>
                              </RemoteConnectionProgressProvider>
                            </MarketingTouchProvider>
                          </RewardsProvider>
                        </CodingPlanUpgradeDialogProvider>
                      </AssistantCodeCommentFeatureProvider>
                    </WebRemoteControlFeatureProvider>
                  </DiffsWorkerPoolProvider>
                </ProjectDirectoryProvider>
              </TabStoreProvider>
            </StoreProvider>
          </PlatformProvider>
        </ServiceProvider>
      </TooltipProvider>
    </LucideProvider>
  );
}

function RootInner({
  services,
  platform,
  initialWorkspaceAbsPath,
  unavailableWorkspacePath,
  initialWorkspaceIdentity,
  initialWorkspacePurpose,
  initialTaskId,
  initialTaskDraft,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  restoreSession = true,
  supportsSettings = true,
  allowOpenWorkspace = true,
  preferDirectoryBrowser,
  supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
  allowRemoteWorkspace = true,
  webRemoteControlWorkspaceSwitcher,
  initialSidebarFileTreeOpen,
  initialWebRemoteControlMobileNavigationIntent,
  webRemoteControlTerminalTransportState,
  initialWorkspaceLoadingFallback,
}: RootProps) {
  const credentialRecovery = useCredentialStoreRecovery(isDesktop === true);
  useInterfaceModeTelemetry(platform, isDesktop === true);
  useEffect(() => {
    setRequestSecurityReporter(platform);
    setMcpStorePlatform(platform);
    // 对话 UI perf 只属于 desktop-continuous；Web/mobile 即使能看到权威状态也不装 reporter。
    setUiPerfArmsReporter(isDesktop ? platform : null);
    setSessionOpenArmsReporter(isDesktop ? platform : null);
    // 发送漏斗同理：只在 Electron 桌面端上报，Web/mobile 的 reportArmsCustomEvent 是空实现。
    setSendFunnelArmsReporter(isDesktop ? platform : null);
    return () => {
      setRequestSecurityReporter(null);
      setMcpStorePlatform(null);
      setUiPerfArmsReporter(null);
      setSessionOpenArmsReporter(null);
      setSendFunnelArmsReporter(null);
    };
  }, [isDesktop, platform]);

  useEffect(
    () =>
      installConversationTelemetryParityE2EBridge({
        platform,
        isDesktop: isDesktop === true,
      }),
    [isDesktop, platform],
  );

  useEffect(
    () => () => {
      disposeConversationTelemetrySupervisors();
    },
    [],
  );

  // 动态工作流灰度快照的唯一取数点：
  // 放在 app 级 ServiceProvider 这一层取一次，自动化页与 run 面板只读。消费方可能位于
  // 工作区级 ServiceProvider 内（远程 Host 的 accessor），由它们取数会拿到另一台 Host 的答案。
  useDynamicWorkflowAvailabilityLoader(services.codingPlanSubscriptionService);

  const { intl, locale, localeResolved } = useZCodeIntl();
  const handleRemoteConnectionTargetChange = useSourceServerUpdateNotifications({
    enabled: isDesktop === true,
    management: services.sourceServerManagementService,
  });
  const theme = useZCodeStore((state) => state.theme);
  const user = useZCodeStore((state) => state.user);
  const isRestoringOAuthSession = useZCodeStore((state) => state.isRestoringOAuthSession);
  useWebRemoteControlAuthSync(platform, services.oauthService, user?.id, isRestoringOAuthSession);
  const setUser = useZCodeStore((state) => state.setUser);
  const setIsRestoringOAuthSession = useZCodeStore((state) => state.setIsRestoringOAuthSession);
  const setOAuthError = useZCodeStore((state) => state.setOAuthError);
  const oauthPollingActive = useZCodeStore((state) => state.oauthPollingActive);
  const setOAuthPollingActive = useZCodeStore((state) => state.setOAuthPollingActive);
  const markOAuthSuccess = useZCodeStore((state) => state.markOAuthSuccess);
  const {
    settings: appSettings,
    refresh: refreshAppSettings,
    update: updateAppSettings,
  } = useSettings();
  // docs/dynamic-workflow/launch.md「The user's choice」：设置里的动态工作流选择变化后，通知本窗口
  // 的 Host 重发 CLI 策略（并转发给远程 Host），再重读灰度快照。
  useDynamicWorkflowUserModeSync({
    settingsLoaded: Boolean(appSettings),
    userMode: appSettings?.dynamicWorkflowMode,
    zcodeAgentService: services.zcodeAgentService,
    codingPlanSubscriptionService: services.codingPlanSubscriptionService,
  });
  const [welcomeScreenOpenReason, setWelcomeScreenOpenReason] =
    useState<WelcomeScreenOpenReason | null>(() =>
      consumeZcodeJwtInvalidRestartMarker() ? "session-expired" : null,
    );
  const [providerFamilyDomainMigrationComplete, setProviderFamilyDomainMigrationComplete] =
    useState(false);
  const loginEntryRequest = useZCodeStore((state) => state.loginEntryRequest);
  const rootModelSelectionRead = useModelSelectionServiceView(services.modelSelectionService);
  const rootModelSelectionView =
    rootModelSelectionRead.state.status === "ready" ? rootModelSelectionRead.state.view : null;
  const rootModelSelectionErrorNode =
    rootModelSelectionRead.state.status === "error" ? (
      <div className="fixed right-4 bottom-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-destructive/30 bg-surface-raised px-3 py-2 text-ui-base text-foreground shadow-lg">
        <span className="min-w-0 flex-1">
          {intl.formatMessage({ id: "root.modelSelection.loadFailed" })}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={rootModelSelectionRead.reload}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    ) : null;
  const readRootModelSelectionView = useCallback(
    () => services.modelSelectionService.getView(),
    [services.modelSelectionService],
  );
  const [remoteConnectionDialogOpen, setRemoteConnectionDialogOpen] = useState(false);
  const [remoteConnectionOpenPreference, setRemoteConnectionOpenPreference] =
    useState<RemoteConnectionOpenPreference | null>(null);
  const [remoteConnectionOpenIntentId, setRemoteConnectionOpenIntentId] = useState(0);
  const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false);
  const [remoteConnectionInProgress, setRemoteConnectionInProgress] = useState(false);
  const [remoteConnectionRequestId, setRemoteConnectionRequestId] = useState<string | null>(null);
  const [isCreatingFallbackWorkspace, setIsCreatingFallbackWorkspace] = useState(false);
  const { connectionLogs: remoteConnectionLogs, resetConnectionLogs: resetRemoteConnectionLogs } =
    useRemoteConnectionLogs(remoteConnectionRequestId);
  const [isBootstrappingInitialWorkspace, setIsBootstrappingInitialWorkspace] = useState(
    Boolean(initialWorkspaceAbsPath),
  );
  const acknowledgingReleaseNotesVersionRef = useRef<string | null>(null);
  const previousRemoteConnectionInProgressRef = useRef(false);
  const didRequestFallbackWorkspaceRef = useRef(false);
  const rootInnerMountedRef = useRef(true);
  const [hasEnteredNativeThemeSyncSurface, setHasEnteredNativeThemeSyncSurface] = useState(false);

  useEffect(() => {
    return () => {
      rootInnerMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const disposable = services.broadcastService.onMessage((message) => {
      if (message.channel === APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL) {
        const parsed = appRuntimePreferencesChangedBroadcastPayloadSchema.safeParse(
          message.payload,
        );
        if (!parsed.success) {
          logger.warn("[settings] 丢弃无效的运行时偏好广播", {
            issues: parsed.error.issues,
          });
          return;
        }
        void refreshAppSettings();
        void services.zcodeAgentService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] 同步跨窗口运行时偏好失败", error);
        });
        void services.botsService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] 同步跨窗口 Bot 运行时偏好失败", error);
        });
        return;
      }

      if (message.channel === CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL) {
        if (!isCodeCommentPayload(message.payload) || !message.payload.id) {
          return;
        }
        useCodeCommentPreviewStore.getState().restoreCommentFromAttachment({
          ...message.payload,
          id: message.payload.id,
        });
        return;
      }

      if (message.channel !== CODE_COMMENT_REMOVE_BROADCAST_CHANNEL) {
        return;
      }

      if (!isCodeCommentRemovePayload(message.payload)) {
        return;
      }

      // 关闭文件 tab 后 PreviewPane 会卸载，不能再依赖 PreviewPane 自己监听跨窗口清理事件。
      // 这里在 Root 生命周期内同步清理 renderer 级 preview store，避免发送后重新打开文件又恢复旧 comment。
      markCodeCommentRemoved(message.payload);
      useCodeCommentPreviewStore.getState().removeCommentBySource(message.payload);
    });

    return () => {
      disposable.dispose();
    };
  }, [
    refreshAppSettings,
    services.botsService,
    services.broadcastService,
    services.zcodeAgentService,
  ]);

  useEffect(() => {
    if (!appSettings) {
      return;
    }
    void services.zcodeAgentService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
        pluginAutoRecommendationEnabled: appSettings.pluginAutoRecommendationEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] 初始化运行时偏好失败", error);
      });
    void services.botsService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
        pluginAutoRecommendationEnabled: appSettings.pluginAutoRecommendationEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] 初始化 Bot 运行时偏好失败", error);
      });
  }, [
    appSettings?.askUserQuestionAutoResolutionEnabled,
    appSettings?.modelIoFullRetentionEnabled,
    appSettings?.pluginAutoRecommendationEnabled,
    services.botsService,
    services.zcodeAgentService,
  ]);

  const tabs = useTabStore((state) => state.tabs);
  const windowWorkspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activeTab = activeTabId ? (tabs.find((tab) => tab.id === activeTabId) ?? null) : null;
  const activeWorkspaceTab = activeTab && isWorkspaceTab(activeTab) ? activeTab : null;
  const isSettingsTabActive = activeTab ? isSettingsTab(activeTab) : false;
  const {
    workspaceShellPath,
    workspaceIdentity: workspaceShellIdentity,
    workspaceRemoteSessionId: workspaceShellRemoteSessionId,
  } = resolveRootWorkspaceShellTarget({
    activeWorkspaceTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    // Settings 覆盖时仍使用被覆盖 tab 的完整远程身份，避免通知与侧栏建立重复订阅。
    workspaceTabs: windowWorkspaceTabs,
  });
  const workspaceScopedServices = useWorkspaceServices(
    workspaceShellPath,
    workspaceShellRemoteSessionId,
    workspaceShellIdentity,
  );

  const localWorkspacePathForRemoteConnection = useTabStore((state) => {
    const activeTab = state.activeTabId
      ? state.tabs.find((tab) => tab.id === state.activeTabId)
      : null;
    if (
      !activeTab ||
      !isWorkspaceTab(activeTab) ||
      activeTab.remoteSessionId ||
      activeTab.remoteTarget ||
      activeTab.workspaceIdentity ||
      activeTab.workspacePurpose === "conversation"
    ) {
      return undefined;
    }
    return activeTab.workspacePath;
  });
  const addTab = useTabStore((state) => state.addTab);
  const activateTabByPath = useTabStore((state) => state.activateTabByPath);
  const tabStoreApi = useTabStoreApi();
  const deviceAdditionReturn = useRef<{
    target: DeviceAdditionReturnTarget;
    completion?: "checking" | "delivered";
    tabId: string | null;
    workspaceKey?: string;
  } | null>(null);
  const finishDeviceAddition = useCallback(
    async (
      result: DeviceAdditionResult,
      background = false,
      canDeliver: () => boolean = () => true,
    ) => {
      const pending = deviceAdditionReturn.current;
      // 同步消费；异步资格校验仍保留同一 owner 标识，新入口替换后旧结果无权导航。
      if (!pending) return false;
      if (pending.completion && result.kind === "connected") return true;
      pending.completion = "checking";
      const isCurrent = () =>
        deviceAdditionReturn.current === pending && pending.target.isCurrent();
      const deliver = (value: DeviceAdditionResult, inBackground: boolean) => {
        if (!isCurrent()) return;
        const tabs = tabStoreApi.getState();
        const tab = tabs.tabs.find((item) => item.id === pending.tabId);
        const workspaceKey =
          tab?.kind === "workspace"
            ? tab.workspaceIdentity?.trim() || tab.workspacePath
            : undefined;
        if ((pending.tabId && !tab) || pending.workspaceKey !== workspaceKey) return;
        if (pending.tabId && !inBackground) tabs.activateTab(pending.tabId);
        logger.debug("[Root] return from device addition", {
          kind: value.kind,
          tabId: pending.tabId,
        });
        pending.completion = "delivered";
        return pending.target.finish(value);
      };
      try {
        if (result.kind === "connected" && pending.target.canFinish) {
          const valid = await pending.target.canFinish(result);
          if (!isCurrent()) return true;
          if (!valid) {
            await deliver({ kind: "cancelled", background: true }, true);
            return true;
          }
        }
        if (result.kind === "connected" && !canDeliver()) {
          pending.completion = undefined;
          return true;
        }
        const finished = deliver(result, background);
        // 显式取消必须撤销在途校验；迟到成功不能再使用同一返回引用恢复旧聊天。
        if (result.kind === "cancelled" && deviceAdditionReturn.current === pending)
          deviceAdditionReturn.current = null;
        await finished;
      } catch (error) {
        if (!isCurrent()) return true;
        // 读取失败不是取消。保留原 owner 和禁发约束，让连接 flow 显示原因并提供重试/取消。
        pending.completion = undefined;
        throw error;
      }
      return true;
    },
    [tabStoreApi],
  );
  const webRemoteControlFeatureEnabled = useWebRemoteControlFeatureEnabled();
  // Bugfix: WebRemoteControlDialog 只是可开关的展示入口，不能由它的本地 state 决定全局远控状态。
  // Root 直接轮询 main 进程状态，让远控会话 running/active 成为唯一真值来源。
  const webRemoteControlStatus = useWebRemoteControlStatus({
    enabled: Boolean(webRemoteControlFeatureEnabled && isDesktop),
  });
  const webRemoteControlSessionActive =
    webRemoteControlStatus.status === "running" || webRemoteControlStatus.status === "active";
  const refreshProviderState = useRootProviderStateRefresh(services);
  useRootProviderSettingsSnapshot(services);
  useEffect(() => {
    let disposed = false;

    void (async () => {
      try {
        await ensureProviderFamilyDomainMigration(services);
      } catch (error) {
        logger.warn("[Root] provider family domain 迁移失败，继续启动", {
          error,
        });
      } finally {
        if (!disposed) {
          setProviderFamilyDomainMigrationComplete(true);
          try {
            await refreshAppSettings();
            await refreshProviderState();
          } catch (refreshError) {
            logger.warn("[Root] provider family domain 迁移后刷新状态失败", {
              error: refreshError,
            });
          }
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [refreshAppSettings, refreshProviderState, services]);

  const shouldPreferDirectoryBrowser = Boolean(preferDirectoryBrowser);
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  const isResolvingStartupAuthState = isRestoringOAuthSession;
  const rootProviderAvailability = resolveProviderAvailabilityState({
    modelSelectionView: rootModelSelectionView,
  });
  const providerStartupSyncPending = isProviderStartupSyncPending({
    providerFamilyDomainMigrationComplete,
    modelSelectionViewHydrated:
      rootProviderAvailability.hydrated || rootModelSelectionRead.state.status === "error",
  });
  const isWebRemoteControlRoot = Boolean(webRemoteControlWorkspaceSwitcher);
  const providerAvailabilityLoginEntryGuardEnabled =
    shouldEnableProviderAvailabilityLoginEntryGuard({
      isWebRemoteControlRoot,
    });
  const { startupCheckCompleted: providerAvailabilityStartupCheckCompleted } =
    useProviderAvailabilityLoginEntryGuard({
      enabled: providerAvailabilityLoginEntryGuardEnabled,
      user,
      isRestoringOAuthSession: isResolvingStartupAuthState || providerStartupSyncPending,
      providerFamilyDomain: appSettings?.providerFamilyDomain,
      modelSelectionView: rootModelSelectionView,
      modelSelectionError:
        rootModelSelectionRead.state.status === "error"
          ? rootModelSelectionRead.state.error
          : undefined,
      refreshProviderState,
      readModelSelectionView: readRootModelSelectionView,
      setLoginEntryOpen: (open) => {
        setWelcomeScreenOpenReason((currentReason) => {
          if (open) {
            return "startup-provider-required";
          }
          // JWT 过期提示确认后会先写入 session-expired，随后 provider
          // 启动门禁以 open=false 收尾。这里若无条件清空，会覆盖重新登录页并回到工作区。
          // 门禁只能关闭自己拥有的启动登录态，不能清理其它交互来源的 reason。
          return currentReason === "startup-provider-required" ? null : currentReason;
        });
      },
    });
  const isResolvingProviderStartupState = shouldResolveProviderStartupState({
    isWebRemoteControlRoot,
    providerStartupSyncPending,
    providerAvailabilityStartupCheckCompleted,
  });
  const isStartupProviderLoginEntryOpen = welcomeScreenOpenReason === "startup-provider-required";
  // 首次安装时 provider 登录入口判定晚于 workspace 注入，ChatView 会先 mount 并触发草稿预热。
  // 这里把 provider 启动检查纳入 workspace 恢复门禁，避免未连接账号前启动 ZCode session。
  const canRestoreWorkspaceSession =
    !isResolvingStartupAuthState &&
    !isResolvingProviderStartupState &&
    !isStartupProviderLoginEntryOpen;
  const workspacePersistenceGate = useMemo<WorkspacePersistenceGate>(
    () => ({ canPersist: false, restoreFailed: false }),
    [],
  );

  useEffect(() => {
    // 跨 workspace 任务列表需要一个稳定的“本地/root services”入口。
    // 桌面端 renderer 启动时会注册一次，但 Web 和测试入口也会直接挂 Root；
    // 这里再以 Root props 兜底注册，避免当前激活远端 workspace 时本地列表误用远端 host。
    registerBaseWorkspaceServices(services);
  }, [services]);

  useBotBroadcastEffects(services, tabStoreApi);

  const handleOpenRemoteConnection = useCallback(
    (preference?: RemoteConnectionOpenPreference) => {
      if (
        preference?.returnTarget &&
        (remoteConnectionInProgress ||
          (deviceAdditionReturn.current && !deviceAdditionReturn.current.completion))
      )
        return false;
      if (!remoteConnectionInProgress) {
        // 新入口替换尚在资格校验的旧返回，先解除旧 owner 的门禁，再使其迟到结果失效。
        deviceAdditionReturn.current?.target.onVisibilityChange?.(false);
        const tabs = tabStoreApi.getState();
        const tab = tabs.tabs.find((item) => item.id === tabs.activeTabId);
        deviceAdditionReturn.current = preference?.returnTarget
          ? {
              target: preference.returnTarget,
              tabId: tabs.activeTabId,
              workspaceKey:
                tab?.kind === "workspace"
                  ? tab.workspaceIdentity?.trim() || tab.workspacePath
                  : undefined,
            }
          : null;
        // 返回目标曾被等同于新增设备，导致已有设备重连也切到设置。
        if (preference?.returnTarget?.kind === "add-device") {
          setPendingSettingsSectionIntent("remoteDevices");
          tabStoreApi.getState().openSettingsTab();
        }
      }
      // 明确入口与卡片恢复分离：空闲流程接受新意图，即使 Profile/目标值相同也重新读取。
      if (!remoteConnectionInProgress) {
        setRemoteConnectionOpenPreference(preference ?? null);
        setRemoteConnectionOpenIntentId((current) => current + 1);
      }
      deviceAdditionReturn.current?.target.onVisibilityChange?.(true);
      setRemoteConnectionDialogOpen(true);
    },
    [remoteConnectionInProgress, tabStoreApi],
  );
  const handleOpenDirectoryBrowser = useCallback(() => {
    setDirectoryBrowserOpen(true);
  }, []);
  const handleReauthenticationRequired = useCallback(() => {
    setWelcomeScreenOpenReason("session-expired");
  }, []);
  const {
    setWorkspaceActionError,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    handleLogout,
    handleSelectProject,
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
    handleOpenWorkspace,
    handleOpenFolderFromWorkspaceMenu,
    handleCreateTask,
    handleBackFromSettings,
    handleOpenTaskFromSettings,
  } = useRootWorkspaceActions({
    intl,
    platform,
    services,
    tabStoreApi,
    addTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    supportsSettings,
    isDesktop,
    allowOpenWorkspace,
    preferDirectoryBrowser: shouldPreferDirectoryBrowser,
    openDirectoryBrowser: handleOpenDirectoryBrowser,
    refreshProviderState,
    updateAppSettings,
    setOAuthError,
    setUser,
    onProviderFamilyDomainClearedAfterLogout: () => {
      setWelcomeScreenOpenReason("logout-provider-required");
    },
    userId: user?.id,
    onOpenRemoteConnection: allowRemoteWorkspace ? handleOpenRemoteConnection : undefined,
    openRemoteProjectWorkspace: openPreparedRemoteProjectWorkspace,
    openMobileProjectDraft: webRemoteControlWorkspaceSwitcher?.openProjectDraft,
    workbenchGroupClientMode: isWebRemoteControlRoot
      ? "web-remote-replayable"
      : "desktop-continuous",
  });
  const handleRemoteWorkspaceActivated = useCallback(
    ({
      workspacePath,
      workspaceIdentity,
      restoreSelection,
      projectId,
    }: {
      workspacePath: string;
      workspaceIdentity: string;
      restoreSelection?: boolean;
      projectId?: string | null;
    }) => {
      // 桌面重连只恢复连接，不得把已选会话覆盖成草稿；手机仍沿用 replayable 入口。
      const selectedTask = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity).activeTaskId;
      if (!isDesktop || !restoreSelection || !selectedTask) {
        if (projectId !== undefined)
          logger.info("[Root] 按原项目初始化远程草稿", { workspaceIdentity, projectId });
        startDraftInWorkspace(workspacePath, workspaceIdentity, { projectId });
      }
    },
    [isDesktop, startDraftInWorkspace],
  );

  const {
    remoteWorkspaceSessions,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceRecoveryByWorkspaceKey,
    remoteWorkspaceErrorByWorkspaceKey,

    buildPersistedTabPatch,
    restorePersistedSession: restoreWorkspaceTabs,
    handleCancelRemoteProject,
    handleSelectRemoteProject,
    handleConnectRemote,
    handleReconnectRemoteWorkspace,
    remoteWorkspaceController,
  } = useRemoteWorkspaceHistory({
    intl,
    services,
    platform,
    supportsSettings,
    isDesktop,
    allowRemoteWorkspace,
    // conversation backing workspace 只属于本地桌面主恢复链路；远程窗口和手机
    // shared-host attachment 不能因此创建独立本地 runtime 或改变 replayable 边界。
    ensureConversationWorkspaceOnRestore: isDesktop && restoreSession && !initialWorkspaceIdentity,
    deferInactiveWorkspaceRestore: isDesktop && restoreSession && !initialWorkspaceIdentity,
    unavailableWorkspacePath,
    tabStoreApi,
    activateTabByPath,
    addTab,
    persistenceGate: workspacePersistenceGate,
    onWorkspaceActivated: handleRemoteWorkspaceActivated,
    onOpenRemoteConnection: handleOpenRemoteConnection,
    manuallyOpeningWorkspaceTabId:
      remoteConnectionDialogOpen || remoteConnectionInProgress
        ? remoteConnectionOpenPreference?.preferredWorkspaceTabId
        : undefined,
  });
  const waitForRemoteWorkspaceConnection = useRemoteWorkspaceConnectionGate(
    reconnectingRemoteWorkspaceKeys,
  );

  async function openPreparedRemoteProjectWorkspace(target: {
    expectedMembershipId?: string;
    hostId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    projectId: string | null;
    isCurrent?: () => boolean;
  }): Promise<void> {
    if (!target.workspaceIdentity) throw new Error("project.workspace-identity-required");
    if (!services.remoteProjectService) throw new Error("remote-project.service-unavailable");
    await attachRemoteProjectWorkspace({
      ...target,
      workspaceIdentity: target.workspaceIdentity,
      remoteService: services.remoteProjectService,
      ...(target.expectedMembershipId ? { projectService: services.projectService } : {}),
      findSession: (identity) =>
        Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById).find(
          (session) => session.workspaceIdentity === identity,
        ),
      waitForPendingConnection: waitForRemoteWorkspaceConnection,
      connect: handleConnectRemote,
      cancel: handleCancelRemoteProject,
      bind: async (remoteSessionId, path, isCurrent) => {
        const session = useRemoteWorkspaceSessionStore.getState().sessionsById[remoteSessionId];
        await remoteWorkspaceController.dispatch({
          type: "open-project",
          sourceServerId: session?.sourceServerId ?? "",
          path,
          remoteSessionId,
          draftProjectId: target.projectId,
          preparedWorkspaceIdentity: target.workspaceIdentity,
          isCurrent,
        });
      },
    });
  }

  const handleResolveConversationWorkspaceForShell = useCallback(
    async () =>
      // Bug 原因：此前只回传 workspacePath，Shell 再按路径反查 identity；多设备 conversation 路径
      // 相同时会归到错误 Source。改为在这里按 Source 归属一次性解析 path + identity。
      await resolveConversationWorkspaceTarget({
        getTabs: () => tabStoreApi.getState().tabs,
        activeWorkspacePath,
        activeWorkspaceIdentity,
        resolveLocalConversationWorkspacePath: handleResolveConversationWorkspace,
      }),
    [activeWorkspacePath, activeWorkspaceIdentity, handleResolveConversationWorkspace, tabStoreApi],
  );

  useEffect(() => {
    if (!platform.onWebRemoteControlReconnectWorkspace) {
      return;
    }

    return platform.onWebRemoteControlReconnectWorkspace(async (request) => {
      try {
        await handleReconnectRemoteWorkspace(request.workspaceKey, {
          activateWorkspaceAfterReconnect: false,
          showErrorToast: false,
          throwOnFailure: true,
        });
        return {
          requestId: request.requestId,
          workspaceKey: request.workspaceKey,
          success: true,
        };
      } catch (error) {
        return {
          requestId: request.requestId,
          workspaceKey: request.workspaceKey,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }, [handleReconnectRemoteWorkspace, platform]);
  useWebRemoteControlRendererActions(platform);

  useEffect(() => {
    // Bugfix: fileDisplay 默认不传 basePath 时需要落到“当前激活 workspace”。
    // 之前纯工具层拿不到窗口内的 workspace 上下文，只能退回绝对路径，导致 mention / 文件展示在输入框里不够简洁。
    // 这里由 Root 在 workspace 切换时同步一份当前上下文，既保留工具层复用性，也不把 Zustand 依赖硬塞进工具函数。
    setDefaultFileDisplayBasePath(activeWorkspacePath);
  }, [activeWorkspacePath]);

  useEffect(() => {
    if (!activeWorkspacePath) {
      return;
    }

    setWorkspaceActionError(null);
  }, [activeWorkspacePath, setWorkspaceActionError]);

  const composerClientNamespace = useComposerClientNamespace();
  const restorePersistedSession = useCallback(
    async (...args: Parameters<typeof restoreWorkspaceTabs>) => {
      const restored = await restoreWorkspaceTabs(...args);
      const restoreDraftIntents = () => {
        // 桌面刷新通过历史 tab 恢复，不经过 initialWorkspace 入口。先恢复项目意图，
        // 再打开首屏门禁，避免 Composer 按未归类范围读取并预热同目录的项目草稿。
        for (const tab of tabStoreApi.getState().tabs) {
          if (!isWorkspaceTab(tab)) continue;
          const workspace = useZCodeSessionStore
            .getState()
            .getWorkspaceState(tab.workspacePath, tab.workspaceIdentity);
          if (workspace.activeTaskId || workspace.draftProjectId !== undefined) continue;
          const scope = readComposerWorkspaceScope(
            tab.workspacePath,
            tab.workspaceIdentity,
            composerClientNamespace,
          );
          if (!scope) continue;
          const draft = readV4ComposerDraft(
            tab.workspacePath,
            tab.workspaceIdentity,
            V4_DRAFT_SCOPE_ROOT,
            scope,
          );
          useZCodeSessionStore
            .getState()
            .startDraft(tab.workspacePath, undefined, tab.workspaceIdentity, {
              projectId: scope.projectId,
              taskGroupId: draft?.taskGroupId,
            });
          logger.info("[Root] 已恢复新建草稿归属", {
            workspacePath: tab.workspacePath,
            workspaceIdentity: tab.workspaceIdentity,
            projectId: scope.projectId,
          });
        }
      };
      restoreDraftIntents();
      return {
        ...restored,
        ...(restored.deferredRestore
          ? {
              deferredRestore: () => {
                restored.deferredRestore!();
                restoreDraftIntents();
              },
            }
          : {}),
      };
    },
    [restoreWorkspaceTabs, composerClientNamespace, tabStoreApi],
  );

  const { isRestoring, hasCompletedInitialRestore, hasCompletedFullRestore } = useTabPersistence({
    settingService: supportsSettings ? services.settingService : undefined,
    // 首次安装未连接账号时，provider 登录入口判定会晚于 workspace 恢复。
    // 如果这里先恢复 workspace，ChatView mount 会触发草稿 session 预热并在登录页背后报错。
    restoreSession: restoreSession && canRestoreWorkspaceSession,
    persistSession: restoreSession && canRestoreWorkspaceSession,
    persistenceGate: workspacePersistenceGate,
    restorePersistedSession,
    buildPersistPatch: buildPersistedTabPatch,
  });

  useEffect(() => {
    if (!isDesktop || !hasCompletedFullRestore) return;
    // Bug 原因：active-first 的单 workspace 只是 Renderer 首屏投影，若立刻对外同步，
    // 会短暂撤销其他 workspace 的 telemetry scope。完整补齐后才能发布全量集合。
    reconcileConversationTelemetryWorkspaceScopes(
      windowWorkspaceTabs.map((tab) => ({
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      })),
    );
  }, [hasCompletedFullRestore, isDesktop, windowWorkspaceTabs]);

  // Bug 原因（2026-08-16 web 远控卡死）：官方版本请求安全校验应答方曾只随桌面正在展示的
  // session pane 挂载，web 远控新建会话时桌面没有对应 pane、web 端无应答方，
  // headers 请求永远滞留 pending，任务永久「工作中」。应答方必须常驻桌面窗口、
  // 覆盖每个打开的 workspace tab，与展示状态解耦；Web 端保持零订阅，桌面仍是唯一权威。
  const requestSecurityBridgeNode = isDesktop ? (
    <RequestSecurityWorkspaceBridge workspaceTabs={windowWorkspaceTabs} />
  ) : null;

  const { tryRefresh, clearCredentials } = useTokenRefresh();
  void tryRefresh;
  void clearCredentials;
  // 启动阻塞是桌面窗口保护期，手机 Web 远控在进入 Root 前已有配对/加载页。
  // Web 端继续使用该 gate 会在 workspace tab 注入前渲染空 RootShell，露出浏览器白底。
  const isStartupRenderBlocked = shouldShowRootStartupLoading({
    isDesktop,
    welcomeScreenOpen: Boolean(welcomeScreenOpenReason),
    isResolvingStartupAuthState,
    isResolvingProviderStartupState,
    isRestoring,
    isBootstrappingInitialWorkspace: isBootstrappingInitialWorkspace || isCreatingFallbackWorkspace,
  });

  const launchReportedRef = useRef(false);
  useEffect(() => {
    if (
      !shouldReportLaunchToInput({
        isStartupRenderBlocked,
        welcomeScreenOpen: Boolean(welcomeScreenOpenReason),
        alreadyReported: launchReportedRef.current,
      })
    ) {
      return;
    }
    launchReportedRef.current = true;
    const timings = readRendererLaunchTimings();
    if (!timings || !timings.marks) {
      return; // 锚点缺失(非桌面/未注入 marks),整批跳过
    }
    reportUiLaunchToInput({
      marks: timings.marks,
      rendererStart: timings.rendererStart,
      reactCommit: timings.reactCommit,
      inputReady: Date.now(), // T6
      sessionId: `launch-${timings.marks.createdAt}`,
    });
  }, [isStartupRenderBlocked, welcomeScreenOpenReason]);

  useRootPlatformEffects({
    clientMode: isWebRemoteControlRoot ? "web-remote-replayable" : "desktop-continuous",
    initialWorkspaceAbsPath,
    initialWorkspaceIdentity,
    initialWorkspacePurpose,
    initialTaskId,
    initialTaskDraft,
    // Bugfix: 系统右键/Service 冷启动传入 initialWorkspacePath 时，必须先恢复历史 tabs，
    // 再把目标 workspace 合并并激活。否则先 addTab 会被 restoreTabs 整体替换掉；
    // 直接禁用 restoreSession 又会让其他 workspace 全部消失。
    canBootstrapInitialWorkspace: canRestoreWorkspaceSession && hasCompletedInitialRestore,
    addTab,
    setIsBootstrappingInitialWorkspace,
    platform,
    activateTabByPath,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    openWorkspace: handleOpenWorkspace,
    openWorkspacePath: handleSelectProject,
    setWorkspaceActionError,
    allowOpenWorkspace,
    isDesktop,
    locale,
    localeResolved,
    tabs,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    webRemoteControlFeatureEnabled,
    hasCompletedFullTabRestore: hasCompletedFullRestore,
    intl,
    isRestoringOAuthSession: isResolvingStartupAuthState || providerStartupSyncPending,
  });

  useEffect(() => {
    if (!platform.onCloseActiveContextRequest) {
      return;
    }

    return platform.onCloseActiveContextRequest(() => {
      const event = new Event(CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT, {
        cancelable: true,
      });
      window.dispatchEvent(event);
      if (event.defaultPrevented) {
        return;
      }

      // 关闭请求先广播给 workspace 层判断 side pane active tab。
      // 没有可见 workspace 或没有可关闭的 side pane tab 时，才回落到关窗口语义。
      void platform.executeDesktopCommand(DesktopCommandIds.CloseWindow);
    });
  }, [platform]);

  useRootOAuthEffects({
    accountIntentKey: JSON.stringify([
      user?.id,
      appSettings?.providerFamilyDomain,
      appSettings?.providerFamilyConnectionSelections,
    ]),
    platform,
    services,
    refreshProviderState,
    refreshAppSettings,
    setUser,
    setIsRestoringOAuthSession,
    setOAuthError,
    oauthPollingActive,
    setOAuthPollingActive,
    markOAuthSuccess,
    onReauthenticationRequired: handleReauthenticationRequired,
  });

  useEffect(
    () =>
      platform.onPostUpdateReleaseNotes((payload) => {
        logger.info("[Root] 收到更新说明，改为静默确认", {
          version: payload.version,
          title: payload.title,
        });
        if (acknowledgingReleaseNotesVersionRef.current === payload.version) {
          return;
        }

        // 自动更新每次命中待展示 release notes 都会走到这里，
        // 之前 Root 会立刻把 payload 送进对话框状态，导致用户每次更新都被强制弹窗打断。
        // 这次需求只移除弹窗本身，因此这里改成收到后直接静默 ack，
        // 既不影响“更新已下载”按钮/菜单/安装链路，也避免 pending 状态残留到下次启动后再次触发。
        acknowledgingReleaseNotesVersionRef.current = payload.version;
        void platform
          .acknowledgePostUpdateReleaseNotes(payload.version)
          .then(() => {
            logger.info("[Root] 更新说明已静默确认", {
              version: payload.version,
            });
          })
          .catch((error) => {
            logger.error("[Root] 更新说明静默确认失败", {
              version: payload.version,
              error,
            });
          })
          .finally(() => {
            if (acknowledgingReleaseNotesVersionRef.current === payload.version) {
              acknowledgingReleaseNotesVersionRef.current = null;
            }
          });
      }),
    [platform],
  );

  const canEnterNativeThemeSyncSurface = Boolean(
    !isStartupRenderBlocked &&
    !welcomeScreenOpenReason &&
    (workspaceShellPath || isSettingsTabActive),
  );

  useEffect(() => {
    if (!canEnterNativeThemeSyncSurface) {
      return;
    }

    // macOS nativeTheme 会影响窗口 vibrancy。这里等 RootStartupLoading
    // 真正退出并进入主界面/设置页后一轮再允许同步，避免启动壳背景被应用主题提前改写。
    setHasEnteredNativeThemeSyncSurface(true);
  }, [canEnterNativeThemeSyncSurface]);

  useDesktopNativeThemeSync({
    enabled: hasEnteredNativeThemeSyncSurface,
    isDesktop,
    platform,
    theme,
  });

  const handleRemoteWorkspaceUserClose = useCallback(
    (workspaceKeys: string[]) => {
      for (const workspaceKey of workspaceKeys) {
        void remoteWorkspaceController.dispatch({
          type: "close-workspace",
          workspaceKey,
          origin: "user-close",
        });
      }
    },
    [remoteWorkspaceController],
  );

  useRemoteWorkspaceTabLifecycle({
    tabs,
    activeWorkspaceTab,
    platform,
    tabStoreApi,
    onRemoteWorkspaceTabsClosed: handleRemoteWorkspaceUserClose,
  });

  useEffect(() => {
    if (
      shouldBlockRootRender({
        isResolvingStartupAuthState,
        isResolvingProviderStartupState,
        isRestoring,
        isBootstrappingInitialWorkspace,
      }) ||
      isStartupProviderLoginEntryOpen ||
      workspaceShellPath ||
      isSettingsTabActive ||
      !allowOpenWorkspace ||
      didRequestFallbackWorkspaceRef.current
    ) {
      return;
    }

    didRequestFallbackWorkspaceRef.current = true;
    setIsCreatingFallbackWorkspace(true);
    // 以前 tab store 的默认空态会把 Root 带到打开工作区中间页。
    // 删除整页流程后，启动恢复为空或入口没有传 initialWorkspacePath 时必须在 Root
    // 兜底落到默认 workspace，避免用户先看到一张“打开工作区”中间页或空白页。
    // 这里不能用当前 effect 的 cleanup 作为异步取消标记：setIsCreatingFallbackWorkspace
    // 或 addTab 后的 workspaceShellPath 变化都会让 React 先跑 cleanup，若因此跳过 finally，
    // 启动 loading gate 会永远保持 true。
    services.fileService
      .ensureConversationWorkspace()
      .then((result) => {
        // 启动兜底创建目录可能早于会话恢复发起、晚于恢复完成返回。
        // 返回后必须按 tab store 最新 active workspace 再判一次，避免迟到的默认项目抢走上次恢复的 tab。
        if (
          !shouldOpenFallbackWorkspaceAfterCreate({
            isMounted: rootInnerMountedRef.current,
            activeWorkspacePath: tabStoreApi.getState().activeWorkspacePath,
          })
        ) {
          return;
        }
        handleSelectConversationWorkspace(result.path);
      })
      .catch((error) => {
        if (!rootInnerMountedRef.current) {
          return;
        }
        logger.error("[Root] 启动兜底创建默认 workspace 失败", { error });
        setWorkspaceActionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (rootInnerMountedRef.current) {
          setIsCreatingFallbackWorkspace(false);
        }
      });
  }, [
    allowOpenWorkspace,
    handleSelectConversationWorkspace,
    isBootstrappingInitialWorkspace,
    isResolvingProviderStartupState,
    isResolvingStartupAuthState,
    isRestoring,
    isSettingsTabActive,
    isStartupProviderLoginEntryOpen,
    services.fileService,
    setWorkspaceActionError,
    tabStoreApi,
    workspaceShellPath,
  ]);

  useEffect(() => {
    if (!workspaceShellPath) {
      return;
    }

    logger.info(
      `[Root] settings view ${isSettingsTabActive ? "open" : "closed"} workspace=${workspaceShellPath}`,
    );
  }, [isSettingsTabActive, workspaceShellPath]);

  useEffect(() => {
    if (!loginEntryRequest) {
      return;
    }
    // 登录入口已从模态弹窗收敛为 WelcomeScreen。
    // provider 连接请求仍要先退出首次启动引导语义，避免连接完成后误创建默认 workspace。
    setWelcomeScreenOpenReason("provider-request");
  }, [loginEntryRequest]);

  // 登录入口不依赖会话；保持引用稳定，避免草稿更新穿透侧栏 memo。
  const handleOpenLoginEntry = useCallback(() => {
    setWelcomeScreenOpenReason("manual-login");
  }, []);
  const handleWelcomeScreenComplete = useCallback(
    async (reason: LoginCompleteReason) => {
      await refreshAppSettings();
      if (
        welcomeScreenOpenReason !== "startup-provider-required" ||
        workspaceShellPath ||
        !allowOpenWorkspace
      ) {
        setWelcomeScreenOpenReason(null);
        return;
      }

      try {
        await handleEnsureConversationWorkspace();
      } catch (error) {
        logger.error("[Root] 登录后创建默认 workspace 失败", {
          error,
          reason,
        });
      } finally {
        setWelcomeScreenOpenReason(null);
      }
    },
    [
      allowOpenWorkspace,
      handleEnsureConversationWorkspace,
      refreshAppSettings,
      welcomeScreenOpenReason,
      workspaceShellPath,
    ],
  );
  const remoteProjectIntentEpoch = useRef(0);
  const [remoteProjectSelection, setRemoteProjectSelection] = useState<{
    host: RemoteProjectHost;
    path: string;
    sessionId: string;
  } | null>(null);
  const selectDirectoryForRemoteProject = useCallback(
    async (sessionId: string, path: string, localWorkspacePath?: string) => {
      const epoch = remoteProjectIntentEpoch.current;
      const session = useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId];
      if (!session?.target || !services.remoteProjectService)
        throw new Error("project.connection-unavailable");
      const identity = session.sourceServerId
        ? buildServerRemoteWorkspaceIdentity({
            serverId: session.sourceServerId,
            workspacePath: path,
          })
        : buildRemoteWorkspaceIdentity(path, session.target);
      const hostId = remoteHostIdFromWorkspaceIdentity(identity);
      const directory = await services.remoteProjectService.readDirectory();
      if (epoch !== remoteProjectIntentEpoch.current) throw new Error("project.creation-cancelled");
      const host = directory.hosts.find((item) => item.id === hostId);
      if (!host) throw new Error("remote-project.host-removed");
      if (
        remoteConnectionOpenPreference?.preferredWorkspaceTabId ||
        remoteConnectionOpenPreference?.preferredProjectEntryId
      ) {
        // 原项目的认证/安装/升级完成应回到原目录，不能误入新建项目编辑。
        const retained = directory.entries.find(
          (entry) =>
            entry.hostId === host.id &&
            (!remoteConnectionOpenPreference.preferredProjectEntryId ||
              entry.id === remoteConnectionOpenPreference.preferredProjectEntryId) &&
            (entry.roots.some((root) => root.rootPath === path) ||
              entry.legacyWorkspace?.workspacePath === path),
        );
        if (!retained)
          throw Object.assign(new Error("remote-project.entry-not-found"), {
            code: "remote-connection-canceled",
          });
        let draftProjectId: string | undefined;
        // 会话重连只恢复原选择；打开项目才解析草稿归属，避免阻止已删除项目的历史会话重连。
        if (!remoteConnectionOpenPreference.preferredWorkspaceTabId) {
          if (!services.projectService) throw new Error("project.service-unavailable");
          // 入口 ID 只校验成员，不会初始化草稿归属；不能沿用本地同目录旧缓存。
          const project = resolveEntryProject(
            retained,
            await services.projectService.readTree({ hostId: host.id }),
          );
          if (!project || project.deleted || !project.roots.some((root) => root.rootPath === path))
            throw new Error("project.not-found");
          draftProjectId = project.id;
        }
        await remoteWorkspaceController.dispatch({
          type: "open-project",
          sourceServerId: session.sourceServerId ?? "",
          remoteSessionId: sessionId,
          path,
          localWorkspacePath,
          preparedWorkspaceIdentity: identity,
          draftProjectId,
          isCurrent: async () => {
            if (epoch !== remoteProjectIntentEpoch.current) return false;
            // bind 会等待远端 IO；初检快照不能授权迟到结果复活已移除/换代的成员。
            const current = await services.remoteProjectService!.readDirectory();
            return (
              epoch === remoteProjectIntentEpoch.current &&
              current.hosts.some(
                (item) => item.id === host.id && item.membershipId === host.membershipId,
              ) &&
              current.entries.some(
                (entry) =>
                  entry.id === retained.id &&
                  entry.hostId === host.id &&
                  (entry.roots.some((root) => root.rootPath === path) ||
                    entry.legacyWorkspace?.workspacePath === path),
              )
            );
          },
        });
        return;
      }
      // 选目录只进入项目编辑，保存与入口登记完成之前不打开会话。
      setRemoteProjectSelection({ host, path, sessionId });
    },
    [
      services.remoteProjectService,
      services.projectService,
      remoteConnectionOpenPreference,
      remoteWorkspaceController,
    ],
  );
  const handleRemoteConnectionDialogOpenChange = useCallback((open: boolean) => {
    const target =
      deviceAdditionReturn.current?.completion === "delivered"
        ? undefined
        : deviceAdditionReturn.current?.target;
    if (target?.isCurrent()) target.onVisibilityChange?.(open);
    if (!open) remoteProjectIntentEpoch.current++;
    setRemoteConnectionDialogOpen(open);
  }, []);
  const handleRemoteProjectIntentCleared = useCallback(() => {
    // 改选新连接只清除原项目恢复意图；从设置进入仍须独立完成设备管理。
    setRemoteConnectionOpenPreference((current) =>
      current?.completion === "device-management"
        ? { completion: "device-management", returnTarget: current.returnTarget }
        : null,
    );
  }, []);

  const remoteConnectionDialog = allowRemoteWorkspace ? (
    <>
      {remoteProjectSelection && services.projectService && services.remoteProjectService ? (
        <RemoteProjectPicker
          key={remoteProjectSelection.host.membershipId}
          host={remoteProjectSelection.host}
          initialRoots={[remoteProjectSelection.path]}
          service={services.projectService}
          remoteService={services.remoteProjectService}
          onClose={() => {
            remoteProjectIntentEpoch.current++;
            const sessionId = remoteProjectSelection.sessionId;
            setRemoteProjectSelection(null);
            void handleCancelRemoteProject(sessionId).catch((error) =>
              logger.warn("[Root] 释放项目创建 attachment 失败", error),
            );
          }}
          onSaved={async () => {}}
        />
      ) : null}
      <SSHDialog
        completion={remoteConnectionOpenPreference?.completion}
        onCancelled={(background) => {
          void finishDeviceAddition(
            { kind: "cancelled", ...(background ? { background: true } : {}) },
            background,
          ).catch((error) => logger.warn("[Root] device addition cancellation failed", error));
        }}
        onDeviceConnected={async (sourceServerId, canDeliver) => {
          if (await finishDeviceAddition({ kind: "connected", sourceServerId }, false, canDeliver))
            return;
          if (canDeliver?.() === false) return;
          setPendingSettingsSectionIntent("remoteDevices", { sourceServerId });
          tabStoreApi.getState().openSettingsTab();
        }}
        onConnect={handleConnectRemote}
        onSelectProject={selectDirectoryForRemoteProject}
        onCancelSession={handleCancelRemoteProject}
        localWorkspacePath={localWorkspacePathForRemoteConnection}
        isWindowsDesktop={isWindowsDesktop}
        remoteWorkspaceSessions={remoteWorkspaceSessions}
        open={remoteConnectionDialogOpen && !remoteProjectSelection}
        onOpenChange={handleRemoteConnectionDialogOpenChange}
        onProjectIntentCleared={handleRemoteProjectIntentCleared}
        onFlowActiveChange={setRemoteConnectionInProgress}
        onFlowRequestIdChange={setRemoteConnectionRequestId}
        onFlowTargetChange={handleRemoteConnectionTargetChange}
        openIntentId={remoteConnectionOpenIntentId}
        initialFailure={remoteConnectionOpenPreference?.initialFailure}
        preferredKind={remoteConnectionOpenPreference?.preferredKind}
        preferredWslDistro={remoteConnectionOpenPreference?.preferredWslDistro}
        preferredSourceServerId={remoteConnectionOpenPreference?.preferredSourceServerId}
        preferredProfileId={remoteConnectionOpenPreference?.preferredProfileId}
        preferredDirectoryPath={remoteConnectionOpenPreference?.preferredDirectoryPath}
        preferredTarget={remoteConnectionOpenPreference?.preferredTarget}
        hideTriggerWhenClosed
      />
    </>
  ) : null;
  const directoryBrowserDialog = directoryBrowserOpen ? (
    <ScopedErrorBoundary
      scope="directory-browser"
      resetKeys={["directory-browser"]}
      variant="silent"
    >
      <DirectoryBrowser
        services={services}
        onCancel={() => setDirectoryBrowserOpen(false)}
        onSelect={(path) => {
          setDirectoryBrowserOpen(false);
          void handleSelectProject(path);
        }}
      />
    </ScopedErrorBoundary>
  ) : null;

  useEffect(() => {
    const wasInProgress = previousRemoteConnectionInProgressRef.current;
    if (!wasInProgress && remoteConnectionInProgress) {
      resetRemoteConnectionLogs();
    }
    previousRemoteConnectionInProgressRef.current = remoteConnectionInProgress;
  }, [remoteConnectionInProgress, resetRemoteConnectionLogs]);

  // 修复原因：没有打开的项目时 Root 只渲染独立设置页，迁移向导没有挂载，数据同步页「迁移」点了没有反应。
  // 两个分支共用同一个迁移向导节点；没有项目时 workspacePath 为空，用户级的项照常导入（见 useSettingsSync）。
  const onboardingDialog = (
    <ScopedErrorBoundary
      scope="onboarding-dialog"
      resetKeys={[workspaceShellIdentity?.trim() || workspaceShellPath]}
      variant="silent"
    >
      <OnboardingDialog
        workspacePath={workspaceShellPath || undefined}
        workspaceIdentity={workspaceShellIdentity}
        isDesktop={isDesktop}
      />
    </ScopedErrorBoundary>
  );

  const settingsLayerProps = {
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    isWebRemoteControl: Boolean(webRemoteControlWorkspaceSwitcher),
    captionWorkspacePath: activeWorkspacePath,
    onBack: activeWorkspacePath ? handleBackFromSettings : undefined,
    onOpenTask: handleOpenTaskFromSettings,
    onCreateTask: handleCreateTask,
    onOpenWorkspace: handleOpenWorkspace,
    allowOpenWorkspace,
    onLogin: !user ? handleOpenLoginEntry : undefined,
    onLogout: user ? handleLogout : undefined,
    user,
  };

  if (credentialRecovery.state) return <CredentialStoreRecovery recovery={credentialRecovery} />;

  if (isStartupRenderBlocked) {
    const loadingLabel = intl.formatMessage({ id: "common.loading" });
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {requestSecurityBridgeNode}
        {remoteConnectionDialog}
        {directoryBrowserDialog}
        {/* 修复原因：HTML 启动壳已经展示 ZCode SVG，但 React 接管 root 后旧壳会被整棵替换。
            之前阻塞恢复 tab / 初始 workspace 注入时重新渲染纯文字“加载中...”，所以启动被拆成两套 loading。
            这里复用同一套 SVG 启动画面，只把文案保留到 aria-label，保证视觉始终连续且不牺牲可访问性。 */}
        <RootStartupLoading label={loadingLabel} />
      </RootShell>
    );
  }

  if (welcomeScreenOpenReason) {
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {requestSecurityBridgeNode}
        {remoteConnectionDialog}
        {directoryBrowserDialog}
        <WelcomeScreen onComplete={handleWelcomeScreenComplete} />
      </RootShell>
    );
  }

  if (!workspaceShellPath && isSettingsTabActive) {
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {remoteConnectionDialog}
        {directoryBrowserDialog}
        <ScopedErrorBoundary
          scope="settings-page"
          resetKeys={["settings-root"]}
          variant="panel"
          className="h-full"
        >
          <SettingsPage {...settingsLayerProps} />
        </ScopedErrorBoundary>
        {onboardingDialog}
      </RootShell>
    );
  }

  if (
    !workspaceShellPath &&
    !isDesktop &&
    initialWorkspaceAbsPath &&
    initialWorkspaceLoadingFallback
  ) {
    // 非桌面入口的 workspace tab 由 effect 注入，首帧不能返回 null。
    // 这里延续入口 loading，等任务列表有 workspaceShellPath 后再切换，避免露出浏览器白底。
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {requestSecurityBridgeNode}
        {initialWorkspaceLoadingFallback}
        {directoryBrowserDialog}
      </RootShell>
    );
  }

  if (!workspaceShellPath) {
    return remoteConnectionDialogOpen || directoryBrowserOpen || rootModelSelectionErrorNode ? (
      <RootShell>
        {rootModelSelectionErrorNode}
        {remoteConnectionDialogOpen ? remoteConnectionDialog : null}
        {directoryBrowserDialog}
      </RootShell>
    ) : null;
  }

  return (
    <RootShell>
      {rootModelSelectionErrorNode}
      {requestSecurityBridgeNode}
      {remoteConnectionDialog}
      {directoryBrowserDialog}
      <OccupationOnboarding
        showWindowControls={Boolean(isWindowsDesktop || (isDesktop && !isMacDesktop))}
        showChildrenWhileLoading={!workspaceShellPath && isSettingsTabActive}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        {/* 新引导属于应用级偏好；无项目时也要挂载，才能响应设置页的手动打开请求。 */}
        {!workspaceShellPath ? (
          isSettingsTabActive ? (
            <ScopedErrorBoundary
              scope="settings-page"
              resetKeys={["settings-root"]}
              variant="panel"
              className="h-full"
            >
              <SettingsPage {...settingsLayerProps} />
            </ScopedErrorBoundary>
          ) : null
        ) : (
          <RemoteWorkspaceControllerProvider controller={remoteWorkspaceController}>
            <RemoteProjectPresentationProvider
              reconnectingKeys={reconnectingRemoteWorkspaceKeys}
              errors={remoteWorkspaceErrorByWorkspaceKey}
              recovery={remoteWorkspaceRecoveryByWorkspaceKey}
              onReconnect={
                webRemoteControlWorkspaceSwitcher?.reconnectWorkspace ??
                handleReconnectRemoteWorkspace
              }
            >
              <RootWorkspaceContent
                workspaceScopedServices={workspaceScopedServices}
                baseFeedbackService={services.feedbackService}
                workspaceShellPath={workspaceShellPath}
                workspaceIdentity={workspaceShellIdentity}
                workspaceRemoteSessionId={workspaceShellRemoteSessionId}
                activeWorkspacePath={activeWorkspacePath}
                isSettingsTabActive={isSettingsTabActive}
                handleConnectRemote={handleConnectRemote}
                handleSelectRemoteProject={handleSelectRemoteProject}
                handleCancelRemoteProject={handleCancelRemoteProject}
                handleReconnectRemoteWorkspace={handleReconnectRemoteWorkspace}
                handleCreateTask={handleCreateTask}
                handleCreateConversationTask={handleCreateConversationTask}
                handleResolveConversationWorkspace={handleResolveConversationWorkspaceForShell}
                handleOpenWorkspace={handleOpenWorkspace}
                handleOpenFolderFromWorkspaceMenu={handleOpenFolderFromWorkspaceMenu}
                handleOpenRemoteWorkspace={
                  allowRemoteWorkspace ? handleOpenRemoteConnection : undefined
                }
                remoteConnectionInProgress={remoteConnectionInProgress}
                remoteWorkspaceSessions={remoteWorkspaceSessions}
                allowRemoteWorkspace={allowRemoteWorkspace}
                handleBackFromSettings={handleBackFromSettings}
                handleOpenTaskFromSettings={handleOpenTaskFromSettings}
                handleLogout={user ? handleLogout : undefined}
                onLogin={!user ? handleOpenLoginEntry : undefined}
                user={user}
                reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
                remoteWorkspaceRecoveryByWorkspaceKey={remoteWorkspaceRecoveryByWorkspaceKey}
                remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
                remoteConnectionLogs={remoteConnectionLogs}
                allowOpenWorkspace={allowOpenWorkspace}
                webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
                initialSidebarFileTreeOpen={initialSidebarFileTreeOpen}
                initialWebRemoteControlMobileNavigationIntent={
                  initialWebRemoteControlMobileNavigationIntent
                }
                webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
                isDesktop={isDesktop}
                isMacDesktop={isMacDesktop}
                isWindowsDesktop={isWindowsDesktop}
                supportsEmbeddedBrowser={supportsEmbeddedBrowser}
              />
            </RemoteProjectPresentationProvider>
          </RemoteWorkspaceControllerProvider>
        )}
        {onboardingDialog}
      </OccupationOnboarding>
    </RootShell>
  );
}
