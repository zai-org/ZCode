/* eslint-disable max-lines -- 旧版临时驱动必须逐项翻译统一场景，并通过旧 production builder/reporter 发到最终出口。 */
import {
  type IPlatformService,
  type ZCodeContextCompactionTimelineMeta,
  type ZCodeProvider,
  type ZCodeStreamEvent,
  type ZCodeUsage,
} from "@zcode/shared";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { reportChatErrorBannerTelemetry } from "@/lib/chatErrorBannerTelemetry.js";
import {
  getConversationTelemetryParityScenario,
  type ConversationTelemetryParityOperation,
} from "@/lib/conversationTelemetryParityScenarioDefinitions.js";
import {
  runRequestVerificationParityAssertions,
  runQuotaParityStateAssertions,
} from "@/lib/conversationTelemetryParityStateE2E.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import {
  activatePromptTelemetry,
  buildCompactionTelemetryExtraDetail,
  finalizePromptTelemetry,
  getActivePromptMessageId,
  getActivePromptModelName,
  queuePromptTelemetry,
  recordAgentStepTelemetryEvent,
  recordComposerFocus,
  recordComposerTextChange,
  recordPromptModelRequestStarted,
  recordPromptPermissionRequest,
  recordPromptPermissionResponse,
  recordPromptTokenUsageDelta,
  resetMessageTelemetryForTest,
} from "@/lib/messageTelemetry.js";
import {
  reportPlanUsageModelRequestStartedToArms,
  reportPlanUsageTtftToArms,
} from "@/lib/planUsageArmsTelemetry.js";
import {
  clearStreamStallTracking,
  recordStreamChunkArrival,
  reportUiFirstToken,
  reportUiMessageComplete,
  reportUiToolCallDetail,
  reportUiTurnBreakdown,
  setUiPerfArmsReporter,
} from "@/lib/uiPerfArmsTelemetry.js";

interface LegacyLifecycle {
  sessionId: string;
  commandId: string;
  taskKey: string;
  sendTime: number;
  foregroundFirstTokenAt: number | null;
  legacyFirstTokenObserved: boolean;
  active: boolean;
  turnId?: string;
  startedTools: Set<string>;
  terminalUsage?: ZCodeUsage;
  lastErrorMessage?: string;
}

interface LegacyScope {
  name: string;
  now: number;
  acceptedCommands: Set<string>;
  eventIds: Set<string>;
  terminalKeys: Set<string>;
  compactionKeys: Set<string>;
  owners: Map<string, string>;
  foregroundCounts: Map<string, number>;
  lifecycles: Map<string, LegacyLifecycle>;
}

interface LegacyScenarioResult {
  caseId: string;
  minimumArmsInventory: Record<string, number>;
  minimumReportInventory: Record<string, number>;
  operationCount: number;
  proof: string[];
  stateAssertions: string[];
}

declare global {
  interface Window {
    __zcodeConversationTelemetryParityE2E?: {
      variant: "current" | "legacy";
      run(caseId: string): Promise<LegacyScenarioResult>;
    };
  }
}

export function installLegacyConversationTelemetryParityE2EBridge(input: {
  platform: IPlatformService;
  isDesktop: boolean;
}): () => void {
  if (!input.isDesktop || !shouldExposeE2EStoreBridge()) return () => undefined;
  const bridge = {
    variant: "legacy" as const,
    run: (caseId: string) => runLegacyScenario(input.platform, caseId),
  };
  window.__zcodeConversationTelemetryParityE2E = bridge;
  return () => {
    if (window.__zcodeConversationTelemetryParityE2E === bridge) {
      delete window.__zcodeConversationTelemetryParityE2E;
    }
  };
}

async function runLegacyScenario(
  platform: IPlatformService,
  caseId: string,
): Promise<LegacyScenarioResult> {
  const scenario = getConversationTelemetryParityScenario(caseId);
  resetMessageTelemetryForTest();
  const scopes = new Map<string, LegacyScope>();
  const visibleErrorKeys = new Set<string>();
  const stateAssertions: string[] = [];
  const getScope = (name = "default"): LegacyScope => {
    const existing = scopes.get(name);
    if (existing) return existing;
    const created: LegacyScope = {
      name,
      now: 0,
      acceptedCommands: new Set(),
      eventIds: new Set(),
      terminalKeys: new Set(),
      compactionKeys: new Set(),
      owners: new Map(),
      foregroundCounts: new Map(),
      lifecycles: new Map(),
    };
    scopes.set(name, created);
    return created;
  };

  for (const operation of scenario.operations) {
    await applyLegacyOperation({
      caseId,
      getScope,
      operation,
      platform,
      stateAssertions,
      visibleErrorKeys,
    });
  }
  return {
    caseId,
    minimumArmsInventory: scenario.minimumArmsInventory,
    minimumReportInventory: scenario.minimumReportInventory,
    operationCount: scenario.operations.length,
    proof: scenario.proof,
    stateAssertions,
  };
}

async function applyLegacyOperation(input: {
  caseId: string;
  getScope(name?: string): LegacyScope;
  operation: ConversationTelemetryParityOperation;
  platform: IPlatformService;
  stateAssertions: string[];
  visibleErrorKeys: Set<string>;
}): Promise<void> {
  const { operation } = input;
  if (operation.kind === "web.noop") {
    await runLegacyWebNoopOperations(input, operation.operations);
    rememberStateAssertion(input.stateAssertions, "web:no-final-output");
    return;
  }
  if (operation.kind === "quota.assert") {
    input.stateAssertions.push(...runQuotaParityStateAssertions());
    return;
  }
  if (operation.kind === "verification.assert") {
    input.stateAssertions.push(...runRequestVerificationParityAssertions());
    return;
  }
  const scope = input.getScope(operation.scope);
  if ("now" in operation) scope.now = operation.now;

  switch (operation.kind) {
    case "focus":
      recordComposerFocus(scopeKey(input.caseId, scope), scope.now);
      return;
    case "text":
      recordComposerTextChange(scopeKey(input.caseId, scope), operation.value, scope.now);
      return;
    case "seed": {
      if (scope.acceptedCommands.has(operation.commandId)) return;
      scope.acceptedCommands.add(operation.commandId);
      const taskKey = taskKeyFor(input.caseId, scope, operation.sessionId);
      const detail = queuePromptTelemetry({
        workspacePath: scopeKey(input.caseId, scope),
        taskId: taskKey,
        messageId: operation.commandId,
        sendTime: operation.now,
        extraDetail: {
          ask_mode: operation.askMode ?? "",
          model_name: operation.modelName ?? "",
          model_provider: operation.modelProvider ?? "",
          ...(operation.providerHostname ? { provider_name: operation.providerHostname } : {}),
          agent: "glm",
          plan_status: "unknown",
          plan_product_id: "",
        },
      });
      scope.lifecycles.set(operation.commandId, {
        sessionId: operation.sessionId,
        commandId: operation.commandId,
        taskKey,
        sendTime: operation.now,
        foregroundFirstTokenAt: null,
        legacyFirstTokenObserved: false,
        active: false,
        startedTools: new Set(),
      });
      await reportLegacyEvent(
        input.platform,
        "send_btn",
        "ck",
        detail,
        operation.sessionId,
        operation.commandId,
      );
      return;
    }
    case "foreground.attach": {
      const previous = scope.owners.get(operation.owner);
      if (previous === operation.sessionId) return;
      if (previous) decrementForeground(scope, previous);
      scope.owners.set(operation.owner, operation.sessionId);
      scope.foregroundCounts.set(
        operation.sessionId,
        (scope.foregroundCounts.get(operation.sessionId) ?? 0) + 1,
      );
      return;
    }
    case "foreground.detach": {
      const previous = scope.owners.get(operation.owner);
      if (!previous) return;
      scope.owners.delete(operation.owner);
      decrementForeground(scope, previous);
      clearStreamStallTracking(previous);
      return;
    }
    case "turn.started": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      const lifecycle = scope.lifecycles.get(operation.commandId);
      if (!lifecycle) return;
      lifecycle.active = true;
      lifecycle.turnId = operation.turnId;
      activatePromptTelemetry(lifecycle.taskKey, lifecycle.commandId);
      return;
    }
    case "model.status": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      const networkEvent = toNetworkEvent(operation);
      reportPlanUsageModelRequestStartedToArms(input.platform, networkEvent);
      const lifecycle = operation.commandId ? scope.lifecycles.get(operation.commandId) : undefined;
      if (lifecycle?.active) {
        recordPromptModelRequestStarted(lifecycle.taskKey, networkEvent, lifecycle.commandId);
        if (operation.status === "model_request_failed") {
          lifecycle.lastErrorMessage = operation.reason;
        }
      }
      return;
    }
    case "chunk": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      const lifecycle = activeLifecycle(scope, operation.commandId);
      if (!lifecycle) return;
      lifecycle.legacyFirstTokenObserved = true;
      const foreground = isForeground(scope, operation.sessionId);
      if (foreground && lifecycle.foregroundFirstTokenAt === null) {
        lifecycle.foregroundFirstTokenAt = operation.now;
      }
      const event = {
        type: operation.channel === "thought" ? "agent_thought_chunk" : "agent_message_chunk",
        taskId: operation.sessionId,
        traceId: operation.eventId,
        inputId: operation.commandId,
        content: "",
        ...(operation.parentToolCallId ? { parentToolUseId: operation.parentToolCallId } : {}),
      } as Extract<ZCodeStreamEvent, { type: "agent_thought_chunk" | "agent_message_chunk" }>;
      await reportFinalizedSteps(
        input.platform,
        lifecycle,
        recordAgentStepTelemetryEvent({
          taskId: lifecycle.taskKey,
          event,
          activeInputId: lifecycle.commandId,
          clientMode: "desktop-continuous",
          now: operation.now,
        }),
      );
      if (foreground) {
        recordStreamChunkArrival(operation.sessionId, {
          now: operation.now,
          talkId: operation.sessionId,
          waitingTool: false,
          model: getActivePromptModelName(lifecycle.taskKey),
          messageId: operation.channel === "text" ? `${operation.commandId}-assistant` : undefined,
          chunkType: operation.channel === "thought" ? "thought" : "message",
        });
      }
      return;
    }
    case "permission": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      const lifecycle = activeLifecycle(scope, operation.commandId);
      if (!lifecycle) return;
      if (operation.phase === "requested") {
        recordPromptPermissionRequest({
          taskId: lifecycle.taskKey,
          requestId: operation.requestId,
          toolCallId: operation.toolCallId,
          now: operation.now,
        });
      } else {
        recordPromptPermissionResponse({
          taskId: lifecycle.taskKey,
          requestId: operation.requestId,
          now: operation.now,
        });
      }
      return;
    }
    case "tool": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      const lifecycle = activeLifecycle(scope, operation.commandId);
      if (!lifecycle) return;
      lifecycle.legacyFirstTokenObserved = true;
      const foreground = isForeground(scope, operation.sessionId);
      if (foreground && lifecycle.foregroundFirstTokenAt === null) {
        lifecycle.foregroundFirstTokenAt = operation.now;
      }
      clearStreamStallTracking(operation.sessionId);
      const started = lifecycle.startedTools.has(operation.toolCallId);
      const terminal = operation.phase === "completed" || operation.phase === "failed";
      lifecycle.startedTools.add(operation.toolCallId);
      const event =
        !started && !terminal
          ? ({
              type: "tool_call",
              taskId: operation.sessionId,
              traceId: operation.eventId,
              inputId: operation.commandId,
              toolId: operation.toolCallId,
              parentToolUseId: operation.parentToolCallId,
              input: {},
              toolName: operation.toolName,
              kind: operation.toolName,
              title: "",
              raw: {},
            } as Extract<ZCodeStreamEvent, { type: "tool_call" }>)
          : ({
              type: "tool_call_update",
              taskId: operation.sessionId,
              traceId: operation.eventId,
              inputId: operation.commandId,
              toolId: operation.toolCallId,
              parentToolUseId: operation.parentToolCallId,
              status:
                operation.phase === "completed"
                  ? "completed"
                  : operation.phase === "failed"
                    ? "failed"
                    : "in_progress",
              toolName: operation.toolName,
              kind: operation.toolName,
              error: operation.errorMessage,
              raw: {},
            } as Extract<ZCodeStreamEvent, { type: "tool_call_update" }>);
      await reportFinalizedSteps(
        input.platform,
        lifecycle,
        recordAgentStepTelemetryEvent({
          taskId: lifecycle.taskKey,
          event,
          activeInputId: lifecycle.commandId,
          clientMode: "desktop-continuous",
          now: operation.now,
        }),
      );
      if (operation.errorMessage) lifecycle.lastErrorMessage = operation.errorMessage;
      if (foreground && terminal && operation.performance) {
        reportUiToolCallDetail({
          toolName: operation.toolName,
          status: operation.phase === "completed" ? "completed" : "failed",
          talkId: operation.sessionId,
          messageId: getActivePromptMessageId(lifecycle.taskKey),
          toolCallId: operation.toolCallId,
          parentToolCallId: operation.parentToolCallId,
          totalMs: operation.performance.totalMs,
          permissionWaitMs: operation.performance.permissionWaitMs,
          commandRunMs: operation.performance.commandRunMs,
          exitCode: operation.performance.exitCode,
          timedOut: operation.performance.timedOut,
          outputBytes: operation.performance.outputBytes,
          commandCategory: operation.performance.commandCategory,
          commandName: operation.performance.commandName,
          commandCount: operation.performance.commandCount,
          commandStatus: operation.performance.commandStatus,
          workspaceKind: operation.performance.workspaceKind,
        });
      }
      return;
    }
    case "usage": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      const lifecycle = activeLifecycle(scope, operation.commandId);
      if (!lifecycle) return;
      recordPromptTokenUsageDelta({
        taskId: lifecycle.taskKey,
        eventKey: operation.eventId,
        usage: {
          inputTokens: operation.inputTokens,
          outputTokens: operation.outputTokens,
          totalTokens: operation.inputTokens + operation.outputTokens,
          reasoningTokens: operation.reasoningTokens ?? 0,
          cachedInputTokens: operation.cacheReadTokens ?? 0,
          cachedWriteInputTokens: operation.cacheWriteTokens ?? 0,
        },
      });
      lifecycle.terminalUsage = mergeUsage(lifecycle.terminalUsage, {
        inputTokens: operation.inputTokens,
        outputTokens: operation.outputTokens,
        totalTokens: operation.inputTokens + operation.outputTokens,
        reasoningTokens: operation.reasoningTokens ?? 0,
        cachedInputTokens: operation.cacheReadTokens ?? 0,
        cachedWriteInputTokens: operation.cacheWriteTokens ?? 0,
      });
      return;
    }
    case "terminal": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      const lifecycle = activeLifecycle(scope, operation.commandId);
      if (!lifecycle) return;
      const terminalKey = `${operation.sessionId}\u0000${operation.commandId}\u0000message_completion`;
      if (!remember(scope.terminalKeys, terminalKey)) return;
      const terminalEvent =
        operation.status === "success"
          ? ({
              type: "task_complete",
              taskId: operation.sessionId,
              traceId: operation.eventId,
              inputId: operation.commandId,
              stopReason: "complete",
            } as Extract<ZCodeStreamEvent, { type: "task_complete" }>)
          : ({
              type: "task_error",
              taskId: operation.sessionId,
              traceId: operation.eventId,
              inputId: operation.commandId,
              error:
                operation.errorMessage ?? lifecycle.lastErrorMessage ?? operation.errorCode ?? "",
              code: operation.errorCode,
            } as Extract<ZCodeStreamEvent, { type: "task_error" }>);
      await reportFinalizedSteps(
        input.platform,
        lifecycle,
        recordAgentStepTelemetryEvent({
          taskId: lifecycle.taskKey,
          event: terminalEvent,
          activeInputId: lifecycle.commandId,
          clientMode: "desktop-continuous",
          now: operation.now,
        }),
      );
      const status =
        operation.status === "success"
          ? "success"
          : operation.status === "interrupted"
            ? "user_interrupt"
            : "fail";
      const completion = finalizePromptTelemetry({
        taskId: lifecycle.taskKey,
        status,
        finishedAt: operation.now,
        usage: operation.status === "success" ? lifecycle.terminalUsage : undefined,
        errorType: operation.errorCode,
        errorMsg: operation.errorMessage ?? lifecycle.lastErrorMessage,
      });
      if (completion) {
        await reportLegacyEvent(
          input.platform,
          "message_completion",
          "agent_trace",
          completion.eventExtraDetail,
          operation.sessionId,
          operation.commandId,
        );
        if (isForeground(scope, operation.sessionId)) {
          reportCompletionArms(input.platform, lifecycle, completion.eventExtraDetail);
        }
      }
      clearStreamStallTracking(operation.sessionId);
      scope.lifecycles.delete(operation.commandId);
      return;
    }
    case "compaction": {
      if (!remember(scope.eventIds, operation.eventId)) return;
      const dedupeKey = `${operation.sessionId}\u0000${operation.operationId}\u0000context_compaction`;
      if (!remember(scope.compactionKeys, dedupeKey) || !isForeground(scope, operation.sessionId))
        return;
      const timeline: ZCodeContextCompactionTimelineMeta = {
        version: 1,
        kind: "synthetic",
        type: "context_compaction",
        operationId: operation.operationId,
        status: operation.status,
        trigger: operation.trigger,
        display: "separator",
        reason: operation.reason,
        summaryMessageId: operation.summaryMessageId,
        preCompactTokenCount: operation.preCompactTokenCount,
        postCompactTokenCount: operation.postCompactTokenCount,
        truePostCompactTokenCount: operation.truePostCompactTokenCount,
        attempt: 1,
        startedAt: operation.startedAt,
        endedAt: operation.endedAt,
      };
      const detail = buildCompactionTelemetryExtraDetail({
        timeline,
        provider: "glm" as ZCodeProvider,
        modelName: operation.modelName,
      });
      if (detail) {
        await reportLegacyEvent(
          input.platform,
          "context_compaction",
          "agent_trace",
          detail,
          operation.sessionId,
          operation.summaryMessageId ?? operation.operationId,
        );
      }
      return;
    }
    case "visible.error":
      if (operation.suppressed || input.visibleErrorKeys.has(operation.errorKey)) return;
      input.visibleErrorKeys.add(operation.errorKey);
      await reportChatErrorBannerTelemetry(input.platform, {
        errorKey: operation.errorKey,
        displayMessage: operation.displayMessage,
        error: {
          code: operation.code,
          message: operation.displayMessage,
          traceId: operation.traceId,
          taskId: operation.sessionId,
          detail: operation.detail,
        },
        providerBusinessRecoveryAction: null,
      });
      return;
    case "feedback":
      // 旧版反馈只有 reaction。当前版自 !3768 起多一个 source_message_id（PV4-21 实测覆盖），parity 暂不
      // 建模；legacy 基线前移到含该字段的版本后，再与 conversationTelemetryParityE2E.ts 两侧同步加入。
      await reportLegacyEvent(
        input.platform,
        "assistant_message_feedback",
        "ck",
        { reaction: operation.reaction },
        operation.sessionId,
        operation.messageId,
        "chat",
      );
      return;
    case "scope.dispose":
      return;
  }
}

async function runLegacyWebNoopOperations(
  input: Parameters<typeof applyLegacyOperation>[0],
  operations: ConversationTelemetryParityOperation[],
): Promise<void> {
  const noopPlatform = {
    reportTelemetryEvent: async () => undefined,
    reportArmsCustomEvent: async () => undefined,
  } as unknown as IPlatformService;
  const scopes = new Map<string, LegacyScope>();
  const getScope = (name = "web"): LegacyScope => {
    const existing = scopes.get(name);
    if (existing) return existing;
    const created: LegacyScope = {
      name: `web-${name}`,
      now: 0,
      acceptedCommands: new Set(),
      eventIds: new Set(),
      terminalKeys: new Set(),
      compactionKeys: new Set(),
      owners: new Map(),
      foregroundCounts: new Map(),
      lifecycles: new Map(),
    };
    scopes.set(name, created);
    return created;
  };

  setUiPerfArmsReporter(null);
  try {
    for (const operation of operations) {
      await applyLegacyOperation({
        ...input,
        getScope,
        operation,
        platform: noopPlatform,
      });
    }
  } finally {
    setUiPerfArmsReporter(input.platform);
  }
}

function rememberStateAssertion(assertions: string[], label: string): void {
  if (!assertions.includes(label)) assertions.push(label);
}

async function reportFinalizedSteps(
  platform: IPlatformService,
  lifecycle: LegacyLifecycle,
  finalized: Array<{ eventExtraDetail: Record<string, string> }>,
): Promise<void> {
  for (const step of finalized) {
    await reportLegacyEvent(
      platform,
      "agent_step",
      "agent_trace",
      step.eventExtraDetail,
      lifecycle.sessionId,
      lifecycle.commandId,
    );
  }
}

function reportCompletionArms(
  platform: IPlatformService,
  lifecycle: LegacyLifecycle,
  detail: Record<string, string>,
): void {
  const ttft =
    lifecycle.foregroundFirstTokenAt === null
      ? lifecycle.legacyFirstTokenObserved
        ? undefined
        : -1
      : lifecycle.foregroundFirstTokenAt - lifecycle.sendTime;
  if (ttft !== undefined) {
    reportUiFirstToken({
      ttftMs: ttft,
      model: detail.model_name || undefined,
      talkId: lifecycle.sessionId,
      messageId: lifecycle.commandId,
    });
    reportPlanUsageTtftToArms(platform, {
      providerId: detail.model_provider,
      modelName: detail.model_name,
      askMode: detail.ask_mode,
      ttftMs: ttft,
    });
  }
  const duration = finite(detail.duration_ms);
  if (duration === undefined) return;
  reportUiMessageComplete({
    durationMs: duration,
    result: detail.status ?? "",
    model: detail.model_name || undefined,
    talkId: lifecycle.sessionId,
    messageId: lifecycle.commandId,
  });
  reportUiTurnBreakdown({
    durationMs: duration,
    result: detail.status ?? "",
    model: detail.model_name || undefined,
    talkId: lifecycle.sessionId,
    messageId: lifecycle.commandId,
    ttftMs: ttft,
    waitingMs: finite(detail.waiting_ms),
    toolCallTotal: finite(detail.tool_call_total),
    toolCallFailed: finite(detail.tool_call_failed),
    agentStepCount: finite(detail.agent_step_cnt),
    retryCount: finite(detail.retry_cnt),
    fileChangeCount: finite(detail.file_change_cnt),
    generatedCodeLines: finite(detail.generated_code_lines),
  });
}

async function reportLegacyEvent(
  platform: IPlatformService,
  elementName: string,
  eventType: string,
  detail: Record<string, string>,
  talkId: string,
  messageId: string,
  eventRegion = "app",
): Promise<void> {
  await reportAppTelemetryEvent(
    platform,
    {
      elementName,
      eventRegion,
      eventType,
      eventExtraDetail: detail,
      talkId,
      messageId,
    },
    "conversation-telemetry-legacy-parity-e2e",
  );
}

function toNetworkEvent(
  operation: Extract<ConversationTelemetryParityOperation, { kind: "model.status" }>,
): Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }> {
  return {
    type: "task_network_debug_status",
    taskId: operation.sessionId,
    traceId: operation.eventId,
    eventKey: operation.eventId,
    inputId: operation.commandId,
    queryId: `${operation.requestId}-query`,
    requestId: operation.requestId,
    statusType: operation.status,
    providerId: operation.providerId,
    modelId: operation.modelId,
    baseURL: operation.providerHostname ? `https://${operation.providerHostname}` : undefined,
    transport: "fetch",
    querySource: "main_turn",
    attempt: 1,
    maxAttempts: 3,
    durationMs: operation.durationMs,
    reason: operation.reason,
    retryable: operation.retryable,
    statusCode: operation.statusCode,
    delayMs: operation.delayMs,
    nextAttempt: operation.nextAttempt,
    idleMs: operation.idleMs,
    timeoutMs: operation.timeoutMs,
  } as Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }>;
}

function activeLifecycle(scope: LegacyScope, commandId: string): LegacyLifecycle | undefined {
  const lifecycle = scope.lifecycles.get(commandId);
  return lifecycle?.active ? lifecycle : undefined;
}

function scopeKey(caseId: string, scope: LegacyScope): string {
  return `telemetry-parity\u0000${caseId}\u0000${scope.name}`;
}

function taskKeyFor(caseId: string, scope: LegacyScope, sessionId: string): string {
  return `${scopeKey(caseId, scope)}\u0000${sessionId}`;
}

function isForeground(scope: LegacyScope, sessionId: string): boolean {
  return (scope.foregroundCounts.get(sessionId) ?? 0) > 0;
}

function decrementForeground(scope: LegacyScope, sessionId: string): void {
  const next = (scope.foregroundCounts.get(sessionId) ?? 1) - 1;
  if (next > 0) scope.foregroundCounts.set(sessionId, next);
  else scope.foregroundCounts.delete(sessionId);
}

function remember(set: Set<string>, key: string): boolean {
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

function mergeUsage(left: ZCodeUsage | undefined, right: ZCodeUsage): ZCodeUsage {
  if (!left) return right;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
    cachedWriteInputTokens:
      (left.cachedWriteInputTokens ?? 0) + (right.cachedWriteInputTokens ?? 0),
  };
}

function finite(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
