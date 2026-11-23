import type { McpPort, McpServerConfig } from "@zcode/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpAdapter } from "../src/mcp/index.js";
import { createMcpConnectionPool } from "../src/mcp/pool.js";
import {
  startControlledHttpMcpServer,
  type ControlledHttpMcpOptions,
  type ControlledHttpMcpServer,
} from "./fixtures/controlled-http-mcp-server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer(options: ControlledHttpMcpOptions = {}) {
  const server = await startControlledHttpMcpServer({ sessionCheck: true, ...options });
  cleanups.push(() => server.close());
  return server;
}

function httpConfig(server: ControlledHttpMcpServer, extra: Partial<McpServerConfig> = {}) {
  return { type: "http", url: server.url, protocolVersion: "legacy", ...extra } as McpServerConfig;
}

function adapterFor(): McpPort {
  const adapter = createMcpAdapter({ env: {} });
  cleanups.push(() => adapter.close());
  return adapter;
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const ping = { serverName: "remote", toolName: "ping", arguments: {} };

describe("HTTP connection classification", () => {
  it.each(["404", "405"] as const)(
    "keeps a stateful connection when GET returns %s",
    async (getMode) => {
      const server = await startServer({ getMode });
      const adapter = adapterFor();
      await expect(adapter.connectServer("remote", httpConfig(server))).resolves.toMatchObject({
        status: "connected",
      });
      // GET 打开事件流失败只说明 server 不提供推送流，不能据此重建连接。
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(adapter.getToolSnapshot().remote?.status.status).toBe("connected");
      await expect(adapter.callTool(ping)).resolves.toMatchObject({
        content: [{ text: "ok:ping" }],
      });
      expect(server.stats.initializations).toBe(1);
    },
  );

  it("publishes a final connection failure once", async () => {
    const server = await startServer({ onInitialize: () => ({ status: 503 }) });
    const adapter = adapterFor();
    const failedObservations: string[] = [];
    adapter.onSnapshotChanged?.(() => {
      const row = adapter.getToolSnapshot().remote;
      if (row?.status.status === "failed") failedObservations.push(row.status.updatedAt);
    });
    await expect(adapter.connectServer("remote", httpConfig(server))).resolves.toMatchObject({
      status: "failed",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(failedObservations).toHaveLength(1);
  });

  it("invalidates after three consecutive network failures and resets on any response", async () => {
    let mode: "destroy" | "ok" = "ok";
    const server = await startServer({
      onToolCall: () => (mode === "destroy" ? { kind: "destroy" } : undefined),
    });
    const adapter = adapterFor();
    await adapter.connectServer("remote", httpConfig(server));
    const fail = async () => {
      mode = "destroy";
      await expect(adapter.callTool(ping)).rejects.toBeDefined();
    };
    await fail();
    await fail();
    mode = "ok";
    await expect(adapter.callTool(ping)).resolves.toBeDefined();
    await fail();
    await fail();
    expect(adapter.getToolSnapshot().remote?.status.status).toBe("connected");
    expect(server.stats.initializations).toBe(1);
    // 前两次响应丢失没有重发。
    expect(server.stats.arrivals.ping).toBe(5);
    await fail();
    // 第三次连续网络失败说明 server 不可达：关闭旧 client 并进入恢复（pending 保留目录）。
    // 这次调用因此以连接关闭结束，在新连接上重试一次。
    await until(() => server.stats.initializations === 2);
    expect(server.stats.arrivals.ping).toBe(7);
  });

  it("detects a dead server through its event stream", async () => {
    const server = await startServer({ getMode: "hold" });
    const adapter = adapterFor();
    await adapter.connectServer("remote", httpConfig(server));
    await until(() => server.stats.gets === 1);
    await server.close();
    // 只有事件流的 server 停掉后：流体错误与重开失败连续计数，第三次触发恢复。
    await until(() => adapter.getToolSnapshot().remote?.status.status !== "connected", 8_000);
  }, 15_000);

  it("does not start interactive authorization while recovering", async () => {
    let requireAuth = false;
    const server = await startServer({
      onInitialize: () => (requireAuth ? { status: 401 } : undefined),
    });
    const opened: string[] = [];
    const adapter = createMcpAdapter({
      env: {},
      mcpOAuth: { openAuthorizationUrl: async (url) => void opened.push(String(url)) },
    });
    cleanups.push(() => adapter.close());
    await adapter.connectServer("remote", httpConfig(server));
    requireAuth = true;
    server.expireSessions();
    await expect(adapter.callTool(ping)).rejects.toBeDefined();
    // 恢复遇到 401 时立即结束，不访问授权元数据，也不打开授权页面。
    await until(() => adapter.getToolSnapshot().remote?.status.status === "failed");
    expect(adapter.getToolSnapshot().remote?.status.failureKind).toBe("oauth_authorization_failed");
    expect(server.stats.initializations).toBe(2);
    expect(server.stats.discoveryRequests).toBe(0);
    expect(opened).toEqual([]);
  });
});

describe("tool call retry after reconnect", () => {
  it("retries once after the HTTP session expires", async () => {
    const server = await startServer();
    const adapter = adapterFor();
    await adapter.connectServer("remote", httpConfig(server));
    server.expireSessions();
    await expect(adapter.callTool(ping)).resolves.toMatchObject({
      content: [{ text: "ok:ping" }],
    });
    expect(server.stats.arrivals.ping).toBe(2);
    expect(server.stats.executed.ping).toBe(1);
    expect(server.stats.initializations).toBe(2);
  });

  it("retries concurrent callers that both saw the expired session", async () => {
    const server = await startServer();
    const adapter = adapterFor();
    await adapter.connectServer("remote", httpConfig(server));
    server.expireSessions();
    const results = await Promise.all([adapter.callTool(ping), adapter.callTool(ping)]);
    expect(results).toHaveLength(2);
    expect(server.stats.arrivals.ping).toBe(4);
    expect(server.stats.executed.ping).toBe(2);
    expect(server.stats.initializations).toBe(2);
  });

  it.each([
    [
      "a 400 session body",
      {
        kind: "http",
        status: 400,
        body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: No valid session ID provided"},"id":null}',
      },
    ],
    [
      "a JSON-RPC connection closed error",
      { kind: "rpc-error", code: -32000, message: "Connection closed" },
    ],
  ] as const)("retries once after %s", async (_label, firstReply) => {
    const server = await startServer({
      onToolCall: (_name, { arrival }) => (arrival === 1 ? firstReply : undefined),
    });
    const adapter = adapterFor();
    await adapter.connectServer("remote", httpConfig(server));
    await expect(adapter.callTool(ping)).resolves.toMatchObject({
      content: [{ text: "ok:ping" }],
    });
    expect(server.stats.arrivals.ping).toBe(2);
    expect(server.stats.initializations).toBe(2);
  });

  it("re-executes an in-flight call when another request expires the session", async () => {
    const firstSlow = Promise.withResolvers<void>();
    const slowStarted = Promise.withResolvers<void>();
    let sideEffects = 0;
    const server = await startServer({
      tools: ["ping", "slow"],
      onToolCall: async (name, { arrival }) => {
        if (name !== "slow") return undefined;
        sideEffects++;
        if (arrival === 1) {
          slowStarted.resolve();
          await firstSlow.promise;
        }
        return undefined;
      },
    });
    const adapter = adapterFor();
    await adapter.connectServer("remote", httpConfig(server));
    const slow = adapter.callTool({ serverName: "remote", toolName: "slow", arguments: {} });
    await slowStarted.promise;
    server.expireSessions();
    await expect(adapter.callTool(ping)).resolves.toBeDefined();
    // 会话过期关闭旧 client，在途长调用收到连接关闭并重试一次：服务端副作用发生两次。
    await expect(slow).resolves.toMatchObject({ content: [{ text: "ok:slow" }] });
    firstSlow.resolve();
    expect(sideEffects).toBe(2);
  });

  it.each([
    [
      "the server answered with a JSON-RPC error",
      { kind: "rpc-error", code: -32000, message: "Not connected" },
    ],
    ["the response was lost", { kind: "destroy" }],
    ["the server returned 500", { kind: "http", status: 500, body: "boom" }],
  ] as const)("does not retry when %s", async (_label, reply) => {
    const server = await startServer({ onToolCall: () => reply });
    const adapter = adapterFor();
    await adapter.connectServer("remote", httpConfig(server));
    await expect(adapter.callTool(ping)).rejects.toBeDefined();
    expect(server.stats.arrivals.ping).toBe(1);
    expect(server.stats.initializations).toBe(1);
  });

  it.each(["replaced", "closed"] as const)(
    "does not retry when the adapter is %s during the reconnect wait",
    async (change) => {
      const reconnect = Promise.withResolvers<void>();
      const reconnecting = Promise.withResolvers<void>();
      const server = await startServer({
        onInitialize: async (count) => {
          if (count !== 2) return;
          reconnecting.resolve();
          await reconnect.promise;
        },
      });
      const adapter = adapterFor();
      await adapter.connectServer("remote", httpConfig(server));
      server.expireSessions();
      const call = adapter.callTool(ping);
      await reconnecting.promise;
      if (change === "replaced") {
        void adapter.connectServer("remote", httpConfig(server, { timeoutMs: 12_345 }));
      } else {
        void adapter.close();
      }
      reconnect.resolve();
      await expect(call).rejects.toBeDefined();
      expect(server.stats.executed.ping ?? 0).toBe(0);
    },
  );

  it("does not retry for a lease released during the reconnect wait", async () => {
    const reconnect = Promise.withResolvers<void>();
    const reconnecting = Promise.withResolvers<void>();
    const server = await startServer({
      onInitialize: async (count) => {
        if (count !== 2) return;
        reconnecting.resolve();
        await reconnect.promise;
      },
    });
    const pool = createMcpConnectionPool({
      createAdapter: () => createMcpAdapter({ env: {} }),
      idleGraceMs: 0,
    });
    cleanups.push(() => pool.close());
    const config = httpConfig(server, { isolation: "workspace" });
    const scope = { workspaceIdentity: "shared" };
    const first = pool.acquireLease({ sessionId: "A" });
    const second = pool.acquireLease({ sessionId: "B" });
    await first.connectServer("remote", config, scope);
    await second.connectServer("remote", config, scope);
    server.expireSessions();
    const call = first.callTool(ping);
    await reconnecting.promise;
    await first.disconnectServer("remote");
    reconnect.resolve();
    await expect(call).rejects.toBeDefined();
    expect(server.stats.executed.ping ?? 0).toBe(0);
    // 另一个租约仍持有同一连接，可以继续调用。
    await expect(second.callTool(ping)).resolves.toBeDefined();
  });

  it("rejects an App call after the connection changes without retrying", async () => {
    const server = await startServer();
    const adapter = adapterFor();
    await adapter.connectServer("remote", httpConfig(server));
    const appConnection = adapter.appConnectionSnapshot!("remote")!;
    server.expireSessions();
    await expect(adapter.callTool(ping, { appConnection })).rejects.toBeDefined();
    await until(() => adapter.getToolSnapshot().remote?.status.status === "connected");
    // App 固定原连接：换代后拒绝，且不在新连接上重放。
    await expect(adapter.callTool(ping, { appConnection })).rejects.toThrow(/connection changed/);
    expect(server.stats.executed.ping ?? 0).toBe(0);
    // 模型调用晚绑定当前连接，同配置重连后继续可用。
    await expect(adapter.callTool(ping)).resolves.toBeDefined();
  });
});

describe("configuration identity", () => {
  it("shares one connection for configs that differ only by undefined fields", async () => {
    const server = await startServer();
    const pool = createMcpConnectionPool({
      createAdapter: () => createMcpAdapter({ env: {} }),
      idleGraceMs: 0,
    });
    cleanups.push(() => pool.close());
    const scope = { workspaceIdentity: "shared" };
    const first = pool.acquireLease({ sessionId: "A" });
    const second = pool.acquireLease({ sessionId: "B" });
    await first.connectServer("remote", httpConfig(server, { isolation: "workspace" }), scope);
    await second.connectServer(
      "remote",
      httpConfig(server, { isolation: "workspace", timeoutMs: undefined }),
      scope,
    );
    expect(pool.stats().activeConnections).toBe(1);
    expect(server.stats.initializations).toBe(1);
    expect(first.getToolSnapshot().remote?.status.status).toBe("connected");
  });

  it("reconnects a failed server on explicit revalidation", async () => {
    const server = await startServer({
      onInitialize: (count) => (count === 1 ? { status: 503 } : undefined),
    });
    const adapter = adapterFor();
    await expect(adapter.connectServer("remote", httpConfig(server))).resolves.toMatchObject({
      status: "failed",
    });
    // 同配置的普通连接请求只复用当前记录，不重启失败连接。
    await expect(adapter.connectServer("remote", httpConfig(server))).resolves.toMatchObject({
      status: "failed",
    });
    await expect(
      adapter.connectServer("remote", httpConfig(server), { revalidate: true }),
    ).resolves.toMatchObject({ status: "connected" });
    expect(server.stats.initializations).toBe(2);
  });
});
