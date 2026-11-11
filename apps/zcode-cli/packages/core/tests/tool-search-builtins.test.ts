import { expect, it } from "vitest";
import { createSessionId, createTurnId, type Model } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { prepareRuntimeProviderRequest } from "../src/runtime/helpers/runtime-provider-request-messages.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { builtInTools, registerBuiltInTools } from "../src/tool/handlers/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { buildToolSearchAnnouncement } from "../src/tool/search/exposure.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

const RESIDENT_NAMES = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "Read",
  "ReportFindings",
  "Skill",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Write",
  // 只在注入 workflowSubmitPort 的 actor 会话注册；fixture 打开了 includeSubmitResult。
  "submit_result",
];

function fixture(embeddedSearchEnabled = false) {
  const registry = createToolRegistry();
  registerBuiltInTools(registry, {
    includeAgent: true,
    includeSkill: true,
    includeSendMessage: true,
    includeRespondToCoordinator: true,
    includeSubmitResult: true,
    submitResultSchema: { type: "object", properties: { answer: { type: "string" } } },
    includeEscalate: true,
    includeWorkflow: true,
    includeAutomation: true,
    includeOffPeak: true,
    includeDynamicWorkflow: true,
    includeNodeRepl: true,
    includeBrowserUse: true,
    embeddedSearchEnabled,
  });
  const model: Model = {
    ...createTestRuntimeModel({
      generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
    }),
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
  };
  return { registry, model, tools: registry.toContracts() };
}

it.each([false, true])(
  "exposes only resident builtins initially and announces the rest (embedded search: %s)",
  (embeddedSearchEnabled) => {
    const input = fixture(embeddedSearchEnabled);
    const entries: RuntimeMessageEntry[] = [];
    const prepared = prepareRuntimeProviderRequest(
      { config: { toolSearch: { mode: "auto" } } },
      { ...input, entries },
    );
    const expectedResidents = RESIDENT_NAMES.filter((name) => input.registry.has(name));
    expect(prepared.request.toolSearchEnabled).toBe(true);
    expect(prepared.request.tools.map((tool) => tool.name).sort()).toEqual(expectedResidents);
    expect(prepared.request.tools.every((tool) => tool.deferLoading === undefined)).toBe(true);

    const deferredNames = input.tools
      .filter((tool) => tool.name !== "DeferredToolCall" && !RESIDENT_NAMES.includes(tool.name))
      .map((tool) => tool.name)
      .sort();
    const announcement = buildToolSearchAnnouncement({ ...input, mode: "native", entries });
    expect(announcement?.metadata?.toolSearchAnnouncement).toEqual({
      addedNames: deferredNames,
      removedNames: [],
      readdedNames: [],
    });
    expect(prepared.toolSearch.catalog.some((tool) => tool.name === "Task")).toBe(false);
    // 同时检查静态条目和注册时重建的工厂条目，避免分支覆盖丢掉 metadata。
    for (const entry of [
      ...builtInTools,
      ...input.registry.list().map((name) => input.registry.get(name)!),
    ]) {
      if (
        entry.metadata.name !== "DeferredToolCall" &&
        !RESIDENT_NAMES.includes(entry.metadata.name)
      ) {
        expect(entry.metadata.shouldDefer, entry.metadata.name).toBe(true);
      }
    }
  },
);

it("loads builtin schemas with deferLoading after executing a real ToolSearch", async () => {
  const input = fixture();
  const prepared = prepareRuntimeProviderRequest(
    { config: { toolSearch: { mode: "auto" } } },
    { ...input, entries: [] },
  );
  const names = input.tools
    .filter((tool) => tool.name !== "DeferredToolCall" && !RESIDENT_NAMES.includes(tool.name))
    .map((tool) => tool.name);
  const call = {
    id: "builtin-search",
    name: "ToolSearch",
    input: { query: `select:${names.join(",")}` },
  };
  const executor = createToolExecutor({
    emitEvent: async () => {},
    registry: input.registry,
    permissionService: new PermissionService(defaultPermissionConfig),
    sessionId: createSessionId("builtin-search"),
    turnId: createTurnId("turn"),
  });
  const result = await executor.execute(call, { toolSearch: prepared.toolSearch });
  expect(result.success).toBe(true);
  expect(result.modelContent).toEqual(
    names.map((toolName) => ({ type: "tool_reference", toolName })),
  );
  const entries: RuntimeMessageEntry[] = [
    { message: { role: "assistant", content: "", toolCalls: [call] } },
    {
      message: {
        role: "tool",
        toolName: call.name,
        toolCallId: call.id,
        content: result.modelContent!,
      },
    },
  ];
  const next = prepareRuntimeProviderRequest(
    { config: { toolSearch: { mode: "auto" } } },
    { ...input, entries },
  );
  expect(next.request.tools).toEqual(
    input.tools
      .filter((tool) => tool.name !== "DeferredToolCall")
      .map((tool) => (RESIDENT_NAMES.includes(tool.name) ? tool : { ...tool, deferLoading: true })),
  );
  expect(next.request.messages.find((message) => message.role === "tool")?.content).toEqual(
    result.modelContent,
  );
});

it.each(["provider_disabled", "tool_unavailable"] as const)(
  "preserves full builtin schemas when ToolSearch is %s",
  (reason) => {
    const input = fixture();
    if (reason === "provider_disabled") {
      input.model = {
        ...input.model,
        requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: false } },
      };
    } else {
      input.tools = input.tools.filter(
        (tool) => tool.name !== "ToolSearch" && tool.name !== "DeferredToolCall",
      );
    }
    const prepared = prepareRuntimeProviderRequest(
      { config: { toolSearch: { mode: "off" } } },
      { ...input, entries: [] },
    );
    expect(prepared.request.toolSearchEnabled).toBe(false);
    expect(prepared.request.tools).toEqual(
      input.tools.filter((tool) => tool.name !== "ToolSearch" && tool.name !== "DeferredToolCall"),
    );
    expect(buildToolSearchAnnouncement({ ...input, entries: [] })).toBeUndefined();
  },
);
