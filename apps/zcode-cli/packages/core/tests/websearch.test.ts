// ============================================================
import { createTestModelSelection } from "./test-model-selection.js";
// Provider-visible WebSearch Wrapper Tests
// ============================================================

import {
  SessionEventType,
  WebSearchInputJsonSchema,
  WebSearchInputSchema,
  WEB_SEARCH_BUDGET_EXHAUSTED_ERROR_CODE,
  createSessionId,
  type ModelSelection,
  type WebSearchBudgetCharge,
} from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { webSearchToolEntry } from "../src/tool/handlers/websearch.js";
import { buildWebSearchOutput } from "../src/tool/handlers/websearch-results.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory, createTestRuntimeModel } from "./test-runtime-model.js";

const modelSelection: ModelSelection = {
  providerId: "deepseek" as never,
  modelId: "deepseek-chat" as never,
};

describe("provider-visible WebSearch wrapper", () => {
  it("exposes WebSearch schema without unsupported provider-native no-op options", () => {
    const properties = WebSearchInputJsonSchema.properties as Record<string, unknown>;

    expect(properties.query).toBeDefined();
    expect(properties.allowed_domains).toBeDefined();
    expect(properties.blocked_domains).toBeDefined();
    expect(properties.allowedDomains).toBeUndefined();
    expect(properties.blockedDomains).toBeUndefined();
    expect(properties.maxUses).toBeUndefined();
    expect(properties.searchContextSize).toBeUndefined();
    expect(properties.numResults).toBeUndefined();
    expect(properties.safeSearch).toBeUndefined();
  });

  it("validates provider-visible search options", () => {
    expect(
      WebSearchInputSchema.safeParse({
        allowed_domains: ["example.com"],
        maxUses: 3,
        query: "latest zcode",
      }).success,
    ).toBe(true);
    expect(
      WebSearchInputSchema.safeParse({
        query: "latest zcode",
        searchContextSize: "high",
      }).success,
    ).toBe(false);
    expect(
      WebSearchInputSchema.safeParse({
        maxUses: 9,
        query: "latest zcode",
      }).success,
    ).toBe(false);
    expect(
      WebSearchInputSchema.safeParse({
        allowed_domains: ["example.com"],
        blocked_domains: ["blocked.example"],
        query: "latest zcode",
      }).success,
    ).toBe(false);
    expect(
      WebSearchInputSchema.safeParse({
        allowed_domains: ["https://example.com"],
        query: "latest zcode",
      }).success,
    ).toBe(true);
    expect(
      WebSearchInputSchema.safeParse({
        allowed_domains: Array.from({ length: 21 }, (_, index) => `example-${index}.com`),
        query: "latest zcode",
      }).success,
    ).toBe(true);
  });

  it("describes public WebSearch citation and domain guidance", () => {
    const description = webSearchToolEntry.metadata.description;
    const instructions = webSearchToolEntry.metadata.modelInstructions?.join("\n") ?? "";
    const prompt = `${description}\n${instructions}`;

    expect(prompt).toContain("Sources:");
    expect(prompt).toContain("markdown links");
    expect(prompt).toContain("allowed_domains");
    expect(prompt).toContain("blocked_domains");
    expect(prompt).toContain("current month");
    expect(prompt).toContain("US-only");
  });

  it("keeps the WebSearch description stable across months", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2027, 1, 15, 12, 0, 0));
      vi.resetModules();

      const { webSearchToolEntry: timedWebSearchToolEntry } =
        await import("../src/tool/handlers/websearch.js");
      const { createToolRegistry: createTimedToolRegistry } =
        await import("../src/tool/registry.js");
      const timedRegistry = createTimedToolRegistry();
      timedRegistry.register(timedWebSearchToolEntry);
      const getProviderDescription = () =>
        timedRegistry.toContracts().find((tool) => tool.name === "WebSearch")?.description ?? "";

      // 月份由会话里的当前日期提供；描述里写月份会让 tools 缓存每月失效一次。
      const february = getProviderDescription();
      expect(february).toContain(
        "- The current month is (provided in the conversation below) — use this when searching for recent information.",
      );
      expect(february).not.toContain("2027");

      vi.setSystemTime(new Date(2027, 2, 15, 12, 0, 0));
      expect(getProviderDescription()).toBe(february);
    } finally {
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it("registers WebSearch as a client-side built-in tool", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, { includeAgent: true });

    expect(registry.has("WebSearch")).toBe(true);
    expect(registry.has("web_search")).toBe(false);
    expect(registry.toContracts()).toContainEqual(
      expect.objectContaining({
        executionMode: "client",
        name: "WebSearch",
        providerNative: undefined,
      }),
    );
  });

  it("keeps non-execution inventory independent from a model", () => {
    const runtime = createRuntime("runtime-websearch-client-wrapper");
    const tools = runtime.getTools();

    expect(runtime.getToolRegistry().has("WebSearch")).toBe(true);
    expect(tools).toContainEqual(
      expect.objectContaining({
        executionMode: "client",
        name: "WebSearch",
        providerNative: undefined,
      }),
    );
    expect(tools.some((tool) => tool.name === "web_search")).toBe(false);
  });

  it("filters execution tools only from the current Active Model property", () => {
    const runtime = createRuntime("runtime-websearch-active-model");
    const createModel = (supportsNativeWebSearch: boolean) =>
      createTestRuntimeModel({
        generateText: async () => ({ finishReason: "stop", text: "", usage: {} }),
        propertyOverrides: { supportsNativeWebSearch },
      });

    expect(runtime.getTools(createModel(true)).some((tool) => tool.name === "WebSearch")).toBe(
      true,
    );
    expect(runtime.getTools(createModel(false)).some((tool) => tool.name === "WebSearch")).toBe(
      false,
    );
  });

  it("normalizes legacy web_search allowlist aliases to WebSearch", () => {
    expect(
      createRuntime("runtime-websearch-explore", {
        toolset: "explore",
        toolAllowlist: ["Read", "Glob", "Grep", "WebSearch"],
      })
        .getTools()
        .some((tool) => tool.name === "WebSearch"),
    ).toBe(true);
    expect(
      createRuntime("runtime-websearch-explore-provider-alias", {
        toolset: "explore",
        toolAllowlist: ["Read", "Glob", "Grep", "web_search"],
      })
        .getTools()
        .some((tool) => tool.name === "WebSearch"),
    ).toBe(true);
    expect(
      createRuntime("runtime-websearch-explore-deny", {
        toolset: "explore",
        toolAllowlist: ["Read", "Glob", "Grep"],
      })
        .getTools()
        .some((tool) => tool.name === "WebSearch"),
    ).toBe(false);
    expect(
      createRuntime("runtime-websearch-allowlist-deny", {
        toolAllowlist: ["Read"],
      })
        .getTools()
        .some((tool) => tool.name === "WebSearch"),
    ).toBe(false);
    expect(
      createRuntime("runtime-websearch-allowlist-public", {
        toolAllowlist: ["WebSearch"],
      })
        .getTools()
        .some((tool) => tool.name === "WebSearch"),
    ).toBe(true);
    expect(
      createRuntime("runtime-websearch-allowlist-provider", {
        toolAllowlist: ["web_search"],
      })
        .getTools()
        .some((tool) => tool.name === "WebSearch"),
    ).toBe(true);
  });

  it("runs an internal streaming provider-native web_search request from the WebSearch handler", async () => {
    const sessionId = createSessionId("runtime-websearch-handler-side-request");
    const eventStore = createTestSessionEventStore();
    const requests: any[] = [];
    let mainRequestCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      { modelSelection: createTestModelSelection(modelSelection) },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          properties: { supportsNativeWebSearch: true },
          async generateText(request: any, observation) {
            if (observation.invocationContext?.metadata?.querySource === "web_search_tool") {
              throw new Error("WebSearch side request must use streamText");
            }

            mainRequestCount++;
            if (mainRequestCount === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_websearch",
                    input: {
                      allowed_domains: ["example.com"],
                      query: "latest zcode",
                    },
                    name: "WebSearch",
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "Final answer with sources",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
          async *streamText(request: any, observation) {
            requests.push({ observation, request });
            if (observation.invocationContext?.metadata?.querySource !== "web_search_tool") {
              throw new Error("Unexpected streaming request");
            }

            yield { type: "start" };
            yield { id: "text_1", type: "text_start" };
            yield {
              id: "text_1",
              text: "Search summary from [Example](https://example.com)",
              type: "text_delta",
            };
            yield { id: "text_1", type: "text_end" };
            yield {
              finishReason: "stop",
              providerMetadata: { rawFinishReason: "end_turn" },
              type: "finish",
              usage: {
                inputTokens: 5,
                outputTokens: 7,
                serverToolUse: { webSearchRequests: 1 },
                totalTokens: 12,
              },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("Search current ZCode info");

    const innerRequest = requests.find(
      ({ observation }) =>
        observation.invocationContext?.metadata?.querySource === "web_search_tool",
    )?.request;
    expect(innerRequest.messages).toEqual([
      {
        content: "You are an assistant for performing a web search tool use.",
        role: "system",
      },
      { content: "Perform a web search for the query: latest zcode", role: "user" },
    ]);
    expect(innerRequest.tools.map((tool: any) => tool.name)).toEqual(["web_search"]);
    expect(innerRequest.tools[0]).toMatchObject({
      executionMode: "providerNative",
      providerNative: expect.objectContaining({
        args: expect.objectContaining({
          allowedDomains: ["example.com"],
          maxUses: 8,
        }),
        logicalName: "WebSearch",
        providerToolName: "web_search",
      }),
    });
    expect(innerRequest.tools[0].providerNative.args).not.toHaveProperty("searchContextSize");
    expect(innerRequest.toolChoice).toBeUndefined();
    expect(innerRequest.options).toEqual({
      maxOutputTokens: 4_096,
      reasoningLevel: "low",
    });

    const storedEvents = await eventStore.getEvents(sessionId);
    expect(
      storedEvents.some(
        (event: any) =>
          event.type === SessionEventType.ToolCallStarted &&
          event.payload?.toolName === "WebSearch",
      ),
    ).toBe(true);
    expect(
      storedEvents.some(
        (event: any) =>
          event.type === SessionEventType.ToolCallResult &&
          event.payload?.toolCallId === "call_websearch",
      ),
    ).toBe(true);
  });

  it("refreshes provider runtime headers before the WebSearch internal model request", async () => {
    const sessionId = createSessionId("runtime-websearch-refresh-runtime-headers");
    const eventStore = createTestSessionEventStore();
    const startPlanModelSelection: ModelSelection = {
      providerId: "account:zai-start-plan" as never,
      modelId: "GLM-5.1" as never,
    };
    const refreshes: string[] = [];
    const requests: any[] = [];
    let mainRequestCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      { modelSelection: createTestModelSelection(startPlanModelSelection) },
      {
        eventStore,
        providerRuntimeHeadersPort: {
          shouldRefreshBeforeModelRequest: ({ providerId }) =>
            providerId === "account:zai-start-plan",
          async refreshBeforeModelRequest(input) {
            refreshes.push(`${input.providerId}:${input.reason}`);
            return {
              headersApplied: true,
            };
          },
        },
        modelFactory: createTestModelFactory({
          properties: { supportsNativeWebSearch: true },
          async generateText(request: any, observation) {
            if (observation.invocationContext?.metadata?.querySource === "web_search_tool") {
              throw new Error("WebSearch side request must use streamText");
            }

            requests.push({ observation, request });
            mainRequestCount++;
            if (mainRequestCount === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_websearch",
                    input: { query: "latest zcode" },
                    name: "WebSearch",
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "Final answer with sources",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
          async *streamText(request: any, observation) {
            requests.push({ observation, request });
            if (observation.invocationContext?.metadata?.querySource !== "web_search_tool") {
              throw new Error("Unexpected streaming request");
            }
            await observation.invocationContext?.refreshRuntimeHeadersBeforeAttempt?.({
              attempt: 1,
              abortSignal: request.abortSignal,
              providerId: String(observation.model.providerId),
              modelId: String(observation.model.modelId),
              traceContext: observation.invocationContext.traceContext,
            });
            yield { type: "start" };
            yield { id: "text_1", type: "text_start" };
            yield {
              id: "text_1",
              text: "Search summary from [Example](https://example.com)",
              type: "text_delta",
            };
            yield { id: "text_1", type: "text_end" };
            yield {
              finishReason: "stop",
              providerMetadata: { rawFinishReason: "end_turn" },
              type: "finish",
              usage: {
                inputTokens: 5,
                outputTokens: 7,
                serverToolUse: { webSearchRequests: 1 },
                totalTokens: 12,
              },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("Search current ZCode info");

    const innerRequest = requests.find(
      ({ observation }) =>
        observation.invocationContext?.metadata?.querySource === "web_search_tool",
    );
    expect(
      typeof innerRequest?.observation.invocationContext?.refreshRuntimeHeadersBeforeAttempt,
    ).toBe("function");
    expect(refreshes).toEqual(["account:zai-start-plan:model-request"]);
  });

  it("formats WebSearch tool results with markdown sources reminder", () => {
    const text = webSearchToolEntry.formatModelContent?.({
      durationMs: 10,
      modelUsage: {
        inputTokens: 5,
        outputTokens: 7,
        serverToolUse: { webSearchRequests: 1 },
        totalTokens: 12,
      },
      query: "latest zcode",
      results: [{ title: "Example", url: "https://example.com" }],
      sources: [],
      webSearchRequests: 1,
    });

    expect(String(text)).toContain('Web search results for query: "latest zcode"');
    expect(String(text)).toContain("- [Example](https://example.com)");
    expect(String(text)).toContain("markdown hyperlinks");
  });

  it("extracts typed provider WebSearch results from content wrappers", () => {
    const output = buildWebSearchOutput(
      { query: "latest zcode" },
      {
        finishReason: "stop",
        model: modelSelection,
        providerMetadata: undefined,
        text: "",
        toolResults: [
          {
            id: "server_search_1",
            name: "web_search",
            output: {
              content: [
                {
                  title: "Wrapped Example",
                  type: "web_search_result",
                  url: "https://example.com/wrapped",
                },
              ],
            },
            providerExecuted: true,
          },
        ],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          serverToolUse: { webSearchRequests: 1 },
        },
      },
      Date.now(),
    );

    expect(output.results).toContainEqual({
      title: "Wrapped Example",
      url: "https://example.com/wrapped",
    });
    expect(output.sources).toContainEqual({
      title: "Wrapped Example",
      url: "https://example.com/wrapped",
    });
  });

  it("extracts markdown sources from streaming WebSearch summaries", () => {
    const output = buildWebSearchOutput(
      { query: "latest zcode" },
      {
        finishReason: "stop",
        model: modelSelection,
        providerMetadata: undefined,
        text: "Search summary from [Example](https://example.com).",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          serverToolUse: { webSearchRequests: 1 },
        },
      },
      Date.now(),
    );

    expect(output.sources).toContainEqual({
      title: "Example",
      url: "https://example.com",
    });
  });
});

function createRuntime(
  sessionId: string,
  config: ConstructorParameters<typeof AgentRuntime>[1] = {},
  deps: Partial<ConstructorParameters<typeof AgentRuntime>[2]> = {},
): AgentRuntime {
  return createTestAgentRuntime(
    createSessionId(sessionId),
    {
      modelSelection: createTestModelSelection(modelSelection),
      ...config,
    },
    {
      eventStore: createTestSessionEventStore(),
      ...deps,
    },
  );
}

// 动态工作流子代理的 per-ask 预算（execution-engine.md「Search budget」）：端口回 exhausted 时
// handler 不发内部模型请求，回带固定错误码的失败；回 charged 时照常发请求。
describe("WebSearch per-ask budget port", () => {
  function budgetContext(charge: () => WebSearchBudgetCharge) {
    const streamText = vi.fn(() => {
      throw new Error("internal request sent");
    });
    const webSearchBudget = { charge: vi.fn(charge) };
    const context = {
      toolCallId: "call_budget",
      model: {
        properties: { supportsNativeWebSearch: true },
        optionSpecs: { reasoningLevel: { values: ["none"] }, maxOutputTokens: { max: 4096 } },
        streamText,
      },
      webSearchBudget,
    };
    return { context, streamText, webSearchBudget };
  }

  it("refuses without sending a request once the budget is used up", async () => {
    const { context, streamText, webSearchBudget } = budgetContext(() => ({
      kind: "exhausted",
      limit: 2,
      message: "Search budget exhausted",
    }));

    const result = await webSearchToolEntry.handler({ query: "void" }, context as never);

    expect(result).toEqual({
      result: false,
      errorCode: WEB_SEARCH_BUDGET_EXHAUSTED_ERROR_CODE,
      message: "Search budget exhausted",
    });
    expect(webSearchBudget.charge).toHaveBeenCalledTimes(1);
    expect(streamText).not.toHaveBeenCalled();
  });

  it("sends the request when the call is charged", async () => {
    const { context, streamText } = budgetContext(() => ({ kind: "charged" }));

    await expect(webSearchToolEntry.handler({ query: "q" }, context as never)).rejects.toThrow(
      "internal request sent",
    );
    expect(streamText).toHaveBeenCalledTimes(1);
  });
});
