/* 官方 Server MCP 的逐请求动态身份头注入与失败分类。
 *
 * 这里是唯一的凭证出口：包裹 createMcpTransportFetch 得到的 fetch，在 SDK 组装完
 * _commonHeaders() 与 requestInit 之后、真正发出请求之前注入。因此现有的 HTTP 代理、
 * 自定义 CA、No Proxy 策略全部保留——本 wrapper 只包裹它，不绕过。
 */
import {
  findOfficialMcpReservedHeaders,
  isOfficialMcpReservedHeaderName,
  summarizeOfficialMcpIdentityHeaders,
  type McpServerFailureKind,
  type OfficialMcpAuthFailureKind,
} from "@zcode/shared";
import type {
  Logger,
  McpOfficialProvenance,
  OfficialMcpAuthHeadersPort,
  OfficialMcpTrustedOriginRegistry,
} from "@zcode/contracts";

/** 由 adapter 抛出的、带稳定分类的官方鉴权错误。禁止调用方按 message 文本分流。 */
export class OfficialMcpAuthError extends Error {
  constructor(
    readonly kind: OfficialMcpAuthFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "OfficialMcpAuthError";
  }
}

/**
 * 关联 id 的 header 名。
 *
 * 用途有两个，都**不是**发送：
 * 1. 从请求头里剥离，避免插件静态配置把这两个可观测通道注入官方端点；
 * 2. 从**响应头**读取服务端自己生成的 request id，记入日志用于端到端对账。
 *
 * 客户端不发送这两个头：服务端始终自行生成请求 id、不读入站值，发了不会被任何人读取。
 */
const REQUEST_ID_HEADER = "x-request-id";
const TRACE_ID_HEADER = "x-trace-id";

export interface CreateOfficialMcpAuthFetchInput {
  authHeadersPort?: OfficialMcpAuthHeadersPort;
  baseFetch: typeof globalThis.fetch;
  logger?: Logger;
  /**
   * 分类上报钩子。SDK 的 version negotiation 会把本模块抛出的 OfficialMcpAuthError
   * 重新包装成普通 Error（message 保留、对象身份丢失），因此 instanceof 在上层不可靠。
   * 分类必须在抛出点上报，不能靠上层解析错误文本判断（项目规范禁止按错误文本分流）。
   */
  onAuthFailure?: (kind: OfficialMcpAuthFailureKind) => void;
  /**
   * 服务端 request id 的上报钩子，用于把它关联回具体一次 `tools/call`。
   *
   * 只有这一层能看到响应头：wrapper 之上是 MCP SDK，它只把 JSON-RPC 结果交给 adapter。
   * 因此 in-band 失败（HTTP 200 + `isError: true`，如配额耗尽）想带上 request id，
   * 必须由这里把它送出去，再由 adapter 按 span 关联。
   */
  onServerResponse?: (response: OfficialMcpServerResponseInfo) => void;
  official: McpOfficialProvenance;
  serverName: string;
  trustedOrigins: OfficialMcpTrustedOriginRegistry;
  /** MCP endpoint URL；Origin 校验以每次请求的实际 URL 为准，不只在连接时校验一次。 */
  url: string;
  workspaceIdentity?: string;
  workspacePath?: string;
  workspaceKey?: string;
}

/** 一次官方 MCP 响应中可用于关联的非敏感事实。不含 body、不含任何 header 值。 */
export interface OfficialMcpServerResponseInfo {
  failureKind?: McpServerFailureKind;
  httpStatus: number;
  rpcMethod?: string;
  rpcToolName?: string;
  /** 服务端自行生成的 `x-request-id`；无 HTTP response 时缺失且绝不伪造。 */
  serverRequestId?: string;
  /** 发起该请求的 tool call span。adapter 用它把 request id 关联回具体一次调用。 */
  spanId?: string;
  traceId?: string;
}

/**
 * 每次可信 Origin 请求前重新解析身份头并注入；解析失败才匿名降级。
 *
 * 关键语义：
 * - Origin 逐请求校验。SDK 可能在 session 期间对同一 transport 发多种请求，
 *   只在连接时校验一次会给后续 URL 变化留下缺口；
 * - 保留头用 set 覆盖语义。append 会产生逗号拼接的多值 Authorization，
 *   "缺失才补"会让非预期的既有值存活（例如 authProvider 写入的 OAuth token）；
 * - redirect: "manual"，3xx 直接失败，避免 Bearer Token 被跨 Origin redirect 带走；
 * - 只有实际注入过凭证的请求才在 401 后重试一次；403/3xx 不重试。
 */
export function createOfficialMcpAuthFetch(
  input: CreateOfficialMcpAuthFetchInput,
): typeof globalThis.fetch {
  const expectedOrigin = safeOrigin(input.url);

  /**
   * 上报分类并构造错误，由调用点 `throw`。
   * 不在此处直接 throw：返回 never 的箭头函数不会触发 TS 控制流收窄
   * （需要调用目标带显式类型注解），会让 throw 之后的 origin / resolved 仍是联合类型。
   */
  const failWith = (kind: OfficialMcpAuthFailureKind, message: string): OfficialMcpAuthError => {
    input.onAuthFailure?.(kind);
    return new OfficialMcpAuthError(kind, message);
  };

  const authFetch = async (
    resource: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const requestUrl = resolveRequestUrl(resource);
    const origin = safeOrigin(requestUrl);
    if (!origin || !expectedOrigin || origin !== expectedOrigin) {
      throw failWith(
        "official_mcp_origin_untrusted",
        `official MCP request origin does not match the configured endpoint: ${input.serverName}`,
      );
    }
    const trust = await input.trustedOrigins.isTrusted({
      mcpKey: input.official.mcpKey,
      origin,
      pluginId: input.official.pluginId,
    });
    if (!trust.trusted) {
      // fail closed：网络请求次数必须为 0，凭证也不会被解析。
      // message 里带上 origin 与 pluginId：只报 serverName 时，看到 detail 也无法判断
      // 判定输入到底是什么（曾因此把 pluginId 后缀问题误查成 url 配置问题）。
      throw failWith(
        "official_mcp_origin_untrusted",
        `official MCP origin is not trusted (${trust.detail ?? "unknown"}): ` +
          `${input.serverName} origin=${origin} pluginId=${input.official.pluginId}`,
      );
    }

    // 请求级 debug 上下文。刻意只含非敏感项：rpc 方法名、请求体字节数、路径。
    // 不记 body 内容（含用户 query），不记任何 header 值。
    const rpc = describeJsonRpc(init?.body);
    const logBase = {
      event: "mcp.official_auth.request",
      mcpKey: input.official.mcpKey,
      mcpServerName: input.serverName,
      module: "adapters.mcp.official_auth",
      requestBodyBytes: byteLength(init?.body),
      urlPath: safePath(requestUrl),
      ...(rpc.method ? { rpcMethod: rpc.method } : {}),
      ...(rpc.id !== undefined ? { rpcId: rpc.id } : {}),
      ...(rpc.toolName ? { rpcToolName: rpc.toolName } : {}),
      ...(rpc.traceId ? { mcpTraceId: rpc.traceId } : {}),
    };

    const send = async (attempt: number): Promise<{ authApplied: boolean; response: Response }> => {
      let authHeaders: Record<string, string> = {};
      let resolveDurationMs: number | undefined;
      if (input.authHeadersPort) {
        const resolveStartedAt = Date.now();
        const resolved = await input.authHeadersPort.resolveHeaders({
          mcpKey: input.official.mcpKey,
          pluginId: input.official.pluginId,
          targetOrigin: origin,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
          ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
          ...(input.workspaceKey ? { workspaceKey: input.workspaceKey } : {}),
          ...(init?.signal ? { signal: init.signal } : {}),
        });
        resolveDurationMs = Date.now() - resolveStartedAt;
        if (resolved.ok) {
          authHeaders = resolved.headers;
        } else {
          // 解析不到身份时仍把无身份请求交给 server 做权威判定；adapter 不缓存旧凭证，
          // 也不在本地把解析失败冒充为网络失败。
          input.logger?.warn("Official MCP auth headers unavailable for request", {
            ...logBase,
            attempt,
            event: "mcp.official_auth.resolve",
            fallback: "anonymous",
            reason: resolved.reason,
            resolveDurationMs,
            status: "failed",
          });
        }
      } else {
        input.logger?.warn("Official MCP auth port unavailable for request", {
          ...logBase,
          attempt,
          event: "mcp.official_auth.resolve",
          fallback: "anonymous",
          reason: "official_auth_unavailable",
          status: "failed",
        });
      }
      // 只记 header 名与套餐维度，绝不记 header 值。targetType 是 PERSONAL/TEAM 这类
      // 低敏枚举，但对"为什么服务端判我没权益"最关键，因此保留原值。
      const identity = summarizeOfficialMcpIdentityHeaders(authHeaders);
      const headers = mergeOfficialAuthHeaders(init?.headers, authHeaders);

      // 关联 id 一律**不外发**，只剥离。
      //
      // 服务端不会采用客户端传入的 request id，始终自行生成、不读入站 header。
      // 因此客户端发送
      // X-Request-Id / X-Trace-Id 不会被任何人读取，属死代码且会误导后来者。
      //
      // 端到端对账改为反方向：读服务端**响应头**里的 x-request-id 并记入日志
      // （见下方 serverRequestId），用它去查服务端日志。
      //
      // 仍然显式 delete 而不是放任：这两个 header 语义上属于关联/可观测通道，不应由
      // 插件静态配置注入到官方端点——插件设的值会原样出现在服务端及中间层日志里。
      headers.delete(REQUEST_ID_HEADER);
      headers.delete(TRACE_ID_HEADER);

      input.logger?.debug("Official MCP request sending", {
        ...logBase,
        attempt,
        resolveDurationMs,
        status: "started",
        timeoutHint: describeAbortSignal(init?.signal),
        ...identity,
      });

      const sendStartedAt = Date.now();
      try {
        const response = await input.baseFetch(resource, {
          ...init,
          headers,
          // 第一阶段不跟随任何重定向；正式 endpoint 应配置为 canonical URL。
          redirect: "manual",
        });
        // 服务端自行生成的 request id，从响应头读回。这是**唯一**能把客户端日志与
        // 服务端日志对上的键：客户端不发送该头，服务端也不采纳入站值。
        const serverRequestId = readServerRequestId(response);
        // Settings 只消费连接、initialize 与 tools/list 诊断。tools/call 可能返回大媒体，
        // 其 request id 已按 span 投影到 tool result，禁止为了设置页再 clone/读取响应体。
        const failureKind =
          rpc.method === "tools/call" ? undefined : await classifyOfficialMcpResponse(response);
        if (serverRequestId || failureKind) {
          // 上报给 adapter 做关联。放在日志之前：即使日志级别把两条记录都过滤掉，
          // in-band 失败仍然拿得到这个 id。
          input.onServerResponse?.({
            httpStatus: response.status,
            ...(failureKind ? { failureKind } : {}),
            ...(serverRequestId ? { serverRequestId } : {}),
            ...(rpc.method ? { rpcMethod: rpc.method } : {}),
            ...(rpc.toolName ? { rpcToolName: rpc.toolName } : {}),
            ...(rpc.spanId ? { spanId: rpc.spanId } : {}),
            ...(rpc.traceId ? { traceId: rpc.traceId } : {}),
          });
        }
        const outcome = {
          ...logBase,
          attempt,
          httpStatus: response.status,
          responseBodyBytes: numericHeader(response.headers.get("content-length")),
          sendDurationMs: Date.now() - sendStartedAt,
          ...(serverRequestId ? { serverRequestId } : {}),
        };
        if (response.ok) {
          input.logger?.debug("Official MCP response received", {
            ...outcome,
            status: "completed",
          });
        } else {
          // 非 2xx 必须记在 warn，不能只有上面那条 debug。
          //
          // 生产构建的 logger 最低级别是 Info（见 logging/index.ts 的
          // getDefaultMinLevel），debug 直接被丢弃。结果是出错时——恰恰是唯一需要对账的
          // 时候——服务端 request id 在日志里根本不存在，只能靠读代码反推（3001
          // "parameter error" 那次排查就是这样）。
          //
          // 这里刻意不吞掉响应：4xx/5xx 仍原样交回 SDK，由它按协议报错，本 wrapper 只
          // 补一条可检索的记录。401/403/3xx 的分类失败在下方另行抛出。
          input.logger?.warn("Official MCP response failed", {
            ...outcome,
            status: "failed",
          });
        }
        return { authApplied: Object.keys(authHeaders).length > 0, response };
      } catch (error) {
        // 超时/取消在这里表现为 AbortError。区分二者对定位"是谁掐断的"很关键：
        // 上层工具超时预算到期与用户主动取消都会走 abort，但 elapsed 与预算的关系不同。
        const sendDurationMs = Date.now() - sendStartedAt;
        input.logger?.warn("Official MCP request did not complete", {
          ...logBase,
          aborted: isAbortError(error),
          attempt,
          error: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : "unknown",
          sendDurationMs,
          status: "failed",
        });
        throw error;
      }
    };

    let sent = await send(1);
    let response = sent.response;
    if (response.status === 401 && sent.authApplied) {
      // 至多重试一次，无条件。能靠重试自愈的只有"请求发出后凭证恰好被刷新"这一窄竞态；
      // 上限为 1，不存在自旋可能。
      input.logger?.info("Official MCP retrying once after 401", {
        ...logBase,
        attempt: 2,
        status: "started",
      });
      await discardBody(response);
      sent = await send(2);
      response = sent.response;
    }

    if (response.status === 401) {
      const baseMessage = "official MCP rejected the current credential";
      const message =
        rpc.method === "tools/call" ? withServerRequestId(baseMessage, response) : baseMessage;
      await discardBody(response);
      throw failWith("official_auth_rejected", message);
    }
    if (response.status === 403) {
      // 身份有效但权限/套餐不足，重取同一份凭证不会改变结果。
      const baseMessage = "official MCP denied access for the current plan";
      const message =
        rpc.method === "tools/call" ? withServerRequestId(baseMessage, response) : baseMessage;
      await discardBody(response);
      throw failWith("official_auth_forbidden", message);
    }
    if (isRedirect(response.status)) {
      const baseMessage = `official MCP responded with a blocked redirect (${response.status})`;
      const message =
        rpc.method === "tools/call" ? withServerRequestId(baseMessage, response) : baseMessage;
      await discardBody(response);
      throw failWith("official_auth_redirect_blocked", message);
    }
    return response;
  };

  return authFetch as typeof globalThis.fetch;
}

const MAX_DIAGNOSTIC_RESPONSE_BYTES = 64 * 1024;

async function classifyOfficialMcpResponse(
  response: Response,
): Promise<McpServerFailureKind | undefined> {
  if (response.status === 429) return "rate_limited";
  if (response.status >= 500) return "server_internal_error";

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    return response.ok ? undefined : "connection_failed";
  }
  const text = await readBoundedResponseText(response, MAX_DIAGNOSTIC_RESPONSE_BYTES);
  if (!text) return response.ok ? undefined : "connection_failed";
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return response.ok ? undefined : "connection_failed";
    }
    const record = parsed as Record<string, unknown>;
    if (record["code"] === 3001) return "server_not_found";
    if (record["code"] === 1000) return "server_unavailable";
    if (record["jsonrpc"] === "2.0" && record["error"] !== undefined) {
      const rpcError = record["error"];
      if (rpcError && typeof rpcError === "object" && !Array.isArray(rpcError)) {
        const code = (rpcError as Record<string, unknown>)["code"];
        if (code === 1006) return "not_authenticated";
        if (code === 3101) return "coding_plan_required";
      }
      return "protocol_error";
    }
  } catch {
    return response.ok ? undefined : "connection_failed";
  }
  return response.ok ? undefined : "connection_failed";
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  const declaredLength = numericHeader(response.headers.get("content-length"));
  if (declaredLength !== undefined && declaredLength > maxBytes) return undefined;
  const body = response.clone().body;
  if (!body) return undefined;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/**
 * 合并静态 header 与身份头。身份头一律覆盖（set），并剔除来源侧残留的保留头
 * ——parse 期已拦截静态保留头，这里是合并点的二次强制。
 * 不触碰 mcp-session-id / mcp-protocol-version / accept / content-type。
 */
export function mergeOfficialAuthHeaders(
  incoming: HeadersInit | undefined,
  authHeaders: Record<string, string>,
): Headers {
  const merged = new Headers();
  const authHeaderNames = new Set(Object.keys(authHeaders).map((name) => name.toLowerCase()));
  new Headers(incoming ?? {}).forEach((value, name) => {
    const normalized = name.toLowerCase();
    // 身份头稍后统一写入；其余保留头（如 authProvider 写入的 Authorization）直接丢弃。
    if (authHeaderNames.has(normalized)) return;
    if (
      isOfficialMcpReservedHeaderName(normalized) &&
      normalized !== "mcp-session-id" &&
      normalized !== "mcp-protocol-version"
    ) {
      return;
    }
    merged.set(name, value);
  });
  for (const [name, value] of Object.entries(authHeaders)) {
    merged.set(name, value);
  }
  return merged;
}

/** 供 adapter 在解析配置时复用，保证黑名单在 parse 与合并两处同源。 */
export { findOfficialMcpReservedHeaders };

function resolveRequestUrl(resource: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof resource === "string") return resource;
  if (resource instanceof URL) return resource.toString();
  return resource.url;
}

function safeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    // 带凭证的 URL 与其 origin 不是同一信任面，直接判为不可信。
    if (url.username !== "" || url.password !== "") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** 服务端在响应头里回带的 request id。缺失时返回 undefined。 */
function readServerRequestId(response: Response): string | undefined {
  const value = response.headers.get(REQUEST_ID_HEADER)?.trim();
  return value ? value : undefined;
}

/**
 * 把服务端 request id 附到分类错误的 message 上。
 *
 * tool call 分类错误直接向上展示，使用紧凑的 `message - requestId` 形态。连接期 request id
 * 由 adapter 的结构化 status diagnostic 统一拼接，避免 SDK 包装前后重复。
 */
function withServerRequestId(message: string, response: Response): string {
  const requestId = readServerRequestId(response);
  return requestId ? `${message} - ${requestId}` : message;
}

/** 请求路径（不含 query）。query 可能带用户内容，因此丢弃。 */
function safePath(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return "(unparsable)";
  }
}

function byteLength(body: unknown): number | undefined {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof Uint8Array) return body.byteLength;
  return undefined;
}

function numericHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 从 JSON-RPC 请求体里取出**结构性**字段用于关联日志：method / id / tools\_call 的工具名 /
 * `_meta` 里的 trace\_id。
 * 刻意不取 `params.arguments`——那里是用户输入（如搜索词），不属于"没那么敏感"的范畴。
 *
 * trace\_id 仅在 `tools/call` 上存在：`initialize` / `tools/list` 由 SDK 在建连阶段发出，
 * 没有 `_meta`，因此那两个请求只有 request id、没有 trace id。这是预期的，不是缺陷。
 */
function describeJsonRpc(body: unknown): {
  id?: number | string;
  method?: string;
  spanId?: string;
  toolName?: string;
  traceId?: string;
} {
  if (typeof body !== "string" || body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const method = typeof record.method === "string" ? record.method : undefined;
    const id =
      typeof record.id === "number" || typeof record.id === "string" ? record.id : undefined;
    const params = isPlainRecord(record.params) ? record.params : undefined;
    const toolName = params && typeof params.name === "string" ? params.name : undefined;
    // mcpRequestMeta 把 trace 写在 params._meta 上（同时有扁平键与 com.zcode/ 命名空间键）。
    const meta = params && isPlainRecord(params._meta) ? params._meta : undefined;
    const traceId = meta && typeof meta.trace_id === "string" ? meta.trace_id : undefined;
    // span 才是"一次 tool call"的粒度：traceId 覆盖整个顶层 session，同一 session 里的
    // 多次调用共用它，用它做关联会串号。
    const spanId = meta && typeof meta.span_id === "string" ? meta.span_id : undefined;
    return {
      ...(id !== undefined ? { id } : {}),
      ...(method ? { method } : {}),
      ...(spanId ? { spanId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(traceId ? { traceId } : {}),
    };
  } catch {
    return {};
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 身份头的**非敏感摘要**：只有名字、是否成对、以及 targetType 的枚举值。
 * 绝不输出 Authorization 或 api-key 的值，连截断值也不输出——日志留存周期不受控。
 */
function describeAbortSignal(signal: AbortSignal | null | undefined): string {
  if (!signal) return "none";
  return signal.aborted ? "already-aborted" : "armed";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 丢弃 body 失败不影响分类结论。
  }
}
