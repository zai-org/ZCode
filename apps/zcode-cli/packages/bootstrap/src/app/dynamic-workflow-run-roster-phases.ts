// ============================================================
// 情势截面的**阶段表**：声明的站点 + 走过的站点
// ============================================================
// 名字与相位读的是 run 面板同一份归约
// 状态（`run.phaseNames` / `run.phases` / `run.currentPhase` / `run.nodes`），时刻读的是
// 事件索引——两侧的分工与 -roster-events.ts 文件头写的是同一条。
//
// 为什么节点计数取**归约状态**而不是 journal 的节点行：阶段坐标（`phaseName`）只活在归约状态
// 上（引擎只在出生事件上打戳，行上没有这一列），拿行去 join 只会把归约状态装不下的节点一并
// 丢掉；而归约状态还装着**还没落行**的 queued 节点，那正是「当前阶段有几个在跑」要数的东西。

import type { DynamicWorkflowRunPhaseView } from "@zcode/contracts";
import type { NodeRecord } from "@zcode/dynamic-workflow";
import type { WorkflowRunNode, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { instanceKey, type RosterEventIndex } from "./dynamic-workflow-run-roster-events.js";
import { NODE_ROW_RUNNING } from "./dynamic-workflow-run-roster-subagents.js";

/** world-read / world-run 之外的节点都按 ask 记：`kind` 只在出生事件上携带，缺席即未知。 */
const WORLD_NODE_KIND = "world-read";

/**
 * 阶段表：声明序的已声明阶段，后面接上「进过但没声明」的那些（按首次进入顺序）。
 *
 * **脚本没声明、也一个都没进过时整个返回 undefined**：那样的 run 没有阶段这回事，
 * 发一个空数组读起来像「阶段表是空的」，是另一句话。
 */
export function buildPhaseViews(input: {
  run: WorkflowRunState | undefined;
  index: RosterEventIndex;
  terminal: boolean;
  /** 节点行。停止事件把归约状态里的节点都结算了，终态上「没做完」只有行还记得。 */
  rows: readonly NodeRecord[];
}): DynamicWorkflowRunPhaseView[] | undefined {
  const { run, index, terminal, rows } = input;
  const declared = run?.phaseNames ?? [];
  const entered = run?.phases ?? [];
  if (declared.length === 0 && entered.length === 0) return undefined;

  const names = [...declared];
  const seen = new Set(declared);
  for (const phase of entered) {
    if (seen.has(phase.name)) continue;
    seen.add(phase.name);
    names.push(phase.name);
  }

  const nodes = run?.nodes ?? [];
  // 这里曾只看归约状态：花名册说子代理 unfinished、`nodes_running=1`，它所在的阶段却写 done。
  const leftoverRows = new Set(
    terminal
      ? rows
          .filter((row) => row.status === NODE_ROW_RUNNING)
          .map((row) => instanceKey(row.siteId, row.ordinal))
      : [],
  );
  const isOpen = (node: WorkflowRunNode) =>
    node.phase !== "settled" || leftoverRows.has(instanceKey(node.siteId, node.ordinal));
  return names.map((name) => {
    const rounds = entered.find((phase) => phase.name === name)?.rounds ?? 0;
    const owned = nodes.filter((node) => node.phaseName === name);
    const running = owned.filter(isOpen).length;
    const settled = owned.length - running;
    const trace = index.phases.get(name);
    return {
      name,
      state: phaseStateOf({
        rounds,
        terminal,
        open: owned.filter(isOpen),
        isCurrent: run?.currentPhase === name,
      }),
      rounds,
      nodesSettled: settled,
      nodesRunning: running,
      ...(trace?.enteredAt === undefined ? {} : { enteredAt: trace.enteredAt }),
      ...(trace?.exitedAt === undefined ? {} : { exitedAt: trace.exitedAt }),
    };
  });
}

/**
 * 一个阶段的处境（见 `DynamicWorkflowRunPhaseState` 的四个词）。
 *
 * `unfinished` **只对终态 run 成立**：run 还活着时，一个非当前阶段里有在飞的 ask 是并行分支
 * 的常态，不是烂尾——它有几个在飞，`nodesRunning` 已经如实说了。
 */
function phaseStateOf(input: {
  rounds: number;
  terminal: boolean;
  /** 这个阶段里还没结算的节点。 */
  open: readonly WorkflowRunNode[];
  isCurrent: boolean;
}): DynamicWorkflowRunPhaseView["state"] {
  const { rounds, terminal, open, isCurrent } = input;
  if (rounds === 0) return "ahead";
  if (terminal) {
    return open.some((node) => node.kind !== WORLD_NODE_KIND) ? "unfinished" : "done";
  }
  return isCurrent ? "current" : "done";
}
