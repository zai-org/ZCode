import { mcpConfigKey } from "@zcode/contracts";
import type {
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectOptions,
  McpConnectionSnapshot,
  McpPort,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpServerConfig,
  McpServerStatus,
  McpServerToolSnapshot,
  McpToolCallResult,
  McpToolDescriptor,
  McpWaitForServerOptions,
} from "@zcode/contracts";
import { randomUUID } from "node:crypto";
import type { McpTelemetryTracker } from "./telemetry.js";

const DEFAULT_IDLE_GRACE_MS = 30_000;

export interface CreateMcpAdapterForPoolInput {
  connectionContext: McpConnectionContext;
  config: McpServerConfig;
  serverName: string;
  workingDirectory?: string;
  workspaceKey?: string;
}

export interface McpConnectionContext {
  mcpConnectionId: string;
  mcpIsolation: "session" | "workspace";
  sessionId?: string;
  workspaceKey?: string;
}

export interface McpConnectionPoolOptions {
  createAdapter(input: CreateMcpAdapterForPoolInput): McpPort;
  idleGraceMs?: number;
  logger?: Logger;
  telemetry?: McpTelemetryTracker;
}

export interface McpConnectionPool {
  acquireLease(options?: { leaseId?: string; sessionId?: string }): McpPort;
  close(): Promise<void>;
  stats(): { activeConnections: number; pendingCloseConnections: number };
}

interface PoolEntry {
  adapter: McpPort;
  closeTimer?: ReturnType<typeof setTimeout>;
  connectionContext: McpConnectionContext;
  key: string;
  refs: Set<string>;
  controller: AbortController;
  closing?: Promise<void>;
  serverName: string;
}

export function createMcpConnectionPool(options: McpConnectionPoolOptions): McpConnectionPool {
  const entries = new Map<string, PoolEntry>();
  const idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
  const logger = options.logger?.child({ module: "adapters.mcp.pool" });
  let closed = false;
  let leaseSequence = 0;
  const snapshotListeners = new Set<() => void>();
  const notifySnapshot = () => {
    for (const listener of snapshotListeners) {
      // 监听者属于不同会话：一个会话的错误不能中断其他会话的通知，也不能变成未捕获异常。
      try {
        listener();
      } catch (error) {
        logger?.error(
          "MCP snapshot listener failed",
          error instanceof Error ? error : new Error(String(error)),
          { event: "mcp.snapshot.listener_failed" },
        );
      }
    }
  };

  const closeEntry = (entry: PoolEntry): Promise<void> => {
    entry.closing ??= (async () => {
      if (entry.closeTimer) clearTimeout(entry.closeTimer);
      entry.closeTimer = undefined;
      if (entries.get(entry.key) === entry) entries.delete(entry.key);
      entry.controller.abort(new Error("MCP connection closed"));
      try {
        await entry.adapter.close();
        logger?.info("MCP pooled connection closed", {
          ...entry.connectionContext,
          event: "mcp.pool.connection.closed",
          mcpServerName: entry.serverName,
          status: "completed",
        });
      } finally {
        options.telemetry?.unregisterConnection({
          connectionId: entry.connectionContext.mcpConnectionId,
        });
      }
    })();
    return entry.closing;
  };
  const closeIdleEntry = (entry: PoolEntry): void => {
    void closeEntry(entry).catch((error: unknown) =>
      logger?.warn("MCP pooled connection close failed", {
        ...entry.connectionContext,
        event: "mcp.pool.connection.close.failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const scheduleClose = (entry: PoolEntry): void => {
    if (entry.closeTimer) return;
    if (idleGraceMs <= 0) {
      closeIdleEntry(entry);
      return;
    }
    entry.closeTimer = setTimeout(() => {
      entry.closeTimer = undefined;
      if (entry.refs.size === 0) closeIdleEntry(entry);
    }, idleGraceMs);
    entry.closeTimer.unref?.();
  };

  const acquireLease = (leaseOptions: { leaseId?: string; sessionId?: string } = {}): McpPort => {
    if (closed) throw new Error("MCP connection pool is closed");
    const leaseId = `${++leaseSequence}:${leaseOptions.leaseId ?? "lease"}`;
    const sessionId = leaseOptions.sessionId?.trim() || undefined;
    const leased = new Map<string, string>();
    const configuredServers = new Map<string, McpServerConfig>();
    const appListeners = new Map<string, Set<{ listener: () => void; off: () => void }>>();
    const invalidateApps = (serverName: string) => {
      const watchers = appListeners.get(serverName);
      appListeners.delete(serverName);
      for (const watcher of watchers ?? []) {
        watcher.off();
        watcher.listener();
      }
    };
    // 经本租约登记的资源订阅：serverName → JSON [uri, subscriberKey]。
    // 释放时只退订这些键；修复前按会话前缀退订，同一会话的另一租约（重开时的重叠窗口）的订阅也被删掉。
    const subscriptions = new Map<string, Set<string>>();
    const releaseSubscriptions = (serverName: string, adapter: McpPort): void => {
      const keys = subscriptions.get(serverName);
      subscriptions.delete(serverName);
      if (!adapter.unsubscribeResource) return;
      for (const item of keys ?? []) {
        const [uri, subscriberKey] = JSON.parse(item) as [string, string];
        void adapter.unsubscribeResource({ serverName, uri, subscriberKey }).catch(() => undefined);
      }
    };
    let leaseClosed = false;
    const leaseShutdown = new AbortController();
    let leaseClose: Promise<void> | undefined;
    const assertOpen = () => {
      if (leaseClosed || closed) throw new Error("MCP session lease is closed");
    };
    const callerSignal = (signal?: AbortSignal) =>
      signal ? AbortSignal.any([leaseShutdown.signal, signal]) : leaseShutdown.signal;
    const wait = async <T>(work: Promise<T>, signal = leaseShutdown.signal): Promise<T> => {
      signal.throwIfAborted();
      let abort: (() => void) | undefined;
      try {
        const value = await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
          }),
        ]);
        signal.throwIfAborted();
        return value;
      } finally {
        if (abort) signal.removeEventListener("abort", abort);
      }
    };
    const leaseListeners = new Set<() => void>();
    let sessionStartupReported = false;

    const requireEntry = (serverName: string): PoolEntry => {
      assertOpen();
      const key = leased.get(serverName);
      const entry = key ? entries.get(key) : undefined;
      if (!entry) throw new Error(`MCP server is not leased by this session: ${serverName}`);
      return entry;
    };

    const release = (
      serverName: string,
      dispose = false,
      immediate = false,
    ): Promise<void> | undefined => {
      const key = leased.get(serverName);
      if (!key) return;
      leased.delete(serverName);
      queueMicrotask(notifySnapshot);
      invalidateApps(serverName);
      const entry = entries.get(key);
      if (!entry) return;
      // 修复前租约释放后遍历不到旧 entry，登记与远端订阅一起泄漏。
      releaseSubscriptions(serverName, entry.adapter);
      if (!entry.refs.delete(leaseId)) return;
      options.telemetry?.releaseOwner({
        connectionId: entry.connectionContext.mcpConnectionId,
        ownerId: leaseId,
      });
      logger?.info("MCP connection lease released", {
        ...entry.connectionContext,
        event: "mcp.pool.lease.released",
        mcpLeaseId: leaseId,
        mcpServerName: serverName,
        refCount: entry.refs.size,
        ...(sessionId ? { sessionId } : {}),
      });
      if (entry.refs.size === 0) {
        // 配置移除（dispose）：旧配置不再被任何租约使用，立即关闭，失败只记日志。
        // 租约关闭（immediate）：session 隔离的连接立即释放并等待完成，其余按宽限期回收。
        if (dispose) closeIdleEntry(entry);
        else if (immediate && entry.connectionContext.mcpIsolation === "session")
          return closeEntry(entry);
        else scheduleClose(entry);
      }
    };

    const acquire = async (
      serverName: string,
      config: McpServerConfig,
      connectOptions: McpConnectOptions = {},
    ): Promise<McpServerStatus> => {
      assertOpen();
      const signal = callerSignal(connectOptions.signal);
      signal.throwIfAborted();
      const key = connectionKey({
        config,
        connectOptions,
        leaseId,
        serverName,
      });
      const previousKey = leased.get(serverName);
      let entry = entries.get(key);
      let ownerAdded = false;
      if (entry) {
        if (entry.closeTimer) clearTimeout(entry.closeTimer);
        entry.closeTimer = undefined;
        const previousRefCount = entry.refs.size;
        entry.refs.add(leaseId);
        ownerAdded = entry.refs.size !== previousRefCount;
      } else {
        // 过去 pool、adapter 和 stdio PID 的日志彼此没有稳定关联键，无法从一个
        // session 追到实际 MCP 子进程。连接上下文在 entry 创建时固定，后续 lease 共用同一 ID。
        const connectionContext = createConnectionContext({
          config,
          connectOptions,
          sessionId,
        });
        options.telemetry?.registerConnection({
          connectionId: connectionContext.mcpConnectionId,
          isolation: connectionContext.mcpIsolation,
          serverName,
          ...(config.source
            ? {
                source:
                  config.source.kind === "user" || config.source.kind === "workspace"
                    ? "custom"
                    : config.source.kind,
              }
            : {}),
        });
        const adapter = options.createAdapter({
          connectionContext,
          config,
          serverName,
          workingDirectory: connectOptions.workingDirectory,
          ...(connectOptions.workspaceKey ? { workspaceKey: connectOptions.workspaceKey } : {}),
        });
        // 连接归 pool，不能继承第一个 session 的关闭信号，否则会连带中止其他 lease。
        const controller = new AbortController();
        adapter.onSnapshotChanged?.(notifySnapshot);
        entry = {
          adapter,
          controller,
          connectionContext,
          key,
          refs: new Set([leaseId]),
          serverName,
        };
        entries.set(key, entry);
        ownerAdded = true;
        logger?.info("MCP pooled connection created", {
          ...connectionContext,
          event: "mcp.pool.connection.created",
          mcpServerName: serverName,
          transport: config.type,
        });
      }
      if (previousKey && previousKey !== key) {
        invalidateApps(serverName);
        const previous = entries.get(previousKey);
        if (previous) {
          releaseSubscriptions(serverName, previous.adapter);
          if (previous.refs.delete(leaseId)) {
            options.telemetry?.releaseOwner({
              connectionId: previous.connectionContext.mcpConnectionId,
              ownerId: leaseId,
            });
            logger?.info("MCP connection lease released", {
              ...previous.connectionContext,
              event: "mcp.pool.lease.released",
              mcpLeaseId: leaseId,
              mcpServerName: serverName,
              refCount: previous.refs.size,
              ...(sessionId ? { sessionId } : {}),
            });
            if (previous.refs.size === 0) void closeEntry(previous);
          }
        }
      }
      leased.set(serverName, key);
      queueMicrotask(notifySnapshot);
      if (ownerAdded) {
        options.telemetry?.acquireOwner({
          connectionId: entry.connectionContext.mcpConnectionId,
          ownerId: leaseId,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      if (previousKey !== key) {
        // workspace 隔离连接会被多个 session 共享，不能把首个 session 记成唯一 owner；
        // 单独记录 lease 生命周期才能准确表达多对一关系。
        logger?.info("MCP connection lease acquired", {
          ...entry.connectionContext,
          event: "mcp.pool.lease.acquired",
          mcpLeaseId: leaseId,
          mcpServerName: serverName,
          refCount: entry.refs.size,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      // 租约先提交；每次等待直接交给连接 owner，不能复用首个 caller 的预算或取消结果。
      // 会话关闭或调用方取消只结束本次等待，连接任务仍归 adapter，不影响共享该连接的其他 lease。
      return await wait(
        entry.adapter.connectServer(serverName, config, { ...connectOptions, signal }),
        signal,
      );
    };

    const snapshot = async (): Promise<McpConnectionSnapshot> => {
      assertOpen();
      const statuses: Record<string, McpServerStatus> = {};
      const tools: McpToolDescriptor[] = [];
      for (const [serverName, key] of leased) {
        const entry = entries.get(key);
        if (!entry) continue;
        const status = (await entry.adapter.status())[serverName];
        if (status) statuses[serverName] = status;
        tools.push(...(await entry.adapter.listTools()));
      }
      assertOpen();
      if (sessionId && !sessionStartupReported) {
        sessionStartupReported = true;
        const enabledServers = [...configuredServers].filter(
          ([, config]) => config.enabled !== false,
        );
        const connectedCount = enabledServers.filter(
          ([serverName]) => statuses[serverName]?.status === "connected",
        ).length;
        options.telemetry?.recordSessionStartup({
          configuredCount: enabledServers.length,
          connectedCount,
          failedCount: enabledServers.length - connectedCount,
          processCount: enabledServers.filter(
            ([serverName, config]) =>
              config.type === "stdio" && statuses[serverName]?.status === "connected",
          ).length,
          sessionId,
        });
      }
      return { statuses, tools };
    };

    // 修复原因：App 连接身份必须只有一种格式。waitForAppConnection 曾直接返回 adapter 原始快照，
    // appConnectionSnapshot 却带租约连接前缀；MCP App 打开时比较两者 identity，经 pool 的连接
    // 永远判为"连接不可用"（Windows E2E 插件沙箱握手失败，日志可见两种 identity）。
    const toLeaseSnapshot = (
      entry: PoolEntry,
      snapshot: { identity: string; generation: number } | null | undefined,
    ) =>
      snapshot
        ? {
            ...snapshot,
            identity: `${entry.connectionContext.mcpConnectionId}:${snapshot.identity}`,
          }
        : null;

    return {
      async waitForAppConnection(serverName) {
        const key = leased.get(serverName);
        if (!key) return null;
        const entry = entries.get(key);
        if (!entry) return null;
        // 连接任务归 adapter 的连接记录；同一 entry 内的重连由 adapter 按连接代际判定。
        try {
          const source = entry.adapter.waitForAppConnection
            ? await wait(entry.adapter.waitForAppConnection(serverName))
            : (entry.adapter.appConnectionSnapshot?.(serverName) ?? null);
          // 共享连接可能仍被其它会话持有；等待结束不能复活已释放或换源的本会话 lease。
          return !leaseClosed && leased.get(serverName) === key && entries.get(key) === entry
            ? toLeaseSnapshot(entry, source)
            : null;
        } catch (error) {
          if (leaseClosed) return null;
          throw error;
        }
      },
      onSnapshotChanged(listener) {
        snapshotListeners.add(listener);
        leaseListeners.add(listener);
        return () => {
          snapshotListeners.delete(listener);
          leaseListeners.delete(listener);
        };
      },
      appConnectionSnapshot(serverName) {
        const key = leased.get(serverName);
        const entry = key ? entries.get(key) : undefined;
        return entry ? toLeaseSnapshot(entry, entry.adapter.appConnectionSnapshot?.(serverName)) : null;
      },
      onAppConnectionInvalidated(serverName, listener) {
        const entry = requireEntry(serverName);
        const watchers = appListeners.get(serverName) ?? new Set();
        const watcher = {
          listener,
          off: entry.adapter.onAppConnectionInvalidated?.(serverName, listener) ?? (() => {}),
        };
        watchers.add(watcher);
        appListeners.set(serverName, watchers);
        return () => {
          watcher.off();
          watchers.delete(watcher);
          if (!watchers.size) appListeners.delete(serverName);
        };
      },
      async callTool(
        request: McpCallToolRequest,
        callOptions?: McpCallToolOptions,
      ): Promise<McpToolCallResult> {
        const entry = requireEntry(request.serverName);
        const signal = callerSignal(callOptions?.signal);
        if (!callOptions?.appConnection)
          return await entry.adapter.callTool(request, {
            ...callOptions,
            signal,
            // 其他 session 可以继续持有连接，但不能替已释放的本租约重放调用。
            retryAllowed: () =>
              leased.get(request.serverName) === entry.key &&
              entries.get(entry.key) === entry &&
              callOptions?.retryAllowed?.() !== false,
          });
        const current = entry.adapter.appConnectionSnapshot?.(request.serverName);
        // 同配置重新创建 adapter 时 generation 可从头计数，必须同时固定 pool entry 身份。
        if (
          !current ||
          `${entry.connectionContext.mcpConnectionId}:${current.identity}` !==
            callOptions.appConnection.identity ||
          current.generation !== callOptions.appConnection.generation
        )
          throw new Error("MCP App connection changed");
        return await entry.adapter.callTool(request, {
          ...callOptions,
          signal,
          appConnection: current,
        });
      },
      async readResource(
        request: McpReadResourceRequest,
        callOptions?: McpCallToolOptions,
      ): Promise<McpReadResourceResult> {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.readResource) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await adapter.readResource(request, {
          ...callOptions,
          signal: callerSignal(callOptions?.signal),
        });
      },
      // 资源列表与订阅经同一 entry 的 adapter；登记表在 adapter（连接层）里，多 session 共享。
      async listResources(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.listResources) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await adapter.listResources(request, {
          ...callOptions,
          signal: callerSignal(callOptions?.signal),
        });
      },
      async listResourceTemplates(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.listResourceTemplates) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await adapter.listResourceTemplates(request, {
          ...callOptions,
          signal: callerSignal(callOptions?.signal),
        });
      },
      async subscribeResource(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.subscribeResource) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        // 先登记：订阅仍在进行时租约释放，也要退订这条等待中的登记。失败也不删除：
        // 退订不存在的键不发请求，多登记无害；删除反而会漏掉同键并发订阅中成功的那次。
        const keys = subscriptions.get(request.serverName) ?? new Set<string>();
        subscriptions.set(
          request.serverName,
          keys.add(JSON.stringify([request.uri, request.subscriberKey])),
        );
        await adapter.subscribeResource(request, {
          ...callOptions,
          signal: callerSignal(callOptions?.signal),
        });
      },
      async unsubscribeResource(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        subscriptions
          .get(request.serverName)
          ?.delete(JSON.stringify([request.uri, request.subscriberKey]));
        if (!adapter.unsubscribeResource) return;
        await adapter.unsubscribeResource(request, {
          ...callOptions,
          signal: callerSignal(callOptions?.signal),
        });
      },
      async unsubscribeResourcesBySubscriber(prefix) {
        for (const keys of subscriptions.values())
          for (const item of keys)
            if ((JSON.parse(item) as [string, string])[1].startsWith(prefix)) keys.delete(item);
        let released = 0;
        const seen = new Set<string>();
        for (const key of leased.values()) {
          if (seen.has(key)) continue;
          seen.add(key);
          const adapter = entries.get(key)?.adapter;
          if (adapter?.unsubscribeResourcesBySubscriber) {
            released += await adapter.unsubscribeResourcesBySubscriber(prefix);
          }
        }
        return released;
      },
      close(): Promise<void> {
        leaseClosed = true;
        leaseShutdown.abort(new Error("MCP session lease closed"));
        for (const listener of leaseListeners) snapshotListeners.delete(listener);
        leaseListeners.clear();
        leaseClose ??= Promise.allSettled(
          [...leased.keys()].map((name) => release(name, false, true)),
        ).then((results) => {
          const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (errors.length) throw new AggregateError(errors, "MCP lease cleanup failed");
        });
        return leaseClose;
      },
      async connectConfiguredServers(
        servers: Record<string, McpServerConfig>,
        connectOptions: McpConnectOptions = {},
      ): Promise<McpConnectionSnapshot> {
        assertOpen();
        callerSignal(connectOptions.signal).throwIfAborted();
        configuredServers.clear();
        for (const [serverName, config] of Object.entries(servers)) {
          configuredServers.set(serverName, config);
        }
        const configuredNames = new Set(Object.keys(servers));
        for (const serverName of [...leased.keys()]) {
          if (!configuredNames.has(serverName)) release(serverName, true);
        }
        await Promise.all(
          Object.entries(servers).map(([serverName, config]) =>
            acquire(serverName, config, connectOptions),
          ),
        );
        callerSignal(connectOptions.signal).throwIfAborted();
        return await wait(snapshot(), callerSignal(connectOptions.signal));
      },
      async connectServer(
        serverName: string,
        config: McpServerConfig,
        connectOptions: McpConnectOptions = {},
      ): Promise<McpServerStatus> {
        return await acquire(serverName, config, connectOptions);
      },
      async disconnectServer(serverName: string): Promise<McpServerStatus | undefined> {
        const key = leased.get(serverName);
        const entry = key ? entries.get(key) : undefined;
        const status = entry ? (await entry.adapter.status())[serverName] : undefined;
        release(serverName);
        return status
          ? {
              ...status,
              status: "disconnected",
              toolCount: 0,
              updatedAt: new Date().toISOString(),
            }
          : undefined;
      },
      async listTools(): Promise<McpToolDescriptor[]> {
        return (await snapshot()).tools;
      },
      getToolSnapshot(): Record<string, McpServerToolSnapshot> {
        const result: Record<string, McpServerToolSnapshot> = {};
        for (const [serverName, key] of leased) {
          const entry = entries.get(key);
          if (!entry) continue;
          const adapterSnapshot = entry.adapter.getToolSnapshot();
          const current = adapterSnapshot[serverName];
          if (current) {
            // 版本号带连接 ID：同名 server 换成新的池化连接后，版本不会与旧连接撞号。
            result[serverName] = current.toolsVersion
              ? {
                  ...current,
                  toolsVersion: `${entry.connectionContext.mcpConnectionId}:${current.toolsVersion}`,
                }
              : current;
          }
        }
        return result;
      },
      async waitForServer(
        serverName: string,
        waitOptions: McpWaitForServerOptions,
      ): Promise<{ timedOut: boolean }> {
        waitOptions.signal?.throwIfAborted();
        const key = leased.get(serverName);
        const entry = key ? entries.get(key) : undefined;
        if (!entry) return { timedOut: false };
        return (
          (await entry.adapter.waitForServer?.(serverName, waitOptions)) ?? { timedOut: false }
        );
      },
      async pingServer(serverName: string, pingOptions?: { timeoutMs?: number }): Promise<boolean> {
        const key = leased.get(serverName);
        const entry = key ? entries.get(key) : undefined;
        if (!entry) return false;
        return (await entry.adapter.pingServer?.(serverName, pingOptions)) ?? true;
      },
      async status(): Promise<Record<string, McpServerStatus>> {
        return (await snapshot()).statuses;
      },
    };
  };

  return {
    acquireLease,
    async close(): Promise<void> {
      closed = true;
      const pending = [...entries.values()];
      entries.clear();
      await Promise.all(pending.map(closeEntry));
    },
    stats() {
      return {
        activeConnections: entries.size,
        pendingCloseConnections: [...entries.values()].filter((entry) => entry.refs.size === 0)
          .length,
      };
    },
  };
}

function createConnectionContext(input: {
  config: McpServerConfig;
  connectOptions: McpConnectOptions;
  sessionId?: string;
}): McpConnectionContext {
  const mcpIsolation = input.config.isolation === "workspace" ? "workspace" : "session";
  const workspaceKey = resolveWorkspaceKey(input.connectOptions);
  return {
    mcpConnectionId: randomUUID(),
    mcpIsolation,
    ...(workspaceKey ? { workspaceKey } : {}),
    ...(mcpIsolation === "session" && input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

function resolveWorkspaceKey(connectOptions: McpConnectOptions): string | undefined {
  return (
    connectOptions.workspaceIdentity?.trim() || connectOptions.workingDirectory?.trim() || undefined
  );
}

function connectionKey(input: {
  config: McpServerConfig;
  connectOptions: McpConnectOptions;
  leaseId: string;
  serverName: string;
}): string {
  // 默认 session isolation；只有明确声明 workspace 的无状态 server 才允许跨 session 复用。
  // 共享按工作目录分组（stdio 进程的 cwd）；会话 key 也进入分组，因为 adapter 在创建时固定 key，
  // 同一 cwd 下 key 不同的会话（例如受管 worktree 目录又被单独添加为项目）若复用连接，官方 MCP
  // 授权头会按第一个会话的 key 路由（MR !3520 review SG-01）。
  const scope =
    input.config.isolation === "workspace"
      ? [
          resolveWorkspaceKey(input.connectOptions) ?? "",
          input.connectOptions.workspaceKey ?? "",
        ].join("\u0000")
      : input.leaseId;
  return [input.serverName, scope, mcpConfigKey(input.config)].join("\u0000");
}
