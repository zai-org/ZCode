import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY,
  ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
  ZCODE_MCP_ERROR_PRESENTATION_META_KEY,
  type ImageProcessorPort,
  type McpPort,
  type ToolArtifactStorePort,
} from "@zcode/contracts";
import {
  resetCapturedZCodeCuaBrokerCredentialsForTest,
  ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME as ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
  sanitizeZCodeRuntimeEnv,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";
import {
  MCP_IMAGE_INLINE_BASE64_BYTES,
  MCP_IMAGE_INLINE_RAW_BYTES,
  registerMcpTools,
} from "../src/mcp/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry, ToolExecutionContext } from "../src/tool/types.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY } from "@zcode/zcode-cua/frame-contract";
import { createTestSessionEventStore } from "./test-event-store.js";

const TEST_PLUGIN_AUTHORITY = "test-plugin-authority";

function officialCuaIntegrityMeta(
  frameId: string,
  imageData: string,
  options: { height?: number; mediaType?: string; width?: number } = {},
) {
  return {
    [OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]: {
      version: 1,
      frame_id: frameId,
      width: options.width ?? 1,
      height: options.height ?? 1,
      media_type: options.mediaType ?? "image/png",
      sha256: createHash("sha256").update(Buffer.from(imageData, "base64")).digest("hex"),
    },
  };
}

function exactRasterInspector(width: number, height: number): ImageProcessorPort {
  return {
    resizeToFit: async (request) => ({
      data: request.data,
      mediaType: request.mediaType,
      originalHeight: height,
      originalWidth: width,
      height,
      resized: false,
      width,
    }),
    prepareForModel: async () => {
      throw new Error("official CUA frame must not be transcoded");
    },
  };
}

function cuaActionReceipt(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action_receipt: {
      schema_version: "zcode-cua-action-receipt-v1",
      action_sent: true,
      dispatch_status: "accepted",
      retry_action: false,
      ...overrides,
    },
  });
}

// computeOfficialCuaServerNames 只信任本进程私有捕获的 authority；测试必须走与生产同一条
// capture 路径（sanitize 时捕获完整凭据组）来播种，绝不能直接改写内部状态。
function seedCapturedBrokerCredentials(): void {
  sanitizeZCodeRuntimeEnv({
    ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/tmp/zcode-cua-test.sock",
    ZCODE_CUA_PERMISSION_BROKER_TOKEN: "test-broker-token",
    [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: TEST_PLUGIN_AUTHORITY,
  });
}

describe("MCP tool bridge", () => {
  afterEach(() => {
    resetCapturedZCodeCuaBrokerCredentialsForTest();
  });

  it("marks only authority-verified official CUA entries with the project capability group", () => {
    const registry = createToolRegistry();
    registerMcpTools(
      registry,
      createMockMcpPort(),
      [
        {
          inputSchema: { type: "object" },
          serverName: "trusted-computer-use",
          toolName: "left_click",
        },
        {
          inputSchema: { type: "object" },
          serverName: "lookalike-computer-use",
          toolName: "left_click",
        },
      ],
      {
        officialCuaServerNames: new Set(["trusted-computer-use"]),
      },
    );

    const trusted = registry.get("mcp__trusted-computer-use__left_click") as
      | (ToolEntry & { permissionCapabilityGroup?: string })
      | undefined;
    const lookalike = registry.get("mcp__lookalike-computer-use__left_click") as
      | (ToolEntry & { permissionCapabilityGroup?: string })
      | undefined;

    expect(trusted?.permissionCapabilityGroup).toBe("official_cua");
    expect(trusted?.modelContentProtection).toBe("official_cua_frame_v1");
    expect(trusted).not.toHaveProperty("preserveStructuredModelContent");
    expect(lookalike?.permissionCapabilityGroup).toBeUndefined();
    expect(lookalike?.modelContentProtection).toBeUndefined();
  });

  it("registers the provider alias during runtime startup for the official CUA plugin", async () => {
    seedCapturedBrokerCredentials();
    const sessionId = createSessionId("official-cua-runtime-alias");
    const traceContext = createRootTraceContext({ sessionId });
    const callTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    const mcpPort = createMockMcpPort({
      callTool,
      connectConfiguredServers: async () => ({
        statuses: {},
        tools: [
          {
            serverName: ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
            toolName: "open_application",
            // adapter 会先按 namespaced serverName 生成这个内部描述符名；core 再把可信官方
            // CUA 投影成模型约定的 computer-use 主名，调用路由仍保留原 serverName。
            name: "mcp__plugin_zcode-cua_computer-use__open_application",
          },
        ],
      }),
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mcp: {
          servers: {
            [ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME]: {
              type: "stdio",
              command: "zcode-cua",
              env: {
                [ZCODE_PLUGIN_ID_ENV_KEY]: ZCODE_CUA_OFFICIAL_PLUGIN_ID,
                [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: TEST_PLUGIN_AUTHORITY,
              },
            },
          },
          trustedOfficialCuaServerNames: [ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME],
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort,
        traceContext,
      },
    );

    await (
      runtime as unknown as {
        initializeMcp(trace: typeof traceContext): Promise<void>;
      }
    ).initializeMcp(traceContext);

    const canonical = runtime.getToolRegistry().get("mcp__computer-use__open_application");
    const alias = runtime.getToolRegistry().get("mcp__computer_use__open_application");
    expect(canonical).toBeDefined();
    expect(alias).toBe(canonical);
    expect(
      runtime.getToolRegistry().get("mcp__plugin_zcode-cua_computer-use__open_application"),
    ).toBeUndefined();

    await alias?.handler({ app: { name: "notepad.exe" } }, createToolContext());
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
        toolName: "open_application",
      }),
      expect.anything(),
    );
  });

  it("does not trust an official-looking CUA server without the resolver plugin identity", async () => {
    seedCapturedBrokerCredentials();
    const sessionId = createSessionId("untrusted-cua-runtime-alias");
    const traceContext = createRootTraceContext({ sessionId });
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mcp: {
          servers: {
            [ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME]: {
              type: "stdio",
              command: "zcode-cua",
            },
          },
          trustedOfficialCuaServerNames: [ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME],
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createMockMcpPort({
          connectConfiguredServers: async () => ({
            statuses: {},
            tools: [
              {
                serverName: ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
                toolName: "open_application",
                name: "mcp__plugin_zcode-cua_computer-use__open_application",
              },
            ],
          }),
        }),
        traceContext,
      },
    );

    await (
      runtime as unknown as {
        initializeMcp(trace: typeof traceContext): Promise<void>;
      }
    ).initializeMcp(traceContext);

    expect(runtime.getToolRegistry().get("mcp__computer_use__open_application")).toBeUndefined();
    expect(runtime.getToolRegistry().get("mcp__computer-use__open_application")).toBeUndefined();
    expect(
      runtime.getToolRegistry().get("mcp__plugin_zcode-cua_computer-use__open_application"),
    ).toBeDefined();
  });

  it("classifies the reserved node_repl js tool as high-risk system execution", () => {
    const registry = createToolRegistry();
    registerMcpTools(registry, createMockMcpPort(), [
      {
        description: "Run JavaScript",
        inputSchema: { type: "object" },
        serverName: "node_repl",
        toolName: "js",
      },
    ]);

    expect(registry.get("mcp__node_repl__js")?.metadata).toMatchObject({
      needsApproval: true,
      riskLevel: "high",
      sideEffectScope: "system",
    });
    expect(registry.get("mcp__node_repl__js")?.resultBudget).toMatchObject({
      maxModelBytes: 64 * 1024,
      strategy: "artifact",
      preview: { direction: "tail" },
    });
  });

  it("accepts the underscore server spelling only for an authority-verified official CUA tool", async () => {
    const registry = createToolRegistry();
    const calls: Array<{ serverName: string; toolName: string }> = [];
    const mcpPort = createMockMcpPort({
      callTool: async (request) => {
        calls.push({
          serverName: request.serverName,
          toolName: request.toolName,
        });
        return { content: [{ type: "text", text: "ok" }] };
      },
    });

    registerMcpTools(
      registry,
      mcpPort,
      [
        {
          serverName: ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
          toolName: "open_application",
          name: "mcp__computer-use__open_application",
        },
      ],
      {
        officialCuaServerNames: new Set([ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME]),
      },
    );

    const canonical = registry.get("mcp__computer-use__open_application");
    const alias = registry.get("mcp__computer_use__open_application");
    expect(alias).toBe(canonical);
    expect(registry.list()).toEqual(["mcp__computer-use__open_application"]);
    expect(registry.toContracts().map((contract) => contract.name)).toEqual([
      "mcp__computer-use__open_application",
    ]);

    await alias?.handler({ app: { name: "notepad.exe" } }, createToolContext());
    expect(calls).toEqual([
      {
        serverName: ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
        toolName: "open_application",
      },
    ]);
  });

  it("does not add the underscore server spelling for an unverified MCP server", () => {
    const registry = createToolRegistry();

    registerMcpTools(registry, createMockMcpPort(), [
      {
        serverName: "computer-use",
        toolName: "open_application",
        name: "mcp__computer-use__open_application",
      },
    ]);

    expect(registry.get("mcp__computer-use__open_application")).toBeDefined();
    expect(registry.get("mcp__computer_use__open_application")).toBeUndefined();
  });

  it("keeps an existing namespaced deny rule effective after official CUA name projection", () => {
    const registry = createToolRegistry();
    const namespacedName = "mcp__plugin_zcode-cua_computer-use__open_application";

    const registered = registerMcpTools(
      registry,
      createMockMcpPort(),
      [
        {
          serverName: ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
          toolName: "open_application",
          name: namespacedName,
        },
      ],
      {
        disallowedTools: [namespacedName],
        officialCuaServerNames: new Set([ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME]),
      },
    );

    expect(registered).toEqual([]);
    expect(registry.get("mcp__computer-use__open_application")).toBeUndefined();
    expect(registry.get("mcp__computer_use__open_application")).toBeUndefined();
  });

  it("keeps an existing namespaced allow rule effective after official CUA name projection", () => {
    const registry = createToolRegistry();
    const namespacedName = "mcp__plugin_zcode-cua_computer-use__open_application";

    const registered = registerMcpTools(
      registry,
      createMockMcpPort(),
      [
        {
          serverName: ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
          toolName: "open_application",
          name: namespacedName,
        },
      ],
      {
        allowedTools: [namespacedName],
        officialCuaServerNames: new Set([ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME]),
      },
    );

    expect(registered).toEqual(["mcp__computer-use__open_application"]);
    expect(registry.get("mcp__computer_use__open_application")).toBe(
      registry.get("mcp__computer-use__open_application"),
    );
  });

  it("registers MCP descriptors as model-facing tools and calls through McpPort", async () => {
    const registry = createToolRegistry();
    const calls: Array<{
      serverName: string;
      toolName: string;
      arguments?: Record<string, unknown>;
      timeoutMs?: number;
    }> = [];
    const mcpPort: McpPort = {
      connectConfiguredServers: async () => ({ statuses: {}, tools: [] }),
      connectServer: async () => ({
        status: "connected",
        transport: "stdio",
        toolCount: 1,
        updatedAt: "now",
      }),
      disconnectServer: async () => undefined,
      status: async () => ({}),
      listTools: async () => [],
      callTool: async (request, options) => {
        calls.push({
          serverName: request.serverName,
          toolName: request.toolName,
          arguments: request.arguments,
          timeoutMs: options?.timeoutMs,
        });
        return {
          content: [{ type: "text", text: `hello ${request.arguments?.name}` }],
        };
      },
      close: async () => {},
    };

    const registered = registerMcpTools(registry, mcpPort, [
      {
        serverName: "local server",
        toolName: "say-hi",
        description: "Say hi",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
        },
        timeoutMs: 900_000,
        annotations: {
          readOnlyHint: true,
        },
      },
    ]);

    expect(registered).toEqual(["mcp__local_server__say-hi"]);
    const entry = registry.get("mcp__local_server__say-hi");
    expect(entry?.metadata).toMatchObject({
      description: "Say hi",
      readOnly: true,
      sideEffectScope: "network",
      needsApproval: true,
      timeoutMs: 900_000,
    });
    expect(entry?.timeout.defaultMs).toBe(900_000);

    // description 必须透传到 model-facing contract，否则 MCP 工具在模型侧没有可用描述
    const contract = registry.toContracts().find((c) => c.name === "mcp__local_server__say-hi");
    expect(contract?.description).toBe("Say hi");

    const output = await entry?.handler({ name: "Ada" }, createToolContext());

    expect(calls).toEqual([
      {
        serverName: "local server",
        toolName: "say-hi",
        arguments: { name: "Ada" },
        timeoutMs: 900_000,
      },
    ]);
    expect(output).toEqual({
      content: [{ type: "text", text: "hello Ada" }],
    });
    expect(entry?.formatModelContent?.(output)).toBe("hello Ada");
  });

  it("marks MCP calls from a subagent runtime", async () => {
    const registry = createToolRegistry();
    const callTool = vi.fn(async () => ({ content: [] }));
    registerMcpTools(registry, createMockMcpPort({ callTool }), [
      {
        serverName: "node_repl",
        toolName: "js",
        inputSchema: { type: "object" },
      },
    ]);

    await registry
      .get("mcp__node_repl__js")
      ?.handler({}, createToolContext({ runtimeScope: "subagent" }));

    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeScope: "subagent" }),
      expect.anything(),
    );
  });

  it("uses the session workspace key instead of the working directory (managed worktree)", async () => {
    const registry = createToolRegistry();
    const callTool = vi.fn(async () => ({ content: [] }));
    registerMcpTools(registry, createMockMcpPort({ callTool }), [
      { serverName: "node_repl", toolName: "js", inputSchema: { type: "object" } },
    ]);

    // 受管 worktree 会话：工作目录是 worktree，会话 key 是项目（docs/git/worktree.md §9.3）。
    await registry.get("mcp__node_repl__js")?.handler(
      {},
      createToolContext({
        workingDirectory: "/data/.zcode/worktrees/3f2a/repo",
        workspaceKey: "/projects/repo",
      }),
    );
    await registry
      .get("mcp__node_repl__js")
      ?.handler({}, createToolContext({ workingDirectory: "/projects/plain" }));

    expect(callTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceKey: "/projects/repo",
        workspacePath: "/data/.zcode/worktrees/3f2a/repo",
      }),
      expect.anything(),
    );
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workspaceKey: "/projects/plain" }),
      expect.anything(),
    );
  });

  it("removes disallowed MCP tools from the registry", () => {
    const registry = createToolRegistry();
    const mcpPort = createMockMcpPort();

    const registered = registerMcpTools(
      registry,
      mcpPort,
      [
        {
          serverName: "local server",
          toolName: "say-hi",
          description: "Say hi",
          inputSchema: { type: "object" },
        },
        {
          serverName: "local server",
          toolName: "say-bye",
          description: "Say bye",
          inputSchema: { type: "object" },
        },
      ],
      {
        disallowedTools: ["mcp__local_server__say-hi(*)"],
      },
    );

    expect(registered).toEqual(["mcp__local_server__say-bye"]);
    expect(registry.has("mcp__local_server__say-hi")).toBe(false);
    expect(registry.has("mcp__local_server__say-bye")).toBe(true);
  });

  it("does not register explicitly disallowed MCP tools", () => {
    const registry = createToolRegistry();
    const mcpPort = createMockMcpPort();

    const registered = registerMcpTools(
      registry,
      mcpPort,
      [
        {
          serverName: "zcode-cua",
          toolName: "get_app_state",
          inputSchema: { type: "object", properties: {} },
        },
        {
          serverName: "zcode-cua",
          toolName: "left_click",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      { disallowedTools: ["mcp__zcode-cua__left_click"] },
    );

    expect(registered).toEqual(["mcp__zcode-cua__get_app_state"]);
    expect(registry.has("mcp__zcode-cua__get_app_state")).toBe(true);
    expect(registry.has("mcp__zcode-cua__left_click")).toBe(false);
  });

  it("requires a user title for CUA app observation and strips it before MCP dispatch", async () => {
    const registry = createToolRegistry();
    const callTool = vi.fn(async () => ({ content: [] }));
    registerMcpTools(registry, createMockMcpPort({ callTool }), [
      {
        serverName: "plugin:computer-use:computer-use",
        toolName: "get_app_state",
        inputSchema: {
          type: "object",
          required: ["app_ref"],
          properties: {
            app_ref: { type: "object" },
            detail: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    ]);

    const entry = registry.get("mcp__plugin_computer-use_computer-use__get_app_state");
    expect(entry?.inputSchema).toMatchObject({
      required: ["app_ref", "title"],
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 120,
        },
      },
      additionalProperties: false,
    });

    await entry?.handler(
      {
        app_ref: { pid: 42 },
        detail: "compact",
        title: "检查设置窗口中的隐私权限",
      },
      createToolContext(),
    );

    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: {
          app_ref: { pid: 42 },
          detail: "compact",
        },
      }),
      expect.anything(),
    );
  });

  it("preserves the official CUA element-vs-image target boundary for the model", () => {
    const registry = createToolRegistry();
    const target = {
      description:
        "Use an element target only for an accessibility-tree element. When the action is derived from a delivered image, use only its frame-bound coordinate target.",
      anyOf: [
        {
          type: "object",
          required: ["type", "state_id", "index"],
          properties: {
            type: { const: "element" },
            state_id: { type: "string" },
            index: { type: "integer" },
          },
          additionalProperties: false,
        },
        {
          type: "object",
          required: ["type", "frame_id", "x", "y"],
          properties: {
            type: { const: "coordinate" },
            frame_id: { type: "string", minLength: 1 },
            x: { type: "integer", minimum: 0 },
            y: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
      ],
    };
    registerMcpTools(registry, createMockMcpPort(), [
      {
        serverName: "plugin:computer-use:computer-use",
        toolName: "left_click",
        inputSchema: {
          type: "object",
          required: ["target"],
          properties: { target },
          additionalProperties: false,
        },
      },
    ]);

    const modelTarget = registry.get("mcp__plugin_computer-use_computer-use__left_click")
      ?.inputSchema.properties?.target as typeof target;
    expect(modelTarget).toEqual(target);
  });

  it("does not add a title contract to unrelated get_app_state MCP tools", () => {
    const registry = createToolRegistry();
    registerMcpTools(registry, createMockMcpPort(), [
      {
        serverName: "device-inspector",
        toolName: "get_app_state",
        inputSchema: {
          type: "object",
          properties: { app_id: { type: "string" } },
        },
      },
    ]);

    const schema = registry.get("mcp__device-inspector__get_app_state")?.inputSchema;
    expect(schema).not.toHaveProperty("properties.title");
    expect(schema).not.toHaveProperty("required");
  });

  it.each(["computer-use", "zcode-cua"])(
    "recognizes the %s CUA server identity for the title contract",
    (serverName) => {
      const registry = createToolRegistry();
      registerMcpTools(registry, createMockMcpPort(), [
        {
          serverName,
          toolName: "get_app_state",
          inputSchema: { type: "object", properties: {} },
        },
      ]);

      expect(registry.get(`mcp__${serverName}__get_app_state`)?.inputSchema).toMatchObject({
        required: ["title"],
        properties: { title: { type: "string" } },
      });
    },
  );

  it("maps destructive MCP annotations into tool metadata", () => {
    const registry = createToolRegistry();
    const mcpPort = createMockMcpPort();

    registerMcpTools(registry, mcpPort, [
      {
        serverName: "device",
        toolName: "reset",
        description: "Reset a device",
        inputSchema: { type: "object" },
        annotations: {
          destructiveHint: true,
        },
      },
    ]);

    const entry = registry.get("mcp__device__reset");

    expect(entry?.metadata).toMatchObject({
      destructive: true,
      readOnly: false,
      riskLevel: "high",
      sideEffectScope: "network",
    });
    expect(entry?.permission).toMatchObject({
      permission: "mcp",
      riskLevel: "high",
      sideEffectScope: "network",
    });
  });

  it("honors the structured message-only MCP error presentation", () => {
    const registry = createToolRegistry();
    registerMcpTools(registry, createMockMcpPort(), [
      {
        serverName: "device",
        toolName: "validate",
        inputSchema: { type: "object" },
      },
    ]);

    const entry = registry.get("mcp__device__validate");
    const modelContent = entry?.formatModelContent?.({
      content: [
        {
          type: "text",
          text: "browser tab 'iab-tab:test' returned an invalid viewport",
        },
      ],
      isError: true,
      _meta: {
        [ZCODE_MCP_ERROR_PRESENTATION_META_KEY]: ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
      },
    });

    expect(modelContent).toBe("browser tab 'iab-tab:test' returned an invalid viewport");
  });

  it("projects non-object MCP 2026-07-28 structured content", () => {
    const registry = createToolRegistry();
    registerMcpTools(registry, createMockMcpPort(), [
      {
        serverName: "modern",
        toolName: "structured",
        inputSchema: { type: "object" },
      },
    ]);

    const entry = registry.get("mcp__modern__structured");
    expect(entry?.outputSchema.properties?.structuredContent).toEqual({});
    expect(
      entry?.formatModelContent?.({
        content: [],
        structuredContent: ["alpha", { beta: true }],
      }),
    ).toBe('Structured content:\n[\n  "alpha",\n  {\n    "beta": true\n  }\n]');
  });

  it("preserves multiline MCP error details when they are not stack frames", () => {
    const registry = createToolRegistry();
    registerMcpTools(registry, createMockMcpPort(), [
      {
        serverName: "device",
        toolName: "validate",
        inputSchema: { type: "object" },
      },
    ]);

    const entry = registry.get("mcp__device__validate");
    const modelContent = entry?.formatModelContent?.({
      content: [
        {
          type: "text",
          text: "Invalid input\n- width is required\n- height is required",
        },
      ],
      isError: true,
      _meta: {
        [ZCODE_MCP_ERROR_PRESENTATION_META_KEY]: ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
      },
    });

    expect(modelContent).toBe("Invalid input\n- width is required\n- height is required");
  });

  it("keeps the existing error projection without message-only metadata", () => {
    const registry = createToolRegistry();
    registerMcpTools(registry, createMockMcpPort(), [
      {
        serverName: "device",
        toolName: "validate",
        inputSchema: { type: "object" },
      },
    ]);

    const entry = registry.get("mcp__device__validate");
    const errorText = [
      "ValidationError: Invalid input",
      "    at validate (file:///plugins/device.mjs:12:3)",
    ].join("\n");
    const modelContent = entry?.formatModelContent?.({
      content: [{ type: "text", text: errorText }],
      isError: true,
    });

    expect(modelContent).toBe(`MCP tool returned an error:\n${errorText}`);
  });

  it("projects MCP image content as model-visible image blocks", () => {
    const registry = createToolRegistry();
    const mcpPort = createMockMcpPort();

    registerMcpTools(registry, mcpPort, [
      {
        serverName: "ios_simulator",
        toolName: "ios_screenshot",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ]);

    const entry = registry.get("mcp__ios_simulator__ios_screenshot");
    const modelContent = entry?.formatModelContent?.({
      content: [
        { type: "text", text: '{"path":"screenshots/latest.png"}' },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    });

    expect(modelContent).toEqual([
      { type: "text", text: '{"path":"screenshots/latest.png"}' },
      {
        type: "image",
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,aGVsbG8=",
        source: {
          id: "mcp-image",
          kind: "inline",
          mimeType: "image/png",
          placeholder: "MCP image",
          sizeBytes: 5,
        },
      },
    ]);
  });

  it("preserves an authority-verified CUA frame image-first pair byte-for-byte", async () => {
    const registry = createToolRegistry();
    const imageData =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const result = {
      content: [
        { type: "image" as const, data: imageData, mimeType: "image/png" },
        {
          type: "text" as const,
          text: JSON.stringify({
            image_ref: {
              actionable: true,
              frame_id: "frame_exact_001",
              height: 1,
              width: 1,
            },
          }),
        },
      ],
      _meta: officialCuaIntegrityMeta("frame_exact_001", imageData),
    };
    const callTool = vi.fn(async () => result);
    registerMcpTools(
      registry,
      createMockMcpPort({ callTool }),
      [
        {
          serverName: ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
          toolName: "get_app_state",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      { officialCuaServerNames: new Set([ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME]) },
    );

    const entry = registry.get("mcp__computer-use__get_app_state");
    const output = await entry?.handler(
      { title: "读取精确坐标图" },
      createToolContext({
        imageProcessorPort: exactRasterInspector(1, 1),
      }),
    );

    expect(output).toBe(result);
    expect(output?.content[0]).toEqual({
      type: "image",
      data: imageData,
      mimeType: "image/png",
    });
    expect(entry?.resultBudget).toMatchObject({
      maxInlineBytes: 256 * 1024,
      maxModelBytes: 256 * 1024,
    });
    expect(entry?.modelContentProtection).toBe("official_cua_frame_v1");
    expect(entry?.formatModelContent?.(output)).toEqual([
      expect.objectContaining({
        type: "image",
        dataUrl: `data:image/png;base64,${imageData}`,
      }),
      {
        type: "text",
        text: result.content[1].text,
      },
    ]);
  });

  it("projects an official CUA action receipt through the generic MCP formatter", async () => {
    const result = {
      content: [
        { type: "text" as const, text: "Dispatched AXPress. (receipt below)" },
        { type: "text" as const, text: cuaActionReceipt() },
      ],
      structuredContent: undefined,
      isError: undefined,
      _meta: undefined,
    };
    const registry = createToolRegistry();
    registerMcpTools(
      registry,
      createMockMcpPort({ callTool: async () => result }),
      [
        {
          serverName: ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
          toolName: "perform_action",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      { officialCuaServerNames: new Set([ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME]) },
    );

    const entry = registry.get("mcp__computer-use__perform_action");
    const output = await entry?.handler({}, createToolContext());

    expect(output).toBe(result);
    expect(entry?.formatModelContent?.(output)).toBe(
      `${result.content[0].text}\n\n${result.content[1].text}`,
    );
  });

  it("does not synthesize refresh_required when a receipt has no post-state", async () => {
    const receipt = cuaActionReceipt();
    const registry = createToolRegistry();
    registerMcpTools(
      registry,
      createMockMcpPort({
        callTool: async () => ({
          content: [
            { type: "text", text: "state_id=s-9 app=Wrong" },
            { type: "text", text: receipt },
          ],
        }),
      }),
      [
        {
          serverName: ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
          toolName: "perform_action",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      { officialCuaServerNames: new Set([ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME]) },
    );

    const output = await registry
      .get("mcp__computer-use__perform_action")
      ?.handler({}, createToolContext());

    expect(output?.isError).not.toBe(true);
    expect(output?.content).toEqual([
      { type: "text", text: "state_id=s-9 app=Wrong" },
      { type: "text", text: receipt },
    ]);
    expect(JSON.stringify(output)).not.toContain("refresh_required");
  });

  it("keeps official CUA receipt normalization out of the bridge budget path", async () => {
    const registry = createToolRegistry();
    const oversizedState = `state_id=s-2 app=Example\n${"tree-node ".repeat(30_000)}`;
    const receipt = cuaActionReceipt();
    registerMcpTools(
      registry,
      createMockMcpPort({
        callTool: async () => ({
          content: [
            { type: "text", text: oversizedState },
            { type: "text", text: receipt },
          ],
        }),
      }),
      [
        {
          serverName: ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
          toolName: "perform_action",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      { officialCuaServerNames: new Set([ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME]) },
    );

    const output = await registry
      .get("mcp__computer-use__perform_action")
      ?.handler({}, createToolContext());

    expect(Buffer.byteLength(oversizedState, "utf8")).toBeGreaterThan(256 * 1024);
    expect(output?.isError).not.toBe(true);
    expect(output?.content).toEqual([
      { type: "text", text: oversizedState },
      { type: "text", text: receipt },
    ]);
  });

  it("keeps structured content as ordinary MCP result text for official CUA receipts", async () => {
    const registry = createToolRegistry();
    registerMcpTools(
      registry,
      createMockMcpPort({
        callTool: async () => ({
          content: [{ type: "text", text: cuaActionReceipt() }],
          structuredContent: { diagnostic: "receipt-only" },
        }),
      }),
      [
        {
          serverName: ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
          toolName: "perform_action",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      { officialCuaServerNames: new Set([ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME]) },
    );

    const output = await registry
      .get("mcp__computer-use__perform_action")
      ?.handler({}, createToolContext());
    const entry = registry.get("mcp__computer-use__perform_action");
    const modelContent = entry?.formatModelContent?.(output);

    expect(output?.isError).not.toBe(true);
    expect(modelContent).toContain("Structured content:");
    expect(modelContent).toContain("receipt-only");
    expect(modelContent).not.toContain("refresh_required");
  });

  it("preserves producer possibly-sent receipts without inventing a post-state", async () => {
    const result = {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            message: "The action may have been sent; refresh first.",
            action_receipt: JSON.parse(
              cuaActionReceipt({
                dispatch_status: "possibly_sent",
              }),
            ).action_receipt,
            state: null,
          }),
        },
      ],
    };
    const registry = createToolRegistry();
    registerMcpTools(
      registry,
      createMockMcpPort({ callTool: async () => result }),
      [
        {
          serverName: ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
          toolName: "perform_action",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      { officialCuaServerNames: new Set([ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME]) },
    );

    const entry = registry.get("mcp__computer-use__perform_action");
    const output = await entry?.handler({}, createToolContext());

    expect(output).toBe(result);
    expect(entry?.formatModelContent?.(output)).toEqual(result.content[0].text);
  });

  it("preserves a large JSON-only result from an official CUA tool", async () => {
    const text = JSON.stringify(
      Array.from({ length: 160 }, (_, index) => ({
        bundle_id: `dev.example.application.${index}`,
        name: `Application ${index}`,
        pid: 10_000 + index,
      })),
    );
    expect(text.length).toBeGreaterThan(1024);
    const result = { content: [{ type: "text" as const, text }] };
    const registry = createToolRegistry();
    registerMcpTools(
      registry,
      createMockMcpPort({ callTool: async () => result }),
      [
        {
          serverName: ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
          toolName: "list_apps",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      { officialCuaServerNames: new Set([ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME]) },
    );

    const output = await registry
      .get("mcp__computer-use__list_apps")
      ?.handler({}, createToolContext());

    expect(output).toBe(result);
  });

  it("persists the original explicit browser screenshot while compressing its model image", async () => {
    const registry = createToolRegistry();
    const originalImage = Buffer.alloc(MCP_IMAGE_INLINE_RAW_BYTES + 1, 7);
    const compressedImage = Buffer.from("compressed-browser-screenshot");
    const mcpPort = createMockMcpPort({
      callTool: async () => ({
        // node_repl 现在把 image 排在 text 之前（见 node-repl-host/src/result.ts），
        // screenshot 下标因此直接是 content 下标。
        content: [
          {
            type: "image",
            data: originalImage.toString("base64"),
            mimeType: "image/png",
          },
          { type: "text", text: "(no output)" },
        ],
        _meta: {
          [ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY]: [0],
        },
      }),
    });
    const artifactWrites: Uint8Array[] = [];
    const artifactStore: ToolArtifactStorePort = {
      writeToolResultArtifact: async () => {
        throw new Error("unexpected text artifact write");
      },
      writeToolResultBinaryArtifact: async (request) => {
        artifactWrites.push(request.content);
        return {
          id: "explicit-browser-shot",
          uri: "zcode-artifact://session/explicit-browser-shot",
          path: "/tmp/explicit-browser-shot.png",
          bytes: request.content.byteLength,
          contentType: request.contentType,
          createdAt: new Date("2026-07-20T00:00:00.000Z"),
        };
      },
      readToolResultArtifact: async () => {
        throw new Error("not used");
      },
    };
    const prepareRequests: Parameters<ImageProcessorPort["prepareForModel"]>[0][] = [];
    const imageProcessorPort: ImageProcessorPort = {
      resizeToFit: async () => {
        throw new Error("unexpected resizeToFit call");
      },
      prepareForModel: async (request) => {
        prepareRequests.push(request);
        return {
          compressed: true,
          data: compressedImage,
          height: 900,
          mediaType: "image/jpeg",
          originalHeight: 3218,
          originalSizeBytes: originalImage.byteLength,
          originalWidth: 942,
          resized: true,
          strategy: "jpeg-quality",
          transformedSizeBytes: compressedImage.byteLength,
          width: 263,
        };
      },
    };

    registerMcpTools(registry, mcpPort, [
      {
        serverName: "node_repl",
        toolName: "js",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const entry = registry.get("mcp__node_repl__js");
    const output = await entry?.handler(
      {},
      createToolContext({ artifactStore, imageProcessorPort }),
    );
    const modelContent = entry?.formatModelContent?.(output);

    expect(prepareRequests).toHaveLength(1);
    expect(prepareRequests[0]).toMatchObject({
      maxBase64Bytes: MCP_IMAGE_INLINE_BASE64_BYTES,
      maxDimension: 2000,
      maxRawBytes: MCP_IMAGE_INLINE_RAW_BYTES,
      mediaType: "image/png",
    });
    // artifact 提示文本必须排在 image 之后：它是为 browser screenshot 现场插入的，
    // 插在 image 前会让 tool_result.content 重新变成 text-first，图又会被网关丢掉。
    expect(modelContent).toEqual([
      {
        type: "image",
        dataUrl: `data:image/jpeg;base64,${compressedImage.toString("base64")}`,
        mediaType: "image/jpeg",
        source: expect.objectContaining({
          id: "mcp-image",
          kind: "inline",
          mimeType: "image/jpeg",
        }),
      },
      {
        type: "text",
        text: "Browser screenshot saved to: /tmp/explicit-browser-shot.png",
      },
      { type: "text", text: "(no output)" },
    ]);
    expect(artifactWrites).toHaveLength(1);
    expect(Buffer.from(artifactWrites[0] ?? [])).toEqual(originalImage);
    expect(JSON.stringify(modelContent)).not.toContain(originalImage.toString("base64"));
  });

  it("does not persist ordinary nodeRepl.emitImage content without a screenshot marker", async () => {
    const registry = createToolRegistry();
    const writeToolResultBinaryArtifact = vi.fn(
      async (
        request: Parameters<NonNullable<ToolArtifactStorePort["writeToolResultBinaryArtifact"]>>[0],
      ) => ({
        id: "unexpected",
        uri: "zcode-artifact://session/unexpected",
        path: "/tmp/unexpected.png",
        bytes: request.content.byteLength,
        contentType: request.contentType,
        createdAt: new Date("2026-07-20T00:00:00.000Z"),
      }),
    );
    const artifactStore: ToolArtifactStorePort = {
      writeToolResultArtifact: async () => {
        throw new Error("not used");
      },
      writeToolResultBinaryArtifact,
      readToolResultArtifact: async () => {
        throw new Error("not used");
      },
    };
    const mcpPort = createMockMcpPort({
      callTool: async () => ({
        content: [{ type: "image", data: "AQID", mimeType: "image/png" }],
      }),
    });
    registerMcpTools(registry, mcpPort, [
      {
        serverName: "node_repl",
        toolName: "js",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const entry = registry.get("mcp__node_repl__js");
    const output = await entry?.handler({}, createToolContext({ artifactStore }));

    expect(writeToolResultBinaryArtifact).not.toHaveBeenCalled();
    expect(entry?.formatModelContent?.(output)).toEqual([
      expect.objectContaining({ type: "image", mediaType: "image/png" }),
    ]);
  });

  it("falls back to the existing oversized-image policy when node_repl compression fails", async () => {
    const registry = createToolRegistry();
    const originalImage = Buffer.alloc(MCP_IMAGE_INLINE_RAW_BYTES + 1, 13);
    const mcpPort = createMockMcpPort({
      callTool: async () => ({
        content: [
          {
            type: "image",
            data: originalImage.toString("base64"),
            mimeType: "image/png",
          },
        ],
      }),
    });
    const imageProcessorPort: ImageProcessorPort = {
      resizeToFit: async () => {
        throw new Error("unexpected resizeToFit call");
      },
      prepareForModel: async () => {
        throw new Error("decode failed");
      },
    };

    registerMcpTools(registry, mcpPort, [
      {
        serverName: "node_repl",
        toolName: "js",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const entry = registry.get("mcp__node_repl__js");
    const output = await entry?.handler({}, createToolContext({ imageProcessorPort }));
    const modelContent = entry?.formatModelContent?.(output);

    expect(modelContent).toContain("MCP image content omitted");
    expect(modelContent).toContain("No artifact store is configured");
    expect(JSON.stringify(modelContent)).not.toContain(originalImage.toString("base64"));
  });

  it("rejects node_repl compression output that still exceeds the inline budget", async () => {
    const registry = createToolRegistry();
    const originalImage = Buffer.alloc(MCP_IMAGE_INLINE_RAW_BYTES + 1, 17);
    const mcpPort = createMockMcpPort({
      callTool: async () => ({
        content: [
          {
            type: "image",
            data: originalImage.toString("base64"),
            mimeType: "image/png",
          },
        ],
      }),
    });
    const imageProcessorPort: ImageProcessorPort = {
      resizeToFit: async () => {
        throw new Error("unexpected resizeToFit call");
      },
      prepareForModel: async () => ({
        compressed: true,
        data: Buffer.alloc(MCP_IMAGE_INLINE_RAW_BYTES + 1, 19),
        mediaType: "image/jpeg",
        originalSizeBytes: originalImage.byteLength,
        resized: false,
        strategy: "jpeg-quality",
        transformedSizeBytes: MCP_IMAGE_INLINE_RAW_BYTES + 1,
      }),
    };

    registerMcpTools(registry, mcpPort, [
      {
        serverName: "node_repl",
        toolName: "js",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const entry = registry.get("mcp__node_repl__js");
    const output = await entry?.handler({}, createToolContext({ imageProcessorPort }));
    const modelContent = entry?.formatModelContent?.(output);

    expect(modelContent).toContain("MCP image content omitted");
    expect(modelContent).toContain("No artifact store is configured");
    expect(JSON.stringify(modelContent)).not.toContain(originalImage.toString("base64"));
  });

  it("stores oversized MCP image content before projecting model-visible output", async () => {
    const registry = createToolRegistry();
    const originalImage = Buffer.alloc(MCP_IMAGE_INLINE_BASE64_BYTES, 7);
    const largeBase64 = originalImage.toString("base64");
    const mcpPort = createMockMcpPort({
      callTool: async () => ({
        content: [
          { type: "text", text: '{"path":"screenshots/latest.png"}' },
          { type: "image", data: largeBase64, mimeType: "image/png" },
        ],
      }),
    });
    const artifactWrites: Array<{
      content: Buffer;
      contentType: string;
      extension?: string;
    }> = [];
    const artifactStore: ToolArtifactStorePort = {
      writeToolResultArtifact: async (request) => {
        throw new Error(`unexpected text artifact write: ${request.contentType}`);
      },
      writeToolResultBinaryArtifact: async (request) => {
        const content = Buffer.from(request.content);
        artifactWrites.push({
          content,
          contentType: request.contentType,
          extension: request.extension,
        });
        return {
          id: "artifact-large-image",
          uri: "zcode-artifact://session/artifact-large-image",
          path: "/tmp/mcp-image.png",
          bytes: content.byteLength,
          contentType: request.contentType,
          createdAt: new Date("2026-06-10T00:00:00.000Z"),
        };
      },
      readToolResultArtifact: async () => {
        throw new Error("not used");
      },
    };

    registerMcpTools(registry, mcpPort, [
      {
        serverName: "ios_simulator",
        toolName: "ios_screenshot",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ]);

    const entry = registry.get("mcp__ios_simulator__ios_screenshot");
    const output = await entry?.handler({}, createToolContext({ artifactStore }));
    const modelContent = entry?.formatModelContent?.(output);

    expect(artifactWrites).toHaveLength(1);
    expect(Buffer.byteLength(largeBase64, "utf8")).toBeGreaterThan(MCP_IMAGE_INLINE_BASE64_BYTES);
    expect(artifactWrites[0]).toMatchObject({
      contentType: "image/png",
      extension: ".png",
    });
    expect(artifactWrites[0]?.content).toEqual(originalImage);
    expect(modelContent).toContain("screenshots/latest.png");
    expect(modelContent).toContain("/tmp/mcp-image.png");
    expect(JSON.stringify(modelContent)).not.toContain(largeBase64);
  });

  it("falls back to text artifacts for oversized MCP images when binary artifacts are unsupported", async () => {
    const registry = createToolRegistry();
    const largeBase64 = Buffer.alloc(MCP_IMAGE_INLINE_BASE64_BYTES, 9).toString("base64");
    const mcpPort = createMockMcpPort({
      callTool: async () => ({
        content: [{ type: "image", data: largeBase64, mimeType: "image/png" }],
      }),
    });
    const artifactWrites: Array<{ content: string; contentType?: string }> = [];
    const artifactStore: ToolArtifactStorePort = {
      writeToolResultArtifact: async (request) => {
        artifactWrites.push({
          content: request.content,
          contentType: request.contentType,
        });
        return {
          id: "artifact-large-image",
          uri: "zcode-artifact://session/artifact-large-image",
          path: "/tmp/mcp-image.json",
          bytes: Buffer.byteLength(request.content, "utf8"),
          contentType: request.contentType ?? "application/json",
          createdAt: new Date("2026-06-10T00:00:00.000Z"),
        };
      },
      readToolResultArtifact: async () => {
        throw new Error("not used");
      },
    };

    registerMcpTools(registry, mcpPort, [
      {
        serverName: "ios_simulator",
        toolName: "ios_screenshot",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ]);

    const entry = registry.get("mcp__ios_simulator__ios_screenshot");
    const output = await entry?.handler({}, createToolContext({ artifactStore }));
    const modelContent = entry?.formatModelContent?.(output);

    expect(artifactWrites).toHaveLength(1);
    expect(artifactWrites[0]?.contentType).toBe("application/json");
    expect(JSON.parse(artifactWrites[0]!.content)).toMatchObject({
      dataUrl: `data:image/png;base64,${largeBase64}`,
      inlineLimitBytes: MCP_IMAGE_INLINE_BASE64_BYTES,
      mimeType: "image/png",
      serverName: "ios_simulator",
      toolName: "ios_screenshot",
      type: "mcp-image-artifact",
    });
    expect(modelContent).toContain("/tmp/mcp-image.json");
    expect(JSON.stringify(modelContent)).not.toContain(largeBase64);
  });

  it("omits oversized MCP image content when artifact storage is unavailable", async () => {
    const registry = createToolRegistry();
    const largeBase64 = Buffer.alloc(MCP_IMAGE_INLINE_BASE64_BYTES, 11).toString("base64");
    const mcpPort = createMockMcpPort({
      callTool: async () => ({
        content: [{ type: "image", data: largeBase64, mimeType: "image/png" }],
      }),
    });

    registerMcpTools(registry, mcpPort, [
      {
        serverName: "ios_simulator",
        toolName: "ios_screenshot",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ]);

    const entry = registry.get("mcp__ios_simulator__ios_screenshot");
    const output = await entry?.handler({}, createToolContext());
    const modelContent = entry?.formatModelContent?.(output);

    expect(modelContent).toContain("MCP image content omitted");
    expect(modelContent).toContain("No artifact store is configured");
    expect(JSON.stringify(modelContent)).not.toContain(largeBase64);
  });
});

function createMockMcpPort(overrides: Partial<McpPort> = {}): McpPort {
  return {
    connectConfiguredServers: async () => ({ statuses: {}, tools: [] }),
    connectServer: async () => ({
      status: "connected",
      transport: "stdio",
      toolCount: 1,
      updatedAt: "now",
    }),
    disconnectServer: async () => undefined,
    status: async () => ({}),
    listTools: async () => [],
    callTool: async () => ({ content: [] }),
    close: async () => {},
    ...overrides,
  };
}
function createToolContext(
  overrides: Partial<
    Pick<
      ToolExecutionContext,
      "artifactStore" | "imageProcessorPort" | "runtimeScope" | "workingDirectory" | "workspaceKey"
    >
  > = {},
): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    sessionId: createSessionId("mcp-tool-bridge"),
    toolCallId: "tool-test",
    traceId: "trace-test" as never,
    workingDirectory: "/tmp/project",
    workspaceRoot: "/tmp/project",
    ...overrides,
  };
}
