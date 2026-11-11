/* eslint-disable max-lines -- CUA 设置页同时编排插件总开关、双权限状态与授权返回恢复链；后续单独拆分组件。 */
// 设置页「电脑控制 (Computer Use)」分区：
//  - 顶部一个总开关：开/关 zcode-cua 插件（连带其 MCP server 与 skill 一起启用/禁用）。
//  - macOS 下再展示 Accessibility / Screen Recording 两个权限行（含授权引导与 stale 恢复链）。
// UI 复用 SettingsGroupCard / SettingsRow / SettingsBadge / Switch，与其它设置分区保持一致。
//
// Helper 权限状态走 useCuaPermissionStatus：事件驱动（进入页面 / 窗口重获焦点 / 显式 refresh）
// 各查一次，不再定时轮询；状态存在共享缓存里，与输入框常驻入口读同一份。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSettings } from "@/hooks/useSettingService.js";
import type { CuaOsSupport, CuaPermissionKind, RemoteTarget } from "@zcode/shared";
import {
  DesktopCommandIds,
  isRemoteWorkspaceIdentity,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
} from "@zcode/shared";
import { isCuaPermissionStatusAvailable, type CuaPermissionRestartOptions } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { Switch } from "@/components/ui/switch.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCuaPermissionStatus } from "@/hooks/useCuaPermissionStatus.js";
import {
  claimCuaPermissionReturnRecovery,
  completeCuaPermissionReturnRecovery,
  captureCuaPermissionReturnRecovery,
  createCuaPermissionReturnRecoveryState,
  isCuaPermissionReturnRecoveryCurrent,
  markCuaPermissionOnboardingOpened,
  shouldRestartHelperAfterCuaPermissionReturn,
  type CuaPermissionReturnRecoveryClaim,
} from "@/lib/cuaPermissionAction.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { SettingsBadge, SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { StatusDot, type StatusDotTone } from "@/settings/StatusDot.js";
import { supportsLocalMacCuaPermissionOnboarding } from "@/lib/cuaPlatform.js";
import { runAfterSuccessfulPluginEnabledChange } from "@/settings/pluginEnabledChange.js";
import { createCuaPermissionOnboardingOperationId } from "@/lib/cuaPermissionOnboardingOperation.js";
import { waitForAccessibilityNotStale } from "@/settings/cuaPermissionRestartVerify.js";
import { requiredCuaPermissionsForFreshStatus } from "@/settings/cuaPermissionPreparation.js";
import { ExternalLink } from "lucide-react";
import {
  isComputerUseRemoteOrLinux,
  resolveComputerUseAvailability,
} from "@/settings/computerUseAvailability.js";

interface ComputerUseSectionProps {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  // SSH 远端设置页里 workspacePath 是远端路径；本机 Helper 状态查询必须使用本机 workspace 路径。
  localWorkspacePath?: string | null;
}

export function ComputerUseSection({
  isDesktop = false,
  isMacDesktop,
  isWindowsDesktop = false,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  localWorkspacePath,
}: ComputerUseSectionProps) {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const platform = usePlatform();
  const pluginManagementService = services.pluginManagementService;
  // cuaPermissionService 在 main 是可选字段（远端 host 无 CUA）；下方各 handler 在缺失时早退。
  const cuaPermissionService = services.cuaPermissionService;
  const isLocalWorkspace =
    !remoteSessionId &&
    !remoteTarget &&
    !(workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim()));
  // Windows 只复用插件总开关；macOS 才具备 TCC 权限、Helper 状态和附加设置能力。
  const supportsLocalMacWorkspace =
    !isWindowsDesktop &&
    (isMacDesktop ?? supportsLocalMacCuaPermissionOnboarding(platform)) &&
    isLocalWorkspace;
  const supportsLocalWindowsWorkspace = isWindowsDesktop && isLocalWorkspace;
  const supportsComputerUseSettings = supportsLocalMacWorkspace || supportsLocalWindowsWorkspace;
  const availability = resolveComputerUseAvailability({
    isDesktop: isDesktop || isWindowsDesktop || supportsLocalMacWorkspace,
    isMacDesktop: isMacDesktop || supportsLocalMacWorkspace,
    isWindowsDesktop,
    remoteSessionId,
    remoteTarget,
    workspaceIdentity,
  });
  // CUA 权限是 macOS 本机属性：仅完整 macOS 设置需要 Helper workspace 路径。
  const path = supportsLocalMacWorkspace ? (localWorkspacePath ?? workspacePath) : null;
  // 展示只跟 settled：fresh 每次查询开始都会落回 false，跟着它渲染会让授权按钮的文案
  // 在「验证中…」与终态之间切换、宽度随之跳变。
  const { status, settled, refresh } = useCuaPermissionStatus(path ?? null, workspaceIdentity);
  const availableStatus = status && isCuaPermissionStatusAvailable(status) ? status : null;

  // macOS 版本门槛：低版本系统上 Helper 被 LaunchServices -10825 拒启，表象是授权反复无响应。
  // 查询一次主进程判定（GetCuaOsSupport），低于地板时渲染提示卡并隐藏授权操作区。
  // 查询失败按无门槛处理，不阻塞设置页；useCuaPermissionStatus 轮询保留，仅隐藏交互入口。
  const [osSupport, setOsSupport] = useState<CuaOsSupport | null>(null);
  useEffect(() => {
    if (!supportsLocalMacWorkspace || typeof platform.executeDesktopCommand !== "function") return;
    let cancelled = false;
    void platform
      .executeDesktopCommand(DesktopCommandIds.GetCuaOsSupport)
      .then((result) => {
        if (!cancelled) setOsSupport(result as CuaOsSupport);
      })
      .catch(() => {
        /* 查询失败按无门槛处理，不阻塞设置页 */
      });
    return () => {
      cancelled = true;
    };
  }, [supportsLocalMacWorkspace, platform]);

  const macOsBelowCuaFloor = osSupport?.kind === "macos-below-minimum";

  // 总开关 = zcode-cua 插件启用态（读自插件管理 store；切换即同步启用/禁用插件及其 MCP + skill）。
  const plugins = usePluginManagementStore((state) => state.plugins);
  const setPluginEnabled = usePluginManagementStore((state) => state.setEnabled);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const cuaPlugin = plugins.find((plugin) => plugin.id === ZCODE_CUA_OFFICIAL_PLUGIN_ID);
  const cuaEnabled = cuaPlugin?.enabled ?? false;
  const cuaToggling = togglingPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID;

  const initRef = useRef(false);
  useEffect(() => {
    if (
      initRef.current ||
      !supportsComputerUseSettings ||
      !workspacePath ||
      !pluginManagementService
    )
      return;
    initRef.current = true;
    // 复用 Plugins 分区同一条初始化路径，确保 store 已加载 zcode-cua 的 enabled 态。
    void initializePlugins({
      workspacePath,
      workspaceIdentity,
      pluginService: pluginManagementService,
    });
  }, [
    supportsComputerUseSettings,
    workspacePath,
    workspaceIdentity,
    pluginManagementService,
    initializePlugins,
  ]);

  const [restarting, setRestarting] = useState(false);
  // 重启 single-flight：授权返回回调、双击和手动按钮共享同一 operation，不并发轮换 broker 凭据。
  const restartPromiseRef = useRef<Promise<boolean> | null>(null);
  const pendingGrantSessionIdRef = useRef<string | undefined>(undefined);
  const returnRecoveryRef = useRef(createCuaPermissionReturnRecoveryState());
  useEffect(() => {
    returnRecoveryRef.current = createCuaPermissionReturnRecoveryState(
      workspaceIdentity?.trim() || path || "<none>",
    );
    pendingGrantSessionIdRef.current = undefined;
  }, [path, workspaceIdentity]);
  // 重启 Helper 后验证仍持续 stale → 显示"重启 ZCode"兜底按钮。accessibility 变 granted 时自愈清除。
  const [verifyTimedOut, setVerifyTimedOut] = useState(false);
  // 卸载守卫：异步 fetch / 重启 / 切换完成时若组件已卸载，跳过 setState。
  const mountedRef = useRef(true);
  const pluginToggleGenerationRef = useRef(0);
  const pluginToggleContextKey = [
    workspacePath ?? "",
    workspaceIdentity ?? "",
    localWorkspacePath ?? "",
    remoteSessionId ?? "",
    remoteTarget ? "remote" : "local",
  ].join("\u0000");
  const pluginToggleContextKeyRef = useRef(pluginToggleContextKey);
  pluginToggleContextKeyRef.current = pluginToggleContextKey;
  const helperContextKey = [path ?? "", workspaceIdentity?.trim() ?? ""].join("\u0000");
  const helperContextKeyRef = useRef(helperContextKey);
  helperContextKeyRef.current = helperContextKey;
  const activeOnboardingOperationIdRef = useRef<string | null>(null);
  const permissionStatusCheckTokenRef = useRef<symbol | null>(null);
  const platformRef = useRef(platform);
  platformRef.current = platform;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pluginToggleGenerationRef.current += 1;
      permissionStatusCheckTokenRef.current = null;
      const operationId = activeOnboardingOperationIdRef.current;
      activeOnboardingOperationIdRef.current = null;
      if (operationId) {
        platformRef.current.cancelCuaPermissionOnboarding?.(operationId);
      }
    };
  }, []);

  // 同一设置页实例切换 workspace 时也要退出旧 participant；否则旧调用返回后会恢复错误的 Helper。
  useEffect(
    () => () => {
      permissionStatusCheckTokenRef.current = null;
      const operationId = activeOnboardingOperationIdRef.current;
      activeOnboardingOperationIdRef.current = null;
      if (operationId) {
        platformRef.current.cancelCuaPermissionOnboarding?.(operationId);
      }
    },
    [path, workspaceIdentity],
  );

  const onRestart = useCallback(
    (
      targetPath = path,
      targetWorkspaceIdentity = workspaceIdentity,
      restartOptions?: CuaPermissionRestartOptions,
    ): Promise<boolean> => {
      if (!targetPath || !services || !cuaPermissionService) return Promise.resolve(false);
      if (restartPromiseRef.current) return restartPromiseRef.current;
      const targetContextKey = [targetPath, targetWorkspaceIdentity?.trim() ?? ""].join("\u0000");
      if (helperContextKeyRef.current === targetContextKey) {
        setVerifyTimedOut(false);
      }
      setRestarting(true);
      const operation = (async (): Promise<boolean> => {
        let queuedActiveProbe = false;
        try {
          const result = await cuaPermissionService.restartHelper(
            targetPath,
            targetWorkspaceIdentity,
            restartOptions,
          );
          if (!result.ok && mountedRef.current) {
            toast(
              intl.formatMessage(
                { id: "cuaPermission.modal.restartFailed" },
                { error: result.reason ?? "unknown error" },
              ),
            );
            return false;
          }
          if (!result.ok) return false;

          // Helper socket 已健康不代表 tccd 状态已经传播完成；短轮询确认 stale 是否消失。
          const stillStale = await waitForAccessibilityNotStale(() =>
            cuaPermissionService.getStatus(targetPath, targetWorkspaceIdentity),
          );
          // 授权过程中可能切换 workspace；旧操作仍完成必要副作用，但不能污染新页面的升级提示。
          if (mountedRef.current && helperContextKeyRef.current === targetContextKey) {
            setVerifyTimedOut(stillStale);
            // 后台权限轮询必须保持只读，真实截图只能跟随显式的授权返回/重启。
            // restart single-flight 已经把同一 Helper 恢复合并为一次，这里只排一个主动探针；
            // hook 会继续合并 focus/refresh，避免重复触发 macOS 隐私采集。
            refresh({ includeFunctionalProbes: true });
            queuedActiveProbe = true;
          }
          return true;
        } catch (error) {
          if (mountedRef.current) {
            toast(
              intl.formatMessage(
                { id: "cuaPermission.modal.restartFailed" },
                {
                  error: error instanceof Error ? error.message : String(error),
                },
              ),
            );
          }
          return false;
        } finally {
          restartPromiseRef.current = null;
          if (mountedRef.current) {
            setRestarting(false);
            // 失败路径仍只读刷新；成功路径已在当前 workspace 精确排入一次主动探针。
            if (!queuedActiveProbe) refresh();
          }
        }
      })();
      restartPromiseRef.current = operation;
      return operation;
    },
    [path, workspaceIdentity, services, refresh, intl],
  );

  const applyPendingGrant = useCallback(
    async (
      expectedClaim?: CuaPermissionReturnRecoveryClaim,
      target?: { workspacePath: string; workspaceIdentity?: string },
      onboardingSessionId?: string,
    ): Promise<boolean> => {
      const claim = expectedClaim ?? captureCuaPermissionReturnRecovery(returnRecoveryRef.current);
      if (!claim || !isCuaPermissionReturnRecoveryCurrent(claim.state, claim)) {
        return false;
      }
      // 授权前若已有 restart，先等它结束，再启动一个真正位于授权之后的新 Helper。
      const existing = restartPromiseRef.current;
      if (existing) await existing;
      if (!isCuaPermissionReturnRecoveryCurrent(claim.state, claim)) return false;
      // A 发起授权后切到 B，返回结果仍属于当前 renderer/host 的 A runtime。用点击时捕获的 identity
      // 完成必要 restart；只让后续展示刷新服从当前 props，不能因 UI generation 变化丢掉副作用。
      const ok = await onRestart(target?.workspacePath, target?.workspaceIdentity, {
        reason: "permission_granted",
        ...((onboardingSessionId ?? pendingGrantSessionIdRef.current)
          ? {
              onboardingSessionId: onboardingSessionId ?? pendingGrantSessionIdRef.current,
            }
          : {}),
      });
      completeCuaPermissionReturnRecovery(claim, ok);
      return ok;
    },
    [onRestart],
  );

  // 兜底:重启 Helper 后仍持续 stale 时,用户可一键重启 ZCode(复用 OAuth 登出同款 RelaunchApp)。
  // 新 ZCode 进程会干净地重新拉起 Helper,绕过当前进程里可能卡住的重启机制(孤儿/socket/状态污染)。
  const onRelaunchApp = useCallback(async () => {
    if (typeof platform.executeDesktopCommand !== "function") return;
    await platform.executeDesktopCommand(DesktopCommandIds.RelaunchApp);
  }, [platform]);

  const onTogglePlugin = useCallback(
    async (next: boolean) => {
      if (!pluginManagementService) return;
      const operationGeneration = ++pluginToggleGenerationRef.current;
      const operationContextKey = pluginToggleContextKey;
      // 切换 zcode-cua 插件 = 同步其 MCP server + skill 一起启用/禁用。
      const completed = await runAfterSuccessfulPluginEnabledChange({
        submit: () => setPluginEnabled(ZCODE_CUA_OFFICIAL_PLUGIN_ID, next, pluginManagementService),
        isCurrent: () =>
          mountedRef.current &&
          pluginToggleGenerationRef.current === operationGeneration &&
          pluginToggleContextKeyRef.current === operationContextKey,
        onSuccess: () => {
          if (supportsLocalMacWorkspace) {
            // 权限状态和手动授权入口只在 macOS Computer Use 设置页展示。启用插件不得自动打开
            // macOS Permissions modal；刷新状态即可，避免打断用户当前工作流。
            refresh();
          }
          if (!next) {
            toast(intl.formatMessage({ id: "settings.computerUse.disabledToast" }));
          }
        },
      });
      if (!completed && mountedRef.current) {
        const message = usePluginManagementStore.getState().error;
        if (message) {
          toast(message);
        }
      }
    },
    [
      path,
      pluginManagementService,
      pluginToggleContextKey,
      refresh,
      setPluginEnabled,
      supportsLocalMacWorkspace,
      intl,
    ],
  );

  // 打开 macOS 系统设置引导用户授权指定权限（Accessibility / Screen Recording）。
  const openPermissionSettings = useCallback(
    async (initialPermission: CuaPermissionKind): Promise<void> => {
      if (
        typeof platform.openCuaPermissionOnboarding !== "function" ||
        activeOnboardingOperationIdRef.current ||
        permissionStatusCheckTokenRef.current
      ) {
        return;
      }
      const checkToken = Symbol("cua-permission-status-check");
      permissionStatusCheckTokenRef.current = checkToken;
      const operationContextKey = helperContextKey;
      let operationId: string | null = null;
      const recoveryState = returnRecoveryRef.current;
      const recoveryTarget = path
        ? {
            workspacePath: path,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          }
        : null;
      try {
        if (!path || !cuaPermissionService) {
          toast(intl.formatMessage({ id: "cuaPermission.modal.unavailable" }));
          return;
        }
        // 设置页行按钮过去直接使用 lastKnown 状态；另一窗口刚完成授权或当前刷新
        // in-flight 时仍会打开过期 pane。点击边沿重新查询 Helper，只允许当前 denied/stale 的精确项。
        let currentStatus = await cuaPermissionService.getStatus(path, workspaceIdentity, {
          includeFunctionalProbes: false,
        });
        // 从系统设置授权返回后 App 会重启 Helper 才能读到新 TCC 授权，这段窗口内查询拿到的是
        // 不可用状态（授权完立刻点行按钮，预检查退化成「暂时无法确认」
        // 而非「已授权」）。状态不可用时短重试 2 次、间隔 2s，等 Helper 就绪后走到「已授权」
        // 或真实缺权分支；期间守卫失效（卸载/重复点击/上下文切换）直接放弃，不再重试。
        for (
          let attempt = 0;
          attempt < 2 && !isCuaPermissionStatusAvailable(currentStatus);
          attempt += 1
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 2000));
          if (
            !mountedRef.current ||
            permissionStatusCheckTokenRef.current !== checkToken ||
            helperContextKeyRef.current !== operationContextKey ||
            returnRecoveryRef.current !== recoveryState
          ) {
            return;
          }
          currentStatus = await cuaPermissionService.getStatus(path, workspaceIdentity, {
            includeFunctionalProbes: false,
          });
        }
        // React concurrent commit 可能已经收到 workspace A→B 更新但 passive effect 尚未清理 A。
        // render 同步更新的 context ref 是这段窗口内唯一可靠的失效信号；让出一个 macrotask后再判，
        // 迟到的 A 状态不能为 B 打开原生设置页。
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (
          !mountedRef.current ||
          permissionStatusCheckTokenRef.current !== checkToken ||
          helperContextKeyRef.current !== operationContextKey ||
          returnRecoveryRef.current !== recoveryState
        ) {
          return;
        }
        if (
          !isCuaPermissionStatusAvailable(currentStatus) ||
          !requiredCuaPermissionsForFreshStatus(currentStatus).includes(initialPermission)
        ) {
          const permissionState = isCuaPermissionStatusAvailable(currentStatus)
            ? initialPermission === "accessibility"
              ? currentStatus.accessibility
              : currentStatus.screenRecording
            : null;
          toast(
            intl.formatMessage({
              id:
                permissionState === "granted"
                  ? "cuaPermission.grantAlreadySatisfied"
                  : "cuaPermission.modal.unavailable",
            }),
          );
          refresh();
          return;
        }
        operationId = createCuaPermissionOnboardingOperationId();
        activeOnboardingOperationIdRef.current = operationId;
        const result = await platform.openCuaPermissionOnboarding({
          initialPermission,
          operationId,
          requiredPermissions: [initialPermission],
        });
        if (
          !mountedRef.current ||
          activeOnboardingOperationIdRef.current !== operationId ||
          helperContextKeyRef.current !== operationContextKey
        ) {
          return;
        }
        if (shouldRestartHelperAfterCuaPermissionReturn(result)) {
          markCuaPermissionOnboardingOpened(recoveryState);
          pendingGrantSessionIdRef.current = result.sessionId;
          const claim = claimCuaPermissionReturnRecovery(recoveryState);
          if (claim && recoveryTarget) {
            void applyPendingGrant(claim, recoveryTarget, result.sessionId);
          }
        } else if (result?.success && result.returnedFromSettings) {
          // 同一 renderer 对 main session 的重复 join 只刷新；不同窗口各自会拿到本 host 的 recovery。
          refresh();
        }
        if (result?.success === false && !result.canceled) {
          toast(
            intl.formatMessage(
              { id: "chat.cuaPermission.openFailed" },
              { error: result.error ?? "unknown error" },
            ),
          );
        }
      } catch (error) {
        if (
          mountedRef.current &&
          permissionStatusCheckTokenRef.current === checkToken &&
          helperContextKeyRef.current === operationContextKey
        ) {
          toast(
            operationId
              ? intl.formatMessage(
                  { id: "chat.cuaPermission.openFailed" },
                  {
                    error: error instanceof Error ? error.message : String(error),
                  },
                )
              : intl.formatMessage({ id: "cuaPermission.modal.unavailable" }),
          );
        }
      } finally {
        if (permissionStatusCheckTokenRef.current === checkToken) {
          permissionStatusCheckTokenRef.current = null;
        }
        if (operationId && activeOnboardingOperationIdRef.current === operationId) {
          activeOnboardingOperationIdRef.current = null;
        }
      }
    },
    [platform, path, services, workspaceIdentity, intl, applyPendingGrant, refresh],
  );

  const onManualRestart = useCallback((): void => {
    void (returnRecoveryRef.current.pending ? applyPendingGrant() : onRestart());
  }, [applyPendingGrant, onRestart]);

  // 自愈:accessibility 在后续任一次查询里变成 granted 时,清除"重启 ZCode"兜底(说明问题已解决)。
  useEffect(() => {
    if (availableStatus?.accessibility === "granted") setVerifyTimedOut(false);
  }, [availableStatus?.accessibility]);

  const renderGrantDetail = (kind: CuaPermissionKind, labelId: string): ReactNode => {
    if (typeof platform.openCuaPermissionOnboarding !== "function") return null;
    return (
      <Button
        type="button"
        variant="link"
        size="sm"
        className="text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300"
        aria-label={intl.formatMessage({ id: labelId })}
        title={intl.formatMessage({ id: labelId })}
        disabled={!settled}
        onClick={() => void openPermissionSettings(kind)}
      >
        <ExternalLink className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">
          {intl.formatMessage({
            id: settled ? labelId : "cuaPermission.status.verifying",
          })}
        </span>
      </Button>
    );
  };

  // 权限状态 → { 圆点颜色 tone, 文案 text }，保证圆点与文案同源（granted 绿/stale 黄/denied 红/unknown 灰）。
  // TCC=granted 即稳定显示 granted（绿）；功能探针（functionalProbeOk）只用于 runtime 就绪判断，
  // 不再让它在每次轮询时把显示态翻成 "verifying"（否则会 granted↔verifying 反复横跳）。
  const statusView = (
    state: "granted" | "stale" | "denied" | "unknown" | undefined,
  ): { tone: StatusDotTone; text: string } => {
    if (state === "granted") {
      return {
        tone: "green",
        text: intl.formatMessage({ id: "cuaPermission.status.granted" }),
      };
    }
    if (state === "stale") {
      // 仅兼容旧 Helper：可能是进程 lag，也可能是旧 ad-hoc CDHash 行，UI 同时提供重启与重新授权。
      return {
        tone: "amber",
        text: intl.formatMessage({ id: "cuaPermission.status.stale" }),
      };
    }
    if (state === "denied") {
      return {
        tone: "red",
        text: intl.formatMessage({ id: "cuaPermission.status.missing" }),
      };
    }
    return {
      tone: "muted",
      text: intl.formatMessage({ id: "cuaPermission.status.unknown" }),
    };
  };

  // 旧 Helper 的 stale 可能来自进程缓存，也可能来自旧 ad-hoc CDHash；先重启并验证，仍失败时同时
  // 保留重新授权入口与“重启 ZCode”兜底，避免把不可由单次 Helper 重启修复的状态误导成已解决。
  const renderRestartDetail = (): ReactNode => (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={restarting || !path}
        onClick={onManualRestart}
      >
        {restarting
          ? intl.formatMessage({ id: "cuaPermission.modal.restarting" })
          : intl.formatMessage({ id: "cuaPermission.modal.restartButton" })}
      </Button>
      {verifyTimedOut && !restarting ? (
        <div className="flex flex-col items-start gap-1">
          <span className="text-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "cuaPermission.modal.relaunchAppHint" })}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void onRelaunchApp()}>
            {intl.formatMessage({
              id: "cuaPermission.modal.relaunchAppButton",
            })}
          </Button>
        </div>
      ) : null}
    </div>
  );

  // 两项权限的状态视图（圆点 tone + 文案），与圆点同源，避免文案/颜色不同步。
  const acc = statusView(availableStatus?.accessibility);
  const screenPerm = statusView(availableStatus?.screenRecording);

  // 输入框常驻入口的显隐。隐藏开关用 useSettings().update 写入
  // （直连 settingService 只落盘不刷新共享 snapshot，输入框按钮读不到新值）。
  // 乐观更新本地开关，失败回滚并提示。
  const { settings: appSettings, update: updateAppSettings } = useSettings();
  const [composerEntryHiddenOverride, setComposerEntryHiddenOverride] = useState<boolean | null>(
    null,
  );
  const [composerEntrySaving, setComposerEntrySaving] = useState(false);
  // 默认隐藏，与 useCuaComposerEntry 同口径：只有显式存过 false 才算展示。
  // 两处必须一致，否则设置页开关的显示状态会和输入框按钮的实际显隐对不上。
  const persistedComposerEntryHidden = appSettings?.computerUseComposerEntryHidden !== false;
  const composerEntryVisible = !(composerEntryHiddenOverride ?? persistedComposerEntryHidden);
  useEffect(() => {
    if (composerEntryHiddenOverride === null) return;
    if (persistedComposerEntryHidden === composerEntryHiddenOverride) {
      setComposerEntryHiddenOverride(null);
    }
  }, [composerEntryHiddenOverride, persistedComposerEntryHidden]);
  const onToggleComposerEntry = useCallback(
    async (visible: boolean) => {
      const nextHidden = !visible;
      setComposerEntryHiddenOverride(nextHidden);
      setComposerEntrySaving(true);
      try {
        await updateAppSettings({ computerUseComposerEntryHidden: nextHidden });
      } catch (error) {
        if (mountedRef.current) {
          setComposerEntryHiddenOverride(null);
          toast(
            intl.formatMessage(
              { id: "settings.computerUse.composerEntry.saveFailed" },
              { error: error instanceof Error ? error.message : String(error) },
            ),
          );
        }
      } finally {
        if (mountedRef.current) setComposerEntrySaving(false);
      }
    },
    [intl, updateAppSettings],
  );

  // 产品需求：denied（未授权）时右侧状态徽章本身可点击，
  // 效果同「打开系统设置」授权按钮；granted/stale/unknown 保持纯展示。
  const renderPermissionBadge = (
    kind: CuaPermissionKind,
    view: { tone: StatusDotTone; text: string },
    state: "granted" | "stale" | "denied" | "unknown" | undefined,
  ): ReactNode => {
    const clickable = state === "denied";
    const badge = (
      <SettingsBadge>
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={view.tone} />
          {view.text}
        </span>
      </SettingsBadge>
    );
    if (!clickable) return badge;
    return (
      <button
        type="button"
        className="cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={view.text}
        onClick={() => void openPermissionSettings(kind)}
      >
        {badge}
      </button>
    );
  };

  if (!supportsComputerUseSettings) {
    // 远端 / Linux 环境若直接 return null，设置页只剩标题，会让用户误以为页面加载失败。
    // 保留入口并明确能力边界，且不渲染任何会触发本地 CUA 写操作的控件。
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-ui-base text-warning">
        <p className="font-medium">
          {intl.formatMessage({ id: "settings.computerUse.unsupported.title" })}
        </p>
        <p className="mt-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id: isComputerUseRemoteOrLinux(availability)
              ? availability.kind === "local-linux"
                ? "settings.computerUse.unsupported.linuxDescription"
                : "settings.computerUse.unsupported.remoteDescription"
              : "settings.computerUse.unsupported.remoteDescription",
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 总开关：开/关 zcode-cua 插件（同步其 MCP + skill） */}
      <SettingsGroupCard>
        <SettingsRow
          searchId="settings.computerUse.toggleLabel"
          label={intl.formatMessage({ id: "settings.computerUse.toggleLabel" })}
          description={intl.formatMessage({
            id: "settings.computerUse.toggleDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.computerUse.toggleLabel",
              })}
              checked={cuaEnabled}
              disabled={cuaToggling || !workspacePath}
              onCheckedChange={(checked) => void onTogglePlugin(checked)}
            />
          }
        />
        {/* 输入框常驻入口的显隐开关：关闭是持久化 hidden 标记，
            重启与版本更新都不会自愈。只管按钮渲不渲染，不影响插件启用态与进行中任务。
            电脑控制关闭时按钮无论如何都不渲染（cuaComposerEntryState 的插件门），
            此时把开关置灰并改文案说明前置条件——留一个可点却看不到效果的开关会被当成坏了。 */}
        <SettingsRow
          searchId="settings.computerUse.composerEntry.label"
          label={intl.formatMessage({ id: "settings.computerUse.composerEntry.label" })}
          description={intl.formatMessage({
            id: cuaEnabled
              ? "settings.computerUse.composerEntry.description"
              : "settings.computerUse.composerEntry.requiresEnabled",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.computerUse.composerEntry.label",
              })}
              checked={composerEntryVisible}
              disabled={composerEntrySaving || !cuaEnabled}
              onCheckedChange={(checked) => void onToggleComposerEntry(checked)}
            />
          }
        />
      </SettingsGroupCard>

      {/* CUA 未启用时隐藏下方权限配置，只留总开关，避免一堆禁用项。 */}
      {cuaEnabled && supportsLocalMacWorkspace ? (
        <>
          {/* macOS 版本低于 CUA Helper 承诺地板时，授权在低版本系统上无法完成
              （Helper 被 LaunchServices -10825 拒启），整卡替换为升级提示。 */}
          {macOsBelowCuaFloor ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
              <p className="font-medium">
                {intl.formatMessage(
                  { id: "cuaPermission.osFloorTitle" },
                  {
                    minimum: osSupport?.minimumMacOs ?? "12.0",
                    current: osSupport?.currentMacOs ?? "12 以下",
                  },
                )}
              </p>
              <p>{intl.formatMessage({ id: "cuaPermission.osFloorDescription" })}</p>
            </div>
          ) : null}
          {/* macOS 权限引导只保留在 Settings 内，CUA 操作与工具审批流不再自动弹权限 modal。 */}
          {!macOsBelowCuaFloor ? (
            <SettingsGroupCard>
              <SettingsRow
                controlLayout="wide"
                label={intl.formatMessage({
                  id: "cuaPermission.perm.accessibility",
                })}
                description={intl.formatMessage({
                  id: "cuaPermission.perm.accessibility.purpose",
                })}
                control={renderPermissionBadge(
                  "accessibility",
                  acc,
                  availableStatus?.accessibility,
                )}
                detail={
                  availableStatus?.accessibility === "granted"
                    ? undefined
                    : availableStatus?.accessibility === "stale"
                      ? renderRestartDetail()
                      : renderGrantDetail("accessibility", "chat.cuaPermission.openAccessibility")
                }
              />
              <SettingsRow
                controlLayout="wide"
                label={intl.formatMessage({
                  id: "cuaPermission.perm.screenRecording",
                })}
                description={intl.formatMessage({
                  id: "cuaPermission.perm.screenRecording.purpose",
                })}
                control={renderPermissionBadge(
                  "screen_recording",
                  screenPerm,
                  availableStatus?.screenRecording,
                )}
                detail={
                  availableStatus?.screenRecording === "granted"
                    ? undefined
                    : renderGrantDetail(
                        "screen_recording",
                        "chat.cuaPermission.openScreenRecording",
                      )
                }
              />
            </SettingsGroupCard>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
