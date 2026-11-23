import { describe, expect, it } from "vitest";
import {
  ModelErrorCode,
  SessionEventType,
  createSessionId,
  modelMessageContentToText,
} from "@zcode/contracts";
import { type AgentRuntime } from "../src/runtime.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const OUTPUT_TOKEN_CONTINUE_PROMPT =
  "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";

function requestText(messages: readonly { content: unknown }[]): string {
  return messages.map((message) => modelMessageContentToText(message.content as never)).join("\n");
}

function countContinue(value: unknown): number {
  return JSON.stringify(value).split(OUTPUT_TOKEN_CONTINUE_PROMPT).length - 1;
}

function canonicalContinueEntries(runtime: AgentRuntime): unknown[] {
  return (runtime as any).messageHistory
    .toRuntimeEntries()
    .filter((entry: any) => entry.metadata?.source === "output_token_continuation");
}

function stopResult(text: string, inputTokens: number, outputTokens = 1, model?: unknown) {
  return {
    finishReason: "stop",
    ...(model ? { model } : {}),
    text,
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  };
}

describe("output-token continuation with Compact", () => {
  it("auto compacts the recovery history and keeps Continue in the preserved segment", async () => {
    const sessionId = createSessionId("output-token-auto-compact");
    const eventStore = createTestSessionEventStore();
    const oldModel = createTestModelSelection("provider-old/model-old", {
      maxOutputTokens: 1,
    });
    const newModel = createTestModelSelection("provider-new/model-new", {
      maxOutputTokens: 1,
    });
    const oldOutputStylePrompt = "Use the old turn-local compact style.";
    const newOutputStylePrompt = "Use the next-turn compact style.";
    const requests: Array<{ compact: boolean; model: string; text: string }> = [];
    let normalCallCount = 0;
    let modelSwitched = false;
    let runtime!: AgentRuntime;
    runtime = createTestAgentRuntime(
      sessionId,
      {
        compact: {
          bufferTokens: 10,
          contextWindow: 120,
          summaryReserveTokens: 0,
        },
        modelSelection: oldModel,
        outputStyle: {
          keepCodingInstructions: true,
          name: "Old compact style",
          prompt: oldOutputStylePrompt,
        },
        titleGeneration: { enabled: false },
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request: any, observation) {
            const text = requestText(request.messages);
            const compact = text.includes("create a detailed summary");
            requests.push({
              compact,
              model: `${observation.model.providerId}/${observation.model.modelId}`,
              text,
            });
            if (compact) {
              if (!modelSwitched) {
                modelSwitched = true;
                runtime.setSessionModelSelection(newModel);
                runtime.updateConfig({
                  outputStyle: {
                    keepCodingInstructions: true,
                    name: "New compact style",
                    prompt: newOutputStylePrompt,
                  },
                });
              }
              return stopResult(
                "<summary>Recovery summary keeps the current task.</summary>",
                100,
                5,
              );
            }

            normalCallCount += 1;
            if (normalCallCount === 1) {
              return stopResult("warmup done", 3, 1);
            }
            if (normalCallCount === 2) {
              return {
                finishReason: "length",
                text: "A",
                usage: { inputTokens: 115, outputTokens: 1, totalTokens: 116 },
              };
            }
            return stopResult("done", 4, 1);
          },
        }),
      },
    );

    await runtime.executeTurn("warmup");
    const result = await runtime.executeTurn("continue task");
    const events = await eventStore.getEvents(sessionId);
    const finalMainRequest = requests.filter((request) => !request.compact).at(-1);

    expect(result.response).toBe("done");
    expect(requests.filter((request) => request.compact)).toHaveLength(1);
    expect(finalMainRequest?.model).toBe("provider-old/model-old");
    expect(finalMainRequest?.text).toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    expect(finalMainRequest?.text).toContain(oldOutputStylePrompt);
    expect(finalMainRequest?.text).not.toContain(newOutputStylePrompt);
    const compactBoundary = events.find(
      (event) => event.type === SessionEventType.CompactBoundary,
    ) as any;
    // 保留段是 partial A 和它后面的 Continue。
    expect(compactBoundary?.payload.keptMessageCount).toBe(2);
    // ModelRequest 事件与实际请求是同一份消息，逐个请求的 Continue 条数相同。
    expect(
      events
        .filter((event) => event.type === SessionEventType.ModelRequest)
        .map((event: any) => countContinue(event.payload.messages)),
    ).toEqual(requests.map((request) => countContinue(request.text)));
    expect(canonicalContinueEntries(runtime)).toHaveLength(1);

    await runtime.executeTurn("next turn uses switched model");
    const nextTurnRequest = requests.filter((request) => !request.compact).at(-1);

    expect(nextTurnRequest?.model).toBe("provider-new/model-new");
    expect(nextTurnRequest?.text).toContain(newOutputStylePrompt);
    expect(nextTurnRequest?.text).not.toContain(oldOutputStylePrompt);
  });

  it("reactively compacts the recovery history and keeps Continue in history", async () => {
    const sessionId = createSessionId("output-token-reactive-compact");
    const eventStore = createTestSessionEventStore();
    const requests: Array<{ compact: boolean; text: string }> = [];
    let normalCallCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        systemPrompt: "You are an output continuation reactive compact test agent.",
        titleGeneration: { enabled: false },
      },
      {
        eventStore,
        modelAdapter: {
          async generateText(request: any) {
            const text = requestText(request.messages);
            const compact = text.includes("create a detailed summary");
            requests.push({ compact, text });
            if (compact) {
              return stopResult("<summary>Reactive recovery summary.</summary>", 100, 5);
            }

            normalCallCount += 1;
            if (normalCallCount <= 2) {
              return stopResult(`setup ${normalCallCount}`, 2);
            }
            if (normalCallCount === 3) {
              return { finishReason: "length", text: "A", usage: {} };
            }
            if (normalCallCount === 4) {
              const error = new Error("provider context window exceeded") as Error & {
                code: string;
              };
              error.code = ModelErrorCode.ModelContextExceeded;
              throw error;
            }
            return stopResult("done", 3);
          },
        } as never,
      },
    );

    await runtime.executeTurn("setup one");
    await runtime.executeTurn("setup two");
    const result = await runtime.executeTurn("recover through reactive compact");
    const events = await eventStore.getEvents(sessionId);
    const finalMainRequest = requests.filter((request) => !request.compact).at(-1);

    expect(result.response).toBe("done");
    expect(requests.filter((request) => request.compact)).toHaveLength(1);
    expect(finalMainRequest?.text).toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    // ModelRequest 事件与实际请求是同一份消息；Continue 随保留段留在 canonical 历史里。
    expect(
      events
        .filter((event) => event.type === SessionEventType.ModelRequest)
        .map((event: any) => countContinue(event.payload.messages)),
    ).toEqual(requests.map((request) => countContinue(request.text)));
    expect(canonicalContinueEntries(runtime)).toHaveLength(1);
  });

  it("preserves the exhausted continuation count across Reactive Compact", async () => {
    const sessionId = createSessionId("output-token-reactive-compact-count");
    const eventStore = createTestSessionEventStore();
    let normalCallCount = 0;
    let compactCallCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        systemPrompt: "You are an output continuation count test agent.",
        titleGeneration: { enabled: false },
      },
      {
        eventStore,
        modelAdapter: {
          async generateText(request: any) {
            const compact = requestText(request.messages).includes("create a detailed summary");
            if (compact) {
              compactCallCount += 1;
              return stopResult("<summary>Keep the recovery count.</summary>", 100, 5);
            }

            normalCallCount += 1;
            if (normalCallCount <= 2) return stopResult(`setup ${normalCallCount}`, 2);
            if (normalCallCount <= 5) {
              return {
                finishReason: "length",
                text: String.fromCharCode(62 + normalCallCount),
                usage: {},
              };
            }
            if (normalCallCount === 6) {
              const error = new Error("provider context window exceeded") as Error & {
                code: string;
              };
              error.code = ModelErrorCode.ModelContextExceeded;
              throw error;
            }
            if (normalCallCount === 7) {
              return { finishReason: "length", text: "D", usage: {} };
            }
            return stopResult("unexpected retry", 3);
          },
        } as never,
      },
    );

    await runtime.executeTurn("setup one");
    await runtime.executeTurn("setup two");
    const setupEventCount = (await eventStore.getEvents(sessionId)).length;
    await expect(runtime.executeTurn("exhaust through reactive compact")).rejects.toMatchObject({
      message: "The model's response exceeded the output token maximum.",
      type: "model_error",
    });

    const events = (await eventStore.getEvents(sessionId)).slice(setupEventCount);
    expect(compactCallCount).toBe(1);
    expect(normalCallCount).toBe(7);
    expect(events.some((event) => event.type === SessionEventType.TurnError)).toBe(true);
    expect(events.some((event) => event.type === SessionEventType.TurnComplete)).toBe(false);
  });

  it("microcompacts the turn entries after Continue and keeps Continue in history", async () => {
    const sessionId = createSessionId("output-token-microcompact");
    const eventStore = createTestSessionEventStore();
    const toolRegistry = createToolRegistry();
    const oldOutputStylePrompt = "Use the old microcompact style.";
    const newOutputStylePrompt = "Use the next-turn microcompact style.";
    const requests: string[] = [];
    let callCount = 0;
    toolRegistry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "MicroRead",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async (input) =>
        `${(input as { slot?: string }).slot ?? "unknown"} tool result `.repeat(12),
    });
    let runtime!: AgentRuntime;
    runtime = createTestAgentRuntime(
      sessionId,
      {
        compact: {
          bufferTokens: 1_000,
          contextWindow: 10_000,
          microcompact: {
            compactableToolNames: ["MicroRead"],
            enabled: true,
            keepRecentToolResults: 1,
            minTokenSavings: 1,
            thresholdTokens: 3_500,
          },
          summaryReserveTokens: 0,
        },
        maxOutputTokens: 100,
        mode: "yolo",
        outputStyle: {
          keepCodingInstructions: true,
          name: "Old microcompact style",
          prompt: oldOutputStylePrompt,
        },
        titleGeneration: { enabled: false },
      },
      {
        eventStore,
        modelAdapter: {
          async generateText(request: any) {
            requests.push(requestText(request.messages));
            callCount += 1;
            if (callCount <= 2) {
              return {
                finishReason: "tool-calls",
                text: "",
                toolCalls: [
                  {
                    id: `micro-read-${callCount}`,
                    input: { slot: callCount === 1 ? "old" : "latest" },
                    name: "MicroRead",
                  },
                ],
                usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
              };
            }
            if (callCount === 3) {
              runtime.updateConfig({
                outputStyle: {
                  keepCodingInstructions: true,
                  name: "New microcompact style",
                  prompt: newOutputStylePrompt,
                },
              });
              return {
                finishReason: "length",
                // 由回复长度稳定跨过 microcompact 阈值，不依赖默认 prompt 的长度。
                text: "A ".repeat(4_000),
                usage: { inputTokens: 2_000, outputTokens: 1, totalTokens: 2_001 },
              };
            }
            return stopResult("done", 500);
          },
        } as never,
        toolRegistry,
      },
    );

    const result = await runtime.executeTurn("read then continue");
    const events = await eventStore.getEvents(sessionId);

    expect(result.response).toBe("done");
    expect(requests).toHaveLength(4);
    expect(requests[2]).not.toContain("[Old tool result content cleared]");
    expect(requests[3]).toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    expect(requests[3]).toContain("[Old tool result content cleared]");
    expect(requests[3]).toContain(oldOutputStylePrompt);
    expect(requests[3]).not.toContain(newOutputStylePrompt);
    expect(events.some((event) => event.type === SessionEventType.MicrocompactBoundary)).toBe(true);
    expect(canonicalContinueEntries(runtime)).toHaveLength(1);

    await runtime.executeTurn("next turn uses refreshed output style");

    // output style 指令是追加的附件：旧公告留在历史里，新风格在其后宣告。
    expect(requests[4]).toContain(newOutputStylePrompt);
    expect(requests[4]!.indexOf(oldOutputStylePrompt)).toBeLessThan(
      requests[4]!.indexOf(newOutputStylePrompt),
    );
  });
});
