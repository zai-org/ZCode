// ============================================================
// AmendWorkflow：确认之前的一切（resolveInput 与它的结构化失败）
// ============================================================
//
// 从 amend-workflow.ts 拆出：那边是 handler 与工具声明，这里是**全流程唯一一次读端口**——把模型
// 的入参归一成「将要发生的执行事实」。每个可省略的字段守同一条规则（省略即沿用前驱），三样都在这里
// 落定：脚本（三条来路，见 amend-workflow-source.ts）、并发上界、子代理模型。此后 hook、权限、
// 确认窗与 handler 面对的只有「一份脚本、一个数或没有、一个规范形或没有」。

import {
  AmendWorkflowInputSchema,
  type AmendWorkflowInput,
  type ModelCatalogPort,
} from "@zcode/contracts";
import type {
  ToolHandlerFailure,
  ToolInputResolutionContext,
  ToolInputResolutionResult,
} from "../types.js";
import { SUBAGENT_MODEL_UNAVAILABLE } from "./create-workflow-source.js";
import { resolveConcurrencyRetuneRoute } from "./amend-workflow-retune.js";
import {
  AMEND_WORKFLOW_ERROR_CODE,
  describePredecessor,
  refuseUnchangedScript,
  resolveAmendMaxConcurrency,
  resolveAmendScript,
} from "./amend-workflow-source.js";
import { resolveModelReference } from "./model-reference.js";
import { withScriptModelBindings } from "./workflow-script-models.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";

export {
  AMEND_WORKFLOW_ERROR_CODE,
  resolveAmendMaxConcurrency,
  scriptUnavailableFailure,
  validateAmendWorkflowSource,
} from "./amend-workflow-source.js";

/** 规范串里 provider 与模型之间的分隔符（`providerId/modelId[$level]`）。 */
const CANONICAL_PROVIDER_SEPARATOR = "/";

/** 前驱不存在：复用内省工具的 `run_not_found`，只补一句点名 `run_id`。 */
export function predecessorNotFoundFailure(runId: string): ToolHandlerFailure {
  const base = workflowRunNotFoundFailure(runId);
  return {
    ...base,
    message: `${base.message} Nothing was stopped or created: \`run_id\` pointed at a run that does not exist — pass an existing run's ID (see ListWorkflowRuns), or start a fresh run with CreateWorkflow.`,
  };
}

/** 前驱在别的进程里跑：本进程停不了它，修订无从开始。终态之后才能从这里修订。 */
function heldElsewhereFailure(runId: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.HELD_ELSEWHERE,
    message: `workflow_run_held_elsewhere: run ${runId} is running in another session's process, so this session cannot stop it to start a revision. Nothing was stopped or created. Amend it from the session that started it, or amend it from here once it has ended.`,
  };
}

/**
 * 全流程唯一一次读端口：把 `run_id` 解析成 `predecessor` 事实块回填进入参。
 *
 * 权限判定（本会话的 run 免确认，permission/service.ts）与确认窗（「仍在运行，将被停止」）都
 * 读它，而两处都在 handler 之前且必须同步，所以只能在这里算好。**无条件覆盖**模型给的任何
 * `predecessor`：伪造它是无效的。前驱不存在在这里就收口——不弹一次注定失败的确认窗。
 *
 * 顺序不能换：前驱查找（不存在就是 `run_not_found`，与脚本无关）→ 落定脚本（读文件或读前驱
 * 存档；读不出来点名原因）→ 比字节（`script_unchanged`）。倒过来做的话，一个指向不存在的 run 的
 * 调用会先因为文件读不出来而报错，模型就会去修一个根本不是问题的东西。
 *
 * 端口缺席（未接线的宿主）时，给了脚本（内联或文件）就原样放行：handler 会走「只 typecheck、
 * 不执行」那条路，与 CreateWorkflow 同形；权限侧读不到 `predecessor` 就照常 ask。两个来源都没给
 * 则无从沿用，当场失败——不能退化成「只 typecheck」，因为没有可编译的东西。
 */
export async function resolveAmendWorkflowInput(
  input: unknown,
  context: ToolInputResolutionContext,
): Promise<ToolInputResolutionResult> {
  const parsed = AmendWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };
  const cwd = context.workingDirectory ?? ".";
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined) {
    const {
      predecessor: _forged,
      max_concurrency: requested,
      subagent_model: _model,
      script_line_offset: _offset,
      ...rest
    } = parsed.data;
    void _forged;
    void _model;
    void _offset;
    // 没有端口就既没有前驱也没有默认并发：`null`（解除）与「沿用」都塌成缺席，数原样过。
    // 归一化后的入参此后永远只有「一个数或没有」这一种形状。
    const subagentModel = resolveAmendSubagentModel(
      parsed.data.subagent_model,
      undefined,
      context.modelCatalogPort,
    );
    if (!subagentModel.result) return subagentModel;
    const script = await resolveAmendScript({
      model: parsed.data,
      cwd,
      port,
      predecessorScriptPath: undefined,
    });
    if (!script.result) return script;
    return {
      result: true,
      // 没有端口就没有前驱可沿用：脚本点名的模型一律对着目录重新解析。
      input: withScriptModelBindings(
        {
          ...rest,
          ...script.fields,
          ...(typeof requested === "number" ? { max_concurrency: requested } : {}),
          ...subagentModel.field,
        },
        context.modelCatalogPort,
      ),
    };
  }
  const snapshot = await port.getTask(parsed.data.run_id);
  if (snapshot === undefined) return predecessorNotFoundFailure(parsed.data.run_id);
  const predecessor = describePredecessor(snapshot, context.sessionId);
  // 路由在这里分岔，而且只能在这里：刚读完前驱（于是知道它还活不活），入参形状又摆在眼前
  // （于是知道除并发外有没有别的要变）。命中即就地调并发——不读脚本、不继承、不编译，
  // 归一化后的入参因此**没有 script**，那也是 handler 与 prepareApproval 认出这条路的凭据。
  const retune = resolveConcurrencyRetuneRoute({
    model: parsed.data,
    port,
    predecessor,
    inherited: snapshot.maxConcurrency,
  });
  if (retune !== undefined) return retune;
  // 这里曾放行：用户批准后，服务停不了别的进程的 run，导入缓存又要求前驱已结算，只能抛宿主故障。
  if (snapshot.status === "running" && snapshot.liveInThisProcess === false) {
    return heldElsewhereFailure(parsed.data.run_id);
  }
  const subagentModel = resolveAmendSubagentModel(
    parsed.data.subagent_model,
    snapshot.subagentModel,
    context.modelCatalogPort,
  );
  if (!subagentModel.result) return subagentModel;
  const script = await resolveAmendScript({
    model: parsed.data,
    cwd,
    port,
    predecessorScriptPath: snapshot.scriptPath,
  });
  if (!script.result) return script;
  const unchanged = await refuseUnchangedScript({
    port,
    model: parsed.data,
    resolvedScript: script.fields.script,
    described: script.described,
  });
  if (unchanged !== undefined) return unchanged;
  const {
    predecessor: _forged,
    max_concurrency: _tristate,
    subagent_model: _model,
    // 行偏移与 `predecessor` 同一姿态：解析结果，模型给的一律作废（下面按文件重算）。
    script_line_offset: _offset,
    ...rest
  } = parsed.data;
  void _forged;
  void _model;
  void _offset;
  const resolved: AmendWorkflowInput = {
    ...rest,
    ...script.fields,
    ...resolveAmendMaxConcurrency(parsed.data.max_concurrency, snapshot.maxConcurrency),
    ...subagentModel.field,
    predecessor: {
      ...predecessor,
      ...(script.inherited ? { script_inherited: true as const } : {}),
    },
  };
  // 脚本点名的模型：同名沿用前驱 run-launched 上的绑定（用户在前驱确认窗里换过的模型因此留得住），
  // 新名字对着目录解析（docs/dynamic-workflow/launch.md「The `AmendWorkflow` tool」）。
  const bound = withScriptModelBindings(resolved, context.modelCatalogPort, snapshot.modelBindings);
  // 最后一步、在绑定表落定之后：新 provider 只能从归一化后的模型里读，读模型给的原文会漏掉脚本绑定。
  const introduced = introducedProviders(bound, snapshot, context.modelCatalogPort);
  return {
    result: true,
    input:
      introduced.length === 0
        ? bound
        : {
            ...bound,
            predecessor: { ...resolved.predecessor, introduces_providers: introduced },
          },
  };
}

/**
 * 这次修订将让子代理用上、而会话与前驱都没用过的 provider（去重、字母序）——
 * `predecessor.introduces_providers` 的唯一来源（docs/dynamic-workflow/launch.md「Amending this
 * session's runs」）。
 *
 *   - 用过：会话当前模型的 provider，以及前驱 `run-launched` 上的子代理模型与脚本绑定的 provider。
 *     前驱的选择在它自己那次确认窗里被用户批过，沿用或在同一 provider 下换名字都不是新的选择。
 *   - 将用：归一化后的 `subagent_model`（缺席即会话模型，不会是新的）与 `model_bindings` 的值。
 *
 * 目录缺席时读不到会话的 provider，只与前驱比：那时模型给的模型名本来就解析不了（整次调用失败），
 * 能走到这里的只有沿用来的，而沿用来的都在「用过」里。
 */
function introducedProviders(
  input: Record<string, unknown>,
  snapshot: { subagentModel?: string; modelBindings?: Record<string, string> },
  catalog: ModelCatalogPort | undefined,
): string[] {
  const used = new Set<string>();
  const sessionProvider = catalog?.listModels().find((entry) => entry.current)?.providerId;
  if (sessionProvider !== undefined) used.add(sessionProvider);
  for (const model of [snapshot.subagentModel, ...Object.values(snapshot.modelBindings ?? {})]) {
    const provider = providerOfCanonical(model);
    if (provider !== undefined) used.add(provider);
  }
  const bindings = input.model_bindings;
  const next = [
    input.subagent_model,
    ...(typeof bindings === "object" && bindings !== null ? Object.values(bindings) : []),
  ];
  const introduced = new Set<string>();
  for (const model of next) {
    const provider = providerOfCanonical(model);
    if (provider !== undefined && !used.has(provider)) introduced.add(provider);
  }
  return [...introduced].sort();
}

/** 规范串 `providerId/modelId[$level]` 的 provider 段；不是规范串即缺席。 */
function providerOfCanonical(model: unknown): string | undefined {
  if (typeof model !== "string") return undefined;
  const separator = model.indexOf(CANONICAL_PROVIDER_SEPARATOR);
  return separator > 0 ? model.slice(0, separator) : undefined;
}

/**
 * 子代理模型的三态归一，与并发上界
 * 同一条形状约定——三态只活到这里，确认窗与 handler 之后面对的只有「一个规范形或没有」：
 *
 *   - 字符串 → 解析；解不出来整次调用失败（什么都没停、没建，窗也不开）。
 *   - `null` → 解除，键整个消失（新 run 跑回会话模型）。
 *   - 省略 → 沿用前驱快照的那一个，并**重新解析一遍**。前驱可能是几天前起的，那个模型此后
 *     可能被删掉或停用；不重解的话失败要等到子代理第一次开口时才发生，那时看起来像运行时故障。
 *
 * 目录缺席时两种来源分开处理：模型自己给的字符串照 `CreateWorkflow` 拒掉（宿主解不了的东西
 * 不静默放行），而**沿用**的那一个原样带过去——它在前驱那一次已经被解析过，为一个这次调用
 * 根本没提到的字段让整次修订失败，是把一个宿主接线缺口记到用户头上。
 */
function resolveAmendSubagentModel(
  requested: string | null | undefined,
  inherited: string | undefined,
  catalog: ModelCatalogPort | undefined,
): { result: true; field: { subagent_model?: string } } | ToolHandlerFailure {
  const choice = resolveAmendSubagentModelChoice(requested, inherited, catalog);
  if (choice.ok) {
    return {
      result: true,
      field: choice.canonical === undefined ? {} : { subagent_model: choice.canonical },
    };
  }
  // 沿用的那一个失败时必须说清它是**继承来的**：模型这次调用压根没提模型名，直接把解析
  // 诊断丢给它，它会以为自己传错了参数，然后原样重试。
  return subagentModelFailure(
    choice.inherited
      ? `This amend inherited the predecessor run's subagent model (\`${choice.text}\`), which is no longer usable. ${choice.message}\n\nPass \`subagent_model: null\` to run the revision on the session model instead.`
      : choice.message,
  );
}

/**
 * 子代理模型三态的**判定本体**，工具与 GUI「配置」（runtime 的 amendWorkflowRunSettings）共用
 * （共享解析代码，不复制）。两者只在怎么**说**失败
 * 上不同——工具对模型说（带 `subagent_model: null` 的建议），GUI 对人说（诊断进 ACK 的 message）。
 *
 * 结果：`canonical` 缺席即「会话模型」；失败带 `inherited`（失败的是沿用来的那一个）与解析诊断。
 */
export function resolveAmendSubagentModelChoice(
  requested: string | null | undefined,
  inherited: string | undefined,
  catalog: ModelCatalogPort | undefined,
):
  | { ok: true; canonical?: string }
  | { ok: false; inherited: boolean; text: string; message: string } {
  if (requested === null) return { ok: true };
  const text = requested ?? inherited;
  if (text === undefined) return { ok: true };
  if (catalog === undefined) {
    return requested === undefined
      ? { ok: true, canonical: text }
      : { ok: false, inherited: false, text, message: SUBAGENT_MODEL_UNAVAILABLE };
  }
  const resolution = resolveModelReference(text, catalog.listModels());
  if (!resolution.ok) {
    return { ok: false, inherited: requested === undefined, text, message: resolution.message };
  }
  return { ok: true, canonical: resolution.canonical };
}

/** 解析失败 → 结构化业务失败。判别键在 message 前缀（同本文件其余几个码）。 */
function subagentModelFailure(message: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.SUBAGENT_MODEL,
    message: `workflow_subagent_model_unresolved: ${message} Nothing was stopped or created.`,
  };
}
