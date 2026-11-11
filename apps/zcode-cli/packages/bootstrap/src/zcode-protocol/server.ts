import { resolve } from "node:path";
import { resolveWorkspaceHookTrustIdentityForWorkspace } from "@zcode/adapters/config";
import type { SessionId } from "@zcode/contracts";
import {
  sessionLifecycleActivationParamsSchema,
  sessionLifecycleParamsSchema,
  sessionLifecycleSnapshotSchema,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import { querySessionDebug } from "./session-debug.js";
import { offPeakControlParamsSchema, offPeakControlResultSchema } from "@zcode/shared";
import { getConversationContextComposition } from "./context-composition/index.js";
import { createNodeNetworkCapture } from "@zcode/shared/node";
import { networkCaptureControlSchema, zcodeProtocolNotifications } from "@zcode/shared";
import {
  zcodePluginsCancelOperationParamsSchema,
  zcodeProtocolMethods,
  zcodeRuntimeCapabilitiesParamsSchema,
  zcodeWorkspaceCancelGenerateTextParamsSchema,
  zcodeWorkspaceHookTrustGrantParamsSchema,
} from "@zcode/shared";
import type { BrowserControlPort } from "@zcode/contracts";
import type {
  McpElicitationRequest,
  McpElicitationResult,
  McpServerNotification,
} from "@zcode/contracts";
import { requestMcpElicitation } from "./interaction-broker.js";
import { InMemoryWorkspaceHookPolicyProvider } from "@zcode/core";
import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  parseConversationTopic,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeProtocolError,
  ZCodeProtocolMessage,
  ZCodeProtocolMethod,
  ZCodeProtocolNotification,
  ZCodeProtocolRequest,
  ZCodeProtocolRequestId,
  ZCodeProtocolResponse,
} from "@zcode/shared";
import {
  cancelBackgroundTask,
  closeSession,
  releaseSessionsUnderDirectory,
  compactSession,
  createSession,
  forkSession,
  generateWorkspaceText,
  goalSession,
  getTaskTokenUsage,
  getUsageStats,
  listSessions,
  listSessionSubagents,
  readEvents,
  readMessages,
  readSession,
  resumeSession,
  sendPrompt,
  setMode,
  setModel,
  setThoughtLevel,
  stopSession,
  subscribeSession,
} from "./server-operations.js";
import { listChildProcesses } from "./process-child-processes.js";
import { ProtocolRuntimeResources } from "./runtime-resources.js";
import {
  ConversationInputPredictionHandler,
  createInputPredictionSessionLoader,
} from "./input-prediction-handler.js";
import {
  readWorkspacePresentation,
  testProviderModelConnectivity,
} from "./workspace-model-runtime.js";
import {
  addPluginMarketplace,
  configurePlugin,
  describePlugin,
  getPluginsOverview,
  installPlugin,
  listPlugins,
  removePluginMarketplace,
  resetPluginConfig,
  restoreBuiltinPlugin,
  setPluginEnabled,
  uninstallPlugin,
  updatePlugin,
  updatePluginMarketplace,
  validatePlugin,
} from "./plugins.js";
import {
  getPluginReferenceCatalog,
  resolveSuggestedPluginReference,
} from "./plugin-reference-catalog.js";
import { getSkillReferenceCatalog } from "./skill-reference-catalog.js";
import { readPluginUserOptions } from "./plugin-user-options.js";
import { getPluginMentionItems } from "./plugin-mention-items.js";
import {
  deleteSavedWorkflowOp,
  getSavedWorkflowOp,
  listSavedWorkflowRunsOp,
  listSavedWorkflowsOp,
  moveSavedWorkflowOp,
  updateSavedWorkflowMetaOp,
} from "./saved-workflows.js";
import { findSavedWorkflowForRunOp, saveSavedWorkflowFromRunOp } from "./saved-workflows-run.js";
import { listMcpServers, setWorkspaceMcpTrust } from "./mcp.js";
import {
  callMcpUiTool,
  sampleMcpUi,
  cancelMcpUiSampling,
  cancelMcpUiToolCall,
  listMcpUiResourceTemplates,
  listMcpUiResources,
  claimMcpUiAppToolCall,
  registerMcpUiAppTools,
  resolveMcpUiAppToolCall,
  unregisterMcpUiAppTools,
  readMcpUiResource,
  readMcpUiResourceForUi,
  routeMcpServerNotification,
  subscribeMcpUiResource,
  unsubscribeMcpUiResource,
} from "./mcp-ui/index.js";
import { listPluginUiSurfaces } from "./plugin-ui-surfaces.js";
import { updateInteractionPreferences } from "./interaction-preferences.js";
import { refreshProviderRegistry, updateAccountProviderConfig } from "./account-provider-config.js";
import { updateModelIoPreferences } from "./model-io-preferences.js";
import { updateOffPeakToolPolicy } from "./off-peak-tool-policy.js";
import { updateDynamicWorkflowPolicy } from "./dynamic-workflow-policy.js";
import { grantWorkspaceHookTrustForProtocol } from "./workspace-hook-trust.js";
import {
  V4InteractionRegistry,
  resolveV4InteractionRegistryOptionsFromEnv,
} from "../zcode-protocol-v4/interaction-registry.js";
import { createConversationV4Gateway } from "./v4-bridge.js";
import {
  createSessionResidentPoolHost,
  getSessionLifecycle,
  shutdownSessionRuntime,
} from "./session-residency.js";
import {
  measureSessionData,
  purgeSessionData,
  previewSessionDeletion,
  executeSessionDeletion,
} from "./session-data/index.js";
import {
  DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT,
  SessionResidentPool,
} from "./session-resident-pool.js";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import {
  createProtocolLogger,
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  PROTOCOL_CLIENT_REQUEST_ERROR_CODES,
  ProtocolRequestError,
  type ParamsSchema,
  parseParams,
  toProtocolError,
  type ZCodeProtocolClientRequestOptions,
  type ZCodeProtocolAgentDependencies,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { createInMemorySessionEventStore } from "@zcode/contracts";

export type { ZCodeProtocolAgentDependencies, ZCodeProtocolSessionRecord };

import { closeMcpUiInstance, openMcpUiInstance, validateMcpUiInstance } from "./mcp-ui/index.js";
const PLUGIN_PREPARATION_MUTATION_METHODS = new Set<string>([
  zcodeProtocolMethods.pluginsSetEnabled,
  zcodeProtocolMethods.pluginsInstall,
  zcodeProtocolMethods.pluginsUninstall,
  zcodeProtocolMethods.pluginsUpdate,
  zcodeProtocolMethods.pluginsRestoreBuiltin,
  zcodeProtocolMethods.pluginsConfigure,
  zcodeProtocolMethods.pluginsMarketplaceAdd,
  zcodeProtocolMethods.pluginsMarketplaceRemove,
  zcodeProtocolMethods.pluginsMarketplaceUpdate,
]);

const MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS = 10_000;

type ZCodeProtocolOutboundMessage = ZCodeProtocolNotification | ZCodeProtocolRequest;

/**
 * Trust store 落盘后各 session 的 coordinator
 * 内存镜像（仅创建时 load）不会自动更新，已信任 Hook 继续被拒、banner pendingCount
 * 停留旧值。pretrust 授权成功后按 workspaceKey 通知所有匹配的活跃 session 重载。
 * 独立导出为纯调度函数（不触网、不发事件），便于回归测试直接构造 sessions Map。
 */
export async function notifyWorkspaceHookTrustGrantSessions(input: {
  grantedWorkspace?: ZCodeWorkspaceRef;
  sessions: Map<string, ZCodeProtocolSessionRecord>;
}): Promise<void> {
  if (!input.grantedWorkspace) return;
  // Trust record 按 Trust identity 共享（D23）：源仓库授予后，同进程内它的受管 worktree
  // session 也必须重载；按 workspaceKey 过滤会漏掉 worktree。跨进程的通知由 Host 负责。
  const trustIdentityOf = (workspace: ZCodeWorkspaceRef) =>
    resolveWorkspaceHookTrustIdentityForWorkspace({
      workspacePath: resolve(workspace.workspacePath),
      ...(workspace.workspaceIdentity?.trim()
        ? { workspaceIdentity: workspace.workspaceIdentity.trim() }
        : {}),
    });
  const granted = await trustIdentityOf(input.grantedWorkspace);
  const records = [...input.sessions.values()];
  const identities = await Promise.all(records.map((record) => trustIdentityOf(record.workspace)));
  await Promise.all(
    records
      .filter((_record, index) => identities[index] === granted)
      .map((record) => record.app.reloadWorkspaceHookTrust()),
  );
}

function collectResidencySessionIds(params: unknown): string[] {
  if (!params || typeof params !== "object") return [];
  const candidate = params as {
    commands?: unknown;
    sessionId?: unknown;
    topic?: unknown;
  };
  const sessionIds = new Set<string>();
  if (typeof candidate.sessionId === "string" && candidate.sessionId.length > 0) {
    sessionIds.add(candidate.sessionId);
  }
  if (typeof candidate.topic === "string") {
    const topicSessionId = parseConversationTopic(candidate.topic);
    if (topicSessionId) sessionIds.add(topicSessionId);
  }
  if (Array.isArray(candidate.commands)) {
    for (const command of candidate.commands) {
      if (!command || typeof command !== "object") continue;
      const sessionId = (command as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        sessionIds.add(sessionId);
      }
    }
  }
  return [...sessionIds];
}

function getPluginOperationId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const operationId = (params as { operationId?: unknown }).operationId;
  return typeof operationId === "string" && operationId.trim().length > 0
    ? operationId.trim()
    : undefined;
}

function getOperationId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const operationId = (params as { operationId?: unknown }).operationId;
  return typeof operationId === "string" && operationId.trim().length > 0
    ? operationId.trim()
    : undefined;
}

export interface ZCodeProtocolPostResponseBatch {
  readonly messages: readonly ZCodeProtocolOutboundMessage[];
  commit(): boolean;
}

interface PendingClientRequest<T> {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
  resultSchema: ParamsSchema<T>;
  requestKeys: Set<string>;
  signal?: AbortSignal;
  timeout?: ReturnType<typeof setTimeout>;
  reannounceTimer?: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
}

export class ZCodeProtocolAgentServer {
  private readonly networkCapture = createNodeNetworkCapture("cli", (batch) => {
    this.messageSink?.({
      method: zcodeProtocolNotifications.processNetworkRequests,
      params: batch,
    });
  });
  private readonly runtimeResources: ProtocolRuntimeResources;
  private shutdownPromise?: Promise<void>;
  readonly browserControlPort: BrowserControlPort;
  /**
   * 官方 MCP 身份头端口所需的最小上下文。
   * MCP 连接池的构造早于 server，需要在 server 就绪后回填闭包持有的引用——
   * 与 v4Gateway 同样的构造顺序收口方式。只暴露 requestClient，不外泄整个 context。
   */
  /** MCP server 发起的 elicitation/create → 用户提问。 */
  requestMcpElicitation(
    request: McpElicitationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<McpElicitationResult> {
    return requestMcpElicitation(this.context, request, options);
  }

  /** MCP server 通知 → 会话 live 事件 / agent 日志。 */
  handleMcpNotification(notification: McpServerNotification): void {
    routeMcpServerNotification(this.context, notification);
  }

  get officialMcpAuthRequestContext(): Pick<ZCodeProtocolAgentServerContext, "requestClient"> {
    return this.context;
  }

  private messageSink?: (message: ZCodeProtocolOutboundMessage) => void;
  private clientDisconnectError?: Error;
  private readonly context: ZCodeProtocolAgentServerContext;
  private readonly logger;
  private readonly pendingClientRequests = new Map<string, PendingClientRequest<unknown>>();
  private readonly pluginOperationControllers = new Map<string, AbortController>();
  private readonly workspaceGenerateTextControllers = new Map<string, AbortController>();
  private readonly inputPrediction: ConversationInputPredictionHandler;
  /**
   * subscribe initial frame 按 JSON-RPC request id 隔离。connection 必须先 take，
   * 再写 response line，最后按数组顺序写 notification，不能靠 microtask 猜时序。
   */
  private readonly postResponseOutbox = new Map<
    ZCodeProtocolRequestId,
    ZCodeProtocolPostResponseBatch
  >();
  private nextClientRequestId = 1;

  constructor(deps: ZCodeProtocolAgentDependencies) {
    this.runtimeResources = new ProtocolRuntimeResources((options) =>
      deps.createZCodeApp({
        ...options,
        ...(deps.pluginPreparation ? { pluginPreparation: deps.pluginPreparation } : {}),
        ...(deps.pluginDiscovery ? { pluginDiscovery: deps.pluginDiscovery } : {}),
      }),
    );
    const resolvedDeps = {
      ...deps,
      createZCodeApp: this.runtimeResources.create,
      // 默认 turn 窗口保留策略。
      createSessionEventStore:
        deps.createSessionEventStore ?? (() => createInMemorySessionEventStore()),
      workspaceHookPolicyProvider:
        deps.workspaceHookPolicyProvider ?? new InMemoryWorkspaceHookPolicyProvider(),
    };
    this.logger = createProtocolLogger(resolvedDeps);
    this.context = {
      assertServing: () => this.runtimeResources.assertServing(),
      deps: resolvedDeps,
      logger: this.logger,
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        modelIoFullRetentionEnabled: false,
        offPeakToolEnabled: false,
        // 动态工作流灰度门 fail-closed：Host 必须显式 workspace/updateDynamicWorkflowPolicy
        // 才开启。
        dynamicWorkflowEnabled: false,
      },
      notify: (notification) => this.messageSink?.(notification),
      requestClient: (method, params, resultSchema, options) =>
        this.requestClient(method, params, resultSchema, options),
      sessions: new Map<string, ZCodeProtocolSessionRecord>(),
      // 交互应答登记表（broker 反向请求 × v4 resolveInteraction 命令的汇合点）。
      v4Interactions: new V4InteractionRegistry(
        resolveV4InteractionRegistryOptionsFromEnv(deps.env ?? process.env),
      ),
    };
    // v4 通道：gateway 闭包持有 context 做帧出口与命令副作用，构造完立即挂回。
    this.context.v4Gateway = createConversationV4Gateway(this.context);
    this.inputPrediction = new ConversationInputPredictionHandler({
      loadSession: createInputPredictionSessionLoader({
        sessions: this.context.sessions,
        sessionStore: resolvedDeps.sessionStore,
      }),
      logger: this.logger,
    });
    this.browserControlPort = createProtocolBrowserControlBroker(this.context);
    const sessionResidentTargetCount =
      deps.sessionResidentPoolOptions?.targetCount ?? deps.sessionResidentTargetCount;
    const sessionResidentHighWaterCount =
      deps.sessionResidentPoolOptions?.highWaterCount ??
      (sessionResidentTargetCount === undefined
        ? undefined
        : Math.max(DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT, sessionResidentTargetCount));
    // 单 CLI resident session 池：协议 request release 主动收敛，资源 sampler 只作兜底。
    this.context.sessionResidentPool = new SessionResidentPool(
      createSessionResidentPoolHost(this.context),
      {
        ...deps.sessionResidentPoolOptions,
        // legacy target 曾同时覆盖 high/low，导致迟滞窗口塌为 0；只覆盖 low。
        // 仅配置 target 且超过默认 high 时抬升隐式 high，显式非法组合仍由 pool 拒绝。
        highWaterCount: sessionResidentHighWaterCount,
        targetCount: sessionResidentTargetCount,
      },
    );
  }

  /** 低频 sampler 兜底入口；正常收敛由每个协议 request 的 operation lease 释放触发。 */
  rebalanceResidentSessions(): void {
    this.context.sessionResidentPool?.rebalance();
  }

  /**
   * 借同一 60s 节拍做 event store 的时间兜底淘汰：
   * subagent 子 session 只有一个 turn，等不到下一个 turn_started，只能按时间清。返回淘汰条数。
   */
  pruneSessionEventStores(nowMs: number = Date.now()): number {
    let evicted = 0;
    for (const record of this.context.sessions.values()) {
      evicted += record.eventStore.pruneTransientEvents?.(nowMs) ?? 0;
    }
    return evicted;
  }

  /** 同一 60s 节拍：释放已终态、无订阅者、无 record 的 detached subagent child publisher。 */
  pruneDetachedChildPublishers(nowMs: number = Date.now()): number {
    return this.context.v4Gateway?.pruneDetachedChildPublishers(nowMs) ?? 0;
  }

  /**
   * 内存诊断计数器，随 60s 资源采样写本地日志。
   * 只读 Map.size / 数组长度，不触碰 session 状态；持久化 event store 不提供 getStats 时计 0。
   */
  collectMemoryDiagnostics(): Record<string, number> {
    let eventRows = 0;
    let eventEvicted = 0;
    let eventTransientRetained = 0;
    for (const record of this.context.sessions.values()) {
      const stats = record.eventStore.getStats?.();
      eventRows += stats?.events ?? 0;
      eventEvicted += stats?.evictedEvents ?? 0;
      eventTransientRetained += stats?.retainedTransient ?? 0;
    }
    const counters: Record<string, number> = {
      sessions: this.context.sessions.size,
      eventRows,
      eventEvicted,
      eventTransientRetained,
    };
    const v4 = this.context.v4Gateway?.collectMemoryDiagnostics();
    if (v4) {
      for (const [key, value] of Object.entries(v4)) {
        counters[`v4.${key}`] = value;
      }
    }
    return counters;
  }

  setNotificationSink(sink: (message: ZCodeProtocolOutboundMessage) => void): void {
    this.runtimeResources.assertServing();
    this.clientDisconnectError = undefined;
    this.messageSink = sink;
  }

  disconnectClient(error: Error): void {
    this.networkCapture.setCaptureId(null);
    this.clientDisconnectError = error;
    // 连接关闭后反向请求已不可能收到响应，必须先结束 pending，
    // 否则正在物化 Session 的 handler 会阻塞 connection 的关闭流程。
    const pendingRequests = new Set(this.pendingClientRequests.values());
    for (const pending of pendingRequests) {
      this.cleanupClientRequest(pending);
      pending.reject(error);
    }
    // Bug 原因：Server Core 被 SIGKILL 后，Agent 的 stdin 虽然收到 EOF，但连接关闭
    // 只拒绝了反向请求，没有打断已经进入 Bash/工具循环的前台执行。transport 会继续
    // 等待该请求自然结束，旧 Agent 因而成为 PPID 1 的孤儿并在新 Core generation 之外
    // 继续写文件。协议 owner 消失就是本进程全部前台执行的终止边界，必须同步取消。
    for (const record of this.context.sessions.values()) {
      try {
        record.app.runtime.stopActiveForegroundExecution?.({
          reason: "ZCode Protocol owner disconnected",
        });
      } catch (cause) {
        this.logger?.warn("Failed to stop foreground execution after protocol disconnect", {
          errorType: cause instanceof Error ? cause.name : typeof cause,
          sessionId: record.app.sessionId,
        });
      }
      record.activeAbortController?.abort(error);
    }
    for (const controller of this.workspaceGenerateTextControllers.values()) {
      controller.abort(error);
    }
    this.workspaceGenerateTextControllers.clear();
    this.inputPrediction.dispose(error);
    for (const controller of this.pluginOperationControllers.values()) {
      controller.abort(error);
    }
    this.pluginOperationControllers.clear();
  }

  /** 进程资源关闭，不使用会删除产品会话/发布 session.removed 的 session/close。 */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    // abort listener 可以同步重入；在通知任何 owner 前先占有同一个关闭结果。
    const shutdown = Promise.withResolvers<void>();
    this.shutdownPromise = shutdown.promise;
    const closingResources = this.runtimeResources.close();
    const closingSessions: Promise<void>[] = [];
    const error = new Error("ZCode Protocol runtime stopping");
    this.disconnectClient(error);
    this.messageSink = undefined;
    this.clearPostResponseMessages();
    for (const controller of this.pluginOperationControllers.values()) controller.abort(error);
    for (const controller of this.workspaceGenerateTextControllers.values())
      controller.abort(error);
    for (const record of this.context.sessions.values()) {
      record.activeAbortController?.abort(error);
      if (getSessionLifecycle(this.context).isReady(record.app.sessionId)) {
        closingSessions.push(shutdownSessionRuntime(this.context, record.app.sessionId));
        continue;
      }
      try {
        record.unsubscribe?.();
      } catch {
        this.logger?.warn("Session unsubscribe failed during protocol shutdown", {
          event: "zcode_protocol.session.unsubscribe.failed",
        });
      }
    }
    void Promise.allSettled([closingResources, ...closingSessions]).then((results) => {
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length)
        shutdown.reject(new AggregateError(errors, "Protocol runtime shutdown failed"));
      else shutdown.resolve();
    });
    return this.shutdownPromise;
  }

  /** app drain 有界结束后释放投影；即使某个 app.close 挂起也必须执行。 */
  disposeProjections(): void {
    this.context.v4Gateway?.dispose();
    this.context.sessions.clear();
  }

  /** 一次性取走某 request 的 post-response messages；重复 take 返回空数组。 */
  takePostResponseMessages(requestId: ZCodeProtocolRequestId): ZCodeProtocolOutboundMessage[] {
    const batch = this.takePostResponseBatch(requestId);
    batch?.commit();
    return [...(batch?.messages ?? [])];
  }

  /** production NDJSON 取完整 batch；只有全部 write 成功后才调 commit。 */
  takePostResponseBatch(requestId: ZCodeProtocolRequestId): ZCodeProtocolPostResponseBatch | null {
    const batch = this.postResponseOutbox.get(requestId) ?? null;
    this.postResponseOutbox.delete(requestId);
    return batch;
  }

  /** connection close / server dispose 时释放尚未写出的 initial frame 引用。 */
  clearPostResponseMessages(): void {
    this.postResponseOutbox.clear();
  }

  async handleMessage(
    message: ZCodeProtocolMessage,
  ): Promise<ZCodeProtocolError | ZCodeProtocolResponse | undefined> {
    this.runtimeResources.assertServing();
    if (isResponse(message)) {
      this.resolveClientRequest(message.id, message.result);
      return undefined;
    }
    if (isErrorResponse(message)) {
      this.rejectClientRequest(
        message.id,
        new ProtocolRequestError(message.error.code, message.error.message, message.error.data),
      );
      return undefined;
    }
    if (isRequest(message)) {
      return await this.handleRequest(message);
    }
    if (isNotification(message)) {
      if (message.method === zcodeProtocolMethods.processNetworkCapture) {
        const control = networkCaptureControlSchema.safeParse(message.params);
        if (control.success) this.networkCapture.setCaptureId(control.data.captureId);
        return undefined;
      }
      this.logger?.debug("ZCode Protocol notification ignored", {
        event: "zcode_protocol.notification.ignored",
        method: message.method,
        module: "bootstrap.zcode_protocol",
      });
    }
    return undefined;
  }

  private async handleRequest(
    request: ZCodeProtocolRequest,
  ): Promise<ZCodeProtocolError | ZCodeProtocolResponse> {
    // request id 可在前一请求完成后复用；新请求不能继承未消费的旧 outbox。
    this.postResponseOutbox.delete(request.id);
    let releaseResidencyOperation: (() => void) | undefined;
    const deletionRequest =
      request.method === V4_METHODS.sessionDeletionPreview ||
      request.method === V4_METHODS.sessionDeletionExecute;
    const requestSessionIds = deletionRequest ? [] : collectResidencySessionIds(request.params);
    const requestCounts = (this.context.sessionRequestCounts ??= new Map<string, number>());
    // 运行态还未进入 busy 的异步请求也必须阻止删除，避免确认期间恢复与删除交错。
    for (const id of requestSessionIds) requestCounts.set(id, (requestCounts.get(id) ?? 0) + 1);
    const changesPlugins = PLUGIN_PREPARATION_MUTATION_METHODS.has(request.method);
    // 变更前仍按源元数据校验；只在完成后失效，避免一次写入反复打断并发读。
    try {
      // subscribe hydration、workspace 配置与 resume 都可能跨 await。若只看
      // session 当前状态，sampler 会在 handler 持有旧 record 时把它关闭。进程级 lease
      // 覆盖整个 request；能识别的 sessionIds 额外用于冷恢复闸门与 LRU touch。
      const lifecycleQuery = request.method === zcodeProtocolMethods.sessionLifecycleGetState;
      const lifecycleMutation =
        request.method === zcodeProtocolMethods.sessionLifecycleEnsureReady ||
        request.method === zcodeProtocolMethods.sessionLifecycleStop ||
        request.method === zcodeProtocolMethods.sessionLifecycleRestart;
      // 查询不能续期或触发回收。生命周期变更使用进程 lease，按 session 的互斥由 owner 管理。
      const sessionIds = lifecycleMutation ? [] : collectResidencySessionIds(request.params);
      if (!lifecycleQuery) {
        // 若先一步取得自动重载资格，新请求等新实例就绪才获取租约，不能在旧 Inbox 留下输入。
        for (const id of sessionIds) {
          const flight = this.context.sessionLifecycle?.idleRestartInProgress(id);
          if (flight) await flight;
        }
        releaseResidencyOperation =
          await this.context.sessionResidentPool?.acquireOperation(sessionIds);
      }
      if (
        request.method !== V4_METHODS.sessionDeletionPreview &&
        request.method !== V4_METHODS.sessionDeletionExecute
      )
        for (const id of collectResidencySessionIds(request.params))
          await this.context.deps.sessionStore?.assertSessionNotDeleting?.(id as SessionId);
      const result = await this.dispatchRequest(request);
      return this.ok(request.id, result);
    } catch (error) {
      this.postResponseOutbox.delete(request.id);
      const protocolError = toProtocolError(error);
      return this.fail(request.id, protocolError.code, protocolError.message, protocolError.data);
    } finally {
      if (changesPlugins) {
        this.context.deps?.pluginPreparation?.invalidate();
        this.context.deps?.pluginDiscovery?.invalidate?.();
      }
      releaseResidencyOperation?.();
      for (const id of requestSessionIds) {
        const remaining = (requestCounts.get(id) ?? 1) - 1;
        if (remaining) requestCounts.set(id, remaining);
        else requestCounts.delete(id);
      }
    }
  }

  private async dispatchRequest(request: ZCodeProtocolRequest) {
    switch (request.method) {
      // ── v4 conversation 通道（竖切，与旧 session/* 并存）──
      case V4_METHODS.connectionFlow: {
        this.requireV4Gateway().setConnectionFlowState(request.params);
        return {};
      }
      case V4_METHODS.conversationSubscribe: {
        // 同一 subscribe 方法按 topic 前缀分派：
        // sessions-index/* → 列表订阅；workspace-config/* → 配置目录订阅；否则 conversation。
        const gateway = this.requireV4Gateway();
        const topic = (request.params as { topic?: unknown } | null)?.topic;
        let dispatch;
        if (typeof topic === "string" && parseSessionsIndexTopic(topic) !== null) {
          dispatch = await gateway.subscribeSessionsIndexReserved(request.params);
        } else if (typeof topic === "string" && parseWorkspaceConfigTopic(topic) !== null) {
          dispatch = await gateway.subscribeWorkspaceConfigReserved(request.params);
        } else {
          dispatch = await gateway.subscribeReserved(request.params);
        }
        if (dispatch.initialWires.length > 0) {
          this.postResponseOutbox.set(request.id, {
            messages: dispatch.initialWires.map((wire) => ({
              method: V4_NOTIFICATIONS.conversationFrame,
              params: wire,
            })),
            commit: dispatch.commit,
          });
        }
        return { ack: dispatch.ack };
      }
      case V4_METHODS.conversationResync: {
        // same-sub recovery 与 subscribe 共用确定性 post-response outbox；公共
        // response 仍 strict ACK-only，physical recovery 只能在 ACK line 后发送。
        const dispatch = this.requireV4Gateway().resyncReserved(request.params);
        if (dispatch.initialWires.length > 0) {
          this.postResponseOutbox.set(request.id, {
            messages: dispatch.initialWires.map((wire) => ({
              method: V4_NOTIFICATIONS.conversationFrame,
              params: wire,
            })),
            commit: dispatch.commit,
          });
        }
        return { ack: dispatch.ack };
      }
      case V4_METHODS.conversationUnsubscribe: {
        // topic + subscriptionId + connectionId 精确命中唯一 publisher；禁止按裸
        // subId 对 conversation/sessions-index/workspace-config 广撒网。
        this.requireV4Gateway().unsubscribe(request.params);
        return {};
      }
      // ── 行分页 query（独立分支，便于与帧分派改动合并）──
      case V4_METHODS.conversationRowsRange:
        return await this.requireV4Gateway().rowsRange(request.params);
      // 手机输入预测：只读、无状态；同会话新请求替代旧请求。
      case V4_METHODS.conversationInputPrediction:
        return await this.inputPrediction.handle(request.params);
      case V4_METHODS.conversationPlans:
        return await this.requireV4Gateway().plans(request.params);
      case V4_METHODS.backgroundBashOutput:
        return await this.requireV4Gateway().backgroundBashOutput(request.params);
      case V4_METHODS.offPeakControl: {
        const params = offPeakControlParamsSchema.parse(request.params);
        const record = this.context.sessions.get(params.sessionId);
        // 生命周期只存在于驻留 runtime；换票不能恢复冷会话或重放原始输入。
        return offPeakControlResultSchema.parse(
          record ? await record.app.runtime.controlOffPeakExecution(params) : { accepted: false },
        );
      }
      case V4_METHODS.conversationFileChanges:
        return await this.requireV4Gateway().fileChanges(request.params);
      case V4_METHODS.conversationFileRewindPreview:
        return await this.requireV4Gateway().fileRewindPreview(request.params);
      // workflow run 事件日志分页（只读、无状态、超时重发安全；新方法天然偏斜安全）。
      case V4_METHODS.conversationWorkflowRunEvents:
        return await this.requireV4Gateway().workflowRunEvents(request.params);
      // dwf run 枚举（重启后的发现查询）。
      case V4_METHODS.conversationWorkflowRuns:
        return await this.requireV4Gateway().workflowRuns(request.params);
      // dwf 用户面产物的三个读面。同族：只读、无状态、
      // 超时重发安全；ArtifactRead 的授权在宿主端口侧，网关只校参数与分块。
      case V4_METHODS.conversationWorkflowRunArtifacts:
        return await this.requireV4Gateway().workflowRunArtifacts(request.params);
      case V4_METHODS.conversationWorkflowRunArtifactData:
        return await this.requireV4Gateway().workflowRunArtifactData(request.params);
      case V4_METHODS.conversationWorkflowRunArtifactRead:
        return await this.requireV4Gateway().workflowRunArtifactRead(request.params);
      // dwf 工作区 transcript 的两个读面。同族。
      case V4_METHODS.conversationWorkflowRunWorkspace:
        return await this.requireV4Gateway().workflowRunWorkspace(request.params);
      case V4_METHODS.conversationWorkflowRunNodeResult:
        return await this.requireV4Gateway().workflowRunNodeResult(request.params);
      // 附件只能走小 RPC transaction，禁止 full-data attachment/put 单行。
      case V4_METHODS.attachmentBegin:
        return await this.requireV4Gateway().attachmentBegin(request.params);
      case V4_METHODS.attachmentChunk:
        return await this.requireV4Gateway().attachmentChunk(request.params);
      case V4_METHODS.attachmentCommit:
        return await this.requireV4Gateway().attachmentCommit(request.params);
      case V4_METHODS.attachmentAbort:
        await this.requireV4Gateway().attachmentAbort(request.params);
        return {};
      case V4_METHODS.attachmentRead:
        return await this.requireV4Gateway().attachmentRead(request.params);
      case V4_METHODS.conversationAttachmentRead:
        return await this.requireV4Gateway().conversationAttachmentRead(request.params);
      case V4_METHODS.conversationAttachmentStat:
        return await this.requireV4Gateway().conversationAttachmentStat(request.params);
      case V4_METHODS.attachmentPreviewSource:
        return await this.requireV4Gateway().attachmentPreviewSource(request.params);
      // ── usage query（additive）：与旧 usage/stats、session/usage 同一数据访问
      // 层（usage store 聚合），仅换 v4 名字空间——不经 v4Gateway（无会话投影依赖），
      // 也不经旧 op 分派（无桥）。旧 case 保留到旧词删除（老 host 版本兼容）。──
      case V4_METHODS.usageStats:
        return await getUsageStats(this.context, request.params);
      case V4_METHODS.conversationUsage:
        return await getTaskTokenUsage(this.context, request.params);
      case V4_METHODS.conversationContextComposition:
        return await getConversationContextComposition(this.context, request.params);
      // 项目数据彻底删除：不经 v4Gateway 会话投影，直接操作本进程的 store 与会话注册表。
      case V4_METHODS.sessionDeletionPreview:
        return previewSessionDeletion(this.context, request.params);
      case V4_METHODS.sessionDeletionExecute:
        return executeSessionDeletion(this.context, request.params);
      case V4_METHODS.sessionDataMeasure:
        return await measureSessionData(this.context, request.params);
      case V4_METHODS.sessionDataPurge:
        return await purgeSessionData(this.context, request.params);
      case V4_METHODS.command:
        return this.requireV4Gateway().handleCommand(request.params);
      case V4_METHODS.commandsQuery:
        return this.requireV4Gateway().queryCommands(request.params);
      case V4_METHODS.sessionsIndexReconcile:
        return this.requireV4Gateway().reconcileSessions(request.params);
      case zcodeProtocolMethods.sessionCreate:
        return await createSession(this.context, request.params, request.trace);
      case zcodeProtocolMethods.sessionLifecycleGetState: {
        const { sessionId } = parseParams(sessionLifecycleParamsSchema, request.params);
        return sessionLifecycleSnapshotSchema.parse(
          await getSessionLifecycle(this.context).getState(sessionId),
        );
      }
      case zcodeProtocolMethods.sessionLifecycleStop: {
        const { sessionId } = parseParams(sessionLifecycleParamsSchema, request.params);
        await getSessionLifecycle(this.context).stop(sessionId);
        return { completed: true as const };
      }
      case zcodeProtocolMethods.sessionLifecycleEnsureReady:
      case zcodeProtocolMethods.sessionLifecycleRestart: {
        const { sessionId, workspace } = parseParams(
          sessionLifecycleActivationParamsSchema,
          request.params,
        );
        const lifecycle = getSessionLifecycle(this.context);
        if (request.method === zcodeProtocolMethods.sessionLifecycleEnsureReady)
          await lifecycle.ensureReady(sessionId, workspace);
        else await lifecycle.restart(sessionId, workspace);
        return { completed: true as const };
      }
      case zcodeProtocolMethods.sessionResume:
        return await resumeSession(this.context, request.params);
      case zcodeProtocolMethods.sessionList:
        return await listSessions(this.context, request.params);
      case zcodeProtocolMethods.sessionSubagents:
        return await listSessionSubagents(this.context, request.params);
      case zcodeProtocolMethods.sessionRead:
        return await readSession(this.context, request.params);
      case zcodeProtocolMethods.sessionMessages:
        return await readMessages(this.context, request.params);
      case zcodeProtocolMethods.sessionEvents:
        return await readEvents(this.context, request.params);
      case zcodeProtocolMethods.sessionSubscribe:
        return await subscribeSession(this.context, request.params);
      case zcodeProtocolMethods.sessionSend:
        return await sendPrompt(this.context, request.params);
      case zcodeProtocolMethods.sessionStop:
        return await stopSession(this.context, request.params);
      case zcodeProtocolMethods.sessionCancelBackgroundTask:
        return await cancelBackgroundTask(this.context, request.params);
      case zcodeProtocolMethods.sessionFork:
        return await forkSession(this.context, request.params);
      case zcodeProtocolMethods.sessionCompact:
        return await compactSession(this.context, request.params);
      case zcodeProtocolMethods.sessionGoal:
        return await goalSession(this.context, request.params);
      case zcodeProtocolMethods.sessionSetModel:
        return await setModel(this.context, request.params);
      case zcodeProtocolMethods.sessionSetThoughtLevel:
        return await setThoughtLevel(this.context, request.params);
      case zcodeProtocolMethods.sessionSetMode:
        return await setMode(this.context, request.params);
      case zcodeProtocolMethods.sessionClose:
        return await closeSession(this.context, request.params);
      case zcodeProtocolMethods.sessionReleaseUnderDirectory:
        return await releaseSessionsUnderDirectory(this.context, request.params);
      case zcodeProtocolMethods.workspaceReadPresentation:
        return await readWorkspacePresentation(this.context, request.params);
      case zcodeProtocolMethods.workspaceHookTrustGrant: {
        const grantResult = await grantWorkspaceHookTrustForProtocol(request.params, {
          appVersion: this.context.deps.version,
          policyProvider: this.context.deps.workspaceHookPolicyProvider,
        });
        if (grantResult.accepted) {
          const grantedParams = zcodeWorkspaceHookTrustGrantParamsSchema.safeParse(request.params);
          await notifyWorkspaceHookTrustGrantSessions({
            // dispatch 层的 params 是弱类型；grant 内部已用同一 schema parse 过，这里
            // safeParse 只为取出 workspace 做匹配，失败即跳过通知（防御，正常必成功）。
            grantedWorkspace: grantedParams.success ? grantedParams.data.workspace : undefined,
            sessions: this.context.sessions,
          });
        }
        return grantResult;
      }
      case zcodeProtocolMethods.providerUpdateAccountConfig:
        return await updateAccountProviderConfig(this.context, request.params);
      case zcodeProtocolMethods.providerRefreshRegistry:
        return await refreshProviderRegistry(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateInteractionPreferences:
        return await updateInteractionPreferences(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateModelIoPreferences:
        return await updateModelIoPreferences(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy:
        return await updateOffPeakToolPolicy(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy:
        return await updateDynamicWorkflowPolicy(this.context, request.params);
      case zcodeProtocolMethods.workspaceGenerateText:
        return await this.withWorkspaceGenerateTextSignal(request, (signal) =>
          generateWorkspaceText(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.workspaceCancelGenerateText:
        return this.cancelWorkspaceGenerateText(request.params);
      case zcodeProtocolMethods.providerTestModelConnectivity:
        return await testProviderModelConnectivity(this.context, request.params);
      case zcodeProtocolMethods.workspaceMcpTrust:
        return await setWorkspaceMcpTrust(this.context, request.params);
      case zcodeProtocolMethods.mcpList:
        return await listMcpServers(this.context, request.params);
      case zcodeProtocolMethods.mcpReadResource:
        return await readMcpUiResource(this.context, request.params);
      case zcodeProtocolMethods.mcpUiOpenInstance:
        return openMcpUiInstance(this.context, request.params);
      case zcodeProtocolMethods.mcpUiValidateInstance:
        return validateMcpUiInstance(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCloseInstance:
        return closeMcpUiInstance(this.context, request.params);
      case zcodeProtocolMethods.mcpUiSampling:
        return sampleMcpUi(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCancelSampling:
        return cancelMcpUiSampling(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCallTool:
        return await callMcpUiTool(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCancelCall:
        return await cancelMcpUiToolCall(this.context, request.params);
      case zcodeProtocolMethods.mcpUiReadResource:
        return await readMcpUiResourceForUi(this.context, request.params);
      case zcodeProtocolMethods.mcpUiListResources:
        return await listMcpUiResources(this.context, request.params);
      case zcodeProtocolMethods.mcpUiListResourceTemplates:
        return await listMcpUiResourceTemplates(this.context, request.params);
      case zcodeProtocolMethods.mcpUiSubscribeResource:
        return await subscribeMcpUiResource(this.context, request.params);
      case zcodeProtocolMethods.mcpUiUnsubscribeResource:
        return await unsubscribeMcpUiResource(this.context, request.params);
      case zcodeProtocolMethods.mcpUiRegisterAppTools:
        return await registerMcpUiAppTools(this.context, request.params);
      case zcodeProtocolMethods.mcpUiUnregisterAppTools:
        return await unregisterMcpUiAppTools(this.context, request.params);
      case zcodeProtocolMethods.mcpUiClaimAppToolCall:
        return await claimMcpUiAppToolCall(this.context, request.params);
      case zcodeProtocolMethods.mcpUiResolveAppToolCall:
        return await resolveMcpUiAppToolCall(this.context, request.params);
      case zcodeProtocolMethods.pluginsList:
        return await listPlugins(this.context, request.params);
      case zcodeProtocolMethods.pluginsReferenceCatalogWithCategory:
        return await getPluginReferenceCatalog(this.context, request.params, true);
      case zcodeProtocolMethods.pluginsReferenceCatalog:
        return await getPluginReferenceCatalog(this.context, request.params);
      case zcodeProtocolMethods.pluginsListUiSurfaces:
        return await listPluginUiSurfaces(this.context, request.params);
      case zcodeProtocolMethods.skillsReferenceCatalog:
        return await getSkillReferenceCatalog(this.context, request.params);
      case zcodeProtocolMethods.workflowsList:
        return await listSavedWorkflowsOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsGet:
        return await getSavedWorkflowOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsUpdateMeta:
        return await updateSavedWorkflowMetaOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsDelete:
        return await deleteSavedWorkflowOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsRuns:
        return await listSavedWorkflowRunsOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsMove:
        return await moveSavedWorkflowOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsSave:
        return await saveSavedWorkflowFromRunOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsForRun:
        return await findSavedWorkflowForRunOp(this.context, request.params);
      case zcodeProtocolMethods.pluginsResolveSuggestedReference:
        return await this.withPluginOperationSignal(request, (signal) =>
          resolveSuggestedPluginReference(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsSetEnabled:
        return await this.withPluginOperationSignal(request, (signal) =>
          setPluginEnabled(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsOverview:
        return await getPluginsOverview(this.context, request.params);
      case zcodeProtocolMethods.processChildProcesses:
        return listChildProcesses(this.context.deps.mcpTelemetry?.listProcesses() ?? []);
      case zcodeProtocolMethods.runtimeCapabilities: {
        const params = zcodeRuntimeCapabilitiesParamsSchema.parse(request.params ?? {});
        // 旧 Host 的严格 schema 不接收新增字段；先协商，再发布目录来源。
        this.context.sessionDirectorySourceEnabled ||=
          params.hostCapabilities?.sessionDirectorySource === true;
        this.context.sessionWorkspaceRoutingEnabled ||=
          params.hostCapabilities?.sessionWorkspaceRouting === true;
        return {
          sessionLifecycleWorkspace: true,
          sessionWorkspaceRouting: true,
          independentPlanState: true,
          highspeedCardOwner: true,
          historyFirst: true,
          pluginDiscoveryUi: true,
          sessionDirectorySource: true,
          residentRowsRange: true,
          genUiContext: true,
          // 会话 cwd 可与 workspace 不同（受管 worktree）：createSession.cwd / worktreeCreation、
          // forkAssistant.targetCwd、按 Host workspace key 冷恢复。旧 Host 的结果 schema 非 strict。
          worktreeCwd: true,
          // 认识 {kind:"extension"} 输入来源（sendText / createSession.firstInput）。旧 CLI 会拒绝或
          // 静默剥掉它，Host 据此决定能否代扩展发消息（docs/design/v2/conversation-input-source.md §7）。
          extensionInputSource: true,
          // 对话引用的 comment / agent 字段会进入模型输入（选区批注）；旧 CLI 会静默剥掉。
          conversationQuoteComment: true,
          // plugins/overview 认识 includeExtensionSummary，并按它在商店信息里带扩展摘要
          // （docs/design/v2/plugin-compat.md「Extension summary」）。
          pluginExtensionSummary: true,
        };
      }
      case zcodeProtocolMethods.pluginsMarketplaceAdd:
        return await this.withPluginOperationSignal(request, (signal) =>
          addPluginMarketplace(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsMarketplaceRemove:
        return await removePluginMarketplace(this.context, request.params);
      case zcodeProtocolMethods.pluginsMarketplaceUpdate:
        return await this.withPluginOperationSignal(request, (signal) =>
          updatePluginMarketplace(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsInstall:
        return await this.withPluginOperationSignal(request, (signal) =>
          installPlugin(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsCancelOperation:
        return this.cancelPluginOperation(request.params);
      case zcodeProtocolMethods.pluginsUninstall:
        return await uninstallPlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsUpdate:
        return await updatePlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsRestoreBuiltin:
        return await restoreBuiltinPlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsConfigure:
        return await configurePlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsResetConfig:
        return await resetPluginConfig(this.context, request.params);
      case zcodeProtocolMethods.pluginsValidate:
        return await validatePlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsDescribe:
        return await describePlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsReadUserOptions:
        return await readPluginUserOptions(this.context, request.params);
      case zcodeProtocolMethods.pluginsMentionItems:
        return await getPluginMentionItems(this.context, request.params);
      case zcodeProtocolMethods.usageStats:
        return await getUsageStats(this.context, request.params);
      case zcodeProtocolMethods.sessionDebug:
        return querySessionDebug(this.context, request.params);
      case zcodeProtocolMethods.sessionUsage:
        return await getTaskTokenUsage(this.context, request.params);
      default:
        throw new ProtocolRequestError(-32601, `Method not found: ${request.method}`);
    }
  }

  private requireV4Gateway() {
    if (!this.context.v4Gateway) {
      throw new ProtocolRequestError(-32603, "v4 gateway is not initialized");
    }
    return this.context.v4Gateway;
  }

  private async withPluginOperationSignal<T>(
    request: ZCodeProtocolRequest,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operationId = getPluginOperationId(request.params);
    if (!operationId) return await run();

    const controller = new AbortController();
    this.pluginOperationControllers.set(operationId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.pluginOperationControllers.get(operationId) === controller) {
        this.pluginOperationControllers.delete(operationId);
      }
    }
  }

  private cancelPluginOperation(rawParams: unknown) {
    const params = parseParams(zcodePluginsCancelOperationParamsSchema, rawParams);
    const controller = this.pluginOperationControllers.get(params.operationId);
    if (!controller) return { operationId: params.operationId, cancelled: false };
    // 插件同步的可取消能力必须保留在 V4 server；仅按 operationId 中止对应链路。
    controller.abort();
    this.pluginOperationControllers.delete(params.operationId);
    return { operationId: params.operationId, cancelled: true };
  }

  private async withWorkspaceGenerateTextSignal<T>(
    request: ZCodeProtocolRequest,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operationId = getOperationId(request.params);
    if (!operationId) return await run();

    if (this.workspaceGenerateTextControllers.has(operationId)) {
      // 重复 operationId 会覆盖首个请求的 AbortController，导致首个请求失去取消能力。
      // 活跃 operationId 必须保持唯一；请求结束后 finally 会释放，之后才允许复用。
      throw new ProtocolRequestError(
        -32600,
        `Workspace generate operation is already active: ${operationId}`,
      );
    }

    const controller = new AbortController();
    this.workspaceGenerateTextControllers.set(operationId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.workspaceGenerateTextControllers.get(operationId) === controller) {
        this.workspaceGenerateTextControllers.delete(operationId);
      }
    }
  }

  private cancelWorkspaceGenerateText(rawParams: unknown) {
    const params = parseParams(zcodeWorkspaceCancelGenerateTextParamsSchema, rawParams);
    const controller = this.workspaceGenerateTextControllers.get(params.operationId);
    if (!controller) return { operationId: params.operationId, cancelled: false };
    controller.abort(new DOMException("Workspace model request cancelled", "AbortError"));
    this.workspaceGenerateTextControllers.delete(params.operationId);
    return { operationId: params.operationId, cancelled: true };
  }

  private ok(id: ZCodeProtocolRequestId, result: unknown): ZCodeProtocolResponse {
    return { id, result };
  }

  private fail(
    id: ZCodeProtocolRequestId,
    code: number,
    message: string,
    data?: unknown,
  ): ZCodeProtocolError {
    return { error: { code, data, message }, id };
  }

  private requestClient<T>(
    method: ZCodeProtocolMethod,
    params: unknown,
    resultSchema: ParamsSchema<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T> {
    if (this.clientDisconnectError) {
      throw this.clientDisconnectError;
    }
    if (!this.messageSink) {
      throw new ProtocolRequestError(
        PROTOCOL_CLIENT_REQUEST_ERROR_CODES.noClientAttached,
        `No ZCode Protocol client is attached for ${method}`,
      );
    }

    return new Promise<T>((resolve, reject) => {
      let active = true;
      const pending: PendingClientRequest<T> = {
        method,
        reject,
        resolve,
        resultSchema,
        requestKeys: new Set(),
        signal: options?.signal,
      };
      const cleanup = () => {
        active = false;
        this.cleanupClientRequest(pending);
      };
      pending.abortHandler = () => {
        cleanup();
        reject(
          new ProtocolRequestError(
            PROTOCOL_CLIENT_REQUEST_ERROR_CODES.cancelled,
            `Client request cancelled: ${method}`,
          ),
        );
      };
      if (options?.signal?.aborted) {
        pending.abortHandler();
        return;
      }
      if (options?.timeoutMs !== undefined) {
        pending.timeout = setTimeout(() => {
          cleanup();
          reject(
            new ProtocolRequestError(
              PROTOCOL_CLIENT_REQUEST_ERROR_CODES.timedOut,
              `Client request timed out: ${method}`,
              {
                timeoutMs: options.timeoutMs,
              },
            ),
          );
        }, options.timeoutMs);
      }
      options?.signal?.addEventListener("abort", pending.abortHandler, { once: true });
      const sendClientRequest = () => {
        if (!active) {
          return;
        }
        const id = `server-${this.nextClientRequestId++}`;
        const key = String(id);
        pending.requestKeys.add(key);
        this.pendingClientRequests.set(key, pending as PendingClientRequest<unknown>);
        this.messageSink?.({
          id,
          method,
          params,
          ...(options?.trace ? { trace: options.trace } : {}),
        });
      };
      sendClientRequest();
      const reannounceIntervalMs =
        options?.reannounceIntervalMs !== undefined &&
        Number.isFinite(options.reannounceIntervalMs) &&
        options.reannounceIntervalMs > 0
          ? Math.floor(options.reannounceIntervalMs)
          : undefined;
      if (reannounceIntervalMs !== undefined) {
        let nextReannounceIntervalMs = reannounceIntervalMs;
        const scheduleReannounce = () => {
          pending.reannounceTimer = setTimeout(() => {
            if (!active) {
              return;
            }
            sendClientRequest();
            nextReannounceIntervalMs = Math.min(
              nextReannounceIntervalMs * 2,
              MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS,
            );
            scheduleReannounce();
          }, nextReannounceIntervalMs);
        };
        scheduleReannounce();
      }
    });
  }

  private resolveClientRequest(id: ZCodeProtocolRequestId, result: unknown): void {
    const key = String(id);
    const pending = this.pendingClientRequests.get(key);
    if (!pending) {
      return;
    }
    this.cleanupClientRequest(pending);
    try {
      pending.resolve(pending.resultSchema.parse(result));
    } catch (error) {
      pending.reject(
        error instanceof Error ? error : new Error(`Invalid response: ${pending.method}`),
      );
    }
  }

  private rejectClientRequest(id: ZCodeProtocolRequestId, error: Error): void {
    const key = String(id);
    const pending = this.pendingClientRequests.get(key);
    if (!pending) {
      return;
    }
    this.cleanupClientRequest(pending);
    pending.reject(error);
  }

  private cleanupClientRequest<T>(pending: PendingClientRequest<T>): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (pending.reannounceTimer) {
      clearTimeout(pending.reannounceTimer);
    }
    if (pending.abortHandler) {
      pending.signal?.removeEventListener("abort", pending.abortHandler);
    }
    for (const requestKey of pending.requestKeys) {
      this.pendingClientRequests.delete(requestKey);
    }
    pending.requestKeys.clear();
  }
}
