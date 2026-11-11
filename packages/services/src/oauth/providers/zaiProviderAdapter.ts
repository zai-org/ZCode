import { Buffer } from "node:buffer";
import {
  ApiError,
  type ApiClient,
  ZAI_CN_PROVIDER_ID,
  type OAuthProviderId,
  type OAuthLinkedBigModel,
  type OAuthCallbackParams,
  type OAuthProviderMeta,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { readApiJson } from "../../providers/api/apiJson.js";
import { ZaiBusinessTokenResolver } from "../../providers/zaiBusinessTokenResolver.js";
import { parseOAuthLoginAttribution } from "../callbackAttribution.js";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";

interface ZaiBackendTokenPayload {
  code?: number;
  msg?: string;
  data?: {
    token?: string;
    zai?: {
      access_token?: string;
    } | null;
    bigmodel?: { customer_id?: string; access_token?: string } | null;
    expires_in?: number;
    user?: ZaiBackendUserPayload;
  } | null;
}

interface ZaiBackendUserPayload {
  user_id?: string;
  email?: string;
  avatar?: string;
  name?: string;
  created_at?: string;
}

interface ZaiUserInfoPayload {
  data?: {
    sub?: string;
    id?: string;
    name?: string;
    preferred_username?: string;
    email?: string;
    picture?: string;
  };
  sub?: string;
  id?: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  picture?: string;
}

/** OAuth 启动恢复允许的最长等待时间（1 分钟） */
const OAUTH_USERINFO_TIMEOUT_MS = 60_000;
const ZAI_BUSINESS_TOKEN_TIMEOUT_MS = 10_000;
const log = createServiceLogger("zaiOAuth");

function normalizeExpiresIn(raw: number | undefined, now: () => number): number | undefined {
  if (!raw || !Number.isFinite(raw)) {
    return undefined;
  }

  return now() + raw * 1000;
}

function inferBase64ImageMimeType(decoded: Buffer): string {
  if (
    decoded.length >= 8 &&
    decoded[0] === 0x89 &&
    decoded[1] === 0x50 &&
    decoded[2] === 0x4e &&
    decoded[3] === 0x47
  ) {
    return "image/png";
  }

  if (decoded.length >= 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff) {
    return "image/jpeg";
  }

  if (decoded.length >= 6 && decoded.toString("ascii", 0, 3) === "GIF") {
    return "image/gif";
  }

  if (
    decoded.length >= 12 &&
    decoded.toString("ascii", 0, 4) === "RIFF" &&
    decoded.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return "image/png";
}

function toBase64ImageDataUrl(raw: string): string | null {
  const normalized = raw.replace(/\s/g, "");
  if (normalized.length < 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return null;
  }

  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length === 0) {
    return null;
  }

  const encoded = decoded.toString("base64").replace(/=+$/, "");
  if (encoded !== normalized.replace(/=+$/, "")) {
    return null;
  }

  return `data:${inferBase64ImageMimeType(decoded)};base64,${normalized}`;
}

function normalizeBackendAvatarUrl(avatar: string | undefined): string | undefined {
  const trimmed = avatar?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^data:image\/[^;]+;base64,/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const dataUrl = toBase64ImageDataUrl(trimmed);
  if (dataUrl) {
    return dataUrl;
  }

  // ZAI 后端现在稳定返回可展示 URL 或 base64，客户端继续拼 chat.z.ai 前缀会改坏服务端语义。
  // 这里只保留原值，避免把后端返回的 avatar 二次加工成错误地址。
  return trimmed;
}

function toBackendUserProfile(user: ZaiBackendUserPayload | undefined): OAuthUserProfile {
  if (!user) {
    return {
      id: "unknown",
      username: "user",
      displayName: "User",
    };
  }

  const id = user.user_id ?? "unknown";
  // ZAI 后端 token body 里的 user.name 才是用户可见昵称，之前只读 email，
  // 导致登录成功后侧栏和日志都显示 phone.local 邮箱；avatar 只做必要的 base64 展示格式归一化。
  const username = user.name?.trim() || user.email || id;
  const avatarUrl = normalizeBackendAvatarUrl(user.avatar);

  return {
    id,
    username,
    displayName: username,
    ...(avatarUrl ? { avatarUrl } : {}),
    rawProfile: user,
  };
}

function hasMeaningfulBackendUser(
  user: ZaiBackendUserPayload | undefined,
): user is ZaiBackendUserPayload {
  if (!user) {
    return false;
  }

  return Boolean(
    user.user_id?.trim() || user.email?.trim() || user.name?.trim() || user.avatar?.trim(),
  );
}

function maskOAuthCode(code: string): string {
  if (code.length <= 8) {
    return "*".repeat(code.length);
  }

  return `${code.slice(0, 4)}...${code.slice(-4)}`;
}

function sanitizeTokenPayloadForLog(tokenPayload: ZaiBackendTokenPayload): unknown {
  // 后端新增 bigmodel 或其他关联字段时，对 data 展开再逐项打码会漏掉新凭据。
  // 仅输出固定的结构摘要，不让上游新增字段或错误文案直接进入日志。
  const data = tokenPayload.data;
  return {
    code: typeof tokenPayload.code === "number" ? tokenPayload.code : undefined,
    hasData: Boolean(data),
    hasZcodeToken: typeof data?.token === "string" && data.token.length > 0,
    hasZaiToken: typeof data?.zai?.access_token === "string" && data.zai.access_token.length > 0,
    hasUser: Boolean(data?.user),
  };
}

function logTokenResponseError(error: unknown): void {
  if (!(error instanceof ApiError)) {
    return;
  }

  // 后端 4xx/5xx 排查需要响应里的 request id；直接记录完整 headers 会把 cookie 等敏感值落盘。
  // readApiJson 只透出安全的链路追踪头，这里把它们和状态码一起打印出来，方便后端按 x-request-id 定位。
  log.warn(undefined, "token response error", {
    method: error.method,
    url: error.url,
    status: error.status,
    responseHeaders: error.responseHeaders ?? {},
  });
}

/** ZAI OAuth 协议适配器 */
export class ZaiProviderAdapter implements OAuthProviderAdapter {
  readonly providerId: OAuthProviderId;
  readonly meta: OAuthProviderMeta;
  readonly redirectUri: string;
  readonly apiClient: ApiClient;
  private readonly businessTokenResolver: ZaiBusinessTokenResolver;
  private lastBackendUserProfile: {
    state: string;
    profile: OAuthUserProfile;
  } | null = null;

  constructor(
    private config: OAuthProviderRuntimeConfig,
    apiClient: ApiClient,
  ) {
    this.providerId = config.id;
    this.meta = {
      id: config.id,
      displayName: config.displayName,
      enabled: config.enabled,
      order: config.order,
    };
    this.redirectUri = config.redirectUri;
    this.apiClient = apiClient;
    this.businessTokenResolver = new ZaiBusinessTokenResolver({
      apiClient,
      // 测试 OAuth app 返回的 ZAI access_token 需要打到测试业务域换业务 token；
      // 如果继续硬编码生产 api.z.ai，本地测试登录会在 OAuth token 成功后失败。
      loginUrl: config.businessLoginUrl ?? "https://api.z.ai/api/auth/z/login",
      timeoutMs: ZAI_BUSINESS_TOKEN_TIMEOUT_MS,
    });
  }

  parseCallbackParams(url: string): OAuthCallbackParams {
    const parsed = new URL(url);
    const code = parsed.searchParams.get("code") ?? parsed.searchParams.get("authCode");
    const state = parsed.searchParams.get("state");

    if (!code || !state) {
      throw new Error("OAuth 回调缺少 code/authCode 或 state 参数");
    }

    const attribution = parseOAuthLoginAttribution(parsed.searchParams);

    return { code, state, ...(attribution ? { attribution } : {}) };
  }

  buildAuthorizeUrl(context: OAuthProviderContext): string {
    if (this.providerId === ZAI_CN_PROVIDER_ID)
      throw new Error("中国区授权必须使用服务端 init 返回的 URL");
    const query = new URLSearchParams({
      redirect_uri: context.redirectUri,
      response_type: "code",
      client_id: this.config.appId,
      state: context.state,
    });

    return `${this.config.authorizeUrl}?${query.toString()}`;
  }

  async normalizePolledTokenSet(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet> {
    // CLI flow 的 ready.access_token 仍是 Z.AI OAuth token，而 Desktop
    // oauth:zai:access_token 的既有契约是 /api/auth/z/login 返回的业务 token。
    // polling 与 deep link 必须在同一 adapter 边界完成转换，避免两种登录方式落盘语义分裂。
    return {
      ...tokenSet,
      accessToken:
        this.providerId === ZAI_CN_PROVIDER_ID
          ? tokenSet.accessToken
          : await this.businessTokenResolver.resolve(tokenSet.accessToken),
    };
  }

  async exchangeToken(
    params: OAuthCallbackParams,
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    // 后端 OAuth token 路由排查时，原日志只记录了 404 结果，看不到客户端实际请求形态。
    // 这里记录 method/url/headers/body 结构，同时脱敏一次性 code，避免敏感授权码落盘。
    log.info(undefined, "token request", {
      method: "POST",
      url: this.config.tokenUrl,
      headers: { "Content-Type": "application/json" },
      body: {
        provider: this.providerId,
        code: maskOAuthCode(params.code),
        codeLength: params.code.length,
        redirect_uri: context.redirectUri,
        state: context.state,
      },
    });

    let tokenPayload: ZaiBackendTokenPayload;
    try {
      tokenPayload = await readApiJson<ZaiBackendTokenPayload>(
        this.apiClient,
        this.config.tokenUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // zcode OAuth token 后端现在同时服务 Z.ai 和 BigModel。
          // 显式传 provider 枚举值，避免只依赖 redirect_uri 推断登录域导致兑换错路由。
          body: JSON.stringify({
            provider: this.providerId,
            code: params.code,
            redirect_uri: context.redirectUri,
            state: context.state,
          }),
        },
      );
    } catch (error) {
      logTokenResponseError(error);
      throw error;
    }

    log.info(undefined, "token final response summary", sanitizeTokenPayloadForLog(tokenPayload));

    if (tokenPayload.code !== 0) {
      throw new Error(tokenPayload.msg?.trim() || "ZAI 后端 token 交换失败");
    }

    const zcodeJwtToken = tokenPayload.data?.token;
    if (!zcodeJwtToken) {
      throw new Error("Token 交换失败：响应缺少 data.token");
    }

    const accessToken = tokenPayload.data?.zai?.access_token;
    if (!accessToken) {
      throw new Error("Token 交换失败：响应缺少 data.zai.access_token");
    }
    // Z.AI 业务接口只认 /api/auth/z/login 返回的平台 JWT。
    // 这里在登录阶段完成转换，让 oauth:zai:access_token 持久化的就是业务 token，后续不再做兜底二次交换。
    const businessAccessToken =
      this.providerId === ZAI_CN_PROVIDER_ID
        ? accessToken
        : await this.businessTokenResolver.resolve(accessToken);

    const backendUser = tokenPayload.data?.user ?? undefined;
    if (!backendUser?.user_id?.trim())
      throw new Error("Token 交换失败：响应缺少 data.user.user_id");
    if (hasMeaningfulBackendUser(backendUser)) {
      this.lastBackendUserProfile = {
        state: context.state,
        profile: toBackendUserProfile(backendUser),
      };
    } else {
      // 后端偶发不返回 data.user（或只返回空对象）时，之前会缓存 unknown/User 并短路后续 userinfo。
      // 这样登录后 UI 会长期显示兜底文案。缺失有效 user 时不缓存，允许 fetchUserInfo 走远端补偿。
      this.lastBackendUserProfile = null;
    }
    const expiresAt = normalizeExpiresIn(tokenPayload.data?.expires_in, context.now);

    return {
      accessToken: businessAccessToken,
      zcodeJwtToken,
      linkedBigModel: readLinkedBigModel(tokenPayload.data?.bigmodel),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  async fetchUserInfo(
    tokenSet: OAuthTokenSet,
    _context: OAuthProviderContext,
  ): Promise<OAuthUserProfile> {
    if (this.lastBackendUserProfile?.state === _context.state) {
      const profile = this.lastBackendUserProfile.profile;
      this.lastBackendUserProfile = null;
      return profile;
    }

    if (this.providerId === ZAI_CN_PROVIDER_ID) {
      if (!tokenSet.zcodeJwtToken) throw new Error("中国区 profile 缺少 ZCode JWT");
      const payload = await readApiJson<ZaiBackendTokenPayload>(
        this.apiClient,
        this.config.userinfoUrl,
        {
          headers: { Authorization: `Bearer ${tokenSet.zcodeJwtToken}` },
          authFailurePolicy: "caller-handled",
          timeoutMs: OAUTH_USERINFO_TIMEOUT_MS,
        },
      );
      if (payload.code !== 0 || !payload.data?.user?.user_id?.trim())
        throw new Error("中国区 profile 响应无效");
      return toBackendUserProfile(payload.data.user);
    }

    const userinfoPayload = await readApiJson<ZaiUserInfoPayload>(
      this.apiClient,
      this.config.userinfoUrl,
      {
        method: "GET",
        // 启动恢复登录态会阻塞 UI 的“恢复中”落定。
        // 如果这里没有超时兜底，弱网下请求可能长期挂起，界面会一直停在 loading。
        // 这里统一限制为 1 分钟，超时后按失败路径收敛状态，避免无限等待。
        timeoutMs: OAUTH_USERINFO_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${tokenSet.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
    const user = userinfoPayload.data ?? userinfoPayload;

    const id = user.sub ?? user.id ?? "unknown";
    const username = user.name ?? user.preferred_username ?? user.email ?? id;

    return {
      id,
      username,
      displayName: username,
      avatarUrl: user.picture,
    };
  }

  normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(`ZAI OAuth 异常: ${String(error)}`);
  }
}

/** 只接受服务端明确返回的完整关联；缺失块不继承上一账号的数据。 */
export function readLinkedBigModel(value: unknown): OAuthLinkedBigModel | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new Error("BigModel 关联响应无效");
  const raw = value as Record<string, unknown>;
  const customerId = typeof raw.customer_id === "string" ? raw.customer_id.trim() : "";
  const accessToken = typeof raw.access_token === "string" ? raw.access_token.trim() : "";
  if (!customerId || !accessToken) throw new Error("BigModel 关联响应缺少身份或凭据");
  return { customerId, accessToken };
}
