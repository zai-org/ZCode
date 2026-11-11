// ============================================================
// FillWorkflowHole：确认之前的一切（resolveInput 与它的结构化失败）
// ============================================================
// docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」→「Input and output」「Approval」。
//
// 从 fill-workflow-hole.ts 拆出（与 amend-workflow-resolve.ts 同一条分法）：那边是 handler 与工具
// 声明，这里是**全流程唯一一次读端口**——把模型的入参归一成「将要发生的执行事实」：函数体的字节
// （内联或读文件）、留白是不是这个 run 正在等的、它归不归本会话、草稿在哪。此后权限、确认窗与
// handler 面对的只有一份函数体与一个 `hole` 事实块。

import { readFile } from "node:fs/promises";
import {
  FILL_WORKFLOW_HOLE_SOURCE_ERROR,
  FillWorkflowHoleInputSchema,
  type DynamicWorkflowRunHole,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSnapshot,
  type FillWorkflowHoleHole,
  type FillWorkflowHoleInput,
} from "@zcode/contracts";
import type {
  ToolHandlerFailure,
  ToolInputResolutionContext,
  ToolInputResolutionResult,
} from "../types.js";
import { spliceHoleBodyPreview } from "./fill-workflow-hole-splice.js";
import { resolveWorkflowScriptFilePath } from "./workflow-path-source.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";

/**
 * 本地失败码表。数值只是日志位（executor 投影成 `code: "N"`），判别键在 message 前缀；
 * `run_not_found` 复用内省表的同键同码。从 31 起编只为与内省表（1/2）、ResumeWorkflowRun（11–15）、
 * ResolveWorkflowQuestion（21–24）、AmendWorkflow（21–29）视觉不撞车——各表的数值空间互相独立。
 */
export const FILL_WORKFLOW_HOLE_ERROR_CODE = {
  FILL_UNAVAILABLE: 31,
  HOLE_NOT_WAITING: 32,
  FILL_UNCHANGED: 33,
  FILL_FILE: 34,
  IDS_UNSTABLE: 35,
  BODY_UNAVAILABLE: 36,
} as const;

/** 入参级违规（来源不是恰好一个）的码，与 CreateWorkflow / AmendWorkflow 的同一个 400。 */
const FILL_WORKFLOW_HOLE_INPUT_FAILURE_CODE = 400;

/**
 * 函数体来源**恰好一个**，只对模型发出的入参成立（归一化之后 `script` 与 `path` 同时在场是合法
 * 执行态：`path` 的字节读进了 `script`）。两个都不给也是违规——没有可沿用的函数体。
 */
export function validateFillWorkflowHoleSource(
  input: unknown,
): { result: true } | ToolHandlerFailure {
  const parsed = FillWorkflowHoleInputSchema.safeParse(input);
  if (!parsed.success) return { result: true };
  const sources = [parsed.data.script, parsed.data.path].filter((value) => value !== undefined);
  if (sources.length === 1) return { result: true };
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_INPUT_FAILURE_CODE,
    message: FILL_WORKFLOW_HOLE_SOURCE_ERROR,
  };
}

// ------------------------------------------------------------
// 上一次被拒绝的尝试（docs/dynamic-workflow/launch.md 的 `fill_unchanged`）
// ------------------------------------------------------------
// 「一个 `path` 的字节等于这个留白上一次被拒的那份」是忘了编辑，要在开窗之前抓住。每会话一张表，
// 键是 (session, run, hole)：handler 在端口报 `compile_failed` 时记下那份字节，resolveInput 对
// `path` 提交比对。只对 `path` 成立——内联再贴一遍会铸一个新的 fill 文件，那是另一种错误，由诊断说。

const rejectedFills = new Map<string, string>();

function rejectionKey(sessionId: string | undefined, runId: string, holeId: string): string {
  return `${sessionId ?? ""}\u0000${runId}\u0000${holeId}`;
}

export function rememberRejectedFill(
  sessionId: string | undefined,
  runId: string,
  holeId: string,
  body: string,
): void {
  rejectedFills.set(rejectionKey(sessionId, runId, holeId), body);
}

/** 测试用：清空「上一次被拒」表，让用例之间互不看见。 */
export function resetFillWorkflowHoleRejectionsForTests(): void {
  rejectedFills.clear();
  preview = undefined;
}

// ------------------------------------------------------------
// 确认窗的预览（docs/dynamic-workflow/launch.md「Approval」）
// ------------------------------------------------------------
// prepareApproval 是同步的、只拿得到入参，而有效脚本要读端口（run 的脚本）才拼得出来。所以
// resolveInput 拼好之后记在一个**单槽**里，prepareApproval 按 (run, hole, body) 认领——与
// workflow-script-analysis.ts 的单槽记忆同一种姿态：值得收敛的重复只有这组紧邻的前后调用。

/** 单槽里的一份预览：有效脚本，加上 run 的模型绑定表（prepareApproval 据它判断函数体点名的模型）。 */
export interface FillPreview {
  effectiveScript: string;
  modelBindings: Record<string, string>;
}

let preview: ({ runId: string; holeId: string; body: string } & FillPreview) | undefined;

/** prepareApproval 取预览：入参对得上就给有效脚本与绑定表，否则 `undefined`（窗照开，只是没图）。 */
export function takeFillPreview(
  runId: string,
  holeId: string,
  body: string,
): FillPreview | undefined {
  if (preview === undefined) return undefined;
  if (preview.runId !== runId || preview.holeId !== holeId || preview.body !== body)
    return undefined;
  return { effectiveScript: preview.effectiveScript, modelBindings: preview.modelBindings };
}

// ------------------------------------------------------------
// resolveInput
// ------------------------------------------------------------

/**
 * 全流程唯一一次读端口：把 `run_id` + `hole_id` 解析成 `hole` 事实块回填进入参。
 *
 * 顺序不能换：run 查找（不存在就是 `run_not_found`，与函数体无关）→ 留白是不是在等（终态 run、
 * 未知 id、已补过都在这里收口——不弹一次注定失败的确认窗）→ 落定函数体（读文件；读不出来点名文件）
 * → 比字节（`fill_unchanged`）→ 回填事实块、拼预览。**无条件覆盖**模型给的任何 `hole`：伪造无效。
 *
 * 端口缺席（未接线的宿主）时函数体照常落定、原样放行：handler 会回「本会话不能补全」的结构化失败，
 * 权限侧读不到 `hole` 就照常 ask。
 */
export async function resolveFillWorkflowHoleInput(
  input: unknown,
  context: ToolInputResolutionContext,
): Promise<ToolInputResolutionResult> {
  const parsed = FillWorkflowHoleInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };
  const cwd = context.workingDirectory ?? ".";
  const { hole: _forged, ...model } = parsed.data;
  void _forged;
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined) {
    const body = await resolveFillBody(model, cwd);
    if (!body.result) return body;
    return { result: true, input: { ...model, ...body.fields } satisfies FillWorkflowHoleInput };
  }

  const snapshot = await port.getTask(model.run_id);
  if (snapshot === undefined) return runNotFoundFailure(model.run_id);
  const waiting = findWaitingHole(snapshot, model.run_id, model.hole_id);
  if (waiting !== undefined && "result" in waiting) return waiting;

  const body = await resolveFillBody(model, cwd);
  if (!body.result) return body;
  if (model.path !== undefined) {
    const rejected = rejectedFills.get(
      rejectionKey(context.sessionId, model.run_id, model.hole_id),
    );
    if (rejected !== undefined && rejected === body.fields.script) {
      return unchangedFillFailure(body.described ?? model.path, model.run_id, model.hole_id);
    }
  }

  const hole =
    waiting === undefined ? undefined : describeHole(snapshot, waiting, context.sessionId);
  await rememberFillPreview(port, model.run_id, model.hole_id, body.fields.script, snapshot);
  return {
    result: true,
    input: {
      ...model,
      ...body.fields,
      ...(hole === undefined ? {} : { hole }),
    } satisfies FillWorkflowHoleInput,
  };
}

function runNotFoundFailure(runId: string): ToolHandlerFailure {
  const base = workflowRunNotFoundFailure(runId);
  return {
    ...base,
    message: `${base.message} Nothing was filled: \`run_id\` pointed at a run that does not exist — take it from the hole notification or from ListWorkflowRuns.`,
  };
}

/**
 * 这个留白是不是 run 正在等的。三种「不是」都回 `hole_not_waiting`，message 说明是哪一种
 * （docs/dynamic-workflow/launch.md 的拒绝表）：run 不在飞（停了就指向 ResumeWorkflowRun——恢复后
 * 留白会重新提问）、id 未知或还没到达、已经补过。快照没有 `holes` 表（老宿主）时回 `undefined`：
 * 无从判断，交给端口。
 */
function findWaitingHole(
  snapshot: DynamicWorkflowRunSnapshot,
  runId: string,
  holeId: string,
): DynamicWorkflowRunHole | ToolHandlerFailure | undefined {
  const status = snapshot.runStatus;
  if (status === "stopped") {
    return notWaitingFailure(
      `run ${runId} is stopped (${snapshot.stopReason ?? "unknown reason"}), so nothing is waiting at ${holeId}. Continue it with ResumeWorkflowRun first; the hole will ask again once the script reaches it.`,
    );
  }
  if (status === "completed" || status === "errored") {
    return notWaitingFailure(
      `run ${runId} has already ${status}, so nothing is waiting at ${holeId}.`,
    );
  }
  // 这里曾放行到端口：窗照开（`holes` 缺席，窗里只有裸的站点 id），用户批准后端口再拒绝。
  if (snapshot.liveInThisProcess === false) {
    return notWaitingFailure(
      `run ${runId} is not running in this session's process, so this session cannot reach its engine. Only the session that started it can fill ${holeId}: ask the user to do it there. If that session has exited, the run is interrupted; ResumeWorkflowRun brings the hole back.`,
    );
  }
  const holes = snapshot.holes;
  if (holes === undefined) return undefined;
  const entry = holes.find((hole) => hole.siteId === holeId);
  if (entry === undefined) {
    return notWaitingFailure(
      `run ${runId} is not waiting at ${holeId}: no hole with that id has been reached (unknown id, or the script has not got there yet). GetWorkflowRun lists the holes it is waiting at.`,
    );
  }
  if (entry.state !== "waiting") {
    return notWaitingFailure(
      `hole ${holeId} ("${entry.name}") of run ${runId} is already filled; the branch has resumed with that body. To change what it does, edit the run's draft and use AmendWorkflow.`,
    );
  }
  return entry;
}

function notWaitingFailure(detail: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.HOLE_NOT_WAITING,
    message: `hole_not_waiting: ${detail} Nothing was filled.`,
  };
}

function unchangedFillFailure(
  described: string,
  runId: string,
  holeId: string,
): ToolHandlerFailure {
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_UNCHANGED,
    message: `fill_unchanged: ${described} is byte-for-byte the body that was just rejected for hole ${holeId} of run ${runId}, so resubmitting it would fail the same way. Edit the file first (the diagnostics name the lines), then call FillWorkflowHole again with the same \`path\`. Nothing was filled.`,
  };
}

/**
 * `hole` 事实块。`owned_by_this_session` 已折进 amend 规则的两个条件（本会话发起、且不是用户亲手
 * 停下的）——权限服务只读这一位（docs/dynamic-workflow/launch.md「Approval」）。
 */
function describeHole(
  snapshot: DynamicWorkflowRunSnapshot,
  entry: DynamicWorkflowRunHole,
  sessionId: string | undefined,
): FillWorkflowHoleHole {
  const owned =
    sessionId !== undefined &&
    snapshot.parentSessionId !== undefined &&
    snapshot.parentSessionId === sessionId &&
    snapshot.stopReason !== "user";
  return {
    name: entry.name,
    type: entry.type,
    ...(snapshot.scriptPath === undefined ? {} : { draft_path: snapshot.scriptPath }),
    ...(entry.line === undefined ? {} : { line: entry.line }),
    owned_by_this_session: owned,
  };
}

/** 归一化出来的函数体字段（两条来源同形），外加模型面该看到的文件写法。 */
type FillBodyResolution =
  | { result: true; fields: { script: string; path?: string }; described?: string }
  | ToolHandlerFailure;

/**
 * 两条来源归一成同一组字段。`path` 逐字节读（不剥任何元数据块：fill 文件装的就是语句本身），
 * 读在 resolveInput 而不在 handler——确认窗要画将要拼入的那份字节，hook 与项目规则也要匹配到它。
 */
async function resolveFillBody(
  model: FillWorkflowHoleInput,
  cwd: string,
): Promise<FillBodyResolution> {
  if (model.path !== undefined) {
    const absolute = resolveWorkflowScriptFilePath(cwd, model.path);
    const described = describeWorkflowScriptPath(absolute, cwd);
    try {
      const script = await readFile(absolute, "utf8");
      if (script.length === 0) return fillFileFailure(`${described} is empty`);
      return { result: true, described, fields: { script, path: absolute } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fillFileFailure(`${described} could not be read: ${reason}`);
    }
  }
  if (model.script !== undefined) return { result: true, fields: { script: model.script } };
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.BODY_UNAVAILABLE,
    message: `workflow_fill_body_unavailable: ${FILL_WORKFLOW_HOLE_SOURCE_ERROR}`,
  };
}

function fillFileFailure(detail: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_FILE,
    message: `workflow_fill_file_unreadable: ${detail}. Pass \`path\` for the fill file a previous result named, or submit the body inline as \`script\`. Nothing was filled.`,
  };
}

/** 拼一次有效脚本记进单槽（读不到 run 的脚本、拼不了都只是没有预览，绝不失败）。 */
async function rememberFillPreview(
  port: DynamicWorkflowRunPort,
  runId: string,
  holeId: string,
  body: string,
  snapshot: DynamicWorkflowRunSnapshot,
): Promise<void> {
  preview = undefined;
  if (typeof port.getScript !== "function") return;
  let stored: string | undefined;
  try {
    stored = await port.getScript(runId);
  } catch {
    return;
  }
  if (stored === undefined || stored.length === 0) return;
  const effectiveScript = spliceHoleBodyPreview(stored, holeId, body);
  if (effectiveScript === undefined) return;
  // 绑定表缺席即 run 没点名过模型（快照的 `modelBindings` 只在点名过时在场）。
  preview = { runId, holeId, body, effectiveScript, modelBindings: snapshot.modelBindings ?? {} };
}
