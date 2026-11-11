/* eslint-disable max-lines -- TaskList 同时承接 workspace 列表渲染、行内操作和外部数据源兼容，先集中收口避免 UI 结构漂移。 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TID_TASK_LIST, TID_TASK_EMPTY, TID_TASK_SETTINGS_BUTTON } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { NewTaskButtonGroup } from "@/NewTaskButtonGroup.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { MemoTaskItem, TaskListItemContextMenuContent } from "@/TaskListItem.js";
import { TaskListLoadingHint } from "@/TaskListLoadingHint.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { logger } from "@/logger.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

export { deriveTaskLeadingIndicator } from "@/lib/taskListItemPresentation.js";

// 默认参数里的 [] 会在每次 TaskList render 时创建新数组；
// 任务流刷新期间这会放大 memo 子组件的等价数据判断成本。
const EMPTY_PINNED_TASKS: ZCodeTaskMeta[] = [];

// 父级 App/Shell 可能因 stream 状态更新重渲，但列表 props 本身未变。
// TaskList 先整体 memo，避免无关父 render 重新遍历任务并触发 MemoTaskItem props 计算。
export const TaskList = memo(function TaskList({
  workspacePath,
  remoteSessionId,
  workspaceIdentity,
  tasks,
  pinnedTasks = EMPTY_PINNED_TASKS,
  activeTaskId,
  sortBy = "manual",
  isWorkspaceActive = true,
  onSelectTask,
  showCreateButton = true,
  showFooter = true,
  showEmptyState = true,
  taskRowVariant = "default",
  hoverEnabled = true,
  loading: inputLoading,
  hasMore = false,
  onShowMore,
  onRenameTask,
  onSetTaskPinned,
  onArchiveTask,
  isArchived = false,
  onSetTaskUnread,
  mobileActiveTaskKey,
  readOnlyReason,
  onOpenFileTree,
  organizationActions,
  renameOnDoubleClick = true,
}: {
  organizationActions?: React.ReactNode;
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  tasks: ZCodeTaskMeta[];
  pinnedTasks?: ZCodeTaskMeta[];
  activeTaskId: string | null;
  sortBy?: "manual" | "created" | "updated";
  isWorkspaceActive?: boolean;
  onSelectTask: (taskId: string) => void;
  showCreateButton?: boolean;
  showFooter?: boolean;
  showEmptyState?: boolean;
  taskRowVariant?: "default" | "timeline";
  hoverEnabled?: boolean;
  loading?: boolean;
  hasMore?: boolean;
  onShowMore?: () => void;
  onRenameTask: (taskId: string, title: string) => Promise<ZCodeTaskMeta | null>;
  onSetTaskPinned: (taskId: string, pinned: boolean) => Promise<ZCodeTaskMeta | null>;
  onArchiveTask: (taskId: string) => Promise<ZCodeTaskMeta | null>;
  isArchived?: boolean;
  onSetTaskUnread: (taskId: string, unread: boolean) => Promise<ZCodeTaskMeta | null>;
  mobileActiveTaskKey?: string | null;
  readOnlyReason?: string;
  onOpenFileTree?: () => void | Promise<void>;
  renameOnDoubleClick?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const pinnedTaskIdSet = useMemo(
    () => new Set(pinnedTasks.map((task) => task.taskId)),
    [pinnedTasks],
  );
  const taskLookup = useMemo(() => [...tasks, ...pinnedTasks], [pinnedTasks, tasks]);
  const startDraft = useZCodeSessionStore((state) => state.startDraft);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const [pendingArchiveTaskId, setPendingArchiveTaskId] = useState<string | null>(null);
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);
  const [contextMenuTaskId, setContextMenuTaskId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const pendingArchiveTaskIdRef = useRef<string | null>(pendingArchiveTaskId);
  const renamingTaskIdRef = useRef<string | null>(renamingTaskId);
  const onSelectTaskRef = useRef(onSelectTask);
  const onSetTaskPinnedRef = useRef(onSetTaskPinned);
  const onArchiveTaskRef = useRef(onArchiveTask);
  const onSetTaskUnreadRef = useRef(onSetTaskUnread);
  pendingArchiveTaskIdRef.current = pendingArchiveTaskId;
  renamingTaskIdRef.current = renamingTaskId;
  onSelectTaskRef.current = onSelectTask;
  onSetTaskPinnedRef.current = onSetTaskPinned;
  onArchiveTaskRef.current = onArchiveTask;
  onSetTaskUnreadRef.current = onSetTaskUnread;
  const handleCancelArchiveConfirm = useCallback(() => {
    setPendingArchiveTaskId(null);
  }, []);

  const handleCancelRenameTask = useCallback(() => {
    setRenamingTaskId(null);
    setRenameDraft("");
  }, []);

  const handleSelectTaskItem = useCallback((taskId: string) => {
    onSelectTaskRef.current(taskId);
  }, []);
  const handleOpenTaskContextMenu = useCallback((taskId: string) => {
    // 以前每个 task row 都常驻一个 Radix ContextMenu root/trigger。
    // 现在 row 只上报目标 task，真正的菜单树由列表级单例挂载，避免大会话里按行放大 Popper/MenuProvider 成本。
    if (pendingArchiveTaskIdRef.current === taskId) {
      setPendingArchiveTaskId(null);
    }
    setContextMenuTaskId(taskId);
  }, []);

  const handleCreateTask = useCallback(() => {
    if (readOnlyReason) {
      return;
    }
    // 新建会话如果在按钮点击时就立即 createTask，会把"空任务"也持久化到列表里，
    // 用户只是想先打开输入框，侧边栏却会平白多出一条没有任何消息的记录。
    // 这里改成进入 workspace 级草稿态，等用户真正发送首条消息时再自动创建 task。
    startDraft(workspacePath, undefined, workspaceIdentity, { createSource: "project" });
  }, [readOnlyReason, startDraft, workspaceIdentity, workspacePath]);

  const handleArchiveTaskFromInline = useCallback(
    async (e: React.MouseEvent, taskId: string) => {
      e.stopPropagation();
      if (readOnlyReason) {
        return;
      }
      if (renamingTaskIdRef.current) {
        handleCancelRenameTask();
      }

      if (pendingArchiveTaskIdRef.current !== taskId) {
        // 侧边栏 hover 操作现在改成“归档任务”，但它依旧会让任务从当前列表立刻消失，
        // 如果首击就直接执行，用户很容易把“临时收起”误触成“怎么整条任务没了”。
        // 这里改成“首次点击进入待确认态，二次点击原位确认”，既保留保护，也不离开当前上下文。
        setPendingArchiveTaskId(taskId);
        return;
      }

      setPendingArchiveTaskId(null);
      await onArchiveTaskRef.current(taskId);
    },
    [handleCancelRenameTask, readOnlyReason],
  );

  const handleStartRenameTask = useCallback(
    (taskId: string, currentTitle: string) => {
      if (readOnlyReason) {
        return;
      }
      logger.info("[TaskList] rename start", {
        taskId,
        workspacePath,
        workspaceIdentity,
        titleLength: currentTitle.length,
      });
      setPendingArchiveTaskId(null);
      setRenamingTaskId(taskId);
      setRenameDraft(currentTitle ?? "");
    },
    [readOnlyReason, workspaceIdentity, workspacePath],
  );

  const handleTogglePinTask = useCallback(
    async (taskId: string, pinned: boolean) => {
      if (readOnlyReason) {
        return;
      }
      const updatedTask = await onSetTaskPinnedRef.current(taskId, pinned);
      if (!updatedTask) {
        return;
      }
    },
    [readOnlyReason],
  );

  const handleArchiveTask = useCallback(
    async (taskId: string) => {
      if (readOnlyReason) {
        return;
      }
      setPendingArchiveTaskId(null);
      handleCancelRenameTask();
      await onArchiveTaskRef.current(taskId);
    },
    [handleCancelRenameTask, readOnlyReason],
  );

  const handleSubmitRenameTask = useCallback(
    async (taskId: string) => {
      if (readOnlyReason) {
        return;
      }
      logger.info("[TaskList] rename submit entered", {
        taskId,
        workspacePath,
        workspaceIdentity,
        draftLength: renameDraft.length,
        trimmedLength: renameDraft.trim().length,
        taskCount: taskLookup.length,
      });
      const task = taskLookup.find((candidate) => candidate.taskId === taskId);
      if (!task) {
        logger.warn("[TaskList] rename submit task missing", {
          taskId,
          workspacePath,
          workspaceIdentity,
        });
        handleCancelRenameTask();
        return;
      }

      const normalizedTitle = renameDraft.trim();
      if (normalizedTitle === task.title.trim()) {
        logger.info("[TaskList] rename submit unchanged", {
          taskId,
          workspacePath,
          workspaceIdentity,
          titleLength: normalizedTitle.length,
        });
        handleCancelRenameTask();
        return;
      }

      // task 标题如果直接保留用户输入的首尾空格，列表里看起来像“没对齐”或“标题丢了”，
      // 但真实持久化内容又已经变化，后续排查很难复现。这里在提交前统一 trim，保证显示和存储一致。
      logger.info("[TaskList] rename submit calling onRenameTask", {
        taskId,
        workspacePath,
        workspaceIdentity,
        previousTitleLength: task.title.length,
        nextTitleLength: normalizedTitle.length,
      });
      let renamedTask: ZCodeTaskMeta | null;
      try {
        renamedTask = await onRenameTask(taskId, normalizedTitle);
      } catch (error) {
        logger.error("[TaskList] rename submit onRenameTask rejected", {
          taskId,
          workspacePath,
          workspaceIdentity,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      logger.info("[TaskList] rename submit onRenameTask resolved", {
        taskId,
        workspacePath,
        workspaceIdentity,
        resolved: Boolean(renamedTask),
        resolvedTitleLength: renamedTask?.title.length,
      });
      if (!renamedTask) {
        logger.warn("[TaskList] rename submit returned empty meta", {
          taskId,
          workspacePath,
          workspaceIdentity,
        });
        toast(intl.formatMessage({ id: "taskList.renameFailed" }));
        return;
      }

      handleCancelRenameTask();
      logger.info("[TaskList] rename submit dialog closed", {
        taskId,
        workspacePath,
        workspaceIdentity,
      });
    },
    [
      handleCancelRenameTask,
      intl,
      onRenameTask,
      readOnlyReason,
      renameDraft,
      taskLookup,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleMarkTaskAsUnread = useCallback(
    (taskId: string) => {
      if (readOnlyReason) {
        return;
      }
      void onSetTaskUnreadRef.current(taskId, true);
    },
    [readOnlyReason],
  );

  useEffect(() => {
    if (!renamingTaskId) {
      return;
    }

    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingTaskId]);

  const visibleSourceTasks = useMemo(() => {
    const orderedTasks =
      sortBy === "manual"
        ? tasks
        : [...tasks].sort((left, right) => compareZCodeTaskListItems(left, right, sortBy));
    return orderedTasks;
  }, [sortBy, tasks]);
  useEffect(() => {
    if (!pendingArchiveTaskId) {
      return;
    }

    const stillExists = visibleSourceTasks.some((task) => task.taskId === pendingArchiveTaskId);
    if (!stillExists) {
      setPendingArchiveTaskId(null);
    }
  }, [pendingArchiveTaskId, visibleSourceTasks]);

  useEffect(() => {
    if (!renamingTaskId) {
      return;
    }

    const stillExists = visibleSourceTasks.some((task) => task.taskId === renamingTaskId);
    if (!stillExists) {
      handleCancelRenameTask();
    }
  }, [handleCancelRenameTask, renamingTaskId, visibleSourceTasks]);

  useEffect(() => {
    if (!contextMenuTaskId) {
      return;
    }

    const stillExists = visibleSourceTasks.some((task) => task.taskId === contextMenuTaskId);
    if (!stillExists) {
      setContextMenuTaskId(null);
    }
  }, [contextMenuTaskId, visibleSourceTasks]);

  const contextMenuTask = useMemo(
    () =>
      contextMenuTaskId
        ? (taskLookup.find((task) => task.taskId === contextMenuTaskId) ?? null)
        : null,
    [contextMenuTaskId, taskLookup],
  );

  function renderTaskItem(task: (typeof visibleSourceTasks)[number]) {
    const isPinned = pinnedTaskIdSet.has(task.taskId);
    return (
      <MemoTaskItem
        key={task.taskId}
        workspacePath={workspacePath}
        remoteSessionId={remoteSessionId}
        task={task}
        variant={taskRowVariant}
        hoverEnabled={hoverEnabled}
        isPinned={isPinned}
        isArchived={isArchived}
        isActive={isWorkspaceActive && task.taskId === activeTaskId}
        isMobileActive={
          mobileActiveTaskKey ===
          `${buildTaskWorkspaceKey(workspacePath, workspaceIdentity)}:${task.taskId}`
        }
        onSelectTask={handleSelectTaskItem}
        onArchiveTaskInline={handleArchiveTaskFromInline}
        onCancelArchiveConfirm={handleCancelArchiveConfirm}
        isArchiveConfirming={pendingArchiveTaskId === task.taskId}
        onTogglePinTask={handleTogglePinTask}
        onStartRenameTask={handleStartRenameTask}
        onArchiveTask={handleArchiveTask}
        onMarkTaskAsUnread={handleMarkTaskAsUnread}
        onOpenTaskContextMenu={handleOpenTaskContextMenu}
        onOpenFileTree={onOpenFileTree}
        actionsDisabled={Boolean(readOnlyReason)}
        actionsDisabledReason={readOnlyReason}
        renameOnDoubleClick={renameOnDoubleClick}
        intl={intl}
      />
    );
  }

  return (
    <div data-testid={TID_TASK_LIST} className={"flex flex-col gap-2"}>
      {renamingTaskId !== null ? (
        <TaskRenameDialog
          open
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
            logger.info("[TaskList] rename confirm dispatched", {
              renamingTaskId,
              workspacePath,
              workspaceIdentity,
              draftLength: renameDraft.length,
            });
            if (!renamingTaskId) {
              return;
            }
            void handleSubmitRenameTask(renamingTaskId);
          }}
        />
      ) : null}

      {showCreateButton ? (
        <div className="border-b p-3">
          <ControlHintTooltip
            title={readOnlyReason ?? intl.formatMessage({ id: "taskList.newThread" })}
          >
            <div>
              <NewTaskButtonGroup
                onCreateTask={handleCreateTask}
                disabled={Boolean(readOnlyReason)}
              />
            </div>
          </ControlHintTooltip>
        </div>
      ) : null}

      {/* 任务列表 */}
      <div>
        <div className="space-y-1">
          {Boolean(inputLoading) && visibleSourceTasks.length === 0 ? (
            <TaskListLoadingHint />
          ) : visibleSourceTasks.length === 0 ? (
            showEmptyState ? (
              <div
                data-testid={TID_TASK_EMPTY}
                className="px-8.5 py-2 text-ui-base text-foreground-subtlest"
              >
                {intl.formatMessage({ id: "taskList.noTasks" })}
              </div>
            ) : null
          ) : (
            <ContextMenu
              onOpenChange={(open) => {
                if (!open) {
                  setContextMenuTaskId(null);
                }
              }}
            >
              <ContextMenuTrigger asChild>
                <ul className="space-y-0.5">{visibleSourceTasks.map(renderTaskItem)}</ul>
              </ContextMenuTrigger>
              {contextMenuTask ? (
                <TaskListItemContextMenuContent
                  workspacePath={workspacePath}
                  remoteSessionId={remoteSessionId}
                  task={contextMenuTask}
                  isPinned={pinnedTaskIdSet.has(contextMenuTask.taskId)}
                  isArchived={isArchived}
                  organizationActions={organizationActions}
                  intl={intl}
                  onTogglePinTask={handleTogglePinTask}
                  onStartRenameTask={handleStartRenameTask}
                  onArchiveTask={handleArchiveTask}
                  onMarkTaskAsUnread={handleMarkTaskAsUnread}
                  disableTaskActions={Boolean(readOnlyReason)}
                  disabledReason={readOnlyReason}
                />
              ) : null}
            </ContextMenu>
          )}
        </div>
        {hasMore && onShowMore ? (
          <div className="pl-8.5">
            <button
              type="button"
              data-task-list-show-more="true"
              className="rounded-sm bg-transparent p-0 text-ui-sm text-foreground-subtle outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
              onClick={onShowMore}
            >
              {intl.formatMessage({ id: "taskList.showMore" })}
            </button>
          </div>
        ) : null}
      </div>

      {showFooter ? (
        <div className="border-t border-outline/40 p-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openSettingsTab}
            data-testid={TID_TASK_SETTINGS_BUTTON}
            className="w-full justify-center"
          >
            <Settings2 className="h-3.5 w-3.5" />
            {intl.formatMessage({ id: "taskList.openSettings" })}
          </Button>
        </div>
      ) : null}
    </div>
  );
});

TaskList.displayName = "TaskList";
