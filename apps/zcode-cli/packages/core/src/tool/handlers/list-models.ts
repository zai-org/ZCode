// ============================================================
// ListModels Tool Handler
// ============================================================
// 列出本宿主已配置的模型。
//
// 两个消费方：动态工作流的 `subagent_model`，以及会话控制 `CreateSession` 的 `model`
// （规格 0.14——那 12 个工具里没有任何一个返回模型列表，缺了它模型只能凭空编 id）。它**不是选模
// 开关**——本工具改不了会话自己的模型，描述里必须把这句话说穿，否则模型会把它当成
// 「切换我自己」的入口，然后向用户报告一个没有发生过的切换。
//
// 与解析器（model-reference.ts）是两条互补的路：那条是被动的（用户说了个名字，解不出来时
// 连同候选一起退回），这条是主动的（「我们有哪些模型可用？」）。两条读的是同一份**活**目录
// ——端口每次调用现读注册表视图，绝不返回构造期的冻结拷贝。

import {
  LIST_MODELS_TOOL_NAME,
  ListModelsInputJsonSchema,
  ListModelsInputSchema,
  ListModelsOutputJsonSchema,
  ListModelsOutputSchema,
  type ListModelsOutput,
  type ModelMessageContent,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler, ToolHandlerFailure } from "../types.js";
import { formatModelCatalogId } from "./model-reference.js";

const LIST_MODELS_TIMEOUT_MS = 10_000;
/** 照 ListSavedWorkflows：目录刻意轻（一次内存读可答），24k 足够几十行还留着余量。 */
const LIST_MODELS_MODEL_BYTES = 24_000;

/**
 * 业务失败码。数值只是日志位（executor 投影成 `code: "N"`），判别键在 message 前缀。
 * 从 31 起编只为与 workflow 内省表（1/2）、ResumeWorkflowRun（11–15）、AmendWorkflow（21–23）
 * 视觉不撞车。
 */
const LIST_MODELS_ERROR_CODE = { CATALOG_UNAVAILABLE: 31 } as const;

const LIST_MODELS_DESCRIPTION = [
  "Lists the models this host has configured, so another tool can be pointed at one.",
  "",
  "- Each row's `id` (`providerId/modelId`) pastes verbatim into the `model` field of CreateSession, or the `subagent_model` field of CreateWorkflow or AmendWorkflow. Append `$<level>` to pick a reasoning level from that row's `reasoningLevels`.",
  "- This tool does NOT change the model you are running on, and no tool changes an existing session's model. It only picks the model for a session or a workflow subagent you are about to create.",
  "- The model the session is on right now is marked `[current]`. Omitting the field uses the configured default, which is not necessarily that one.",
  "- A row marked `disabled` cannot be used (no API key, disabled by policy). Resolve that with the user rather than picking around it silently.",
].join("\n");

/**
 * 「本会话没有模型目录」。**绝不**静默回空列表：那会让模型把「这台机器没配模型」和
 * 「这个会话读不到目录」混成同一个结论（`workflow_introspection_unavailable` 同款理由），
 * 然后据此告诉用户他一个模型都没有——而他正在用一个。
 */
function modelCatalogUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: LIST_MODELS_ERROR_CODE.CATALOG_UNAVAILABLE,
    message:
      "model_catalog_unavailable: this session cannot list models — the host did not provide a model catalog. This is a capability gap, not an empty configuration. Omit `subagent_model` on CreateWorkflow and AmendWorkflow; the workflow's subagents will run on the session model.",
  };
}

const listModelsHandler: ToolHandler = async (input, context) => {
  ListModelsInputSchema.parse(input);

  const port = context.modelCatalogPort;
  if (port === undefined) return modelCatalogUnavailableFailure();

  const entries = port.listModels();
  const current = entries.find((entry) => entry.current);

  return {
    // 目录里一条都没标 current 时缺席（端口契约允许：会话的选择可能指向一个已被删掉的
    // provider）。造一个空字符串会让模型把"没有当前模型"读成"当前模型叫空"。
    ...(current === undefined ? {} : { current: formatModelCatalogId(current) }),
    models: entries.map((entry) => ({
      id: formatModelCatalogId(entry),
      providerId: entry.providerId,
      modelId: entry.modelId,
      ...(entry.providerLabel === undefined ? {} : { providerLabel: entry.providerLabel }),
      // 没有档位的模型给空数组而不是缺席：读侧据此知道"接 `$` 是错的"，而缺席读起来像
      // "这一行没说"。
      reasoningLevels: [...entry.reasoningLevels],
      ...(entry.defaultReasoningLevel === undefined
        ? {}
        : { defaultReasoningLevel: entry.defaultReasoningLevel }),
      ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
      ...(entry.disabledReason === undefined ? {} : { disabledReason: entry.disabledReason }),
    })),
  } satisfies ListModelsOutput;
};

/**
 * 模型面：一行一个模型。
 *
 * 与 ListSavedWorkflows 的**多行块**式刻意不同（那边一条要带描述、使用时机与参数表）：目录行
 * 是低信息密度的高基数实体——几十行都长一个样，而模型在这里只做一件事，把某一行的 `id`
 * 抄进 `subagent_model`。挤成一行正好，也让 24k 预算装得下一整份目录。
 */
function formatListModelsModelContent(output: unknown): ModelMessageContent {
  const parsed = ListModelsOutputSchema.safeParse(output);
  if (!parsed.success) return "ListModels returned an invalid result.";
  const { current, models } = parsed.data;

  if (models.length === 0) {
    // 「一个都没配」必须说成一句话：空容器容易被读成「工具没答上来」。
    return [
      '<models count="0">',
      "No models are configured on this host. Omit `subagent_model`: the workflow's subagents run on the session model.",
      "</models>",
    ].join("\n");
  }

  const lines = models.map((model) => {
    const parts = [model.id];
    if (model.providerLabel !== undefined) parts.push(` — ${model.providerLabel}`);
    if (model.reasoningLevels.length > 0) {
      const levels = model.reasoningLevels.join(",");
      const fallback =
        model.defaultReasoningLevel === undefined
          ? ""
          : ` (default ${model.defaultReasoningLevel})`;
      parts.push(`; levels: ${levels}${fallback}`);
    }
    // current 与 disabled 排在行尾且各用方括号：它们是模型据以**排除**一行的两个标记，
    // 放在中段会被更长的档位表推出视线。
    if (model.id === current) parts.push(" [current]");
    if (model.disabledReason !== undefined) parts.push(` [disabled: ${model.disabledReason}]`);
    return parts.join("");
  });

  return [`<models count="${models.length}">`, ...lines, "</models>"].join("\n");
}

export const listModelsToolEntry: ToolEntry = {
  capability:
    "List the models this host has configured, for choosing a new session or subagent model",
  metadata: {
    shouldDefer: true,
    name: LIST_MODELS_TOOL_NAME,
    description: LIST_MODELS_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: LIST_MODELS_TIMEOUT_MS,
    maxOutputBytes: LIST_MODELS_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: listModelsHandler,
  inputSchema: ListModelsInputJsonSchema,
  outputSchema: ListModelsOutputJsonSchema,
  runtimeInputSchema: ListModelsInputSchema,
  runtimeOutputSchema: ListModelsOutputSchema,
  formatModelContent: formatListModelsModelContent,
  permission: {
    permission: "listModels",
    reason: "ListModels reads the host's configured model catalog",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    // 入参是空对象，所以模式只按工具名匹配（同 ListSavedWorkflows）。
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // 刻意**不**继承 CreateWorkflow 的 alwaysAsk：那道门的理由是「执行整块代码」，
    // 读一张已配置模型的表不属于它。
  },
  resultBudget: {
    maxInlineBytes: LIST_MODELS_MODEL_BYTES,
    maxModelBytes: LIST_MODELS_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: LIST_MODELS_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: LIST_MODELS_TIMEOUT_MS,
    maxMs: LIST_MODELS_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "ListModels reads the in-memory model catalog and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
