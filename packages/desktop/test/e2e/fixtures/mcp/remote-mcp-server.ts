import { createServer, type ServerResponse } from "node:http";

// 真实传输，仅模型动作使用 fixture；恢复时序由 initialize 门控，不依赖 sleep。
export async function createRemoteMcpFixture(type: "http" | "sse", name = `remote${type}`) {
  let stream: ServerResponse | undefined;
  let initializations = 0;
  let streams = 0;
  let discovered = false;
  let calls = 0;
  let failNextList = false;
  let changeDuringDiscovery = false;
  let freshTool = false;
  // 恢复 discovery 中发出 list_changed 后，客户端随后刷新的那一次 tools/list 可由测试挂起，
  // 用来固定“刷新晚于重试调用的续写请求”这一顺序；只挂起这一次。
  let holdRefresh = false;
  const refreshGate = Promise.withResolvers<void>();
  let failNextCall = false;
  let lastProbeSession: string | undefined;
  let probes = 0;
  let listSuccesses = 0;
  let gate = Promise.withResolvers<void>();
  let rejectRecovery = false;
  const sessions = new Set<string>();
  const events: { event: string; ts: string }[] = [];
  const record = (event: string) => events.push({ event, ts: new Date().toISOString() });
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      streams++;
      record("stream-opened");
      stream = response;
      response.on("close", () => record("stream-closed"));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(type === "sse" ? "event: endpoint\ndata: /messages\n\n" : ": ready\n\n");
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    if (message.method === "ping") {
      probes++;
      lastProbeSession = String(request.headers["mcp-session-id"]);
      record("probe");
    }
    if (
      type === "http" &&
      message.method !== "initialize" &&
      !sessions.has(String(request.headers["mcp-session-id"]))
    ) {
      record("session-rejected");
      response.writeHead(404).end("Session not found");
      return;
    }
    let result: unknown = {};
    if (message.method === "initialize") {
      initializations++;
      record("initialize");
      if (rejectRecovery) {
        record("initialize-rejected");
        response.writeHead(503).end("recovery unavailable");
        return;
      }
      if (initializations > 1) await gate.promise;
      result = {
        protocolVersion: "2025-11-25",
        serverInfo: { name, version: "1" },
        capabilities: { tools: { listChanged: true } },
      };
    } else if (message.method === "tools/list") {
      discovered = true;
      record("tools/list");
      if (failNextList) {
        failNextList = false;
        stream?.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "transient discovery failure" } })}\n\n`,
        );
        response.writeHead(202).end();
        return;
      }
      if (holdRefresh && freshTool) {
        holdRefresh = false;
        record("refresh-list-held");
        await refreshGate.promise;
        response.on("finish", () => record("refresh-list-served"));
      }
      listSuccesses++;
      result = {
        tools: [
          {
            name: "ping",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          },
        ],
      };
      if (freshTool)
        (result as { tools: unknown[] }).tools.push({
          name: "fresh",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        });
      if (changeDuringDiscovery) {
        changeDuringDiscovery = false;
        freshTool = true;
        record("discovery-list-changed");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
        );
        response.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
        );
        return;
      }
    } else if (message.method === "tools/call") {
      calls++;
      record(message.params.name);
      if (failNextCall) {
        failNextCall = false;
        record("call-protocol-error");
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: "Not connected" },
          }),
        );
        return;
      }
      result = { content: [{ type: "text", text: `E2E_MCP_REMOTE_RECOVERY:${name}:pong` }] };
    }
    const sessionId =
      message.method === "initialize"
        ? `${name}-${initializations}`
        : String(request.headers["mcp-session-id"]);
    if (message.method === "initialize") sessions.add(sessionId);
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    if (type === "sse") {
      stream?.write(`event: message\ndata: ${body}\n\n`);
      response.writeHead(202).end();
    } else
      response
        .writeHead(200, { "content-type": "application/json", "mcp-session-id": sessionId })
        .end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing MCP listener address");
  return {
    name,
    events,
    config: {
      type,
      url: `http://127.0.0.1:${address.port}/mcp`,
      protocolVersion: "legacy",
      timeoutMs: 120_000,
    },
    ready: () => discovered && stream !== undefined,
    recoveredStreamOrReconnecting: () => (type === "http" ? streams > 1 : initializations > 1),
    refreshWithTransientFailure() {
      const before = listSuccesses;
      failNextList = true;
      stream?.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
      );
      return () => listSuccesses > before;
    },
    expire({ failRecovery = false } = {}) {
      sessions.clear();
      rejectRecovery = failRecovery;
      gate = Promise.withResolvers<void>();
      record("session-expired");
    },
    changeDuringDiscovery({ holdRefresh: hold = false }: { holdRefresh?: boolean } = {}) {
      changeDuringDiscovery = true;
      holdRefresh = hold;
    },
    releaseRefresh() {
      record("refresh-released");
      refreshGate.resolve();
    },
    initializations: () => initializations,
    calls: () => calls,
    probes: () => probes,
    failCallAfterExecution() {
      failNextCall = true;
    },
    expireProbedSession() {
      if (!lastProbeSession || !sessions.delete(lastProbeSession))
        throw new Error("No probed session to expire");
      gate = Promise.withResolvers<void>();
      record("probe-session-expired");
    },
    disconnect() {
      record("disconnect");
      stream?.destroy();
    },
    release() {
      record("release");
      gate.resolve();
    },
    async close() {
      gate.resolve();
      refreshGate.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
