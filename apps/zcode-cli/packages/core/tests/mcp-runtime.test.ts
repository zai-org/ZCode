import { createMockMcpPort, mcpStatus } from "./mcp-runtime-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetCapturedZCodeCuaBrokerCredentialsForTest,
  sanitizeZCodeRuntimeEnv,
  ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";
import {
  ModelTransportKind,
  SessionEventType,
  createSessionId,
  createTraceId,
  createWorkspaceId,
  type McpConnectionSnapshot,
  type McpPort,
  type McpServerStatus,
  type McpServerToolSnapshot,
  type McpToolDescriptor,
  type McpToolCatalogPort,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type SessionEventStorePort,
  type SessionId,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("AgentRuntime MCP integration", () => {
  afterEach(() => {
    resetCapturedZCodeCuaBrokerCredentialsForTest();
  });

  it.each(["tavily_search", "tavily_extract", "lookup_record"])(
    "%s sends one complete result to subsequent model requests",
    async (toolName) => {
      const sessionId = createSessionId(`runtime-${toolName}`);
      const structuredContent = {
        results: [{ url: "https://example.com", content: "result ".repeat(4_000) }],
      };
      const text = JSON.stringify(structuredContent);
      const toolResult = { content: [{ type: "text", text }], structuredContent };
      const modelToolName = `mcp__custom_search__${toolName}`;
      let modelCallCount = 0;
      let mcpCallCount = 0;
      const runtime = createTestAgentRuntime(
        sessionId,
        {
          mode: "build",
          mcp: {
            enabled: true,
            servers: { custom_search: { type: "stdio", command: "node" } },
          },
        },
        {
          eventStore: createTestSessionEventStore(),
          permissionBroker: {
            requestPermission: async () => ({ decision: "allow", reason: "Test approval" }),
          },
          mcpPort: createMockMcpPort({
            connectConfiguredServers: async () => ({
              statuses: { custom_search: mcpStatus("connected", { toolCount: 1 }) },
              tools: [
                {
                  serverName: "custom_search",
                  toolName,
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: true },
                },
              ],
            }),
            callTool: async () => {
              mcpCallCount++;
              return toolResult;
            },
          }),
          modelFactory: createTestModelFactory({
            async generateText(request) {
              modelCallCount++;
              if (modelCallCount === 1) {
                return {
                  finishReason: "tool-calls",
                  text: "",
                  toolCalls: [{ id: "mcp-call", name: modelToolName, input: {} }],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              const messages = request.messages.filter((message) => message.role === "tool");
              expect(messages).toHaveLength(1);
              expect(messages[0]?.content).toBe(text);
              return {
                finishReason: "stop",
                text: "done",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            },
          }),
        },
      );

      await runtime.startMcpStartup({ sessionId, traceId: createTraceId(`startup-${toolName}`) });
      expect((await runtime.executeTurn("Search")).response).toBe("done");
      expect((await runtime.executeTurn("Use the previous result")).response).toBe("done");
      expect(modelCallCount).toBe(3);
      expect(mcpCallCount).toBe(1);
      expect(toolResult.structuredContent).toEqual(structuredContent);
    },
  );

  it("keeps the session resident while detached MCP startup is pending", async () => {
    const sessionId = createSessionId("runtime-mcp-residency");
    const startup = deferred<McpConnectionSnapshot>();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createMockMcpPort({
          connectConfiguredServers: async () => startup.promise,
        }),
      },
    );

    expect(runtime.hasResidencyBlockingWork()).toBe(true);
    startup.resolve(emptyMcpSnapshot());
    await runtime.startMcpStartup({
      sessionId,
      traceId: createTraceId("runtime-mcp-residency"),
    });
    expect(runtime.hasResidencyBlockingWork()).toBe(false);
  });

  it("starts configured MCP servers when the runtime is constructed", () => {
    const sessionId = createSessionId("runtime-mcp-startup");
    const eventStore = createTestSessionEventStore();
    let connectCalls = 0;
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => {
        connectCalls++;
        return emptyMcpSnapshot();
      },
    });

    createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
      },
    );

    expect(connectCalls).toBe(1);
  });

  it("passes a 15s OAuth authorization wait limit to session MCP startup", () => {
    const sessionId = createSessionId("runtime-mcp-oauth-timeout");
    const eventStore = createTestSessionEventStore();
    let connectOptions: Parameters<McpPort["connectConfiguredServers"]>[1];
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async (_servers, options) => {
        connectOptions = options;
        return emptyMcpSnapshot();
      },
    });

    createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            notion: {
              type: "http",
              url: "https://mcp.example.test/mcp",
              oauth: {
                type: "authorization_code",
              },
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
      },
    );

    expect(connectOptions?.oauthAuthorizationTimeoutMs).toBe(15_000);
  });

  it("emits turn_started before pending MCP startup resolves and waits before model request", async () => {
    const sessionId = createSessionId("runtime-mcp-background-startup");
    const eventStore = createTestSessionEventStore();
    const startup = deferred<McpConnectionSnapshot>();
    let modelRequestCount = 0;
    let toolNames: string[] = [];
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => startup.promise,
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            modelRequestCount++;
            toolNames = request.tools.map((tool: { name: string }) => tool.name);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    const turn = runtime.executeTurn("use mcp if needed");
    await waitForEvent(eventStore, sessionId, SessionEventType.TurnStarted);
    expect(modelRequestCount).toBe(0);

    startup.resolve({
      statuses: {
        local: {
          status: "connected",
          transport: "stdio",
          toolCount: 1,
          updatedAt: "now",
        },
      },
      tools: [
        {
          serverName: "local",
          toolName: "ping",
          inputSchema: {
            type: "object",
            properties: {},
          },
          annotations: {
            readOnlyHint: true,
          },
        },
      ],
    });

    await turn;
    expect(modelRequestCount).toBe(1);
    expect(toolNames).toContain("mcp__local__ping");
  });

  it("uses the cached catalog without waiting and applies the live list on the next request", async () => {
    const sessionId = createSessionId("runtime-mcp-cached-startup");
    const startup = deferred<McpConnectionSnapshot>();
    const providerToolSnapshots: string[] = [];
    const publishedSnapshots: Record<string, McpServerToolSnapshot>[] = [];
    let listToolsCalls = 0;
    const cachedTool = {
      serverName: "local",
      toolName: "ping",
      description: "cached description",
      inputSchema: { type: "object", properties: {} } as const,
    };
    const snapshot: Record<string, McpServerToolSnapshot> = {
      local: { status: mcpStatus("connecting") },
    };
    const catalogPort: McpToolCatalogPort = {
      prepare: () => ({
        lookup: { status: "complete", byServer: { local: [cachedTool] } },
        publish: (published) => {
          publishedSnapshots.push(published);
        },
      }),
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: { type: "stdio", command: "node", args: ["server.js"] },
          },
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createSnapshotMcpPort(snapshot, {
          connectConfiguredServers: async () => startup.promise,
          // 快照端口不再走 listTools 轮询；请求准备只读内存快照。
          listTools: async () => {
            listToolsCalls += 1;
            return [];
          },
        }),
        mcpStartupPolicy: "background",
        mcpToolCatalogPort: catalogPort,
        modelAdapter: {
          async generateText(request: any) {
            providerToolSnapshots.push(JSON.stringify(request.tools));
            return {
              finishReason: "stop",
              model: request.model,
              providerMetadata: undefined,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never,
      },
    );

    await runtime.executeTurn("first request");
    expect(providerToolSnapshots).toHaveLength(1);
    expect(providerToolSnapshots[0]).toContain("mcp__local__ping");
    expect(providerToolSnapshots[0]).toContain("cached description");

    const liveTools = [
      {
        ...cachedTool,
        description: "live description changed",
        inputSchema: {
          type: "object" as const,
          properties: { live: { type: "boolean" } },
        },
      },
      {
        serverName: "local",
        toolName: "new-tool",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ];
    snapshot.local = { status: mcpStatus("connected"), tools: liveTools, toolsVersion: "c1:1" };
    startup.resolve({ statuses: { local: mcpStatus("connected") }, tools: liveTools });
    await runtime.startMcpStartup({ sessionId, traceId: createTraceId("cached-startup") });
    await runtime.executeTurn("second request");

    expect(publishedSnapshots.at(-1)?.local?.tools).toEqual(liveTools);
    expect(providerToolSnapshots).toHaveLength(2);
    expect(providerToolSnapshots[1]).toContain("live description changed");
    expect(providerToolSnapshots[1]).toContain("mcp__local__new-tool");
    expect(listToolsCalls).toBe(0);
  });

  it("applies the official CUA name projection to cached catalog entries", async () => {
    // 缓存命中走快照注册路径时，官方 CUA 的规范名投影 / 别名必须同样成立，
    // 且执行期 live 解析要按同一投影规则比对名称。
    const TEST_PLUGIN_AUTHORITY = "test-plugin-authority";
    sanitizeZCodeRuntimeEnv({
      ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/tmp/zcode-cua-test.sock",
      ZCODE_CUA_PERMISSION_BROKER_TOKEN: "test-broker-token",
      [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: TEST_PLUGIN_AUTHORITY,
    });
    const sessionId = createSessionId("runtime-mcp-cached-cua");
    const cuaTool = {
      serverName: ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME,
      toolName: "open_application",
      name: "mcp__plugin_zcode-cua_computer-use__open_application",
      inputSchema: { type: "object", properties: {} } as const,
    };
    const snapshot: Record<string, McpServerToolSnapshot> = {
      [ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME]: { status: mcpStatus("connecting") },
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            [ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME]: {
              type: "stdio",
              command: "zcode-cua",
              env: {
                [ZCODE_PLUGIN_ID_ENV_KEY]: ZCODE_CUA_OFFICIAL_PLUGIN_ID,
                [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: TEST_PLUGIN_AUTHORITY,
              },
            },
          },
          trustedOfficialCuaServerNames: [ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME],
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createSnapshotMcpPort(snapshot, {
          connectConfiguredServers: () => new Promise(() => {}),
        }),
        mcpStartupPolicy: "background",
        mcpToolCatalogPort: {
          prepare: () => ({
            lookup: {
              status: "complete",
              byServer: { [ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME]: [cuaTool] },
            },
            publish: () => {},
          }),
        },
        modelAdapter: createStopModelAdapter(),
      },
    );

    await runtime.executeTurn("first request");

    const registry = runtime.getToolRegistry();
    const canonical = registry.get("mcp__computer-use__open_application");
    expect(canonical).toBeDefined();
    expect(registry.get("mcp__computer_use__open_application")).toBe(canonical);
    expect(registry.get("mcp__plugin_zcode-cua_computer-use__open_application")).toBeUndefined();
    expect((canonical as { permissionCapabilityGroup?: string }).permissionCapabilityGroup).toBe(
      "official_cua",
    );

    snapshot[ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME] = {
      status: mcpStatus("connected"),
      tools: [cuaTool],
      toolsVersion: "c1:1",
    };
    const resolution = await canonical!.resolveForExecution!({});
    expect(resolution.status).toBe("ready");
    if (resolution.status === "ready") {
      expect(resolution.entry.metadata.name).toBe("mcp__computer-use__open_application");
    }
  });

  it("waits only for the target server and revalidates cached tools before permission", async () => {
    const sessionId = createSessionId("runtime-mcp-cached-live-preflight");
    const serverReady = deferred<{ timedOut: boolean }>();
    const waitCalls: { serverName: string; timeoutMs: number }[] = [];
    let modelRequestCount = 0;
    let mcpCallCount = 0;
    const cachedTool = {
      serverName: "device",
      toolName: "reset",
      inputSchema: { type: "object", properties: {} } as const,
    };
    const snapshot: Record<string, McpServerToolSnapshot> = {
      device: { status: mcpStatus("connecting") },
      other: { status: mcpStatus("connecting") },
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "plan",
        mcp: {
          enabled: true,
          servers: {
            device: { type: "stdio", command: "node", args: ["server.js"] },
            other: { type: "stdio", command: "node", args: ["other.js"] },
          },
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createSnapshotMcpPort(snapshot, {
          connectConfiguredServers: () => new Promise(() => {}),
          waitForServer: (serverName, options) => {
            waitCalls.push({ serverName, timeoutMs: options.timeoutMs });
            return serverReady.promise;
          },
          callTool: async () => {
            mcpCallCount++;
            return { content: [{ type: "text", text: "should-not-run" }] };
          },
        }),
        mcpStartupPolicy: "background",
        mcpToolCatalogPort: {
          prepare: () => ({
            lookup: { status: "complete", byServer: { device: [cachedTool] } },
            publish: () => {},
          }),
        },
        modelAdapter: {
          async generateText(request: any) {
            modelRequestCount++;
            if (modelRequestCount === 1) {
              snapshot.device.status = mcpStatus("disconnected");
              return toolCallResult(request, "reset", "mcp__device__reset");
            }
            return stopModelResult(request);
          },
        } as never,
      },
    );

    const turn = runtime.executeTurn("do not mutate");
    await waitForCondition(() => waitCalls.length === 1);
    // 已注册工具使用连接超时，不能继承搜索的短等待预算。
    expect(waitCalls).toEqual([{ serverName: "device", timeoutMs: 30_000 }]);
    snapshot.device = {
      status: mcpStatus("connected"),
      tools: [{ ...cachedTool, annotations: { destructiveHint: true } }],
      toolsVersion: "c1:1",
    };
    serverReady.resolve({ timedOut: false });

    await turn;
    expect(modelRequestCount).toBe(2);
    expect(mcpCallCount).toBe(0);
  });

  it("reports a timed-out server wait as unavailable without calling the server", async () => {
    const sessionId = createSessionId("runtime-mcp-wait-timeout");
    const eventStore = createTestSessionEventStore();
    const waitCalls: number[] = [];
    let mcpCallCount = 0;
    const cachedTool = {
      serverName: "slow",
      toolName: "lookup",
      inputSchema: { type: "object", properties: {} } as const,
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "plan",
        mcp: {
          enabled: true,
          servers: {
            slow: { type: "stdio", command: "node", args: ["server.js"], timeoutMs: 3_000 },
          },
        },
      },
      {
        eventStore,
        mcpPort: createSnapshotMcpPort(
          { slow: { status: mcpStatus("connecting") } },
          {
            connectConfiguredServers: () => new Promise(() => {}),
            waitForServer: async (_serverName, options) => {
              waitCalls.push(options.timeoutMs);
              return { timedOut: true };
            },
            callTool: async () => {
              mcpCallCount++;
              return { content: [{ type: "text", text: "should-not-run" }] };
            },
          },
        ),
        mcpStartupPolicy: "background",
        mcpToolCatalogPort: {
          prepare: () => ({
            lookup: { status: "complete", byServer: { slow: [cachedTool] } },
            publish: () => {},
          }),
        },
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            if (!request.messages.some((message: any) => message.role === "tool")) {
              return toolCallResult(request, "lookup", "mcp__slow__lookup");
            }
            return stopModelResult(request);
          },
        } as never),
      },
    );

    await runtime.executeTurn("look it up");
    expect(waitCalls).toEqual([3_000]);
    expect(mcpCallCount).toBe(0);
  });

  it.each([
    {
      label: "reconnects and checks the recovered definition",
      recovered: (tool: McpToolDescriptor): McpServerToolSnapshot => ({
        status: mcpStatus("connected"),
        tools: [{ ...tool, annotations: { destructiveHint: true } }],
        toolsVersion: "c2:1",
      }),
    },
    {
      label: "reports a failed reconnect as unavailable",
      recovered: (): McpServerToolSnapshot => ({ status: mcpStatus("failed") }),
    },
  ])("does not run a disconnected server's stale definition: $label", async ({ recovered }) => {
    const sessionId = createSessionId("runtime-mcp-disconnected-preflight");
    const waitCalls: { reconnect?: boolean; reauthorize?: boolean }[] = [];
    let mcpCallCount = 0;
    const staleTool = {
      serverName: "device",
      toolName: "reset",
      inputSchema: { type: "object", properties: {} } as const,
      annotations: { readOnlyHint: true },
    };
    const snapshot: Record<string, McpServerToolSnapshot> = {
      device: { status: mcpStatus("connected"), tools: [staleTool], toolsVersion: "c1:1" },
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "plan",
        mcp: {
          enabled: true,
          servers: { device: { type: "stdio", command: "node", args: ["server.js"] } },
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createSnapshotMcpPort(snapshot, {
          connectConfiguredServers: () => new Promise(() => {}),
          waitForServer: async (_serverName, options) => {
            waitCalls.push({ reconnect: options.reconnect, reauthorize: options.reauthorize });
            // 执行前检查要求重连：断线 server 恢复后发布新定义，或重连失败。
            if (options.reconnect) snapshot.device = recovered(staleTool);
            return { timedOut: false };
          },
          callTool: async () => {
            mcpCallCount++;
            return { content: [{ type: "text", text: "should-not-run" }] };
          },
        }),
        mcpStartupPolicy: "background",
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            if (!request.messages.some((message: any) => message.role === "tool")) {
              snapshot.device.status = mcpStatus("disconnected");
              return toolCallResult(request, "reset", "mcp__device__reset");
            }
            return stopModelResult(request);
          },
        } as never),
      },
    );

    await runtime.executeTurn("reset the device");
    expect(mcpCallCount).toBe(0);
    // 只有工具执行准入要求授权失败的 server 重新授权；MCP App 打开不传。
    expect(waitCalls).toEqual([{ reconnect: true, reauthorize: true }]);
  });

  it("keeps remote workspaces on the cold path until remote session identity is available", async () => {
    const sessionId = createSessionId("runtime-mcp-remote-cold");
    const startup = deferred<McpConnectionSnapshot>();
    let catalogPrepareCount = 0;
    let modelRequestCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            remote: { type: "stdio", command: "node", args: ["server.js"] },
          },
        },
        workspaceIdentity: createWorkspaceId("ssh://host/workspace"),
      },
      {
        eventStore: createTestSessionEventStore(),
        isRemoteWorkspace: () => true,
        mcpPort: createMockMcpPort({
          connectConfiguredServers: async () => startup.promise,
        }),
        mcpToolCatalogPort: {
          prepare: () => {
            catalogPrepareCount++;
            return {
              lookup: {
                status: "complete",
                byServer: {
                  remote: [
                    {
                      serverName: "remote",
                      toolName: "cached",
                      inputSchema: { type: "object", properties: {} },
                    },
                  ],
                },
              },
              publish: () => {},
            };
          },
        },
        modelAdapter: {
          async generateText(request: any) {
            modelRequestCount++;
            return stopModelResult(request);
          },
        } as never,
      },
    );

    const turn = runtime.executeTurn("remote request");
    await waitForCondition(() => runtime.hasResidencyBlockingWork());
    expect(catalogPrepareCount).toBe(0);
    expect(modelRequestCount).toBe(0);
    startup.resolve(emptyMcpSnapshot());
    await turn;
    expect(modelRequestCount).toBe(1);
  });

  it("does not register or cache a startup that resolves after shutdown began", async () => {
    const sessionId = createSessionId("runtime-mcp-late-startup-after-shutdown");
    const startup = deferred<McpConnectionSnapshot>();
    let publishCount = 0;
    const liveTool = {
      serverName: "local",
      toolName: "ping",
      inputSchema: { type: "object", properties: {} } as const,
    };
    const snapshot: Record<string, McpServerToolSnapshot> = {
      local: { status: mcpStatus("connecting") },
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: { local: { type: "stdio", command: "node", args: ["server.js"] } },
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createSnapshotMcpPort(snapshot, {
          connectConfiguredServers: async () => startup.promise,
        }),
        mcpToolCatalogPort: {
          prepare: () => ({
            lookup: { status: "incomplete", byServer: {} },
            publish: (rows) => {
              if (Object.values(rows).some((row) => row.status.status === "connected"))
                publishCount++;
            },
          }),
        },
        modelAdapter: createStopModelAdapter(),
      },
    );

    const turn = runtime.executeTurn("blocking request");
    await waitForCondition(() => runtime.hasResidencyBlockingWork());
    // 等待启动期间开始关闭，随后启动成功返回。
    runtime.beginShutdown();
    snapshot.local = { status: mcpStatus("connected"), tools: [liveTool], toolsVersion: "c1:1" };
    startup.resolve({ statuses: { local: mcpStatus("connected") }, tools: [liveTool] });
    await turn.catch(() => {});
    expect(runtime.getToolRegistry().get("mcp__local__ping")).toBeUndefined();
    expect(publishCount).toBe(0);
  });

  it.each([
    {
      label: "reordered tools with the same content",
      next: (tools: McpToolDescriptor[]) => [...tools].reverse(),
      reregistered: false,
    },
    {
      label: "a repeated list_changed with identical content",
      next: (tools: McpToolDescriptor[]) => tools.map((tool) => ({ ...tool })),
      reregistered: false,
    },
    {
      label: "a schema-only update",
      next: (tools: McpToolDescriptor[]) =>
        tools.map((tool) =>
          tool.toolName === "alpha"
            ? { ...tool, inputSchema: { type: "object", properties: { q: { type: "string" } } } }
            : tool,
        ),
      reregistered: true,
    },
  ])("compares MCP tool content across versions for $label", async ({ next, reregistered }) => {
    const sessionId = createSessionId("runtime-mcp-content-compare");
    const toolNames: string[][] = [];
    const tools: McpToolDescriptor[] = [
      { serverName: "a", toolName: "alpha", inputSchema: { type: "object", properties: {} } },
      { serverName: "a", toolName: "beta", inputSchema: { type: "object", properties: {} } },
    ];
    const snapshot: Record<string, McpServerToolSnapshot> = {
      a: { status: mcpStatus("connected"), tools, toolsVersion: "c1:1" },
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: { a: { type: "stdio", command: "node", args: ["a.js"] } },
        },
        titleGeneration: { enabled: false },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createSnapshotMcpPort(snapshot, {
          connectConfiguredServers: () => new Promise(() => {}),
        }),
        mcpStartupPolicy: "background",
        modelAdapter: createStopModelAdapter(toolNames),
      },
    );

    await runtime.executeTurn("first");
    const before = runtime.getToolRegistry().get("mcp__a__alpha");
    snapshot.a = { status: mcpStatus("connected"), tools: next(tools), toolsVersion: "c1:2" };
    await runtime.executeTurn("second");
    const after = runtime.getToolRegistry().get("mcp__a__alpha");
    const mcpOrder = (names: string[] | undefined) =>
      names?.filter((name) => name.startsWith("mcp__"));
    expect(mcpOrder(toolNames[1])).toEqual(mcpOrder(toolNames[0]));
    if (reregistered) expect(after).not.toBe(before);
    else expect(after).toBe(before);
  });

  it("does not wait for MCP startup on a background request without cache", async () => {
    const sessionId = createSessionId("runtime-mcp-background-cold");
    const toolNames: string[][] = [];
    const snapshot: Record<string, McpServerToolSnapshot> = {
      local: { status: mcpStatus("connecting") },
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: { local: { type: "stdio", command: "node", args: ["server.js"] } },
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createSnapshotMcpPort(snapshot, {
          connectConfiguredServers: () => new Promise(() => {}),
        }),
        mcpStartupPolicy: "background",
        modelAdapter: createStopModelAdapter(toolNames),
      },
    );

    await runtime.executeTurn("first request");
    expect(toolNames[0]?.some((name) => name.startsWith("mcp__"))).toBe(false);
  });

  it("waits for MCP startup by default even when the port exposes tool snapshots", async () => {
    const sessionId = createSessionId("runtime-mcp-snapshot-blocking");
    const startup = deferred<McpConnectionSnapshot>();
    const toolNames: string[][] = [];
    const liveTool = {
      serverName: "local",
      toolName: "ping",
      inputSchema: { type: "object", properties: {} } as const,
    };
    const snapshot: Record<string, McpServerToolSnapshot> = {
      local: { status: mcpStatus("connecting") },
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: { local: { type: "stdio", command: "node", args: ["server.js"] } },
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createSnapshotMcpPort(snapshot, {
          connectConfiguredServers: async () => startup.promise,
        }),
        modelAdapter: createStopModelAdapter(toolNames),
      },
    );

    const turn = runtime.executeTurn("blocking request");
    await waitForCondition(() => runtime.hasResidencyBlockingWork());
    expect(toolNames).toHaveLength(0);
    snapshot.local = { status: mcpStatus("connected"), tools: [liveTool], toolsVersion: "c1:1" };
    startup.resolve({ statuses: { local: mcpStatus("connected") }, tools: [liveTool] });
    await turn;
    expect(toolNames[0]).toContain("mcp__local__ping");
  });

  it.each([
    ["automation", { automationId: "automation-1" }],
    ["off-peak", { offPeakTaskId: "offpeak-1" }],
  ] as const)(
    "waits for MCP startup on a background-policy %s turn",
    async (label, attribution) => {
      const sessionId = createSessionId(`runtime-mcp-auto-${label}`);
      const startup = deferred<McpConnectionSnapshot>();
      const toolNames: string[][] = [];
      const liveTool = {
        serverName: "local",
        toolName: "ping",
        inputSchema: { type: "object", properties: {} } as const,
      };
      const snapshot: Record<string, McpServerToolSnapshot> = {
        local: { status: mcpStatus("connecting") },
      };
      const runtime = createTestAgentRuntime(
        sessionId,
        {
          mode: "build",
          mcp: {
            enabled: true,
            servers: { local: { type: "stdio", command: "node", args: ["server.js"] } },
          },
        },
        {
          eventStore: createTestSessionEventStore(),
          mcpPort: createSnapshotMcpPort(snapshot, {
            connectConfiguredServers: async () => startup.promise,
          }),
          mcpStartupPolicy: "background",
          modelAdapter: createStopModelAdapter(toolNames),
        },
      );

      // 自动任务无人可交互，即使会话策略是 background 也必须等启动结束。
      const turn = runtime.executeTurn("automatic task", undefined, attribution);
      // 启动未释放前模型请求不得发出；background 不等待时这里会先看到模型请求。
      await expect(waitForCondition(() => toolNames.length > 0)).rejects.toThrow("Timed out");
      snapshot.local = { status: mcpStatus("connected"), tools: [liveTool], toolsVersion: "c1:1" };
      startup.resolve({ statuses: { local: mcpStatus("connected") }, tools: [liveTool] });
      await turn;
      expect(toolNames[0]).toContain("mcp__local__ping");
    },
  );

  it.each([
    ["reconnecting", { status: mcpStatus("connecting") }],
    ["failed", { status: mcpStatus("failed") }],
    [
      "oauth pending",
      {
        status: {
          ...mcpStatus("connecting"),
          authorization: {
            type: "oauth_authorization_code",
            authorizationUrl: "https://auth.example.com/authorize",
            startedAt: "now",
          },
        },
      },
    ],
  ] as const)(
    "uses the connection snapshot during recovery and clears terminal failure: %s",
    async (_label, reconnecting) => {
      const sessionId = createSessionId(`runtime-mcp-keep-shown-${_label}`);
      const toolNames: string[][] = [];
      const docsTool = {
        serverName: "docs",
        toolName: "search",
        inputSchema: { type: "object", properties: {} } as const,
      };
      const snapshot: Record<string, McpServerToolSnapshot> = {
        docs: { status: mcpStatus("connected"), tools: [docsTool], toolsVersion: "c1:1" },
      };
      const runtime = createTestAgentRuntime(
        sessionId,
        {
          mode: "build",
          mcp: {
            enabled: true,
            servers: { docs: { type: "http", url: "https://mcp.example.com/docs" } },
          },
        },
        {
          eventStore: createTestSessionEventStore(),
          mcpPort: createSnapshotMcpPort(snapshot, {
            connectConfiguredServers: () => new Promise(() => {}),
          }),
          mcpStartupPolicy: "background",
          modelAdapter: createStopModelAdapter(toolNames),
        },
      );

      await runtime.executeTurn("first");
      // 重连保留目录由连接层负责；session 不再维护另一份旧列表。
      snapshot.docs = { ...reconnecting, tools: [docsTool], toolsVersion: "c1:1" };
      await runtime.executeTurn("second");
      // 合法的空清单才替换已展示的工具。
      snapshot.docs = { status: mcpStatus("connected"), tools: [], toolsVersion: "c2:1" };
      await runtime.executeTurn("third");

      expect(toolNames[0]).toContain("mcp__docs__search");
      if (_label === "failed") expect(toolNames[1]).not.toContain("mcp__docs__search");
      else expect(toolNames[1]).toContain("mcp__docs__search");
      expect(toolNames[2]).not.toContain("mcp__docs__search");
    },
  );

  it.each(["disabled", "untrusted"] as const)(
    "drops the shown list of a %s server",
    async (status) => {
      const sessionId = createSessionId(`runtime-mcp-drop-shown-${status}`);
      const toolNames: string[][] = [];
      const docsTool = {
        serverName: "docs",
        toolName: "search",
        inputSchema: { type: "object", properties: {} } as const,
      };
      const snapshot: Record<string, McpServerToolSnapshot> = {
        docs: { status: mcpStatus("connected"), tools: [docsTool], toolsVersion: "c1:1" },
      };
      const runtime = createTestAgentRuntime(
        sessionId,
        {
          mode: "build",
          mcp: {
            enabled: true,
            servers: { docs: { type: "http", url: "https://mcp.example.com/docs" } },
          },
        },
        {
          eventStore: createTestSessionEventStore(),
          mcpPort: createSnapshotMcpPort(snapshot, {
            connectConfiguredServers: () => new Promise(() => {}),
          }),
          mcpStartupPolicy: "background",
          modelAdapter: createStopModelAdapter(toolNames),
        },
      );

      await runtime.executeTurn("first");
      snapshot.docs = { status: mcpStatus(status) };
      await runtime.executeTurn("second");

      expect(toolNames[0]).toContain("mcp__docs__search");
      expect(toolNames[1]).not.toContain("mcp__docs__search");
    },
  );

  it("applies a server published during a tool call on the next request of the same turn", async () => {
    const sessionId = createSessionId("runtime-mcp-publish-mid-turn");
    const toolNames: string[][] = [];
    const pingTool = {
      serverName: "a",
      toolName: "ping",
      inputSchema: { type: "object", properties: {} } as const,
    };
    const lateTool = {
      serverName: "b",
      toolName: "late",
      inputSchema: { type: "object", properties: {} } as const,
    };
    const snapshot: Record<string, McpServerToolSnapshot> = {
      a: { status: mcpStatus("connected"), tools: [pingTool], toolsVersion: "c1:1" },
      b: { status: mcpStatus("connecting") },
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        // 用 yolo 让 MCP 工具免审批执行；本用例只验证同一轮下一次请求的工具列表，不验证权限。
        mode: "yolo",
        mcp: {
          enabled: true,
          servers: {
            a: { type: "stdio", command: "node", args: ["a.js"] },
            b: { type: "stdio", command: "node", args: ["b.js"] },
          },
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createSnapshotMcpPort(snapshot, {
          connectConfiguredServers: () => new Promise(() => {}),
          callTool: async () => {
            // server b 在工具调用期间就绪，下一次正常请求才生效。
            snapshot.b = {
              status: mcpStatus("connected"),
              tools: [lateTool],
              toolsVersion: "c2:1",
            };
            return { content: [{ type: "text", text: "pong" }] };
          },
        }),
        mcpStartupPolicy: "background",
        modelAdapter: {
          async generateText(request: any) {
            toolNames.push(request.tools.map((tool: { name: string }) => tool.name));
            if (toolNames.length === 1) return toolCallResult(request, "ping", "mcp__a__ping");
            return stopModelResult(request);
          },
        } as never,
      },
    );

    await runtime.executeTurn("ping");
    expect(toolNames).toHaveLength(2);
    expect(toolNames[0]).toContain("mcp__a__ping");
    expect(toolNames[0]).not.toContain("mcp__b__late");
    expect(toolNames[1]).toContain("mcp__b__late");
  });

  it("keeps the request tool list fixed during output token continuation", async () => {
    const sessionId = createSessionId("runtime-mcp-continuation-fixed");
    const toolNames: string[][] = [];
    const snapshot: Record<string, McpServerToolSnapshot> = {
      a: { status: mcpStatus("connecting") },
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: { a: { type: "stdio", command: "node", args: ["a.js"] } },
        },
        titleGeneration: { enabled: false },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createSnapshotMcpPort(snapshot, {
          connectConfiguredServers: () => new Promise(() => {}),
        }),
        mcpStartupPolicy: "background",
        modelAdapter: {
          async generateText(request: any) {
            toolNames.push(request.tools.map((tool: { name: string }) => tool.name));
            if (toolNames.length === 1) {
              snapshot.a = {
                status: mcpStatus("connected"),
                tools: [
                  {
                    serverName: "a",
                    toolName: "late",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
                toolsVersion: "c1:1",
              };
              return { ...stopModelResult(request), finishReason: "length", text: "partial" };
            }
            return stopModelResult(request);
          },
        } as never,
      },
    );

    await runtime.executeTurn("long answer");
    expect(toolNames).toHaveLength(2);
    expect(toolNames[1]).not.toContain("mcp__a__late");
    await runtime.executeTurn("next request");
    expect(toolNames[2]).toContain("mcp__a__late");
  });

  it("keeps the request tool list fixed during reasoning stream recovery", async () => {
    const sessionId = createSessionId("runtime-mcp-stream-recovery-fixed");
    const toolNames: string[][] = [];
    const snapshot: Record<string, McpServerToolSnapshot> = {
      a: { status: mcpStatus("connecting") },
    };
    const publishStatus = async (
      observation: any,
      requestId: string,
      event: Record<string, unknown>,
    ) =>
      observation.invocationContext?.statusSink?.publish({
        attempt: 1,
        maxAttempts: 1,
        providerId: String(observation.model.providerId),
        modelId: String(observation.model.modelId),
        requestId,
        timestamp: new Date().toISOString(),
        traceId:
          observation.invocationContext?.traceContext?.traceId ?? createTraceId("mcp-recovery"),
        transport: ModelTransportKind.Sse,
        ...event,
      });
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        modelStreaming: "on",
        mcp: {
          enabled: true,
          servers: { a: { type: "stdio", command: "node", args: ["a.js"] } },
        },
        titleGeneration: { enabled: false },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createSnapshotMcpPort(snapshot, {
          connectConfiguredServers: () => new Promise(() => {}),
        }),
        mcpStartupPolicy: "background",
        modelFactory: createTestModelFactory({
          async generateText() {
            throw new Error("streaming path expected");
          },
          async *streamText(request: any, observation: any) {
            toolNames.push(request.tools.map((tool: { name: string }) => tool.name));
            const requestId = `mcp-recovery-${toolNames.length}`;
            await publishStatus(observation, requestId, { type: "model_request_started" });
            if (toolNames.length === 1) {
              yield { type: "reasoning_start", id: "r1" };
              yield { type: "reasoning_delta", id: "r1", text: "thinking" };
              // 断流前 server 就绪；恢复请求仍沿用原请求的工具清单。
              snapshot.a = {
                status: mcpStatus("connected"),
                tools: [
                  {
                    serverName: "a",
                    toolName: "late",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
                toolsVersion: "c1:1",
              };
              const error = new Error("Provider stream failed with ECONNRESET.") as Error & {
                code?: string;
                context?: Record<string, unknown>;
              };
              error.code = "model_network_error";
              error.context = { reason: "network_error", retryable: true };
              await publishStatus(observation, requestId, {
                message: error.message,
                reason: "network_error",
                retryable: true,
                type: "model_request_failed",
              });
              throw error;
            }
            yield { type: "text_delta", text: "done" };
            yield {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("think");
    expect(toolNames).toHaveLength(2);
    expect(toolNames[1]).not.toContain("mcp__a__late");
    await runtime.executeTurn("next request");
    expect(toolNames[2]).toContain("mcp__a__late");
  });

  it.each([
    {
      label: "readOnly",
      registered: { annotations: { readOnlyHint: true } },
      live: { annotations: {} },
    },
    {
      label: "model visibility",
      registered: {},
      live: { visibility: ["app"] as ("app" | "model")[] },
    },
    {
      label: "destructive",
      registered: { annotations: {} },
      live: { annotations: { destructiveHint: true } },
    },
    {
      label: "concurrency",
      registered: { annotations: { idempotentHint: true } },
      live: { annotations: {} },
    },
  ])("rejects a call when the live $label constraint is stricter", async ({ registered, live }) => {
    const sessionId = createSessionId("runtime-mcp-stricter-live");
    const eventStore = createTestSessionEventStore();
    let mcpCallCount = 0;
    const baseTool = {
      serverName: "a",
      toolName: "lookup",
      inputSchema: { type: "object", properties: {} } as const,
    };
    const snapshot: Record<string, McpServerToolSnapshot> = {
      a: {
        status: mcpStatus("connected"),
        tools: [{ ...baseTool, ...registered }],
        toolsVersion: "c1:1",
      },
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "plan",
        mcp: {
          enabled: true,
          servers: { a: { type: "stdio", command: "node", args: ["a.js"] } },
        },
      },
      {
        eventStore,
        mcpPort: createSnapshotMcpPort(snapshot, {
          connectConfiguredServers: () => new Promise(() => {}),
          callTool: async () => {
            mcpCallCount++;
            return { content: [{ type: "text", text: "should-not-run" }] };
          },
        }),
        mcpStartupPolicy: "background",
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            if (!request.messages.some((message: any) => message.role === "tool")) {
              snapshot.a = {
                ...snapshot.a!,
                tools: [{ ...baseTool, ...live }],
                toolsVersion: "c1:2",
              };
              return toolCallResult(request, "lookup", "mcp__a__lookup");
            }
            return stopModelResult(request);
          },
        } as never),
      },
    );

    await runtime.executeTurn("lookup");
    expect(mcpCallCount).toBe(0);
    const events = await eventStore.getEvents(sessionId);
    expect(JSON.stringify(events)).toContain("stricter");
  });

  it("does not execute a read-only idempotent MCP call while the model is still streaming", async () => {
    const sessionId = createSessionId("runtime-mcp-no-stream-execution");
    let mcpCallCount = 0;
    let callsBeforeFinish: number | undefined;
    const snapshot: Record<string, McpServerToolSnapshot> = {
      a: {
        status: mcpStatus("connected"),
        tools: [
          {
            serverName: "a",
            toolName: "lookup",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true, idempotentHint: true },
          },
        ],
        toolsVersion: "c1:1",
      },
    };
    let requestCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        modelStreaming: "on",
        mcp: {
          enabled: true,
          servers: { a: { type: "stdio", command: "node", args: ["a.js"] } },
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createSnapshotMcpPort(snapshot, {
          callTool: async () => {
            mcpCallCount++;
            return { content: [{ type: "text", text: "ok" }] };
          },
        }),
        modelFactory: createTestModelFactory({
          async *streamText() {
            requestCount++;
            if (requestCount === 1) {
              yield {
                type: "tool_call",
                toolCall: { id: "lookup", name: "mcp__a__lookup", input: {} },
              };
              // MCP 必须等流结束、经执行前校验后才调用；提前执行会在这里被看到。
              await expect(waitForCondition(() => mcpCallCount > 0)).rejects.toThrow("Timed out");
              callsBeforeFinish = mcpCallCount;
              yield { type: "finish", finishReason: "tool-calls", usage: {} };
              return;
            }
            yield { type: "text_delta", text: "done" };
            yield { type: "finish", finishReason: "stop", usage: {} };
          },
        } as never),
      },
    );

    await runtime.executeTurn("lookup");
    expect(callsBeforeFinish).toBe(0);
    expect(mcpCallCount).toBe(1);
  });

  it("registers configured MCP tools before the first model request", async () => {
    const sessionId = createSessionId("runtime-mcp-tools");
    const eventStore = createTestSessionEventStore();
    let toolNames: string[] = [];
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => ({
        statuses: {
          local: {
            status: "connected",
            transport: "stdio",
            toolCount: 1,
            updatedAt: "now",
          },
        },
        tools: [
          {
            serverName: "local",
            toolName: "ping",
            inputSchema: {
              type: "object",
              properties: {},
            },
            annotations: {
              readOnlyHint: true,
            },
          },
        ],
      }),
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            toolNames = request.tools.map((tool: { name: string }) => tool.name);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("use mcp if needed");

    expect(toolNames).toContain("mcp__local__ping");
  });

  // 修复原因：Plan 曾直接放行非 destructive MCP，比 build 更宽；现在单次询问且不提供始终允许。
  it("asks once before non-read-only MCP tools run in plan mode", async () => {
    const sessionId = createSessionId("runtime-mcp-plan-mode");
    const eventStore = createTestSessionEventStore();
    let modelCallCount = 0;
    let mcpCallCount = 0;
    let admissionRefreshes = 0;
    const permissionRequests: PermissionBrokerRequest[] = [];

    const permissionBroker: PermissionBrokerPort = {
      async requestPermission(request) {
        permissionRequests.push(request);
        return { decision: "allow", reason: "Approved once" };
      },
    };

    const mcpPort = createMockMcpPort({
      refreshWorkspaceTrustAdmission: async () => {
        admissionRefreshes++;
      },
      connectConfiguredServers: async () => ({
        statuses: {
          local: {
            status: "connected",
            transport: "stdio",
            toolCount: 1,
            updatedAt: "now",
          },
        },
        tools: [
          {
            serverName: "local",
            toolName: "lookup",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
          },
        ],
      }),
      callTool: async (request) => {
        mcpCallCount++;
        return {
          content: [{ type: "text", text: `lookup:${request.arguments?.query}` }],
        };
      },
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "plan",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
        permissionBroker,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            modelCallCount++;
            if (modelCallCount === 1) {
              expect(request.tools.map((tool: { name: string }) => tool.name)).toContain(
                "mcp__local__lookup",
              );
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "I will look this up.",
                toolCalls: [
                  {
                    id: "mcp-lookup",
                    name: "mcp__local__lookup",
                    input: { query: "plan context" },
                  },
                ],
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
              };
            }

            expect(
              request.messages.some((message: any) => {
                return (
                  message.role === "tool" && String(message.content).includes("lookup:plan context")
                );
              }),
            ).toBe(true);

            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("use mcp while planning");

    expect(result.response).toBe("done");
    expect(mcpCallCount).toBe(1);
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]).toMatchObject({
      optionsPolicy: "no-always-allow",
      ruleId: "mode.plan.mcp",
      toolName: "mcp__local__lookup",
    });
    expect(modelCallCount).toBe(2);
    expect(admissionRefreshes).toBe(1);
    await runtime.executeTurn("next user prompt");
    expect(admissionRefreshes).toBe(2);
  });

  // EnterPlanMode 免确认；进入 Plan 后调用 MCP 仍须用户确认，模型不能借进入 Plan 绕过审批。
  it("does not let EnterPlanMode unlock MCP tools without approval", async () => {
    let modelCallCount = 0;
    let mcpCallCount = 0;
    const permissionRequests: PermissionBrokerRequest[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-mcp-enter-plan"),
      {
        mode: "build",
        mcp: { enabled: true, servers: { local: { type: "stdio", command: "node" } } },
      },
      {
        eventStore: createTestSessionEventStore(),
        permissionBroker: {
          async requestPermission(request) {
            permissionRequests.push(request);
            return { decision: "deny", reason: "denied in test" };
          },
        },
        mcpPort: createMockMcpPort({
          // 会话只从按 server 分组的快照读工具；没有状态的 server 不会出现在工具列表里。
          connectConfiguredServers: async () => ({
            statuses: { local: mcpStatus("connected") },
            tools: [{ serverName: "local", toolName: "js", inputSchema: { type: "object" } }],
          }),
          callTool: async () => {
            mcpCallCount++;
            return { content: [{ type: "text", text: "executed" }] };
          },
        }),
        modelFactory: createTestModelFactory({
          generateText: async () => {
            modelCallCount++;
            const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
            if (modelCallCount === 1)
              return {
                finishReason: "tool-calls",
                text: "",
                toolCalls: [{ id: "enter-plan", name: "EnterPlanMode", input: {} }],
                usage,
              };
            if (modelCallCount === 2)
              return {
                finishReason: "tool-calls",
                text: "",
                toolCalls: [{ id: "mcp-js", name: "mcp__local__js", input: { code: "x" } }],
                usage,
              };
            return { finishReason: "stop", text: "done", usage };
          },
        }),
      },
    );

    await runtime.executeTurn("plan then run");

    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]).toMatchObject({
      ruleId: "mode.plan.mcp",
      toolName: "mcp__local__js",
    });
    expect(mcpCallCount).toBe(0);
  });

  it.each([
    ["user_steer", false],
    ["user_steer", true],
    ["coordinator_steer", false],
    ["coordinator_steer", true],
  ] as const)(
    "refreshes admission only for user guide: %s, attachment: %s",
    async (inputPresentation, withAttachment) => {
      const toolStarted = deferred<void>();
      const releaseTool = deferred<void>();
      let refreshes = 0;
      let modelSteps = 0;
      const runtime = createTestAgentRuntime(
        createSessionId(`mcp-admission-${inputPresentation}`),
        {
          // 用 yolo 让 MCP 工具免审批执行；本用例只验证 admission 刷新，不验证权限。
          // 原先借 plan 放行 readOnlyHint MCP，plan 现在交给原模式判定，build 会请求审批。
          mode: "yolo",
          mcp: { enabled: true, servers: { local: { type: "stdio", command: "node" } } },
        },
        {
          eventStore: createTestSessionEventStore(),
          mcpPort: createMockMcpPort({
            refreshWorkspaceTrustAdmission: async () => {
              refreshes++;
            },
            connectConfiguredServers: async () => ({
              // 会话从连接快照读取目录；快照行由状态产生，没有状态的工具不会进入目录。
              statuses: {
                local: { status: "connected", transport: "stdio", toolCount: 1, updatedAt: "now" },
              },
              tools: [
                {
                  serverName: "local",
                  toolName: "ping",
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: true },
                },
              ],
            }),
            callTool: async () => {
              toolStarted.resolve();
              await releaseTool.promise;
              return { content: [{ type: "text", text: "pong" }] };
            },
          }),
          modelFactory: createTestModelFactory({
            generateText: async () => {
              modelSteps++;
              return {
                finishReason: modelSteps === 1 ? "tool-calls" : "stop",
                text: modelSteps === 1 ? "checking" : "done",
                toolCalls:
                  modelSteps === 1
                    ? [{ id: "ping", name: "mcp__local__ping", input: {} }]
                    : undefined,
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            },
          }),
        },
      );
      const turn = runtime.executeTurn("start");
      try {
        await toolStarted.promise;
        const result = await runtime.steerTurn({
          input: "follow up",
          delivery: "guide",
          inputPresentation,
          ...(withAttachment
            ? { attachments: [{ type: "file" as const, content: "note", path: "note.txt" }] }
            : {}),
        });
        expect(result.kind).toBe("queued");
      } finally {
        releaseTool.resolve();
      }
      await turn;
      expect(modelSteps).toBe(2);
      expect(refreshes).toBe(inputPresentation === "user_steer" ? 2 : 1);
    },
  );

  it("refreshes admission for new user input, not model-only or coordinator continuations", async () => {
    let refreshes = 0;
    let failRefresh = false;
    const runtime = createTestAgentRuntime(
      createSessionId("mcp-admission-user-boundary"),
      { mode: "build", mcp: { enabled: true, servers: {} } },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          generateText: async () => ({
            finishReason: "stop",
            text: "done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }),
        }),
        mcpPort: createMockMcpPort({
          refreshWorkspaceTrustAdmission: async () => {
            refreshes++;
            if (failRefresh) throw new Error("admission read failed");
          },
        }),
      },
    );

    await runtime.executeTurn("first user prompt");
    expect(refreshes).toBe(1);
    await runtime.executeTurn("continue goal", undefined, {
      inputSource: "goal-continuation",
      inputVisibility: "model-only",
    });
    await runtime.executeTurn("background result", undefined, {
      inputSource: "background_task",
      inputVisibility: "model-only",
    });
    await runtime.executeTurn("coordinator message", undefined, {
      inputPresentation: "coordinator_input",
    });
    expect(refreshes).toBe(1);
    await runtime.executeTurn("second user prompt");
    expect(refreshes).toBe(2);
    failRefresh = true;
    await expect(runtime.executeTurn("keep chatting on read failure")).resolves.toBeDefined();
    expect(refreshes).toBe(3);
  });

  it("denies destructive MCP tools in plan mode before calling the MCP server", async () => {
    const sessionId = createSessionId("runtime-mcp-plan-destructive");
    const eventStore = createTestSessionEventStore();
    let modelCallCount = 0;
    let mcpCallCount = 0;
    let secondRequest: any;

    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => ({
        statuses: {
          device: {
            status: "connected",
            transport: "stdio",
            toolCount: 1,
            updatedAt: "now",
          },
        },
        tools: [
          {
            serverName: "device",
            toolName: "reset",
            inputSchema: {
              type: "object",
              properties: {},
            },
            annotations: {
              destructiveHint: true,
            },
          },
        ],
      }),
      callTool: async () => {
        mcpCallCount++;
        return { content: [{ type: "text", text: "should-not-run" }] };
      },
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "plan",
        mcp: {
          enabled: true,
          servers: {
            device: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            modelCallCount++;
            if (modelCallCount === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "I will reset the device.",
                toolCalls: [
                  {
                    id: "mcp-reset",
                    name: "mcp__device__reset",
                    input: {},
                  },
                ],
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
              };
            }

            secondRequest = request;
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("do not mutate while planning");
    const toolMessage = secondRequest.messages.find((message: any) => message.role === "tool");

    expect(result.response).toBe("done");
    expect(mcpCallCount).toBe(0);
    expect(toolMessage?.content).toContain(
      "Plan mode only allows read-only, non-destructive tools",
    );
  });
});

function mcpStatus(status: McpServerStatus["status"]): McpServerStatus {
  return { status, transport: "stdio", toolCount: 0, updatedAt: "now" };
}

function createSnapshotMcpPort(
  snapshot: Record<string, McpServerToolSnapshot>,
  overrides: Partial<McpPort> = {},
): McpPort {
  return createMockMcpPort({
    getToolSnapshot: () => snapshot,
    waitForServer: async () => ({ timedOut: false }),
    ...overrides,
  });
}

function stopModelResult(request: any) {
  return {
    finishReason: "stop",
    model: request.model,
    providerMetadata: undefined,
    text: "done",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

function toolCallResult(request: any, id: string, name: string) {
  return {
    ...stopModelResult(request),
    finishReason: "tool-calls",
    text: "calling",
    toolCalls: [{ id, name, input: {} }],
  };
}

function createStopModelAdapter(toolNames: string[][] = []): never {
  return {
    async generateText(request: any) {
      toolNames.push(request.tools.map((tool: { name: string }) => tool.name));
      return stopModelResult(request);
    },
  } as never;
}

function emptyMcpSnapshot(): McpConnectionSnapshot {
  return {
    statuses: {},
    tools: [],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function waitForEvent(
  eventStore: SessionEventStorePort,
  sessionId: SessionId,
  type: string,
): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const events = await eventStore.getEvents(sessionId);
    if (events.some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for event: ${type}`);
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}
