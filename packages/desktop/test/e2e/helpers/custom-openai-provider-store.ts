import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  type ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  createE2EProviderModelSnapshot,
  getE2EAppDataPaths,
  type E2EModelProviderSnapshot,
  type E2EProviderModality,
} from "./desktop-app.js";
import { getUpstreamApiKey } from "./upstream-provider.js";

// 修复原因：WDIO worker 的 os.homedir() 可能不同于 desktop-app 使用的 E2E_HOME_DIR；
// direct seed 必须复用同一份 sandbox 路径，否则 Provider 会写到应用读不到的位置。
const E2E_APP_DATA_PATHS = getE2EAppDataPaths();
const PERSONAL_CONFIG_FILE = E2E_APP_DATA_PATHS.configFile;
const E2E_PROVIDER_RUNTIME_FILE = resolve(
  process.env.ZCODE_E2E_NETWORK_CAPTURE_DIR?.trim() ||
    resolve(E2E_APP_DATA_PATHS.homeDir, "..", ".e2e-network-capture"),
  "upstream-runtime.json",
);

const E2E_MODEL_CONTEXT_WINDOW = 200_000;
const E2E_MODEL_MAX_OUTPUT_TOKENS = 32_000;

export interface SeedCustomOpenAIProviderOptions {
  reasoningLevel?: NonNullable<
    ConstructorParameters<typeof ModelOptionSpecsConfig>[0]
  >["reasoningLevel"];
  baseURL?: string;
  // null 专用于不完整配置回归；undefined 保持普通 text-only 夹具。
  inputModalities?: readonly E2EProviderModality[] | null;
  modelId: string;
  providerId: string;
  providerName: string;
}

export async function seedCustomOpenAIChatCompletionsProvider({
  baseURL: explicitBaseURL,
  inputModalities,
  reasoningLevel,
  modelId,
  providerId,
  providerName,
}: SeedCustomOpenAIProviderOptions): Promise<E2EModelProviderSnapshot> {
  const baseURL = explicitBaseURL?.trim() || (await resolveSeededReplayBaseUrl());
  if (!baseURL) {
    throw new Error(
      "没有找到已 seed 的 replay provider Base URL，无法写入 OpenAI-compatible provider",
    );
  }

  const providerConfig = new ProviderConfig({
    // 新格式要求个人 Provider 明确分组，否则只有配置记录而无可执行模型。
    group: "standard-personal",
    access: new ApiKeyAccessConfig({ apiKey: getUpstreamApiKey() }),
    api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl: baseURL }),
    personalModelIds: [modelId],
  });
  const repository = new NodePersonalProviderConfigRepository({
    filePath: PERSONAL_CONFIG_FILE,
    pollingIntervalMs: false,
  });
  try {
    await repository.update((current) => ({
      ...current,
      providers: current.providers.setRule({ providerId, providerName, config: providerConfig }),
      models: current.models.setExact(
        providerId,
        modelId,
        createE2EModelConfig(inputModalities, reasoningLevel),
      ),
    }));
  } finally {
    repository.dispose();
  }

  // 返回值只是 E2E 对 Personal Config 的观察投影，不参与任何运行时装配。
  return createSeededOpenAIProvider({
    baseURL,
    inputModalities,
    modelId,
    providerId,
    providerName,
  });
}

export async function seedCustomAnthropicMessagesProvider({
  baseURL,
  modelId,
  providerId,
  providerName,
}: {
  baseURL: string;
  modelId: string;
  providerId: string;
  providerName: string;
}): Promise<E2EModelProviderSnapshot> {
  const providerConfig = new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig({ apiKey: getUpstreamApiKey() }),
    api: new ProviderApiConfig({
      type: "anthropic-messages",
      baseUrl: baseURL.replace(/\/+$/u, ""),
    }),
    personalModelIds: [modelId],
  });
  const repository = new NodePersonalProviderConfigRepository({
    filePath: PERSONAL_CONFIG_FILE,
    pollingIntervalMs: false,
  });
  try {
    await repository.update((current) => ({
      ...current,
      providers: current.providers.setRule({ providerId, providerName, config: providerConfig }),
      models: current.models.setExact(providerId, modelId, createE2EModelConfig(["text"])),
    }));
  } finally {
    repository.dispose();
  }
  const now = Date.now();
  return {
    id: providerId,
    name: providerName,
    apiFormat: "anthropic-messages",
    apiKey: getUpstreamApiKey(),
    apiKeyRequired: true,
    defaultKind: "anthropic",
    endpoints: { baseURL, paths: { anthropic: "" } },
    models: [
      createE2EProviderModelSnapshot({
        id: modelId,
        kinds: ["anthropic"],
        defaultKind: "anthropic",
        contextWindow: E2E_MODEL_CONTEXT_WINDOW,
        maxOutputTokens: E2E_MODEL_MAX_OUTPUT_TOKENS,
        supportsTools: true,
        supportsJsonSchemaOutput: false,
      }),
    ],
    source: "custom",
    createdAt: now,
    updatedAt: now,
  };
}

export async function resolveSeededReplayBaseUrl() {
  const envBaseURL = process.env.E2E_PROVIDER_RUNTIME_BASE_URL?.trim();
  if (envBaseURL) return normalizeReplayRootBaseUrl(envBaseURL);

  const runtimeBaseURL = await readReplayRootBaseUrlFromRuntimeFile();
  if (runtimeBaseURL) return runtimeBaseURL;

  const personal = await readPersonalProviderConfig();
  for (const [, provider] of personal.providers.entries()) {
    if (
      provider.access?.type === "api-key" &&
      provider.access.apiKey?.trim() === getUpstreamApiKey()
    ) {
      return normalizeReplayRootBaseUrl(provider.api?.baseUrl ?? "");
    }
  }
  return "";
}

function createE2EModelConfig(
  inputModalities: readonly E2EProviderModality[] | null | undefined,
  reasoningLevel?: SeedCustomOpenAIProviderOptions["reasoningLevel"],
): ModelConfig {
  const inputs = new Set(inputModalities ?? ["text"]);
  return new ModelConfig({
    // direct seed 曾只保存部分字段：本地设置页无法收录，远端也不能接受它作为默认模型。
    enabled: true,
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: E2E_MODEL_CONTEXT_WINDOW,
      inputFormat:
        inputModalities === null
          ? null
          : {
              supportsText: inputs.has("text"),
              supportsImage: inputs.has("image"),
              supportsVideo: inputs.has("video"),
              supportsAudio: inputs.has("audio"),
              supportsPdf: inputs.has("pdf"),
            },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      // 专项需要完整声明待验证档位与 wire；默认夹具仍保持无思考参数。
      reasoningLevel: reasoningLevel ?? { values: ["disabled"], map: "{}" },
      maxOutputTokens: {
        max: E2E_MODEL_MAX_OUTPUT_TOKENS,
        map: '{"max_completion_tokens":maxOutputTokens}',
      },
    }),
  });
}

function createSeededOpenAIProvider({
  baseURL,
  inputModalities,
  modelId,
  providerId,
  providerName,
}: SeedCustomOpenAIProviderOptions & { baseURL: string }): E2EModelProviderSnapshot {
  const now = Date.now();
  const model = createE2EProviderModelSnapshot({
    id: modelId,
    kinds: ["openai-compatible"],
    defaultKind: "openai-compatible",
    contextWindow: E2E_MODEL_CONTEXT_WINDOW,
    maxOutputTokens: E2E_MODEL_MAX_OUTPUT_TOKENS,
    supportsTools: true,
    supportsJsonSchemaOutput: false,
    ...(inputModalities ? { modalities: { input: inputModalities, output: ["text"] } } : {}),
  });
  return {
    id: providerId,
    name: providerName,
    apiFormat: "openai-chat-completions",
    apiKey: getUpstreamApiKey(),
    apiKeyRequired: true,
    defaultKind: "openai-compatible",
    endpoints: { baseURL, paths: { "openai-compatible": "" } },
    models: [model],
    source: "custom",
    createdAt: now,
    updatedAt: now,
  };
}

async function readPersonalProviderConfig(): Promise<ProviderConfigLayerSnapshot> {
  const repository = new NodePersonalProviderConfigRepository({
    filePath: PERSONAL_CONFIG_FILE,
    pollingIntervalMs: false,
  });
  try {
    return await repository.read();
  } finally {
    repository.dispose();
  }
}

async function readReplayRootBaseUrlFromRuntimeFile() {
  try {
    const json = JSON.parse(await readFile(E2E_PROVIDER_RUNTIME_FILE, "utf-8")) as {
      baseUrl?: string;
    };
    return normalizeReplayRootBaseUrl(json.baseUrl ?? "");
  } catch {
    return "";
  }
}

function normalizeReplayRootBaseUrl(baseURL: string) {
  const trimmed = baseURL.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/anthropic") ? trimmed.slice(0, -"/anthropic".length) : trimmed;
}

/**
 * 从 Personal Config 删除一个自定义 Provider 及其模型规则，模拟 Provider 从 Registry 下架
 * （套餐到期 / 切账号后的会话常驻模型失效场景）。写盘后仍需走设置页刷新让进程 Registry 重读。
 */
export async function removeCustomProviderFromPersonalConfig(providerId: string): Promise<void> {
  const repository = new NodePersonalProviderConfigRepository({
    filePath: PERSONAL_CONFIG_FILE,
    pollingIntervalMs: false,
  });
  try {
    await repository.update((current) => ({
      ...current,
      providers: current.providers.delete(providerId),
      models: current.models.deleteExactForProvider(providerId),
    }));
  } finally {
    repository.dispose();
  }
}
