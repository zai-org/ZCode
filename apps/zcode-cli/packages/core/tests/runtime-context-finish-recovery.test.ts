import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  getCurrentModelInvocationContext,
  CoreErrorType,
  createCoreError,
  createSessionId,
  getModelUsageTotalTokens,
  type ModelResult,
  type UsageStorePort,
} from "@zcode/contracts";
import { createTestSessionEventStore } from "./test-event-store.js";
import {
  OUTPUT_TOKEN_CONTINUE_PROMPT,
  createRuntime,
  createRecordingMessageStore,
  requestText,
  stopResult,
} from "./runtime-output-token-continuation-test-helpers.js";

import { executeAdapterGenerateText } from "../../adapters/tests/test-adapter-model.js";
import {
  TestAiSdkModelAdapter,
  TestProviderConfigFixture,
} from "../../adapters/tests/test-provider-config.js";

const CONTEXT_REASON = "model_context_window_exceeded";
const SUMMARY = "<summary>Retain the current task after context recovery.</summary>";
const EMPTY_CONTEXT_RESULT: ModelResult = {
  finishReason: "length",
  providerMetadata: { rawFinishReason: CONTEXT_REASON },
  text: "",
  usage: { inputTokens: 80, outputTokens: 5, totalTokens: 85 },
};

function createContextRecovery(input: {
  result: ModelResult;
  repeatOverflow?: boolean;
  throwOverflow?: boolean;
  compactEnabled?: boolean;
  onCompact?: () => void;
}) {
  const runtimeId = "empty-context-finish-recovery";
  const sessionId = createSessionId(runtimeId);
  const eventStore = createTestSessionEventStore();
  const requests: Array<{ kind: "compact" | "normal"; text: string }> = [];
  const recordModelUsage = vi.fn(
    async (_fact: Parameters<UsageStorePort["recordModelUsage"]>[0]) => {},
  );
  const upsertTurnUsage = vi.fn(
    async (_fact: Parameters<UsageStorePort["upsertTurnUsage"]>[0]) => {},
  );
  const sessionStore = {
    ...createRecordingMessageStore(),
    recordModelUsage,
    upsertTurnUsage,
    async upsertToolUsage() {},
  };
  let eventOffset = 0;
  let recovering = false;
  let overflowReturned = false;
  const runtime = createRuntime({
    id: runtimeId,
    config: {
      systemPrompt: "Context recovery test.",
      compact: { enabled: input.compactEnabled ?? true },
    },
    deps: { eventStore, sessionStore: sessionStore as never },
    modelAdapter: {
      async generateText(request: { messages: readonly { content: unknown }[] }) {
        const text = requestText(request.messages);
        const compact = text.includes("create a detailed summary");
        requests.push({ kind: compact ? "compact" : "normal", text });
        if (compact) {
          input.onCompact?.();
          return stopResult(SUMMARY, 100, 5);
        }
        if (!recovering) return stopResult("setup complete", 2);
        if (!overflowReturned || input.repeatOverflow) {
          overflowReturned = true;
          if (input.throwOverflow) {
            throw createCoreError(CoreErrorType.ModelContextExceeded, "Context limit reached", {
              recoverable: true,
              retryable: true,
            });
          }
          // 用真实 Adapter 验证成功 finish 在边界归一为失败，并把网络事实交给同一 Core sink。
          const invocation = getCurrentModelInvocationContext();
          const adapter = new TestAiSdkModelAdapter({
            registry: new TestProviderConfigFixture({
              providers: {
                test: { kind: "custom", createLanguageModel: (modelId) => ({ modelId }) as never },
              },
            }),
            runtime: {
              async generateText() {
                return {
                  ...input.result,
                  rawFinishReason: input.result.providerMetadata?.rawFinishReason,
                  reasoning: input.result.reasoning?.map((block) => ({
                    type: "reasoning",
                    text: block.text,
                    providerMetadata: block.providerOptions,
                  })),
                } as never;
              },
              streamText() {
                throw new Error("Non-streaming fixture");
              },
            },
            retry: { maxAttempts: 1 },
          });
          return executeAdapterGenerateText(adapter, {
            providerId: "test",
            modelId: "model",
            messages: request.messages as never,
            statusSink: invocation?.statusSink,
            traceContext: invocation?.traceContext,
            metadata: invocation?.metadata,
          });
        }
        return stopResult("recovered", 3);
      },
    },
  });
  return {
    runtime,
    requests,
    recordModelUsage,
    upsertTurnUsage,
    events: async () => (await eventStore.getEvents(sessionId)).slice(eventOffset),
    async seedHistory() {
      await runtime.executeTurn("setup one");
      await runtime.executeTurn("setup two");
      requests.length = 0;
      recordModelUsage.mockClear();
      upsertTurnUsage.mockClear();
      eventOffset = (await eventStore.getEvents(sessionId)).length;
    },
    recover(abortSignal?: AbortSignal) {
      recovering = true;
      return runtime.executeTurn("recover the current task", undefined, { abortSignal });
    },
  };
}

describe("context-limit failure recovery", () => {
  it.each([{}, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, EMPTY_CONTEXT_RESULT.usage])(
    "settles reported usage before compact and retries without Continue: %j",
    async (usage) => {
      let completedAt: number | undefined;
      const test = createContextRecovery({
        result: { ...EMPTY_CONTEXT_RESULT, usage },
        onCompact() {
          expect(test.recordModelUsage.mock.calls[0]?.[0]).toMatchObject({
            status: "error",
            rawUsage: usage,
          });
          expect((test.runtime as any).lastAssistantCompletedAtMs).toBe(completedAt);
        },
      });
      await test.seedHistory();
      completedAt = (test.runtime as any).lastAssistantCompletedAtMs;
      const recovered = await test.recover();
      const tokens = getModelUsageTotalTokens(usage);
      expect(recovered.response).toBe("recovered");
      expect(recovered.usage?.totalTokens).toBe(tokens + 109);
      const facts = test.recordModelUsage.mock.calls.map(([fact]) => fact);
      expect(facts.map((fact) => fact.querySource)).toEqual(["main_turn", "compact", "main_turn"]);
      expect(new Set(facts.map((fact) => fact.logicalRequestId)).size).toBe(3);
      expect(facts[0]).toMatchObject({
        status: "error",
        contextExceeded: true,
        errorType: "context_exceeded",
        retryable: false,
      });
      expect(facts.slice(1)).toMatchObject([
        { status: "completed", contextExceeded: false },
        { status: "completed", contextExceeded: false },
      ]);
      expect(test.upsertTurnUsage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: "completed", computedTotalTokens: tokens + 109 }),
      );
      const events = await test.events();
      expect(events.filter((event) => event.type === SessionEventType.ModelComplete)).toHaveLength(
        2,
      );
      expect(events.filter((event) => event.type === SessionEventType.TurnComplete)).toMatchObject([
        {
          payload: {
            resultType: "success",
            tokenCount: tokens + 4,
            usage: { totalTokens: tokens + 109 },
          },
        },
      ]);
      expect(
        events.filter((event) => event.type === SessionEventType.CompactBoundary),
      ).toMatchObject([{ payload: { trigger: "reactive" } }]);
      expect(test.requests.map(({ kind }) => kind)).toEqual(["normal", "compact", "normal"]);
      expect(test.requests.every(({ text }) => !text.includes(OUTPUT_TOKEN_CONTINUE_PROMPT))).toBe(
        true,
      );
      expect(test.requests[2]?.text).toContain("Retain the current task after context recovery.");
      expect(test.requests[2]?.text).toContain("recover the current task");
      expect((await test.runtime.executeTurn("next turn")).usage?.totalTokens).toBe(4);
    },
  );

  it.each(["disabled", "no-history", "repeated", "failed", "cancelled"])(
    "preserves failed usage without duplicate recovery: %s",
    async (mode) => {
      const controller = new AbortController();
      const test = createContextRecovery({
        result: EMPTY_CONTEXT_RESULT,
        compactEnabled: mode !== "disabled",
        repeatOverflow: mode === "repeated",
        onCompact() {
          expect(test.recordModelUsage.mock.calls[0]?.[0].providerTotalTokens).toBe(85);
          if (mode === "cancelled") controller.abort(new Error("user stop"));
          if (mode === "failed" || mode === "cancelled") throw new Error("compact interrupted");
        },
      });
      if (mode !== "no-history") await test.seedHistory();
      await expect(test.recover(controller.signal)).rejects.toMatchObject({
        type: mode === "cancelled" ? "turn_cancelled" : "model_context_exceeded",
      });
      const facts = test.recordModelUsage.mock.calls.map(([fact]) => fact);
      expect(facts[0]).toMatchObject({
        status: "error",
        contextExceeded: true,
        errorType: "context_exceeded",
        providerTotalTokens: 85,
      });
      if (mode === "repeated") {
        expect(facts.map((fact) => fact.providerTotalTokens)).toEqual([85, 105, 85]);
        expect(facts.map((fact) => fact.status)).toEqual(["error", "completed", "error"]);
        expect(new Set(facts.map((fact) => fact.logicalRequestId)).size).toBe(3);
        expect(test.requests.map(({ kind }) => kind)).toEqual(["normal", "compact", "normal"]);
      } else {
        expect(test.requests.map(({ kind }) => kind)).toEqual(
          mode === "disabled" || mode === "no-history"
            ? ["normal"]
            : mode === "failed"
              ? ["normal", "compact", "compact"]
              : ["normal", "compact"],
        );
      }
      expect(test.requests.every(({ text }) => !text.includes(OUTPUT_TOKEN_CONTINUE_PROMPT))).toBe(
        true,
      );
      expect(test.upsertTurnUsage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          status: mode === "cancelled" ? "cancelled" : "error",
          computedTotalTokens: mode === "repeated" ? 275 : 85,
        }),
      );
      if (mode === "cancelled")
        expect(
          (await test.events()).filter((event) => event.type === SessionEventType.TurnComplete),
        ).toMatchObject([{ payload: { resultType: "cancelled", usage: { totalTokens: 85 } } }]);
    },
  );

  it("recovers even if the usage store fails", async () => {
    const test = createContextRecovery({ result: EMPTY_CONTEXT_RESULT });
    await test.seedHistory();
    test.recordModelUsage.mockRejectedValueOnce(new Error("store unavailable"));
    expect((await test.recover()).usage?.totalTokens).toBe(194);
    expect((await test.runtime.executeTurn("next turn")).usage?.totalTokens).toBe(4);
  });

  it.each([
    { text: "partial answer" },
    { text: "", reasoning: [{ text: "partial reasoning" }] },
    { text: "", reasoning: [{ text: "", providerOptions: { opaqueReasoning: "retained" } }] },
    {
      text: "partial output limit",
      finishReason: "other",
      providerMetadata: { rawFinishReason: "max_output_tokens" },
    },
  ])("preserves partial output and existing Continue: %j", async (partial) => {
    const test = createContextRecovery({ result: { ...EMPTY_CONTEXT_RESULT, ...partial } });
    await test.seedHistory();
    expect((await test.recover()).usage?.totalTokens).toBe(89);
    expect(test.recordModelUsage.mock.calls.map(([fact]) => fact)).toMatchObject([
      { status: "completed", contextExceeded: false },
      { status: "completed", contextExceeded: false },
    ]);
    expect(test.requests.map(({ kind }) => kind)).toEqual(["normal", "normal"]);
    expect(test.requests[1]?.text).toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    const history = JSON.stringify((test.runtime as any).messageHistory.toRuntimeEntries());
    expect(history).toContain(partial.text || partial.reasoning?.[0].text || "retained");
  });

  it("preserves existing thrown context-error recovery", async () => {
    const test = createContextRecovery({ throwOverflow: true, result: EMPTY_CONTEXT_RESULT });
    await test.seedHistory();
    expect((await test.recover()).usage?.totalTokens).toBe(109);
    expect(test.recordModelUsage.mock.calls[0]?.[0]).toMatchObject({
      status: "error",
      contextExceeded: true,
      providerTotalTokens: undefined,
    });
    expect(test.requests.map(({ kind }) => kind)).toEqual(["normal", "compact", "normal"]);
  });
});
