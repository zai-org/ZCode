import type { SitesFailureReason, SitesResult } from "../contract.ts";

/**
 * 宿主在每条发给 stdio 官方 MCP 的消息上附的身份结果，键与 `@zcode/shared` 的
 * OFFICIAL_MCP_AUTH_META_KEY 一致（跨进程协议常量，单测比对）。这里不 import shared 的主入口，
 * 免得把整个 shared 打进 server.mjs。
 */
export const OFFICIAL_MCP_AUTH_META_KEY = "com.zcode/official-mcp-auth";

const AUTH_REASONS = new Set<SitesFailureReason>([
  "official_auth_unavailable",
  "official_auth_plan_required",
  "official_mcp_origin_untrusted",
]);

type AuthResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: SitesFailureReason };

/** 读出身份头；缺失或形状不对都按「官方鉴权不可用」处理，不匿名请求。 */
export function readOfficialAuth(meta: unknown): AuthResult {
  const value = isRecord(meta) ? meta[OFFICIAL_MCP_AUTH_META_KEY] : undefined;
  if (!isRecord(value))
    return { ok: false, reason: "official_auth_unavailable" };
  if (value.ok === true && isRecord(value.headers)) {
    const headers: Record<string, string> = {};
    for (const [name, header] of Object.entries(value.headers))
      if (typeof header === "string") headers[name] = header;
    if (Object.keys(headers).length) return { ok: true, headers };
  }
  const reason = value.reason as SitesFailureReason;
  return {
    ok: false,
    reason: AUTH_REASONS.has(reason) ? reason : "official_auth_unavailable",
  };
}

export interface SitesApiOptions {
  /** zcode-server origin，与宿主解析官方 MCP 目标时同一口径。 */
  origin: string;
  /** 控制面要求的 X-ZCode-App-Version；缺失返回 3001，过旧返回 3609。 */
  appVersion: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
}

export type SitesApi = (
  authMeta: unknown,
  method: "GET" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
) => Promise<SitesResult>;

/**
 * 每次请求现取身份头，不缓存、不落盘、不写日志。401 不重试：宿主下一条消息会带上刷新后的头。
 * redirect 设为 manual，3xx 按坏响应处理，避免身份头被带到别的 origin。
 */
export function createSitesApi(options: SitesApiOptions): SitesApi {
  return async (authMeta, method, path, body) => {
    const auth = readOfficialAuth(authMeta);
    if (!auth.ok) return { error: { reason: auth.reason } };
    let response: Response;
    try {
      response = await options.fetch(options.origin + path, {
        method,
        headers: {
          ...auth.headers,
          Accept: "application/json",
          "X-ZCode-App-Version": options.appVersion,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      return { error: { reason: "network" } };
    }
    if (response.status === 401)
      return { error: { reason: "unauthenticated" } };
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      return { error: { reason: "bad_response" } };
    }
    if (!isRecord(envelope) || typeof envelope.code !== "number")
      return { error: { reason: "bad_response" } };
    const logid =
      typeof envelope.logid === "string" && envelope.logid
        ? envelope.logid
        : undefined;
    if (envelope.code !== 0)
      return { error: { code: envelope.code, ...(logid ? { logid } : {}) } };
    // deleteSite 成功时省略 data；统一成 null，免得 JSON 序列化后丢掉 data 键、页面认不出成功。
    return { data: envelope.data ?? null };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
