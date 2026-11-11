import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  ZAI_CN_PROVIDER_ID,
  type ApiClient,
} from "@zcode/shared";
import type { OAuthRuntimeConfig } from "../runtimeConfig.js";
import { BigModelProviderAdapter } from "./bigmodelProviderAdapter.js";
import type { OAuthProviderAdapter } from "./providerAdapter.js";
import { ZaiProviderAdapter } from "./zaiProviderAdapter.js";

/** 根据运行时配置创建可用 provider adapter */
export function createOAuthProviderAdapters(
  config: OAuthRuntimeConfig,
  options: { apiClient?: ApiClient } = {},
): OAuthProviderAdapter[] {
  const adapters: OAuthProviderAdapter[] = [];
  const apiClient = options.apiClient;
  if (!apiClient) {
    throw new Error(
      "ApiClient 注入缺失：OAuth provider adapters 必须通过 Providers 传入 apiClient",
    );
  }

  for (const providerConfig of config.providers) {
    switch (providerConfig.id) {
      case BIGMODEL_PROVIDER_ID:
        adapters.push(new BigModelProviderAdapter(providerConfig, apiClient));
        break;
      case ZAI_PROVIDER_ID:
      case ZAI_CN_PROVIDER_ID:
        adapters.push(new ZaiProviderAdapter(providerConfig, apiClient));
        break;
      default:
        // 未知 provider 直接忽略，避免单个配置错误拖垮全部登录能力。
        break;
    }
  }

  return adapters;
}

export type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";

export { readLinkedBigModel } from "./zaiProviderAdapter.js";
