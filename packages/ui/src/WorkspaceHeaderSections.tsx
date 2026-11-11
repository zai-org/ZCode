import { useSessionRuntimeRestart } from "@/app-shell/useWorkspaceSessionReload.js";
import { useOptionalProjectSelectionDirectory } from "@/project-sidebar/index.js";
import { resolveWorkspaceRemoteSessionId } from "@/lib/workspaceServiceResolver.js";
import { RemoteConnectionStateIcon } from "@/remote-connection/RemoteConnectionStateIcon.js";
import { useRemoteProjectPresentationFacts } from "@/hooks/RemoteProjectPresentationContext.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import {
  formatRemoteDeviceName,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import { WorkspaceContextPath } from "@/WorkspaceHeaderSections/WorkspaceContextPath.js";
import { WorkspaceLastActivity } from "@/WorkspaceHeaderSections/WorkspaceLastActivity.js";
/* eslint-disable max-lines -- Header 标题区当前同时承载 task 菜单、路径上下文和 workspace 级状态提示，先保持单文件收口，避免菜单链路迁移时再引入回归。 */
import {
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import {
  TID_WORKSPACE_MORE_BUTTON,
  TID_WORKSPACE_PATH,
  TID_WORKSPACE_TITLE,
} from "@zcode/shared/test-ids";
import { useMemo, useRef, useState } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Ellipsis, Folder, FolderGit2, GitBranch, LoaderCircle } from "lucide-react";
import { formatWorktreeLabel } from "@/managed-worktrees/index.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { TaskActionMenuContent } from "@/TaskActionMenuContent.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatRemoteWorkspaceDisplayLabel,
  formatRemoteWorkspaceHeaderHostLabel,
} from "@/lib/remoteWorkspaceHistory.js";
import { resolveWorkspaceHeaderProvider } from "@/lib/workspaceHeaderProvider.js";
import { toast } from "@/components/ui/toast.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { resolveGitBranchTriggerLabel } from "@/git-branch-switcher/display.js";
import type {
  WorkspaceHeaderState,
  WorkspaceHeaderTitleSectionProps,
} from "@/WorkspaceHeaderSections/shared.js";
import { applyTaskQueryCacheMutation } from "@/store/taskQueryCacheStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import {
  DataSyncEntryMenuItems,
  resolveDataSyncEntrySourceServerId,
  useDataSyncDeviceOnline,
  useDataSyncEntry,
} from "@/data-sync/index.js";
import { useSourceServerDisplayNames } from "@/hooks/useSourceServerDisplayNames.js";
import { useRemoteDevicePresentationInput } from "@/hooks/useSourceServerStatuses.js";

export type { WorkspaceHeaderState, WorkspaceHeaderTitleSectionProps };
export {
  WorkspaceHeaderActionSection,
  type WorkspaceHeaderActionSectionProps,
} from "@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js";

export function WorkspaceHeaderTitleSection({
  variant,
  readOnlyReason,
  workspaceAbsPath,
  remoteSessionId,
  workspaceIdentity,
  remoteTarget,
  localWorkspacePath,
  projectName,
  activeTaskTitle,
  activeTaskChangeSummary: _activeTaskChangeSummary,
  activeTaskId,
  activeTraceId: _activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  gitSummary,
  gitDirtyFileCount: _gitDirtyFileCount,
  sessionLogPath: _sessionLogPath,
  nativeSessionLogProvider: _nativeSessionLogProvider,
  nativeSessionLogPath: _nativeSessionLogPath,
  nativeSessionLogExists: _nativeSessionLogExists,
  nativeSessionLogLoading: _nativeSessionLogLoading,
  providerWorkspaceConfigPath: _providerWorkspaceConfigPath,
  providerWorkspaceConfigExists: _providerWorkspaceConfigExists,
  providerWorkspaceConfigLoading: _providerWorkspaceConfigLoading,
  reloadSessionPending,
  workspaceHeaderState,
  onRefreshGit: _onRefreshGit,
  isMacDesktop: _isMacDesktop,
  isMacFullscreen: _isMacFullscreen,
  isWindowsDesktop: _isWindowsDesktop,
  isWebRemoteControl: _isWebRemoteControl = false,
  selectedEditor: _selectedEditor,
  simplifyForNarrowRemote = false,
  compact = false,
}: WorkspaceHeaderTitleSectionProps) {
  const { intl } = useZCodeIntl();
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const services = useWorkspaceServices(workspaceAbsPath, remoteSessionId, workspaceIdentity);
  const taskRestart = useSessionRuntimeRestart(
    workspaceAbsPath,
    activeSessionId,
    remoteSessionId,
    workspaceIdentity,
  );
  const upsertOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.upsertOptimisticTaskListItem,
  );
  const removeOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.removeOptimisticTaskListItem,
  );
  const setTaskUnreadIndicator = useZCodeSessionStore((state) => state.setTaskUnreadIndicator);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const [workspaceContextOpen, setWorkspaceContextOpen] = useState(false);
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const headerWorkspaceTabs = useMemo(
    () => [
      {
        id: `header-${workspaceIdentity?.trim() || workspaceAbsPath}`,
        kind: "workspace" as const,
        workspacePath: workspaceAbsPath,
        label: projectName,
        remoteSessionId,
        workspaceIdentity,
      },
    ],
    [projectName, remoteSessionId, workspaceAbsPath, workspaceIdentity],
  );
  const headerPinnedTaskList = useGlobalTaskList({
    kind: "pinned",
    // Header 常驻渲染，以前为了菜单里的 pin/unpin 文案会在启动时额外拉一份
    // pinned task 列表。只有打开更多菜单时才需要这个成员状态，延迟查询可以减少首屏
    // listTaskList 数量，并通过 useGlobalTaskList 的共享订阅复用 workspace 事件源。
    workspaceTabs: taskMenuOpen && activeTaskId ? headerWorkspaceTabs : [],
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 20,
  });
  const pinnedTasks = headerPinnedTaskList.items;
  const activeTaskMeta = resolvedActiveTaskMeta ?? null;
  const isPinned = Boolean(
    activeTaskId && pinnedTasks.some((task) => task.taskId === activeTaskId),
  );
  const resolvedTaskActionTaskId = activeTaskMeta?.taskId ?? activeTaskId;
  // 新建任务在第一次写入数据库前没有稳定 taskId。
  // 之前 Header 更多菜单虽然点击后会被回调里的空 id guard 拦住，但 UI 仍显示为可点，
  // 用户会感知成“菜单无响应”；这里只禁用依赖已落库 task 的动作，保留 workspace 级入口。
  const disableTaskTargetActions = !resolvedTaskActionTaskId;
  const taskMenuMembershipLoading =
    taskMenuOpen && Boolean(resolvedTaskActionTaskId) && headerPinnedTaskList.loading;
  const workspaceHeaderProvider = resolveWorkspaceHeaderProvider(
    activeTaskProvider,
    workspaceHeaderState.selectedProvider,
  );
  const menuTaskProvider = activeTaskProvider ?? workspaceHeaderProvider;
  const {
    taskSessionFile,
    taskNativeSessionLogFile,
    providerConfigFile,
    fileManagerLabel,
    handleCopyText,
    handleOpenTaskPathInFileManager,
    handleOpenProviderConfig,
  } = useTaskListItemContextActions({
    workspacePath: workspaceAbsPath,
    remoteSessionId,
    workspaceIdentity,
    taskId: activeTaskId ?? "",
    // 任务日志查询与 Header 当前展示态使用同一个 provider。
    provider: menuTaskProvider,
    intl,
  });
  const remoteWorkspaceHostLabel = remoteTarget
    ? formatRemoteWorkspaceHeaderHostLabel(remoteTarget)
    : null;
  const sourceServerDisplayNames = useSourceServerDisplayNames();
  const sourceServerId = parseRemoteWorkspaceIdentity(workspaceIdentity ?? "")?.sourceServerId;
  const sourceServerDisplayName = sourceServerId
    ? sourceServerDisplayNames.get(sourceServerId)?.trim()
    : undefined;
  const deviceInput = useRemoteDevicePresentationInput(sourceServerId);
  // 远控 tab 只携带身份，bridge 已在身份索引登记；直接读 tab sessionId 会误报断线。
  const attached = useRemoteWorkspaceSessionStore((state) => {
    const sessionId = resolveWorkspaceRemoteSessionId(
      { workspacePath: workspaceAbsPath, workspaceIdentity, remoteSessionId, remoteTarget },
      state,
    );
    return Boolean(sessionId && state.sessionsById[sessionId]?.services);
  });
  // 远控没有 Source 管理服务，设备名称复用窗口目录；精确 Host 身份避免同路径串设备。
  const projectDirectory = useOptionalProjectSelectionDirectory();
  const hostId = remoteHostIdFromWorkspaceIdentity(workspaceIdentity ?? "");
  const directoryTarget = projectDirectory?.directory.hosts.find(
    (host) => host.id === hostId,
  )?.target;
  const projectFacts = useRemoteProjectPresentationFacts(
    workspaceIdentity?.trim() || workspaceAbsPath,
  );
  const presentation = resolveRemoteConnectionPresentation({
    ...deviceInput,
    attached,
    ...projectFacts,
  });
  const remoteStatusLabel = presentation.recovery
    ? intl.formatMessage({ id: presentation.recovery.messageId }, presentation.recovery.values)
    : intl.formatMessage({ id: presentation.shortMessageId });
  const workspaceDisplayLabel = formatRemoteWorkspaceDisplayLabel(projectName, remoteTarget);
  const remoteDeviceName =
    formatRemoteDeviceName(remoteTarget ?? directoryTarget ?? undefined, sourceServerDisplayName) ??
    intl.formatMessage({ id: "workspaceSidebar.remoteProject" });
  // worktree 任务的头部标识只读当前任务的 worktree 根目录（docs/git/worktree.md §3.7）。
  const managedWorktreeLabel =
    activeTaskMeta?.taskId === activeTaskId
      ? formatWorktreeLabel(intl, activeTaskMeta?.worktreeRoot)
      : null;
  const managedWorktree = managedWorktreeLabel !== null;
  const workspaceContextLabel = managedWorktreeLabel ?? workspaceDisplayLabel;
  const workspaceBranchLabel = gitSummary.isRepository
    ? resolveGitBranchTriggerLabel({
        headRefType: gitSummary.headRefType,
        currentBranchName: gitSummary.branchName,
        detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
        fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
      })
    : null;
  const isRemoteWorkspace = Boolean(
    remoteWorkspaceHostLabel || workspaceIdentity?.trim() || remoteSessionId,
  );
  // 同步入口打开数据同步弹窗：设备取自 tab 的 workspace identity，MCP 按当前项目做 workspace 映射。
  const dataSync = useDataSyncEntry();
  const dataSyncSourceServerId = resolveDataSyncEntrySourceServerId({
    workspacePath: workspaceAbsPath,
    workspaceIdentity,
    remoteTarget,
  });
  const dataSyncDeviceOnline = useDataSyncDeviceOnline(dataSyncSourceServerId);
  const showDataSyncEntry = dataSync.available && Boolean(dataSyncSourceServerId);
  const workspaceActionLoading = reloadSessionPending;
  const workspaceActionLoadingTitle = intl.formatMessage({
    id: "appHeader.workspaceSessionActionLoading",
  });
  // 新任务草稿还没有稳定 task 作用域，header 再展示 workspace/分支会和空态主文案重复抢焦点。
  // 草稿态继续隐藏上下文入口；已有 task 将工作区与分支收进名称前的图标提示。
  const isDraftNewTask = variant ? variant === "draft" : activeTaskId === null;

  const handleOpenTaskFeedback = async () => {
    const taskTitle =
      activeTaskTitle ||
      intl.formatMessage({
        id: activeTaskMeta?.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
      });
    // Header 更多菜单缺少当前任务的反馈入口，用户只能复制日志再手动新建反馈。
    // 这里打开反馈表单时预填任务标题、路径和日志线索，截图和诊断日志由用户主动选择。
    openFeedbackSubmit({
      title: intl
        .formatMessage(
          { id: "feedback.submit.template.section.taskFeedbackTitle" },
          { title: taskTitle },
        )
        .slice(0, 80),
      type: "bug",
      module: "Agent任务执行失败",
      severity: "P2-中",
      includeLogs: true,
      description: buildTaskFeedbackDescription({
        taskTitle,
        taskId: resolvedTaskActionTaskId ?? undefined,
        workspacePath: workspaceAbsPath,
        taskSessionPath: taskSessionFile.path,
        taskLogPath: taskNativeSessionLogFile.path,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "taskList.feedbackOpened" }));
  };

  const handleStartRenameTask = () => {
    if (!resolvedTaskActionTaskId) {
      return;
    }
    setRenamingTaskId(resolvedTaskActionTaskId);
    setRenameDraft(activeTaskMeta?.title ?? activeTaskTitle ?? "");
  };

  const handleCancelRenameTask = () => {
    setRenamingTaskId(null);
    setRenameDraft("");
  };

  const buildHeaderTaskSnapshot = (
    fallbackTask: ZCodeTaskMeta,
    overrides?: Partial<ZCodeTaskMeta>,
  ): ZCodeTaskMeta => {
    if (activeTaskMeta) {
      return {
        ...activeTaskMeta,
        ...overrides,
      };
    }

    return {
      ...fallbackTask,
      title: activeTaskTitle ?? fallbackTask.title,
      ...overrides,
    };
  };

  const handleSubmitRenameTask = async () => {
    if (!renamingTaskId) {
      return;
    }

    const normalizedTitle = renameDraft.trim();
    const currentTitle = activeTaskMeta?.title ?? activeTaskTitle ?? "";
    if (normalizedTitle === currentTitle.trim()) {
      handleCancelRenameTask();
      return;
    }

    try {
      const renamedTask = await services.zcodeTaskService.renameTask({
        taskId: renamingTaskId,
        workspacePath: workspaceAbsPath,
        title: normalizedTitle,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      upsertOptimisticTaskListItem(workspaceAbsPath, renamedTask, workspaceIdentity);
      applyTaskQueryCacheMutation({
        previousTask: buildHeaderTaskSnapshot(renamedTask, {
          title: currentTitle,
        }),
        nextTask: renamedTask,
        previousState: { pinned: isPinned, archived: false },
        nextState: { pinned: isPinned, archived: false },
      });
      handleCancelRenameTask();
    } catch {
      toast(intl.formatMessage({ id: "taskList.renameFailed" }));
    }
  };

  return (
    <div
      className={cn(
        // 标题区必须按内容占宽，不能 flex-1 铺满整条 header。
        // 父级 header 是 drag 区域；如果 no-drag 的标题区铺满剩余空间，mac/Windows 标题栏空白处会无法拖动窗口。
        "flex min-w-0 items-center gap-2 overflow-hidden [app-region:no-drag]",
        simplifyForNarrowRemote && "max-md:gap-1",
      )}
    >
      <TaskRenameDialog
        open={!isDraftNewTask && renamingTaskId !== null}
        value={renameDraft}
        inputRef={renameInputRef}
        intl={intl}
        onOpenChange={(open) => {
          if (!open) {
            handleCancelRenameTask();
          }
        }}
        onChange={setRenameDraft}
        onCancel={handleCancelRenameTask}
        onConfirm={() => {
          void handleSubmitRenameTask();
        }}
      />
      {!isDraftNewTask || isRemoteWorkspace ? (
        <ControlHintTooltip
          open={workspaceContextOpen}
          onOpenChange={setWorkspaceContextOpen}
          side="bottom"
          align="start"
          className="w-72 items-start border-popover-border bg-popover p-3 text-popover-foreground shadow-md [&>span:first-child]:min-w-0 [&>span:first-child]:flex-1 [&>span:first-child]:text-ui-base [&>span:first-child]:text-popover-foreground"
          title={
            <span
              data-workspace-header-context-info=""
              className="flex w-full min-w-0 flex-col gap-3 text-left"
            >
              <span className="flex min-w-0 items-start gap-2">
                {isRemoteWorkspace ? (
                  <RemoteConnectionStateIcon presentation={presentation} project />
                ) : managedWorktree ? (
                  <FolderGit2 className="size-4 shrink-0" />
                ) : (
                  <Folder className="size-4 shrink-0" />
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    {workspaceContextLabel}
                  </span>
                  {isRemoteWorkspace ? (
                    <span className="inline-flex w-fit min-w-0 max-w-full items-center gap-1 rounded-full bg-surface py-px pl-1.5 pr-2 text-ui-sm font-normal text-foreground-subtle">
                      <span className={cn("size-1.5 shrink-0 rounded-full", presentation.dot)} />
                      <span className="truncate">{remoteDeviceName}</span>
                      {presentation.status !== "online" ? (
                        <span>
                          {presentation.recovery
                            ? intl.formatMessage(
                                { id: presentation.recovery.messageId },
                                presentation.recovery.values,
                              )
                            : intl.formatMessage({ id: presentation.shortMessageId })}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                  {workspaceContextOpen && isRemoteWorkspace ? (
                    <span
                      data-workspace-context-path=""
                      className="break-all font-mono text-ui-sm text-foreground-subtle"
                    >
                      {workspaceAbsPath}
                    </span>
                  ) : workspaceContextOpen ? (
                    <WorkspaceContextPath
                      // worktree 任务显示自己的 cwd，而不是项目主目录（§3.7）。
                      workspacePath={
                        (activeTaskMeta?.taskId === activeTaskId
                          ? activeTaskMeta?.cwd
                          : undefined) ?? workspaceAbsPath
                      }
                      workspaceIdentity={workspaceIdentity}
                      remoteSessionId={remoteSessionId}
                    />
                  ) : null}
                </span>
              </span>
              {workspaceContextOpen ? (
                <WorkspaceLastActivity
                  task={activeTaskMeta?.taskId === activeTaskId ? activeTaskMeta : null}
                />
              ) : null}
              {workspaceBranchLabel ? (
                <span className="flex min-w-0 items-center gap-2 border-t border-border/50 pt-3 font-normal">
                  <GitBranch className="size-4 shrink-0" />
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    {workspaceBranchLabel}
                  </span>
                </span>
              ) : null}
            </span>
          }
        >
          <Button
            type="button"
            variant="ghost"
            size={isRemoteWorkspace ? "sm" : compact ? "icon-sm" : "icon-md"}
            className={
              isRemoteWorkspace
                ? "min-w-0 max-w-40 gap-1.5 px-1.5 text-foreground-subtle"
                : undefined
            }
            data-testid={TID_WORKSPACE_PATH}
            // 上下文信息改为 tooltip 承载后，这个按钮不再有 DOM title；工作区绝对路径
            // 是 e2e 判定“header 属于哪个工作区”的唯一锚点（aria-label 只有显示名），
            // 因此单独用数据属性暴露，避免和 tooltip 争抢原生提示。
            data-workspace-abs-path={workspaceAbsPath}
            aria-description={isRemoteWorkspace ? remoteStatusLabel : undefined}
            aria-label={[workspaceContextLabel, workspaceBranchLabel].filter(Boolean).join(" · ")}
            onClick={() => setWorkspaceContextOpen(true)}
          >
            {isRemoteWorkspace ? (
              <>
                <RemoteConnectionStateIcon presentation={presentation} project />
                <span data-workspace-device-name="" className="min-w-0 truncate text-ui-sm">
                  {remoteDeviceName}
                </span>
              </>
            ) : managedWorktree ? (
              <FolderGit2 className="size-4 text-foreground-subtle" />
            ) : (
              <Folder className="size-4 text-foreground-subtle" />
            )}
          </Button>
        </ControlHintTooltip>
      ) : null}
      {!isDraftNewTask ? (
        <h1
          data-testid={TID_WORKSPACE_TITLE}
          className={cn(
            "flex min-w-12 max-w-100 shrink items-center gap-2 truncate font-semibold text-foreground @max-[560px]/workspace-header:max-w-[30vw] @max-[420px]/workspace-header:max-w-[22vw]",
            simplifyForNarrowRemote && "max-md:max-w-[42vw]",
            compact ? "text-[0.92rem]" : "text-ui-base",
          )}
          title={activeTaskTitle}
        >
          <span className="min-w-0 truncate">{activeTaskTitle}</span>
          {/* {activeTaskChangeSummary ? (
          <>
            {activeTaskChangeSummary.added > 0 ? (
              <span className="text-diff-added">
                +{activeTaskChangeSummary.added}
              </span>
            ) : null}
            {activeTaskChangeSummary.removed > 0 ? (
              <span className="text-diff-removed">
                -{activeTaskChangeSummary.removed}
              </span>
            ) : null}
          </>
        ) : null} */}
        </h1>
      ) : null}
      <div className="flex min-w-0 shrink-0 items-center gap-1">
        {!isDraftNewTask ? (
          <DropdownMenu open={taskMenuOpen} onOpenChange={setTaskMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size={compact ? "icon-sm" : "icon-md"}
                data-testid={TID_WORKSPACE_MORE_BUTTON}
                aria-label={intl.formatMessage({ id: "common.more" })}
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              {showDataSyncEntry && dataSyncSourceServerId ? (
                <>
                  <DataSyncEntryMenuItems
                    disabled={!dataSyncDeviceOnline}
                    onSelect={(category) =>
                      dataSync.open({
                        sourceServerId: dataSyncSourceServerId,
                        category,
                        ...(localWorkspacePath
                          ? {
                              workspace: {
                                sourceWorkspacePath: localWorkspacePath,
                                targetWorkspacePath: workspaceAbsPath,
                              },
                            }
                          : {}),
                      })
                    }
                  />
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <TaskActionMenuContent
                intl={intl}
                isPinned={isPinned}
                fileManagerLabel={fileManagerLabel}
                taskSessionFile={taskSessionFile}
                activeSessionId={activeSessionId}
                taskNativeSessionLogFile={taskNativeSessionLogFile}
                providerConfigFile={providerConfigFile}
                disableTaskTargetActions={disableTaskTargetActions || taskMenuMembershipLoading}
                disableTaskActions={Boolean(readOnlyReason)}
                disabledReason={readOnlyReason}
                disablePinTaskAction={taskMenuMembershipLoading}
                hideMobileUnsupportedActions={simplifyForNarrowRemote}
                Item={DropdownMenuItem}
                Separator={DropdownMenuSeparator}
                onRestartTask={
                  activeSessionId && !readOnlyReason
                    ? () => {
                        void taskRestart.restart();
                      }
                    : undefined
                }
                restartPending={taskRestart.pending}
                onTogglePinTask={() => {
                  if (!resolvedTaskActionTaskId) {
                    return;
                  }
                  const optimisticTask = activeTaskMeta ?? null;
                  if (optimisticTask) {
                    applyTaskQueryCacheMutation({
                      previousTask: optimisticTask,
                      nextTask: optimisticTask,
                      previousState: { pinned: isPinned, archived: false },
                      nextState: { pinned: !isPinned, archived: false },
                    });
                  }
                  void services.zcodeTaskService
                    .setTaskPinned({
                      taskId: resolvedTaskActionTaskId,
                      workspacePath: workspaceAbsPath,
                      pinned: !isPinned,
                      ...(workspaceIdentity ? { workspaceIdentity } : {}),
                    })
                    .then((meta) => {
                      removeOptimisticTaskListItem(
                        workspaceAbsPath,
                        resolvedTaskActionTaskId,
                        workspaceIdentity,
                      );
                      applyTaskQueryCacheMutation({
                        previousTask: buildHeaderTaskSnapshot(meta),
                        nextTask: meta,
                        previousState: { pinned: !isPinned, archived: false },
                        nextState: { pinned: !isPinned, archived: false },
                      });
                    })
                    .catch(() => {
                      if (optimisticTask) {
                        applyTaskQueryCacheMutation({
                          previousTask: optimisticTask,
                          nextTask: optimisticTask,
                          previousState: { pinned: !isPinned, archived: false },
                          nextState: { pinned: isPinned, archived: false },
                        });
                      }
                      toast(intl.formatMessage({ id: "taskList.pinFailed" }));
                    });
                }}
                onStartRenameTask={handleStartRenameTask}
                onMarkTaskAsUnread={() => {
                  if (!resolvedTaskActionTaskId) {
                    return;
                  }
                  void services.zcodeTaskService
                    .setTaskUnread({
                      taskId: resolvedTaskActionTaskId,
                      workspacePath: workspaceAbsPath,
                      unread: true,
                      ...(workspaceIdentity ? { workspaceIdentity } : {}),
                    })
                    .then((meta) => {
                      setTaskUnreadIndicator(
                        workspaceAbsPath,
                        resolvedTaskActionTaskId,
                        true,
                        workspaceIdentity,
                      );
                      upsertOptimisticTaskListItem(workspaceAbsPath, meta, workspaceIdentity);
                      applyTaskQueryCacheMutation({
                        previousTask: buildHeaderTaskSnapshot(meta),
                        nextTask: meta,
                        previousState: { pinned: isPinned, archived: false },
                        nextState: { pinned: isPinned, archived: false },
                      });
                    });
                }}
                onOpenTaskFeedback={() => {
                  void handleOpenTaskFeedback();
                }}
                onOpenTaskPathInFileManager={() => {
                  void handleOpenTaskPathInFileManager();
                }}
                onCopyWorkspacePath={() => {
                  void handleCopyText(
                    intl.formatMessage({ id: "appHeader.copyPath" }),
                    workspaceAbsPath,
                  );
                }}
                onCopyTaskPath={() => {
                  void handleCopyText(
                    intl.formatMessage({ id: "appHeader.copyTaskPath" }),
                    taskSessionFile.path,
                  );
                }}
                onCopyTaskLogPath={() => {
                  void handleCopyText(
                    intl.formatMessage({ id: "appHeader.copyLogPath" }),
                    taskNativeSessionLogFile.path,
                  );
                }}
                onCopySessionId={() => {
                  void handleCopyText(
                    intl.formatMessage({ id: "appHeader.copySessionId" }),
                    activeSessionId,
                  );
                }}
                onViewModelTrajectory={
                  resolvedTaskActionTaskId
                    ? () => {
                        useModelTrajectoryStore.getState().requestOpen({
                          taskId: resolvedTaskActionTaskId,
                          workspaceKey: workspaceIdentity?.trim() || workspaceAbsPath,
                          title: activeTaskMeta?.title ?? null,
                        });
                      }
                    : undefined
                }
                onOpenProviderConfig={() => {
                  void handleOpenProviderConfig();
                }}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {dataSync.dialog}
        {!isDraftNewTask && workspaceActionLoading ? (
          <ControlHintTooltip
            title={workspaceActionLoadingTitle}
            side="bottom"
            align="start"
            className="max-w-84 items-start px-2 py-1.5"
          >
            <span
              role="img"
              aria-label={workspaceActionLoadingTitle}
              className={cn(
                "inline-flex items-center justify-center rounded-full text-foreground-subtle",
                compact ? "size-6" : "size-7",
              )}
            >
              <LoaderCircle className={cn("animate-spin", compact ? "size-3.5" : "size-4")} />
            </span>
          </ControlHintTooltip>
        ) : null}
      </div>
    </div>
  );
}
