import { describe, expect, it } from "vitest";
import type { PluginLoadOutcome, PluginMetadata } from "@zcode/contracts";
import { resolvePluginRuntimeFeatures } from "../src/app/plugin-runtime-features.js";
import { resolveBuiltInNodeReplMcpServers } from "../src/app/built-in-node-repl.js";

function plugin(id: string, enabled: boolean, rootPath = "/tmp/plugin"): PluginMetadata {
  const [name = id, marketplace = "test"] = id.split("@");
  return {
    commandRootCount: 0,
    components: [],
    dataPath: "/tmp/plugin-data",
    declaredMcpServerNames: [],
    enabled,
    hookDetails: [],
    id,
    manifestPath: `${rootPath}/.zcode-plugin/plugin.json`,
    marketplace,
    mcpServerNames: [],
    name,
    rootPath,
    skillCount: 0,
    skillRootCount: 0,
    source: "official",
  };
}

function outcome(plugins: PluginMetadata[]): Pick<PluginLoadOutcome, "plugins"> {
  return { plugins };
}

describe("resolvePluginRuntimeFeatures", () => {
  it("enables browser-use without exposing the legacy core node_repl tools", () => {
    expect(
      resolvePluginRuntimeFeatures(outcome([plugin("browser-use@zcode-plugins-official", true)])),
    ).toEqual({
      browserUse: true,
      browserDocumentationRoot: "/tmp/plugin/docs",
    });
  });

  it("exposes only the stateless modern node_repl runtime, served from the host root", () => {
    const enabledServers = resolveBuiltInNodeReplMcpServers({
      pluginOutcome: outcome([
        plugin("node-repl-host@zcode-plugins-official", true, "/tmp/host"),
        plugin("browser-use@zcode-plugins-official", true),
      ]),
      workingDirectory: "/workspace",
    });
    expect(enabledServers.node_repl).toMatchObject({
      command: process.execPath,
      cwd: "/workspace",
      env: { ELECTRON_RUN_AS_NODE: "1", ZCODE_PLUGIN_ROOT: "/tmp/plugin" },
      timeoutMs: 600_000,
      isolation: "workspace",
      protocolVersion: "2026-07-28",
      // 内建来源决定进程意外退出后由 adapter 自动重启（docs/mcp-stateless-node-repl.md）。
      source: { kind: "builtin" },
      type: "stdio",
    });
    // 产物来自宿主自己的 root，不再来自 browser-use 的 root。
    expect(
      enabledServers.node_repl?.type === "stdio"
        ? enabledServers.node_repl.args?.at(-1)
        : undefined,
    ).toBe("/tmp/host/dist/mcp/server.js");
    expect(enabledServers.browser_use).toBeUndefined();
  });

  it("does not register node_repl when the shared host is missing", () => {
    // 宿主缺失只能安全地不注册：没有宿主可跑，绝不回退到某个插件包里的旧产物。
    expect(
      resolveBuiltInNodeReplMcpServers({
        pluginOutcome: outcome([plugin("browser-use@zcode-plugins-official", true)]),
        workingDirectory: "/workspace",
      }),
    ).toEqual({});
  });

  it("serves Computer Use without the Browser Use package", () => {
    // 回归（2026-09-11）：宿主产物过去只从 browser-use 的 rootPath 取，browser-use 包缺失时
    // 即便 CUA 启用也拿不到宿主。三个包独立后两个能力对称。
    const servers = resolveBuiltInNodeReplMcpServers({
      pluginOutcome: outcome([
        plugin("node-repl-host@zcode-plugins-official", true, "/tmp/host"),
        plugin("computer-use@zcode-plugins-official", true, "/tmp/cua-plugin"),
      ]),
      workingDirectory: "/workspace",
    });
    expect(servers.node_repl).toMatchObject({
      env: { ZCODE_CUA_PLUGIN_ROOT: "/tmp/cua-plugin" },
      type: "stdio",
    });
    // browser-use 不在时不注入它的 root，宿主据此知道浏览器那半边不可用。
    expect(
      servers.node_repl?.type === "stdio" ? servers.node_repl.env?.ZCODE_PLUGIN_ROOT : undefined,
    ).toBeUndefined();
  });

  it("enables the CUA SDK without registering core node_repl tools", () => {
    expect(
      resolvePluginRuntimeFeatures(outcome([plugin("computer-use@zcode-plugins-official", true)])),
    ).toEqual({ computerUse: true });
  });

  // 回归：browser-use 关闭后 node_repl 仍然被注册，宿主照样拉起 stdio 子进程，
  // mcp__node_repl__js 等 3 个高权限工具照样进模型工具池（线上日志实证：
  // runtimeFeatureBrowserUse=false 且用户 MCP 配置为 0 时，mcp.startup 仍 serverCount=1 / toolCount=3）。
  // 根因是这里只判断「browser-use 包存在」，漏掉了 plugin.enabled；
  // 而同一份 pluginOutcome 在 resolvePluginRuntimeFeatures 里是判断 enabled 的，两条路径语义分叉。
  it("does not register node_repl when the browser-use plugin is disabled", () => {
    expect(
      resolveBuiltInNodeReplMcpServers({
        pluginOutcome: outcome([
          plugin("node-repl-host@zcode-plugins-official", true, "/tmp/host"),
          plugin("browser-use@zcode-plugins-official", false),
        ]),
        workingDirectory: "/workspace",
      }),
    ).toEqual({});
  });

  it("keeps the shared host and CUA runtime roots separate", () => {
    const servers = resolveBuiltInNodeReplMcpServers({
      pluginOutcome: outcome([
        plugin("node-repl-host@zcode-plugins-official", true, "/tmp/host"),
        plugin("browser-use@zcode-plugins-official", false, "/tmp/browser-plugin"),
        plugin("computer-use@zcode-plugins-official", true, "/tmp/cua-plugin"),
      ]),
      workingDirectory: "/workspace",
    });

    // browser-use 已停用：只注入 CUA 的 root，两个领域各自独立。
    expect(servers.node_repl).toMatchObject({
      env: { ZCODE_CUA_PLUGIN_ROOT: "/tmp/cua-plugin" },
      type: "stdio",
    });
    expect(
      servers.node_repl?.type === "stdio" ? servers.node_repl.env?.ZCODE_PLUGIN_ROOT : undefined,
    ).toBeUndefined();
  });

  it("does not register node_repl when the browser-use plugin is absent", () => {
    expect(
      resolveBuiltInNodeReplMcpServers({
        pluginOutcome: outcome([plugin("browser@third-party", true)]),
        workingDirectory: "/workspace",
      }),
    ).toEqual({});
  });

  it("keeps browser-use disabled for disabled or non-official plugins", () => {
    expect(
      resolvePluginRuntimeFeatures(outcome([plugin("browser-use@zcode-plugins-official", false)])),
    ).toEqual({});
    expect(resolvePluginRuntimeFeatures(outcome([plugin("browser@third-party", true)]))).toEqual(
      {},
    );
  });
});
