import type { ProviderFamilyDomain } from "./model-provider-family.js";

/**
 * OAuth 领域类型定义
 *
 * 说明：敏感信息（如 appSecret）以及 provider 默认端点配置
 * 只允许放在 services 的 provider 模块中，不能放 shared 层。
 */

/** 内置 BigModel provider id */
export const BIGMODEL_PROVIDER_ID = "bigmodel" as const;

/** 内置 ZAI provider id */
export const ZAI_PROVIDER_ID = "zai" as const;
export const ZAI_CN_PROVIDER_ID = "zai_cn" as const;
export const OAUTH_LINKED_BIGMODEL_KEY = "oauth:linked_bigmodel" as const;

export function isZaiOAuthProvider(provider: string | null | undefined): boolean {
  return provider === ZAI_PROVIDER_ID || provider === ZAI_CN_PROVIDER_ID;
}

export function isBuiltinOAuthProvider(provider: string): boolean {
  return isZaiOAuthProvider(provider) || provider === BIGMODEL_PROVIDER_ID;
}

/** 同一 ZCode 主体的关联业务凭据，仅供 Host 内部使用。 */
export interface OAuthLinkedBigModel {
  customerId: string;
  accessToken: string;
}

/** 当前受支持的 Host/CLI 写入方共同维护，用于识别同账号重复登录的不同提交。 */
export const OAUTH_SESSION_REVISION_KEY = "oauth:session_revision" as const;

/** 凭据解密失败错误前缀 */
export const CREDENTIAL_DECRYPT_ERROR_PREFIX = "凭据解密失败：" as const;

/** 凭据解密失败稳定错误码 */
export const CREDENTIAL_DECRYPT_ERROR_CODE = "ZCODE_CREDENTIAL_DECRYPT_FAILED" as const;

/** 判断错误是否来自本地凭据解密失败 */
export function isCredentialDecryptError(error: unknown): boolean {
  const code = readCredentialErrorCode(error);
  if (code) {
    return code === CREDENTIAL_DECRYPT_ERROR_CODE;
  }

  // 兼容历史错误和跨边界丢失 code 的旧 payload；新错误应优先携带稳定 code。
  if (readCredentialErrorMessage(error).startsWith(CREDENTIAL_DECRYPT_ERROR_PREFIX)) {
    return true;
  }

  return false;
}

function readCredentialErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code?: unknown }).code ?? "");
  }

  return "";
}

function readCredentialErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }

  return "";
}

/** OAuth provider 标识 */
export type OAuthProviderId =
  | typeof BIGMODEL_PROVIDER_ID
  | typeof ZAI_PROVIDER_ID
  | (string & { readonly __oauthProviderBrand?: never });

/** Provider 展示元信息 */
export interface OAuthProviderMeta {
  id: OAuthProviderId;
  displayName: string;
  enabled: boolean;
  order: number;
}

/** 发起 OAuth 请求 */
export interface OAuthStartRequest {
  provider: OAuthProviderId;
}

/** 发起 OAuth 返回 */
export interface OAuthStartResponse {
  provider: OAuthProviderId;
  authorizeUrl: string;
  state: string;
}

/** 应用登录回调结果 */
export interface OAuthSessionCallbackResult {
  kind: "session";
  provider: OAuthProviderId;
  userInfo: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
  };
}

/** 只携带归因参数的 OAuth deep link 回调结果 */
export interface OAuthAttributionCallbackResult {
  kind: "attribution";
  provider: OAuthProviderId;
  attribution: OAuthLoginAttribution;
}

/** 同一登录已由 polling 完成后迟到的 deep link；调用方只需忽略。 */
export interface OAuthDuplicateCallbackResult {
  kind: "duplicate";
  provider: OAuthProviderId;
}

/** OAuth 回调归一化结果 */
export type OAuthCallbackResult =
  | OAuthSessionCallbackResult
  | OAuthAttributionCallbackResult
  | OAuthDuplicateCallbackResult;

/** Main 进程路由 deep link 时使用的 state 上报结构 */
export interface OAuthStateRegistration {
  state: string;
  provider?: OAuthProviderId;
}

/** 归一化后的回调参数 */
export interface OAuthCallbackParams {
  state: string;
  code: string;
  attribution?: OAuthLoginAttribution;
}

/** OAuth 登录归因参数：来自官网中转页或投放链接 */
export interface OAuthLoginAttribution {
  channel_id?: string;
  utm_source?: string;
  utm_campaign?: string;
}

/** 归一化 token 结构 */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  zcodeJwtToken?: string;
  linkedBigModel?: OAuthLinkedBigModel;
}

export interface UserInfo {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
}

export type OAuthCachedSessionRestoreResult =
  | { status: "authenticated"; userInfo: UserInfo }
  | { status: "signed-out" }
  | { status: "reauthentication-required"; reason: "jwt-expired" };

/** 账号能力安全投影；不得在此加入访问 token 或原始后端响应。 */
export interface OAuthAccountAvailability {
  loginProvider: OAuthProviderId | null;
  userId: string | null;
  sessionRevision: string | null;
  families: ProviderFamilyDomain[];
}

/** 受信任嵌入网页的主会话交接。关联业务凭据仍留在 Host，不包含中国区上游 token。 */
export interface OAuthWebsiteSession {
  loginProvider: OAuthProviderId;
  userId: string;
  sessionRevision: string | null;
  zcodeJwtToken: string | null;
  legacyOAuthToken: string | null;
}

/** OAuth owner 已完成会话凭据变更；不携带用户资料或 token。 */
export type OAuthSessionState = "signed-in" | "signed-out";

/** Host 在检测到 ZCode JWT 失效后通知 Renderer 展示确认并重启。 */
export const ZCODE_JWT_INVALID_BROADCAST_CHANNEL = "auth:zcode-jwt-invalid";

export type JwtExpirationResult =
  | { kind: "valid"; expiresAt: number }
  | { kind: "expired"; expiresAt: number }
  | { kind: "unknown" };

/**
 * 只解析 JWT 的 exp 来判断本地生命周期，不承担签名校验。
 * 无法证明已过期的历史或非标准 token 保持兼容，最终有效性仍由服务端决定。
 */
export function resolveJwtExpiration(
  token: string,
  now = Date.now(),
  clockSkewMs = 30_000,
): JwtExpirationResult {
  try {
    const payloadSegment = token.split(".")[1];
    if (!payloadSegment) {
      return { kind: "unknown" };
    }

    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = globalThis.atob(padded);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= 0) {
      return { kind: "unknown" };
    }

    const expiresAt = payload.exp * 1_000;
    return now + Math.max(0, clockSkewMs) >= expiresAt
      ? { kind: "expired", expiresAt }
      : { kind: "valid", expiresAt };
  } catch {
    return { kind: "unknown" };
  }
}

/** 归一化用户信息 */
export interface OAuthUserProfile {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  rawProfile?: unknown;
}

/** 登出范围 */
export type OAuthLogoutScope = "active" | "all";
