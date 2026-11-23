import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createNodePluginAdapter } from "../src/plugins/index.js";

const BROKEN_PLUGIN_NAME = "broken-plugin";

// manifest 校验已把已知的坏字段（如 userConfig 项不是对象）拦在发现入口；这里模拟组件准备阶段
// 仍然抛错的情况。修复前异常会中断整个启动加载，一个坏插件让会话无法创建。
vi.mock("../src/plugins/ui-surfaces.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/plugins/ui-surfaces.js")>();
  return {
    ...actual,
    parsePluginUiSurfaces: (input: Parameters<typeof actual.parsePluginUiSurfaces>[0]) => {
      if (input.loaded.manifest.name === BROKEN_PLUGIN_NAME)
        throw new Error("component preparation failed");
      return actual.parsePluginUiSurfaces(input);
    },
  };
});

it("isolates a plugin whose components cannot be prepared", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-plugin-isolation-"));
  const good = join(root, "good");
  const broken = join(root, "broken");
  try {
    for (const [pluginRoot, manifest] of [
      [good, { name: "good-plugin", mcpServers: { demo: { command: "node" } } }],
      [broken, { name: BROKEN_PLUGIN_NAME, mcpServers: { broken: { command: "must-not-start" } } }],
    ] as const) {
      await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
      await writeFile(join(pluginRoot, ".zcode-plugin", "plugin.json"), JSON.stringify(manifest));
    }
    const storageRoot = join(root, "storage");
    const outcome = await createNodePluginAdapter({ storageRoot }).discoverPlugins({
      config: { dirs: [broken, good], enabled: true, enabledPlugins: {}, options: {} },
      env: {},
      storageRoot,
      workingDirectory: root,
    });
    expect(Object.keys(outcome.mcpServers)).toEqual(["plugin:good-plugin:demo"]);
    expect(outcome.plugins.map((plugin) => plugin.id)).toEqual(["good-plugin@inline"]);
    expect(outcome.diagnostics).toContainEqual(
      expect.objectContaining({ code: "plugin_load_failed", pluginId: "broken-plugin@inline" }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
