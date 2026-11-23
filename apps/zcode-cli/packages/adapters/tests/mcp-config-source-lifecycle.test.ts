import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createDynamicMcpConfigSource } from "../src/mcp/config-source.js";

const state = vi.hoisted(() => ({
  config: "{}",
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
  blocked: false,
  watchers: [] as EventEmitter[],
  files: new Map<string, string>(),
  reading: "",
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }),
  // 虚拟配置文件系统也负责发布前的数据目录准备，不能落到真实 /workspace。
  mkdir: vi.fn(async () => undefined),
  readFile: async (path: string) => {
    if (state.files.has(path)) {
      const captured = state.files.get(path)!;
      if (state.reading === path) {
        state.entered.resolve();
        await state.release.promise;
      }
      return captured;
    }
    if (path === "/workspace/config.json") {
      if (state.blocked) {
        state.entered.resolve();
        await state.release.promise;
      }
      return state.config;
    }
    if (path === "/new-plugin/.zcode-plugin/plugin.json")
      return JSON.stringify({ name: "test", mcpServers: { service: { command: "node" } } });
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  },
}));
vi.mock("chokidar", () => ({
  watch: () => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) });
    state.watchers.push(watcher);
    queueMicrotask(() => watcher.emit("ready"));
    return watcher;
  },
}));

it("does not create watchers or publish a delayed configuration after close", async () => {
  const source = await createDynamicMcpConfigSource({
    configPaths: ["/workspace/config.json"],
    userConfigPath: "/workspace/config.json",
    pluginStorageRoot: "/workspace/plugins",
    pluginRoots: [],
    workingDirectory: "/workspace",
  });
  const published = vi.fn();
  source.subscribe(published);
  const watchers = state.watchers.length;
  state.blocked = true;
  state.config = JSON.stringify({ plugins: { dirs: ["/new-plugin"] } });
  state.watchers[0]!.emit("all", "change", "/workspace/config.json");
  await state.entered.promise;
  source.close();
  state.release.resolve();
  // 文件端口返回已解决的 Promise；一个事件循环边界排空本次读取链，无真实磁盘时序假设。
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(state.watchers).toHaveLength(watchers);
  expect(published).not.toHaveBeenCalled();
  expect(source.getSnapshot().servers).toEqual({});
});

it("rereads newly declared files under an existing watched directory after coverage changes", async () => {
  state.blocked = false;
  state.watchers = [];
  state.entered = Promise.withResolvers<void>();
  state.release = Promise.withResolvers<void>();
  state.config = JSON.stringify({ plugins: { dirs: ["/workspace/plugin"] } });
  const manifest = "/workspace/plugin/.zcode-plugin/plugin.json";
  const oldFile = "/workspace/plugin/old.json";
  const newFile = "/workspace/plugin/new.json";
  state.files.set(manifest, JSON.stringify({ name: "example", mcpServers: "old.json" }));
  state.files.set(oldFile, JSON.stringify({ mcpServers: { service: { command: "old" } } }));
  const source = await createDynamicMcpConfigSource({
    configPaths: ["/workspace/config.json"],
    userConfigPath: "/workspace/config.json",
    pluginStorageRoot: "/workspace/plugins",
    pluginRoots: [],
    workingDirectory: "/workspace",
  });
  try {
    const changed = Promise.withResolvers<void>();
    source.subscribe(() => changed.resolve());
    state.files.set(manifest, JSON.stringify({ name: "example", mcpServers: "new.json" }));
    state.files.set(newFile, JSON.stringify({ mcpServers: { service: { command: "stale" } } }));
    state.reading = newFile;
    state.watchers[0]!.emit("all", "change", manifest);
    await state.entered.promise;
    // 新文件尚未进入订阅集合，故此更新没有 watcher 事件；ready 后的重读必须捕获它。
    state.files.set(newFile, JSON.stringify({ mcpServers: { service: { command: "fresh" } } }));
    state.reading = "";
    state.release.resolve();
    await changed.promise;
    expect(Object.values(source.getSnapshot().servers)).toEqual([
      expect.objectContaining({ command: "fresh" }),
    ]);
  } finally {
    source.close();
    state.files.clear();
  }
});

it("publishes private workspace options on save and falls back to user options on removal", async () => {
  state.blocked = false;
  state.watchers = [];
  state.files.clear();
  state.config = JSON.stringify({
    plugins: { dirs: ["/workspace/plugin"], options: { "example@inline": { label: "user" } } },
  });
  const project = "/workspace/project/.zcode/config.json";
  const secrets = "/workspace/plugin-secrets.json";
  state.files.set(
    project,
    JSON.stringify({ plugins: { options: { "example@inline": { label: "repository" } } } }),
  );
  state.files.set(
    "/workspace/plugin/.zcode-plugin/plugin.json",
    JSON.stringify({
      name: "example",
      userConfig: { label: { type: "string" } },
      mcpServers: { service: { command: "node", env: { LABEL: "${user_config.label}" } } },
    }),
  );
  const source = await createDynamicMcpConfigSource({
    configPaths: [project, "/workspace/config.json"],
    userConfigPath: "/workspace/config.json",
    pluginStorageRoot: "/workspace/plugins",
    pluginRoots: [],
    workingDirectory: "/workspace/project",
  });
  const label = () => Object.values(source.getSnapshot().servers)[0]?.env?.LABEL;
  try {
    expect(label()).toBe("user");
    let changed = Promise.withResolvers<void>();
    source.subscribe(() => changed.resolve());
    state.files.set(
      secrets,
      JSON.stringify({
        version: 1,
        user: {},
        workspaces: {
          "/workspace/project": { "example@inline": { label: "private" } },
        },
      }),
    );
    for (const watcher of state.watchers) watcher.emit("all", "add", secrets);
    await changed.promise;
    expect(label()).toBe("private");
    changed = Promise.withResolvers<void>();
    state.files.delete(secrets);
    for (const watcher of state.watchers) watcher.emit("all", "unlink", secrets);
    await changed.promise;
    expect(label()).toBe("user");
  } finally {
    source.close();
    state.files.clear();
  }
});
