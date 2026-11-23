import * as executionAdapters from "@zcode/adapters/exec";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import { type AgentRuntime, PermissionService, defaultPermissionConfig } from "@zcode/core";
import { createModelTelemetry } from "@zcode/telemetry";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTraceId,
  CREATE_WORKFLOW_TOOL_NAME,
  ESCALATE_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  type McpConnectionSnapshot,
  type McpServerToolSnapshot,
  type Model,
  type ModelResult,
  type ModelSelection,
  type PermissionBrokerRequest,
  SessionEventType,
  SUBMIT_RESULT_TOOL_NAME,
  type SessionEvent,
  type SessionEventStorePort,
  type SessionStorePort,
  type SkillRoot,
  type WorkflowEscalatePort,
  type WorkflowSubmitPort,
} from "@zcode/contracts";
import {
  createScriptWorkflowAgentRuntime,
  createWorkflowChildSkillPort,
  type ScriptWorkflowAgentRuntimeDeps,
} from "../src/app/script-workflow-child-runtime.js";
import { createProtocolBrowserControlBroker } from "../src/zcode-protocol/browser-control-broker.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import {
  parseWorkflowSubagentPermissionMode,
  workflowActorInteractionDescription,
  workflowActorPermissionPolicy,
  type WorkflowSubagentPermissionMode,
} from "../src/app/workflow-actor-permission.js";
import { workflowActorToolPolicy } from "../src/app/workflow-actor-tools.js";
import {
  createTestAgentRuntime,
  createTestModelFactory,
  createTestModelFactoryFromAdapter,
} from "./helpers/test-agent-runtime.js";

/**
 * actor transcript 的直播通道（照 subagent 同款）。三件事被钉住：
 * 共享 event store、构造期 sink 从 seq 1 起看全、事件在共享 store 里恰好一份。
 */
describe("script workflow child runtime — actor transcript 直播通道", () => {
  const parentSessionId = createSessionId("dwf-parent");
  const actorSessionId = createSessionId("dwf-actor-a-1");

  let tempRoot: string;
  let parentStore: SessionEventStorePort;
  let sessionStore: SessionStorePort;
  let parentRuntime: AgentRuntime;
  let forwarded: SessionEvent[];

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-actor-transcript-"));
    parentStore = createInMemorySessionEventStore();
    sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    forwarded = [];
    parentRuntime = createTestAgentRuntime(
      parentSessionId,
      { workingDirectory: tempRoot },
      {
        eventStore: parentStore,
        fileSystemPort: createNodeFileSystemAdapter(),
        modelFactory: scriptedModelFactory,
      },
    );
    // 协议服务器听的就是父 record 自己的 runtime 订阅（server-operations.ts 的
    // `record.unsubscribe = app.runtime.subscribeEvents(...)`），detached 的子 sessionId
    // 在那里被路由成 live topic。测试因此断在同一个面上，而不是任何注入的旁路。
    parentRuntime.subscribeEvents({
      onSessionEvent: (event) => {
        forwarded.push(event);
      },
    });
  });

  afterEach(async () => {
    await rm(tempRoot, { force: true, recursive: true });
  });

  // 父会话的 model factory：生产里 child 与主 turn 共用 create-app 造的那一份（见
  // script-workflow-child-runtime.ts 的 deps.modelFactory）。
  const scriptedModelFactory = createTestModelFactoryFromAdapter({
    async generateText() {
      return {
        finishReason: "stop",
        providerMetadata: undefined,
        text: "actor done",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      } as unknown as ModelResult;
    },
  });

  function makeDeps(): ScriptWorkflowAgentRuntimeDeps {
    return {
      agentTelemetry: createModelTelemetry().agentExecution,
      appOptions: { env: process.env },
      appVersion: "0.0.0-test",
      configResult: {
        config: {
          features: { skill: false },
          modelStream: { idleTimeoutMs: 0 },
          network: {},
          skillOverrides: {},
          skills: { enabled: false, roots: [] },
        },
      },
      fileSystemPort: createNodeFileSystemAdapter(),
      imageProcessorPort: {},
      logger: undefined,
      modelFactory: scriptedModelFactory,
      permissionService: new PermissionService(defaultPermissionConfig),
      runtime: parentRuntime,
      runtimeConfig: { workingDirectory: tempRoot },
      sessionId: parentSessionId,
      sessionStore,
      storageRoot: tempRoot,
      workingDirectory: tempRoot,
    } as unknown as ScriptWorkflowAgentRuntimeDeps;
  }

  async function makeActorRuntime(): Promise<AgentRuntime> {
    return createScriptWorkflowAgentRuntime({
      childSessionId: actorSessionId,
      deps: makeDeps(),
      request: { opts: {} } as never,
      traceContext: createRootTraceContext({ sessionId: parentSessionId }),
    });
  }

  it("borrows the parent's current MCP directory without reconciling or closing its connections", async () => {
    const startup = Promise.withResolvers<McpConnectionSnapshot>();
    const connect = vi.fn(() => startup.promise);
    const close = vi.fn(async () => {});
    const live: Record<string, McpServerToolSnapshot> = {
      current: {
        status: { status: "connected", transport: "stdio", toolCount: 1, updatedAt: "now" },
        toolsVersion: "1",
        tools: [{ serverName: "current", toolName: "ping", inputSchema: { type: "object" } }],
      },
    };
    const port = {
      connectConfiguredServers: connect,
      close,
      getToolSnapshot: () => live,
      connectServer: vi.fn(),
      disconnectServer: vi.fn(),
      status: async () => ({}),
      listTools: async () => [],
      callTool: vi.fn(),
    };
    parentRuntime = createTestAgentRuntime(
      parentSessionId,
      {
        workingDirectory: tempRoot,
        mcp: { enabled: true, servers: { current: { type: "stdio", command: "current" } } },
      },
      { eventStore: parentStore, modelFactory: scriptedModelFactory, mcpPort: port },
    );
    const deps = makeDeps();
    deps.runtimeConfig.mcp = {
      enabled: true,
      servers: { stale: { type: "stdio", command: "old" } },
    };
    // 父启动始终未完成：不带 scope 的 child 不等待整个启动，直接借用当前已连接的目录。
    const actor = await createScriptWorkflowAgentRuntime({
      childSessionId: actorSessionId,
      deps,
      request: { opts: {} } as never,
      traceContext: createRootTraceContext({ sessionId: parentSessionId }),
    });
    try {
      await actor.executeTurn("go");
      expect(connect).toHaveBeenCalledTimes(1);
      expect(actor.getToolRegistry().has("mcp__current__ping")).toBe(true);
      expect(actor.getToolRegistry().has("mcp__stale__ping")).toBe(false);
    } finally {
      actor.beginShutdown();
      parentRuntime.beginShutdown();
      startup.resolve({ statuses: {}, tools: [] });
    }
    expect(close).not.toHaveBeenCalled();
  });

  it("actor runtime 与父 runtime 共享 event store", async () => {
    const execution = vi.spyOn(executionAdapters, "createNodeExecutionAdapter");
    const actorRuntime = await makeActorRuntime();
    expect(execution).toHaveBeenCalledWith(
      expect.objectContaining({
        bashOutputTempDir: tmpdir(),
        outputRootDir: join(tempRoot, "cli", "exec"),
      }),
    );
    execution.mockRestore();
    expect(actorRuntime.getSessionEventStore()).toBe(parentStore);

    await actorRuntime.ensureSessionPersistedForExternalActivity("workflow actor a#1@1");
    await actorRuntime.executeTurn("go");

    // v4 的 loadPersistedEvents 读的就是 record.eventStore，按 actorSessionId 取；
    // 私建内存 store 时这里恒为空，transcript 永久空白。
    const stored = await parentStore.getEvents(actorSessionId);
    expect(stored.length).toBeGreaterThan(1);
    // 会话行也落在共享的 sessionStore 上（v4 冷 hydration 的前提）。
    expect(await sessionStore.getSession(actorSessionId)).toBeDefined();
  });

  it("转发流从 sequenceNumber 1（SessionTitleUpdated）起，保留 actor 的 sessionId", async () => {
    const actorRuntime = await makeActorRuntime();

    await actorRuntime.ensureSessionPersistedForExternalActivity("workflow actor a#1@1");
    await actorRuntime.executeTurn("go");

    expect(forwarded.length).toBeGreaterThan(1);
    // sink 装在构造期，所以 seq 1 的 title 事件也在流里。装在 persist 之后的旧订阅只能从
    // seq 2 起，而 v4 网关只排水连续 seq——它会永远等一个再也不会来的 seq 1。
    expect(forwarded[0]!.type).toBe(SessionEventType.SessionTitleUpdated);
    expect(forwarded[0]!.sequenceNumber).toBe(1);
    expect(forwarded.every((event) => event.sessionId === actorSessionId)).toBe(true);
    expect(forwarded.map((event) => event.sequenceNumber)).toEqual(
      forwarded.map((_event, index) => index + 1),
    );
  });

  it("恰好一次：每条 actor 事件在共享 store 里只有一份，父会话不被污染", async () => {
    const actorRuntime = await makeActorRuntime();

    await actorRuntime.ensureSessionPersistedForExternalActivity("workflow actor a#1@1");
    await actorRuntime.executeTurn("go");

    const stored = await parentStore.getEvents(actorSessionId);
    expect(stored.length).toBeGreaterThan(1);
    const idCounts = new Map<string, number>();
    for (const event of stored) idCounts.set(event.id, (idCounts.get(event.id) ?? 0) + 1);
    expect([...idCounts.values()].filter((count) => count !== 1)).toEqual([]);

    // 转发是「只通知不 append」：转发条数与落库条数一致，没有第二次写入。
    expect(forwarded.map((event) => event.id)).toEqual(stored.map((event) => event.id));
    // 父会话自己一条事件都没有：actor 正文不许落到父 timeline 上。
    expect(await parentStore.getEvents(parentSessionId)).toEqual([]);
  });

  /**
   * actor 会话的两个控制端口 → 两个控制工具（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）。
   *
   * 这条线是 escalate 的**整条命脉**：端口从 run service 经 create-app 的 createActorRuntime
   * 流到这里，core 再以「端口在场」为门注册工具。断在注册表上而不是断在参数透传上，是因为
   * 中间任何一环漏掉（没接、名字写错、门判据写反），透传断言都还会绿，而 actor 的求助通道
   * 已经没了——它撞上坏门时只剩死磕或投机绕过。
   */
  describe("script workflow child runtime — actor 的控制工具面", () => {
    const submitPort: WorkflowSubmitPort = { respond: async () => ({ accept: true }) };
    const escalatePort: WorkflowEscalatePort = {
      escalate: async () => ({ kind: "answered", answer: "ok", qid: "dwfq-x-1" }),
    };

    function actorRuntimeWith(ports: {
      workflowSubmitPort?: WorkflowSubmitPort;
      workflowEscalatePort?: WorkflowEscalatePort;
    }): Promise<AgentRuntime> {
      return createScriptWorkflowAgentRuntime({
        childSessionId: createSessionId("dwf-actor-tools"),
        deps: makeDeps(),
        request: { opts: {} } as never,
        traceContext: createRootTraceContext({ sessionId: parentSessionId }),
        ...ports,
      });
    }

    it("注入 escalatePort 即为该会话注册 escalate", async () => {
      const registry = (
        await actorRuntimeWith({
          workflowSubmitPort: submitPort,
          workflowEscalatePort: escalatePort,
        })
      ).getToolRegistry();
      expect(registry.has(ESCALATE_TOOL_NAME)).toBe(true);
      expect(registry.has(SUBMIT_RESULT_TOOL_NAME)).toBe(true);
    });

    it("两个端口各自独立成门：只给 submitPort 时 escalate 不注册", async () => {
      const registry = (
        await actorRuntimeWith({ workflowSubmitPort: submitPort })
      ).getToolRegistry();
      expect(registry.has(SUBMIT_RESULT_TOOL_NAME)).toBe(true);
      expect(registry.has(ESCALATE_TOOL_NAME)).toBe(false);
    });

    it("两个端口都缺席时两个工具都不注册（非 actor 会话的形状）", async () => {
      const registry = (await actorRuntimeWith({})).getToolRegistry();
      expect(registry.has(SUBMIT_RESULT_TOOL_NAME)).toBe(false);
      expect(registry.has(ESCALATE_TOOL_NAME)).toBe(false);
    });
  });

  // persona 经 configOverrides.workflowActor 叠加到基座之上，systemPrompt 必须缺席——哪怕父
  // 会话自带 custom system prompt（docs/dynamic-workflow/authoring.md「The system prompt」）。
  describe("script workflow child runtime — persona 走 workflowActor 而非 systemPrompt", () => {
    function configOf(runtime: AgentRuntime): Record<string, unknown> {
      return (runtime as unknown as { config: Record<string, unknown> }).config;
    }

    it("workflowActor 落到 child config，systemPrompt 不被父会话的 custom prompt 污染", async () => {
      const deps = makeDeps();
      const runtime = await createScriptWorkflowAgentRuntime({
        childSessionId: createSessionId("dwf-actor-persona"),
        configOverrides: { workflowActor: { name: "reviewer", persona: "You review." } },
        deps: {
          ...deps,
          runtimeConfig: { ...deps.runtimeConfig, systemPrompt: "parent custom prompt" },
        },
        request: { opts: {} } as never,
        traceContext: createRootTraceContext({ sessionId: parentSessionId }),
      });
      const config = configOf(runtime);
      expect(config.workflowActor).toEqual({ name: "reviewer", persona: "You review." });
      expect(config.systemPrompt).toBeUndefined();
    });

    it("没有 workflowActor 时 systemPrompt 照旧回落到父会话配置", async () => {
      const deps = makeDeps();
      const runtime = await createScriptWorkflowAgentRuntime({
        childSessionId: createSessionId("dwf-actor-legacy"),
        deps: {
          ...deps,
          runtimeConfig: { ...deps.runtimeConfig, systemPrompt: "parent custom prompt" },
        },
        request: { opts: {} } as never,
        traceContext: createRootTraceContext({ sessionId: parentSessionId }),
      });
      expect(configOf(runtime).systemPrompt).toBe("parent custom prompt");
    });
  });

  /**
   * 动态工作流灰度门在 workflow child 上的形态（docs/dynamic-workflow/launch.md「Gray release」）：
   * 这里**没有**第二份判定，child config 由 `...deps.runtimeConfig` 整体继承父会话的结论。
   * 钉住它是因为构造点用的是展开而不是逐字段枚举——将来有人改成枚举（subagent.ts 就是枚举，
   * 并因此漏过这个字段）时，这条用例会红。
   *
   * 三种取值都要断：父会话开着（run 只可能在开着的会话里启动）child 必须拿到全部工具；
   * 父会话不参与灰度（TUI / headless）同理；父会话关着时 child 也关着，这在生产中不可达
   * （关着就没有 CreateWorkflow，起不了 run），断它只是为了证明继承没有方向性错误。
   */
  describe("script workflow child runtime — 灰度门整体继承父会话", () => {
    function childRuntimeForParent(parentFlag: boolean | undefined): Promise<AgentRuntime> {
      const deps = makeDeps();
      return createScriptWorkflowAgentRuntime({
        childSessionId: createSessionId(`dwf-actor-gray-${String(parentFlag)}`),
        deps: {
          ...deps,
          runtimeConfig: {
            ...deps.runtimeConfig,
            ...(parentFlag === undefined ? {} : { dynamicWorkflowEnabled: parentFlag }),
          },
        },
        request: { opts: {} } as never,
        traceContext: createRootTraceContext({ sessionId: parentSessionId }),
      });
    }

    it.each([
      { parentFlag: true, available: true },
      { parentFlag: undefined, available: true },
      { parentFlag: false, available: false },
    ])("父会话 dynamicWorkflowEnabled=%j", async ({ parentFlag, available }) => {
      const runtime = await childRuntimeForParent(parentFlag);
      expect(
        (runtime as unknown as { config: { dynamicWorkflowEnabled?: boolean } }).config
          .dynamicWorkflowEnabled,
      ).toBe(parentFlag);
      const registry = runtime.getToolRegistry();
      // 探针刻意用两个**只读**工具：CreateWorkflow / AmendWorkflow / SaveWorkflow /
      // ResumeWorkflowRun / ResolveWorkflowQuestion 在 workflow_child 里另有一道结构性禁令
      // （tool-allowlist.ts 的 WORKFLOW_CHILD_DISALLOWED_TOOLS），三种取值下恒为 false，
      // 拿它们当探针只会写出一条永远为真的假断言。ListWorkflowRuns / GetWorkflowRun 同理
      // （2026-10-21 起子 runtime 不持有 run 端口而不注册，见 RUN_INTROSPECTION_TOOLS），所以换成
      // 不经 run 端口的 ListSavedWorkflows。
      expect(registry.has(LIST_SAVED_WORKFLOWS_TOOL_NAME)).toBe(available);
      expect(registry.has(EVAL_WORKFLOW_SNIPPET_TOOL_NAME)).toBe(available);
      // 反向断言：门只碰工作流那几件，普通工具面在三种取值下都在。
      expect(registry.has("Read")).toBe(true);
      // 结构性禁令与灰度门互不干扰：CreateWorkflow 在 workflow_child 里恒缺席。
      expect(registry.has(CREATE_WORKFLOW_TOOL_NAME)).toBe(false);
    });
  });
});

/**
 * actor / script workflow child 的模型面必须和父会话**同源**（一份 model factory）。
 *
 * 事故复盘（2026-09-02 日志包）：自定义 provider 起初被存成 openai-compatible，主 turn 与 actor 都
 * 404；用户改成 anthropic 并推送 registry 后主 turn 恢复，但两分钟后启动的 actor 仍用旧 kind——
 * 因为 child 拿 app 创建时冻结的配置自建了一份 registry。provider 重构后 Registry 视图是进程级的、
 * Model 由 factory 按创建时刻的视图造出（docs/working-memory/provider-refactor/design/registry/runtime.md），
 * 所以这里只剩一条要钉住：child 造 Model 走的必须是 deps 里父会话那一份 factory，且以父会话
 * **当前**的选择为基线。
 */
describe("script workflow child runtime — 与父会话共享 model factory", () => {
  const parentSessionId = createSessionId("dwf-parent-model");
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-actor-model-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { force: true, recursive: true });
  });

  async function baseDeps(parentRuntime: AgentRuntime): Promise<ScriptWorkflowAgentRuntimeDeps> {
    return {
      agentTelemetry: createModelTelemetry().agentExecution,
      appOptions: { env: {} },
      appVersion: "0.0.0-test",
      configResult: {
        config: {
          features: { skill: false },
          modelStream: { idleTimeoutMs: 0 },
          network: {},
          skillOverrides: {},
          skills: { enabled: false, roots: [] },
        },
      },
      fileSystemPort: createNodeFileSystemAdapter(),
      imageProcessorPort: {},
      logger: undefined,
      permissionService: new PermissionService(defaultPermissionConfig),
      runtime: parentRuntime,
      runtimeConfig: { workingDirectory: tempRoot },
      sessionId: parentSessionId,
      sessionStore: await createSqliteSessionStore({ dbPath: ":memory:" }),
      storageRoot: tempRoot,
      workingDirectory: tempRoot,
    } as unknown as ScriptWorkflowAgentRuntimeDeps;
  }

  it("child 用 deps 里父会话的 factory 造 Model，并以父会话当前的选择为基线", async () => {
    const parentModelFactory = vi.fn(
      (target: { selection: ModelSelection }): Model => ({
        providerId: target.selection.providerId as Model["providerId"],
        modelId: target.selection.modelId as Model["modelId"],
        properties: {
          contextWindow: 200_000,
          inputFormat: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
          outputFormat: { supportsText: true },
          supportsMidConversationSystem: false,
          supportsNativeWebSearch: false,
          supportsJsonSchemaOutput: true,
          supportsToolCall: true,
        } as unknown as Model["properties"],
        optionSpecs: { maxOutputTokens: { max: 4096 } },
        options: { maxOutputTokens: 4096 },
        bind() {
          return this;
        },
        async generateText() {
          return {
            finishReason: "stop",
            providerMetadata: undefined,
            text: "actor done",
            usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          } as unknown as ModelResult;
        },
        streamText(): never {
          throw new Error("streamText is not part of this fixture");
        },
      }),
    );
    const parentRuntime = createTestAgentRuntime(
      parentSessionId,
      {
        modelSelection: { providerId: "glm", modelId: "GLM-5.3-Highspeed" },
        workingDirectory: tempRoot,
      },
      {
        eventStore: createInMemorySessionEventStore(),
        fileSystemPort: createNodeFileSystemAdapter(),
        modelFactory:
          parentModelFactory as unknown as ScriptWorkflowAgentRuntimeDeps["modelFactory"],
      },
    );
    const deps = await baseDeps(parentRuntime);
    deps.modelFactory =
      parentModelFactory as unknown as ScriptWorkflowAgentRuntimeDeps["modelFactory"];

    const actorRuntime = await createScriptWorkflowAgentRuntime({
      childSessionId: createSessionId("dwf-actor-model-wiring"),
      deps,
      request: { opts: {} } as never,
      traceContext: createRootTraceContext({ sessionId: parentSessionId }),
    });
    expect(actorRuntime.getSessionModelSelection()).toEqual({
      providerId: "glm",
      modelId: "GLM-5.3-Highspeed",
    });
    await actorRuntime.ensureSessionPersistedForExternalActivity("workflow actor a#1@1");
    await actorRuntime.executeTurn("go");

    expect(
      parentModelFactory.mock.calls.some(
        ([target]) =>
          target.selection.providerId === "glm" && target.selection.modelId === "GLM-5.3-Highspeed",
      ),
    ).toBe(true);
  });

  it("request.opts.model 必须带 provider 段：裸模型名不再借父会话的 provider 补全", async () => {
    const parentRuntime = createTestAgentRuntime(
      parentSessionId,
      {
        modelSelection: { providerId: "glm", modelId: "GLM-5.3-Highspeed" },
        workingDirectory: tempRoot,
      },
      {
        eventStore: createInMemorySessionEventStore(),
        fileSystemPort: createNodeFileSystemAdapter(),
      },
    );
    const deps = await baseDeps(parentRuntime);
    deps.modelFactory = createTestModelFactoryFromAdapter({
      async generateText() {
        throw new Error("not called");
      },
    });
    await expect(
      createScriptWorkflowAgentRuntime({
        childSessionId: createSessionId("dwf-actor-model-bare"),
        deps,
        request: { opts: { model: "GLM-5.3-Highspeed" } } as never,
        traceContext: createRootTraceContext({ sessionId: parentSessionId }),
      }),
    ).rejects.toThrow(/provider-qualified/);
  });
});

/**
 * docs/zcode-protocol-model-backed-control-requests.md「反向请求的会话路由与终止保证」契约 2。
 *
 * Bug 根因（2026-09-09）：actor 的对外交互端口过去直接取自 `appOptions` / `deps.permissionBroker`，
 * 于是带着自己的 `sess_dwf-…` 去问桌面；桌面 `requireSession` 抛错、response 永不发出，
 * 8 个子代理在首个模型请求前挂死 80 分钟（日志里只有一条 model.request.started）。
 * 现在端口只能由父 runtime 铸造，路由身份恒为父会话。
 */
describe("script workflow child runtime — 对外交互端口由父 runtime 铸造", () => {
  const parentSessionId = createSessionId("dwf-parent-routing");
  const actorSessionId = createSessionId("dwf-actor-routing-1");

  let tempRoot: string;
  let parentRuntime: AgentRuntime;
  let refreshes: Array<{ providerId: string; routedSessionId?: string }>;
  let permissionRequests: Array<{ sessionId: string; origin?: unknown }>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-actor-routing-"));
    refreshes = [];
    permissionRequests = [];
    parentRuntime = createTestAgentRuntime(parentSessionId, { workingDirectory: tempRoot }, {
      eventStore: createInMemorySessionEventStore(),
      fileSystemPort: createNodeFileSystemAdapter(),
      // 主 runtime 的端口：每次调用报自己的 sessionId；child 拿到的是父 runtime 派生的实例，
      // 派生层把 sessionId 改写成父会话（core 的 child-client-ports.ts）。
      providerRuntimeHeadersPort: {
        shouldRefreshBeforeModelRequest: () => true,
        async refreshBeforeModelRequest(input) {
          refreshes.push({ providerId: input.providerId, routedSessionId: input.sessionId });
          return { headersApplied: true };
        },
      },
      modelFactory: routingModelFactory,
      permissionBroker: {
        async requestPermission(request) {
          permissionRequests.push({ sessionId: request.sessionId, origin: request.origin });
          return { decision: "allow" };
        },
      },
    } as never);
  });

  afterEach(async () => {
    await rm(tempRoot, { force: true, recursive: true });
  });

  // 真实 adapter 在每次 attempt 发出前刷新 runtime headers；这里照做，好让断言落在真实链路上
  // （runtime deps → 调用上下文 → 端口）。
  const routingModelFactory = createTestModelFactory({
    async generateText(_request, observation) {
      await observation.invocationContext?.refreshRuntimeHeadersBeforeAttempt?.({ attempt: 1 });
      return {
        finishReason: "stop",
        providerMetadata: undefined,
        text: "actor done",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      } as unknown as ModelResult;
    },
  });

  async function makeActorRuntime(): Promise<AgentRuntime> {
    const deps = {
      agentTelemetry: createModelTelemetry().agentExecution,
      appOptions: { env: process.env },
      appVersion: "0.0.0-test",
      configResult: {
        config: {
          features: { skill: false },
          modelStream: { idleTimeoutMs: 0 },
          network: {},
          skillOverrides: {},
          skills: { enabled: false, roots: [] },
        },
      },
      fileSystemPort: createNodeFileSystemAdapter(),
      imageProcessorPort: {},
      logger: undefined,
      modelFactory: routingModelFactory,
      permissionService: new PermissionService(defaultPermissionConfig),
      runtime: parentRuntime,
      runtimeConfig: { workingDirectory: tempRoot },
      sessionId: parentSessionId,
      sessionStore: await createSqliteSessionStore({ dbPath: ":memory:" }),
      storageRoot: tempRoot,
      workingDirectory: tempRoot,
    } as unknown as ScriptWorkflowAgentRuntimeDeps;
    return createScriptWorkflowAgentRuntime({
      childSessionId: actorSessionId,
      deps,
      request: { opts: { agentType: "reviewer", label: "复核员" }, prompt: "go" } as never,
      traceContext: createRootTraceContext({ sessionId: parentSessionId }),
    });
  }

  it("actor 的 provider runtime headers 刷新以父会话为路由身份", async () => {
    const actorRuntime = await makeActorRuntime();
    await actorRuntime.executeTurn("go");

    expect(refreshes.length).toBeGreaterThan(0);
    // 端口入参里的 sessionId 必须是父会话：桌面只订阅父 task 的会话，带子会话去问没人应答。
    expect(refreshes.every((entry) => entry.routedSessionId === parentSessionId)).toBe(true);
  });

  it("父 runtime 铸造的 permission broker 带父会话身份与子代理 origin", async () => {
    // 这正是 createScriptWorkflowAgentRuntime 装进 actor deps 的那一份（见实现里的
    // `...deps.runtime.createChildClientPorts(...)`）。
    const ports = parentRuntime.createChildClientPorts({
      agentId: actorSessionId,
      agentType: "reviewer",
      childSessionId: actorSessionId,
      description: "复核员",
    });

    await ports.permissionBroker!.requestPermission({
      requestId: "req-actor",
      sessionId: actorSessionId,
      traceId: createTraceId(),
      toolCallId: createToolCallId(),
      toolName: "Bash",
      input: {},
      mode: "yolo",
      ruleId: "rule",
      reason: "test",
      riskLevel: "low",
      requestedAt: new Date(0),
    } as never);

    expect(permissionRequests).toHaveLength(1);
    // 桌面 UI 只订阅父 task 的 sessionId；带子会话来就没人能应答。
    expect(permissionRequests[0]!.sessionId).toBe(parentSessionId);
    expect(permissionRequests[0]!.origin).toMatchObject({
      kind: "subagent",
      childSessionId: actorSessionId,
      parentSessionId,
    });
  });
});

/**
 * workflow 子代理跑在发起会话的权限模式上（docs/dynamic-workflow/launch.md「Permissions inside a
 * run」）：该问时经父 runtime 派生的 broker 请求用户，origin 标注这个子代理，并镜像到父会话；
 * guarded 的危险命令是 user-once，拒绝时命令不执行、拒绝结果回到子代理。YOLO 不问普通工具。
 * 子代理没有 AskUserQuestion：它要人判断时 escalate 给主代理。
 */
describe("script workflow child runtime — 子代理经父 broker 请求权限与提问", () => {
  const parentSessionId = createSessionId("dwf-parent-guarded");
  const actorSessionId = createSessionId("dwf-actor-guarded-1");

  let tempRoot: string;
  let parentRuntime: AgentRuntime;
  let requests: PermissionBrokerRequest[];
  let modelRequests: string[];
  let execute: ReturnType<typeof vi.fn>;
  /** actor 第一次模型请求发出的工具调用；默认一条危险 Bash。 */
  let firstToolCall: { id: string; name: string; input: Record<string, unknown> };

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-actor-guarded-"));
    requests = [];
    modelRequests = [];
    firstToolCall = {
      id: "actor-guarded-rm",
      name: "Bash",
      input: { command: "rm -rf fixture-only" },
    };
    execute = vi.fn(async () => ({
      status: "completed" as const,
      stdout: { text: "executed", bytes: 8, truncated: false },
      stderr: { text: "", bytes: 0, truncated: false },
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
      cancelled: false,
      startedAt: new Date(),
      completedAt: new Date(),
    }));
    parentRuntime = createTestAgentRuntime(
      parentSessionId,
      { workingDirectory: tempRoot, mode: "guarded" },
      {
        eventStore: createInMemorySessionEventStore(),
        fileSystemPort: createNodeFileSystemAdapter(),
        modelFactory: guardedModelFactory,
        permissionBroker: {
          async requestPermission(request: PermissionBrokerRequest) {
            requests.push(request);
            return { decision: "deny", reason: "guarded actor fixture denial" };
          },
        },
      } as never,
    );
  });

  afterEach(async () => {
    await rm(tempRoot, { force: true, recursive: true });
  });

  // 第一次请求发出 firstToolCall；拿到工具结果后结束。
  const guardedModelFactory = createTestModelFactoryFromAdapter({
    async generateText(request) {
      modelRequests.push(JSON.stringify(request));
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      if (modelRequests.length === 1) {
        return {
          finishReason: "tool-calls",
          text: "",
          usage,
          toolCalls: [firstToolCall],
        } as unknown as ModelResult;
      }
      return { finishReason: "stop", text: "actor done", usage } as unknown as ModelResult;
    },
  });

  async function makeActorRuntime(
    subagentPermissionMode: WorkflowSubagentPermissionMode | undefined,
  ): Promise<AgentRuntime> {
    const deps = {
      agentTelemetry: createModelTelemetry().agentExecution,
      appOptions: { env: process.env, executionPort: { run: execute } },
      appVersion: "0.0.0-test",
      configResult: {
        config: {
          features: { skill: false },
          modelStream: { idleTimeoutMs: 0 },
          network: {},
          skillOverrides: {},
          skills: { enabled: false, roots: [] },
        },
      },
      fileSystemPort: createNodeFileSystemAdapter(),
      imageProcessorPort: {},
      logger: undefined,
      modelFactory: guardedModelFactory,
      permissionService: new PermissionService(defaultPermissionConfig),
      runtime: parentRuntime,
      runtimeConfig: { workingDirectory: tempRoot, mcp: { enabled: false } },
      sessionId: parentSessionId,
      sessionStore: await createSqliteSessionStore({ dbPath: ":memory:" }),
      storageRoot: tempRoot,
      workingDirectory: tempRoot,
    } as unknown as ScriptWorkflowAgentRuntimeDeps;
    // 与 create-app 的 actor 工厂同一组展开：工具面 + 权限面 + 交互归属描述。
    return createScriptWorkflowAgentRuntime({
      childSessionId: actorSessionId,
      configOverrides: {
        ...workflowActorToolPolicy(),
        ...workflowActorPermissionPolicy(subagentPermissionMode),
      },
      deps,
      interactionDescription: workflowActorInteractionDescription({
        actor: { siteId: "agent#1", ordinal: 0 },
        persona: { name: "reviewer" },
      }),
      request: { opts: {} } as never,
      traceContext: createRootTraceContext({ sessionId: parentSessionId }),
    });
  }

  it("guarded：一次 user-once 请求，父会话路由、子代理 origin；拒绝后不执行且结果回到子代理", async () => {
    const actorRuntime = await makeActorRuntime("guarded");
    expect(actorRuntime.getMode()).toBe("guarded");
    await actorRuntime.executeTurn("go");

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      approvalMode: "user-once",
      sessionId: parentSessionId,
      toolName: "Bash",
      origin: {
        kind: "subagent",
        agentId: actorSessionId,
        childSessionId: actorSessionId,
        description: "reviewer (agent#1@0)",
        parentSessionId,
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(modelRequests.some((request) => request.includes("guarded actor fixture denial"))).toBe(
      true,
    );
    // 子代理的 guarded 不改父会话的模式。
    expect(parentRuntime.getMode()).toBe("guarded");
  });

  it("交互事件镜像到父会话：父流里看到 PermissionRequested（带 origin）与随后的终态", async () => {
    // 回归（2026-09-23 实机）：request 到达了 broker，但桌面只从**父会话**的实时投影生成
    // 确认窗；actor 的 PermissionRequested 只落在子会话，窗不出现、子代理永久等待。
    const parentEvents: SessionEvent[] = [];
    parentRuntime.subscribeEvents({
      onSessionEvent: (event) => {
        if (event.sessionId === parentSessionId) parentEvents.push(event);
      },
    });
    const actorRuntime = await makeActorRuntime("guarded");
    await actorRuntime.executeTurn("go");

    const requested = parentEvents.filter(
      (event) => event.type === SessionEventType.PermissionRequested,
    );
    expect(requested).toHaveLength(1);
    const payload = requested[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      requestId: requests[0]!.requestId,
      toolName: "Bash",
      approvalMode: "user-once",
      childSessionId: actorSessionId,
      origin: {
        kind: "subagent",
        childSessionId: actorSessionId,
        description: "reviewer (agent#1@0)",
        parentSessionId,
      },
    });
    // 终态也要镜像过去，否则父投影里的待办交互永远不消失。
    const settled = parentEvents.filter(
      (event) =>
        event.type === SessionEventType.PermissionResolved ||
        event.type === SessionEventType.PermissionDenied,
    );
    expect(settled.length).toBeGreaterThan(0);
    expect(
      settled.every(
        (event) => (event.payload as { toolCallId?: unknown }).toolCallId === payload.toolCallId,
      ),
    ).toBe(true);
    // 只镜像交互：actor 的工具事件不进父会话 timeline。
    expect(
      parentEvents.some(
        (event) =>
          event.type === SessionEventType.ToolCallStarted ||
          event.type === SessionEventType.ToolCallResult,
      ),
    ).toBe(false);
  });

  it("停止 run（actor turn 被 abort）撤销挂起的请求：broker 收到 abort，命令不执行", async () => {
    const aborted = Promise.withResolvers<void>();
    const registered = Promise.withResolvers<void>();
    // 换一个永不作答、只响应 abort 的 broker：代表用户还没看到的那一个确认窗。
    parentRuntime = createTestAgentRuntime(
      parentSessionId,
      { workingDirectory: tempRoot, mode: "guarded" },
      {
        eventStore: createInMemorySessionEventStore(),
        fileSystemPort: createNodeFileSystemAdapter(),
        modelFactory: guardedModelFactory,
        permissionBroker: {
          requestPermission(request: PermissionBrokerRequest, options?: { signal?: AbortSignal }) {
            requests.push(request);
            registered.resolve();
            return new Promise((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => {
                  aborted.resolve();
                  reject(new Error("aborted"));
                },
                { once: true },
              );
            });
          },
        },
      } as never,
    );
    const actorRuntime = await makeActorRuntime("guarded");
    const controller = new AbortController();
    const turn = actorRuntime.executeTurn("go", undefined, { abortSignal: controller.signal });
    await registered.promise;
    controller.abort();
    await aborted.promise;
    await turn.catch(() => undefined);

    expect(requests).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("YOLO run（键缺席）：子代理不问，命令照常执行", async () => {
    const actorRuntime = await makeActorRuntime(undefined);
    expect(actorRuntime.getMode()).toBe("yolo");
    await actorRuntime.executeTurn("go");

    expect(requests).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("build run：子代理的普通 Bash 也经父会话请求（非 user-once），并镜像到父会话", async () => {
    const parentEvents: SessionEvent[] = [];
    parentRuntime.subscribeEvents({
      onSessionEvent: (event) => {
        if (event.sessionId === parentSessionId) parentEvents.push(event);
      },
    });
    const actorRuntime = await makeActorRuntime("build");
    expect(actorRuntime.getMode()).toBe("build");
    await actorRuntime.executeTurn("go");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.approvalMode).not.toBe("user-once");
    expect(requests[0]).toMatchObject({
      sessionId: parentSessionId,
      toolName: "Bash",
      origin: { kind: "subagent", description: "reviewer (agent#1@0)" },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(parentEvents.some((event) => event.type === SessionEventType.PermissionRequested)).toBe(
      true,
    );
  });

  it("AskUserQuestion：子代理的工具面里没有它，调用不会向用户提问，父流里也没有 PermissionRequested", async () => {
    firstToolCall = {
      id: "actor-question",
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Which file should I review first?",
            header: "Order",
            multiSelect: false,
            options: [
              { label: "a.ts", description: "The entry point" },
              { label: "b.ts", description: "The helper" },
            ],
          },
        ],
      },
    };
    const parentEvents: SessionEvent[] = [];
    parentRuntime.subscribeEvents({
      onSessionEvent: (event) => {
        if (event.sessionId === parentSessionId) parentEvents.push(event);
      },
    });
    // build 模式下普通工具都会问；即便如此 AskUserQuestion 也到不了用户面前。
    const actorRuntime = await makeActorRuntime("build");
    await actorRuntime.executeTurn("go");

    expect(requests).toHaveLength(0);
    expect(
      parentEvents.filter((event) => event.type === SessionEventType.PermissionRequested),
    ).toHaveLength(0);
    // 工具调用被当作不可用工具回给子代理，turn 照常结束（第二次模型请求带着这条错误结果）。
    expect(modelRequests).toHaveLength(2);
    expect(modelRequests[1]).toContain("actor-question");
  });
});

describe("workflow actor permission — run 记下的模式读回", () => {
  it("认识的模式原样读回；缺席、未知值与 plan 读成缺席（= YOLO）", () => {
    for (const mode of ["build", "edit", "yolo", "guarded", "auto"] as const) {
      expect(parseWorkflowSubagentPermissionMode(mode)).toBe(mode);
      expect(workflowActorPermissionPolicy(mode)).toEqual({ mode });
    }
    for (const raw of [undefined, "plan", "full-auto-2027", 42]) {
      expect(parseWorkflowSubagentPermissionMode(raw)).toBeUndefined();
    }
    expect(workflowActorPermissionPolicy(undefined)).toEqual({ mode: "yolo" });
  });
});

/**
 * 动态工作流子代理的 Browser Use（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
 * 「Subagent sessions」）。
 *
 * Bug 根因（2026-09-30）：actor 的 `mcp__node_repl__js` 带着自己的 `sess_dwf-…` 到达协议 broker，
 * `requireSession` 只认客户端会话，每个 `agent.browsers.*` 都以 `Session is not active` 失败；actor
 * runtime 也没有 browser 端口，turn end / 关闭从不通知桌面。现在由父端口派生子端口：tab 归属是
 * actor 自己的 sessionId，workspace / clientMode 取父会话，关闭时 closeTabs 并撤销登记。
 */
describe("script workflow child runtime — 子代理的 Browser Use", () => {
  const parentSessionId = createSessionId("dwf-parent-browser");
  const actorSessionId = createSessionId("dwf-dwfrun-b-actor_1_1");

  let tempRoot: string;
  let parentRuntime: AgentRuntime;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-actor-browser-"));
    parentRuntime = createTestAgentRuntime(
      parentSessionId,
      { workingDirectory: tempRoot },
      {
        eventStore: createInMemorySessionEventStore(),
        fileSystemPort: createNodeFileSystemAdapter(),
        modelFactory: browserModelFactory,
      },
    );
  });

  afterEach(async () => {
    await rm(tempRoot, { force: true, recursive: true });
  });

  const browserModelFactory = createTestModelFactoryFromAdapter({
    async generateText() {
      return {
        finishReason: "stop",
        providerMetadata: undefined,
        text: "actor done",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      } as unknown as ModelResult;
    },
  });

  /** 协议 server 的 context：只登记父会话（客户端认识的唯一会话）。 */
  function makeProtocolContext(requestClient: ReturnType<typeof vi.fn>) {
    return {
      requestClient,
      sessions: new Map([
        [
          parentSessionId,
          {
            deliveryKind: "desktop-continuous",
            workspace: { workspaceKey: "/repo", workspacePath: "/repo" },
          },
        ],
      ]),
    } as unknown as ZCodeProtocolAgentServerContext;
  }

  async function makeActorRuntime(
    browserControlPort: Parameters<
      typeof createScriptWorkflowAgentRuntime
    >[0]["browserControlPort"],
  ): Promise<AgentRuntime> {
    const deps = {
      agentTelemetry: createModelTelemetry().agentExecution,
      appOptions: { env: process.env },
      appVersion: "0.0.0-test",
      configResult: {
        config: {
          features: { skill: false },
          modelStream: { idleTimeoutMs: 0 },
          network: {},
          skillOverrides: {},
          skills: { enabled: false, roots: [] },
        },
      },
      fileSystemPort: createNodeFileSystemAdapter(),
      imageProcessorPort: {},
      logger: undefined,
      modelFactory: browserModelFactory,
      permissionService: new PermissionService(defaultPermissionConfig),
      pluginSkillRoots: [],
      runtime: parentRuntime,
      runtimeConfig: {
        workingDirectory: tempRoot,
        runtimeFeatures: { browserUse: true },
      },
      sessionId: parentSessionId,
      sessionStore: await createSqliteSessionStore({ dbPath: ":memory:" }),
      storageRoot: tempRoot,
      workingDirectory: tempRoot,
    } as unknown as ScriptWorkflowAgentRuntimeDeps;
    return createScriptWorkflowAgentRuntime({
      childSessionId: actorSessionId,
      deps,
      request: { opts: {} } as never,
      traceContext: createRootTraceContext({ sessionId: parentSessionId }),
      ...(browserControlPort === undefined ? {} : { browserControlPort }),
    });
  }

  function sentCommands(requestClient: ReturnType<typeof vi.fn>) {
    return requestClient.mock.calls.map((call) => {
      const params = call[1] as {
        command?: Record<string, unknown>;
        sessionId: string;
        workspaceKey: string;
      };
      return {
        command: params.command,
        sessionId: params.sessionId,
        workspaceKey: params.workspaceKey,
      };
    });
  }

  it("actor 经 node_repl 的浏览器请求用自己的 sessionId，workspace 取父会话；turn end 与关闭都到达桌面", async () => {
    const requestClient = vi.fn(async () => ({ ok: true, elapsedMs: 0 }));
    const context = makeProtocolContext(requestClient);
    // 生产里有两个实例：app 的 runtime 端口（传给工厂的父端口）与进程级 node_repl broker 用的那个。
    const appPort = createProtocolBrowserControlBroker(context);
    const nodeReplPort = createProtocolBrowserControlBroker(context);
    const actorRuntime = await makeActorRuntime(appPort);

    // actor 的 `mcp__node_repl__js` 最终以 actor 的 session_id 调到进程级实例。
    await expect(
      nodeReplPort.execute({
        browserId: "iab-1",
        browserGeneration: 7,
        sessionId: actorSessionId,
        command: { method: "newTab" },
      }),
    ).resolves.toMatchObject({ ok: true });
    await actorRuntime.executeTurn("go");
    await actorRuntime.closeBrowserSession();

    expect(sentCommands(requestClient)).toEqual([
      { command: { method: "newTab" }, sessionId: actorSessionId, workspaceKey: "/repo" },
      {
        command: expect.objectContaining({ method: "turnEnded" }),
        sessionId: actorSessionId,
        workspaceKey: "/repo",
      },
      {
        command: { method: "closeSession", closeTabs: true },
        sessionId: actorSessionId,
        workspaceKey: "/repo",
      },
    ]);
    // 关闭即撤销登记：之后同一 id 与未登记的会话一样被拒。
    await expect(nodeReplPort.list({ sessionId: actorSessionId })).rejects.toThrow(
      `Session is not active: ${actorSessionId}`,
    );
  });

  it("不传父端口（legacy Workflow child）：actor 没有 Browser 登记，关闭不发任何浏览器请求", async () => {
    const requestClient = vi.fn(async () => ({ ok: true, elapsedMs: 0 }));
    const nodeReplPort = createProtocolBrowserControlBroker(makeProtocolContext(requestClient));
    const actorRuntime = await makeActorRuntime(undefined);

    await expect(nodeReplPort.list({ sessionId: actorSessionId })).rejects.toThrow(
      `Session is not active: ${actorSessionId}`,
    );
    await actorRuntime.executeTurn("go");
    await actorRuntime.closeBrowserSession();
    expect(requestClient).not.toHaveBeenCalled();
  });

  it("端口没有 forChildSession（CLI headless CDP）：actor 直接用父端口，关闭时关自己的 session", async () => {
    const closed: string[] = [];
    const port = {
      list: vi.fn(async () => []),
      execute: vi.fn(async () => ({ ok: true, elapsedMs: 0 })),
      closeSession: vi.fn(async (input: { sessionId: string }) => {
        closed.push(input.sessionId);
      }),
    };
    const actorRuntime = await makeActorRuntime(port);
    await actorRuntime.closeBrowserSession();
    expect(closed).toEqual([actorSessionId]);
  });
});

describe("script workflow child runtime — 子代理的技能清单", () => {
  const PACKAGES_ROOT = fileURLToPath(new URL("../../", import.meta.url));
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-actor-skills-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { force: true, recursive: true });
  });

  function skillDeps(input: { pluginSkillRoots: SkillRoot[] }) {
    return {
      appOptions: { env: process.env },
      configResult: {
        config: {
          features: { skill: true },
          skillOverrides: {},
          skills: { enabled: true, roots: [join(tempRoot, "configured")] },
        },
      },
      pluginSkillRoots: input.pluginSkillRoots,
    } as unknown as ScriptWorkflowAgentRuntimeDeps;
  }

  // Bug 根因（2026-09-30）：child 自己造 skill adapter 时只带了用户配置的 roots，插件技能根
  // （browser-use 的 control-browser 等）是后来才加到主会话那一份上的，child 这边漂掉了。
  it("插件技能根与用户配置根都在：actor 看得见 browser-use 的 control-browser", async () => {
    await mkdir(join(tempRoot, "configured", "house-style"), { recursive: true });
    await writeFile(
      join(tempRoot, "configured", "house-style", "SKILL.md"),
      "---\nname: house-style\ndescription: House style.\n---\n\nBody.\n",
    );
    const port = createWorkflowChildSkillPort(
      skillDeps({
        pluginSkillRoots: [
          {
            path: join(PACKAGES_ROOT, "browser-use-plugin", "skills"),
            priority: 1_000,
            scope: "system",
            source: "plugin",
            pluginId: "browser-use@zcode-plugins-official",
          },
        ],
      }),
    );

    const outcome = await port!.discoverSkills({ workingDirectory: tempRoot });
    const names = outcome.skills.map((skill) => skill.name);
    expect(names).toEqual(expect.arrayContaining(["control-browser", "house-style"]));
    // 捆绑的 dynamic-workflows 技能不给子代理：它不能起工作流。
    expect(names).not.toContain("dynamic-workflows");
  });

  it("技能总开关关闭时没有 skill 端口", () => {
    const deps = skillDeps({ pluginSkillRoots: [] });
    (deps.configResult.config.features as { skill: boolean }).skill = false;
    expect(createWorkflowChildSkillPort(deps)).toBeUndefined();
  });
});
