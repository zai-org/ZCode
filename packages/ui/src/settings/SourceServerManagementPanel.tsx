import {
  useRemoteConnectionProgress,
  RemoteConnectionMinimizedProgress,
  summarizeRemoteConnectionProgress,
} from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { DesktopCommandIds, ZCODE_VERSION } from "@zcode/shared";
/* eslint-disable max-lines -- Source/Profile/迁移三类管理操作共享同一 Host 快照和错误状态。 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FileWarning,
  Folder,
  ListTree,
  LoaderCircle,
  Pencil,
  Plus,
  Power,
  RotateCw,
  Server,
  Box,
  TerminalSquare,
  Copy,
  Trash2,
  Unplug,
  Wrench,
} from "lucide-react";
import { resolveWorkspaceKey } from "@zcode/shared";
import type {
  ConnectionProfile,
  AppSettings,
  SourceServerManagementSnapshot,
  SourceServerMigrationReport,
  SourceServerRecord,
  SourceServerWorkspaceHistoryEntry,
} from "@zcode/shared";
import type { ISourceServerManagementService } from "@zcode/services";
import { getPathLeaf } from "@/lib/path.js";
import { toast } from "@/components/ui/toast.js";
import { getSourceServerManagementErrorMessage } from "@/lib/sourceServerManagementError.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { useSourceServerOperationLogs } from "@/hooks/useSourceServerOperationLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SourceServerMigrationReportPanel } from "@/settings/SourceServerMigrationReportPanel.js";
import {
  resolveSourceServerUpdatePercent,
  SourceServerLogList,
  SourceServerUpdateActivity,
} from "@/settings/SourceServerUpdateActivity.js";
import {
  SourceServerDeviceRow,
  type SourceServerDeviceRowProgress,
} from "@/settings/SourceServerDeviceRow.js";
import {
  matchesSourceServerDeviceSearch,
  reconcileSourceServerDeviceOrder,
} from "@/settings/sourceServerDeviceList.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import {
  resolveRemoteConnectionPresentation,
  getRemoteDevicePresentationInput,
  classifyRemoteConnectionError,
  type RemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import {
  sourceServerUpdatePreferences,
  sourceServerUpdateKey,
  useDeferredSourceServerUpdates,
} from "@/lib/sourceServerUpdatePreferences.js";
import {
  getRemoteServiceLifecycleDescription,
  getSourceServerForceUpdateDescription,
  getSourceServerDowngradeConfirmation,
  getSourceServerReinstallConfirmation,
  isSourceServerCredentialsRequiredError,
  readSourceServerRunningTasksForConfirmation,
  resolveSourceServerLifecycleActionAvailability,
  resolveSourceServerReinstallAvailability,
  runSourceServerUpdate,
} from "@/lib/sourceServerUpdateAction.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { EditConnectionProfileDialog } from "@/remote-connection/EditConnectionProfileDialog.js";
import {
  formatConnectionProfileTarget,
  RemoteConnectionKindTag,
  RemoteConnectionStatusTag,
} from "@/remote-connection/RemoteConnectionTags.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import { buildRemoteWorkspaceProjection } from "@/remote/remoteWorkspaceProjection.js";

function formatTimestamp(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatRelativeTimestamp(
  timestamp: number,
  locale: string,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string,
): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return formatMessage({ id: "common.justNow" });
  if (elapsed < 60 * 60_000) {
    return formatMessage({ id: "common.minutesAgo" }, { count: Math.floor(elapsed / 60_000) });
  }
  if (elapsed < 24 * 60 * 60_000) {
    return formatMessage({ id: "common.hoursAgo" }, { count: Math.floor(elapsed / (60 * 60_000)) });
  }
  if (elapsed < 48 * 60 * 60_000) return formatMessage({ id: "common.yesterday" });
  return new Date(timestamp).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
}

export function getProjectCount(
  snapshot: SourceServerManagementSnapshot,
  sourceServerId: string,
  remoteConversationWorkspaceBySourceServerId?: AppSettings["remoteConversationWorkspaceBySourceServerId"],
): number {
  return new Set(
    snapshot.workspaceHistory
      .filter(
        (entry) =>
          entry.sourceServerId === sourceServerId &&
          remoteConversationWorkspaceBySourceServerId?.[sourceServerId]?.workspacePath !==
            entry.workspacePath,
      )
      .map((entry) => resolveWorkspaceKey(entry)),
  ).size;
}

const COLLAPSED_PROJECT_COUNT = 3;

/** 设备行在后台连接等用户处理、或后台连接进行中时显示的状态（RDUX-13 进度展示）。 */
const BACKGROUND_WAITING_PRESENTATION = resolveRemoteConnectionPresentation({ state: "pending" });
const BACKGROUND_CONNECTING_PRESENTATION = resolveRemoteConnectionPresentation({
  state: "connecting",
});

function getProjectDisplayName(server: SourceServerRecord, workspacePath: string): string {
  return (
    server.declaredWorkspaces?.find((item) => item.workspacePath === workspacePath)?.label ??
    getPathLeaf(workspacePath)
  );
}

function toggleSetItem(current: ReadonlySet<string>, item: string): Set<string> {
  const next = new Set(current);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
}

/**
 * 失败详情要打开的连接：优先 Host failed 终态；其次是保持未连接但留有原因的连接
 * （例如停止远端服务失败，Host 按自己选择的路由写入原因，Renderer 不知道是哪条连接）。
 */
function findSourceErrorProfile(
  snapshot: SourceServerManagementSnapshot | null | undefined,
  sourceServerId: string,
): ConnectionProfile | undefined {
  const states = snapshot?.states.filter((state) => state.sourceServerId === sourceServerId) ?? [];
  const state =
    states.find((candidate) => candidate.state === "failed") ??
    states
      .filter((candidate) => candidate.error || candidate.errorCode)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  return snapshot?.profiles.find((profile) => profile.profileId === state?.profileId);
}

/**
 * 设备卡「更多」中的远端服务生命周期操作（RDLC-01）。可用状态、危险确认、同设备互斥与提示规则两者共用；
 * 只有停止使用 destructive 菜单项。顺序即菜单顺序：重启在停止之前。
 */
const REMOTE_SERVICE_LIFECYCLE_ACTIONS = {
  restart: {
    label: "settings.source.restartRemoteService",
    title: "settings.source.restartRemoteServiceTitle",
    completedToast: "sourceServer.restartCompletedToast",
    failedToast: "sourceServer.restartFailedToast",
    intent: "source-server-restart",
    icon: RotateCw,
    variant: "default",
  },
  stop: {
    label: "settings.source.stopRemoteService",
    title: "settings.source.stopRemoteServiceTitle",
    completedToast: "sourceServer.stopCompletedToast",
    failedToast: "sourceServer.stopFailedToast",
    intent: "source-server-stop",
    icon: Power,
    variant: "destructive",
  },
} as const;
type RemoteServiceLifecycleAction = keyof typeof REMOTE_SERVICE_LIFECYCLE_ACTIONS;
const REMOTE_SERVICE_LIFECYCLE_ACTION_ORDER: readonly RemoteServiceLifecycleAction[] = [
  "restart",
  "stop",
];

function profileOperationScope(profile: ConnectionProfile): string {
  return profile.sourceServerId
    ? `source:${profile.sourceServerId}`
    : `profile:${profile.profileId}`;
}

export function SourceServerManagementPanel({
  management,
  targetSourceServerId,
  targetSourceServerDetails = false,
  onTargetSourceServerFocused,
  onCreateConnection,
  onConnectProfile,
  onDisconnectSource,
  onShowInSidebar,
  onOpenProject,
  onShowUpdateDetails,
  workspaceTabs = [],
  settings,
  onUpdateSettings,
  hideProjectDeviceNames = false,
  onHideProjectDeviceNamesChange,
}: {
  management: ISourceServerManagementService;
  targetSourceServerId?: string;
  targetSourceServerDetails?: boolean;
  onTargetSourceServerFocused?: () => void;
  onCreateConnection?: () => void;
  /** 用户点击连接时交给 Root 的全局弹窗，以 preferredProfileId 直达第 4 步。 */
  onConnectProfile?: (profileId: string) => Promise<void> | void;
  /** 用户断开设备时交给 Root 的统一 RemoteWorkspaceController。 */
  onDisconnectSource?: (sourceServerId: string) => Promise<void>;
  /** 「在侧边栏中显示」菜单项：返回工作区主界面（侧边栏设备分组所在处）。 */
  onShowInSidebar?: (sourceServerId: string) => void;
  onOpenProject?: (sourceServerId: string, path: string, profileId?: string) => Promise<void>;
  onShowUpdateDetails?: (sourceServerId: string) => void;
  workspaceTabs?: WorkspaceTabState[];
  /** 「新任务」按钮（原型 L763）：激活该设备已打开的 workspace tab 并开新草稿。 */
  /** 有已打开 workspace tab 的设备 id 集合；「新任务」仅对这些设备渲染。 */
  settings?: Pick<
    AppSettings,
    "remoteStartupAutoReconnectEnabled" | "remoteConversationWorkspaceBySourceServerId"
  > | null;
  onUpdateSettings?: (patch: Partial<AppSettings>) => Promise<unknown> | void;
  hideProjectDeviceNames?: boolean;
  onHideProjectDeviceNamesChange?: (hidden: boolean) => void;
}) {
  const background = useRemoteConnectionProgress();
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const platform = useOptionalPlatform();
  const deferredUpdates = useDeferredSourceServerUpdates();
  const [startupAutoReconnect, setStartupAutoReconnect] = useState(
    settings?.remoteStartupAutoReconnectEnabled ?? true,
  );
  useEffect(() => {
    setStartupAutoReconnect(settings?.remoteStartupAutoReconnectEnabled ?? true);
  }, [settings?.remoteStartupAutoReconnectEnabled]);
  const [editingConnection, setEditingConnection] = useState<{
    profile: ConnectionProfile;
    server?: SourceServerRecord;
    focusField?: "host" | "auth";
  } | null>(null);
  const [errorDetailsProfile, setErrorDetailsProfile] = useState<ConnectionProfile | null>(null);
  const [expandedSavedConnectionSources, setExpandedSavedConnectionSources] = useState<Set<string>>(
    new Set(),
  );
  const [expandedProjectSources, setExpandedProjectSources] = useState<Set<string>>(new Set());
  // 设备列表的展示状态（RDUX-13）：只在面板内存中，面板重挂即重置，不写回 Host。
  const [expandedDevices, setExpandedDevices] = useState<ReadonlySet<string>>(new Set());
  const [highlightedSourceServerId, setHighlightedSourceServerId] = useState<string | null>(null);
  const [deviceSearch, setDeviceSearch] = useState("");
  const [deviceOrder, setDeviceOrder] = useState<readonly string[] | null>(null);
  const [pendingFocusSourceServerId, setPendingFocusSourceServerId] = useState<string | null>(null);
  const deviceTogglesRef = useRef(new Map<string, HTMLButtonElement>());
  // 用户操作任一行（展开或收起）都结束定位高亮；不使用定时器清除。
  const toggleDevice = useCallback((sourceServerId: string) => {
    setExpandedDevices((current) => toggleSetItem(current, sourceServerId));
    setHighlightedSourceServerId(null);
  }, []);
  // 只记录用户手动切换过的日志展开状态；未切换时由设备是否失败决定默认值。
  const [logExpansionBySource, setLogExpansionBySource] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  // 这里只拥有面板操作的防重状态；业务状态与快照版本仍由 Host 和快照 hook 负责。
  const operationsRef = useRef(new Map<string, readonly string[]>());
  const [busyOperations, setBusyOperations] = useState<ReadonlyMap<string, readonly string[]>>(
    new Map(),
  );
  const busyScopes = new Set([...busyOperations.values()].flat());
  if (background?.sourceServerId) busyScopes.add(`source:${background.sourceServerId}`);
  else if (background?.profileId) busyScopes.add(`profile:${background.profileId}`);
  const hasBusyScope = useCallback(
    (scope: string) => [...operationsRef.current.values()].some((scopes) => scopes.includes(scope)),
    [],
  );
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // 相对时间必须随时钟更新，不能依赖连接事件才重绘。
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setClockTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [migrationReports, setMigrationReports] = useState<
    Record<string, SourceServerMigrationReport | undefined>
  >({});

  const {
    snapshot,
    ready,
    applySnapshot,
    refresh: refreshSnapshot,
  } = useSourceServerManagementSnapshot(management, {
    onError: (cause) => setError(getSourceServerManagementErrorMessage(cause, intl.formatMessage)),
  });
  const focusedTargetRef = useRef<string | undefined>(undefined);
  // 定位意图（RDUX-13）：快照就绪且目标设备存在时，清空搜索、只展开目标行并持续高亮；
  // 聚焦与滚动等目标行渲染后再执行。
  useEffect(() => {
    if (!targetSourceServerId) {
      focusedTargetRef.current = undefined;
      return;
    }
    const targetKey = `${targetSourceServerId}:${targetSourceServerDetails}`;
    if (!ready || focusedTargetRef.current === targetKey) return;
    if (!snapshot?.servers.some((server) => server.sourceServerId === targetSourceServerId)) return;
    setDeviceSearch("");
    setExpandedDevices(new Set([targetSourceServerId]));
    setHighlightedSourceServerId(targetSourceServerId);
    setPendingFocusSourceServerId(targetSourceServerId);
    const failedProfile = findSourceErrorProfile(snapshot, targetSourceServerId);
    if (targetSourceServerDetails && failedProfile) setErrorDetailsProfile(failedProfile);
    focusedTargetRef.current = targetKey;
    onTargetSourceServerFocused?.();
  }, [
    ready,
    snapshot,
    targetSourceServerId,
    targetSourceServerDetails,
    onTargetSourceServerFocused,
  ]);
  const { logsByProfileId } = useSourceServerOperationLogs(
    management,
    snapshot?.profiles.map((profile) => profile.profileId),
  );
  const projection = useMemo(
    () =>
      buildRemoteWorkspaceProjection({
        managementSnapshot: snapshot,
        tabs: [],
        remoteConversationWorkspaceBySourceServerId:
          settings?.remoteConversationWorkspaceBySourceServerId,
      }),
    [snapshot, settings?.remoteConversationWorkspaceBySourceServerId],
  );
  const refresh = useCallback(async () => {
    refreshSnapshot();
  }, [refreshSnapshot]);

  const stateByProfile = useMemo(
    () => new Map(snapshot?.states.map((state) => [state.profileId, state]) ?? []),
    [snapshot?.states],
  );
  // 失败提示的“查看详情”在操作结束后才点击，需要读取届时最新的 Host 快照。
  const snapshotRef = useRef(snapshot);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const run = useCallback(
    async (
      key: string,
      operation: () => Promise<SourceServerManagementSnapshot | void>,
      scopes: readonly string[] = [key],
    ) => {
      // 同设备的不同连接互斥；无关设备和日志查看独立，不用全局锁阻塞长时间更新。
      if (operationsRef.current.has(key) || scopes.some(hasBusyScope)) return;
      operationsRef.current.set(key, scopes);
      setBusyOperations(new Map(operationsRef.current));
      setError(null);
      try {
        const nextSnapshot = await operation();
        if (nextSnapshot) applySnapshot(nextSnapshot);
        else refreshSnapshot();
      } catch (cause) {
        setError(getSourceServerManagementErrorMessage(cause, intl.formatMessage));
      } finally {
        operationsRef.current.delete(key);
        setBusyOperations(new Map(operationsRef.current));
      }
    },
    [applySnapshot, refreshSnapshot, intl, hasBusyScope],
  );

  /** 设备操作失败提示；凭据不可静默取得时与内联错误共用补充凭据文案，不提供无内容的详情。 */
  const showOperationFailureToast = useCallback(
    (
      cause: unknown,
      messageId: string,
      source: string,
      sourceServerId: string | undefined,
      openDetails: () => void,
    ) => {
      if (isSourceServerCredentialsRequiredError(cause)) {
        toast(getSourceServerManagementErrorMessage(cause, intl.formatMessage), {
          variant: "warning",
        });
        return;
      }
      toast(intl.formatMessage({ id: messageId }, { source }), {
        variant: "warning",
        actionLabel: intl.formatMessage({ id: "remote.action.details" }),
        onAction: () => {
          // 操作可跨面板生命周期完成，不能让全局 toast 捕获已卸载组件的 setter。
          if (mountedRef.current) openDetails();
          else if (sourceServerId) onShowUpdateDetails?.(sourceServerId);
        },
      });
    },
    [intl, onShowUpdateDetails],
  );

  const removeProfile = useCallback(
    async (profile: ConnectionProfile) => {
      if (!management) return;
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "settings.source.removeProfileTitle" }),
        description: intl.formatMessage(
          { id: "settings.source.removeProfileDescription" },
          { name: profile.displayName ?? profile.transport },
        ),
        confirmLabel: intl.formatMessage({
          id: "settings.source.removeProfile",
        }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      await run(`remove:${profile.profileId}`, () => management.removeProfile(profile.profileId), [
        profileOperationScope(profile),
      ]);
    },
    [confirmDialog, intl, management, run],
  );

  const removeSourceServer = useCallback(
    async (server: SourceServerRecord) => {
      if (hasBusyScope(`source:${server.sourceServerId}`)) return;
      const affectedProjects = workspaceTabs.filter(
        (tab) =>
          getWorkspaceSourceServerId(tab, { workspaceHistory: snapshot?.workspaceHistory }) ===
          server.sourceServerId,
      );
      const projectNotice =
        affectedProjects.length > 0
          ? intl.formatMessage(
              { id: "settings.source.removeOpenProjects" },
              {
                projects: affectedProjects
                  .map((tab) => `${tab.label} (${tab.workspacePath})`)
                  .join("\n"),
              },
            )
          : intl.formatMessage({ id: "settings.source.noOpenProjects" });
      const confirmed = await confirmDialog({
        title: intl.formatMessage({
          id: "settings.source.removeSourceServer",
        }),
        description:
          intl.formatMessage(
            { id: "settings.source.removeSourceServerDescription" },
            { name: server.displayName },
          ) +
          "\n\n" +
          projectNotice,
        confirmLabel: intl.formatMessage({
          id: "settings.source.removeSourceServer",
        }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      await run(
        `remove-source:${server.sourceServerId}`,
        () => management.removeSourceServer(server.sourceServerId),
        [`source:${server.sourceServerId}`],
      );
    },
    [confirmDialog, intl, management, run, snapshot?.workspaceHistory, workspaceTabs, hasBusyScope],
  );

  const loadMigrationReport = useCallback(
    async (sourceServerId: string) => {
      if (!management) return;
      await run(`report:${sourceServerId}`, async () => {
        const report = await management.getMigrationReport(sourceServerId);
        setMigrationReports((current) => ({ ...current, [sourceServerId]: report }));
      });
    },
    [management, run],
  );

  const toggleMigrationReport = useCallback(
    (sourceServerId: string) => {
      if (migrationReports[sourceServerId]) {
        setMigrationReports((current) => {
          const next = { ...current };
          delete next[sourceServerId];
          return next;
        });
        return;
      }
      void loadMigrationReport(sourceServerId);
    },
    [loadMigrationReport, migrationReports],
  );

  const runMigrationOperation = useCallback(
    async (
      key: string,
      sourceServerId: string,
      operation: () => Promise<SourceServerMigrationReport>,
    ) => {
      await run(key, async () => {
        const report = await operation();
        setMigrationReports((current) => ({ ...current, [sourceServerId]: report }));
      }, [`source:${sourceServerId}`]);
    },
    [run],
  );

  const updateProfile = useCallback(
    async (
      profile: ConnectionProfile,
      allowDowngrade = false,
      // RDRI-01：重新安装复用同一更新链，只替换提示文案与设备名称。
      feedback: { source?: string; completedToast?: string; failedToast?: string } = {},
    ) => {
      const source = feedback.source ?? profile.displayName ?? profile.transport;
      await run(
        `update:${profile.profileId}`,
        async () => {
          let next: SourceServerManagementSnapshot | null;
          try {
            next = await runSourceServerUpdate({
              management,
              profileId: profile.profileId,
              allowDowngrade,
              confirmForce: async () =>
                await confirmDialog({
                  title: intl.formatMessage({
                    id: "settings.source.forceUpdateTitle",
                  }),
                  description: await getSourceServerForceUpdateDescription(
                    management,
                    profile.profileId,
                    (id) => intl.formatMessage({ id }),
                  ),
                  confirmLabel: intl.formatMessage({
                    id: "settings.source.forceUpdate",
                  }),
                  confirmVariant: "destructive",
                }),
            });
          } catch (cause) {
            showOperationFailureToast(
              cause,
              feedback.failedToast ?? "sourceServer.updateFailedToast",
              source,
              profile.sourceServerId,
              () => setErrorDetailsProfile(profile),
            );
            throw cause;
          }
          if (next)
            toast(
              intl.formatMessage(
                { id: feedback.completedToast ?? "sourceServer.updateCompletedToast" },
                { source },
              ),
              { variant: "source-server-update" },
            );
          return next ?? undefined;
        },
        [profileOperationScope(profile)],
      );
    },
    [confirmDialog, intl, management, run, showOperationFailureToast],
  );

  /**
   * 重新安装远端服务（RDRI-01）：普通确认后复用更新链，把本机版本 archive 重新装到远端；损坏的同版本
   * release 由远端安装器整体替换。运行中任务守卫与强制确认沿用更新，不另起 Host 操作。
   */
  const reinstallRemoteService = useCallback(
    async (server: SourceServerRecord, profile: ConnectionProfile) => {
      const confirmed = await confirmDialog(
        getSourceServerReinstallConfirmation({
          source: server.displayName,
          version: ZCODE_VERSION,
          formatMessage: intl.formatMessage,
        }),
      );
      if (!confirmed) return;
      await updateProfile(profile, false, {
        source: server.displayName,
        completedToast: "sourceServer.reinstallCompletedToast",
        failedToast: "sourceServer.reinstallFailedToast",
      });
    },
    [confirmDialog, intl, updateProfile],
  );

  /**
   * 重启 / 停止远端服务（RDLC-01）：先按设备读取运行中任务，再弹危险确认，确认后交给 Host。重启期间
   * 设备显示连接中，完成后自动连接；停止由 Host 先断开、再停远端服务，设备保持未连接。
   * 读取、确认与执行处于同一个 `source:<id>` 互斥内：读取期间菜单项禁用，不能重复触发，
   * 读取结束到确认之间也不会插入同设备的其他操作。
   */
  const runRemoteServiceLifecycle = useCallback(
    async (server: SourceServerRecord, action: RemoteServiceLifecycleAction) => {
      const copy = REMOTE_SERVICE_LIFECYCLE_ACTIONS[action];
      await run(
        `${action}:${server.sourceServerId}`,
        async () => {
          try {
            // 读取只在凭据不可静默取得时抛出：此时不打开确认，由下方 catch 给出与更新相同的补充凭据提示。
            const runningTasks = await readSourceServerRunningTasksForConfirmation(
              management,
              server.sourceServerId,
            );
            const confirmed = await confirmDialog({
              title: intl.formatMessage({ id: copy.title }),
              description: getRemoteServiceLifecycleDescription({
                action,
                runningTasks,
                startupAutoReconnect,
                formatMessage: (id) => intl.formatMessage({ id }),
              }),
              confirmLabel: intl.formatMessage({ id: copy.label }),
              confirmVariant: "destructive",
              intent: copy.intent,
              scrollableDescription: true,
            });
            if (!confirmed) return;
            const next =
              action === "restart"
                ? await management.restartSource(server.sourceServerId)
                : await management.stopSource(server.sourceServerId);
            toast(intl.formatMessage({ id: copy.completedToast }, { source: server.displayName }));
            return next;
          } catch (cause) {
            showOperationFailureToast(
              cause,
              copy.failedToast,
              server.displayName,
              server.sourceServerId,
              () => {
                const profile =
                  findSourceErrorProfile(snapshotRef.current, server.sourceServerId) ??
                  snapshotRef.current?.profiles.find(
                    (candidate) => candidate.profileId === server.preferredProfileId,
                  );
                if (profile) setErrorDetailsProfile(profile);
              },
            );
            throw cause;
          }
        },
        [`source:${server.sourceServerId}`],
      );
    },
    [confirmDialog, intl, management, run, showOperationFailureToast, startupAutoReconnect],
  );

  const servers = snapshot?.servers ?? [];
  const profiles = snapshot?.profiles ?? [];
  const activeProfiles = profiles.filter((profile) => profile.lifecycleState !== "retired");
  const retiredProfiles = profiles.filter((profile) => profile.lifecycleState === "retired");
  const unboundProfiles = activeProfiles.filter((profile) => !profile.sourceServerId);

  // 最近使用排序只在快照首次就绪时计算一次；之后只插入新设备、删除已移除设备（RDUX-13）。
  const deviceRecency = servers.map((server) => ({
    sourceServerId: server.sourceServerId,
    online:
      resolveRemoteConnectionPresentation(
        getRemoteDevicePresentationInput(snapshot, server.sourceServerId),
      ).status === "online",
    lastUsedAt: Math.max(
      server.lastOnlineAt ?? 0,
      ...(projection.devices
        .find((candidate) => candidate.sourceServerId === server.sourceServerId)
        ?.knownProjects.map((project) => project.lastOpenedAt) ?? []),
    ),
  }));
  const nextDeviceOrder = ready
    ? reconcileSourceServerDeviceOrder(deviceOrder, deviceRecency)
    : deviceOrder;
  // 渲染期派生：顺序变化时立即更新；没有变化时 reconcile 返回原引用，不会循环渲染。
  if (nextDeviceOrder !== deviceOrder) setDeviceOrder(nextDeviceOrder);
  const serverById = new Map(servers.map((server) => [server.sourceServerId, server]));
  const visibleServers = (nextDeviceOrder ?? [])
    .map((sourceServerId) => serverById.get(sourceServerId))
    .filter((server) => server !== undefined)
    .filter((server) => {
      const device = projection.devices.find(
        (candidate) => candidate.sourceServerId === server.sourceServerId,
      );
      return matchesSourceServerDeviceSearch(deviceSearch, [
        server.displayName,
        server.hostname,
        ...(device?.profiles ?? []).map((profile) => formatConnectionProfileTarget(profile)),
        ...(device?.knownProjects ?? []).map((project) =>
          getProjectDisplayName(server, project.workspacePath),
        ),
      ]);
    });
  useEffect(() => {
    if (!pendingFocusSourceServerId) return;
    const toggle = deviceTogglesRef.current.get(pendingFocusSourceServerId);
    if (!toggle) return;
    toggle.scrollIntoView({ block: "center" });
    toggle.focus({ preventScroll: true });
    setPendingFocusSourceServerId(null);
  }, [pendingFocusSourceServerId, nextDeviceOrder, deviceSearch]);

  const renderIdentityConfirmation = (profile: ConnectionProfile, size: "sm" | "xs") => (
    <Button
      type="button"
      variant="outline"
      size={size}
      disabled={
        busyScopes.has(profileOperationScope(profile)) ||
        stateByProfile.get(profile.profileId)?.state === "updating"
      }
      onClick={() =>
        void confirmDialog({
          title: intl.formatMessage({ id: "settings.source.identityChangeTitle" }),
          description: intl.formatMessage({ id: "settings.source.identityChangeDescription" }),
          confirmLabel: intl.formatMessage({ id: "settings.source.identityChangeConfirm" }),
        }).then((confirmed) =>
          confirmed
            ? run(
                `identity:${profile.profileId}`,
                () => management.confirmIdentityChange(profile.profileId),
                [profileOperationScope(profile)],
              )
            : undefined,
        )
      }
    >
      {busyOperations.has(`identity:${profile.profileId}`) ? (
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
      ) : null}
      {intl.formatMessage({ id: "settings.source.identityChangeConfirm" })}
    </Button>
  );

  const handleProfileAction = (
    profile: ConnectionProfile,
    presentation: RemoteConnectionPresentation,
    server?: SourceServerRecord,
  ) => {
    if (
      !["security", "details"].includes(presentation.primaryAction) &&
      hasBusyScope(profileOperationScope(profile))
    )
      return;
    switch (presentation.primaryAction) {
      case "update-desktop":
        void run("desktop-update", async () => {
          await platform?.executeDesktopCommand(DesktopCommandIds.CheckForUpdates);
        });
        return;
      case "update-server":
        void updateProfile(profile);
        return;
      case "disconnect":
        if (profile.sourceServerId && onDisconnectSource)
          void run(
            `disconnect:${profile.sourceServerId}`,
            () => onDisconnectSource(profile.sourceServerId!),
            [profileOperationScope(profile)],
          );
        return;
      case "credentials":
      case "edit-auth":
        setEditingConnection({ profile, server, focusField: "auth" });
        return;
      case "edit-host":
        setEditingConnection({ profile, server, focusField: "host" });
        return;
      case "security":
      case "details":
        setErrorDetailsProfile(profile);
        return;
      case "none":
        return;
      default:
        void run(
          `connect:${profile.profileId}`,
          async () => {
            await onConnectProfile?.(profile.profileId);
          },
          [profileOperationScope(profile)],
        );
    }
  };

  const renderProfile = (profile: ConnectionProfile, server?: SourceServerRecord) => {
    const state = stateByProfile.get(profile.profileId);
    const isOnline = state?.state === "online";
    const identityChangePending = state?.state === "identity-change-pending";
    const profileName = profile.displayName ?? profile.transport;
    const presentation = resolveRemoteConnectionPresentation({ ...state, target: profile.target });
    const mutationBusy =
      busyScopes.has(profileOperationScope(profile)) || presentation.status === "connecting";
    const actionBusy =
      mutationBusy && !["security", "details"].includes(presentation.primaryAction);
    const devicePresentation = server
      ? resolveRemoteConnectionPresentation(
          getRemoteDevicePresentationInput(snapshot, server.sourceServerId),
        )
      : null;
    const connectionErrorText =
      presentation.reason && devicePresentation?.profileId !== profile.profileId
        ? intl.formatMessage({ id: presentation.reason.titleId }, presentation.reason.values)
        : null;
    return (
      <div
        key={profile.profileId}
        className="group/line -mx-2 flex min-w-0 flex-wrap items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover"
      >
        <RemoteConnectionKindTag kind={profile.transport} />
        {!server ? <RemoteConnectionStatusTag presentation={presentation} /> : null}
        <span className="shrink-0 text-ui-base font-medium text-foreground">{profileName}</span>
        <span className="min-w-0 truncate font-mono text-ui-sm text-remote-foreground-muted">
          {formatConnectionProfileTarget(profile)}
        </span>
        {server?.preferredProfileId === profile.profileId ? (
          <span className="shrink-0 rounded-md bg-tag px-2 py-0.5 text-ui-xs text-remote-foreground-muted">
            {intl.formatMessage({ id: "settings.source.defaultProfile" })}
          </span>
        ) : null}
        <span className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
          {connectionErrorText ? (
            <span
              className="max-w-64 truncate text-ui-sm text-destructive-surface-foreground"
              title={connectionErrorText}
            >
              {connectionErrorText}
            </span>
          ) : profile.lastConnectedAt ? (
            <span
              className="text-ui-sm text-remote-foreground-muted"
              title={formatTimestamp(profile.lastConnectedAt, locale)}
            >
              {intl.formatMessage(
                { id: "settings.source.lastConnected" },
                {
                  time: formatRelativeTimestamp(
                    profile.lastConnectedAt,
                    locale,
                    intl.formatMessage,
                  ),
                },
              )}
            </span>
          ) : null}
          {!isOnline && !identityChangePending ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={actionBusy}
              onClick={() =>
                handleProfileAction(
                  profile,
                  resolveRemoteConnectionPresentation({
                    ...stateByProfile.get(profile.profileId),
                    target: profile.target,
                  }),
                )
              }
            >
              {intl.formatMessage({
                id: resolveRemoteConnectionPresentation({ ...state, target: profile.target })
                  .actionMessageId,
              })}
            </Button>
          ) : null}
          {identityChangePending ? renderIdentityConfirmation(profile, "xs") : null}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={intl.formatMessage({
              id: "settings.source.editConnection",
            })}
            disabled={busyScopes.has(profileOperationScope(profile))}
            onClick={() => setEditingConnection({ profile })}
          >
            <Pencil className="size-3.5" />
            {intl.formatMessage({ id: "settings.source.editConnection" })}
          </Button>
          {server && server.preferredProfileId !== profile.profileId ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={mutationBusy}
              onClick={() =>
                void run(
                  `preferred:${profile.profileId}`,
                  () => management.setPreferredProfile(server.sourceServerId, profile.profileId),
                  [profileOperationScope(profile)],
                )
              }
            >
              {intl.formatMessage({ id: "settings.source.setDefault" })}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={mutationBusy}
            onClick={() => void removeProfile(profile)}
          >
            <Trash2 className="size-3.5" />
            {intl.formatMessage({ id: "settings.source.removeProfile" })}
          </Button>
        </span>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4" aria-busy={busyOperations.size > 0}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <p className="text-ui-base text-remote-foreground-muted">
            {intl.formatMessage({ id: "settings.remoteDevicesDescription" })}
          </p>
          {error ? (
            <p role="alert" className="mt-2 text-ui-base text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        {onCreateConnection && (!ready || profiles.length > 0 || servers.length > 0) ? (
          <Button type="button" size="sm" onClick={onCreateConnection}>
            <Plus className="size-3.5" />
            {intl.formatMessage({ id: "settings.source.newConnection" })}
          </Button>
        ) : null}
      </div>
      {background &&
      !servers.some((server) => server.sourceServerId === background.sourceServerId) &&
      !unboundProfiles.some((profile) => profile.profileId === background.profileId) ? (
        <section
          data-unfinished-background-connection
          className="rounded-xl border border-card-border bg-card pt-3"
        >
          <p className="px-4 text-ui-base font-medium">
            {intl.formatMessage({ id: "settings.source.unfinishedConnections" })}
          </p>
          <RemoteConnectionMinimizedProgress {...background} />
        </section>
      ) : null}
      {!ready && !error ? (
        <p
          role="status"
          className="flex items-center gap-2 text-ui-base text-remote-foreground-muted"
        >
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          {intl.formatMessage({ id: "common.loading" })}
        </p>
      ) : null}
      <div className="min-w-0 space-y-3">
        {servers.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.source.devicesHeading" })}
              <span className="text-ui-xs font-normal text-remote-foreground-muted">
                {servers.length}
              </span>
            </h3>
            <SettingsSearchInput
              containerClassName="w-full max-w-64"
              value={deviceSearch}
              onChange={(event) => setDeviceSearch(event.target.value)}
              onClear={() => setDeviceSearch("")}
              clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
              placeholder={intl.formatMessage({ id: "settings.source.searchPlaceholder" })}
              aria-label={intl.formatMessage({ id: "settings.source.searchPlaceholder" })}
            />
          </div>
        ) : null}
        {servers.length > 0 ? (
          <div
            data-source-server-device-list
            className="@container/source-server-devices overflow-hidden rounded-xl border border-card-border bg-card"
          >
            {visibleServers.length === 0 ? (
              <p className="px-4 py-6 text-center text-ui-base text-remote-foreground-muted">
                {intl.formatMessage(
                  { id: "settings.source.searchEmpty" },
                  { query: deviceSearch.trim() },
                )}
              </p>
            ) : null}
            {visibleServers.map((server) => {
              const device = projection.devices.find(
                (candidate) => candidate.sourceServerId === server.sourceServerId,
              );
              const serverProfiles = device?.profiles ?? [];
              const preferredProfile =
                serverProfiles.find((profile) => profile.profileId === server.preferredProfileId) ??
                serverProfiles[0];
              // 旧 Source 在确认前仍可能是 uninstalled；恢复入口不能藏在安装状态或首选线路折叠后面。
              const pendingIdentityProfiles = serverProfiles.filter(
                (profile) =>
                  stateByProfile.get(profile.profileId)?.state === "identity-change-pending",
              );
              const identityChangeProfile =
                pendingIdentityProfiles.find((profile) => profile === preferredProfile) ??
                pendingIdentityProfiles[0];
              const currentProfile = serverProfiles.find(
                (profile) => stateByProfile.get(profile.profileId)?.state === "online",
              );
              const displayedProfile = currentProfile ?? preferredProfile;
              const ConnectionIcon =
                displayedProfile?.transport === "docker"
                  ? Box
                  : displayedProfile?.transport === "wsl"
                    ? TerminalSquare
                    : Server;
              // 同一项目可能有多条历史（不同连接），保留最近一次，并按最近打开倒序展示。
              const latestProjectByKey = new Map<string, SourceServerWorkspaceHistoryEntry>();
              for (const project of device?.knownProjects ?? []) {
                const key = resolveWorkspaceKey(project);
                const existing = latestProjectByKey.get(key);
                if (!existing || project.lastOpenedAt >= existing.lastOpenedAt)
                  latestProjectByKey.set(key, project);
              }
              const projects = [...latestProjectByKey.values()].sort(
                (left, right) => right.lastOpenedAt - left.lastOpenedAt,
              );
              const projectsExpanded = expandedProjectSources.has(server.sourceServerId);
              const visibleProjects = projectsExpanded
                ? projects
                : projects.slice(0, COLLAPSED_PROJECT_COUNT);
              const openedProjectPaths = new Set(
                workspaceTabs
                  .filter(
                    (tab) =>
                      getWorkspaceSourceServerId(tab, {
                        workspaceHistory: snapshot?.workspaceHistory,
                      }) === server.sourceServerId,
                  )
                  .map((tab) => tab.workspacePath),
              );
              const otherProfiles = displayedProfile
                ? serverProfiles.filter(
                    (profile) =>
                      profile !== displayedProfile && !pendingIdentityProfiles.includes(profile),
                  )
                : [];
              const online = device?.aggregatedStatus === "online";
              const migrationReport = migrationReports[server.sourceServerId];
              const migrationCount = snapshot?.migrationCounts.find(
                (count) => count.sourceServerId === server.sourceServerId,
              );
              const showServerLines = server.installState !== "uninstalled";
              const pendingMigrationCount =
                showServerLines && migrationCount?.status === "available"
                  ? migrationCount.failedPathCount + migrationCount.abandonedPathCount
                  : 0;
              // 覆盖可更新/必须升级/更新中/更新失败四态：更新中不再携带 updateAvailability，也要选中。
              const profileStates = serverProfiles
                .map((profile) => stateByProfile.get(profile.profileId))
                .filter((state) => state !== undefined);
              const presentation = resolveRemoteConnectionPresentation(
                getRemoteDevicePresentationInput(snapshot, server.sourceServerId),
              );
              const actionProfile =
                serverProfiles.find((profile) => profile.profileId === presentation.profileId) ??
                preferredProfile;
              const deviceBusy = busyScopes.has(`source:${server.sourceServerId}`);
              const lifecycleAvailability = resolveSourceServerLifecycleActionAvailability({
                status: presentation.status,
                deviceBusy,
                lastSeenVersion: server.lastSeenVersion,
              });
              const reinstallAvailability = actionProfile
                ? resolveSourceServerReinstallAvailability({
                    status: presentation.status,
                    deviceBusy,
                    installState: server.installState,
                    lastSeenVersion: server.lastSeenVersion,
                    localVersion: ZCODE_VERSION,
                  })
                : ({ visible: false } as const);
              const actionBusy =
                busyOperations.has(`disconnect:${server.sourceServerId}`) ||
                busyOperations.has(`connect:${actionProfile?.profileId}`) ||
                busyOperations.has(`update:${actionProfile?.profileId}`) ||
                (busyOperations.has("desktop-update") &&
                  presentation.primaryAction === "update-desktop");
              const preferredConnectionErrorText = presentation.reason
                ? intl.formatMessage(
                    { id: presentation.reason.titleId },
                    presentation.reason.values,
                  )
                : null;
              const serverState =
                profileStates.find((state) => state.state === "updating") ??
                profileStates.find(
                  (state) =>
                    (state.updateAvailability && state.updateAvailability !== "none") ||
                    state.state === "updating",
                );
              const updateFailed = serverState?.state === "failed";
              const updateKey = sourceServerUpdateKey(
                server.sourceServerId,
                serverState?.availableVersion ?? "",
              );
              const showUpdate =
                serverState &&
                !(
                  serverState.updateAvailability === "available" &&
                  serverState.state !== "updating" &&
                  deferredUpdates.has(updateKey)
                );

              const updateFailureText =
                updateFailed && serverState
                  ? formatRemoteConnectionError({
                      fallback: intl.formatMessage({ id: "settings.source.operationFailed" }),
                      reasonCode: serverState.errorCode,
                      retryable: serverState.retryable,
                      recoveryAttempt: serverState.recoveryAttempt,
                      recoveryLimit: serverState.recoveryLimit,
                      formatMessage: intl.formatMessage,
                    })
                  : null;
              const updateExplainsConnectionError = Boolean(
                showUpdate &&
                serverState?.profileId === presentation.profileId &&
                (serverState?.state === "updating" ||
                  (updateFailed && updateFailureText === preferredConnectionErrorText) ||
                  (serverState?.updateAvailability === "required" &&
                    presentation.reason?.category === "source-server-upgrade-required")),
              );

              const operationLogs =
                logsByProfileId[serverState?.profileId ?? actionProfile?.profileId ?? ""] ?? [];
              const showOtherProfiles = showServerLines && otherProfiles.length > 0;
              const otherProfilesExpanded =
                showOtherProfiles && expandedSavedConnectionSources.has(server.sourceServerId);
              // 更新中由更新横幅展示进度与日志，页脚不重复。
              const showRecentLog = operationLogs.length > 0 && serverState?.state !== "updating";
              const logExpanded =
                showRecentLog &&
                (logExpansionBySource.get(server.sourceServerId) ??
                  presentation.status === "failed");
              // 进度展示（RDUX-13）：折叠时顶边进度线 + 短状态；展开后进度线隐藏，展开区显示完整进度。
              const deviceBackground =
                background?.sourceServerId === server.sourceServerId ? background : null;
              const backgroundSummary = deviceBackground
                ? summarizeRemoteConnectionProgress(deviceBackground)
                : null;
              let rowPresentation = presentation;
              let rowProgress: SourceServerDeviceRowProgress | undefined;
              const backgroundInFlight =
                backgroundSummary?.progressing === true &&
                !backgroundSummary.waiting &&
                !deviceBackground?.error;
              if (deviceBackground && !backgroundInFlight) {
                // Bug 原因：后台连接期间设备操作互斥禁用，而进度块只在展开区。等待输入、已完成、
                // 失败或已取消时若沿用 Host 状态，折叠行会显示“已连接”或禁用的“重试”，看不出
                // 还要继续或处理；这些状态统一提示需要处理，由用户展开后处理。
                rowPresentation = BACKGROUND_WAITING_PRESENTATION;
              } else if (backgroundInFlight) {
                rowPresentation = BACKGROUND_CONNECTING_PRESENTATION;
                rowProgress = { percent: backgroundSummary.percent };
              } else if (serverState?.state === "updating") {
                rowProgress = { percent: resolveSourceServerUpdatePercent(operationLogs) };
              } else if (presentation.status === "connecting") {
                rowProgress = {};
              }
              // 与展开区可选更新横幅同一条件：稍后隐藏，更新中不显示。
              const optionalUpdateVersion =
                showUpdate &&
                serverState &&
                serverState.updateAvailability === "available" &&
                serverState.state !== "updating"
                  ? (serverState.availableVersion?.replace(/^v/i, "") ?? "")
                  : null;
              const expanded = expandedDevices.has(server.sourceServerId);
              const showsPrimaryAction =
                presentation.primaryAction !== "none" &&
                presentation.primaryAction !== "disconnect";
              return (
                <SourceServerDeviceRow
                  key={server.sourceServerId}
                  sourceServerId={server.sourceServerId}
                  name={server.displayName}
                  address={
                    displayedProfile ? formatConnectionProfileTarget(displayedProfile) : undefined
                  }
                  icon={ConnectionIcon}
                  dimIcon={server.installState === "uninstalled"}
                  expanded={expanded}
                  highlighted={highlightedSourceServerId === server.sourceServerId}
                  progress={rowProgress}
                  onToggle={() => toggleDevice(server.sourceServerId)}
                  toggleRef={(element) => {
                    if (element) deviceTogglesRef.current.set(server.sourceServerId, element);
                    else deviceTogglesRef.current.delete(server.sourceServerId);
                  }}
                  metaTone={pendingMigrationCount > 0 ? "warning" : "muted"}
                  metaTitle={
                    pendingMigrationCount > 0
                      ? intl.formatMessage({
                          id: "settings.source.connectionHistoryNeedsAttention",
                        })
                      : undefined
                  }
                  meta={
                    pendingMigrationCount > 0 ? (
                      <>
                        <FileWarning className="size-3.5 text-warning" aria-hidden="true" />
                        {intl.formatMessage(
                          { id: "settings.source.pendingMigrationCount" },
                          { count: pendingMigrationCount },
                        )}
                      </>
                    ) : optionalUpdateVersion !== null ? (
                      intl.formatMessage(
                        { id: "settings.source.updateAvailableVersion" },
                        { version: optionalUpdateVersion },
                      )
                    ) : online ? (
                      intl.formatMessage(
                        { id: "settings.source.projectCount" },
                        { count: projects.length },
                      )
                    ) : server.lastOnlineAt ? (
                      intl.formatMessage(
                        { id: "settings.source.lastOnline" },
                        {
                          time: formatRelativeTimestamp(
                            server.lastOnlineAt,
                            locale,
                            intl.formatMessage,
                          ),
                        },
                      )
                    ) : undefined
                  }
                  status={
                    <RemoteConnectionStatusTag
                      presentation={rowPresentation}
                      compact
                      progressPercent={rowProgress?.percent}
                    />
                  }
                  actions={
                    <>
                      {presentation.primaryAction === "confirm-identity" &&
                      identityChangeProfile ? (
                        renderIdentityConfirmation(identityChangeProfile, "sm")
                      ) : showsPrimaryAction ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={
                            (deviceBusy &&
                              !["security", "details"].includes(presentation.primaryAction)) ||
                            actionBusy ||
                            presentation.status === "connecting"
                          }
                          aria-busy={actionBusy}
                          onClick={() => {
                            if (actionProfile)
                              handleProfileAction(actionProfile, presentation, server);
                            else onCreateConnection?.();
                          }}
                        >
                          {actionBusy ? (
                            <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                          ) : null}
                          {intl.formatMessage({
                            id:
                              server.installState === "uninstalled" &&
                              presentation.primaryAction === "install"
                                ? "settings.source.reinstallAndConnect"
                                : presentation.actionMessageId,
                          })}
                        </Button>
                      ) : null}
                      {presentation.primaryAction === "update-desktop" && preferredProfile ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={deviceBusy}
                          aria-busy={busyOperations.has(`connect:${preferredProfile.profileId}`)}
                          onClick={() =>
                            void run(
                              `connect:${preferredProfile.profileId}`,
                              async () => {
                                await onConnectProfile?.(preferredProfile.profileId);
                              },
                              [profileOperationScope(preferredProfile)],
                            )
                          }
                        >
                          {busyOperations.has(`connect:${preferredProfile.profileId}`) ? (
                            <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                          ) : null}
                          {intl.formatMessage({ id: "remote.action.connect" })}
                        </Button>
                      ) : null}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={intl.formatMessage({ id: "common.more" })}
                          >
                            <Ellipsis className="size-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="w-max min-w-64 [&_[data-slot=dropdown-menu-item]]:whitespace-nowrap"
                        >
                          {/* RDUX-13：编辑与已连接设备的断开从行上移入菜单，断开仍不弹确认。 */}
                          {displayedProfile ? (
                            <DropdownMenuItem
                              disabled={deviceBusy}
                              onSelect={() =>
                                setEditingConnection({ profile: displayedProfile, server })
                              }
                            >
                              <Pencil className="size-3.5" />
                              {intl.formatMessage({ id: "settings.source.editConnection" })}
                            </DropdownMenuItem>
                          ) : null}
                          {presentation.primaryAction === "disconnect" && actionProfile ? (
                            <DropdownMenuItem
                              disabled={deviceBusy || actionBusy}
                              onSelect={() =>
                                handleProfileAction(actionProfile, presentation, server)
                              }
                            >
                              <Unplug className="size-3.5" />
                              <span className="flex min-w-0 flex-col">
                                {intl.formatMessage({ id: "remote.action.disconnect" })}
                                <span className="text-ui-sm text-remote-foreground-muted">
                                  {intl.formatMessage({ id: "settings.source.disconnectHint" })}
                                </span>
                              </span>
                            </DropdownMenuItem>
                          ) : null}
                          {/*
                            Bug 原因：「移除全部连接」曾被包在 online 分支里，简化 UI 删掉离线态的
                            「重命名 / 迁移报告」后离线菜单变成空壳，离线设备再无任何移除入口。
                            移除只删本机记录与凭据，Host removeSourceServer 会先幂等断开再删记录，
                            不依赖远端在线；因此对所有已安装状态都渲染，只有「在侧边栏中显示」保留在线条件。
                          */}
                          {onShowInSidebar &&
                          workspaceTabs.some(
                            (tab) =>
                              getWorkspaceSourceServerId(tab, {
                                workspaceHistory: snapshot?.workspaceHistory,
                              }) === server.sourceServerId,
                          ) ? (
                            <DropdownMenuItem
                              onSelect={() => onShowInSidebar(server.sourceServerId)}
                            >
                              <ListTree className="size-3.5" />
                              {intl.formatMessage({
                                id: "settings.source.showInSidebar",
                              })}
                            </DropdownMenuItem>
                          ) : null}
                          {displayedProfile || presentation.primaryAction === "disconnect" ? (
                            <DropdownMenuSeparator />
                          ) : null}
                          <div
                            className="max-w-80 space-y-1 px-2 py-2 text-ui-sm text-remote-foreground-muted"
                            data-device-info
                          >
                            {[
                              ["version", server.lastSeenVersion],
                              ["hostname", server.hostname],
                              ["osUser", server.osUser],
                              ["deviceId", server.sourceServerId],
                            ].map(([key, value]) => (
                              <p key={key} className="break-all whitespace-normal">
                                <span>
                                  {intl.formatMessage({ id: `settings.source.info.${key}` })}:{" "}
                                </span>
                                {value ?? intl.formatMessage({ id: "remote.infoUnavailable" })}
                              </p>
                            ))}
                          </div>
                          <DropdownMenuItem
                            onSelect={() =>
                              void run(`copy:${server.sourceServerId}`, async () => {
                                await navigator.clipboard.writeText(server.sourceServerId);
                              })
                            }
                          >
                            <Copy className="size-3.5" />
                            {intl.formatMessage({ id: "settings.source.copyDeviceId" })}
                          </DropdownMenuItem>
                          {lifecycleAvailability.visible ? (
                            <>
                              <DropdownMenuSeparator />
                              {REMOTE_SERVICE_LIFECYCLE_ACTION_ORDER.map((action) => {
                                const copy = REMOTE_SERVICE_LIFECYCLE_ACTIONS[action];
                                const Icon = copy.icon;
                                return (
                                  <Fragment key={action}>
                                    {/* RDRI-01：重新安装位于重启与停止之间；可用规则独立，不受远端控制命令版本门禁约束。 */}
                                    {action === "stop" &&
                                    reinstallAvailability.visible &&
                                    actionProfile ? (
                                      <DropdownMenuItem
                                        data-source-server-lifecycle-action="reinstall"
                                        disabled={!reinstallAvailability.enabled || actionBusy}
                                        onSelect={() =>
                                          void reinstallRemoteService(server, actionProfile)
                                        }
                                      >
                                        <Wrench className="size-3.5" />
                                        <span className="flex min-w-0 flex-col">
                                          {intl.formatMessage({
                                            id: "settings.source.reinstallRemoteService",
                                          })}
                                          <span className="text-ui-sm text-remote-foreground-muted">
                                            {intl.formatMessage({
                                              id: "settings.source.reinstallRemoteServiceHint",
                                            })}
                                          </span>
                                        </span>
                                      </DropdownMenuItem>
                                    ) : null}
                                    <DropdownMenuItem
                                      variant={copy.variant}
                                      data-source-server-lifecycle-action={action}
                                      disabled={!lifecycleAvailability.enabled}
                                      onSelect={() =>
                                        void runRemoteServiceLifecycle(server, action)
                                      }
                                    >
                                      <Icon className="size-3.5" />
                                      <span className="flex min-w-0 flex-col">
                                        {intl.formatMessage({ id: copy.label })}
                                        {/* 禁用菜单项不响应指针，版本提示必须常驻在项内而不是悬停提示。 */}
                                        {lifecycleAvailability.requiresRemoteUpdate ? (
                                          <span className="text-ui-sm text-remote-foreground-muted">
                                            {intl.formatMessage({
                                              id: "settings.source.remoteServiceUpdateRequired",
                                            })}
                                          </span>
                                        ) : null}
                                      </span>
                                    </DropdownMenuItem>
                                  </Fragment>
                                );
                              })}
                            </>
                          ) : null}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={deviceBusy}
                            onSelect={() => void removeSourceServer(server)}
                          >
                            <Trash2 className="size-3.5" />
                            {intl.formatMessage({
                              id: "settings.source.removeSourceServer",
                            })}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  }
                >
                  {deviceBackground ? (
                    <div className="-mx-4">
                      <RemoteConnectionMinimizedProgress {...deviceBackground} />
                    </div>
                  ) : presentation.status === "connecting" && presentation.recovery ? (
                    <div className="rounded-lg bg-progress-surface px-3 py-2 text-ui-base text-progress-surface-foreground">
                      {intl.formatMessage(
                        { id: presentation.recovery.messageId },
                        presentation.recovery.values,
                      )}
                    </div>
                  ) : null}
                  <div
                    className="flex min-w-0 flex-wrap items-center gap-2 text-ui-sm text-remote-foreground-muted"
                    data-device-connection
                  >
                    {displayedProfile ? (
                      <>
                        <RemoteConnectionKindTag kind={displayedProfile.transport} />
                        <span
                          className="min-w-0 truncate font-mono"
                          title={formatConnectionProfileTarget(displayedProfile)}
                        >
                          {formatConnectionProfileTarget(displayedProfile)}
                        </span>
                        {/* 只有一条连接时“当前 / 默认”没有区分意义，不显示。 */}
                        {serverProfiles.length > 1 && currentProfile ? (
                          <span className="shrink-0 rounded-md bg-tag px-1.5 py-0.5 text-ui-xs">
                            {intl.formatMessage({
                              id: "settings.source.currentProfile",
                            })}
                          </span>
                        ) : null}
                        {serverProfiles.length > 1 &&
                        displayedProfile.profileId === server.preferredProfileId ? (
                          <span className="shrink-0 rounded-md bg-tag px-1.5 py-0.5 text-ui-xs">
                            {intl.formatMessage({ id: "settings.source.defaultProfile" })}
                          </span>
                        ) : null}
                        {displayedProfile.profileId !== server.preferredProfileId ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={deviceBusy}
                            onClick={() =>
                              void run(
                                `preferred:${displayedProfile.profileId}`,
                                () =>
                                  management.setPreferredProfile(
                                    server.sourceServerId,
                                    displayedProfile.profileId,
                                  ),
                                [`source:${server.sourceServerId}`],
                              )
                            }
                          >
                            {intl.formatMessage({ id: "settings.source.setDefault" })}
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                    {server.lastSeenVersion ? (
                      <span
                        className="shrink-0"
                        title={intl.formatMessage({ id: "settings.source.info.version" })}
                      >
                        {displayedProfile ? "· " : ""}v{server.lastSeenVersion.replace(/^v/i, "")}
                      </span>
                    ) : null}
                    {server.lastOnlineAt && !online ? (
                      <span
                        className="shrink-0"
                        title={formatTimestamp(server.lastOnlineAt, locale)}
                      >
                        {displayedProfile || server.lastSeenVersion ? "· " : ""}
                        {intl.formatMessage(
                          { id: "settings.source.lastOnline" },
                          {
                            time: formatRelativeTimestamp(
                              server.lastOnlineAt,
                              locale,
                              intl.formatMessage,
                            ),
                          },
                        )}
                      </span>
                    ) : null}
                  </div>
                  {/* 更新失败只替代同一连接的相同原因，其他连接和可选更新不能吞掉连接错误。 */}
                  {preferredConnectionErrorText && !updateExplainsConnectionError ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-destructive-surface px-3 py-2 text-ui-base text-destructive-surface-foreground">
                      <span className="min-w-0 flex-1">{preferredConnectionErrorText}</span>
                      {/* RDRI-01：连接失败时就地提供重新安装；与「更多」菜单共用同一可用规则与确认。 */}
                      {presentation.status === "failed" &&
                      reinstallAvailability.visible &&
                      actionProfile ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-source-server-reinstall
                          disabled={!reinstallAvailability.enabled || actionBusy}
                          onClick={() => void reinstallRemoteService(server, actionProfile)}
                        >
                          {intl.formatMessage({ id: "settings.source.reinstallRemoteService" })}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {showUpdate && serverState ? (
                    <div
                      className={cn(
                        "flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-ui-base",
                        presentation.updateNotice.surface,
                        presentation.updateNotice.foreground,
                      )}
                    >
                      <span>
                        {serverState.state === "updating"
                          ? intl.formatMessage({
                              id: "settings.source.updateInProgress",
                            })
                          : updateFailed
                            ? updateFailureText
                            : serverState.updateAvailability === "required"
                              ? intl.formatMessage({
                                  id: "settings.source.updateRequired",
                                })
                              : intl.formatMessage(
                                  { id: "settings.source.updateAvailableVersion" },
                                  {
                                    version: serverState.availableVersion?.replace(/^v/i, "") ?? "",
                                  },
                                )}
                      </span>
                      {serverState.updateAvailability === "available" &&
                      serverState.state !== "updating" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="ml-auto"
                          onClick={() => sourceServerUpdatePreferences.defer(updateKey)}
                        >
                          {intl.formatMessage({ id: "updateDialog.later" })}
                        </Button>
                      ) : null}
                      {serverState.state !== "updating" &&
                      presentation.primaryAction !== "update-server" &&
                      presentation.primaryAction !== "update-desktop" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={deviceBusy || busyOperations.has("desktop-update")}
                          onClick={() => {
                            const profile = serverProfiles.find(
                              (candidate) => candidate.profileId === serverState.profileId,
                            );
                            if (serverState.upgradeTarget === "controller")
                              void run("desktop-update", async () => {
                                await platform?.executeDesktopCommand(
                                  DesktopCommandIds.CheckForUpdates,
                                );
                              });
                            else if (profile) void updateProfile(profile);
                          }}
                        >
                          {intl.formatMessage({
                            id:
                              serverState.upgradeTarget === "controller"
                                ? "remote.action.update-desktop"
                                : updateFailed
                                  ? "remote.action.retry"
                                  : "remote.action.update-server",
                          })}
                        </Button>
                      ) : null}
                      {serverState.upgradeTarget === "controller" &&
                      serverState.updateAvailability === "required" &&
                      serverState.state !== "updating" &&
                      serverState.currentVersion ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={deviceBusy}
                          onClick={() => {
                            const profile = serverProfiles.find(
                              (candidate) => candidate.profileId === serverState.profileId,
                            );
                            if (!profile) return;
                            void confirmDialog(
                              getSourceServerDowngradeConfirmation(serverState, intl.formatMessage),
                            ).then((confirmed) =>
                              confirmed ? updateProfile(profile, true) : undefined,
                            );
                          }}
                        >
                          {intl.formatMessage(
                            { id: "remote.action.downgrade-server" },
                            { version: serverState.currentVersion.replace(/^v/i, "") },
                          )}
                        </Button>
                      ) : null}
                      {serverState.state === "updating" ? (
                        <SourceServerUpdateActivity
                          active={serverState.state === "updating"}
                          logs={operationLogs}
                        />
                      ) : serverState.currentVersion && serverState.minimumVersion ? (
                        <p className="basis-full text-ui-sm opacity-80">
                          {intl.formatMessage(
                            { id: "settings.source.versionDetails" },
                            {
                              current: serverState.currentVersion.replace(/^v/i, ""),
                              minimum: serverState.minimumVersion.replace(/^v/i, ""),
                            },
                          )}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {pendingIdentityProfiles.length > 1 ? (
                    <div>
                      {pendingIdentityProfiles
                        .filter((profile) => profile !== identityChangeProfile)
                        .map((profile) => renderProfile(profile, server))}
                    </div>
                  ) : null}
                  <div className="min-w-0" data-device-projects>
                    {projects.length === 0 ? (
                      <p className="text-ui-sm text-remote-foreground-muted">
                        {intl.formatMessage({ id: "settings.source.projectCount" }, { count: 0 })}
                      </p>
                    ) : (
                      <>
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <p className="text-ui-sm font-medium text-remote-foreground-muted">
                            {intl.formatMessage({ id: "settings.source.recentProjects" })}
                          </p>
                          {/* Bug 原因：旧实现超出三个只显示不可点击的 +N，其余项目在此处无法打开。 */}
                          {projects.length > COLLAPSED_PROJECT_COUNT ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              className="text-remote-foreground-muted"
                              aria-expanded={projectsExpanded}
                              onClick={() =>
                                setExpandedProjectSources((current) =>
                                  toggleSetItem(current, server.sourceServerId),
                                )
                              }
                            >
                              {intl.formatMessage(
                                {
                                  id: projectsExpanded
                                    ? "settings.source.showLessProjects"
                                    : "settings.source.showAllProjects",
                                },
                                { count: projects.length },
                              )}
                            </Button>
                          ) : null}
                        </div>
                        <div className="mt-1 min-w-0">
                          {visibleProjects.map((project) => {
                            const projectName = getProjectDisplayName(
                              server,
                              project.workspacePath,
                            );
                            return (
                              <Button
                                key={resolveWorkspaceKey(project)}
                                data-device-project
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="group/project -mx-2 h-auto w-[calc(100%+1rem)] min-w-0 justify-start gap-2 px-2 py-1.5"
                                aria-label={projectName}
                                title={project.workspacePath}
                                disabled={!onOpenProject || deviceBusy}
                                onClick={() =>
                                  void run(
                                    `open:${resolveWorkspaceKey(project)}`,
                                    () =>
                                      onOpenProject?.(
                                        server.sourceServerId,
                                        project.workspacePath,
                                        displayedProfile?.profileId,
                                      ) ?? Promise.resolve(),
                                    [`source:${server.sourceServerId}`],
                                  )
                                }
                              >
                                <Folder className="size-3.5 text-remote-foreground-muted" />
                                <span className="max-w-48 shrink-0 truncate text-ui-base font-medium">
                                  {projectName}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-left font-mono text-ui-sm text-remote-foreground-muted">
                                  {project.workspacePath}
                                </span>
                                {openedProjectPaths.has(project.workspacePath) ? (
                                  <span className="shrink-0 rounded-md bg-tag px-1.5 py-0.5 text-ui-xs text-remote-foreground-muted">
                                    {intl.formatMessage({ id: "settings.source.projectOpened" })}
                                  </span>
                                ) : null}
                                <span className="shrink-0 text-ui-sm text-remote-foreground-muted">
                                  {formatRelativeTimestamp(
                                    project.lastOpenedAt,
                                    locale,
                                    intl.formatMessage,
                                  )}
                                </span>
                                <ArrowUpRight className="size-3.5 text-remote-foreground-muted opacity-0 group-hover/project:opacity-100 group-focus-visible/project:opacity-100" />
                              </Button>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                  {showOtherProfiles || showRecentLog ? (
                    <div className="border-t border-border pt-2" data-device-card-footer>
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        {showOtherProfiles ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="-ml-2 text-remote-foreground-muted"
                            aria-label={intl.formatMessage({
                              id: "settings.source.otherSavedConnections",
                            })}
                            aria-expanded={otherProfilesExpanded}
                            onClick={() =>
                              setExpandedSavedConnectionSources((current) =>
                                toggleSetItem(current, server.sourceServerId),
                              )
                            }
                          >
                            {otherProfilesExpanded ? (
                              <ChevronDown className="size-3.5" />
                            ) : (
                              <ChevronRight className="size-3.5" />
                            )}
                            {intl.formatMessage(
                              { id: "settings.source.otherSavedConnectionsCount" },
                              { count: otherProfiles.length },
                            )}
                          </Button>
                        ) : null}
                        {showRecentLog ? (
                          <Button
                            data-source-server-log-toggle
                            type="button"
                            variant="ghost"
                            size="sm"
                            // 只有日志入口时靠左，避免页脚左侧空出一整行。
                            className={cn(
                              "text-remote-foreground-muted",
                              showOtherProfiles ? "-mr-2 ml-auto" : "-ml-2",
                            )}
                            aria-expanded={logExpanded}
                            onClick={() =>
                              setLogExpansionBySource((current) =>
                                new Map(current).set(server.sourceServerId, !logExpanded),
                              )
                            }
                          >
                            <ChevronRight
                              className={cn(
                                "size-3.5 transition-transform",
                                logExpanded && "rotate-90",
                              )}
                            />
                            {intl.formatMessage({ id: "settings.source.recentLog" })}
                          </Button>
                        ) : null}
                      </div>
                      {otherProfilesExpanded ? (
                        <div className="mt-1 px-2 py-1">
                          {otherProfiles.map((profile) => renderProfile(profile, server))}
                        </div>
                      ) : null}
                      {logExpanded ? (
                        <div className="mt-1 pb-1">
                          <SourceServerLogList logs={operationLogs} />
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {/* 产品边界：迁移账本是内部兼容机制，仅在存在待处理问题时以用户可理解的连接历史提醒暴露。 */}
                  {pendingMigrationCount > 0 ? (
                    <div className="border-t border-border pt-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="-ml-2 justify-start text-ui-base text-remote-foreground-muted"
                        onClick={() => toggleMigrationReport(server.sourceServerId)}
                      >
                        {migrationReport ? (
                          <ChevronDown className="size-3.5" />
                        ) : (
                          <ChevronRight className="size-3.5" />
                        )}
                        <FileWarning className="size-3.5 text-warning" />
                        {intl.formatMessage({
                          id: "settings.source.connectionHistoryNeedsAttention",
                        })}
                        <span className="font-medium text-warning-surface-foreground">
                          {intl.formatMessage(
                            { id: "settings.source.pendingMigrationCount" },
                            { count: pendingMigrationCount },
                          )}
                        </span>
                      </Button>
                      {migrationReport ? (
                        <SourceServerMigrationReportPanel
                          report={migrationReport}
                          disabled={deviceBusy}
                          onAbandon={(workspacePath, migrationId) => {
                            void confirmDialog({
                              title: intl.formatMessage({
                                id: "settings.source.abandonMigrationTitle",
                              }),
                              description: intl.formatMessage({
                                id: "settings.source.abandonMigrationDescription",
                              }),
                              confirmLabel: intl.formatMessage({
                                id: "settings.source.abandonMigration",
                              }),
                              confirmVariant: "destructive",
                            }).then((confirmed) => {
                              if (!confirmed) return;
                              void runMigrationOperation(
                                `abandon:${server.sourceServerId}:${migrationId}`,
                                server.sourceServerId,
                                () =>
                                  management.abandonWorkspaceMigration(
                                    server.sourceServerId,
                                    workspacePath,
                                    migrationId,
                                  ),
                              );
                            });
                          }}
                          onRetry={(workspacePath, migrationId) =>
                            void runMigrationOperation(
                              `retry:${server.sourceServerId}:${migrationId}`,
                              server.sourceServerId,
                              () =>
                                management.retryWorkspaceMigration(
                                  server.sourceServerId,
                                  workspacePath,
                                  migrationId,
                                ),
                            )
                          }
                        />
                      ) : null}
                    </div>
                  ) : null}
                </SourceServerDeviceRow>
              );
            })}
          </div>
        ) : null}
        {unboundProfiles.length > 0 ? (
          <details
            open={
              background &&
              !background.sourceServerId &&
              unboundProfiles.some((profile) => profile.profileId === background.profileId)
                ? true
                : undefined
            }
            data-unfinished-connections
            className="group/unfinished border-t border-border pt-4"
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 text-ui-base font-medium">
              <ChevronRight className="size-3.5 transition-transform group-open/unfinished:rotate-90" />
              {intl.formatMessage({ id: "settings.source.unfinishedConnections" })}
              <span className="rounded-md bg-tag px-1.5 py-0.5 text-ui-xs font-normal text-remote-foreground-muted">
                {unboundProfiles.length}
              </span>
            </summary>
            <div className="mt-2 space-y-2">
              {unboundProfiles.map((profile) => (
                <div key={profile.profileId}>
                  {renderProfile(profile)}
                  {background &&
                  !background.sourceServerId &&
                  background.profileId === profile.profileId ? (
                    <RemoteConnectionMinimizedProgress {...background} />
                  ) : null}
                  {(logsByProfileId[profile.profileId]?.length ?? 0) > 0 ? (
                    <SourceServerUpdateActivity
                      active={false}
                      recent
                      logs={logsByProfileId[profile.profileId] ?? []}
                    />
                  ) : null}
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  busyOperations.has("clear-unfinished") ||
                  unboundProfiles.some((profile) => busyScopes.has(profileOperationScope(profile)))
                }
                onClick={() => {
                  void confirmDialog({
                    title: intl.formatMessage({ id: "settings.source.clearUnfinished" }),
                    description: intl.formatMessage({
                      id: "settings.source.clearUnfinishedDescription",
                    }),
                    confirmLabel: intl.formatMessage({ id: "settings.source.clearUnfinished" }),
                    confirmVariant: "destructive",
                  }).then((confirmed) => {
                    if (confirmed)
                      void run(
                        "clear-unfinished",
                        async () => {
                          // 清理时复核归属，连接刚成功的设备不能被旧列表误删。
                          const latest = await management.getSnapshot();
                          for (const profile of latest.profiles) {
                            if (!profile.sourceServerId && profile.lifecycleState !== "retired")
                              applySnapshot(await management.removeProfile(profile.profileId));
                          }
                        },
                        unboundProfiles.map(profileOperationScope),
                      );
                  });
                }}
              >
                {intl.formatMessage({ id: "settings.source.clearUnfinished" })}
              </Button>
            </div>
          </details>
        ) : null}
        {retiredProfiles.length > 0 ? (
          <details className="group/retired border-t border-border pt-4">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-ui-base font-medium text-foreground">
              <ChevronRight className="size-3.5 shrink-0 text-remote-foreground-muted transition-transform group-open/retired:rotate-90" />
              {intl.formatMessage(
                { id: "settings.source.retiredProfilesWithCount" },
                { count: retiredProfiles.length },
              )}
              <span className="text-ui-sm font-normal text-remote-foreground-muted">
                {intl.formatMessage({
                  id: "settings.source.retiredProfilesDescription",
                })}
              </span>
            </summary>
            <div className="mt-2 space-y-1 pl-6">
              {retiredProfiles.map((profile) => (
                <div
                  key={profile.profileId}
                  className="flex min-w-0 flex-wrap items-center gap-2 py-1.5 text-remote-foreground-muted"
                >
                  <span className="font-mono text-ui-sm">
                    {profile.displayName ?? profile.transport}
                    {intl.formatMessage({
                      id: "settings.source.retiredNameSuffix",
                    })}
                  </span>
                  <span className="text-ui-sm">
                    {profile.retiredAt
                      ? `${intl.formatMessage(
                          { id: "settings.source.archivedAt" },
                          {
                            time: formatRelativeTimestamp(
                              profile.retiredAt,
                              locale,
                              intl.formatMessage,
                            ),
                          },
                        )} · ${intl.formatMessage({
                          id: "settings.source.retiredEntryNote",
                        })}`
                      : intl.formatMessage({
                          id: "settings.source.retiredEntryNote",
                        })}
                  </span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
        <section className="border-t border-border pt-4">
          <h3 className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({
              id: "settings.source.preferences",
            })}
          </h3>
          <div className="mt-3 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-ui-base text-foreground">
                  {intl.formatMessage({ id: "settings.source.hideProjectDeviceNames" })}
                </p>
                <p className="text-ui-sm text-remote-foreground-muted">
                  {intl.formatMessage({ id: "settings.source.hideProjectDeviceNamesDescription" })}
                </p>
              </div>
              <Switch
                data-testid="hide-project-device-names"
                checked={hideProjectDeviceNames}
                disabled={!onHideProjectDeviceNamesChange}
                onCheckedChange={onHideProjectDeviceNamesChange}
                aria-label={intl.formatMessage({ id: "settings.source.hideProjectDeviceNames" })}
              />
            </div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-ui-base text-foreground">
                  {intl.formatMessage({
                    id: "settings.source.startupAutoReconnect",
                  })}
                </p>
                <p className="text-ui-sm text-remote-foreground-muted">
                  {intl.formatMessage({
                    id: "settings.source.startupAutoReconnectDescription",
                  })}
                </p>
              </div>
              <Switch
                checked={startupAutoReconnect}
                disabled={busyOperations.has("startup-reconnect") || !onUpdateSettings}
                aria-busy={busyOperations.has("startup-reconnect")}
                onCheckedChange={(checked) => {
                  const previous = startupAutoReconnect;
                  setStartupAutoReconnect(checked);
                  void run("startup-reconnect", async () => {
                    try {
                      await onUpdateSettings?.({ remoteStartupAutoReconnectEnabled: checked });
                    } catch (cause) {
                      setStartupAutoReconnect(previous);
                      throw cause;
                    }
                  });
                }}
                aria-label={intl.formatMessage({
                  id: "settings.source.startupAutoReconnect",
                })}
              />
            </div>
          </div>
        </section>
        {ready && profiles.length === 0 && servers.length === 0 ? (
          <div className="space-y-3 py-4 text-center text-ui-base text-remote-foreground-muted">
            <p>{intl.formatMessage({ id: "settings.source.empty" })}</p>
            {onCreateConnection ? (
              <Button type="button" size="sm" onClick={onCreateConnection}>
                <Plus className="size-3.5" />
                {intl.formatMessage({ id: "settings.source.newConnection" })}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <Dialog
        open={Boolean(errorDetailsProfile)}
        onOpenChange={(open) => {
          if (!open) setErrorDetailsProfile(null);
        }}
      >
        <DialogContent>
          {errorDetailsProfile
            ? (() => {
                const state = stateByProfile.get(errorDetailsProfile.profileId);
                const classified = classifyRemoteConnectionError({
                  errorCode: state?.errorCode,
                  error: state?.error,
                  target: errorDetailsProfile.target,
                });
                return (
                  <>
                    <DialogHeader>
                      <DialogTitle>{intl.formatMessage({ id: classified.titleId })}</DialogTitle>
                      <DialogDescription>
                        {intl.formatMessage({ id: classified.reasonId })}
                      </DialogDescription>
                    </DialogHeader>
                    <details>
                      <summary>{intl.formatMessage({ id: "remote.error.details" })}</summary>
                      <pre className="whitespace-pre-wrap break-words text-ui-sm">
                        {state?.error ?? errorDetailsProfile.lastConnectError}
                      </pre>
                    </details>
                    <SourceServerUpdateActivity
                      active={false}
                      recent
                      logs={logsByProfileId[errorDetailsProfile.profileId] ?? []}
                    />
                  </>
                );
              })()
            : null}
        </DialogContent>
      </Dialog>
      <EditConnectionProfileDialog
        open={editingConnection !== null}
        profile={editingConnection?.profile ?? null}
        source={editingConnection?.server}
        focusField={editingConnection?.focusField}
        management={management}
        onOpenChange={(open) => {
          if (!open) setEditingConnection(null);
        }}
        onSaved={refresh}
      />
    </div>
  );
}
