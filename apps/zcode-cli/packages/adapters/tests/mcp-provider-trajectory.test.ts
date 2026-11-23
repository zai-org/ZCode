import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { expect, it } from "vitest";
import type { McpConfigurationSnapshot, McpServerToolSnapshot } from "@zcode/contracts";
import { toAiSdkMessages } from "../src/model/transform.js";
import { toAiSdkTools } from "../src/model/tool-transform.js";
import { toolSearchHeaders } from "../src/model/tool-search.js";
import {
  createRuntime,
  mcpStatus,
  stdioServer,
  tool,
} from "../../core/tests/mcp-runtime-fixture.js";
import expected from "../../core/tests/tool-search/provider-diagnostics.json";

it("preserves the complete native wire trajectory through ready, delivery, removal and restoration", async () => {
  const bodies: Array<{
    tools: Record<string, unknown>[];
    messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
  }> = [];
  const provider = createAnthropic({
    apiKey: "test",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ error: { type: "invalid_request_error", message: "capture" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    },
  });
  const name = "mcp__demo__ping";
  const snapshot: Record<string, McpServerToolSnapshot> = {
    demo: { status: mcpStatus("connecting") },
  };
  let configuration: McpConfigurationSnapshot = { enabled: true, servers: { demo: stdioServer() } };
  let changed = () => {};
  const { runtime } = createRuntime({
    label: "native-wire",
    snapshot,
    toolSearchMode: "native",
    toolAllowlist: ["ToolSearch", name],
    mcpConfigurationSource: {
      getSnapshot: () => configuration,
      subscribe: (listener) => {
        changed = listener;
        return () => {};
      },
      close() {},
    },
    respond: async (request, index) => {
      const options = {
        providerKind: "anthropic" as const,
        toolSearchEnabled: request.toolSearchEnabled,
      };
      await expect(
        generateText({
          model: provider("claude-opus-5-5"),
          maxRetries: 0,
          headers: toolSearchHeaders(undefined, request.toolSearchEnabled),
          tools: toAiSdkTools(request.tools, options),
          messages: toAiSdkMessages(request.messages, options),
        }),
      ).rejects.toBeDefined();
      if (index === 0) {
        snapshot.demo = {
          status: mcpStatus("connected"),
          tools: [{ ...tool("demo", "ping"), description: "Ping service" }],
          toolsVersion: "1",
        };
        return {
          text: "",
          finishReason: "tool-calls",
          usage: {},
          toolCalls: [
            {
              id: "search",
              name: "ToolSearch",
              input: { query: `select:${name}`, max_results: 5 },
            },
          ],
        };
      }
      return undefined;
    },
  });
  try {
    await runtime.executeTurn("find ping");
    expect(bodies[0]!.tools.map((tool) => tool.name)).toEqual(["ToolSearch"]);
    const pending = bodies[0]!.messages
      .flatMap((message) => message.content.map((block) => ({ role: message.role, ...block })))
      .find((block) => String(block.text).includes("still connecting"));
    expect(pending).toEqual({
      role: "user",
      type: "text",
      text: `<system-reminder>\n${expected.pending}\n</system-reminder>`,
    });
    const loaded = bodies[1]!.tools.find((tool) => tool.name === name);
    expect(loaded).toEqual({
      name,
      description: "Ping service",
      input_schema: { type: "object", properties: {} },
      defer_loading: true,
    });
    const result = bodies[1]!.messages
      .flatMap((message) => message.content.map((block) => ({ role: message.role, ...block })))
      .find((block) => block.type === "tool_result");
    expect(result).toEqual({
      role: "user",
      type: "tool_result",
      tool_use_id: "search",
      content: [{ type: "tool_reference", tool_name: name }],
    });
    configuration = { enabled: true, servers: {} };
    delete snapshot.demo;
    changed();
    await runtime.executeTurn("removed");
    const removed = bodies.at(-1)!;
    expect(removed.tools.find((tool) => tool.name === name)).toEqual(loaded);
    const withdrawal = removed.messages
      .flatMap((message) => message.content.map((block) => ({ role: message.role, ...block })))
      .find((block) => String(block.text).includes("Disregard those definitions"));
    // 撤销提醒紧挨用户输入，合并相邻 user 内容时以换行结尾。
    expect(withdrawal).toEqual({
      role: "user",
      type: "text",
      text: `<system-reminder>\n${expected.retract}\n</system-reminder>\n`,
    });
    expect(removed.tools.map((tool) => tool.name)).toEqual([name, "ToolSearch"]);
    configuration = { enabled: true, servers: { demo: stdioServer() } };
    snapshot.demo = {
      status: mcpStatus("connected"),
      tools: [{ ...tool("demo", "ping"), description: "New live definition" }],
      toolsVersion: "2",
    };
    changed();
    await runtime.executeTurn("restored");
    expect(bodies.at(-1)!.tools.find((tool) => tool.name === name)).toEqual(loaded);
    expect(JSON.stringify(bodies.at(-1)!.messages)).toContain(
      "1 deferred tool is available again (MCP server reconnected — names announced earlier in this conversation): mcp__demo__*. Load via ToolSearch as before.",
    );
  } finally {
    runtime.beginShutdown();
  }
});
