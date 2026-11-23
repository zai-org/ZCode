import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SessionEventType,
  ModelErrorCode,
  type ModelNetworkStatusEvent,
  type SessionEvent,
} from "@zcode/contracts";
import { uuidv7 } from "@zcode/shared";
import { ConversationTelemetryFactNormalizer } from "../src/zcode-protocol-v4/conversation-telemetry-facts.js";

import {
  TestAiSdkModelAdapter,
  TestProviderConfigFixture,
} from "../../adapters/tests/test-provider-config.js";
import {
  executeAdapterGenerateText,
  executeAdapterStreamText,
} from "../../adapters/tests/test-adapter-model.js";

function event(type: SessionEvent["type"], payload: unknown, seq: number): SessionEvent {
  return {
    id: `event-${seq}`,
    sessionId: "parent",
    turnId: "turn",
    traceId: "trace",
    sequenceNumber: seq,
    timestamp: new Date(),
    type,
    payload,
  } as SessionEvent;
}

describe("main turn telemetry identity", () => {
  it("projects admitted mobile origin without copying prompt or arbitrary metadata", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    const started = normalizer.normalize(
      "parent",
      event(
        SessionEventType.TurnStarted,
        {
          turnNumber: 1,
          input: "private prompt",
          inputId: "command",
          intent: { inputOrigin: "mobile" },
        },
        1,
      ),
      { modelName: "model", modelProvider: "provider" },
    );
    expect(started).toMatchObject({
      inputOrigin: "mobile",
      sourceCommandId: "command",
      modelName: "model",
      modelProvider: "provider",
    });
    expect(JSON.stringify(started)).not.toContain("private prompt");
  });
  it.each([undefined, "background_task"])("keeps inputId through %s turn facts", (inputSource) => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    const inputId = uuidv7();
    expect(
      normalizer.normalize(
        "parent",
        event(
          SessionEventType.TurnStarted,
          {
            turnNumber: 1,
            input: "prompt",
            inputId,
            inputSource,
            messageId: "msg_persisted",
          },
          1,
        ),
      ),
    ).toMatchObject({ sourceCommandId: inputId, kind: "turn.started" });
    expect(
      normalizer.normalize(
        "parent",
        event(
          SessionEventType.TurnComplete,
          {
            turnNumber: 1,
            result: { type: "complete" },
            duration: 10,
          },
          2,
        ),
      ),
    ).toMatchObject({ sourceCommandId: inputId, kind: "turn.terminal" });
  });

  it("does not substitute a persisted message ID for a missing input ID", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    const fact = normalizer.normalize(
      "parent",
      event(
        SessionEventType.TurnStarted,
        {
          turnNumber: 1,
          input: "notice",
          inputSource: "background_task",
          messageId: "msg_persisted",
        },
        1,
      ),
    );
    expect(fact).not.toHaveProperty("sourceCommandId");
  });
});

// 必须把真实 Adapter 的网络终态交给真实 normalizer，手工构造 failed 会掩盖完成身份入队回归。
describe.each(["stream", "generate"] as const)("%s empty context recovery identity", (mode) => {
  it.each(["success", "failed", "cancelled"])(
    "keeps retry and next-turn identity after %s compact",
    async (outcome) => {
      const normalizer = new ConversationTelemetryFactNormalizer();
      let seq = 0;
      let turnId = "turn-1";
      const publish = (type: SessionEvent["type"], payload: unknown) =>
        normalizer.normalize("parent", { ...event(type, payload, ++seq), turnId });
      async function request(
        id: string,
        totalTokens: number,
        querySource = "main_turn",
        overflow = false,
      ) {
        const statuses: ModelNetworkStatusEvent[] = [];
        const usage = { inputTokens: totalTokens - 5, outputTokens: 5, totalTokens };
        const completion = {
          finishReason: overflow ? "length" : "stop",
          rawFinishReason: overflow ? "model_context_window_exceeded" : "stop",
        };
        const providerId = `provider-${id}`;
        const modelId = `model-${id}`;
        const adapter = new TestAiSdkModelAdapter({
          registry: new TestProviderConfigFixture({
            providers: {
              [providerId]: { kind: "custom", createLanguageModel: () => ({ modelId }) as never },
            },
          }),
          retry: { maxAttempts: 1 },
          runtime: {
            async generateText() {
              return { ...completion, text: overflow ? "" : "done", usage } as never;
            },
            streamText() {
              return {
                fullStream: (async function* () {
                  yield { type: "start" };
                  if (!overflow) yield { type: "text-delta", id: "text", text: "done" };
                  yield { type: "finish", ...completion, totalUsage: usage };
                })(),
              } as never;
            },
          },
        });
        const options = {
          providerId,
          modelId,
          messages: [{ role: "user" as const, content: "Continue" }],
          metadata: { querySource },
          statusSink: {
            publish(status: ModelNetworkStatusEvent) {
              statuses.push(status);
              publish(SessionEventType.ModelNetworkStatus, status);
            },
          },
        };
        const run = async () => {
          if (mode === "generate") return executeAdapterGenerateText(adapter, options);
          for await (const _event of executeAdapterStreamText(adapter, options)) {
            /* consume provider stream */
          }
        };
        if (overflow) {
          await expect(run()).rejects.toMatchObject({ code: ModelErrorCode.ModelContextExceeded });
          expect(statuses.filter((status) => status.type === "model_request_failed")).toHaveLength(
            1,
          );
          expect(statuses.some((status) => status.type === "model_request_completed")).toBe(false);
          return;
        }
        await run();
        const completed = statuses.find((status) => status.type === "model_request_completed")!;
        const fact = publish(SessionEventType.ModelComplete, {
          content: "done",
          stopReason: "stop",
          querySource,
          usage,
        });
        if (querySource === "compact") expect(fact).toBeNull();
        else
          expect(fact).toMatchObject({
            kind: "usage.delta",
            requestId: completed.requestId,
            providerId,
            modelId,
            totalTokens,
            turnId,
          });
      }
      await request("A", 85, "main_turn", true);
      if (outcome === "success") {
        await request("B", 112, "compact");
        await request("C", 104);
      }
      publish(
        outcome === "failed" ? SessionEventType.TurnError : SessionEventType.TurnComplete,
        outcome === "failed"
          ? {
              error: {
                type: "model_context_exceeded",
                message: "Compact failed",
                retryable: false,
              },
            }
          : { resultType: outcome, duration: 10, tokenCount: 301, toolCallCount: 0 },
      );
      turnId = "turn-2";
      await request("D", 20);
    },
  );
});

// 冻结 a129878ef5 的旧 strict 分支白名单，不能从当前 schema 动态生成。
const legacyBaseKeys = [
  "memoryEnabled",
  "version",
  "eventId",
  "eventSeq",
  "occurredAt",
  "sessionId",
  "sourceCommandId",
  "turnId",
  "kind",
];
const frozenLegacySchema = (keys: string[]) =>
  z
    .object(
      Object.fromEntries([...legacyBaseKeys, ...keys].map((key) => [key, z.unknown().optional()])),
    )
    .strict();
const legacyStarted = frozenLegacySchema([
  "inputOrigin",
  "modelName",
  "modelProvider",
  "executionKind",
  "inputSource",
  "backgroundSource",
  "automationId",
  "offPeakTaskId",
  "offPeakRunType",
  "taskTrigger",
  "scheduledAt",
]);
const legacyUsage = frozenLegacySchema([
  "requestId",
  "providerId",
  "modelId",
  "providerKind",
  "providerHostname",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
]);

describe("首响独立通知兼容旧 strict fact", () => {
  it.each([
    [true, "startNow", "direct"],
    [false, "queue", "queued"],
  ] as const)("首条=%s / %s 只放独立 admission", (isFirstMessage, admittedDelivery, sendMode) => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    const raw = event(
      SessionEventType.TurnStarted,
      { inputId: "command", isFirstMessage, intent: { admittedDelivery } },
      1,
    );
    const wire = normalizer.normalize("parent", raw);
    expect(legacyStarted.safeParse(wire).success).toBe(true);
    expect(wire).not.toHaveProperty("isFirstMessage");
    expect(wire).not.toHaveProperty("sendMode");
    expect(normalizer.normalizeTurnAdmission("parent", raw)).toMatchObject({
      sourceCommandId: "command",
      isFirstMessage,
      sendMode,
    });
    // 守护测试自身必须能识别本次审核发现的退化。
    expect(legacyStarted.safeParse({ ...wire, isFirstMessage }).success).toBe(false);
  });
  it("guide 不映射 direct，缺事实不发空补充通知", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    const raw = event(
      SessionEventType.TurnStarted,
      { inputId: "c", intent: { admittedDelivery: "guide" } },
      1,
    );
    normalizer.normalize("parent", raw);
    expect(normalizer.normalizeTurnAdmission("parent", raw)).toBeNull();
  });
  it.each([undefined, 0, 9])("usage 旧格式不变，独立 metrics 保留 cache=%s", (cacheReadTokens) => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    const raw = event(
      SessionEventType.ModelNetworkStatus,
      {
        type: "model_request_completed",
        requestId: "r",
        providerId: "p",
        modelId: "m",
        transport: "http",
        attempt: 1,
        maxAttempts: 2,
        durationMs: 10,
        querySource: "main_turn",
        usage: { inputTokens: 12, cacheReadTokens },
      },
      1,
    );
    normalizer.normalize("parent", raw);
    const metrics = normalizer.normalizeModelRequestMetrics("parent", raw);
    expect(metrics).toMatchObject({ requestId: "r", inputTokens: 12 });
    if (cacheReadTokens === undefined) expect(metrics).not.toHaveProperty("cacheReadTokens");
    else expect(metrics?.cacheReadTokens).toBe(cacheReadTokens);
    const wire = normalizer.normalize(
      "parent",
      event(
        SessionEventType.ModelComplete,
        { querySource: "main_turn", usage: { inputTokens: 12, cacheReadTokens } },
        2,
      ),
    );
    expect(legacyUsage.safeParse(wire).success).toBe(true);
    expect(wire).not.toHaveProperty("ttftInputTokens");
    expect(wire).not.toHaveProperty("ttftCachedInputTokens");
    expect(legacyUsage.safeParse({ ...wire, ttftInputTokens: 12 }).success).toBe(false);
  });
  it("metrics 沿用 cacheTokens 回退并保留 input 缺失", () => {
    const n = new ConversationTelemetryFactNormalizer();
    const raw = event(
      SessionEventType.ModelNetworkStatus,
      {
        type: "model_request_completed",
        requestId: "r",
        providerId: "p",
        modelId: "m",
        durationMs: 10,
        usage: { cacheTokens: 9 },
      },
      1,
    );
    const fact = n.normalizeModelRequestMetrics("parent", raw);
    expect(fact).toMatchObject({ cacheReadTokens: 9 });
    expect(fact).not.toHaveProperty("inputTokens");
  });
});
