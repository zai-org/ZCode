// ToolSearch 动态 MCP 端到端发包：runtime 实际产出的请求经 Anthropic SDK 序列化后的工具定义与引用。
// 规格见 docs/mcp-async-tool-catalog-cache.md §5；server 就绪由等待端口手动触发，不用 sleep。
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { expect, it } from "vitest";
import {
  createSessionId,
  type McpPort,
  type McpServerStatus,
  type McpServerToolSnapshot,
  type Model,
  type ModelRequest,
  toolSearchNameForMode,
} from "@zcode/contracts";
import { toAiSdkMessages } from "../src/model/transform.js";
import { toAiSdkTools } from "../src/model/tool-transform.js";
import { toolSearchHeaders } from "../src/model/tool-search.js";
import { createTestAgentRuntime } from "../../core/tests/test-agent-runtime.js";
import { createTestSessionEventStore } from "../../core/tests/test-event-store.js";
import { createTestModelFactory } from "../../core/tests/test-runtime-model.js";

const MCP_TOOL = "mcp__local__ping";
const STATUS_REMINDER = "The following MCP servers are still connecting —";

type WireTool = { name: string; input_schema?: unknown; defer_loading?: boolean };
type Wire = { tools?: WireTool[]; messages: unknown[] };

function mcpStatus(status: McpServerStatus["status"]): McpServerStatus {
  return { status, transport: "stdio", toolCount: 0, updatedAt: "now" };
}

async function toWire(request: ModelRequest): Promise<Wire> {
  let wire: Wire | undefined;
  const provider = createAnthropic({
    apiKey: "test",
    fetch: async (_url, init) => {
      wire = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ error: { type: "invalid_request_error", message: "capture" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    },
  });
  const options = {
    providerKind: "anthropic" as const,
    toolSearchEnabled: request.toolSearchEnabled ?? false,
  };
  await expect(
    generateText({
      model: provider("test"),
      maxRetries: 0,
      headers: toolSearchHeaders(undefined, options.toolSearchEnabled),
      tools: toAiSdkTools(request.tools ?? [], options),
      messages: toAiSdkMessages(request.messages, options),
    }),
  ).rejects.toBeDefined();
  return wire!;
}

async function runWaitThenReady(mode: "local" | "native") {
  const snapshot: Record<string, McpServerToolSnapshot> = {
    local: { status: mcpStatus("connecting") },
  };
  const port: McpPort = {
    connectConfiguredServers: () => new Promise(() => {}),
    connectServer: async () => mcpStatus("connected"),
    disconnectServer: async () => undefined,
    status: async () => ({}),
    listTools: async () => [],
    callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
    close: async () => {},
    getToolSnapshot: () => snapshot,
    // 等待返回时 server 已就绪：本批结果之后的下一次正常请求才应用新列表。
    waitForServer: async () => {
      snapshot.local = {
        status: mcpStatus("connected"),
        tools: [
          {
            serverName: "local",
            toolName: "ping",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        toolsVersion: "c1",
      };
      return { timedOut: false };
    },
  };
  const requests: ModelRequest[] = [];
  const factory = createTestModelFactory({
    async generateText(request) {
      requests.push(request);
      const call = [
        {
          id: "search-1",
          name: "ToolSearch",
          input: { query: `select:${MCP_TOOL}`, max_results: 5 },
        },
        mode === "native"
          ? { id: "ping-1", name: MCP_TOOL, input: {} }
          : { id: "ping-1", name: "DeferredToolCall", input: { name: MCP_TOOL, input: {} } },
      ][requests.length - 1];
      return (
        call
          ? { text: "", finishReason: "tool-calls", usage: {}, toolCalls: [call] }
          : { text: "done", finishReason: "stop", usage: {} }
      ) as never;
    },
  });
  const wrap = (model: Model): Model => ({
    ...model,
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
    bind: (options) => wrap(model.bind(options)),
  });
  const runtime = createTestAgentRuntime(
    createSessionId(`mcp-wait-wire-${mode}`),
    {
      mode: "yolo",
      modelStreaming: "off",
      titleGeneration: { enabled: false },
      toolSearch: { mode },
      mcp: { enabled: true, servers: { local: { type: "stdio", command: "node", args: [] } } },
    },
    {
      eventStore: createTestSessionEventStore(),
      mcpPort: port,
      mcpStartupPolicy: "background",
      modelFactory: (input) => wrap(factory(input)),
    },
  );
  await runtime.executeTurn("needs local");
  await runtime.closeBrowserSession();
  expect(requests).toHaveLength(3);
  return Promise.all(requests.map(toWire));
}

it.each(["local", "native"] as const)(
  "searches pending MCP and calls the ready tool with the expected wire protocol (%s)",
  async (mode) => {
    const [first, second, third] = await runWaitThenReady(mode);
    const names = (wire: Wire) => wire.tools?.map((entry) => entry.name) ?? [];
    for (const wire of [first!, second!, third!]) {
      expect(names(wire)).not.toContain("WaitForMcpServers");
      expect(JSON.stringify(wire.messages)).not.toContain("WaitForMcpServers");
      expect(JSON.stringify(wire.messages)).not.toContain("MCP server status for this request:");
    }
    // Local 的控制工具以 LocalToolSearch 发送；schema 入口不随改名变化。
    expect(
      first!.tools?.find((entry) => entry.name === toolSearchNameForMode(mode))?.input_schema,
    ).toMatchObject({ required: ["query", "max_results"] });
    expect(names(first!)).not.toContain(MCP_TOOL);
    expect(JSON.stringify(first!.messages)).toContain(STATUS_REMINDER);
    const text = JSON.stringify(second!.messages);
    if (mode === "native") {
      expect(second!.tools?.find((entry) => entry.name === MCP_TOOL)?.defer_loading).toBe(true);
      expect(text).toContain(`"tool_name":"${MCP_TOOL}"`);
    } else {
      expect(names(second!)).not.toContain(MCP_TOOL);
      expect(names(second!)).toContain("DeferredToolCall");
      expect(text).toContain("<function>");
      expect(text).toContain(MCP_TOOL);
    }
    expect(JSON.stringify(third!.messages)).toContain("pong");
  },
);

// ToolSearch 关闭时没有连接中公告：WaitForMcpServers 是唯一提示，定义字节固定、发送后保持。
it("offers WaitForMcpServers without ToolSearch and keeps it after the server connects (off)", async () => {
  const snapshot: Record<string, McpServerToolSnapshot> = {
    local: { status: mcpStatus("connecting") },
  };
  const port: McpPort = {
    connectConfiguredServers: () => new Promise(() => {}),
    connectServer: async () => mcpStatus("connected"),
    disconnectServer: async () => undefined,
    status: async () => ({}),
    listTools: async () => [],
    callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
    close: async () => {},
    getToolSnapshot: () => snapshot,
    waitForServer: async () => {
      snapshot.local = {
        status: mcpStatus("connected"),
        tools: [
          {
            serverName: "local",
            toolName: "ping",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        toolsVersion: "c1",
      };
      return { timedOut: false };
    },
  };
  const requests: ModelRequest[] = [];
  const factory = createTestModelFactory({
    async generateText(request) {
      requests.push(request);
      const call = [
        { id: "wait-1", name: "WaitForMcpServers", input: {} },
        { id: "ping-1", name: MCP_TOOL, input: {} },
      ][requests.length - 1];
      return (
        call
          ? { text: "", finishReason: "tool-calls", usage: {}, toolCalls: [call] }
          : { text: "done", finishReason: "stop", usage: {} }
      ) as never;
    },
  });
  const runtime = createTestAgentRuntime(
    createSessionId("mcp-wait-wire-off"),
    {
      mode: "yolo",
      modelStreaming: "off",
      titleGeneration: { enabled: false },
      toolSearch: { mode: "off" },
      mcp: { enabled: true, servers: { local: { type: "stdio", command: "node", args: [] } } },
    },
    {
      eventStore: createTestSessionEventStore(),
      mcpPort: port,
      mcpStartupPolicy: "background",
      modelFactory: factory,
    },
  );
  await runtime.executeTurn("needs local");
  await runtime.closeBrowserSession();
  expect(requests).toHaveLength(3);
  const [first, second, third] = await Promise.all(requests.map(toWire));
  const wait = first!.tools?.find((entry) => entry.name === "WaitForMcpServers") as
    | (WireTool & { description?: string })
    | undefined;
  expect(JSON.stringify(wait?.input_schema)).toBe(
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"servers":{"description":"Server names to wait for (default: all pending)","type":"array","items":{"type":"string"}}},"additionalProperties":false}',
  );
  expect(wait?.description).toMatch(/^Wait for MCP servers that are still connecting/);
  expect(JSON.stringify(first!.messages)).not.toContain(STATUS_REMINDER);
  // 结果按分组逐行给模型；就绪时不是错误结果。
  expect(JSON.stringify(second!.messages)).toContain(
    "ready: true\\nConnected (their tools are now available — call them directly): local",
  );
  expect(JSON.stringify(second!.messages)).not.toContain('"is_error":true');
  // 连上之后 tools 段保留 WaitForMcpServers，只在末尾增加 MCP 工具。
  const names = (wire: Wire) => wire.tools?.map((entry) => entry.name) ?? [];
  expect(names(second!)).toEqual([...names(first!), MCP_TOOL]);
  expect(JSON.stringify(third!.messages)).toContain("pong");
});
