// @vitest-environment node
/**
 * MCP 结果投影：优先模型可见 content，空内容回退 structuredContent。
 *
 * 背景（2026-08-19 产品反馈）：CUA 等成功结果携带 structuredContent: undefined
 * 的空键时，通用 bridge 仍追加 "Structured content:\n"（stringify(undefined)
 * 为空串），模型每次都看到一段无信息量的尾巴。
 *
 * producer 将模型需要的错误恢复详情写入 content，应用读取 structuredContent。
 */
import { describe, expect, it } from "vitest";

import { formatMcpToolResult, registerMcpTools } from "../src/mcp/index.js";
import { createMcpAppProvidedToolEntry } from "../src/mcp/app-tools.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { McpPort } from "@zcode/shared";

describe("formatMcpToolResult structuredContent projection", () => {
  // 最小 mock port（与 mcp-tool-bridge.test.ts 的 createMockMcpPort 同形）；
  // 本用例组只消费 registerMcpTools 的 descriptor→entry 注册，port 不被调用。
  const createMockMcpPort = (): McpPort =>
    ({
      connectConfiguredServers: async () => ({ statuses: {}, tools: [] }),
      connectServer: async () => ({
        status: "connected",
        transport: "stdio",
        toolCount: 1,
        updatedAt: "now",
      }),
      disconnectServer: async () => undefined,
      status: async () => ({}),
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      close: async () => {},
    }) as McpPort;

  function structuredToolEntry(toolName = "structured", serverName = "modern") {
    const registry = createToolRegistry();
    registerMcpTools(registry, createMockMcpPort(), [
      {
        serverName,
        toolName,
        inputSchema: { type: "object" },
      },
    ]);
    return registry.get(`mcp__${serverName}__${toolName}`);
  }

  it("undefined 值不投影（CUA 成功结果空尾巴修复）", () => {
    const entry = structuredToolEntry();
    expect(
      entry?.formatModelContent?.({
        content: [{ type: "text", text: '{"pid":18067}' }],
        structuredContent: undefined,
      }),
    ).toBe('{"pid":18067}');
  });

  it("null / 空对象 / 空数组值同样不投影", () => {
    const entry = structuredToolEntry();
    for (const empty of [null, {}, []]) {
      expect(
        entry?.formatModelContent?.({
          content: [{ type: "text", text: "ok" }],
          structuredContent: empty,
        }),
      ).toBe("ok");
    }
  });

  it("错误结果同样优先 content", () => {
    expect(
      structuredToolEntry()?.formatModelContent?.({
        content: [{ type: "text", text: "blocked" }],
        isError: true,
        structuredContent: { action_sent: true, request_delivery_state: "possibly_sent" },
      }),
    ).toBe("MCP tool returned an error:\nblocked");
  });

  it.each([null, {}, [], false, 0, "result", [1, 2]])(
    "空 content 回退 JSON 值 %j",
    (structuredContent) => {
      expect(
        structuredToolEntry()?.formatModelContent?.({
          content: [{ type: "text", text: "" }],
          structuredContent,
        }),
      ).toBe(`Structured content:\n${JSON.stringify(structuredContent, null, 2)}`);
    },
  );

  describe.each(["tavily_search", "tavily_extract", "lookup_record"])("%s", (toolName) => {
    it.each(["tavily", "custom_search", "plugin_tavily_search"])(
      "同一份 JSON 只投影一次，支持 server 名 %s",
      (serverName) => {
        const structuredContent = {
          results: [{ url: "https://example.com", content: "唯一结果" }],
          response_time: 0.2,
        };
        const text = JSON.stringify(
          {
            response_time: 0.2,
            results: [{ content: "唯一结果", url: "https://example.com" }],
          },
          null,
          2,
        );
        const output = { content: [{ type: "text", text }], structuredContent };
        const original = structuredClone(output);

        expect(structuredToolEntry(toolName, serverName)?.formatModelContent?.(output)).toBe(text);
        expect(output).toEqual(original);
      },
    );

    it.each([
      ["非 JSON", { results: ["完整结果"] }],
      ['{"results":["部分结果"]}', { results: ["完整结果"] }],
      ['{"results":["完整结果"]}', { results: ["完整结果"], failed_results: ["失败"] }],
      ["[2,1]", [1, 2]],
      ['"1"', 1],
    ])("优先 content，无需解析或比较 JSON %s", (text, structuredContent) => {
      const result = structuredToolEntry(toolName)?.formatModelContent?.({
        content: [{ type: "text", text }],
        structuredContent,
      });
      expect(result).toBe(text);
    });

    it.each([[[1, "two"]], ["result"], [false], [0]])("支持 JSON 值 %j", (structuredContent) => {
      const text = JSON.stringify(structuredContent);
      expect(
        structuredToolEntry(toolName)?.formatModelContent?.({
          content: [{ type: "text", text }],
          structuredContent,
        }),
      ).toBe(text);
    });

    it("保留额外说明、图片和资源", () => {
      const structuredContent = { results: ["唯一结果"] };
      const text = JSON.stringify(structuredContent);
      const result = structuredToolEntry(toolName)?.formatModelContent?.({
        content: [
          { type: "text", text: "结果说明" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          { type: "text", text },
          { type: "resource", resource: { uri: "https://example.com", text: "资源" } },
        ],
        structuredContent,
      });
      expect(result).toEqual([
        { type: "text", text: "结果说明" },
        expect.objectContaining({ type: "image" }),
        { type: "text", text },
        { type: "text", text: expect.stringContaining("资源") },
      ]);
    });

    it("保留错误标志与只有 structuredContent 的结果", () => {
      const structuredContent = { error: "quota" };
      const text = JSON.stringify(structuredContent);
      const entry = structuredToolEntry(toolName);
      expect(
        entry?.formatModelContent?.({
          content: [{ type: "text", text }],
          structuredContent,
          isError: true,
        }),
      ).toBe(`MCP tool returned an error:\n${text}`);
      expect(entry?.formatModelContent?.({ content: [], structuredContent })).toBe(
        `Structured content:\n${JSON.stringify(structuredContent, null, 2)}`,
      );
      expect(entry?.formatModelContent?.({ content: [{ type: "text", text }] })).toBe(text);
    });
  });

  it("公共投影优先模型可见 content", () => {
    const structuredContent = { records: [{ id: 1 }] };
    const text = JSON.stringify(structuredContent);
    expect(formatMcpToolResult({ content: [{ type: "text", text }], structuredContent })).toBe(
      text,
    );
  });

  it("MCP Apps app-provided 工具复用公共选择规则", () => {
    const structuredContent = { records: [{ id: 1 }] };
    const text = JSON.stringify(structuredContent);
    const entry = createMcpAppProvidedToolEntry(
      {
        modelName: "app__records__lookup",
        serverName: "records",
        pluginId: "records",
        scopeId: "scope",
        generation: 1,
        toolName: "lookup",
        inputSchema: { type: "object" },
      },
      async () => ({ content: [] }),
    );
    expect(
      entry.formatModelContent?.({ content: [{ type: "text", text }], structuredContent }),
    ).toBe(text);
  });
});
