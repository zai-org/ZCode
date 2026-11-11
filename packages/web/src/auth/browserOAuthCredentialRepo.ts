import { createBrowserNonce } from "#src/auth/oauthStateCodec.js";
import type { WebOAuthProviderId } from "#src/auth/contract.js";
export type { WebOAuthProviderId } from "#src/auth/contract.js";
import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  ZAI_CN_PROVIDER_ID,
  type OAuthProviderId,
  type OAuthTokenSet,
  type OAuthCachedSessionRestoreResult,
  type UserInfo,
  resolveJwtExpiration,
} from "@zcode/shared";
import { toUserInfo } from "./zaiWebOAuthProvider.js";

const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const ZAI_ACCESS_TOKEN_KEY = "oauth:zai:access_token";
const ZAI_USER_INFO_KEY = "oauth:zai:user_info";
const BIGMODEL_ACCESS_TOKEN_KEY = "oauth:bigmodel:access_token";
const BIGMODEL_USER_INFO_KEY = "oauth:bigmodel:user_info";
const OAUTH_PENDING_LOGINS_KEY = "oauth_pending_logins";
const BROWSER_SESSION_KEY = "oauth:browser_session";
const LOGIN_ATTEMPT_KEY = "oauth:browser_login_attempt";
const SESSION_EPOCH_KEY = "oauth:browser_session_epoch";
// 同一浏览器多个标签页可以同时发起登录；只留最近几条，放弃的登录不会无限累积。
const MAX_PENDING_LOGINS = 5;

export function isWebOAuthProviderId(value: unknown): value is WebOAuthProviderId {
  return (
    value === ZAI_PROVIDER_ID || value === ZAI_CN_PROVIDER_ID || value === BIGMODEL_PROVIDER_ID
  );
}

/** 历史渠道键只用于兼容读取；新登录统一写入一条完整会话。 */
function providerKeys(provider: WebOAuthProviderId): { accessToken: string; userInfo: string } {
  if (provider === ZAI_CN_PROVIDER_ID)
    return { accessToken: "oauth:zai_cn:access_token", userInfo: "oauth:zai_cn:user_info" };
  return provider === BIGMODEL_PROVIDER_ID
    ? { accessToken: BIGMODEL_ACCESS_TOKEN_KEY, userInfo: BIGMODEL_USER_INFO_KEY }
    : { accessToken: ZAI_ACCESS_TOKEN_KEY, userInfo: ZAI_USER_INFO_KEY };
}

interface BrowserOAuthSession {
  version: 1;
  provider: WebOAuthProviderId;
  userInfo: UserInfo;
  zcodeJwtToken: string;
  revision: string;
  /** 仅当前渠道的业务材料，供同源官网使用；不是关联账号凭据。 */
  businessAccessToken?: string;
}

interface BrowserOAuthCredentialRepoStorage {
  localStorage: Storage;
}

/** 一次跳出去的登录：回调页靠它校验 state，并用同一 provider 与回调地址换 token。 */
export interface PendingOAuthLogin {
  nonce: string;
  provider: WebOAuthProviderId;
  redirectUri: string;
  expectedSession: string;
}

function isPendingOAuthLogin(value: unknown): value is PendingOAuthLogin {
  if (!value || typeof value !== "object") return false;
  const login = value as Partial<Record<keyof PendingOAuthLogin, unknown>>;
  return (
    typeof login.nonce === "string" &&
    hasText(login.nonce) &&
    isWebOAuthProviderId(login.provider) &&
    typeof login.redirectUri === "string" &&
    hasText(login.redirectUri) &&
    typeof login.expectedSession === "string" &&
    hasText(login.expectedSession)
  );
}

interface BrowserOAuthCredentialRepoOptions {
  now?: () => number;
}

interface WebZaiTokenSet {
  zcodeJwtToken: string;
  zaiAccessToken: string;
  expiresAt?: number;
}

function getBrowserStorage(): BrowserOAuthCredentialRepoStorage {
  return { localStorage: window.localStorage };
}

function hasText(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 浏览器 OAuth 凭据仓储：统一收敛 localStorage 读写，避免业务层散落认证状态判断。 */
export class BrowserOAuthCredentialRepo {
  private readonly localStorage: Storage;
  private readonly now: () => number;

  constructor(
    storage: BrowserOAuthCredentialRepoStorage = getBrowserStorage(),
    options: BrowserOAuthCredentialRepoOptions = {},
  ) {
    this.localStorage = storage.localStorage;
    this.now = options.now ?? Date.now;
  }

  private readPrimarySession(): BrowserOAuthSession | null {
    try {
      const raw = this.localStorage.getItem(BROWSER_SESSION_KEY);
      if (!raw) return null;
      const session = JSON.parse(raw) as BrowserOAuthSession;
      const userInfo = toUserInfo(session.userInfo);
      return session.version === 1 &&
        isWebOAuthProviderId(session.provider) &&
        userInfo &&
        userInfo.id !== "unknown" &&
        hasText(session.zcodeJwtToken) &&
        hasText(session.revision)
        ? { ...session, userInfo }
        : null;
    } catch {
      return null;
    }
  }

  private sessionSnapshot(): string {
    return JSON.stringify(
      [
        BROWSER_SESSION_KEY,
        SESSION_EPOCH_KEY,
        ACTIVE_PROVIDER_KEY,
        ZCODE_JWT_TOKEN_KEY,
        ZAI_ACCESS_TOKEN_KEY,
        ZAI_USER_INFO_KEY,
        BIGMODEL_ACCESS_TOKEN_KEY,
        BIGMODEL_USER_INFO_KEY,
      ].map((key) => this.localStorage.getItem(key)),
    );
  }

  private withSessionLock<T>(run: () => T): Promise<T> {
    if (!navigator.locks)
      return Promise.reject(new Error("Browser session locking is unavailable"));
    return navigator.locks.request("zcode-browser-oauth", run);
  }

  beginLoginAttempt(nonce: string): Promise<string> {
    return this.withSessionLock(() => {
      this.localStorage.setItem(LOGIN_ATTEMPT_KEY, nonce);
      return this.sessionSnapshot();
    });
  }

  ownsLoginAttempt(nonce: string, expected: string): boolean {
    return (
      this.localStorage.getItem(LOGIN_ATTEMPT_KEY) === nonce && this.sessionSnapshot() === expected
    );
  }

  finishLoginAttempt(nonce: string): Promise<void> {
    if (this.localStorage.getItem(LOGIN_ATTEMPT_KEY) !== nonce) return Promise.resolve();
    // 无锁浏览器不会创建新attempt；清理旧attempt不能覆盖原始登录错误。
    if (!navigator.locks) return Promise.resolve();
    return this.withSessionLock(() => {
      if (this.localStorage.getItem(LOGIN_ATTEMPT_KEY) === nonce)
        this.localStorage.removeItem(LOGIN_ATTEMPT_KEY);
    });
  }

  commitPrimarySession(
    session: Omit<BrowserOAuthSession, "version">,
    expected: string,
    nonce: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.withSessionLock(() => {
      // 跨标签页的旧ready/旧callback不能覆盖新登录或退出；检查和单记录提交共用一把锁。
      if (
        signal?.aborted ||
        this.sessionSnapshot() !== expected ||
        this.localStorage.getItem(LOGIN_ATTEMPT_KEY) !== nonce
      )
        return false;
      this.localStorage.setItem(BROWSER_SESSION_KEY, JSON.stringify({ version: 1, ...session }));
      this.localStorage.removeItem(LOGIN_ATTEMPT_KEY);
      window.dispatchEvent(new Event("zcode-browser-auth-change"));
      return true;
    });
  }

  subscribeSessionChange(listener: () => void): () => void {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith("oauth:") || event.key === ZCODE_JWT_TOKEN_KEY)
        listener();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("zcode-browser-auth-change", listener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("zcode-browser-auth-change", listener);
    };
  }

  getSessionRevision(): string | null {
    if (this.localStorage.getItem(BROWSER_SESSION_KEY) !== null)
      return this.readPrimarySession()?.revision ?? null;
    const account = this.loadActiveAccount();
    return account
      ? JSON.stringify([
          account.provider,
          account.userInfo,
          this.localStorage.getItem(SESSION_EPOCH_KEY),
        ])
      : null;
  }

  clearSession(): Promise<void> {
    // 无Web Locks时仍允许退出；新登录不支持无锁提交，因此不会与此清理并发提交。
    if (!navigator.locks) {
      this.clearAll();
      return Promise.resolve();
    }
    return this.withSessionLock(() => this.clearAll());
  }

  saveTokenSet(tokenSet: WebZaiTokenSet | OAuthTokenSet, provider: WebOAuthProviderId): void {
    const accessToken =
      "zaiAccessToken" in tokenSet ? tokenSet.zaiAccessToken : tokenSet.accessToken;
    const zcodeJwtToken = tokenSet.zcodeJwtToken;

    this.localStorage.setItem(providerKeys(provider).accessToken, accessToken);
    if (zcodeJwtToken) {
      this.localStorage.setItem(ZCODE_JWT_TOKEN_KEY, zcodeJwtToken);
    } else {
      this.localStorage.removeItem(ZCODE_JWT_TOKEN_KEY);
    }
  }

  saveUserInfo(user: unknown, provider: WebOAuthProviderId): void {
    const rawUserInfo = JSON.stringify(user);
    this.localStorage.setItem(providerKeys(provider).userInfo, rawUserInfo);
  }

  setActiveProvider(provider: WebOAuthProviderId | null): void {
    if (!provider) {
      this.localStorage.removeItem(ACTIVE_PROVIDER_KEY);
      return;
    }

    this.localStorage.setItem(ACTIVE_PROVIDER_KEY, provider);
  }

  getActiveProvider(): OAuthProviderId | null {
    if (this.localStorage.getItem(BROWSER_SESSION_KEY) !== null)
      return this.readPrimarySession()?.provider ?? null;
    return this.localStorage.getItem(ACTIVE_PROVIDER_KEY);
  }

  loadCachedSession(): UserInfo | null {
    const result = this.loadCachedSessionState();
    return result.status === "authenticated" ? result.userInfo : null;
  }

  /**
   * 只读的账号展示资料（设备页账号行）。不是登录门禁：不校验 JWT、不清理残缺凭据，
   * 否则渲染一次列表就可能提前登出；登录事实仍由 loadCachedSessionState / JWT 决定。
   */
  loadActiveAccount(): { provider: WebOAuthProviderId; userInfo: UserInfo } | null {
    try {
      if (this.localStorage.getItem(BROWSER_SESSION_KEY) !== null) {
        const session = this.readPrimarySession();
        return session ? { provider: session.provider, userInfo: session.userInfo } : null;
      }
      const provider = this.localStorage.getItem(ACTIVE_PROVIDER_KEY);
      if (!isWebOAuthProviderId(provider)) return null;
      const rawUserInfo = this.localStorage.getItem(providerKeys(provider).userInfo);
      if (!hasText(rawUserInfo)) return null;
      const userInfo = toUserInfo(JSON.parse(rawUserInfo));
      return userInfo ? { provider, userInfo } : null;
    } catch {
      return null;
    }
  }

  loadCachedSessionState(): OAuthCachedSessionRestoreResult {
    if (this.localStorage.getItem(BROWSER_SESSION_KEY) !== null) {
      const session = this.readPrimarySession();
      if (!session) return { status: "signed-out" };
      return resolveJwtExpiration(session.zcodeJwtToken, this.now()).kind === "expired"
        ? { status: "reauthentication-required", reason: "jwt-expired" }
        : { status: "authenticated", userInfo: session.userInfo };
    }
    const activeProvider = this.localStorage.getItem(ACTIVE_PROVIDER_KEY);
    const zcodeJwtToken = this.localStorage.getItem(ZCODE_JWT_TOKEN_KEY);
    // 一次只有一个 activeProvider（切换 provider = 重新登录并覆盖），所以按它选 key 段读。
    const keys = isWebOAuthProviderId(activeProvider) ? providerKeys(activeProvider) : null;
    const accessToken = keys ? this.localStorage.getItem(keys.accessToken) : null;
    const rawUserInfo = keys ? this.localStorage.getItem(keys.userInfo) : null;

    if (!keys || !hasText(zcodeJwtToken) || !hasText(accessToken) || !hasText(rawUserInfo)) {
      return { status: "signed-out" };
    }

    if (resolveJwtExpiration(zcodeJwtToken, this.now()).kind === "expired") {
      // Web localStorage 之前只检查 JWT 是否存在，过期后仍会恢复伪登录态。
      return { status: "reauthentication-required", reason: "jwt-expired" };
    }

    try {
      const userInfo = toUserInfo(JSON.parse(rawUserInfo));
      if (userInfo) {
        return { status: "authenticated", userInfo };
      }
    } catch {
      // localStorage 可能留下旧版或手工写入的损坏 JSON。
      // 这里只读返回未登录，避免渲染或旧读取任务误清除新会话。
    }

    return { status: "signed-out" };
  }

  loadZCodeJwtToken(): string | null {
    // loadCachedSessionState 只读，可选配置读取不会顺带清理过期或残缺的登录态。
    const session = this.loadCachedSessionState();
    if (session.status !== "authenticated") return null;
    return (
      this.readPrimarySession()?.zcodeJwtToken ??
      this.localStorage.getItem(ZCODE_JWT_TOKEN_KEY)?.trim() ??
      null
    );
  }

  clearAll(): void {
    // 即使退出时原本无登录，也要使在途旧callback失效，不能把清空误判成未变化。
    this.localStorage.setItem(SESSION_EPOCH_KEY, createBrowserNonce());
    this.localStorage.removeItem(BROWSER_SESSION_KEY);
    this.localStorage.removeItem(LOGIN_ATTEMPT_KEY);
    this.localStorage.removeItem(OAUTH_PENDING_LOGINS_KEY);
    this.localStorage.removeItem(ACTIVE_PROVIDER_KEY);
    this.localStorage.removeItem(ZCODE_JWT_TOKEN_KEY);
    // 两个 provider 的 key 段一起清：切换 provider 时不能留下上一个身份的残片，
    // 否则 loadCachedSessionState 可能读到半套凭据。
    this.localStorage.removeItem(ZAI_ACCESS_TOKEN_KEY);
    this.localStorage.removeItem(ZAI_USER_INFO_KEY);
    this.localStorage.removeItem(BIGMODEL_ACCESS_TOKEN_KEY);
    this.localStorage.removeItem(BIGMODEL_USER_INFO_KEY);
    this.localStorage.removeItem("oauth:zai_cn:access_token");
    this.localStorage.removeItem("oauth:zai_cn:user_info");
    window.dispatchEvent(new Event("zcode-browser-auth-change"));
  }

  /**
   * 记住这次跳出去的登录，按 nonce 区分。
   *
   * 修复：原先 nonce/provider/回调地址存在发起页的 sessionStorage。部分手机浏览器的 OAuth
   * 回调不在发起登录的标签页里，或标签页被系统回收后重建，回调页读不到 nonce，换 token 前
   * 就报 “OAuth CSRF 检测失败”，重新登录也一样失败。改存同源 localStorage 后，同一浏览器的
   * 任意标签页都能完成回调；nonce 仍随机且只用一次，CSRF 校验强度不变。
   */
  savePendingLogin(login: PendingOAuthLogin): void {
    const logins = this.readPendingLogins().filter((pending) => pending.nonce !== login.nonce);
    this.writePendingLogins([...logins, login].slice(-MAX_PENDING_LOGINS));
  }

  /** 取出并删除 nonce 对应的登录记录；找不到时不改动其他标签页的记录。 */
  takePendingLogin(nonce: string): PendingOAuthLogin | null {
    const logins = this.readPendingLogins();
    const login = logins.find((pending) => pending.nonce === nonce);
    if (!login) return null;
    this.writePendingLogins(logins.filter((pending) => pending !== login));
    return login;
  }

  private readPendingLogins(): PendingOAuthLogin[] {
    const raw = this.localStorage.getItem(OAUTH_PENDING_LOGINS_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isPendingOAuthLogin) : [];
    } catch {
      // 损坏的记录不能当成本次登录；下一次发起登录会整体覆盖。
      return [];
    }
  }

  private writePendingLogins(logins: PendingOAuthLogin[]): void {
    if (logins.length > 0) {
      this.localStorage.setItem(OAUTH_PENDING_LOGINS_KEY, JSON.stringify(logins));
    } else {
      this.localStorage.removeItem(OAUTH_PENDING_LOGINS_KEY);
    }
  }
}
