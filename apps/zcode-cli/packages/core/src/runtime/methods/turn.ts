import {
  PLUGIN_DISCOVERY_INPUT,
  beginLocalTurnPreparation,
  type LocalTtftDetail,
} from "@zcode/contracts";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import {
  buildLifecycleHookContextEntry,
  commitPendingSessionStartContext,
  stageSessionStartContext,
} from "./hooks.js";
import { refreshWorkspaceTrustAdmission } from "./mcp.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import {
  ensureGroupTaskPermissionScope,
  telemetryInputOrigin,
  TELEMETRY_INPUT_ORIGIN_ATTRIBUTE,
} from "./input-intent-persistence.js";
import { prepareOffPeakTurn } from "../off-peak/runtime.js";
import {
  CoreErrorType,
  HookEventName,
  SessionEventType,
  createChildTraceContext,
  createQueryId,
  createModelUsageSummaryFromEvents,
  createMessageId,
  createTurnId,
  runWithContextAsync,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import type {
  HookRunResult,
  MessageId,
  MessagePart,
  Model,
  ModelSelection,
  QueryId,
  SessionEvent,
  SessionGoal,
  TurnState,
} from "../deps.js";
import {
  parseCompactCommand,
  parseRewindCommand,
  createTurnAbortScope,
  throwIfTurnAborted,
  createTurnFailureError,
  isExternalTurnFault,
  isTurnCancellationError,
  appendTurnOutcomeEvent,
  buildRuntimeUserEntriesFromTurn,
  buildUserContentFromTurn,
  logResolvedTurnAttachments,
  resolveTurnAttachments,
  summarizeTurnAttachmentsForEvent,
  runtimeMetadataForSyntheticUserMessageSource,
} from "../helpers/index.js";
import type { ActiveTurnSteeringState, ExecuteTurnOptions, TurnResult } from "../types.js";
import type { ActiveTurnStartReservation } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { PromptRuntimeCommand } from "../command-queue.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";
import { buildReferencedSessionContextReminderBody } from "../../session-context/references.js";
import { runRegularTurnLoop } from "./turn-loop.js";
import { appendInterruptMarker } from "./interrupt-marker.js";
import {
  maybeStartDeferredSessionTitleGeneration,
  maybeStartSessionTitleGeneration,
} from "./session-title.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { finishOutputTokenRecovery } from "./turn-output-token-continuation.js";
import { recordTurnUsageFact } from "./usage-observability.js";
import { persistStableForkCompletionBoundary } from "./stable-fork-boundary.js";
import {
  closeGoalStateChangeReminderDeferral,
  openGoalStateChangeReminderDeferral,
} from "./goal-state-reminder.js";
import {
  disposeProjectMemoryRecallPrefetch,
  startProjectMemoryRecallPrefetch,
} from "../helpers/project-memory-recall.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../../memory/project-memory-retrieval-branch.js";
import { scheduleProjectMemoryExtraction } from "../helpers/project-memory-extraction.js";
import { appendBrowserTurnScreenshot } from "./browser-turn-screenshot.js";
import { clearBrowserTurnState } from "../../repl/browser-turn-state.js";
import {
  acceptSubmissionModelSelection,
  captureHighspeedFallbackSelection,
  applySubmissionExecutionState,
  createTurnModel,
  resolveExecutionModelRetryBudget,
} from "./turn-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import {
  matchExecutionSelectionCreationFallback,
  resolveExecutionFallbackCandidates,
} from "./turn-execution-fallback.js";

const TARGET_RUN_HEARTBEAT_MS = 15_000;
const MODEL_CREATION_FAILED_MESSAGE = "Model creation failed";
const MODEL_CREATION_TURN_PHASE = "model_creation";
const TURN_EXECUTION_FAILED_MESSAGE = "Turn execution failed";

export async function executeTurn(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
): Promise<TurnResult> {
  if (options?.modelExecution) {
    options = {
      ...options,
      modelExecution: captureHighspeedFallbackSelection(this, options.modelExecution),
    };
  }
  return await enqueueCancellableRuntimeCommand<TurnResult, PromptRuntimeCommand>(this, {
    abortSignal: options?.abortSignal,
    onCommandAccepted: () => {
      // 原始 executeTurn 与协议 admission 共用接纳语义；Loop 开始后不再倒写旧选择。
      void acceptSubmissionModelSelection(
        this,
        options?.intent,
        options?.traceContext ?? this.rootTraceContext,
        options?.modelExecution,
      ).catch((error) => {
        this.logger?.warn("Accepted model selection projection failed", { error: String(error) });
      });
    },
    createCommand: ({ reject, resolve }) => ({
      attachments,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input,
      mode: "prompt",
      options,
      priority: "next",
      reject,
      resolve,
      traceContext: options?.traceContext ?? this.rootTraceContext,
    }),
  });
}

export async function executeTurnCommand(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
  startReservation?: ActiveTurnStartReservation,
): Promise<TurnResult> {
  // 普通 Turn 过去在异步初始化完成后才读取 Session Selection/输出样式，
  // 初始化期间发生的切模会越过 admission 边界，错误影响已经开始的 Turn。
  // 这里在任何 await 之前冻结本轮事实；后续配置变化只作用于下一轮。
  const offPeakTurn = prepareOffPeakTurn(this, options);
  options = offPeakTurn.options;
  const admittedModelSelection =
    options?.intent?.modelSelection ??
    (options && "executionSelection" in options
      ? options.executionSelection
      : this.getSessionModelSelection());
  // 加速轮期间新输入可以更新 Session 续跑选择；卡过期必须回到本轮启动时的普通模型。
  const highspeedFallbackSelection = options?.modelExecution?.selectionFallback
    ? structuredClone(
        "highspeedFallbackSelection" in options.modelExecution
          ? options.modelExecution.highspeedFallbackSelection
          : this.getSessionModelSelection(),
      )
    : undefined;
  const admittedOutputStyle = this.config.outputStyle;
  const compactInstructions = parseCompactCommand(input);
  const rewindCommand = parseRewindCommand(input);
  const turnId = startReservation?.turnId ?? createTurnId();
  const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined) ?? createQueryId();
  const displayInput = options?.displayInput ?? input;
  const inputOrigin = telemetryInputOrigin(options?.intent, options?.traceContext?.attributes);
  const baseTurnTraceContext =
    startReservation?.traceContext ??
    createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
      queryId,
      sessionId: this.sessionId,
      turnId,
      attributes: {
        turnNumber: this.turnNumber,
      },
    });
  const turnTraceContext = inputOrigin
    ? {
        ...baseTurnTraceContext,
        attributes: {
          ...baseTurnTraceContext.attributes,
          [TELEMETRY_INPUT_ORIGIN_ATTRIBUTE]: inputOrigin,
        },
      }
    : baseTurnTraceContext;
  const traceId = turnTraceContext.traceId;
  const turnStartedAtMs = Date.now();
  const targetRunInputID = options?.inputId ?? String(turnId);
  const events: SessionEvent[] = [];
  let turnMachine = TurnMachineImpl.create(this.sessionId, this.turnNumber, input, traceId, turnId);
  this.currentTurnFileChanges = new Map();
  if (!startReservation) this.reserveTurnStart(turnId, turnTraceContext, "regular");

  const turnAbortScope = createTurnAbortScope(options?.abortSignal);
  const turnAbortSignal = turnAbortScope.signal;
  let activeTurn: ActiveTurnSteeringState | undefined;
  let startedTarget: SessionGoal | null = null;
  let targetRunHeartbeat: ReturnType<typeof setInterval> | undefined;
  let userMessageId: MessageId | undefined;
  let loopState: RegularTurnLoopState | undefined;
  let shouldRetryTitleGenerationAfterTurn = false;
  // 线上“已工作 N 秒”但没有终态的根因候选是：内层 Turn try/catch 之前的 await
  // 拒绝直接穿出。记录当前阶段并区分是否已被内层处理，便于生产日志还原卡点。
  let turnPhase = "queued";
  let turnFailureHandled = false;
  let finishPreparation: () => void = () => {};
  const preparationStages: Record<string, LocalTtftDetail["stage"]> = {
    context_initialization: "context",
    session_start_hooks: "hooks",
    user_prompt_hooks: "hooks",
    session_persistence: "persistence",
    turn_started_event: "persistence",
    target_accounting: "persistence",
  };
  const startTurnPhase = (phase: string): number => {
    const stage = preparationStages[phase];
    finishPreparation =
      stage && stage !== "attempt" && stage !== "retry_wait" && stage !== "user_confirmation"
        ? beginLocalTurnPreparation(turnTraceContext, stage)
        : () => {};
    turnPhase = phase;
    const startedAt = Date.now();
    this.logger?.info("Turn phase started", {
      ...traceContextToLogContext(turnTraceContext),
      event: "turn.phase.started",
      module: "core.runtime",
      phase,
      status: "started",
    });
    return startedAt;
  };
  const completeTurnPhase = (phase: string, startedAt: number): void => {
    finishPreparation();
    this.logger?.info("Turn phase completed", {
      ...traceContextToLogContext(turnTraceContext),
      durationMs: Date.now() - startedAt,
      event: "turn.phase.completed",
      module: "core.runtime",
      phase,
      status: "completed",
    });
  };
  const turnTelemetry = this.agentTelemetry.turn({
    inputSource: options?.inputSource,
    traceContext: turnTraceContext,
    turnNumber: this.turnNumber,
  });

  const execute = () =>
    runWithContextAsync(turnTraceContext, async () => {
      const executionStartedAt = performance.timeOrigin + performance.now();
      beginLocalTurnPreparation(turnTraceContext, "execution")();
      throwIfTurnAborted(turnAbortSignal);
      let admittedModel: Model | undefined;
      let effectiveExecutionSelection = admittedModelSelection;
      let effectiveRequestDependencies = options?.modelExecution?.requestDependencies;
      let creationFallback:
        | {
            reason: "highspeed_selection_unavailable";
            fromModelSelection: ModelSelection;
            toModelSelection: ModelSelection;
          }
        | undefined;
      // 普通轮创建模型失败后仍要保留已接纳输入；这里只记下原始错误，由主生命周期落库并收尾。
      let creationFailure: { error: unknown } | undefined;
      // 创建期退回声明命中但所有候选都无法创建：TurnError 归因要带上该事实，Renderer 才能作废匹配卡。
      let creationFallbackUnavailable = false;
      try {
        admittedModel =
          rewindCommand === null
            ? createTurnModel(this, {
                requestDependencies: options?.modelExecution?.requestDependencies,
                selection: admittedModelSelection,
                // 带退回声明的执行句柄 0 次重试：失败立刻交给 turn step 退回会话模型。
                retryBudget: resolveExecutionModelRetryBudget({
                  selection: admittedModelSelection,
                  selectionFallback: options?.modelExecution?.selectionFallback,
                }),
              })
            : undefined;
      } catch (error) {
        let reportedCreationError = error;
        const creationFallbackMatch = matchExecutionSelectionCreationFallback({
          error,
          selection: admittedModelSelection,
          selectionFallback: options?.modelExecution?.selectionFallback,
          selectionScope: options?.modelExecution?.selectionScope,
        });
        const selectionFallback = options?.modelExecution?.selectionFallback;
        if (creationFallbackMatch && admittedModelSelection && selectionFallback) {
          const skippedCandidates: Array<{
            source: string;
            providerId: string;
            modelId: string;
            error: string;
          }> = [];
          const candidates = resolveExecutionFallbackCandidates({
            declaredTarget: selectionFallback.target,
            executionProviderId: admittedModelSelection.providerId,
            sessionSelection: highspeedFallbackSelection,
          });
          for (const candidate of candidates) {
            try {
              admittedModel = createTurnModel(this, { selection: candidate.selection });
              effectiveExecutionSelection = candidate.selection;
              effectiveRequestDependencies = undefined;
              creationFallback = {
                reason: creationFallbackMatch.reason,
                fromModelSelection: admittedModelSelection,
                toModelSelection: candidate.selection,
              };
              this.logger?.warn(
                "Execution model selection was unavailable; falling back before the request",
                {
                  ...traceContextToLogContext(turnTraceContext),
                  event: "model.execution_selection.creation_fallback",
                  module: "core.runtime",
                  status: "completed",
                  reason: creationFallbackMatch.reason,
                  fromProviderId: admittedModelSelection.providerId,
                  fromModelId: admittedModelSelection.modelId,
                  toProviderId: candidate.selection.providerId,
                  toModelId: candidate.selection.modelId,
                  toSource: candidate.source,
                  ...(skippedCandidates.length > 0 ? { skippedCandidates } : {}),
                  errorMessage: error instanceof Error ? error.message : String(error),
                },
              );
              break;
            } catch (fallbackError) {
              // Highspeed 已确认不可用后，若普通模型也无法创建，用户应看到可操作的普通模型错误，
              // 不能继续暴露隐藏执行 Provider 的 Registry 错误。
              reportedCreationError = fallbackError;
              skippedCandidates.push({
                source: candidate.source,
                providerId: candidate.selection.providerId,
                modelId: candidate.selection.modelId,
                error:
                  fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
              });
            }
          }
          if (!creationFallback) {
            creationFallbackUnavailable = true;
            this.logger?.warn(
              "Execution model selection was unavailable and no fallback model could be created",
              {
                ...traceContextToLogContext(turnTraceContext),
                event: "model.execution_selection.creation_fallback_unavailable",
                module: "core.runtime",
                status: "failed",
                reason: creationFallbackMatch.reason,
                fromProviderId: admittedModelSelection.providerId,
                fromModelId: admittedModelSelection.modelId,
                skippedCandidates,
                errorMessage: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
        // Bug 根因：Provider/Model 在 Registry 中短暂缺失时，旧逻辑在请求前直接结束 Turn，
        // 请求期 selectionFallback 永远没有机会运行。成功创建声明目标后继续既有 Turn 主链。
        if (!admittedModel) {
          if (compactInstructions === null) {
            // Bug 根因：edit/retry 的 branch cut 已提交后，Registry 仍可能在 Core 创建模型前变化；
            // 已接纳输入必须提升为 TurnStarted + 持久消息，否则只剩历史截断，重启也无法恢复文本。
            // CR-01：上一版复制了一份落库流程并在主 try 外执行，附件、取消或存储失败会直接穿出，
            // TurnStarted 之后没有终态，原始创建错误也被覆盖。这里只记下错误，落库与终态交给主链。
            creationFailure = { error: reportedCreationError };
          } else {
            // /compact 不产生用户消息，创建失败直接写终态。
            turnFailureHandled = true;
            const coreError = createTurnFailureError(
              reportedCreationError,
              turnAbortSignal,
              MODEL_CREATION_FAILED_MESSAGE,
            );
            await appendTurnOutcomeEvent(this, {
              coreError,
              events,
              durationMs: Date.now() - turnStartedAtMs,
              turnPhase: MODEL_CREATION_TURN_PHASE,
              inputId: options?.inputId,
              // 卡身份仍以接纳时冻结的 intent 为准，不能依赖分页窗口中的 userInput 反查。
              highspeedCardId: options?.intent?.highspeed?.cardId,
              highspeedFallbackUnavailable: creationFallbackUnavailable,
              traceContext: turnTraceContext,
              fallbackMessage: MODEL_CREATION_FAILED_MESSAGE,
              logEvent: "turn.failed",
              logLabel: "Turn",
            });
            throw coreError;
          }
        }
      }
      let phaseStartedAt: number;
      // Bug 根因：创建错误确定后仍执行 Context/SessionStart，会在 TurnStarted 前被二次 I/O 错误覆盖，
      // 并提前消费一次性 SessionStart。失败轮跳过它们，只复用后续输入持久化与终态主链。
      if (!creationFailure) {
        phaseStartedAt = startTurnPhase("context_initialization");
        if (this.contextInitialized) {
          // 每个后续 model step 都按该步骤实际持有的 Model 重新投影 Context；
          // Session Selection 只决定未来创建哪个 Model，不能充当执行事实。
          rebuildContextPrefix(this, { model: admittedModel });
        } else {
          // 首轮初始化已经用 admitted Model 构造并安装完整 Context，随后再 rebuild
          // 会把同一 Prefix 连续构造两次。未初始化与已初始化分支互斥，每个 model step 只构造一次。
          await this.ensureContextInitialized(turnTraceContext, admittedModel);
        }
        completeTurnPhase("context_initialization", phaseStartedAt);
        throwIfTurnAborted(turnAbortSignal);
        phaseStartedAt = startTurnPhase("session_start_hooks");
        const sessionStartHookResult = await this.runSessionStartHooks(
          "startup",
          turnTraceContext,
          turnAbortSignal,
          admittedModel,
        );
        completeTurnPhase("session_start_hooks", phaseStartedAt);
        // 首轮会话行还没创建，结果先放进待写槽，会话写库后再提交（见下方 session_persistence）。
        stageSessionStartContext(this, sessionStartHookResult.additionalContexts);
      }

      if (compactInstructions !== null) {
        const compactModel = await applySubmissionExecutionState(
          this,
          options?.intent,
          turnTraceContext,
          options?.modelExecution,
          admittedModel,
        );
        return this.executeManualCompact(
          input,
          compactInstructions,
          turnId,
          turnTraceContext,
          turnAbortSignal,
          options?.inputId,
          compactModel,
        );
      }
      if (rewindCommand !== null) {
        return this.executeRewindCommand(
          input,
          rewindCommand,
          turnId,
          turnTraceContext,
          turnAbortSignal,
          options?.inputId,
        );
      }
      // 创建失败轮不会进入 model step，guide 无法被消费；不可 steer 时调用方会改走队列。
      activeTurn = this.beginActiveTurn(
        turnId,
        turnTraceContext,
        "regular",
        creationFailure === undefined,
        {
          ...(options?.inputId === undefined ? {} : { inputId: options.inputId }),
        },
      );
      this.logger?.info("Turn started", {
        ...traceContextToLogContext(turnTraceContext),
        event: "turn.started",
        inputLength: input.length,
        module: "core.runtime",
        status: "started",
      });

      turnMachine = new TurnMachineImpl(turnMachine.start());
      phaseStartedAt = startTurnPhase("session_persistence");
      await this.ensureSessionPersisted(displayInput, turnTraceContext);
      // SessionStart（startup / resume / fork）的上下文写在本轮输入之前。
      // 修复原因：以前只写内存，冷恢复后丢失，请求前缀改变、缓存失效。
      await commitPendingSessionStartContext(this, turnTraceContext);
      await this.persistPendingWorktreeCreationTimeline(turnTraceContext);
      await ensureGroupTaskPermissionScope(this.sessionStore, this.sessionId, options?.intent);
      // execution-scoped 临时 Provider（例如闲时任务）拥有本轮自己的模型，不改写
      // Session Selection；普通 Submission 才在真正开跑时应用其原子选择。
      // 创建失败轮不再应用：重复建模会在主 try 之外再次抛错；也不改写选择、mode、plan，
      // 不占用目标轮次。
      const submissionModel = creationFailure
        ? undefined
        : await applySubmissionExecutionState(
            this,
            options?.intent,
            turnTraceContext,
            options?.modelExecution,
            admittedModel,
          );
      startedTarget = creationFailure
        ? null
        : await this.readSessionTargetForContext(turnTraceContext);
      completeTurnPhase("target_read", phaseStartedAt);
      if (startedTarget?.status !== "active") {
        startedTarget = null;
      }
      userMessageId =
        options?.skipInputRecord === true
          ? (options.recordedInputMessageId ?? createMessageId())
          : createMessageId();
      // 附件展示元信息随 TurnStarted 下发（v4 投影 → userInput row.attachments）。
      // workspace checkpoint 挂在 user messageId 上；先生成 id 再发 TurnStarted，
      // v4 投影才能用 turn rowId 找回该轮文件 checkpoint，避免摘要有计数但展开查空。
      const attachmentMetas = summarizeTurnAttachmentsForEvent(attachments);
      const turnStartedEvent = this.createEvent(
        SessionEventType.TurnStarted,
        {
          executionStartedAt,
          turnNumber: this.turnNumber,
          input: displayInput,
          messageId: userMessageId,
          inputId: options?.inputId,
          ...(options?.automationId
            ? { automationId: options.automationId }
            : options?.offPeakTaskId
              ? {
                  offPeakTaskId: options.offPeakTaskId,
                  ...(options.offPeakRunType ? { offPeakRunType: options.offPeakRunType } : {}),
                }
              : {}),
          foregroundExecutionId: this.activeForegroundExecution?.foregroundExecutionId,
          queryId,
          inputSource: options?.inputSource,
          ...(inputOrigin ? { inputOrigin } : {}),
          inputVisibility: options?.inputVisibility,
          originMeta: options?.originMeta,
          ...(options?.epilogueStart === undefined ? {} : { epilogueStart: options.epilogueStart }),
          ...(options?.backgroundSource ? { backgroundSource: options.backgroundSource } : {}),
          targetId: options?.targetId,
          ...(options?.intent ? { intent: options.intent } : {}),
          ...(attachmentMetas ? { attachments: attachmentMetas } : {}),
        },
        turnTraceContext,
      );
      phaseStartedAt = startTurnPhase("turn_started_event");
      await this.appendEvent(turnStartedEvent, turnTraceContext);
      completeTurnPhase("turn_started_event", phaseStartedAt);
      events.push(turnStartedEvent);
      phaseStartedAt = startTurnPhase("target_accounting");
      startedTarget = await this.startTargetTurnAccounting({
        inputID: targetRunInputID,
        startedAtMs: turnStartedAtMs,
        startedTarget,
        traceContext: turnTraceContext,
      });
      completeTurnPhase("target_accounting", phaseStartedAt);
      if (startedTarget && this.sessionStore?.heartbeatTargetRun) {
        targetRunHeartbeat = setInterval(() => {
          void this.trackResidencyBlockingWork(
            this.heartbeatTargetTurnAccounting({
              inputID: targetRunInputID,
              seenAtMs: Date.now(),
              startedTarget,
              traceContext: turnTraceContext,
            }),
          );
        }, TARGET_RUN_HEARTBEAT_MS);
        if (typeof targetRunHeartbeat === "object" && "unref" in targetRunHeartbeat) {
          targetRunHeartbeat.unref();
        }
      }

      try {
        phaseStartedAt = startTurnPhase("user_prompt_hooks");
        const userPromptHookResult: HookRunResult = options?.skipUserPromptSubmitHooks
          ? { additionalContexts: [] }
          : await this.runUserPromptSubmitHooks(
              input,
              attachments,
              turnTraceContext,
              turnAbortSignal,
            );
        completeTurnPhase("user_prompt_hooks", phaseStartedAt);
        if (userPromptHookResult.preventContinuation) {
          const response =
            userPromptHookResult.stopReason ?? "Prompt blocked by UserPromptSubmit hook.";
          if (activeTurn) activeTurn.steerable = false;
          turnMachine = new TurnMachineImpl(turnMachine.complete(response, "success"));
          const turnUsage = createModelUsageSummaryFromEvents(events);
          const completeEvent = this.createEvent(
            SessionEventType.TurnComplete,
            {
              response,
              tokenCount: 0,
              usage: turnUsage,
              toolCallCount: 0,
              duration: Date.now() - turnMachine.state.startedAt.getTime(),
              resultType: "success",
              cacheStats: this.messageHistory.getCacheStats(),
              inputId: options?.inputId,
            },
            turnTraceContext,
          );
          await this.appendEvent(completeEvent, turnTraceContext);
          events.push(completeEvent);
          await recordTurnUsageFact(this, {
            completedAt: Date.now(),
            events,
            startedAt: turnStartedAtMs,
            status: "completed",
            traceContext: turnTraceContext,
            turnId,
          });
          this.turnNumber++;
          const projection = await this.rebuildProjection();
          await this.accountTargetTurnCompletion({
            inputID: targetRunInputID,
            startedAtMs: turnStartedAtMs,
            startedTarget,
            traceContext: turnTraceContext,
            usage: turnUsage,
          });
          return {
            response,
            turnId,
            traceId,
            usage: turnUsage,
            events,
            projection,
          };
        }
        // UserPromptSubmit 的上下文交给本轮第一次输入附件收集，排在 prompt 之后、输入附件批次末尾；
        // rewind / retry 切到这条 prompt 时一起删除，不会重复。
        const userPromptHookContext = buildLifecycleHookContextEntry(
          HookEventName.UserPromptSubmit,
          userPromptHookResult.additionalContexts,
        );
        injectReferencedSessionContextReminderIntoMessageHistory.call(this, input, options);
        // 话题原文由标准文本附件按需读取，可信来源归档不能再次生成隐藏上下文。
        const resolvedAttachments = await resolveTurnAttachments(attachments, {
          abortSignal: turnAbortSignal,
          artifactStore: this.artifactStore,
          fileSystemPort: this.fileSystemPort,
          imageProcessorPort: this.imageProcessorPort,
          sessionId: this.sessionId,
          traceContext: turnTraceContext,
          turnId,
          workingDirectory: this.workingDirectory,
        });
        logResolvedTurnAttachments(this.logger, turnTraceContext, resolvedAttachments);
        const sharedContextRefs = options?.sharedContextRefs ?? options?.intent?.sharedContextRefs;
        if (sharedContextRefs && sharedContextRefs.length > 0) {
          const [reference] = sharedContextRefs;
          if (!reference || reference.kind !== "shared_context_import") {
            throw new Error("invalid shared context reference");
          }
          if (!this.sessionStore) throw new Error("shared context import storage is unavailable");
          const alreadyHydrated = this.messageHistory
            .borrowReadOnlyRuntimeEntries()
            .some(
              (entry) => entry.kind !== "attachment" && entry.metadata?.source === "shared_context",
            );
          if (!alreadyHydrated) {
            const importedMessages = await this.sessionStore.messages({
              sessionID: this.sessionId,
            });
            const contextMessage = importedMessages.find(
              (message) =>
                message.info.role === "user" &&
                message.info.source === "shared_context" &&
                message.info.metadata &&
                typeof message.info.metadata === "object" &&
                (message.info.metadata as Record<string, unknown>).contextId ===
                  reference.context_id,
            );
            const contextText = contextMessage?.parts
              .filter(
                (part): part is Extract<MessagePart, { type: "text" }> => part.type === "text",
              )
              .map((part) => part.text)
              .join("\n")
              .trim();
            if (!contextText) throw new Error("shared context content is unavailable");
            this.messageHistory.addUser(
              contextText,
              runtimeMetadataForSyntheticUserMessageSource("shared_context"),
            );
          }
        }
        await this.persistPendingModelChangeTimeline(turnTraceContext);
        if (options?.skipInputRecord !== true && options?.inputVisibility === "model-only") {
          const inputSource = options.inputSource ?? "goal-continuation";
          const userContent = buildUserContentFromTurn(input, resolvedAttachments);
          this.messageHistory.addUser(
            userContent,
            runtimeInputMetadata(options.inputPresentation) ??
              runtimeMetadataForSyntheticUserMessageSource(inputSource),
          );
          // /goal 自动续跑是 runtime 注入给模型的内部 user-role 输入，
          // 不是用户在聊天里新发的一条消息。持久化时保留 raw 输入供恢复/排查使用，
          // 但用 model-only 语义阻止 UI-facing snapshot 把它渲染成用户气泡。
          await this.persistSyntheticUserNoticeForSession({
            messageID: userMessageId,
            metadata: {
              ...(options.targetId ? { targetId: options.targetId } : {}),
              ...(options.inputPresentation
                ? { inputPresentation: options.inputPresentation }
                : {}),
              visibility: "model-only",
            },
            sessionId: this.sessionId,
            source: inputSource,
            text: input,
            traceContext: turnTraceContext,
            visibility: "model-only",
          });
        } else if (options?.skipInputRecord !== true) {
          this.messageHistory.addEntries(
            buildRuntimeUserEntriesFromTurn(
              withConversationQuotes(
                input,
                options?.intent?.conversationQuotes,
                options?.intent?.botGroupSource,
              ),
              resolvedAttachments,
              {
                browserAmbientContext: options?.browserAmbientContext,
                genUiContext: options?.intent?.genUiContext,
                // 设计模式能力信号只认 Host 在 v4 命令里可信注入的 intent.inputOrigin，不用 trace 属性兜底：
                // 旧版 session/send（Bot 带附件时的回退路径）没有 intent.inputOrigin，也没有 Bot clientId，
                // 将来即使有人往 trace 里写 telemetry.inputOrigin，也不会对 IM 用户声明设计模式。
                ...(options?.intent?.inputOrigin ? { inputOrigin: options.intent.inputOrigin } : {}),
                ...(options?.intent?.clientId ? { inputClientId: options.intent.clientId } : {}),
              },
            ).map((entry) => {
              const metadata = runtimeInputMetadata(options?.inputPresentation);
              // 合并而不是替换：输入 entry 上还挂着页面状态（genUiState）。
              // 修复原因：整体替换会删掉它，抢占运行中轮次的立即发送在热态请求里丢失页面状态，
              // 冷恢复按合并恢复又带上，前后请求不一致。写法与冷恢复相同。
              return entry.kind !== "attachment" && metadata
                ? { ...entry, metadata: { ...entry.metadata, ...metadata } }
                : entry;
            }),
          );
          // /init 和自定义 slash command 会把模型输入展开成较长的内部
          // prompt。模型可见的历史必须使用展开后的 input，但 UI 展示、会话标题和
          // 恢复快照只能展示用户真实提交的原始 query。
          await this.persistUserPrompt(
            userMessageId,
            displayInput,
            resolvedAttachments,
            turnTraceContext,
            {
              intent: options?.intent,
              inputPresentation: options?.inputPresentation,
              sessionInputId: options?.intent?.queueItemId,
              sourceCommandId: options?.inputId,
              ...(options?.epilogueStart === undefined
                ? {}
                : { epilogueStart: options.epilogueStart }),
            },
          );
          // 提示读取跟随真实新输入，不随模型续步重复；首输入复用 MCP 初始化的读取。
          if (
            this.mcpToolsRegistered &&
            (options?.inputSource === undefined || options.inputSource === "workflow_launch") &&
            runtimeInputMetadata(options?.inputPresentation)?.source !== "legacy_synthetic"
          ) {
            await refreshWorkspaceTrustAdmission(this, turnTraceContext);
          }
        }
        if (creationFailure) {
          // 已接纳输入已随 TurnStarted 和用户消息落库；不准备 Agent、不生成标题、不请求模型，
          // 终态由下方 catch 统一写入。
          throw creationFailure.error;
        }
        if (creationFallback) {
          // TurnStarted 与用户消息已先落库，continuous/replayable 投影都能把退回事实关联到同一输入行。
          const fallbackEvent = this.createEvent(
            SessionEventType.TurnExecutionModelFallback,
            {
              ...(options?.inputId ? { inputId: options.inputId } : {}),
              reason: creationFallback.reason,
              fromModelSelection: creationFallback.fromModelSelection,
              toModelSelection: creationFallback.toModelSelection,
            },
            turnTraceContext,
          );
          await this.appendEvent(fallbackEvent, turnTraceContext);
          events.push(fallbackEvent);
        }
        // 配置读取曾早于输入展示/持久化，失败会让已发送消息从界面消失。
        // 在原有输入记录后固定本轮定义，错误/取消复用本层收尾，且不启动标题或模型请求。
        await this.prepareAgentDefinitions({
          signal: turnAbortSignal,
          traceContext: turnTraceContext,
        });
        throwIfTurnAborted(turnAbortSignal);
        if (options?.skipInputRecord !== true && options?.inputVisibility !== "model-only") {
          // 修复原因：标题生成以前等主 turn 成功后才启动，用户 stop/cancel 首轮请求时
          // generated title 永远没有机会发起。首条 query 持久化后即可异步生成，避免被主链路取消拖死。
          const titleGenerationStarted = maybeStartSessionTitleGeneration.call(
            this,
            displayInput,
            userMessageId,
            turnTraceContext,
            {
              deferIfProviderRuntimeHeadersRefresh: true,
              offPeakExecutionId: options?.offPeakExecutionId,
            },
          );
          shouldRetryTitleGenerationAfterTurn = !titleGenerationStarted;
        }
        // Plugin reminder 必须在对应 user 消息写入历史和 session store 后再追加：
        // provider 形态因此稳定为 user → system，cold hydration 也按同一因果顺序恢复。
        // 根因：input 可能已经被自定义命令展开，解析它会让命令模板里的 plugin://
        // 凭空获得“用户引用”语义；这里只解析真实持久化的 canonical displayInput。
        // runtime 内部的 model-only continuation 不代表新的用户意图，不重复解析。
        if (options?.inputVisibility !== "model-only") {
          await this.injectPluginReferenceReminderFromTurn(
            displayInput,
            turnTraceContext,
            options?.toolDisallowlist,
          );
        }

        this.messageHistory.setCacheMiss();
        const loopModel = submissionModel ?? admittedModel;
        if (!loopModel) {
          throw new Error("Turn model was not created before execution");
        }
        startProjectMemoryRecallPrefetch(
          this,
          {
            model: loopModel,
            traceContext: turnTraceContext,
            turnAbortSignal,
          },
          ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
        );
        loopState = {
          activeTurn,
          ...(options?.automationId ? { automationId: options.automationId } : {}),
          // 闲时派发轮的身份进入 loop state，供工具执行边界 deny OffPeakCreate。
          ...(options?.offPeakTaskId ? { offPeakTaskId: options.offPeakTaskId } : {}),
          ...(options?.offPeakExecutionId
            ? { offPeakExecutionId: options.offPeakExecutionId }
            : {}),
          anomalyWarningsInjected: 0,
          backgroundSubagentResultConsumed: options?.backgroundSubagentResultConsumed === true,
          workflowResultConsumed: options?.workflowResultConsumed === true,
          completedRealToolResultBatch: false,
          inputAttachmentCollectionPending: "turn_input",
          ...(userPromptHookContext ? { userPromptHookContext } : {}),
          currentUserMessageId: userMessageId,
          events,
          input,
          ...(options?.inputId ? { inputId: options.inputId } : {}),
          modelResponse: "",
          model: loopModel,
          ...(options?.modelExecution?.selectionScope === "execution"
            ? { modelSelectionScope: "execution" as const }
            : {}),
          // 加速卡回退仅使用启动时快照，不随随后接纳的用户选择变化。
          ...(!creationFallback && options?.modelExecution?.selectionFallback
            ? {
                selectionFallback: options.modelExecution.selectionFallback,
                highspeedFallbackSelection,
              }
            : {}),
          ...(options?.modelExecution?.subagents && effectiveExecutionSelection
            ? {
                subagentModelOverride: {
                  selection: effectiveExecutionSelection,
                  requestDependencies: effectiveRequestDependencies,
                  background: options.modelExecution.subagents.background,
                },
              }
            : {}),
          modelStepCount: 0,
          historyRoundCount: 0,
          reactiveCompactAttemptedInCurrentModelStep: false,
          repeatedToolCallSignature: undefined,
          repeatedToolCallStreakCount: 0,
          stopHookContinuationCount: 0,
          streamRecoveryRetryCount: 0,
          tokenCount: 0,
          toolCallCount: 0,
          turnRequestState: {
            // Turn 只借一次 canonical 成员集合，之后由显式 commit 推进；entry 本身
            // 遵循 MessageHistory 的不可变约定。
            entries: [...this.messageHistory.borrowReadOnlyRuntimeEntries()],
            outputTokenContinuationCount: 0,
          },
          pluginDiscoveryUi: options?.intent?.[PLUGIN_DISCOVERY_INPUT] === true,
          toolDisallowlist: options?.toolDisallowlist,
          traceId,
          turnAbortSignal,
          turnId,
          turnMachine,
          turnOutputStyle: admittedOutputStyle,
          turnTraceContext,
          userMessageId,
        };

        openGoalStateChangeReminderDeferral(activeTurn);
        phaseStartedAt = startTurnPhase("regular_turn_loop");
        try {
          await runRegularTurnLoop.call(this, loopState);
          completeTurnPhase("regular_turn_loop", phaseStartedAt);
        } finally {
          finishOutputTokenRecovery(loopState.turnRequestState);
          await closeGoalStateChangeReminderDeferral.call(this, activeTurn, turnTraceContext);
        }
        turnMachine = loopState.turnMachine;

        const turnUsage = createModelUsageSummaryFromEvents(events);
        // goal usage/active-run 先结算，再固定 exact goal/verifier boundary；只有两者都
        // 已持久化，TurnComplete 才能让 projection/UI 开放最终 assistant fork。
        await this.accountTargetTurnCompletion({
          inputID: targetRunInputID,
          startedAtMs: turnStartedAtMs,
          startedTarget,
          traceContext: turnTraceContext,
          usage: turnUsage,
        });
        if (loopState.stableProductStartMessageId && loopState.stableBoundaryAssistantMessageId) {
          await persistStableForkCompletionBoundary(this, {
            boundaryMessageId: loopState.stableBoundaryAssistantMessageId,
            startMessageId: loopState.stableProductStartMessageId,
            historyRoundCount: loopState.historyRoundCount,
            traceContext: turnTraceContext,
          });
        }
        if (loopState.stableBoundaryAssistantMessageId) {
          await appendBrowserTurnScreenshot(
            this,
            loopState,
            loopState.stableBoundaryAssistantMessageId,
          );
        }
        const completeEvent = this.createEvent(
          SessionEventType.TurnComplete,
          {
            response: loopState.modelResponse,
            tokenCount: loopState.tokenCount,
            usage: turnUsage,
            toolCallCount: loopState.toolCallCount,
            historyRoundCount: loopState.historyRoundCount,
            duration: Date.now() - turnMachine.state.startedAt.getTime(),
            resultType: "success",
            ...(loopState.backgroundSubagentResultConsumed
              ? { backgroundSubagentResultConsumed: true }
              : {}),
            ...(loopState.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
            cacheStats: this.messageHistory.getCacheStats(),
            inputId: options?.inputId,
          },
          turnTraceContext,
        );
        await this.appendEvent(completeEvent, turnTraceContext);
        events.push(completeEvent);
        await recordTurnUsageFact(this, {
          completedAt: Date.now(),
          events,
          startedAt: turnStartedAtMs,
          status: "completed",
          traceContext: turnTraceContext,
          turnId,
          userMessageId,
        });
        if (shouldRetryTitleGenerationAfterTurn && userMessageId) {
          // 需要请求前刷新 provider runtime headers 的模型
          // 若在主 turn 前生成标题，会先占用鉴权刷新窗口，导致真正的用户消息失败。
          maybeStartDeferredSessionTitleGeneration.call(
            this,
            displayInput,
            userMessageId,
            turnTraceContext,
            options?.offPeakExecutionId,
          );
        }
        this.turnNumber++;

        const projection = await this.rebuildProjection();
        this.logger?.info("Turn completed", {
          ...traceContextToLogContext(turnTraceContext),
          durationMs: Date.now() - turnMachine.state.startedAt.getTime(),
          event: "turn.completed",
          module: "core.runtime",
          status: "completed",
          toolCallCount: loopState.toolCallCount,
        });
        // 单轮执行策略只抑制本次成功 Turn 的后台提取，不修改 Session Memory 配置。
        if (options?.modelExecution?.memoryExtraction !== "skip") {
          scheduleProjectMemoryExtraction(this, {
            model: loopState.model,
            traceContext: turnTraceContext,
          });
        }

        const result: TurnResult = {
          response: loopState.modelResponse,
          turnId,
          traceId,
          usage: turnUsage,
          events,
          projection,
        };
        return result;
      } catch (error) {
        turnFailureHandled = true;
        // CR-01：创建失败轮进入主链只为保留已接纳输入。落库中的普通失败不能覆盖模型创建错误，
        // 只记 warn。用户取消仍收口为 cancelled；宿主 fault 只经 abort signal 传入，
        // createTurnFailureError 会先于创建错误识别它。
        const reportedCreationFailure =
          creationFailure && !isTurnCancellationError(error, turnAbortSignal)
            ? creationFailure
            : undefined;
        if (reportedCreationFailure && error !== reportedCreationFailure.error) {
          this.logger?.warn("Accepted input persistence failed after model creation failed", {
            ...traceContextToLogContext(turnTraceContext),
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "turn.model_creation.input_persistence_failed",
            module: "core.runtime",
            status: "failed",
          });
        }
        const fallbackMessage = reportedCreationFailure
          ? MODEL_CREATION_FAILED_MESSAGE
          : TURN_EXECUTION_FAILED_MESSAGE;
        const coreError = createTurnFailureError(
          reportedCreationFailure ? reportedCreationFailure.error : error,
          turnAbortSignal,
          fallbackMessage,
        );
        const preserveQueueAutoDrainOnCancel =
          coreError.type === CoreErrorType.TurnCancelled &&
          this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
        const finishedTarget = await this.finishTargetTurnAccounting({
          endedAtMs: Date.now(),
          inputID: targetRunInputID,
          startedTarget,
          status: coreError.type === CoreErrorType.TurnCancelled ? "paused" : undefined,
          traceContext: turnTraceContext,
        });
        if (finishedTarget?.targetID === startedTarget?.targetID) {
          startedTarget = finishedTarget;
        }
        // 停止的轮次给模型留中断标记；send-now 抢占是为了交付下一条输入，不加标记。
        // 修复原因：宿主外部故障中止本轮时，被取消的工具结果已写成停止文字，却没有标记；
        // 它同样是中止，与用户停止一样留标记。
        const abortedTurn =
          coreError.type === CoreErrorType.TurnCancelled ||
          isExternalTurnFault(turnAbortSignal?.reason);
        if (loopState && abortedTurn && !preserveQueueAutoDrainOnCancel) {
          await appendInterruptMarker(this, loopState, turnTraceContext);
        }
        if (coreError.type === CoreErrorType.TurnCancelled) {
          await this.pauseActiveTargetForCancellation(turnTraceContext);
          if (activeTurn) {
            await this.fallbackPendingGuidesToQueue({
              activeTurn,
              events,
              reasonCode: "guide.turnInterrupted",
              traceContext: turnTraceContext,
            });
          }
        }
        // 普通 TurnError 只结束当前 turn，不撤销已经 accepted 的 future input。
        // V4 TurnError 投影将队列切成 error-paused，runtime 同步关闭行内 drain，
        // 保留排队输入，等待用户显式继续。
        if (activeTurn && coreError.type !== CoreErrorType.TurnCancelled) {
          const pendingInputs = (await this.rebuildProjection()).pendingSteerInputs;
          if (pendingInputs.length > 0) {
            this.queueAutoDrain = false;
            this.queueExternalDrainActive = false;
          }
        } else if (
          activeTurn &&
          coreError.type === CoreErrorType.TurnCancelled &&
          !preserveQueueAutoDrainOnCancel &&
          activeTurn.pendingInputs.length > 0
        ) {
          // runtime 授权位与投影同步：投影在 TurnComplete(cancelled)+queue>0 时把
          // queue.autoDrain 置 false（held），runtime 的 drain 门也必须同步翻转，
          // 否则 held 期间新起的 turn 会把后续入队项 drain 掉，与投影语义分叉。
          this.queueAutoDrain = false;
          this.queueExternalDrainActive = false;
        }

        // background wake 可能在 loopState 初始化前取消；此时仍要保留已 dequeue 的结果事实。
        const backgroundSubagentResultConsumed =
          options?.backgroundSubagentResultConsumed === true ||
          loopState?.backgroundSubagentResultConsumed === true;
        const workflowResultConsumed =
          options?.workflowResultConsumed === true || loopState?.workflowResultConsumed === true;
        await appendTurnOutcomeEvent(this, {
          coreError,
          events,
          durationMs: Date.now() - turnMachine.state.startedAt.getTime(),
          turnPhase: reportedCreationFailure ? MODEL_CREATION_TURN_PHASE : turnMachine.state.phase,
          inputId: options?.inputId,
          highspeedCardId: options?.intent?.highspeed?.cardId,
          highspeedFallbackUnavailable:
            creationFallbackUnavailable || loopState?.highspeedFallbackUnavailable === true,
          traceContext: turnTraceContext,
          fallbackMessage,
          logEvent: "turn.failed",
          logLabel: "Turn",
          preserveQueueAutoDrainOnCancel,
          backgroundSubagentResultConsumed,
          workflowResultConsumed,
          historyRoundCount: loopState?.historyRoundCount,
        });
        await recordTurnUsageFact(this, {
          completedAt: Date.now(),
          error: coreError,
          events,
          startedAt: turnStartedAtMs,
          status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
          traceContext: turnTraceContext,
          turnId,
          userMessageId,
        });
        throw coreError;
      }
    }).then(
      (result) => {
        turnTelemetry.finishCompleted("assistant_message");
        return result;
      },
      (error: unknown) => {
        if (!turnFailureHandled) {
          this.logger?.warn("Turn execution escaped lifecycle handler", {
            ...traceContextToLogContext(turnTraceContext),
            durationMs: Date.now() - turnStartedAtMs,
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "turn.lifecycle.unhandled_rejection",
            module: "core.runtime",
            phase: turnPhase,
            status: "failed",
          });
        }
        if (isTurnCancellationError(error, turnAbortSignal)) {
          turnTelemetry.finishCancelled("abort_signal");
        } else {
          turnTelemetry.finishFailed("unhandled", "unknown", error);
        }
        throw error;
      },
    );

  return turnTelemetry.run(execute).finally(async () => {
    disposeProjectMemoryRecallPrefetch(this);
    if (targetRunHeartbeat) {
      clearInterval(targetRunHeartbeat);
    }
    this.releaseTurnStart(turnId);
    clearBrowserTurnState(this.sessionId, turnId);
    this.finishActiveTurn(activeTurn);
    offPeakTurn.release(
      turnAbortSignal.aborted
        ? "stopped"
        : events.some((event) => event.type === SessionEventType.TurnError)
          ? "failed"
          : "succeeded",
    );
    turnAbortScope.dispose();
    try {
      await this.browserControlPort?.turnEnded?.({
        sessionId: this.sessionId,
        turnId: String(turnId),
        traceContext: turnTraceContext,
      });
    } catch (error) {
      // 生命周期清理失败不能覆盖已经完成/失败的主 turn；backend 会在 session close 再兜底释放。
      this.logger?.warn("Browser turn cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "browser.turn_cleanup.failed",
        turnId: String(turnId),
      });
    }
  });
}

function injectReferencedSessionContextReminderIntoMessageHistory(
  this: AgentRuntimeInternal,
  input: string,
  options?: ExecuteTurnOptions,
): void {
  if (options?.inputVisibility === "model-only") return;
  // ReadSession 只在可信绑定了会话工具的根会话注册；子代理等运行时没有它，不提示不存在的工具。
  if (!this.sessionControlKind) return;
  const reminderBody = buildReferencedSessionContextReminderBody(input);
  if (!reminderBody) return;
  this.messageHistory.addAttachment("referenced_session_context", reminderBody);
}
