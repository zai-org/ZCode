// ============================================================
// Dynamic Workflow Run 的**情势截面**：阶段 / 子代理 / 健康
// ============================================================
// `getRunDetail` 原本只给得出计数与一截
// 日志尾巴，回答不了模型真正要问的三件事：run 走到哪了、每个子代理此刻在干什么、它还在动吗。
// 本模块就是那三件事的派生，且**只是派生**——纯函数，不碰 journal、不碰注册表、不取时钟：
// 事件、节点行、actor 行、归约状态、停驻问题和 `now` 全部由调用方递进来。
//
// 之所以要纯：这三组字段的规则（状态词的判定顺序、缺席的读法、时间的唯一来源）密度高、
// 易错，而它们的取数面（SQLite journal + 引擎注册表）在测试里贵得离谱。把规则和取数分开，
// 规则就能用一把手搓的事件与行钉死，取数只需一条集成用例证明接线通了。
//
// 拆分：事件扫描在 -roster-events.ts，阶段表在 -roster-phases.ts，花名册在
// -roster-subagents.ts（各自的文件头写了自己的取数纪律）；本文件留下公开契约、健康面与编排。

import type {
  DynamicWorkflowRunHealth,
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowRunPhaseView,
  DynamicWorkflowRunSubagentView,
} from "@zcode/contracts";
import type { ActorRecord, NodeRecord, StoredEvent } from "@zcode/dynamic-workflow";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { TERMINAL_RUN_STATUSES } from "./dynamic-workflow-run-observation.js";
import {
  indexRosterEvents,
  instanceKey,
  type RosterEventIndex,
} from "./dynamic-workflow-run-roster-events.js";
import { buildPhaseViews } from "./dynamic-workflow-run-roster-phases.js";
import { buildSubagentViews, NODE_ROW_RUNNING } from "./dynamic-workflow-run-roster-subagents.js";

/** ask 节点行的 `kind`。连败只数 ask 的结算：world-read 失败不是「子代理连着挂」。 */
const ASK_NODE_KIND = "ask";

/** 情势截面的取数入参。 */
export interface WorkflowRunRosterInput {
  /**
   * 本 run 的归约状态（journal 事件重放进 run 面板同一个 reducer 的结果）。
   * 一条事件都没有的 run（注册表间隙）传 `undefined`：那时阶段表缺席、花名册为空。
   */
  run: WorkflowRunState | undefined;
  /** 本 run 的全部 journal 事件，sequence 升序。时间的**唯一**来源。 */
  events: readonly StoredEvent[];
  /**
   * 非 report 的节点行、不带结果（`listNodes(runId, {kinds: NON_REPORT_NODE_KINDS, withResult:
   * false})`）。只贡献状态与 `stats`，行上没有任何时间列。
   */
  nodes: readonly NodeRecord[];
  /** `journal.listActors(runId, {withPersona: false})`。花名册的名册本身。 */
  actors: readonly ActorRecord[];
  /** run 的生命周期状态，与详情面给出的那一个同值（终态与否改写一半的状态词）。 */
  status: DynamicWorkflowRunLifecycleStatus;
  /**
   * 此刻停驻在这个 run 上的问题；**`undefined` 表示这次读查不到停驻表**（run 在别的进程
   * 名下），此时 `health.pendingQuestionsKnown` 为假且没有子代理会被报成 `parked`。
   * 空数组与之相反，是一句确定的「没人在等」。
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /** 本次读的时刻，只用于给事件时间**上钳**（见 -roster-events.ts 的 `timeOf`）。 */
  now: number;
}

/** 情势截面：详情面直接展开这三个键。 */
export interface WorkflowRunRoster {
  phases?: DynamicWorkflowRunPhaseView[];
  subagents: DynamicWorkflowRunSubagentView[];
  health: DynamicWorkflowRunHealth;
}

/** 从一次 getRunDetail 已经读到的那几份事实里派生情势截面。 */
export function buildWorkflowRunRoster(input: WorkflowRunRosterInput): WorkflowRunRoster {
  const { run, events, nodes, actors, status, pendingQuestions, now } = input;
  const terminal = TERMINAL_RUN_STATUSES.has(status);
  const index = indexRosterEvents(events, now);
  const phases = buildPhaseViews({ run, index, terminal, rows: nodes });
  return {
    ...(phases === undefined ? {} : { phases }),
    subagents: buildSubagentViews({
      actors,
      nodes,
      run,
      index,
      terminal,
      ...(pendingQuestions === undefined ? {} : { pendingQuestions }),
    }),
    health: buildHealth({ run, nodes, index, terminal, pendingQuestions }),
  };
}

/** run 整体还在不在动（见 `DynamicWorkflowRunHealth`）。 */
function buildHealth(input: {
  run: WorkflowRunState | undefined;
  nodes: readonly NodeRecord[];
  index: RosterEventIndex;
  terminal: boolean;
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
}): DynamicWorkflowRunHealth {
  const { run, nodes, index, terminal, pendingQuestions } = input;
  // 终态 run 才数遗留：run 还活着时「有行标着 running」就是它在正常干活。
  const leftoverRunning = terminal
    ? nodes.filter((node) => node.status === NODE_ROW_RUNNING).length
    : 0;
  return {
    ...(index.lastProgressAt === undefined ? {} : { lastProgressAt: index.lastProgressAt }),
    ...(index.stalledSince === undefined ? {} : { stalledSince: index.stalledSince }),
    ...concurrencyField(run, index),
    consecutiveFailures: countTrailingFailures(nodes, index),
    cachedSteps: index.settlements.filter((settlement) => settlement.cached).length,
    ...(leftoverRunning === 0 ? {} : { leftoverRunning }),
    pendingQuestionsKnown: pendingQuestions !== undefined,
  };
}

/**
 * 并发现状。
 *
 * `cap` 是**这个 run 自己的**上界：用户给它定过就是那个数，没定过就是默认并发（`concurrency.ceiling`，
 * 键名早于「默认并发」这个概念）。
 * `effective` 是治理器此刻实际放行的数，即再与共享闸门取一次小。
 *
 * **只在 `effective < cap` 时在场**，与详情面的 `maxConcurrency` 同一条缺席规则：一个跑满自己
 * 那条界的 run 没有可说的。报默认值当 `cap` 是错的——一个以 `max_concurrency: 3` 起的 run 在
 * 六核机器上会永远显示成「3/6」，读起来像被限流，而它正跑在用户亲手定的界上。
 */
function concurrencyField(
  run: WorkflowRunState | undefined,
  index: RosterEventIndex,
): Pick<DynamicWorkflowRunHealth, "concurrency"> {
  const concurrency = run?.concurrency;
  if (concurrency === undefined) return {};
  const cap = concurrency.limit ?? concurrency.ceiling;
  const effective = Math.min(concurrency.cap, cap);
  if (effective >= cap) return {};
  return {
    concurrency: {
      effective,
      cap,
      ...(index.concurrencyReason === undefined ? {} : { reason: index.concurrencyReason }),
      ...(index.concurrencySince === undefined ? {} : { since: index.concurrencySince }),
    },
  };
}

/**
 * 按结算顺序**结尾处连续**失败的 ask 数：连挂 3 次与前后散落 3 次是两个不同的处境，
 * 前者说明下一条也多半会挂。只数 ask——world-read 的失败是脚本的事，不是子代理在垮。
 * `cancelled` 与成功一样断开连败：被取消不是失败。
 */
function countTrailingFailures(nodes: readonly NodeRecord[], index: RosterEventIndex): number {
  const askKeys = new Set(
    nodes
      .filter((node) => node.kind === ASK_NODE_KIND)
      .map((node) => instanceKey(node.siteId, node.ordinal)),
  );
  let failures = 0;
  for (let position = index.settlements.length - 1; position >= 0; position -= 1) {
    const settlement = index.settlements[position]!;
    if (!askKeys.has(settlement.key)) continue;
    if (settlement.outcome !== "failed") break;
    failures += 1;
  }
  return failures;
}
