import type {
  McpConnectionSnapshot,
  McpPort,
  McpServerConfig,
  McpServerStatus,
} from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMcpConnectionPool } from "../src/mcp/pool.js";
import { createMcpTelemetryTracker } from "../src/mcp/telemetry.js";

describe("MCP connection pool isolation", () => {
  it("closing a lease cancels its resource request without cancelling another session", async () => {
    const adapter = createFakeAdapter("fixture");
    const signals: AbortSignal[] = [];
    adapter.readResource = vi.fn(async (_request, options) => {
      signals.push(options!.signal!);
      return { contents: [] };
    });
    const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
    const a = pool.acquireLease(),
      b = pool.acquireLease();
    const config: McpServerConfig = { type: "stdio", command: "fixture", isolation: "workspace" };
    await Promise.all([a.connectServer("fixture", config), b.connectServer("fixture", config)]);
    await a.readResource!({ serverName: "fixture", uri: "test://a" });
    await b.readResource!({ serverName: "fixture", uri: "test://b" });
    await a.close();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(adapter.close).not.toHaveBeenCalled();
    await b.close();
    await pool.close();
  });

  it("shares startup waiters and rejects a released lease while another owner connects", async () => {
    const ready = Promise.withResolvers<void>();
    let initialized = false;
    const source = { identity: "trusted", generation: 1 };
    const connectServer = vi.fn(async () => {
      await ready.promise;
      initialized = true;
      return { status: "connected" };
    });
    const adapter = {
      connectServer,
      waitForAppConnection: async () => (initialized ? source : null),
      close: vi.fn(async () => {}),
    } as unknown as McpPort;
    const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
    const a = pool.acquireLease({ sessionId: "a" });
    const b = pool.acquireLease({ sessionId: "b" });
    const config: McpServerConfig = { type: "stdio", command: "fixture", isolation: "workspace" };
    const connecting = Promise.allSettled([
      a.connectServer("fixture", config),
      b.connectServer("fixture", config),
    ]);
    const released = a.waitForAppConnection!("fixture");
    const opening = b.waitForAppConnection!("fixture");
    await a.close();
    ready.resolve();
    expect((await connecting).map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(await released).toBeNull();
    expect(await opening).toEqual(source);
    expect(connectServer).toHaveBeenCalledOnce();
    await b.close();
    await pool.close();
  });

  it("reports one startup count snapshot for a session lease", async () => {
    const events: unknown[] = [];
    const telemetry = createMcpTelemetryTracker({
      idSalt: "device-a",
      onEvent: (event) => events.push(event),
    });
    const pool = createMcpConnectionPool({
      createAdapter: ({ config, serverName }) =>
        createFakeAdapterWithStatus(
          serverName,
          config.type,
          serverName === "pending" ? "connecting" : "connected",
        ),
      idleGraceMs: 0,
      telemetry,
    });
    const session = pool.acquireLease({ leaseId: "session-a", sessionId: "session-a" });

    await session.connectConfiguredServers({
      local: { command: "node", type: "stdio" },
      remote: { type: "http", url: "https://mcp.example.test" },
      pending: { command: "node", type: "stdio" },
    });
    await session.status();

    expect(events).toContainEqual(
      expect.objectContaining({
        configuredCount: 3,
        connectedCount: 2,
        failedCount: 1,
        kind: "session_startup",
        processCount: 1,
        sessionId: "session-a",
      }),
    );
    expect(
      events.filter((event) => (event as { kind?: string }).kind === "session_startup"),
    ).toHaveLength(1);

    await session.close();
    await pool.close();
  });

  it("reports a built-in plugin MCP process with the built-in telemetry source", async () => {
    let connectionId: string | undefined;
    const events: Array<{ kind: string; mcpId?: string; mcpSource?: string }> = [];
    const telemetry = createMcpTelemetryTracker({
      idSalt: "device-a",
      onEvent: (event) => events.push(event),
      randomId: () => "mcp-instance-1",
    });
    const pool = createMcpConnectionPool({
      createAdapter: ({ connectionContext, serverName }) => {
        connectionId = connectionContext.mcpConnectionId;
        return createFakeAdapter(serverName);
      },
      idleGraceMs: 0,
      telemetry,
    });
    const session = pool.acquireLease({ leaseId: "session-a", sessionId: "session-a" });

    await session.connectServer("plugin:browser-use:browser", {
      command: "node",
      source: { kind: "builtin" },
      type: "stdio",
    });
    telemetry.recordProcessStarted({ connectionId: connectionId!, pid: 10_001 });

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "process_start",
        mcpId: "builtin:browser-use:browser",
        mcpSource: "builtin",
      }),
    );

    await session.close();
    await pool.close();
  });

  it("reports a zero startup snapshot for a session without configured MCP servers", async () => {
    const events: unknown[] = [];
    const telemetry = createMcpTelemetryTracker({
      idSalt: "device-a",
      onEvent: (event) => events.push(event),
    });
    const pool = createMcpConnectionPool({
      createAdapter: ({ serverName }) => createFakeAdapter(serverName),
      idleGraceMs: 0,
      telemetry,
    });
    const session = pool.acquireLease({ leaseId: "session-a", sessionId: "session-a" });

    await session.status();

    expect(events).toEqual([
      expect.objectContaining({
        configuredCount: 0,
        connectedCount: 0,
        failedCount: 0,
        kind: "session_startup",
        processCount: 0,
        sessionId: "session-a",
      }),
    ]);
    await session.close();
    await pool.close();
  });

  it("shares only an explicitly workspace-isolated server in the same workspace", async () => {
    const created: Array<{
      adapter: McpPort;
      config: McpServerConfig;
      serverName: string;
    }> = [];
    const pool = createMcpConnectionPool({
      createAdapter: ({ config, serverName }) => {
        const adapter = createFakeAdapter(serverName);
        created.push({ adapter, config, serverName });
        return adapter;
      },
      idleGraceMs: 0,
    });
    const sessionA = pool.acquireLease({ leaseId: "session-a" });
    const sessionB = pool.acquireLease({ leaseId: "session-b" });
    const config: McpServerConfig = {
      command: "node",
      isolation: "workspace",
      protocolVersion: "2026-07-28",
      type: "stdio",
    };

    await sessionA.connectServer("browser_use", config, {
      workingDirectory: "/workspace",
      workspaceIdentity: "local-workspace-a",
    });
    await sessionB.connectServer("browser_use", config, {
      workingDirectory: "/workspace",
      workspaceIdentity: "local-workspace-a",
    });

    expect(created).toHaveLength(1);
    await sessionA.close();
    expect(created[0]?.adapter.close).not.toHaveBeenCalled();
    await sessionB.close();
    await Promise.resolve();
    expect(created[0]?.adapter.close).toHaveBeenCalledOnce();
    await pool.close();
  });

  it("keeps telemetry registration when a crashed workspace entry is reacquired during idle grace", async () => {
    let instanceSequence = 0;
    let connectionId: string | undefined;
    const events: Array<{ kind: string; mcpInstanceId?: string }> = [];
    const telemetry = createMcpTelemetryTracker({
      idSalt: "device-a",
      onEvent: (event) => events.push(event),
      randomId: () => `mcp-instance-${++instanceSequence}`,
    });
    const createAdapter = vi.fn(
      ({
        connectionContext,
        serverName,
      }: Parameters<Parameters<typeof createMcpConnectionPool>[0]["createAdapter"]>[0]) => {
        connectionId = connectionContext.mcpConnectionId;
        return createFakeAdapter(serverName);
      },
    );
    const pool = createMcpConnectionPool({
      createAdapter,
      idleGraceMs: 60_000,
      telemetry,
    });
    const config: McpServerConfig = {
      command: "node",
      isolation: "workspace",
      type: "stdio",
    };
    const connectOptions = {
      workingDirectory: "/workspace",
      workspaceIdentity: "local-workspace-a",
    };
    const sessionA = pool.acquireLease({ leaseId: "session-a", sessionId: "session-a" });

    await sessionA.connectServer("browser_use", config, connectOptions);
    expect(connectionId).toEqual(expect.any(String));
    telemetry.recordProcessStarted({ connectionId: connectionId!, pid: 10_001 });
    telemetry.recordProcessCrashed({ connectionId: connectionId!, exitCode: 23, signal: null });
    await sessionA.close();

    const sessionB = pool.acquireLease({ leaseId: "session-b", sessionId: "session-b" });
    await sessionB.connectServer("browser_use", config, connectOptions);
    const restarted = telemetry.recordProcessStarted({ connectionId: connectionId!, pid: 10_002 });

    expect(createAdapter).toHaveBeenCalledOnce();
    expect(restarted).toEqual({
      mcpId: expect.stringMatching(/^custom:[a-f0-9]{12}$/),
      mcpInstanceId: "mcp-instance-2",
    });
    expect(events.map((event) => [event.kind, event.mcpInstanceId])).toEqual([
      ["process_start", "mcp-instance-1"],
      ["process_crash", "mcp-instance-1"],
      ["process_start", "mcp-instance-2"],
    ]);

    await sessionB.close();
    await pool.close();
  });

  it("does not share default/legacy servers or remote workspaces with different identities", async () => {
    const createAdapter = vi.fn(({ serverName }: { serverName: string }) =>
      createFakeAdapter(serverName),
    );
    const pool = createMcpConnectionPool({ createAdapter, idleGraceMs: 0 });
    const sessionA = pool.acquireLease({ leaseId: "session-a" });
    const sessionB = pool.acquireLease({ leaseId: "session-b" });
    const legacy: McpServerConfig = { command: "node", type: "stdio" };

    await sessionA.connectServer("legacy", legacy, {
      workingDirectory: "/same-path",
    });
    await sessionB.connectServer("legacy", legacy, {
      workingDirectory: "/same-path",
    });
    expect(createAdapter).toHaveBeenCalledTimes(2);

    const shared: McpServerConfig = {
      command: "node",
      isolation: "workspace",
      type: "stdio",
    };
    await sessionA.connectServer("browser_use", shared, {
      workingDirectory: "/same-path",
      workspaceIdentity: "ssh://host-a/workspace",
    });
    await sessionB.connectServer("browser_use", shared, {
      workingDirectory: "/same-path",
      workspaceIdentity: "ssh://host-b/workspace",
    });
    expect(createAdapter).toHaveBeenCalledTimes(4);

    await sessionA.close();
    await sessionB.close();
    await pool.close();
  });

  it("logs connection identity and each session lease for a shared workspace server", async () => {
    const info = vi.fn();
    const logger = {
      child: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      info,
      warn: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    const connectionContexts: unknown[] = [];
    const pool = createMcpConnectionPool({
      createAdapter: ({ connectionContext, serverName }) => {
        connectionContexts.push(connectionContext);
        return createFakeAdapter(serverName);
      },
      idleGraceMs: 0,
      logger,
    });
    const sessionA = pool.acquireLease({
      leaseId: "session-a",
      sessionId: "session-a",
    });
    const sessionB = pool.acquireLease({
      leaseId: "session-b",
      sessionId: "session-b",
    });
    const config: McpServerConfig = {
      command: "node",
      isolation: "workspace",
      protocolVersion: "2026-07-28",
      type: "stdio",
    };

    await sessionA.connectServer("browser_use", config, {
      workingDirectory: "/workspace/path",
      workspaceIdentity: "remote:workspace-a",
    });
    await sessionB.connectServer("browser_use", config, {
      workingDirectory: "/workspace/path",
      workspaceIdentity: "remote:workspace-a",
    });

    expect(connectionContexts).toEqual([
      {
        mcpConnectionId: expect.any(String),
        mcpIsolation: "workspace",
        workspaceKey: "remote:workspace-a",
      },
    ]);
    const connectionId = (connectionContexts[0] as { mcpConnectionId: string }).mcpConnectionId;
    expect(info).toHaveBeenCalledWith(
      "MCP pooled connection created",
      expect.objectContaining({
        event: "mcp.pool.connection.created",
        mcpConnectionId: connectionId,
        mcpIsolation: "workspace",
        workspaceKey: "remote:workspace-a",
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "MCP connection lease acquired",
      expect.objectContaining({
        event: "mcp.pool.lease.acquired",
        mcpConnectionId: connectionId,
        refCount: 1,
        sessionId: "session-a",
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "MCP connection lease acquired",
      expect.objectContaining({
        event: "mcp.pool.lease.acquired",
        mcpConnectionId: connectionId,
        refCount: 2,
        sessionId: "session-b",
      }),
    );

    await sessionA.close();
    expect(info).toHaveBeenCalledWith(
      "MCP connection lease released",
      expect.objectContaining({
        event: "mcp.pool.lease.released",
        mcpConnectionId: connectionId,
        refCount: 1,
        sessionId: "session-a",
      }),
    );
    await sessionB.close();
    await Promise.resolve();
    expect(info).toHaveBeenCalledWith(
      "MCP connection lease released",
      expect.objectContaining({
        event: "mcp.pool.lease.released",
        mcpConnectionId: connectionId,
        refCount: 0,
        sessionId: "session-b",
      }),
    );
    await pool.close();
  });

  it("binds a session-isolated connection to its session in diagnostics", async () => {
    const createAdapter = vi.fn(({ serverName }: { serverName: string }) =>
      createFakeAdapter(serverName),
    );
    const pool = createMcpConnectionPool({ createAdapter, idleGraceMs: 0 });
    const session = pool.acquireLease({
      leaseId: "session-a",
      sessionId: "session-a",
    });

    await session.connectServer(
      "node_repl",
      { command: "node", type: "stdio" },
      { workingDirectory: "/workspace" },
    );

    expect(createAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionContext: {
          mcpConnectionId: expect.any(String),
          mcpIsolation: "session",
          sessionId: "session-a",
          workspaceKey: "/workspace",
        },
      }),
    );
    await session.close();
    await pool.close();
  });
});

// 受管 worktree（docs/git/worktree.md §7.2 / §9.3）：连接分组按工作目录，会话 key 只透传给 adapter
// 用于发往 Host 的官方 MCP 授权头。
describe("MCP connection pool session workspace key", () => {
  it("passes the session workspace key to the adapter without changing the pool scope", async () => {
    const createAdapter = vi.fn(({ serverName }: { serverName: string }) =>
      createFakeAdapter(serverName),
    );
    const pool = createMcpConnectionPool({ createAdapter, idleGraceMs: 0 });
    const session = pool.acquireLease({ leaseId: "session-a", sessionId: "session-a" });

    await session.connectServer(
      "node_repl",
      { command: "node", type: "stdio" },
      { workingDirectory: "/data/.zcode/worktrees/3f2a/repo", workspaceKey: "/projects/repo" },
    );

    expect(createAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionContext: expect.objectContaining({
          workspaceKey: "/data/.zcode/worktrees/3f2a/repo",
        }),
        workingDirectory: "/data/.zcode/worktrees/3f2a/repo",
        workspaceKey: "/projects/repo",
      }),
    );
    await session.close();
    await pool.close();
  });

  it("does not share a workspace connection between sessions with different workspace keys", async () => {
    const createAdapter = vi.fn(({ serverName }: { serverName: string }) =>
      createFakeAdapter(serverName),
    );
    const pool = createMcpConnectionPool({ createAdapter, idleGraceMs: 0 });
    const config = { command: "node", type: "stdio" as const, isolation: "workspace" as const };
    const cwd = "/data/.zcode/worktrees/3f2a/repo";
    // 同一 cwd：一个是源项目的 worktree 会话，一个把该目录单独添加成项目（MR !3520 review SG-01）。
    const leases = [
      pool.acquireLease({ leaseId: "a", sessionId: "a" }),
      pool.acquireLease({ leaseId: "b", sessionId: "b" }),
      pool.acquireLease({ leaseId: "c", sessionId: "c" }),
    ];
    await leases[0]!.connectServer("shared", config, {
      workingDirectory: cwd,
      workspaceKey: "/projects/repo",
    });
    await leases[1]!.connectServer("shared", config, { workingDirectory: cwd, workspaceKey: cwd });
    await leases[2]!.connectServer("shared", config, {
      workingDirectory: cwd,
      workspaceKey: "/projects/repo",
    });

    expect(
      createAdapter.mock.calls.map(([input]) => (input as { workspaceKey?: string }).workspaceKey),
    ).toEqual(["/projects/repo", cwd]);
    for (const lease of leases) await lease.close();
    await pool.close();
  });
});

// Bugfix 回归：设置页刷新走进程级 `protocol-settings` lease，配置不变时命中同一个 pool entry。
// 过去 acquire 直接返回首次连接那个 resolve 过的 promise，停掉的 HTTP MCP 永远显示已连接。
describe("MCP connection pool revalidation", () => {
  const config: McpServerConfig = { type: "http", url: "https://mcp.example/sse" };

  it("keeps a live connection when the ping succeeds", async () => {
    const adapter = createControllableAdapter("official_tools");
    const createAdapter = vi.fn(() => adapter);
    const pool = createMcpConnectionPool({ createAdapter, idleGraceMs: 0 });
    const settings = pool.acquireLease({ leaseId: "protocol-settings" });

    await settings.connectConfiguredServers({ official_tools: config }, { revalidate: true });
    await settings.connectConfiguredServers({ official_tools: config }, { revalidate: true });

    expect(createAdapter).toHaveBeenCalledOnce();
    expect(adapter.connectServer).toHaveBeenCalledOnce();
    expect(adapter.pingServer).toHaveBeenCalledOnce();
    await pool.close();
  });

  it("reconnects the same pooled entry when the ping reports a dead transport", async () => {
    const adapter = createControllableAdapter("official_tools");
    const createAdapter = vi.fn(() => adapter);
    const pool = createMcpConnectionPool({ createAdapter, idleGraceMs: 0 });
    const settings = pool.acquireLease({ leaseId: "protocol-settings" });

    await settings.connectConfiguredServers({ official_tools: config }, { revalidate: true });
    adapter.alive = false;
    const snapshot = await settings.connectConfiguredServers(
      { official_tools: config },
      { revalidate: true },
    );

    // 原地重连：adapter/entry 身份不变，共享同一连接的其他 lease 不会掉成 "not leased"。
    expect(createAdapter).toHaveBeenCalledOnce();
    expect(adapter.connectServer).toHaveBeenCalledTimes(2);
    expect(snapshot.statuses.official_tools?.status).toBe("connected");
    await pool.close();
  });

  it("reconnects a pooled entry that already knows it is disconnected", async () => {
    const adapter = createControllableAdapter("node_repl");
    const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
    const settings = pool.acquireLease({ leaseId: "protocol-settings" });

    await settings.connectConfiguredServers({ node_repl: config }, { revalidate: true });
    // stdio 的 onclose 已经把 record 标成 disconnected；刷新必须重试，而不是回放这条旧失败。
    adapter.setStatus("disconnected");
    await settings.connectConfiguredServers({ node_repl: config }, { revalidate: true });

    expect(adapter.connectServer).toHaveBeenCalledTimes(2);
    expect(adapter.pingServer).not.toHaveBeenCalled();
    await pool.close();
  });

  it("does not disturb an in-flight OAuth handshake", async () => {
    const adapter = createControllableAdapter("oauth_server");
    const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
    const settings = pool.acquireLease({ leaseId: "protocol-settings" });

    await settings.connectConfiguredServers({ oauth_server: config }, { revalidate: true });
    adapter.setStatus("connecting");
    await settings.connectConfiguredServers({ oauth_server: config }, { revalidate: true });

    expect(adapter.connectServer).toHaveBeenCalledOnce();
    expect(adapter.pingServer).not.toHaveBeenCalled();
    await pool.close();
  });

  it("treats a port without ping support as alive", async () => {
    const adapter = createFakeAdapter("legacy_port");
    const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
    const settings = pool.acquireLease({ leaseId: "protocol-settings" });

    await settings.connectConfiguredServers({ legacy_port: config }, { revalidate: true });
    await settings.connectConfiguredServers({ legacy_port: config }, { revalidate: true });

    expect(adapter.connectServer).toHaveBeenCalledOnce();
    await pool.close();
  });

  it("skips revalidation when the caller does not ask for it", async () => {
    const adapter = createControllableAdapter("official_tools");
    const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
    const session = pool.acquireLease({ leaseId: "session-a", sessionId: "session-a" });

    await session.connectConfiguredServers({ official_tools: config });
    adapter.alive = false;
    await session.connectConfiguredServers({ official_tools: config });

    // session 启动复用刚建立的连接，不该为每次收敛付一次 ping。
    expect(adapter.pingServer).not.toHaveBeenCalled();
    expect(adapter.connectServer).toHaveBeenCalledOnce();
    await pool.close();
  });

  it("shares one revalidation between concurrent refreshes", async () => {
    const adapter = createControllableAdapter("official_tools");
    const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
    const settings = pool.acquireLease({ leaseId: "protocol-settings" });

    await settings.connectConfiguredServers({ official_tools: config }, { revalidate: true });
    adapter.alive = false;
    await Promise.all([
      settings.connectConfiguredServers({ official_tools: config }, { revalidate: true }),
      settings.connectConfiguredServers({ official_tools: config }, { revalidate: true }),
    ]);

    expect(adapter.connectServer).toHaveBeenCalledTimes(2);
    await pool.close();
  });
});

interface ControllableAdapter extends McpPort {
  alive: boolean;
  setStatus: (status: McpServerStatus["status"]) => void;
  connectServer: McpPort["connectServer"] & { mock: { calls: unknown[] } };
  pingServer: NonNullable<McpPort["pingServer"]> & { mock: { calls: unknown[] } };
}

function createControllableAdapter(serverName: string): ControllableAdapter {
  let status: McpServerStatus = {
    status: "connected",
    toolCount: 1,
    transport: "http",
    updatedAt: new Date(0).toISOString(),
  };
  const adapter = {
    alive: true,
    setStatus: (next: McpServerStatus["status"]) => {
      status = { ...status, status: next };
    },
    callTool: vi.fn(async () => ({ content: [{ text: "ok", type: "text" }] })),
    close: vi.fn(async () => undefined),
    connectConfiguredServers: vi.fn(
      async (): Promise<McpConnectionSnapshot> => ({
        statuses: { [serverName]: status },
        tools: [],
      }),
    ),
    connectServer: vi.fn(async () => {
      adapter.alive = true;
      status = { ...status, status: "connected" };
      return status;
    }),
    disconnectServer: vi.fn(async () => ({ ...status, status: "disconnected" as const })),
    listTools: vi.fn(async () => []),
    pingServer: vi.fn(async () => adapter.alive),
    status: vi.fn(async () => ({ [serverName]: status })),
  } as unknown as ControllableAdapter;
  return adapter;
}

function createFakeAdapter(serverName: string): McpPort {
  const status: McpServerStatus = {
    status: "connected",
    toolCount: 1,
    transport: "stdio",
    updatedAt: new Date(0).toISOString(),
  };
  return {
    callTool: vi.fn(async () => ({ content: [{ text: "ok", type: "text" }] })),
    close: vi.fn(async () => undefined),
    connectConfiguredServers: vi.fn(
      async (): Promise<McpConnectionSnapshot> => ({
        statuses: { [serverName]: status },
        tools: [],
      }),
    ),
    connectServer: vi.fn(async () => status),
    disconnectServer: vi.fn(async () => ({
      ...status,
      status: "disconnected",
    })),
    listTools: vi.fn(async () => []),
    status: vi.fn(async () => ({ [serverName]: status })),
  };
}

function createFakeAdapterWithStatus(
  serverName: string,
  transport: McpServerStatus["transport"],
  statusKind: McpServerStatus["status"],
): McpPort {
  const status: McpServerStatus = {
    status: statusKind,
    toolCount: statusKind === "connected" ? 1 : 0,
    transport,
    updatedAt: new Date(0).toISOString(),
  };
  return {
    callTool: vi.fn(async () => ({ content: [{ text: "ok", type: "text" }] })),
    close: vi.fn(async () => undefined),
    connectConfiguredServers: vi.fn(async () => ({
      statuses: { [serverName]: status },
      tools: [],
    })),
    connectServer: vi.fn(async () => status),
    disconnectServer: vi.fn(async () => ({ ...status, status: "disconnected" })),
    listTools: vi.fn(async () => []),
    status: vi.fn(async () => ({ [serverName]: status })),
  };
}

it("cancels one session waiter without cancelling the pooled connection or another waiter", async () => {
  const connected = Promise.withResolvers<McpServerStatus>();
  let signal: AbortSignal | undefined;
  const adapter = {
    connectServer: vi.fn((_name, _config, options) => {
      signal = options?.signal;
      return connected.promise;
    }),
    close: vi.fn(async () => {}),
  } as unknown as McpPort;
  const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
  const a = pool.acquireLease({ sessionId: "a" }),
    b = pool.acquireLease({ sessionId: "b" });
  const abort = new AbortController();
  const config: McpServerConfig = { type: "stdio", command: "fixture", isolation: "workspace" };
  const openingA = a.connectServer("fixture", config, { signal: abort.signal });
  const checked = expect(openingA).rejects.toThrow();
  const openingB = b.connectServer("fixture", config);
  abort.abort(new Error("session closed"));
  expect(signal?.aborted).not.toBe(true);
  await checked;
  await a.close();
  connected.resolve({ status: "connected", transport: "stdio", toolCount: 0, updatedAt: "now" });
  expect((await openingB).status).toBe("connected");
  expect(adapter.close).not.toHaveBeenCalled();
  await expect(a.connectServer("fixture", config)).rejects.toThrow();
  await b.close();
  await pool.close();
});

it("lease close interrupts an in-flight connection wait and forbids late reacquisition", async () => {
  const connecting = Promise.withResolvers<McpServerStatus>();
  const adapter = {
    connectServer: () => connecting.promise,
    close: async () => {},
  } as unknown as McpPort;
  const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
  const lease = pool.acquireLease();
  const pending = lease.connectServer("fixture", { type: "stdio", command: "fixture" });
  const checked = expect(pending).rejects.toThrow();
  await lease.close();
  await checked;
  connecting.resolve({ status: "connected", transport: "stdio", toolCount: 0, updatedAt: "now" });
  await expect(
    lease.connectServer("fixture", { type: "stdio", command: "fixture" }),
  ).rejects.toThrow();
  await pool.close();
});
