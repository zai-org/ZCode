import { createContext, useContext } from "react";
import type { OpenExtensionLogs, OpenExtensionView } from "@/extension-slots/contract.js";

// 打开扩展视图标签的入口：由 App 层的 ExtensionViewsProvider 提供（它持有侧栏标签的 owner 回调）。
export const OpenExtensionViewContext = createContext<OpenExtensionView | null>(null);

export function useOpenExtensionView(): OpenExtensionView | null {
  return useContext(OpenExtensionViewContext);
}

// 打开扩展日志标签的入口（§16.8）：同一个 Provider 提供；没有扩展门面时为 null。
export const OpenExtensionLogsContext = createContext<OpenExtensionLogs | null>(null);

export function useOpenExtensionLogs(): OpenExtensionLogs | null {
  return useContext(OpenExtensionLogsContext);
}
