import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import type { ConfigResult } from "@zcode/adapters/config";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import {
  createNodeWorkflowDefinitionStore,
  createNodeWorkflowStore,
} from "@zcode/adapters/workflow";
import {
  AgentRuntime,
  ExpertWorkflowRuntime,
  createExpertWorkflowDefinition,
  type AgentRuntimeConfig,
  type AgentRuntimeDeps,
  type PermissionService,
  type WorkflowAgentRunner,
} from "@zcode/core";
import {
  type AgentExecutionTelemetryPort,
  createChildTraceContext,
  createSessionId,
  type ContextSourcePort,
  type ExecutionPort,
  type FileSystemPort,
  type HttpClientPort,
  type ImageProcessorPort,
  type PdfDocumentPort,
  type Logger,
  type SessionEventSink,
  type SessionId,
  type SessionStorePort,
  type ToolArtifactStorePort,
  type TraceContext,
  type WorkflowDefinition,
} from "@zcode/contracts";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import type { PrepareUserExecutionBoundary, ZCodeAppOptions } from "./types.js";
import { createWorkflowMethods, type WorkflowFacade } from "./workflow-methods.js";

interface CreateWorkflowFacadeDeps {
  agentTelemetry: AgentExecutionTelemetryPort;
  appOptions: ZCodeAppOptions;
  appVersion: string;
  artifactStore?: ToolArtifactStorePort;
  cliStorageRoot: string;
  configResult: ConfigResult;
  contextSourcePort?: ContextSourcePort;
  eventSink?: SessionEventSink;
  executionPort?: ExecutionPort;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  logger: Logger;
  /** 父会话的 model factory（与 script-workflow-child-runtime.ts 同一约定）。 */
  modelFactory: NonNullable<AgentRuntimeDeps["modelFactory"]>;
  permissionService: PermissionService;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  runtime: AgentRuntime;
  runtimeConfig: AgentRuntimeConfig;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  storageRoot: string;
  traceContext: TraceContext;
  workingDirectory: string;
}

export function createWorkflowFacade(deps: CreateWorkflowFacadeDeps): WorkflowFacade {
  const workflowStore = createNodeWorkflowStore({
    rootDir: join(deps.cliStorageRoot, "workflows"),
  });
  const workflowDefinitionStore = createNodeWorkflowDefinitionStore({
    rootDir: join(deps.cliStorageRoot, "workflows"),
  });
  const builtInExpertWorkflowDefinition = createExpertWorkflowDefinition();
  const workflowRuntimeCache = new Map<string, ExpertWorkflowRuntime>();
  const workflowAgentRunner: WorkflowAgentRunner = {
    run: async (request) => {
      await deps.prepareUserExecutionBoundary({ traceContext: request.traceContext });
      const workflowKind = request.workflowKind ?? builtInExpertWorkflowDefinition.kind;
      const childSessionId = createSessionId(`workflow_${request.activityId}`);
      const parentTraceContext = request.traceContext ?? deps.traceContext;
      const childTraceContext = createChildTraceContext(parentTraceContext, {
        attributes: {
          parentSessionId: deps.sessionId,
          workflowActivityId: request.activityId,
          workflowKind,
          workflowPhase: request.phase,
          workflowRunId: request.runId,
        },
        sessionId: childSessionId,
        rootSessionId: parentTraceContext.rootSessionId ?? deps.sessionId,
      });
      const parentSelection = deps.runtime.getSessionModelSelection();
      await request.onChildSessionStarted?.({
        model: parentSelection
          ? `${parentSelection.providerId}/${parentSelection.modelId}`
          : undefined,
        sessionId: childSessionId,
        traceId: childTraceContext.traceId,
      });
      const childRuntime = await createWorkflowChildRuntime(deps, {
        childSessionId,
        childTraceContext,
        workflowKind,
      });
      const unsubscribe = request.onEvent
        ? childRuntime.subscribeEvents({ onSessionEvent: request.onEvent })
        : undefined;

      try {
        const result = await childRuntime.executeTurn(request.prompt, undefined, {
          abortSignal: request.abortSignal,
          inputSource: "subagent",
          traceContext: childTraceContext,
        });
        const childSelection = childRuntime.getSessionModelSelection();
        return {
          model: childSelection
            ? `${childSelection.providerId}/${childSelection.modelId}`
            : undefined,
          response: result.response,
          sessionId: childSessionId,
          traceId: result.traceId,
          turnId: result.turnId,
        };
      } finally {
        unsubscribe?.();
      }
    },
  };

  const resolveWorkflowDefinition = async (input?: {
    definitionId?: string;
    workflowKind?: string;
  }): Promise<WorkflowDefinition> => {
    const requestedKind = input?.workflowKind ?? builtInExpertWorkflowDefinition.kind;
    const requestedDefinitionId = input?.definitionId;
    if (!requestedDefinitionId && requestedKind === builtInExpertWorkflowDefinition.kind) {
      return builtInExpertWorkflowDefinition;
    }

    const lookupId = requestedDefinitionId ?? requestedKind;
    const definition = await workflowDefinitionStore.readDefinition(lookupId);
    if (!definition) {
      throw new Error(`Workflow definition not found: ${lookupId}`);
    }
    if (input?.workflowKind && definition.kind !== input.workflowKind) {
      throw new Error(
        `Workflow definition ${definition.definitionId} has kind ${definition.kind}, expected ${input.workflowKind}`,
      );
    }
    return definition;
  };

  const workflowRuntimeForDefinition = (definition: WorkflowDefinition): ExpertWorkflowRuntime => {
    const cacheKey = [definition.definitionId, definition.definitionVersion, definition.kind].join(
      ":",
    );
    const cached = workflowRuntimeCache.get(cacheKey);
    if (cached) return cached;
    const runtimeForDefinition = new ExpertWorkflowRuntime({
      agentRunner: workflowAgentRunner,
      definition,
      onWorkflowEvent: deps.appOptions.onWorkflowEvent,
      store: workflowStore,
    });
    workflowRuntimeCache.set(cacheKey, runtimeForDefinition);
    return runtimeForDefinition;
  };

  const workflowRuntimeForRequest = async (input?: {
    definitionId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowRuntime> =>
    workflowRuntimeForDefinition(await resolveWorkflowDefinition(input));

  const workflowRuntimeForLookup = async (input?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowRuntime> => {
    if (input?.runId) {
      const snapshot = await workflowStore.readRun(input.runId, { signal: input.abortSignal });
      if (snapshot) {
        if (
          snapshot.kind === builtInExpertWorkflowDefinition.kind &&
          (snapshot.definitionId === undefined ||
            snapshot.definitionId === builtInExpertWorkflowDefinition.definitionId)
        ) {
          return workflowRuntimeForDefinition(builtInExpertWorkflowDefinition);
        }
        return workflowRuntimeForDefinition(
          await resolveWorkflowDefinition({
            definitionId: snapshot.definitionId,
            workflowKind: snapshot.kind,
          }),
        );
      }
    }
    return workflowRuntimeForRequest({
      definitionId: input?.definitionId,
      workflowKind: input?.workflowKind,
    });
  };

  const listWorkflowRuns: NonNullable<WorkflowFacade["listWorkflows"]> = async (options) => {
    let workflowKind = options?.workflowKind;
    if (options?.definitionId) {
      const definition = await resolveWorkflowDefinition({
        definitionId: options.definitionId,
        workflowKind,
      });
      workflowKind = definition.kind;
    }
    return workflowStore.listRuns(
      { cwd: deps.workingDirectory, kind: workflowKind, limit: options?.limit },
      { signal: options?.abortSignal },
    );
  };

  const workflowExternalActivityPrompt = (definition: WorkflowDefinition, task: string): string =>
    definition.kind === builtInExpertWorkflowDefinition.kind
      ? `/expert ${task}`
      : `/workflow ${definition.kind} ${task}`;

  const switchWorkflowToYolo = (): void => {
    if (deps.runtime.getMode() !== "yolo" && deps.runtime.getMode() !== "guarded") {
      deps.runtime.updateConfig({ mode: "yolo" });
    }
  };

  const createStartInput = async (
    input: { definitionId?: string; task: string; workflowKind?: string },
    defaultKind?: string,
  ) => {
    const definition = await resolveWorkflowDefinition({
      definitionId: input.definitionId,
      workflowKind: input.workflowKind ?? defaultKind,
    });
    const workflow = workflowRuntimeForDefinition(definition);
    return { definition, workflow };
  };

  const persistWorkflowActivity = async (
    definition: WorkflowDefinition,
    task: string,
    traceContext: TraceContext,
  ): Promise<void> => {
    await deps.runtime.ensureSessionPersistedForExternalActivity(
      workflowExternalActivityPrompt(definition, task),
      { traceContext },
    );
  };

  return createWorkflowMethods({
    builtInExpertWorkflowDefinition,
    createStartInput,
    listWorkflowRuns,
    prepareUserExecutionBoundary: deps.prepareUserExecutionBoundary,
    persistWorkflowActivity,
    sessionId: deps.sessionId,
    switchWorkflowToYolo,
    traceContext: deps.traceContext,
    workflowRuntimeForLookup,
    workingDirectory: deps.workingDirectory,
  });
}

async function createWorkflowChildRuntime(
  deps: CreateWorkflowFacadeDeps,
  options: {
    childSessionId: SessionId;
    childTraceContext: TraceContext;
    workflowKind: string;
  },
): Promise<AgentRuntime> {
  const childMcp = await deps.runtime.createChildMcpAccess();
  return new AgentRuntime(
    options.childSessionId,
    {
      ...deps.runtimeConfig,
      mcp: childMcp.config,
      agentName: options.workflowKind === "expert" ? "zcode-expert" : "zcode-workflow",
      // workflow child 不在 Guarded 合同内；只隔离父任务模式，不继承审批。
      mode: "yolo",
      modelSelection: deps.runtime.getSessionModelSelection(),
      // 父 Shell 在首条输入才解析，不能继承 app 创建时尚未初始化的静态配置。
      bashShellSelection: deps.runtime.getSessionShellSelection(),
      parentSessionId: deps.sessionId,
      taskType: "workflow_child",
      workingDirectory: deps.workingDirectory,
    },
    {
      agentTelemetry: deps.agentTelemetry,
      agentTelemetryCausation: deps.agentTelemetry.captureCausation(),
      // Workflow 在父工具返回后独立调度，不能伪装成父 Span 的同步 Child。
      agentTelemetryCausationMode: "linked_root",
      eventStore: createInMemorySessionEventStore(),
      sessionStore: deps.sessionStore,
      logger: deps.logger,
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
        deps.appOptions.httpClientPort ??
        createNodeWebFetchHttpClientAdapter({
          env: deps.appOptions.env ?? process.env,
          timeoutMs: deps.configResult.config.network.timeout,
          proxyUrl: deps.configResult.config.network.httpProxy,
          noProxy: deps.configResult.config.network.noProxy,
          caCertFile: deps.configResult.config.network.caCertFile,
        }),
      imageProcessorPort: deps.imageProcessorPort,
      pdfDocumentPort: deps.pdfDocumentPort,
      artifactStore: deps.artifactStore,
      contextSourcePort:
        deps.appOptions.contextSourcePort ??
        createNodeContextSourceAdapter({ env: deps.appOptions.env }),
      skillPort:
        deps.configResult.config.features.skill && deps.configResult.config.skills.enabled
          ? (deps.appOptions.skillPort ??
            createNodeSkillAdapter({
              extraRoots: deps.configResult.config.skills.roots,
              // workflow 子 agent 复用同一套 skill 发现逻辑，也必须继承主配置里的禁用路径。
              disabledPaths: collectDisabledPaths(deps.configResult.config.skillOverrides),
            }))
          : undefined,
      ...childMcp.deps,
      eventSink: deps.eventSink,
      modelFactory: deps.modelFactory,
      resolveEffectiveModelSelection: deps.appOptions.resolveEffectiveModelSelection,
      // 对外交互端口由父 runtime 派生（permissionBroker + providerRuntimeHeadersPort）：
      // 子会话不是协议客户端认识的身份，直接透传 appOptions 的端口会让反向请求发到一个
      // 客户端找不到的 session 上、response 永不回来。
      ...deps.runtime.createChildClientPorts({
        agentId: options.childSessionId,
        agentType: options.workflowKind === "expert" ? "zcode-expert" : "zcode-workflow",
        childSessionId: options.childSessionId,
        description: `${options.workflowKind} workflow agent`,
        ...(options.childTraceContext.turnId === undefined
          ? {}
          : { parentTurnId: options.childTraceContext.turnId }),
      }),
      permissionService: deps.permissionService,
      appVersion: deps.appVersion,
      traceContext: options.childTraceContext,
    },
  );
}
