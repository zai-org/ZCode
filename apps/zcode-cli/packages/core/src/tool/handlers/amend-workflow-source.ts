// ============================================================
// AmendWorkflow - 这次修订跑哪一份脚本
// ============================================================
//
// 脚本有三条来路，归一成同一组字段：`path`（常态：就地改过的脚本文件）、`script`（内联整份）、
// 两个都不给（沿用前驱存档的那一份）。从 resolveInput 本体（amend-workflow-resolve.ts）分出来的
// 理由与 `create-workflow-source.ts` 同一条：这里是**读世界**的地方（脚本文件、前驱存档的脚本），
// handler 是**改世界**的地方。两者搅在一起，下一个人自然会在 handler 里再读一次盘，而确认窗看到
// 的就不再是将要执行的那份字节了。

import {
  AMEND_WORKFLOW_SOURCE_ERROR,
  AmendWorkflowInputSchema,
  type AmendWorkflowInput,
  type AmendWorkflowPredecessor,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSnapshot,
} from "@zcode/contracts";
import type { ToolHandlerFailure } from "../types.js";
import { normalizeWorkflowMaxConcurrency } from "./create-workflow-source.js";
import { readWorkflowScriptFile } from "./workflow-path-source.js";

/**
 * 本地失败码表。数值只是日志位（executor 投影成 `code: "N"`），判别键在 message 前缀；
 * `run_not_found` 复用内省表的同键同码（三个工具上「被引用的 run 不存在」是同一件事）。
 * 从 21 起编只为与内省表（1/2）、ResumeWorkflowRun（11–15）视觉不撞车。
 */
export const AMEND_WORKFLOW_ERROR_CODE = {
  AMEND_UNAVAILABLE: 21,
  MISSING_BOUNDARIES: 22,
  SUBAGENT_MODEL: 23,
  SCRIPT_UNCHANGED: 24,
  SCRIPT_FILE: 25,
  SCRIPT_UNAVAILABLE: 26,
  // 只改并发那条路由自己的三个拒绝（docs/dynamic-workflow/launch.md「Changing only the
  // parallelism of a live run」）；三者都不动 run。
  RETUNE_UNCHANGED: 27,
  RUN_SETTLED: 28,
  NOT_RETUNABLE: 29,
  HELD_ELSEWHERE: 30,
} as const;

/** 入参级违规（两个来源都给了）的码，与 `CreateWorkflow` 的同一个 400。 */
const AMEND_WORKFLOW_INPUT_FAILURE_CODE = 400;

/**
 * 修订脚本**至多给一个**，只对模型发出的入参成立（理由同 `validateCreateWorkflowSource`：归一化
 * 之后 `script` 与 `path` 同时在场是合法执行态）。两个都不给不是违规——那是「沿用前驱的脚本」。
 */
export function validateAmendWorkflowSource(input: unknown): { result: true } | ToolHandlerFailure {
  const parsed = AmendWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true };
  if (parsed.data.script !== undefined && parsed.data.path !== undefined) {
    return {
      result: false,
      errorCode: AMEND_WORKFLOW_INPUT_FAILURE_CODE,
      message: AMEND_WORKFLOW_SOURCE_ERROR,
    };
  }
  return { result: true };
}

/**
 * 两个来源都省略了，却没有可沿用的脚本。两种原因同一个判别键：对模型下一步是同一件事——把脚本交上来。
 *
 *   - `record`：前驱的记录里没有脚本（脚本落库之前的老 run）；
 *   - `host`：本会话没有 run 端口，或端口不带 `getScript`（老宿主）。
 */
export function scriptUnavailableFailure(
  runId: string,
  cause: "record" | "host",
): ToolHandlerFailure {
  const why =
    cause === "record"
      ? `run ${runId} has no stored script to keep (it predates script persistence)`
      : `this host cannot read run ${runId}'s stored script`;
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.SCRIPT_UNAVAILABLE,
    message: `workflow_amend_script_unavailable: ${why}, so the script cannot be omitted here — pass the whole script as \`script\`, or its file as \`path\`. Nothing was stopped or created.`,
  };
}

/**
 * 并发上界的三态归一（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）：
 *
 *   - 数 → 向下取整到至少 1，没有上限（高于默认并发与低于它一样作数）；
 *   - `null` → 解除，键整个消失（新 run 跑在默认并发上）；
 *   - 省略 → 沿用前驱的上界，**原样**。快照**只在不等于默认时**带 `maxConcurrency`，所以「前驱
 *     没设过」与「前驱跑在默认上」在这里是同一件事：也是键消失；一个被调高过的前驱把它的数
 *     传下去。
 *
 * 三态只活到这里：确认窗与 handler 之后面对的只有「一个数或没有」。**唯一的例外是就地调并发**
 * 那条路由（amend-workflow-retune.ts）：`retuneConcurrency` 自己收 `number | null`，默认并发那个数
 * 只有端口知道，工具不该猜第二遍。
 */
export function resolveAmendMaxConcurrency(
  requested: number | null | undefined,
  inherited: number | undefined,
): { max_concurrency?: number } {
  if (requested === null) return {};
  const resolved = requested ?? inherited;
  if (resolved === undefined) return {};
  return { max_concurrency: normalizeWorkflowMaxConcurrency(resolved) };
}

/**
 * 前驱事实块（docs/dynamic-workflow/launch.md「From call to run」第 2 步）。resolveInput 与就地
 * 调并发的落回路（结算竞态里重读一次快照）共用这一份派生，免得两处对「这个 run 现在算什么状态」
 * 给出不同的答案。
 */
export function describePredecessor(
  snapshot: DynamicWorkflowRunSnapshot,
  sessionId: string | undefined,
): AmendWorkflowPredecessor {
  // 快照的 `status` 是追踪器的通用词（stopped 折成 cancelled …）；真实词在 `runStatus`，只在
  // 终态在场——非终态一律读作 running（pending 在这里与 running 无分别：都会被 amend 停下）。
  const status = snapshot.runStatus ?? "running";
  return {
    ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
    status,
    ...(snapshot.stopReason === undefined ? {} : { stop_reason: snapshot.stopReason }),
    owned_by_this_session:
      sessionId !== undefined &&
      snapshot.parentSessionId !== undefined &&
      snapshot.parentSessionId === sessionId,
  };
}

/** 归一化出来的脚本字段（三条来源同形），外加模型面该看到的文件写法与「是否沿用」。 */
export type AmendScriptResolution =
  | {
      result: true;
      fields: { script: string; path?: string; script_line_offset?: number };
      described?: string;
      inherited: boolean;
    }
  | ToolHandlerFailure;

/**
 * 三条来源归一成同一组字段。
 *
 *   - `path`：读文件。带元数据块时块被剥掉且**声明被忽略**——修订不带实参（实参是前驱那次 run
 *     的事实，随 journal 走），所以这里没有可校验的东西；块仍要剥，否则它会被当成脚本的一部分
 *     喂进编译器。
 *   - `script`：原样。
 *   - 都省略：经端口读前驱存档的那一份（resume 重放的同一份字节）。读在 resolveInput 而不在
 *     handler：确认窗要画将要跑的那份脚本的图，hook 与项目规则也要匹配到它，而这两处都在
 *     handler 之前。空串与缺席同义——运行时 schema 的 `.min(1)` 不收空脚本。沿用的脚本还要
 *     认一次家（{@link resolveKeptScriptFile}）：前驱的脚本文件若仍是这份字节，新 run 就继续
 *     记它，否则 `path` 缺席，handler 照「不来自文件的脚本」的规矩写一份新草稿。
 *
 * `port` 缺席（未接线的宿主）时前两条照常，第三条无从沿用，当场失败。
 */
export async function resolveAmendScript(options: {
  model: AmendWorkflowInput;
  cwd: string;
  port: DynamicWorkflowRunPort | undefined;
  /** 前驱快照上的脚本文件（绝对路径）；沿用脚本时用来认家。 */
  predecessorScriptPath: string | undefined;
}): Promise<AmendScriptResolution> {
  const { model, cwd, port } = options;
  if (model.path !== undefined) {
    const read = await readWorkflowScriptFile({ cwd, inputPath: model.path });
    if (!read.ok) {
      return {
        result: false,
        errorCode: AMEND_WORKFLOW_ERROR_CODE.SCRIPT_FILE,
        message: `workflow_script_file_unreadable: ${read.message} Nothing was stopped or created.`,
      };
    }
    return {
      result: true,
      inherited: false,
      described: read.file.described,
      fields: {
        script: read.file.script,
        path: read.file.path,
        ...(read.file.bodyLineOffset === 0 ? {} : { script_line_offset: read.file.bodyLineOffset }),
      },
    };
  }
  if (model.script !== undefined) {
    return { result: true, inherited: false, fields: { script: model.script } };
  }
  if (port === undefined || typeof port.getScript !== "function") {
    return scriptUnavailableFailure(model.run_id, "host");
  }
  const stored = await port.getScript(model.run_id);
  if (stored === undefined || stored.length === 0) {
    return scriptUnavailableFailure(model.run_id, "record");
  }
  const kept = await resolveKeptScriptFile({
    cwd,
    scriptPath: options.predecessorScriptPath,
    script: stored,
  });
  return {
    result: true,
    inherited: true,
    ...(kept === undefined ? {} : { described: kept.described }),
    fields: {
      script: stored,
      ...(kept === undefined
        ? {}
        : {
            path: kept.path,
            ...(kept.lineOffset === 0 ? {} : { script_line_offset: kept.lineOffset }),
          }),
    },
  };
}

/**
 * 沿用的脚本认家：前驱记下的脚本文件若**此刻**
 * 读出来仍是沿用的那份字节，新 run 就继续记这个文件——脚本没变，文件也没变，它就是新 run 的
 * 脚本文件，模型下一次修订仍去编辑它。工具的沿用与 GUI「配置」共用这一条。
 *
 * 任何一处对不上（前驱没记过文件、文件没了、读不出来、或已被改过）都回 `undefined`：调用方照
 * 「不来自文件的脚本」写一份新草稿。绝不把一个内容已经不是这份脚本的文件记到新 run 上——那会让
 * 诊断行号与「去编辑那个文件」都指向另一段代码。
 */
export async function resolveKeptScriptFile(options: {
  cwd: string;
  scriptPath: string | undefined;
  script: string;
}): Promise<{ path: string; described: string; lineOffset: number } | undefined> {
  if (options.scriptPath === undefined) return undefined;
  const read = await readWorkflowScriptFile({ cwd: options.cwd, inputPath: options.scriptPath });
  if (!read.ok || read.file.script !== options.script) return undefined;
  return {
    path: read.file.path,
    described: read.file.described,
    lineOffset: read.file.bodyLineOffset,
  };
}

/**
 * 「文件没被改过」的预检。
 *
 * 只对**模型给的** `path` 成立：这道网要抓的是**忘了编辑**，而把脚本贴一遍、或明说「脚本不动」
 * （两个来源都省略）都不是那个错误。也只在这次调用什么都没改时成立——同时设了 `max_concurrency`
 * 或 `subagent_model` 的修订有它自己的意义，脚本一字不动是合理的（`null` 算「传了」：它是一次
 * 显式解除）。
 *
 * `getScript` 是端口的可选成员，缺席就跳过这道预检：它是便利，不是正确性的门。
 */
export async function refuseUnchangedScript(options: {
  port: DynamicWorkflowRunPort;
  /** 模型发出的入参（归一化之前）：沿用时回填的 `path` 不算「模型给的」。 */
  model: AmendWorkflowInput;
  resolvedScript: string;
  described: string | undefined;
}): Promise<ToolHandlerFailure | undefined> {
  const { port, model, resolvedScript, described } = options;
  if (model.path === undefined) return undefined;
  if (model.max_concurrency !== undefined || model.subagent_model !== undefined) return undefined;
  if (typeof port.getScript !== "function") return undefined;

  const previous = await port.getScript(model.run_id);
  if (previous === undefined || previous !== resolvedScript) return undefined;
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.SCRIPT_UNCHANGED,
    message: `workflow_script_unchanged: ${described ?? model.path} is byte-for-byte the script run ${model.run_id} was started with, so amending it would repeat that run exactly. Edit the file first, then call AmendWorkflow again with the same \`path\`; to change only the settings, pass them and omit \`path\`; to continue a stopped run under the same script, use ResumeWorkflowRun. Nothing was stopped or created.`,
  };
}
