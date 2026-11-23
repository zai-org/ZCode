import { describe, expect, it } from "vitest";
import { SessionEventType, createSessionId } from "@zcode/contracts";
import type { AgentRuntime } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import {
  OUTPUT_TOKEN_CONTINUE_PROMPT,
  countContinuePrompts,
  createRecordingMessageStore,
  createRuntime,
  estimateCanonicalHistory,
  outputLimitResult,
  requestText,
  stopResult,
  withoutCacheControl,
  withoutEmptyToolCalls,
} from "./runtime-output-token-continuation-test-helpers.js";

describe("AgentRuntime output-token continuation", () => {
  it.each([
    { id: "output-token-empty-continue", rawReasons: [], taskType: undefined },
    {
      id: "output-token-subagent",
      rawReasons: [undefined, "max_tokens", "max_output_tokens"],
      taskType: "subagent_child" as const,
    },
  ])("continues three empty output limits for $id", async ({ id, rawReasons, taskType }) => {
    const requests: any[] = [];
    let callCount = 0;
    const runtime = createRuntime({
      id,
      config: taskType ? { taskType } : undefined,
      modelAdapter: {
        async generateText(request: any) {
          requests.push(request);
          callCount += 1;
          if (callCount <= 3) {
            const rawFinishReason = rawReasons[callCount - 1];
            return outputLimitResult(rawFinishReason ? { rawFinishReason } : {});
          }
          return stopResult("done", 40);
        },
      } as never,
    });
    (runtime as any).messageHistory.toRuntimeEntries = () => {
      throw new Error("turn requests must not clone canonical history entries");
    };

    const result = await runtime.executeTurn("start");

    expect(result.response).toBe("done");
    expect(requests.map((request) => countContinuePrompts(request.messages))).toEqual([0, 1, 2, 3]);
  });

  it("counts only assistant products that enter provider-visible history", async () => {
    const runtimeId = "output-token-empty-assistant-commit";
    const sessionId = createSessionId(runtimeId);
    const eventStore = createTestSessionEventStore();
    const store = createRecordingMessageStore();
    let callCount = 0;
    const runtime = createRuntime({
      id: runtimeId,
      deps: { eventStore, sessionStore: store as never },
      modelAdapter: {
        async generateText() {
          callCount += 1;
          if (callCount === 1) {
            return {
              finishReason: "length",
              reasoning: [{ text: "" }],
              text: "",
              usage: {},
            };
          }
          return stopResult("done", 2);
        },
      } as never,
    });

    await runtime.executeTurn("start");

    const events = await eventStore.getEvents(sessionId);
    const turnComplete = events.find((event) => event.type === SessionEventType.TurnComplete);
    expect(
      (turnComplete?.payload as { historyRoundCount?: number } | undefined)?.historyRoundCount,
    ).toBe(1);
    expect(store.savedMessages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(store.savedParts.filter((part) => part.type === "reasoning")).toEqual([]);
  });

  // model-request-output-tokens.md「Output-limit Continue 恢复」：Continue 按隐藏提醒记录持久化，
  // 本轮最后一个请求是下一轮第一个请求的前缀，冷恢复与 live 逐字节相同。
  it("persists Continue as hidden rows so the next turn and cold resume keep the prefix", async () => {
    const runtimeId = "output-token-partial-history";
    const sessionId = createSessionId(runtimeId);
    const eventStore = createTestSessionEventStore();
    const store = createRecordingMessageStore();
    const requests: any[] = [];
    let nextTurnEstimate = 0;
    const responses = [
      outputLimitResult({
        rawFinishReason: "max_tokens",
        text: "A",
        usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      }),
      outputLimitResult({
        rawFinishReason: "max_output_tokens",
        text: "B",
        usage: { inputTokens: 12, outputTokens: 1, totalTokens: 13 },
      }),
      outputLimitResult({
        rawFinishReason: "model_context_window_exceeded",
        text: "C",
        usage: { inputTokens: 14, outputTokens: 1, totalTokens: 15 },
      }),
      stopResult("D", 16),
      stopResult("next done", 18, 2),
    ];
    let runtime!: AgentRuntime;
    runtime = createRuntime({
      id: runtimeId,
      deps: {
        eventStore,
        sessionStore: store as never,
      },
      modelAdapter: {
        async generateText(request: any) {
          requests.push(request);
          if (requests.length === 5) {
            nextTurnEstimate = estimateCanonicalHistory(runtime);
          }
          return responses.shift()!;
        },
      } as never,
    });

    const first = await runtime.executeTurn("first");
    const firstTurnEvents = await eventStore.getEvents(sessionId);
    const canonicalAfterFirst = (runtime as any).messageHistory.toRuntimeEntries();

    expect(first.response).toBe("D");
    expect(
      firstTurnEvents
        .filter((event) => event.type === SessionEventType.ModelComplete)
        .map((event: any) => event.payload.content),
    ).toEqual(["A", "B", "C", "D"]);
    expect(
      firstTurnEvents
        .filter((event) => event.type === SessionEventType.ModelComplete)
        .map((event: any) => event.payload.stopReason),
    ).toEqual(["length", "length", "length", "stop"]);
    expect(
      store.savedMessages
        .filter((message) => message.role === "assistant")
        .map((message) => message.finish),
    ).toEqual(["length", "length", "length", "stop"]);
    expect(
      store.savedParts.filter((part) => part.type === "step-finish").map((part) => part.reason),
    ).toEqual(["length", "length", "length", "stop"]);
    // 每个 partial 之后写一条隐藏 Continue：纯文本，不包 <system-reminder>，不显示给用户。
    const continueRows = store.savedMessages.filter(
      (message) => message.semantics?.source === "output_token_continuation",
    );
    expect(continueRows).toHaveLength(3);
    for (const row of continueRows) {
      expect(row).toMatchObject({
        role: "user",
        synthetic: true,
        semantics: {
          kind: "system_reminder",
          providerVisibility: "visible",
          uiVisibility: "hidden",
        },
      });
      expect(
        store.savedParts.filter((part) => part.messageID === row.id).map((part) => part.text),
      ).toEqual([OUTPUT_TOKEN_CONTINUE_PROMPT]);
    }
    expect(
      store.savedMessages
        .filter((message) => message.role === "assistant" || continueRows.includes(message))
        .map((message) => (message.role === "assistant" ? message.finish : "continue")),
    ).toEqual(["length", "continue", "length", "continue", "length", "continue", "stop"]);
    // ModelRequest 事件与实际请求是同一份消息。
    expect(
      firstTurnEvents
        .filter((event) => event.type === SessionEventType.ModelRequest)
        .map((event: any) => countContinuePrompts(event.payload.messages)),
    ).toEqual([0, 1, 2, 3]);
    expect(
      canonicalAfterFirst.filter(
        (entry: any) => entry.metadata?.source === "output_token_continuation",
      ),
    ).toHaveLength(3);

    let coldRequest: any;
    const resumedRuntime = createRuntime({
      id: runtimeId,
      deps: { eventStore: createTestSessionEventStore(), sessionStore: store as never },
      modelAdapter: {
        async generateText(request: any) {
          coldRequest = request;
          return stopResult("cold done", 18, 2);
        },
      } as never,
    });
    await resumedRuntime.resumeFromStore();

    const second = await runtime.executeTurn("next real user");
    await resumedRuntime.executeTurn("next real user");

    expect(second.response).toBe("next done");
    // 本轮最后一个请求是下一轮第一个请求的前缀；缓存断点会移到最新消息上，不算内容。
    const lastOfFirstTurn = withoutCacheControl(requests[3]!.messages);
    expect(withoutCacheControl(requests[4]!.messages).slice(0, lastOfFirstTurn.length)).toEqual(
      lastOfFirstTurn,
    );
    expect(countContinuePrompts(requests[4]!.messages)).toBe(3);
    expect(requestText(requests[4]!.messages)).toContain("next real user");
    expect(withoutEmptyToolCalls(coldRequest.messages)).toEqual(
      withoutEmptyToolCalls(requests[4]!.messages),
    );
    expect(
      canonicalAfterFirst
        .filter((entry: any) => entry.message?.role === "assistant")
        .map((entry: any) => entry.tokens?.input),
    ).toEqual([10, 12, 14, 16]);
    expect(nextTurnEstimate).toBeGreaterThan(17);
  });

  it("fails the turn when the Continue row cannot be persisted", async () => {
    const store = createRecordingMessageStore();
    // message 写成功、part 写失败：写了一半的行必须回滚。
    const continueMessageIds = new Set<string>();
    const saveMessage = store.saveMessage.bind(store);
    store.saveMessage = async (message: any) => {
      if (message.semantics?.source === "output_token_continuation") {
        continueMessageIds.add(message.id);
      }
      await saveMessage(message);
    };
    const savePart = store.savePart.bind(store);
    store.savePart = async (part: any) => {
      if (continueMessageIds.has(part.messageID)) throw new Error("continue row write failed");
      await savePart(part);
    };
    const requests: any[] = [];
    const runtime = createRuntime({
      id: "output-token-continue-persist-failure",
      deps: { sessionStore: store as never },
      modelAdapter: {
        async generateText(request: any) {
          requests.push(request);
          return requests.length === 1 ? outputLimitResult({ text: "A" }) : stopResult("B", 16);
        },
      } as never,
    });

    // 写库失败向上抛错，不回退到只在内存里的 Continue，也不再发续写请求。
    const error = await runtime.executeTurn("first").then(
      () => undefined,
      (reason: unknown) => reason as Error & { cause?: Error },
    );
    expect(error?.cause?.message).toBe("continue row write failed");
    expect(requests).toHaveLength(1);
    expect(continueMessageIds.size).toBe(1);
    expect(store.savedMessages.some((message) => continueMessageIds.has(message.id))).toBe(false);
    expect(JSON.stringify((runtime as any).messageHistory.toRuntimeEntries())).not.toContain(
      OUTPUT_TOKEN_CONTINUE_PROMPT,
    );

    // 失败后下一轮照常运行：请求带着已落盘的 partial，没有 Continue。
    await runtime.executeTurn("second");
    expect(requests).toHaveLength(2);
    expect(countContinuePrompts(requests[1].messages)).toBe(0);
    expect(requestText(requests[1].messages)).toContain("A");
  });

  it("replays a session saved before Continue was persisted unchanged", async () => {
    const runtimeId = "output-token-legacy-session";
    const store = createRecordingMessageStore();
    const runtime = createRuntime({
      id: runtimeId,
      deps: { sessionStore: store as never },
      modelAdapter: {
        responses: [outputLimitResult({ text: "A" }), stopResult("B", 16)],
        async generateText() {
          return this.responses.shift()!;
        },
      } as never,
    });
    await runtime.executeTurn("first");
    // 改动前的会话没有 Continue 记录：删掉它们，模拟旧存档。
    for (const row of store.savedMessages.filter(
      (message) => message.semantics?.source === "output_token_continuation",
    )) {
      await store.removeMessage({ sessionID: row.sessionID, messageID: row.id });
    }

    let coldRequest: any;
    const resumedRuntime = createRuntime({
      id: runtimeId,
      deps: { sessionStore: store as never },
      modelAdapter: {
        async generateText(request: any) {
          coldRequest = request;
          return stopResult("cold done", 18, 2);
        },
      } as never,
    });
    await resumedRuntime.resumeFromStore();
    await resumedRuntime.executeTurn("next real user");

    // 旧存档照旧回放：没有 Continue，两段 assistant 相邻。
    expect(countContinuePrompts(coldRequest.messages)).toBe(0);
    expect(
      coldRequest.messages
        .filter((message: any) => message.role === "assistant")
        .map((message: any) => requestText([message])),
    ).toEqual(["A", "B"]);
  });

  it("preserves the last valid provider usage anchor across empty recovery usage", async () => {
    const runtimeId = "output-token-empty-usage-anchor";
    const requests: any[] = [];
    let assistantEntriesBeforeThirdRequest: any[] = [];
    let nextTurnEstimate = 0;
    let runtime!: AgentRuntime;
    runtime = createRuntime({
      id: runtimeId,
      modelAdapter: {
        async generateText(request: any) {
          requests.push(request);
          if (requests.length === 1) {
            return outputLimitResult({
              text: "A",
              usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
            });
          }
          if (requests.length === 2) {
            return outputLimitResult({});
          }
          if (requests.length === 3) {
            assistantEntriesBeforeThirdRequest = (runtime as any).messageHistory
              .toRuntimeEntries()
              .filter((entry: any) => entry.message?.role === "assistant");
            return { finishReason: "stop", text: "C", usage: {} };
          }
          nextTurnEstimate = estimateCanonicalHistory(runtime);
          return stopResult("next done", 20);
        },
      } as never,
    });

    const first = await runtime.executeTurn("first");
    expect(first.response).toBe("C");
    expect(assistantEntriesBeforeThirdRequest).toHaveLength(1);
    expect(assistantEntriesBeforeThirdRequest[0]?.tokens).toMatchObject({ input: 10, output: 1 });

    const second = await runtime.executeTurn("next real user");

    expect(second.response).toBe("next done");
    expect(nextTurnEstimate).toBeGreaterThan(11);
  });

  it("closes the fourth output limit through the existing TurnError path", async () => {
    const runtimeId = "output-token-exhausted";
    const sessionId = createSessionId(runtimeId);
    const eventStore = createTestSessionEventStore();
    const store = createRecordingMessageStore();
    let callCount = 0;
    const runtime = createRuntime({
      id: runtimeId,
      deps: {
        eventStore,
        sessionStore: store as never,
      },
      modelAdapter: {
        async generateText() {
          callCount += 1;
          if (callCount > 4) {
            return stopResult("next turn still works", 50, 2);
          }
          return outputLimitResult({
            text: String.fromCharCode(64 + callCount),
            usage: {
              inputTokens: callCount * 10,
              outputTokens: 1,
              totalTokens: callCount * 10 + 1,
            },
          });
        },
      } as never,
    });

    await expect(runtime.executeTurn("start")).rejects.toMatchObject({
      message: "The model's response exceeded the output token maximum.",
      type: "model_error",
    });
    const events = await eventStore.getEvents(sessionId);
    const finalPartialPart = store.savedParts.find(
      (part) => part.type === "text" && part.text === "D",
    );
    const finalPartialAssistant = store.savedMessages.find(
      (message) => message.id === finalPartialPart?.messageID,
    );
    const errorCarrier = store.savedMessages.find(
      (message) => message.role === "assistant" && message.error,
    );

    expect(callCount).toBe(4);
    const turnError = events.find((event) => event.type === SessionEventType.TurnError);
    expect(turnError?.payload).toMatchObject({
      error: {
        code: "model_output_limit_exceeded",
        message: "The model's response exceeded the output token maximum.",
      },
    });
    expect(events.some((event) => event.type === SessionEventType.TurnComplete)).toBe(false);
    expect(finalPartialAssistant).toMatchObject({
      tokens: { input: 40, output: 1, total: 41 },
    });
    expect(finalPartialAssistant?.error).toBeUndefined();
    expect(errorCarrier?.id).not.toBe(finalPartialAssistant?.id);
    expect(errorCarrier?.error?.data?.message).toBe(
      "The model's response exceeded the output token maximum.",
    );
    expect(errorCarrier?.tokens).toMatchObject({
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
    expect(store.savedParts.filter((part) => part.messageID === errorCarrier?.id)).toEqual([
      expect.objectContaining({
        type: "step-finish",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ]);

    const next = await runtime.executeTurn("continue after the displayed error");
    expect(next.response).toBe("next turn still works");
    expect(callCount).toBe(5);
  });

  it("persists and hydrates an empty exhausted assistant error", async () => {
    const runtimeId = "output-token-empty-exhausted";
    const sessionId = createSessionId(runtimeId);
    const eventStore = createTestSessionEventStore();
    const store = createRecordingMessageStore();
    let callCount = 0;
    const runtime = createRuntime({
      id: runtimeId,
      deps: {
        eventStore,
        sessionStore: store as never,
      },
      modelAdapter: {
        async generateText() {
          callCount += 1;
          return outputLimitResult({
            usage: {
              inputTokens: callCount * 10,
              outputTokens: 1,
              totalTokens: callCount * 10 + 1,
            },
          });
        },
      } as never,
    });

    await expect(runtime.executeTurn("start")).rejects.toMatchObject({
      message: "The model's response exceeded the output token maximum.",
      type: "model_error",
    });

    expect(callCount).toBe(4);
    const durableAssistants = store.savedMessages.filter((message) => message.role === "assistant");
    const durableStepFinishes = store.savedParts.filter((part) => part.type === "step-finish");
    expect(durableAssistants).toHaveLength(1);
    expect(durableAssistants[0]).toMatchObject({
      error: {
        name: "model_output_limit_exceeded",
        data: {
          code: "model_output_limit_exceeded",
          message: "The model's response exceeded the output token maximum.",
          retryable: true,
          attribution: {
            providerErrorCode: "model_output_limit_exceeded",
            reason: "model_output_limit_exceeded",
            source: "provider",
          },
        },
      },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(durableStepFinishes).toHaveLength(1);
    expect(durableStepFinishes[0]).toMatchObject({
      reason: "length",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(
      (runtime as any).messageHistory
        .toRuntimeEntries()
        .filter((entry: any) => entry.message?.role === "assistant"),
    ).toEqual([]);
    const exhaustedEvents = await eventStore.getEvents(sessionId);
    expect(
      exhaustedEvents.filter((event) => event.type === SessionEventType.ModelComplete),
    ).toHaveLength(4);
    expect(
      exhaustedEvents.filter((event) => event.type === SessionEventType.ModelComplete).at(-1)
        ?.payload,
    ).toMatchObject({
      usage: { inputTokens: 40, outputTokens: 1, totalTokens: 41 },
    });
    expect(
      exhaustedEvents.find((event) => event.type === SessionEventType.TurnError)?.payload,
    ).toMatchObject({
      error: {
        code: "model_output_limit_exceeded",
        message: "The model's response exceeded the output token maximum.",
      },
    });

    let coldRequest: any;
    const resumedRuntime = createRuntime({
      id: runtimeId,
      deps: {
        eventStore,
        sessionStore: store as never,
      },
      modelAdapter: {
        async generateText(request: any) {
          coldRequest = request;
          return stopResult("cold resume done", 50, 2);
        },
      } as never,
    });
    await resumedRuntime.resumeFromStore();
    await resumedRuntime.executeTurn("continue after cold resume");

    expect(coldRequest.messages.filter((message: any) => message.role === "assistant")).toEqual([]);
    // 耗尽时三条 Continue 已经写库，冷恢复照样回放；error carrier 不进入 provider history。
    expect(countContinuePrompts(coldRequest.messages)).toBe(3);
    expect(requestText(coldRequest.messages)).toContain("continue after cold resume");
  });
});
