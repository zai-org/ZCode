/* eslint-disable max-lines -- OAuth 凭据仓储集中维护 ZAI/BigModel 登录镜像 key 边界，拆分会让鉴权事实源更难追踪。 */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type {
  OAuthLoginAttribution,
  OAuthAccountAvailability,
  OAuthWebsiteSession,
  OAuthProviderId,
  OAuthTokenSet,
  OAuthUserProfile,
  ProviderFamilyDomain,
} from "@zcode/shared";
import {
  BIGMODEL_PROVIDER_ID,
  isCredentialDecryptError,
  OAUTH_SESSION_REVISION_KEY,
  ZAI_PROVIDER_ID,
  ZAI_CN_PROVIDER_ID,
  OAUTH_LINKED_BIGMODEL_KEY,
  isZaiOAuthProvider,
  isBuiltinOAuthProvider,
  resolveStartPlanFamilyFromOAuthProvider,
} from "@zcode/shared";
import type { ICredentialService } from "../../credential/credential.js";
import type { LocalCredentialService } from "#src/credential/credentialService.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";

const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const LOGIN_ATTRIBUTION_KEY = "oauth:login_attribution";
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const SESSION_REVISION_KEY = OAUTH_SESSION_REVISION_KEY;
const KNOWN_OAUTH_PROVIDER_IDS = [
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  ZAI_CN_PROVIDER_ID,
] as const;
const log = createServiceLogger("oauthCredentialRepo");

interface OAuthCredentialRepoOptions {
  providerIds?: readonly OAuthProviderId[];
  onCorruptOAuthSessionCleared?: (providerIds: readonly OAuthProviderId[]) => Promise<void>;
}

function accessTokenKey(provider: OAuthProviderId): string {
  return `oauth:${provider}:access_token`;
}

function refreshTokenKey(provider: OAuthProviderId): string {
  return `oauth:${provider}:refresh_token`;
}

function userInfoKey(provider: OAuthProviderId): string {
  return `oauth:${provider}:user_info`;
}

function collectKnownOAuthProviderIds(
  providerIds: readonly OAuthProviderId[] = [],
): OAuthProviderId[] {
  const uniqueProviderIds = new Set<OAuthProviderId>(KNOWN_OAUTH_PROVIDER_IDS);
  for (const providerId of providerIds) {
    uniqueProviderIds.add(providerId);
  }
  return [...uniqueProviderIds];
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

function normalizeStoredZaiAvatarUrl(avatar: string | undefined): string | undefined {
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

  return trimmed;
}

function toOAuthUserProfileFromRawZaiUser(raw: Record<string, unknown>): OAuthUserProfile | null {
  const id = typeof raw.user_id === "string" ? raw.user_id : "unknown";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const email = typeof raw.email === "string" ? raw.email : "";
  const username = name || email || id;
  const avatarUrl = normalizeStoredZaiAvatarUrl(
    typeof raw.avatar === "string" ? raw.avatar : undefined,
  );

  if (!name && !email && id === "unknown") {
    return null;
  }

  return {
    id,
    username,
    displayName: username,
    ...(avatarUrl ? { avatarUrl } : {}),
    rawProfile: raw,
  };
}

/** Host 私有的请求期套餐材料，不作为 App 登录或 Renderer 返回值。 */
/** Host 内部身份快照，不含套餐选择；仅主业务 JWT 可用于 ZCode 请求。 */
export interface OAuthIdentityMaterial {
  loginProvider: OAuthProviderId;
  zcodeUserId: string;
  sessionRevision: string | null;
  zcodeJwtToken: string;
}

export interface OAuthAccountMaterial {
  family: ProviderFamilyDomain;
  loginProvider: OAuthProviderId;
  zcodeUserId: string;
  sessionRevision: string | null;
  accountIdentity: string;
  accessToken: string;
  zcodeJwtToken: string | null;
}

/** Start Plan 请求期材料：只含主体与共享 ZCode JWT，不携带任何套餐业务 token。 */
export type OAuthStartPlanMaterial = Omit<OAuthAccountMaterial, "accessToken">;

export function isSameOAuthAccountMaterial(
  left: OAuthStartPlanMaterial | null,
  right: OAuthStartPlanMaterial | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** OAuth 凭据仓储：统一 provider 命名空间 */
export class OAuthCredentialRepo {
  private readonly knownProviderIds: OAuthProviderId[];

  constructor(
    private credentialService: ICredentialService,
    options: OAuthCredentialRepoOptions = {},
  ) {
    this.knownProviderIds = collectKnownOAuthProviderIds(options.providerIds);
    this.onCorruptOAuthSessionCleared = options.onCorruptOAuthSessionCleared;
  }

  private readonly onCorruptOAuthSessionCleared?: (
    providerIds: readonly OAuthProviderId[],
  ) => Promise<void>;

  private get localStore(): Pick<
    LocalCredentialService,
    "loadMany" | "updateMany" | "deleteUnreadable"
  > {
    const store = this.credentialService as Partial<LocalCredentialService>;
    if (
      typeof store.loadMany !== "function" ||
      typeof store.updateMany !== "function" ||
      typeof store.deleteUnreadable !== "function"
    )
      throw new Error("OAuth 会话提交需要 Host 私有批量凭据存储");
    return store as Pick<LocalCredentialService, "loadMany" | "updateMany" | "deleteUnreadable">;
  }

  private sessionKeys(): string[] {
    return [
      ACTIVE_PROVIDER_KEY,
      ZCODE_JWT_TOKEN_KEY,
      SESSION_REVISION_KEY,
      OAUTH_LINKED_BIGMODEL_KEY,
      ...this.knownProviderIds.flatMap((provider) => [
        accessTokenKey(provider),
        refreshTokenKey(provider),
        userInfoKey(provider),
      ]),
    ];
  }

  async loadSessionSnapshot(): Promise<Record<string, string | null>> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let identity: Record<string, string | null>;
      try {
        identity = await this.localStore.loadMany([ACTIVE_PROVIDER_KEY, SESSION_REVISION_KEY]);
      } catch (error) {
        if (!isCredentialDecryptError(error)) throw error;
        await this.clearCorruptOAuthSession([ACTIVE_PROVIDER_KEY, SESSION_REVISION_KEY]);
        continue;
      }
      const provider = identity[ACTIVE_PROVIDER_KEY];
      const keys = [
        ACTIVE_PROVIDER_KEY,
        ZCODE_JWT_TOKEN_KEY,
        SESSION_REVISION_KEY,
        ...(provider
          ? [accessTokenKey(provider), refreshTokenKey(provider), userInfoKey(provider)]
          : []),
      ];
      try {
        const snapshot = await this.localStore.loadMany(keys);
        if (
          snapshot[ACTIVE_PROVIDER_KEY] === provider &&
          snapshot[SESSION_REVISION_KEY] === identity[SESSION_REVISION_KEY]
        ) {
          if (!provider || !isBuiltinOAuthProvider(provider)) return snapshot;
          try {
            const full = await this.localStore.loadMany([...keys, OAUTH_LINKED_BIGMODEL_KEY]);
            if (
              full[ACTIVE_PROVIDER_KEY] === provider &&
              full[SESSION_REVISION_KEY] === snapshot[SESSION_REVISION_KEY]
            )
              return full;
          } catch (error) {
            if (!isCredentialDecryptError(error)) throw error;
            // 关联材料损坏只能清理该关联，不能注销仍有效的主登录。
            await this.localStore.deleteUnreadable([OAUTH_LINKED_BIGMODEL_KEY], {
              expected: snapshot,
              removeKeys: [OAUTH_LINKED_BIGMODEL_KEY],
              replacements: { [SESSION_REVISION_KEY]: randomUUID() },
            });
          }
        }
      } catch (error) {
        if (!isCredentialDecryptError(error)) throw error;
        // 清理也比较原身份与 revision；旧渠道的坏密文不能删除已切换的新登录。
        await this.clearCorruptOAuthSession(keys, identity);
      }
    }
    throw new Error("OAuth session changed while reading credentials");
  }

  tokenSetFromSnapshot(
    snapshot: Readonly<Record<string, string | null>>,
    provider: OAuthProviderId,
  ): OAuthTokenSet | null {
    const accessToken = snapshot[accessTokenKey(provider)];
    if (!accessToken) return null;
    const refreshToken = snapshot[refreshTokenKey(provider)];
    const zcodeJwtToken = snapshot[ZCODE_JWT_TOKEN_KEY];
    let linkedBigModel: OAuthTokenSet["linkedBigModel"];
    try {
      const raw = JSON.parse(snapshot[OAUTH_LINKED_BIGMODEL_KEY] ?? "null");
      if (
        typeof raw?.userId === "string" &&
        raw.userId === this.profileFromSnapshot(snapshot, provider)?.id &&
        typeof raw?.customerId === "string" &&
        raw.customerId.trim() &&
        typeof raw?.accessToken === "string" &&
        raw.accessToken.trim()
      )
        linkedBigModel = { customerId: raw.customerId, accessToken: raw.accessToken };
    } catch {
      /* 非法关联不作为主身份失效证据。 */
    }
    return {
      accessToken,
      ...(linkedBigModel ? { linkedBigModel } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(zcodeJwtToken ? { zcodeJwtToken } : {}),
    };
  }

  profileFromSnapshot(
    snapshot: Readonly<Record<string, string | null>>,
    provider: OAuthProviderId,
  ): OAuthUserProfile | null {
    return this.parseStoredUserProfile(snapshot[userInfoKey(provider)] ?? null, provider);
  }

  async loadIdentityMaterial(): Promise<OAuthIdentityMaterial | null> {
    const snapshot = await this.loadSessionSnapshot();
    const provider = snapshot[ACTIVE_PROVIDER_KEY];
    const profile = provider ? this.profileFromSnapshot(snapshot, provider) : null;
    const jwt = snapshot[ZCODE_JWT_TOKEN_KEY]?.trim();
    if (!provider || !profile || !jwt) return null;
    return {
      loginProvider: provider,
      zcodeUserId: profile.id,
      sessionRevision: snapshot[SESSION_REVISION_KEY] ?? null,
      zcodeJwtToken: jwt,
    };
  }

  async loadFamilyMaterial(family: ProviderFamilyDomain): Promise<OAuthAccountMaterial | null> {
    return this.materialFromSnapshot(await this.loadSessionSnapshot(), family);
  }

  async loadStartPlanMaterial(
    family: ProviderFamilyDomain,
  ): Promise<OAuthStartPlanMaterial | null> {
    return this.startPlanMaterialFromSnapshot(await this.loadSessionSnapshot(), family);
  }

  async loadWebsiteSession(): Promise<OAuthWebsiteSession | null> {
    const snapshot = await this.loadSessionSnapshot();
    const provider = snapshot[ACTIVE_PROVIDER_KEY];
    const profile = provider ? this.profileFromSnapshot(snapshot, provider) : null;
    const tokens = provider ? this.tokenSetFromSnapshot(snapshot, provider) : null;
    if (!provider || !profile || !tokens) return null;
    return {
      loginProvider: provider,
      userId: profile.id,
      sessionRevision: snapshot[SESSION_REVISION_KEY] ?? null,
      zcodeJwtToken: tokens.zcodeJwtToken ?? null,
      // 中国区 OAuth 仅用于上游授权；网页通过主 JWT 的 profile 取得关联，不能误投全球接口。
      legacyOAuthToken:
        provider === ZAI_PROVIDER_ID || provider === BIGMODEL_PROVIDER_ID
          ? tokens.accessToken
          : null,
    };
  }

  async loadAccountAvailability(): Promise<OAuthAccountAvailability> {
    const snapshot = await this.loadSessionSnapshot();
    const provider = snapshot[ACTIVE_PROVIDER_KEY];
    const profile = provider ? this.profileFromSnapshot(snapshot, provider) : null;
    return {
      loginProvider: profile ? (provider ?? null) : null,
      userId: profile?.id ?? null,
      sessionRevision: snapshot[SESSION_REVISION_KEY] ?? null,
      families: (["zai", "bigmodel"] as const).filter(
        (family) => this.materialFromSnapshot(snapshot, family) !== null,
      ),
    };
  }

  private materialFromSnapshot(
    snapshot: Readonly<Record<string, string | null>>,
    family: ProviderFamilyDomain,
  ): OAuthAccountMaterial | null {
    const loginProvider = snapshot[ACTIVE_PROVIDER_KEY];
    if (!loginProvider) return null;
    const profile = this.profileFromSnapshot(snapshot, loginProvider);
    const tokens = this.tokenSetFromSnapshot(snapshot, loginProvider);
    if (!profile || !tokens) return null;
    const direct = loginProvider === family;
    const linked = family === "bigmodel" ? tokens.linkedBigModel : undefined;
    if (!direct && !linked) return null;
    // 中国区 OAuth 不能被当成全球区业务凭据；关联也必须已经绑定当前 ZCode 主体。
    return {
      family,
      loginProvider,
      zcodeUserId: profile.id,
      sessionRevision: snapshot[SESSION_REVISION_KEY] ?? null,
      accountIdentity: linked?.customerId ?? profile.id,
      accessToken: linked?.accessToken ?? tokens.accessToken,
      zcodeJwtToken: tokens.zcodeJwtToken ?? null,
    };
  }

  /**
   * Bug 原因：Start 身份曾只来自套餐家族材料。国内新账号（zai_cn，未注册 BigModel）
   * 两个 family 都没有材料，Start 被判为未连接、要求登录，也不查 balance。
   * Start 只需要 ZCode JWT：已有家族材料时沿用原身份；否则仅“登录对应的 Start 家族”
   * 以 ZCode 主体兜底，其他 family 仍没有 Start 材料。付费套餐不读取这里。
   */
  private startPlanMaterialFromSnapshot(
    snapshot: Readonly<Record<string, string | null>>,
    family: ProviderFamilyDomain,
  ): OAuthStartPlanMaterial | null {
    const account = this.materialFromSnapshot(snapshot, family);
    if (account) {
      const { accessToken: _accessToken, ...material } = account;
      return material;
    }
    const loginProvider = snapshot[ACTIVE_PROVIDER_KEY];
    if (!loginProvider || resolveStartPlanFamilyFromOAuthProvider(loginProvider) !== family)
      return null;
    const profile = this.profileFromSnapshot(snapshot, loginProvider);
    const tokens = this.tokenSetFromSnapshot(snapshot, loginProvider);
    if (!profile || !tokens) return null;
    return {
      family,
      loginProvider,
      zcodeUserId: profile.id,
      sessionRevision: snapshot[SESSION_REVISION_KEY] ?? null,
      accountIdentity: profile.id,
      zcodeJwtToken: tokens.zcodeJwtToken ?? null,
    };
  }

  async commitSession(
    expected: Readonly<Record<string, string | null>>,
    provider: OAuthProviderId,
    tokenSet: OAuthTokenSet,
    profile: OAuthUserProfile,
    assertCurrent?: () => void,
  ): Promise<boolean> {
    const changes: Record<string, string | null> = Object.fromEntries(
      this.sessionKeys().map((key) => [key, null]),
    );
    Object.assign(changes, {
      [ACTIVE_PROVIDER_KEY]: provider,
      [SESSION_REVISION_KEY]: randomUUID(),
      [ZCODE_JWT_TOKEN_KEY]: tokenSet.zcodeJwtToken ?? null,
      [OAUTH_LINKED_BIGMODEL_KEY]: tokenSet.linkedBigModel
        ? JSON.stringify({ userId: profile.id, ...tokenSet.linkedBigModel })
        : null,
      [accessTokenKey(provider)]: tokenSet.accessToken,
      [refreshTokenKey(provider)]: tokenSet.refreshToken ?? null,
      [userInfoKey(provider)]: JSON.stringify(
        isZaiOAuthProvider(provider) && profile.rawProfile ? profile.rawProfile : profile,
      ),
    });
    return this.localStore.updateMany(changes, { expected, assertCurrent });
  }

  async clearSession(expected: Readonly<Record<string, string | null>>): Promise<boolean> {
    return this.localStore.updateMany(
      {
        ...Object.fromEntries(this.sessionKeys().map((key) => [key, null])),
        [SESSION_REVISION_KEY]: randomUUID(),
      },
      { expected },
    );
  }

  async getActiveProvider(): Promise<OAuthProviderId | null> {
    return this.loadActiveProvider();
  }

  async setActiveProvider(provider: OAuthProviderId | null): Promise<void> {
    await this.saveActiveProvider(provider);
  }

  async loadActiveProvider(): Promise<OAuthProviderId | null> {
    try {
      return await this.credentialService.load(ACTIVE_PROVIDER_KEY);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      await this.clearCorruptOAuthSession([ACTIVE_PROVIDER_KEY]);
      return this.credentialService.load(ACTIVE_PROVIDER_KEY);
    }
  }

  async saveActiveProvider(provider: OAuthProviderId | null): Promise<void> {
    const snapshot = await this.loadSessionSnapshot();
    if (!provider) {
      if (!(await this.clearSession(snapshot)))
        throw new Error("OAuth session changed before clearing provider");
      return;
    }
    if (
      !(await this.localStore.updateMany(
        {
          [ACTIVE_PROVIDER_KEY]: provider,
          [SESSION_REVISION_KEY]: randomUUID(),
        },
        { expected: snapshot },
      ))
    )
      throw new Error("OAuth session changed before updating provider");
  }

  async loadActiveTokenSet(): Promise<OAuthTokenSet | null> {
    const snapshot = await this.loadSessionSnapshot();
    const provider = snapshot[ACTIVE_PROVIDER_KEY];
    return provider ? this.tokenSetFromSnapshot(snapshot, provider) : null;
  }

  async saveActiveTokenSet(tokenSet: OAuthTokenSet): Promise<void> {
    const snapshot = await this.loadSessionSnapshot();
    const provider = snapshot[ACTIVE_PROVIDER_KEY];
    if (!provider) throw new Error("保存当前登录 token 前缺少 active provider");
    if (!(await this.saveTokenSet(provider, tokenSet, snapshot)))
      throw new Error("OAuth session changed before token update");
  }

  async loadActiveUserProfile(): Promise<OAuthUserProfile | null> {
    const snapshot = await this.loadSessionSnapshot();
    const provider = snapshot[ACTIVE_PROVIDER_KEY];
    return provider ? this.profileFromSnapshot(snapshot, provider) : null;
  }

  async saveActiveUserProfile(profile: OAuthUserProfile): Promise<void> {
    const snapshot = await this.loadSessionSnapshot();
    const provider = snapshot[ACTIVE_PROVIDER_KEY];
    if (!provider) throw new Error("保存当前登录 user 前缺少 active provider");
    if (!(await this.saveUserProfile(provider, profile, snapshot)))
      throw new Error("OAuth session changed before profile update");
  }

  async saveLoginAttribution(attribution: OAuthLoginAttribution): Promise<void> {
    const persistAttribution = Object.fromEntries(
      Object.entries(attribution).flatMap(([key, value]) => {
        const trimmed = typeof value === "string" ? value.trim() : "";
        return trimmed ? [[key, trimmed]] : [];
      }),
    );

    if (Object.keys(persistAttribution).length === 0) {
      return;
    }

    await this.credentialService.save(LOGIN_ATTRIBUTION_KEY, JSON.stringify(persistAttribution));
  }

  async loadLoginAttribution(): Promise<OAuthLoginAttribution | null> {
    let raw: string | null;
    try {
      raw = await this.credentialService.load(LOGIN_ATTRIBUTION_KEY);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }
      return null;
    }

    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // 兼容本分支早期保存过的 { params, expiresAt } 结构；取消 TTL 后只读取 params。
      const storedParams =
        parsed.params && typeof parsed.params === "object"
          ? (parsed.params as Record<string, unknown>)
          : parsed;

      const params = Object.fromEntries(
        Object.entries(storedParams).flatMap(([key, value]) =>
          (key === "channel_id" || key === "utm_source" || key === "utm_campaign") &&
          typeof value === "string" &&
          value.trim()
            ? [[key, value.trim()]]
            : [],
        ),
      ) as OAuthLoginAttribution;
      if (Object.keys(params).length === 0) {
        await this.credentialService.delete(LOGIN_ATTRIBUTION_KEY);
        return null;
      }
      return params;
    } catch {
      await this.credentialService.delete(LOGIN_ATTRIBUTION_KEY);
      return null;
    }
  }

  async clearActiveSession(expected?: Readonly<Record<string, string | null>>): Promise<boolean> {
    return this.clearSession(expected ?? (await this.loadSessionSnapshot()));
  }

  async loadTokenSet(provider: OAuthProviderId): Promise<OAuthTokenSet | null> {
    return this.tokenSetFromSnapshot(await this.loadSessionSnapshot(), provider);
  }

  async loadCachedSessionTokens(
    provider: OAuthProviderId,
  ): Promise<{ key: string; value: string }[] | null> {
    const snapshot = await this.loadSessionSnapshot();
    if (snapshot[ACTIVE_PROVIDER_KEY] !== provider) return null;
    return [ZCODE_JWT_TOKEN_KEY, accessTokenKey(provider)].map((key) => ({
      key,
      value: snapshot[key]?.trim() ?? "",
    }));
  }

  async saveTokenSet(
    provider: OAuthProviderId,
    tokenSet: OAuthTokenSet,
    expected?: Readonly<Record<string, string | null>>,
  ): Promise<boolean> {
    return this.localStore.updateMany(
      {
        [accessTokenKey(provider)]: tokenSet.accessToken,
        [refreshTokenKey(provider)]: tokenSet.refreshToken ?? null,
        [ZCODE_JWT_TOKEN_KEY]: tokenSet.zcodeJwtToken ?? null,
        [SESSION_REVISION_KEY]: randomUUID(),
      },
      { expected: expected ?? (await this.loadSessionSnapshot()) },
    );
  }

  async loadUserProfile(provider: OAuthProviderId): Promise<OAuthUserProfile | null> {
    return this.profileFromSnapshot(await this.loadSessionSnapshot(), provider);
  }

  private parseStoredUserProfile(
    raw: string | null,
    provider?: OAuthProviderId,
  ): OAuthUserProfile | null {
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<OAuthUserProfile>;
      if (
        typeof parsed.id === "string" &&
        typeof parsed.username === "string" &&
        typeof parsed.displayName === "string"
      ) {
        const avatarUrl = typeof parsed.avatarUrl === "string" ? parsed.avatarUrl : undefined;
        const rawProfile =
          typeof parsed.rawProfile === "object" && parsed.rawProfile !== null
            ? parsed.rawProfile
            : undefined;
        return {
          id: parsed.id,
          username: parsed.username,
          displayName: parsed.displayName,
          ...(avatarUrl ? { avatarUrl } : {}),
          ...(rawProfile ? { rawProfile } : {}),
        };
      }

      if (isZaiOAuthProvider(provider) && typeof parsed === "object" && parsed !== null) {
        // ZAI user_info 现在按后端 data.user 原样持久化，
        // 启动恢复时需要从 user_id/name/avatar 重新映射展示字段。
        const zaiProfile = toOAuthUserProfileFromRawZaiUser(parsed as Record<string, unknown>);
        if (zaiProfile) {
          return zaiProfile;
        }
      }
    } catch {
      // ignore parse error and fallback to null
    }

    return null;
  }

  async saveUserProfile(
    provider: OAuthProviderId,
    profile: OAuthUserProfile,
    expected?: Readonly<Record<string, string | null>>,
  ): Promise<boolean> {
    // ZAI 后端返回的 data.user 是后续账号态排查与恢复的源数据，
    // 之前只保存归一化展示字段会丢失 email/name/avatar 原始结构。
    const persistProfile =
      isZaiOAuthProvider(provider) && profile.rawProfile ? profile.rawProfile : profile;

    return this.localStore.updateMany(
      {
        [userInfoKey(provider)]: JSON.stringify(persistProfile),
        [SESSION_REVISION_KEY]: randomUUID(),
      },
      { expected: expected ?? (await this.loadSessionSnapshot()) },
    );
  }

  async clearUserProfile(provider: OAuthProviderId): Promise<void> {
    const snapshot = await this.loadSessionSnapshot();
    if (
      !(await this.localStore.updateMany(
        {
          [userInfoKey(provider)]: null,
          [SESSION_REVISION_KEY]: randomUUID(),
        },
        { expected: snapshot },
      ))
    )
      throw new Error("OAuth session changed before clearing profile");
  }

  async clearProvider(provider: OAuthProviderId): Promise<void> {
    const snapshot = await this.loadSessionSnapshot();
    if (snapshot[ACTIVE_PROVIDER_KEY] === provider) {
      await this.clearSession(snapshot);
      return;
    }
    await this.localStore.updateMany(
      {
        [accessTokenKey(provider)]: null,
        [refreshTokenKey(provider)]: null,
        [userInfoKey(provider)]: null,
        [SESSION_REVISION_KEY]: randomUUID(),
      },
      { expected: snapshot },
    );
  }

  async clearAll(_providers: OAuthProviderId[]): Promise<void> {
    if (!(await this.clearSession(await this.loadSessionSnapshot())))
      throw new Error("OAuth session changed before logout");
  }

  private async clearCorruptOAuthSession(
    keys: readonly string[],
    expected?: Readonly<Record<string, string | null>>,
  ): Promise<void> {
    const deleted = await this.localStore.deleteUnreadable(keys, {
      expected,
      removeKeys: this.sessionKeys(),
      replacements: { [SESSION_REVISION_KEY]: randomUUID() },
    });
    if (!deleted) return;
    try {
      await this.onCorruptOAuthSessionCleared?.(this.knownProviderIds);
    } catch (error) {
      // 派生模型 provider 清理失败不能阻断 OAuth 损坏态恢复。
      // 主 OAuth 凭据已经删除，用户必须能回到可重新登录的未登录态。
      log.warn(undefined, "clear derived provider keys after corrupt OAuth session failed", error);
    }
  }
}
