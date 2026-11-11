import { sanitizeRemoteConnectionLog, remoteConnectionFailureLogLevel } from "@zcode/shared";
/* eslint-disable max-lines -- Main 的完整薄转发契约集中维护请求与端口关联。 */
import { randomUUID } from "node:crypto";
import { BrowserWindow, MessageChannelMain } from "electron";
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  buildRemoteWorkspaceIdentity,
  buildRemoteEnvironmentKey,
  buildSshRemoteHostKey,
  buildServerRemoteWorkspaceIdentity,
  HostMessageTypes,
  HostResponseTypes,
  hostResponseMessageSchema,
  InternalChannels,
  PlatformChannels,
  REMOTE_BIND_CANCELED_ERROR_CODE,
  REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS,
  resolveWorkspaceKey,
  scopedServicePortPayloadSchema,
  type BindRemoteWorkspaceSessionContextResult,
  type RemoteTarget,
  type ProviderProvisioningTrigger,
  type WindowHostRemoteWorkspaceDescriptor,
  type WorkspacePurpose,
  type WebRemoteControlFailure,
  type HostPreparedProjectWorkspace,
  type HostProjectWorkspaceNavigationInput,
} from "@zcode/shared";
import type {
  RemoteConnectionStats,
  RemoteDisconnectReason,
  RemoteGaugeTransition,
} from "./desktopRemoteUsageArmsTelemetry.js";
import type { RemoteAssetDirs } from "./desktopRuntimeEnv.js";
import {
  ProviderProvisioningEnvironmentCoordinator,
  ProviderProvisioningExecutionError,
} from "./providerProvisioningEnvironmentCoordinator.js";

interface RemoteWorkspaceSessionContext {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

interface RemoteWorkspaceConnectContext {
  workspacePath?: string;
  workspaceIdentity?: string;
  confirmSourceServerInstall?: boolean;
}

interface PendingConnect {
  requestId: string;
  webContentsId: number;
  win: BrowserWindow;
  remoteUsageTelemetryEligible: boolean;
  resolve: (sessionId: string) => void;
  onConnected?: (descriptor: WindowHostRemoteWorkspaceDescriptor) => void;
  reject: (error: Error) => void;
}

interface PendingWorkspaceBind {
  resolve: (previousWorkspaceIdentity?: string) => void;
  reject: (error: Error & { code?: string; retryable?: boolean }) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface WorkspaceContextBindFlight {
  contextKey: string;
  promise: Promise<BindRemoteWorkspaceSessionContextResult>;
}

interface RemoteAttachmentRoute {
  /** 手机创建的目录 scope 不自动建立桌面 tab；桌面显式 join 后才提升。 */
  mobileOnly?: boolean;
  providerProvisioningReady?: Promise<void>;
  webContentsId: number;
  // Main 只保留端口转发所需的 request/session 关联和脱敏 descriptor；连接/任务事实归 Host。
  descriptor: WindowHostRemoteWorkspaceDescriptor;
  rendererAttachmentId?: string;
  /** 首个 desktop attachment（含首次 Provisioning）的唯一结果；首连阶段的 join 等待它。 */
  initialAttachmentReady?: Promise<void>;
  pendingRendererAttachment?: {
    attachmentId: string;
    previousAttachmentId?: string;
    reason: string;
    ready: () => Promise<void>;
    timeout: NodeJS.Timeout;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  attachmentState: "attachable" | "closed";
  connectedAtMonotonicMs: number;
  connectFinalized: boolean;
  remoteUsageTelemetryEligible: boolean;
  providerProvisioningDispose?: () => void;
}

interface PendingProviderProvisioningExecution {
  readonly child: ElectronUtilityProcess;
  readonly trigger: ProviderProvisioningTrigger;
  readonly startedAtMonotonicMs: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function normalizeServerRemoteUrlForComparison(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    if (parsed.protocol === "wss:") parsed.protocol = "https:";
    parsed.hash = "";
    parsed.search = "";
    const normalizedPath = parsed.pathname.replace(/\/+$/g, "");
    parsed.pathname = normalizedPath.endsWith("/ws")
      ? normalizedPath.slice(0, -"/ws".length) || "/"
      : normalizedPath || "/";
    return parsed.toString().replace(/\/$/g, "");
  } catch {
    return url.trim().replace(/\/+$/g, "");
  }
}

function isSameRemoteTarget(left: RemoteTarget, right: RemoteTarget): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "ssh":
      return (
        right.kind === "ssh" &&
        left.host.trim().toLowerCase() === right.host.trim().toLowerCase() &&
        (left.port ?? 22) === (right.port ?? 22) &&
        left.username.trim() === right.username.trim() &&
        (left.privateKeyPath ?? "") === (right.privateKeyPath ?? "")
      );
    case "wsl":
      return (
        right.kind === "wsl" &&
        (left.distro?.trim() || "default") === (right.distro?.trim() || "default") &&
        (left.user?.trim() ?? "") === (right.user?.trim() ?? "")
      );
    case "docker":
      return right.kind === "docker" && left.container === right.container;
    case "server":
      return (
        right.kind === "server" &&
        normalizeServerRemoteUrlForComparison(left.url) ===
          normalizeServerRemoteUrlForComparison(right.url)
      );
  }
}

function buildRemoteTargetTelemetryKey(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${buildSshRemoteHostKey(target)}`;
    case "wsl":
      return `wsl:${target.distro?.trim() || "default"}\0${target.user?.trim() ?? ""}`;
    case "docker":
      return `docker:${target.container}`;
    case "server":
      return `server:${normalizeServerRemoteUrlForComparison(target.url)}`;
  }
}

function closeMessagePort(port: MessagePortMain | undefined): void {
  if (!port) return;
  try {
    port.close();
  } catch {
    // MessagePort 关闭失败不影响 Host 内 attachment 的 close/dispose 幂等收口。
  }
}

export function createRemoteWorkspaceSessionManager(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  resolveRemoteAssetDirs: () => RemoteAssetDirs;
  resolveWslTarget?: (
    target: Extract<RemoteTarget, { kind: "wsl" }>,
  ) => Promise<Extract<RemoteTarget, { kind: "wsl" }>>;
  createMessageChannel?: () => {
    port1: MessagePortMain;
    port2: MessagePortMain;
  };
  rendererAttachmentReadyTimeoutMs?: number;
  workspaceBindReadyTimeoutMs?: number;
  reportRemoteConnectionStateChanged?: (params: {
    rendererId: number;
    remoteKind: RemoteTarget["kind"];
    transition: Exclude<RemoteGaugeTransition, "none">;
  }) => void;
  reportRemoteDisconnect?: (params: {
    rendererId: number;
    remoteKind: RemoteTarget["kind"];
    disconnectReason: RemoteDisconnectReason;
    durationMs: number;
  }) => void;
  monotonicNowMs?: () => number;
  webRemoteControlManagerRef: {
    current: {
      failRemoteSession(sessionId: string, reason: string, failure: WebRemoteControlFailure): void;
      replaceRemoteSession?(event: {
        previousSessionId: string;
        sessionId: string;
        workspacePath: string;
        workspaceIdentity: string;
      }): Promise<void>;
    } | null;
  };
  providerProvisioningCoordinator?: ProviderProvisioningEnvironmentCoordinator;
}) {
  const pendingByRequestKey = new Map<string, PendingConnect>();
  const pendingProjectNavigations = new Map<
    string,
    {
      child: ElectronUtilityProcess;
      win: BrowserWindow;
      requestId: string;
      resolve(value: HostPreparedProjectWorkspace): void;
      reject(error: Error): void;
    }
  >();
  const pendingWorkspaceBindsByRequestKey = new Map<string, PendingWorkspaceBind>();
  const workspaceContextBindFlightsBySessionId = new Map<string, WorkspaceContextBindFlight>();
  const routesBySessionId = new Map<string, RemoteAttachmentRoute>();
  const listenedHosts = new WeakSet<ElectronUtilityProcess>();
  // Bug 原因（R8）：Host 打开项目目录有自己的 30 秒截止并报出具体原因；bind 兜底同为 30 秒时
  // 总是 Main 先到，用户只看到“附着已取消”。兜底只处理 Host 完全不应答，必须晚于 Host 的截止时间。
  const workspaceBindReadyTimeoutMs =
    options.workspaceBindReadyTimeoutMs ?? REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS + 10_000;
  const pendingProviderProvisioningExecutions = new Map<
    string,
    PendingProviderProvisioningExecution
  >();
  const providerProvisioningCoordinator =
    options.providerProvisioningCoordinator ?? new ProviderProvisioningEnvironmentCoordinator();
  let appShutdownStarted = false;
  const monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());

  function requestKey(webContentsId: number, requestId: string): string {
    return `${webContentsId}\0${requestId}`;
  }

  function getWindowHost(win: BrowserWindow): ElectronUtilityProcess {
    const child = options.windowHostProcessMap.get(win.webContents.id);
    if (!child || child.pid == null) {
      throw new Error(`未找到窗口 Local Host，windowId=${win.webContents.id}`);
    }
    ensureHostListener(child, win.webContents.id);
    return child;
  }

  function createMessageChannel() {
    return options.createMessageChannel?.() ?? new MessageChannelMain();
  }

  function emitConnectionLog(
    win: BrowserWindow,
    payload: {
      requestId?: string;
      sessionId?: string;
      level: "info" | "warn" | "error";
      message: string;
    },
  ): void {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(PlatformChannels.RemoteConnectionLog, {
      label: `window-host-${win.webContents.id}`,
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      level: payload.level,
      source: "window-host-controller",
      message: sanitizeRemoteConnectionLog(payload.message),
      // Bugfix: R1 改造曾把完整 ISO 时间直接交给连接日志 UI，长时间戳会挤压 flex 日志列并换行。
      // 这里恢复既有的紧凑时钟展示契约，Host 的 requestId 路由和原始日志内容保持不变。
      timestamp: new Date().toLocaleTimeString(undefined, {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    });
  }

  function detachServicePort(
    child: ElectronUtilityProcess,
    attachmentId: string,
    reason: string,
  ): void {
    try {
      child.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId,
      });
    } catch (error) {
      // 候选 port 的回收属于幂等清理，不能因 Host 已退出导致 ready promise 再次悬空。
      options.logger.warn("[window-host-remote] detach renderer attachment failed", {
        attachmentId,
        reason,
        error,
      });
    }
  }

  async function attachRendererPort(
    win: BrowserWindow,
    route: RemoteAttachmentRoute,
    reason: string,
  ): Promise<void> {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("窗口已关闭，无法 attachment 远程 workspace");
    }
    if (
      routesBySessionId.get(route.descriptor.remoteSessionId) !== route ||
      route.attachmentState !== "attachable"
    )
      throw new Error("远程 workspace scope 已失效，不能创建 attachment");
    const child = getWindowHost(win);
    const descriptor = route.descriptor;
    if (!descriptor.workspacePath || !descriptor.workspaceIdentity) {
      throw new Error(
        `远程 descriptor 缺少 workspace scope，sessionId=${descriptor.remoteSessionId}`,
      );
    }
    const attachmentId = randomUUID();
    const rendererPayload = scopedServicePortPayloadSchema.parse({
      attachmentId,
      sessionId: descriptor.remoteSessionId,
      target: descriptor.target,
      ...(descriptor.sourceServerId ? { sourceServerId: descriptor.sourceServerId } : {}),
      workspacePath: descriptor.workspacePath,
      workspaceIdentity: descriptor.workspaceIdentity,
      ...(descriptor.workspacePurpose ? { workspacePurpose: descriptor.workspacePurpose } : {}),
    });
    const { port1, port2 } = createMessageChannel();
    const previousAttachmentId = route.rendererAttachmentId;
    const superseded = route.pendingRendererAttachment;
    if (superseded) {
      clearTimeout(superseded.timeout);
      route.pendingRendererAttachment = undefined;
      detachServicePort(child, superseded.attachmentId, "superseded");
      superseded.reject(
        new Error(`renderer attachment 已被后续换代替代，sessionId=${descriptor.remoteSessionId}`),
      );
    }

    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = route.pendingRendererAttachment;
        if (!pending || pending.attachmentId !== attachmentId) return;
        route.pendingRendererAttachment = undefined;
        detachServicePort(child, attachmentId, "ready-timeout");
        const error = new Error(
          `renderer attachment ready 超时，sessionId=${descriptor.remoteSessionId}`,
        );
        options.logger.warn("[window-host-remote] renderer attachment ready timeout", {
          sessionId: descriptor.remoteSessionId,
          attachmentId,
          reason,
        });
        reject(error);
      }, options.rendererAttachmentReadyTimeoutMs ?? 15_000);
      timeout.unref?.();
      route.pendingRendererAttachment = {
        attachmentId,
        previousAttachmentId,
        reason,
        ready: () => ready,
        timeout,
        resolve,
        reject,
      };

      try {
        child.postMessage(
          {
            type: HostMessageTypes.AttachServicePort,
            requestId: randomUUID(),
            attachmentId,
            clientMode: "desktop-continuous",
            scope: {
              kind: "remote",
              ...(descriptor.sourceServerId ? { sourceServerId: descriptor.sourceServerId } : {}),
              remoteSessionId: descriptor.remoteSessionId,
              workspacePath: descriptor.workspacePath,
              workspaceIdentity: descriptor.workspaceIdentity,
            },
          },
          [port2],
        );
        win.webContents.postMessage(InternalChannels.ScopedServicePort, rendererPayload, [port1]);
      } catch (error) {
        clearTimeout(timeout);
        route.pendingRendererAttachment = undefined;
        detachServicePort(child, attachmentId, "delivery-failed");
        closeMessagePort(port1);
        closeMessagePort(port2);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return ready;
  }

  function waitForRendererAttachmentReady(route: RemoteAttachmentRoute): Promise<void> {
    if (route.pendingRendererAttachment) {
      return route.pendingRendererAttachment.ready();
    }
    if (route.rendererAttachmentId) {
      return Promise.resolve();
    }
    // Bug 原因：route 在首次 Provisioning 完成前就已登记，此时既没有 pending 也没有已就绪 attachment。
    // Source 已在线时同窗口重复 connect 会被 Host join 到这个 session，旧逻辑在这里直接拒绝，
    // 用户看到“尚无可用 renderer attachment”。首连阶段改为等待同一个首连结果，与发起者同成同败。
    if (route.initialAttachmentReady) {
      return route.initialAttachmentReady;
    }
    return Promise.reject(
      new Error(
        `远程 workspace route 尚无可用 renderer attachment，sessionId=${route.descriptor.remoteSessionId}`,
      ),
    );
  }

  function buildWorkspaceContextBindKey(params: {
    workspaceIdentity: string;
    workspacePurpose?: WorkspacePurpose;
  }): string {
    return `${params.workspaceIdentity}\0${params.workspacePurpose ?? ""}`;
  }

  function waitForJoinedRouteReady(
    route: RemoteAttachmentRoute,
    descriptor: WindowHostRemoteWorkspaceDescriptor,
  ): Promise<void> {
    const bindFlight = workspaceContextBindFlightsBySessionId.get(descriptor.remoteSessionId);
    if (
      bindFlight &&
      descriptor.workspaceIdentity &&
      bindFlight.contextKey ===
        buildWorkspaceContextBindKey({
          workspaceIdentity: descriptor.workspaceIdentity,
          workspacePurpose: descriptor.workspacePurpose,
        })
    ) {
      return bindFlight.promise.then(() => undefined);
    }
    return waitForRendererAttachmentReady(route);
  }

  function confirmRendererAttachmentReady(
    webContentsId: number,
    payload: { sessionId: string; attachmentId: string },
  ): void {
    const route = routesBySessionId.get(payload.sessionId);
    const pending = route?.pendingRendererAttachment;
    if (
      !route ||
      route.webContentsId !== webContentsId ||
      !pending ||
      pending.attachmentId !== payload.attachmentId
    ) {
      options.logger.warn("[window-host-remote] ignore stale renderer attachment ready", {
        webContentsId,
        sessionId: payload.sessionId,
        attachmentId: payload.attachmentId,
      });
      // Bug 原因：Main 放弃 attachment 并删除 route（如换代 ready 超时）后，Renderer 才处理 port 并登记 session。
      // 这条 session 已没有 route 和 Host 连接，导航却仍按目录找到它：点击任务报“未找到”，查看文件读已关闭的连接。
      // ACK 在登记之后发出，由它触发释放不会早于登记，不需要超时或墓碑；route 还在时由当前 attachment 负责，不释放。
      if (!route) {
        const win = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.webContents.id === webContentsId,
        );
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(InternalChannels.ScopedServicePortReleased, payload);
        }
      }
      return;
    }

    clearTimeout(pending.timeout);
    route.pendingRendererAttachment = undefined;
    const child = options.windowHostProcessMap.get(route.webContentsId);
    if (!child || child.pid == null) {
      pending.reject(new Error(`窗口 Local Host 已退出，sessionId=${payload.sessionId}`));
      return;
    }
    route.rendererAttachmentId = pending.attachmentId;
    if (pending.previousAttachmentId) {
      // Host generation bind 会 fail-closed 立即失效 A；Main 仍需等 renderer 注册 B
      // 后再提升 route 并做幂等清理。reload 复挂没有 generation 换代，也因此不会提前拆掉可用旧 port。
      detachServicePort(child, pending.previousAttachmentId, "candidate-promoted");
    }
    options.logger.info(
      `[window-host-remote] renderer attachment ready, sessionId=${payload.sessionId}, reason=${pending.reason}`,
    );
    if (!route.connectFinalized) {
      route.connectFinalized = true;
      if (route.remoteUsageTelemetryEligible) {
        reportRemoteRouteConnected(route);
      }
    }
    pending.resolve();
  }

  function reportRemoteRouteConnected(route: RemoteAttachmentRoute): void {
    try {
      options.reportRemoteConnectionStateChanged?.({
        rendererId: route.webContentsId,
        remoteKind: route.descriptor.target.kind,
        transition: "connected",
      });
    } catch (error) {
      options.logger.warn("[remote-usage-arms] connected reporter failed", {
        error,
      });
    }
  }

  function handleConnected(
    child: ElectronUtilityProcess,
    webContentsId: number,
    requestId: string,
    descriptor: WindowHostRemoteWorkspaceDescriptor,
  ): void {
    const key = requestKey(webContentsId, requestId);
    const pending = pendingByRequestKey.get(key);
    if (!pending) {
      child.postMessage({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        requestId: randomUUID(),
        remoteSessionId: descriptor.remoteSessionId,
      });
      return;
    }
    pendingByRequestKey.delete(key);
    const existingRoute = routesBySessionId.get(descriptor.remoteSessionId);
    if (existingRoute) {
      if (
        existingRoute.webContentsId !== webContentsId ||
        existingRoute.attachmentState !== "attachable" ||
        !isSameRemoteTarget(existingRoute.descriptor.target, descriptor.target)
      ) {
        // Bug 原因：Host join 合法复用 logical sessionId；只有同窗口、同 target 才能共享
        // Main route。冲突时拒绝新请求，但不能 dispose 仍被旧 owner 使用的 session。
        pending.reject(
          new Error(
            `远程 workspace join 与已有 route 不匹配，sessionId=${descriptor.remoteSessionId}`,
          ),
        );
        return;
      }
      if (existingRoute.mobileOnly) {
        existingRoute.mobileOnly = false;
        // 手机 scope 没有 renderer ready；桌面采用时重新走唯一的连接提交点。
        existingRoute.connectFinalized = false;
        existingRoute.remoteUsageTelemetryEligible ||= pending.remoteUsageTelemetryEligible;
        existingRoute.initialAttachmentReady = (
          existingRoute.providerProvisioningReady ?? Promise.resolve()
        ).then(() => attachRendererPort(pending.win, existingRoute, "desktop-join"));
        void existingRoute.initialAttachmentReady.then(
          () => pending.resolve(descriptor.remoteSessionId),
          (error: unknown) =>
            pending.reject(error instanceof Error ? error : new Error(String(error))),
        );
        return;
      }
      // Bug 原因：显式 conversation bind 与 Source 自动恢复可能 join 到同一个 Host
      // logical session。过去这里覆盖 routesBySessionId，旧 candidate 的 ready ACK 会被
      // 判 stale，遗留 timer 最终又回收健康 attachment。重复 connect 只等待唯一 route ready。
      const promoteTelemetryEligibility =
        !existingRoute.remoteUsageTelemetryEligible && pending.remoteUsageTelemetryEligible;
      existingRoute.remoteUsageTelemetryEligible ||= pending.remoteUsageTelemetryEligible;
      if (promoteTelemetryEligibility && existingRoute.connectFinalized) {
        reportRemoteRouteConnected(existingRoute);
      }
      void waitForJoinedRouteReady(existingRoute, descriptor).then(
        () => {
          pending.onConnected?.(descriptor);
          pending.resolve(descriptor.remoteSessionId);
        },
        (error: unknown) =>
          pending.reject(error instanceof Error ? error : new Error(String(error))),
      );
      return;
    }
    const route: RemoteAttachmentRoute = {
      webContentsId,
      descriptor,
      attachmentState: "attachable",
      connectedAtMonotonicMs: monotonicNowMs(),
      connectFinalized: false,
      remoteUsageTelemetryEligible: pending.remoteUsageTelemetryEligible,
    };
    routesBySessionId.set(descriptor.remoteSessionId, route);
    const environmentKey = buildRemoteEnvironmentKey(descriptor.target);
    const registration = providerProvisioningCoordinator.register(
      environmentKey,
      descriptor.remoteSessionId,
      (trigger) =>
        executeProviderProvisioning(child, descriptor.remoteSessionId, environmentKey, trigger),
      descriptor.sourceServerId,
    );
    route.providerProvisioningDispose = registration.dispose;
    route.initialAttachmentReady = registration.initialSync.then(() =>
      attachRendererPort(pending.win, route, "connect"),
    );
    void route.initialAttachmentReady
      .then(() => {
        emitConnectionLog(pending.win, {
          requestId,
          sessionId: descriptor.remoteSessionId,
          level: "info",
          message: `远程 ${descriptor.target.kind} workspace 已连接`,
        });
        pending.onConnected?.(descriptor);
        pending.resolve(descriptor.remoteSessionId);
      })
      .catch((error: unknown) => {
        route.providerProvisioningDispose?.();
        routesBySessionId.delete(descriptor.remoteSessionId);
        child.postMessage({
          type: HostMessageTypes.DisposeRemoteWorkspaceSession,
          requestId: randomUUID(),
          remoteSessionId: descriptor.remoteSessionId,
        });
        emitConnectionLog(pending.win, {
          requestId,
          sessionId: descriptor.remoteSessionId,
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  function handleReconnected(
    child: ElectronUtilityProcess,
    webContentsId: number,
    previousRemoteSessionId: string,
    descriptor: WindowHostRemoteWorkspaceDescriptor,
  ): void {
    const route = routesBySessionId.get(previousRemoteSessionId);
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === webContentsId,
    );
    if (!route || route.webContentsId !== webContentsId || !win) {
      child.postMessage({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        requestId: randomUUID(),
        remoteSessionId: descriptor.remoteSessionId,
      });
      return;
    }
    routesBySessionId.delete(previousRemoteSessionId);
    route.descriptor = descriptor;
    route.attachmentState = "attachable";
    routesBySessionId.set(descriptor.remoteSessionId, route);
    // Bug 原因：Provisioning lane 以 remoteSessionId 登记，execute 闭包也绑定旧 sessionId；
    // Source 重连换代后若不重新登记，后续下发都会命中 Host 已失效的旧 session，远端再也收不到配置。
    // 先摘掉旧登记再登记新 session，让 lane 按 Environment 重新上线整份重下发（离线期间的本机
    // 配置变更由此补齐）；重连不是首连发布屏障，失败只记录 warning，不拆除已恢复的 Workspace。
    route.providerProvisioningDispose?.();
    const environmentKey = buildRemoteEnvironmentKey(descriptor.target);
    const registration = providerProvisioningCoordinator.register(
      environmentKey,
      descriptor.remoteSessionId,
      (trigger) =>
        executeProviderProvisioning(child, descriptor.remoteSessionId, environmentKey, trigger),
      descriptor.sourceServerId,
    );
    route.providerProvisioningDispose = registration.dispose;
    registration.initialSync.catch((error: unknown) => {
      options.logger.warn(
        "[provider-provisioning] Environment resync after reconnect did not apply",
        {
          environmentKey,
          previousRemoteSessionId,
          remoteSessionId: descriptor.remoteSessionId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    });
    void (
      route.mobileOnly
        ? Promise.resolve()
        : attachRendererPort(win, route, "source-server-reconnected")
    )
      .then(() => {
        if (!descriptor.workspacePath || !descriptor.workspaceIdentity) return;
        // Bug 原因：手机 bridge 换代曾被 await 在 Desktop 关键路径上，手机 attachment
        // 失败会落入外层 catch 并 dispose 已就绪的 Desktop session。Desktop continuous
        // 先完成换代；手机 replayable 恢复是隔离的旁路，失败只降级手机。
        if (!route.mobileOnly)
          win.webContents.send(PlatformChannels.RemoteSessionReconnected, {
            previousSessionId: previousRemoteSessionId,
            sessionId: descriptor.remoteSessionId,
            workspacePath: descriptor.workspacePath,
            workspaceIdentity: descriptor.workspaceIdentity,
          });
        emitConnectionLog(win, {
          sessionId: descriptor.remoteSessionId,
          level: "info",
          message: `远程 ${descriptor.target.kind} workspace 已自动重连`,
        });
        void options.webRemoteControlManagerRef.current
          ?.replaceRemoteSession?.({
            previousSessionId: previousRemoteSessionId,
            sessionId: descriptor.remoteSessionId,
            workspacePath: descriptor.workspacePath,
            workspaceIdentity: descriptor.workspaceIdentity,
          })
          .catch((error: unknown) => {
            options.logger.warn("[window-host-remote] mobile bridge recovery failed", {
              previousRemoteSessionId,
              remoteSessionId: descriptor.remoteSessionId,
              error,
            });
          });
      })
      .catch((error: unknown) => {
        route.providerProvisioningDispose?.();
        routesBySessionId.delete(descriptor.remoteSessionId);
        child.postMessage({
          type: HostMessageTypes.DisposeRemoteWorkspaceSession,
          requestId: randomUUID(),
          remoteSessionId: descriptor.remoteSessionId,
        });
        options.logger.warn("[window-host-remote] Source reconnect attachment failed", {
          previousRemoteSessionId,
          remoteSessionId: descriptor.remoteSessionId,
          error,
        });
        // Bug 原因：窗口只收到过旧 session 的可恢复断连。这里回收换代 session 后不再通知，窗口的 tab
        // 一直留着旧 id、“连接中”不结束，导航一直等待，重连入口也因 tab 仍有 id 而跳过。
        // 换代无法交付就是这次恢复的终点：按终止断连通知窗口与手机，由各自 owner 收尾。
        publishRemoteSessionClosed(win, {
          remoteSessionId: previousRemoteSessionId,
          exitCode: null,
          signal: null,
          error: error instanceof Error ? error.message : String(error),
          recoverable: false,
        });
      });
  }

  function executeProviderProvisioning(
    child: ElectronUtilityProcess,
    remoteSessionId: string,
    environmentKey: string,
    trigger: ProviderProvisioningTrigger,
  ): Promise<void> {
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      pendingProviderProvisioningExecutions.set(requestId, {
        child,
        trigger,
        startedAtMonotonicMs: monotonicNowMs(),
        resolve,
        reject,
      });
      try {
        child.postMessage({
          type: HostMessageTypes.ProviderProvisioningExecute,
          requestId,
          environmentKey,
          remoteSessionId,
          trigger,
        });
      } catch (error) {
        pendingProviderProvisioningExecutions.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function detachRouteAttachments(
    route: RemoteAttachmentRoute,
    reason: string,
    error: Error,
  ): void {
    const child = options.windowHostProcessMap.get(route.webContentsId);
    if (route.pendingRendererAttachment) {
      const pending = route.pendingRendererAttachment;
      clearTimeout(pending.timeout);
      route.pendingRendererAttachment = undefined;
      if (child) detachServicePort(child, pending.attachmentId, reason);
      pending.reject(error);
    }
    if (route.rendererAttachmentId) {
      if (child) detachServicePort(child, route.rendererAttachmentId, reason);
      route.rendererAttachmentId = undefined;
    }
  }

  function retireActiveRoute(
    route: RemoteAttachmentRoute,
    reason: RemoteDisconnectReason,
    mutate: () => void,
  ): void {
    const wasActive =
      route.remoteUsageTelemetryEligible &&
      route.attachmentState === "attachable" &&
      route.connectFinalized;
    mutate();
    if (!wasActive) return;

    const common = {
      rendererId: route.webContentsId,
      remoteKind: route.descriptor.target.kind,
    };
    try {
      options.reportRemoteConnectionStateChanged?.({
        ...common,
        transition: reason,
      });
    } catch (error) {
      // telemetry 是连接生命周期的旁路，不能因 reporter 异常回滚 route 退出状态。
      options.logger.warn("[remote-usage-arms] disconnect gauge reporter failed", { error });
    }
    try {
      options.reportRemoteDisconnect?.({
        ...common,
        disconnectReason: reason,
        durationMs: Math.max(0, Math.round(monotonicNowMs() - route.connectedAtMonotonicMs)),
      });
    } catch (error) {
      options.logger.warn("[remote-usage-arms] disconnect reporter failed", {
        error,
      });
    }
  }

  interface RemoteSessionClosedNotice {
    remoteSessionId: string;
    exitCode?: number | null;
    signal?: string | null;
    error?: string;
    recoverable?: boolean;
    recoveryAttempt?: number;
    recoveryLimit?: number;
    recoveryBudgetExhausted?: boolean;
    reasonCode?: string;
    retryable?: boolean;
  }

  /** 把 session 断连通知给窗口；终止断连同时结束手机 bridge 上的同一 session。 */
  function publishRemoteSessionClosed(
    win: BrowserWindow | undefined,
    event: RemoteSessionClosedNotice,
  ): void {
    if (event.recoverable !== true) {
      options.webRemoteControlManagerRef.current?.failRemoteSession(
        event.remoteSessionId,
        "window-host:connection-offline",
        {
          reason: "workspace-closed",
          message: "远程工作区连接已结束，请在桌面端重新连接。",
        },
      );
    }
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(PlatformChannels.RemoteSessionClosed, {
        sessionId: event.remoteSessionId,
        reason: "host-exit" as const,
        exitCode: event.exitCode ?? null,
        signal: event.signal ?? null,
        ...(event.error ? { error: event.error } : {}),
        ...(event.recoverable !== undefined ? { recoverable: event.recoverable } : {}),
        ...(event.recoveryAttempt ? { recoveryAttempt: event.recoveryAttempt } : {}),
        ...(event.recoveryLimit ? { recoveryLimit: event.recoveryLimit } : {}),
        ...(event.recoveryBudgetExhausted !== undefined
          ? { recoveryBudgetExhausted: event.recoveryBudgetExhausted }
          : {}),
        ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
        ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
      });
      emitConnectionLog(win, {
        sessionId: event.remoteSessionId,
        level: "warn",
        message: event.error || "远程 workspace 连接已断开",
      });
    }
  }

  function handleClosed(
    webContentsId: number,
    event: RemoteSessionClosedNotice & {
      reason: "connection-closed" | "disposed" | "connect-cancelled";
    },
  ): void {
    const route = routesBySessionId.get(event.remoteSessionId);
    if (!route || route.webContentsId !== webContentsId) return;
    if (event.reason !== "connection-closed") {
      route.providerProvisioningDispose?.();
      retireActiveRoute(route, "disposed", () => {
        routesBySessionId.delete(event.remoteSessionId);
      });
      detachRouteAttachments(
        route,
        "session-released",
        new Error(`远程 workspace 已释放，sessionId=${event.remoteSessionId}`),
      );
      return;
    }
    retireActiveRoute(route, "connection-closed", () => {
      route.attachmentState = "closed";
    });
    route.providerProvisioningDispose?.();
    // 连接断开只把 route 标成 closed，已暴露的 desktop attachment 仍留在窗口 Host；
    // sessionId 换代后 Main 又会删除 route，导致旧 ChannelServer 永久失去回收入口。
    detachRouteAttachments(
      route,
      "session-connection-closed",
      new Error(`远程 workspace 已关闭，sessionId=${event.remoteSessionId}`),
    );
    publishRemoteSessionClosed(
      BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.id === webContentsId),
      event,
    );
  }

  function acceptPreparedProjectWorkspace(
    child: ElectronUtilityProcess,
    webContentsId: number,
    requestId: string,
    result: { ok: true; value: HostPreparedProjectWorkspace } | { ok: false; error: string },
  ): void {
    const key = requestKey(webContentsId, requestId);
    const pending = pendingProjectNavigations.get(key);
    if (!pending || pending.child !== child) return;
    if (!result.ok) {
      pendingProjectNavigations.delete(key);
      pending.reject(new Error(result.error));
      return;
    }
    const descriptor = result.value.remote;
    if (!descriptor) {
      pendingProjectNavigations.delete(key);
      pending.resolve(result.value);
      return;
    }
    const resolveWhenReady = (route: RemoteAttachmentRoute, ownsRegistration: boolean) => {
      void (route.providerProvisioningReady ?? Promise.resolve()).then(
        () => {
          // 每个 join 都必须等同一屏障，并保留自己的取消资格到成功提交。
          if (pendingProjectNavigations.get(key) !== pending) return;
          pendingProjectNavigations.delete(key);
          if (
            routesBySessionId.get(descriptor.remoteSessionId) !== route ||
            route.attachmentState !== "attachable"
          )
            pending.reject(new Error("项目导航 scope 已失效"));
          else pending.resolve(result.value);
        },
        (error: unknown) => {
          if (pendingProjectNavigations.get(key) === pending) pendingProjectNavigations.delete(key);
          if (
            ownsRegistration &&
            routesBySessionId.get(descriptor.remoteSessionId) === route &&
            route.mobileOnly
          ) {
            routesBySessionId.delete(descriptor.remoteSessionId);
            route.providerProvisioningDispose?.();
            child.postMessage({
              type: HostMessageTypes.DisposeRemoteWorkspaceSession,
              requestId: randomUUID(),
              remoteSessionId: descriptor.remoteSessionId,
            });
          }
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    };
    const existing = routesBySessionId.get(descriptor.remoteSessionId);
    if (existing) {
      if (
        existing.webContentsId !== webContentsId ||
        existing.attachmentState !== "attachable" ||
        existing.descriptor.workspaceIdentity !== descriptor.workspaceIdentity ||
        existing.descriptor.workspacePath !== descriptor.workspacePath
      ) {
        pendingProjectNavigations.delete(key);
        pending.reject(new Error("Project navigation scope conflicts with existing route"));
      } else resolveWhenReady(existing, false);
      return;
    }
    const route: RemoteAttachmentRoute = {
      webContentsId,
      descriptor,
      mobileOnly: true,
      attachmentState: "attachable",
      connectedAtMonotonicMs: monotonicNowMs(),
      connectFinalized: true,
      remoteUsageTelemetryEligible: false,
    };
    routesBySessionId.set(descriptor.remoteSessionId, route);
    const environmentKey = buildRemoteEnvironmentKey(descriptor.target);
    const registration = providerProvisioningCoordinator.register(
      environmentKey,
      descriptor.remoteSessionId,
      (trigger) =>
        executeProviderProvisioning(child, descriptor.remoteSessionId, environmentKey, trigger),
      descriptor.sourceServerId,
    );
    route.providerProvisioningDispose = registration.dispose;
    route.providerProvisioningReady = registration.initialSync;
    resolveWhenReady(route, true);
  }

  function ensureHostListener(child: ElectronUtilityProcess, webContentsId: number): void {
    if (listenedHosts.has(child)) return;
    listenedHosts.add(child);
    child.on("message", (message: unknown) => {
      const parsed = hostResponseMessageSchema.safeParse(message);
      if (!parsed.success) return;
      if (parsed.data.type === HostResponseTypes.ProjectWorkspacePrepared) {
        acceptPreparedProjectWorkspace(
          child,
          webContentsId,
          parsed.data.requestId,
          parsed.data.result,
        );
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnectionLog) {
        const pending = pendingByRequestKey.get(requestKey(webContentsId, parsed.data.requestId));
        if (!pending) return;
        // 多个远程连接共享 window Host，不能再从进程 label/stdout 猜日志归属；
        // Host 已带上连接 requestId，Main 只向对应发起窗口做薄转发。
        emitConnectionLog(pending.win, {
          requestId: parsed.data.requestId,
          level: parsed.data.level,
          message: parsed.data.message,
        });
        return;
      }
      if (parsed.data.type === HostResponseTypes.ProviderProvisioningSourceChanged) {
        void providerProvisioningCoordinator.requestAll(parsed.data.trigger);
        return;
      }
      if (parsed.data.type === HostResponseTypes.ProviderProvisioningExecutionResult) {
        const pending = pendingProviderProvisioningExecutions.get(parsed.data.requestId);
        if (!pending || pending.child !== child) return;
        pendingProviderProvisioningExecutions.delete(parsed.data.requestId);
        const logContext = {
          environmentKey: parsed.data.environmentKey,
          trigger: pending.trigger,
          status: parsed.data.status,
          durationMs: Math.max(0, monotonicNowMs() - pending.startedAtMonotonicMs),
        };
        if (parsed.data.status !== "applied" && parsed.data.status !== "already-applied") {
          const errorCode =
            parsed.data.errorCode ??
            (parsed.data.status === "unsupported"
              ? "capability-unavailable"
              : "target-apply-failed");
          // 首次失败以前在 warning 前返回，连接面板也只剩开始日志，无法区分本地与远端故障。
          // 仅记录经过 schema 校验的阶段码；远端 error 自由文本仍不进入日志或反馈。
          options.logger.warn("[provider-provisioning] Environment sync did not apply", {
            ...logContext,
            errorCode,
          });
          // 失败一律带阶段码交给协调器：lane 据此记录最近结果（数据同步页的唯一数据源），
          // 是否把失败抛给连接发布屏障由协调器按 trigger 决定（只有 environment-online 会抛出）。
          pending.reject(
            new ProviderProvisioningExecutionError(
              `Provider Provisioning ${pending.trigger === "environment-online" ? "首次" : ""}同步失败 (${parsed.data.status}; ${errorCode})`,
              errorCode,
            ),
          );
          return;
        } else {
          options.logger.info("[provider-provisioning] Environment sync completed", logContext);
        }
        pending.resolve();
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnected) {
        handleConnected(child, webContentsId, parsed.data.requestId, parsed.data.descriptor);
        return;
      }
      if (
        parsed.data.type === HostResponseTypes.RemoteWorkspaceContextBound ||
        parsed.data.type === HostResponseTypes.RemoteWorkspaceContextBindFailed
      ) {
        const key = requestKey(webContentsId, parsed.data.requestId);
        const pending = pendingWorkspaceBindsByRequestKey.get(key);
        if (!pending) return;
        pendingWorkspaceBindsByRequestKey.delete(key);
        clearTimeout(pending.timeout);
        if (parsed.data.type === HostResponseTypes.RemoteWorkspaceContextBound) {
          pending.resolve(parsed.data.previousWorkspaceIdentity);
        } else {
          const error = new Error(parsed.data.error) as Error & {
            code?: string;
            retryable?: boolean;
          };
          if (parsed.data.reasonCode) error.code = parsed.data.reasonCode;
          if (parsed.data.retryable !== undefined) error.retryable = parsed.data.retryable;
          pending.reject(error);
        }
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceReconnected) {
        handleReconnected(
          child,
          webContentsId,
          parsed.data.previousRemoteSessionId,
          parsed.data.descriptor,
        );
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnectFailed) {
        const key = requestKey(webContentsId, parsed.data.requestId);
        const pending = pendingByRequestKey.get(key);
        if (!pending) return;
        pendingByRequestKey.delete(key);
        emitConnectionLog(pending.win, {
          requestId: parsed.data.requestId,
          level: remoteConnectionFailureLogLevel(parsed.data.reasonCode ?? ""),
          message: sanitizeRemoteConnectionLog(parsed.data.error),
        });
        const error = new Error(parsed.data.error) as Error & {
          code?: string;
          retryable?: boolean;
          profileId?: string;
          resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
        };
        if (parsed.data.reasonCode) error.code = parsed.data.reasonCode;
        if (parsed.data.retryable !== undefined) error.retryable = parsed.data.retryable;
        if (parsed.data.profileId) error.profileId = parsed.data.profileId;
        if (parsed.data.resolvedWslTarget) error.resolvedWslTarget = parsed.data.resolvedWslTarget;
        pending.reject(error);
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceClosed) {
        handleClosed(webContentsId, parsed.data);
      }
    });
    child.once("exit", () => {
      const error = new Error("窗口 Local Host 已退出");
      for (const [key, pending] of pendingProjectNavigations) {
        if (pending.child !== child) continue;
        pendingProjectNavigations.delete(key);
        pending.reject(error);
      }

      for (const [requestId, pendingExecution] of pendingProviderProvisioningExecutions) {
        if (pendingExecution.child !== child) continue;
        pendingProviderProvisioningExecutions.delete(requestId);
        pendingExecution.reject(error);
      }
      for (const [key, pending] of Array.from(pendingByRequestKey)) {
        if (pending.webContentsId === webContentsId) {
          pendingByRequestKey.delete(key);
          pending.reject(error);
        }
      }
      for (const [key, pending] of Array.from(pendingWorkspaceBindsByRequestKey)) {
        if (!key.startsWith(`${webContentsId}\0`)) continue;
        pendingWorkspaceBindsByRequestKey.delete(key);
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      for (const [sessionId, route] of Array.from(routesBySessionId)) {
        if (route.webContentsId !== webContentsId) continue;
        route.providerProvisioningDispose?.();
        retireActiveRoute(route, "host-exit", () => {
          routesBySessionId.delete(sessionId);
        });
        if (route.pendingRendererAttachment) {
          clearTimeout(route.pendingRendererAttachment.timeout);
          route.pendingRendererAttachment.reject(error);
        }
      }
    });
  }

  async function createRemoteWorkspaceSession(
    win: BrowserWindow,
    target: RemoteTarget,
    requestId?: string,
    context?: RemoteWorkspaceConnectContext,
    lifecycle?: {
      remoteUsageTelemetryEligible?: boolean;
      onConnected?: (descriptor: WindowHostRemoteWorkspaceDescriptor) => void;
    },
  ): Promise<string> {
    if (appShutdownStarted) {
      throw new Error("应用正在退出，无法创建远程工作区连接");
    }
    const child = getWindowHost(win);
    const resolvedTarget =
      target.kind === "wsl" && options.resolveWslTarget
        ? await options.resolveWslTarget(target)
        : target;
    if (appShutdownStarted) {
      // WSL identity 解析跨 await，期间退出屏障可能已清空 Main 请求关联并开始回收 Host。
      // 恢复后必须重新验证生命周期，禁止在 shutdown barrier 之后注册迟到请求。
      throw new Error("应用正在退出，无法创建远程工作区连接");
    }
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("窗口已关闭，无法创建远程工作区连接");
    }
    const resolvedRequestId = requestId ?? randomUUID();
    const key = requestKey(win.webContents.id, resolvedRequestId);
    if (pendingByRequestKey.has(key)) {
      throw new Error(`远程连接 requestId 重复，requestId=${resolvedRequestId}`);
    }
    emitConnectionLog(win, {
      requestId: resolvedRequestId,
      level: "info",
      message: `正在通过窗口 Host 连接 ${resolvedTarget.kind} workspace`,
    });
    return new Promise<string>((resolve, reject) => {
      pendingByRequestKey.set(key, {
        requestId: resolvedRequestId,
        webContentsId: win.webContents.id,
        win,
        remoteUsageTelemetryEligible: lifecycle?.remoteUsageTelemetryEligible ?? false,
        onConnected: lifecycle?.onConnected,
        resolve,
        reject,
      });
      child.postMessage({
        type: HostMessageTypes.ConnectRemoteWorkspace,
        requestId: resolvedRequestId,
        target: resolvedTarget,
        remoteAssets: options.resolveRemoteAssetDirs(),
        ...(context?.workspacePath ? { workspacePath: context.workspacePath } : {}),
        ...(context?.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
        ...(context?.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
      });
    });
  }

  async function bindRemoteWorkspaceSessionContext(
    sessionId: string,
    context: RemoteWorkspaceSessionContext,
    expectedWebContentsId?: number,
  ): Promise<BindRemoteWorkspaceSessionContextResult> {
    const route = routesBySessionId.get(sessionId);
    if (!route) {
      throw new Error(`未找到远程 workspace session，sessionId=${sessionId}`);
    }
    if (expectedWebContentsId != null && route.webContentsId !== expectedWebContentsId) {
      throw new Error(`远程 workspace session 不属于当前窗口，sessionId=${sessionId}`);
    }
    const requestedWorkspaceIdentity =
      context.workspaceIdentity?.trim() ||
      buildRemoteWorkspaceIdentity(context.workspacePath, route.descriptor.target);
    const workspaceIdentity = route.descriptor.sourceServerId
      ? buildServerRemoteWorkspaceIdentity({
          serverId: route.descriptor.sourceServerId,
          workspacePath: context.workspacePath,
        })
      : requestedWorkspaceIdentity;
    const contextKey = buildWorkspaceContextBindKey({
      workspaceIdentity,
      workspacePurpose: context.workspacePurpose,
    });
    const existingFlight = workspaceContextBindFlightsBySessionId.get(sessionId);
    if (existingFlight) {
      if (existingFlight.contextKey !== contextKey) {
        throw new Error(`远程 workspace session 正在绑定其它 context，sessionId=${sessionId}`);
      }
      return await existingFlight.promise;
    }
    const requestedWorkspacePurpose = context.workspacePurpose ?? route.descriptor.workspacePurpose;
    if (
      route.descriptor.workspacePath === context.workspacePath &&
      route.descriptor.workspaceIdentity === workspaceIdentity &&
      (route.descriptor.workspacePurpose ?? "project") === (requestedWorkspacePurpose ?? "project")
    ) {
      // Bug 原因：join caller 在首个 bind 完成后会再次提交同一 context。重复换代
      // attachment 会让并行初始化使用的 services 失效；已绑定 context 只等待当前 candidate ready。
      await waitForRendererAttachmentReady(route);
      return createBoundRemoteWorkspaceContextResult(route);
    }
    const promise = performRemoteWorkspaceSessionContextBind({
      route,
      sessionId,
      context,
      requestedWorkspaceIdentity,
      workspaceIdentity,
    });
    workspaceContextBindFlightsBySessionId.set(sessionId, {
      contextKey,
      promise,
    });
    try {
      return await promise;
    } finally {
      const current = workspaceContextBindFlightsBySessionId.get(sessionId);
      if (current?.promise === promise) {
        workspaceContextBindFlightsBySessionId.delete(sessionId);
      }
    }
  }

  async function performRemoteWorkspaceSessionContextBind(params: {
    route: RemoteAttachmentRoute;
    sessionId: string;
    context: RemoteWorkspaceSessionContext;
    requestedWorkspaceIdentity: string;
    workspaceIdentity: string;
  }): Promise<BindRemoteWorkspaceSessionContextResult> {
    const { route, sessionId, context, requestedWorkspaceIdentity, workspaceIdentity } = params;
    const child = options.windowHostProcessMap.get(route.webContentsId);
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === route.webContentsId,
    );
    if (!child || !win) {
      throw new Error(`未找到远程 workspace 所属窗口 Host，sessionId=${sessionId}`);
    }
    const requestId = randomUUID();
    const bindRequestKey = requestKey(route.webContentsId, requestId);
    const bindReady = new Promise<string | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingWorkspaceBindsByRequestKey.get(bindRequestKey);
        if (!pending) return;
        pendingWorkspaceBindsByRequestKey.delete(bindRequestKey);
        child.postMessage({
          type: HostMessageTypes.CancelRemoteWorkspaceBind,
          requestId,
          remoteSessionId: sessionId,
        });
        pending.reject(
          Object.assign(
            new Error(
              `workspace bind ACK 超时，sessionId=${sessionId}, timeoutMs=${workspaceBindReadyTimeoutMs}`,
            ),
            {
              // Bug 原因：超时会主动发 CancelRemoteWorkspaceBind，但本地先拒绝了无 code 的
              // Error，Renderer 永远走不到已登记的 bindCanceled i18n 分支。
              code: REMOTE_BIND_CANCELED_ERROR_CODE,
              retryable: true,
            },
          ),
        );
      }, workspaceBindReadyTimeoutMs);
      pendingWorkspaceBindsByRequestKey.set(bindRequestKey, {
        resolve,
        reject,
        timeout,
      });
    });
    child.postMessage({
      type: HostMessageTypes.BindRemoteWorkspaceContext,
      requestId,
      remoteSessionId: sessionId,
      workspacePath: context.workspacePath,
      workspaceIdentity,
      ...(context.workspacePurpose ? { workspacePurpose: context.workspacePurpose } : {}),
      ...(requestedWorkspaceIdentity !== workspaceIdentity
        ? { legacyRouteHint: requestedWorkspaceIdentity }
        : {}),
    });
    let previousWorkspaceIdentity: string | undefined;
    try {
      previousWorkspaceIdentity = await bindReady;
    } catch (error) {
      const pending = pendingWorkspaceBindsByRequestKey.get(bindRequestKey);
      if (pending) clearTimeout(pending.timeout);
      pendingWorkspaceBindsByRequestKey.delete(bindRequestKey);
      throw error;
    }
    route.descriptor = {
      ...route.descriptor,
      workspacePath: context.workspacePath,
      workspaceIdentity,
      ...(context.workspacePurpose ? { workspacePurpose: context.workspacePurpose } : {}),
      generation: route.descriptor.generation + 1,
    };
    // 同一 parentPort 上 Bind 先于 Attach 处理；IPC 只在 renderer 注册新 port 后返回。
    await attachRendererPort(win, route, "workspace-context-bound");
    return createBoundRemoteWorkspaceContextResult(route, previousWorkspaceIdentity);
  }

  function createBoundRemoteWorkspaceContextResult(
    route: RemoteAttachmentRoute,
    previousWorkspaceIdentity?: string,
  ): BindRemoteWorkspaceSessionContextResult {
    return {
      ...(route.descriptor.sourceServerId
        ? { sourceServerId: route.descriptor.sourceServerId }
        : {}),
      remoteSessionId: route.descriptor.remoteSessionId,
      workspacePath: route.descriptor.workspacePath!,
      workspaceIdentity: route.descriptor.workspaceIdentity!,
      ...(route.descriptor.workspacePurpose
        ? { workspacePurpose: route.descriptor.workspacePurpose }
        : {}),
      ...(previousWorkspaceIdentity ? { previousWorkspaceIdentity } : {}),
    };
  }

  function reattachRemoteWorkspaceSessionsForWindow(win: BrowserWindow, reason: string): void {
    for (const route of routesBySessionId.values()) {
      if (
        !route.mobileOnly &&
        route.webContentsId === win.webContents.id &&
        route.attachmentState === "attachable"
      ) {
        void attachRendererPort(win, route, reason).catch((error: unknown) => {
          options.logger.warn("[window-host-remote] renderer reattach failed", {
            sessionId: route.descriptor.remoteSessionId,
            reason,
            error,
          });
        });
      }
    }
  }

  function getRemoteConnectionStats(): RemoteConnectionStats {
    const activeRoutes = Array.from(routesBySessionId.values()).filter(
      (route) =>
        route.remoteUsageTelemetryEligible &&
        route.attachmentState === "attachable" &&
        route.connectFinalized,
    );
    return {
      activeSessionCount: activeRoutes.length,
      activeTargetCount: new Set(
        activeRoutes.map((route) => buildRemoteTargetTelemetryKey(route.descriptor.target)),
      ).size,
    };
  }

  function disposeRemoteWorkspaceSession(sessionId: string, _reason?: string): void {
    const route = routesBySessionId.get(sessionId);
    if (!route) return;
    retireActiveRoute(route, "disposed", () => {
      routesBySessionId.delete(sessionId);
    });
    route.providerProvisioningDispose?.();
    const child = options.windowHostProcessMap.get(route.webContentsId);
    if (route.pendingRendererAttachment) {
      const pending = route.pendingRendererAttachment;
      clearTimeout(pending.timeout);
      route.pendingRendererAttachment = undefined;
      if (child) detachServicePort(child, pending.attachmentId, "session-disposed");
      pending.reject(new Error(`远程 workspace session 已释放，sessionId=${sessionId}`));
    }
    if (!child) return;
    if (route.rendererAttachmentId) {
      child.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId: route.rendererAttachmentId,
      });
    }
    child.postMessage({
      type: HostMessageTypes.DisposeRemoteWorkspaceSession,
      requestId: randomUUID(),
      remoteSessionId: sessionId,
    });
  }

  function disposeRemoteWorkspaceSessionsForWindow(webContentsId: number): void {
    for (const [key, pending] of pendingProjectNavigations) {
      if (pending.win.webContents.id !== webContentsId) continue;
      pendingProjectNavigations.delete(key);
      pending.reject(new Error("窗口已关闭，项目导航已取消"));
    }

    for (const [sessionId, route] of Array.from(routesBySessionId)) {
      if (route.webContentsId !== webContentsId) continue;
      retireActiveRoute(route, "window-closed", () => {
        routesBySessionId.delete(sessionId);
      });
      route.providerProvisioningDispose?.();
      if (route.pendingRendererAttachment) {
        clearTimeout(route.pendingRendererAttachment.timeout);
        route.pendingRendererAttachment.reject(new Error("窗口已关闭，attachment 已取消"));
      }
    }
    for (const [key, pending] of Array.from(pendingByRequestKey)) {
      if (pending.webContentsId !== webContentsId) continue;
      pendingByRequestKey.delete(key);
      pending.reject(new Error("窗口已关闭，远程连接已取消"));
    }
    for (const [key, pending] of Array.from(pendingWorkspaceBindsByRequestKey)) {
      if (!key.startsWith(`${webContentsId}\0`)) continue;
      pendingWorkspaceBindsByRequestKey.delete(key);
      clearTimeout(pending.timeout);
      pending.reject(new Error("窗口已关闭，workspace bind 已取消"));
    }
  }

  function cancelPendingRemoteWorkspaceSessionsForWindow(
    webContentsId: number,
    _reason: string,
    requestId?: string,
  ): void {
    const child = options.windowHostProcessMap.get(webContentsId);
    if (!child) return;
    for (const [key, pending] of pendingProjectNavigations) {
      if (
        pending.win.webContents.id !== webContentsId ||
        (requestId && pending.requestId !== requestId)
      )
        continue;
      pendingProjectNavigations.delete(key);
      child.postMessage({
        type: HostMessageTypes.CancelRemoteWorkspaceConnect,
        requestId: pending.requestId,
      });
      pending.reject(new Error("项目导航已取消"));
    }
    for (const pending of pendingByRequestKey.values()) {
      if (
        pending.webContentsId === webContentsId &&
        (!requestId || pending.requestId === requestId)
      ) {
        child.postMessage({
          type: HostMessageTypes.CancelRemoteWorkspaceConnect,
          requestId: pending.requestId,
        });
      }
    }
  }

  function hasRemoteWorkspaceSessionForTarget(
    win: BrowserWindow,
    target: RemoteTarget,
    context?: RemoteWorkspaceSessionContext,
  ): boolean {
    const workspaceKey = context ? resolveWorkspaceKey(context) : undefined;
    return Array.from(routesBySessionId.values()).some(
      (route) =>
        route.webContentsId === win.webContents.id &&
        route.attachmentState === "attachable" &&
        isSameRemoteTarget(route.descriptor.target, target) &&
        (!workspaceKey ||
          resolveWorkspaceKey({
            workspacePath: route.descriptor.workspacePath ?? "",
            workspaceIdentity: route.descriptor.workspaceIdentity,
          }) === workspaceKey),
    );
  }

  function attachRemoteWorkspaceSessionHost(params: {
    windowId: number;
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspaceKey: string;
    clientMode: "web-remote-replayable";
    terminalOwnerId?: string;
  }): {
    process: ElectronUtilityProcess;
    port: MessagePortMain;
    remoteKind: RemoteTarget["kind"];
  } {
    const route = routesBySessionId.get(params.remoteSessionId);
    if (!route) {
      throw Object.assign(
        new Error(`未找到远程 workspace session，sessionId=${params.remoteSessionId}`),
        {
          code: "REMOTE_SESSION_MISSING" as const,
        },
      );
    }
    if (route.attachmentState !== "attachable") {
      throw Object.assign(new Error("远程 workspace source 当前离线"), {
        code: "REMOTE_SESSION_OFFLINE" as const,
      });
    }
    const win = BrowserWindow.fromId(params.windowId);
    if (!win || win.webContents.id !== route.webContentsId) {
      throw Object.assign(new Error("远程 workspace session 不属于当前窗口"), {
        code: "REMOTE_SESSION_WINDOW_MISMATCH" as const,
      });
    }
    const descriptor = route.descriptor;
    if (
      descriptor.workspacePath !== params.workspacePath ||
      descriptor.workspaceIdentity !== params.workspaceIdentity ||
      params.workspaceKey !== params.workspaceIdentity
    ) {
      throw Object.assign(new Error("远程 workspaceKey 与 logical session 不匹配。"), {
        code: "REMOTE_WORKSPACE_IDENTITY_MISMATCH" as const,
      });
    }
    const process = getWindowHost(win);
    const { port1, port2 } = createMessageChannel();
    process.postMessage(
      {
        type: HostMessageTypes.AttachServicePort,
        requestId: randomUUID(),
        attachmentId: randomUUID(),
        clientMode: params.clientMode,
        ...(params.terminalOwnerId ? { terminalOwnerId: params.terminalOwnerId } : {}),
        scope: {
          kind: "remote",
          remoteSessionId: params.remoteSessionId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        },
      },
      [port2],
    );
    return { process, port: port1, remoteKind: descriptor.target.kind };
  }

  function prepareProjectWorkspace(
    win: BrowserWindow,
    request: HostProjectWorkspaceNavigationInput,
    requestId: string = randomUUID(),
  ): Promise<HostPreparedProjectWorkspace> {
    if (appShutdownStarted || win.isDestroyed() || win.webContents.isDestroyed())
      return Promise.reject(new Error("窗口已关闭，项目导航已取消"));
    const child = getWindowHost(win);
    const key = requestKey(win.webContents.id, requestId);
    if (pendingProjectNavigations.has(key))
      return Promise.reject(new Error("项目导航 requestId 重复"));
    return new Promise((resolve, reject) => {
      pendingProjectNavigations.set(key, { child, win, requestId, resolve, reject });
      try {
        child.postMessage({
          type: HostMessageTypes.PrepareProjectWorkspace,
          requestId,
          ...request,
          clientMode: "web-remote-replayable",
        });
      } catch (error) {
        pendingProjectNavigations.delete(key);
        reject(error);
      }
    });
  }

  return {
    prepareProjectWorkspace,
    createRemoteWorkspaceSession,
    attachRemoteWorkspaceSessionHost,
    bindRemoteWorkspaceSessionContext,
    confirmRendererAttachmentReady,
    reattachRemoteWorkspaceSessionsForWindow,
    hasRemoteWorkspaceSessionForTarget,
    getRemoteConnectionStats,
    disposeRemoteWorkspaceSession,
    disposeRemoteWorkspaceSessionsForWindow,
    /** 数据同步页：按设备读取 Provisioning lane 的最近结果；只在本机 Main → Host 间流转。 */
    getProviderProvisioningLaneStatus: (
      sourceServerId: string,
      options?: { waitForIdle?: boolean },
    ) => providerProvisioningCoordinator.getLaneStatus(sourceServerId, options),
    /** 数据同步页「重试」：复用同一条 single-flight lane 的尾随同步。 */
    retryProviderProvisioning: (sourceServerId: string) =>
      providerProvisioningCoordinator.retry(sourceServerId),
    disposeAllAndWaitForAppShutdown: async (_reason: string) => {
      appShutdownStarted = true;
      const error = new Error("应用正在退出，远程连接已取消");
      for (const pending of pendingProjectNavigations.values()) pending.reject(error);
      pendingProjectNavigations.clear();
      for (const pending of pendingByRequestKey.values()) pending.reject(error);
      pendingByRequestKey.clear();
      for (const pending of pendingWorkspaceBindsByRequestKey.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      pendingWorkspaceBindsByRequestKey.clear();
      for (const [sessionId, route] of Array.from(routesBySessionId)) {
        retireActiveRoute(route, "app-shutdown", () => {
          routesBySessionId.delete(sessionId);
        });
        route.providerProvisioningDispose?.();
        if (!route.pendingRendererAttachment) continue;
        clearTimeout(route.pendingRendererAttachment.timeout);
        route.pendingRendererAttachment.reject(error);
      }
      routesBySessionId.clear();
    },
    cancelPendingRemoteWorkspaceSessionsForWindow,
    handleWorkspaceRunningTaskCountChanged: () => {
      // Running-task 事实现在由窗口 Host registry/ControllerProjection 持有；Main 不再维护 WSL pool。
    },
  };
}
