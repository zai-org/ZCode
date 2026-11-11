import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import type { OAuthTokenSet, UserInfo } from "@zcode/shared";
import type { WebOAuthProviderId } from "#src/auth/contract.js";

export interface WebZaiOAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  /** BigModel 授权入口；参数名与 ZAI 不同（redirect/appId vs redirect_uri/client_id）。 */
  bigmodelAuthorizeUrl: string;
  bigmodelAppId: string;
}

interface WebZaiOAuthCallbackParams {
  code?: string;
  error?: string;
  state: string;
}

interface WebZaiTokenExchangeResult {
  tokenSet: OAuthTokenSet;
  userInfo: UserInfo;
  rawUserInfo: unknown;
}

interface WebZaiBackendTokenPayload {
  code?: number;
  msg?: string;
  data?: {
    token?: string;
    zai?: {
      access_token?: string;
    } | null;
    bigmodel?: {
      access_token?: string;
    } | null;
    expires_in?: number;
    user?: unknown;
  } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeBackendAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^data:image\/[^;]+;base64,/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length >= 16) {
    return `data:image/png;base64,${trimmed}`;
  }

  return trimmed;
}

export function toUserInfo(user: unknown): UserInfo | null {
  if (!isRecord(user)) {
    return null;
  }

  if (
    typeof user.id === "string" &&
    typeof user.username === "string" &&
    typeof user.displayName === "string"
  ) {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      ...(typeof user.avatarUrl === "string" ? { avatarUrl: user.avatarUrl } : {}),
    };
  }

  const id = typeof user.user_id === "string" ? user.user_id : "unknown";
  const name = typeof user.name === "string" ? user.name.trim() : "";
  const email = typeof user.email === "string" ? user.email.trim() : "";
  const username = name || email || id;
  if (!name && !email && id === "unknown") {
    return null;
  }

  return {
    id,
    username,
    displayName: username,
    ...(normalizeBackendAvatarUrl(user.avatar)
      ? { avatarUrl: normalizeBackendAvatarUrl(user.avatar) }
      : {}),
  };
}

function resolveExpiresAt(expiresIn: number | undefined, now: () => number): number | undefined {
  if (!expiresIn || !Number.isFinite(expiresIn)) {
    return undefined;
  }

  return now() + expiresIn * 1000;
}

function normalizeTokenResponse(
  payload: WebZaiBackendTokenPayload,
  now: () => number,
  provider: WebOAuthProviderId,
): WebZaiTokenExchangeResult {
  if (payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "OAuth token exchange failed");
  }

  const zcodeJwtToken = payload.data?.token?.trim();
  if (!zcodeJwtToken) {
    throw new Error("Token exchange response missing data.token");
  }

  // 服务端按 provider 把 access_token 放在不同子对象里（GrantJWT 的 resp.Zai / resp.Bigmodel）。
  const accessToken = (
    provider === BIGMODEL_PROVIDER_ID
      ? payload.data?.bigmodel?.access_token
      : payload.data?.zai?.access_token
  )?.trim();
  if (!accessToken) {
    throw new Error(`Token exchange response missing data.${provider}.access_token`);
  }

  const rawUserInfo = payload.data?.user;
  const canonicalId =
    isRecord(rawUserInfo) && typeof rawUserInfo.user_id === "string"
      ? rawUserInfo.user_id.trim()
      : "";
  const userInfo =
    canonicalId && isRecord(rawUserInfo)
      ? toUserInfo({
          user_id: canonicalId,
          name: rawUserInfo.name,
          email: rawUserInfo.email,
          avatar: rawUserInfo.avatar,
        })
      : null;
  if (!userInfo) throw new Error("Token exchange response missing canonical user info");

  const expiresAt = resolveExpiresAt(payload.data?.expires_in, now);

  return {
    tokenSet: {
      accessToken,
      zcodeJwtToken,
      ...(expiresAt ? { expiresAt } : {}),
    },
    userInfo,
    rawUserInfo,
  };
}

export class ZaiWebOAuthProvider {
  constructor(
    private readonly config: WebZaiOAuthProviderConfig,
    private readonly now: () => number = Date.now,
  ) {}

  buildAuthorizeUrl(params: {
    state: string;
    redirectUri?: string;
    provider?: WebOAuthProviderId;
  }): string {
    const redirectUri = params.redirectUri ?? this.config.redirectUri;
    // 两家的授权参数名完全不同，没有共通形状可抽；直接分支比造一层映射配置更好读。
    if (params.provider === BIGMODEL_PROVIDER_ID) {
      const query = new URLSearchParams({
        redirect: redirectUri,
        appId: this.config.bigmodelAppId,
        state: params.state,
      });
      return `${this.config.bigmodelAuthorizeUrl}?${query.toString()}`;
    }

    const query = new URLSearchParams({
      redirect_uri: redirectUri,
      response_type: "code",
      client_id: this.config.clientId,
      state: params.state,
    });

    return `${this.config.authorizeUrl}?${query.toString()}`;
  }

  parseCallbackParams(url: string): WebZaiOAuthCallbackParams {
    const parsed = new URL(url);
    const state = parsed.searchParams.get("state")?.trim();
    if (!state) {
      throw new Error("OAuth callback missing state");
    }

    return {
      state,
      ...(parsed.searchParams.get("code") ? { code: parsed.searchParams.get("code")! } : {}),
      ...(parsed.searchParams.get("authCode")
        ? { code: parsed.searchParams.get("authCode")! }
        : {}),
      ...(parsed.searchParams.get("error") ? { error: parsed.searchParams.get("error")! } : {}),
    };
  }

  async exchangeToken(params: {
    code: string;
    state: string;
    redirectUri?: string;
    provider?: WebOAuthProviderId;
  }): Promise<WebZaiTokenExchangeResult> {
    const provider = params.provider ?? ZAI_PROVIDER_ID;
    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // 服务端 provider 缺省即 zai，这里仍显式发送：默认值靠约定不如写清楚。
        provider,
        code: params.code,
        redirect_uri: params.redirectUri ?? this.config.redirectUri,
        state: params.state,
      }),
    });

    if (!response.ok) {
      throw new Error(`OAuth token exchange failed with HTTP ${response.status}`);
    }

    return normalizeTokenResponse(
      (await response.json()) as WebZaiBackendTokenPayload,
      this.now,
      provider,
    );
  }
}
