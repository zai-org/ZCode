import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  createTurnId,
  DeferredToolCallInputSchema,
  TaskStopInputSchema,
  type ToolSearchExecutionContext,
} from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { buildToolExposure } from "../src/tool/search/exposure.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { deferredToolCallEntry } from "../src/tool/handlers/deferred-tool-call.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import type { ToolEntry } from "../src/tool/types.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import type { ToolExecutorOptions } from "../src/tool/executor/types.js";
import { resolveDeferredToolCall } from "../src/tool/deferred-call.js";

function fixture(
  overrides: Partial<ToolEntry> = {},
  executorOptions: Partial<ToolExecutorOptions> = {},
) {
  const registry = createToolRegistry();
  const handler = vi.fn(async (input: unknown) => input);
  const target: ToolEntry = {
    ...toolSearchToolEntry,
    aliases: undefined,
    metadata: {
      ...toolSearchToolEntry.metadata,
      name: "DeferredA",
      description: "A",
      shouldDefer: true,
    },
    inputSchema: {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
      additionalProperties: false,
    },
    runtimeInputSchema: undefined,
    outputSchema: {},
    runtimeOutputSchema: undefined,
    formatModelContent: undefined,
    permission: undefined,
    handler,
    ...overrides,
  };
  registry.register(toolSearchToolEntry);
  registry.register(deferredToolCallEntry);
  registry.register(target);
  registry.register({
    ...target,
    metadata: { ...target.metadata, name: "DeferredB", description: "B" },
  });
  registry.register({
    ...target,
    metadata: { ...target.metadata, name: "Resident", shouldDefer: false },
  });
  const model = createTestRuntimeModel({
    generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
  });
  const expose = (entries: RuntimeMessageEntry[] = []) =>
    buildToolExposure({ model, mode: "local", tools: registry.toContracts(), registry, entries });
  const executor = createToolExecutor({
    registry,
    emitEvent: async () => {},
    permissionService: new PermissionService(defaultPermissionConfig),
    sessionId: createSessionId("local-search"),
    turnId: createTurnId("turn"),
    getMode: () => "yolo",
    ...executorOptions,
  });
  return { registry, target, handler, model, expose, executor };
}

function resultEntry(content: RuntimeMessageEntry["message"]["content"]): RuntimeMessageEntry {
  return { message: { role: "tool", toolName: "ToolSearch", toolCallId: "search", content } };
}
const reference = (toolName: string) => ({ type: "tool_reference" as const, toolName });
const text = (value: unknown) => JSON.stringify(value);

it("executes the LocalToolSearch name through the same canonical handler", async () => {
  const { expose, executor, registry } = fixture();
  expect(registry.list()).not.toContain("LocalToolSearch");
  const result = await executor.execute(
    { id: "local-search", name: "LocalToolSearch", input: { query: "select:DeferredA" } },
    { toolSearch: expose().context },
  );
  expect(result.success).toBe(true);
  expect(result.modelContent).toEqual([{ type: "tool_reference", toolName: "DeferredA" }]);
});

describe("Local ToolSearch request projection", () => {
  it("exposes one concise calling example that satisfies both wrapper and target schemas", () => {
    const { expose } = fixture();
    const description = expose().tools.find(
      (tool) => tool.name === "LocalToolSearch",
    )!.description!;
    expect(description).toMatch(/^Fetches .* called using DeferredToolCall\./);
    expect(description).toContain(
      '"select:TaskStop,mcp__byob__browser_navigate" — fetch these exact deferred tools by name',
    );
    expect(description).not.toContain("select:Read,Edit,Grep");
    expect(description).toContain("Call resident tools directly using their normal tool calls");
    expect(description).toContain(
      "For deferred tools, parameters describes the input object passed to DeferredToolCall.",
    );
    expect(description).not.toContain("does not change a tool's classification");
    expect(description).not.toContain("the same encoding");
    expect(description).not.toContain("<commentary>");
    const examples = [...description.matchAll(/<example>([\s\S]*?)<\/example>/g)];
    expect(examples).toHaveLength(1);
    const json = examples[0]![1]!.match(/DeferredToolCall\(([^\n]+)\)/)?.[1];
    const call = DeferredToolCallInputSchema.parse(JSON.parse(json!));
    expect(call.name).toBe("TaskStop");
    expect(TaskStopInputSchema.parse(call.input)).toEqual(call.input);
    // 参数值只能是占位符，不能是模型可能照抄的虚构 task_id。
    expect(call.input).toEqual({ task_id: expect.stringMatching(/^<.+>$/) });
  });

  it("expands a reference run in one functions block without changing tools or raw history", () => {
    const { expose } = fixture();
    const entries = [resultEntry([reference("DeferredA"), reference("DeferredB")])];
    const original = structuredClone(entries);
    const initial = expose();
    const searched = expose(entries);
    expect(initial.tools.map((tool) => tool.name)).toEqual([
      "LocalToolSearch",
      "DeferredToolCall",
      "Resident",
    ]);
    expect(searched.tools).toEqual(initial.tools);
    const content = text(searched.entries[0]?.message.content);
    expect(content.match(/<functions>/g)).toHaveLength(1);
    expect(content.match(/<function>/g)).toHaveLength(2);
    expect(content).toContain("parameters");
    expect(content).not.toContain("tool_reference");
    expect(searched.tools.some((tool) => tool.deferLoading)).toBe(false);
    expect(entries).toEqual(original);
    expect([...searched.context.discovered]).toEqual(["DeferredA", "DeferredB"]);
  });

  it("keeps intervening text and separate results in order and removes unavailable references", () => {
    const { expose } = fixture();
    const entries = [
      resultEntry([
        reference("DeferredA"),
        { type: "text" as const, text: "HOOK" },
        reference("missing"),
        reference("DeferredB"),
      ]),
      resultEntry([reference("DeferredA")]),
    ];
    const projected = expose(entries).entries;
    const content = text(projected[0]?.message.content);
    expect(content.match(/<functions>/g)).toHaveLength(2);
    expect(content.indexOf("DeferredA")).toBeLessThan(content.indexOf("HOOK"));
    expect(content.indexOf("HOOK")).toBeLessThan(content.indexOf("DeferredB"));
    expect(content).not.toContain("missing");
    expect(text(projected[1]?.message.content).match(/<functions>/g)).toHaveLength(1);
    expect(text(expose([resultEntry([reference("missing")])]).entries)).toContain(
      "tools no longer available",
    );
  });

  it("returns the active Local definition when directly selecting a resident control", () => {
    const { expose } = fixture();
    const result = expose([resultEntry([reference("ToolSearch")])]);
    const content = result.entries[0]!.message.content;
    if (!Array.isArray(content) || content[0]?.type !== "text")
      throw new Error("Expected expanded definition");
    const definition = JSON.parse(
      content[0].text.split("\n")[1]!.slice("<function>".length, -"</function>".length),
    );
    expect(definition.description).toBe(
      result.tools.find((tool) => tool.name === "LocalToolSearch")?.description,
    );
  });

  it("promotes checkpoint definitions into ordinary tools without synthetic results", () => {
    const { expose } = fixture();
    const entries: RuntimeMessageEntry[] = [
      {
        message: { role: "user", content: "summary" },
        metadata: {
          compactBoundary: { boundaryId: "boundary", preCompactDiscoveredTools: ["DeferredA"] },
        },
      },
    ];
    const result = expose(entries);
    expect([...result.context.discovered]).toEqual(["DeferredA"]);
    expect(text(result.entries)).not.toContain("<functions>");
    expect(result.tools.find((tool) => tool.name === "DeferredA")).toMatchObject({
      name: "DeferredA",
    });
    expect(result.tools.find((tool) => tool.name === "DeferredA")?.deferLoading).toBeUndefined();
  });
});

describe("DeferredToolCall execution", () => {
  it("normalizes once and isolates nested handler mutations from the model input", async () => {
    const { registry, expose, executor } = fixture({
      inputSchema: { type: "object" },
      handler: async (input) => {
        (input as { nested: { values: number[] } }).nested.values.push(2);
        return input;
      },
    });
    const raw = {
      id: "isolated",
      name: "DeferredToolCall",
      input: { name: "DeferredA", input: { nested: { values: [1] } } },
    };
    const context = expose().context;
    const admitted = resolveDeferredToolCall(raw, context, registry).call;
    expect(admitted).toEqual({
      id: raw.id,
      name: "DeferredA",
      input: raw.input.input,
      modelCallWrapper: "DeferredToolCall",
    });
    expect(resolveDeferredToolCall(admitted, context, registry).call).toBe(admitted);
    const result = await executor.execute(admitted, { toolSearch: context });
    expect(result.success).toBe(true);
    expect(raw.input.input.nested.values).toEqual([1]);
    expect(admitted.input).toEqual(raw.input.input);
  });

  it.each(["allow", "deny"] as const)(
    "uses target approval and terminal behavior: %s",
    async (decision) => {
      const permission = vi.fn(async () => ({ decision }));
      const { executor, expose, handler } = fixture(
        {
          metadata: {
            ...toolSearchToolEntry.metadata,
            name: "DeferredA",
            shouldDefer: true,
            readOnly: false,
            concurrentSafe: false,
            needsApproval: true,
            sideEffectScope: "workspace",
            riskLevel: "medium",
            stopTurnOnSuccess: true,
          },
        },
        { getMode: () => "default", permissionBroker: { requestPermission: permission } },
      );
      for (const wrapped of [false, true]) {
        const result = await executor.execute(
          {
            id: "approval",
            name: wrapped ? "DeferredToolCall" : "DeferredA",
            input: wrapped ? { name: "DeferredA", input: { value: 1 } } : { value: 1 },
          },
          { toolSearch: expose().context },
        );
        expect(result.success).toBe(decision === "allow");
        expect(result.turnControl?.stopTurnAfterResult).toBe(
          decision === "allow" ? true : undefined,
        );
      }
      expect(permission).toHaveBeenCalledTimes(2);
      for (const [request] of permission.mock.calls)
        expect(request).toMatchObject({ toolName: "DeferredA" });
      expect(handler).toHaveBeenCalledTimes(decision === "allow" ? 2 : 0);
    },
  );

  it.each([
    null,
    [],
    { name: "DeferredA", input: "{}" },
    { name: "DeferredA", input: [] },
    { name: "DeferredA", input: {}, id: "nested" },
    { name: "DeferredA" },
  ])("rejects malformed wrapper input before target hooks: %j", async (input) => {
    const hook = vi.fn(async () => ({}));
    const { executor, expose, handler } = fixture(
      {},
      {
        hookRunner: createInMemoryHookRunner({
          hooks: [{ event: "PreToolUse", matcher: "DeferredA", callback: hook }],
        }),
      },
    );
    const result = await executor.execute(
      { id: "malformed", name: "DeferredToolCall", input },
      { toolSearch: expose().context },
    );
    expect(result.success).toBe(false);
    expect(result.modelContent).toContain("InputValidationError");
    expect(handler).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it("uses the target for hooks, media, handler errors and cancellation", async () => {
    const callback = vi.fn(async (input) => ({
      hookSpecificOutput: { hookEventName: input.hookEventName, additionalContext: "TARGET_HOOK" },
    }));
    const { executor, expose, handler } = fixture(
      {
        formatModelContent: () => [
          { type: "text", text: "target output" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
      {
        hookRunner: createInMemoryHookRunner({
          hooks: [{ event: "PostToolUse", matcher: "DeferredA", callback }],
        }),
      },
    );
    const execute = (wrapped: boolean, signal?: AbortSignal) =>
      executor.execute(
        {
          id: "same",
          name: wrapped ? "DeferredToolCall" : "DeferredA",
          input: wrapped ? { name: "DeferredA", input: { value: 1 } } : { value: 1 },
        },
        { toolSearch: expose().context, signal },
      );
    const direct = await execute(false);
    const wrapped = await execute(true);
    expect(wrapped.modelContent).toEqual(direct.modelContent);
    expect(wrapped.hookAdditionalContexts).toEqual(direct.hookAdditionalContexts);
    expect(wrapped.hookAdditionalContexts).toEqual([
      expect.stringMatching(/^\w+:DeferredA hook additional context: TARGET_HOOK$/),
    ]);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(2);
    const cancelled = await execute(true, AbortSignal.abort());
    expect(cancelled.success).toBe(false);
    expect(handler).toHaveBeenCalledTimes(2);
    handler.mockRejectedValueOnce(new Error("target failed"));
    const failedDirect = await execute(false);
    handler.mockRejectedValueOnce(new Error("target failed"));
    const failedWrapped = await execute(true);
    expect(failedWrapped.error?.message).toEqual(failedDirect.error?.message);
    expect(failedWrapped.modelContent).toEqual(failedDirect.modelContent);
  });

  it("rejects provider-native targets and follows current deferred classification", async () => {
    const { registry, target, expose, executor, handler } = fixture();
    registry.register(
      { ...target, providerNative: { type: "test" } as never },
      { silentDuplicateWarning: true },
    );
    const call = {
      id: "classification",
      name: "DeferredToolCall",
      input: { name: "DeferredA", input: { value: 1 } },
    };
    expect((await executor.execute(call, { toolSearch: expose().context })).success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    registry.register(target, { silentDuplicateWarning: true });
    expect((await executor.execute(call, { toolSearch: expose().context })).success).toBe(true);
    registry.register(
      { ...target, metadata: { ...target.metadata, alwaysLoad: true } },
      { silentDuplicateWarning: true },
    );
    expect((await executor.execute(call, { toolSearch: expose().context })).success).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("uses the ordinary target execution and error formatting with the original call ID", async () => {
    const { executor, expose, handler } = fixture();
    const toolSearch = expose().context;
    const wrapped = await executor.execute(
      {
        id: "wrapped",
        name: "DeferredToolCall",
        input: { name: "DeferredA", input: { value: 7 } },
      },
      { toolSearch },
    );
    expect(wrapped).toMatchObject({ success: true, toolCallId: "wrapped", toolName: "DeferredA" });
    expect(handler).toHaveBeenCalledExactlyOnceWith(
      { value: 7 },
      expect.objectContaining({ toolCallId: "wrapped" }),
    );
    const directError = await executor.execute(
      { id: "direct-error", name: "DeferredA", input: {} },
      { toolSearch },
    );
    const wrappedError = await executor.execute(
      { id: "wrapped-error", name: "DeferredToolCall", input: { name: "DeferredA", input: {} } },
      { toolSearch },
    );
    expect(wrappedError.modelContent).toEqual(directError.modelContent);
    expect(wrappedError.error?.type).toEqual(directError.error?.type);
  });

  it.each(["Resident", "ToolSearch", "DeferredToolCall", "missing"])(
    "rejects %s before target execution",
    async (name) => {
      const { executor, expose, handler } = fixture();
      const result = await executor.execute(
        { id: "rejected", name: "DeferredToolCall", input: { name, input: { value: 1 } } },
        { toolSearch: expose().context },
      );
      expect(result).toMatchObject({
        success: false,
        toolCallId: "rejected",
        toolName: "DeferredToolCall",
      });
      if (name === "Resident") expect(result.error?.message).toContain("directly");
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("rejects disabled, native, excluded and currently always-loaded targets", async () => {
    const { executor, expose, handler, registry, target } = fixture();
    const context = expose().context;
    const contexts: ToolSearchExecutionContext[] = [
      { ...context, mode: "off", enabled: false },
      { ...context, mode: "native" },
      { ...context, catalog: [] },
    ];
    registry.register(
      { ...target, metadata: { ...target.metadata, alwaysLoad: true } },
      { silentDuplicateWarning: true },
    );
    contexts.push(expose().context);
    for (const toolSearch of contexts) {
      const result = await executor.execute(
        {
          id: "rejected",
          name: "DeferredToolCall",
          input: { name: "DeferredA", input: { value: 1 } },
        },
        { toolSearch },
      );
      expect(result.success).toBe(false);
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
