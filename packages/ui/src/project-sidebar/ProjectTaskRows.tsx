import { Fragment, memo, useCallback, useContext, useMemo, useState } from "react";
import type { ProjectTask, ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { TaskGroupTaskMenu } from "@/project-sidebar/TaskGroupTaskMenu.js";
import { TaskList } from "@/TaskList.js";
import { Button } from "@/components/ui/button.js";
import { useProjectTaskActions } from "@/project-sidebar/useProjectTaskActions.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { compareProjectTaskRows } from "@/project-sidebar/view.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { timelineDateHeadings } from "@/project-sidebar/timelineDates.js";

const EMPTY: ProjectTask[] = [];
export const ProjectTaskRow = memo(function Row({
  task,
  onSelect,
  refresh,
  variant,
  showFiles,
  renameOnDoubleClick = true,
}: {
  task: ProjectTask;
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
  variant: "default" | "timeline";
  showFiles: boolean;
  renameOnDoubleClick?: boolean;
}) {
  const presentation = useContext(ProjectTaskListContext);
  const { remoteSessionId, rename, pin, archive, unread } = useProjectTaskActions(task, refresh);
  const workspaceKey = task.workspaceIdentity?.trim() || task.workspacePath;
  // 原因：每行订阅完整 activeTaskId 会让同工作区所有行随选择更新；只订阅自身选中态。
  const isActive = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.activeTaskId === task.taskId,
  );
  const rows = useMemo(() => [task], [task]);
  const select = useCallback(
    () =>
      onSelect(task.workspacePath, task.taskId, task.workspaceIdentity, undefined, task.unreadAt),
    [onSelect, task],
  );
  const openFiles = useCallback(
    () => presentation.onOpenTaskFiles?.(task, remoteSessionId ?? undefined),
    [presentation.onOpenTaskFiles, task, remoteSessionId],
  );
  // 原因：内联 JSX 每次都会创建新引用，导致 TaskList 的 memo 比较失效。
  const organizationActions = useMemo(() => <TaskGroupTaskMenu task={task} />, [task]);
  // 项目身份详情只由项目入口承载；会话行使用任务卡，不复用项目详情。
  return (
    // 每行独立渲染 TaskList，外层留白避免选中和悬停背景粘连。
    <div className="py-px">
      <TaskList
        organizationActions={organizationActions}
        workspacePath={task.workspacePath}
        workspaceIdentity={task.workspaceIdentity}
        remoteSessionId={remoteSessionId ?? undefined}
        // pinnedTasks 只负责标识样式；TaskList 的真实渲染集合始终是 tasks。
        tasks={rows}
        pinnedTasks={task.pinned ? rows : EMPTY}
        activeTaskId={isActive ? task.taskId : null}
        isWorkspaceActive={presentation.activeWorkspaceKey === workspaceKey}
        mobileActiveTaskKey={presentation.mobileActiveTaskKey}
        onOpenFileTree={
          presentation.onOpenTaskFiles &&
          showFiles &&
          (!task.workspaceIdentity?.trim() || remoteSessionId)
            ? openFiles
            : undefined
        }
        showCreateButton={false}
        showFooter={false}
        showEmptyState={false}
        // 原因：旧接线只传排序，遗漏 timeline 样式，导致目录信息和空闲灰点消失。
        taskRowVariant={variant}
        hoverEnabled={!presentation.isWebRemoteControl}
        sortBy="updated"
        onSelectTask={select}
        onRenameTask={rename}
        onSetTaskPinned={pin}
        onArchiveTask={archive}
        isArchived={task.archived}
        onSetTaskUnread={unread}
        renameOnDoubleClick={renameOnDoubleClick}
      />
    </div>
  );
});

export function ProjectTaskRows({
  tasks,
  onSelect,
  refresh,
  kind = "project",
  showEmptyState = true,
}: {
  showEmptyState?: boolean;
  kind?: "project" | "pinned" | "timeline" | "unread";
  tasks: ProjectTask[];
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
}) {
  const { intl, locale } = useZCodeIntl();
  const chronological = kind === "timeline" || kind === "unread";
  const pageSize = chronological ? 20 : 5;
  const [limit, setLimit] = useState(pageSize);
  const [showAll, setShowAll] = useState(false);
  const ordered = useMemo(
    () => [...tasks].sort((a, b) => compareProjectTaskRows(a, b, kind)),
    [tasks, kind],
  );
  const visible =
    kind === "pinned" ? (showAll ? ordered : ordered.slice(0, 20)) : ordered.slice(0, limit);
  const hasMore = kind === "pinned" ? ordered.length > 20 : ordered.length > limit;
  const headings = chronological
    ? timelineDateHeadings(
        visible.map((task) => task.updatedAt),
        Date.now(),
        locale,
      )
    : [];
  // 原因：逐行复用 TaskList 后，空数组不再挂载旧空态；列表 owner 统一展示一次。
  if (!tasks.length)
    return kind === "pinned" || !showEmptyState ? null : (
      <div
        className="px-8.5 py-2 text-ui-base text-foreground-subtlest"
        data-testid="project-no-tasks"
      >
        {intl.formatMessage({
          id: kind === "unread" ? "taskList.noUnreadTasks" : "taskList.noTasks",
        })}
      </div>
    );
  return (
    <div
      className={kind === "pinned" || chronological ? "px-2" : undefined}
      data-testid={
        kind === "pinned"
          ? "project-pinned-tasks"
          : chronological
            ? `project-${kind}-tasks`
            : undefined
      }
    >
      {kind === "pinned" ? (
        // 原因：重构遗漏了原置顶区的外层留白，并把分区标题降成了辅助字号。
        <h3 className="px-2.5 py-1 text-ui-base font-medium text-foreground-subtlest">
          {intl.formatMessage({ id: "taskList.pinnedSection" })}
        </h3>
      ) : null}
      {visible.map((task, index) => (
        // 日期标题与行共用完整任务 key；跨日期段更新不能重挂载正在操作的任务行。
        <Fragment
          key={JSON.stringify([
            task.hostId,
            task.workspaceIdentity?.trim() || task.workspacePath,
            task.taskId,
          ])}
        >
          {headings[index] ? (
            <h3
              data-timeline-date-heading={headings[index].key}
              className="px-2.5 pt-2 pb-1 text-ui-base font-medium text-foreground-subtle"
            >
              {intl.formatMessage({ id: headings[index].id }, headings[index].values)}
            </h3>
          ) : null}
          <ProjectTaskRow
            task={task}
            onSelect={onSelect}
            refresh={refresh}
            variant={chronological ? "timeline" : "default"}
            showFiles={kind === "pinned"}
            // 按未读第一击会清未读并移除该行，第二击没有目标；该视图保留右键重命名。
            renameOnDoubleClick={kind !== "unread"}
          />
        </Fragment>
      ))}
      {hasMore ? (
        <Button
          data-task-list-show-more="true"
          variant="ghost"
          size="sm"
          // 原因：分页入口误用辅助字号和次级颜色，与任务标题及空态不一致；仅交互时提亮。
          className="ml-8.5 h-auto p-0 text-ui-base text-foreground-subtlest hover:bg-transparent focus-visible:text-foreground"
          onClick={() =>
            kind === "pinned" ? setShowAll((value) => !value) : setLimit((n) => n + pageSize)
          }
        >
          {intl.formatMessage({
            id: kind === "pinned" && showAll ? "taskList.showLess" : "taskList.showMore",
          })}
        </Button>
      ) : null}
    </div>
  );
}
