import { expect, it } from "vitest";
import type { ModelToolContract } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../src/agent/message-history.js";
import { createToolRegistry } from "../../src/tool/registry.js";
import { toolSearchToolEntry } from "../../src/tool/handlers/tool-search.js";
import { webFetchToolEntry } from "../../src/tool/handlers/webfetch.js";
import { buildToolExposure } from "../../src/tool/search/exposure.js";
import { compactToolSearchDelivery } from "../../src/tool/search/history.js";
import { createTestRuntimeModel } from "../test-runtime-model.js";

const SCHEMA_A = { type: "object", properties: { text: { type: "string" } } } as const;
const SCHEMA_B = { type: "object", properties: { text: { type: "number" } } } as const;

function mcpTool(server: string, tool: string, resident: boolean, inputSchema: object = SCHEMA_A) {
  return {
    ...webFetchToolEntry,
    inputSchema,
    metadata: {
      ...webFetchToolEntry.metadata,
      name: `mcp__${server}__${tool}`,
      description: `${server} ${tool} tool`,
      ...(resident ? { alwaysLoad: true } : {}),
      mcpPresentation: { serverName: server, toolName: tool },
    },
  } as typeof webFetchToolEntry;
}

function fixture() {
  const registry = createToolRegistry();
  registry.register(toolSearchToolEntry);
  registry.register({
    ...webFetchToolEntry,
    metadata: { ...webFetchToolEntry.metadata, name: "Write", shouldDefer: false },
  });
  for (const entry of [
    mcpTool("def", "bye", false),
    mcpTool("def", "echo", false),
    mcpTool("res", "bye", true),
    mcpTool("res", "ping", true),
  ])
    registry.register(entry);
  const model = createModel();
  const entries: RuntimeMessageEntry[] = [];
  const exposure = () =>
    buildToolExposure({ model, mode: "native", registry, tools: registry.toContracts(), entries });
  /** 模拟一次请求成功提交：交付增量写入历史。 */
  const send = () => {
    const result = exposure();
    entries.push({
      message: { role: "assistant", content: "ok" },
      toolSearchDelivery: result.delivery,
    });
    return result;
  };
  const reference = (...names: string[]) =>
    entries.push({
      message: {
        role: "tool",
        toolCallId: "search",
        toolName: "ToolSearch",
        content: names.map((toolName) => ({ type: "tool_reference" as const, toolName })),
      },
    });
  return { model, registry, entries, exposure, send, reference };
}

const wire = (tools: readonly ModelToolContract[]) =>
  tools.map((tool) => `${tool.name}${tool.deferLoading ? "(d)" : ""}`);

it("freezes a resident MCP definition at its first delivery", () => {
  const { registry, send } = fixture();
  send();
  registry.unregister("mcp__res__ping");
  registry.register(mcpTool("res", "ping", true, SCHEMA_B));
  const next = send();
  // 修复前 schema 变化后发送 live 定义并重新记录，已发送的工具字节随之改变。
  expect(next.tools.find((tool) => tool.name === "mcp__res__ping")?.inputSchema).toEqual(SCHEMA_A);
  expect(next.delivery).toBeUndefined();
});

it("re-declares departed resident tools after the previous present tool", () => {
  const { registry, send, reference } = fixture();
  send();
  reference("mcp__def__bye", "mcp__def__echo");
  const before = send();
  expect(wire(before.tools)).toEqual([
    "ToolSearch",
    "Write",
    "mcp__def__bye(d)",
    "mcp__def__echo(d)",
    "mcp__res__bye",
    "mcp__res__ping",
  ]);
  registry.unregister("mcp__res__bye");
  registry.unregister("mcp__res__ping");
  const after = send();
  // 修复前离开的常驻工具从请求中消失；现在按记录顺序放回第一个 MCP 工具之前，定义字节不变。
  expect(wire(after.tools)).toEqual([
    "ToolSearch",
    "Write",
    "mcp__res__bye",
    "mcp__res__ping",
    "mcp__def__bye(d)",
    "mcp__def__echo(d)",
  ]);
  // provider 只发送这些字段；重新声明的定义与离开前发送的字节相同。
  const sent = (tools: readonly ModelToolContract[], name: string) => {
    const tool = tools.find((item) => item.name === name)!;
    return JSON.stringify([
      tool.name,
      tool.description,
      tool.inputSchema,
      tool.strict,
      tool.deferLoading,
    ]);
  };
  for (const name of ["mcp__res__bye", "mcp__res__ping"])
    expect(sent(after.tools, name)).toBe(sent(before.tools, name));
  expect(wire(send().tools)).toEqual(wire(after.tools));
});

it("does not re-declare a resident tool that is only filtered from this request", () => {
  const { registry, entries, send } = fixture();
  send();
  const scoped = buildToolExposure({
    model: createModel(),
    mode: "native",
    registry,
    tools: registry.toContracts().filter((tool) => tool.name !== "mcp__res__ping"),
    entries,
  });
  expect(wire(scoped.tools)).not.toContain("mcp__res__ping");
});

it("records deferred definitions only for referenced tools", () => {
  const { entries, exposure } = fixture();
  // compact 携带的名称没有引用：照常以 defer_loading 发送，但不是已交付定义。
  entries.push({
    message: { role: "user", content: "summary" },
    metadata: {
      compactBoundary: { boundaryId: "boundary", preCompactDiscoveredTools: ["mcp__def__echo"] },
    },
  });
  const result = exposure();
  expect(wire(result.tools)).toContain("mcp__def__echo(d)");
  expect(result.delivery?.definitions.map((item) => item.tool.name)).toEqual([
    "mcp__res__bye",
    "mcp__res__ping",
  ]);
});

it("carries departed resident records through compact unless they were revoked", () => {
  const { registry, entries, send } = fixture();
  send();
  registry.unregister("mcp__res__bye");
  registry.unregister("mcp__res__ping");
  entries.push({
    kind: "attachment",
    content: "",
    metadata: {
      source: "tool_search_announcement",
      toolSearchAnnouncement: { addedNames: [], removedNames: [], readdedNames: [] },
      toolSearchMcpDelta: { retractedTools: [{ name: "mcp__res__bye", cause: "disabled" }] },
    },
  } as RuntimeMessageEntry);
  const carried = compactToolSearchDelivery(
    entries,
    [],
    (name) => registry.get(name) !== undefined,
  );
  // 已撤销的不再携带；未撤销的离开工具跨 compact 继续原位声明；仍在目录中的按 live 定义重新记录。
  expect(carried?.definitions.map((item) => item.tool.name)).toEqual(["mcp__res__ping"]);
});

function createModel() {
  return {
    ...createTestRuntimeModel({
      generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
    }),
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
  };
}
