import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import type { ConfigResult } from "@zcode/adapters/config";
import {
  AgentRuntime,
  type AgentRuntimeConfig,
  type AgentRuntimeDeps,
  type ChildClientPortsContext,
  type PermissionService,
} from "@zcode/core";
import {
  type AgentExecutionTelemetryPort,
  type BrowserControlPort,
  type ContextSourcePort,
  type FileSystemPort,
  type HttpClientPort,
  type ImageProcessorPort,
  type JsonSchema,
  type PdfDocumentPort,
  type Logger,
  type McpPort,
  type ModelRequestAdmission,
  type SessionId,
  type SessionStorePort,
  type SkillPort,
  type SkillRoot,
  type ToolArtifactStorePort,
  type TraceContext,
  type WorkflowAgentCallInput,
  type WorkflowEscalatePort,
  type WorkflowWebSearchBudgetPort,
  type WorkflowSubmitPort,
} from "@zcode/contracts";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import { parseProviderQualifiedModelSelection } from "./provider-registry-selection.js";
import type { ZCodeAppOptions } from "./types.js";

export interface ScriptWorkflowAgentRuntimeDeps {
  agentTelemetry: AgentExecutionTelemetryPort;
  appOptions: ZCodeAppOptions;
  appVersion: string;
  artifactStore?: ToolArtifactStorePort;
  configResult: ConfigResult;
  contextSourcePort?: ContextSourcePort;
  fileSystemPort: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  logger: Logger;
  mcpPort?: McpPort;
  /** 父会话的 model factory：child 与主 turn 从同一份 Registry 视图造 Model，不各自冻结。 */
  modelFactory: NonNullable<AgentRuntimeDeps["modelFactory"]>;
  permissionService: PermissionService;
  /**
   * 插件的技能根（主会话 skill 端口的同一份 `pluginOutcome.skillRoots`）。捆绑技能根不在内：
   * 那里只有 dynamic-workflows，子代理不能起工作流。
   */
  pluginSkillRoots: readonly SkillRoot[];
  runtime: AgentRuntime;
  runtimeConfig: AgentRuntimeConfig;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  storageRoot: string;
  workingDirectory: string;
}

export function createScriptWorkflowAgentRuntime(input: {
  childSessionId: SessionId;
  deps: ScriptWorkflowAgentRuntimeDeps;
  request: WorkflowAgentCallInput;
  traceContext: TraceContext;
  /**
   * 覆盖 child runtime 的配置切片。dwf actor 用它落工具面：`workflowActorToolPolicy` 给出
   * `toolDisallowlist`（全集的减法），而 `request.opts.tools` 只能表达 allowlist——两者不是
   * 同一个自由度。
   */
  configOverrides?: Partial<AgentRuntimeConfig>;
  /**
   * 会话级 submit 端口。注入即为该会话注册 submit_result 工具（core 的注册门以端口存在为准），
   * 这是 dwf typed ask 的终止通道。
   */
  workflowSubmitPort?: WorkflowSubmitPort;
  /**
   * mono 子代理的 typed `submit_result` 声明：
   * 在场时 core 注册 `{ result: <schema> }` 而非任意 JSON。只与 workflowSubmitPort 同在时有意义。
   */
  workflowSubmitSchema?: JsonSchema;
  /**
   * 会话级升级端口。注入即为该会话注册 `escalate` 工具
   * （core 的注册门同样以端口存在为准），这是 actor 遇到真阻塞时唯一的求助通道。
   */
  workflowEscalatePort?: WorkflowEscalatePort;
  /** 每个 ask 的 WebSearch 预算端口（dwf actor 恒有）；缺席即无上限（legacy `Workflow` 子代理）。 */
  webSearchBudget?: WorkflowWebSearchBudgetPort;
  /**
   * 模型请求准入端口。dwf actor 由 driver
   * 给出（每次模型请求尝试先过进程级闸门）；legacy `Workflow` 工具的子代理不传——不受闸门约束、
   * 不喂信号。与两个工具端口同路进 runtime deps。
   */
  modelRequestAdmission?: ModelRequestAdmission;
  /**
   * 交互请求 origin 上的 `description`（权限窗来源徽标的文字）。dwf actor 由工厂给出
   * `<persona 名> (<siteId>@<ordinal>)`（workflow-actor-permission.ts）；缺席时回落到
   * `request.opts.label` / agentType（legacy workflow child 的既有行为）。
   */
  interactionDescription?: string;
  /**
   * **父会话**的浏览器端口（主 runtime 用的那一份）。在场即给子代理 Browser Use：这里用
   * `forChildSession` 派生出子端口——tab 归属是子会话自己的 id，workspace / clientMode 取父会话，
   * runtime 关闭时连 tab 一起关并撤销登记。只有 dwf actor 传：它的 runtime 在 run dispose 时必然
   * `closeBrowserSession`；legacy workflow child 没有关闭链路，不传
   * （apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Subagent sessions」）。
   */
  browserControlPort?: BrowserControlPort;
}): AgentRuntime {
  // dwf actor 经 configOverrides.workflowActor 走 builder 的叠加路径，此时 systemPrompt 必须
  // 缺席（builder 对二者同在抛错）——父会话自带的 custom system prompt 不得漏给子代理，所以
  // 从继承的配置里把它剥掉，而不是靠后面的覆盖。
  const { systemPrompt: inheritedSystemPrompt, ...inheritedConfig } = input.deps.runtimeConfig;
  const systemPrompt =
    input.configOverrides?.workflowActor === undefined
      ? (input.request.opts?.systemPrompt ?? inheritedSystemPrompt)
      : undefined;
  const parentSelection = input.deps.runtime.getSessionModelSelection();
  const requestedSelection = input.request.opts?.model
    ? parseProviderQualifiedModelSelection(input.request.opts.model)
    : undefined;
  if (input.request.opts?.model && !requestedSelection) {
    throw new Error(`Workflow child model must be provider-qualified: ${input.request.opts.model}`);
  }
  const modelSelection = requestedSelection ?? parentSelection;
  return new AgentRuntime(
    input.childSessionId,
    {
      ...inheritedConfig,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      agentName: input.request.opts?.agentType ?? "zcode-workflow",
      maxTurns: input.request.opts?.maxTurns ?? input.deps.runtimeConfig.maxTurns,
      // 基线 YOLO，父任务仍保留自己的 Guarded。legacy script workflow child 就停在这里；dwf actor
      // 经 configOverrides 覆盖成 run 记下的模式（docs/dynamic-workflow/launch.md
      // 「Permissions inside a run」）。
      mode: "yolo",
      modelSelection,
      // 父 Shell 在首条输入才解析，子会话须继承父 runtime 已初始化的 shell。
      bashShellSelection: input.deps.runtime.getSessionShellSelection(),
      parentSessionId: input.deps.sessionId,
      subagents: { enabled: false },
      taskType: "workflow_child",
      // actor 只存在于一次 run 之下，天然「已激活」（launch.md「On demand: activation」Children 段）：
      // 不继承父会话的按需标志，否则 spread 会把 onDemand 带进来而子会话里没有任何激活入口。
      dynamicWorkflowToolsOnDemand: false,
      toolAllowlist: input.request.opts?.tools,
      workingDirectory: input.deps.workingDirectory,
      ...input.configOverrides,
    },
    {
      ...createRuntimeDeps(input.deps, input.traceContext, input.childSessionId, {
        // 对外交互端口只能由父 runtime 铸造：子会话不是客户端认识的身份。
        // 这里过去直接用 `appOptions.providerRuntimeHeadersPort` /
        // `deps.permissionBroker`，于是 actor 带着 `sess_dwf-…` 去问桌面，桌面
        // `requireSession` 抛错、response 永不发出，子代理在首个模型请求前挂死。
        agentId: input.childSessionId,
        agentType: input.request.opts?.agentType ?? "zcode-workflow",
        childSessionId: input.childSessionId,
        description:
          input.interactionDescription ??
          input.request.opts?.label ??
          input.request.opts?.agentType ??
          "workflow agent",
        ...(input.traceContext.turnId === undefined
          ? {}
          : { parentTurnId: input.traceContext.turnId }),
      }),
      ...(input.browserControlPort === undefined
        ? {}
        : {
            browserControlPort:
              input.browserControlPort.forChildSession?.({
                childSessionId: input.childSessionId,
                parentSessionId: input.deps.sessionId,
              }) ?? input.browserControlPort,
          }),
      ...(input.workflowSubmitPort ? { workflowSubmitPort: input.workflowSubmitPort } : {}),
      ...(input.workflowSubmitPort && input.workflowSubmitSchema
        ? { workflowSubmitSchema: input.workflowSubmitSchema }
        : {}),
      ...(input.workflowEscalatePort ? { workflowEscalatePort: input.workflowEscalatePort } : {}),
      ...(input.webSearchBudget ? { webSearchBudget: input.webSearchBudget } : {}),
      ...(input.modelRequestAdmission
        ? { modelRequestAdmission: input.modelRequestAdmission }
        : {}),
    },
  );
}

function createRuntimeDeps(
  deps: ScriptWorkflowAgentRuntimeDeps,
  traceContext: TraceContext,
  childSessionId: SessionId,
  clientPortsContext: ChildClientPortsContext,
): ConstructorParameters<typeof AgentRuntime>[2] {
  return {
    agentTelemetry: deps.agentTelemetry,
    agentTelemetryCausation: deps.agentTelemetry.captureCausation(),
    // Script workflow child 具有独立生命周期；用 Link 保留发起关系。
    agentTelemetryCausationMode: "linked_root",
    appVersion: deps.appVersion,
    artifactStore: deps.artifactStore,
    contextSourcePort:
      deps.contextSourcePort ??
      deps.appOptions.contextSourcePort ??
      createNodeContextSourceAdapter({ env: deps.appOptions.env }),
    // 直播通道（照 subagent 同款）：原始子会话事件只**通知**父 runtime 的外部 sink 集，
    // 保留子 sessionId 让协议层按 detached live session 路由；父侧不再 append，
    // 所以共享 store 里每条事件恰好一份。
    //
    // 必须在**构造期**装：`ensureSessionPersistedForExternalActivity` 把 SessionTitleUpdated
    // 写成 sequenceNumber 1，而 v4 网关只排水连续 seq——构造之后才挂的订阅从 seq 2 起，
    // 会永远等一个再也不会来的 seq 1（这正是旧 subscribeEvents 通道从未直播成功的原因）。
    eventSink: {
      onSessionEvent: async (event) => {
        await deps.runtime.notifyExternalChildSessionEvent({
          childSessionId,
          event,
          traceContext,
          // 交互事件另镜像到父会话：确认窗只从父会话投影生成（与 createChildClientPorts 同一份
          // 归属，docs/dynamic-workflow/launch.md「Permissions inside a run」）。
          interactionOrigin: clientPortsContext,
        });
      },
    },
    // 与父 runtime 共享 event store：子事件按子自己的 sessionId 落在同一个 store 里，
    // v4 的 `loadPersistedEvents(childSessionId)` 因此命中。私建内存 store 时它永远读不到，
    // transcript 就是永久空白（照 subagent.ts 的 `eventStore: this.eventStore`）。
    eventStore: deps.runtime.getSessionEventStore(),
    executionPort:
      deps.appOptions.executionPort ??
      createNodeExecutionAdapter({
        onToolExecResource: deps.appOptions.onToolExecResource,
        network: {
          httpProxy: deps.configResult.config.network.httpProxy,
          noProxy: deps.configResult.config.network.noProxy,
          caCertFile: deps.configResult.config.network.caCertFile,
        },
        outputRootDir: join(deps.storageRoot, "cli", "exec"),
        bashOutputTempDir: tmpdir(),
        processEnv: deps.appOptions.env ?? process.env,
      }),
    fileSystemPort: deps.appOptions.fileSystemPort ?? createNodeFileSystemAdapter(),
    httpClientPort:
      deps.httpClientPort ??
      deps.appOptions.httpClientPort ??
      createNodeWebFetchHttpClientAdapter({
        env: deps.appOptions.env ?? process.env,
        proxyUrl: deps.configResult.config.network.httpProxy,
        noProxy: deps.configResult.config.network.noProxy,
        caCertFile: deps.configResult.config.network.caCertFile,
        timeoutMs: deps.configResult.config.network.timeout,
      }),
    imageProcessorPort: deps.imageProcessorPort,
    pdfDocumentPort: deps.pdfDocumentPort,
    logger: deps.logger,
    mcpPort: deps.mcpPort,
    modelFactory: deps.modelFactory,
    resolveEffectiveModelSelection: deps.appOptions.resolveEffectiveModelSelection,
    // permissionBroker + providerRuntimeHeadersPort 都在这里面：父 runtime 派生，路由身份已改写成父会话。
    ...deps.runtime.createChildClientPorts(clientPortsContext),
    permissionService: deps.permissionService,
    sessionStore: deps.sessionStore,
    skillPort: createWorkflowChildSkillPort(deps),
    traceContext,
  };
}

/**
 * workflow child 的技能端口：用户配置根 + 插件技能根，禁用路径照主会话。
 *
 * Bug 根因（2026-09-30）：这里原先只带用户配置的 roots，插件技能根是后来才加到主会话那一份上的，
 * child 这边漂掉了——dwf 子代理看不见 browser-use 的 control-browser，只能自己翻插件目录摸索。
 */
export function createWorkflowChildSkillPort(
  deps: Pick<ScriptWorkflowAgentRuntimeDeps, "appOptions" | "configResult" | "pluginSkillRoots">,
): SkillPort | undefined {
  if (!deps.configResult.config.features.skill || !deps.configResult.config.skills.enabled) {
    return undefined;
  }
  return (
    deps.appOptions.skillPort ??
    createNodeSkillAdapter({
      extraRoots: deps.configResult.config.skills.roots,
      extraResolvedRoots: [...deps.pluginSkillRoots],
      // 脚本 workflow child runtime 不能绕过用户禁用的 SKILL.md 路径。
      disabledPaths: collectDisabledPaths(deps.configResult.config.skillOverrides),
    })
  );
}
