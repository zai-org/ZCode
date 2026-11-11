import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Cloud, Folder, FolderGit2, GitBranch } from "lucide-react";
import type { GitRepositorySummary, ZCodeTaskMeta } from "@zcode/shared";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { cn } from "@/components/lib/utils.js";
import { resolveGitBranchTriggerLabel } from "@/git-branch-switcher/display.js";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import { formatWorktreeLabel } from "@/managed-worktrees/index.js";
import { RemoteTaskDeviceLabel } from "@/remote-connection/RemoteTaskDeviceLabel.js";
import type { TaskRowIdentityHoverCardProps } from "@/task-row-hover/contract.js";
import { WorkspaceContextPath } from "@/WorkspaceHeaderSections/WorkspaceContextPath.js";
import { WorkspaceLastActivity } from "@/WorkspaceHeaderSections/WorkspaceLastActivity.js";
import { formatWorkspaceContextPath } from "@/WorkspaceHeaderSections/workspaceContextPathFormat.js";

const HOVER_OPEN_DELAY_MS = 300;
const CHANGE_PARTS_EMPTY: string[] = [];

type WorkspaceServiceAccessor = ReturnType<typeof useBaseWorkspaceServices>;

/**
 * 会话行悬停卡片：本地和远程任务都显示任务自己的目录、最近活动和 HEAD。
 *
 * 打开后才挂载内容，Git/远程 home 查询因此只在用户真实停留时发生；关闭即丢弃快照，
 * 不把行的悬停状态写进任务或 workspace store。
 */
export function TaskRowIdentityHoverCard({
  task,
  workspaceLabel,
  remoteSessionId,
  disabled = false,
  children,
}: TaskRowIdentityHoverCardProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const overDetails = useRef(false);

  const changeOpen = (next: boolean) => {
    clearTimeout(openTimer.current);
    setOpen(next);
  };
  const scheduleOpen = () => {
    // 菜单和行内的焦点/指针事件会连续触发；只保留一个打开任务，避免离开后旧定时器重新弹出。
    clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS);
  };
  const containsPointerTarget = (next: EventTarget | null) =>
    next instanceof Node &&
    Boolean(triggerRef.current?.contains(next) || detailsRef.current?.contains(next));
  const leave = (event: PointerEvent<HTMLElement>) => {
    event.preventDefault();
    if (containsPointerTarget(event.relatedTarget)) return;
    changeOpen(false);
  };
  useEffect(() => {
    // 会话被替换、禁用状态变化或行卸载时撤销旧浮层，不能把上一行的展示状态带到下一行。
    clearTimeout(openTimer.current);
    setOpen(false);
    overDetails.current = false;
    return () => clearTimeout(openTimer.current);
  }, [disabled, task.taskId, task.workspaceIdentity, task.workspacePath]);

  if (disabled) return children;

  return (
    <HoverCard open={open} onOpenChange={changeOpen}>
      <HoverCardTrigger
        asChild
        ref={triggerRef}
        onPointerEnter={(event) => {
          event.preventDefault();
          // 触屏点击也会合成 pointerenter；只允许鼠标/触控板进入时打开。
          if (event.pointerType !== "touch") scheduleOpen();
        }}
        onPointerLeave={leave}
        onFocus={(event) => {
          event.preventDefault();
          // 点击会话行也会聚焦；只有键盘焦点打开卡片，避免点击后留下浮层。
          if (event.target.matches(":focus-visible")) scheduleOpen();
        }}
        onBlur={(event) => {
          event.preventDefault();
          if (containsPointerTarget(event.relatedTarget)) return;
          // 点击卡片文字会让行失焦但没有新焦点；仍在卡片内时保留选择和复制。
          if (event.relatedTarget || !overDetails.current) changeOpen(false);
        }}
      >
        {children}
      </HoverCardTrigger>
      {open ? (
        <HoverCardContent
          ref={detailsRef}
          data-testid="task-row-details"
          role="tooltip"
          side="right"
          align="start"
          onPointerEnter={(event) => {
            event.preventDefault();
            overDetails.current = true;
            clearTimeout(openTimer.current);
          }}
          onPointerLeave={(event) => {
            overDetails.current = false;
            leave(event);
          }}
          onContextMenu={(event) => {
            // Portal 只改变 DOM 位置，React 合成事件仍会冒泡到 TaskList 外层的
            // ContextMenuTrigger；不拦截会让 Radix 吞掉原生右键菜单，卡片内无法复制路径。
            event.stopPropagation();
          }}
          // 窄屏和长路径不能撑破浮层：按 Radix 可用宽度收缩，内部滚动。
          className={cn(
            "w-80 max-w-(--radix-hover-card-content-available-width) rounded-xl p-0 text-ui-sm",
            "before:absolute before:inset-y-0 before:w-1 data-[side=right]:before:-left-1",
          )}
        >
          <TaskRowIdentityDetails
            task={task}
            workspaceLabel={workspaceLabel}
            remoteSessionId={remoteSessionId}
          />
        </HoverCardContent>
      ) : null}
    </HoverCard>
  );
}

/**
 * 本地任务和远程任务使用不同的服务来源：本地任务必须固定到 base services，
 * 不能因为同路径的远程标签页处于活动状态而继承 remote session。
 */
function TaskRowIdentityDetails({
  task,
  workspaceLabel,
  remoteSessionId,
}: {
  task: ZCodeTaskMeta;
  workspaceLabel: string;
  remoteSessionId?: string;
}) {
  return task.workspaceIdentity?.trim() ? (
    <RemoteTaskRowIdentityDetails
      task={task}
      workspaceLabel={workspaceLabel}
      remoteSessionId={remoteSessionId}
    />
  ) : (
    <LocalTaskRowIdentityDetails task={task} workspaceLabel={workspaceLabel} />
  );
}

function LocalTaskRowIdentityDetails({
  task,
  workspaceLabel,
}: {
  task: ZCodeTaskMeta;
  workspaceLabel: string;
}) {
  const services = useBaseWorkspaceServices();
  const branchLabel = useGitBranchLabel(task, services, true);
  const taskCwd = task.cwd ?? task.workspacePath;
  return (
    <TaskRowIdentityDetailsBody
      task={task}
      workspaceLabel={workspaceLabel}
      isRemote={false}
      pathNode={<LocalWorkspaceContextPath path={taskCwd} services={services} />}
      branchLabel={branchLabel}
    />
  );
}

function RemoteTaskRowIdentityDetails({
  task,
  workspaceLabel,
  remoteSessionId,
}: {
  task: ZCodeTaskMeta;
  workspaceLabel: string;
  remoteSessionId?: string;
}) {
  const { services, rpcReady } = useWorkspaceServicesResolution(
    task.workspacePath,
    remoteSessionId,
    task.workspaceIdentity,
  );
  const branchLabel = useGitBranchLabel(task, services, rpcReady);
  const taskCwd = task.cwd ?? task.workspacePath;
  return (
    <TaskRowIdentityDetailsBody
      task={task}
      workspaceLabel={workspaceLabel}
      isRemote
      pathNode={
        rpcReady ? (
          <WorkspaceContextPath
            // worktree 任务显示自己的 cwd，不使用项目主目录。
            workspacePath={taskCwd}
            workspaceIdentity={task.workspaceIdentity}
            remoteSessionId={remoteSessionId}
          />
        ) : (
          // 断连时不做 home 缩写，避免向断连代理发 system.info。
          <RawWorkspaceContextPath path={taskCwd} />
        )
      }
      branchLabel={branchLabel}
    />
  );
}

function TaskRowIdentityDetailsBody({
  task,
  workspaceLabel,
  isRemote,
  pathNode,
  branchLabel,
}: {
  task: ZCodeTaskMeta;
  workspaceLabel: string;
  isRemote: boolean;
  pathNode: ReactNode;
  branchLabel: string | null;
}) {
  const { intl } = useZCodeIntl();
  const changeSummary = getTaskChangeSummary(task);
  const changeParts = changeSummary ? formatChangeParts(changeSummary) : CHANGE_PARTS_EMPTY;
  return (
    <div className="@container/task-row-details max-h-(--radix-hover-card-content-available-height) overflow-y-auto p-3">
      <div className="flex min-w-0 items-start gap-2">
        <TaskRowIdentityIcon task={task} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">
            {formatWorktreeLabel(intl, task.worktreeRoot) ?? workspaceLabel}
          </span>
          {isRemote ? <RemoteTaskDeviceLabel task={task} /> : null}
          {pathNode}
        </span>
      </div>
      <div className="mt-3 flex min-w-0 flex-col gap-3">
        <WorkspaceLastActivity task={task} />
        {branchLabel ? (
          <span
            data-task-row-branch="true"
            className="flex min-w-0 items-center gap-2 border-t border-border/50 pt-3"
          >
            <GitBranch aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">{branchLabel}</span>
          </span>
        ) : null}
        {changeParts.length > 0 ? (
          <span className="flex min-w-0 items-center gap-1 border-t border-border/50 pt-3">
            {changeParts.map((part) => (
              <span
                key={part}
                className={part.startsWith("+") ? "text-diff-added" : "text-diff-removed"}
              >
                {part}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** 本地路径显式使用 base services 的 home，不经过按活动标签页推断的 workspace 服务。 */
function LocalWorkspaceContextPath({
  path,
  services,
}: {
  path: string;
  services: WorkspaceServiceAccessor;
}) {
  const [home, setHome] = useState<string | undefined>(undefined);
  useEffect(() => {
    let disposed = false;
    void services.systemService.info().then(
      (info) => {
        if (!disposed) setHome(info.homedir);
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [services]);
  return <RawWorkspaceContextPath path={formatWorkspaceContextPath(path, home)} />;
}

function RawWorkspaceContextPath({ path }: { path: string }) {
  return (
    <span
      data-workspace-context-path=""
      className="min-w-0 break-words text-ui-sm font-normal text-foreground-subtle [overflow-wrap:anywhere]"
    >
      {path}
    </span>
  );
}

function useGitBranchLabel(
  task: ZCodeTaskMeta,
  services: WorkspaceServiceAccessor,
  enabled: boolean,
): string | null {
  const { intl } = useZCodeIntl();
  const [summary, setSummary] = useState<GitRepositorySummary | null>(null);
  const gitWorkspacePath = task.cwd ?? task.workspacePath;
  useEffect(() => {
    setSummary(null);
    // 远程未连接时不查询 Git，也不主动建立连接；卡片保留已知的标签、路径和活动时间。
    if (!enabled) return;
    let disposed = false;
    void services.gitService.getRepositorySummary({ workspacePath: gitWorkspacePath }).then(
      (next) => {
        if (!disposed) setSummary(next);
      },
      () => {
        // Git 不可用、目录已删除或远程断开都走空态；悬停提示不能把只读查询失败放大成报错。
      },
    );
    return () => {
      disposed = true;
    };
  }, [enabled, gitWorkspacePath, services]);

  if (!summary?.isGitAvailable || !summary.isRepository) return null;
  return resolveGitBranchTriggerLabel({
    headRefType: summary.headRefType,
    currentBranchName: summary.branchName,
    detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
    fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
  });
}

function TaskRowIdentityIcon({ task }: { task: ZCodeTaskMeta }) {
  if (task.workspaceIdentity?.trim()) {
    return <Cloud aria-hidden="true" className="mt-0.5 size-4 shrink-0" />;
  }
  if (task.worktreeRoot) {
    return <FolderGit2 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />;
  }
  return <Folder aria-hidden="true" className="mt-0.5 size-4 shrink-0" />;
}

function formatChangeParts(summary: ReturnType<typeof getTaskChangeSummary>): string[] {
  if (!summary) return CHANGE_PARTS_EMPTY;
  const parts: string[] = [];
  if (summary.added > 0) parts.push(`+${summary.added}`);
  if (summary.removed > 0) parts.push(`-${summary.removed}`);
  return parts;
}
