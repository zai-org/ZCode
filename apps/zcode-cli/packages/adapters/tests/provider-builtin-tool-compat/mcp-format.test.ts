import { describe, expect, it } from "vitest";
import {
  PROVIDER_BUILTIN_TOOL_SERVER_NAME,
  rewriteProviderBuiltinToolContent,
} from "../../src/model/provider-builtin-tool-compat/contract.js";
import { deltaTexts, run, serverToolUse, textBlock } from "./stream-test-helpers.js";

// 新格式：服务端直接下发 mcp_tool_use / mcp_tool_result，结果摘要在结果之后。
// 旧格式契约见 contract.test.ts；经 Runtime 的端到端见 ../provider-builtin-tool-rounds.test.ts。
describe("provider-builtin-tool-compat upstream MCP format", () => {
  /** serverName 为 null 时不带 server_name（线上漏发的形态）。 */
  const mcpToolUseBlock = (
    id = "call_1",
    serverName: string | null = "4_5v_mcp",
    name = "analyze_image",
  ) => ({
    type: "mcp_tool_use",
    id,
    name,
    ...(serverName === null ? {} : { server_name: serverName }),
    input: {},
  });
  const mcpToolResultBlock = (id = "call_1", isError = false) => ({
    type: "mcp_tool_result",
    tool_use_id: id,
    content: [{ type: "text", text: "ok" }],
    is_error: isError,
  });
  const mcpToolUse = (
    index: number,
    id = "call_1",
    serverName: string | null = "4_5v_mcp",
    name = "analyze_image",
  ) => [
    { type: "content_block_start", index, content_block: mcpToolUseBlock(id, serverName, name) },
    { type: "content_block_stop", index },
  ];
  const mcpToolResult = (index: number, id = "call_1", isError = false) => [
    { type: "content_block_start", index, content_block: mcpToolResultBlock(id, isError) },
    { type: "content_block_stop", index },
  ];
  /** 服务端渲染的结果摘要：真实流与服务端文档示例都是这个形态。 */
  const summary = (toolName: string, body = "ok") =>
    `**Output:**\n**${toolName}_result_summary:** ${body}`;

  it("passes upstream MCP blocks through and drops their rendered copies", () => {
    const output = run([
      ...textBlock(0, "**🌐 Built-in Tool: analyze_image**"),
      ...mcpToolUse(1),
      ...mcpToolResult(2),
      ...textBlock(3, summary("analyze_image")),
      ...textBlock(4, "答案"),
    ]);
    expect(output).toEqual([...mcpToolUse(1), ...mcpToolResult(2), ...textBlock(4, "答案")]);
  });

  it("drops the rendered copies around parallel upstream MCP calls", () => {
    // 服务端文档示例：两个调用在前、两个结果在后，按 id 配对，展示文本夹在中间；摘要标签按各自的调用确认。
    const output = run([
      ...textBlock(0, "**🌐 Built-in Tool: analyze_image**"),
      ...mcpToolUse(1, "call_1"),
      ...textBlock(2, "**🌐 Built-in Tool: webReader**"),
      ...mcpToolUse(3, "call_2", "web_reader", "webReader"),
      ...mcpToolResult(4, "call_1"),
      ...textBlock(5, summary("analyze_image", "first")),
      ...mcpToolResult(6, "call_2", true),
      ...textBlock(7, summary("webReader", "MCP error 400")),
      ...textBlock(8, "答案"),
    ]);
    expect(output).toEqual([
      ...mcpToolUse(1, "call_1"),
      ...mcpToolUse(3, "call_2", "web_reader", "webReader"),
      ...mcpToolResult(4, "call_1"),
      ...mcpToolResult(6, "call_2", true),
      ...textBlock(8, "答案"),
    ]);
  });

  it("drops a summary whose prefix and label arrive split across deltas", () => {
    const output = run([
      ...mcpToolUse(0),
      ...mcpToolResult(1),
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "**Out" } },
      { type: "ping" },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: "put:**\n**analyze_image_res" },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: "ult_summary:** ok" },
      },
      { type: "content_block_stop", index: 2 },
    ]);
    expect(deltaTexts(output)).toEqual([]);
  });

  it("drops the next call header when a result arrives without its summary", () => {
    // 与旧格式对齐：结果后直接接下一个调用时，紧跟结果的调用头也是副本。
    const output = run([
      ...textBlock(0, "**🌐 Built-in Tool: analyze_image**"),
      ...mcpToolUse(1, "call_1"),
      ...mcpToolResult(2, "call_1"),
      ...textBlock(3, "**🌐 Built-in Tool: webReader**"),
      ...mcpToolUse(4, "call_2"),
      ...mcpToolResult(5, "call_2"),
      ...textBlock(6, "答案"),
    ]);
    expect(output).toEqual([
      ...mcpToolUse(1, "call_1"),
      ...mcpToolResult(2, "call_1"),
      ...mcpToolUse(4, "call_2"),
      ...mcpToolResult(5, "call_2"),
      ...textBlock(6, "答案"),
    ]);
  });

  it.each([
    [
      "a bold answer after the paired result",
      [...mcpToolUse(0), ...mcpToolResult(1)],
      "**结论：** 图片包含一辆红色汽车",
    ],
    ["summary-like text before any result", mcpToolUse(0), "**Output:** copy"],
    // 紧跟结果、像调用头的文字，后面没有调用就不是副本。
    [
      "header-like text after the result with no call after it",
      [...mcpToolUse(0), ...mcpToolResult(1)],
      "**🌐 正文",
    ],
    // 评审 CR-01：服务端没发摘要时，模型以 **Output:** 开头的回答紧跟结果，不能被整块删掉。
    [
      "a model answer labelled **Output:** after the paired result",
      [...mcpToolUse(0), ...mcpToolResult(1)],
      "**Output:** 正常最终回答",
    ],
    [
      "a model answer labelled **Output:** after an error result",
      [...mcpToolUse(0), ...mcpToolResult(1, "call_1", true)],
      "**Output:** 正常最终回答",
    ],
    [
      "a summary labelled for a different tool",
      [...mcpToolUse(0), ...mcpToolResult(1)],
      summary("webReader"),
    ],
  ])("keeps %s", (_label, before, answer) => {
    // 摘要后面没有结构块可确认：只有紧跟配对结果、带配对调用摘要标签的整块才算副本。
    const output = run([...before, ...textBlock(2, answer)]);
    expect(deltaTexts(output)).toEqual([answer]);
  });

  it("keeps a model answer labelled **Output:** that arrives split across deltas", () => {
    const deltas = ["**Out", "put:** 正常", "最终回答"];
    const output = run([
      ...mcpToolUse(0),
      ...mcpToolResult(1),
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
      ...deltas.map((text) => ({
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text },
      })),
      { type: "content_block_stop", index: 2 },
      ...textBlock(3, "补充"),
    ]);
    // 整块收完就放行，不等下一个块，顺序不变。
    expect(deltaTexts(output)).toEqual([...deltas, "补充"]);
  });

  it("keeps a summary the stream cut off before its block stopped", () => {
    // 断流时还没确认的缓冲帧由 finish 补发，不吞内容。
    const output = run([
      ...mcpToolUse(0),
      ...mcpToolResult(1),
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: "**Output:** partial" },
      },
    ]);
    expect(deltaTexts(output)).toEqual(["**Output:** partial"]);
  });

  it("fills in a missing server_name on an upstream MCP call", () => {
    // 2026-11-05 线上漏发 server_name：AI SDK schema 要求它是字符串，缺失时整轮报错。
    expect(run(mcpToolUse(0, "call_1", null))).toEqual(
      mcpToolUse(0, "call_1", PROVIDER_BUILTIN_TOOL_SERVER_NAME),
    );
    expect(rewriteProviderBuiltinToolContent([mcpToolUseBlock("call_1", null)])).toEqual({
      changed: true,
      content: [mcpToolUseBlock("call_1", PROVIDER_BUILTIN_TOOL_SERVER_NAME)],
    });
  });

  it("drops an MCP result that no call in the message paired", () => {
    // AI SDK 按 tool_use_id 直接取调用记录，取不到会抛 TypeError，整条流失败。
    const output = run([
      ...mcpToolUse(0),
      { type: "content_block_start", index: 1, content_block: mcpToolResultBlock("call_other") },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "stray" } },
      { type: "content_block_stop", index: 1 },
      ...textBlock(2, "答案"),
    ]);
    expect(output).toEqual([...mcpToolUse(0), ...textBlock(2, "答案")]);

    expect(
      rewriteProviderBuiltinToolContent([
        mcpToolUseBlock(),
        mcpToolResultBlock("call_other"),
        { type: "text", text: "答案" },
      ]),
    ).toEqual({ changed: true, content: [mcpToolUseBlock(), { type: "text", text: "答案" }] });
  });

  it("pairs calls and results across the two formats within one message", () => {
    // 服务端半迁移时可能混出：旧格式调用配新格式结果，新格式调用配旧格式裸结果，都不能当成未配对丢掉。
    const output = run([
      ...serverToolUse(0),
      ...mcpToolResult(1, "call_1"),
      ...mcpToolUse(2, "call_2"),
      {
        type: "content_block_start",
        index: 3,
        content_block: { type: "tool_result", tool_use_id: "call_2", content: "ok" },
      },
      { type: "content_block_stop", index: 3 },
    ]);
    expect(
      output
        .filter((event) => event.type === "content_block_start")
        .map((event) => event.content_block),
    ).toEqual([
      expect.objectContaining({ type: "mcp_tool_use", id: "call_1" }),
      mcpToolResultBlock("call_1"),
      mcpToolUseBlock("call_2"),
      expect.objectContaining({ type: "mcp_tool_result", tool_use_id: "call_2" }),
    ]);
  });

  it("leaves upstream MCP blocks untouched in non-streaming content", () => {
    // 服务端文档：非流式响应没有展示文本，原生块原样透传。
    const content = [mcpToolUseBlock(), mcpToolResultBlock(), { type: "text", text: "答案" }];
    expect(rewriteProviderBuiltinToolContent(content)).toEqual({ changed: false, content });
  });
});
