import { stationLampClass } from "@/components/workflow-timeline/WorkflowTimelineLedge.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import {
  WorkflowAgentFace,
  AgentResultBadge,
  SubagentCollectionIcon,
} from "@/components/workflow-timeline/WorkflowAgentFace.js";
import { SUBAGENT_WORKFLOW_COLOR } from "@/lib/subagentColors.js";
import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";
/* oxlint-disable eslint(max-lines) -- 状态胶囊复用各类详情与已有操作，保持摘要和详情使用同一数据源。 */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  createContext,
  useContext,
  useRef,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  createLucideIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleCheckBigIcon,
  CircleIcon,
  FileDiffIcon,
  GitBranchIcon,
  GoalIcon,
  ListChecksIcon,
  PauseIcon,
  PlayIcon,
  CircleStopIcon,
  SquareTerminalIcon,
  WorkflowIcon,
} from "lucide-react";
import {
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
  ConversationSnapshot,
  SubagentProjectionState,
  GoalState,
  PlanState,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { GitStatusRepositoryContext } from "@/hooks/useGitRepository.js";
import { Button } from "@/components/ui/button.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { formatBackgroundTaskElapsedLabel } from "@/BackgroundTaskElapsedLabel.js";
import { GitActionMenu } from "@/GitActionMenu.js";
import { HostedGitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { resolveGitBranchTriggerLabel } from "@/git-branch-switcher/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenSubagentDirectorySideTabRequest,
  OpenSubagentSideTabRequest,
  OpenWorkflowRunDirectorySideTabRequest,
} from "@/lib/workspaceSidePane.js";
import {
  buildConversationStatusPanelModel,
  type ConversationStatusPanelRunningSubagent,
  type ConversationStatusPanelModel,
  type ConversationStatusPanelWorkflowRun,
} from "@/v4/conversationStatusPanelModel.js";
import type { ConversationStatusPanelWorkflowRunTarget } from "@/v4/conversationStatusPanelModel.js";
import { workflowRunOpenTarget } from "@/v4/conversationStatusPanelModel.js";
import {
  buildConversationGoalIterationSummaries,
  getConversationGoalElapsedSeconds,
} from "@/v4/conversationGoalSummaryModel.js";

// 当前图标库没有 MonitorActivity；用单个 SVG 描边，避免叠加图标的背景遮住显示器轮廓。
const MonitorActivityIcon = createLucideIcon("MonitorActivity", [
  ["rect", { x: "2", y: "3", width: "20", height: "14", rx: "2", key: "screen" }],
  ["path", { d: "M8 21h8M12 17v4M5 10h3l2-4 3 8 2-4h4", key: "activity" }],
]);

// 胶囊只共享展开身份，不复制会话状态；同一输入框一次只打开一个详情。
const StatusCapsuleContext = createContext<{
  hiddenLabels: readonly string[];
  open: string | null;
  setOpen: React.Dispatch<React.SetStateAction<string | null>>;
} | null>(null);

export function ComposerStatusRow({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const [hiddenLabels, setHiddenLabels] = useState<string[]>([]);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    // 按完整文案计算所需宽度，不用折叠后的宽度判断恢复，避免显隐反复跳动。
    const measure = () => {
      const buttons = [...element.querySelectorAll<HTMLElement>("[data-status-capsule]")];
      const sizes = buttons.map((button) => {
        const css = getComputedStyle(button);
        const title = button.querySelector("[data-capsule-label]");
        const range = document.createRange();
        if (title) range.selectNodeContents(title.firstElementChild ?? title);
        const textWidth = title ? range.getBoundingClientRect().width : 0;
        const icon = button.firstElementChild?.getBoundingClientRect().width ?? 0;
        const secondary = button.querySelector("[data-status-capsule-secondary]");
        const fixed =
          icon +
          (secondary?.getBoundingClientRect().width ?? 0) +
          parseFloat(css.paddingLeft) +
          parseFloat(css.paddingRight) +
          parseFloat(css.borderLeftWidth) +
          parseFloat(css.borderRightWidth) +
          parseFloat(css.columnGap) * (secondary ? 2 : 1);
        return {
          id: button.dataset.statusCapsule!,
          full: fixed + textWidth,
          max: parseFloat(css.maxWidth),
        };
      });
      const total =
        sizes.reduce((sum, item) => sum + Math.min(item.full, item.max), 0) +
        Math.max(0, sizes.length - 1) * parseFloat(getComputedStyle(element).columnGap);
      const next = sizes
        .filter(
          (item) =>
            ["todo", "git", "activity"].includes(item.id) &&
            (total > element.clientWidth + 0.5 || item.full > item.max + 0.5),
        )
        .map((item) => item.id);
      setHiddenLabels((previous) => (previous.join() === next.join() ? previous : next));
      buttons.forEach((button) => resize.observe(button));
    };
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    const mutation = new MutationObserver(measure);
    mutation.observe(element, { childList: true, characterData: true, subtree: true });
    measure();
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);
  const value = useMemo(() => ({ open, setOpen, hiddenLabels }), [open, hiddenLabels]);
  return (
    <StatusCapsuleContext.Provider value={value}>
      <div className="@container min-w-0 max-w-full px-3">
        <div
          ref={row}
          data-testid="composer-status-row"
          // 与输入框底部 pb-4、滚动按钮 mb-4 对齐；不叠加顶部 padding。
          className="flex min-w-0 max-w-full items-center justify-center gap-2 pb-4 empty:hidden @max-[640px]:gap-1"
        >
          {children}
        </div>
      </div>
    </StatusCapsuleContext.Provider>
  );
}

function StatusCapsuleTitle({ title }: { title: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Goal 标题保留溢出淡出；其他胶囊由状态栏统一决定折叠。
    const measure = () => setOverflow(element.scrollWidth > element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [title]);
  return (
    <span
      ref={ref}
      className={cn(
        "block min-w-0 overflow-hidden whitespace-nowrap",
        overflow && "[mask-image:linear-gradient(to_right,black_calc(100%_-_1rem),transparent)]",
      )}
    >
      {title}
    </span>
  );
}

export function StatusCapsule({
  id,
  label,
  secondary,
  icon,
  children,
  tone,
  attention = false,
  dataAttributes,
}: {
  id: string;
  label: ReactNode;
  secondary?: ReactNode;
  icon: ReactNode;
  children: ReactNode;
  tone?: "warning" | "destructive";
  attention?: boolean;
  dataAttributes?: Record<`data-${string}`, string | number | undefined>;
}) {
  const shared = useContext(StatusCapsuleContext);
  const hideLabel = shared?.hiddenLabels.includes(id) ?? false;
  const [localOpen, setLocalOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const setSharedOpen = shared?.setOpen;
  useEffect(
    () => () => {
      // 状态消失时清除展开身份，避免同类状态再次出现时自动展开。
      setSharedOpen?.((current) => (current === id ? null : current));
    },
    [id, setSharedOpen],
  );
  const open = shared ? shared.open === id : localOpen;
  useEffect(() => {
    if (attention) trigger.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [attention]);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => (shared ? shared.setOpen(next ? id : null) : setLocalOpen(next))}
    >
      <PopoverTrigger asChild>
        <Button
          ref={trigger}
          type="button"
          variant="outline"
          size="sm"
          data-status-capsule={id}
          {...dataAttributes}
          aria-label={hideLabel && typeof label === "string" ? label : undefined}
          // 基础 Button 的 bg-clip-padding 会让边框下方缺少背景；胶囊局部覆盖以保持边缘连续。
          className={cn(
            "relative grid h-8 min-w-min max-w-64 shrink gap-1.5 rounded-full border-[0.5px] border-input-border bg-input bg-clip-border backdrop-blur-md pl-2 pr-2.5 text-ui-base shadow-(--shadow-composer-soft) @max-[640px]:gap-1",
            // flex 的 min-w-0 会把外框缩得比固定图标与数字更窄；Grid 最小列宽保护这些槽位。
            hideLabel
              ? "grid-cols-[auto_auto] shrink-0"
              : secondary != null
                ? "grid-cols-[auto_minmax(0,1fr)_auto]"
                : "grid-cols-[auto_minmax(0,1fr)]",
            tone === "warning" && "text-warning",
            tone === "destructive" && "text-destructive",
          )}
        >
          <span
            className={cn(
              "flex h-4 shrink-0 items-center justify-center",
              id === "activity" ? "min-w-4" : "w-4",
            )}
          >
            {icon}
          </span>
          <span
            data-capsule-label
            className={cn(
              "min-w-0 text-ui-base",
              hideLabel
                ? "pointer-events-none invisible absolute w-max whitespace-nowrap"
                : "overflow-hidden",
            )}
          >
            {typeof label === "string" ? <StatusCapsuleTitle title={label} /> : label}
          </span>
          {secondary != null ? (
            <span
              data-status-capsule-secondary
              className="flex shrink-0 items-center gap-1 text-ui-sm text-foreground-subtle tabular-nums"
            >
              {secondary}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      {open ? (
        <PopoverContent
          side="top"
          align="center"
          collisionPadding={12}
          data-status-capsule-content={id}
          className={cn(
            "composer-status-popover w-80 max-w-[calc(100vw-1.5rem)] max-h-[min(60dvh,var(--radix-popover-content-available-height))] overflow-y-auto rounded-xl p-2",
            // 操作区分隔线已提供间距，避免叠加共享浮层的 gap-4。
            (id === "git" || id === "activity") && "gap-0",
          )}
        >
          {children}
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

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
  plan?: PlanState | null;
  backgroundWorks?: readonly BackgroundWorkSummary[];
  runningSubagents?: readonly ConversationStatusPanelRunningSubagent[];
  endedSubagents?: SubagentProjectionState["ended"];
  activitySummaryDismissed?: ConversationSnapshot["activitySummaryDismissed"];
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
  /** CLI 完整历史成功数，不含 Bash；缺席时兼容旧 CLI 的预览计数。 */
  completedActivityCount?: number | null;
  endedSubagentCount?: number;
  rootSessionId?: string;
  parentSessionId?: string;
  onRefreshGit?: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onPauseGoal?: () => void;
  onResumeGoal?: () => void;
  onOpenBackgroundBash?: (work: BackgroundWorkSummary) => void;
  onCancelBackgroundWork?: (workId: string) => void;
  onStopSubagent?: (control: { taskId: string; executionId: string }) => void;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenSubagentDirectorySideTabRequest) => void;
  onOpenWorkflowRun?: (target: ConversationStatusPanelWorkflowRunTarget) => void;
  onOpenWorkflowRunDirectory?: (request: OpenWorkflowRunDirectorySideTabRequest) => void;
}
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

function GoalStatusSection({
  model,
  onPauseGoal,
  onResumeGoal,
}: {
  model: ConversationStatusPanelModel;
  onPauseGoal?: () => void;
  onResumeGoal?: () => void;
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
        size="sm"
        className="shrink-0"
        data-goal-action="pause"
        disabled={!onPauseGoal}
        aria-label={intl.formatMessage({ id: "chat.target.pause" })}
        onClick={onPauseGoal}
      >
        <PauseIcon className="size-3.5" />
        {intl.formatMessage({ id: "chat.target.pause" })}
      </Button>
    </ControlHintTooltip>
  ) : isPaused ? (
    <ControlHintTooltip title={intl.formatMessage({ id: "chat.target.resume" })}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0"
        data-goal-action="resume"
        disabled={!onResumeGoal}
        aria-label={intl.formatMessage({ id: "chat.target.resume" })}
        onClick={onResumeGoal}
      >
        <PlayIcon className="size-3.5" />
        {intl.formatMessage({ id: "chat.target.resume" })}
      </Button>
    </ControlHintTooltip>
  ) : isDone ? (
    <CircleCheckBigIcon
      aria-label={intl.formatMessage({ id: "chat.goalVerification.complete" })}
      className="size-4 shrink-0 text-success"
    />
  ) : null;

  return (
    <section data-status-section="goal" className="min-w-0">
      <div className="px-2 pt-2 text-ui-base break-words">{goal.objective}</div>
      <div className="flex min-h-8 items-center justify-between gap-2 px-2 py-2 text-ui-sm text-foreground-subtle">
        <span
          className="tabular-nums"
          data-goal-elapsed-seconds={getConversationGoalElapsedSeconds(goal, now)}
        >
          {intl.formatMessage({ id: "chat.target.elapsed" }, { duration: elapsed })}
        </span>
        {control}
      </div>
      <div className="space-y-0">
        {/* 首轮摘要是模型自动生成的占位；没有轮次数据时不重复展示目标短标题。 */}
        {iterationRows
          .filter(
            (row) =>
              row.iteration > 1 ||
              row.totalCount > 0 ||
              row.verificationOutcome != null ||
              goal.iterations?.some((entry) => entry.iteration === row.iteration),
          )
          .map((row) => {
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
                className="flex min-w-0 cursor-default items-start gap-2 rounded-lg px-2 py-2 hover:bg-hover"
                title={title}
              >
                {row.completed ? (
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-success text-ui-xs tabular-nums text-success">
                    {row.iteration}
                  </span>
                ) : (
                  <GoalIcon className="size-4 shrink-0 text-foreground-subtle" />
                )}
                <p className="line-clamp-3 min-w-0 flex-1 text-ui-base leading-4 text-foreground">
                  {title}
                </p>
                {row.totalCount > 0 ? (
                  <span className="shrink-0 text-ui-sm tabular-nums text-foreground-subtle">
                    {row.completedCount}/{row.totalCount}
                  </span>
                ) : null}
              </div>
            );
          })}
      </div>
    </section>
  );
}

function PlanStatusIcon({ status }: { status: PlanState["items"][number]["status"] }) {
  if (status === "completed") {
    return <CheckCircle2Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />;
  }
  if (status === "inProgress") {
    return <ArrowRightIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-foreground" />;
  }
  return <CircleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-foreground-subtlest" />;
}

function PlanStatusItemRows({ items }: { items: PlanState["items"] }) {
  return items.map((item) => (
    <li
      key={item.id}
      data-plan-status={item.status}
      className="flex min-h-8 items-start gap-2 rounded-lg px-2 py-1.5 text-ui-base hover:bg-hover"
    >
      <PlanStatusIcon status={item.status} />
      <span
        title={item.content}
        className={cn(
          "min-w-0 flex-1 break-words leading-5",
          item.status === "completed" ? "text-foreground-subtlest line-through" : "text-foreground",
        )}
      >
        {item.content}
      </span>
    </li>
  ));
}

function PlanStatusSection({ model }: { model: ConversationStatusPanelModel }) {
  const focusCurrent = useCallback((node: HTMLUListElement | null) => {
    node?.querySelector('[data-plan-status="inProgress"]')?.scrollIntoView({ block: "nearest" });
  }, []);
  const plan = model.plan;
  if (!plan) return null;

  return (
    <section data-status-section="plan" className="min-w-0">
      <ul ref={focusCurrent}>
        <PlanStatusItemRows items={plan.items} />
      </ul>
    </section>
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
      className="pointer-events-auto relative z-[2] ml-auto h-6 shrink-0 px-1.5 text-ui-base text-foreground"
    >
      <CircleStopIcon aria-hidden className="size-3" />
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
      className="group relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 hover:bg-hover"
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
      <SquareTerminalIcon className="pointer-events-none relative z-[1] mt-0.5 size-4 shrink-0 text-foreground-subtle" />
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="line-clamp-2 text-ui-base leading-5 text-foreground">{work.title}</p>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-base">
          <span className="shrink-0 text-ui-sm tabular-nums text-foreground-subtle">
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

/** 未命名的判定：`title ≡ runId`（见 `ConversationStatusPanelWorkflowRun.title`）。 */
function workflowRunDisplayName(run: ConversationStatusPanelWorkflowRun): string | null {
  return run.title && run.title !== run.runId ? run.title : null;
}

/** 单盏状态灯（pending 空心、running 脉冲），与卡片、侧栏同一套 `STATUS_DOT`。 */
function WorkflowRunLamp({ status }: { status: "pending" | "running" }) {
  return (
    <span aria-hidden="true" data-workflow-run-lamp={status} className={stationLampClass(status)} />
  );
}

// 活动行按标题、头像、耗时与操作分层，避免悬停时用停止按钮遮住耗时。
function WorkflowRunRow({
  now,
  onCancelBackgroundWork,
  onOpenWorkflowRun,
  run,
  actors,
}: {
  now: number;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenWorkflowRun?: (target: ConversationStatusPanelWorkflowRunTarget) => void;
  run: ConversationStatusPanelWorkflowRun;
  actors?: WorkflowRunState["actors"];
}) {
  const { intl } = useZCodeIntl();
  const openTarget = onOpenWorkflowRun ? workflowRunOpenTarget(run) : null;
  const displayName =
    workflowRunDisplayName(run) ??
    intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const canStop = Boolean(run.workId && run.cancellable !== false && onCancelBackgroundWork);
  return (
    <li
      data-testid={run.workId ? testId(TID_V4_BACKGROUND_WORK_ITEM, run.workId) : undefined}
      data-background-task-kind="workflow"
      data-workflow-run-id={run.runId}
      data-work-id={run.workId}
      data-work-status={run.status}
      className="group relative flex min-w-0 items-start gap-2 rounded-lg p-2 hover:bg-hover"
    >
      {openTarget ? (
        <button
          type="button"
          data-workflow-run-details-trigger="true"
          data-workflow-run-id={run.runId}
          aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" })}
          onClick={() => onOpenWorkflowRun?.(openTarget)}
          className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-input-border-focused"
        />
      ) : null}
      <span className="pointer-events-none relative z-[1] flex h-5 w-4 shrink-0 items-center justify-center">
        {run.status ? <WorkflowRunLamp status={run.status} /> : null}
      </span>
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="line-clamp-2 text-ui-base leading-5 text-foreground">{displayName}</span>
        {actors?.length ? (
          <span className="flex flex-wrap items-center gap-2">
            {actors.map((actor) => (
              <WorkflowAgentFace
                key={`${actor.siteId}:${actor.ordinal}`}
                avatarIndex={undefined}
                name={actor.name || actor.siteId}
                status={
                  actor.status === "completed"
                    ? "done"
                    : actor.status === "running"
                      ? "running"
                      : undefined
                }
                showCompletionMark={actor.status === "completed"}
                className="size-4 min-h-4! min-w-4!"
              />
            ))}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {run.startedAt !== undefined && run.status !== "pending" ? (
            <span className="text-ui-sm tabular-nums text-foreground-subtle">
              {formatBackgroundTaskElapsedLabel(
                Math.max(0, now - run.startedAt),
                intl.formatMessage,
              )}
            </span>
          ) : null}
          {canStop && run.workId ? (
            <RunningWorkCancelButton workId={run.workId} onCancel={onCancelBackgroundWork} />
          ) : null}
        </div>
      </div>
    </li>
  );
}

function SubagentStatusSection({
  timersPaused = false,
  onStopSubagent,
  pendingSubagentStops,
  onOpenSubagentSession,
  parentSessionId,
  rootSessionId,
  subagents,
}: {
  timersPaused?: boolean;
  onStopSubagent?: (control: { taskId: string; executionId: string }) => void;
  pendingSubagentStops?: ReadonlySet<string>;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
  parentSessionId?: string;
  rootSessionId?: string;
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
  if (subagents.length === 0) return null;
  const rows = (
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
              "group relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 hover:bg-hover",
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
                className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-input-border-focused"
              />
            ) : null}
            {/* 活动项统一使用 16px 图标列；覆盖头像最小尺寸，并按标题首行居中。 */}
            <span className="pointer-events-none relative z-[1] flex h-5 w-4 shrink-0 items-center justify-center">
              <WorkflowAgentFace
                avatarIndex={undefined}
                name={subagent.subagentType}
                status="running"
                color={configuredColor ? SUBAGENT_WORKFLOW_COLOR[configuredColor] : undefined}
                className="size-4 min-h-4! min-w-4!"
              />
            </span>
            <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="line-clamp-2 text-ui-base leading-5 text-foreground">
                {subagent.title}
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-base">
                <span className="text-ui-sm tabular-nums text-foreground-subtle">
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
                    className="pointer-events-auto relative z-[2] ml-auto h-6 shrink-0 px-1.5 text-ui-base text-foreground"
                  >
                    <CircleStopIcon aria-hidden className="size-3" />
                    {intl.formatMessage({ id: "chat.statusPanel.runningStop" })}
                  </Button>
                ) : null}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
  return <li>{rows}</li>;
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
    <div className={cn(separated && "mt-1 border-t-[0.5px] border-border/50 pt-1")}>
      <button
        type="button"
        data-testid={testId}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-ui-base text-foreground hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-input-border-focused"
        onClick={onOpen}
      >
        {icon}
        <span>{label}</span>
        <span className="ml-auto text-ui-sm tabular-nums text-foreground-subtle">{count}</span>
        <ChevronRightIcon className="size-4 text-foreground-subtle" />
      </button>
    </div>
  );
}

type ActivityResult = "completed" | "stopped" | "failed";
function EndedActivityItem({
  title,
  summary,
  result,
  icon,
  actors,
  startedAt,
  endedAt,
  onOpen,
}: {
  title: string;
  summary?: string;
  result: ActivityResult;
  icon: ReactNode;
  actors?: WorkflowRunState["actors"];
  startedAt?: number;
  endedAt?: number;
  onOpen?: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <li
      data-activity-result={result}
      className="relative flex items-start gap-2 rounded-lg p-2 hover:bg-hover"
    >
      {onOpen ? (
        <button
          type="button"
          className="absolute inset-0 rounded-lg"
          aria-label={title}
          onClick={onOpen}
        />
      ) : null}
      <span className="pointer-events-none relative mt-0.5 size-4 shrink-0">{icon}</span>
      <div className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="line-clamp-2 text-ui-base leading-5">{title}</span>
        {actors?.length ? (
          <span className="flex flex-wrap gap-2">
            {actors.map((actor) => (
              <WorkflowAgentFace
                key={`${actor.siteId}:${actor.ordinal}`}
                avatarIndex={undefined}
                name={actor.name || actor.siteId}
                status={actor.status === "completed" ? "done" : undefined}
                showCompletionMark={actor.status === "completed"}
                className="size-4 min-h-4! min-w-4!"
              />
            ))}
          </span>
        ) : null}
        {/* 结束摘要可能沿用启动描述，和标题相同时不重复展示；保留不同摘要的原文。 */}
        {summary?.trim() && summary.trim() !== title.trim() ? (
          <span className="line-clamp-2 text-ui-sm text-foreground-subtle">{summary}</span>
        ) : null}
        <span className="flex gap-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: `chat.capsule.activity.${result}` })}
          {startedAt !== undefined && endedAt !== undefined ? (
            <span className="tabular-nums">
              {formatDurationUnits(
                Math.max(0, Math.floor((endedAt - startedAt) / 1000)),
                intl.formatMessage,
              )}
            </span>
          ) : null}
        </span>
      </div>
    </li>
  );
}

function ConversationStatusPanelImpl(props: ConversationStatusPanelProps) {
  const { intl } = useZCodeIntl();
  const presentation = useToolPresentationCapabilities();
  const capsuleContext = useContext(StatusCapsuleContext);
  const isOfficeMode = useIsOfficeMode();
  const repository = useContext(GitStatusRepositoryContext);
  const {
    workspacePath,
    gitCwd,
    workspaceIdentity,
    gitSummary,
    onRefreshGit,
    parentSessionId,
    rootSessionId,
    onCancelBackgroundWork,
    onStopSubagent,
    pendingSubagentStops,
  } = props;
  // 子会话标签切换只隐藏 forceMount 内容，不会卸载；导航前关闭 Portal，避免失去锚点。
  const closeOnNavigate = <Args extends unknown[]>(action: ((...args: Args) => void) | undefined) =>
    action
      ? (...args: Args) => {
          capsuleContext?.setOpen(null);
          action(...args);
        }
      : undefined;
  const onOpenGitReview = closeOnNavigate(props.onOpenGitReview);
  const onOpenBackgroundBash = closeOnNavigate(props.onOpenBackgroundBash);
  const onOpenWorkflowRun = closeOnNavigate(props.onOpenWorkflowRun);
  const onOpenSubagentSession = closeOnNavigate(props.onOpenSubagentSession);
  const onOpenSubagentDirectory = closeOnNavigate(props.onOpenSubagentDirectory);
  const onOpenWorkflowRunDirectory = closeOnNavigate(props.onOpenWorkflowRunDirectory);
  const workflowRuns = props.workflowRuns ?? EMPTY_WORKFLOW_RUNS;
  // actor.sessionId 是协议中的归属事实；没有关联的旧数据不猜测、不隐藏。
  const workflowChildren = new Set(
    workflowRuns.flatMap((run) =>
      run.actors.flatMap((actor) => (actor.sessionId ? [actor.sessionId] : [])),
    ),
  );
  const model = buildConversationStatusPanelModel({
    ...props,
    isOfficeMode,
    runningSubagents: (props.runningSubagents ?? EMPTY_RUNNING_SUBAGENTS).filter(
      (agent) => !workflowChildren.has(agent.childSessionId),
    ),
  });
  const endedAgents = (props.endedSubagents ?? []).filter(
    (agent) =>
      !workflowChildren.has(agent.childSessionId) &&
      (!props.activitySummaryDismissed?.subagentIds.includes(agent.childSessionId) ||
        (agent.endedAt ?? 0) > props.activitySummaryDismissed.at),
  );
  const endedRuns = workflowRuns.filter(
    (run) =>
      run.status !== "pending" &&
      run.status !== "running" &&
      !props.activitySummaryDismissed?.workflowRunIds.includes(run.runId),
  );
  const endedWorks = (props.backgroundWorks ?? []).filter(
    (work) =>
      work.kind === "bash" &&
      work.status !== "running" &&
      !props.activitySummaryDismissed?.workIds.includes(work.workId),
  );
  const now = useNowTicker(
    !props.timersPaused &&
      (model.runningBashWorks.length + model.runningWorkflowRuns.length > 0 ||
        (model.goal?.status === "active" && model.goal.activeRunStartedAtMs != null)),
  );
  const gitData = repository?.workspacePath === (gitCwd ?? workspacePath) ? repository : null;
  const changes = gitData
    ? ["unstaged", "staged"].flatMap((source) =>
        gitData.state.datasets[source as "unstaged" | "staged"].sections.flatMap((section) =>
          section.changes.map((change) => ({ change, source: source as "unstaged" | "staged" })),
        ),
      )
    : [];
  const files = [...new Set(changes.map(({ change }) => change.path))];
  const branchLabel = gitSummary
    ? resolveGitBranchTriggerLabel({
        headRefType: gitSummary.headRefType,
        currentBranchName: gitSummary.branchName,
        detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
        fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
      })
    : "";
  const canGit = Boolean(
    !isOfficeMode &&
    gitSummary?.isRepository &&
    (files.length || (props.gitDirtyFileCount ?? 0) > 0),
  );
  // 运行与已结束项来自权威投影；已结束摘要保留到下次成功发送边界。
  const activities = [
    ...model.runningBashWorks.map((work) => ({
      id: "bash:" + work.workId,
      startedAt: work.startedAt,
      node: (
        <RunningStatusItem
          work={work}
          now={now}
          onOpenBackgroundBash={onOpenBackgroundBash}
          onCancelBackgroundWork={onCancelBackgroundWork}
        />
      ),
    })),
    ...model.runningWorkflowRuns.map((run) => ({
      id: "workflow:" + run.runId,
      startedAt: run.startedAt,
      node: (
        <WorkflowRunRow
          run={run}
          actors={workflowRuns.find((item) => item.runId === run.runId)?.actors}
          now={now}
          onOpenWorkflowRun={onOpenWorkflowRun}
          onCancelBackgroundWork={onCancelBackgroundWork}
        />
      ),
    })),
    ...model.runningSubagentWorks.map((agent) => ({
      id: "agent:" + agent.childSessionId,
      startedAt: agent.startedAt,
      node: (
        <SubagentStatusSection
          timersPaused={props.timersPaused}
          subagents={[agent]}
          parentSessionId={parentSessionId}
          rootSessionId={rootSessionId}
          onStopSubagent={onStopSubagent}
          pendingSubagentStops={pendingSubagentStops}
          onOpenSubagentSession={onOpenSubagentSession}
        />
      ),
    })),
  ].sort(
    (a, b) =>
      (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id),
  );
  const endedActivities: { id: string; result: ActivityResult; node: ReactNode }[] = [
    ...endedWorks.map((work) => {
      const result: ActivityResult =
        work.status === "failed" ? "failed" : work.status === "cancelled" ? "stopped" : "completed";
      return {
        id: `bash:${work.workId}`,
        result,
        node: (
          <EndedActivityItem
            title={work.title}
            summary={work.resultSummary}
            result={result}
            icon={<SquareTerminalIcon className="size-4" />}
            startedAt={work.startedAt}
            endedAt={work.endedAt}
            onOpen={onOpenBackgroundBash ? () => onOpenBackgroundBash(work) : undefined}
          />
        ),
      };
    }),
    ...endedRuns.map((run) => {
      const work = props.backgroundWorks?.find((item) => item.workId === run.runId);
      const result: ActivityResult =
        run.status === "errored" ? "failed" : run.status === "stopped" ? "stopped" : "completed";
      const title =
        work?.title && work.title !== run.runId
          ? work.title
          : intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
      return {
        id: `workflow:${run.runId}`,
        result,
        node: (
          <EndedActivityItem
            title={title}
            result={result}
            summary={run.error || run.resultPreview}
            icon={
              <span
                className={cn(
                  "mt-1 block size-1.5 rounded-full",
                  result === "completed"
                    ? "bg-success"
                    : result === "failed"
                      ? "bg-destructive"
                      : "bg-foreground-subtle",
                )}
              />
            }
            actors={run.actors}
            startedAt={work?.startedAt}
            endedAt={work?.endedAt}
            onOpen={
              run.toolCallId && onOpenWorkflowRun
                ? () =>
                    onOpenWorkflowRun({
                      runId: run.runId,
                      toolCallId: run.toolCallId!,
                      workflowName: title,
                    })
                : undefined
            }
          />
        ),
      };
    }),
    ...endedAgents.map((agent) => {
      const configuredColor = presentation.agentColor?.(agent.subagentType);
      const result: ActivityResult =
        agent.status === "failed"
          ? "failed"
          : agent.status === "cancelled"
            ? "stopped"
            : "completed";
      return {
        id: `agent:${agent.childSessionId}`,
        result,
        node: (
          <EndedActivityItem
            title={agent.title}
            result={result}
            summary={agent.summary}
            icon={
              <WorkflowAgentFace
                avatarIndex={undefined}
                name={agent.subagentType}
                color={configuredColor ? SUBAGENT_WORKFLOW_COLOR[configuredColor] : undefined}
                // 停止和失败不能回退 undefined，否则头像会显示等待三点。
                status={
                  result === "completed" ? "done" : result === "failed" ? "failed" : undefined
                }
                idle={result === "stopped"}
                result={result}
                className="size-4 min-h-4! min-w-4!"
              />
            }
            startedAt={agent.startedAt}
            endedAt={agent.endedAt}
            onOpen={
              parentSessionId && onOpenSubagentSession
                ? () =>
                    onOpenSubagentSession({
                      parentSessionId,
                      rootSessionId: rootSessionId ?? parentSessionId,
                      childSessionId: agent.childSessionId,
                      subagentType: agent.subagentType,
                      title: agent.title,
                    })
                : undefined
            }
          />
        ),
      };
    }),
  ];
  // 旧实现用本轮结束明细统一挡住目录，导致新终端完成时上一轮历史入口消失。
  // 两类目录按各自已收起身份独立展示，与本轮结果共存；首次完成不提前显示目录。
  const hasSubagentDirectory = Boolean(
    props.activitySummaryDismissed?.subagentIds.length &&
    parentSessionId &&
    onOpenSubagentDirectory &&
    (props.endedSubagentCount ?? 0) > 0,
  );
  const hasWorkflowDirectory = Boolean(
    props.activitySummaryDismissed?.workflowRunIds.length &&
    parentSessionId &&
    onOpenWorkflowRunDirectory &&
    (props.endedWorkflowRunCount ?? 0) > 0,
  );
  const hasHistoryEntry = hasSubagentDirectory || hasWorkflowDirectory;
  // 收起明细只清除旧失败；Bash 只保留本轮成功，独立 child/Workflow 跨轮保留。
  const failedCount = endedActivities.filter((item) => item.result === "failed").length;
  const completedBashCount = endedWorks.filter((work) => work.status === "resultPending").length;
  const previewCompletedCount =
    workflowRuns.filter((run) => run.status === "completed").length +
    (props.endedSubagents ?? []).filter(
      (agent) => agent.status === "success" && !workflowChildren.has(agent.childSessionId),
    ).length;
  // null 只表示完整数量未知，不能抹掉已观察到的成功状态；undefined 兼容旧 CLI。
  const completedCount =
    props.completedActivityCount === null
      ? null
      : completedBashCount + (props.completedActivityCount ?? previewCompletedCount);
  const hasCompletedResult =
    (completedCount ?? 0) > 0 || completedBashCount + previewCompletedCount > 0;
  const activityResult: ActivityResult = failedCount
    ? "failed"
    : !hasCompletedResult && endedActivities.some((item) => item.result === "stopped")
      ? "stopped"
      : "completed";
  const activityLabel = activities.length
    ? "chat.capsule.activity.running"
    : activityResult === "stopped"
      ? "chat.capsule.activityLabel"
      : `chat.capsule.activity.${activityResult}`;
  const activityCount = activities.length || failedCount || completedCount;
  const avatarResult: ActivityResult | undefined = activities.length ? undefined : activityResult;
  // 头像组保留运行和成功项，不能复用摘要状态过滤；每个头像按自身事实显示徽标。
  const avatarAgents = [
    ...model.runningSubagentWorks,
    ...(activities.length || avatarResult === "completed"
      ? (props.endedSubagents ?? []).filter(
          (agent) => agent.status === "success" && !workflowChildren.has(agent.childSessionId),
        )
      : endedAgents.filter((agent) =>
          avatarResult === "failed" ? agent.status === "failed" : agent.status === "cancelled",
        )),
  ];
  const activityAvatars = Array.from(
    new Map<
      string,
      {
        name: string;
        status: "running" | "done" | "failed" | undefined;
        result: ActivityResult | undefined;
        color?: string;
      }
    >([
      ...workflowRuns
        // 父 run 停止或失败不撤销 actor 已完成的事实；只补入本轮仍可见的结束 run。
        .filter(
          (run) =>
            endedRuns.includes(run) ||
            (activities.length
              ? run.status === "running" || run.status === "pending" || run.status === "completed"
              : avatarResult === "completed" && run.status === "completed"),
        )
        .flatMap((run) =>
          run.actors
            .filter(
              (actor) =>
                actor.status === "completed" ||
                (activities.length && (run.status === "running" || run.status === "pending")),
            )
            .map(
              (actor) =>
                [
                  actor.sessionId || `${run.runId}:${actor.siteId}:${actor.ordinal}`,
                  {
                    name: actor.name || actor.siteId,
                    status:
                      actor.status === "completed"
                        ? "done"
                        : actor.status === "running"
                          ? "running"
                          : undefined,
                    result: actor.status === "completed" ? "completed" : undefined,
                  },
                ] as const,
            ),
        ),
      ...avatarAgents.map((agent) => {
        // 消息区与运行详情已经读取配置色，胶囊和结束详情必须使用同一身份来源。
        const configuredColor = presentation.agentColor?.(agent.subagentType);
        const result: ActivityResult | undefined =
          agent.status === "success"
            ? "completed"
            : agent.status === "failed"
              ? "failed"
              : agent.status === "cancelled"
                ? "stopped"
                : undefined;
        return [
          agent.childSessionId,
          {
            name: agent.subagentType,
            status:
              result === undefined
                ? agent.status === "running"
                  ? "running"
                  : undefined
                : result === "completed"
                  ? "done"
                  : result === "failed"
                    ? "failed"
                    : undefined,
            result,
            color: configuredColor ? SUBAGENT_WORKFLOW_COLOR[configuredColor] : undefined,
          },
        ] as const;
      }),
    ]).entries(),
  )
    // 等待和运行都没有 result，旧排序会让三个等待 actor 挤掉真正运行的代理。
    // 先按运行、等待、结束占名额，再单独排列展示位置。
    .sort(
      ([, left], [, right]) =>
        Number(left.result !== undefined) - Number(right.result !== undefined) ||
        Number(right.status === "running") - Number(left.status === "running"),
    )
    .slice(0, 3)
    // 占位优先级不等于展示顺序：选定后完成在左、进行中在右，不能先换序再截取。
    .sort(
      ([, left], [, right]) =>
        Number(right.result !== undefined) - Number(left.result !== undefined),
    );

  const goal = model.goal;
  const goalSeconds = goal ? getConversationGoalElapsedSeconds(goal, now) : 0;
  const goalDuration = formatDurationUnits(goalSeconds, intl.formatMessage);
  const goalStatus =
    goal && goal.status !== "active"
      ? intl.formatMessage({ id: `chat.capsule.goal.${goal.status}` })
      : "";
  const todoStatus = model.plan?.items.some((item) => item.status === "inProgress")
    ? "running"
    : model.plan && model.plan.completedCount === model.plan.totalCount
      ? "completed"
      : "pending";
  return (
    <>
      {goal ? (
        <StatusCapsule
          id="goal"
          icon={
            goal.status === "verified" ? (
              <CircleCheckBigIcon className="size-4 text-success" />
            ) : (
              <GoalIcon className="size-4" />
            )
          }
          label={goal.summaryTitle || goal.objective}
          secondary={
            goal.status !== "verified"
              ? goal.status === "active"
                ? goalDuration
                : goalStatus
              : undefined
          }
        >
          <GoalStatusSection
            model={model}
            onPauseGoal={props.onPauseGoal}
            onResumeGoal={props.onResumeGoal}
          />
        </StatusCapsule>
      ) : null}
      {model.plan?.totalCount ? (
        <StatusCapsule
          id="todo"
          icon={
            model.plan.completedCount === model.plan.totalCount ? (
              <CheckCircle2Icon className="size-4 text-success" />
            ) : (
              <ListChecksIcon className="size-4" />
            )
          }
          label={intl.formatMessage({ id: "chat.capsule.todo." + todoStatus })}
          secondary={`${model.plan.completedCount}/${model.plan.totalCount}`}
        >
          <PlanStatusSection model={model} />
        </StatusCapsule>
      ) : null}
      {canGit ? (
        <StatusCapsule
          id="git"
          icon={<FileDiffIcon className="size-4" />}
          label={intl.formatMessage(
            { id: "chat.capsule.files" },
            { count: files.length || props.gitDirtyFileCount || 0 },
          )}
          secondary={
            <>
              <span className="text-diff-added">+{props.gitWorktreeChangeSummary?.added ?? 0}</span>
              <span className="text-diff-removed">
                −{props.gitWorktreeChangeSummary?.removed ?? 0}
              </span>
            </>
          }
        >
          {/* 滚动视口抵达面板边缘，留白放在内容内，避免滚动条随外层 p-2 内缩。 */}
          <ScrollFadeViewport
            data-testid="status-git-files"
            className="-mx-2 max-h-64 flex-none overscroll-y-contain px-2"
          >
            {changes.map(({ change, source }) => (
              <button
                key={source + ":" + change.path}
                type="button"
                title={`${change.workspaceRelativePath || change.path} · ${intl.formatMessage({ id: "chat.capsule." + source })}`}
                aria-label={`${change.workspaceRelativePath || change.path} ${intl.formatMessage({ id: "chat.capsule." + source })} ${change.added + change.removed > 0 ? `+${change.added} -${change.removed}` : intl.formatMessage({ id: "chat.capsule.fileChanged" })}`}
                className="flex w-full items-center gap-2 rounded-lg p-2 text-left text-ui-base hover:bg-hover"
                onClick={closeOnNavigate(() => gitData?.openChange(change.path, source))}
              >
                <FileDisplayIcon
                  src={resolveFileDisplayDescriptor(change.path).fileIconSrc}
                  size={16}
                  className="shrink-0"
                />
                <span className="min-w-0 flex-1 truncate">
                  {resolveFileDisplayDescriptor(change.path).fileName}
                </span>
                {change.added + change.removed > 0 ? (
                  <span className="shrink-0">
                    <span className="text-diff-added">+{change.added}</span>{" "}
                    <span className="text-diff-removed">-{change.removed}</span>
                  </span>
                ) : null}
              </button>
            ))}
          </ScrollFadeViewport>
          {gitSummary ? (
            <div>
              {/* 分隔线独立留白，避免操作区单侧 padding 造成上下间距不均。 */}
              {changes.length > 0 ? (
                <div aria-hidden="true" className="my-1 border-t-[0.5px] border-border/50" />
              ) : null}
              <Button
                data-testid="status-git-view-all"
                variant="ghost"
                className="h-8 w-full justify-start gap-2 rounded-lg border-0 px-2 text-left text-ui-base"
                disabled={!onOpenGitReview}
                onClick={() => onOpenGitReview?.(props.gitWorktreeReviewSourceId ?? undefined)}
              >
                <FileDiffIcon className="size-4" />
                <span className="min-w-0 flex-1 text-left">
                  {intl.formatMessage({ id: "chat.statusPanel.viewAllChanges" })}
                </span>
                <span className="shrink-0 text-ui-sm text-foreground-subtle">
                  {files.length || props.gitDirtyFileCount || 0}
                </span>
              </Button>
              {onRefreshGit ? (
                <div data-testid="status-git-current-branch">
                  <HostedGitBranchSwitcher
                    restoreFocusToTrigger
                    workspacePath={gitCwd ?? workspacePath}
                    gitSummary={gitSummary}
                    dirtyFileCount={files.length || props.gitDirtyFileCount || 0}
                    onRefreshGit={onRefreshGit}
                    onModalOpen={() => capsuleContext?.setOpen(null)}
                    className="min-w-0 w-full p-0"
                    triggerClassName="h-8 w-full justify-start gap-2 rounded-lg border-0 px-2 text-left text-ui-base [&_svg]:shrink-0 [&_[data-branch-switcher-primary-icon]]:text-foreground"
                    renderTriggerLabel={(label) => (
                      <span className="min-w-0 flex-1">
                        <StatusCapsuleTitle title={label} />
                      </span>
                    )}
                  />
                </div>
              ) : (
                <div
                  data-testid="status-git-current-branch"
                  title={branchLabel}
                  className="flex h-8 w-full min-w-0 items-center gap-2 px-2 text-ui-base"
                >
                  <GitBranchIcon className="size-4 shrink-0" />
                  <StatusCapsuleTitle title={branchLabel} />
                </div>
              )}
              {onRefreshGit ? (
                <GitActionMenu
                  workspacePath={gitCwd ?? workspacePath}
                  workspaceIdentity={workspaceIdentity}
                  gitSummary={gitSummary}
                  activeTaskChangeSummary={props.activeTaskChangeSummary ?? null}
                  onRefreshGit={onRefreshGit}
                  triggerLayout="status-row"
                />
              ) : null}
            </div>
          ) : null}
        </StatusCapsule>
      ) : null}
      {activities.length > 0 || endedActivities.length > 0 || hasHistoryEntry ? (
        <StatusCapsule
          id="activity"
          // 计数与实际渲染共用去重模型；已结束摘要不计入运行数。
          dataAttributes={{
            "data-background-bash-count": model.runningBashWorks.length,
            "data-background-workflow-count": model.runningWorkflowRuns.length,
            "data-background-subagent-count": model.runningSubagentWorks.length,
            "data-background-total-count": activities.length,
          }}
          icon={
            <span className="relative flex">
              {activityAvatars.length ? (
                <span className="isolate flex -space-x-1.5" aria-hidden="true">
                  {activityAvatars.map(([id, avatar], index) => (
                    // 徽标画在头像左下角；后一个头像整体置顶，保持自身徽标不被前一个头像挡住。
                    <span
                      key={id}
                      className="relative size-4 shrink-0"
                      style={{ zIndex: index + 1 }}
                    >
                      <WorkflowAgentFace
                        avatarIndex={undefined}
                        name={avatar.name}
                        color={avatar.color}
                        status={avatar.status}
                        result={avatar.result}
                        idle={avatar.result === "stopped"}
                        motionPaused={Boolean(avatar.result)}
                        outlineColor="var(--color-input)"
                        className="relative size-4 min-h-4! min-w-4!"
                      />
                    </span>
                  ))}
                </span>
              ) : (
                <MonitorActivityIcon className="size-4" aria-hidden="true" />
              )}
              {!activityAvatars.length && !activities.length && endedActivities.length > 0 ? (
                <svg
                  aria-hidden
                  className="pointer-events-none absolute bottom-0 left-0 size-4 overflow-visible"
                  viewBox="0 0 20 20"
                >
                  <AgentResultBadge result={activityResult} />
                </svg>
              ) : null}
            </span>
          }
          label={intl.formatMessage({ id: activityLabel })}
          secondary={
            activityCount ||
            (endedActivities.length > 0 && activityResult === "stopped"
              ? intl.formatMessage({ id: `chat.capsule.activity.${activityResult}` })
              : activityCount === null
                ? undefined
                : 0)
          }
        >
          <div className="max-h-72 overflow-y-auto">
            {[...activities, ...endedActivities].map((activity) => (
              <ul key={activity.id} data-activity-id={activity.id}>
                {activity.node}
              </ul>
            ))}
          </div>
          {hasHistoryEntry ? (
            <>
              <EndedDirectoryRow
                count={hasSubagentDirectory ? (props.endedSubagentCount ?? 0) : 0}
                icon={<SubagentCollectionIcon className="size-4 min-h-4! min-w-4!" />}
                label={intl.formatMessage({ id: "sidePane.subagentDirectory" })}
                testId="activity-subagent-directory"
                separated={activities.length + endedActivities.length > 0}
                onOpen={
                  parentSessionId && onOpenSubagentDirectory
                    ? () =>
                        onOpenSubagentDirectory?.({
                          parentSessionId,
                          rootSessionId: rootSessionId ?? parentSessionId,
                        })
                    : undefined
                }
              />
              <EndedDirectoryRow
                count={hasWorkflowDirectory ? (props.endedWorkflowRunCount ?? 0) : 0}
                icon={<WorkflowIcon className="size-4 shrink-0 text-foreground-subtle" />}
                label={intl.formatMessage({ id: "sidePane.workflowDirectory" })}
                testId="activity-workflow-directory"
                separated={activities.length + endedActivities.length > 0 && !hasSubagentDirectory}
                onOpen={
                  parentSessionId && onOpenWorkflowRunDirectory
                    ? () => onOpenWorkflowRunDirectory?.({ parentSessionId })
                    : undefined
                }
              />
            </>
          ) : null}
        </StatusCapsule>
      ) : null}
    </>
  );
}

export const ConversationStatusPanel = memo(ConversationStatusPanelImpl);
