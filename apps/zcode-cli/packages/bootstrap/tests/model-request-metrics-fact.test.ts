// 模型请求指标事实（docs/monitoring/conversation-telemetry-v4.md「模型请求指标」，扩展进程 §10）。
import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  conversationTelemetryFactSchema,
  modelRequestMetricsFactSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationTelemetryFactNormalizer } from "../src/zcode-protocol-v4/conversation-telemetry-facts.js";

function event(type: SessionEvent["type"], payload: unknown, seq: number): SessionEvent {
  return {
    id: `event-${seq}`,
    sessionId: "session",
    turnId: "turn",
    traceId: "trace",
    sequenceNumber: seq,
    timestamp: new Date(1_700_000_000_000 + seq),
    type,
    payload,
  } as SessionEvent;
}

function completed(querySource: string, seq: number) {
  return event(
    SessionEventType.ModelNetworkStatus,
    {
      type: "model_request_completed",
      timestamp: new Date().toISOString(),
      traceId: "trace",
      requestId: `request-${seq}`,
      providerId: "provider",
      modelId: "model",
      baseURL: "https://api.example.com/v1",
      transport: "http",
      attempt: 1,
      maxAttempts: 3,
      querySource,
      durationMs: 2_000,
      finishReason: "stop",
      timeToFirstContentMs: 400,
      usage: {
        inputTokens: 1_000,
        outputTokens: 320,
        reasoningTokens: 20,
        cacheReadTokens: 600,
        totalTokens: 1_320,
      },
      requestHeaders: { authorization: "secret" },
    },
    seq,
  );
}

describe("model request metrics fact", () => {
  it("carries usage, timing and the request purpose of a completed request", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    normalizer.normalize(
      "session",
      event(SessionEventType.TurnStarted, { turnNumber: 1, input: "prompt", inputId: "cmd-1" }, 1),
    );
    const main = completed("main_turn", 2);
    // 原有事实不变：旧 App 的 strict schema 仍能解析 model.request.status。
    const status = normalizer.normalize("session", main);
    expect(() => conversationTelemetryFactSchema.parse(status)).not.toThrow();
    expect(status).not.toHaveProperty("timeToFirstContentMs");
    expect(status).not.toHaveProperty("outputTokens");

    const metrics = normalizer.normalizeModelRequestMetrics("session", main);
    expect(metrics).toEqual({
      version: 1,
      kind: "model.request.metrics",
      eventId: "event-2",
      eventSeq: 2,
      occurredAt: 1_700_000_000_002,
      sessionId: "session",
      turnId: "turn",
      sourceCommandId: "cmd-1",
      requestId: "request-2",
      providerId: "provider",
      modelId: "model",
      querySource: "main_turn",
      durationMs: 2_000,
      timeToFirstContentMs: 400,
      inputTokens: 1_000,
      outputTokens: 320,
      reasoningTokens: 20,
      cacheReadTokens: 600,
      totalTokens: 1_320,
    });
    expect(() => modelRequestMetricsFactSchema.parse(metrics)).not.toThrow();
    expect(JSON.stringify(metrics)).not.toContain("secret");
    expect(JSON.stringify(metrics)).not.toContain("example.com");

    // 旁路请求能区分：标题生成、compact 带各自的 querySource。
    expect(
      normalizer.normalizeModelRequestMetrics("session", completed("session_title", 3))
        ?.querySource,
    ).toBe("session_title");
    expect(
      normalizer.normalizeModelRequestMetrics("session", completed("compact", 4))?.querySource,
    ).toBe("compact");
  });

  it("only emits for completed requests", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    expect(
      normalizer.normalizeModelRequestMetrics(
        "session",
        event(
          SessionEventType.ModelNetworkStatus,
          {
            type: "model_request_started",
            timestamp: new Date().toISOString(),
            traceId: "trace",
            requestId: "request",
            providerId: "provider",
            modelId: "model",
            transport: "http",
            attempt: 1,
            maxAttempts: 3,
          },
          1,
        ),
      ),
    ).toBeNull();
    expect(
      normalizer.normalizeModelRequestMetrics(
        "session",
        event(SessionEventType.TurnStarted, { turnNumber: 1, input: "x" }, 2),
      ),
    ).toBeNull();
  });
});
