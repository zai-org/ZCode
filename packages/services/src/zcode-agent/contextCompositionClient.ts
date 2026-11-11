// App 侧 context 组成：查询、变更通知与模型请求指标通知（context-composition 模块）。
// 规格：apps/zcode-cli/docs/design/v2/model/context-composition.md §3.6；
// 模型请求指标见 docs/monitoring/conversation-telemetry-v4.md「模型请求指标」。
//
// 不在模块顶层创建 logger：本文件经 zcodeAgent 可达 Renderer，createServiceLogger 读 process.pid 会白屏。
import { Emitter, type Event } from "@zcode/rpc";
import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  modelRequestMetricsFactSchema,
  v4ConversationContextCompositionChangedSchema,
  v4ConversationContextCompositionParamsSchema,
  v4ConversationContextCompositionResultSchema,
  type ContextComposition,
  type ContextCompositionChangedEvent,
  type ModelRequestMetricsFact,
} from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelection } from "@zcode/shared";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { ZCodeAgentWorkspaceTarget } from "#src/zcode-agent/zcodeAgentPluginParams.js";
import type { ZCodeProtocolClient } from "#src/zcode-agent/zcodeProtocolClient.js";

/** JSON-RPC method-not-found：旧 CLI 不认识查询方法。 */
const METHOD_NOT_FOUND_CODE = -32601;

export interface ZCodeAgentContextCompositionParams extends ZCodeAgentWorkspaceTarget {
  sessionId: string;
  /** 完整模型选择（含思考档位）；省略时 CLI 用会话当前模型。草稿按 Renderer 报告的所选模型传。 */
  modelSelection?: ModelSelection;
}

export interface ContextCompositionClientDeps {
  /** existing-only：工作区没有运行中的 CLI 时抛 runtime-unavailable 错误，不启动进程。 */
  getExistingClient(target: ZCodeAgentWorkspaceTarget): Promise<ZCodeProtocolClient>;
  isRuntimeUnavailableError(error: unknown): boolean;
  resolveWorkspaceKey(target: ZCodeAgentWorkspaceTarget): string;
  logger: Pick<ServiceLogger, "debug">;
}

export interface ContextCompositionClient {
  getContextComposition(
    params: ZCodeAgentContextCompositionParams,
  ): Promise<ContextComposition | null>;
  onDidChange(target: ZCodeAgentWorkspaceTarget): Event<ContextCompositionChangedEvent>;
  onModelRequestMetrics(target: ZCodeAgentWorkspaceTarget): Event<ModelRequestMetricsFact>;
  /** 通知路由：认识的方法返回 true（已处理，调用方直接 return）。 */
  handleNotification(
    workspace: ZCodeAgentWorkspaceTarget,
    message: { method: string; params?: unknown },
  ): boolean;
  dispose(): void;
}

export function createContextCompositionClient(
  deps: ContextCompositionClientDeps,
): ContextCompositionClient {
  const changedEmitters = new Map<string, Emitter<ContextCompositionChangedEvent>>();
  const metricsEmitters = new Map<string, Emitter<ModelRequestMetricsFact>>();
  const emitterFor = <T>(map: Map<string, Emitter<T>>, target: ZCodeAgentWorkspaceTarget) => {
    const key = deps.resolveWorkspaceKey(target);
    let emitter = map.get(key);
    if (!emitter) {
      emitter = new Emitter<T>();
      map.set(key, emitter);
    }
    return emitter;
  };

  return {
    async getContextComposition(params) {
      const wire = v4ConversationContextCompositionParamsSchema.parse({
        sessionId: params.sessionId,
        ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
      });
      let client: ZCodeProtocolClient;
      try {
        client = await deps.getExistingClient(params);
      } catch (error) {
        // existing-only：没有运行中的 CLI 就没有内存里的会话，按「会话不在内存」处理。
        if (deps.isRuntimeUnavailableError(error)) return null;
        throw error;
      }
      try {
        const result = await client.request(
          V4_METHODS.conversationContextComposition,
          wire,
          v4ConversationContextCompositionResultSchema,
        );
        return result.composition;
      } catch (error) {
        // 旧 CLI 不认识方法：界面显示「当前版本不支持」，不当作错误。
        if (isMethodNotFoundError(error)) return null;
        throw error;
      }
    },
    onDidChange(target) {
      return emitterFor(changedEmitters, target).event;
    },
    onModelRequestMetrics(target) {
      return emitterFor(metricsEmitters, target).event;
    },
    handleNotification(workspace, message) {
      if (message.method === V4_NOTIFICATIONS.conversationContextCompositionChanged) {
        const parsed = v4ConversationContextCompositionChangedSchema.safeParse(message.params);
        if (parsed.success) emitterFor(changedEmitters, workspace).fire(parsed.data);
        // 每次变更一条，按消息流同数量级，只记 debug。
        else deps.logger.debug(undefined, "丢弃无效 context 组成变更通知");
        return true;
      }
      if (message.method === V4_NOTIFICATIONS.modelRequestMetrics) {
        const parsed = modelRequestMetricsFactSchema.safeParse(message.params);
        if (parsed.success) emitterFor(metricsEmitters, workspace).fire(parsed.data);
        else deps.logger.debug(undefined, "丢弃无效模型请求指标");
        return true;
      }
      return false;
    },
    dispose() {
      for (const emitter of changedEmitters.values()) emitter.dispose();
      changedEmitters.clear();
      for (const emitter of metricsEmitters.values()) emitter.dispose();
      metricsEmitters.clear();
    },
  };
}

function isMethodNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === METHOD_NOT_FOUND_CODE
  );
}
