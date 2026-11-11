import { describe, expect, it } from "vitest";
import { type Model, type ModelToolContract } from "@zcode/contracts";
import { createTestRuntimeModel } from "./test-runtime-model.js";
import { buildToolExposure, buildToolSearchAnnouncement } from "../src/tool/search/exposure.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { deferredToolCallEntry } from "../src/tool/handlers/deferred-tool-call.js";
import { taskOutputToolEntry } from "../src/tool/handlers/task-output.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { todoReadToolEntry } from "../src/tool/handlers/todo.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { collectDiscoveredTools, parseToolSearchHiddenNames } from "../src/tool/search/history.js";

const model = (enabled: boolean): Model => ({
  ...createTestRuntimeModel({
    generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
  }),
  requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: enabled } },
});

it("keeps enabled search call/result pairing when every reference in a result becomes unavailable", () => {
  const registry = createToolRegistry();
  [toolSearchToolEntry, todoReadToolEntry, taskOutputToolEntry].forEach((entry) =>
    registry.register(entry),
  );
  const tools = registry.toContracts();
  const entries: RuntimeMessageEntry[] = [
    {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "search-removed", name: "ToolSearch", input: { query: "select:TodoRead" } },
        ],
      },
    },
    {
      message: {
        role: "tool",
        toolName: "ToolSearch",
        toolCallId: "search-removed",
        content: [{ type: "tool_reference", toolName: "TodoRead" }],
      },
    },
  ];
  const before = structuredClone(entries);
  const projected = buildToolExposure({
    mode: "native" as const,
    model: model(true),
    registry,
    entries,
    tools: tools.filter((tool) => tool.name !== "TodoRead"),
  });

  expect(projected.enabled).toBe(true);
  expect(projected.context.catalog.map((tool) => tool.name)).toEqual(["ToolSearch", "TaskOutput"]);
  expect(projected.tools.map((tool) => tool.name)).toEqual(["ToolSearch"]);
  expect(projected.entries).toHaveLength(2);
  expect(projected.entries[0]).toEqual(entries[0]);
  expect(projected.entries[1]).toMatchObject({
    message: {
      role: "tool",
      toolName: "ToolSearch",
      toolCallId: "search-removed",
      content: [{ type: "text", text: "[Tool references removed - tools no longer available]" }],
    },
  });
  expect(entries).toEqual(before);
  expect([...collectDiscoveredTools(entries)]).toEqual(["TodoRead"]);
  const restored = buildToolExposure({
    mode: "native" as const,
    model: model(true),
    registry,
    entries,
    tools,
  });
  expect(restored.entries).toEqual(before);
  expect(restored.tools.find((tool) => tool.name === "TodoRead")).toMatchObject({
    deferLoading: true,
  });
});

it("projects current definitions and removes inaccessible references without changing raw history", () => {
  const registry = createToolRegistry();
  [toolSearchToolEntry, todoReadToolEntry, readToolEntry].forEach((entry) =>
    registry.register(entry),
  );
  const tools = registry.toContracts();
  const entries: RuntimeMessageEntry[] = [
    {
      message: {
        role: "tool",
        toolName: "ToolSearch",
        toolCallId: "real",
        content: [{ type: "tool_reference", toolName: "TodoRead" }],
      },
    },
  ];
  const on = buildToolExposure({
    mode: "native" as const,
    model: model(true),
    tools,
    registry,
    entries,
  });
  expect(on.tools.find((tool) => tool.name === "TodoRead")?.deferLoading).toBe(true);
  const off = buildToolExposure({
    mode: "off" as const,
    model: model(false),
    tools,
    registry,
    entries: [
      ...entries,
      buildToolSearchAnnouncement({
        mode: "native" as const,
        model: model(true),
        tools,
        registry,
        entries,
      })!,
    ],
  });
  expect(off.tools.map((tool) => tool.name)).toEqual(["TodoRead", "Read"]);
  expect(off.entries).toHaveLength(1);
  expect(JSON.stringify(off)).not.toContain('"tool_reference"');
  const changed = tools.map((tool) =>
    tool.name === "TodoRead"
      ? { ...tool, description: "new schema", inputSchema: { type: "object", required: ["new"] } }
      : tool,
  ) as ModelToolContract[];
  expect(
    buildToolExposure({
      mode: "native" as const,
      model: model(true),
      tools: changed,
      registry,
      entries,
    }).tools.find((tool) => tool.name === "TodoRead")?.description,
  ).toBe("new schema");
  const denied = buildToolExposure({
    mode: "native" as const,
    model: model(true),
    tools: tools.filter((tool) => tool.name !== "TodoRead"),
    registry,
    entries,
  });
  expect(denied.enabled).toBe(false);
  expect(denied.context.catalog.map((tool) => tool.name)).not.toContain("TodoRead");
  expect(entries[0]?.message.content).toEqual([{ type: "tool_reference", toolName: "TodoRead" }]);
});

it("collects announcements from retained history independently of request projection", () => {
  const registry = createToolRegistry();
  [toolSearchToolEntry, todoReadToolEntry, readToolEntry].forEach((entry) =>
    registry.register(entry),
  );
  const input = {
    mode: "native" as const,
    model: model(true),
    tools: registry.toContracts(),
    registry,
    entries: [],
  };
  const announcement = buildToolSearchAnnouncement(input)!;
  expect(announcement.content)
    .toBe(`The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:
TodoRead`);
  expect(announcement.metadata?.toolSearchAnnouncement).toEqual({
    addedNames: ["TodoRead"],
    removedNames: [],
    readdedNames: [],
  });
  expect(input.entries).toEqual([]);
  const entries = [announcement];
  expect(buildToolSearchAnnouncement({ ...input, entries })).toBeUndefined();
  expect(
    buildToolSearchAnnouncement({ ...input, mode: "off" as const, model: model(false) }),
  ).toBeUndefined();
  expect(
    buildToolSearchAnnouncement({
      ...input,
      tools: input.tools.filter((t) => t.name !== "ToolSearch"),
    }),
  ).toBeUndefined();
  const projected = buildToolExposure({ ...input, entries });
  expect(projected.entries).toEqual(entries);
  expect(projected).not.toHaveProperty("announcement");
  expect(buildToolExposure(input).entries).toEqual([]);
});

it("rebuilds complete name listings from retained deltas, including a readded-only suffix", () => {
  const registry = createToolRegistry();
  [toolSearchToolEntry, todoReadToolEntry, taskOutputToolEntry].forEach((t) =>
    registry.register(t),
  );
  const tools = registry.toContracts();
  const collect = (entries: RuntimeMessageEntry[], names = ["TodoRead", "TaskOutput"]) =>
    buildToolSearchAnnouncement({
      mode: "native" as const,
      model: model(true),
      registry,
      entries,
      tools: tools.filter((t) => t.name === "ToolSearch" || names.includes(t.name)),
    });
  const first = collect([], ["TodoRead"])!;
  const second = collect([first])!;
  expect(second.metadata?.toolSearchAnnouncement).toEqual({
    addedNames: ["TaskOutput"],
    removedNames: [],
    readdedNames: [],
  });
  expect(second.content).not.toContain("TodoRead");
  const rebuilt = collect([second])!;
  expect(rebuilt.metadata?.toolSearchAnnouncement).toEqual({
    addedNames: ["TodoRead"],
    removedNames: [],
    readdedNames: [],
  });
  expect(rebuilt.content).toContain("\nTodoRead");
  expect(collect([second, rebuilt])).toBeUndefined();

  const removed = collect([first, second], ["TaskOutput"])!;
  expect(removed.metadata?.toolSearchAnnouncement).toEqual({
    addedNames: [],
    removedNames: ["TodoRead"],
    readdedNames: [],
  });
  const readded = collect([first, second, removed])!;
  expect(readded.metadata?.toolSearchAnnouncement).toEqual({
    addedNames: ["TodoRead"],
    removedNames: [],
    readdedNames: ["TodoRead"],
  });
  expect(readded.content).toBe(
    `1 deferred tool is available again in this session (announced earlier in this conversation): TodoRead. Load via ToolSearch as before.`,
  );
  expect(collect([first, second, removed, readded])).toBeUndefined();
  const readdedSuffix = collect([readded])!;
  expect(readdedSuffix.metadata?.toolSearchAnnouncement).toEqual({
    addedNames: ["TaskOutput", "TodoRead"],
    removedNames: [],
    readdedNames: [],
  });
  expect(readdedSuffix.content).toContain("\nTaskOutput\nTodoRead");
  expect(collect([readded, readdedSuffix])).toBeUndefined();
});

it.each([30, 31])("renders removal of %i names at the listing threshold", (count) => {
  const registry = createToolRegistry();
  const names = Array.from(
    { length: count },
    (_, i) => `mcp__demo__tool${String(i).padStart(2, "0")}`,
  );
  [toolSearchToolEntry, todoReadToolEntry].forEach((entry) => registry.register(entry));
  for (const name of names) {
    registry.register({ ...todoReadToolEntry, metadata: { ...todoReadToolEntry.metadata, name } });
  }
  const tools = registry.toContracts();
  const first = buildToolSearchAnnouncement({
    mode: "native" as const,
    model: model(true),
    tools,
    registry,
    entries: [],
  })!;
  const removed = buildToolSearchAnnouncement({
    mode: "native" as const,
    model: model(true),
    registry,
    tools: tools.filter((tool) => !names.includes(tool.name)),
    entries: [first],
  })!;
  const expected =
    count === 30
      ? `The following deferred tools are no longer available. Do not search for them — ToolSearch will return no match:\n${names.join("\n")}`
      : "31 deferred tools are no longer available: mcp__demo__* (31). Do not search for them — ToolSearch will return no match.";
  expect(removed.content).toBe(`${expected}

This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.`);
  expect(removed.metadata?.toolSearchAnnouncement?.removedNames).toEqual(names);
});

it("separates added, grouped readded and removed announcement paragraphs", () => {
  const registry = createToolRegistry();
  const names = ["mcp__demo__read", "mcp__demo__write", "mcp__other__read", "TaskOutput"];
  registry.register(toolSearchToolEntry);
  for (const name of [...names, "TodoRead"]) {
    registry.register({ ...todoReadToolEntry, metadata: { ...todoReadToolEntry.metadata, name } });
  }
  const priorNames = [...names, "Gone"];
  const entries: RuntimeMessageEntry[] = [
    {
      message: { role: "user", content: "prior listing" },
      metadata: {
        source: "legacy_synthetic",
        toolSearchAnnouncement: { addedNames: priorNames, readdedNames: [], removedNames: [] },
      },
    },
    {
      message: { role: "user", content: "prior removal" },
      metadata: {
        source: "legacy_synthetic",
        toolSearchAnnouncement: { addedNames: [], readdedNames: [], removedNames: names },
      },
    },
  ];
  const announcement = buildToolSearchAnnouncement({
    mode: "native" as const,
    model: model(true),
    registry,
    tools: registry.toContracts(),
    entries,
  })!;
  expect(announcement.content)
    .toBe(`The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:
TodoRead

3 deferred tools are available again (MCP server reconnected — names announced earlier in this conversation): mcp__demo__* (2), mcp__other__*. Load via ToolSearch as before.

1 deferred tool is available again in this session (announced earlier in this conversation): TaskOutput. Load via ToolSearch as before.

The following deferred tools are no longer available in this session. Do not search for them — ToolSearch will return no match:
Gone

This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.`);
  expect(
    buildToolSearchAnnouncement({
      mode: "native" as const,
      model: model(true),
      registry,
      tools: registry.toContracts(),
      entries: [...entries, announcement],
    }),
  ).toBeUndefined();
});

it("does not announce deletion when a deferred tool becomes resident", () => {
  const registry = createToolRegistry();
  [toolSearchToolEntry, todoReadToolEntry, taskOutputToolEntry].forEach((t) =>
    registry.register(t),
  );
  const tools = registry.toContracts();
  const input = { mode: "native" as const, model: model(true), registry, tools, entries: [] };
  const first = buildToolSearchAnnouncement(input)!;
  registry.register(
    { ...todoReadToolEntry, metadata: { ...todoReadToolEntry.metadata, alwaysLoad: true } },
    { silentDuplicateWarning: true },
  );
  expect(buildToolSearchAnnouncement({ ...input, entries: [first] })).toBeUndefined();
  registry.register(todoReadToolEntry, { silentDuplicateWarning: true });
  expect(buildToolSearchAnnouncement({ ...input, entries: [first] })).toBeUndefined();
});

it("disables deferral when ToolSearch is outside the allowed scope and honors alwaysLoad", () => {
  const registry = createToolRegistry();
  registry.register({
    ...todoReadToolEntry,
    metadata: { ...todoReadToolEntry.metadata, alwaysLoad: true },
  });
  registry.register(toolSearchToolEntry);
  const exposed = buildToolExposure({
    mode: "native" as const,
    model: model(true),
    tools: registry.toContracts(),
    registry,
    entries: [],
  });
  expect(exposed.reason).toBe("no_deferred_tools");
  expect(exposed.tools[0]?.name).toBe("TodoRead");
  const scoped = buildToolExposure({
    mode: "native" as const,
    model: model(true),
    tools: [todoReadToolEntry].map((entry) => ({
      name: entry.metadata.name,
      inputSchema: entry.inputSchema,
    })),
    entries: [],
  });
  expect(scoped.enabled).toBe(false);
});

describe("removal reasons", () => {
  const AMBIENT =
    "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.";
  // removed 离开工具目录；hidden 仍在 registry，只是本轮不在 tools 里。
  function announceThenRemove(removed: string[], hidden: string[] = []) {
    const registry = createToolRegistry();
    [toolSearchToolEntry, todoReadToolEntry].forEach((entry) => registry.register(entry));
    // mcp__demo__keep 始终留在本轮，ToolSearch 保持开启。
    for (const name of [...removed, "mcp__demo__keep"]) {
      registry.register({
        ...todoReadToolEntry,
        metadata: { ...todoReadToolEntry.metadata, name },
      });
    }
    const first = buildToolSearchAnnouncement({
      mode: "native" as const,
      model: model(true),
      tools: registry.toContracts(),
      registry,
      entries: [],
    })!;
    for (const name of removed) registry.unregister(name);
    return buildToolSearchAnnouncement({
      mode: "native" as const,
      model: model(true),
      tools: registry.toContracts().filter((tool) => !hidden.includes(tool.name)),
      registry,
      entries: [first],
    })!;
  }

  it("names an MCP disconnect by the mcp__ name prefix", () => {
    // 只看名称前缀，不读取连接状态；非 MCP 名称不写成断开。
    const removed = announceThenRemove(["mcp__my_server__read", "mcp__other__read", "TaskOutput"]);
    expect(removed.content)
      .toBe(`The following deferred tools are no longer available (their MCP server disconnected). Do not search for them — ToolSearch will return no match:
mcp__my_server__read
mcp__other__read

The following deferred tools are no longer available in this session. Do not search for them — ToolSearch will return no match:
TaskOutput

${AMBIENT}`);
    // 原因只进入文案，增量事实不变。
    expect(removed.metadata?.toolSearchAnnouncement?.removedNames).toEqual([
      "TaskOutput",
      "mcp__my_server__read",
      "mcp__other__read",
    ]);
  });

  it("summarizes more than 30 tools of a disconnected server", () => {
    const names = Array.from(
      { length: 31 },
      (_, i) => `mcp__demo__tool${String(i).padStart(2, "0")}`,
    );
    expect(announceThenRemove(names).content).toBe(
      `31 deferred tools are no longer available (MCP server disconnected): mcp__demo__* (31). Do not search for them — ToolSearch will return no match.

${AMBIENT}`,
    );
  });

  it("keeps the neutral text for a tool that is only hidden in this turn", () => {
    expect(announceThenRemove([], ["TodoRead"]).content)
      .toBe(`The following deferred tools are no longer available. Do not search for them — ToolSearch will return no match:
TodoRead

${AMBIENT}`);
  });

  // 请求投影每次按 metadata 重新渲染；隐藏名称不记下来时，同一条公告在请求里会变成"会话内不可用"。
  it("renders the hidden names in every request and after cold resume", () => {
    const announcement = announceThenRemove([], ["TodoRead"]);
    expect(announcement.metadata?.toolSearchHiddenNames).toEqual(["TodoRead"]);
    const registry = createToolRegistry();
    [toolSearchToolEntry, deferredToolCallEntry, todoReadToolEntry].forEach((entry) =>
      registry.register(entry),
    );
    registry.register({
      ...todoReadToolEntry,
      metadata: { ...todoReadToolEntry.metadata, name: "mcp__demo__keep" },
    });
    const tools = registry.toContracts().filter((tool) => tool.name !== "TodoRead");
    // 冷恢复只剩持久化的 metadata 原样回来。
    const resumed = parseToolSearchHiddenNames(
      JSON.parse(JSON.stringify(announcement.metadata!.toolSearchHiddenNames)),
      announcement.metadata!.toolSearchAnnouncement!,
    );
    const restored: RuntimeMessageEntry = {
      ...announcement,
      metadata: { ...announcement.metadata!, toolSearchHiddenNames: resumed },
    };
    for (const entry of [announcement, restored]) {
      for (const mode of ["native", "local"] as const) {
        const projected = buildToolExposure({
          mode,
          model: model(true),
          tools,
          registry,
          entries: [entry],
        });
        const searchName = mode === "local" ? "LocalToolSearch" : "ToolSearch";
        expect(projected.entries.find((item) => item.kind === "attachment")?.content)
          .toBe(`The following deferred tools are no longer available. Do not search for them — ${searchName} will return no match:
TodoRead

${AMBIENT}`);
      }
    }
  });
});
