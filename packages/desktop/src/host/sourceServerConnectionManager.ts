import {
  sourceServerRunningTasksSchema,
  type SourceServerRunningTask,
  type SourceServerRunningTasksResult,
} from "@zcode/shared";
/* eslint-disable max-lines -- Source 连接状态机、重试、更新和单连接归并必须共享同一代际状态。 */
import { SourceServerOperationLogs } from "./sourceServerOperationLogs.js";
import { Emitter, type Event } from "@zcode/rpc";
import type {
  ConnectionProfile,
  RemoteTarget,
  ServerRemoteInfo,
  CompatibilityManifest,
  SourceServerArtifactPolicy,
  SourceServerConnectionStateSnapshot,
} from "@zcode/shared";
import {
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_UPDATE_IN_PROGRESS_ERROR_CODE,
  REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE,
  ZCODE_COMPATIBILITY_MANIFEST,
  compareCompatibilityVersions,
  evaluateSourceServerCompatibility,
  isPublicZCodeErrorCode,
  normalizeRemoteConnectionError,
  stripRemoteTargetSecrets,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import {
  createSourceServerTransportAdapter,
  readServerCommandResult,
  type ServerReleaseAsset,
  type SourceServerFileTransfer,
  type SourceServerIngressInfo,
  type SourceServerTransportAdapter,
  type TransportContext,
} from "@zcode/server/source-server";
import {
  connectServerRemoteOverDuplex,
  type ServerRemoteConnection,
  type ServerRemoteDuplexConnectionOptions,
} from "./serverRemoteConnection.js";
import type { SourceServerDirectory } from "./sourceServerDirectory.js";
import { isSourceServerAutomaticRecoveryTerminalState } from "./sourceServerRecoveryPolicy.js";

export type {
  SourceServerConnectionState,
  SourceServerConnectionStateSnapshot,
} from "@zcode/shared";

export interface ManagedSourceServerConnection {
  /** 本次调用复用物理连接时的实际脱敏目标；不写入在线 owner。 */
  reusedConnectionTarget?: RemoteTarget;
  sourceServerId: string;
  profileId: string;
  serverInfo: ServerRemoteInfo;
  services: IServiceAccessor;
}

/** 会让远端主动断线的设备级生命周期操作。 */
type LifecycleOperationKind = "update" | "stop" | "restart";

/**
 * 让同 Source 在线连接关闭成为“预期断线”的生命周期操作：更新与重启，完成后由 reconnect 换代。
 * 停止在执行远端命令前已删除恢复意图并释放连接，不属于此类。
 */
type ExpectedDisconnectOperationKind = Exclude<LifecycleOperationKind, "stop">;

export type SourceServerConnectionInvalidatedEvent =
  | {
      sourceServerId: string;
      /** 更新或重启远端服务让在线连接失效；两者都可恢复，完成后由 reconnect 换代。 */
      reason: ExpectedDisconnectOperationKind;
    }
  | {
      sourceServerId: string;
      reason: "profile-removed";
      recoverable: false;
    };

export class SourceServerInstallRequiredError extends Error {
  public readonly code = SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE;
  public readonly retryable = false;
  public constructor(public readonly profileId: string) {
    super("Source Server installation requires explicit user confirmation");
    this.name = "SourceServerInstallRequiredError";
  }
}

export class SourceServerUpgradeRequiredError extends Error {
  public readonly code = SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE;
  public readonly retryable = false;
  public constructor(
    public readonly profileId: string,
    public readonly upgradeTarget: "controller" | "server",
    public readonly currentVersion: string,
    public readonly minimumVersion: string,
    public readonly reason: "compatibility" | "development-archive" = "compatibility",
  ) {
    super(
      reason === "development-archive"
        ? `Source Server ${currentVersion} release archive differs from the current development build and must be updated`
        : upgradeTarget === "server"
          ? `Source Server ${currentVersion} must be upgraded to at least ${minimumVersion}`
          : `ZCode Desktop ${currentVersion} must be upgraded to at least ${minimumVersion}`,
    );
    this.name = "SourceServerUpgradeRequiredError";
  }
}

export class SourceServerIdentityChangePendingError extends Error {
  public readonly code = SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE;
  public readonly retryable = false;
  public constructor(
    public readonly profileId: string,
    public readonly pendingSourceServerId: string,
  ) {
    super("Source Server identity changed after reinstall and requires confirmation");
    this.name = "SourceServerIdentityChangePendingError";
  }
}

class SourceServerExplicitDisconnectError extends Error {
  public readonly code = "remote-connection-canceled";
  public constructor(public readonly sourceServerId: string) {
    super(`Source Server explicitly disconnected: ${sourceServerId}`);
    this.name = "SourceServerExplicitDisconnectError";
  }
}

class SourceServerProfileRemovedError extends Error {
  public constructor(public readonly profileId: string) {
    super(`Connection Profile removed: ${profileId}`);
    this.name = "SourceServerProfileRemovedError";
  }
}

/**
 * 同一设备已有停止、重启或更新在进行，或同一 Profile 已有更新（R3 §8.4.5 互斥矩阵）；不是公开错误码，
 * UI 按管理错误文案展示。`subject` 只用于日志，例如 `Source Server <id>`、`Profile <id>`。
 */
class SourceServerLifecycleOperationInProgressError extends Error {
  public readonly code = "source-server-operation-in-progress";
  public readonly retryable = true;
  public constructor(subject: string) {
    super(`Another lifecycle operation is in progress for ${subject}`);
    this.name = "SourceServerLifecycleOperationInProgressError";
  }
}

/** 同一设备的更新进行中，公开连接入口被拒绝（R3 §6.3「更新期间的连接」）。 */
class SourceServerUpdateInProgressError extends Error {
  public readonly code = SOURCE_SERVER_UPDATE_IN_PROGRESS_ERROR_CODE;
  public readonly retryable = true;
  public constructor(public readonly profileId: string) {
    super("Source Server update is in progress; connect after the update finishes");
    this.name = "SourceServerUpdateInProgressError";
  }
}

/** 用户在本机阶段取消更新（R3 §6.3）；取消不是失败，设备操作日志记为 info。 */
class SourceServerUpdateCanceledError extends Error {
  public readonly code = "remote-connection-canceled";
  public readonly retryable = true;
  public constructor(public readonly profileId: string) {
    super("Source Server update canceled");
    this.name = "SourceServerUpdateCanceledError";
  }
}

class SourceServerHandshakeClosedError extends Error {
  public readonly retryable = true;
  public constructor(reason: string) {
    super(`Source Server connection closed during handshake: ${reason}`);
    this.name = "SourceServerHandshakeClosedError";
  }
}

export interface SourceServerConnectionManagerOptions {
  /** 成员关系归持久化端口；连接管理器只负责 admission 和握手提交的时序。 */
  admitConnection?: (input: {
    profile: ConnectionProfile;
    intent: "add" | "retain";
    confirmIdentityChange: boolean;
  }) => Promise<(sourceServerId: string) => Promise<void>>;
  directory: {
    recordLastOnline?(sourceServerId: string, timestamp: number): Promise<void>;
    markSourceUninstalled?(profileId: string): Promise<void>;
    recordHandshake(
      profileId: string,
      handshake: Parameters<SourceServerDirectory["recordHandshake"]>[1],
      options?: Parameters<SourceServerDirectory["recordHandshake"]>[2],
    ): Promise<{
      identityChanged: boolean;
      effectiveProfile?: ConnectionProfile;
    }>;
  };
  createAdapter?: (kind: "ssh" | "wsl" | "docker") => SourceServerTransportAdapter;
  connectServer?: (options: ServerRemoteDuplexConnectionOptions) => Promise<ServerRemoteConnection>;
  now?: () => number;
  logWarn?: (message: string, error: Error) => void;
  onProjectChange?: (sourceServerId: string) => void;
  compatibilityManifest?: CompatibilityManifest;
  sourceServerArtifactPolicy?: SourceServerArtifactPolicy;
  resolveRelease?: (
    probe: Awaited<ReturnType<SourceServerTransportAdapter["probe"]>>,
    target: Exclude<RemoteTarget, { kind: "server" }>,
    options?: { metadataOnly?: boolean } & Pick<TransportContext, "signal" | "onLog">,
  ) => Promise<ServerReleaseAsset>;
}

export interface ConnectSourceServerOptions {
  membershipIntent?: "add" | "retain";
  profile: ConnectionProfile;
  target: RemoteTarget;
  release?: ServerReleaseAsset;
  allowInstall?: boolean;
  confirmIdentityChange?: boolean;
  resolveRelease?: SourceServerConnectionManagerOptions["resolveRelease"];
  context?: TransportContext;
  onDiagnosticPhase?: (phase: string) => void;
  /** 仅实际执行探测/握手的 flight 在升级等待点调用，join 请求不得提交另一份凭据。 */
  onAuthenticatedUpgradeRequired?: () => Promise<void>;
}

export interface StartupReconnectResult {
  profileId: string;
  status: "online" | "failed";
  error?: string;
}

interface OnlineConnection extends ManagedSourceServerConnection {
  connection: ServerRemoteConnection;
  profileIds: Set<string>;
  projectSubscription?: { dispose(): void };
}

interface ReconnectInput {
  profile: ConnectionProfile;
  target: Exclude<RemoteTarget, { kind: "server" }>;
  context: TransportContext;
}

interface ConnectFlight {
  promise: Promise<ManagedSourceServerConnection>;
  sourceServerId?: string;
  controller: AbortController;
}

/**
 * 生命周期操作 flight：更新与重启存在期间，同 Source 的在线连接关闭视为预期断线，只做连接失效、
 * 不排重试；显式断开、移除 Profile 与 dispose 会中止它。同一 Source 只允许多个 update flight 并存
 * （经 sibling Profile 发起，同一 Profile 最多一个）；停止、重启与任何操作互斥（R3 §8.4.5）。
 */
interface LifecycleOperationFlight {
  kind: LifecycleOperationKind;
  profileId: string;
  sourceServerId?: string;
  controller: AbortController;
  /**
   * 更新本机阶段的取消（R3 §6.3）；进入远端阶段前置空，此后 cancelUpdate 不再生效。
   * 快照的 `updateCancelable` 只由它推导（见 setState）。
   */
  localStageCancel?: AbortController;
}

/** 设备级操作（停止、重启、读取运行中任务）执行远端命令所用的连接与凭据。 */
type SourceOperationRoute = Pick<ReconnectInput, "profile" | "target">;

const ONLINE_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;
const OFFLINE_PROBE_INTERVAL_MS = 2 * 60_000;

/**
 * 生命周期操作（更新、停止、重启）失败写入连接状态的错误字段。errorCode 与 retryable 取自同一归一化
 * 结果（唯一来源）：错误码来自内层原因时，retryable 不能再读外层包装。远端未声明 retryable 时统一
 * 按可重试处理（2026-10-21 确认，含停止失败）。
 */
function describeLifecycleOperationFailure(
  error: unknown,
): Pick<SourceServerConnectionStateSnapshot, "error" | "errorCode" | "retryable"> {
  const normalized = normalizeRemoteConnectionError(error);
  return {
    error: normalized.message,
    ...(isPublicZCodeErrorCode(normalized.code) ? { errorCode: normalized.code } : {}),
    retryable: normalized.retryable ?? true,
  };
}

/** 预期断线操作在被失效连接上的状态投影：重启只显示“连接中”，不能显示成更新中（RDLC-01）。 */
function expectedDisconnectProjection(
  kind: ExpectedDisconnectOperationKind,
): "updating" | "bootstrapping" {
  return kind === "restart" ? "bootstrapping" : "updating";
}

function readErrorRetryable(error: unknown): boolean | undefined {
  if (!error || typeof error !== "object" || !("retryable" in error)) {
    return undefined;
  }
  return typeof error.retryable === "boolean" ? error.retryable : undefined;
}

function isAutomaticRecoveryUserActionCode(code: unknown): boolean {
  return (
    code === SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE ||
    code === SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE ||
    code === SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE
  );
}

function buildCompatibilityState(
  controller: CompatibilityManifest,
  server: CompatibilityManifest,
): Pick<
  SourceServerConnectionStateSnapshot,
  "updateAvailability" | "currentVersion" | "availableVersion" | "minimumVersion" | "upgradeTarget"
> {
  const result = evaluateSourceServerCompatibility(controller, server);
  if (!result.compatible && result.upgradeTarget) {
    return {
      updateAvailability: "required",
      currentVersion: result.olderVersion,
      availableVersion: result.newerVersion,
      minimumVersion: result.requiredMinimumVersion,
      upgradeTarget: result.upgradeTarget,
    };
  }
  if (result.updateAvailable) {
    return {
      updateAvailability: "available",
      currentVersion: result.olderVersion,
      availableVersion: result.newerVersion,
      minimumVersion: result.requiredMinimumVersion,
      upgradeTarget: result.newerEndpoint === "controller" ? "server" : "controller",
    };
  }
  return {
    updateAvailability: "none",
    currentVersion: server.productVersion,
    availableVersion: server.productVersion,
    minimumVersion: result.requiredMinimumVersion,
  };
}

function preserveCompatibilityState(
  snapshot: SourceServerConnectionStateSnapshot,
): Pick<
  SourceServerConnectionStateSnapshot,
  | "updateAvailability"
  | "currentVersion"
  | "availableVersion"
  | "minimumVersion"
  | "upgradeTarget"
  | "downgradedFrom"
> {
  return {
    ...(snapshot.updateAvailability ? { updateAvailability: snapshot.updateAvailability } : {}),
    ...(snapshot.currentVersion ? { currentVersion: snapshot.currentVersion } : {}),
    ...(snapshot.availableVersion ? { availableVersion: snapshot.availableVersion } : {}),
    ...(snapshot.minimumVersion ? { minimumVersion: snapshot.minimumVersion } : {}),
    ...(snapshot.upgradeTarget ? { upgradeTarget: snapshot.upgradeTarget } : {}),
    ...(snapshot.downgradedFrom ? { downgradedFrom: snapshot.downgradedFrom } : {}),
  };
}

function createConcurrencyGate(limit: number): {
  acquire(): Promise<() => void>;
} {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    acquire: async () =>
      await new Promise<() => void>((resolve) => {
        const grant = () => {
          active += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active -= 1;
            waiting.shift()?.();
          });
        };
        if (active < limit) grant();
        else waiting.push(grant);
      }),
  };
}

export class SourceServerConnectionManager {
  private readonly adapters = new Map<string, SourceServerTransportAdapter>();
  private readonly states = new Map<string, SourceServerConnectionStateSnapshot>();
  private readonly compatibilityByProfileId = new Map<
    string,
    ReturnType<typeof preserveCompatibilityState>
  >();
  private readonly onlineBySourceServerId = new Map<string, OnlineConnection>();
  private readonly connectFlights = new Map<string, ConnectFlight>();
  private readonly stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
  private readonly reconnectEmitter = new Emitter<ManagedSourceServerConnection>();
  private readonly connectionInvalidatedEmitter =
    new Emitter<SourceServerConnectionInvalidatedEvent>();
  private readonly reconnectInputs = new Map<string, ReconnectInput>();
  private readonly profileIdsBySourceServerId = new Map<string, Set<string>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly offlineProbeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lifecycleOperationFlights = new Set<LifecycleOperationFlight>();
  public readonly onDidChangeState: Event<SourceServerConnectionStateSnapshot> =
    this.stateEmitter.event;
  public readonly onDidReconnect: Event<ManagedSourceServerConnection> =
    this.reconnectEmitter.event;
  public readonly onDidInvalidateConnection: Event<SourceServerConnectionInvalidatedEvent> =
    this.connectionInvalidatedEmitter.event;
  private readonly createAdapter: NonNullable<
    SourceServerConnectionManagerOptions["createAdapter"]
  >;
  private readonly connectServer: NonNullable<
    SourceServerConnectionManagerOptions["connectServer"]
  >;
  private readonly now: () => number;
  private readonly compatibilityManifest: CompatibilityManifest;

  private readonly operationLogs = new SourceServerOperationLogs(() => this.now());
  public readonly onDidAppendOperationLog = this.operationLogs.onDidAppend;
  public getRecentOperationLogs(profile: Pick<ConnectionProfile, "profileId" | "sourceServerId">) {
    return this.operationLogs.read(profile);
  }

  public constructor(private readonly options: SourceServerConnectionManagerOptions) {
    this.createAdapter =
      options.createAdapter ?? ((kind) => createSourceServerTransportAdapter(kind));
    this.connectServer = options.connectServer ?? connectServerRemoteOverDuplex;
    this.now = options.now ?? Date.now;
    this.compatibilityManifest = options.compatibilityManifest ?? ZCODE_COMPATIBILITY_MANIFEST;
  }

  public async connect(
    options: ConnectSourceServerOptions,
  ): Promise<ManagedSourceServerConnection> {
    // Bug 原因（ZCT-2116085848489570304）：更新上传期间，同一向导又对同一设备连接了一次。
    // 连接照常 probe 到旧版本，把 updating 改成 needs-upgrade，并替换设备操作日志；更新仍在后台
    // 进行，用户却只看到“必须升级”。更新的内部重连走 connectForSource，不经过这里；其他入口在
    // 写状态、写日志和建 transport 之前拒绝，原连接意图由发起更新的一方继续。
    const { profile } = options;
    for (const flight of this.lifecycleOperationFlights) {
      if (
        flight.kind === "update" &&
        (flight.profileId === profile.profileId ||
          (profile.sourceServerId !== undefined &&
            flight.sourceServerId === profile.sourceServerId))
      ) {
        throw new SourceServerUpdateInProgressError(profile.profileId);
      }
    }
    try {
      return await this.connectForSource(
        { ...options, membershipIntent: options.membershipIntent ?? "add" },
        options.profile.sourceServerId,
      );
    } finally {
      // 连接失败、被拒或复用已有连接时，本次 target 没有成为恢复意图，不能留下空闲会话。
      this.releaseTargetTransport(options.target);
    }
  }

  private reusedConnection(
    connection: ManagedSourceServerConnection,
  ): ManagedSourceServerConnection {
    const target = this.reconnectInputs.get(connection.sourceServerId)?.target;
    return {
      sourceServerId: connection.sourceServerId,
      profileId: connection.profileId,
      serverInfo: connection.serverInfo,
      services: connection.services,
      ...(target ? { reusedConnectionTarget: stripRemoteTargetSecrets(target) } : {}),
    };
  }

  private async connectForSource(
    options: ConnectSourceServerOptions,
    sourceServerId: string | undefined,
    recordOperation = true,
  ): Promise<ManagedSourceServerConnection> {
    const existingFlight = this.connectFlights.get(options.profile.profileId);
    if (existingFlight) return this.reusedConnection(await existingFlight.promise);
    const controller = new AbortController();
    const flightOptions = sourceServerId
      ? {
          ...options,
          context: {
            ...options.context,
            signal: options.context?.signal
              ? AbortSignal.any([options.context.signal, controller.signal])
              : controller.signal,
          },
        }
      : options;
    let flight!: ConnectFlight;
    const connect = (context: TransportContext) =>
      this.connectOnce({ ...flightOptions, context }, controller.signal);
    const promise = (
      recordOperation
        ? this.operationLogs.run(
            "connect",
            options.profile,
            options.target,
            flightOptions.context,
            connect,
          )
        : connect(flightOptions.context ?? {})
    ).finally(() => {
      if (this.connectFlights.get(options.profile.profileId) === flight) {
        this.connectFlights.delete(options.profile.profileId);
      }
    });
    flight = {
      promise,
      ...(sourceServerId ? { sourceServerId } : {}),
      controller,
    };
    this.connectFlights.set(options.profile.profileId, flight);
    return await promise;
  }

  public getStateByProfile(profileId: string): SourceServerConnectionStateSnapshot {
    return (
      this.states.get(profileId) ?? {
        profileId,
        state: "absent",
        updatedAt: this.now(),
      }
    );
  }

  public listStates(): SourceServerConnectionStateSnapshot[] {
    return [...this.states.values()];
  }

  public async reconnectOnStartup(
    candidates: Array<{
      profile: ConnectionProfile;
      target: Exclude<RemoteTarget, { kind: "server" }>;
    }>,
    options: { maxConcurrency?: number; timeoutMs?: number } = {},
  ): Promise<StartupReconnectResult[]> {
    if (candidates.length === 0) return [];
    const timeoutMs = options.timeoutMs ?? 10_000;
    const globalGate = createConcurrencyGate(Math.max(1, options.maxConcurrency ?? 3));
    // Bug 原因：多个 Docker Source 共用本机 Docker daemon、磁盘和 CPU。三条冷启动 probe
    // 同时校验大体积 release 时，单条手动连接只需约 4.6 秒，三条并发却会一起撞上 10 秒
    // 上限。Docker 冷启动在 transport 内串行，SSH 仍可占用其余全局槽位。
    const dockerGate = createConcurrencyGate(1);
    const reconnectCandidate = async (
      candidate: (typeof candidates)[number],
    ): Promise<StartupReconnectResult> => {
      const releaseTransport =
        candidate.target.kind === "docker" ? await dockerGate.acquire() : undefined;
      const releaseGlobal = await globalGate.acquire();
      const abortController = new AbortController();
      const startedAt = Date.now();
      let diagnosticPhase = "queued";
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.connect({
            profile: candidate.profile,
            target: candidate.target,
            membershipIntent: "retain",
            context: { signal: abortController.signal },
            onDiagnosticPhase: (phase) => {
              diagnosticPhase = phase;
            },
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Source Server startup reconnect timed out after ${timeoutMs}ms`));
              abortController.abort();
            }, timeoutMs);
          }),
        ]);
        return { profileId: candidate.profile.profileId, status: "online" };
      } catch (error) {
        if (error instanceof Error && error.message.includes("startup reconnect timed out")) {
          this.options.logWarn?.(
            `Source Server startup reconnect timeout diagnostic profile=${
              candidate.profile.profileId
            } transport=${candidate.target.kind} phase=${diagnosticPhase} elapsedMs=${Date.now() - startedAt}`,
            error,
          );
        }
        return {
          profileId: candidate.profile.profileId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (timer) clearTimeout(timer);
        releaseGlobal();
        releaseTransport?.();
      }
    };
    // 最近在线的 Source 对应用户最可能仍在使用的 workspace。首个候选独占启动窗口，
    // 避免和其余 Source 同时 probe/握手而在应用冷启动峰值中耗尽 10 秒预算；完成后其余
    // Source 再按全局 3 并发继续，不改变单 Source 超时和只尝试一次的合同。
    const [firstCandidate, ...remainingCandidates] = candidates;
    const firstResult = await reconnectCandidate(firstCandidate!);
    return [firstResult, ...(await Promise.all(remainingCandidates.map(reconnectCandidate)))];
  }

  public getOnlineConnection(sourceServerId: string): ManagedSourceServerConnection | undefined {
    return this.onlineBySourceServerId.get(sourceServerId);
  }

  public getFileTransfer(sourceServerId: string): SourceServerFileTransfer {
    const online = this.onlineBySourceServerId.get(sourceServerId);
    const input = this.reconnectInputs.get(sourceServerId);
    if (!online || !input) throw new Error("Source Server file transfer is unavailable");
    const backend = this.getAdapter(input.profile.transport).createFileTransfer(input.target);
    const assertCurrent = () => {
      // 暂存属于当前 attachment generation；旧能力不能在重连后悄悄使用新线路或重建连接。
      if (this.onlineBySourceServerId.get(sourceServerId) !== online) {
        throw new Error("Source Server file transfer generation is unavailable");
      }
    };
    return {
      exec: async (command) => {
        assertCurrent();
        return backend.exec(command);
      },
      upload: async (localPath, remotePath, options) => {
        assertCurrent();
        await backend.upload(localPath, remotePath, options);
        assertCurrent();
      },
    };
  }

  public async updateServer(options: {
    profile: ConnectionProfile;
    target: Exclude<RemoteTarget, { kind: "server" }>;
    force?: boolean;
    allowDowngrade?: boolean;
    context?: TransportContext;
    release?: ServerReleaseAsset;
    resolveRelease?: SourceServerConnectionManagerOptions["resolveRelease"];
  }): Promise<ManagedSourceServerConnection> {
    const { profile } = options;
    // 必须在写操作日志前拒绝：日志 owner 按设备只保留最近一次操作，被拒绝的更新不能覆盖停止的日志。
    if (profile.sourceServerId) {
      this.assertLifecycleOperationCanStart(profile.sourceServerId, "update");
    }
    // Bug 原因（CR-01）：同一 Profile 曾允许两个更新并存。后一个更新把前一个写的 updating 记成更新前状态，
    // 取消或失败收口时写回，更新全部结束后设备仍显示“更新中”；取消后旧更新迟到的收口还会覆盖新更新的状态。
    // 同一 Profile 只允许一个更新：flight 在收口之后才摘除，新更新必然读到稳定的更新前状态。
    for (const flight of this.lifecycleOperationFlights) {
      if (flight.kind === "update" && flight.profileId === profile.profileId) {
        throw new SourceServerLifecycleOperationInProgressError(`Profile ${profile.profileId}`);
      }
    }
    // Bug 原因：更新不在 connectFlights 中，断开后安装的迟到结果仍能重新发布连接。
    // 按操作身份登记，尚未握手的 Profile 也可取消；取消时先摘 owner，旧更新不再压住新连接的恢复。
    const flight = this.registerLifecycleOperation(
      "update",
      profile.profileId,
      profile.sourceServerId,
    );
    flight.localStageCancel = new AbortController();
    const signal = AbortSignal.any([
      ...(options.context?.signal ? [options.context.signal] : []),
      flight.controller.signal,
      flight.localStageCancel.signal,
    ]);
    try {
      return await this.operationLogs.run(
        "update",
        profile,
        options.target,
        { ...options.context, signal },
        (context) => this.updateServerOnce({ ...options, context }, flight),
      );
    } finally {
      this.lifecycleOperationFlights.delete(flight);
      this.releaseTargetTransport(options.target);
    }
  }

  /**
   * 取消该线路处于本机阶段（probe、release 解析与本机下载）的更新（R3 §6.3），返回是否取消了更新。
   * 远端阶段或没有更新时为空操作并返回 false。取消不是断开：不删除恢复意图，由 updateServerOnce
   * 按失败路径收口且不写错误字段。
   */
  public cancelUpdate(profileId: string): boolean {
    let canceled = false;
    for (const flight of this.lifecycleOperationFlights) {
      if (flight.kind !== "update" || flight.profileId !== profileId || !flight.localStageCancel)
        continue;
      flight.localStageCancel.abort(new SourceServerUpdateCanceledError(profileId));
      canceled = true;
    }
    return canceled;
  }

  private async updateServerOnce(
    options: Parameters<SourceServerConnectionManager["updateServer"]>[0] & {
      context: TransportContext;
    },
    flight: LifecycleOperationFlight,
  ): Promise<ManagedSourceServerConnection> {
    const { context } = options;
    const { controller } = flight;
    const localStageSignal = flight.localStageCancel?.signal;
    const sourceServerId = options.profile.sourceServerId;
    const previousState = this.getStateByProfile(options.profile.profileId);
    const previousCompatibility = preserveCompatibilityState(previousState);
    if (sourceServerId) {
      this.clearRecoveryTimers(sourceServerId);
    }
    this.setState(options.profile.profileId, {
      state: "updating",
      ...(sourceServerId ? { sourceServerId } : {}),
      ...previousCompatibility,
    });
    let runningTasks: SourceServerRunningTask[] | undefined;
    try {
      context.signal?.throwIfAborted();
      const adapter = this.getAdapter(options.profile.transport);
      // Bug 原因：已握手分支曾改走远端 `zcode update`，但正常安装链没有配置远端 release
      // manifest URL，生产更新必然失败。所有 Profile 都由 Desktop 解析同一 archive 并经 Adapter 应用。
      const probe = await adapter.probe(options.target, context);
      context.signal?.throwIfAborted();
      const releaseResolver = options.resolveRelease ?? this.options.resolveRelease;
      // Bug 原因（ZCT-2117527614209818624）：resolver 在本机下载约 90MB archive，过去不接收取消信号也不写
      // 进度，更新停在“Checking the remote device”几分钟且无法取消。现在下载随更新取消立即中止并写进度。
      const release =
        options.release ??
        (releaseResolver
          ? await releaseResolver(probe, options.target, {
              signal: context.signal,
              onLog: context.onLog,
            })
          : null);
      context.signal?.throwIfAborted();
      if (!release) throw new Error("Source Server update release is unavailable");
      // 远端阶段从 installOrUpdate 开始，此后取消会留下写了一半的远端；同步去掉可取消标记（R3 §6.3）。
      flight.localStageCancel = undefined;
      this.setState(options.profile.profileId, {
        state: "updating",
        ...(sourceServerId ? { sourceServerId } : {}),
        ...previousCompatibility,
      });
      await adapter.installOrUpdate(options.target, release, context, {
        force: options.force === true,
        ...(options.allowDowngrade ? { allowDowngrade: true } : {}),
      });
      context.signal?.throwIfAborted();
      const online = sourceServerId ? this.onlineBySourceServerId.get(sourceServerId) : undefined;
      if (sourceServerId && online) {
        this.invalidateOnlineConnectionForLifecycleOperation(sourceServerId, online, "update");
      }
      // 失效事件的同步订阅者也可能提交断开，不能在该终态后进入 bootstrapping。
      context.signal?.throwIfAborted();
      // 重连事件由 connectOnce 的发布点统一 fire，这里不再重复发布。
      return await this.connectForSource(
        {
          profile: options.profile,
          target: options.target,
          context,
        },
        sourceServerId,
        false,
      );
    } catch (error) {
      // 终态由断开/删除/释放操作发布；旧更新的成功或失败都不能写回捕获的旧状态。
      controller.signal.throwIfAborted();
      if (localStageSignal?.aborted) {
        // 本机阶段被取消：远端没有写入。按失败收口恢复更新前状态，但不写错误字段（R3 §6.3）。
        const canceled: unknown = localStageSignal.reason;
        this.settleFailedLifecycleOperation({
          kind: "update",
          profileId: options.profile.profileId,
          sourceServerId,
          previousState,
          error: canceled,
          canceled: true,
        });
        throw canceled;
      }
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "source-server-update-running-tasks"
      ) {
        // 清单不可用不能绕过 force=false 的运行任务守卫，保持未知即可。
        runningTasks = await this.readRunningTasks(
          options.profile.transport,
          options.target,
          context,
        );
      }
      // running-tasks 读取同样会让出执行权，断开可能发生在错误收尾期间。
      controller.signal.throwIfAborted();
      this.settleFailedLifecycleOperation({
        kind: "update",
        profileId: options.profile.profileId,
        sourceServerId,
        previousState,
        runningTasks,
        error,
      });
      throw error;
    }
  }

  /**
   * 经 transport 执行只读的 `running-tasks --json`。清单走控制命令，不扩展持久化 status 格式；
   * 远端输出 null（Core 尚未上报）、命令失败或输出不符 schema 都返回 undefined，即“清单不可用”。
   */
  private async readRunningTasks(
    transport: ConnectionProfile["transport"],
    target: Exclude<RemoteTarget, { kind: "server" }>,
    context: TransportContext,
  ): Promise<SourceServerRunningTask[] | undefined> {
    try {
      const result = await this.getAdapter(transport).exec(
        target,
        ["running-tasks", "--json"],
        context,
      );
      if (result.exitCode !== 0) return undefined;
      const parsed = sourceServerRunningTasksSchema.safeParse(JSON.parse(result.stdout.trim()));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 停止 / 重启确认前按设备读取运行中任务（RDLC-01，R3 §8.4.5）。路由与凭据规则同停止和重启：
   * 有恢复意图时沿用其连接与内存中的凭据，否则由调用方解析可静默取得凭据的离线路由
   * （取不到时抛 `credentials-required`）。只读：不登记生命周期操作，不改变连接状态，也不写设备
   * 操作日志（日志按设备只保留最近一次操作，读取不能覆盖它）。
   */
  public async getSourceRunningTasks(input: {
    sourceServerId: string;
    resolveOfflineRoute: () => Promise<SourceOperationRoute>;
  }): Promise<SourceServerRunningTasksResult> {
    const route = await this.resolveSourceOperationRoute(input);
    try {
      const tasks = await this.readRunningTasks(route.profile.transport, route.target, {});
      return tasks ? { available: true, tasks } : { available: false };
    } finally {
      this.releaseTargetTransport(route.target);
    }
  }

  /**
   * 设备级操作（停止、重启、读取运行中任务）的唯一路由解析：Source 有恢复意图（在线、重试或离线探测中）
   * 时沿用其连接与内存中的凭据；否则由调用方按默认连接、最近连接解析可静默取得凭据的离线路由。
   * 读取凭据会让出执行权，期间手动连接可能已发布恢复意图：恢复意图的连接优先，保证操作的 Profile
   * 就是之后承接恢复的那条连接。让出执行权后的互斥复查由调用方负责。
   */
  private async resolveSourceOperationRoute(input: {
    sourceServerId: string;
    resolveOfflineRoute: () => Promise<SourceOperationRoute>;
  }): Promise<SourceOperationRoute> {
    const current = this.reconnectInputs.get(input.sourceServerId);
    if (current) return current;
    const offlineRoute = await input.resolveOfflineRoute();
    return this.reconnectInputs.get(input.sourceServerId) ?? offlineRoute;
  }

  /**
   * 更新与重启失败的统一收口（R3 §8.4.5）。物理连接已不在时：有恢复意图且非终态从第一档自动恢复；
   * 没有恢复意图时，更新保持 offline 带错误，重启显示连接失败（`failed`）。连接仍在时恢复操作前状态。
   */
  private settleFailedLifecycleOperation(input: {
    kind: ExpectedDisconnectOperationKind;
    profileId: string;
    sourceServerId?: string;
    previousState: SourceServerConnectionStateSnapshot;
    runningTasks?: SourceServerRunningTask[];
    error: unknown;
    /** 用户取消更新：不是失败事实，不写错误字段，仍需升级的设备继续显示“需要更新”。 */
    canceled?: boolean;
  }): void {
    const { profileId, sourceServerId, previousState, runningTasks, error } = input;
    const failure = {
      ...preserveCompatibilityState(previousState),
      ...(runningTasks ? { runningTasks } : {}),
      ...(input.canceled ? {} : describeLifecycleOperationFailure(error)),
    };
    if (sourceServerId && !this.onlineBySourceServerId.has(sourceServerId)) {
      // 操作期间 transport 已断开时不能恢复捕获的 online 快照，否则会产生无连接、无 timer 的假在线。
      if (this.reconnectInputs.has(sourceServerId)) {
        if (!this.stopAutomaticRecoveryForTerminalFailure(sourceServerId, error)) {
          this.scheduleOnlineRetry(sourceServerId, 0);
        }
      } else {
        this.setState(profileId, {
          // 重启从未连接状态发起即是“让设备恢复可用”，失败须显示连接失败而非中性的未连接。
          state: input.kind === "restart" ? "failed" : "offline",
          sourceServerId,
          ...failure,
        });
      }
      return;
    }
    this.setState(profileId, {
      // 失败不是新的兼容性事实；真实连接仍在时恢复操作前状态。取消没有失败，原样恢复。
      state: previousState.state === "absent" && !input.canceled ? "failed" : previousState.state,
      ...(sourceServerId ? { sourceServerId } : {}),
      ...failure,
    });
  }

  /**
   * 重启设备上的远端服务（RDLC-01，R3 §8.4.5）。登记 `restart` 生命周期操作 flight 并清恢复定时器，
   * 设备显示“连接中”；经 transport 执行 `restart --json`，远端旧进程退出引起的在线连接关闭视为预期断线。
   * 远端确认新 daemon ready 后走现有连接流程并发出 reconnect，由 Registry 为已打开的 workspace 换代。
   *
   * 路由同停止：Source 有恢复意图时沿用其连接与内存中的凭据；否则由调用方按默认连接、最近连接
   * 解析可静默取得凭据的连接。
   */
  public async restartSource(input: {
    sourceServerId: string;
    resolveOfflineRoute: () => Promise<SourceOperationRoute>;
  }): Promise<ManagedSourceServerConnection> {
    const { sourceServerId } = input;
    // 必须在写操作日志前拒绝：被拒绝的重启不能覆盖进行中操作的日志。
    this.assertLifecycleOperationCanStart(sourceServerId, "restart");
    const { profile, target } = await this.resolveSourceOperationRoute(input);
    // 离线路由读取凭据会让出执行权，期间可能已有其他生命周期操作登记。
    this.assertLifecycleOperationCanStart(sourceServerId, "restart");
    const flight = this.registerLifecycleOperation("restart", profile.profileId, sourceServerId);
    const { controller } = flight;
    try {
      return await this.operationLogs.run(
        "restart",
        profile,
        target,
        { signal: controller.signal },
        async (context) => {
          const previousState = this.getStateByProfile(profile.profileId);
          this.clearRecoveryTimers(sourceServerId);
          // 不新增 Host 状态：重启期间投影为“连接中”，不显示更新中，也不带自动重试计数。
          this.setState(profile.profileId, { state: "bootstrapping", sourceServerId });
          try {
            const status = readServerCommandResult(
              await this.getAdapter(profile.transport).exec(target, ["restart", "--json"], context),
              "Remote service failed to restart",
            );
            // 旧远端会把 restart 当成只换 Core 的 ack；只有新 daemon ready 才能开始连接。
            if (status.state !== "ready") {
              throw new Error("Remote service did not confirm that it restarted");
            }
            controller.signal.throwIfAborted();
            // Bug 原因：远端旧进程退出后，WS close 可能晚于命令返回；连接流程会把仍登记为在线的
            // 旧连接当作可复用并直接返回，随后迟到的 close 又按普通断线排重试。连接前先主动失效。
            const online = this.onlineBySourceServerId.get(sourceServerId);
            if (online) {
              this.invalidateOnlineConnectionForLifecycleOperation(
                sourceServerId,
                online,
                "restart",
              );
            }
            // 失效事件的同步订阅者也可能提交断开，不能在该终态后进入连接流程。
            controller.signal.throwIfAborted();
            // 重连事件由 connectOnce 的发布点统一 fire。
            return await this.connectForSource({ profile, target, context }, sourceServerId, false);
          } catch (error) {
            // 断开、移除或释放已经发布了终态；被中止的重启不能写回状态。
            controller.signal.throwIfAborted();
            this.settleFailedLifecycleOperation({
              kind: "restart",
              profileId: profile.profileId,
              sourceServerId,
              previousState,
              error,
            });
            throw error;
          }
        },
      );
    } finally {
      this.lifecycleOperationFlights.delete(flight);
      this.releaseTargetTransport(target);
    }
  }

  /**
   * 停止设备上的远端服务（RDLC-01，R3 §8.4.5）。先完整执行显式断开收口（清定时器、中止在途连接、
   * 删除恢复意图、释放连接、置 offline），再经 transport 执行 `stop --wait --json`。恢复意图已删除，
   * 远端退出引起的连接关闭不会排重试或离线探测；成功和失败都保持 offline。
   *
   * 路由：Source 仍有恢复意图（在线、重试或离线探测中）时沿用其连接与内存中的凭据；
   * 否则由调用方按默认连接、最近连接解析可静默取得凭据的连接。
   */
  public async stopSource(input: {
    sourceServerId: string;
    resolveOfflineRoute: () => Promise<SourceOperationRoute>;
  }): Promise<void> {
    const { sourceServerId } = input;
    // 必须在写操作日志前拒绝：被拒绝的停止不能覆盖进行中操作的日志。
    this.assertLifecycleOperationCanStart(sourceServerId, "stop");
    const route = await this.resolveSourceOperationRoute(input);
    // 离线路由读取凭据会让出执行权，期间可能已有其他生命周期操作登记；必须在显式断开（会中止
    // 同 Source 的全部 flight）之前复查，否则断开会先中止进行中的操作。
    this.assertLifecycleOperationCanStart(sourceServerId, "stop");
    // 路由取自恢复意图时，断开交回的就是 route.target：远端命令沿用它的会话，不重新认证，结束后再释放。
    this.disconnectSource(sourceServerId);
    const profileId = route.profile.profileId;
    const flight = this.registerLifecycleOperation("stop", profileId, sourceServerId);
    const { controller } = flight;
    // 清掉上一次停止失败留在这条连接上的原因；整个停止过程设备保持未连接。
    this.setState(profileId, { state: "offline", sourceServerId });
    try {
      await this.operationLogs.run(
        "stop",
        route.profile,
        route.target,
        { signal: controller.signal },
        async (context) => {
          const status = readServerCommandResult(
            await this.getAdapter(route.profile.transport).exec(
              route.target,
              ["stop", "--wait", "--json"],
              context,
            ),
            "Remote service failed to stop",
          );
          // 不支持 --wait 的旧远端只回 ack；只有最终 stopped 才能报告“已停止”。
          if (status.state !== "stopped" && status.state !== "uninstalled") {
            throw new Error("Remote service did not confirm that it stopped");
          }
          return { sourceServerId, profileId };
        },
      );
      controller.signal.throwIfAborted();
    } catch (error) {
      // 断开、移除或释放已经发布了终态；被中止的停止不能写回状态。
      controller.signal.throwIfAborted();
      // 设备保持未连接；失败原因留在这条连接的状态上，供失败详情分类展示。
      this.setState(profileId, {
        state: "offline",
        sourceServerId,
        ...describeLifecycleOperationFailure(error),
      });
      throw error;
    } finally {
      this.lifecycleOperationFlights.delete(flight);
      this.releaseTargetTransport(route.target);
    }
  }

  public disconnect(sourceServerId: string): void {
    const droppedTarget = this.disconnectSource(sourceServerId);
    if (droppedTarget) this.releaseTargetTransport(droppedTarget);
  }

  public removeProfile(profileId: string): void {
    this.operationLogs.removeProfile(profileId);
    // 记下被取消的预期断线操作及其类型，收尾时直接按类型判断它留在恢复 owner 上的投影。
    const canceledExpectedDisconnects = new Map<string, ExpectedDisconnectOperationKind>();
    for (const flight of this.lifecycleOperationFlights) {
      if (flight.profileId !== profileId) continue;
      if (flight.sourceServerId && flight.kind !== "stop") {
        canceledExpectedDisconnects.set(flight.sourceServerId, flight.kind);
      }
      this.lifecycleOperationFlights.delete(flight);
      flight.controller.abort(new SourceServerProfileRemovedError(profileId));
    }
    const connectingSourceServerId = this.connectFlights.get(profileId)?.sourceServerId;
    const sourceOwnedOnlyByConnectingProfile =
      connectingSourceServerId &&
      !this.reconnectInputs.has(connectingSourceServerId) &&
      !this.onlineBySourceServerId.has(connectingSourceServerId)
        ? connectingSourceServerId
        : undefined;
    const currentSourceServerId =
      [...this.reconnectInputs].find(([, input]) => input.profile.profileId === profileId)?.[0] ??
      [...this.onlineBySourceServerId].find(([, online]) => online.profileId === profileId)?.[0] ??
      sourceOwnedOnlyByConnectingProfile;
    if (currentSourceServerId) {
      // Bug 原因：Directory 删除当前线路后，旧实现只删展示状态，恢复 owner、timer 和
      // 已解析的 secret 仍存活，断线后会继续使用已删除线路。删除当前线路等价于显式
      // 断开整个 Source；其他线路只能由用户后续手动选择，不能在这里静默接管。
      const droppedTarget = this.disconnectSource(currentSourceServerId, profileId);
      if (droppedTarget) this.releaseTargetTransport(droppedTarget);
      return;
    }

    const flight = this.connectFlights.get(profileId);
    if (flight) {
      this.connectFlights.delete(profileId);
      flight.controller.abort(new SourceServerProfileRemovedError(profileId));
    }
    for (const online of this.onlineBySourceServerId.values()) {
      online.profileIds.delete(profileId);
    }
    this.states.delete(profileId);
    this.compatibilityByProfileId.delete(profileId);
    for (const [sourceServerId, profileIds] of this.profileIdsBySourceServerId) {
      if (!profileIds.delete(profileId)) continue;
      if (profileIds.size === 0) this.profileIdsBySourceServerId.delete(sourceServerId);
    }
    // Bug 原因：非当前线路的更新或重启可能已移除旧物理连接；取消后跳过操作收尾，原 owner
    // 会永久停在该操作的投影（更新为 updating，重启为 bootstrapping）。删除操作接回仍保留的
    // 恢复意图，不依赖已取消操作的迟到结果。投影按被取消 flight 的类型判断，不从状态反推。
    for (const [sourceServerId, kind] of canceledExpectedDisconnects) {
      const input = this.reconnectInputs.get(sourceServerId);
      if (
        input &&
        !this.onlineBySourceServerId.has(sourceServerId) &&
        this.getStateByProfile(input.profile.profileId).state ===
          expectedDisconnectProjection(kind) &&
        // owner 自己已有在途连接时由该连接收口，不能再排重试。
        !this.connectFlights.has(input.profile.profileId) &&
        !this.expectedDisconnectOperation(sourceServerId)
      )
        this.scheduleOnlineRetry(sourceServerId, 0);
    }
  }

  /**
   * 显式断开收口。返回被删除的恢复意图 target：它的 transport 会话由调用方释放（停止要先用它执行远端命令）。
   */
  private disconnectSource(
    sourceServerId: string,
    removedProfileId?: string,
  ): Exclude<RemoteTarget, { kind: "server" }> | undefined {
    const online = this.onlineBySourceServerId.get(sourceServerId);
    const reconnectInput = this.reconnectInputs.get(sourceServerId);
    const profileIds = new Set(this.profileIdsBySourceServerId.get(sourceServerId) ?? []);
    for (const profileId of online?.profileIds ?? []) profileIds.add(profileId);
    if (reconnectInput) profileIds.add(reconnectInput.profile.profileId);
    for (const flight of this.lifecycleOperationFlights) {
      if (flight.sourceServerId !== sourceServerId) continue;
      this.lifecycleOperationFlights.delete(flight);
      flight.controller.abort(new SourceServerExplicitDisconnectError(sourceServerId));
      profileIds.add(flight.profileId);
    }

    // Bug 原因：意外断线会先摘除 online owner；显式断开若再用 online 是否存在判断生命周期，
    // 就只会清掉 timer 而永久遗留 retrying。必须在删除恢复索引前捕获 Source 的全部 Profile，
    // 中止仍在执行的 Source flight，并且无论当前是否还有物理连接都发布 offline 终态；否则
    // 已进入 bootstrapping 的迟到成功还会覆盖用户刚刚提交的 offline 意图。
    this.clearRecoveryTimers(sourceServerId);
    for (const [profileId, flight] of this.connectFlights) {
      if (flight.sourceServerId !== sourceServerId) continue;
      if (this.connectFlights.get(profileId) === flight) {
        this.connectFlights.delete(profileId);
      }
      flight.controller.abort(
        profileId === removedProfileId
          ? new SourceServerProfileRemovedError(profileId)
          : new SourceServerExplicitDisconnectError(sourceServerId),
      );
      profileIds.add(profileId);
    }
    if (removedProfileId) profileIds.delete(removedProfileId);
    this.reconnectInputs.delete(sourceServerId);
    this.profileIdsBySourceServerId.delete(sourceServerId);
    if (online) this.onlineBySourceServerId.delete(sourceServerId);
    if (removedProfileId) {
      this.connectionInvalidatedEmitter.fire({
        sourceServerId,
        reason: "profile-removed",
        recoverable: false,
      });
    }
    online?.projectSubscription?.dispose();
    online?.connection.dispose();
    for (const profileId of profileIds) {
      this.setState(profileId, { state: "offline", sourceServerId });
    }
    if (removedProfileId) {
      this.states.delete(removedProfileId);
      this.compatibilityByProfileId.delete(removedProfileId);
    }
    return reconnectInput?.target;
  }

  public dispose(): void {
    const reason = Object.assign(new Error("Source Server manager disposed"), {
      code: "remote-connection-canceled",
    });
    for (const flight of this.lifecycleOperationFlights) flight.controller.abort(reason);
    this.lifecycleOperationFlights.clear();
    // 更新的重握手可能尚无 online owner，不能只遍历 online 表来回收在途连接。
    for (const flight of this.connectFlights.values()) flight.controller.abort(reason);
    this.connectFlights.clear();
    for (const sourceServerId of this.retryTimers.keys()) this.clearRecoveryTimers(sourceServerId);
    for (const sourceServerId of this.offlineProbeTimers.keys())
      this.clearRecoveryTimers(sourceServerId);
    // 离线恢复也持有连接意图；只清 online 会让被中止 flight 的迟到 catch 重新排重试。
    for (const sourceServerId of new Set([
      ...this.reconnectInputs.keys(),
      ...this.onlineBySourceServerId.keys(),
    ])) {
      this.disconnect(sourceServerId);
    }
    for (const adapter of this.adapters.values()) adapter.dispose?.();
    this.adapters.clear();
    this.stateEmitter.dispose();
    this.reconnectEmitter.dispose();
    this.connectionInvalidatedEmitter.dispose();
    this.operationLogs.dispose();
  }

  private async connectOnce(
    options: ConnectSourceServerOptions,
    explicitDisconnectSignal?: AbortSignal,
  ): Promise<ManagedSourceServerConnection> {
    const { profile, target } = options;
    if (target.kind === "server" || profile.transport !== target.kind) {
      throw new Error(
        `Connection Profile ${profile.profileId} transport does not match target ${target.kind}`,
      );
    }
    const signal = options.context?.signal;
    let unpublishedConnection: ServerRemoteConnection | undefined;
    const throwIfAborted = () => {
      explicitDisconnectSignal?.throwIfAborted();
      signal?.throwIfAborted();
    };
    throwIfAborted();
    let commitMembership: ((sourceServerId: string) => Promise<void>) | undefined;
    if (this.options.admitConnection) {
      try {
        commitMembership = await this.options.admitConnection({
          profile,
          intent: options.membershipIntent ?? "retain",
          confirmIdentityChange: options.confirmIdentityChange === true,
        });
      } catch (error) {
        // 线路已移除时，迟到 admission 错误不再有权重建 failed 展示行。
        throwIfAborted();
        this.setState(profile.profileId, {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
          retryable: false,
        });
        throw error;
      }
    }
    throwIfAborted();
    if (profile.sourceServerId) {
      const existing = this.onlineBySourceServerId.get(profile.sourceServerId);
      if (existing) {
        await commitMembership?.(profile.sourceServerId);
        // 复用也经过异步成员提交；这段等待可能已被用户断开，不能返回旧 socket。
        throwIfAborted();
        if (this.onlineBySourceServerId.get(profile.sourceServerId) !== existing)
          throw new Error("Source Server connection changed during admission");
        existing.profileIds.add(profile.profileId);
        this.rememberSourceProfiles(profile.sourceServerId, existing.profileIds);
        this.setState(profile.profileId, {
          state: "online",
          sourceServerId: profile.sourceServerId,
        });
        return this.reusedConnection(existing);
      }
    }
    this.setState(profile.profileId, { state: "bootstrapping" });
    const adapter = this.getAdapter(profile.transport);
    let targetTransportCancelled = false;
    const cancelTargetTransport = () => {
      if (targetTransportCancelled) return;
      targetTransportCancelled = true;
      adapter.cancel?.(target);
    };
    if (signal?.aborted || explicitDisconnectSignal?.aborted) {
      cancelTargetTransport();
      throwIfAborted();
    }
    signal?.addEventListener("abort", cancelTargetTransport, { once: true });
    explicitDisconnectSignal?.addEventListener("abort", cancelTargetTransport, { once: true });
    let ignoreConnectionClose = false;
    try {
      options.onDiagnosticPhase?.("probe");
      const shouldRefreshDevelopmentArtifact =
        this.options.sourceServerArtifactPolicy === "development-content-addressed" &&
        target.kind === "ssh";
      const probe = await adapter.probe(
        target,
        options.context ?? {},
        shouldRefreshDevelopmentArtifact ? { includeReleaseIdentity: true } : undefined,
      );
      throwIfAborted();
      if (probe.installed) {
        const installedVersion = probe.installedVersion?.trim() || "unknown";
        let compatibleInstalledVersion = false;
        try {
          compatibleInstalledVersion =
            compareCompatibilityVersions(
              installedVersion,
              this.compatibilityManifest.minCompatibleVersion,
            ) >= 0;
        } catch {
          // Bug 原因：pre-R3 或损坏安装可能返回空值/unknown。继续执行新版本 ensureDaemon
          // 只会在 ingress-token 合同处变成通用 failed，用户也失去升级入口。
          compatibleInstalledVersion = false;
        }
        if (!compatibleInstalledVersion) {
          this.setState(profile.profileId, {
            state: "needs-upgrade",
            updateAvailability: "required",
            currentVersion: installedVersion,
            availableVersion: this.compatibilityManifest.productVersion,
            minimumVersion: this.compatibilityManifest.minCompatibleVersion,
            upgradeTarget: "server",
            // 远端由旧版 Desktop 显式切回时，向导必须等用户确认再升级，不能自动覆盖对方的选择。
            ...(probe.downgradedFrom ? { downgradedFrom: probe.downgradedFrom } : {}),
            errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
            retryable: false,
          });
          throw new SourceServerUpgradeRequiredError(
            profile.profileId,
            "server",
            installedVersion,
            this.compatibilityManifest.minCompatibleVersion,
          );
        }
        if (
          shouldRefreshDevelopmentArtifact &&
          installedVersion === this.compatibilityManifest.productVersion
        ) {
          const releaseResolver = options.resolveRelease ?? this.options.resolveRelease;
          if (!releaseResolver) {
            throw new Error("Development Source Server release is unavailable");
          }
          const release = await releaseResolver(probe, target);
          throwIfAborted();
          if (
            release.version === installedVersion &&
            release.sha256.toLowerCase() !== probe.installedArchiveSha256?.toLowerCase()
          ) {
            // Bug 原因（R3A-B-06）：开发态同版本刷新过去在这里直接 installOrUpdate，绕开了
            // updateServer 的 updating 状态、操作日志和 force 守卫确认；远端有运行中任务时 guard
            // 只能表现为普通连接失败，UI 既没有“强制更新”入口也不会在任务结束后重试。
            // 开发态与生产态只在“是否需要更新”的判定上不同（SHA vs 版本兼容），判定之后必须
            // 走同一条 needs-upgrade → updateSource/updateServer 链路，连接流程本身不执行更新。
            this.setState(profile.profileId, {
              state: "needs-upgrade",
              updateAvailability: "required",
              currentVersion: installedVersion,
              availableVersion: release.version,
              minimumVersion: this.compatibilityManifest.minCompatibleVersion,
              upgradeTarget: "server",
              errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
              retryable: false,
            });
            throw new SourceServerUpgradeRequiredError(
              profile.profileId,
              "server",
              installedVersion,
              this.compatibilityManifest.minCompatibleVersion,
              "development-archive",
            );
          }
        }
      }
      if (!probe.installed) {
        if (profile.sourceServerId) {
          await this.options.directory.markSourceUninstalled?.(profile.profileId);
          throwIfAborted();
        }
        const releaseResolver = options.resolveRelease ?? this.options.resolveRelease;
        // 首次安装同样在本机下载 archive：「取消连接」与显式断开要立即中止下载，并写下载进度（R3 §6.3）。
        const releaseSignals = [signal, explicitDisconnectSignal].filter(
          (item): item is AbortSignal => item !== undefined,
        );
        const release =
          options.release ??
          (options.allowInstall && releaseResolver
            ? await releaseResolver(probe, target, {
                signal: AbortSignal.any(releaseSignals),
                onLog: options.context?.onLog,
              })
            : undefined);
        throwIfAborted();
        if (!release) {
          // 预览是附加信息；CDN/缓存元数据不可用时仍保留安装等待点。实际安装解析继续严格失败。
          const previewRelease = releaseResolver
            ? await releaseResolver(probe, target, { metadataOnly: true }).catch(() => undefined)
            : undefined;
          throwIfAborted();
          this.setState(profile.profileId, {
            ...(previewRelease
              ? {
                  installPreview: {
                    version: previewRelease.version,
                    sizeBytes: previewRelease.sizeBytes,
                    ...(probe.installPath ? { installPath: probe.installPath } : {}),
                  },
                }
              : {}),
            state: "needs-install",
            ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
            errorCode: SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
            retryable: false,
          });
          throw new SourceServerInstallRequiredError(profile.profileId);
        }
        await adapter.installOrUpdate(target, release, options.context ?? {});
        throwIfAborted();
      }
      options.onDiagnosticPhase?.("daemon");
      const ingress = await adapter.ensureDaemon(target, options.context ?? {}, {
        observedStatus: probe.daemonStatus,
      });
      throwIfAborted();
      let published: { sourceServerId: string; connection: ServerRemoteConnection } | undefined;
      let closedBeforePublish: string | undefined;
      // 只认当前这次握手的关闭事件：失败握手的连接迟到关闭，不能计入回退后的握手。
      let liveHandshake: object | undefined;
      const onHandshakeClose = (attempt: object, reason: string) => {
        if (ignoreConnectionClose || liveHandshake !== attempt) return;
        // Bug 原因（RV-P1-1）：close 事件过去只按 sourceServerId 路由，并用在线表是否存在做守卫。
        // 握手落盘（recordHandshake）期间连接关闭时，在线表要么为空（事件被丢弃，随后把已关闭的
        // 连接发布为 online），要么指向同一 Source 上另一条健康连接（sibling 的关闭会拆掉在线
        // owner 并清掉它的重试）。发布前只记录关闭事实，由发布点按连接失败收口；发布后才处理，
        // 且必须带上本连接身份，close 只作用于它所属的那条连接。
        if (!published) {
          closedBeforePublish = reason || "connection closed";
          return;
        }
        this.handleUnexpectedClose(published.sourceServerId, reason, published.connection);
      };
      const handshake = async (daemon: SourceServerIngressInfo) => {
        const attempt = {};
        liveHandshake = attempt;
        // Bug 原因：ws 在 upgrade 失败时同一 tick 先发 error 再发 close，关闭回调早于下面的 catch，
        // liveHandshake 挡不住它；上一次握手留下的关闭记录会让回退后健康的连接在发布点被判为已关闭。
        // 关闭记录只属于当前这次握手，开始时清空。
        closedBeforePublish = undefined;
        try {
          return await this.connectServer({
            ingressToken: daemon.ingressToken,
            createConnection: async () =>
              await adapter.openChannel(target, daemon, options.context ?? {}),
            onClose: ({ reason }) => onHandshakeClose(attempt, reason),
          });
        } catch (error) {
          liveHandshake = undefined;
          throw error;
        }
      };
      options.onDiagnosticPhase?.("protocol-handshake");
      let connection: ServerRemoteConnection;
      try {
        connection = await handshake(ingress);
      } catch (error) {
        throwIfAborted();
        if (!ingress.reusedProbeStatus) throw error;
        // Bug 原因：probe 只凭 status.json 为 ready 且 Core PID 能 kill -0 就复用端口。远端重启后快照残留，
        // PID 被同用户的其他进程复用，端口已无人监听，握手报 socket hang up，且一直不去拉起 daemon。
        // 快照只是省一次 serve --daemon 的优化；握手失败时回退一次，由 serve --daemon 经 control
        // 读取 Supervisor 的实时状态，必要时接管残留锁并重新拉起。
        this.options.logWarn?.(
          "reused Source Server did not answer the handshake; running serve --daemon",
          error instanceof Error ? error : new Error(String(error)),
        );
        options.context?.onLog?.({
          phase: "daemon",
          message: "Reused Source Server did not respond; checking it with serve --daemon",
        });
        options.onDiagnosticPhase?.("daemon");
        const restarted = await adapter.ensureDaemon(target, options.context ?? {});
        throwIfAborted();
        options.onDiagnosticPhase?.("protocol-handshake");
        connection = await handshake(restarted);
      }
      unpublishedConnection = connection;
      throwIfAborted();
      const compatibility = connection.serverInfo.compatibility;
      if (!compatibility) {
        this.setState(profile.profileId, {
          state: "needs-upgrade",
          updateAvailability: "required",
          currentVersion: connection.serverInfo.version,
          availableVersion: this.compatibilityManifest.productVersion,
          minimumVersion: this.compatibilityManifest.minCompatibleVersion,
          upgradeTarget: "server",
          errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
          retryable: false,
        });
        throw new SourceServerUpgradeRequiredError(
          profile.profileId,
          "server",
          connection.serverInfo.version,
          this.compatibilityManifest.minCompatibleVersion,
        );
      }
      const compatibilityResult = evaluateSourceServerCompatibility(
        this.compatibilityManifest,
        compatibility,
      );
      const compatibilityState = buildCompatibilityState(this.compatibilityManifest, compatibility);
      if (!compatibilityResult.compatible && compatibilityResult.upgradeTarget) {
        this.setState(profile.profileId, {
          state: "needs-upgrade",
          ...compatibilityState,
          errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
          retryable: false,
        });
        throw new SourceServerUpgradeRequiredError(
          profile.profileId,
          compatibilityResult.upgradeTarget,
          compatibilityResult.olderVersion,
          compatibilityResult.requiredMinimumVersion,
        );
      }
      const sourceServerId = connection.serverInfo.serverId;
      const connectedAt = this.now();
      options.onDiagnosticPhase?.("directory-record");
      const handshakeResult = await this.options.directory.recordHandshake(
        profile.profileId,
        {
          sourceServerId,
          osUser: connection.serverInfo.identity?.osUser,
          hostname: connection.serverInfo.identity?.hostname,
          version:
            connection.serverInfo.compatibility?.productVersion ?? connection.serverInfo.version,
          connectedAt,
          workspaces: connection.serverInfo.workspaces,
        },
        ...(options.confirmIdentityChange ? [{ confirmIdentityChange: true }] : []),
      );
      throwIfAborted();
      if (handshakeResult.identityChanged && options.confirmIdentityChange !== true) {
        this.setState(profile.profileId, {
          state: "identity-change-pending",
          sourceServerId: profile.sourceServerId,
          pendingSourceServerId: sourceServerId,
          errorCode: SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
          retryable: false,
        });
        throw new SourceServerIdentityChangePendingError(profile.profileId, sourceServerId);
      }
      const effectiveProfile = handshakeResult.effectiveProfile ?? profile;
      // 关闭发生于目录落盘时不能再提交成员；健康 sibling owner 可继续承接本次 admission。
      if (closedBeforePublish !== undefined && !this.onlineBySourceServerId.has(sourceServerId))
        throw new SourceServerHandshakeClosedError(closedBeforePublish);
      await commitMembership?.(sourceServerId);
      throwIfAborted();
      options.onDiagnosticPhase?.("publish-online");
      if (effectiveProfile.profileId !== profile.profileId) {
        this.setState(profile.profileId, {
          state: "offline",
          ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
        });
      }

      const existing = this.onlineBySourceServerId.get(sourceServerId);
      if (existing) {
        existing.profileIds.add(effectiveProfile.profileId);
        this.rememberSourceProfiles(sourceServerId, existing.profileIds);
        this.setState(effectiveProfile.profileId, {
          state: "online",
          sourceServerId,
          ...compatibilityState,
        });
        return this.reusedConnection(existing);
      }
      if (closedBeforePublish !== undefined) {
        // 握手期间连接已死：不能发布，按普通连接失败抛出，让手动连接显示可重试失败、
        // 自动恢复路径继续下一档重试。放在 sibling join 之后：owner 健康时 join 才是正确结果。
        throw new SourceServerHandshakeClosedError(closedBeforePublish);
      }
      const managed: OnlineConnection = {
        sourceServerId,
        profileId: effectiveProfile.profileId,
        serverInfo: connection.serverInfo,
        services: connection.services,
        connection,
        profileIds: new Set([effectiveProfile.profileId]),
      };
      if (this.options.onProjectChange) {
        managed.projectSubscription = connection.services.broadcastService.onMessage((event) => {
          // 换代/断开后迟到广播不能代表当前 Source；通知仅触发读取，不带项目数据。
          if (
            event.channel === "state:projects" &&
            this.onlineBySourceServerId.get(sourceServerId) === managed
          )
            this.options.onProjectChange?.(sourceServerId);
        });
      }
      // Bug 原因：onDidReconnect 过去只挂在 retry/probe timer 回调和 updateServer 上；
      // retrying/offline 期间由 connect()（connectProfile / confirmIdentityChange）手动连接成功，
      // Manager 会清掉待触发的 retry timer 并发布 online，却不发 reconnect。Host wrapper 只在
      // reconnect 时换 services，Registry entry 的 recoveryReady 因此无人 resolve，同 route 新
      // connect 永久等待。reconnectInputs 只在首次发布时写入、显式断开时删除，「再次发布同一
      // Source」就是唯一的重连事实源：无论谁触发的连接，非在线 -> 在线都在这里统一 fire。
      const isRepublish = this.reconnectInputs.has(sourceServerId);
      const replacedTarget = this.reconnectInputs.get(sourceServerId)?.target;
      this.onlineBySourceServerId.set(sourceServerId, managed);
      published = { sourceServerId, connection };
      unpublishedConnection = undefined;
      this.rememberSourceProfiles(sourceServerId, managed.profileIds);
      this.clearRecoveryTimers(sourceServerId);
      this.reconnectInputs.set(sourceServerId, {
        profile: effectiveProfile,
        target,
        // 操作级 onLog 捕获本次日志及凭据；恢复不得持有旧闭包，下一次操作会重新建日志上下文。
        context: {},
      });
      // Bug 原因：更新、身份确认等用新 target 重新发布时，旧 target 的会话不再有 owner，过去一直留到
      // Host 退出，每次更新都多留一条到设备的空闲 SSH 连接。恢复意图换 target 时释放旧会话。
      if (replacedTarget) this.releaseTargetTransport(replacedTarget);
      this.setState(effectiveProfile.profileId, {
        state: "online",
        sourceServerId,
        ...compatibilityState,
      });
      if (isRepublish) this.reconnectEmitter.fire(managed);
      return managed;
    } catch (error) {
      if (
        error instanceof SourceServerUpgradeRequiredError &&
        !signal?.aborted &&
        !explicitDisconnectSignal?.aborted
      ) {
        await options.onAuthenticatedUpgradeRequired?.();
      }
      if (explicitDisconnectSignal?.aborted) {
        throw explicitDisconnectSignal.reason;
      }
      if (
        error instanceof SourceServerInstallRequiredError ||
        error instanceof SourceServerUpgradeRequiredError ||
        error instanceof SourceServerIdentityChangePendingError
      )
        throw error;
      const normalized = normalizeRemoteConnectionError(error);
      const errorCode = isPublicZCodeErrorCode(normalized.code) ? normalized.code : undefined;
      const retryable =
        error && typeof error === "object" && "retryable" in error
          ? (error as { retryable?: unknown }).retryable
          : undefined;
      this.setState(profile.profileId, {
        state: "failed",
        error: normalized.message,
        ...(errorCode ? { errorCode } : {}),
        ...(typeof retryable === "boolean" ? { retryable } : {}),
      });
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancelTargetTransport);
      explicitDisconnectSignal?.removeEventListener("abort", cancelTargetTransport);
      // Bug 原因：分支内释放遗漏了握手落盘拒绝和兼容版本解析异常，恢复重试会累积连接。
      // 握手、目录写入、身份确认、成员提交共用这一个未发布资源出口；在线表接管前始终由本次
      // 尝试持有连接，统一释放并忽略其关闭事件，避免影响后继 owner。
      if (unpublishedConnection) {
        ignoreConnectionClose = true;
        unpublishedConnection.dispose();
      }
    }
  }

  private getAdapter(kind: "ssh" | "wsl" | "docker"): SourceServerTransportAdapter {
    let adapter = this.adapters.get(kind);
    if (!adapter) {
      adapter = this.createAdapter(kind);
      this.adapters.set(kind, adapter);
    }
    return adapter;
  }

  /**
   * 释放 target 的 transport 会话（SSH 连接、WSL 子进程等，含其中的凭据）。恢复意图仍持有同一 target 时保留，
   * 供重试、离线探测和设备操作复用。
   *
   * Bug 原因：Adapter 按 target 对象缓存会话，只在连接中止或 Host 释放时关闭；显式断开、停止、恢复意图换 target
   * 以及一次性操作结束后都没有释放，停止远端服务后本机仍连着设备。target 的持有者结束时统一经这里释放。
   */
  private releaseTargetTransport(target: RemoteTarget): void {
    for (const input of this.reconnectInputs.values()) {
      if (input.target === target) return;
    }
    this.adapters.get(target.kind)?.cancel?.(target);
  }

  private handleUnexpectedClose(
    sourceServerId: string,
    reason: string,
    connection: ServerRemoteConnection,
  ): void {
    const online = this.onlineBySourceServerId.get(sourceServerId);
    // 只处理属于当前 online owner 的关闭；已被替换或从未发布的连接迟到的 close 不得拆掉后继者。
    if (!online || online.connection !== connection) return;
    // 生命周期操作会让远端主动断线：只做连接失效，不摘恢复意图、不排重试。
    const expectedDisconnect = this.expectedDisconnectOperation(sourceServerId);
    if (expectedDisconnect) {
      this.invalidateOnlineConnectionForLifecycleOperation(
        sourceServerId,
        online,
        expectedDisconnect,
      );
      return;
    }
    this.onlineBySourceServerId.delete(sourceServerId);
    // Bug 原因：意外断线后旧 RPC generation 只从在线表移除，却没有显式释放 protocol/socket；
    // 多次重连会让旧 generation 的 pending 状态依赖 GC。先摘 owner 再 dispose，重复 close 回调会
    // 因 online 表已无该 Source 而幂等返回。
    online.projectSubscription?.dispose();
    online.connection.dispose();
    for (const profileId of online.profileIds) {
      this.setState(profileId, {
        state: "retrying",
        sourceServerId,
        ...(reason ? { error: reason } : {}),
        recoveryAttempt: 1,
        recoveryLimit: ONLINE_RETRY_DELAYS_MS.length,
      });
    }
    this.scheduleOnlineRetry(sourceServerId, 0);
  }

  /**
   * 让在线连接关闭成为“预期断线”的操作（更新或重启；按互斥矩阵二者不会并存）。停止在执行远端命令前
   * 已删除恢复意图并释放连接，其间用户另行建立的新连接按普通断线恢复，不能被当成换代吞掉。
   */
  private expectedDisconnectOperation(
    sourceServerId: string,
  ): ExpectedDisconnectOperationKind | undefined {
    for (const flight of this.lifecycleOperationFlights) {
      if (flight.sourceServerId === sourceServerId && flight.kind !== "stop") return flight.kind;
    }
    return undefined;
  }

  /**
   * 同 Source 互斥：停止、重启与任何操作互斥；多个更新经 sibling Profile 并存保持现状。
   * 同一 Profile 只允许一个更新，由 updateServer 按 profileId 另行检查（尚无 sourceServerId 的线路也适用）。
   */
  private assertLifecycleOperationCanStart(
    sourceServerId: string,
    kind: LifecycleOperationKind,
  ): void {
    const conflict = [...this.lifecycleOperationFlights].some(
      (flight) =>
        flight.sourceServerId === sourceServerId && (kind !== "update" || flight.kind !== "update"),
    );
    if (conflict) {
      throw new SourceServerLifecycleOperationInProgressError(`Source Server ${sourceServerId}`);
    }
  }

  /**
   * 登记生命周期操作 flight 的唯一入口。调用方须先完成互斥检查（让出执行权后要复查），并在写操作
   * 日志前登记；flight 由同一调用方在操作日志结束后摘除。
   */
  private registerLifecycleOperation(
    kind: LifecycleOperationKind,
    profileId: string,
    sourceServerId: string | undefined,
  ): LifecycleOperationFlight {
    const flight: LifecycleOperationFlight = {
      kind,
      profileId,
      sourceServerId,
      controller: new AbortController(),
    };
    this.lifecycleOperationFlights.add(flight);
    return flight;
  }

  private invalidateOnlineConnectionForLifecycleOperation(
    sourceServerId: string,
    online: OnlineConnection,
    operation: ExpectedDisconnectOperationKind,
  ): void {
    if (this.onlineBySourceServerId.get(sourceServerId) !== online) return;
    // Bug 原因：显式更新过去只替换 Manager 内的物理连接，没有先失效仍指向旧 services 的
    // logical workspace；更新成功后 UI 会看到 online，但 scoped RPC 仍命中已关闭 generation。
    // 先摘物理 owner 并发布一次 Source 级失效，再释放连接，Registry 才能 fail-closed 后换代。
    this.onlineBySourceServerId.delete(sourceServerId);
    for (const profileId of online.profileIds) {
      this.setState(profileId, { state: expectedDisconnectProjection(operation), sourceServerId });
    }
    this.connectionInvalidatedEmitter.fire({ sourceServerId, reason: operation });
    online.projectSubscription?.dispose();
    online.connection.dispose();
  }

  private scheduleOnlineRetry(sourceServerId: string, attempt: number): void {
    const input = this.reconnectInputs.get(sourceServerId);
    const delay = ONLINE_RETRY_DELAYS_MS[attempt];
    if (!input || delay === undefined) {
      this.enterOfflineProbe(sourceServerId);
      return;
    }
    const existing = this.retryTimers.get(sourceServerId);
    if (existing) clearTimeout(existing);
    for (const profileId of this.profileIdsForSource(sourceServerId, input.profile.profileId)) {
      this.setState(profileId, {
        state: "retrying",
        sourceServerId,
        recoveryAttempt: attempt + 1,
        recoveryLimit: ONLINE_RETRY_DELAYS_MS.length,
      });
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(sourceServerId);
      void this.connectForSource(
        {
          profile: input.profile,
          target: input.target,
          context: input.context,
        },
        sourceServerId,
      ).catch((error) => {
        if (
          error instanceof SourceServerExplicitDisconnectError ||
          error instanceof SourceServerProfileRemovedError ||
          this.stopAutomaticRecoveryForTerminalFailure(sourceServerId, error)
        ) {
          return;
        }
        if (attempt + 1 < ONLINE_RETRY_DELAYS_MS.length) {
          this.scheduleOnlineRetry(sourceServerId, attempt + 1);
        } else {
          this.enterOfflineProbe(sourceServerId, error);
        }
      });
    }, delay);
    this.retryTimers.set(sourceServerId, timer);
  }

  private enterOfflineProbe(sourceServerId: string, error?: unknown): void {
    const input = this.reconnectInputs.get(sourceServerId);
    if (!input) return;
    const normalized = error === undefined ? undefined : normalizeRemoteConnectionError(error);
    if (normalized) {
      // Bug 原因：预算耗尽后的最终 cause 只留在 state.error，而 UI 按合同不展示裸 Host
      // 原文，导致诊断信息无稳定出口。终态每轮只记一条 warn，不按探测心跳刷盘。
      this.options.logWarn?.(
        `[source-server] recovery budget exhausted source=${sourceServerId}`,
        error instanceof Error ? error : new Error(normalized.message),
      );
    }
    const errorCode =
      normalized?.code &&
      normalized.code !== "remote-connection-unknown" &&
      isPublicZCodeErrorCode(normalized.code)
        ? normalized.code
        : REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE;
    for (const profileId of this.profileIdsForSource(sourceServerId, input.profile.profileId)) {
      this.setState(profileId, {
        state: "offline",
        sourceServerId,
        recoveryAttempt: ONLINE_RETRY_DELAYS_MS.length,
        recoveryLimit: ONLINE_RETRY_DELAYS_MS.length,
        recoveryBudgetExhausted: true,
        retryable: true,
        ...(normalized ? { error: normalized.message } : {}),
        ...(errorCode ? { errorCode } : {}),
      });
    }
    const existing = this.offlineProbeTimers.get(sourceServerId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.offlineProbeTimers.delete(sourceServerId);
      void this.connectForSource(
        {
          profile: input.profile,
          target: input.target,
          context: input.context,
        },
        sourceServerId,
      ).catch((error) => {
        if (
          error instanceof SourceServerExplicitDisconnectError ||
          error instanceof SourceServerProfileRemovedError ||
          this.stopAutomaticRecoveryForTerminalFailure(sourceServerId, error)
        ) {
          return;
        }
        this.enterOfflineProbe(sourceServerId, error);
      });
    }, OFFLINE_PROBE_INTERVAL_MS);
    this.offlineProbeTimers.set(sourceServerId, timer);
  }

  private stopAutomaticRecoveryForTerminalFailure(sourceServerId: string, error: unknown): boolean {
    const input = this.reconnectInputs.get(sourceServerId);
    const ownerState = input ? this.states.get(input.profile.profileId) : undefined;
    const normalized = normalizeRemoteConnectionError(error);
    if (
      readErrorRetryable(error) !== false &&
      !isAutomaticRecoveryUserActionCode(normalized.code) &&
      !isSourceServerAutomaticRecoveryTerminalState(ownerState)
    ) {
      return false;
    }
    // Bug 原因：旧恢复调度只识别 UpgradeRequired，其他用户动作和 retryable:false
    // 会被下一次 retry/offline probe 覆盖。终态必须在创建后续 timer 前截断自动路径。
    this.clearRecoveryTimers(sourceServerId);
    if (input && !isSourceServerAutomaticRecoveryTerminalState(ownerState)) {
      this.setState(input.profile.profileId, {
        state: "failed",
        sourceServerId,
        ...this.compatibilityByProfileId.get(input.profile.profileId),
        error: normalized.message,
        ...(isPublicZCodeErrorCode(normalized.code) ? { errorCode: normalized.code } : {}),
        retryable: false,
      });
    }
    if (input) {
      for (const profileId of this.profileIdsForSource(sourceServerId, input.profile.profileId)) {
        if (profileId === input.profile.profileId) continue;
        // Bug 原因：Source 级恢复停止后，sibling Profile 若遗留 retrying，聚合状态仍会显示
        // 连接中且其 logical wrapper 不会收到终态。只有真实 owner 保留可操作 pending 状态。
        this.setState(profileId, {
          state: "offline",
          sourceServerId,
          error: normalized.message,
          ...(isPublicZCodeErrorCode(normalized.code) ? { errorCode: normalized.code } : {}),
          retryable: false,
        });
      }
    }
    return true;
  }

  private profileIdsForSource(sourceServerId: string, fallbackProfileId: string): string[] {
    const remembered = this.profileIdsBySourceServerId.get(sourceServerId);
    return remembered && remembered.size > 0 ? [...remembered] : [fallbackProfileId];
  }

  private rememberSourceProfiles(sourceServerId: string, profileIds: Iterable<string>): void {
    const remembered = this.profileIdsBySourceServerId.get(sourceServerId) ?? new Set<string>();
    for (const profileId of profileIds) remembered.add(profileId);
    this.profileIdsBySourceServerId.set(sourceServerId, remembered);
  }

  private clearRecoveryTimers(sourceServerId: string): void {
    const retryTimer = this.retryTimers.get(sourceServerId);
    if (retryTimer) clearTimeout(retryTimer);
    this.retryTimers.delete(sourceServerId);
    const probeTimer = this.offlineProbeTimers.get(sourceServerId);
    if (probeTimer) clearTimeout(probeTimer);
    this.offlineProbeTimers.delete(sourceServerId);
  }

  private setState(
    profileId: string,
    patch: Omit<
      SourceServerConnectionStateSnapshot,
      "profileId" | "updatedAt" | "updateCancelable"
    >,
  ): void {
    const previous = this.states.get(profileId);
    const inheritedCompatibility =
      patch.state === "retrying" || patch.state === "offline" || patch.state === "updating"
        ? (this.compatibilityByProfileId.get(profileId) ??
          (previous ? preserveCompatibilityState(previous) : {}))
        : {};
    // Bug 原因（CR-02）：updateCancelable 曾只在更新开始时手写一次。本机下载期间旧在线连接关闭时，
    // 连接失效投影重新写 updating 且不带该字段，Host 仍可取消，快照却不再可取消。
    // 改为每次写 updating 时按更新 flight 推导：有处于本机阶段、尚未取消的更新才带上（R3 §6.3）。
    const updateCancelable =
      patch.state === "updating" &&
      [...this.lifecycleOperationFlights].some(
        (flight) =>
          flight.kind === "update" &&
          flight.profileId === profileId &&
          flight.localStageCancel?.signal.aborted === false,
      );
    const snapshot: SourceServerConnectionStateSnapshot = {
      profileId,
      // 恢复/离线/更新是连接生命周期状态，不会产生新的版本兼容事实；保留最后一次
      // Host 握手判定，避免 UI 在状态跃迁时丢失当前/可用/最低版本字段。
      ...inheritedCompatibility,
      ...patch,
      ...(updateCancelable ? { updateCancelable: true } : {}),
      updatedAt: this.now(),
    };
    if (snapshot.currentVersion || snapshot.updateAvailability) {
      this.compatibilityByProfileId.set(profileId, preserveCompatibilityState(snapshot));
    }
    this.states.set(profileId, snapshot);
    if (previous?.state === "online" && snapshot.state !== "online" && previous.sourceServerId) {
      // 最近在线是最后在线时刻，不是握手开始时间；失败重试不能把离线设备伪装成刚在线。
      void this.options.directory
        .recordLastOnline?.(previous.sourceServerId, snapshot.updatedAt)
        .catch((error: unknown) =>
          this.options.logWarn?.(
            "Failed to persist Source Server last online time",
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
    }
    this.stateEmitter.fire(snapshot);
  }
}
