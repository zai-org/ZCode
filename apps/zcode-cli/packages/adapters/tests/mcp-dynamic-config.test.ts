import { mkdtemp, mkdir, writeFile, rm, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { activateDirectoryAtomically } from "../src/plugins/atomic-directory.js";
import { createMcpConfigurationLoader } from "../src/mcp/config-loader.js";
import { createDynamicMcpConfigSource } from "../src/mcp/config-source.js";

/** 直接使用加载器的用例按配置源的方式采纳每次结果。 */
async function accept(loader: ReturnType<typeof createMcpConfigurationLoader>) {
  const loaded = await loader.load();
  loaded.commit();
  return loaded;
}

it.each(["config", "legacy"])(
  "keeps valid settings with MCP warnings on initial load and refresh (%s)",
  async (format) => {
    const root = await mkdtemp(join(tmpdir(), "mcp-config-warning-"));
    const config = join(root, "config.json");
    const legacy = join(root, ".mcp.json");
    const plugin = join(root, "plugin");
    try {
      await mkdir(join(plugin, ".zcode-plugin"), { recursive: true });
      await writeFile(
        join(plugin, ".zcode-plugin", "plugin.json"),
        JSON.stringify({ name: "example", mcpServers: { demo: { command: "node" } } }),
      );
      const loader = createMcpConfigurationLoader({
        configPaths: [config],
        userConfigPath: config,
        fallbackPaths: format === "legacy" ? { [config]: legacy } : undefined,
        pluginStorageRoot: join(root, "plugins"),
        pluginRoots: [],
        workingDirectory: root,
      });
      for (const enabled of [false, true]) {
        const name = enabled ? "updated" : "initial";
        const servers = { [name]: { command: "node" }, broken: { command: 123 } };
        await writeFile(
          config,
          JSON.stringify({
            features: { mcp: enabled },
            plugins: { enabled, dirs: [plugin] },
            ...(format === "config" ? { mcp: { servers } } : {}),
          }),
        );
        if (format === "legacy") await writeFile(legacy, JSON.stringify({ mcpServers: servers }));
        const { configuration } = await accept(loader);
        expect(configuration.enabled).toBe(enabled);
        expect(Object.keys(configuration.servers).sort()).toEqual(
          enabled ? ["plugin:example:demo", name].sort() : [name],
        );
        expect(configuration.servers[name]).toMatchObject({ type: "stdio", command: "node" });
      }

      const { configuration: valid } = await accept(loader);
      // warning 的结果也是有效快照；后续整体解析失败不能回退到更早配置。
      for (const invalid of ["{ invalid", JSON.stringify({ features: { mcp: "invalid" } })]) {
        await writeFile(config, invalid);
        await expect(accept(loader)).resolves.toMatchObject({ configuration: valid });
      }
      if (format === "legacy") {
        await writeFile(legacy, "{ invalid");
        await expect(accept(loader)).resolves.toMatchObject({ configuration: valid });
      }
      await rm(config);
      await rm(legacy, { force: true });
      await expect(accept(loader)).resolves.toMatchObject({
        configuration: { enabled: true, servers: {} },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("publishes external atomic config replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-config-"));
  const file = join(root, "config.json");
  await writeFile(file, JSON.stringify({ mcp: { servers: {} } }));
  const source = await createDynamicMcpConfigSource({
    configPaths: [file],
    userConfigPath: file,
    pluginStorageRoot: join(root, "plugins"),
    workingDirectory: root,
    pluginRoots: [],
  });
  try {
    const changed = Promise.withResolvers<void>();
    source.subscribe(() => {
      if (source.getSnapshot().servers.test) changed.resolve();
    });
    await writeFile(
      `${file}.tmp`,
      JSON.stringify({ mcp: { servers: { test: { type: "stdio", command: "node" } } } }),
    );
    await rename(`${file}.tmp`, file);
    await changed.promise;
    expect(source.getSnapshot().servers.test?.type).toBe("stdio");
  } finally {
    source.close();
    await rm(root, { recursive: true, force: true });
  }
}, 5000);

it("reloads an installed plugin on each install record commit and removes it on uninstall", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-plugin-"));
  const config = join(root, "config.json");
  const plugins = join(root, "plugins");
  const plugin = join(root, "plugin");
  await mkdir(plugins);
  await mkdir(join(plugin, ".zcode-plugin"), { recursive: true });
  await writeFile(
    join(plugin, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: "example", mcpServers: "./.mcp.json" }),
  );
  await writeFile(
    join(plugin, ".mcp.json"),
    JSON.stringify({ mcpServers: { demo: { command: "node", args: ["server.js"] } } }),
  );
  await writeFile(
    config,
    JSON.stringify({ plugins: { enabledPlugins: { "example@test": true } } }),
  );
  const source = await createDynamicMcpConfigSource({
    configPaths: [config],
    userConfigPath: config,
    pluginStorageRoot: plugins,
    pluginRoots: [],
    workingDirectory: root,
  });
  // 安装和更新流程在替换插件目录后写安装记录（updatedAt 每次不同）；配置源只监听这个提交点。
  const commit = (updatedAt: string) =>
    writeFile(
      join(plugins, "installed_plugins.json"),
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
            updatedAt,
            scope: "user",
          },
        ],
      }),
    );
  try {
    const loaded = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    let installed = false;
    source.subscribe(() => {
      if (source.getSnapshot().servers["plugin:example:demo"]) {
        installed = true;
        loaded.resolve();
      } else if (installed) removed.resolve();
    });
    await commit("2026-01-01T00:00:00Z");
    await loaded.promise;
    expect(source.getSnapshot().servers["plugin:example:demo"]).toMatchObject({ command: "node" });
    const declared = Promise.withResolvers<void>();
    const refreshed = Promise.withResolvers<void>();
    source.subscribe(() => {
      const server = source.getSnapshot().servers["plugin:example:demo"];
      if (server?.type === "stdio" && server.args?.[0] === "declared.js") declared.resolve();
      if (server?.type === "stdio" && server.args?.[0] === "updated.js") refreshed.resolve();
    });
    const extra = join(plugin, "extra.json");
    await writeFile(
      extra,
      JSON.stringify({ mcpServers: { demo: { command: "node", args: ["declared.js"] } } }),
    );
    await writeFile(
      join(plugin, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "example", mcpServers: "./extra.json" }),
    );
    await commit("2026-01-02T00:00:00Z");
    await declared.promise;
    await writeFile(
      extra,
      JSON.stringify({ mcpServers: { demo: { command: "node", args: ["updated.js"] } } }),
    );
    await commit("2026-01-03T00:00:00Z");
    await refreshed.promise;

    await writeFile(
      join(plugins, "installed_plugins.json"),
      JSON.stringify({ version: 1, plugins: [] }),
    );
    await removed.promise;
    expect(source.getSnapshot().servers).toEqual({});
  } finally {
    source.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps an explicit server map and retains a malformed install inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-explicit-"));
  const config = join(root, "config.json");
  const manifest = join(root, "plugin", ".zcode-plugin", "plugin.json");
  const inventory = join(root, "installed_plugins.json");
  await mkdir(join(root, "plugin", ".zcode-plugin"), { recursive: true });
  await writeFile(
    manifest,
    JSON.stringify({ name: "example", mcpServers: { demo: { command: "node" } } }),
  );
  await writeFile(
    inventory,
    JSON.stringify({ plugins: { "example@test": [{ installPath: join(root, "plugin") }] } }),
  );
  await writeFile(
    config,
    JSON.stringify({ plugins: { enabledPlugins: { "example@test": true } } }),
  );
  const explicit = { pinned: { type: "stdio" as const, command: "node", args: ["pinned.js"] } };
  const source = await createDynamicMcpConfigSource({
    configPaths: [config],
    userConfigPath: config,
    pluginStorageRoot: root,
    pluginRoots: [],
    workingDirectory: root,
    explicitServers: explicit,
  });
  try {
    expect(Object.keys(source.getSnapshot().servers).sort()).toEqual([
      "pinned",
      "plugin:example:demo",
    ]);
    const changed = Promise.withResolvers<void>();
    source.subscribe(() => {
      if (!source.getSnapshot().enabled) changed.resolve();
    });
    await writeFile(inventory, JSON.stringify({ plugins: "broken" }));
    await writeFile(
      config,
      JSON.stringify({
        features: { mcp: false },
        plugins: { enabledPlugins: { "example@test": true } },
        mcp: { servers: { unexpected: { command: "node" } } },
      }),
    );
    await changed.promise;
    expect(Object.keys(source.getSnapshot().servers).sort()).toEqual([
      "pinned",
      "plugin:example:demo",
    ]);
    expect(source.getSnapshot().servers.pinned).toEqual(explicit.pinned);
  } finally {
    source.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("retains an invalid source while applying a different valid source and detects directory recreation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-config-sources-"));
  const directory = join(root, "workspace");
  await mkdir(directory);
  const user = join(root, "config.json");
  const project = join(directory, "config.json");
  await writeFile(
    user,
    JSON.stringify({ mcp: { servers: { user: { type: "stdio", command: "node" } } } }),
  );
  const source = await createDynamicMcpConfigSource({
    configPaths: [user, project],
    userConfigPath: user,
    pluginStorageRoot: root,
    pluginRoots: [],
    workingDirectory: root,
  });
  try {
    const first = Promise.withResolvers<void>();
    const next = Promise.withResolvers<void>();
    source.subscribe(() => {
      if (source.getSnapshot().servers.one) first.resolve();
      if (source.getSnapshot().servers.two) next.resolve();
    });
    await writeFile(user, "{ invalid");
    await writeFile(
      project,
      JSON.stringify({ mcp: { servers: { one: { type: "stdio", command: "node" } } } }),
    );
    await first.promise;
    expect(source.getSnapshot().servers.user).toBeDefined();
    const replacement = join(root, "replacement");
    await mkdir(replacement);
    await writeFile(
      join(replacement, "config.json"),
      JSON.stringify({ mcp: { servers: { two: { type: "stdio", command: "node" } } } }),
    );
    await rename(directory, join(root, "old"));
    await rename(replacement, directory);
    await next.promise;
    expect(Object.keys(source.getSnapshot().servers).sort()).toEqual(["two", "user"]);
  } finally {
    source.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("does not reuse a plugin result after its installation path is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-plugin-replacement-"));
  const config = join(root, "config.json");
  const inventory = join(root, "installed_plugins.json");
  const pluginId = "example@test";
  const record = (version: string) => ({
    id: pluginId,
    name: "example",
    marketplace: "test",
    version,
    installPath: join(root, version),
    installedAt: "2026-01-01T00:00:00Z",
    scope: "user",
  });
  await writeFile(config, JSON.stringify({ plugins: { enabledPlugins: { [pluginId]: true } } }));
  for (const version of ["v1", "v2"]) {
    await mkdir(join(root, version, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(root, version, ".zcode-plugin", "plugin.json"),
      JSON.stringify({
        name: "example",
        mcpServers: {
          demo: version === "v1" ? { command: "node", args: ["old.js"] } : { command: 123 },
        },
      }),
    );
  }
  await writeFile(inventory, JSON.stringify({ version: 1, plugins: [record("v1")] }));
  const source = await createDynamicMcpConfigSource({
    configPaths: [config],
    userConfigPath: config,
    pluginStorageRoot: root,
    pluginRoots: [],
    workingDirectory: root,
  });
  try {
    expect(source.getSnapshot().servers["plugin:example:demo"]).toMatchObject({ args: ["old.js"] });
    await writeFile(inventory, JSON.stringify({ version: 1, plugins: [record("v2")] }));
    await vi.waitFor(() => expect(source.getSnapshot().servers).toEqual({}));
  } finally {
    source.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("isolates malformed plugin server and installation entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-entry-isolation-"));
  const plugin = join(root, "plugin");
  const config = join(root, "config.json");
  try {
    await mkdir(join(plugin, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(plugin, ".zcode-plugin", "plugin.json"),
      JSON.stringify({
        name: "example",
        mcpServers: { good: { command: "node" }, bad: { command: 42 } },
      }),
    );
    await writeFile(
      config,
      JSON.stringify({ plugins: { enabledPlugins: { "example@test": true } } }),
    );
    await writeFile(
      join(root, "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "example@test",
            name: "example",
            marketplace: "test",
            version: "1",
            installPath: plugin,
            installedAt: "2026-01-01",
            scope: "user",
          },
          { id: "broken" },
        ],
      }),
    );
    const loader = createMcpConfigurationLoader({
      configPaths: [config],
      userConfigPath: config,
      pluginStorageRoot: root,
      pluginRoots: [],
      workingDirectory: root,
    });
    expect(Object.keys((await accept(loader)).configuration.servers)).toEqual([
      "plugin:example:good",
    ]);
    // 有效的空声明必须收敛，不能继续回退到旧插件目录。
    await writeFile(
      join(plugin, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "example", mcpServers: {} }),
    );
    expect((await accept(loader)).configuration.servers).toEqual({});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not fail config loading when an optional filesystem workspace is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-missing-workspace-"));
  const config = join(root, "config.json");
  try {
    await writeFile(
      config,
      JSON.stringify({
        mcp: {
          servers: {
            filesystem: { command: "npx", args: ["@modelcontextprotocol/server-filesystem", root] },
            other: { command: "node" },
          },
        },
      }),
    );
    const loader = createMcpConfigurationLoader({
      configPaths: [config],
      userConfigPath: config,
      pluginStorageRoot: root,
      pluginRoots: [],
      workingDirectory: join(root, "missing"),
    });
    const { configuration } = await accept(loader);
    expect(Object.keys(configuration.servers)).toEqual(["filesystem", "other"]);
    expect(configuration.servers.filesystem).toMatchObject({
      args: ["@modelcontextprotocol/server-filesystem", root],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("publishes the final value of consecutive atomic replacements", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-consecutive-replace-"));
  const config = join(root, "config.json");
  await writeFile(config, "{}");
  const source = await createDynamicMcpConfigSource({
    configPaths: [config],
    userConfigPath: config,
    pluginStorageRoot: join(root, "plugins"),
    pluginRoots: [],
    workingDirectory: root,
  });
  try {
    for (const command of ["first", "second", "third"]) {
      const observed = Promise.withResolvers<void>();
      const unsubscribe = source.subscribe(() => {
        if (
          source.getSnapshot().servers.demo?.type === "stdio" &&
          source.getSnapshot().servers.demo.command === command
        )
          observed.resolve();
      });
      await writeFile(`${config}.tmp`, JSON.stringify({ mcp: { servers: { demo: { command } } } }));
      await rename(`${config}.tmp`, config);
      try {
        await observed.promise;
      } finally {
        unsubscribe();
      }
    }
  } finally {
    source.close();
    await rm(root, { recursive: true, force: true });
  }
}, 5000);

it("reads only the committed plugin generation during an atomic activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-atomic-plugin-"));
  const plugin = join(root, "plugin");
  const authority = join(root, "installed_plugins.json");
  const config = join(root, "config.json");
  let activation: Awaited<ReturnType<typeof activateDirectoryAtomically>> | undefined;
  try {
    const manifest = (command: string) =>
      JSON.stringify({ name: "example", mcpServers: { demo: { command } } });
    await mkdir(join(plugin, ".zcode-plugin"), { recursive: true });
    await writeFile(join(plugin, ".zcode-plugin", "plugin.json"), manifest("old"));
    const record = {
      id: "example@test",
      name: "example",
      marketplace: "test",
      version: "1",
      installPath: plugin,
      installedAt: "2026-01-01",
      scope: "user",
    };
    await writeFile(authority, JSON.stringify({ version: 1, plugins: [record] }));
    await writeFile(
      config,
      JSON.stringify({ plugins: { enabledPlugins: { "example@test": true } } }),
    );
    const loader = createMcpConfigurationLoader({
      configPaths: [config],
      userConfigPath: config,
      pluginStorageRoot: root,
      pluginRoots: [],
      workingDirectory: root,
    });
    const stable = (await accept(loader)).configuration;
    activation = await activateDirectoryAtomically({
      targetPath: plugin,
      authorityPath: authority,
      prepare: async (path) => {
        await mkdir(join(path, ".zcode-plugin"), { recursive: true });
        await writeFile(join(path, ".zcode-plugin", "plugin.json"), manifest("new"));
      },
    });
    expect((await accept(loader)).configuration).toEqual(stable);
    const cold = createMcpConfigurationLoader({
      configPaths: [config],
      userConfigPath: config,
      pluginStorageRoot: root,
      pluginRoots: [],
      workingDirectory: root,
    });
    expect((await cold.load()).configuration.servers).toEqual({});
    await writeFile(
      authority,
      JSON.stringify({
        version: 1,
        plugins: [{ ...record, cacheTransactionId: activation.transactionId }],
      }),
    );
    expect((await accept(loader)).configuration.servers["plugin:example:demo"]).toMatchObject({
      command: "new",
      env: expect.objectContaining({ ZCODE_PLUGIN_ROOT: plugin }),
    });
  } finally {
    await activation?.finalize();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["directory", "isolation"])("prepares each plugin independently (%s)", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-plugin-preparation-"));
  const config = join(root, "config.json");
  const plugin = join(root, "plugin");
  const manifest = join(plugin, ".zcode-plugin", "plugin.json");
  try {
    await mkdir(join(plugin, ".zcode-plugin"), { recursive: true });
    await writeFile(
      manifest,
      JSON.stringify({
        name: "example",
        mcpServers: { demo: { command: "node", cwd: "${ZCODE_PLUGIN_DATA}" } },
      }),
    );
    await writeFile(
      config,
      JSON.stringify({
        plugins: { dirs: [plugin] },
        mcp: { servers: { old: { command: "node" } } },
      }),
    );
    const loader = createMcpConfigurationLoader({
      configPaths: [config],
      userConfigPath: config,
      pluginStorageRoot: join(root, "plugins"),
      pluginRoots: [],
      workingDirectory: root,
    });
    const initial = await accept(loader);
    const published = initial.configuration.servers["plugin:example:demo"];
    expect(published?.type).toBe("stdio");
    if (published?.type !== "stdio") throw new Error("missing plugin server");
    if (mode === "directory") {
      expect(
        await stat(published.cwd!)
          .then((s) => s.isDirectory())
          .catch(() => false),
      ).toBe(true);
      return;
    }
    await writeFile(
      manifest,
      JSON.stringify({
        name: "example",
        userConfig: { broken: null },
        mcpServers: { demo: { command: "node" } },
      }),
    );
    await writeFile(
      config,
      JSON.stringify({
        plugins: { dirs: [plugin] },
        mcp: { servers: { fresh: { command: "node" } } },
      }),
    );
    expect(Object.keys((await accept(loader)).configuration.servers)).toEqual(["fresh"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("holds stable execution paths during standalone activation and observes its commit marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-plugin-commit-"));
  const config = join(root, "config.json");
  const plugin = join(root, "plugin");
  const manifest = (command: string) =>
    JSON.stringify({ name: "example", mcpServers: { demo: { command } } });
  let activation: Awaited<ReturnType<typeof activateDirectoryAtomically>> | undefined;
  let source: Awaited<ReturnType<typeof createDynamicMcpConfigSource>> | undefined;
  try {
    await mkdir(join(plugin, ".zcode-plugin"), { recursive: true });
    await writeFile(join(plugin, ".zcode-plugin", "plugin.json"), manifest("old"));
    const settings = { plugins: { dirs: [plugin] }, mcp: { servers: {} } };
    await writeFile(config, JSON.stringify(settings));
    source = await createDynamicMcpConfigSource({
      configPaths: [config],
      userConfigPath: config,
      pluginStorageRoot: root,
      pluginRoots: [],
      workingDirectory: root,
    });
    const stable = source.getSnapshot().servers["plugin:example:demo"];
    activation = await activateDirectoryAtomically({
      targetPath: plugin,
      prepare: async (path) => {
        await mkdir(join(path, ".zcode-plugin"), { recursive: true });
        await writeFile(join(path, ".zcode-plugin", "plugin.json"), manifest("new"));
      },
    });
    const unrelated = Promise.withResolvers<void>();
    source.subscribe(() => {
      if (source!.getSnapshot().servers.unrelated) unrelated.resolve();
    });
    await writeFile(
      config,
      JSON.stringify({ ...settings, mcp: { servers: { unrelated: { command: "node" } } } }),
    );
    await unrelated.promise;
    expect(source.getSnapshot().servers["plugin:example:demo"]).toEqual(stable);
    const committed = Promise.withResolvers<void>();
    source.subscribe(() => {
      const server = source!.getSnapshot().servers["plugin:example:demo"];
      if (server?.type === "stdio" && server.command === "new") committed.resolve();
    });
    await activation.finalize();
    activation = undefined;
    await committed.promise;
    expect(source.getSnapshot().servers["plugin:example:demo"]).toMatchObject({
      env: { ZCODE_PLUGIN_ROOT: plugin },
    });
  } finally {
    source?.close();
    await activation?.rollback();
    await rm(root, { recursive: true, force: true });
  }
}, 5000);

it("does not retain a disabled plugin during activation and restores only the rolled-back generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-plugin-rollback-"));
  const config = join(root, "config.json");
  const plugin = join(root, "plugin");
  let activation: Awaited<ReturnType<typeof activateDirectoryAtomically>> | undefined;
  try {
    await mkdir(join(plugin, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(plugin, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "example", mcpServers: { demo: { command: "old" } } }),
    );
    const settings = { plugins: { dirs: [plugin] } };
    await writeFile(config, JSON.stringify(settings));
    const loader = createMcpConfigurationLoader({
      configPaths: [config],
      userConfigPath: config,
      pluginStorageRoot: root,
      pluginRoots: [],
      workingDirectory: root,
    });
    const stable = (await accept(loader)).configuration;
    activation = await activateDirectoryAtomically({
      targetPath: plugin,
      prepare: async (path) => {
        await mkdir(join(path, ".zcode-plugin"), { recursive: true });
        await writeFile(
          join(path, ".zcode-plugin", "plugin.json"),
          JSON.stringify({ name: "example", mcpServers: { demo: { command: "new" } } }),
        );
      },
    });
    await writeFile(config, JSON.stringify({ plugins: { ...settings.plugins, enabled: false } }));
    expect((await accept(loader)).configuration.servers).toEqual({});
    await writeFile(config, JSON.stringify(settings));
    expect((await accept(loader)).configuration.servers).toEqual({});
    await activation.rollback();
    activation = undefined;
    expect((await accept(loader)).configuration).toEqual(stable);
  } finally {
    await activation?.rollback();
    await rm(root, { recursive: true, force: true });
  }
});
