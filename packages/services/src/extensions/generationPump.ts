import { Emitter, type Event } from "@zcode/rpc";
import { ESTIMATED_TOKEN_CHAR_DIVISOR, calculateOutputTps } from "@zcode/shared";
import {
  GENERATION_STREAMING_PUSH_INTERVAL_MS,
  type GenerationMetrics,
  type WorkspaceRef,
} from "@zcode/shared/extension-host";
import type {
  ConversationTelemetryFact,
  ModelRequestMetricsFact,
} from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import {
  createWorkspaceSubscriptions,
  type WorkbenchState,
} from "#src/extensions/workbenchState.js";

// 生成速率（docs/plugins/extension-host.md §10）：Window Host 是唯一聚合点。
// - 流式估算：stream.chunk 字符数 ÷ 除数常量 ÷ 距本请求首个 chunk 的时间，每个请求最多每 500ms 推一次。
// - 准确值：model.request.metrics 的服务商 output tokens ÷（durationMs − timeToFirstContentMs）。
// - 只统计主轮请求；没有扩展订阅时不聚合。

/** 主轮请求的 querySource；标题生成、compact、子代理等旁路请求不计入。 */
const MAIN_TURN_QUERY_SOURCE = "main_turn";

interface StreamState {
  requestId: string;
  workspace: WorkspaceRef;
  model: { providerId: string; modelId: string };
  /** 本请求首个 chunk 的时间（CLI 记录的 occurredAt）。stream.chunk 的 firstChunk 按 part 判定，不能用。 */
  firstChunkAt?: number;
  chars: number;
  /** 本地时钟：上一次推送的时间，用于每请求 500ms 节流。 */
  lastPushAt: number;
}

export interface GenerationPump {
  readonly onDidGenerate: Event<GenerationMetrics>;
  dispose(): void;
}

export function createGenerationPump(deps: {
  agent: Pick<
    IZCodeAgentService,
    "onDynamicConversationTelemetryFact" | "onDynamicModelRequestMetrics"
  >;
  workbench: WorkbenchState;
  logger: Pick<ServiceLogger, "debug" | "info">;
  now?: () => number;
}): GenerationPump {
  const now = deps.now ?? Date.now;
  /** stream.chunk 不带 requestId：按会话记当前进行中的主轮请求（来自 model.request.status）。 */
  const streams = new Map<string, StreamState>();

  const handleFact = (workspace: WorkspaceRef, fact: ConversationTelemetryFact) => {
    if (fact.kind === "model.request.status") {
      const current = streams.get(fact.sessionId);
      if (fact.status === "model_request_started") {
        if (fact.querySource === MAIN_TURN_QUERY_SOURCE) {
          streams.set(fact.sessionId, {
            requestId: fact.requestId,
            workspace,
            model: { providerId: fact.providerId, modelId: fact.modelId },
            chars: 0,
            lastPushAt: Number.NEGATIVE_INFINITY,
          });
        }
        return;
      }
      if (current?.requestId !== fact.requestId) return;
      if (fact.status === "model_retry_scheduled") {
        // 重试从头流：首个 chunk 时间与字符数作废。
        delete current.firstChunkAt;
        current.chars = 0;
        return;
      }
      if (fact.status === "model_request_completed" || fact.status === "model_request_failed") {
        streams.delete(fact.sessionId);
      }
      return;
    }
    if (fact.kind !== "stream.chunk" || fact.parentToolCallId) return;
    const stream = streams.get(fact.sessionId);
    if (!stream) return;
    stream.firstChunkAt ??= fact.occurredAt;
    stream.chars += fact.chunkLength;
    const elapsedMs = fact.occurredAt - stream.firstChunkAt;
    // 回放或批量到达的流可能同一时刻到达：没有经过时间就没有速率。
    if (elapsedMs <= 0) return;
    const pushedAt = now();
    if (pushedAt - stream.lastPushAt < GENERATION_STREAMING_PUSH_INTERVAL_MS) return;
    stream.lastPushAt = pushedAt;
    const outputTokensPerSecond = (stream.chars / ESTIMATED_TOKEN_CHAR_DIVISOR / elapsedMs) * 1000;
    emitter.fire({
      sessionId: fact.sessionId,
      workspace: stream.workspace,
      requestId: stream.requestId,
      model: stream.model,
      phase: "streaming",
      outputTokensPerSecond,
    });
    // 每请求每秒最多 2 次，和消息流同数量级：只记 debug。
    deps.logger.debug(
      undefined,
      `generation streaming sessionId=${fact.sessionId} requestId=${stream.requestId} tps=${outputTokensPerSecond.toFixed(2)}`,
    );
  };

  const handleMetrics = (workspace: WorkspaceRef, fact: ModelRequestMetricsFact) => {
    if (fact.querySource !== MAIN_TURN_QUERY_SOURCE) return;
    if (streams.get(fact.sessionId)?.requestId === fact.requestId) streams.delete(fact.sessionId);
    const firstContentMs = fact.timeToFirstContentMs;
    // 与开发者工具面板同一定义：生成时长 = durationMs − timeToFirstContentMs，两者都有且前者更大时才有准确值。
    const generationMs =
      firstContentMs !== undefined && fact.durationMs > firstContentMs
        ? fact.durationMs - firstContentMs
        : null;
    const outputTokensPerSecond = calculateOutputTps(fact.outputTokens, generationMs);
    if (outputTokensPerSecond === null) return;
    emitter.fire({
      sessionId: fact.sessionId,
      workspace,
      requestId: fact.requestId,
      model: { providerId: fact.providerId, modelId: fact.modelId },
      phase: "final",
      outputTokensPerSecond,
      ...(fact.outputTokens !== undefined ? { outputTokens: fact.outputTokens } : {}),
      ...(firstContentMs !== undefined ? { timeToFirstTokenMs: firstContentMs } : {}),
    });
    deps.logger.debug(
      undefined,
      `generation final sessionId=${fact.sessionId} requestId=${fact.requestId} tps=${outputTokensPerSecond.toFixed(2)}`,
    );
  };

  const telemetry = createWorkspaceSubscriptions(
    (workspace) => deps.agent.onDynamicConversationTelemetryFact(workspace),
    handleFact,
    (workspaceKey) => deps.logger.info(undefined, `generation pump subscribed ${workspaceKey}`),
  );
  const metrics = createWorkspaceSubscriptions(
    (workspace) => deps.agent.onDynamicModelRequestMetrics?.(workspace),
    handleMetrics,
  );
  let active = false;
  const sync = () => {
    const workspaces = deps.workbench.workspaces();
    telemetry.sync(workspaces);
    metrics.sync(workspaces);
  };
  const emitter = new Emitter<GenerationMetrics>({
    // 没有扩展订阅 models.onDidGenerate 时不做聚合。
    onWillAddFirstListener: () => {
      active = true;
      sync();
      deps.logger.info(undefined, `generation pump started workspaces=${telemetry.size()}`);
    },
    onDidRemoveLastListener: () => {
      active = false;
      telemetry.disposeAll();
      metrics.disposeAll();
      streams.clear();
      deps.logger.info(undefined, "generation pump stopped");
    },
  });
  const reportSubscription = deps.workbench.onDidChangeReport(() => {
    if (active) sync();
  });

  return {
    onDidGenerate: emitter.event,
    dispose() {
      reportSubscription.dispose();
      telemetry.disposeAll();
      metrics.disposeAll();
      streams.clear();
      emitter.dispose();
    },
  };
}
