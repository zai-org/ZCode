import { toolSearchNameForMode } from "@zcode/contracts";
import { resolveDeferredToolCall } from "../deferred-call.js";
import {
  type AgentTelemetryErrorCategory,
  CoreErrorType,
  HookEventName,
  createChildTraceContext,
  createCoreError,
  createRootTraceContext,
  getCurrentTraceContext,
  traceContextToLogContext,
  type ToolExecutionSpanWriter,
  type SessionEvent,
} from "@zcode/contracts";
import {
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  attestOfficialCuaFrameContent,
  containsOfficialCuaImageRefCredentialText,
} from "@zcode/zcode-cua/frame-contract";
import {
  normalizeToolExecutionInput,
  prepareInitialToolExecutionInput,
} from "../input-normalization.js";
import { hasOfficialCuaFrameAuthority } from "../../mcp/image-normalization.js";
import type { SkillTelemetryMetadata } from "@zcode/contracts";
import type { ToolExecutionContext, ToolExecutionResult } from "../types.js";
import type { ToolEntry } from "../types.js";
import type { BackgroundTaskTracker } from "./background-tasks.js";
import {
  annotateUnsettledCall,
  createErrorResult,
  createPermissionErrorResult,
  createToolHandlerFailureError,
  isToolHandlerFailure,
} from "./errors.js";
import { emitToolCallError, emitToolCallResult, emitToolCallStarted } from "./events.js";
import {
  formatToolHookAdditionalContexts,
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPreToolUseHooks,
} from "./hook-flow.js";
import { resolveToolCallCapabilityFlags } from "./permission-capability.js";
import { resolveToolPermission } from "./permission-flow.js";
import { snapshotPermissionInput } from "./permission-input.js";
import { buildToolInputResolutionContext } from "./permission-input-adjustments.js";
import { createMcpToolDisplay, createToolResultDisplay } from "./result-display.js";
import { serializeOutput } from "./result-serialization.js";
import {
  ToolDeadline,
  executeWithTimeout,
  linkAbortSignal,
  observeToolAdmissionClock,
  resolveTimeoutMs,
} from "./timeout.js";
import { createToolModelStatusSink, withDefaultToolModelStatusSink } from "./model-status-sink.js";
import { runToolCallWithTelemetry } from "./telemetry.js";
import {
  withAutomationCreateLimitTurnStop,
  withPlanExitDeniedTurnStop,
  withTerminalToolTurnStop,
  withWorkflowRefineDeniedFollowUp,
} from "./turn-control.js";
import { mergeToolExecutionTelemetry, readToolExecutionTelemetry } from "../handlers/tool-perf.js";
import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";
import { validateInitialModelToolInput, validateInput, validateOutput } from "./validation.js";
import type { ExecutableToolCall } from "../types.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import { resolveToolEntryModelContract } from "../model-contract.js";

const UNDISCOVERED_TOOL_SCHEMA_EXPLANATION =
  "\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. " +
  "Without the schema in your prompt, typed parameters (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. ";

export async function executeToolCall(
  deps: ToolExecutorDeps,
  backgroundTasks: BackgroundTaskTracker,
  toolCall: ExecutableToolCall,
  options?: ToolExecuteOptions,
): Promise<ToolExecutionResult> {
  const admission = resolveDeferredToolCall(toolCall, options?.toolSearch, deps.registry);
  if (admission.error) {
    const result = createErrorResult(admission.call, admission.error);
    await emitToolCallError(
      deps,
      toolCall.id,
      options?.traceContext ??
        deps.traceContext ??
        createRootTraceContext({ sessionId: deps.sessionId, turnId: deps.turnId }),
      deps.turnId,
      result.error,
    );
    return result;
  }
  // 历史只保存一份原始目标参数；执行/Hook 可修改的对象在执行入口独立复制。
  toolCall = admission.call.modelCallWrapper
    ? { ...admission.call, input: structuredClone(admission.call.input) }
    : admission.call;
  const totalStartedAt = Date.now();
  const entry = isEmptyToolName(toolCall.name) ? undefined : deps.registry.get(toolCall.name);
  const canonicalToolCall =
    entry && toolCall.name !== entry.metadata.name
      ? { ...toolCall, name: entry.metadata.name }
      : toolCall;
  // 隐私与基数边界：未注册工具名来自模型输出，不能假定是受控枚举。
  // 业务错误仍保留真实名称供模型自修复，远端 Trace 统一落入固定 unknown 桶。
  const telemetryToolCall = entry ? canonicalToolCall : { ...toolCall, name: "unknown" };
  return runToolCallWithTelemetry(deps, telemetryToolCall, options, (telemetry) =>
    executeToolCallImpl(deps, backgroundTasks, toolCall, totalStartedAt, options, telemetry),
  );
}

async function executeToolCallImpl(
  deps: ToolExecutorDeps,
  backgroundTasks: BackgroundTaskTracker,
  toolCall: ExecutableToolCall,
  totalStartedAt: number,
  options?: ToolExecuteOptions,
  telemetry?: ToolExecutionSpanWriter,
): Promise<ToolExecutionResult> {
  const parentTraceContext =
    options?.traceContext ??
    getCurrentTraceContext() ??
    deps.traceContext ??
    createRootTraceContext({ sessionId: deps.sessionId, turnId: deps.turnId });
  const emptyToolName = isEmptyToolName(toolCall.name);
  const registeredEntry = emptyToolName ? undefined : deps.registry.get(toolCall.name);
  const model = options?.model ?? deps.model;
  const entry = registeredEntry
    ? resolveToolEntryModelContract(registeredEntry, {
        model,
      })
    : undefined;
  const pluginId = entry?.metadata.mcpPresentation?.pluginId;
  const canonicalToolCall =
    entry && toolCall.name !== entry.metadata.name
      ? { ...toolCall, name: entry.metadata.name }
      : toolCall;
  const traceContext = createChildTraceContext(parentTraceContext, {
    sessionId: deps.sessionId,
    turnId: deps.turnId,
    attributes: {
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    },
  });
  const traceId = traceContext.traceId;
  const turnId = traceContext.turnId ?? deps.turnId;

  if (!entry) {
    const result = createErrorResult(
      toolCall,
      createCoreError(
        CoreErrorType.ToolNotFound,
        emptyToolName
          ? "Model returned an invalid tool call: tool name is empty."
          : `Tool not found: ${toolCall.name}`,
        {
          context: { toolCallId: toolCall.id, toolName: toolCall.name },
          recoverable: false,
        },
      ),
    );
    // 空名在 admission 阶段停止会让模型永远收不到配对结果。复用
    // registry-miss 生命周期，provider 内容严格保留模型返回的原始名称（含空白名称）。
    // 修复原因：非空的未知工具名只发 `Tool not found: X` 时没有 tool_use_error 包装。
    result.modelContent = `<tool_use_error>Error: No such tool available: ${toolCall.name}</tool_use_error>`;
    // registry miss 发生在 handler/ToolCallStarted 之前；旧代码只把失败
    // 返回给 provider，没有发布 ToolCallError，V4 tool row 因而永久停在 inputStreaming。
    await emitToolCallError(
      deps,
      toolCall.id,
      traceContext,
      turnId,
      result.error,
      undefined,
      pluginId,
    );
    deps.logger?.warn("Tool call rejected because the tool is not registered", {
      ...traceContextToLogContext(traceContext),
      event: "tool.call.not_found",
      module: "core.tool.executor",
      status: "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    telemetry?.finishFailed("lookup", "configuration", result.error);
    return result;
  }

  let lifetime: ReturnType<NonNullable<ToolEntry["retainExecution"]>> | undefined;
  try {
    lifetime = entry.retainExecution?.(canonicalToolCall.id);
  } catch (error) {
    const result = createErrorResult(
      canonicalToolCall,
      createCoreError(
        CoreErrorType.ToolCancelled,
        error instanceof Error ? error.message : "Tool instance is unavailable",
      ),
    );
    await emitToolCallError(
      deps,
      canonicalToolCall.id,
      traceContext,
      turnId,
      result.error,
      undefined,
      pluginId,
    );
    return result;
  }
  if (lifetime)
    options = {
      ...options,
      signal: options?.signal
        ? AbortSignal.any([options.signal, lifetime.signal])
        : lifetime.signal,
    };
  try {
    const mode = deps.getMode();

    if (options?.signal?.aborted) {
      const result = createErrorResult(
        canonicalToolCall,
        createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled"),
      );
      telemetry?.finishCancelled("abort_signal");
      return result;
    }

    const preparedInitialInput = prepareInitialToolExecutionInput({
      entry,
      input: canonicalToolCall.input,
      logger: deps.logger,
    });
    let executionInput = preparedInitialInput.input;
    const initialInputValidation = validateInitialModelToolInput(
      executionInput,
      entry,
      preparedInitialInput.runtimeValidationIssues,
    );
    if (initialInputValidation) {
      const result = createErrorResult(canonicalToolCall, initialInputValidation);
      const search = options?.toolSearch;
      // 延迟 schema 未加载只提供纠错提示，不增加工具执行拒绝条件。
      if (
        search?.enabled &&
        !search.discovered.has(canonicalToolCall.name) &&
        search.catalog.some((tool) => tool.name === canonicalToolCall.name && tool.deferred)
      ) {
        // 原提示省略了类型退化原因；完整解释与 schema 一并提供，避免只引导盲目重试。
        result.modelContent =
          (result.modelContent ?? initialInputValidation.message) +
          UNDISCOVERED_TOOL_SCHEMA_EXPLANATION +
          `Load the tool first: call ${toolSearchNameForMode(search.mode)} with query "select:${canonicalToolCall.name}", then retry this call. ` +
          `For reference, this tool's input schema is: ${JSON.stringify(entry.inputSchema)}` +
          (search.mode === "local"
            ? `\nCall DeferredToolCall with {name: "${canonicalToolCall.name}", input: {...}}.`
            : "");
      }
      // schema 失败与 registry miss 同属 handler/ToolCallStarted 之前的早退；旧代码
      // 只把失败回灌模型，没有发布 ToolCallError，V4 tool row 因而在整个 turn 里停在
      // inputStreaming（CreateWorkflow 卡持续显示「正在编写工作流」），模型重试后又叠一张。
      await emitToolCallError(
        deps,
        canonicalToolCall.id,
        traceContext,
        turnId,
        result.error,
        undefined,
        pluginId,
      );
      telemetry?.finishFailed("validation", "parse", result.error);
      return result;
    }

    const toolInputValidation = entry.validateInput?.(executionInput, {
      runtimeTaskRegistry: deps.runtimeTaskRegistry,
    });
    if (toolInputValidation && isToolHandlerFailure(toolInputValidation)) {
      // tool-specific 语义校验原先只能放在 handler，导致无效调用仍先执行
      // PreToolUse、权限和 failure hook；语义校验必须在 hook 前结束。
      const result = createErrorResult(
        canonicalToolCall,
        createToolHandlerFailureError(canonicalToolCall, toolInputValidation),
      );
      await emitToolCallError(
        deps,
        canonicalToolCall.id,
        traceContext,
        turnId,
        result.error,
        undefined,
        pluginId,
      );
      // 工具专属校验以普通失败结果返回，不走 handler 执行的 try/catch 失败收口。
      // 先发出 ToolCallError 更新工具行，再显式标记遥测失败，避免被记录为 abandoned。
      telemetry?.finishFailed("validation", "parse", result.error);
      return result;
    }

    // 归一化：把模型发出的入参换成「将要发生的执行事实」。位置刻意在 hook **之前**——此后
    // hook、权限规则、确认窗载荷、prepareApproval 与 handler 读的都是同一份输入，于是
    // 「策略看得到真正的脚本」「跨版本可见」「确认与执行同字节」三件事一次到位。
    if (entry.resolveInput) {
      const resolution = await entry.resolveInput(
        executionInput,
        buildToolInputResolutionContext(deps),
      );
      if (isToolHandlerFailure(resolution)) {
        // 与 validateInput 同一条生命周期出口：解析不出来是模型该立刻拿回去修的东西，
        // 不该先弹一次注定失败的确认窗。
        const result = createErrorResult(
          canonicalToolCall,
          createToolHandlerFailureError(canonicalToolCall, resolution),
        );
        await emitToolCallError(
          deps,
          canonicalToolCall.id,
          traceContext,
          turnId,
          result.error,
          undefined,
          pluginId,
        );
        telemetry?.finishFailed("validation", "parse", result.error);
        return result;
      }
      executionInput = resolution.input;
    }

    const preToolHookResult = await runPreToolUseHooks(
      deps,
      canonicalToolCall,
      executionInput,
      entry,
      mode,
      traceContext,
      options?.signal,
    );
    // 在各出口按需格式化：成功路径要先做凭据过滤再格式化（见下）；超长 context 会落盘，提前算好会多写一次文件。
    const formatPreToolHookContexts = () =>
      formatToolHookAdditionalContexts(
        deps,
        HookEventName.PreToolUse,
        canonicalToolCall,
        preToolHookResult.additionalContexts,
        traceContext,
      );
    // 成功路径已过滤、已格式化的 Pre 上下文；之后再抛错时 catch 复用它。
    let formattedSafePreContexts: string[] | undefined;
    if (preToolHookResult.permissionBehavior === "deny" || preToolHookResult.preventContinuation) {
      const result = withHookAdditionalContexts(
        withPlanExitDeniedTurnStop(
          createPermissionErrorResult(
            canonicalToolCall,
            preToolHookResult.hookPermissionDecisionReason ??
              preToolHookResult.stopReason ??
              "Blocked by PreToolUse hook",
            {
              decision: "deny",
              mode,
              reason:
                preToolHookResult.hookPermissionDecisionReason ?? preToolHookResult.stopReason,
              source: "hook.PreToolUse",
            },
          ),
          {
            mode,
            planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
            toolName: canonicalToolCall.name,
          },
        ),
        await formatPreToolHookContexts(),
      );
      telemetry?.setPermissionDecision("denied");
      telemetry?.finishDenied("policy_denied");
      return result;
    }
    if (preToolHookResult.updatedInput !== undefined) {
      executionInput = normalizeToolExecutionInput({
        entry,
        input: preToolHookResult.updatedInput,
        logger: deps.logger,
        source: "hook",
      });
      const hookInputValidation = validateInput(executionInput, entry);
      if (hookInputValidation) {
        // Hook 修改后的输入校验失败会在 handler 前直接返回，旧分支没有带上
        // PreToolUse context，导致模型只看到 schema error，看不到 Hook
        // 已产生的诊断上下文；与 deny、permission-deny 的提前失败契约不一致。
        const result = withHookAdditionalContexts(
          createErrorResult(canonicalToolCall, hookInputValidation),
          await formatPreToolHookContexts(),
        );
        telemetry?.finishFailed("validation", "parse", result.error);
        return result;
      }
    }

    // Shell 已由 session owner 固定；匹配和执行复用同一选择，不为不存在的热切换再建快照。
    const bashShellSelection = deps.getBashShellSelection?.() ?? deps.bashShellSelection;
    const guardedWorkingDirectory = mode === "guarded" ? deps.getWorkingDirectory() : undefined;
    if (mode === "guarded") executionInput = snapshotPermissionInput(executionInput);
    const permissionResult = await resolveToolPermission(
      deps,
      canonicalToolCall,
      entry,
      executionInput,
      preToolHookResult,
      mode,
      traceContext,
      options?.signal,
      telemetry,
      {
        mode,
        bashShellSelection,
        ...(guardedWorkingDirectory === undefined
          ? {}
          : { workingDirectory: guardedWorkingDirectory }),
      },
    );
    if (!permissionResult.allowed) {
      const result = withHookAdditionalContexts(
        withWorkflowRefineDeniedFollowUp(
          withPlanExitDeniedTurnStop(permissionResult.result, {
            mode,
            planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
            toolName: canonicalToolCall.name,
          }),
          { toolName: canonicalToolCall.name },
        ),
        await formatPreToolHookContexts(),
      );
      if (result.error?.type === CoreErrorType.PermissionDenied) {
        telemetry?.finishDenied("user_denied");
      } else {
        telemetry?.finishFailed(
          "permission",
          errorCategoryForToolError(result.error?.type),
          result.error,
        );
      }
      return result;
    }
    executionInput = permissionResult.executionInput;
    const permissionWaitMs = permissionResult.permissionWaitMs;
    const inputAdjustments = permissionResult.inputAdjustments;

    const startTime = Date.now();
    // 按**执行入参**解析一次副作用旗标（Bash 的只读命令判定就在这里落定），随 ToolCallStarted 发出：
    // 事件先于 handler，所以订阅者（dynamic-workflow driver 的导入缓存关门）在第一个字节落盘前就知道。
    await emitToolCallStarted(
      deps,
      canonicalToolCall,
      traceContext,
      turnId,
      startTime,
      createMcpToolDisplay(entry.metadata.mcpPresentation),
      resolveToolCallCapabilityFlags(deps, entry, executionInput),
    );

    deps.logger?.info("Tool call started", {
      ...traceContextToLogContext(traceContext),
      event: "tool.call.started",
      module: "core.tool.executor",
      status: "started",
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    });

    const timeoutMs = resolveTimeoutMs(entry, executionInput, deps.defaultTimeoutMs, {
      model,
    });
    const executionAbortController = new AbortController();
    const unlinkParentAbort = linkAbortSignal(options?.signal, executionAbortController);
    // 可暂停的 deadline：本次调用内部的模型请求在准入闸门前排队时暂停计时。排队的两端
    // 以本 toolCallId 的 ModelNetworkStatus 会话事件到达，所以在事件出口拦一层即可，handler 无感。
    const deadline = new ToolDeadline(timeoutMs);
    const emitEvent =
      deps.emitEvent === undefined
        ? undefined
        : async (event: SessionEvent): Promise<void> => {
            observeToolAdmissionClock(event, canonicalToolCall.id, deadline);
            await deps.emitEvent(event);
          };
    let readFileStateMetadata: ToolExecutionResult["readFileStateMetadata"];
    let skillTelemetryMetadata: SkillTelemetryMetadata | undefined;
    let failureStage: "handler" | "serialize" | "post_hook" = "handler";

    try {
      const model = options?.model ?? deps.model;
      const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
        bashAvailable: deps.registry.has("Bash"),
      });
      const context: ToolExecutionContext = {
        toolCallId: canonicalToolCall.id,
        toolSearch: options?.toolSearch,
        telemetry,
        logger: deps.logger,
        automationTurn: options?.automationTurn,
        automationId: options?.automationId,
        offPeakTurn: options?.offPeakTurn,
        traceContext,
        traceId,
        spanId: traceContext.spanId,
        parentSpanId: traceContext.parentSpanId,
        abortSignal: executionAbortController.signal,
        backgroundTaskControlPort: deps.backgroundTaskControlPort,
        emitEvent,
        executionPort: deps.executionPort,
        browserControlPort: deps.browserControlPort,
        browserDocumentationRoot: deps.browserDocumentationRoot,
        fileSystemPort: deps.fileSystemPort,
        httpClientPort: deps.httpClientPort,
        imageProcessorPort: deps.imageProcessorPort,
        pdfDocumentPort: deps.pdfDocumentPort,
        // 工具内部的模型请求默认把状态事件发进会话：deadline 暂停与 driver 相位都靠这条流。
        model: withDefaultToolModelStatusSink(
          model,
          createToolModelStatusSink({ emitEvent, sessionId: deps.sessionId, turnId, traceId }),
        ),
        subagentModelOverride: options?.subagentModelOverride,
        embeddedSearch: {
          ...(deps.embeddedSearchBackend ? { backend: deps.embeddedSearchBackend } : {}),
          enabled: embeddedSearchDecision?.useEmbeddedSearchBranch ?? false,
          ...(deps.nativeSearchEnhancementsEnabled === false ? { findAndGrepEnabled: false } : {}),
        },
        skillPort: deps.skillPort,
        subagentPort: deps.subagentPort,
        coordinatorResponsePort: deps.coordinatorResponsePort,
        workflowSubmitPort: deps.workflowSubmitPort,
        workflowEscalatePort: deps.workflowEscalatePort,
        webSearchBudget: deps.webSearchBudget,
        artifactStore: deps.artifactStore,
        sessionControl: deps.sessionControl,
        automationPort: deps.automationPort,
        offPeakPort: deps.offPeakPort,
        pluginDiscoveryPort: options?.pluginDiscoveryUi ? deps.pluginDiscoveryPort : undefined,
        topicResourcePort: deps.topicResourcePort,
        sessionStore: deps.sessionStore,
        sessionModePort: deps.sessionModePort,
        workflowPort: deps.workflowPort,
        dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort,
        dynamicWorkflowSnippetPort: deps.dynamicWorkflowSnippetPort,
        modelCatalogPort: deps.modelCatalogPort,
        runtimeTaskRegistry: deps.runtimeTaskRegistry,
        readFileState: deps.readFileState,
        recordReadFileStateMetadata: (metadata) => {
          // 修复原因：part 在工具开始前按声明顺序落盘、完成时原地更新；工具结果返回的先后也不等于
          // 写入先后（handler 写入之后还有序列化、hook、结果事件等异步步骤）。冷恢复按这两种顺序重放
          // 快照，并行工具会选错视图。工具写 live 状态后同步调用这里，此刻取号就是 live 的写入顺序。
          readFileStateMetadata = {
            ...metadata,
            snapshotIndex: deps.nextReadFileStateSnapshotIndex(),
          };
        },
        recordSkillTelemetryMetadata: (metadata) => {
          skillTelemetryMetadata = metadata;
        },
        bashShellSelection,
        setWorkingDirectory: deps.setWorkingDirectory,
        workingDirectory: guardedWorkingDirectory ?? deps.getWorkingDirectory(),
        workspaceRoot: deps.getWorkspaceRoot(),
        workspaceIdentity: deps.workspaceIdentity,
        workspaceKey: deps.workspaceKey,
        remoteSessionId: deps.remoteSessionId,
        clientMode: deps.clientMode,
        deliveryKind: deps.deliveryKind,
        memoryRoot: deps.getMemoryRoot?.(),
        runtimeScope: deps.runtimeScope,
        providerVisibleToolNames: deps.registry
          .list()
          .filter((name) => deps.registry.getMetadata(name)?.providerVisible !== false),
        sessionId: deps.sessionId,
        turnId,
        ...(inputAdjustments === undefined ? {} : { inputAdjustments }),
      };

      const output = await executeWithTimeout(
        entry.handler,
        executionInput,
        context,
        deadline,
        executionAbortController,
        entry,
      );
      const durationMs = Date.now() - startTime;
      if (isToolHandlerFailure(output)) {
        // handler 用返回值表达可预期业务失败；这里只转换到既有异常控制流，
        // 继续复用原来的 failure hook、事件和日志，不引入第二套执行生命周期。
        throw createToolHandlerFailureError(canonicalToolCall, output);
      }
      validateOutput(output, entry);
      // node_repl 同时承载 Browser Use 与 CUA，不能在注册时把整个 server 标成 official。
      // CUA SDK 结果带 producer integrity metadata 时，才为本次序列化临时打开原子帧保护；
      // 否则通用 resultBudget 会截断/重排 image_ref，或非 authority 路径会把引用剥掉。
      const modelOutputEntry = resolveModelOutputEntry(entry, output);
      failureStage = "serialize";
      let serialization = await serializeOutput(
        deps,
        output,
        modelOutputEntry,
        traceContext,
        canonicalToolCall.id,
        executionAbortController.signal,
      );
      failureStage = "post_hook";
      const postToolHookResult = await runPostToolUseHooks(
        deps,
        canonicalToolCall,
        executionInput,
        output,
        serialization.artifactPath,
        traceContext,
        options?.signal,
      );
      // 修复原因：Hook 文本原来拼进 tool result、占用它的预算；现在 tool result 只放工具原文，
      // Hook 文本由结算写成这批结果之后的附件。
      // 官方 CUA 帧的 image_ref 凭据不能经 Hook 文本进入模型上下文：去掉这类 context 并按截断记账。
      const isCredentialSafe = (context: string) =>
        modelOutputEntry.modelContentProtection !== OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION ||
        !containsOfficialCuaImageRefCredentialText(context);
      const safePreContexts = preToolHookResult.additionalContexts.filter(isCredentialSafe);
      const safePostContexts = postToolHookResult.additionalContexts.filter(isCredentialSafe);
      if (
        safePreContexts.length < preToolHookResult.additionalContexts.length ||
        safePostContexts.length < postToolHookResult.additionalContexts.length
      ) {
        serialization = { ...serialization, truncated: true };
      }
      formattedSafePreContexts = await formatToolHookAdditionalContexts(
        deps,
        HookEventName.PreToolUse,
        canonicalToolCall,
        safePreContexts,
        traceContext,
      );
      const hookAdditionalContexts = [
        ...formattedSafePreContexts,
        ...(await formatToolHookAdditionalContexts(
          deps,
          HookEventName.PostToolUse,
          canonicalToolCall,
          safePostContexts,
          traceContext,
        )),
      ];
      const display = createToolResultDisplay(canonicalToolCall.name, output, {
        mcp: entry.metadata.mcpPresentation,
        officialCua: entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
      });
      const perf = mergeToolExecutionTelemetry(readToolExecutionTelemetry(output), {
        permissionWaitMs,
        // totalMs 是用户感知的工具生命周期：registry lookup、校验、Hook、权限等待、
        // handler、序列化与 PostToolUse。durationMs 继续只表示 handler 主执行段。
        totalMs: Date.now() - totalStartedAt,
      });

      const finalModelContent = serialization.modelContent ?? serialization.content;
      const modelContentProtection = modelOutputEntry.modelContentProtection
        ? attestOfficialCuaFrameContent(finalModelContent, modelOutputEntry.modelContentProtection)
        : undefined;
      if (
        modelOutputEntry.modelContentProtection &&
        Array.isArray(finalModelContent) &&
        finalModelContent.some((block) => block.type === "image") &&
        !modelContentProtection
      ) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          "Official CUA frame failed final model-content attestation",
          { recoverable: true },
        );
      }

      const result: ToolExecutionResult = withTerminalToolTurnStop(
        {
          toolCallId: canonicalToolCall.id,
          toolName: canonicalToolCall.name,
          success: true,
          output,
          display,
          modelContent: finalModelContent,
          ...(hookAdditionalContexts.length > 0 ? { hookAdditionalContexts } : {}),
          ...(readFileStateMetadata ? { readFileStateMetadata } : {}),
          performance: perf,
          serialization,
          durationMs,
          startedAt: new Date(startTime),
          completedAt: new Date(),
        },
        { entry },
      );

      await emitToolCallResult(
        deps,
        canonicalToolCall,
        traceContext,
        turnId,
        serialization,
        durationMs,
        display,
        perf,
        skillTelemetryMetadata,
        pluginId,
      );

      await backgroundTasks.trackBackgroundTask(canonicalToolCall, output, traceContext, turnId);

      deps.logger?.info("Tool call completed", {
        ...traceContextToLogContext(traceContext),
        durationMs,
        event: "tool.call.completed",
        module: "core.tool.executor",
        status: "completed",
        toolCallId: canonicalToolCall.id,
        toolName: canonicalToolCall.name,
      });

      telemetry?.setOutputBytes(serialization.returnedBytes);
      telemetry?.setOutputTruncated(serialization.truncated);
      telemetry?.finishCompleted();
      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const failureHookResult = await runPostToolUseFailureHooks(
        deps,
        canonicalToolCall,
        executionInput,
        error,
        traceContext,
        options?.signal,
      );
      // 修复原因：Hook 文本原来以 UI 摘要为底拼进失败结果，有 Hook 与没有 Hook 时模型看到的
      // 错误不同。现在 tool result 只放 createErrorResult 的原文，Hook 文本另成附件。
      // 规格 0.15：超时与执行中取消会在「请求可能已被受理」之后打断 handler，回执送不回来；
      // 让工具把对账身份追加进同一条错误，否则模型只能另起新请求、重复执行。
      const failure = annotateUnsettledCall(
        error instanceof Error ? error : new Error(String(error)),
        entry ?? {},
        executionInput,
        canonicalToolCall.id,
      );
      // 修复原因：同步子代理失败时父模型只收到 provider 原文，拿不到续接用的 agentId。
      // 工具补充的文本只接在模型可见原文之后；UI 摘要、错误事件和日志都不变。
      const errorResult = createErrorResult(canonicalToolCall, failure, durationMs, {
        modelNote: entry?.formatErrorModelContent?.(error),
      });
      let result = withHookAdditionalContexts(errorResult, [
        // 修复原因：成功路径格式化之后再抛错（例如官方 CUA 帧校验失败、写结果事件失败）时，
        // 重新格式化会用未过滤的上下文，把被过滤的凭据送进附件，超长上下文还会再落盘一次。
        ...(formattedSafePreContexts ?? (await formatPreToolHookContexts())),
        ...(await formatToolHookAdditionalContexts(
          deps,
          HookEventName.PostToolUseFailure,
          canonicalToolCall,
          failureHookResult.additionalContexts,
          traceContext,
        )),
      ]);
      result = withAutomationCreateLimitTurnStop(result, {
        error,
        toolName: canonicalToolCall.name,
      });

      // Skill 已解析成功后，serialize/post_hook 仍可能失败；错误事件也要保留
      // resolved metadata，否则失败的 Skill agent_step 无法归因到具体 skill。
      await emitToolCallError(
        deps,
        canonicalToolCall.id,
        traceContext,
        turnId,
        result.error,
        skillTelemetryMetadata,
        pluginId,
      );

      deps.logger?.error(
        "Tool call failed",
        error instanceof Error ? error : new Error(String(error)),
        {
          ...traceContextToLogContext(traceContext),
          durationMs,
          event: "tool.call.failed",
          module: "core.tool.executor",
          status: "failed",
          toolCallId: canonicalToolCall.id,
          toolName: canonicalToolCall.name,
        },
      );

      if (options?.signal?.aborted || result.error?.type === CoreErrorType.ToolCancelled) {
        telemetry?.finishCancelled("abort_signal");
      } else {
        telemetry?.finishFailed(
          failureStage,
          errorCategoryForToolError(result.error?.type),
          // 原始异常只交给 Telemetry 做受控脱敏；result.error 是面向业务协议重新包装后的错误，
          // 不能覆盖 Trace 中用于定位根因的 source message/type/code。
          error,
        );
      }
      return result;
    } finally {
      unlinkParentAbort();
    }
  } finally {
    lifetime?.release();
  }
}

function resolveModelOutputEntry(entry: ToolEntry, output: unknown): ToolEntry {
  const isSharedNodeRepl =
    entry.metadata.name === "mcp__node_repl__js" ||
    entry.metadata.mcpPresentation?.serverName === "node_repl";
  if (
    entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION ||
    !isSharedNodeRepl ||
    !hasOfficialCuaFrameAuthority(output)
  ) {
    return entry;
  }
  return {
    ...entry,
    modelContentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    resultBudget: {
      ...entry.resultBudget,
      maxInlineBytes: Math.max(entry.resultBudget.maxInlineBytes, 256 * 1024),
      maxModelBytes: Math.max(entry.resultBudget.maxModelBytes, 256 * 1024),
      strategy: "truncate",
      preview: { direction: "head" },
    },
  };
}

function isEmptyToolName(toolName: string): boolean {
  return toolName.trim().length === 0;
}

function errorCategoryForToolError(type: string | undefined): AgentTelemetryErrorCategory {
  switch (type) {
    case CoreErrorType.ConfigurationError:
    case CoreErrorType.ToolNotFound:
      return "configuration";
    case CoreErrorType.PermissionDenied:
    case CoreErrorType.PermissionEscalation:
    case CoreErrorType.PermissionTimeout:
      return "permission";
    case CoreErrorType.InvalidInput:
      return "parse";
    case CoreErrorType.ToolCancelled:
      return "cancelled";
    case CoreErrorType.ToolTimeout:
      return "timeout";
    default:
      return "internal";
  }
}

/**
 * 成功、失败与提前返回的失败（PreToolUse 拒绝、Hook 改写后校验失败、权限拒绝）都带上 Hook context。
 * PreToolUse deny 和权限拒绝会在 handler 前提前返回，旧逻辑只在 handler 的成功/异常路径带 context，
 * 导致 Hook 明明返回了 additionalContext，模型却看不到。
 */
function withHookAdditionalContexts(
  result: ToolExecutionResult,
  hookAdditionalContexts: readonly string[],
): ToolExecutionResult {
  if (hookAdditionalContexts.length === 0) return result;
  return { ...result, hookAdditionalContexts: [...hookAdditionalContexts] };
}
