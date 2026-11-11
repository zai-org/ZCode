/* eslint-disable max-lines -- subagent runtime wiring 集中衔接 child runtime、tool pool、权限、MCP 与 activity watchdog，拆分需单独迁移。 */
import {
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  SESSION_ENTRY_MODEL_SELECTION,
  parseModelSelectionValue,
} from "@zcode/contracts";
import type { CollaborationMode, SubagentRunOptions, WorkspaceId } from "@zcode/contracts";
import { inheritPermissionMode, restrictPermissionMode } from "@zcode/contracts";
import {
  defaultScheduler,
  buildExploreAllowedTools,
  buildExploreAgentPrompt,
  createExploreSubagentPort,
  createCoreError,
  CoreErrorType,
} from "../deps.js";
import type {
  ExploreSubagentRuntimeRequest,
  McpConnectionSnapshot,
  McpPort,
  Model,
  ModelSelection,
  SkillContent,
  SkillLoadOutcome,
  SkillOperationOptions,
  SkillPort,
  SubagentPort,
} from "../deps.js";
import { resolveExecutionState } from "@zcode/shared";
import { AgentRuntime } from "../agent-runtime.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { resolveSubagentSelection } from "../helpers/subagent-selection.js";
import type { AgentRuntimeDeps } from "../types.js";
import { toMcpToolName } from "../../mcp/index.js";
import { createBorrowedSubagentMcpAccess } from "../../subagent/borrowed-mcp-port.js";
import { createSubagentMessageSink } from "../../subagent/message-steering.js";
import { latestAnnouncedEnvironment } from "./context-refresh.js";
import {
  extractRequiredMcpServerNames,
  matchesRequiredMcpServer,
} from "../../subagent/mcp-config.js";
import { mirrorSubagentToolEvent } from "../../subagent/tool-event-mirror.js";
import { isBuiltInExploreAgentProfile } from "../../subagent/profile.js";
import {
  buildSubagentChildDisallowRules,
  filterSubagentChildToolNames,
} from "../../subagent/tool-policy.js";
import { isSubagentDispatchToolName } from "../../tool/compat.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import { getSessionShellEnvironment } from "./session-shell-environment.js";
import { deriveChildClientPorts } from "../helpers/child-client-ports.js";
import { createCoordinatorResponsePort } from "../../subagent/coordinator-response.js";
import { isStaleBranchRuntimeTaskEvent } from "./runtime-command-generation.js";
import { loadPersistentAgentMemory } from "../../subagent/persistent-memory.js";
import {
  createOfficialCuaPolicy,
  SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE,
  SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE,
  type OfficialCuaPolicy,
} from "../../subagent/computer-use-policy.js";
import { computeOfficialCuaServerNames } from "./mcp.js";
import { persistRuntimeModelSelection, sameModelSelection } from "./turn-model.js";
import { getOffPeakExecution, markTemporaryRuntimeSelection } from "../off-peak/runtime.js";
import { getOffPeakModelBinding } from "../off-peak/model-binding.js";
import { noteSubagentActivity } from "../../subagent/background-stall.js";

export function createDefaultSubagentPort(
  this: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
): SubagentPort | undefined {
  if (this.config.subagents?.enabled === false) {
    return undefined;
  }

  const ownedRuntimes = new Set<AgentRuntime>();
  return createExploreSubagentPort({
    closeOwnedRuntimes: async () => {
      const results = await Promise.allSettled(
        [...ownedRuntimes].map(async (runtime) => {
          await runtime.close();
          ownedRuntimes.delete(runtime);
        }),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Subagent runtimes cleanup failed");
      ownedRuntimes.clear();
    },
    logger: this.logger,
    inactivityTimeoutMs: this.config.subagents?.inactivityTimeoutMs,
    autoBackgroundMs: this.config.subagents?.autoBackgroundMs,
    outputRootDir: this.config.subagents?.outputRootDir,
    getAgentDefinitions: this.getAgentDefinitions,
    builtInModelSelectionOverrides: this.config.subagents?.builtInModelSelectionOverrides,
    runtimeTaskRegistry: this.runtimeTaskRegistry,
    emitParentEvent: async (event, traceContext) => {
      if (isStaleBranchRuntimeTaskEvent(this, event)) return;
      await this.appendEvent(event, traceContext);
    },
    enqueueParentTaskNotification: (notification) => {
      this.enqueueBackgroundTaskNotification({
        originMeta: notification.originMeta,
        taskId: notification.taskId,
        text: notification.text,
        traceContext: notification.traceContext,
      });
      return undefined;
    },
    getAllowedTools: () => {
      return buildExploreAllowedTools({
        embeddedSearchEnabled: resolveSubagentEmbeddedSearchEnabled(),
      });
    },
    runExploreAgent: async (request, options) => {
      const offPeak = getOffPeakExecution(this);
      const childBinding = offPeak?.createChildBinding();
      if (offPeak && !offPeak.lifecycle.terminal) {
        const selection = offPeak.lifecycle.ownedByUser
          ? this.getSessionModelSelection()
          : offPeak.selection;
        if (selection)
          options = {
            ...options,
            modelOverride: {
              selection,
              requestDependencies: childBinding?.requestDependencies,
              background: "allow",
            },
          };
      }
      try {
        request.reportActivity?.();
        const builtInExplore = isBuiltInExploreAgentProfile(request.profile);
        const agentsMdInstructions =
          request.profile.injectAgentsMd !== false
            ? this.contextSourceSnapshot?.userInstructions
            : undefined;
        const { selection: profileChildSelection, hasConcreteModel } = resolveSubagentSelection({
          profileSelection: request.profile.modelSelection,
          parentSelection: this.getSessionModelSelection(),
          overrideSelection: options?.modelOverride?.selection,
          resolveSelection: deps.resolveEffectiveModelSelection,
        });
        const modelOverride = options?.modelOverride;
        const inheritedModel = !modelOverride && !hasConcreteModel ? options?.model : undefined;
        // Core Server override 优先于持久化 profile 与父模型继承，但仍只是标准 Selection。
        const childSelection = inheritedModel
          ? modelSelectionFromActiveModel(inheritedModel)
          : profileChildSelection;
        const embeddedSearchEnabled = resolveSubagentEmbeddedSearchEnabled();
        const baseChildEnvInfo = this.contextSourceSnapshot?.envInfo ??
          this.config.envInfo ?? {
            cwd: request.workingDirectory,
            platform: "unknown",
            shell: "unknown",
            osVersion: "unknown",
            nodeVersion: "unknown",
          };
        const shellEnvironment = getSessionShellEnvironment(this);
        const bashShellSelection = shellEnvironment?.selection;
        const childEnvInfo = {
          ...baseChildEnvInfo,
          ...(shellEnvironment ? { shell: shellEnvironment.promptShell } : {}),
        };
        const baseAgentPrompt =
          builtInExplore && request.systemPrompt?.trim() === ""
            ? buildExploreAgentPrompt({ embeddedSearchEnabled })
            : request.systemPrompt?.trim();
        const persistentMemory = await loadPersistentAgentMemory({
          fileSystemPort: deps.fileSystemPort,
          logger: this.logger,
          memory: this.config.memory,
          profile: request.profile,
          traceContext: request.traceContext,
          workspaceRoot: request.workspaceRoot,
        });
        // 空 agent prompt 不是一个语义段；先硬拼 `\n\n` 会把缺失段的边界
        // 泄漏到 persistent Memory 开头。这里只组合非空正文，block 左边界由 builder 统一添加。
        const agentPrompt = [baseAgentPrompt, persistentMemory?.prompt]
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join("\n\n");
        const announcedEnvironment = latestAnnouncedEnvironment(
          this.messageHistory.borrowReadOnlyRuntimeEntries(),
        );
        const childRuntimeEnvInfo = {
          ...childEnvInfo,
          // 父会话切目录后，起始快照的仓库属性已过期；只继承同一 cwd 的最近已接受环境。
          // 附加目录属于父运行配置，child 不继承，不能随快照混入 envInfo。
          ...(announcedEnvironment?.cwd === request.workingDirectory
            ? {
                platform: announcedEnvironment.platform,
                shell: announcedEnvironment.shell,
                osVersion: announcedEnvironment.osVersion,
                isGitRepository: announcedEnvironment.isGitRepository,
              }
            : {}),
          cwd: request.workingDirectory,
        };
        const officialCuaServerNames = computeOfficialCuaServerNames(
          this.config.mcp?.servers ?? {},
          new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
        );
        const preflightCuaPolicy = createOfficialCuaPolicy(
          officialCuaServerNames,
          [],
          this.config.pluginReferenceCatalog,
        );
        await validateSubagentComputerUseConfiguration(request, preflightCuaPolicy, this.skillPort);
        const childMcpAccess = await resolveSubagentMcpAccess.call(
          this,
          request,
          officialCuaServerNames,
        );
        const childToolAllowlist = resolveSubagentToolAllowlist.call(
          this,
          request,
          childMcpAccess.snapshot?.tools.map((descriptor) => toMcpToolName(descriptor)) ?? [],
        );
        validateSubagentMcpRequirements(request, childToolAllowlist, childMcpAccess);
        const childMode = resolveSubagentPermissionMode(
          this.getPlanEnabled() ? "plan" : this.config.mode,
          request.permissionMode,
          request.profile.permissionModeRestrictOnly === true,
        );
        // 旧 plan 枚举不包含基础权限；拆分后继承父会话的基础模式。新建与恢复子会话共用这一份状态。
        const childExecutionState = resolveExecutionState({
          mode: childMode === "plan" ? this.config.mode : childMode,
          planEnabled: childMode === "plan",
        });
        const childCuaPolicy = createOfficialCuaPolicy(
          officialCuaServerNames,
          childMcpAccess.parentSnapshot?.tools ?? childMcpAccess.snapshot?.tools ?? [],
          this.config.pluginReferenceCatalog,
        );
        await validateSubagentComputerUseConfiguration(request, childCuaPolicy, this.skillPort);
        const childSkillPort = resolveSubagentSkillPort(
          this.skillPort,
          request.profile.skills,
          childCuaPolicy,
        );
        const baseChildModelFactory = modelOverride
          ? createSubagentOverrideModelFactory(modelOverride, this.modelFactory)
          : inheritedModel
            ? createInheritedSubagentModelFactory(childSelection, inheritedModel, this.modelFactory)
            : this.modelFactory;
        if (!baseChildModelFactory) {
          throw createCoreError(
            CoreErrorType.ConfigurationError,
            `Subagent model factory cannot resolve ${childSelection.providerId}/${childSelection.modelId}`,
            { recoverable: true },
          );
        }
        const childModel = baseChildModelFactory({ selection: childSelection });
        const childModelFactory: NonNullable<AgentRuntimeDeps["modelFactory"]> = (target) =>
          target.selection.providerId === childSelection.providerId &&
          target.selection.modelId === childSelection.modelId &&
          target.selection.options?.reasoningLevel === childSelection.options?.reasoningLevel
            ? childModel
            : baseChildModelFactory(target);
        const parentToolCallId = traceStringAttribute(request.traceContext, "parentToolCallId");
        // 对外交互端口（permission broker + provider runtime headers）：与 dwf actor、legacy
        // workflow child 共用同一条派生，路由身份统一落到本 runtime 的会话。
        const childClientPorts = deriveChildClientPorts(
          {
            permissionBroker: this.permissionBroker,
            ...(this.providerRuntimeHeadersPort === undefined
              ? {}
              : { providerRuntimeHeadersPort: this.providerRuntimeHeadersPort }),
          },
          {
            agentId: request.agentId,
            agentType: request.agentType,
            childSessionId: request.sessionId,
            description: request.description,
            parentSessionId: this.sessionId,
            parentToolCallId,
            ...(request.traceContext.turnId === undefined
              ? {}
              : { parentTurnId: request.traceContext.turnId }),
          },
        );
        // Browser Use：子代理与当前对话共用 tab（tabOwner: "parent"），用户能在面板里看到它开的 tab，
        // 它也能看到对话里已有的 tab；workspace / clientMode 经 forChildSession 登记回父会话解析。
        // 子代理结束只撤销登记，不关 tab。端口没有 forChildSession（CLI headless）时退回子会话自己的 scope。
        const childBrowserControlPort =
          this.browserControlPort?.forChildSession?.({
            childSessionId: request.sessionId,
            parentSessionId: this.sessionId,
            tabOwner: "parent",
          }) ?? this.browserControlPort;
        const mirroredToolNameByChildToolCallId = new Map<string, string>();
        let sessionReadyNotified = false;
        const notifySessionReady = async () => {
          if (sessionReadyNotified) return;
          await request.onSessionReady?.();
          sessionReadyNotified = true;
        };
        this.logger?.debug("Starting subagent child runtime", {
          parentSessionId: this.sessionId,
          childSessionId: request.sessionId,
          agentType: request.agentType,
        });
        const childRuntime = new AgentRuntime(
          request.sessionId,
          {
            ...childExecutionState,
            // 模型选择的影响不只在最终 request.model：MCS、内建搜索与 token/media 预算会在
            // child runtime 内按 default model 预先塑形。同步 child 因此必须把整套执行
            // 配置都指向父 turn 快照；runner 禁止它转后台，provider registry 则由父 turn
            // finally 清理，快照不会成为可恢复的 session 配置。
            modelSelection: cloneModelSelection(childSelection),
            modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
            workingDirectory: request.workingDirectory,
            // Bash cd 只改变执行 cwd；若丢失绑定身份，child 会落到另一个 workspace，重启后无法打开。
            workspacePath: this.config.workspacePath ?? request.workspaceRoot,
            workspaceIdentity:
              this.config.workspaceIdentity ??
              (this.config.memory?.workspaceIdentity?.trim() as WorkspaceId | undefined),
            workspaceKey: this.config.workspaceKey,
            // 执行模型只由 child Active Model 投影进 Context；envInfo 不保存第二份模型事实。
            envInfo: childRuntimeEnvInfo,
            // Explore 子运行时之前没有继承主会话的流式配置，Protocol 桌面端虽已默认
            // 开启 modelStreaming，子请求仍会退回 generateText。部分 OpenAI-compatible 端点在
            // 非流式请求里也返回 SSE `data:` 帧，generateText 会按普通 JSON 解析并报
            // Invalid JSON response；继承父配置可让子 agent 与主链路走同一 streamText 语义。
            modelStreaming: this.config.modelStreaming,
            bashTimeoutPolicy: this.config.bashTimeoutPolicy,
            midConversationSystem: this.config.midConversationSystem,
            toolSearch: this.config.toolSearch,
            bashShellSelection,
            // child 只复用父 runtime 已解析的 instructions snapshot；Project Context 仍不继承。
            currentDate: this.contextSourceSnapshot?.currentDate ?? this.config.currentDate,
            subagentContext: {
              agentPrompt: agentPrompt ?? "",
              ...(agentsMdInstructions ? { userInstructions: agentsMdInstructions } : {}),
            },
            agentName: `zcode-${request.agentType}`,
            maxTurns: request.maxTurns ?? this.config.subagents?.maxTurns ?? 4,
            parentSessionId: this.sessionId,
            taskType: "subagent_child",
            // 动态工作流灰度门必须结构性继承：
            // 父会话关着而子代理开着，等于 Agent 工具变成绕过灰度的后门。默认路径（child 继承
            // 父 registry 可见的工具名）本来就够，但**自定义 agent profile 显式写
            // `allowedTools: ["CreateWorkflow"]` 时会跳过那次交集**，只剩这一道能挡住。
            dynamicWorkflowEnabled: this.config.dynamicWorkflowEnabled,
            // launch.md「On demand: activation」Children 段：子代理继承父会话**此刻**的工具面——
            // 父未激活则子也按需（子会话里没有 `/workflow` 入口，实际等于没有工作流工具）；
            // 父已激活则子出生即注册。
            dynamicWorkflowToolsOnDemand:
              this.config.dynamicWorkflowToolsOnDemand === true &&
              !this.dynamicWorkflowToolsActivated,
            // 修复原因：默认 subagent 已从 Explore 调整为 general-purpose。
            // toolset 不能再依赖 DEFAULT_SUBAGENT_TYPE，否则默认通用 agent 会被误降级为只读搜索工具面。
            toolset: builtInExplore ? "explore" : "main",
            toolAllowlist: childToolAllowlist,
            toolDisallowlist: this.config.toolDisallowlist,
            embeddedSearchBackend: this.config.embeddedSearchBackend,
            nativeSearchEnhancementsEnabled: this.config.nativeSearchEnhancementsEnabled,
            subagents: {
              backgroundBashMaxMs: this.config.subagents?.backgroundBashMaxMs,
              enabled: false,
            },
            mcp: childMcpAccess.config,
          },
          {
            agentTelemetry: this.agentTelemetry.port,
            agentTelemetryCausation: this.agentTelemetry.captureCausation(),
            // 前台 child 的生命周期被父 Agent Tool await，使用真实父子 Span；后台 child
            // 可能晚于父 Tool/Turn 结束，只能作为独立 Trace 用 Link 保留因果关系。
            agentTelemetryCausationMode: request.background ? "linked_root" : "child",
            eventStore: this.eventStore,
            // 日期公告取运行时时钟；child 继承父时钟，父子只有一个日期来源。
            now: this.now,
            sessionStore: deps.sessionStore,
            // 共享宿主环境读取端口，只用于 child 内 cd 之后的环境探测；初始快照和指令都取父级传下的配置。
            contextSourcePort: this.contextSourcePort,
            // 子 runtime 的模型请求准入：装配方给了 subagent 工厂就用它（受闸门约束，同一父会话的
            // subagent 共用一条队列）；没给则沿用父的端口。
            // 修复原因：subagent 曾直接继承父的 observer（不排队、不看 Retry-After），一轮并行多个
            // Agent 调用会放大成 1302 风暴（docs/dynamic-workflow/concurrency.md「Where the port is bound」）。
            modelRequestAdmission:
              deps.subagentModelRequestAdmission?.(this.sessionId) ?? this.modelRequestAdmission,
            modelFactory: childModelFactory,
            resolveEffectiveModelSelection: deps.resolveEffectiveModelSelection,
            // 子 runtime 自己仍使用 request.sessionId 做事件持久化和 trace 归档；对外阻塞交互
            // （permission / AskUserQuestion / provider runtime headers）一律路由回父 session——
            // 桌面 UI 只认识父 task 的 sessionId。派生收敛在 deriveChildClientPorts 一处，
            // dwf actor 与 legacy workflow child 走同一条。
            ...childClientPorts,
            ...(childBrowserControlPort === undefined
              ? {}
              : { browserControlPort: childBrowserControlPort }),
            coordinatorResponsePort: createCoordinatorResponsePort({
              agentId: request.agentId,
              agentType: request.agentType,
              childSessionId: request.sessionId,
              parentToolCallId,
              enqueue: (input) => this.enqueueSubagentMessage(input),
            }),
            // 修复原因：Explore 曾新建默认配置的权限服务，父会话的 allowedTools、disallowedTools 和
            // 会话内授权都不生效。所有子会话（含 Explore）都继承父会话的权限服务。
            permissionService: this.permissionService,
            toolScheduler: deps.toolScheduler ?? defaultScheduler,
            executionPort: deps.executionPort,
            fileSystemPort: deps.fileSystemPort,
            // Explore 子运行时会暴露 WebFetch，但之前没有继承主 runtime 的
            // HTTP client port，导致工具在真正发请求前抛出配置错误，而不是网络请求失败。
            httpClientPort: deps.httpClientPort,
            imageProcessorPort: deps.imageProcessorPort,
            pdfDocumentPort: deps.pdfDocumentPort,
            memoryRoot: persistentMemory?.rootDir,
            mcpPort: childMcpAccess.port,
            skillPort: childSkillPort,
            artifactStore: deps.artifactStore,
            appVersion: this.appVersion,
            eventSink: {
              onSessionEvent: async (event) => {
                request.reportActivity?.();
                request.onEvent?.(event);
                noteSubagentActivity(
                  this.runtimeTaskRegistry,
                  request.agentId,
                  event,
                  Date.now(),
                  request.executionId,
                );
                // child runtime 的事件已经按 childSessionId 落库，但旧链路只把
                // 少量工具事件镜像给 parent sink，导致 UI 订阅 child topic 后只能拿到打开时
                // 的 hydration，后续流式内容不会更新。raw child event 只通知父 runtime 的
                // 外部 sinks，不再次 append，因此不会重复持久化；bootstrap 再按 event.sessionId
                // 把它路由到 child publisher。
                await this.notifyEventSinks(event, {
                  ...request.traceContext,
                  sessionId: request.sessionId,
                });
                const mirroredEvent = mirrorSubagentToolEvent(event, {
                  agentId: request.agentId,
                  agentType: request.agentType,
                  background: request.background,
                  childSessionId: request.sessionId,
                  description: request.description,
                  parentSessionId: this.sessionId,
                  parentToolCallId,
                  parentTurnId: request.traceContext.turnId,
                  toolNameByChildToolCallId: mirroredToolNameByChildToolCallId,
                });
                if (!mirroredEvent) return;

                // parent mirror 保留原语义：父会话只看到 subagent 摘要/工具活动，raw child
                // 正文不会污染父 timeline。
                await this.notifyEventSinks(mirroredEvent, {
                  ...request.traceContext,
                  sessionId: this.sessionId,
                });
              },
            },
            logger: this.logger,
            traceContext: request.traceContext,
          },
        );

        // 已完成的 child 仍可能拥有后台 Bash、title/MCP 等工作；父 session 关闭时仍需找到它。
        ownedRuntimes.add(childRuntime);
        try {
          const resumesExistingChild = request.resumeFromStore === true;
          if (childBinding)
            markTemporaryRuntimeSelection(
              childRuntime as unknown as AgentRuntimeInternal,
              offPeak?.ordinarySelection,
            );
          let previousSelection: ModelSelection | undefined;
          if (resumesExistingChild) {
            const persistedMessages = await this.sessionStore?.messages({
              sessionID: request.sessionId,
            });
            // terminal resume 只恢复已有历史；模型初始化前失败不能变成一次空 session 创建。
            if (!persistedMessages?.length) {
              throw createCoreError(
                CoreErrorType.SessionNotFound,
                `No transcript found for agent ${request.agentId}`,
                { recoverable: true },
              );
            }
            const entries = await this.sessionStore?.sessionEntries?.({
              sessionID: request.sessionId,
              type: SESSION_ENTRY_MODEL_SELECTION,
            });
            previousSelection = parseModelSelectionValue(entries?.at(-1)?.data);
            await childRuntime.resumeFromStore({
              // 修复原因：恢复曾沿用子会话落盘时的模式，父会话改模式或升级后（Explore 曾固定 yolo）
              // 恢复的子会话仍按旧模式运行；这里用本次按父会话当前状态算出的模式覆盖。
              executionStateOverride: childExecutionState,
              persistedMessages,
              traceContext: request.traceContext,
            });
            // 恢复只导入历史；本轮 profile 选出的模型仍是执行权威，并更新冷恢复所用的选择记录。
            await persistRuntimeModelSelection(
              childRuntime as unknown as AgentRuntimeInternal,
              childSelection,
            );
          } else {
            // 父会话过去先发布 SubagentSpawned，child 的首轮 executeTurn 才落库。
            // 并发派生时目录查询会在两者之间读到少一个 child。这里把持久化提升为发布前闸门。
            await childRuntime.ensureSessionPersistedForExternalActivity(request.prompt, {
              traceContext: request.traceContext,
            });
          }
          await notifySessionReady();
          if (
            !resumesExistingChild ||
            (previousSelection && !sameModelSelection(previousSelection, childSelection))
          ) {
            // 同模型恢复不重复插入分隔线；配置变化复用现有事件和 transcript 记录。
            childRuntime.recordPendingModelChange({
              ...(previousSelection
                ? {
                    fromModel: previousSelection,
                    fromModelLabel: `${previousSelection.providerId}/${previousSelection.modelId}`,
                  }
                : {}),
              toModel: childSelection,
              toModelLabel: `${childSelection.providerId}/${childSelection.modelId}`,
            });
            await childRuntime.emitModelSelected({
              modelSelection: childSelection,
              effectiveReasoningLevel: childModel.options.reasoningLevel,
              previousModelSelection: previousSelection ?? null,
              traceContext: request.traceContext,
            });
          }
          request.registerMessageSink?.(createSubagentMessageSink(childRuntime, request));
          return await childRuntime.executeTurn(request.prompt, undefined, {
            ...(childBinding
              ? {
                  offPeakTaskId: offPeak!.offPeakTaskId,
                  modelExecution: {
                    selectionScope: "execution" as const,
                    memoryExtraction: "skip" as const,
                  },
                }
              : { offPeakTaskId: undefined }),
            abortSignal: options?.signal,
            // 子 Runtime 的首轮输入来自父 Agent，而不是真实用户直接输入；保留源事实，避免
            // Subagent Turn 在 Trace 和成功率报表里被误归类为 user。
            inputSource: "subagent",
            inputPresentation: "coordinator_input",
            traceContext: request.traceContext,
          });
        } finally {
          const cancelled = options?.signal?.aborted === true;
          childRuntime.sealBackgroundTaskNotifications({
            reason: cancelled ? "subagent_cancelled" : "subagent_terminal",
            traceContext: request.traceContext,
          });
          // 执行结果与资源释放分开；失败保留句柄，最终 owner close 依据当时释放结果判断。
          const released = cancelled ? childRuntime.close() : childRuntime.retire();
          const release = released.then(
            () => {
              ownedRuntimes.delete(childRuntime);
            },
            (error: unknown) =>
              this.logger?.warn("Subagent resource cleanup pending", {
                event: "subagent.cleanup.pending",
                childSessionId: request.sessionId,
                error: error instanceof Error ? error.message : String(error),
              }),
          );
          if (cancelled || !childRuntime.hasResidencyBlockingWork()) await release;
        }
      } finally {
        childBinding?.release();
      }
    },
  });
}

function resolveSubagentEmbeddedSearchEnabled(): boolean {
  const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
    bashAvailable: true,
  });

  return embeddedSearchDecision.useEmbeddedSearchBranch;
}

export function createInheritedSubagentModelFactory(
  inheritedSelection: ModelSelection,
  inheritedModel: Model,
  fallbackFactory: AgentRuntimeDeps["modelFactory"],
): NonNullable<AgentRuntimeDeps["modelFactory"]> {
  return (target) => {
    if (
      target.selection.providerId === inheritedSelection.providerId &&
      target.selection.modelId === inheritedSelection.modelId &&
      target.selection.options?.reasoningLevel === inheritedSelection.options?.reasoningLevel
    ) {
      // Selection 保持显式意图的稀疏形态；不能拿它和 Active Model 的完整 effective
      // options 比较，否则默认值必然导致复用失败并让 child 重新解释可变 Registry。
      return inheritedModel;
    }
    return fallbackFactory(target);
  };
}

export function modelSelectionFromActiveModel(model: Model): ModelSelection {
  const reasoningLevel = model.options.reasoningLevel;
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

function createSubagentOverrideModelFactory(
  override: NonNullable<SubagentRunOptions["modelOverride"]>,
  fallbackFactory: AgentRuntimeDeps["modelFactory"],
): AgentRuntimeDeps["modelFactory"] {
  return (target) => {
    const model = fallbackFactory({
      ...target,
      selection: override.selection,
      requestDependencies: override.requestDependencies,
    });
    return getOffPeakModelBinding(override.requestDependencies)?.wrap(model) ?? model;
  };
}

function resolveSubagentPermissionMode(
  parentMode: AgentRuntimeInternal["config"]["mode"],
  permissionMode: ExploreSubagentRuntimeRequest["permissionMode"],
  restrictOnly: boolean,
): AgentRuntimeInternal["config"]["mode"] {
  // 修复原因：插件 profile 按用户级解析，声明 bypassPermissions 时父会话 build 的子会话
  // 也会变成 yolo，模型生成的命令全部免审批。插件声明只能收紧：取父会话与声明中更严格的一个。
  // 父会话未设置模式时按 build 比较，与 getMode 的默认值一致。
  const applyDeclared = (mode: CollaborationMode): CollaborationMode =>
    restrictOnly ? restrictPermissionMode(parentMode ?? "build", mode) : mode;
  switch (permissionMode) {
    case "bypassPermissions":
    case "dontAsk":
      return applyDeclared(inheritPermissionMode(parentMode, "yolo"));
    case "acceptEdits":
      return applyDeclared("edit");
    case "auto":
      return applyDeclared("auto");
    case "plan":
      return applyDeclared("plan");
    case "default":
    case undefined:
      // 修复原因：内置 Explore 曾在这里固定为 yolo，只靠 prompt 约束只读；提示注入后模型可经
      // Agent(Explore) 在 build 或 Plan 父会话下免审批执行任意 Bash。现在与其他 profile 一样继承
      // 父会话模式与 Plan 状态，Bash 是否只读交给 shell AST 判定。
      return parentMode;
    default:
      return parentMode;
  }
}

function resolveSubagentToolAllowlist(
  this: AgentRuntimeInternal,
  request: ExploreSubagentRuntimeRequest,
  visibleMcpToolNames: readonly string[],
): readonly string[] {
  const disallowedRules = buildSubagentChildDisallowRules([
    ...(this.config.toolDisallowlist ?? []),
    ...(request.disallowedTools ?? []),
  ]);
  const inheritsAvailableTools =
    request.allowedTools.length === 0 || request.allowedTools.includes("*");
  if (inheritsAvailableTools) {
    const parentAllowedMcpToolNames = filterMcpToolNamesByParentAllowlist(
      visibleMcpToolNames,
      this.config.toolAllowlist,
    );
    const availableToolNames = [
      ...this.getTools()
        // child MCP 必须与 parent 启动 snapshot 使用同一批 descriptor，
        // 不能从另一份 registry 视图重新推导。
        .filter((tool) => tool.permission?.permission !== "mcp")
        .map((tool) => tool.name),
      ...parentAllowedMcpToolNames,
    ];
    return appendCoordinatorResponseTool(
      [...new Set(availableToolNames)]
        .filter((toolName) => !isSubagentDispatchToolName(toolName))
        .filter((toolName) => filterSubagentChildToolNames([toolName], disallowedRules).length > 0),
    );
  }
  if (request.allowedTools.length > 0) {
    return appendCoordinatorResponseTool(
      filterSubagentChildToolNames(request.allowedTools, disallowedRules),
    );
  }
  return appendCoordinatorResponseTool([]);
}

function filterMcpToolNamesByParentAllowlist(
  toolNames: readonly string[],
  parentAllowlist: readonly string[] | undefined,
): readonly string[] {
  if (parentAllowlist === undefined) return toolNames;
  const allowed = new Set(parentAllowlist);
  return toolNames.filter((toolName) => allowed.has(toolName));
}

function isModelVisibleMcpToolName(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

function appendCoordinatorResponseTool(toolNames: readonly string[]): readonly string[] {
  if (toolNames.includes(RESPOND_TO_COORDINATOR_TOOL_NAME)) {
    return toolNames;
  }

  // child 控制通道不受 profile 工具列表约束；全局 toolDisallowlist 仍在 runtime 注册边界生效。
  return [...toolNames, RESPOND_TO_COORDINATOR_TOOL_NAME];
}

interface ResolvedSubagentMcpAccess {
  config: { enabled?: boolean } | undefined;
  port: McpPort | undefined;
  parentSnapshot: McpConnectionSnapshot | undefined;
  snapshot: McpConnectionSnapshot | undefined;
}

async function resolveSubagentMcpAccess(
  this: AgentRuntimeInternal,
  request: ExploreSubagentRuntimeRequest,
  officialCuaServerNames: ReadonlySet<string>,
): Promise<ResolvedSubagentMcpAccess> {
  if (!shouldBorrowParentMcp(request)) {
    return { config: undefined, parentSnapshot: undefined, port: undefined, snapshot: undefined };
  }

  const scopedServerNames = request.profile.mcpServers?.length
    ? request.profile.mcpServers
    : undefined;
  if (!this.mcpPort || this.config.mcp?.enabled === false) {
    if (scopedServerNames) {
      throw createSubagentMcpUnavailableError(request);
    }
    return {
      config: this.config.mcp?.enabled === false ? { enabled: false } : undefined,
      parentSnapshot: undefined,
      port: undefined,
      snapshot: undefined,
    };
  }

  // child 不拥有连接生命周期，只能复用 parent constructor 已创建的启动快照。
  const parentStartupSnapshot = await this.mcpStartupPromise;
  if (!parentStartupSnapshot) {
    if (scopedServerNames) {
      throw createSubagentMcpUnavailableError(request);
    }
    return { config: undefined, parentSnapshot: undefined, port: undefined, snapshot: undefined };
  }

  const unavailableScopedServerNames = (scopedServerNames ?? []).filter(
    (serverName) => parentStartupSnapshot.statuses[serverName]?.status !== "connected",
  );
  if (unavailableScopedServerNames.length > 0) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Required MCP server is not connected: ${unavailableScopedServerNames.join(", ")}`,
      {
        context: {
          agentType: request.agentType,
          missingMcpServers: unavailableScopedServerNames,
        },
        recoverable: true,
      },
    );
  }

  const borrowed = createBorrowedSubagentMcpAccess(
    this.mcpPort,
    parentStartupSnapshot,
    scopedServerNames,
    officialCuaServerNames,
  );
  return {
    config: { enabled: true },
    parentSnapshot: parentStartupSnapshot,
    port: borrowed.port,
    snapshot: borrowed.snapshot,
  };
}

function shouldBorrowParentMcp(request: ExploreSubagentRuntimeRequest): boolean {
  if ((request.profile.mcpServers?.length ?? 0) > 0) return true;
  if (request.allowedTools.length === 0 || request.allowedTools.includes("*")) return true;
  return request.allowedTools.some((toolName) => {
    const normalized = toolName.trim();
    return isConcreteMcpToolName(normalized) || isMcpServerSelector(normalized);
  });
}

function validateSubagentMcpRequirements(
  request: ExploreSubagentRuntimeRequest,
  effectiveAllowedTools: readonly string[],
  access: ResolvedSubagentMcpAccess,
): void {
  const inheritsAvailableTools =
    request.allowedTools.length === 0 || request.allowedTools.includes("*");
  if (inheritsAvailableTools) return;

  const normalizedAllowedTools = effectiveAllowedTools.map((toolName) => toolName.trim());
  const requiredToolNames = normalizedAllowedTools.filter(isConcreteMcpToolName);
  const requiredServerNames = extractRequiredMcpServerNames(
    normalizedAllowedTools.filter(isMcpServerSelector),
  );
  if (requiredToolNames.length === 0 && requiredServerNames.length === 0) return;
  if (!access.port || !access.snapshot) {
    throw createSubagentMcpUnavailableError(request, requiredToolNames);
  }
  const snapshot = access.snapshot;

  const unavailableServerNames = requiredServerNames.filter(
    (serverName) => !matchesRequiredMcpServer(serverName, snapshot.statuses),
  );
  if (unavailableServerNames.length > 0) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Required MCP server is not connected: ${unavailableServerNames.join(", ")}`,
      {
        context: {
          agentType: request.agentType,
          missingMcpServers: unavailableServerNames,
        },
        recoverable: true,
      },
    );
  }

  const visibleToolNames = new Set(snapshot.tools.map((descriptor) => toMcpToolName(descriptor)));
  const missingToolNames = requiredToolNames.filter((toolName) => !visibleToolNames.has(toolName));
  if (missingToolNames.length === 0) return;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `Required MCP tool is not available in the parent startup snapshot: ${missingToolNames.join(", ")}`,
    {
      context: {
        agentType: request.agentType,
        missingMcpTools: missingToolNames,
      },
      recoverable: true,
    },
  );
}

function isConcreteMcpToolName(toolName: string): boolean {
  return isModelVisibleMcpToolName(toolName) && !isMcpServerSelector(toolName);
}

function isMcpServerSelector(toolName: string): boolean {
  return toolName === "mcp" || (toolName.startsWith("mcp__") && toolName.endsWith("__*"));
}

function createSubagentMcpUnavailableError(
  request: ExploreSubagentRuntimeRequest,
  requiredToolNames: readonly string[] = [],
) {
  return createCoreError(
    CoreErrorType.ConfigurationError,
    "Subagent MCP is unavailable because the parent startup snapshot is unavailable",
    {
      context: {
        agentType: request.agentType,
        requiredMcpTools: requiredToolNames,
      },
      recoverable: true,
    },
  );
}

function resolveSubagentSkillPort(
  parentSkillPort: SkillPort | undefined,
  skillNames: readonly string[] | undefined,
  cuaPolicy: OfficialCuaPolicy,
): SkillPort | undefined {
  if (!parentSkillPort) {
    return parentSkillPort;
  }
  return new FilteredSkillPort(
    parentSkillPort,
    skillNames && skillNames.length > 0 ? new Set(skillNames) : undefined,
    cuaPolicy,
  );
}

class FilteredSkillPort implements SkillPort {
  constructor(
    private readonly parent: SkillPort,
    private readonly allowedSkills: ReadonlySet<string> | undefined,
    private readonly cuaPolicy: OfficialCuaPolicy,
  ) {}

  async discoverSkills(
    request: Parameters<SkillPort["discoverSkills"]>[0],
    options?: SkillOperationOptions,
  ): Promise<SkillLoadOutcome> {
    const outcome = await this.parent.discoverSkills(request, options);
    const skills = outcome.skills.filter((skill) => this.isAllowedSkill(skill));
    return {
      ...outcome,
      skills,
      totalDiscovered: skills.length,
    };
  }

  async loadSkill(
    request: Parameters<SkillPort["loadSkill"]>[0],
    options?: SkillOperationOptions,
  ): Promise<SkillContent> {
    if (
      this.cuaPolicy.isOfficialSkillRequest(request.name) ||
      (await this.hasUniqueOfficialSkillMatch(request, options))
    ) {
      throw createSubagentComputerUseUnavailableError(request.name);
    }
    const resolvedName = await this.resolveAllowedSkillRequestName(request, options);
    if (!resolvedName) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Skill is not allowed for subagent",
        {
          context: {
            allowedSkills: this.allowedSkills ? [...this.allowedSkills] : [],
            skill: request.name,
            toolName: "Skill",
          },
          recoverable: true,
        },
      );
    }
    return this.parent.loadSkill({ ...request, name: resolvedName }, options);
  }

  private async hasUniqueOfficialSkillMatch(
    request: Parameters<SkillPort["loadSkill"]>[0],
    options?: SkillOperationOptions,
  ): Promise<boolean> {
    if (request.name.includes(":")) return false;
    const outcome = await this.parent.discoverSkills(
      {
        workingDirectory: request.workingDirectory,
        roots: request.roots,
        trace: request.trace,
      },
      options,
    );
    return isUniqueOfficialSkillRequest(outcome.skills, request.name, this.cuaPolicy);
  }

  private isAllowedSkill(skill: SkillContent["metadata"]): boolean {
    if (this.cuaPolicy.isOfficialSkill(skill)) return false;
    return (
      this.allowedSkills === undefined ||
      this.allowedSkills.has(skill.name) ||
      (skill.qualifiedName !== undefined && this.allowedSkills.has(skill.qualifiedName))
    );
  }

  private async resolveAllowedSkillRequestName(
    request: Parameters<SkillPort["loadSkill"]>[0],
    options?: SkillOperationOptions,
  ): Promise<string | undefined> {
    const outcome = await this.discoverSkills(
      {
        workingDirectory: request.workingDirectory,
        roots: request.roots,
        trace: request.trace,
      },
      options,
    );
    const matches = outcome.skills.filter((skill) => matchesSkillRequestName(skill, request.name));
    if (matches.length === 0) {
      return undefined;
    }
    if (matches.length > 1) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Skill name is ambiguous for subagent; use the fully qualified skill name",
        {
          context: {
            allowedSkills: this.allowedSkills ? [...this.allowedSkills] : [],
            matchingSkills: matches.map((skill) => skill.qualifiedName ?? skill.name),
            skill: request.name,
            toolName: "Skill",
          },
          recoverable: true,
        },
      );
    }
    // 可见 skills 列表会把 plugin skill 展示为 qualified name，并声明 bare alias 也可加载。
    // 子 agent 按 bare alias 调用时，先绑定回过滤后的 metadata，避免父端按全局同名 skill 误加载。
    return matches[0]?.qualifiedName ?? matches[0]?.name;
  }
}

async function validateSubagentComputerUseConfiguration(
  request: ExploreSubagentRuntimeRequest,
  cuaPolicy: OfficialCuaPolicy,
  parentSkillPort: SkillPort | undefined,
): Promise<void> {
  const explicitServer = request.profile.mcpServers?.find((serverName) =>
    cuaPolicy.serverNames.has(serverName.trim()),
  );
  const explicitTool = request.allowedTools.find(
    (toolName) =>
      cuaPolicy.isOfficialToolRequest(toolName) || cuaPolicy.isOfficialServerSelector(toolName),
  );
  let explicitSkill = request.profile.skills?.find((skillName) =>
    cuaPolicy.isOfficialSkillRequest(skillName),
  );
  if (!explicitSkill && parentSkillPort && request.profile.skills?.length) {
    try {
      const outcome = await parentSkillPort.discoverSkills({
        workingDirectory: request.workingDirectory,
        trace: request.traceContext,
      });
      explicitSkill = request.profile.skills.find((skillName) =>
        isUniqueOfficialSkillRequest(outcome.skills, skillName, cuaPolicy),
      );
    } catch {
      // Skill discovery remains lazy; a later Skill load will surface its own error.
    }
  }
  if (!explicitServer && !explicitTool && !explicitSkill) return;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE,
    {
      context: {
        agentType: request.agentType,
        code: SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE,
        ...(explicitServer ? { mcpServer: explicitServer } : {}),
        ...(explicitTool ? { mcpTool: explicitTool } : {}),
        ...(explicitSkill ? { skill: explicitSkill } : {}),
      },
      recoverable: true,
    },
  );
}

export function isUniqueOfficialSkillRequest(
  skills: readonly SkillContent["metadata"][],
  requestName: string,
  cuaPolicy: Pick<OfficialCuaPolicy, "isOfficialSkill">,
): boolean {
  if (requestName.includes(":")) return false;
  const matches = skills.filter((skill) => matchesSkillRequestName(skill, requestName));
  return matches.length === 1 && matches[0] !== undefined && cuaPolicy.isOfficialSkill(matches[0]);
}

function createSubagentComputerUseUnavailableError(skillName: string) {
  return createCoreError(
    CoreErrorType.ToolExecutionFailed,
    SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE,
    {
      context: {
        code: SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE,
        skill: skillName,
        toolName: "Skill",
      },
      recoverable: true,
    },
  );
}

function matchesSkillRequestName(skill: SkillContent["metadata"], requestName: string): boolean {
  return skill.name === requestName || skill.qualifiedName === requestName;
}

function traceStringAttribute(
  traceContext: { attributes?: Record<string, string | number | boolean> },
  key: string,
): string | undefined {
  const value = traceContext.attributes?.[key];
  return typeof value === "string" ? value : undefined;
}
