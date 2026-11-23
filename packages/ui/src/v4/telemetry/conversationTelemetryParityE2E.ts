/* eslint-disable max-lines -- 测试桥只负责把统一的 19 个场景输入翻译成 V4 live fact，集中映射便于隐私审计。 */
import type { IPlatformService } from "@zcode/shared";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import {
  getConversationTelemetryParityScenario,
  type ConversationTelemetryParityOperation,
} from "@/lib/conversationTelemetryParityScenarioDefinitions.js";
import {
  runRequestVerificationParityAssertions,
  runQuotaParityStateAssertions,
} from "@/lib/conversationTelemetryParityStateE2E.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { resetMessageTelemetryForTest } from "@/lib/messageTelemetry.js";
import { setUiPerfArmsReporter } from "@/lib/uiPerfArmsTelemetry.js";
import { ConversationTelemetrySupervisor } from "@/v4/telemetry/conversationTelemetrySupervisor.js";

interface ParityScopeRuntime {
  now: number;
  sequence: number;
  supervisor: ConversationTelemetrySupervisor;
  foregroundOwners: Map<string, object>;
}

export interface ConversationTelemetryParityScenarioResult {
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
      run(caseId: string): Promise<ConversationTelemetryParityScenarioResult>;
    };
  }
}

export function installConversationTelemetryParityE2EBridge(input: {
  platform: IPlatformService;
  isDesktop: boolean;
}): () => void {
  if (!input.isDesktop || !shouldExposeE2EStoreBridge()) {
    return () => undefined;
  }

  const bridge = {
    variant: "current" as const,
    run: (caseId: string) => runCurrentScenario(input.platform, caseId),
  };
  window.__zcodeConversationTelemetryParityE2E = bridge;
  return () => {
    if (window.__zcodeConversationTelemetryParityE2E === bridge) {
      delete window.__zcodeConversationTelemetryParityE2E;
    }
  };
}

async function runCurrentScenario(
  platform: IPlatformService,
  caseId: string,
): Promise<ConversationTelemetryParityScenarioResult> {
  const scenario = getConversationTelemetryParityScenario(caseId);
  resetMessageTelemetryForTest();
  const scopes = new Map<string, ParityScopeRuntime>();
  const visibleErrorKeys = new Set<string>();
  const stateAssertions: string[] = [];

  const getScope = (scopeName = "default"): ParityScopeRuntime => {
    const existing = scopes.get(scopeName);
    if (existing) return existing;
    const created: ParityScopeRuntime = {
      now: 0,
      sequence: 0,
      foregroundOwners: new Map(),
      supervisor: undefined as unknown as ConversationTelemetrySupervisor,
    };
    created.supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: `telemetry-parity\u0000${caseId}\u0000${scopeName}`,
      now: () => created.now,
    });
    scopes.set(scopeName, created);
    return created;
  };

  try {
    for (const operation of scenario.operations) {
      await applyCurrentOperation({
        caseId,
        getScope,
        operation,
        platform,
        stateAssertions,
        visibleErrorKeys,
      });
    }
    await Promise.all([...scopes.values()].map((scope) => scope.supervisor.flushReportsForTest()));
    return {
      caseId,
      minimumArmsInventory: scenario.minimumArmsInventory,
      minimumReportInventory: scenario.minimumReportInventory,
      operationCount: scenario.operations.length,
      proof: scenario.proof,
      stateAssertions,
    };
  } finally {
    for (const scope of scopes.values()) {
      await scope.supervisor.flushReportsForTest();
      scope.supervisor.dispose();
    }
  }
}

async function applyCurrentOperation(input: {
  caseId: string;
  getScope(scopeName?: string): ParityScopeRuntime;
  operation: ConversationTelemetryParityOperation;
  platform: IPlatformService;
  stateAssertions: string[];
  visibleErrorKeys: Set<string>;
}): Promise<void> {
  const { operation } = input;
  if (operation.kind === "web.noop") {
    await runCurrentWebNoopOperations(input, operation.operations);
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
      scope.supervisor.recordComposerFocus();
      return;
    case "text":
      scope.supervisor.recordComposerTextChange(operation.value);
      return;
    case "seed":
      scope.supervisor.acceptPromptSeed({
        sessionId: operation.sessionId,
        sourceCommandId: operation.commandId,
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
      return;
    case "foreground.attach": {
      const owner = scope.foregroundOwners.get(operation.owner) ?? {};
      scope.foregroundOwners.set(operation.owner, owner);
      scope.supervisor.attachForeground(owner, operation.sessionId);
      return;
    }
    case "foreground.detach": {
      const owner = scope.foregroundOwners.get(operation.owner);
      if (owner) {
        // attachForeground 返回的 disposer 不必额外保存：把同 owner 绑定到一个不会参与
        // case 的 sentinel session，会先递减旧 session，随后 scope dispose 清理 sentinel。
        scope.supervisor.attachForeground(owner, `detached:${operation.owner}`);
      }
      return;
    }
    case "turn.started":
      scope.supervisor.handleFact(
        toFact(scope, operation, {
          kind: "turn.started",
          executionKind: "agent",
        }),
      );
      return;
    case "model.status":
      scope.supervisor.handleFact(
        toFact(scope, operation, {
          kind: "model.request.status",
          requestId: operation.requestId,
          status: operation.status,
          providerId: operation.providerId,
          modelId: operation.modelId,
          providerHostname: operation.providerHostname,
          transport: "fetch",
          querySource: "main_turn",
          queryId: `${operation.requestId}-query`,
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
        }),
      );
      return;
    case "chunk":
      scope.supervisor.handleFact(
        toFact(scope, operation, {
          kind: "stream.chunk",
          channel: operation.channel,
          chunkLength: 1,
          firstChunk: operation.firstChunk,
          assistantMessageId: `${operation.commandId}-assistant`,
          parentToolCallId: operation.parentToolCallId,
        }),
      );
      return;
    case "permission":
      scope.supervisor.handleFact(
        toFact(scope, operation, {
          kind: "permission.lifecycle",
          phase: operation.phase,
          requestId: operation.requestId,
          toolCallId: operation.toolCallId,
          toolName: "Bash",
          decision: operation.decision,
        }),
      );
      return;
    case "tool":
      scope.supervisor.handleFact(
        toFact(scope, operation, {
          kind: "tool.lifecycle",
          phase: operation.phase,
          toolCallId: operation.toolCallId,
          toolName: operation.toolName,
          errorCode: operation.errorCode,
          errorMessage: operation.errorMessage,
          parentToolCallId: operation.parentToolCallId,
          performance: operation.performance,
        }),
      );
      return;
    case "usage":
      scope.supervisor.handleFact(
        toFact(scope, operation, {
          kind: "usage.delta",
          inputTokens: operation.inputTokens,
          outputTokens: operation.outputTokens,
          totalTokens: operation.inputTokens + operation.outputTokens,
          reasoningTokens: operation.reasoningTokens ?? 0,
          cacheReadTokens: operation.cacheReadTokens ?? 0,
          cacheWriteTokens: operation.cacheWriteTokens ?? 0,
        }),
      );
      return;
    case "terminal":
      scope.supervisor.handleFact(
        toFact(scope, operation, {
          kind: "turn.terminal",
          status: operation.status,
          errorCode: operation.errorCode,
          errorMessage: operation.errorMessage,
        }),
      );
      return;
    case "compaction":
      scope.supervisor.handleFact({
        version: 1,
        eventId: operation.eventId,
        eventSeq: scope.sequence++,
        occurredAt: operation.now,
        sessionId: operation.sessionId,
        kind: "compaction.terminal",
        operationId: operation.operationId,
        summaryMessageId: operation.summaryMessageId,
        status: operation.status,
        trigger: operation.trigger,
        compactReason: operation.compactReason,
        reason: operation.reason,
        attempt: 1,
        startedAt: operation.startedAt,
        endedAt: operation.endedAt,
        preCompactTokenCount: operation.preCompactTokenCount,
        postCompactTokenCount: operation.postCompactTokenCount,
        truePostCompactTokenCount: operation.truePostCompactTokenCount,
        modelName: operation.modelName,
        modelProvider: operation.modelProvider,
      });
      return;
    case "visible.error":
      if (operation.suppressed || input.visibleErrorKeys.has(operation.errorKey)) return;
      input.visibleErrorKeys.add(operation.errorKey);
      scope.supervisor.reportVisibleChatError({
        errorKey: operation.errorKey,
        displayMessage: operation.displayMessage,
        error: {
          code: operation.code,
          message: operation.displayMessage,
          traceId: operation.traceId,
          taskId: operation.sessionId,
          detail: operation.detail,
        },
      });
      return;
    case "feedback":
      // 真实组件（ConversationAssistantTextActions）自 !3768 起还上报 source_message_id（所在轮轮头
      // sourceCommandId），由 PV4-21 实测覆盖。parity 与 legacy 基线逐字段比对，legacy 没有这个字段，
      // 只在这里加会造成 payload mismatch；待 legacy 基线前移到含该字段的版本后，两侧同步加入。
      await reportAppTelemetryEvent(
        input.platform,
        {
          elementName: "assistant_message_feedback",
          eventRegion: "chat",
          eventType: "ck",
          eventExtraDetail: { reaction: operation.reaction },
          talkId: operation.sessionId,
          messageId: operation.messageId,
        },
        "conversation-telemetry-parity-e2e",
      );
      return;
    case "scope.dispose":
      await scope.supervisor.flushReportsForTest();
      scope.supervisor.dispose();
      return;
  }
}

async function runCurrentWebNoopOperations(
  input: Parameters<typeof applyCurrentOperation>[0],
  operations: ConversationTelemetryParityOperation[],
): Promise<void> {
  const noopPlatform = {
    reportTelemetryEvent: async () => undefined,
    reportArmsCustomEvent: async () => undefined,
  } as unknown as IPlatformService;
  const scopes = new Map<string, ParityScopeRuntime>();
  const getScope = (scopeName = "web"): ParityScopeRuntime => {
    const existing = scopes.get(scopeName);
    if (existing) return existing;
    const created: ParityScopeRuntime = {
      now: 0,
      sequence: 0,
      foregroundOwners: new Map(),
      supervisor: undefined as unknown as ConversationTelemetrySupervisor,
    };
    created.supervisor = new ConversationTelemetrySupervisor({
      platform: noopPlatform,
      workspaceScopeKey: `telemetry-parity\u0000${input.caseId}\u0000web\u0000${scopeName}`,
      now: () => created.now,
    });
    scopes.set(scopeName, created);
    return created;
  };

  // Web reporter 的 production 边界就是 no-op。这里仍执行完整场景；如果任何 UI ARMS
  // 意外穿透到桌面全局 reporter，TDP19 的最终 inventory 会立刻多出一组并使差分失败。
  setUiPerfArmsReporter(null);
  try {
    for (const operation of operations) {
      await applyCurrentOperation({
        ...input,
        getScope,
        operation,
        platform: noopPlatform,
      });
    }
    await Promise.all([...scopes.values()].map((scope) => scope.supervisor.flushReportsForTest()));
  } finally {
    for (const scope of scopes.values()) {
      await scope.supervisor.flushReportsForTest();
      scope.supervisor.dispose();
    }
    setUiPerfArmsReporter(input.platform);
  }
}

function rememberStateAssertion(assertions: string[], label: string): void {
  if (!assertions.includes(label)) assertions.push(label);
}

function toFact(
  scope: ParityScopeRuntime,
  operation: Extract<
    ConversationTelemetryParityOperation,
    {
      kind:
        | "turn.started"
        | "model.status"
        | "chunk"
        | "permission"
        | "tool"
        | "usage"
        | "terminal";
    }
  >,
  detail: Record<string, unknown>,
): ConversationTelemetryFact {
  return {
    version: 1,
    eventId: operation.eventId,
    eventSeq: scope.sequence++,
    occurredAt: operation.now,
    sessionId: operation.sessionId,
    ...(operation.commandId ? { sourceCommandId: operation.commandId } : {}),
    ...(operation.turnId ? { turnId: operation.turnId } : {}),
    ...detail,
  } as ConversationTelemetryFact;
}
