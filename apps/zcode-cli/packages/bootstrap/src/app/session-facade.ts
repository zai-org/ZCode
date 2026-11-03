import { updateUiLocaleInFileConfig, type ConfigResult } from "@zcode/adapters/config";
import {
  McpResourceSubscribeUnsupportedError,
  resolveMcpToolVisibility,
  SESSION_ENTRY_MODEL_SELECTION,
  traceContextToLogContext,
  type CollaborationMode,
  type ExecutionPort,
  type GoalStatus,
  type LocalSettingStorePort,
  type Logger,
  type LoggerFactory,
  type McpPort,
  type McpServerConfig,
  type MessageId,
  type ProjectId,
  type SessionId,
  type SessionStorePort,
  type SupportedLocale,
  type TraceContext,
  type TurnInputIntentMetadata,
  type UiLocale,
  type UiThemePreference,
} from "@zcode/contracts";
import {
  createMcpAppProvidedToolEntry,
  createMcpToolEntry,
  toMcpToolName,
  type AgentRuntime,
} from "@zcode/core";
import { resolveLocale } from "@zcode/i18n";
import { normalizeModelSelection, type ModelSelection } from "@zcode/provider";
import { listMcpServerStatuses } from "../mcp-config.js";
import { loadSessionTranscriptFromStore } from "../session-transcript.js";
import { getLocaleConfigPath } from "./locale-selection.js";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";
import {
  completeAuxiliaryRegistryModelSelection,
  getRegistryBackedModel,
  listRegistryBackedModels,
  requireRegistryThoughtLevel,
  resolveRegistryModelSelection,
  resolveRegistryOwnedModelSelection,
  resolveRegistryOwnedSelection,
  resolveRegistryThoughtLevel,
  type ResolvedRegistrySelection,
} from "./provider-registry-selection.js";
import { isClosableSessionStore } from "./session-store.js";
import { createSubagentObservation } from "./subagent-observation.js";
import type { PrepareUserExecutionBoundary, ZCodeApp } from "./types.js";
import type { CliDefaultSelection } from "./cli-default-selection.js";

type SessionFacade = Pick<
  ZCodeApp,
  | "readBackgroundBashOutput"
  | "cancelBackgroundTask"
  | "clearTarget"
  | "close"
  | "callMcpToolForUi"
  | "getMcpAppConnectionSnapshot"
  | "waitForMcpAppConnection"
  | "onMcpAppConnectionInvalidated"
  | "replaceMcpAppProvidedTools"
  | "connectMcpServer"
  | "disconnectMcpServer"
  | "generateWorkspaceText"
  | "sampleModel"
  | "testModelConnectivity"
  | "forkFromCheckpoint"
  | "getMode"
  | "getModel"
  | "getCurrentModelOption"
  | "getModelOption"
  | "getLocale"
  | "getDefaultThoughtLevel"
  | "getThoughtLevel"
  | "getTheme"
  | "listCheckpoints"
  | "listMcpServers"
  | "getMcpToolVisibility"
  | "listModels"
  | "listThoughtLevels"
  | "loadSessionTranscript"
  | "readMcpResource"
  | "readMcpResourceForUi"
  | "listMcpResourcesForUi"
  | "listMcpResourceTemplatesForUi"
  | "subscribeMcpResourceForUi"
  | "unsubscribeMcpResourceForUi"
  | "unsubscribeMcpResourcesForUi"
  | "readSubagents"
  | "readSubagentTranscript"
  | "readTodos"
  | "readTarget"
  | "setCustomSessionTitle"
  | "setMode"
  | "setModel"
  | "setThoughtLevel"
  | "setLocale"
  | "setTarget"
  | "updateTargetStatus"
>;

interface SessionResourceCloseInput {
  beginShutdown: () => void;
  closeBrowserSession: () => Promise<void>;
  closeExecution?: () => Promise<void> | void;
  closeMcp?: () => Promise<void> | void;
  closeNodeReplBrowserBroker?: () => Promise<void> | void;
  closeSessionStore?: () => void;
  logger: Logger;
}

interface CreateSessionFacadeDeps {
  cliDefaultSelection?: CliDefaultSelection;
  /**
   * 停下本会话拥有的 dwf run：
   * run service 的 `close()`。缺席即本装配没有 dwf 端口（journal 窄化失败、测试装配）。
   */
  closeDynamicWorkflowRuns?: () => Promise<void>;
  closeScriptWorkflowRuns?: () => Promise<void>;
  closeNodeReplBrowserBroker?: () => Promise<void> | undefined;
  configResult: ConfigResult;
  configuredMcpServers: Record<string, McpServerConfig>;
  configuredDefaultModelSelection?: ModelSelection;
  executionPort: ExecutionPort;
  localSettingStore?: LocalSettingStorePort;
  logger: Logger;
  loggerFactory: LoggerFactory;
  mcpPort?: McpPort;
  ownsExecutionPort: boolean;
  ownsMcpPort: boolean;
  ownsSessionStore: boolean;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  prepareResume(traceContext?: TraceContext): Promise<void>;
  projectID: ProjectId;
  providerRegistry: ProviderRegistryModelSource;
  resolveUiLocale(locale: UiLocale): SupportedLocale;
  runtime: AgentRuntime;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  traceContext: TraceContext;
  untrustedProjectMcpServers: Set<string>;
  workingDirectory: string;
}

export function createSessionFacade(deps: CreateSessionFacadeDeps): SessionFacade {
  let closePromise: Promise<void> | undefined;
  let currentLocale = resolveLocale(deps.configResult.config.ui.locale);
  // App-Provided Tools：本会话当前登记在 ToolRegistry 里的模型侧名字（整体替换时先注销）。
  let appProvidedToolNames: string[] = [];
  const currentRegistrySelection = ():
    | { owned: false }
    | {
        owned: true;
        registry: ProviderRegistryModelSource;
        selection?: ResolvedRegistrySelection;
      } => {
    const registry = deps.providerRegistry;
    const selection = readUserModelSelection(deps);
    if (!selection) return { owned: false };
    const { providerId } = selection;
    if (!registry.getProvider(providerId)) return { owned: false };
    const resolved = resolveRegistryModelSelection(registry, selection);
    return resolved ? { owned: true, registry, selection: resolved } : { owned: true, registry };
  };

  const readTargetWithInterruptedRunRecovery = async () => {
    const target = await deps.sessionStore.readTarget({
      sessionID: deps.sessionId,
    });
    if (
      !deps.runtime.getActiveTurnInfo() &&
      target?.activeInputId &&
      target.activeRunStartedAtMs != null &&
      deps.sessionStore.recoverInterruptedTargetRun
    ) {
      // 上次 app/agent 退出可能留下未清空的 active_run_started_at。
      // 这里不能用当前时间结算，否则离线时间会被算进 goal 运行时长；store 会用 last_seen 收口。
      return await deps.sessionStore.recoverInterruptedTargetRun({
        sessionID: deps.sessionId,
      });
    }
    return target;
  };

  const setTargetStatus = async (
    action: "cleared" | "set" | "status_updated",
    input: {
      objective?: string;
      displayText?: string;
      status?: GoalStatus;
      tokenBudget?: number | null;
      intent?: TurnInputIntentMetadata;
    },
  ) => {
    const visibleObjective = action === "set" ? (input.objective ?? "").trim() : undefined;
    const visibleGoalQuery =
      action === "set" ? input.displayText?.trim() || visibleObjective : undefined;
    // /goal 不走普通 prompt 提交流程，但它会先把 session 持久化。
    // 必须在首次持久化前走统一用户执行边界，否则 runtime/bash_shell_selection
    // 会因为当时 selection 为空而缺失，冷恢复时退回 legacy shell fallback。
    await deps.prepareUserExecutionBoundary({
      traceContext: deps.traceContext,
    });
    await deps.runtime.ensureSessionPersistedForExternalActivity(
      visibleObjective ?? `/goal ${input.status ?? "clear"}`,
      { traceContext: deps.traceContext },
    );
    const previousTarget = await deps.sessionStore.readTarget({
      sessionID: deps.sessionId,
    });
    const target =
      action === "set"
        ? await deps.sessionStore.setTarget({
            objective: visibleObjective ?? "",
            sessionID: deps.sessionId,
            status: input.status,
            tokenBudget: input.tokenBudget,
          })
        : action === "status_updated"
          ? await deps.sessionStore.updateTargetStatus({
              sessionID: deps.sessionId,
              status: input.status ?? "active",
            })
          : null;

    if (action === "cleared") {
      const cleared = await deps.sessionStore.clearTarget({
        sessionID: deps.sessionId,
      });
      if (cleared) {
        await deps.runtime.recordGoalStateChangeReminder({
          text: goalStateChangeReminderText("cleared"),
          traceContext: deps.traceContext,
        });
      }
      // TUI 和协议客户端可能在重连或恢复后仍缓存旧 goal。
      // 即使 session store 已经是空，也要把显式 clear 投影成 target:null，
      // 让客户端不能只因为“No goal to clear.”这条文本而继续保留旧面板。
      await deps.runtime.recordTargetChanged({
        action,
        previousTarget,
        source: "command",
        target,
        traceContext: deps.traceContext,
      });
      return cleared;
    }
    if (target) {
      if (visibleObjective !== undefined) {
        // /goal 同时是控制命令和用户 query。旧路径只把解析后的 objective
        // 落库，且 live 事件里没有这条输入；因此首轮实时列表为空，冷恢复后也丢失
        // `/goal` / `/target` / `replace` 原文。target 继续存 canonical objective，
        // 可见消息单独保留协议层传入的原始 display text。
        await deps.runtime.recordExternalUserPrompt(visibleGoalQuery ?? visibleObjective, {
          goalSummaryTargetID: target.targetID,
          intent: input.intent,
          traceContext: deps.traceContext,
        });
      }
      const reminderAction =
        input.status === "paused" && previousTarget?.status !== "paused"
          ? "paused"
          : input.status === "active" && previousTarget?.status === "paused"
            ? "resumed"
            : undefined;
      const reminderText = goalStateChangeReminderText(reminderAction);
      if (reminderText) {
        await deps.runtime.recordGoalStateChangeReminder({
          text: reminderText,
          traceContext: deps.traceContext,
        });
      }
      await deps.runtime.recordTargetChanged({
        action,
        previousTarget,
        source: "command",
        target,
        traceContext: deps.traceContext,
      });
    }
    return target;
  };

  return {
    close: async () => {
      // close 的结果必须代表真实完成；调用方等待超时不能让生命周期永久误判 faulted。
      // 先登记 Promise 再执行 shutdown 回调，保证同步重入也只关闭一次。
      closePromise ??= Promise.resolve().then(async () => {
        // 关闭入口先阻止新调度并取消在飞 Memory Extraction，再等待取消链路收口。
        const errors: unknown[] = [];
        deps.runtime.beginShutdown();
        const owners: Array<[string, (() => Promise<void>) | undefined]> = [
          ["runtime_work", () => deps.runtime.closeOwnedWork()],
          ["dynamic_workflow", deps.closeDynamicWorkflowRuns],
          ["script_workflow", deps.closeScriptWorkflowRuns],
        ];
        // 所属工作实际收口后才释放依赖资源；进程退出预算由外层进程 owner 负责。
        const closed = await closeNamedResources(owners, deps.logger);
        for (const result of closed) if (result.status === "rejected") errors.push(result.reason);
        const closableSessionStore =
          deps.ownsSessionStore && isClosableSessionStore(deps.sessionStore)
            ? deps.sessionStore
            : undefined;
        try {
          await closeSessionResources({
            beginShutdown: () => deps.runtime.beginShutdown(),
            closeBrowserSession: () => deps.runtime.closeBrowserSession(),
            closeExecution:
              deps.ownsExecutionPort && deps.executionPort.close
                ? () => deps.executionPort.close?.()
                : undefined,
            closeMcp: deps.ownsMcpPort && deps.mcpPort ? () => deps.mcpPort?.close() : undefined,
            closeNodeReplBrowserBroker: deps.closeNodeReplBrowserBroker,
            closeSessionStore: closableSessionStore
              ? () => closableSessionStore.close()
              : undefined,
            logger: deps.logger,
          });
        } catch (error) {
          errors.push(error);
        }
        if (errors.length)
          throw new AggregateError(
            errors,
            `Session shutdown failed: ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")}`,
          );
      });
      return await closePromise;
    },
    getMode: () => deps.runtime.getMode(),
    getModel: () => formatLegacyRuntimeModelValue(readUserModelSelection(deps)),
    getLocale: () => currentLocale,
    getTheme: () => deps.configResult.config.ui.theme as UiThemePreference,
    getDefaultThoughtLevel: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? resolveRegistryThoughtLevel(registryState.selection)
        : readUserModelSelection(deps)?.options?.reasoningLevel;
    },
    // 当前档位只读会话事实；缺失时不能借默认档位伪装成已完成选择。
    getThoughtLevel: () => readUserModelSelection(deps)?.options?.reasoningLevel,
    loadSessionTranscript: async () =>
      await loadSessionTranscriptFromStore({
        sessionId: deps.sessionId,
        sessionStore: deps.sessionStore,
      }),
    ...createSubagentObservation(deps),
    readTodos: async () => deps.sessionStore.readTodos({ sessionID: deps.sessionId }),
    readTarget: readTargetWithInterruptedRunRecovery,
    setCustomSessionTitle: async (input) =>
      deps.runtime.setCustomSessionTitle({
        title: input.title,
        traceContext: input.traceContext ?? deps.traceContext,
      }),
    setTarget: async (input) =>
      (await setTargetStatus("set", input)) as Awaited<ReturnType<ZCodeApp["setTarget"]>>,
    updateTargetStatus: async (status) =>
      (await setTargetStatus("status_updated", { status })) as Awaited<
        ReturnType<ZCodeApp["updateTargetStatus"]>
      >,
    clearTarget: async () => (await setTargetStatus("cleared", {})) as boolean,
    listModels: () => {
      return listRegistryBackedModels(deps.providerRegistry);
    },
    getCurrentModelOption: () => {
      const selection = readUserModelSelection(deps);
      return selection && getRegistryBackedModel(deps.providerRegistry, selection);
    },
    getModelOption: (selection) => getRegistryBackedModel(deps.providerRegistry, selection),
    listThoughtLevels: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? [...(registryState.selection?.model.config.optionSpecs.reasoningLevel.values ?? [])]
        : [];
    },
    listMcpServers: async () =>
      listMcpServerStatuses(
        deps.mcpPort,
        deps.configuredMcpServers,
        deps.untrustedProjectMcpServers,
      ),
    connectMcpServer: async (name) => {
      const config = deps.configuredMcpServers[name];
      if (!config) {
        throw new Error(`MCP server is not configured: ${name}`);
      }
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      return deps.mcpPort.connectServer(name, config, {
        trace: deps.traceContext,
        workingDirectory: deps.workingDirectory,
      });
    },
    readMcpResource: async (serverName, uri, options) => {
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      if (!deps.mcpPort.readResource) {
        throw new Error("MCP resources are not supported by this runtime");
      }
      return deps.mcpPort.readResource(
        { serverName, uri, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    readMcpResourceForUi: async (serverName, uri, options) => {
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      if (!deps.mcpPort.readResource) {
        throw new Error("MCP resources are not supported by this runtime");
      }
      return deps.mcpPort.readResource(
        { serverName, uri, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    listMcpResourcesForUi: async (serverName, cursor, options) => {
      if (!deps.mcpPort) throw new Error("MCP is disabled");
      if (!deps.mcpPort.listResources) {
        throw new McpResourceSubscribeUnsupportedError(serverName);
      }
      return deps.mcpPort.listResources(
        { serverName, ...(cursor ? { cursor } : {}), trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    listMcpResourceTemplatesForUi: async (serverName, cursor, options) => {
      if (!deps.mcpPort) throw new Error("MCP is disabled");
      if (!deps.mcpPort.listResourceTemplates) {
        throw new McpResourceSubscribeUnsupportedError(serverName);
      }
      return deps.mcpPort.listResourceTemplates(
        { serverName, ...(cursor ? { cursor } : {}), trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    subscribeMcpResourceForUi: async (serverName, uri, subscriberKey, options) => {
      if (!deps.mcpPort) throw new Error("MCP is disabled");
      if (!deps.mcpPort.subscribeResource) {
        throw new McpResourceSubscribeUnsupportedError(serverName);
      }
      await deps.mcpPort.subscribeResource(
        { serverName, uri, subscriberKey, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    unsubscribeMcpResourceForUi: async (serverName, uri, subscriberKey, options) => {
      if (!deps.mcpPort?.unsubscribeResource) return;
      await deps.mcpPort.unsubscribeResource(
        { serverName, uri, subscriberKey, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    unsubscribeMcpResourcesForUi: async (subscriberKeyPrefix) => {
      if (!deps.mcpPort?.unsubscribeResourcesBySubscriber) return 0;
      return deps.mcpPort.unsubscribeResourcesBySubscriber(subscriberKeyPrefix);
    },
    onMcpAppConnectionInvalidated: (name, listener) =>
      deps.mcpPort?.onAppConnectionInvalidated?.(name, listener) ?? (() => {}),
    getMcpAppConnectionSnapshot: (name) => deps.mcpPort?.appConnectionSnapshot?.(name) ?? null,
    waitForMcpAppConnection: async (name) =>
      deps.mcpPort?.waitForAppConnection
        ? deps.mcpPort.waitForAppConnection(name)
        : (deps.mcpPort?.appConnectionSnapshot?.(name) ?? null),
    callMcpToolForUi: async (serverName, toolName, args, options) => {
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      const snapshot = deps.mcpPort.appConnectionSnapshot?.(serverName);
      if (!snapshot) throw new Error("MCP App connection is unavailable");
      const descriptor = (await deps.mcpPort.listTools()).find(
        (tool) => tool.serverName === serverName && tool.toolName === toolName,
      );
      if (!descriptor || !resolveMcpToolVisibility(descriptor).includes("app"))
        throw new Error("Tool is not available to this App");
      const registry = deps.runtime.getToolRegistry();
      const registered = registry
        .list()
        .map((name) => registry.get(name))
        .find(
          (entry) =>
            entry?.metadata.mcpPresentation?.serverName === serverName &&
            entry.metadata.mcpPresentation.toolName === toolName,
        );
      const entry =
        registered ??
        createMcpToolEntry(toMcpToolName(descriptor), descriptor, deps.mcpPort, false);
      const executor = deps.runtime.getToolExecutor();
      if (!executor.authorizeAppTool) throw new Error("MCP App host authorization is unavailable");
      const input = await executor.authorizeAppTool(
        { id: crypto.randomUUID(), name: entry.metadata.name, input: args ?? {} },
        entry,
        { signal: options?.signal, traceContext: deps.traceContext },
      );
      // 审批期间连接可能被替换：批准只属于原连接，执行前必须再次验证。
      options?.signal?.throwIfAborted();
      const current = deps.mcpPort.appConnectionSnapshot?.(serverName);
      if (
        !current ||
        current.identity !== snapshot.identity ||
        current.generation !== snapshot.generation
      )
        throw new Error("MCP App connection changed during authorization");
      return deps.mcpPort.callTool(
        {
          serverName,
          toolName,
          arguments: input as Record<string, unknown>,
          trace: deps.traceContext,
          runtimeScope: "main",
        },
        { signal: options?.signal, appConnection: snapshot },
      );
    },
    replaceMcpAppProvidedTools: (definitions, execute) => {
      const registry = deps.runtime.getToolRegistry();
      for (const name of appProvidedToolNames) registry.unregister(name);
      const registered: string[] = [];
      for (const definition of definitions) {
        // 不覆盖内置 / MCP 工具：`app__` 前缀本不该冲突，冲突时以既有工具为准。
        if (registry.has(definition.modelName) || registered.includes(definition.modelName))
          continue;
        registry.register(createMcpAppProvidedToolEntry(definition, execute), {
          silentDuplicateWarning: true,
        });
        registered.push(definition.modelName);
      }
      appProvidedToolNames = registered;
      // 同回合下一次模型请求即可见：只是让 getTools 重建缓存；工具集合没变时发给模型的内容也不变。
      deps.runtime.invalidateToolCache();
      return registered;
    },
    getMcpToolVisibility: async (serverName, toolName) => {
      if (!deps.mcpPort) return null;
      // 真相是 adapter 归一化过的 descriptor（同一份 tools/list），不另存副本。
      const descriptor = (await deps.mcpPort.listTools()).find(
        (tool) => tool.serverName === serverName && tool.toolName === toolName,
      );
      return descriptor ? resolveMcpToolVisibility(descriptor) : null;
    },
    readBackgroundBashOutput: (workId, sessionId) =>
      deps.runtime.readBackgroundBashOutput(workId, sessionId),
    cancelBackgroundTask: async (taskId, options) =>
      deps.runtime.cancelBackgroundTask(taskId, {
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    disconnectMcpServer: async (name) => {
      if (!deps.mcpPort) return undefined;
      return deps.mcpPort.disconnectServer(name);
    },
    listCheckpoints: async (options) => {
      await deps.prepareResume();
      return deps.runtime.listWorkspaceCheckpoints(options);
    },
    forkFromCheckpoint: async (options) => {
      await deps.prepareResume(options?.traceContext);
      return deps.runtime.forkWorkspaceFromCheckpoint({
        targetCheckpointId: options?.targetCheckpointId,
        targetMessageId: options?.targetMessageId as MessageId | undefined,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    sampleModel: (input, options) =>
      deps.runtime.sampleModel(input, {
        ...options,
        traceContext: options.traceContext ?? deps.traceContext,
      }),
    generateWorkspaceText: async (input, options) => {
      // 辅助文本入口只规范化模型身份；具体的最低档位由 Core 的辅助请求调用点显式决定。
      const selection =
        normalizeModelSelection(deps.providerRegistry.getView(), input.selection) ??
        input.selection;
      return await deps.runtime.generateWorkspaceText(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
    testModelConnectivity: async (input, options) => {
      // 连接测试用的 Model 也要先绑定最低档位，否则严格 Factory 会先因缺档位失败。
      const selection = completeAuxiliaryRegistryModelSelection(
        deps.providerRegistry,
        input.selection,
      );
      await deps.runtime.testModelConnectivity(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
    setMode: async (mode: CollaborationMode) => {
      const previousMode = deps.runtime.getMode();
      const session = await deps.sessionStore.getSession(deps.sessionId);
      // 群模式属于任务授权；不能写入工作区默认模式，让其他群或私聊继承。
      if (session?.permission?.scope === "session") {
        await deps.sessionStore.updateSession({
          id: deps.sessionId,
          permission: { ...session.permission, mode },
        });
      }
      await deps.runtime.setExecutionState({ mode }, deps.traceContext);
      if (deps.localSettingStore && session?.permission?.scope !== "session") {
        try {
          await deps.localSettingStore.saveProjectPermissionMode({
            mode: deps.runtime.getMode(),
            projectID: deps.projectID,
          });
        } catch (error) {
          deps.logger.warn("Project mode preference write failed", {
            ...traceContextToLogContext(deps.traceContext),
            error: error instanceof Error ? error.message : String(error),
            event: "local_setting.permission_mode.write_failed",
            mode,
            module: "bootstrap",
            projectId: deps.projectID,
            status: "failed",
          });
        }
      }
      deps.logger.info("Session mode updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.mode.updated",
        mode,
        module: "bootstrap",
        previousMode,
        status: "completed",
      });
      return {
        mode: deps.runtime.getMode(),
        previousMode,
        traceId: deps.traceContext.traceId,
      };
    },
    setModel: async (modelId, options) => {
      // 配置命令已提交完整 Selection；转成字符串会丢档位。先整体校验再一次
      // 更新/保存，非法档位不能留下已换模型的半次修改。旧字符串入口保留只改身份语义。
      const registrySelection =
        typeof modelId === "string"
          ? resolveRegistryOwnedSelection(
              deps.providerRegistry,
              modelId,
              deps.configuredDefaultModelSelection,
              { allowMissingReasoning: true },
            )
          : resolveRegistryOwnedModelSelection(deps.providerRegistry, modelId);
      if (!registrySelection) {
        throw new Error(`Provider Registry 中不存在 Model: ${modelId}`);
      }
      const previousSelection = readUserModelSelection(deps);
      const previousModel = formatLegacyRuntimeModelValue(previousSelection);
      const model = formatLegacyRuntimeModelValue(registrySelection.selection);
      const sessionSelection: ModelSelection = {
        providerId: registrySelection.selection.providerId,
        modelId: registrySelection.selection.modelId,
        ...(typeof modelId !== "string" && registrySelection.selection.options
          ? { options: { ...registrySelection.selection.options } }
          : {}),
      };
      if (deps.cliDefaultSelection && !options?.transient) {
        deps.cliDefaultSelection.set(sessionSelection);
      } else {
        deps.runtime.setSessionModelSelection(sessionSelection);
      }
      // transient 切换不产出 modelChange 聊天通知：应用/还原成对出现会刷出两条无意义通知。
      if (!options?.transient) {
        deps.runtime.recordPendingModelChange({
          fromModel: previousSelection,
          fromModelLabel: previousModel,
          toModel: sessionSelection,
          toModelLabel: model,
        });
        await persistSessionModelSelection(deps);
      }
      deps.logger.info("Session model updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.model.updated",
        model,
        module: "bootstrap",
        previousModel,
        status: "completed",
      });
      return {
        model,
        previousModel,
        traceId: deps.traceContext.traceId,
      };
    },
    setThoughtLevel: async (level) => {
      const registryState = currentRegistrySelection();
      if (registryState.owned) {
        const currentSelection = readUserModelSelection(deps);
        if (!currentSelection) throw new Error("Select a model before choosing reasoning effort");
        const registrySelection =
          registryState.selection ??
          resolveRegistryOwnedModelSelection(registryState.registry, {
            providerId: currentSelection.providerId,
            modelId: currentSelection.modelId,
          })!;
        const previousThoughtLevel = resolveRegistryThoughtLevel(
          registrySelection,
          currentSelection.options?.reasoningLevel,
        );
        const thoughtLevel = requireRegistryThoughtLevel(registrySelection, level);
        const nextSelection = {
          ...currentSelection,
          options: {
            ...currentSelection.options,
            reasoningLevel: thoughtLevel,
          },
        };
        if (deps.cliDefaultSelection) deps.cliDefaultSelection.set(nextSelection);
        else deps.runtime.setSessionModelSelection(nextSelection);
        await persistSessionModelSelection(deps);
        deps.logger.info("Session reasoning effort updated", {
          ...traceContextToLogContext(deps.traceContext),
          event: "session.reasoning_effort.updated",
          module: "bootstrap",
          previousThoughtLevel,
          status: "completed",
          thoughtLevel,
        });
        return {
          previousThoughtLevel,
          thoughtLevel,
          traceId: deps.traceContext.traceId,
        };
      }
      throw new Error("当前 Session Model 不属于 Provider Registry");
    },
    setLocale: async (locale) => {
      const previousLocale = currentLocale;
      const configPath = getLocaleConfigPath(deps.configResult);
      const persisted = await updateUiLocaleInFileConfig(configPath, locale);
      currentLocale = deps.resolveUiLocale(locale);
      deps.configResult.config.ui.locale = currentLocale;
      deps.logger.info("Session locale updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.locale.updated",
        locale: currentLocale,
        module: "bootstrap",
        previousLocale,
        requestedLocale: locale,
        status: "completed",
      });
      return {
        configPath: persisted.path,
        locale: currentLocale,
        previousLocale,
        requestedLocale: locale,
        traceId: deps.traceContext.traceId,
      };
    },
  };
}

/** 慢关闭只提供诊断；不能用超时结果替代资源的真实完成。 */
async function closeNamedResources(
  resources: Array<[string, (() => Promise<void> | void) | undefined]>,
  logger: Logger,
): Promise<PromiseSettledResult<void>[]> {
  const pending = new Set(resources.filter(([, close]) => close).map(([name]) => name));
  const slow = setTimeout(() => {
    if (pending.size)
      logger.warn("Session resources are still closing", {
        event: "session.resource_close.slow",
        pendingResources: [...pending],
        elapsedMs: 30_000,
      });
  }, 30_000);
  slow.unref();
  try {
    return await Promise.allSettled(
      resources.flatMap(([name, close]) =>
        close
          ? [
              Promise.resolve()
                .then(close)
                .catch((cause: unknown) => {
                  logger.warn("Session resource close failed", {
                    event: "session.resource_close.failed",
                    resource: name,
                    error: cause instanceof Error ? cause.message : String(cause),
                  });
                  throw new Error(
                    `${name}: ${cause instanceof Error ? cause.message : String(cause)}`,
                    { cause },
                  );
                })
                .finally(() => pending.delete(name)),
            ]
          : [],
      ),
    );
  } finally {
    clearTimeout(slow);
  }
}

export async function closeSessionResources(input: SessionResourceCloseInput): Promise<void> {
  const errors: unknown[] = [];
  try {
    // 第一拍先关闭 runtime admission；后续 execution cancel 只能收口状态，不能再唤醒模型。
    input.beginShutdown();
  } catch (error) {
    errors.push(error);
    input.logger.warn("Failed to begin runtime shutdown", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.shutdown_admission.failed",
    });
  }

  const resources: Array<[name: string, close: (() => Promise<void> | void) | undefined]> = [
    ["browser_session", input.closeBrowserSession],
    ["execution", input.closeExecution],
    ["mcp", input.closeMcp],
    ["node_repl_browser_broker", input.closeNodeReplBrowserBroker],
  ];

  // 独立资源并行释放；外部超时不能让仍在收尾的借用者碰到已关闭的 store。
  const completion = (async () => {
    const results = await closeNamedResources(resources, input.logger);
    for (const result of results) if (result.status === "rejected") errors.push(result.reason);
    try {
      input.closeSessionStore?.();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        `Session resources could not be safely released: ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")}`,
      );
  })();
  return completion;
}

async function persistSessionModelSelection(deps: CreateSessionFacadeDeps): Promise<void> {
  if (!deps.sessionStore.saveSessionEntry) return;
  const selection = readUserModelSelection(deps);
  if (!selection) return;
  const timestamp = Date.now();
  try {
    await deps.sessionStore.saveSessionEntry({
      id: `${deps.sessionId}:runtime-model-selection`,
      sessionID: deps.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      // 模型与思考档位是 session-local 原子选型；切换后立即落同一稳定 entry，
      // 不必等下一条消息，也不会在冷恢复时读取 workspace/draft 的全局最新选择。
      // 同时配置补写不代表用户新活动，不能触发 session.time_updated 变成“刚刚”。
      data: {
        modelId: selection.modelId,
        providerId: selection.providerId,
        ...(selection.options ? { options: selection.options } : {}),
      },
    });
  } catch (error) {
    const logContext = {
      ...traceContextToLogContext(deps.traceContext),
      error: error instanceof Error ? error.message : String(error),
      modelId: selection.modelId,
      module: "bootstrap",
      providerId: selection.providerId,
      thoughtLevel: selection.options?.reasoningLevel,
    };
    // Bug 原因（ZCT-2109847556412547072）：App 在 deferred 会话首条消息前设置选型/档位时，
    // session 行尚未创建，entry 写入必然报 FOREIGN KEY，却以 warn 进入生产日志，误导排查。
    // 首次持久化（ensureSessionPersisted）会以当时的 Session Selection 补写同一 entry，
    // 所以仅在会话仍未持久化时降为 debug。仍先尝试写入而不是预先跳过：若首次持久化正在进行，
    // 预判跳过会漏写比其读取更晚的选择。
    if (!deps.runtime.isSessionPersisted()) {
      deps.logger.debug("Session model selection persistence deferred until session is persisted", {
        ...logContext,
        event: "session.model_selection.persist_deferred",
        status: "waiting",
      });
      return;
    }
    // 选型已经在当前 runtime 生效；持久化失败不能反向伪装成切换失败，但必须留生产日志。
    deps.logger.warn("Session model selection persistence failed", {
      ...logContext,
      event: "session.model_selection.persist_failed",
      status: "failed",
    });
  }
}

/** 仅供仍以 provider/model 字符串工作的内部 App facade；不是 ModelSelection 序列化。 */
function formatLegacyRuntimeModelValue(selection: ModelSelection | undefined): string {
  return selection ? `${selection.providerId}/${selection.modelId}` : "";
}

type GoalStateChangeReminderAction = "paused" | "resumed" | "cleared";

function goalStateChangeReminderText(action: GoalStateChangeReminderAction): string;
function goalStateChangeReminderText(action: undefined): undefined;
function goalStateChangeReminderText(
  action: GoalStateChangeReminderAction | undefined,
): string | undefined;
function goalStateChangeReminderText(
  action: GoalStateChangeReminderAction | undefined,
): string | undefined {
  switch (action) {
    case "paused":
      return "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.";
    case "resumed":
      return "The session goal is active again and will be pursued.";
    case "cleared":
      return "The session goal has been cleared. Do not continue pursuing any previous goal unless the user sets a new goal.";
    default:
      return undefined;
  }
}

function readUserModelSelection(deps: CreateSessionFacadeDeps): ModelSelection | undefined {
  return deps.cliDefaultSelection
    ? deps.cliDefaultSelection.get()
    : deps.runtime.getSessionModelSelection();
}
