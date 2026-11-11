import type { IDisposable } from "@zcode/rpc";
import type { AppSessionRef } from "@zcode/session-control/contracts";
import {
  EXTENSION_API_VERSION,
  ExtensionError,
  MAX_SESSION_MIRRORS,
  MAX_SESSION_SUBSCRIPTIONS_PER_PLUGIN,
  SESSION_EVENT_MAX_BYTES,
  SESSION_MIRROR_MAX_BYTES,
  isExtensionAnswerableInteraction,
  isExtensionError,
  type SessionConversationEvent,
  type SessionInteractionsEvent,
  type SessionListEvent,
  type SessionReadRowsInput,
  type SessionReadRowsResult,
  type SessionRowsEvent,
  type SessionTargetInput,
} from "@zcode/shared/extension-host";
import {
  TopicWireFrameAssembler,
  V4_WIRE_PROTOCOL_VERSION,
  applyConversationDeltas,
  conversationTopic,
  conversationTopicFrameSchema,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type ConversationTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "#src/zcode-agent/zcodeAgent.js";
import {
  createZCodeAgentConnectionScope,
  type ZCodeAgentConnectionScope,
} from "#src/zcode-agent/zcodeAgentConnectionScope.js";
import type {
  CapabilityCallContext,
  CapabilitySubscription,
} from "#src/extensions/capabilityTypes.js";
import {
  createSessionListPump,
  type ExtensionTaskRowsSource,
} from "#src/extensions/sessionListPump.js";
import type { SessionsBackend } from "#src/extensions/sessionsBackend.js";

// 会话读连接（docs/plugins/extension-host.md §17.5，P3b）：插件是与手机同级的客户端，读走自己的连接。
//
//   ctx.sessions.onDidChangeRows({ sessionId }) ──► 网关（已查声明、协议、授权）
//       ├─ 上限：该插件的不同会话 ≤ 8，全局镜像 ≤ 32（limit-exceeded）
//       ├─ 解析：facade readSession(view: summary) → 会话引用（与模型工具同一份授权）
//       └─ 镜像（按会话共享）：scope（extension-host:<gen>，replayable）订阅 conversation topic，
//          snapshot → reset；deltas → apply 后的整行；断档 → forceSnapshot 重同步 → reset
//
// 连接作用域属于一代扩展进程：detach 时 scope.dispose() 全部退订，插件重连后重订，第一个事件是 reset。
// 列表泵在 sessionListPump.ts，与连接无关（读的是 Window Host 控制器投影）。

export interface SessionReadsDeps {
  /** 连接作用域的底座：Window Host 的 IZCodeAgentService（只在本进程内）。 */
  agent: IZCodeAgentService | undefined;
  /** 解析会话目标走 facade（客户端类调用方，与 readSession 同一份授权与代际检查）。 */
  sessions: SessionsBackend;
  /** Window Host 控制器的任务投影；缺省时列表订阅报 unavailable。 */
  taskRows: ExtensionTaskRowsSource | undefined;
  /** 本机来源 id（会话引用的 sourceServerId）；没有会话 facade 时为 undefined。 */
  localSourceServerId(): string | undefined;
  /** 当前连接的扩展进程代际；没有连接时为 null。 */
  currentGen(): number | null;
  /**
   * 回答审批与切换权限模式的范围检查（§17.12）：会话不在调用方插件的项目里时抛 forbidden。
   * 只用于 interactions 一类的登记；缺省时这类登记一律 forbidden。
   */
  controlScope?(pluginId: string, session: AppSessionRef): Promise<void>;
  logger: Pick<ServiceLogger, "debug" | "info" | "warn">;
}

/** 一次性读取的结果：会话目标与当前交互（§17.12，回答与切换前的检查用）。 */
export interface SessionInteractionsRead {
  target: ZCodeAgentWorkspaceTarget & { sessionId: string };
  event: SessionInteractionsEvent;
}

export interface SessionReads {
  readRows(
    call: CapabilityCallContext,
    input: SessionReadRowsInput,
  ): Promise<SessionReadRowsResult>;
  onDidChangeList(call: CapabilityCallContext): CapabilitySubscription<SessionListEvent>;
  onDidChangeConversation(
    call: CapabilityCallContext,
    input: SessionTargetInput,
  ): CapabilitySubscription<SessionConversationEvent>;
  onDidChangeRows(
    call: CapabilityCallContext,
    input: SessionTargetInput,
  ): CapabilitySubscription<SessionRowsEvent>;
  /** 插件项目里的会话：待处理的审批与提问、当前权限模式（§17.12）。 */
  onDidChangeInteractions(
    call: CapabilityCallContext,
    input: SessionTargetInput,
  ): CapabilitySubscription<SessionInteractionsEvent>;
  /**
   * 读一次当前交互（同样经范围检查）：会话已有镜像时直接取，没有时临时挂一个、拿到快照就释放
   * （计入每插件的会话上限）。换代或断开时以 cancelled 结束。
   */
  readInteractions(
    call: CapabilityCallContext,
    sessionId: string,
  ): Promise<SessionInteractionsRead>;
  /** 换代或断开：释放连接作用域与全部镜像。 */
  detach(): void;
  dispose(): void;
}

type Target = ZCodeAgentWorkspaceTarget & { sessionId: string };

interface Registration {
  pluginId: string;
  sessionId: string;
  kind: "rows" | "conversation" | "interactions";
  /** 一次性读取的登记：换代或断开时要以 cancelled 结束（订阅由 RPC 服务端一起释放，不需要）。 */
  oneShot?: boolean;
  listener: (event: never) => void;
  fail: (error: ExtensionError) => void;
  mirror: Mirror | null;
  disposed: boolean;
}

interface Mirror {
  key: string;
  target: Target;
  topic: string;
  assembler: TopicWireFrameAssembler<ConversationTopicFrame>;
  registrations: Set<Registration>;
  /** 每次（重新）订阅加一：迟到的 ACK 与失败按它判断是否过期。 */
  attempt: number;
  phase: "subscribing" | "live" | "resyncing" | "detached" | "closed";
  subscriptionId: string | null;
  snapshot: ConversationSnapshot | null;
  rowBytes: Map<number, number>;
  totalBytes: number;
  /** 最近一次推给会话状态订阅者的 logEpoch/revision/phase。 */
  stateKey: string | null;
  /** 最近一次推给交互订阅者的权限模式与交互（不含修订号：流式期间修订号一直变，内容没变不推）。 */
  interactionsKey: string | null;
  lifecycleRevision: number;
}

interface Connection {
  gen: number;
  scope: ZCodeAgentConnectionScope;
  ready: Promise<void>;
  /** 每个工作区一条帧流与一条会话生命周期流，按 topic 分给镜像。 */
  workspaces: Map<string, IDisposable[]>;
  runtime: IDisposable[];
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const workspaceKeyOf = (target: ZCodeAgentWorkspaceTarget) =>
  target.workspaceIdentity?.trim() || target.workspacePath;
const describe = (error: unknown) =>
  isExtensionError(error)
    ? error.code
    : (((error as { code?: unknown } | null)?.code as string | undefined) ??
      (error instanceof Error ? error.name : typeof error));

export function createSessionReads(deps: SessionReadsDeps): SessionReads {
  const { logger } = deps;
  const list = createSessionListPump({
    taskRows: deps.taskRows,
    localSourceServerId: deps.localSourceServerId,
    logger,
  });
  let connection: Connection | null = null;
  const mirrors = new Map<string, Mirror>();
  const registrations = new Set<Registration>();

  // —— 连接作用域：每个代际一份，第一次读正文时创建 ——

  const connect = (gen: number): Connection => {
    if (connection?.gen === gen) return connection;
    if (deps.currentGen() !== gen)
      throw new ExtensionError("cancelled", "the extension host generation changed");
    if (!deps.agent) throw new ExtensionError("unavailable", "session reads are unavailable");
    releaseConnection("replaced");
    const agent = deps.agent;
    const connectionId = `extension-host:${gen}`;
    const scope = createZCodeAgentConnectionScope(agent, {
      connectionId,
      clientMode: "web-remote-replayable",
    });
    const ready = (async () => {
      await scope.service.helloConversationV4();
      await scope.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        clientId: "extension-host",
        appVersion: `extension-host/${EXTENSION_API_VERSION}`,
      });
    })();
    void ready.catch(() => undefined);
    const next: Connection = { gen, scope, ready, workspaces: new Map(), runtime: [] };
    // 运行时重启后旧订阅全部失效（scope 已忘掉 owner）：该工作区的镜像重新订阅，第一个事件是 reset。
    next.runtime.push(
      scope.service.onAgentRuntimeRestarted(({ workspaceKey }) => {
        for (const mirror of mirrors.values()) {
          if (workspaceKeyOf(mirror.target) === workspaceKey)
            subscribe(mirror, "runtime restarted");
        }
      }),
    );
    connection = next;
    logger.info(undefined, `session read connection open connectionId=${connectionId}`);
    return next;
  };

  const releaseConnection = (reason: string) => {
    const current = connection;
    if (!current) return;
    connection = null;
    for (const mirror of mirrors.values()) closeMirror(mirror, false);
    for (const disposables of current.workspaces.values()) {
      for (const disposable of disposables) disposable.dispose();
    }
    for (const disposable of current.runtime) disposable.dispose();
    // scope.dispose() 向 CLI 退订本连接的全部订阅（与手机断开相同）。
    void current.scope.dispose().catch((error: unknown) => {
      logger.warn(undefined, `session read connection dispose failed (${describe(error)})`);
    });
    logger.info(
      undefined,
      `session read connection closed connectionId=extension-host:${current.gen} (${reason})`,
    );
  };

  /** 每个工作区只挂一次帧流与生命周期流；按 topic 交给镜像。 */
  const watchWorkspace = (current: Connection, target: ZCodeAgentWorkspaceTarget) => {
    const key = workspaceKeyOf(target);
    if (current.workspaces.has(key)) return;
    const workspace: ZCodeAgentWorkspaceTarget = {
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    };
    current.workspaces.set(key, [
      current.scope.service.onDynamicConversationFrame(workspace)((wire) => {
        for (const mirror of mirrors.values()) {
          if (mirror.topic === wire.topic && workspaceKeyOf(mirror.target) === key)
            acceptWire(mirror, wire);
        }
      }),
      current.scope.service.onDynamicSessionLifecycle(workspace)((snapshot) => {
        const mirror = mirrors.get(`${key}\0${snapshot.sessionId}`);
        if (!mirror || snapshot.revision < mirror.lifecycleRevision) return;
        mirror.lifecycleRevision = snapshot.revision;
        if (snapshot.state === "stopping" || snapshot.state === "faulted") {
          // 会话在停：scope 已忘掉这条订阅。镜像保留快照，等会话再启动时重新订阅。
          mirror.attempt += 1;
          mirror.phase = "detached";
          mirror.subscriptionId = null;
          mirror.assembler.clear();
          logger.info(undefined, `session mirror detached session=${mirror.target.sessionId}`);
          return;
        }
        if (
          mirror.phase === "detached" &&
          (snapshot.state === "starting" || snapshot.state === "ready")
        ) {
          subscribe(mirror, `session ${snapshot.state}`);
        }
      }),
    ]);
  };

  // —— 镜像 ——

  const deliver = (
    mirror: Mirror,
    kind: Registration["kind"],
    event: unknown,
    only?: Registration,
  ) => {
    for (const registration of only ? [only] : mirror.registrations) {
      if (registration.kind !== kind || registration.disposed) continue;
      (registration.listener as (event: unknown) => void)(event);
    }
  };

  /** 行事件超过单个事件上限时改推 stale，插件用 readRows 补读。 */
  const deliverRows = (mirror: Mirror, event: SessionRowsEvent, only?: Registration) => {
    const sized =
      jsonBytes(event) > SESSION_EVENT_MAX_BYTES
        ? { kind: "stale" as const, logEpoch: event.logEpoch, revision: event.revision }
        : event;
    deliver(mirror, "rows", sized, only);
    logger.debug(
      undefined,
      `session rows ${sized.kind} session=${mirror.target.sessionId} rows=${sized.kind === "reset" ? sized.rows.length : sized.kind === "rows" ? sized.upserted.length : 0}`,
    );
  };

  const resetEvent = (snapshot: ConversationSnapshot): SessionRowsEvent => ({
    kind: "reset",
    logEpoch: snapshot.logEpoch,
    revision: snapshot.revision,
    rows: snapshot.rows.window,
  });

  const stateOf = (mirror: Mirror, snapshot: ConversationSnapshot): SessionConversationEvent => ({
    sessionId: mirror.target.sessionId,
    logEpoch: snapshot.logEpoch,
    revision: snapshot.revision,
    phase: snapshot.control.phase,
  });

  /** 交互投影：只留工具审批与提问（§17.12）；Hook 信任审查与插件安装确认不给插件看。 */
  const interactionsOf = (
    mirror: Mirror,
    snapshot: ConversationSnapshot,
  ): SessionInteractionsEvent => ({
    sessionId: mirror.target.sessionId,
    logEpoch: snapshot.logEpoch,
    revision: snapshot.revision,
    mode: snapshot.config.mode,
    interactions: snapshot.pendingInteractions.filter((interaction) =>
      isExtensionAnswerableInteraction(interaction.kind),
    ),
  });

  const publishState = (mirror: Mirror, snapshot: ConversationSnapshot) => {
    const state = stateOf(mirror, snapshot);
    const key = `${state.logEpoch}\0${state.revision}\0${state.phase}`;
    if (key !== mirror.stateKey) {
      mirror.stateKey = key;
      deliver(mirror, "conversation", state);
    }
    const interactions = interactionsOf(mirror, snapshot);
    const interactionsKey = JSON.stringify([interactions.mode, interactions.interactions]);
    if (interactionsKey === mirror.interactionsKey) return;
    mirror.interactionsKey = interactionsKey;
    deliver(mirror, "interactions", interactions);
  };

  /** 按窗口里各行的 JSON 字节控制镜像大小：超过预算时从最旧的行丢起（仍可经 readRows 读到）。 */
  const fitBudget = (mirror: Mirror, snapshot: ConversationSnapshot, changed?: Set<number>) => {
    if (!changed) {
      mirror.rowBytes.clear();
      mirror.totalBytes = 0;
    }
    for (const row of snapshot.rows.window) {
      if (changed && !changed.has(row.rowId)) continue;
      const bytes = jsonBytes(row);
      mirror.totalBytes += bytes - (mirror.rowBytes.get(row.rowId) ?? 0);
      mirror.rowBytes.set(row.rowId, bytes);
    }
    let drop = 0;
    const window = snapshot.rows.window;
    while (mirror.totalBytes > SESSION_MIRROR_MAX_BYTES && drop < window.length - 1) {
      const row = window[drop]!;
      mirror.totalBytes -= mirror.rowBytes.get(row.rowId) ?? 0;
      mirror.rowBytes.delete(row.rowId);
      drop += 1;
    }
    if (drop === 0) return snapshot;
    logger.debug(
      undefined,
      `session mirror trimmed session=${mirror.target.sessionId} rows=${drop}`,
    );
    return { ...snapshot, rows: { ...snapshot.rows, window: window.slice(drop) } };
  };

  const applyFrame = (mirror: Mirror, frame: ConversationTopicFrame) => {
    if (frame.payload.kind === "snapshot") {
      const next = frame.payload.snapshot;
      if (next.sessionId !== mirror.target.sessionId) return;
      mirror.subscriptionId ??= frame.subscriptionId;
      mirror.phase = "live";
      const snapshot = fitBudget(mirror, next);
      mirror.snapshot = snapshot;
      deliverRows(mirror, resetEvent(snapshot));
      publishState(mirror, snapshot);
      return;
    }
    // 重同步期间的增量跟不上镜像水位，等下一个 snapshot。
    const current = mirror.snapshot;
    if (mirror.phase !== "live" || !current) return;
    if (frame.fromSeq !== current.seq || frame.toSeq <= frame.fromSeq) {
      resync(mirror, "sequence gap");
      return;
    }
    const changed = new Set<number>();
    let removed = false;
    for (const delta of frame.payload.deltas) {
      if (delta.op === "row.appended" || delta.op === "row.upserted") changed.add(delta.row.rowId);
      else if (delta.op === "row.delta") changed.add(delta.rowId);
      else if (delta.op === "row.removed") removed = true;
    }
    const applied = { ...applyConversationDeltas(current, frame.payload.deltas), seq: frame.toSeq };
    const snapshot = fitBudget(mirror, applied, removed ? undefined : changed);
    mirror.snapshot = snapshot;
    if (removed) {
      // 行被删除（回退、压缩改写）：不单独推删除，整窗 reset。
      deliverRows(mirror, resetEvent(snapshot));
    } else if (changed.size > 0) {
      const upserted: ConversationRow[] = snapshot.rows.window.filter((row) =>
        changed.has(row.rowId),
      );
      if (upserted.length > 0)
        deliverRows(mirror, {
          kind: "rows",
          logEpoch: snapshot.logEpoch,
          revision: snapshot.revision,
          upserted,
        });
    }
    publishState(mirror, snapshot);
  };

  const acceptWire = (mirror: Mirror, wire: ConversationTopicWireCandidate) => {
    if (mirror.phase === "closed" || mirror.phase === "detached") return;
    if (mirror.subscriptionId && wire.subscriptionId !== mirror.subscriptionId) return;
    for (const event of mirror.assembler.accept(wire)) {
      if (event.kind === "fault") {
        logger.warn(
          undefined,
          `session mirror frame rejected session=${mirror.target.sessionId} reason=${event.fault.reasonCode}`,
        );
        resync(mirror, "assembly fault");
        return;
      }
      applyFrame(mirror, event.frame);
    }
  };

  /** 镜像不能恢复：它的订阅都以 unavailable 结束，镜像释放。 */
  const failMirror = (mirror: Mirror, reason: string) => {
    logger.warn(undefined, `session mirror failed session=${mirror.target.sessionId} (${reason})`);
    const error = new ExtensionError("unavailable", "the session is not available to read");
    for (const registration of mirror.registrations) {
      registration.disposed = true;
      registrations.delete(registration);
      registration.fail(error);
    }
    mirror.registrations.clear();
    closeMirror(mirror, true);
  };

  const subscribe = (mirror: Mirror, reason: string) => {
    const current = connection;
    if (!current || mirror.phase === "closed") return;
    mirror.attempt += 1;
    const attempt = mirror.attempt;
    mirror.phase = "subscribing";
    mirror.subscriptionId = null;
    mirror.assembler.clear();
    void (async () => {
      await current.ready;
      const result = await current.scope.service.subscribeConversationV4({
        workspacePath: mirror.target.workspacePath,
        ...(mirror.target.workspaceIdentity
          ? { workspaceIdentity: mirror.target.workspaceIdentity }
          : {}),
        sessionId: mirror.target.sessionId,
        visibility: "background",
      });
      if (attempt !== mirror.attempt || mirror.phase === "closed" || connection !== current) {
        void unsubscribeQuietly(current, mirror.target, result.ack.subscriptionId);
        return;
      }
      mirror.subscriptionId = result.ack.subscriptionId;
      logger.info(
        undefined,
        `session mirror subscribed session=${mirror.target.sessionId} connectionId=extension-host:${current.gen} mode=${result.ack.mode} (${reason})`,
      );
    })().catch((error: unknown) => {
      if (attempt !== mirror.attempt || mirror.phase === "closed" || connection !== current) return;
      failMirror(mirror, `subscribe failed: ${describe(error)}`);
    });
  };

  const resync = (mirror: Mirror, reason: string) => {
    const current = connection;
    const subscriptionId = mirror.subscriptionId;
    if (!current || mirror.phase !== "live" || !subscriptionId) return;
    mirror.phase = "resyncing";
    const attempt = mirror.attempt;
    // 与 Renderer 相同：RPC 前先清掉这条路由的组装状态，迟到的旧残片照常丢弃。
    mirror.assembler.abort(mirror.topic, subscriptionId);
    logger.info(undefined, `session mirror resync session=${mirror.target.sessionId} (${reason})`);
    void current.scope.service
      .resyncConversationV4({
        workspacePath: mirror.target.workspacePath,
        ...(mirror.target.workspaceIdentity
          ? { workspaceIdentity: mirror.target.workspaceIdentity }
          : {}),
        subscriptionId,
        base: null,
        forceSnapshot: true,
      })
      .catch((error: unknown) => {
        if (attempt !== mirror.attempt || mirror.phase === "closed") return;
        failMirror(mirror, `resync failed: ${describe(error)}`);
      });
  };

  const unsubscribeQuietly = async (
    current: Connection,
    target: Target,
    subscriptionId: string,
  ) => {
    try {
      await current.scope.service.unsubscribeConversationV4({
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        subscriptionId,
      });
    } catch (error) {
      logger.debug(undefined, `session mirror unsubscribe failed (${describe(error)})`);
    }
  };

  /** 释放镜像。unsubscribe 为 false 时由 scope.dispose() 统一退订（换代）。 */
  const closeMirror = (mirror: Mirror, unsubscribe: boolean) => {
    if (mirror.phase === "closed") return;
    const subscriptionId = mirror.subscriptionId;
    mirror.phase = "closed";
    mirror.attempt += 1;
    mirror.assembler.clear();
    mirror.snapshot = null;
    mirrors.delete(mirror.key);
    if (unsubscribe && connection && subscriptionId)
      void unsubscribeQuietly(connection, mirror.target, subscriptionId);
    logger.info(undefined, `session mirror released session=${mirror.target.sessionId}`);
  };

  // —— 登记：上限、解析、挂到镜像 ——

  /** 会话目标经 facade 解析：与 sessions.readSession 同一份授权与代际检查，只读本机来源。 */
  const resolve = async (
    call: CapabilityCallContext,
    sessionId: string,
    capabilityId: string,
    kind?: Registration["kind"],
  ): Promise<Target> => {
    // 交互一类的能力是写档：解析会话只是读，按 readSession 走（不写审计行；审计由调用方的写动作写一次）。
    const runAs = kind === "interactions" ? "sessions.readSession" : capabilityId;
    const result = await deps.sessions.run(call, runAs, (ctx, control) =>
      control.readSession(ctx, { sessionId, view: "summary" }),
    );
    if (result.view !== "summary") throw new ExtensionError("internal", "unexpected session view");
    const session = result.summary.session as AppSessionRef;
    if (session.kind !== "app" || session.sourceServerId !== deps.localSourceServerId())
      throw new ExtensionError("forbidden", "only sessions on this device can be read");
    // 交互与权限模式只对插件项目里的会话开放（§17.12）：在挂镜像之前检查。
    if (kind === "interactions") {
      if (!deps.controlScope)
        throw new ExtensionError("forbidden", "session approvals are not available");
      await deps.controlScope(call.pluginId, session);
    }
    return {
      workspacePath: session.workspacePath,
      ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
      sessionId: session.sessionId,
    };
  };

  const attach = (registration: Registration, target: Target, gen: number) => {
    const current = connect(gen);
    const key = `${workspaceKeyOf(target)}\0${target.sessionId}`;
    let mirror = mirrors.get(key);
    if (!mirror) {
      if (mirrors.size >= MAX_SESSION_MIRRORS)
        throw new ExtensionError(
          "limit-exceeded",
          `at most ${MAX_SESSION_MIRRORS} sessions can be read at the same time`,
        );
      mirror = {
        key,
        target,
        topic: conversationTopic(target.sessionId),
        assembler: new TopicWireFrameAssembler(conversationTopicFrameSchema),
        registrations: new Set(),
        attempt: 0,
        phase: "subscribing",
        subscriptionId: null,
        snapshot: null,
        rowBytes: new Map(),
        totalBytes: 0,
        stateKey: null,
        interactionsKey: null,
        lifecycleRevision: 0,
      };
      mirrors.set(key, mirror);
      watchWorkspace(current, target);
      subscribe(mirror, `first listener plugin=${registration.pluginId}`);
    }
    registration.mirror = mirror;
    mirror.registrations.add(registration);
    // 镜像已有快照：新的监听先收当前值（与镜像第一次收到快照时相同）。
    const snapshot = mirror.snapshot;
    if (snapshot && (mirror.phase === "live" || mirror.phase === "resyncing")) {
      if (registration.kind === "rows") deliverRows(mirror, resetEvent(snapshot), registration);
      else if (registration.kind === "interactions")
        deliver(mirror, "interactions", interactionsOf(mirror, snapshot), registration);
      else deliver(mirror, "conversation", stateOf(mirror, snapshot), registration);
    }
  };

  const release = (registration: Registration) => {
    if (registration.disposed) return;
    registration.disposed = true;
    registrations.delete(registration);
    const mirror = registration.mirror;
    if (!mirror) return;
    mirror.registrations.delete(registration);
    if (mirror.registrations.size === 0) closeMirror(mirror, true);
  };

  /**
   * 登记一个监听：上限按插件的不同会话数算（会话状态、行与交互合计），在解析前同步检查；
   * 解析（含范围检查）成功后挂到镜像。失败时以 fail 结束。返回登记（已失败时为 null）。
   */
  const admitRegistration = (
    call: CapabilityCallContext,
    input: SessionTargetInput,
    kind: Registration["kind"],
    capabilityId: string,
    listener: (event: never) => void,
    fail: (error: ExtensionError) => void,
    oneShot = false,
  ): Registration | null => {
    const sessions = new Set(
      [...registrations]
        .filter((entry) => entry.pluginId === call.pluginId)
        .map((entry) => entry.sessionId),
    );
    if (!sessions.has(input.sessionId) && sessions.size >= MAX_SESSION_SUBSCRIPTIONS_PER_PLUGIN) {
      fail(
        new ExtensionError(
          "limit-exceeded",
          `at most ${MAX_SESSION_SUBSCRIPTIONS_PER_PLUGIN} sessions per plugin can be subscribed`,
        ),
      );
      return null;
    }
    const registration: Registration = {
      pluginId: call.pluginId,
      sessionId: input.sessionId,
      kind,
      ...(oneShot ? { oneShot } : {}),
      listener,
      fail,
      mirror: null,
      disposed: false,
    };
    registrations.add(registration);
    void resolve(call, input.sessionId, capabilityId, kind)
      .then((target) => {
        if (registration.disposed) return;
        attach(registration, target, call.gen);
      })
      .catch((error: unknown) => {
        if (registration.disposed) return;
        registration.disposed = true;
        registrations.delete(registration);
        fail(
          error instanceof ExtensionError
            ? error
            : new ExtensionError("unavailable", "the session is not available to read"),
        );
      });
    return registration;
  };

  const register =
    <E>(kind: Registration["kind"], capabilityId: string) =>
    (call: CapabilityCallContext, input: SessionTargetInput): CapabilitySubscription<E> =>
    (listener, fail) => {
      const registration = admitRegistration(
        call,
        input,
        kind,
        capabilityId,
        listener as (event: never) => void,
        fail,
      );
      return { dispose: () => (registration ? release(registration) : undefined) };
    };

  return {
    async readRows(call, input) {
      const target = await resolve(call, input.sessionId, "sessions.readRows");
      const current = connect(call.gen);
      try {
        await current.ready;
        const result = await current.scope.service.conversationRowsRangeV4({
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
          sessionId: target.sessionId,
          ...(input.beforeRowId !== undefined ? { beforeRowId: input.beforeRowId } : {}),
          limit: input.limit,
        });
        return {
          logEpoch: result.atLogEpoch,
          revision: result.atRevision,
          rows: result.rows,
          hasMore: result.hasMore,
        };
      } catch (error) {
        // 原始错误文本可能带路径：日志与扩展都只拿错误码。
        logger.warn(undefined, `sessions.readRows failed (${describe(error)})`);
        throw new ExtensionError("unavailable", "the session rows are not available to read");
      }
    },
    onDidChangeList: (call) => list.subscribe(call.pluginId),
    onDidChangeConversation: register<SessionConversationEvent>(
      "conversation",
      "sessions.onDidChangeConversation",
    ),
    onDidChangeRows: register<SessionRowsEvent>("rows", "sessions.onDidChangeRows"),
    onDidChangeInteractions: register<SessionInteractionsEvent>(
      "interactions",
      "sessions.onDidChangeInteractions",
    ),
    readInteractions(call, sessionId) {
      // 临时挂一个交互登记：第一个事件就是当前值（镜像已有快照时立刻到，没有时等首个快照），拿到就释放。
      return new Promise<SessionInteractionsRead>((resolveRead, rejectRead) => {
        let settled = false;
        let registration: Registration | null = null;
        const finish = (outcome: () => void) => {
          if (settled) return;
          settled = true;
          if (registration) release(registration);
          outcome();
        };
        registration = admitRegistration(
          call,
          { sessionId },
          "interactions",
          "sessions.resolveInteraction",
          ((event: SessionInteractionsEvent) => {
            const target = registration?.mirror?.target;
            finish(() =>
              target
                ? resolveRead({ target: { ...target }, event })
                : rejectRead(
                    new ExtensionError("unavailable", "the session is not available to read"),
                  ),
            );
          }) as (event: never) => void,
          (error) => finish(() => rejectRead(error)),
          true,
        );
        // 登记时同步失败（上限）：fail 已经结束了这次读取；镜像已有快照时首个事件也是同步到达的。
        if (settled && registration) release(registration);
      });
    },
    detach() {
      // 网关的订阅随 RPC 服务端一起释放；这里先清登记，再释放镜像与作用域。
      // 一次性读取没有 RPC 订阅兜底：以 cancelled 结束，调用方据此报告换代。
      for (const registration of registrations) {
        registration.disposed = true;
        if (registration.oneShot)
          registration.fail(
            new ExtensionError("cancelled", "the extension host generation changed"),
          );
      }
      registrations.clear();
      releaseConnection("extension host detached");
    },
    dispose() {
      this.detach();
      list.dispose();
    },
  };
}
