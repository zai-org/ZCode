import {
  ZAI_PROVIDER_ID,
  ZAI_CN_PROVIDER_ID,
  buildRuntimeZaiBusinessUrl,
  buildRuntimeZaiOAuthUrl,
  resolveZaiOAuthClientId,
} from "@zcode/shared";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import {
  buildDesktopOAuthRedirectUriFromEnv,
  buildZCodeApiUrlFromEnv,
  readBoolean,
  readEnv,
} from "./configUtils.js";

export const ZAI_OAUTH_PROVIDER_CONFIG: Omit<OAuthProviderRuntimeConfig, "appSecret"> = {
  id: ZAI_PROVIDER_ID,
  displayName: "Z.ai",
  enabled: true,
  order: 1,
  // ZAI 当前 OAuth 授权入口使用 /api/oauth 前缀，继续走 /auth/oauth 会打开旧入口。
  authorizeUrl: "https://chat.z.ai/api/oauth/authorize",
  tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
  userinfoUrl: "https://chat.z.ai/api/oauth/userinfo",
  businessLoginUrl: "https://api.z.ai/api/auth/z/login",
  // 生产 client_id 不是 secret，但保留 fallback 可以避免未配置 env 的旧构建直接无法登录。
  appId: "client_P8X5CMWmlaRO9gyO-KSqtg",
  redirectUri: "zcode://oauth/callback",
};

export function createZaiProviderRuntimeConfig(env: NodeJS.ProcessEnv): OAuthProviderRuntimeConfig {
  return {
    ...ZAI_OAUTH_PROVIDER_CONFIG,
    enabled: readBoolean(env, "ZAI_OAUTH_ENABLED", ZAI_OAUTH_PROVIDER_CONFIG.enabled),
    authorizeUrl:
      readEnv(env, "ZAI_OAUTH_AUTHORIZE_URL") ??
      buildRuntimeZaiOAuthUrl(env, "/api/oauth/authorize"),
    tokenUrl:
      readEnv(env, "ZAI_OAUTH_TOKEN_URL") ?? buildZCodeApiUrlFromEnv(env, "/api/v1/oauth/token"),
    userinfoUrl: resolveZaiUserinfoUrl(env),
    businessLoginUrl:
      readEnv(env, "ZAI_BUSINESS_LOGIN_URL") ??
      buildRuntimeZaiBusinessUrl(env, "/api/auth/z/login"),
    appId:
      // client_id 是公开 OAuth app 标识，按环境覆盖，避免测试/生产 OAuth 应用混用。
      resolveZaiOAuthClientId(env),
    redirectUri: buildDesktopOAuthRedirectUriFromEnv(env),
  };
}

export function resolveZaiUserinfoUrl(env: NodeJS.ProcessEnv): string {
  return (
    readEnv(env, "ZAI_OAUTH_USERINFO_URL") ?? buildRuntimeZaiOAuthUrl(env, "/api/oauth/userinfo")
  );
}

/** 中国区授权信息由 ZCode init 提供，不猜测中国区业务端点或使用全球区换证。 */
export function createZaiCnProviderRuntimeConfig(
  env: NodeJS.ProcessEnv,
): OAuthProviderRuntimeConfig {
  return {
    ...createZaiProviderRuntimeConfig(env),
    id: ZAI_CN_PROVIDER_ID,
    displayName: "Z.ai (CN)",
    order: 2,
    userinfoUrl: buildZCodeApiUrlFromEnv(env, "/api/v1/oauth/profile"),
  };
}
