import { vi } from "vitest";
// MCP 测试共用 fixture：快照式端口与可记录请求的 runtime。
import {
  createSessionId,
  type McpPort,
  type McpToolCatalogPort,
  type McpConfigurationSource,
  type McpServerStatus,
  type McpServerToolSnapshot,
  type Model,
  type ModelRequest,
  type PermissionBrokerPort,
  type SessionStorePort,
  type ToolSearchMode,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

export function mcpStatus(
  status: McpServerStatus["status"],
  extra: Partial<McpServerStatus> = {},
): McpServerStatus {
  return { status, transport: "stdio", toolCount: 0, updatedAt: "now", ...extra };
}

export function tool(serverName: string, toolName: string) {
  return { serverName, toolName, inputSchema: { type: "object", properties: {} } as const };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function createSnapshotMcpPort(
  snapshot: Record<string, McpServerToolSnapshot>,
  overrides: Partial<McpPort> = {},
): McpPort {
  return {
    connectConfiguredServers: () => new Promise(() => {}),
    connectServer: async () => mcpStatus("connected"),
    disconnectServer: async () => undefined,
    status: async () => ({}),
    listTools: async () => [],
    callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
    close: async () => {},
    getToolSnapshot: () => snapshot,
    waitForServer: async () => ({ timedOut: false }),
    ...overrides,
  };
}

export function stdioServer(extra: Record<string, unknown> = {}) {
  return { type: "stdio" as const, command: "node", args: ["server.js"], ...extra };
}

export interface RuntimeFixture {
  requests: ModelRequest[];
  runtime: ReturnType<typeof createTestAgentRuntime>;
}

export function createRuntime(input: {
  label: string;
  snapshot: Record<string, McpServerToolSnapshot>;
  servers?: Record<string, ReturnType<typeof stdioServer>>;
  policy?: "background" | "blocking";
  toolSearchMode?: ToolSearchMode;
  toolDisallowlist?: string[];
  toolAllowlist?: string[];
  mcpEnabled?: boolean;
  supportsToolCall?: boolean;
  mcpPort?: Partial<McpPort>;
  mcpToolCatalogPort?: McpToolCatalogPort;
  mcpConfigurationSource?: McpConfigurationSource;
  sessionStore?: SessionStorePort;
  /** 走真实执行器调用 MCP 工具时需要；缺省为拒绝一切的 broker。 */
  permissionBroker?: PermissionBrokerPort;
  respond?: (
    request: ModelRequest,
    index: number,
  ) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
}): RuntimeFixture & { port: McpPort } {
  const requests: ModelRequest[] = [];
  const modelFactory = createTestModelFactory({
    async generateText(request) {
      requests.push(request);
      return ((await input.respond?.(request, requests.length - 1)) ?? {
        text: "done",
        finishReason: "stop",
        usage: {},
      }) as never;
    },
  });
  // native 需要 Anthropic 协议能力；supportsToolCall 覆盖用于不支持工具调用的模型。
  const native = input.toolSearchMode === "native";
  const wrap = (model: Model): Model => ({
    ...model,
    ...(native
      ? {
          requestCapabilities: {
            foldRemindersIntoToolResults: true,
            toolSearch: { protocolSupported: true, defaultEnabled: true },
          },
        }
      : {}),
    ...(input.supportsToolCall === undefined
      ? {}
      : { properties: { ...model.properties, supportsToolCall: input.supportsToolCall } }),
    bind: (options) => wrap(model.bind(options)),
  });
  const wrapped = native || input.supportsToolCall !== undefined;
  const port = createSnapshotMcpPort(input.snapshot, input.mcpPort);
  const runtime = createTestAgentRuntime(
    createSessionId(`runtime-mcp-wait-${input.label}`),
    {
      mode: "build",
      modelStreaming: "off",
      titleGeneration: { enabled: false },
      toolSearch: { mode: input.toolSearchMode ?? "off" },
      toolDisallowlist: input.toolDisallowlist,
      toolAllowlist: input.toolAllowlist,
      mcp: {
        enabled: input.mcpEnabled ?? true,
        servers: input.servers ?? { local: stdioServer() },
      },
    },
    {
      ...(input.sessionStore ? { sessionStore: input.sessionStore } : {}),
      ...(input.permissionBroker ? { permissionBroker: input.permissionBroker } : {}),
      eventStore: createTestSessionEventStore(),
      mcpPort: port,
      mcpConfigurationSource: input.mcpConfigurationSource,
      mcpToolCatalogPort: input.mcpToolCatalogPort,
      mcpStartupPolicy: input.policy ?? "background",
      modelFactory: wrapped ? (i) => wrap(modelFactory(i)) : modelFactory,
    },
  );
  return { requests, runtime, port };
}

export function toolNames(request: ModelRequest | undefined): string[] {
  return request?.tools?.map((entry) => entry.name) ?? [];
}

export function messagesText(request: ModelRequest | undefined): string {
  return JSON.stringify(request?.messages ?? []);
}

/** 测试 adapter 自己发布连接结果；生产 session 只读快照。 */
export function createMockMcpPort(overrides: Partial<McpPort> = {}): McpPort {
  let snapshot: Record<string, McpServerToolSnapshot> = {};
  return {
    getToolSnapshot: () => snapshot,
    connectServer: vi.fn(async () => mcpStatus("connected")),
    disconnectServer: vi.fn(async () => undefined),
    status: vi.fn(async () =>
      Object.fromEntries(Object.entries(snapshot).map(([name, row]) => [name, row.status])),
    ),
    listTools: vi.fn(async () => Object.values(snapshot).flatMap((row) => row.tools ?? [])),
    callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
    close: vi.fn(async () => {}),
    ...overrides,
    connectConfiguredServers: vi.fn(async (servers, options) => {
      const result = await (overrides.connectConfiguredServers?.(servers, options) ??
        Promise.resolve({ statuses: {}, tools: [] }));
      snapshot = Object.fromEntries(
        Object.entries(result.statuses).map(([name, status]) => [
          name,
          {
            status,
            tools: result.tools.filter((tool) => tool.serverName === name),
            toolsVersion: "1",
          },
        ]),
      );
      return result;
    }),
  };
}
