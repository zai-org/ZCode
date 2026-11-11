import {
  WorkflowAgentFace,
  SubagentCollectionIcon,
} from "@/components/workflow-timeline/WorkflowAgentFace.js";
import { SUBAGENT_WORKFLOW_COLOR } from "@/lib/subagentColors.js";
import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";
/* oxlint-disable eslint(max-lines) -- 状态面板同时维护收起态摘要、展开态分区、菜单策略和宽度自适应，同文件能保证两种形态共享同一内容优先级。 */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  ActivityIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckBigIcon,
  CircleIcon,
  EllipsisIcon,
  FileDiffIcon,
  GoalIcon,
  ListChecksIcon,
  Maximize2Icon,
  Minimize2Icon,
  PauseIcon,
  PlayIcon,
  SquareIcon,
  SquareTerminalIcon,
  Workflow,
} from "lucide-react";
import {
  TID_CHAT_SUMMARY_PANEL,
  TID_V4_BACKGROUND_WORK_CANCEL,
  TID_V4_BACKGROUND_WORK_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeSessionRunningSubagent,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type {
  BackgroundWorkSummary,
  GoalState,
  PlanState,
  ToolCallRow,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { RUN_STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import { WorkflowRunRail } from "@/components/workflow-run-line/WorkflowRunRail.js";
import { foldWorkflowRunRail } from "@/lib/workflowRunLine.js";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { formatBackgroundTaskElapsedLabel } from "@/BackgroundTaskElapsedLabel.js";
import { GitActionMenu } from "@/GitActionMenu.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenSubagentDirectorySideTabRequest,
  OpenSubagentSideTabRequest,
  OpenWorkflowRunDirectorySideTabRequest,
} from "@/lib/workspaceSidePane.js";
import type { ChatViewSummaryPanelVariant } from "@/v4/legacyChatViewTypes.js";
import { resolveConversationStatusPanelVariant } from "@/v4/conversationLayout.js";
import {
  buildConversationStatusPanelModel,
  type ConversationStatusPanelRunningSubagent,
  type ConversationStatusPanelModel,
  type ConversationStatusPanelSessionPlanItem,
  type ConversationStatusPanelWorkflowRun,
} from "@/v4/conversationStatusPanelModel.js";
import type { ConversationStatusPanelWorkflowRunTarget } from "@/v4/conversationStatusPanelModel.js";
import {
  workflowRunOpenTarget,
  workflowRunWords,
  type ConversationStatusPanelWorkflowRunWords,
} from "@/v4/conversationStatusPanelModel.js";
import {
  buildConversationGoalIterationSummaries,
  getConversationGoalElapsedSeconds,
} from "@/v4/conversationGoalSummaryModel.js";

export interface ConversationStatusPanelProps {
  workspacePath: string;
  /** Git 操作所在目录；worktree 任务是会话 cwd，缺省为 workspacePath（docs/git/worktree.md §3.7）。 */
  gitCwd?: string;
  workspaceIdentity?: string;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  goal?: GoalState | null;
  sessionPlans?: readonly ToolCallRow[];
  plan?: PlanState | null;
  backgroundWorks?: readonly BackgroundWorkSummary[];
  runningSubagents?: readonly ConversationStatusPanelRunningSubagent[];
  pendingSubagentStops?: ReadonlySet<string>;
  /**
   * runtime 不在线时为 true：终端、工作流、智能体三个分区的运行项都在 runtime 里执行，此时都没有
   * 执行者，计时停在断开前（停止 / 取消入口由宿主不下发回调来隐藏）。
   */
  timersPaused?: boolean;
  /** 本会话 `snapshot.workflowRuns.runs`；与 backgroundWorks 在模型层按 workId ≡ runId 联接。 */
  workflowRuns?: readonly WorkflowRunState[];
  /**
   * 已结束的 workflow run 条数（journal 口径，`countEndedWorkflowRuns`）。
   * 面板不自己算：它手上的投影是 memory-only 的活状态，重启后为空，而这条计数恰恰要在重启后
   * 仍然正确。
   */
  endedWorkflowRunCount?: number;
  endedSubagentCount?: number;
  rootSessionId?: string;
  parentSessionId?: string;
  /** 当前 pane 是否由手机 Web 远控壳承载。 */
  isWebRemoteControl?: boolean;
  /** 当前是否为粗指针手机视口。 */
  isMobileViewport?: boolean;
  layoutMode?: "none" | "auto" | "inline";
  summaryPanelVariantOverride?: ChatViewSummaryPanelVariant | null;
  onVariantChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
  terminalSectionOpen?: boolean;
  onTerminalSectionOpenChange?: (open: boolean) => void;
  agentSectionOpen?: boolean;
  onAgentSectionOpenChange?: (open: boolean) => void;
  workflowSectionOpen?: boolean;
  onWorkflowSectionOpenChange?: (open: boolean) => void;
  onRefreshGit?: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onPauseGoal?: () => void;
  onResumeGoal?: () => void;
  onOpenPlanDetail?: (request: OpenPlanDetailSideTabRequest) => void;
  onOpenBackgroundBash?: (work: BackgroundWorkSummary) => void;
  onCancelBackgroundWork?: (workId: string) => void;
  onStopSubagent?: (control: { taskId: string; executionId: string }) => void;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenSubagentDirectorySideTabRequest) => void;
  onOpenWorkflowRun?: (target: ConversationStatusPanelWorkflowRunTarget) => void;
  onOpenWorkflowRunDirectory?: (request: OpenWorkflowRunDirectorySideTabRequest) => void;
  className?: string;
}

// memo 组件默认 props 不内联创建数组，避免每次渲染生成新引用触发稳定引用边界测试。
const EMPTY_BACKGROUND_WORKS: readonly BackgroundWorkSummary[] = [];
const EMPTY_RUNNING_SUBAGENTS: readonly ConversationStatusPanelRunningSubagent[] = [];
const EMPTY_WORKFLOW_RUNS: readonly WorkflowRunState[] = [];

function formatDurationUnits(
  totalSeconds: number,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const restSeconds = seconds % 60;
  const hourUnit = formatMessage({ id: "chat.summaryPanel.duration.hours" });
  const minuteUnit = formatMessage({ id: "chat.summaryPanel.duration.minutes" });
  const secondUnit = formatMessage({ id: "chat.summaryPanel.duration.seconds" });
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}${hourUnit}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}${minuteUnit}`);
  }
  if (restSeconds > 0 || parts.length === 0) {
    parts.push(`${restSeconds}${secondUnit}`);
  }
  return parts.join(" ");
}

function getBackgroundWorkElapsedMs(work: BackgroundWorkSummary, now: number) {
  return Math.max(0, now - work.startedAt);
}

function getLongestRunningWorkElapsedMs(works: readonly BackgroundWorkSummary[], now: number) {
  return works.reduce(
    (longestElapsedMs, work) => Math.max(longestElapsedMs, getBackgroundWorkElapsedMs(work, now)),
    0,
  );
}

function formatRunningCount(
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
  count: number,
) {
  return formatMessage(
    {
      id:
        count === 1
          ? "chat.summaryPanel.runningBackgroundTasksMiniValue"
          : "chat.summaryPanel.runningBackgroundTasksMiniValuePlural",
    },
    { count: String(count) },
  );
}

function formatRunningSubagentCount(
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
  count: number,
) {
  return formatMessage(
    {
      // 这里的计数至少包含 running 投影中的 subagent（可能是 mixed 胶囊总数）；
      // subagent 又包含 foreground、background、blocked 和 waiting，复用后台任务文案
      // 会把计数语义错误地缩窄成“后台”。
      id:
        count === 1
          ? "chat.statusPanel.runningAgentsValue"
          : "chat.statusPanel.runningAgentsValuePlural",
    },
    { count: String(count) },
  );
}

type StatusSectionKind =
  | "environment"
  | "goal"
  | "sessionPlans"
  | "plan"
  | "terminal"
  | "workflow"
  | "agent";

const STATUS_SECTION_SCROLL_POLICY = {
  environment: null,
  goal: "max-h-48",
  sessionPlans: "max-h-48",
  // 六个双行 Todo（6 × 52px）需要约 20rem；超过后只滚动进程区块。
  plan: "max-h-80",
  terminal: "max-h-48",
  // workflow 行定高 56px，列表滚到三行半（196px）：露出的半行告诉人下面还有。
  workflow: "max-h-[12.25rem]",
  agent: "max-h-48",
} as const satisfies Record<StatusSectionKind, string | null>;

function StatusSectionHeader({
  children,
  isOpen,
  section,
  title,
}: {
  children?: ReactNode;
  isOpen: boolean;
  section: StatusSectionKind;
  title: string;
}) {
  return (
    <div className="mb-0.5 flex h-8 min-w-0 shrink-0 items-center gap-1.5 px-2 pr-8">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-expanded={isOpen}
          data-status-section-trigger={section}
          className="group flex min-w-0 shrink-0 items-center gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
        >
          <span className="shrink-0 text-ui-base text-[var(--color-foreground-subtle)]">
            {title}
          </span>
          {isOpen ? (
            <ChevronDownIcon className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          )}
        </button>
      </CollapsibleTrigger>
      {children ? (
        <div className="inline-flex min-w-0 max-w-full shrink items-center gap-1.5 text-ui-sm text-[var(--color-foreground-subtlest)]">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function StatusSection({
  children,
  defaultOpen = true,
  footer,
  onOpenChange,
  open,
  separated = false,
  section,
  title,
  trailing,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  /** 固定在滚动视口之外的页脚（如已结束目录入口）：列表再长也滚不走它。 */
  footer?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  separated?: boolean;
  section: StatusSectionKind;
  title: string;
  trailing?: (isOpen: boolean) => ReactNode;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = open ?? uncontrolledOpen;
  // 限高过去依赖每个调用方显式传 scrollable，组合区块或新增类型时容易
  // 旁路滚动视口。改为按完整区块类型表统一裁决，让计划等新类型漏配时直接触发类型检查。
  const scrollViewportMaxHeightClass = STATUS_SECTION_SCROLL_POLICY[section];
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [isControlled, onOpenChange],
  );

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={handleOpenChange}
      data-status-section={section}
      className={cn("min-w-0 flex-none", separated && "border-t border-[var(--color-border)] pt-2")}
    >
      <section className="min-w-0 flex-none">
        <StatusSectionHeader isOpen={isOpen} section={section} title={title}>
          {trailing?.(isOpen)}
        </StatusSectionHeader>
        <CollapsibleContent>
          {scrollViewportMaxHeightClass ? (
            // 长 Goal / 计划 / Todo / 终端 / 智能体列表过去保持自然高度，外层 shell
            // 只能把超出 max-height 的内容裁掉。滚动边界必须放在折叠动画内容层内部，
            // 既固定区块标题和控制，也不破坏 CollapsibleContent 的高度动画。
            <div
              data-status-section-scroll={section}
              className={cn(
                scrollViewportMaxHeightClass,
                "min-h-0 overflow-x-hidden overflow-y-auto pr-1",
              )}
            >
              {children}
            </div>
          ) : (
            children
          )}
          {footer}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function GitStatusSection({
  activeTaskChangeSummary,
  gitSummary,
  gitWorktreeReviewSourceId,
  model,
  onOpenGitReview,
  onRefreshGit,
  separated,
  workspaceIdentity,
  workspacePath,
  useVerticalFloatingPanels,
}: {
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  gitSummary: GitRepositorySummary | null | undefined;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  model: ConversationStatusPanelModel;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onRefreshGit?: () => void;
  separated: boolean;
  workspaceIdentity?: string;
  workspacePath: string;
  useVerticalFloatingPanels: boolean;
}) {
  const { intl } = useZCodeIntl();
  const git = model.git;
  if (!git || !gitSummary || !onRefreshGit) {
    return null;
  }
  const hasChanges = git.added + git.removed > 0;
  const canOpenReview = Boolean(onOpenGitReview && gitSummary.isRepository);

  return (
    <StatusSection
      section="environment"
      separated={separated}
      title={intl.formatMessage({ id: "chat.statusPanel.environment" })}
      trailing={(isOpen) =>
        isOpen ? null : (
          <span className="shrink-0 font-mono text-ui-sm tabular-nums">
            <span className={cn("text-[var(--color-diff-added)]", !hasChanges && "opacity-50")}>
              +{git.added}
            </span>{" "}
            <span className={cn("text-[var(--color-diff-removed)]", !hasChanges && "opacity-50")}>
              -{git.removed}
            </span>
          </span>
        )
      }
    >
      <div className="space-y-0">
        {/* Bug 原因：V4 状态面板迁移时只保留了 Changes 的静态展示，
            没有继续透传旧版 Git review 回调，导致规范中的审阅入口不可点击。 */}
        <button
          type="button"
          disabled={!canOpenReview}
          className={cn(
            "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui-base text-[var(--color-foreground)] transition-colors",
            canOpenReview
              ? "hover:bg-[var(--color-hover)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
              : "cursor-default opacity-50",
          )}
          onClick={() => {
            onOpenGitReview?.(gitWorktreeReviewSourceId ?? undefined);
          }}
        >
          <FileDiffIcon className="size-4 shrink-0 text-[var(--color-foreground)]" />
          <span className="min-w-0 flex-1 truncate">
            {intl.formatMessage({ id: "chat.statusPanel.changes" })}
          </span>
          <span className="shrink-0 font-mono tabular-nums">
            <span className="text-[var(--color-diff-added)]">+{git.added}</span>{" "}
            <span className="text-[var(--color-diff-removed)]">-{git.removed}</span>
          </span>
        </button>
        <GitBranchSwitcher
          workspacePath={workspacePath}
          gitSummary={gitSummary}
          dirtyFileCount={git.dirtyFileCount}
          onRefreshGit={onRefreshGit}
          className="w-full px-0 pt-0"
          triggerClassName="flex h-8 w-full min-w-0 justify-start gap-2 rounded-lg px-2 text-left text-ui-base text-[var(--color-foreground)] hover:bg-[var(--color-hover)] hover:text-[var(--color-foreground)] [&>span]:max-w-[calc(100%-3.5rem)] [&_svg:first-child]:text-[var(--color-foreground)]"
          popoverClassName="w-72 max-w-[calc(100vw-2rem)]"
          branchListClassName="max-h-56"
          popoverSide={useVerticalFloatingPanels ? "bottom" : "left"}
          showFooterActions
        />
        <GitActionMenu
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          gitSummary={gitSummary}
          activeTaskChangeSummary={activeTaskChangeSummary ?? null}
          onRefreshGit={onRefreshGit}
          triggerLayout="status-row"
          className="w-full"
        />
      </div>
    </StatusSection>
  );
}

function GoalStatusSection({
  model,
  onPauseGoal,
  onResumeGoal,
  separated,
}: {
  model: ConversationStatusPanelModel;
  onPauseGoal?: () => void;
  onResumeGoal?: () => void;
  separated: boolean;
}) {
  const { intl } = useZCodeIntl();
  const goal = model.goal;
  const isPausable =
    goal?.status === "active" || goal?.status === "verifying" || goal?.status === "notSatisfied";
  const isPaused = goal?.status === "paused";
  const isDone = goal?.status === "verified";
  const iterationRows = useMemo(
    () => (goal ? buildConversationGoalIterationSummaries(goal) : []),
    [goal],
  );
  // 用时秒针只看「有没有在跑」这一个布尔。effect 不能以整个 goal 对象为依赖：
  // 每个 goal 事件都同步 setNow 并重建 interval——落在投影帧的同步提交里，给 React 的嵌套更新计数
  // 记一笔（与工作流卡 React #185 崩溃同形）。
  const now = useNowTicker(isPausable && goal?.activeRunStartedAtMs != null);

  if (!goal) return null;

  const elapsed = formatDurationUnits(
    getConversationGoalElapsedSeconds(goal, now),
    intl.formatMessage,
  );
  const control = isPausable ? (
    <ControlHintTooltip title={intl.formatMessage({ id: "chat.target.pause" })}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-6 shrink-0"
        data-goal-action="pause"
        disabled={!onPauseGoal}
        aria-label={intl.formatMessage({ id: "chat.target.pause" })}
        onClick={onPauseGoal}
      >
        <PauseIcon className="size-3.5" />
      </Button>
    </ControlHintTooltip>
  ) : isPaused ? (
    <ControlHintTooltip title={intl.formatMessage({ id: "chat.target.resume" })}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-6 shrink-0"
        data-goal-action="resume"
        disabled={!onResumeGoal}
        aria-label={intl.formatMessage({ id: "chat.target.resume" })}
        onClick={onResumeGoal}
      >
        <PlayIcon className="size-3.5" />
      </Button>
    </ControlHintTooltip>
  ) : isDone ? (
    <CircleCheckBigIcon
      aria-label={intl.formatMessage({ id: "chat.goalVerification.complete" })}
      className="size-4 shrink-0 text-[var(--color-success)]"
    />
  ) : null;

  return (
    <StatusSection
      section="goal"
      separated={separated}
      title={intl.formatMessage({ id: "chat.statusPanel.goal" })}
      trailing={() => (
        <>
          <span
            className="shrink-0 tabular-nums"
            data-goal-elapsed-seconds={getConversationGoalElapsedSeconds(goal, now)}
          >
            {elapsed}
          </span>
          {control ? <span className="shrink-0">·</span> : null}
          {control}
        </>
      )}
    >
      <div className="space-y-0">
        {iterationRows.map((row) => {
          const title =
            row.title ??
            intl.formatMessage(
              { id: "chat.summaryPanel.goalIterationValue" },
              { count: String(row.iteration) },
            );
          return (
            <div
              key={row.iteration}
              data-goal-iteration={row.iteration}
              data-goal-iteration-completed={row.completed}
              data-goal-verification-outcome={row.verificationOutcome ?? undefined}
              className="flex min-w-0 cursor-default items-start gap-2 rounded-lg px-2 py-2 hover:bg-[var(--color-hover)]"
              title={title}
            >
              {row.completed ? (
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-[var(--color-success)] text-ui-xs tabular-nums text-[var(--color-success)]">
                  {row.iteration}
                </span>
              ) : (
                <GoalIcon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
              )}
              <p className="line-clamp-3 min-w-0 flex-1 text-ui-base leading-4 text-[var(--color-foreground)]">
                {title}
              </p>
              {row.totalCount > 0 ? (
                <span className="shrink-0 text-ui-sm tabular-nums text-[var(--color-foreground-subtle)]">
                  {row.completedCount}/{row.totalCount}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </StatusSection>
  );
}

function PlanStatusIcon({ status }: { status: PlanState["items"][number]["status"] }) {
  if (status === "completed") {
    return (
      <CheckCircle2Icon
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-[var(--color-success)]"
      />
    );
  }
  if (status === "inProgress") {
    return (
      <ArrowRightIcon
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-[var(--color-foreground)]"
      />
    );
  }
  return (
    <CircleIcon
      aria-hidden
      className="mt-0.5 size-3.5 shrink-0 text-[var(--color-foreground-subtlest)]"
    />
  );
}

const COMPACT_TODO_THRESHOLD = 6;
const TODO_FOCUS_WINDOW_SIZE = 3;

export interface StatusPanelTodoFocusWindow {
  compact: boolean;
  precedingItems: PlanState["items"];
  focusItems: PlanState["items"];
  followingItems: PlanState["items"];
}

export function getStatusPanelTodoFocusWindow(
  items: PlanState["items"],
): StatusPanelTodoFocusWindow {
  if (items.length <= COMPACT_TODO_THRESHOLD) {
    return {
      compact: false,
      precedingItems: [],
      focusItems: items,
      followingItems: [],
    };
  }

  const runningIndex = items.findIndex((item) => item.status === "inProgress");
  const firstUnfinishedIndex = items.findIndex((item) => item.status !== "completed");
  const focusIndex =
    runningIndex >= 0
      ? runningIndex
      : firstUnfinishedIndex >= 0
        ? firstUnfinishedIndex
        : Math.max(0, items.length - TODO_FOCUS_WINDOW_SIZE);
  // 只取“当前 + 后两条”会让靠近列表末尾的当前项只剩一两条上下文。
  // 从前面回补可以让精简窗口在项目数足够时始终保持三条，同时不改变 snapshot 原序。
  const focusStartIndex = Math.max(0, Math.min(focusIndex, items.length - TODO_FOCUS_WINDOW_SIZE));
  const focusEndIndex = Math.min(items.length, focusStartIndex + TODO_FOCUS_WINDOW_SIZE);

  return {
    compact: true,
    precedingItems: items.slice(0, focusStartIndex),
    focusItems: items.slice(focusStartIndex, focusEndIndex),
    followingItems: items.slice(focusEndIndex),
  };
}

function PlanStatusItemRows({ items }: { items: PlanState["items"] }) {
  return items.map((item) => (
    <li
      key={item.id}
      data-plan-status={item.status}
      className="flex min-h-8 items-start gap-2 rounded-lg px-2 py-1.5 text-ui-base hover:bg-[var(--color-hover)]"
    >
      <PlanStatusIcon status={item.status} />
      <span
        title={item.content}
        className={cn(
          "line-clamp-2 min-w-0 flex-1 break-words leading-5",
          item.status === "completed"
            ? "text-[var(--color-foreground-subtlest)] line-through"
            : "text-[var(--color-foreground)]",
        )}
      >
        {item.content}
      </span>
    </li>
  ));
}

const TodoPreviewTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & {
    group: "preceding" | "following";
    label: string;
    open: boolean;
    onTouchOpen: () => void;
  }
>(function TodoPreviewTrigger({ group, label, onClick, onTouchOpen, open, ...buttonProps }, ref) {
  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      aria-expanded={open}
      data-status-todo-preview-trigger={group}
      className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui-base text-[var(--color-foreground-subtle)] hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
      onClick={(event) => {
        onClick?.(event);
        // HoverCard 在桌面由 hover/focus 驱动；仅无 hover 输入补充点击打开，
        // 避免桌面点击把已经由 hover 打开的预览反向关闭。
        if (
          !event.defaultPrevented &&
          typeof window !== "undefined" &&
          window.matchMedia?.("(hover: none)").matches
        ) {
          onTouchOpen();
        }
      }}
    >
      <ChevronLeftIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
});

type TodoPreviewGroup = "preceding" | "following";

function TodoHiddenGroupPreview({
  group,
  items,
  onOpenChange,
  open,
  popoverSide,
}: {
  group: TodoPreviewGroup;
  items: PlanState["items"];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  popoverSide: "bottom" | "left";
}) {
  const { intl } = useZCodeIntl();
  const messageId =
    group === "preceding"
      ? items.every((item) => item.status === "completed")
        ? "chat.statusPanel.todoCompletedFold"
        : "chat.statusPanel.todoEarlierFold"
      : items.every((item) => item.status === "pending")
        ? "chat.statusPanel.todoWaitingFold"
        : "chat.statusPanel.todoLaterFold";
  const label = intl.formatMessage({ id: messageId }, { count: String(items.length) });

  return (
    <HoverCard closeDelay={80} open={open} openDelay={120} onOpenChange={onOpenChange}>
      <HoverCardTrigger asChild>
        <TodoPreviewTrigger
          group={group}
          label={label}
          open={open}
          onTouchOpen={() => onOpenChange(true)}
        />
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        side={popoverSide}
        sideOffset={4}
        data-status-todo-preview-content={group}
        className="w-80 max-w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-[var(--color-popover-border)] bg-[var(--color-menu)] p-3 shadow-md ring-0"
      >
        <div className="flex max-h-[min(24rem,calc(100dvh-2rem))] min-w-0 flex-col">
          <p className="flex h-8 shrink-0 items-center px-2 text-ui-base text-[var(--color-foreground-subtle)]">
            {label}
          </p>
          <ul className="min-h-0 space-y-0 overflow-y-auto pr-1">
            <PlanStatusItemRows items={items} />
          </ul>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function PlanStatusItems({
  plan,
  popoverSide,
}: {
  plan: NonNullable<ConversationStatusPanelModel["plan"]>;
  popoverSide: "bottom" | "left";
}) {
  const [openPreviewGroup, setOpenPreviewGroup] = useState<TodoPreviewGroup | null>(null);
  const window = getStatusPanelTodoFocusWindow(plan.displayItems);
  const handlePreviewOpenChange = (group: TodoPreviewGroup, open: boolean) => {
    setOpenPreviewGroup((current) => (open ? group : current === group ? null : current));
  };

  return (
    <ul className="space-y-0 pb-1">
      {window.compact && window.precedingItems.length > 0 ? (
        <li>
          <TodoHiddenGroupPreview
            group="preceding"
            items={window.precedingItems}
            open={openPreviewGroup === "preceding"}
            onOpenChange={(open) => handlePreviewOpenChange("preceding", open)}
            popoverSide={popoverSide}
          />
        </li>
      ) : null}
      <PlanStatusItemRows items={window.focusItems} />
      {window.compact && window.followingItems.length > 0 ? (
        <li>
          <TodoHiddenGroupPreview
            group="following"
            items={window.followingItems}
            open={openPreviewGroup === "following"}
            onOpenChange={(open) => handlePreviewOpenChange("following", open)}
            popoverSide={popoverSide}
          />
        </li>
      ) : null}
    </ul>
  );
}

function SessionPlansStatusSection({
  model,
  onOpenPlanDetail,
  parentSessionId,
  separated,
}: {
  model: ConversationStatusPanelModel;
  onOpenPlanDetail?: (request: OpenPlanDetailSideTabRequest) => void;
  parentSessionId?: string;
  separated: boolean;
}) {
  const { intl } = useZCodeIntl();
  const sessionPlans = model.sessionPlans;
  if (!sessionPlans) return null;

  return (
    <StatusSection
      section="sessionPlans"
      separated={separated}
      title={intl.formatMessage({ id: "chat.statusPanel.sessionPlans" })}
    >
      <ul className="space-y-0">
        {sessionPlans.items.map((item) => {
          const title = item.title ?? intl.formatMessage({ id: "chat.statusPanel.planFallback" });
          const canOpen = Boolean(parentSessionId && onOpenPlanDetail);
          return (
            <li key={item.toolCallId}>
              <button
                type="button"
                data-plan-directory-tool-call-id={item.toolCallId}
                disabled={!canOpen}
                aria-label={intl.formatMessage({ id: "chat.statusPanel.openPlan" }, { title })}
                onClick={() => {
                  if (!parentSessionId) return;
                  onOpenPlanDetail?.(buildSessionPlanOpenRequest(parentSessionId, item));
                }}
                className={cn(
                  "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-base text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]",
                  canOpen && "hover:bg-[var(--color-hover)]",
                )}
              >
                <ListChecksIcon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
                <span className="min-w-0 flex-1 truncate">{title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </StatusSection>
  );
}

export function buildSessionPlanOpenRequest(
  parentSessionId: string,
  item: ConversationStatusPanelSessionPlanItem,
): OpenPlanDetailSideTabRequest {
  return {
    parentSessionId,
    toolCallId: item.toolCallId,
    markdown: item.markdown,
    ...(item.planFilePath ? { planFilePath: item.planFilePath } : {}),
  };
}

function PlanStatusSection({
  model,
  popoverSide,
  separated,
}: {
  model: ConversationStatusPanelModel;
  popoverSide: "bottom" | "left";
  separated: boolean;
}) {
  const { intl } = useZCodeIntl();
  const plan = model.plan;
  if (!plan) return null;
  const isCompleted = plan.totalCount > 0 && plan.completedCount >= plan.totalCount;

  return (
    <StatusSection
      section="plan"
      separated={separated}
      title={intl.formatMessage({ id: "chat.statusPanel.todo" })}
      trailing={() => (
        <span
          className={cn(
            "tabular-nums",
            isCompleted ? "text-[var(--color-success)]" : "text-[var(--color-foreground-subtle)]",
          )}
        >
          {plan.completedCount}/{plan.totalCount}
        </span>
      )}
    >
      <PlanStatusItems
        key={plan.displayItems
          .map((item) => `${item.id}\u0000${item.content}\u0000${item.status}`)
          .join("\u0001")}
        plan={plan}
        popoverSide={popoverSide}
      />
    </StatusSection>
  );
}

function RunningWorkCancelButton({
  workId,
  onCancel,
}: {
  workId: string;
  onCancel?: (workId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onCancel?.(workId);
    },
    [onCancel, workId],
  );

  if (!onCancel) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid={testId(TID_V4_BACKGROUND_WORK_CANCEL, workId)}
      aria-label={intl.formatMessage({
        id: "chat.summaryPanel.stopRunningBackgroundTask",
      })}
      onClick={handleClick}
      className="pointer-events-auto relative z-[2] ml-auto h-6 shrink-0 px-1.5 text-ui-base text-[var(--color-foreground)]"
    >
      <SquareIcon aria-hidden className="size-3 fill-current" />
      {intl.formatMessage({ id: "chat.statusPanel.runningStop" })}
    </Button>
  );
}

export function buildRunningSubagentOpenRequest({
  parentSessionId,
  rootSessionId,
  subagent,
}: {
  parentSessionId?: string;
  rootSessionId?: string;
  subagent: ZCodeSessionRunningSubagent;
}): OpenSubagentSideTabRequest | null {
  if (!parentSessionId) return null;
  return {
    rootSessionId: rootSessionId ?? parentSessionId,
    parentSessionId,
    childSessionId: subagent.childSessionId,
    subagentType: subagent.subagentType,
    title: subagent.title,
  };
}

function RunningStatusItem({
  now,
  onOpenBackgroundBash,
  onCancelBackgroundWork,
  work,
}: {
  now: number;
  onOpenBackgroundBash?: (work: BackgroundWorkSummary) => void;
  onCancelBackgroundWork?: (workId: string) => void;
  work: BackgroundWorkSummary;
}) {
  const { intl } = useZCodeIntl();

  return (
    <li
      data-testid={testId(TID_V4_BACKGROUND_WORK_ITEM, work.workId)}
      data-background-task-kind={work.kind}
      data-work-id={work.workId}
      data-work-status={work.status}
      className="group relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 hover:bg-[var(--color-hover)]"
    >
      {onOpenBackgroundBash ? (
        <button
          type="button"
          className="absolute inset-0 rounded-lg focus-visible:outline-ring"
          aria-label={intl.formatMessage({ id: "bashOutput.open" }, { title: work.title })}
          data-testid="background-bash-open"
          onClick={() => onOpenBackgroundBash(work)}
        />
      ) : null}
      <SquareTerminalIcon className="pointer-events-none relative z-[1] mt-0.5 size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="line-clamp-2 text-ui-base leading-5 text-[var(--color-foreground)]">
          {work.title}
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-base">
          <span className="shrink-0 tabular-nums text-[var(--color-foreground-subtle)]">
            {formatBackgroundTaskElapsedLabel(
              getBackgroundWorkElapsedMs(work, now),
              intl.formatMessage,
            )}
          </span>
          {work.cancellable !== false ? (
            <RunningWorkCancelButton workId={work.workId} onCancel={onCancelBackgroundWork} />
          ) : null}
        </div>
      </div>
    </li>
  );
}

function BackgroundWorkStatusSection({
  onOpenBackgroundBash,
  onCancelBackgroundWork,
  onOpenChange,
  open,
  separated,
  section,
  timersPaused = false,
  title,
  works,
}: {
  onOpenBackgroundBash?: (work: BackgroundWorkSummary) => void;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  separated: boolean;
  section: "terminal" | "agent";
  timersPaused?: boolean;
  title: string;
  works: readonly BackgroundWorkSummary[];
}) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  const orderedRunningWorks = useMemo(
    () => [...works].sort((left, right) => left.startedAt - right.startedAt),
    [works],
  );

  useEffect(() => {
    if (works.length === 0 || timersPaused) {
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [works.length, timersPaused]);

  if (works.length === 0) return null;

  const collapsedElapsedLabel = formatDurationUnits(
    Math.max(1, Math.floor(getLongestRunningWorkElapsedMs(works, now) / 1000)),
    intl.formatMessage,
  );

  return (
    <StatusSection
      section={section}
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={title}
      trailing={(isOpen) =>
        isOpen ? (
          <span>
            {intl.formatMessage(
              {
                id:
                  works.length === 1
                    ? "chat.statusPanel.runningStatusValue"
                    : "chat.statusPanel.runningStatusValuePlural",
              },
              { count: String(works.length) },
            )}
          </span>
        ) : (
          <>
            <span className="min-w-0 truncate">{collapsedElapsedLabel}</span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{formatRunningCount(intl.formatMessage, works.length)}</span>
          </>
        )
      }
    >
      <ul className="space-y-0">
        {orderedRunningWorks.map((work) => (
          <RunningStatusItem
            key={work.workId}
            work={work}
            now={now}
            onOpenBackgroundBash={onOpenBackgroundBash}
            onCancelBackgroundWork={onCancelBackgroundWork}
          />
        ))}
      </ul>
    </StatusSection>
  );
}

/**
 * run 行的时长：沿用分区头部的时长单位（formatDurationUnits），但不带「已运行」前缀，且超过
 * 一小时去掉秒——一条跑了一小时的 run 上逐秒跳动的数字只是噪音（`1小时 2分` / `1h 2m`）。
 */
function formatWorkflowRunElapsed(
  elapsedMs: number,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return formatDurationUnits(seconds >= 3600 ? seconds - (seconds % 60) : seconds, formatMessage);
}

/** run 「此刻在做什么」的词，按 i18n 拼成一句（规则在模型层的 `workflowRunWords`）。 */
function formatWorkflowRunWords(
  words: ConversationStatusPanelWorkflowRunWords,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
) {
  switch (words.kind) {
    case "status":
      return formatMessage({ id: `chat.toolCall.workflow.run.status.${words.status}` });
    case "steps":
      return formatMessage(
        { id: "chat.toolCall.workflow.card.steps" },
        { done: String(words.done), total: String(words.total) },
      );
    case "phases":
      return words.text;
  }
}

/** 未命名的判定：`title ≡ runId`（见 `ConversationStatusPanelWorkflowRun.title`）。 */
function workflowRunDisplayName(run: ConversationStatusPanelWorkflowRun): string | null {
  return run.title && run.title !== run.runId ? run.title : null;
}

/** 单盏状态灯（pending 空心、running 脉冲），与卡片、侧栏同一套 `STATUS_DOT`。 */
function WorkflowRunLamp({ status }: { status: "pending" | "running" }) {
  return (
    <span
      aria-hidden="true"
      data-workflow-run-lamp={status}
      className={cn("size-1.5 shrink-0 rounded-full", RUN_STATUS_DOT[status])}
    />
  );
}

/**
 * run 行的 Stop（docs/dynamic-workflow/presentation.md「Other places a run appears」）：沿用今天的
 * 幽灵按钮（方块 + 「停止」），但**叠在时长上**——悬停或键盘焦点落进这一行时出现、时长淡出；
 * 平时不占位，整列行因此只剩名字和时长。没有悬停的触屏（`hover: none`）上常驻，换成第三列的 32px
 * 图标按钮。隐藏时同时关掉指针事件：一个看不见却点得中的 Stop 会在用户点时长时停掉 run。
 * 背景用不透明的 menu-hover：它与悬停中的行同色，盖住时长下面可能被截断的名字尾巴。
 */
function WorkflowRunStopButton({
  workId,
  onCancel,
}: {
  workId: string;
  onCancel: (workId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid={testId(TID_V4_BACKGROUND_WORK_CANCEL, workId)}
      aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.cancel" })}
      onClick={(event) => {
        event.stopPropagation();
        onCancel(workId);
      }}
      className={cn(
        "pointer-events-none absolute right-1.5 top-1.5 z-[2] h-6 gap-1 bg-menu-hover px-1.5 text-ui-sm text-foreground opacity-0 transition-opacity",
        "hover:bg-[image:linear-gradient(var(--color-hover),var(--color-hover))]",
        "group-hover/wf-run:pointer-events-auto group-hover/wf-run:opacity-100 group-focus-within/wf-run:pointer-events-auto group-focus-within/wf-run:opacity-100",
        "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:static [@media(hover:none)]:size-8 [@media(hover:none)]:bg-transparent [@media(hover:none)]:p-0 [@media(hover:none)]:text-foreground-subtle [@media(hover:none)]:opacity-100",
      )}
    >
      <SquareIcon aria-hidden className="size-2.5 fill-current [@media(hover:none)]:size-3" />
      <span className="[@media(hover:none)]:sr-only">
        {intl.formatMessage({ id: "chat.statusPanel.runningStop" })}
      </span>
    </Button>
  );
}

/**
 * 一条 run 两行定高（56px）：第一行 名字 + 时长，第二行 侧栏同款轨道 + 「在做什么」的词。
 * 字段三簇逐簇独立缺席（见 `ConversationStatusPanelWorkflowRun`）：
 * - 无 `status`：偏斜降级行（旧 CLI），只剩第一行——不知道状态就不画灯、不说词；
 * - 无 `startedAt`：没有配对的后台任务，没有时长；pending 也不报时长；
 * - 无 `workId` / 不可取消：没有 Stop，时长常驻。
 * 可见的状态词没了（灯和 phase 已经说了），所以它进打开按钮的无障碍名：名字 · 状态 · 词。
 */
function WorkflowRunRow({
  now,
  onCancelBackgroundWork,
  onOpenWorkflowRun,
  run,
}: {
  now: number;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenWorkflowRun?: (target: ConversationStatusPanelWorkflowRunTarget) => void;
  run: ConversationStatusPanelWorkflowRun;
}) {
  const { intl } = useZCodeIntl();
  // 行 → 打开意图的换算与 composer 徽标直达共用（模型层 workflowRunOpenTarget）。
  const openTarget = onOpenWorkflowRun ? workflowRunOpenTarget(run) : null;
  const name = workflowRunDisplayName(run);
  const displayName = name ?? intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const words = workflowRunWords(run);
  const wordsText = words ? formatWorkflowRunWords(words, intl.formatMessage) : null;
  const elapsed =
    run.startedAt === undefined || run.status === "pending"
      ? null
      : formatWorkflowRunElapsed(now - run.startedAt, intl.formatMessage);
  const canStop = Boolean(run.workId && run.cancellable !== false && onCancelBackgroundWork);
  const statusWord = run.status
    ? intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${run.status}` })
    : null;
  const openLabel = [
    intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" }),
    displayName,
    statusWord,
    wordsText === statusWord ? null : wordsText,
  ]
    .filter(Boolean)
    .join(" · ");
  const phases = run.phases ?? [];

  return (
    <li
      data-testid={run.workId ? testId(TID_V4_BACKGROUND_WORK_ITEM, run.workId) : undefined}
      data-background-task-kind="workflow"
      data-workflow-run-id={run.runId}
      data-work-id={run.workId}
      data-work-status={run.status}
      className={cn(
        "group/wf-run relative grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-2 rounded-lg p-2 hover:bg-[var(--color-hover)]",
        canStop && "[@media(hover:none)]:grid-cols-[1rem_minmax(0,1fr)_2rem]",
        openTarget && "cursor-pointer",
      )}
    >
      {openTarget ? (
        // 行里还有 Stop 这个嵌套交互，整行 button 会套出嵌套按钮：透明同级按钮承接「打开详情页」，
        // Stop 保持独立交互层并阻止冒泡（与 Agent 行同款）。
        <button
          type="button"
          data-workflow-run-details-trigger="true"
          data-workflow-run-id={run.runId}
          aria-label={openLabel}
          title={displayName}
          onClick={() => onOpenWorkflowRun?.(openTarget)}
          className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
        />
      ) : null}
      <Workflow className="pointer-events-none relative z-[1] mt-0.5 size-4 shrink-0 self-start text-[var(--color-foreground-subtle)]" />
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-col gap-0.5">
        <div
          data-workflow-island-line="name"
          className="flex h-5 min-w-0 items-baseline gap-2 leading-5"
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-ui-base",
              name ? "text-[var(--color-foreground)]" : "text-[var(--color-foreground-subtle)]",
            )}
          >
            {displayName}
          </span>
          {elapsed ? (
            <span
              data-workflow-run-elapsed="true"
              className={cn(
                "shrink-0 text-ui-sm tabular-nums text-[var(--color-foreground-subtle)] transition-opacity",
                canStop &&
                  "group-hover/wf-run:opacity-0 [@media(hover:hover)]:group-focus-within/wf-run:opacity-0",
                // 触屏：Stop 占了第三列，时长挪到第二行末尾（没有第二行时留在这里）。
                canStop && wordsText && "[@media(hover:none)]:hidden",
              )}
            >
              {elapsed}
            </span>
          ) : null}
        </div>
        {words && wordsText ? (
          <div
            data-workflow-island-line="phase"
            className="flex h-4.5 min-w-0 items-center gap-1.5 text-ui-sm text-[var(--color-foreground-subtle)]"
          >
            {words.kind === "phases" ? (
              <WorkflowRunRail rail={foldWorkflowRunRail(phases)} intl={intl} />
            ) : (
              <WorkflowRunLamp status={run.status === "pending" ? "pending" : "running"} />
            )}
            <span className="min-w-0 flex-1 truncate">{wordsText}</span>
            {elapsed && canStop ? (
              <span
                aria-hidden="true"
                className="hidden shrink-0 tabular-nums [@media(hover:none)]:inline"
              >
                {elapsed}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {canStop && run.workId && onCancelBackgroundWork ? (
        <WorkflowRunStopButton workId={run.workId} onCancel={onCancelBackgroundWork} />
      ) : null}
    </li>
  );
}

/**
 * Workflows 分区：与 Terminals / Agents 并列的第三类实时活动，**外加**一条通往 run 目录的
 * 页脚行——已结束的 run 折进这条页脚行，不占活动列表的位置。
 *
 * 头部右侧开合一个样：一盏运行灯 + 「{n} 个运行中」。折叠时不再换成「所有 run 里最长的时长」
 * ——那不是任何一条 run 的时间。只有 run 列表滚动（三行半，露出的半行告诉人下面还有）；
 * 已结束入口放在滚动区之外，run 再多也滚不走它。
 *
 * **不排序**：顺序 = 投影 runs 序 = 启动序（模型层已经保证）。Terminals / Agents 按
 * startedAt 排是因为它们的投影无序；这里重排反而会让行在每次投影更新时跳位。
 */
function WorkflowStatusSection({
  endedRunCount,
  onCancelBackgroundWork,
  onOpenChange,
  onOpenDirectory,
  onOpenWorkflowRun,
  open,
  parentSessionId,
  runs,
  separated,
  timersPaused = false,
  title,
}: {
  endedRunCount: number;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenChange?: (open: boolean) => void;
  onOpenDirectory?: (request: OpenWorkflowRunDirectorySideTabRequest) => void;
  onOpenWorkflowRun?: (target: ConversationStatusPanelWorkflowRunTarget) => void;
  open?: boolean;
  parentSessionId?: string;
  runs: readonly ConversationStatusPanelWorkflowRun[];
  separated: boolean;
  timersPaused?: boolean;
  title: string;
}) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  // 只有带 startedAt 的行需要秒级刷新；一行都没有时不必让面板每秒重渲染。
  const tickingRunCount = runs.filter((run) => run.startedAt !== undefined).length;
  useEffect(() => {
    if (tickingRunCount === 0 || timersPaused) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [tickingRunCount, timersPaused]);

  // 活动行与已结束计数**都**为零才收起整个分区：只按活动数开门的那一版，重启后一个 run
  // 都不在跑，于是入口连带目录页一起消失——而重启后回看被打断的 run 正是它的主要用途。
  if (runs.length === 0 && endedRunCount <= 0) return null;

  return (
    <StatusSection
      section="workflow"
      // 宿主不接管开合时同一条规则：有活 run 就默认打开（受控时由宿主按同一规则驱动）。
      defaultOpen={runs.length > 0}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={title}
      trailing={() =>
        runs.length > 0 ? (
          <>
            <WorkflowRunLamp status="running" />
            <span>
              {intl.formatMessage(
                { id: "chat.statusPanel.workflowsLive" },
                { count: String(runs.length) },
              )}
            </span>
          </>
        ) : null
      }
      // 已结束的 run 折进这条页脚行（与 Agents 分区共用同一个 affordance）：终态 run 不占
      // 活动列表的位置，但入口必须留着——被打断的那些正是最需要点进去的。
      footer={
        <EndedDirectoryRow
          count={endedRunCount}
          icon={
            <CheckCircle2Icon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
          }
          label={intl.formatMessage({ id: "chat.statusPanel.endedWorkflows" })}
          separated={runs.length > 0}
          testId="workflow-run-directory-trigger"
          onOpen={
            parentSessionId && onOpenDirectory
              ? () => onOpenDirectory({ parentSessionId })
              : undefined
          }
        />
      }
    >
      <ul className="space-y-0">
        {runs.map((run) => (
          <WorkflowRunRow
            key={run.runId}
            run={run}
            now={now}
            onCancelBackgroundWork={onCancelBackgroundWork}
            onOpenWorkflowRun={onOpenWorkflowRun}
          />
        ))}
      </ul>
    </StatusSection>
  );
}

function SubagentStatusSection({
  endedSubagentCount,
  timersPaused = false,
  onStopSubagent,
  pendingSubagentStops,
  onOpenChange,
  onOpenSubagentDirectory,
  onOpenSubagentSession,
  open,
  parentSessionId,
  rootSessionId,
  separated,
  title,
  subagents,
}: {
  endedSubagentCount: number;
  timersPaused?: boolean;
  onStopSubagent?: (control: { taskId: string; executionId: string }) => void;
  pendingSubagentStops?: ReadonlySet<string>;
  onOpenChange?: (open: boolean) => void;
  onOpenSubagentDirectory?: (request: OpenSubagentDirectorySideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
  open?: boolean;
  parentSessionId?: string;
  rootSessionId?: string;
  separated: boolean;
  title: string;
  subagents: readonly ConversationStatusPanelRunningSubagent[];
}) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  const presentation = useToolPresentationCapabilities();
  const ordered = useMemo(
    () => [...subagents].sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0)),
    [subagents],
  );
  useEffect(() => {
    if (subagents.length === 0 || timersPaused) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [subagents.length, timersPaused]);
  if (subagents.length === 0 && endedSubagentCount <= 0) return null;
  const longestElapsedMs = subagents.reduce(
    (longest, item) => Math.max(longest, Math.max(0, now - (item.startedAt ?? now))),
    0,
  );

  return (
    <StatusSection
      section="agent"
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={title}
      trailing={(isOpen) =>
        subagents.length === 0 ? null : isOpen ? (
          <span>{formatRunningSubagentCount(intl.formatMessage, subagents.length)}</span>
        ) : (
          <>
            <span className="min-w-0 truncate">
              {formatDurationUnits(
                Math.max(1, Math.floor(longestElapsedMs / 1000)),
                intl.formatMessage,
              )}
            </span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">
              {formatRunningSubagentCount(intl.formatMessage, subagents.length)}
            </span>
          </>
        )
      }
    >
      <ul className="space-y-0">
        {ordered.map((subagent) => {
          const configuredColor = presentation.agentColor?.(subagent.subagentType);
          const request = buildRunningSubagentOpenRequest({
            parentSessionId,
            rootSessionId,
            subagent,
          });
          const canOpenSubagentSession = Boolean(request && onOpenSubagentSession);
          const stopControl = subagent.stopControl;
          const pendingStopKey = stopControl
            ? JSON.stringify([stopControl.taskId, stopControl.executionId])
            : null;
          const stopPending = Boolean(pendingStopKey && pendingSubagentStops?.has(pendingStopKey));
          const canStopSubagent = Boolean(stopControl && onStopSubagent);
          return (
            <li
              key={subagent.childSessionId}
              data-testid="v4-running-subagent-item"
              data-background-task-kind="agent"
              data-child-session-id={subagent.childSessionId}
              data-subagent-task-id={stopControl?.taskId}
              data-subagent-execution-id={stopControl?.executionId}
              data-work-status="running"
              className={cn(
                "group relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 hover:bg-[var(--color-hover)]",
                canOpenSubagentSession && "cursor-pointer",
              )}
            >
              {canOpenSubagentSession ? (
                // Agent 行同时包含“打开详情”和 Stop，不能用整行 button 包住
                // Stop 形成嵌套按钮。透明同级按钮承接详情，Stop 保持独立交互层且阻止冒泡。
                <button
                  type="button"
                  data-running-subagent-session-trigger="true"
                  data-child-session-id={subagent.childSessionId}
                  aria-label={intl.formatMessage({
                    id: "chat.summaryPanel.openRunningSubagentSession",
                  })}
                  onClick={() => request && onOpenSubagentSession?.(request)}
                  className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
                />
              ) : null}
              {/* 与 Progress 共用 14px 图标列；覆盖头像最小尺寸，并按标题首行居中。 */}
              <span className="pointer-events-none relative z-[1] flex h-5 w-3.5 shrink-0 items-center justify-center">
                <WorkflowAgentFace
                  avatarIndex={undefined}
                  name={subagent.subagentType}
                  status="running"
                  color={configuredColor ? SUBAGENT_WORKFLOW_COLOR[configuredColor] : undefined}
                  className="size-3.5 min-h-3.5! min-w-3.5!"
                />
              </span>
              <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="line-clamp-2 text-ui-base leading-5 text-[var(--color-foreground)]">
                  {subagent.title}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-base">
                  <span className="text-ui-base tabular-nums text-[var(--color-foreground-subtle)]">
                    {formatBackgroundTaskElapsedLabel(
                      Math.max(0, now - (subagent.startedAt ?? now)),
                      intl.formatMessage,
                    )}
                  </span>
                  {canStopSubagent && stopControl ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="v4-running-subagent-stop"
                      data-subagent-task-id={stopControl.taskId}
                      data-subagent-execution-id={stopControl.executionId}
                      aria-label={intl.formatMessage({
                        id: "chat.summaryPanel.stopRunningSubagent",
                      })}
                      aria-busy={stopPending}
                      disabled={stopPending}
                      onClick={(event) => {
                        event.stopPropagation();
                        onStopSubagent?.(stopControl);
                      }}
                      className="pointer-events-auto relative z-[2] ml-auto h-6 shrink-0 px-1.5 text-ui-base text-[var(--color-foreground)]"
                    >
                      <SquareIcon aria-hidden className="size-3 fill-current" />
                      {intl.formatMessage({ id: "chat.statusPanel.runningStop" })}
                    </Button>
                  ) : null}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <EndedSubagentDirectoryRow
        count={endedSubagentCount}
        parentSessionId={parentSessionId}
        rootSessionId={rootSessionId}
        onOpen={onOpenSubagentDirectory}
        separated={subagents.length > 0}
      />
    </StatusSection>
  );
}

/**
 * 「已结束的 X · N ›」页脚行：分区里那条通往目录页的入口。
 *
 * Agents 与 Workflows **共用这一个** affordance（图标/文案/计数/回调由调用方给）。抽出来的
 * 理由不是省行数，而是不出现第二套画法：两个分区的页脚行若各写一遍，两者会随时间长出不同的
 * 间距、不同的 hover、不同的计数位置，而它们在读者眼里本来是同一个动作。
 *
 * `count <= 0` 或缺回调即整行缺席：一个点了没反应的入口比没有入口更糟。
 */
function EndedDirectoryRow({
  count,
  icon,
  label,
  onOpen,
  separated,
  testId,
}: {
  count: number;
  icon: ReactNode;
  label: string;
  onOpen?: () => void;
  separated: boolean;
  testId?: string;
}) {
  if (count <= 0 || !onOpen) return null;
  return (
    <div className={cn(separated && "border-t border-[var(--color-border)] pt-2")}>
      <button
        type="button"
        data-testid={testId}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-ui-base text-[var(--color-foreground)] hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
        onClick={onOpen}
      >
        {icon}
        <span>{label}</span>
        <span className="ml-auto text-[var(--color-foreground-subtle)]">{count}</span>
        <ChevronRightIcon className="size-4 text-[var(--color-foreground-subtle)]" />
      </button>
    </div>
  );
}

function EndedSubagentDirectoryRow({
  count,
  onOpen,
  parentSessionId,
  rootSessionId,
  separated,
}: {
  count: number;
  onOpen?: (request: OpenSubagentDirectorySideTabRequest) => void;
  parentSessionId?: string;
  rootSessionId?: string;
  separated: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <EndedDirectoryRow
      count={count}
      icon={<CheckCircle2Icon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" />}
      label={intl.formatMessage({ id: "chat.statusPanel.endedAgents" })}
      separated={separated}
      onOpen={
        parentSessionId && onOpen
          ? () =>
              onOpen({
                rootSessionId: rootSessionId ?? parentSessionId,
                parentSessionId,
              })
          : undefined
      }
    />
  );
}

function StatusSummaryMetric({ children, icon }: { children: ReactNode; icon: ReactNode }) {
  return (
    <div className="flex h-8 w-max max-w-full min-w-0 items-center gap-1.5 pl-2 pr-3 text-ui-base text-[var(--color-foreground)]">
      <span className="relative size-4 shrink-0">
        <span className="absolute inset-0 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
          {icon}
        </span>
        <Maximize2Icon className="absolute inset-0 size-4 text-[var(--color-foreground)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      </span>
      {children}
    </div>
  );
}

/**
 * 胶囊里的工作流摘要：Workflow 图标 · 名字 · 灯 · phase 词 · `+n`（其余在跑的 run）。
 * phase 词整段保留（至多占 45%），先截的是名字：名字看开头就认得出，截断的 phase 什么也说不了。降级行（旧 CLI，无状态）只有名字，不画灯——不知道状态就不猜。
 */
function WorkflowSummaryMetric({
  others,
  run,
}: {
  others: number;
  run: ConversationStatusPanelWorkflowRun;
}) {
  const { intl } = useZCodeIntl();
  const name = workflowRunDisplayName(run);
  const words = workflowRunWords(run);
  const wordsText = words ? formatWorkflowRunWords(words, intl.formatMessage) : null;
  return (
    <StatusSummaryMetric icon={<Workflow className="size-4 text-[var(--color-foreground)]" />}>
      <span
        data-workflow-pill={run.runId}
        className={cn(
          // 挤不下时只有名字让位：phase 不收缩，但封顶 45%，所以名字总还剩一半多。不给名字设
          // 最小宽度——定宽下限会把短名字撑出一段空白，还会和 phase 一起把胶囊撑破。
          "min-w-0 truncate",
          !name && "text-[var(--color-foreground-subtle)]",
        )}
      >
        {name ?? intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" })}
      </span>
      {run.status && wordsText ? (
        <>
          <WorkflowRunLamp status={run.status} />
          <span className="max-w-[45%] shrink-0 truncate text-[var(--color-foreground-subtle)]">
            {wordsText}
          </span>
        </>
      ) : null}
      {others > 0 ? (
        <span className="shrink-0 tabular-nums text-[var(--color-foreground-subtlest)]">
          +{others}
        </span>
      ) : null}
    </StatusSummaryMetric>
  );
}

function getCurrentPlanItem(plan: ConversationStatusPanelModel["plan"]) {
  return (
    plan?.items.find((item) => item.status === "inProgress") ??
    plan?.items.find((item) => item.status === "pending") ??
    null
  );
}

function getCompletedPlanItem(plan: ConversationStatusPanelModel["plan"]) {
  return [...(plan?.items ?? [])].reverse().find((item) => item.status === "completed") ?? null;
}

function StatusSummaryRow({
  endedWorkflowRunCount,
  gitWorktreeChangeSummary,
  model,
  onOpenWorkflowSection,
  onVariantChange,
}: {
  /** 已结束 run 的目录计数；宿主给 0 表示目录入口不可渲染（缺会话或缺回调）。 */
  endedWorkflowRunCount: number;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  model: ConversationStatusPanelModel;
  /** 胶囊显示着工作流时，点击展开要同时打开的「工作流」分区。 */
  onOpenWorkflowSection?: () => void;
  onVariantChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const expandLabel = intl.formatMessage({ id: "chat.summaryPanel.showPanel" });
  const currentPlanItem = getCurrentPlanItem(model.plan);
  const completedPlanItem = getCompletedPlanItem(model.plan);
  const latestSessionPlan = model.sessionPlans?.items[0] ?? null;
  const goal = model.goal;
  const goalTitle = goal ? goal.summaryTitle?.trim() || goal.objective.trim() || null : null;
  const goalStatus = goal?.status ?? null;
  // V4 goal 在 verifier 判定未完成后会进入 notSatisfied；mini 过去漏掉
  // 这个合法开放态并返回 null，导致只剩 2px 空 shell，也失去重新展开入口。
  const isActiveGoal =
    goalStatus === "active" ||
    goalStatus === "notSatisfied" ||
    goalStatus === "paused" ||
    goalStatus === "verifying";
  const isDoneGoal = goalStatus === "verified";
  const added = gitWorktreeChangeSummary?.added ?? 0;
  const removed = gitWorktreeChangeSummary?.removed ?? 0;
  const hasGitMiniSummary = Boolean(model.git && added + removed > 0);

  // 胶囊摘要过去把所有后台任务都写死成 Activity，纯 Subagent 因而没有复用
  // Running 明细的头像语义。**恰好一类**沿用该类图标，混合才是 Activity。在跑的工作流不进这条
  // 兜底：它排在胶囊最前，自己一个分支（名字 · 灯 · phase），不再是一个计数。
  const hasRunningBash = model.runningBashWorks.length > 0;
  const hasRunningSubagent = model.runningSubagentWorks.length > 0;
  const runningCount = model.runningBashWorks.length + model.runningSubagentWorks.length;
  const RunningSummaryIcon =
    hasRunningBash && hasRunningSubagent
      ? ActivityIcon
      : hasRunningBash
        ? SquareTerminalIcon
        : SubagentCollectionIcon;
  const firstLiveRun = model.runningWorkflowRuns[0];
  // 在跑的工作流排在胶囊最前（docs/dynamic-workflow/presentation.md「Other places a run appears」）：
  // 它在跑时就是会话在做的事，而主代理那一轮多半早已结束、todo 只是上一轮的余迹。过去它排在
  // 最后，理由是「与输入框的后台计数重复」——名字加 phase 并不重复什么。
  const summaryMetric = firstLiveRun ? (
    <WorkflowSummaryMetric run={firstLiveRun} others={model.runningWorkflowRuns.length - 1} />
  ) : currentPlanItem ? (
    <StatusSummaryMetric
      icon={<ArrowRightIcon className="size-4 text-[var(--color-foreground)]" />}
    >
      <span className="min-w-0 truncate">{currentPlanItem.content}</span>
    </StatusSummaryMetric>
  ) : goalTitle && isActiveGoal ? (
    <StatusSummaryMetric icon={<GoalIcon className="size-4 text-[var(--color-foreground)]" />}>
      <span className="min-w-0 truncate">{goalTitle}</span>
    </StatusSummaryMetric>
  ) : hasGitMiniSummary ? (
    <StatusSummaryMetric icon={<FileDiffIcon className="size-4 text-[var(--color-foreground)]" />}>
      <span className="min-w-0 truncate">
        {intl.formatMessage({ id: "chat.statusPanel.changes" })}
      </span>
      <span className="shrink-0 text-[var(--color-diff-added)]">+{added}</span>
      <span className="shrink-0 text-[var(--color-diff-removed)]">-{removed}</span>
    </StatusSummaryMetric>
  ) : goalTitle && isDoneGoal ? (
    <StatusSummaryMetric icon={<GoalIcon className="size-4 text-[var(--color-foreground)]" />}>
      <span className="min-w-0 truncate">{goalTitle}</span>
    </StatusSummaryMetric>
  ) : completedPlanItem ? (
    <StatusSummaryMetric icon={<CheckCircle2Icon className="size-4 text-[var(--color-success)]" />}>
      <span className="min-w-0 truncate">{completedPlanItem.content}</span>
    </StatusSummaryMetric>
  ) : model.plan ? (
    <StatusSummaryMetric
      icon={<ListChecksIcon className="size-4 text-[var(--color-foreground-subtle)]" />}
    >
      <span className="min-w-0 truncate">
        {intl.formatMessage({ id: "chat.statusPanel.todo" })}
      </span>
      <span className="shrink-0 text-[var(--color-foreground-subtle)]">
        {model.plan.completedCount}/{model.plan.totalCount}
      </span>
    </StatusSummaryMetric>
  ) : latestSessionPlan ? (
    <StatusSummaryMetric
      icon={<ListChecksIcon className="size-4 text-[var(--color-foreground)]" />}
    >
      <span className="min-w-0 truncate">
        {latestSessionPlan.title ?? intl.formatMessage({ id: "chat.statusPanel.planFallback" })}
      </span>
    </StatusSummaryMetric>
  ) : runningCount > 0 ? (
    <StatusSummaryMetric
      // 头像默认最小尺寸为 20px，会撑出 16px 图标槽；此处按胶囊图标尺寸覆盖，避免偏心和挤占文字间距。
      icon={
        <RunningSummaryIcon className="size-4 min-h-4! min-w-4! text-[var(--color-foreground)]" />
      }
    >
      {/* 产品规则：终端 / 智能体的实时计数只能在没有 Goal/Todo/Git 等主状态时兜底，
          避免胶囊把主状态和输入框已展示的实时计数重复拼接。 */}
      <span className="shrink-0">
        {hasRunningSubagent
          ? formatRunningSubagentCount(intl.formatMessage, runningCount)
          : formatRunningCount(intl.formatMessage, runningCount)}
      </span>
    </StatusSummaryMetric>
  ) : endedWorkflowRunCount > 0 ? (
    // 胶囊的兜底链止步于「活动计数」，而面板级的卸载闸门（!hasContent &&
    // !canRenderEndedWorkflows）为了保住 run 目录入口，会在**只剩已结束 run**时仍保留
    // 整个壳——工作区无 Git 变更时 workflow 一结束，胶囊各分支全 null，只剩一条 2px
    // 空壳线（与 goal notSatisfied 那次是同一个失效形状）。这里补上最低优先级的终态
    // 分支：图标沿用 Workflow 域，文案与 Workflows 分区页脚同 key，点开即展开面板。
    <StatusSummaryMetric
      icon={<Workflow className="size-4 text-[var(--color-foreground-subtle)]" />}
    >
      <span className="min-w-0 truncate">
        {intl.formatMessage({ id: "chat.statusPanel.endedWorkflows" })}
      </span>
      <span className="shrink-0 text-[var(--color-foreground-subtle)]">
        {endedWorkflowRunCount}
      </span>
    </StatusSummaryMetric>
  ) : null;

  if (!summaryMetric) {
    return null;
  }

  return (
    <ControlHintTooltip title={expandLabel} sideOffset={4} side="left">
      <button
        type="button"
        aria-label={expandLabel}
        className="group inline-flex w-max max-w-full cursor-pointer flex-col items-stretch text-left text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-menu-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
        onClick={() => {
          // 展开后看到的不能比胶囊还少：胶囊显示着工作流，就连同「工作流」分区一起打开——
          // 哪怕读者先前手动折过它（点胶囊就是「给我看这个」）。
          if (firstLiveRun) onOpenWorkflowSection?.();
          onVariantChange?.("panel");
        }}
      >
        {summaryMetric}
      </button>
    </ControlHintTooltip>
  );
}

function ConversationStatusPanelImpl({
  workspacePath,
  gitCwd,
  workspaceIdentity,
  gitSummary,
  gitDirtyFileCount = 0,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeTaskChangeSummary,
  goal,
  sessionPlans,
  plan,
  backgroundWorks = EMPTY_BACKGROUND_WORKS,
  runningSubagents = EMPTY_RUNNING_SUBAGENTS,
  workflowRuns = EMPTY_WORKFLOW_RUNS,
  endedWorkflowRunCount = 0,
  endedSubagentCount = 0,
  rootSessionId,
  parentSessionId,
  isWebRemoteControl = false,
  isMobileViewport = false,
  layoutMode = "none",
  summaryPanelVariantOverride,
  onVariantChange,
  terminalSectionOpen,
  onTerminalSectionOpenChange,
  agentSectionOpen,
  onAgentSectionOpenChange,
  workflowSectionOpen,
  onWorkflowSectionOpenChange,
  onRefreshGit,
  onOpenGitReview,
  onPauseGoal,
  onResumeGoal,
  onOpenPlanDetail,
  onOpenBackgroundBash,
  onCancelBackgroundWork,
  onStopSubagent,
  pendingSubagentStops,
  timersPaused = false,
  onOpenSubagentSession,
  onOpenSubagentDirectory,
  onOpenWorkflowRun,
  onOpenWorkflowRunDirectory,
  className,
}: ConversationStatusPanelProps) {
  const isOfficeMode = useIsOfficeMode();
  const model = useMemo(
    () =>
      buildConversationStatusPanelModel({
        isOfficeMode,
        gitSummary,
        gitDirtyFileCount,
        gitWorktreeChangeSummary,
        goal,
        sessionPlans,
        workspacePath,
        plan,
        backgroundWorks,
        runningSubagents,
        workflowRuns,
      }),
    [
      isOfficeMode,
      backgroundWorks,
      gitDirtyFileCount,
      gitSummary,
      gitWorktreeChangeSummary,
      goal,
      sessionPlans,
      plan,
      runningSubagents,
      workflowRuns,
      workspacePath,
    ],
  );
  const variant = resolveConversationStatusPanelVariant({
    variantOverride: summaryPanelVariantOverride ?? null,
  });
  const isVariantAutomatic = summaryPanelVariantOverride == null;
  // Bug 根因：状态面板在手机远控中仍把分支/Todo 浮层固定到左侧，
  // 而面板本身已占据大部分视口，左右均无法容纳固定宽度。手机远控改用纵向定位，
  // 让 Radix 在上/下之间翻转；桌面和宽屏 Web 保持原左侧交互。
  const useVerticalFloatingPanels = isWebRemoteControl && isMobileViewport;
  const panelModeValue = isVariantAutomatic ? "auto" : variant;
  const { intl } = useZCodeIntl();
  const panelMenuLabel = intl.formatMessage({
    id: "chat.summaryPanel.displayMode",
  });
  const canRenderGit = Boolean(model.git && gitSummary && onRefreshGit);
  const canRenderGoal = Boolean(model.goal);
  const canRenderSessionPlans = Boolean(model.sessionPlans);
  const canRenderPlan = Boolean(model.plan);
  const canRenderTerminals = model.runningBashWorks.length > 0;
  // 已结束的 run 也开门（与 canRenderAgents 同判断）：重启后活动数为零，若只按它开门，
  // 通往 run 目录的唯一入口会连带消失。
  const canRenderEndedWorkflows = Boolean(
    endedWorkflowRunCount > 0 && parentSessionId && onOpenWorkflowRunDirectory,
  );
  const canRenderWorkflows = model.runningWorkflowRuns.length > 0 || canRenderEndedWorkflows;
  const canRenderEndedAgents = Boolean(
    endedSubagentCount > 0 && parentSessionId && onOpenSubagentDirectory,
  );
  // 已结束目录入口过去渲染在 Agent StatusSection 之后，视觉和 DOM 都被提升成
  // 并列顶层 section。Agent 的运行态和已结束目录属于同一领域，统一由 Agent 折叠分组承载。
  const canRenderAgents = model.runningSubagentWorks.length > 0 || canRenderEndedAgents;
  const handlePanelModeChange = useCallback(
    (value: string) => {
      if (value === "auto") {
        onVariantChange?.(null);
        return;
      }
      if (value === "panel" || value === "mini") {
        onVariantChange?.(value);
      }
    },
    [onVariantChange],
  );
  const handleOpenWorkflowSection = useCallback(() => {
    onWorkflowSectionOpenChange?.(true);
  }, [onWorkflowSectionOpenChange]);
  const handleCollapseToMini = useCallback(() => {
    onVariantChange?.("mini");
  }, [onVariantChange]);

  // `model.hasContent` 只认**活的**内容（模型手上的投影都是活状态），所以「只剩历史」的
  // 会话会连整个胶囊一起消失——而那正是重启后打开一条旧对话的样子，run 目录的入口于是又没了。
  // 已结束的 run 因此单独开这道门。（Agents 的已结束行有同一个洞：`endedSubagentCount` 也
  // 没进 `hasContent`。那是既有行为，不在本轮一起翻。）
  if (!model.hasContent && !canRenderEndedWorkflows) {
    return null;
  }

  return (
    <div
      className={cn(
        "pointer-events-none absolute top-0 z-20 pt-4",
        // 旧 ChatView 的 inline 面板直接钉在右侧，正文列通过独立 translate 让位。
        // v4 若继续用 inset-x-0 + justify-end，会让面板容器宽铺满并改变宽屏下的横向对齐。
        layoutMode === "inline"
          ? "right-4"
          : layoutMode === "auto"
            ? "inset-x-0 flex justify-end px-4 @min-[1280px]/conversation:left-auto @min-[1280px]/conversation:right-4 @min-[1280px]/conversation:px-0"
            : "inset-x-0 flex justify-end px-4",
        className,
      )}
    >
      {/* Bugfix: 状态面板恢复旧 ChatView 的同 shell 收起/展开模型。
          之前 v4 用固定展开卡片替代 summary panel，窄屏会遮挡聊天正文，也丢失用户 override。 */}
      <aside
        aria-label={intl.formatMessage({ id: "chat.summaryPanel.title" })}
        data-testid={TID_CHAT_SUMMARY_PANEL}
        data-state={variant === "mini" ? "collapsed" : "expanded"}
        data-display-mode={variant}
        data-goal-status={model.goal?.status}
        data-goal-objective={model.goal?.objective}
        data-running-background-count={
          model.runningBashWorks.length +
          model.runningSubagentWorks.length +
          model.runningWorkflowRuns.length
        }
        data-running-terminal-count={model.runningBashWorks.length}
        data-running-agent-count={model.runningSubagentWorks.length}
        data-running-workflow-count={model.runningWorkflowRuns.length}
        data-ended-workflow-count={endedWorkflowRunCount}
        className={cn(
          "pointer-events-auto relative overflow-hidden rounded-2xl border border-[var(--color-popover-border)] bg-[var(--color-popover)] text-[var(--color-foreground)] shadow-md transition-[border-radius,padding,background-color,box-shadow] duration-300 ease-in-out",
          // 胶囊宽度只由 CSS 决定：w-max 跟随摘要内容，上限以 conversation 容器（100cqw）为基准。
          // Bug 原因：过去由 ResizeObserver 量出摘要宽度写进 CSS 变量（为了给宽度做插值动画，
          // 而 shell 早已不过渡宽度），测量值会比内容晚一次渲染、上限又按窗口宽度（100vw）算——
          // 两者都能让文字落到胶囊外面。
          variant === "mini"
            ? "inline-flex max-h-8.5 w-max max-w-[min(20rem,calc(100cqw-2rem))] flex-col"
            : variant === "panel"
              ? "flex max-h-[min(64dvh,32rem)] w-80 max-w-[calc(100cqw-2rem)] flex-col"
              : "inline-flex max-h-8.5 w-max max-w-[min(20rem,calc(100cqw-2rem))] flex-col @min-[1280px]/conversation:max-h-[min(64dvh,32rem)] @min-[1280px]/conversation:w-80",
        )}
      >
        {variant !== "mini" ? (
          <div
            className={cn(
              "absolute right-3 top-3 z-10 items-center gap-1",
              variant === "auto" ? "hidden @min-[1280px]/conversation:flex" : "flex",
            )}
          >
            <DropdownMenu>
              <ControlHintTooltip title={panelMenuLabel} side="left">
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    aria-label={panelMenuLabel}
                  >
                    <EllipsisIcon className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </ControlHintTooltip>
              <DropdownMenuContent align="end" side="bottom" className="w-44">
                <DropdownMenuRadioGroup
                  value={panelModeValue}
                  onValueChange={handlePanelModeChange}
                >
                  <DropdownMenuRadioItem value="auto">
                    {intl.formatMessage({
                      id: "chat.summaryPanel.displayModeAuto",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <ControlHintTooltip
              title={intl.formatMessage({ id: "chat.summaryPanel.showMini" })}
              side="left"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6"
                aria-label={intl.formatMessage({
                  id: "chat.summaryPanel.showMini",
                })}
                onClick={handleCollapseToMini}
              >
                <Minimize2Icon className="size-3.5" />
              </Button>
            </ControlHintTooltip>
          </div>
        ) : null}
        {variant !== "mini" ? (
          // 单个区块限高后，多区块同时展开仍可能超过 shell；外层必须提供
          // 第二层兜底滚动，保证后续区块标题和操作始终可达，不能继续直接裁切。
          <div
            className={cn(
              "min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto p-2",
              variant === "auto" ? "hidden @min-[1280px]/conversation:flex" : "flex",
            )}
          >
            {canRenderGit ? (
              <GitStatusSection
                model={model}
                gitSummary={gitSummary}
                gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
                workspacePath={gitCwd ?? workspacePath}
                workspaceIdentity={workspaceIdentity}
                activeTaskChangeSummary={activeTaskChangeSummary}
                onRefreshGit={onRefreshGit}
                onOpenGitReview={onOpenGitReview}
                separated={false}
                useVerticalFloatingPanels={useVerticalFloatingPanels}
              />
            ) : null}
            {canRenderGoal ? (
              <GoalStatusSection
                model={model}
                separated={canRenderGit}
                onPauseGoal={onPauseGoal}
                onResumeGoal={onResumeGoal}
              />
            ) : null}
            {canRenderSessionPlans ? (
              <SessionPlansStatusSection
                model={model}
                parentSessionId={parentSessionId}
                onOpenPlanDetail={onOpenPlanDetail}
                separated={canRenderGit || canRenderGoal}
              />
            ) : null}
            {canRenderPlan ? (
              <PlanStatusSection
                model={model}
                popoverSide={useVerticalFloatingPanels ? "bottom" : "left"}
                separated={canRenderGit || canRenderGoal || canRenderSessionPlans}
              />
            ) : null}
            {canRenderTerminals ? (
              <BackgroundWorkStatusSection
                onOpenBackgroundBash={onOpenBackgroundBash}
                section="terminal"
                title={intl.formatMessage({ id: "chat.statusPanel.terminals" })}
                works={model.runningBashWorks}
                open={terminalSectionOpen}
                onOpenChange={onTerminalSectionOpenChange}
                separated={canRenderGit || canRenderGoal || canRenderSessionPlans || canRenderPlan}
                timersPaused={timersPaused}
                onCancelBackgroundWork={onCancelBackgroundWork}
              />
            ) : null}
            {canRenderWorkflows ? (
              <WorkflowStatusSection
                title={intl.formatMessage({ id: "chat.statusPanel.workflows" })}
                runs={model.runningWorkflowRuns}
                endedRunCount={canRenderEndedWorkflows ? endedWorkflowRunCount : 0}
                open={workflowSectionOpen}
                onOpenChange={onWorkflowSectionOpenChange}
                separated={
                  canRenderGit ||
                  canRenderGoal ||
                  canRenderSessionPlans ||
                  canRenderPlan ||
                  canRenderTerminals
                }
                parentSessionId={parentSessionId}
                timersPaused={timersPaused}
                onCancelBackgroundWork={onCancelBackgroundWork}
                onOpenWorkflowRun={onOpenWorkflowRun}
                onOpenDirectory={onOpenWorkflowRunDirectory}
              />
            ) : null}
            {canRenderAgents ? (
              <SubagentStatusSection
                title={intl.formatMessage({ id: "chat.statusPanel.agents" })}
                subagents={model.runningSubagentWorks}
                endedSubagentCount={canRenderEndedAgents ? endedSubagentCount : 0}
                timersPaused={timersPaused}
                onStopSubagent={onStopSubagent}
                pendingSubagentStops={pendingSubagentStops}
                open={agentSectionOpen}
                onOpenChange={onAgentSectionOpenChange}
                separated={
                  canRenderGit ||
                  canRenderGoal ||
                  canRenderSessionPlans ||
                  canRenderPlan ||
                  canRenderTerminals ||
                  canRenderWorkflows
                }
                parentSessionId={parentSessionId}
                rootSessionId={rootSessionId}
                onOpenSubagentSession={onOpenSubagentSession}
                onOpenSubagentDirectory={onOpenSubagentDirectory}
              />
            ) : null}
          </div>
        ) : null}
        <div
          aria-hidden={variant === "panel"}
          className={cn(
            "w-max max-w-full transition-opacity duration-150",
            variant === "mini"
              ? "pointer-events-auto relative visible opacity-100"
              : variant === "panel"
                ? "pointer-events-none invisible absolute left-0 top-0 opacity-0"
                : "pointer-events-auto relative visible opacity-100 @min-[1280px]/conversation:hidden",
          )}
        >
          <StatusSummaryRow
            model={model}
            // 与页脚同一道门（canRenderEndedWorkflows）：缺会话或缺回调时目录打不开，
            // 胶囊也就不该报一个点了没反应的数。
            endedWorkflowRunCount={canRenderEndedWorkflows ? endedWorkflowRunCount : 0}
            gitWorktreeChangeSummary={gitWorktreeChangeSummary}
            onOpenWorkflowSection={handleOpenWorkflowSection}
            onVariantChange={onVariantChange}
          />
        </div>
      </aside>
    </div>
  );
}

export const ConversationStatusPanel = memo(ConversationStatusPanelImpl);
