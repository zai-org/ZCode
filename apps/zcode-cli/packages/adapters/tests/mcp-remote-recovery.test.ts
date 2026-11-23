import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { withTimeout } from "../src/mcp/timeout.js";
import { createMcpAdapter } from "../src/mcp/index.js";
import { createMcpConnectionPool } from "../src/mcp/pool.js";

it("reconfirms a shared HTTP subscription after an unsubscribe response is lost", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let remoteSubscribed = false,
    subscribeCount = 0,
    initializations = 0,
    toolCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown = {};
    if (message.method === "initialize") {
      initializations++;
      result = {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "controlled", version: "1" },
        capabilities: { tools: {}, resources: { subscribe: true } },
      };
    } else if (message.method === "tools/list") {
      result = { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] };
    } else if (message.method === "tools/call") {
      toolCalls++;
      result = { content: [{ type: "text", text: "completed once" }] };
    } else if (message.method === "resources/subscribe") {
      remoteSubscribed = true;
      subscribeCount++;
    } else if (message.method === "resources/unsubscribe") {
      remoteSubscribed = false;
      entered.resolve();
      await release.promise;
      // 远端已完成退订，但客户端收不到确认；连接仍可用于后续独立请求。
      response.destroy();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json", "mcp-session-id": "controlled" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const pool = createMcpConnectionPool({
    createAdapter: () => createMcpAdapter({ env: {} }),
    idleGraceMs: 0,
  });
  const first = pool.acquireLease({ sessionId: "A" }),
    second = pool.acquireLease({ sessionId: "B" });
  try {
    const config = {
      type: "http",
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
      protocolVersion: "legacy",
      isolation: "workspace",
    } as const;
    const scope = { workspaceIdentity: "shared" };
    await first.connectServer("remote", config, scope);
    await second.connectServer("remote", config, scope);
    const request = { serverName: "remote", uri: "test://shared", subscriberKey: "A:scope:1" };
    await first.subscribeResource!(request);
    const removing = first.unsubscribeResource!(request);
    await withTimeout(entered.promise, 5000, "Unsubscribe did not reach the server");
    const adding = second.subscribeResource!({ ...request, subscriberKey: "B:scope:1" });
    release.resolve();
    await Promise.all([removing, adding]);
    expect(remoteSubscribed).toBe(true);
    expect(subscribeCount).toBe(2);
    await first.close();
    expect(remoteSubscribed).toBe(true);
    expect(
      await second.callTool({ serverName: "remote", toolName: "ping", arguments: {} }),
    ).toMatchObject({ content: [{ text: "completed once" }] });
    expect(second.getToolSnapshot().remote.status.status).toBe("connected");
    expect(initializations).toBe(1);
    expect(toolCalls).toBe(1);
  } finally {
    release.resolve();
    await pool.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10_000);

it.each(["sse"] as const)(
  "recovers a real %s transport after its server stream closes",
  async (type) => {
    const streamOpened = Promise.withResolvers<ServerResponse>();
    const reconnecting = Promise.withResolvers<void>();
    const allowRecovery = Promise.withResolvers<void>();
    let initializations = 0;
    let stream: ServerResponse | undefined;
    const server = createServer(async (request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(type === "sse" ? "event: endpoint\ndata: /messages\n\n" : ": ready\n\n");
        stream = response;
        streamOpened.resolve(response);
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(200).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString());
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (message.method === "initialize") {
        initializations++;
        if (initializations > 1) {
          reconnecting.resolve();
          await allowRecovery.promise;
        }
        result = {
          protocolVersion: "2025-11-25",
          serverInfo: { name: "controlled", version: "1" },
          capabilities: { tools: {} },
        };
      } else if (message.method === "tools/list") {
        result = { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] };
      } else if (message.method === "tools/call")
        result = { content: [{ type: "text", text: "recovered" }] };
      const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      if (type === "sse") {
        stream?.write(`event: message\ndata: ${body}\n\n`);
        response.writeHead(202).end();
      } else
        response
          .writeHead(200, { "content-type": "application/json", "mcp-session-id": "controlled" })
          .end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local server address");
    const adapter = createMcpAdapter({ env: {} });
    try {
      await adapter.connectServer("remote", {
        type,
        url: `http://127.0.0.1:${address.port}/mcp`,
        protocolVersion: "legacy",
      });
      expect(adapter.getToolSnapshot!()!.remote.status.status).toBe("connected");
      (await streamOpened.promise).destroy();
      await withTimeout(reconnecting.promise, 5000, "Transport did not begin recovery");
      expect(adapter.getToolSnapshot!()!.remote).toMatchObject({
        status: { status: "connecting" },
        tools: [{ toolName: "ping" }],
      });
      allowRecovery.resolve();
      await adapter.waitForServer!("remote", { timeoutMs: 5000 });
      expect(adapter.getToolSnapshot!()!.remote.status.status).toBe("connected");
      expect(
        await adapter.callTool({ serverName: "remote", toolName: "ping", arguments: {} }),
      ).toMatchObject({ content: [{ text: "recovered" }] });
      expect(initializations).toBe(2);
    } finally {
      allowRecovery.resolve();
      await adapter.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  10_000,
);

it("HTTP GET stream recovery preserves the client and an in-flight POST call", async () => {
  const streamOpened = Promise.withResolvers<ServerResponse>();
  const callStarted = Promise.withResolvers<void>();
  const allowCall = Promise.withResolvers<void>();
  const streamReopened = Promise.withResolvers<void>();
  let initializations = 0;
  let streams = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": ready\n\n");
      streams++;
      streamOpened.resolve(response);
      if (streams > 1) streamReopened.resolve();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown = {};
    if (message.method === "initialize") {
      initializations++;
      result = {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "controlled", version: "1" },
        capabilities: { tools: {} },
      };
    } else if (message.method === "tools/list") {
      result = { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] };
    } else if (message.method === "tools/call") {
      callStarted.resolve();
      await allowCall.promise;
      result = { content: [{ type: "text", text: "completed once" }] };
    }
    response
      .writeHead(200, { "content-type": "application/json", "mcp-session-id": "controlled" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local server address");
  const adapter = createMcpAdapter({ env: {} });
  try {
    await adapter.connectServer("remote", {
      type: "http",
      url: `http://127.0.0.1:${address.port}/mcp`,
      protocolVersion: "legacy",
    });
    const before = adapter.appConnectionSnapshot!("remote");
    const call = adapter.callTool({ serverName: "remote", toolName: "ping", arguments: {} }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await callStarted.promise;
    (await streamOpened.promise).end();
    await withTimeout(streamReopened.promise, 6000, "GET stream was not reopened");
    allowCall.resolve();
    expect(await call).toMatchObject({ value: { content: [{ text: "completed once" }] } });
    expect(initializations).toBe(1);
    expect(adapter.appConnectionSnapshot!("remote")).toEqual(before);
  } finally {
    allowCall.resolve();
    await adapter.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10_000);

// 使用真实 SDK/HTTP：404 不等于 JSON-RPC 工具错误，响应丢失也不能证明工具未执行。
async function createSessionFixture(sessionful = true) {
  let recoveryStarted = Promise.withResolvers<void>();
  let recoveryGate = Promise.withResolvers<void>();
  const streamReady = Promise.withResolvers<void>();
  const pingStarted = Promise.withResolvers<void>();
  let pingGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let changeDuringDiscovery = false;
  let changedTools = false;
  let pings = 0;
  let initializations = 0;
  let calls = 0;
  let requests = 0;
  let sessionId = "";
  let stream: ServerResponse | undefined;
  let failure: "expired" | "lost-response" | "server-error" | "protocol-error" | undefined;
  let expiredArrivals: { count: number; gate: PromiseWithResolvers<void> } | undefined;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      stream = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": ready\n\n");
      streamReady.resolve();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (message.method === "initialize") {
      initializations++;
      sessionId = `session-${initializations}`;
      if (initializations > 1) {
        recoveryStarted.resolve();
        await recoveryGate.promise;
      }
      result = {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "session-fixture", version: "1" },
        capabilities: { tools: {} },
      };
    } else {
      if (message.method === "tools/call") requests++;
      // 显式开启时，过期的调用等指定数量的调用都到达后才收到 404。修复前测试依赖时序：
      // 第一个 404 同步关闭旧 client 后，第二个调用可能尚未发出，到达次数在 3 和 4 之间波动。
      if (failure === "expired" && message.method === "tools/call" && expiredArrivals) {
        if (requests >= expiredArrivals.count) expiredArrivals.gate.resolve();
        await expiredArrivals.gate.promise;
      }
      if (message.method === "ping") {
        pings++;
        pingStarted.resolve();
        await pingGate?.promise;
      }
      if (
        failure === "expired" ||
        (sessionful && request.headers["mcp-session-id"] !== sessionId)
      ) {
        response.writeHead(404).end("Session not found");
        return;
      }
      if (message.method === "tools/list") {
        result = {
          tools: [
            {
              name: changedTools ? "fresh" : "ping",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
        if (changeDuringDiscovery) {
          changeDuringDiscovery = false;
          changedTools = true;
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
          );
          response.end(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
          );
          return;
        }
      } else if (message.method === "ping") {
        result = {};
      } else {
        if (failure === "server-error") {
          response.writeHead(500).end("operation failed");
          return;
        }
        calls++;
        if (failure === "protocol-error") {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32000, message: "Not connected" },
            }),
          );
          return;
        }
        if (failure === "lost-response") {
          request.socket.destroy();
          return;
        }
        result = { content: [{ type: "text", text: `performed-${calls}` }] };
      }
    }
    response
      .writeHead(200, {
        "content-type": "application/json",
        ...(sessionful ? { "mcp-session-id": sessionId } : {}),
      })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const adapter = createMcpAdapter({ env: {} });
  const config = {
    type: "http",
    url: `http://127.0.0.1:${address.port}/mcp`,
    protocolVersion: "legacy",
  } as const;
  await adapter.connectServer("remote", config);
  await withTimeout(streamReady.promise, 2000, "HTTP event stream did not open");
  return {
    adapter,
    config,
    get recoveryStarted() {
      return recoveryStarted.promise;
    },
    pingStarted: pingStarted.promise,
    holdPing() {
      pingGate = Promise.withResolvers<void>();
    },
    releasePing() {
      pingGate?.resolve();
    },
    pings: () => pings,
    fail(value: typeof failure) {
      failure = value;
      if (value === "expired") {
        recoveryGate = Promise.withResolvers<void>();
        recoveryStarted = Promise.withResolvers<void>();
      }
    },
    changeDuringDiscovery() {
      changeDuringDiscovery = true;
    },
    holdExpiredCallsUntil(count: number) {
      expiredArrivals = { count, gate: Promise.withResolvers<void>() };
    },
    refresh() {
      stream!.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
      );
    },
    release() {
      failure = undefined;
      recoveryGate.resolve();
    },
    counts: () => ({ initializations, calls, requests }),
    call: () => adapter.callTool({ serverName: "remote", toolName: "ping", arguments: {} }),
    async close() {
      pingGate?.resolve();
      recoveryGate.resolve();
      expiredArrivals?.gate.resolve();
      await adapter.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("continues a real HTTP discovery notification after recovery readiness", async () => {
  const fixture = await createSessionFixture();
  const updated = Promise.withResolvers<void>();
  const off = fixture.adapter.onSnapshotChanged!(() => {
    if (fixture.adapter.getToolSnapshot().remote.tools?.[0]?.toolName === "fresh")
      updated.resolve();
  });
  try {
    fixture.fail("expired");
    fixture.changeDuringDiscovery();
    const call = fixture.call();
    await fixture.recoveryStarted;
    fixture.release();
    // 会话过期的调用在恢复后的连接上重试一次。
    await expect(call).resolves.toMatchObject({ content: [{ text: "performed-1" }] });
    await withTimeout(updated.promise, 1000, "discovery notification was lost");
    expect(fixture.adapter.getToolSnapshot().remote.tools?.[0]?.toolName).toBe("fresh");
    expect(fixture.counts()).toEqual({ initializations: 2, calls: 1, requests: 2 });
  } finally {
    off();
    await fixture.close();
  }
});

it.each(["call", "list"] as const)(
  "HTTP session expiry during %s shares connection recovery and retries the call once",
  async (operation) => {
    const fixture = await createSessionFixture();
    try {
      fixture.fail("expired");
      const call = operation === "call" ? fixture.call() : undefined;
      if (operation === "list") fixture.refresh();
      await withTimeout(fixture.recoveryStarted, 2000, "Expired session did not recover");
      expect(fixture.adapter.getToolSnapshot!().remote).toMatchObject({
        status: { status: "connecting" },
        tools: [{ toolName: "ping" }],
      });
      expect(fixture.counts()).toEqual({
        initializations: 2,
        calls: 0,
        requests: operation === "call" ? 1 : 0,
      });
      fixture.release();
      if (call) await expect(call).resolves.toMatchObject({ content: [{ text: "performed-1" }] });
      else {
        await fixture.adapter.waitForServer!("remote", { timeoutMs: 2000 });
        expect(await fixture.call()).toMatchObject({ content: [{ text: "performed-1" }] });
      }
      expect(fixture.counts()).toEqual({
        initializations: 2,
        calls: 1,
        requests: operation === "call" ? 2 : 1,
      });
    } finally {
      await fixture.close();
    }
  },
);

it.each(["lost-response", "server-error", "stateless-404", "protocol-error"] as const)(
  "does not replay or reconnect on %s",
  async (failure) => {
    const fixture = await createSessionFixture(failure !== "stateless-404");
    try {
      fixture.fail(failure === "stateless-404" ? "expired" : failure);
      // 允许重连立即完成，确保断言发现重复执行，而不是被恢复门控超时掩盖。
      if (failure === "protocol-error") {
        fixture.release();
        fixture.fail(failure);
      }
      await expect(fixture.call()).rejects.toThrow();
      expect(fixture.counts()).toEqual({
        initializations: 1,
        calls: failure === "lost-response" || failure === "protocol-error" ? 1 : 0,
        requests: 1,
      });
      fixture.fail(undefined);
      await fixture.call();
      expect(fixture.counts().initializations).toBe(1);
      expect(fixture.counts().requests).toBe(2);
    } finally {
      await fixture.close();
    }
  },
);

it("removing an expired HTTP connection cancels recovery and rejects late discovery", async () => {
  const fixture = await createSessionFixture();
  try {
    fixture.fail("expired");
    const call = fixture.call();
    await withTimeout(fixture.recoveryStarted, 2000, "Expired session did not recover");
    const waiter = fixture.adapter.waitForServer!("remote", { timeoutMs: 2000 }).catch(
      () => undefined,
    );
    await fixture.adapter.disconnectServer("remote");
    fixture.release();
    await waiter;
    // 删除连接后不在新记录上重试。
    await expect(call).rejects.toThrow();
    expect(fixture.adapter.getToolSnapshot!().remote).toEqual({
      status: expect.objectContaining({ status: "disconnected", toolCount: 0 }),
    });
    expect(fixture.counts()).toEqual({ initializations: 2, calls: 0, requests: 1 });
  } finally {
    await fixture.close();
  }
});

it("concurrent expired calls share recovery and cancelling one waiter does not cancel it", async () => {
  const fixture = await createSessionFixture();
  try {
    fixture.fail("expired");
    fixture.holdExpiredCallsUntil(2);
    const calls = Promise.all([fixture.call(), fixture.call()]);
    await withTimeout(fixture.recoveryStarted, 2000, "Expired session did not recover");
    const controller = new AbortController();
    const cancelled = fixture.adapter.waitForServer!("remote", {
      timeoutMs: 2000,
      signal: controller.signal,
    });
    const cancellation = expect(cancelled).rejects.toThrow();
    controller.abort();
    await cancellation;
    expect(fixture.counts().initializations).toBe(2);
    expect(fixture.counts().calls).toBe(0);
    fixture.release();
    // 两个调用共享一次恢复，各自重试一次：4 次到达、2 次执行、2 次初始化。
    expect(await calls).toMatchObject([
      { content: [{ text: expect.stringMatching(/^performed-/) }] },
      { content: [{ text: expect.stringMatching(/^performed-/) }] },
    ]);
    expect(fixture.counts()).toEqual({ initializations: 2, calls: 2, requests: 4 });
  } finally {
    await fixture.close();
  }
});

it("withdrawing one session lease during HTTP recovery preserves the other session", async () => {
  const fixture = await createSessionFixture();
  const pool = createMcpConnectionPool({ createAdapter: () => fixture.adapter, idleGraceMs: 0 });
  const first = pool.acquireLease({ leaseId: "first" });
  const second = pool.acquireLease({ leaseId: "second" });
  const config = { ...fixture.config, isolation: "workspace" as const };
  const scope = { workspaceIdentity: "workspace-a" };
  try {
    fixture.release();
    await first.connectServer("remote", config, scope);
    await second.connectServer("remote", config, scope);
    const before = fixture.counts().initializations;
    fixture.fail("expired");
    const request = { serverName: "remote", toolName: "ping", arguments: {} };
    const withdrawn = first.callTool(request);
    await withTimeout(fixture.recoveryStarted, 2000, "Expired session did not recover");
    await first.connectConfiguredServers({}, scope);
    expect(first.getToolSnapshot!()).toEqual({});
    await expect(first.callTool(request)).rejects.toThrow();
    fixture.release();
    // 恢复完成后不替已撤销的租约重放调用。
    await expect(withdrawn).rejects.toThrow();
    await second.waitForServer!("remote", { timeoutMs: 2000 });
    expect(await second.callTool(request)).toMatchObject({ content: [{ text: "performed-1" }] });
    expect(fixture.counts().initializations).toBe(before + 1);
    expect(first.getToolSnapshot!()).toEqual({});
  } finally {
    await pool.close();
    await fixture.close();
  }
});

it("settings revalidation shares HTTP expiry recovery and preserves another session's pending catalog", async () => {
  const fixture = await createSessionFixture();
  const pool = createMcpConnectionPool({ createAdapter: () => fixture.adapter, idleGraceMs: 0 });
  const settings = pool.acquireLease({ leaseId: "settings" });
  const session = pool.acquireLease({ sessionId: "conversation" });
  const config = { ...fixture.config, isolation: "workspace" as const };
  const scope = { workspaceIdentity: "shared" };
  try {
    fixture.release();
    await settings.connectServer("remote", config, scope);
    await session.connectServer("remote", config, scope);
    const before = fixture.counts().initializations;
    fixture.fail("expired");
    const refresh = settings.connectConfiguredServers(
      { remote: config },
      { ...scope, revalidate: true },
    );
    await withTimeout(fixture.recoveryStarted, 2000, "Probe did not start recovery");
    expect(session.getToolSnapshot().remote).toMatchObject({
      status: { status: "connecting" },
      tools: [{ toolName: "ping" }],
    });
    await withTimeout(refresh, 2000, "Refresh should report pending without replacing recovery");
    await settings.connectConfiguredServers({ remote: config }, { ...scope, revalidate: true });
    expect(fixture.pings()).toBe(1);
    await settings.close();
    expect(session.getToolSnapshot().remote.tools).toHaveLength(1);
    fixture.release();
    await session.waitForServer!("remote", { timeoutMs: 2000 });
    expect(
      await session.callTool({ serverName: "remote", toolName: "ping", arguments: {} }),
    ).toMatchObject({ content: [{ text: "performed-1" }] });
    expect(fixture.counts()).toEqual({ initializations: before + 1, calls: 1, requests: 1 });
  } finally {
    fixture.release();
    await pool.close();
    await fixture.close();
  }
});

it("cancelling one concurrent revalidation does not cancel the other", async () => {
  const fixture = await createSessionFixture();
  const pool = createMcpConnectionPool({ createAdapter: () => fixture.adapter, idleGraceMs: 0 });
  const first = pool.acquireLease();
  const second = pool.acquireLease();
  const config = { ...fixture.config, isolation: "workspace" as const };
  const scope = { workspaceIdentity: "shared" };
  try {
    fixture.release();
    await first.connectServer("remote", config, scope);
    await second.connectServer("remote", config, scope);
    const before = fixture.counts().initializations;
    fixture.holdPing();
    const controller = new AbortController();
    const cancelled = first.connectServer("remote", config, {
      ...scope,
      revalidate: true,
      signal: controller.signal,
    });
    const survivor = second.connectServer("remote", config, { ...scope, revalidate: true });
    await fixture.pingStarted;
    controller.abort();
    // 租约侧的取消以 reject 结束本次等待；另一个调用方的探测不受影响。
    const outcome = await withTimeout(
      cancelled.then(
        () => "resolved",
        () => "rejected",
      ),
      2000,
      "Caller cancellation did not end its wait",
    );
    expect(outcome).toBe("rejected");
    fixture.releasePing();
    await survivor;
    // 存活探测无副作用：并发校验各自探测，成功时都不重建连接。
    expect(fixture.counts().initializations).toBe(before);
    expect(second.getToolSnapshot().remote.status.status).toBe("connected");
  } finally {
    fixture.releasePing();
    await pool.close();
    await fixture.close();
  }
});

it("a delayed health probe cannot recreate a connection after its final lease closes", async () => {
  const fixture = await createSessionFixture();
  const pool = createMcpConnectionPool({ createAdapter: () => fixture.adapter, idleGraceMs: 0 });
  const lease = pool.acquireLease();
  try {
    fixture.release();
    await lease.connectServer("remote", fixture.config);
    const before = fixture.counts().initializations;
    fixture.holdPing();
    const refreshing = lease.connectServer("remote", fixture.config, { revalidate: true });
    await fixture.pingStarted;
    await lease.close();
    fixture.releasePing();
    // 租约关闭中断进行中的等待；迟到的探测仍不能重建连接。
    await expect(refreshing).rejects.toThrow();
    expect(fixture.counts().initializations).toBe(before);
    expect(pool.stats().activeConnections).toBe(0);
    expect(lease.getToolSnapshot()).toEqual({});
  } finally {
    fixture.releasePing();
    await pool.close();
    await fixture.close();
  }
});

// 订阅恢复由宿主负责：连接换代后 adapter 不在新连接上重放旧订阅，新的订阅申请在新连接上重新确认。
it("does not replay subscriptions after reconnect and confirms new subscriptions on the new client", async () => {
  let initializations = 0,
    expired = false;
  const subscribeSessions: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks).toString());
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown = {};
    if (msg.method === "initialize") {
      initializations++;
      expired = false;
      result = {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "controlled", version: "1" },
        capabilities: { tools: {}, resources: { subscribe: true } },
      };
    } else {
      if (expired) {
        res.writeHead(404).end("Session not found");
        return;
      }
      if (msg.method === "tools/list")
        result = { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] };
      else if (msg.method === "resources/subscribe")
        subscribeSessions.push(String(req.headers["mcp-session-id"]));
      else if (msg.method === "tools/call") result = { content: [{ type: "text", text: "ok" }] };
    }
    res
      .writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": `s-${initializations}`,
      })
      .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const adapter = createMcpAdapter({ env: {} });
  try {
    await adapter.connectServer("remote", {
      type: "http",
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
      protocolVersion: "legacy",
    });
    const invalidated = Promise.withResolvers<void>();
    adapter.onAppConnectionInvalidated!("remote", () => invalidated.resolve());
    await adapter.subscribeResource!({
      serverName: "remote",
      uri: "test://resource",
      subscriberKey: "session|instance-1|scope",
    });
    expired = true;
    await expect(
      adapter.callTool({ serverName: "remote", toolName: "ping" }),
    ).resolves.toMatchObject({
      content: [{ text: "ok" }],
    });
    await withTimeout(invalidated.promise, 2000, "App connection was not invalidated");
    expect(subscribeSessions).toEqual(["s-1"]);
    // 宿主关闭旧实例并重开：新实例的申请在新 client 上重新发出。
    await adapter.unsubscribeResourcesBySubscriber!("session|instance-1|");
    await adapter.subscribeResource!({
      serverName: "remote",
      uri: "test://resource",
      subscriberKey: "session|instance-2|scope",
    });
    expect(subscribeSessions).toEqual(["s-1", "s-2"]);
    expect(initializations).toBe(2);
  } finally {
    await adapter.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
