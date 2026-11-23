import { describe, expect, it } from "vitest";
import { createConfig } from "@zcode/adapters/config";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderRegistry,
} from "@zcode/provider";
import type { ModelSelection } from "@zcode/contracts";
import { resolveAppRuntimeConfig } from "../src/app/runtime-config.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";

const identity = { providerId: "provider-a", modelId: "model-a" };
const complete = { ...identity, options: { reasoningLevel: "high" } };

function createRegistry() {
  return new ProviderRegistry([
    {
      providerId: identity.providerId,
      config: createApiKeyProviderConfig({
        apiFormat: "openai-chat-completions",
        apiKey: "test",
        baseURL: "https://example.test",
        models: [identity.modelId],
      }),
      models: [
        {
          modelId: identity.modelId,
          config: new ModelConfig({
            enabled: true,
            visibility: "visible",

            properties: new ModelPropertiesConfig({
              requiresMfjsToolSchema: false,
              contextWindow: 200_000,
              inputFormat: {
                supportsText: true,
                supportsImage: false,
                supportsVideo: false,
                supportsAudio: false,
                supportsPdf: false,
              },
              outputFormat: { supportsText: true },
              supportsToolCall: true,
              supportsJsonSchemaOutput: true,
              supportsNativeWebSearch: false,
              supportsMidConversationSystem: true,
            }),
            optionSpecs: new ModelOptionSpecsConfig({
              reasoningLevel: {
                values: ["low", "high"],
                map: '{"reasoning_effort":reasoningLevel}',
              },
              maxOutputTokens: {
                max: 32_000,
                map: '{"max_tokens":maxOutputTokens}',
              },
            }),
          }),
        },
      ],
    },
  ]);
}

function resolve(resume: boolean, modelSelection?: ModelSelection, registry = createRegistry()) {
  return resolveAppRuntimeConfig({
    mcpConfiguration: { enabled: false, servers: {} },
    cliStorageRoot: "/test/cli",
    configResult: createConfig({ env: {}, skipUserConfig: true, workingDirectory: "/test" }),
    options: {
      resume,
      providerRegistry: registry,
      configuredDefaultModelSelection: complete,
      runtimeConfig: { modelSelection },
    },
    subagentOutputRootDir: "/test/agents",
    workingDirectory: "/test",
  }).runtimeConfig;
}

describe("Runtime 创建与未绑定恢复的边界", () => {
  it("新建会话没有 configured default 时使用正式初始推荐，历史恢复仍保持未绑定", () => {
    const config = resolveAppRuntimeConfig({
      mcpConfiguration: { enabled: false, servers: {} },
      cliStorageRoot: "/test/cli",
      configResult: createConfig({ env: {}, skipUserConfig: true, workingDirectory: "/test" }),
      options: { providerRegistry: createRegistry() },
      subagentOutputRootDir: "/test/agents",
      workingDirectory: "/test",
    });
    // Todo 58/88 的初始选择规则允许 Registry 推荐；下面的 resume 场景仍禁止默认值覆盖历史。
    expect(config.runtimeConfig.modelSelection).toEqual(complete);
  });
  it.each([
    undefined,
    identity,
    { ...identity, options: { reasoningLevel: "removed" } },
    { ...complete, providerId: "removed" },
    { ...complete, modelId: "removed" },
  ])("恢复不完整选择 %j 时不报错、不选择 configured default", (selection) => {
    expect(resolve(true, selection).modelSelection).toBeUndefined();
  });
  it("Registry 为空仍允许恢复历史", () => {
    expect(resolve(true, undefined, new ProviderRegistry([])).modelSelection).toBeUndefined();
  });
  it("完整选择恢复时原样保留", () => {
    expect(resolve(true, complete).modelSelection).toEqual(complete);
  });
  it("新建会话仍正常使用 configured default", () => {
    expect(resolve(false).modelSelection).toEqual(complete);
  });
});
