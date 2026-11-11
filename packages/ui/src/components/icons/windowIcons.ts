import { createLucideIcon } from "lucide-react";

/**
 * Lucide 图标默认线宽的唯一来源。
 * App 的 Root 与分享页独立入口都通过 LucideProvider 注入这个值，
 * 避免两个入口各写一份导致同一组件的图标粗细不一致。
 */
export const DEFAULT_LUCIDE_STROKE_WIDTH = 1.5;

// 用户提供的窗口图形使用 Lucide 渲染，去掉白底并继承主题前景色及全局线宽。
export const WindowMaximizeIcon = createLucideIcon("WindowMaximize", [
  [
    "path",
    {
      d: "M17.4444 5H6.55556C5.69645 5 5 5.69645 5 6.55556V17.4444C5 18.3036 5.69645 19 6.55556 19H17.4444C18.3036 19 19 18.3036 19 17.4444V6.55556C19 5.69645 18.3036 5 17.4444 5Z",
      key: "frame",
    },
  ],
]);

export const WindowRestoreIcon = createLucideIcon("WindowRestore", [
  ["path", { d: "M9 5H13C16.3137 5 19 7.68629 19 11V15", key: "back" }],
  ["rect", { x: "5", y: "9", width: "10", height: "10", rx: "2", key: "front" }],
]);
