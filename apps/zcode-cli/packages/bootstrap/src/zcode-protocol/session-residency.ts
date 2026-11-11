// Session 常驻池的真实事实适配与去激活执行面。

import type { SessionId } from "@zcode/contracts";
import { zcodeProtocolMethods } from "@zcode/shared";
import { waitForSessionResidencyFinalization } from "../session-execution/index.js";
import type {
  SessionDeactivationDecision,
  SessionResidentPoolHost,
} from "./session-resident-pool.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { SessionLifecycleController } from "../session-lifecycle/index.js";
import { activateSessionRuntime, validateSessionActivationWorkspace } from "./server-operations.js";
import { abortMcpUiToolCallsForSession, clearMcpUiAppToolsForSession } from "./mcp-ui/index.js";

export function getSessionLifecycle(
  context: ZCodeProtocolAgentServerContext,
): SessionLifecycleController {
  return (context.sessionLifecycle ??= new SessionLifecycleController({
    exists: async (sessionId) => {
      const persisted = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      if (persisted?.time.deleted !== undefined) return false;
      return Boolean(persisted || context.sessions.has(sessionId));
    },
    hasRuntime: (sessionId) => context.sessions.has(sessionId),
    validateActivation: (sessionId, workspace) =>
      validateSessionActivationWorkspace(context, sessionId, workspace),
    activate: async (sessionId, workspace) => {
      const persistedMessages = await context.v4Gateway?.prepareSessionHistory(
        sessionId,
        workspace,
      );
      await activateSessionRuntime(
        context,
        { sessionId, workspace },
        {
          reusePersistedMessages: true,
          persistedMessages,
        },
      );
    },
    assertCanStop: (sessionId) => {
      // 主动停止不继承 TTL/LRU 的 busy 保护；回收仍由 resident pool 单独预检。
      void sessionId;
    },
    release: (sessionId, initializationFailed) =>
      releaseSessionRecord(context, sessionId, initializationFailed ? "discard" : "close"),
    onOperationSettled: (id) => context.sessions.get(id)?.pluginReload?.check(),
    onChange: (snapshot) => {
      context.logger?.info("Session runtime lifecycle changed", {
        event: "zcode_protocol.session.lifecycle_changed",
        ...snapshot,
      });
      try {
        context.notify({ method: zcodeProtocolMethods.sessionLifecycleChanged, params: snapshot });
      } catch (error) {
        // 通知连接失败不改变已完成的生命周期事实，客户端重连后通过查询对账。
        context.logger?.warn("Session lifecycle notification failed", {
          sessionId: snapshot.sessionId,
          error,
        });
      }
    },
  }));
}

/** 条件关闭和删除复用资源释放；调用方保留自己的产品预检及软删除顺序。 */
export function closeSessionRuntime(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  deleted = false,
): Promise<void> {
  return getSessionLifecycle(context).dispose(sessionId, () =>
    releaseSessionRecord(context, sessionId, deleted ? "delete" : "close"),
  );
}

export function discardSessionRuntime(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<void> {
  return getSessionLifecycle(context).dispose(sessionId, () =>
    releaseSessionRecord(context, sessionId, "discard"),
  );
}

/** 整体退出保留原有投影收口顺序；尚未初始化完成的 app 仍由进程资源 owner 收集。 */
export function shutdownSessionRuntime(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<void> {
  return getSessionLifecycle(context).dispose(sessionId, () =>
    releaseSessionRecord(context, sessionId, "shutdown"),
  );
}

export {
  acquireSessionResidencyFinalization,
  runWithSessionResidencyFinalization,
  type SessionResidencyFinalizationOwner,
} from "../session-execution/index.js";

/**
 * 只释放 resident runtime，不删除任何持久 session/task 事实。
 *
 * 同步摘除与异步关闭由 session lifecycle owner 组合成一个事务；pool 只决定何时回收。
 * registry 缺席不代表已经释放，只有 owner 确认关闭成功后才能恢复新实例。
 */
export async function deactivateSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<void> {
  const record = context.sessions.get(sessionId);
  if (!record) return;
  // CommandInbox pin 的拒绝曾发生在 unsubscribe 之后，异常会留下仍在 registry
  // 但收不到 runtime event 的半清 record。所有可预检拒绝必须早于第一个副作用。
  context.v4Gateway?.assertSessionRuntimeDeactivatable(sessionId);
  await getSessionLifecycle(context).dispose(sessionId, () =>
    releaseSessionRecord(context, sessionId, "deactivate"),
  );
}

async function releaseSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  mode: "close" | "deactivate" | "discard" | "delete" | "shutdown",
): Promise<void> {
  const record = context.sessions.get(sessionId);
  if (!record) {
    if (mode === "close") {
      await context.v4Gateway?.releaseSessionProjection(sessionId);
      await context.v4Gateway?.finishSessionRelease(sessionId);
    } else if (mode !== "discard" && mode !== "shutdown")
      context.v4Gateway?.disposeSession(sessionId);
    return;
  }
  record.pluginReload?.dispose();
  const errors: Error[] = [];
  const failed = (stage: string, cause: unknown) => {
    const error = new Error(`${stage}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    errors.push(error);
    context.logger?.warn("Session release stage failed", {
      event: "zcode_protocol.session.release_stage_failed",
      sessionId,
      mode,
      stage,
      error: error.message,
      code: cause && typeof cause === "object" && "code" in cause ? cause.code : undefined,
    });
  };
  let projectionReleased: Promise<void> | undefined;
  if (mode === "close") {
    // 先冻结后台唤醒和队列，再暂停目标并取消执行；重启不能在取消后自动续跑。
    try {
      record.app.runtime.beginShutdown();
    } catch (error) {
      failed("close_admission", error);
    }
    try {
      const target = await record.app.readTarget?.();
      if (target?.status === "active") await record.app.updateTargetStatus?.("paused");
    } catch (error) {
      failed("goal_pause", error);
    }
    try {
      record.app.runtime.stopActiveForegroundExecution?.({ reason: "session runtime restarting" });
      record.activeAbortController?.abort(new Error("Session runtime restarting"));
    } catch (error) {
      failed("cancel_execution", error);
    }
  }
  try {
    record.unsubscribe?.();
  } catch (error) {
    failed("unsubscribe", error);
  }
  // 先摘除旧实例，避免 close 的 await 窗口向半关闭 runtime 发命令。
  // gateway 的删除通知需要 registry 中的 workspace 身份，因此必须在摘除前发出。
  try {
    if (mode === "close")
      projectionReleased = context.v4Gateway
        ?.releaseSessionProjection(sessionId)
        .catch((error: unknown) => {
          failed("projection_release", error);
        });
    else if (mode === "deactivate") context.v4Gateway?.deactivateSession(sessionId);
    else if (mode !== "discard" && mode !== "shutdown")
      context.v4Gateway?.disposeSession(sessionId, { deleted: mode === "delete" });
  } catch (error) {
    failed("projection_release", error);
  }
  context.sessions.delete(sessionId);
  if (mode === "close" || mode === "delete") {
    try {
      abortMcpUiToolCallsForSession(sessionId);
      clearMcpUiAppToolsForSession(context, sessionId);
      await record.app.unsubscribeMcpResourcesForUi?.(`${sessionId}|`);
    } catch (error) {
      failed("mcp_ui_release", error);
    }
  }
  // 一个清理步骤失败不能跳过 app.close；最终错误仍由生命周期 owner 隔离。
  let runtimeClosed = false;
  try {
    await record.app.close?.();
    runtimeClosed = true;
  } catch (error) {
    failed("runtime_close", error);
  }
  // 投影的拒绝必须始终被消费；只有真实 runtime close 完成后才能结算其执行队列。
  await projectionReleased;
  if (runtimeClosed) {
    try {
      await waitForSessionResidencyFinalization(record);
      if (mode === "close") await context.v4Gateway?.finishSessionRelease(sessionId);
    } catch (error) {
      failed("execution_finalization", error);
    }
  }
  try {
    if (mode !== "shutdown") await record.eventStore.deleteSession(sessionId as SessionId);
  } catch (error) {
    // 独立内存投影不拥有运行资源；失败不阻止替代实例，保留诊断即可。
    context.logger?.warn("Session event cache cleanup failed", {
      event: "zcode_protocol.session.event_cache_cleanup_failed",
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      `Session runtime release failed: ${errors.map((error) => error.message).join("; ")}`,
    );
  await context.deps?.sessionStore?.unregisterSessionRuntime?.(sessionId as SessionId);
}

/**
 * 会话是否忙：驻留阻塞工作、待处理交互或排队命令；未加载返回 null。
 * 彻底删除会话数据与 `session/releaseUnderDirectory` 共用同一判定。
 */
export function readSessionBusyState(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): "busy" | "idle" | null {
  const facts = createSessionResidentPoolHost(context).readResidencyFacts(sessionId);
  if (!facts) return null;
  return facts.hasResidencyBlockingWork || facts.hasPendingInteractions || facts.hasQueuedCommands
    ? "busy"
    : "idle";
}

export function createSessionResidentPoolHost(
  context: ZCodeProtocolAgentServerContext,
): SessionResidentPoolHost {
  return {
    deactivate: (sessionId) => deactivateSessionRecord(context, sessionId),
    onOperationsReleased: (id) => context.sessions.get(id)?.pluginReload?.check(),
    listSessionIds: () => [...context.sessions.keys()],
    readResidencyFacts: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      return {
        hasPendingInteractions: context.v4Interactions.hasPendingForSession(sessionId),
        hasQueuedCommands: context.v4Gateway?.hasResidencyBlockingCommands(sessionId) ?? false,
        hasLegacySubscriber: record.legacyStreamSubscribed === true,
        // active/queue 与 registry background task 不能覆盖 title、MCP、memory
        // 等 detached work；统一查询由 runtime 维护，协议 finalization 只补协议所有权。
        hasResidencyBlockingWork:
          (context.sessionLifecycle !== undefined &&
            !context.sessionLifecycle.isReady(sessionId)) ||
          record.activeAbortController !== undefined ||
          (record.residencyFinalizationCount ?? 0) > 0 ||
          record.app.runtime.hasResidencyBlockingWork(),
        hasSubscribers: context.v4Gateway?.hasConversationSubscribers(sessionId) ?? false,
        lastActivityAt: record.updatedAt,
        persisted: record.persistence === "immediate",
      };
    },
    onDeactivated: (sessionId, decision) => {
      context.logger?.info("Session resident runtime deactivated", {
        ...deactivationLogContext(decision),
        event: "zcode_protocol.session.resident_deactivated",
        sessionId,
      });
    },
    onError: (sessionId, error, decision) => {
      context.logger?.warn("Session resident deactivation failed", {
        ...deactivationLogContext(decision),
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.session.resident_deactivation_failed",
        sessionId,
      });
    },
  };
}

function deactivationLogContext(
  decision: SessionDeactivationDecision,
): Record<string, number | string> {
  return {
    highWaterCount: decision.highWaterCount,
    idleMs: decision.idleMs,
    idleTimeoutMs: decision.idleTimeoutMs,
    reason: decision.reason,
    residentCountBefore: decision.residentCountBefore,
    targetCount: decision.targetCount,
  };
}

/** 只登记本实例的意图，绝不能在安装工具内部 await 自己这一轮的结束。 */
export function requestPluginSessionReload(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): void {
  const id = record.app.sessionId;
  if (context.sessions.get(id) !== record || record.pluginReload) return;
  const lifecycle = getSessionLifecycle(context);
  const host = createSessionResidentPoolHost(context);
  let disposed = false;
  let checking = false;
  let revision = 0;
  let waitingForFinalization = false;
  const removeWorkListener = record.app.runtime.onResidencyWorkChanged(check);
  function dispose() {
    if (disposed) return;
    disposed = true;
    delete record.pluginReload;
    removeWorkListener();
  }
  function idle() {
    const facts = host.readResidencyFacts(id);
    return (
      !disposed &&
      context.sessions.get(id) === record &&
      facts?.persisted &&
      !facts.hasResidencyBlockingWork &&
      !facts.hasPendingInteractions &&
      !facts.hasQueuedCommands &&
      !context.sessionResidentPool?.operationCount(id)
    );
  }
  function check() {
    revision++;
    if (checking || disposed) return;
    checking = true;
    queueMicrotask(() => {
      void evaluate()
        .catch((error) => {
          // 读取安全事实失败时不冒险中断任务；后续显式重启仍由同一个生命周期处理。
          dispose();
          context.logger?.warn("Plugin session reload failed", { sessionId: id, error });
        })
        .finally(() => {
          checking = false;
          if (!disposed && evaluated !== revision) check();
        });
    });
  }
  let evaluated = 0;
  async function evaluate() {
    evaluated = revision;
    if (disposed) return;
    if (record.residencyFinalizationCount && !waitingForFinalization) {
      waitingForFinalization = true;
      void waitForSessionResidencyFinalization(record).then(() => {
        waitingForFinalization = false;
        check();
      });
    }
    if (!idle()) return;
    const [goal, admitted] = await Promise.all([
      record.app.readTarget(),
      context.deps.sessionStore?.listSessionInputs?.({
        sessionID: id as SessionId,
        status: "admitted",
      }),
    ]);
    // DB 读取期间可以有新输入。丢弃过期读结果，并在同一同步片检查租约、取得 restart flight。
    if (evaluated !== revision || goal?.status === "active" || admitted?.length || !idle()) return;
    const flight = lifecycle.restartIdle(id);
    if (flight) {
      dispose();
      await flight;
    }
  }
  record.pluginReload = { check, dispose };
  check();
}
