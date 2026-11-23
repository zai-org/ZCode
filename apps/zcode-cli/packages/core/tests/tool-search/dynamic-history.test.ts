import { expect, it } from "vitest";
import { ToolSearchDeliverySchema } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../src/agent/message-history.js";
import { createToolRegistry } from "../../src/tool/registry.js";
import { toolSearchToolEntry } from "../../src/tool/handlers/tool-search.js";
import { todoReadToolEntry } from "../../src/tool/handlers/todo.js";
import { buildToolExposure, buildToolSearchAnnouncement } from "../../src/tool/search/exposure.js";
import { createTestRuntimeModel } from "../test-runtime-model.js";
import {
  compactToolSearchDelivery,
  collectToolSearchDelivery,
} from "../../src/tool/search/history.js";
import expected from "./provider-diagnostics.json";

function fixture() {
  const registry = createToolRegistry();
  registry.register(toolSearchToolEntry);
  registry.register(todoReadToolEntry);
  const model = {
    ...createTestRuntimeModel({
      generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
    }),
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
  };
  const entries: RuntimeMessageEntry[] = [
    {
      message: {
        role: "tool",
        toolCallId: "search",
        toolName: "ToolSearch",
        content: [{ type: "tool_reference", toolName: "TodoRead" }],
      },
    },
  ];
  const input = {
    model,
    mode: "native" as const,
    registry,
    tools: registry.toContracts(),
    entries,
  };
  return { input, registry, entries };
}

it("keeps delivered definitions after removal without restoring the execution catalog", () => {
  const { input, registry, entries } = fixture();
  const first = buildToolExposure(input);
  expect(first.delivery?.definitions).toHaveLength(1);
  entries.push({
    message: { role: "assistant", content: "loaded" },
    toolSearchDelivery: first.delivery,
  });
  registry.unregister("TodoRead");
  const next = buildToolExposure({ ...input, tools: registry.toContracts() });
  expect(next.enabled).toBe(true);
  expect(next.tools.map((tool) => tool.name)).toEqual(["TodoRead", "ToolSearch"]);
  expect(next.tools.find((tool) => tool.name === "TodoRead")).toEqual({
    ...first.delivery!.definitions[0]!.tool,
    deferLoading: true,
  });
  expect(next.context.catalog.map((tool) => tool.name)).not.toContain("TodoRead");
  expect(next.entries[0]).toEqual(entries[0]);
  expect(next.delivery).toBeUndefined();
});

it("carries only definitions and stripped references still present after compact", () => {
  const { input, entries } = fixture();
  const first = buildToolExposure(input);
  const committed: RuntimeMessageEntry = {
    message: { role: "assistant", content: "loaded" },
    toolSearchDelivery: first.delivery,
  };
  entries.push(committed);
  expect(compactToolSearchDelivery(entries, [])).toBeUndefined();
  const carried = compactToolSearchDelivery(entries, entries.slice(0, 1));
  expect(carried).toEqual(first.delivery);
  const summary: RuntimeMessageEntry = {
    message: { role: "user", content: "summary" },
    toolSearchDelivery: carried,
  };
  expect(collectToolSearchDelivery([summary, entries[0]!]).retained.size).toBe(1);
  // rewind/fork 必须只由选中分支恢复；被裁掉的 assistant 不能给旧引用补交付事实。
  expect(collectToolSearchDelivery(entries.slice(0, 1)).retained.size).toBe(0);
});

it("renders exact retraction and resident restoration only for delivered definitions", () => {
  const { input, registry } = fixture();
  registry.unregister("TodoRead");
  const name = "mcp__demo__ping";
  registry.register({
    ...todoReadToolEntry,
    metadata: {
      ...todoReadToolEntry.metadata,
      name,
      mcpPresentation: {
        serverName: "demo",
        toolName: "ping",
        description: "Ping service",
        official: true,
        pluginId: "demo-plugin",
      },
    },
  });
  const entries: RuntimeMessageEntry[] = [];
  const current = () => ({
    ...input,
    entries,
    tools: registry.toContracts(),
    mcp: { pending: [], failed: [], sources: { demo: "connected" as const } },
  });
  entries.push(buildToolSearchAnnouncement(current())!);
  entries.push({
    message: {
      role: "tool",
      toolCallId: "load",
      toolName: "ToolSearch",
      content: [{ type: "tool_reference", toolName: name }],
    },
  });
  const delivered = buildToolExposure(current()).delivery;
  expect(ToolSearchDeliverySchema.safeParse(delivered).success).toBe(true);
  expect(delivered?.definitions[0]?.mcp).toEqual({ serverName: "demo", toolName: "ping" });
  entries.push({
    message: { role: "assistant", content: "loaded" },
    toolSearchDelivery: delivered,
  });
  registry.unregister(name);
  const removed = buildToolSearchAnnouncement({
    ...current(),
    mcp: { pending: [], failed: [], sources: {} },
  })!;
  expect(removed.content).toBe(expected.retract);
  entries.push(removed);
  registry.register({
    ...todoReadToolEntry,
    metadata: { ...todoReadToolEntry.metadata, name, alwaysLoad: true },
  });
  expect(buildToolSearchAnnouncement(current())?.content).toBe(expected.restore);
});

it("pins a delivered schema while execution definitions change and keeps projection pure", () => {
  const { input, entries } = fixture();
  const first = buildToolExposure(input);
  expect(first.delivery).toBeDefined();
  entries.push({
    message: { role: "assistant", content: "loaded" },
    toolSearchDelivery: first.delivery,
  });
  const before = structuredClone(entries);
  const changed = input.tools.map((tool) =>
    tool.name === "TodoRead" ? { ...tool, description: "changed" } : tool,
  );
  expect(buildToolExposure({ ...input, tools: changed }).tools).toEqual(first.tools);
  expect(entries).toEqual(before);
});

it("does not resurrect a reference stripped before its definition was delivered", () => {
  const { input, entries } = fixture();
  const absent = buildToolExposure({
    ...input,
    tools: input.tools.filter((tool) => tool.name !== "TodoRead"),
  });
  expect(absent.delivery?.strippedReferences).toEqual([
    { toolCallId: "search", toolName: "TodoRead" },
  ]);
  entries.push({
    message: { role: "assistant", content: "missing" },
    toolSearchDelivery: absent.delivery,
  });
  const restored = buildToolExposure(input);
  expect(JSON.stringify(restored.entries)).not.toContain('"type":"tool_reference"');
});

it("repeats current pending facts when a name delta is generated, then deduplicates", () => {
  const { input } = fixture();
  const mcp = { pending: ["service"], failed: [] };
  const first = buildToolSearchAnnouncement({ ...input, entries: [], mcp })!;
  const next = buildToolSearchAnnouncement({
    ...input,
    entries: [first],
    tools: input.tools.filter((tool) => tool.name !== "TodoRead"),
    mcp,
  })!;
  expect(next.content).toContain("The following MCP servers are still connecting —");
  expect(
    buildToolSearchAnnouncement({
      ...input,
      entries: [first, next],
      tools: input.tools.filter((tool) => tool.name !== "TodoRead"),
      mcp,
    }),
  ).toBeUndefined();
});

// 本轮隐藏按中性文案公告，并记下名称；之后真正离开目录才写"会话内不可用"。
it("keeps the neutral text while a name is only hidden, then announces the departure", () => {
  const { input, registry } = fixture();
  const first = buildToolSearchAnnouncement({ ...input, entries: [] })!;
  const scoped = { ...input, tools: input.tools.filter((tool) => tool.name !== "TodoRead") };
  const hidden = buildToolSearchAnnouncement({ ...scoped, entries: [first] })!;
  expect(hidden.content).toContain("The following deferred tools are no longer available.");
  expect(hidden.metadata?.toolSearchHiddenNames).toEqual(["TodoRead"]);
  registry.unregister("TodoRead");
  expect(buildToolSearchAnnouncement({ ...scoped, entries: [first, hidden] })).toBeUndefined();
});

it("does not announce internal source or permission index changes", () => {
  const { input } = fixture();
  const tools = input.tools.filter((tool) => tool.name === "ToolSearch");
  const mcp = { pending: [], failed: [], sources: { demo: "connected" as const } };
  expect(buildToolSearchAnnouncement({ ...input, tools, entries: [], mcp })).toBeUndefined();
  const failed = { ...mcp, failed: [{ name: "broken", error: "refused" }] };
  const first = buildToolSearchAnnouncement({ ...input, tools, entries: [], mcp: failed })!;
  expect(
    buildToolSearchAnnouncement({
      ...input,
      tools,
      entries: [first],
      mcp: { ...failed, sources: {}, deniedTools: ["never-loaded"] },
    }),
  ).toBeUndefined();
});

it("compact rebuilds names without replaying transient connection status", () => {
  const { input } = fixture();
  const notice = buildToolSearchAnnouncement(
    {
      ...input,
      entries: [],
      mcp: { pending: ["waiting"], failed: [{ name: "broken", error: "refused" }] },
    },
    new Set(),
  );
  expect(notice?.content).toContain("TodoRead");
  expect(notice?.content).not.toMatch(/still connecting|failed to connect/);
});

it("compact keeps the status facts of the preserved tail instead of resetting them", () => {
  const { input } = fixture();
  const mcp = { pending: ["waiting"], failed: [] };
  const names = buildToolSearchAnnouncement({ ...input, entries: [] })!;
  const status = buildToolSearchAnnouncement({ ...input, entries: [names], mcp })!;
  // 名称公告已被摘要，保留段只剩状态公告；compact 重建名称但不写状态。
  const notice = buildToolSearchAnnouncement({ ...input, entries: [status], mcp }, new Set())!;
  expect(notice.content).toContain("TodoRead");
  expect(notice.metadata.toolSearchMcpDelta?.mcp).toBeUndefined();
  // 修复前 compact 写入空状态，下一次采集把仍在连接的 server 当作新事件再次公告。
  expect(buildToolSearchAnnouncement({ ...input, entries: [status, notice], mcp })).toBeUndefined();
});

it("announces authorization changes once", () => {
  const { input } = fixture();
  const names = buildToolSearchAnnouncement({ ...input, entries: [] })!;
  const mcp = { pending: [], needsAuth: ["locked"], failed: [] };
  const first = buildToolSearchAnnouncement({ ...input, entries: [names], mcp })!;
  expect(first.content).toContain(
    "The following MCP servers require authentication before their tools can be used:\nlocked",
  );
  expect(first.metadata.toolSearchMcpDelta?.mcp).toEqual(mcp);
  expect(buildToolSearchAnnouncement({ ...input, entries: [names, first], mcp })).toBeUndefined();
  const cleared = buildToolSearchAnnouncement({
    ...input,
    entries: [names, first],
    mcp: { pending: [], failed: [] },
  });
  expect(cleared?.metadata.toolSearchMcpDelta?.mcp).toEqual({ pending: [], failed: [] });
});

it("does not announce while the control tool is unavailable and keeps sent announcements", () => {
  const { input } = fixture();
  const withSearch = input.tools;
  const withoutSearch = withSearch.filter((tool) => tool.name !== "ToolSearch");
  const entries: RuntimeMessageEntry[] = [{ message: { role: "user", content: "one" } }];
  entries.push(buildToolSearchAnnouncement({ ...input, tools: withSearch, entries })!);
  const project = (tools: typeof withSearch) =>
    JSON.stringify(buildToolExposure({ ...input, tools, entries }).entries.slice(0, 2));
  const sent = project(withSearch);
  // 控制工具暂时不在请求中：不生成新公告，已发送的公告照常投影。
  expect(
    buildToolSearchAnnouncement({
      ...input,
      tools: withoutSearch,
      entries,
      mcp: { pending: ["waiting"], failed: [] },
    }),
  ).toBeUndefined();
  expect(project(withoutSearch)).toBe(sent);
  expect(project(withSearch)).toBe(sent);
});

it("records resident MCP delivery for retraction without retaining a deferred reference", () => {
  const { input, registry } = fixture();
  registry.unregister("TodoRead");
  const name = "mcp__demo__resident";
  registry.register({
    ...todoReadToolEntry,
    metadata: {
      ...todoReadToolEntry.metadata,
      name,
      alwaysLoad: true,
      mcpPresentation: { serverName: "demo", toolName: "resident" },
    },
  });
  const exposed = buildToolExposure({ ...input, tools: registry.toContracts(), entries: [] });
  expect(exposed.tools.some((tool) => tool.name === name)).toBe(true);
  expect(exposed.delivery?.definitions.map((item) => item.tool.name)).toEqual([name]);
  const entries: RuntimeMessageEntry[] = [
    { message: { role: "assistant", content: "seen" }, toolSearchDelivery: exposed.delivery },
  ];
  registry.unregister(name);
  const current = {
    ...input,
    tools: registry.toContracts(),
    entries,
    mcp: { pending: [], failed: [], sources: {} },
  };
  expect(buildToolSearchAnnouncement(current)?.content).toContain("Disregard those definitions");
  expect(buildToolExposure(current).enabled).toBe(false);
  expect(collectToolSearchDelivery(entries).retained.size).toBe(0);
  expect(compactToolSearchDelivery(entries, [])).toBeUndefined();
});

it.each([false, true])(
  "does not redeliver unchanged definitions after JSON restore (MCP=%s)",
  (mcp) => {
    const { input, entries, registry } = fixture();
    if (mcp) {
      registry.unregister("TodoRead");
      registry.register({
        ...todoReadToolEntry,
        metadata: {
          ...todoReadToolEntry.metadata,
          mcpPresentation: { serverName: "demo", toolName: "fetch" },
        },
      });
    }
    const tools = registry.toContracts().map(({ description, ...tool }) => tool);
    const first = buildToolExposure({ ...input, tools });
    entries.push({
      message: { role: "assistant", content: "loaded" },
      toolSearchDelivery: first.delivery,
    });
    const next = buildToolExposure({
      ...input,
      tools,
      entries: JSON.parse(JSON.stringify(entries)),
    });
    expect(next.delivery).toBeUndefined();
    expect(JSON.parse(JSON.stringify(next.tools))).toEqual(JSON.parse(JSON.stringify(first.tools)));
    expect(next.entries.map((e) => e.message)).toEqual(entries.map((e) => e.message));
  },
);
