// 每个 runtime 的 context 组成状态：最近一次请求的组成与变更监听器。查询入口在 query.ts。
// 规格：apps/zcode-cli/docs/design/v2/model/context-composition.md §3.3–§3.4。
//
// 修订号不在这里：唯一 owner 是 bootstrap 的 ContextCompositionRevisionTracker。
// runtime 只在变更点同步调用监听器，合并与计数由 tracker 负责。
// 本文件不依赖预演（preview.ts → context-refresh.ts → 本文件），避免 import 环。
import {
  getModelUsageContextTokens,
  getModelUsageInputWindowTokens,
  type ModelUsage,
} from "@zcode/contracts";
import type { ContextComposition } from "@zcode/shared/zcode-protocol-v4";
import { traceContextToLogContext } from "../deps.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ContextCompositionBreakdown } from "./classifier.js";

/** 查询结果去掉 sessionId 与 revision（二者由 bootstrap 补上）。 */
export type ContextCompositionMeasurement = Omit<ContextComposition, "sessionId" | "revision">;

export interface RecordedRequestComposition {
  model: ContextCompositionMeasurement["model"];
  measuredAt: number;
  breakdown: ContextCompositionBreakdown;
  providerInputTokens?: number;
  /** 与输入框用量圆环同一个值（spec §3.2）。 */
  providerContextTokens?: number;
  /**
   * 之后又发生了 compact、工具变化、前缀重建或换模型：下一个请求的组成必然不同，
   * 再返回这份会误导，查询改为预演，直到下一次请求算好分解。
   */
  superseded: boolean;
}

/** 变更原因，对应 spec §3.4 的触发事件。 */
export type ContextCompositionChangeReason =
  | "request"
  | "request_usage"
  | "compact"
  | "tools"
  | "context_prefix"
  | "model";

export type ContextCompositionChangeListener = (change: {
  reason: ContextCompositionChangeReason;
}) => void;

interface RuntimeContextCompositionState {
  listeners: Set<ContextCompositionChangeListener>;
  request?: RecordedRequestComposition;
}

// 照 turn-model.ts 的写法挂在 runtime 实例上，不扩 AgentRuntime 的字段（agent-runtime.ts 已超 800 行）。
const states = new WeakMap<AgentRuntimeInternal, RuntimeContextCompositionState>();

/** 最近一次请求组成；没有时为 undefined。只读：变更只经本文件的 record/supersede。 */
export function recordedRequestComposition(
  runtime: AgentRuntimeInternal,
): Readonly<RecordedRequestComposition> | undefined {
  return stateOf(runtime).request;
}

function stateOf(runtime: AgentRuntimeInternal): RuntimeContextCompositionState {
  let state = states.get(runtime);
  if (!state) {
    state = { listeners: new Set() };
    states.set(runtime, state);
  }
  return state;
}

function notifyListeners(
  runtime: AgentRuntimeInternal,
  reason: ContextCompositionChangeReason,
): void {
  for (const listener of stateOf(runtime).listeners) {
    try {
      listener({ reason });
    } catch (error) {
      // 监听器只是观测旁路，失败不能打断模型请求、compact 或换模型。
      runtime.logger?.warn("Context composition listener failed", {
        ...traceContextToLogContext(runtime.rootTraceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "context_composition.listener.failed",
        module: "core.runtime",
        reason,
      });
    }
  }
}

/** 公开方法：订阅组成变更；返回取消订阅函数。 */
export function subscribeContextCompositionChanged(
  this: AgentRuntimeInternal,
  listener: ContextCompositionChangeListener,
): () => void {
  const { listeners } = stateOf(this);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 公开方法：会话外部改了会影响组成的状态（换模型）。最近一次请求组成作废并通知。 */
export function markContextCompositionChanged(this: AgentRuntimeInternal): void {
  supersedeContextComposition(this, "model");
}

/** compact 完成、工具缓存失效、前缀重建：最近一次请求组成作废并通知。 */
export function supersedeContextComposition(
  runtime: AgentRuntimeInternal,
  reason: Exclude<ContextCompositionChangeReason, "request" | "request_usage">,
): void {
  const request = stateOf(runtime).request;
  if (request) request.superseded = true;
  notifyListeners(runtime, reason);
}

/** 请求的分解算好：记为最近一次请求组成并通知。 */
export function recordRequestContextComposition(
  runtime: AgentRuntimeInternal,
  input: { model: Model; breakdown: ContextCompositionBreakdown },
): void {
  stateOf(runtime).request = {
    model: compositionModelOf(input.model),
    measuredAt: runtime.now().getTime(),
    breakdown: input.breakdown,
    superseded: false,
  };
  notifyListeners(runtime, "request");
}

/** 请求完成、服务商 usage 到达：补上 providerInputTokens、providerContextTokens 并通知。 */
export function recordRequestContextCompositionUsage(
  runtime: AgentRuntimeInternal,
  breakdown: ContextCompositionBreakdown,
  usage: ModelUsage | undefined,
): void {
  const request = stateOf(runtime).request;
  const providerInputTokens = getModelUsageInputWindowTokens(usage);
  // 只认同一次分解：用对象身份配对，usage 不会挂到更晚的请求上。
  if (!request || request.breakdown !== breakdown || providerInputTokens === undefined) return;
  request.providerInputTokens = providerInputTokens;
  // 圆环（product-projection 的 usedTokens）对同一份 usage 调同一个函数；这里不另算 input + output，
  // 两边才不会因为口径不同而对不上（用户反馈：插件与 App 显示的上下文占用不一致）。
  const providerContextTokens = getModelUsageContextTokens(usage);
  if (providerContextTokens !== undefined) request.providerContextTokens = providerContextTokens;
  notifyListeners(runtime, "request_usage");
}

export function compositionModelOf(model: Model): ContextCompositionMeasurement["model"] {
  const contextWindow = model.properties.contextWindow;
  return {
    providerId: String(model.providerId),
    modelId: String(model.modelId),
    contextWindow:
      typeof contextWindow === "number" && Number.isInteger(contextWindow) && contextWindow > 0
        ? contextWindow
        : null,
  };
}
