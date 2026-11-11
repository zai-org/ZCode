interface TaskActionMenuItemProps {
  children: React.ReactNode;
  "data-testid"?: string;
  disabled?: boolean;
  onSelect?: () => void;
  title?: string;
}

interface TaskActionMenuSeparatorProps {
  key?: string;
}

export function TaskActionMenuContent({
  intl,
  isPinned,
  isArchived = false,
  fileManagerLabel,
  taskSessionFile,
  activeSessionId,
  taskNativeSessionLogFile,
  providerConfigFile,
  disableTaskActions = false,
  disableTaskTargetActions = false,
  disablePinTaskAction = false,
  disabledReason,
  archiveDisabledReason,
  hideMobileUnsupportedActions = false,
  Item,
  Separator,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  onRestartTask,
  restartPending = false,
  onOpenTaskFeedback,
  onOpenTaskPathInFileManager,
  onCopyWorkspacePath,
  onCopyTaskPath,
  onCopyTaskLogPath,
  onCopySessionId,
  onViewModelTrajectory,
  onOpenProviderConfig,
}: {
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  isPinned: boolean;
  isArchived?: boolean;
  fileManagerLabel: string;
  taskSessionFile: { loading: boolean; path: string | null; exists: boolean };
  activeSessionId?: string | null;
  taskNativeSessionLogFile: {
    loading: boolean;
    path: string | null;
    exists: boolean;
  };
  providerConfigFile: { loading: boolean; path: string | null; exists: boolean };
  disableTaskActions?: boolean;
  disableTaskTargetActions?: boolean;
  disablePinTaskAction?: boolean;
  disabledReason?: string;
  /** 归档专属的禁用原因（运行中任务）；其余操作不受影响。 */
  archiveDisabledReason?: string;
  hideMobileUnsupportedActions?: boolean;
  Item: React.ComponentType<TaskActionMenuItemProps>;
  Separator: React.ComponentType<TaskActionMenuSeparatorProps>;
  onTogglePinTask: () => void;
  onStartRenameTask: () => void;
  /** 不传则不展示归档项：Header 拿不到实时运行态，归档只在侧栏提供。 */
  onArchiveTask?: () => void;
  onMarkTaskAsUnread: () => void;
  onRestartTask?: () => void;
  restartPending?: boolean;
  onOpenTaskFeedback?: () => void;
  onOpenTaskPathInFileManager: () => void;
  onCopyWorkspacePath: () => void;
  onCopyTaskPath: () => void;
  onCopyTaskLogPath: () => void;
  onCopySessionId?: () => void;
  onViewModelTrajectory?: () => void;
  onOpenProviderConfig: () => void;
}) {
  const taskTargetActionsDisabled = disableTaskActions || disableTaskTargetActions;

  return (
    <>
      <Item
        disabled={taskTargetActionsDisabled || disablePinTaskAction}
        title={taskTargetActionsDisabled ? disabledReason : undefined}
        onSelect={() => {
          if (!taskTargetActionsDisabled && !disablePinTaskAction) {
            onTogglePinTask();
          }
        }}
      >
        {intl.formatMessage({ id: isPinned ? "taskList.unpin" : "taskList.pin" })}
      </Item>
      <Item
        disabled={taskTargetActionsDisabled}
        title={disabledReason}
        onSelect={() => {
          if (!taskTargetActionsDisabled) {
            onStartRenameTask();
          }
        }}
      >
        {intl.formatMessage({ id: "taskList.rename" })}
      </Item>
      {onArchiveTask ? (
        <Item
          disabled={taskTargetActionsDisabled || Boolean(archiveDisabledReason)}
          title={disabledReason ?? archiveDisabledReason}
          onSelect={() => {
            if (!taskTargetActionsDisabled && !archiveDisabledReason) {
              onArchiveTask();
            }
          }}
        >
          {intl.formatMessage({ id: isArchived ? "taskList.unarchive" : "taskList.archive" })}
        </Item>
      ) : null}
      <Item
        disabled={taskTargetActionsDisabled}
        title={disabledReason}
        onSelect={() => {
          if (!taskTargetActionsDisabled) {
            onMarkTaskAsUnread();
          }
        }}
      >
        {intl.formatMessage({ id: "taskList.markAsUnread" })}
      </Item>
      {onRestartTask ? (
        <Item
          data-testid="task-restart"
          disabled={taskTargetActionsDisabled || restartPending}
          onSelect={onRestartTask}
        >
          {intl.formatMessage({ id: restartPending ? "taskList.restarting" : "taskList.restart" })}
        </Item>
      ) : null}
      <Separator />
      {!hideMobileUnsupportedActions ? (
        <Item
          disabled={disableTaskActions}
          title={disableTaskActions ? disabledReason : undefined}
          onSelect={() => {
            if (!disableTaskActions) {
              onOpenTaskPathInFileManager();
            }
          }}
        >
          {fileManagerLabel}
        </Item>
      ) : null}
      <Item
        disabled={disableTaskActions}
        title={disableTaskActions ? disabledReason : undefined}
        onSelect={onCopyWorkspacePath}
      >
        {intl.formatMessage({ id: "appHeader.copyPath" })}
      </Item>
      <Item
        disabled={taskTargetActionsDisabled || taskSessionFile.loading || !taskSessionFile.path}
        title={taskTargetActionsDisabled ? disabledReason : undefined}
        onSelect={onCopyTaskPath}
      >
        {intl.formatMessage({ id: "appHeader.copyTaskPath" })}
      </Item>
      <Item
        disabled={
          taskTargetActionsDisabled ||
          taskNativeSessionLogFile.loading ||
          !taskNativeSessionLogFile.path
        }
        title={taskTargetActionsDisabled ? disabledReason : undefined}
        onSelect={onCopyTaskLogPath}
      >
        {/* Bugfix: ZCode Agent 的日志路径可能先按运行时约定得出，当前日期文件尚未落盘。
            复制动作只依赖路径字符串，不能把 exists=false 当成不可复制，否则菜单会表现成“不能点”。 */}
        {intl.formatMessage({ id: "appHeader.copyLogPath" })}
      </Item>
      {onCopySessionId ? (
        <Item
          disabled={taskTargetActionsDisabled || !activeSessionId}
          title={taskTargetActionsDisabled ? disabledReason : undefined}
          onSelect={onCopySessionId}
        >
          {intl.formatMessage({ id: "appHeader.copySessionId" })}
        </Item>
      ) : null}
      {!hideMobileUnsupportedActions ? (
        /* Bugfix: 手机远控运行在浏览器里，无法可靠打开桌面端 provider 配置文件。
           这里只在远控移动端隐藏入口，桌面端仍沿用“路径已知即可前往配置”的能力。 */
        <Item
          disabled={disableTaskActions || providerConfigFile.loading || !providerConfigFile.path}
          title={disableTaskActions ? disabledReason : undefined}
          onSelect={() => {
            if (!disableTaskActions) {
              onOpenProviderConfig();
            }
          }}
        >
          <span className="truncate">
            {intl.formatMessage({ id: "appHeader.goToProviderConfig" })}
          </span>
        </Item>
      ) : null}
      {onViewModelTrajectory ? (
        <>
          <Separator />
          {/* 调用轨迹查看：从 ~/.zcode/cli 的 model-io 还原该 task 的模型请求/响应/工具调用，
              在右侧边栏可视化。只依赖 taskId（即 sessionId），不依赖快照文件是否落盘。 */}
          <Item
            disabled={taskTargetActionsDisabled || !activeSessionId}
            title={taskTargetActionsDisabled ? disabledReason : undefined}
            onSelect={onViewModelTrajectory}
          >
            {intl.formatMessage({ id: "taskList.viewModelTrajectory" })}
          </Item>
        </>
      ) : null}
      {onOpenTaskFeedback ? (
        <>
          <Separator />
          <Item disabled={taskTargetActionsDisabled} onSelect={onOpenTaskFeedback}>
            {/* Bugfix: 任务菜单之前只有复制日志/路径，用户遇到任务问题时还要手动回到反馈中心。
                “反馈问题”不是任务管理动作，单独放在菜单底部更符合兜底求助入口的层级。 */}
            {intl.formatMessage({ id: "taskList.feedback" })}
          </Item>
        </>
      ) : null}
    </>
  );
}
