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
  McpToolCallResult,
  McpToolDescriptor,
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
  connecting: Promise<McpServerStatus>;
  key: string;
  refs: Set<string>;
  /** 同一 entry 的并发存活校验共享一次探测，避免重复 ping / 重复重连。 */
  revalidating?: Promise<void>;
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

  // 设置页的 mcpPort 是进程级的 `protocol-settings` lease，connectionKey 只由
  // serverName + leaseId + config 组成，配置没变时每次 mcp/list 都命中同一个 entry 并直接返回
  // 首次连接那个早已 resolve 的 promise——不重连、不探测、不打日志。HTTP/SSE MCP 被停掉又不会
  // 派发 onclose，于是设置页永远显示"已连接并可用"，点多少次刷新都不变。
  // 这里在显式要求 revalidate 时先确认连接仍然存活，已死则在同一个 entry 上原地重连
  // （保持 entry 身份，其他共享该连接的 lease 不会被打断成 "not leased"）。
  const revalidateEntry = async (
    entry: PoolEntry,
    config: McpServerConfig,
    connectOptions: McpConnectOptions,
  ): Promise<void> => {
    if (entry.revalidating) {
      await entry.revalidating;
      return;
    }
    const run = (async () => {
      const connected = await entry.connecting.then(
        () => true,
        () => false,
      );
      const state = connected
        ? (await entry.adapter.status())[entry.serverName]?.status
        : undefined;
      // 进行中的握手（含 OAuth 待授权）和显式停用/待信任状态不打扰：
      // 重连会作废浏览器里已打开的授权 URL 和 PKCE/state。
      if (state === "connecting" || state === "disabled" || state === "untrusted") {
        return;
      }
      if (state === "connected") {
        const alive = (await entry.adapter.pingServer?.(entry.serverName)) ?? true;
        if (alive) {
          logger?.debug("MCP pooled connection revalidated", {
            ...entry.connectionContext,
            event: "mcp.pool.connection.revalidated",
            mcpServerName: entry.serverName,
            status: "completed",
          });
          return;
        }
      }
      logger?.warn("MCP pooled connection is stale; reconnecting", {
        ...entry.connectionContext,
        event: "mcp.pool.connection.stale",
        mcpConnectionState: state ?? "unknown",
        mcpServerName: entry.serverName,
        status: "started",
      });
      entry.controller.signal.throwIfAborted();
      entry.connecting = entry.adapter.connectServer(entry.serverName, config, {
        ...connectOptions,
        signal: entry.controller.signal,
      });
      // 失败由 status()/调用方 await entry.connecting 表达，这里不重复冒泡。
      await entry.connecting.catch(() => undefined);
    })();
    entry.revalidating = run.finally(() => {
      entry.revalidating = undefined;
    });
    await entry.revalidating;
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
    let sessionStartupReported = false;

    const requireEntry = (serverName: string): PoolEntry => {
      assertOpen();
      const key = leased.get(serverName);
      const entry = key ? entries.get(key) : undefined;
      if (!entry) throw new Error(`MCP server is not leased by this session: ${serverName}`);
      return entry;
    };

    const release = (serverName: string, immediate = false): Promise<void> | undefined => {
      const key = leased.get(serverName);
      if (!key) return;
      leased.delete(serverName);
      invalidateApps(serverName);
      const entry = entries.get(key);
      if (!entry) return;
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
        if (immediate && entry.connectionContext.mcpIsolation === "session")
          return closeEntry(entry);
        scheduleClose(entry);
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
      const reused = entry !== undefined;
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
        entry = {
          adapter,
          controller,
          connectionContext,
          connecting: adapter.connectServer(serverName, config, {
            ...connectOptions,
            signal: controller.signal,
          }),
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
            if (previous.refs.size === 0) scheduleClose(previous);
          }
        }
      }
      leased.set(serverName, key);
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
      // 引用登记先于任何等待；close 与 revalidate 交错也不会产生迟到 lease。
      if (reused && connectOptions.revalidate)
        await wait(revalidateEntry(entry, config, connectOptions), signal);
      return await wait(entry.connecting, signal);
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

    return {
      async waitForAppConnection(serverName) {
        const key = leased.get(serverName);
        if (!key) return null;
        const entry = entries.get(key);
        if (!entry) return null;
        const connecting = entry.connecting;
        try {
          await wait(connecting);
          const source = entry.adapter.waitForAppConnection
            ? await wait(entry.adapter.waitForAppConnection(serverName))
            : (entry.adapter.appConnectionSnapshot?.(serverName) ?? null);
          // 共享连接可能仍被其它会话持有；等待结束不能复活已释放或换源的本会话 lease。
          return !leaseClosed &&
            leased.get(serverName) === key &&
            entries.get(key) === entry &&
            entry.connecting === connecting
            ? source
            : null;
        } catch (error) {
          if (leaseClosed) return null;
          throw error;
        }
      },
      appConnectionSnapshot(serverName) {
        const key = leased.get(serverName);
        return key ? (entries.get(key)?.adapter.appConnectionSnapshot?.(serverName) ?? null) : null;
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
        return await requireEntry(request.serverName).adapter.callTool(request, {
          ...callOptions,
          signal: callerSignal(callOptions?.signal),
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
        await adapter.subscribeResource(request, {
          ...callOptions,
          signal: callerSignal(callOptions?.signal),
        });
      },
      async unsubscribeResource(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.unsubscribeResource) return;
        await adapter.unsubscribeResource(request, {
          ...callOptions,
          signal: callerSignal(callOptions?.signal),
        });
      },
      async unsubscribeResourcesBySubscriber(prefix) {
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
        leaseClose ??= Promise.allSettled(
          [...leased.keys()].map((name) => release(name, true)),
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
          if (!configuredNames.has(serverName)) release(serverName);
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
      toolListRevision(): number {
        let revision = 0;
        for (const key of new Set(leased.values())) {
          revision += entries.get(key)?.adapter.toolListRevision?.() ?? 0;
        }
        return revision;
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
  return [input.serverName, scope, stableStringify(input.config)].join("\u0000");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
