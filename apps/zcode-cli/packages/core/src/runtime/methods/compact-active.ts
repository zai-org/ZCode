import type { ModelToolContract } from "@zcode/contracts";
import { SEND_MESSAGE_TOOL_NAME } from "@zcode/contracts";
import { buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import { buildCompactTaskStatusEntries } from "../helpers/compact-task-status.js";
import { canReadBackgroundOutputFile } from "../../tool/executor/background-task-output.js";
import {
  prepareRuntimeProviderRequest,
  shouldUseMidConversationSystem,
} from "../helpers/runtime-provider-request-messages.js";
import {
  collectDiscoveredTools,
  compactDiscoveryMetadata,
  compactToolSearchDelivery,
} from "../../tool/search/history.js";
import { collectRuntimeAgentListing } from "../helpers/agent-listing.js";
import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CompactTimelineStatus,
  SessionEventType,
  createChildTraceContext,
  isCoreError,
  createMessageId,
  createPartId,
  traceContextToLogContext,
  buildCompactPrompt,
  buildCompactSummaryMessage,
  buildManualCompactBoundary,
  createCompactBoundaryId,
  getAutoCompactOutputReserveTokens,
  getUsageTotalTokens,
} from "../deps.js";
import type { SessionEvent, TraceContext } from "../deps.js";
import {
  defaultCompactPhaseForTrigger,
  defaultCompactReasonForTrigger,
  countCompactPreservedRuntimeMessages,
  buildPostCompactRuntimeEntries,
  compactFailureReasonFromError,
  estimateRuntimeEntryTokens,
  getRuntimeEntriesToSummarize,
  hasEnoughRuntimeEntriesToCompact,
  selectCompactEntries,
  selectCompactEntriesAfterPromptTooLong,
  selectCompactEntriesForInitialPromptTooLong,
  throwIfTurnAborted,
  isTurnCancellationError,
  isModelContextExceededError,
  isModelMediaTooLargeError,
  logMediaBudgetProjection,
  logMediaCapabilityProjection,
  truncateCompactSummaryRequestEntriesAfterPromptTooLong,
  projectCompactMediaForRetry,
  projectMessagesForModelMediaPolicy,
  logCompactMediaRetryProjection,
  readApprovedPlanFileReferenceEntry,
  replaceReadFileStateAfterCompact,
  restorePostCompactFiles,
  buildRuntimeModeReminderBodyForTask,
  hasFullRuntimeModeReminder,
} from "../helpers/index.js";
import {
  buildCompactLeadingAnnouncements,
  collectSkillsListing,
  rebuildContextPrefix,
  resolveSessionContextAnnouncement,
  restateContextAfterCompact,
} from "./context-refresh.js";
import type { CompactTimelineContext, RuntimeModelTextResult } from "../types.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { CompactAttemptOutcome } from "./turn-loop-state.js";
import {
  legacySyntheticRuntimeMetadata,
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { selectPersistedCompactTail } from "../helpers/compact-preservation.js";
import {
  createCompactContextExceededFinishError,
  createCompactPromptTooLongError,
  formatCompactSummaryOrThrow,
  persistCompactTimelineEvent,
  warnCompactSummaryOutputLimit,
} from "./compact-active-helpers.js";
import { runCompactSummaryModelRequest } from "./compact-summary-model-request.js";
import { resolveAutoCompactPolicyConfig } from "./model-token-limits.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { resetProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { createRuntimeModel } from "./runtime-model.js";
import { supersedeContextComposition } from "../context-composition/state.js";
import { preserveCanonicalContextPrefix } from "./turn-output-token-continuation.js";
import {
  applyRereadInstructionSources,
  buildRereadInstructionContext,
  rereadInstructionSources,
} from "./context.js";
import { setReadFileStateEntry } from "../../tool/read-file-state.js";
import { clearPromptSnapshot } from "../helpers/prompt-snapshot.js";
import { discardPendingSessionStartContext, runCompactSessionStartHooks } from "./hooks.js";

const AUTO_COMPACT_MAX_ATTEMPTS = 3;

export async function compactActiveConversation(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: {
    abortSignal?: AbortSignal;
    compactContextTelemetry?: {
      inputTokens: number;
      policyContextWindowTokens: number;
      thresholdTokens?: number;
      tokenSource: "estimate" | "provider_usage";
    };
    autoCompactThreshold?: number;
    compactReason?: CompactReason;
    initialPromptTooLongCause?: unknown;
    phase?: CompactPhase;
    sourceCommandId?: string;
    trigger?: CompactTrigger;
    model?: Model;
    agentListingTools?: readonly { name: string }[];
    activeEntries?: readonly RuntimeMessageEntry[];
    getContinuationTools?: () => readonly ModelToolContract[];
  } = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  const compactTelemetry = this.agentTelemetry.compaction({
    trigger,
    phase,
    maxAttempts: AUTO_COMPACT_MAX_ATTEMPTS,
    modelMode: this.config.modelStreaming === "off" ? "non_streaming" : "streaming",
    policyContextWindowTokens: options.compactContextTelemetry?.policyContextWindowTokens,
    thresholdTokens: options.compactContextTelemetry?.thresholdTokens,
    tokenSource: options.compactContextTelemetry?.tokenSource,
    traceContext: turnTraceContext,
  });
  if (options.compactContextTelemetry) {
    // Auto 复用策略决策，Reactive 复用 overflow 路径 activeMessages；其他 trigger 不额外投影。
    compactTelemetry.setInputTokens(options.compactContextTelemetry.inputTokens);
  }
  return compactTelemetry.run(async () => {
    try {
      const result = await compactActiveConversationImpl.call(
        this,
        customInstructions,
        turnTraceContext,
        events,
        options,
      );
      compactTelemetry.setOutputTokens(result.tokenCount);
      compactTelemetry.finishCompleted();
      return result;
    } catch (error) {
      if (isTurnCancellationError(error, options.abortSignal)) {
        compactTelemetry.finishCancelled("abort_signal");
      } else {
        compactTelemetry.finishFailed("unhandled", "unknown", error);
      }
      throw error;
    }
  });
}

async function compactActiveConversationImpl(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: {
    abortSignal?: AbortSignal;
    compactContextTelemetry?: {
      inputTokens: number;
      policyContextWindowTokens: number;
      thresholdTokens?: number;
      tokenSource: "estimate" | "provider_usage";
    };
    autoCompactThreshold?: number;
    compactReason?: CompactReason;
    initialPromptTooLongCause?: unknown;
    phase?: CompactPhase;
    sourceCommandId?: string;
    trigger?: CompactTrigger;
    model?: Model;
    agentListingTools?: readonly { name: string }[];
    activeEntries?: readonly RuntimeMessageEntry[];
    getContinuationTools?: () => readonly ModelToolContract[];
  } = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  throwIfTurnAborted(options.abortSignal);
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  const compactReason = options.compactReason ?? defaultCompactReasonForTrigger(trigger);
  const compactModel =
    options.model ??
    createRuntimeModel(this, {
      selection: this.getSessionModelSelection(),
    });
  // Active compact 会跨多个 await 保留这份成员浅快照；它依赖 RuntimeMessageEntry
  // 不可变约定。selection、provider render 和最终 replace 会创建各自拥有的副本，
  // 禁止在 compact 期间原地修改 activeEntries 内共享的 entry/message/content。
  const activeEntries = [
    ...(options.activeEntries ?? this.messageHistory.borrowReadOnlyRuntimeEntries()),
  ];
  const useMidConversationSystem = shouldUseMidConversationSystem(this.config, compactModel);
  const initialSelection = selectInitialCompactEntriesForActiveConversation({
    activeEntries,
    initialPromptTooLongCause: options.initialPromptTooLongCause,
    trigger,
    useMidConversationSystem,
  });
  let currentSelection = initialSelection;
  let preservedEntries = currentSelection.preservedEntries;
  const initialEntriesForSummary = currentSelection.entriesForSummary;
  let entriesForSummary = initialEntriesForSummary;
  let entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
  const preCompactTokenCount = estimateRuntimeEntryTokens(activeEntries, {
    useMidConversationSystem,
  });
  const maxAttempts = trigger === CompactTrigger.Auto ? AUTO_COMPACT_MAX_ATTEMPTS : 1;
  let attempt = 1;
  const compactTimeline: CompactTimelineContext = {
    operationId: `cmp_${crypto.randomUUID()}`,
    messageId: createMessageId(),
    partId: createPartId(),
    trigger,
    phase,
    compactReason,
    ...(options.sourceCommandId ? { sourceCommandId: options.sourceCommandId } : {}),
    startedAt: Date.now(),
    preCompactTokenCount,
  };

  if (!hasEnoughRuntimeEntriesToCompact(entriesForSummary)) {
    const skippedPayload = this.buildCompactTimelinePayload(compactTimeline, {
      endedAt: Date.now(),
      replace: true,
      status: CompactTimelineStatus.Skipped,
    });
    // 刚压缩过或历史太少时，/compact 是健康 no-op，不能暴露成系统故障。
    // 上层快速回填 tracker 只能记录真实 boundary，因此必须显式返回 skipped。
    await persistCompactTimelineEvent(
      this,
      SessionEventType.CompactCompleted,
      skippedPayload,
      turnTraceContext,
      events,
    );
    return {
      displayText: "Context is up to date; no compression needed",
      entries: activeEntries,
      outcome: "skipped",
      tokenCount: preCompactTokenCount,
    };
  }

  const compactStartedPayload = this.buildCompactTimelinePayload(compactTimeline, {
    ...(maxAttempts > 1 ? { attempt, maxAttempts } : {}),
    status: CompactTimelineStatus.Started,
  });
  await persistCompactTimelineEvent(
    this,
    SessionEventType.CompactStarted,
    compactStartedPayload,
    turnTraceContext,
    events,
  );
  // 自动/超窗压缩重发已有输入，不能消费后台已更新的能力快照。
  if (trigger === CompactTrigger.Manual) await this.initializeMcp(turnTraceContext);
  throwIfTurnAborted(options.abortSignal);
  // 与主循环同一份工具目录（含本轮禁用规则），由同一个请求准备入口投影。
  // 修复原因：摘要请求另选工具（只带 ToolSearch 相关工具，或超过 100 个时发空列表）时，
  // tools 段与主循环不同，整个摘要请求不命中主循环的前缀缓存。
  const compactCandidates = options.getContinuationTools?.() ?? this.getTools(compactModel);
  const registry = this.getToolRegistry();

  while (true) {
    try {
      const lastSummarizedMessageId = this.latestConversationMessageId;
      const modelTraceContext = createChildTraceContext(turnTraceContext, {
        attributes: {
          model: `${compactModel.providerId}/${compactModel.modelId}`,
          querySource: "compact",
        },
      });
      const compactPrompt = buildCompactPrompt(customInstructions);
      let result: RuntimeModelTextResult;
      let compactPromptTooLongAttempts = 0;
      let stripMediaForSummary = false;
      const reselectEntriesAfterPromptTooLong = (cause: unknown): boolean => {
        const reselected = selectCompactEntriesAfterPromptTooLong({
          currentGroupsPreserved: currentSelection.groupsPreserved,
          entries: activeEntries,
          promptTooLongCause: cause,
          trigger,
          useMidConversationSystem,
        });
        if (!reselected) return false;

        compactPromptTooLongAttempts += 1;
        currentSelection = reselected;
        preservedEntries = reselected.preservedEntries;
        entriesForSummary = reselected.entriesForSummary;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        return true;
      };
      const truncateEntriesAfterPromptTooLong = (cause: unknown): boolean => {
        if (!canUseCompactSummaryTruncationFallback(trigger)) return false;

        const truncated = truncateCompactSummaryRequestEntriesAfterPromptTooLong({
          attempt: compactPromptTooLongAttempts,
          cause,
          entriesForSummary,
          logger: this.logger,
          traceContext: modelTraceContext,
          useMidConversationSystem,
        });
        if (!truncated) return false;

        compactPromptTooLongAttempts += 1;
        entriesForSummary = truncated;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        return true;
      };

      while (true) {
        const prepared = prepareRuntimeProviderRequest(this, {
          model: compactModel,
          tools: compactCandidates,
          registry,
          // 已发现工具按本次请求的消息计算：只在保留段里发现的工具不发送。
          entries: entriesForSummary,
          prompt: compactPrompt,
          applyCacheControl: true,
          skipCacheWrite: true,
        });
        const requestMessages = prepared.request.messages;
        // Compact 曾只执行 capability projection，漏掉普通 turn 共用的聚合
        // 媒体预算；统一走模型媒体策略，避免 summary 请求绕过全局请求上限。
        const mediaPolicyProjection = projectMessagesForModelMediaPolicy(
          requestMessages,
          compactModel.properties.inputFormat,
        );
        logMediaCapabilityProjection(
          this.logger,
          modelTraceContext,
          mediaPolicyProjection.capabilityProjection,
          {
            event: "compact.request.media_capability_projection",
            message: "Compact request media capability projection",
            model: `${compactModel.providerId}/${compactModel.modelId}`,
          },
        );
        logMediaBudgetProjection(
          this.logger,
          modelTraceContext,
          mediaPolicyProjection.mediaBudgetProjection,
          {
            event: "compact.request.media_projection",
            message: "Compact request media budget projection",
          },
        );
        let projectedRequestMessages = mediaPolicyProjection.messages;
        if (stripMediaForSummary) {
          // 复用通用 media budget 文案会污染 summary 的 provider-visible 内容。
          const mediaProjection = projectCompactMediaForRetry(projectedRequestMessages);
          projectedRequestMessages = mediaProjection.messages;
          logCompactMediaRetryProjection(this.logger, modelTraceContext, mediaProjection);
        }

        const modelRequestEvent = this.createEvent(
          SessionEventType.ModelRequest,
          {
            messages: projectedRequestMessages,
            providerId: String(compactModel.providerId),
            modelId: String(compactModel.modelId),
            querySource: "compact",
            toolCount: prepared.request.tools.length,
            compactPromptTooLongRetry: compactPromptTooLongAttempts,
          },
          modelTraceContext,
        );
        await this.appendEvent(modelRequestEvent, modelTraceContext);
        events.push(modelRequestEvent);
        const modelStartedAt = Date.now();
        const networkEventStartIndex = events.length;
        const compactSummaryMaxOutputTokens = capCompactSummaryMaxOutputTokens(this, compactModel);
        using statusSink = this.createModelStatusSink(modelTraceContext, events);
        const compactModelRequest = {
          abortSignal: options.abortSignal,
          maxOutputTokens: compactSummaryMaxOutputTokens,
          messages: projectedRequestMessages,
          metadata: traceContextToLogContext(modelTraceContext),
          modelCall: {
            attributes: {
              compactionOuterAttempt: attempt,
              compactionTrigger: trigger,
            },
            operation: "context_compaction" as const,
            operationId: compactTimeline.operationId,
          },
          statusSink,
          // compact 的首个真实 provider event 结束 SSE retry 资格；隐藏 partial 在
          // content block 提交前仍可丢弃并 HTTP fallback，block end 后则禁止任何重放。
          preserveProviderStreamBoundaries: true,
          traceContext: modelTraceContext,
          tools: prepared.request.tools,
          toolSearchEnabled: prepared.request.toolSearchEnabled,
          refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
            abortSignal: options.abortSignal,
            model: compactModel,
            traceContext: modelTraceContext,
          }),
        };

        try {
          result = await runCompactSummaryModelRequest({
            logger: this.logger,
            model: compactModel,
            request: compactModelRequest,
          });
        } catch (error) {
          await recordModelUsageFact(this, {
            attemptIndex: compactPromptTooLongAttempts,
            error,
            events,
            model: compactModel,
            networkEventStartIndex,
            querySource: "compact",
            startedAt: modelStartedAt,
            status: isTurnCancellationError(error, options.abortSignal) ? "cancelled" : "error",
            traceContext: modelTraceContext,
          });
          if (isTurnCancellationError(error, options.abortSignal)) {
            throw error;
          }
          if (isModelMediaTooLargeError(error) && !stripMediaForSummary) {
            stripMediaForSummary = true;
            this.logger?.info(
              "Compact summary hit media-size error; retrying with stripped media",
              {
                ...traceContextToLogContext(modelTraceContext),
                errorMessage: error instanceof Error ? error.message : String(error),
                event: "compact.request.media_too_large.retry",
                module: "core.runtime",
              },
            );
            continue;
          }
          if (isModelContextExceededError(error)) {
            if (reselectEntriesAfterPromptTooLong(error)) continue;
            if (truncateEntriesAfterPromptTooLong(error)) continue;
            throw createCompactPromptTooLongError({
              attempt: compactPromptTooLongAttempts,
              cause: error,
              preCompactTokenCount,
            });
          }
          throw error;
        }

        await recordModelUsageFact(this, {
          attemptIndex: compactPromptTooLongAttempts,
          events,
          model: compactModel,
          networkEventStartIndex,
          querySource: "compact",
          result,
          startedAt: modelStartedAt,
          status: "completed",
          toolCallCount: this.extractToolCallsFromResult(result).length,
          traceContext: modelTraceContext,
        });
        const contextError = createCompactContextExceededFinishError(result);
        if (contextError) {
          // compact summary 也可能以 finishReason 返回超窗而不是 throw；
          // 必须先进入同一套 recent preserve 重选逻辑，避免 finishReason 路径丢上下文。
          if (reselectEntriesAfterPromptTooLong(contextError)) continue;
          if (truncateEntriesAfterPromptTooLong(contextError)) continue;
          throw createCompactPromptTooLongError({
            attempt: compactPromptTooLongAttempts,
            cause: contextError,
            preCompactTokenCount,
          });
        }
        warnCompactSummaryOutputLimit(this, result, {
          maxOutputTokens: compactSummaryMaxOutputTokens,
          traceContext: modelTraceContext,
          trigger,
        });
        break;
      }

      const summary = formatCompactSummaryOrThrow(this, result, modelTraceContext);
      const persistedSummary = summary;
      // 修复原因：文件恢复曾用读取状态里缓存的视图，补回的可能是旧内容或片段；现在重读当前文件。
      // plan 文件、补回文件和指令文件互不依赖，并行读取。
      const [planFileReferenceEntry, fileRestore, instructionReread] = await Promise.all([
        this.fileSystemPort
          ? readApprovedPlanFileReferenceEntry({
              abortSignal: options.abortSignal,
              fileSystemPort: this.fileSystemPort,
              sessionId: this.sessionId,
              traceContext: modelTraceContext,
              workspaceRoot: this.workspaceRoot,
            })
          : undefined,
        restorePostCompactFiles(this, {
          abortSignal: options.abortSignal,
          preservedEntries,
          traceContext: modelTraceContext,
        }),
        rereadInstructionSources(this, modelTraceContext, options.abortSignal),
      ]);
      // Bug 根因：compact 丢弃旧公告后曾依赖下一次请求补齐，纯 Continue 无正常收集机会。
      // 在取消检查后按保留历史重建，使用继续执行的作用域，不使用摘要候选工具。
      throwIfTurnAborted(options.abortSignal);
      // 重读的指令内容只用于 summary 之前的完整公告；compact 落库后才交给 runtime。
      const rereadInstructionContext = instructionReread
        ? buildRereadInstructionContext(this, instructionReread, compactModel)
        : undefined;
      const preCompactDiscoveredTools = collectDiscoveredTools(activeEntries);
      const discovery = compactDiscoveryMetadata({
        boundaryId: createCompactBoundaryId(),
        preCompactDiscoveredTools: [...preCompactDiscoveredTools],
      });
      // 新检查点尚未提交；公告使用同一候选分类，避免把即将提升的工具重新公告为待加载。
      const toolSearchDelivery = compactToolSearchDelivery(
        activeEntries,
        preservedEntries,
        (name) => registry.get(name) !== undefined,
      );
      const deliveryCarrier = {
        message: { role: "user" as const, content: "" },
        toolSearchDelivery,
      };
      const toolAnnouncement = buildToolSearchAnnouncement(
        {
          model: compactModel,
          mode: this.config.toolSearch?.mode,
          tools: options.getContinuationTools?.() ?? this.getTools(compactModel),
          registry,
          entries: [...preservedEntries, deliveryCarrier],
          mcp: this.mcpServerStatusFacts,
        },
        preCompactDiscoveredTools,
      );
      const agentListingEntry = collectRuntimeAgentListing(
        this,
        preservedEntries,
        options.agentListingTools ?? this.getTools(options.model ?? compactModel),
      );
      const skillsListingEntry = collectSkillsListing(
        this,
        preservedEntries,
        options.agentListingTools ?? this.getTools(options.model ?? compactModel),
      );
      // 保留段非空时，请求前公告放在 summary 之前（去掉保留段已有的来源），Git 按当前目录重读；
      // 保留段为空时由下一次请求的请求前公告追加在末尾，Git 也在那时读取。
      const leadingReminderEntries =
        preservedEntries.length > 0
          ? buildCompactLeadingAnnouncements(
              this,
              preservedEntries,
              await resolveSessionContextAnnouncement(
                this,
                preservedEntries,
                "compaction",
                modelTraceContext,
                options.abortSignal,
              ),
              rereadInstructionContext,
            )
          : [];
      // 计划模式下 compaction 重发完整的 plan 提醒。
      // 修复原因：输入附件与 auto/reactive compaction 在同一次循环中，且先于 compaction 收集；
      // 保留段可能已带本次收集的完整提醒，无条件重发会出现两条完整提醒，周期也多算一次。
      // 保留段只有简短提醒时，完整说明已被摘要，仍要重发。
      // 修复原因：这里曾不区分子会话，子会话 compact 后又收到主会话的五阶段提醒；与轮内收集共用选择逻辑。
      const planModeReminderBody = hasFullRuntimeModeReminder(preservedEntries)
        ? null
        : buildRuntimeModeReminderBodyForTask([], {
            mode: this.getMode(),
            planEnabled: this.getPlanEnabled(),
            taskType: this.config.taskType,
            tools: compactCandidates,
          });
      const compactSessionStart = await runCompactSessionStartHooks(
        this,
        preservedEntries,
        turnTraceContext,
        options.abortSignal,
        compactModel,
      );
      // hook runner 把取消当作单个 hook 失败，不会抛错；hook 返回后要再检查一次取消，
      // 否则 hook 运行期间点停止，compaction 仍会提交。
      throwIfTurnAborted(options.abortSignal);
      // 后台任务状态：summary 返回后读一次本 runtime 的注册表，之后结束的任务由通知队列送达。
      const continuationToolNames = (
        options.agentListingTools ?? this.getTools(options.model ?? compactModel)
      ).map((tool) => tool.name);
      const taskStatusEntries = buildCompactTaskStatusEntries({
        branchGeneration: this.branchGeneration,
        canContinueAgent: continuationToolNames.includes(SEND_MESSAGE_TOOL_NAME),
        canReadOutputFile: canReadBackgroundOutputFile(continuationToolNames),
        now: this.now(),
        tasks: Object.values(this.runtimeTaskRegistry.all()),
      });
      // compaction 附件顺序：文件恢复 → 任务状态 → plan 文件 → plan 提醒 → ToolSearch 公告
      // → agent listing → skill 列表 → 环境 → 模型 → 输出风格 → 回复语言 → compact SessionStart 上下文。
      // 修复原因：agent listing 排在文件恢复之前，顺序错误。
      const postCompactReminderEntries = [
        ...fileRestore.entries,
        ...taskStatusEntries,
        ...(planFileReferenceEntry ? [planFileReferenceEntry] : []),
        ...(planModeReminderBody
          ? [systemReminderAttachmentEntry("runtime_mode", planModeReminderBody)]
          : []),
        ...(toolAnnouncement ? [toolAnnouncement] : []),
        ...(agentListingEntry ? [agentListingEntry] : []),
        ...(skillsListingEntry ? [skillsListingEntry] : []),
        ...restateContextAfterCompact(this, activeEntries, preservedEntries),
        ...(compactSessionStart.entry ? [compactSessionStart.entry] : []),
      ];

      const modelCompleteEvent = this.createEvent(
        SessionEventType.ModelComplete,
        {
          content: summary,
          stopReason: result.finishReason,
          usage: result.usage,
          querySource: "compact",
          toolCallCount: 0,
        },
        modelTraceContext,
      );
      await this.appendEvent(modelCompleteEvent, modelTraceContext);
      events.push(modelCompleteEvent);

      const summaryMessageId = createMessageId();
      const summaryMessageContent = buildCompactSummaryMessage(persistedSummary, {
        // 与 summary 之前的请求前公告用同一判定：保留段非空。
        preservedMessagesKept: preservedEntries.length > 0,
        suppressFollowup: true,
      });
      const preservation = this.sessionStore
        ? await selectPersistedCompactTail({
            sessionStore: this.sessionStore,
            sessionId: this.sessionId,
            groupsPreserved: currentSelection.groupsPreserved,
            summaryMessageId,
          })
        : { keptMessageCount: countCompactPreservedRuntimeMessages(preservedEntries) };
      // 新写入的记录（请求前公告、summary、compaction 附件）与它们的 live 条目用同一个时间；
      // 保留段条目带着原时间。静默提醒按条目时间计时，冷恢复读回的时间与 live 相同。
      const compactCreated = this.now().getTime();
      const withCompactTime = (entries: readonly RuntimeMessageEntry[]) =>
        entries.map((entry) => ({ ...entry, time: compactCreated }));
      const leadingEntries = withCompactTime(leadingReminderEntries);
      const postCompactAttachmentEntries = withCompactTime(postCompactReminderEntries);
      const summaryEntry = {
        message: { role: "user" as const, content: summaryMessageContent },
        metadata: { ...legacySyntheticRuntimeMetadata(), compactBoundary: discovery },
        ...(toolSearchDelivery ? { toolSearchDelivery } : {}),
        time: compactCreated,
      };
      const postCompactEntries = buildPostCompactRuntimeEntries(activeEntries, summaryEntry, {
        leadingReminderEntries: leadingEntries,
        postCompactReminderEntries: postCompactAttachmentEntries,
        preservedEntries,
      });
      const truePostCompactTokenCount = estimateRuntimeEntryTokens(postCompactEntries, {
        useMidConversationSystem,
      });
      const providerPostCompactTokenCount = getUsageTotalTokens(result.usage);
      const compactBoundary = buildManualCompactBoundary({
        ...discovery,
        autoCompactThreshold: options.autoCompactThreshold,
        compactReason,
        customInstructions,
        lastSummarizedMessageId,
        phase,
        postCompactTokenCount: providerPostCompactTokenCount,
        preCompactTokenCount,
        summarizedMessageCount: entriesToSummarize.length,
        summaryMessageId,
        traceContext: turnTraceContext,
        trigger,
        ...(currentSelection.groupsPreserved > 0
          ? {
              keptMessageCount: preservation.keptMessageCount,
            }
          : {}),
        preservedSegment: preservation.preservedSegment,
        truePostCompactTokenCount,
        willRetriggerNextTurn:
          options.autoCompactThreshold !== undefined
            ? truePostCompactTokenCount >= options.autoCompactThreshold
            : undefined,
      });

      // 发现检查点跟随 summary 原子保存；持久化成功后才替换 Runtime 历史。
      await this.persistCompactSummary(
        summaryMessageId,
        summaryMessageContent,
        persistedSummary,
        compactBoundary,
        modelTraceContext,
        {
          created: compactCreated,
          model: compactModel,
          operationId: compactTimeline.operationId,
          leadingReminderEntries: leadingEntries,
          postCompactReminderEntries: postCompactAttachmentEntries,
          toolSearchDelivery,
        },
      );

      const compactBoundaryEvent = this.createEvent(
        SessionEventType.CompactBoundary,
        compactBoundary,
        turnTraceContext,
      );
      await this.appendEvent(compactBoundaryEvent, turnTraceContext);
      events.push(compactBoundaryEvent);

      const compactCompletedPayload = this.buildCompactTimelinePayload(compactTimeline, {
        ...(maxAttempts > 1 ? { attempt, maxAttempts } : {}),
        boundaryId: compactBoundary.boundaryId,
        endedAt: Date.now(),
        postCompactTokenCount: providerPostCompactTokenCount,
        replace: true,
        status: CompactTimelineStatus.Completed,
        summaryMessageId,
        tailStartMessageId: lastSummarizedMessageId,
        truePostCompactTokenCount,
      });
      await persistCompactTimelineEvent(
        this,
        SessionEventType.CompactCompleted,
        compactCompletedPayload,
        turnTraceContext,
        events,
      );

      // compaction 已提交：compact 有结果时替换还没提交的 startup / resume 结果；没有结果时保留，下一轮照常提交。
      if (compactSessionStart.hasContext) discardPendingSessionStartContext(this);
      this.latestConversationMessageId = summaryMessageId;
      this.messageHistory.replaceMessages(
        options.activeEntries
          ? preserveCanonicalContextPrefix(
              this.messageHistory.borrowReadOnlyRuntimeEntries(),
              postCompactEntries,
            )
          : postCompactEntries,
      );
      replaceReadFileStateAfterCompact(this.readFileState, fileRestore.readFileStateEntries);
      if (instructionReread) {
        applyRereadInstructionSources(this, instructionReread, compactModel);
        // MEMORY.md 的读取状态与 runtime 持有的索引一致；必须在上面的整表替换之后写入。
        if (instructionReread.memoryIndex) {
          setReadFileStateEntry(
            this.readFileState,
            instructionReread.memoryIndex.readFileStateEntry,
          );
        }
      }
      resetProjectMemoryRecall(this);
      // compaction 之后的窗口按当前代码重新组装 system：清掉 prompt 快照，并重建历史和
      // 本轮请求的前缀，下一次主循环请求重新记录。不重建时旧 system 会被当成新快照记下来。
      const entries = (await clearPromptSnapshot(this, turnTraceContext))
        ? rebuildContextPrefix(this, {
            model: compactModel,
            turnRequestEntries: postCompactEntries,
          })
        : postCompactEntries;
      supersedeContextComposition(this, "compact");

      return {
        displayText: "Compacted",
        entries,
        outcome: "compacted",
        tokenCount: providerPostCompactTokenCount,
      };
    } catch (error) {
      if (
        trigger === CompactTrigger.Auto &&
        attempt < maxAttempts &&
        !isTurnCancellationError(error, options.abortSignal) &&
        isAutoCompactRetryableError(error)
      ) {
        attempt += 1;
        const retryPayload = this.buildCompactTimelinePayload(compactTimeline, {
          attempt,
          maxAttempts,
          reason: compactFailureReasonFromError(error),
          status: CompactTimelineStatus.Retrying,
        });
        // 自动 compact 的中间失败不能提前落成 failed 横线。
        // 这里在同一个 operation 上发 retrying，直到第 3 次仍失败才写最终 failed。
        await persistCompactTimelineEvent(
          this,
          SessionEventType.CompactStarted,
          retryPayload,
          turnTraceContext,
          events,
        );
        this.logger?.warn("Auto compact retrying", {
          ...traceContextToLogContext(turnTraceContext),
          attempt,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "compact.auto.retrying",
          maxAttempts,
          module: "core.runtime",
          timelineStatus: CompactTimelineStatus.Retrying,
        });
        currentSelection = initialSelection;
        preservedEntries = currentSelection.preservedEntries;
        entriesForSummary = initialEntriesForSummary;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        continue;
      }
      await this.finishCompactTimelineFailure({
        abortSignal: options.abortSignal,
        attempt,
        error,
        events,
        maxAttempts: maxAttempts > 1 ? maxAttempts : undefined,
        timeline: compactTimeline,
        traceContext: turnTraceContext,
      });
      throw error;
    }
  }
}

function isAutoCompactRetryableError(error: unknown): boolean {
  return isCoreError(error) ? error.retryable : true;
}

function canUseCompactSummaryTruncationFallback(trigger: CompactTrigger): boolean {
  return trigger !== CompactTrigger.Auto && trigger !== CompactTrigger.Reactive;
}

function selectInitialCompactEntriesForActiveConversation(input: {
  activeEntries: readonly RuntimeMessageEntry[];
  initialPromptTooLongCause?: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
}) {
  const baseSelection = selectCompactEntries({
    entries: input.activeEntries,
    trigger: input.trigger,
  });
  if (input.initialPromptTooLongCause === undefined) {
    return baseSelection;
  }

  return (
    selectCompactEntriesForInitialPromptTooLong({
      entries: input.activeEntries,
      promptTooLongCause: input.initialPromptTooLongCause,
      trigger: input.trigger,
      useMidConversationSystem: input.useMidConversationSystem,
    }) ?? baseSelection
  );
}

function capCompactSummaryMaxOutputTokens(runtime: AgentRuntimeInternal, model: Model): number {
  // 修复原因：摘要曾固定封顶 20K，推理和 <analysis> 也挤在里面，大窗口会话常被 length 截断。
  // 现在直接取 Auto Compact reserve：触发时这部分窗口正好留给摘要，大窗口按窗口比例加大。
  // 不按 usage 估算剩余窗口：截断旧轮或剥离媒体后重试时，留下的旧 usage 已过期，会算错上限。
  return getAutoCompactOutputReserveTokens(resolveAutoCompactPolicyConfig(runtime, model));
}
