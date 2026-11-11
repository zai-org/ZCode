// ============================================================
// Dynamic Workflow Run Service：给一处正在等的留白补上函数体
// ============================================================
// docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」；引擎文档「Holes」→「The fill
// service's checks」。这是 `DynamicWorkflowRunPort.fillHole` 的实现体，与 `retuneConcurrency`
// 同一姿态、与三条启动入口分居：它一个 run 都不铸，只对着已经在飞的那个说一句话。
//
// 顺序就是全部的语义，且**拒绝即零副作用**（留白照旧在等）：
//   1. 找 run（journal 行 ∪ 注册表）→ `run_not_found`；不在本进程飞 → `hole_not_waiting`；
//   2. 读 run 此刻的脚本，收集站点表，按站点 id 找到那处开放的留白 → 不在 / 已补 → `hole_not_waiting`；
//   3. 把函数体拼成调用的最后一个实参（`spliceHoleBody`），对**整份**有效脚本跑一遍与提交同款的
//      分析，再查点名的模型都在本 run 的绑定表里（诊断按落点分到函数体内 / 草稿内）→ `compile_failed`；
//   4. 站点稳定性复核（`checkSiteStability`）：老 id 一个不少、位置只按插入行数平移，新 id 全是这次
//      补全写下的（带被补留白的前缀，或是体里新留的留白及其体内站点）→ 不成立是宿主故障 →
//      `fill_ids_unstable`；
//   5. 经控制面把 `holeBodies[siteId]`、有效脚本与它的规格表 / 阶段表交给引擎（`fillHole` 一个
//      同步步骤里写回 run 行、记 `hole-filled`、放行停驻的分支）→ `not_waiting` / `settled` →
//      `hole_not_waiting`；
//   6. 引擎收下之后才动宿主侧：注册表条目换成有效脚本的事实，草稿**就地**改写，`scriptPath`
//      不变。草稿写失败不撤销补全——journal 已经是真相，草稿只是把手。
//
// 唯一在引擎之前落盘的是**没有草稿的 run 的那份新草稿**：它的路径要随 `hole-filled` 进 journal
// （冷读面靠它在重启后找到这份草稿），而事件是引擎在同一个同步步骤里记的，所以只能先铸。引擎
// 随后拒绝（竞态：刚结算 / 没在等）时把这个本次刚铸的文件删掉——「什么都不删草稿」说的是模型
// 编辑过的草稿，一个几毫秒前由本次调用独占创建、谁都还没见过的文件不在其列。

import { rm, writeFile } from "node:fs/promises";
import type { DynamicWorkflowRunFillHoleRequest, FillWorkflowHoleResult } from "@zcode/contracts";
import {
  analyzeWorkflowScript,
  checkSiteStability,
  collectPhaseNames,
  collectSites,
  createWorkflowProgram,
  interpret,
  projectControlFlow,
  spliceHoleBody,
  type SiteTable,
  type WorkflowProgram,
} from "@zcode/dynamic-workflow";
import { compileProgram } from "./dynamic-workflow-run-compile.js";
import { mapFillDiagnostics, unboundFillModelDiagnostics } from "./dynamic-workflow-run-holes.js";
import {
  isRunLiveInThisProcess,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service.js";

/** 本模块借用的 service 内部状态；全是引用，本文件不持有任何自己的状态。 */
export interface DynamicWorkflowRunFillContext {
  deps: DynamicWorkflowRunServiceDeps;
  runs: Map<string, RunRegistryEntry>;
  /**
   * 每个 run 的补全串行链（见 {@link fillDynamicWorkflowHole}）：runId → 该 run 最后一次排进去的
   * 补全。链排空即删键，不随 run 的一生常驻。由 service 持有一张。
   */
  fillQueues: Map<string, Promise<unknown>>;
}

/**
 * 同一个 run 的补全**串行**执行。Bug 根因（2026-09-28 评审）：一个 run 可以同时停在两处留白
 * （两个 future 各一处、或两个分支各一处），模型也会把两次 FillWorkflowHole 放进同一个并行批里；
 * 本函数从读 `entry.scriptText` 到把有效脚本交给引擎之间有 await（没有草稿时先铸草稿），第二次
 * 调用就会拿**第一次补全之前**的文本去拼，引擎的 `updateRunScript` 随后把第一个函数体整个盖掉。
 * 所以每次补全都排在该 run 上一次补全**完全返回**之后才开始，并在自己的轮到时才读脚本；上一次被
 * 拒绝（甚至抛错）不阻塞下一次。不同 run 之间互不排队。
 */
export function fillDynamicWorkflowHole(
  ctx: DynamicWorkflowRunFillContext,
  request: DynamicWorkflowRunFillHoleRequest,
): Promise<FillWorkflowHoleResult> {
  const { runId } = request;
  const previous = ctx.fillQueues.get(runId) ?? Promise.resolve();
  const turn = previous.then(
    () => fillOnce(ctx, request),
    () => fillOnce(ctx, request),
  );
  // 链上挂的是「结束了」这个事实，成败都算；链排空即删键（只删仍是自己的那条）。
  const settled: Promise<unknown> = turn.then(
    () => undefined,
    () => undefined,
  );
  ctx.fillQueues.set(runId, settled);
  void settled.then(() => {
    if (ctx.fillQueues.get(runId) === settled) ctx.fillQueues.delete(runId);
  });
  return turn;
}

/** run 没有名字、阶段表也空时铸草稿用的兜底名（与工具侧的兜底词同一个）。 */
const DRAFT_FALLBACK_NAME = "workflow";

type Refusal = Extract<FillWorkflowHoleResult, { ok: false }>;

async function fillOnce(
  ctx: DynamicWorkflowRunFillContext,
  request: DynamicWorkflowRunFillHoleRequest,
): Promise<FillWorkflowHoleResult> {
  const { deps, runs } = ctx;
  const { runId, holeId } = request;
  const entry = runs.get(runId);
  const record = deps.journal.getRun(runId);
  if (entry === undefined && record === undefined) {
    return refuse("run_not_found", `No run with id ${runId}.`);
  }
  // 在飞判定看**本进程注册表**：journal 说 running 而这里没有它，是别的进程（或死进程）的 run，
  // 本 service 够不着它的引擎。停下的 run 指向 ResumeWorkflowRun——resume 会重新到达留白、再问一次。
  if (!isRunLiveInThisProcess(entry)) {
    const status = entry?.terminal?.status ?? record?.status;
    const hint =
      status === "stopped"
        ? `Run ${runId} is stopped; ResumeWorkflowRun it first, after which the hole asks again.`
        : status === "completed" || status === "errored"
          ? `Run ${runId} has ended (${status}); nothing is waiting.`
          : `Run ${runId} is not in flight in this session.`;
    return refuse("hole_not_waiting", hint);
  }

  // 2. run 此刻的脚本（条目上的就是引擎手里的那份：一次补全会同步换掉它）。在自己轮到时才读——
  //    排在前面的补全已经把它换成了带那个函数体的有效脚本。
  const scriptText = entry.scriptText;
  const workflow = createWorkflowProgram(scriptText);
  const before = collectSites(workflow);
  const site = before.holes.find((hole) => hole.id === holeId);
  if (site === undefined) {
    const known = before.holes.map((hole) => `${hole.id} (${hole.name ?? "?"})`).join(", ");
    return refuse(
      "hole_not_waiting",
      `${holeId} is not a hole of run ${runId}${known === "" ? "" : `; its holes are ${known}`}.`,
    );
  }
  if (site.body !== undefined) {
    return refuse("hole_not_waiting", `${holeId} of run ${runId} is already filled.`);
  }

  // 3. 拼接 + 与提交同款的分析（9012 与其余 authoring 规则都在里面）。
  const spliced = spliceHoleBody(scriptText, before, holeId, request.body);
  if (spliced === undefined) {
    return refuse("hole_not_waiting", `${holeId} of run ${runId} cannot take a body.`);
  }
  // 模型名只能取本 run 的绑定表（见 unboundFillModelDiagnostics）：表在条目上，补全按 run 串行，
  // 所以这里读到的就是子代理建会话时会查的那一张。
  const analysis = analyzeWorkflowScript(spliced.text);
  const diagnostics = analysis.ok
    ? unboundFillModelDiagnostics(analysis.modelReferences, entry.modelBindings)
    : analysis.diagnostics;
  if (diagnostics.length > 0) {
    return {
      ok: false,
      reason: "compile_failed",
      message: `The effective script does not compile (${diagnostics.length} diagnostic${
        diagnostics.length === 1 ? "" : "s"
      }); nothing was spliced and the hole is still waiting.`,
      diagnostics: mapFillDiagnostics({
        diagnostics,
        effectiveText: spliced.text,
        body: request.body,
        insertedAtLine: spliced.insertedAtLine,
        insertedLines: spliced.insertedLines,
      }),
    };
  }

  // 4. 稳定性复核在编译产物之前：编译（schema 合成、lowering）对一份 id 会错位的脚本是白付。
  const effective = createWorkflowProgram(spliced.text);
  const after = collectSites(effective);
  const stability = checkSiteStability(
    before,
    after,
    holeId,
    spliced.insertedAtLine,
    spliced.insertedLines,
  );
  if (!stability.ok) {
    deps.logger?.error?.("Dynamic workflow hole fill renumbered an existing site", undefined, {
      detail: stability.detail,
      event: "dynamic_workflow.fill.ids_unstable",
      holeId,
      module: "bootstrap.app",
      runId,
    });
    return refuse(
      "fill_ids_unstable",
      `The compiled effective script renumbered an existing site (${stability.detail}). This is a host fault, not a problem with the body; the hole is still waiting.`,
    );
  }
  const compiled = compileProgram(spliced.text, effective, after);
  const code = compiled.holeBodies[holeId];
  if (code === undefined) {
    // 拼接成功、稳定性通过，lowering 却没给出这处留白的函数体：只可能是分析器与 lowering 的
    // 契约漂移。按宿主故障报，而不是把 undefined 递给引擎。
    return refuse(
      "fill_ids_unstable",
      `Lowering produced no body for ${holeId}; this is a host fault and the hole is still waiting.`,
    );
  }

  // 5. 交给引擎（一个同步步骤：换表、写回有效脚本、记 hole-filled、放行停驻的分支）。没有草稿的
  //    run 先铸一份（见文件头），路径随事件落 journal。
  const minted =
    entry.scriptPath === undefined ? await mintDraft(ctx, entry, spliced.text) : undefined;
  const filledBy =
    request.parentSessionId === undefined ? {} : { filledBy: String(request.parentSessionId) };
  const result = entry.control.fillHole({
    siteId: holeId,
    code,
    script: { text: spliced.text, hash: compiled.scriptHash },
    askSpecs: compiled.askSpecs,
    sitePhases: compiled.sitePhases,
    phaseNames: compiled.phases.phaseNames,
    ...(compiled.phases.holes.length === 0 ? {} : { holes: compiled.phases.holes }),
    ...filledBy,
    ...(minted === undefined ? {} : { scriptPath: minted }),
  });
  if (result === undefined || !result.ok) {
    if (minted !== undefined) await discardMintedDraft(ctx, runId, minted);
    const reason = result?.reason;
    deps.logger?.info?.("Dynamic workflow hole fill refused by the engine", {
      event: "dynamic_workflow.fill.refused",
      holeId,
      module: "bootstrap.app",
      reason: reason ?? "engine_unbound",
      runId,
    });
    return refuse(
      "hole_not_waiting",
      reason === "settled"
        ? `Run ${runId} has already settled; nothing is waiting.`
        : `Run ${runId} is not waiting at ${holeId}: it has not reached it yet, or it is already filled.`,
    );
  }

  // 6. 引擎收下了：宿主侧的事实跟着换（脚本、留白表、阶段表描述的必须是同一份脚本），再写草稿。
  const previousPhases = phaseNamesOf(workflow, before);
  entry.scriptText = spliced.text;
  entry.holes = compiled.holes;
  entry.phaseNames = compiled.phases.phaseNames;
  if (minted !== undefined) entry.scriptPath = minted;
  else await rewriteDraft(ctx, entry, runId, spliced.text);
  const scriptPath = entry.scriptPath;
  deps.logger?.info?.("Dynamic workflow hole filled", {
    event: "dynamic_workflow.fill.applied",
    holeId,
    module: "bootstrap.app",
    runId,
    ...(scriptPath === undefined ? {} : { scriptPath }),
  });
  return {
    ok: true,
    phasesAdded: compiled.phases.phaseNames.filter((name) => !previousPhases.has(name)),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    scriptText: spliced.text,
  };
}

function refuse(reason: Refusal["reason"], message: string): Refusal {
  return { ok: false, reason, message };
}

/** 拼接前脚本的阶段表（同一条投影规则），`phasesAdded` 的比对基准。 */
function phaseNamesOf(workflow: WorkflowProgram, table: SiteTable): Set<string> {
  return new Set(collectPhaseNames(projectControlFlow(interpret(workflow, table))).phaseNames);
}

/**
 * 草稿的就地改写（docs/dynamic-workflow/launch.md「The draft after a fill」）：run 有草稿就改写
 * 那个文件、路径不变——这是「草稿绝不在模型背后被覆盖」的唯一例外，模型要的正是这次写入。
 * 尽力而为：写不进去只记一条 warn，路径照旧（文件还在，只是内容旧了，日志说了原因）。
 */
async function rewriteDraft(
  ctx: DynamicWorkflowRunFillContext,
  entry: RunRegistryEntry,
  runId: string,
  text: string,
): Promise<void> {
  if (entry.scriptPath === undefined) return;
  try {
    await writeFile(entry.scriptPath, text, "utf8");
  } catch (error) {
    ctx.deps.logger?.warn?.("Dynamic workflow draft could not be rewritten after a fill", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.fill.draft_rewrite_failed",
      module: "bootstrap.app",
      runId,
      scriptPath: entry.scriptPath,
    });
  }
}

/**
 * 没有草稿的 run 按内联规则铸一份（规则在工具层，经 deps 注入）；铸不成（没注入、写不进去）回
 * `undefined`——补全照常成功，只是回话里没有路径。
 */
async function mintDraft(
  ctx: DynamicWorkflowRunFillContext,
  entry: RunRegistryEntry,
  text: string,
): Promise<string | undefined> {
  const minted = await ctx.deps.writeWorkflowDraft?.({
    cwd: entry.cwd,
    name: entry.name ?? entry.phaseNames?.[0] ?? DRAFT_FALLBACK_NAME,
    source: text,
  });
  return minted?.path;
}

/** 引擎拒绝了这次补全：刚为它铸的草稿谁都还没见过，删掉（见文件头）；删不掉只记日志。 */
async function discardMintedDraft(
  ctx: DynamicWorkflowRunFillContext,
  runId: string,
  path: string,
): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    ctx.deps.logger?.warn?.(
      "Dynamic workflow draft minted for a refused fill could not be removed",
      {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "dynamic_workflow.fill.minted_draft_orphaned",
        module: "bootstrap.app",
        runId,
        scriptPath: path,
      },
    );
  }
}
