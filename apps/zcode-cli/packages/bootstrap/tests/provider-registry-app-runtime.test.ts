import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import * as executionAdapters from "@zcode/adapters/exec";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  createProjectId,
  createSessionId,
  type Model,
} from "@zcode/contracts";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderRegistry,
} from "@zcode/provider";
import { describe, expect, it, vi } from "vitest";
import { createZCodeApp } from "../src/app/create-app.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import type { V4SessionRecordView } from "../src/zcode-protocol-v4/commands/types.js";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

const { createModelAdapterMock } = vi.hoisted(() => ({
  createModelAdapterMock: vi.fn(),
}));

vi.mock("../src/model-factory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/model-factory.js")>()),
  createModelAdapter: createModelAdapterMock,
}));

describe("ZCode App Provider Registry runtime", () => {
  it.each(["", "   ", "high", "invalid"])(
    "同名模型跨 Provider 命令通过真实 Registry/facade 校验 thought=%j",
    async (thought) => {
      const storageDir = await mkdtemp(join(tmpdir(), "registry-switch-"));
      const registry = new ProviderRegistry([
        provider(),
        { ...provider(), providerId: "provider-b" },
      ]);
      const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
      const previous = {
        providerId: "provider-a",
        modelId: "model-b",
        options: { reasoningLevel: "low" },
      };
      const app = await createZCodeApp({
        configuredDefaultModelSelection: previous,
        readSubagentRuntimeConfig: async () => ({ kind: "built-in-fallback" }),
        env: {},
        modelAdapter: fakeModelAdapter(),
        providerRegistry: registry,
        runtimeConfig: {
          mcp: { enabled: false },
          workingDirectory: process.cwd(),
          storage: { dir: storageDir },
        },
        sessionStore,
        skipUserConfig: true,
      });
      const selected = vi.spyOn(app.runtime, "emitModelSelected");
      const persisted = vi.spyOn(sessionStore, "saveSessionEntry");
      const record = {
        app,
        workspace: { workspacePath: process.cwd() },
        persistence: "immediate",
        traceContext: { traceId: "registry-switch" },
      } as V4SessionRecordView;
      const executor = new V4CommandExecutor({ getRecord: () => record });
      try {
        const result = executor.execute({
          type: "switchModelConfig",
          sessionId: app.sessionId,
          commandId: "registry-switch",
          baseRevision: 0,
          payload: { provider: "provider-b", model: "model-b", thought },
        } as CommandEnvelope);
        if (thought === "invalid") {
          await expect(result).rejects.toThrow("not supported");
          expect(app.runtime.getSessionModelSelection()).toEqual(previous);
          expect(selected).not.toHaveBeenCalled();
          expect(persisted).not.toHaveBeenCalled();
        } else {
          await result;
          const expected = {
            providerId: "provider-b",
            modelId: "model-b",
            options: { reasoningLevel: "high" },
          };
          expect(app.runtime.getSessionModelSelection()).toEqual(expected);
          expect(persisted).toHaveBeenCalledWith(expect.objectContaining({ data: expected }));
          expect(selected).toHaveBeenCalledTimes(1);
          expect(selected).toHaveBeenCalledWith(
            expect.objectContaining({
              modelSelection: expected,
              previousModelSelection: previous,
            }),
          );
        }
      } finally {
        await app.close?.();
        sessionStore.close();
        await rm(storageDir, { recursive: true, force: true });
      }
    },
  );

  it("拒绝在没有进程 Provider Registry 时构造 App", async () => {
    await expect(
      // @ts-expect-error 回归保护：运行时仍需拒绝未迁移的 JavaScript/嵌入调用方。
      createZCodeApp({
        env: {},
        runtimeConfig: { mcp: { enabled: false }, workingDirectory: process.cwd() },
        skipUserConfig: true,
      }),
    ).rejects.toThrow("createZCodeApp requires a Provider Registry");
  });

  it("新 Session 优先 Configured Default；未配置时按正式初始规则选择最高档", async () => {
    const registry = new ProviderRegistry([provider()]);
    const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const common = {
      env: {},
      modelAdapter: fakeModelAdapter(),
      providerRegistry: registry,
      runtimeConfig: {
        mcp: { enabled: false },
        workingDirectory: process.cwd(),
      },
      sessionStore,
      skipUserConfig: true,
    } as const;

    const execution = vi.spyOn(executionAdapters, "createNodeExecutionAdapter");
    const configured = await createZCodeApp({
      ...common,
      configuredDefaultModelSelection: {
        providerId: "provider-a",
        modelId: "model-b",
        options: { reasoningLevel: "low" },
      },
    });
    expect(execution).toHaveBeenCalledWith(
      expect.objectContaining({ bashOutputTempDir: tmpdir() }),
    );
    execution.mockRestore();
    expect(configured.getModel()).toBe("provider-a/model-b");
    expect(configured.getThoughtLevel()).toBe("low");
    await configured.close?.();

    const unbound = await createZCodeApp(common);
    // Todo 88：这是全新 Session 初始化，不是历史失效选择恢复，允许正式初始推荐。
    expect(unbound.getModel()).toBe("provider-a/model-a");
    expect(unbound.runtime.getSessionModelSelection()).toMatchObject({
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "disabled" },
    });
    await unbound.close?.();
    sessionStore.close();
  });

  it("恢复 Session 时使用持久 Session Selection 覆盖 Environment 默认值", async () => {
    const registry = new ProviderRegistry([provider()]);
    const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId("provider-registry-resume");
    await sessionStore.createSession({
      id: sessionId,
      projectID: createProjectId("provider-registry-project"),
      slug: "provider-registry-resume",
      directory: process.cwd(),
      title: "Registry resume",
      version: "test",
    });
    await sessionStore.saveSessionEntry?.({
      id: `${sessionId}:runtime-model-selection`,
      sessionID: sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      time: { created: 1, updated: 1 },
      data: {
        providerId: "provider-a",
        modelId: "model-b",
        options: { reasoningLevel: "low" },
      },
    });
    const app = await createZCodeApp({
      configuredDefaultModelSelection: {
        providerId: "provider-a",
        modelId: "model-a",
      },
      env: {},
      modelAdapter: fakeModelAdapter(),
      providerRegistry: registry,
      resume: true,
      runtimeConfig: {
        mcp: { enabled: false },
        workingDirectory: process.cwd(),
      },
      sessionId,
      sessionStore,
      skipUserConfig: true,
    });

    // 恢复实例在读取 Session 当前选择前保持未绑定，不能短暂借用 Environment 默认值。
    expect(app.getModel()).toBe("");
    await app.resume();
    expect(app.getModel()).toBe("provider-a/model-b");
    expect(app.getThoughtLevel()).toBe("low");
    expect(app.runtime.getSessionModelSelection()).toEqual({
      providerId: "provider-a",
      modelId: "model-b",
      options: { reasoningLevel: "low" },
    });

    await app.close?.();

    const unavailableSessionId = createSessionId("provider-registry-unavailable-resume");
    await sessionStore.createSession({
      id: unavailableSessionId,
      projectID: createProjectId("provider-registry-project"),
      slug: "provider-registry-unavailable-resume",
      directory: process.cwd(),
      title: "Unavailable Registry resume",
      version: "test",
    });
    await sessionStore.saveSessionEntry?.({
      id: `${unavailableSessionId}:runtime-model-selection`,
      sessionID: unavailableSessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      time: { created: 1, updated: 1 },
      data: { providerId: "provider-a", modelId: "glm-5.2" },
    });
    const unavailable = await createZCodeApp({
      configuredDefaultModelSelection: {
        providerId: "provider-a",
        modelId: "model-a",
      },
      env: {},
      modelAdapter: fakeModelAdapter(),
      providerRegistry: registry,
      resume: true,
      runtimeConfig: {
        mcp: { enabled: false },
        workingDirectory: process.cwd(),
      },
      sessionId: unavailableSessionId,
      sessionStore,
      skipUserConfig: true,
    });
    await unavailable.resume();
    expect(unavailable.getModel()).toBe("");
    expect(unavailable.getThoughtLevel()).toBeUndefined();
    expect(unavailable.listThoughtLevels()).toEqual([]);
    await unavailable.close?.();
    sessionStore.close();
  });

  it("本地 Provider Runtime 直接使用进程 Provider Registry", async () => {
    const registry = new ProviderRegistry([provider()]);
    const source = {
      getView: () => registry.getView(),
      getProvider: (providerId: string) => registry.getProvider(providerId),
      getModel: (providerId: string, modelId: string) => registry.getModel(providerId, modelId),
      validateSelection: (selection: Parameters<typeof registry.validateSelection>[0]) =>
        registry.validateSelection(selection),
      onDidChange(listener: () => void) {
        return registry.onDidChange(listener);
      },
    };
    const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createZCodeApp({
      env: {},
      modelAdapter: {
        addStatusSink() {},
        createModel: () => fakeModel(),
        setModelIoFullRetentionEnabled() {},
      } as never,
      providerRegistry: source,
      runtimeConfig: {
        mcp: { enabled: false },
        workingDirectory: process.cwd(),
        modelSelection: {
          providerId: "provider-a",
          modelId: "model-a",
          options: { reasoningLevel: "disabled" },
        },
      },
      sessionStore,
      skipUserConfig: true,
    });

    expect(app.listModels().map((model) => model.ref)).toEqual([
      { providerId: "provider-a", modelId: "model-a" },
      { providerId: "provider-a", modelId: "model-b" },
    ]);

    // Registry 路径只持久化 Session Selection；没有旧 CLI model 配置文件也能切换。
    const switched = await app.setModel("provider-a/model-b");
    expect(switched).toMatchObject({
      model: "provider-a/model-b",
      previousModel: "provider-a/model-a",
    });
    expect(app.getModel()).toBe("provider-a/model-b");
    expect(app.getThoughtLevel()).toBeUndefined();
    expect(app.listThoughtLevels()).toEqual(["low", "high"]);

    // Registry 一旦拥有整个 Provider，同 Provider 下的旧 Runtime Model 不能再通过
    // 直接 setModel 请求绕过 Registry，形成逐模型的新旧事实拼接。
    await expect(app.setModel("provider-a/legacy-shadow-model")).rejects.toThrow(
      "Provider Registry 中不存在 Model: provider-a/legacy-shadow-model",
    );
    expect(app.getModel()).toBe("provider-a/model-b");

    const thought = await app.setThoughtLevel("low");
    expect(thought).toMatchObject({
      previousThoughtLevel: undefined,
      thoughtLevel: "low",
    });
    expect(app.getThoughtLevel()).toBe("low");

    await app.close?.();
    sessionStore.close();
  });

  it("连接测试会在正式 ModelFactory 前补齐最低推理档位", async () => {
    const registry = new ProviderRegistry([provider()]);
    const createdReasoningLevels: string[] = [];
    const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createZCodeApp({
      configuredDefaultModelSelection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "disabled" },
      },
      env: {},
      modelAdapter: fakeModelAdapter((input: unknown) => {
        const options = input as { options?: { reasoningLevel?: string } };
        createdReasoningLevels.push(options.options?.reasoningLevel ?? "missing");
        return connectivityModel();
      }),
      providerRegistry: registry,
      runtimeConfig: {
        mcp: { enabled: false },
        workingDirectory: process.cwd(),
        modelSelection: {
          providerId: "provider-a",
          modelId: "model-a",
          options: { reasoningLevel: "disabled" },
        },
      },
      sessionStore,
      skipUserConfig: true,
    });

    await expect(
      app.testModelConnectivity({
        selection: { providerId: "provider-a", modelId: "model-b" },
      }),
    ).resolves.toBeUndefined();
    expect(createdReasoningLevels).toContain("low");

    await app.close?.();
    sessionStore.close();
  });

  it("Expert Workflow 子 Runtime 继续使用进程 Registry 的 ModelFactory", async () => {
    const registry = new ProviderRegistry([provider()]);
    const createdModels: string[] = [];
    const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createZCodeApp({
      env: {},
      modelAdapter: fakeModelAdapter(() => {
        createdModels.push("provider-a/model-a");
        return workflowModel();
      }),
      providerRegistry: registry,
      runtimeConfig: {
        mcp: { enabled: false },
        workingDirectory: process.cwd(),
        modelSelection: {
          providerId: "provider-a",
          modelId: "model-a",
          options: { reasoningLevel: "disabled" },
        },
      },
      sessionStore,
      skipUserConfig: true,
    });

    const result = await app.runExpertWorkflow({
      task: "verify registry model factory inheritance",
    });

    expect(createdModels.length).toBeGreaterThan(0);
    expect(["completed", "paused"]).toContain(result.status);

    await app.close?.();
    sessionStore.close();
  });

  it("Registry 模式的 Workflow 子 Runtime 复用主 App Adapter", async () => {
    const registry = new ProviderRegistry([provider()]);
    const adapter = fakeModelAdapter(() => workflowModel());
    createModelAdapterMock.mockReturnValue(adapter);
    const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createZCodeApp({
      env: {},
      providerRegistry: registry,
      runtimeConfig: {
        mcp: { enabled: false },
        workingDirectory: process.cwd(),
        modelSelection: {
          providerId: "provider-a",
          modelId: "model-a",
          options: { reasoningLevel: "disabled" },
        },
      },
      sessionStore,
      skipUserConfig: true,
    });

    const result = await app.runExpertWorkflow({
      task: "verify child runtime adapter ownership",
    });

    expect(["completed", "paused"]).toContain(result.status);
    expect(createModelAdapterMock).toHaveBeenCalledTimes(1);

    await app.close?.();
    sessionStore.close();
    createModelAdapterMock.mockReset();
  });
});

function provider() {
  return {
    providerId: "provider-a",
    config: createApiKeyProviderConfig({
      apiFormat: "anthropic-messages",
      apiKey: "registry-key",
      baseURL: "https://registry.example.com",
      models: ["model-a"],
    }),
    models: [registryModel("model-a"), registryModel("model-b", true)],
  };
}

function registryModel(modelId: string, reasoning = false) {
  return {
    modelId,
    config: new ModelConfig({
      properties: new ModelPropertiesConfig({
        requiresMfjsToolSchema: false,
        contextWindow: modelId === "model-b" ? 128_000 : 200_000,
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
        supportsMidConversationSystem: false,
      }),
      optionSpecs: new ModelOptionSpecsConfig({
        reasoningLevel: reasoning
          ? {
              values: ["low", "high"],
              map: '{"reasoning_effort":reasoningLevel}',
            }
          : {
              values: ["disabled"],
              map: "{}",
            },
        maxOutputTokens: {
          max: 32_000,
          map: '{"max_completion_tokens":maxOutputTokens}',
        },
      }),
    }),
  };
}

function fakeModel(): Model {
  return {
    providerId: "provider-a" as Model["providerId"],
    modelId: "model-a" as Model["modelId"],
    properties: {
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
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: {
        values: ["disabled"],
        map: "{}",
      },
      maxOutputTokens: {
        max: 32_000,
        map: '{"max_completion_tokens":maxOutputTokens}',
      },
    },
    options: { maxOutputTokens: 8_000, reasoningLevel: "disabled" },
    bind() {
      return this;
    },
    async generateText() {
      throw new Error("not used");
    },
    streamText() {
      throw new Error("not used");
    },
  };
}

function fakeModelAdapter(createModel: (input?: unknown) => Model = fakeModel) {
  return {
    addStatusSink() {},
    createModel,
    setModelIoFullRetentionEnabled() {},
  } as never;
}

function connectivityModel(): Model {
  return {
    ...fakeModel(),
    modelId: "model-b" as Model["modelId"],
    optionSpecs: {
      ...fakeModel().optionSpecs,
      reasoningLevel: {
        values: ["low", "high"],
        map: "{}",
      },
    },
    async *streamText() {
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

function workflowModel(): Model {
  return {
    ...fakeModel(),
    async generateText() {
      return {
        finishReason: "stop",
        text: JSON.stringify({ reasoning: "ok", verdict: "pass" }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };
}
