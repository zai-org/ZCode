import type { IDisposable } from "@zcode/rpc";
import type { ExtensionError } from "@zcode/shared/extension-host";

// 能力网关与各后端共用的调用类型（docs/plugins/extension-host.md §7.2、§17.3）。单独成文件，
// 后端不必依赖网关本身（否则网关 → 后端 → 网关成环）。

export interface CapabilityCallContext {
  /** 调用方插件 id。按插件的授权与审计用于归因，不是安全边界（§7.3）。 */
  pluginId: string;
  /** 调用到达的扩展进程代际（这条连接的 gen）。 */
  gen: number;
}

/**
 * 订阅处理函数的返回：比 Event 多一个 fail，后端用它以错误结束这次订阅（上限、目标不可用等，§17.3）。
 * 只用 listener 的普通 Event 也满足这个类型。
 */
export type CapabilitySubscription<T> = (
  listener: (event: T) => void,
  fail: (error: ExtensionError) => void,
) => IDisposable;
