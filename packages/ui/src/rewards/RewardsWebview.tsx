import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildRewardsUrl,
  createRewardsInjectionScript,
  isTrustedRewardsUrl,
  REWARDS_PARTITION,
  resolveRewardsOrigin,
  toZhOrEnLocale,
  ZCODE_ENV,
  type RewardsContext,
} from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import { logger } from "@/logger.js";
import { Button } from "@/components/ui/button.js";
import { EmbeddedWebsiteHeader } from "@/components/EmbeddedWebsiteHeader.js";

export function RewardsWebview({ onClose }: { onClose: () => void }) {
  const { oauthService } = useServices();
  const platform = usePlatform();
  const { intl, locale: uiLocale } = useZCodeIntl();
  // 奖励页是外部网页，只有中英两套；非中文界面语言打开英文页。
  const locale = toZhOrEnLocale(uiLocale);
  const themePreference = useZCodeStore((s) => s.theme);
  const userId = useZCodeStore((s) => s.user?.id ?? null);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  const theme: RewardsContext["theme"] = (
    themePreference === "system" ? systemDark : resolveTheme(themePreference) === "dark"
  )
    ? "zai-dark"
    : "zai-light";
  const env = import.meta.env;
  const policy = { dev: env.DEV, e2e: env.VITE_ZCODE_E2E_STORE_BRIDGE === "1" };
  const [url] = useState(() =>
    buildRewardsUrl(
      resolveRewardsOrigin({
        ...policy,
        env: ZCODE_ENV,
        override:
          typeof env.VITE_REWARDS_WEBVIEW_ORIGIN === "string"
            ? env.VITE_REWARDS_WEBVIEW_ORIGIN
            : undefined,
      }),
      locale,
      theme,
    ),
  );
  const view = useRef<ElectronWebviewTag | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const generation = useRef(0);
  const ready = useRef(false);
  const injectedIdentity = useRef<string | null | undefined>(undefined);
  const authSnapshot = useRef({ fingerprint: "", revision: 0 });
  const latest = useRef({ theme, locale, userId });
  // 读取后的身份比较覆盖 React effect 尚未执行的窗口，不能让旧账号写入新页面。
  latest.current = { theme, locale, userId };
  const [error, setError] = useState(false);
  const [navigation, setNavigation] = useState({ loading: true, back: false, forward: false });
  const inject = useCallback(async () => {
    const element = view.current;
    if (!element || !ready.current) return;
    const epoch = ++generation.current;
    const identity = latest.current.userId;
    try {
      const href = element.getURL();
      if (!isTrustedRewardsUrl(href, policy)) return;
      if (injectedIdentity.current !== identity) {
        // 切账号不能等异步凭据读取完才清旧账号，先撤销当前页面登录态。
        await element.executeJavaScript(
          createRewardsInjectionScript(
            {
              theme: latest.current.theme,
              locale: latest.current.locale,
              auth: {
                status: "anonymous",
                provider: null,
                revision: ++authSnapshot.current.revision,
              },
            },
            {},
            href,
          ),
        );
        injectedIdentity.current = identity;
      }
      const session = identity ? await oauthService.getWebsiteSession() : null;
      const rawProvider = session?.loginProvider;
      const provider: RewardsContext["auth"]["provider"] =
        rawProvider === "zai"
          ? "zai"
          : rawProvider === "zai_cn"
            ? "zai_cn"
            : rawProvider === "bigmodel"
              ? "bigmodel"
              : null;
      const oauth = session?.legacyOAuthToken ?? null;
      const jwt = session?.zcodeJwtToken ?? null;
      const current = await oauthService.getAccountAvailability();
      if (
        view.current !== element ||
        epoch !== generation.current ||
        latest.current.userId !== identity ||
        !ready.current ||
        element.getURL() !== href
      )
        return;
      if (
        current.userId !== (session?.userId ?? null) ||
        current.loginProvider !== (session?.loginProvider ?? null) ||
        (session && current.sessionRevision !== session.sessionRevision)
      ) {
        throw new Error("OAuth session changed during rewards handoff");
      }
      const fingerprint = JSON.stringify([
        identity,
        provider,
        session?.sessionRevision,
        oauth,
        jwt,
      ]);
      if (authSnapshot.current.fingerprint !== fingerprint) {
        authSnapshot.current.fingerprint = fingerprint;
        ++authSnapshot.current.revision;
      }
      const snapshot: RewardsContext = {
        theme: latest.current.theme,
        locale: latest.current.locale,
        auth: {
          provider,
          status: identity && provider && (oauth || jwt) ? "ready" : "anonymous",
          revision: authSnapshot.current.revision,
        },
      };
      await element.executeJavaScript(createRewardsInjectionScript(snapshot, { oauth, jwt }, href));
      if (epoch === generation.current) setError(false);
    } catch {
      if (epoch === generation.current) {
        setError(true);
        logger.warn("[rewards] context injection failed");
      }
    }
  }, [oauthService, policy.dev, policy.e2e]);
  const injectRef = useRef(inject);
  injectRef.current = inject;
  useEffect(() => {
    const subscription = oauthService.onDidChangeSession(() => {
      injectedIdentity.current = undefined;
      void injectRef.current();
    });
    return () => subscription.dispose();
  }, [oauthService]);
  useEffect(() => {
    void inject();
  }, [inject, locale, theme, userId]);
  const attach = useCallback((element: ElectronWebviewTag | null) => {
    cleanup.current?.();
    view.current = element;
    if (!element) return;
    const sync = () =>
      setNavigation((s) => ({ ...s, back: element.canGoBack(), forward: element.canGoForward() }));
    const start = () => {
      ++generation.current;
      ready.current = false;
      setNavigation((s) => ({ ...s, loading: true }));
    };
    const stop = () => {
      sync();
      setNavigation((s) => ({ ...s, loading: false }));
      // Next 语言路由会触发 loading，但同文档导航没有新的 dom-ready；恢复桥接就绪。
      ready.current = true;
      void injectRef.current();
    };
    const loaded = () => {
      ready.current = true;
      sync();
      void injectRef.current();
    };
    const failed = (event: ElectronWebviewDidFailLoadEvent) => {
      if (event.isMainFrame && event.errorCode !== -3) {
        setError(true);
        logger.warn("[rewards] webview load failed", { code: event.errorCode });
      }
    };
    element.addEventListener("dom-ready", loaded);
    element.addEventListener("did-start-loading", start);
    element.addEventListener("did-stop-loading", stop);
    element.addEventListener("did-fail-load", failed);
    cleanup.current = () => {
      ++generation.current;
      // 除显式关闭外，Root 卸载也要撤销凭据；销毁中的 guest 失败可忽略。
      if (ready.current) {
        try {
          void element
            .executeJavaScript(
              createRewardsInjectionScript(
                {
                  theme: latest.current.theme,
                  locale: latest.current.locale,
                  auth: {
                    status: "anonymous",
                    provider: null,
                    revision: ++authSnapshot.current.revision,
                  },
                },
                {},
                element.getURL(),
              ),
            )
            .catch(() => {});
        } catch {
          /* guest 已销毁。 */
        }
      }
      ready.current = false;
      element.removeEventListener("dom-ready", loaded);
      element.removeEventListener("did-start-loading", start);
      element.removeEventListener("did-stop-loading", stop);
      element.removeEventListener("did-fail-load", failed);
    };
  }, []);
  useEffect(
    () => () => {
      cleanup.current?.();
      view.current = null;
    },
    [],
  );
  const close = async () => {
    ++generation.current;
    const element = view.current;
    try {
      if (element && ready.current)
        await element.executeJavaScript(
          createRewardsInjectionScript(
            {
              theme,
              locale,
              auth: { status: "anonymous", provider: null, revision: generation.current },
            },
            {},
            element.getURL(),
          ),
        );
    } catch {
      /* WebView 已销毁时不阻塞关闭。 */
    }
    onClose();
  };
  return (
    <section
      data-testid="rewards-surface"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background pt-12 text-foreground"
    >
      <EmbeddedWebsiteHeader
        title={intl.formatMessage({ id: "rewards.title" })}
        loading={navigation.loading}
        canGoBack={navigation.back}
        canGoForward={navigation.forward}
        onBack={() => view.current?.goBack()}
        onForward={() => view.current?.goForward()}
        onReload={() => view.current?.reload()}
        onClose={() => void close()}
      />
      {error && (
        <div
          role="alert"
          className="mx-auto flex w-full max-w-5xl items-center gap-3 px-6 text-ui-base"
        >
          <span>{intl.formatMessage({ id: "rewards.loadFailed" })}</span>
          <Button
            variant="ghost"
            onClick={() => {
              setError(false);
              view.current?.reload();
            }}
          >
            {intl.formatMessage({ id: "common.refresh" })}
          </Button>
          <Button variant="ghost" onClick={() => void platform.openExternal(url)}>
            {intl.formatMessage({ id: "rewards.openWebsite" })}
          </Button>
        </div>
      )}
      {/* 网页视口必须铺满窗口；限宽交给网站内容，否则滚动条也会被居中内缩。 */}
      <webview
        ref={attach}
        src={url}
        partition={REWARDS_PARTITION}
        className="min-h-0 w-full flex-1 bg-background"
        data-testid="rewards-webview"
      />
    </section>
  );
}
