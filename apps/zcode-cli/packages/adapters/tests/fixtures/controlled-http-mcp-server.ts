// 受控的 Streamable HTTP MCP server：只用于 adapter 回归，按工具名统计到达与执行次数。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

export interface ControlledHttpMcpStats {
  arrivals: Record<string, number>;
  executed: Record<string, number>;
  initializations: number;
  gets: number;
  /** OAuth 元数据发现请求（`/.well-known/*`），用于确认是否发起了授权流程。 */
  discoveryRequests: number;
}

export type ControlledToolReply =
  | { kind: "result"; text?: string }
  | { kind: "rpc-error"; code: number; message: string }
  | { kind: "http"; status: number; body?: string; headers?: Record<string, string> }
  | { kind: "destroy" };

export interface ControlledHttpMcpOptions {
  /** 未知 session 返回 404（有状态 server）。 */
  sessionCheck?: boolean;
  /** GET 事件流的响应：405（不支持）、404（无 GET 路由）或保持打开。 */
  getMode?: "405" | "404" | "hold";
  tools?: string[];
  /** 返回 undefined 时按成功结果处理；可 await 门控以模拟长调用。 */
  onToolCall?: (
    name: string,
    context: { sessionId?: string; arrival: number },
  ) => Promise<ControlledToolReply | undefined> | ControlledToolReply | undefined;
  /** 返回 HTTP 响应时初始化失败（例如 503 或 401），用于模拟恢复被拒绝；可 await 门控。 */
  onInitialize?: (
    count: number,
  ) =>
    | Promise<{ status: number; body?: string; headers?: Record<string, string> } | void>
    | { status: number; body?: string; headers?: Record<string, string> }
    | void;
}

export interface ControlledHttpMcpServer {
  url: string;
  stats: ControlledHttpMcpStats;
  /** 使当前全部 session 失效，下一次带旧 session 的请求返回 404。 */
  expireSessions(): void;
  close(): Promise<void>;
}

export async function startControlledHttpMcpServer(
  options: ControlledHttpMcpOptions = {},
): Promise<ControlledHttpMcpServer> {
  const stats: ControlledHttpMcpStats = {
    arrivals: {},
    executed: {},
    initializations: 0,
    gets: 0,
    discoveryRequests: 0,
  };
  const sessions = new Set<string>();
  const sockets = new Set<Socket>();
  let sequence = 0;
  const bump = (counts: Record<string, number>, key: string) =>
    (counts[key] = (counts[key] ?? 0) + 1);
  const tools = options.tools ?? ["ping"];

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url?.includes("/.well-known/")) {
      stats.discoveryRequests++;
      response.writeHead(404).end();
      return;
    }
    if (request.method === "GET") {
      stats.gets++;
      if (options.getMode === "404") {
        response.writeHead(404, { "content-type": "text/plain" }).end("Cannot GET /mcp");
        return;
      }
      if (options.getMode === "hold") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": ready\n\n");
        return;
      }
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
    const sessionId = request.headers["mcp-session-id"] as string | undefined;
    const toolName: string | undefined =
      message.method === "tools/call" ? message.params?.name : undefined;
    const arrival = toolName ? bump(stats.arrivals, toolName) : 0;
    if (
      options.sessionCheck &&
      message.method !== "initialize" &&
      sessionId &&
      !sessions.has(sessionId)
    ) {
      response.writeHead(404, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32001, message: "Session not found" },
        }),
      );
      return;
    }
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let replySessionId = sessionId;
    const reply = (result: unknown) =>
      response
        .writeHead(200, {
          "content-type": "application/json",
          ...(replySessionId ? { "mcp-session-id": replySessionId } : {}),
        })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") {
      stats.initializations++;
      const rejected = await options.onInitialize?.(stats.initializations);
      if (rejected) {
        response.writeHead(rejected.status, rejected.headers).end(rejected.body ?? "");
        return;
      }
      replySessionId = `session-${++sequence}`;
      sessions.add(replySessionId);
      reply({
        protocolVersion: "2025-11-25",
        serverInfo: { name: "controlled", version: "1" },
        capabilities: { tools: {}, resources: { subscribe: true } },
      });
      return;
    }
    if (message.method === "tools/list") {
      reply({
        tools: tools.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })),
      });
      return;
    }
    if (message.method !== "tools/call") {
      reply({});
      return;
    }
    const outcome = await options.onToolCall?.(toolName!, { sessionId, arrival });
    if (outcome?.kind === "destroy") {
      bump(stats.executed, toolName!);
      request.socket.destroy();
      return;
    }
    if (outcome?.kind === "http") {
      response.writeHead(outcome.status, outcome.headers).end(outcome.body ?? "");
      return;
    }
    bump(stats.executed, toolName!);
    if (outcome?.kind === "rpc-error") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: outcome.code, message: outcome.message },
        }),
      );
      return;
    }
    reply({ content: [{ type: "text", text: outcome?.text ?? `ok:${toolName}` }] });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    stats,
    expireSessions: () => sessions.clear(),
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
