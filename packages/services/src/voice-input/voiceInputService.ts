import { Emitter } from "@zcode/rpc";
import type { ApiClient } from "@zcode/shared";
import type { WebSocket } from "undici";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  IVoiceInputService,
  VoiceInputErrorCode,
  VoiceInputEvent,
} from "#src/voice-input/contract.js";

const log = createServiceLogger("voice-input");

// zcode-server ASR 协议见其仓库 docs/asr.md；这里只用 realtime 模式。
const TICKET_PATH = "/api/v1/asr/tickets";
const TICKET_TIMEOUT_MS = 10_000;

interface Session {
  attemptId: string;
  language: "zh-CN" | "en-US";
  startedAt: number;
  socket: WebSocket | null;
  /** 本次连接是否经 HTTP 代理；由 Host 网络 transport 的选路结果决定 */
  viaProxy: boolean;
  /** WS 握手成功（onopen）；用于区分握手失败与握手后被断开 */
  opened: boolean;
  started: boolean;
  finishRequested: boolean;
  /** started 之前到达的音频；started 后按顺序发出并清空 */
  pending: Uint8Array[];
  sentBytes: number;
  /** 已经发出终态事件（completed / error），之后的关闭不再报错 */
  settled: boolean;
  serverSessionId?: string;
  provider?: string;
}

export function mapAsrErrorCode(code: string | undefined, status?: number): VoiceInputErrorCode {
  switch (code) {
    case "unauthorized":
      return "unauthorized";
    case "rate_limited":
      return "rate_limited";
    case "unavailable":
    case "upstream_unavailable":
      return "unavailable";
    case "upstream_timeout":
      return "upstream_timeout";
    case "audio_limit_exceeded":
      return "audio_limit_exceeded";
    case "empty_audio":
    case "audio_too_short":
      return "audio_too_short";
  }
  if (status === 401) return "unauthorized";
  // 通用限流中间件返回无响应体的 429。
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  return "failed";
}

function readServerMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function createVoiceInputService(options: {
  apiClient: ApiClient;
  getToken: () => Promise<string | null | undefined>;
  resolveOrigin: () => Promise<string>;
  /** 由 Host 网络 transport 提供，与 HTTP 请求共用代理、No Proxy 与自定义 CA；不提供默认直连实现 */
  createSocket: (url: string) => Promise<{ socket: WebSocket; viaProxy: boolean }>;
}): IVoiceInputService & { dispose(): void } {
  const emitter = new Emitter<VoiceInputEvent>();
  const createSocket = options.createSocket;
  // 唯一数据源：当前会话。旧会话的回调通过 `current !== session` 判断后丢弃。
  let current: Session | null = null;

  function emit(session: Session, event: VoiceInputEvent) {
    if (current !== session || session.settled) return;
    if (event.type === "completed" || event.type === "error") session.settled = true;
    emitter.fire(event);
  }

  function summary(session: Session) {
    return {
      attemptId: session.attemptId,
      serverSessionId: session.serverSessionId,
      provider: session.provider,
      sentBytes: session.sentBytes,
      elapsedMs: Date.now() - session.startedAt,
    };
  }

  function fail(session: Session, code: VoiceInputErrorCode, detail: Record<string, unknown>) {
    if (current !== session || session.settled) return;
    log.warn(undefined, "voice input failed", { ...summary(session), code, ...detail });
    emit(session, { attemptId: session.attemptId, type: "error", code });
    release(session);
  }

  function release(session: Session) {
    if (current === session) current = null;
    const socket = session.socket;
    session.socket = null;
    if (socket && socket.readyState <= 1) socket.close(1000);
  }

  function sendChunk(session: Session, chunk: Uint8Array) {
    session.sentBytes += chunk.byteLength;
    log.debug(undefined, "voice input audio chunk", {
      attemptId: session.attemptId,
      bytes: chunk.byteLength,
    });
    session.socket?.send(chunk);
  }

  async function requestTicket(): Promise<{ ticket: string; wsPath: string }> {
    const origin = await options.resolveOrigin();
    const token = (await options.getToken())?.trim();
    if (!token) throw Object.assign(new Error("missing_token"), { status: 401 });
    const response = await options.apiClient.request(new URL(TICKET_PATH, origin).href, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "realtime" }),
      timeoutMs: TICKET_TIMEOUT_MS,
      redirect: "error",
    });
    const body = (await response.json().catch(() => null)) as {
      code?: number;
      logid?: string;
      data?: { ticket?: string; ws_path?: string; error_code?: string };
    } | null;
    if (!response.ok || body?.code !== 0 || !body.data?.ticket || !body.data.ws_path) {
      throw Object.assign(new Error("ticket_rejected"), {
        status: response.status,
        errorCode: body?.data?.error_code,
        logid: body?.logid,
      });
    }
    return { ticket: body.data.ticket, wsPath: new URL(body.data.ws_path, origin).href };
  }

  function handleMessage(session: Session, data: unknown) {
    const message = readServerMessage(data);
    if (!message) return;
    const text = typeof message.text === "string" ? message.text : "";
    switch (message.type) {
      case "started": {
        session.started = true;
        session.serverSessionId =
          typeof message.session_id === "string" ? message.session_id : undefined;
        session.provider = typeof message.provider === "string" ? message.provider : undefined;
        log.info(undefined, "voice input started", summary(session));
        emit(session, { attemptId: session.attemptId, type: "started" });
        for (const chunk of session.pending.splice(0)) sendChunk(session, chunk);
        if (session.finishRequested) session.socket?.send(JSON.stringify({ type: "finish" }));
        return;
      }
      case "result":
        log.debug(undefined, "voice input result", {
          attemptId: session.attemptId,
          length: text.length,
        });
        emit(session, { attemptId: session.attemptId, type: "result", text });
        return;
      case "completed":
        log.info(undefined, "voice input completed", {
          ...summary(session),
          length: text.length,
          audioDurationMs: message.audio_duration_ms,
        });
        emit(session, { attemptId: session.attemptId, type: "completed", text });
        release(session);
        return;
      case "error":
        fail(session, mapAsrErrorCode(String(message.code ?? "")), {
          serverCode: message.code,
          retryable: message.retryable,
        });
        return;
    }
  }

  async function connect(session: Session) {
    let ticket: { ticket: string; wsPath: string };
    try {
      ticket = await requestTicket();
    } catch (error) {
      const status = (error as { status?: number }).status;
      const errorCode = (error as { errorCode?: string }).errorCode;
      // 没有 HTTP 状态说明请求没有到达服务端（DNS、断网、超时、代理）。
      fail(session, status === undefined ? "network" : mapAsrErrorCode(errorCode, status), {
        stage: "ticket",
        status,
        errorCode,
        logid: (error as { logid?: string }).logid,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (current !== session) return;
    const url = new URL(ticket.wsPath);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.searchParams.set("ticket", ticket.ticket);
    // Node 的 WebSocket 不带 Origin 头；renderer 的 file:// 来源会被服务端 allowed_origins 拒绝。
    let socket: WebSocket;
    try {
      const connection = await createSocket(url.href);
      socket = connection.socket;
      session.viaProxy = connection.viaProxy;
    } catch (error) {
      // 代理配置无效、CA 读取失败等：fail-closed，不回退直连。
      fail(session, "network", {
        stage: "socket-create",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (current !== session) {
      socket.close(1000);
      return;
    }
    socket.binaryType = "arraybuffer";
    session.socket = socket;
    socket.onopen = () => {
      if (current !== session) return;
      session.opened = true;
      log.info(undefined, "voice input socket open", {
        attemptId: session.attemptId,
        viaProxy: session.viaProxy,
        elapsedMs: Date.now() - session.startedAt,
      });
      socket.send(
        JSON.stringify({
          type: "start",
          audio: { encoding: "pcm_s16le", sample_rate: 16000, channels: 1 },
          language: session.language,
          options: { punctuation: true, itn: true },
        }),
      );
    };
    socket.onmessage = (event) => {
      if (current === session) handleMessage(session, event.data);
    };
    socket.onerror = () => {
      // 修复原因：Host transport 用 undici 6 的 WebSocket，握手被拒（非 101，如 ticket 失效 401/403）
      // 时只触发 error、不触发 close；原先只在 onclose 里失败，会话一直停在连接中，没有提示和日志。
      // 握手前的 error 直接按握手失败结束；握手后的 error 仍由随后的 onclose 记录 close code。
      // 握手失败时 Node 不提供 HTTP 状态，无法区分代理与服务端，所以归为 failed。
      if (!session.opened) {
        fail(session, "failed", { stage: "handshake", opened: false, viaProxy: session.viaProxy });
      }
    };
    socket.onclose = (event) => {
      // 修复原因：用户经本地 MITM 抓包代理使用时，ticket 成功，WS 每次约 5 秒后 1006 断开。
      // 服务端在 started 前失败时一定先发 error 事件再发 close 帧（1011），客户端两者都没收到，
      // 说明帧被中间的代理丢弃；原先统一提示「语音识别失败，请重试」，用户无法定位到代理。
      // 只在经代理、握手成功后、started 前、非正常关闭时归为 proxy；其他断开仍是 failed。
      // 必须要求 opened：握手阶段服务端用 HTTP 状态拒绝（如 ticket 无效返回 403）时，
      // 客户端同样只看到 1006，无法区分代理和服务端，归为 proxy 会误导用户去排查代理。
      const code =
        session.viaProxy && session.opened && !session.started && !event.wasClean
          ? "proxy"
          : "failed";
      fail(session, code, {
        stage: "socket",
        opened: session.opened,
        viaProxy: session.viaProxy,
        closeCode: event.code,
        wasClean: event.wasClean,
        reason: event.reason,
      });
    };
  }

  return {
    onEvent: emitter.event,
    async start({ attemptId, language }) {
      if (current) {
        log.info(undefined, "voice input replaced", summary(current));
        const previous = current;
        previous.settled = true;
        if (previous.socket?.readyState === 1)
          previous.socket.send(JSON.stringify({ type: "cancel" }));
        release(previous);
      }
      const session: Session = {
        attemptId,
        language,
        startedAt: Date.now(),
        socket: null,
        viaProxy: false,
        opened: false,
        started: false,
        finishRequested: false,
        pending: [],
        sentBytes: 0,
        settled: false,
      };
      current = session;
      log.info(undefined, "voice input start", { attemptId, language });
      void connect(session);
    },
    async sendAudio({ attemptId, chunk }) {
      const session = current;
      if (!session || session.attemptId !== attemptId || session.finishRequested) return;
      if (!session.started) session.pending.push(chunk);
      else sendChunk(session, chunk);
    },
    async finish({ attemptId }) {
      const session = current;
      if (!session || session.attemptId !== attemptId || session.finishRequested) return;
      session.finishRequested = true;
      if (session.started) session.socket?.send(JSON.stringify({ type: "finish" }));
    },
    async cancel({ attemptId }) {
      const session = current;
      if (!session || session.attemptId !== attemptId) return;
      log.info(undefined, "voice input cancelled", summary(session));
      session.settled = true;
      if (session.socket?.readyState === 1) session.socket.send(JSON.stringify({ type: "cancel" }));
      release(session);
    },
    dispose() {
      if (current) {
        current.settled = true;
        release(current);
      }
      emitter.dispose();
    },
  };
}
