import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  CoreErrorType,
  createRootTraceContext,
  createProjectId,
  createSessionId,
  createToolCallId,
  createTurnId,
  HookEventName,
  SessionEventType,
  type SessionEvent,
  type ExecutionPort,
  type PermissionBrokerPort,
  type PermissionRuleset,
  type ProjectId,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
  type ToolArtifactStorePort,
  type ToolArtifactReadRequest,
  type ToolArtifactWriteRequest,
} from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@zcode/shared";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createConfiguredHookRunner, createInMemoryHookRunner } from "../src/hooks/index.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../src/tool/types.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

describe("ToolExecutor trace propagation", () => {
  it("preserves Skill metadata when the handler fails", async () => {
    const sessionId = createSessionId("skill-error-metadata");
    const turnId = createTurnId("skill-error-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const toolCallId = createToolCallId("skill-error-call");
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "Skill",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "session",
      },
      handler: async (_input, context) => {
        context.recordSkillTelemetryMetadata?.({
          name: "pptx",
          qualifiedName: "document-skills:pptx",
          pluginId: "document-skills@zcode-plugins-official",
          source: "plugin",
        });
        throw new Error("post hook failed");
      },
    });
    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    await executor.execute({ id: toolCallId, input: {}, name: "Skill" }, { traceContext });

    const errorEvent = events.find((event) => event.type === SessionEventType.ToolCallError);
    expect(errorEvent?.payload).toMatchObject({
      toolCallId,
      skillMetadata: {
        name: "pptx",
        qualifiedName: "document-skills:pptx",
        pluginId: "document-skills@zcode-plugins-official",
        source: "plugin",
      },
    });
  });

  it("emits ToolCallError when a model calls a tool missing from the registry", async () => {
    const sessionId = createSessionId("tool-registry-miss");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const toolCallId = createToolCallId("missing-call");
    const events: SessionEvent[] = [];
    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry: createToolRegistry(),
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: toolCallId,
        input: { pattern: "stale tool contract" },
        name: "GrepMissingFromRegistry",
      },
      { traceContext },
    );

    expect(result).toMatchObject({
      success: false,
      error: { type: CoreErrorType.ToolNotFound },
      toolCallId,
    });
    expect(events.map((event) => event.type)).toEqual([SessionEventType.ToolCallError]);
    expect(events[0]?.payload).toMatchObject({
      toolCallId,
      error: { type: CoreErrorType.ToolNotFound },
    });
  });

  it("emits ToolCallError when the model input fails the tool inputSchema", async () => {
    const sessionId = createSessionId("tool-schema-miss");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const toolCallId = createToolCallId("schema-miss-call");
    const events: SessionEvent[] = [];
    const handler = vi.fn(async () => "must-not-run");
    const registry = createToolRegistry();
    registry.register({
      handler,
      inputSchema: {
        type: "object",
        properties: { script: { type: "string" } },
        additionalProperties: false,
      },
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "CreateWorkflow",
        needsApproval: true,
        readOnly: false,
        riskLevel: "medium",
        sideEffectScope: "workspace",
      },
    });
    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    // 真实样本：GLM 把工具调用标记泄漏进参数名，strict schema 因而拒绝整个调用。
    const result = await executor.execute(
      {
        id: toolCallId,
        input: { "args</arg_key><ac7a3bd7><arg_value>{": '{"topic":"x"}' },
        name: "CreateWorkflow",
      },
      { traceContext },
    );

    expect(result).toMatchObject({
      success: false,
      error: { type: CoreErrorType.ToolExecutionFailed },
      toolCallId,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([SessionEventType.ToolCallError]);
    expect(events[0]?.payload).toMatchObject({
      toolCallId,
      error: { type: CoreErrorType.ToolExecutionFailed },
    });
  });

  it("forces empty names through registry miss before hooks, permission, or handler", async () => {
    const sessionId = createSessionId("empty-tool-registry-miss");
    const turnId = createTurnId("empty-tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const toolCallId = createToolCallId("empty-call");
    const events: SessionEvent[] = [];
    const handler = vi.fn(async () => "must-not-run");
    const registry = createToolRegistry();
    const registryGet = vi.spyOn(registry, "get").mockReturnValue({
      handler,
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "empty_tool_name",
        needsApproval: true,
        readOnly: false,
        riskLevel: "medium",
        sideEffectScope: "workspace",
      },
    });
    const hookRun = vi.fn(async () => ({ additionalContexts: [] }));
    const permissionRequest = vi.fn(async () => ({ decision: "allow" as const }));
    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      hookRunner: { run: hookRun },
      permissionBroker: { requestPermission: permissionRequest },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: toolCallId,
        input: {},
        name: "  ",
      },
      { traceContext },
    );

    expect(result).toMatchObject({
      error: {
        message: "Model returned an invalid tool call: tool name is empty.",
        type: CoreErrorType.ToolNotFound,
      },
      modelContent: "<tool_use_error>Error: No such tool available:   </tool_use_error>",
      success: false,
      toolCallId,
      toolName: "  ",
    });
    expect(registryGet).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(hookRun).not.toHaveBeenCalled();
    expect(permissionRequest).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([SessionEventType.ToolCallError]);
  });

  it("executes a registered tool whose legitimate name is empty_tool_name", async () => {
    const sessionId = createSessionId("legitimate-placeholder-tool");
    const turnId = createTurnId("legitimate-placeholder-tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const toolCallId = createToolCallId("legitimate-placeholder-call");
    const events: SessionEvent[] = [];
    const handler = vi.fn(async () => "ok");
    const registry = createToolRegistry();
    registry.register(createContractToolEntry({ name: "empty_tool_name", handler }));
    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: toolCallId,
        input: {},
        name: "empty_tool_name",
      },
      { traceContext },
    );

    expect(result).toMatchObject({
      success: true,
      toolCallId,
      toolName: "empty_tool_name",
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallResult,
    ]);
  });

  it("passes the parent trace id into emitted events and tool context", async () => {
    const sessionId = createSessionId("tool-trace");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const toolCallId = createToolCallId("call");
    const events: SessionEvent[] = [];
    let capturedContext: ToolExecutionContext | undefined;
    const registry = createToolRegistry();

    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "TraceTool",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async (_input, context) => {
        capturedContext = context;
        return "ok";
      },
    });

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: toolCallId,
        input: {},
        name: "TraceTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(capturedContext?.traceId).toBe(traceContext.traceId);
    expect(capturedContext?.spanId).toBeDefined();
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallResult,
    ]);
    expect(new Set(events.map((event) => event.traceId))).toEqual(new Set([traceContext.traceId]));
  });

  it("keeps every tool call bound to the executor Active Model", async () => {
    const sessionId = createSessionId("tool-model-ref");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const capturedModels: ToolExecutionContext["model"][] = [];
    const activeModel = createTestRuntimeModel({
      generateText: async () => ({ finishReason: "stop", text: "" }),
      providerId: "智谱",
      modelId: "glm-4.7",
    });

    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "CaptureModelSelection",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async (_input, context) => {
        capturedModels.push(context.model);
        return "ok";
      },
    });

    const executor = createToolExecutor({
      emitEvent: async () => {},
      model: activeModel,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    await executor.execute({
      id: createToolCallId("capture-model-ref-1"),
      input: {},
      name: "CaptureModelSelection",
    });

    await executor.execute({
      id: createToolCallId("capture-model-ref-2"),
      input: {},
      name: "CaptureModelSelection",
    });

    // 工具拿到的是 executor Active Model 的同一身份与配置；executor 会包一层默认状态汇
    // （withDefaultToolModelStatusSink，docs/dynamic-workflow/concurrency.md「Tool-side requests」），
    // 所以比身份而非引用，并确认请求确实落到同一个 Active Model 上。
    const identityOf = (model: ToolExecutionContext["model"]) =>
      model && {
        providerId: model.providerId,
        modelId: model.modelId,
        options: model.options,
        optionSpecs: model.optionSpecs,
        properties: model.properties,
      };
    expect(capturedModels.map(identityOf)).toEqual([
      identityOf(activeModel),
      identityOf(activeModel),
    ]);
    for (const captured of capturedModels) {
      await expect(captured!.generateText({ messages: [] })).resolves.toEqual({
        finishReason: "stop",
        text: "",
      });
    }
  });

  it("passes enabled embedded search context into tool handlers by default", async () => {
    const sessionId = createSessionId("tool-embedded-search");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const backend = {
      kind: "internal-cli" as const,
      command: "zcode",
      args: ["__internal-search"],
    };
    let capturedContext: ToolExecutionContext | undefined;

    registry.register(
      createContractToolEntry({
        name: "Bash",
        handler: async () => "ok",
      }),
    );
    registry.register(
      createContractToolEntry({
        name: "CaptureEmbeddedSearch",
        handler: async (_input, context) => {
          capturedContext = context;
          return "ok";
        },
      }),
    );

    const executor = createToolExecutor({
      embeddedSearchBackend: backend,
      emitEvent: async () => {},
      model: createTestRuntimeModel({
        generateText: async () => ({ finishReason: "stop", text: "" }),
        providerId: "anthropic",
        modelId: "claude-opus-4-8-cc",
      }),
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute({
      id: createToolCallId("capture-embedded-search"),
      input: {},
      name: "CaptureEmbeddedSearch",
    });

    expect(result.success).toBe(true);
    expect(capturedContext?.embeddedSearch).toEqual({
      enabled: true,
      backend,
    });
  });

  it("keeps embedded search visible while disabling Session find and grep enhancements", async () => {
    const sessionId = createSessionId("tool-native-search-disabled");
    const registry = createToolRegistry();
    const backend = {
      kind: "native-binaries" as const,
      findCommand: "/tools/bfs",
      grepCommand: "/tools/ugrep",
      rgCommand: "/tools/rg",
    };
    let capturedContext: ToolExecutionContext | undefined;
    registry.register(createContractToolEntry({ name: "Bash", handler: async () => "ok" }));
    registry.register(
      createContractToolEntry({
        name: "CaptureEmbeddedSearch",
        handler: async (_input, context) => {
          capturedContext = context;
          return "ok";
        },
      }),
    );

    const executor = createToolExecutor({
      embeddedSearchBackend: backend,
      emitEvent: async () => {},
      model: createTestRuntimeModel({
        generateText: async () => ({ finishReason: "stop", text: "" }),
        providerId: "anthropic",
        modelId: "claude-opus-4-8-cc",
      }),
      nativeSearchEnhancementsEnabled: false,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
    });

    await executor.execute({
      id: createToolCallId("capture-native-search-disabled"),
      input: {},
      name: "CaptureEmbeddedSearch",
    });

    expect(capturedContext?.embeddedSearch).toEqual({
      enabled: true,
      backend,
      findAndGrepEnabled: false,
    });
  });

  it("emits bounded file diff display data for file mutation outputs", async () => {
    const sessionId = createSessionId("tool-file-diff-display");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();

    registry.register(
      createContractToolEntry({
        name: "WriteLike",
        outputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            structuredPatch: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
              },
            },
          },
          required: ["filePath", "structuredPatch"],
          additionalProperties: true,
        },
        handler: async () => ({
          filePath: "/work/demo.ts",
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-old", "+new"],
            },
          ],
        }),
      }),
    );

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("call-file-diff"),
        input: {},
        name: "WriteLike",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    const resultEvent = events.find((event) => event.type === SessionEventType.ToolCallResult);
    expect((resultEvent?.payload as any).result.display).toEqual({
      kind: "file_diff",
      filePath: "/work/demo.ts",
      additions: 1,
      deletions: 1,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-old", "+new"],
        },
      ],
      truncated: false,
    });
  });

  it("emits SendMessage business failures as structured display data", async () => {
    const sessionId = createSessionId("tool-send-message-display");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    const output = {
      status: "failed",
      messageId: "msg_failed",
      agentId: "agent_missing",
      error: "No active local_agent task found for target agent_missing.",
      message: "The target agent is no longer running.",
    };

    registry.register(
      createContractToolEntry({
        name: "SendMessage",
        outputSchema: {
          type: "object",
          properties: {
            status: { type: "string" },
            messageId: { type: "string" },
            agentId: { type: "string" },
            error: { type: "string" },
            message: { type: "string" },
          },
          required: ["status", "messageId"],
          additionalProperties: true,
        },
        handler: async () => output,
        formatModelContent: (value) => (value as typeof output).message,
      }),
    );

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("call-send-message-display"),
        input: {},
        name: "SendMessage",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    const resultEvent = events.find((event) => event.type === SessionEventType.ToolCallResult);
    if (resultEvent?.type !== SessionEventType.ToolCallResult) {
      throw new Error("Expected SendMessage ToolCallResult event");
    }
    expect(resultEvent.payload.result).toMatchObject({
      success: true,
      content: "The target agent is no longer running.",
      display: {
        kind: "local_agent_message",
        status: "failed",
        error: "No active local_agent task found for target agent_missing.",
        message: "The target agent is no longer running.",
      },
    });
  });

  it("keeps TaskStop display data separate from hook-augmented model content", async () => {
    const sessionId = createSessionId("tool-task-stop-display");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    const output = {
      message: "Successfully stopped task: task_alpha (pnpm test)",
      task_id: "task_alpha",
      task_type: "background_shell",
      command: "pnpm test",
    };

    registry.register(
      createContractToolEntry({
        name: "TaskStop",
        outputSchema: {
          type: "object",
          properties: {
            message: { type: "string" },
            task_id: { type: "string" },
            task_type: { type: "string" },
            command: { type: "string" },
          },
          required: ["message", "task_id", "task_type"],
          additionalProperties: false,
        },
        handler: async () => output,
        formatModelContent: (value) => JSON.stringify(value),
      }),
    );
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: "PostToolUse",
          matcher: "TaskStop",
          callback: async (input) => ({
            hookSpecificOutput: {
              hookEventName: input.hookEventName,
              additionalContext: "extra post context",
            },
          }),
        },
      ],
    });
    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      hookRunner,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("call-task-stop-display"),
        input: {},
        name: "TaskStop",
      },
      { traceContext },
    );

    expect(JSON.stringify(result.modelContent)).not.toContain("extra post context");
    expect(result.hookAdditionalContexts).toEqual([
      "PostToolUse:TaskStop hook additional context: extra post context",
    ]);
    const resultEvent = events.find((event) => event.type === SessionEventType.ToolCallResult);
    if (resultEvent?.type !== SessionEventType.ToolCallResult) {
      throw new Error("Expected TaskStop ToolCallResult event");
    }
    expect(resultEvent.payload.result).toMatchObject({
      success: true,
      display: {
        kind: "task_stop",
        taskId: "task_alpha",
        taskType: "background_shell",
        command: "pnpm test",
        message: "Successfully stopped task: task_alpha",
      },
    });
    expect(resultEvent.payload.result.content).toContain(
      "Successfully stopped task: task_alpha (pnpm test)",
    );
    // Hook 文本只进工具批次后的附件，不进 tool_call_result 事件和工具卡。
    expect(resultEvent.payload.result.content).not.toContain("extra post context");
    expect(JSON.stringify(resultEvent.payload.result.display)).not.toContain("extra post context");
  });

  it("fails closed after emitting and resolving a permission request without a broker", async () => {
    const sessionId = createSessionId("tool-permission");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const toolCallId = createToolCallId("call-write");
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();

    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: false,
        destructive: false,
        name: "WriteLike",
        needsApproval: true,
        readOnly: false,
        riskLevel: "medium",
        sideEffectScope: "workspace",
      },
      handler: async () => "should not run",
    });

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      mode: "build",
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: toolCallId,
        input: { file_path: "demo.txt" },
        name: "WriteLike",
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe("permission_denied");
    expect(result.error?.message).toBe(
      "ZCode requested permissions to use WriteLike, but you haven't granted it yet.",
    );
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.PermissionRequested,
      SessionEventType.PermissionResolved,
    ]);
    expect(events[0]?.traceId).toBe(traceContext.traceId);
    expect((events[1]?.payload as any).decision).toBe("deny");
  });

  it("executes the tool after the permission broker approves", async () => {
    const sessionId = createSessionId("tool-permission-allow");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    let brokerSawRequest = false;
    const permissionBroker: PermissionBrokerPort = {
      async requestPermission(request) {
        brokerSawRequest = true;
        expect(request.toolName).toBe("WriteLike");
        expect(request.suggestedPermissionUpdates).toEqual([
          {
            behavior: "allow",
            rules: [{ ruleContent: "demo.txt", toolName: "WriteLike" }],
            type: "addRules",
          },
        ]);
        return { decision: "allow", reason: "approved in test" };
      },
    };

    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: false,
        destructive: false,
        name: "WriteLike",
        needsApproval: true,
        readOnly: false,
        riskLevel: "medium",
        sideEffectScope: "workspace",
      },
      handler: async () => {
        return "write-ok";
      },
    });

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      mode: "build",
      permissionBroker,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("call-write-allow"),
        input: { file_path: "demo.txt" },
        name: "WriteLike",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe("write-ok");
    expect(brokerSawRequest).toBe(true);
    expect((events[0]?.payload as any).suggestedPermissionUpdates).toEqual([
      {
        behavior: "allow",
        rules: [{ ruleContent: "demo.txt", toolName: "WriteLike" }],
        type: "addRules",
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.PermissionRequested,
      SessionEventType.PermissionResolved,
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallResult,
    ]);
    expect((events[1]?.payload as any).decision).toBe("allow");
  });

  it("merges permission wait and handler perf into tool result events", async () => {
    const sessionId = createSessionId("tool-perf-permission");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    const permissionBroker: PermissionBrokerPort = {
      async requestPermission() {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { decision: "allow", reason: "approved in perf test" };
      },
    };

    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: false,
        destructive: false,
        name: "WriteLike",
        needsApproval: true,
        readOnly: false,
        riskLevel: "medium",
        sideEffectScope: "workspace",
      },
      handler: async () => ({
        filePath: "/work/demo.txt",
        content: "demo",
        perf: {
          detail: {
            kind: "filesystem",
            filesystem: {
              writeMs: 7,
              fileCount: 1,
              totalBytes: 4,
              workspaceKind: "local",
            },
          },
        },
      }),
    });

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      mode: "build",
      permissionBroker,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("call-write-perf"),
        input: { file_path: "demo.txt" },
        name: "WriteLike",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    const resultEvent = events.find((event) => event.type === SessionEventType.ToolCallResult);
    expect((resultEvent?.payload as any).result.perf).toMatchObject({
      permissionWaitMs: expect.any(Number),
      detail: {
        kind: "filesystem",
        filesystem: {
          writeMs: 7,
          fileCount: 1,
          totalBytes: 4,
          workspaceKind: "local",
        },
      },
    });
  });

  it("blocks tool execution when a PreToolUse hook denies the call", async () => {
    const sessionId = createSessionId("tool-hook-deny");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    let handlerRan = false;

    registry.register(
      createContractToolEntry({
        name: "HookedTool",
        handler: async () => {
          handlerRan = true;
          return "should-not-run";
        },
      }),
    );

    const hookRunner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          event: "PreToolUse",
          matcher: "HookedTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              additionalContext: "explain the hook denial",
              hookEventName: input.hookEventName,
              permissionDecision: "deny",
              permissionDecisionReason: "blocked in test",
            },
          }),
        },
      ],
    });

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      hookRunner,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("hook-deny"),
        input: {},
        name: "HookedTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe("permission_denied");
    expect(result.error?.message).toContain("blocked in test");
    expect(JSON.stringify(result.modelContent ?? "")).not.toContain("explain the hook denial");
    expect(result.hookAdditionalContexts).toEqual([
      "PreToolUse:HookedTool hook additional context: explain the hook denial",
    ]);
    expect(handlerRan).toBe(false);
    expect(events.map((event) => event.type)).toEqual([
      // D20：block 决策只产生一个终态事件（runner.ts:143 为 blocked ? Blocked : Completed）。
      SessionEventType.HookRunStarted,
      SessionEventType.HookRunBlocked,
    ]);
  });

  it("uses modified input returned by a PreToolUse hook", async () => {
    const sessionId = createSessionId("tool-hook-modify");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    let capturedInput: unknown;

    registry.register(
      createContractToolEntry({
        name: "InputTool",
        handler: async (input) => {
          capturedInput = input;
          return "ok";
        },
      }),
    );

    const hookRunner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          event: "PreToolUse",
          matcher: "InputTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              hookEventName: input.hookEventName,
              updatedInput: { value: "after-hook" },
            },
          }),
        },
      ],
    });

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      hookRunner,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("hook-modify"),
        input: { value: "before-hook" },
        name: "InputTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(capturedInput).toEqual({ value: "after-hook" });
  });

  it("runs configured process hooks through ExecutionPort", async () => {
    const sessionId = createSessionId("tool-hook-process");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    let capturedRequest: Parameters<ExecutionPort["run"]>[0] | undefined;
    let capturedInput: unknown;
    const now = new Date();
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return {
          status: "completed",
          exitCode: 0,
          stdout: {
            text: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                updatedInput: { value: "process-hook" },
              },
            }),
            bytes: 84,
            truncated: false,
          },
          stderr: {
            text: "",
            bytes: 0,
            truncated: false,
          },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: now,
          completedAt: now,
        };
      },
    };

    registry.register(
      createContractToolEntry({
        name: "ConfiguredHookTool",
        handler: async (input) => {
          capturedInput = input;
          return "ok";
        },
      }),
    );

    const hookRunner = createConfiguredHookRunner({
      config: {
        enabled: true,
        timeoutMs: 5000,
        maxOutputBytes: 1024,
        events: {
          PreToolUse: [
            {
              matcher: "ConfiguredHookTool",
              hooks: [
                {
                  type: "process",
                  command: "hook-command",
                  args: ["--flag"],
                },
              ],
            },
          ],
        },
      },
      executionPort,
      getWorkingDirectory: () => ".",
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
        id: createToolCallId("hook-process"),
        input: { value: "before" },
        name: "ConfiguredHookTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(capturedInput).toEqual({ value: "process-hook" });
    expect(capturedRequest?.command).toEqual({
      mode: "argv",
      file: "hook-command",
      args: ["--flag"],
    });
    expect(JSON.parse(String(capturedRequest?.stdin))).toMatchObject({
      toolCallId: "tool_hook-process",
      toolInput: { value: "before" },
      toolName: "ConfiguredHookTool",
      tool_input: { value: "before" },
      tool_name: "ConfiguredHookTool",
      tool_use_id: "tool_hook-process",
    });
  });

  it("adds snake_case tool aliases to configured PostToolUse hook stdin", async () => {
    const sessionId = createSessionId("tool-hook-post-alias");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const now = new Date();
    let capturedRequest: Parameters<ExecutionPort["run"]>[0] | undefined;
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return {
          status: "completed",
          exitCode: 0,
          stdout: {
            text: "",
            bytes: 0,
            truncated: false,
          },
          stderr: {
            text: "",
            bytes: 0,
            truncated: false,
          },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: now,
          completedAt: now,
        };
      },
    };

    registry.register(
      createContractToolEntry({
        name: "PostAliasTool",
        handler: async () => "post-output",
      }),
    );

    const hookRunner = createConfiguredHookRunner({
      config: {
        enabled: true,
        timeoutMs: 5000,
        maxOutputBytes: 1024,
        events: {
          PostToolUse: [
            {
              matcher: "PostAliasTool",
              hooks: [
                {
                  type: "command",
                  command: "hook-command",
                },
              ],
            },
          ],
        },
      },
      executionPort,
      getWorkingDirectory: () => ".",
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
        id: createToolCallId("post-alias-call"),
        input: { file_path: "demo.ts" },
        name: "PostAliasTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(String(capturedRequest?.stdin))).toMatchObject({
      hookEventName: "PostToolUse",
      hook_event_name: "PostToolUse",
      toolCallId: "tool_post-alias-call",
      toolInput: { file_path: "demo.ts" },
      toolName: "PostAliasTool",
      toolResultPreview: "post-output",
      tool_response: "post-output",
      tool_input: { file_path: "demo.ts" },
      tool_name: "PostAliasTool",
      tool_use_id: "tool_post-alias-call",
    });
  });

  it("runs configured command hooks through shell with plugin environment", async () => {
    const sessionId = createSessionId("tool-hook-command");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    let capturedRequest: Parameters<ExecutionPort["run"]>[0] | undefined;
    const now = new Date();
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return {
          status: "completed",
          exitCode: 0,
          stdout: {
            text: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext: "from-command",
              },
            }),
            bytes: 101,
            truncated: false,
          },
          stderr: {
            text: "",
            bytes: 0,
            truncated: false,
          },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: now,
          completedAt: now,
        };
      },
    };

    const hookRunner = createConfiguredHookRunner({
      config: {
        enabled: true,
        timeoutMs: 5000,
        maxOutputBytes: 1024,
        events: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [
                {
                  type: "command",
                  command:
                    '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start "${CLAUDE_PROJECT_DIR}" "${CLAUDE_SESSION_ID}"',
                  plugin: {
                    dataPath: "/tmp/plugin-data",
                    id: "superpowers@zcode-plugins-official",
                    name: "superpowers",
                    rootPath: "/tmp/superpowers",
                  },
                },
              ],
            },
          ],
        },
      },
      executionPort,
      getWorkingDirectory: () => "/workspace",
    });

    const result = await hookRunner?.run(
      {
        cwd: "/workspace",
        hookEventName: HookEventName.SessionStart,
        mode: "build",
        sessionId,
        source: "startup",
        timestamp: new Date().toISOString(),
        traceId: traceContext.traceId,
        turnId,
      },
      { matchValue: "startup" },
    );

    expect(result?.additionalContexts).toHaveLength(1);
    expect(result?.additionalContexts[0]).toBe("from-command");
    expect(capturedRequest?.command).toMatchObject({
      mode: "shell",
      command: `"/tmp/superpowers/hooks/run-hook.cmd" session-start "/workspace" "${sessionId}"`,
    });
    expect(capturedRequest?.command).not.toHaveProperty("shellProfile");
    expect(capturedRequest?.captureCwdAfterSuccess).toBeUndefined();
    expect(capturedRequest?.env?.set).toMatchObject({
      CLAUDE_CODE_SESSION_ID: sessionId,
      CLAUDE_PLUGIN_ROOT: "/tmp/superpowers",
      CLAUDE_PROJECT_DIR: "/workspace",
      CLAUDE_SESSION_ID: sessionId,
      ZCODE_PLUGIN_DATA: "/tmp/plugin-data",
      ZCODE_PLUGIN_ID: "superpowers@zcode-plugins-official",
      ZCODE_PLUGIN_ROOT: "/tmp/superpowers",
      ZCODE_PROJECT_DIR: "/workspace",
      ZCODE_SESSION_ID: sessionId,
    });
    expect(JSON.parse(String(capturedRequest?.stdin))).toMatchObject({
      hook_event_name: "SessionStart",
      session_id: sessionId,
    });
  });

  it("fails plugin hooks that request a skill directory without a skill context", async () => {
    const sessionId = createSessionId("tool-hook-plugin-skill-dir");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    let executionCalled = false;
    const executionPort: ExecutionPort = {
      async run() {
        executionCalled = true;
        throw new Error("execution should not be called");
      },
    };

    const hookRunner = createConfiguredHookRunner({
      config: {
        enabled: true,
        timeoutMs: 5000,
        maxOutputBytes: 1024,
        events: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: 'bash "${CLAUDE_SKILL_DIR}/hooks/session-start"',
                },
              ],
            },
          ],
        },
      },
      executionPort,
      emitEvent: async (event) => {
        events.push(event);
      },
      getWorkingDirectory: () => "/workspace",
    });

    const result = await hookRunner?.run(
      {
        cwd: "/workspace",
        hookEventName: HookEventName.SessionStart,
        mode: "build",
        sessionId,
        source: "startup",
        timestamp: new Date().toISOString(),
        traceId: traceContext.traceId,
        turnId,
      },
      { matchValue: "startup" },
    );

    expect(result?.additionalContexts).toEqual([]);
    expect(executionCalled).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: SessionEventType.HookRunFailed,
        payload: expect.objectContaining({
          stderrPreview: "Hook variable requires a skill context: CLAUDE_SKILL_DIR",
        }),
      }),
    );
  });

  it("passes Claude-compatible Stop hook input and maps block decisions", async () => {
    const sessionId = createSessionId("tool-hook-stop-claude-compat");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    let capturedInput: Record<string, unknown> | undefined;
    let capturedTranscript = "";
    const now = new Date();
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedInput = JSON.parse(String(request.stdin));
        capturedTranscript = await readFile(String(capturedInput.transcript_path), "utf8");
        return {
          status: "completed",
          exitCode: 0,
          stdout: {
            text: JSON.stringify({
              decision: "block",
              reason: "repeat the original task",
              systemMessage: "Ralph iteration 2",
            }),
            bytes: 85,
            truncated: false,
          },
          stderr: {
            text: "",
            bytes: 0,
            truncated: false,
          },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: now,
          completedAt: now,
        };
      },
    };
    const hookRunner = createConfiguredHookRunner({
      config: {
        enabled: true,
        timeoutMs: 5000,
        maxOutputBytes: 1024,
        events: {
          Stop: [
            {
              hooks: [{ type: "command", command: "bash stop-hook.sh" }],
            },
          ],
        },
      },
      executionPort,
      getWorkingDirectory: () => "/workspace",
    });

    const result = await hookRunner?.run({
      cwd: "/workspace",
      hookEventName: HookEventName.Stop,
      mode: "build",
      responsePreview: "draft",
      responseText: "draft full answer",
      sessionId,
      stopHookActive: false,
      timestamp: new Date().toISOString(),
      toolCallCount: 0,
      traceId: traceContext.traceId,
      turnId,
    });

    expect(capturedInput).toMatchObject({
      hook_event_name: "Stop",
      session_id: sessionId,
      transcript_path: expect.any(String),
    });
    expect(capturedTranscript).toContain('"role":"assistant"');
    expect(capturedTranscript).toContain("draft full answer");
    expect(result?.stopShouldContinue).toBe(true);
    expect(result?.additionalContexts).toEqual(["Ralph iteration 2", "repeat the original task"]);
  });

  // 契约更新（docs/design/v2/permission-responder-race.md）：hook 与 broker 并发竞速，
  // broker 的应答通道总是先建立（会被调用），但 hook 决定先到时 broker 等待被 abort、
  // 其应答不被消费。旧断言「broker 不被调用」属于串行时代，已作废。
  it("lets a PermissionRequest hook approval win the race over a pending broker", async () => {
    const sessionId = createSessionId("tool-hook-permission-allow");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    let handlerRan = false;
    let brokerArmed = false;
    let brokerSignal: AbortSignal | undefined;

    registry.register({
      ...createContractToolEntry({
        name: "WriteLike",
        handler: async () => {
          handlerRan = true;
          return "write-ok";
        },
      }),
      metadata: {
        concurrentSafe: false,
        destructive: false,
        name: "WriteLike",
        needsApproval: true,
        readOnly: false,
        riskLevel: "medium",
        sideEffectScope: "workspace",
      },
      permission: {
        permission: "write-like",
        reason: "test write tool",
        riskLevel: "medium",
        sideEffectScope: "workspace",
        needsApproval: true,
        patternSources: ["tool"],
        denyPriority: "beforeAsk",
      },
    });

    const hookRunner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          event: "PermissionRequest",
          matcher: "WriteLike",
          callback: async (input) => ({
            hookSpecificOutput: {
              hookEventName: input.hookEventName,
              decision: { behavior: "allow" },
            },
          }),
        },
      ],
    });

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      hookRunner,
      permissionBroker: {
        requestPermission(_request, requestOptions) {
          brokerArmed = true;
          brokerSignal = requestOptions?.signal ?? undefined;
          // 模拟尚未点击的用户：挂起直到竞速败者被 abort。
          return new Promise((_, reject) => {
            requestOptions?.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted by race")),
              { once: true },
            );
          });
        },
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("hook-permission-allow"),
        input: { file_path: "demo.txt" },
        name: "WriteLike",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(handlerRan).toBe(true);
    expect(brokerArmed).toBe(true);
    expect(brokerSignal?.aborted).toBe(true);
    const resolved = events.find((event) => event.type === SessionEventType.PermissionResolved);
    expect((resolved?.payload as any).decision).toBe("allow");
  });

  it("carries PostToolUse hook additional context beside an unchanged tool result", async () => {
    const sessionId = createSessionId("tool-hook-post-context");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();

    registry.register(
      createContractToolEntry({
        name: "PostTool",
        handler: async () => "tool-output",
      }),
    );

    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: "PostToolUse",
          matcher: "PostTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              hookEventName: input.hookEventName,
              additionalContext: "extra post context",
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
        id: createToolCallId("hook-post-context"),
        input: {},
        name: "PostTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.modelContent).toBe("tool-output");
    expect(result.hookAdditionalContexts).toEqual([
      "PostToolUse:PostTool hook additional context: extra post context",
    ]);
  });

  it("carries PostToolUseFailure hook context beside the raw failed tool result", async () => {
    const sessionId = createSessionId("tool-hook-failure-context");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();

    registry.register(
      createContractToolEntry({
        name: "FailTool",
        handler: async () => {
          throw new Error("boom");
        },
      }),
    );

    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: "PostToolUseFailure",
          matcher: "FailTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              hookEventName: input.hookEventName,
              additionalContext: "try the recovery path",
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
        id: createToolCallId("hook-failure-context"),
        input: {},
        name: "FailTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.modelContent ?? result.error?.message)).toContain("boom");
    expect(JSON.stringify(result.modelContent ?? "")).not.toContain("try the recovery path");
    expect(result.hookAdditionalContexts).toEqual([
      "PostToolUseFailure:FailTool hook additional context: try the recovery path",
    ]);
  });

  it("persists project permission updates and uses them on later calls", async () => {
    const sessionId = createSessionId("tool-project-permission");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const projectID = createProjectId("tool-project-permission");
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    const sessionStore = createProjectPermissionStore(sessionId, projectID);
    let handlerRuns = 0;
    let brokerRequests = 0;

    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: false,
        destructive: false,
        name: "WriteLike",
        needsApproval: true,
        readOnly: false,
        riskLevel: "medium",
        sideEffectScope: "workspace",
      },
      handler: async () => {
        handlerRuns += 1;
        return "write-ok";
      },
    });

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      mode: "build",
      permissionBroker: {
        async requestPermission() {
          brokerRequests += 1;
          return {
            decision: "allow",
            permissionUpdates: [
              {
                behavior: "allow",
                rules: [{ toolName: "WriteLike" }],
                type: "addRules",
              },
            ],
            reason: "approved for project",
          };
        },
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      sessionStore,
      turnId,
      traceContext,
    });

    const first = await executor.execute(
      {
        id: createToolCallId("call-write-project-first"),
        input: { file_path: "demo.txt" },
        name: "WriteLike",
      },
      { traceContext },
    );
    const second = await executor.execute(
      {
        id: createToolCallId("call-write-project-second"),
        input: { file_path: "demo.txt" },
        name: "WriteLike",
      },
      { traceContext },
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(handlerRuns).toBe(2);
    expect(brokerRequests).toBe(1);
    expect(await sessionStore.getProjectPermission(projectID)).toEqual({
      allow: [{ toolName: "WriteLike" }],
      version: 1,
    });
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.PermissionRequested,
      SessionEventType.PermissionResolved,
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallResult,
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallResult,
    ]);
  });

  it("persists one official CUA project grant for the trusted tool family", async () => {
    const sessionId = createSessionId("official-cua-project-permission");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const projectID = createProjectId("official-cua-project-permission");
    const registry = createToolRegistry();
    const sessionStore = createProjectPermissionStore(sessionId, projectID);
    const toolNames = [
      "mcp__computer-use__get_app_state",
      "mcp__computer-use__left_click",
      "mcp__computer-use__key",
      "mcp__computer-use__drag",
    ];
    let brokerRequests = 0;
    let handlerRuns = 0;

    for (const name of toolNames) {
      const entry = {
        handler: async () => {
          handlerRuns += 1;
          return "cua-ok";
        },
        inputSchema: {},
        metadata: {
          concurrentSafe: false,
          destructive: false,
          name,
          needsApproval: true,
          readOnly: false,
          riskLevel: "medium" as const,
          sideEffectScope: "system" as const,
        },
        permissionCapabilityGroup: "official_cua",
      } as ToolEntry & { permissionCapabilityGroup: "official_cua" };
      registry.register(entry);
    }

    const executor = createToolExecutor({
      emitEvent: async () => {},
      mode: "build",
      permissionBroker: {
        async requestPermission(request) {
          brokerRequests += 1;
          expect(request.suggestedPermissionUpdates).toEqual([
            {
              behavior: "allow",
              rules: [{ toolName: OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME }],
              type: "addRules",
            },
          ]);
          return {
            decision: "allow",
            permissionUpdates: request.suggestedPermissionUpdates,
            reason: "approved official CUA for project",
          };
        },
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      sessionStore,
      turnId,
      traceContext,
    });

    for (const [index, name] of toolNames.entries()) {
      const result = await executor.execute(
        {
          id: createToolCallId(`official-cua-${index}`),
          input: {},
          name,
        },
        { traceContext },
      );
      expect(result.success, JSON.stringify(result)).toBe(true);
    }

    expect(handlerRuns).toBe(4);
    expect(brokerRequests).toBe(1);
    expect(await sessionStore.getProjectPermission(projectID)).toEqual({
      allow: [{ toolName: OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME }],
      version: 1,
    });
  });

  it("uses modified input returned by the permission broker", async () => {
    const sessionId = createSessionId("tool-permission-modify");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    let receivedInput: unknown;

    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: false,
        destructive: false,
        name: "WriteLike",
        needsApproval: true,
        readOnly: false,
        riskLevel: "medium",
        sideEffectScope: "workspace",
      },
      handler: async (input) => {
        receivedInput = input;
        return "modified-ok";
      },
    });

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      mode: "build",
      permissionBroker: {
        async requestPermission() {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return {
            decision: "modify",
            modifiedInput: { file_path: "approved.txt" },
            reason: "narrowed path",
          };
        },
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("call-write-modify"),
        input: { file_path: "demo.txt" },
        name: "WriteLike",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(receivedInput).toEqual({ file_path: "approved.txt" });
    const resultEvent = events.find((event) => event.type === SessionEventType.ToolCallResult);
    expect((resultEvent?.payload as any).result.perf).toMatchObject({
      permissionWaitMs: expect.any(Number),
    });
  });

  it("runs side-effecting tools without approval in yolo mode", async () => {
    const sessionId = createSessionId("tool-yolo");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();

    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: false,
        destructive: false,
        name: "WriteLike",
        needsApproval: true,
        readOnly: false,
        riskLevel: "medium",
        sideEffectScope: "workspace",
      },
      handler: async () => "ok",
    });

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      mode: "yolo",
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("call-yolo"),
        input: { file_path: "demo.txt" },
        name: "WriteLike",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe("ok");
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallResult,
    ]);
  });

  it("applies declared timeout policy and aborts the handler signal", async () => {
    const sessionId = createSessionId("tool-timeout");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    let handlerSawAbort = false;

    registry.register(
      createContractToolEntry({
        name: "SlowTool",
        timeoutMs: 5,
        timeout: {
          defaultMs: 5,
          maxMs: 5,
          allowCallOverride: false,
        },
        cancellation: {
          supported: true,
          cleanup: "bestEffort",
          userVisibleMessage: "SlowTool was cancelled",
        },
        handler: async (_input, context) =>
          new Promise((resolve) => {
            context.abortSignal.addEventListener("abort", () => {
              handlerSawAbort = true;
            });
            setTimeout(() => resolve("late"), 50);
          }),
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
        id: createToolCallId("call-timeout"),
        input: { timeout: 500 },
        name: "SlowTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe("tool_timeout");
    expect(result.error?.message).toContain("5ms");
    expect(handlerSawAbort).toBe(true);
  });

  it("does not apply the executor default timeout when timeout policy is none", async () => {
    const sessionId = createSessionId("tool-timeout-none");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();

    registry.register(
      createContractToolEntry({
        name: "NoTimeoutTool",
        timeoutMs: 1,
        timeout: { kind: "none" },
        handler: async () =>
          new Promise((resolve) => {
            setTimeout(() => resolve("late-ok"), 20);
          }),
      }),
    );

    const executor = createToolExecutor({
      defaultTimeoutMs: 1,
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("call-timeout-none"),
        input: {},
        name: "NoTimeoutTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe("late-ok");
  });

  it("emits background task lifecycle events for backgrounded tools", async () => {
    const sessionId = createSessionId("tool-background");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    const executionPort: ExecutionPort = {
      async run() {
        throw new Error("run should not be called");
      },
      async getBackgroundTask(taskId) {
        const now = new Date();
        return {
          taskId,
          status: "completed",
          startedAt: now,
          completedAt: now,
          pid: 1234,
          result: {
            status: "completed",
            exitCode: 0,
            stdout: {
              text: "",
              bytes: 6,
              truncated: true,
              artifactPath: "/tmp/bg-stdout.log",
            },
            stderr: {
              text: "",
              bytes: 0,
              truncated: false,
            },
            durationMs: 1,
            timedOut: false,
            cancelled: false,
            startedAt: now,
            completedAt: now,
            pid: 1234,
          },
        };
      },
    };

    registry.register(
      createContractToolEntry({
        name: "BackgroundTool",
        handler: async () => ({
          backgroundTaskId: "exec_bg",
          interrupted: false,
          status: "backgrounded",
          stderr: "",
          stdout: "",
        }),
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
      }),
    );

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      executionPort,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("call-background"),
        input: {
          command: "npm run dev",
        },
        name: "BackgroundTool",
      },
      { traceContext },
    );
    await nextTick();

    expect(result.success).toBe(true);
    expect(events.map((event) => event.type)).toContain(SessionEventType.BackgroundTaskStarted);
    expect(events.map((event) => event.type)).toContain(SessionEventType.BackgroundTaskCompleted);
    const completed = events.find(
      (event) => event.type === SessionEventType.BackgroundTaskCompleted,
    );
    expect(completed?.payload).toMatchObject({
      outputBytes: 6,
      outputPath: "/tmp/bg-stdout.log",
      status: "completed",
      taskId: "exec_bg",
    });
  });

  it("enqueues a task notification when background Bash completes", async () => {
    const sessionId = createSessionId("tool-background-bash");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const notifications: string[] = [];
    const executionPort: ExecutionPort = {
      async run() {
        throw new Error("run should not be called");
      },
      async getBackgroundTask(taskId) {
        const now = new Date();
        return {
          taskId,
          status: "completed",
          startedAt: now,
          completedAt: now,
          outputPath: "/tmp/bg-stdout.log",
          stdoutPersistedOutputPath: "/tmp/bg-stdout.log",
          stderrPersistedOutputPath: "/tmp/bg-stderr.log",
          result: {
            status: "completed",
            exitCode: 0,
            stdout: {
              text: "",
              bytes: 6,
              truncated: true,
              artifactPath: "/tmp/bg-stdout.log",
            },
            stderr: {
              text: "",
              bytes: 0,
              truncated: false,
              artifactPath: "/tmp/bg-stderr.log",
            },
            durationMs: 1,
            timedOut: false,
            cancelled: false,
            startedAt: now,
            completedAt: now,
          },
        };
      },
    };

    registry.register(
      createContractToolEntry({
        name: "Bash",
        handler: async () => ({
          backgroundTaskId: "exec_bg",
          interrupted: false,
          persistedOutputPath: "/tmp/bg-stdout.log",
          status: "backgrounded",
          stderr: "",
          stdout: "",
        }),
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
      }),
    );

    const executor = createToolExecutor({
      emitEvent: async () => undefined,
      enqueueBackgroundTaskNotification: (notification) => {
        notifications.push(notification.text);
      },
      executionPort,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("call-background-bash"),
        input: {
          command: "npm run dev",
          description: "Start dev server",
        },
        name: "Bash",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("<task-notification>");
    expect(notifications[0]).toContain("<task-id>exec_bg</task-id>");
    expect(notifications[0]).toContain("<status>completed</status>");
    expect(notifications[0]).toContain("<output-file>/tmp/bg-stdout.log</output-file>");
    expect(notifications[0]).not.toContain("<stdout-file>");
    expect(notifications[0]).not.toContain("<stderr-file>");
    expect(notifications[0]).toContain(
      '<summary>Background command "Start dev server" completed (exit code 0)</summary>',
    );
    expect(notifications[0]).not.toContain("Use Read on the output file");
    expect(notifications[0]).not.toContain('stdout":');
  });

  it("propagates parent cancellation into the per-tool abort signal", async () => {
    const sessionId = createSessionId("tool-parent-cancel");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const parentAbortController = new AbortController();
    let handlerSawAbort = false;
    let markReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });

    registry.register(
      createContractToolEntry({
        name: "CancelAwareTool",
        handler: async (_input, context) =>
          new Promise((resolve) => {
            context.abortSignal.addEventListener("abort", () => {
              handlerSawAbort = true;
              resolve("aborted");
            });
            markReady();
          }),
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

    const pending = executor.execute(
      {
        id: createToolCallId("call-parent-cancel"),
        input: {},
        name: "CancelAwareTool",
      },
      { signal: parentAbortController.signal, traceContext },
    );

    await ready;
    parentAbortController.abort();
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe("tool_cancelled");
    expect(result.error?.message).toBe("Test tool was cancelled");
    expect(handlerSawAbort).toBe(true);
  });

  it("serializes tool output through resultBudget before emitting model content", async () => {
    const sessionId = createSessionId("tool-result-budget");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    const rawOutput = "0123456789".repeat(20);

    registry.register(
      createContractToolEntry({
        name: "BudgetTool",
        handler: async () => rawOutput,
        resultBudget: {
          maxInlineBytes: 64,
          maxModelBytes: 64,
          strategy: "truncate",
          preview: {
            direction: "head",
          },
        },
      }),
    );

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("call-budget"),
        input: {},
        name: "BudgetTool",
      },
      { traceContext },
    );

    const resultEvent = events.find((event) => event.type === SessionEventType.ToolCallResult);
    const payload = resultEvent?.payload as any;

    expect(result.success).toBe(true);
    expect(result.output).toBe(rawOutput);
    expect(result.modelContent).toContain("Tool output truncated by resultBudget");
    expect(result.serialization?.truncated).toBe(true);
    expect(Buffer.byteLength(result.modelContent ?? "", "utf8")).toBeLessThanOrEqual(64);
    expect(payload.result.content).toBe(result.modelContent);
    expect(payload.result.truncated).toBe(true);
    expect(payload.result.originalBytes).toBe(Buffer.byteLength(rawOutput, "utf8"));
  });

  it("serializes structured tool model content through resultBudget before emitting model content", async () => {
    const sessionId = createSessionId("tool-structured-result-budget");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    const rawOutput = { ok: true };
    const rawStructuredText = "structured-output".repeat(20);

    registry.register(
      createContractToolEntry({
        name: "StructuredBudgetTool",
        handler: async () => rawOutput,
        outputSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
          },
          required: ["ok"],
          additionalProperties: false,
        },
        formatModelContent: () => [{ type: "text", text: rawStructuredText }],
        resultBudget: {
          maxInlineBytes: 72,
          maxModelBytes: 72,
          strategy: "truncate",
          preview: {
            direction: "head",
          },
        },
      }),
    );

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("call-structured-budget"),
        input: {},
        name: "StructuredBudgetTool",
      },
      { traceContext },
    );

    const resultEvent = events.find((event) => event.type === SessionEventType.ToolCallResult);
    const payload = resultEvent?.payload as any;

    expect(result.success).toBe(true);
    expect(result.modelContent).toContain("Tool output truncated by resultBudget");
    expect(result.serialization?.content).toBe(result.modelContent);
    expect(result.serialization?.modelContent).toBe(result.modelContent);
    expect(result.serialization?.truncated).toBe(true);
    expect(Buffer.byteLength(result.modelContent ?? "", "utf8")).toBeLessThanOrEqual(72);
    expect(payload.result.content).toBe(result.modelContent);
  });

  it("does not let hook context change the structured tool result budget", async () => {
    const sessionId = createSessionId("tool-structured-hook-budget");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const rawStructuredText = "structured-output".repeat(8);

    registry.register(
      createContractToolEntry({
        name: "StructuredHookBudgetTool",
        handler: async () => ({ ok: true }),
        outputSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
          },
          required: ["ok"],
          additionalProperties: false,
        },
        formatModelContent: () => [{ type: "text", text: rawStructuredText }],
        resultBudget: {
          maxInlineBytes: 160,
          maxModelBytes: 160,
          strategy: "truncate",
          preview: {
            direction: "head",
          },
        },
      }),
    );

    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: "PostToolUse",
          matcher: "StructuredHookBudgetTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              hookEventName: input.hookEventName,
              additionalContext: "extra post context ".repeat(8),
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
        id: createToolCallId("call-structured-hook-budget"),
        input: {},
        name: "StructuredHookBudgetTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    // Hook 文本不占 tool result 预算：结果与没有 Hook 时相同。
    expect(result.modelContent).toEqual([{ type: "text", text: rawStructuredText }]);
    expect(result.serialization?.truncated).toBe(false);
    expect(result.hookAdditionalContexts).toHaveLength(1);
    expect(result.hookAdditionalContexts?.[0]).toMatch(
      /^PostToolUse:StructuredHookBudgetTool hook additional context: extra post context /,
    );
  });

  it("keeps hook context out of an official CUA receipt", async () => {
    const sessionId = createSessionId("tool-trusted-cua-receipt");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const receipt = {
      type: "text" as const,
      text: JSON.stringify({
        action_receipt: {
          schema_version: "zcode-cua-action-receipt-v1",
          action_sent: true,
          dispatch_status: "accepted",
          retry_action: false,
        },
      }),
    };
    const registry = createToolRegistry();
    registry.register(
      createContractToolEntry({
        name: "TrustedCuaReceiptTool",
        handler: async () => ({ ok: true }),
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        formatModelContent: () => [receipt],
        modelContentProtection: "official_cua_frame_v1",
        resultBudget: {
          maxInlineBytes: 4096,
          maxModelBytes: 4096,
          strategy: "truncate",
          preview: { direction: "head" },
        },
      }),
    );
    const executor = createToolExecutor({
      emitEvent: async () => {},
      hookRunner: createInMemoryHookRunner({
        hooks: [
          {
            event: "PostToolUse",
            matcher: "TrustedCuaReceiptTool",
            callback: async (input) => ({
              hookSpecificOutput: {
                hookEventName: input.hookEventName,
                additionalContext: "hook-context",
              },
            }),
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
        id: createToolCallId("call-trusted-cua-receipt"),
        input: {},
        name: "TrustedCuaReceiptTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.serialization?.content).toContain("zcode-cua-action-receipt-v1");
    expect(result.serialization?.content).not.toContain("hook-context");
    expect(result.serialization?.truncated).toBe(false);
    expect(result.hookAdditionalContexts).toEqual([
      "PostToolUse:TrustedCuaReceiptTool hook additional context: hook-context",
    ]);
  });

  it("applies the generic result budget to large official CUA receipt text", async () => {
    const sessionId = createSessionId("tool-trusted-cua-receipt-budget");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const largeText = {
      type: "text" as const,
      text: `receipt diagnostic ${"x".repeat(245 * 1024)}`,
    };
    const receipt = {
      type: "text" as const,
      text: JSON.stringify({
        action_receipt: {
          schema_version: "zcode-cua-action-receipt-v1",
          action_sent: true,
          dispatch_status: "accepted",
          retry_action: false,
        },
      }),
    };

    const registry = createToolRegistry();
    registry.register(
      createContractToolEntry({
        name: "TrustedCuaReceiptBudgetTool",
        handler: async () => ({ ok: true }),
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        formatModelContent: () => [largeText, receipt],
        modelContentProtection: "official_cua_frame_v1",
        resultBudget: {
          maxInlineBytes: 1024,
          maxModelBytes: 1024,
          strategy: "truncate",
          preview: { direction: "head" },
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
        id: createToolCallId("call-trusted-cua-receipt-budget"),
        input: {},
        name: "TrustedCuaReceiptBudgetTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.serialization?.truncated).toBe(true);
    expect(result.serialization?.content).toContain("Tool output truncated by resultBudget");
    expect(result.serialization?.content).not.toContain("refresh_required");
    expect(result.serialization?.content).not.toContain("consumer_state_budget_exceeded");
  });

  it("applies the generic budget when official CUA protection is absent (SG-01)", async () => {
    const sessionId = createSessionId("tool-preserve-without-protection");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const largeImage = {
      type: "image" as const,
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    };
    const registry = createToolRegistry();
    registry.register(
      createContractToolEntry({
        name: "UnprotectedStructuredImageTool",
        handler: async () => ({ ok: true }),
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        // 序列化字节压力来自 text 块（image 块只渲染为短占位符）；
        // 旧实现的问题在于结构化数组原样返回、2KB 级图片直进模型内容。
        formatModelContent: () => [
          { type: "text" as const, text: `unprotected structured output ${"x".repeat(2048)}` },
          largeImage,
        ],
        // SG-01 回归：唯一的 modelContentProtection authority 缺失时必须走通用预算。
        resultBudget: {
          maxInlineBytes: 256,
          maxModelBytes: 256,
          strategy: "truncate",
          preview: { direction: "head" },
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
        id: createToolCallId("call-unprotected-structured-image"),
        input: {},
        name: "UnprotectedStructuredImageTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    // 关键回归断言：protection 缺失时结构化数组不得原样进入模型内容——
    // 旧实现会直接返回 [text, image(2KB dataUrl)] 结构化块绕过预算。
    expect(Array.isArray(result.modelContent)).toBe(false);
    // 序列化 content 的 image 块只渲染为短占位符；把字节压力放进 text 块，
    // 验证超预算时通用截断分支确实接管（truncated + budget 提示注入）。
    expect(result.serialization?.truncated).toBe(true);
    expect(result.serialization?.content).toContain("Tool output truncated by resultBudget");
    expect(Buffer.byteLength(result.serialization?.content ?? "", "utf8")).toBeLessThanOrEqual(
      1024,
    );
  });

  it("fails closed when protected final model content cannot be attested", async () => {
    const sessionId = createSessionId("tool-invalid-protected-frame");
    const registry = createToolRegistry();
    registry.register(
      createContractToolEntry({
        name: "InvalidProtectedFrameTool",
        handler: async () => ({ ok: true }),
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        formatModelContent: () => [
          {
            type: "image",
            mediaType: "image/png",
            dataUrl: "data:image/png;base64,iVBORw0KGgo=",
          },
        ],
        modelContentProtection: "official_cua_frame_v1",
      }),
    );

    const executor = createToolExecutor({
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
    });
    const result = await executor.execute({
      id: createToolCallId("call-invalid-protected-frame"),
      input: {},
      name: "InvalidProtectedFrameTool",
    });

    expect(result.success).toBe(false);
    expect(result.modelContentProtection).toBeUndefined();
    expect(result.modelContent).toBeUndefined();
    expect(result.error?.message).toContain("failed final model-content attestation");
  });

  it("persists oversized artifact-budget output with an independent preview budget", async () => {
    const sessionId = createSessionId("tool-artifact-budget");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    const artifactStore = new RecordingArtifactStore();
    const rawOutput = { text: "artifact-output".repeat(20) };

    registry.register(
      createContractToolEntry({
        name: "ArtifactTool",
        handler: async () => rawOutput,
        outputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
          additionalProperties: false,
        },
        resultBudget: {
          maxInlineBytes: 160,
          maxModelBytes: 160,
          strategy: "artifact",
          preview: {
            direction: "head",
          },
          artifact: {
            enabled: true,
            retention: "session",
          },
        },
      }),
    );

    const executor = createToolExecutor({
      artifactStore,
      emitEvent: async (event) => {
        events.push(event);
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("call-artifact"),
        input: {},
        name: "ArtifactTool",
      },
      { traceContext },
    );

    const resultEvent = events.find((event) => event.type === SessionEventType.ToolCallResult);
    const payload = resultEvent?.payload as any;

    expect(result.success).toBe(true);
    expect(artifactStore.requests).toHaveLength(1);
    expect(artifactStore.requests[0]?.content).toBe(JSON.stringify(rawOutput));
    expect(result.serialization?.artifactPath).toBe("/artifacts/artifact-1.json");
    expect(result.modelContent).toBe(
      '<persisted-output>\nOutput too large (311 B). Full output saved to: /artifacts/artifact-1.json\n\nPreview (first 2 KB):\n{"text":"artifact-outputartifact-outputartifact-outputartifact-outputartifact-outputartifact-outputartifact-outputartifact-outputartifact-outputartifact-outputartifact-outputartifact-outputartifact-outputartifact-outputartifact-outputartifact-outputartifact-outputartifact-outputartifact-outputartifact-output"}\n</persisted-output>',
    );
    expect(payload.result.artifactPath).toBe("/artifacts/artifact-1.json");
  });

  it("keeps hook context out of a persisted artifact preview", async () => {
    const sessionId = createSessionId("tool-artifact-budget-with-hook");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const artifactStore = new RecordingArtifactStore();
    const rawOutput = { text: "artifact-output".repeat(20) };

    registry.register(
      createContractToolEntry({
        name: "ArtifactHookTool",
        handler: async () => rawOutput,
        outputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
          additionalProperties: false,
        },
        resultBudget: {
          maxInlineBytes: 160,
          maxModelBytes: 160,
          strategy: "artifact",
          preview: {
            direction: "head",
          },
          artifact: {
            enabled: true,
            retention: "session",
          },
        },
      }),
    );

    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: "PostToolUse",
          matcher: "ArtifactHookTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              hookEventName: input.hookEventName,
              additionalContext: "artifact hook context",
            },
          }),
        },
      ],
    });

    const executor = createToolExecutor({
      artifactStore,
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
        id: createToolCallId("call-artifact-hook"),
        input: {},
        name: "ArtifactHookTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.modelContent).toContain("<persisted-output>");
    expect(result.modelContent).toContain("artifact-output".repeat(20));
    expect(result.modelContent).not.toContain("artifact hook context");
    expect(result.hookAdditionalContexts).toEqual([
      "PostToolUse:ArtifactHookTool hook additional context: artifact hook context",
    ]);
  });

  it("keeps literal persisted-output text unchanged when a hook adds context", async () => {
    const sessionId = createSessionId("tool-literal-persisted-output-hook");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const rawOutput = "<persisted-output>\nliteral output\n</persisted-output>";

    registry.register(
      createContractToolEntry({
        name: "LiteralPersistedOutputTool",
        handler: async () => rawOutput,
        resultBudget: {
          maxInlineBytes: 120,
          maxModelBytes: 120,
          strategy: "truncate",
          preview: {
            direction: "head",
          },
        },
      }),
    );

    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: "PostToolUse",
          matcher: "LiteralPersistedOutputTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              hookEventName: input.hookEventName,
              additionalContext: "literal hook context ".repeat(6),
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
        id: createToolCallId("call-literal-persisted-output"),
        input: {},
        name: "LiteralPersistedOutputTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.serialization?.budgetStrategy).toBe("truncate");
    expect(result.serialization?.artifactPath).toBeUndefined();
    expect(result.modelContent).toBe(rawOutput);
    expect(result.hookAdditionalContexts).toHaveLength(1);
    expect(result.hookAdditionalContexts?.[0]).toMatch(
      /^PostToolUse:LiteralPersistedOutputTool hook additional context: literal hook context /,
    );
  });

  it("keeps structured media results unchanged when a hook adds context", async () => {
    const sessionId = createSessionId("tool-media-hook-budget");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const imageBlock = {
      type: "image" as const,
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,aGVsbG8=",
    };

    registry.register(
      createContractToolEntry({
        name: "MediaHookBudgetTool",
        handler: async () => ({ ok: true }),
        outputSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
          },
          required: ["ok"],
          additionalProperties: false,
        },
        formatModelContent: () => [
          imageBlock,
          {
            type: "text",
            text: "media textual context",
          },
        ],
        resultBudget: {
          maxInlineBytes: 120,
          maxModelBytes: 120,
          strategy: "truncate",
          preview: {
            direction: "head",
          },
        },
      }),
    );

    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: "PostToolUse",
          matcher: "MediaHookBudgetTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              hookEventName: input.hookEventName,
              additionalContext: "extra post context ".repeat(10),
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
        id: createToolCallId("call-media-hook-budget"),
        input: {},
        name: "MediaHookBudgetTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.modelContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "image", dataUrl: imageBlock.dataUrl }),
      ]),
    );
    expect(result.serialization?.content).not.toContain("extra post context");
    expect(result.serialization?.truncated).toBe(false);
    expect(result.hookAdditionalContexts).toHaveLength(1);
  });

  it("maps empty tool output to a model-visible completion message", async () => {
    const sessionId = createSessionId("tool-empty-output");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();

    registry.register(
      createContractToolEntry({
        name: "EmptyTool",
        handler: async () => "   ",
      }),
    );

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("call-empty"),
        input: {},
        name: "EmptyTool",
      },
      { traceContext },
    );

    const resultEvent = events.find((event) => event.type === SessionEventType.ToolCallResult);
    const payload = resultEvent?.payload as any;

    expect(result.success).toBe(true);
    expect(result.modelContent).toBe("(EmptyTool completed with no output)");
    expect(result.serialization?.content).toBe("(EmptyTool completed with no output)");
    expect(result.serialization?.truncated).toBe(false);
    expect(payload.result.content).toBe("(EmptyTool completed with no output)");
  });

  it("falls back to a truncated artifact-budget output when artifact storage is unavailable", async () => {
    const sessionId = createSessionId("tool-artifact-budget-no-store");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const rawOutput = "oversized-output".repeat(20);

    registry.register(
      createContractToolEntry({
        name: "ArtifactFallbackTool",
        handler: async () => rawOutput,
        resultBudget: {
          maxInlineBytes: 64,
          maxModelBytes: 64,
          strategy: "artifact",
          artifact: {
            enabled: true,
            retention: "session",
          },
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
        id: createToolCallId("call-artifact-fallback-no-store"),
        input: {},
        name: "ArtifactFallbackTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.modelContent).toContain("Tool output truncated by resultBudget");
    expect(result.serialization?.content).toBe(result.modelContent);
    expect(result.serialization?.truncated).toBe(true);
    expect(Buffer.byteLength(result.modelContent ?? "", "utf8")).toBeLessThanOrEqual(64);
    expect(result.serialization?.artifactPath).toBeUndefined();
  });

  it("falls back to a truncated artifact-budget output when artifact storage fails", async () => {
    const sessionId = createSessionId("tool-artifact-budget-store-fails");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const artifactStore = new FailingArtifactStore();
    const rawOutput = "oversized-output".repeat(20);

    registry.register(
      createContractToolEntry({
        name: "ArtifactFailingStoreTool",
        handler: async () => rawOutput,
        resultBudget: {
          maxInlineBytes: 64,
          maxModelBytes: 64,
          strategy: "artifact",
          artifact: {
            enabled: true,
            retention: "session",
          },
        },
      }),
    );

    const executor = createToolExecutor({
      artifactStore,
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("call-artifact-fallback-failed-store"),
        input: {},
        name: "ArtifactFailingStoreTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.modelContent).toContain("Tool output truncated by resultBudget");
    expect(result.serialization?.content).toBe(result.modelContent);
    expect(result.serialization?.truncated).toBe(true);
    expect(Buffer.byteLength(result.modelContent ?? "", "utf8")).toBeLessThanOrEqual(64);
    expect(result.serialization?.artifactPath).toBeUndefined();
  });

  it("fails closed when handler output violates outputSchema", async () => {
    const sessionId = createSessionId("tool-output-schema");
    const turnId = createTurnId("tool-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();

    registry.register(
      createContractToolEntry({
        name: "SchemaTool",
        handler: async () => ({ ok: 123 }),
        outputSchema: {
          type: "object",
          properties: {
            ok: { type: "string" },
          },
          required: ["ok"],
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
        id: createToolCallId("call-schema"),
        input: {},
        name: "SchemaTool",
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe("tool_execution_failed");
    expect(result.error?.message).toBe("Tool output failed outputSchema validation");
  });
});

function createContractToolEntry(options: {
  name: string;
  handler: ToolHandler;
  outputSchema?: ToolEntry["outputSchema"];
  formatModelContent?: ToolEntry["formatModelContent"];
  timeoutMs?: number;
  timeout?: ToolEntry["timeout"];
  cancellation?: ToolEntry["cancellation"];
  resultBudget?: ToolEntry["resultBudget"];
  modelContentProtection?: ToolEntry["modelContentProtection"];
}): ToolEntry {
  return {
    capability: `${options.name} test capability`,
    metadata: {
      concurrentSafe: true,
      destructive: false,
      name: options.name,
      needsApproval: false,
      readOnly: true,
      riskLevel: "low",
      sideEffectScope: "none",
      timeoutMs: options.timeoutMs ?? 30000,
    },
    handler: options.handler,
    formatModelContent: options.formatModelContent,
    inputSchema: {
      type: "object",
      additionalProperties: true,
    },
    outputSchema: options.outputSchema ?? {
      type: "string",
    },
    permission: {
      permission: "test",
      reason: "test tool",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: ["none"],
      denyPriority: "beforeAsk",
    },
    resultBudget: options.resultBudget ?? {
      maxInlineBytes: 100_000,
      maxModelBytes: 100_000,
      strategy: "truncate",
    },
    modelContentProtection: options.modelContentProtection,
    timeout: options.timeout ?? {
      defaultMs: options.timeoutMs ?? 30000,
      maxMs: options.timeoutMs ?? 30000,
      allowCallOverride: false,
    },
    cancellation: options.cancellation ?? {
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

const nextTick = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

class RecordingArtifactStore implements ToolArtifactStorePort {
  readonly requests: ToolArtifactWriteRequest[] = [];
  readonly contents = new Map<string, { content: string; contentType: string }>();

  async writeToolResultArtifact(request: ToolArtifactWriteRequest) {
    this.requests.push(request);
    const uri = "zcode-artifact://test/artifact-1";
    this.contents.set(uri, {
      content: request.content,
      contentType: request.contentType ?? "application/json",
    });
    return {
      id: "artifact-1",
      uri,
      path: "/artifacts/artifact-1.json",
      bytes: Buffer.byteLength(request.content, "utf8"),
      contentType: request.contentType ?? "application/json",
      createdAt: new Date(),
    };
  }

  async readToolResultArtifact(request: ToolArtifactReadRequest) {
    const artifact = this.contents.get(request.uri);
    if (!artifact) throw new Error(`missing artifact: ${request.uri}`);
    return {
      uri: request.uri,
      content: artifact.content,
      bytes: Buffer.byteLength(artifact.content, "utf8"),
      contentType: artifact.contentType,
    };
  }
}

class FailingArtifactStore implements ToolArtifactStorePort {
  async writeToolResultArtifact(): Promise<never> {
    throw new Error("artifact write failed");
  }

  async readToolResultArtifact(): Promise<never> {
    throw new Error("artifact read failed");
  }
}

function createProjectPermissionStore(
  sessionId: SessionId,
  projectID: ProjectId,
): SessionStorePort {
  const projectPermissions = new Map<string, PermissionRuleset>();
  const session: SessionInfo = {
    directory: "/work",
    id: sessionId,
    projectID,
    slug: "permission-test",
    taskType: "interactive",
    time: {
      created: 1,
      updated: 1,
    },
    title: "Permission test",
    version: "0.1.0",
  };

  return {
    async createSession() {
      return session;
    },
    async updateSession() {
      return session;
    },
    async getSession(inputSessionId) {
      return inputSessionId === sessionId ? session : null;
    },
    async listSessions() {
      return [session];
    },
    async saveMessage() {},
    async removeMessage() {},
    async savePart() {},
    async removePart() {},
    async messages() {
      return [];
    },
    async readTodos() {
      return [];
    },
    async updateTodos() {},
    async readTarget() {
      return null;
    },
    async setTarget(input) {
      return {
        sessionID: input.sessionID,
        targetID: "target-permission-test",
        objective: input.objective,
        summaryTitle: null,
        status: input.status ?? "active",
        tokenBudget: input.tokenBudget ?? null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        time: { created: 1, updated: 1 },
      };
    },
    async createTarget(input) {
      return {
        sessionID: input.sessionID,
        targetID: "target-permission-test",
        objective: input.objective,
        summaryTitle: null,
        status: "active",
        tokenBudget: input.tokenBudget ?? null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        time: { created: 1, updated: 1 },
      };
    },
    async updateTargetStatus() {
      return null;
    },
    async accountTargetUsage() {
      return null;
    },
    async updateTargetSummaryTitle() {
      return null;
    },
    async clearTarget() {
      return false;
    },
    async getProjectPermission(inputProjectID) {
      return projectPermissions.get(inputProjectID) ?? null;
    },
    async saveProjectPermission(input) {
      projectPermissions.set(input.projectID, input.permission);
      return input.permission;
    },
    async setRevert() {},
    async clearRevert() {},
  };
}
