import { toast } from "@/components/ui/toast.js";
import { RemoteConnectionSelection } from "@/remote-connection/RemoteConnectionSelection.js";
import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { profileMatchesRemoteTarget } from "@/lib/remoteConnectionWizard.js";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  createUuid,
  getSourceServerUpdateTarget,
  isSameSourceServerUpdateTarget,
  DEFAULT_REMOTE_ASSET_INSTALL_MODE,
  REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE,
  resolveWorkspaceKey,
  SOURCE_SERVER_UPDATE_IN_PROGRESS_ERROR_CODE,
  ZCODE_VERSION,
  type ConnectionProfile,
  type SourceServerRunningTask,
  type RemoteTarget,
} from "@zcode/shared";
import { useCancelPendingRemoteConnection } from "@/hooks/useCancelPendingRemoteConnection.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useRemoteConnectionForm } from "@/hooks/useRemoteConnectionForm.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { useSourceServerOperationLogs } from "@/hooks/useSourceServerOperationLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import {
  buildRemoteTarget,
  buildRemoteTargetFromProfile,
  findPreferredSourceConnectionProfile,
  findSourceServerUpgradeProfileId,
  getRemoteWizardStepCopy,
  collectRemoteFormFieldErrors,
  formatRemoteDraftPreview,
  withDefaultRemoteResourcePackages,
} from "@/lib/remoteConnectionWizard.js";
import {
  getRemoteConnectionCompletionDialogState,
  getRemoteConnectionDirectoryFailureState,
  isRemoteConnectionFlowActive,
} from "@/lib/remoteConnectionDialogState.js";
import { logger } from "@/logger.js";
import {
  classifyRemoteConnectionError,
  formatRemoteConnectionError,
  getRemoteDevicePresentationInput,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import {
  getSourceServerDowngradeConfirmation,
  getSourceServerReinstallConfirmation,
  resolveSourceServerReinstallAvailability,
  runSourceServerUpdate,
} from "@/lib/sourceServerUpdateAction.js";
import { startUserAction, type UserActionHandle } from "@/lib/userActionTelemetry.js";
import {
  useRemoteBoundaryAcknowledgement,
  RemoteConnectionConnectingStep,
  RemoteConnectionDirectoryStep,
  RemoteConnectionSettingsStep,
  formatDeviceCardMeta,
} from "@/RemoteConnectionDialogContent.js";
import { formatRemoteLinkRailTarget } from "@/remote-connection/RemoteLinkRail.js";
import {
  RemoteConnectionWizardHeader,
  type RemoteWizardStep,
} from "@/RemoteConnectionWizardChrome.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { loadConnectionProfileCredentials } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";

import {
  normalizeRemoteConnectionOptions,
  type RemoteConnectionFlowOptions,
} from "@/remote-connection-flow/contract.js";
export type { RemoteConnectionFlowOptions } from "@/remote-connection-flow/contract.js";

interface RemoteConnectionCompletionIntent {
  preferredDirectoryPath?: string;
  options?: {
    directToDirectory?: boolean;
    localWorkspacePath?: string;
    announceReusedConnection?: boolean;
  };
}

export function useRemoteConnectionFlow(options: RemoteConnectionFlowOptions) {
  const {
    openIntentId,
    completion,
    onDeviceConnected,
    onCancelled,
    onConnect,
    onConnectionReady,
    onSelectProject,
    onCancelSession,
    localWorkspacePath,
    controlledOpen,
    onOpenChange,
    isWindowsDesktop,
    remoteWorkspaceSessions,
    onFlowActiveChange,
    onFlowRequestIdChange,
    onFlowTargetChange,
    preferredKind,
    preferredWslDistro,
    preferredSourceServerId,
    preferredProfileId,
    preferredDirectoryPath,
    preferredTarget,
    onProjectIntentCleared,
    initialFailure,
  } = normalizeRemoteConnectionOptions(options);
  const addingDevice =
    completion === "device-management" &&
    !preferredSourceServerId &&
    !preferredProfileId &&
    !preferredTarget;
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const acknowledgeBoundary = useRemoteBoundaryAcknowledgement();
  const cancelPendingRemoteConnection = useCancelPendingRemoteConnection();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const minimizedRef = useRef(false);
  const confirmationPending = useConfirmDialogStore((state) => Boolean(state.pendingRequest));
  const [discardPending, setDiscardPending] = useState(false);
  const [completionRunning, setCompletionRunning] = useState(false);
  const [blockedCompletion, setBlockedCompletion] = useState<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (confirmationPending || discardPending || !blockedCompletion) return;
    // 在关闭确认的 owner 处理完选择后重入，避免确认关闭与完成回调抢跑。
    setBlockedCompletion(null);
    const epoch = entryEpochRef.current;
    setCompletionRunning(true);
    void blockedCompletion()
      .catch((cause) => {
        if (entryEpochRef.current !== epoch) return;
        setError(getErrorMessage(cause));
        setCurrentStep("connecting");
        applyOpenState(true);
      })
      .finally(() => {
        if (entryEpochRef.current === epoch) setCompletionRunning(false);
      });
  }, [confirmationPending, discardPending, blockedCompletion]);
  const pendingBackgroundCompletion = useRef<(() => Promise<void>) | null>(null);
  const [backgroundReady, setBackgroundReady] = useState(false);
  const [aliasCredentialsPending, setAliasCredentialsPending] = useState(false);
  const activeRequestIdRef = useRef<string | null>(null);
  const entryEpochRef = useRef(0);
  const refreshingIntentRef = useRef<number | null>(null);
  const [refreshingIntent, setRefreshingIntent] = useState(false);
  const consumedOpenIntentIdRef = useRef<number | undefined>(undefined);
  const activeTraceRef = useRef<{ requestId: string; trace: UserActionHandle } | null>(null);
  const cancelActiveTrace = useCallback(() => {
    const active = activeTraceRef.current;
    activeTraceRef.current = null;
    active?.trace.cancel();
  }, []);
  useEffect(() => cancelActiveTrace, [cancelActiveTrace]);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState<string>();
  const [rawError, setRawError] = useState<string>();
  // 0 表示尚未提交；每次提交校验失败递增，表单据此显示内联错误并聚焦第一个出错字段（RDUX-27）。
  const [validationAttempt, setValidationAttempt] = useState(0);
  const [focusCredentials, setFocusCredentials] = useState(false);
  const [directoryPath, setDirectoryPath] = useState("");
  const consumedKindPreferenceRef = useRef<string | null>(null);
  const [step, setCurrentStep] = useState<RemoteWizardStep>("device");
  // Root 常驻挂载，设置入口的首帧也直接展示分类表单，不等待 effect 隐藏旧选择屏。
  const currentStep = addingDevice && step === "device" ? "settings" : step;
  const ownsConnectedSessionRef = useRef(false);
  const [connectedSessionId, setConnectedSessionIdState] = useState<string | null>(null);
  const connectedSessionIdRef = useRef<string | null>(null);
  const setConnectedSessionId = useCallback((sessionId: string | null) => {
    connectedSessionIdRef.current = sessionId;
    setConnectedSessionIdState(sessionId);
  }, []);
  const [connectingRequestId, setConnectingRequestId] = useState<string | null>(null);
  const [pendingRemoteTarget, setPendingRemoteTarget] = useState<RemoteTarget | null>(null);
  const [pendingInstallConfirmation, setPendingInstallConfirmation] = useState<RemoteTarget | null>(
    null,
  );
  const [upgradeProfileId, setUpgradeProfileId] = useState<string | null>(null);
  // Desktop 较旧时可显式切换的线路；与 upgradeProfileId 互斥，由同一份 Host 快照定位。
  // Bug 原因：关闭向导、改选线路等重置点曾只清空 upgradeProfileId，项目入口以非升级失败
  // 打开另一条线路时不会重新定位，旧线路的切换入口和更新日志会带过去。两者同属当前连接
  // 意图，凡清空 upgradeProfileId 处必须同时清空它。
  const [downgradeProfileId, setDowngradeProfileId] = useState<string | null>(null);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  // 本向导发起的更新所属的意图 epoch。确认身份也借 upgradeLoading 显示进行中，但它只是一次连接，
  // 不是“向导持有的更新”；关闭是否等同收起只看这里（RDUX-10 例外）。
  const ownedUpdateEpochRef = useRef<number | null>(null);
  const [pendingForceUpdate, setPendingForceUpdate] = useState<{
    tasks?: SourceServerRunningTask[];
  } | null>(null);
  const forceDecisionRef = useRef<((confirmed: boolean) => void) | null>(null);
  const settleForceUpdate = (confirmed: boolean) => {
    const resolve = forceDecisionRef.current;
    forceDecisionRef.current = null;
    setPendingForceUpdate(null);
    resolve?.(confirmed);
  };
  useEffect(
    () => () => {
      forceDecisionRef.current?.(false);
      forceDecisionRef.current = null;
    },
    [],
  );
  const [recognizedDeviceName, setRecognizedDeviceName] = useState<string | undefined>();
  const [recognizedSourceServerId, setRecognizedSourceServerId] = useState<string | undefined>();
  const [
    remoteConversationWorkspaceBySourceServerId,
    setRemoteConversationWorkspaceBySourceServerId,
  ] = useState<Record<string, { workspacePath: string; lastResolvedAt: number }>>({});
  /** 当前连接使用的线路名（SSH alias / 线路 displayName）；无名线路由消费方回退 user@host:port。 */
  const [activeProfileName, setActiveProfileName] = useState<string | undefined>();
  const consumedPreferredSourceServerIdRef = useRef<string | null>(null);
  const consumedPreferredProfileIdRef = useRef<string | null>(null);
  const consumedPreferredTargetRef = useRef<RemoteTarget | null>(null);
  const pendingCompletionIntentRef = useRef<RemoteConnectionCompletionIntent>({});
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const selectingDirectoryRef = useRef(false);
  const { connectionLogs, resetConnectionLogs, appendConnectionLog } =
    useRemoteConnectionLogs(connectingRequestId);
  // 连接成功后要打开的项目目录；有值时连接屏多一步“打开项目目录”。
  const [workspaceStepPath, setWorkspaceStepPath] = useState<string>();
  const open = controlledOpen ?? uncontrolledOpen;
  const {
    kind,
    host,
    port,
    username,
    sshAuthMethod,
    assetInstallMode,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    wslDistro,
    wslUser,
    dockerContainer,
    manualDockerContainer,
    serverUrl,
    serverName,
    serverToken,
    serverWorkspacePath,
    sshConfigAliases,
    sshConfigAliasesLoading,
    sshConfigAliasesError,
    selectedSshConfigAlias,
    dockerAvailable,
    wslDistros,
    dockerContainers,
    availableKinds,
    setKind,
    setHost,
    setPort,
    setUsername,
    setSshAuthMethod,
    setAssetInstallMode,
    setPassword,
    setPrivateKeyPath,
    setPrivateKeyPassphrase,
    setWslDistro,
    setWslUser,
    setDockerContainer,
    setManualDockerContainer,
    setServerUrl,
    setServerName,
    setServerToken,
    setServerWorkspacePath,
    refreshDockerContainers,
    applySshConfigAlias,
    clearSelectedSshConfigAlias,
    currentRuntimeOptionsLoading,
    currentRuntimeOptionsError,
    resetDraft,
    discoveryLoading,
    discoveryError,
  } = useRemoteConnectionForm({
    open,
    isWindowsDesktop,
    preferredKind,
    preferredWslDistro,
    preserveDraftOnOpen: true,
    discoverAll: !addingDevice,
  });
  const directoryBrowserServices = useRemoteWorkspaceSessionStore((state) =>
    connectedSessionId ? (state.sessionsById[connectedSessionId]?.services ?? null) : null,
  );
  const baseServices = useBaseWorkspaceServices();
  const sourceManagement = baseServices.sourceServerManagementService;
  // 合同层：管理快照统一走 useSourceServerManagementSnapshot（双事件订阅 + in-flight/queued 队列 + generation 判序），
  // 不再各自手写订阅（§8.1.4 全部消费方收敛为统一 hook）。
  const { snapshot: sourceManagementSnapshot, applySnapshot: applySourceManagementSnapshot } =
    useSourceServerManagementSnapshot(sourceManagement, { enabled: open || minimizedRef.current });
  // RDRI-01：重新安装按“重试”的同一规则定位线路。更新日志只在 Host 报告该线路正在更新时并入，
  // 不新增需要在各重置点清空的向导状态。
  const reinstallProfile = useMemo(() => {
    if (!pendingRemoteTarget || pendingRemoteTarget.kind === "server") return undefined;
    const profiles = (sourceManagementSnapshot?.profiles ?? []).filter(
      (profile) => profile.lifecycleState !== "retired",
    );
    return (
      profiles.find((profile) => profile.profileId === preferredProfileId) ??
      profiles.find((profile) => profileMatchesRemoteTarget(profile, pendingRemoteTarget))
    );
  }, [pendingRemoteTarget, preferredProfileId, sourceManagementSnapshot]);
  const reinstallUpdating = Boolean(
    reinstallProfile &&
    sourceManagementSnapshot?.states.some(
      (state) => state.profileId === reinstallProfile.profileId && state.state === "updating",
    ),
  );
  // 升级与切换远端互斥，二者都走 Host 更新链，向导展示同一线路的操作日志。
  const updateProfileId =
    upgradeProfileId ??
    downgradeProfileId ??
    (reinstallUpdating ? (reinstallProfile?.profileId ?? null) : null);
  const { logsByProfileId: sourceOperationLogs } = useSourceServerOperationLogs(
    sourceManagement,
    updateProfileId ? [updateProfileId] : [],
  );
  // R3 §6.3：更新是否处于可取消的本机阶段只读 Host 快照，Renderer 不按日志阶段自行推断。
  const updateCancelable =
    upgradeLoading &&
    Boolean(
      updateProfileId &&
      sourceManagementSnapshot?.states.some(
        (state) => state.profileId === updateProfileId && state.updateCancelable === true,
      ),
    );
  useEffect(() => {
    if (
      !open &&
      currentStep === "device" &&
      !pendingRemoteTarget &&
      !connectedSessionId &&
      !loading
    ) {
      consumedKindPreferenceRef.current = null;
      consumedPreferredSourceServerIdRef.current = null;
      consumedPreferredProfileIdRef.current = null;
    }
  }, [open, currentStep, pendingRemoteTarget, connectedSessionId, loading]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void baseServices.settingService
      .get()
      .then((settings) => {
        if (!disposed) {
          setRemoteConversationWorkspaceBySourceServerId(
            settings.remoteConversationWorkspaceBySourceServerId ?? {},
          );
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [baseServices.settingService, open]);
  const flowSnapshot = useMemo(
    () => ({
      currentStep,
      loading,
      connectedSessionId,
    }),
    [connectedSessionId, currentStep, loading],
  );
  const flowActive =
    isRemoteConnectionFlowActive(flowSnapshot) ||
    upgradeLoading ||
    Boolean(blockedCompletion) ||
    completionRunning;
  const recognizedServer = useMemo(
    () =>
      recognizedSourceServerId
        ? (sourceManagementSnapshot?.servers.find(
            (server) => server.sourceServerId === recognizedSourceServerId,
          ) ?? null)
        : null,
    [recognizedSourceServerId, sourceManagementSnapshot],
  );
  const visibleConnectionLogs = useMemo(() => {
    const updateLogs = updateProfileId ? (sourceOperationLogs[updateProfileId] ?? []) : [];
    return [
      ...(connectingRequestId
        ? connectionLogs
        : rawError === initialFailure?.message
          ? (initialFailure?.logs ?? [])
          : []),
      ...updateLogs.map((entry, index) => ({
        id: `source-update-${entry.timestamp}-${entry.phase}-${index}`,
        level: entry.level,
        message: `[source-server:${entry.phase}] ${entry.message}${
          entry.progress === undefined || /^(?:upload|download) progress:/u.test(entry.message)
            ? ""
            : ` ${(entry.progress * 100).toFixed(1)}%`
        }`,
        timestamp: new Date(entry.timestamp).toLocaleTimeString(locale, {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      })),
    ];
  }, [
    connectionLogs,
    connectingRequestId,
    initialFailure,
    rawError,
    locale,
    sourceOperationLogs,
    updateProfileId,
  ]);
  const quickOpenDirectoryData = useMemo(() => {
    if (!recognizedSourceServerId || !sourceManagementSnapshot) {
      return {
        paths: [] as Array<{ path: string; label?: string }>,
        entries: [] as Array<{ path: string; label?: string }>,
      };
    }
    const localEntries = sourceManagementSnapshot.workspaceHistory
      .filter(
        (entry) =>
          entry.sourceServerId === recognizedSourceServerId &&
          remoteConversationWorkspaceBySourceServerId[recognizedSourceServerId]?.workspacePath !==
            entry.workspacePath,
      )
      .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
    const localKeys = new Set(localEntries.map((entry) => resolveWorkspaceKey(entry)));
    const server = sourceManagementSnapshot.servers.find(
      (candidate) => candidate.sourceServerId === recognizedSourceServerId,
    );
    return {
      paths: localEntries.slice(0, 3).map((entry) => ({
        path: entry.workspacePath,
        // 原型 q-time：本地记录显示相对时间（昨天 / 8月20日），远端记录显示「远端记录」。
        label: formatTaskRelativeTime(entry.lastOpenedAt, intl),
      })),
      entries: (server?.declaredWorkspaces ?? [])
        .filter((entry) => !localKeys.has(resolveWorkspaceKey(entry)))
        .map((entry) => ({
          path: entry.workspacePath,
          label: intl.formatMessage({ id: "remote.remoteRecord" }),
        })),
    };
  }, [
    intl,
    recognizedSourceServerId,
    remoteConversationWorkspaceBySourceServerId,
    sourceManagementSnapshot,
  ]);

  const backgroundActive = minimizedRef.current;
  useEffect(() => {
    // 后台完成消费后即使 loading/open 都未改变，也必须释放 Root 的入口门禁。
    onFlowActiveChange?.(flowActive || backgroundActive);
  }, [flowActive, backgroundActive, onFlowActiveChange]);

  const updateConnectingRequestId = useCallback(
    (requestId: string | null) => {
      activeRequestIdRef.current = requestId;
      setConnectingRequestId(requestId);
      onFlowRequestIdChange?.(requestId);
    },
    [onFlowRequestIdChange],
  );

  const updatePendingRemoteTarget = useCallback(
    (target: RemoteTarget | null) => {
      setPendingRemoteTarget(target);
      // 已保存 WSL 线路曾只更新连接目标，返回配置却使用空值或上一线路的表单。
      // 在接受目标的同一入口回填两项，省略参数也必须清空旧输入。
      if (target?.kind === "wsl") {
        setWslDistro(target.distro ?? "");
        setWslUser(target.user ?? "");
      }
      // 在 onConnect 前同步告知通知层；最小化不清空目标，退出或改选沿用同一清理入口。
      onFlowTargetChange?.(target);
    },
    [onFlowTargetChange, setWslDistro, setWslUser],
  );
  useEffect(() => () => onFlowTargetChange?.(null), [onFlowTargetChange]);

  const applyOpenState = (nextOpen: boolean) => {
    onOpenChange?.(nextOpen);
    if (controlledOpen === undefined) {
      setUncontrolledOpen(nextOpen);
    }
  };

  /** 连接成功后由本 flow 打开指定目录时才有“打开项目目录”这一步；设备管理和交给调用方的完成没有。 */
  const resolveWorkspaceStepPath = (path?: string) =>
    completion !== "device-management" && !onConnectionReady && path?.trim()
      ? path.trim()
      : undefined;

  const resetFeedback = () => {
    setCancelled(false);
    setError("");
    setErrorCode(undefined);
    setRawError(undefined);
    setValidationAttempt(0);
  };

  const resetDirectorySelectionState = useCallback(() => {
    selectingDirectoryRef.current = false;
    setSelectingDirectory(false);
  }, []);

  const handleCancelSession = useCallback(
    async (sessionId: string) => {
      try {
        await onCancelSession(sessionId);
      } catch (sessionError) {
        logger.warn("[SSHDialog] 释放未确认的远程 session 失败:", {
          sessionId,
          error: sessionError,
        });
      }
    },
    [onCancelSession],
  );

  const closeDialog = useCallback(
    (options?: { preserveSession?: boolean; keepOpen?: boolean }) => {
      settleForceUpdate(false);
      cancelActiveTrace();
      entryEpochRef.current += 1;
      setBlockedCompletion(null);
      setCompletionRunning(false);
      minimizedRef.current = false;
      pendingBackgroundCompletion.current = null;
      setBackgroundReady(false);
      refreshingIntentRef.current = null;
      setRefreshingIntent(false);
      resetDraft();
      setDirectoryPath("");
      consumedKindPreferenceRef.current = null;
      consumedPreferredSourceServerIdRef.current = null;
      consumedPreferredProfileIdRef.current = null;
      consumedPreferredTargetRef.current = null;
      setAliasCredentialsPending(false);
      setFocusCredentials(false);
      // 关闭确认可能早于连接完成，异步确认后必须释放当前 attachment，不能读旧闭包。
      const sessionId = connectedSessionIdRef.current;
      if (!options?.preserveSession && sessionId && ownsConnectedSessionRef.current) {
        void handleCancelSession(sessionId);
      } else if (!options?.preserveSession && loading && currentStep === "connecting") {
        // Bugfix: 连接过程里 sessionId 尚未返回时，关闭弹窗会只重置 UI；这里补上显式取消，确保后台下载同步停止。
        void cancelPendingRemoteConnection(connectingRequestId ?? undefined);
      }
      resetFeedback();
      setLoading(false);
      resetDirectorySelectionState();
      resetConnectionLogs();
      setCurrentStep(addingDevice ? "settings" : "device");
      setConnectedSessionId(null);
      ownsConnectedSessionRef.current = false;
      updatePendingRemoteTarget(null);
      setPendingInstallConfirmation(null);
      setUpgradeProfileId(null);
      setDowngradeProfileId(null);
      setUpgradeLoading(false);
      setRecognizedDeviceName(undefined);
      setRecognizedSourceServerId(undefined);
      setActiveProfileName(undefined);
      pendingCompletionIntentRef.current = {};
      // Bug 原因：SSHDialog 常驻挂载，关闭时不清空会让下一次连接沿用上一次的“打开项目目录”这一步。
      setWorkspaceStepPath(undefined);
      updateConnectingRequestId(null);
      if (!options?.keepOpen) applyOpenState(false);
    },
    [
      addingDevice,
      cancelActiveTrace,
      cancelPendingRemoteConnection,
      connectedSessionId,
      connectingRequestId,
      currentStep,
      handleCancelSession,
      loading,
      resetDirectorySelectionState,
      updateConnectingRequestId,
      updatePendingRemoteTarget,
    ],
  );

  const confirmRemoteFlowDiscard = useCallback(async () => {
    if (currentStep === "connecting" && loading) {
      return confirmDialog({
        title: intl.formatMessage({ id: "remote.connectingConfirmTitle" }),
        description: intl.formatMessage({
          id: "remote.connectingConfirmDescription",
        }),
        confirmLabel: intl.formatMessage({ id: "remote.stopConnecting" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      });
    }
    if (!connectedSessionId) {
      return true;
    }
    return confirmDialog({
      title: intl.formatMessage({ id: "remote.connectedConfirmTitle" }),
      description: intl.formatMessage({
        id: "remote.connectedConfirmDescription",
      }),
      confirmLabel: intl.formatMessage({ id: "remote.leaveConnectedSession" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });
  }, [confirmDialog, connectedSessionId, currentStep, intl, loading]);

  const withConfirmedDiscard = async (discard: () => void | Promise<void>) => {
    const epoch = entryEpochRef.current;
    setDiscardPending(true);
    try {
      const confirmed = await confirmRemoteFlowDiscard();
      if (confirmed && entryEpochRef.current === epoch) await discard();
    } finally {
      setDiscardPending(false);
    }
  };
  const handleCloseRequest = (beforeClose?: () => void) =>
    withConfirmedDiscard(() => {
      beforeClose?.();
      const background = minimizedRef.current;
      closeDialog();
      onCancelled?.(background);
    });
  // Bug 原因（ZCT-2116085848489570304）：更新进行中关闭向导只撤销本流程的意图，远端更新照常进行；
  // 更新完成后既不重连也不打开原项目。本机停不了远端更新，所以对话框的关闭（标题栏、Esc、遮罩、
  // 底部关闭）此时等同收起，保留原意图，完成后按后台完成提示继续。后台卡片的「取消」仍放弃意图。
  // Bug 原因（同工单复审）：这里曾只看 upgradeLoading，确认身份也会置它，关闭被当成收起，确认返回后
  // 在后台继续连接。只有本向导发起的更新才例外，确认身份中关闭仍撤销意图。
  const handleDismissRequest = () => {
    if (upgradeLoading && ownedUpdateEpochRef.current === entryEpochRef.current) {
      minimizedRef.current = true;
      applyOpenState(false);
      return;
    }
    void handleCloseRequest();
  };

  const updateRequiredServer = useCallback(
    async (
      profileId: string,
      target: Exclude<RemoteTarget, { kind: "server" }>,
      allowDowngrade = false,
    ): Promise<boolean> => {
      if (!sourceManagement || upgradeLoading) return false;
      const epoch = entryEpochRef.current;
      const isCurrent = () => entryEpochRef.current === epoch;
      ownedUpdateEpochRef.current = epoch;
      setUpgradeLoading(true);
      try {
        const next = await runSourceServerUpdate({
          management: sourceManagement,
          profileId,
          expectedTarget: getSourceServerUpdateTarget(target),
          allowDowngrade,
          confirmForce: async () => {
            if (!isCurrent()) return false;
            // 清单只是确认的附加信息，读取失败不能绕过或替换 force=false 守卫。
            const snapshot = await sourceManagement.getSnapshot().catch(() => undefined);
            if (!isCurrent()) return false;
            if (snapshot) applySourceManagementSnapshot(snapshot);
            const tasks = snapshot?.states.find(
              (state) => state.profileId === profileId,
            )?.runningTasks;
            setPendingForceUpdate({ tasks });
            return await new Promise<boolean>((resolve) => {
              forceDecisionRef.current = resolve;
            });
          },
        });
        if (!isCurrent() || !next) return false;
        applySourceManagementSnapshot(next);
        setError("");
        setErrorCode(undefined);
        setRawError(undefined);
        return true;
      } catch (updateError) {
        if (!isCurrent()) return false;
        const failure = updateError as {
          code?: unknown;
          retryable?: unknown;
        };
        if (failure.code === "remote-target-changed") {
          setUpgradeProfileId(null);
          setDowngradeProfileId(null);
          setErrorCode(undefined);
          setRawError(undefined);
          setError(intl.formatMessage({ id: "project.connectionUnavailable" }));
          return false;
        }
        setErrorCode(typeof failure.code === "string" ? failure.code : undefined);
        setRawError(getErrorMessage(updateError));
        setError(
          formatRemoteConnectionError({
            fallback: getErrorMessage(updateError),
            reasonCode: typeof failure.code === "string" ? failure.code : undefined,
            retryable: typeof failure.retryable === "boolean" ? failure.retryable : undefined,
            formatMessage: intl.formatMessage,
          }),
        );
        return false;
      } finally {
        if (ownedUpdateEpochRef.current === epoch) ownedUpdateEpochRef.current = null;
        if (isCurrent()) setUpgradeLoading(false);
      }
    },
    [applySourceManagementSnapshot, confirmDialog, intl, sourceManagement, upgradeLoading],
  );

  const startRemoteConnection = async (
    target: RemoteTarget,
    confirmSourceServerInstall = false,
    preferredDirectoryPath?: string,
    options?: RemoteConnectionCompletionIntent["options"],
    automaticServerUpdateAttempted = false,
  ) => {
    const nextTarget = withDefaultRemoteResourcePackages(target);

    if (activeRequestIdRef.current) {
      // Bugfix: React 还没来得及把按钮置 disabled 时，快速重复点击会启动多个 SSH host process。
      // 这里在事件入口再做一次并发保护，避免同一个 dialog 产生多条部署流并把上传进度混在一起。
      return;
    }

    const operationEpoch = ++entryEpochRef.current;
    setDirectoryPath("");
    pendingCompletionIntentRef.current = {
      preferredDirectoryPath,
      options,
    };
    setWorkspaceStepPath(resolveWorkspaceStepPath(preferredDirectoryPath));

    updatePendingRemoteTarget(nextTarget);
    setLoading(true);
    const sessionsAtStart = new Set(
      Object.keys(useRemoteWorkspaceSessionStore.getState().sessionsById),
    );
    const requestId = createUuid();
    updateConnectingRequestId(requestId);
    resetFeedback();
    resetConnectionLogs();
    setUpgradeProfileId(null);
    setDowngradeProfileId(null);
    setCurrentStep("connecting");
    const trace = startUserAction({
      featureId: "workspace.remote.lifecycle",
      action: "connect",
      trigger: "button",
      workspaceKind: "remote",
      remoteKind: nextTarget.kind,
    });
    activeTraceRef.current = { requestId, trace };
    const finishTrace = (finish: (action: UserActionHandle) => void) => {
      if (activeTraceRef.current?.requestId !== requestId) return;
      activeTraceRef.current = null;
      finish(trace);
    };
    try {
      let sessionId: string;
      try {
        const context = confirmSourceServerInstall
          ? { confirmSourceServerInstall: true }
          : undefined;
        sessionId = options?.announceReusedConnection
          ? await onConnect(nextTarget, requestId, context, { announceReusedConnection: true })
          : await onConnect(nextTarget, requestId, context);
      } catch (error) {
        if (activeRequestIdRef.current !== requestId) return;
        const reasonCode =
          error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (reasonCode !== "source-server-install-required") throw error;
        if (!confirmSourceServerInstall) {
          // 安装确认内联在连接阶段，避免在远程弹窗里再套一个确认弹窗，且能让用户看到真实目标。
          const snapshot = await sourceManagement?.getSnapshot().catch(() => undefined);
          if (activeRequestIdRef.current !== requestId) return;
          if (snapshot) applySourceManagementSnapshot(snapshot);
          const failure = error as {
            resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
          };
          const installTarget =
            nextTarget.kind === "wsl" ? (failure.resolvedWslTarget ?? nextTarget) : nextTarget;
          updatePendingRemoteTarget(installTarget);
          setPendingInstallConfirmation(installTarget);
          finishTrace((action) => action.cancel());
          return;
        }
        throw error;
      }
      // 取消/关闭先撤销请求归属；迟到结果只释放临时 session，不能复活旧流程。
      const discardStaleResult = () => {
        if (activeRequestIdRef.current === requestId) return false;
        if (!sessionsAtStart.has(sessionId)) void handleCancelSession(sessionId);
        return true;
      };
      if (discardStaleResult()) return;
      const connectedSourceServerId =
        useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId]?.sourceServerId;
      // 识别时刻由连接结果驱动：directory-record 完成后 session 才携带 sourceServerId，
      // 此时展示「已识别为现有设备」并刷新快照，确保新识别设备的名称与目录历史立即可用。
      if (connectedSourceServerId) {
        setRecognizedSourceServerId(connectedSourceServerId);
        try {
          const nextSnapshot = await sourceManagement?.getSnapshot();
          if (discardStaleResult()) return;
          if (nextSnapshot) {
            // 经统一 hook 的 generation 判序入口写入，防止旧快照后至覆盖新内容。
            applySourceManagementSnapshot(nextSnapshot);
            setRecognizedDeviceName(
              nextSnapshot.servers.find(
                (server) => server.sourceServerId === connectedSourceServerId,
              )?.displayName,
            );
          }
        } catch {
          // 设备名仅用于展示；快照读取失败时保留连接结果，不打断流程。
        }
      }
      if (discardStaleResult()) return;
      // 后台只保留本次意图的完成动作；不能在网络结果到达时恢复旧页面。
      // 设备管理只需 Source 身份，立即释放本次独占 attachment。
      ownsConnectedSessionRef.current =
        completion !== "device-management" && !sessionsAtStart.has(sessionId);
      if (completion === "device-management" && !sessionsAtStart.has(sessionId)) {
        await handleCancelSession(sessionId);
        if (discardStaleResult()) return;
      }
      setConnectedSessionId(completion === "device-management" ? null : sessionId);
      const finishConnection = async () => {
        const isCurrent = () => entryEpochRef.current === operationEpoch;
        if (!isCurrent()) return;
        if (minimizedRef.current) {
          deferCompletion();
          return;
        }
        // 读取/保存介绍也会跨过收起事件；前台权限必须与 epoch 一起在 await 后重验。
        const acknowledged =
          !connectedSourceServerId ||
          (await acknowledgeBoundary(
            () => isCurrent() && !minimizedRef.current,
            () => setBlockedCompletion(() => finishConnection),
          ));
        if (!isCurrent()) return;
        if (minimizedRef.current) {
          deferCompletion();
          return;
        }
        if (!acknowledged) return;
        if (completion === "device-management") {
          // 设备管理没有目录/项目副作用；只回收本次独占的临时 attachment，物理连接仍由 Source owner 保持。
          // 聊天返回仍需校验成员资格；必须等完成方确认，失败沿用本 flow 的错误和重试边界。
          await onDeviceConnected?.(
            connectedSourceServerId,
            () => isCurrent() && !minimizedRef.current,
          );
          if (!isCurrent()) return;
          if (minimizedRef.current) {
            deferCompletion();
            return;
          }
          finishTrace((action) => action.complete({ resultSource: "platform_result" }));
          closeDialog({ preserveSession: true });
          return;
        }
        if (onConnectionReady) {
          await onConnectionReady(sessionId);
          if (entryEpochRef.current !== operationEpoch) return;
          finishTrace((action) => action.complete({ resultSource: "platform_result" }));
          return;
        }
        if (preferredDirectoryPath?.trim()) {
          // 目录提交开始后由项目 owner 接管 attachment；取消 UI 不能回收可能已提交成功的会话。
          // 失败仍由下面的 catch 回收或恢复目录选择，介绍等待阶段的取消则由 flow 负责。
          setConnectedSessionId(null);
          // bind 不带连接日志；由 flow 记下“打开项目目录”这一步，连接屏据此显示进行中与失败。
          appendConnectionLog(
            "info",
            `[source-server:workspace] Preparing ${preferredDirectoryPath}`,
          );
          try {
            await onSelectProject(
              sessionId,
              preferredDirectoryPath,
              options?.localWorkspacePath ?? localWorkspacePath,
            );
            if (entryEpochRef.current !== operationEpoch) return;
            pendingCompletionIntentRef.current = {};
            minimizedRef.current = false;
            setDirectoryPath("");
            resetConnectionLogs();
            setCurrentStep("device");
            setConnectedSessionId(null);
            updatePendingRemoteTarget(null);
            setRecognizedDeviceName(undefined);
            updateConnectingRequestId(null);
            applyOpenState(false);
            finishTrace((action) => action.complete({ resultSource: "platform_result" }));
            return;
          } catch (selectionError) {
            if (entryEpochRef.current !== operationEpoch) {
              if (!sessionsAtStart.has(sessionId)) void handleCancelSession(sessionId);
              return;
            }
            if (
              selectionError &&
              typeof selectionError === "object" &&
              "code" in selectionError &&
              selectionError.code === "remote-connection-canceled"
            ) {
              // 成员移除属于意图取消，不是可改目录的 IO 错误；只回收本次新建的 attachment。
              if (!sessionsAtStart.has(sessionId)) await handleCancelSession(sessionId);
              if (entryEpochRef.current !== operationEpoch) return;
              pendingCompletionIntentRef.current = {};
              onProjectIntentCleared?.();
              resetFeedback();
              setCancelled(true);
              finishTrace((action) => action.cancel());
              return;
            }
            const selectionCode =
              selectionError && typeof selectionError === "object" && "code" in selectionError
                ? String(selectionError.code)
                : undefined;
            if (selectionCode === REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE) {
              // Bug 原因（R8）：远端读目录卡住时，目录浏览器也会读同一台机器的目录，退回浏览器只会
              // 换个地方继续卡。留在连接屏，把“打开项目目录”标为失败并提供重试；本次临时
              // attachment 交还，重试会重新连接并再次打开同一目录。
              appendConnectionLog(
                "error",
                `[source-server:workspace] ${getErrorMessage(selectionError)}`,
              );
              if (!sessionsAtStart.has(sessionId)) await handleCancelSession(sessionId);
              if (entryEpochRef.current !== operationEpoch) return;
              setErrorCode(selectionCode);
              setRawError(getErrorMessage(selectionError));
              setError(
                formatRemoteConnectionError({
                  fallback: getErrorMessage(selectionError),
                  reasonCode: selectionCode,
                  formatMessage: intl.formatMessage,
                }),
              );
              finishTrace((action) => action.fail({ failureStage: "remote_connect" }));
              return;
            }
            // 历史目录可能已被删除或权限变化；保留连接并回退目录浏览器，不能把快速入口变成死路。
            setError(getErrorMessage(selectionError));
          }
        }
        const completionState = getRemoteConnectionCompletionDialogState("success", {
          directToDirectory: true,
        });
        setConnectedSessionId(sessionId);
        setCurrentStep(completionState.step);
        minimizedRef.current = false;
        applyOpenState(completionState.open);
        finishTrace((action) => action.complete({ resultSource: "platform_result" }));
      };
      const deferCompletion = () => {
        setConnectedSessionId(completion === "device-management" ? null : sessionId);
        const continueConnection = async () => {
          if (connectedSourceServerId && sourceManagement) {
            const latest = await sourceManagement.getSnapshot();
            if (entryEpochRef.current !== operationEpoch) return;
            applySourceManagementSnapshot(latest);
            if (
              !latest.servers.some((server) => server.sourceServerId === connectedSourceServerId) ||
              !latest.states.some(
                (state) =>
                  state.sourceServerId === connectedSourceServerId && state.state === "online",
              )
            ) {
              if (completion !== "device-management" && !sessionsAtStart.has(sessionId))
                await handleCancelSession(sessionId);
              if (entryEpochRef.current !== operationEpoch) return;
              setConnectedSessionId(null);
              minimizedRef.current = true;
              setError(intl.formatMessage({ id: "project.connectionUnavailable" }));
              return;
            }
          }
          await finishConnection();
        };
        pendingBackgroundCompletion.current = continueConnection;
        setBackgroundReady(true);
        toast(intl.formatMessage({ id: "remote.background.ready" }), {
          variant: "info",
          dismissible: true,
          dismissLabel: intl.formatMessage({ id: "common.close" }),
          dedupeKey: `remote-connection:${openIntentId ?? 0}:${operationEpoch}`,
          actionLabel: intl.formatMessage({ id: "remote.background.continue" }),
          onAction: () => {
            if (
              entryEpochRef.current !== operationEpoch ||
              pendingBackgroundCompletion.current !== continueConnection
            )
              return;
            resumeBackground();
          },
        });
        finishTrace((action) => action.complete({ resultSource: "platform_result" }));
      };
      await finishConnection();
    } catch (connectError) {
      if (activeRequestIdRef.current !== requestId) return;
      if (
        connectError &&
        typeof connectError === "object" &&
        "code" in connectError &&
        connectError.code === "remote-connection-canceled"
      ) {
        resetFeedback();
        setCancelled(true);
        finishTrace((action) => action.cancel());
        return;
      }
      const completionState = getRemoteConnectionCompletionDialogState("error");
      const failure = connectError as {
        code?: unknown;
        retryable?: unknown;
        profileId?: unknown;
        resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
      };
      const reasonCode = typeof failure.code === "string" ? failure.code : undefined;
      const errorMessage = formatRemoteConnectionError({
        fallback: getErrorMessage(connectError),
        reasonCode,
        retryable: typeof failure.retryable === "boolean" ? failure.retryable : undefined,
        formatMessage: intl.formatMessage,
      });
      setErrorCode(reasonCode);
      setRawError(getErrorMessage(connectError));
      setError(errorMessage);
      setCurrentStep(completionState.step);
      if (!minimizedRef.current) applyOpenState(completionState.open);
      finishTrace((action) => action.fail({ failureStage: "remote_connect" }));
      if (reasonCode === "source-server-upgrade-required" && nextTarget.kind !== "server") {
        const failedTarget =
          nextTarget.kind === "wsl" ? (failure.resolvedWslTarget ?? nextTarget) : nextTarget;
        updatePendingRemoteTarget(failedTarget);
        await resumeRequiredServerUpdate(
          failedTarget,
          { preferredDirectoryPath, options },
          operationEpoch,
          automaticServerUpdateAttempted,
          typeof failure.profileId === "string" ? failure.profileId : undefined,
        );
      }
    } finally {
      // 所有失去归属的返回都结束旁路遥测；显式取消已在撤销请求前同步结算。
      finishTrace((action) => action.cancel());
      // 成功恢复原目录会先清空 requestId；仍属同一流程时必须结束 busy，取消/重试则由新 epoch 接管。
      if (entryEpochRef.current === operationEpoch) {
        activeRequestIdRef.current = null;
        setLoading(false);
      }
    }
  };

  const resumeRequiredServerUpdate = async (
    target: Exclude<RemoteTarget, { kind: "server" }>,
    intent: RemoteConnectionCompletionIntent,
    epoch: number,
    automaticServerUpdateAttempted = false,
    failedProfileId?: string,
  ): Promise<void> => {
    if (!sourceManagement) return;
    const isCurrent = () => entryEpochRef.current === epoch;
    try {
      const snapshot = await sourceManagement.getSnapshot();
      if (!isCurrent()) return;
      applySourceManagementSnapshot(snapshot);
      // Profile ID 标识可编辑记录，不能先覆盖失败目标再匹配；WSL 使用失败响应的实际身份。
      if (target.kind === "wsl" && (!target.distro?.trim() || !target.user?.trim())) {
        throw new Error(intl.formatMessage({ id: "project.connectionUnavailable" }));
      }
      const failedProfile = failedProfileId
        ? snapshot.profiles.find(
            (profile) =>
              profile.profileId === failedProfileId && profile.lifecycleState !== "retired",
          )
        : undefined;
      if (
        failedProfileId &&
        (!failedProfile || !isSameSourceServerUpdateTarget(failedProfile.target, target))
      ) {
        throw new Error(intl.formatMessage({ id: "project.connectionUnavailable" }));
      }
      const profileId = findSourceServerUpgradeProfileId(snapshot, target, failedProfileId);
      setUpgradeProfileId(profileId);
      if (!profileId) {
        const controllerProfileId = findSourceServerUpgradeProfileId(
          snapshot,
          target,
          failedProfileId,
          "controller",
        );
        setDowngradeProfileId(controllerProfileId);
        if (controllerProfileId) return;
        throw new Error(intl.formatMessage({ id: "project.connectionUnavailable" }));
      }
      if (automaticServerUpdateAttempted) return;
      // 远端被旧版 Desktop 显式切回时，自动升级会直接推翻对方的选择；改由用户点击「更新远端」确认。
      if (snapshot.states.find((state) => state.profileId === profileId)?.downgradedFrom) return;
      // 原项目交接曾只展示 initialFailure，绕过普通连接的自动更新。两种入口共用同一受保护
      // 更新链与意图 epoch：取消后不得恢复旧项目，更新后的连接也不得形成自动更新循环。
      if (!(await updateRequiredServer(profileId, target)) || !isCurrent()) return;
      updateConnectingRequestId(null);
      await startRemoteConnection(
        target,
        false,
        intent.preferredDirectoryPath,
        intent.options,
        true,
      );
    } catch (cause) {
      if (!isCurrent()) return;
      // 快照失败后只清空 Profile 会留下无效的“更新远端”按钮；清除旧升级错误，
      // 展示真实失败并沿用显式重试，重新连接后再由 Host 快照确认是否需要更新。
      setUpgradeProfileId(null);
      setDowngradeProfileId(null);
      setErrorCode(undefined);
      setRawError(getErrorMessage(cause));
      setError(getErrorMessage(cause));
      logger.warn("[SSHDialog] 读取或核验升级目标失败", cause);
    }
  };

  const formSnapshot = {
    kind,
    host,
    port,
    username,
    sshAuthMethod,
    assetInstallMode,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    selectedSshConfigAlias,
    wslDistro,
    wslUser,
    dockerContainer,
    manualDockerContainer,
    serverUrl,
    serverName,
    serverToken,
    serverWorkspacePath,
  };

  const handleConnect = async () => {
    if (loading) {
      // Bugfix: React 还没来得及把按钮置 disabled 时，快速重复点击会启动多个 SSH host process。
      // 这里在事件入口再做一次并发保护，避免同一个 dialog 产生多条部署流并把上传进度混在一起。
      return;
    }

    const { target: nextTarget } = buildRemoteTarget(intl, formSnapshot);
    if (!nextTarget) {
      // Bugfix: 必填项缺失属于表单校验，不应该和真实连接失败共用顶部错误条。
      // 错误改为显示在对应字段下方（RDUX-27），这里只记录一次失败提交。
      setValidationAttempt((attempt) => attempt + 1);
      return;
    }

    resetFeedback();
    setAliasCredentialsPending(false);
    updatePendingRemoteTarget(nextTarget);
    setActiveProfileName(selectedSshConfigAlias?.trim() || undefined);
    // 手动设备连接完成后统一选目录；已有项目保持原来的明确目录意图。
    await startRemoteConnection(
      nextTarget,
      false,
      // 外部偏好只在入口初始化；重新读取 props 会让「新建连接」复活旧设备目录。
      pendingCompletionIntentRef.current.preferredDirectoryPath,
      {
        ...pendingCompletionIntentRef.current.options,
        directToDirectory: true,
      },
    );
  };

  const handleConfirmInstall = useCallback(() => {
    logger.lifecycle.info("[remote-connection] 用户确认安装", {
      hasTarget: Boolean(pendingInstallConfirmation),
      activeRequestId: activeRequestIdRef.current,
      loading,
    });
    if (!pendingInstallConfirmation) return;
    const target = pendingInstallConfirmation;
    const intent = pendingCompletionIntentRef.current;
    setPendingInstallConfirmation(null);
    void startRemoteConnection(target, true, intent.preferredDirectoryPath, intent.options);
  }, [pendingInstallConfirmation, startRemoteConnection, loading]);

  const handleCancelInstall = useCallback(() => {
    if (completion === "device-management" && onCancelled) {
      const background = minimizedRef.current;
      closeDialog();
      onCancelled(background);
      return;
    }
    // 安装确认可能已排入事件队列；取消先撤销归属，旧确认不能重新发起连接。
    entryEpochRef.current += 1;
    setPendingInstallConfirmation(null);
    resetFeedback();
    setCancelled(true);
  }, [closeDialog, completion, onCancelled]);

  // 向导持有的更新在本机阶段可取消（R3 §6.3），是否取消以 Host 返回为准；远端阶段 Host 不取消。
  // 必须在撤销 epoch 之前调用：归属按当前 epoch 判断，其他入口发起的更新不受向导取消影响。
  const cancelOwnedSourceUpdate = useCallback(async (): Promise<boolean> => {
    if (!sourceManagement || !updateProfileId) return false;
    if (ownedUpdateEpochRef.current !== entryEpochRef.current) return false;
    try {
      return (await sourceManagement.cancelSourceUpdate(updateProfileId)).canceled;
    } catch (error) {
      logger.warn("[remote-connection] 取消远端服务更新失败", error);
      return false;
    }
  }, [sourceManagement, updateProfileId]);

  const abandonConnection = useCallback(() => {
    if (completion === "device-management" && onCancelled) {
      const background = minimizedRef.current;
      closeDialog();
      onCancelled(background);
      return;
    }
    settleForceUpdate(false);
    cancelActiveTrace();
    const requestId = activeRequestIdRef.current;
    entryEpochRef.current += 1;
    setBlockedCompletion(null);
    setCompletionRunning(false);
    const sessionId = connectedSessionIdRef.current;
    if (sessionId && ownsConnectedSessionRef.current) void handleCancelSession(sessionId);
    setConnectedSessionId(null);
    updateConnectingRequestId(null);
    setLoading(false);
    // 取消先撤销 epoch，旧更新的 finally 不再有权清理 busy；在 owner 的取消入口同步收口。
    setUpgradeLoading(false);
    setPendingInstallConfirmation(null);
    setAliasCredentialsPending(false);
    resetFeedback();
    setCancelled(true);
    if (requestId) void cancelPendingRemoteConnection(requestId);
  }, [
    cancelActiveTrace,
    cancelPendingRemoteConnection,
    closeDialog,
    completion,
    onCancelled,
    updateConnectingRequestId,
  ]);

  const handleCancelConnection = useCallback(() => {
    if (!updateCancelable) {
      abandonConnection();
      return;
    }
    // Host 进入远端阶段时同步去掉可取消标记，快照稍后才到。以 Host 的取消结果为准：未取消就保持
    // 更新中，更新完成后照常继续原意图，按钮随下一份快照禁用。
    const epoch = entryEpochRef.current;
    void cancelOwnedSourceUpdate().then((canceled) => {
      if (canceled && entryEpochRef.current === epoch) abandonConnection();
    });
  }, [abandonConnection, cancelOwnedSourceUpdate, updateCancelable]);

  const handleStartPendingRemoteConnection = useCallback(
    (automaticServerUpdateAttempted = false) => {
      if (!pendingRemoteTarget) {
        void handleConnect();
        return;
      }

      if (
        pendingRemoteTarget.kind === "ssh" &&
        !pendingRemoteTarget.password &&
        !pendingRemoteTarget.privateKeyPath
      ) {
        resetFeedback();
        setAliasCredentialsPending(true);
        return;
      }
      const intent = pendingCompletionIntentRef.current;
      void startRemoteConnection(
        pendingRemoteTarget,
        false,
        intent.preferredDirectoryPath,
        intent.options,
        automaticServerUpdateAttempted,
      );
    },
    [handleConnect, pendingRemoteTarget, startRemoteConnection],
  );

  const handleUpgradeRequiredServer = useCallback(async () => {
    if (!upgradeProfileId || !pendingRemoteTarget || pendingRemoteTarget.kind === "server") return;
    if (await updateRequiredServer(upgradeProfileId, pendingRemoteTarget)) {
      handleStartPendingRemoteConnection(true);
    }
  }, [
    handleStartPendingRemoteConnection,
    pendingRemoteTarget,
    upgradeProfileId,
    updateRequiredServer,
  ]);

  const handleDowngradeServer = useCallback(async () => {
    if (!downgradeProfileId || !pendingRemoteTarget || pendingRemoteTarget.kind === "server")
      return;
    const state = sourceManagementSnapshot?.states.find(
      (candidate) => candidate.profileId === downgradeProfileId,
    );
    if (!state) return;
    const epoch = entryEpochRef.current;
    const confirmed = await confirmDialog(
      getSourceServerDowngradeConfirmation(state, intl.formatMessage),
    );
    // 确认框打开期间用户可能已取消或改选目标，旧确认不能再发起降级。
    if (!confirmed || entryEpochRef.current !== epoch) return;
    if (await updateRequiredServer(downgradeProfileId, pendingRemoteTarget, true)) {
      handleStartPendingRemoteConnection(true);
    }
  }, [
    confirmDialog,
    downgradeProfileId,
    handleStartPendingRemoteConnection,
    intl,
    pendingRemoteTarget,
    sourceManagementSnapshot,
    updateRequiredServer,
  ]);

  const reinstallServer = reinstallProfile?.sourceServerId
    ? sourceManagementSnapshot?.servers.find(
        (server) => server.sourceServerId === reinstallProfile.sourceServerId,
      )
    : undefined;
  // Bug 原因（CR-01）：这里曾固定 deviceBusy=false 且只看 visible。设备卡或另一窗口正在更新/重启同一设备时，
  // 过时的失败页仍可再发 updateSource；Host 允许更新并存，会真的再跑一次安装。
  // 设备是否忙改读 Host 管理快照，与设备卡同一投影（更新中、重启、其他入口连接中均为“连接中”）；
  // 按 RDRI-01，此时失败页不提供入口。入口只在失败面板渲染，状态仍按“连接失败”判断。
  const reinstallDeviceBusy =
    Boolean(reinstallProfile) &&
    resolveRemoteConnectionPresentation(
      reinstallProfile?.sourceServerId
        ? getRemoteDevicePresentationInput(
            sourceManagementSnapshot,
            reinstallProfile.sourceServerId,
          )
        : (sourceManagementSnapshot?.states.find(
            (state) => state.profileId === reinstallProfile?.profileId,
          ) ?? {}),
    ).status === "connecting";
  const reinstallAvailability = resolveSourceServerReinstallAvailability({
    status: "failed",
    deviceBusy: reinstallDeviceBusy,
    installState: reinstallServer?.installState,
    lastSeenVersion: reinstallServer?.lastSeenVersion,
    localVersion: ZCODE_VERSION,
  });
  const reinstallAvailable =
    Boolean(reinstallProfile) && reinstallAvailability.visible && reinstallAvailability.enabled;

  const handleReinstallServer = useCallback(async () => {
    if (!reinstallProfile || !pendingRemoteTarget || pendingRemoteTarget.kind === "server") return;
    const epoch = entryEpochRef.current;
    const confirmed = await confirmDialog(
      getSourceServerReinstallConfirmation({
        source:
          recognizedDeviceName ??
          activeProfileName ??
          formatRemoteLinkRailTarget(pendingRemoteTarget),
        version: ZCODE_VERSION,
        formatMessage: intl.formatMessage,
      }),
    );
    // 确认框打开期间用户可能已取消或改选目标，旧确认不能再发起重装。
    if (!confirmed || entryEpochRef.current !== epoch) return;
    // 复用更新链：运行中任务守卫与强制确认沿用更新；成功后按更新后的规则继续原连接，不再触发自动更新。
    if (await updateRequiredServer(reinstallProfile.profileId, pendingRemoteTarget)) {
      handleStartPendingRemoteConnection(true);
    }
  }, [
    activeProfileName,
    confirmDialog,
    handleStartPendingRemoteConnection,
    intl,
    pendingRemoteTarget,
    recognizedDeviceName,
    reinstallProfile,
    updateRequiredServer,
  ]);

  const handleBackToConnection = useCallback(async () => {
    if (!connectedSessionId) {
      return;
    }

    resetFeedback();
    try {
      await onCancelSession(connectedSessionId);
      setConnectedSessionId(null);
      updateConnectingRequestId(null);
      resetConnectionLogs();
      setCurrentStep("settings");
    } catch (sessionError) {
      setError(getErrorMessage(sessionError));
    }
  }, [connectedSessionId, onCancelSession, updateConnectingRequestId]);

  const handleSelectDirectory = useCallback(
    async (path: string) => {
      if (!connectedSessionId || selectingDirectoryRef.current) {
        return;
      }

      // Bugfix: 选中远程目录后还要做 realpath、provider 同步、session 持久化和任务列表刷新。
      // 这些异步步骤之前没有独立的提交中状态，用户会看到按钮无响应；这里在入口设置状态并用 ref 防重复提交。
      const epoch = entryEpochRef.current;
      selectingDirectoryRef.current = true;
      setSelectingDirectory(true);
      resetFeedback();
      try {
        await onSelectProject(connectedSessionId, path, localWorkspacePath);
        if (entryEpochRef.current !== epoch) return;
        pendingCompletionIntentRef.current = {};
        minimizedRef.current = false;
        setDirectoryPath("");
        resetConnectionLogs();
        setCurrentStep("device");
        setConnectedSessionId(null);
        updatePendingRemoteTarget(null);
        updateConnectingRequestId(null);
        applyOpenState(false);
      } catch (selectionError) {
        if (entryEpochRef.current !== epoch) return;
        const failureState = getRemoteConnectionDirectoryFailureState({
          connectedSessionId,
          // 事件处理器只在失败时读取一次最新 snapshot，避免为了回调判断新增重复 Zustand 订阅。
          sessionStillRegistered: Boolean(
            useRemoteWorkspaceSessionStore.getState().sessionsById[connectedSessionId],
          ),
        });
        if (!failureState.connectedSessionId) {
          setConnectedSessionId(null);
          setCurrentStep(failureState.step);
          updateConnectingRequestId(null);
        }
        setError(getErrorMessage(selectionError));
      } finally {
        if (entryEpochRef.current === epoch) resetDirectorySelectionState();
      }
    },
    [
      connectedSessionId,
      localWorkspacePath,
      onSelectProject,
      resetDirectorySelectionState,
      updateConnectingRequestId,
      updatePendingRemoteTarget,
    ],
  );

  const acceptInitialFailure = (
    target: RemoteTarget,
    initialFailure?: RemoteConnectionOpenPreference["initialFailure"],
  ) => {
    if (!initialFailure) return false;
    if (initialFailure.code === "source-server-upgrade-required" && initialFailure.failedTarget) {
      target = { ...target, ...initialFailure.failedTarget };
    }
    if (
      (initialFailure.code === "source-server-install-required" ||
        initialFailure.code === "source-server-upgrade-required") &&
      target.kind === "wsl"
    ) {
      target = initialFailure.resolvedWslTarget ?? target;
    }
    updatePendingRemoteTarget(target);
    setKind(target.kind);
    if (target.kind === "ssh") {
      setHost(target.host);
      setPort(String(target.port ?? 22));
      setUsername(target.username);
      setPassword(target.password ?? "");
      setPrivateKeyPath(target.privateKeyPath ?? "");
      setPrivateKeyPassphrase(target.privateKeyPassphrase ?? "");
      setSshAuthMethod(target.privateKeyPath ? "privateKey" : "password");
      setAssetInstallMode(target.assetInstallMode ?? DEFAULT_REMOTE_ASSET_INSTALL_MODE);
    } else if (target.kind === "wsl") {
      setWslDistro(target.distro ?? "");
      setWslUser(target.user ?? "");
    } else if (target.kind === "docker") {
      setDockerContainer(target.container);
      setManualDockerContainer(target.container);
    } else {
      setServerUrl(target.url);
      setServerName(target.name ?? "");
      setServerToken(target.token ?? "");
    }
    setCurrentStep("connecting");
    setWorkspaceStepPath(
      resolveWorkspaceStepPath(
        pendingCompletionIntentRef.current.preferredDirectoryPath ?? preferredDirectoryPath,
      ),
    );
    setErrorCode(initialFailure.code);
    setRawError(initialFailure.message);
    setError(
      formatRemoteConnectionError({
        fallback: initialFailure.message,
        reasonCode: initialFailure.code,
        formatMessage: intl.formatMessage,
      }),
    );
    if (initialFailure.code === "source-server-install-required")
      setPendingInstallConfirmation(target);
    if (initialFailure.code === "source-server-upgrade-required" && target.kind !== "server") {
      void resumeRequiredServerUpdate(
        target,
        pendingCompletionIntentRef.current,
        entryEpochRef.current,
        false,
        initialFailure.profileId,
      );
    }
    return true;
  };

  const handleSelectProfile = (
    profile: ConnectionProfile,
    preferredDirectoryPath?: string,
    selectOptions?: {
      initialFailure?: RemoteConnectionOpenPreference["initialFailure"];
      directToDirectory?: boolean;
      localWorkspacePath?: string;
    },
  ) => {
    const entryEpoch = ++entryEpochRef.current;
    resetFeedback();
    setPendingInstallConfirmation(null);
    setUpgradeProfileId(null);
    setDowngradeProfileId(null);
    // 凭据缺失时也保留目录意图，不能等真正拨号才记录。
    pendingCompletionIntentRef.current = { preferredDirectoryPath, options: selectOptions };
    // Bug 原因：下面在拨号前就进入连接屏（读取或补凭据），阶段数必须同时按本次目录意图计算。
    setWorkspaceStepPath(resolveWorkspaceStepPath(preferredDirectoryPath));
    setDirectoryPath("");
    setActiveProfileName(profile.displayName);
    setRecognizedSourceServerId(profile.sourceServerId);
    setRecognizedDeviceName(
      sourceManagementSnapshot?.servers.find(
        (server) => server.sourceServerId === profile.sourceServerId,
      )?.displayName,
    );
    // Bug 原因：外部连接入口过去先在原界面直接执行 connectProfile，导致 toast、静默连接和
    // 弹窗进度三套反馈并存。精确 Profile intent 在加载凭据前就进入连接屏，后续安装/升级/
    // 失败/重试全部由同一个连接步骤承接。
    setCurrentStep("connecting");
    void (async () => {
      try {
        const target = buildRemoteTargetFromProfile(profile);
        const failure = selectOptions?.initialFailure;
        if (
          failure?.code === "source-server-upgrade-required" &&
          failure.failedTarget &&
          !isSameSourceServerUpdateTarget(target, failure.failedTarget)
        ) {
          // 新 Profile 的凭据也不能混入旧失败目标；先交回原身份，让恢复校验提供显式重试。
          acceptInitialFailure(failure.failedTarget, failure);
          return;
        }
        setKind(target.kind);
        // Bug 原因：设备首屏之前只把 Profile 的非敏感 metadata 传给 Host，
        // Host manager.connect 不会替 UI 解析 credential refs，密码线路因此必然认证失败。
        const credentials = await loadConnectionProfileCredentials({
          profile,
          loadCredential: baseServices.credentialService.load,
        });
        if (entryEpochRef.current !== entryEpoch) return;
        if (target.kind === "ssh") {
          const hasPasswordAuth = Boolean(credentials?.password);
          const expectsPrivateKeyPassphrase =
            profile.target.kind === "ssh" &&
            Boolean(profile.target.privateKeyPassphraseCredentialKey);
          const hasPrivateKeyAuth = Boolean(
            target.privateKeyPath &&
            (!expectsPrivateKeyPassphrase || credentials?.privateKeyPassphrase),
          );
          if (!hasPasswordAuth && !hasPrivateKeyAuth) {
            // Bug 原因：Profile ref 存在但 value 缺失时，旧路径仍以空认证 target 发起 SSH，
            // 把“需要交互凭据”误报成服务端认证失败。认证链不完整必须在网络调用前 fail closed。
            updatePendingRemoteTarget(target);
            // 补凭据时仍保留原线路配置，返回设置不能变成空白的新连接。
            setKind("ssh");
            // 自动换目标不能混用常驻表单中上一设备的凭据，缺凭据只能重新输入。
            setPassword("");
            setPrivateKeyPassphrase("");
            setServerToken("");
            setHost(target.host);
            setPort(String(target.port ?? 22));
            setUsername(target.username);
            setPrivateKeyPath(target.privateKeyPath ?? "");
            setSshAuthMethod(target.privateKeyPath ? "privateKey" : "password");
            setAssetInstallMode(target.assetInstallMode ?? DEFAULT_REMOTE_ASSET_INSTALL_MODE);
            setErrorCode("credentials-required");
            setError(intl.formatMessage({ id: "remote.error.credentialsRequired" }));
            return;
          }
        }
        const targetWithCredentials =
          target.kind === "ssh" && credentials
            ? {
                ...target,
                ...(credentials.password ? { password: credentials.password } : {}),
                ...(credentials.privateKeyPassphrase
                  ? {
                      privateKeyPassphrase: credentials.privateKeyPassphrase,
                    }
                  : {}),
              }
            : target;
        // 已保存线路可能直接进入连接屏；返回修改用户名/密钥时必须编辑这条线路，而非旧表单草稿。
        if (targetWithCredentials.kind === "ssh") {
          setHost(targetWithCredentials.host);
          setPort(String(targetWithCredentials.port ?? 22));
          setUsername(targetWithCredentials.username);
          setPrivateKeyPath(targetWithCredentials.privateKeyPath ?? "");
          setSshAuthMethod(targetWithCredentials.privateKeyPath ? "privateKey" : "password");
          setPassword(targetWithCredentials.password ?? "");
          setPrivateKeyPassphrase(targetWithCredentials.privateKeyPassphrase ?? "");
          setAssetInstallMode(
            targetWithCredentials.assetInstallMode ?? DEFAULT_REMOTE_ASSET_INSTALL_MODE,
          );
        }
        updatePendingRemoteTarget(targetWithCredentials);
        if (acceptInitialFailure(targetWithCredentials, selectOptions?.initialFailure)) return;
        await startRemoteConnection(
          targetWithCredentials,
          false,
          preferredDirectoryPath,
          selectOptions,
        );
      } catch (cause) {
        if (entryEpochRef.current !== entryEpoch) return;
        setError(getErrorMessage(cause));
        setCurrentStep("connecting");
      }
    })();
  };
  const acceptOpenIntent = useEffectEvent(() => {
    // 新入口先撤销旧 epoch/等待点，再由下面的偏好 effect 消费；恢复卡片不走这里。
    const wasBackground = minimizedRef.current;
    closeDialog({ keepOpen: true });
    if (wasBackground && sourceManagement) {
      const epoch = entryEpochRef.current;
      refreshingIntentRef.current = epoch;
      setRefreshingIntent(true);
      // 后台订阅保持存活，新入口仍须先读最新 Profile，不能消费旧快照的已编辑线路。
      void sourceManagement
        .getSnapshot()
        .then((snapshot) => {
          if (entryEpochRef.current === epoch) applySourceManagementSnapshot(snapshot);
        })
        .catch((cause) => {
          if (entryEpochRef.current === epoch) setError(getErrorMessage(cause));
        })
        .finally(() => {
          if (refreshingIntentRef.current !== epoch) return;
          refreshingIntentRef.current = null;
          setRefreshingIntent(false);
        });
    }
  });
  useEffect(() => {
    if (!open || openIntentId === undefined || consumedOpenIntentIdRef.current === openIntentId)
      return;
    consumedOpenIntentIdRef.current = openIntentId;
    // Root 用 flowActive 拒绝新增意图；显式替换已有 openIntentId 仍需撤销等待中的完成动作。
    if (isRemoteConnectionFlowActive(flowSnapshot) || upgradeLoading) return;
    acceptOpenIntent();
  }, [open, openIntentId, flowActive]);

  const applyKindPreference = useEffectEvent(() => {
    if (!preferredKind || !availableKinds.includes(preferredKind)) return;
    // 外部 WSL/UNC 意图只在新入口消费一次；恢复收起的表单不能覆盖用户草稿。
    resetDraft();
    setKind(preferredKind);
    if (preferredKind === "wsl") setWslDistro(preferredWslDistro ?? "");
    setCurrentStep("settings");
  });
  useEffect(() => {
    if (!open || !preferredKind || preferredTarget || preferredProfileId || preferredSourceServerId)
      return;
    const key = `${preferredKind}:${preferredWslDistro ?? ""}`;
    if (consumedKindPreferenceRef.current === key) return;
    consumedKindPreferenceRef.current = key;
    applyKindPreference();
  }, [
    open,
    preferredKind,
    preferredWslDistro,
    preferredTarget,
    preferredProfileId,
    preferredSourceServerId,
    openIntentId,
  ]);

  const applyPreferredTarget = useEffectEvent((target: RemoteTarget) => {
    entryEpochRef.current += 1;
    setFocusCredentials(false);
    // 只替换地址会把上一目标的密码/token 带进新请求；清理发生在换目标而非收起时。
    setPassword("");
    setPrivateKeyPassphrase("");
    setServerToken("");
    setKind(target.kind);
    updatePendingRemoteTarget(target);
    pendingCompletionIntentRef.current = {
      preferredDirectoryPath,
      options: { directToDirectory: true },
    };
    if (target.kind === "ssh") {
      setHost(target.host);
      setPort(String(target.port ?? 22));
      setUsername(target.username);
      setPrivateKeyPath(target.privateKeyPath ?? "");
      setSshAuthMethod(target.privateKeyPath ? "privateKey" : "password");
      // 已有线路必须沿用保存的下载侧，不能被新建表单的默认值覆盖。
      setAssetInstallMode(target.assetInstallMode ?? DEFAULT_REMOTE_ASSET_INSTALL_MODE);
    } else if (target.kind === "wsl") {
      setWslDistro(target.distro ?? "");
      setWslUser(target.user ?? "");
    } else if (target.kind === "docker") {
      setManualDockerContainer(target.container);
      setDockerContainer(target.container);
    } else {
      setServerUrl(target.url);
      setServerName(target.name ?? "");
    }
    if (!acceptInitialFailure(target, initialFailure)) setCurrentStep("settings");
  });
  useEffect(() => {
    if (
      !open &&
      currentStep === "device" &&
      !pendingRemoteTarget &&
      !connectedSessionId &&
      !loading
    )
      consumedPreferredTargetRef.current = null;
    if (
      !open ||
      !preferredTarget ||
      preferredProfileId ||
      loading ||
      connectedSessionId ||
      consumedPreferredTargetRef.current === preferredTarget
    )
      return;
    consumedPreferredTargetRef.current = preferredTarget;
    applyPreferredTarget(preferredTarget);
  }, [
    open,
    preferredTarget,
    preferredProfileId,
    loading,
    connectedSessionId,
    currentStep,
    pendingRemoteTarget,
    openIntentId,
  ]);

  const openPreferredSourceDirectory = useEffectEvent((profile: ConnectionProfile) => {
    handleSelectProfile(profile, undefined, { directToDirectory: true });
  });
  const openPreferredProfile = useEffectEvent((profile: ConnectionProfile) => {
    handleSelectProfile(profile, preferredDirectoryPath, {
      directToDirectory: true,
      initialFailure,
    });
  });

  useEffect(() => {
    if (
      !open ||
      !preferredProfileId ||
      refreshingIntentRef.current !== null ||
      loading ||
      connectedSessionId ||
      consumedPreferredProfileIdRef.current === preferredProfileId ||
      !sourceManagementSnapshot
    ) {
      return;
    }
    const profile = sourceManagementSnapshot.profiles.find(
      (candidate) =>
        candidate.profileId === preferredProfileId && candidate.lifecycleState !== "retired",
    );
    if (!profile) return;

    consumedPreferredProfileIdRef.current = preferredProfileId;
    openPreferredProfile(profile);
  }, [
    connectedSessionId,
    loading,
    open,
    openIntentId,
    preferredProfileId,
    refreshingIntent,
    sourceManagementSnapshot,
  ]);

  useEffect(() => {
    if (
      !open ||
      !preferredSourceServerId ||
      refreshingIntentRef.current !== null ||
      loading ||
      connectedSessionId ||
      consumedPreferredSourceServerIdRef.current === preferredSourceServerId ||
      !sourceManagementSnapshot
    ) {
      return;
    }
    const profile = findPreferredSourceConnectionProfile(
      sourceManagementSnapshot,
      preferredSourceServerId,
    );
    if (!profile) return;

    // Bug 原因：侧栏设备组虽然已知 sourceServerId，弹窗入口过去只接受连接类型，
    // 打开后只能重置到设备首屏。这里一次性消费设备意图，并复用设备卡既有直达目录链路。
    consumedPreferredSourceServerIdRef.current = preferredSourceServerId;
    openPreferredSourceDirectory(profile);
  }, [
    connectedSessionId,
    loading,
    open,
    openIntentId,
    preferredSourceServerId,
    refreshingIntent,
    sourceManagementSnapshot,
  ]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      minimizedRef.current = false;
      applyOpenState(true);
      return;
    }

    handleDismissRequest();
  };

  // Bug 原因（ZCT-2116085848489570304 复审）：更新由其他入口发起时，Host 拒绝本次连接
  // （source-server-update-in-progress，R3 §6.3）。它是等待点，但副题与后台卡片只看 error 是否为空，
  // 显示成“连接失败”。等待点按“正在更新远端服务”展示，卡片按等待处理，与连接屏的状态一致。
  const waitingForSourceUpdate = errorCode === SOURCE_SERVER_UPDATE_IN_PROGRESS_ERROR_CODE;
  const stepCopy = getRemoteWizardStepCopy(intl, currentStep, kind, {
    lineName:
      activeProfileName ??
      (pendingRemoteTarget ? formatRemoteLinkRailTarget(pendingRemoteTarget) : undefined),
    deviceName: recognizedDeviceName,
    connectionReady: Boolean(connectedSessionId) && !error,
    hasError: Boolean(error),
    updating: upgradeLoading || waitingForSourceUpdate,
    cancelled,
  });

  const credentialCategory = classifyRemoteConnectionError({
    errorCode,
    error: rawError ?? error,
  }).category;
  const needsCredentials =
    aliasCredentialsPending ||
    credentialCategory === "credentials" ||
    credentialCategory === "authentication";
  const passphraseRequired =
    pendingRemoteTarget?.kind === "ssh" && Boolean(pendingRemoteTarget.privateKeyPath);
  const currentConnectionState = sourceManagementSnapshot?.states.find(
    (state) =>
      state.profileId === upgradeProfileId ||
      sourceManagementSnapshot.profiles.some(
        (profile) =>
          profile.profileId === state.profileId &&
          pendingRemoteTarget &&
          pendingRemoteTarget.kind !== "server" &&
          profileMatchesRemoteTarget(profile, pendingRemoteTarget),
      ),
  );
  const resumeBackground = () => {
    const finish = pendingBackgroundCompletion.current;
    if (!finish) {
      handleOpenChange(true);
      return;
    }
    const operationEpoch = entryEpochRef.current;
    // 先消费再运行，重复按钮和旧 toast 不能重复恢复。
    pendingBackgroundCompletion.current = null;
    minimizedRef.current = false;
    // 通知继续曾跳过前台通知，资格查询期间原草稿仍可发送；先由原 owner 恢复禁发，再等待 IO。
    applyOpenState(true);
    setBackgroundReady(false);
    setCompletionRunning(true);
    void finish()
      .catch((cause) => {
        // 快照读取也可能延迟失败；取消或换入口后不能用旧错误重新打开弹窗。
        if (entryEpochRef.current !== operationEpoch) return;
        setError(getErrorMessage(cause));
        setCurrentStep("connecting");
        // 显式继续也会等待资格 IO；用户再次收起后，迟到错误只能更新原后台操作。
        if (!minimizedRef.current) applyOpenState(true);
      })
      .finally(() => {
        if (entryEpochRef.current === operationEpoch) setCompletionRunning(false);
      });
  };
  const resumeOpenedBackground = useEffectEvent(() => {
    // 普通入口只更新受控 open，曾绕过后台恢复，导致已完成结果挂在没有继续入口的连接页。
    // 复用同一恢复动作：在途时解除后台标记，完成后一次消费结果，保留取消与代际保护。
    if (minimizedRef.current) resumeBackground();
  });
  useEffect(() => {
    if (open) resumeOpenedBackground();
  }, [open]);
  const displayTarget = useMemo(
    () =>
      pendingRemoteTarget?.kind === "ssh"
        ? {
            kind: "ssh" as const,
            host: pendingRemoteTarget.host,
            username: pendingRemoteTarget.username,
            port: pendingRemoteTarget.port,
          }
        : pendingRemoteTarget?.kind === "server"
          ? {
              kind: "server" as const,
              url: pendingRemoteTarget.url,
              name: pendingRemoteTarget.name,
            }
          : pendingRemoteTarget,
    [pendingRemoteTarget],
  );
  const directoryEpoch = entryEpochRef.current;
  return {
    open,
    currentStep,
    error,
    handleOpenChange,
    header: {
      currentStep,
      deviceManagement: completion === "device-management",
      hideHeading: currentStep === "connecting" && !cancelled,
      title: stepCopy.title,
      description: stepCopy.description,
      // 表单屏头部的实时目标预览，与连接页头部的「类型 + 等宽目标」同构（RDUX-27）。
      settingsPreview:
        currentStep === "settings"
          ? { kind, target: formatRemoteDraftPreview(formSnapshot) }
          : undefined,
      onMinimize: () => {
        // Bug 原因：收起按钮过去被 loading/connectedSessionId 门禁，填写配置和连接失败
        // 等 idle 步骤会看起来像功能被删除。收起始终只改 visibility；状态清理由关闭负责。
        minimizedRef.current = true;
        applyOpenState(false);
      },
      onClose: () => {
        // Bugfix: 关闭和收起的语义不同。关闭仍走确认和取消逻辑，避免已连接但未选目录的 session 泄漏。
        // 更新进行中例外，见 handleDismissRequest。
        handleDismissRequest();
      },
    } satisfies ComponentProps<typeof RemoteConnectionWizardHeader>,
    minimizedProgress:
      !open && minimizedRef.current
        ? {
            operationId: `${openIntentId ?? 0}:${directoryEpoch}`,
            view: currentStep,
            cancelled,
            target: displayTarget,
            name: recognizedDeviceName ?? activeProfileName,
            logs: visibleConnectionLogs,
            ...(workspaceStepPath ? { workspacePath: workspaceStepPath } : {}),
            // Bug 原因（ZCT-2116085848489570304）：更新进行中 error 仍是触发更新的需升级错误，
            // 卡片据此显示“连接失败”。连接屏由 upgradeLoading 覆盖该错误，卡片也按进行中展示。
            error:
              upgradeLoading || waitingForSourceUpdate || errorCode === "credentials-required"
                ? ""
                : error,
            reason:
              error && !upgradeLoading
                ? intl.formatMessage({
                    id: classifyRemoteConnectionError({
                      errorCode,
                      target: pendingRemoteTarget ?? undefined,
                    }).reasonId,
                  })
                : "",
            waiting:
              aliasCredentialsPending ||
              Boolean(pendingInstallConfirmation) ||
              Boolean(pendingForceUpdate) ||
              waitingForSourceUpdate ||
              errorCode === "credentials-required",
            ready: backgroundReady,
            sourceServerId: recognizedSourceServerId ?? preferredSourceServerId,
            profileId:
              preferredProfileId ??
              sourceManagementSnapshot?.profiles.find(
                (profile) =>
                  pendingRemoteTarget &&
                  pendingRemoteTarget.kind !== "server" &&
                  profileMatchesRemoteTarget(profile, pendingRemoteTarget),
              )?.profileId,
            onCancel: () => {
              // 确认放弃后才取消本机阶段的更新；远端阶段只放弃原意图（R3 §6.3）。
              if (entryEpochRef.current === directoryEpoch)
                void handleCloseRequest(() => void cancelOwnedSourceUpdate());
            },
            onResume: () => {
              if (
                entryEpochRef.current !== directoryEpoch ||
                (backgroundReady && !pendingBackgroundCompletion.current)
              )
                return;
              resumeBackground();
            },
          }
        : null,
    aliasCredentials: aliasCredentialsPending
      ? {
          password,
          onPasswordChange: setPassword,
          onSubmit: () => {
            void handleConnect();
          },
        }
      : null,
    selectionStep: {
      snapshot: sourceManagementSnapshot,
      aliases: sshConfigAliases,
      distros: wslDistros,
      containers: dockerContainers,
      availableKinds,
      dockerAvailable,
      loading: discoveryLoading,
      discoveryError,
      remoteConversationWorkspaceBySourceServerId,
      onSelectProfile: (profile, path) => {
        onProjectIntentCleared?.();
        handleSelectProfile(profile, path, { directToDirectory: true });
      },
      onNewConnection: (nextKind) => {
        entryEpochRef.current += 1;
        pendingCompletionIntentRef.current = { options: { announceReusedConnection: true } };
        updatePendingRemoteTarget(null);
        resetDraft();
        setDirectoryPath("");
        setRecognizedDeviceName(undefined);
        setRecognizedSourceServerId(undefined);
        setKind(nextKind);
        setActiveProfileName(undefined);
        setAliasCredentialsPending(false);
        setFocusCredentials(false);
        onProjectIntentCleared?.();
        resetFeedback();
        setCurrentStep("settings");
      },
      onSelectTarget: (target) => {
        resetDraft();
        setDirectoryPath("");
        setRecognizedDeviceName(undefined);
        setRecognizedSourceServerId(undefined);
        setKind(target.kind);
        if (target.kind === "wsl") setWslDistro(target.distro ?? "");
        if (target.kind === "docker") setDockerContainer(target.container);
        setActiveProfileName(undefined);
        onProjectIntentCleared?.();
        void startRemoteConnection(target);
      },
      onSelectAlias: (alias) => {
        resetDraft();
        setDirectoryPath("");
        setRecognizedDeviceName(undefined);
        setRecognizedSourceServerId(undefined);
        setKind("ssh");
        applySshConfigAlias(alias);
        setActiveProfileName(alias.alias);
        pendingCompletionIntentRef.current = {};
        onProjectIntentCleared?.();
        resetFeedback();
        const target: RemoteTarget = {
          kind: "ssh",
          host: alias.host?.trim() || alias.alias,
          username: alias.username?.trim() ?? "",
          port: alias.port,
          sshConfigAlias: alias.alias,
          privateKeyPath: alias.privateKeyPath,
          assetInstallMode: DEFAULT_REMOTE_ASSET_INSTALL_MODE,
        };
        updatePendingRemoteTarget(target);
        if (!target.username) {
          setCurrentStep("settings");
          return;
        }
        if (!target.privateKeyPath) {
          setAliasCredentialsPending(true);
          setCurrentStep("connecting");
          return;
        }
        void startRemoteConnection(target);
      },
    } satisfies ComponentProps<typeof RemoteConnectionSelection>,
    settingsStep: {
      availableKinds: addingDevice ? availableKinds : undefined,
      onKindChange: addingDevice
        ? (nextKind: RemoteTarget["kind"]) => {
            if (nextKind === kind) return;
            entryEpochRef.current += 1;
            resetDraft();
            setKind(nextKind);
            updatePendingRemoteTarget(null);
            setActiveProfileName(undefined);
            setRecognizedSourceServerId(undefined);
            setRecognizedDeviceName(undefined);
            resetFeedback();
          }
        : undefined,
      connectLabel:
        completion === "device-management"
          ? intl.formatMessage({ id: "remote.addAndConnect" })
          : undefined,
      kind: kind,
      host: host,
      port: port,
      username: username,
      sshAuthMethod: sshAuthMethod,
      assetInstallMode: assetInstallMode,
      password: password,
      privateKeyPath: privateKeyPath,
      privateKeyPassphrase: privateKeyPassphrase,
      wslDistro: wslDistro,
      wslUser: wslUser,
      wslDistros: wslDistros,
      dockerContainer: dockerContainer,
      manualDockerContainer: manualDockerContainer,
      serverUrl: serverUrl,
      serverName: serverName,
      serverToken: serverToken,
      serverWorkspacePath: serverWorkspacePath,
      dockerContainers: dockerContainers,
      dockerAvailable: dockerAvailable,
      sshConfigAliases: sshConfigAliases,
      sshConfigAliasesLoading: sshConfigAliasesLoading,
      sshConfigAliasesError: sshConfigAliasesError,
      selectedSshConfigAlias: selectedSshConfigAlias,
      currentRuntimeOptionsLoading: currentRuntimeOptionsLoading,
      currentRuntimeOptionsError: currentRuntimeOptionsError,
      remoteWorkspaceSessions: remoteWorkspaceSessions,
      // 错误由当前字段值实时计算，字段改为有效即消失；唯一规则来源为 collectRemoteFormFieldErrors。
      fieldErrors: validationAttempt > 0 ? collectRemoteFormFieldErrors(intl, formSnapshot) : [],
      validationAttempt,
      focusCredentials: focusCredentials,
      loading: loading,
      onBack: () => {
        if (addingDevice) {
          void handleCloseRequest();
          return;
        }
        resetFeedback();
        setCurrentStep("device");
      },
      onHostChange: setHost,
      onPortChange: setPort,
      onUsernameChange: setUsername,
      onSshAuthMethodChange: setSshAuthMethod,
      onAssetInstallModeChange: setAssetInstallMode,
      onPasswordChange: setPassword,
      onPrivateKeyPathChange: setPrivateKeyPath,
      onPrivateKeyPassphraseChange: setPrivateKeyPassphrase,
      onWslDistroChange: setWslDistro,
      onWslUserChange: setWslUser,
      onDockerContainerChange: setDockerContainer,
      onManualDockerContainerChange: setManualDockerContainer,
      onServerUrlChange: setServerUrl,
      onServerNameChange: setServerName,
      onServerTokenChange: setServerToken,
      onServerWorkspacePathChange: setServerWorkspacePath,
      onDockerContainersRefresh: refreshDockerContainers,
      onApplySshConfigAlias: applySshConfigAlias,
      onClearSelectedSshConfigAlias: clearSelectedSshConfigAlias,
      onConnect: () => {
        void handleConnect();
      },
    } satisfies ComponentProps<typeof RemoteConnectionSettingsStep>,
    connectingStep: {
      backToDevicesLabel: addingDevice
        ? intl.formatMessage({ id: "settings.source.newConnection" })
        : undefined,
      onClose: handleDismissRequest,
      onBackToDevices: () => {
        closeDialog({ keepOpen: true });
        // 返回列表不是重开同一外部入口，不能立即再次消费仍在 props 中的偏好。
        consumedKindPreferenceRef.current = preferredKind
          ? `${preferredKind}:${preferredWslDistro ?? ""}`
          : null;
        consumedPreferredSourceServerIdRef.current = preferredSourceServerId ?? null;
        consumedPreferredProfileIdRef.current = preferredProfileId ?? null;
        consumedPreferredTargetRef.current = preferredTarget ?? null;
        onProjectIntentCleared?.();
      },
      forceUpdate: pendingForceUpdate
        ? {
            ...pendingForceUpdate,
            onConfirm: () => settleForceUpdate(true),
            onCancel: handleCancelConnection,
          }
        : undefined,
      credentials: needsCredentials
        ? {
            passphrase: passphraseRequired,
            value: passphraseRequired ? privateKeyPassphrase : password,
            onChange: passphraseRequired ? setPrivateKeyPassphrase : setPassword,
            onSubmit: () => {
              if (pendingRemoteTarget?.kind !== "ssh") return;
              const value = passphraseRequired ? privateKeyPassphrase : password;
              if (!value) return;
              const target = {
                ...pendingRemoteTarget,
                ...(passphraseRequired ? { privateKeyPassphrase: value } : { password: value }),
              };
              const intent = pendingCompletionIntentRef.current;
              setAliasCredentialsPending(false);
              void startRemoteConnection(
                target,
                false,
                intent.preferredDirectoryPath,
                intent.options,
              );
            },
          }
        : undefined,
      onMinimize: () => {
        minimizedRef.current = true;
        applyOpenState(false);
      },
      kind: kind,
      logs: visibleConnectionLogs,
      errorMessage: error,
      errorCode: errorCode,
      rawError: rawError,
      upgradeTarget: sourceManagementSnapshot?.states.find(
        (state) =>
          state.profileId === upgradeProfileId ||
          sourceManagementSnapshot.profiles.some(
            (profile) =>
              profile.profileId === state.profileId &&
              pendingRemoteTarget &&
              pendingRemoteTarget.kind !== "server" &&
              profileMatchesRemoteTarget(profile, pendingRemoteTarget),
          ),
      )?.upgradeTarget,
      cancelled: cancelled,
      onCancelConnection: handleCancelConnection,
      loading: loading || upgradeLoading,
      upgradeRequired: Boolean(upgradeProfileId),
      upgradeLoading: upgradeLoading && !pendingForceUpdate,
      updateCancelable: updateCancelable && !pendingForceUpdate,
      onUpgrade: () => {
        void handleUpgradeRequiredServer();
      },
      downgradedFrom: sourceManagementSnapshot?.states.find(
        (state) => state.profileId === upgradeProfileId,
      )?.downgradedFrom,
      downgradeVersion: sourceManagementSnapshot?.states.find(
        (state) => state.profileId === downgradeProfileId,
      )?.currentVersion,
      onDowngrade: downgradeProfileId
        ? () => {
            void handleDowngradeServer();
          }
        : undefined,
      onReinstall: reinstallAvailable
        ? () => {
            void handleReinstallServer();
          }
        : undefined,
      // 带项目目录时，设备连上不算完成；成功打开目录后向导直接关闭，连接屏不会显示全部完成。
      connectionReady: Boolean(connectedSessionId) && !error && !workspaceStepPath,
      workspacePath: workspaceStepPath,
      onContinueToDirectory: () => setCurrentStep("directory"),
      target: pendingRemoteTarget,
      recognizedDeviceName: recognizedDeviceName,
      profileName: activeProfileName,
      recognizedDeviceMeta: recognizedServer ? formatDeviceCardMeta(recognizedServer) : undefined,
      localVersion: ZCODE_VERSION,
      onUseRemoteDownload:
        pendingRemoteTarget?.kind === "ssh"
          ? () => {
              const target = {
                ...pendingRemoteTarget,
                assetInstallMode: "remote-download" as const,
              };
              const intent = pendingCompletionIntentRef.current;
              updatePendingRemoteTarget(target);
              void startRemoteConnection(
                target,
                false,
                intent.preferredDirectoryPath,
                intent.options,
              );
            }
          : undefined,
      installConfirmation: pendingInstallConfirmation
        ? {
            target: pendingInstallConfirmation,
            preview: currentConnectionState?.installPreview,
            onConfirm: () => {
              if (entryEpochRef.current !== directoryEpoch) return;
              handleConfirmInstall();
            },
            onCancel: handleCancelInstall,
          }
        : undefined,
      onBack: () => {
        void withConfirmedDiscard(async () => {
          cancelActiveTrace();
          const epoch = ++entryEpochRef.current;
          setBlockedCompletion(null);
          setCompletionRunning(false);
          const sessionId = connectedSessionIdRef.current;
          if (sessionId && ownsConnectedSessionRef.current) void handleCancelSession(sessionId);
          setConnectedSessionId(null);
          activeRequestIdRef.current = null;
          if (loading) {
            await cancelPendingRemoteConnection(connectingRequestId ?? undefined);
            if (entryEpochRef.current !== epoch) return;
            setLoading(false);
          }
          setFocusCredentials(errorCode === "credentials-required");
          setPendingInstallConfirmation(null);
          resetFeedback();
          updateConnectingRequestId(null);
          setCurrentStep("settings");
        });
      },
      onRetry: () => {
        if (errorCode !== "source-server-identity-change-pending") {
          handleStartPendingRemoteConnection();
          return;
        }
        const profileId =
          preferredProfileId ??
          sourceManagementSnapshot?.profiles.find(
            (profile) =>
              pendingRemoteTarget &&
              pendingRemoteTarget.kind !== "server" &&
              profileMatchesRemoteTarget(profile, pendingRemoteTarget),
          )?.profileId;
        if (!profileId || !sourceManagement) return;
        const epoch = entryEpochRef.current;
        void (async () => {
          if (entryEpochRef.current !== epoch) return;
          setUpgradeLoading(true);
          try {
            const snapshot = await sourceManagement.confirmIdentityChange(profileId);
            if (entryEpochRef.current !== epoch) return;
            applySourceManagementSnapshot(snapshot);
            setUpgradeLoading(false);
            handleStartPendingRemoteConnection();
          } catch (cause) {
            if (entryEpochRef.current === epoch) setError(getErrorMessage(cause));
          } finally {
            if (entryEpochRef.current === epoch) setUpgradeLoading(false);
          }
        })();
      },
    } satisfies ComponentProps<typeof RemoteConnectionConnectingStep>,
    directoryStep: {
      directoryPath,
      onDirectoryPathChange: (path) => {
        if (entryEpochRef.current === directoryEpoch) setDirectoryPath(path);
      },
      services: directoryBrowserServices,
      remoteTarget: pendingRemoteTarget,
      sourceServerId: recognizedSourceServerId,
      localWorkspacePath: localWorkspacePath,
      selecting: selectingDirectory,
      onSelect: (path) => {
        void handleSelectDirectory(path);
      },
      onBack: () => {
        void withConfirmedDiscard(handleBackToConnection);
      },
      onCancel: () => {
        void handleCloseRequest();
      },
      onChooseLater: () => {
        // 只释放未绑定项目的临时 attachment；Host 的设备连接独立保留。
        if (!selectingDirectoryRef.current) closeDialog();
      },
      deviceName: recognizedDeviceName,
      profileName: activeProfileName,
      deviceVersion: recognizedServer?.lastSeenVersion,
      onRenameDevice:
        recognizedSourceServerId && sourceManagement
          ? async (name) => {
              const snapshot = await sourceManagement.renameSource(recognizedSourceServerId, name);
              if (entryEpochRef.current !== directoryEpoch) return;
              applySourceManagementSnapshot(snapshot);
              setRecognizedDeviceName(name);
            }
          : undefined,
      quickOpenPaths: quickOpenDirectoryData.paths,
      quickOpenEntries: quickOpenDirectoryData.entries,
    } satisfies ComponentProps<typeof RemoteConnectionDirectoryStep>,
  };
}
