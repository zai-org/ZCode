/* oxlint-disable eslint(max-lines) -- Coding Plan webview 容器集中维护凭据注入、购买完成回传、三方支付导航和错误兜底。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useServices } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { RENDERER_ZCODE_ENDPOINT_URLS } from "@/lib/rendererZCodeEndpoint.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { EmbeddedWebsiteHeader } from "@/components/EmbeddedWebsiteHeader.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { normalizeThemePreference, resolveTheme } from "@/useTheme.js";
import type { CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";
import type { CodingPlanFunnelContext } from "@/lib/codingPlanFunnelTelemetry.js";
import {
  buildCodingPlanEmbeddedWebviewUrl,
  buildCodingPlanEmbeddedReportContext,
  createCodingPlanAuthInjectionScript,
  createCodingPlanCredentialClearScript,
  createCodingPlanLangInjectionScript,
  createCodingPlanScrollbarHideScript,
  isTrustedCodingPlanEmbeddedWebviewUrl,
  resolveCodingPlanEmbeddedOrigin,
  resolveCodingPlanWebsiteProvider,
  type CodingPlanEmbeddedCredentials,
  type CodingPlanEmbeddedTheme,
  type CodingPlanPurchaseAudience,
  CODING_PLAN_WEBVIEW_OVERRIDE_ENV_KEY,
} from "@/settings/model-provider-section/codingPlanEmbeddedWebview.js";
import {
  CodingPlanWebviewChannels,
  type CodingPlanPurchaseCompletePayload,
  ZCODE_ENV,
  ZCODE_VERSION,
  toZhOrEnLocale,
} from "@zcode/shared";

interface CodingPlanEmbeddedWebviewDialogProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onOpenResult?: (opened: boolean) => void;
  providerId: CodingPlanProviderId;
  funnelContext?: CodingPlanFunnelContext | null;
  audience?: CodingPlanPurchaseAudience;
  teamPlanKey?: string | null;
  /**
   * 官网页购买成功后的回调。
   *
   * 官网页通过 preload 注入的 window.zcodeBridge.notifyPurchaseComplete({ provider })
   * 发送 zcode:coding-plan-purchase-complete 频道消息，本组件在 webview 的
   * ipc-message 事件里识别该频道并触发此回调（经 onPurchaseCompleteRef 防 stale closure）。
   * 上层（CodingPlanUpgradeDialog）在此回调里刷新 entitlements/providers 并关闭 webview。
   */
  onPurchaseComplete?: () => void;
}

interface CodingPlanWebviewImportMetaEnv {
  DEV?: boolean;
  VITE_CODING_PLAN_WEBVIEW_ORIGIN?: string;
  VITE_ZCODE_E2E_STORE_BRIDGE?: string;
}

interface CodingPlanWebviewNavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}

function readCodingPlanWebviewImportMetaEnv(): CodingPlanWebviewImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: CodingPlanWebviewImportMetaEnv }).env ??
    {}) as CodingPlanWebviewImportMetaEnv;
}

export function CodingPlanEmbeddedWebviewDialog({
  onOpenChange,
  open,
  providerId,
  funnelContext,
  audience,
  teamPlanKey,
  onPurchaseComplete,
  onOpenResult,
}: CodingPlanEmbeddedWebviewDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const { oauthService } = useServices();
  const authGeneration = useRef(0);
  const platform = usePlatform();
  const theme = useZCodeStoreWithDefault((state) => state.theme, "zai-dark");
  const userId = useZCodeStoreWithDefault((state) => state.user?.id ?? null, null);
  const webviewRef = useRef<ElectronWebviewTag | null>(null);
  const onOpenResultRef = useRef(onOpenResult);
  onOpenResultRef.current = onOpenResult;
  // 当前 locale 作为 webview 语言 hint / 注入值。官网只有中英两套，非中文界面语言走英文。
  const webviewLocale = toZhOrEnLocale(locale);
  const webviewCleanupRef = useRef<(() => void) | null>(null);
  // webview 是否已 dom-ready：executeJavaScript 只在 ready 后调用，
  // 否则会抛 "WebView must be attached to the DOM and dom-ready emitted"。
  const webviewReadyRef = useRef(false);
  const frozenWebviewUrlRef = useRef<string | null>(null);
  const injectAuthRef = useRef<(webview: ElectronWebviewTag | null) => Promise<void>>(
    async () => {},
  );
  // onPurchaseComplete 通过 ref 在 ref callback / 事件监听器里访问，避免 stale closure
  // （handleWebviewRef 用 useCallback([],) 只绑定一次事件，不依赖 onPurchaseComplete 最新值）。
  const onPurchaseCompleteRef = useRef<(() => void) | undefined>(onPurchaseComplete);
  useEffect(() => {
    onPurchaseCompleteRef.current = onPurchaseComplete;
  }, [onPurchaseComplete]);
  const [authError, setAuthError] = useState<string | null>(null);
  // loadError: webview 加载失败/崩溃时的兜底态。
  // 按用户决策，webview 不可用时只报错并引导去官网购买，不回退到老 Dialog。
  const [loadError, setLoadError] = useState<string | null>(null);
  const [navigationState, setNavigationState] = useState<CodingPlanWebviewNavigationState>({
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
  });
  const provider = resolveCodingPlanWebsiteProvider(providerId);
  const embeddedTheme: CodingPlanEmbeddedTheme =
    normalizeThemePreference(theme) === "zai-dark" || resolveTheme(theme) === "dark"
      ? "zai-dark"
      : "zai-light";
  const computedWebviewUrl = useMemo(() => {
    const env = readCodingPlanWebviewImportMetaEnv();
    const origin = resolveCodingPlanEmbeddedOrigin({
      dev: env.DEV === true,
      endpointOrigin: RENDERER_ZCODE_ENDPOINT_URLS.origin,
      e2eStoreBridgeEnabled: env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      overrideOrigin: env.VITE_CODING_PLAN_WEBVIEW_ORIGIN,
      zcodeEnv: ZCODE_ENV,
    });
    // URL 带 ?lang= hint 让官网首屏就有正确语言，避免注入前的英文闪烁。
    // 同步带 ?theme= hint，避免官网 SSR 默认 dark 在 App 浅色主题下首帧闪烁。
    return buildCodingPlanEmbeddedWebviewUrl({
      origin,
      provider,
      locale: webviewLocale,
      theme: embeddedTheme,
      audience,
      teamPlanKey,
    });
  }, [audience, embeddedTheme, provider, teamPlanKey, webviewLocale]);
  if (open && frozenWebviewUrlRef.current === null) {
    // theme=system 会随 OS 自动切换，若 src 跟着变化会重载正在授权的 PayPal 页面。
    // Dialog 一次打开生命周期只固定首帧 hint，运行时 theme 仍通过 auth 注入脚本同步给官网。
    frozenWebviewUrlRef.current = computedWebviewUrl;
  } else if (!open && frozenWebviewUrlRef.current !== null) {
    frozenWebviewUrlRef.current = null;
  }
  const webviewUrl = frozenWebviewUrlRef.current ?? computedWebviewUrl;

  const injectAuth = useCallback(
    async (webview: ElectronWebviewTag | null = webviewRef.current) => {
      if (!webview) {
        return;
      }
      const generation = ++authGeneration.current;
      setAuthError(null);
      try {
        const env = readCodingPlanWebviewImportMetaEnv();
        const currentUrl = typeof webview.getURL === "function" ? webview.getURL() : "";
        if (
          !isTrustedCodingPlanEmbeddedWebviewUrl(currentUrl, {
            e2eStoreBridgeEnabled: env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
          })
        ) {
          // dom-ready 会在后续主 frame 导航时再次触发，初始 src 可信不代表
          // 当前页面仍是官网购买页。离开可信页后只能做本 origin 清理，不能注入 App 凭据。
          await webview.executeJavaScript(createCodingPlanCredentialClearScript(), true);
          return;
        }
        // 持久分区先撤销旧会话，再等待 Host 的原子快照，避免多个单键读取拼接账号。
        await webview.executeJavaScript(createCodingPlanCredentialClearScript(), true);
        const [session, deviceMid] = await Promise.all([
          oauthService.getWebsiteSession(),
          Promise.resolve()
            .then(() => platform.getDeviceId())
            .catch(() => null),
        ]);
        const current = await oauthService.getAccountAvailability();
        if (
          generation !== authGeneration.current ||
          webviewRef.current !== webview ||
          webview.getURL() !== currentUrl ||
          !webviewReadyRef.current
        )
          return;
        if (
          current.userId !== (session?.userId ?? null) ||
          current.loginProvider !== (session?.loginProvider ?? null) ||
          (session && current.sessionRevision !== session.sessionRevision)
        ) {
          // 资料补全也可能推进代次；拒绝旧材料后显示已有重试入口，不能静默停在空白页。
          throw new Error("OAuth session changed during website handoff");
        }
        const credentials: CodingPlanEmbeddedCredentials = {
          zcodeJwtToken: session?.zcodeJwtToken,
          zaiAccessToken:
            session?.loginProvider === "zai" && provider === "zai"
              ? session.legacyOAuthToken
              : null,
          bigmodelAccessToken:
            session?.loginProvider === "bigmodel" && provider === "bigmodel"
              ? session.legacyOAuthToken
              : null,
        };
        const reportContext = buildCodingPlanEmbeddedReportContext({
          funnelContext,
          deviceMid,
          userId: session?.userId,
          appVersion: ZCODE_VERSION,
        });
        const script = createCodingPlanAuthInjectionScript({
          provider,
          credentials,
          theme: embeddedTheme,
          locale: webviewLocale,
          reportContext,
          loginProvider: session?.loginProvider ?? null,
          expectedUrl: currentUrl,
        });
        // webview 使用持久 partition，provider/account 切换时不能让旧 token
        // 短暂残留在 localStorage 里被官网首屏逻辑读到。注入前先清敏感 key，再写当前凭据。
        await webview.executeJavaScript(
          `${createCodingPlanCredentialClearScript()};\n${script}`,
          true,
        );
      } catch (error) {
        // WebView 和 App renderer 是不同存储分区，官网页不能直接读 App credentialService。
        // 注入失败时必须给出可重试状态，否则页面会停留在未登录/骨架态且用户无法恢复。
        if (generation !== authGeneration.current) return;
        setAuthError(error instanceof Error ? error.message : String(error));
        logger.warn("[CodingPlanEmbeddedWebviewDialog] 注入购买凭据失败", {
          provider,
          error,
        });
      }
    },
    [oauthService, embeddedTheme, funnelContext, platform, provider, userId, webviewLocale],
  );

  // App locale 运行时变化时，对已 dom-ready 的 webview 注入 lang 更新脚本，
  // 让官网无感切换语言（webviewUrl 变化会整页 reload，这里处理「同一页面内 locale 变了」的场景）。
  // webview 未 dom-ready 时跳过：dom-ready 后的 auth 注入脚本本身会带最新 locale，
  // 无需在这里提前注入（提前 executeJavaScript 会抛 attach/dom-ready 错误）。
  useEffect(() => {
    if (!open) return;
    if (!webviewReadyRef.current) return;
    const webview = webviewRef.current;
    if (!webview) return;
    const script = createCodingPlanLangInjectionScript(webviewLocale);
    void webview.executeJavaScript(script, true).catch(() => {
      // webview 已销毁时 executeJavaScript 会拒绝，静默即可。
    });
  }, [open, webviewLocale]);

  injectAuthRef.current = injectAuth;
  useEffect(() => {
    const subscription = oauthService.onDidChangeSession(() => {
      ++authGeneration.current;
      if (webviewReadyRef.current) void injectAuthRef.current(webviewRef.current);
    });
    return () => subscription.dispose();
  }, [oauthService]);
  useEffect(() => {
    if (open && webviewReadyRef.current) void injectAuthRef.current(webviewRef.current);
  }, [open, injectAuth]);

  const syncNavigationState = useCallback((webview: ElectronWebviewTag | null) => {
    if (!webview) {
      setNavigationState({
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
      });
      return;
    }
    try {
      setNavigationState((current) => ({
        ...current,
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
      }));
    } catch (error) {
      // 三方支付页导航 churn 中 webview 可能短暂未 attach。
      // 导航按钮只是辅助控件，同步失败不应影响支付流程。
      logger.debug("[CodingPlanEmbeddedWebviewDialog] 同步 webview 导航状态失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const handleGoBack = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !navigationState.canGoBack) return;
    webview.goBack();
    syncNavigationState(webview);
  }, [navigationState.canGoBack, syncNavigationState]);

  const handleGoForward = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !navigationState.canGoForward) return;
    webview.goForward();
    syncNavigationState(webview);
  }, [navigationState.canGoForward, syncNavigationState]);

  const handleReloadWebview = useCallback(() => {
    webviewRef.current?.reload();
  }, []);

  const handleWebviewRef = useCallback(
    (element: ElectronWebviewTag | null) => {
      webviewCleanupRef.current?.();
      webviewCleanupRef.current = null;
      webviewRef.current = element;
      if (!element) {
        webviewReadyRef.current = false;
        setNavigationState({
          canGoBack: false,
          canGoForward: false,
          isLoading: false,
        });
        return;
      }
      const handleDomReady = () => {
        // 标记 ready，允许后续 locale 变化的 executeJavaScript 注入。
        webviewReadyRef.current = true;
        syncNavigationState(element);
        // 官网和三方支付页内部会继承各自原生滚动条，接入 App 后与无边框
        // webview 外壳并列出现很突兀；只隐藏 scrollbar，不禁用页面滚动。
        void element
          .executeJavaScript(createCodingPlanScrollbarHideScript(), true)
          .catch((error) => {
            logger.debug("[CodingPlanEmbeddedWebviewDialog] 隐藏 webview 滚动条失败", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        void injectAuthRef.current(element);
        onOpenResultRef.current?.(true);
      };
      const handleDidStartLoading = () => {
        // 新导航开始：重置 ready，避免在未 ready 的页面上 executeJavaScript。
        ++authGeneration.current;
        webviewReadyRef.current = false;
        setAuthError(null);
        setLoadError(null);
        setNavigationState((current) => ({ ...current, isLoading: true }));
      };
      const handleDidStopLoading = () => {
        setNavigationState((current) => ({ ...current, isLoading: false }));
        syncNavigationState(element);
      };
      const handleNavigation = () => {
        syncNavigationState(element);
      };
      // did-fail-load: 主 frame 加载失败（网络中断、DNS 失败、连接被拒等）。
      // 只对主 frame 报错，避免子资源失败把整个 webview 打成错误态。
      const handleDidFailLoad = (event: ElectronWebviewDidFailLoadEvent) => {
        if (!event.isMainFrame) {
          return;
        }
        const description = event.errorDescription || String(event.errorCode);
        logger.warn("[CodingPlanEmbeddedWebviewDialog] webview 加载失败", {
          provider,
          errorCode: event.errorCode,
          errorDescription: event.errorDescription,
          validatedURL: event.validatedURL,
        });
        setLoadError(description);
        onOpenResultRef.current?.(false);
        setNavigationState((current) => ({ ...current, isLoading: false }));
      };
      // render-process-gone: 渲染进程崩溃/OOM/被杀，webview 已无法恢复，同样进入错误态。
      const handleRenderProcessGone = (event: ElectronWebviewRenderProcessGoneEvent) => {
        logger.warn("[CodingPlanEmbeddedWebviewDialog] webview 渲染进程崩溃", {
          provider,
          reason: event.details.reason,
          exitCode: event.details.exitCode,
        });
        setLoadError(event.details.reason);
        onOpenResultRef.current?.(false);
      };
      // ipc-message: 官网页通过 preload 的 window.zcodeBridge.notifyPurchaseComplete
      // 发回购买完成信号（zcode:coding-plan-purchase-complete）。
      // 参照 useEmbeddedBrowserWheelChain.ts 的 ipc-message handler 模式。
      const handleIpcMessage = (event: ElectronWebviewIpcMessageEvent) => {
        if (event.channel !== CodingPlanWebviewChannels.PurchaseComplete) {
          return;
        }
        const raw = event.args[0] as CodingPlanPurchaseCompletePayload | undefined;
        if (raw?.provider !== "zai" && raw?.provider !== "bigmodel") {
          // payload 不合法，忽略，避免伪造或脏数据触发刷新。
          logger.warn("[CodingPlanEmbeddedWebviewDialog] 收到非法的购买完成 payload", {
            channel: event.channel,
            args: event.args,
          });
          return;
        }
        logger.info("[CodingPlanEmbeddedWebviewDialog] 收到官网购买完成信号，触发刷新", {
          provider: raw.provider,
          timestamp: raw.timestamp,
        });
        onPurchaseCompleteRef.current?.();
      };

      element.addEventListener("dom-ready", handleDomReady);
      element.addEventListener("did-start-loading", handleDidStartLoading);
      element.addEventListener("did-stop-loading", handleDidStopLoading);
      element.addEventListener("did-navigate", handleNavigation);
      element.addEventListener("did-navigate-in-page", handleNavigation);
      element.addEventListener("did-fail-load", handleDidFailLoad);
      element.addEventListener("render-process-gone", handleRenderProcessGone);
      element.addEventListener("ipc-message", handleIpcMessage);
      // React effect 绑定可能晚于 <webview> 首轮 dom-ready。
      // ref 挂载时立即绑定 Electron 事件，确保 executeJavaScript 只在 dom-ready 之后发生。
      webviewCleanupRef.current = () => {
        ++authGeneration.current;
        webviewReadyRef.current = false;
        element.removeEventListener("dom-ready", handleDomReady);
        element.removeEventListener("did-start-loading", handleDidStartLoading);
        element.removeEventListener("did-stop-loading", handleDidStopLoading);
        element.removeEventListener("did-navigate", handleNavigation);
        element.removeEventListener("did-navigate-in-page", handleNavigation);
        element.removeEventListener("did-fail-load", handleDidFailLoad);
        element.removeEventListener("render-process-gone", handleRenderProcessGone);
        element.removeEventListener("ipc-message", handleIpcMessage);
      };
    },
    [syncNavigationState],
  );

  useEffect(() => {
    return () => {
      const webview = webviewRef.current;
      if (webviewReadyRef.current && webview) {
        // 关闭购买页时主动清掉持久 partition 内的凭据 key，降低跨账号残留窗口。
        void webview.executeJavaScript(createCodingPlanCredentialClearScript(), true).catch(() => {
          // webview 可能已销毁，主进程 clear-all-data 会兜底清理 partition。
        });
      }
      webviewCleanupRef.current?.();
      webviewCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (open) {
      setAuthError(null);
      setLoadError(null);
      setNavigationState({
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
      });
    }
  }, [open, webviewUrl]);

  // 打开官网购买页：webview 不可用时引导用户去官网自行购买。
  const handleOpenWebsite = useCallback(() => {
    platform.openExternal(webviewUrl);
  }, [platform, webviewUrl]);

  if (!open) {
    return null;
  }

  const pageContentWidthClass = "max-w-5xl";

  return (
    <section
      data-testid="coding-plan-upgrade-surface"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background pt-12 text-foreground"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <EmbeddedWebsiteHeader
          title={intl.formatMessage({ id: "settings.modelProvider.codingPlan.webview.title" })}
          loading={navigationState.isLoading}
          canGoBack={navigationState.canGoBack}
          canGoForward={navigationState.canGoForward}
          onBack={handleGoBack}
          onForward={handleGoForward}
          onReload={handleReloadWebview}
          onClose={() => onOpenChange(false)}
        />

        <main
          className={cn(
            "mx-auto flex w-full flex-1 flex-col px-6 pt-2 pb-8 max-sm:px-4 max-sm:pt-2 max-sm:pb-5",
            pageContentWidthClass,
          )}
        >
          {authError ? (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3 text-ui-base text-foreground-subtle">
              <span>
                {intl.formatMessage({
                  id: "settings.modelProvider.codingPlan.webview.authInjectFailed",
                })}
              </span>
              <Button size="sm" variant="outline" onClick={() => void injectAuth()}>
                <RefreshCwIcon className="size-3.5" />
                {intl.formatMessage({
                  id: "settings.modelProvider.codingPlan.webview.retry",
                })}
              </Button>
            </div>
          ) : null}
          {loadError ? (
            <div
              className="mb-3 flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-ui-base text-foreground-subtle"
              data-testid="coding-plan-embedded-webview-load-error"
            >
              <span className="font-medium text-foreground">
                {intl.formatMessage({
                  id: "settings.modelProvider.codingPlan.webview.loadFailed",
                })}
              </span>
              <span className="text-ui-sm text-foreground-subtle">{loadError}</span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={handleOpenWebsite}>
                  <ExternalLinkIcon className="size-3.5" />
                  {intl.formatMessage({
                    id: "settings.modelProvider.codingPlan.webview.openWebsite",
                  })}
                </Button>
                <Button size="sm" variant="ghost" onClick={handleReloadWebview}>
                  <RefreshCwIcon className="size-3.5" />
                  {intl.formatMessage({
                    id: "settings.modelProvider.codingPlan.webview.retry",
                  })}
                </Button>
              </div>
            </div>
          ) : null}
          <webview
            ref={handleWebviewRef}
            allowpopups={"" as unknown as boolean}
            partition="persist:zcode-coding-plan"
            src={webviewUrl}
            className={cn(
              "min-h-0 flex-1 bg-background [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              loadError && "hidden",
            )}
            data-testid="coding-plan-embedded-webview"
          />
        </main>
      </div>
    </section>
  );
}

export { CODING_PLAN_WEBVIEW_OVERRIDE_ENV_KEY };
