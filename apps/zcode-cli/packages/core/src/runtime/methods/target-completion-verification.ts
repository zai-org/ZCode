import {
  SessionEventType,
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
  createChildTraceContext,
  failOpenGoalCompletionVerification,
  failedGoalCompletionVerification,
  formatGoalCompletionVerificationPrompt,
  parseGoalCompletionVerificationText,
  runWithModelInvocationContext,
  traceContextToLogContext,
} from "../deps.js";
import type {
  GoalCompletionVerificationOutput,
  Model,
  SessionEvent,
  SessionGoal,
  TraceContext,
} from "../deps.js";
import { prepareRuntimeProviderRequest, throwIfTurnAborted } from "../helpers/index.js";
import { projectMessagesForModelMediaPolicy } from "../helpers/media-budget.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { isRuntimeAttachmentEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel } from "./runtime-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { isStartPlanBusyStreamRecoveryFailure } from "./streaming-recovery.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { runTargetCompletionVerificationWithTelemetry } from "./target-completion-verification-telemetry.js";

export interface TargetCompletionVerificationResult {
  target: SessionGoal;
  verification: GoalCompletionVerificationOutput;
}

const TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const START_PLAN_TARGET_VERIFIER_RETRY_PROVIDER_IDS = new Set([
  "account:bigmodel-start-plan",
  "account:zai-start-plan",
]);

export async function verifyActiveTargetCompletionForContinuation(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    target: SessionGoal;
    traceContext: TraceContext;
  },
): Promise<TargetCompletionVerificationResult | null> {
  if (this.config.targetCompletionVerification?.enabled === false) return null;
  if (!this.sessionStore) return null;
  if (input.target.status !== "active") return null;

  const execute = async (): Promise<TargetCompletionVerificationResult> => {
    const events: SessionEvent[] = [];
    const verification = await verifyTargetCompletion.call(this, {
      abortSignal: input.abortSignal,
      events,
      target: input.target,
      traceContext: input.traceContext,
    });

    if (!verification.passed) {
      return {
        target: input.target,
        verification,
      };
    }

    const previousTarget = await this.readSessionTargetForContext(input.traceContext);
    const completedTarget =
      (await this.sessionStore!.updateTargetStatus({
        sessionID: this.sessionId,
        status: "complete",
      })) ?? input.target;
    await this.recordTargetChanged({
      action: "status_updated",
      previousTarget,
      source: "runtime",
      target: completedTarget,
      traceContext: input.traceContext,
    });

    return {
      target: completedTarget,
      verification,
    };
  };
  return runTargetCompletionVerificationWithTelemetry(this, input, execute);
}

async function verifyTargetCompletion(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    target: SessionGoal;
    traceContext: TraceContext;
  },
): Promise<GoalCompletionVerificationOutput> {
  // 目标验证期间也允许切换 session 默认模型；请求、重试和 usage 必须共用
  // 验证开始时的模型快照，不能在 provider 返回后重新读取 Session Selection。
  const requestedModelSelection = this.getSessionModelSelection();
  const model = createRuntimeModel(this, { selection: requestedModelSelection });
  const modelTraceContext = createChildTraceContext(input.traceContext, {
    attributes: {
      model: `${model.providerId}/${model.modelId}`,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      targetId: input.target.targetID,
    },
  });
  const verificationId = modelTraceContext.spanId ?? modelTraceContext.traceId;
  const foregroundExecutionId = this.activeForegroundExecution?.foregroundExecutionId;
  const goalIteration = await getNextTargetCompletionVerificationIteration.call(
    this,
    input.target.targetID,
  );
  const anchor = targetCompletionVerificationAnchor.call(this, input.traceContext);
  await this.appendEvent(
    this.createEvent(
      SessionEventType.TargetCompletionVerification,
      {
        ...anchor,
        ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
        goalIteration,
        status: "started",
        targetId: input.target.targetID,
        verificationId,
      },
      modelTraceContext,
    ),
    modelTraceContext,
  );
  // verifier 和轮内每个 model step 一样，按本次请求的模型重新投影前缀。
  // 修复原因：轮次结束后改语言、output style 等重建不带模型，默认写成 MCS 文案；
  // 不支持 MCS 的模型收到的 Harness 文案与实际送达方式矛盾，前缀缓存也失效。
  rebuildContextPrefix(this, { model });
  const prepared = prepareRuntimeProviderRequest(this, {
    entries: withoutTrailingPendingAssistantToolCallEntries(
      this.messageHistory.borrowReadOnlyRuntimeEntries(),
    ),
    prompt: formatGoalCompletionVerificationPrompt(input.target),
    tools: [],
    applyCacheControl: true,
    model,
  });
  // verifier 直接消费完整历史但曾绕过正常请求的媒体策略；只补 capability
  // 仍会让聚合超限失败进入 fail-open。请求前统一执行能力和预算投影。
  const messages = projectMessagesForModelMediaPolicy(
    prepared.request.messages,
    model.properties.inputFormat,
  ).messages;
  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      messages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      toolCount: 0,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  input.events.push(modelRequestEvent);
  const modelStartedAt = Date.now();
  const networkEventStartIndex = input.events.length;

  try {
    const result = await generateTargetCompletionVerificationText.call(this, {
      abortSignal: input.abortSignal,
      events: input.events,
      request: { ...prepared.request, messages },
      model,
      traceContext: modelTraceContext,
    });
    throwIfTurnAborted(input.abortSignal);
    const toolCalls = this.extractToolCallsFromResult(result);
    const modelCompleteEvent = this.createEvent(
      SessionEventType.ModelComplete,
      {
        content: result.text,
        querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
        stopReason: result.finishReason,
        toolCallCount: toolCalls.length,
        usage: result.usage,
      },
      modelTraceContext,
    );
    await this.appendEvent(modelCompleteEvent, modelTraceContext);
    input.events.push(modelCompleteEvent);
    await recordModelUsageFact(this, {
      events: input.events,
      model,
      networkEventStartIndex,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      result,
      startedAt: modelStartedAt,
      status: "completed",
      toolCallCount: toolCalls.length,
      traceContext: modelTraceContext,
    });
    const verification =
      toolCalls.length > 0
        ? failOpenGoalCompletionVerification(
            "The completion verifier attempted to call tools instead of returning a verification result.",
          )
        : parseGoalCompletionVerificationText(result.text);
    await this.appendEvent(
      this.createEvent(
        SessionEventType.TargetCompletionVerification,
        {
          ...anchor,
          ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
          goalIteration,
          status: "completed",
          targetId: input.target.targetID,
          verification,
          verificationId,
        },
        modelTraceContext,
      ),
      modelTraceContext,
    );
    return verification;
  } catch (error) {
    await recordModelUsageFact(this, {
      error,
      events: input.events,
      model,
      networkEventStartIndex,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      startedAt: modelStartedAt,
      status: input.abortSignal?.aborted ? "cancelled" : "error",
      traceContext: modelTraceContext,
    });
    if (input.abortSignal?.aborted) {
      const preserveQueueAutoDrainOnCancel =
        this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
      await this.appendEvent(
        this.createEvent(
          SessionEventType.TargetCompletionVerification,
          {
            ...anchor,
            ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
            goalIteration,
            status: "cancelled",
            targetId: input.target.targetID,
            ...(preserveQueueAutoDrainOnCancel ? { preserveQueueAutoDrainOnCancel: true } : {}),
            verification: failedGoalCompletionVerification(
              "Completion verifier request was cancelled.",
            ),
            verificationId,
          },
          modelTraceContext,
        ),
        modelTraceContext,
      );
      // 用户 Stop 或队列“立即发送”打断 goal verifier 时，当前没有普通
      // executeTurn 的取消收口路径会暂停 target。如果仍保持 active，后续
      // resumeSession + sendPrompt 会被 agent 当成 goal continuation，普通用户消息会继续输出 checkpoint。
      await this.pauseActiveTargetForCancellation(modelTraceContext);
      throw error;
    }
    this.logger?.warn("Goal completion verification failed open", {
      ...traceContextToLogContext(modelTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.completion_verification.failed_open",
      module: "core.runtime",
      status: "failed",
      targetId: input.target.targetID,
    });
    const verification = failOpenGoalCompletionVerification(
      error instanceof Error
        ? `Completion verifier request failed: ${error.message}`
        : "The completion verifier could not confirm that every goal requirement is complete.",
    );
    await this.appendEvent(
      this.createEvent(
        SessionEventType.TargetCompletionVerification,
        {
          ...anchor,
          ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
          goalIteration,
          status: "failed_closed",
          targetId: input.target.targetID,
          verification,
          verificationId,
        },
        modelTraceContext,
      ),
      modelTraceContext,
    );
    return verification;
  }
}

function targetCompletionVerificationAnchor(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): { anchorAssistantMessageId?: string; anchorTurnId?: string } {
  const anchorAssistantMessageId = this.latestAssistantMessageId;
  const anchorTurnId = this.latestAssistantTurnId ?? traceContext.turnId;
  return {
    ...(anchorAssistantMessageId ? { anchorAssistantMessageId } : {}),
    ...(anchorTurnId ? { anchorTurnId } : {}),
  };
}

async function generateTargetCompletionVerificationText(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    request: ReturnType<typeof prepareRuntimeProviderRequest>["request"];
    model: Model;
    traceContext: TraceContext;
  },
) {
  const maxAttempts = TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      using statusSink = this.createModelStatusSink(input.traceContext, input.events);
      const invocationContext = {
        metadata: traceContextToLogContext(input.traceContext),
        modelCall: {
          operation: "goal_completion_verification" as const,
        },
        statusSink,
        traceContext: input.traceContext,
        refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
          abortSignal: input.abortSignal,
          model: input.model,
          traceContext: input.traceContext,
        }),
      };
      return await runWithModelInvocationContext(invocationContext, () =>
        input.model.generateText({
          abortSignal: input.abortSignal,
          ...input.request,
          // Verifier 继承已绑定的思考配置，不能套用低成本辅助调用的降档和封顶策略。
          options: { maxOutputTokens: input.model.optionSpecs.maxOutputTokens.max },
        }),
      );
    } catch (error) {
      const retryDelayMs = TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS[attempt - 1];
      if (
        input.abortSignal?.aborted ||
        retryDelayMs === undefined ||
        !isTargetVerifierStartPlanBusyFailure(error, input.model.providerId)
      ) {
        throw error;
      }

      // 目标完成验证发生在用户已看到 assistant 迭代之后；Start Plan busy
      // 是 admission 瞬时并发。先短暂重试，避免直接走 fail-open 把可恢复并发误当完成。
      this.logger?.warn("Goal completion verification retrying after Start Plan busy", {
        ...traceContextToLogContext(input.traceContext),
        attempt,
        event: "target.completion_verification.retry_start_plan_busy",
        maxAttempts,
        module: "core.runtime",
        retryDelayMs,
        status: "waiting",
      });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      throwIfTurnAborted(input.abortSignal);
    }
  }

  throw new Error("Goal completion verification retry loop exhausted unexpectedly.");
}

function isTargetVerifierStartPlanBusyFailure(error: unknown, providerId: string): boolean {
  return (
    START_PLAN_TARGET_VERIFIER_RETRY_PROVIDER_IDS.has(providerId) &&
    isStartPlanBusyStreamRecoveryFailure(error)
  );
}

async function getNextTargetCompletionVerificationIteration(
  this: AgentRuntimeInternal,
  targetId: string,
): Promise<number> {
  const projection = await this.rebuildProjection();
  const targetTimeline = projection.targetCompletionVerificationTimeline.filter(
    (item) => item.targetId === targetId,
  );
  const latestIteration = targetTimeline.reduce(
    (maxIteration, item, index) => Math.max(maxIteration, item.goalIteration ?? index + 1),
    0,
  );
  // goal 迭代由 verifier lifecycle 推进，而不是普通 turn 或用户继续次数。
  // runtime 在 started/completed/failed_closed/cancelled 上固定同一个编号，UI 与 snapshot 才不会各自猜。
  return latestIteration + 1;
}

function withoutTrailingPendingAssistantToolCallEntries(
  entries: readonly RuntimeMessageEntry[],
): readonly RuntimeMessageEntry[] {
  const last = entries.at(-1);
  if (
    !last ||
    isRuntimeAttachmentEntry(last) ||
    last?.message.role !== "assistant" ||
    !last.message.toolCalls ||
    last.message.toolCalls.length === 0
  ) {
    return entries;
  }
  return entries.slice(0, -1);
}
