import type { WebOAuthProviderId } from "./browserOAuthCredentialRepo.js";

type WebAuthLocale = "zh-CN" | "en-US";

interface WebAuthPageCopy {
  defaultRegion: "zai_cn" | "zai";
  regionLabel: string;
  authorizeAction: string;
  waiting: string;
  authorizationHint: string;
  cancelAction: string;
  brand: string;
  loginTitle: string;
  loginDescription: string;
  loginAction: Record<WebOAuthProviderId, string>;
  loginRegion: Record<WebOAuthProviderId, string>;
  callbackTitle: string;
  callbackDescription: string;
  callbackErrorTitle: string;
  callbackErrorDescription: string;
  retryAction: string;
}

const WEB_AUTH_COPY = {
  "zh-CN": {
    defaultRegion: "zai_cn",
    regionLabel: "账号区域",
    authorizeAction: "通过浏览器授权登录",
    waiting: "等待授权完成",
    authorizationHint: "请在新标签页完成授权，完成后会自动返回。若未打开，请允许弹出窗口后重试。",
    cancelAction: "取消",
    brand: "ZCode",
    loginTitle: "登录后继续使用 Web 远程控制",
    loginDescription: "请选择与电脑端相同的登录平台，并使用同一账号。",
    loginAction: {
      zai: "连接 Z.ai 继续使用",
      zai_cn: "连接 Z.ai 继续使用",
      bigmodel: "连接 BigModel 继续使用",
    },
    loginRegion: { zai: "全球", zai_cn: "中国", bigmodel: "中国" },
    callbackTitle: "正在完成登录",
    callbackDescription: "请稍候，正在校验账号身份。",
    callbackErrorTitle: "登录失败",
    callbackErrorDescription: "授权流程未完成，请重新登录。",
    retryAction: "重新登录",
  },
  "en-US": {
    defaultRegion: "zai",
    regionLabel: "Account region",
    authorizeAction: "Authorize in browser",
    waiting: "Waiting for authorization",
    authorizationHint:
      "Complete authorization in the new tab. This page will continue automatically. If no tab opens, allow pop-ups and retry.",
    cancelAction: "Cancel",
    brand: "ZCode",
    loginTitle: "Sign In To Continue",
    loginDescription: "Choose the same sign-in provider and account as on your computer.",
    loginAction: {
      zai: "Connect to Z.ai",
      zai_cn: "Connect to Z.ai",
      bigmodel: "Connect to BigModel",
    },
    loginRegion: { zai: "Global", zai_cn: "China", bigmodel: "CN" },
    callbackTitle: "Finishing Sign-In",
    callbackDescription: "Verifying your account identity.",
    callbackErrorTitle: "Sign-In Failed",
    callbackErrorDescription: "The authorization flow did not complete. Sign in again.",
    retryAction: "Sign In Again",
  },
} satisfies Record<WebAuthLocale, WebAuthPageCopy>;

function resolveWebAuthLocale(language?: string): WebAuthLocale {
  const candidate =
    language ??
    document.documentElement.lang ??
    navigator.language ??
    navigator.languages?.[0] ??
    "";

  return candidate.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function getWebAuthCopy(locale: WebAuthLocale = resolveWebAuthLocale()): WebAuthPageCopy {
  return WEB_AUTH_COPY[locale];
}
