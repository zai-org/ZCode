import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ConfigResult } from "@zcode/adapters/config";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { Logger, PluginLoadOutcome } from "@zcode/contracts";
import { createConfig } from "@zcode/adapters/config";
import { createMcpConfigSourceRegistry } from "@zcode/adapters/mcp";
import { createAppMcpConfigurationSource } from "../src/app/dynamic-mcp-config.js";
import { resolveStartupPlugins } from "../src/app/startup-marks.js";
import { resolveEffectiveMcpConfiguration } from "../src/mcp-config.js";
import { resolveAppRuntimeConfig } from "../src/app/runtime-config.js";

it("workspace snapshots reload disk configuration while explicit maps and children stay scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-app-source-"));
  const workspace = join(root, "workspace");
  const user = join(root, "user.json");
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  await writeFile(
    join(workspace, ".zcode", "config.json"),
    JSON.stringify({ mcp: { servers: { shared: { command: "project" } } } }),
  );
  await writeFile(
    user,
    JSON.stringify({ features: { mcp: false }, mcp: { servers: { shared: { command: "user" } } } }),
  );
  const base = {
    options: { pluginStorageRoot: join(root, "plugins") },
    configResult: { sources: { user: { path: user } } } as ConfigResult,
    runtimeFeatures: {} as AgentRuntimeConfig["runtimeFeatures"],
    pluginOutcome: { plugins: [] } as unknown as PluginLoadOutcome,
    builtInMcpServers: { host: { type: "stdio" as const, command: "host" } },
    cliStorageRoot: root,
    workingDirectory: workspace,
    logger: { warn: vi.fn(), debug: vi.fn() } as unknown as Logger,
  };
  const workspaceSource = await createAppMcpConfigurationSource({
    ...base,
    options: base.options,
  });
  const explicitSource = await createAppMcpConfigurationSource({
    ...base,
    options: {
      ...base.options,
      runtimeConfig: {
        mcp: { enabled: true, servers: { pinned: { type: "stdio", command: "pinned" } } },
      },
    },
  });
  try {
    expect(workspaceSource!.getSnapshot().enabled).toBe(false);
    expect(explicitSource!.getSnapshot().enabled).toBe(true);
    expect(workspaceSource!.getSnapshot().servers.shared).toMatchObject({ command: "user" });
    expect(Object.keys(explicitSource!.getSnapshot().servers).sort()).toEqual(["host", "pinned"]);
    const applied = Promise.withResolvers<void>();
    workspaceSource!.subscribe(() => {
      if (workspaceSource!.getSnapshot().servers.next) applied.resolve();
    });
    await writeFile(user, JSON.stringify({ mcp: { servers: { next: { command: "new" } } } }));
    await applied.promise;
    expect(workspaceSource!.getSnapshot().servers.shared).toMatchObject({
      command: "project",
      cwd: workspace,
    });
    expect(workspaceSource!.getSnapshot().servers.host).toEqual(base.builtInMcpServers.host);
    expect(Object.keys(explicitSource!.getSnapshot().servers).sort()).toEqual(["host", "pinned"]);
    expect(JSON.parse(await readFile(user, "utf8")).mcp.servers.host).toBeUndefined();
    const forkSource = await createAppMcpConfigurationSource({
      ...base,
      options: {
        ...base.options,
        runtimeConfig: { parentSessionId: "parent" } as AgentRuntimeConfig,
      },
    });
    try {
      expect(forkSource?.getSnapshot().servers.next).toMatchObject({ command: "new" });
    } finally {
      forkSource?.close();
    }
  } finally {
    workspaceSource?.close();
    explicitSource?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("produces the same first snapshot as the startup configuration path", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-app-parity-"));
  const workspace = join(root, "workspace");
  const user = join(root, "user.json");
  const pluginStorageRoot = join(root, "plugins");
  const inline = join(root, "inline-plugin");
  const installed = join(root, "installed-plugin");
  try {
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await mkdir(pluginStorageRoot, { recursive: true });
    for (const [pluginRoot, name] of [
      [inline, "inline-example"],
      [installed, "installed-example"],
    ] as const) {
      await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({ name, mcpServers: { demo: { command: "node", args: ["server.js"] } } }),
      );
    }
    await writeFile(
      join(pluginStorageRoot, "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "installed-example@market",
            name: "installed-example",
            marketplace: "market",
            version: "1.0.0",
            installPath: installed,
            installedAt: "2026-01-01T00:00:00Z",
            scope: "user",
          },
        ],
      }),
    );
    await writeFile(
      join(workspace, ".zcode", "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            shared: { command: "project" },
            local: { command: "node", args: ["server.js"], cwd: "tools" },
          },
        },
      }),
    );
    await writeFile(
      user,
      JSON.stringify({
        mcp: {
          servers: {
            shared: { command: "user" },
            remote: { type: "http", url: "https://example.com/mcp", enabled: false },
          },
        },
        plugins: {
          dirs: [inline],
          enabledPlugins: { "installed-example@market": true },
        },
      }),
    );
    const configResult = createConfig({
      env: {},
      userConfigPath: user,
      workingDirectory: workspace,
    });
    const pluginOutcome = await resolveStartupPlugins({
      cliStorageRoot: root,
      configResult,
      env: {},
      options: { pluginStorageRoot },
      startupTimer: { mark() {} } as unknown as Parameters<
        typeof resolveStartupPlugins
      >[0]["startupTimer"],
      workingDirectory: workspace,
    });
    const builtInMcpServers = { host: { type: "stdio" as const, command: "host" } };
    // 设置页与启动插件发现走 createConfig + 插件加载器；会话走动态加载器。两套解析结果必须相同，
    // 来源标记也相同：启动路径由 runtime 配置按 createConfig 的来源补标。
    const startup = resolveAppRuntimeConfig({
      cliStorageRoot: root,
      configResult,
      options: {},
      mcpConfiguration: resolveEffectiveMcpConfiguration({
        enabled: configResult.config.features.mcp,
        servers: configResult.config.mcp.servers,
        pluginServers: pluginOutcome.mcpServers,
        builtInServers: builtInMcpServers,
      }).mcp,
      subagentOutputRootDir: join(root, "output"),
      workingDirectory: workspace,
    }).runtimeConfig.mcp!;
    const source = await createAppMcpConfigurationSource({
      options: { pluginStorageRoot },
      configResult,
      runtimeFeatures: {} as AgentRuntimeConfig["runtimeFeatures"],
      pluginOutcome,
      builtInMcpServers,
      cliStorageRoot: root,
      workingDirectory: workspace,
      logger: { warn: vi.fn(), debug: vi.fn() } as unknown as Logger,
    });
    try {
      // 官方内置插件同样经过两条路径，只断言夹具中的来源都已出现。
      expect(Object.keys(startup.servers)).toEqual(
        expect.arrayContaining([
          "host",
          "local",
          "plugin:inline-example:demo",
          "plugin:installed-example:demo",
          "remote",
          "shared",
        ]),
      );
      expect(source!.getSnapshot()).toEqual(startup);
    } finally {
      source?.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("sessions in one process share the injected configuration source registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-app-shared-"));
  const workspace = join(root, "workspace");
  const user = join(root, "user.json");
  await mkdir(workspace, { recursive: true });
  await writeFile(user, JSON.stringify({ mcp: { servers: { first: { command: "node" } } } }));
  const registry = createMcpConfigSourceRegistry();
  const acquire = vi.spyOn(registry, "acquire");
  const create = (host: string) =>
    createAppMcpConfigurationSource({
      options: { pluginStorageRoot: join(root, "plugins"), mcpConfigSourceRegistry: registry },
      configResult: { sources: { user: { path: user } } } as ConfigResult,
      runtimeFeatures: {} as AgentRuntimeConfig["runtimeFeatures"],
      pluginOutcome: { plugins: [] } as unknown as PluginLoadOutcome,
      builtInMcpServers: { [host]: { type: "stdio" as const, command: host } },
      cliStorageRoot: root,
      workingDirectory: workspace,
      logger: { warn: vi.fn(), debug: vi.fn() } as unknown as Logger,
    });
  const first = await create("alpha");
  const second = await create("beta");
  try {
    expect(acquire).toHaveBeenCalledTimes(2);
    // 内建 server 由每个会话自己的 prepare 补上，共享条目不会互相串。
    expect(Object.keys(first.getSnapshot().servers).sort()).toEqual(["alpha", "first"]);
    expect(Object.keys(second.getSnapshot().servers).sort()).toEqual(["beta", "first"]);
    const applied = Promise.withResolvers<void>();
    second.subscribe(() => {
      if (second.getSnapshot().servers.next) applied.resolve();
    });
    // 关闭会话 A（重复关闭）后，会话 B 仍能热更新。
    first.close();
    first.close();
    await writeFile(user, JSON.stringify({ mcp: { servers: { next: { command: "node" } } } }));
    await applied.promise;
    expect(Object.keys(second.getSnapshot().servers).sort()).toEqual(["beta", "next"]);
  } finally {
    first.close();
    second.close();
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
