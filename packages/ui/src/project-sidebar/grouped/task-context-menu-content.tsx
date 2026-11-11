import { SidebarNativeTooltip } from "@/ControlHintTooltip.js";
import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu.js";
import { TaskGroupColorDot } from "@/project-sidebar/grouped/colors.js";
import type { TaskGroupMenuItem } from "@/project-sidebar/grouped/types.js";

export function GroupedTaskContextMenuContent({
  task,
  currentGroupId,
  groups,
  intl,
  fileManagerLabel,
  taskSessionFile,
  taskNativeSessionLogFile,
  providerConfigFile,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  onOpenTaskPathInFileManager,
  onCopyText,
  onOpenProviderConfig,
  onOpenTaskFeedback,
  disabledReason,
  archiveDisabledReason,
}: {
  task: ZCodeTaskMeta;
  currentGroupId?: string;
  groups: TaskGroupMenuItem[];
  intl: {
    formatMessage: (desc: { id: string }) => string;
  };
  fileManagerLabel: string;
  taskSessionFile: { loading: boolean; path: string | null };
  taskNativeSessionLogFile: { loading: boolean; path: string | null };
  providerConfigFile: { loading: boolean; path: string | null };
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  onOpenTaskPathInFileManager: () => void;
  onCopyText: (label: string, text: string | null) => void;
  onOpenProviderConfig: () => void;
  onOpenTaskFeedback: () => void;
  disabledReason?: string;
  /** 归档专属的禁用原因（运行中任务）；其余操作不受影响。 */
  archiveDisabledReason?: string;
}) {
  return (
    <ContextMenuContent className="w-56">
      <ContextMenuSub>
        <SidebarNativeTooltip>
          <ContextMenuSubTrigger
            data-testid="task-group-move-menu"
            disabled={Boolean(disabledReason)}
            title={disabledReason}
          >
            {intl.formatMessage({ id: "taskGroup.moveToGroup" })}
          </ContextMenuSubTrigger>
        </SidebarNativeTooltip>
        <ContextMenuSubContent className="w-52">
          <SidebarNativeTooltip>
            <ContextMenuItem
              data-testid="task-group-remove"
              disabled={Boolean(disabledReason) || !currentGroupId}
              title={disabledReason}
              onSelect={() => {
                if (!disabledReason) {
                  onMoveTaskToGroup(task, null);
                }
              }}
            >
              {intl.formatMessage({ id: "taskGroup.removeFromGroup" })}
            </ContextMenuItem>
          </SidebarNativeTooltip>
          <ContextMenuSeparator />
          {groups.map((group) => (
            <SidebarNativeTooltip key={group.id}>
              <ContextMenuItem
                data-task-group-target={group.id}
                disabled={Boolean(disabledReason) || group.id === currentGroupId}
                title={disabledReason}
                onSelect={() => {
                  if (!disabledReason) {
                    onMoveTaskToGroup(task, group.id);
                  }
                }}
              >
                <TaskGroupColorDot color={group.color} />
                <span className="truncate">{group.title}</span>
              </ContextMenuItem>
            </SidebarNativeTooltip>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <SidebarNativeTooltip>
        <ContextMenuItem
          disabled={Boolean(disabledReason)}
          title={disabledReason}
          onSelect={() => {
            if (!disabledReason) {
              onMoveTaskToTop(task);
            }
          }}
        >
          {intl.formatMessage({ id: "taskGroup.moveToTop" })}
        </ContextMenuItem>
      </SidebarNativeTooltip>
      <ContextMenuSeparator />
      <SidebarNativeTooltip>
        <ContextMenuItem
          disabled={Boolean(disabledReason)}
          title={disabledReason}
          onSelect={() => {
            if (!disabledReason) {
              onStartRenameTask(task);
            }
          }}
        >
          {intl.formatMessage({ id: "taskList.rename" })}
        </ContextMenuItem>
      </SidebarNativeTooltip>
      <SidebarNativeTooltip>
        <ContextMenuItem
          disabled={Boolean(disabledReason) || Boolean(archiveDisabledReason)}
          title={disabledReason ?? archiveDisabledReason}
          onSelect={() => {
            if (!disabledReason && !archiveDisabledReason) {
              onArchiveTask(task);
            }
          }}
        >
          {intl.formatMessage({ id: "taskList.archive" })}
        </ContextMenuItem>
      </SidebarNativeTooltip>
      <SidebarNativeTooltip>
        <ContextMenuItem
          disabled={Boolean(disabledReason)}
          title={disabledReason}
          onSelect={() => {
            if (!disabledReason) {
              onMarkTaskAsUnread(task);
            }
          }}
        >
          {intl.formatMessage({ id: "taskList.markAsUnread" })}
        </ContextMenuItem>
      </SidebarNativeTooltip>
      <ContextMenuSeparator />
      <SidebarNativeTooltip>
        <ContextMenuItem
          disabled={Boolean(disabledReason)}
          title={disabledReason}
          onSelect={() => {
            if (!disabledReason) {
              onOpenTaskPathInFileManager();
            }
          }}
        >
          {fileManagerLabel}
        </ContextMenuItem>
      </SidebarNativeTooltip>
      <ContextMenuItem
        onSelect={() =>
          onCopyText(intl.formatMessage({ id: "appHeader.copyPath" }), task.workspacePath)
        }
      >
        {intl.formatMessage({ id: "appHeader.copyPath" })}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={taskSessionFile.loading || !taskSessionFile.path}
        onSelect={() =>
          onCopyText(intl.formatMessage({ id: "appHeader.copyTaskPath" }), taskSessionFile.path)
        }
      >
        {intl.formatMessage({ id: "appHeader.copyTaskPath" })}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={taskNativeSessionLogFile.loading || !taskNativeSessionLogFile.path}
        onSelect={() =>
          onCopyText(
            intl.formatMessage({ id: "appHeader.copyLogPath" }),
            taskNativeSessionLogFile.path,
          )
        }
      >
        {intl.formatMessage({ id: "appHeader.copyLogPath" })}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() =>
          onCopyText(intl.formatMessage({ id: "appHeader.copySessionId" }), task.taskId)
        }
      >
        {intl.formatMessage({ id: "appHeader.copySessionId" })}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={providerConfigFile.loading || !providerConfigFile.path}
        onSelect={onOpenProviderConfig}
      >
        <span className="truncate">
          {intl.formatMessage({ id: "appHeader.goToProviderConfig" })}
        </span>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onOpenTaskFeedback}>
        {intl.formatMessage({ id: "taskList.feedback" })}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
