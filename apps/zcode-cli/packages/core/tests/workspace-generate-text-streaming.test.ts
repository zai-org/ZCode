import { describe, expect, it } from "vitest";
import { createTestModelSelection } from "./test-model-selection.js";
import type {
  Model,
  ModelInvocationContext,
  ModelOptions,
  ModelRequest,
  SessionTaskType,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createSessionId, getCurrentModelInvocationContext } from "@zcode/contracts";
import { createRuntimeModel } from "../src/runtime/methods/runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFormatProperties } from "./test-runtime-model.js";

function createStreamingModel(overrides?: {
  streamEvents?: AsyncIterable<{ type: string; [key: string]: unknown }>;
  streamError?: Error;
  reasoningLevels?: readonly string[];
  maxOutputTokens?: number;
  onBind?: (options: ModelOptions | undefined) => void;
  onRequest?: (request: ModelRequest) => void;
}): Model {
  const model: Model = {
    providerId: "test-provider",
    modelId: "glm-test",
    properties: {
      contextWindow: 128_000,
      ...createTestModelFormatProperties(),
      supportsMidConversationSystem: false,
      supportsNativeWebSearch: false,
      supportsJsonSchemaOutput: false,
      supportsToolCall: true,
    },
    optionSpecs: {
      reasoningLevel: {
        values: overrides?.reasoningLevels ?? ["disabled"],
      },
      maxOutputTokens: { max: overrides?.maxOutputTokens ?? 128_000 },
    },
    options: {
      maxOutputTokens: 128_000,
      reasoningLevel: overrides?.reasoningLevels?.at(-1) ?? "disabled",
    },
    bind(options) {
      overrides?.onBind?.(options);
      return this;
    },
    async generateText(_request: ModelRequest) {
      throw new Error("generateText should not be called");
    },
    streamText(request: ModelRequest) {
      overrides?.onRequest?.(request);
      if (overrides?.streamError) {
        return (async function* () {
          yield { type: "start" };
          throw overrides.streamError;
        })();
      }
      const events = overrides?.streamEvents ?? [];
      return (async function* () {
        yield* events as AsyncIterable<{ type: string; [key: string]: unknown }>;
      })();
    },
  } as unknown as Model;
  return model;
}

function createRuntimeWithModel(model: Model, taskType: SessionTaskType = "interactive") {
  return createTestAgentRuntime(
    createSessionId("workspace-generate-text-streaming"),
    {
      taskType,
      modelSelection: createTestModelSelection(
        createTestModelSelection("test-provider/glm-test", {}),
      ),
    },
    {
      eventStore: createTestSessionEventStore(),
      modelFactory: () => model,
    },
  );
}

describe("workspace generateText streaming aggregation", () => {
  it.each([
    ["interactive", "main"],
    ["subagent_child", "subagent"],
    ["selection_side_chat", "side_chat"],
  ] as const)(
    "workspace calls borrowing a %s runtime stay other without reclassifying session requests",
    async (taskType, expectedSessionType) => {
      const seen: (ModelInvocationContext | undefined)[] = [];
      const model = createStreamingModel({
        onRequest: () => seen.push(getCurrentModelInvocationContext()),
        streamEvents: (async function* () {
          yield { type: "finish", finishReason: "stop" };
        })(),
      });
      model.generateText = async () => {
        seen.push(getCurrentModelInvocationContext());
        return { text: "ok", finishReason: "stop" };
      };
      const runtime = createRuntimeWithModel(model, taskType);
      const selection = { providerId: "test-provider", modelId: "glm-test" };
      await Promise.all([
        runtime.testModelConnectivity({ selection }),
        runtime.generateWorkspaceText({
          selection,
          prompt: "Write a commit message",
          querySource: "git_commit_message",
        }),
        createRuntimeModel(runtime as never, { selection }).generateText({ messages: [] }),
      ]);
      expect(seen).toHaveLength(3);
      expect(
        seen.find((context) => context?.metadata?.querySource === "provider_settings_connectivity")
          ?.modelRequestSessionType,
      ).toBe("other");
      expect(
        seen.find((context) => context?.metadata?.querySource === "git_commit_message")
          ?.modelRequestSessionType,
      ).toBe("other");
      expect(seen.find((context) => !context?.metadata?.querySource)?.modelRequestSessionType).toBe(
        expectedSessionType,
      );
    },
  );

  it("connectivity test creates the selected formal Model and consumes streamText", async () => {
    let streamConsumed = false;
    async function* events() {
      yield { type: "start" };
      yield { type: "text_delta", text: "ok" };
      yield { type: "finish", finishReason: "stop", usage: { totalTokens: 1 } };
      streamConsumed = true;
    }
    const model = createStreamingModel({ streamEvents: events() });
    const runtime = createRuntimeWithModel(model);

    await runtime.testModelConnectivity({
      selection: { providerId: "test-provider", modelId: "glm-test" },
    });

    expect(streamConsumed).toBe(true);
  });

  it("binds the lowest public reasoning level for connectivity tests", async () => {
    let boundOptions: ModelOptions | undefined;
    const model = createStreamingModel({
      reasoningLevels: ["low", "high", "max"],
      onBind: (options) => {
        boundOptions = options;
      },
      streamEvents: (async function* () {
        yield { type: "finish", finishReason: "stop" };
      })(),
    });
    const runtime = createRuntimeWithModel(model);

    await runtime.testModelConnectivity({
      selection: { providerId: "test-provider", modelId: "glm-test" },
    });

    expect(boundOptions).toEqual({ maxOutputTokens: 512, reasoningLevel: "low" });
  });

  it.each([
    { maxOutputTokens: 1, expectedBudget: 1 },
    { maxOutputTokens: 256, expectedBudget: 256 },
    { maxOutputTokens: 512, expectedBudget: 512 },
    { maxOutputTokens: 1024, expectedBudget: 512 },
  ])(
    "respects output cap $maxOutputTokens with reasoning disabled",
    async ({ maxOutputTokens, expectedBudget }) => {
      let boundOptions: ModelOptions | undefined;
      const model = createStreamingModel({
        maxOutputTokens,
        onBind: (options) => {
          boundOptions = options;
        },
        streamEvents: (async function* () {
          yield { type: "finish", finishReason: "stop" };
        })(),
      });
      const runtime = createRuntimeWithModel(model);

      await runtime.testModelConnectivity({
        selection: { providerId: "test-provider", modelId: "glm-test" },
      });

      expect(boundOptions).toEqual({ maxOutputTokens: expectedBudget, reasoningLevel: "disabled" });
    },
  );

  it.each(["stop", "length"])("accepts %s without any response text", async (finishReason) => {
    const model = createStreamingModel({
      streamEvents: (async function* () {
        yield { type: "start" };
        yield { type: "finish", finishReason, usage: { outputTokens: 1 } };
      })(),
    });
    await expect(
      createRuntimeWithModel(model).testModelConnectivity({
        selection: { providerId: "test-provider", modelId: "glm-test" },
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    "test-provider",
    "account:bigmodel-start-plan",
    "account:bigmodel-individual-coding-plan",
    "account:zai-team-coding-plan",
  ])("keeps the exact connectivity whitelist messages for %s", async (providerId) => {
    let receivedRequest: ModelRequest | undefined;
    const model = createStreamingModel({
      onRequest: (request) => {
        receivedRequest = request;
      },
      streamEvents: (async function* () {
        yield { type: "finish", finishReason: "stop" };
      })(),
    });
    const runtime = createRuntimeWithModel(model);

    await runtime.testModelConnectivity({
      selection: { providerId, modelId: "glm-test" },
    });

    expect(receivedRequest?.messages).toEqual([
      { role: "system", content: "You are ZCode connectivity probe." },
      { role: "user", content: "hi" },
    ]);
    expect(receivedRequest?.tools).toBeUndefined();
    expect(Object.keys(receivedRequest!).sort()).toEqual(["abortSignal", "messages"]);
  });

  it.each(["throw", "error-event", "no-finish"])(
    "does not report connectivity success for %s",
    async (failure) => {
      const model = createStreamingModel({
        ...(failure === "throw" ? { streamError: new Error("probe rejected") } : {}),
        streamEvents: (async function* () {
          if (failure === "error-event")
            yield { type: "error", error: new Error("probe rejected") };
          else yield { type: "text_delta", text: "partial" };
        })(),
      });
      await expect(
        createRuntimeWithModel(model).testModelConnectivity({
          selection: { providerId: "test-provider", modelId: "glm-test" },
        }),
      ).rejects.toThrow(failure === "no-finish" ? "finish" : "probe rejected");
    },
  );

  it("keeps non-stream generateText for the git commit message querySource", async () => {
    let streamCalled = false;
    let boundOptions: ModelOptions | undefined;
    const model = createStreamingModel({
      onBind: (options) => {
        boundOptions = options;
      },
    });
    model.streamText = ((request: ModelRequest) => {
      void request;
      streamCalled = true;
      throw new Error("streamText should not be called");
    }) as never;
    model.generateText = async () => ({
      finishReason: "stop",
      text: "fix: commit message",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const runtime = createRuntimeWithModel(model);

    const result = await runtime.generateWorkspaceText({
      selection: { providerId: "test-provider", modelId: "glm-test" },
      prompt: "Generate a commit message",
      querySource: "git_commit_message",
      maxOutputTokens: 256,
    });

    expect(streamCalled).toBe(false);
    expect(result.text).toBe("fix: commit message");
    expect(boundOptions).toEqual({ maxOutputTokens: 5_000, reasoningLevel: "disabled" });
  });
});
