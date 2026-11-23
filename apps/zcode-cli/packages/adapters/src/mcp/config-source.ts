import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type {
  Logger,
  McpConfigurationSnapshot,
  McpConfigurationSource,
  McpServerConfig,
} from "@zcode/contracts";
import { mcpConfigKey } from "@zcode/contracts";
import {
  createMcpConfigurationLoader,
  type McpConfigurationLoaderOptions,
} from "./config-loader.js";
import {
  createRefcountedRegistry,
  createWatchedEntry,
  WATCHED_SOURCE_DEBOUNCE_MS,
  type WatchedEntry,
} from "../watch/watched-source.js";

/** 一次保存常产生多个 raw / all 事件；尾部去抖把它们合成一次读盘。 */
export const MCP_CONFIG_EVENT_DEBOUNCE_MS = WATCHED_SOURCE_DEBOUNCE_MS;

export interface McpConfigurationSourceOptions extends McpConfigurationLoaderOptions {
  /** 每个会话自己的整形（内建 server、computerUse、显式 enabled、broker）；必须复制后修改。 */
  prepare?(
    servers: Record<string, McpServerConfig>,
    pluginServers: Record<string, McpServerConfig>,
    enabled: boolean,
  ): McpConfigurationSnapshot;
}

export interface McpConfigSourceRegistry {
  /** 同一进程内输入相同的会话共用一组 watcher 与读盘结果；每次返回一个可幂等释放的 view。 */
  acquire(options: McpConfigurationSourceOptions): Promise<McpConfigurationSource>;
  /** 进程退出时强制关闭全部条目；之后迟到的 view 释放什么也不做。 */
  close(): void;
}

type LoadedConfiguration = Awaited<
  ReturnType<ReturnType<typeof createMcpConfigurationLoader>["load"]>
>;

type SharedConfigEntry = WatchedEntry<LoadedConfiguration>;

/** 单个调用方的配置源（TUI、headless、测试）：私有 registry，view 释放即关闭全部资源。 */
export async function createDynamicMcpConfigSource(
  options: McpConfigurationSourceOptions,
): Promise<McpConfigurationSource> {
  return createMcpConfigSourceRegistry().acquire(options);
}

/**
 * key 与加载器输入取自同一份 options，覆盖范围一致。Set 先转成有序数组：直接交给
 * mcpConfigKey 一律是 "{}"。只有 official 根目录被加载器使用。含 env 原值，只保留哈希。
 */
function sourceKey(options: McpConfigurationLoaderOptions): string {
  const byKey = ([left]: [string, unknown], [right]: [string, unknown]) =>
    left < right ? -1 : left > right ? 1 : 0;
  return createHash("sha256")
    .update(
      JSON.stringify([
        options.configPaths,
        options.userConfigPath ?? null,
        Object.entries(options.fallbackPaths ?? {}).toSorted(byKey),
        options.pluginStorageRoot,
        // 修复原因：已信任的项目目录插件也是加载器输入。键里只有官方根目录时，信任前后创建的
        // 会话共用同一个源，信任后的新会话仍拿不到插件的 MCP 与技能（WPL-014 运行时日志确认）。
        options.pluginRoots
          .filter((root) => root.source === "official" || root.workspaceTrust?.state === "trusted")
          .map((root) => [
            root.rootPath,
            root.marketplace,
            root.workspaceTrust?.state === "trusted" ? root.workspaceTrust.declarationDigest : null,
          ]),
        mcpConfigKey(options.explicitServers),
        options.workingDirectory,
        Object.entries(options.env ?? process.env).toSorted(byKey),
        [...(options.defaultEnabledPlugins ?? [])].toSorted(),
      ]),
    )
    .digest("hex");
}

export function createMcpConfigSourceRegistry(
  registryOptions: { logger?: Logger } = {},
): McpConfigSourceRegistry {
  return createRefcountedRegistry<
    McpConfigurationSourceOptions,
    SharedConfigEntry,
    McpConfigurationSource
  >({
    label: "MCP configuration source",
    key: ({ prepare: _prepare, ...loaderOptions }) => sourceKey(loaderOptions),
    // 修复原因：条目比创建它的会话活得久；带着 prepare 闭包会让该会话的 app 作用域无法回收。
    create: ({ prepare: _prepare, ...loaderOptions }) =>
      createSharedConfigEntry({
        ...loaderOptions,
        logger: registryOptions.logger ?? loaderOptions.logger,
      }),
    view: (entry, options, release) =>
      createConfigView(entry, options.prepare, release, options.logger),
  });
}

function createConfigView(
  entry: SharedConfigEntry,
  prepare: McpConfigurationSourceOptions["prepare"],
  release: () => void,
  logger: Logger | undefined,
): McpConfigurationSource {
  const snapshot = () => {
    const loaded = entry.current();
    return prepare
      ? prepare(loaded.configuration.servers, loaded.pluginServers, loaded.configuration.enabled)
      : loaded.configuration;
  };
  let current = snapshot();
  let currentKey = mcpConfigKey(current);
  let closed = false;
  const listeners = new Set<() => void>();
  // 条目对每次采纳都通知；内容不变的 view 不通知会话，避免多余的 reconcile。
  const unlisten = entry.listen(() => {
    const next = snapshot();
    const nextKey = mcpConfigKey(next);
    if (nextKey === currentKey) return;
    logger?.debug("MCP configuration snapshot published", {
      serverNames: Object.keys(next.servers),
    });
    current = next;
    currentKey = nextKey;
    // 遍历副本：回调里取消订阅不能跳过其余订阅者。
    for (const listener of Array.from(listeners)) listener();
  });
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      // 一次 app 关闭会多次走 beginShutdown；只释放一次引用。
      if (closed) return;
      closed = true;
      listeners.clear();
      unlisten();
      release();
    },
  };
}

/** 首载和后续文件事件只调用同一加载器；监听器不解析或合并配置。 */
function createSharedConfigEntry(
  options: McpConfigurationLoaderOptions,
): Promise<SharedConfigEntry> {
  const loader = createMcpConfigurationLoader(options);
  return createWatchedEntry({
    load: () => loader.load(),
    // 缺失目录只在这些根目录之内向上找锚点。
    bounds: [
      options.workingDirectory,
      dirname(options.pluginStorageRoot),
      ...(options.userConfigPath ? [dirname(options.userConfigPath)] : []),
    ],
    label: "MCP configuration",
    logger: options.logger,
  });
}
