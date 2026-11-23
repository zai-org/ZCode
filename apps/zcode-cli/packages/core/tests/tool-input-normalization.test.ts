import { describe, expect, it } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  markUnparsedToolInput,
} from "@zcode/contracts";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import { createManualPermissionBroker } from "../src/permission/broker.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../src/tool/types.js";

describe("tool execution input normalization", () => {
  it("safe-parses stringified JSON before tool execution when adapter input is still a string", async () => {
    const sessionId = createSessionId("tool-input-string");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    let capturedInput: unknown;

    registry.register(
      createToolEntry({
        name: "StringInputTool",
        runtimeInputSchema: objectRuntimeSchema((value) =>
          typeof value.value === "string" ? { value: value.value } : undefined,
        ),
        handler: async (input) => {
          capturedInput = input;
          return "ok";
        },
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
          required: ["value"],
          additionalProperties: false,
        },
      }),
    );

    const executor = createToolExecutor({
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("string-input"),
        input: '{"value":"from-string"}',
        name: "StringInputTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(capturedInput).toEqual({ value: "from-string" });
  });

  it("applies runtime schema defaults before hooks and handlers", async () => {
    const sessionId = createSessionId("tool-input-defaults");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    let hookSawInput: unknown;
    let handlerSawInput: unknown;

    registry.register(
      createToolEntry({
        name: "DefaultingTool",
        runtimeInputSchema: objectRuntimeSchema((value) => ({
          flag: typeof value.flag === "boolean" ? value.flag : false,
        })),
        handler: async (input) => {
          handlerSawInput = input;
          return "ok";
        },
        inputSchema: {
          type: "object",
          properties: {
            flag: { type: "boolean" },
          },
          additionalProperties: false,
        },
      }),
    );

    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: "PreToolUse",
          matcher: "DefaultingTool",
          callback: async (input) => {
            hookSawInput = input.toolInput;
            return undefined;
          },
        },
      ],
    });

    const executor = createToolExecutor({
      emitEvent: async () => {},
      hookRunner,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("defaulting-input"),
        input: {},
        name: "DefaultingTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(hookSawInput).toEqual({ flag: false });
    expect(handlerSawInput).toEqual({ flag: false });
  });

  it("returns exact initial validation content for an adapter-normalized empty object", async () => {
    const sessionId = createSessionId("tool-input-malformed");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    let handlerRan = false;

    registry.register(
      createToolEntry({
        name: "AskUserQuestion",
        runtimeInputSchema: objectRuntimeSchema((value) =>
          Array.isArray(value.questions) ? { questions: value.questions } : undefined,
        ),
        handler: async () => {
          handlerRan = true;
          return "ok";
        },
        inputSchema: {
          type: "object",
          properties: {
            questions: { type: "array" },
          },
          required: ["questions"],
          additionalProperties: false,
        },
      }),
    );

    const executor = createToolExecutor({
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("malformed-input"),
        input: {},
        name: "AskUserQuestion",
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result).toMatchObject({
      toolCallId: createToolCallId("malformed-input"),
      toolName: "AskUserQuestion",
    });
    expect(result.error?.message).toBe("Tool input failed inputSchema validation");
    expect(result.modelContent).toBe(
      [
        "<tool_use_error>InputValidationError: AskUserQuestion failed due to the following issue:",
        "The required parameter `questions` is missing</tool_use_error>",
      ].join("\n"),
    );
    expect(handlerRan).toBe(false);
  });

  it("returns the unparsed-JSON error instead of running a tool that accepts {}", async () => {
    const sessionId = createSessionId("tool-input-unparsed");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    let handlerRan = false;
    registry.register(
      createToolEntry({
        aliases: ["unparsed_alias"],
        name: "OptionalInputTool",
        runtimeInputSchema: objectRuntimeSchema(() => ({})),
        handler: async () => {
          handlerRan = true;
          return "ran";
        },
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
      }),
    );
    const executor = createToolExecutor({
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });
    const raw = '{"value":"C:\\path"}';

    const result = await executor.execute(
      {
        id: createToolCallId("unparsed-input"),
        input: markUnparsedToolInput(raw),
        name: "unparsed_alias",
      },
      { traceContext },
    );

    expect(handlerRan).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe("Tool input could not be parsed as JSON");
    expect(result.modelContent).toBe(
      [
        "<tool_use_error>InputValidationError: OptionalInputTool was called with input that could not be parsed as JSON.",
        `You sent (first ${raw.length} of ${raw.length} bytes): ${raw}`,
        "Common causes: unescaped backslashes in file paths (use / or \\\\), unescaped control characters, or truncated output. Retry with valid JSON.</tool_use_error>",
      ].join("\n"),
    );
  });

  it("uses the canonical tool name in initial validation content", async () => {
    const sessionId = createSessionId("tool-input-alias-validation");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();

    registry.register(
      createToolEntry({
        aliases: ["validation_alias"],
        name: "CanonicalValidationTool",
        runtimeInputSchema: objectRuntimeSchema((value) =>
          typeof value.value === "string" ? { value: value.value } : undefined,
        ),
        handler: async () => "ok",
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
          required: ["value"],
          additionalProperties: false,
        },
      }),
    );

    const executor = createToolExecutor({
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("alias-validation"),
        input: {},
        name: "validation_alias",
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.toolName).toBe("CanonicalValidationTool");
    expect(result.modelContent).toContain(
      "InputValidationError: CanonicalValidationTool failed due to the following issue:",
    );
  });

  // 规则见根目录 docs/model-tool-call-validation.md：JSON Schema 通过、runtime schema 失败时，
  // 在 validateInput、hook 与权限之前返回 InputValidationError。
  it("rejects a runtime-only parser issue before validateInput, hooks, and the handler", async () => {
    const sessionId = createSessionId("tool-input-runtime-only-issue");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    let handlerRan = false;
    let validateInputRan = false;
    let hookRan = false;

    registry.register({
      ...createToolEntry({
        name: "RuntimeOnlyValidationTool",
        runtimeInputSchema: {
          safeParse: () => ({
            success: false,
            error: {
              issues: [{ code: "custom", path: ["value"], message: "runtime-only issue" }],
            },
          }),
        },
        handler: async () => {
          handlerRan = true;
          return "ok";
        },
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
          required: ["value"],
          additionalProperties: false,
        },
      }),
      validateInput: () => {
        validateInputRan = true;
        return { result: true };
      },
    });

    const executor = createToolExecutor({
      emitEvent: async () => {},
      hookRunner: createInMemoryHookRunner({
        hooks: [
          {
            event: "PreToolUse",
            matcher: "RuntimeOnlyValidationTool",
            callback: async () => {
              hookRan = true;
              return {};
            },
          },
        ],
      }),
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("runtime-only-issue"),
        input: { value: "accepted-by-json-schema" },
        name: "RuntimeOnlyValidationTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.modelContent).toBe(`<tool_use_error>InputValidationError: [
  {
    "code": "custom",
    "path": [
      "value"
    ],
    "message": "runtime-only issue"
  }
]</tool_use_error>`);
    expect(validateInputRan).toBe(false);
    expect(hookRan).toBe(false);
    expect(handlerRan).toBe(false);
  });

  it("keeps the original flow when the runtime parser reports no readable issues", async () => {
    const sessionId = createSessionId("tool-input-runtime-no-issues");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    let handlerSawInput: unknown;

    registry.register(
      createToolEntry({
        name: "RuntimeNoIssuesTool",
        runtimeInputSchema: objectRuntimeSchema(() => undefined),
        handler: async (input) => {
          handlerSawInput = input;
          return "ok";
        },
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
          required: ["value"],
          additionalProperties: false,
        },
      }),
    );

    const executor = createToolExecutor({
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const input = { value: "accepted-by-json-schema" };
    const result = await executor.execute(
      {
        id: createToolCallId("runtime-no-issues"),
        input,
        name: "RuntimeNoIssuesTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(handlerSawInput).toEqual(input);
  });

  it("re-normalizes hook-updated stringified input before permission and handler execution", async () => {
    const sessionId = createSessionId("tool-input-hook-update");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    let handlerSawInput: unknown;

    registry.register(
      createToolEntry({
        name: "HookUpdatedInputTool",
        runtimeInputSchema: objectRuntimeSchema((value) =>
          typeof value.value === "string" ? { value: value.value } : undefined,
        ),
        handler: async (input) => {
          handlerSawInput = input;
          return "ok";
        },
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
          required: ["value"],
          additionalProperties: false,
        },
      }),
    );

    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: "PreToolUse",
          matcher: "HookUpdatedInputTool",
          callback: async () => ({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              updatedInput: '{"value":"from-hook"}',
            },
          }),
        },
      ],
    });

    const executor = createToolExecutor({
      emitEvent: async () => {},
      hookRunner,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("hook-updated-input"),
        input: { value: "initial" },
        name: "HookUpdatedInputTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(handlerSawInput).toEqual({ value: "from-hook" });
  });

  it("re-normalizes broker-modified stringified input before handler execution", async () => {
    const sessionId = createSessionId("tool-input-broker-update");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const permissionBroker = createManualPermissionBroker({
      onRequest: (request) => {
        permissionBroker.resolvePermission(request.requestId, {
          decision: "modify",
          modifiedInput: '{"value":"from-broker"}',
        });
      },
    });
    let handlerSawInput: unknown;

    registry.register(
      createToolEntry({
        name: "BrokerUpdatedInputTool",
        needsApproval: true,
        runtimeInputSchema: objectRuntimeSchema((value) =>
          typeof value.value === "string" ? { value: value.value } : undefined,
        ),
        handler: async (input) => {
          handlerSawInput = input;
          return "ok";
        },
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
          required: ["value"],
          additionalProperties: false,
        },
      }),
    );

    const executor = createToolExecutor({
      emitEvent: async () => {},
      permissionBroker,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("broker-updated-input"),
        input: { value: "initial" },
        name: "BrokerUpdatedInputTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(handlerSawInput).toEqual({ value: "from-broker" });
  });

  it("does not apply initial validation content to broker-modified input", async () => {
    const sessionId = createSessionId("tool-input-broker-invalid");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const permissionBroker = createManualPermissionBroker({
      onRequest: (request) => {
        permissionBroker.resolvePermission(request.requestId, {
          decision: "modify",
          modifiedInput: {},
        });
      },
    });

    registry.register(
      createToolEntry({
        name: "BrokerInvalidInputTool",
        needsApproval: true,
        runtimeInputSchema: objectRuntimeSchema((value) =>
          typeof value.value === "string" ? { value: value.value } : undefined,
        ),
        handler: async () => "should-not-run",
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
          required: ["value"],
          additionalProperties: false,
        },
      }),
    );

    const executor = createToolExecutor({
      emitEvent: async () => {},
      permissionBroker,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("broker-invalid-input"),
        input: { value: "initial" },
        name: "BrokerInvalidInputTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe("Tool input failed inputSchema validation");
    expect(result.modelContent).toBeUndefined();
  });
});

function createToolEntry(options: {
  aliases?: readonly string[];
  name: string;
  handler: ToolHandler;
  inputSchema: ToolEntry["inputSchema"];
  needsApproval?: boolean;
  runtimeInputSchema: unknown;
}): ToolEntry {
  const needsApproval = options.needsApproval ?? false;

  return {
    aliases: options.aliases,
    capability: `${options.name} test capability`,
    metadata: {
      concurrentSafe: true,
      destructive: false,
      name: options.name,
      needsApproval,
      readOnly: true,
      riskLevel: needsApproval ? "medium" : "low",
      sideEffectScope: "none",
      timeoutMs: 30000,
    },
    handler: async (input: unknown, context: ToolExecutionContext) =>
      options.handler(input, context),
    inputSchema: options.inputSchema,
    outputSchema: {
      type: "string",
    },
    permission: {
      permission: "test",
      reason: "test tool",
      riskLevel: needsApproval ? "medium" : "low",
      sideEffectScope: "none",
      needsApproval,
      patternSources: ["none"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: 100_000,
      maxModelBytes: 100_000,
      strategy: "truncate",
    },
    runtimeInputSchema: options.runtimeInputSchema,
    timeout: {
      defaultMs: 30000,
      maxMs: 30000,
      allowCallOverride: false,
    },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "Test tool was cancelled",
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}

function objectRuntimeSchema<T extends Record<string, unknown>>(
  normalize: (value: Record<string, unknown>) => T | undefined,
): { safeParse: (value: unknown) => { success: true; data: T } | { success: false } } {
  return {
    safeParse(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { success: false };
      }

      const normalized = normalize(value as Record<string, unknown>);
      if (!normalized) {
        return { success: false };
      }

      return {
        success: true,
        data: normalized,
      };
    },
  };
}
