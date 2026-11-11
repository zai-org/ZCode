// context 组成的查询入口：有效的请求组成且模型相同时返回它，否则按所查模型预演。
// 规格：apps/zcode-cli/docs/design/v2/model/context-composition.md §3.3。
import { traceContextToLogContext } from "../deps.js";
import type { ModelSelection, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeModel } from "../methods/runtime-model.js";
import { toContextCompositionCategories, type ContextCompositionBreakdown } from "./classifier.js";
import { previewContextComposition } from "./preview.js";
import {
  compositionModelOf,
  recordedRequestComposition,
  type ContextCompositionMeasurement,
} from "./state.js";

export interface ContextCompositionQuery {
  /** 完整模型选择；省略时用会话当前模型。 */
  modelSelection?: ModelSelection;
  traceContext?: TraceContext;
}

/** 公开方法：查询组成。有效的请求组成且模型相同时返回它，否则按所查模型预演。 */
export async function getContextComposition(
  this: AgentRuntimeInternal,
  input: ContextCompositionQuery = {},
): Promise<ContextCompositionMeasurement | null> {
  if (this.shuttingDown) return null;
  const selection = input.modelSelection ?? this.getSessionModelSelection();
  // 草稿还没选模型、查询也没给：没有可预演的请求。
  if (!selection) return null;
  const request = recordedRequestComposition(this);
  if (
    request &&
    !request.superseded &&
    request.model.providerId === selection.providerId &&
    request.model.modelId === selection.modelId
  ) {
    return buildContextCompositionMeasurement({
      phase: "request",
      measuredAt: request.measuredAt,
      model: request.model,
      breakdown: request.breakdown,
      providerInputTokens: request.providerInputTokens,
      providerContextTokens: request.providerContextTokens,
    });
  }
  const model = createRuntimeModel(this, { selection });
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const breakdown = await previewContextComposition(this, { model, traceContext });
  this.logger?.debug("Context composition previewed", {
    ...traceContextToLogContext(traceContext),
    event: "context_composition.previewed",
    module: "core.runtime",
    modelId: String(model.modelId),
    providerId: String(model.providerId),
  });
  return buildContextCompositionMeasurement({
    phase: "draft-preview",
    measuredAt: this.now().getTime(),
    model: compositionModelOf(model),
    breakdown,
  });
}

export function buildContextCompositionMeasurement(input: {
  phase: ContextCompositionMeasurement["phase"];
  measuredAt: number;
  model: ContextCompositionMeasurement["model"];
  breakdown: ContextCompositionBreakdown;
  providerInputTokens?: number;
  providerContextTokens?: number;
}): ContextCompositionMeasurement {
  const categories = toContextCompositionCategories(input.breakdown);
  const estimatedTokens = categories.reduce((sum, category) => sum + category.tokens, 0);
  const contextWindow = input.model.contextWindow;
  return {
    phase: input.phase,
    measuredAt: input.measuredAt,
    model: input.model,
    tokenMethod: "estimated",
    estimatedTokens,
    ...(input.phase === "request" && input.providerInputTokens !== undefined
      ? { providerInputTokens: input.providerInputTokens }
      : {}),
    ...(input.phase === "request" && input.providerContextTokens !== undefined
      ? { providerContextTokens: input.providerContextTokens }
      : {}),
    freeTokens: contextWindow === null ? null : Math.max(0, contextWindow - estimatedTokens),
    categories,
  };
}
