import {
  createModel as createExecutableModel,
  type AiSdkModelAdapter,
  type CreateAiSdkModelOptions,
} from "@zcode/adapters/model";
import { afterEach } from "vitest";
import { type ModelEvent, type ModelRequest, type ModelResult } from "@zcode/contracts";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderRegistry,
  type Provider,
} from "@zcode/provider";
import { createZCodeApp } from "../../src/app/create-app.js";
import type { ZCodeApp, ZCodeAppOptions } from "../../src/app/types.js";
import { createApiKeyProviderConfig } from "../provider-config-fixtures.js";

const DEFAULT_TEST_MODEL = {
  providerId: "zai",
  modelId: "glm-4.6",
} as const;

export interface RegistryBackedTestModelExecution {
  providerId: string;
  modelId: string;
}

export interface RegistryBackedTestModelExecutor {
  generateText(
    request: ModelRequest,
    execution: RegistryBackedTestModelExecution,
  ): Promise<ModelResult>;
  streamText?(
    request: ModelRequest,
    execution: RegistryBackedTestModelExecution,
  ): AsyncIterable<ModelEvent>;
}

type RegistryBackedTestAppOptions = Omit<ZCodeAppOptions, "providerRegistry"> & {
  modelExecutor?: RegistryBackedTestModelExecutor;
  providerRegistry?: ZCodeAppOptions["providerRegistry"];
};

const openedApps: Awaited<ReturnType<typeof createZCodeApp>>[] = [];

afterEach(async () => {
  // 仅关闭数据库会留下 App 的配置 watcher，后续用例持续累积监听和读取；按 App 所有权回收。
  for (const app of openedApps.splice(0)) await app.close?.();
});

export async function createRegistryBackedTestApp(
  options: RegistryBackedTestAppOptions = {},
): Promise<ZCodeApp> {
  const modelSelections = collectModelSelections(options);
  const providerRegistry = options.providerRegistry ?? createTestProviderRegistry(modelSelections);
  const { modelExecutor, ...appOptions } = options;

  const app = await createZCodeApp({
    ...appOptions,
    runtimeConfig: {
      ...appOptions.runtimeConfig,
      // 测试基座默认关闭标题生成，避免无关 Session 测试产生额外模型调用与事件。
      titleGeneration: appOptions.runtimeConfig?.titleGeneration ?? { enabled: false },
    },
    providerRegistry,
    ...(modelExecutor ? { modelAdapter: createRegistryBackedTestModelAdapter(modelExecutor) } : {}),
  });
  openedApps.push(app);
  return app;
}

export function createTestProviderRegistry(
  modelSelections: readonly { providerId: string; modelId: string }[] = [DEFAULT_TEST_MODEL],
): ProviderRegistry {
  const orderedSelections = dedupeModelSelections([DEFAULT_TEST_MODEL, ...modelSelections]);
  const modelsByProvider = new Map<string, string[]>();
  for (const selection of orderedSelections) {
    const providerId = String(selection.providerId);
    const modelId = String(selection.modelId);
    const models = modelsByProvider.get(providerId) ?? [];
    models.push(modelId);
    modelsByProvider.set(providerId, models);
  }

  const providers: Provider[] = Array.from(modelsByProvider, ([providerId, modelIds]) => ({
    providerId,
    config: createApiKeyProviderConfig({
      apiFormat: "anthropic-messages",
      apiKey: "registry-test-key",
      baseURL: `https://${providerId}.registry.test`,
      models: modelIds,
    }),
    models: modelIds.map((modelId) => ({
      modelId,
      config: createTestModelConfig(),
    })),
  }));
  return new ProviderRegistry(providers);
}

function createTestModelConfig(): ModelConfig {
  const reasoningLevels = ["low", "medium", "high", "deep"] as const;
  return new ModelConfig({
    enabled: true,
    visibility: "visible",

    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 1_000_000,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: false,
        supportsPdf: true,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: {
        values: reasoningLevels,
        map: '{"output_config":{"effort":reasoningLevel}}',
      },
      maxOutputTokens: {
        max: 1_000_000,
        map: '{"max_tokens":maxOutputTokens}',
      },
    }),
  });
}

function collectModelSelections(
  options: RegistryBackedTestAppOptions,
): { providerId: string; modelId: string }[] {
  const selections: { providerId: string; modelId: string }[] = [];
  const add = (selection: { providerId: string; modelId: string } | undefined) => {
    if (selection) selections.push(selection);
  };
  if (options.runtimeConfig?.modelSelection) {
    selections.push(options.runtimeConfig.modelSelection);
  }
  add(options.runtimeConfig?.titleGeneration?.modelSelection);
  if (options.configuredDefaultModelSelection) {
    selections.push(options.configuredDefaultModelSelection);
  }
  return selections;
}

function dedupeModelSelections(
  selections: readonly { providerId: string; modelId: string }[],
): { providerId: string; modelId: string }[] {
  const seen = new Set<string>();
  return selections.filter((selection) => {
    const key = `${String(selection.providerId)}/${String(selection.modelId)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createRegistryBackedTestModelAdapter(
  executor: RegistryBackedTestModelExecutor,
): AiSdkModelAdapter {
  return {
    addStatusSink: () => {},
    createModel: (input: CreateAiSdkModelOptions) => {
      const execution = (request: ModelRequest): RegistryBackedTestModelExecution => ({
        providerId: input.providerId,
        modelId: input.modelId,
      });
      return createExecutableModel({
        providerId: input.providerId,
        modelId: input.modelId,
        displayName: input.displayName,
        properties: input.modelConfig.properties,
        optionSpecs: input.modelConfig.optionSpecs,
        options: input.options,
        executor: {
          generateText: (request) => executor.generateText(request, execution(request)),
          streamText: (request) =>
            executor.streamText?.(request, execution(request)) ??
            streamResult(executor.generateText(request, execution(request))),
        },
      });
    },
    setModelIoFullRetentionEnabled: () => {},
  } as unknown as AiSdkModelAdapter;
}

async function* streamResult(result: Promise<ModelResult>): AsyncIterable<ModelEvent> {
  const resolved = await result;
  if (resolved.text) {
    yield { id: "bootstrap-test-text", type: "text_start" };
    yield { id: "bootstrap-test-text", text: resolved.text, type: "text_delta" };
    yield { id: "bootstrap-test-text", type: "text_end" };
  }
  yield {
    finishReason: resolved.finishReason,
    type: "finish",
    usage: resolved.usage,
  };
}
