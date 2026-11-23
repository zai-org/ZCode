import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { LucideProvider } from "lucide-react";
import "../../share-ui/src/styles.css";
import { DEFAULT_LUCIDE_STROKE_WIDTH } from "../../ui/src/components/icons/windowIcons.js";
import { applyTheme, type Theme } from "../../ui/src/useTheme.js";
import {
  ConversationShareLandingLoader,
  ConversationShareLandingStatus,
} from "../../web/src/share/ConversationShareLandingPage.js";
import {
  ConversationSharePreviewClient,
  resolveConversationShareRouteLocale,
} from "../../web/src/share/conversationSharePreviewClient.js";
import {
  conversationShareManagePath,
  isConversationSharePath,
  resolveConversationShareCodeFromPath,
  resolveConversationShareManageLocale,
} from "../../web/src/share/conversationShareRoute.js";
import {
  ConversationShareManageClient,
  ConversationShareManageLoader,
} from "../../web/src/share-manage/index.js";
import { resolveWebRemoteControlInitialTheme } from "../../web/src/web-remote-control/adapters/webRemoteControlThemeSeed.js";
import { createWebAuthService } from "../../web/src/auth/webAuthService.js";
import {
  WEB_ZAI_OAUTH_CONFIG,
  resolveWebAuthDevReturnTo,
} from "../../web/src/auth/webZaiOAuthConfig.js";
import { ShareCallbackPage } from "./ShareAuthPages.js";
import type { WebOAuthProviderId } from "../../web/src/auth/browserOAuthCredentialRepo.js";

const reactRoot = createRoot(document.getElementById("root")!);
// 问题：Share 是独立入口，不经过 App 的 Root，原来没有 LucideProvider，
// 共用组件里未显式传 strokeWidth 的图标（思考、工具摘要等）回退到 lucide 默认 2，比 App 的 1.5 更粗。
// 修复：在唯一渲染出口统一注入同一个默认线宽，分享页、管理页、回调页都生效。
const root = {
  render(node: ReactNode): void {
    reactRoot.render(
      <LucideProvider strokeWidth={DEFAULT_LUCIDE_STROKE_WIDTH}>{node}</LucideProvider>,
    );
  },
};
const webAuthService = createWebAuthService();

function resolveThemePreference(): Theme {
  const saved = localStorage.getItem("zcode-theme");
  return resolveWebRemoteControlInitialTheme({ storedTheme: saved, defaultTheme: "zai-light" });
}

// Share 是独立入口，不会经过完整 Web 的 bootstrap；必须在渲染前同步根主题 class，
// 否则页面外壳使用默认浅色 token，而 MessageResponse 会按 zai-dark 选择 github-dark，
// 最终产生浅色页面套深色 Markdown 代码块的混合样式。
const INITIAL_THEME = resolveThemePreference();
applyTheme(INITIAL_THEME);

function isOAuthCallback(): boolean {
  return (
    window.location.pathname === "/cn/share/callback" ||
    window.location.pathname === "/share/callback"
  );
}

function renderCallback(): void {
  // Bug 原因：区域登录改为同页跳转后，回调带的是服务端 flow state，不含 app_return_to；原先只解析
  // 本端编码的 state，失败后“重新登录”落到无分享码的 /share 错误页。回跳地址只记在 pending 里，
  // 改用与完整 Web 入口相同的解析，且必须在 handleCallback 取出 pending 之前读取。
  const retryTarget = webAuthService.resolveCallbackReturnTo(window.location.href) ?? "/share";
  root.render(
    <ShareCallbackPage
      authService={webAuthService}
      onSuccess={({ appReturnTo }) => window.location.replace(appReturnTo ?? "/share")}
      onRetry={() => window.location.replace(retryTarget)}
    />,
  );
}

const endpointOrigin =
  import.meta.env.VITE_ZCODE_BASE_URL?.trim().replace(/\/+$/u, "") || window.location.origin;
const mockMode =
  import.meta.env.DEV && import.meta.env.VITE_CONVERSATION_SHARE_PREVIEW_MOCK === "true";
const getMockToken = () =>
  mockMode && window.sessionStorage.getItem("zcode:share:mock-auth") === "owner"
    ? "mock-owner-token"
    : null;
const getAccessToken = () => getMockToken() ?? webAuthService.getZCodeJwtToken();

// Bug 原因：登录按钮靠返回的 promise 判断失败、靠 signal 在跳转前取消；原先不传 signal、不返回 promise，
// 取消后页面仍跳到授权站，初始化失败时一直停在等待态。
function startLogin(provider: WebOAuthProviderId, signal?: AbortSignal): Promise<void> | void {
  if (mockMode) {
    window.sessionStorage.setItem("zcode:share:mock-auth", "owner");
    window.location.reload();
    return;
  }
  return webAuthService.startLogin({
    signal,
    provider,
    appReturnTo: window.location.href,
    redirectUri: WEB_ZAI_OAUTH_CONFIG.shareRedirectUri,
    devReturnTo: resolveWebAuthDevReturnTo(WEB_ZAI_OAUTH_CONFIG, "share"),
  });
}

function logout(): void {
  if (mockMode) window.sessionStorage.removeItem("zcode:share:mock-auth");
  void webAuthService.logout();
}

async function renderManage(locale: "zh-CN" | "en-US"): Promise<void> {
  document.documentElement.lang = locale;
  document.title = locale === "zh-CN" ? "我的分享 · ZCode" : "My shares · ZCode";
  const client = mockMode
    ? new (
        await import("../../web/src/share-manage/mockConversationShareManageClient.js")
      ).MockConversationShareManageClient()
    : new ConversationShareManageClient({ baseUrl: `${endpointOrigin}/api/v1` });
  root.render(
    <ConversationShareManageLoader
      client={client}
      getAccessToken={getAccessToken}
      onLogin={startLogin}
      onLogout={logout}
      locale={locale}
      theme={INITIAL_THEME}
    />,
  );
}

async function renderShare(): Promise<void> {
  const locale = resolveConversationShareRouteLocale(window.location.pathname);
  document.documentElement.lang = locale;
  document.title = locale === "zh-CN" ? "ZCode 会话分享" : "ZCode Conversation Share";

  const shareCode = resolveConversationShareCodeFromPath(window.location.pathname);
  if (!shareCode) {
    root.render(
      <ConversationShareLandingStatus
        state={{ kind: "error", error: "invalid_contract" }}
        locale={locale}
      />,
    );
    return;
  }

  const client = mockMode
    ? new (
        await import("../../web/src/share/mockConversationSharePreviewClient.js")
      ).MockConversationSharePreviewClient()
    : new ConversationSharePreviewClient({ baseUrl: `${endpointOrigin}/api/v1` });
  root.render(
    <ConversationShareLandingLoader
      shareCode={shareCode}
      client={client}
      getAccessToken={getAccessToken}
      onLogin={startLogin}
      onLogout={() => {
        logout();
        window.location.reload();
      }}
      locale={locale}
      theme={INITIAL_THEME}
      manageHref={conversationShareManagePath(locale)}
    />,
  );
}

async function main(): Promise<void> {
  if (isOAuthCallback()) {
    renderCallback();
    return;
  }
  // 管理页必须先于分享码解析匹配，否则 /share/manage 会被当成分享码 "manage" 去请求 preview。
  const manageLocale = resolveConversationShareManageLocale(window.location.pathname);
  if (manageLocale) {
    await renderManage(manageLocale);
    return;
  }
  if (isConversationSharePath(window.location.pathname)) {
    await renderShare();
    return;
  }
  root.render(
    <ConversationShareLandingStatus state={{ kind: "error", error: "invalid_contract" }} />,
  );
}

void main();
