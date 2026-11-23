import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpConfigurationSnapshot, McpServerConfig } from "@zcode/contracts";
import { createMcpConfigurationLoader } from "../src/mcp/config-loader.js";
import {
  MCP_CONFIG_EVENT_DEBOUNCE_MS,
  createDynamicMcpConfigSource,
  createMcpConfigSourceRegistry,
} from "../src/mcp/config-source.js";

// 进程内共享配置源：同一 key 只有一组 watcher，一次写入的事件突发只读一次盘。
const CONFIG_PATH = "/workspace/config.json";
const PLUGIN_MANIFEST = "/workspace/plugin/.zcode-plugin/plugin.json";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  reads: new Map<string, number>(),
  watchers: [] as Array<EventEmitter & { close: ReturnType<typeof vi.fn> }>,
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }),
  // 全部文件端口都是虚拟的：真实 IO 不受假定时器推进，读盘链会停在半途。
  access: async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  },
  mkdir: vi.fn(async () => undefined),
  readFile: async (path: string) => {
    state.reads.set(path, (state.reads.get(path) ?? 0) + 1);
    const content = state.files.get(path);
    if (content !== undefined) return content;
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  },
}));
vi.mock("../src/mcp/config-loader.js", async (original) => {
  const actual = await original<typeof import("../src/mcp/config-loader.js")>();
  return { ...actual, createMcpConfigurationLoader: vi.fn(actual.createMcpConfigurationLoader) };
});
vi.mock("chokidar", () => ({
  watch: () => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) });
    state.watchers.push(watcher);
    queueMicrotask(() => watcher.emit("ready"));
    return watcher;
  },
}));

function writeConfig(servers: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  state.files.set(CONFIG_PATH, JSON.stringify({ mcp: { servers }, ...extra }));
}

function loads(): number {
  return state.reads.get(CONFIG_PATH) ?? 0;
}

function options(extra: { defaultEnabledPlugins?: ReadonlySet<string> } = {}) {
  return {
    configPaths: [CONFIG_PATH],
    userConfigPath: CONFIG_PATH,
    pluginStorageRoot: "/workspace/plugins",
    pluginRoots: [],
    workingDirectory: "/workspace",
    ...extra,
  };
}

/** 模拟一次保存：同一文件的 raw 与 all 事件交替到达。 */
function emitWriteBurst(): void {
  for (const watcher of state.watchers) {
    watcher.emit("raw", "change", "config.json", { watchedPath: "/workspace" });
    watcher.emit("all", "change", CONFIG_PATH);
    watcher.emit("raw", "rename", "config.json", { watchedPath: "/workspace" });
  }
}

/** 推过去抖窗口并排空随后的读盘链。 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(MCP_CONFIG_EVENT_DEBOUNCE_MS);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  state.files.clear();
  state.reads.clear();
  state.watchers = [];
  writeConfig({ first: { command: "node" } });
});

afterEach(() => {
  vi.useRealTimers();
});

it("loads once for a burst of events from one write", async () => {
  const source = await createDynamicMcpConfigSource(options());
  try {
    const before = loads();
    writeConfig({ second: { command: "node" } });
    emitWriteBurst();
    await settle();
    // 修复前每个事件都把 drain 标脏：一次保存读 2 次以上，多个会话再各读一遍。
    expect(loads() - before).toBe(1);
    expect(Object.keys(source.getSnapshot().servers)).toEqual(["second"]);
  } finally {
    source.close();
  }
});

it("shares one watcher set for sessions with the same inputs", async () => {
  const registry = createMcpConfigSourceRegistry();
  const first = await registry.acquire(options());
  const watchers = state.watchers.length;
  const second = await registry.acquire(options());
  try {
    expect(watchers).toBeGreaterThan(0);
    expect(state.watchers).toHaveLength(watchers);
  } finally {
    first.close();
    second.close();
    registry.close();
  }
});

it("does not share a source between sessions admitted with different workspace plugin trust", async () => {
  // 修复前键里只有官方根目录：信任前创建的会话与信任后的新会话共用一个源，新会话拿不到插件 MCP。
  const root = (state: "pending" | "trusted") => ({
    rootPath: "/workspace/plugin",
    marketplace: "inline",
    source: "inline" as const,
    workspaceTrust: { state, pluginRoot: "plugin", declarationDigest: "a".repeat(64) },
  });
  const registry = createMcpConfigSourceRegistry();
  const pending = await registry.acquire({ ...options(), pluginRoots: [root("pending")] });
  const watchers = state.watchers.length;
  const trusted = await registry.acquire({ ...options(), pluginRoots: [root("trusted")] });
  try {
    expect(state.watchers.length).toBeGreaterThan(watchers);
  } finally {
    pending.close();
    trusted.close();
    registry.close();
  }
});

it("reads the latest files on acquire even without a watcher event", async () => {
  const registry = createMcpConfigSourceRegistry();
  const first = await registry.acquire(options());
  const firstNotified = vi.fn();
  first.subscribe(firstNotified);
  try {
    writeConfig({ fresh: { command: "node" } });
    const second = await registry.acquire(options());
    try {
      expect(Object.keys(second.getSnapshot().servers)).toEqual(["fresh"]);
      expect(Object.keys(first.getSnapshot().servers)).toEqual(["fresh"]);
      expect(firstNotified).toHaveBeenCalledOnce();
    } finally {
      second.close();
    }
  } finally {
    first.close();
    registry.close();
  }
});

it("skips a pending debounce timer when a new session acquires", async () => {
  const registry = createMcpConfigSourceRegistry();
  const first = await registry.acquire(options());
  try {
    writeConfig({ fresh: { command: "node" } });
    emitWriteBurst();
    expect(vi.getTimerCount()).toBe(1);
    const second = await registry.acquire(options());
    try {
      expect(Object.keys(second.getSnapshot().servers)).toEqual(["fresh"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      second.close();
    }
  } finally {
    first.close();
    registry.close();
  }
});

it("keeps other views updated after one view is closed twice", async () => {
  const registry = createMcpConfigSourceRegistry();
  const first = await registry.acquire(options());
  const second = await registry.acquire(options());
  const secondNotified = vi.fn();
  second.subscribe(secondNotified);
  try {
    // 一次 app 关闭会多次走 beginShutdown；view 释放必须幂等，引用计数只减一次。
    first.close();
    first.close();
    expect(state.watchers.every((watcher) => watcher.close.mock.calls.length === 0)).toBe(true);
    writeConfig({ later: { command: "node" } });
    emitWriteBurst();
    await settle();
    expect(secondNotified).toHaveBeenCalledOnce();
    expect(Object.keys(second.getSnapshot().servers)).toEqual(["later"]);
  } finally {
    second.close();
    registry.close();
  }
});

it("closes watchers and timers when the last view is released", async () => {
  const registry = createMcpConfigSourceRegistry();
  const first = await registry.acquire(options());
  const second = await registry.acquire(options());
  const notified = vi.fn();
  first.subscribe(notified);
  second.subscribe(notified);
  writeConfig({ late: { command: "node" } });
  emitWriteBurst();
  first.close();
  second.close();
  const before = loads();
  expect(state.watchers.every((watcher) => watcher.close.mock.calls.length === 1)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await settle();
  expect(loads()).toBe(before);
  expect(notified).not.toHaveBeenCalled();
  registry.close();
});

it("releases the entry when a view fails to prepare and retries on the next acquire", async () => {
  const registry = createMcpConfigSourceRegistry();
  await expect(
    registry.acquire({
      ...options(),
      prepare() {
        throw new Error("prepare failed");
      },
    }),
  ).rejects.toThrow("prepare failed");
  expect(state.watchers.every((watcher) => watcher.close.mock.calls.length === 1)).toBe(true);
  const watchers = state.watchers.length;
  const source = await registry.acquire(options());
  try {
    expect(state.watchers.length).toBeGreaterThan(watchers);
    expect(Object.keys(source.getSnapshot().servers)).toEqual(["first"]);
  } finally {
    source.close();
    registry.close();
  }
});

it("keeps per-session preparation isolated on a shared entry", async () => {
  const registry = createMcpConfigSourceRegistry();
  const withHost = (name: string) => ({
    ...options(),
    prepare: (servers: Record<string, McpServerConfig>, _plugins: unknown, enabled: boolean) => ({
      enabled,
      servers: { ...servers, [name]: { type: "stdio" as const, command: name } },
    }),
  });
  const first = await registry.acquire(withHost("alpha"));
  const second = await registry.acquire(withHost("beta"));
  try {
    writeConfig({ later: { command: "node" } });
    emitWriteBurst();
    await settle();
    expect(Object.keys(first.getSnapshot().servers).sort()).toEqual(["alpha", "later"]);
    expect(Object.keys(second.getSnapshot().servers).sort()).toEqual(["beta", "later"]);
  } finally {
    first.close();
    second.close();
    registry.close();
  }
});

it("separates entries whose default-enabled plugin sets differ", async () => {
  const registry = createMcpConfigSourceRegistry();
  // Set 直接参与 mcpConfigKey 会序列化成 "{}"，不同集合必须得到不同的 key。
  const first = await registry.acquire(options({ defaultEnabledPlugins: new Set(["a@official"]) }));
  const watchers = state.watchers.length;
  const second = await registry.acquire(
    options({ defaultEnabledPlugins: new Set(["b@official"]) }),
  );
  try {
    expect(state.watchers.length).toBe(watchers * 2);
  } finally {
    first.close();
    second.close();
    registry.close();
  }
});

it("lets every view see plugin servers by identity on a shared entry", async () => {
  writeConfig({}, { plugins: { dirs: ["/workspace/plugin"] } });
  state.files.set(
    PLUGIN_MANIFEST,
    JSON.stringify({ name: "example", mcpServers: { service: { command: "node" } } }),
  );
  const registry = createMcpConfigSourceRegistry();
  // 官方 CUA 信任按对象身份判定；各 view 共用同一份原始结果，不能各自深拷贝。
  const trusted = {
    ...options(),
    prepare: (
      servers: Record<string, McpServerConfig>,
      pluginServers: Record<string, McpServerConfig>,
      enabled: boolean,
    ): McpConfigurationSnapshot => ({
      enabled,
      servers,
      trustedOfficialCuaServerNames: Object.keys(pluginServers).filter(
        (name) => servers[name] === pluginServers[name],
      ),
    }),
  };
  const first = await registry.acquire(trusted);
  const second = await registry.acquire(trusted);
  try {
    expect(first.getSnapshot().trustedOfficialCuaServerNames).toEqual(["plugin:example:service"]);
    expect(second.getSnapshot().trustedOfficialCuaServerNames).toEqual(["plugin:example:service"]);
  } finally {
    first.close();
    second.close();
    registry.close();
  }
});

it("does not keep the creating session's preparation in the shared entry", async () => {
  const registry = createMcpConfigSourceRegistry();
  const first = await registry.acquire({
    ...options(),
    prepare: (_servers, _plugins, enabled) => ({ enabled, servers: {} }),
  });
  try {
    // 修复前条目持有创建者的 options：prepare 闭包引用创建者的 app 作用域，该会话关闭后仍不能回收。
    expect(vi.mocked(createMcpConfigurationLoader).mock.lastCall?.[0]).not.toHaveProperty(
      "prepare",
    );
  } finally {
    first.close();
    registry.close();
  }
});
