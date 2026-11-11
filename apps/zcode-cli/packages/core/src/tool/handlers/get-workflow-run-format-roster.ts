// ============================================================
// GetWorkflowRun 模型面的**情势三块**：`<health>` / `<phases>` / `<subagents>`（+ `<log_tail>`）
// ============================================================
// 从 get-workflow-run-format.ts 拆出：
// 那里是「一个事实一个块」的骨架，这里是三张**表**——列、对齐和逐相位的措辞自成一块。
//
// 两条纪律：
//   1. 缺席即不写。没有时间戳就没有年龄，没有 `node-progress` 就没有 turn / tool calls，
//      绝不用 0 顶替「不知道」——`0 tool calls` 是一件事实，而缺席是另一件。
//   2. 列宽由本次这些行算出来（有上界），不是写死的魔法数：一份只有两个子代理的花名册
//      不该为了一个不存在的长名字空出二十列。

import type {
  GetWorkflowRunOutput,
  GetWorkflowRunPhase,
  GetWorkflowRunSubagent,
} from "@zcode/contracts";
import {
  escapeWorkflowRunText,
  formatRelativeAge,
  formatWorkflowRunCount,
  formatWorkflowRunDuration,
} from "./workflow-run-introspection.js";

/** 列之间的间隔：两个空格。一个空格会让「名字 地址」读成一个词。 */
const COLUMN_GAP = "  ";
/** 对齐列的宽度上界。超过它的值原样写出并让这一行变长，而不是把整张表撑宽。 */
const MAX_COLUMN_WIDTH = 24;
/** 任务摘要行的缩进：它从属于上一行，不是新的一行事实。 */
const TASK_LINE_INDENT = "  ";

function padColumn(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function columnWidth(values: readonly string[]): number {
  return Math.min(
    MAX_COLUMN_WIDTH,
    values.reduce((widest, value) => Math.max(widest, value.length), 0),
  );
}

/** 把若干段拼成一行：空段（= 不知道的事实）直接消失，不留下两个连着的间隔。 */
function joinCells(cells: readonly string[]): string {
  // 末尾 trim：最后一列的补白会变成行尾空格，而那是一行看不见的噪声（`ahead` 的行全是它）。
  return cells
    .filter((cell) => cell.length > 0)
    .join(COLUMN_GAP)
    .trimEnd();
}

// ————————————————————————————————————————————————
// <health>
// ————————————————————————————————————————————————

/**
 * run 整体还在不在动，一行 `key=value`。
 *
 * `stalled` 只对活着的 run 有意义（一个终态 run 当然不动了），而终态 run 多出一句
 * **leftover 说明**：下面那些标着 running 的行是进程死在它们下面的残留，不是活的工作。
 * 这是本工具仅有的两处「把不知道说出口」之一——沉默会被读成「它们还在跑」。
 */
export function formatWorkflowRunHealthBlock(run: GetWorkflowRunOutput, terminal: boolean): string {
  const now = run.generatedAt;
  const health = run.health;
  const cells: string[] = [];

  const lastProgress = formatRelativeAge(now, health.lastProgressAt);
  if (lastProgress !== undefined) cells.push(`last_progress=${lastProgress}`);

  if (health.concurrency !== undefined) {
    const { effective, cap, reason, since } = health.concurrency;
    const sinceAge = formatRelativeAge(now, since);
    const why = [
      reason === undefined ? "" : escapeWorkflowRunText(reason),
      sinceAge === undefined ? "" : `since ${sinceAge}`,
    ]
      .filter((part) => part.length > 0)
      .join(" ");
    cells.push(`concurrency=${effective}/${cap}${why.length === 0 ? "" : ` (${why})`}`);
  }

  if (!terminal) {
    const stalledAge = formatRelativeAge(now, health.stalledSince);
    cells.push(`stalled=${stalledAge === undefined ? "no" : `since ${stalledAge}`}`);
  }

  cells.push(`consecutive_failures=${health.consecutiveFailures}`);
  cells.push(`cached_steps=${health.cachedSteps}`);

  const leftover = terminal ? health.leftoverRunning : undefined;
  const note =
    leftover === undefined || leftover === 0
      ? ""
      : `\nThe ${leftover} "running" step${leftover === 1 ? "" : "s"} below ${
          leftover === 1 ? "is a leftover" : "are leftovers"
        } of ${
          // 只有 interrupted 才是进程死了（缺原因的老行也按它读）；其余是 run 自己停下的。
          run.stopReason === undefined || run.stopReason === "interrupted"
            ? "the exited process"
            : "the ended run"
        }, not live work.`;
  return `<health>${joinCells(cells)}${note}</health>`;
}

// ————————————————————————————————————————————————
// <phases>
// ————————————————————————————————————————————————

/** 阶段表：一行一个阶段，声明序。`ahead` 的行只有名字和状态——它还没发生过。 */
export function formatWorkflowRunPhasesBlock(
  run: GetWorkflowRunOutput,
  terminal: boolean,
): string | undefined {
  const phases = run.phases;
  if (phases === undefined || phases.length === 0) return undefined;

  const names = phases.map((phase) => escapeWorkflowRunText(phase.name));
  const nameWidth = columnWidth(names);
  const stateWidth = columnWidth(phases.map((phase) => phase.state));

  const lines = phases.map((phase, index) =>
    joinCells([
      `${index + 1}. ${padColumn(names[index]!, nameWidth)}`,
      padColumn(phase.state, stateWidth),
      phaseRoundsCell(phase),
      phaseCountsCell(phase, terminal),
      phaseDurationCell(phase, run.generatedAt, terminal),
    ]),
  );
  return `<phases>\n${lines.join("\n")}\n</phases>`;
}

function phaseRoundsCell(phase: GetWorkflowRunPhase): string {
  // rounds 为 0 只可能是 `ahead`：一个还没被进入过的阶段说不出「进过几次」。
  if (phase.rounds === 0) return "";
  return `${phase.rounds} round${phase.rounds === 1 ? "" : "s"}`;
}

function phaseCountsCell(phase: GetWorkflowRunPhase, terminal: boolean): string {
  if (phase.nodesRunning > 0) {
    // 终态 run 里的「还在跑」是没结算，不是在动。
    return `${phase.nodesSettled} settled, ${phase.nodesRunning} ${terminal ? "unfinished" : "running"}`;
  }
  if (phase.nodesSettled === 0) return "";
  return `${phase.nodesSettled} step${phase.nodesSettled === 1 ? "" : "s"} settled`;
}

function phaseDurationCell(phase: GetWorkflowRunPhase, now: number, terminal: boolean): string {
  if (phase.enteredAt === undefined) return "";
  if (phase.exitedAt !== undefined)
    return formatWorkflowRunDuration(phase.exitedAt - phase.enteredAt);
  // 没有离开时刻：活着的 run 说「到现在为止」，终态 run 什么也不说——它的离开时刻无人记录，
  // 拿读时的 now 去减等于把「进程死后的这几个小时」算进那个阶段。
  return terminal ? "" : `${formatWorkflowRunDuration(now - phase.enteredAt)} so far`;
}

// ————————————————————————————————————————————————
// <subagents>
// ————————————————————————————————————————————————

/**
 * 花名册：一行一个子代理，外加一行缩进的 `task:`（有任务摘要时）。
 *
 * 一行的读法是「谁 · 在哪 · 什么相位 · 在哪个阶段 · 正在做什么 · 花了多少 token」，
 * 其中「正在做什么」按相位分叉——在跑的说它的 ask 和工具，在等的说等什么，停驻的说等哪个
 * 问题、等了多久。这正是这个工具存在的理由：模型要能一眼看出「谁卡住了」。
 */
export function formatWorkflowRunSubagentsBlock(run: GetWorkflowRunOutput): string {
  if (run.subagents.length === 0) return "<subagents>No subagents created yet.</subagents>";

  const askedAtByQid = new Map<string, number>();
  for (const question of run.pendingQuestions ?? [])
    askedAtByQid.set(question.qid, question.askedAt);

  const names = run.subagents.map((subagent) =>
    subagent.name === undefined ? "" : escapeWorkflowRunText(subagent.name),
  );
  const addresses = run.subagents.map(
    (subagent) => `${escapeWorkflowRunText(subagent.siteId)}@${subagent.ordinal}`,
  );
  const nameWidth = columnWidth(names);
  const addressWidth = columnWidth(addresses);
  const stateWidth = columnWidth(run.subagents.map((subagent) => subagent.state));

  const lines: string[] = [];
  run.subagents.forEach((subagent, index) => {
    lines.push(
      joinCells([
        // 匿名 actor 不合成兜底名（同 pendingQuestions）：留白，地址列仍对齐。
        padColumn(names[index]!, nameWidth),
        padColumn(addresses[index]!, addressWidth),
        padColumn(subagent.state, stateWidth),
        subagent.phaseName === undefined
          ? ""
          : `phase ${escapeWorkflowRunText(subagent.phaseName)}`,
        subagentActivityCell(subagent, run.generatedAt, askedAtByQid),
        subagent.tokens > 0 ? `${formatWorkflowRunCount(subagent.tokens)} tokens` : "",
      ]),
    );
    const head = subagent.currentAsk?.instructionsHead;
    if (head !== undefined && head.length > 0) {
      lines.push(`${TASK_LINE_INDENT}task: ${escapeWorkflowRunText(head)}`);
    }
  });
  const truncated =
    run.subagentsTruncated === true
      ? `\nOnly the first ${run.subagents.length} subagents are listed; this run has more.`
      : "";
  return `<subagents>\n${lines.join("\n")}${truncated}\n</subagents>`;
}

function subagentActivityCell(
  subagent: GetWorkflowRunSubagent,
  now: number,
  askedAtByQid: ReadonlyMap<string, number>,
): string {
  if (subagent.state === "parked" && subagent.parkedOn !== undefined) {
    const waited = formatRelativeAge(now, askedAtByQid.get(subagent.parkedOn));
    const forHow = waited === undefined ? "" : ` for ${waited.replace(/ ago$/u, "")}`;
    return `on question ${escapeWorkflowRunText(subagent.parkedOn)}${forHow}`;
  }
  if (subagent.state === "waiting") return waitCell(subagent, now);
  if (subagent.state === "unfinished" && subagent.currentAsk !== undefined) {
    return `${askAddress(subagent.currentAsk)} was in flight at the stop`;
  }
  if (subagent.currentAsk !== undefined) return executingCell(subagent, now);
  return settledCell(subagent);
}

function askAddress(ask: NonNullable<GetWorkflowRunSubagent["currentAsk"]>): string {
  // actorSeq 是 journal 的 0 基列；模型面按人读的 1 基说「第几步」。
  const step = ask.actorSeq === undefined ? "" : ` (step ${ask.actorSeq + 1})`;
  return `${escapeWorkflowRunText(ask.siteId)}@${ask.ordinal}${step}`;
}

function executingCell(subagent: GetWorkflowRunSubagent, now: number): string {
  const ask = subagent.currentAsk!;
  const parts = [askAddress(ask)];
  const onStep = formatRelativeAge(now, ask.startedAt);
  if (onStep !== undefined) parts.push(`${onStep.replace(/ ago$/u, "")} on this step`);
  if (ask.turn !== undefined) parts.push(`turn ${ask.turn}`);
  if (ask.toolCalls !== undefined)
    parts.push(`${ask.toolCalls} tool call${ask.toolCalls === 1 ? "" : "s"}`);
  if (ask.lastTool !== undefined) {
    const target =
      ask.lastTool.target === undefined ? "" : ` ${escapeWorkflowRunText(ask.lastTool.target)}`;
    const age = formatRelativeAge(now, ask.lastTool.at);
    parts.push(
      `last ${escapeWorkflowRunText(ask.lastTool.name)}${target}${age === undefined ? "" : ` ${age}`}`,
    );
  }
  return parts.join(", ");
}

function waitCell(subagent: GetWorkflowRunSubagent, now: number): string {
  const wait = subagent.wait;
  if (wait === undefined) return "";
  const waited = formatRelativeAge(now, wait.since);
  const forHow = waited === undefined ? "" : ` for ${waited.replace(/ ago$/u, "")}`;
  if (wait.cause === "slot") return `waiting for a slot${forHow}`;
  const after = wait.reason === undefined ? "" : ` after ${escapeWorkflowRunText(wait.reason)}`;
  const retry =
    wait.retryAfterMs === undefined
      ? ""
      : `, retry in ${formatWorkflowRunDuration(wait.retryAfterMs)}`;
  // 「等了多久」贴着原因，「还要等多久」收尾：两个时长挨在一起时读者分不清哪个是哪个。
  return `backoff${after}${forHow}${retry}`;
}

function settledCell(subagent: GetWorkflowRunSubagent): string {
  if (subagent.stepsSettled === 0 && subagent.stepsFailed === 0) return "";
  const failed = subagent.stepsFailed > 0 ? `, ${subagent.stepsFailed} failed` : "";
  return `${subagent.stepsSettled} step${subagent.stepsSettled === 1 ? "" : "s"}${failed}`;
}

// ————————————————————————————————————————————————
// <log_tail>
// ————————————————————————————————————————————————

/** 叙事尾巴。事件带落库时刻时前缀年龄；老 journal 上没有这一列，那些行就只有序号。 */
export function formatWorkflowRunLogTailBlock(run: GetWorkflowRunOutput): string {
  if (run.logTail.length === 0) return "<log_tail>No log() narration recorded yet.</log_tail>";
  const lines = run.logTail.map((entry) => {
    const age = formatRelativeAge(run.generatedAt, entry.at);
    return joinCells([`[${entry.sequence}]`, age ?? "", escapeWorkflowRunText(entry.message)]);
  });
  return `<log_tail>\n${lines.join("\n")}\n</log_tail>`;
}
