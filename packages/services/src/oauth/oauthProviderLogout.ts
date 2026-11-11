import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  ZAI_PROVIDER_ID,
  type OAuthProviderId,
} from "@zcode/shared";
import { accountProviderCredentialKey } from "../model-provider/accountProviderCredentialKey.js";
import type { AccountProviderCredentialStore } from "../model-provider/accountProviderCredentialStore.js";

interface OAuthProviderLogoutDependencies {
  readonly accountProviderCredentialStore: Pick<AccountProviderCredentialStore, "deleteApiKey">;
  readonly refreshAccountProviders?: (reason: string) => Promise<unknown>;
}

export function createOAuthProviderLogoutHandler(
  dependencies: OAuthProviderLogoutDependencies,
): (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void> {
  return async (provider, accountIdentity) => {
    const providerIds = resolveProviderIds(provider);
    if (providerIds && accountIdentity?.trim()) {
      await dependencies.accountProviderCredentialStore.deleteApiKey(
        accountProviderCredentialKey({
          providerId: providerIds.codingPlan,
          planKind: "individual-coding-plan",
          accountIdentity,
        }),
      );
    }
    // 新CN渠道没有旧Key清理映射，但退出同样必须使账号投影失效。
    // 旧代码提前return会留下已退出账号的套餐可用性；请求期鉴权与UI投影须同时撤销。
    await dependencies.refreshAccountProviders?.(`oauth-logout:${provider}`);
  };
}

function resolveProviderIds(provider: OAuthProviderId): {
  readonly codingPlan: string;
} | null {
  if (provider === ZAI_PROVIDER_ID) {
    return {
      codingPlan: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    };
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    return {
      codingPlan: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    };
  }
  return null;
}
