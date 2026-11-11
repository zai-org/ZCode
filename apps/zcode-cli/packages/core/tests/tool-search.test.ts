import { describe, expect, it } from "vitest";
import type { ToolSearchCandidate } from "@zcode/contracts";
import { searchTools } from "../src/tool/search/search.js";
import { collectDiscoveredTools, projectToolReferences } from "../src/tool/search/history.js";
import { buildToolExposure, resolveToolSearchMode } from "../src/tool/search/exposure.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { webFetchToolEntry } from "../src/tool/handlers/webfetch.js";
import { webSearchToolEntry } from "../src/tool/handlers/websearch.js";
import { todoWriteToolEntry } from "../src/tool/handlers/todo.js";
import { enterPlanModeToolEntry, exitPlanModeToolEntry } from "../src/tool/handlers/plan-mode.js";
import { taskOutputToolEntry } from "../src/tool/handlers/task-output.js";
import { taskStopToolEntry } from "../src/tool/handlers/task-stop.js";
import { sendMessageToolEntry } from "../src/tool/handlers/send-message.js";
import {
  cronCreateToolEntry,
  cronListToolEntry,
  cronDeleteToolEntry,
  cronPauseSelfToolEntry,
} from "../src/tool/handlers/cron.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

const catalog = [
  { name: "Read", aliases: ["read_file"], deferred: false, description: "Read files" },
  { name: "WebFetch", deferred: true, description: "Fetch content from a URL" },
  { name: "mcp__slack__send_message", deferred: true, description: "Send messages" },
  { name: "mcp__slack__search", deferred: true, description: "Search messages" },
  { name: "mcp__comms__send", deferred: true, description: "Send to slack" },
];

describe("ToolSearch semantics", () => {
  it("searches built-in hints through the real scoped request catalog", () => {
    const registry = createToolRegistry();
    [
      toolSearchToolEntry,
      webFetchToolEntry,
      webSearchToolEntry,
      todoWriteToolEntry,
      enterPlanModeToolEntry,
      exitPlanModeToolEntry,
      taskOutputToolEntry,
      taskStopToolEntry,
      sendMessageToolEntry,
      cronCreateToolEntry,
      cronListToolEntry,
      cronDeleteToolEntry,
      cronPauseSelfToolEntry,
    ].forEach((entry) => registry.register(entry));
    const tools = registry.toContracts();
    const exposed = buildToolExposure({
      model: {
        ...createTestRuntimeModel({
          generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
        }),
        requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
      },
      tools,
      registry,
      entries: [],
    });
    for (const tool of exposed.context.catalog.filter((t) => t.deferred))
      expect(tool.searchHint, tool.name).toBeTruthy();
    for (const [query, name] of [
      ["logs", "TaskOutput"],
      ["cancel", "CronDelete"],
      ["active", "CronList"],
      ["pause", "CronPauseSelf"],
    ]) {
      expect(searchTools(query!, exposed.context.catalog)).toContain(name);
      expect(searchTools(`+${query}`, exposed.context.catalog)).toContain(name);
    }
    expect(searchTools("+cancel cron", exposed.context.catalog)).toEqual(["CronDelete"]);
    expect(searchTools("+logs absent", exposed.context.catalog)).toEqual(["TaskOutput"]);
    const scoped = exposed.context.catalog.filter((t) => t.name !== "CronDelete");
    expect(searchTools("+cancel cron", scoped)).not.toContain("CronDelete");
  });

  it("selects canonical tools and aliases without truncating direct selection", () => {
    expect(searchTools("select:WebFetch,read_file,WebFetch,missing", catalog, 1)).toEqual([
      "WebFetch",
      "Read",
    ]);
    expect(searchTools("select:read", catalog)).toEqual([]);
    expect(searchTools("read_file", catalog)).toEqual([]);
    expect(searchTools("read", catalog)).toEqual(["Read"]);
  });
  it("searches deferred tools by prefix and weighted name/description matches", () => {
    expect(searchTools("mcp__slack__", catalog, 1)).toEqual(["mcp__slack__send_message"]);
    expect(searchTools("slack send", catalog)[0]).toBe("mcp__slack__send_message");
    expect(searchTools("+slack send", catalog)).toContain("mcp__comms__send");
    expect(searchTools("files", catalog)).toEqual([]);
    expect(searchTools("nonexistent", catalog)).toEqual([]);
  });
  it("uses genuine results and the selected compact checkpoint, not ordinary calls", () => {
    const entries = [
      {
        message: { role: "user" as const, content: "summary" },
        metadata: {
          source: "legacy_synthetic" as const,
          compactBoundary: { boundaryId: "boundary", preCompactDiscoveredTools: ["WebFetch"] },
        },
      },
      {
        message: {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: "read", name: "Read", input: {} }],
        },
      },
      {
        message: {
          role: "tool" as const,
          toolCallId: "search",
          toolName: "ToolSearch",
          content: [{ type: "tool_reference" as const, toolName: "mcp__slack__search" }],
        },
      },
    ];
    expect([...collectDiscoveredTools(entries)]).toEqual(["WebFetch", "mcp__slack__search"]);
    const before = structuredClone(entries);
    const off = projectToolReferences(entries, "off", []).entries;
    expect(off[2]?.message.content).toEqual([
      { type: "text", text: "[Tool references removed - tool search not enabled]" },
    ]);
    expect(off[2]?.message.toolCallId).toBe("search");
    expect(entries).toEqual(before);
  });

  it("tokenizes explicit MCP server and tool metadata even when the public name is opaque", () => {
    const tools: ToolSearchCandidate[] = [
      {
        name: "OpaqueTool",
        deferred: true,
        mcp: { serverName: "Team.Slack", toolName: "send_message" },
      },
      {
        name: "ResidentTool",
        deferred: false,
        mcp: { serverName: "Team.Slack", toolName: "send_message" },
      },
      { name: "PlainTool", deferred: true },
    ];
    expect(searchTools("+team +slack +send +message", tools)).toEqual(["OpaqueTool"]);
    expect(searchTools("opaque", tools)).toEqual([]);
    expect(searchTools("OpaqueTool", tools)).toEqual(["OpaqueTool"]);
  });

  it("requires every required term while allowing name, hint and description to satisfy them", () => {
    const tools: ToolSearchCandidate[] = [
      { name: "SlackReports", deferred: true, description: "report" },
      { name: "SendReports", deferred: true, description: "report" },
      { name: "HintMatch", deferred: true, searchHint: "slack send", description: "report" },
      { name: "SlackSend", deferred: true, description: "report" },
      { name: "DescriptionMatch", deferred: true, description: "slack send report" },
      { name: "MixedMatch", deferred: true, searchHint: "slack", description: "send report" },
    ];
    expect(searchTools("+slack +send report", tools)).toEqual([
      "SlackSend",
      "HintMatch",
      "MixedMatch",
      "DescriptionMatch",
    ]);
    expect(searchTools("+slack +send +absent report", tools)).toEqual([]);
  });

  it.each([
    ["foo.bar", "fooXbar"],
    ["a[b]c", "abc"],
    ["a+b", "aaab"],
    ["a(b)c", "abc"],
    ["a|b", "a b"],
    ["a\\b", "a b"],
  ])("matches %s literally in search hints and descriptions", (query, lookalike) => {
    const tools = [
      { name: "LiteralDescription", deferred: true, description: `Supports ${query} syntax` },
      { name: "PatternLookalike", deferred: true, description: `Supports ${lookalike} syntax` },
      { name: "LiteralHint", deferred: true, searchHint: `Supports ${query} syntax` },
    ];
    expect(searchTools(query, tools)).toEqual(["LiteralHint", "LiteralDescription"]);
    expect(searchTools(`+${query}`, tools)).toEqual(["LiteralHint", "LiteralDescription"]);
  });

  it("ranks MCP names, builtin names, partial names, hints and descriptions before truncation", () => {
    const tools = [
      { name: "DescriptionOnly", deferred: true, description: "lookup" },
      { name: "HintOnly", deferred: true, searchHint: "lookup" },
      { name: "HintAndDescription", deferred: true, searchHint: "lookup", description: "lookup" },
      { name: "Lookupish", deferred: true },
      { name: "LookupFiles", deferred: true },
      { name: "mcp__lookup__files", deferred: true },
    ];
    expect(searchTools("lookup", tools, 10)).toEqual([
      "mcp__lookup__files",
      "LookupFiles",
      "Lookupish",
      "HintAndDescription",
      "HintOnly",
      "DescriptionOnly",
    ]);
    expect(searchTools("lookup", tools, 3)).toEqual([
      "mcp__lookup__files",
      "LookupFiles",
      "Lookupish",
    ]);
  });
  it("preserves unrelated text and removes only unavailable references", () => {
    const entries = [
      {
        message: {
          role: "tool" as const,
          content: [
            { type: "text" as const, text: "diagnostic" },
            { type: "tool_reference" as const, toolName: "removed" },
            { type: "tool_reference" as const, toolName: "WebFetch" },
          ],
        },
      },
    ];
    expect(
      projectToolReferences(entries, "native", [{ name: "WebFetch", inputSchema: {} }]).entries[0]
        ?.message.content,
    ).toEqual([entries[0]!.message.content[0], entries[0]!.message.content[2]]);
  });
  it("defaults off and selects an explicit mode from actual Model capabilities", () => {
    const base = createTestRuntimeModel({
      generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
    });
    const supported = {
      ...base,
      requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: false } },
    };
    expect(resolveToolSearchMode(supported)).toBe("off");
    expect(resolveToolSearchMode(supported, "auto")).toBe("local");
    expect(resolveToolSearchMode(supported, "native")).toBe("native");
    const codingPlan = {
      ...supported,
      requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
    };
    expect(resolveToolSearchMode(codingPlan)).toBe("off");
    expect(resolveToolSearchMode(codingPlan, "auto")).toBe("native");
    expect(() => resolveToolSearchMode(base, "native")).toThrow(/Anthropic Messages/);
    expect(() =>
      resolveToolSearchMode(
        { ...base, properties: { ...base.properties, supportsToolCall: false } },
        "local",
      ),
    ).toThrow(/supports tool calls/);
  });
});
