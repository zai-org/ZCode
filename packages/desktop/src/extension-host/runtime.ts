import { AsyncLocalStorage } from "node:async_hooks";
import { setGlobalProxyFromEnv } from "node:http";
import { sep } from "node:path";
import { format } from "node:util";
import { ExtensionError, type ExtensionHostToMainMessage } from "@zcode/shared/extension-host";

// 扩展进程的运行时护栏（docs/plugins/extension-host.md §7.1）：
// - 扩展代码的未捕获错误只记日志，并标明所属插件，不让进程退出。
// - 扩展调用 process.exit 会抛错；宿主自己退出用 exitHost。
// - 日志经 parentPort 发给 Main，由 Main 以 [extension-host] 前缀写盘。

interface Attribution {
  pluginId: string;
}

const attribution = new AsyncLocalStorage<Attribution>();
/** 插件根目录 → 插件 id。AsyncLocalStorage 拿不到上下文时（如部分未捕获错误），按堆栈路径归因。 */
const pluginRoots = new Map<string, string>();
const realExit = process.exit.bind(process) as (code?: number) => never;

export function postToMain(message: ExtensionHostToMainMessage): void {
  try {
    process.parentPort?.postMessage(message);
  } catch {
    // parentPort 已关闭（Main 正在退出）时没有可写的地方，丢弃。
  }
}

export function hostLog(
  level: "info" | "warn" | "error",
  message: string,
  pluginId?: string,
): void {
  postToMain({ type: "extension-host/log", level, message, ...(pluginId ? { pluginId } : {}) });
}

/**
 * 打开环境代理（docs/plugins/extension-host.md §12.1、§18.1 H3）：监管器已把设置页的代理与 No Proxy
 * 翻译进本进程的环境变量。Node 默认不读这些变量，全局 fetch 与 http(s).request 要经
 * http.setGlobalProxyFromEnv() 打开（Electron 44 的 Node 24.21 提供）。这是全局状态，只由宿主在加载任何扩展前调一次。
 * 自定义 CA 不需要这里：NODE_EXTRA_CA_CERTS 由 Node 在进程启动时读取。
 * 代理地址不合法时只记错误码（地址可能带账号密码），扩展照常加载，请求直连。
 */
export function enableEnvironmentProxy(): void {
  const env = process.env;
  const configured = Boolean(
    env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY,
  );
  if (!configured) {
    hostLog("info", "environment proxy: not configured");
    return;
  }
  try {
    setGlobalProxyFromEnv(env);
    hostLog(
      "info",
      `environment proxy: enabled noProxy=${env.no_proxy || env.NO_PROXY ? "set" : "unset"}`,
    );
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    hostLog(
      "warn",
      `environment proxy: not enabled (${typeof code === "string" ? code : "error"})`,
    );
  }
}

export function formatLogArgs(args: readonly unknown[]): string {
  return format(...args);
}

/** 在插件归因上下文里运行扩展代码（激活、命令、监听器、停用）。 */
export function runAsPlugin<T>(pluginId: string, fn: () => T): T {
  return attribution.run({ pluginId }, fn);
}

export function registerPluginRoot(rootPath: string, pluginId: string): void {
  pluginRoots.set(rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`, pluginId);
}

export function unregisterPluginRoot(rootPath: string): void {
  pluginRoots.delete(rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`);
}

function attributeError(error: unknown): string | undefined {
  const current = attribution.getStore()?.pluginId;
  if (current) return current;
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  for (const [root, pluginId] of pluginRoots) {
    if (stack.includes(root)) return pluginId;
  }
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export function exitHost(code: number): never {
  return realExit(code);
}

/** 进程入口最先调用一次。 */
export function installRuntimeGuards(): void {
  process.exit = ((code?: number) => {
    throw new ExtensionError(
      "internal",
      `process.exit(${code ?? ""}) is not allowed in extensions`,
    );
  }) as typeof process.exit;
  attributeConsole();
  process.on("uncaughtException", (error) => {
    const pluginId = attributeError(error);
    hostLog("error", `uncaught exception: ${describeError(error)}`, pluginId);
  });
  process.on("unhandledRejection", (reason) => {
    const pluginId = attributeError(reason);
    hostLog("error", `unhandled rejection: ${describeError(reason)}`, pluginId);
  });
}

/**
 * 扩展代码里的 console.* 按插件归因（docs/plugins/extension-host.md §16.8）。
 * 修复原因：原先只有 ctx.log 带插件 id，console.* 直接写 stdout，在日志控制台里只是没有归属的
 * [stdout] 行，按插件过滤时看不到；插件作者最常用的恰恰是 console.log。
 * 修法：复用已有的 AsyncLocalStorage 归因上下文（激活、命令、监听器、视图都在 runAsPlugin 里运行）。
 * 在插件上下文里的调用转成带插件 id 的日志；不在插件上下文里（宿主自身、依赖库）保持原样写 stdout。
 */
function attributeConsole(): void {
  const levels = {
    debug: "info",
    log: "info",
    info: "info",
    warn: "warn",
    error: "error",
  } as const;
  for (const [method, level] of Object.entries(levels) as Array<
    [keyof typeof levels, "info" | "warn" | "error"]
  >) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      const pluginId = attribution.getStore()?.pluginId;
      if (pluginId) hostLog(level, formatLogArgs(args), pluginId);
      else original(...args);
    };
  }
}
