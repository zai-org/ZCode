/**
 * live-config-watch 对外契约：打开的会话重读配置时共用的监听与读取原语。
 * 领域（MCP 配置源、Skill 实时目录）只提供加载器；何时重读、监听哪些锚点由这里决定。
 */
import type { Logger } from "@zcode/contracts";

/** 加载器一次全量读取的结果；只有被采纳（成为当前快照）时才调用 commit。 */
export interface WatchedLoad {
  /** 本次读到或依赖的文件；缺失的文件也要登记，创建时才能被发现。 */
  files: Set<string>;
  /** 只看直接子目录增删的目录（skill 根目录）；子目录里的文件不监听。 */
  directories?: Set<string>;
  commit(): void;
}

export interface WatchedEntry<L extends WatchedLoad> {
  current(): L;
  listen(listener: () => void): () => void;
  /** 跳过去抖立即读盘，等到本轮及其后续 drain 全部采纳。 */
  flush(): Promise<void>;
  close(): void;
}

export interface WatchedEntryOptions<L extends WatchedLoad> {
  load(): Promise<L>;
  /** 缺失路径只在包含它的最外层边界之内向上找锚点。 */
  bounds: readonly string[];
  /** 目录条目的直接子目录名过滤；不传时全部接受。 */
  childName?(name: string): boolean;
  /** 日志前缀，例如 "MCP configuration"。 */
  label: string;
  logger?: Logger;
  /** 一次绑定建立监听的总截止时间（毫秒）；只供测试注入，生产不传，用 `WATCH_BIND_TIMEOUT_MS`。 */
  bindTimeoutMs?: number;
}

export interface RefcountedRegistry<O, V> {
  /** 同一进程内 key 相同的调用方共用一个条目；每次返回一个可幂等释放的 view。 */
  acquire(options: O): Promise<V>;
  /** 进程退出时强制关闭全部条目；之后迟到的 view 释放什么也不做。 */
  close(): void;
}
