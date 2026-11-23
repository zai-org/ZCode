import {
  builtInTools,
  createConfiguredHookRunner,
  createInMemoryHookRunner,
  createSessionMailboxHookRegistrations,
  createToolExecutor,
  getCurrentTraceContext,
  registerBuiltInTools,
  traceContextToLogContext,
} from "../deps.js";
import type { HookRunner, SessionId, ToolExecutor, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeDeps } from "../types.js";
import { resolveRuntimeEmbeddedSearchEnabled } from "../methods/embedded-search-branch.js";
import { getSessionShellSelectionFromConfig } from "../methods/session-shell-environment.js";
import { createRuntimeSessionModePort } from "../session-mode-port.js";
import { shouldSuppressSealedSubagentBashNotification } from "../../runtime-task/notification-policy.js";
import {
  resolveRuntimeDynamicWorkflowToolSurfaceDeferral,
  resolveBuiltInToolAllowlist,
  resolveRuntimeAgentAlwaysBackground,
  resolveRuntimeDisallowedTools,
  resolveRuntimeDynamicWorkflowToolsIncluded,
} from "./tool-allowlist.js";
import { isStaleBranchRuntimeTaskEvent } from "../methods/runtime-command-generation.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";
import { sessionHasLoadedSkill } from "../../agent/loaded-skills.js";
import { sessionControlForRuntime } from "../../tool/session-control/contract.js";
import {
  createMcpServerWaitPort,
  describeUnavailableMcpTool,
  resolveUnregisteredMcpTool,
} from "../methods/mcp.js";

const DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS = 3_600_000;
const EMPTY_RUNTIME_HOOK_CONFIG = {
  enabled: false,
  events: {},
  maxOutputBytes: 32_768,
  timeoutMs: 60_000,
} as const;

export function initializeRuntimeTooling(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  sessionId: SessionId,
): { executor: ToolExecutor; hookRunner?: HookRunner } {
  registerRuntimeBuiltInTools(runtime, deps);
  const hookRunner = createRuntimeHookRunner(runtime, deps, sessionId);
  return {
    executor: deps.toolExecutor ?? createRuntimeToolExecutor(runtime, deps, hookRunner),
    hookRunner,
  };
}

function registerRuntimeBuiltInTools(runtime: AgentRuntimeInternal, deps: AgentRuntimeDeps): void {
  const nodeReplEnabled = runtime.config.runtimeFeatures?.nodeRepl === true;
  runtime.sessionControlKind = sessionControlForRuntime(
    deps.sessionControl,
    runtime.config.taskType,
    runtime.sessionId,
  )?.kind;
  const browserUseEnabled = resolveRuntimeBrowserUseEnabled(runtime, deps);
  registerBuiltInTools(runtime.registry, {
    bashTimeoutPolicy: runtime.config.bashTimeoutPolicy,
    includeSkill: Boolean(runtime.skillPort),
    includeAgent: Boolean(runtime.subagentPort),
    includeSendMessage: runtime.subagentPort?.sendMessage !== undefined,
    includeRespondToCoordinator:
      runtime.config.taskType === "subagent_child" && Boolean(deps.coordinatorResponsePort),
    // submit_result 只在注入了 workflowSubmitPort 的 workflow actor 会话注册。以端口存在为门，
    // 与 taskType 无关：workflow actor 是 workflow_child，其 runtimeScope 目前是 "main"。
    includeSubmitResult: Boolean(deps.workflowSubmitPort),
    // mono 子代理：typed 声明。门仍是端口。
    ...(deps.workflowSubmitSchema === undefined
      ? {}
      : { submitResultSchema: deps.workflowSubmitSchema }),
    // escalate 与 submit_result 同门同理由：端口在场即注册（不做 opt-in：最可能撞墙的 actor 恰是作者没标记的那个）。
    includeEscalate: Boolean(deps.workflowEscalatePort),
    includeWorkflow: Boolean(deps.workflowPort),
    sessionControlKind: runtime.sessionControlKind,
    includeAutomation: Boolean(deps.automationPort) && runtime.config.taskType !== "subagent_child",
    // offPeakPort 只在 host 下发 offPeakToolEnabled 时注入（灰度/远程门在 host 端），
    // 端口存在即代表曝光允许；subagent 子会话与 automation 同规则不暴露。
    includeOffPeak: Boolean(deps.offPeakPort) && runtime.config.taskType !== "subagent_child",
    // 话题资源只在 App 托管运行时可读；CLI 不知道会话是否为机器人会话，授权在调用时按可信输入校验。
    includeTopicResource: Boolean(deps.topicResourcePort),
    // 动态工作流灰度门：与 off-peak 相反，
    // 这里不能用端口在场做判据——十个工具的端口在任何 CLI 里都装配齐全，灰度是 Host 的决定。
    // 取值收在 tool-allowlist.ts，与分支刷新那个入口共用同一个推导。
    includeDynamicWorkflow: resolveRuntimeDynamicWorkflowToolsIncluded(runtime),
    agentAlwaysBackground: resolveRuntimeAgentAlwaysBackground(runtime.config),
    includePluginDiscovery:
      Boolean(deps.pluginDiscoveryPort) && runtime.config.taskType !== "subagent_child",
    // 与 MCP 会话同门（agent-runtime 在有 mcpPort 时创建会话）；本轮是否可见由 getTools(model) 决定。
    includeMcpServerWait: Boolean(deps.mcpPort),
    // 修复原因：browserControlPort 只是宿主能力，不应隐式暴露高权限 node_repl。
    // node_repl/browser-use 由 ZCode 官方 browser-use 插件启停推导出的 runtimeFeatures 控制。
    includeNodeRepl: nodeReplEnabled,
    includeBrowserUse: browserUseEnabled,
    embeddedSearchEnabled: resolveRuntimeEmbeddedSearchEnabled(runtime),
    allowedTools: resolveBuiltInToolAllowlist(runtime.config),
    // workflow_child 的结构性禁用（CreateWorkflow/SaveWorkflow 因 alwaysAsk 隐形挂起；
    // ResumeWorkflowRun 已免确认但因「child 内不得再编排」仍在列）在 helper
    // 里与 turn 级名单合并，见 tool-allowlist.ts 的根因注释。
    disallowedTools: resolveRuntimeDisallowedTools(runtime.config),
  });
}

function createRuntimeHookRunner(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  sessionId: SessionId,
): HookRunner | undefined {
  let hookRunner =
    deps.hookRunner ??
    ((runtime.config.hooks?.enabled || deps.workspaceHookSnapshot) && deps.executionPort
      ? createConfiguredHookRunner({
          config: runtime.config.hooks ?? EMPTY_RUNTIME_HOOK_CONFIG,
          emitEvent: async (event) => {
            await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
          },
          executionPort: deps.executionPort,
          getWorkingDirectory: () => runtime.workingDirectory,
          logger: runtime.logger,
          workspaceHookAdmission: deps.workspaceHookAdmission,
          workspaceHookSnapshot: deps.workspaceHookSnapshot,
        })
      : undefined);

  if (!deps.sessionMailboxPort) {
    return hookRunner;
  }

  hookRunner ??= createInMemoryHookRunner({
    emitEvent: async (event) => {
      if (isStaleBranchRuntimeTaskEvent(runtime, event)) return;
      await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
    },
    logger: runtime.logger,
  });
  for (const hook of createSessionMailboxHookRegistrations({
    enqueuePendingInput: async (input, traceContext) => {
      const result = await runtime.steerTurn({
        delivery: "guide",
        expectedTurnId: traceContext.turnId,
        input,
        traceContext,
      });
      if (result.kind === "rejected") {
        runtime.logger?.warn("Session mailbox input was not queued", {
          ...traceContextToLogContext(traceContext),
          event: "session.mailbox.queue_rejected",
          module: "core.runtime",
          reason: result.reason,
          status: "completed",
        });
      }
    },
    mailbox: deps.sessionMailboxPort,
    sessionId,
  })) {
    if ("register" in hookRunner && typeof hookRunner.register === "function") {
      hookRunner.register(hook);
    }
  }
  return hookRunner;
}

function createRuntimeToolExecutor(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  hookRunner: HookRunner | undefined,
): ToolExecutor {
  const browserUseEnabled = resolveRuntimeBrowserUseEnabled(runtime, deps);
  return createToolExecutor({
    agentTelemetry: runtime.agentTelemetry.port,
    agentTelemetryActorKind: runtime.agentTelemetry.actorKind,
    registry: runtime.registry,
    permissionService: runtime.permissionService,
    permissionBroker: runtime.permissionBroker,
    emitEvent: async (event) => {
      await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
    },
    enqueueBackgroundTaskNotification: (notification) => {
      runtime.enqueueBackgroundTaskNotification(notification);
    },
    shouldEnqueueBackgroundTaskNotification: (input) =>
      shouldEnqueueRuntimeBackgroundTaskNotification(runtime, input),
    logger: runtime.logger,
    backgroundTaskControlPort: {
      stopBackgroundTask: runtime.stopBackgroundTask.bind(runtime),
    },
    executionPort: deps.executionPort,
    browserControlPort: browserUseEnabled ? deps.browserControlPort : undefined,
    browserDocumentationRoot: browserUseEnabled
      ? runtime.config.runtimeFeatures?.browserDocumentationRoot
      : undefined,
    fileSystemPort: deps.fileSystemPort,
    httpClientPort: deps.httpClientPort,
    imageProcessorPort: deps.imageProcessorPort,
    // 合并删除旧模型连接时曾漏掉此端口；Read 分页渲染与整份 PDF 页数检查仍依赖宿主注入。
    pdfDocumentPort: deps.pdfDocumentPort,
    embeddedSearchBackend: runtime.config.embeddedSearchBackend,
    nativeSearchEnhancementsEnabled: runtime.config.nativeSearchEnhancementsEnabled,
    skillPort: deps.skillPort,
    subagentPort: runtime.subagentPort,
    coordinatorResponsePort: deps.coordinatorResponsePort,
    workflowSubmitPort: deps.workflowSubmitPort,
    workflowEscalatePort: deps.workflowEscalatePort,
    webSearchBudget: deps.webSearchBudget,
    artifactStore: deps.artifactStore,
    sessionControl: sessionControlForRuntime(
      deps.sessionControl,
      runtime.config.taskType,
      runtime.sessionId,
    ),
    automationPort: deps.automationPort,
    offPeakPort: deps.offPeakPort,
    topicResourcePort: deps.topicResourcePort,
    pluginDiscoveryPort: deps.pluginDiscoveryPort,
    sessionStore: deps.sessionStore,
    sessionModePort: createRuntimeSessionModePort(runtime),
    workflowPort: deps.workflowPort,
    dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort: deps.dynamicWorkflowSnippetPort,
    modelCatalogPort: deps.modelCatalogPort,
    runtimeTaskRegistry: runtime.runtimeTaskRegistry,
    registerResidencyBlockingWork: (work) => {
      void runtime.trackResidencyBlockingWork(work).catch(() => undefined);
    },
    readFileState: runtime.readFileState,
    // 工作流创作工具的技能门（tool/handlers/workflow-skill-gate.ts）：按模型此刻看得见的历史回答
    // 「读过技能没有」。只在会话真有 Skill 工具时给探针——没有 skillPort 的会话装不上那个技能，
    // 门若仍然在场就成了一道谁也过不去的墙。
    ...(deps.skillPort === undefined
      ? {}
      : {
          hasLoadedSkill: (skillName: string) =>
            sessionHasLoadedSkill(runtime.messageHistory.borrowReadOnlyRuntimeEntries(), skillName),
        }),
    // Skill 工具的未激活提示（tool/handlers/skill.ts）：只读 runtime 自己的激活态，每次调用现取，
    // 所以 `/workflow` 激活之后的下一次 Skill 调用就读到 "none"。
    getDynamicWorkflowToolSurfaceDeferral: () =>
      resolveRuntimeDynamicWorkflowToolSurfaceDeferral(runtime),
    describeUnavailableTool: (toolName, model) =>
      describeUnavailableMcpTool(runtime, toolName, model) ||
      describeUnavailableBuiltInTool(runtime, toolName),
    ...(deps.mcpPort === undefined
      ? {}
      : {
          mcpServerWaitPort: createMcpServerWaitPort(runtime),
          resolveUnregisteredTool: (toolName, options) =>
            resolveUnregisteredMcpTool(runtime, toolName, options),
        }),
    subagentBackgroundBashMaxMs:
      runtime.config.taskType === "subagent_child"
        ? normalizeSubagentBackgroundBashMaxMs(runtime.config.subagents?.backgroundBashMaxMs)
        : undefined,
    getBashShellSelection: () => getSessionShellSelectionFromConfig(runtime.config),
    hookRunner,
    getWorkingDirectory: () => runtime.workingDirectory,
    setWorkingDirectory: runtime.setWorkingDirectory.bind(runtime),
    getWorkspaceRoot: () => runtime.workspaceRoot,
    workspaceIdentity: runtime.config.workspaceIdentity?.toString(),
    workspaceKey: runtime.config.workspaceKey,
    remoteSessionId: runtime.config.remoteSessionId,
    clientMode: runtime.config.clientMode,
    deliveryKind: runtime.config.deliveryKind,
    getMemoryRoot: () =>
      deps.memoryRoot ?? resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot),
    runtimeScope: runtime.config.taskType === "subagent_child" ? "subagent" : "main",
    syncSubagent:
      runtime.config.taskType === "subagent_child" &&
      runtime.config.subagents?.startedInForeground === true,
    permissionTimeoutMs: runtime.config.permissionTimeoutMs,
    sessionId: runtime.sessionId,
    traceContext: runtime.rootTraceContext,
    getMode: () => runtime.config.mode ?? "build",
    maxConcurrency: runtime.config.toolConcurrency?.maxConcurrency,
  });
}

/**
 * MCP 之外的未注册工具报错后缀，判定顺序见 docs/model-tool-call-validation.md「未知工具的后缀」。
 * 修复原因：原来只有 MCP 工具有后缀。大小写写错、调用已移除的 Grep/Glob、子代理里调用没有提供的内置工具时，
 * 模型只看到 "No such tool available"，不知道该换哪个工具，容易重复同一个调用。
 */
function describeUnavailableBuiltInTool(runtime: AgentRuntimeInternal, toolName: string): string {
  // embedded search 不注册 Grep/Glob，但它们仍在 builtInTools 里，所以排在内置工具判定之前。
  if (toolName === "Grep" || toolName === "Glob") {
    if (!runtime.registry.has("Bash")) return `. ${toolName} is disabled for this session.`;
    return toolName === "Grep"
      ? ". Grep is not available in this session — search file contents with `grep` via the Bash tool instead."
      : ". Glob is not available in this session — find files with `find` via the Bash tool instead.";
  }
  if (builtInTools.some((entry) => entry.metadata.name === toolName)) {
    return runtime.config.taskType === "subagent_child"
      ? `. ${toolName} is not available inside subagents. Complete the task with the tools provided and return your findings in your final response.`
      : `. ${toolName} is not among the tools available here. Continue with the tools you have.`;
  }
  const lowerName = toolName.toLowerCase();
  const matches = runtime.registry.list().filter((name) => name.toLowerCase() === lowerName);
  return matches.length === 1 ? `. Tool names are case-sensitive: call ${matches[0]} instead.` : "";
}

function resolveRuntimeBrowserUseEnabled(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
): boolean {
  return (
    runtime.config.runtimeFeatures?.browserUse === true && deps.browserControlPort !== undefined
  );
}

function shouldEnqueueRuntimeBackgroundTaskNotification(
  runtime: AgentRuntimeInternal,
  input: {
    status: string;
    taskId: string;
    toolName: string;
    traceContext: TraceContext;
  },
): boolean {
  if (runtime.shuttingDown) {
    runtime.logger?.info?.("Suppressed background task notification during runtime shutdown", {
      ...traceContextToLogContext(input.traceContext),
      event: "runtime.background_task_notification.shutdown_suppressed",
      module: "core.runtime",
      taskId: input.taskId,
      taskStatus: input.status,
      toolName: input.toolName,
    });
    return false;
  }
  const registryTask = runtime.runtimeTaskRegistry.get(input.taskId);
  if (
    !shouldSuppressSealedSubagentBashNotification({
      isSubagentChildRuntime: runtime.config.taskType === "subagent_child",
      notificationSealed: runtime.backgroundTaskNotificationsSealed,
      registryTask,
      toolName: input.toolName,
    })
  ) {
    return true;
  }
  runtime.logger?.info?.("Suppressed sealed subagent background Bash notification", {
    ...traceContextToLogContext(input.traceContext),
    event: "runtime.background_task_notification.suppressed",
    module: "core.runtime",
    reason: runtime.backgroundTaskNotificationSealReason,
    taskId: input.taskId,
    taskStatus: input.status,
    toolName: input.toolName,
  });
  return false;
}

function normalizeSubagentBackgroundBashMaxMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS;
  }
  return Math.trunc(value);
}
