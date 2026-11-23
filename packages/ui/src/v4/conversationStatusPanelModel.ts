import type { GitRepositorySummary } from "@zcode/shared";
import type {
  BackgroundWorkSummary,
  GoalState,
  PlanState,
  RunningSubagentSummary,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import type { SessionWorkflowPhaseSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  deriveSessionWorkflowPhases,
  workflowRunStepCounts,
} from "@zcode/shared/zcode-protocol-v4";

export interface ConversationStatusPanelGitModel {
  branchName: string | null;
  headRefType: GitRepositorySummary["headRefType"];
  dirtyFileCount: number;
  added: number;
  removed: number;
  ahead: number;
  behind: number;
  isClean: boolean;
}

export interface ConversationStatusPanelPlanModel {
  items: PlanState["items"];
  displayItems: PlanState["items"];
  completedCount: number;
  waitingCount: number;
  totalCount: number;
}

export interface ConversationStatusPanelRunningSubagent extends RunningSubagentSummary {
  stopControl?: { taskId: string; executionId: string };
}

/**
 * Workflows 分区的一行。
 *
 * 字段成三簇，因为三种事实各自可以缺席：`status` / `nodesSettled` / `nodesTotal` 来自
 * `workflowRuns` 投影；`title` / `startedAt` 是后台任务的静态元数据；`workId` /
 * `cancellable` 是 Stop 的前提，只在后台任务仍 running 时出现。**缺席用字段不存在表达，
 * 而不是 0 或空串**——渲染层据此决定这行有没有状态词/步数、有没有时长、能不能停，一个假
 * 的 0/0 会显示成「一步都没跑」。分簇的理由见 `buildRunningWorkflowRuns`。
 */
export interface ConversationStatusPanelWorkflowRun {
  /** 身份与 React key；偏斜降级行用 workId 顶替（两者本就 ≡）。 */
  runId: string;
  /** 缺席即该行不可点（没有可开的详情页 tab），与投影里 run 无 toolCallId 同义。 */
  toolCallId?: string;
  /** 有 run 支撑才有状态词；降级行没有。 */
  status?: "pending" | "running";
  nodesSettled?: number;
  nodesTotal?: number;
  /**
   * 站点表（声明序）与当前站，与侧栏运行行同一条推导（shared 的 `deriveSessionWorkflowPhases`）。
   * 与 `status` 同簇：有 run 支撑才有；降级行没有。空数组 = 脚本没声明阶段。
   */
  phases?: SessionWorkflowPhaseSummary[];
  currentPhase?: string;
  /**
   * 展示名。**`title ≡ workId` 即「未命名」**，渲染层据此换成 i18n 兜底名：core 的
   * `workflowTaskSubject` 兜底链最终落到 taskId（≡ runId ≡ workId），而投影把非空
   * description 原样抄进 title——所以「题名恰好等于 id」是唯一可靠的未命名信号。
   * 模型不做这个替换（i18n 不属于模型层），只保证 title 原样透出。
   */
  title?: string;
  startedAt?: number;
  /** 停止按钮要的控制句柄；只在 work 仍 running 时出现（已结束的 work 没有可取消的东西）。 */
  workId?: string;
  cancellable?: boolean;
}

/**
 * 「打开哪个 run 的详情页」的意图。会话与 workspace 身份由宿主补齐，面板不感知 scope
 * （与工具卡走同一个 handler，不存在第二条打开路径）。
 *
 * 组件层从模型取得打开意图类型，不反向依赖。
 */
export interface ConversationStatusPanelWorkflowRunTarget {
  runId: string;
  toolCallId: string;
  workflowName?: string;
}

/**
 * 面板行 → 打开意图。无 `toolCallId` 即 null（没有可开的详情页 tab）。名字只在真有时带上：
 * `title ≡ runId` 是未命名 run 的兜底样子（core 的 workflowTaskSubject 落到 taskId），把 runId
 * 冻进 tab 标签比通用兜底名更糟。面板行使用这一处换算。
 */
export function workflowRunOpenTarget(
  run: ConversationStatusPanelWorkflowRun,
): ConversationStatusPanelWorkflowRunTarget | null {
  if (!run.toolCallId) return null;
  return {
    runId: run.runId,
    toolCallId: run.toolCallId,
    ...(run.title && run.title !== run.runId ? { workflowName: run.title } : {}),
  };
}

export interface ConversationStatusPanelModel {
  hasContent: boolean;
  git: ConversationStatusPanelGitModel | null;
  goal: GoalState | null;
  plan: ConversationStatusPanelPlanModel | null;
  runningBashWorks: BackgroundWorkSummary[];
  runningSubagentWorks: ConversationStatusPanelRunningSubagent[];
  runningWorkflowRuns: ConversationStatusPanelWorkflowRun[];
}

export interface BuildConversationStatusPanelModelInput {
  isOfficeMode?: boolean;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  goal?: GoalState | null;
  plan?: PlanState | null;
  backgroundWorks?: readonly BackgroundWorkSummary[];
  runningSubagents?: readonly ConversationStatusPanelRunningSubagent[];
  workflowRuns?: readonly WorkflowRunState[];
}

function buildGitModel({
  gitSummary,
  gitDirtyFileCount = 0,
  gitWorktreeChangeSummary,
}: Pick<
  BuildConversationStatusPanelModelInput,
  "gitSummary" | "gitDirtyFileCount" | "gitWorktreeChangeSummary"
>): ConversationStatusPanelGitModel | null {
  if (!gitSummary?.isGitAvailable || !gitSummary.isRepository) {
    return null;
  }
  const added = gitWorktreeChangeSummary?.added ?? 0;
  const removed = gitWorktreeChangeSummary?.removed ?? 0;
  // v4 之前只要是 Git repository 就创建 Git model，导致 clean repo
  // 也挂出右上角状态卡；旧 ChatView 只在 worktree 有行级变化时展示 Git Tools。
  if (added + removed <= 0) {
    return null;
  }
  const isClean =
    !gitSummary.isDirty &&
    gitDirtyFileCount === 0 &&
    added === 0 &&
    removed === 0 &&
    gitSummary.ahead === 0;

  return {
    branchName: gitSummary.branchName,
    headRefType: gitSummary.headRefType,
    dirtyFileCount: gitDirtyFileCount,
    added,
    removed,
    ahead: gitSummary.ahead,
    behind: gitSummary.behind,
    isClean,
  };
}

function buildPlanModel(plan: PlanState | null | undefined) {
  if (!plan || plan.items.length === 0) {
    return null;
  }
  const completed = plan.items.filter((item) => item.status === "completed");
  return {
    items: plan.items,
    // 按状态重新分组会让 Todo 完成时从原位置跳到列表末尾，破坏 TodoWrite
    // snapshot 的权威顺序。这里完整保留原数组，只由 renderer 负责滚动和状态样式。
    displayItems: plan.items,
    completedCount: completed.length,
    waitingCount: plan.items.length - completed.length,
    totalCount: plan.items.length,
  };
}

/**
 * Workflows 分区：活动 run 与 workflow 后台任务按 **workId ≡ runId** 联接。
 *
 * 这条等式不是猜的，是 schema 上写明的既有事实（`backgroundWorkSummarySchema` 的
 * kind 注释与 `backgroundResultOriginMetaSchema` 的 "workflow" 注释）；所以联接用主键
 * 直接对上，不需要 Agent 行那套「重复身份宁可不显示」的消歧。
 *
 * 两侧各自可以单方面缺席，缺席的处理按**字段含义**分簇，而不是按 work 的 status 一刀切：
 * - `title` / `startedAt` 是静态元数据，work 无论什么 status 都取。work 走到 resultPending
 *   时若一并丢掉它们，run 还在跑的那一行会当场闪成 i18n 兜底名并失去时长——纯视觉故障。
 * - `workId` / `cancellable` 是 Stop 的前提，**只在 work 仍 running 时给**：已结束的 work
 *   没有可取消的东西，留着按钮就是一个点了没反应的 Stop。
 * - run 有、work 全无：仍成行（状态词与步数是投影自己的事实），只是没有题名/时长/Stop。
 * - work 有、run 无：说明 CLI 老到不发 `workflowRuns` 投影键。降级成只有题名/时长/Stop
 *   的一行，**追加在 run 支撑的行之后**——它没有启动序上的位置，插进中间等于编造顺序。
 *   这条兜底的全部理由是：**cancel 入口在任何偏斜下都不许消失**；因此降级行只收 running
 *   的 work——既没有 run、work 也已结束的那条没有任何可操作的东西，显示它就是一条死行。
 */
function buildRunningWorkflowRuns(
  runs: readonly WorkflowRunState[] | undefined,
  workflowWorkByWorkId: ReadonlyMap<string, BackgroundWorkSummary>,
): ConversationStatusPanelWorkflowRun[] {
  const rows: ConversationStatusPanelWorkflowRun[] = [];
  const joinedWorkIds = new Set<string>();
  for (const run of runs ?? []) {
    // pending 也是活动态：run 已经起跑、只是还没派发第一个节点，藏起来等于让用户
    // 在「工作流启动了」和「面板出现它」之间看到一段空窗。
    if (run.status !== "pending" && run.status !== "running") continue;
    const work = workflowWorkByWorkId.get(run.runId);
    if (work) joinedWorkIds.add(run.runId);
    // 计数与聊天紧凑卡同源（唯一实现在 @zcode/shared 的 workflowRunStepCounts：表内 + 表外）。
    const steps = workflowRunStepCounts(run);
    rows.push({
      runId: run.runId,
      ...(run.toolCallId ? { toolCallId: run.toolCallId } : {}),
      status: run.status,
      nodesSettled: steps.settled,
      nodesTotal: steps.total,
      phases: deriveSessionWorkflowPhases(run),
      ...(run.currentPhase === undefined ? {} : { currentPhase: run.currentPhase }),
      ...(work ? { title: work.title, startedAt: work.startedAt } : {}),
      ...(work?.status === "running"
        ? {
            workId: work.workId,
            // 缺省即可停，与 Agent 行同款 `!== false`：能停而不给按钮比反过来更糟。
            cancellable: work.cancellable !== false,
          }
        : {}),
    });
  }
  // 顺序 = 投影 runs 序 = 启动序，模型不排序；重排会让面板行在每次投影更新时跳位。
  for (const [workId, work] of workflowWorkByWorkId) {
    if (joinedWorkIds.has(workId) || work.status !== "running") continue;
    rows.push({
      runId: workId,
      workId,
      title: work.title,
      startedAt: work.startedAt,
      cancellable: work.cancellable !== false,
    });
  }
  return rows;
}

export function buildConversationStatusPanelModel(
  input: BuildConversationStatusPanelModelInput,
): ConversationStatusPanelModel {
  const git = input.isOfficeMode ? null : buildGitModel(input);
  const goal = input.goal ?? null;
  const plan = buildPlanModel(input.plan);
  const runningBashWorks: BackgroundWorkSummary[] = [];
  const workflowWorkByWorkId = new Map<string, BackgroundWorkSummary>();
  for (const work of input.backgroundWorks ?? []) {
    if (work.kind === "workflow") {
      // "workflow"（workflow run）曾与 bash 同列在 Terminals 下，那是保住停止入口的已记录错标；
      // 现在它有自己的 Workflows 分区，于是**只**按 workId ≡ runId 进 workflow 联接表。
      // 留在 runningBashWorks 里就是让同一个 run 在两个分区各出现一次。
      //
      // 这一支**收在 running 闸门之前**：题名与启动时刻对已结束的 work 依然有效（见
      // buildRunningWorkflowRuns 的分簇说明），status 的判断留到那里按字段做。workId 是
      // 主键，重复即上游损坏，不做消歧。
      workflowWorkByWorkId.set(work.workId, work);
      continue;
    }
    if (work.status !== "running") continue;
    if (work.kind === "bash") {
      runningBashWorks.push(work);
    }
  }
  // 子智能体的 Stop 资格由 running 投影显式给出；旧 backgroundWorks 可能滞后或缺行，
  // 用 childSessionId 联接会把另一条任务的控制柄误挂到目录行上。
  const runningSubagentWorks = [...(input.runningSubagents ?? [])];

  const runningWorkflowRuns = buildRunningWorkflowRuns(input.workflowRuns, workflowWorkByWorkId);

  return {
    git,
    goal,
    plan,
    runningBashWorks,
    runningSubagentWorks,
    runningWorkflowRuns,
    hasContent: Boolean(
      git ||
      goal ||
      plan ||
      runningBashWorks.length > 0 ||
      runningSubagentWorks.length > 0 ||
      runningWorkflowRuns.length > 0,
    ),
  };
}
