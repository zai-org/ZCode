import { createNodePluginAdapter } from "@zcode/adapters/plugins";
import { createOfficialPluginPreparation } from "./app/bundled-plugins.js";
import { resolveZCodePlugins } from "./plugins.js";
import { createMcpTransportFetch } from "@zcode/adapters";
import { createSharedZCodeCredentialStore } from "@zcode/adapters/auth";
import { createCredentialCipherBridge } from "@zcode/shared/credential-security";
import { credentialCipherReplySchema, zcodeProtocolMethods } from "@zcode/shared";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import type { McpElicitationPort, McpNotificationPort } from "@zcode/contracts";
import { createNodeModelSelectionFacade } from "@zcode/provider-node";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import {
  createMcpAdapterConnectionPool,
  createMcpTelemetryTracker,
  type McpConnectionPool,
  type McpTelemetryTracker,
} from "@zcode/adapters/mcp";
import {
  zcodeProtocolNotifications,
  type ZCodeMcpResourceSample,
  type ZCodeMcpTelemetryEvent,
} from "@zcode/shared";
import { createNodeSessionDataFiles, type SqliteSessionStore } from "@zcode/adapters/storage";
import { traceContextToLogContext, createRootTraceContext } from "@zcode/contracts";
import type { McpPort, ModelSelection } from "@zcode/contracts";
import type { PresentationSurface } from "@zcode/core";
import type { RunZCodeProtocolAgentOptions, ZCodeAppOptions } from "./app/types.js";
import { createZCodeApp } from "./app/create-app.js";
import {
  createNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./app/node-repl-browser-broker.js";
import {
  openProtocolStartupStorage,
  prepareProtocolStartupStorage,
} from "./zcode-protocol/storage-startup.js";
import { closeSessionStore, getSessionDbPath } from "./app/session-store.js";
import { resolveMcpNodeFallbackProvider } from "./app/mcp-node-fallback.js";
import { getCliStorageRoot, getPluginStorageRoot, getProjectMemoryRoot } from "./app/paths.js";
import { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
import { scheduleStartupLogRetentionCleanup } from "./log-retention.js";
import { resolveProcessProviderEndpointRoutingPort } from "./provider-endpoint-routing.js";
import { StartupTimer, startupNow } from "./startup-logging.js";
import { installZCodeProtocolAiSdkWarningLogger } from "./zcode-protocol/ai-sdk-warning-logger.js";
import {
  createOfficialCommandAuthHeadersPort,
  createOfficialMcpAuthHeadersPort,
  type OfficialMcpAuthRequestContext,
} from "./zcode-protocol/official-mcp-auth-port.js";
import {
  createOfficialCommandEndpoint,
  type OfficialCommandEndpoint,
} from "./official-command-endpoint/index.js";
import {
  createOfficialMcpTrustedOriginRegistry,
  OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV,
  ZCODE_WORKSPACE_IDENTITY_ENV,
  resolveRuntimeZCodeEndpointOrigin,
} from "@zcode/shared";
import { ZCodeProtocolAgentServer } from "./zcode-protocol/server.js";
import { ZCodeProtocolNdjsonConnection } from "./zcode-protocol/transport.js";
import { cleanupProtocolRuntime } from "./zcode-protocol/runtime-cleanup.js";
import { startProtocolResourceSampler } from "./zcode-protocol/resource-sampler.js";
import { acquireProtocolStartupResource } from "./zcode-protocol/startup-resource.js";
import { prepareZCodeTelemetryEnv, shutdownZCodeTelemetry } from "./telemetry-bootstrap.js";
import type { ZCodeProcessResourceSampler } from "./process-resource-sampler.js";

export function applyProtocolPresentationSurface(
  options: Omit<ZCodeAppOptions, "providerRegistry">,
  presentationSurface: PresentationSurface,
): Omit<ZCodeAppOptions, "providerRegistry"> {
  return {
    ...options,
    runtimeConfig: {
      ...options.runtimeConfig,
      presentationSurface,
    },
  };
}

/**
 * 进程级 Registry 已就绪后，它就是当前 Environment 的模型事实源。
 *
 * 旧 workspace snapshot 不再参与 Provider 和 Model 执行。
 */
export function applyProtocolProviderRegistry(
  options: Omit<ZCodeAppOptions, "providerRegistry">,
  providerRegistry: ZCodeAppOptions["providerRegistry"],
  configuredDefaultModelSelection?: ModelSelection,
): ZCodeAppOptions {
  return {
    ...options,
    providerRegistry,
    ...(configuredDefaultModelSelection ? { configuredDefaultModelSelection } : {}),
  };
}

export async function runZCodeProtocolAgent(
  options: RunZCodeProtocolAgentOptions = {},
): Promise<void> {
  if (options.prepareStorageOnly) {
    const config = createConfig({ env: options.env });
    await prepareProtocolStartupStorage({
      dbPath: getSessionDbPath(config, options.cwd),
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
    });
    return;
  }
  const startupStartedAt = startupNow();
  const presentationSurface = options.presentationSurface ?? "terminal";
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const loggerFactory = createNodeLoggerFactory({ env: options.env });
  const traceContext = createRootTraceContext({
    attributes: {
      entrypoint: "zcode_protocol",
    },
  });
  const logger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap.zcode_protocol",
  });
  installZCodeProtocolAiSdkWarningLogger(logger);
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap.zcode_protocol",
      startupKind: "zcode_protocol_agent",
    },
    startupStartedAt,
  );
  startupTimer.start("ZCode Protocol agent startup started", {
    context: { version: options.version },
    event: "zcode_protocol.startup.started",
    stage: "start",
  });

  // 修复原因：原先给 seed+discovery 共 3 秒预算，超时后整个进程到重启前都不加载插件。
  // Windows 实测冷启动 seed 官方插件约 3.0~3.1 秒，插件版本升级后的首次启动必然超时。
  // 先停用启动预算：seed 等锁仍由 15 秒共享锁预算兜住，超时按单插件降级回退旧缓存。
  const pluginPreparation = createOfficialPluginPreparation();
  let pluginDiscovery: ReturnType<typeof createNodePluginAdapter> | undefined;
  let pluginPrewarm: Promise<void> | undefined;
  let sessionStore: SqliteSessionStore | undefined;
  let serverForCleanup: ZCodeProtocolAgentServer | undefined;
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let officialCommandEndpoint: OfficialCommandEndpoint | undefined;
  let mcpConnectionPool: McpConnectionPool | undefined;
  let credentialCipherBridge: ReturnType<typeof createProtocolCredentialCipher> | undefined;
  let mcpPort: McpPort | undefined;
  let mcpTelemetryTracker: McpTelemetryTracker | undefined;
  let mcpResourceSink: ((samples: ZCodeMcpResourceSample[]) => void) | undefined;
  let mcpTelemetrySink: ((event: ZCodeMcpTelemetryEvent) => void) | undefined;
  let processResourceSampler: ZCodeProcessResourceSampler | undefined;
  let providerRegistryRuntime:
    | Awaited<ReturnType<typeof startProcessProviderRegistryRuntime>>
    | undefined;
  try {
    // 数据库准备先于账号、Registry 和遥测，不把远端材料等待混进迁移门禁。
    const configResult = createConfig({ env: options.env });
    sessionStore = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      disposeLate: (store) => closeSessionStore(store),
      create: () =>
        openProtocolStartupStorage({
          dbPath: getSessionDbPath(configResult),
          output,
          onProgress: (progress) =>
            logger.info("SQLite startup state", {
              event: "zcode_protocol.startup.storage_state",
              ...progress,
            }),
        }),
    });
    pluginDiscovery = createNodePluginAdapter({
      storageRoot: getPluginStorageRoot(
        getCliStorageRoot(resolvePath(configResult.config.storage.dir)),
      ),
    });
    pluginPrewarm = resolveZCodePlugins({
      pluginDiscovery,
      workspaceIdentity: (options.env ?? process.env)[ZCODE_WORKSPACE_IDENTITY_ENV]?.trim(),
      env: options.env,
      logger,
      workingDirectory: options.cwd,
      pluginPreparation,
    }).then(
      () => undefined,
      (error: unknown) => {
        if (!pluginPreparation.signal.aborted)
          logger.warn("Plugin startup preparation failed", {
            event: "zcode_protocol.plugins.prewarm.failed",
            errorType: error instanceof Error ? error.name : typeof error,
          });
      },
    );
    const runtimeEnv = options.env ?? process.env;
    options.lifecycle?.signal.throwIfAborted();
    providerRegistryRuntime = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      create: () => startProcessProviderRegistryRuntime(runtimeEnv),
      disposeLate: (runtime) => runtime.dispose(),
    });
    options.lifecycle?.signal.throwIfAborted();
    logger.info("Worker Provider Registry 已就绪", {
      accountRevision: providerRegistryRuntime.snapshot.sourceRevisions.account,
      configRevision: providerRegistryRuntime.snapshot.sourceRevisions.config,
      event: "zcode_protocol.provider_registry.ready",
      module: "bootstrap.zcode_protocol",
      providerCount: providerRegistryRuntime.snapshot.registry.providers.length,
    });
    const runtimeSurface = resolveProtocolRuntimeSurface(runtimeEnv);
    const telemetryEnv = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      disposeLate: () => shutdownZCodeTelemetry(),
      create: () =>
        prepareZCodeTelemetryEnv(runtimeEnv, {
          cliVersion: options.version,
          productVersion: options.env?.ZCODE_APP_VERSION,
          runtimeSurface,
        }),
    });
    const telemetryDeviceMid = telemetryEnv.ZCODE_TELEMETRY_DEVICE_MID;
    mcpTelemetryTracker =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpTelemetryTracker({
            idSalt: telemetryDeviceMid ?? traceContext.traceId,
            onEvent: (event) => mcpTelemetrySink?.(event),
            onResourceSamples: (samples) => mcpResourceSink?.(samples),
          });
    // 官方 MCP 身份头端口（spec §7.1/§7.2）：连接池构造早于 server，故用惰性 holder 回填。
    // server 就绪前该端口返回 official_auth_unavailable；HTTP tools/call 会匿名交给服务端
    // 返回结构化权限错误，stdio 则把 reason 下发给插件。连接与工具发现都不受影响。
    let officialMcpAuthContext: OfficialMcpAuthRequestContext | undefined;
    credentialCipherBridge = createProtocolCredentialCipher(() => officialMcpAuthContext);
    const mcpCredentialStore = createSharedZCodeCredentialStore({
      env: options.env,
      cipher: credentialCipherBridge.cipher,
    });
    const providerEndpointRoutingPort =
      options.providerEndpointRoutingPort ??
      resolveProcessProviderEndpointRoutingPort({
        credentialStore: mcpCredentialStore,
        appVersion: options.version,
        env: options.env,
        logger,
        network: configResult.config.network,
        sourceTitle: "electron",
      });
    // stdio 官方 MCP 没有 url 可供校验，targetOrigin 只能由宿主给出。
    // 与下面 trustedOrigins 的 resolveZCodeApiOrigin 必须是同一个表达式，否则两侧判定分叉。
    const resolveZCodeApiOrigin = (): string =>
      resolveRuntimeZCodeEndpointOrigin(options.env ?? process.env);
    const workspaceIdentity = (options.env ?? process.env)[ZCODE_WORKSPACE_IDENTITY_ENV]?.trim();
    const officialMcpAuth = {
      authHeadersPort: createOfficialMcpAuthHeadersPort({
        resolveContext: () => officialMcpAuthContext,
        // workspaceKey 必须遵守仓库约定 `workspaceIdentity?.trim() || workspacePath`，
        // 否则同路径不同 identity 的远端 workspace 在审计上下文里无法区分。
        // 注意：agent 进程当前没有 identity 来源，因此实际多为 undefined，key 退化为 path；
        // 详见 official-mcp-auth-port.ts 的"剩余缺口"说明。
        // 修复原因：本地会话曾按 MCP 工作目录重算 key，受管 worktree 会话得到 worktree 路径，
        // Host 按 key 路由时找不到所属项目，官方 MCP 授权头请求被拒（docs/git/worktree.md §9.3）。
        // 会话带有协议入口给出的 key 时直接使用。
        resolveWorkspace: ({ workspaceIdentity, workspacePath, workspaceKey }) => {
          const path = workspacePath ?? options.cwd;
          if (!path) return undefined;
          const identity = workspaceIdentity?.trim();
          return {
            ...(identity ? { workspaceIdentity: identity } : {}),
            workspaceKey: workspaceKey || identity || path,
            workspacePath: path,
          };
        },
      }),
      resolveZCodeApiOrigin,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      // 信任判定只看一条：目标 origin 等于当前 ZCode API origin（https）。pluginId 不参与。
      // origin 运行时解析（跟随 production/test 与自建环境），不硬编码域名。
      trustedOrigins: createOfficialMcpTrustedOriginRegistry({
        devTrustedOriginsRaw: (options.env ?? process.env)[OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV],
        resolveZCodeApiOrigin,
      }),
    };
    // 官方插件命令进程的代理端点（技术方案 5.8）：CLI 不持有凭证，端点每个请求向 host 现取
    // 身份头后转发给 zcode-server。和官方 MCP 用同一个 origin 表达式与网络配置。
    const endpointEnv = options.env ?? process.env;
    officialCommandEndpoint = createOfficialCommandEndpoint({
      resolveHeaders: createOfficialCommandAuthHeadersPort({
        resolveContext: () => officialMcpAuthContext,
        logger,
      }).resolveHeaders,
      resolveZCodeApiOrigin,
      appVersion: endpointEnv.ZCODE_APP_VERSION?.trim() || options.version,
      fetch: createMcpTransportFetch({ env: endpointEnv, network: configResult.config.network }),
      logger,
    });
    const activeOfficialCommandEndpoint = officialCommandEndpoint;
    // MCP elicitation 归属到协议 server 的会话；pool 先于 server 创建，端口延迟绑定。
    let elicitationServer: {
      requestMcpElicitation: McpElicitationPort["requestElicitation"];
      handleMcpNotification: McpNotificationPort["onNotification"];
    } | null = null;
    mcpConnectionPool =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpAdapterConnectionPool({
            mcpOAuth: { credentialStore: mcpCredentialStore },
            elicitation: {
              requestElicitation: (request, elicitationOptions) =>
                elicitationServer
                  ? elicitationServer.requestMcpElicitation(request, elicitationOptions)
                  : Promise.resolve({ action: "decline" as const }),
            },
            // server 通知同样延迟绑定到协议 server。
            notifications: {
              onNotification: (notification) =>
                elicitationServer?.handleMcpNotification(notification),
            },
            clientVersion: options.version ?? "0.0.0",
            env: options.env,
            logger,
            network: {
              httpProxy: configResult.config.network.httpProxy,
              noProxy: configResult.config.network.noProxy,
              caCertFile: configResult.config.network.caCertFile,
            },
            nodeFallback: resolveMcpNodeFallbackProvider({
              cliStorageRoot: getCliStorageRoot(resolvePath(configResult.config.storage.dir)),
              logger,
            }),
            officialMcpAuth,
            telemetry: mcpTelemetryTracker,
            workingDirectory: options.cwd,
          });
    mcpPort = mcpConnectionPool?.acquireLease({ leaseId: "protocol-settings" });
    const activeProviderRegistryRuntime = providerRegistryRuntime;
    const protocolCliStorageRoot = getCliStorageRoot(resolvePath(configResult.config.storage.dir));
    const modelSelectionFacade = createNodeModelSelectionFacade(
      activeProviderRegistryRuntime.runtime.registryService,
    );
    options.lifecycle?.signal.throwIfAborted();
    const server = (serverForCleanup = new ZCodeProtocolAgentServer({
      createZCodeApp: (appOptions = {}) =>
        createZCodeApp({
          ...applyProtocolProviderRegistry(
            applyProtocolPresentationSurface(appOptions, presentationSurface),
            activeProviderRegistryRuntime.runtime.registryService,
            activeProviderRegistryRuntime.configuredDefaultModelSelection,
          ),
          // 只读同进程已应用快照；不为子任务另发 Host RPC，也不在 ModelFactory 偷换模型。
          resolveEffectiveModelSelection: (selection) => {
            const view = modelSelectionFacade.getView(undefined, undefined, { selection });
            return {
              effectiveSelection: view.effectiveSelection ?? null,
              selectionIssue: view.selectionIssue,
            };
          },
          env: {
            ...telemetryEnv,
            ...appOptions.env,
            ...(telemetryDeviceMid ? { ZCODE_TELEMETRY_DEVICE_MID: telemetryDeviceMid } : {}),
          },
          ...(nodeReplBrowserBroker ? { nodeReplBrowserBroker } : {}),
          ...(mcpConnectionPool
            ? {
                mcpPortFactory: () =>
                  mcpConnectionPool!.acquireLease({
                    leaseId: appOptions.sessionId,
                    sessionId: appOptions.sessionId,
                  }),
              }
            : {}),
          providerEndpointRoutingPort,
          officialCommandEnv: (sessionId, workspace, observer) =>
            activeOfficialCommandEndpoint.envForSession(sessionId, workspace, observer),
          sourceTitle: "electron",
          onToolExecResource: (params) =>
            connection.send({ method: zcodeProtocolNotifications.toolExecResource, params }),
        }),
      pluginPreparation,
      pluginDiscovery,
      cwd: options.cwd,
      env: options.env,
      loggerFactory,
      mcpPort,
      mcpTelemetry: mcpTelemetryTracker,
      sessionStore,
      sessionDataFiles: createNodeSessionDataFiles({
        cliStorageRoot: protocolCliStorageRoot,
        // 与会话运行时的记忆解析同一函数，删除的正是 CLI 读写的那个目录。
        memoryRoot: ({ workspacePath, workspaceIdentity }) =>
          getProjectMemoryRoot(protocolCliStorageRoot, workspacePath, workspaceIdentity),
      }),
      syncAccountProviderConfig: activeProviderRegistryRuntime.syncAccountProviderConfig,
      refreshProviderRegistry: async (reason) => {
        await activeProviderRegistryRuntime.runtime.registryService.refresh(reason);
      },
      version: options.version,
    }));
    officialMcpAuthContext = server.officialMcpAuthRequestContext;
    elicitationServer = server;
    if (configResult.config.features.mcp !== false) {
      nodeReplBrowserBroker = createNodeReplBrowserBroker({
        browserControlPort: server.browserControlPort,
        logger,
        platform: process.platform,
      });
      const broker = nodeReplBrowserBroker;
      await acquireProtocolStartupResource({
        signal: options.lifecycle?.signal,
        logger,
        create: () => broker.ready,
      });
    }
    const connection = new ZCodeProtocolNdjsonConnection({
      signal: options.lifecycle?.signal,
      clearPostResponseMessages: () => server.clearPostResponseMessages(),
      handleMessage: (message) => server.handleMessage(message),
      input,
      logger,
      onTransportClosed: (error) => server.disconnectClient(error),
      output,
      takePostResponseBatch: (requestId) => server.takePostResponseBatch(requestId),
    });
    server.setNotificationSink((notification) => connection.send(notification));
    mcpResourceSink = (samples) =>
      connection.send({
        method: zcodeProtocolNotifications.mcpResourceSamples,
        params: samples,
      });
    mcpTelemetrySink = (event) => {
      // 五分钟资源通知取代旧内存通知；tracker 内部孤儿事实仍保留原判据。
      if (event.kind === "memory") return;
      connection.send({
        method: zcodeProtocolNotifications.mcpTelemetry,
        params: event,
      });
    };
    connection.start();
    mcpTelemetryTracker?.start();
    processResourceSampler = startProtocolResourceSampler(
      server,
      (message) => connection.send(message),
      logger,
    );
    startupTimer.complete("ZCode Protocol agent startup completed", {
      event: "zcode_protocol.startup.completed",
      stage: "total",
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    await connection.waitForClose();
  } catch (error) {
    options.lifecycle?.requestShutdown(
      error instanceof Error ? error : new Error("Protocol runtime failed", { cause: error }),
    );
    startupTimer.fail("ZCode Protocol agent startup failed", error, {
      event: "zcode_protocol.startup.failed",
      stage: "total",
    });
    throw error;
  } finally {
    credentialCipherBridge?.dispose();
    options.lifecycle?.requestShutdown();
    await officialCommandEndpoint?.close().catch((error: unknown) => {
      logger.warn("Official command endpoint close failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.official_command_endpoint.close_failed",
      });
    });
    await cleanupProtocolRuntime({
      logger,
      deadlineAt: options.lifecycle?.deadlineAt,
      server: serverForCleanup,
      pluginPreparation: {
        dispose: async () => {
          pluginDiscovery?.dispose();
          await pluginPreparation.dispose();
          await pluginPrewarm;
        },
      },
      processResourceSampler,
      mcpTelemetryTracker,
      nodeReplBrowserBroker,
      mcpPort,
      mcpConnectionPool,
      sessionStore,
      providerRegistryRuntime,
    });
    logger.info("ZCode Protocol agent shutdown completed", {
      ...traceContextToLogContext(traceContext),
      event: "zcode_protocol.shutdown.completed",
      module: "bootstrap.zcode_protocol",
      status: "completed",
    });
  }
}

function resolveProtocolRuntimeSurface(
  env: NodeJS.ProcessEnv,
): "desktop_local_host" | "remote_workspace_host" {
  // Bug 根因：入口曾无条件覆盖 Host 注入值，远程 SSH/WSL/容器 Trace 被归入本地 Desktop。
  return env.ZCODE_TELEMETRY_RUNTIME_SURFACE?.trim() === "remote_workspace_host"
    ? "remote_workspace_host"
    : "desktop_local_host";
}

/** 内置 CLI 的凭据加解密只委托已连接 Host，禁止失败后改为本机系统库读取。 */
function createProtocolCredentialCipher(
  resolveContext: () => OfficialMcpAuthRequestContext | undefined,
) {
  const bridge = createCredentialCipherBridge((request) => {
    const context = resolveContext();
    if (!context) throw new Error("Credential cipher host is unavailable");
    void context
      .requestClient(
        zcodeProtocolMethods.interactionRequestCredentialCipher,
        request,
        credentialCipherReplySchema,
        {},
      )
      .then(
        (reply) => bridge.receive(reply),
        () =>
          bridge.receive({
            requestId: request.requestId,
            result: {
              ok: false,
              error: {
                code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
                message: "Credential cipher host is unavailable",
              },
            },
          }),
      );
  });
  return bridge;
}
