import {
  BIGMODEL_PROVIDER_ID,
  type OAuthProviderId,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import type { OAuthProviderAdapter } from "./providers/index.js";

const BIGMODEL_PROFILE_SCHEMA_VERSION = 2;
const BIGMODEL_PROFILE_MIGRATION_RETRY_DELAY_MS = 60 * 60 * 1000;

interface RefreshLegacyBigModelCachedProfileOptions {
  adapter: OAuthProviderAdapter;
  cachedProfile: OAuthUserProfile;
  loadTokenSet: () => Promise<OAuthTokenSet | null>;
  saveProfile: (profile: OAuthUserProfile) => Promise<void>;
  now: () => number;
  runWithAdapterError: <T>(run: () => Promise<T>) => Promise<T>;
}

function getCachedProfileSchemaVersion(profile: OAuthUserProfile): number | null {
  const rawProfile = profile.rawProfile;
  if (!rawProfile || typeof rawProfile !== "object") {
    return null;
  }

  const version = (rawProfile as { zcodeProfileSchemaVersion?: unknown }).zcodeProfileSchemaVersion;
  return typeof version === "number" ? version : null;
}

function getCachedProfileMigrationRetryAfter(profile: OAuthUserProfile): number | null {
  const rawProfile = profile.rawProfile;
  if (!rawProfile || typeof rawProfile !== "object") {
    return null;
  }

  const retryAfter = (rawProfile as { zcodeProfileMigrationRetryAfter?: unknown })
    .zcodeProfileMigrationRetryAfter;
  return typeof retryAfter === "number" ? retryAfter : null;
}

function isBigModelUserInfoFallback(profile: OAuthUserProfile): boolean {
  return profile.id === "unknown" && profile.username === "user" && profile.displayName === "User";
}

/** 上游业务userinfo只拥有展示字段；customerNumber或sub不能成为ZCode资产主体。 */
export function mergeOAuthDisplayProfile(
  cachedProfile: OAuthUserProfile,
  businessProfile: OAuthUserProfile,
): OAuthUserProfile {
  if (isBigModelUserInfoFallback(businessProfile)) return cachedProfile;
  return {
    ...cachedProfile,
    username: businessProfile.username,
    displayName: businessProfile.displayName,
    ...(businessProfile.avatarUrl ? { avatarUrl: businessProfile.avatarUrl } : {}),
  };
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function shouldCompleteMigrationAfterError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status === 401 || status === 403;
}

export function withProviderProfileSchema(
  provider: OAuthProviderId,
  profile: OAuthUserProfile,
): OAuthUserProfile {
  if (provider !== BIGMODEL_PROVIDER_ID) {
    return profile;
  }

  const rawProfile =
    profile.rawProfile && typeof profile.rawProfile === "object" ? profile.rawProfile : {};
  const nextRawProfile = { ...(rawProfile as Record<string, unknown>) };
  delete nextRawProfile.zcodeProfileMigrationRetryAfter;

  return {
    ...profile,
    rawProfile: {
      ...nextRawProfile,
      zcodeProfileSchemaVersion: BIGMODEL_PROFILE_SCHEMA_VERSION,
    },
  };
}

function withBigModelProfileMigrationRetryAfter(
  profile: OAuthUserProfile,
  now: number,
): OAuthUserProfile {
  const rawProfile =
    profile.rawProfile && typeof profile.rawProfile === "object" ? profile.rawProfile : {};

  return {
    ...profile,
    rawProfile: {
      ...(rawProfile as Record<string, unknown>),
      zcodeProfileMigrationRetryAfter: now + BIGMODEL_PROFILE_MIGRATION_RETRY_DELAY_MS,
    },
  };
}

export async function refreshLegacyBigModelCachedProfile(
  options: RefreshLegacyBigModelCachedProfileOptions,
): Promise<OAuthUserProfile> {
  const { adapter, cachedProfile, loadTokenSet, now, runWithAdapterError, saveProfile } = options;
  if (
    (getCachedProfileSchemaVersion(cachedProfile) ?? 0) >= BIGMODEL_PROFILE_SCHEMA_VERSION ||
    (getCachedProfileMigrationRetryAfter(cachedProfile) ?? 0) > now() ||
    !adapter.fetchUserInfo
  ) {
    return cachedProfile;
  }

  const tokenSet = await loadTokenSet();
  if (!tokenSet) {
    await saveProfile(withProviderProfileSchema(BIGMODEL_PROVIDER_ID, cachedProfile));
    return cachedProfile;
  }

  try {
    // BigModel 旧缓存只保存 nickName，升级后 restoreCachedSession 会绕过
    // fetchUserInfo。这里对无版本缓存做 best-effort 刷新，失败仍保留本地登录态。
    const refreshedProfile = await runWithAdapterError(() =>
      adapter.fetchUserInfo!(tokenSet, {
        providerId: BIGMODEL_PROVIDER_ID,
        state: "",
        redirectUri: adapter.redirectUri,
        now,
      }),
    );
    if (isBigModelUserInfoFallback(refreshedProfile)) {
      // 旧版本可能把 zcode JWT 写进 BigModel access token。
      // adapter 会返回 unknown/User 哨兵值表示无法查 BigModel 用户信息；
      // 迁移不能把已有可信缓存覆盖成这个哨兵值，否则版本标记会永久固化错误展示名。
      await saveProfile(withProviderProfileSchema(BIGMODEL_PROVIDER_ID, cachedProfile));
      return cachedProfile;
    }
    // BigModel customerNumber属于业务账号，不能覆盖已保存的ZCode主体。
    // 旧迁移把整份业务profile回写，两个ID不同时会让设备、关联和资产被当成另一账号。
    const migratedProfile = withProviderProfileSchema(
      BIGMODEL_PROVIDER_ID,
      mergeOAuthDisplayProfile(cachedProfile, refreshedProfile),
    );
    await saveProfile(migratedProfile);
    return migratedProfile;
  } catch (error) {
    if (shouldCompleteMigrationAfterError(error)) {
      await saveProfile(withProviderProfileSchema(BIGMODEL_PROVIDER_ID, cachedProfile));
      return cachedProfile;
    }

    // 离线、超时或 5xx 只是暂时性失败，不能永久写入 schema version 2。
    // 写入 retry-after 可避免每次启动都打 userinfo，同时保留后续成功迁移机会。
    await saveProfile(withBigModelProfileMigrationRetryAfter(cachedProfile, now()));
    return cachedProfile;
  }
}
