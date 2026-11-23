// ============================================================
// Dynamic Workflow Run 的冷回放：journal → 与 live 同一种进度载荷
// ============================================================
// `workflowRuns` 投影只有内存一条来源，
// 重启后为空；而 dwf_event 里躺着引擎发过的每一条事件——与 live 时喂给投影的是同一份有界序列化。
// 本模块把它们按 journal 顺序重新铸成 DynamicWorkflowRunProgressPayload，冷物化把这批载荷当
// 内存事件喂给同一个 reducer，于是重启前后的投影逐字节一致。
//
// 独立成模块而不是塞进 observation.ts：铸造链（toProgressPayload）在 launch.ts，而 launch.ts
// 已经 import observation.ts（谓词），反向 import 就是环。

import type { DwfRunSessionListItem } from "@zcode/adapters/storage";
import type { DynamicWorkflowRunProgressPayload } from "@zcode/contracts";
import type {
  JournalStorePort,
  ListEventsOptions,
  RunEvent,
  StoredEvent,
} from "@zcode/dynamic-workflow";
import { WORKFLOW_RUNS_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { coldCompiledHoles } from "./dynamic-workflow-run-holes.js";
import { toProgressPayload } from "./dynamic-workflow-run-launch.js";
import { TERMINAL_RUN_STATUSES } from "./dynamic-workflow-run-observation.js";

/**
 * 一条 run 的全部进度载荷，按 journal sequence 升序。
 *
 * **结算以行为准**：行是终态（completed / errored / stopped）时，回放的最后一条 `run-settled`
 * 永远按行铸造——尾部存着的 `run-settled`（若有）被它替换，尾部没有（进程死亡、孤儿收敛只改写了
 * 行，刻意不合成事件——journal 的契约是「引擎发过什么」）就追加。同一条铸造链、同一个 resumable
 * 谓词（toProgressPayload 内部）；reducer 的 `run-settled` 分支已经做全部归一化，这里不需要第二个
 * 归一化器。铸出的载荷**只存在于这次回放的返回值里**，绝不写进 dwf_event。
 *
 * 终态词表重构（completed / errored / stopped）只在
 * 行的 codec 里做了映射，dwf_event 的载荷是原样 JSON——之前写下的 `run-settled` 带的是旧词
 * `cancelled` / `failed`。原实现看到尾部已有 `run-settled` 就不再合成，把旧词原样喂给 reducer，
 * reducer 认不出这个词，run 便被留在 running：卡片亮着灯、Cancel 可点而后端无事可取消。行是状态
 * 的唯一权威（codec 已把旧行译成新词），所以结算一律从行派生；事件的词表再怎么变，冷回放都不
 * 会再对着旧事件说谎。新词表的 run 两条路给出逐字节相同的载荷（引擎的 `run-settled` 恰好只带
 * 行上的那四个字段），live 与冷回放一致的契约不变。
 *
 * `defaultConcurrency` 是**必填**而不是可选：它是 `run-started` 载荷上的宿主派生字段（线上键名仍是
 * `concurrencyCeiling`），live 侧恒在场（launch 那一刻算的），这里漏掉就会让冷回放的第一条载荷比
 * live 少一个键——而「两侧逐字节相等」正是本模块唯一的契约。调用方给的是同一个
 * `resolveWorkflowDefaultConcurrency`。
 */
export function replayRunProgress(
  row: DwfRunSessionListItem,
  journal: Pick<JournalStorePort, "listEvents">,
  defaultConcurrency: number,
): DynamicWorkflowRunProgressPayload[] {
  return replayRunProgressFromEvents(
    row,
    journal.listEvents(row.runId, COLD_REPLAY_EVENT_READ),
    defaultConcurrency,
  );
}

/**
 * 冷回放（与 GetWorkflowRun）读事件的形状：全部事件，但本 run 第 64 条之后的 report 事件不带
 * `item`（docs/dynamic-workflow/presentation.md「Cold replay」、docs/execution-engine.md
 * 「Reading the journal」）。
 *
 * 为什么归约结果与读全量逐字节相同：reducer 按实例 upsert report 条目、满 64 条后拒收新实例，
 * `run-started` 不清表，而每个 report 实例只发一次事件（重放命中静默跳过）——所以前 64 条
 * report 事件恰好就是 reducer 会为之生成预览的那些；之后的每一条它只读实例（置 `truncated`）
 * 与标签（数看板条目）。修复原因：此前这里读全量，一个报了 65,536 条的 run 在会话打开时要把
 * 约 2 GiB 的 item 解码进内存，而它们没有一条会被显示。
 */
export const COLD_REPLAY_EVENT_READ: ListEventsOptions = {
  types: "all",
  reportItems: { limit: WORKFLOW_RUNS_LIMITS.maxReports },
};

/**
 * 同一条铸造链，但事件由调用方**已经读好**递进来。
 *
 * 存在的理由只有一个：`getRunDetail` 要在同一次调用里既归约出 run 状态、又按事件时刻算情势
 * 截面。让两边各 `listEvents` 一次，
 * 就是为同一份数据付两遍钱——而这条读面在长 run 上正是最贵的那一段。
 *
 * 递进来的必须是**该 run 的全部事件、sequence 升序**（即 `listEvents(runId, COLD_REPLAY_EVENT_READ)`
 * 的返回），尾部结算的替换逻辑依赖「最后一条就是最后一条」。
 */
export function replayRunProgressFromEvents(
  row: DwfRunSessionListItem,
  stored: readonly StoredEvent[],
  defaultConcurrency: number,
): DynamicWorkflowRunProgressPayload[] {
  const toolCallId = row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId };
  // 留白的类型（`hole-reached` 的派生字段）：live 侧读注册表条目上的编译产物，这里没有条目，只能
  // 对行里的（有效）脚本重建一次站点表——**只在这批事件里真有留白到达时**才付这笔编译，绝大多数
  // run 没有留白，冷回放因此与从前逐字相同。行里脚本缺席（老行）即不补。
  const holeTypeOf = coldHoleTypeOf(row.scriptText, stored);
  // 发起锚点：与 live 同一条铸造链，派生字段也要一致——
  // 冷回放载荷与 live 载荷逐字节相等是本模块的契约（测试钉住）。锚点就在这批事件里（首条
  // run-launched），不必再查一次 journal；升级前的 run 没有它，字段缺席。
  const launched = stored.find((entry) => entry.event.type === "run-launched")?.event;
  const launchInputId =
    launched?.type === "run-launched" ? { launchInputId: launched.inputId } : {};
  // lineage 指针与 live 同源（launch 侧从入参或 journal 行读，这里直接是行）。
  const resumedFrom = row.resumedFrom === undefined ? {} : { resumedFrom: row.resumedFrom };
  // 子代理模型与锚点**同源**：同一条 `run-launched` 事件（零 SQL，dwf_run 上没有这一列）。
  // live 侧从 launch 入参或同一条事件读回同一个规范串，所以两侧载荷仍然逐字节相等。设过才在场。
  const subagentModel =
    launched?.type === "run-launched" && launched.subagentModel !== undefined
      ? { subagentModel: launched.subagentModel }
      : {};
  // 脚本点名的模型绑定表：同一条事件、同一条论证（actor-created 的派生 `model` 据它映射），两侧载荷
  // 因此仍然逐字节相等。
  const modelBindings =
    launched?.type === "run-launched" && launched.modelBindings !== undefined
      ? { modelBindings: launched.modelBindings }
      : {};
  const terminal = TERMINAL_RUN_STATUSES.has(row.status);
  const last = stored.at(-1);
  // 只替换**尾部**的结算：resume 过的 run 中途还躺着上一世的 `run-settled`，那是真实历史，
  // 紧随其后的 `run-started` 会把它翻回 running（reducer 的既有语义），不动它。
  const trailingSettle = terminal && last?.event.type === "run-settled" ? last : undefined;
  const replayable = trailingSettle === undefined ? stored : stored.slice(0, -1);
  const payloads = replayable.map((entry) =>
    toProgressPayload({
      event: entry.event,
      runId: row.runId,
      sequence: entry.sequence,
      ...toolCallId,
      ...launchInputId,
      ...resumedFrom,
      ...subagentModel,
      ...modelBindings,
      concurrencyCeiling: defaultConcurrency,
      ...(holeTypeOf === undefined ? {} : { holeTypeOf }),
      ...(entry.event.type === "hole-reached" && entry.timeCreated !== undefined
        ? { reachedAt: entry.timeCreated }
        : {}),
    }),
  );
  if (!terminal) return payloads;
  const settled: RunEvent = {
    type: "run-settled",
    status: row.status,
    // stopped 的行必带 reason（老行解码缺席时仓储已兜成 user）；其余状态不带。
    ...(row.status === "stopped" ? { stopReason: row.stopReason ?? "user" } : {}),
    ...(row.status === "stopped" && row.supersededBy !== undefined
      ? { supersededBy: row.supersededBy }
      : {}),
    ...(row.failure === undefined ? {} : { error: row.failure }),
  };
  payloads.push({
    ...toProgressPayload({
      event: settled,
      runId: row.runId,
      // 合成结算不能预占 N+1，否则恢复后的真实启动事件会与它碰撞。
      sequence: trailingSettle?.sequence ?? last?.sequence ?? 0,
      ...toolCallId,
      ...launchInputId,
      ...resumedFrom,
      ...subagentModel,
      ...modelBindings,
      concurrencyCeiling: defaultConcurrency,
    }),
    ...(trailingSettle ? {} : { syntheticSettlement: true }),
  });
  return payloads;
}

/**
 * 冷回放的留白类型查询（`hole-reached` 的派生字段）：事实表由 {@link coldCompiledHoles} 只在
 * 需要时重建；没有即不补 `type`，UI 退回展示载荷。
 */
function coldHoleTypeOf(
  scriptText: string | undefined,
  stored: readonly StoredEvent[],
): ((siteId: string) => string | undefined) | undefined {
  const holes = coldCompiledHoles(scriptText, stored);
  return holes === undefined
    ? undefined
    : (siteId) => holes.find((hole) => hole.siteId === siteId)?.type;
}
