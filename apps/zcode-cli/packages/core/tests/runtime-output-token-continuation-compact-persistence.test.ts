import { describe, expect, it } from "vitest";
import {
  ModelErrorCode,
  type ModelRequestPayload,
  SessionEventType,
  createSessionId,
  modelMessageContentToText,
} from "@zcode/contracts";
import { type AgentRuntime } from "../src/runtime.js";
import {
  OUTPUT_TOKEN_CONTINUE_PROMPT,
  countContinuePrompts,
  createRecordingMessageStore,
  requestText,
  stopResult,
} from "./runtime-output-token-continuation-test-helpers.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";

const EXHAUST_PROMPT = "exhaust output continuation before Compact";
const REACTIVE_PROMPT = "trigger Reactive Compact after output exhaustion";
const COLD_PROMPT = "continue after cold Compact hydration";

interface CapturedRequest {
  compact: boolean;
  lastText: string;
  messages: Array<{ role: string; text: string }>;
  text: string;
}

describe("output-token terminal errors across Compact persistence", () => {
  it("keeps Continue in the Compact wire request and in the recorded events", async () => {
    const sessionId = createSessionId("continue-in-compact-summary-events");
    const eventStore = createTestSessionEventStore();
    const store = createRecordingMessageStore();
    const requests: Array<{ compact: boolean; text: string }> = [];
    let normalRequestCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      { modelStreaming: "off", titleGeneration: { enabled: false } },
      {
        eventStore,
        sessionStore: store as never,
        modelAdapter: {
          async generateText(request: any) {
            const text = requestText(request.messages);
            const compact = text.includes("create a detailed summary");
            requests.push({ compact, text });
            if (compact) return stopResult("<summary>Retain the current task.</summary>", 20, 5);
            normalRequestCount += 1;
            if (normalRequestCount <= 2) return stopResult(`setup ${normalRequestCount}`, 10);
            if (normalRequestCount <= 4) {
              return {
                finishReason: "length",
                text: normalRequestCount === 3 ? "partial A" : "partial B",
                usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
              };
            }
            if (normalRequestCount === 5) {
              const error = new Error("provider context window exceeded") as Error & {
                code: string;
              };
              error.code = ModelErrorCode.ModelContextExceeded;
              throw error;
            }
            return stopResult("done", 30);
          },
        } as never,
      },
    );

    await runtime.executeTurn("setup one");
    await runtime.executeTurn("setup two");
    const result = await runtime.executeTurn("start continuation task");

    // 两次续写使较早的 Continue 进入待总结部分；只测一次会把它留在 preserved tail，漏掉回归。
    const compactRequests = requests.filter((request) => request.compact);
    expect(result.response).toBe("done");
    expect(compactRequests).toHaveLength(1);
    expect(compactRequests[0]?.text).toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    expect(requests.at(-1)?.text).toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    const events = await eventStore.getEvents(sessionId);
    const requestPayloads = events
      .filter((event) => event.type === SessionEventType.ModelRequest)
      .map((event) => event.payload as ModelRequestPayload);
    const compactPayloads = requestPayloads.filter((payload) => payload.querySource === "compact");
    expect(compactPayloads).toHaveLength(1);
    expect(JSON.stringify(compactPayloads[0]?.messages)).toContain("partial A");
    // 事件与实际请求是同一份消息；两条 Continue 都按隐藏提醒记录写库。
    expect(requestPayloads.map((payload) => countContinuePrompts(payload.messages))).toEqual(
      requests.map((request) => request.text.split(OUTPUT_TOKEN_CONTINUE_PROMPT).length - 1),
    );
    expect(
      store.savedMessages.filter(
        (message) => message.semantics?.source === "output_token_continuation",
      ),
    ).toHaveLength(2);
  });

  it("keeps a raw output-limit partial consistent after reactive Compact and cold resume", async () => {
    const sessionId = createSessionId("raw-context-partial-compact-resume");
    const store = createRecordingMessageStore();
    const requests: CapturedRequest[] = [];
    let normalRequestCount = 0;
    let promptTooLongThrown = false;

    const modelAdapter = {
      async generateText(request: any) {
        const messages = request.messages.map((message: any) => ({
          role: message.role,
          text: modelMessageContentToText(message.content),
        }));
        const text = requestText(request.messages);
        const compact = text.includes("create a detailed summary");
        requests.push({
          compact,
          lastText: messages.at(-1)?.text ?? "",
          messages,
          text,
        });

        if (compact) {
          return stopResult(
            "<summary>Reactive Compact keeps the raw context partial.</summary>",
            100,
            5,
          );
        }

        normalRequestCount += 1;
        if (normalRequestCount <= 2) {
          return stopResult(`setup ${normalRequestCount}`, 10);
        }
        if (normalRequestCount === 3) {
          return {
            finishReason: "other",
            providerMetadata: { rawFinishReason: "max_output_tokens" },
            text: "raw context partial",
            usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
          };
        }
        if (normalRequestCount === 4 && !promptTooLongThrown) {
          promptTooLongThrown = true;
          const error = new Error("prompt is too long: 999 tokens > 100") as Error & {
            code: string;
          };
          error.code = ModelErrorCode.ModelContextExceeded;
          throw error;
        }
        return stopResult("completed after Compact", 30);
      },
    };
    const runtimeConfig = {
      systemPrompt: "You are a raw context partial Compact parity test agent.",
      titleGeneration: { enabled: false as const },
    };
    const runtime = createTestAgentRuntime(sessionId, runtimeConfig, {
      eventStore: createTestSessionEventStore(),
      modelAdapter: modelAdapter as never,
      sessionStore: store as never,
    });

    await runtime.executeTurn("setup one");
    await runtime.executeTurn("setup two");
    await runtime.executeTurn("trigger raw context partial");

    const coldStore = createRecordingMessageStore();
    await coldStore.createSession(await store.getSession(sessionId));
    coldStore.savedMessages.push(...store.savedMessages.map((message) => ({ ...message })));
    coldStore.savedParts.push(...store.savedParts.map((part) => ({ ...part })));

    const liveNext = await runtime.executeTurn("compare provider history");
    const liveRequest = requests.at(-1);
    expect(liveNext.response).toBe("completed after Compact");
    expect(requests.filter((request) => request.compact)).toHaveLength(1);
    expect(requests.some((request) => request.text.includes(OUTPUT_TOKEN_CONTINUE_PROMPT))).toBe(
      true,
    );
    expect(liveRequest?.text).toContain("Reactive Compact keeps the raw context partial.");
    expect(liveRequest?.text).toContain("raw context partial");
    // 压缩保留段里的 Continue 随保留段留存；下面断言冷恢复与 live 相同。
    expect(liveRequest?.text).toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);

    const resumedRuntime = createTestAgentRuntime(sessionId, runtimeConfig, {
      eventStore: createTestSessionEventStore(),
      modelAdapter: modelAdapter as never,
      sessionStore: coldStore as never,
    });
    await resumedRuntime.resumeFromStore();
    await resumedRuntime.executeTurn("compare provider history");

    const coldRequest = requests.at(-1);
    expect(coldRequest?.text).toBe(liveRequest?.text);
  });

  it("keeps a partial terminal assistant in both live and cold preserved history", async () => {
    const result = await runCompactPersistenceScenario({
      id: "output-token-partial-error-compact-persistence",
      partials: ["A1 partial", "A2 partial", "A3 partial", "A4 partial"],
    });
    const liveRequest = findRequest(result.requests, REACTIVE_PROMPT);
    const coldRequest = findRequest(result.requests, COLD_PROMPT);
    const partialPart = result.store.savedParts.find(
      (part) => part.type === "text" && part.text === "A4 partial",
    );
    const partialMessage = result.store.savedMessages.find(
      (message) => message.id === partialPart?.messageID,
    );

    const errorMessage = result.store.savedMessages.find(
      (message) => message.error?.name === "model_output_limit_exceeded",
    );
    const errorParts = result.store.savedParts.filter(
      (part) => part.messageID === errorMessage?.id,
    );

    expect(partialMessage?.error).toBeUndefined();
    expect(errorMessage?.id).not.toBe(partialMessage?.id);
    expect(errorMessage?.tokens).toMatchObject({ input: 0, output: 0 });
    expect(
      errorParts.some(
        (part) =>
          (part.type === "text" && part.text.trim().length > 0) ||
          part.type === "reasoning" ||
          part.type === "tool",
      ),
    ).toBe(false);
    expect(liveRequest.text).toContain("A4 partial");
    expect(coldRequest.text).toContain("A4 partial");
  });

  it("keeps an empty terminal error only in the transcript, not provider history", async () => {
    const result = await runCompactPersistenceScenario({
      id: "output-token-empty-error-compact-persistence",
      partials: ["", "", "", ""],
    });
    const liveRequest = findRequest(result.requests, REACTIVE_PROMPT);
    const coldRequest = findRequest(result.requests, COLD_PROMPT);
    const errorMessage = result.store.savedMessages.find(
      (message) => message.error?.name === "model_output_limit_exceeded",
    );
    const errorParts = result.store.savedParts.filter(
      (part) => part.messageID === errorMessage?.id,
    );

    expect(errorMessage).toBeDefined();
    expect(
      errorParts.some(
        (part) =>
          (part.type === "text" && part.text.trim().length > 0) ||
          part.type === "reasoning" ||
          part.type === "tool",
      ),
    ).toBe(false);
    expect(hasEmptyAssistant(liveRequest)).toBe(false);
    expect(hasEmptyAssistant(coldRequest)).toBe(false);
  });
});

async function runCompactPersistenceScenario(input: {
  id: string;
  partials: readonly string[];
}): Promise<{
  requests: CapturedRequest[];
  store: ReturnType<typeof createRecordingMessageStore>;
}> {
  const sessionId = createSessionId(input.id);
  const store = createRecordingMessageStore();
  const requests: CapturedRequest[] = [];
  let exhaustionCallCount = 0;
  let overflowThrown = false;
  let responseCount = 0;
  const modelAdapter = {
    async generateText(request: any) {
      const messages = request.messages.map((message: any) => ({
        role: message.role,
        text: modelMessageContentToText(message.content),
      }));
      const text = requestText(request.messages);
      const lastText = messages.at(-1)?.text ?? "";
      const compact = text.includes("create a detailed summary");
      requests.push({ compact, lastText, messages, text });

      if (compact) {
        return stopResult(
          "<summary>Compact summary intentionally omits exact partial markers.</summary>",
          100,
          5,
        );
      }
      if (text.includes(EXHAUST_PROMPT) && exhaustionCallCount < input.partials.length) {
        const partial = input.partials[exhaustionCallCount]!;
        exhaustionCallCount += 1;
        return {
          finishReason: "length",
          text: partial,
          usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
        };
      }
      if (lastText === REACTIVE_PROMPT && !overflowThrown) {
        overflowThrown = true;
        const error = new Error("provider context window exceeded") as Error & { code: string };
        error.code = ModelErrorCode.ModelContextExceeded;
        throw error;
      }

      responseCount += 1;
      return stopResult(`normal response ${responseCount}`, 3);
    },
  };
  const runtimeConfig = {
    systemPrompt: "You are an output continuation Compact persistence test agent.",
    titleGeneration: { enabled: false as const },
  };
  const runtime = createTestAgentRuntime(sessionId, runtimeConfig, {
    eventStore: createTestSessionEventStore(),
    modelAdapter: modelAdapter as never,
    sessionStore: store as never,
  });

  await runtime.executeTurn("first setup to summarize");
  await runtime.executeTurn("second setup to summarize");
  await expect(runtime.executeTurn(EXHAUST_PROMPT)).rejects.toMatchObject({
    message: "The model's response exceeded the output token maximum.",
    type: "model_error",
  });
  await runtime.executeTurn(REACTIVE_PROMPT);

  const resumedRuntime = createTestAgentRuntime(sessionId, runtimeConfig, {
    eventStore: createTestSessionEventStore(),
    modelAdapter: modelAdapter as never,
    sessionStore: store as never,
  });
  await resumedRuntime.resumeFromStore();
  await resumedRuntime.executeTurn(COLD_PROMPT);

  return { requests, store };
}

function findRequest(requests: readonly CapturedRequest[], lastText: string): CapturedRequest {
  const request = requests
    .filter((candidate) => !candidate.compact && candidate.lastText === lastText)
    .at(-1);
  expect(request).toBeDefined();
  return request!;
}

function hasEmptyAssistant(request: CapturedRequest): boolean {
  return request.messages.some(
    (message) => message.role === "assistant" && message.text.trim().length === 0,
  );
}
