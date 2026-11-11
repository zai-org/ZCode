import { describe, expect, it } from "vitest";
import {
  LOCAL_TOOL_SEARCH_NAME,
  ModelRequestSessionFeature,
  SESSION_ENTRY_SESSION_FEATURES,
  TOOL_SEARCH_NAME,
  createRootTraceContext,
  createSessionId,
  type Model,
  type ModelInvocationContext,
  type ModelRequest,
  type ModelResult,
  type SessionEntryInfo,
  type SessionStorePort,
  type ToolSearchMode,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../../src/runtime/internal.js";
import { readSessionFeatures } from "../../src/runtime/session-features/contract.js";
import { createToolRegistry } from "../../src/tool/registry.js";
import { createRecordingMessageStore } from "../runtime-output-token-continuation-test-helpers.js";
import { createTestAgentRuntime } from "../test-agent-runtime.js";
import { createTestSessionEventStore } from "../test-event-store.js";
import { createTestModelFactory } from "../test-runtime-model.js";

// 规格：docs/design/v2/model/session-features-header.md 的 ToolSearch 标签：主循环打点与旁路请求。
const { ToolSearchCalled, ToolSearchLocal, ToolSearchNative } = ModelRequestSessionFeature;

describe("主循环打点（端到端）", () => {
  /** 一轮：模型先搜索一次再结束；返回每次模型请求带的标签和最终写入的 entry。 */
  async function runSearchTurn(mode: ToolSearchMode, searchName = TOOL_SEARCH_NAME) {
    const entries = new Map<string, SessionEntryInfo>();
    const seen: ModelInvocationContext[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId(`session-features-tool-search-${Math.random().toString(36).slice(2)}`),
      {
        mode: "yolo",
        modelStreaming: "off",
        titleGeneration: { enabled: false },
        toolSearch: { mode },
        // TaskOutput 是内置的 deferred 工具；local 还需要 DeferredToolCall 作为控制工具。
        toolAllowlist: [TOOL_SEARCH_NAME, "DeferredToolCall", "Read", "TaskOutput"],
      },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore: recordingSessionStore(entries),
        modelFactory: withToolSearchCapability(
          createTestModelFactory({
            async generateText(_request, observation) {
              seen.push(observation.invocationContext!);
              if (seen.length === 1)
                return {
                  text: "",
                  finishReason: "tool-calls",
                  usage: {},
                  toolCalls: [
                    { id: "call_search", name: searchName, input: { query: "select:TaskOutput" } },
                  ],
                };
              return { text: "done", finishReason: "stop", usage: {} };
            },
          }),
        ),
      },
    );
    await runtime.executeTurn("load the task output tool");
    await (runtime as unknown as AgentRuntimeInternal).sessionFeaturesWrite;
    return {
      features: seen.map((context) => context.modelRequestSessionFeatures),
      entries: [...entries.values()]
        .filter((entry) => entry.type === SESSION_ENTRY_SESSION_FEATURES)
        .map((entry) => entry.data),
    };
  }

  it("native：首个请求就带模式标签，搜索之后的请求再带 tool_search_called，并写入 entry", async () => {
    const { features, entries } = await runSearchTurn("native");
    expect(features).toEqual([[ToolSearchNative], [ToolSearchCalled, ToolSearchNative]]);
    expect(entries).toEqual([{ features: [ToolSearchCalled, ToolSearchNative] }]);
  });

  it("local：模型调用 LocalToolSearch，标签与 native 对称", async () => {
    const { features, entries } = await runSearchTurn("local", LOCAL_TOOL_SEARCH_NAME);
    expect(features).toEqual([[ToolSearchLocal], [ToolSearchCalled, ToolSearchLocal]]);
    expect(entries).toEqual([{ features: [ToolSearchCalled, ToolSearchLocal] }]);
  });

  it("off：不打模式标签；搜索调用执行失败也不打 tool_search_called", async () => {
    const { features, entries } = await runSearchTurn("off");
    expect(features).toEqual([undefined, undefined]);
    expect(entries).toEqual([]);
  });
});

describe("旁路请求不打模式标签", () => {
  it("compact 请求即使启用了 ToolSearch 也不打标签", async () => {
    const registry = createToolRegistry();
    // compact 只保留 Read、ToolSearch 与 MCP 工具；一个 deferred 的 MCP 工具即可让 ToolSearch 生效。
    registry.register({
      inputSchema: { type: "object", properties: {} },
      metadata: {
        name: "mcp__demo__lookup",
        mcpPresentation: { serverName: "demo", toolName: "lookup" },
        readOnly: true,
        concurrentSafe: true,
        destructive: false,
        needsApproval: false,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => "done",
    });
    const compactRequests: Array<{ request: ModelRequest; context: ModelInvocationContext }> = [];
    const runtime = createTestAgentRuntime(
      createSessionId("session-features-tool-search-compact"),
      {
        modelStreaming: "off",
        titleGeneration: { enabled: false },
        toolAllowlist: ["Read", TOOL_SEARCH_NAME],
        toolSearch: { mode: "native" },
      },
      {
        toolRegistry: registry,
        eventStore: createTestSessionEventStore(),
        modelFactory: withToolSearchCapability(
          createTestModelFactory({
            async generateText(request, observation): Promise<ModelResult> {
              compactRequests.push({ request, context: observation.invocationContext! });
              return {
                text: "<summary>Continue the task.</summary>",
                finishReason: "stop",
                usage: {},
              };
            },
          }),
        ),
      },
    );
    const internal = runtime as unknown as AgentRuntimeInternal;
    // 直接灌历史再压缩：不经过主循环，会话里没有任何标签。
    internal.messageHistory.addUser("first setup turn");
    internal.messageHistory.addAssistant("first response");
    internal.messageHistory.addUser("second setup turn");
    internal.messageHistory.addAssistant("second response");
    await internal.compactActiveConversation(undefined, createRootTraceContext(), [], {});

    expect(compactRequests).toHaveLength(1);
    expect(compactRequests[0]!.request.toolSearchEnabled).toBe(true);
    expect(compactRequests[0]!.context.modelRequestSessionFeatures).toBeUndefined();
    expect(readSessionFeatures(internal)).toEqual([]);
  });
});

/** 让测试模型声明支持 Anthropic 协议的工具搜索，native 才能生效（resolveToolSearchMode）。 */
function withToolSearchCapability(
  factory: ReturnType<typeof createTestModelFactory>,
): ReturnType<typeof createTestModelFactory> {
  const wrap = (model: Model): Model => ({
    ...model,
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
    bind: (options) => wrap(model.bind(options)),
  });
  return (input) => wrap(factory(input));
}

function recordingSessionStore(entries: Map<string, SessionEntryInfo>): SessionStorePort {
  return {
    ...createRecordingMessageStore(),
    async getProjectPermission() {
      return null;
    },
    async saveSessionEntry(entry: SessionEntryInfo) {
      entries.set(entry.id, entry);
    },
  } as unknown as SessionStorePort;
}
