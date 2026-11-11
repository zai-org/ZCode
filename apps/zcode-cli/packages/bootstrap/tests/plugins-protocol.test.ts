import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginLoadOutcome } from "@zcode/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 协议 handler 只从 workspace 推导 storageRoot，user config 仍解析到 ~/.zcode/cli/config.json
// （getDefaultConfigPath 无 env 覆盖）。为隔离 restore/overview 的 user-config 往返，把 node:os
// 的 homedir 重定向到一次性临时目录；tmpdir 等其余实现保留原值。这样 resolvePath("~/.zcode/cli")
// 落到隔离目录，绝不触碰真实 HOME。
// 回归原因：vi.mock 会提升到普通 const 初始化之前；临时 HOME 也必须通过 vi.hoisted
// 提前建立，否则 mock factory 读取 FAKE_HOME 时会命中 TDZ，导致整个 suite 无法收集。
const FAKE_HOME = await vi.hoisted(async () => {
  const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ]);
  return await mkdtemp(join(tmpdir(), "zcode-protocol-home-"));
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => FAKE_HOME };
});

import {
  zcodeProtocolMethods,
  zcodePluginsConfigureParamsSchema,
  zcodePluginsInstallResultSchema,
  zcodePluginsListParamsSchema,
  zcodePluginsListResultSchema,
  zcodePluginsMarketplaceMutationResultSchema,
  zcodePluginsMarketplaceUpdateParamsSchema,
  zcodePluginsOverviewParamsSchema,
  zcodePluginsOverviewResultSchema,
  zcodePluginsCancelOperationParamsSchema,
  zcodePluginsCancelOperationResultSchema,
  zcodePluginsSetEnabledParamsSchema,
  zcodePluginsValidateResultSchema,
} from "@zcode/shared";
import { getCliStorageRoot, getPluginStorageRoot } from "../src/app/paths.js";
import { installZCodeMarketplacePlugin } from "../src/plugins.js";
import { createOfficialPluginPreparation } from "../src/app/bundled-plugins.js";
import {
  addPluginMarketplace,
  describePlugin,
  getPluginsOverview,
  installPlugin,
  listPlugins,
  normalizePluginRootForComparison,
  restoreBuiltinPlugin,
  updatePlugin,
} from "../src/zcode-protocol/plugins.js";
import { withPluginStorageLock } from "../src/lib/plugin-storage-lock.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

afterAll(async () => {
  await rm(FAKE_HOME, { force: true, recursive: true });
});

const NODE_REPL_HOST_PLUGIN_ID = "node-repl-host@zcode-plugins-official";

// 协议契约层面的回归: 确保 plugins/list 与 plugins/setEnabled 已注册且 schema 可用。
// 端到端发现逻辑由 bootstrap/tests/plugins.test.ts (resolveZCodePlugins) 覆盖。
describe("plugins protocol contracts", () => {
  it.each([true, false])(
    "normalizes external userConfig before strict list validation (enabled=%s)",
    async (enabled) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-plugin-user-config-"));
      const pluginRoot = join(root, "extension");
      const userConfigPath = join(FAKE_HOME, ".zcode", "cli", "config.json");
      const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
      const userConfig = {
        track: { type: "string", default: "auto", options: ["auto", "transform"] },
        panel: { type: "string", default: "auto", options: ["auto", "off"] },
        token: { type: "string", required: true, sensitive: true, title: "Token" },
      };
      const manifest = JSON.stringify({ name: "extension", userConfig });
      try {
        await writeTestFile(manifestPath, manifest);
        await writeTestFile(
          join(root, "healthy", ".claude-plugin", "plugin.json"),
          JSON.stringify({ name: "healthy" }),
        );
        await writeTestFile(
          userConfigPath,
          JSON.stringify({
            plugins: {
              dirs: [pluginRoot, join(root, "healthy")],
              enabledPlugins: { "extension@inline": enabled },
              options: { "extension@inline": { token: "fixture-secret" } },
            },
          }),
        );
        const result = await listPlugins({} as ZCodeProtocolAgentServerContext, {
          workspace: { workspacePath: root, workspaceKey: root },
        });
        const parsed = zcodePluginsListResultSchema.parse(result);
        expect(parsed.plugins.map((plugin) => plugin.id)).toContain("healthy@inline");
        expect(parsed.plugins.find((plugin) => plugin.id === "extension@inline")).toMatchObject({
          enabled,
          userConfig: {
            track: { type: "string", default: "auto" },
            panel: { type: "string", default: "auto" },
            token: userConfig.token,
          },
        });
        expect(JSON.stringify(parsed)).not.toContain("fixture-secret");
        expect(await readFile(manifestPath, "utf8")).toBe(manifest);
      } finally {
        await rm(userConfigPath, { force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    null,
    [],
    { token: null },
    { token: { sensitive: "true" } },
    { token: { type: "unknown" } },
    { token: { default: [] } },
  ])("isolates invalid known userConfig fields: %j", async (userConfig) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-invalid-config-"));
    const userConfigPath = join(FAKE_HOME, ".zcode", "cli", "config.json");
    try {
      for (const name of ["healthy", "invalid"]) {
        await writeTestFile(
          join(root, name, ".claude-plugin", "plugin.json"),
          JSON.stringify({
            name,
            ...(name === "invalid" ? { userConfig } : {}),
          }),
        );
      }
      await writeTestFile(
        userConfigPath,
        JSON.stringify({ plugins: { dirs: [join(root, "invalid"), join(root, "healthy")] } }),
      );
      const result = zcodePluginsListResultSchema.parse(
        await listPlugins({} as ZCodeProtocolAgentServerContext, {
          workspace: { workspacePath: root, workspaceKey: root },
        }),
      );
      expect(result.plugins.some((plugin) => plugin.id === "healthy@inline")).toBe(true);
      expect(result.plugins.some((plugin) => plugin.id === "invalid@inline")).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "plugin_manifest_invalid",
          pluginId: "invalid@inline",
          severity: "error",
        }),
      );
    } finally {
      await rm(userConfigPath, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes marketplace mutations behind the workspace plugin storage lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-protocol-marketplace-lock-"));
    const previousStorageDir = process.env.ZCODE_STORAGE_DIR;
    process.env.ZCODE_STORAGE_DIR = join(root, "storage");
    const pluginStorageRoot = getPluginStorageRoot(
      getCliStorageRoot(process.env.ZCODE_STORAGE_DIR),
    );
    let releaseLock = (): void => {};
    let markLockEntered = (): void => {};
    const lockEntered = new Promise<void>((resolve) => {
      markLockEntered = resolve;
    });
    const blocker = withPluginStorageLock(pluginStorageRoot, async () => {
      markLockEntered();
      await new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    });

    try {
      await lockEntered;
      const mutation = addPluginMarketplace({} as ZCodeProtocolAgentServerContext, {
        workspace: { workspacePath: root, workspaceKey: root },
        source: "unsupported-marketplace-source",
      }).then(
        () => "resolved",
        () => "rejected",
      );

      expect(
        await Promise.race([
          mutation,
          new Promise<"blocked">((resolve) => {
            setTimeout(() => resolve("blocked"), 50);
          }),
        ]),
      ).toBe("blocked");

      releaseLock();
      await blocker;
      expect(await mutation).toBe("rejected");
    } finally {
      releaseLock();
      await blocker;
      if (previousStorageDir === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorageDir;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("describes a cached marketplace candidate while a long install holds the storage lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-protocol-describe-lock-"));
    const previousStorageDir = process.env.ZCODE_STORAGE_DIR;
    process.env.ZCODE_STORAGE_DIR = join(root, "storage");
    const pluginStorageRoot = getPluginStorageRoot(
      getCliStorageRoot(process.env.ZCODE_STORAGE_DIR),
    );
    const marketplaceDir = join(pluginStorageRoot, "marketplaces", "e2e-describe");
    await writeTestFile(
      join(marketplaceDir, "marketplace.json"),
      JSON.stringify({ name: "e2e-describe", plugins: [{ name: "local", source: "./local" }] }),
    );
    await writeTestFile(
      join(marketplaceDir, "local", "skills", "describe-marker", "SKILL.md"),
      "---\nname: describe-marker\ndescription: Describe marker\n---\n",
    );
    const lock = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    // 模拟长时间安装占住存储锁：详情读取已缓存 manifest 时不能排在它后面。
    const blocker = withPluginStorageLock(pluginStorageRoot, async () => {
      entered.resolve();
      await lock.promise;
    });
    try {
      await entered.promise;
      const result = await Promise.race([
        describePlugin({} as ZCodeProtocolAgentServerContext, {
          workspace: { workspacePath: root, workspaceKey: root },
          marketplace: "e2e-describe",
          pluginName: "local",
        }),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1000)),
      ]);
      expect(result).not.toBe("blocked");
      expect(JSON.stringify(result)).toContain("describe-marker");
    } finally {
      lock.resolve();
      await blocker;
      if (previousStorageDir === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorageDir;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps describe behind the storage lock when the marketplace manifest must be written", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-protocol-describe-fetch-lock-"));
    const previousStorageDir = process.env.ZCODE_STORAGE_DIR;
    process.env.ZCODE_STORAGE_DIR = join(root, "storage");
    const pluginStorageRoot = getPluginStorageRoot(
      getCliStorageRoot(process.env.ZCODE_STORAGE_DIR),
    );
    const lock = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const blocker = withPluginStorageLock(pluginStorageRoot, async () => {
      entered.resolve();
      await lock.promise;
    });
    try {
      await entered.promise;
      const describe = describePlugin({} as ZCodeProtocolAgentServerContext, {
        workspace: { workspacePath: root, workspaceKey: root },
        marketplace: "missing-marketplace",
        pluginName: "missing",
      }).then(() => "resolved");
      expect(
        await Promise.race([
          describe,
          new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
        ]),
      ).toBe("blocked");
      lock.resolve();
      expect(await describe).toBe("resolved");
    } finally {
      lock.resolve();
      await blocker;
      if (previousStorageDir === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorageDir;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("registers plugin management methods", () => {
    expect(zcodeProtocolMethods.pluginsList).toBe("plugins/list");
    expect(zcodeProtocolMethods.pluginsSetEnabled).toBe("plugins/setEnabled");
    expect(zcodeProtocolMethods.pluginsOverview).toBe("plugins/overview");
    expect(zcodeProtocolMethods.pluginsMarketplaceAdd).toBe("plugins/marketplace/add");
    expect(zcodeProtocolMethods.pluginsMarketplaceUpdate).toBe("plugins/marketplace/update");
    expect(zcodeProtocolMethods.pluginsInstall).toBe("plugins/install");
    expect(zcodeProtocolMethods.pluginsCancelOperation).toBe("plugins/cancelOperation");
    expect(zcodeProtocolMethods.pluginsValidate).toBe("plugins/validate");
  });

  it("accepts an optional config scope for Settings list and overview projections", () => {
    const workspace = { workspacePath: "/w", workspaceKey: "/w" };
    expect(
      zcodePluginsListParamsSchema.parse({
        workspace,
        configScope: "user",
      }).configScope,
    ).toBe("user");
    expect(
      zcodePluginsOverviewParamsSchema.parse({
        workspace,
        configScope: "workspace",
      }).configScope,
    ).toBe("workspace");
  });

  it("parses a plugins/list result payload", () => {
    const parsed = zcodePluginsListResultSchema.parse({
      plugins: [
        {
          id: "skill-creator@zcode-plugins-official",
          name: "skill-creator",
          enabled: true,
          source: "official",
          marketplace: "zcode-plugins-official",
          skillCount: 1,
          skillRootCount: 1,
          commandRootCount: 0,
          declaredMcpServerNames: [],
          mcpServerNames: [],
          hostMcpServerNames: ["node_repl"],
          hookDetails: [
            {
              event: "Stop",
              matcher: "default",
              type: "command",
              command: 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/stop-hook.sh"',
              sourcePath: "/cache/skill-creator/hooks/hooks.json",
              runnable: true,
            },
          ],
          rootPath: "/cache/skill-creator/0.1.0",
          rootSource: "workspace",
          enabledSource: "workspace",
          optionSources: {
            label: "workspace",
          },
        },
      ],
      diagnostics: [
        { code: "plugin_unsupported_component", message: "ignored", severity: "warning" },
      ],
    });
    expect(parsed.plugins[0]?.name).toBe("skill-creator");
    expect(parsed.plugins[0]?.hostMcpServerNames).toEqual(["node_repl"]);
    expect(parsed.plugins[0]?.hookDetails?.[0]?.event).toBe("Stop");
    expect(parsed.plugins[0]?.rootSource).toBe("workspace");
    expect(parsed.plugins[0]?.enabledSource).toBe("workspace");
    expect(parsed.plugins[0]?.optionSources).toEqual({ label: "workspace" });
  });

  it("normalizes Windows plugin roots for Workspace ownership projection", () => {
    expect(
      normalizePluginRootForComparison("C:\\Repo\\Plugin", "win32"),
    ).toBe(normalizePluginRootForComparison("c:/repo/plugin", "win32"));
  });

  it("does not discover an inline plugin from Workspace plugin directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-workspace-plugin-root-source-"));
    const pluginRoot = join(root, "plugins", "workspace-demo");
    try {
      await writeTestFile(
        join(root, ".zcode", "config.json"),
        JSON.stringify({ plugins: { dirs: [pluginRoot], enabledPlugins: { "workspace-demo@inline": false } } }),
      );
      await writeTestFile(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({
          name: "workspace-demo", mcpServers: { panel: { command: "node", args: ["panel.mjs"] } },
          ui: { surfaces: [{ id: "panel", title: "Panel", server: "panel", resourceUri: "ui://demo/panel", availability: "session" }] },
        }),
      );

      const result = await listPlugins({} as ZCodeProtocolAgentServerContext, {
        workspace: { workspacePath: root, workspaceKey: root },
      });

      expect(result.plugins.find((plugin) => plugin.id === "workspace-demo@inline")).toMatchObject({
        rootPath: "",
        packageStatus: "missing",
        enabled: false,
        mcpServerNames: [],
      });
      expect(result.plugins.find((plugin) => plugin.id === "workspace-demo@inline")?.uiSurfaces).toBeUndefined();
      expect(() => zcodePluginsListResultSchema.parse(result)).not.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports each plugin's data path for the App extension context", async () => {
    // docs/plugins/extension-host.md §18.1 H6：ctx.extension.dataPath 只取 plugins/list 的 dataPath，
    // 与 MCP server 的 ${ZCODE_PLUGIN_DATA} 同一个值（<CLI 插件存储根>/data/<插件 id>）。
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-data-path-"));
    const pluginRoot = join(root, "plugins", "data-demo");
    const userConfigPath = join(FAKE_HOME, ".zcode", "cli", "config.json");
    try {
      await writeTestFile(
        userConfigPath,
        JSON.stringify({
          plugins: { dirs: [pluginRoot], enabledPlugins: { "data-demo@inline": true } },
        }),
      );
      await writeTestFile(
        join(pluginRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({ name: "data-demo", version: "1.0.0" }),
      );

      const result = await listPlugins({} as ZCodeProtocolAgentServerContext, {
        workspace: { workspacePath: root, workspaceKey: root },
        configScope: "user",
      });

      expect(result.plugins.find((plugin) => plugin.id === "data-demo@inline")?.dataPath).toBe(
        join(FAKE_HOME, ".zcode", "cli", "plugins", "data", "data-demo@inline"),
      );
      expect(() => zcodePluginsListResultSchema.parse(result)).not.toThrow();
    } finally {
      await rm(userConfigPath, { force: true });
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps the User projection independent from Workspace enable overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-config-view-"));
    const pluginId = "skill-creator@zcode-plugins-official";
    const userConfigPath = join(FAKE_HOME, ".zcode", "cli", "config.json");
    try {
      await writeTestFile(
        userConfigPath,
        JSON.stringify({
          plugins: { enabledPlugins: { [pluginId]: true } },
        }),
      );
      await writeTestFile(
        join(root, ".zcode", "config.json"),
        JSON.stringify({
          plugins: { enabledPlugins: { [pluginId]: false } },
        }),
      );

      const userResult = await listPlugins(
        {} as ZCodeProtocolAgentServerContext,
        {
          workspace: { workspacePath: root, workspaceKey: root },
          configScope: "user",
        },
      );
      const workspaceResult = await listPlugins(
        {} as ZCodeProtocolAgentServerContext,
        {
          workspace: { workspacePath: root, workspaceKey: root },
          configScope: "workspace",
        },
      );

      expect(
        userResult.plugins.find((plugin) => plugin.id === pluginId),
      ).toMatchObject({
        enabled: true,
        enabledSource: "user",
      });
      expect(
        workspaceResult.plugins.find((plugin) => plugin.id === pluginId),
      ).toMatchObject({
        enabled: false,
        enabledSource: "workspace",
      });
    } finally {
      await rm(userConfigPath, { force: true });
      await rm(root, { force: true, recursive: true });
    }
  });

  it("preserves User option sources in the Workspace merged projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-option-source-view-"));
    const pluginRoot = join(root, "user-plugin");
    const pluginId = "option-source-view@inline";
    const userConfigPath = join(FAKE_HOME, ".zcode", "cli", "config.json");
    try {
      await writeTestFile(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({
          name: "option-source-view",
          userConfig: {
            label: { default: "default-label", type: "string" },
          },
        }),
      );
      await writeTestFile(
        userConfigPath,
        JSON.stringify({
          plugins: {
            dirs: [pluginRoot],
            options: { [pluginId]: { label: "user-label" } },
          },
        }),
      );

      const result = await listPlugins({} as ZCodeProtocolAgentServerContext, {
        workspace: { workspacePath: root, workspaceKey: root },
        configScope: "workspace",
      });

      expect(result.plugins.find((plugin) => plugin.id === pluginId)).toMatchObject({
        configuredOptions: { label: "user-label" },
        optionSources: { label: "user" },
      });
    } finally {
      await rm(userConfigPath, { force: true });
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    { name: "list", query: listPlugins, duringQuery: false },
    { name: "overview", query: getPluginsOverview, duringQuery: false },
    { name: "list", query: listPlugins, duringQuery: true },
    { name: "overview", query: getPluginsOverview, duringQuery: true },
  ])(
    "rejects degraded management $name (duringQuery=$duringQuery)",
    async ({ query, duringQuery }) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-plugin-degraded-query-"));
      const previousStorage = process.env.ZCODE_STORAGE_DIR;
      process.env.ZCODE_STORAGE_DIR = join(root, "storage");
      const preparation = createOfficialPluginPreparation({ startupTimeoutMs: 3000 });
      const pluginId = "skill-creator@zcode-plugins-official";
      const entered = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<PluginLoadOutcome>();
      const discoverPlugins = () => {
        entered.resolve();
        return pending.promise;
      };
      try {
        await writeTestFile(
          join(root, ".zcode", "config.json"),
          JSON.stringify({ plugins: { enabledPlugins: { [pluginId]: true } } }),
        );
        const params = {
          workspace: { workspacePath: root, workspaceKey: root },
          configScope: "workspace",
        };
        const baseline = await listPlugins({} as ZCodeProtocolAgentServerContext, params);
        const installed = baseline.plugins.find((p) => p.id === pluginId)!;
        expect(installed.rootPath).toBeTruthy();
        expect(installed.packageStatus).not.toBe("missing");
        const markerPath = join(installed.rootPath, ".zcode-plugin-seed.json");
        const marker = await readFile(markerPath, "utf8");
        vi.useFakeTimers();
        if (!duringQuery) {
          const fallback = preparation.resolvePlugins(discoverPlugins);
          await vi.advanceTimersByTimeAsync(3000);
          expect((await fallback).diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: "plugin_startup_timeout" })]),
          );
        }
        const context = {
          deps: { pluginPreparation: preparation, pluginDiscovery: { discoverPlugins } },
        } as ZCodeProtocolAgentServerContext;
        const result = query(context, params).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        if (duringQuery) {
          await entered.promise;
          await vi.advanceTimersByTimeAsync(3000);
        }
        vi.useRealTimers();
        expect(await result).toMatchObject({ error: { code: "ZCODE_PLUGIN_STARTUP_TIMEOUT" } });
        expect(await readFile(markerPath, "utf8")).toBe(marker);
      } finally {
        vi.useRealTimers();
        pending.resolve({
          plugins: [],
          diagnostics: [],
          hooks: {},
          mcpServers: {},
          skillRoots: [],
          commandRoots: [],
        });
        await preparation.dispose();
        if (previousStorage === undefined) delete process.env.ZCODE_STORAGE_DIR;
        else process.env.ZCODE_STORAGE_DIR = previousStorage;
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  it("keeps a Workspace declaration visible when its package is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-missing-package-view-"));
    const pluginId = "missing-fixture@personal-market";
    try {
      await writeTestFile(
        join(root, ".zcode", "config.json"),
        JSON.stringify({
          plugins: { enabledPlugins: { [pluginId]: true } },
        }),
      );

      const result = await listPlugins(
        {} as ZCodeProtocolAgentServerContext,
        {
          workspace: { workspacePath: root, workspaceKey: root },
          configScope: "workspace",
        },
      );

      expect(
        result.plugins.find((plugin) => plugin.id === pluginId),
      ).toMatchObject({
        enabled: true,
        enabledSource: "workspace",
        marketplace: "personal-market",
        name: "missing-fixture",
        packageStatus: "missing",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("hides the node-repl-host plugin and its host node_repl MCP from settings projections", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-browser-host-mcp-protocol-"));
    const previousStorageDir = process.env.ZCODE_STORAGE_DIR;
    process.env.ZCODE_STORAGE_DIR = join(root, "cli");

    try {
      const result = await listPlugins({} as ZCodeProtocolAgentServerContext, {
        workspace: { workspacePath: root, workspaceKey: root },
      });
      expect(result.plugins.some((plugin) => plugin.hostMcpServerNames !== undefined)).toBe(false);
      expect(result.plugins.map((plugin) => plugin.id)).not.toContain(NODE_REPL_HOST_PLUGIN_ID);

      const overview = await getPluginsOverview({} as ZCodeProtocolAgentServerContext, {
        workspace: { workspacePath: root, workspaceKey: root },
      });
      expect(
        [
          ...overview.availablePlugins,
          ...overview.installedPlugins,
          ...overview.restorableBuiltins,
        ].map((plugin) => plugin.id),
      ).not.toContain(NODE_REPL_HOST_PLUGIN_ID);
    } finally {
      if (previousStorageDir === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorageDir;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a plugins/setEnabled payload missing pluginId", () => {
    expect(() =>
      zcodePluginsSetEnabledParamsSchema.parse({
        workspace: { workspacePath: "/w", workspaceKey: "/w" },
        enabled: true,
      }),
    ).toThrow();
  });

  it("accepts an operationId for cancellable suggested-prompt enablement", () => {
    expect(
      zcodePluginsSetEnabledParamsSchema.parse({
        workspace: { workspacePath: "/w", workspaceKey: "/w" },
        pluginId: "document-skills@zcode-plugins-official",
        enabled: true,
        operationId: "suggested-enable-1",
      }).operationId,
    ).toBe("suggested-enable-1");
  });

  it("parses marketplace mutation, install, and validate result payloads", () => {
    expect(
      zcodePluginsConfigureParamsSchema.parse({
        workspace: { workspacePath: "/w", workspaceKey: "/w" },
        pluginId: "secret-plugin@personal",
        options: { region: "us-east-1" },
        clearOptionKeys: ["token"],
      }).clearOptionKeys,
    ).toEqual(["token"]);

    expect(
      zcodePluginsMarketplaceUpdateParamsSchema.parse({
        workspace: { workspacePath: "/w", workspaceKey: "/w" },
        marketplace: "workspace-market",
        operationId: "refresh-workspace-market",
      }).operationId,
    ).toBe("refresh-workspace-market");

    expect(
      zcodePluginsMarketplaceMutationResultSchema.parse({
        marketplace: {
          id: "claude-plugins-official",
          name: "claude-plugins-official",
          source: { source: "github", repo: "anthropics/claude-plugins" },
          pluginCount: 10,
          refreshFailure: {
            code: "plugin_archive_fetch_failed",
            failedAt: "2026-08-05T00:00:00.000Z",
            message: "archive unavailable",
          },
        },
        diagnostics: [],
      }).marketplace?.id,
    ).toBe("claude-plugins-official");

    expect(
      zcodePluginsInstallResultSchema.parse({
        installedPlugins: [
          {
            id: "hello@claude-plugins-official",
            name: "hello",
            marketplace: "claude-plugins-official",
            enabled: false,
            scope: "user",
          },
        ],
        dependencyClosure: ["hello@claude-plugins-official"],
        diagnostics: [],
      }).installedPlugins[0]?.id,
    ).toBe("hello@claude-plugins-official");

    expect(
      zcodePluginsValidateResultSchema.parse({
        ok: true,
        diagnostics: [],
        compatibility: {
          runnable: ["skills", "commands", "hooks", "mcpServers", "userConfig"],
          diagnosticOnly: ["agents"],
          unsupported: ["npm"],
        },
      }).compatibility.runnable,
    ).toContain("hooks");
  });

  it("parses a plugins/cancelOperation payload", () => {
    expect(
      zcodePluginsCancelOperationParamsSchema.parse({
        operationId: "remote-plugin-sync-1",
      }).operationId,
    ).toBe("remote-plugin-sync-1");
    expect(
      zcodePluginsCancelOperationResultSchema.parse({
        operationId: "remote-plugin-sync-1",
        cancelled: true,
      }),
    ).toEqual({ operationId: "remote-plugin-sync-1", cancelled: true });
  });
});

async function writeTestFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function writeKnownMarketplaces(
  storageRoot: string,
  marketplaces: Array<Record<string, unknown>>,
): Promise<void> {
  await writeTestFile(
    join(storageRoot, "known_marketplaces.json"),
    JSON.stringify({ version: 1, marketplaces }),
  );
}

// updatePlugin 走真实 bootstrap 路径：它从 workspace 的 config 推导 pluginStorageRoot，
// 因此用 ZCODE_STORAGE_DIR 把存储根锚定到临时目录（storage.dir 以 "cli" 结尾时
// getCliStorageRoot 原样返回，故 pluginStorageRoot = <storageDir>/plugins）。
describe("updatePlugin handler diagnostics", () => {
  const noopContext = {} as unknown as ZCodeProtocolAgentServerContext;
  let previousStorageDir: string | undefined;

  beforeEach(() => {
    previousStorageDir = process.env.ZCODE_STORAGE_DIR;
  });

  afterEach(() => {
    if (previousStorageDir === undefined) delete process.env.ZCODE_STORAGE_DIR;
    else process.env.ZCODE_STORAGE_DIR = previousStorageDir;
  });

  it("update returns diagnostics when a target fails to reinstall", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-update-fail-"));
    const storageDir = join(root, "cli");
    const pluginStorageRoot = getPluginStorageRoot(getCliStorageRoot(storageDir));
    const marketplaceRoot = join(root, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "demo");
    process.env.ZCODE_STORAGE_DIR = storageDir;

    try {
      // Arrange: a directory marketplace declaring demo@1.0.0, installed into the
      // exact storage root the handler will resolve.
      await writeKnownMarketplaces(pluginStorageRoot, [
        {
          id: "lazy-market",
          source: { source: "directory", path: marketplaceRoot },
          name: "lazy-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 0,
        },
      ]);
      await writeTestFile(
        join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "lazy-market",
          plugins: [{ name: "demo", source: "./plugins/demo", version: "1.0.0" }],
        }),
      );
      await writeTestFile(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "demo", skills: "skills", version: "1.0.0" }),
      );
      await writeTestFile(join(pluginRoot, "skills", "demo", "SKILL.md"), "# demo");

      const installResult = await installZCodeMarketplacePlugin({
        marketplace: "lazy-market",
        pluginName: "demo",
        pluginStorageRoot,
        userConfigPath: join(root, "config.json"),
        workingDirectory: root,
      });
      expect(installResult.installedPlugins.map((p) => p.id)).toContain("demo@lazy-market");

      // Make reinstall fail: drop the persisted marketplace manifest dir AND the
      // source directory. ensureMarketplaceManifestAvailable then falls back to the
      // known record and re-fetches from the (now missing) directory source, which
      // throws -> installZCodeMarketplacePlugin returns an error diagnostic.
      await rm(join(pluginStorageRoot, "marketplaces", "lazy-market"), {
        force: true,
        recursive: true,
      });
      await rm(marketplaceRoot, { force: true, recursive: true });

      const result = await updatePlugin(noopContext, {
        workspace: { workspacePath: root, workspaceKey: root },
        pluginId: "demo@lazy-market",
      });

      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.installedPlugins).toHaveLength(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

// 扩展摘要的版本兼容（docs/plugins/plugin-publishing.md §4.3）：商店信息与 overview 结果是 strict，
// services 可能比 CLI 旧。CLI 只在参数带 includeExtensionSummary 时才写 listing.extensionSummary；
// 安装等其他结果一律不带。componentTypes 的 "extension" 是开放字符串，照常透传。
describe("plugins/overview extension summary", () => {
  const noopContext = {} as unknown as ZCodeProtocolAgentServerContext;
  let previousStorageDir: string | undefined;

  beforeEach(() => {
    previousStorageDir = process.env.ZCODE_STORAGE_DIR;
  });

  afterEach(() => {
    if (previousStorageDir === undefined) delete process.env.ZCODE_STORAGE_DIR;
    else process.env.ZCODE_STORAGE_DIR = previousStorageDir;
  });

  it("adds listing.extensionSummary only when the request asks for it", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-extension-summary-"));
    const storageDir = join(root, "cli");
    const pluginStorageRoot = getPluginStorageRoot(getCliStorageRoot(storageDir));
    const marketplaceRoot = join(root, "marketplace");
    process.env.ZCODE_STORAGE_DIR = storageDir;
    const summary = { engines: { zcode: "^1.4.0" }, grants: ["sessions.fullAccess"] };

    try {
      await writeKnownMarketplaces(pluginStorageRoot, [
        {
          id: "ext-market",
          source: { source: "directory", path: marketplaceRoot },
          name: "ext-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 0,
        },
      ]);
      await writeTestFile(
        join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "ext-market",
          plugins: [
            {
              name: "ext-ok",
              source: "./plugins/ext-ok",
              version: "1.0.0",
              displayName: "Ext OK",
              componentTypes: ["extension"],
              extensionSummary: { ...summary, unknownKey: true },
            },
            { name: "plain", source: "./plugins/plain", version: "1.0.0" },
          ],
        }),
      );
      for (const name of ["ext-ok", "plain"]) {
        const pluginRoot = join(marketplaceRoot, "plugins", name);
        await writeTestFile(
          join(pluginRoot, ".claude-plugin", "plugin.json"),
          JSON.stringify({ name, skills: "skills", version: "1.0.0" }),
        );
        await writeTestFile(join(pluginRoot, "skills", name, "SKILL.md"), `# ${name}`);
      }
      const workspace = { workspacePath: root, workspaceKey: root };
      const install = await installPlugin(noopContext, {
        workspace,
        marketplace: "ext-market",
        pluginName: "ext-ok",
      });
      expect(install.installedPlugins.map((plugin) => plugin.id)).toContain("ext-ok@ext-market");
      expect(JSON.stringify(install)).not.toContain("extensionSummary");

      const legacy = await getPluginsOverview(noopContext, { workspace });
      // 旧 services 的 strict schema 没有这个键；不要求时线上不能出现它。
      expect(JSON.stringify(legacy)).not.toContain("extensionSummary");
      expect(
        legacy.availablePlugins.find((plugin) => plugin.id === "ext-ok@ext-market")
          ?.componentTypes,
      ).toContain("extension");

      const params = { workspace, includeExtensionSummary: true };
      expect(zcodePluginsOverviewParamsSchema.parse(params)).toEqual(params);
      const overview = zcodePluginsOverviewResultSchema.parse(
        await getPluginsOverview(noopContext, params),
      );
      const available = overview.availablePlugins.find(
        (plugin) => plugin.id === "ext-ok@ext-market",
      );
      expect(available?.listing).toEqual({ displayName: "Ext OK", extensionSummary: summary });
      expect(
        overview.installedPlugins.find((plugin) => plugin.id === "ext-ok@ext-market")?.listing,
      ).toEqual({ displayName: "Ext OK", extensionSummary: summary });
      const plain = overview.availablePlugins.find((plugin) => plugin.id === "plain@ext-market");
      expect(plain?.listing).toBeUndefined();
      expect(plain?.componentTypes ?? []).not.toContain("extension");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

// restoreBuiltinPlugin / overview 走真实 bootstrap 路径：storageRoot 由 ZCODE_STORAGE_DIR
// 锚定（storage.dir 以 "cli" 结尾时 getCliStorageRoot 原样返回，pluginStorageRoot =
// <storageDir>/plugins）；suppressedBuiltins 必须写到 handler 实际解析的 user config，即
// ~/.zcode/cli/config.json（文件头部已把 homedir 重定向到 FAKE_HOME，故落在隔离目录）。
describe("restoreBuiltinPlugin handler", () => {
  const noopContext = {} as unknown as ZCodeProtocolAgentServerContext;
  const builtinId = "skill-creator@zcode-plugins-official";
  const userConfigPath = join(FAKE_HOME, ".zcode", "cli", "config.json");
  let previousStorageDir: string | undefined;

  beforeEach(() => {
    previousStorageDir = process.env.ZCODE_STORAGE_DIR;
  });

  afterEach(async () => {
    if (previousStorageDir === undefined) delete process.env.ZCODE_STORAGE_DIR;
    else process.env.ZCODE_STORAGE_DIR = previousStorageDir;
    await rm(userConfigPath, { force: true });
  });

  it("restoreBuiltinPlugin clears suppression via protocol handler", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-restore-handler-"));
    const storageDir = join(root, "cli");
    process.env.ZCODE_STORAGE_DIR = storageDir;

    try {
      // Arrange: user config (the path the handler actually reads/writes) suppresses
      // the built-in so the overview lists it as a restorable built-in.
      await writeTestFile(
        userConfigPath,
        JSON.stringify({ plugins: { enabled: true, suppressedBuiltins: [builtinId] } }),
      );

      const before = await getPluginsOverview(noopContext, {
        workspace: { workspacePath: root, workspaceKey: root },
      });
      expect(before.restorableBuiltins.find((p) => p.id === builtinId)).toBeDefined();

      const result = await restoreBuiltinPlugin(noopContext, {
        workspace: { workspacePath: root, workspaceKey: root },
        pluginId: builtinId,
      });
      expect(result).toEqual({ pluginId: builtinId, diagnostics: [] });

      // The handler patched the user config to drop the suppression marker.
      const config = JSON.parse(await readFile(userConfigPath, "utf8"));
      expect(config.plugins?.suppressedBuiltins ?? []).not.toContain(builtinId);

      // After restore the overview no longer lists it as restorable.
      const after = await getPluginsOverview(noopContext, {
        workspace: { workspacePath: root, workspaceKey: root },
      });
      expect(after.restorableBuiltins.find((p) => p.id === builtinId)).toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("restores a suppressed bundled plugin through the locked install handler without deadlocking", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-install-handler-"));
    const storageDir = join(root, "cli");
    process.env.ZCODE_STORAGE_DIR = storageDir;

    try {
      await writeTestFile(
        userConfigPath,
        JSON.stringify({
          plugins: { enabled: true, suppressedBuiltins: [builtinId] },
        }),
      );
      // Seed the bundled catalog/cache before entering the protocol lock.
      await getPluginsOverview(noopContext, {
        workspace: { workspacePath: root, workspaceKey: root },
      });

      const result = await Promise.race([
        installPlugin(noopContext, {
          workspace: { workspacePath: root, workspaceKey: root },
          marketplace: "zcode-plugins-official",
          pluginName: "skill-creator",
        }),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000)),
      ]);

      expect(result).not.toBe("timeout");
      expect(result).toMatchObject({
        dependencyClosure: [builtinId],
        diagnostics: [],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
