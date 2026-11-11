// ============================================================
// GetWorkflowRun 的 `<summary>`：情势的一句话
// ============================================================
//
// 这句话**确定性地**从结构化字段拼出，没有任何模型参与：同一份快照永远拼出同一句话，
// 所以它可以被逐字钉住，也不会在两次读之间自己改口。它回答的是读者真正问的三件事——
// 这个 run 在哪、它在动吗、有没有事等着我做——而下面各块是这三个答案的展开。
//
// 一条纪律贯穿全文：**不知道就不说**。没有时间戳就不给年龄，没有阶段就不提阶段位置，
// 查不到停驻表就明说「不知道」，绝不用 0 或「unknown」冒充一个事实。

import type { GetWorkflowRunOutput } from "@zcode/contracts";
import { GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS } from "@zcode/contracts";
import {
  formatRelativeAge,
  formatWorkflowRunCount,
  formatWorkflowRunDuration,
} from "./workflow-run-introspection.js";

/** 摘要要读的事实 = 整份输出减去摘要自己（handler 先铸出输出，再拿它拼这一句）。 */
export type WorkflowRunSummaryFacts = Omit<GetWorkflowRunOutput, "summary">;

/** 终态三词：run 已经没有下一步动作了（与端口的终态判定同集）。 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "errored", "stopped"]);

/** 超出字符预算时整句整句地丢，实在丢不动才硬切——省略号留一个字符。 */
const SUMMARY_ELLIPSIS = "…";

export function buildWorkflowRunSummary(run: WorkflowRunSummaryFacts): string {
  const now = run.generatedAt;
  const terminal = TERMINAL_STATUSES.has(run.status);

  // 头两句是骨架（这个 run 在哪 + 走到第几步），任何预算下都不丢。
  const required = [
    `${statusClause(run, now, terminal)}${phaseClause(run)}.`,
    `${stepsClause(run, terminal)}.`,
  ];
  const optional = [
    failureClause(run),
    questionsClause(run),
    holesClause(run),
    progressClause(run, now, terminal),
    deliverableClause(run),
    ownershipClause(run),
  ].filter((clause): clause is string => clause !== undefined);

  const sentences = [...required, ...optional];
  while (
    sentences.length > required.length &&
    sentences.join(" ").length > GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS
  ) {
    sentences.pop();
  }
  const text = sentences.join(" ");
  if (text.length <= GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS) return text;
  return `${text.slice(0, GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS - SUMMARY_ELLIPSIS.length)}${SUMMARY_ELLIPSIS}`;
}

/** 状态 + 它已经跑了多久 / 结束了多久。 */
function statusClause(run: WorkflowRunSummaryFacts, now: number, terminal: boolean): string {
  const elapsed = formatWorkflowRunDuration(run.updatedAt - run.createdAt);
  if (!terminal) {
    return run.status === "pending"
      ? "Pending, not dispatched yet"
      : `Running for ${formatWorkflowRunDuration(now - run.createdAt)}`;
  }
  if (run.status === "completed") return `Completed in ${elapsed}`;
  if (run.status === "errored") return `Errored after ${elapsed}`;
  // stopped：先说停在多久以前（读者要判断的是「这事还新鲜吗」），再说它一共跑了多久。
  const reason = run.stopReason === undefined ? "stopped" : run.stopReason;
  const endedAge = formatRelativeAge(now, run.updatedAt);
  const ended = endedAge === undefined ? "" : ` ${endedAge}`;
  return `Stopped (${reason})${ended} after ${elapsed}`;
}

/**
 * 阶段位置。活着的（或终态但还有阶段没收口的）run 说「第几 / 共几」，全部走完的只说共几个——
 * 对一个已经跑完的 run，「在第 4 个阶段」是句没有信息的话。脚本没有阶段时整句不出现。
 */
function phaseClause(run: WorkflowRunSummaryFacts): string {
  const phases = run.phases;
  if (phases === undefined || phases.length === 0) return "";
  const index = phases.findIndex(
    (phase) => phase.state === "current" || phase.state === "unfinished",
  );
  if (index < 0) {
    // 只数走过的：`ahead` 的阶段还没发生过，算进去就把没做的事说成做过了。
    const entered = phases.filter((phase) => phase.state !== "ahead").length;
    return `, across ${entered} phase${entered === 1 ? "" : "s"}`;
  }
  return `, in phase ${index + 1} of ${phases.length} (${phases[index]!.name})`;
}

/** 步数。`nodesObserved` 是已落库节点行数，绝不冒充「总步数」——动态工作流没有静态总数。 */
function stepsClause(run: WorkflowRunSummaryFacts, terminal: boolean): string {
  const settled = run.usage.nodesCompleted + run.usage.nodesFailed;
  const leftover = run.health.leftoverRunning;
  if (terminal && leftover !== undefined && leftover > 0) {
    return `${settled} of ${run.usage.nodesObserved} dispatched steps settled; ${leftover} ${
      leftover === 1 ? "was" : "were"
    } still running ${leftoverEnding(run, leftover)}`;
  }
  if (terminal) {
    const failed = run.usage.nodesFailed > 0 ? `, ${run.usage.nodesFailed} failed` : "";
    return `${settled} step${settled === 1 ? "" : "s"} settled${failed}, ${formatWorkflowRunCount(
      run.usage.spentTokens,
    )} tokens`;
  }
  const running =
    run.usage.nodesRunning > 0 ? `, ${run.usage.nodesRunning} running${runningBreakdown(run)}` : "";
  return `${settled} of ${run.usage.nodesObserved} dispatched steps settled${running}`;
}

/**
 * 没结算的步是怎么留下的，由停止原因决定。这里曾一律写「进程退出、恢复时重派」：被修订替代的 run
 * 进程好好的，恢复还会被拒（同一份输出的 `<superseded>` 就这么说），读者拿到的是两句相反的话。
 */
function leftoverEnding(run: WorkflowRunSummaryFacts, leftover: number): string {
  if (run.stopReason === "superseded") {
    return `when the run was superseded; the new run owns ${leftover === 1 ? "it" : "them"}`;
  }
  if (run.status === "errored") return "when the run ended";
  if (run.stopReason === undefined || run.stopReason === "interrupted") {
    return "when the owning process exited and will be re-dispatched on resume";
  }
  return "when the run stopped and will be re-dispatched on resume";
}

/**
 * 在飞那几步分别在干什么（花名册的相位计数）。花名册读不出时整个括号不出现。
 *
 * **不变式**：一个处在活相位的子代理（`executing` / `waiting` / `parked`）名下恰有一条还标着
 * `running` 的 ask 行——`waiting` 是那条 ask 在等槽位或在退避，`parked` 是它停在一个问题上，
 * 两者的行都还没结算。所以这三个数是 `usage.nodesRunning` 的一个**划分**，加起来必须等于它。
 * 括号里的数与括号外的数对不上，只可能是造数据的人手搓了一份现实中不存在的 journal。
 */
function runningBreakdown(run: WorkflowRunSummaryFacts): string {
  const counts = { executing: 0, waiting: 0, parked: 0 };
  for (const subagent of run.subagents) {
    if (subagent.state === "executing") counts.executing += 1;
    else if (subagent.state === "waiting") counts.waiting += 1;
    else if (subagent.state === "parked") counts.parked += 1;
  }
  const parts = (Object.keys(counts) as (keyof typeof counts)[])
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${key}`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

/**
 * 待答问题。**「不知道」是一句必须说出口的话**：读另一个进程名下的 run 时，「没有人在等」
 * 与「查不到」长得一模一样，而这两者对模型是完全不同的下一步。
 */
function questionsClause(run: WorkflowRunSummaryFacts): string | undefined {
  if (!run.health.pendingQuestionsKnown) return "Pending questions are unknown from this session.";
  const count = run.pendingQuestions?.length ?? 0;
  if (count === 0) return undefined;
  return `${count} question${count === 1 ? "" : "s"} awaiting your answer.`;
}

/** 等着的留白（docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」）：与待答问题同一种「等你」。 */
function holesClause(run: WorkflowRunSummaryFacts): string | undefined {
  const count = (run.holes ?? []).filter((hole) => hole.state === "waiting").length;
  if (count === 0) return undefined;
  return `${count} hole${count === 1 ? "" : "s"} awaiting your code.`;
}

/** 最后一次被观察到在动是什么时候；停滞了就把这个词说出来。 */
function progressClause(
  run: WorkflowRunSummaryFacts,
  now: number,
  terminal: boolean,
): string | undefined {
  if (terminal) return undefined;
  const age = formatRelativeAge(now, run.health.lastProgressAt);
  if (age === undefined) return undefined;
  return run.health.stalledSince === undefined
    ? `Last progress ${age}.`
    : `Stalled, last progress ${age}.`;
}

/** 失败码进摘要：模型据它分辨「进程死了」与「脚本真失败」，而这决定它下一步走哪条路由。 */
function failureClause(run: WorkflowRunSummaryFacts): string | undefined {
  if (run.error === undefined) return undefined;
  if (run.status !== "errored" && run.stopReason !== "provider") return undefined;
  return `Failure: ${run.error.code}.`;
}

/**
 * 交付物（completed 才有）：读者要被指向那一件东西，而不是一张产物清单。
 *
 * 标题**不加引号**：这一句最终会经 XML-ish 转义进 `<summary>`，而那张转义表把 `"` 换成
 * `&quot;`——一对为了可读性加的引号会在模型眼前变成两团实体。括号里的 kind 已经把标题括住了。
 */
function deliverableClause(run: WorkflowRunSummaryFacts): string | undefined {
  if (run.status !== "completed") return undefined;
  const primary = run.artifacts?.find((artifact) => artifact.primary === true);
  if (primary === undefined) return undefined;
  return `Deliverable: ${primary.title ?? primary.id} (${primary.kind}, primary).`;
}

/** 非本会话拥有的 run：通知不会来，TaskOutput 也看不到它——summary 首句必须写明归属。 */
function ownershipClause(run: WorkflowRunSummaryFacts): string | undefined {
  return run.ownedByThisSession ? undefined : "Owned by another session.";
}
