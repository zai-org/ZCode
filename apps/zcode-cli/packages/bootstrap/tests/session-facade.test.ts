import { describe, expect, it, vi } from "vitest";
import {
  DefaultRuntimeConfig,
  createProjectId,
  createSessionId,
  type ModelSelection,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import { createSessionFacade } from "../src/app/session-facade.js";

import { deferred } from "./session-facade-fixture.js";

describe("session facade shutdown", () => {
  it("keeps group mode changes in the session rather than the project", async () => {
    const saveProjectPermissionMode = vi.fn();
    const updateSession = vi.fn(async () => undefined);
    const setExecutionState = vi.fn();
    const facade = createSessionFacade({
      configResult: { config: DefaultRuntimeConfig },
      sessionId: "group-session",
      traceContext: { traceId: "group-mode" },
      runtime: { getMode: () => "build", setExecutionState },
      logger: { info: vi.fn(), warn: vi.fn() },
      localSettingStore: { saveProjectPermissionMode },
      sessionStore: {
        getSession: async () => ({ permission: { version: 1, scope: "session", mode: "build" } }),
        updateSession,
      },
    } as never);
    await facade.setMode("yolo");
    expect(saveProjectPermissionMode).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledWith({
      id: "group-session",
      permission: { version: 1, scope: "session", mode: "yolo" },
    });
    expect(setExecutionState).toHaveBeenCalledWith({ mode: "yolo" }, { traceId: "group-mode" });
  });

  // 关闭次序（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Engine ownership」规则二）：dwf 的关闭夹在
  // beginShutdown 与资源关闭之间——前者让结算带出的终态通知被丢掉，后者让子代理还有
  // execution / MCP / store 可用、引擎还有 journal 可写自己那一笔。
  it("closes all work owners before releasing shared resources", async () => {
    const drainGate = deferred<void>();
    const calls: string[] = [];
    const closeOwnedWork = vi.fn(async () => {
      calls.push("drain:start");
      await drainGate.promise;
      calls.push("drain");
    });
    const facade = createSessionFacade({
      closeDynamicWorkflowRuns: async () => {
        calls.push("dwf");
      },
      closeScriptWorkflowRuns: async () => {
        calls.push("script");
      },
      configResult: {
        config: DefaultRuntimeConfig,
        configPort: {} as never,
        sources: {} as never,
      },
      configuredMcpServers: {},
      executionPort: {
        async close() {
          calls.push("execution");
        },
      } as never,
      logger: {} as never,
      loggerFactory: {} as never,
      mcpPort: {
        async close() {
          calls.push("mcp");
        },
      } as never,
      modelAdapter: {} as never,
      modelConfig: undefined,
      ownsExecutionPort: true,
      ownsMcpPort: true,
      ownsSessionStore: true,
      prepareResume: async () => {},
      prepareUserExecutionBoundary: async () => {},
      projectID: createProjectId("session-facade-memory-drain"),
      resolveUiLocale: () => "en-US",
      runtime: {
        beginShutdown: vi.fn(() => {
          calls.push("shutdown");
        }),
        closeBrowserSession: async () => {
          calls.push("browser");
        },
        closeOwnedWork,
        getModelRef: () => ({ providerId: "builtin:zai", modelId: "GLM-5" }),
      } as unknown as AgentRuntime,
      sessionId: createSessionId("session-facade-memory-drain"),
      sessionStore: {
        close() {
          calls.push("store");
        },
      } as never,
      traceContext: {} as never,
      untrustedProjectMcpServers: new Set(),
      workingDirectory: "/workspace",
    });

    const closing = facade.close?.();
    await nextTask();
    expect(calls).toEqual(["shutdown", "drain:start", "dwf", "script"]);

    drainGate.resolve();
    await closing;

    expect(closeOwnedWork).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      "shutdown",
      "drain:start",
      "dwf",
      "script",
      "drain",
      "shutdown",
      "browser",
      "execution",
      "mcp",
      "store",
    ]);
  });

  // 卡住或抛错的 dwf 关闭不能吃掉资源关闭：最坏情况是留一行孤儿 run，下次构造时被收敛，
  // 而资源没关会漏子进程、MCP 连接与 sqlite 句柄。
  it("still closes owned resources when closing dynamic workflow runs throws", async () => {
    const calls: string[] = [];
    const warn = vi.fn();
    const facade = createSessionFacade({
      closeDynamicWorkflowRuns: async () => {
        calls.push("dwf");
        throw new Error("engine refused to stop");
      },
      configResult: {
        config: DefaultRuntimeConfig,
        configPort: {} as never,
        sources: {} as never,
      },
      configuredMcpServers: {},
      executionPort: {
        async close() {
          calls.push("execution");
        },
      } as never,
      logger: { warn } as never,
      loggerFactory: {} as never,
      mcpPort: {
        async close() {
          calls.push("mcp");
        },
      } as never,
      modelAdapter: {} as never,
      modelConfig: undefined,
      ownsExecutionPort: true,
      ownsMcpPort: true,
      ownsSessionStore: true,
      prepareResume: async () => {},
      prepareUserExecutionBoundary: async () => {},
      projectID: createProjectId("session-facade-dwf-close-throws"),
      resolveUiLocale: () => "en-US",
      runtime: {
        beginShutdown: () => {
          calls.push("shutdown");
        },
        closeBrowserSession: async () => {
          calls.push("browser");
        },
        closeOwnedWork: async () => {
          calls.push("drain");
        },
      } as unknown as AgentRuntime,
      sessionId: createSessionId("session-facade-dwf-close-throws"),
      sessionStore: {
        close() {
          calls.push("store");
        },
      } as never,
      traceContext: {} as never,
      untrustedProjectMcpServers: new Set(),
      workingDirectory: "/workspace",
    });

    await expect(facade.close?.()).rejects.toBeInstanceOf(AggregateError);

    expect(calls).toEqual([
      "shutdown",
      "drain",
      "dwf",
      "shutdown",
      "browser",
      "execution",
      "mcp",
      "store",
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("session facade model selection", () => {
  it("reads and updates the session selection without projecting a runtime ModelSelection", async () => {
    let modelSelection: ModelSelection = {
      providerId: "temporary-provider",
      modelId: "temporary-model",
      options: { reasoningLevel: "high" },
    };
    // Facade 的补全与查询必须观察同一 View；旧 fake 只有 lookup，遗漏了正式 getView 契约。
    const provider = {
      providerId: "temporary-provider",
      config: { label: "Temporary", enabled: true },
      models: [
        {
          modelId: "temporary-model",
          config: {
            optionSpecs: {
              reasoningLevel: { values: ["low", "high"] },
            },
          },
        },
      ],
    };
    const saveSessionEntry = vi.fn(async () => {});
    const markContextCompositionChanged = vi.fn();
    const validateSelection = vi.fn((selection: ModelSelection) =>
      selection.options?.reasoningLevel === "invalid"
        ? {
            ok: false,
            code: "reasoning-level-not-supported",
            ...selection,
            reasoningLevel: "invalid",
          }
        : { ok: true },
    );
    const facade = createSessionFacade({
      configResult: {
        config: DefaultRuntimeConfig,
        configPort: {} as never,
        sources: {} as never,
      },
      configuredMcpServers: {},
      executionPort: {} as never,
      logger: { info: vi.fn(), warn: vi.fn() } as never,
      loggerFactory: {} as never,
      localSettingStore: {
        getProjectPermissionMode: () => null,
        saveProjectPermissionMode: vi.fn(),
      },
      ownsExecutionPort: false,
      ownsMcpPort: false,
      ownsSessionStore: false,
      prepareResume: async () => {},
      prepareUserExecutionBoundary: async () => {},
      projectID: createProjectId("session-facade-selection"),
      providerRegistry: {
        getProvider: () => provider,
        getModel: () => provider.models[0],
        getView: () => ({ providers: [provider] }),
        validateSelection,
      } as never,
      resolveUiLocale: () => "en-US",
      runtime: {
        getSessionModelSelection: () => modelSelection,
        setSessionModelSelection: (selection: typeof modelSelection) => {
          modelSelection = selection;
        },
        markContextCompositionChanged,
        updateConfig: vi.fn(),
        recordPendingModelChange: vi.fn(),
      } as unknown as AgentRuntime,
      sessionId: createSessionId("session-facade-selection"),
      sessionStore: { saveSessionEntry } as never,
      traceContext: { traceId: "trace-selection" } as never,
      untrustedProjectMcpServers: new Set(),
      workingDirectory: "/workspace",
    });

    expect(facade.getModel()).toBe("temporary-provider/temporary-model");
    expect(facade.getDefaultThoughtLevel()).toBeUndefined();
    expect(facade.getThoughtLevel()).toBe("high");
    expect(facade.listThoughtLevels()).toEqual(["low", "high"]);
    await expect(
      facade.setModel("temporary-provider/temporary-model", { transient: true }),
    ).resolves.not.toHaveProperty("thoughtLevel");
    // 跨模型切换只更新模型身份；Reasoning 没有默认值，必须由用户另行选择。
    expect(modelSelection).toEqual({
      providerId: "temporary-provider",
      modelId: "temporary-model",
    });
    await expect(facade.setThoughtLevel("low")).resolves.toMatchObject({
      previousThoughtLevel: undefined,
      thoughtLevel: "low",
    });
    expect(modelSelection.options?.reasoningLevel).toBe("low");

    // Bot /model 的结构化命令必须完整应用，不能先转成字符串而丢掉档位。
    saveSessionEntry.mockClear();
    const submitted: ModelSelection = {
      providerId: "temporary-provider",
      modelId: "temporary-model",
      options: { reasoningLevel: "high" },
    };
    await facade.setModel(submitted);
    expect(validateSelection).toHaveBeenLastCalledWith(submitted);
    expect(modelSelection).toEqual(submitted);
    expect(saveSessionEntry).toHaveBeenCalledTimes(1);
    expect(saveSessionEntry).toHaveBeenLastCalledWith(expect.objectContaining({ data: submitted }));
    submitted.options!.reasoningLevel = "low";
    expect(modelSelection.options?.reasoningLevel).toBe("high");

    saveSessionEntry.mockClear();
    await expect(
      facade.setModel({ ...submitted, options: { reasoningLevel: "invalid" } }),
    ).rejects.toThrow("not supported");
    expect(modelSelection.options?.reasoningLevel).toBe("high");
    expect(saveSessionEntry).not.toHaveBeenCalled();
    // 每次成功换模型都让 context 组成作废并通知；校验失败的那次不算（context-composition.md §3.4）。
    expect(markContextCompositionChanged).toHaveBeenCalledTimes(2);
  });

  // ZCT-2109847556412547072：App 在 deferred 会话首条消息前设置档位，entry 写入因 session 行未创建
  // 而报 FOREIGN KEY；首次持久化会以当时选择补写，因此该时序只记 debug，已持久化会话仍须 warn。
  it.each([
    [false, "debug", "session.model_selection.persist_deferred"],
    [true, "warn", "session.model_selection.persist_failed"],
  ] as const)("sessionPersisted=%s 时选型写入失败记 %s", async (persisted, level, event) => {
    let modelSelection: ModelSelection = {
      providerId: "temporary-provider",
      modelId: "temporary-model",
      options: { reasoningLevel: "high" },
    };
    const provider = {
      providerId: "temporary-provider",
      config: { label: "Temporary", enabled: true },
      models: [
        {
          modelId: "temporary-model",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
        },
      ],
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const saveSessionEntry = vi.fn(async () => {
      throw new Error("FOREIGN KEY constraint failed");
    });
    const facade = createSessionFacade({
      configResult: { config: DefaultRuntimeConfig, configPort: {} as never, sources: {} as never },
      configuredMcpServers: {},
      executionPort: {} as never,
      logger: logger as never,
      loggerFactory: {} as never,
      localSettingStore: {
        getProjectPermissionMode: () => null,
        saveProjectPermissionMode: vi.fn(),
      },
      ownsExecutionPort: false,
      ownsMcpPort: false,
      ownsSessionStore: false,
      prepareResume: async () => {},
      prepareUserExecutionBoundary: async () => {},
      projectID: createProjectId("session-facade-deferred-selection"),
      providerRegistry: {
        getProvider: () => provider,
        getModel: () => provider.models[0],
        getView: () => ({ providers: [provider] }),
        validateSelection: () => ({ ok: true }),
      } as never,
      resolveUiLocale: () => "en-US",
      runtime: {
        getSessionModelSelection: () => modelSelection,
        setSessionModelSelection: (selection: ModelSelection) => {
          modelSelection = selection;
        },
        isSessionPersisted: () => persisted,
        markContextCompositionChanged: vi.fn(),
        updateConfig: vi.fn(),
        recordPendingModelChange: vi.fn(),
      } as unknown as AgentRuntime,
      sessionId: createSessionId("session-facade-deferred-selection"),
      sessionStore: { saveSessionEntry } as never,
      traceContext: { traceId: "trace-deferred-selection" } as never,
      untrustedProjectMcpServers: new Set(),
      workingDirectory: "/workspace",
    });

    // 选型仍在当前 runtime 生效，失败不反向伪装成切换失败。
    await expect(facade.setThoughtLevel("low")).resolves.toMatchObject({ thoughtLevel: "low" });
    expect(modelSelection.options?.reasoningLevel).toBe("low");
    expect(saveSessionEntry).toHaveBeenCalledTimes(1);
    const other = level === "debug" ? logger.warn : logger.debug;
    expect(logger[level]).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event, error: "FOREIGN KEY constraint failed" }),
    );
    expect(other).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: expect.stringMatching(/^session\.model_selection\./) }),
    );
  });
});

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
