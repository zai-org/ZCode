import { parseConversationShareRoute } from "./conversationSharePreviewClient.js";

export function resolveConversationShareCodeFromPath(pathname: string): string | null {
  return parseConversationShareRoute(pathname);
}

/**
 * 中文站 /cn/share 与英文站 /share 都是分享路由。
 * 这里只判断「是否归分享页处理」，形状不合法的留给 code 解析报 invalid_contract。
 */
export function isConversationSharePath(pathname: string): boolean {
  return (
    pathname === "/cn/share" ||
    pathname.startsWith("/cn/share/") ||
    pathname === "/share" ||
    pathname.startsWith("/share/")
  );
}

const CONVERSATION_SHARE_MANAGE_PATH_RE = /^\/(cn\/)?share\/manage\/?$/u;

/** 分享管理页 `/share/manage`（英文）与 `/cn/share/manage`（中文）；必须先于分享码解析匹配。 */
export function resolveConversationShareManageLocale(pathname: string): "zh-CN" | "en-US" | null {
  const match = CONVERSATION_SHARE_MANAGE_PATH_RE.exec(pathname);
  if (!match) return null;
  return match[1] ? "zh-CN" : "en-US";
}

export function conversationShareManagePath(locale: "zh-CN" | "en-US"): string {
  return locale === "zh-CN" ? "/cn/share/manage" : "/share/manage";
}
