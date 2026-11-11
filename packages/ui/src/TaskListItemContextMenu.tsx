import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu.js";
import { TaskActionMenuContent } from "@/TaskActionMenuContent.js";

export function TaskListItemContextMenu({
  organizationActions,
  intl,
  isPinned,
  isArchived = false,
  fileManagerLabel,
  taskSessionFile,
  activeSessionId,
  taskNativeSessionLogFile,
  providerConfigFile,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  onOpenTaskFeedback,
  onOpenTaskPathInFileManager,
  onCopyWorkspacePath,
  onCopyTaskPath,
  onCopyTaskLogPath,
  onCopySessionId,
  onViewModelTrajectory,
  onOpenProviderConfig,
  disableTaskActions = false,
  disabledReason,
  archiveDisabledReason,
}: {
  organizationActions?: React.ReactNode;
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
  onTogglePinTask: () => void;
  onStartRenameTask: () => void;
  onArchiveTask: () => void;
  onMarkTaskAsUnread: () => void;
  onOpenTaskFeedback: () => void;
  onOpenTaskPathInFileManager: () => void;
  onCopyWorkspacePath: () => void;
  onCopyTaskPath: () => void;
  onCopyTaskLogPath: () => void;
  onCopySessionId?: () => void;
  onViewModelTrajectory?: () => void;
  onOpenProviderConfig: () => void;
  disableTaskActions?: boolean;
  disabledReason?: string;
  archiveDisabledReason?: string;
}) {
  return (
    <ContextMenuContent className="w-52">
      {organizationActions}
      <TaskActionMenuContent
        intl={intl}
        isPinned={isPinned}
        isArchived={isArchived}
        fileManagerLabel={fileManagerLabel}
        taskSessionFile={taskSessionFile}
        activeSessionId={activeSessionId}
        taskNativeSessionLogFile={taskNativeSessionLogFile}
        providerConfigFile={providerConfigFile}
        Item={ContextMenuItem}
        Separator={ContextMenuSeparator}
        onTogglePinTask={onTogglePinTask}
        onStartRenameTask={onStartRenameTask}
        onArchiveTask={onArchiveTask}
        onMarkTaskAsUnread={onMarkTaskAsUnread}
        onOpenTaskFeedback={onOpenTaskFeedback}
        onOpenTaskPathInFileManager={onOpenTaskPathInFileManager}
        onCopyWorkspacePath={onCopyWorkspacePath}
        onCopyTaskPath={onCopyTaskPath}
        onCopyTaskLogPath={onCopyTaskLogPath}
        onCopySessionId={onCopySessionId}
        onViewModelTrajectory={onViewModelTrajectory}
        onOpenProviderConfig={onOpenProviderConfig}
        disableTaskActions={disableTaskActions}
        disabledReason={disabledReason}
        archiveDisabledReason={archiveDisabledReason}
      />
    </ContextMenuContent>
  );
}
