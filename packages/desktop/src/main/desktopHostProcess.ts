import type { HostQuitBlocker, HostRemoteConversationTelemetryResponse } from "@zcode/shared";
import {
  createSystemCredentialCipher,
  executeCredentialCipherRequest,
} from "@zcode/shared/credential-security";
import { getAppConfigDir } from "@zcode/services/node";
import { ingestToolExecResource } from "./desktopResourceTelemetry.js";
import { bindAppControlNavigationHost } from "#src/app-control-navigation/main.js";
import { ingestMcpResourceSamples } from "./processResourceMcpTelemetrySource.js";
/* eslint-disable max-lines -- host process 统一处理 main↔host 生命周期、日志、ZCode Agent，拆分前先保持跨进程消息收口。 */
import {
  type HostAgentProcessErrorResponse,
  type HostAgentProcessExceptionResponse,
  type HostAgentProcessExitedResponse,
  type HostAgentProcessReadyResponse,
  type HostAgentProcessSpawnedResponse,
  type HostCuaOperationStateResponse,
  type HostMcpTelemetryResponse,
  type HostSessionCreateTelemetryResponse,
  type HostPluginTelemetryResponse,
  type ProviderProvisioningLaneStatus,
  type RemoteTarget,
  type TaskRealtimeHostDeliveryKind,
  type WorkspacePurpose,
  CREDENTIAL_KEY_SHARE_UNAVAILABLE_ERROR_CODE,
  formatZCodeHostProcessName,
  HostMessageTypes,
  hostResponseMessageSchema,
  HostResponseTypes,
  InternalChannels,
  LAUNCH_MARKS_QUERY_KEY,
  RUNTIME_ZCODE_DEBUG,
  serializeLaunchMarks,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
} from "@zcode/shared";
import type {
  PluginSandboxHandle,
  PluginSandboxRegisterRequestPayload,
  PluginSandboxRegisterResultPayload,
} from "@zcode/shared/mcp-apps";
import type { UtilityProcess as ElectronUtilityProcess, MessagePortMain } from "electron";
import {
  app,
  BrowserWindow,
  utilityProcess as electronUtilityProcess,
  MessageChannelMain,
} from "electron";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { BroadcastHub } from "./broadcastHub.js";
import { bindDatabaseStartupRelay } from "./databaseStartupRelay.js";
import { getMainLaunchPartialMarks } from "./desktopLaunchMarks.js";
import { ingestHostNetworkObservations } from "./desktopNetworkTelemetry.js";
import {
  buildHostProcessEnv,
  hostModulePath,
  resolveBundledGlmBinaryPath,
} from "./desktopRuntimeEnv.js";
import { ingestHostNetworkCapture } from "./resourceManagerNetwork.js";
import { buildHostE2ECoverageEnv } from "./e2eCoverage.js";
import { createFeedbackLogArchiveFromExportLogs } from "./exportLogs.js";
import { createHostLogRelay } from "./hostLogRelay.js";
import { ingestCliResourceSample } from "./processResourceCliSource.js";
import { ingestHostSelfResourceSample } from "./processResourceSelfHeapSource.js";
import { resolveHostResourceUsageResult } from "./resourceManagerHostSampling.js";
import {
  registerHostAgentProcess,
  registerHostProcess,
  unregisterHostAgentProcess,
  unregisterHostProcess,
} from "./resourceManagerWindow.js";
import type { RemoteAssetDirs } from "./desktopRuntimeEnv.js";
import type { TaskRealtimeBus } from "./taskRealtimeBus.js";

export interface WindowBootstrapOptions {
  restoreSession?: boolean;
  supportsSettings?: boolean;
  initialWorkspacePath?: string;
  initialWorkspacePurpose?: WorkspacePurpose;
  unavailableWorkspacePath?: string;
  windowKind?: "main" | "update-status";
  locale?: string;
}

export interface HostInitMessage {
  browserBackendIdentity?: { id: string; generation: number };
  type: typeof HostMessageTypes.InitLocal;
  hostId?: string;
  databaseStartupId?: string;
  deliveryKind?: TaskRealtimeHostDeliveryKind;
  deviceMid?: string;
  feedbackApiBase?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  agentWarmupTargets?: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
  }>;
  agentSpawnFallbackCwd?: string;
  remoteAssets?: RemoteAssetDirs;
  /** Main 解析后的 ZCode Built-in Provider Config 路径；Host/Services 不感知 Electron 安装布局。 */
  zcodeBuiltinProviderConfigFilePath: string;
  /** Main 提前异步采集并过滤的本机 runtime 环境；只允许传给 InitLocal。 */
  runtimeProcessEnvPatch?: Record<string, string>;
}

export interface SpawnHostProcessOptions {
  internalChannel?: typeof InternalChannels.ServicePort | typeof InternalChannels.ScopedServicePort;
  internalPayload?: unknown;
  registerBroadcast?: boolean;
  taskRealtime?: {
    workspaceKeys: Iterable<string>;
    deliveryKind?: TaskRealtimeHostDeliveryKind;
    onHostId?: (hostId: string) => void;
  };
  onPortReady?: (port: MessagePortMain) => void;
  /** 共享 SSH/WSL Host 初始化时不创建特殊的首个 workspace RPC port。 */
  attachInitialServicePort?: boolean;
}

const exitedHostProcesses = new WeakSet<ElectronUtilityProcess>();
const disposingHostProcesses = new Set<ElectronUtilityProcess>();

export function listDisposingHostProcesses(): ElectronUtilityProcess[] {
  return Array.from(disposingHostProcesses);
}

export function loadWindow(
  win: BrowserWindow,
  page: "index" | "login" = "index",
  bootstrap?: WindowBootstrapOptions,
): Promise<void> {
  const query = Object.fromEntries(
    Object.entries({
      restoreSession:
        bootstrap?.restoreSession == null ? undefined : String(bootstrap.restoreSession),
      supportsSettings:
        bootstrap?.supportsSettings == null ? undefined : String(bootstrap.supportsSettings),
      initialWorkspacePath: bootstrap?.initialWorkspacePath,
      initialWorkspacePurpose: bootstrap?.initialWorkspacePurpose,
      unavailableWorkspacePath: bootstrap?.unavailableWorkspacePath,
      windowKind: bootstrap?.windowKind,
      locale: bootstrap?.locale,
    }).filter((entry): entry is [string, string] => entry[1] != null),
  );

  if (page === "index") {
    const partial = getMainLaunchPartialMarks();
    query[LAUNCH_MARKS_QUERY_KEY] = serializeLaunchMarks({
      ...partial,
      loadUrl: Date.now(), // T3
    });
  }

  // 生产包不能信任继承环境中的开发服务器地址，否则会被本机开发会话劫持为空白页。
  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    const base = process.env["ELECTRON_RENDERER_URL"];
    const url = new URL(page === "login" ? `${base}/login.html` : base);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return win.loadURL(url.toString());
  } else {
    return win.loadFile(join(import.meta.dirname, `../renderer/${page}.html`), {
      query,
    });
  }
}

export function spawnHostProcess(
  win: BrowserWindow,
  label: string,
  initMessage: HostInitMessage,
  dependencies: {
    hostProcessLocalEnv: Record<string, string>;
    /** Main 进程已完成服务端灰度裁决；Host 只消费这个快照，不自行请求或分桶。 */
    desktopContextPromptEnabled?: () => boolean;
    logger: {
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
    };
    broadcastHub: BroadcastHub;
    taskRealtimeBus?: TaskRealtimeBus;
    windowHostProcessMap: Map<number, ElectronUtilityProcess>;
    hostRunningTaskCountMap: Map<ElectronUtilityProcess, number>;
    /** 每个 Host 当前阻止退出的事项（docs/git/worktree.md §6.4）；空集合时删除条目。 */
    hostQuitBlockersMap: Map<ElectronUtilityProcess, HostQuitBlocker[]>;
    onWorkspaceRunningTaskCountChanged?: (
      child: ElectronUtilityProcess,
      event: {
        workspacePath: string;
        workspaceIdentity?: string;
        runningTaskCount: number;
      },
    ) => void;
    onAgentProcessExited?: (event: HostAgentProcessExitedResponse) => void;
    onAgentProcessError?: (event: HostAgentProcessErrorResponse) => void;
    onAgentProcessException?: (event: HostAgentProcessExceptionResponse) => void;
    onAgentProcessReady?: (event: HostAgentProcessReadyResponse) => void;
    onAgentProcessSpawned?: (event: HostAgentProcessSpawnedResponse) => void;
    onMcpTelemetry?: (event: HostMcpTelemetryResponse) => void;
    onPluginTelemetry?: (event: HostPluginTelemetryResponse) => void;
    onRemoteConversationTelemetry?: (event: HostRemoteConversationTelemetryResponse) => void;
    onSessionCreateTelemetry?: (event: HostSessionCreateTelemetryResponse) => void;
    onCuaOperationStateChanged?: (
      source: ElectronUtilityProcess,
      event: HostCuaOperationStateResponse,
    ) => void;
    onCuaOperationStateSourceExited?: (source: ElectronUtilityProcess) => void;
    /** host → main：定时任务派发结果，转交给 cron scheduler 结算调度状态机。 */
    onCronRunResult?: (result: {
      runId: string;
      ok: boolean;
      taskId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent";
    }) => void;
    /** host → main：闲时任务派发结果，转交给 scheduler 结算（与 cron 独立）。 */
    onOffPeakRunResult?: (result: {
      offPeakTaskId: string;
      ok: boolean;
      lifecycleManaged?: true;
      conversationId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent";
    }) => void;
    /** host 中 manual run 落库后请求 main 立即唤醒 scheduler。 */
    onCronSchedulerWakeRequested?: (automationId: string) => void;
    /** host 中闲时任务翻 schedulable 后请求 main 立即唤醒 scheduler。 */
    onOffPeakSchedulerWakeRequested?: (offPeakTaskId?: string) => void;
    // browser-use：main 用 WebContentsView+CDP 执行一条命令。实现由宿主注入；缺省则 backend_unavailable。
    handleBrowserExecuteRequest?: (params: {
      win: BrowserWindow;
      requestId: string;
      browserId?: string;
      browserGeneration?: number;
      controlScopeId?: string;
      sessionId: string;
      turnId?: string;
      workspaceKey?: string;
      workspacePath?: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode?: "desktop-continuous" | "web-remote-replayable";
      sessionContext?: "live" | "cached";
      command: unknown;
    }) => Promise<{ ok: boolean; [k: string]: unknown }>;
    /** Host 已完成附件授权后，由 Main 将本地视频 realpath 加入精确协议授权集合。 */
    authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
    /** Host 校验完插件 UI HTML 后交给 Main 沙箱注册表登记，返回句柄。 */
    registerPluginSandbox?: (
      input: PluginSandboxRegisterRequestPayload,
    ) => PluginSandboxHandle | Promise<PluginSandboxHandle>;
    /** 数据同步页经本机 Host 读取 / 重试 Main 协调器的 Provisioning lane（按 sourceServerId）。 */
    providerProvisioningLanes?: {
      getStatus(
        sourceServerId: string,
        options: { waitForIdle: boolean },
      ): Promise<ProviderProvisioningLaneStatus>;
      retry(sourceServerId: string): Promise<ProviderProvisioningLaneStatus>;
    };
  },
  options?: SpawnHostProcessOptions,
): ElectronUtilityProcess {
  const hostId = randomUUID();
  // 系统库只由 Main 访问；路径在 fork 时绑定，Host 不能指定其他凭据目录。
  const credentialCipher = createSystemCredentialCipher({
    filePath: join(getAppConfigDir(), "credentials.json"),
  });
  const glmBinaryPath = resolveBundledGlmBinaryPath();
  const execArgv = [
    ...(RUNTIME_ZCODE_DEBUG ? [`--inspect-brk=${RUNTIME_ZCODE_DEBUG}`] : []),
    "--no-warnings",
  ];
  const child = electronUtilityProcess.fork(hostModulePath, [], {
    serviceName: formatZCodeHostProcessName(label),
    execArgv,
    env: {
      ...buildHostProcessEnv(dependencies.hostProcessLocalEnv),
      ...buildHostE2ECoverageEnv(),
      ZCODE_PROCESS_LABEL: label,
      // macOS-only: the Computer Use Helper launcher runs inside this forked host utilityProcess, whose
      // code-signing identity is a nested Electron helper (NOT dev.zcode.app). Publish THIS (main
      // Electron) process's pid — which IS dev.zcode.app — so helperLauncher passes it as
      // `--launcher-pid` and the Helper's signature/peer verification succeeds instead of
      // health-timing out. Env-name mirror of services' LAUNCHER_PID_ENV. Not set on
      // Windows/Linux (CUA is macOS-only; nothing reads it there) to keep the host env pristine.
      ...(process.platform === "darwin" ? { ZCODE_CUA_LAUNCHER_PID: String(process.pid) } : {}),
      ...(dependencies.desktopContextPromptEnabled
        ? {
            [ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]: dependencies.desktopContextPromptEnabled()
              ? "1"
              : "0",
          }
        : {}),
    },
  });

  dependencies.logger.info(
    `[spawnHostProcess] forked host process for (${label}), pid=${child.pid}`,
  );
  dependencies.logger.info(`[spawnHostProcess] host module path: ${hostModulePath}`);
  dependencies.logger.info(`[spawnHostProcess] glm binary path: ${glmBinaryPath ?? "<not found>"}`);
  dependencies.logger.info(
    `[spawnHostProcess] BIGMODEL_OAUTH_APP_SECRET source: ${process.env.BIGMODEL_OAUTH_APP_SECRET ? "process" : dependencies.hostProcessLocalEnv.BIGMODEL_OAUTH_APP_SECRET ? "dotenv" : "fallback"}`,
  );

  // 远程连接与本地服务共享 window Host，进程级 stdout 没有请求身份。
  // 连接进度改由 HostResponseTypes.RemoteWorkspaceConnectionLog 按 requestId 上报。
  const hostLogRelay = createHostLogRelay(
    label,
    dependencies.logger as Parameters<typeof createHostLogRelay>[1],
  );

  child.stderr?.on("data", (data: Buffer) => {
    hostLogRelay.onStderr(data.toString());
  });
  child.stdout?.on("data", (data: Buffer) => {
    hostLogRelay.onStdout(data.toString());
  });

  const databaseStartupRelay = bindDatabaseStartupRelay(win, child, hostId);
  const unbindAppNavigation = bindAppControlNavigationHost(win, child, (id) =>
    BrowserWindow.fromId(id),
  );
  child.once("exit", unbindAppNavigation);
  child.on("message", (message: unknown) => {
    const result = hostResponseMessageSchema.safeParse(message);
    if (!result.success) {
      return;
    }

    if (result.data.type === HostResponseTypes.CredentialCipherRequest) {
      const { type: _type, ...request } = result.data;
      void executeCredentialCipherRequest(credentialCipher, request)
        .then((reply) => {
          if (!exitedHostProcesses.has(child)) {
            child.postMessage({ type: HostMessageTypes.CredentialCipherResult, ...reply });
          }
        })
        .catch(() => {
          // Host 已退出时只能放弃回包；任何凭据输入/结果都不得进入日志。
        });
      return;
    }

    if (result.data.type === HostResponseTypes.CredentialKeyShareRequest) {
      const { requestId, targetBaseDir } = result.data;
      // 修复原因（ZCT-2120723935487688704）：切换数据存储路径只复制凭据文件，新根缺少系统条目，
      // 重启后掉登录且无法重新登录。Host 只提供数据根；凭据路径由 Main 按 copyDataDirectory 的
      // 目标布局推导，密钥不离开 Main，也不开放对目标目录的加解密。
      const share = isAbsolute(targetBaseDir)
        ? credentialCipher.shareKeyWithCopiedCredentials(
            join(targetBaseDir, ".zcode", "v2", "credentials.json"),
          )
        : Promise.reject(new Error("Data root must be absolute"));
      void share
        .then(
          () => ({ ok: true }),
          () => ({ ok: false, errorCode: CREDENTIAL_KEY_SHARE_UNAVAILABLE_ERROR_CODE }),
        )
        .then((reply) => {
          dependencies.logger.info(`[credential-key-share] ${reply.ok ? "completed" : "failed"}`);
          if (!exitedHostProcesses.has(child)) {
            child.postMessage({
              type: HostMessageTypes.CredentialKeyShareResult,
              requestId,
              ...reply,
            });
          }
        })
        .catch(() => {
          // Host 已退出时只能放弃回包；原生异常不进入日志，避免泄露系统细节。
        });
      return;
    }

    if (result.data.type === HostResponseTypes.DatabaseStartupState) {
      databaseStartupRelay.receive(result.data.state);
      return;
    }

    if (result.data.type === HostResponseTypes.Log) {
      hostLogRelay.onStructuredLog(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.NetworkTelemetryBatch) {
      ingestHostNetworkObservations(result.data.observations);
      return;
    }
    if (result.data.type === HostResponseTypes.NetworkCaptureBatch) {
      ingestHostNetworkCapture(result.data.batch, child.pid ?? 0);
      return;
    }
    // CLI 自采的 60 秒样本：按 services 打的 lane 归入 cli_chat / cli_aux 角色。
    if (result.data.type === HostResponseTypes.AgentResourceSample) {
      ingestCliResourceSample(
        result.data.sample,
        result.data.runtimeSurface,
        result.data.environmentKey,
      );
      return;
    }

    // Host 自采的 60 秒样本：main 只取 heap 作 host 角色事件的 heap 维度。
    if (result.data.type === HostResponseTypes.HostResourceSample) {
      ingestHostSelfResourceSample(result.data.sample);
      return;
    }

    if (result.data.type === HostResponseTypes.ResourceUsageSnapshotResult) {
      resolveHostResourceUsageResult(label, result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.ToolExecResource) {
      ingestToolExecResource(result.data.sample, result.data.runtimeSurface);
      return;
    }

    if (result.data.type === HostResponseTypes.McpResourceSamples) {
      ingestMcpResourceSamples(
        result.data.samples,
        result.data.runtimeSurface,
        result.data.environmentKey,
      );
      return;
    }

    if (result.data.type === HostResponseTypes.McpTelemetry) {
      dependencies.onMcpTelemetry?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.PluginTelemetry) {
      dependencies.onPluginTelemetry?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.RemoteConversationTelemetry) {
      dependencies.onRemoteConversationTelemetry?.(result.data);
      return;
    }
    if (result.data.type === HostResponseTypes.SessionCreateTelemetry) {
      dependencies.onSessionCreateTelemetry?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.LocalMediaPreviewPathAuthorizeRequest) {
      const request = result.data;
      const authorize = dependencies.authorizeLocalMediaPreviewPath;
      if (!authorize) {
        child.postMessage({
          type: HostMessageTypes.LocalMediaPreviewPathAuthorizeResult,
          requestId: request.requestId,
          ok: false,
          error: "Local media preview path authorization is unavailable.",
        });
        return;
      }
      void authorize(request.path)
        .then((path) => {
          child.postMessage({
            type: HostMessageTypes.LocalMediaPreviewPathAuthorizeResult,
            requestId: request.requestId,
            ok: true,
            path,
          });
        })
        .catch((error) => {
          child.postMessage({
            type: HostMessageTypes.LocalMediaPreviewPathAuthorizeResult,
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (result.data.type === HostResponseTypes.PluginSandboxRegisterRequest) {
      const request = result.data;
      const register = dependencies.registerPluginSandbox;
      const reply = (payload: PluginSandboxRegisterResultPayload) =>
        child.postMessage({ type: HostMessageTypes.PluginSandboxRegisterResult, ...payload });
      if (!register || win.isDestroyed() || request.ownerWebContentsId !== win.webContents.id) {
        reply({
          requestId: request.requestId,
          ok: false,
          error: "Plugin UI sandbox is unavailable.",
        });
        return;
      }
      void Promise.resolve()
        // schema 的 refine 已按 contentKind 校验归属（扩展视图无会话，其他类型必须有会话）；
        // zod 的推导类型表达不出这层判别，这里收窄成契约的判别联合。
        .then(() => register(request as PluginSandboxRegisterRequestPayload))
        .then((handle) => reply({ requestId: request.requestId, ok: true, ...handle }))
        .catch((error: unknown) =>
          reply({
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return;
    }

    if (result.data.type === HostResponseTypes.CuaOperationState) {
      // Main 只投影 Host 已经判定的 turn 状态，不在这里重复解析 session/tool 业务事件。
      dependencies.onCuaOperationStateChanged?.(child, result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.ProviderProvisioningLaneRequest) {
      const request = result.data;
      const lanes = dependencies.providerProvisioningLanes;
      const reply = (status: ProviderProvisioningLaneStatus) =>
        child.postMessage({
          type: HostMessageTypes.ProviderProvisioningLaneResult,
          requestId: request.requestId,
          status,
        });
      // 没有协调器（例如未接线的测试宿主）时回「无 lane」：Host 请求总有应答，不靠超时收尾。
      if (!lanes) {
        reply({ lane: "none" });
        return;
      }
      void (
        request.action === "retry"
          ? lanes.retry(request.sourceServerId)
          : lanes.getStatus(request.sourceServerId, { waitForIdle: request.action === "wait" })
      ).then(reply, (error: unknown) => {
        // 协调器的查询与重试不会抛出；万一抛出也要应答，避免 Renderer 一直停在「同步中」。
        dependencies.logger.warn("[provider-provisioning] lane request failed", {
          action: request.action,
          error: error instanceof Error ? error.message : String(error),
        });
        reply({ lane: "none" });
      });
      return;
    }

    if (result.data.type === HostResponseTypes.FeedbackLogArchiveRequest) {
      const request = result.data;
      void createFeedbackLogArchiveFromExportLogs(request.sourceDir)
        .then((archive) => {
          child.postMessage({
            type: HostMessageTypes.FeedbackLogArchiveResult,
            requestId: request.requestId,
            ok: true,
            path: archive.path,
            size: archive.size,
          });
        })
        .catch((error) => {
          child.postMessage({
            type: HostMessageTypes.FeedbackLogArchiveResult,
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (result.data.type === HostResponseTypes.BrowserExecuteRequest) {
      // browser-use：main 用 WebContentsView+CDP 执行命令（handleBrowserExecuteRequest）。
      // 缺省实现时返回 backend_unavailable，保证通道打通但不阻塞。
      const requestId = result.data.requestId;
      const handler = dependencies.handleBrowserExecuteRequest;
      const fallback = {
        ok: false as const,
        error: {
          code: "backend_unavailable",
          message: "browser executor not ready",
        },
        elapsedMs: 0,
      };
      void (
        handler
          ? handler({
              win,
              requestId,
              controlScopeId: result.data.controlScopeId,
              browserId: result.data.browserId,
              browserGeneration: result.data.browserGeneration,
              sessionId: result.data.sessionId,
              turnId: result.data.turnId,
              workspaceKey: result.data.workspaceKey,
              workspacePath: result.data.workspacePath,
              workspaceIdentity: result.data.workspaceIdentity,
              remoteSessionId: result.data.remoteSessionId,
              clientMode: result.data.clientMode,
              sessionContext: result.data.sessionContext,
              command: result.data.command,
            }).catch((error: unknown) => ({
              ok: false as const,
              error: {
                code: "execution_error",
                message: error instanceof Error ? error.message : String(error),
              },
              elapsedMs: 0,
            }))
          : Promise.resolve(fallback)
      ).then((commandResult) => {
        child.postMessage({
          type: HostMessageTypes.BrowserExecuteResult,
          requestId,
          result: commandResult,
        });
      });
      return;
    }

    if (result.data.type === HostResponseTypes.AgentProcessSpawned) {
      registerHostAgentProcess(label, {
        pid: result.data.pid,
        provider: result.data.provider,
        workspacePath: result.data.workspacePath,
        command: result.data.command,
        args: result.data.args,
        startedAt: result.data.startedAt,
      });
      dependencies.onAgentProcessSpawned?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.AgentProcessReady) {
      dependencies.onAgentProcessReady?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.AgentProcessExited) {
      unregisterHostAgentProcess(label, result.data.pid);
      dependencies.onAgentProcessExited?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.AgentProcessError) {
      dependencies.onAgentProcessError?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.AgentProcessException) {
      dependencies.onAgentProcessException?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.CronRunResult) {
      dependencies.onCronRunResult?.({
        runId: result.data.runId,
        ok: result.data.ok,
        taskId: result.data.taskId,
        sessionId: result.data.sessionId,
        error: result.data.error,
        failureKind: result.data.failureKind,
      });
      return;
    }

    if (result.data.type === HostResponseTypes.OffPeakRunResult) {
      dependencies.onOffPeakRunResult?.({
        offPeakTaskId: result.data.offPeakTaskId,
        ok: result.data.ok,
        lifecycleManaged: result.data.lifecycleManaged,
        conversationId: result.data.conversationId,
        sessionId: result.data.sessionId,
        error: result.data.error,
        failureKind: result.data.failureKind,
      });
      return;
    }

    if (result.data.type === HostResponseTypes.CronSchedulerWakeRequest) {
      dependencies.onCronSchedulerWakeRequested?.(result.data.automationId);
      return;
    }

    if (result.data.type === HostResponseTypes.OffPeakSchedulerWakeRequest) {
      dependencies.onOffPeakSchedulerWakeRequested?.(result.data.offPeakTaskId);
      return;
    }

    if (result.data.type === HostResponseTypes.QuitBlockersChanged) {
      if (result.data.blockers.length > 0) {
        dependencies.hostQuitBlockersMap.set(child, result.data.blockers);
      } else {
        dependencies.hostQuitBlockersMap.delete(child);
      }
      return;
    }

    if (result.data.type === HostResponseTypes.AgentRunningTaskCountChanged) {
      if (result.data.runningTaskCount > 0) {
        dependencies.hostRunningTaskCountMap.set(child, result.data.runningTaskCount);
      } else {
        dependencies.hostRunningTaskCountMap.delete(child);
      }
      dependencies.logger.info(
        `[app-quit] host running agent sessions updated (${label}) count=${result.data.runningTaskCount}`,
      );
      return;
    }

    if (result.data.type === HostResponseTypes.WorkspaceRunningTaskCountChanged) {
      dependencies.onWorkspaceRunningTaskCountChanged?.(child, {
        workspacePath: result.data.workspacePath,
        workspaceIdentity: result.data.workspaceIdentity,
        runningTaskCount: result.data.runningTaskCount,
      });
      return;
    }
  });

  const shouldAttachRealtimeHost = options?.taskRealtime != null;
  const hostInitMessage: HostInitMessage = shouldAttachRealtimeHost
    ? {
        ...initMessage,
        databaseStartupId: databaseStartupRelay.startupId,
        hostId,
        deliveryKind: options?.taskRealtime?.deliveryKind,
      }
    : { ...initMessage, databaseStartupId: databaseStartupRelay.startupId };

  if (options?.attachInitialServicePort === false) {
    child.postMessage(hostInitMessage);
  } else {
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage(hostInitMessage, [port2]);

    if (options?.onPortReady) {
      options.onPortReady(port1);
    } else {
      win.webContents.postMessage(
        options?.internalChannel ?? InternalChannels.ServicePort,
        options?.internalChannel === InternalChannels.ScopedServicePort
          ? (options.internalPayload ?? null)
          : { databaseStartupId: databaseStartupRelay.startupId },
        [port1],
      );
    }
  }

  const windowId = win.webContents.id;
  const shouldRegisterBroadcast = options?.registerBroadcast ?? true;
  if (shouldRegisterBroadcast) {
    dependencies.broadcastHub.register(windowId, child);
  }

  if (shouldAttachRealtimeHost && dependencies.taskRealtimeBus && options?.taskRealtime) {
    dependencies.taskRealtimeBus.registerHost({
      hostId,
      windowId: win.id,
      child,
      workspaceKeys: options.taskRealtime.workspaceKeys,
      deliveryKind: options.taskRealtime.deliveryKind,
    });
    options.taskRealtime.onHostId?.(hostId);
  }

  registerHostProcess(label, child);

  child.on("exit", (code) => {
    exitedHostProcesses.add(child);
    // Host exit 是 fail-hidden 权威边界；不能依赖即将退出的 Host 再补发 inactive。
    dependencies.onCuaOperationStateSourceExited?.(child);
    hostLogRelay.flushRawLogs();
    dependencies.logger.info(`[spawnHostProcess] host process (${label}) exited with code ${code}`);
    dependencies.hostRunningTaskCountMap.delete(child);
    dependencies.hostQuitBlockersMap.delete(child);
    if (shouldRegisterBroadcast) {
      dependencies.broadcastHub.unregister(windowId);
    }
    unregisterHostProcess(label);
    for (const [wcId, process] of dependencies.windowHostProcessMap) {
      if (process === child) {
        dependencies.windowHostProcessMap.delete(wcId);
        break;
      }
    }
  });

  return child;
}

export function disposeHostProcess(
  child: ElectronUtilityProcess,
  label: string,
  disposingHostProcessTimers: WeakMap<ElectronUtilityProcess, ReturnType<typeof setTimeout>>,
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  forceKillDelayMs = 300,
) {
  if (disposingHostProcessTimers.has(child)) {
    return;
  }
  disposingHostProcesses.add(child);

  logger.info(
    `[disposeHostProcess] disposing host process (${label}), pid=${child.pid ?? "unknown"}`,
  );

  try {
    child.postMessage({ type: HostMessageTypes.Dispose });
  } catch (error) {
    logger.warn(`[disposeHostProcess] failed to post dispose to (${label}):`, error);
  }

  // host 收到 Dispose 后需要等待 agent 进程树的 SIGTERM/SIGKILL 兜底完成。
  // 如果 main 仍按 150/300ms 强杀 host，host 会先退出，zcode-cli/app-server 子进程就可能被 init 接管成孤儿。
  const effectiveForceKillDelayMs = Math.max(forceKillDelayMs, 3_500);
  const killTimer = setTimeout(() => {
    disposingHostProcessTimers.delete(child);
    try {
      child.kill();
    } catch (error) {
      logger.warn(`[disposeHostProcess] failed to kill host process (${label}):`, error);
    }
  }, effectiveForceKillDelayMs);

  disposingHostProcessTimers.set(child, killTimer);
  child.once("exit", () => {
    exitedHostProcesses.add(child);
    disposingHostProcesses.delete(child);
    clearTimeout(killTimer);
    disposingHostProcessTimers.delete(child);
  });
}
export function disposeHostProcessAndWait(
  child: ElectronUtilityProcess,
  label: string,
  disposingHostProcessTimers: WeakMap<ElectronUtilityProcess, ReturnType<typeof setTimeout>>,
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  options: {
    forceKillDelayMs?: number;
    waitTimeoutMs?: number;
  } = {},
): Promise<void> {
  // Electron UtilityProcess 不是 Node ChildProcess，没有 exitCode 字段。
  // 右键 Dock 退出会走 before-quit -> disposeHostProcessAndWait；旧判断把运行中的 host
  // 的 undefined exitCode 当成“已退出”。这里改为记录 exit 事件，避免第一次退出漏发 Dispose。
  if (exitedHostProcesses.has(child)) {
    return Promise.resolve();
  }

  const waitTimeoutMs = Math.max(options.waitTimeoutMs ?? 0, 0);

  return new Promise((resolve) => {
    let settled = false;
    let waitTimeout: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (waitTimeout) {
        clearTimeout(waitTimeout);
        waitTimeout = null;
      }
      resolve();
    };

    child.once("exit", () => {
      exitedHostProcesses.add(child);
      settle();
    });

    if (waitTimeoutMs > 0) {
      waitTimeout = setTimeout(() => {
        logger.warn(
          `[disposeHostProcessAndWait] host process exit wait timed out (${label}), pid=${child.pid ?? "unknown"}`,
        );
        settle();
      }, waitTimeoutMs);
      waitTimeout.unref?.();
    }

    disposeHostProcess(child, label, disposingHostProcessTimers, logger, options.forceKillDelayMs);
  });
}
