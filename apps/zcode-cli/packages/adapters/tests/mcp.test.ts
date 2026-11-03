import { delimiter, dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import { ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY } from "@zcode/shared";
import type { SharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";

const {
  capturedClientInfo,
  capturedClients,
  capturedHttpOptions,
  capturedSseOptions,
  capturedStdioOptions,
  capturedStdioStderrHandlers,
  capturedClientOptions,
  clientCloseMock,
  clientCallToolMock,
  clientConnectMock,
  clientListToolsMock,
  clientPingMock,
  transportCloseMock,
  transportFinishAuthMock,
  authMock,
} = vi.hoisted(() => ({
  capturedClientInfo: [] as Array<{ name: string; version: string }>,
  capturedClients: [] as Array<{ onclose?: () => void }>,
  capturedHttpOptions: [] as unknown[],
  capturedSseOptions: [] as unknown[],
  capturedStdioOptions: [] as unknown[],
  capturedStdioStderrHandlers: [] as Array<(chunk: Buffer) => void>,
  capturedClientOptions: [] as unknown[],
  clientCloseMock: vi.fn(async () => {}),
  clientCallToolMock: vi.fn(async () => ({
    content: [{ type: "text", text: "ok" }],
  })),
  clientConnectMock: vi.fn(async () => {}),
  clientListToolsMock: vi.fn(async () => ({ tools: [] })),
  clientPingMock: vi.fn(async () => ({})),
  transportCloseMock: vi.fn(async () => {}),
  transportFinishAuthMock: vi.fn(async () => {}),
  authMock: vi.fn(async () => "AUTHORIZED" as const),
}));

vi.mock("@modelcontextprotocol/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/client")>();
  return {
    ...actual,
    auth: authMock,
    Client: class {
      readonly close = clientCloseMock;
      readonly callTool = clientCallToolMock;
      readonly connect = clientConnectMock;
      readonly listTools = clientListToolsMock;
      readonly ping = clientPingMock;
      onclose?: () => void;

      constructor(info: { name: string; version: string }, options?: unknown) {
        capturedClientInfo.push(info);
        capturedClientOptions.push(options);
        capturedClients.push(this);
      }

      getProtocolEra() {
        const options = capturedClientOptions.at(-1) as {
          versionNegotiation?: { mode?: unknown };
        };
        return options?.versionNegotiation?.mode === "legacy" ? "legacy" : "modern";
      }

      getNegotiatedProtocolVersion() {
        const options = capturedClientOptions.at(-1) as {
          versionNegotiation?: { mode?: unknown };
        };
        return options?.versionNegotiation?.mode === "legacy" ? "2025-11-25" : "2026-07-28";
      }
    },
    SSEClientTransport: class {
      readonly close = transportCloseMock;
      readonly finishAuth = transportFinishAuthMock;

      constructor(_url: URL, options: unknown) {
        capturedSseOptions.push(options);
      }
    },
    StreamableHTTPClientTransport: class {
      readonly close = transportCloseMock;
      readonly finishAuth = transportFinishAuthMock;

      constructor(_url: URL, options: unknown) {
        capturedHttpOptions.push(options);
      }
    },
  };
});

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: class {
    readonly close = transportCloseMock;
    readonly pid = 42_424;
    readonly stderr = {
      on: vi.fn((event: "data", handler: (chunk: Buffer) => void) => {
        if (event === "data") capturedStdioStderrHandlers.push(handler);
      }),
    };

    constructor(options: unknown) {
      capturedStdioOptions.push(options);
    }
  },
}));

import { createMcpAdapter } from "../src/mcp/index.js";
import { createMcpTelemetryTracker } from "../src/mcp/telemetry.js";

/**
 * 把 Phase 1 建连做成认证失败，并接管 Phase 2 的 `auth()`：调用 provider 的
 * `redirectToAuthorization()` 暴露授权 URL，然后阻塞在 gate 上，直到测试调用 `release()`。
 *
 * 修复原因：授权 URL 的归属已经从「Phase 1 provider 自己 redirect」改为「Phase 2 事务发布」，
 * 所以这些用例必须走 connect 失败 → 分类 → Phase 2 这条新链路。
 */
function stubInteractiveAuthorization(
  authorizationUrl: string,
  beforeAuthorization?: Promise<void>,
): { release: () => void; ready: Promise<void> } {
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let connectAttempts = 0;
  clientConnectMock.mockImplementation(async () => {
    connectAttempts += 1;
    // 第一次建连以确定性认证错误失败，触发 Phase 2；授权完成后的重连必须成功。
    if (connectAttempts === 1) throw new UnauthorizedError();
  });
  authMock.mockImplementation(async (provider: unknown) => {
    const interactiveProvider = provider as {
      redirectToAuthorization(url: URL): Promise<void>;
    };
    await beforeAuthorization;
    await interactiveProvider.redirectToAuthorization(new URL(authorizationUrl));
    markReady();
    await gate;
    return "AUTHORIZED" as const;
  });
  return { release, ready };
}

async function observePromiseWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<
  | { status: "fulfilled"; value: T }
  | { reason: unknown; status: "rejected" }
  | { status: "pending" }
> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const observed = promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ reason, status: "rejected" as const }),
  );
  try {
    return await Promise.race([
      observed,
      new Promise<{ status: "pending" }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ status: "pending" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

describe("createMcpAdapter", () => {
  beforeEach(() => {
    capturedClientInfo.length = 0;
    capturedHttpOptions.length = 0;
    capturedSseOptions.length = 0;
    capturedStdioOptions.length = 0;
    capturedStdioStderrHandlers.length = 0;
    capturedClientOptions.length = 0;
    capturedClients.length = 0;
    clientCloseMock.mockClear();
    clientCallToolMock.mockClear();
    clientConnectMock.mockClear();
    clientListToolsMock.mockClear();
    clientPingMock.mockClear();
    clientPingMock.mockResolvedValue({});
    transportCloseMock.mockClear();
    transportFinishAuthMock.mockClear();
    authMock.mockClear();
    authMock.mockResolvedValue("AUTHORIZED");
    clientConnectMock.mockResolvedValue(undefined);
    clientListToolsMock.mockResolvedValue({ tools: [] });
    clientCallToolMock.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("close waits for cancelled handshake resource cleanup before returning", async () => {
    const started = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const cleaned = Promise.withResolvers<void>();
    clientConnectMock.mockImplementationOnce(async () => {
      started.resolve();
      await new Promise(() => {});
    });
    clientCloseMock.mockImplementationOnce(async () => {
      cleanupStarted.resolve();
      await cleaned.promise;
    });
    const adapter = createMcpAdapter();
    const connecting = adapter.connectServer("slow", {
      type: "http",
      url: "https://mcp.example.test/mcp",
    });
    await started.promise;
    let settled = false;
    const closing = adapter.close().then(() => {
      settled = true;
    });
    await cleanupStarted.promise;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(settled).toBe(false);
    cleaned.resolve();
    await closing;
    await connecting;
    expect(await adapter.status()).toEqual({});
  });

  it("waits for the existing App connection without exposing a premature snapshot or reconnecting", async () => {
    const gate = Promise.withResolvers<void>();
    clientConnectMock.mockImplementationOnce(() => gate.promise);
    const adapter = createMcpAdapter();
    const connecting = adapter.connectServer("fixture", { type: "stdio", command: "node" });
    await vi.waitFor(() => expect(clientConnectMock).toHaveBeenCalledOnce());
    expect(adapter.appConnectionSnapshot?.("fixture")).toBeNull();
    const settled = vi.fn();
    const opening = adapter.waitForAppConnection!("fixture").then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    gate.resolve();
    await connecting;
    await opening;
    expect(settled).toHaveBeenCalledWith(adapter.appConnectionSnapshot?.("fixture"));
    expect(settled.mock.calls[0]?.[0]).not.toBeNull();
    expect(clientConnectMock).toHaveBeenCalledOnce();
    await adapter.close();
  });

  it("does not issue an App connection for an absent or failed server", async () => {
    const adapter = createMcpAdapter();
    expect(await adapter.waitForAppConnection!("missing")).toBeNull();
    clientConnectMock.mockRejectedValueOnce(new Error("fixture startup failure"));
    await adapter.connectServer("fixture", { type: "stdio", command: "node" });
    expect(await adapter.waitForAppConnection!("fixture")).toBeNull();
    expect(clientConnectMock).toHaveBeenCalledOnce();
    await adapter.close();
  });

  it("rejects an App startup waiter after the connection generation is replaced", async () => {
    const gate = Promise.withResolvers<void>();
    clientConnectMock.mockImplementationOnce(() => gate.promise);
    const adapter = createMcpAdapter();
    const config = { type: "stdio" as const, command: "node" };
    const connecting = adapter.connectServer("fixture", config);
    await vi.waitFor(() => expect(clientConnectMock).toHaveBeenCalledOnce());
    const opening = adapter.waitForAppConnection!("fixture");
    await adapter.connectServer("fixture", config);
    gate.resolve();
    await connecting;
    expect(await opening).toBeNull();
    expect(adapter.appConnectionSnapshot?.("fixture")).not.toBeNull();
    await adapter.close();
  });

  it("forwards runtime scope, session, turn, and trace context through MCP request metadata", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("node_repl", {
      command: "node",
      type: "stdio",
    });

    await adapter.callTool({
      arguments: { code: "1 + 1" },
      serverName: "node_repl",
      toolName: "js",
      runtimeScope: "subagent",
      trace: {
        parentSpanId: "parent-1",
        sessionId: "session-1" as never,
        spanId: "span-1",
        traceId: "trace-1" as never,
        turnId: "turn-1" as never,
      },
    });

    expect(clientCallToolMock).toHaveBeenCalledWith(
      {
        arguments: { code: "1 + 1" },
        name: "js",
        _meta: {
          "com.zcode/request-context": {
            parent_span_id: "parent-1",
            runtime_scope: "subagent",
            session_id: "session-1",
            span_id: "span-1",
            trace_id: "trace-1",
            turn_id: "turn-1",
          },
          parent_span_id: "parent-1",
          runtime_scope: "subagent",
          session_id: "session-1",
          span_id: "span-1",
          trace_id: "trace-1",
          turn_id: "turn-1",
        },
      },
      expect.objectContaining({ resetTimeoutOnProgress: true }),
    );
  });

  it("forwards the root session of a subagent call through MCP request metadata", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("node_repl", { command: "node", type: "stdio" });

    await adapter.callTool({
      arguments: { code: "1 + 1" },
      serverName: "node_repl",
      toolName: "js",
      runtimeScope: "subagent",
      trace: {
        rootSessionId: "session-1" as never,
        sessionId: "subagent-1" as never,
        traceId: "trace-1" as never,
      },
    });

    const meta = clientCallToolMock.mock.calls.at(-1)?.[0]._meta;
    expect(meta).toMatchObject({ root_session_id: "session-1", session_id: "subagent-1" });
    expect(meta["com.zcode/request-context"]).toMatchObject({
      root_session_id: "session-1",
      session_id: "subagent-1",
    });
  });

  it("uses the injected client version for MCP initialize", async () => {
    const adapter = createMcpAdapter({ clientVersion: "9.8.7" });

    await adapter.connectServer("demo", {
      command: "node",
      type: "stdio",
    });

    expect(capturedClientInfo).toEqual([
      {
        name: "zcode",
        version: "9.8.7",
      },
    ]);
  });

  it("logs the configured negotiation policy and actual MCP protocol version", async () => {
    const infoMock = vi.fn();
    const logger = {
      child: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      info: infoMock,
      warn: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    const adapter = createMcpAdapter({
      clientName: "zcode-test",
      clientVersion: "9.8.7",
      connectionContext: {
        mcpConnectionId: "connection-session-1",
        mcpIsolation: "session",
        sessionId: "session-1",
        workspaceKey: "workspace-1",
      },
      logger,
    });

    await adapter.connectServer("auto-modern", {
      command: "node",
      type: "stdio",
    });
    await adapter.connectServer("explicit-legacy", {
      command: "node",
      protocolVersion: "legacy",
      type: "stdio",
    });

    expect(infoMock).toHaveBeenCalledWith(
      "MCP server connected",
      expect.objectContaining({
        event: "mcp.server.connected",
        mcpClientName: "zcode-test",
        mcpClientVersion: "9.8.7",
        mcpConnectionId: "connection-session-1",
        mcpIsolation: "session",
        mcpProtocolEra: "modern",
        mcpProtocolVersion: "2026-07-28",
        mcpServerName: "auto-modern",
        mcpTransportPid: 42_424,
        mcpVersionNegotiationMode: "auto",
        sessionId: "session-1",
        workspaceKey: "workspace-1",
      }),
    );
    expect(infoMock).toHaveBeenCalledWith(
      "MCP server connected",
      expect.objectContaining({
        event: "mcp.server.connected",
        mcpClientName: "zcode-test",
        mcpClientVersion: "9.8.7",
        mcpProtocolEra: "legacy",
        mcpProtocolVersion: "2025-11-25",
        mcpServerName: "explicit-legacy",
        mcpVersionNegotiationMode: "legacy",
      }),
    );
  });

  it("defaults ordinary MCP servers to dual-era auto while keeping explicit era pins", async () => {
    const adapter = createMcpAdapter();

    await adapter.connectServer("browser_use", {
      command: "node",
      protocolVersion: "2026-07-28",
      timeoutMs: 600_000,
      type: "stdio",
    });
    await adapter.connectServer("default-stdio", {
      command: "node",
      type: "stdio",
    });
    await adapter.connectServer("default-http", {
      type: "http",
      url: "https://mcp.example.test",
    });
    await adapter.connectServer("auto-http", {
      protocolVersion: "auto",
      timeoutMs: 2_000,
      type: "http",
      url: "https://mcp.example.test/auto",
    });
    await adapter.connectServer("legacy-http", {
      protocolVersion: "legacy",
      type: "http",
      url: "https://mcp.example.test/legacy",
    });
    await adapter.connectServer("legacy-sse", {
      type: "sse",
      url: "https://mcp.example.test/sse",
    });

    expect(
      capturedClientOptions.map((options) => ({
        versionNegotiation: (options as { versionNegotiation?: unknown }).versionNegotiation,
      })),
    ).toEqual([
      {
        versionNegotiation: {
          mode: { pin: "2026-07-28" },
          probe: { timeoutMs: 600_000 },
        },
      },
      { versionNegotiation: { mode: "auto", probe: { timeoutMs: 5_000 } } },
      { versionNegotiation: { mode: "auto", probe: { timeoutMs: 5_000 } } },
      { versionNegotiation: { mode: "auto", probe: { timeoutMs: 1_000 } } },
      { versionNegotiation: { mode: "legacy" } },
      { versionNegotiation: { mode: "legacy" } },
    ]);
    // MCP Apps：每个 client 都宣告可渲染的 UI mimeType，server 据此决定是否下发 ui 资源。
    for (const options of capturedClientOptions) {
      expect(options).toMatchObject({
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
          },
        },
      });
    }
  });

  it("preserves non-object structuredContent from MCP 2026-07-28", async () => {
    clientCallToolMock.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      structuredContent: ["first", 2, true],
    });
    const adapter = createMcpAdapter();
    await adapter.connectServer("modern", {
      command: "node",
      protocolVersion: "2026-07-28",
      type: "stdio",
    });

    await expect(
      adapter.callTool({
        serverName: "modern",
        toolName: "array-result",
      }),
    ).resolves.toMatchObject({
      structuredContent: ["first", 2, true],
    });
  });

  it("projects server timeout onto listed MCP tool descriptors", async () => {
    clientListToolsMock.mockResolvedValue({
      tools: [
        {
          name: "long-task",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    });
    const adapter = createMcpAdapter();

    await adapter.connectServer("demo", {
      command: "node",
      timeoutMs: 900_000,
      type: "stdio",
    });

    await expect(adapter.listTools()).resolves.toMatchObject([
      {
        serverName: "demo",
        toolName: "long-task",
        name: "mcp__demo__long-task",
        timeoutMs: 900_000,
      },
    ]);
  });

  it("reports connecting status while an MCP server is still starting", async () => {
    let resolveConnect!: () => void;
    clientConnectMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const adapter = createMcpAdapter();

    const connect = adapter.connectServer("demo", {
      command: "node",
      type: "stdio",
    });
    await Promise.resolve();

    await expect(adapter.status()).resolves.toMatchObject({
      demo: {
        status: "connecting",
        transport: "stdio",
        toolCount: 0,
      },
    });

    resolveConnect();
    await expect(connect).resolves.toMatchObject({
      status: "connected",
      toolCount: 0,
    });
  });

  it("bounds callTool waiting for a shared startup connection without cancelling it", async () => {
    let resolveConnect!: () => void;
    clientConnectMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const adapter = createMcpAdapter();
    const connect = adapter.connectServer("demo", {
      command: "node",
      type: "stdio",
    });
    await Promise.resolve();

    const call = adapter.callTool(
      {
        serverName: "demo",
        toolName: "slow-start",
      },
      { timeoutMs: 20 },
    );

    try {
      await expect(observePromiseWithin(call, 200)).resolves.toMatchObject({
        reason: {
          name: "McpTimeoutError",
        },
        status: "rejected",
      });
      await expect(adapter.status()).resolves.toMatchObject({
        demo: { status: "connecting" },
      });
      expect(clientCallToolMock).not.toHaveBeenCalled();
    } finally {
      resolveConnect();
      await Promise.allSettled([connect, call]);
      await adapter.close();
    }

    await expect(adapter.status()).resolves.toEqual({});
  });

  it("includes sanitized recent stdio stderr when MCP server connection fails", async () => {
    const debugMock = vi.fn();
    const warnMock = vi.fn();
    const logger = {
      child: vi.fn(),
      debug: debugMock,
      error: vi.fn(),
      info: vi.fn(),
      warn: warnMock,
    };
    logger.child.mockReturnValue(logger);
    clientConnectMock.mockImplementation(async () => {
      capturedStdioStderrHandlers[0]?.(
        Buffer.from(
          [
            "MYSQL_PASS=super-secret",
            "Authorization: Bearer live-token",
            "fatal: database refused connection",
          ].join("\n"),
        ),
      );
      throw new Error("MCP error -32000: Connection closed");
    });
    const adapter = createMcpAdapter({ logger });

    await expect(
      adapter.connectServer("mysql-local", {
        command: "node",
        type: "stdio",
      }),
    ).resolves.toMatchObject({
      error: expect.stringContaining("fatal: database refused connection"),
      status: "failed",
    });

    expect(debugMock).toHaveBeenCalledWith(
      "MCP stdio stderr",
      expect.objectContaining({
        stderr: expect.stringContaining("fatal: database refused connection"),
      }),
    );
    expect(warnMock).toHaveBeenCalledWith(
      "MCP server connection failed",
      expect.objectContaining({
        error: "MCP error -32000: Connection closed",
        event: "mcp.server.failed",
        stderr: expect.stringContaining("fatal: database refused connection"),
      }),
    );
    const warnContext = warnMock.mock.calls[0]?.[1] as { stderr?: string };
    expect(warnContext.stderr).toContain("MYSQL_PASS=[Redacted]");
    expect(warnContext.stderr).toContain("Authorization: Bearer [Redacted]");
    expect(warnContext.stderr).not.toContain("super-secret");
    expect(warnContext.stderr).not.toContain("live-token");
    const status = (await adapter.status())["mysql-local"];
    expect(status?.error).toContain("MCP error -32000: Connection closed");
    expect(status?.error).toContain("MYSQL_PASS=[Redacted]");
    expect(status?.error).not.toContain("super-secret");
    expect(status?.error).not.toContain("live-token");
    await adapter.close();
  });

  it.each([
    ["python", "ModuleNotFoundError: No module named 'mcp'"],
    ["node", "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'example-mcp'"],
    ["path", "ENOENT: no such file or directory"],
    ["permission", "PermissionError: [Errno 13] Permission denied"],
  ])(
    "exposes bounded sanitized %s startup evidence without changing failure kind",
    async (_name, cause) => {
      clientConnectMock.mockImplementation(async () => {
        capturedStdioStderrHandlers[0]?.(
          Buffer.from(
            "noise".repeat(1_000) +
              "\n\u001b[31m" +
              cause +
              "\u001b[0m\nAPI_TOKEN=fixture-secret\n",
          ),
        );
        throw new Error("Connection closed");
      });
      const adapter = createMcpAdapter();
      try {
        const status = await adapter.connectServer("broken", { command: "node", type: "stdio" });
        expect(status).toMatchObject({ status: "failed", failureKind: "process_start_failed" });
        expect(status.error).toContain(cause);
        expect(status.error).toContain("Connection closed");
        expect(status.error).not.toContain("\u001b");
        expect(status.error).not.toContain("fixture-secret");
        expect(status.error!.length).toBeLessThanOrEqual(4_520);
      } finally {
        await adapter.close();
      }
    },
  );

  it("keeps HTTP failures separate from recent stdio stderr", async () => {
    clientConnectMock.mockRejectedValue(new Error("network unavailable"));
    const adapter = createMcpAdapter();
    try {
      const status = await adapter.connectServer("http-failure", {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer fixture" },
      });
      expect(status.error).toBe("network unavailable");
      expect(status.failureKind).toBe("network_unreachable");
    } finally {
      await adapter.close();
    }
  });

  it("redacts quoted and escaped credential values before exposing stderr", async () => {
    clientConnectMock.mockImplementation(async () => {
      capturedStdioStderrHandlers[0]?.(
        Buffer.from(
          [
            'API_TOKEN="first secret with spaces"',
            String.raw`VE_SPEECH_MCP_TOKEN="second escaped\" secret"`,
            String.raw`{"access_token":"third escaped\" secret"}`,
            "ModuleNotFoundError: No module named 'mcp'",
          ].join("\n"),
        ),
      );
      throw new Error("Connection closed");
    });
    const adapter = createMcpAdapter();
    try {
      const status = await adapter.connectServer("quoted-secret", {
        command: "node",
        type: "stdio",
      });
      expect(status.error).toContain("No module named 'mcp'");
      expect(status.error).not.toContain("secret");
      expect(status.error).not.toContain("escaped");
      expect(status.error).not.toContain("spaces");
    } finally {
      await adapter.close();
    }
  });

  it("marks the record disconnected and logs recent stderr when the transport closes unexpectedly", async () => {
    const warnMock = vi.fn();
    const logger = {
      child: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: warnMock,
    };
    logger.child.mockReturnValue(logger);
    const telemetryEvents: Array<{ kind: string; mcpInstanceId?: string }> = [];
    const telemetry = createMcpTelemetryTracker({
      idSalt: "device-a",
      onEvent: (event) => telemetryEvents.push(event),
      randomId: () => "mcp-instance-1",
    });
    telemetry.registerConnection({
      connectionId: "connection-1",
      isolation: "session",
      serverName: "node_repl",
    });
    telemetry.acquireOwner({
      connectionId: "connection-1",
      ownerId: "lease-1",
      sessionId: "session-1",
    });
    const adapter = createMcpAdapter({
      connectionContext: {
        mcpConnectionId: "connection-1",
        mcpIsolation: "session",
        sessionId: "session-1",
      },
      logger,
      telemetry,
    });

    await adapter.connectServer("node_repl", {
      command: "node",
      type: "stdio",
    });
    capturedStdioStderrHandlers[0]?.(
      Buffer.from("node_repl uncaughtException: boom from async timer\n"),
    );

    capturedClients.at(-1)?.onclose?.();

    expect(warnMock).toHaveBeenCalledWith(
      "MCP server connection lost",
      expect.objectContaining({
        event: "mcp.server.connection_lost",
        mcpServerName: "node_repl",
        mcpTransportPid: 42_424,
        stderr: expect.stringContaining("boom from async timer"),
      }),
    );
    const statuses = await adapter.status();
    expect(statuses.node_repl?.status).toBe("disconnected");
    expect(statuses.node_repl?.failureKind).toBe("unexpected_disconnect");
    expect(telemetryEvents.map((event) => [event.kind, event.mcpInstanceId])).toEqual([
      ["process_start", "mcp-instance-1"],
      ["process_crash", "mcp-instance-1"],
    ]);
  });

  it("does not report connection_lost when the server is closed deliberately", async () => {
    const warnMock = vi.fn();
    const logger = {
      child: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: warnMock,
    };
    logger.child.mockReturnValue(logger);
    const adapter = createMcpAdapter({ logger });

    await adapter.connectServer("node_repl", {
      command: "node",
      type: "stdio",
    });
    await adapter.disconnectServer("node_repl");
    capturedClients.at(-1)?.onclose?.();

    expect(warnMock).not.toHaveBeenCalledWith("MCP server connection lost", expect.anything());
  });

  // Bugfix 回归：HTTP/SSE MCP 被停掉不会派发 onclose，status() 会一直停在 connected。
  // 设置页刷新依赖 pingServer 把这种无声死亡暴露出来。
  it("keeps the server connected when the ping succeeds", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("official_tools", {
      type: "http",
      url: "https://mcp.example/mcp",
    });

    await expect(adapter.pingServer?.("official_tools")).resolves.toBe(true);
    expect((await adapter.status()).official_tools?.status).toBe("connected");
  });

  it("marks the server disconnected when the ping hits a dead transport", async () => {
    const warnMock = vi.fn();
    const logger = {
      child: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: warnMock,
    };
    logger.child.mockReturnValue(logger);
    const adapter = createMcpAdapter({ logger });
    await adapter.connectServer("official_tools", {
      type: "http",
      url: "https://mcp.example/mcp",
    });
    // SDK 本地错误用字符串 code（REQUEST_TIMEOUT / CONNECTION_CLOSED …）。
    clientPingMock.mockRejectedValue(
      Object.assign(new Error("Request timed out"), { code: "REQUEST_TIMEOUT" }),
    );

    await expect(adapter.pingServer?.("official_tools")).resolves.toBe(false);
    expect((await adapter.status()).official_tools).toMatchObject({
      failureKind: "unexpected_disconnect",
      status: "disconnected",
    });
    expect(warnMock).toHaveBeenCalledWith(
      "MCP server ping failed",
      expect.objectContaining({
        event: "mcp.server.ping.failed",
        mcpServerName: "official_tools",
      }),
    );
  });

  it("treats a JSON-RPC error answer as a live connection", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("official_tools", {
      type: "http",
      url: "https://mcp.example/mcp",
    });
    // server 回了 method-not-found：请求走通了，连接是活的，不能据此拆连接。
    clientPingMock.mockRejectedValue(
      Object.assign(new Error("Method not found"), { code: -32_601 }),
    );

    await expect(adapter.pingServer?.("official_tools")).resolves.toBe(true);
    expect((await adapter.status()).official_tools?.status).toBe("connected");
  });

  it("reports an unknown server as not alive", async () => {
    const adapter = createMcpAdapter();
    await expect(adapter.pingServer?.("missing")).resolves.toBe(false);
  });

  it("reconnects and retries once when the tool call hits a dead transport", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("node_repl", {
      command: "node",
      type: "stdio",
    });

    clientCallToolMock
      .mockRejectedValueOnce(new Error("Not connected"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "revived" }] });

    const result = await adapter.callTool({
      arguments: { code: "1 + 1" },
      serverName: "node_repl",
      toolName: "js",
    });

    expect(result.content).toEqual([{ type: "text", text: "revived" }]);
    expect(clientConnectMock).toHaveBeenCalledTimes(2);
    expect(clientCallToolMock).toHaveBeenCalledTimes(2);
  });

  it("reconnects before calling when the record was already marked disconnected", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("node_repl", {
      command: "node",
      type: "stdio",
    });

    capturedClients.at(-1)?.onclose?.();
    expect((await adapter.status()).node_repl?.status).toBe("disconnected");

    const result = await adapter.callTool({
      arguments: { code: "1 + 1" },
      serverName: "node_repl",
      toolName: "js",
    });

    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(clientConnectMock).toHaveBeenCalledTimes(2);
    expect((await adapter.status()).node_repl?.status).toBe("connected");
  });

  it("surfaces the original error when reconnection also fails", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("node_repl", {
      command: "node",
      type: "stdio",
    });

    clientCallToolMock.mockRejectedValue(new Error("Not connected"));
    clientConnectMock.mockRejectedValue(new Error("spawn ENOENT"));

    await expect(
      adapter.callTool({
        arguments: { code: "1 + 1" },
        serverName: "node_repl",
        toolName: "js",
      }),
    ).rejects.toThrow(/Not connected/);
    expect(clientCallToolMock).toHaveBeenCalledTimes(1);
  });

  it("injects unified network env into stdio MCP transports", async () => {
    const adapter = createMcpAdapter({
      env: {
        PATH: dirname(process.execPath),
        ZCODE_AGENT_CA_CERT: "/tmp/root-ca.pem",
      },
      network: {
        httpProxy: "127.0.0.1:8888",
        noProxy: "localhost,127.0.0.1",
      },
    });

    await adapter.connectServer("demo", {
      command: "node",
      env: {
        MCP_TOKEN: "secret",
      },
      type: "stdio",
    });

    const options = capturedStdioOptions[0] as { env?: Record<string, string> };
    expect(options.env).toMatchObject({
      ALL_PROXY: "http://127.0.0.1:8888",
      CURL_CA_BUNDLE: "/tmp/root-ca.pem",
      GIT_SSL_CAINFO: "/tmp/root-ca.pem",
      HTTPS_PROXY: "http://127.0.0.1:8888",
      HTTP_PROXY: "http://127.0.0.1:8888",
      MCP_TOKEN: "secret",
      NODE_EXTRA_CA_CERTS: "/tmp/root-ca.pem",
      NO_PROXY: "localhost,127.0.0.1",
      // MCP 会补齐 Node 目录；本测试使用已含 Node 的 PATH，避免依赖测试机的 /bin。
      PATH: dirname(process.execPath),
      REQUESTS_CA_BUNDLE: "/tmp/root-ca.pem",
      SSL_CERT_FILE: "/tmp/root-ca.pem",
      all_proxy: "http://127.0.0.1:8888",
      http_proxy: "http://127.0.0.1:8888",
      https_proxy: "http://127.0.0.1:8888",
      no_proxy: "localhost,127.0.0.1",
    });
  });

  it("appends the injected node fallback after the server env", async () => {
    const resolve = vi.fn(async () => ({
      binDir: "/fallback/bin",
      env: { ZCODE_NODE_FALLBACK_EXEC_PATH: "/electron" },
    }));
    const adapter = createMcpAdapter({
      env: { PATH: dirname(process.execPath) },
      nodeFallback: { resolve },
    });

    await adapter.connectServer("demo", {
      command: "node",
      // 插件自带 PATH 会整体替换宿主 PATH；fallback 仍须追加在它后面。
      env: { PATH: "/plugin/bin" },
      type: "stdio",
    });

    const options = capturedStdioOptions[0] as { env?: Record<string, string> };
    expect(options.env?.PATH).toBe(["/plugin/bin", "/fallback/bin"].join(delimiter));
    expect(options.env?.ZCODE_NODE_FALLBACK_EXEC_PATH).toBe("/electron");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("restores captured user network env into stdio MCP transports", async () => {
    const adapter = createMcpAdapter({
      env: {
        [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify({
          NODE_EXTRA_CA_CERTS: "/tmp/user-ca.pem",
          http_proxy: "http://user-proxy:8080",
        }),
        PATH: dirname(process.execPath),
      },
      network: {},
    });

    await adapter.connectServer("demo", {
      command: "node",
      type: "stdio",
    });

    const options = capturedStdioOptions[0] as { env?: Record<string, string> };
    expect(options.env).toMatchObject({
      NODE_EXTRA_CA_CERTS: "/tmp/user-ca.pem",
      PATH: dirname(process.execPath),
      http_proxy: "http://user-proxy:8080",
    });
    expect(options.env?.[ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]).toBeUndefined();
  });

  it("passes proxy-aware fetch into HTTP and SSE MCP transports", async () => {
    const adapter = createMcpAdapter({
      env: {
        ZCODE_HTTP_PROXY: "http://127.0.0.1:8888",
      },
      network: {},
    });

    await adapter.connectServer("http-demo", {
      type: "http",
      url: "https://mcp.example.test",
    });
    await adapter.connectServer("sse-demo", {
      type: "sse",
      url: "https://mcp.example.test/sse",
    });

    expect(capturedHttpOptions[0]).toMatchObject({
      fetch: expect.any(Function),
    });
    expect(capturedSseOptions[0]).toMatchObject({
      fetch: expect.any(Function),
    });
    await adapter.close();
  });

  it("passes a pure token AuthProvider into bare HTTP and SSE MCP transports", async () => {
    const adapter = createMcpAdapter();

    await adapter.connectServer("http-demo", {
      type: "http",
      url: "https://mcp.example.test",
    });
    await adapter.connectServer("sse-demo", {
      type: "sse",
      url: "https://mcp.example.test/sse",
    });

    const providers = [
      (capturedHttpOptions[0] as { authProvider?: Record<string, unknown> }).authProvider,
      (capturedSseOptions[0] as { authProvider?: Record<string, unknown> }).authProvider,
    ];

    for (const provider of providers) {
      expect(provider).toBeDefined();
      // 修复原因（根因 1）：运行期只能是纯 AuthProvider。SDK 的 `isOAuthClientProvider()` 判定
      // 依赖 `clientInformation`/`tokens` 等方法是否存在；一旦被识别为 OAuthClientProvider，
      // transport 就会通过 `adaptOAuthProvider` 包裹它，401 走 SDK 的 `auth()`，绕过我们的
      // refresh 单飞锁，rotation 竞态立刻复发。同时它还会带来 discovery / DCR / callback listener。
      expect(typeof provider?.token).toBe("function");
      expect(typeof provider?.onUnauthorized).toBe("function");
      expect(provider?.clientInformation).toBeUndefined();
      expect(provider?.tokens).toBeUndefined();
      expect(provider?.saveTokens).toBeUndefined();
      expect(provider?.clientMetadata).toBeUndefined();
      expect(provider?.redirectToAuthorization).toBeUndefined();
      expect(provider?.saveCodeVerifier).toBeUndefined();
    }
    await adapter.close();
  });

  it("does not attach implicit OAuth provider when HTTP MCP has an Authorization header", async () => {
    const adapter = createMcpAdapter();

    await adapter.connectServer("manual-token", {
      type: "http",
      url: "https://mcp.example.test",
      headers: {
        Authorization: "Bearer user-token",
      },
    });

    expect((capturedHttpOptions[0] as { authProvider?: unknown }).authProvider).toBeUndefined();
    await adapter.close();
  });

  it("passes OAuth client credentials providers into HTTP and SSE MCP transports", async () => {
    const adapter = createMcpAdapter({
      clientName: "zcode-test",
    });

    await adapter.connectServer("http-demo", {
      type: "http",
      url: "https://mcp.example.test",
      headers: {
        "X-ZCode": "1",
      },
      oauth: {
        type: "client_credentials",
        clientId: "http-client",
        clientSecret: "http-secret",
        scope: "mcp:tools",
      },
    });
    await adapter.connectServer("sse-demo", {
      type: "sse",
      url: "https://mcp.example.test/sse",
      oauth: {
        type: "client_credentials",
        clientId: "sse-client",
        clientSecret: "sse-secret",
      },
    });

    const httpOptions = capturedHttpOptions[0] as {
      authProvider?: {
        clientInformation(): { client_id: string; client_secret?: string };
        clientMetadata: {
          client_name?: string;
          grant_types?: string[];
          scope?: string;
        };
      };
      requestInit?: { headers?: Record<string, string> };
    };
    const sseOptions = capturedSseOptions[0] as {
      authProvider?: {
        clientInformation(): { client_id: string; client_secret?: string };
        clientMetadata: { client_name?: string; grant_types?: string[] };
      };
    };

    expect(httpOptions.requestInit?.headers).toEqual({ "X-ZCode": "1" });
    expect(httpOptions.authProvider?.clientInformation()).toEqual({
      client_id: "http-client",
      client_secret: "http-secret",
    });
    expect(httpOptions.authProvider?.clientMetadata).toMatchObject({
      client_name: "zcode-test-http-demo",
      grant_types: ["client_credentials"],
      scope: "mcp:tools",
    });
    expect(sseOptions.authProvider?.clientInformation()).toEqual({
      client_id: "sse-client",
      client_secret: "sse-secret",
    });
    expect(sseOptions.authProvider?.clientMetadata).toMatchObject({
      client_name: "zcode-test-sse-demo",
      grant_types: ["client_credentials"],
    });
  });

  it("exposes pending OAuth authorization URL through server status", async () => {
    const { release: resolveConnect } = stubInteractiveAuthorization(
      "https://auth.example.test/authorize?state=state_test",
    );
    const adapter = createMcpAdapter();

    const connect = adapter.connectServer("notion", {
      type: "http",
      url: "https://mcp.example.test/mcp",
      oauth: {
        type: "authorization_code",
        clientName: "ZCode",
      },
    });

    let authorizationUrl: string | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await adapter.status();
      authorizationUrl = status.notion?.authorization?.authorizationUrl;
      if (authorizationUrl) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(authorizationUrl).toBe("https://auth.example.test/authorize?state=state_test");

    resolveConnect();
    await expect(connect).resolves.toMatchObject({
      status: "connected",
      toolCount: 0,
    });
    await adapter.close();
  });

  it("reuses an unchanged configured connection while OAuth authorization is pending", async () => {
    const { release: resolveConnect } = stubInteractiveAuthorization(
      "https://auth.example.test/authorize?state=stable_state",
    );
    const adapter = createMcpAdapter();
    const firstConnect = adapter.connectConfiguredServers({
      notion: {
        type: "http",
        url: "https://mcp.example.test/mcp",
        oauth: {
          type: "authorization_code",
          clientName: "ZCode",
        },
      },
    });

    let authorizationUrl: string | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await adapter.status();
      authorizationUrl = status.notion?.authorization?.authorizationUrl;
      if (authorizationUrl) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const secondConnect = adapter.connectConfiguredServers({
      notion: {
        type: "http",
        url: "https://mcp.example.test/mcp",
        oauth: {
          type: "authorization_code",
          clientName: "ZCode",
        },
      },
    });
    await Promise.resolve();

    expect(authorizationUrl).toBe("https://auth.example.test/authorize?state=stable_state");
    expect(clientConnectMock).toHaveBeenCalledTimes(1);
    // Phase 1 的探测 transport 在进入 Phase 2 前一定会被关闭（negotiation 失败后不可复用），
    // 所以这里断言的是「第二个 caller 没有另起一条连接」，而不是 transport 从未关闭。
    expect(capturedHttpOptions).toHaveLength(1);
    await expect(adapter.status()).resolves.toMatchObject({
      notion: {
        authorization: {
          authorizationUrl: "https://auth.example.test/authorize?state=stable_state",
        },
        status: "connecting",
      },
    });

    resolveConnect();
    await expect(Promise.all([firstConnect, secondConnect])).resolves.toMatchObject([
      { statuses: { notion: { status: "connected" } } },
      { statuses: { notion: { status: "connected" } } },
    ]);
    await adapter.close();
  });

  it("keeps a reused OAuth connection alive when a bounded caller times out", async () => {
    const { release: resolveConnect } = stubInteractiveAuthorization(
      "https://auth.example.test/authorize?state=shared_timeout_state",
    );
    const adapter = createMcpAdapter();
    const servers = {
      notion: {
        type: "http" as const,
        url: "https://mcp.example.test/mcp",
        oauth: {
          type: "authorization_code" as const,
          clientName: "ZCode",
        },
      },
    };
    const settingsConnect = adapter.connectConfiguredServers(servers);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await adapter.status();
      if (status.notion?.authorization?.authorizationUrl) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const sessionConnect = await adapter.connectConfiguredServers(servers, {
      oauthAuthorizationTimeoutMs: 20,
    });

    expect(sessionConnect.statuses.notion).toMatchObject({
      authorization: {
        authorizationUrl: "https://auth.example.test/authorize?state=shared_timeout_state",
      },
      status: "connecting",
    });
    expect(clientConnectMock).toHaveBeenCalledTimes(1);
    // Phase 1 的探测 transport 在进入 Phase 2 前一定会被关闭（negotiation 失败后不可复用），
    // 所以这里断言的是「第二个 caller 没有另起一条连接」，而不是 transport 从未关闭。
    expect(capturedHttpOptions).toHaveLength(1);

    resolveConnect();
    await expect(settingsConnect).resolves.toMatchObject({
      statuses: { notion: { status: "connected" } },
    });
    await adapter.close();
  });

  it("only cancels the caller waiter when a reused OAuth connection is aborted", async () => {
    const { release: resolveConnect } = stubInteractiveAuthorization(
      "https://auth.example.test/authorize?state=shared_abort_state",
    );
    const adapter = createMcpAdapter();
    const servers = {
      notion: {
        type: "http" as const,
        url: "https://mcp.example.test/mcp",
        oauth: {
          type: "authorization_code" as const,
          clientName: "ZCode",
        },
      },
    };
    const settingsConnect = adapter.connectConfiguredServers(servers);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await adapter.status();
      if (status.notion?.authorization?.authorizationUrl) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const abortController = new AbortController();
    const sessionConnect = adapter.connectConfiguredServers(servers, {
      signal: abortController.signal,
    });
    abortController.abort(new Error("session stopped"));

    await expect(sessionConnect).resolves.toMatchObject({
      statuses: {
        notion: {
          authorization: {
            authorizationUrl: "https://auth.example.test/authorize?state=shared_abort_state",
          },
          status: "connecting",
        },
      },
    });
    expect(clientConnectMock).toHaveBeenCalledTimes(1);
    // Phase 1 的探测 transport 在进入 Phase 2 前一定会被关闭（negotiation 失败后不可复用），
    // 所以这里断言的是「第二个 caller 没有另起一条连接」，而不是 transport 从未关闭。
    expect(capturedHttpOptions).toHaveLength(1);

    resolveConnect();
    await expect(settingsConnect).resolves.toMatchObject({
      statuses: { notion: { status: "connected" } },
    });
    await adapter.close();
  });

  it("treats per-connect OAuth authorization timeout as a caller budget, not a transaction kill", async () => {
    let startAuthorization!: () => void;
    const beforeAuthorization = new Promise<void>((resolve) => {
      startAuthorization = resolve;
    });
    const { release, ready } = stubInteractiveAuthorization(
      "https://auth.example.test/authorize?state=state_test",
      beforeAuthorization,
    );
    const adapter = createMcpAdapter();
    const startedAt = Date.now();
    try {
      const status = await adapter.connectServer(
        "notion",
        {
          type: "http",
          url: "https://mcp.example.test/mcp",
          timeoutMs: 2_000,
          oauth: { type: "authorization_code", clientName: "ZCode" },
        },
        { oauthAuthorizationTimeoutMs: 20 },
      );
      // URL 发布含异步存储，不能假定它比 20ms caller 预算更快；事务应在 caller 返回后继续。
      expect(status).toMatchObject({ status: "connecting" });
      expect(status.authorization).toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(transportFinishAuthMock).not.toHaveBeenCalled();
      startAuthorization();
      await ready;
      await expect(adapter.status()).resolves.toMatchObject({
        notion: {
          authorization: {
            authorizationUrl: "https://auth.example.test/authorize?state=state_test",
          },
          status: "connecting",
        },
      });
      release();
      await vi.waitFor(async () => {
        expect(await adapter.status()).toMatchObject({ notion: { status: "connected" } });
      });
    } finally {
      startAuthorization();
      release();
      await adapter.close();
    }
  });

  it("keeps runtime OAuth recovery alive after the triggering caller times out", async () => {
    let startAuthorization!: () => void;
    const beforeAuthorization = new Promise<void>((resolve) => {
      startAuthorization = resolve;
    });
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    let releaseAuthorization!: () => void;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    authMock.mockImplementation(async (provider: unknown) => {
      const interactiveProvider = provider as {
        redirectToAuthorization(url: URL): Promise<void>;
        state(): Promise<string>;
      };
      const authorizationUrl = new URL("https://auth.example.test/authorize");
      authorizationUrl.searchParams.set("state", await interactiveProvider.state());
      await beforeAuthorization;
      await interactiveProvider.redirectToAuthorization(authorizationUrl);
      markReady();
      await authorizationGate;
      return "AUTHORIZED" as const;
    });
    clientCallToolMock
      .mockRejectedValueOnce(new UnauthorizedError())
      .mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const adapter = createMcpAdapter();
    await adapter.connectServer("runtime", {
      oauth: {
        type: "authorization_code",
      },
      type: "http",
      url: "https://mcp.example.test/mcp",
    });

    const call = adapter.callTool(
      {
        serverName: "runtime",
        toolName: "oauth_ping",
      },
      { timeoutMs: 20 },
    );

    try {
      await expect(observePromiseWithin(call, 200)).resolves.toMatchObject({
        reason: {
          name: "McpTimeoutError",
        },
        status: "rejected",
      });
      // 显式让 caller 先超时，再发布 URL，避免靠机器负载决定断言先后。
      startAuthorization();
      await ready;
      await expect(adapter.status()).resolves.toMatchObject({
        runtime: {
          authorization: {
            authorizationUrl: expect.stringContaining("https://auth.example.test/authorize"),
          },
          status: "connecting",
        },
      });

      releaseAuthorization();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const status = await adapter.status();
        if (status.runtime?.status === "connected") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await expect(adapter.status()).resolves.toMatchObject({
        runtime: { status: "connected" },
      });
      await expect(
        adapter.callTool(
          {
            serverName: "runtime",
            toolName: "oauth_ping",
          },
          { timeoutMs: 200 },
        ),
      ).resolves.toMatchObject({
        content: [{ text: "ok", type: "text" }],
      });
      expect(authMock).toHaveBeenCalledTimes(1);
      // 原 caller 已经超时，后台 recovery 只负责重连；不会替超时 caller 再执行工具。
      expect(clientCallToolMock).toHaveBeenCalledTimes(2);
    } finally {
      startAuthorization();
      releaseAuthorization();
      await Promise.allSettled([call]);
      await adapter.close();
    }
  });

  it("shares one runtime OAuth recovery across concurrent tool callers", async () => {
    let releaseAuthorization!: () => void;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    authMock.mockImplementation(async (provider: unknown) => {
      const interactiveProvider = provider as {
        redirectToAuthorization(url: URL): Promise<void>;
        state(): Promise<string>;
      };
      const authorizationUrl = new URL("https://auth.example.test/authorize");
      authorizationUrl.searchParams.set("state", await interactiveProvider.state());
      await interactiveProvider.redirectToAuthorization(authorizationUrl);
      await authorizationGate;
      return "AUTHORIZED" as const;
    });
    clientCallToolMock
      .mockRejectedValueOnce(new UnauthorizedError())
      .mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const adapter = createMcpAdapter();
    await adapter.connectServer("runtime", {
      oauth: {
        type: "authorization_code",
      },
      type: "http",
      url: "https://mcp.example.test/mcp",
    });

    const firstCall = adapter.callTool(
      {
        serverName: "runtime",
        toolName: "oauth_ping",
      },
      { timeoutMs: 2_000 },
    );

    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const status = await adapter.status();
        if (status.runtime?.authorization?.authorizationUrl) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(adapter.status()).resolves.toMatchObject({
        runtime: {
          authorization: {
            authorizationUrl: expect.stringContaining("https://auth.example.test/authorize"),
          },
          status: "connecting",
        },
      });

      const secondCall = adapter.callTool(
        {
          serverName: "runtime",
          toolName: "oauth_ping",
        },
        { timeoutMs: 2_000 },
      );
      await Promise.resolve();
      expect(clientCallToolMock).toHaveBeenCalledTimes(1);

      releaseAuthorization();
      await expect(Promise.all([firstCall, secondCall])).resolves.toMatchObject([
        { content: [{ text: "ok", type: "text" }] },
        { content: [{ text: "ok", type: "text" }] },
      ]);
      expect(authMock).toHaveBeenCalledTimes(1);
      // 第一次认证失败 + first caller 的一次安全重试 + second caller 的首次实际调用。
      expect(clientCallToolMock).toHaveBeenCalledTimes(3);
      await expect(adapter.status()).resolves.toMatchObject({
        runtime: { status: "connected" },
      });
    } finally {
      releaseAuthorization();
      await Promise.allSettled([firstCall]);
      await adapter.close();
    }
  });

  it("does not let a caller abort close the shared runtime OAuth callback listener", async () => {
    let authorizationContext:
      | {
          authorizationUrl: string;
          redirectUrl: string;
        }
      | undefined;
    authMock.mockImplementation(
      async (provider: unknown, options?: { authorizationCode?: string }) => {
        if (options?.authorizationCode) return "AUTHORIZED" as const;
        const interactiveProvider = provider as {
          redirectToAuthorization(url: URL): Promise<void>;
          state(): Promise<string>;
        };
        const authorizationUrl = new URL("https://auth.example.test/authorize");
        authorizationUrl.searchParams.set("state", await interactiveProvider.state());
        await interactiveProvider.redirectToAuthorization(authorizationUrl);
        return "REDIRECT" as never;
      },
    );
    clientCallToolMock
      .mockRejectedValueOnce(new UnauthorizedError())
      .mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const adapter = createMcpAdapter({
      mcpOAuth: {
        onAuthorizationRequired: async (context) => {
          authorizationContext = context;
        },
      },
    });
    await adapter.connectServer("runtime", {
      oauth: {
        type: "authorization_code",
      },
      type: "http",
      url: "https://mcp.example.test/mcp",
    });

    const abortController = new AbortController();
    const call = adapter.callTool(
      {
        serverName: "runtime",
        toolName: "oauth_ping",
      },
      {
        signal: abortController.signal,
        timeoutMs: 2_000,
      },
    );

    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (authorizationContext) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(authorizationContext).toBeDefined();

      abortController.abort(new Error("caller stopped"));
      await expect(observePromiseWithin(call, 200)).resolves.toMatchObject({
        reason: {
          message: "caller stopped",
        },
        status: "rejected",
      });

      const callbackUrl = new URL(authorizationContext!.redirectUrl);
      callbackUrl.searchParams.set("code", "authorized-after-caller-abort");
      callbackUrl.searchParams.set(
        "state",
        new URL(authorizationContext!.authorizationUrl).searchParams.get("state") ?? "",
      );
      await expect(fetch(callbackUrl)).resolves.toMatchObject({ ok: true });

      for (let attempt = 0; attempt < 50; attempt += 1) {
        const status = await adapter.status();
        if (status.runtime?.status === "connected") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(adapter.status()).resolves.toMatchObject({
        runtime: { status: "connected" },
      });
      expect(authMock).toHaveBeenCalledTimes(2);
      expect(clientConnectMock).toHaveBeenCalledTimes(2);
    } finally {
      await Promise.allSettled([call]);
      await adapter.close();
    }
  });

  it("converges Phase 2 orchestration errors to a retryable failed server status", async () => {
    const credentialError = new Error("Unable to read shared ZCode credentials");
    const credentialStore = {
      filePath: "/tmp/zcode-unreadable-credentials.json",
      load: vi.fn(async () => {
        throw credentialError;
      }),
      loadMany: vi.fn(async () => {
        throw credentialError;
      }),
    } as unknown as SharedZCodeCredentialStore;
    clientConnectMock.mockRejectedValue(new UnauthorizedError());
    const adapter = createMcpAdapter({
      mcpOAuth: {
        credentialStore,
      },
    });
    const config = {
      oauth: {
        type: "authorization_code" as const,
      },
      type: "http" as const,
      url: "https://mcp.example.test/mcp",
    };

    try {
      await expect(adapter.connectConfiguredServers({ broken: config })).resolves.toMatchObject({
        statuses: {
          broken: {
            error: "Unable to read shared ZCode credentials",
            failureKind: "oauth_authorization_failed",
            status: "failed",
          },
        },
      });
      await expect(adapter.status()).resolves.toMatchObject({
        broken: {
          failureKind: "oauth_authorization_failed",
          status: "failed",
        },
      });

      await expect(adapter.connectConfiguredServers({ broken: config })).resolves.toMatchObject({
        statuses: {
          broken: {
            failureKind: "oauth_authorization_failed",
            status: "failed",
          },
        },
      });
      expect(clientConnectMock).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close();
    }
  });

  it("only opens OAuth authorization URL when an opener is injected", async () => {
    const openAuthorizationUrl = vi.fn(async () => {});
    const { release: resolveConnect } = stubInteractiveAuthorization(
      "https://auth.example.test/authorize?state=state_test",
    );
    const adapter = createMcpAdapter({
      mcpOAuth: {
        openAuthorizationUrl,
      },
    });

    const connect = adapter.connectServer("notion", {
      type: "http",
      url: "https://mcp.example.test/mcp",
      oauth: {
        type: "authorization_code",
        clientName: "ZCode",
      },
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await adapter.status();
      if (status.notion?.authorization?.authorizationUrl) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(openAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationUrl: "https://auth.example.test/authorize?state=state_test",
        serverName: "notion",
      }),
    );

    resolveConnect();
    await expect(connect).resolves.toMatchObject({
      status: "connected",
      toolCount: 0,
    });
    await adapter.close();
  });
});
