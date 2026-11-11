import { expect, it } from "vitest";
import { createSessionId, type Model, type ModelRequest } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

it.each([
  { force: false, childCodingPlan: false, searchAllowed: true, local: true, explore: true },
  { force: false, childCodingPlan: false, searchAllowed: true, local: true },
  { force: false, childCodingPlan: false, searchAllowed: false, local: true },
  { force: false, childCodingPlan: false, searchAllowed: true },
  { force: false, childCodingPlan: true, searchAllowed: true },
  { force: true, childCodingPlan: false, searchAllowed: true },
  { force: true, childCodingPlan: false, searchAllowed: false },
])(
  "uses the child Model, startup override, independent discovery and allowed scope: %j",
  async ({ force, childCodingPlan, searchAllowed, local = false, explore = false }) => {
    const childRequests: ModelRequest[] = [];
    const parentRequests: ModelRequest[] = [];
    const childEnabled = (local || force || childCodingPlan) && searchAllowed;
    // 内置 Explore 白名单里的 WebFetch/WebSearch/TodoWrite 已常驻，只剩子会话控制通道
    // RespondToCoordinator 是 deferred；自定义 profile 用白名单里的 TaskOutput。
    const target = explore ? "RespondToCoordinator" : "TaskOutput";
    const factory = createTestModelFactory({
      async generateText(request, observation) {
        const child = observation.invocationContext?.metadata?.querySource === "subagent";
        const requests = child ? childRequests : parentRequests;
        requests.push(request);
        if (!child && requests.length === 1)
          return {
            text: "",
            usage: {},
            finishReason: "tool-calls",
            toolCalls: [
              {
                id: "spawn",
                name: "Agent",
                input: {
                  description: "Search scoped tools",
                  prompt: `Discover ${target}`,
                  subagent_type: explore ? "Explore" : "researcher",
                },
              },
            ],
          };
        if (child && childEnabled && requests.length === 1)
          return {
            text: "",
            usage: {},
            finishReason: "tool-calls",
            toolCalls: [
              {
                id: "child-search",
                name: local ? "LocalToolSearch" : "ToolSearch",
                input: { query: explore ? `select:${target}` : `select:${target},TodoRead` },
              },
            ],
          };
        return { text: "done", usage: {}, finishReason: "stop" };
      },
    });
    const withCapability = (model: Model): Model => ({
      ...model,
      requestCapabilities: {
        toolSearch: {
          protocolSupported: true,
          defaultEnabled: model.modelId === "child" ? childCodingPlan : true,
        },
      },
      bind: (options) => withCapability(model.bind(options)),
    });
    const runtime = createTestAgentRuntime(
      createSessionId("toolsearch-subagent"),
      {
        mode: "yolo",
        modelStreaming: "off",
        titleGeneration: { enabled: false },
        toolSearch: { mode: local ? "local" : force ? "native" : "auto" },
        modelSelection: { providerId: "test", modelId: "parent" },
        subagents: explore
          ? undefined
          : {
              profiles: [
                {
                  name: "researcher",
                  description: "Research",
                  source: "user",
                  systemPrompt: "Search tools",
                  modelSelection: { providerId: "test", modelId: "child" },
                  tools: searchAllowed
                    ? ["ToolSearch", ...(local ? ["DeferredToolCall"] : []), "TaskOutput"]
                    : ["TaskOutput"],
                },
              ],
            },
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: (input) => withCapability(factory(input)),
      },
    );
    try {
      await runtime.executeTurn("Run the researcher.");
      expect(childRequests.length).toBe(childEnabled ? 2 : 1);
      expect(childRequests[0]?.toolSearchEnabled).toBe(childEnabled && !local);
      expect(
        childRequests[0]?.tools?.some(
          (tool) => tool.name === (local ? "LocalToolSearch" : "ToolSearch"),
        ),
      ).toBe(childEnabled);
      if (childEnabled) {
        expect(childRequests[0]?.tools?.some((tool) => tool.name === target)).toBe(false);
        if (local) {
          expect(childRequests[1]?.tools).toEqual(childRequests[0]?.tools);
          expect(JSON.stringify(childRequests[1]?.messages)).toContain("<functions>");
          // Local 把发现结果展开成 <functions> 文本，不会出现 "toolName"；按定义名核对，
          // 作用域外的 TodoRead 不能被展开。
          const result = childRequests[1]?.messages.find((message) => message.role === "tool");
          const text = (Array.isArray(result?.content) ? result.content : [])
            .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
            .join("\n");
          const loaded = [...text.matchAll(/<function>(.*?)<\/function>/gu)].map(
            (match) => (JSON.parse(match[1]!) as { name: string }).name,
          );
          expect(loaded).toEqual([target]);
        } else {
          expect(childRequests[1]?.tools?.find((tool) => tool.name === target)?.deferLoading).toBe(
            true,
          );
          expect(
            childRequests[1]?.messages.find((message) => message.role === "tool")?.content,
          ).toEqual([{ type: "tool_reference", toolName: target }]);
        }
      } else expect(childRequests[0]?.tools?.some((tool) => tool.name === target)).toBe(true);
      // 子会话的发现不回流父会话：父会话末轮工具列表与首轮相同，历史里也没有 Local 展开的定义。
      // 只断言 target 不在父会话工具里会在 Local 与 Explore 行恒为真，因此对照整份列表。
      expect(parentRequests).toHaveLength(2);
      expect(parentRequests[1]?.tools).toEqual(parentRequests[0]?.tools);
      expect(JSON.stringify(parentRequests[1]?.messages)).not.toContain("<functions>");
    } finally {
      await runtime.closeBrowserSession();
    }
  },
);
