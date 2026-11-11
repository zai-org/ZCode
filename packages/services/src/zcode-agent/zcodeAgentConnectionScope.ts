/* eslint-disable max-lines -- 三类 V4 topic 的同构 connection ownership 生命周期集中在单一 facade。 */
// V4 connection-scoped service facade：每个 RPC attachment 独立持有 subscription
// ownership；base service 仍只转发 CLI 事实，不在 host/main/relay 复制业务状态。
import { Emitter, Event as RpcEvent, type Event, type IDisposable } from "@zcode/rpc";
import {
  V4_WIRE_PROTOCOL_VERSION,
  clientHelloSchema,
  clientSupportsWorkflowRunDeltas,
  conversationTopic,
  sessionsIndexTopic,
  workspaceConfigTopic,
  type ConversationTopicWireCandidate,
  type HelloMessage,
  type SessionsIndexTopicWireCandidate,
  type V4ConnectionFlowState,
  type WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  IZCodeAgentService,
  ZCodeAgentConversationResyncParams,
  ZCodeAgentConversationUnsubscribeParams,
  ZCodeAgentRuntimePolicy,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import { isRemoteInputPredictionEnabled } from "./inputPredictionSwitch.js";

export type ZCodeAgentV4ClientMode = "desktop-continuous" | "web-remote-replayable";

export interface ZCodeAgentV4ConnectionContext {
  connectionId: string;
  clientMode: ZCodeAgentV4ClientMode;
  role?: "terminal-client" | "trusted-host-relay";
  /**
   * 这条连接的 clientHello 声明了认得 `workflowRun.*` 键级增量。与 `clientMode` 同族：
   * 由本 facade 从握手事实写出，订阅入参里的同名字段一律被清掉——一个客户端认不认得增量
   * 是**连接**的事实，不是某一次订阅可以自选的口味。缺席 = 按旧消费者处理。
   */
  workflowRunDeltas?: boolean;
  pluginDiscoveryUi?: boolean;
  historyFirst?: boolean;
}

const TRUSTED_CONNECTION_FIELD = "__zcodeTrustedV4Connection";
const TRUSTED_UNSUBSCRIBE_ROUTE_FIELD = "__zcodeTrustedV4UnsubscribeRoute";

type TrustedConnectionCarrier = {
  [TRUSTED_CONNECTION_FIELD]?: ZCodeAgentV4ConnectionContext;
};

export interface TrustedZCodeAgentV4UnsubscribeRoute {
  topic: string;
  connectionId: string;
}

type TrustedUnsubscribeRouteCarrier = {
  [TRUSTED_UNSUBSCRIBE_ROUTE_FIELD]?: TrustedZCodeAgentV4UnsubscribeRoute;
};

export function readTrustedZCodeAgentV4UnsubscribeRoute(
  value: unknown,
): TrustedZCodeAgentV4UnsubscribeRoute | null {
  if (typeof value !== "object" || value === null) return null;
  const route = (value as TrustedUnsubscribeRouteCarrier)[TRUSTED_UNSUBSCRIBE_ROUTE_FIELD];
  if (!route || typeof route.topic !== "string" || typeof route.connectionId !== "string") {
    return null;
  }
  return route;
}

/**
 * 该字段只在 host facade → base/remote service proxy 之间传递；facade 会覆盖所有
 * UI 入参中的同名字段，因此 renderer/mobile 不能伪造可信连接模式。
 */
export function readTrustedZCodeAgentV4Connection(
  value: unknown,
): ZCodeAgentV4ConnectionContext | null {
  if (typeof value !== "object" || value === null) return null;
  const context = (value as TrustedConnectionCarrier)[TRUSTED_CONNECTION_FIELD];
  if (!context || typeof context.connectionId !== "string") return null;
  if (
    context.clientMode !== "desktop-continuous" &&
    context.clientMode !== "web-remote-replayable"
  ) {
    return null;
  }
  return {
    connectionId: context.connectionId,
    clientMode: context.clientMode,
    // 只认 true：缺席与 false 都是「旧消费者」，键在场与否是下游读端的判据。
    ...(context.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
    ...(context.pluginDiscoveryUi === true ? { pluginDiscoveryUi: true } : {}),
    ...(context.historyFirst === true ? { historyFirst: true } : {}),
  };
}

function withTrustedConnection<T extends object>(
  value: T,
  context: ZCodeAgentV4ConnectionContext,
): T {
  const forwarded: Record<string, unknown> = {
    ...(value as unknown as Record<string, unknown>),
  };
  // 共享 service 暴露在多个 RPC port 上时，调用方曾能传 profile，且所有
  // port 共用 workspace fan-out。facade 必须先清掉所有可伪造字段，再写 host 真值。
  delete forwarded[TRUSTED_CONNECTION_FIELD];
  delete forwarded["connectionId"];
  delete forwarded["clientMode"];
  delete forwarded["deliveryProfile"];
  delete forwarded["subscriberScope"];
  // 与 clientMode 同族的可信位：UI 面的 subscribe 不能自己挑增量编码。
  delete forwarded["workflowRunDeltas"];
  delete forwarded["pluginDiscoveryUi"];
  delete forwarded["historyFirst"];
  forwarded[TRUSTED_CONNECTION_FIELD] = context;
  return forwarded as T;
}

function withTrustedUnsubscribeRoute<T extends object>(
  value: T,
  route: TrustedZCodeAgentV4UnsubscribeRoute,
): T {
  const forwarded = {
    ...(value as unknown as Record<string, unknown>),
  };
  delete forwarded[TRUSTED_UNSUBSCRIBE_ROUTE_FIELD];
  forwarded[TRUSTED_UNSUBSCRIBE_ROUTE_FIELD] = route;
  return forwarded as T;
}

/** sendText.source 或 createSession.firstInput.source 是 extension（CLI 契约 conversation-input-source.md §2）。 */
function carriesExtensionInputSource(envelope: { type: string; payload: unknown }): boolean {
  const payload =
    envelope.payload && typeof envelope.payload === "object"
      ? (envelope.payload as {
          source?: { kind?: unknown };
          firstInput?: { source?: { kind?: unknown } } | null;
        })
      : undefined;
  if (envelope.type === "sendText") return payload?.source?.kind === "extension";
  if (envelope.type === "createSession") return payload?.firstInput?.source?.kind === "extension";
  return false;
}

function workspaceKey(target: ZCodeAgentWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function workspaceTarget(target: ZCodeAgentWorkspaceTarget): ZCodeAgentWorkspaceTarget {
  return {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
}

type SubscriptionKind = "conversation" | "sessions-index" | "workspace-config";

interface OwnedSubscription {
  kind: SubscriptionKind;
  ownershipKey: string;
  subscriptionId: string;
  topic: string;
  connectionId: string;
  clientMode: ZCodeAgentV4ClientMode;
  target: ZCodeAgentWorkspaceTarget;
}

interface ConnectionFlowRoute {
  key: string;
  target: ZCodeAgentWorkspaceTarget;
  connection: ZCodeAgentV4ConnectionContext;
}

type RoutedTopicFrame =
  | ConversationTopicWireCandidate
  | SessionsIndexTopicWireCandidate
  | WorkspaceConfigTopicWireCandidate;

interface PendingOwnership {
  kind: SubscriptionKind;
  target: ZCodeAgentWorkspaceTarget;
  topic: string;
  frames: RoutedTopicFrame[];
  stagedBytes: number;
  overflowReason: string | null;
  runtimeGeneration: number;
  invalidatedByRuntimeRestart: boolean;
}

interface RoutedFrameEvent {
  emitter: Emitter<RoutedTopicFrame>;
  upstream: IDisposable;
}

// ACK 窗口只覆盖控制面竞态，不替代 subscriber buffer/resync。这里按帧数和
// JSON 字节双限额暂存，避免异常 peer 在 subscribe pending 期间无限占用 host 内存。
const MAX_PENDING_OWNERSHIP_FRAMES = 1_024;
const MAX_PENDING_OWNERSHIP_BYTES = 32 * 1024 * 1024;
const MAX_DOWNSTREAM_CONNECTION_ID_LENGTH = 256;

function assertConnectionId(connectionId: string): void {
  if (
    connectionId.trim().length === 0 ||
    connectionId.length > MAX_DOWNSTREAM_CONNECTION_ID_LENGTH
  ) {
    throw new Error("fault.connection.invalidConnectionId");
  }
}

function namespaceRelayConnectionId(
  upstreamConnectionId: string,
  downstreamConnectionId: string,
): string {
  // 长度前缀消除 `a/b + c` 与 `a + b/c` 这类分隔符碰撞；connectionId 只作
  // opaque route key，不需要业务层解析。
  return `relay:${upstreamConnectionId.length}:${upstreamConnectionId}${downstreamConnectionId.length}:${downstreamConnectionId}`;
}

function frameBytes(frame: RoutedTopicFrame): number {
  return new TextEncoder().encode(JSON.stringify(frame)).byteLength;
}

function deliveryProfileFor(clientMode: ZCodeAgentV4ClientMode): HelloMessage["deliveryProfile"] {
  return clientMode === "desktop-continuous" ? "continuous" : "replayable";
}

function createHello(context: ZCodeAgentV4ConnectionContext): HelloMessage {
  const continuous = context.clientMode === "desktop-continuous";
  return {
    kind: "hello",
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    connectionId: context.connectionId,
    clientMode: context.clientMode,
    deliveryProfile: deliveryProfileFor(context.clientMode),
    serverTime: Date.now(),
    capabilities: {
      nativeDialogs: continuous,
      localTerminal: continuous,
      binaryFrames: false,
      compression: "none",
      workspaceHookReview: true,
      independentPlanState: true,
      genUiContext: true,
      // 本 Host 会转发 `workflowRun.*` 键级增量；客户端见到它才能在 clientHello 里回声明
      // （那个 capabilities 是 .strict() 的，反过来会让老 Host 握不上手）。
      workflowRunDeltas: true,
      pluginDiscovery: true,
      historyFirst: true,
      // 手机远控输入预测：受 Host 开关控制；缺席/false 时手机不得发起 inputPrediction。
      inputPrediction: isRemoteInputPredictionEnabled(),
      // 手机任务列表预加载：rowsRange 支持 residency=resident-only（只读热会话）。
      residentRowsRange: true,
    },
    auth: {},
  };
}

export interface ZCodeAgentConnectionScope {
  readonly service: IZCodeAgentService;
  /** MessagePort/transport sideband only；不是 UI-facing RPC。 */
  setTransportFlowState(state: V4ConnectionFlowState): Promise<void>;
  dispose(): Promise<void>;
}

/** 为单个 host/server RPC attachment 建立可信 V4 facade。 */
export function createZCodeAgentConnectionScope(
  base: IZCodeAgentService,
  context: ZCodeAgentV4ConnectionContext,
): ZCodeAgentConnectionScope {
  assertConnectionId(context.connectionId);
  const role = context.role ?? "terminal-client";
  const owned = new Map<string, OwnedSubscription>();
  const routeKeyByOwnership = new Map<string, string>();
  const pendingByOwnership = new Map<string, Set<PendingOwnership>>();
  const routedFrameEvents = new Map<string, RoutedFrameEvent>();
  const runtimeGenerationByWorkspaceKey = new Map<string, number>();
  let disposed = false;
  // trusted relay 已在外层 transport（stdio / Node-only WS role header）完成身份
  // 选择；终端 UI 仍必须走 hello → clientHello。
  let handshakeComplete = role === "trusted-host-relay";
  let helloIssued = role === "trusted-host-relay";
  let boundClientId: string | null = null;
  /** clientHello 里的增量声明；trusted relay 没有自己的 clientHello，只搬运下游的。 */
  let clientWorkflowRunDeltas = false;
  let pluginDiscoveryUiSupported = false;
  let clientHistoryFirst = false;
  let commandQueryWorkspaceKey: string | null = null;
  let currentTransportFlowState: V4ConnectionFlowState = "drained";
  let flowClosed = false;
  let flowUpdateChain = Promise.resolve();
  const forwardedFlowStateByRoute = new Map<string, V4ConnectionFlowState>();
  /** attachment 曾触及的 workspace route 留到 port dispose，保证无 subscription 也能 trusted closed。 */
  const attachmentFlowRoutes = new Map<string, ConnectionFlowRoute>();

  const forwardedConnection = (params: unknown): ZCodeAgentV4ConnectionContext => {
    const downstream = readTrustedZCodeAgentV4Connection(params);
    if (role === "trusted-host-relay" && downstream) {
      assertConnectionId(downstream.connectionId);
      return {
        connectionId: namespaceRelayConnectionId(context.connectionId, downstream.connectionId),
        clientMode: downstream.clientMode,
        // 增量位属于**下游那一端**：relay 自己不消费帧，只把下游 clientHello 的声明带上去。
        ...(downstream.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
        ...(downstream.pluginDiscoveryUi === true ? { pluginDiscoveryUi: true } : {}),
        ...(downstream.historyFirst === true ? { historyFirst: true } : {}),
      };
    }
    return {
      connectionId: context.connectionId,
      clientMode: context.clientMode,
      ...(clientWorkflowRunDeltas ? { workflowRunDeltas: true } : {}),
      ...(role === "terminal-client" && pluginDiscoveryUiSupported
        ? { pluginDiscoveryUi: true }
        : {}),
      ...(clientHistoryFirst ? { historyFirst: true } : {}),
    };
  };

  const assertOpen = () => {
    if (disposed) throw new Error("fault.connection.closed");
  };
  const assertReady = () => {
    assertOpen();
    if (!handshakeComplete) throw new Error("fault.connection.handshakeRequired");
  };
  const routeKey = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    topic: string,
    subscriptionId: string,
    connectionId: string,
  ) => `${kind}\0${workspaceKey(target)}\0${topic}\0${subscriptionId}\0${connectionId}`;
  const ownershipKey = (kind: SubscriptionKind, target: ZCodeAgentWorkspaceTarget, topic: string) =>
    `${kind}\0${workspaceKey(target)}\0${topic}`;
  const routedEventKey = (kind: SubscriptionKind, target: ZCodeAgentWorkspaceTarget) =>
    `${kind}\0${workspaceKey(target)}`;
  const flowRouteKey = (target: ZCodeAgentWorkspaceTarget, connectionId: string) =>
    `${workspaceKey(target)}\0${connectionId}`;
  const flowRouteForEntry = (entry: OwnedSubscription): ConnectionFlowRoute => ({
    key: flowRouteKey(entry.target, entry.connectionId),
    target: entry.target,
    connection: {
      connectionId: entry.connectionId,
      clientMode: entry.clientMode,
    } satisfies ZCodeAgentV4ConnectionContext,
  });
  const currentFlowRoutes = () => {
    const routes = new Map<string, ConnectionFlowRoute>(attachmentFlowRoutes);
    for (const entry of owned.values()) {
      const route = flowRouteForEntry(entry);
      routes.set(route.key, route);
    }
    return routes;
  };
  const forwardFlowRoute = async (
    route: ConnectionFlowRoute,
    state: V4ConnectionFlowState,
  ): Promise<void> => {
    if (forwardedFlowStateByRoute.get(route.key) === state) return;
    await base.setConnectionFlowStateV4(
      withTrustedConnection(
        {
          ...workspaceTarget(route.target),
          state,
        },
        route.connection,
      ),
    );
    forwardedFlowStateByRoute.set(route.key, state);
  };
  const applyTransportFlowState = async (state: V4ConnectionFlowState): Promise<void> => {
    if (flowClosed && state !== "closed") return;
    currentTransportFlowState = state;
    if (state === "closed") flowClosed = true;
    for (const route of currentFlowRoutes().values()) {
      await forwardFlowRoute(route, state);
    }
  };
  const enqueueTransportFlowState = (state: V4ConnectionFlowState): Promise<void> => {
    if (disposed || (flowClosed && state !== "closed")) return Promise.resolve();
    const update = flowUpdateChain.then(() => applyTransportFlowState(state));
    // 快速 SAT→DRN 与 close 必须保持提交顺序；单次 RPC 失败不能打断后续
    // close 清理，但调用方仍会收到该次 update 的 rejection。
    flowUpdateChain = update.catch(() => {});
    return update;
  };
  const syncCurrentFlowForEntry = async (entry: OwnedSubscription): Promise<void> => {
    if (currentTransportFlowState !== "saturated") return;
    await forwardFlowRoute(flowRouteForEntry(entry), "saturated");
  };
  const closeUnusedFlowRoute = async (entry: OwnedSubscription): Promise<void> => {
    const route = flowRouteForEntry(entry);
    if (currentFlowRoutes().has(route.key)) return;
    if (forwardedFlowStateByRoute.has(route.key)) {
      await forwardFlowRoute(route, "closed");
      forwardedFlowStateByRoute.delete(route.key);
    }
  };
  const remember = (subscriptionId: string, entry: OwnedSubscription): void => {
    const key = routeKey(entry.kind, entry.target, entry.topic, subscriptionId, entry.connectionId);
    const previous = routeKeyByOwnership.get(entry.ownershipKey);
    if (previous) owned.delete(previous);
    routeKeyByOwnership.set(entry.ownershipKey, key);
    owned.set(key, entry);
  };
  const findBySubscription = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    subscriptionId: string,
    expectedRoute: TrustedZCodeAgentV4UnsubscribeRoute | null,
  ): OwnedSubscription | null => {
    const expectedWorkspaceKey = workspaceKey(target);
    const matches = [...owned.values()].filter(
      (entry) =>
        entry.kind === kind &&
        entry.subscriptionId === subscriptionId &&
        workspaceKey(entry.target) === expectedWorkspaceKey &&
        (!expectedRoute ||
          (entry.topic === expectedRoute.topic &&
            entry.connectionId === expectedRoute.connectionId)),
    );
    // terminal UI 只传 subId；若它在同 method/workspace 内碰撞，宁可拒绝猜测。
    // trusted relay 则使用下游 facade 写入的 topic/connection 精确命中。
    return matches.length === 1 ? matches[0]! : null;
  };
  const ownsFrame = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    frame: { subscriptionId: string; topic: string },
  ) => {
    const expectedWorkspaceKey = workspaceKey(target);
    return [...owned.values()].some(
      (entry) =>
        entry.kind === kind &&
        entry.subscriptionId === frame.subscriptionId &&
        entry.topic === frame.topic &&
        workspaceKey(entry.target) === expectedWorkspaceKey,
    );
  };
  const forwardedUnsubscribeRoute = (
    params: unknown,
  ): TrustedZCodeAgentV4UnsubscribeRoute | null => {
    if (role !== "trusted-host-relay") return null;
    const downstream = readTrustedZCodeAgentV4UnsubscribeRoute(params);
    if (!downstream) return null;
    assertConnectionId(downstream.connectionId);
    return {
      topic: downstream.topic,
      connectionId: namespaceRelayConnectionId(context.connectionId, downstream.connectionId),
    };
  };
  const beginPendingOwnership = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    topic: string,
  ): PendingOwnership => {
    const pending: PendingOwnership = {
      kind,
      target: workspaceTarget(target),
      topic,
      frames: [],
      stagedBytes: 0,
      overflowReason: null,
      runtimeGeneration: runtimeGenerationByWorkspaceKey.get(workspaceKey(target)) ?? 0,
      invalidatedByRuntimeRestart: false,
    };
    const key = ownershipKey(kind, target, topic);
    const group = pendingByOwnership.get(key) ?? new Set<PendingOwnership>();
    group.add(pending);
    pendingByOwnership.set(key, group);
    return pending;
  };
  const removePendingOwnership = (pending: PendingOwnership): void => {
    const key = ownershipKey(pending.kind, pending.target, pending.topic);
    const group = pendingByOwnership.get(key);
    group?.delete(pending);
    if (group?.size === 0) pendingByOwnership.delete(key);
  };
  const discardPendingOwnership = (pending: PendingOwnership): void => {
    removePendingOwnership(pending);
    pending.frames.length = 0;
    pending.stagedBytes = 0;
    pending.overflowReason = null;
  };
  const stageFrame = (pending: PendingOwnership, frame: RoutedTopicFrame): void => {
    if (pending.overflowReason || pending.invalidatedByRuntimeRestart) return;
    const bytes = frameBytes(frame);
    if (
      pending.frames.length + 1 > MAX_PENDING_OWNERSHIP_FRAMES ||
      pending.stagedBytes + bytes > MAX_PENDING_OWNERSHIP_BYTES
    ) {
      // 旧 ACK staging 超限时 shift 最旧帧，会把一个
      // logical frame 变成永久缺片。溢出必须清空整批并显式失败。
      pending.frames.length = 0;
      pending.stagedBytes = 0;
      pending.overflowReason = "fault.subscription.initialFrameStagingOverflow";
      return;
    }
    pending.frames.push(frame);
    pending.stagedBytes += bytes;
  };
  const routeIncomingFrame = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    frame: RoutedTopicFrame,
    emitter: Emitter<RoutedTopicFrame>,
  ): void => {
    if (ownsFrame(kind, target, frame)) {
      emitter.fire(frame);
      return;
    }
    const group = pendingByOwnership.get(ownershipKey(kind, target, frame.topic));
    if (!group) return;
    for (const pending of group) stageFrame(pending, frame);
  };
  const routedEvent = <T extends RoutedTopicFrame>(
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    source: Event<T>,
  ): Event<T> => {
    const key = routedEventKey(kind, target);
    let route = routedFrameEvents.get(key);
    if (!route) {
      const emitter = new Emitter<RoutedTopicFrame>();
      route = {
        emitter,
        upstream: source((frame) => routeIncomingFrame(kind, target, frame, emitter)),
      };
      routedFrameEvents.set(key, route);
    }
    return route.emitter.event as Event<T>;
  };
  const forget = (entry: OwnedSubscription): void => {
    const key = routeKey(
      entry.kind,
      entry.target,
      entry.topic,
      entry.subscriptionId,
      entry.connectionId,
    );
    owned.delete(key);
    if (routeKeyByOwnership.get(entry.ownershipKey) === key) {
      routeKeyByOwnership.delete(entry.ownershipKey);
    }
  };
  const unsubscribeBase = (
    entry: OwnedSubscription,
    runtimePolicy?: ZCodeAgentRuntimePolicy,
  ): Promise<void> => {
    const params: ZCodeAgentConversationUnsubscribeParams = {
      ...entry.target,
      subscriptionId: entry.subscriptionId,
      ...(runtimePolicy ? { runtimePolicy } : {}),
    };
    const forwarded = withTrustedUnsubscribeRoute(params, {
      topic: entry.topic,
      connectionId: entry.connectionId,
    });
    switch (entry.kind) {
      case "conversation":
        return base.unsubscribeConversationV4(forwarded);
      case "sessions-index":
        return base.unsubscribeSessionsIndexV4(forwarded);
      case "workspace-config":
        return base.unsubscribeWorkspaceConfigV4(forwarded);
    }
  };
  const unsubscribeOwnedEntry = async (
    entry: OwnedSubscription,
    runtimePolicy?: ZCodeAgentRuntimePolicy,
  ): Promise<void> => {
    forget(entry);
    try {
      // trusted relay 以 owned route 校验 flow control。最后一个 subscription
      // 必须先 closed 再 unsubscribe；反序会让上游先忘 owner，closed 被拒绝后留下 paused connection。
      await closeUnusedFlowRoute(entry);
    } finally {
      await unsubscribeBase(entry, runtimePolicy);
    }
  };
  const resyncBase = (entry: OwnedSubscription, params: ZCodeAgentConversationResyncParams) => {
    const forwarded = withTrustedUnsubscribeRoute(params, {
      topic: entry.topic,
      connectionId: entry.connectionId,
    });
    switch (entry.kind) {
      case "conversation":
        return base.resyncConversationV4(forwarded);
      case "sessions-index":
        return base.resyncSessionsIndexV4(forwarded);
      case "workspace-config":
        return base.resyncWorkspaceConfigV4(forwarded);
    }
  };
  const resyncOwned = (kind: SubscriptionKind, params: ZCodeAgentConversationResyncParams) => {
    assertReady();
    const entry = findBySubscription(
      kind,
      params,
      params.subscriptionId,
      forwardedUnsubscribeRoute(params),
    );
    if (!entry) return Promise.reject(new Error("fault.subscription.notOwned"));
    return resyncBase(entry, params);
  };
  const rememberAfterSubscribe = async (
    subscriptionId: string,
    entry: Omit<OwnedSubscription, "subscriptionId">,
    pending: PendingOwnership,
  ): Promise<void> => {
    removePendingOwnership(pending);
    const complete = { ...entry, subscriptionId };
    if (
      pending.invalidatedByRuntimeRestart ||
      pending.runtimeGeneration !==
        (runtimeGenerationByWorkspaceKey.get(workspaceKey(entry.target)) ?? 0)
    ) {
      // 旧 runtime 的迟到 ACK 可能与新 runtime 复用同一 subId。
      // 这里只丢本地 owner，绝不能向新 runtime 反向 unsubscribe 同名 subscription。
      discardPendingOwnership(pending);
      throw new Error("fault.subscription.runtimeRestarted");
    }
    if (disposed) {
      // port close 与 subscribe ACK 可并发；迟到 ACK 不能在已关闭 facade
      // 重新登记 owner，必须立即反向 unsubscribe。
      discardPendingOwnership(pending);
      await unsubscribeBase(complete).catch(() => {});
      throw new Error("fault.connection.closed");
    }
    if (pending.overflowReason) {
      const reason = pending.overflowReason;
      discardPendingOwnership(pending);
      await unsubscribeBase(complete).catch(() => {});
      throw new Error(reason);
    }
    remember(subscriptionId, complete);
    try {
      // 当前 transport 已 saturated 时，订阅 ACK 才让 trusted downstream route 成为事实；
      // 必须在此补发一次 SAT，不能等待下一个 high-water edge。
      await syncCurrentFlowForEntry(complete);
    } catch (error) {
      forget(complete);
      await unsubscribeBase(complete).catch(() => {});
      throw error;
    }
    const route = routedFrameEvents.get(routedEventKey(entry.kind, entry.target));
    if (!route) return;
    // CLI notification 可能先于 RPC subscribe response 抵达 host。旧实现
    // 直到 await 返回才登记 owner，早帧会被永久丢弃；同 topic 双端 pending 时也不能
    // 猜 owner。ACK 后只释放 ACK subscriptionId 对应帧，保留原到达顺序。
    for (const frame of pending.frames) {
      if (frame.subscriptionId === subscriptionId && ownsFrame(entry.kind, entry.target, frame)) {
        route.emitter.fire(frame);
      }
    }
    pending.frames.length = 0;
    pending.stagedBytes = 0;
  };

  const invalidateWorkspaceRuntime = (invalidatedWorkspaceKey: string, generation: number) => {
    runtimeGenerationByWorkspaceKey.set(invalidatedWorkspaceKey, generation);
    // runtime 内 subscription 已全部消失；本地 owner 直接 forget，不向新 runtime 清理。
    for (const entry of owned.values()) {
      if (workspaceKey(entry.target) === invalidatedWorkspaceKey) forget(entry);
    }
    for (const key of forwardedFlowStateByRoute.keys()) {
      if (key.startsWith(`${invalidatedWorkspaceKey}\0`)) {
        forwardedFlowStateByRoute.delete(key);
      }
    }
    const invalidatedPending = [...pendingByOwnership.values()]
      .flatMap((group) => [...group])
      .filter((pending) => workspaceKey(pending.target) === invalidatedWorkspaceKey);
    for (const pending of invalidatedPending) {
      pending.invalidatedByRuntimeRestart = true;
      // 从 routing group 摘除，避免旧 ACK 永不到达时继续为新 runtime 每帧积压；
      // pending 对象仍由原 Promise continuation 持有，可据 generation 拒绝迟到 ACK。
      removePendingOwnership(pending);
      pending.frames.length = 0;
      pending.stagedBytes = 0;
    }
  };

  const hasRuntimeLifecycle = Boolean(base.onAgentRuntimeLifecycle);
  const runtimeLifecycleDisposable = base.onAgentRuntimeLifecycle?.((event) => {
    if (event.state === "available") {
      // 首次冷启动的 subscribe 会先登记 pending，再由同一次启动发布
      // available(gen1)，最后才收到 ACK。available 不是旧 ownership 的失效边界；
      // 若在这里推进 generation，会把当前 runtime 的合法 ACK 误判成 restart。
      // 真正的换代一定先发布 unavailable，由下方分支清理旧 owner/pending。
      return;
    }
    // attachment facade 若只监听 restart，runtime 退出但未重启时就会保留旧 owner，
    // 后续 UI cleanup 会重建 unsubscribe 参数并误走启动型 client；因此 unavailable 直接失效本地 owner。
    invalidateWorkspaceRuntime(event.workspaceKey, event.runtimeIdentity.generation);
  });
  const runtimeRestartDisposable = hasRuntimeLifecycle
    ? undefined
    : base.onAgentRuntimeRestarted?.(({ workspaceKey: restarted }) => {
        const nextGeneration = (runtimeGenerationByWorkspaceKey.get(restarted) ?? 0) + 1;
        invalidateWorkspaceRuntime(restarted, nextGeneration);
      });

  const overrides: Partial<IZCodeAgentService> = {
    onDynamicSessionLifecycle(params) {
      return (listener) =>
        base.onDynamicSessionLifecycle(params)((snapshot) => {
          if (snapshot.state === "stopping") {
            const topic = conversationTopic(snapshot.sessionId);
            const key = workspaceKey(params);
            // 只清当前 session 的 owner；不能使其他任务或 sessions-index 的订阅失效。
            for (const entry of owned.values()) {
              if (workspaceKey(entry.target) === key && entry.topic === topic) forget(entry);
            }
            for (const group of [...pendingByOwnership.values()]) {
              for (const pending of [...group]) {
                if (workspaceKey(pending.target) !== key || pending.topic !== topic) continue;
                pending.invalidatedByRuntimeRestart = true;
                removePendingOwnership(pending);
                pending.frames.length = 0;
                pending.stagedBytes = 0;
              }
            }
          }
          listener(snapshot);
        });
    },
    async helloConversationV4() {
      assertOpen();
      helloIssued = true;
      return createHello(context);
    },
    async initializeConversationV4(clientHello) {
      assertOpen();
      if (!helloIssued) throw new Error("fault.connection.helloRequired");
      const parsed = clientHelloSchema.parse(clientHello);
      if (boundClientId !== null && boundClientId !== parsed.clientId) {
        throw new Error("fault.connection.clientChanged");
      }
      boundClientId = parsed.clientId;
      clientWorkflowRunDeltas = clientSupportsWorkflowRunDeltas(parsed);
      pluginDiscoveryUiSupported = parsed.capabilities?.pluginDiscoveryUi === true;
      clientHistoryFirst = parsed.capabilities?.historyFirst === true;
      handshakeComplete = true;
    },
    async setConnectionFlowStateV4(params) {
      assertOpen();
      if (role !== "trusted-host-relay") {
        throw new Error("fault.connection.flowControlForbidden");
      }
      const downstream = readTrustedZCodeAgentV4Connection(params);
      if (!downstream) throw new Error("fault.connection.flowControlUntrusted");
      const forwarded = forwardedConnection(params);
      const ownsRoute =
        attachmentFlowRoutes.has(flowRouteKey(params, forwarded.connectionId)) ||
        [...owned.values()].some(
          (entry) =>
            workspaceKey(entry.target) === workspaceKey(params) &&
            entry.connectionId === forwarded.connectionId,
        );
      if (!ownsRoute) throw new Error("fault.subscription.notOwned");
      await base.setConnectionFlowStateV4(withTrustedConnection(params, forwarded));
    },
    async sendConversationCommandV4(params) {
      assertOpen();
      // extension 来源只由扩展网关经 app-control 注入（docs/plugins/extension-host.md §17.8）；app-control 直接调
      // 基础 agent 服务，不经任何连接作用域。渲染进程、手机与 relay 的命令都从这里进入，带这个来源就是伪造。
      if (carriesExtensionInputSource(params.envelope)) {
        throw new Error("fault.command.extensionSourceUntrusted");
      }
      if (role === "terminal-client") {
        assertReady();
        if (params.envelope.clientId !== boundClientId) {
          // 旧 facade 未覆盖 command 入口，未握手调用与伪造 clientId 都会
          // 直达 CLI；静默覆盖又会破坏 command 幂等归属，因此明确拒绝不一致。
          throw new Error("fault.command.clientMismatch");
        }
      }
      // command 过去只校验 envelope.clientId，却没有像订阅、附件一样注入
      // host 真值，导致 mobile 可伪造顶层 clientMode，且 relay 下游身份在 command 链路丢失。
      // envelope 仍原样透传；可信连接上下文只通过 host 内部 carrier 传给 base service。
      return base.sendConversationCommandV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async queryConversationCommandsV4(params) {
      assertReady();
      // 纯时钟探测不查询任何 command，不能抢占/改变业务查询的 workspace 绑定。
      if (params.clock)
        return base.queryConversationCommandsV4(
          withTrustedConnection(params, forwardedConnection(params)),
        );
      const requestedWorkspaceKey = workspaceKey(params);
      if (commandQueryWorkspaceKey !== null && commandQueryWorkspaceKey !== requestedWorkspaceKey) {
        throw new Error("fault.command.queryForeignWorkspace");
      }
      commandQueryWorkspaceKey = requestedWorkspaceKey;
      return base.queryConversationCommandsV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async backgroundBashOutputV4(params) {
      assertReady();
      return base.backgroundBashOutputV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async conversationRowsRangeV4(params) {
      assertReady();
      return base.conversationRowsRangeV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async attachmentBeginV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const result = await base.attachmentBeginV4(withTrustedConnection(params, forwarded));
      if (result.state === "staging") {
        if (disposed || flowClosed) {
          // begin ACK 可能晚于 port close。若此时再登记 route，closed 已经错过它，
          // CLI 会留下只能等 TTL 的半上传；先用同 trusted identity abort，再拒绝迟到结果。
          await base.attachmentAbortV4(withTrustedConnection(params, forwarded)).catch(() => {});
          throw new Error("fault.connection.closed");
        }
        const route: ConnectionFlowRoute = {
          key: flowRouteKey(params, forwarded.connectionId),
          target: workspaceTarget(params),
          connection: forwarded,
        };
        attachmentFlowRoutes.set(route.key, route);
        if (currentTransportFlowState === "saturated") {
          try {
            await forwardFlowRoute(route, "saturated");
          } catch (error) {
            attachmentFlowRoutes.delete(route.key);
            await base.attachmentAbortV4(withTrustedConnection(params, forwarded)).catch(() => {});
            throw error;
          }
        }
      }
      return result;
    },
    async attachmentReadV4(params) {
      assertReady();
      return base.attachmentReadV4(withTrustedConnection(params, forwardedConnection(params)));
    },
    async conversationAttachmentReadV4(params) {
      assertReady();
      return base.conversationAttachmentReadV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async conversationAttachmentStatV4(params) {
      assertReady();
      return base.conversationAttachmentStatV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async attachmentPreviewSourceV4(params) {
      assertReady();
      return base.attachmentPreviewSourceV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async attachmentChunkV4(params) {
      assertReady();
      return base.attachmentChunkV4(withTrustedConnection(params, forwardedConnection(params)));
    },
    async attachmentCommitV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      return base.attachmentCommitV4(withTrustedConnection(params, forwarded));
    },
    async attachmentAbortV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      await base.attachmentAbortV4(withTrustedConnection(params, forwarded));
    },
    async subscribeConversationV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const topic = conversationTopic(params.sessionId);
      const pending = beginPendingOwnership("conversation", params, topic);
      try {
        const result = await base.subscribeConversationV4(withTrustedConnection(params, forwarded));
        await rememberAfterSubscribe(
          result.ack.subscriptionId,
          {
            kind: "conversation",
            ownershipKey: `conversation\0${workspaceKey(params)}\0${topic}\0${forwarded.connectionId}`,
            topic,
            connectionId: forwarded.connectionId,
            clientMode: forwarded.clientMode,
            target: workspaceTarget(params),
          },
          pending,
        );
        return result;
      } catch (error) {
        discardPendingOwnership(pending);
        throw error;
      }
    },
    async unsubscribeConversationV4(params) {
      const entry = findBySubscription(
        "conversation",
        params,
        params.subscriptionId,
        forwardedUnsubscribeRoute(params),
      );
      if (!entry) return;
      await unsubscribeOwnedEntry(entry, params.runtimePolicy);
    },
    async resyncConversationV4(params) {
      return resyncOwned("conversation", params);
    },
    onDynamicConversationFrame(params) {
      return routedEvent<ConversationTopicWireCandidate>(
        "conversation",
        params,
        base.onDynamicConversationFrame(params),
      );
    },
    onDynamicLocalTtftFacts(params) {
      assertOpen();
      if (
        role !== "terminal-client" ||
        context.clientMode !== "desktop-continuous" ||
        params.workspaceIdentity?.trim() ||
        params.remoteSessionId
      )
        return RpcEvent.None;
      return base.onDynamicLocalTtftFacts(workspaceTarget(params));
    },
    onDynamicConversationTelemetryFact(params) {
      assertOpen();
      // 可信 clientMode 来自 host attachment；Web/mobile/relay 即使能读权威对话态，
      // 也不能借共享 workspace emitter 安装生产 telemetry reporter。
      const downstream = readTrustedZCodeAgentV4Connection(params);
      const relayDesktopDownstream =
        role === "trusted-host-relay" && downstream?.clientMode === "desktop-continuous";
      if (
        context.clientMode !== "desktop-continuous" ||
        (role !== "terminal-client" && !relayDesktopDownstream)
      ) {
        return RpcEvent.None;
      }
      // renderer 的 workspace supervisor 会先于 V4 hello/initialize 挂载。
      // telemetry emitter 本身不发起协议请求，允许可信 desktop 提前监听，避免动态
      // Event 在 handshake 前抛错并让 host channel 退出；live fact 仍只会在 ingest 后产生。
      // 远程 workspace 还会经过 trusted host relay；这里沿用已有 trusted carrier 传递
      // 下游 clientMode/namespace connectionId，relay 自身没有可信下游时仍保持拒绝。
      return base.onDynamicConversationTelemetryFact(
        withTrustedConnection(workspaceTarget(params), forwardedConnection(params)),
      );
    },
    onDynamicPluginUiToolResult() {
      assertOpen();
      // 页面创建只属于本地桌面；手机回放和 relay 不拥有原生 guest。
      if (role !== "terminal-client" || context.clientMode !== "desktop-continuous")
        return RpcEvent.None;
      return base.onDynamicPluginUiToolResult();
    },
    onDynamicCuaPermissionObservation() {
      assertOpen();
      // 权限弹窗是本地桌面副作用；手机 replay attachment 只能消费可恢复对话事实。
      if (role !== "terminal-client" || context.clientMode !== "desktop-continuous") {
        return RpcEvent.None;
      }
      return base.onDynamicCuaPermissionObservation();
    },
    onDynamicProcessResourceSample() {
      assertOpen();
      // CLI 资源样本只供远端 Desktop Host relay 回传 main；renderer/mobile attachment
      // 不消费该事件，也不能把它引入 continuous/replayable 消息面。
      if (role !== "trusted-host-relay") {
        return RpcEvent.None;
      }
      return base.onDynamicProcessResourceSample();
    },
    onDynamicToolExecResource() {
      // 完成事实与会话交付无关，禁止进入 continuous/replayable attachment。
      if (disposed || role !== "trusted-host-relay") return RpcEvent.None;
      return base.onDynamicToolExecResource();
    },
    onDynamicMcpResourceSamples() {
      // 资源事实不属于会话流，桌面 continuous 与手机 replayable attachment 均不能订阅。
      if (disposed || role !== "trusted-host-relay") return RpcEvent.None;
      return base.onDynamicMcpResourceSamples();
    },
    onDynamicRemoteConversationTelemetry() {
      if (disposed || role !== "trusted-host-relay") return RpcEvent.None;
      return base.onDynamicRemoteConversationTelemetry();
    },
    onDynamicMcpTelemetry() {
      assertOpen();
      // MCP 遥测与 CLI 资源样本共用可信 Host relay 边界，不进入 renderer/mobile 会话链路。
      if (role !== "trusted-host-relay") {
        return RpcEvent.None;
      }
      return base.onDynamicMcpTelemetry();
    },
    async subscribeSessionsIndexV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const topic = sessionsIndexTopic(workspaceKey(params));
      const pending = beginPendingOwnership("sessions-index", params, topic);
      try {
        const result = await base.subscribeSessionsIndexV4(
          withTrustedConnection(params, forwarded),
        );
        await rememberAfterSubscribe(
          result.ack.subscriptionId,
          {
            kind: "sessions-index",
            ownershipKey: `sessions-index\0${topic}\0${forwarded.connectionId}`,
            topic,
            connectionId: forwarded.connectionId,
            clientMode: forwarded.clientMode,
            target: workspaceTarget(params),
          },
          pending,
        );
        return result;
      } catch (error) {
        discardPendingOwnership(pending);
        throw error;
      }
    },
    async unsubscribeSessionsIndexV4(params) {
      const entry = findBySubscription(
        "sessions-index",
        params,
        params.subscriptionId,
        forwardedUnsubscribeRoute(params),
      );
      if (!entry) return;
      await unsubscribeOwnedEntry(entry, params.runtimePolicy);
    },
    async resyncSessionsIndexV4(params) {
      return resyncOwned("sessions-index", params);
    },
    onDynamicSessionsIndexFrame(params) {
      return routedEvent<SessionsIndexTopicWireCandidate>(
        "sessions-index",
        params,
        base.onDynamicSessionsIndexFrame(params),
      );
    },
    async subscribeWorkspaceConfigV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const topic = workspaceConfigTopic(workspaceKey(params));
      const pending = beginPendingOwnership("workspace-config", params, topic);
      try {
        const result = await base.subscribeWorkspaceConfigV4(
          withTrustedConnection(params, forwarded),
        );
        await rememberAfterSubscribe(
          result.ack.subscriptionId,
          {
            kind: "workspace-config",
            ownershipKey: `workspace-config\0${topic}\0${forwarded.connectionId}`,
            topic,
            connectionId: forwarded.connectionId,
            clientMode: forwarded.clientMode,
            target: workspaceTarget(params),
          },
          pending,
        );
        return result;
      } catch (error) {
        discardPendingOwnership(pending);
        throw error;
      }
    },
    async unsubscribeWorkspaceConfigV4(params) {
      const entry = findBySubscription(
        "workspace-config",
        params,
        params.subscriptionId,
        forwardedUnsubscribeRoute(params),
      );
      if (!entry) return;
      await unsubscribeOwnedEntry(entry, params.runtimePolicy);
    },
    async resyncWorkspaceConfigV4(params) {
      return resyncOwned("workspace-config", params);
    },
    onDynamicWorkspaceConfigFrame(params) {
      return routedEvent<WorkspaceConfigTopicWireCandidate>(
        "workspace-config",
        params,
        base.onDynamicWorkspaceConfigFrame(params),
      );
    },
  };

  const service = new Proxy(base, {
    get(target, property, receiver) {
      const override = Reflect.get(overrides, property, receiver);
      if (override !== undefined) return override;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    service,
    setTransportFlowState(state) {
      return enqueueTransportFlowState(state);
    },
    async dispose() {
      if (disposed) return;
      // close 必须排在已入队 SAT/DRN 之后；即使控制 RPC 失败也继续 owned cleanup。
      await enqueueTransportFlowState("closed").catch(() => {});
      if (disposed) return;
      disposed = true;
      handshakeComplete = false;
      helloIssued = false;
      boundClientId = null;
      clientWorkflowRunDeltas = false;
      const entries = Array.from(owned.values());
      owned.clear();
      routeKeyByOwnership.clear();
      for (const group of pendingByOwnership.values()) {
        for (const pending of group) {
          pending.frames.length = 0;
          pending.stagedBytes = 0;
          pending.overflowReason = null;
        }
      }
      pendingByOwnership.clear();
      for (const route of routedFrameEvents.values()) {
        route.upstream.dispose();
        route.emitter.dispose();
      }
      routedFrameEvents.clear();
      runtimeLifecycleDisposable?.dispose();
      runtimeRestartDisposable?.dispose();
      runtimeGenerationByWorkspaceKey.clear();
      attachmentFlowRoutes.clear();
      forwardedFlowStateByRoute.clear();
      await Promise.allSettled(entries.map((entry) => unsubscribeBase(entry)));
    },
  };
}

// Share RPC 复用同一内部 carrier 写入规则，不能复制一套连接身份拼装。
export { withTrustedConnection as withTrustedZCodeAgentV4Connection };
