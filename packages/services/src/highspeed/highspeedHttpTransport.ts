import {
  highspeedDrawResponseSchema,
  highspeedHealthyResponseSchema,
  type HighspeedDrawRequest,
} from "@zcode/shared";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import { withRequestIdHeader } from "#src/providers/api/requestIdHeaders.js";
import type { HighspeedServiceTransport } from "./highspeedCardService.js";

const DIAGNOSTIC_HEADER_NAMES = ["x-request-id", "x-trace-id", "x-span-id"] as const;
const MAX_LOG_TEXT_CHARS = 1_000;
/**
 * 后台请求生命期上限。必须明确大于 1s 发送等待预算：慢但合法的 draw 仍能在后台落地供下一轮使用；
 * 同时保证永不返回的连接有界结束并释放 in-flight draw（spec §3 规则 6）。
 */
export const HIGHSPEED_REQUEST_TIMEOUT_MS = 20_000;

class HighspeedBusinessResponseError extends Error {
  constructor(
    readonly operation: "draw" | "healthy",
    readonly businessCode: number,
  ) {
    super(`highspeed ${operation} failed: business code ${businessCode}`);
    this.name = "HighspeedBusinessResponseError";
  }
}

export function createHighspeedHttpTransport(options: {
  drawUrl: string;
  healthyBaseUrl: string;
  drawHeaders: () => Promise<Record<string, string>>;
  healthyHeaders: () => Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
  logger: Pick<ServiceLogger, "warn">;
  /** 单次 draw/healthy 请求的生命期上限；缺省 HIGHSPEED_REQUEST_TIMEOUT_MS。 */
  requestTimeoutMs?: number;
}): HighspeedServiceTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger;
  const requestTimeoutMs = options.requestTimeoutMs ?? HIGHSPEED_REQUEST_TIMEOUT_MS;

  async function performRequest<T>(params: {
    operation: "draw" | "healthy";
    method: "GET" | "POST";
    url: string;
    body?: HighspeedDrawRequest;
    resolveHeaders: () => Promise<Record<string, string>>;
    parse: (payload: unknown) => { success: true; data: T } | { success: false; error: Error };
  }): Promise<T> {
    const startedAt = Date.now();
    const safeUrl = sanitizeLogUrl(params.url);
    let headers: Headers;
    try {
      headers = withRequestIdHeader({
        ...(params.body ? { "content-type": "application/json" } : {}),
        ...(await params.resolveHeaders()),
      });
    } catch (error) {
      logger.warn(undefined, "Highspeed 接口请求准备失败", {
        operation: params.operation,
        method: params.method,
        url: safeUrl,
        durationMs: Date.now() - startedAt,
        error: readErrorMessage(error, params.url, safeUrl),
      });
      throw error;
    }

    const requestId = headers.get("x-request-id") ?? undefined;
    // Bug 根因：fetch 过去没有任何 deadline。代理/服务端接受连接后永不返回时 Promise 永久 pending，
    // 而 HighspeedCardService.inFlightDraw 只在该 Promise settle 的 finally 里释放——后续所有发送都
    // 复用这个死 Promise、各等 1s 再降级，整个应用生命周期内不再发起新 draw、next_draw_at 也无法更新。
    // 这里给请求一个有界生命期，超时后 abort → reject 让 finally 得以执行；deadline 同时覆盖响应体
    // 读取，服务端在 headers 之后停滞同样会被终止（与 bots/providers/providerRequest.ts 同一做法）。
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort(
        new Error(`highspeed ${params.operation} request timed out after ${requestTimeoutMs}ms`),
      );
    }, requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(params.url, {
          method: params.method,
          headers,
          signal: controller.signal,
          ...(params.body ? { body: JSON.stringify(params.body) } : {}),
        });
      } catch (error) {
        // Bug 原因：Highspeed 过去只把 fetch 异常透传到 RPC，无法区分失败的接口与请求链路。
        // 这里只记录脱敏路由和 request id，不记录请求头/body，避免 JWT 与任务数据落盘。
        logger.warn(undefined, "Highspeed 接口网络请求失败", {
          operation: params.operation,
          method: params.method,
          url: safeUrl,
          requestId,
          durationMs: Date.now() - startedAt,
          error: readErrorMessage(error, params.url, safeUrl),
        });
        throw error;
      }

      return await readHighspeedResponse({
        logger,
        operation: params.operation,
        method: params.method,
        rawUrl: params.url,
        safeUrl,
        requestId,
        startedAt,
        response,
        parse: params.parse,
      });
    } finally {
      clearTimeout(deadline);
    }
  }

  return {
    draw: (request, headers) =>
      performRequest({
        operation: "draw",
        method: "POST",
        url: options.drawUrl,
        body: request,
        resolveHeaders: headers ? async () => headers : options.drawHeaders,
        parse: (payload) => highspeedDrawResponseSchema.safeParse(payload),
      }),
    async healthy(cardId, headers) {
      const parsed = await performRequest({
        operation: "healthy",
        method: "GET",
        url: new URL(`${encodeURIComponent(cardId)}/healthy`, options.healthyBaseUrl).toString(),
        resolveHeaders: headers ? async () => headers : options.healthyHeaders,
        parse: (payload) => highspeedHealthyResponseSchema.safeParse(payload),
      });
      return {
        cardId: parsed.data.card_id,
        promptTokens: parsed.data.prompt_tokens,
        completionTokens: parsed.data.completion_tokens,
        durationSeconds: parsed.data.duration_seconds,
      };
    },
  };
}

async function readHighspeedResponse<T>(params: {
  logger: Pick<ServiceLogger, "warn">;
  operation: "draw" | "healthy";
  method: "GET" | "POST";
  rawUrl: string;
  safeUrl: string;
  requestId: string | undefined;
  startedAt: number;
  response: Response;
  parse: (payload: unknown) => { success: true; data: T } | { success: false; error: Error };
}): Promise<T> {
  const responseHeaders = readDiagnosticHeaders(params.response.headers);
  let responseText: string;
  try {
    responseText = await params.response.text();
  } catch (error) {
    logResponseFailure(params, "Highspeed 接口响应读取失败", {
      responseHeaders,
      error: readErrorMessage(error, params.rawUrl, params.safeUrl),
    });
    throw error;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText) as unknown;
  } catch (error) {
    if (!params.response.ok) {
      logResponseFailure(params, "Highspeed 接口 HTTP 请求失败", {
        responseHeaders,
        response: summarizeResponse(responseText),
      });
      throw new Error(`highspeed ${params.operation} failed: ${params.response.status}`, {
        cause: error,
      });
    }
    logResponseFailure(params, "Highspeed 接口响应 JSON 解析失败", {
      responseHeaders,
      response: summarizeResponse(responseText),
      error: readErrorMessage(error, params.rawUrl, params.safeUrl),
    });
    throw error;
  }

  const responseSummary = summarizeResponse(payload);
  if (!params.response.ok) {
    logResponseFailure(params, "Highspeed 接口 HTTP 请求失败", {
      responseHeaders,
      response: responseSummary,
    });
    throw new Error(`highspeed ${params.operation} failed: ${params.response.status}`);
  }

  const parsed = params.parse(payload);
  if (!parsed.success) {
    logResponseFailure(params, "Highspeed 接口响应结构校验失败", {
      responseHeaders,
      response: responseSummary,
      error: truncateLogText(parsed.error.message),
    });
    throw parsed.error;
  }
  const businessCode = readBusinessCode(parsed.data);
  if (businessCode !== undefined && businessCode !== 0) {
    logResponseFailure(params, "Highspeed 接口业务失败", {
      responseHeaders,
      response: responseSummary,
    });
    // Bug 根因：旧实现只记录非零业务码却继续返回 data，会让调用方缓存
    // 被后端拒绝的卡或把 share/healthy 误判为成功。业务失败必须在 I/O 边界向上传播。
    throw new HighspeedBusinessResponseError(params.operation, businessCode);
  }
  return parsed.data;
}

function logResponseFailure(
  params: {
    logger: Pick<ServiceLogger, "warn">;
    operation: "draw" | "healthy";
    method: "GET" | "POST";
    safeUrl: string;
    requestId: string | undefined;
    startedAt: number;
    response: Response;
  },
  message: string,
  context: Record<string, unknown>,
): void {
  params.logger.warn(undefined, message, {
    operation: params.operation,
    method: params.method,
    url: params.safeUrl,
    requestId: params.requestId,
    durationMs: Date.now() - params.startedAt,
    status: params.response.status,
    statusText: params.response.statusText,
    ...context,
  });
}

function sanitizeLogUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-highspeed-url>";
  }
}

function readDiagnosticHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of DIAGNOSTIC_HEADER_NAMES) {
    const value = headers.get(name)?.trim();
    if (value) result[name] = value;
  }
  return result;
}

function truncateLogText(value: string): string {
  const trimmed = value.trim();
  const truncated =
    trimmed.length > MAX_LOG_TEXT_CHARS ? `${trimmed.slice(0, MAX_LOG_TEXT_CHARS)}…` : trimmed;
  return truncated
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<redacted-jwt>")
    .replace(
      /(["']?(?:token|authorization|api[_-]?key|secret)["']?\s*[:=]\s*["'])[^"']+/gi,
      "$1<redacted>",
    );
}

function readErrorMessage(error: unknown, rawUrl: string, safeUrl: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncateLogText(message.replaceAll(rawUrl, safeUrl));
}

function summarizeResponse(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { bodyPreview: truncateLogText(String(payload ?? "")) };
  }
  const record = payload as Record<string, unknown>;
  const message = [record.msg, record.message, record.error, record.detail].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return {
    ...(typeof record.code === "number" || typeof record.code === "string"
      ? { code: record.code }
      : {}),
    ...(message ? { message: truncateLogText(message) } : {}),
    fields: Object.keys(record).sort(),
  };
}

function readBusinessCode(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const code = (payload as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}
