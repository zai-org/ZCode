import { normalizeRemoteConnectionError, sanitizeRemoteConnectionLog } from "@zcode/shared";
import { createCredentialCipherBridge } from "@zcode/shared/credential-security";
import { join } from "node:path";
/* eslint-disable max-lines -- Host 入口集中编排 local/remote service wiring，本次退出保护需要在同一处桥接 host 上报。 */
/* eslint-disable max-lines -- host process 入口集中维护 local/remote 初始化和资源回收，realtime bridge 接入后先保持同文件收口。 */
/**
 * Host Process 入口 —— 每个窗口对应一个独立的 host process
 *
 * 同一窗口的 Renderer 和手机 都 attachment 到这个 Host：
 *   Renderer / Mobile ←MessagePort→ Window Host
 *                                      ├─ local services
 *                                      └─ remote connection registry
 *
 * 启动流程：
 * 1. main 进程通过 Electron `utilityProcess.fork()` 创建本进程
 * 2. main 进程只发送一次 init-local 初始化窗口 Host
 * 3. 后续远端 connect / scoped attachment 都由同一 Host 处理
 */
import { createHostDatabaseStartup } from "./database-startup/hostDatabaseStartup.js";
import { isOffPeakTerminalStatus } from "@zcode/shared";
import { createHostNetworkCapture } from "./hostNetworkCapture.js";
import { randomUUID } from "node:crypto";
import { createPluginSandboxRegistrationBridge } from "./pluginSandbox/index.js";
import { createWindowTopicResourceRelay } from "./windowTopicResourceRelay.js";
import {
  MessagePortProtocol,
  ChannelServer,
  type IDisposable,
  type IChannelServer,
  LoggingChannelServer,
  NetworkTelemetryChannelServer,
} from "@zcode/rpc";
import { registerHostNetworkTelemetry, stopHostNetworkTelemetry } from "./hostNetworkTelemetry.js";
import { registerHostServiceResourceTelemetry } from "./hostServiceResourceTelemetry.js";
import { resolveResourceTelemetryEnvironmentKey } from "./hostResourceTelemetryEnvironment.js";
import { reportHostSessionCreate } from "./hostSessionCreateTelemetry.js";
import { createBrowserControlMainBridge } from "./browserControlMainBridge.js";
import {
  createAppControlNavigationBridge,
  createAppControlDiscoverySourceResolver,
  appNavigationResultMessageSchema,
} from "#src/app-control-navigation/host.js";
import { materializeBrowserRecordingArtifact } from "./browserRecordingArtifactMaterializer.js";
import { mainToExtensionWindowMessageSchema } from "@zcode/shared/extension-host";
import {
  ServiceCollection,
  IBotsService,
  ICredentialService,
  IFileService,
  IClientConfigService,
  IMediaPreviewService,
  IOffPeakTaskService,
  IRemoteProjectService,
  type RemoteProjectHost,
  IProjectService,
  ITaskGroupService,
  IBroadcastService,
  IModelSelectionService,
  ISettingService,
  ISourceServerManagementService,
  ITerminalService,
  IDeviceSyncStateService,
  IProviderProvisioningStatusService,
  IExtensionsService,
  IExtensionViewsService,
  IExtensionGrantsService,
  IPluginManagementService,
  IWindowControllerService,
  IConversationShareService,
  IPromptAttachmentTransferService,
  IZCodeAgentService,
  IZCodeTaskService,
  IZCodeSessionService,
  ICuaPipSessionService,
  createZCodeAgentConnectionScope,
  type ZCodeAgentV4ClientMode,
  collectServiceMemoryDiagnostics,
  createWebRemoteProjectTreeActivityBridge,
} from "@zcode/services";
import {
  createLocalServices,
  createProjectWorkspaceNavigation,
  createRemoteProjectConnectionAdmission,
  releaseRemoteProjectProfileHost,
  findRemoteProjectHostIdForProfile,
  remoteProjectHostIdForProfile,
  remoteProjectHostIdForTarget,
  prepareRemoteServerConnection,
  bindRemoteProjectIdentities,
  createRemoteIdentityRegistrationCache,
  getOffPeakRequestAuthBuilder,
  disposeServiceResources,
  disposeServiceResourcesAndWait,
  AutomationRepo,
  OffPeakTaskRepo,
  OffPeakTaskService,
  createServiceLogger,
  buildTaskChangeSummary,
  createHostApiNetworkTransport,
  createSettingServiceWithMigrations,
  createDeviceSyncStateService,
  createHostProviderProvisioningStatus,
  createWindowHostExtensions,
  getPluginUserOptionsReader,
  type AppControlServiceHandle,
  type WindowHostExtensions,
  getAppConfigDir,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
  type BotProjectConnection,
  type HostApiNetworkTransport,
  type OffPeakRequestAuthBuilder,
} from "@zcode/services/node";
import { createHostResourceUsageResponder } from "./hostResourceUsage.js";
import {
  assertBoundSessionDispatchable,
  resolveOffPeakDispatchKind,
} from "./offPeakDispatchPlan.js";
import {
  CREDENTIAL_KEY_SHARE_UNAVAILABLE_ERROR_CODE,
  HostMessageTypes,
  HostResponseTypes,
  formatLogPrefix,
  formatZCodeHostProcessName,
  formatZodError,
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  buildRemoteEnvironmentKey,
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  buildRemoteHostWorkspaceIdentity,
  resolveWorkspaceKey,
  REMOTE_BIND_CANCELED_ERROR_CODE,
  REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE,
  formatModelPickerValue,
  type ZCodePromptAttachment,
  type ZCodeStreamEvent,
  type ZCodeTaskMeta,
  type TaskStreamMirrorableEvent,
  type TraceId,
  type ZCodeTaskMode,
  type WindowHostAttachmentScope,
  type SourceServerArtifactPolicy,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunOutcome,
  type ModelSelection,
} from "@zcode/shared";
import {
  parseHostIncomingMessageEvent,
  rejectUnavailableAttachedServicePort,
} from "./hostMessagePortGuard.js";
// remote backend 相关模块延迟加载：ssh2 的 CJS 依赖链（asn1 等）在 asar 打包后路径断裂，
// 静态 import 会导致 local 模式的 host process 也崩溃。
// 改为动态 import，仅 remote 模式时才加载。
import type { IRemoteBackend } from "@zcode/server/remote";
import type { Locale, RemoteTarget } from "@zcode/shared";
import { wrapElectronPort } from "./electronPort.js";
import { createTaskRealtimeBridgeForHostInit } from "./taskRealtimeBridge.js";
import { resolveRpcLogLevel } from "./rpcLogLevel.js";
import { createHostWorkspaceTaskTracker } from "./hostWorkspaceTaskTracker.js";
import {
  createRemoteMediaPreviewProxy,
  type RemoteMediaPreviewProxy,
} from "./remoteMediaPreviewProxy.js";
import { watchCronRunBotDelivery } from "./cronBotDelivery.js";
import { createHostRemoteWorkspaceProxyState } from "./hostRemoteWorkspaceProxyState.js";
import {
  createServerRemoteWorkspaceServiceCollection,
  resolveServerProjectService,
} from "./remoteWorkspaceServiceCollection.js";
import { getRemoteProviderProvisioningExecutor } from "./remoteProviderProvisioningService.js";
import {
  createSourceSettingsServiceCollection,
  shouldDetachSourceSettingsAttachment,
} from "./sourceSettingsServiceCollection.js";
import { shouldReportHostConsoleError, stringifyHostLogArg } from "./hostLog.js";
import { flushHostE2ECoverage } from "./e2eCoverage.js";
import { runHostShutdownPhases, type HostShutdownResult } from "./hostShutdownPhases.js";
import { initializeHostApiNetworkTransportOwner } from "./hostInitialization.js";
import { createHostUncaughtExceptionHandler } from "./hostUncaughtExceptionGuard.js";
import {
  recordCronRunOutcomeBestEffort,
  startManualClaimHeartbeat,
  settleCronRunTerminalOutcome,
  settleManualDispatchFailureBestEffort,
} from "./cronRunLifecycle.js";
import { connectServerRemote, type ServerRemoteConnection } from "./serverRemoteConnection.js";
import { bindBotGroupTaskScope } from "./botGroupTaskScope.js";
import { createWindowHostAttachmentRegistry } from "./windowHostAttachmentRegistry.js";
import {
  exposeWindowHostAttachmentServices,
  createWindowHostTerminalOwners,
  createTerminalScope,
} from "./windowHostAttachmentRpcPolicy.js";
import { scopeConversationShareServiceForAttachment } from "./conversationShareAttachmentService.js";
import {
  createWindowRemoteConnectionRegistry,
  type WindowRemoteConnectionCloseEvent,
  type WindowRemoteConnectionHandle,
} from "./windowRemoteConnectionRegistry.js";
import { pushDynamicWorkflowUserModeToRemoteHosts } from "./remoteDynamicWorkflowUserMode.js";
import { connectDesktopSourceServer } from "./connectDesktopSourceServer.js";
import { prepareRemoteWorkspaceIdentity } from "./remoteWorkspacePreparation.js";
import { createWindowHostControllerRuntime } from "./windowHostControllerService.js";
import { resolveBotRemoteWorkspace } from "./botRemoteWorkspaceResolver.js";
import { SourceServerDirectory } from "./sourceServerDirectory.js";
import { connectSourceServerTarget } from "./connectSourceServerTarget.js";
import {
  SourceServerConnectionManager,
  SourceServerInstallRequiredError,
  SourceServerUpgradeRequiredError,
} from "./sourceServerConnectionManager.js";
import { createSourceServerRecoveryCloseEvent } from "./sourceServerRecoveryPolicy.js";
import { runStartupReconnectBatch } from "./sourceServerStartupReconnect.js";
import {
  createSourceServerManagementService,
  type SourceServerManagementService,
} from "./sourceServerManagementService.js";
import { resolveSourceServerReleaseAsset } from "./sourceServerReleaseResolver.js";
import { resolveAutomationSubmissionModelSelection } from "./automationModelSelection.js";
import { createRemoteConnectionProgressContext } from "@zcode/server/remote/remoteConnectionProgressContext.js";
import {
  createRemotePromptAttachmentTransferService,
  type RemotePromptAttachmentTransferService,
} from "./promptAttachmentTransferService.js";
import { startHostSelfResourceTelemetry } from "./hostSelfResourceTelemetry.js";
type HostRemoteConnection = ServerRemoteConnection;
interface HostRemoteConnectionCapabilities {
  promptAttachmentTransferFactory?: (
    scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
  ) => RemotePromptAttachmentTransferService;
  browserRecordingUploader?: Pick<IRemoteBackend, "upload">;
  remoteMediaPreviewFactory?: (
    scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
  ) => RemoteMediaPreviewProxy;
  sourceServerId?: string;
  persistentSourceConnection?: boolean;
  /** underlying 服务实例标识，创建 logical wrapper 不代表物理连接换代。 */
  physicalOwner?: () => object;
  /** 当前物理连接的项目能力；只读发现不接受旧 Server 的兼容项目代理。 */
  readonly virtualProjects?: boolean;
  profileId?: string;
  recordWorkspaceOpen?: (input: {
    workspacePath: string;
    workspaceIdentity: string;
    workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    legacyWorkspaceIdentity?: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  bindWorkspaceIdentity?: (input: {
    workspacePath: string;
    stableWorkspaceIdentity: string;
    legacyRouteHint?: string;
    signal?: AbortSignal;
  }) => Promise<void>;
}

let activeRemoteMediaRequests = 0;
const hostRemoteMediaRequestLimiter = {
  tryAcquire: () => {
    if (activeRemoteMediaRequests >= 4) return false;
    activeRemoteMediaRequests += 1;
    return true;
  },
  release: () => {
    activeRemoteMediaRequests = Math.max(0, activeRemoteMediaRequests - 1);
  },
  getState: () => ({ active: activeRemoteMediaRequests, limit: 4 }),
};
const remoteMediaRangePreviewEnabled =
  process.env["ZCODE_REMOTE_MEDIA_RANGE_PREVIEW_ENABLED"] !== "0";

type RemoteAssetDirs = import("./windowRemoteConnectionRegistry.js").WindowRemoteAssetDirs;

const { parentPort } = process;
const credentialCipherBridge = createCredentialCipherBridge((request) => {
  if (!parentPort) throw new Error("parentPort unavailable");
  parentPort.postMessage({ type: HostResponseTypes.CredentialCipherRequest, ...request });
});
const hostNetworkCapture = createHostNetworkCapture(parentPort);

// 进程检索体验优化：host 由 utilityProcess 拉起时外壳仍是 Electron Helper，
// 这里根据 main 传入的窗口 label 补一层稳定的 zcode-* title，方便系统进程列表过滤。
process.title = formatZCodeHostProcessName(process.env["ZCODE_PROCESS_LABEL"]);

type HostLogLevel = "info" | "warn" | "error";

interface PendingFeedbackLogArchiveRequest {
  resolve: (archive: { path: string; size: number }) => void;
  reject: (error: Error) => void;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}

interface PendingLocalMediaPreviewPathAuthorization {
  resolve: (path: string) => void;
  reject: (error: Error) => void;
}

const pendingFeedbackLogArchiveRequests = new Map<string, PendingFeedbackLogArchiveRequest>();
let nextFeedbackLogArchiveRequestSeq = 0;
const pendingLocalMediaPreviewPathAuthorizations = new Map<
  string,
  PendingLocalMediaPreviewPathAuthorization
>();

function authorizeLocalMediaPreviewPath(path: string): Promise<string> {
  if (!parentPort) {
    return Promise.reject(new Error("parentPort unavailable"));
  }
  const requestId = randomUUID();
  return new Promise<string>((resolve, reject) => {
    pendingLocalMediaPreviewPathAuthorizations.set(requestId, { resolve, reject });
    try {
      parentPort.postMessage({
        type: HostResponseTypes.LocalMediaPreviewPathAuthorizeRequest,
        requestId,
        path,
      });
    } catch (error) {
      pendingLocalMediaPreviewPathAuthorizations.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

interface PendingCredentialKeyShare {
  resolve: () => void;
  reject: (error: Error) => void;
}

const pendingCredentialKeyShares = new Map<string, PendingCredentialKeyShare>();

/**
 * 数据存储路径切换复制完成后，请求 Main 把当前系统密钥登记到目标数据根。
 * 只有 Main 访问系统库；失败时 reject，由设置服务中止切换（见系统安全存储规格）。
 */
function shareCredentialKeyWithDataRoot(targetBaseDir: string): Promise<void> {
  if (!parentPort) {
    return Promise.reject(new Error("parentPort unavailable"));
  }
  const requestId = randomUUID();
  return new Promise<void>((resolve, reject) => {
    pendingCredentialKeyShares.set(requestId, { resolve, reject });
    try {
      parentPort.postMessage({
        type: HostResponseTypes.CredentialKeyShareRequest,
        requestId,
        targetBaseDir,
      });
    } catch (error) {
      pendingCredentialKeyShares.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// 数据同步页「模型提供商」分类读取 / 重试 Main 协调器的 Provisioning lane（只在本机 Host）。
const hostProviderProvisioningStatus = createHostProviderProvisioningStatus((message) => {
  if (!parentPort) throw new Error("parentPort unavailable");
  parentPort.postMessage(message);
});

const pluginSandboxRegistrationBridge = createPluginSandboxRegistrationBridge({
  send: (message) => {
    if (!parentPort) throw new Error("parentPort unavailable");
    parentPort.postMessage(message);
  },
});

// browser-use host↔main 桥：把 agent 的 browser 命令经 parentPort 转给 main（WebContentsView+CDP）。
// parentPort 为空（不应发生于 host 进程）时 postToMain 抛错，bridge 自身返回 backend_unavailable。
const appControlNavigation = createAppControlNavigationBridge({
  post: (message) => {
    if (!parentPort) throw new Error("parentPort unavailable");
    parentPort.postMessage(message);
  },
});
let browserBackendIdentity: { id: string; generation: number } | undefined;
const browserControlMainBridge = createBrowserControlMainBridge({
  getBackendIdentity: () => browserBackendIdentity,
  postToMain: (message) => {
    if (!parentPort) {
      throw new Error("parentPort unavailable");
    }
    parentPort.postMessage(message);
  },
  materializeRecording: (input) => {
    let remoteBackend: Pick<IRemoteBackend, "upload"> | undefined;
    if (input.remoteSessionId) {
      const workspaceIdentity = input.workspaceIdentity;
      if (!workspaceIdentity?.trim()) {
        throw new Error("remote Browser recording materialization requires workspaceIdentity");
      }
      // Window Host 重构后同一进程可同时持有多个远端连接，旧的进程级
      // remoteConnection 会串 session。必须用完整 scope 从 registry 的权威 entry 取 uploader。
      remoteBackend = windowRemoteConnectionRegistry.resolveScopedCapabilities({
        kind: "remote",
        remoteSessionId: input.remoteSessionId,
        workspacePath: input.workspacePath,
        workspaceIdentity,
      })?.browserRecordingUploader;
      if (!remoteBackend) {
        throw new Error(
          "Source Server browser recording transfer requires the remote resource transaction path",
        );
      }
    }
    return materializeBrowserRecordingArtifact({
      ...input,
      ...(remoteBackend ? { remoteBackend } : {}),
    });
  },
});

function reportHostLog(level: HostLogLevel, args: unknown[]): void {
  if (!parentPort) {
    return;
  }

  try {
    parentPort.postMessage({
      type: HostResponseTypes.Log,
      level,
      source: "host",
      message: args.map((arg) => stringifyHostLogArg(arg)).join(" "),
    });
  } catch {
    // 日志上报失败不应影响 host 主流程。
  }
}

const rawConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const remoteConnectionProgressContext = createRemoteConnectionProgressContext({
  emit: ({ requestId, level, args }) => {
    if (!parentPort) {
      return;
    }
    try {
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceConnectionLog,
        requestId,
        level,
        message: args.map((arg) => stringifyHostLogArg(arg)).join(" "),
      });
    } catch {
      // 连接进度上报失败不应中断 SSH/WSL/Docker 的真实连接流程。
    }
  },
});

function writeHostLog(level: HostLogLevel, ...args: unknown[]): void {
  const prefix = formatLogPrefix("zcode-host", process.pid);
  const consoleFn =
    level === "error" ? rawConsole.error : level === "warn" ? rawConsole.warn : rawConsole.log;
  consoleFn(prefix, ...args);
  reportHostLog(level, [prefix, ...args]);
}

function createFullFeedbackLogArchiveViaMain(
  sourceDir: string,
  options?: {
    onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
  },
): Promise<{ path: string; size: number }> {
  const requestId = `feedback-log-archive-${Date.now()}-${nextFeedbackLogArchiveRequestSeq++}`;
  options?.onProgress?.({ processedBytes: 0, totalBytes: 0 });

  return new Promise((resolve, reject) => {
    pendingFeedbackLogArchiveRequests.set(requestId, {
      resolve,
      reject,
      onProgress: options?.onProgress,
    });
    // 问题反馈以前在 host service 内走 compactLogArchive 的 full fallback，
    // 收集范围和“导出日志”不一致，缺少 zcode-cli 日志、rollout/debug 以及导出链路脱敏。
    // 这里把完整日志打包委托给 main process 的导出日志同源逻辑，host 只拿 zip 路径继续上传。
    try {
      parentPort.postMessage({
        type: HostResponseTypes.FeedbackLogArchiveRequest,
        requestId,
        sourceDir,
      });
    } catch (error) {
      pendingFeedbackLogArchiveRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const logger = {
  info: (...args: unknown[]) => writeHostLog("info", ...args),
  warn: (...args: unknown[]) => writeHostLog("warn", ...args),
  error: (...args: unknown[]) => writeHostLog("error", ...args),
};

const cronAutomationRepo = new AutomationRepo();
const cronRunSubscriptions = new Map<string, { dispose(): void }>();

// ---- 闲时任务（off-peak）派发：与 cron 并行的独立链路（表/消息/常量互不复用）----
const offPeakTaskRepo = new OffPeakTaskRepo();
const offPeakRunSubscriptions = new Map<string, { dispose(): void }>();
/**
 * 续跑提示词（"实现时定"的落地）：3h 时间盒到期 / app 重启恢复后 resume 同一
 * session 续发。不重发原始 prompt（会让模型从头再做一遍），而是指示接续未完成的工作。
 */
const OFF_PEAK_RESUME_PROMPT =
  "Continue the previous task from where it left off. The run was interrupted " +
  "(app restart or execution window expired). Do not start over; review what has " +
  "already been done and complete the remaining work.";

// ---- off-peak 运行时装配（server client + 进程内 mock 网关 + 编排服务，host 域属主）----
// ⚠ 多窗口=多 host 会各自跑一份 sync 轮询（批量接口幂等、写入同库同数据，重复仅多耗请求）；
// mock 网关用固定端口单实例共享票据状态。若多窗口轮询放大成本，再加跨 host 选主。
interface OffPeakRuntime {
  service: OffPeakTaskService;
  /** 派发时按本段票据构造逐请求鉴权；静态模型事实由 CLI Built-in Config 提供。 */
  buildRequestAuth: OffPeakRequestAuthBuilder;
  validateSelection: (selection: {
    providerId: string;
    modelId: string;
    options?: { reasoningLevel?: string };
  }) => Promise<boolean>;
}
let offPeakRuntime: OffPeakRuntime | null = null;

async function ensureOffPeakRuntime(): Promise<OffPeakRuntime | null> {
  if (offPeakRuntime) return offPeakRuntime;
  const services = activeServices;
  if (!services) return null;
  const service = services.getOptional(IOffPeakTaskService);
  const buildRequestAuth = getOffPeakRequestAuthBuilder(services);
  if (!service || !buildRequestAuth) {
    logger.warn("off-peak runtime unavailable: missing host services");
    return null;
  }
  offPeakRuntime = {
    service: service as OffPeakTaskService,
    buildRequestAuth,
    validateSelection: (selection) =>
      (service as OffPeakTaskService).validateDispatchModelSelection(selection),
  };
  logger.info("off-peak runtime ready (service from local collection)");
  return offPeakRuntime;
}

function disposeOffPeakRuntime(): void {
  if (!offPeakRuntime) return;
  offPeakRuntime = null;
}

interface OffPeakRunDispatchRequest {
  offPeakTaskId: string;
  prompt: string;
  permissionMode: string;
  modelSelection: ModelSelection;
  conversationId?: string;
  sessionId?: string;
  serverTicketId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  projectId?: string | null;
  hostId?: string;
  additionalDirectories?: string[];
}

function offPeakRunSubscriptionKey(taskId: string, traceId: TraceId): string {
  return `${taskId}\u0000${traceId}`;
}

function disposeOffPeakRunSubscription(key: string): void {
  const disposable = offPeakRunSubscriptions.get(key);
  if (!disposable) return;
  offPeakRunSubscriptions.delete(key);
  disposable.dispose();
}

/** 终态回填 files_changed：复用现有 task diff 汇总（工具写盘型统计，Bash 改动不计入，接受）。 */
async function resolveOffPeakFilesChanged(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): Promise<number | undefined> {
  try {
    const snapshot = await params.zcodeTaskService.getTaskSnapshot({
      taskId: params.taskId,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    });
    const fileChanges = snapshot?.fileChanges;
    if (!fileChanges) return undefined;
    // 汇总为空（无文件改动）按 0 计——"改了 0 个文件"对完成通知是真实信息。
    return buildTaskChangeSummary(fileChanges)?.fileCount ?? 0;
  } catch (error) {
    logger.warn("off-peak files_changed 汇总失败（不阻塞终态落库）:", error);
    return undefined;
  }
}

/** loop 终态 → off_peak_tasks 终态：succeeded→completed、stopped→cancelled（用户手动停止）、其余→failed。 */
async function finalizeOffPeakRun(params: {
  zcodeTaskService: IZCodeTaskService;
  offPeakTaskId: string;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  outcome: ZCodeAutomationRunOutcome;
  error?: string;
}): Promise<void> {
  const status =
    params.outcome === "succeeded"
      ? ("completed" as const)
      : params.outcome === "stopped"
        ? ("cancelled" as const)
        : ("failed" as const);
  const filesChanged = await resolveOffPeakFilesChanged(params);
  const updated = await offPeakTaskRepo.markTerminal(params.offPeakTaskId, {
    status,
    endedAt: Date.now(),
    ...(params.error ? { failureReason: params.error } : {}),
    ...(filesChanged !== undefined ? { filesChanged } : {}),
  });
  if (!updated) {
    // 终态不可逆出：任务已被用户先一步取消/删除等，丢弃迟到回写（幂等兜底）。
    logger.info(
      `off-peak terminal writeback dropped (already terminal) task=${params.offPeakTaskId}`,
    );
    return;
  }
  logger.info(
    `off-peak run finished task=${params.offPeakTaskId} status=${status} filesChanged=${filesChanged ?? "n/a"}`,
  );
  // 后台完成统一置未读，打开 task 时由导航链路清除（与 cron 同款）。
  void params.zcodeTaskService.setTaskUnread({
    taskId: params.taskId,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    unread: true,
  });
}

function trackOffPeakRunOutcome(params: {
  zcodeTaskService: IZCodeTaskService;
  zcodeAgentService: IZCodeAgentService;
  service: OffPeakTaskService;
  ticketId: string;
  offPeakTaskId: string;
  taskId: string;
  traceId: TraceId;
  workspacePath: string;
  workspaceIdentity?: string;
}): { admitted(): void } {
  const key = offPeakRunSubscriptionKey(params.taskId, params.traceId);
  disposeOffPeakRunSubscription(key);
  const target = {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  };
  const registration = params.service.residentExecutions.register({
    offPeakTaskId: params.offPeakTaskId,
    executionId: params.traceId,
    sessionId: params.taskId,
    ticketId: params.ticketId,
    control: (control) =>
      params.zcodeAgentService.controlOffPeakExecutionV4({ ...target, control }),
    complete: (outcome) => finalizeOffPeakRun({ ...params, outcome }),
    disposed: () => disposeOffPeakRunSubscription(key),
  });
  const disposable = params.zcodeAgentService.onDynamicOffPeakLifecycle(target)((event) => {
    if (event.executionId !== params.traceId || event.sessionId !== params.taskId) return;
    void params.service.residentExecutions
      .handle(event)
      .catch((error) => logger.warn("off-peak 生命周期处理失败:", error));
  });
  offPeakRunSubscriptions.set(key, {
    dispose() {
      disposable.dispose();
      registration.dispose();
    },
  });
  return registration;
}

/**
 * 把一次闲时任务派发提交给当前 host 的 V4 task service。
 * 首跑 createTask；进程内换票只交付现存执行，绝不重发初始 prompt。
 * 已有任务行的中断恢复仍复用会话；它不恢复旧进程的后台工作或通知。
 */
async function dispatchOffPeakRun(request: OffPeakRunDispatchRequest): Promise<{
  conversationId?: string;
  sessionId?: string;
  lifecycleManaged: true;
}> {
  const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
  const zcodeAgentService = activeServices?.getOptional(IZCodeAgentService);
  if (!zcodeTaskService || !zcodeAgentService) {
    throw new Error("ZCode task service is not initialized.");
  }
  const runtime = await ensureOffPeakRuntime();
  if (!runtime) {
    throw new Error("off-peak runtime is not available");
  }
  if (!request.serverTicketId) {
    // schedulable 必然已取号；无票派发说明快照失序，按 transient 回执等下轮（轮询会补票）。
    throw new Error("off-peak dispatch without server ticket");
  }
  const currentTask = await offPeakTaskRepo.get(request.offPeakTaskId);
  if (!currentTask || isOffPeakTerminalStatus(currentTask.status)) {
    // 调度认领与 CLI 收口可以交错；迟到的派发不能重放已经完成的任务。
    await runtime.service.residentExecutions.discardTicket(request.serverTicketId);
    const sessionId = currentTask?.conversationId ?? request.conversationId ?? request.sessionId;
    return { conversationId: sessionId, sessionId, lifecycleManaged: true };
  }
  if (runtime.service.residentExecutions.has(request.offPeakTaskId)) {
    const stillNeedsTicket = runtime.service.residentExecutions.retakeGuard(request.offPeakTaskId);
    const auth = runtime.service.residentExecutions.isUserOwned(request.offPeakTaskId)
      ? {}
      : await runtime.buildRequestAuth(request.serverTicketId);
    // 先写 running 再唤醒 CLI；否则新请求立即过期产生的 requeue 会被迟到确认覆盖。
    await offPeakTaskRepo.markRunning(request.offPeakTaskId, { startedAt: Date.now() });
    try {
      const resident = await runtime.service.residentExecutions.deliverTicket(
        request.offPeakTaskId,
        request.serverTicketId,
        auth,
      );
      if (resident)
        return {
          conversationId: resident.sessionId,
          sessionId: resident.sessionId,
          lifecycleManaged: true,
        };
      // 等凭据期间驻留执行可能完成并注销；此派发已属于续票，禁止降级成初始 prompt。
      await runtime.service.residentExecutions.discardTicket(request.serverTicketId);
      const sessionId = currentTask.conversationId ?? request.conversationId ?? request.sessionId;
      return { conversationId: sessionId, sessionId, lifecycleManaged: true };
    } catch (error) {
      // RPC 在途可能发生用户接管或整项完成，失败回执不能重新夺回调度归属。
      if (stillNeedsTicket()) await offPeakTaskRepo.requeueForContinuation(request.offPeakTaskId);
      throw error;
    }
  }
  // 闲时 Selection 只承载驻内存续跑；普通 Session entry 与 CLI 默认不持久化它。
  const idleSelection = request.modelSelection;
  if (!(await runtime.validateSelection(idleSelection))) {
    throw new OffPeakModelUnavailableError("idlePlan");
  }
  const requestAuth = await runtime.buildRequestAuth(request.serverTicketId);
  // 首次派发与复用会话的恢复派发需要在轮次事实中可区分；该字段只描述
  // 当前自动 turn 的调度阶段，不改变稳定 task ID、独立 message ID 或手动消息语义。
  const dispatchKind = resolveOffPeakDispatchKind(request);
  const offPeakRunType = dispatchKind === "resume" ? "resume" : "init";
  let trackedKey: string | null = null;
  try {
    let taskId: string;
    let traceId: TraceId;
    let promptContent = request.prompt;
    if (dispatchKind === "bound-first-run") {
      // 绑定首跑：会话内创建的任务在创建它的会话里执行（对齐 dispatchCronRun 的 targetTaskId 路径）。
      // 先探测再写配置：绑定的是用户的工作会话，忙碌时直接 transient 交给调度器退避，
      // 不能先 setMode 再被 session/send 以 -32010 拒绝（那会悄悄改掉用户会话的权限模式）。
      taskId = request.sessionId!;
      traceId = `${request.offPeakTaskId}:bound:${randomUUID()}` as TraceId;
      const workspaceScope = {
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        additionalDirectories: request.additionalDirectories,
      };
      // Bug 原因：归属收口后 tasks-index 行的 status 只镜像 CLI 的 last_outcome，
      // 永远不会是 running，原来按 listTasks(...).status === "running" 的忙碌判断已失效，
      // 闲时任务会被派发到仍在运行的绑定会话上。运行中事实只能取 syncer 的活动集合。
      const [deletedIds, activeIds] = await Promise.all([
        zcodeTaskService.listDeletedTaskIds(workspaceScope),
        zcodeTaskService.listActiveTaskIds(workspaceScope),
      ]);
      assertBoundSessionDispatchable({
        sessionId: taskId,
        deleted: deletedIds.includes(taskId),
        running: activeIds.includes(taskId),
      });
      await zcodeTaskService.resumeTask({
        ...workspaceScope,
        taskId,
        // 绑定会话首次盖章归属标记，侧栏归入闲时分组（机制同 cron targetTaskId）。
        offPeakTaskId: request.offPeakTaskId,
      });
      await zcodeTaskService.setConfigOption({
        taskId,
        traceId,
        configId: "mode",
        value: request.permissionMode,
      });
    } else if (dispatchKind === "resume") {
      // 续跑段：resume 同一 session（冷恢复水合历史；send 前必须先 resume）。
      taskId = request.conversationId!;
      // 原因：offPeakTaskId 只用于跨 talk 关联；每次自动轮必须生成独立消息身份，
      // 不能复用 task ID，也不能依赖同毫秒时间戳避免碰撞。
      traceId = `${request.offPeakTaskId}:resume:${randomUUID()}` as TraceId;
      promptContent = OFF_PEAK_RESUME_PROMPT;
      await zcodeTaskService.resumeTask({
        taskId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        additionalDirectories: request.additionalDirectories,
        // D48：pre-打点会话续跑时补写归属标记（bootstrap 回填之外的双保险）。
        offPeakTaskId: request.offPeakTaskId,
      });
      // 权限模式随派发下发（resume 后显式设置，幂等）。
      await zcodeTaskService.setConfigOption({
        taskId,
        traceId,
        configId: "mode",
        value: request.permissionMode,
      });
      // 档位是 idle Selection 的一部分，只在 sendPrompt 注入；单独写档位会污染用户会话。
    } else {
      const task = await zcodeTaskService.createTask({
        projectId: request.projectId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        additionalDirectories: request.additionalDirectories,
        // 空 Session 沿用普通初始化；idle Selection 只在下方执行中注入。
        // 在此写入会让闲时轮结束后的普通消息继续使用无票的隐藏 Provider。
        mode: request.permissionMode as ZCodeTaskMode,
        // 闲时任务是无界面的 createTask + sendPrompt 连续派发；空 session 必须在首条
        // V4 admission 内先持久化，否则 session_input 外键会先于 session 主记录写入。
        deferPersistenceUntilFirstPrompt: true,
        // 创建时即盖章持久归属标记（月亮图标/后续系统分组只看该标记，不再反查 store）。
        offPeakTaskId: request.offPeakTaskId,
      });
      taskId = task.taskId;
      traceId = task.traceId;
    }
    // 准备会话含异步 I/O；任务可能在此期间取消，首条 prompt 接纳前必须重新核对。
    const beforeAdmission = await offPeakTaskRepo.get(request.offPeakTaskId);
    if (!beforeAdmission || isOffPeakTerminalStatus(beforeAdmission.status)) {
      await runtime.service.residentExecutions.discardTicket(request.serverTicketId);
      return { conversationId: taskId, sessionId: taskId, lifecycleManaged: true };
    }
    trackedKey = offPeakRunSubscriptionKey(taskId, traceId);
    const lifecycle = trackOffPeakRunOutcome({
      zcodeTaskService,
      zcodeAgentService,
      service: runtime.service,
      ticketId: request.serverTicketId,
      offPeakTaskId: request.offPeakTaskId,
      taskId,
      traceId,
      workspacePath: request.workspacePath,
      ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    });
    await zcodeTaskService.sendPrompt({
      taskId,
      traceId,
      content: promptContent,
      clientMode: "desktop-continuous",
      // Bug 原因：闲时自动 turn 以前只注入 idle plan，没有限制工具面，模型可在后台创建
      // 持久化定时任务。首跑与续跑在此收敛，显式隐藏 CronCreate 且不伪造 cron automation 归属。
      // 闲时轮同时隐藏 OffPeakCreate，OffPeakList 只读保留。
      toolDenylist: ["CronCreate", "OffPeakCreate"],
      modelSelection: idleSelection,
      modelExecution: {
        // 闲时执行凭据只服务主 Turn；完成后不再派生自动 Memory 请求。
        memoryExtraction: "skip",
        selectionScope: "execution",
        offPeak: {
          executionId: traceId,
          ticketId: request.serverTicketId,
          providerErrorCode: "3102",
        },
        requestAuth,
        subagents: {
          foregroundModel: "submission",
          background: "allow",
        },
      },
      offPeakTaskId: request.offPeakTaskId,
      offPeakRunType,
    });
    await offPeakTaskRepo.markRunning(request.offPeakTaskId, {
      startedAt: Date.now(),
      conversationId: taskId,
      sessionId: taskId,
    });
    lifecycle.admitted();
    // 只有 init 实际新建；绑定首跑和跨票续跑只是原 Session 的后续输入。
    if (dispatchKind === "init") {
      reportHostSessionCreate(parentPort, {
        clientLanguage: resolveHostClientLanguage(),
        sessionId: taskId,
        messageId: traceId,
        source: "automation_idle",
        workspaceIdentity: request.workspaceIdentity,
      });
    }
    return { conversationId: taskId, sessionId: taskId, lifecycleManaged: true };
  } catch (error) {
    if (trackedKey) disposeOffPeakRunSubscription(trackedKey);
    throw error;
  }
}

interface CronRunDispatchRequest {
  automationId: string;
  runId: string;
  prompt: string;
  targetTaskId?: string;
  modelSelection?: ModelSelection;
  mode?: ZCodeTaskMode;
  workspacePath: string;
  workspaceIdentity?: string;
  projectId?: string | null;
  hostId?: string;
  additionalDirectories?: string[];
}

function resolveAutomationTargetServices(request: {
  workspacePath: string;
  workspaceIdentity?: string;
}): ServiceCollection {
  const remoteSession = windowRemoteConnectionRegistry.findSessionForWorkspace(request);
  if (remoteSession) {
    if (!remoteSession.workspaceIdentity) {
      throw new Error("Automation 目标 Remote Host 缺少 workspaceIdentity");
    }
    return windowRemoteConnectionRegistry.resolveScopedServices({
      kind: "remote",
      remoteSessionId: remoteSession.remoteSessionId,
      workspacePath: request.workspacePath,
      workspaceIdentity: remoteSession.workspaceIdentity,
    });
  }
  // 远程 Automation 找不到目标 logical session 时，旧派发会静默落到 Local Host，
  // 从而使用本地模型首选与 Registry。远程身份只能失败，不能跨 Environment fallback。
  if (request.workspaceIdentity && isRemoteWorkspaceIdentity(request.workspaceIdentity)) {
    throw new Error("Automation 目标 Remote Host 当前不可用");
  }
  if (!activeServices) {
    throw new Error("Local Host services are not initialized.");
  }
  return activeServices;
}

function cronRunSubscriptionKey(taskId: string, traceId: TraceId): string {
  return `${taskId}\u0000${traceId}`;
}

function parseCronRunScheduledAt(runId: string, automationId: string): number | null {
  const prefix = `${automationId}:`;
  if (!runId.startsWith(prefix)) return null;
  const value = Number(runId.slice(prefix.length).split(":")[0]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function markCronRunOutcome(params: {
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: "schedule" | "manual";
  outcome: ZCodeAutomationRunOutcome;
  error?: string;
}): void {
  void recordCronRunOutcomeBestEffort({
    ...params,
    repo: cronAutomationRepo,
    logWarn: (message, error) => logger.warn(message, error),
  });
}

function disposeCronRunSubscription(key: string): void {
  const disposable = cronRunSubscriptions.get(key);
  if (!disposable) return;
  cronRunSubscriptions.delete(key);
  disposable.dispose();
}

async function applyCronRunConfigToExistingTask(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  traceId: TraceId;
  modelSelection?: ModelSelection;
  mode?: string;
}): Promise<void> {
  let thoughtAppliedWithModel = false;
  let modeAppliedWithModel = false;
  if (params.modelSelection) {
    await params.zcodeTaskService.setAutomationSessionConfig({
      taskId: params.taskId,
      traceId: params.traceId,
      modelSelection: params.modelSelection,
      thoughtLevel: params.modelSelection.options?.reasoningLevel,
      mode: params.mode?.trim() as ZCodeTaskMode | undefined,
    });
    thoughtAppliedWithModel = true;
    modeAppliedWithModel = true;
  }
  if (!modeAppliedWithModel && params.mode?.trim()) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "mode",
      value: params.mode.trim(),
    });
  }
  if (!thoughtAppliedWithModel && params.modelSelection?.options?.reasoningLevel) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "thought_level",
      value: params.modelSelection.options.reasoningLevel,
    });
  }
}

function trackCronRunOutcome(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  traceId: TraceId;
  workspacePath: string;
  workspaceIdentity?: string;
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: "schedule" | "manual";
}): void {
  const key = cronRunSubscriptionKey(params.taskId, params.traceId);
  disposeCronRunSubscription(key);
  markCronRunOutcome({ ...params, outcome: "running" });
  const disposable = params.zcodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
    (result) => {
      if (result.inputId !== params.traceId) return;
      void settleCronRunTerminalOutcome({
        ...params,
        outcome: result.outcome,
        error: result.error,
        repo: cronAutomationRepo,
        logWarn: (message, error) => logger.warn(message, error),
      });
      // 定时任务在后台完成后统一置为未读，真正打开 task 时再由导航链路清除。
      void params.zcodeTaskService.setTaskUnread({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        unread: true,
      });
      disposeCronRunSubscription(key);
    },
  );
  const claimHeartbeat =
    params.trigger === "manual"
      ? startManualClaimHeartbeat({
          ...params,
          repo: cronAutomationRepo,
          logWarn: (message, error) => logger.warn(message, error),
        })
      : null;
  cronRunSubscriptions.set(key, {
    dispose() {
      claimHeartbeat?.dispose();
      disposable.dispose();
    },
  });
}

/**
 * 把一次 cron/manual run 直接提交给当前 host 的 V4 task service。
 * 会话内 automation 可能绑定到未激活 session，必须先恢复再应用保存的运行参数。
 */
async function dispatchCronRun(request: CronRunDispatchRequest): Promise<{
  taskId: string;
  sessionId: string;
}> {
  const targetServices = resolveAutomationTargetServices(request);
  const zcodeTaskService = targetServices.getOptional(IZCodeTaskService);
  if (!zcodeTaskService) {
    throw new Error("ZCode task service is not initialized.");
  }
  const modelSelectionService = targetServices.getOptional(IModelSelectionService);
  if (!modelSelectionService) {
    throw new Error("目标 Host Model Selection service is not initialized.");
  }
  // 长期配置是原意图；首次派发在目标 Host 解析后固定。已有 run 必须直接复用，
  // 不能因账号变化或本次 Registry 读取失败重新解释历史执行选择。
  const existingRun = await cronAutomationRepo.getRun(request.runId);
  const resolvedSubmissionModelSelection = await resolveAutomationSubmissionModelSelection({
    selection: request.modelSelection,
    fixedSelection: existingRun?.modelSelection,
    modelSelectionService,
    // Repo 已在读取前完成离线导入；不再为迁移绕行 Agent/账号服务。
    // 未迁入或损坏的新值仍由此入口明确拒绝，不能当成跟随 Workspace。
    readSelection: () =>
      cronAutomationRepo.getModelSelectionForDispatch(
        request.automationId,
        resolveWorkspaceKey(request),
      ),
  });
  const submissionModelSelection = await cronAutomationRepo.fixRunModelSelection(
    request.runId,
    resolvedSubmissionModelSelection,
  );
  let trackedKey: string | null = null;
  const workspaceKey = resolveWorkspaceKey(request);
  const trigger = request.runId.includes(":manual:") ? "manual" : "schedule";
  const scheduledAt = parseCronRunScheduledAt(request.runId, request.automationId);
  try {
    const task = request.targetTaskId
      ? { taskId: request.targetTaskId }
      : await zcodeTaskService.createTask({
          projectId: request.projectId,
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
          additionalDirectories: request.additionalDirectories,
          model: formatModelPickerValue(submissionModelSelection),
          mode: request.mode,
          thoughtLevel: submissionModelSelection.options?.reasoningLevel,
          automationId: request.automationId,
        });
    // 未绑定会话时不能沿用 createTask 的 session trace 作为首条 prompt trace：
    // CLI 无法从 inputId 还原 manual/schedule admission。
    // 建会话 trace 与执行 runId 是两种身份；两条派发路径的 prompt 都必须统一使用 runId。
    const promptTraceId = request.runId as TraceId;
    if (request.targetTaskId) {
      // 绑定会话在 app 重启或切换 workspace 后通常不处于 active；旧实现直接
      // setConfig/sendPrompt 会立即报 Session is not active，看起来像「立即运行」没有触发。
      await zcodeTaskService.resumeTask({
        taskId: task.taskId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        additionalDirectories: request.additionalDirectories,
        model: formatModelPickerValue(submissionModelSelection),
        thoughtLevel: submissionModelSelection.options?.reasoningLevel,
        automationId: request.automationId,
      });
      await applyCronRunConfigToExistingTask({
        zcodeTaskService,
        taskId: task.taskId,
        traceId: promptTraceId,
        modelSelection: submissionModelSelection,
        mode: request.mode,
      });
    }
    const botsService = targetServices.getOptional(IBotsService);
    if (botsService) {
      try {
        await watchCronRunBotDelivery({
          automationId: request.automationId,
          runId: promptTraceId,
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          taskId: task.taskId,
          repo: cronAutomationRepo,
          botsService,
        });
      } catch (error) {
        // Bot 回推是 best-effort 辅助通道；配置/凭据/订阅失败不能阻断 automation 派发与结算。
        logger.warn(
          `automation Bot delivery subscription failed automation=${request.automationId} provider=unknown`,
          error,
        );
      }
    }
    trackedKey = cronRunSubscriptionKey(task.taskId, promptTraceId);
    trackCronRunOutcome({
      zcodeTaskService,
      taskId: task.taskId,
      traceId: promptTraceId,
      workspacePath: request.workspacePath,
      workspaceIdentity: request.workspaceIdentity,
      runId: request.runId,
      automationId: request.automationId,
      workspaceKey,
      scheduledAt,
      trigger,
    });
    await zcodeTaskService.sendPrompt({
      taskId: task.taskId,
      traceId: promptTraceId,
      content: request.prompt,
      clientMode: "desktop-continuous",
      automationId: request.automationId,
    });
    // prompt 创建的定时任务带 targetTaskId，追加原会话不能计成 session_create。
    if (!request.targetTaskId) {
      reportHostSessionCreate(parentPort, {
        clientLanguage: resolveHostClientLanguage(),
        sessionId: task.taskId,
        messageId: promptTraceId,
        source: "automation_scheduled",
        workspaceIdentity: request.workspaceIdentity,
      });
    }
    return { taskId: task.taskId, sessionId: task.taskId };
  } catch (error) {
    if (trackedKey) disposeCronRunSubscription(trackedKey);
    markCronRunOutcome({
      runId: request.runId,
      automationId: request.automationId,
      workspaceKey,
      scheduledAt,
      trigger,
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function dispatchManualAutomationRun(params: {
  automation: ZCodeAutomation;
  run: ZCodeAutomationRun;
}): Promise<void> {
  logger.info(
    `direct manual automation dispatch started automation=${params.automation.automationId} runId=${params.run.runId}`,
  );
  let result: Awaited<ReturnType<typeof dispatchCronRun>>;
  try {
    result = await dispatchCronRun({
      automationId: params.automation.automationId,
      runId: params.run.runId,
      prompt: params.automation.prompt,
      targetTaskId: params.automation.targetTaskId,
      modelSelection: params.run.modelSelection ?? params.automation.modelSelection,
      mode: params.automation.mode,
      workspacePath: params.automation.workspacePath,
      workspaceIdentity: params.automation.workspaceIdentity,
      projectId: params.automation.projectId,
      hostId: params.automation.hostId,
      additionalDirectories: params.automation.additionalDirectories,
    });
  } catch (error) {
    logger.warn(
      `direct manual automation dispatch failed automation=${params.automation.automationId} runId=${params.run.runId}:`,
      error,
    );
    await settleManualDispatchFailureBestEffort({
      repo: cronAutomationRepo,
      automationId: params.automation.automationId,
      runId: params.run.runId,
      workspaceKey: params.automation.workspaceKey,
      scheduledAt: params.run.scheduledAt ?? null,
      trigger: "manual",
      dispatchError: error,
      logWarn: (message, releaseError) => logger.warn(message, releaseError),
    });
    throw error;
  }

  try {
    await cronAutomationRepo.markManualRunDispatched({
      runId: params.run.runId,
      sessionId: result.sessionId,
      dispatchedAt: Date.now(),
    });
  } catch (error) {
    // prompt 已经 accepted/queued，台账和累计次数回写失败不能伪装成派发失败并提前释放锁；
    // 真实终态仍由 trackCronRunOutcome 收口，避免同一 automation 重复排队。
    logger.warn(
      `回写 manual automation dispatched 状态与运行次数失败 automation=${params.automation.automationId} runId=${params.run.runId}`,
      error,
    );
  }
  // sendPrompt ACK 可能只表示进入 busy queue；manual claim 必须保留到对应 turn 终态。
  logger.info(
    `direct manual automation dispatch accepted automation=${params.automation.automationId} runId=${params.run.runId} taskId=${result.taskId}`,
  );
}

// Node warning 不是远端连接失败，改成结构化 warn，避免默认 stderr 被误染成 error。
process.on("warning", (warning) => logger.warn(`${warning.name}: ${warning.message}`));

registerHostNetworkTelemetry(parentPort);
// Host 进程自身的 60 秒采样：一次读数两个出口——门控后写本地
// `[memory]` 行，同一次读数换算成 HostResourceSample 经 parentPort 送 main 作 heap 来源。
// services 计数器由各 service 工厂自注册。
const hostSelfResourceTelemetry = startHostSelfResourceTelemetry({
  logger,
  collectCounters: collectServiceMemoryDiagnostics,
  postMessage: parentPort ? (message) => parentPort.postMessage(message) : undefined,
});

const runtimeProcessLifecycleReporter = {
  onSpawn(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessSpawned,
      ...event,
    });
  },
  onReady(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessReady,
      ...event,
    });
  },
  onExit(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessExited,
      ...event,
      signal: event.signal ?? null,
    });
  },
  onError(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessError,
      ...event,
    });
  },
  onException(event) {
    parentPort?.postMessage({ type: HostResponseTypes.AgentProcessException, ...event });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["processLifecycleReporter"];

const runtimeTaskReporter = {
  onRunningTaskCountChanged(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentRunningTaskCountChanged,
      runningTaskCount: event.runningTaskCount,
    });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["taskRuntimeReporter"];

const quitBlockerReporter = {
  onQuitBlockersChanged(blockers) {
    parentPort?.postMessage({ type: HostResponseTypes.QuitBlockersChanged, blockers });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["quitBlockerReporter"];

const cuaOperationStateReporter = {
  onStateChanged(event) {
    if (!parentPort) {
      return;
    }
    parentPort.postMessage({
      type: HostResponseTypes.CuaOperationState,
      ...event,
    });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["cuaOperationStateReporter"];

let untrackedPromptRpcCount = 0;
function reportHostRunningTaskCount(): void {
  runtimeTaskReporter.onRunningTaskCountChanged({
    runningTaskCount: workspaceTaskTracker.getTotalRunningTaskCount() + untrackedPromptRpcCount,
  });
}

const workspaceTaskTracker = createHostWorkspaceTaskTracker((event) => {
  parentPort?.postMessage({
    type: HostResponseTypes.WorkspaceRunningTaskCountChanged,
    ...event,
  });
  windowRemoteConnectionRegistry.setWorkspaceRunningTaskCount(event);
  reportHostRunningTaskCount();
});

function isZCodeTaskMeta(value: unknown): value is ZCodeTaskMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    "taskId" in value &&
    "workspacePath" in value &&
    "traceId" in value &&
    typeof (value as { taskId?: unknown }).taskId === "string" &&
    typeof (value as { workspacePath?: unknown }).workspacePath === "string" &&
    typeof (value as { traceId?: unknown }).traceId === "string"
  );
}

function isRemoteMirrorableStreamEvent(
  event: ZCodeStreamEvent,
): event is TaskStreamMirrorableEvent {
  return event.type !== "task_stream_mirror_batch" && event.type !== "task_snapshot_updated";
}

function createReportingRemoteZCodeTaskService<T extends object>(
  service: T,
  options?: {
    reportRunningPromptCount?: boolean;
    taskRealtimePort?: ReturnType<typeof createTaskRealtimeBridgeForHostInit>;
    materializePromptAttachments?: (params: {
      taskId: string;
      traceId: TraceId;
      content: string;
      attachments?: ZCodePromptAttachment[];
    }) => Promise<{ content: string; attachments?: ZCodePromptAttachment[] }>;
  },
): T {
  const workspaceProxyState = createHostRemoteWorkspaceProxyState();

  function forwardSessionMessageRequest(request: unknown): void {
    parentPort?.postMessage({
      type: HostResponseTypes.SessionMessageSendRequested,
      request,
    });
  }

  function subscribeSessionMessageRequests(target: T, meta: ZCodeTaskMeta): void {
    const onDynamicWorkspaceEvent = Reflect.get(target, "onDynamicWorkspaceEvent");
    if (typeof onDynamicWorkspaceEvent !== "function") {
      return;
    }
    const subscribe = onDynamicWorkspaceEvent.call(target, {
      workspacePath: meta.workspacePath,
      ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
    });
    if (typeof subscribe !== "function") {
      return;
    }
    workspaceProxyState.ensureWorkspaceSubscription(meta, () =>
      subscribe((event: unknown) => {
        if (
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "workspace_session_message_send_requested"
        ) {
          forwardSessionMessageRequest((event as { request?: unknown }).request);
        }
      }),
    );
  }

  function rememberTaskMeta(result: unknown): void {
    if (isZCodeTaskMeta(result)) {
      workspaceProxyState.rememberTaskMeta(result);
      subscribeSessionMessageRequests(service, result);
      parentPort?.postMessage({
        type: HostResponseTypes.SessionRouteAnnounce,
        route: {
          sessionId: result.taskId,
        },
      });
    }
  }

  function rememberTaskMetasFromResult(result: unknown): void {
    if (Array.isArray(result)) {
      for (const item of result) {
        rememberTaskMetasFromResult(item);
      }
      return;
    }
    rememberTaskMeta(result);
    if (typeof result !== "object" || result === null) {
      return;
    }
    const items = (result as { items?: unknown }).items;
    if (Array.isArray(items)) {
      for (const item of items) {
        rememberTaskMeta(item);
      }
    }
    const snapshot = (result as { snapshot?: unknown }).snapshot;
    if (typeof snapshot === "object" && snapshot !== null) {
      rememberTaskMeta((snapshot as { meta?: unknown }).meta);
    }
    rememberTaskMeta((result as { meta?: unknown }).meta);
  }

  async function prepareRemotePromptParams(params: {
    taskId: string;
    traceId: TraceId;
    content: string;
    attachments?: ZCodePromptAttachment[];
  }): Promise<{
    taskId: string;
    traceId: TraceId;
    content: string;
    attachments?: ZCodePromptAttachment[];
  }> {
    if (!options?.materializePromptAttachments) {
      return params;
    }
    return {
      ...params,
      ...(await options.materializePromptAttachments(params)),
    };
  }

  async function mirrorRemotePrompt(
    target: T,
    sendPrompt: (...args: unknown[]) => Promise<unknown>,
    params: {
      taskId: string;
      traceId: TraceId;
      content: string;
      attachments?: ZCodePromptAttachment[];
    },
  ): Promise<unknown> {
    const taskRealtimePort = options?.taskRealtimePort;
    const meta = workspaceProxyState.getTaskMeta(params.taskId);
    if (!taskRealtimePort || !meta) {
      return sendPrompt.call(target, params);
    }

    const mirrorTarget = {
      workspacePath: meta.workspacePath,
      workspaceIdentity: meta.workspaceIdentity,
      workspaceKey: resolveWorkspaceKey(meta),
      taskId: params.taskId,
      runId: params.traceId,
      traceId: params.traceId,
    };
    const leaseResult = await taskRealtimePort
      .acquireTaskRunLease(mirrorTarget)
      .catch((error: unknown) => {
        logger.warn("Bot remote runtime realtime lease failed:", error);
        return null;
      });
    if (!leaseResult?.acquired) {
      return sendPrompt.call(target, params);
    }

    taskRealtimePort.publishStreamOp(mirrorTarget, {
      kind: "user_message",
      messageId: `user-${params.traceId}`,
      content: params.content,
      attachments: params.attachments,
      timestamp: Date.now(),
    });

    // 写路径（send/stop/交互回执）已收敛 v4 命令面；本镜像属**读路径**——
    // taskRealtimePort → 手机 relay → 手机端
    // zcodeSessionStore 的整条消费链词表都是 ZCodeStreamEvent。两个方案的评估结论：
    // a) relay 直接转发 v4 帧、手机端消费 v4 store（正解）：需要重做 relay stream-op
    //    协议 + 手机端 store；
    // b) 帧→ZCodeStreamEvent 薄映射：等价复刻 adapter mapSessionEvent，
    //    否决。
    // 结论：本镜像保持 legacy 源不动。
    const dynamicStreamEvent = Reflect.get(target, "onDynamicStreamEvent");
    const streamDisposable =
      typeof dynamicStreamEvent === "function"
        ? dynamicStreamEvent.call(
            target,
            params.taskId,
          )((event: ZCodeStreamEvent) => {
            if (isRemoteMirrorableStreamEvent(event)) {
              taskRealtimePort.publishStreamOp(mirrorTarget, {
                kind: "stream_event",
                event,
              });
            }
          })
        : null;

    try {
      return await sendPrompt.call(target, params);
    } finally {
      // 远端 zcode-server 没有 desktop realtime port；由窗口 Host 内的
      // remote facade 接管 lease 和 stream mirror，确保 UI 能持续收到远端会话流。
      streamDisposable?.dispose();
      taskRealtimePort.releaseTaskRunLease(mirrorTarget);
    }
  }

  function finishWorkspaceTask(taskId: string, meta: ZCodeTaskMeta): void {
    workspaceProxyState.disposeTaskReadySubscription(taskId);
    workspaceTaskTracker.finish(taskId, meta);
  }

  function beginWorkspaceTask(target: T, taskId: string, meta: ZCodeTaskMeta): boolean {
    const started = workspaceTaskTracker.begin(taskId, meta);
    if (!started) {
      return false;
    }
    const onDynamicTaskReady = Reflect.get(target, "onDynamicTaskReady");
    if (typeof onDynamicTaskReady !== "function") {
      workspaceTaskTracker.finish(taskId, meta);
      throw new Error("remote ZCode task service does not expose onDynamicTaskReady");
    }
    const subscribe = onDynamicTaskReady.call(target, taskId);
    if (typeof subscribe !== "function") {
      workspaceTaskTracker.finish(taskId, meta);
      throw new Error("remote ZCode task ready event is not subscribable");
    }
    workspaceProxyState.trackTaskReady(
      taskId,
      meta,
      (listener) => subscribe(listener),
      () => finishWorkspaceTask(taskId, meta),
    );
    return true;
  }

  // remote workspace 的 ZCode Agent manager 跑在远端 server，desktop main 不能直接看到
  // `handles` 状态。sendPrompt Promise 只是远端 ACK，必须等待 task ready 才能允许回收 workspace。
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === "createTask" || property === "resumeTask") && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          rememberTaskMeta(result);
          return result;
        };
      }
      if (
        (property === "listTasks" ||
          property === "listPinnedTasks" ||
          property === "listTaskList" ||
          property === "listArchivedTasks" ||
          property === "getTaskMeta" ||
          property === "getTaskSnapshot" ||
          property === "getTaskSnapshotWithEtag") &&
        typeof value === "function"
      ) {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          rememberTaskMetasFromResult(result);
          return result;
        };
      }
      if (property === "releaseWorkspacePreparation" && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          const context = args[0];
          if (
            typeof context === "object" &&
            context !== null &&
            typeof (context as { workspacePath?: unknown }).workspacePath === "string"
          ) {
            const workspaceContext = context as {
              workspacePath: string;
              workspaceIdentity?: string;
            };
            // pooled Host 不随 tab 退出；runtime 成功释放后必须同步解除 Host 代理层引用，
            // 否则 task meta 和动态事件 listener 会在整个应用生命周期内单调增长。
            workspaceProxyState.clearWorkspace(workspaceContext);
            workspaceTaskTracker.clearWorkspace(workspaceContext);
          }
          return result;
        };
      }
      const shouldWrapSendPrompt =
        options?.reportRunningPromptCount !== false ||
        Boolean(options?.taskRealtimePort) ||
        Boolean(options?.materializePromptAttachments);
      if (property !== "sendPrompt" || typeof value !== "function" || !shouldWrapSendPrompt) {
        return value;
      }

      return async (...args: unknown[]) => {
        let trackedTask: { taskId: string; meta: ZCodeTaskMeta; started: boolean } | undefined;
        let tracksOnlyRpcLifetime = false;
        try {
          const params = args[0];
          if (
            typeof params === "object" &&
            params !== null &&
            typeof (params as { taskId?: unknown }).taskId === "string" &&
            typeof (params as { traceId?: unknown }).traceId === "string" &&
            typeof (params as { content?: unknown }).content === "string"
          ) {
            const promptParams = params as {
              taskId: string;
              traceId: TraceId;
              content: string;
              attachments?: ZCodePromptAttachment[];
            };
            const taskMeta = workspaceProxyState.getTaskMeta(promptParams.taskId) as
              | ZCodeTaskMeta
              | undefined;
            if (taskMeta) {
              trackedTask = {
                taskId: promptParams.taskId,
                meta: taskMeta,
                started: beginWorkspaceTask(target, promptParams.taskId, taskMeta),
              };
            } else if (options?.reportRunningPromptCount !== false) {
              // task meta 缺失时无法安全伪造 workspace identity；仅保留 ACK 期间的 Host 退出诊断，
              // 不让该 fallback 参与 workspace runtime 的释放裁决。
              tracksOnlyRpcLifetime = true;
              untrackedPromptRpcCount += 1;
              reportHostRunningTaskCount();
            }
            const preparedParams = await prepareRemotePromptParams(promptParams);
            return await mirrorRemotePrompt(
              target,
              value.bind(target) as (...promptArgs: unknown[]) => Promise<unknown>,
              preparedParams,
            );
          }
          if (options?.reportRunningPromptCount !== false) {
            tracksOnlyRpcLifetime = true;
            untrackedPromptRpcCount += 1;
            reportHostRunningTaskCount();
          }
          return await value.apply(target, args);
        } catch (error) {
          if (trackedTask?.started) {
            finishWorkspaceTask(trackedTask.taskId, trackedTask.meta);
          }
          throw error;
        } finally {
          if (tracksOnlyRpcLifetime) {
            untrackedPromptRpcCount = Math.max(0, untrackedPromptRpcCount - 1);
            reportHostRunningTaskCount();
          }
        }
      };
    },
  });
}

function warmUpZCodeAgent(
  services: ServiceCollection,
  context: { workspacePath?: string; workspaceIdentity?: string },
  reason: string,
): void {
  if (!context.workspacePath) {
    return;
  }
  const workspacePath = context.workspacePath;
  const workspaceIdentity = context.workspaceIdentity;
  const zcodeSessionService = services.getOptional(IZCodeSessionService);
  if (!zcodeSessionService) {
    return;
  }
  void zcodeSessionService
    .initializeWorkspace({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    })
    .then((result) => {
      if (!result.available) {
        if (result.reasonCode === "provider_not_ready") {
          logger.info(
            `ZCode agent warmup waiting for provider/model (${reason}) workspace=${workspacePath}`,
          );
          return;
        }
        logger.warn(
          `ZCode agent warmup unavailable (${reason}) workspace=${workspacePath} reason=${result.reason ?? "unknown"}`,
        );
        return;
      }
      // 模型候选和首选项已经由目标 Host ModelSelectionView 提供；workspace
      // presentation 只剩 mode 与 slash commands。预热不能为读取 presentation 额外创建
      // Agent App，否则其 MCP close 会占住协议通道并阻塞真正的 Session 初始化。
      logger.info(
        `ZCode agent warmup ready (${reason}) workspace=${workspacePath} transport=${result.transportKind ?? "unknown"}`,
      );
    })
    .catch((error) => {
      logger.warn(`ZCode agent warmup failed (${reason}) workspace=${workspacePath}:`, error);
    });
}

// 后台输出轮询仍需独立的 debug logger，不能随其他日志调用方移除而丢失工厂导入。
const rpcDebugLogger = createServiceLogger("rpc");

function logRpc(message: string, ...args: unknown[]): void {
  const level = resolveRpcLogLevel(message, ...args);
  if (level === "debug") {
    rpcDebugLogger.debug(undefined, message, ...args);
    return;
  }
  logger[level](message, ...args);
}

function formatRemoteTargetForLog(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${target.username}@${target.host}:${target.port ?? 22}`;
    case "wsl": {
      const user = target.user?.trim();
      const distro = target.distro ?? "default";
      return user ? `wsl:${distro}:${user}` : `wsl:${distro}`;
    }
    case "docker":
      return `docker:${target.container}`;
    case "server":
      return `server:${target.name?.trim() || target.url}`;
  }
}

console.log = (...args: unknown[]) => {
  rawConsole.log(...args);
  reportHostLog("info", args);
};

console.warn = (...args: unknown[]) => {
  rawConsole.warn(...args);
  reportHostLog("warn", args);
};

console.error = (...args: unknown[]) => {
  rawConsole.error(...args);
  // Electron 会把 Node warning 先走 console.error，而 process warning listener 随后还会
  // 结构化记录 warn；若这里继续上报，就会为同一个 warning 留下一条 error 和一条 warn。
  if (!shouldReportHostConsoleError(args)) {
    return;
  }
  reportHostLog("error", args);
};

/** 当前 host 已注册的服务集合，进程退出时用于统一回收本地资源 */
let databaseStartup: ReturnType<typeof createHostDatabaseStartup> | undefined;
const pendingStartupAttachments = new Map<string, () => void>();
let activeServices: ServiceCollection | null = null;
// 扩展门面（docs/plugins/extension-host.md）：InitLocal 建立服务后创建，Host 退出时断开扩展进程端口。
let windowHostExtensions: WindowHostExtensions | null = null;
/**
 * Main 推送的实时界面语言，供 ZCode endpoint 请求的 X-Client-Language。
 * 过去 Host 用进程 Intl locale（Dock 启动无 LANG 会回退 en-US）；setting.json 写入可能滞后或失败，
 * 也不能代表当前界面，所以只认 Main 的 InitLocal 初值与 application-locale-changed 变更。
 */
let applicationLocale: Locale | undefined;
/**
 * InitLocal 没带 locale（或尚未到达）时的兜底：setting.json 里持久化的界面语言。
 * 以前这种情况下 NodeApiClient 回落到进程 Intl 系统语言，会和 UI 选的语言不一致。
 * 只作兜底，Main 推送的 applicationLocale 永远优先。
 */
let persistedApplicationLocale: Locale | undefined;
function resolveHostClientLanguage(): Locale | undefined {
  return applicationLocale ?? persistedApplicationLocale;
}
let activeHostApiNetworkTransport: HostApiNetworkTransport | null = null;
let sourceServerDirectory: SourceServerDirectory | null = null;
let sourceServerConnectionManager: SourceServerConnectionManager | null = null;
let sourceServerManagementService: SourceServerManagementService | null = null;
let sourceServerArtifactPolicy: SourceServerArtifactPolicy = "release-versioned";
const sourceServerDisplayNameById = new Map<string, string>();
let sourceSettingsStateSubscription: IDisposable | null = null;
const activeWorkspaceBindRequestIds = new Set<string>();
const cancelledWorkspaceBindRequestIds = new Set<string>();
const workspaceBindAbortControllers = new Map<string, AbortController>();
const projectNavigationAbortControllers = new Map<string, AbortController>();
let sourceServerRuntimeInitializeFlight: Promise<SourceServerConnectionManager> | null = null;

function notifyProjectChange(): void {
  void activeServices
    ?.get(IBroadcastService)
    .send({ channel: "state:projects", payload: {} })
    .catch((error) => logger.warn("failed to notify project change", error));
}

/** Bot 只取得当前 Source 代际，不拥有连接，也不创建 logical tab。 */
function resolveBotProjectConnection(hostId: string): BotProjectConnection | undefined {
  const serverId = parseRemoteWorkspaceIdentity(
    buildRemoteHostWorkspaceIdentity(hostId, "/"),
  )?.sourceServerId;
  if (!serverId) return undefined;
  const registered = windowRemoteConnectionRegistry.getOnlineSource(serverId);
  if (registered) {
    const services = registered.services;
    return {
      owner: registered.capabilities?.physicalOwner?.() ?? services,
      taskService: createControllerRoutedTaskService(services.get(IZCodeTaskService), {
        kind: "local",
      }),
      modelSelectionService: services.get(IModelSelectionService),
      agentService: services.get(IZCodeAgentService),
      bindWorkspace: async (target) => {
        await registered.capabilities?.bindWorkspaceIdentity?.({
          workspacePath: target.workspacePath,
          stableWorkspaceIdentity: target.workspaceIdentity,
          legacyRouteHint: target.workspaceIdentity,
        });
      },
    };
  }
  const connection = sourceServerConnectionManager?.getOnlineConnection(serverId);
  if (!connection) return undefined;
  return {
    owner: connection.services,
    taskService: createControllerRoutedTaskService(connection.services.zcodeTaskService, {
      kind: "local",
    }),
    modelSelectionService: connection.services.modelSelectionService,
    agentService: connection.services.zcodeAgentService,
    bindWorkspace: async (target) => {
      await connection.services.sourceServerWorkspaceService.resolveWorkspace({
        workspacePath: target.workspacePath,
        legacyRouteHint: target.workspaceIdentity,
      });
    },
  };
}

function requireActiveHostApiNetworkTransport(): HostApiNetworkTransport {
  if (!activeHostApiNetworkTransport) {
    // Bug 原因：Source Server release 下载若在 Host 网络策略之外回退 global fetch，会绕过设置页代理。
    throw new Error("Window Host network transport is not initialized");
  }
  return activeHostApiNetworkTransport;
}

async function ensureSourceServerConnectionManager(): Promise<SourceServerConnectionManager> {
  if (sourceServerConnectionManager) return sourceServerConnectionManager;
  if (!sourceServerDirectory) throw new Error("Source Server directory 尚未初始化");
  if (!activeServices) throw new Error("Host services 尚未初始化");
  const directory = sourceServerDirectory;
  const remoteProjects = activeServices.get(IRemoteProjectService);
  sourceServerRuntimeInitializeFlight ??= (async () => {
    await directory.initialize();
    if (hasDisposedHostResources || sourceServerDirectory !== directory) {
      throw new Error("Source Server directory 初始化期间 Host 已释放");
    }
    const manager = new SourceServerConnectionManager({
      directory,
      admitConnection: createRemoteProjectConnectionAdmission(remoteProjects),
      onProjectChange: notifyProjectChange,
      logWarn: (message, error) => logger.warn(message, error),
      sourceServerArtifactPolicy,
      connectServer: (options) =>
        connectDesktopSourceServer(options, {
          resolveServices: (scope) => windowRemoteConnectionRegistry.resolveScopedServices(scope),
          getBots: () => activeServices?.getOptional(IBotsService),
          readDynamicWorkflowMode: async () =>
            (await activeServices?.get(ISettingService).get())?.dynamicWorkflowMode,
          onModeSyncError: (error) =>
            logger.warn("remote dynamic workflow user mode push failed", error),
        }),
    });
    sourceServerConnectionManager = manager;
    return manager;
  })().finally(() => {
    sourceServerRuntimeInitializeFlight = null;
  });
  return await sourceServerRuntimeInitializeFlight;
}
/** 本地 host services 的资源遥测订阅；远端连接的订阅由各自的 connection handle 持有。 */
let activeLocalResourceTelemetry: IDisposable | null = null;
// 资源管理器采样只在 main 请求时执行一次，Host 不维护任何周期定时器。
const hostResourceUsageResponder = createHostResourceUsageResponder({
  getAgentService: () => activeServices?.getOptional(IZCodeAgentService),
  postMessage: (message) => parentPort?.postMessage(message),
});
let activeSessionRealtimePort: ReturnType<typeof createTaskRealtimeBridgeForHostInit> = null;
let hasDisposedHostResources = false;
let disposeHostResourcesInFlight: Promise<HostShutdownResult> | null = null;

async function disposeHostRemoteConnection(connection: HostRemoteConnection): Promise<void> {
  connection.dispose();
}

async function createWindowRemoteConnectionHandle(params: {
  target: RemoteTarget;
  membershipIntent?: "add" | "retain";
  existingSourceServerId?: string;
  remoteAssets: RemoteAssetDirs;
  signal: AbortSignal;
  confirmSourceServerInstall?: boolean;
}): Promise<WindowRemoteConnectionHandle<ServiceCollection, HostRemoteConnectionCapabilities>> {
  if (!activeServices) throw new Error("Local Host services are not initialized.");
  const clientConfigService = activeServices.get(IClientConfigService);
  if (params.signal.aborted) {
    throw new Error("远程连接已取消");
  }
  const closeListeners = new Set<(event: WindowRemoteConnectionCloseEvent) => void>();
  const reconnectListeners = new Set<() => void>();
  let topicResourceRelay: ReturnType<typeof createWindowTopicResourceRelay> | undefined;
  const notifyClose = (event: WindowRemoteConnectionCloseEvent) => {
    topicResourceRelay?.dispose();
    for (const listener of closeListeners) {
      listener(event);
    }
  };
  let connection: HostRemoteConnection;
  let managedProfile: import("@zcode/shared").ConnectionProfile | undefined;
  let reusedConnectionTarget: RemoteTarget | undefined;
  let managerStateSubscription: { dispose(): void } | undefined;
  let managerConnectionInvalidatedSubscription: { dispose(): void } | undefined;
  let managerReconnectSubscription: { dispose(): void } | undefined;
  let services: ServiceCollection;
  let resourceTelemetry: IDisposable | undefined;
  const refreshResourceTelemetry = () => {
    resourceTelemetry?.dispose();
    // Source 重连会替换 services；遥测也必须释放旧订阅并挂到新一代代理，避免重连后静默丢样本。
    resourceTelemetry = registerHostServiceResourceTelemetry({
      services,
      postMessage: (message) => parentPort?.postMessage(message),
      runtimeSurface: "remote",
      // SSH/WSL/Docker 也会复用兼容的旧 Source；所有 Server 都须声明能力才订阅新增事件。
      telemetrySupported: connection.serverInfo.capabilities.processResourceTelemetry === true,
      remoteConversationTelemetrySupported:
        connection.serverInfo.capabilities.remoteConversationTelemetry === true,
      environmentKey: resolveResourceTelemetryEnvironmentKey(
        params.target,
        connection.serverInfo.serverId,
      ),
      onError: (error) => logger.warn("remote resource telemetry subscription failed", error),
    });
  };
  let lastNotifiedRecoveryAttempt = 0;
  let disposed = false;
  let sourceClosed = false;
  let projectSubscription: { dispose(): void } | undefined;
  const detachOwnSourceSettings = () => {
    const sourceId = connection?.serverInfo.serverId;
    if (!sourceId || params.target.kind !== "server") return;
    const current = windowRemoteConnectionRegistry.getOnlineSource(sourceId);
    if (!current || current.services === services)
      windowHostAttachmentRegistry.detachSourceSettingsAttachments(sourceId);
  };
  if (params.target.kind === "server") {
    if (params.existingSourceServerId) throw new Error("project.host-offline");
    if (!activeServices) throw new Error("Host services 尚未初始化");
    const admission = await prepareRemoteServerConnection({
      service: activeServices.get(IRemoteProjectService),
      credentials: activeServices.get(ICredentialService),
      target: params.target,
      intent: params.membershipIntent ?? "add",
    });
    params.signal.throwIfAborted();
    topicResourceRelay = createWindowTopicResourceRelay({
      getPeerAgentService: () => connection?.services.zcodeAgentService,
      resolveServices: (scope) => windowRemoteConnectionRegistry.resolveScopedServices(scope),
      getBots: () => activeServices?.getOptional(IBotsService),
    });
    try {
      connection = await connectServerRemote(admission.target, {
        signal: params.signal,
        fetchImpl: requireActiveHostApiNetworkTransport().fetch,
        commitMembership: admission.commit,
        topicResourceChannel: topicResourceRelay.channel,
        onClose: ({ code, reason }) => {
          sourceClosed = true;
          detachOwnSourceSettings();
          notifyClose({ exitCode: code, signal: null, ...(reason ? { error: reason } : {}) });
        },
      });
    } catch (error) {
      topicResourceRelay.dispose();
      throw error;
    }
  } else {
    if (!sourceServerDirectory) {
      throw new Error("Source Server manager 尚未初始化");
    }
    const manager = await ensureSourceServerConnectionManager();
    const existingProfile = params.existingSourceServerId
      ? (await sourceServerDirectory.snapshot()).profiles.find(
          (item) => item.sourceServerId === params.existingSourceServerId,
        )
      : undefined;
    const existingConnection = params.existingSourceServerId
      ? manager.getOnlineConnection(params.existingSourceServerId)
      : undefined;
    if (params.existingSourceServerId && (!existingProfile || !existingConnection))
      throw new Error("project.host-offline");
    const { profile, connection: managed } =
      existingProfile && existingConnection
        ? { profile: existingProfile, connection: existingConnection }
        : await connectSourceServerTarget(sourceServerDirectory, manager, {
            membershipIntent: params.membershipIntent,
            target: params.target,
            allowInstall: params.confirmSourceServerInstall === true,
            resolveRelease: async (probe, target, options) =>
              await resolveSourceServerReleaseAsset(
                probe,
                params.remoteAssets,
                target,
                {
                  fetch: requireActiveHostApiNetworkTransport().fetch,
                },
                options,
              ),
            context: {
              signal: params.signal,
              onLog: (event) => {
                const progress =
                  event.progress == null
                    ? ""
                    : ` ${(Math.max(0, Math.min(1, event.progress)) * 100).toFixed(1)}%`;
                // 上传与本机下载的进度消息自带百分比和速度，原样输出。
                const message =
                  event.progress == null || /^(?:upload|download) progress:/u.test(event.message)
                    ? `[source-server:${event.phase}] ${event.message}`
                    : `[source-server:${event.phase}] upload progress (${event.message}):${progress}`;
                remoteConnectionProgressContext.report(event.level ?? "info", [message]);
              },
            },
          });
    managedProfile = profile;
    reusedConnectionTarget = managed.reusedConnectionTarget;
    const sourceDirectorySnapshot = await sourceServerDirectory.snapshot();
    for (const server of sourceDirectorySnapshot.servers) {
      sourceServerDisplayNameById.set(server.sourceServerId, server.displayName);
    }
    managerStateSubscription = manager.onDidChangeState((state) => {
      if (state.profileId !== profile.profileId) return;
      if (state.state === "online") {
        lastNotifiedRecoveryAttempt = 0;
        return;
      }
      const closeEvent = createSourceServerRecoveryCloseEvent(state);
      if (!closeEvent) return;
      if (state.state === "retrying" && state.recoveryAttempt === lastNotifiedRecoveryAttempt) {
        return;
      }
      if (state.state === "retrying") {
        lastNotifiedRecoveryAttempt = state.recoveryAttempt ?? lastNotifiedRecoveryAttempt;
      }
      notifyClose(closeEvent);
    });
    connection = {
      serverInfo: managed.serverInfo,
      services: managed.services,
      dispose() {
        // Bug 原因：Window registry handle 是 logical/attachment lease，不是 Source connection owner。
        // 旧 entry 取消或迟到恢复时若调用 manager.disconnect，会拆掉新 entry 正在共享的
        // Source。真实物理连接由 SourceServerConnectionManager 在显式断开或 Host shutdown 回收。
      },
    };
    managerConnectionInvalidatedSubscription = manager.onDidInvalidateConnection((event) => {
      if (event.sourceServerId !== managed.sourceServerId || disposed) return;
      // Bug 原因：物理 Source connection 被更新或其当前 Profile 被删除时，若不先按
      // Source 通知 Registry，已有 logical workspace 会继续以 online 状态持有失效 services。
      // 只有显式列出的原因可恢复：更新与重启远端服务完成后由 reconnect 换代。删除当前 Profile
      // 属于用户显式断开，必须发布 terminal close；未来新增的原因默认不可恢复，需在此显式声明。
      notifyClose({
        exitCode: null,
        signal: null,
        recoverable: event.reason === "update" || event.reason === "restart",
      });
    });
    managerReconnectSubscription = manager.onDidReconnect((reconnected) => {
      if (reconnected.sourceServerId !== managed.sourceServerId || disposed) return;
      connection = {
        serverInfo: reconnected.serverInfo,
        services: reconnected.services,
        dispose() {
          // 同上：只释放当前 wrapper 的订阅，不跨 lease 关闭共享 Source。
        },
      };
      services = createServerRemoteWorkspaceServiceCollection({
        clientConfigService,
        connectionServices: reconnected.services,
        virtualProjects: reconnected.serverInfo.capabilities.virtualProjects,
        serverId: reconnected.serverInfo.serverId,
        sourceServices: activeServices ?? undefined,
        targetKind: params.target.kind,
      });
      refreshResourceTelemetry();
      lastNotifiedRecoveryAttempt = 0;
      for (const listener of reconnectListeners) listener();
    });
  }

  if (params.signal.aborted) {
    topicResourceRelay?.dispose();
    await disposeHostRemoteConnection(connection);
    throw new Error("远程连接已取消");
  }

  services = createServerRemoteWorkspaceServiceCollection({
    clientConfigService,
    connectionServices: connection.services,
    virtualProjects: connection.serverInfo.capabilities.virtualProjects,
    serverId: connection.serverInfo.serverId,
    targetKind: params.target.kind,
    sourceServices: activeServices ?? undefined,
  });
  if (params.target.kind === "server") {
    projectSubscription = connection.services.broadcastService.onMessage((event) => {
      if (!disposed && !sourceClosed && event.channel === "state:projects") notifyProjectChange();
    });
  }
  refreshResourceTelemetry();
  // 桌面 attachment 对远端媒体走 Host loopback Range 数据面；services 会随 Source 重连换代，
  // 工厂在调用时再取当前 file service。server 直连保持 renderer inline 读取。
  const remoteMediaPreviewFactory =
    params.target.kind === "server" || !remoteMediaRangePreviewEnabled
      ? undefined
      : (scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>) =>
          createRemoteMediaPreviewProxy({
            fileService: services.get(IFileService),
            logger: {
              debug: (message, metadata) => {
                if (process.env.NODE_ENV !== "production") logger.info(message, metadata);
              },
              warn: (message, metadata) => logger.warn(message, metadata),
            },
            scope,
            requestLimiter: hostRemoteMediaRequestLimiter,
          });

  return {
    ...(reusedConnectionTarget ? { reusedConnectionTarget } : {}),
    get services() {
      return services;
    },
    capabilities: {
      sourceServerId: connection.serverInfo.serverId,
      physicalOwner: () => connection.services,
      get virtualProjects() {
        return connection.serverInfo.capabilities.virtualProjects;
      },
      ...(remoteMediaPreviewFactory ? { remoteMediaPreviewFactory } : {}),
      persistentSourceConnection: true,
      ...(managedProfile ? { profileId: managedProfile.profileId } : {}),
      ...(managedProfile
        ? {
            promptAttachmentTransferFactory: (
              scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
            ) => {
              if (!sourceServerConnectionManager) throw new Error("Source Server is unavailable");
              return createRemotePromptAttachmentTransferService(
                sourceServerConnectionManager.getFileTransfer(connection.serverInfo.serverId),
                {
                  scope,
                  onJanitorError: (error) => logger.warn("remote attachment janitor failed", error),
                },
              );
            },
          }
        : {}),
      ...(managedProfile && sourceServerDirectory
        ? {
            bindWorkspaceIdentity: async (input) => {
              input.signal?.throwIfAborted();
              const currentRouteHint = buildRemoteWorkspaceIdentity(
                input.workspacePath,
                params.target,
              );
              const legacyRouteHint = await sourceServerDirectory!.resolveLegacyWorkspaceIdentity({
                profileId: managedProfile!.profileId,
                workspacePath: input.workspacePath,
                fallback: input.legacyRouteHint ?? currentRouteHint,
              });
              input.signal?.throwIfAborted();
              await connection.services.sourceServerWorkspaceService.resolveWorkspace({
                workspacePath: input.workspacePath,
                legacyRouteHint,
              });
            },
          }
        : {
            bindWorkspaceIdentity: async (input) => {
              await connection.services.sourceServerWorkspaceService.resolveWorkspace({
                workspacePath: input.workspacePath,
              });
            },
          }),
      ...(managedProfile && sourceServerDirectory
        ? {
            recordWorkspaceOpen: async (input) => {
              await sourceServerDirectory?.recordWorkspaceOpen({
                profileId: managedProfile!.profileId,
                sourceServerId: connection.serverInfo.serverId,
                ...input,
              });
            },
          }
        : {}),
    },
    onDidClose(listener) {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    onDidReconnect(listener) {
      reconnectListeners.add(listener);
      return { dispose: () => reconnectListeners.delete(listener) };
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      detachOwnSourceSettings();
      topicResourceRelay?.dispose();
      closeListeners.clear();
      reconnectListeners.clear();
      managerStateSubscription?.dispose();
      managerConnectionInvalidatedSubscription?.dispose();
      managerReconnectSubscription?.dispose();
      projectSubscription?.dispose();
      resourceTelemetry?.dispose();
      await disposeHostRemoteConnection(connection);
    },
  };
}

// 项目树/发送前目录解析的远端身份登记，按物理连接去重（见 createRemoteIdentityRegistrationCache）。
// Registry 路径带 Host 目录的 legacy hint，Manager 路径不带；两者分开缓存，各自的首次登记请求保持不变。
// 工作区打开（prepareWorkspaceIdentity）不走这里，打开时仍按 R3 §9.2 惰性合并旧变体。
const registryProjectIdentityRegistrations = createRemoteIdentityRegistrationCache();
const managerProjectIdentityRegistrations = createRemoteIdentityRegistrationCache();

const windowRemoteConnectionRegistry = createWindowRemoteConnectionRegistry<
  ServiceCollection,
  HostRemoteConnectionCapabilities
>({
  connect: (request) => createWindowRemoteConnectionHandle(request),
  createId: randomUUID,
  onConnectionChanged: notifyProjectChange,
  resolveSourceServerId: (handle) => handle.capabilities?.sourceServerId,
  shouldKeepConnectionAlive: (handle) => handle.capabilities?.persistentSourceConnection === true,
  prepareWorkspaceIdentity: async (handle, input) => {
    // 连接向导据此显示“打开项目目录”这一步；失败（含超时）时同一步标红。只在连接请求的上下文内上报。
    remoteConnectionProgressContext.report("info", [
      `[source-server:workspace] Preparing ${input.workspacePath}`,
    ]);
    try {
      await prepareRemoteWorkspaceIdentity(
        handle.services.get(IFileService),
        input,
        handle.capabilities?.bindWorkspaceIdentity,
      );
    } catch (error) {
      if (!input.signal?.aborted) {
        remoteConnectionProgressContext.report("error", [
          `[source-server:workspace] ${error instanceof Error ? error.message : String(error)}`,
        ]);
      }
      throw error;
    }
  },
  releaseWorkspace: async (services, context) => {
    await services.get(IZCodeTaskService).releaseWorkspacePreparation({
      workspacePath: context.workspacePath,
      ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
      provider: "glm",
    });
    logger.info(
      `released WSL workspace runtime, workspaceKey=${context.workspaceIdentity?.trim() || context.workspacePath}`,
    );
  },
  onWorkspaceReleaseError: (context, error) => {
    logger.warn(
      `failed to release WSL workspace runtime, workspaceKey=${context.workspaceIdentity?.trim() || context.workspacePath}`,
      error,
    );
  },
  onSessionClosed: (event) => {
    // logical session 已离线时 attachment 仍持有旧 services/订阅；后续 sessionId
    // 换代只释放 transport，无法按旧 ID 找回这些端口。Host 在失效源头统一关闭所有 clientMode。
    windowHostAttachmentRegistry.detachRemoteSessionAttachments(event.remoteSessionId);
    const session = windowRemoteConnectionRegistry.getSession(event.remoteSessionId);
    if (session?.workspacePath && session.workspaceIdentity) {
      windowHostControllerRuntime.disconnectSource({
        kind: "remote",
        ...(session.sourceServerId ? { sourceServerId: session.sourceServerId } : {}),
        remoteSessionId: event.remoteSessionId,
        workspacePath: session.workspacePath,
        workspaceIdentity: session.workspaceIdentity,
      });
    }
    parentPort?.postMessage({
      type: HostResponseTypes.RemoteWorkspaceClosed,
      remoteSessionId: event.remoteSessionId,
      reason: "connection-closed",
      exitCode: event.exitCode,
      signal: event.signal,
      ...(event.recoverable !== undefined ? { recoverable: event.recoverable } : {}),
      ...(event.error ? { error: event.error } : {}),
      ...(event.recoveryAttempt ? { recoveryAttempt: event.recoveryAttempt } : {}),
      ...(event.recoveryLimit ? { recoveryLimit: event.recoveryLimit } : {}),
      ...(event.recoveryBudgetExhausted !== undefined
        ? { recoveryBudgetExhausted: event.recoveryBudgetExhausted }
        : {}),
      ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
      ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
    });
    logWindowHostTopology("remote-connection-closed");
  },
  onSessionReconnected: async ({
    previous,
    current,
    services: currentServices,
    isCurrent,
    commit,
  }) => {
    if (
      !previous.workspacePath ||
      !previous.workspaceIdentity ||
      !current.workspacePath ||
      !current.workspaceIdentity
    ) {
      throw new Error("Source 重连换代缺少 workspace scope");
    }
    const previousScope = {
      kind: "remote" as const,
      ...(previous.sourceServerId ? { sourceServerId: previous.sourceServerId } : {}),
      remoteSessionId: previous.remoteSessionId,
      workspacePath: previous.workspacePath,
      workspaceIdentity: previous.workspaceIdentity,
    };
    const currentScope = {
      kind: "remote" as const,
      ...(current.sourceServerId ? { sourceServerId: current.sourceServerId } : {}),
      ...(current.sourceServerId && sourceServerDisplayNameById.get(current.sourceServerId)
        ? {
            serverDisplayName: sourceServerDisplayNameById.get(current.sourceServerId),
          }
        : {}),
      remoteSessionId: current.remoteSessionId,
      workspacePath: current.workspacePath,
      workspaceIdentity: current.workspaceIdentity,
    };
    await windowHostControllerRuntime.replaceDisconnectedSource(
      previousScope,
      {
        scope: currentScope,
        taskService: currentServices.get(IZCodeTaskService),
        agentService: currentServices.getOptional(IZCodeAgentService),
        sourceAvailability: "online",
      },
      {
        canCommit: isCurrent,
        rollbackOnFailure: true,
      },
    );
    if (!commit()) {
      throw new Error("Source 重连换代在 Controller 提交后失去 Registry owner");
    }
    try {
      parentPort?.postMessage({
        type: HostResponseTypes.RemoteWorkspaceReconnected,
        previousRemoteSessionId: previous.remoteSessionId,
        descriptor: {
          ...(current.sourceServerId ? { sourceServerId: current.sourceServerId } : {}),
          remoteSessionId: current.remoteSessionId,
          target: current.target,
          workspacePath: current.workspacePath,
          workspaceIdentity: current.workspaceIdentity,
          generation: current.generation,
        },
      });
    } catch (error) {
      // Controller 已提交新 generation 后不能再让 Registry 回滚；parentPort 失效意味着
      // Window Host 与 Main 的进程通道正在终止，交给既有 Host shutdown 回收全部 owner。
      logger.error("failed to publish committed remote workspace replacement", error);
    }
    logWindowHostTopology("remote-connection-reconnected");
  },
  onSessionReconnectError: (error) => {
    logger.warn("failed to replace Source Server logical sessions after reconnect", error);
  },
});

const windowHostControllerRuntime = createWindowHostControllerRuntime({
  onRunStarted: (run) =>
    parentPort?.postMessage({
      type: HostResponseTypes.Broadcast,
      message: { channel: "mobile-push:run", payload: run },
    }),
  onNotification: (event) =>
    parentPort?.postMessage({
      type: HostResponseTypes.Broadcast,
      message: { channel: "mobile-push:event", payload: event },
    }),
  createId: randomUUID,
  readHostTaskList: (query) => {
    if (!activeServices) throw new Error("Window Host services unavailable");
    return activeServices.get(IZCodeTaskService).listTaskList(query);
  },
  onSourceError: (scope, operation, error) => {
    logger.warn(
      `window Controller source ${operation} failed, scope=${scope.kind}, workspaceKey=${scope.workspaceIdentity?.trim() || scope.workspacePath}`,
      error,
    );
  },
  // 归档 / 删除任务只改 task index，tab 仍挂在原任务名下：任务离开列表后没有 scope 能显示它，
  // 出声的 tab 又受 residency 保护不被逐出，页面会一直在后台播放。Controller 收到任务归档/删除事实后由这里关闭属主 tab。
  onTasksArchivedOrDeleted: (scope, taskIds) => {
    const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
    for (const taskId of taskIds) {
      void browserControlMainBridge
        .execute({
          sessionId: taskId,
          workspaceKey,
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
          ...(scope.kind === "remote" && scope.remoteSessionId
            ? { remoteSessionId: scope.remoteSessionId }
            : {}),
          command: { method: "closeSession", closeTabs: true },
        })
        .then((result) => {
          if (!result.ok) {
            logger.warn(
              `archived/deleted task browser tabs cleanup failed, taskId=${taskId}, code=${result.error?.code ?? "unknown"}`,
            );
          }
        })
        .catch((error) =>
          logger.warn(`archived/deleted task browser tabs cleanup failed, taskId=${taskId}`, error),
        );
    }
  },
  resolveSource: (scope) => {
    const remoteSession = windowRemoteConnectionRegistry.findSessionForWorkspace(scope);
    if (remoteSession?.workspacePath && remoteSession.workspaceIdentity) {
      const controllerScope = {
        kind: "remote" as const,
        ...(remoteSession.sourceServerId ? { sourceServerId: remoteSession.sourceServerId } : {}),
        ...(remoteSession.sourceServerId &&
        sourceServerDisplayNameById.get(remoteSession.sourceServerId)
          ? {
              serverDisplayName: sourceServerDisplayNameById.get(remoteSession.sourceServerId),
            }
          : {}),
        remoteSessionId: remoteSession.remoteSessionId,
        workspacePath: remoteSession.workspacePath,
        workspaceIdentity: remoteSession.workspaceIdentity,
      };
      if (remoteSession.sourceAvailability !== "online") {
        return {
          scope: controllerScope,
          sourceAvailability: "offline" as const,
        };
      }
      const services = windowRemoteConnectionRegistry.resolveScopedServices(controllerScope);
      return {
        scope: controllerScope,
        taskService: services.get(IZCodeTaskService),
        agentService: services.getOptional(IZCodeAgentService),
        sourceAvailability: "online" as const,
      };
    }
    // 远程 history scope 未连接或已被移除时，绝不能落回本地 tasks-index。
    if (scope.workspaceIdentity && isRemoteWorkspaceIdentity(scope.workspaceIdentity)) {
      // 项目树不要求打开 workspace tab；列表命令可复用稳定 Source 的现有物理连接，不能伪造 logical session。
      const identity = parseRemoteWorkspaceIdentity(scope.workspaceIdentity);
      const connection =
        identity?.kind === "server" &&
        identity.sourceServerId &&
        identity.workspacePath === scope.workspacePath
          ? sourceServerConnectionManager?.getOnlineConnection(identity.sourceServerId)
          : undefined;
      const registered =
        identity?.kind === "server" &&
        identity.sourceServerId &&
        identity.workspacePath === scope.workspacePath
          ? windowRemoteConnectionRegistry.getOnlineSource(identity.sourceServerId)
          : undefined;
      if (identity?.kind === "server" && identity.sourceServerId && (connection || registered))
        return {
          scope: {
            kind: "remote" as const,
            sourceServerId: identity.sourceServerId,
            workspacePath: scope.workspacePath,
            workspaceIdentity: scope.workspaceIdentity,
          },
          taskService:
            connection?.services.zcodeTaskService ?? registered!.services.get(IZCodeTaskService),
          agentService:
            connection?.services.zcodeAgentService ??
            registered!.services.getOptional(IZCodeAgentService),
          sourceAvailability: "online" as const,
        };
      return null;
    }
    const taskService = activeServices?.getOptional(IZCodeTaskService);
    if (!taskService) {
      return null;
    }
    return {
      scope: {
        kind: "local" as const,
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      },
      taskService,
      agentService: activeServices?.getOptional(IZCodeAgentService),
      sourceAvailability: "online" as const,
    };
  },
});

// 手机 project.readTree 叠加实时待处理交互；只有手机 attachment 存在时才监听投影并广播。
const webRemoteProjectTreeActivity = createWebRemoteProjectTreeActivityBridge({
  readRows: () => windowHostControllerRuntime.readTaskRows(),
  subscribeRows: (onChange) => windowHostControllerRuntime.subscribeTaskRows(onChange),
  notifyProjectChange,
});

function wireLocalResourceTelemetry(services: ServiceCollection): void {
  activeLocalResourceTelemetry?.dispose();
  activeLocalResourceTelemetry = registerHostServiceResourceTelemetry({
    services,
    postMessage: (message) => parentPort?.postMessage(message),
    runtimeSurface: "local",
    onError: (error) => logger.warn("local resource telemetry subscription failed", error),
  });
}

function disposeLocalResourceTelemetry(): void {
  try {
    activeLocalResourceTelemetry?.dispose();
  } catch {
    // 资源遥测释放失败不能阻塞 Host 的既有 shutdown barrier。
  } finally {
    activeLocalResourceTelemetry = null;
  }
}

type ExposedServicePortHandle = {
  server: IChannelServer & { ready(): void };
  dispose(): void;
};

function createControllerRoutedTaskService(
  base: IZCodeTaskService,
  attachmentScope: WindowHostAttachmentScope,
): IZCodeTaskService {
  const route = async (
    params: {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    },
    mutation:
      | { kind: "pin"; pinned: boolean }
      | { kind: "archive"; archived: boolean }
      | { kind: "delete" }
      | { kind: "mark-read"; expectedUnreadAt?: number }
      | { kind: "mark-unread" },
  ) =>
    windowHostControllerRuntime.service.mutateTask({
      address: await windowHostControllerRuntime.resolveTaskAddress({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        attachmentScope,
      }),
      mutation,
    });

  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "setTaskPinned") {
        return async (params: Parameters<IZCodeTaskService["setTaskPinned"]>[0]) => {
          const meta = await route(params, {
            kind: "pin",
            pinned: params.pinned,
          });
          if (!meta) throw new Error("pin mutation 后 task 投影缺失");
          return meta;
        };
      }
      if (property === "archiveTask" || property === "unarchiveTask") {
        return async (
          params:
            | Parameters<IZCodeTaskService["archiveTask"]>[0]
            | Parameters<IZCodeTaskService["unarchiveTask"]>[0],
        ) => {
          const meta = await route(params, {
            kind: "archive",
            archived: property === "archiveTask",
          });
          if (!meta) throw new Error("archive mutation 后 task 投影缺失");
          return meta;
        };
      }
      if (property === "deleteTask") {
        return async (params: Parameters<IZCodeTaskService["deleteTask"]>[0]) => {
          await route(params, { kind: "delete" });
        };
      }
      if (property === "deleteArchivedTasks") {
        return async (params: Parameters<IZCodeTaskService["deleteArchivedTasks"]>[0]) => {
          if (params.taskIds.length === 0) {
            return { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] };
          }
          return windowHostControllerRuntime.service.deleteArchivedTasks({
            address: await windowHostControllerRuntime.resolveTaskAddress({
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              taskId: params.taskIds[0]!,
              attachmentScope,
              allowMissingTask: true,
            }),
            taskIds: params.taskIds,
          });
        };
      }
      if (property === "deleteArchivedTask") {
        return async (params: Parameters<IZCodeTaskService["deleteArchivedTask"]>[0]) =>
          windowHostControllerRuntime.service.deleteArchivedTask({
            address: await windowHostControllerRuntime.resolveTaskAddress({
              ...params,
              attachmentScope,
              allowMissingTask: true,
            }),
          });
      }
      if (property === "setTaskUnread") {
        return async (params: Parameters<IZCodeTaskService["setTaskUnread"]>[0]) => {
          const meta = await route(
            params,
            params.unread
              ? { kind: "mark-unread" }
              : {
                  kind: "mark-read",
                  ...(params.expectedUnreadAt != null
                    ? { expectedUnreadAt: params.expectedUnreadAt }
                    : {}),
                },
          );
          if (!meta) throw new Error("unread mutation 后 task 投影缺失");
          return meta;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      if (
        typeof value === "function" &&
        [
          "getBotGroupTaskBlockReason",
          "cancelBotGroupInput",
          "submitBotGroupInput",
          "readBotTopicSummaries",
        ].includes(String(property))
      ) {
        return (params: Record<string, unknown>) =>
          value.call(target, bindBotGroupTaskScope(params, attachmentScope));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const terminalOwners = createWindowHostTerminalOwners((error) => {
  logger.warn("failed to dispose mobile terminal owner", error);
});

function exposeServicesOnMessagePort(
  port: Electron.MessagePortMain,
  services: ServiceCollection,
  deferInit: boolean,
  clientMode: ZCodeAgentV4ClientMode = "desktop-continuous",
  attachmentScope: WindowHostAttachmentScope = { kind: "local" },
  capabilities?: HostRemoteConnectionCapabilities,
  terminalOwnerId?: string,
): ExposedServicePortHandle {
  const terminal = services.getOptional(ITerminalService);
  const legacyTerminalScope =
    clientMode === "web-remote-replayable" && terminal && !terminalOwnerId
      ? createTerminalScope(terminal, (error) =>
          logger.warn("failed to dispose mobile attachment terminal", error),
        )
      : undefined;
  const scopedTerminal =
    clientMode === "web-remote-replayable" && terminal
      ? terminalOwnerId
        ? terminalOwners.bind(
            terminalOwnerId,
            attachmentScope.kind === "remote"
              ? `remote:${attachmentScope.remoteSessionId}`
              : "local",
            terminal,
          )
        : legacyTerminalScope!.service
      : undefined;
  const wrappedPort = wrapElectronPort(port);
  const protocol = new MessagePortProtocol(wrappedPort);
  // remote 模式延迟发送 Initialize：远程建连需要时间，如果构造时就发 Initialize，
  // renderer 会立即发请求但 channel 还没注册，导致 "Unknown channel" 超时错误。
  // attach 模式复用已就绪服务，必须立即初始化新的 RPC MessagePort。
  logger.info(`creating ChannelServer (deferInit=${deferInit})`);
  const rawServer = new ChannelServer(protocol, "host", 1000, deferInit);
  const loggedServer = new LoggingChannelServer(rawServer, logRpc);
  const server = new NetworkTelemetryChannelServer(loggedServer);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionContext = { connectionId: `host-rpc-${randomUUID()}`, clientMode };
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, connectionContext)
    : undefined;
  services.register(IWindowControllerService, windowHostControllerRuntime.service);
  // 未读自动写入只归窗口 base renderer；手机和 remote facade 不能重复消费同一完成信号。
  const controllerAttachment = windowHostControllerRuntime.createAttachmentService(
    clientMode === "desktop-continuous" && attachmentScope.kind === "local",
  );
  const overrides = new Map<string, unknown>([
    [IWindowControllerService.channelName, controllerAttachment],
  ]);
  // 手机可从任意远端 workspace 重建 Root；侧栏组织服务仍归控制端，不能随当前执行 attachment 换库。
  if (
    clientMode === "web-remote-replayable" &&
    attachmentScope.kind === "remote" &&
    activeServices
  ) {
    overrides.set(IProjectService.channelName, activeServices.get(IProjectService));
    overrides.set(IRemoteProjectService.channelName, activeServices.get(IRemoteProjectService));
    services.register(ITaskGroupService, activeServices.get(ITaskGroupService));
  }
  // 远端媒体必须按 attachment 的 clientMode 选择数据面：桌面使用 Host loopback Range，手机保持 inline。
  const remoteMediaPreviewProxy =
    attachmentScope.kind === "remote" && clientMode === "desktop-continuous"
      ? capabilities?.remoteMediaPreviewFactory?.(attachmentScope)
      : undefined;
  if (remoteMediaPreviewProxy) {
    overrides.set(IMediaPreviewService.channelName, remoteMediaPreviewProxy.service);
  }
  // R3 的 Source 本地 transfer 无法读取 Desktop localPath；跨机 staging 必须在 owning
  // Window Host attachment 注入，复用当前 transport。桌面/手机不另建 runtime 或业务队列。
  const remotePromptAttachmentTransfer =
    attachmentScope.kind === "remote"
      ? capabilities?.promptAttachmentTransferFactory?.(attachmentScope)
      : undefined;
  const { dispose: disposePromptAttachmentTransfer, ...promptAttachmentService } =
    remotePromptAttachmentTransfer ?? {};
  if (remotePromptAttachmentTransfer) {
    // dispose 只属于 Host attachment 生命周期，不暴露为 Renderer RPC。
    overrides.set(IPromptAttachmentTransferService.channelName, promptAttachmentService);
  }
  const taskService = services.getOptional(IZCodeTaskService);
  if (taskService) {
    overrides.set(
      IZCodeTaskService.channelName,
      createControllerRoutedTaskService(taskService, attachmentScope),
    );
  }
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  const conversationShareService = services.getOptional(IConversationShareService);
  if (conversationShareService) {
    // Share service 若继续持有 raw Agent，会绕过当前 MessagePort 已握手的 trusted carrier，
    // rowsRange 会以 connection untrusted 拒绝。必须复用同一 attachment connection scope。
    overrides.set(
      IConversationShareService.channelName,
      scopeConversationShareServiceForAttachment(
        conversationShareService,
        clientMode,
        connectionScope?.service,
        connectionContext,
      ),
    );
  }
  if (scopedTerminal) overrides.set(ITerminalService.channelName, scopedTerminal);
  const isWebRemoteAttachment = clientMode === "web-remote-replayable";
  const baseProjectService = isWebRemoteAttachment
    ? ((overrides.get(IProjectService.channelName) as IProjectService | undefined) ??
      services.getOptional(IProjectService))
    : undefined;
  if (baseProjectService) {
    overrides.set(
      IProjectService.channelName,
      webRemoteProjectTreeActivity.decorate(baseProjectService),
    );
  }
  const webRemoteProjectTreeRetention = isWebRemoteAttachment
    ? webRemoteProjectTreeActivity.retain()
    : undefined;
  exposeWindowHostAttachmentServices({
    server,
    services,
    overrides,
    clientMode,
    attachmentScope,
    windowServices: activeServices ?? undefined,
    ...(isWebRemoteAttachment
      ? { decorateWindowProjectService: webRemoteProjectTreeActivity.decorate }
      : {}),
  });
  let disposed = false;
  let flowUpdateChain = Promise.resolve();
  const forwardFlowState = (state: "saturated" | "drained" | "closed") => {
    if (!connectionScope) return Promise.resolve();
    const update = flowUpdateChain.then(() => connectionScope.setTransportFlowState(state));
    flowUpdateChain = update.catch((error) => {
      logger.warn("failed to forward attachment connection flow state", {
        state,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return update;
  };
  const flowStateDisposable = protocol.onFlowState((state) => {
    if (disposed) return;
    // MessagePort sideband 已在 protocol 层与 Uint8Array 分流；这里只把 owning scope
    // 的 edge 串行送往 CLI，不能由 control object 指定 connectionId。
    void forwardFlowState(state).catch(() => {});
  });
  const handle: ExposedServicePortHandle = {
    server,
    dispose() {
      if (disposed) return;
      disposed = true;
      flowStateDisposable.dispose();
      controllerAttachment.dispose();
      legacyTerminalScope?.dispose();
      webRemoteProjectTreeRetention?.dispose();
      void disposePromptAttachmentTransfer?.().catch((error: unknown) => {
        logger.warn("failed to dispose remote attachment transfer", error);
      });
      void remoteMediaPreviewProxy?.dispose().catch((error: unknown) => {
        logger.warn("failed to dispose remote media preview proxy", error);
      });
      // close 排在所有已接收 SAT/DRN 之后；scope.dispose 自身会再次幂等确保 closed，
      // 但绝不让迟到 saturated 在 close 后复活 CLI pause state。
      void forwardFlowState("closed")
        .catch(() => {})
        .then(() => connectionScope?.dispose());
      rawServer.dispose();
      protocol.disconnect();
    },
  };
  port.once("close", () => handle.dispose());
  logger.info(`service connection ready mode=${clientMode}`);
  return handle;
}

const windowHostAttachmentRegistry = createWindowHostAttachmentRegistry<
  ServiceCollection,
  Electron.MessagePortMain,
  HostRemoteConnectionCapabilities
>({
  resolveScope: (scope: WindowHostAttachmentScope) => {
    if (scope.kind === "local") {
      if (!activeServices) {
        throw new Error("local services 尚未初始化");
      }
      return { services: activeServices, generation: 1 };
    }
    if (scope.kind === "source-settings") {
      const connection = sourceServerConnectionManager?.getOnlineConnection(scope.sourceServerId);
      const registered = windowRemoteConnectionRegistry.getOnlineSource(scope.sourceServerId);
      const configServices = connection?.services ?? registered?.services;
      if (!configServices) {
        throw new Error(`Source Server is offline: ${scope.sourceServerId}`);
      }
      return {
        services: createSourceSettingsServiceCollection(configServices),
        generation:
          sourceServerConnectionManager
            ?.listStates()
            .find((state) => state.sourceServerId === scope.sourceServerId)?.updatedAt ?? 1,
      };
    }
    const session = windowRemoteConnectionRegistry.getSession(scope.remoteSessionId);
    if (!session) {
      throw new Error(`未找到远程 logical session，remoteSessionId=${scope.remoteSessionId}`);
    }
    return {
      services: windowRemoteConnectionRegistry.resolveScopedServices(scope),
      generation: session.generation,
      capabilities: windowRemoteConnectionRegistry.resolveScopedCapabilities(scope),
    };
  },
  expose: ({ port, services, clientMode, scope, capabilities, terminalOwnerId }) =>
    exposeServicesOnMessagePort(
      port,
      services,
      false,
      clientMode,
      scope,
      capabilities,
      terminalOwnerId,
    ),
});

function logWindowHostTopology(reason: string): void {
  const stats = windowRemoteConnectionRegistry.getStats();
  logger.info(
    `window Host topology, reason=${reason}, pid=${process.pid}, connections=${stats.connectionCount}, logicalSessions=${stats.logicalSessionCount}, attachments=${windowHostAttachmentRegistry.size()}`,
  );
}

function disposeAttachedServicePorts(): void {
  terminalOwners.setOwner(null);
  windowHostAttachmentRegistry.dispose();
}

async function disposeHostResources(reason: string): Promise<HostShutdownResult> {
  databaseStartup?.dispose();
  pendingStartupAttachments.clear();
  if (hasDisposedHostResources) {
    return (
      (await disposeHostResourcesInFlight) ?? {
        exitCode: 0,
        failedPhases: [],
        timedOutPhases: [],
      }
    );
  }
  hasDisposedHostResources = true;
  for (const controller of projectNavigationAbortControllers.values()) controller.abort();
  projectNavigationAbortControllers.clear();

  disposeHostResourcesInFlight = (async () => {
    logger.info(`disposing host resources, reason=${reason}`);

    appControlNavigation.dispose();
    pluginSandboxRegistrationBridge.dispose();
    windowHostExtensions?.dispose();
    windowHostExtensions = null;
    stopHostNetworkTelemetry();
    hostNetworkCapture.setCaptureId(null);
    hostSelfResourceTelemetry.stop();
    disposeLocalResourceTelemetry();
    disposeAttachedServicePorts();
    windowHostControllerRuntime.dispose();
    for (const key of Array.from(cronRunSubscriptions.keys())) {
      disposeCronRunSubscription(key);
    }
    cronAutomationRepo.close();
    for (const key of Array.from(offPeakRunSubscriptions.keys())) {
      disposeOffPeakRunSubscription(key);
    }
    disposeOffPeakRuntime();
    offPeakTaskRepo.close();

    if (activeSessionRealtimePort) {
      activeSessionRealtimePort.dispose();
      activeSessionRealtimePort = null;
    }

    const servicesToDispose = activeServices;
    activeServices = null;
    // Registry 是全部远端 connection 的唯一 owner；释放失败不能阻塞本地服务继续收口。
    const remoteDisposal = runHostShutdownPhases(
      [
        {
          name: "remote-registry-dispose",
          run: () => windowRemoteConnectionRegistry.dispose(),
          timeoutMs: 6_000,
        },
        {
          name: "source-server-manager-dispose",
          run: async () => {
            sourceServerConnectionManager?.dispose();
            sourceServerManagementService?.dispose();
            sourceSettingsStateSubscription?.dispose();
            sourceServerConnectionManager = null;
            sourceServerManagementService = null;
            sourceSettingsStateSubscription = null;
            sourceServerDirectory = null;
          },
          timeoutMs: 2_000,
        },
      ],
      {
        phaseTimeoutMs: 5_000,
        log: (message, details) => logger.warn(message, details),
      },
    );
    // 根因：先等远端连接会耗尽本地 CLI 的正常退出窗口；两个 owner 同时开始收口。
    const serviceDisposal = runHostShutdownPhases(
      servicesToDispose
        ? [
            {
              name: "service-dispose",
              run: () => disposeServiceResourcesAndWait(servicesToDispose),
              timeoutMs: 3_500,
            },
          ]
        : [],
      { phaseTimeoutMs: 3_500, log: (message, details) => logger.warn(message, details) },
    );
    const results = await Promise.all([remoteDisposal, serviceDisposal]);
    const shutdownResult: HostShutdownResult = {
      exitCode: results.some((result) => result.exitCode !== 0) ? 1 : 0,
      failedPhases: results.flatMap((result) => result.failedPhases),
      timedOutPhases: results.flatMap((result) => result.timedOutPhases),
    };
    if (shutdownResult.exitCode !== 0) {
      logger.warn("host resource cleanup completed with errors", {
        failedPhases: shutdownResult.failedPhases,
        reason,
        timedOutPhases: shutdownResult.timedOutPhases,
      });
    }
    activeHostApiNetworkTransport = null;
    return shutdownResult;
  })();

  const shutdownResult = await disposeHostResourcesInFlight;
  flushHostE2ECoverage((error) => {
    logger.warn("[e2e-coverage] host coverage flush failed", error);
  });
  return shutdownResult;
}

function disposeHostResourcesBestEffort(reason: string): void {
  if (hasDisposedHostResources) {
    return;
  }
  hasDisposedHostResources = true;

  logger.info(`disposing host resources, reason=${reason}`);
  pluginSandboxRegistrationBridge.dispose();
  windowHostExtensions?.dispose();
  windowHostExtensions = null;
  stopHostNetworkTelemetry();
  hostNetworkCapture.setCaptureId(null);
  disposeLocalResourceTelemetry();
  disposeAttachedServicePorts();
  windowHostControllerRuntime.dispose();
  for (const key of Array.from(cronRunSubscriptions.keys())) {
    disposeCronRunSubscription(key);
  }
  cronAutomationRepo.close();
  for (const key of Array.from(offPeakRunSubscriptions.keys())) {
    disposeOffPeakRunSubscription(key);
  }
  disposeOffPeakRuntime();
  offPeakTaskRepo.close();
  void windowRemoteConnectionRegistry.dispose();

  if (activeServices) {
    try {
      disposeServiceResources(activeServices);
    } catch (error) {
      logger.error("failed to dispose local services:", error);
    } finally {
      activeServices = null;
      activeHostApiNetworkTransport = null;
    }
  }

  if (activeSessionRealtimePort) {
    activeSessionRealtimePort.dispose();
    activeSessionRealtimePort = null;
  }
}

process.once("SIGTERM", () => {
  credentialCipherBridge.dispose();
  void disposeHostResources("SIGTERM").then(
    (result) => process.exit(result.exitCode),
    () => process.exit(1),
  );
});

process.once("SIGINT", () => {
  credentialCipherBridge.dispose();
  void disposeHostResources("SIGINT").then(
    (result) => process.exit(result.exitCode),
    () => process.exit(1),
  );
});

process.once("disconnect", () => {
  credentialCipherBridge.dispose();
  // parent IPC 消失后不会再有人发送 Dispose；有界清理结束后必须明确退出，避免 Host 常驻。
  void disposeHostResources("disconnect").finally(() => process.exit(1));
});

process.once("exit", () => {
  credentialCipherBridge.dispose();
  disposeHostResourcesBestEffort("exit");
});

let handlingFatalUncaughtException = false;
process.on(
  "uncaughtException",
  createHostUncaughtExceptionHandler({
    onRecovered: (error, origin) => {
      const memoryUsage = process.memoryUsage();
      logger.warn("contained host allocation failure from native TLS callback", {
        arrayBuffers: memoryUsage.arrayBuffers,
        external: memoryUsage.external,
        heapUsed: memoryUsage.heapUsed,
        message: error.message,
        origin,
        rss: memoryUsage.rss,
      });
    },
    onFatal: (error, origin) => {
      if (handlingFatalUncaughtException) {
        process.exit(1);
      }
      handlingFatalUncaughtException = true;
      logger.error(`uncaughtException origin=${origin}:`, error);
      void disposeHostResources(`uncaughtException:${origin}`).finally(() => process.exit(1));
    },
  }),
);

parentPort.on("message", async (e: Electron.MessageEvent) => {
  // 私有凭据回复先交给 bridge 校验并结束等待；通用校验丢弃非法回复会遗留文件锁。
  if (e.data?.type === HostMessageTypes.CredentialCipherResult) {
    const { type: _type, ...reply } = e.data;
    credentialCipherBridge.receive(reply);
    return;
  }
  const navigation = appNavigationResultMessageSchema.safeParse(e.data);
  if (navigation.success) {
    appControlNavigation.receive(navigation.data);
    return;
  }
  // 扩展进程的 L0 控制消息（牵线、状态）走独立 schema，不进入 Host 消息联合类型。
  const extensionControl = mainToExtensionWindowMessageSchema.safeParse(e.data);
  if (extensionControl.success) {
    const extensionPort = e.ports[0];
    windowHostExtensions?.receiveControl(
      extensionControl.data,
      extensionPort
        ? {
            port: wrapElectronPort(extensionPort),
            onClose: (listener) => extensionPort.once("close", listener),
          }
        : undefined,
    );
    return;
  }
  const result = parseHostIncomingMessageEvent(e);
  if (!result.success) {
    logger.error("invalid parentPort message:", formatZodError(result.error));
    return;
  }

  const msg = result.data;
  // 在任何 await 之前同步赋值：InitLocal 与变更消息同端口按序到达，初值不会覆盖较新的变更。
  if (msg.type === HostMessageTypes.InitLocal && msg.locale) {
    applicationLocale = msg.locale;
  }
  if (msg.type === HostMessageTypes.ApplicationLocaleChanged) {
    applicationLocale = msg.locale;
    return;
  }
  if (msg.type === HostMessageTypes.NetworkCapture) {
    hostNetworkCapture.setCaptureId(msg.control.captureId);
    return;
  }
  const port = e.ports[0];
  if (msg.type === HostMessageTypes.DatabaseStartupControl) {
    if (msg.control.action === "snapshot") databaseStartup?.coordinator.publish();
    else if (msg.control.action === "retry")
      void databaseStartup?.coordinator.retry(msg.control.attemptId);
    return;
  }

  if (msg.type === HostMessageTypes.PrepareProjectWorkspace) {
    const controller = new AbortController();
    if (projectNavigationAbortControllers.has(msg.requestId)) {
      parentPort.postMessage({
        type: HostResponseTypes.ProjectWorkspacePrepared,
        requestId: msg.requestId,
        result: { ok: false, error: "项目导航 requestId 重复" },
      });
      return;
    }
    projectNavigationAbortControllers.set(msg.requestId, controller);
    try {
      const services = activeServices;
      if (!services || hasDisposedHostResources) throw new Error("Window Host is unavailable");
      const assertHost = () => {
        controller.signal.throwIfAborted();
        if (activeServices !== services || hasDisposedHostResources)
          throw new Error("Window Host changed during project navigation");
      };
      const navigation = createProjectWorkspaceNavigation({
        projectService: services.get(IProjectService),
        remoteProjectService: services.get(IRemoteProjectService),
        readConnectionOwner: (hostId) => resolveBotProjectConnection(hostId)?.owner,
        openRemoteWorkspace: async ({ host, directories, owner, assertCurrent }) => {
          assertHost();
          const serverId = parseRemoteWorkspaceIdentity(
            buildRemoteHostWorkspaceIdentity(host.id, directories.workspacePath),
          )?.sourceServerId;
          if (!serverId || !host.target) throw new Error("project.host-offline");
          // 对 Manager-only Source 仅登记现有连接的 wrapper；URL Source 必须已经在 Registry 在线。
          const registered = await windowRemoteConnectionRegistry.connectSource({
            target: host.target,
            remoteAssets: {},
            membershipIntent: "retain",
            existingSourceServerId: serverId,
          });
          assertHost();
          if (
            (registered.handle.capabilities?.physicalOwner?.() ?? registered.handle.services) !==
            owner
          )
            throw new Error("project.navigation-stale");
          return windowRemoteConnectionRegistry.openWorkspaceOnSource({
            requestId: msg.requestId,
            sourceServerId: serverId,
            workspacePath: directories.workspacePath,
            workspaceIdentity: directories.workspaceIdentity,
            workspacePurpose: directories.projectId ? "project" : "conversation",
            assertCurrent: async () => {
              assertHost();
              await assertCurrent();
              assertHost();
            },
          });
        },
      });
      const value = await navigation.prepare({
        projectId: msg.projectId,
        hostId: msg.hostId,
        draftId: msg.draftId,
        reuseDraft: msg.reuseDraft,
        ...(msg.task ? { task: msg.task } : {}),
      });
      assertHost();
      parentPort.postMessage({
        type: HostResponseTypes.ProjectWorkspacePrepared,
        requestId: msg.requestId,
        result: { ok: true, value },
      });
    } catch (error) {
      parentPort.postMessage({
        type: HostResponseTypes.ProjectWorkspacePrepared,
        requestId: msg.requestId,
        result: { ok: false, error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      if (projectNavigationAbortControllers.get(msg.requestId) === controller)
        projectNavigationAbortControllers.delete(msg.requestId);
    }
    return;
  }

  if (msg.type === HostMessageTypes.CuaPipFocusChanged) {
    const service = activeServices?.getOptional(ICuaPipSessionService);
    if (service) {
      void service.publishFocus(msg.event);
    } else {
      // 取不到服务时过去静默丢弃，focus-changed 于是从链路上凭空消失
      // （dev 实测 0 条，正式包同期 92 条）。补这条才能把「main 没发」与
      // 「host 收到了但服务没注册」分开。
      logger.warn("[cua-pip-session] focus event dropped: service unavailable");
    }
    return;
  }

  if (msg.type === HostMessageTypes.ResourceUsageSnapshotRequest) {
    void hostResourceUsageResponder.handleRequest(msg);
    return;
  }
  if (msg.type === HostMessageTypes.ResourceUsageSnapshotCancel) {
    hostResourceUsageResponder.cancelRequest(msg.requestId);
    return;
  }

  if (msg.type === HostMessageTypes.ProviderProvisioningLaneResult) {
    hostProviderProvisioningStatus.handleResult(msg);
    return;
  }

  if (msg.type === HostMessageTypes.FeedbackLogArchiveResult) {
    const pending = pendingFeedbackLogArchiveRequests.get(msg.requestId);
    if (!pending) {
      return;
    }
    pendingFeedbackLogArchiveRequests.delete(msg.requestId);
    if (msg.ok && msg.path && typeof msg.size === "number") {
      pending.onProgress?.({ processedBytes: msg.size, totalBytes: msg.size });
      pending.resolve({ path: msg.path, size: msg.size });
      return;
    }
    pending.reject(new Error(msg.error ?? "反馈日志归档创建失败"));
    return;
  }

  if (msg.type === HostMessageTypes.CredentialKeyShareResult) {
    const pending = pendingCredentialKeyShares.get(msg.requestId);
    if (!pending) {
      return;
    }
    pendingCredentialKeyShares.delete(msg.requestId);
    if (msg.ok) {
      pending.resolve();
      return;
    }
    pending.reject(
      Object.assign(new Error("System credential storage is unavailable"), {
        code: msg.errorCode ?? CREDENTIAL_KEY_SHARE_UNAVAILABLE_ERROR_CODE,
      }),
    );
    return;
  }

  if (msg.type === HostMessageTypes.LocalMediaPreviewPathAuthorizeResult) {
    const pending = pendingLocalMediaPreviewPathAuthorizations.get(msg.requestId);
    if (!pending) return;
    pendingLocalMediaPreviewPathAuthorizations.delete(msg.requestId);
    if (msg.ok && msg.path) {
      logger.info("local media preview path authorization OK");
      pending.resolve(msg.path);
    } else {
      pending.reject(new Error(msg.error ?? "本地视频预览路径授权失败"));
    }
    return;
  }

  if (msg.type === HostMessageTypes.PluginSandboxRegisterResult) {
    pluginSandboxRegistrationBridge.accept(msg);
    return;
  }

  if (msg.type === HostMessageTypes.CronRun) {
    if (databaseStartup?.coordinator.snapshot.phase !== "ready") {
      parentPort.postMessage({
        type: HostResponseTypes.CronRunResult,
        runId: msg.runId,
        ok: false,
        error: "Local database startup is not ready",
        failureKind: "transient",
      });
      return;
    }
    void (async () => {
      try {
        const dispatchResult = await dispatchCronRun({
          ...msg,
          mode: msg.mode as ZCodeTaskMode | undefined,
        });
        parentPort.postMessage({
          type: HostResponseTypes.CronRunResult,
          runId: msg.runId,
          ok: true,
          ...dispatchResult,
        });
      } catch (error) {
        parentPort.postMessage({
          type: HostResponseTypes.CronRunResult,
          runId: msg.runId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          failureKind: "transient",
        });
      }
    })();
    return;
  }

  if (msg.type === HostMessageTypes.OffPeakRun) {
    if (databaseStartup?.coordinator.snapshot.phase !== "ready") {
      parentPort.postMessage({
        type: HostResponseTypes.OffPeakRunResult,
        offPeakTaskId: msg.offPeakTaskId,
        ok: false,
        error: "Local database startup is not ready",
        failureKind: "transient",
      });
      return;
    }
    void (async () => {
      try {
        const dispatchResult = await dispatchOffPeakRun(msg);
        parentPort.postMessage({
          type: HostResponseTypes.OffPeakRunResult,
          offPeakTaskId: msg.offPeakTaskId,
          ok: true,
          ...dispatchResult,
        });
      } catch (error) {
        parentPort.postMessage({
          type: HostResponseTypes.OffPeakRunResult,
          offPeakTaskId: msg.offPeakTaskId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          // 确定性模型/凭证配置错误重试不会自愈；交给 scheduler 转 failed，
          // 未知及生命周期错误仍按 transient 保持原退避语义。
          failureKind: error instanceof OffPeakPermanentDispatchError ? "permanent" : "transient",
        });
      }
    })();
    return;
  }

  if (msg.type === HostMessageTypes.BrowserExecuteResult) {
    // main 的 WebContentsView+CDP 执行完 browser 命令，按 requestId 关联回 bridge 的 pending。
    void browserControlMainBridge.handleResult({
      requestId: msg.requestId,
      result: msg.result,
    });
    return;
  }

  if (msg.type === HostMessageTypes.Dispose) {
    credentialCipherBridge.dispose();
    // main 进程通知清理（窗口关闭 / app 退出时）
    // 这里必须等待统一资源清理完成（含异步收尾写回），再让进程退出；main 侧仍有强杀 timer 兜底。
    const result = await disposeHostResources("parent dispose");
    process.exit(result.exitCode);
    return;
  }

  if (msg.type === HostMessageTypes.Broadcast) {
    return;
  }

  if (msg.type === HostMessageTypes.SessionMessageDeliver) {
    const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      parentPort.postMessage({
        type: HostResponseTypes.SessionMessageDeliverResult,
        result: {
          error: "ZCode task service is not initialized.",
          messageId: msg.request.messageId,
          requestId: msg.request.requestId,
          sessionId: msg.request.fromSessionId,
          status: "failed",
        },
      });
      return;
    }

    void zcodeTaskService
      .deliverSessionMessage(msg.request)
      .then((deliveryResult) => {
        parentPort.postMessage({
          type: HostResponseTypes.SessionMessageDeliverResult,
          result: deliveryResult,
        });
      })
      .catch((error) => {
        parentPort.postMessage({
          type: HostResponseTypes.SessionMessageDeliverResult,
          result: {
            error: error instanceof Error ? error.message : String(error),
            messageId: msg.request.messageId,
            requestId: msg.request.requestId,
            sessionId: msg.request.fromSessionId,
            status: "failed",
          },
        });
      });
    return;
  }

  if (msg.type === HostMessageTypes.SessionMessageDeliveryResult) {
    const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      logger.warn("session message delivery result received before ZCode task service initialized");
      return;
    }
    void zcodeTaskService.sendSessionMessageDeliveryResult(msg.result).catch((error) => {
      logger.warn("failed to forward session message delivery result:", error);
    });
    return;
  }

  if (msg.type === HostMessageTypes.ProviderProvisioningExecute) {
    const session = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    if (
      !session ||
      !session.workspaceIdentity ||
      buildRemoteEnvironmentKey(session.target) !== msg.environmentKey
    ) {
      parentPort.postMessage({
        type: HostResponseTypes.ProviderProvisioningExecutionResult,
        requestId: msg.requestId,
        environmentKey: msg.environmentKey,
        status: "failed",
        error: "Remote Environment registration 已失效",
        errorCode: "session-unavailable",
      });
      return;
    }
    const scope = {
      kind: "remote",
      remoteSessionId: session.remoteSessionId,
      workspacePath: session.workspacePath ?? "/",
      workspaceIdentity: session.workspaceIdentity,
    } as const;
    void Promise.resolve()
      .then(() =>
        (() => {
          const provisioningService = getRemoteProviderProvisioningExecutor(
            windowRemoteConnectionRegistry.resolveScopedServices(scope),
          );
          if (!provisioningService) {
            throw new Error("Remote Environment 不支持 Provider Provisioning");
          }
          return provisioningService.syncLocalToRemote();
        })(),
      )
      .then((result) => {
        parentPort.postMessage({
          type: HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: msg.requestId,
          environmentKey: msg.environmentKey,
          status: result.status,
          ...(result.errorMessage ? { error: result.errorMessage } : {}),
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        });
      })
      .catch((error: unknown) => {
        parentPort.postMessage({
          type: HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: msg.requestId,
          environmentKey: msg.environmentKey,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          errorCode: "host-execution-failed",
        });
      });
    return;
  }

  if (msg.type === HostMessageTypes.ConnectRemoteWorkspace) {
    const workspacePath =
      msg.workspacePath ??
      (msg.target.kind === "server" ? msg.target.workspacePath?.trim() || "/" : "/");
    const workspaceIdentity =
      msg.workspaceIdentity ?? buildRemoteWorkspaceIdentity(workspacePath, msg.target);
    logger.info(
      `connecting window-scoped remote source, requestId=${msg.requestId}, target=${formatRemoteTargetForLog(msg.target)}`,
    );
    void remoteConnectionProgressContext
      .run(msg.requestId, () =>
        windowRemoteConnectionRegistry.connect({
          requestId: msg.requestId,
          target: msg.target,
          remoteAssets: msg.remoteAssets,
          workspacePath,
          workspaceIdentity,
          ...(msg.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
        }),
      )
      .then(async (descriptor) => {
        const replacedOfflineSessions = windowRemoteConnectionRegistry
          .listSessions()
          .filter(
            (session) =>
              session.remoteSessionId !== descriptor.remoteSessionId &&
              session.state === "disconnected" &&
              session.workspacePath === descriptor.workspacePath &&
              session.workspaceIdentity === descriptor.workspaceIdentity,
          );
        for (const replaced of replacedOfflineSessions) {
          if (replaced.workspacePath && replaced.workspaceIdentity) {
            const previousScope = {
              kind: "remote",
              ...(replaced.sourceServerId ? { sourceServerId: replaced.sourceServerId } : {}),
              remoteSessionId: replaced.remoteSessionId,
              workspacePath: replaced.workspacePath,
              workspaceIdentity: replaced.workspaceIdentity,
            } as const;
            const nextScope = {
              kind: "remote",
              ...(descriptor.sourceServerId ? { sourceServerId: descriptor.sourceServerId } : {}),
              remoteSessionId: descriptor.remoteSessionId,
              workspacePath: replaced.workspacePath,
              workspaceIdentity: replaced.workspaceIdentity,
            } as const;
            try {
              const services = windowRemoteConnectionRegistry.resolveScopedServices(nextScope);
              await windowHostControllerRuntime.replaceDisconnectedSource(previousScope, {
                scope: nextScope,
                taskService: services.get(IZCodeTaskService),
                sourceAvailability: "online",
              });
            } catch (error) {
              // source 已连接但 task-index 暂时不可读时不能回滚 transport，也不能删除上一代
              // 离线可信投影。Controller 会保留 pending replacement，后续 query 成功后原子替换。
              logger.warn("failed to atomically replace disconnected Controller source", error);
            }
          }
          windowHostAttachmentRegistry.detachRemoteSessionAttachments(replaced.remoteSessionId);
          await windowRemoteConnectionRegistry.disposeSession(replaced.remoteSessionId);
          // 重连替换后旧 remoteSessionId 已不再可 attachment；同步清理 Main 的端口请求关联，
          // 但不向 Renderer 伪报一次新的 transport failure。
          parentPort.postMessage({
            type: HostResponseTypes.RemoteWorkspaceClosed,
            remoteSessionId: replaced.remoteSessionId,
            reason: "disposed",
          });
        }
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceConnected,
          requestId: msg.requestId,
          descriptor,
        });
        logWindowHostTopology("remote-connected");
      })
      .catch((error) => {
        const failure = normalizeRemoteConnectionError(error);
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceConnectFailed,
          requestId: msg.requestId,
          error: sanitizeRemoteConnectionLog(failure.message) || "Remote connection failed",
          reasonCode: failure.code,
          ...(error instanceof SourceServerUpgradeRequiredError ||
          error instanceof SourceServerInstallRequiredError
            ? { profileId: error.profileId }
            : {}),
          // 安装和升级等待固定 Main 解析后的 WSL 身份，不能从可编辑 Profile 重建。
          // 身份来自同一请求，独立于附加安装预览；只回传 WSL 的非敏感连接参数。
          ...((error instanceof SourceServerInstallRequiredError ||
            error instanceof SourceServerUpgradeRequiredError) &&
          msg.target.kind === "wsl"
            ? { resolvedWslTarget: msg.target }
            : {}),
          ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
        });
      });
    return;
  }

  if (msg.type === HostMessageTypes.CancelRemoteWorkspaceConnect) {
    projectNavigationAbortControllers.get(msg.requestId)?.abort();
    windowRemoteConnectionRegistry.cancelConnect(msg.requestId);
    return;
  }

  if (msg.type === HostMessageTypes.CancelRemoteWorkspaceBind) {
    cancelledWorkspaceBindRequestIds.add(msg.requestId);
    workspaceBindAbortControllers.get(msg.requestId)?.abort();
    // Bug 原因：bind 可能 join 到已有 Source logical session；取消一个选择目录请求不代表
    // 该 session 的其他 attachment/owner 都已释放。这里只取消 request，不再连坐 dispose。
    if (!activeWorkspaceBindRequestIds.has(msg.requestId)) {
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
        requestId: msg.requestId,
        error: "Remote workspace bind was canceled",
        reasonCode: REMOTE_BIND_CANCELED_ERROR_CODE,
        retryable: false,
      });
      cancelledWorkspaceBindRequestIds.delete(msg.requestId);
      workspaceBindAbortControllers.delete(msg.requestId);
    }
    return;
  }

  if (msg.type === HostMessageTypes.BindRemoteWorkspaceContext) {
    activeWorkspaceBindRequestIds.add(msg.requestId);
    const bindAbortController = new AbortController();
    workspaceBindAbortControllers.set(msg.requestId, bindAbortController);
    if (cancelledWorkspaceBindRequestIds.has(msg.requestId)) {
      bindAbortController.abort();
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
        requestId: msg.requestId,
        error: "Remote workspace bind was canceled",
        reasonCode: REMOTE_BIND_CANCELED_ERROR_CODE,
        retryable: false,
      });
      activeWorkspaceBindRequestIds.delete(msg.requestId);
      cancelledWorkspaceBindRequestIds.delete(msg.requestId);
      workspaceBindAbortControllers.delete(msg.requestId);
      return;
    }
    const previous = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    let workspaceReady: Promise<void>;
    try {
      workspaceReady = windowRemoteConnectionRegistry.bindWorkspaceContext({
        remoteSessionId: msg.remoteSessionId,
        workspacePath: msg.workspacePath,
        workspaceIdentity: msg.workspaceIdentity,
        ...(msg.workspacePurpose ? { workspacePurpose: msg.workspacePurpose } : {}),
        ...(msg.legacyRouteHint ? { legacyWorkspaceIdentity: msg.legacyRouteHint } : {}),
        signal: bindAbortController.signal,
      });
    } catch (error) {
      logger.warn(
        `failed to bind remote workspace context, remoteSessionId=${msg.remoteSessionId}`,
        error,
      );
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
        requestId: msg.requestId,
        error: error instanceof Error ? error.message : String(error),
        ...(error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? { reasonCode: error.code }
          : {}),
        ...(error &&
        typeof error === "object" &&
        "retryable" in error &&
        typeof error.retryable === "boolean"
          ? { retryable: error.retryable }
          : {}),
      });
      activeWorkspaceBindRequestIds.delete(msg.requestId);
      cancelledWorkspaceBindRequestIds.delete(msg.requestId);
      workspaceBindAbortControllers.delete(msg.requestId);
      return;
    }
    const current = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    if (current) {
      // scope generation 换代后，旧 Renderer/手机 attachment 不得继续持有远端 IO facade。
      windowHostAttachmentRegistry.detachStaleRemoteSessionAttachments(
        msg.remoteSessionId,
        current.generation,
      );
    }
    void workspaceReady
      .then(async () => {
        if (cancelledWorkspaceBindRequestIds.has(msg.requestId)) {
          throw Object.assign(new Error("Remote workspace bind was canceled"), {
            code: REMOTE_BIND_CANCELED_ERROR_CODE,
            retryable: false,
          });
        }
        const currentSession = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
        if (!currentSession?.workspaceIdentity) {
          // Bug 原因：bind 完成前 logical session 可能被并发释放；旧实现直接 return，Main
          // 永远收不到 ACK。抛入统一失败链，确保每个 requestId 恰好 settle 一次。
          throw Object.assign(
            new Error(`远程 workspace bind 完成时 session 已失效: ${msg.remoteSessionId}`),
            {
              code: REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE,
              retryable: true,
            },
          );
        }
        const scope = {
          kind: "remote" as const,
          ...(currentSession.sourceServerId
            ? { sourceServerId: currentSession.sourceServerId }
            : {}),
          remoteSessionId: msg.remoteSessionId,
          workspacePath: msg.workspacePath,
          workspaceIdentity: currentSession.workspaceIdentity,
        };
        await windowRemoteConnectionRegistry
          .resolveScopedCapabilities(scope)
          ?.recordWorkspaceOpen?.({
            workspacePath: msg.workspacePath,
            workspaceIdentity: currentSession.workspaceIdentity,
            ...(msg.workspacePurpose ? { workspacePurpose: msg.workspacePurpose } : {}),
            ...(msg.legacyRouteHint ? { legacyWorkspaceIdentity: msg.legacyRouteHint } : {}),
            signal: bindAbortController.signal,
          });
        if (cancelledWorkspaceBindRequestIds.has(msg.requestId)) {
          throw Object.assign(new Error("Remote workspace bind was canceled"), {
            code: REMOTE_BIND_CANCELED_ERROR_CODE,
            retryable: false,
          });
        }
        if (previous?.workspacePath && previous.workspaceIdentity) {
          windowHostControllerRuntime.removeSource({
            kind: "remote",
            ...(previous.sourceServerId ? { sourceServerId: previous.sourceServerId } : {}),
            remoteSessionId: msg.remoteSessionId,
            workspacePath: previous.workspacePath,
            workspaceIdentity: previous.workspaceIdentity,
          });
        }
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceContextBound,
          requestId: msg.requestId,
          // Bug 原因：首次从旧 route tab 打开 Source workspace 时，Renderer 只拿到 stable
          // identity 会误认为没有旧 tab，随后 addTab 产生第二个 workspace。把本次 bind
          // 使用的旧 route 作为一次性 tab rekey 提示返回；它不是任务路由身份，手机端忽略。
          ...(msg.legacyRouteHint && msg.legacyRouteHint !== currentSession.workspaceIdentity
            ? { previousWorkspaceIdentity: msg.legacyRouteHint }
            : {}),
        });
        logger.info(
          `bound remote workspace context, remoteSessionId=${msg.remoteSessionId}, workspacePath=${msg.workspacePath}`,
        );
        activeWorkspaceBindRequestIds.delete(msg.requestId);
        cancelledWorkspaceBindRequestIds.delete(msg.requestId);
        workspaceBindAbortControllers.delete(msg.requestId);
      })
      .catch((error) => {
        logger.warn(
          `failed to prepare bound remote workspace, remoteSessionId=${msg.remoteSessionId}`,
          error,
        );
        const normalizedError = cancelledWorkspaceBindRequestIds.has(msg.requestId)
          ? Object.assign(new Error("Remote workspace bind was canceled"), {
              code: REMOTE_BIND_CANCELED_ERROR_CODE,
              retryable: false,
            })
          : error;
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
          requestId: msg.requestId,
          error:
            normalizedError instanceof Error ? normalizedError.message : String(normalizedError),
          ...(normalizedError &&
          typeof normalizedError === "object" &&
          "code" in normalizedError &&
          typeof normalizedError.code === "string"
            ? { reasonCode: normalizedError.code }
            : {}),
          ...(normalizedError &&
          typeof normalizedError === "object" &&
          "retryable" in normalizedError &&
          typeof normalizedError.retryable === "boolean"
            ? { retryable: normalizedError.retryable }
            : {}),
        });
        activeWorkspaceBindRequestIds.delete(msg.requestId);
        cancelledWorkspaceBindRequestIds.delete(msg.requestId);
        workspaceBindAbortControllers.delete(msg.requestId);
      });
    return;
  }

  if (msg.type === HostMessageTypes.DisposeRemoteWorkspaceSession) {
    const disposedSession = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    windowHostAttachmentRegistry.detachRemoteSessionAttachments(msg.remoteSessionId);
    void windowRemoteConnectionRegistry
      .disposeSession(msg.remoteSessionId)
      .then(() => {
        if (disposedSession?.workspacePath && disposedSession.workspaceIdentity) {
          windowHostControllerRuntime.removeSource({
            kind: "remote",
            ...(disposedSession.sourceServerId
              ? { sourceServerId: disposedSession.sourceServerId }
              : {}),
            remoteSessionId: msg.remoteSessionId,
            workspacePath: disposedSession.workspacePath,
            workspaceIdentity: disposedSession.workspaceIdentity,
          });
        }
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceClosed,
          remoteSessionId: msg.remoteSessionId,
          reason: "disposed",
        });
        logWindowHostTopology("remote-session-disposed");
      })
      .catch((error) => {
        logger.warn(
          `failed to dispose remote logical session, remoteSessionId=${msg.remoteSessionId}`,
          error,
        );
      });
    return;
  }

  if (msg.type === HostMessageTypes.SetTerminalOwner) {
    terminalOwners.setOwner(msg.ownerId);
    return;
  }

  if (msg.type === HostMessageTypes.AttachServicePort) {
    if (!port) {
      logger.error("attach-service-port message missing MessagePort");
      return;
    }
    if (msg.scope.kind === "local" && databaseStartup?.coordinator.snapshot.phase !== "ready") {
      // 刷新/手机 attachment 复用同一 Host，等待现有准备，不启动第二个执行者。
      pendingStartupAttachments.set(msg.attachmentId, () => {
        windowHostAttachmentRegistry.attach({ ...msg, port });
      });
      port.once("close", () => pendingStartupAttachments.delete(msg.attachmentId));
      return;
    }
    try {
      if (msg.clientMode === "web-remote-replayable" && msg.scope.kind === "source-settings") {
        throw new Error("Source settings attachments are Desktop-only");
      }
      if (msg.scope.kind === "remote") {
        // Bind 与 Attach 共用 parentPort，但 WSL 上一代 workspace release 可能仍在途。
        // 持有已转移 port 等待 Host 内 generation barrier，避免新 attachment 踩过旧 runtime 清理。
        await windowRemoteConnectionRegistry.waitForScopedServices(msg.scope);
      }
      windowHostAttachmentRegistry.attach({
        requestId: msg.requestId,
        attachmentId: msg.attachmentId,
        clientMode: msg.clientMode,
        terminalOwnerId: msg.terminalOwnerId,
        scope: msg.scope,
        port,
      });
      logger.info(
        `attached scoped service port, attachmentId=${msg.attachmentId}, scope=${msg.scope.kind}, clientMode=${msg.clientMode}`,
      );
      logWindowHostTopology("attachment-added");
    } catch (error) {
      // 跨 logical session 或旧 identity 的 port 若继续暴露，会把远端请求路由到错误 source。
      // scope 校验失败必须关闭已转移端口并明确记录，禁止回退 active local services。
      rejectUnavailableAttachedServicePort(port, false);
      logger.warn(`failed to attach scoped service port, attachmentId=${msg.attachmentId}`, error);
    }
    return;
  }

  if (msg.type === HostMessageTypes.DetachServicePort) {
    pendingStartupAttachments.delete(msg.attachmentId);
    windowHostAttachmentRegistry.detach(msg.attachmentId);
    logger.info(`detached service port, attachmentId=${msg.attachmentId}`);
    logWindowHostTopology("attachment-removed");
    return;
  }

  if (!port) {
    return;
  }

  if (msg.type === HostMessageTypes.InitLocal) {
    browserBackendIdentity = msg.browserBackendIdentity;
    if (!port) {
      logger.error("init-local message missing MessagePort");
      return;
    }
    if (databaseStartup) {
      port.close();
      databaseStartup.coordinator.publish();
      return;
    }
    let basePortClosed = false;
    port.once("close", () => {
      basePortClosed = true;
    });
    databaseStartup = createHostDatabaseStartup({
      startupId: msg.databaseStartupId,
      cwd: msg.agentSpawnFallbackCwd ?? process.cwd(),
      workingDirectories:
        msg.agentWarmupTargets?.map((target) => target.workspacePath) ??
        (msg.workspacePath ? [msg.workspacePath] : []),
      env: msg.runtimeProcessEnvPatch,
      publish: (state) => {
        parentPort?.postMessage({ type: HostResponseTypes.DatabaseStartupState, state });
        if (state.phase === "ready") {
          for (const attach of pendingStartupAttachments.values()) {
            try {
              attach();
            } catch (error) {
              logger.warn("startup attachment failed", error);
            }
          }
          pendingStartupAttachments.clear();
        }
      },
      onFailure: (error) =>
        logger.error(
          `local database startup failed attempt=${databaseStartup?.coordinator.snapshot.attemptId}`,
          error,
        ),
      initializeServices: async () => {
        logger.info("initializing local services");
        activeSessionRealtimePort = createTaskRealtimeBridgeForHostInit(msg, parentPort);
        // 旧 Team 补组织必须与网络代理读取共用同一个 Setting 实例及写队列。
        // 只注入 service 会跳过默认装配分支，导致缺组织的升级用户永远无法恢复连接。
        const {
          service: settingService,
          prepareLegacyAccountConnections,
          setWorkspaceProjection,
        } = createSettingServiceWithMigrations({ shareCredentialKeyWithDataRoot });
        // 不阻塞启动：读到持久化语言后作为 X-Client-Language 的兜底。
        void settingService.get().then(
          (settings) => {
            persistedApplicationLocale = settings.locale;
          },
          () => {},
        );
        const hostApiNetworkTransport = createHostApiNetworkTransport(async () => {
          const settings = await settingService.get();
          return {
            httpProxy: settings.httpProxy,
            noProxy: settings.httpProxyNoProxy,
            caCertPath: settings.httpProxyCaCertPath,
          };
        });
        // createLocalServices 交出的会话控制 facade：只交给扩展网关（docs/plugins/extension-host.md §17.2），
        // 不注册进 ServiceCollection，不在任何 RPC 频道上。
        let appControlForExtensions: AppControlServiceHandle | undefined;
        const services = await initializeHostApiNetworkTransportOwner({
          transport: hostApiNetworkTransport,
          log: (message, details) => logger.warn(message, details),
          establishOwner: () => {
            const initializedServices = createLocalServices({
              onAppControlServiceCreated: (handle) => {
                appControlForExtensions = handle;
              },
              // 插件管理变更在 Window Host 成功返回后重推扩展进程的插件清单（§3.4），
              // 配置与重置另通知该插件的扩展设置订阅者（§16.7）。
              onPluginManagementMutated: (change) => windowHostExtensions?.refreshInventory(change),
              reportPluginTelemetryEvent: (event) => {
                parentPort?.postMessage({
                  type: HostResponseTypes.PluginTelemetry,
                  event: {
                    ...event,
                    context: {
                      ...event.context,
                      screenResolution: event.context.screenResolution || "unknown",
                    },
                  },
                });
              },
              resolveBotProjectConnection,
              resolveBotRemoteWorkspace: (workspace) =>
                sourceServerDirectory
                  ? resolveBotRemoteWorkspace(workspace, "lookup", {
                      directory: sourceServerDirectory,
                      listSessions: () => windowRemoteConnectionRegistry.listSessions(),
                    })
                  : Promise.resolve(null),
              setWorkspaceProjection,
              remoteProjectConnection: {
                connectHost: async (host) => {
                  if (host.target?.kind === "server") {
                    const connected = await windowRemoteConnectionRegistry.connectSource({
                      target: host.target,
                      remoteAssets: msg.remoteAssets ?? {},
                      membershipIntent: "retain",
                    });
                    return remoteProjectHostIdForTarget(host.target, connected.sourceServerId);
                  }
                  if (!sourceServerManagementService)
                    throw new Error("remote-project.connector-unavailable");
                  const management = sourceServerManagementService;
                  const snapshot = await management.getSnapshot();
                  // Bug 原因：IPv6 等地址不能构成成员身份，逐条计算 ID 时会抛错，任意一条这样的线路
                  // 都会让所有设备的侧栏重连失败。它不拥有成员行，按“不匹配”处理。
                  const profiles = snapshot.profiles.filter(
                    (profile) =>
                      profile.lifecycleState !== "retired" &&
                      findRemoteProjectHostIdForProfile(profile) === host.id,
                  );
                  const preferred = new Set(
                    snapshot.servers.map((server) => server.preferredProfileId),
                  );
                  const profile =
                    profiles.find((item) => preferred.has(item.profileId)) ?? profiles[0];
                  if (!profile) throw new Error("remote-project.profile-not-found");
                  const connected = await management.connectProfile(profile.profileId, {
                    retainedOnly: true,
                  });
                  const resolved = connected.profiles.find(
                    (item) => item.profileId === profile.profileId,
                  );
                  if (
                    !resolved ||
                    !connected.states.some(
                      (state) => state.profileId === resolved.profileId && state.state === "online",
                    )
                  )
                    throw new Error("project.host-offline");
                  return remoteProjectHostIdForProfile(resolved);
                },
                readConnectionStates: async () => {
                  const result = new Map<
                    string,
                    Pick<
                      RemoteProjectHost,
                      | "connectionStatus"
                      | "lastConnectionError"
                      | "lastConnectionStatus"
                      | "upgradeTarget"
                    >
                  >();
                  for (const state of windowRemoteConnectionRegistry.listConnections()) {
                    if (state.target.kind !== "server") continue;
                    result.set(remoteProjectHostIdForTarget(state.target, state.sourceServerId), {
                      connectionStatus:
                        state.state === "online"
                          ? "online"
                          : state.state === "connecting"
                            ? "connecting"
                            : "offline",
                    });
                  }
                  if (!sourceServerDirectory || !sourceServerConnectionManager) return result;
                  const snapshot = await sourceServerDirectory.snapshot();
                  for (const state of sourceServerConnectionManager.listStates()) {
                    const profile = snapshot.profiles.find(
                      (item) => item.profileId === state.profileId,
                    );
                    if (!profile) continue;
                    // Bug 原因：IPv6 等地址的失败线路会留下连接状态，这里曾计算 ID 抛错，整个
                    // readDirectory 随之失败。它不拥有成员行，没有可投影的目标。
                    const id = findRemoteProjectHostIdForProfile(profile);
                    if (!id) continue;
                    const value =
                      state.state === "online"
                        ? "online"
                        : ["bootstrapping", "retrying", "updating"].includes(state.state)
                          ? "connecting"
                          : "offline";
                    if (
                      result.get(id)?.connectionStatus !== "online" &&
                      (result.get(id)?.connectionStatus !== "connecting" || value === "online")
                    )
                      result.set(id, {
                        connectionStatus: value,
                        lastConnectionError: state.error,
                        lastConnectionStatus: state.state,
                        // 修复原因：投影曾丢掉 upgradeTarget，桌面端过旧时详情入口误显示“更新远端”。
                        upgradeTarget: state.upgradeTarget,
                      });
                  }
                  return result;
                },
              },
              resolveAppControlDiscoverySource: createAppControlDiscoverySourceResolver({
                registry: windowRemoteConnectionRegistry,
                getSourceServerConnectionManager: () => sourceServerConnectionManager ?? undefined,
              }),
              resolveProjectHostService: async (hostId) => {
                const serverId = parseRemoteWorkspaceIdentity(
                  buildRemoteHostWorkspaceIdentity(hostId, "/"),
                )?.sourceServerId;
                const registered = serverId
                  ? windowRemoteConnectionRegistry.getOnlineSource(serverId)
                  : undefined;
                if (registered && serverId) {
                  // Registry handle 跨 Source 重连不换代；必须按物理连接去重，Core 重启后才会重新登记。
                  const physicalConnection =
                    registered.capabilities?.physicalOwner?.() ?? registered.services;
                  return bindRemoteProjectIdentities(
                    registered.services.get(IProjectService),
                    (workspacePath) =>
                      registryProjectIdentityRegistrations(
                        physicalConnection,
                        workspacePath,
                        async () => {
                          const workspaceIdentity = buildServerRemoteWorkspaceIdentity({
                            serverId,
                            workspacePath,
                          });
                          await registered.capabilities?.bindWorkspaceIdentity?.({
                            workspacePath,
                            stableWorkspaceIdentity: workspaceIdentity,
                          });
                          return workspaceIdentity;
                        },
                      ),
                  );
                }
                const source = sourceServerConnectionManager?.listStates().find(
                  (state) =>
                    state.sourceServerId &&
                    remoteHostIdFromWorkspaceIdentity(
                      buildServerRemoteWorkspaceIdentity({
                        serverId: state.sourceServerId,
                        workspacePath: "/",
                      }),
                    ) === hostId,
                );
                const connection = source?.sourceServerId
                  ? sourceServerConnectionManager?.getOnlineConnection(source.sourceServerId)
                  : undefined;
                if (!connection || !source?.sourceServerId) throw new Error("project.host-offline");
                const sourceServerId = source.sourceServerId;
                return bindRemoteProjectIdentities(
                  resolveServerProjectService({
                    connectionServices: connection.services,
                    serverId: sourceServerId,
                    virtualProjects: connection.serverInfo.capabilities.virtualProjects,
                    sourceServices: activeServices ?? undefined,
                  }),
                  (workspacePath) =>
                    managerProjectIdentityRegistrations(
                      connection.services,
                      workspacePath,
                      async () => {
                        await connection.services.sourceServerWorkspaceService.resolveWorkspace({
                          workspacePath,
                        });
                        return buildServerRemoteWorkspaceIdentity({
                          serverId: sourceServerId,
                          workspacePath,
                        });
                      },
                    ),
                );
              },
              parentPort,
              credentialCipherProvider: credentialCipherBridge.cipher,
              settingService,
              prepareLegacyAccountConnections,
              hostApiNetworkTransport,
              resolveClientLanguage: resolveHostClientLanguage,
              authorizeLocalMediaPreviewPath,
              // launch.md「The user's choice」：本机用户选择变化后，推给本窗口所有在线的远程 Host。
              forwardDynamicWorkflowUserMode: (mode) => {
                void pushDynamicWorkflowUserModeToRemoteHosts(
                  windowRemoteConnectionRegistry
                    .listReadyConnections()
                    .map(({ target, services: remoteServices }) => ({
                      target,
                      zcodeAgentService: remoteServices.get(IZCodeAgentService),
                    })),
                  mode,
                  (error) => logger.warn("remote dynamic workflow user mode forward failed", error),
                );
              },
              registerPluginSandbox: pluginSandboxRegistrationBridge.register,
              runtimeProcessEnvPatch: msg.runtimeProcessEnvPatch,
              agentTelemetry: {
                getDeviceMid: () => msg.deviceMid,
                runtimeSurface: "desktop_local_host",
              },
              serviceAuthorityMode: "desktop-local",
              zcodeAgentSpawnFallbackCwd: msg.agentSpawnFallbackCwd,
              zcodeBuiltinProviderConfigFilePath: msg.zcodeBuiltinProviderConfigFilePath,
              processLifecycleReporter: runtimeProcessLifecycleReporter,
              taskRuntimeReporter: runtimeTaskReporter,
              quitBlockerReporter,
              feedback: {
                apiBaseUrl: msg.feedbackApiBase,
                createFullLogArchive: createFullFeedbackLogArchiveViaMain,
              },
              forwardSessionMessageSendRequested: (request) => {
                parentPort?.postMessage({
                  type: HostResponseTypes.SessionMessageSendRequested,
                  request,
                });
              },
              onAutomationManualRunRequested: dispatchManualAutomationRun,
              onOffPeakSchedulerWakeRequested: () => {
                parentPort?.postMessage({ type: HostResponseTypes.OffPeakSchedulerWakeRequest });
              },
              onProviderProvisioningSourceChanged: (trigger) => {
                parentPort?.postMessage({
                  type: HostResponseTypes.ProviderProvisioningSourceChanged,
                  trigger,
                });
              },
              // browser-use：agent 的 interaction/browserExecute 经 zcodeAgentService 转到这个 executor，
              // 再经 parentPort 到 main 的 WebContentsView+CDP 执行。
              browserControlExecutor: browserControlMainBridge,
              appControlNavigation,
              // CUA 顶部提示属于物理 Windows 桌面投影；非 Windows 和远端 authority 都不得上报。
              cuaOperationStateReporter:
                process.platform === "win32" ? cuaOperationStateReporter : undefined,
            });
            activeServices = initializedServices;
            activeHostApiNetworkTransport = hostApiNetworkTransport;
            return initializedServices;
          },
        });
        const zcodeTaskService = services.getOptional(IZCodeTaskService);
        if (zcodeTaskService) {
          const reportingZCodeTaskService = createReportingRemoteZCodeTaskService(
            zcodeTaskService,
            {
              reportRunningPromptCount: false,
            },
          );
          services.register(IZCodeTaskService, reportingZCodeTaskService);
        }
        sourceServerDirectory = new SourceServerDirectory({
          settingService: services.get(ISettingService),
          credentialService: services.get(ICredentialService),
          // host 域无 debug 日志通道；按 debug 语义仅在非生产输出，生产 no-op 防止刷盘。
          logDebug: (message) => {
            if (process.env.NODE_ENV !== "production") logger.info(message);
          },
          logWarn: (message) => logger.warn(message),
        });
        sourceServerArtifactPolicy =
          msg.remoteAssets?.sourceServerArtifactPolicy ?? "release-versioned";
        // Bug 原因：release resolver 过去只传给 updateSource；启动恢复和 connectProfile 直接调用
        // Manager，在 development-content-addressed 同版本校验处拿不到本地 archive，必然误报 unavailable。
        const resolveSourceServerRelease = async (
          probe: Parameters<typeof resolveSourceServerReleaseAsset>[0],
          target: Parameters<typeof resolveSourceServerReleaseAsset>[2],
          options?: Parameters<typeof resolveSourceServerReleaseAsset>[4],
        ) =>
          await resolveSourceServerReleaseAsset(
            probe,
            msg.remoteAssets ?? {},
            target,
            {
              fetch: hostApiNetworkTransport.fetch,
            },
            options,
          );
        sourceServerConnectionManager = new SourceServerConnectionManager({
          directory: sourceServerDirectory,
          admitConnection: createRemoteProjectConnectionAdmission(
            services.get(IRemoteProjectService),
          ),
          onProjectChange: notifyProjectChange,
          logWarn: (message, error) => logger.warn(message, error),
          sourceServerArtifactPolicy,
          resolveRelease: resolveSourceServerRelease,
        });
        sourceServerManagementService = createSourceServerManagementService({
          directory: sourceServerDirectory,
          manager: sourceServerConnectionManager,
          resolveRelease: resolveSourceServerRelease,
          onDirectorySnapshot: (snapshot) => {
            sourceServerDisplayNameById.clear();
            for (const server of snapshot.servers) {
              sourceServerDisplayNameById.set(server.sourceServerId, server.displayName);
            }
          },
          onBeforeSourceServerRemoved: async (sourceServerId) => {
            const hostId = remoteHostIdFromWorkspaceIdentity(
              buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath: "/" }),
            );
            if (!hostId) throw new Error("remote-project.invalid-host-identity");
            await services.get(IRemoteProjectService).removeHost(hostId);
            windowHostAttachmentRegistry.detachSourceSettingsAttachments(sourceServerId);
            sourceServerDisplayNameById.delete(sourceServerId);
          },
          releaseUnboundProfileHost: async (profile, profiles) =>
            await releaseRemoteProjectProfileHost(
              services.get(IRemoteProjectService),
              profile,
              profiles,
            ),
        });
        sourceSettingsStateSubscription = sourceServerConnectionManager.onDidChangeState(
          (state) => {
            notifyProjectChange();
            if (state.sourceServerId && shouldDetachSourceSettingsAttachment(state.state)) {
              windowHostAttachmentRegistry.detachSourceSettingsAttachments(state.sourceServerId);
            }
          },
        );
        services.register(ISourceServerManagementService, sourceServerManagementService);
        // 数据同步页的设备同步状态只属于本机 Host：不进入远程 workspace RPC 合同、
        // source-settings 服务集合，也不在手机 attachment 白名单中。
        services.register(
          IDeviceSyncStateService,
          createDeviceSyncStateService({
            filePath: join(getAppConfigDir(), "data-sync-state.json"),
          }),
        );
        services.register(
          IProviderProvisioningStatusService,
          hostProviderProvisioningStatus.service,
        );
        // 扩展门面只在桌面本机 Host 注册：不进远程 workspace 合同、source-settings 与手机白名单。
        // 必须在 base attachment 之前注册，否则这条端口上看不到该频道。
        windowHostExtensions?.dispose();
        windowHostExtensions = createWindowHostExtensions({
          pluginManagement: services.get(IPluginManagementService),
          // context 组成与生成速率的数据泵（docs/plugins/extension-host.md §9、§10），也是会话读连接的底座（§17.5）。
          agent: services.get(IZCodeAgentService),
          // 会话列表泵（§17.5）：与侧栏、手机同一份控制器投影，只在本进程内交给扩展门面。
          taskRows: {
            read: () => windowHostControllerRuntime.readTaskRows(),
            subscribe: (onChange) => windowHostControllerRuntime.subscribeTaskRows(onChange),
          },
          // 扩展视图与 MCP App 共用同一条 Host → Main 沙箱登记桥（contentKind "extension"）。
          registerSandbox: pluginSandboxRegistrationBridge.register,
          inventoryWorkspacePath: msg.agentSpawnFallbackCwd ?? process.cwd(),
          // 扩展 settings 能力的读取器（含敏感值，§16.7）：只在本进程内交给网关，不登记为服务。
          userOptionsReader: getPluginUserOptionsReader(services),
          appControl: appControlForExtensions,
          // 插件项目（§17.4）：本机项目服务，与侧栏「新建项目」同一条 saveProject 路径。
          projects: services.get(IProjectService),
          // 能力 models.list（§18.1 H9）：与输入框模型选择器同一份视图。
          modelSelection: services.get(IModelSelectionService),
          // 授权记录与审计（§17.7、§17.8）：~/.zcode/v2/extensions，只由扩展门面读写。
          dataDir: join(getAppConfigDir(), "extensions"),
          postToMain: (message) => parentPort.postMessage(message),
        });
        services.register(IExtensionsService, windowHostExtensions.service);
        services.register(IExtensionViewsService, windowHostExtensions.viewsService);
        services.register(IExtensionGrantsService, windowHostExtensions.grantsService);
        wireLocalResourceTelemetry(services);
        hasDisposedHostResources = false;
        disposeHostResourcesInFlight = null;
        const agentWarmupTargets =
          msg.agentWarmupTargets && msg.agentWarmupTargets.length > 0
            ? msg.agentWarmupTargets
            : msg.workspacePath
              ? [
                  {
                    workspacePath: msg.workspacePath,
                    ...(msg.workspaceIdentity ? { workspaceIdentity: msg.workspaceIdentity } : {}),
                  },
                ]
              : [];
        // Main 已把启动预热限制为 active workspace 1 个；Host 必须显式消费这份固定名单，
        // 不能让后续 task-list observer 再隐式扩大，也不能因失败扫描补位。
        agentWarmupTargets.forEach((target, index) => {
          warmUpZCodeAgent(
            services,
            target,
            `local host init (${index + 1}/${agentWarmupTargets.length})`,
          );
        });
        logger.info("exposing services on ChannelServer...");
        if (!basePortClosed)
          windowHostAttachmentRegistry.attach({
            requestId: `init-local-${randomUUID()}`,
            attachmentId: `base-${randomUUID()}`,
            clientMode: "desktop-continuous",
            scope: { kind: "local" },
            port,
          });
        logWindowHostTopology("base-attachment-ready");
        logger.info("local services ready, all channels registered");
        // 服务就绪后请 Main 牵线扩展进程（首个就绪的 Window Host 会拉起它）。
        windowHostExtensions.announceReady();
        // URL Host 复用相同启动开关与 Registry；项目发现不创建 logical workspace/Agent。
        void runStartupReconnectBatch({
          getSettings: () => services.get(ISettingService).get(),
          listCandidates: async () =>
            (await services.get(IRemoteProjectService).readDirectory()).hosts.filter(
              (host) => host.kind === "server",
            ),
          reconnect: (hosts) =>
            Promise.all(
              hosts.map(async (host) => {
                try {
                  await services.get(IRemoteProjectService).connectHost(host.id);
                } catch (error) {
                  logger.warn("URL Server startup reconnect failed", { hostId: host.id, error });
                }
              }),
            ),
        }).catch((error) => logger.warn("URL Server startup directory unavailable", error));

        // Bug 原因：Directory 迁移属于远程附加能力，等待它完成会把本地 base attachment 的
        // 首帧一起拖住。base ready 后再后台初始化；失败 flight 清空，用户显式连接仍可重试。
        void sourceServerDirectory
          .initialize()
          .then(async () =>
            runStartupReconnectBatch({
              getSettings: () => services.get(ISettingService).get(),
              listCandidates: async () => {
                const retained = new Set(
                  (await services.get(IRemoteProjectService).readDirectory()).hosts.map(
                    (host) => host.id,
                  ),
                );
                return (await sourceServerDirectory!.listStartupReconnectCandidates()).filter(
                  (candidate) => retained.has(remoteProjectHostIdForProfile(candidate.profile)),
                );
              },
              reconnect: (candidates) =>
                sourceServerConnectionManager!.reconnectOnStartup(candidates),
            }),
          )
          .then((results) => {
            const online = results.filter((result) => result.status === "online").length;
            // Bug 原因：过去只记录失败计数，真实 Profile/reason 被吞掉，导致冷启动失败只能靠
            // 手动重连再次触发。启动批次最多 3 个，逐项 warn 不会形成高频日志。
            for (const result of results) {
              if (result.status === "failed") {
                logger.warn("Source Server startup reconnect failed", {
                  profileId: result.profileId,
                  error: result.error,
                });
              }
            }
            logger.info(
              `Source Server startup reconnect finished, online=${online}, failed=${results.length - online}`,
            );
          })
          .catch((error) =>
            logger.warn(
              "Source Server directory initialization failed; local services remain available",
              error,
            ),
          );
      },
    });
    await databaseStartup.coordinator.start();
  }
});
