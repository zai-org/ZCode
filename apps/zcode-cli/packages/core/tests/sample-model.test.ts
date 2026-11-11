import { describe, expect, it, vi } from "vitest";
import { getCurrentModelInvocationContext, type ModelStatusSink } from "@zcode/contracts";
import { sampleModel } from "../src/runtime/methods/sample-model.js";
import { createModelStatusSink } from "../src/runtime/methods/model-status.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

const input = {
  request: {
    messages: [
      { role: "user" as const, content: { type: "text" as const, text: "Explain fractions" } },
    ],
    maxTokens: 400,
  },
  source: { pluginId: "lesson", serverName: "teacher", appIdentity: "app" },
};
function fixture() {
  const usage = vi.fn(async () => {});
  const generateText = vi.fn(async (_request: unknown) => ({
    text: "A half is 1/2",
    finishReason: "stop",
    usage: { inputTokens: 12, outputTokens: 8 },
  }));
  const model = {
    providerId: "fixture",
    modelId: "math",
    properties: { inputFormat: { supportsText: true, supportsImage: true } },
    optionSpecs: { maxOutputTokens: { max: 100 } },
    options: {},
    generateText,
    streamText: vi.fn(),
    bind: vi.fn(),
  };
  const runtime = {
    config: { mode: "plan", taskType: "interactive" },
    sessionId: "task",
    sessionFeatures: new Set(),
    rootTraceContext: { traceId: "trace", spanId: "parent" },
    modelFactory: vi.fn(() => model),
    getSessionModelSelection: vi.fn(() => ({ providerId: "fixture", modelId: "math" })),
    ensureSessionPersisted: vi.fn(async () => {}),
    appendEvent: vi.fn(),
    logModelNetworkStatus: vi.fn(),
    createEvent: vi.fn((type, payload) => ({ type, payload, timestamp: new Date() })),
    createModelStatusSink,
    extractToolCallsFromResult: vi.fn(() => []),
    sessionStore: {
      recordModelUsage: usage,
      upsertTurnUsage: vi.fn(),
      upsertToolUsage: vi.fn(),
    },
  } as unknown as AgentRuntimeInternal;
  return {
    runtime,
    model,
    usage,
    generateText,
    options: { abortSignal: new AbortController().signal },
  };
}
describe("task-bound sampling execution", () => {
  it.each(["success", "failure", "cancelled"] as const)(
    "releases status publishing after %s",
    async (outcome) => {
      const f = fixture();
      let sink: ModelStatusSink | undefined;
      f.generateText.mockImplementationOnce(async () => {
        sink = getCurrentModelInvocationContext()?.statusSink;
        if (outcome !== "success")
          throw outcome === "cancelled"
            ? new DOMException("cancelled", "AbortError")
            : new Error("sampling failed");
        return { text: "done", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      });
      await sampleModel.call(f.runtime, input, f.options).catch(() => {});
      expect(sink).toBeDefined();
      await sink!.publish({ type: "model_request_started", attempt: 1 } as never);
      expect(f.runtime.logModelNetworkStatus).not.toHaveBeenCalled();
    },
  );

  it("uses task model, limits output, keeps main history unchanged and records usage", async () => {
    const f = fixture();
    f.generateText.mockImplementationOnce(async () => {
      await getCurrentModelInvocationContext()?.statusSink?.publish({
        type: "model_request_started",
        attempt: 1,
      } as never);
      return { text: "A half", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 8 } };
    });
    expect(
      await sampleModel.call(
        f.runtime,
        {
          ...input,
          request: {
            ...input.request,
            systemPrompt: "Teach gently",
            modelPreferences: { hints: [{ name: "other" }] },
          },
        },
        f.options,
      ),
    ).toEqual({
      role: "assistant",
      model: "math",
      content: { type: "text", text: "A half" },
      stopReason: "endTurn",
    });
    expect(f.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: "Teach gently" },
          { role: "user", content: [{ type: "text", text: "Explain fractions" }] },
        ],
        options: { maxOutputTokens: 100 },
      }),
    );
    expect(f.runtime.appendEvent).not.toHaveBeenCalled();
    expect(f.runtime.modelFactory).toHaveBeenCalledWith({
      selection: { providerId: "fixture", modelId: "math" },
    });
    expect(f.usage).toHaveBeenCalledWith(
      expect.objectContaining({
        querySource: "mcp_app_sampling",
        status: "completed",
        sessionID: "task",
        outputTokens: 8,
      }),
    );
  });
  it("passes images as image input and refuses unsupported models before calling them", async () => {
    const f = fixture();
    const imageInput = {
      ...input,
      request: {
        ...input.request,
        messages: [
          {
            role: "user" as const,
            content: { type: "image" as const, mimeType: "image/png" as const, data: "AQ==" },
          },
        ],
      },
    };
    await sampleModel.call(f.runtime, imageInput, f.options);
    expect(f.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,AQ==" },
            ],
          },
        ],
      }),
    );
    f.model.properties.inputFormat.supportsImage = false;
    await expect(sampleModel.call(f.runtime, imageInput, f.options)).rejects.toThrow("image input");
    expect(f.generateText).toHaveBeenCalledTimes(1);
  });
  it("keeps truncated stop reason and records cancelled usage on late success", async () => {
    const f = fixture();
    f.generateText.mockResolvedValueOnce({
      text: "Partial",
      finishReason: "length",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect((await sampleModel.call(f.runtime, input, f.options)).stopReason).toBe("maxTokens");
    const abort = new AbortController();
    f.generateText.mockImplementationOnce(async () => {
      abort.abort();
      return { text: "late", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
    });
    await expect(
      sampleModel.call(f.runtime, input, { abortSignal: abort.signal }),
    ).rejects.toThrow();
    expect(f.usage).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "cancelled", outputTokens: 1 }),
    );
    expect(f.runtime.appendEvent).not.toHaveBeenCalled();
  });
});
