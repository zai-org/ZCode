/* oxlint-disable eslint(max-lines) */
/**
 * WelcomeScreen —— OAuth / API Key 登录入口
 *
 * 通过 useOAuth hook 驱动 OAuth 流程。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LoaderCircle, TriangleAlertIcon } from "lucide-react";
import {
  type OAuthProviderMeta,
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  ZAI_CN_PROVIDER_ID,
} from "@zcode/shared";
import {
  TID_LOGIN_REGION_SWITCH,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_OAUTH_CANCEL,
  TID_OAUTH_COPY_LOGIN_LINK,
  TID_OAUTH_ERROR,
  TID_OAUTH_LOGIN_BUTTON,
} from "@zcode/shared/test-ids";
import { Alert, AlertDescription } from "./components/ui/alert.js";
import { Button } from "./components/ui/button.js";
import { ZCodeAboutLogo } from "@/components/ui/ZCodeAboutLogo.js";
import { useOAuth } from "./hooks/useOAuth.js";
import { usePlatform } from "./hooks/usePlatform.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { LoginApiKeyForm } from "./login/LoginApiKeyForm.js";
import { ThemeHeroVisual } from "./openWorkspacePageThemeHero.js";
import { useZCodeStore } from "./store/StoreProvider.js";
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";
import { toast } from "@/components/ui/toast.js";
import type { useCredentialStoreRecovery } from "@/hooks/useCredentials.js";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog.js";

export function CredentialStoreRecovery({
  recovery,
}: {
  recovery: ReturnType<typeof useCredentialStoreRecovery>;
}) {
  const { intl } = useZCodeIntl();
  const [confirming, setConfirming] = useState(false);
  const text = (id: Parameters<typeof intl.formatMessage>[0]["id"]) => intl.formatMessage({ id });
  return (
    <main
      data-testid="credential-store-recovery"
      className="relative flex min-h-dvh items-center justify-center bg-background p-4 text-foreground"
    >
      <DesktopOverlayWindowControls />
      <section className="w-full max-w-md space-y-4 rounded-2xl border border-popover-border bg-background p-6 text-ui-base shadow-md">
        <h1 className="text-ui-lg font-semibold">{text("login.credentialStore.title")}</h1>
        <p className="text-foreground-subtle">
          {text(
            recovery.state?.status === "recovered"
              ? "login.credentialStore.done"
              : recovery.state?.status === "changed"
                ? "login.credentialStore.changed"
                : "login.credentialStore.description",
          )}
        </p>
        {recovery.state?.status === "recovered" && (
          <p className="break-all text-ui-sm text-foreground-subtle">{recovery.state.backupPath}</p>
        )}
        {recovery.failed && (
          <Alert variant="destructive" data-testid="credential-store-recovery-error">
            <AlertDescription>{text("login.credentialStore.failed")}</AlertDescription>
          </Alert>
        )}
        {recovery.state?.status === "corrupt" ? (
          <Button
            data-testid="credential-store-recovery-open"
            disabled={recovery.busy}
            onClick={() => setConfirming(true)}
          >
            {text("login.credentialStore.restore")}
          </Button>
        ) : (
          <Button
            data-testid="credential-store-recovery-reload"
            onClick={() => window.location.reload()}
          >
            {text("login.credentialStore.reload")}
          </Button>
        )}
      </section>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!recovery.busy) setConfirming(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{text("login.credentialStore.restore")}</AlertDialogTitle>
            <AlertDialogDescription>{text("login.credentialStore.confirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="credential-store-recovery-cancel"
              disabled={recovery.busy}
            >
              {text("common.cancel")}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              data-testid="credential-store-recovery-confirm"
              disabled={recovery.busy}
              onClick={async () => {
                await recovery.recover();
                setConfirming(false);
              }}
            >
              {text("login.credentialStore.restore")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

const LOGIN_TERMS_URL = "https://zcode.z.ai/terms";
const LOGIN_PRIVACY_URL = "https://zcode.z.ai/privacy";

interface WelcomeScreenProps {
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
}

export type LoginCompleteReason = "oauth" | "apiKey" | "skip";

/** 登录页区域展示态；真实区域路由等 Z.ai 国内一方登录 provider 就绪后再接入。 */
type SingleLoginRegion = "domestic" | "global";

/** 区域展示态跟随界面语言：英文默认海外，中文默认国内。 */
export function resolveLoginRegionForLocale(locale: string): SingleLoginRegion {
  return locale === "en-US" ? "global" : "domestic";
}

export function WelcomeScreen({ onComplete }: WelcomeScreenProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  return (
    <main className="relative h-full min-h-dvh overflow-hidden bg-background text-foreground">
      <ThemeHeroVisual className="absolute inset-0" />
      {/* 原生拖拽命中不受 pointer-events/z-index 约束；拖拽层必须避开窗控，且先于 no-drag 区声明。 */}
      <div className="pointer-events-none absolute left-0 top-0 right-0 z-10 flex h-12 items-center [app-region:drag] platform-windows-desktop:right-[134px] platform-linux-desktop:right-[134px]" />
      <DesktopOverlayWindowControls />
      {/* 矮窗口展开表单时，绝对定位的协议会盖住操作区；同一滚动布局保证两者可达，窗控仍在外层。 */}
      <div className="relative z-10 flex h-dvh flex-col items-center overflow-y-auto px-4 pb-6 pt-14 sm:px-6">
        <div className="flex w-full flex-1 shrink-0 items-center justify-center py-6">
          <section className="flex w-full max-w-sm shrink-0 flex-col gap-7 rounded-2xl bg-background p-8 text-ui-base/relaxed shadow-md sm:p-10">
            <LoginPanel active onComplete={onComplete} />
          </section>
        </div>
        <footer className="pointer-events-none flex shrink-0 flex-col items-center gap-2 text-center text-ui-xs text-foreground-subtle">
          <p className="flex flex-wrap items-center justify-center gap-x-1">
            <span>{intl.formatMessage({ id: "login.agreement.prefix" })}</span>
            <button
              type="button"
              className="pointer-events-auto rounded-sm underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                void platform.openExternal(LOGIN_TERMS_URL);
              }}
            >
              {intl.formatMessage({ id: "login.agreement.terms" })}
            </button>
            <span>{intl.formatMessage({ id: "login.agreement.conjunction" })}</span>
            <button
              type="button"
              className="pointer-events-auto rounded-sm underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                void platform.openExternal(LOGIN_PRIVACY_URL);
              }}
            >
              {intl.formatMessage({ id: "login.agreement.privacy" })}
            </button>
          </p>
          <p>{intl.formatMessage({ id: "login.copyright" })}</p>
        </footer>
      </div>
    </main>
  );
}

interface LoginPanelProps {
  active: boolean;
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
}

interface ActiveLoginEntryAttempt {
  id: number;
  providerId: OAuthProviderMeta["id"];
}

export function shouldCompleteProviderLoginAttempt(params: {
  attempt: ActiveLoginEntryAttempt | null;
  successProvider: OAuthProviderMeta["id"] | null;
}): boolean {
  return !params.attempt || params.successProvider === params.attempt.providerId;
}

export function shouldCompleteLoginFromExistingUser(params: {
  hasUser: boolean;
  attempt: ActiveLoginEntryAttempt | null;
}): boolean {
  return params.hasUser && !params.attempt;
}

export function LoginPanel({ active, onComplete }: LoginPanelProps) {
  const { intl, locale, setLocalePreference } = useZCodeIntl();
  const {
    startLogin,
    cancel,
    reset,
    status,
    error,
    providers,
    loadingProviders,
    pendingProvider,
    authorizeUrl,
    refreshProviders,
  } = useOAuth();
  const user = useZCodeStore((s) => s.user);
  const oauthError = useZCodeStore((s) => s.oauthError);
  const setOAuthError = useZCodeStore((s) => s.setOAuthError);
  const oauthSuccessSeq = useZCodeStore((s) => s.oauthSuccessSeq);
  const lastOAuthSuccessProvider = useZCodeStore((s) => s.lastOAuthSuccessProvider);
  const loginEntryRequest = useZCodeStore((s) => s.loginEntryRequest);
  const clearLoginEntryRequest = useZCodeStore((s) => s.clearLoginEntryRequest);
  const markLoginEntryAttemptStatus = useZCodeStore((s) => s.markLoginEntryAttemptStatus);
  const [loginMode, setLoginMode] = useState<"providers" | "apiKey">("providers");
  const [loginRegion, setLoginRegion] = useState<SingleLoginRegion>(() =>
    resolveLoginRegionForLocale(locale),
  );
  const loginRegionUserSelectedRef = useRef(false);
  const wasActiveRef = useRef(active);
  const consumedLoginRequestRef = useRef<number | null>(null);
  const observedOAuthSuccessSeqRef = useRef(oauthSuccessSeq);
  const lastAttemptProviderRef = useRef<OAuthProviderMeta["id"] | null>(null);
  const activeLoginEntryAttemptRef = useRef<ActiveLoginEntryAttempt | null>(null);
  const shownLoginErrorRef = useRef<string | null>(null);

  const finishActiveLoginEntryAttempt = useCallback(
    (status: "succeeded" | "cancelled" | "failed") => {
      const attempt = activeLoginEntryAttemptRef.current;
      if (!attempt) {
        return;
      }
      activeLoginEntryAttemptRef.current = null;
      markLoginEntryAttemptStatus(attempt.id, status);
    },
    [markLoginEntryAttemptStatus],
  );

  const startTrackedLogin = useCallback(
    (
      provider: OAuthProviderMeta["id"],
      options?: Parameters<typeof startLogin>[1],
      loginEntryAttemptId?: number,
    ) => {
      const activeAttempt = activeLoginEntryAttemptRef.current;
      if (activeAttempt && activeAttempt.id !== loginEntryAttemptId) {
        // 用户在统一登录页开始另一条登录流程时，旧购买意图不能继续等待。
        finishActiveLoginEntryAttempt("cancelled");
      }
      // 上一次失败遗留的 store oauthError 若不清掉，新流程进入等待态后
      // 失败提示会和等待提示同屏（如失败后关闭登录入口，再从设置页自动续接登录）。
      shownLoginErrorRef.current = null;
      setOAuthError(null);
      if (loginEntryAttemptId !== undefined) {
        activeLoginEntryAttemptRef.current = {
          id: loginEntryAttemptId,
          providerId: provider,
        };
        markLoginEntryAttemptStatus(loginEntryAttemptId, "waiting");
      }
      lastAttemptProviderRef.current = provider;
      return startLogin(provider, options);
    },
    [finishActiveLoginEntryAttempt, markLoginEntryAttemptStatus, setOAuthError, startLogin],
  );

  const visibleProviders = useMemo(() => resolveVisibleLoginProviders(providers), [providers]);
  const loginProvider = useMemo(
    () => resolveSingleLoginProvider(visibleProviders, loginRegion),
    [visibleProviders, loginRegion],
  );

  // 语言可能在挂载后才解析完成（如 system 偏好）；用户未手动切换区域前，让区域跟随语言。
  useEffect(() => {
    if (loginRegionUserSelectedRef.current) {
      return;
    }
    setLoginRegion(resolveLoginRegionForLocale(locale));
  }, [locale]);

  useEffect(() => {
    if (active) {
      void refreshProviders();
    }
  }, [active, refreshProviders]);

  useEffect(() => {
    if (
      !active ||
      !loginEntryRequest?.providerId ||
      consumedLoginRequestRef.current === loginEntryRequest.id
    ) {
      return;
    }

    consumedLoginRequestRef.current = loginEntryRequest.id;
    clearLoginEntryRequest(loginEntryRequest.id);
    // Model Provider 的登录/连接入口以前绕过统一登录入口直接发起 OAuth，
    // 导致用户看不到统一的等待、取消和错误状态。这里在 WelcomeScreen 打开后自动启动指定 provider，
    // 复用登录入口的 loading 流程，同时用 request id 防止 React 严格模式下重复发起。
    void startTrackedLogin(
      loginEntryRequest.providerId,
      {
        purpose: loginEntryRequest.purpose,
      },
      loginEntryRequest.id,
    );
  }, [active, clearLoginEntryRequest, loginEntryRequest, startTrackedLogin]);

  // Root 层 OAuth 回调失败时写入 Zustand oauthError，统一登录入口负责显示错误。
  useEffect(() => {
    if (oauthError && active) {
      finishActiveLoginEntryAttempt("failed");
      reset(); // 重置 useOAuth 的 waiting 状态
      // oauthError 已在 store 中，下方 UI 会读取并显示
    }
  }, [active, finishActiveLoginEntryAttempt, oauthError, reset]);

  useEffect(() => {
    if (active && status === "error") {
      finishActiveLoginEntryAttempt("failed");
    }
  }, [active, finishActiveLoginEntryAttempt, status]);

  // 登录失败统一用全局 toast：提示不占用登录卡片布局，卡片内只保留重试/取消操作。
  // 同一条消息只弹一次；重新发起登录时清空去重标记，允许同一错误再次提示。
  useEffect(() => {
    if (!active) {
      return;
    }
    const message = oauthError || (status === "error" ? error : null);
    if (!message || shownLoginErrorRef.current === message) {
      return;
    }
    shownLoginErrorRef.current = message;
    toast(message);
  }, [active, error, oauthError, status]);

  // OAuth 回调成功后 Root 层设置 user，统一登录入口自动关闭。
  useEffect(() => {
    if (
      active &&
      shouldCompleteLoginFromExistingUser({
        hasUser: Boolean(user),
        attempt: activeLoginEntryAttemptRef.current,
      })
    ) {
      // 全局 user 可能来自另一个 Provider，不能把刚发起的购买登录
      // 误判为成功；Provider-specific attempt 只由匹配的 OAuth success 完成。
      reset();
      setOAuthError(null);
      void onComplete("oauth");
    }
  }, [active, finishActiveLoginEntryAttempt, onComplete, reset, setOAuthError, user]);

  useEffect(() => {
    if (!active) {
      observedOAuthSuccessSeqRef.current = oauthSuccessSeq;
      return;
    }

    if (oauthSuccessSeq > observedOAuthSuccessSeqRef.current) {
      observedOAuthSuccessSeqRef.current = oauthSuccessSeq;
    } else {
      return;
    }

    if (
      status === "waiting" &&
      shouldCompleteProviderLoginAttempt({
        attempt: activeLoginEntryAttemptRef.current,
        successProvider: lastOAuthSuccessProvider,
      })
    ) {
      // provider connection 复用同一个登录入口视觉流程，
      // 但成功后不会写 App user；这里用 Root 的成功信号关闭登录入口，保持用户交互不变。
      finishActiveLoginEntryAttempt("succeeded");
      reset();
      setOAuthError(null);
      void onComplete("oauth");
    }
  }, [
    active,
    finishActiveLoginEntryAttempt,
    lastOAuthSuccessProvider,
    oauthSuccessSeq,
    onComplete,
    reset,
    setOAuthError,
    status,
  ]);

  const resetApiKeyForm = useCallback(() => {
    setLoginMode("providers");
  }, []);

  const handleCopyLoginLink = useCallback(async () => {
    if (!authorizeUrl || typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(intl.formatMessage({ id: "login.oauth.copyLinkFailed" }));
      return;
    }

    try {
      await navigator.clipboard.writeText(authorizeUrl);
      toast(intl.formatMessage({ id: "login.oauth.copyLinkSuccess" }));
    } catch {
      toast(intl.formatMessage({ id: "login.oauth.copyLinkFailed" }));
    }
  }, [authorizeUrl, intl]);

  useEffect(() => {
    if (active) {
      wasActiveRef.current = true;
      return;
    }

    if (!wasActiveRef.current) {
      return;
    }
    wasActiveRef.current = false;

    if (status === "waiting") {
      void cancel(pendingProvider ?? undefined);
    }
    finishActiveLoginEntryAttempt("cancelled");
    reset();
    setOAuthError(null);
    clearLoginEntryRequest();
    resetApiKeyForm();
  }, [
    active,
    cancel,
    clearLoginEntryRequest,
    finishActiveLoginEntryAttempt,
    pendingProvider,
    reset,
    resetApiKeyForm,
    setOAuthError,
    status,
  ]);

  return (
    <>
      <LoginPanelHeader
        title={intl.formatMessage({ id: "login.title" })}
        description={intl.formatMessage({ id: "login.description" })}
      >
        {null}
      </LoginPanelHeader>

      {/* idle → waiting 会整体替换操作区，而等待态比按钮列表矮；页面垂直居中时
          卡片会先缩小、授权链接出现后再变高，表现为点击登录时抖动。
          固定状态区最小高度，让卡片外框在切换期间保持稳定。 */}
      <div className="min-h-36 space-y-6">
        {/* Bugfix: Root 层写入 oauthError（轮询/回调失败）后 effect 会把 useOAuth reset 回 idle，
            若只判断 status==="idle" 会让失败块和渠道按钮列表同屏、状态纠缠。
            失败期间统一由下方失败块接管（重新登录/取消），渠道列表等错误清掉后再回来。 */}
        {status === "idle" && !oauthError && loginMode === "providers" && (
          <div className="space-y-4">
            {loadingProviders ? (
              <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-6 text-ui-base text-foreground-subtle">
                <LoaderCircle className="size-4 animate-spin" />
                {intl.formatMessage({ id: "login.oauth.loadingProviders" })}
              </div>
            ) : null}

            {!loadingProviders && !loginProvider ? (
              <Alert
                variant="warning"
                className="flex items-center justify-center gap-2 text-center"
                data-testid={TID_OAUTH_ERROR}
              >
                <TriangleAlertIcon className="size-4" />
                <AlertDescription className="text-center">
                  {intl.formatMessage({ id: "login.oauth.noProviders" })}
                </AlertDescription>
              </Alert>
            ) : null}

            {!loadingProviders ? (
              <div className="flex flex-col items-center">
                <Button
                  variant="default"
                  className="h-11 w-full rounded-lg text-ui-base font-medium"
                  size="lg"
                  data-testid={TID_OAUTH_LOGIN_BUTTON}
                  disabled={!loginProvider}
                  onClick={() => {
                    if (loginProvider) void startTrackedLogin(loginProvider);
                  }}
                >
                  <span className="min-w-0 truncate">
                    {intl.formatMessage({ id: "login.singleLogin.browserButton" })}
                  </span>
                </Button>
                <Button
                  variant="outline"
                  className="mt-2.5 h-10 w-full rounded-lg text-ui-base font-medium"
                  size="lg"
                  data-testid={TID_LOGIN_USE_API_KEY_BUTTON}
                  onClick={() => {
                    setLoginMode("apiKey");
                  }}
                >
                  {intl.formatMessage({ id: "login.useApiKey" })}
                </Button>
                {/* 当前区域停用时仍保留切换入口，不能把用户锁在不可用区域。 */}
                <div className="mt-4 flex h-7 w-full items-center justify-center">
                  <button
                    type="button"
                    className="rounded-md px-2 text-ui-sm text-foreground-subtle underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid={TID_LOGIN_REGION_SWITCH}
                    onClick={() => {
                      const nextRegion = loginRegion === "domestic" ? "global" : "domestic";
                      // 用户手动切换后，区域不再跟随后续语言变化。
                      loginRegionUserSelectedRef.current = true;
                      setLoginRegion(nextRegion);
                      // 区域切换与界面语言联动：国内入口使用中文，海外入口使用英文。
                      setLocalePreference(nextRegion === "domestic" ? "zh-CN" : "en-US");
                    }}
                  >
                    {intl.formatMessage({
                      id:
                        loginRegion === "domestic"
                          ? "login.singleLogin.switchToGlobal"
                          : "login.singleLogin.switchToDomestic",
                    })}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {status === "idle" && loginMode === "apiKey" ? (
          <LoginApiKeyForm
            onCancel={() => setLoginMode("providers")}
            onSaved={() => {
              resetApiKeyForm();
              return onComplete("apiKey");
            }}
            onSkipped={() => {
              resetApiKeyForm();
              return onComplete("skip");
            }}
          />
        ) : null}

        {status === "waiting" && (
          <div className="flex flex-col">
            <div className="flex h-11 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-2 text-ui-base text-foreground-subtle">
              <LoaderCircle className="size-4 animate-spin" />
              {intl.formatMessage({ id: "login.singleLogin.waiting" })}
            </div>
            <Button
              variant="outline"
              className="mt-2.5 h-10 w-full text-ui-base"
              size="lg"
              data-testid={TID_OAUTH_CANCEL}
              onClick={() => {
                // OAuth 等待态里的“取消”只应取消浏览器授权等待，
                // 不能关闭整个登录入口，否则用户需要重新从入口打开才能换登录方式。
                finishActiveLoginEntryAttempt("cancelled");
                void cancel(pendingProvider ?? undefined);
              }}
            >
              {intl.formatMessage({ id: "login.oauth.cancel" })}
            </Button>
            {/* 第三行固定占位，授权链接晚到时只替换内容，不改变卡片高度和按钮位置。 */}
            <div className="mt-4 flex h-7 items-center justify-center gap-1 text-center text-ui-sm text-foreground-subtle">
              {authorizeUrl ? (
                <>
                  <span>{intl.formatMessage({ id: "login.oauth.browserNotOpened" })}</span>
                  <button
                    type="button"
                    className="font-medium text-brand underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid={TID_OAUTH_COPY_LOGIN_LINK}
                    onClick={() => void handleCopyLoginLink()}
                  >
                    {intl.formatMessage({ id: "login.oauth.copyLoginLink" })}
                  </button>
                </>
              ) : null}
            </div>
          </div>
        )}

        {(status === "error" || oauthError) && (
          // 错误文案已改为全局 toast；这里只保留失败态操作，test id 继续标记失败状态。
          <div className="space-y-4" data-testid={TID_OAUTH_ERROR}>
            <Button
              className="h-10 w-full text-ui-base"
              size="lg"
              onClick={() => {
                const retryProvider = resolveLoginRetryProvider({
                  pendingProvider,
                  lastAttemptProvider: lastAttemptProviderRef.current,
                  providers: visibleProviders,
                });
                if (!retryProvider) {
                  return;
                }
                // OAuth 回调失败会触发 reset()，它会清空 pendingProvider。
                // 重新登录必须沿用刚才失败的渠道；没有记录时回到当前选中的区域。
                // store 残留错误由 startTrackedLogin 发起前统一清理。
                void startTrackedLogin(retryProvider);
              }}
            >
              {intl.formatMessage({ id: "login.oauth.retry" })}
            </Button>
            <Button
              variant="outline"
              className="h-10 w-full text-ui-base"
              size="lg"
              data-testid={TID_OAUTH_CANCEL}
              onClick={() => {
                // 失败态不能只有「重新登录」沿原渠道重试：想换渠道只能关闭
                // 登录入口重开，容易在同一条失败链路上反复失败。这里对齐等待态取消的
                // 语义：结束本次失败流程回到渠道列表，登录入口不关闭。
                finishActiveLoginEntryAttempt("cancelled");
                setOAuthError(null);
                void cancel(pendingProvider ?? undefined);
              }}
            >
              {intl.formatMessage({ id: "login.oauth.cancel" })}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function LoginPanelHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <header className="flex flex-col items-center gap-4 text-center">
      <LoginPanelLogo />
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-ui-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-ui-base/relaxed text-foreground-subtle">{description}</p>
      </div>
      {children}
    </header>
  );
}

function LoginPanelLogo() {
  return (
    // 登录 logo 壳是固定深色底，边框不能跟随浅色主题 token，否则浅色主题下边框过重。
    <div
      className="relative flex size-16 items-center justify-center rounded-2xl bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] text-[#ffffff] shadow-lg/20 before:pointer-events-none before:absolute before:inset-0 before:rounded-2xl before:border before:border-[rgba(255,255,255,0.1)]"
      aria-label="ZCode"
      role="img"
    >
      <ZCodeAboutLogo className="h-auto w-10" />
    </div>
  );
}

function getProviderPriority(provider: OAuthProviderMeta): number {
  switch (provider.id) {
    // 保持内置 provider 的稳定顺序；登录入口固定取 Z.ai，其余 provider 只服务于显式连接请求。
    case ZAI_PROVIDER_ID:
      return 0;
    case BIGMODEL_PROVIDER_ID:
      return 1;
    default:
      return 10 + provider.order;
  }
}

export function resolveVisibleLoginProviders(providers: OAuthProviderMeta[]): OAuthProviderMeta[] {
  // 保持 Z.ai 在前、BigModel 在后的稳定顺序。
  return [...providers].sort((left, right) => {
    return getProviderPriority(left) - getProviderPriority(right);
  });
}

export function resolveSingleLoginProvider(
  providers: OAuthProviderMeta[],
  region: SingleLoginRegion,
): OAuthProviderMeta["id"] | null {
  const providerId = region === "domestic" ? ZAI_CN_PROVIDER_ID : ZAI_PROVIDER_ID;
  return providers.find((provider) => provider.id === providerId && provider.enabled)?.id ?? null;
}

export function resolveLoginRetryProvider({
  pendingProvider,
  lastAttemptProvider,
  providers,
}: {
  pendingProvider: OAuthProviderMeta["id"] | null;
  lastAttemptProvider: OAuthProviderMeta["id"] | null;
  providers: OAuthProviderMeta[];
}): OAuthProviderMeta["id"] | null {
  return pendingProvider ?? lastAttemptProvider ?? providers[0]?.id ?? null;
}
