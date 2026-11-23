import {
  createMcpDeadline,
  McpTimeoutError,
  waitWithinMcpDeadline,
  withTimeout,
} from "../src/mcp/timeout.js";
import { createMcpConnectionPool } from "../src/mcp/pool.js";
import { delimiter, dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SdkError, SdkErrorCode, UnauthorizedError } from "@modelcontextprotocol/client";
import { ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY } from "@zcode/shared";
import type { SharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";

const {
  capturedClientInfo,
  capturedClients,
  capturedHttpOptions,
  capturedSseOptions,
  capturedStdioOptions,
  capturedStdioStderrHandlers,
  capturedClientOptions,
  clientCloseMock,
  clientCallToolMock,
  clientConnectMock,
  clientListToolsMock,
  clientPingMock,
  clientSubscribeMock,
  clientUnsubscribeMock,
  transportCloseMock,
  transportFinishAuthMock,
  authMock,
} = vi.hoisted(() => ({
  capturedClientInfo: [] as Array<{ name: string; version: string }>,
  capturedClients: [] as Array<{
    notificationHandlers: Map<string, (notification: unknown) => void>;
    onclose?: () => void;
  }>,
  capturedHttpOptions: [] as unknown[],
  capturedSseOptions: [] as unknown[],
  capturedStdioOptions: [] as unknown[],
  capturedStdioStderrHandlers: [] as Array<(chunk: Buffer) => void>,
  capturedClientOptions: [] as unknown[],
  clientCloseMock: vi.fn(async () => {}),
  clientCallToolMock: vi.fn(async () => ({
    content: [{ type: "text", text: "ok" }],
  })),
  clientConnectMock: vi.fn(async () => {}),
  clientListToolsMock: vi.fn(async () => ({ tools: [] })),
  clientPingMock: vi.fn(async () => ({})),
  clientSubscribeMock: vi.fn(async () => ({})),
  clientUnsubscribeMock: vi.fn(async () => ({})),
  transportCloseMock: vi.fn(async () => {}),
  transportFinishAuthMock: vi.fn(async () => {}),
  authMock: vi.fn(async () => "AUTHORIZED" as const),
}));

vi.mock("@modelcontextprotocol/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/client")>();
  return {
    ...actual,
    auth: authMock,
    Client: class {
      readonly close = clientCloseMock;
      readonly callTool = clientCallToolMock;
      readonly connect = clientConnectMock;
      readonly listTools = clientListToolsMock;
      readonly ping = clientPingMock;
      readonly subscribeResource = clientSubscribeMock;
      readonly unsubscribeResource = clientUnsubscribeMock;
      getServerCapabilities() {
        return { resources: { subscribe: true } };
      }
      readonly notificationHandlers = new Map<string, (notification: unknown) => void>();
      onclose?: () => void;

      setNotificationHandler(method: string, handler: (notification: unknown) => void) {
        this.notificationHandlers.set(method, handler);
      }

      constructor(info: { name: string; version: string }, options?: unknown) {
        capturedClientInfo.push(info);
        capturedClientOptions.push(options);
        capturedClients.push(this);
      }

      getProtocolEra() {
        const options = capturedClientOptions.at(-1) as {
          versionNegotiation?: { mode?: unknown };
        };
        return options?.versionNegotiation?.mode === "legacy" ? "legacy" : "modern";
      }

      getNegotiatedProtocolVersion() {
        const options = capturedClientOptions.at(-1) as {
          versionNegotiation?: { mode?: unknown };
        };
        return options?.versionNegotiation?.mode === "legacy" ? "2025-11-25" : "2026-07-28";
      }
    },
    SSEClientTransport: class {
      readonly close = transportCloseMock;
      readonly finishAuth = transportFinishAuthMock;

      constructor(_url: URL, options: unknown) {
        capturedSseOptions.push(options);
      }
    },
    StreamableHTTPClientTransport: class {
      readonly close = transportCloseMock;
      readonly finishAuth = transportFinishAuthMock;

      constructor(_url: URL, options: unknown) {
        capturedHttpOptions.push(options);
      }
    },
  };
});

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: class {
    readonly close = transportCloseMock;
    readonly pid = 42_424;
    readonly stderr = {
      on: vi.fn((event: "data", handler: (chunk: Buffer) => void) => {
        if (event === "data") capturedStdioStderrHandlers.push(handler);
      }),
    };

    constructor(options: unknown) {
      capturedStdioOptions.push(options);
    }
  },
}));

import { createMcpAdapter } from "../src/mcp/index.js";
import { createMcpTelemetryTracker } from "../src/mcp/telemetry.js";

// 宿主内建的 stdio server（node_repl）：source 只由宿主生成。
const BUILT_IN_STDIO_CONFIG = {
  command: "node",
  source: { kind: "builtin" as const },
  type: "stdio" as const,
};

/**
 * 把 Phase 1 建连做成认证失败，并接管 Phase 2 的 `auth()`：调用 provider 的
 * `redirectToAuthorization()` 暴露授权 URL，然后阻塞在 gate 上，直到测试调用 `release()`。
 *
 * 修复原因：授权 URL 的归属已经从「Phase 1 provider 自己 redirect」改为「Phase 2 事务发布」，
 * 所以这些用例必须走 connect 失败 → 分类 → Phase 2 这条新链路。
 */
function stubInteractiveAuthorization(
  authorizationUrl: string,
  beforeAuthorization?: Promise<void>,
): { release: () => void; ready: Promise<void> } {
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let connectAttempts = 0;
  clientConnectMock.mockImplementation(async () => {
    connectAttempts += 1;
    // 第一次建连以确定性认证错误失败，触发 Phase 2；授权完成后的重连必须成功。
    if (connectAttempts === 1) throw new UnauthorizedError();
  });
  authMock.mockImplementation(async (provider: unknown) => {
    const interactiveProvider = provider as {
      redirectToAuthorization(url: URL): Promise<void>;
    };
    await beforeAuthorization;
    await interactiveProvider.redirectToAuthorization(new URL(authorizationUrl));
    markReady();
    await gate;
    return "AUTHORIZED" as const;
  });
  return { release, ready };
}

async function observePromiseWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<
  | { status: "fulfilled"; value: T }
  | { reason: unknown; status: "rejected" }
  | { status: "pending" }
> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const observed = promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ reason, status: "rejected" as const }),
  );
  try {
    return await Promise.race([
      observed,
      new Promise<{ status: "pending" }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ status: "pending" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

describe("createMcpAdapter", () => {
  beforeEach(() => {
    capturedClientInfo.length = 0;
    capturedHttpOptions.length = 0;
    capturedSseOptions.length = 0;
    capturedStdioOptions.length = 0;
    capturedStdioStderrHandlers.length = 0;
    capturedClientOptions.length = 0;
    capturedClients.length = 0;
    clientCloseMock.mockClear();
    clientCallToolMock.mockClear();
    clientConnectMock.mockClear();
    clientListToolsMock.mockReset();
    clientSubscribeMock.mockReset().mockResolvedValue({});
    clientUnsubscribeMock.mockReset().mockResolvedValue({});
    clientPingMock.mockClear();
    clientPingMock.mockResolvedValue({});
    transportCloseMock.mockClear();
    transportFinishAuthMock.mockClear();
    authMock.mockClear();
    authMock.mockResolvedValue("AUTHORIZED");
    clientConnectMock.mockResolvedValue(undefined);
    clientListToolsMock.mockResolvedValue({ tools: [] });
    clientCallToolMock.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("close waits for cancelled handshake resource cleanup before returning", async () => {
    const started = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const cleaned = Promise.withResolvers<void>();
    clientConnectMock.mockImplementationOnce(async () => {
      started.resolve();
      await new Promise(() => {});
    });
    clientCloseMock.mockImplementationOnce(async () => {
      cleanupStarted.resolve();
      await cleaned.promise;
    });
    const adapter = createMcpAdapter();
    const connecting = adapter.connectServer("slow", {
      type: "http",
      url: "https://mcp.example.test/mcp",
    });
    await started.promise;
    let settled = false;
    const closing = adapter.close().then(() => {
      settled = true;
    });
    await cleanupStarted.promise;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(settled).toBe(false);
    cleaned.resolve();
    await closing;
    await connecting;
    expect(await adapter.status()).toEqual({});
  });

  it("does not start a connection while the adapter is closing", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("first", { type: "stdio", command: "node" });
    const closeGate = Promise.withResolvers<void>();
    const connectGate = Promise.withResolvers<void>();
    clientCloseMock.mockImplementationOnce(() => closeGate.promise);
    const closing = adapter.close();
    await vi.waitFor(() => expect(clientCloseMock).toHaveBeenCalled());
    clientConnectMock.mockClear();
    // 持久实现由 beforeEach 复位；未被调用的 once 实现会串到下一个用例。
    clientConnectMock.mockImplementation(() => connectGate.promise);
    // 修复前关闭期间仍会登记新记录；close 清空记录后，连接完成时读不到记录而抛 TypeError。
    const late = adapter.connectServer("late", { type: "stdio", command: "node" });
    closeGate.resolve();
    await closing;
    connectGate.resolve();
    await expect(late).resolves.toMatchObject({ status: "disconnected" });
    expect(clientConnectMock).not.toHaveBeenCalled();
    expect(await adapter.status()).toEqual({});
  });

  it("waits for the existing App connection without exposing a premature snapshot or reconnecting", async () => {
    const gate = Promise.withResolvers<void>();
    clientConnectMock.mockImplementationOnce(() => gate.promise);
    const adapter = createMcpAdapter();
    const connecting = adapter.connectServer("fixture", { type: "stdio", command: "node" });
    await vi.waitFor(() => expect(clientConnectMock).toHaveBeenCalledOnce());
    expect(adapter.appConnectionSnapshot?.("fixture")).toBeNull();
    const settled = vi.fn();
    const opening = adapter.waitForAppConnection!("fixture").then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    gate.resolve();
    await connecting;
    await opening;
    expect(settled).toHaveBeenCalledWith(adapter.appConnectionSnapshot?.("fixture"));
    expect(settled.mock.calls[0]?.[0]).not.toBeNull();
    expect(clientConnectMock).toHaveBeenCalledOnce();
    await adapter.close();
  });

  it("does not issue an App connection for an absent or failed server", async () => {
    const adapter = createMcpAdapter();
    expect(await adapter.waitForAppConnection!("missing")).toBeNull();
    clientConnectMock.mockRejectedValueOnce(new Error("fixture startup failure"));
    await adapter.connectServer("fixture", { type: "stdio", command: "node" });
    expect(await adapter.waitForAppConnection!("fixture")).toBeNull();
    expect(clientConnectMock).toHaveBeenCalledOnce();
    await adapter.close();
  });

  // 相同配置复用当前连接任务，只有配置变更才换代；换代后旧等待者不能拿到新连接。
  it("rejects an App startup waiter after the connection generation is replaced", async () => {
    const gate = Promise.withResolvers<void>();
    clientConnectMock.mockImplementationOnce(() => gate.promise);
    const adapter = createMcpAdapter();
    const config = { type: "stdio" as const, command: "node" };
    const connecting = adapter.connectServer("fixture", config);
    await vi.waitFor(() => expect(clientConnectMock).toHaveBeenCalledOnce());
    const opening = adapter.waitForAppConnection!("fixture");
    const replaced = adapter.connectServer("fixture", { ...config, env: { VERSION: "2" } });
    gate.resolve();
    await Promise.all([connecting, replaced]);
    expect(await opening).toBeNull();
    expect(adapter.appConnectionSnapshot?.("fixture")).not.toBeNull();
    await adapter.close();
  });

  /** 在用例内收集未处理 rejection，不依赖测试框架的全局检测。 */
  async function collectUnhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
    const leaked: unknown[] = [];
    const listener = (reason: unknown) => leaked.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await run();
      // 未处理 rejection 在下一轮事件循环前派发。
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", listener);
    }
    return leaked;
  }

  it.each(["cancelled", "expired"] as const)(
    "observes a shared task rejection after its waiter is already %s",
    async (mode) => {
      const task = Promise.withResolvers<void>();
      const abort = new AbortController();
      abort.abort(new Error("Caller left"));
      const waiting = Promise.resolve().then(() =>
        mode === "cancelled"
          ? withTimeout(task.promise, 1000, "Deadline expired", abort.signal)
          : waitWithinMcpDeadline(task.promise, createMcpDeadline(0), "Deadline expired"),
      );
      const leaked = await collectUnhandledRejections(async () => {
        await expect(waiting).rejects.toThrow(
          mode === "cancelled" ? "Caller left" : "Deadline expired",
        );
        task.reject(new Error("Shared task failed after waiter left"));
      });
      expect(leaked).toEqual([]);
    },
  );

  it("observes subscription work when cancellation and disconnect overlap", async () => {
    const adapter = createMcpAdapter();
    try {
      await adapter.connectServer("demo", { type: "http", url: "https://example.com/mcp" });
      const abort = new AbortController();
      const subscription = adapter.subscribeResource!(
        {
          serverName: "demo",
          uri: "test://closing",
          subscriberKey: "A:scope:1",
        },
        { signal: abort.signal },
      ).catch((error: unknown) => error);
      const leaked = await collectUnhandledRejections(async () => {
        abort.abort(new Error("Caller closing"));
        await adapter.disconnectServer("demo");
        expect(await subscription).toEqual(new Error("Caller closing"));
      });
      expect(leaked).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it("preserves a committed subscription when a duplicate caller is cancelled", async () => {
    const adapter = createMcpAdapter();
    const request = {
      serverName: "demo",
      uri: "test://existing",
      subscriberKey: "session:scope:1",
    };
    try {
      await adapter.connectServer("demo", { type: "http", url: "https://example.com/mcp" });
      await adapter.subscribeResource!(request);
      const abort = new AbortController();
      const duplicate = adapter.subscribeResource!(request, { signal: abort.signal });
      abort.abort(new Error("Duplicate cancelled"));
      await expect(duplicate).rejects.toThrow("Duplicate cancelled");
      expect(await adapter.unsubscribeResourcesBySubscriber!("session:")).toBe(1);
      await adapter.unsubscribeResource!(request);
      expect(clientUnsubscribeMock).toHaveBeenCalledTimes(1);
      expect(clientSubscribeMock).toHaveBeenCalledTimes(1);
    } finally {
      await adapter.close();
    }
  });

  it("keeps another pending subscription with the same key when one caller leaves", async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    clientSubscribeMock.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return {};
    });
    const adapter = createMcpAdapter();
    const request = {
      serverName: "demo",
      uri: "test://concurrent",
      subscriberKey: "session:scope:1",
    };
    try {
      await adapter.connectServer("demo", { type: "http", url: "https://example.com/mcp" });
      const abort = new AbortController();
      const first = adapter.subscribeResource!(request, { signal: abort.signal });
      await entered.promise;
      const second = adapter.subscribeResource!(request);
      // 首个 RPC 仍由 gate 阻塞，让两个 caller 都登记完再取消其中一个。
      await new Promise<void>((resolve) => setImmediate(resolve));
      abort.abort(new Error("First caller left"));
      await expect(first).rejects.toThrow("First caller left");
      release.resolve();
      await second;
      expect(clientUnsubscribeMock).not.toHaveBeenCalled();
      expect(clientSubscribeMock).toHaveBeenCalledTimes(1);
      expect(await adapter.unsubscribeResourcesBySubscriber!("session:")).toBe(1);
    } finally {
      release.resolve();
      await adapter.close();
    }
  });

  it.each(["explicit", "scope"] as const)(
    "does not revive a subscription removed by %s cleanup during connection wait",
    async (mode) => {
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      clientConnectMock.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
      const adapter = createMcpAdapter();
      const request = { serverName: "demo", uri: "test://late", subscriberKey: "session:scope:1" };
      const connecting = adapter.connectServer("demo", {
        type: "http",
        url: "https://example.com/mcp",
      });
      try {
        await entered.promise;
        const subscribing = adapter.subscribeResource!(request);
        if (mode === "scope") await adapter.unsubscribeResourcesBySubscriber!("session:");
        else await adapter.unsubscribeResource!(request);
        release.resolve();
        await Promise.all([connecting, subscribing]);
        expect(await adapter.unsubscribeResourcesBySubscriber!("session:")).toBe(0);
        expect(clientSubscribeMock).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await adapter.close();
      }
    },
  );

  it.each(["lease", "revalidate", "configured"] as const)(
    "keeps a later %s caller independent of the initial connection wait",
    async (mode) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      clientConnectMock.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
      const adapter = createMcpAdapter();
      const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
      const first = pool.acquireLease(),
        second = pool.acquireLease();
      const config = { type: "stdio" as const, command: "node", isolation: "workspace" as const };
      const scope = { workspaceIdentity: "shared" };
      const starting = first.connectServer("demo", config, scope);
      try {
        await entered.promise;
        const controller = new AbortController();
        const waiting =
          mode === "configured"
            ? adapter.connectConfiguredServers({ demo: config }, { signal: controller.signal })
            : second.connectServer("demo", config, {
                ...scope,
                signal: controller.signal,
                revalidate: mode === "revalidate",
              });
        let finished = false;
        // 经 pool 租约的取消以 reject 结束本次等待；直接调用 adapter 时返回当前状态。
        const settled = waiting.then(
          () => "resolved",
          () => "rejected",
        );
        void settled.then(() => {
          finished = true;
        });
        controller.abort();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(finished).toBe(true);
        expect(await settled).toBe(mode === "configured" ? "resolved" : "rejected");
        expect(adapter.getToolSnapshot().demo.status.status).toBe("connecting");
        release.resolve();
        await starting;
        expect(clientConnectMock).toHaveBeenCalledOnce();
        expect((await first.callTool({ serverName: "demo", toolName: "ping" })).content).toEqual([
          { type: "text", text: "ok" },
        ]);
      } finally {
        release.resolve();
        await starting;
        await pool.close();
      }
    },
  );

  it.each(["initial", "recovery"] as const)(
    "continues a list_changed received during %s discovery without another read or notification",
    async (phase) => {
      const adapter = createMcpAdapter();
      const config = { type: "http" as const, url: "https://mcp.example.test" };
      const tool = (name: string) => ({ name, inputSchema: { type: "object", properties: {} } });
      const refreshed = Promise.withResolvers<void>();
      const off = adapter.onSnapshotChanged!(() => {
        if (adapter.getToolSnapshot().demo?.tools?.[0]?.toolName === "new") refreshed.resolve();
      });
      try {
        if (phase === "recovery") await adapter.connectServer("demo", config);
        clientListToolsMock.mockImplementationOnce(async () => {
          capturedClients.at(-1)!.notificationHandlers.get("notifications/tools/list_changed")!({});
          await new Promise<void>((resolve) => setImmediate(resolve));
          return { tools: [tool("old")] };
        });
        clientListToolsMock.mockResolvedValueOnce({ tools: [tool("new")] });
        if (phase === "recovery") {
          capturedClients.at(-1)!.onclose?.();
          await adapter.waitForServer!("demo", { timeoutMs: 1000 });
        } else await adapter.connectServer("demo", config);
        await withTimeout(refreshed.promise, 300, "dirty discovery was not resumed");
        expect(adapter.getToolSnapshot().demo.tools?.[0]?.toolName).toBe("new");
      } finally {
        off();
        await adapter.close();
      }
    },
  );

  it("does not inherit a settled caller wait and keeps independent timeout budgets", async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    clientConnectMock.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const adapter = createMcpAdapter();
    const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
    const a = pool.acquireLease(),
      b = pool.acquireLease();
    const config = { type: "stdio" as const, command: "node", isolation: "workspace" as const };
    const options = { workspaceIdentity: "shared" };
    const abort = new AbortController();
    const initial = a.connectServer("demo", config, { ...options, signal: abort.signal });
    try {
      await entered.promise;
      abort.abort();
      // 租约侧取消以 reject 结束首个调用方的等待；连接本身仍在进行。
      await expect(initial).rejects.toThrow();
      expect(adapter.getToolSnapshot().demo.status.status).toBe("connecting");
      expect(
        (await b.connectServer("demo", config, { ...options, oauthAuthorizationTimeoutMs: 5 }))
          .status,
      ).toBe("connecting");
      let complete = false;
      const survivor = b.connectServer("demo", config, options).then((status) => {
        complete = true;
        return status;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(complete).toBe(false);
      release.resolve();
      expect((await survivor).status).toBe("connected");
      expect(clientConnectMock).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await initial.catch(() => undefined);
      await pool.close();
    }
  });

  it("hands a notification at refresh completion to the next refresh", async () => {
    const adapter = createMcpAdapter();
    const tool = (name: string) => ({ name, inputSchema: { type: "object", properties: {} } });
    await adapter.connectServer("demo", { type: "stdio", command: "node" });
    const notify = () =>
      capturedClients.at(-1)!.notificationHandlers.get("notifications/tools/list_changed")!({});
    clientListToolsMock
      .mockResolvedValueOnce({ tools: [tool("first")] })
      .mockResolvedValueOnce({ tools: [tool("last")] });
    const finished = Promise.withResolvers<void>();
    const off = adapter.onSnapshotChanged!(() => {
      const name = adapter.getToolSnapshot().demo.tools?.[0]?.toolName;
      if (name === "first") notify();
      if (name === "last") finished.resolve();
    });
    try {
      notify();
      await withTimeout(finished.promise, 500, "notification lost during task handoff");
      expect(clientListToolsMock).toHaveBeenCalledTimes(3);
    } finally {
      off();
      await adapter.close();
    }
  });

  it.each(["subscribe", "unsubscribe"] as const)(
    "serializes a changed resource intent while %s is in flight",
    async (operation) => {
      const adapter = createMcpAdapter();
      await adapter.connectServer("demo", { type: "stdio", command: "node" });
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const first = { serverName: "demo", uri: "test://resource", subscriberKey: "first" };
      const second = { ...first, subscriberKey: "second" };
      const events: string[] = [];
      clientSubscribeMock.mockImplementation(async () => {
        events.push("subscribe");
        return {};
      });
      clientUnsubscribeMock.mockImplementation(async () => {
        events.push("unsubscribe");
        return {};
      });
      if (operation === "unsubscribe") await adapter.subscribeResource!(first);
      const blocked = operation === "subscribe" ? clientSubscribeMock : clientUnsubscribeMock;
      blocked.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        events.push(operation);
        return {};
      });
      const pending =
        operation === "subscribe"
          ? adapter.subscribeResource!(first)
          : adapter.unsubscribeResource!(first);
      try {
        await entered.promise;
        const latest =
          operation === "subscribe"
            ? adapter.unsubscribeResource!(first)
            : adapter.subscribeResource!(second);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(events).toEqual(operation === "subscribe" ? [] : ["subscribe"]);
        release.resolve();
        await Promise.all([pending, latest]);
        expect(events).toEqual(
          operation === "subscribe"
            ? ["subscribe", "unsubscribe"]
            : ["subscribe", "unsubscribe", "subscribe"],
        );
      } finally {
        release.resolve();
        await pending;
        await adapter.close();
      }
    },
  );

  it("does not publish a discovery result after its client closed", async () => {
    clientListToolsMock.mockImplementationOnce(async () => {
      capturedClients.at(-1)!.onclose?.();
      return { tools: [] };
    });
    const adapter = createMcpAdapter();
    try {
      const status = await adapter.connectServer("demo", { type: "stdio", command: "node" });
      expect(status.status).toBe("failed");
      expect(adapter.appConnectionSnapshot!("demo")).toBeNull();
      expect(adapter.getToolSnapshot().demo.tools).toBeUndefined();
    } finally {
      await adapter.close();
    }
  });

  it("cancels only the initial caller wait while the shared connection keeps starting", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    clientConnectMock.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
    });
    const adapter = createMcpAdapter();
    const controller = new AbortController();
    const connecting = adapter.connectServer(
      "demo",
      { type: "stdio", command: "node" },
      { signal: controller.signal },
    );
    try {
      await started.promise;
      controller.abort();
      expect((await connecting).status).toBe("connecting");
      release.resolve();
      expect(await adapter.waitForServer!("demo", { timeoutMs: 1000 })).toEqual({
        timedOut: false,
      });
      expect(adapter.getToolSnapshot().demo.status.status).toBe("connected");
      expect(clientConnectMock).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await adapter.close();
    }
  });

  it("retains pending tools through recovery attempts and clears them only on exhaustion", async () => {
    vi.useFakeTimers();
    const adapter = createMcpAdapter();
    const observed: Array<{ status: string; tools: number | undefined }> = [];
    try {
      clientListToolsMock.mockResolvedValueOnce({
        tools: [{ name: "ping", inputSchema: { type: "object" } }],
      } as never);
      await adapter.connectServer("demo", { type: "http", url: "https://mcp.example.test" });
      clientListToolsMock.mockRejectedValue(new Error("discovery unavailable"));
      adapter.onSnapshotChanged!(() => {
        const row = adapter.getToolSnapshot().demo;
        observed.push({ status: row.status.status, tools: row.tools?.length });
      });
      capturedClients.at(-1)!.onclose!();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(clientConnectMock).toHaveBeenCalledTimes(6);
      expect(observed.at(-1)).toEqual({ status: "failed", tools: undefined });
      expect(observed.slice(0, -1).length).toBeGreaterThan(0);
      expect(
        observed.slice(0, -1).every((row) => row.status === "connecting" && row.tools === 1),
      ).toBe(true);
      expect(adapter.getToolSnapshot().demo.recovering).toBeUndefined();
    } finally {
      await adapter.close();
      vi.useRealTimers();
    }
  });

  it("notifies terminal failure after delayed connection cleanup, without emitting on reads", async () => {
    const closing = Promise.withResolvers<void>();
    clientListToolsMock.mockRejectedValueOnce(new Error("discovery failed"));
    clientCloseMock.mockImplementationOnce(() => closing.promise);
    const adapter = createMcpAdapter();
    const states: string[] = [];
    adapter.onSnapshotChanged!(() => {
      states.push(adapter.getToolSnapshot().demo?.status.status ?? "missing");
    });
    const connecting = adapter.connectServer("demo", { type: "stdio", command: "node" });
    await vi.waitFor(() => expect(clientCloseMock).toHaveBeenCalled());
    closing.resolve();
    await connecting;
    await Promise.resolve();
    expect(states.at(-1)).toBe("failed");
    const count = states.length;
    adapter.getToolSnapshot();
    await adapter.status();
    adapter.getToolSnapshot();
    await Promise.resolve();
    expect(states).toHaveLength(count);
    await adapter.close();
  });

  it("commits replacement, removal and disablement before awaiting old connection close", async () => {
    const adapter = createMcpAdapter();
    const config = { type: "stdio" as const, command: "server-a" };
    clientListToolsMock.mockResolvedValue({
      tools: [{ name: "old", inputSchema: { type: "object" } }],
    } as never);
    await adapter.connectConfiguredServers({ replaced: config, removed: config, disabled: config });
    const closing = Promise.withResolvers<void>();
    clientCloseMock.mockImplementationOnce(() => closing.promise);
    const pending = adapter.connectConfiguredServers({
      replaced: { ...config, command: "server-b" },
      disabled: { ...config, enabled: false },
    });
    try {
      const snapshot = adapter.getToolSnapshot!();
      expect(snapshot.replaced?.status.status).toBe("connecting");
      expect(snapshot.replaced?.tools).toBeUndefined();
      expect(snapshot.removed?.status.status).toBe("disconnected");
      expect(snapshot.disabled?.status.status).toBe("disabled");
    } finally {
      closing.resolve();
      await pending;
      await adapter.close();
    }
  });

  it.each(["disconnect", "disable"] as const)(
    "late %s completion cannot overwrite a newer connection",
    async (action) => {
      const adapter = createMcpAdapter();
      const config = { type: "stdio" as const, command: "server-a" };
      await adapter.connectServer("demo", config);
      const closing = Promise.withResolvers<void>();
      clientCloseMock.mockImplementationOnce(() => closing.promise);
      const old =
        action === "disconnect"
          ? adapter.disconnectServer("demo")
          : adapter.connectServer("demo", { ...config, enabled: false });
      try {
        await adapter.connectServer("demo", { ...config, command: "server-b" });
        closing.resolve();
        await old;
        expect(adapter.getToolSnapshot!().demo?.status.status).toBe("connected");
      } finally {
        closing.resolve();
        await old;
        await adapter.close();
      }
    },
  );

  it("authorizes once and retries a tool call that hit an OAuth error", async () => {
    const descriptor = {
      name: "oauth_ping",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    };
    clientListToolsMock.mockResolvedValue({ tools: [descriptor] } as never);
    const adapter = createMcpAdapter();
    await adapter.connectServer("runtime", {
      type: "http",
      url: "https://mcp.example.test/mcp",
      oauth: { type: "authorization_code" },
    });
    // 模型调用不固定定义：授权后的新连接只要仍提供该工具即可重试。
    clientListToolsMock.mockResolvedValue({
      tools: [{ ...descriptor, annotations: { readOnlyHint: false } }],
    } as never);
    clientCallToolMock
      .mockRejectedValueOnce(new UnauthorizedError())
      .mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    try {
      await expect(
        adapter.callTool({ serverName: "runtime", toolName: "oauth_ping" }),
      ).resolves.toMatchObject({ content: [{ text: "ok" }] });
      expect(authMock).toHaveBeenCalledTimes(1);
      expect(clientCallToolMock).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close();
    }
  });

  it("accepts an OAuth recovery whose status object changed after unrelated list refresh", async () => {
    const target = { name: "ping", inputSchema: { type: "object" } };
    clientListToolsMock.mockResolvedValue({ tools: [target] } as never);
    const adapter = createMcpAdapter();
    await adapter.connectServer("runtime", {
      type: "http",
      url: "https://mcp.example.test/mcp",
      oauth: { type: "authorization_code" },
    });
    let refreshed = false;
    const unsubscribe = adapter.onSnapshotChanged!(() => {
      if (
        capturedClients.length === 2 &&
        adapter.getToolSnapshot().runtime?.status.status === "connected" &&
        !refreshed
      ) {
        refreshed = true;
        clientListToolsMock.mockResolvedValue({
          tools: [target, { name: "other", inputSchema: { type: "object" } }],
        } as never);
        capturedClients.at(-1)!.notificationHandlers.get("notifications/tools/list_changed")!({});
      }
    });
    clientCallToolMock.mockRejectedValueOnce(new UnauthorizedError());
    try {
      await expect(
        adapter.callTool({ serverName: "runtime", toolName: "ping" }),
      ).resolves.toMatchObject({ content: [{ text: "ok" }] });
      expect(refreshed).toBe(true);
      expect(clientCallToolMock).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      await adapter.close();
    }
  });

  it.each([
    ["a local not-connected error", "http", SdkErrorCode.NotConnected, "Not connected", 1],
    ["a connection-closed error", "http", SdkErrorCode.ConnectionClosed, "Connection closed", 2],
    [
      "a connection-closed code with other text",
      "http",
      SdkErrorCode.ConnectionClosed,
      "Not connected",
      2,
    ],
    [
      "a stdio connection-closed error",
      "stdio",
      SdkErrorCode.ConnectionClosed,
      "Connection closed",
      1,
    ],
  ] as const)(
    "retries a call once only for HTTP connection-closed errors: %s",
    async (_label, type, code, message, calls) => {
      const target = { name: "ping", inputSchema: { type: "object" } };
      clientListToolsMock.mockResolvedValue({ tools: [target] } as never);
      const adapter = createMcpAdapter();
      await adapter.connectServer(
        "demo",
        type === "http" ? { type, url: "https://mcp.example.test/mcp" } : { type, command: "node" },
      );
      clientCallToolMock.mockRejectedValueOnce(new SdkError(code, message));
      try {
        const call = adapter.callTool({ serverName: "demo", toolName: "ping" });
        if (calls === 2) await expect(call).resolves.toMatchObject({ content: [{ text: "ok" }] });
        else await expect(call).rejects.toThrow();
        expect(clientCallToolMock).toHaveBeenCalledTimes(calls);
      } finally {
        await adapter.close();
      }
    },
  );

  it("does not retry on a replaced configuration after the connection closes", async () => {
    clientListToolsMock.mockResolvedValue({
      tools: [{ name: "ping", inputSchema: { type: "object" } }],
    } as never);
    const adapter = createMcpAdapter();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    clientCallToolMock.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed");
    });
    await adapter.connectServer("demo", { type: "http", url: "https://old.example.test/mcp" });
    const call = adapter.callTool({ serverName: "demo", toolName: "ping" });
    const observed = call.then(
      () => "called",
      () => "rejected",
    );
    try {
      await entered.promise;
      await adapter.connectServer("demo", { type: "http", url: "https://new.example.test/mcp" });
      const replacement = adapter.appConnectionSnapshot!("demo");
      release.resolve();
      expect(await observed).toBe("rejected");
      expect(adapter.appConnectionSnapshot!("demo")).toEqual(replacement);
      expect(clientConnectMock).toHaveBeenCalledTimes(2);
      expect(clientCallToolMock).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await observed;
      await adapter.close();
    }
  });

  it("does not replay an authorized call after its lease is revoked during OAuth recovery", async () => {
    const pool = createMcpConnectionPool({
      createAdapter: () => createMcpAdapter(),
      idleGraceMs: 0,
    });
    const caller = pool.acquireLease({ sessionId: "caller" });
    const other = pool.acquireLease({ sessionId: "other" });
    const config = {
      type: "http" as const,
      url: "https://mcp.example.test/mcp",
      oauth: { type: "authorization_code" as const },
      isolation: "workspace" as const,
    };
    clientListToolsMock.mockResolvedValue({
      tools: [{ name: "oauth_ping", inputSchema: { type: "object" } }],
    } as never);
    await caller.connectServer("demo", config);
    await other.connectServer("demo", config);
    const entered = Promise.withResolvers<void>();
    const authorized = Promise.withResolvers<void>();
    authMock.mockImplementationOnce(async () => {
      entered.resolve();
      await authorized.promise;
      return "AUTHORIZED";
    });
    clientCallToolMock
      .mockRejectedValueOnce(new UnauthorizedError())
      .mockResolvedValue({ content: [] });
    const call = caller.callTool({ serverName: "demo", toolName: "oauth_ping" });
    const observed = call.then(
      () => "called",
      (error) => String(error),
    );
    try {
      await entered.promise;
      await caller.connectConfiguredServers({});
      authorized.resolve();
      // 授权完成后本租约已释放：不替它重放调用，返回原授权错误。
      expect(await observed).toMatch(/Unauthorized/);
      expect(clientCallToolMock).toHaveBeenCalledTimes(1);
      expect(other.getToolSnapshot!()?.demo?.status.status).toBe("connected");
    } finally {
      authorized.resolve();
      await observed;
      await caller.close();
      await other.close();
      await pool.close();
    }
  });

  it("forwards runtime scope, session, turn, and trace context through MCP request metadata", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("node_repl", {
      command: "node",
      type: "stdio",
    });

    await adapter.callTool({
      arguments: { code: "1 + 1" },
      serverName: "node_repl",
      toolName: "js",
      runtimeScope: "subagent",
      trace: {
        parentSpanId: "parent-1",
        sessionId: "session-1" as never,
        spanId: "span-1",
        traceId: "trace-1" as never,
        turnId: "turn-1" as never,
      },
    });

    expect(clientCallToolMock).toHaveBeenCalledWith(
      {
        arguments: { code: "1 + 1" },
        name: "js",
        _meta: {
          "com.zcode/request-context": {
            parent_span_id: "parent-1",
            runtime_scope: "subagent",
            session_id: "session-1",
            span_id: "span-1",
            trace_id: "trace-1",
            turn_id: "turn-1",
          },
          parent_span_id: "parent-1",
          runtime_scope: "subagent",
          session_id: "session-1",
          span_id: "span-1",
          trace_id: "trace-1",
          turn_id: "turn-1",
        },
      },
      expect.objectContaining({ resetTimeoutOnProgress: true }),
    );
  });

  it("forwards the root session of a subagent call through MCP request metadata", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("node_repl", { command: "node", type: "stdio" });

    await adapter.callTool({
      arguments: { code: "1 + 1" },
      serverName: "node_repl",
      toolName: "js",
      runtimeScope: "subagent",
      trace: {
        rootSessionId: "session-1" as never,
        sessionId: "subagent-1" as never,
        traceId: "trace-1" as never,
      },
    });

    const meta = clientCallToolMock.mock.calls.at(-1)?.[0]._meta;
    expect(meta).toMatchObject({ root_session_id: "session-1", session_id: "subagent-1" });
    expect(meta["com.zcode/request-context"]).toMatchObject({
      root_session_id: "session-1",
      session_id: "subagent-1",
    });
  });

  it("uses the injected client version for MCP initialize", async () => {
    const adapter = createMcpAdapter({ clientVersion: "9.8.7" });

    await adapter.connectServer("demo", {
      command: "node",
      type: "stdio",
    });

    expect(capturedClientInfo).toEqual([
      {
        name: "zcode",
        version: "9.8.7",
      },
    ]);
  });

  it("logs the configured negotiation policy and actual MCP protocol version", async () => {
    const infoMock = vi.fn();
    const logger = {
      child: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      info: infoMock,
      warn: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    const adapter = createMcpAdapter({
      clientName: "zcode-test",
      clientVersion: "9.8.7",
      connectionContext: {
        mcpConnectionId: "connection-session-1",
        mcpIsolation: "session",
        sessionId: "session-1",
        workspaceKey: "workspace-1",
      },
      logger,
    });

    await adapter.connectServer("auto-modern", {
      command: "node",
      type: "stdio",
    });
    await adapter.connectServer("explicit-legacy", {
      command: "node",
      protocolVersion: "legacy",
      type: "stdio",
    });

    expect(infoMock).toHaveBeenCalledWith(
      "MCP server connected",
      expect.objectContaining({
        event: "mcp.server.connected",
        mcpClientName: "zcode-test",
        mcpClientVersion: "9.8.7",
        mcpConnectionId: "connection-session-1",
        mcpIsolation: "session",
        mcpProtocolEra: "modern",
        mcpProtocolVersion: "2026-07-28",
        mcpServerName: "auto-modern",
        mcpTransportPid: 42_424,
        mcpVersionNegotiationMode: "auto",
        sessionId: "session-1",
        workspaceKey: "workspace-1",
      }),
    );
    expect(infoMock).toHaveBeenCalledWith(
      "MCP server connected",
      expect.objectContaining({
        event: "mcp.server.connected",
        mcpClientName: "zcode-test",
        mcpClientVersion: "9.8.7",
        mcpProtocolEra: "legacy",
        mcpProtocolVersion: "2025-11-25",
        mcpServerName: "explicit-legacy",
        mcpVersionNegotiationMode: "legacy",
      }),
    );
  });

  it("defaults ordinary MCP servers to dual-era auto while keeping explicit era pins", async () => {
    const adapter = createMcpAdapter();

    await adapter.connectServer("browser_use", {
      command: "node",
      protocolVersion: "2026-07-28",
      timeoutMs: 600_000,
      type: "stdio",
    });
    await adapter.connectServer("default-stdio", {
      command: "node",
      type: "stdio",
    });
    await adapter.connectServer("default-http", {
      type: "http",
      url: "https://mcp.example.test",
    });
    await adapter.connectServer("auto-http", {
      protocolVersion: "auto",
      timeoutMs: 2_000,
      type: "http",
      url: "https://mcp.example.test/auto",
    });
    await adapter.connectServer("legacy-http", {
      protocolVersion: "legacy",
      type: "http",
      url: "https://mcp.example.test/legacy",
    });
    await adapter.connectServer("legacy-sse", {
      type: "sse",
      url: "https://mcp.example.test/sse",
    });

    expect(
      capturedClientOptions.map((options) => ({
        versionNegotiation: (options as { versionNegotiation?: unknown }).versionNegotiation,
      })),
    ).toEqual([
      {
        versionNegotiation: {
          mode: { pin: "2026-07-28" },
          probe: { timeoutMs: 600_000 },
        },
      },
      { versionNegotiation: { mode: "auto", probe: { timeoutMs: 5_000 } } },
      { versionNegotiation: { mode: "auto", probe: { timeoutMs: 5_000 } } },
      { versionNegotiation: { mode: "auto", probe: { timeoutMs: 1_000 } } },
      { versionNegotiation: { mode: "legacy" } },
      { versionNegotiation: { mode: "legacy" } },
    ]);
    // MCP Apps：每个 client 都宣告可渲染的 UI mimeType，server 据此决定是否下发 ui 资源。
    for (const options of capturedClientOptions) {
      expect(options).toMatchObject({
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
          },
        },
      });
    }
  });

  it("preserves non-object structuredContent from MCP 2026-07-28", async () => {
    clientCallToolMock.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      structuredContent: ["first", 2, true],
    });
    const adapter = createMcpAdapter();
    await adapter.connectServer("modern", {
      command: "node",
      protocolVersion: "2026-07-28",
      type: "stdio",
    });

    await expect(
      adapter.callTool({
        serverName: "modern",
        toolName: "array-result",
      }),
    ).resolves.toMatchObject({
      structuredContent: ["first", 2, true],
    });
  });

  it("projects server timeout onto listed MCP tool descriptors", async () => {
    clientListToolsMock.mockResolvedValue({
      tools: [
        {
          name: "long-task",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    });
    const adapter = createMcpAdapter();

    await adapter.connectServer("demo", {
      command: "node",
      timeoutMs: 900_000,
      type: "stdio",
    });

    await expect(adapter.listTools()).resolves.toMatchObject([
      {
        serverName: "demo",
        toolName: "long-task",
        name: "mcp__demo__long-task",
        timeoutMs: 900_000,
      },
    ]);
  });

  it("reports connecting status while an MCP server is still starting", async () => {
    let resolveConnect!: () => void;
    clientConnectMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const adapter = createMcpAdapter();

    const connect = adapter.connectServer("demo", {
      command: "node",
      type: "stdio",
    });
    await Promise.resolve();

    await expect(adapter.status()).resolves.toMatchObject({
      demo: {
        status: "connecting",
        transport: "stdio",
        toolCount: 0,
      },
    });

    resolveConnect();
    await expect(connect).resolves.toMatchObject({
      status: "connected",
      toolCount: 0,
    });
  });

  it("bounds callTool waiting for a shared startup connection without cancelling it", async () => {
    let resolveConnect!: () => void;
    clientConnectMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const adapter = createMcpAdapter();
    const connect = adapter.connectServer("demo", {
      command: "node",
      type: "stdio",
    });
    await Promise.resolve();

    const call = adapter.callTool(
      {
        serverName: "demo",
        toolName: "slow-start",
      },
      { timeoutMs: 20 },
    );

    try {
      await expect(observePromiseWithin(call, 200)).resolves.toMatchObject({
        reason: {
          name: "McpTimeoutError",
        },
        status: "rejected",
      });
      await expect(adapter.status()).resolves.toMatchObject({
        demo: { status: "connecting" },
      });
      expect(clientCallToolMock).not.toHaveBeenCalled();
    } finally {
      resolveConnect();
      await Promise.allSettled([connect, call]);
      await adapter.close();
    }

    await expect(adapter.status()).resolves.toEqual({});
  });

  it("includes sanitized recent stdio stderr when MCP server connection fails", async () => {
    const debugMock = vi.fn();
    const warnMock = vi.fn();
    const logger = {
      child: vi.fn(),
      debug: debugMock,
      error: vi.fn(),
      info: vi.fn(),
      warn: warnMock,
    };
    logger.child.mockReturnValue(logger);
    clientConnectMock.mockImplementation(async () => {
      capturedStdioStderrHandlers[0]?.(
        Buffer.from(
          [
            "MYSQL_PASS=super-secret",
            "Authorization: Bearer live-token",
            "fatal: database refused connection",
          ].join("\n"),
        ),
      );
      throw new Error("MCP error -32000: Connection closed");
    });
    const adapter = createMcpAdapter({ logger });

    await expect(
      adapter.connectServer("mysql-local", {
        command: "node",
        type: "stdio",
      }),
    ).resolves.toMatchObject({
      error: expect.stringContaining("fatal: database refused connection"),
      status: "failed",
    });

    expect(debugMock).toHaveBeenCalledWith(
      "MCP stdio stderr",
      expect.objectContaining({
        stderr: expect.stringContaining("fatal: database refused connection"),
      }),
    );
    expect(warnMock).toHaveBeenCalledWith(
      "MCP server connection failed",
      expect.objectContaining({
        error: "MCP error -32000: Connection closed",
        event: "mcp.server.failed",
        stderr: expect.stringContaining("fatal: database refused connection"),
      }),
    );
    const warnContext = warnMock.mock.calls[0]?.[1] as { stderr?: string };
    expect(warnContext.stderr).toContain("MYSQL_PASS=[Redacted]");
    expect(warnContext.stderr).toContain("Authorization: Bearer [Redacted]");
    expect(warnContext.stderr).not.toContain("super-secret");
    expect(warnContext.stderr).not.toContain("live-token");
    const status = (await adapter.status())["mysql-local"];
    expect(status?.error).toContain("MCP error -32000: Connection closed");
    expect(status?.error).toContain("MYSQL_PASS=[Redacted]");
    expect(status?.error).not.toContain("super-secret");
    expect(status?.error).not.toContain("live-token");
    await adapter.close();
  });

  it.each([
    ["python", "ModuleNotFoundError: No module named 'mcp'"],
    ["node", "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'example-mcp'"],
    ["path", "ENOENT: no such file or directory"],
    ["permission", "PermissionError: [Errno 13] Permission denied"],
  ])(
    "exposes bounded sanitized %s startup evidence without changing failure kind",
    async (_name, cause) => {
      clientConnectMock.mockImplementation(async () => {
        capturedStdioStderrHandlers[0]?.(
          Buffer.from(
            "noise".repeat(1_000) +
              "\n\u001b[31m" +
              cause +
              "\u001b[0m\nAPI_TOKEN=fixture-secret\n",
          ),
        );
        throw new Error("Connection closed");
      });
      const adapter = createMcpAdapter();
      try {
        const status = await adapter.connectServer("broken", { command: "node", type: "stdio" });
        expect(status).toMatchObject({ status: "failed", failureKind: "process_start_failed" });
        expect(status.error).toContain(cause);
        expect(status.error).toContain("Connection closed");
        expect(status.error).not.toContain("\u001b");
        expect(status.error).not.toContain("fixture-secret");
        expect(status.error!.length).toBeLessThanOrEqual(4_520);
      } finally {
        await adapter.close();
      }
    },
  );

  it("keeps HTTP failures separate from recent stdio stderr", async () => {
    clientConnectMock.mockRejectedValue(new Error("network unavailable"));
    const adapter = createMcpAdapter();
    try {
      const status = await adapter.connectServer("http-failure", {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer fixture" },
      });
      expect(status.error).toBe("network unavailable");
      expect(status.failureKind).toBe("network_unreachable");
    } finally {
      await adapter.close();
    }
  });

  it("redacts quoted and escaped credential values before exposing stderr", async () => {
    clientConnectMock.mockImplementation(async () => {
      capturedStdioStderrHandlers[0]?.(
        Buffer.from(
          [
            'API_TOKEN="first secret with spaces"',
            String.raw`VE_SPEECH_MCP_TOKEN="second escaped\" secret"`,
            String.raw`{"access_token":"third escaped\" secret"}`,
            "ModuleNotFoundError: No module named 'mcp'",
          ].join("\n"),
        ),
      );
      throw new Error("Connection closed");
    });
    const adapter = createMcpAdapter();
    try {
      const status = await adapter.connectServer("quoted-secret", {
        command: "node",
        type: "stdio",
      });
      expect(status.error).toContain("No module named 'mcp'");
      expect(status.error).not.toContain("secret");
      expect(status.error).not.toContain("escaped");
      expect(status.error).not.toContain("spaces");
    } finally {
      await adapter.close();
    }
  });

  it("does not leak a credential whose key name is cut by stderr tail truncation", async () => {
    clientConnectMock.mockImplementation(async () => {
      // 构造保留的 4000 字符尾部恰好从键名 VE_SPEECH_MCP_TOKEN 中间的 KEN 开始。
      const head = "KEN=fixture-secret\nreal failure\n";
      const tail = `${head}${"y".repeat(4000 - head.length - 1)}\n`;
      capturedStdioStderrHandlers[0]?.(Buffer.from(`first line\nVE_SPEECH_MCP_TO${tail}`));
      throw new Error("Connection closed");
    });
    const adapter = createMcpAdapter();
    try {
      const status = await adapter.connectServer("cut-key", { command: "node", type: "stdio" });
      expect(status.error).toContain("real failure");
      expect(status.error).not.toContain("fixture-secret");
    } finally {
      await adapter.close();
    }
  });

  it("keeps stderr after a CR-only boundary when tail truncation cuts a credential key", async () => {
    clientConnectMock.mockImplementation(async () => {
      const tail = `KEN=fixture-secret\rreal failure\r${"y".repeat(4100)}\rreal failure`;
      capturedStdioStderrHandlers[0]?.(Buffer.from(`VE_SPEECH_MCP_TO${tail}`));
      throw new Error("Connection closed");
    });
    const adapter = createMcpAdapter();
    try {
      const status = await adapter.connectServer("cr-only", { command: "node", type: "stdio" });
      expect(status.error).toContain("real failure");
      expect(status.error).not.toContain("fixture-secret");
    } finally {
      await adapter.close();
    }
  });

  it.each([" ", ",", ";", "&"])(
    "fails closed when tail truncation cuts a quoted credential containing %j and no newline remains",
    async (separator) => {
      const warnMock = vi.fn();
      const logger = {
        child: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: warnMock,
      };
      logger.child.mockReturnValue(logger);
      clientConnectMock.mockImplementation(async () => {
        // 保留的 4000 字符尾部从 KEN="..." 开始且没有换行，凭证值内含分隔符。
        const tail = `KEN="fixture${separator}leaked-suffix"`;
        // 前缀 16 字符 + 4000 字符，保留的尾部正好从 KEN 开始。
        const input = `VE_SPEECH_MCP_TO${tail}${"y".repeat(4000 - tail.length)}`;
        capturedStdioStderrHandlers[0]?.(Buffer.from(input));
        throw new Error("Connection closed");
      });
      const adapter = createMcpAdapter({ logger });
      try {
        const status = await adapter.connectServer("long-line", { command: "node", type: "stdio" });
        expect(status.error).toContain("Connection closed");
        for (const text of [status.error, JSON.stringify(warnMock.mock.calls)]) {
          expect(text).not.toContain("fixture");
          expect(text).not.toContain("leaked-suffix");
        }
      } finally {
        await adapter.close();
      }
    },
  );

  it("marks the record disconnected and logs recent stderr when the transport closes unexpectedly", async () => {
    const warnMock = vi.fn();
    const logger = {
      child: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: warnMock,
    };
    logger.child.mockReturnValue(logger);
    const telemetryEvents: Array<{ kind: string; mcpInstanceId?: string }> = [];
    const telemetry = createMcpTelemetryTracker({
      idSalt: "device-a",
      onEvent: (event) => telemetryEvents.push(event),
      randomId: () => "mcp-instance-1",
    });
    telemetry.registerConnection({
      connectionId: "connection-1",
      isolation: "session",
      serverName: "node_repl",
    });
    telemetry.acquireOwner({
      connectionId: "connection-1",
      ownerId: "lease-1",
      sessionId: "session-1",
    });
    const adapter = createMcpAdapter({
      connectionContext: {
        mcpConnectionId: "connection-1",
        mcpIsolation: "session",
        sessionId: "session-1",
      },
      logger,
      telemetry,
    });

    await adapter.connectServer("node_repl", {
      command: "node",
      type: "stdio",
    });
    capturedStdioStderrHandlers[0]?.(
      Buffer.from("node_repl uncaughtException: boom from async timer\n"),
    );

    capturedClients.at(-1)?.onclose?.();

    expect(warnMock).toHaveBeenCalledWith(
      "MCP server connection lost",
      expect.objectContaining({
        event: "mcp.server.connection_lost",
        mcpServerName: "node_repl",
        mcpTransportPid: 42_424,
        stderr: expect.stringContaining("boom from async timer"),
      }),
    );
    const statuses = await adapter.status();
    expect(statuses.node_repl?.status).toBe("failed");
    expect(statuses.node_repl?.failureKind).toBe("unexpected_disconnect");
    expect(telemetryEvents.map((event) => [event.kind, event.mcpInstanceId])).toEqual([
      ["process_start", "mcp-instance-1"],
      ["process_crash", "mcp-instance-1"],
    ]);
  });

  it("does not report connection_lost when the server is closed deliberately", async () => {
    const warnMock = vi.fn();
    const logger = {
      child: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: warnMock,
    };
    logger.child.mockReturnValue(logger);
    const adapter = createMcpAdapter({ logger });

    await adapter.connectServer("node_repl", {
      command: "node",
      type: "stdio",
    });
    await adapter.disconnectServer("node_repl");
    capturedClients.at(-1)?.onclose?.();

    expect(warnMock).not.toHaveBeenCalledWith("MCP server connection lost", expect.anything());
  });

  // Bugfix 回归：HTTP/SSE MCP 被停掉不会派发 onclose，status() 会一直停在 connected。
  // 设置页刷新依赖 pingServer 把这种无声死亡暴露出来。
  it("keeps the server connected when the ping succeeds", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("official_tools", {
      type: "http",
      url: "https://mcp.example/mcp",
    });

    await expect(adapter.pingServer?.("official_tools")).resolves.toBe(true);
    expect((await adapter.status()).official_tools?.status).toBe("connected");
  });

  it("starts shared remote recovery when the ping hits a dead transport", async () => {
    const warnMock = vi.fn();
    const logger = {
      child: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: warnMock,
    };
    logger.child.mockReturnValue(logger);
    const adapter = createMcpAdapter({ logger });
    await adapter.connectServer("official_tools", {
      type: "http",
      url: "https://mcp.example/mcp",
    });
    // SDK 本地错误用字符串 code（REQUEST_TIMEOUT / CONNECTION_CLOSED …）。
    clientPingMock.mockRejectedValue(
      Object.assign(new Error("Request timed out"), { code: "REQUEST_TIMEOUT" }),
    );
    const recovering = Promise.withResolvers<void>();
    clientConnectMock.mockImplementationOnce(() => recovering.promise);
    await expect(adapter.pingServer?.("official_tools")).resolves.toBe(false);
    expect((await adapter.status()).official_tools).toMatchObject({
      status: "connecting",
    });
    expect(warnMock).toHaveBeenCalledWith(
      "MCP server ping failed",
      expect.objectContaining({
        event: "mcp.server.ping.failed",
        mcpServerName: "official_tools",
      }),
    );
    recovering.resolve();
    await adapter.waitForServer!("official_tools", { timeoutMs: 2000 });
    await adapter.close();
  });

  it("explicitly retries a failed stdio connection without starting background recovery", async () => {
    const adapter = createMcpAdapter();
    const config = { command: "node", type: "stdio" as const };
    await adapter.connectServer("stdio", config);
    capturedClients[0]!.onclose?.();
    expect(clientConnectMock).toHaveBeenCalledTimes(1);
    expect((await adapter.status()).stdio?.status).toBe("failed");
    await adapter.connectServer("stdio", config, { revalidate: true });
    expect(clientConnectMock).toHaveBeenCalledTimes(2);
    expect((await adapter.status()).stdio?.status).toBe("connected");
    await adapter.close();
  });

  // 回归：内建 node_repl 进程被外部终止后，修复前直接进入 failed，工具在下一步离开会话，
  // 模型不再调用，同 workspace 的新会话也复用这条 failed 记录，没有任何重连入口。
  it("restarts a built-in stdio server after an unexpected exit and keeps its catalog meanwhile", async () => {
    clientListToolsMock.mockResolvedValue({
      tools: [{ name: "js", inputSchema: { type: "object" } }],
    } as never);
    const adapter = createMcpAdapter();
    try {
      await adapter.connectServer("node_repl", BUILT_IN_STDIO_CONFIG);
      const restart = Promise.withResolvers<void>();
      clientConnectMock.mockImplementationOnce(() => restart.promise);
      capturedClients.at(-1)!.onclose?.();
      const restarting = adapter.getToolSnapshot!().node_repl;
      expect(restarting?.status.status).toBe("connecting");
      expect(restarting?.tools?.map((tool) => tool.toolName)).toEqual(["js"]);
      restart.resolve();
      await adapter.waitForServer!("node_repl", { timeoutMs: 1000 });
      expect(adapter.getToolSnapshot!().node_repl?.status.status).toBe("connected");
      expect(clientConnectMock).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close();
    }
  });

  it("gives up after five built-in stdio restart attempts and drops the retained catalog", async () => {
    clientListToolsMock.mockResolvedValue({
      tools: [{ name: "js", inputSchema: { type: "object" } }],
    } as never);
    const adapter = createMcpAdapter();
    await adapter.connectServer("node_repl", BUILT_IN_STDIO_CONFIG);
    const connects = clientConnectMock.mock.calls.length;
    vi.useFakeTimers();
    try {
      clientConnectMock.mockRejectedValue(new Error("spawn failed"));
      capturedClients.at(-1)!.onclose?.();
      expect(adapter.getToolSnapshot!().node_repl?.status.status).toBe("connecting");
      await vi.runAllTimersAsync();
      expect(clientConnectMock.mock.calls.length - connects).toBe(5);
      expect(adapter.getToolSnapshot!().node_repl?.status.status).toBe("failed");
      expect(await adapter.listTools()).toEqual([]);
    } finally {
      vi.useRealTimers();
      await adapter.close();
    }
  });

  it("limits built-in stdio restarts within the restart window", async () => {
    const adapter = createMcpAdapter();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await adapter.connectServer("node_repl", BUILT_IN_STDIO_CONFIG);
      const exitAndSettle = async () => {
        capturedClients.at(-1)!.onclose?.();
        await adapter.waitForServer!("node_repl", { timeoutMs: 1000 });
        return adapter.getToolSnapshot!().node_repl?.status;
      };
      for (let restart = 0; restart < 5; restart++)
        expect((await exitAndSettle())?.status).toBe("connected");
      // 第 6 次退出仍在 10 分钟窗口内：不再自动重启，进入 failed（目录保留见下一个用例）。
      const connects = clientConnectMock.mock.calls.length;
      expect(await exitAndSettle()).toMatchObject({
        status: "failed",
        failureKind: "unexpected_disconnect",
      });
      expect(clientConnectMock.mock.calls.length).toBe(connects);
      // 显式重连重新开始计数。
      await adapter.connectServer("node_repl", BUILT_IN_STDIO_CONFIG, { revalidate: true });
      expect((await exitAndSettle())?.status).toBe("connected");
      for (let restart = 0; restart < 4; restart++) await exitAndSettle();
      expect((await exitAndSettle())?.status).toBe("failed");
      // 窗口过去后再次退出时允许重启。
      await adapter.connectServer("node_repl", BUILT_IN_STDIO_CONFIG, { revalidate: true });
      for (let restart = 0; restart < 5; restart++) await exitAndSettle();
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
      expect((await exitAndSettle())?.status).toBe("connected");
    } finally {
      vi.useRealTimers();
      await adapter.close();
    }
  });

  // 回归：超过重启上限后修复前清空目录，工具离开会话，执行准入重连到不了；同 workspace 的新会话
  // 也复用这条 failed 记录，窗口过去后仍不可用。现在保留目录，下一次执行准入重连。
  it("keeps the built-in catalog after the restart limit and restarts on the next execution", async () => {
    clientListToolsMock.mockResolvedValue({
      tools: [{ name: "js", inputSchema: { type: "object" } }],
    } as never);
    const adapter = createMcpAdapter();
    try {
      await adapter.connectServer("node_repl", BUILT_IN_STDIO_CONFIG);
      for (let exit = 0; exit < 6; exit++) {
        capturedClients.at(-1)!.onclose?.();
        await adapter.waitForServer!("node_repl", { timeoutMs: 1000 });
      }
      const limited = adapter.getToolSnapshot!().node_repl;
      expect(limited?.status).toMatchObject({
        status: "failed",
        failureKind: "unexpected_disconnect",
      });
      expect(limited?.tools?.map((tool) => tool.toolName)).toEqual(["js"]);
      const connects = clientConnectMock.mock.calls.length;
      const restart = Promise.withResolvers<void>();
      clientConnectMock.mockImplementationOnce(() => restart.promise);
      const waiting = adapter.waitForServer!("node_repl", { reconnect: true, timeoutMs: 1000 });
      // 重连期间目录不离开视图。
      const reconnecting = adapter.getToolSnapshot!().node_repl;
      expect(reconnecting?.status.status).toBe("connecting");
      expect(reconnecting?.tools?.map((tool) => tool.toolName)).toEqual(["js"]);
      restart.resolve();
      await expect(waiting).resolves.toEqual({ timedOut: false });
      expect(adapter.getToolSnapshot!().node_repl?.status.status).toBe("connected");
      expect(clientConnectMock.mock.calls.length - connects).toBe(1);
    } finally {
      await adapter.close();
    }
  });

  it("drops the retained built-in catalog when the execution restart fails", async () => {
    clientListToolsMock.mockResolvedValue({
      tools: [{ name: "js", inputSchema: { type: "object" } }],
    } as never);
    const adapter = createMcpAdapter();
    try {
      await adapter.connectServer("node_repl", BUILT_IN_STDIO_CONFIG);
      for (let exit = 0; exit < 6; exit++) {
        capturedClients.at(-1)!.onclose?.();
        await adapter.waitForServer!("node_repl", { timeoutMs: 1000 });
      }
      expect(adapter.getToolSnapshot!().node_repl?.tools?.map((tool) => tool.toolName)).toEqual([
        "js",
      ]);
      clientConnectMock.mockRejectedValueOnce(new Error("spawn failed"));
      await adapter.waitForServer!("node_repl", { reconnect: true, timeoutMs: 1000 });
      const row = adapter.getToolSnapshot!().node_repl;
      expect(row?.status.status).toBe("failed");
      expect(row?.status.failureKind).not.toBe("unexpected_disconnect");
      expect(row?.tools).toBeUndefined();
    } finally {
      await adapter.close();
    }
  });

  it("still drops the catalog of an ordinary stdio server after an unexpected exit", async () => {
    clientListToolsMock.mockResolvedValue({
      tools: [{ name: "echo", inputSchema: { type: "object" } }],
    } as never);
    const adapter = createMcpAdapter();
    try {
      await adapter.connectServer("stdio", { command: "node", type: "stdio" });
      capturedClients.at(-1)!.onclose?.();
      const row = adapter.getToolSnapshot!().stdio;
      expect(row?.status).toMatchObject({ status: "failed", failureKind: "unexpected_disconnect" });
      expect(row?.tools).toBeUndefined();
    } finally {
      await adapter.close();
    }
  });

  it("treats a JSON-RPC error answer as a live connection", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("official_tools", {
      type: "http",
      url: "https://mcp.example/mcp",
    });
    // server 回了 method-not-found：请求走通了，连接是活的，不能据此拆连接。
    clientPingMock.mockRejectedValue(
      Object.assign(new Error("Method not found"), { code: -32_601 }),
    );

    await expect(adapter.pingServer?.("official_tools")).resolves.toBe(true);
    expect((await adapter.status()).official_tools?.status).toBe("connected");
  });

  it("reports an unknown server as not alive", async () => {
    const adapter = createMcpAdapter();
    await expect(adapter.pingServer?.("missing")).resolves.toBe(false);
  });

  it("does not reconnect a replaced configuration after its health probe fails", async () => {
    const adapter = createMcpAdapter();
    const config = { type: "http" as const, url: "https://mcp.example/old" };
    await adapter.connectServer("docs", config);
    const probe = Promise.withResolvers<Record<string, never>>();
    const probing = Promise.withResolvers<void>();
    clientPingMock.mockImplementationOnce(() => {
      probing.resolve();
      return probe.promise;
    });
    const refresh = adapter.connectServer("docs", config, { revalidate: true });
    await probing.promise;
    await adapter.connectServer("docs", { ...config, url: "https://mcp.example/new" });
    probe.reject(new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed"));
    await refresh;
    expect(clientConnectMock).toHaveBeenCalledTimes(2);
    expect(capturedHttpOptions).toHaveLength(2);
    expect((await adapter.status()).docs?.status).toBe("connected");
    await adapter.close();
  });

  it("does not retry a stdio call whose transport reports not connected", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("node_repl", {
      command: "node",
      type: "stdio",
    });

    clientCallToolMock.mockRejectedValueOnce(new Error("Not connected"));

    // 进程死亡由 onclose 进入 failed，下一次调用先重连；本次调用不重发。
    await expect(
      adapter.callTool({
        arguments: { code: "1 + 1" },
        serverName: "node_repl",
        toolName: "js",
      }),
    ).rejects.toThrow(/Not connected/);
    expect(clientConnectMock).toHaveBeenCalledTimes(1);
    expect(clientCallToolMock).toHaveBeenCalledTimes(1);
  });

  it("reconnects before calling when the record was already marked disconnected", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("node_repl", {
      command: "node",
      type: "stdio",
    });

    capturedClients.at(-1)?.onclose?.();
    expect((await adapter.status()).node_repl?.status).toBe("failed");

    const result = await adapter.callTool({
      arguments: { code: "1 + 1" },
      serverName: "node_repl",
      toolName: "js",
    });

    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(clientConnectMock).toHaveBeenCalledTimes(2);
    expect((await adapter.status()).node_repl?.status).toBe("connected");
  });

  it("surfaces the original error when reconnection also fails", async () => {
    const adapter = createMcpAdapter();
    await adapter.connectServer("node_repl", {
      command: "node",
      type: "stdio",
    });

    clientCallToolMock.mockRejectedValue(new Error("Not connected"));
    clientConnectMock.mockRejectedValue(new Error("spawn ENOENT"));

    await expect(
      adapter.callTool({
        arguments: { code: "1 + 1" },
        serverName: "node_repl",
        toolName: "js",
      }),
    ).rejects.toThrow(/Not connected/);
    expect(clientCallToolMock).toHaveBeenCalledTimes(1);
  });

  it("keeps transport error codes separate from the connection failure classification", async () => {
    const adapter = createMcpAdapter();
    clientConnectMock.mockRejectedValue(
      Object.assign(new Error("Connection refused"), { cause: { code: "ECONNREFUSED" } }),
    );
    const status = await adapter.connectServer("diagnostic", { command: "node", type: "stdio" });
    expect(status).toMatchObject({ status: "failed", errorCode: "ECONNREFUSED" });
    expect(status.failureKind).not.toBe("ECONNREFUSED");
    await adapter.close();
  });

  it("injects unified network env into stdio MCP transports", async () => {
    const adapter = createMcpAdapter({
      env: {
        PATH: dirname(process.execPath),
        ZCODE_AGENT_CA_CERT: "/tmp/root-ca.pem",
      },
      network: {
        httpProxy: "127.0.0.1:8888",
        noProxy: "localhost,127.0.0.1",
      },
    });

    await adapter.connectServer("demo", {
      command: "node",
      env: {
        MCP_TOKEN: "secret",
      },
      type: "stdio",
    });

    const options = capturedStdioOptions[0] as { env?: Record<string, string> };
    expect(options.env).toMatchObject({
      ALL_PROXY: "http://127.0.0.1:8888",
      CURL_CA_BUNDLE: "/tmp/root-ca.pem",
      GIT_SSL_CAINFO: "/tmp/root-ca.pem",
      HTTPS_PROXY: "http://127.0.0.1:8888",
      HTTP_PROXY: "http://127.0.0.1:8888",
      MCP_TOKEN: "secret",
      NODE_EXTRA_CA_CERTS: "/tmp/root-ca.pem",
      NO_PROXY: "localhost,127.0.0.1",
      // MCP 会补齐 Node 目录；本测试使用已含 Node 的 PATH，避免依赖测试机的 /bin。
      PATH: dirname(process.execPath),
      REQUESTS_CA_BUNDLE: "/tmp/root-ca.pem",
      SSL_CERT_FILE: "/tmp/root-ca.pem",
      all_proxy: "http://127.0.0.1:8888",
      http_proxy: "http://127.0.0.1:8888",
      https_proxy: "http://127.0.0.1:8888",
      no_proxy: "localhost,127.0.0.1",
    });
  });

  it("appends the injected node fallback after the server env", async () => {
    const resolve = vi.fn(async () => ({
      binDir: "/fallback/bin",
      env: { ZCODE_NODE_FALLBACK_EXEC_PATH: "/electron" },
    }));
    const adapter = createMcpAdapter({
      env: { PATH: dirname(process.execPath) },
      nodeFallback: { resolve },
    });

    await adapter.connectServer("demo", {
      command: "node",
      // 插件自带 PATH 会整体替换宿主 PATH；fallback 仍须追加在它后面。
      env: { PATH: "/plugin/bin" },
      type: "stdio",
    });

    const options = capturedStdioOptions[0] as { env?: Record<string, string> };
    expect(options.env?.PATH).toBe(["/plugin/bin", "/fallback/bin"].join(delimiter));
    expect(options.env?.ZCODE_NODE_FALLBACK_EXEC_PATH).toBe("/electron");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("restores captured user network env into stdio MCP transports", async () => {
    const adapter = createMcpAdapter({
      env: {
        [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify({
          NODE_EXTRA_CA_CERTS: "/tmp/user-ca.pem",
          http_proxy: "http://user-proxy:8080",
        }),
        PATH: dirname(process.execPath),
      },
      network: {},
    });

    await adapter.connectServer("demo", {
      command: "node",
      type: "stdio",
    });

    const options = capturedStdioOptions[0] as { env?: Record<string, string> };
    expect(options.env).toMatchObject({
      NODE_EXTRA_CA_CERTS: "/tmp/user-ca.pem",
      PATH: dirname(process.execPath),
      http_proxy: "http://user-proxy:8080",
    });
    expect(options.env?.[ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]).toBeUndefined();
  });

  it("passes proxy-aware fetch into HTTP and SSE MCP transports", async () => {
    const adapter = createMcpAdapter({
      env: {
        ZCODE_HTTP_PROXY: "http://127.0.0.1:8888",
      },
      network: {},
    });

    await adapter.connectServer("http-demo", {
      type: "http",
      url: "https://mcp.example.test",
    });
    await adapter.connectServer("sse-demo", {
      type: "sse",
      url: "https://mcp.example.test/sse",
    });

    expect(capturedHttpOptions[0]).toMatchObject({
      fetch: expect.any(Function),
    });
    expect(capturedSseOptions[0]).toMatchObject({
      fetch: expect.any(Function),
    });
    await adapter.close();
  });

  it("passes a pure token AuthProvider into bare HTTP and SSE MCP transports", async () => {
    const adapter = createMcpAdapter();

    await adapter.connectServer("http-demo", {
      type: "http",
      url: "https://mcp.example.test",
    });
    await adapter.connectServer("sse-demo", {
      type: "sse",
      url: "https://mcp.example.test/sse",
    });

    const providers = [
      (capturedHttpOptions[0] as { authProvider?: Record<string, unknown> }).authProvider,
      (capturedSseOptions[0] as { authProvider?: Record<string, unknown> }).authProvider,
    ];

    for (const provider of providers) {
      expect(provider).toBeDefined();
      // 修复原因（根因 1）：运行期只能是纯 AuthProvider。SDK 的 `isOAuthClientProvider()` 判定
      // 依赖 `clientInformation`/`tokens` 等方法是否存在；一旦被识别为 OAuthClientProvider，
      // transport 就会通过 `adaptOAuthProvider` 包裹它，401 走 SDK 的 `auth()`，绕过我们的
      // refresh 单飞锁，rotation 竞态立刻复发。同时它还会带来 discovery / DCR / callback listener。
      expect(typeof provider?.token).toBe("function");
      expect(typeof provider?.onUnauthorized).toBe("function");
      expect(provider?.clientInformation).toBeUndefined();
      expect(provider?.tokens).toBeUndefined();
      expect(provider?.saveTokens).toBeUndefined();
      expect(provider?.clientMetadata).toBeUndefined();
      expect(provider?.redirectToAuthorization).toBeUndefined();
      expect(provider?.saveCodeVerifier).toBeUndefined();
    }
    await adapter.close();
  });

  it("does not attach implicit OAuth provider when HTTP MCP has an Authorization header", async () => {
    const adapter = createMcpAdapter();

    await adapter.connectServer("manual-token", {
      type: "http",
      url: "https://mcp.example.test",
      headers: {
        Authorization: "Bearer user-token",
      },
    });

    expect((capturedHttpOptions[0] as { authProvider?: unknown }).authProvider).toBeUndefined();
    await adapter.close();
  });

  it("passes OAuth client credentials providers into HTTP and SSE MCP transports", async () => {
    const adapter = createMcpAdapter({
      clientName: "zcode-test",
    });

    await adapter.connectServer("http-demo", {
      type: "http",
      url: "https://mcp.example.test",
      headers: {
        "X-ZCode": "1",
      },
      oauth: {
        type: "client_credentials",
        clientId: "http-client",
        clientSecret: "http-secret",
        scope: "mcp:tools",
      },
    });
    await adapter.connectServer("sse-demo", {
      type: "sse",
      url: "https://mcp.example.test/sse",
      oauth: {
        type: "client_credentials",
        clientId: "sse-client",
        clientSecret: "sse-secret",
      },
    });

    const httpOptions = capturedHttpOptions[0] as {
      authProvider?: {
        clientInformation(): { client_id: string; client_secret?: string };
        clientMetadata: {
          client_name?: string;
          grant_types?: string[];
          scope?: string;
        };
      };
      requestInit?: { headers?: Record<string, string> };
    };
    const sseOptions = capturedSseOptions[0] as {
      authProvider?: {
        clientInformation(): { client_id: string; client_secret?: string };
        clientMetadata: { client_name?: string; grant_types?: string[] };
      };
    };

    expect(httpOptions.requestInit?.headers).toEqual({ "X-ZCode": "1" });
    expect(httpOptions.authProvider?.clientInformation()).toEqual({
      client_id: "http-client",
      client_secret: "http-secret",
    });
    expect(httpOptions.authProvider?.clientMetadata).toMatchObject({
      client_name: "zcode-test-http-demo",
      grant_types: ["client_credentials"],
      scope: "mcp:tools",
    });
    expect(sseOptions.authProvider?.clientInformation()).toEqual({
      client_id: "sse-client",
      client_secret: "sse-secret",
    });
    expect(sseOptions.authProvider?.clientMetadata).toMatchObject({
      client_name: "zcode-test-sse-demo",
      grant_types: ["client_credentials"],
    });
  });

  it("exposes pending OAuth authorization URL through server status", async () => {
    const { release: resolveConnect } = stubInteractiveAuthorization(
      "https://auth.example.test/authorize?state=state_test",
    );
    const adapter = createMcpAdapter();

    const connect = adapter.connectServer("notion", {
      type: "http",
      url: "https://mcp.example.test/mcp",
      oauth: {
        type: "authorization_code",
        clientName: "ZCode",
      },
    });

    let authorizationUrl: string | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await adapter.status();
      authorizationUrl = status.notion?.authorization?.authorizationUrl;
      if (authorizationUrl) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(authorizationUrl).toBe("https://auth.example.test/authorize?state=state_test");

    resolveConnect();
    await expect(connect).resolves.toMatchObject({
      status: "connected",
      toolCount: 0,
    });
    await adapter.close();
  });

  it("reuses an unchanged configured connection while OAuth authorization is pending", async () => {
    const { release: resolveConnect } = stubInteractiveAuthorization(
      "https://auth.example.test/authorize?state=stable_state",
    );
    const adapter = createMcpAdapter();
    const firstConnect = adapter.connectConfiguredServers({
      notion: {
        type: "http",
        url: "https://mcp.example.test/mcp",
        oauth: {
          type: "authorization_code",
          clientName: "ZCode",
        },
      },
    });

    let authorizationUrl: string | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await adapter.status();
      authorizationUrl = status.notion?.authorization?.authorizationUrl;
      if (authorizationUrl) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const secondConnect = adapter.connectConfiguredServers({
      notion: {
        type: "http",
        url: "https://mcp.example.test/mcp",
        oauth: {
          type: "authorization_code",
          clientName: "ZCode",
        },
      },
    });
    await Promise.resolve();

    expect(authorizationUrl).toBe("https://auth.example.test/authorize?state=stable_state");
    await expect(
      adapter.connectServer(
        "notion",
        {
          type: "http",
          url: "https://mcp.example.test/mcp",
          oauth: { type: "authorization_code", clientName: "ZCode" },
        },
        { revalidate: true },
      ),
    ).resolves.toMatchObject({
      status: "connecting",
      authorization: { authorizationUrl },
    });
    expect(clientConnectMock).toHaveBeenCalledTimes(1);
    // Phase 1 的探测 transport 在进入 Phase 2 前一定会被关闭（negotiation 失败后不可复用），
    // 所以这里断言的是「第二个 caller 没有另起一条连接」，而不是 transport 从未关闭。
    expect(capturedHttpOptions).toHaveLength(1);
    await expect(adapter.status()).resolves.toMatchObject({
      notion: {
        authorization: {
          authorizationUrl: "https://auth.example.test/authorize?state=stable_state",
        },
        status: "connecting",
      },
    });

    resolveConnect();
    await expect(Promise.all([firstConnect, secondConnect])).resolves.toMatchObject([
      { statuses: { notion: { status: "connected" } } },
      { statuses: { notion: { status: "connected" } } },
    ]);
    await adapter.close();
  });

  it("keeps a reused OAuth connection alive when a bounded caller times out", async () => {
    const { release: resolveConnect } = stubInteractiveAuthorization(
      "https://auth.example.test/authorize?state=shared_timeout_state",
    );
    const adapter = createMcpAdapter();
    const servers = {
      notion: {
        type: "http" as const,
        url: "https://mcp.example.test/mcp",
        oauth: {
          type: "authorization_code" as const,
          clientName: "ZCode",
        },
      },
    };
    const settingsConnect = adapter.connectConfiguredServers(servers);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await adapter.status();
      if (status.notion?.authorization?.authorizationUrl) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const sessionConnect = await adapter.connectConfiguredServers(servers, {
      oauthAuthorizationTimeoutMs: 20,
    });

    expect(sessionConnect.statuses.notion).toMatchObject({
      authorization: {
        authorizationUrl: "https://auth.example.test/authorize?state=shared_timeout_state",
      },
      status: "connecting",
    });
    expect(clientConnectMock).toHaveBeenCalledTimes(1);
    // Phase 1 的探测 transport 在进入 Phase 2 前一定会被关闭（negotiation 失败后不可复用），
    // 所以这里断言的是「第二个 caller 没有另起一条连接」，而不是 transport 从未关闭。
    expect(capturedHttpOptions).toHaveLength(1);

    resolveConnect();
    await expect(settingsConnect).resolves.toMatchObject({
      statuses: { notion: { status: "connected" } },
    });
    await adapter.close();
  });

  it("only cancels the caller waiter when a reused OAuth connection is aborted", async () => {
    const { release: resolveConnect } = stubInteractiveAuthorization(
      "https://auth.example.test/authorize?state=shared_abort_state",
    );
    const adapter = createMcpAdapter();
    const servers = {
      notion: {
        type: "http" as const,
        url: "https://mcp.example.test/mcp",
        oauth: {
          type: "authorization_code" as const,
          clientName: "ZCode",
        },
      },
    };
    const settingsConnect = adapter.connectConfiguredServers(servers);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await adapter.status();
      if (status.notion?.authorization?.authorizationUrl) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const abortController = new AbortController();
    const sessionConnect = adapter.connectConfiguredServers(servers, {
      signal: abortController.signal,
    });
    abortController.abort(new Error("session stopped"));

    await expect(sessionConnect).resolves.toMatchObject({
      statuses: {
        notion: {
          authorization: {
            authorizationUrl: "https://auth.example.test/authorize?state=shared_abort_state",
          },
          status: "connecting",
        },
      },
    });
    expect(clientConnectMock).toHaveBeenCalledTimes(1);
    // Phase 1 的探测 transport 在进入 Phase 2 前一定会被关闭（negotiation 失败后不可复用），
    // 所以这里断言的是「第二个 caller 没有另起一条连接」，而不是 transport 从未关闭。
    expect(capturedHttpOptions).toHaveLength(1);

    resolveConnect();
    await expect(settingsConnect).resolves.toMatchObject({
      statuses: { notion: { status: "connected" } },
    });
    await adapter.close();
  });

  it("treats per-connect OAuth authorization timeout as a caller budget, not a transaction kill", async () => {
    let startAuthorization!: () => void;
    const beforeAuthorization = new Promise<void>((resolve) => {
      startAuthorization = resolve;
    });
    const { release, ready } = stubInteractiveAuthorization(
      "https://auth.example.test/authorize?state=state_test",
      beforeAuthorization,
    );
    const adapter = createMcpAdapter();
    const startedAt = Date.now();
    try {
      const status = await adapter.connectServer(
        "notion",
        {
          type: "http",
          url: "https://mcp.example.test/mcp",
          timeoutMs: 2_000,
          oauth: { type: "authorization_code", clientName: "ZCode" },
        },
        { oauthAuthorizationTimeoutMs: 20 },
      );
      // URL 发布含异步存储，不能假定它比 20ms caller 预算更快；事务应在 caller 返回后继续。
      expect(status).toMatchObject({ status: "connecting" });
      expect(status.authorization).toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(transportFinishAuthMock).not.toHaveBeenCalled();
      startAuthorization();
      await ready;
      await expect(adapter.status()).resolves.toMatchObject({
        notion: {
          authorization: {
            authorizationUrl: "https://auth.example.test/authorize?state=state_test",
          },
          status: "connecting",
        },
      });
      release();
      await vi.waitFor(async () => {
        expect(await adapter.status()).toMatchObject({ notion: { status: "connected" } });
      });
    } finally {
      startAuthorization();
      release();
      await adapter.close();
    }
  });

  it("keeps runtime OAuth recovery alive after the triggering caller times out", async () => {
    let startAuthorization!: () => void;
    const beforeAuthorization = new Promise<void>((resolve) => {
      startAuthorization = resolve;
    });
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    let releaseAuthorization!: () => void;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    authMock.mockImplementation(async (provider: unknown) => {
      const interactiveProvider = provider as {
        redirectToAuthorization(url: URL): Promise<void>;
        state(): Promise<string>;
      };
      const authorizationUrl = new URL("https://auth.example.test/authorize");
      authorizationUrl.searchParams.set("state", await interactiveProvider.state());
      await beforeAuthorization;
      await interactiveProvider.redirectToAuthorization(authorizationUrl);
      markReady();
      await authorizationGate;
      return "AUTHORIZED" as const;
    });
    clientCallToolMock
      .mockRejectedValueOnce(new UnauthorizedError())
      .mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const adapter = createMcpAdapter();
    await adapter.connectServer("runtime", {
      oauth: {
        type: "authorization_code",
      },
      type: "http",
      url: "https://mcp.example.test/mcp",
    });

    const call = adapter.callTool(
      {
        serverName: "runtime",
        toolName: "oauth_ping",
      },
      { timeoutMs: 20 },
    );

    try {
      await expect(observePromiseWithin(call, 200)).resolves.toMatchObject({
        reason: {
          name: "McpTimeoutError",
        },
        status: "rejected",
      });
      // 显式让 caller 先超时，再发布 URL，避免靠机器负载决定断言先后。
      startAuthorization();
      await ready;
      await expect(adapter.status()).resolves.toMatchObject({
        runtime: {
          authorization: {
            authorizationUrl: expect.stringContaining("https://auth.example.test/authorize"),
          },
          status: "connecting",
        },
      });

      releaseAuthorization();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const status = await adapter.status();
        if (status.runtime?.status === "connected") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await expect(adapter.status()).resolves.toMatchObject({
        runtime: { status: "connected" },
      });
      await expect(
        adapter.callTool(
          {
            serverName: "runtime",
            toolName: "oauth_ping",
          },
          { timeoutMs: 200 },
        ),
      ).resolves.toMatchObject({
        content: [{ text: "ok", type: "text" }],
      });
      expect(authMock).toHaveBeenCalledTimes(1);
      // 原 caller 已经超时，后台 recovery 只负责重连；不会替超时 caller 再执行工具。
      expect(clientCallToolMock).toHaveBeenCalledTimes(2);
    } finally {
      startAuthorization();
      releaseAuthorization();
      await Promise.allSettled([call]);
      await adapter.close();
    }
  });

  it("shares one runtime OAuth recovery across concurrent tool callers", async () => {
    let releaseAuthorization!: () => void;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    authMock.mockImplementation(async (provider: unknown) => {
      const interactiveProvider = provider as {
        redirectToAuthorization(url: URL): Promise<void>;
        state(): Promise<string>;
      };
      const authorizationUrl = new URL("https://auth.example.test/authorize");
      authorizationUrl.searchParams.set("state", await interactiveProvider.state());
      await interactiveProvider.redirectToAuthorization(authorizationUrl);
      await authorizationGate;
      return "AUTHORIZED" as const;
    });
    clientCallToolMock
      .mockRejectedValueOnce(new UnauthorizedError())
      .mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    clientListToolsMock.mockResolvedValue({
      tools: [{ name: "oauth_ping", inputSchema: { type: "object" } }],
    } as never);

    const adapter = createMcpAdapter();
    await adapter.connectServer("runtime", {
      oauth: {
        type: "authorization_code",
      },
      type: "http",
      url: "https://mcp.example.test/mcp",
    });

    const firstCall = adapter.callTool(
      {
        serverName: "runtime",
        toolName: "oauth_ping",
      },
      { timeoutMs: 2_000 },
    );
    // 立即挂上处理：触发授权的调用在链接发布时就会 reject，晚挂会被记为未处理 rejection。
    const firstOutcome = firstCall.then(
      () => "resolved",
      (error: unknown) => error,
    );

    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const status = await adapter.status();
        if (status.runtime?.authorization?.authorizationUrl) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(adapter.status()).resolves.toMatchObject({
        runtime: {
          authorization: {
            authorizationUrl: expect.stringContaining("https://auth.example.test/authorize"),
          },
          status: "connecting",
        },
      });

      // 触发授权的调用在链接发布后以原始错误结束，由 core 改写为 needs-auth 文本。
      expect(String(await firstOutcome)).toMatch(/Unauthorized/);
      const secondCall = adapter.callTool(
        {
          serverName: "runtime",
          toolName: "oauth_ping",
        },
        { timeoutMs: 2_000 },
      );
      await Promise.resolve();
      expect(clientCallToolMock).toHaveBeenCalledTimes(1);

      releaseAuthorization();
      await expect(secondCall).resolves.toMatchObject({
        content: [{ text: "ok", type: "text" }],
      });
      expect(authMock).toHaveBeenCalledTimes(1);
      // 第一次认证失败 + second caller 等到同一轮授权完成后的首次实际调用；不另起授权。
      expect(clientCallToolMock).toHaveBeenCalledTimes(2);
      await expect(adapter.status()).resolves.toMatchObject({
        runtime: { status: "connected" },
      });
    } finally {
      releaseAuthorization();
      await Promise.allSettled([firstCall]);
      await adapter.close();
    }
  });

  it("does not let a caller abort close the shared runtime OAuth callback listener", async () => {
    let authorizationContext:
      | {
          authorizationUrl: string;
          redirectUrl: string;
        }
      | undefined;
    // 链接发布后触发调用会立即结束；在发布前中止调用，才能覆盖"调用方中止不关闭共享监听"。
    const entered = Promise.withResolvers<void>();
    const publish = Promise.withResolvers<void>();
    authMock.mockImplementation(
      async (provider: unknown, options?: { authorizationCode?: string }) => {
        if (options?.authorizationCode) return "AUTHORIZED" as const;
        entered.resolve();
        await publish.promise;
        const interactiveProvider = provider as {
          redirectToAuthorization(url: URL): Promise<void>;
          state(): Promise<string>;
        };
        const authorizationUrl = new URL("https://auth.example.test/authorize");
        authorizationUrl.searchParams.set("state", await interactiveProvider.state());
        await interactiveProvider.redirectToAuthorization(authorizationUrl);
        return "REDIRECT" as never;
      },
    );
    clientCallToolMock
      .mockRejectedValueOnce(new UnauthorizedError())
      .mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const adapter = createMcpAdapter({
      mcpOAuth: {
        onAuthorizationRequired: async (context) => {
          authorizationContext = context;
        },
      },
    });
    await adapter.connectServer("runtime", {
      oauth: {
        type: "authorization_code",
      },
      type: "http",
      url: "https://mcp.example.test/mcp",
    });

    const abortController = new AbortController();
    const call = adapter.callTool(
      {
        serverName: "runtime",
        toolName: "oauth_ping",
      },
      {
        signal: abortController.signal,
        timeoutMs: 2_000,
      },
    );

    try {
      await entered.promise;
      abortController.abort(new Error("caller stopped"));
      await expect(observePromiseWithin(call, 200)).resolves.toMatchObject({
        reason: {
          message: "caller stopped",
        },
        status: "rejected",
      });
      publish.resolve();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (authorizationContext) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(authorizationContext).toBeDefined();

      const callbackUrl = new URL(authorizationContext!.redirectUrl);
      callbackUrl.searchParams.set("code", "authorized-after-caller-abort");
      callbackUrl.searchParams.set(
        "state",
        new URL(authorizationContext!.authorizationUrl).searchParams.get("state") ?? "",
      );
      await expect(fetch(callbackUrl)).resolves.toMatchObject({ ok: true });

      for (let attempt = 0; attempt < 50; attempt += 1) {
        const status = await adapter.status();
        if (status.runtime?.status === "connected") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(adapter.status()).resolves.toMatchObject({
        runtime: { status: "connected" },
      });
      expect(authMock).toHaveBeenCalledTimes(2);
      expect(clientConnectMock).toHaveBeenCalledTimes(2);
    } finally {
      publish.resolve();
      await Promise.allSettled([call]);
      await adapter.close();
    }
  });

  describe("tool-call authorization", () => {
    const OAUTH_SERVER = {
      type: "http" as const,
      url: "https://mcp.example.test/mcp",
      oauth: { type: "authorization_code" as const },
    };
    const OAUTH_TOOLS = { tools: [{ name: "oauth_ping", inputSchema: { type: "object" } }] };
    const AUTHORIZATION_URL = "https://auth.example.test/authorize";
    const RECONNECT_WAIT_CAP_MS = 30_000;
    const STATUS_POLL_ATTEMPTS = 50;
    const STATUS_POLL_INTERVAL_MS = 10;

    /** 发布授权链接后停在 gate 上；gate 以 error 结束时模拟授权到期或失败。 */
    function publishAuthorizationThen(gate: Promise<"AUTHORIZED" | Error>) {
      authMock.mockImplementation(async (provider: unknown) => {
        const interactive = provider as {
          redirectToAuthorization(url: URL): Promise<void>;
          state(): Promise<string>;
        };
        const url = new URL(AUTHORIZATION_URL);
        url.searchParams.set("state", await interactive.state());
        await interactive.redirectToAuthorization(url);
        const outcome = await gate;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
    }

    async function waitForSnapshot(
      adapter: ReturnType<typeof createMcpAdapter>,
      predicate: (row: ReturnType<typeof adapter.getToolSnapshot>[string] | undefined) => boolean,
    ) {
      for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
        if (predicate(adapter.getToolSnapshot().runtime)) return;
        await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
      }
      throw new Error(`snapshot did not converge: ${JSON.stringify(adapter.getToolSnapshot())}`);
    }

    /** 调用期 401 触发授权，授权以 error 结束；返回保留了目录的 adapter。 */
    async function failToolCallAuthorization(failure: Error = new Error("authorization expired")) {
      const gate = Promise.withResolvers<"AUTHORIZED" | Error>();
      publishAuthorizationThen(gate.promise);
      clientListToolsMock.mockResolvedValue(OAUTH_TOOLS as never);
      clientCallToolMock.mockRejectedValueOnce(new UnauthorizedError());
      const adapter = createMcpAdapter();
      await adapter.connectServer("runtime", OAUTH_SERVER);
      // 立即挂上处理：调用在链接发布时就会 reject，晚挂会被记为未处理 rejection。
      const call = Promise.allSettled([
        adapter.callTool({ serverName: "runtime", toolName: "oauth_ping" }),
      ]);
      await waitForSnapshot(adapter, (row) => Boolean(row?.status.authorization));
      gate.resolve(failure);
      await call;
      await waitForSnapshot(
        adapter,
        (row) => row?.status.failureKind === "oauth_authorization_failed",
      );
      return adapter;
    }

    it("ends the triggering call once the authorization link is published", async () => {
      const gate = Promise.withResolvers<"AUTHORIZED" | Error>();
      publishAuthorizationThen(gate.promise);
      clientListToolsMock.mockResolvedValue(OAUTH_TOOLS as never);
      clientCallToolMock.mockRejectedValueOnce(new UnauthorizedError());
      const adapter = createMcpAdapter();
      await adapter.connectServer("runtime", OAUTH_SERVER);
      const call = adapter.callTool(
        { serverName: "runtime", toolName: "oauth_ping" },
        { timeoutMs: RECONNECT_WAIT_CAP_MS },
      );
      try {
        // 修复前要等满 30 s 才以工具超时结束，模型不知道需要用户授权。
        const observed = await observePromiseWithin(call, 1_000);
        expect(observed.status).toBe("rejected");
        expect(String((observed as { reason: unknown }).reason)).toMatch(/Unauthorized/);
        expect(adapter.getToolSnapshot().runtime?.status.authorization?.authorizationUrl).toContain(
          AUTHORIZATION_URL,
        );
        // 授权仍在后台进行；完成后连接恢复，已结束的调用不被重放。
        gate.resolve("AUTHORIZED");
        await waitForSnapshot(adapter, (row) => row?.status.status === "connected");
        expect(clientCallToolMock).toHaveBeenCalledTimes(1);
      } finally {
        gate.resolve("AUTHORIZED");
        await Promise.allSettled([call]);
        await adapter.close();
      }
    });

    it("returns the original error when the reconnect wait reaches its cap", async () => {
      clientListToolsMock.mockResolvedValue({
        tools: [{ name: "ping", inputSchema: { type: "object" } }],
      } as never);
      const adapter = createMcpAdapter();
      // 连接超时长于重连等待上限，等待一定先被上限截断。
      await adapter.connectServer("demo", {
        type: "http",
        url: "https://mcp.example.test/mcp",
        timeoutMs: RECONNECT_WAIT_CAP_MS * 10,
      });
      const reconnect = Promise.withResolvers<void>();
      clientConnectMock.mockImplementation(() => reconnect.promise);
      clientCallToolMock.mockRejectedValueOnce(
        new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed"),
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const observed = adapter
          .callTool(
            { serverName: "demo", toolName: "ping" },
            { timeoutMs: RECONNECT_WAIT_CAP_MS * 4 },
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await vi.advanceTimersByTimeAsync(RECONNECT_WAIT_CAP_MS);
        const error = await observed;
        // 修复前报 McpTimeoutError，模型以为工具超时，实际是连接关闭且仍在恢复。
        expect(error).toBeInstanceOf(SdkError);
        expect(String(error)).toContain("Connection closed");
      } finally {
        vi.useRealTimers();
        reconnect.resolve();
        await adapter.close();
      }
    });

    it("keeps the tool directory when tool-call authorization ends without completing", async () => {
      const adapter = await failToolCallAuthorization();
      try {
        // 修复前授权失败会清空目录，且之后没有任何重连入口，server 永久停在 needs-auth。
        expect(adapter.getToolSnapshot().runtime?.tools?.map((item) => item.toolName)).toEqual([
          "oauth_ping",
        ]);
      } finally {
        await adapter.close();
      }
    });

    it("keeps the tool directory when the authorization transaction times out", async () => {
      // 授权事务到期由 withTimeout 抛出 McpTimeoutError。修复前 failConnection 先按超时归类为
      // connection_timeout，覆盖调用方传入的 oauth_authorization_failed：目录被清空，也没有重连入口。
      const adapter = await failToolCallAuthorization(
        new McpTimeoutError("MCP server runtime OAuth authorization timed out"),
      );
      try {
        expect(adapter.getToolSnapshot().runtime?.tools?.map((item) => item.toolName)).toEqual([
          "oauth_ping",
        ]);
      } finally {
        await adapter.close();
      }
    });

    it("does not start an authorization when an MCP App reconnects", async () => {
      const adapter = await failToolCallAuthorization();
      try {
        authMock.mockClear();
        clientConnectMock.mockClear();
        // 打开 MCP App 只传 reconnect：修复前会走授权失败重连，发起交互授权并发布链接。
        await expect(
          adapter.waitForServer("runtime", { reconnect: true, timeoutMs: 5_000 }),
        ).resolves.toEqual({ timedOut: false });
        expect(clientConnectMock).not.toHaveBeenCalled();
        expect(authMock).not.toHaveBeenCalled();
        const row = adapter.getToolSnapshot().runtime;
        expect(row?.status.failureKind).toBe("oauth_authorization_failed");
        expect(row?.status.authorization).toBeUndefined();
      } finally {
        await adapter.close();
      }
    });

    it("reconnects once on the next execution with credentials authorized elsewhere", async () => {
      const adapter = await failToolCallAuthorization();
      try {
        // 另一进程（设置页）已完成授权：Phase 1 直接连上，不再发起交互授权。
        authMock.mockClear();
        clientConnectMock.mockClear();
        clientConnectMock.mockResolvedValue(undefined);
        const waits = [
          adapter.waitForServer("runtime", {
            reconnect: true,
            reauthorize: true,
            timeoutMs: 5_000,
          }),
          adapter.waitForServer("runtime", {
            reconnect: true,
            reauthorize: true,
            timeoutMs: 5_000,
          }),
        ];
        // 重连期间保留目录，工具不会离开模型视图。
        expect(adapter.getToolSnapshot().runtime?.tools?.map((item) => item.toolName)).toEqual([
          "oauth_ping",
        ]);
        await expect(Promise.all(waits)).resolves.toEqual([
          { timedOut: false },
          { timedOut: false },
        ]);
        expect(adapter.getToolSnapshot().runtime?.status.status).toBe("connected");
        expect(clientConnectMock).toHaveBeenCalledTimes(1);
        expect(authMock).not.toHaveBeenCalled();
        await expect(
          adapter.callTool({ serverName: "runtime", toolName: "oauth_ping" }),
        ).resolves.toMatchObject({ content: [{ text: "ok" }] });
      } finally {
        await adapter.close();
      }
    });

    it("starts a new authorization on the next execution when credentials are still missing", async () => {
      const adapter = await failToolCallAuthorization();
      const gate = Promise.withResolvers<"AUTHORIZED" | Error>();
      try {
        publishAuthorizationThen(gate.promise);
        clientConnectMock.mockRejectedValueOnce(new UnauthorizedError());
        // 授权链接发布即结束等待，调用方据此立即返回 needs-auth。
        await expect(
          observePromiseWithin(
            adapter.waitForServer("runtime", {
              reconnect: true,
              reauthorize: true,
              timeoutMs: 5_000,
            }),
            1_000,
          ),
        ).resolves.toEqual({ status: "fulfilled", value: { timedOut: false } });
        const row = adapter.getToolSnapshot().runtime;
        expect(row?.status.authorization?.authorizationUrl).toContain(AUTHORIZATION_URL);
        expect(row?.tools?.map((item) => item.toolName)).toEqual(["oauth_ping"]);
      } finally {
        gate.resolve(new Error("closed"));
        await adapter.close();
      }
    });
  });

  it("converges Phase 2 orchestration errors to a retryable failed server status", async () => {
    const credentialError = new Error("Unable to read shared ZCode credentials");
    const credentialStore = {
      filePath: "/tmp/zcode-unreadable-credentials.json",
      load: vi.fn(async () => {
        throw credentialError;
      }),
      loadMany: vi.fn(async () => {
        throw credentialError;
      }),
    } as unknown as SharedZCodeCredentialStore;
    clientConnectMock.mockRejectedValue(new UnauthorizedError());
    const adapter = createMcpAdapter({
      mcpOAuth: {
        credentialStore,
      },
    });
    const config = {
      oauth: {
        type: "authorization_code" as const,
      },
      type: "http" as const,
      url: "https://mcp.example.test/mcp",
    };

    try {
      await expect(adapter.connectConfiguredServers({ broken: config })).resolves.toMatchObject({
        statuses: {
          broken: {
            error: "Unable to read shared ZCode credentials",
            failureKind: "oauth_authorization_failed",
            status: "failed",
          },
        },
      });
      await expect(adapter.status()).resolves.toMatchObject({
        broken: {
          failureKind: "oauth_authorization_failed",
          status: "failed",
        },
      });

      await expect(adapter.connectConfiguredServers({ broken: config })).resolves.toMatchObject({
        statuses: {
          broken: {
            failureKind: "oauth_authorization_failed",
            status: "failed",
          },
        },
      });
      // 相同配置 reconcile 不重试失败连接；显式连接操作（revalidate）仍可重试。
      expect(clientConnectMock).toHaveBeenCalledTimes(1);
      await adapter.connectServer("broken", config, { revalidate: true });
      expect(clientConnectMock).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close();
    }
  });

  it("only opens OAuth authorization URL when an opener is injected", async () => {
    const openAuthorizationUrl = vi.fn(async () => {});
    const { release: resolveConnect } = stubInteractiveAuthorization(
      "https://auth.example.test/authorize?state=state_test",
    );
    const adapter = createMcpAdapter({
      mcpOAuth: {
        openAuthorizationUrl,
      },
    });

    const connect = adapter.connectServer("notion", {
      type: "http",
      url: "https://mcp.example.test/mcp",
      oauth: {
        type: "authorization_code",
        clientName: "ZCode",
      },
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await adapter.status();
      if (status.notion?.authorization?.authorizationUrl) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(openAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationUrl: "https://auth.example.test/authorize?state=state_test",
        serverName: "notion",
      }),
    );

    resolveConnect();
    await expect(connect).resolves.toMatchObject({
      status: "connected",
      toolCount: 0,
    });
    await adapter.close();
  });

  describe("async startup snapshot and wait", () => {
    const LIST_CHANGED = "notifications/tools/list_changed";
    const stdio = { type: "stdio" as const, command: "node" };
    const tool = (name: string) => ({ name, inputSchema: { type: "object", properties: {} } });

    it("reads memory only: no tools while connecting, an empty list is distinct after connect", async () => {
      const gate = Promise.withResolvers<void>();
      clientConnectMock.mockImplementationOnce(() => gate.promise);
      const adapter = createMcpAdapter();
      const connecting = adapter.connectServer("demo", stdio);
      await vi.waitFor(() => expect(clientConnectMock).toHaveBeenCalledOnce());

      const before = adapter.getToolSnapshot!();
      expect(before.demo?.status.status).toBe("connecting");
      expect(before.demo?.tools).toBeUndefined();
      expect(before.demo?.toolsVersion).toBeUndefined();

      gate.resolve();
      await connecting;
      const after = adapter.getToolSnapshot!();
      expect(after.demo?.status.status).toBe("connected");
      expect(after.demo?.tools).toEqual([]);
      expect(after.demo?.toolsVersion).toEqual(expect.any(String));
      await adapter.close();
    });

    it("refreshes list_changed in the background and keeps alwaysLoad", async () => {
      clientListToolsMock.mockResolvedValueOnce({ tools: [tool("a")] });
      const adapter = createMcpAdapter();
      await adapter.connectServer("demo", { ...stdio, alwaysLoad: true });
      const first = adapter.getToolSnapshot!().demo!;

      const refresh = Promise.withResolvers<{ tools: unknown[] }>();
      clientListToolsMock.mockImplementationOnce(() => refresh.promise);
      capturedClients.at(-1)!.notificationHandlers.get(LIST_CHANGED)!({});
      await vi.waitFor(() => expect(clientListToolsMock).toHaveBeenCalledTimes(2));

      // 刷新进行中：快照立即返回旧列表，不等待网络。
      const during = adapter.getToolSnapshot!().demo!;
      expect(during.toolsVersion).toBe(first.toolsVersion);
      expect(during.tools?.map((item) => item.toolName)).toEqual(["a"]);

      refresh.resolve({ tools: [tool("b")] });
      await vi.waitFor(() =>
        expect(adapter.getToolSnapshot!().demo!.tools?.map((item) => item.toolName)).toEqual(["b"]),
      );
      const after = adapter.getToolSnapshot!().demo!;
      expect(after.toolsVersion).not.toBe(first.toolsVersion);
      expect(after.tools?.[0]?.alwaysLoad).toBe(true);
      expect(after.status.toolCount).toBe(1);
      await adapter.close();
    });

    it("retries a failed list refresh in the producer while snapshot reads stay pure", async () => {
      clientListToolsMock.mockResolvedValueOnce({ tools: [tool("a")] });
      const adapter = createMcpAdapter();
      await adapter.connectServer("demo", stdio);
      const first = adapter.getToolSnapshot!().demo!;
      const handler = capturedClients.at(-1)!.notificationHandlers.get(LIST_CHANGED)!;

      const failed = Promise.withResolvers<{ tools: unknown[] }>();
      clientListToolsMock.mockImplementationOnce(() => failed.promise);
      clientListToolsMock.mockResolvedValueOnce({ tools: [tool("c")] });
      handler({});
      failed.reject(new Error("list failed"));
      await vi.waitFor(() => expect(clientListToolsMock).toHaveBeenCalledTimes(2));
      // 清空一轮宏任务，确保失败分支已执行完（脏标记已重新置位），而不是靠 sleep。
      await new Promise((resolve) => setImmediate(resolve));
      expect(adapter.getToolSnapshot!().demo!.toolsVersion).toBe(first.toolsVersion);

      // 失败后保留脏标记，但读快照只读内存，反复读取也不会发起 tools/list。
      for (let index = 0; index < 3; index += 1) adapter.getToolSnapshot!();
      expect(clientListToolsMock).toHaveBeenCalledTimes(2);

      // 无第二次通知，也无 listTools 调用；由连接层推进失败后的重试。
      await vi.waitFor(
        () =>
          expect(adapter.getToolSnapshot!().demo!.tools?.map((item) => item.toolName)).toEqual([
            "c",
          ]),
        { timeout: 2000 },
      );
      expect(clientListToolsMock).toHaveBeenCalledTimes(3);
      await adapter.close();
    });

    it("cancels a list refresh backoff when its connection closes", async () => {
      vi.useFakeTimers();
      const adapter = createMcpAdapter();
      try {
        await adapter.connectServer("demo", stdio);
        clientListToolsMock.mockRejectedValueOnce(new Error("temporary list failure"));
        capturedClients.at(-1)!.notificationHandlers.get(LIST_CHANGED)!({});
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        await adapter.disconnectServer("demo");
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(clientListToolsMock).toHaveBeenCalledTimes(2);
      } finally {
        await adapter.close();
        vi.useRealTimers();
      }
    });

    it("ignores a late list_changed from a replaced client", async () => {
      clientListToolsMock.mockResolvedValueOnce({ tools: [tool("old")] });
      const adapter = createMcpAdapter();
      await adapter.connectServer("demo", stdio);
      const oldHandler = capturedClients.at(-1)!.notificationHandlers.get(LIST_CHANGED)!;
      clientListToolsMock.mockResolvedValueOnce({ tools: [tool("fresh")] });
      await adapter.connectServer("demo", { ...stdio, args: ["replacement"] });
      const replaced = adapter.getToolSnapshot!().demo!;
      const calls = clientListToolsMock.mock.calls.length;

      oldHandler({});
      await Promise.resolve();

      expect(clientListToolsMock).toHaveBeenCalledTimes(calls);
      expect(adapter.getToolSnapshot!().demo!).toEqual(replaced);
      await adapter.close();
    });

    it("runs one more pass when list_changed arrives during a refresh", async () => {
      const adapter = createMcpAdapter();
      await adapter.connectServer("demo", stdio);
      const handler = capturedClients.at(-1)!.notificationHandlers.get(LIST_CHANGED)!;

      const firstRefresh = Promise.withResolvers<{ tools: unknown[] }>();
      clientListToolsMock.mockImplementationOnce(() => firstRefresh.promise);
      clientListToolsMock.mockResolvedValueOnce({ tools: [tool("second")] });
      handler({});
      await vi.waitFor(() => expect(clientListToolsMock).toHaveBeenCalledTimes(2));
      handler({});
      // single-flight：进行中的刷新不会并发第二次 tools/list。
      expect(clientListToolsMock).toHaveBeenCalledTimes(2);
      firstRefresh.resolve({ tools: [tool("first")] });

      await vi.waitFor(() =>
        expect(adapter.getToolSnapshot!().demo!.tools?.map((item) => item.toolName)).toEqual([
          "second",
        ]),
      );
      expect(clientListToolsMock).toHaveBeenCalledTimes(3);
      await adapter.close();
    });

    it("drops a late refresh result after the connection is replaced", async () => {
      clientListToolsMock.mockResolvedValueOnce({ tools: [tool("old")] });
      const adapter = createMcpAdapter();
      await adapter.connectServer("demo", stdio);
      const late = Promise.withResolvers<{ tools: unknown[] }>();
      clientListToolsMock.mockImplementationOnce(() => late.promise);
      capturedClients.at(-1)!.notificationHandlers.get(LIST_CHANGED)!({});
      await vi.waitFor(() => expect(clientListToolsMock).toHaveBeenCalledTimes(2));

      clientListToolsMock.mockResolvedValueOnce({ tools: [tool("fresh")] });
      await adapter.connectServer("demo", { ...stdio, args: ["replacement"] });
      const replaced = adapter.getToolSnapshot!().demo!;
      late.resolve({ tools: [tool("late")] });
      await Promise.resolve();
      await Promise.resolve();

      expect(adapter.getToolSnapshot!().demo!).toEqual(replaced);
      expect(replaced.tools?.map((item) => item.toolName)).toEqual(["fresh"]);
      await adapter.close();
    });

    it("removes the stdio directory after an unexpected disconnect", async () => {
      clientListToolsMock.mockResolvedValueOnce({ tools: [tool("a")] });
      const adapter = createMcpAdapter();
      await adapter.connectServer("demo", stdio);
      const first = adapter.getToolSnapshot!().demo!;
      capturedClients.at(-1)!.onclose?.();
      const after = adapter.getToolSnapshot!().demo!;
      expect(first.tools).toHaveLength(1);
      expect(after.status.status).toBe("failed");
      expect(after.toolsVersion).toBeUndefined();
      expect(after.tools).toBeUndefined();
      await adapter.close();
    });

    it("waits for the shared startup with a bound and cancel without closing the connection", async () => {
      const gate = Promise.withResolvers<void>();
      clientConnectMock.mockImplementationOnce(() => gate.promise);
      const adapter = createMcpAdapter();
      const connecting = adapter.connectServer("demo", stdio);
      await vi.waitFor(() => expect(clientConnectMock).toHaveBeenCalledOnce());

      await expect(adapter.waitForServer!("demo", { timeoutMs: 1 })).resolves.toEqual({
        timedOut: true,
      });
      const abort = new AbortController();
      const aborted = adapter.waitForServer!("demo", { signal: abort.signal, timeoutMs: 60_000 });
      abort.abort(new Error("caller cancelled"));
      await expect(aborted).rejects.toThrow("caller cancelled");
      expect(adapter.getToolSnapshot!().demo!.status.status).toBe("connecting");

      const waiting = adapter.waitForServer!("demo", { timeoutMs: 60_000 });
      gate.resolve();
      await expect(waiting).resolves.toEqual({ timedOut: false });
      await connecting;
      expect(clientConnectMock).toHaveBeenCalledOnce();
      await expect(adapter.waitForServer!("demo", { timeoutMs: 1 })).resolves.toEqual({
        timedOut: false,
      });
      await expect(adapter.waitForServer!("missing", { timeoutMs: 1 })).resolves.toEqual({
        timedOut: false,
      });
      await adapter.close();
    });

    it("reconnects a disconnected server only when the execution check asks for it", async () => {
      clientListToolsMock.mockResolvedValueOnce({ tools: [tool("a")] });
      const adapter = createMcpAdapter();
      await adapter.connectServer("demo", stdio);
      capturedClients.at(-1)!.onclose?.();

      // WaitForMcpServers 不带 reconnect：断线 server 不自动重连。
      await expect(adapter.waitForServer!("demo", { timeoutMs: 60_000 })).resolves.toEqual({
        timedOut: false,
      });
      expect(clientConnectMock).toHaveBeenCalledOnce();
      expect(adapter.getToolSnapshot!().demo!.status.status).toBe("failed");

      clientListToolsMock.mockResolvedValueOnce({ tools: [tool("b")] });
      await expect(
        adapter.waitForServer!("demo", { timeoutMs: 60_000, reconnect: true }),
      ).resolves.toEqual({ timedOut: false });
      expect(clientConnectMock).toHaveBeenCalledTimes(2);
      const recovered = adapter.getToolSnapshot!().demo!;
      expect(recovered.status.status).toBe("connected");
      expect(recovered.tools?.map((item) => item.toolName)).toEqual(["b"]);
      await adapter.close();
    });

    it("keeps a waiter pending while a reconnect is still closing the previous connection", async () => {
      const adapter = createMcpAdapter();
      await adapter.connectServer("demo", stdio);
      const closing = Promise.withResolvers<void>();
      clientCloseMock.mockImplementationOnce(() => closing.promise);
      const reconnecting = adapter.connectServer("demo", { ...stdio, args: ["replacement"] });

      // 旧连接还在关闭、新握手尚未开始：新的 connecting 记录必须已登记，等待不能凭旧的 connected 记录立即成功。
      expect(adapter.getToolSnapshot!().demo!.status.status).toBe("connecting");
      await expect(adapter.waitForServer!("demo", { timeoutMs: 1 })).resolves.toEqual({
        timedOut: true,
      });
      const waiting = adapter.waitForServer!("demo", { timeoutMs: 60_000 });
      closing.resolve();
      await expect(waiting).resolves.toEqual({ timedOut: false });
      await expect(reconnecting).resolves.toMatchObject({ status: "connected" });
      await adapter.close();
    });

    it("returns a waiter as soon as startup turns into a pending OAuth authorization", async () => {
      const beforeAuthorization = Promise.withResolvers<void>();
      const { release } = stubInteractiveAuthorization(
        "https://auth.example.test/authorize?state=state_wait",
        beforeAuthorization.promise,
      );
      const adapter = createMcpAdapter();
      const connecting = adapter.connectServer("notion", {
        type: "http",
        url: "https://mcp.example.test/mcp",
        oauth: { type: "authorization_code", clientName: "ZCode" },
      });
      await vi.waitFor(() => expect(authMock).toHaveBeenCalled());
      expect(adapter.getToolSnapshot!().notion?.status.authorization).toBeUndefined();

      // 调用开始时只是普通 connecting；授权需要用户处理时立即结束本次等待，不等满预算。
      const waiting = adapter.waitForServer!("notion", { timeoutMs: 60_000 });
      beforeAuthorization.resolve();
      await expect(waiting).resolves.toEqual({ timedOut: false });
      expect(adapter.getToolSnapshot!().notion?.status.authorization?.authorizationUrl).toBe(
        "https://auth.example.test/authorize?state=state_wait",
      );
      // 已处于授权等待时再调用，也立即返回；底层授权不被取消。
      await expect(adapter.waitForServer!("notion", { timeoutMs: 60_000 })).resolves.toEqual({
        timedOut: false,
      });

      release();
      await expect(connecting).resolves.toMatchObject({ status: "connected" });
      await adapter.close();
    });
  });
  it("retries list refresh on the recovered connection and cancels it when that connection closes", async () => {
    const adapter = createMcpAdapter();
    const tool = (name: string) => ({ name, inputSchema: { type: "object" } });
    clientListToolsMock.mockResolvedValue({ tools: [tool("old")] } as never);
    await adapter.connectServer("remote", { type: "sse", url: "https://example.test/mcp" });
    capturedClients.at(-1)!.onclose?.();
    await adapter.waitForServer!("remote", { timeoutMs: 1000 });
    expect(adapter.getToolSnapshot!().remote?.status.status).toBe("connected");
    vi.useFakeTimers();
    try {
      clientListToolsMock
        .mockRejectedValueOnce(new Error("transient list failure"))
        .mockResolvedValueOnce({ tools: [tool("new")] } as never);
      capturedClients.at(-1)!.notificationHandlers.get("notifications/tools/list_changed")!({});
      await vi.advanceTimersByTimeAsync(1000);
      expect(adapter.getToolSnapshot!().remote?.tools?.map((t) => t.toolName)).toEqual(["new"]);
      clientListToolsMock.mockRejectedValue(new Error("another list failure"));
      capturedClients.at(-1)!.notificationHandlers.get("notifications/tools/list_changed")!({});
      await vi.advanceTimersByTimeAsync(0);
      const calls = clientListToolsMock.mock.calls.length;
      await adapter.close();
      await vi.runAllTimersAsync();
      expect(clientListToolsMock).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
      await adapter.close();
    }
  });
});

// 回归：远程意外断连在后台恢复，等待期间不丢目录。
it("keeps remote tools pending until shared background recovery settles", async () => {
  const adapter = createMcpAdapter();
  clientListToolsMock.mockResolvedValue({
    tools: [{ name: "ping", inputSchema: { type: "object" } }],
  } as never);
  await adapter.connectServer("remote", { type: "http", url: "https://example.test/mcp" });
  const release = Promise.withResolvers<void>();
  clientConnectMock.mockImplementationOnce(() => release.promise);
  capturedClients.at(-1)!.onclose?.();
  expect(adapter.getToolSnapshot?.()?.remote?.status.status).toBe("connecting");
  expect(adapter.getToolSnapshot?.()?.remote?.tools?.[0]?.toolName).toBe("ping");
  const waiting = adapter.waitForServer!("remote", { timeoutMs: 1000 });
  release.resolve();
  await waiting;
  expect(adapter.getToolSnapshot?.()?.remote?.status.status).toBe("connected");
  await adapter.close();
});

it("exhausts five remote recovery attempts and drops the retained directory", async () => {
  const adapter = createMcpAdapter();
  clientListToolsMock.mockResolvedValue({
    tools: [{ name: "ping", inputSchema: { type: "object" } }],
  } as never);
  await adapter.connectServer("remote", { type: "http", url: "https://example.test/mcp" });
  const calls = clientConnectMock.mock.calls.length;
  vi.useFakeTimers();
  try {
    clientConnectMock.mockRejectedValue(new Error("offline"));
    capturedClients.at(-1)!.onclose?.();
    expect(adapter.getToolSnapshot!().remote?.status.status).toBe("connecting");
    await vi.runAllTimersAsync();
    expect(clientConnectMock.mock.calls.length - calls).toBe(5);
    expect(adapter.getToolSnapshot!().remote?.status.status).toBe("failed");
    expect(await adapter.listTools()).toEqual([]);
  } finally {
    vi.useRealTimers();
    await adapter.close();
  }
});
