import type { Logger } from "@zcode/contracts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createMcpAdapter } from "../src/mcp/index.js";
import { createMcpConnectionPool } from "../src/mcp/pool.js";

type Reply = { kind: "ok" } | { kind: "rpc-error"; code: number; message: string };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startResourceServer() {
  const calls: string[] = [];
  const replies = new Map<string, Reply[]>();
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    if (String(message.method).startsWith("resources/")) calls.push(message.method);
    const reply = replies.get(message.method)?.shift() ?? { kind: "ok" };
    const headers = { "content-type": "application/json", "mcp-session-id": "controlled" };
    if (reply.kind === "rpc-error") {
      response.writeHead(200, headers).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: reply.code, message: reply.message },
        }),
      );
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "controlled", version: "1" },
            capabilities: { tools: {}, resources: { subscribe: true } },
          }
        : message.method === "tools/list"
          ? { tools: [] }
          : {};
    response
      .writeHead(200, headers)
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    calls,
    reply: (method: string, value: Reply) =>
      replies.set(method, [...(replies.get(method) ?? []), value]),
    config: {
      type: "http" as const,
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
      protocolVersion: "legacy" as const,
    },
  };
}

function captureLogger() {
  const lines: Array<{ message: string; event?: unknown; status?: unknown }> = [];
  const record = (message: string, fields?: Record<string, unknown>) =>
    lines.push({ message, event: fields?.event, status: fields?.status });
  const logger: Logger = {
    child: () => logger,
    debug: record,
    info: record,
    warn: record,
    error: record,
  };
  return { logger, lines };
}

it("keeps the confirmed state when the server rejects a subscription", async () => {
  const server = await startResourceServer();
  const adapter = createMcpAdapter({ env: {} });
  cleanups.push(() => adapter.close());
  await adapter.connectServer("remote", server.config);
  server.reply("resources/subscribe", {
    kind: "rpc-error",
    code: -32002,
    message: "Resource not found",
  });
  await expect(
    adapter.subscribeResource!({ serverName: "remote", uri: "test://missing", subscriberKey: "k" }),
  ).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 100));
  // 服务端明确拒绝说明远端没有订阅，不能再补发一次退订。
  expect(server.calls).toEqual(["resources/subscribe"]);
  expect(adapter.resourceSubscriptionCounts?.()).toEqual({ remote: {} });
});

it("logs an unsubscribe only after it was sent", async () => {
  const server = await startResourceServer();
  const { logger, lines } = captureLogger();
  const adapter = createMcpAdapter({ env: {}, logger });
  cleanups.push(() => adapter.close());
  await adapter.connectServer("remote", server.config);
  const controller = new AbortController();
  const subscribing = adapter.subscribeResource!(
    { serverName: "remote", uri: "test://a", subscriberKey: "k" },
    { signal: controller.signal },
  );
  controller.abort(new Error("cancelled"));
  await expect(subscribing).rejects.toThrow("cancelled");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(server.calls).toEqual([]);
  expect(lines.filter((line) => line.event === "mcp.resource.unsubscribe")).toEqual([]);
});

it("releases a session's subscriptions when its lease releases the server", async () => {
  const server = await startResourceServer();
  const pool = createMcpConnectionPool({
    createAdapter: () => createMcpAdapter({ env: {} }),
    idleGraceMs: 0,
  });
  cleanups.push(() => pool.close());
  const config = { ...server.config, isolation: "workspace" as const };
  const scope = { workspaceIdentity: "shared" };
  const first = pool.acquireLease({ sessionId: "A" });
  const second = pool.acquireLease({ sessionId: "B" });
  await first.connectServer("remote", config, scope);
  await second.connectServer("remote", config, scope);
  await first.subscribeResource!({ serverName: "remote", uri: "test://a", subscriberKey: "A|i|s" });
  // 配置删除使本会话释放该 server；共享连接仍由另一个会话持有。
  await first.connectConfiguredServers({}, scope);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(server.calls).toEqual(["resources/subscribe", "resources/unsubscribe"]);
  expect(second.getToolSnapshot().remote?.status.status).toBe("connected");
});

it("keeps another lease's subscription when a lease of the same session releases the server", async () => {
  const server = await startResourceServer();
  const pool = createMcpConnectionPool({
    createAdapter: () => createMcpAdapter({ env: {} }),
    idleGraceMs: 0,
  });
  cleanups.push(() => pool.close());
  const config = { ...server.config, isolation: "workspace" as const };
  const scope = { workspaceIdentity: "shared" };
  // 同一会话重开：新租约已登记订阅，旧租约稍后才释放。
  const previous = pool.acquireLease({ sessionId: "A" });
  const reopened = pool.acquireLease({ sessionId: "A" });
  await previous.connectServer("remote", config, scope);
  await reopened.connectServer("remote", config, scope);
  await previous.subscribeResource!({
    serverName: "remote",
    uri: "test://a",
    subscriberKey: "A|old|s",
  });
  await reopened.subscribeResource!({
    serverName: "remote",
    uri: "test://a",
    subscriberKey: "A|new|s",
  });
  await previous.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  // 修复前按会话前缀退订：新租约的登记也被删除，计数归零，远端被退订。
  expect(server.calls).toEqual(["resources/subscribe"]);
});
