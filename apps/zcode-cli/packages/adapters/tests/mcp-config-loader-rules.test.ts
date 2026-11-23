import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Logger } from "@zcode/contracts";
import { createMcpConfigurationLoader } from "../src/mcp/config-loader.js";
import { inspectWorkspacePluginRoot } from "../src/plugins/workspace-plugin-declaration/index.js";

/** 存活的另一个进程：父进程一定存在，用它模拟仍在写入的 writer。 */
const LIVE_OWNER_PID = process.ppid;
const SERVER_NAME = "plugin:example:demo";

let root: string;
let config: string;
let plugins: string;
let plugin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcp-loader-rules-"));
  config = join(root, "config.json");
  plugins = join(root, "plugins");
  plugin = join(root, "plugin");
  await mkdir(plugins);
});
afterEach(() => rm(root, { recursive: true, force: true }));

function createLoader(logger?: Logger) {
  return createMcpConfigurationLoader({
    configPaths: [config],
    userConfigPath: config,
    pluginStorageRoot: plugins,
    pluginRoots: [],
    workingDirectory: root,
    ...(logger ? { logger } : {}),
  });
}

async function writeManifest(directory: string, value: string): Promise<void> {
  await mkdir(join(plugin, directory), { recursive: true });
  await writeFile(join(plugin, directory, "plugin.json"), value);
}

it("skips a plugin whose first existing manifest is invalid", async () => {
  // 修复前无效的首个 manifest 会回退到下一个目录，与启动时的插件发现结论不同。
  await writeManifest(".zcode-plugin", "{ invalid");
  await writeManifest(
    ".claude-plugin",
    JSON.stringify({ name: "example", mcpServers: { demo: { command: "node" } } }),
  );
  await writeFile(config, JSON.stringify({ plugins: { dirs: [plugin] } }));
  const { configuration } = await createLoader().load();
  expect(configuration.servers).toEqual({});
});

it("keeps the fallback of the last accepted load, not of an unaccepted one", async () => {
  const loader = createLoader();
  await writeFile(config, JSON.stringify({ mcp: { servers: { accepted: { command: "a" } } } }));
  (await loader.load()).commit();
  await writeFile(config, JSON.stringify({ mcp: { servers: { superseded: { command: "b" } } } }));
  // 未被采纳的读取（例如 drain 期间又有文件变化）不能改变回退基础。
  await loader.load();
  await writeFile(config, "{ invalid");
  const { configuration } = await loader.load();
  expect(Object.keys(configuration.servers)).toEqual(["accepted"]);
});

it("logs plugin MCP diagnostics only when they change between accepted loads", async () => {
  const warn = vi.fn();
  const loader = createLoader({ warn, debug: vi.fn() } as unknown as Logger);
  // 缺少的 user_config 值会生成 plugin_variable_missing 诊断。
  const manifest = (key: string) =>
    JSON.stringify({
      name: "example",
      mcpServers: { demo: { command: "node", args: [`\${user_config.${key}}`] } },
    });
  const diagnosticWarnings = () =>
    warn.mock.calls.filter(([message]) => message === "Plugin MCP configuration diagnostic");
  await writeManifest(".zcode-plugin", manifest("token_a"));
  await writeFile(config, JSON.stringify({ plugins: { dirs: [plugin] } }));
  (await loader.load()).commit();
  const first = diagnosticWarnings().length;
  expect(first).toBeGreaterThan(0);
  // 修复前每次重读都把同一条诊断再记一遍，用户频繁保存配置时日志持续增长。
  await writeFile(config, JSON.stringify({ plugins: { dirs: [plugin] }, mcp: { servers: {} } }));
  (await loader.load()).commit();
  expect(diagnosticWarnings()).toHaveLength(first);
  await writeManifest(".zcode-plugin", manifest("token_b"));
  (await loader.load()).commit();
  expect(diagnosticWarnings().length).toBeGreaterThan(first);
});

it("logs each load warning once until it changes, keeping unchanged ones quiet", async () => {
  const warn = vi.fn();
  const loader = createLoader({ warn, debug: vi.fn() } as unknown as Logger);
  const count = (message: string) =>
    warn.mock.calls.filter(([logged]) => logged === message).length;
  await writeManifest(".zcode-plugin", "{ invalid");
  await writeFile(config, JSON.stringify({ plugins: { dirs: [plugin] } }));
  (await loader.load()).commit();
  expect(count("Plugin manifest invalid")).toBe(1);
  // Skill 实时目录读同一批插件，记同样的文案；context 标出读取方。
  expect(warn).toHaveBeenCalledWith(
    "Plugin manifest invalid",
    expect.objectContaining({ reader: "MCP configuration" }),
  );
  // 修复前 manifest 无效、配置读取失败等 warn 每次重读都再记一遍。
  await writeFile(config, JSON.stringify({ plugins: { dirs: [plugin] }, mcp: { servers: {} } }));
  (await loader.load()).commit();
  expect(count("Plugin manifest invalid")).toBe(1);
  // 新出现的 warn 照常记录；没变的那条不因此重记。配置读取失败时沿用上次有效内容，插件仍在。
  await writeFile(config, "{ invalid");
  (await loader.load()).commit();
  expect(count("MCP configuration read failed")).toBe(1);
  expect(count("Plugin manifest invalid")).toBe(1);
});

it("does not prepare plugin data directories while MCP is disabled", async () => {
  await writeManifest(
    ".zcode-plugin",
    JSON.stringify({ name: "example", mcpServers: { demo: { command: "node" } } }),
  );
  await writeFile(
    config,
    JSON.stringify({ features: { mcp: false }, plugins: { dirs: [plugin] } }),
  );
  await createLoader().load();
  await expect(stat(join(plugins, "data"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("skips the workspace directory when it cannot be inspected", async () => {
  const warn = vi.fn();
  const filesystem = {
    type: "stdio",
    command: "npx",
    args: ["@modelcontextprotocol/server-filesystem", "/Users/dev"],
  };
  await writeFile(config, JSON.stringify({ mcp: { servers: { filesystem } } }));
  const loader = createMcpConfigurationLoader({
    configPaths: [config],
    userConfigPath: config,
    pluginStorageRoot: plugins,
    pluginRoots: [],
    // 名称超长使 stat 报 ENAMETOOLONG；修复前非 ENOENT 错误会让整次加载失败。
    workingDirectory: join(root, "x".repeat(300)),
    logger: { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger,
  });
  const loaded = await loader.load();
  expect(loaded.configuration.servers.filesystem).toMatchObject({ args: filesystem.args });
  // 加载 warn 在结果被采纳时记录。
  loaded.commit();
  expect(warn).toHaveBeenCalledWith(
    "MCP filesystem workspace unavailable",
    expect.objectContaining({ error: expect.stringContaining("ENAMETOOLONG") }),
  );
});

it("reads installed plugins from the backup while a writer replaces the inventory", async () => {
  await writeManifest(
    ".zcode-plugin",
    JSON.stringify({ name: "example", mcpServers: { demo: { command: "node" } } }),
  );
  await writeFile(
    config,
    JSON.stringify({ plugins: { enabledPlugins: { "example@test": true } } }),
  );
  // Windows 不能覆盖已有文件：writer 先把清单移到 backup，再放入新文件。窗口内正式文件不存在。
  await writeFile(
    join(plugins, ".installed_plugins.json.backup"),
    JSON.stringify({
      version: 1,
      plugins: [
        {
          id: "example@test",
          name: "example",
          marketplace: "test",
          version: "1.0.0",
          installPath: plugin,
          installedAt: "2026-01-01T00:00:00Z",
          scope: "user",
        },
      ],
    }),
  );
  await writeFile(
    join(plugins, ".installed_plugins.json.transaction.json"),
    JSON.stringify({
      version: 2,
      stageName: ".installed_plugins.json.stage-next",
      transactionId: "inventory",
      ownerId: "other-process",
      ownerPid: LIVE_OWNER_PID,
      hadTarget: true,
      mode: "standalone",
    }),
  );
  const { configuration } = await createLoader().load();
  expect(configuration.servers[SERVER_NAME]).toMatchObject({ command: "node" });
});

it("ignores plugin directories declared by project configuration", async () => {
  // 修复前项目配置的 plugins.dirs 原样进入加载器：未信任仓库可借 inline 插件注册并启动 MCP。
  await writeManifest(
    ".zcode-plugin",
    JSON.stringify({ name: "example", mcpServers: { demo: { command: "node" } } }),
  );
  const project = join(root, "project.json");
  await writeFile(project, JSON.stringify({ plugins: { dirs: [plugin] } }));
  const loader = createMcpConfigurationLoader({
    configPaths: [project, config],
    userConfigPath: config,
    pluginStorageRoot: plugins,
    pluginRoots: [],
    workingDirectory: root,
  });
  expect((await loader.load()).configuration.servers).toEqual({});
  // 用户配置仍可声明插件目录。
  await writeFile(config, JSON.stringify({ plugins: { dirs: [plugin] } }));
  expect(Object.keys((await loader.load()).configuration.servers)).toEqual([SERVER_NAME]);
});

it("uses private plugin options for live MCP reloads and never repository options", async () => {
  const id = "example@inline";
  const project = join(root, "workspace", ".zcode", "config.json");
  const workspace = join(root, "workspace");
  const secrets = join(root, "plugin-secrets.json");
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  await writeManifest(
    ".zcode-plugin",
    JSON.stringify({
      name: "example",
      userConfig: { pythonPath: { type: "file" }, token: { type: "string", sensitive: true } },
      mcpServers: {
        demo: {
          command: "node",
          env: { PYTHON: "${user_config.pythonPath}", TOKEN: "${user_config.token}" },
        },
      },
    }),
  );
  await writeFile(
    config,
    JSON.stringify({
      plugins: {
        dirs: [plugin],
        options: { [id]: { pythonPath: "user-python", token: "user-token" } },
      },
    }),
  );
  await writeFile(
    project,
    JSON.stringify({
      plugins: {
        options: { [id]: { pythonPath: "./repository-python", token: "repository-token" } },
      },
    }),
  );
  const loader = createMcpConfigurationLoader({
    configPaths: [project, config],
    userConfigPath: config,
    pluginStorageRoot: plugins,
    pluginRoots: [],
    workingDirectory: workspace,
  });
  const initial = await loader.load();
  expect(initial.configuration.servers[SERVER_NAME]).toMatchObject({
    env: { PYTHON: "user-python", TOKEN: "user-token" },
  });
  expect(initial.files.has(secrets)).toBe(true);
  initial.commit();
  await writeFile(
    secrets,
    JSON.stringify({
      version: 1,
      user: { [id]: { token: "private-user-token" } },
      workspaces: { [workspace]: { [id]: { pythonPath: "private-workspace-python" } } },
    }),
  );
  const saved = await loader.load();
  expect(saved.configuration.servers[SERVER_NAME]).toMatchObject({
    env: { PYTHON: "private-workspace-python", TOKEN: "private-user-token" },
  });
  saved.commit();
  // 私有文件损坏不能复用旧执行参数，更不能回退到仓库值。
  await writeFile(secrets, "{ invalid");
  const corrupt = await loader.load();
  expect(corrupt.configuration.servers[SERVER_NAME]).toMatchObject({
    env: { PYTHON: "user-python", TOKEN: "user-token" },
  });
  corrupt.commit();
  await rm(secrets);
  expect((await loader.load()).configuration.servers[SERVER_NAME]).toMatchObject({
    env: { PYTHON: "user-python", TOKEN: "user-token" },
  });
});

it("tags each server with the source of the file that declared it, including fallbacks", async () => {
  // 修复前加载器不标来源，工作区 guard 找不到项目声明时把回退文件里的 server 当作非工作区配置放行。
  const project = join(root, "zcode.json");
  const workspaceConfig = join(root, "workspace-config.json");
  const workspaceFallback = join(root, "workspace-agents.json");
  const userFallback = join(root, "user-agents.json");
  await writeFile(project, JSON.stringify({ mcp: { servers: { declared: { command: "a" } } } }));
  await writeFile(
    workspaceFallback,
    JSON.stringify({ mcpServers: { fallback: { command: "b" } } }),
  );
  await writeFile(config, JSON.stringify({}));
  await writeFile(userFallback, JSON.stringify({ mcpServers: { personal: { command: "c" } } }));
  const loader = createMcpConfigurationLoader({
    configPaths: [project, workspaceConfig, config],
    userConfigPath: config,
    fallbackPaths: { [workspaceConfig]: workspaceFallback, [config]: userFallback },
    pluginStorageRoot: plugins,
    pluginRoots: [],
    workingDirectory: root,
  });
  const { servers } = (await loader.load()).configuration;
  expect(servers.declared?.source).toEqual({ kind: "workspace" });
  expect(servers.fallback?.source).toEqual({ kind: "workspace" });
  expect(servers.personal?.source).toEqual({ kind: "user" });
});

it("watches commit points instead of installed plugin directories, but keeps inline plugin files", async () => {
  // 修复前加载器把每个已安装插件的 manifest、MCP 声明和事务记录都放进监听集合：26 个插件约 84 个
  // 目录 watcher，新会话要串行等它们就绪。缓存插件目录只由安装流程写入，并以写安装记录结束，
  // 监听安装记录即可。inline 插件没有提交点，仍监听它的文件。
  const cached = join(plugins, "cache", "test", "example", "1.0.0");
  const inline = join(root, "inline");
  const declare = async (path: string, name: string) => {
    await mkdir(join(path, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(path, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name, mcpServers: "./.mcp.json" }),
    );
    await writeFile(
      join(path, ".mcp.json"),
      JSON.stringify({ mcpServers: { demo: { command: "node" } } }),
    );
  };
  await declare(cached, "example");
  await declare(inline, "local");
  const inventory = join(plugins, "installed_plugins.json");
  await writeFile(
    inventory,
    JSON.stringify({
      version: 1,
      plugins: [
        {
          id: "example@test",
          name: "example",
          marketplace: "test",
          version: "1.0.0",
          installPath: cached,
          installedAt: "2026-01-01T00:00:00Z",
          scope: "user",
        },
      ],
    }),
  );
  await writeFile(
    config,
    JSON.stringify({ plugins: { dirs: [inline], enabledPlugins: { "example@test": true } } }),
  );
  const loaded = await createLoader().load();
  // 两个插件都照常加载，只是缓存插件的文件不进入监听集合。
  expect(Object.keys(loaded.configuration.servers).sort()).toEqual([
    "plugin:example:demo",
    "plugin:local:demo",
  ]);
  const files = [...loaded.files];
  expect(files).toContain(config);
  expect(files).toContain(inventory);
  expect(files.filter((file) => file.startsWith(join(plugins, "cache")))).toEqual([]);
  expect(files).toContain(join(inline, ".zcode-plugin", "plugin.json"));
  expect(files).toContain(join(inline, ".mcp.json"));
  expect(files).toContain(join(root, ".inline.transaction.json"));
});

it("reads project files with the startup project whitelist", async () => {
  // 规则见根目录 docs/security/deep-link-project-trust-boundary.md：项目文件只认扩展声明与启停。
  const project = join(root, "workspace", ".zcode", "config.json");
  const official = join(root, "official");
  await writeManifest(
    ".zcode-plugin",
    JSON.stringify({ name: "example", mcpServers: { demo: { command: "node" } } }),
  );
  await mkdir(join(official, ".zcode-plugin"), { recursive: true });
  await writeFile(
    join(official, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: "offi", mcpServers: { pong: { command: "node" } } }),
  );
  await writeFile(
    config,
    JSON.stringify({
      plugins: { dirs: [plugin] },
      mcp: { servers: { mine: { command: "node" } } },
    }),
  );
  await mkdir(join(root, "workspace", ".zcode"), { recursive: true });
  const loader = createMcpConfigurationLoader({
    configPaths: [project, config],
    userConfigPath: config,
    pluginStorageRoot: plugins,
    pluginRoots: [
      { rootPath: official, marketplace: "zcode-plugins-official", source: "official" },
    ],
    defaultEnabledPlugins: new Set(["offi@zcode-plugins-official"]),
    workingDirectory: root,
  });
  const servers = ["mine", "plugin:example:demo", "plugin:offi:pong", "proj"];

  // 运行参数不生效：项目不能关掉 MCP、关掉全部插件或隐藏官方插件。
  await writeFile(
    project,
    JSON.stringify({
      features: { mcp: false },
      plugins: { enabled: false, suppressedBuiltins: ["offi@zcode-plugins-official"] },
      mcp: { servers: { proj: { command: "node" } } },
    }),
  );
  const restricted = (await loader.load()).configuration;
  expect(restricted.enabled).toBe(true);
  expect(Object.keys(restricted.servers).sort()).toEqual(servers);

  // 运行参数的非法值在校验前排除，同一文件的 server 照常加载。
  await writeFile(
    project,
    JSON.stringify({ storage: 5, mcp: { servers: { proj: { command: "node" } } } }),
  );
  expect(Object.keys((await loader.load()).configuration.servers).sort()).toEqual(servers);
});

it("keeps user fields that a project file does not declare", async () => {
  const project = join(root, "workspace", ".zcode", "config.json");
  await mkdir(join(root, "workspace", ".zcode"), { recursive: true });
  await writeFile(config, JSON.stringify({ features: { mcp: false } }));
  await writeFile(project, JSON.stringify({ plugins: { enabledPlugins: { "x@test": true } } }));
  const { configuration } = await createMcpConfigurationLoader({
    configPaths: [project, config],
    userConfigPath: config,
    pluginStorageRoot: plugins,
    pluginRoots: [],
    workingDirectory: root,
  }).load();
  // 与 createConfig 相同：项目层没声明 features，不能冲掉用户层的关闭。
  expect(configuration.enabled).toBe(false);
});

it("keeps a trusted workspace plugin only while its declarations match the trusted digest", async () => {
  // docs/plugins/workspace-plugin-dir-trust.md：项目目录插件只沿用会话启动时已准入的那批；
  // 会话中途声明变了（例如 git pull）就撤下它的 MCP，不能沿用旧信任执行新声明。
  const manifest = (command: string) =>
    JSON.stringify({ name: "example", mcpServers: { demo: { command } } });
  await writeManifest(".zcode-plugin", manifest("node"));
  await writeFile(config, JSON.stringify({}));
  const inspected = await inspectWorkspacePluginRoot({ workspaceRoot: root, rootPath: plugin });
  const loader = createMcpConfigurationLoader({
    configPaths: [config],
    userConfigPath: config,
    pluginStorageRoot: plugins,
    pluginRoots: [
      {
        rootPath: plugin,
        marketplace: "inline",
        source: "inline",
        workspaceTrust: {
          state: "trusted",
          pluginRoot: inspected!.pluginRoot,
          declarationDigest: inspected!.declarationDigest,
        },
      },
    ],
    workingDirectory: root,
  });
  expect(Object.keys((await loader.load()).configuration.servers)).toEqual([SERVER_NAME]);

  await writeManifest(".zcode-plugin", manifest("python"));
  expect((await loader.load()).configuration.servers).toEqual({});
});

it("never loads a pending workspace plugin root in an open session", async () => {
  await writeManifest(
    ".zcode-plugin",
    JSON.stringify({ name: "example", mcpServers: { demo: { command: "node" } } }),
  );
  await writeFile(config, JSON.stringify({}));
  const loader = createMcpConfigurationLoader({
    configPaths: [config],
    userConfigPath: config,
    pluginStorageRoot: plugins,
    pluginRoots: [
      {
        rootPath: plugin,
        marketplace: "inline",
        source: "inline",
        workspaceTrust: { state: "pending", pluginRoot: "plugin", declarationDigest: "0".repeat(64) },
      },
    ],
    workingDirectory: root,
  });
  expect((await loader.load()).configuration.servers).toEqual({});
});
