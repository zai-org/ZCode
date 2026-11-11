import { createWorkspaceMcpTrust } from "../workspace-mcp-trust/index.js";
import { subagentProfilesFromSnapshot } from "../runtime-subagents/index.js";
import { CliDefaultSelection } from "./cli-default-selection.js";
import {
  createCliSessionControlRuntime,
  type CliSessionControlRuntime,
} from "../cli-session-control/index.js";
import type { SessionControlBinding } from "@zcode/core/session-control";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createInMemorySessionEventStore,
  createNodeToolArtifactStore,
} from "@zcode/adapters/storage";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import {
  createConfigWithPluginMigrations,
  resolvePath,
  resolveWorkspaceHookTrustIdentityForWorkspace,
} from "@zcode/adapters/config";
import {
  createNodeExecutionAdapter,
  resolveEffectiveBashShellSelection,
} from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createJimpImageProcessorAdapter } from "@zcode/adapters/image";
import { createPopplerPdfDocumentAdapter } from "@zcode/adapters/pdf";
import { createNodeSessionMailboxAdapter } from "@zcode/adapters/mailbox";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import { createMcpAdapter } from "@zcode/adapters/mcp";
import {
  AgentRuntime,
  normalizeAgentProfiles,
  PermissionService,
  buildPluginReferenceCatalog,
  writeWorkflowDraft,
  type AmendWorkflowRunSettingsInput,
  type ResumeSessionResult,
} from "@zcode/core";
import { createModelTelemetry } from "@zcode/telemetry";
import {
  createRootTraceContext,
  ModelRequestSessionFeature,
  traceContextToLogContext,
  type TraceContext,
  type SessionId,
  createSessionId,
  createSessionEvent,
  SessionEventType,
  type ExecutionShellSelection,
  type MessageId,
} from "@zcode/contracts";
import { isRemoteWorkspaceIdentity, resolveZCodeRuntimeEnv } from "@zcode/shared";
import {
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
} from "@zcode/shared/zcode-protocol-v4";

import { createModelAdapter } from "../model-factory.js";
import { StartupTimer, startupNow } from "../startup-logging.js";
import { scheduleStartupLogRetentionCleanup } from "../log-retention.js";
import type {
  PrepareUserExecutionBoundary,
  ResumeOptions,
  ZCodeApp,
  ZCodeAppOptions,
} from "./types.js";
import {
  createConfigCliOverrides,
  isMessageEnabled,
  resolveEffectiveLocale,
  resolveEffectiveConfigResult,
} from "./app-config-options.js";
import {
  getCliStorageRoot,
  getModelIoDir,
  getSubagentOutputRootDir,
  projectIdFromDirectory,
} from "./paths.js";
import {
  asInputHistoryStore,
  asLocalSettingStore,
  openStartupSessionStore,
  readProjectPermissionMode,
  readSessionModelSelection,
} from "./session-store.js";
import { createWorkflowFacade } from "./workflow-facade.js";
import { createInputFacade } from "./input-facade.js";
import { createPluginFacadeForApp } from "./plugin-facade.js";
import { resolvePluginRuntimeFeatures } from "./plugin-runtime-features.js";
import { OFFICIAL_VISUALIZE_PLUGIN_ID } from "./official-plugin-definitions.js";
import { createSessionFacade } from "./session-facade.js";
import { resolveAppRuntimeConfig, runtimeConfigLogContext } from "./runtime-config.js";
import { resolveBundledSkillRoots } from "./bundled-skills.js";
import { resolveMcpNodeFallbackProvider } from "./mcp-node-fallback.js";
import { collectDynamicWorkflowDisabledSkillPaths } from "./dynamic-workflow-gate.js";
import { createWorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";
import { createScriptWorkflowBridge } from "./script-workflow-methods.js";
import {
  createDynamicWorkflowRunService,
  isDynamicWorkflowTaskLinkStore,
  resolveDynamicWorkflowJournalStore,
} from "./dynamic-workflow-run-service.js";
import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";
import { createDynamicWorkflowSnippetService } from "./dynamic-workflow-snippet-service.js";
import { createModelCatalogPort } from "./model-catalog-port.js";
import { createDynamicWorkflowRunProgressSink } from "./dynamic-workflow-run-progress-sink.js";
import { createScriptWorkflowAgentRuntime } from "./script-workflow-child-runtime.js";
import { workflowActorModelPolicy } from "./workflow-actor-model.js";
import {
  workflowActorInteractionDescription,
  workflowActorPermissionPolicy,
} from "./workflow-actor-permission.js";
import { startWorkflowQuotaAutoResume } from "./dynamic-workflow-quota-resume.js";
import { workflowActorToolPolicy } from "./workflow-actor-tools.js";
import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./node-repl-browser-broker.js";
import { resolveBuiltInNodeReplMcpServers } from "./built-in-node-repl.js";
import { resolveZCodeCustomCommandPrompt } from "../custom-command-prompt.js";
import { resolveZCodeBuiltinPromptCommandInvocation } from "../builtin-prompt-command.js";
import { BUILTIN_WORKFLOW_COMMAND_NAME } from "../builtin-workflow-command.js";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import {
  loadPluginAgentTemplates,
  resolvePluginAgentProfiles,
  loadZCodeAgentProfiles,
} from "../subagents.js";
import { createRuntimeAiSdkModelExecutionConfig } from "../model-config.js";
import { withOfficialCommandEnv } from "../official-command-endpoint/index.js";
import { ApiProviderModelRuntime } from "./provider-registry-model-runtime.js";
import {
  completeAppStartup,
  debugRuntimeConfigResolved,
  markConfigurationLoaded,
  markMcpAdapterInitialized,
  markRuntimeConstructed,
  markStorageAdaptersInitialized,
  resolveStartupPlugins,
  startAppStartup,
} from "./startup-marks.js";

function decodePromptAttachmentDataUrl(
  content: string,
  fallbackMime: string,
  maxBytes: number,
): { bytes: Uint8Array; mediaType: string } {
  const commaIndex = content.indexOf(",");
  const headerParts =
    content.slice(0, "data:".length).toLowerCase() === "data:" && commaIndex >= 0
      ? content.slice("data:".length, commaIndex).split(";")
      : [];
  const mediaType = (headerParts.shift()?.trim() || fallbackMime).split(";", 1)[0]!.toLowerCase();
  const payload = commaIndex >= 0 ? content.slice(commaIndex + 1) : "";
  if (
    headerParts.at(-1)?.trim().toLowerCase() !== "base64" ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) ||
    payload.length % 4 !== 0
  ) {
    throw new Error("fault.attachment.previewArtifactInvalid");
  }
  if (
    !mediaType.startsWith("image/") &&
    !mediaType.startsWith("video/") &&
    mediaType !== "application/pdf" &&
    // 根因：文本材料复用上传 artifact，但原 data URL 解码器仅接受媒体，合法预览被二次拒绝。
    !(
      mediaType === "text/plain" &&
      fallbackMime.split(";", 1)[0]?.trim().toLowerCase() === "text/plain"
    )
  ) {
    throw new Error("fault.attachment.previewNotMedia");
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.byteLength > maxBytes) {
    throw new Error("fault.attachment.previewTooLarge");
  }
  return { bytes, mediaType };
}

export async function createZCodeApp(options: ZCodeAppOptions): Promise<ZCodeApp> {
  if (!options?.providerRegistry) {
    throw new Error("createZCodeApp requires a Provider Registry");
  }
  const startupStartedAt = startupNow();
  const appVersion = options.version ?? "0.0.0";
  const sessionId = options.sessionId ?? createSessionId();
  const traceContext = options.traceContext ?? createRootTraceContext({ sessionId });
  const workingDirectory = resolve(options.runtimeConfig?.workingDirectory ?? process.cwd());
  // Hook Trust identity（D23）：受管 worktree 归一为源仓库路径，snapshot 与 Trust record 共用该键。
  // createConfig 是同步函数，resolver 要异步读取 .git 链接，所以在这里先算好再传入。
  const workspaceHookTrustIdentity = await resolveWorkspaceHookTrustIdentityForWorkspace({
    workspacePath: workingDirectory,
    ...(options.runtimeConfig?.memory?.workspaceIdentity?.trim()
      ? { workspaceIdentity: options.runtimeConfig.memory.workspaceIdentity.trim() }
      : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  const configResult = resolveEffectiveConfigResult(
    await createConfigWithPluginMigrations({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      workspaceHookTrustIdentity,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
      cliOverrides: createConfigCliOverrides(options),
    }),
    options,
  );
  const loggerFactory = options.loggerFactory ?? createNodeLoggerFactory({ env: options.env });
  const logger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap",
  });
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap",
      startupKind: "zcode_app",
    },
    startupStartedAt,
  );
  startAppStartup({
    hasInjectedModelAdapter: options.modelAdapter !== undefined,
    resume: options.resume === true,
    startupTimer,
  });
  markConfigurationLoaded({
    configResult,
    startupTimer,
  });
  const modelLogger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "adapters.model",
  });
  const modelTelemetry = createModelTelemetry({
    owner: options.telemetryOwner,
    sessionId,
  });
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let ownedNodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let providerModelRuntime: ApiProviderModelRuntime | undefined;
  let standaloneSessionControl: CliSessionControlRuntime | undefined;
  try {
    const storageRoot = resolvePath(configResult.config.storage.dir);
    const cliStorageRoot = getCliStorageRoot(storageRoot);
    const modelIoDir = getModelIoDir(
      cliStorageRoot,
      resolveZCodeRuntimeEnv(options.env ?? process.env) === "development",
    );
    // 初始化与父轮必须使用同一 Host 来源，避免 CLI storage.dir 的另一份定义在首轮消失。
    const hostSubagentSnapshot = await options.readSubagentRuntimeConfig?.({
      signal: new AbortController().signal,
      traceContext,
    });
    const zcodeSubagentProfileOutcome = hostSubagentSnapshot
      ? subagentProfilesFromSnapshot(hostSubagentSnapshot)
      : await loadZCodeAgentProfiles({
          logger,
          storageRoot,
          workingDirectory,
          additionalDirectories: options.additionalDirectories,
        });
    const zcodeSubagentProfiles = zcodeSubagentProfileOutcome.profiles;
    const pluginOutcome = await resolveStartupPlugins({
      cliStorageRoot,
      configResult,
      env: options.env,
      logger,
      options,
      startupTimer,
      workingDirectory,
    });
    // 随 CLI 内置的技能包（dynamic-workflows 等）：不属于任何插件，用户无法停用或卸载。
    const bundledSkillRoots = resolveBundledSkillRoots({ cliStorageRoot, logger });
    const pluginTemplates = loadPluginAgentTemplates({ logger, plugins: pluginOutcome.plugins });
    const pluginSubagentProfiles =
      hostSubagentSnapshot?.kind === "built-in-fallback"
        ? []
        : resolvePluginAgentProfiles(
            {
              logger,
              plugins: pluginOutcome.plugins,
              reservedProfileNames: zcodeSubagentProfiles.map((profile) => profile.name),
              modelSelectionOverrides:
                zcodeSubagentProfileOutcome.pluginAgentModelSelectionOverrides,
            },
            pluginTemplates,
          ).profiles;
    const pluginRuntimeFeatures = resolvePluginRuntimeFeatures(pluginOutcome);
    const builtInMcpServers = resolveBuiltInNodeReplMcpServers({
      pluginOutcome,
      workingDirectory,
    });
    // 用户目录已在 loader 前完成原地迁移；不能给项目/插件旧身份加内存兼容旁路。
    const subagentProfiles = [...zcodeSubagentProfiles, ...pluginSubagentProfiles];
    const ownsSessionStore = options.sessionStore === undefined;
    const sessionStore =
      options.sessionStore ?? (await openStartupSessionStore(configResult, startupTimer));
    // 独立 CLI/TUI 同样登记持有关系，其他 App 进程不能把未加载误判为全局空闲。
    if (ownsSessionStore) await sessionStore.registerSessionRuntime?.(sessionId);
    let sessionControl = options.sessionControl;
    let standaloneRootProvenance: "new-independent-root" | "unverified-history" =
      "unverified-history";
    if (options.standaloneSessionControl) {
      if (
        sessionControl ||
        options.runtimeConfig?.parentSessionId ||
        options.runtimeConfig?.workspaceIdentity
      ) {
        throw new Error("Standalone session control requires an independent local CLI root");
      }
      // borrowed 只说明 app.close 的责任；新建根已有唯一启动 owner，应保留 rename/send 能力。
      // resume 或复用历史 ID 不证明独立来源，不能因当前进程拿到 runtime 就把历史升级为可写目标。
      if (options.resume !== true && !(await sessionStore.getSession(sessionId))) {
        standaloneRootProvenance = "new-independent-root";
      }
      const workspace = { kind: "cli" as const, workspacePath: workingDirectory };
      const bindRoot = (rootId: SessionId): SessionControlBinding => ({
        kind: "cli",
        control: standaloneSessionControl!.control,
        context: () => ({
          callerId: rootId,
          rootSession: { ...workspace, sessionId: rootId },
          allowedScopes: [workspace],
          // 独立 CLI 的读取不要求 owner：list/read 可访问本机 CLI 会话库，写操作仍只看 allowedScopes。
          readAnyLocalSession: true,
        }),
      });
      standaloneSessionControl = createCliSessionControlRuntime({
        workspace,
        sessionStore,
        createRootApp: async (request) => {
          // 新根只借用基础设施和独立 CLI 配置，不展开 actor 的 runtimeConfig、yolo 或审批结果。
          const target = await createZCodeApp({
            sessionId: request.sessionId,
            resume: request.resume,
            traceContext: request.traceContext,
            sessionStore,
            sessionControl: bindRoot(request.sessionId),
            // Bug 根因：后台根原先不传交互端口，Core 退回拒绝 broker，需要审批的工具被直接拒绝、
            // 用户看不到询问。改为共用启动方的同一个询问通道（TUI 审批队列 / headless 拒绝）；
            // 只共用通道，不共用批准结果，权限模式仍固定 build。
            permissionBroker: options.permissionBroker,
            providerRegistry: options.providerRegistry,
            configuredDefaultModelSelection: options.configuredDefaultModelSelection,
            providerEndpointRoutingPort: options.providerEndpointRoutingPort,
            providerRuntimeHeadersPort: options.providerRuntimeHeadersPort,
            modelAdapter: options.modelAdapter,
            env: options.env,
            skipUserConfig: options.skipUserConfig,
            userConfigPath: options.userConfigPath,
            version: options.version,
            runtimeConfig: {
              workingDirectory: request.cwd,
              taskType: request.resume ? "fork" : "interactive",
              mode: "build",
            },
          });
          if (request.model) {
            try {
              await target.setModel(request.model);
            } catch (error) {
              await target.close?.();
              throw error;
            }
          }
          return target;
        },
      });
      sessionControl = bindRoot(sessionId);
    }
    const localSettingStore = asLocalSettingStore(sessionStore);
    // 受管 worktree 会话的项目身份（权限 project_id、项目记忆）映射回源仓库路径，与 Hook Trust
    // 继承同一 resolver（docs/git/worktree.md §6.6.3）。远程 workspace 的 Trust identity 是
    // 不透明身份而不是目录，保持按工作目录派生；映射失败时 resolver 已退回工作目录。
    const projectDirectory =
      !options.runtimeConfig?.memory?.workspaceIdentity?.trim() &&
      workspaceHookTrustIdentity !== workingDirectory
        ? workspaceHookTrustIdentity
        : undefined;
    const projectID = projectIdFromDirectory(projectDirectory ?? workingDirectory);
    const persistedMode = options.runtimeConfig?.mode
      ? undefined
      : readProjectPermissionMode(localSettingStore, projectID);
    let { configuredMcpServers, runtimeConfig, untrustedProjectMcpServers } =
      resolveAppRuntimeConfig({
        cliStorageRoot,
        configResult,
        options,
        persistedMode,
        pluginHooks: pluginOutcome.hooks,
        pluginMcpServers: pluginOutcome.mcpServers,
        builtInMcpServers,
        pluginRuntimeFeatures,
        builtInSubagentModelSelectionOverrides:
          zcodeSubagentProfileOutcome.builtInModelSelectionOverrides,
        subagentOutputRootDir: getSubagentOutputRootDir(cliStorageRoot),
        subagentProfiles,
        storageRoot,
        workingDirectory,
        workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      });
    // 过去仅凭宿主目录注入 Gen UI 上下文，插件关闭后仍污染模型请求；复用已解析的插件启用态。
    if (
      !pluginOutcome.plugins.some(
        (plugin) => plugin.id === OFFICIAL_VISUALIZE_PLUGIN_ID && plugin.enabled,
      )
    ) {
      runtimeConfig.genUiOutputRoot = undefined;
    }
    if (projectDirectory) runtimeConfig.projectDirectory = projectDirectory;
    // 协议入口给出会话所属 workspace 的 key（受管 worktree 会话 = 项目）；MCP 工具调用与官方 MCP
    // 授权头以它为身份，不按工作目录重算（docs/git/worktree.md §9.3）。
    if (options.workspaceKey) runtimeConfig.workspaceKey = options.workspaceKey;
    const browserControlPort = options.browserControlPort;
    if (
      browserControlPort &&
      pluginRuntimeFeatures.browserUse === true &&
      runtimeConfig.mcp?.servers?.node_repl?.type === "stdio"
    ) {
      nodeReplBrowserBroker =
        options.nodeReplBrowserBroker ??
        (ownedNodeReplBrowserBroker = createNodeReplBrowserBroker({
          browserControlPort,
          logger,
          platform: options.platform,
        }));
      configuredMcpServers = injectNodeReplBrowserBroker(
        configuredMcpServers,
        nodeReplBrowserBroker,
      );
      runtimeConfig.mcp = {
        ...runtimeConfig.mcp,
        servers: injectNodeReplBrowserBroker(
          runtimeConfig.mcp.servers ?? {},
          nodeReplBrowserBroker,
        ),
      };
    }
    startupTimer.mark("ZCode runtime configuration resolved", {
      context: runtimeConfigLogContext(runtimeConfig, workingDirectory),
      event: "bootstrap.app.startup.runtime_config.completed",
      stage: "resolve_runtime_config",
    });
    // Plugin 对话引用：身份 catalog 在 App（Session runtime）
    // 创建时冻结一次。冷恢复会重建 App，天然拿到新 catalog；已有 Session 不热加载新 Plugin。
    const pluginReferenceCatalog = buildPluginReferenceCatalog(pluginOutcome.plugins);
    runtimeConfig.pluginReferenceCatalog = pluginReferenceCatalog;
    let runtime: AgentRuntime | undefined;
    const cliDefaultSelection =
      options.modelSelectionMode === "cli-default"
        ? new CliDefaultSelection(runtimeConfig.modelSelection)
        : undefined;
    const workspaceHookRuntimeSecurity = createWorkspaceHookRuntimeSecurity({
      appVersion,
      logger,
      projectConfigPath: options.projectConfigPath,
      policy: options.workspaceHookPolicy,
      policyProvider: options.workspaceHookPolicyProvider,
      reviewHost: options.workspaceHookReviewHost,
      ...(options.env ? { env: options.env } : {}),
      // 对外 workspaceKey：协议入口传入会话所属 workspace 的 key（受管 worktree 会话 = 项目）；
      // 独立 CLI 缺省同旧规则：远程 identity 优先，否则工作目录。
      workspaceKey:
        options.workspaceKey ??
        (options.runtimeConfig?.memory?.workspaceIdentity?.trim() || workingDirectory),
      workspaceHookTrustEnabled: options.workspaceHookTrustEnabled,
      runtimeRoot: configResult.sources.project.workspaceHookRuntimeRoot ?? {
        // Fallback 只在 config-factory 未导出时生效（理论上不会发生）。
        // 此处原本无条件按单层 runtimeConfig.hooks 重建 runtimeRoot，与
        // config-factory 遍历 default/user/project/env/cli 全部层的推导不一致，
        // 导致 review 快照与 toggle 重建的 bundleDigest 不同，
        // 「审核中 toggle」被误报为 workspace_hooks_snapshot_mismatch。
        enabled: runtimeConfig.hooks?.enabled === true,
        timeoutMs: runtimeConfig.hooks?.timeoutMs ?? 60_000,
        maxOutputBytes: runtimeConfig.hooks?.maxOutputBytes ?? 32_768,
      },
      sessionId,
      snapshot: configResult.sources.project.workspaceHookSnapshot,
      userConfigPath: configResult.sources.user.path,
      workingDirectory,
      ...(options.workspaceHookReviewHost
        ? {
            emitReviewEvent: async (event) => {
              if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
              await runtime.appendEvent(
                createSessionEvent(event.type, sessionId, event.payload, {
                  traceId: traceContext.traceId,
                }),
                traceContext,
              );
            },
            emitAdmissionEvent: async (event) => {
              if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
              await runtime.appendEvent(
                createSessionEvent(event.type, sessionId, event.payload, {
                  traceId: traceContext.traceId,
                }),
                traceContext,
              );
            },
          }
        : {}),
    });
    const permissionService = new PermissionService({
      allowedTools: new Set(configResult.config.permission.allowedTools),
      autoApproveHighRisk: configResult.config.permission.autoApproveHighRisk,
      disallowedTools: new Set(configResult.config.permission.disallowedTools),
      allowMediumRiskInAutoMode: configResult.config.permission.allowMediumRiskInAuto,
    });
    const inputHistoryStore = options.inputHistoryStore ?? asInputHistoryStore(sessionStore);
    const artifactStore =
      options.artifactStore ??
      createNodeToolArtifactStore({
        imageCacheRootDir: join(storageRoot, "cli", "image-cache"),
        pdfCacheRootDir: join(storageRoot, "cli", "pdf-cache"),
        rootDir: join(storageRoot, "cli", "artifacts"),
        videoCacheRootDir: join(storageRoot, "cli", "video-cache"),
      });
    const imageProcessorPort = options.imageProcessorPort ?? createJimpImageProcessorAdapter();
    const messageEnabled = isMessageEnabled(options.env ?? process.env);
    const sessionMailboxPort =
      options.sessionMailboxPort ??
      (messageEnabled
        ? createNodeSessionMailboxAdapter({
            rootDir: resolvePath(
              (options.env ?? process.env).ZCODE_MAILBOX_ROOT ?? "~/.zcode/mailbox",
            ),
          })
        : undefined);
    markStorageAdaptersInitialized({
      cliStorageRoot,
      hasInjectedArtifactStore: options.artifactStore !== undefined,
      hasInjectedSessionStore: options.sessionStore !== undefined,
      startupTimer,
      storageRoot,
    });
    const rawMcpPort =
      options.mcpPort ??
      (runtimeConfig.mcp?.enabled === false
        ? undefined
        : (options.mcpPortFactory?.({ workingDirectory }) ??
          createMcpAdapter({
            clientVersion: appVersion,
            env: options.env,
            logger,
            network: {
              httpProxy: configResult.config.network.httpProxy,
              noProxy: configResult.config.network.noProxy,
              caCertFile: configResult.config.network.caCertFile,
            },
            nodeFallback: resolveMcpNodeFallbackProvider({ cliStorageRoot, logger }),
            workingDirectory,
          })));
    const mcpPort = rawMcpPort
      ? createWorkspaceMcpTrust({
          workingDirectory,
          workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
          userConfigPath: options.userConfigPath,
          projectConfigPath: options.projectConfigPath,
          skipUserConfig: options.skipUserConfig,
          env: options.env,
          onAdmissionChanged: async (payload) => {
            if (!runtime) return;
            await runtime.appendEvent(
              createSessionEvent(
                SessionEventType.WorkspaceMcpAdmissionUpdated,
                sessionId,
                payload,
                { traceId: traceContext.traceId },
              ),
              traceContext,
            );
          },
        }).guard(rawMcpPort)
      : undefined;
    const ownsMcpPort = options.mcpPort === undefined && mcpPort !== undefined;
    const baseExecutionPort =
      options.executionPort ??
      createNodeExecutionAdapter({
        onToolExecResource: options.onToolExecResource,
        network: {
          httpProxy: configResult.config.network.httpProxy,
          noProxy: configResult.config.network.noProxy,
          caCertFile: configResult.config.network.caCertFile,
        },
        outputRootDir: join(storageRoot, "cli", "exec"),
        bashOutputTempDir: tmpdir(),
        processEnv: options.env ?? process.env,
      });
    // 本 app 只服务一个 session：它的子进程统一带上这个 session 的官方命令端点 env。
    const officialCommandEnv = options.officialCommandEnv;
    const officialCommandIdentity = options.runtimeConfig?.memory?.workspaceIdentity;
    const officialCommandWorkspace = {
      workspacePath: workingDirectory,
      ...(officialCommandIdentity ? { workspaceIdentity: officialCommandIdentity } : {}),
    };
    const executionPort = officialCommandEnv
      ? withOfficialCommandEnv(
          baseExecutionPort,
          () =>
            officialCommandEnv(sessionId, officialCommandWorkspace, {
              onSiteDeploymentRequested: () => {
                runtime?.recordSessionFeature({ feature: ModelRequestSessionFeature.SiteDeploy });
              },
            }),
          logger,
        )
      : baseExecutionPort;
    const ownsExecutionPort = options.executionPort === undefined;
    const pdfDocumentPort =
      options.pdfDocumentPort ?? createPopplerPdfDocumentAdapter({ executionPort });
    // browser-use 控制端口：仅当宿主（desktop）注入时可用，无本地 fallback（纯 CLI 无浏览器底座）。
    const fileSystemPort = options.fileSystemPort ?? createNodeFileSystemAdapter();
    const httpClientPort =
      options.httpClientPort ??
      createNodeWebFetchHttpClientAdapter({
        env: options.env ?? process.env,
        timeoutMs: configResult.config.network.timeout,
        proxyUrl: configResult.config.network.httpProxy,
        noProxy: configResult.config.network.noProxy,
        caCertFile: configResult.config.network.caCertFile,
      });
    const providerEndpointRoutingPort = options.providerEndpointRoutingPort;
    markMcpAdapterInitialized({
      configuredMcpServers,
      hasInjectedMcpPort: options.mcpPort !== undefined,
      mcpEnabled: runtimeConfig.mcp?.enabled !== false,
      startupTimer,
      trustedMcpServerCount: Object.keys(runtimeConfig.mcp?.servers ?? {}).length,
    });
    debugRuntimeConfigResolved({
      configResult,
      logger,
      runtimeConfig,
    });
    const getRuntime = (): AgentRuntime => {
      if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
      return runtime;
    };
    let resumePrepared = false;
    const resolveDefaultShellSelection = (): ExecutionShellSelection =>
      resolveEffectiveBashShellSelection({
        env: options.env ?? process.env,
        platform: options.platform ?? process.platform,
      }).selection;
    let initialShellSelectionPromise: Promise<ExecutionShellSelection> | undefined;
    const resolveInitialShellSelection = (): Promise<ExecutionShellSelection> => {
      initialShellSelectionPromise ??= (async () =>
        (await options.resolveInitialBashShellSelection?.()) ?? resolveDefaultShellSelection())();
      return initialShellSelectionPromise;
    };
    const initializeSessionShellEnvironment = async (): Promise<void> => {
      getRuntime().initializeSessionShellEnvironmentIfNeeded(await resolveInitialShellSelection());
    };

    const restorePersistedModelSelection = async (): Promise<
      ResumeSessionResult["modelSelection"]
    > => {
      const registry = options.providerRegistry;
      let selection: ResumeSessionResult["modelSelection"];
      try {
        // 数据库启动已完成版本化迁移；恢复只读新字段，不按会话重复补迁。
        selection = await readSessionModelSelection(sessionStore, sessionId);
      } catch (error) {
        // 选择 entry 的读取/解析故障不能拖垮独立的历史恢复；留下真实存储错误，
        // 不读取旧消息或默认模型来掩盖失败。
        logger.warn("Session model selection restore failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "session.model_selection.restore_failed",
          sessionId,
        });
      }
      const validation = selection && registry.validateSelection(selection);
      if (selection && validation && !validation.ok) {
        // 观测：校验失败只影响运行绑定、不影响保存意图；但一旦不绑定，之后若只发送 execution 作用域的
        // 加速轮就没有机会重新绑定。曾在 Registry 刚就绪、账号权益未解析的 600ms 窗口内静默置空，
        // 直到加速卡过期降级找不到退回目标才暴露，日志里却看不到这一步。
        logger.warn("Session model selection restored but not bound to the runtime", {
          event: "session.model_selection.restore_unbound",
          modelId: selection.modelId,
          providerId: selection.providerId,
          sessionId,
          validationCode: validation.code,
        });
      }
      // 只查模型是否存在会把缺档位/已删除的选择重新绑定进 Runtime，
      // 抵消了未绑定初始化。历史恢复不要求可执行模型，只有完整选择可以绑定。
      getRuntime().setSessionModelSelection(validation?.ok ? selection : undefined);
      cliDefaultSelection?.set(validation?.ok ? selection : undefined);
      // 恢复结果是保存意图，不是执行绑定。过去在这里置空/删档位，Host 的
      // Selection View 就再也拿不到原意图，账号切换和配置恢复后也无法重新解析。
      return selection;
    };

    const resumeFromStore = async (resumeOptions?: ResumeOptions): Promise<ResumeSessionResult> => {
      const runtime = getRuntime();
      const unsubscribe = resumeOptions?.onEvent
        ? runtime.subscribeEvents({ onSessionEvent: resumeOptions.onEvent })
        : undefined;

      try {
        const resumeTraceContext = resumeOptions?.traceContext ?? traceContext;
        const modelSelection = await restorePersistedModelSelection();
        await initializeSessionShellEnvironment();
        const result = await runtime.resumeFromStore({
          ...(resumeOptions?.abortSignal ? { abortSignal: resumeOptions.abortSignal } : {}),
          // 只传调用方原始 mode；项目/全局默认值不能伪装成 invocation override，
          // 否则交互式 resume 将无法恢复真正持久化的 session mode。
          modeOverride: options.runtimeConfig?.mode,
          persistedMessages: resumeOptions?.persistedMessages,
          traceContext: resumeTraceContext,
        });
        await runtime.activatePausedTargetAfterResume(resumeTraceContext);
        // SessionResumed 已清理旧投影；即使声明未变也要重新发布当前准入。
        try {
          await mcpPort?.refreshWorkspaceTrustAdmission?.(true);
        } catch (error) {
          logger.warn("MCP trust admission publication failed after resume", {
            event: "mcp.trust.admission.failed",
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        resumePrepared = true;
        return { ...result, modelSelection };
      } finally {
        unsubscribe?.();
      }
    };

    const prepareResume = async (
      submitTraceContext?: TraceContext,
      abortSignal?: AbortSignal,
    ): Promise<void> => {
      if (!options.resume || resumePrepared) return;
      await resumeFromStore({
        ...(abortSignal ? { abortSignal } : {}),
        traceContext: submitTraceContext ?? traceContext,
      });
      resumePrepared = true;
    };

    const prepareUserExecutionBoundary: PrepareUserExecutionBoundary = async (boundaryOptions) => {
      // Bash shell 属于“首次真实用户执行”边界，而不是 chat
      // input 独有状态。普通 prompt、expert workflow、script workflow 都可能
      // 作为新 session 的第一个模型/子 agent 入口，必须统一在 resume/context
      // 初始化前落定一次，避免模型看到的 Shell 与 Bash 执行 shell 分叉。
      await initializeSessionShellEnvironment();
      await prepareResume(boundaryOptions?.traceContext, boundaryOptions?.abortSignal);
    };

    const modelExecutionConfig = createRuntimeAiSdkModelExecutionConfig(options.env, {
      appVersion,
      endpointRoutingPort: providerEndpointRoutingPort,
      network: configResult.config.network,
      sourceTitle: options.sourceTitle,
    });
    const modelAdapter =
      options.modelAdapter ??
      createModelAdapter({
        env: options.env,
        logger: modelLogger,
        modelIoDir,
        modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled,
        executionConfig: modelExecutionConfig,
        statusSink: modelTelemetry.statusSink,
        streamIdleTimeoutMs: configResult.config.modelStream.idleTimeoutMs,
      });
    if (options.modelAdapter && modelTelemetry.statusSink) {
      modelAdapter.addStatusSink(modelTelemetry.statusSink);
    }
    // 进程级并发治理器：run service 拿它的窄端口给
    // driver（每个 actor runtime 一个请求级准入端口）；主 runtime 挂它的 observer（下面 deps）——
    // 不排队、不看冷却，但计入在飞并喂信号。进程级单例——配额本就在账号上，不按会话分。
    // 不再经 adapter 级 addStatusSink 喂信号：同一事件只能沿 ticket 喂一次。
    const workflowConcurrencyGovernor = getWorkflowConcurrencyGovernor();
    modelAdapter.setModelIoFullRetentionEnabled(options.modelIoFullRetentionEnabled ?? false);
    providerModelRuntime = new ApiProviderModelRuntime({
      registry: options.providerRegistry,
      modelAdapter,
    });
    providerModelRuntime.start();
    // model factory 提前到三条 workflow child 装配线之前构造：script workflow bridge、dwf actor
    // runtime 与 expert workflow facade 都**共享**父会话这一份 factory——Registry 视图更新后
    // 新建的 Model 才看得到，child 不各自冻结一份。
    const modelFactory = providerModelRuntime.modelFactory;
    const scriptWorkflowFacade = createScriptWorkflowBridge({
      agentTelemetry: modelTelemetry.agentExecution,
      appOptions: options,
      appVersion,
      artifactStore,
      configResult,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      pluginSkillRoots: pluginOutcome.skillRoots,
      prepareUserExecutionBoundary,
      getRuntime,
      runtimeConfig,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
    });

    // workflow run service：CreateWorkflow 的确认窗 Allow 之后真启动引擎的那一侧。
    // journal 窄化失败（store 不带 dwf_* 表）时**不构造**服务——端口保持 undefined，
    // CreateWorkflow 因此回到占位诊断路径。这是一个记了日志的可见降级，而不是一条
    // 会静默丢掉持久化的运行路径（详见 dynamic-workflow-run-service.ts 的文件头）。
    const dynamicWorkflowJournal = resolveDynamicWorkflowJournalStore(sessionStore, logger);
    const dynamicWorkflowRunPort =
      dynamicWorkflowJournal === undefined
        ? undefined
        : createDynamicWorkflowRunService({
            concurrency: workflowConcurrencyGovernor,
            createActorRuntime: ({
              actor,
              persona,
              pinnedModel,
              runSubagentModel,
              actorModel,
              subagentPermissionMode,
              sessionId: actorSessionId,
              submitPort,
              submitProfile,
              escalatePort,
              webSearchBudgetPort,
              modelRequestAdmission,
            }) =>
              createScriptWorkflowAgentRuntime({
                childSessionId: actorSessionId,
                configOverrides: {
                  // persona 的身份（有效名 + system）→ context builder 的工作流子代理路径。
                  // 匿名 / 无 system 时字段缺席，builder 据此省略 named 从句与 persona 段。
                  workflowActor: {
                    ...(persona.name === undefined ? {} : { name: persona.name }),
                    ...(persona.system === undefined ? {} : { persona: persona.system }),
                  },
                  // actor 的工具面是减法（全集减去 plan 与越权的元工具），只能经 configOverrides
                  // 表达（request.opts.tools 只有 allowlist）。
                  ...workflowActorToolPolicy(),
                  // 权限面：子代理跑发起会话的权限模式（plan 除外），未记录即 YOLO
                  // （docs/dynamic-workflow/launch.md「Permissions inside a run」）。
                  ...workflowActorPermissionPolicy(subagentPermissionMode),
                  // 模型面：`runSubagentModel` 是本 run 自己的选择（`subagent_model`），在场时整条
                  // 覆盖，排在 pin 之上——主代理不受它影响。没有它也没有 pin 就不覆盖——child runtime
                  // 的基线本就是父会话当前模型（工厂的基线，见 script-workflow-child-runtime.ts）。
                  // resume 带来的 pin 钉住上一次实际跑的模型（persona 冻结不变式的持久化那一半，见
                  // workflow-actor-model.ts 的优先级表）；parentSelection 取父会话**当前**的选择，
                  // 与工厂基线同源，pin 比对才不会漂移。
                  ...workflowActorModelPolicy(
                    {
                      parentSelection: getRuntime().getSessionModelSelection(),
                      ...(runSubagentModel === undefined ? {} : { runSelection: runSubagentModel }),
                      // persona 点名的模型（脚本里的 `agent(…, { model })`）排在 run 选择之上。
                      ...(actorModel === undefined ? {} : { actorSelection: actorModel }),
                    },
                    pinnedModel,
                  ).configOverrides,
                },
                deps: {
                  agentTelemetry: modelTelemetry.agentExecution,
                  appOptions: options,
                  appVersion,
                  artifactStore,
                  configResult,
                  fileSystemPort,
                  httpClientPort,
                  imageProcessorPort,
                  logger,
                  mcpPort,
                  // 父会话的 model factory：actor 与主 turn 从同一份 Registry 视图造 Model，
                  // 不各自冻结一份。
                  modelFactory,
                  permissionService,
                  pluginSkillRoots: pluginOutcome.skillRoots,
                  runtime: getRuntime(),
                  runtimeConfig,
                  sessionId,
                  sessionStore,
                  storageRoot,
                  workingDirectory,
                },
                // persona 不再经 request.opts.systemPrompt 整段替换子代理的系统提示，而是经
                // workflowActor 叠加到基座之上。
                // request 在这里只是工厂签名的占位：opts 为空即「不覆盖任何东西」。
                request: { opts: {} } as never,
                // 权限窗的来源徽标点名这个子代理：`<persona 名> (<siteId>@<ordinal>)`。
                interactionDescription: workflowActorInteractionDescription({ actor, persona }),
                // 子代理的 Browser Use：父会话的端口，由工厂经 forChildSession 派生子端口（tab 归属是
                // actor 自己的 sessionId）。actor runtime 在 run dispose 时 closeBrowserSession，
                // 那一步连 tab 一起关并撤销登记（dynamic-workflow/docs/execution-engine.md「Subagent sessions」）。
                ...(browserControlPort === undefined ? {} : { browserControlPort }),
                traceContext,
                // submit profile → submit_result 形态：
                // `untyped` 不注入端口（core 的注册门是端口在场，于是没有这个工具——全 untyped 的子代理
                // 本来就无处可提交）；`mono` 注入端口 + typed 声明；`generic` 只注入端口（通用声明）。
                ...(submitProfile.kind === "untyped" ? {} : { workflowSubmitPort: submitPort }),
                // 展开：dwf 的 JsonSchema 是无索引签名的 interface，contracts 的是 Record；
                // 字面量展开拿到隐式索引签名，不必在两包之间造一个转换函数。
                ...(submitProfile.kind === "mono"
                  ? { workflowSubmitSchema: { ...submitProfile.schema } }
                  : {}),
                // 升级端口与 submit 端口同进同出：两者都是 actor 会话的控制通道，而端口在场
                // 就是 core 侧的注册门。恒传（端口在 run service 里恒被构造），不做 opt-in——
                // 最可能撞上未预见之墙的 actor 恰是作者没标记的那一个。
                workflowEscalatePort: escalatePort,
                // 每个 ask 的 WebSearch 预算（execution-engine.md「Search budget」）：同为 actor 会话的控制面，恒传。
                webSearchBudget: webSearchBudgetPort,
                // 请求级准入端口：driver 在治理器在场时给出，runner 每次尝试先过闸门。
                ...(modelRequestAdmission === undefined ? {} : { modelRequestAdmission }),
              }),
            // 边界记账与转录截断都读写 actor 会话的消息，走的必须是同一个 store。
            actorTranscriptStore: sessionStore,
            // 用户面产物的字节落点：与主会话、workflow 子
            // 代理共用同一个 tool-artifact store，产物因此和别的大结果落在同一棵目录树下。
            artifactStore,
            executionPort,
            fileSystemPort,
            journal: dynamicWorkflowJournal,
            logger,
            // 进度投影的接缝：一条引擎事件 → 一条父会话的会话事件 → v4 的 workflowRuns 状态键。
            // 走 runtime 的 append 链路（而不是直接推 eventSink）是必需的：只有它同时做持久化、
            // 补 sequenceNumber 与扇出，冷恢复与 replayable 重连因此免费。
            //
            // 身份闸门、runtime 未就绪与 append 失败三条降级路径都在这个汇里（连同它们的单测），
            // 见 dynamic-workflow-run-progress-sink.ts 的文件头。
            onRunEvent: createDynamicWorkflowRunProgressSink({
              // 惰性：run service 在 runtime 构造之前就建好了（它是 AgentRuntime 的依赖之一）。
              getRuntime,
              logger,
              sessionId,
            }),
            // 孤儿收敛的作用域：本 app 的会话。构造时把**这个会话**留在 journal 里的非终态
            // run（死进程的遗物）收敛成 failed；兄弟会话的在飞 run 因此绝不会被误伤。
            parentSessionId: sessionId,
            // 补全落在没有草稿的 run 上时铸草稿（docs/dynamic-workflow/launch.md「The draft after a
            // fill」）：内联规则只在工具层有一份实现，这里注入而不是让 run service 复制它。
            writeWorkflowDraft,
            // 建 run 那一刻会话的权限模式（记进 run-launched，子代理随之）。
            // 惰性同 onRunEvent：启动只来自工具调用或 v4 命令，那时 runtime 必已就绪。
            permissionMode: () => getRuntime().getMode(),
            // 在飞的引擎把本会话钉成常驻。2026-09-15 的 bug：引擎不进 runtime task registry，
            // 常驻池把带着在飞 run 的 App 按 idle（10 分钟）关掉，resume 又起了第二个引擎。
            // 惰性取 runtime 同 onRunEvent：run service 是 AgentRuntime 的依赖，构造更早；
            // 而启动只来自工具调用或 v4 命令，那时 runtime 必已就绪。
            registerResidencyBlockingWork: (work) => {
              void getRuntime().trackResidencyBlockingWork(work);
            },
            // 发起锚点：CreateWorkflow 在父会话的活动轮里执行，
            // 那一轮的 inputId 就是子代理 agent_step 要挂的 message。trace.turnId 对不上活动轮
            // （理论上不该发生）就交回 submit 侧兜底铸值，绝不把别的轮的 id 记成锚点。
            resolveLaunchInputId: (trace) => {
              const active = getRuntime().getActiveTurnInfo();
              return active !== undefined && active.turnId === trace.turnId
                ? active.inputId
                : undefined;
            },
            ...(isDynamicWorkflowTaskLinkStore(sessionStore)
              ? { taskLinkStore: sessionStore }
              : {}),
          });
    // dwf snippet service：EvalWorkflowSnippet 的执行面。刻意**不**依赖 dwf journal——
    // snippet 完全瞬态（内存 journal），不该被 run service 的 durability 前提连坐；
    // 所以即使 run 端口因 journal 缺席而不构造，实验通道仍然可用。
    const dynamicWorkflowSnippetPort = createDynamicWorkflowSnippetService({
      executionPort,
      fileSystemPort,
      logger,
    });
    // 模型目录：工具层把用户说的模型名解析成 workflow run 的子代理选型（model-catalog-port.ts）。
    const modelCatalogPort = createModelCatalogPort({
      registry: options.providerRegistry,
      currentSelection: () => getRuntime().getSessionModelSelection(),
    });
    runtime = new AgentRuntime(sessionId, runtimeConfig, {
      ...(options.readSubagentRuntimeConfig
        ? {
            loadAgentDefinitions: async (input) => {
              const snapshot = await options.readSubagentRuntimeConfig!(input);
              const parsed = subagentProfilesFromSnapshot(snapshot);
              const pluginProfiles =
                snapshot.kind === "built-in-fallback"
                  ? []
                  : resolvePluginAgentProfiles(
                      {
                        logger,
                        plugins: pluginOutcome.plugins,
                        reservedProfileNames: parsed.profiles.map((profile) => profile.name),
                        modelSelectionOverrides: parsed.pluginAgentModelSelectionOverrides,
                      },
                      pluginTemplates,
                    ).profiles;
              return {
                activeAgents: normalizeAgentProfiles(
                  [
                    ...(options.runtimeConfig?.subagents?.profiles ?? []),
                    ...parsed.profiles,
                    ...pluginProfiles,
                  ],
                  {
                    builtInModelSelectionOverrides: {
                      ...parsed.builtInModelSelectionOverrides,
                      ...options.runtimeConfig?.subagents?.builtInModelSelectionOverrides,
                    },
                  },
                ),
              };
            },
          }
        : {}),
      agentTelemetry: modelTelemetry.agentExecution,
      // 主代理的模型请求过治理器的 observer：立即放行，但让治理器看见它的 429 / 成功。
      modelRequestAdmission: workflowConcurrencyGovernor.observer(),
      // 主代理的 subagent 不是 observer：和 workflow run 一样排队、看冷却，同一父会话共用一条队列。
      subagentModelRequestAdmission: (parentSessionId) =>
        workflowConcurrencyGovernor.sessionSubagents(parentSessionId),
      eventStore: options.eventStore ?? createInMemorySessionEventStore(),
      sessionStore,
      sessionMailboxPort,
      logger,
      executionPort,
      workspaceHookAdmission: workspaceHookRuntimeSecurity?.admission,
      workspaceHookSnapshot: workspaceHookRuntimeSecurity?.snapshot,
      browserControlPort,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      artifactStore,
      contextSourcePort:
        options.contextSourcePort ?? createNodeContextSourceAdapter({ env: options.env }),
      skillPort:
        configResult.config.features.skill && configResult.config.skills.enabled
          ? (options.skillPort ??
            createNodeSkillAdapter({
              additionalDirectories: options.additionalDirectories,
              extraRoots: configResult.config.skills.roots,
              extraResolvedRoots: [...pluginOutcome.skillRoots, ...bundledSkillRoots],
              disabledPaths: [
                ...collectDisabledPaths(configResult.config.skillOverrides),
                // 动态工作流关闭时不提供 dynamic-workflows 技能：
                // 十个工具都不在场，再让模型读到「怎么写工作流脚本」只会诱导它去调不存在的工具。
                ...(runtimeConfig.dynamicWorkflowEnabled === false
                  ? collectDynamicWorkflowDisabledSkillPaths(bundledSkillRoots)
                  : []),
              ],
            }))
          : undefined,
      mcpPort,
      eventSink: options.eventSink,
      onOffPeakLifecycleEvent: options.onOffPeakLifecycleEvent
        ? (event) => options.onOffPeakLifecycleEvent!({ ...event, sessionId })
        : undefined,
      modelFactory,
      modelIoDir,
      providerRuntimeHeadersPort: options.providerRuntimeHeadersPort,
      resolveEffectiveModelSelection: options.resolveEffectiveModelSelection,
      isRemoteWorkspace: () =>
        isRemoteWorkspaceIdentity(runtimeConfig.memory?.workspaceIdentity ?? ""),
      permissionBroker: options.permissionBroker,
      permissionService,
      workflowPort: scriptWorkflowFacade.workflowPort,
      dynamicWorkflowRunPort,
      dynamicWorkflowSnippetPort,
      modelCatalogPort,
      sessionControl,
      automationPort: options.automationPort,
      offPeakPort: options.offPeakPort,
      topicResourcePort: options.topicResourcePort,
      pluginDiscoveryPort: options.pluginDiscoveryPort,
      appVersion,
      traceContext,
    });
    markRuntimeConstructed({
      hasInjectedModelAdapter: options.modelAdapter !== undefined,
      sessionId,
      startupTimer,
    });
    completeAppStartup({
      sessionId,
      startupTimer,
      workingDirectory,
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    const inputFacade = createInputFacade({
      cliDefaultSelection,
      artifactStore,
      customCommandPromptResolver: async (text, resolverOptions) => {
        const builtin = resolveZCodeBuiltinPromptCommandInvocation(text, {
          // 动态工作流灰度关闭时内置 `/workflow` 不得展开（DWG-03）。目录侧已经把它从 `/` 面板
          // 剔除，但用户仍可手打命令名，两条路径必须给出同一个结论。独立 CLI 的 TUI 与 headless
          // 按 --workflow-mode 显式取值；缺席（进程内嵌入方）不设门禁，见 runtimeConfig 字段注释。
          dynamicWorkflowEnabled: runtimeConfig.dynamicWorkflowEnabled,
          workingDirectory,
        });
        if (builtin !== undefined) {
          if (builtin.name === BUILTIN_WORKFLOW_COMMAND_NAME) {
            // `/workflow` 的展开处就是 onDemand 会话的激活点（launch.md「On demand: activation」）：
            // 它先于 executeTurn，本轮首个模型请求就带着十个工具。alwaysOn / 已激活会话里是 no-op。
            // 问的是 runtime 而不是闭包里的 runtimeConfig——构造时 config 被拷贝，闭包看不到翻转。
            await runtime?.activateDynamicWorkflowTools({
              source: "command",
              traceContext: resolverOptions?.traceContext ?? traceContext,
            });
            // 同一展开点打会话能力标签（docs/design/v2/model/session-features-header.md）；
            // 灰度关闭时命令不展开、不进入本分支，所以不打。
            runtime?.recordSessionFeature({
              feature: ModelRequestSessionFeature.WorkflowCmd,
              traceContext: resolverOptions?.traceContext ?? traceContext,
            });
          }
          return builtin.prompt;
        }
        return await resolveZCodeCustomCommandPrompt(text, {
          additionalDirectories: options.additionalDirectories,
          env: options.env,
          logger,
          projectConfigPath: options.projectConfigPath,
          skipUserConfig: options.skipUserConfig,
          userConfigPath: options.userConfigPath,
          workingDirectory,
        });
      },
      inputHistoryStore,
      logger,
      prepareUserExecutionBoundary,
      runtime,
      sessionId,
      traceContext,
    });
    const workflowFacade = createWorkflowFacade({
      agentTelemetry: modelTelemetry.agentExecution,
      appOptions: options,
      appVersion,
      artifactStore,
      cliStorageRoot,
      configResult,
      eventSink: options.eventSink,
      imageProcessorPort,
      pdfDocumentPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      prepareUserExecutionBoundary,
      runtime,
      runtimeConfig,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
    });
    // 额度停止的 run 到点自动续跑（dynamic-workflow-quota-resume.ts）。续跑与 UI 的「恢复」同一条路
    // （port.resume → 重臂追踪：终态通知、后台任务条目、常驻护栏），外加统一执行边界：冷启动补做时
    // 会话可能还没从存储恢复。
    const quotaAutoResume =
      dynamicWorkflowRunPort === undefined ||
      dynamicWorkflowJournal === undefined ||
      typeof dynamicWorkflowRunPort.resume !== "function"
        ? undefined
        : startWorkflowQuotaAutoResume({
            journal: dynamicWorkflowJournal,
            logger,
            parentSessionId: sessionId,
            resume: async (runId) => {
              await prepareUserExecutionBoundary({ traceContext });
              const result = await dynamicWorkflowRunPort.resume!(runId);
              if (result.ok) {
                await getRuntime().trackResumedDynamicWorkflowRun({
                  runId: result.runId,
                  ...(result.toolCallId === undefined ? {} : { toolCallId: result.toolCallId }),
                  traceContext,
                });
              }
              return result;
            },
            subscribeRunSettled: (listener) => dynamicWorkflowRunPort.subscribeRunSettled(listener),
          });
    const sessionFacade = createSessionFacade({
      closeScriptWorkflowRuns: () => scriptWorkflowFacade.closeScriptWorkflowRuns(),
      cliDefaultSelection,
      // App 关闭时停下本会话拥有的 dwf run：
      // 引擎活在本 App 的闭包里，关掉 App 而不停它，journal 行会停在 running 等下一次孤儿收敛。
      ...(dynamicWorkflowRunPort === undefined
        ? {}
        : {
            closeDynamicWorkflowRuns: () => {
              // 先停自动续跑：关闭中的 service 拒绝 resume，到点的定时器不该再去撞它。
              quotaAutoResume?.dispose();
              return dynamicWorkflowRunPort.close();
            },
          }),
      configResult,
      configuredMcpServers,
      ...(options.configuredDefaultModelSelection
        ? {
            configuredDefaultModelSelection: options.configuredDefaultModelSelection,
          }
        : {}),
      executionPort,
      localSettingStore,
      logger,
      loggerFactory,
      mcpPort,
      ownsExecutionPort,
      ownsMcpPort,
      closeNodeReplBrowserBroker: async () => {
        await ownedNodeReplBrowserBroker?.close();
      },
      ownsSessionStore,
      prepareUserExecutionBoundary,
      prepareResume,
      projectID,
      providerRegistry: options.providerRegistry,
      resolveUiLocale: (locale) => resolveEffectiveLocale(locale, options),
      runtime,
      sessionId,
      sessionStore,
      traceContext,
      untrustedProjectMcpServers,
      workingDirectory,
    });

    const closeSession = sessionFacade.close;
    const resolvePromptAttachment = async (input: {
      ref: string;
      mime: string;
      messageId?: string;
      attachmentIndex?: number;
    }): Promise<{ ref: string; mediaType: string; artifactUri?: string }> => {
      let ref = input.ref;
      let mediaType = input.mime;
      let artifactUri: string | undefined;
      if (input.messageId && input.attachmentIndex !== undefined) {
        // 预览单个附件曾通过 messages() 解码整段会话；长会话会同步扫描
        // 所有 parts，且无关坏行也会让目标预览失败。按 session/message 定点读取即可。
        const persistedMessage = await sessionStore.messageWithParts({
          sessionID: sessionId,
          messageID: input.messageId as MessageId,
        });
        const persistedAttachment = persistedMessage?.parts.filter((part) => part.type === "file")[
          input.attachmentIndex
        ];
        if (persistedAttachment?.type === "file") {
          mediaType = persistedAttachment.mime;
          // live row 的 ref 仍是原始路径；如果直接读取，源文件删除或覆盖后
          // 热态预览会和冷恢复 artifact 不一致。同一 message/index 必须优先取不可变副本。
          artifactUri =
            persistedAttachment.metadata?.artifactUri ??
            (persistedAttachment.url.startsWith("zcode-artifact://")
              ? persistedAttachment.url
              : undefined);
          ref =
            artifactUri ??
            (!persistedAttachment.url.startsWith("data:") ? persistedAttachment.url : input.ref);
        }
        // message row 会先于后续 FilePart 逐条落库；目标 part 尚未可见时仍应
        // 使用已经由当前 projection 授权的 input.ref，不能制造短暂的预览失败窗口。
      }
      return { ref, mediaType, ...(artifactUri ? { artifactUri } : {}) };
    };
    const app: ZCodeApp = {
      sessionId,
      traceId: traceContext.traceId,
      runtime,
      respondWorkspaceHookReview: (input) =>
        workspaceHookRuntimeSecurity?.respond(
          {
            sessionId: input.sessionId,
            taskId: input.taskId,
            runId: input.runId,
            ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
            workspaceIdentity: input.workspaceIdentity,
            bundleDigest: input.bundleDigest,
            reviewFlowId: input.reviewFlowId,
            generation: input.generation,
            interactionId: input.interactionId,
          },
          input.decision,
        ) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      toggleWorkspaceHookReviewItem: (input) =>
        workspaceHookRuntimeSecurity?.toggle(
          {
            sessionId: input.sessionId,
            taskId: input.taskId,
            runId: input.runId,
            ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
            workspaceIdentity: input.workspaceIdentity,
            bundleDigest: input.bundleDigest,
            reviewFlowId: input.reviewFlowId,
            generation: input.generation,
            interactionId: input.interactionId,
          },
          input.reviewItemId,
          input.enabled,
        ) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      revokeWorkspaceHookTrust: (input) =>
        ("hookDeclarationDigests" in input
          ? workspaceHookRuntimeSecurity?.revokeCurrent(input)
          : workspaceHookRuntimeSecurity?.revoke(
              {
                sessionId: input.sessionId,
                taskId: input.taskId,
                runId: input.runId,
                ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
                workspaceIdentity: input.workspaceIdentity,
                bundleDigest: input.bundleDigest,
                reviewFlowId: input.reviewFlowId,
                generation: input.generation,
                interactionId: input.interactionId,
              },
              input.reviewItemIds,
            )) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      requestWorkspaceHookReview: (input) =>
        workspaceHookRuntimeSecurity?.requestReview({
          workspaceIdentity: input.workspaceIdentity,
          bundleDigest: input.bundleDigest,
        }) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      // Settings pretrust 写盘后由 server 按 workspace 调用：重载 Trust store 到本
      // session 的 coordinator 并重发 admission 状态（详见 types.ts 注释）。
      reloadWorkspaceHookTrust: () =>
        workspaceHookRuntimeSecurity?.reloadTrust() ?? Promise.resolve(),
      reloadWorkspaceMcpTrust: () =>
        mcpPort?.refreshWorkspaceTrustAdmission?.() ?? Promise.resolve(),
      setModelIoFullRetentionEnabled: (enabled) =>
        modelAdapter.setModelIoFullRetentionEnabled(enabled),
      readToolResultArtifact: (uri) =>
        artifactStore.readToolResultArtifact({ uri, trace: traceContext }),
      // wire/staging 全程是 decoded chunk；只有完整 checksum commit 后才在
      // CLI 进程内恢复既有 data-URL artifact 形态，保持 provider 读取链兼容。
      writePromptAttachment: async (input) => {
        const artifact = await artifactStore.writeToolResultArtifact({
          content: `data:${input.mime};base64,${Buffer.from(input.bytes).toString("base64")}`,
          contentType: "text/plain",
          retention: "session",
          sessionId,
          toolCallId: `prompt-attachment-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          toolName: "prompt-attachment:upload",
          trace: traceContext,
        });
        if (
          input.mime.startsWith("image/") ||
          input.mime.startsWith("video/") ||
          input.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf"
        ) {
          // 派生媒体只是可重建缓存；真实 IO 失败不破坏 durable data URL，最终请求投影会再次 ensure。
          void artifactStore
            .primeMediaAttachmentPath?.({
              bytes: input.bytes,
              mediaType: input.mime,
              uri: artifact.uri,
            })
            .catch(() => undefined);
        }
        return { ref: artifact.uri };
      },
      readPromptAttachment: async (input) => {
        const { ref, mediaType } = await resolvePromptAttachment(input);
        // 读取必须留在 session runtime 内：artifact 走 session store，路径走当前
        // FileSystemPort，SSH/WSL/Docker 才会命中正确的远端文件系统。
        if (ref.startsWith("zcode-artifact://")) {
          const artifact = await artifactStore.readToolResultArtifact({
            uri: ref,
            trace: traceContext,
          });
          return decodePromptAttachmentDataUrl(artifact.content, mediaType, input.maxBytes);
        }
        const read = await fileSystemPort.readBinaryFile({
          path: ref,
          maxBytes: input.maxBytes,
          trace: traceContext,
        });
        return { bytes: read.content, mediaType };
      },
      statPromptAttachment: async (input) => {
        const { ref, mediaType, artifactUri } = await resolvePromptAttachment(input);
        if (artifactUri) {
          if (!artifactStore.statToolResultArtifact) {
            throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statUnsupported);
          }
          const result = await artifactStore.statToolResultArtifact({
            uri: artifactUri,
            trace: traceContext,
          });
          return {
            totalBytes: result.bytes,
            mediaType: result.contentType || mediaType,
            ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
          };
        }
        const result = await fileSystemPort.stat({ path: ref, trace: traceContext });
        if (result.kind !== "file") {
          // 目录/符号链接/已消失都意味着「这个附件不再是可分享的文件」，用稳定码上抛，
          // 让 share 预检按确定分类处理，而不是靠错误文本猜。
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statNotFile);
        }
        return {
          totalBytes: result.sizeBytes,
          mediaType,
          ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
        };
      },
      resolvePromptAttachmentPreviewSource: async (input) => {
        const resolved = await resolvePromptAttachment(input);
        if (!resolved.mediaType.startsWith("video/")) return { kind: "chunked" };
        if (resolved.artifactUri) {
          if (!artifactStore.ensureMediaAttachmentPath) return { kind: "chunked" };
          try {
            const materialized = await artifactStore.ensureMediaAttachmentPath({
              uri: resolved.artifactUri,
              mediaType: resolved.mediaType,
            });
            if (materialized.status === "ready" && materialized.path.trim()) {
              return {
                kind: "local_path",
                path: materialized.path,
                mediaType: resolved.mediaType,
              };
            }
          } catch {
            // artifact 仍是不可变事实；派生文件失败只允许 gateway 回到 artifact chunk。
          }
          return { kind: "chunked" };
        }
        if (isAbsolute(resolved.ref)) {
          return {
            kind: "local_path",
            path: resolved.ref,
            mediaType: resolved.mediaType,
          };
        }
        return { kind: "chunked" };
      },
      ...sessionFacade,
      close: async () => {
        try {
          // 先关闭 manager 准入并等后台根中断落盘，再让发起会话关闭其拥有的共享存储。
          try {
            await standaloneSessionControl?.close();
          } finally {
            await closeSession?.();
          }
        } finally {
          try {
            providerModelRuntime?.dispose();
          } finally {
            try {
              await modelTelemetry.shutdown();
            } catch (error) {
              // 遥测失败不表示 session 仍占用运行资源，也不能覆盖真正的关闭错误。
              logger.warn("Session telemetry shutdown failed", {
                event: "session.telemetry_shutdown.failed",
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      },
      ...workflowFacade,
      ...scriptWorkflowFacade,
      // dwf 事件日志的读面。**可选能力**：journal 不可用时 run service 整个不构造，
      // 这个方法随之缺席，v4 网关据此回结构化的能力不支持错误——「没有事件」与
      // 「这个会话没有这个能力」必须能被 renderer 区分。
      ...(dynamicWorkflowRunPort === undefined
        ? {}
        : {
            listDynamicWorkflowRunEvents: async (input: {
              runId: string;
              afterSequence?: number;
              limit?: number;
              maxBytes?: number;
            }) =>
              dynamicWorkflowRunPort.listEvents(input.runId, {
                ...(input.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                ...(input.limit === undefined ? {} : { limit: input.limit }),
                ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
              }),
          }),
      // workflow run 的**用户面产物**读面。三条一起注册、
      // 一起缺席：它们是同一个 journal 读面的三个切片，部分在场只会让 UI 拿到一张有卡片
      // 却打不开的侧板。三个端口成员都是可选的（stub 端口不陪跑），所以逐个探测。
      // ⚠ 术语：artifact = 脚本发布给用户看的产出，不是端口上的 `output`（顶层返回值）。
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.listArtifacts !== "function" ||
      typeof dynamicWorkflowRunPort.listArtifactItems !== "function" ||
      typeof dynamicWorkflowRunPort.readArtifact !== "function"
        ? {}
        : {
            listDynamicWorkflowRunArtifacts: async (input: { runId: string }) =>
              dynamicWorkflowRunPort.listArtifacts!(input.runId),
            listDynamicWorkflowRunArtifactItems: async (input: {
              runId: string;
              artifactId: string;
              afterSequence?: number;
              limit: number;
              maxBytes: number;
              fields?: readonly string[];
            }) =>
              dynamicWorkflowRunPort.listArtifactItems!(input.runId, input.artifactId, {
                ...(input.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                limit: input.limit,
                maxBytes: input.maxBytes,
                ...(input.fields === undefined ? {} : { fields: input.fields }),
              }),
            readDynamicWorkflowRunArtifact: async (input: {
              runId: string;
              artifactId: string;
              version: number;
            }) =>
              dynamicWorkflowRunPort.readArtifact!(input.runId, input.artifactId, input.version),
          }),
      // workflow run 的工作区 transcript：两条一起
      // 注册、一起缺席，理由同产物的三条。
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.listWorkspaceNodes !== "function" ||
      typeof dynamicWorkflowRunPort.readWorkspaceNodeResult !== "function"
        ? {}
        : {
            listDynamicWorkflowRunWorkspaceNodes: async (input: { runId: string }) =>
              dynamicWorkflowRunPort.listWorkspaceNodes!(input.runId),
            readDynamicWorkflowRunNodeResult: async (input: {
              runId: string;
              siteId: string;
              ordinal: number;
              maxBytes: number;
            }) =>
              dynamicWorkflowRunPort.readWorkspaceNodeResult!(
                input.runId,
                input.siteId,
                input.ordinal,
                { maxBytes: input.maxBytes },
              ),
          }),
      // dwf run 的会话级生命周期读面（在飞计数 + 结算订阅）。消费者是宿主的 provider registry
      // 安全边界：子代理共用本会话的 live adapter，在飞 run 期间 replace registry 会 dispose
      // 它们绑定的请求资源。缺席条件同上。
      ...(dynamicWorkflowRunPort === undefined ? {} : {}),
      // dwf run 的枚举面（重启后的发现查询）。能力缺席条件同上；端口的 listRunsForSession
      // 是可选成员，方法缺席时本能力同样不注册。
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.listRunsForSession !== "function"
        ? {}
        : {
            listDynamicWorkflowRuns: async (input: { limit?: number }) =>
              dynamicWorkflowRunPort.listRunsForSession!(input.limit),
          }),
      // workflow run 的冷回放。能力缺席条件同上。
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.replayProgressForSession !== "function"
        ? {}
        : {
            replayDynamicWorkflowRuns: async (input: { excludeRunIds: ReadonlySet<string> }) =>
              dynamicWorkflowRunPort.replayProgressForSession!(input),
          }),
      // dwf run 的恢复。能力缺席条件同上；此外
      // 端口的 resume 是可选成员（stub 端口不陪跑），方法缺席时本能力同样不注册——
      // 对 renderer「端口缺席」与「方法缺席」是同一个业务事实。
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.resume !== "function"
        ? {}
        : {
            resumeWorkflowRun: async (input: { workId: string; name?: string }) => {
              const result = await dynamicWorkflowRunPort.resume!(input.workId);
              if (result.ok) {
                // 追踪重臂必须紧随成功的 resume：registry 登记（回收护栏）、backgroundWorks
                // 条目（cancellable）、终态通知。port.resume 已先替换注册表条目，
                // waiter 因此挂在新的结算 promise 上（run service 文件头不变式 5）。
                await getRuntime().trackResumedDynamicWorkflowRun({
                  runId: result.runId,
                  ...(result.toolCallId === undefined ? {} : { toolCallId: result.toolCallId }),
                  ...(input.name === undefined ? {} : { name: input.name }),
                  traceContext,
                });
              }
              return result;
            },
          }),
      // 中枢直接启动一个已保存的工作流。能力缺席条件与
      // resumeWorkflowRun 家族一致：dwf 端口整体缺席（stub / 单测宿主）时不注册——GUI 据此拿到
      // 能力不支持错误并原样显示，而不是把「不支持直接启动」误当成一次失败的启动。
      // 与 /goal 控制轮同构：先走统一用户执行边界（读取 shell 设置并完成 resume 准备），
      // 再由 runtime 解析 + 校验 + 编译 + 落启动轮 + submit。
      ...(dynamicWorkflowRunPort === undefined
        ? {}
        : {
            startSavedWorkflow: async (input: {
              name: string;
              scope?: "project" | "global";
              args?: Record<string, unknown>;
            }) => {
              await prepareUserExecutionBoundary({ traceContext });
              return await getRuntime().startSavedWorkflowRun({ ...input, traceContext });
            },
          }),
      // GUI「配置」。它
      // 沿用前驱的脚本，所以端口必须既能 amend 又能读回脚本；缺一就不注册，GUI 拿到能力不支持。
      // 与 startSavedWorkflow 同一条用户执行边界：冷恢复的会话先恢复 Session 边界再落设置轮。
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.amend !== "function" ||
      typeof dynamicWorkflowRunPort.getScript !== "function"
        ? {}
        : {
            amendWorkflowRunSettings: async (
              input: Omit<AmendWorkflowRunSettingsInput, "traceContext">,
            ) => {
              await prepareUserExecutionBoundary({ traceContext });
              return await getRuntime().amendWorkflowRunSettings({ ...input, traceContext });
            },
          }),
      ...createPluginFacadeForApp({ configResult, options, workingDirectory }),
      getPluginReferenceCatalog: () => pluginReferenceCatalog,
      getSkillCatalog: async () => {
        // Skill 目录属于 context 初始化结果。冷恢复必须先恢复 Session 边界，再读取
        // 新 runtime 的快照，不能绕开 resume 后用旧工作目录独立扫描。
        await prepareUserExecutionBoundary({ traceContext });
        return await getRuntime().getSkillCatalog(traceContext);
      },
      resume: resumeFromStore,
      ...inputFacade,
    };
    standaloneSessionControl?.attachRoot(app, standaloneRootProvenance);
    return app;
  } catch (error) {
    await standaloneSessionControl?.close();
    providerModelRuntime?.dispose();
    void modelTelemetry.shutdown().catch(() => undefined);
    void ownedNodeReplBrowserBroker?.close();
    startupTimer.fail("ZCode app startup failed", error, {
      context: { sessionId, workingDirectory },
      event: "bootstrap.app.startup.failed",
      stage: "total",
    });
    throw error;
  }
}
