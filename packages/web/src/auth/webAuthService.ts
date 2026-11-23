import { createBrowserNonce } from "#src/auth/oauthStateCodec.js";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID, type UserInfo } from "@zcode/shared";
import {
  forwardRegionalOAuthCallback,
  initializeRegionalOAuth,
  pollRegionalOAuth,
  waitForRegionalPoll,
  type RegionalOAuthProvider,
} from "#src/auth/webRegionalOAuth.js";
import {
  BrowserOAuthCredentialRepo,
  type PendingOAuthLogin,
  type PendingRegionalFlow,
  type WebOAuthProviderId,
} from "./browserOAuthCredentialRepo.js";
import {
  buildOAuthState,
  buildReturnToCallbackUrl,
  buildWebRemoteOAuthRedirectUri,
  isTrustedDevReturnTo,
  parseOAuthState,
  parseOptionalUrl,
  resolveSafeAppReturnTo,
} from "./oauthStateCodec.js";
import { WEB_ZAI_OAUTH_CONFIG, type WebZaiOAuthConfig } from "./webZaiOAuthConfig.js";
import { ZaiWebOAuthProvider } from "./zaiWebOAuthProvider.js";

interface WebAuthServiceRuntime {
  assign(url: string): void;
  createNonce(): string;
  getCurrentHref(): string;
  getCurrentOrigin(): string;
  replace(url: string): void;
}

interface WebAuthServiceDependencies {
  config?: WebZaiOAuthConfig;
  provider?: ZaiWebOAuthProvider;
  repo?: BrowserOAuthCredentialRepo;
  runtime?: WebAuthServiceRuntime;
}

interface WebAuthLoginOptions {
  signal?: AbortSignal;
  devReturnTo?: string;
  appReturnTo?: string;
  redirectUri?: string;
  /** 缺省 zai，保持 /remote 等既有入口行为不变。 */
  provider?: WebOAuthProviderId;
}

export interface WebAuthCallbackResult {
  userInfo: UserInfo;
  appReturnTo: string | null;
}

function createDefaultRuntime(): WebAuthServiceRuntime {
  return {
    assign: (url) => {
      window.location.assign(url);
    },
    createNonce: createBrowserNonce,
    getCurrentHref: () => window.location.href,
    getCurrentOrigin: () => window.location.origin,
    replace: (url) => {
      window.location.replace(url);
    },
  };
}

export class WebAuthService {
  private readonly config: WebZaiOAuthConfig;
  private readonly provider: ZaiWebOAuthProvider;
  private readonly repo: BrowserOAuthCredentialRepo;
  private readonly runtime: WebAuthServiceRuntime;
  private loginController: AbortController | null = null;

  constructor(dependencies: WebAuthServiceDependencies = {}) {
    this.config = dependencies.config ?? WEB_ZAI_OAUTH_CONFIG;
    this.provider = dependencies.provider ?? new ZaiWebOAuthProvider(this.config);
    this.repo = dependencies.repo ?? new BrowserOAuthCredentialRepo();
    this.runtime = dependencies.runtime ?? createDefaultRuntime();
  }

  async startLogin(options: WebAuthLoginOptions = {}): Promise<void> {
    this.loginController?.abort();
    if (options.provider === BIGMODEL_PROVIDER_ID) {
      await this.startLegacyLogin(options);
      return;
    }
    const controller = new AbortController();
    this.loginController = controller;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const nonce = this.runtime.createNonce();
    let navigated = false;
    try {
      controller.signal.throwIfAborted();
      const expected = await this.repo.beginLoginAttempt(nonce);
      const pollToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      const provider = options.provider ?? ZAI_PROVIDER_ID;
      const flow = await initializeRegionalOAuth(provider, pollToken, controller.signal);
      controller.signal.throwIfAborted();
      if (!this.repo.ownsLoginAttempt(nonce, expected))
        throw new Error("OAuth session was superseded");
      const currentOrigin = this.runtime.getCurrentOrigin();
      const appReturnTo = options.appReturnTo ?? this.runtime.getCurrentHref();
      const redirectUri = buildWebRemoteOAuthRedirectUri(
        options.redirectUri ?? this.config.redirectUri,
        appReturnTo,
        { currentOrigin },
      );
      const safeReturnTo = resolveSafeAppReturnTo(appReturnTo, { currentOrigin });
      // Bug 原因：3.18 用 window.open 打开授权新标签、原页内存轮询。App 内置浏览器里弹窗为 null、
      // 替换当前页或原页后台暂停，登录失败。改为同页跳转：flow 记入同源 pending，回调页继续完成；
      // 只改 redirect_uri，授权站、client_id、state 仍用服务端返回值。
      this.repo.savePendingLogin({
        nonce,
        provider,
        redirectUri,
        expectedSession: expected,
        ...(safeReturnTo ? { appReturnTo: safeReturnTo } : {}),
        regional: {
          flowId: flow.flowId,
          pollToken,
          state: flow.state,
          intervalMs: flow.intervalMs,
          // 剩余寿命按服务端 server_time 算出；截止时间换成本机时钟，回调页用同一时钟比较。
          deadline: Date.now() + flow.lifetimeMs,
        },
      });
      const authorizeUrl = new URL(flow.authorizeUrl);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      navigated = true;
      this.runtime.assign(authorizeUrl.toString());
    } finally {
      options.signal?.removeEventListener("abort", abort);
      if (this.loginController === controller) this.loginController = null;
      if (!navigated) {
        // 跳转前取消或失败：本次 pending 与 attempt 一起作废，不留给回调页。
        this.repo.takePendingLogin(nonce);
        await this.repo.finishLoginAttempt(nonce);
      }
    }
  }

  private async startLegacyLogin(options: WebAuthLoginOptions): Promise<void> {
    const nonce = this.runtime.createNonce();
    const provider = options.provider ?? ZAI_PROVIDER_ID;
    const appReturnTo = options.appReturnTo ?? this.runtime.getCurrentHref();
    const returnToOptions = { currentOrigin: this.runtime.getCurrentOrigin() };
    const redirectUri = buildWebRemoteOAuthRedirectUri(
      options.redirectUri ?? this.config.redirectUri,
      appReturnTo,
      returnToOptions,
    );
    const expectedSession = await this.repo.beginLoginAttempt(nonce);
    this.repo.savePendingLogin({ nonce, provider, redirectUri, expectedSession });

    const state = buildOAuthState({
      nonce,
      app_return_to: appReturnTo,
      ...(options.devReturnTo
        ? {
            return_to: buildWebRemoteOAuthRedirectUri(
              options.devReturnTo,
              appReturnTo,
              returnToOptions,
            ),
          }
        : {}),
    });

    this.runtime.assign(
      this.provider.buildAuthorizeUrl({
        state,
        provider,
        redirectUri,
      }),
    );
  }

  /** 回调页渲染前调用：失败后“重新登录”回到发起页。只读，不消费 pending。 */
  resolveCallbackReturnTo(url: string): string | null {
    const state = new URL(url).searchParams.get("state")?.trim();
    if (!state) return null;
    const regional = this.repo.findRegionalPendingLogin(state);
    if (regional) return regional.appReturnTo ?? null;
    return resolveSafeAppReturnTo(parseOAuthState(state)?.app_return_to, {
      currentOrigin: this.runtime.getCurrentOrigin(),
    });
  }

  async handleCallback(url: string): Promise<WebAuthCallbackResult | null> {
    const callback = this.provider.parseCallbackParams(url);
    // 区域登录的 state 是服务端 flow state，不是本端编码的 state，先按它找 pending。
    const regionalLogin = this.repo.takeRegionalPendingLogin(callback.state);
    if (regionalLogin?.regional)
      return this.completeRegionalCallback(callback, regionalLogin, regionalLogin.regional);
    const statePayload = parseOAuthState(callback.state);
    if (!statePayload) {
      throw new Error("OAuth state is invalid");
    }

    const returnToUrl = parseOptionalUrl(statePayload.return_to);
    if (returnToUrl && returnToUrl.origin !== this.runtime.getCurrentOrigin()) {
      if (this.config.allowDevReturnToRedirect && isTrustedDevReturnTo(returnToUrl)) {
        const redirectUrl = buildReturnToCallbackUrl(returnToUrl.toString(), {
          ...(callback.code ? { code: callback.code } : {}),
          ...(callback.error ? { error: callback.error } : {}),
          state: callback.state,
        });
        if (redirectUrl) {
          this.runtime.replace(redirectUrl);
          return null;
        }
      }
    }

    if (callback.error) {
      throw new Error(`OAuth login failed: ${callback.error}`);
    }

    if (!callback.code) {
      throw new Error("OAuth callback missing code");
    }

    // provider 与回调地址必须取跳转前记下的那条：authorize 参数名和 token 响应里 access_token
    // 的位置都是 provider 特定的，token 请求也要用授权时的完整回调地址。
    const pendingLogin = this.repo.takePendingLogin(statePayload.nonce);
    if (!pendingLogin) {
      throw new Error("OAuth CSRF 检测失败");
    }
    const { provider, redirectUri, expectedSession } = pendingLogin;
    // 起点快照来自发起时；迟到callback不能重新领取当前会话的写入资格。
    if (!this.repo.ownsLoginAttempt(pendingLogin.nonce, expectedSession))
      throw new Error("OAuth session was superseded");
    const exchange = await this.provider.exchangeToken({
      code: callback.code,
      state: callback.state,
      provider,
      redirectUri,
    });

    const token = exchange.tokenSet.zcodeJwtToken;
    if (
      !token ||
      !(await this.repo.commitPrimarySession(
        {
          provider,
          zcodeJwtToken: token,
          userInfo: exchange.userInfo,
          revision: this.runtime.createNonce(),
          ...(exchange.tokenSet.accessToken
            ? { businessAccessToken: exchange.tokenSet.accessToken }
            : {}),
        },
        expectedSession,
        pendingLogin.nonce,
      ))
    )
      throw new Error("OAuth session was superseded");

    return {
      userInfo: exchange.userInfo,
      appReturnTo: resolveSafeAppReturnTo(statePayload.app_return_to, {
        currentOrigin: this.runtime.getCurrentOrigin(),
      }),
    };
  }

  private async completeRegionalCallback(
    callback: { code?: string; error?: string; state: string },
    pending: PendingOAuthLogin,
    flow: PendingRegionalFlow,
  ): Promise<WebAuthCallbackResult> {
    const controller = new AbortController();
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (callback.error) throw new Error(`OAuth login failed: ${callback.error}`);
      if (!callback.code) throw new Error("OAuth callback missing code");
      // 起点快照来自发起时；跳转期间其他标签的新登录/退出使本次结果作废。
      if (!this.repo.ownsLoginAttempt(pending.nonce, pending.expectedSession))
        throw new Error("OAuth session was superseded");
      const remainingMs = flow.deadline - Date.now();
      if (remainingMs <= 0) throw new Error("OAuth flow expired");
      expiryTimer = setTimeout(
        () => controller.abort(new Error("OAuth flow expired")),
        remainingMs,
      );
      const provider = pending.provider as RegionalOAuthProvider;
      await forwardRegionalOAuthCallback(
        provider,
        callback.code,
        callback.state,
        controller.signal,
      );
      while (true) {
        if (!this.repo.ownsLoginAttempt(pending.nonce, pending.expectedSession))
          throw new Error("OAuth session was superseded");
        const session = await pollRegionalOAuth(
          { flowId: flow.flowId, provider },
          flow.pollToken,
          controller.signal,
        );
        if (session) {
          if (
            !(await this.repo.commitPrimarySession(
              { ...session, provider, revision: pending.nonce },
              pending.expectedSession,
              pending.nonce,
              controller.signal,
            ))
          )
            throw new Error("OAuth session was superseded");
          return { userInfo: session.userInfo, appReturnTo: pending.appReturnTo ?? null };
        }
        await waitForRegionalPoll(flow.intervalMs, controller.signal);
      }
    } finally {
      clearTimeout(expiryTimer);
      await this.repo.finishLoginAttempt(pending.nonce);
    }
  }

  async restoreCachedSession(): Promise<UserInfo | null> {
    return this.repo.loadCachedSession();
  }

  restoreCachedSessionState() {
    return this.repo.loadCachedSessionState();
  }

  subscribeSessionChange(listener: () => void): () => void {
    return this.repo.subscribeSessionChange(listener);
  }

  getSessionRevision(): string | null {
    return this.repo.getSessionRevision();
  }

  getZCodeJwtToken(): string | null {
    return this.repo.loadZCodeJwtToken();
  }

  /** 设备页账号行的展示资料；只读，不参与登录判断。 */
  getActiveAccount(): {
    displayName: string;
    avatarUrl?: string;
    provider: WebOAuthProviderId;
  } | null {
    const account = this.repo.loadActiveAccount();
    if (!account) return null;
    const { userInfo, provider } = account;
    return {
      displayName: userInfo.displayName.trim() || userInfo.username,
      ...(userInfo.avatarUrl ? { avatarUrl: userInfo.avatarUrl } : {}),
      provider,
    };
  }

  async logout(): Promise<void> {
    this.loginController?.abort();
    await this.repo.clearSession();
  }
}

export function createWebAuthService(): WebAuthService {
  return new WebAuthService();
}
