// ============================================================
// Dynamic Workflow Run 的观察面辅助（run service 的只读半身）
// ============================================================
// 快照/列表/详情的合成规则。从 dynamic-workflow-run-service.ts 拆出：服务文件承载入口与门，
// 本文件承载「registry + journal → 对外读面」的纯合成规则（无 I/O、无状态）。

import type { DwfRunListItem, DwfRunSessionListItem } from "@zcode/adapters/storage";
import {
  boundDynamicWorkflowRunEventPayload,
  DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES,
  DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS,
  type DynamicWorkflowRunError,
  type DynamicWorkflowRunHole,
  type DynamicWorkflowRunLogEntry,
  type DynamicWorkflowRunPendingQuestion,
  type DynamicWorkflowRunSessionSummary,
  type DynamicWorkflowRunSnapshot,
  type DynamicWorkflowRunStopReason,
  type DynamicWorkflowRunSummary,
} from "@zcode/contracts";
import type {
  JournalStorePort,
  RunRecord,
  RunSettlement,
  RunStatus,
  RunStopReason,
  StoredEvent,
  WorkflowErrorCode,
  WorkflowErrorJson,
} from "@zcode/dynamic-workflow";
import { artifactsOf } from "./dynamic-workflow-run-artifact-projection.js";
import { runLineageActiveMs } from "./dynamic-workflow-run-elapsed.js";
import {
  readRunModelBindings,
  readRunScriptPath,
  readRunSubagentModel,
} from "./dynamic-workflow-run-launch-anchor.js";
import { resolveDynamicWorkflowRunLabel } from "./dynamic-workflow-run-label.js";
import { lineageFields, supersededByOf } from "./dynamic-workflow-run-lineage.js";
import type { CompiledHole } from "./dynamic-workflow-run-holes.js";
import type { ActorSessionQuiescence } from "./workflow-driver-quiescence.js";
import type { WorkflowRunControl } from "./workflow-run-control.js";

/**
 * 产物归并住在 dynamic-workflow-run-artifact-projection.ts（本文件顶到 oxlint 的 400 行上限）。
 * 原样再导出而不是让四个调用点各改 import：它们找的是「观察面」，而这次拆分是行数约束的结果、
 * 不是边界的变化——把它变成一次跨模块改名，只会让 git blame 指向一个与意图无关的提交。
 */
export { artifactsOf };

/** 注册表条目：一个在飞或近期结算的 run。 */
export interface RunRegistryEntry {
  controller: AbortController;
  startedAt: Date;
  toolCallId?: string;
  parentSessionId?: string;
  /**
   * 三个 submit 时元数据的内存副本，只服务于 **submit → createRun 的微任务间隙**：那一刻
   * journal 里还没有行，而枚举面必须能把这个 run 按项目过滤（cwd）并给出标签（name /
   * 脚本首行）。行一旦出现，journal 就是这三者的权威，内存副本不再被读。
   */
  cwd: string;
  name?: string;
  scriptText: string;
  /**
   * 本 run 实际生效的并发上界（`dwf_run.caps_max_concurrency` 的内存副本，同一条间隙论证）。
   * submit / amend 落值，**resume 不落**——那条路沿用 journal 记录里的 caps，而它的行早就在了。
   */
  maxConcurrency?: number;
  /**
   * 本 run 的活体控制面（docs/dynamic-workflow/concurrency.md「The control path」）。与
   * {@link controller} 并列而非合并：那个是「停下这个 run」的唯一通道，这个是「改这个 run 的一项
   * 设置」的唯一通道，两者的收件人（harness 的 signal / 引擎与座位闸门）也不是同一个。
   *
   * 三条建条目的路都造一个（submit / amend / resume），launch 把它的两端接上。条目在、句柄的
   * `setMaxConcurrency` 却回 false，就是「run 在这两步之间结算了」——`retuneConcurrency` 据此
   * 回 `not_live`。
   */
  control?: WorkflowRunControl;
  /**
   * 本 run 的子代理模型（`run-launched` 事件上那个规范 picker 串
   * `providerId/modelId[$reasoningLevel]` 的内存副本）。
   * 同一条间隙论证：`AmendWorkflow` 的 resolveInput 读快照判「沿用什么」，而修订一个刚起步的
   * run 恰好落在 submit → 引擎记事件的那几个微任务里。
   *
   * **三条建条目的路都落值**：submit / amend 用刚归一出来的那个串，resume 读一次事件头抄过来。
   * 值在建 run 那一世写死、本 run 余生不变，所以副本与事件不可能分叉——读面因此只剩一条规则：
   * 有条目就读条目，只有冷行（本进程没有条目）才去扫事件。缺席即子代理跑在会话模型上。
   */
  subagentModel?: string;
  /**
   * 本 run 脚本点名的模型绑定表（`run-launched` 事件上 `modelBindings` 的内存副本；
   * docs/dynamic-workflow/launch.md「Models the script names」）。与 {@link subagentModel} 逐条同规：
   * 三条建条目的路都落值、余生不变，有条目就读条目。缺席即脚本没点名模型。
   */
  modelBindings?: Record<string, string>;
  /**
   * 本 run 的脚本文件（`run-launched` 事件上那个绝对路径的内存副本）。与 {@link subagentModel} 逐条同规：
   * 三条建条目的路都落值（submit / amend 用入参给的那一个，resume 读一次事件头抄过来），
   * 值在建 run 那一世写死、余生不变，所以副本与事件不可能分叉。缺席即这个 run 没有文件。
   */
  scriptPath?: string;
  /** 修订 run 的前驱（`dwf_run.resumed_from` 的内存副本，journal 行出现之前枚举面唯一能读到的地方）。 */
  resumedFrom?: string;
  /**
   * **此刻有效脚本**的留白事实表（docs/execution-engine.md「Holes」）：快照的 `type` / `line` 与
   * 进度载荷的 `type` 读它。三条建条目的路都从编译产物落值；一次补全把它换成有效脚本的表——
   * 嵌套在函数体里的新留白由此出现。与 `scriptText` 同步换，两者描述的必须是同一份脚本。
   */
  holes?: readonly CompiledHole[];
  /**
   * 此刻生效的阶段表（留白按名字占位）：submit / amend 抄提交方给的声明表，resume 从事件读回，
   * 补全后换成有效脚本的表（引擎在 `hole-filled` 上记的同一张）。快照的 before / after 读它。
   */
  phaseNames?: readonly string[];
  /**
   * 本 run 的用量起点（前驱结算后的 `spentTokens`）。同一条间隙论证：行落库之前两条读面只能从条目读用量，而修订
   * 一个刚起步的 run 恰好落在那几个微任务里。**只有 amend 路落值**：全新 submit 从零起账，
   * resume 的行早就在了。
   */
  inheritedTokens?: number;
  /**
   * 本 run 的 driver 交出来的**会话静默探针**（workflow-driver-quiescence.ts）。driver 构造时
   * 回填，所以刚建好的条目上还没有——那个间隙里这个 run 连一个 actor 会话都还没建，问它也无话可说。
   *
   * 唯一的读者是 amend：取代一个在飞前驱之后，它要先确认那些会话已经写完，才谈得上接续那条
   * 未完的 ask（`inFlight`）。探针的所有权就在这个条目上——一个 run 一份，随 driver 生灭，
   * 不另立进程级注册表。
   */
  quiescence?: ActorSessionQuiescence;
  /** 结算 promise；waitForTask 等它。fire-and-forget 的那条链就挂在这里。 */
  settlement: Promise<RunSettlement>;
  /** 已结算时的终态（产物/错误只在这里，journal 不存脚本返回值）。 */
  terminal?: RunSettlement;
  completedAt?: Date;
  /**
   * 已经为这个条目记过一次「journal 行是外来终态」的日志（见 {@link synthesizeRunStatus} 的
   * 优先级说明）。追踪器每秒轮询一次，不记这个标记就会每秒一条同样的 warn。
   */
  foreignTerminalLogged?: true;
}

/**
 * run 的终态集（不含 pending / running）。
 * 这里是「什么算终态」的**唯一权威**：journal 侧的 SQL 只做索引友好的预筛，收敛前按本集合
 * 再判一次，好让将来新增一个非终态状态时只有这一处要改。
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "errored",
  "stopped",
]);

/**
 * 由 journal 记录 + 活注册表合成快照。两者都没有该 run 时返回 undefined（上层归一成 lost）。
 *
 * `pendingQuestions` 由调用方从**内存的**升级停驻表投影好再传进来（本文件的纪律是无 I/O、
 * 无状态）。传空数组即「此刻没有待答问题」，字段整个缺席——不发空数组。
 *
 * `defaultConcurrency` 同理由调用方给（读它要探进程核数 = I/O）：缺席即「本次读不判默认值」，
 * `maxConcurrency` 整字段不出——见 {@link runConcurrencyField}。
 */
/** run 的引擎是否在本进程手里：`fillHole` 的放行判定与快照的 `liveInThisProcess` 共用这一条。 */
export function isRunLiveInThisProcess(
  entry: RunRegistryEntry | undefined,
): entry is RunRegistryEntry & { control: NonNullable<RunRegistryEntry["control"]> } {
  return entry !== undefined && entry.terminal === undefined && entry.control !== undefined;
}

export function snapshotOf(
  taskId: string,
  runs: Map<string, RunRegistryEntry>,
  journal: JournalStorePort,
  pendingQuestions: readonly DynamicWorkflowRunPendingQuestion[] = [],
  defaultConcurrency?: number,
  /**
   * 留白（docs/execution-engine.md「The run snapshot」），与 `pendingQuestions` 同规由调用方
   * 投影好递进来（`waiting` 要读引擎的停驻表，那是 I/O 之外的活状态）；空即整字段缺席。
   */
  holes: readonly DynamicWorkflowRunHole[] = [],
): DynamicWorkflowRunSnapshot | undefined {
  const entry = runs.get(taskId);
  const record = journal.getRun(taskId);
  if (entry === undefined && record === undefined) return undefined;

  // 状态合成的唯一实现（见 {@link synthesizeRunStatus}）。快照面的词汇表没有 pending，
  // 所以在最后一步折叠：runStatusToTaskStatus 把 pending 与 running 一起报成 running——
  // 这正是"在注册表里就是在跑"的既有行为（缺了它，刚 submit 的 run 第一次轮询就被判成 lost）。
  const status: DynamicWorkflowRunSnapshot["status"] = runStatusToTaskStatus(
    synthesizeRunStatus(entry, record?.status),
  );

  // reports / artifacts / 活动时长只在终态取数：它们的唯一消费者是终态通知与终态 TaskOutput，
  // 而快照被后台追踪器反复轮询——在飞时读它们没有读者，只有成本。
  const settled = status !== "running";

  // lineage 的活动时长（docs/dynamic-workflow/transcript-and-notifications.md「How long it took」）。
  const activeDurationMs = settled ? runLineageActiveMs(journal, taskId) : undefined;

  // 真实终态词 + 停止原因 + 结构化失败（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）：快照基类的
  // `status` 是后台任务追踪器的通用词汇（stopped 折成 cancelled、errored 折成 failed），通知
  // 要说真话只能读这三个字段。终态之前不带（还没有可说的终局）。
  const runStatus = synthesizeRunStatus(entry, record?.status);
  const terminal = TERMINAL_RUN_STATUSES.has(runStatus);
  const stopReason = terminal ? stopReasonOf(entry, record) : undefined;
  const failure = terminal ? terminalErrorField(runStatus, entry, record).error : undefined;
  const error = failure?.message;
  // 归属：AmendWorkflow 的
  // resolveInput 读快照判「是不是本会话的 run」；lineage 两端指针见 lineageFields。
  const parentSessionId = entry?.parentSessionId ?? record?.parentSessionId;
  // run 自己的名字：行一旦落库 journal 就是权威，只在 submit → createRun 的间隙读注册表副本。
  // 这里曾漏掉 name，GUI「配置」（dynamic-workflow-run-settings.ts）读快照取名永远是空，
  // 设置轮文字、合成的 AmendWorkflow 与后继 run 的通知都退成了 run id（launch.md「The settings turn」）。
  const name = record?.name ?? entry?.name;

  return {
    runId: taskId,
    taskId,
    startedAt: entry?.startedAt ?? new Date(0),
    status,
    ...(name === undefined ? {} : { name }),
    ...(terminal ? { runStatus } : {}),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(terminal ? {} : { liveInThisProcess: isRunLiveInThisProcess(entry) }),
    ...lineageFields(entry?.resumedFrom ?? record?.resumedFrom, supersededByOf(entry, record)),
    // 内存副本优先于 journal，与上面每一个间隙字段同规：submit → createRun 的那几个微任务里
    // 行还不存在，而 AmendWorkflow 的 resolveInput 恰好会在那时读这张快照。
    ...runConcurrencyField(
      entry?.maxConcurrency ?? record?.caps.maxConcurrency,
      defaultConcurrency,
    ),
    // 子代理模型：**有条目就读条目**（三条建条目的路都落值，见 RunRegistryEntry.subagentModel），
    // 只有冷行——本进程没有条目——才去扫一次事件头（八条的有界扫描，不是整条 journal）。
    // 它没有并发上界那道「值不值得一提」的判据：只在用户显式设过时才存在，在场本身就是全部
    // 的信息。缺席即跑在会话模型上。
    ...runSubagentModelField(
      entry === undefined ? readRunSubagentModel(journal, taskId) : entry.subagentModel,
    ),
    // 脚本文件：与子代理模型逐条同规（有条目就读条目，只有冷行才扫一次事件头），同样
    // 「记过才在场」。终态通知据它把下一步说成「就地编辑那个文件」，所以快照必须带上它。
    ...runScriptPathField(
      entry === undefined ? readRunScriptPath(journal, taskId) : entry.scriptPath,
    ),
    // 脚本点名的模型：与子代理模型逐条同规。AmendWorkflow 与 GUI「配置」据它让同名的绑定沿用下去。
    ...runModelBindingsField(
      entry === undefined ? readRunModelBindings(journal, taskId) : entry.modelBindings,
    ),
    ...(failure === undefined ? {} : { failure }),
    ...(activeDurationMs === undefined ? {} : { activeDurationMs }),
    ...(entry?.completedAt === undefined ? {} : { completedAt: entry.completedAt }),
    ...(error === undefined ? {} : { error }),
    // 零条时整字段缺席（与 reports 同规）：读侧据此让整块 pending 区消失，不渲染空节。
    ...(pendingQuestions.length === 0 ? {} : { pendingQuestions }),
    ...(holes.length === 0 ? {} : { holes }),
    ...(settled ? reportsOf(taskId, journal) : {}),
    // 用户面产物。⚠ 与紧邻的 `output`
    // （`entry.terminal.artifact` = 脚本顶层返回值，引擎内部也叫 artifact）是**两件不同的东西**：
    // 这里是脚本经 `artifact.*` 发布给用户看的产出，那里是给模型看的返回值。
    ...(settled ? artifactsOf(taskId, journal) : {}),
    ...(entry?.terminal?.status === "completed"
      ? { output: entry.terminal.artifact }
      : // 重启后本进程的注册表是空的，产物只能从 journal 记录取（migration 0020 的
        // result_json）。内存终态在上一支里优先——它是本进程刚从引擎手里接过的原值。
        record?.status === "completed" && record.result !== undefined
        ? { output: record.result }
        : {}),
  };
}

/**
 * 两条读面（`getTask` 快照与 `getRunDetail` 详情）上的 `maxConcurrency`
 *
 * **只在不等于默认并发时在场**（高于、低于都算）：跑在默认值上的 run 没有可说的——它就是默认
 * 行为，而每一行都带一个等于默认值的数，只会让模型把「没设限」读成「设了个限」。默认值缺席（调用方
 * 没给）时同样整字段不出：判据都没有，报一个数就是在猜。
 *
 * 一处实现供两条读面共用：两处各判一次，「等于默认算不算在场」迟早会在某一次调参时分叉。
 */
export function runConcurrencyField(
  applied: number | undefined,
  defaultConcurrency: number | undefined,
): { maxConcurrency?: number } {
  if (applied === undefined || defaultConcurrency === undefined || applied === defaultConcurrency) {
    return {};
  }
  return { maxConcurrency: applied };
}

/**
 * 两条读面（`getTask` 快照与 `getRunDetail` 详情）上的 `subagentModel`
 *
 * 规则只有一条：**设过才在场**。与 {@link runConcurrencyField} 不同，这里没有可比的默认值——
 * 「跑在会话模型上」不是一个能写进这个字段的字符串，而把当前会话模型填进去会让读侧把「没设」
 * 读成「设了，正好等于会话模型」，两者在 amend 的三态里是不同的意思。
 *
 * 一处实现供两条读面共用，与并发上界同一条论证。
 */
export function runSubagentModelField(subagentModel: string | undefined): {
  subagentModel?: string;
} {
  return subagentModel === undefined ? {} : { subagentModel };
}

/** 两条读面上的 `modelBindings`：与 {@link runSubagentModelField} 同一条规则，记过（且非空）才在场。 */
export function runModelBindingsField(modelBindings: Record<string, string> | undefined): {
  modelBindings?: Record<string, string>;
} {
  return modelBindings === undefined || Object.keys(modelBindings).length === 0
    ? {}
    : { modelBindings };
}

/**
 * 两条读面上的 `scriptPath`。规则与
 * {@link runSubagentModelField} 逐字相同：**记过才在场**，没有可比的默认值——「这个 run 没有
 * 脚本文件」不是一个能写进这个字段的路径，而填一个猜出来的路径会让模型去编辑一个与本 run
 * 无关的文件。一处实现供两条读面共用。
 */
export function runScriptPathField(scriptPath: string | undefined): { scriptPath?: string } {
  return scriptPath === undefined ? {} : { scriptPath };
}

/**
 * 终态快照上的 `reports` 与 `reportCount`：journal 里 `kind = "report"` 的节点行（一次写入、恒
 * `completed`、被报告的 item 就在 `result` 上），按插入顺序 = 报告顺序。
 *
 * 为什么从 journal 读而不是从投影读：`workflowRuns.reports` 是有界的 memory-only 展示面
 * （冷恢复后为空），而这些行是那些条目的**持久家**。完成通知要在 failed / cancelled 上
 * 一样携带产物——一个死在第 12 个 ask 上的 run 仍然做完了 11 个 ask 的活，捞回它正是
 * `report` 存在的理由——所以它读的必须是持久那一份。
 *
 * 只读前 {@link DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS} 条、至多
 * {@link DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES} 字节的 item，总数是一次 `count(*)`
 * （docs/execution-engine.md「Reading the journal」）。修复原因：此前这里把整张节点表连同每条
 * report item 读进内存——一个报满的 run 在结算那一刻要解码 GiB 量级的 item，而通知那一节的
 * 字符预算只容得下几十条。条数界单独也不够：单条上限 1 MiB 时 256 条就是 256 MiB。零条时两个
 * 字段都缺席：通知端据此让整节 `<reports>` 消失，不发空节。
 */
function reportsOf(
  taskId: string,
  journal: JournalStorePort,
): { reports?: readonly unknown[]; reportCount?: number } {
  const reportCount = journal.countNodes(taskId, "report");
  if (reportCount === 0) return {};
  const reports = journal
    .listNodes(taskId, {
      kinds: ["report"],
      withResult: true,
      limit: DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS,
      maxResultBytes: DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES,
    })
    .map((node) => node.result);
  return { reports, reportCount };
}

/**
 * **状态真相合成的唯一实现**，优先级四档：
 *   内存终态 > 活条目（journal 状态只在非终态时采信）> journal 状态 > 「在注册表里但还没有行」。
 *
 * 本进程引擎仍存活时，journal 中的终态行可能来自另一实例的孤儿收敛，不能据此结束本地追踪。
 * 本地已结算时优先使用内存终态；第二档处理尚未结算的活条目，忽略外部终态行并等待引擎结算，
 * 避免提前通知模型、标完任务后丢弃真正的完成结果。
 *
 * 三个读面（快照、列表、详情）共用它。之所以返回 journal 的 {@link RunStatus} 词汇表而不是
 * 快照的：那一档最细——`pending`（已提交、引擎还没建行）在内省面上是模型看得懂的区别，而
 * 快照面把它折进 `running` 只是它自己的词汇表限制（{@link runStatusToTaskStatus} 负责折叠）。
 * 反过来（先折叠再想办法还原）就得在下游猜"这个 running 到底是哪一种"。
 */
function synthesizeRunStatus(
  entry: RunRegistryEntry | undefined,
  journalStatus: RunStatus | undefined,
): RunStatus {
  // 内存终态优先：本进程刚从引擎手里接过的结算，比 journal 行（可能还没写完）更新。
  if (entry?.terminal !== undefined) return terminalRunStatus(entry.terminal);
  // 走到这里 `entry !== undefined` 即「本服务持有的活 run」：行上的终态只可能是外来写入，
  // 忽略它、照实说在跑。非终态的行（pending / running）照常采信——它们本就是引擎自己写的。
  // 刻意只拦终态：`journalStatus` 缺席的间隙仍要落到下面的 `pending`（那一档更细，
  // 且内省面把它当成模型看得懂的区别）。
  if (
    entry !== undefined &&
    journalStatus !== undefined &&
    TERMINAL_RUN_STATUSES.has(journalStatus)
  ) {
    return "running";
  }
  if (journalStatus !== undefined) return journalStatus;
  // 注册表有、journal 无：submit → createRun 的微任务间隙。`pending` 是这一刻**唯一诚实**的
  // 状态——run 已被接受，但引擎还没落下任何一行。
  return "pending";
}

function terminalRunStatus(settlement: RunSettlement): RunStatus {
  switch (settlement.status) {
    case "completed":
      return "completed";
    case "stopped":
      return "stopped";
    default:
      return "errored";
  }
}

/**
 * 逻辑终态 → 后台任务追踪器的通用词汇。追踪器（与 bash / subagent 任务共用）不认识
 * stopped / errored：stopped 折成 `cancelled`、errored 折成 `failed`；真实词经快照的
 * `runStatus` / `stopReason` 另行透出。
 */
function runStatusToTaskStatus(status: RunStatus): DynamicWorkflowRunSnapshot["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "errored":
      return "failed";
    case "stopped":
      return "cancelled";
    // pending / running 都还在跑。
    default:
      return "running";
  }
}

/**
 * 停止原因：内存终态优先（本进程刚从引擎手里接过的结算），其次 journal 行。只对 stopped 有意义；
 * 其余状态返回 undefined。
 *
 * 与 {@link synthesizeRunStatus} 同一条优先级：**活条目下没有停止原因**。行上写着一个，只能是
 * 外来写入，而三个读面必须给出同一个答案——状态说「在跑」、
 * 原因却说「被打断了」，比两者都错更难查。
 */
function stopReasonOf(
  entry: RunRegistryEntry | undefined,
  record: { status?: RunStatus; stopReason?: RunStopReason } | undefined,
): DynamicWorkflowRunStopReason | undefined {
  if (entry?.terminal !== undefined) {
    return entry.terminal.status === "stopped" ? entry.terminal.reason : undefined;
  }
  if (entry !== undefined) return undefined;
  if (record?.status === "stopped") return record.stopReason ?? "user";
  return undefined;
}

/**
 * journal 行（+ 可选的内存条目）→ 列表与详情的共同截面。
 *
 * 时间戳**直读 journal 行**，刻意绕开 {@link snapshotOf} 的 `new Date(0)` 兜底：内存条目被
 * 逐出后那个起始时间是假的，而内省面的时间是模型据以判断"多久以前"的依据。
 */
export function journalRunSummary(
  row: DwfRunListItem,
  entry: RunRegistryEntry | undefined,
  ownerSessionId: string,
): DynamicWorkflowRunSummary {
  const ownedByThisSession = entry !== undefined || row.parentSessionId === ownerSessionId;
  // 读的是 **journal 的** status 而不是合成后的：语义就是「journal 说它还没结束，而本会话
  // 无法证实」。（这个分支上两者必然相等——非本会话、不在注册表，就没有内存终态可以覆盖
  // journal——按字面写是为了将来新增真相源时这条断言依然成立。）
  const possiblyInterrupted = !TERMINAL_RUN_STATUSES.has(row.status) && !ownedByThisSession;
  const stopReason = stopReasonOf(entry, row);
  return {
    runId: row.runId,
    ...resolveDynamicWorkflowRunLabel({
      runId: row.runId,
      ...(row.name === undefined ? {} : { name: row.name }),
      ...(row.scriptText === undefined ? {} : { scriptText: row.scriptText }),
    }),
    status: synthesizeRunStatus(entry, row.status),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...lineageFields(entry?.resumedFrom ?? row.resumedFrom, supersededByOf(entry, row)),
    ownedByThisSession,
    // 为真时才在场：缺席读作「没有这个疑虑」，而 `false` 会让每一行都带一个噪音字段。
    ...(possiblyInterrupted ? { possiblyInterrupted: true } : {}),
    createdAt: row.timeCreated,
    updatedAt: row.timeUpdated,
  };
}

/**
 * 只有内存条目的 run（submit → createRun 的微任务间隙）→ 共同截面。
 *
 * 归属恒为真（它就在本会话的注册表里），因此也永远不带 `possiblyInterrupted`。时间戳取自
 * 注册时刻——这不是兜底猜测，而是这个 run 真实的提交时间（journal 行落下时写的是同一毫秒级
 * 的 `Date.now()`）。
 */
export function registryRunSummary(
  runId: string,
  entry: RunRegistryEntry,
): DynamicWorkflowRunSummary {
  return {
    runId,
    ...resolveDynamicWorkflowRunLabel({
      runId,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      scriptText: entry.scriptText,
    }),
    status: synthesizeRunStatus(entry, undefined),
    ...(entry.terminal?.status === "stopped" ? { stopReason: entry.terminal.reason } : {}),
    ...lineageFields(entry.resumedFrom, supersededByOf(entry, undefined)),
    ownedByThisSession: true,
    createdAt: entry.startedAt.getTime(),
    updatedAt: (entry.completedAt ?? entry.startedAt).getTime(),
  };
}

/**
 * completed 的 run 才带产物，且 `undefined` 产物 = **整字段缺席**（与完成通知同规）。
 *
 * 优先级同 {@link snapshotOf}：内存终态的 artifact 是本进程刚从引擎手里接过的**原值**，
 * journal 的 result_json 是它经过一次 JSON 往返后的形态；条目被逐出后才退到后者。
 * 值本身**原样交出、不序列化**——面向模型的文本投影在 core 有唯一实现，端口再做一次就会
 * 出现「同一个产物在通知里和在工具里长得不一样」。
 */
export function terminalResultField(
  status: RunStatus,
  entry: RunRegistryEntry | undefined,
  row?: { result?: unknown },
): { result?: unknown } {
  if (status !== "completed") return {};
  if (entry?.terminal?.status === "completed" && entry.terminal.artifact !== undefined) {
    return { result: entry.terminal.artifact };
  }
  // `result: null` 是合法产物（`ask<T | null>` 会返回它），所以判据是 `!== undefined`
  // 而不是真值性——解码侧同样只在列非 NULL 时才写出这个键。
  return row?.result === undefined ? {} : { result: row.result };
}

/**
 * errored 恒带失败；stopped 只对 provider / interrupted 带（user / model 停下没有失败可言）。
 * journal 的 `failure_json` 是**权威**：它带结构化 code，`Interrupted`（进程死了）、
 * `ProviderStop`（模型侧确定性错误）与 `DriverError`（脚本真失败）因此可以被模型分辨——所以
 * 这里原样透出 code，绝不折叠成一个通用失败；`ProviderStop` 的结构化明细一并透出。
 */
export function terminalErrorField(
  status: RunStatus,
  entry: RunRegistryEntry | undefined,
  row?: { failure?: WorkflowErrorJson },
): { error?: DynamicWorkflowRunError } {
  if (status !== "errored" && status !== "stopped") return {};
  // 内存终态优先：本进程刚从引擎手里接过的结算带原值（ProviderStop 明细齐全），journal 行是
  // 它经一次 JSON 往返后的形态；条目被逐出后才退到后者。
  const memoryError =
    entry?.terminal?.status === "errored"
      ? entry.terminal.error
      : entry?.terminal?.status === "stopped"
        ? entry.terminal.error
        : undefined;
  if (memoryError !== undefined) {
    // 引擎构造之前就失败的路径（子进程无法 spawn、构造抛错）在注册表里放的是一个包装过的
    // 普通 Error——运行时可能没有 code。归到 DriverError 而不是编一个新码：那条路径的失败
    // 确实来自引擎之外的驱动层。
    const code = typeof memoryError.code === "string" ? memoryError.code : "DriverError";
    const providerStop = (memoryError as { providerStop?: WorkflowErrorJson["providerStop"] })
      .providerStop;
    return {
      error: {
        code,
        message: memoryError.message,
        ...(providerStop === undefined ? {} : { providerStop }),
      },
    };
  }
  if (row?.failure !== undefined) {
    return {
      error: {
        code: row.failure.code,
        message: row.failure.message,
        ...(row.failure.providerStop === undefined
          ? {}
          : { providerStop: row.failure.providerStop }),
      },
    };
  }
  return {};
}

/**
 * 一条 journal 里的 `log` 事件 → 端口的 logTail 项。
 *
 * 消息经 {@link boundDynamicWorkflowRunEventPayload} 有界化而不是自己 slice：字符串上限
 * （2048）与代理项安全的截断规则已经在端口那一侧写过一遍，抄第二遍就会在某次调参时分叉。
 * 查询已按 `type='log'` 下推过滤，所以非 log 事件只可能来自实现漂移——此时给空消息而不是
 * 崩掉整个详情面。
 */
export function toLogTailEntry(stored: StoredEvent): DynamicWorkflowRunLogEntry {
  const message = stored.event.type === "log" ? stored.event.message : "";
  const { payload } = boundDynamicWorkflowRunEventPayload({ message });
  return {
    sequence: stored.sequence,
    message: typeof payload.message === "string" ? payload.message : "",
    // 落库时刻原样过界；没有这一列的老 journal 上缺席（读侧据此不给年龄）。
    ...(stored.timeCreated === undefined ? {} : { at: stored.timeCreated }),
  };
}

/** 等结算，但尊重调用方的 signal（等待被打断不等于 run 被取消）。 */
export async function settleOrAbort(
  settlement: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) {
    await settlement;
    return;
  }
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    void settlement.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
    );
  });
}

/**
 * 孤儿收敛写入的失败编码（宿主级成员，引擎自身永不产出）。随 `stopped(interrupted)` 一起落库：
 * status + stopReason 已经说明「进程死亡打断」，这条 code 是同一事实的第二证据（老行只有它）。
 */
export const INTERRUPTED_FAILURE_CODE: WorkflowErrorCode = "Interrupted";

/**
 * resume 门的唯一谓词：**stopped 即可恢复**，
 * 除了 `superseded`——它的未完结工作已归后继所有，重放等于对着后继正在改的工作区把同一件事做两遍；
 * errored / completed 不可。{@link DynamicWorkflowRunSessionSummary.resumable} 用同一个——
 * UI 若自行按 status 重新推导，两处谓词总有一天不一致：按钮亮着但命令被拒。
 */
export function isResumableRecord(record: Pick<RunRecord, "status" | "stopReason">): boolean {
  return isResumableSettlement(record.status, record.stopReason);
}

/**
 * 同一个谓词的「结算事实」形态：`run-settled` 载荷上的 `resumable` 位由它算（live 由
 * toProgressPayload 按引擎事件算，冷回放由补种按 journal 行算），reducer 只搬运。
 */
export function isResumableSettlement(status: RunStatus, stopReason?: RunStopReason): boolean {
  return status === "stopped" && stopReason !== "superseded";
}

/**
 * 枚举行 → 会话枚举摘要。三件事都刻意与别处同源：
 *   - `resumable` 用 resume 门的同一个谓词（{@link isResumableRecord}）；
 *   - `label` 用两条读面共用的那条派生链（{@link resolveDynamicWorkflowRunLabel}）——枚举面
 *     自己拼一次兜底，同一个 run 就会在 `/dwf list` 与工具卡上显示不同的名字；
 *   - `updatedAt` 直读 journal 行的 `timeUpdated`（`RunRecord` 不带时间，故入参是枚举行）。
 */
export function toSessionSummary(
  row: DwfRunSessionListItem,
  entry?: RunRegistryEntry,
): DynamicWorkflowRunSessionSummary {
  const { label } = resolveDynamicWorkflowRunLabel({
    runId: row.runId,
    ...(row.name === undefined ? {} : { name: row.name }),
    ...(row.scriptText === undefined ? {} : { scriptText: row.scriptText }),
  });
  // 第四条读面也走同一条优先级（{@link synthesizeRunStatus}）：活条目下行上的终态是外来写入，
  // 状态报 running，停止原因与失败一并不出。少了这一支，会话列表会独自显示一个已经「停下」的
  // run，而快照 / 列表 / 详情三处都说它在跑。
  const status = synthesizeRunStatus(entry, row.status);
  const stopReason = stopReasonOf(entry, row);
  const live = entry !== undefined && entry.terminal === undefined;
  return {
    runId: row.runId,
    ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
    label,
    updatedAt: row.timeUpdated,
    status,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...lineageFields(row.resumedFrom, supersededByOf(entry, row)),
    ...(live || row.failure?.code === undefined ? {} : { failureCode: row.failure.code }),
    ...(live || row.failure?.message === undefined ? {} : { failureMessage: row.failure.message }),
    resumable: isResumableSettlement(status, stopReason),
  };
}
