import { expect, it, vi } from "vitest";
import type { ResolvedToolSearchMode } from "@zcode/contracts";
import type {
  RuntimeMessageEntry,
  RuntimeMessageMessageEntry,
} from "../src/agent/message-history.js";
import { buildToolExposure, buildToolSearchAnnouncement } from "../src/tool/search/exposure.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { deferredToolCallEntry } from "../src/tool/handlers/deferred-tool-call.js";
import { taskOutputToolEntry } from "../src/tool/handlers/task-output.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

function fixture() {
  const registry = createToolRegistry();
  [toolSearchToolEntry, deferredToolCallEntry, taskOutputToolEntry].forEach((tool) =>
    registry.register(tool),
  );
  const model = {
    ...createTestRuntimeModel({
      generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
    }),
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
  };
  const tools = registry.toContracts();
  return { registry, model, tools };
}

function result(
  content: RuntimeMessageMessageEntry["message"]["content"],
): RuntimeMessageMessageEntry {
  return { message: { role: "tool", toolName: "ToolSearch", toolCallId: "search", content } };
}

it.each<ResolvedToolSearchMode>(["native", "local", "off"])(
  "%s reuses unchanged tool result entries and their content",
  (mode) => {
    const entries = [result([{ type: "text", text: "ordinary tool output" }]), result("text")];
    for (const entry of entries) entry.message.toolName = "TaskOutput";
    for (const entry of entries) {
      Object.freeze(entry.message.content);
      Object.freeze(entry.message);
      Object.freeze(entry);
    }
    const projected = buildToolExposure({ ...fixture(), mode, entries });
    expect(projected.entries).toHaveLength(entries.length);
    entries.forEach((entry, index) => expect(projected.entries[index]).toBe(entry));
  },
);

it("encodes a Local definition once per request and reads new definitions on the next request", () => {
  const input = fixture();
  const reference = { type: "tool_reference" as const, toolName: "TaskOutput" };
  const entries = [result([reference, reference]), result([reference])];
  const stringify = vi.spyOn(JSON, "stringify");
  let first;
  let second;
  let definitions;
  try {
    first = buildToolExposure({ ...input, mode: "local", entries });
    second = buildToolExposure({
      ...input,
      mode: "local",
      entries,
      tools: input.tools.map((tool) =>
        tool.name === "TaskOutput" ? { ...tool, description: "updated definition" } : tool,
      ),
    });
    definitions = stringify.mock.calls.filter(([value]) => value?.name === "TaskOutput");
  } finally {
    stringify.mockRestore();
  }
  expect(definitions).toHaveLength(2);
  const firstContent = first.entries.map((entry) => JSON.stringify(entry.message.content));
  expect(firstContent[0]?.match(/<functions>/g)).toHaveLength(1);
  expect(firstContent[0]?.match(/<function>/g)).toHaveLength(2);
  expect(firstContent[1]?.match(/<functions>/g)).toHaveLength(1);
  expect(JSON.stringify(first.entries)).not.toContain("updated definition");
  expect(JSON.stringify(second.entries)).toContain("updated definition");
  expect(entries[0]?.message.content).toEqual([reference, reference]);
});

it("preserves Native discovery ordering when an earlier error reference is discovered later", () => {
  const input = fixture();
  const reference = { type: "tool_reference" as const, toolName: "TaskOutput" };
  const failed = result([reference]);
  failed.message.isError = true;
  const withoutDiscovery = buildToolExposure({ ...input, mode: "native", entries: [failed] });
  expect(withoutDiscovery.context.discovered.size).toBe(0);
  expect(withoutDiscovery.entries[0]?.message.content).toEqual([
    { type: "text", text: "[Tool references removed - tools no longer available]" },
  ]);
  const successful = result([reference]);
  const discovered = buildToolExposure({
    ...input,
    mode: "native",
    entries: [failed, successful],
  });
  expect(discovered.tools.find((tool) => tool.name === "TaskOutput")?.deferLoading).toBe(true);
  expect(discovered.entries[0]).toBe(failed);
  expect(discovered.entries[1]).toBe(successful);
});

// 模式切换复用同一份原始历史，不能依赖上一请求改写后的名称或公告。
it.each(["ToolSearch", "LocalToolSearch"])(
  "projects %s history across every mode transition",
  (storedName) => {
    const input = fixture();
    const announcement = buildToolSearchAnnouncement({
      ...input,
      mode: storedName === "ToolSearch" ? "native" : "local",
      entries: [],
    })!;
    const entries: RuntimeMessageEntry[] = [
      announcement,
      {
        message: {
          role: "user",
          content: "Keep the literal ToolSearch and LocalToolSearch in this text.",
        },
      },
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "search", name: storedName, input: { query: "select:TaskOutput" } }],
        },
      },
      {
        message: {
          role: "tool",
          toolName: storedName,
          toolCallId: "search",
          content: [{ type: "tool_reference", toolName: "TaskOutput" }],
        },
      },
    ];
    const before = structuredClone(entries);
    const toolsBefore = structuredClone(input.tools);
    for (const from of ["native", "local", "off"] as const) {
      const previous = buildToolExposure({ ...input, mode: from, entries });
      const previousSnapshot = structuredClone(previous.entries);
      for (const mode of ["native", "local", "off"] as const) {
        const projected = buildToolExposure({ ...input, mode, entries });
        const name =
          mode === "local" ? "LocalToolSearch" : mode === "native" ? "ToolSearch" : storedName;
        const messages = projected.entries
          .filter((entry) => entry.kind !== "attachment")
          .map((entry) => entry.message);
        expect(
          messages
            .flatMap((message) => message.toolCalls ?? [])
            .find((call) => call.id === "search")?.name,
        ).toBe(name);
        expect(messages.find((message) => message.toolCallId === "search")?.toolName).toBe(name);
        expect(messages[0]?.content).toBe(before[1]!.message.content);
        const names = projected.tools.map((tool) => tool.name);
        expect(names.includes("LocalToolSearch")).toBe(mode === "local");
        expect(names.includes("ToolSearch")).toBe(mode === "native");
        const notices = projected.entries.filter((entry) => entry.kind === "attachment");
        expect(notices).toHaveLength(mode === "off" ? 0 : 1);
        if (mode !== "off") expect(notices[0]!.content).toContain(`via ${name}.`);
        expect([...projected.context.discovered]).toContain("TaskOutput");
        expect(projected.loadedToolCallIds.has("search")).toBe(mode === "native");
        expect(previous.entries).toEqual(previousSnapshot);
        expect(entries).toEqual(before);
        expect(input.tools).toEqual(toolsBefore);
      }
    }
  },
);

it("recomputes the Auto search name when the model capability changes", () => {
  const input = fixture();
  for (const supported of [true, false, true]) {
    const model = {
      ...input.model,
      requestCapabilities: {
        toolSearch: { protocolSupported: supported, defaultEnabled: supported },
      },
    };
    const projected = buildToolExposure({ ...input, model, mode: "auto", entries: [] });
    expect(projected.tools.map((tool) => tool.name)).toContain(
      supported ? "ToolSearch" : "LocalToolSearch",
    );
    expect(projected.tools.map((tool) => tool.name)).not.toContain(
      supported ? "LocalToolSearch" : "ToolSearch",
    );
  }
});
