import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import type { McpServerConfig } from "@zcode/contracts";
import { getErrorCode, isNetworkFailure } from "../model/failure-inspection.js";

/** 连续多少次网络层失败视为服务端不可达；任何 HTTP 响应都会清零。 */
export const MCP_TERMINAL_NETWORK_FAILURE_LIMIT = 3;

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
const JSON_RPC_CONNECTION_CLOSED_CODE = -32000;
/**
 * 服务端只用正文表达"会话不存在"（400）。这里是"不用错误文本做流程判断"规则的例外：
 * 没有结构化字段可用，匹配范围限定为会话失效的三种已知写法。
 */
const SESSION_EXPIRED_BODY =
  /Server not initialized|No valid session ID|Mcp-Session-Id header is required/i;
const CONNECTION_CLOSED_MESSAGE = /Connection closed/i;

export type McpTransportErrorKind = "session_expired" | "stream_open_failed" | "other";

/**
 * onerror 分类：会话过期要重建连接；GET 打开事件流失败只说明 server 不提供推送流
 * （常见于只实现 POST 的有状态 server 返回 404/405），连接本身仍可用。
 */
export function classifyTransportError(
  error: unknown,
  input: { sessionId: string | undefined },
): McpTransportErrorKind {
  if (!(error instanceof SdkHttpError)) return "other";
  if (error.code === SdkErrorCode.ClientHttpFailedToOpenStream) return "stream_open_failed";
  return isSessionExpiredHttpError(error, input.sessionId !== undefined)
    ? "session_expired"
    : "other";
}

/**
 * 工具调用是否可以在重连后重试一次（只用于 Streamable HTTP）：
 * - 会话过期：调用开始时已有 session ID 的 POST 404，或 400 正文表示会话不存在；
 * - 连接关闭：本地 ConnectionClosed，或 JSON-RPC -32000 且消息为连接关闭。
 * 服务端 JSON-RPC 错误（包括 `-32000 Not connected`）、响应丢失、HTTP 500 与超时都不重试。
 */
export function isRetryableCallError(
  error: unknown,
  input: { type: McpServerConfig["type"]; hadSessionId: boolean },
): boolean {
  if (input.type !== "http") return false;
  if (error instanceof SdkHttpError) return isSessionExpiredHttpError(error, input.hadSessionId);
  if (error instanceof SdkError) return error.code === SdkErrorCode.ConnectionClosed;
  // 部分 server / 代理把连接关闭转成 JSON-RPC -32000，与本地连接关闭同样处理。
  // 这是"不用错误文本做流程判断"规则的例外：-32000 是通用服务端错误码，只有消息文本能区分连接关闭。
  return (
    error instanceof ProtocolError &&
    error.code === JSON_RPC_CONNECTION_CLOSED_CODE &&
    CONNECTION_CLOSED_MESSAGE.test(error.message)
  );
}

function isSessionExpiredHttpError(error: SdkHttpError, hadSessionId: boolean): boolean {
  if (error.code !== SdkErrorCode.ClientHttpNotImplemented) return false;
  if (error.status === HTTP_NOT_FOUND) return hadSessionId;
  const text = (error.data as { text?: unknown } | undefined)?.text;
  return (
    error.status === HTTP_BAD_REQUEST && typeof text === "string" && SESSION_EXPIRED_BODY.test(text)
  );
}

/**
 * 统计 fetch 层的网络失败：请求失败或事件流体出错都计一次，任何 HTTP 响应清零。
 * HTTP/SSE server 停掉时 SDK 不派发 onclose，只能由这里发现。主动关闭产生的 abort 不计数。
 */
export function countNetworkFailures(
  send: typeof globalThis.fetch,
  onExhausted: () => void,
): typeof globalThis.fetch {
  let failures = 0;
  const fail = (error: unknown) => {
    if (!isNetworkFailure(getErrorCode(error))) return;
    if (++failures < MCP_TERMINAL_NETWORK_FAILURE_LIMIT) return;
    failures = 0;
    onExhausted();
  };
  return (async (input, init) => {
    let response: Response;
    try {
      response = await send(input, init);
    } catch (error) {
      fail(error);
      throw error;
    }
    failures = 0;
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
      return response;
    return new Response(observeStreamErrors(response.body, fail), {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  }) as typeof globalThis.fetch;
}

function observeStreamErrors(
  body: ReadableStream<Uint8Array>,
  onError: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        onError(error);
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
