import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createDynamicMcpConfigSource } from "../src/mcp/config-source.js";

const { watchers } = vi.hoisted(() => ({ watchers: [] as EventEmitter[] }));
vi.mock("chokidar", () => ({
  watch: () => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) });
    watchers.push(watcher);
    queueMicrotask(() => watcher.emit("ready"));
    return watcher;
  },
}));

it.each([null, undefined, 0])(
  "reloads the watched anchor on raw events with filename %s",
  async (filename) => {
    const root = await mkdtemp(join(tmpdir(), "mcp-raw-event-"));
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
      const changed = Promise.withResolvers<void>();
      source.subscribe(() => {
        if (source.getSnapshot().servers.fresh) changed.resolve();
      });
      await writeFile(config, JSON.stringify({ mcp: { servers: { fresh: { command: "node" } } } }));
      expect(() => {
        for (const watcher of watchers)
          watcher.emit("raw", "change", filename, { watchedPath: root });
      }).not.toThrow();
      await changed.promise;
      expect(source.getSnapshot().servers.fresh).toMatchObject({ command: "node" });
    } finally {
      source.close();
      await rm(root, { recursive: true, force: true });
      watchers.length = 0;
    }
  },
);
