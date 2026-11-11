/**
 * 语音输入 E2E 的 zcode-server ASR 替身（协议见 zcode-server docs/asr.md）。
 *
 * 只实现 Composer 语音输入用到的 `POST /api/v1/asr/tickets` 与 `WS /api/v1/asr/realtime`，
 * 行为由 `scenario` 控制；其余 zcode / 账号请求返回 404。
 * 根因记录：假 JWT 若打到真实控制面会收到 401，全局登录失效流程随即退出登录，
 * 语音按钮因未登录而隐藏；所以必须在 Electron 启动前把 zcode 与账号域名都指向本替身。
 * spec 通过 `/__e2e/asr/*` 控制端点切换场景、读取记录。
 */
import { createServer, type IncomingMessage } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { WebSocketServer } from "ws";

export type AsrMockScenario =
  /** partial 为空时不发临时结果；holdFinal 时收到 finish 不回 completed，等 /__e2e/asr/release */
  | { kind: "normal"; partial: string; final: string; holdFinal?: boolean }
  | { kind: "ticket-error"; status: number; errorCode: string }
  | { kind: "empty-final" }
  /** ticket 正常签发，WS 握手阶段返回该 HTTP 状态（模拟 ticket 失效、Origin 被拒等） */
  | { kind: "ws-reject"; status: number };

export interface AsrMockSession {
  start?: Record<string, unknown>;
  audioBytes: number;
  /** 收到 finish 时已收到的音频字节；finish 之后再到的音频计入 audioAfterFinish */
  audioBytesAtFinish?: number;
  audioAfterFinish: number;
  controls: string[];
  closed: boolean;
}

export interface AsrMockServer {
  origin: string;
  scenario: AsrMockScenario;
  ticketRequests: Array<{ authorization?: string; body: string }>;
  sessions: AsrMockSession[];
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => resolve(body));
  });
}

export async function startAsrMockServer(scenario: AsrMockScenario): Promise<AsrMockServer> {
  const tickets = new Set<string>();
  const heldCompletions: Array<() => void> = [];
  let ticketSeq = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__e2e/asr/reset" && request.method === "POST") {
      mock.scenario = JSON.parse(await readBody(request)) as AsrMockScenario;
      mock.ticketRequests.length = 0;
      heldCompletions.length = 0;
      mock.sessions.length = 0;
      response.end("{}");
      return;
    }
    if (url.pathname === "/__e2e/asr/release" && request.method === "POST") {
      for (const complete of heldCompletions.splice(0)) complete();
      response.end("{}");
      return;
    }
    if (url.pathname === "/__e2e/asr/state") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ ticketRequests: mock.ticketRequests, sessions: mock.sessions }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/asr/tickets") {
      const body = await readBody(request);
      mock.ticketRequests.push({ authorization: request.headers.authorization, body });
      response.setHeader("Content-Type", "application/json");
      if (mock.scenario.kind === "ticket-error") {
        response.statusCode = mock.scenario.status;
        response.end(
          JSON.stringify({
            code: mock.scenario.status,
            msg: "error",
            data: { error_code: mock.scenario.errorCode, retryable: true },
          }),
        );
        return;
      }
      const ticket = Buffer.alloc(32, ++ticketSeq).toString("base64url");
      tickets.add(ticket);
      response.end(
        JSON.stringify({
          code: 0,
          msg: "",
          data: { ticket, expires_in: 60, ws_path: "/api/v1/asr/realtime" },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const ticket = url.searchParams.get("ticket") ?? "";
    // 与真实服务一致：ticket 一次性；带 Origin 的连接按 allowed_origins 拒绝（这里不允许任何 Origin）。
    if (
      url.pathname !== "/api/v1/asr/realtime" ||
      !tickets.delete(ticket) ||
      request.headers.origin
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (mock.scenario.kind === "ws-reject") {
      socket.end(`HTTP/1.1 ${mock.scenario.status} Rejected\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const session: AsrMockSession = {
        audioBytes: 0,
        audioAfterFinish: 0,
        controls: [],
        closed: false,
      };
      mock.sessions.push(session);
      let seq = 0;
      const send = (event: Record<string, unknown>) =>
        ws.send(JSON.stringify({ ...event, session_id: "e2e-session", seq: ++seq }));
      ws.on("close", () => {
        session.closed = true;
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          if (session.audioBytesAtFinish !== undefined) {
            session.audioAfterFinish += (data as Buffer).byteLength;
          }
          const firstAudio = session.audioBytes === 0;
          session.audioBytes += (data as Buffer).byteLength;
          if (firstAudio && mock.scenario.kind === "normal" && mock.scenario.partial) {
            send({ type: "result", text: mock.scenario.partial, segments: [] });
          }
          return;
        }
        const message = JSON.parse(data.toString()) as { type: string };
        if (message.type === "start") {
          session.start = message as Record<string, unknown>;
          send({
            type: "started",
            mode: "realtime",
            provider: "volcengine",
            max_audio_duration_ms: 1_800_000,
          });
          return;
        }
        session.controls.push(message.type);
        if (message.type === "finish") session.audioBytesAtFinish = session.audioBytes;
        if (message.type === "finish") {
          const text = mock.scenario.kind === "normal" ? mock.scenario.final : "";
          const complete = () => {
            if (ws.readyState !== ws.OPEN) return;
            send({
              type: "completed",
              text,
              segments: [],
              audio_duration_ms: session.audioBytes / 32,
            });
            ws.close(1000);
          };
          if (mock.scenario.kind === "normal" && mock.scenario.holdFinal) {
            heldCompletions.push(complete);
            return;
          }
          send({
            type: "completed",
            text,
            segments: [],
            audio_duration_ms: session.audioBytes / 32,
          });
          ws.close(1000);
        } else if (message.type === "cancel") {
          send({ type: "cancelled" });
          ws.close(1000);
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const mock: AsrMockServer = {
    origin: `http://127.0.0.1:${port}`,
    scenario,
    ticketRequests: [],
    sessions: [],
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
  return mock;
}

export interface AsrFrameDroppingProxy {
  url: string;
  /** 经本代理完成握手的 ASR WebSocket 数 */
  upgradedSockets: number;
  close(): Promise<void>;
}

/**
 * 模拟用户日志中的 MITM 抓包代理：普通 HTTP 请求（含 ticket）正常转发；
 * ASR WebSocket 的 101 响应转发后，丢弃双向数据帧，再直接断开 TCP（客户端看到 1006）。
 * 握手被源站拒绝（非 101）时按普通响应原样转发。
 * TCP 是字节流，请求行与状态行可能被拆到多个 data 事件，所以按累计缓冲判断，不按单个 chunk。
 */
export async function startAsrFrameDroppingProxy(): Promise<AsrFrameDroppingProxy> {
  const sockets = new Set<Socket>();
  const server = createServer();
  server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => {
    const [host = "", port = "80"] = (request.url ?? "").split(":");
    const upstream = connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
    });
    sockets.add(client).add(upstream);
    // 客户端方向只保留尾部，足够匹配跨 chunk 的请求行；上游方向从发出升级请求后开始累计响应头。
    let clientTail = "";
    let responseHead: string | null = null;
    let dropping = false;
    client.on("data", (chunk: Buffer) => {
      if (dropping) return;
      if (responseHead === null) {
        clientTail = (clientTail + chunk.toString("latin1")).slice(-4096);
        if (clientTail.includes("GET /api/v1/asr/realtime")) {
          clientTail = "";
          responseHead = "";
        }
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      if (dropping) return;
      client.write(chunk);
      if (responseHead === null) return;
      responseHead += chunk.toString("latin1");
      if (!responseHead.includes("\r\n\r\n")) return;
      if (responseHead.startsWith("HTTP/1.1 101 ")) {
        dropping = true;
        proxy.upgradedSockets += 1;
        setTimeout(() => {
          client.destroy();
          upstream.destroy();
        }, 1_000);
      }
      // 非 101：握手被源站拒绝，响应已原样转发，之后按普通流量处理。
      responseHead = null;
    });
    const cleanup = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", cleanup).on("close", cleanup);
    upstream.on("error", cleanup).on("close", cleanup);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const proxy: AsrFrameDroppingProxy = {
    url: `http://127.0.0.1:${port}`,
    upgradedSockets: 0,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  return proxy;
}

export const VOICE_INPUT_SPEC = "composer-voice-input.test.ts";

/** wdio beforeSession：Electron 启动前启动替身并改写 zcode / 账号域名；其他 spec 为 no-op。 */
export async function prepareVoiceInputFixture(
  specs: string[],
): Promise<(() => Promise<void>) | null> {
  if (!specs.some((spec) => spec.replaceAll("\\", "/").endsWith(`/${VOICE_INPUT_SPEC}`)))
    return null;
  const mock = await startAsrMockServer({ kind: "normal", partial: "", final: "" });
  const envPatch = {
    ZCODE_E2E_ASR_MOCK_URL: mock.origin,
    ZCODE_BASE_URL: mock.origin,
    ZCODE_TEST_BASE_URL: mock.origin,
    ZCODE_ENDPOINT_ORIGIN: mock.origin,
    ZAI_BUSINESS_BASE_URL: mock.origin,
    ZAI_OAUTH_USERINFO_URL: `${mock.origin}/api/oauth/userinfo`,
    BIGMODEL_API_BASE_URL: mock.origin,
    BIGMODEL_OAUTH_USERINFO_URL: `${mock.origin}/api/biz/customer/getCustomerInfo`,
  };
  const previous = Object.fromEntries(Object.keys(envPatch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, envPatch);
  return async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await mock.close();
  };
}
