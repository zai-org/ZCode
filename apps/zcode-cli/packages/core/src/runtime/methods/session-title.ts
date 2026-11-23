import { SessionEventType, traceContextToLogContext } from "../deps.js";
import type {
  MessageId,
  MessageWithParts,
  ModelSelection,
  SessionInfo,
  SessionTitleSource,
  TraceContext,
} from "../deps.js";
import type { AgentTelemetryCausation } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  persistFallbackGoalSummaryTitle,
  persistGeneratedGoalSummaryTitle,
} from "./goal-summary-title.js";
import {
  SESSION_TITLE_QUERY_SOURCE,
  generateTitleCandidate,
  normalizeTitleInput,
  retainTitleModelContext,
  type TitleModelContext,
} from "./title-generation-sidecar.js";

// 修复原因：这里曾包含 "generated"。turnNumber 和 sessionTitleGenerationAttempted 在冷恢复时重建，
// compact 后 active 历史只剩摘要，两者都回到初始值，下一条消息又会生成一次标题并覆盖旧标题。
// 标题每个会话只生成一次，以持久化的 titleSource 为唯一判据：请求前与写回 CAS 共用这份列表。
const GENERATED_TITLE_EXPECTED_SOURCES: readonly SessionTitleSource[] = ["default", "first_input"];
const MIN_GENERATED_TITLE_INPUT_CHARS = 10;

function acceptsGeneratedTitle(titleSource: SessionTitleSource | undefined): boolean {
  return GENERATED_TITLE_EXPECTED_SOURCES.includes(titleSource ?? "first_input");
}

export function maybeStartSessionTitleGeneration(
  this: AgentRuntimeInternal,
  input: string,
  messageID: MessageId,
  traceContext: TraceContext,
  options?: {
    deferIfProviderRuntimeHeadersRefresh?: boolean;
    goalSummaryTargetID?: string;
    offPeakExecutionId?: string;
  },
): boolean {
  return maybeStartSessionTitleGenerationFromSeed.call(this, input, {
    deferIfProviderRuntimeHeadersRefresh: options?.deferIfProviderRuntimeHeadersRefresh,
    goalSummaryTargetID: options?.goalSummaryTargetID,
    offPeakExecutionId: options?.offPeakExecutionId,
    messageID,
    traceContext,
  });
}

export function maybeStartDeferredSessionTitleGeneration(
  this: AgentRuntimeInternal,
  input: string,
  messageID: MessageId,
  traceContext: TraceContext,
  offPeakExecutionId?: string,
): boolean {
  return maybeStartSessionTitleGenerationFromSeed.call(this, input, {
    messageID,
    traceContext,
    offPeakExecutionId,
  });
}

export function maybeStartSessionTitleGenerationFromExternalInput(
  this: AgentRuntimeInternal,
  input: string,
  options?: { goalSummaryTargetID?: string; traceContext?: TraceContext },
): void {
  // /goal 这类协议命令不走普通 executeTurn，但 objective 仍是用户可见的首条意图。
  // 这里复用 title seed，不额外持久化 user message，避免为了标题生成污染聊天 transcript。
  maybeStartSessionTitleGenerationFromSeed.call(this, input, {
    bypassShortInputGuard: true,
    goalSummaryTargetID: options?.goalSummaryTargetID,
    traceContext: options?.traceContext ?? this.rootTraceContext,
  });
}

function maybeStartSessionTitleGenerationFromSeed(
  this: AgentRuntimeInternal,
  input: string,
  options: {
    deferIfProviderRuntimeHeadersRefresh?: boolean;
    goalSummaryTargetID?: string;
    messageID?: MessageId;
    traceContext: TraceContext;
    bypassShortInputGuard?: boolean;
    offPeakExecutionId?: string;
  },
): boolean {
  if (
    !shouldAttemptSessionTitleGeneration(this, input, {
      bypassShortInputGuard: options.bypassShortInputGuard,
    })
  ) {
    return false;
  }
  if (
    options.deferIfProviderRuntimeHeadersRefresh &&
    shouldDeferSessionTitleForRuntimeHeaders(this)
  ) {
    // 首条消息的 title generation 和主消息会共享同一个 runtimeModel。
    // 需要刷新 runtime headers 的 provider 先让主 turn 发出去，再异步补标题。
    return false;
  }
  this.sessionTitleGenerationAttempted = true;
  // 标题任务会越过当前 Turn 的生命周期。入队时冻结 causation，避免后续 await、
  // 调度器或实现重构使后台 Trace 静默丢失指向触发 Span 的 Link。
  const causation = this.agentTelemetry.captureCausation();
  const modelContext = retainTitleModelContext(this, options.offPeakExecutionId);

  const generation = generateAndPersistSessionTitle
    .call(this, input, options.messageID, options.traceContext, {
      causation,
      modelContext,
      goalSummaryTargetID: options.goalSummaryTargetID,
    })
    .catch(async (error) => {
      this.logger?.warn("Session title generation failed", {
        ...traceContextToLogContext(options.traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_title_generation.failed",
        module: "core.runtime",
        status: "failed",
      });
      if (options.goalSummaryTargetID) {
        await persistFallbackGoalSummaryTitle.call(this, {
          objective: input,
          reason: "session_title_generation_failed",
          targetID: options.goalSummaryTargetID,
          traceContext: options.traceContext,
        });
      }
    })
    .finally(() => modelContext.release());
  void this.trackResidencyBlockingWork(generation).catch((error) => {
    this.logger?.warn("Session title fallback persistence failed", {
      ...traceContextToLogContext(options.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_title_generation.fallback_failed",
      module: "core.runtime",
      status: "failed",
    });
  });
  return true;
}

function shouldAttemptSessionTitleGeneration(
  runtime: AgentRuntimeInternal,
  input: string,
  options: { bypassShortInputGuard?: boolean } = {},
): boolean {
  if (runtime.shuttingDown) return false;
  if (runtime.sessionTitleGenerationAttempted) return false;
  if (runtime.config.titleGeneration?.enabled === false) return false;
  if (!runtime.config.titleGeneration) return false;
  if (!runtime.sessionStore) return false;
  if (runtime.config.parentSessionId) return false;
  if (runtime.config.taskType && runtime.config.taskType !== "interactive") return false;
  if (runtime.turnNumber !== 0) return false;
  const normalizedInput = normalizeTitleInput(input);
  if (normalizedInput.length === 0) return false;
  // 短首发输入本身已经是可读标题，继续走 generated title sidecar
  // 会把 "hi" 这类标题稳定覆盖成泛化的 "New Coding Session"。
  return (
    options.bypassShortInputGuard ||
    Array.from(normalizedInput).length >= MIN_GENERATED_TITLE_INPUT_CHARS
  );
}

function shouldDeferSessionTitleForRuntimeHeaders(runtime: AgentRuntimeInternal): boolean {
  const runtimeHeadersPort = runtime.providerRuntimeHeadersPort;
  if (!runtimeHeadersPort) return false;
  const selection =
    runtime.config.titleGeneration?.modelSelection ?? runtime.getSessionModelSelection();
  if (!selection) return true;
  return (
    runtimeHeadersPort.shouldRefreshBeforeModelRequest?.({
      providerId: selection.providerId,
      modelId: selection.modelId,
    }) ?? true
  );
}

async function generateAndPersistSessionTitle(
  this: AgentRuntimeInternal,
  input: string,
  messageID: MessageId | undefined,
  traceContext: TraceContext,
  options: {
    causation?: AgentTelemetryCausation;
    goalSummaryTargetID?: string;
    modelContext?: TitleModelContext;
  } = {},
): Promise<void> {
  const initialSession = await this.sessionStore?.getSession(this.sessionId);
  if (!initialSession || initialSession.parentID || initialSession.taskType !== "interactive") {
    return;
  }

  if (
    await shouldSkipGeneratedTitleForFirstQueryEdit.call(
      this,
      initialSession,
      messageID,
      traceContext,
    )
  ) {
    return;
  }

  const shouldPersistSessionTitle = acceptsGeneratedTitle(initialSession.titleSource);
  if (!shouldPersistSessionTitle && !options.goalSummaryTargetID) {
    this.logger?.debug("Session title generation skipped", {
      ...traceContextToLogContext(traceContext),
      event: "session_title_generation.skipped",
      module: "core.runtime",
      reason: `${initialSession.titleSource}_title`,
    });
    return;
  }
  if (options.goalSummaryTargetID) {
    this.logger?.info("Goal summary title generation started", {
      ...traceContextToLogContext(traceContext),
      event: "goal_summary_title_generation.started",
      module: "core.runtime",
      querySource: SESSION_TITLE_QUERY_SOURCE,
      status: "started",
      targetId: options.goalSummaryTargetID,
    });
  }

  const generated = await generateTitleCandidate.call(this, input, {
    causation: options.causation,
    modelContext: options.modelContext,
    messageID,
    querySource: SESSION_TITLE_QUERY_SOURCE,
    traceContext,
  });
  if (!generated) {
    if (options.goalSummaryTargetID) {
      // 首次 /goal 会把 session title sidecar 同时当作 summaryTitle 来源；
      // 这个 sidecar 空响应时必须给目标摘要写兜底，否则第一轮迭代没有语义标题。
      await persistFallbackGoalSummaryTitle.call(this, {
        objective: input,
        reason: "session_title_empty",
        targetID: options.goalSummaryTargetID,
        traceContext,
      });
    }
    return;
  }

  if (shouldPersistSessionTitle) {
    await persistGeneratedSessionTitle.call(this, {
      messageID,
      modelSelection: generated.modelSelection,
      title: generated.title,
      traceContext: generated.traceContext,
    });
  }

  if (options.goalSummaryTargetID) {
    await persistGeneratedGoalSummaryTitle.call(this, {
      targetID: options.goalSummaryTargetID,
      title: generated.title,
      traceContext: generated.traceContext,
    });
  }
}

/**
 * renameSession：用户显式重命名会话（titleSource=custom）。custom 之后自动标题
 * 生成会被跳过（见 persistGeneratedSessionTitle 的 custom_title 短路），持久化 + 发
 * SessionTitleUpdated(source:custom) 供 v4 投影 meta 更新。
 */
export async function setCustomSessionTitle(
  this: AgentRuntimeInternal,
  input: { title: string; traceContext: TraceContext },
): Promise<void> {
  const previous = await this.sessionStore?.getSession(this.sessionId);
  const previousTitle = previous?.title ?? "";
  await this.sessionStore?.updateSession({
    id: this.sessionId,
    title: input.title,
    titleSource: "custom",
  });
  await this.appendEvent(
    this.createEvent(
      SessionEventType.SessionTitleUpdated,
      {
        previousTitle,
        source: "custom",
        title: input.title,
      },
      input.traceContext,
    ),
    input.traceContext,
  );
}

async function persistGeneratedSessionTitle(
  this: AgentRuntimeInternal,
  input: {
    messageID: MessageId | undefined;
    modelSelection: ModelSelection;
    title: string;
    traceContext: TraceContext;
  },
): Promise<void> {
  // 标题 sidecar 现在会在首条 query 落库后并发启动，用户可能在 LLM 返回前编辑首条 query。
  // 写回前重新读取 session，避免旧 query 的 generated title 覆盖编辑后的首屏标题语义。
  const session = await getSessionForGeneratedTitle.call(this, input.messageID, input.traceContext);
  if (!session) return;
  if (session.titleSource === "custom") {
    this.logger?.debug("Session title generation skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "session_title_generation.skipped",
      module: "core.runtime",
      reason: "custom_title",
    });
    return;
  }

  const previousTitle = session.title;
  const updated = await this.sessionStore?.updateSession({
    expectedTitleSources: GENERATED_TITLE_EXPECTED_SOURCES,
    id: this.sessionId,
    title: input.title,
    ...(input.messageID ? { titleMessageID: input.messageID } : {}),
    titleSource: "generated",
  });
  if (!updated || updated.title !== input.title || updated.titleSource !== "generated") {
    this.logger?.debug("Session title generation skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "session_title_generation.skipped",
      module: "core.runtime",
      reason: "title_source_changed",
    });
    return;
  }

  await this.appendEvent(
    this.createEvent(
      SessionEventType.SessionTitleUpdated,
      {
        // 旧持久化事件 DTO 尚未迁移；不把该投影重新暴露为标题生成配置。
        ...(input.messageID ? { messageID: input.messageID } : {}),
        previousTitle,
        source: "generated",
        title: input.title,
      },
      input.traceContext,
    ),
    input.traceContext,
  );
}

async function getSessionForGeneratedTitle(
  this: AgentRuntimeInternal,
  messageID: MessageId | undefined,
  traceContext: TraceContext,
): Promise<SessionInfo | null> {
  const session = await this.sessionStore?.getSession(this.sessionId);
  if (!session || session.parentID || session.taskType !== "interactive") return null;
  if (
    await shouldSkipGeneratedTitleForFirstQueryEdit.call(this, session, messageID, traceContext)
  ) {
    return null;
  }
  return session;
}

async function shouldSkipGeneratedTitleForFirstQueryEdit(
  this: AgentRuntimeInternal,
  session: SessionInfo,
  messageID: MessageId | undefined,
  traceContext: TraceContext,
): Promise<boolean> {
  if (!(await isSuppressedByFirstQueryEdit.call(this, session, messageID))) return false;
  this.logger?.debug("Session title generation skipped", {
    ...traceContextToLogContext(traceContext),
    event: "session_title_generation.skipped",
    module: "core.runtime",
    reason: "first_query_edited",
  });
  return true;
}

async function isSuppressedByFirstQueryEdit(
  this: AgentRuntimeInternal,
  session: SessionInfo,
  messageID: MessageId | undefined,
): Promise<boolean> {
  // 编辑首条 query 会通过 conversation_rewind 把 target 指向旧用户消息。
  // 旧 query 的标题请求即使已经发出，也只能记录用量，不能再写回会话标题。
  if (messageID && session.revert?.targetMessageID === messageID) return true;
  return hasEditedFirstVisibleUserQuery.call(this, session);
}

async function hasEditedFirstVisibleUserQuery(
  this: AgentRuntimeInternal,
  session: SessionInfo,
): Promise<boolean> {
  const revert = session.revert;
  if (revert?.kind !== "conversation_rewind" || !revert.targetMessageID) return false;
  const keptMessageIds = new Set(revert.keptMessageIDs ?? []);
  if (keptMessageIds.size === 0) return true;

  const messages = await this.sessionStore?.messages({ sessionID: this.sessionId });
  if (!messages) return false;
  return !messages.some(
    (message) => keptMessageIds.has(message.info.id) && isVisibleRealUserMessage(message),
  );
}

function isVisibleRealUserMessage(message: MessageWithParts): boolean {
  const info = message.info;
  return info.role === "user" && info.synthetic !== true && info.visibility !== "model-only";
}
