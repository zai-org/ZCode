import type { UtilityProcess } from "electron";

// extension-host 模块的公开契约（docs/plugins/extension-host.md §4、§12.1）。
// 扩展进程本身（index.ts）只由 utilityProcess.fork 加载，不被其他模块 import；
// Main 只经监管器与它交互。跨进程消息形状在 extension-host-protocol 定义。

/**
 * 设置页的网络出口（docs/plugins/extension-host.md §12.1、§18.1 H3）：HTTP 代理、No Proxy、自定义 CA 路径。
 * owner 是设置文件（AppSettings 的 httpProxy、httpProxyNoProxy、httpProxyCaCertPath）；监管器每次启动扩展进程前读一次。
 */
export interface ExtensionHostNetworkSettings {
  httpProxy?: string;
  noProxy?: string;
  caCertPath?: string;
}

export interface ExtensionHostSupervisorDeps {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  /** 读设置页的网络出口；缺省时只用 Main 环境里的白名单变量。 */
  readNetworkSettings?: () => Promise<ExtensionHostNetworkSettings>;
}

export interface ExtensionHostSupervisor {
  /**
   * 登记一个 Window Host。收到它的 window-ready 后才牵线；首个就绪的 Window Host 拉起扩展进程。
   * 同一时刻只给一个 Window Host 牵线；它退出后给下一个就绪的 Window Host 牵线。
   */
  trackWindowHost(host: UtilityProcess): void;
  /** App 退出：发 dispose，扩展的 deactivate 共用 1 秒，1.5 秒后强杀。 */
  dispose(): Promise<void>;
}
