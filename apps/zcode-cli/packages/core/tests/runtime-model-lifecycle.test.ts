import { describe, expect, it, vi } from "vitest";
import {
  getCurrentModelInvocationContext,
  type ModelStatusSink,
  ModelErrorCode,
  SessionEventType,
  createModelId,
  createModelProviderId,
  createSessionId,
  type Model,
  type ModelRequest,
  type ModelResult,
  type ModelSelection,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFormatProperties } from "./test-runtime-model.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("Agent Runtime Model lifecycle", () => {
  it.each(["success", "failure", "cancelled"] as const)(
    "disposes the model status sink after %s",
    async (outcome) => {
      const store = createTestSessionEventStore();
      const sessionId = createSessionId(`sink-${outcome}`);
      let retained: ModelStatusSink | undefined;
      const runtime = createTestAgentRuntime(
        sessionId,
        { mode: "build", modelSelection: createTestModelSelection("test/model") },
        {
          eventStore: store,
          modelFactory: ({ selection }) => ({
            ...createLifecycleTestModel(selection),
            async generateText() {
              retained = getCurrentModelInvocationContext()?.statusSink;
              if (outcome !== "success")
                throw outcome === "cancelled"
                  ? new DOMException("cancelled", "AbortError")
                  : new Error("model failed");
              return result(selection, { finishReason: "stop", text: "done" });
            },
          }),
        },
      );
      await runtime.executeTurn("test sink lifetime").catch(() => {});
      expect(retained).toBeDefined();
      const count = (await store.getEvents(sessionId)).length;
      await retained!.publish({ type: "model_request_started", attempt: 1 } as never);
      expect((await store.getEvents(sessionId)).length).toBe(count);
    },
  );

  it("manual compact executes its submitted B after newer C was accepted without reverting C", async () => {
    const requests: string[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("compact-submitted-model"),
      { mode: "build", modelSelection: createTestModelSelection("test/model-a") },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: ({ selection }) => {
          const model = createLifecycleTestModel(selection);
          return {
            ...model,
            async generateText(request) {
              const compact = JSON.stringify(request.messages).includes(
                "create a detailed summary",
              );
              requests.push(`${selection.modelId}:${compact ? "compact" : "normal"}`);
              return result(selection, {
                finishReason: "stop",
                text: compact ? "<summary>Preserve the task and files.</summary>" : "done",
              });
            },
          };
        },
      },
    );
    await runtime.executeTurn("first history");
    await runtime.executeTurn("newer input", undefined, {
      intent: {
        sourceCommandId: "newer-c",
        kind: "sendText",
        admissionSeq: 3,
        modelSelection: createTestModelSelection("test/model-c"),
      },
    });
    await runtime.executeTurn("/compact", undefined, {
      intent: {
        sourceCommandId: "queued-b",
        kind: "compact",
        admissionSeq: 2,
        modelSelection: createTestModelSelection("test/model-b"),
      },
    });
    expect(requests).toContain("model-b:compact");
    expect(requests).not.toContain("model-c:compact");
    expect(runtime.getSessionModelSelection().modelId).toBe("model-c");
  });

  it("does not fall back to the Adapter when the explicit ModelFactory is unavailable", async () => {
    const eventStore = createTestSessionEventStore();
    const modelSelection = createTestModelSelection("test/adapter-only-model");
    const generateText = vi.fn(async () =>
      result(modelSelection, { finishReason: "stop", text: "adapter fallback" }),
    );
    const runtime = createTestAgentRuntime(
      createSessionId("adapter-fallback-is-forbidden"),
      {
        mode: "build",
        modelSelection: createTestModelSelection(modelSelection),
        workingDirectory: "/tmp/zcode-adapter-fallback-is-forbidden",
      },
      {
        eventStore,
        modelFactory: () => {
          throw new Error("test model unavailable");
        },
        modelAdapter: {
          generateText,
          async *streamText() {
            throw new Error("not used");
          },
        },
      } as never,
    );

    await expect(runtime.executeTurn("must use a ModelFactory")).rejects.toThrow();
    expect(generateText).not.toHaveBeenCalled();
    const outcomes = (await eventStore.getEvents(runtime.sessionId)).filter(
      (event) => event.type === SessionEventType.TurnError,
    );
    expect(outcomes).toHaveLength(1);
    expect(JSON.stringify(outcomes[0])).toContain("test model unavailable");
    expect(runtime.getSessionModelSelection()).toEqual(modelSelection);
  });

  it("creates the Loop Model from the admitted Submission selection and applies its mode", async () => {
    const createdModelSelections: Array<ModelSelection> = [];
    const runtime = createTestAgentRuntime(
      createSessionId("submission-model-lifecycle"),
      {
        mode: "build",
        modelSelection: createTestModelSelection(createTestModelSelection("test/model-a")),
        workingDirectory: "/tmp/zcode-submission-model-lifecycle",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: ((input: { selection: ModelSelection }) => {
          const modelSelection = modelSelectionFromSelection(input.selection);
          createdModelSelections.push(modelSelection);
          return createLifecycleTestModel(modelSelection);
        }) as never,
      },
    );

    await runtime.executeTurn("use the submitted model", undefined, {
      intent: {
        sourceCommandId: "submission-command",
        kind: "sendText",
        requestedDelivery: "start-now",
        modelSelection: {
          providerId: "other-provider",
          modelId: "model-b",
          options: { reasoningLevel: "high" },
        },
        mode: "plan",
      },
    });

    expect(createdModelSelections).toEqual([
      expect.objectContaining({
        providerId: "other-provider",
        modelId: "model-b",
        options: { reasoningLevel: "high" },
      }),
    ]);
    expect(runtime.getSessionModelSelection()).toMatchObject({
      providerId: "other-provider",
      modelId: "model-b",
      options: { reasoningLevel: "high" },
    });
    expect(runtime.getMode()).toBe("build");
    expect(runtime.getPlanEnabled()).toBe(true);
  });

  it("keeps an execution-scoped model isolated from the persistent Submission selection", async () => {
    const eventStore = createTestSessionEventStore();
    const createdModelIds: string[] = [];
    const createdRequestAuthSources: unknown[] = [];
    const secret = "turn-only-key-do-not-persist";
    const requestAuthSource = {
      resolve: vi.fn().mockResolvedValue({ apiKey: secret }),
    };
    const runtime = createTestAgentRuntime(
      createSessionId("temporary-execution-model-lifecycle"),
      {
        mode: "build",
        modelSelection: createTestModelSelection(createTestModelSelection("test/session-model")),
        workingDirectory: "/tmp/zcode-temporary-execution-model-lifecycle",
      },
      {
        eventStore,
        modelFactory: ((input: {
          selection: ModelSelection;
          requestDependencies?: { requestAuth?: { source?: unknown } };
        }) => {
          const modelSelection = modelSelectionFromSelection(input.selection);
          createdModelIds.push(String(modelSelection.modelId));
          createdRequestAuthSources.push(input.requestDependencies?.requestAuth?.source);
          return createLifecycleTestModel(modelSelection);
        }) as never,
      },
    );

    await runtime.executeTurn("temporary task", undefined, {
      intent: {
        sourceCommandId: "temporary-command",
        kind: "sendText",
        requestedDelivery: "start-now",
        modelSelection: { providerId: "temporary", modelId: "idle-model" },
      },
      modelExecution: {
        selectionScope: "execution",
        requestDependencies: { requestAuth: { source: requestAuthSource } },
      },
    });

    await runtime.executeTurn("ordinary task");

    expect(createdModelIds).toEqual(["idle-model", "session-model"]);
    expect(createdRequestAuthSources).toEqual([requestAuthSource, undefined]);
    expect(runtime.getSessionModelSelection()).toMatchObject({
      providerId: "test",
      modelId: "session-model",
    });
    expect(
      JSON.stringify(
        await eventStore.getEvents(createSessionId("temporary-execution-model-lifecycle")),
      ),
    ).not.toContain(secret);
  });

  it("keeps one Model across all steps of a loop and creates a new Model for the next turn", async () => {
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "ReadMarker",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => "marker",
    });

    let runtime: ReturnType<typeof createTestAgentRuntime>;
    const modelFactory = vi.fn((input: { selection: ModelSelection }) => {
      const modelSelection = modelSelectionFromSelection(input.selection);
      let calls = 0;
      const model: Model = {
        providerId: modelSelection.providerId,
        modelId: modelSelection.modelId,
        properties: {
          contextWindow: 128_000,
          ...createTestModelFormatProperties(),
          supportsMidConversationSystem: false,
          supportsNativeWebSearch: false,
          supportsJsonSchemaOutput: true,
          supportsToolCall: true,
        },
        optionSpecs: {
          maxOutputTokens: { max: 8_000 },
        },
        options: { maxOutputTokens: 8_000 },
        bind() {
          return this;
        },
        async generateText(request: ModelRequest): Promise<ModelResult> {
          calls += 1;
          if (modelSelection.modelId === "model-a" && calls === 1) {
            runtime.setSessionModelSelection(
              createTestModelSelection(createTestModelSelection("test/model-b")),
            );
            return result(modelSelection, {
              finishReason: "tool-calls",
              toolCalls: [{ id: "read-marker", name: "ReadMarker", input: {} }],
            });
          }
          return result(modelSelection, { finishReason: "stop", text: "done" });
        },
        streamText() {
          throw new Error("not used");
        },
      };
      return model;
    });

    runtime = createTestAgentRuntime(
      createSessionId("model-lifecycle"),
      {
        mode: "build",
        modelSelection: createTestModelSelection(createTestModelSelection("test/model-a")),
        workingDirectory: "/tmp/zcode-model-lifecycle",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: modelFactory as never,
        toolRegistry: registry,
      },
    );

    await runtime.executeTurn("first");
    await runtime.executeTurn("second");

    expect(modelFactory.mock.calls.map(([input]) => input.selection.modelId)).toEqual([
      "model-a",
      "model-b",
    ]);
  });

  it("captures model and context before async turn setup can observe a model switch", async () => {
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "ReadBeforeModelCapture",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => "marker",
    });

    let runtime: ReturnType<typeof createTestAgentRuntime>;
    const requests: Array<{ modelId: string; text: string }> = [];
    const modelFactory = vi.fn((input: { selection: ModelSelection }) => {
      const modelSelection = modelSelectionFromSelection(input.selection);
      let calls = 0;
      const model: Model = {
        providerId: modelSelection.providerId,
        modelId: modelSelection.modelId,
        properties: {
          contextWindow: 128_000,
          ...createTestModelFormatProperties(),
          supportsMidConversationSystem: false,
          supportsNativeWebSearch: false,
          supportsJsonSchemaOutput: true,
          supportsToolCall: true,
        },
        optionSpecs: {
          maxOutputTokens: { max: 8_000 },
        },
        options: { maxOutputTokens: 8_000 },
        bind() {
          return this;
        },
        async generateText(request: ModelRequest): Promise<ModelResult> {
          calls += 1;
          requests.push({
            modelId: modelSelection.modelId,
            text: JSON.stringify(request.messages),
          });
          if (modelSelection.modelId === "model-a" && calls === 1) {
            return result(modelSelection, {
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "read-before-model-capture",
                  name: "ReadBeforeModelCapture",
                  input: {},
                },
              ],
            });
          }
          return result(modelSelection, { finishReason: "stop", text: "done" });
        },
        streamText() {
          throw new Error("not used");
        },
      };
      return model;
    });

    runtime = createTestAgentRuntime(
      createSessionId("model-context-before-capture"),
      {
        mode: "build",
        modelSelection: createTestModelSelection(createTestModelSelection("test/model-a")),
        workingDirectory: "/tmp/zcode-model-context-before-capture",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: modelFactory as never,
        toolRegistry: registry,
      },
    );

    let switched = false;
    const unsubscribe = runtime.subscribeEvents({
      onSessionEvent(event) {
        if (!switched && event.type === SessionEventType.TurnStarted) {
          switched = true;
          runtime.setSessionModelSelection(
            createTestModelSelection(createTestModelSelection("test/model-b")),
          );
          runtime.updateConfig({
            language: "zh-CN",
            outputStyle: {
              name: "Learning",
              prompt: "Explain tradeoffs while solving the task.",
            },
          });
        }
      },
    });
    try {
      await runtime.executeTurn("first");
      await runtime.executeTurn("second");
    } finally {
      unsubscribe();
    }

    expect(modelFactory.mock.calls.map(([input]) => input.selection.modelId)).toEqual([
      "model-a",
      "model-b",
    ]);
    expect(requests.map((request) => request.modelId)).toEqual(["model-a", "model-a", "model-b"]);
    expect(requests[0]?.text).toContain("model named test/model-a");
    expect(requests[0]?.text).not.toContain("Learning output style is active");
    expect(requests[1]?.text).toContain("model named test/model-a");
    expect(requests[1]?.text).not.toContain("model named test/model-b");
    expect(requests[1]?.text).not.toContain("Learning output style is active");
    expect(requests[2]?.text).toContain("model named test/model-b");
    expect(requests[2]?.text).toContain("Learning output style is active");
  });

  it("keeps the execution-scoped Model while permission approval pauses and resumes the loop", async () => {
    const registry = createToolRegistry();
    const handler = vi.fn(async () => "write-ok");
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: false,
        destructive: false,
        name: "WriteMarker",
        needsApproval: true,
        readOnly: false,
        riskLevel: "medium",
        sideEffectScope: "workspace",
      },
      handler,
    });

    let approve!: () => void;
    const permissionGate = new Promise<{ decision: "allow" }>((resolve) => {
      approve = () => resolve({ decision: "allow" });
    });
    const permissionBroker = {
      requestPermission: vi.fn(() => permissionGate),
    };
    const requestAuthSource = {
      resolve: vi.fn().mockResolvedValue({ apiKey: "permission-turn-key" }),
    };
    const modelCalls: string[] = [];
    const requestAuthSources: unknown[] = [];
    const modelFactory = vi.fn(
      (input: {
        selection: ModelSelection;
        requestDependencies?: { requestAuth?: { source?: unknown } };
      }) => {
        const modelSelection = modelSelectionFromSelection(input.selection);
        requestAuthSources.push(input.requestDependencies?.requestAuth?.source);
        let calls = 0;
        return {
          ...createLifecycleTestModel(modelSelection),
          async generateText(): Promise<ModelResult> {
            calls += 1;
            modelCalls.push(`${modelSelection.modelId}:${calls}`);
            return calls === 1
              ? result(modelSelection, {
                  finishReason: "tool-calls",
                  toolCalls: [{ id: "write-marker", name: "WriteMarker", input: {} }],
                })
              : result(modelSelection, { finishReason: "stop", text: "done" });
          },
        } satisfies Model;
      },
    );
    const runtime = createTestAgentRuntime(
      createSessionId("execution-model-permission-continuation"),
      {
        mode: "build",
        modelSelection: createTestModelSelection(createTestModelSelection("test/session-model")),
        workingDirectory: "/tmp/zcode-execution-model-permission",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: modelFactory as never,
        permissionBroker,
        toolRegistry: registry,
      },
    );

    const executing = runtime.executeTurn("permission task", undefined, {
      intent: {
        sourceCommandId: "permission-command",
        kind: "sendText",
        requestedDelivery: "start-now",
        modelSelection: { providerId: "temporary", modelId: "idle-model" },
      },
      modelExecution: {
        selectionScope: "execution",
        requestDependencies: { requestAuth: { source: requestAuthSource } },
      },
    });

    await vi.waitFor(() => expect(permissionBroker.requestPermission).toHaveBeenCalledTimes(1));
    expect(modelFactory).toHaveBeenCalledTimes(1);
    expect(modelCalls).toEqual(["idle-model:1"]);
    expect(requestAuthSources).toEqual([requestAuthSource]);

    approve();
    await executing;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(modelFactory).toHaveBeenCalledTimes(1);
    expect(modelCalls).toEqual(["idle-model:1", "idle-model:2"]);
    expect(runtime.getSessionModelSelection()).toMatchObject({
      providerId: "test",
      modelId: "session-model",
    });
  });

  it("keeps the execution-scoped Model and request auth while reactive compact retries after a session model switch", async () => {
    let runtime: ReturnType<typeof createTestAgentRuntime>;
    let overflowThrown = false;
    const createdModelIds: string[] = [];
    const createdRequestAuthSources: unknown[] = [];
    const callsByModel: string[] = [];
    const modelFactory = vi.fn(
      (input: {
        selection: ModelSelection;
        requestDependencies?: { requestAuth?: { source?: unknown } };
      }) => {
        const modelSelection = modelSelectionFromSelection(input.selection);
        createdModelIds.push(modelSelection.modelId);
        createdRequestAuthSources.push(input.requestDependencies?.requestAuth?.source);
        const model: Model = {
          providerId: modelSelection.providerId,
          modelId: modelSelection.modelId,
          properties: {
            contextWindow: 128_000,
            ...createTestModelFormatProperties(),
            supportsMidConversationSystem: false,
            supportsNativeWebSearch: false,
            supportsJsonSchemaOutput: true,
            supportsToolCall: true,
          },
          optionSpecs: {
            maxOutputTokens: { max: 8_000 },
          },
          options: { maxOutputTokens: 8_000 },
          bind() {
            return this;
          },
          async generateText(request: ModelRequest): Promise<ModelResult> {
            const requestText = JSON.stringify(request.messages);
            const compactRequest = requestText.includes("create a detailed summary");
            callsByModel.push(`${modelSelection.modelId}:${compactRequest ? "compact" : "normal"}`);
            if (compactRequest) {
              return result(modelSelection, {
                finishReason: "stop",
                text: "<summary>Keep the active loop model.</summary>",
              });
            }
            if (requestText.includes("trigger overflow") && !overflowThrown) {
              overflowThrown = true;
              runtime.setSessionModelSelection(
                createTestModelSelection(createTestModelSelection("test/model-b")),
              );
              const error = new Error("provider context window exceeded") as Error & {
                code: string;
              };
              error.code = ModelErrorCode.ModelContextExceeded;
              throw error;
            }
            return result(modelSelection, { finishReason: "stop", text: "done" });
          },
          streamText() {
            throw new Error("not used");
          },
        };
        return model;
      },
    );

    runtime = createTestAgentRuntime(
      createSessionId("model-lifecycle-reactive-compact"),
      {
        compact: { enabled: true },
        mode: "build",
        modelSelection: createTestModelSelection(createTestModelSelection("test/model-a")),
        workingDirectory: "/tmp/zcode-model-lifecycle-reactive",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: modelFactory as never,
      },
    );

    await runtime.executeTurn("first setup turn");
    await runtime.executeTurn("second setup turn");
    const requestAuthSource = {
      resolve: vi.fn().mockResolvedValue({ apiKey: "compact-turn-key" }),
    };
    await runtime.executeTurn("trigger overflow", undefined, {
      intent: {
        sourceCommandId: "compact-command",
        kind: "sendText",
        requestedDelivery: "start-now",
        modelSelection: { providerId: "temporary", modelId: "idle-model" },
      },
      modelExecution: {
        selectionScope: "execution",
        requestDependencies: { requestAuth: { source: requestAuthSource } },
      },
    });

    expect(createdModelIds).toEqual(["model-a", "model-a", "idle-model"]);
    expect(createdRequestAuthSources).toEqual([undefined, undefined, requestAuthSource]);
    expect(callsByModel.slice(-3)).toEqual([
      "idle-model:normal",
      "idle-model:compact",
      "idle-model:normal",
    ]);
  });

  it("attributes context usage to the Model executing the request", () => {
    const activeModelSelection = createTestModelSelection("test/model-a");
    const runtime = createTestAgentRuntime(
      createSessionId("model-context-usage-attribution"),
      { modelSelection: createTestModelSelection(createTestModelSelection("test/model-b")) },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({}),
      },
    );
    const activeModel: Model = {
      providerId: activeModelSelection.providerId,
      modelId: activeModelSelection.modelId,
      properties: {
        contextWindow: 128_000,
        ...createTestModelFormatProperties(),
        supportsMidConversationSystem: false,
        supportsNativeWebSearch: false,
        supportsJsonSchemaOutput: true,
        supportsToolCall: true,
      },
      optionSpecs: {
        maxOutputTokens: { max: 8_000 },
      },
      options: { maxOutputTokens: 8_000 },
      bind() {
        return this;
      },
      async generateText(): Promise<ModelResult> {
        return result(activeModelSelection, { finishReason: "stop" });
      },
      streamText() {
        throw new Error("not used");
      },
    };

    const snapshot = (runtime as any).buildContextUsageSnapshot({
      messages: [{ role: "user", content: "hello" }],
      model: activeModel,
      tools: [],
    });

    expect(snapshot.model).toBe("test/model-a");
  });

  it("attributes assistant history to the loop Model instead of provider result metadata", async () => {
    const activeModelSelection = createTestModelSelection("test/model-a");
    const reportedModelSelection = createTestModelSelection("provider/model-reported-by-provider");
    const model: Model = {
      providerId: activeModelSelection.providerId,
      modelId: activeModelSelection.modelId,
      properties: {
        contextWindow: 128_000,
        ...createTestModelFormatProperties(),
        supportsMidConversationSystem: false,
        supportsNativeWebSearch: false,
        supportsJsonSchemaOutput: true,
        supportsToolCall: true,
      },
      optionSpecs: {
        maxOutputTokens: { max: 8_000 },
      },
      options: { maxOutputTokens: 8_000 },
      bind() {
        return this;
      },
      async generateText(): Promise<ModelResult> {
        return result(reportedModelSelection, { finishReason: "stop", text: "done" });
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const runtime = createTestAgentRuntime(
      createSessionId("model-history-attribution"),
      { modelSelection: createTestModelSelection(activeModelSelection) },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: () => model,
      },
    );

    await runtime.executeTurn("hello");

    const assistant = (
      runtime as unknown as {
        messageHistory: {
          toRuntimeEntries(): Array<{
            message?: { modelId?: string; providerId?: string; role?: string };
          }>;
        };
      }
    ).messageHistory
      .toRuntimeEntries()
      .findLast((entry) => entry.message?.role === "assistant");
    expect(assistant?.message).toMatchObject({
      providerId: model.providerId,
      modelId: model.modelId,
    });
  });
});

function createLifecycleTestModel(modelSelection: ModelSelection): Model {
  return {
    providerId: modelSelection.providerId,
    modelId: modelSelection.modelId,
    properties: {
      contextWindow: 128_000,
      ...createTestModelFormatProperties(),
      supportsMidConversationSystem: false,
      supportsNativeWebSearch: false,
      supportsJsonSchemaOutput: true,
      supportsToolCall: true,
    },
    optionSpecs: {
      reasoningLevel: {
        values: ["low", "high"],
      },
      maxOutputTokens: { max: 8_000 },
    },
    options: {
      reasoningLevel: modelSelection.options?.reasoningLevel,
      maxOutputTokens: 8_000,
    },
    bind(options) {
      return { ...this, options: { ...this.options, ...options } };
    },
    async generateText(): Promise<ModelResult> {
      return result(modelSelection, { finishReason: "stop", text: "done" });
    },
    streamText() {
      throw new Error("not used");
    },
  };
}

function modelSelectionFromSelection(selection: ModelSelection): ModelSelection {
  return {
    providerId: createModelProviderId(selection.providerId),
    modelId: createModelId(selection.modelId),
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}

function result(
  modelSelection: ModelSelection,
  input: {
    finishReason: string;
    text?: string;
    toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  },
): ModelResult {
  return {
    finishReason: input.finishReason,
    text: input.text ?? "",
    toolCalls: input.toolCalls,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}
