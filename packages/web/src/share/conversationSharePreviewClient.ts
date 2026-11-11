import {
  conversationShareErrorEnvelopeSchema,
  classifyConversationShareError,
  conversationShareRequestIdSchema,
  conversationSharePreviewDataSchema,
  createConversationShareSuccessEnvelopeSchema,
  decodeConversationShareRows,
  isConversationShareSchemaVersionSupported,
  parseConversationSharePathname,
  type ConversationShareErrorKind,
  type ConversationSharePreview,
} from "@zcode/shared";

const SHARE_CODE_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/u;

export type ConversationSharePreviewErrorKind = ConversationShareErrorKind;

export class ConversationSharePreviewClientError extends Error {
  readonly kind: ConversationSharePreviewErrorKind;
  readonly status?: number;
  readonly code?: number;
  readonly requestId?: string;

  constructor(options: {
    kind: ConversationSharePreviewErrorKind;
    message: string;
    status?: number;
    code?: number;
    requestId?: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConversationSharePreviewClientError";
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
    const requestId = conversationShareRequestIdSchema.safeParse(options.requestId);
    if (requestId.success) this.requestId = requestId.data;
  }
}

export function isSafeConversationShareCode(value: string): boolean {
  return SHARE_CODE_PATTERN.test(value);
}

export function parseConversationShareRoute(pathname: string): string | null {
  const parsed = parseConversationSharePathname(pathname);
  if (!parsed) return null;
  let code: string;
  try {
    code = decodeURIComponent(parsed.rawCode);
  } catch {
    return null;
  }
  return isSafeConversationShareCode(code) ? code : null;
}

/** 页面语言由路径前缀决定：/cn/share 中文，裸 /share 英文；非分享路径回退到浏览器语言。 */
export function resolveConversationShareRouteLocale(pathname: string): "zh-CN" | "en-US" {
  const parsed = parseConversationSharePathname(pathname);
  if (parsed) return parsed.locale;
  return /^zh(?:-|$)/iu.test(navigator.language) ? "zh-CN" : "en-US";
}

export function buildShareImportDeepLink(shareCode: string): string {
  if (!isSafeConversationShareCode(shareCode)) {
    throw new TypeError("Invalid conversation share code");
  }
  return `zcode://share/import?code=${encodeURIComponent(shareCode)}`;
}

export interface ConversationSharePreviewClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  diagnostics?: ConversationSharePreviewDiagnostics;
}

export interface ConversationSharePreviewDiagnostics {
  info(event: string, details: Record<string, unknown>): void;
  warn(event: string, details: Record<string, unknown>): void;
}

// fetch/CORS/DNS 异常不能统一折叠为 network：需要看到请求是否发起以及实际 endpoint。
// 日志只保留脱敏目标和传输元数据，禁止记录 share code、JWT、响应正文或 Signed URL。
const DEFAULT_DIAGNOSTICS: ConversationSharePreviewDiagnostics = {
  info(event, details) {
    console.info("[conversation-share-web]", event, details);
  },
  warn(event, details) {
    console.warn("[conversation-share-web]", event, details);
  },
};

const successEnvelopeSchema = createConversationShareSuccessEnvelopeSchema(
  conversationSharePreviewDataSchema,
);

export class ConversationSharePreviewClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly diagnostics: ConversationSharePreviewDiagnostics;

  constructor(options: ConversationSharePreviewClientOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
    // 直接保存 window.fetch 后以实例方法调用会把 this 绑定到 Client，Chromium 因此抛 Illegal invocation。
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.diagnostics = options.diagnostics ?? DEFAULT_DIAGNOSTICS;
  }

  async getPreview(shareCode: string, accessToken?: string): Promise<ConversationSharePreview> {
    if (!isSafeConversationShareCode(shareCode)) {
      throw new ConversationSharePreviewClientError({
        kind: "invalid_contract",
        message: "Invalid conversation share code",
      });
    }

    const headers = accessToken?.trim()
      ? { Authorization: `Bearer ${accessToken.trim()}` }
      : undefined;
    const authenticated = headers !== undefined;
    const requestTarget = `${this.baseUrl}/shares/<redacted>/preview`;
    this.diagnostics.info("preview_request_started", {
      requestTarget,
      pageOrigin: globalThis.location?.origin ?? "unavailable",
      authenticated,
      shareCodeLength: shareCode.length,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/shares/${encodeURIComponent(shareCode)}/preview`,
        { method: "GET", ...(headers ? { headers } : {}) },
      );
    } catch (error) {
      const errorName = error instanceof Error ? error.name : typeof error;
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      const errorMessage = rawErrorMessage
        .replaceAll(shareCode, "<redacted>")
        .replaceAll(encodeURIComponent(shareCode), "<redacted>");
      this.diagnostics.warn("preview_request_failed", {
        requestTarget,
        authenticated,
        errorName,
        errorMessage,
      });
      throw new ConversationSharePreviewClientError({
        kind: "network",
        message: "Unable to load this conversation share",
        cause: error,
      });
    }

    this.diagnostics.info("preview_response_received", {
      requestTarget,
      authenticated,
      status: response.status,
      ok: response.ok,
      redirected: response.redirected,
      contentType: response.headers.get("content-type"),
    });

    const headerId = conversationShareRequestIdSchema.safeParse(
      response.headers.get("x-request-id"),
    );
    const requestId = headerId.success ? headerId.data : undefined;
    let body: string;
    try {
      body = await response.text();
    } catch (cause) {
      throw new ConversationSharePreviewClientError({
        kind: "network",
        message: "Share response interrupted",
        status: response.status,
        requestId,
        cause,
      });
    }
    if (!response.ok && !body.trim()) {
      throw new ConversationSharePreviewClientError({
        kind: classifyConversationShareError(response.status),
        message: "Conversation share API failed",
        status: response.status,
        requestId,
      });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch (error) {
      throw new ConversationSharePreviewClientError({
        kind: response.ok ? "invalid_contract" : classifyConversationShareError(response.status),
        message: "Conversation share API returned invalid JSON",
        status: response.status,
        requestId,
        cause: error,
      });
    }

    if (!response.ok) {
      const parsedError = conversationShareErrorEnvelopeSchema.safeParse(payload);
      if (parsedError.success) {
        // 未知业务码保留 code 和请求 ID，方便关联服务端日志。
        throw new ConversationSharePreviewClientError({
          kind: classifyConversationShareError(response.status, parsedError.data.code),
          message: parsedError.data.msg,
          status: response.status,
          requestId: requestId ?? parsedError.data.logid,
          code: parsedError.data.code,
        });
      }
      throw new ConversationSharePreviewClientError({
        kind: classifyConversationShareError(response.status),
        message: "Conversation share API failed",
        status: response.status,
        requestId,
      });
    }

    const parsed = successEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ConversationSharePreviewClientError({
        kind: "invalid_contract",
        message: "Conversation share preview does not match the public contract",
        status: response.status,
        requestId,
        cause: parsed.error,
      });
    }
    const data = parsed.data.data;
    // 落地页镜像是独立部署、独立回滚的，所以它随时可能比发布分享的客户端旧。版本高于本
    // build 认知时要说「请升级」，不能混进「分享格式无效」。
    if (!isConversationShareSchemaVersionSupported(data.schema_version)) {
      this.diagnostics.warn("preview_schema_version_unsupported", {
        requestTarget,
        version: data.schema_version,
      });
      throw new ConversationSharePreviewClientError({
        kind: "unsupported_schema_version",
        message: "Conversation share requires a newer ZCode version",
        status: response.status,
        requestId,
      });
    }
    // 逐行降级：认不出的行跳过并计数，不让整页打不开。
    const decoded = decodeConversationShareRows(data.rows);
    if (decoded.unsupportedCount > 0) {
      this.diagnostics.info("preview_dropped_unsupported_rows", {
        requestTarget,
        kinds: decoded.unsupportedKinds,
        droppedCount: decoded.unsupportedCount,
        keptCount: decoded.rows.length,
      });
    }
    return { ...data, rows: decoded.rows, unsupportedRowCount: decoded.unsupportedCount };
  }
}
