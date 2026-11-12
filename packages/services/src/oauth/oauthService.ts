/* eslint-disable max-lines -- OAuthService 集中维护 OAuth 会话生命周期和 provider 切换边界，当前 review 修复只收窄后台迁移写入条件。 */
import { randomBytes } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import {
  ApiError,
  formatLogPrefix,
  type ApiClient,
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  ZAI_CN_PROVIDER_ID,
  isBuiltinOAuthProvider,
  isZaiOAuthProvider,
  type OAuthCallbackResult,
  type OAuthAccountAvailability,
  type OAuthCachedSessionRestoreResult,
  type OAuthProviderId,
  type OAuthProviderMeta,
  type OAuthSessionState,
  type OAuthStartResponse,
  type OAuthTokenSet,
  type OAuthUserProfile,
  type UserInfo,
  resolveJwtExpiration,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { CredentialFileGuard } from "@zcode/shared/node";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { readApiJson } from "../providers/api/apiJson.js";
import type { IOAuthService } from "./oauth.js";
import { isCurrentOAuthCredentialRequest } from "#src/oauth/oauthUnauthorizedRequest.js";
import { hasOAuthAuthorizationCode, parseOAuthLoginAttribution } from "./callbackAttribution.js";
import {
  mergeOAuthDisplayProfile,
  refreshLegacyBigModelCachedProfile,
  withProviderProfileSchema,
} from "./oauthProfileSchema.js";
import {
  createOAuthProviderAdapters,
  readLinkedBigModel,
  type OAuthProviderAdapter,
} from "./providers/index.js";
import { OAuthCredentialRepo } from "./repo/oauthCredentialRepo.js";
import { createOAuthRuntimeConfig } from "./runtimeConfig.js";
import {
  buildDesktopOAuthRedirectUriFromEnv,
  buildZCodeApiUrlFromEnv,
} from "./providers/configUtils.js";

/** OAuth 超时时间（5 分钟） */
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_PROFILE_TIMEOUT_MS = 10_000;
const COMPLETED_POLLING_STATE_GRACE_MS = 30 * 1000;
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("oauthService", process.pid), ...args);
const serviceLog = createServiceLogger("oauthService");

interface PendingState {
  credentialGuard?: CredentialFileGuard;
  state: string;
  provider: OAuthProviderId;
  timeout: NodeJS.Timeout;
  phase: "awaiting-attribution-or-code" | "awaiting-code-after-attribution";
  completions?: Set<Promise<OAuthCallbackResult | null>>;
  expectedSession: Readonly<Record<string, string | null>>;
  redirectUri?: string;
  polling?: {
    expiresAt: number;
    flowId: string;
    nextPollAt: number;
    pollIntervalMs: number;
    pollToken: string;
    pollUrl: string;
  };
}

interface OAuthFlowEnvelope {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

interface OAuthServiceDependencies {
  captureCredentialGuard?: () => Promise<CredentialFileGuard>;
  adapters?: OAuthProviderAdapter[];
  apiClient?: ApiClient;
  now?: () => number;
  monotonicNow?: () => number;
  env?: NodeJS.ProcessEnv;
  onProviderLogout?: (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void>;
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toUserInfo(profile: OAuthUserProfile): UserInfo {
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.displayName,
    ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  };
}

function isSameOAuthProfile(left: OAuthUserProfile, right: OAuthUserProfile): boolean {
  return (
    left.id === right.id &&
    left.username === right.username &&
    left.displayName === right.displayName &&
    left.avatarUrl === right.avatarUrl &&
    JSON.stringify(left.rawProfile ?? null) === JSON.stringify(right.rawProfile ?? null)
  );
}

/**
 * OAuth 认证服务实现
 *
 * 在 host process 中运行，管理 OAuth 流程的完整生命周期。
 */
export class OAuthService implements IOAuthService {
  private readonly sessionChanges = new Emitter<OAuthSessionState>();
  readonly onDidChangeSession = this.sessionChanges.event;
  private readonly credentialService: ICredentialService;
  private readonly captureCredentialGuard?: () => Promise<CredentialFileGuard>;
  private readonly repo: OAuthCredentialRepo;
  private readonly adapters = new Map<OAuthProviderId, OAuthProviderAdapter>();
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly onProviderLogout?: (
    provider: OAuthProviderId,
    accountIdentity?: string | null,
  ) => Promise<void>;
  private readonly apiClient?: ApiClient;
  private readonly env: NodeJS.ProcessEnv;
  private readonly profileRefreshes = new Map<string, Promise<OAuthAccountAvailability>>();
  private pendingState: PendingState | null = null;
  private oauthFlowStartGeneration = 0;
  private oauthFlowStartProvider: OAuthProviderId | null = null;
  private oauthSessionGeneration = 0;
  private sessionMutationQueue: Promise<unknown> = Promise.resolve();
  private recentlyCompletedPollingState: {
    credentialGuard?: CredentialFileGuard;
    generation: number;
    expiresAt: number;
    provider: OAuthProviderId;
    state: string;
  } | null = null;
  /** Host 定时器清除的 polling flow 的发起代次；新登录或取消推进代次后自然失效。 */
  private expiredPollingGeneration: number | null = null;

  constructor(credentialService: ICredentialService, dependencies: OAuthServiceDependencies = {}) {
    this.credentialService = credentialService;
    this.captureCredentialGuard = dependencies.captureCredentialGuard;
    this.now = dependencies.now ?? Date.now;
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    this.onProviderLogout = dependencies.onProviderLogout;
    this.apiClient = dependencies.apiClient;
    this.env = dependencies.env ?? process.env;

    const adapters =
      dependencies.adapters ??
      createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
        apiClient: dependencies.apiClient,
      });

    for (const adapter of adapters) {
      this.adapters.set(adapter.providerId, adapter);
    }
    this.repo = new OAuthCredentialRepo(credentialService, {
      providerIds: adapters.map((adapter) => adapter.providerId),
      onCorruptOAuthSessionCleared: async (providers) => {
        this.sessionChanges.fire("signed-out");
        // 本地 OAuth 凭据解密失败后等价于强制 logout。
        // repo 只能清 OAuth 命名空间，派生的 Start/Coding Plan provider key 必须回到 service 层清理。
        await this.notifyProvidersLogout(providers);
      },
    });
  }

  async getProviders(): Promise<OAuthProviderMeta[]> {
    return [...this.adapters.values()]
      .map((adapter) => adapter.meta)
      .filter((meta) => meta.enabled)
      .sort((a, b) => a.order - b.order);
  }

  async getActiveProvider(): Promise<OAuthProviderId | null> {
    return this.repo.getActiveProvider();
  }

  async getAccountAvailability(): Promise<OAuthAccountAvailability> {
    return this.repo.loadAccountAvailability();
  }

  getWebsiteSession() {
    return this.repo.loadWebsiteSession();
  }

  async refreshAccountProfile(
    expected?: Pick<OAuthAccountAvailability, "loginProvider" | "userId" | "sessionRevision">,
  ): Promise<OAuthAccountAvailability> {
    const snapshot = await this.repo.loadSessionSnapshot();
    const provider = snapshot["oauth:active_provider"];
    const profile = provider ? this.repo.profileFromSnapshot(snapshot, provider) : null;
    const tokens = provider ? this.repo.tokenSetFromSnapshot(snapshot, provider) : null;
    const jwt = tokens?.zcodeJwtToken;
    // 拒绝来自旧业务请求的刷新：分类后可能已在另一进程完成重登或退出。
    if (
      expected &&
      (expected.loginProvider !== provider ||
        expected.userId !== profile?.id ||
        expected.sessionRevision !== (snapshot["oauth:session_revision"] ?? null))
    ) {
      return this.getAccountAvailability();
    }
    if (!provider || !profile || !tokens || !jwt || !this.apiClient)
      return this.getAccountAvailability();
    const key = JSON.stringify([provider, profile.id, snapshot["oauth:session_revision"], jwt]);
    const existing = this.profileRefreshes.get(key);
    if (existing) return existing;
    const refresh = (async () => {
      const response = await readApiJson<OAuthFlowEnvelope>(
        this.apiClient!,
        buildZCodeApiUrlFromEnv(this.env, "/api/v1/oauth/profile"),
        {
          headers: { Authorization: `Bearer ${jwt}` },
          authFailurePolicy: "caller-handled",
          timeoutMs: OAUTH_PROFILE_TIMEOUT_MS,
        },
      );
      const data = response.data;
      if (
        response.code !== 0 ||
        !isUnknownRecord(data) ||
        !isUnknownRecord(data.user) ||
        readTrimmedString(data.user.user_id) !== profile.id
      ) {
        throw new Error("账号关联响应无效或主体不一致");
      }
      const linkedBigModel = readLinkedBigModel(data.bigmodel);
      // 缺失关联块尚不能证明解除关联；只接受明确合法的正向结果，不清除原有材料。
      if (
        linkedBigModel &&
        JSON.stringify(linkedBigModel) !== JSON.stringify(tokens.linkedBigModel)
      ) {
        await this.runSessionMutation(async () => {
          // 补关联不能抢占用户正在进行的新登录；整组 CAS 再防御另一进程的退出或换人。
          if (this.pendingState || this.oauthFlowStartProvider) return;
          if (
            await this.repo.commitSession(
              snapshot,
              provider,
              { ...tokens, linkedBigModel },
              profile,
            )
          )
            this.oauthSessionGeneration += 1;
        });
      }
      return this.getAccountAvailability();
    })();
    this.profileRefreshes.set(key, refresh);
    try {
      return await refresh;
    } finally {
      if (this.profileRefreshes.get(key) === refresh) this.profileRefreshes.delete(key);
    }
  }

  async restoreCachedSession(): Promise<UserInfo | null> {
    const result = await this.restoreCachedSessionState();
    return result.status === "authenticated" ? result.userInfo : null;
  }

  async restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult> {
    return this.withCurrentCredentialStore(() => this.restoreCachedSessionStateInternal());
  }

  private async withCurrentCredentialStore<T>(operation: () => Promise<T>): Promise<T> {
    const guard = await this.captureCredentialGuard?.();
    return guard ? guard(operation) : operation();
  }

  private async restoreCachedSessionStateInternal(): Promise<OAuthCachedSessionRestoreResult> {
    const restoreGeneration = this.oauthSessionGeneration;
    const snapshot = await this.repo.loadSessionSnapshot();
    const activeProvider = snapshot["oauth:active_provider"];
    if (!activeProvider) {
      log("restoreCachedSession skipped: no active provider");
      return { status: "signed-out" };
    }

    const adapter = this.adapters.get(activeProvider);
    if (!adapter || !adapter.meta.enabled) {
      log(
        "restoreCachedSession aborted: provider unavailable, clearing active provider:",
        activeProvider,
      );
      if (!(await this.repo.clearActiveSession(snapshot))) return this.restoreCachedSessionState();
      return { status: "signed-out" };
    }

    const profile = this.repo.profileFromSnapshot(snapshot, activeProvider);
    if (!profile) {
      // zai / bigmodel 这类 OAuth token 生命周期很短，启动时如果强依赖远端 userinfo 校验，
      // 用户明明刚登录过，也会因为 access_token 过期被误判成未登录。
      // 这里改为优先读取登录成功时持久化的 user_info，只要用户没有手动退出，就按缓存恢复展示态。
      log("restoreCachedSession skipped: missing cached user profile:", activeProvider);
      return { status: "signed-out" };
    }

    const tokens = [
      ZCODE_JWT_TOKEN_KEY,
      ...(activeProvider === ZAI_CN_PROVIDER_ID ? [] : [`oauth:${activeProvider}:access_token`]),
    ].map((key) => ({
      key,
      value: snapshot[key]?.trim() ?? "",
    }));
    const expired = tokens.find(
      ({ value }) => value && resolveJwtExpiration(value, this.now()).kind === "expired",
    );
    const zcodeJwtToken = tokens[0]?.value ?? "";
    if (expired) {
      serviceLog.info("cached session invalidated because login JWT expired", {
        provider: activeProvider,
        credentialKey: expired.key,
      });
      const invalidated = await this.invalidateExpiredCachedSession(
        restoreGeneration,
        activeProvider,
        profile,
        expired.value,
        snapshot,
        expired.key,
      );
      if (!invalidated) {
        return this.restoreCachedSessionState();
      }
      return { status: "reauthentication-required", reason: "jwt-expired" };
    }

    if (activeProvider === BIGMODEL_PROVIDER_ID) {
      const migrationGeneration = this.oauthSessionGeneration;
      void refreshLegacyBigModelCachedProfile({
        adapter,
        cachedProfile: profile,
        loadTokenSet: () =>
          this.loadBigModelCachedProfileMigrationTokenSet(migrationGeneration, profile),
        now: this.now,
        runWithAdapterError: (run) => this.runWithAdapterError(adapter, run),
        saveProfile: (nextProfile) =>
          this.saveBigModelCachedProfileMigration(
            migrationGeneration,
            profile,
            nextProfile,
            snapshot,
          ),
      })
        .then((migratedProfile) => {
          if (migratedProfile !== profile) {
            log(
              "restoreCachedSession migrated cached profile:",
              activeProvider,
              migratedProfile.id,
            );
          }
        })
        .catch((error: unknown) => {
          log(
            "restoreCachedSession background profile migration failed:",
            activeProvider,
            error instanceof Error ? error.message : String(error),
          );
        });
    }

    if (isZaiOAuthProvider(activeProvider)) {
      if (!zcodeJwtToken) {
        // sidebar 登录入口之前只看缓存 user_info，会把“缺少 zcodejwttoken”的状态误判成已登录。
        // 这里补充 zcodejwttoken 门槛，确保没有后端 JWT 时统一按未登录处理。
        log("restoreCachedSession skipped: missing zcodejwttoken:", activeProvider);
        return { status: "signed-out" };
      }
    }

    log("restoreCachedSession restored:", activeProvider, profile.id);
    return { status: "authenticated", userInfo: toUserInfo(profile) };
  }

  private async invalidateExpiredCachedSession(
    expectedGeneration: number,
    expectedProvider: OAuthProviderId,
    expectedProfile: OAuthUserProfile,
    expectedJwt: string,
    expectedSnapshot: Readonly<Record<string, string | null>>,
    credentialKey = ZCODE_JWT_TOKEN_KEY,
  ): Promise<boolean> {
    const invalidated = await this.runSessionMutation(async () => {
      const snapshot = await this.repo.loadSessionSnapshot();
      const currentProvider = snapshot["oauth:active_provider"];
      const currentProfile = this.repo.profileFromSnapshot(snapshot, expectedProvider);
      const currentJwt = snapshot[credentialKey]?.trim() ?? "";
      if (
        this.oauthSessionGeneration !== expectedGeneration ||
        currentProvider !== expectedProvider ||
        !currentProfile ||
        !isSameOAuthProfile(currentProfile, expectedProfile) ||
        currentJwt !== expectedJwt
      ) {
        // 启动恢复读取过期凭据后，新登录或 provider 切换可能已经完成；
        // 旧恢复任务只能清理仍与其快照完全一致的会话，不能误删刚写入的新认证状态。
        serviceLog.info("skipped stale expired JWT session invalidation", {
          provider: expectedProvider,
        });
        return false;
      }
      if (!(await this.repo.clearActiveSession(expectedSnapshot))) return false;
      this.oauthSessionGeneration += 1;
      this.sessionChanges.fire("signed-out");
      return true;
    });
    if (!invalidated) {
      return false;
    }
    await this.cancelPending(expectedProvider);
    try {
      await this.notifyProviderLogout(expectedProvider, expectedProfile.id);
    } catch (error) {
      // JWT 已过期时主认证事实必须先失效；派生 provider 清理失败不能把 UI 留在伪登录态。
      serviceLog.warn("expired JWT derived provider cleanup failed", {
        provider: expectedProvider,
        error,
      });
    }
    return true;
  }

  private async loadBigModelCachedProfileMigrationTokenSet(
    expectedGeneration: number,
    expectedCachedProfile: OAuthUserProfile,
  ): Promise<OAuthTokenSet | null> {
    return this.runSessionMutation(async () => {
      if (this.oauthSessionGeneration !== expectedGeneration) {
        log("restoreCachedSession skipped stale BigModel token migration");
        return null;
      }

      const activeProvider = await this.repo.getActiveProvider();
      const currentProfile = await this.repo.loadUserProfile(BIGMODEL_PROVIDER_ID);
      if (
        activeProvider !== BIGMODEL_PROVIDER_ID ||
        !currentProfile ||
        !isSameOAuthProfile(currentProfile, expectedCachedProfile)
      ) {
        // 迁移请求目标固定是 BigModel，token 也必须固定读取 BigModel 命名空间；
        // 发请求前先复核持久化快照，避免切换到 ZAI 后把其他 provider token 发给 BigModel。
        log("restoreCachedSession skipped stale BigModel token migration:", activeProvider);
        return null;
      }

      return this.repo.loadTokenSet(BIGMODEL_PROVIDER_ID);
    });
  }

  private async saveBigModelCachedProfileMigration(
    expectedGeneration: number,
    expectedCachedProfile: OAuthUserProfile,
    nextProfile: OAuthUserProfile,
    expectedSnapshot: Readonly<Record<string, string | null>>,
  ): Promise<void> {
    await this.runSessionMutation(async () => {
      if (this.oauthSessionGeneration !== expectedGeneration) {
        log("restoreCachedSession skipped stale BigModel profile migration");
        return;
      }

      const activeProvider = await this.repo.getActiveProvider();
      if (activeProvider !== BIGMODEL_PROVIDER_ID) {
        log("restoreCachedSession skipped stale BigModel profile migration:", activeProvider);
        return;
      }

      const currentProfile = await this.repo.loadUserProfile(BIGMODEL_PROVIDER_ID);
      if (!currentProfile || !isSameOAuthProfile(currentProfile, expectedCachedProfile)) {
        // BigModel 旧缓存迁移在后台完成，期间用户可能 logout、切到 ZAI，
        // 或重新登录 BigModel。只有当前缓存仍是启动时那份旧缓存时，旧迁移结果才允许落盘。
        log("restoreCachedSession skipped outdated BigModel profile migration");
        return;
      }

      if (!(await this.repo.saveUserProfile(BIGMODEL_PROVIDER_ID, nextProfile, expectedSnapshot)))
        throw new Error("OAuth session changed during cached profile migration");
    });
  }

  private runSessionMutation<T>(run: () => Promise<T>): Promise<T> {
    // 后台 profile 迁移、logout、provider 切换都会改 OAuth 凭据；
    // 必须串行化，避免旧迁移在退出或切换清理之后重新写回 user_info。
    const next = this.sessionMutationQueue.catch(() => undefined).then(run);
    this.sessionMutationQueue = next.catch(() => undefined);
    return next;
  }

  private async persistOAuthSession(
    provider: OAuthProviderId,
    tokenSet: OAuthTokenSet,
    profile: OAuthUserProfile,
    expected: Readonly<Record<string, string | null>>,
    isStillCurrent: () => boolean,
  ): Promise<void> {
    const committed = await this.repo.commitSession(
      expected,
      provider,
      tokenSet,
      withProviderProfileSchema(provider, profile),
      () => {
        if (!isStillCurrent()) throw new Error("OAuth flow 已取消");
      },
    );
    // 条件失败表示另一写入者已经改变会话；不能用回滚再覆盖对方的新登录。
    if (!committed) throw new Error("OAuth 会话已变化，请重新发起登录");
    this.oauthSessionGeneration += 1;
    this.sessionChanges.fire("signed-in");
  }

  private async runPendingSessionCompletion(
    pending: PendingState,
    complete: () => Promise<{ tokenSet: OAuthTokenSet; profile: OAuthUserProfile }>,
    preserveAttribution?: () => Promise<void>,
  ): Promise<OAuthCallbackResult | null> {
    // 恢复代次在发起 flow 时固定；准入写归因与最终提交都沿用它，迟到结果不能写回恢复后的新库。
    const guarded = <T>(operation: () => Promise<T>): Promise<T> =>
      pending.credentialGuard ? pending.credentialGuard(operation) : operation();
    const completion = (async (): Promise<OAuthCallbackResult | null> => {
      const admitted = await this.runSessionMutation(() =>
        guarded(async () => {
          if (this.pendingState !== pending) {
            if (
              !this.pendingState &&
              this.recentlyCompletedPollingState?.state === pending.state &&
              this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
            )
              await preserveAttribution?.();
            return false;
          }
          await preserveAttribution?.();
          return true;
        }),
      );
      if (!admitted) {
        return !this.pendingState &&
          this.recentlyCompletedPollingState?.state === pending.state &&
          this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
          ? { kind: "duplicate", provider: pending.provider }
          : null;
      }
      // 网络不占用会话队列，取消无需等待慢请求；只有最终提交与取消按入队顺序线性化。
      const { tokenSet, profile } = await complete();
      return this.runSessionMutation(() =>
        guarded(async () => {
          if (this.pendingState !== pending) {
            return !this.pendingState &&
              this.recentlyCompletedPollingState?.state === pending.state &&
              this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
              ? { kind: "duplicate", provider: pending.provider }
              : null;
          }
          await this.persistOAuthSession(
            pending.provider,
            tokenSet,
            profile,
            pending.expectedSession,
            () => this.pendingState === pending,
          );
          this.clearPendingState();
          this.recentlyCompletedPollingState = {
            credentialGuard: pending.credentialGuard,
            generation: this.oauthFlowStartGeneration,
            expiresAt: this.now() + COMPLETED_POLLING_STATE_GRACE_MS,
            provider: pending.provider,
            state: pending.state,
          };
          return { kind: "session", provider: pending.provider, userInfo: toUserInfo(profile) };
        }),
      );
    })();
    // 单个“最后候选”会漏掉先到的慢请求，后到失败就会提前取消它。
    // 记录全部在途候选；等待的是原始候选而不是彼此的错误处理，避免相互等待。
    const completions = (pending.completions ??= new Set());
    completions.add(completion);
    void completion.then(
      () => completions.delete(completion),
      () => completions.delete(completion),
    );
    try {
      return await completion;
    } catch (error) {
      if (
        !this.pendingState &&
        this.recentlyCompletedPollingState?.state === pending.state &&
        this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
      )
        return { kind: "duplicate", provider: pending.provider };
      if (this.pendingState !== pending) return null;
      serviceLog.warn(undefined, "OAuth completion candidate failed", {
        provider: pending.provider,
      });
      while (completions.size > 0 && this.pendingState === pending) {
        await Promise.allSettled(completions);
        if (
          !this.pendingState &&
          this.recentlyCompletedPollingState?.state === pending.state &&
          this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
        ) {
          return { kind: "duplicate", provider: pending.provider };
        }
        if (this.pendingState !== pending) return null;
      }
      throw error;
    }
  }

  async restoreSession(): Promise<UserInfo | null> {
    return this.withCurrentCredentialStore(() => this.restoreSessionInternal());
  }

  private async restoreSessionInternal(): Promise<UserInfo | null> {
    const snapshot = await this.repo.loadSessionSnapshot();
    const activeProvider = snapshot["oauth:active_provider"];
    if (!activeProvider) {
      log("restoreSession skipped: no active provider");
      return null;
    }

    log("restoreSession started:", activeProvider);

    const adapter = this.adapters.get(activeProvider);
    if (!adapter || !adapter.meta.enabled) {
      log(
        "restoreSession aborted: provider unavailable, clearing active provider:",
        activeProvider,
      );
      await this.repo.clearActiveSession(snapshot);
      return null;
    }

    let tokenSet = this.repo.tokenSetFromSnapshot(snapshot, activeProvider);
    if (!tokenSet && adapter.loadLegacyTokenSet) {
      log("restoreSession fallback: trying provider legacy token set:", activeProvider);
      tokenSet = await adapter.loadLegacyTokenSet((key) => this.credentialService.load(key));
    }

    if (!tokenSet || !adapter.fetchUserInfo) {
      log(
        "restoreSession failed: missing token or user-info capability, logging out:",
        activeProvider,
      );
      await this.logoutActiveSession(
        async () =>
          JSON.stringify(await this.repo.loadSessionSnapshot()) === JSON.stringify(snapshot),
      );
      return null;
    }

    try {
      log("restoreSession validating token with provider userinfo endpoint:", activeProvider);
      const fetchedProfile = await this.runWithAdapterError(adapter, () =>
        adapter.fetchUserInfo!(tokenSet, {
          providerId: activeProvider,
          state: "",
          redirectUri: adapter.redirectUri,
          now: this.now,
        }),
      );

      const cachedProfile = this.repo.profileFromSnapshot(snapshot, activeProvider);
      // 显式恢复和后台资料迁移共用边界：上游userinfo只能更新展示，不能替换主身份。
      // 缺少可信缓存时必须重新完成ZCode登录，不从customerNumber或sub构造主用户。
      if (
        (activeProvider === BIGMODEL_PROVIDER_ID || activeProvider === ZAI_PROVIDER_ID) &&
        (!cachedProfile || cachedProfile.id === "unknown")
      )
        return null;
      const profile =
        activeProvider === BIGMODEL_PROVIDER_ID || activeProvider === ZAI_PROVIDER_ID
          ? mergeOAuthDisplayProfile(cachedProfile!, fetchedProfile)
          : fetchedProfile;

      // profile 只能补充原主体，不能把旧 JWT 与另一个 user ID 组合成新登录。
      if (
        activeProvider === ZAI_CN_PROVIDER_ID &&
        profile.id !== this.repo.profileFromSnapshot(snapshot, activeProvider)?.id
      ) {
        throw new Error("profile 返回的账号与当前会话不一致");
      }
      if (
        !(await this.repo.commitSession(
          snapshot,
          activeProvider,
          {
            ...tokenSet,
            zcodeJwtToken: tokenSet.zcodeJwtToken ?? snapshot[ZCODE_JWT_TOKEN_KEY] ?? undefined,
          },
          withProviderProfileSchema(activeProvider, profile),
        ))
      )
        return null;
      log("restoreSession validated:", activeProvider, profile.id);
      return toUserInfo(profile);
    } catch (error) {
      const normalized = adapter.normalizeError(error);

      // 启动恢复只看本地凭据会把“过期 token”误判成已登录。
      // 当远端明确返回未授权（401/403）时，立即按退出流程清理本地登录态。
      if (activeProvider !== ZAI_CN_PROVIDER_ID && this.isUnauthorizedError(normalized)) {
        log("restoreSession unauthorized, logging out:", activeProvider, normalized.message);
        await this.logoutActiveSession(
          async () =>
            JSON.stringify(await this.repo.loadSessionSnapshot()) === JSON.stringify(snapshot),
        );
        return null;
      }

      log("restoreSession validation error:", activeProvider, normalized.message);

      throw normalized;
    }
  }

  async startOAuth(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    if (provider === ZAI_CN_PROVIDER_ID) return this.startOAuthWithPolling(provider);
    return this.startOAuthInternal(provider);
  }

  async startOAuthWithPolling(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    if (!isBuiltinOAuthProvider(provider)) {
      return this.startOAuthInternal(provider);
    }

    const adapter = this.getEnabledAdapter(provider);
    if (!this.apiClient) {
      throw new Error("ApiClient 注入缺失：OAuth polling 必须通过 Providers 传入 apiClient");
    }
    // 两个 init 并发时，先发但后返回的旧响应会覆盖较新的 pending flow。
    // generation 让最后一次用户操作拥有 flow，旧响应只结束自己的调用方。
    const { startGeneration, expectedSession, credentialGuard } = await this.runSessionMutation(
      async () => {
        const startGeneration = ++this.oauthFlowStartGeneration;
        this.oauthFlowStartProvider = provider;
        this.clearPendingState();
        // 先固定恢复代次再读会话快照，保证两者来自同一代凭据库。
        const credentialGuard = await this.captureCredentialGuard?.();
        return {
          startGeneration,
          credentialGuard,
          expectedSession: await this.repo.loadSessionSnapshot(),
        };
      },
    );
    if (this.oauthFlowStartGeneration !== startGeneration)
      throw new Error("OAuth flow 已被新的登录请求替换");
    const pollToken = randomBytes(32).toString("hex");
    const initUrl = buildZCodeApiUrlFromEnv(this.env, "/api/v1/oauth/cli/init");
    const envelope = await readApiJson<OAuthFlowEnvelope>(this.apiClient, initUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pollToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider }),
    });
    if (this.oauthFlowStartGeneration !== startGeneration) {
      throw new Error("OAuth flow 已被新的登录请求替换");
    }
    this.oauthFlowStartProvider = null;
    const data = envelope.data;
    if (
      envelope.code !== 0 ||
      !isUnknownRecord(data) ||
      !readTrimmedString(data.flow_id) ||
      !readTrimmedString(data.authorize_url) ||
      !Number.isFinite(data.expires_at) ||
      !Number.isFinite(data.poll_interval_sec)
    ) {
      throw new Error(readTrimmedString(envelope.msg) || "OAuth flow 初始化响应无效");
    }

    const flowId = readTrimmedString(data.flow_id)!;
    const authorizeUrlString = readTrimmedString(data.authorize_url)!;
    const expiresAt = (data.expires_at as number) * 1_000;
    const pollIntervalMs = (data.poll_interval_sec as number) * 1_000;
    let authorizeUrl: URL;
    try {
      authorizeUrl = new URL(authorizeUrlString);
    } catch {
      throw new Error("OAuth flow 初始化响应无效");
    }
    if (provider === BIGMODEL_PROVIDER_ID) {
      // BigModel CLI callback 的失败页会截断原有 Desktop deep link 回调体验。
      // flow 仍由 Host 轮询，但浏览器回调恢复到官网中转页，再透传到 zcode://oauth/callback。
      authorizeUrl.searchParams.set("redirect", buildDesktopOAuthRedirectUriFromEnv(this.env));
    } else if (isZaiOAuthProvider(provider)) {
      // 国内渠道曾漏过中转改写；显式传渠道，避免官网把国内授权码送往海外回调。
      // 只改回调地址，授权站、client_id 和 state 仍由服务端决定。
      const redirectUri = new URL(buildDesktopOAuthRedirectUriFromEnv(this.env));
      if (provider === ZAI_CN_PROVIDER_ID) redirectUri.searchParams.set("provider", provider);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri.toString());
    }
    const state = authorizeUrl.searchParams.get("state")?.trim();
    const remainingLifetimeMs = expiresAt - this.now();
    if (
      authorizeUrl.protocol !== "https:" ||
      !state ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(pollIntervalMs) ||
      remainingLifetimeMs <= 0 ||
      pollIntervalMs < 1_000 ||
      pollIntervalMs >= remainingLifetimeMs
    ) {
      throw new Error("OAuth flow 初始化响应无效");
    }

    const timeoutMs = Math.min(OAUTH_TIMEOUT_MS, remainingLifetimeMs);
    // 初始化期间可能发生全库恢复；旧 flow 不能在恢复后重新取得写入资格。
    await credentialGuard?.(() => this.credentialService.inspectStore());
    if (this.oauthFlowStartGeneration !== startGeneration)
      throw new Error("OAuth flow 已被新的登录请求替换");
    const timeout = setTimeout(() => {
      const pending = this.pendingState;
      // polling flow 超时必须立即收口，不能等待下一次 UI 轮询；同时校验 flowId，避免旧定时器清掉新 flow。
      void this.runSessionMutation(async () => {
        if (
          this.pendingState === pending &&
          pending?.state === state &&
          pending.polling?.flowId === flowId
        ) {
          this.clearPendingState();
          // Bug 原因：这里只清除 flow，之后 pollPendingOAuth 因 pending 为空返回 null，
          // UI 把 null 当作继续等待，登录页永久停在等待态。记下本代过期事实，下一次轮询抛出过期错误。
          this.expiredPollingGeneration = startGeneration;
        }
      });
    }, timeoutMs);
    this.pendingState = {
      credentialGuard,
      state,
      expectedSession,
      provider: adapter.providerId,
      timeout,
      phase: "awaiting-attribution-or-code",
      ...(provider === ZAI_CN_PROVIDER_ID
        ? { redirectUri: authorizeUrl.searchParams.get("redirect_uri") ?? undefined }
        : {}),
      polling: {
        expiresAt,
        flowId,
        nextPollAt: this.monotonicNow(),
        pollIntervalMs,
        pollToken,
        pollUrl: buildZCodeApiUrlFromEnv(
          this.env,
          `/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`,
        ),
      },
    };

    serviceLog.info("OAuth polling flow started", {
      expiresInMs: timeoutMs,
      pollIntervalMs,
      provider,
    });
    return { provider, authorizeUrl: authorizeUrl.toString(), state };
  }

  async pollPendingOAuth(): Promise<OAuthCallbackResult | null> {
    const apiClient = this.apiClient;
    if (!apiClient) {
      return null;
    }
    const pending = this.pendingState;
    const polling = pending?.polling;
    if (!pending || !polling) {
      if (this.expiredPollingGeneration === this.oauthFlowStartGeneration)
        throw new Error("OAuth flow 已过期");
      return null;
    }
    if (this.now() >= polling.expiresAt) {
      await this.cancelPending(pending.provider);
      throw new Error("OAuth flow 已过期");
    }
    // 系统时间回拨会让基于绝对时间的间隔长期不到期；只用单调时钟调度轮询。
    // 上面的服务端绝对过期校验与本地五分钟上限仍独立生效。
    const pollNow = this.monotonicNow();
    if (pollNow < polling.nextPollAt) {
      return null;
    }
    polling.nextPollAt = pollNow + polling.pollIntervalMs;

    let envelope: OAuthFlowEnvelope;
    try {
      envelope = await readApiJson<OAuthFlowEnvelope>(apiClient, polling.pollUrl, {
        headers: { Authorization: `Bearer ${polling.pollToken}` },
      });
    } catch (error) {
      if (this.pendingState !== pending) return null;
      if (
        error instanceof ApiError &&
        error.status &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        try {
          return await this.runPendingSessionCompletion(pending, async () => {
            throw error;
          });
        } catch (terminalError) {
          await this.runSessionMutation(async () => {
            if (this.pendingState === pending) this.clearPendingState();
          });
          throw terminalError;
        }
      }
      // 轮询是 deep link 丢失时的可靠路径，单次断网或 5xx 不能立即取消 flow。
      // 保留服务端下发的查询间隔，下一轮继续尝试；高频状态只记 debug，避免生产日志膨胀。
      serviceLog.debug("OAuth polling request will retry", {
        error: error instanceof Error ? error.message : String(error),
        provider: pending.provider,
      });
      return null;
    }
    if (this.pendingState !== pending) {
      return null;
    }
    if (
      envelope.code === 0 &&
      isUnknownRecord(envelope.data) &&
      readTrimmedString(envelope.data.status) === "pending"
    ) {
      return null;
    }
    try {
      const result = await this.runPendingSessionCompletion(pending, async () => {
        const pollData = envelope.data;
        if (envelope.code !== 0 || !isUnknownRecord(pollData)) {
          throw new Error(readTrimmedString(envelope.msg) || "OAuth flow 查询响应无效");
        }
        const status = readTrimmedString(pollData.status);
        if (status === "failed") {
          throw new Error("OAuth flow 授权失败");
        }
        if (status !== "ready") {
          throw new Error("OAuth flow 查询响应无效");
        }

        const ready = pollData;
        const user = isUnknownRecord(ready.user) ? ready.user : null;
        const zai = isUnknownRecord(ready.zai) ? ready.zai : null;
        const bigmodel = isUnknownRecord(ready.bigmodel) ? ready.bigmodel : null;
        const providerAccessToken = isZaiOAuthProvider(pending.provider)
          ? readTrimmedString(zai?.access_token)
          : readTrimmedString(bigmodel?.access_token) || readTrimmedString(bigmodel?.accessToken);
        const zcodeJwtToken = readTrimmedString(ready.token);
        const userId = readTrimmedString(user?.user_id);
        if (!zcodeJwtToken || !providerAccessToken || !userId) {
          throw new Error("OAuth flow 查询响应无效");
        }
        const username = readTrimmedString(user?.name) || readTrimmedString(user?.email) || userId;
        const avatarUrl = readTrimmedString(user?.avatar);
        const profile: OAuthUserProfile = {
          id: userId,
          username,
          displayName: username,
          ...(avatarUrl ? { avatarUrl } : {}),
          rawProfile: user,
        };
        const adapter = this.getAdapter(pending.provider);
        const refreshToken =
          pending.provider === BIGMODEL_PROVIDER_ID
            ? readTrimmedString(bigmodel?.refresh_token) ||
              readTrimmedString(bigmodel?.refreshToken)
            : undefined;
        const linkedBigModel = isZaiOAuthProvider(pending.provider)
          ? readLinkedBigModel(ready.bigmodel)
          : undefined;
        const tokenSet = adapter.normalizePolledTokenSet
          ? await adapter.normalizePolledTokenSet({
              accessToken: providerAccessToken,
              zcodeJwtToken,
              linkedBigModel,
              ...(refreshToken ? { refreshToken } : {}),
            })
          : {
              accessToken: providerAccessToken,
              zcodeJwtToken,
              linkedBigModel,
              ...(refreshToken ? { refreshToken } : {}),
            };
        return { tokenSet, profile };
      });
      if (result?.kind === "session") {
        serviceLog.info("OAuth polling flow completed", { provider: pending.provider });
      }
      return result;
    } catch (error) {
      await this.runSessionMutation(async () => {
        if (this.pendingState === pending) this.clearPendingState();
      });
      throw error;
    }
  }

  private async startOAuthInternal(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    const adapter = this.getEnabledAdapter(provider);

    // 同窗口快速连续点击不同 provider 时，旧 state 如果不先取消，
    // 两条并发流程会共享同一回调通道，导致后回调抢占前回调并触发 state 错配。
    const start = await this.runSessionMutation(async () => {
      this.oauthFlowStartGeneration += 1;
      this.oauthFlowStartProvider = null;
      this.clearPendingState();
      // 先固定恢复代次再读会话快照，保证两者来自同一代凭据库。
      const credentialGuard = await this.captureCredentialGuard?.();
      return {
        generation: this.oauthFlowStartGeneration,
        credentialGuard,
        expectedSession: await this.repo.loadSessionSnapshot(),
      };
    });
    if (start.generation !== this.oauthFlowStartGeneration)
      throw new Error("OAuth flow 已被新的登录请求替换");

    const state = randomBytes(32).toString("hex");
    const timeout = setTimeout(() => {
      void this.runSessionMutation(async () => {
        if (this.pendingState?.state === state) this.clearPendingState();
      });
    }, OAUTH_TIMEOUT_MS);

    this.pendingState = {
      credentialGuard: start.credentialGuard,
      state,
      expectedSession: start.expectedSession,
      provider: adapter.providerId,
      timeout,
      phase: "awaiting-attribution-or-code",
    };

    const authorizeUrl = adapter.buildAuthorizeUrl({
      providerId: adapter.providerId,
      state,
      redirectUri: adapter.redirectUri,
      now: this.now,
    });

    return {
      provider: adapter.providerId,
      authorizeUrl,
      state,
    };
  }

  async handleCallback(url: string): Promise<OAuthCallbackResult | null> {
    const pending = this.pendingState;
    if (!pending) {
      const callbackState = new URL(url).searchParams.get("state")?.trim();
      const completed = this.recentlyCompletedPollingState;
      if (
        callbackState &&
        completed?.state === callbackState &&
        completed.generation === this.oauthFlowStartGeneration &&
        this.now() < completed.expiresAt
      ) {
        const attribution = parseOAuthLoginAttribution(new URL(url).searchParams);
        await this.runSessionMutation(async () => {
          // 修复原因：轮询先成功时仍需保存浏览器归因，不能把登录去重当作丢弃整条回调。
          if (
            !this.pendingState &&
            this.recentlyCompletedPollingState === completed &&
            completed.generation === this.oauthFlowStartGeneration &&
            attribution
          ) {
            const save = () => this.repo.saveLoginAttribution(attribution);
            await (completed.credentialGuard ? completed.credentialGuard(save) : save());
          }
        });
        return { kind: "duplicate", provider: completed.provider };
      }
      throw new Error("OAuth state 不匹配或已过期");
    }

    const parsedUrl = new URL(url);
    const state = parsedUrl.searchParams.get("state");
    if (!state || state !== pending.state) {
      throw new Error("OAuth state 不匹配或已过期");
    }
    if (pending.polling && this.now() >= pending.polling.expiresAt) {
      await this.cancelPending(pending.provider);
      throw new Error("OAuth flow 已过期");
    }

    const attribution = parseOAuthLoginAttribution(parsedUrl.searchParams);
    if (attribution && !hasOAuthAuthorizationCode(parsedUrl.searchParams)) {
      if (pending.phase === "awaiting-code-after-attribution") {
        throw new Error("OAuth 归因回调已处理");
      }

      // 修复原因：纯归因回调是最终授权码前的中转步骤，不能清掉仍需继续登录的 state；
      // 但若不显式推进 phase，同一 state 可重复写入归因并隐式复用 pending 生命周期。
      pending.phase = "awaiting-code-after-attribution";
      try {
        // 普通 save 会领取恢复后的新代次；纯归因也必须沿用 pending 的旧代次，避免迟到回调写回新库。
        const save = () => this.repo.saveLoginAttribution(attribution);
        await (pending.credentialGuard ? pending.credentialGuard(save) : save());
      } catch (error) {
        if (this.pendingState === pending) {
          pending.phase = "awaiting-attribution-or-code";
        }
        throw error;
      }
      return {
        kind: "attribution",
        provider: pending.provider,
        attribution,
      };
    }

    if (pending.provider === ZAI_CN_PROVIDER_ID && pending.polling) {
      // 官网已把国内授权码交给后端；客户端再次兑换会争抢一次性 code。
      // 唤起只补归因，登录仍由同一 flow 的 polling 提交；旧回调不能写入新会话。
      const generation = this.oauthFlowStartGeneration;
      return this.runSessionMutation(async () => {
        const completed = this.recentlyCompletedPollingState;
        const sameFlow =
          this.oauthFlowStartGeneration === generation &&
          (this.pendingState === pending ||
            (!this.pendingState &&
              completed?.state === pending.state &&
              completed.generation === generation &&
              this.now() < completed.expiresAt));
        if (sameFlow && attribution) {
          const save = () => this.repo.saveLoginAttribution(attribution);
          await (pending.credentialGuard ? pending.credentialGuard(save) : save());
        }
        return null;
      });
    }

    const adapter = this.getAdapter(pending.provider);
    const fallbackProfile: OAuthUserProfile = {
      id: "unknown",
      username: "user",
      displayName: "User",
    };

    return this.runPendingSessionCompletion(
      pending,
      async () => {
        const callback = adapter.parseCallbackParams(url);
        const context = {
          providerId: adapter.providerId,
          state: callback.state,
          redirectUri: pending.redirectUri ?? adapter.redirectUri,
          now: this.now,
        };
        const tokenSet = await this.runWithAdapterError(adapter, () =>
          adapter.exchangeToken(callback, context),
        );
        let profile = fallbackProfile;
        if (adapter.fetchUserInfo) {
          try {
            profile = await this.runWithAdapterError(adapter, () =>
              adapter.fetchUserInfo!(tokenSet, context),
            );
          } catch {
            // 获取用户信息失败不阻塞登录
          }
        }
        return { tokenSet, profile };
      },
      attribution ? () => this.repo.saveLoginAttribution(attribution) : undefined,
    );
  }

  async refreshToken(provider?: OAuthProviderId): Promise<void> {
    return this.withCurrentCredentialStore(() => this.refreshTokenInternal(provider));
  }

  private async refreshTokenInternal(provider?: OAuthProviderId): Promise<void> {
    const generation = this.oauthSessionGeneration;
    const targetProvider = await this.resolveProvider(provider);
    if (!targetProvider) {
      throw new Error("当前没有可用的登录 provider");
    }

    const adapter = this.getEnabledAdapter(targetProvider);
    if (!adapter.refreshToken) {
      throw new Error(
        `${adapter.meta.displayName} OAuth 暂未提供 refresh token 交换接口，请重新登录`,
      );
    }

    const snapshot = await this.repo.loadSessionSnapshot();
    const activeProvider = snapshot["oauth:active_provider"];
    if (targetProvider !== activeProvider) {
      throw new Error("只能刷新当前 App 登录 provider，请重新登录");
    }

    const tokenSet = this.repo.tokenSetFromSnapshot(snapshot, targetProvider);
    if (!tokenSet?.refreshToken) {
      throw new Error("当前账号缺少 refresh_token，请重新登录");
    }

    const refreshed = await this.runWithAdapterError(adapter, () =>
      adapter.refreshToken!(tokenSet, {
        providerId: targetProvider,
        state: "",
        redirectUri: adapter.redirectUri,
        now: this.now,
      }),
    );

    await this.runSessionMutation(async () => {
      if (this.oauthSessionGeneration !== generation) return;
      await this.repo.saveTokenSet(
        targetProvider,
        {
          ...tokenSet,
          ...refreshed,
          zcodeJwtToken: refreshed.zcodeJwtToken ?? tokenSet.zcodeJwtToken,
        },
        snapshot,
      );
    });
  }

  /** Host 本地 401 提交入口，不扩展 IOAuthService 的跨端契约。 */
  logoutIfCurrentCredentialRequest(input: string | URL, headers: Headers): Promise<boolean> {
    return this.withCurrentCredentialStore(() =>
      this.logoutActiveSession(() =>
        isCurrentOAuthCredentialRequest({
          input,
          headers,
          credentialService: this.credentialService,
          env: this.env,
        }),
      ),
    );
  }

  private async logoutActiveSession(isCurrent?: () => Promise<boolean>): Promise<boolean> {
    const result = await this.runSessionMutation(async () => {
      // 异步分类的 true 不是清理授权；凭据复核与清理必须和登录写入共用队列。
      const snapshot = await this.repo.loadSessionSnapshot();
      if (isCurrent && !(await isCurrent())) return null;
      const activeProvider = snapshot["oauth:active_provider"];
      // 合并边界：清理前保留原账号身份，不能退回仅按平台清理或在退出后再猜身份。
      const accountIdentity = activeProvider
        ? (this.repo.profileFromSnapshot(snapshot, activeProvider)?.id ?? null)
        : null;
      if (!(await this.repo.clearActiveSession(snapshot))) return null;
      this.oauthSessionGeneration += 1;
      // 登出已生效：后续 provider/设置清理即使失败，也必须先撤销已认证的远控连接。
      this.sessionChanges.fire("signed-out");
      return { activeProvider, accountIdentity };
    });
    if (!result) return false;
    if (result.activeProvider) {
      await this.cancelPending(result.activeProvider);
      try {
        await this.notifyProviderLogout(result.activeProvider, result.accountIdentity);
      } catch (error) {
        if (!isCurrent) throw error;
        // 凭据已经清理，派生配置失败不能吞掉原有过期提示；手动退出仍保留原错误语义。
        serviceLog.warn("Unauthorized session provider cleanup failed", { error });
      }
    }
    return true;
  }

  async logout(provider?: OAuthProviderId): Promise<void> {
    return this.withCurrentCredentialStore(() => this.logoutInternal(provider));
  }

  private async logoutInternal(provider?: OAuthProviderId): Promise<void> {
    if (!provider) {
      if (!(await this.logoutActiveSession())) throw new Error("OAuth 会话已变化，请重新退出");
      return;
    }

    const loggedOutIdentity = await this.runSessionMutation(async () => {
      const snapshot = await this.repo.loadSessionSnapshot();
      const activeProvider = snapshot["oauth:active_provider"];
      if (provider !== activeProvider) {
        return undefined;
      }
      const accountIdentity = this.repo.profileFromSnapshot(snapshot, provider)?.id ?? null;
      // ZAI/BigModel provider 的 Unlink 已收敛为 App logout。
      // 只有当前 active provider 才代表登录事实，避免旧 unlink 路径误删非当前 provider token。
      if (!(await this.repo.clearActiveSession(snapshot)))
        throw new Error("OAuth 会话已变化，请重新退出");
      this.oauthSessionGeneration += 1;
      this.sessionChanges.fire("signed-out");
      return accountIdentity;
    });
    if (loggedOutIdentity !== undefined) {
      await this.notifyProviderLogout(provider, loggedOutIdentity);
    }
    await this.cancelPending(provider);
  }

  async logoutAll(): Promise<void> {
    return this.withCurrentCredentialStore(() => this.logoutAllInternal());
  }

  private async logoutAllInternal(): Promise<void> {
    const providers = [...this.adapters.keys()];
    const accountIdentities = await this.runSessionMutation(async () => {
      const snapshot = await this.repo.loadSessionSnapshot();
      const identities = new Map<OAuthProviderId, string | null>();
      for (const provider of providers) {
        identities.set(provider, this.repo.profileFromSnapshot(snapshot, provider)?.id ?? null);
      }
      if (!(await this.repo.clearSession(snapshot)))
        throw new Error("OAuth 会话已变化，请重新退出");
      this.oauthSessionGeneration += 1;
      this.sessionChanges.fire("signed-out");
      return identities;
    });
    if (!accountIdentities) return;
    await this.cancelPending();
    await this.notifyProvidersLogout(providers, accountIdentities);
  }

  async cancelPending(provider?: OAuthProviderId): Promise<void> {
    await this.runSessionMutation(async () => {
      if (!this.pendingState) {
        if (provider && this.oauthFlowStartProvider && this.oauthFlowStartProvider !== provider)
          return;
      } else if (provider && this.pendingState.provider !== provider) return;
      this.oauthFlowStartGeneration += 1;
      this.oauthFlowStartProvider = null;
      this.clearPendingState();
    });
  }

  private clearPendingState(): void {
    if (!this.pendingState) {
      return;
    }

    clearTimeout(this.pendingState.timeout);
    this.pendingState = null;
  }

  private async notifyProviderLogout(
    provider: OAuthProviderId,
    accountIdentity?: string | null,
  ): Promise<void> {
    if (!this.onProviderLogout) {
      return;
    }

    await this.onProviderLogout(provider, accountIdentity);
  }

  private async notifyProvidersLogout(
    providers: readonly OAuthProviderId[],
    accountIdentities: ReadonlyMap<OAuthProviderId, string | null> = new Map(),
  ): Promise<void> {
    await Promise.all(
      providers.map((provider) =>
        this.notifyProviderLogout(provider, accountIdentities.get(provider)),
      ),
    );
  }

  private getAdapter(provider: OAuthProviderId): OAuthProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`不支持的 OAuth provider: ${provider}`);
    }

    return adapter;
  }

  private getEnabledAdapter(provider: OAuthProviderId): OAuthProviderAdapter {
    const adapter = this.getAdapter(provider);
    if (!adapter.meta.enabled) {
      throw new Error(`OAuth provider 未启用: ${provider}`);
    }

    return adapter;
  }

  private async resolveProvider(provider?: OAuthProviderId): Promise<OAuthProviderId | null> {
    if (provider) {
      return provider;
    }

    return this.repo.getActiveProvider();
  }

  private async runWithAdapterError<T>(
    adapter: OAuthProviderAdapter,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw adapter.normalizeError(error);
    }
  }

  private isUnauthorizedError(error: Error): boolean {
    const lowerMessage = error.message.toLowerCase();
    return (
      /\b401\b|\b403\b/.test(lowerMessage) ||
      lowerMessage.includes("unauthorized") ||
      lowerMessage.includes("forbidden")
    );
  }
}

/**
 * 工厂函数：创建 OAuthService 实例
 */
export function createOAuthService(
  credentialService: ICredentialService,
  dependencies: Omit<OAuthServiceDependencies, "adapters"> = {},
): OAuthService {
  return new OAuthService(credentialService, {
    ...dependencies,
    adapters: createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
      apiClient: dependencies.apiClient,
    }),
  });
}
