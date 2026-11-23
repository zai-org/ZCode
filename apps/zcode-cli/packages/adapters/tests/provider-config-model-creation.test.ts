import { describe, expect, it } from "vitest";
import type { ModelNetworkStatusEvent } from "@zcode/contracts";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelInputFormatConfig,
  ModelOptionSpecsConfig,
  ModelOutputFormatConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  type RegistryModelConfig,
  type RegistryProviderConfig,
} from "@zcode/provider";
import { AiSdkModelAdapter } from "../src/model/runner.js";
import type { AiSdkModelRuntime } from "../src/model/runner-runtime.js";

describe("AiSdkModelAdapter Provider Config creation", () => {
  it("keeps option maps out of duplicate AI SDK provider options", async () => {
    const requests: Array<{ providerOptions?: Record<string, unknown> }> = [];
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        requests.push(options);
        return {
          finishReason: "stop",
          text: "done",
          totalUsage: {},
          usage: {},
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const providerConfig = new ProviderConfig({
      access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
      api: new ProviderApiConfig({
        type: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
      builtinModelIds: ["gpt-5.6-sol"],
      enabled: true,
      id: "openai",
      personalModelIds: [],
      name: "OpenAI",
      visibility: "visible",
    }) as RegistryProviderConfig;
    const modelConfig = new ModelConfig({
      enabled: true,

      properties: new ModelPropertiesConfig({
        requiresMfjsToolSchema: false,
        contextWindow: 1_050_000,
        inputFormat: new ModelInputFormatConfig({
          supportsText: true,
          supportsImage: true,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: true,
        }),
        outputFormat: new ModelOutputFormatConfig({ supportsText: true }),
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      }),
      optionSpecs: new ModelOptionSpecsConfig({
        reasoningLevel: {
          values: ["none", "low", "medium", "high", "xhigh", "max"],
          map: '{"reasoning":{"effort":reasoningLevel}}',
        },
        maxOutputTokens: {
          max: 128_000,
          map: '{"max_output_tokens":maxOutputTokens}',
        },
      }),
    }) as RegistryModelConfig;
    const adapter = new AiSdkModelAdapter({
      runtime,
      statusSink: { publish: (event) => statusEvents.push(event) },
    });
    const model = adapter.createModel({
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      providerConfig,
      modelConfig,
      options: { maxOutputTokens: 128_000, reasoningLevel: "max" },
    });

    await model.generateText({ messages: [{ role: "user", content: "hello" }] });
    await model.generateText({
      messages: [{ role: "user", content: "summarize cheaply" }],
      options: { reasoningLevel: "none" },
    });

    // openai 段是 Responses 加密推理回传的选项，store 和 include 由同一处写出；两个档位的推理映射
    // 都写了 reasoning，所以都带 include。映射本身的字段仍只进请求体，不复制进 providerOptions。
    const responsesOptions = {
      apiFormat: "openai-responses",
      openai: { store: false, include: ["reasoning.encrypted_content"] },
    };
    expect(requests.map((request) => request.providerOptions)).toEqual([
      responsesOptions,
      responsesOptions,
    ]);
    expect(model.options).toEqual({ maxOutputTokens: 128_000, reasoningLevel: "max" });
    expect(
      statusEvents
        .filter((event) => event.type === "model_request_started")
        .map((event) => event.modelCall.reasoning),
    ).toEqual([
      expect.objectContaining({
        requestedControl: "provider_default",
        requestedLevel: "max",
        requestedState: "provider_default",
      }),
      expect.objectContaining({
        requestedControl: "provider_default",
        requestedLevel: "none",
        requestedState: "provider_default",
      }),
    ]);
  });
});
