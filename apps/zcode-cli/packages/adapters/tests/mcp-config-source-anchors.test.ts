import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDynamicMcpConfigSource } from "../src/mcp/config-source.js";

const state = vi.hoisted(() => ({
  watchers: [] as Array<EventEmitter & { anchor: string }>,
}));
vi.mock("chokidar", () => ({
  watch: (anchor: string) => {
    const watcher = Object.assign(new EventEmitter(), { anchor, close: vi.fn(async () => {}) });
    state.watchers.push(watcher);
    queueMicrotask(() => watcher.emit("ready"));
    return watcher;
  },
}));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcp-config-anchors-"));
  state.watchers = [];
});
afterEach(() => rm(root, { recursive: true, force: true }));

function inside(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith("..") && child !== path);
}

it("does not watch above the known roots when configuration directories are missing", async () => {
  const workspace = join(root, "home", "dev", "workspace");
  const home = join(root, "home", "dev");
  await mkdir(workspace, { recursive: true });
  const userConfig = join(home, ".zcode", "v2", "config.json");
  const projectConfig = join(workspace, ".zcode", "config.json");
  const source = await createDynamicMcpConfigSource({
    configPaths: [projectConfig, userConfig],
    userConfigPath: userConfig,
    fallbackPaths: {
      [userConfig]: join(home, ".agents", "mcp.json"),
      [projectConfig]: join(workspace, ".agents", "mcp.json"),
    },
    pluginStorageRoot: join(home, ".zcode", "v2", "plugins"),
    pluginRoots: [],
    workingDirectory: workspace,
  });
  try {
    const anchors = state.watchers.map((watcher) => watcher.anchor);
    // 修复前缺失目录一路向上找到已存在的目录并再监听其父目录，会监听用户目录与其上级。
    expect(anchors).toEqual([workspace]);
    expect(anchors.every((anchor) => inside(workspace, anchor))).toBe(true);
    expect(anchors).not.toContain(home);
    expect(anchors).not.toContain(dirname(workspace));
  } finally {
    source.close();
  }
});

it("rebinds a watcher that fails after it became ready", async () => {
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ mcp: { servers: {} } }));
  const source = await createDynamicMcpConfigSource({
    configPaths: [config],
    userConfigPath: config,
    pluginStorageRoot: join(root, "plugins"),
    pluginRoots: [],
    workingDirectory: root,
  });
  try {
    const failed = state.watchers.find((watcher) => watcher.anchor === root)!;
    expect(failed).toBeDefined();
    const before = state.watchers.length;
    // 修复前就绪后报错只删除 watcher，之后的配置变化不再被发现。
    failed.emit("error", Object.assign(new Error("watch failed"), { code: "EIO" }));
    await vi.waitFor(
      () =>
        expect(state.watchers.slice(before).some((watcher) => watcher.anchor === root)).toBe(true),
      { timeout: 2_000 },
    );
    const changed = Promise.withResolvers<void>();
    source.subscribe(() => {
      if (source.getSnapshot().servers.fresh) changed.resolve();
    });
    await writeFile(config, JSON.stringify({ mcp: { servers: { fresh: { command: "node" } } } }));
    state.watchers.at(-1)!.emit("all", "change", config);
    await changed.promise;
  } finally {
    source.close();
  }
});
