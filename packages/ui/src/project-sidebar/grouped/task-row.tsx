import { TID_TASK_ITEM, TID_TASK_ROW_WORKTREE_ICON, testId } from "@zcode/shared/test-ids";
import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";
import { memo, useContext, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { UniqueIdentifier } from "@dnd-kit/core";
import { isCronTask, isOffPeakTask } from "@zcode/shared";
import { ArrowUpToLine, Clock, GitBranch, ListTree, LoaderCircle, Moon, X } from "lucide-react";
import { formatWorktreeLabel } from "@/managed-worktrees/index.js";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { toast } from "@/components/ui/toast.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  deriveTaskLeadingIndicator,
  formatTaskRelativeTime,
  isTaskRowRenameBlockedTarget,
} from "@/lib/taskListItemPresentation.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import {
  getTaskListAttention,
  getTaskListRowActivity,
  isTaskListRowRunning,
} from "@/v4/taskListRowActivity.js";
import { GroupedTaskContextMenuContent } from "@/project-sidebar/grouped/task-context-menu-content.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import { TaskInteractionBadge } from "@/TaskInteractionBadge.js";
import { TaskRowIdentityHoverCard } from "@/task-row-hover/index.js";
import {
  TASK_GROUP_ROW_CLASS,
  TASK_GROUP_ROW_LINE_CLASS,
  type TaskGroupMenuItem,
} from "@/project-sidebar/grouped/types.js";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";
import { useTaskInteractionAutoResolutionSnooze } from "@/hooks/useTaskInteractionAutoResolutionSnooze.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";

function GroupedTaskRowComponent({
  task,
  currentGroupId,
  groups,
  remoteSessionId,
  isActive,
  isMobileActive,
  workspaceLabel,
  onSelectTask,
  onCloseTask,
  onOpenFileTree,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  dragId,
  dragging,
  dragOverlay,
  tooltipsDisabled,
}: {
  task: ZCodeTaskMeta;
  currentGroupId?: string;
  groups: TaskGroupMenuItem[];
  remoteSessionId?: string;
  isActive: boolean;
  isMobileActive: boolean;
  workspaceLabel: string;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onCloseTask: (task: ZCodeTaskMeta) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  dragId?: UniqueIdentifier;
  dragging?: boolean;
  dragOverlay?: boolean;
  tooltipsDisabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const presentation = useContext(ProjectTaskListContext);
  const workspaceActionsDisabled = useOptionalTabStore((state) =>
    isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
    : undefined;
  const snoozeInteractionAutoResolution = useTaskInteractionAutoResolutionSnooze({
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: task.taskId,
  });
  const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
  const taskActivity = getTaskListRowActivity(task);
  const taskAttention = getTaskListAttention(task);
  // 交互胶囊是当前最高优先级的右侧状态；无论来自 sessions-index 摘要还是
  // activity attention，都不应再并排显示相对时间并挤压任务标题。
  const hasPendingInteraction = Boolean(task.pendingInteraction) || taskAttention !== null;
  // Bugfix：远端 session 未就绪时打开文件树必然会被 resolver 拒绝，因此不要暴露
  // 无效 action；本地 task 不需要 remoteSessionId，仍保持入口可用。
  const canOpenFileTree =
    Boolean(onOpenFileTree) && (!task.workspaceIdentity?.trim() || Boolean(remoteSessionId));
  const taskAttentionLabel = taskAttention
    ? intl.formatMessage({
        id: taskAttention.kind === "userInput" ? "taskList.userInputTag" : "taskList.permissionTag",
      })
    : null;
  const taskAttentionDisplay =
    taskAttention && taskAttentionLabel && taskAttention.count > 1
      ? intl.formatMessage(
          { id: "taskList.attentionCount" },
          { label: taskAttentionLabel, count: String(taskAttention.count) },
        )
      : taskAttentionLabel;
  const leadingIndicator = deriveTaskLeadingIndicator(task, taskActivity);
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });
  const taskTimeLabel = formatTaskRelativeTime(task.updatedAt, intl);
  const isTaskCron = isCronTask(task);
  // 月亮身份改为持久 meta 标记判断；off-peak store 反查在任务被删除后会丢失
  // 会话溯源，且让每一行多背一个全局 store 订阅。
  const isTaskOffPeak = isOffPeakTask(task);
  // worktree 标识只读任务的 worktree 根目录（tasks-index worktree_root，docs/git/worktree.md §3.7）。
  const worktreeLabel = formatWorktreeLabel(intl, task.worktreeRoot);
  const statusDotClassName =
    leadingIndicator === "error"
      ? "bg-destructive"
      : leadingIndicator === "unread"
        ? // Bugfix: grouped task 未读点需要和普通 task list 共用 sky 色，避免 brand 色在不同主题下表达漂移。
          "bg-sky-500 dark:bg-sky-400"
        : null;
  const canShowHoverActions = !dragOverlay;
  // 工作流运行行：分组行同样长在标题下；
  // drag overlay 只是纯展示，不挂确认副作用与点击入口。
  const workflowRunLinesNode =
    taskActivity?.workflowActivity && !dragOverlay ? (
      <TaskWorkflowRunLines
        activity={taskActivity.workflowActivity}
        isActive={isActive}
        intl={intl}
        session={{
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
          sessionId: task.taskId,
        }}
      />
    ) : null;

  const taskRow = (
    <div
      role={dragOverlay ? undefined : "button"}
      tabIndex={dragOverlay ? undefined : 0}
      data-mobile-active-task={!dragOverlay && isMobileActive ? "true" : undefined}
      className={cn(
        "group/task-row",
        TASK_GROUP_ROW_CLASS,
        dragOverlay
          ? "pointer-events-none cursor-grabbing border border-border bg-background shadow-lg opacity-100"
          : "cursor-pointer",
        isActive ? "bg-selected" : canShowHoverActions && "hover:bg-surface-hover",
        dragging && "opacity-0",
      )}
    >
      <span className={TASK_GROUP_ROW_LINE_CLASS}>
        <TaskTitleOverflowText
          as="span"
          className="text-foreground"
          title={dragOverlay ? undefined : taskTitle}
        >
          {/* Bugfix: grouped task 标题超出时不要显示省略号，右侧渐隐能保留标题连续性，避免和右侧状态元信息挤在一起。 */}
          {taskTitle}
        </TaskTitleOverflowText>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          {task.pendingInteraction ? (
            <TaskInteractionBadge
              interaction={task.pendingInteraction}
              formatMessage={(id) => intl.formatMessage({ id })}
              onSnoozeCountdown={dragOverlay ? undefined : snoozeInteractionAutoResolution}
            />
          ) : taskAttentionDisplay ? (
            <Badge
              className={cn(
                "h-5 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18",
                canShowHoverActions && "group-hover/task-row:hidden",
              )}
            >
              {taskAttentionDisplay}
            </Badge>
          ) : null}
          <span
            className={cn(
              "flex shrink-0 items-center gap-1",
              canShowHoverActions && "group-hover/task-row:hidden",
            )}
          >
            {leadingIndicator === "loading" ? (
              <LoaderCircle className="size-3.5 animate-spin text-foreground-subtle" />
            ) : statusDotClassName ? (
              <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                <span className={cn("size-1.5 rounded-full", statusDotClassName)} />
              </span>
            ) : null}
            {!hasPendingInteraction && isTaskCron ? (
              // drag overlay 也复用 grouped row 元信息；clock 放时间前面，不能跟未读点互斥。
              <Clock
                data-cron-task-icon="true"
                aria-label={intl.formatMessage({ id: "taskList.cronTaskLabel" })}
                className="size-3.5 shrink-0"
              />
            ) : !hasPendingInteraction && isTaskOffPeak ? (
              <Moon
                data-off-peak-task-icon="true"
                aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                className="size-3.5 shrink-0"
              />
            ) : null}
            {!hasPendingInteraction ? <span className="mr-1">{taskTimeLabel}</span> : null}
          </span>
        </span>
      </span>
    </div>
  );

  // DragOverlay 高频渲染时只返回纯展示节点，避免隐藏 action tooltip 的 Radix ref 循环和 task 路径 RPC。
  if (dragOverlay) return taskRow;

  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [taskRowHovered, setTaskRowHovered] = useState(false);
  const [taskRowFocusWithin, setTaskRowFocusWithin] = useState(false);
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const {
    taskSessionFile,
    taskNativeSessionLogFile,
    providerConfigFile,
    fileManagerLabel,
    handleCopyText,
    handleOpenTaskPathInFileManager,
    handleOpenProviderConfig,
  } = useTaskListItemContextActions({
    workspacePath: task.workspacePath,
    remoteSessionId,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    provider: task.provider,
    intl,
    loadTaskPaths: contextMenuOpen,
    loadProviderConfig: contextMenuOpen,
  });
  const handleSelect = () => {
    onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
  };
  const handleRowClick = (event: MouseEvent<HTMLDivElement>) => {
    // 双击的第二击交给 onDoubleClick 的重命名，避免重复打开任务或重复建立远端连接。
    if (event.detail > 1) return;
    handleSelect();
  };
  const handleRowDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (workspaceActionsDisabled || dragging || contextMenuOpen) return;
    if (isHoverNone || event.defaultPrevented) return;
    if (isTaskRowRenameBlockedTarget(event.target)) return;
    onStartRenameTask(task);
  };
  // 关闭即归档；归档不停止 agent turn，运行中归档后新建的 browser tab 无处可见、无法关闭。
  const archiveDisabledReason = isTaskListRowRunning(task)
    ? intl.formatMessage({ id: "taskList.archiveBlockedWhileRunning" })
    : undefined;
  const handleCloseTask = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled || archiveDisabledReason) {
      return;
    }
    onCloseTask(task);
  };
  const handleOpenFileTree = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onOpenFileTree?.(task);
  };
  const handleMoveTaskToTop = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onMoveTaskToTop(task);
  };
  const handleOpenTaskFeedback = async () => {
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
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        taskSessionPath: taskSessionFile.path,
        taskLogPath: taskNativeSessionLogFile.path,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "taskList.feedbackOpened" }));
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    handleSelect();
  };
  const dragDisabled = workspaceActionsDisabled || !dragId || contextMenuOpen || dragOverlay;
  const draggable = useDraggable({
    id: dragId ?? `disabled:${workspaceKey}:${task.taskId}`,
    disabled: dragDisabled,
    data: { type: "grouped-task", taskKey: dragId },
  });
  const droppable = useDroppable({
    id: dragId ?? `disabled-drop:${workspaceKey}:${task.taskId}`,
    disabled: workspaceActionsDisabled || !dragId || dragOverlay,
    data: { type: "grouped-task", taskKey: dragId },
  });

  const setTaskRowRef = (element: HTMLDivElement | null) => {
    draggable.setNodeRef(element);
    droppable.setNodeRef(element);
  };
  const groupedTaskDomKey = typeof dragId === "string" ? encodeURIComponent(dragId) : undefined;
  // Bug 原因：CSS hidden → flex 会让 action trigger 在 pointer 到达时才获得布局尺寸，
  // Tooltip Portal 可能先以未定位坐标绘制。改为交互状态决定 action 是否挂载，
  // 同时保留键盘、触摸设备和手机远控 active task 的入口。
  const shouldMountHoverActions =
    !task.pendingInteraction &&
    (taskRowHovered || taskRowFocusWithin || isHoverNone || isMobileActive);
  // 触屏端 isHoverNone 只负责常驻 action；时间、状态点和 cron/off-peak 元信息
  // 仍应保留，仅在真实 hover / focus 交互时让位，避免手机端永久丢失任务状态。
  const shouldSuppressTaskMetadata = taskRowHovered || taskRowFocusWithin;

  const interactiveTaskRow = (
    <div
      ref={setTaskRowRef}
      {...draggable.attributes}
      {...draggable.listeners}
      role="button"
      tabIndex={0}
      onClick={handleRowClick}
      onDoubleClick={handleRowDoubleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setTaskRowHovered(true)}
      onMouseLeave={() => setTaskRowHovered(false)}
      onFocusCapture={() => setTaskRowFocusWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setTaskRowFocusWithin(false);
        }
      }}
      data-grouped-task-key={groupedTaskDomKey}
      data-testid={testId(TID_TASK_ITEM, task.taskId)}
      data-task-item-key={groupedTaskDomKey}
      data-mobile-active-task={isMobileActive ? "true" : undefined}
      className={cn(
        "group/task-row",
        TASK_GROUP_ROW_CLASS,
        "cursor-pointer",
        isActive ? "bg-selected" : "hover:bg-surface-hover",
        dragging && "opacity-0",
      )}
    >
      <span className={TASK_GROUP_ROW_LINE_CLASS}>
        <TaskTitleOverflowText as="span" className="text-foreground" title={taskTitle}>
          {/* Bugfix: grouped task 标题超出时不要显示省略号，右侧渐隐能保留标题连续性，避免和右侧状态元信息挤在一起。 */}
          {taskTitle}
        </TaskTitleOverflowText>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          {task.pendingInteraction ? (
            <TaskInteractionBadge
              interaction={task.pendingInteraction}
              formatMessage={(id) => intl.formatMessage({ id })}
              onSnoozeCountdown={snoozeInteractionAutoResolution}
            />
          ) : taskAttentionDisplay && !shouldSuppressTaskMetadata ? (
            <Badge className="h-5 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18">
              {taskAttentionDisplay}
            </Badge>
          ) : null}
          {!shouldSuppressTaskMetadata ? (
            <span className="flex shrink-0 items-center gap-1">
              {leadingIndicator === "loading" ? (
                <LoaderCircle className="size-3.5 animate-spin text-foreground-subtle" />
              ) : statusDotClassName ? (
                <span
                  aria-hidden="true"
                  className="flex size-4 shrink-0 items-center justify-center"
                >
                  <span className={cn("size-1.5 rounded-full", statusDotClassName)} />
                </span>
              ) : null}
              {!hasPendingInteraction && isTaskCron ? (
                // 可交互 grouped row 之前漏渲染 clock，导致 Projects 分组里的定时任务没有 icon。
                // 这里和普通 task list 一样放在时间前面，同时不再被未读/运行状态顶掉。
                <Clock
                  data-cron-task-icon="true"
                  aria-label={intl.formatMessage({ id: "taskList.cronTaskLabel" })}
                  className="size-3.5 shrink-0"
                />
              ) : !hasPendingInteraction && isTaskOffPeak ? (
                <Moon
                  data-off-peak-task-icon="true"
                  aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                  className="size-3.5 shrink-0"
                />
              ) : null}
              {!hasPendingInteraction && worktreeLabel ? (
                <GitBranch
                  data-testid={TID_TASK_ROW_WORKTREE_ICON}
                  aria-label={intl.formatMessage({ id: "taskList.managedWorktreeLabel" })}
                  className="size-3.5 shrink-0"
                />
              ) : null}
              {!hasPendingInteraction ? <span className="mr-1">{taskTimeLabel}</span> : null}
            </span>
          ) : null}
          {shouldMountHoverActions ? (
            <span className="flex shrink-0 items-center gap-0.5">
              {canOpenFileTree ? (
                <TaskRowActionButton
                  label={intl.formatMessage({ id: "git.action.showTree" })}
                  onClick={handleOpenFileTree}
                  showTooltip
                  disabledReason={workspaceActionsDisabledReason}
                >
                  <ListTree className="size-3.5" />
                </TaskRowActionButton>
              ) : null}
              <TaskRowActionButton
                label={intl.formatMessage({ id: "taskGroup.moveToTop" })}
                onClick={handleMoveTaskToTop}
                showTooltip
                disabledReason={workspaceActionsDisabledReason}
              >
                <ArrowUpToLine className="size-3.5" />
              </TaskRowActionButton>
              <TaskRowActionButton
                label={intl.formatMessage({ id: "common.close" })}
                onClick={handleCloseTask}
                showTooltip
                disabledReason={workspaceActionsDisabledReason ?? archiveDisabledReason}
              >
                <X className="size-3.5" />
              </TaskRowActionButton>
            </span>
          ) : null}
        </span>
      </span>
      {workflowRunLinesNode}
    </div>
  );

  // grouped row 不能用原生 button 承载整行；行内还有菜单、关闭、文件树等 button，外层继续用 role=button，避免嵌套 button 破坏键盘和右键菜单语义。
  return (
    <ContextMenu onOpenChange={setContextMenuOpen}>
      {tooltipsDisabled ? (
        // overlay 拖拽时指针下方的真实 row 仍可能被 Radix 识别为 hover，跳过触发器避免底层 row 或 action 弹出悬浮卡片。
        <ContextMenuTrigger asChild>{interactiveTaskRow}</ContextMenuTrigger>
      ) : (
        <TaskRowIdentityHoverCard
          task={task}
          workspaceLabel={workspaceLabel}
          remoteSessionId={remoteSessionId}
          disabled={presentation.isWebRemoteControl}
        >
          <ContextMenuTrigger asChild>{interactiveTaskRow}</ContextMenuTrigger>
        </TaskRowIdentityHoverCard>
      )}
      {contextMenuOpen ? (
        // 右键菜单内容带 Radix Presence/Portal，拖拽重排时常驻挂载会触发嵌套更新循环；仅在菜单打开时挂载内容，配合路径懒加载避免拖拽过程刷 task path RPC。
        <GroupedTaskContextMenuContent
          task={task}
          currentGroupId={currentGroupId}
          groups={groups}
          intl={intl}
          fileManagerLabel={fileManagerLabel}
          taskSessionFile={taskSessionFile}
          taskNativeSessionLogFile={taskNativeSessionLogFile}
          providerConfigFile={providerConfigFile}
          onMoveTaskToGroup={onMoveTaskToGroup}
          onMoveTaskToTop={onMoveTaskToTop}
          onStartRenameTask={onStartRenameTask}
          onArchiveTask={onArchiveTask}
          onMarkTaskAsUnread={onMarkTaskAsUnread}
          onOpenTaskPathInFileManager={() => void handleOpenTaskPathInFileManager()}
          onCopyText={(label, text) => void handleCopyText(label, text)}
          onOpenProviderConfig={() => void handleOpenProviderConfig()}
          onOpenTaskFeedback={() => void handleOpenTaskFeedback()}
          disabledReason={workspaceActionsDisabledReason}
          archiveDisabledReason={archiveDisabledReason}
        />
      ) : null}
    </ContextMenu>
  );
}
export const GroupedTaskRow = memo(GroupedTaskRowComponent);
