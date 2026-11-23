import { describe, expect, it } from "vitest";
import { CoreErrorType, HookEventName, SessionEventType, createSessionId } from "@zcode/contracts";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import { type AgentRuntime } from "../src/runtime.js";
import {
  commitAssistantToTurnRequest,
  commitTurnRequestEntries,
} from "../src/runtime/methods/turn-output-token-continuation.js";
import type { TurnRequestState } from "../src/runtime/methods/turn-loop-state.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";
import {
  OUTPUT_TOKEN_CONTINUE_PROMPT,
  countContinuePrompts,
  createRecordingMessageStore,
  outputLimitResult as createOutputLimitResult,
  requestText,
  stopResult as createStopResult,
  withoutEmptyToolCalls,
} from "./runtime-output-token-continuation-test-helpers.js";

function outputLimitResult(text = "") {
  return createOutputLimitResult({
    text,
    usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
  });
}

function stopResult(text: string) {
  return createStopResult(text, 20);
}

describe("output-token continuation control-flow boundaries", () => {
  it("persists reasoning-only partial output before Continue", async () => {
    const requests: any[] = [];
    let runtime!: AgentRuntime;
    runtime = createTestAgentRuntime(
      createSessionId("output-token-reasoning-partial"),
      { titleGeneration: { enabled: false } },
      {
        eventStore: createTestSessionEventStore(),
        modelAdapter: {
          async generateText(request: any) {
            requests.push(request);
            if (requests.length === 1) {
              return {
                finishReason: "length",
                reasoning: [{ text: "reasoning partial" }],
                text: "",
                usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
              };
            }
            return stopResult("done");
          },
        } as never,
      },
    );

    const result = await runtime.executeTurn("start");
    const assistantEntries = (runtime as any).messageHistory
      .borrowReadOnlyRuntimeEntries()
      .filter((entry: any) => entry.message?.role === "assistant");

    expect(result.response).toBe("done");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages)).toContain("reasoning partial");
    expect(requestText(requests[1].messages)).toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    expect(JSON.stringify(assistantEntries[0]?.message?.content)).toContain("reasoning partial");
  });

  it("resets the continuation budget after a complete tool boundary", async () => {
    const registry = createToolRegistry();
    const requests: any[] = [];
    let callCount = 0;
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "RecoveryBoundary",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => "tool boundary complete",
    });
    const runtime = createTestAgentRuntime(
      createSessionId("output-token-tool-budget-reset"),
      { mode: "yolo", titleGeneration: { enabled: false } },
      {
        eventStore: createTestSessionEventStore(),
        toolRegistry: registry,
        modelAdapter: {
          async generateText(request: any) {
            requests.push(request);
            callCount += 1;
            if (callCount === 1) return outputLimitResult("before tool");
            if (callCount === 2) {
              return {
                ...outputLimitResult(),
                toolCalls: [{ id: "recovery-boundary", input: {}, name: "RecoveryBoundary" }],
              };
            }
            if (callCount <= 5) return outputLimitResult(`after tool ${callCount - 2}`);
            return stopResult("done");
          },
        } as never,
      },
    );

    const result = await runtime.executeTurn("use a tool between recovery chains");

    expect(result.response).toBe("done");
    expect(requests.map((request) => countContinuePrompts(request.messages))).toEqual([
      0, 1, 1, 2, 3, 4,
    ]);
    expect(requestText(requests[2].messages)).toContain("tool boundary complete");
  });

  it("runs Stop hook feedback only after output recovery reaches a normal stop", async () => {
    const capturedRequests: string[] = [];
    let modelCallCount = 0;
    let hookCallCount = 0;
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.Stop,
          callback: async () => {
            hookCallCount += 1;
            if (modelCallCount !== 2) return undefined;
            return { decision: "block", reason: "revise after recovered stop" };
          },
        },
      ],
    });
    const eventStore = createTestSessionEventStore();
    const sessionId = createSessionId("output-token-stop-hook-order");
    const runtime = createTestAgentRuntime(
      sessionId,
      { titleGeneration: { enabled: false } },
      {
        eventStore,
        hookRunner,
        modelAdapter: {
          async generateText(request: any) {
            modelCallCount += 1;
            capturedRequests.push(requestText(request.messages));
            if (modelCallCount === 1) return outputLimitResult("partial");
            if (modelCallCount === 2) return stopResult("recovered draft");
            return stopResult("final");
          },
        } as never,
      },
    );

    const result = await runtime.executeTurn("start");
    const events = await eventStore.getEvents(sessionId);

    expect(result.response).toBe("final");
    expect(modelCallCount).toBe(3);
    expect(hookCallCount).toBe(2);
    expect(capturedRequests[1]).toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    expect(capturedRequests[1]).not.toContain("revise after recovered stop");
    expect(capturedRequests[2]).toContain("revise after recovered stop");
    // ModelRequest 事件与实际请求是同一份消息，Continue 写库后之后的请求都带着它。
    expect(
      events
        .filter((event) => event.type === SessionEventType.ModelRequest)
        .map((event: any) => countContinuePrompts(event.payload.messages)),
    ).toEqual([0, 1, 1]);
  });

  it("cancels immediately when Abort fires during a continuation request", async () => {
    const abortController = new AbortController();
    const requests: any[] = [];
    const sessionId = createSessionId("output-token-abort-recovery");
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionId,
      { titleGeneration: { enabled: false } },
      {
        eventStore,
        modelAdapter: {
          async generateText(request: any) {
            requests.push(request);
            if (requests.length === 1) return outputLimitResult("partial");
            abortController.abort(new Error("user stopped recovery"));
            throw new Error("user stopped recovery");
          },
        } as never,
      },
    );

    await expect(
      runtime.executeTurn("start", undefined, { abortSignal: abortController.signal }),
    ).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });

    const events = await eventStore.getEvents(sessionId);
    expect(requests).toHaveLength(2);
    expect(requestText(requests[1].messages)).toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    expect(events.some((event) => event.type === SessionEventType.TurnError)).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: SessionEventType.TurnComplete,
      payload: { resultType: "cancelled" },
    });
  });

  it("keeps partial, Continue and the interrupt marker in order, live and after cold resume", async () => {
    const abortController = new AbortController();
    const store = createRecordingMessageStore();
    const requests: any[] = [];
    const sessionId = createSessionId("output-token-abort-order");
    const modelAdapter = {
      async generateText(request: any) {
        requests.push(request);
        if (requests.length === 1) return outputLimitResult("AUDIT_PARTIAL");
        if (requests.length === 2) {
          abortController.abort(new Error("user stopped recovery"));
          throw new Error("user stopped recovery");
        }
        return stopResult("after stop");
      },
    } as never;
    const createRuntime = () =>
      createTestAgentRuntime(
        sessionId,
        { titleGeneration: { enabled: false } },
        { eventStore: createTestSessionEventStore(), modelAdapter, sessionStore: store as never },
      );
    const runtime = createRuntime();

    await expect(
      runtime.executeTurn("start", undefined, { abortSignal: abortController.signal }),
    ).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });
    const markerSources = ["output_token_continuation", "interrupt_marker"];
    const durableOrder = store.savedMessages.filter(
      (message) =>
        message.role === "assistant" || markerSources.includes(message.semantics?.source),
    );
    // 第二个 assistant 是被停止的续写请求留下的取消记录（带 error，不进 provider history）。
    expect(durableOrder.map((message) => message.semantics?.source ?? message.role)).toEqual([
      "assistant",
      "output_token_continuation",
      "assistant",
      "interrupt_marker",
    ]);
    expect(durableOrder[2]?.error).toBeDefined();

    const resumed = createRuntime();
    await resumed.resumeFromStore();
    await runtime.executeTurn("AUDIT_NEXT_PROMPT");
    await resumed.executeTurn("AUDIT_NEXT_PROMPT");

    const live = requestText(requests[2].messages);
    const order = [
      "AUDIT_PARTIAL",
      OUTPUT_TOKEN_CONTINUE_PROMPT,
      "[Request interrupted by user]",
      "AUDIT_NEXT_PROMPT",
    ];
    const positions = order.map((text) => live.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(withoutEmptyToolCalls(requests[3].messages)).toEqual(
      withoutEmptyToolCalls(requests[2].messages),
    );
  });

  it("keeps an empty canonical commit as a no-op", () => {
    let canonicalCommitCount = 0;
    const runtime = {
      messageHistory: {
        addEntries() {
          canonicalCommitCount += 1;
        },
      },
    };
    const turnRequestState: TurnRequestState = {
      entries: [],
      outputTokenContinuationCount: 0,
    };

    commitTurnRequestEntries(runtime as never, turnRequestState, []);

    expect(canonicalCommitCount).toBe(0);
    expect(turnRequestState.entries).toEqual([]);
  });

  it("attributes partial output to the Turn model instead of provider result metadata", () => {
    const activeModel = createTestRuntimeModel({
      generateText: async () => ({ finishReason: "stop", text: "", usage: {} }),
      providerId: "active-provider",
      modelId: "active-model",
    });
    const reportedModel = createTestModelSelection("reported-provider/reported-model");
    const committedEntries: any[] = [];
    const turnRequestState: TurnRequestState = {
      entries: [],
      outputTokenContinuationCount: 0,
    };
    const runtime = {
      messageHistory: {
        addEntries(entries: readonly unknown[]) {
          committedEntries.push(...entries);
        },
      },
      now: () => new Date(0),
    };

    const committed = commitAssistantToTurnRequest(
      runtime as never,
      {
        model: activeModel,
        modelResponse: "partial",
        turnRequestState,
      } as never,
      {
        finishReason: "length",
        model: reportedModel,
        text: "partial",
        usage: {},
      },
      undefined,
    );

    expect(committed).toBe(true);
    expect(committedEntries[0]?.message).toMatchObject({
      providerId: activeModel.providerId,
      modelId: activeModel.modelId,
    });
    expect(turnRequestState.entries[0]).toBe(committedEntries[0]);
  });
});
