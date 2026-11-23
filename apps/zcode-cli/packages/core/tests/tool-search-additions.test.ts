import { expect, it, vi } from "vitest";
import { ToolSearchAnnouncementSchema, createSessionId, createTurnId } from "@zcode/contracts";
import { createToolRegistry } from "../src/tool/registry.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { deferredToolCallEntry } from "../src/tool/handlers/deferred-tool-call.js";
import { taskOutputToolEntry } from "../src/tool/handlers/task-output.js";
import { todoReadToolEntry } from "../src/tool/handlers/todo.js";
import { buildToolExposure, buildToolSearchAnnouncement } from "../src/tool/search/exposure.js";
import { prepareRuntimeProviderRequest } from "../src/runtime/helpers/runtime-provider-request-messages.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";
import { searchTools } from "../src/tool/search/search.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";

const reference = { type: "tool_reference" as const, toolName: "TaskOutput" };
function fixture() {
  const registry = createToolRegistry();
  const handler = vi.fn();
  [
    toolSearchToolEntry,
    deferredToolCallEntry,
    todoReadToolEntry,
    { ...taskOutputToolEntry, handler },
  ].forEach((entry) => registry.register(entry));
  const model = {
    ...createTestRuntimeModel({
      generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
    }),
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
  };
  const executor = createToolExecutor({
    registry,
    emitEvent: async () => {},
    permissionService: new PermissionService(defaultPermissionConfig),
    getMode: () => "yolo",
    sessionId: createSessionId("search-additions"),
    turnId: createTurnId("turn"),
  });
  return { registry, model, executor, handler };
}
function searchHistory(): RuntimeMessageEntry[] {
  return [
    { message: { role: "user", content: "load tools" }, metadata: { source: "real_user" } },
    {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "search", name: "ToolSearch", input: { query: "select:TaskOutput" } },
          { id: "second", name: "ToolSearch", input: { query: "select:TodoRead" } },
        ],
      },
    },
    {
      message: {
        role: "tool",
        toolName: "ToolSearch",
        toolCallId: "search",
        content: [
          { type: "text", text: "before" },
          reference,
          reference,
          { type: "text", text: "Hook context" },
        ],
      },
    },
    {
      message: {
        role: "tool",
        toolName: "ToolSearch",
        toolCallId: "second",
        content: [{ type: "tool_reference", toolName: "TodoRead" }],
      },
    },
  ];
}

it.each(["native", "local", "off"] as const)(
  "projects success markers after the result batch in %s, without treating them as user input",
  (mode) => {
    const { registry, model } = fixture();
    const entries = searchHistory();
    const before = structuredClone(entries);
    const prepare = () =>
      prepareRuntimeProviderRequest(
        { config: { toolSearch: { mode } } },
        { entries, registry, model, tools: registry.toContracts(), applyCacheControl: true },
      );
    const first = prepare();
    expect(prepare()).toEqual(first);
    const markers = first.request.messages.filter(
      (message) => message.role === "user" && message.content === "Tool loaded.",
    );
    expect(markers).toHaveLength(mode === "native" ? 2 : 0);
    if (mode === "native")
      expect(first.request.messages.slice(-2).map((message) => message.content)).toEqual([
        "Tool loaded.",
        "Tool loaded.",
      ]);
    expect(first.projection.sourceEntries).toHaveLength(first.request.messages.length);
    expect(first.projection.diagnostics.latestRealUserMessageIndex).toBe(0);
    expect(
      first.request.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    ).toEqual(["search", "second"]);
    expect(JSON.stringify(first.request.messages)).not.toContain("loadedToolCallIds");
    expect(entries).toEqual(before);
  },
);

it.each(["error", "unmatched", "unavailable"] as const)(
  "does not derive success for %s results",
  (state) => {
    const { registry, model } = fixture();
    const entries = searchHistory().slice(0, 3);
    const result = entries[2]!;
    if (result.kind === "attachment") throw new Error("unexpected attachment");
    if (state === "error") result.message.isError = true;
    if (state === "unmatched")
      result.message.content =
        "No matching deferred tools found. Loaded tools are not searchable here and need no loading. Check your loaded tool list and query; try corrected spelling, alternative names, or broader keywords before concluding a tool is missing.";
    if (state === "unavailable") registry.unregister("TaskOutput");
    for (const mode of ["native", "local"] as const) {
      const prepared = prepareRuntimeProviderRequest(
        { config: { toolSearch: { mode } } },
        { entries, registry, model, tools: registry.toContracts() },
      );
      expect(prepared.request.messages.some((message) => message.content === "Tool loaded.")).toBe(
        false,
      );
    }
  },
);

it.each(["native", "local"] as const)(
  "provides current schema and exact selection for invalid undiscovered %s input",
  async (mode) => {
    const { registry, model, executor, handler } = fixture();
    const exposure = buildToolExposure({
      mode,
      registry,
      model,
      tools: registry.toContracts(),
      entries: [],
    });
    const call = {
      id: "invalid",
      name: mode === "native" ? "TaskOutput" : "DeferredToolCall",
      input: mode === "native" ? {} : { name: "TaskOutput", input: {} },
    };
    const invalid = await executor.execute(call, { toolSearch: exposure.context });
    expect(invalid.success).toBe(false);
    expect(invalid.toolCallId).toBe("invalid");
    expect(invalid.modelContent).toContain("InputValidationError");
    const known = await executor.execute(call, {
      toolSearch: { ...exposure.context, discovered: new Set(["TaskOutput"]) },
    });
    const guidance =
      "\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. " +
      "Without the schema in your prompt, typed parameters (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. " +
      `Load the tool first: call ${mode === "local" ? "LocalToolSearch" : "ToolSearch"} with query "select:TaskOutput", then retry this call. ` +
      `For reference, this tool's input schema is: ${JSON.stringify(taskOutputToolEntry.inputSchema)}`;
    // 纠错段落属于这次校验错误，放在 `</tool_use_error>` 之内。
    const closing = "</tool_use_error>";
    expect(known.modelContent?.endsWith(closing)).toBe(true);
    expect(invalid.modelContent).toBe(
      `${known.modelContent?.slice(0, -closing.length)}${guidance}` +
        (mode === "local"
          ? '\nCall DeferredToolCall with {name: "TaskOutput", input: {...}}.'
          : "") +
        closing,
    );
    expect(known.modelContent).not.toContain("select:TaskOutput");
    const off = buildToolExposure({
      mode: "off",
      registry,
      model,
      tools: registry.toContracts(),
      entries: [],
    });
    const disabled = await executor.execute(
      { ...call, name: "TaskOutput", input: {} },
      { toolSearch: off.context },
    );
    expect(disabled.modelContent).toBe(known.modelContent);
    expect(handler).not.toHaveBeenCalled();
    registry.unregister("TaskOutput");
    const missing = await executor.execute(call, { toolSearch: exposure.context });
    expect(missing.success).toBe(false);
    expect(missing.modelContent ?? "").not.toContain("For reference, this tool's input schema is:");
  },
);

it.each([false, true])(
  "renders announcements through existing reminder projection (MCS=%s)",
  (mcs) => {
    const { registry, model } = fixture();
    const announcement = buildToolSearchAnnouncement({
      model,
      mode: "native",
      tools: registry.toContracts(),
      registry,
      entries: [],
    })!;
    expect(announcement).toMatchObject({
      kind: "attachment",
      metadata: { source: "tool_search_announcement" },
    });
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "user", content: "hello" }, metadata: { source: "real_user" } },
      { message: { role: "assistant", content: "prior" } },
      { message: { role: "user", content: "next" }, metadata: { source: "real_user" } },
      announcement,
    ];
    const request = prepareRuntimeProviderRequest(
      { config: { toolSearch: { mode: "native" } } },
      {
        entries,
        registry,
        model: {
          ...model,
          properties: { ...model.properties, supportsMidConversationSystem: mcs },
        },
        tools: registry.toContracts(),
      },
    );
    const message = request.request.messages.find((message) =>
      JSON.stringify(message.content).includes("schemas are NOT loaded"),
    );
    expect(message?.role).toBe(mcs ? "system" : "user");
    expect(JSON.stringify(message?.content).includes("<system-reminder>")).toBe(!mcs);
    expect(
      request.request.messages[request.projection.diagnostics.latestRealUserMessageIndex!]?.content,
    ).toBe("next");
  },
);

it("selects MCP short names without overriding exact names or aliases or widening scope", () => {
  const catalog = [
    { name: "mcp__one__look_up", deferred: true, mcp: { serverName: "one", toolName: "look.up" } },
    { name: "mcp__two__look_up", deferred: true, mcp: { serverName: "two", toolName: "look.up" } },
  ];
  expect(searchTools("select:look.up,look_up", catalog, 1)).toEqual(
    catalog.map((tool) => tool.name),
  );
  expect(
    searchTools("select:look.up", [
      ...catalog,
      { name: "Exact", aliases: ["look.up"], deferred: true },
    ]),
  ).toEqual(["Exact"]);
  expect(searchTools("select:look_up", catalog.slice(1))).toEqual([catalog[1]!.name]);
  expect(searchTools("select:missing", catalog)).toEqual([]);
  // server 尾部下划线会紧邻 canonical 分隔符；短名不能靠拆最后一个分隔符还原。
  const punctuation = [
    {
      name: "mcp__server___look_up",
      deferred: true,
      mcp: { serverName: "server.", toolName: "look.up" },
    },
  ];
  expect(searchTools("select:look_up", punctuation)).toEqual([punctuation[0]!.name]);
});

it("does not promote a derived success marker to a media protection anchor", () => {
  const { registry, model } = fixture();
  const prepared = prepareRuntimeProviderRequest(
    { config: { toolSearch: { mode: "native" } } },
    { entries: searchHistory().slice(1), registry, model, tools: registry.toContracts() },
  );
  expect(prepared.request.messages.at(-1)?.content).toBe("Tool loaded.");
  expect(prepared.projection.sourceEntries.at(-1)).toBeUndefined();
  expect(prepared.projection.diagnostics.latestRealUserMessageIndex).toBe(-1);
});

it("announces final removal without retracting a definition that was never delivered", () => {
  const { registry, model } = fixture();
  registry.unregister("TodoRead");
  registry.unregister("TaskOutput");
  registry.unregister("DeferredToolCall");
  registry.register({
    ...todoReadToolEntry,
    metadata: {
      ...todoReadToolEntry.metadata,
      name: "Opaque",
      shouldDefer: true,
      mcpPresentation: { serverName: "source", toolName: "fetch" },
    },
  });
  const initial = buildToolSearchAnnouncement({
    registry,
    model,
    mode: "native",
    tools: registry.toContracts(),
    entries: [],
    mcp: { pending: [], failed: [] },
  })!;
  registry.unregister("Opaque");
  const input = {
    registry,
    model,
    mode: "native" as const,
    tools: registry.toContracts(),
    entries: [initial],
    mcp: { pending: [], failed: [] },
  };
  const removed = buildToolSearchAnnouncement(input)!;
  expect(removed.metadata?.toolSearchMcpDelta?.retractedTools).toBeUndefined();
  expect(removed.content).not.toContain("Disregard those definitions");
  expect(removed.content).toContain("no longer available in this session");
  expect(buildToolExposure(input).tools.map((tool) => tool.name)).not.toContain("ToolSearch");
  expect(buildToolSearchAnnouncement({ ...input, entries: [initial, removed] })).toBeUndefined();
});

it.each(["native", "local"] as const)(
  "delivers final removal facts after %s search becomes unavailable",
  (mode) => {
    const { registry, model } = fixture();
    for (const name of ["TodoRead", "TaskOutput"]) registry.unregister(name);
    const name = "mcp__sample__ping";
    registry.register({
      ...todoReadToolEntry,
      metadata: {
        ...todoReadToolEntry.metadata,
        name,
        mcpPresentation: { serverName: "sample", toolName: "ping" },
      },
    });
    const input = { mode, model, registry, tools: registry.toContracts(), entries: [] };
    const first = buildToolSearchAnnouncement(input)!;
    const status = buildToolSearchAnnouncement({
      ...input,
      entries: [first],
      mcp: { pending: ["sample"], failed: [] },
    })!;
    expect.soft(status.metadata.toolSearchMcpDelta?.toolOrigins).toBeUndefined();
    registry.unregister(name);
    const last = buildToolSearchAnnouncement({
      ...input,
      tools: registry.toContracts(),
      entries: [first, status],
      mcp: { pending: [], failed: [] },
    })!;
    const entries = [
      { message: { role: "user" as const, content: "continue" } },
      first,
      status,
      last,
    ];
    const prepared = prepareRuntimeProviderRequest(
      { config: { toolSearch: { mode } } },
      { model, registry, tools: registry.toContracts(), entries },
    );
    expect(prepared.request.tools?.some((tool) => tool.name === "ToolSearch")).toBe(false);
    expect(JSON.stringify(prepared.request.messages)).toContain("their MCP server disconnected");
    const off = prepareRuntimeProviderRequest(
      { config: { toolSearch: { mode: "off" } } },
      { model, registry, tools: registry.toContracts(), entries },
    );
    expect(JSON.stringify(off.request.messages)).not.toContain("their MCP server disconnected");
  },
);

it("keeps the old strict name delta compatible while recording MCP facts separately", () => {
  const { registry, model } = fixture();
  const announcement = buildToolSearchAnnouncement({
    entries: [],
    model,
    registry,
    tools: registry.toContracts(),
    mode: "native",
    mcp: { pending: ["demo"], failed: [] },
  });
  expect(announcement?.metadata.toolSearchAnnouncement).toEqual({
    addedNames: expect.any(Array),
    removedNames: [],
    readdedNames: [],
  });
  expect(
    ToolSearchAnnouncementSchema.safeParse(announcement?.metadata.toolSearchAnnouncement).success,
  ).toBe(true);
  expect(announcement?.metadata).toMatchObject({
    toolSearchMcpDelta: { mcp: { pending: ["demo"], failed: [] } },
  });
});
