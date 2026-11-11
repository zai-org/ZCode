import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfig } from "@zcode/adapters/config";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS } from "@zcode/shared";
import { ZCODE_PLUGIN_HOST_COMMAND } from "@zcode/contracts";
import type { Logger, PluginDiscoverRequest } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveStartupPlugins } from "../src/app/startup-marks.js";
import {
  createOfficialPluginPreparation,
  findMissingOfficialPluginSeedPaths,
  resolveOfficialPluginRoots,
} from "../src/app/bundled-plugins.js";
import {
  OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS,
  OFFICIAL_PLUGIN_DEFINITIONS,
} from "../src/app/official-plugin-definitions.js";
import { createPluginFacadeForApp } from "../src/app/plugin-facade.js";
import type { ZCodeAppOptions } from "../src/app/types.js";
import {
  configureZCodePlugin,
  describeZCodePlugin,
  enrichCachedClaudeMarketplaceIconsForOverview,
  getZCodePluginsOverview,
  installZCodeMarketplacePlugin,
  listZCodePlugins,
  resolveZCodePlugins,
  resetZCodePluginConfig,
  resolveMarketplaceRefreshTargetIds,
  restoreBuiltinPlugin,
  setZCodePluginEnabled,
  uninstallZCodeMarketplacePlugin,
  updateZCodePluginMarketplace,
  validateZCodePlugin,
  isWorkspacePluginConfigPath,
} from "../src/plugins.js";
import { StartupTimer } from "../src/startup-logging.js";

const IOS_SIMULATOR_PLUGIN_ID = "ios-simulator@zcode-plugins-official";

it("Settings 默认启用集合与 CLI 的官方插件声明一致", () => {
  expect([...DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS].sort()).toEqual(
    OFFICIAL_PLUGIN_DEFINITIONS.filter((definition) => definition.defaultEnabled)
      .map((definition) => `${definition.name}@zcode-plugins-official`)
      .sort(),
  );
});

// 产品决策（2026-09-11）：电脑控制回退为默认关闭，首启不再注入 computer-use 工具集与
// Helper 依赖。上面那条只保证两处名单同步，不阻止有人重新把 defaultEnabled 标回 true，
// 所以这里单独把 CUA 的默认态钉住。
it("computer-use 默认不启用（电脑控制需用户在设置页显式开启）", () => {
  const cua = OFFICIAL_PLUGIN_DEFINITIONS.find((definition) => definition.name === "computer-use");
  expect(cua).toBeDefined();
  expect(cua?.defaultEnabled ?? false).toBe(false);
  expect(DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has("computer-use@zcode-plugins-official")).toBe(
    false,
  );
});
it("design 默认关闭，等待用户安装或启用", () => {
  const design = OFFICIAL_PLUGIN_DEFINITIONS.find((definition) => definition.name === "design");
  expect(design).toBeDefined();
  expect(design?.defaultEnabled ?? false).toBe(false);
  expect(DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has("design@zcode-plugins-official")).toBe(false);
});

const ANDROID_EMULATOR_PLUGIN_ID = "android-emulator@zcode-plugins-official";
const IOS_SIMULATOR_MCP_ID = "plugin:ios-simulator:ios-simulator";
const ANDROID_EMULATOR_MCP_ID = "plugin:android-emulator:android-emulator";
const BROWSER_USE_PLUGIN_ID = "browser-use@zcode-plugins-official";
const DOCUMENTS_PLUGIN_ID = "documents@zcode-plugins-official";
const RESTORE_LEGACY_SESSIONS_PLUGIN_ID = "restore-legacy-sessions@zcode-plugins-official";
const SKILL_CREATOR_PLUGIN_ID = "skill-creator@zcode-plugins-official";

function createNoopStartupTimer(): StartupTimer {
  const noop = () => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return new StartupTimer(logger, {});
}
const OFFICIAL_PLUGIN_CACHE_PATH = join(
  "cache",
  "zcode-plugins-official",
  "ios-simulator",
  "0.1.0",
);
const OFFICIAL_ANDROID_PLUGIN_CACHE_PATH = join(
  "cache",
  "zcode-plugins-official",
  "android-emulator",
  "0.1.1",
);
const OFFICIAL_RESTORE_LEGACY_SESSIONS_PLUGIN_CACHE_PATH = join(
  "cache",
  "zcode-plugins-official",
  "restore-legacy-sessions",
  "0.1.0",
);
const OFFICIAL_SKILL_CREATOR_PLUGIN_CACHE_PATH = join(
  "cache",
  "zcode-plugins-official",
  "skill-creator",
  "0.1.0",
);
const BUNDLED_PLUGIN_DIST_PATH = fileURLToPath(
  new URL("../../ios-simulator-plugin/dist/mcp/server.js", import.meta.url),
);
const BUNDLED_ANDROID_PLUGIN_DIST_PATH = fileURLToPath(
  new URL("../../android-emulator-plugin/dist/mcp/server.js", import.meta.url),
);

describe("ZCode plugins", () => {
  it("uses the existing Runtime identity for shared startup and facade discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-runtime-plugin-scope-"));
    const discoverPlugins = vi.fn(async (_request: PluginDiscoverRequest) => ({
      commandRoots: [],
      diagnostics: [],
      hooks: {},
      mcpServers: {},
      plugins: [],
      skillRoots: [],
    }));
    const options = {
      env: {},
      pluginStorageRoot: join(root, "plugins"),
      pluginDiscovery: { discoverPlugins },
      pluginPreparation: {
        startupDegraded: false,
        resolvePlugins: async (resolve: () => ReturnType<typeof discoverPlugins>) =>
          await resolve(),
        signal: new AbortController().signal,
        prepare: async () => [],
        invalidate() {},
        async dispose() {},
      },
      runtimeConfig: {
        memory: { workspaceIdentity: "remote-workspace" },
        remoteSessionId: "attachment-one",
      },
    };
    try {
      const configResult = createConfig({ env: {}, skipUserConfig: true, workingDirectory: root });
      await resolveStartupPlugins({
        cliStorageRoot: join(root, "cli"),
        configResult,
        options,
        startupTimer: createNoopStartupTimer(),
        workingDirectory: root,
      });
      const facade = createPluginFacadeForApp({
        configResult,
        options: options as ZCodeAppOptions,
        workingDirectory: root,
      });
      await facade.listPlugins();
      expect(discoverPlugins).toHaveBeenCalledTimes(2);
      for (const call of discoverPlugins.mock.calls) {
        expect(call[0]).toMatchObject({
          workingDirectory: root,
          workspaceIdentity: "remote-workspace",
          remoteSessionId: "attachment-one",
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts cached Claude icon migration without blocking overview callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-icon-migration-"));
    const pluginStorageRoot = join(root, "plugins");
    const marketplaceRoot = join(pluginStorageRoot, "marketplaces", "claude-plugins-official");
    try {
      await mkdir(marketplaceRoot, { recursive: true });
      await writeFile(
        join(marketplaceRoot, "marketplace.json"),
        JSON.stringify({
          name: "claude-plugins-official",
          plugins: [{ name: "figma", source: "./figma" }],
        }),
      );
      let resolveFetch!: (response: Response) => void;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        ),
      );

      expect(
        enrichCachedClaudeMarketplaceIconsForOverview({
          env: {},
          pluginStorageRoot,
          skipUserConfig: true,
          workingDirectory: root,
        }),
      ).toBeUndefined();

      resolveFetch(
        new Response(
          JSON.stringify([{ name: "figma", icon: "figma/icon.png", mimeType: "image/png" }]),
          { status: 200 },
        ),
      );
      await vi.waitFor(async () => {
        const saved = JSON.parse(
          await readFile(join(marketplaceRoot, "marketplace.json"), "utf8"),
        ) as { plugins: Array<{ icon?: string }> };
        expect(saved.plugins[0]?.icon).toBe(
          "https://cdn-zcode.z.ai/zcode/official-plugin/assets/figma/icon.png",
        );
      });
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("declares the ui component type exactly for bundled plugins with UI surfaces", async () => {
    const packagesRoot = fileURLToPath(new URL("../../", import.meta.url));

    for (const plugin of OFFICIAL_PLUGIN_DEFINITIONS) {
      const packageRoot = join(packagesRoot, basename(plugin.rootCandidates[0] ?? ""));
      const pluginManifest = JSON.parse(
        await readFile(join(packageRoot, ".zcode-plugin", "plugin.json"), "utf8"),
      ) as { ui?: { surfaces?: unknown[] } };
      // 卸载后的可恢复条目没有运行时信息，商店只能靠定义里的 componentTypes 归入「UI 插件」。
      expect(plugin.componentTypes?.includes("ui") ?? false, plugin.name).toBe(
        (pluginManifest.ui?.surfaces?.length ?? 0) > 0,
      );
    }
  });

  it("rejects an incomplete Browser Use filesystem or SEA seed", () => {
    const browserUse = OFFICIAL_PLUGIN_DEFINITIONS.find((plugin) => plugin.name === "browser-use");
    if (!browserUse) throw new Error("missing Browser Use official plugin definition");
    expect(browserUse.requiredSeedPaths).toEqual(OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS);
    expect(browserUse.requiredSeedPaths).toContain("docs/recording.md");
    expect(
      findMissingOfficialPluginSeedPaths(browserUse, [
        ...OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS.slice(0, -1).map((path) => ({ path })),
      ]),
    ).toEqual([OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS.at(-1)]);
  });

  it.each([undefined, true, false])(
    "resolves design default and explicit preference: %s",
    async (enabled) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-design-default-"));
      try {
        const userConfigPath = join(root, "config.json");
        await writeFile(
          userConfigPath,
          JSON.stringify({
            plugins: {
              enabledPlugins:
                enabled === undefined ? {} : { "design@zcode-plugins-official": enabled },
            },
          }),
        );
        const outcome = await resolveZCodePlugins({
          env: {},
          pluginStorageRoot: join(root, "plugins"),
          userConfigPath,
          workingDirectory: root,
        });
        const design = outcome.plugins.find(
          (plugin) => plugin.id === "design@zcode-plugins-official",
        );
        expect(design).toBeDefined();
        expect(design?.enabled).toBe(enabled === true);
        expect(
          outcome.skillRoots.some(
            (skillRoot) => skillRoot.pluginId === "design@zcode-plugins-official",
          ),
        ).toBe(enabled === true);
        expect(
          outcome.hooks.SessionStart?.some((matcher) =>
            matcher.hooks.some((hook) => hook.plugin?.id === "design@zcode-plugins-official"),
          ) ?? false,
        ).toBe(enabled === true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("can disable one document plugin without disabling the other formats or search", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-document-toggle-"));
    try {
      const userConfigPath = join(root, "config.json");
      await writeFile(
        userConfigPath,
        JSON.stringify({
          plugins: { enabledPlugins: { "documents@zcode-plugins-official": false } },
        }),
      );
      const outcome = await resolveZCodePlugins({
        env: {},
        pluginStorageRoot: join(root, "plugins"),
        userConfigPath,
        workingDirectory: root,
      });
      expect(outcome.plugins.find((plugin) => plugin.name === "documents")?.enabled).toBe(false);
      for (const name of ["pdf", "presentations", "spreadsheets", "image-search"])
        expect(outcome.plugins.find((plugin) => plugin.name === name)?.enabled).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps same-name marketplace listings isolated by stable plugin id", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-plugin-listing-id-"));
    const pluginStorageRoot = join(root, "plugins");

    try {
      await writeKnownMarketplaces(pluginStorageRoot, [
        {
          id: "custom-marketplace",
          source: { source: "directory", path: root },
          name: "custom-marketplace",
          addedAt: "2026-08-23T00:00:00.000Z",
          pluginCount: 1,
        },
      ]);
      await writeTestFile(
        join(pluginStorageRoot, "marketplaces", "custom-marketplace", "marketplace.json"),
        JSON.stringify({
          name: "custom-marketplace",
          plugins: [
            {
              name: "computer-use",
              displayName: "Custom Computer Use",
              displayName_i18n: { "zh-CN": "自定义电脑控制" },
            },
          ],
        }),
      );

      const outcome = await listZCodePlugins({
        env: {},
        pluginStorageRoot,
        skipUserConfig: true,
        workingDirectory: root,
      });

      expect(outcome.pluginListingsById?.["computer-use@zcode-plugins-official"]).toMatchObject({
        displayName: "Computer Use",
      });
      expect(outcome.pluginListingsById?.["computer-use@custom-marketplace"]).toMatchObject({
        displayName: "Custom Computer Use",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps the catalog and immutable cache for suppressed built-ins", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-suppressed-"));

    try {
      const pluginStorageRoot = join(root, "plugins");

      // First seed normally so the cache dir exists.
      await resolveOfficialPluginRoots({ storageRoot: pluginStorageRoot });
      const seededDir = join(pluginStorageRoot, OFFICIAL_SKILL_CREATOR_PLUGIN_CACHE_PATH);
      await stat(seededDir); // exists

      // Now suppress it and re-resolve.
      await resolveOfficialPluginRoots({
        storageRoot: pluginStorageRoot,
        suppressedBuiltins: new Set([SKILL_CREATOR_PLUGIN_ID]),
      });

      // 卸载只改变 Runtime 抑制态；Catalog 和不可变 cache 仍供详情页读取。
      await expect(stat(seededDir)).resolves.toBeDefined();

      // Synthetic marketplace.json 保留被抑制插件，避免详情请求变成 plugin_not_found。
      const manifest = JSON.parse(
        await readFile(
          join(pluginStorageRoot, "marketplaces", "zcode-plugins-official", "marketplace.json"),
          "utf8",
        ),
      );
      expect(
        manifest.plugins.find((p: { name: string }) => p.name === "skill-creator"),
      ).toMatchObject({
        source: "filesystem",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("marks update-available when a newer version exists in the manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-update-detect-"));
    const pluginStorageRoot = join(root, "plugins");
    const marketplaceRoot = join(root, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "demo");
    const configPath = join(root, "config.json");

    try {
      // Arrange a directory marketplace whose plugin declares v1, and install it so
      // installed_plugins.json records version 1.0.0.
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

      await installZCodeMarketplacePlugin({
        marketplace: "lazy-market",
        pluginName: "demo",
        pluginStorageRoot,
        userConfigPath: configPath,
        workingDirectory: root,
      });

      // Now advertise a higher version (2.0.0) in the persisted marketplace manifest,
      // simulating an upstream release the installed copy hasn't caught up to.
      const manifestPath = join(
        pluginStorageRoot,
        "marketplaces",
        "lazy-market",
        "marketplace.json",
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        name: string;
        plugins: Array<{ name: string; version?: string }>;
      };
      for (const entry of manifest.plugins) {
        if (entry.name === "demo") entry.version = "2.0.0";
      }
      await writeFile(manifestPath, JSON.stringify(manifest));

      const overview = await getZCodePluginsOverview({
        pluginStorageRoot,
        userConfigPath: configPath,
        workingDirectory: root,
      });
      const target = overview.installedPlugins.find((p) => p.id === "demo@lazy-market");
      expect(target?.updateStatus).toBe("update-available");
      expect(target?.latestVersion).toBe("2.0.0");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  // The Claude-official shape: entries pin a commit sha (no top-level version). Detection must
  // compare installed record.source.sha vs manifest entry.source.sha, not entry.version.
  // (docs/plugin-marketplace-update-detection-handoff.md)
  it("marks update-available via source.sha when the manifest entry has no version", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-update-sha-"));
    const pluginStorageRoot = join(root, "plugins");
    const configPath = join(root, "config.json");

    try {
      await writeKnownMarketplaces(pluginStorageRoot, [
        {
          id: "sha-market",
          source: { source: "directory", path: join(root, "src") },
          name: "sha-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 1,
        },
      ]);
      // Persisted manifest pins a NEW sha, no version (mirrors a git-subdir official entry).
      await writeTestFile(
        join(pluginStorageRoot, "marketplaces", "sha-market", "marketplace.json"),
        JSON.stringify({
          name: "sha-market",
          plugins: [
            {
              name: "demo",
              source: {
                source: "git-subdir",
                url: "https://example.test/x.git",
                path: "p",
                sha: "newsha1234567890",
              },
            },
          ],
        }),
      );
      // Installed record snapshot carries the OLD sha.
      await writeTestFile(
        join(pluginStorageRoot, "installed_plugins.json"),
        JSON.stringify({
          plugins: [
            {
              id: "demo@sha-market",
              name: "demo",
              marketplace: "sha-market",
              version: "0.0.0",
              installPath: join(pluginStorageRoot, "cache", "sha-market", "demo", "0.0.0"),
              installedAt: "2026-01-01T00:00:00.000Z",
              scope: "user",
              source: {
                source: "git-subdir",
                url: "https://example.test/x.git",
                path: "p",
                sha: "oldsha0987654321",
              },
            },
          ],
        }),
      );

      const overview = await getZCodePluginsOverview({
        pluginStorageRoot,
        userConfigPath: configPath,
        workingDirectory: root,
      });
      const target = overview.installedPlugins.find((p) => p.id === "demo@sha-market");
      expect(target?.updateStatus).toBe("update-available");
      expect(target?.latestVersion).toBe("newsha1"); // short 7-char sha label
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("marks update-available via zip source sha256 when the manifest entry has no version", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-update-zip-sha-"));
    const pluginStorageRoot = join(root, "plugins");
    const configPath = join(root, "config.json");

    try {
      await writeKnownMarketplaces(pluginStorageRoot, [
        {
          id: "zip-market",
          source: { source: "directory", path: join(root, "src") },
          name: "zip-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 1,
        },
      ]);
      await writeTestFile(
        join(pluginStorageRoot, "marketplaces", "zip-market", "marketplace.json"),
        JSON.stringify({
          name: "zip-market",
          plugins: [
            {
              name: "demo",
              source: {
                source: "url",
                type: "zip",
                url: "https://cdn.example.test/demo.zip",
                sha256: `${"b".repeat(64)}`,
              },
            },
          ],
        }),
      );
      await writeTestFile(
        join(pluginStorageRoot, "installed_plugins.json"),
        JSON.stringify({
          plugins: [
            {
              id: "demo@zip-market",
              name: "demo",
              marketplace: "zip-market",
              version: "0.0.0",
              installPath: join(pluginStorageRoot, "cache", "zip-market", "demo", "0.0.0"),
              installedAt: "2026-01-01T00:00:00.000Z",
              scope: "user",
              source: {
                source: "url",
                type: "zip",
                url: "https://cdn.example.test/demo.zip",
                sha256: `${"a".repeat(64)}`,
              },
            },
          ],
        }),
      );

      const overview = await getZCodePluginsOverview({
        pluginStorageRoot,
        userConfigPath: configPath,
        workingDirectory: root,
      });
      const target = overview.installedPlugins.find((p) => p.id === "demo@zip-market");
      expect(target?.updateStatus).toBe("update-available");
      expect(target?.latestVersion).toBe("bbbbbbb");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("lists suppressed official plugins as restorable built-ins", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-restorable-"));
    const pluginStorageRoot = join(root, "plugins");
    const userConfigPath = join(root, "config.json");

    try {
      await writeFile(
        userConfigPath,
        JSON.stringify({
          plugins: {
            enabled: true,
            suppressedBuiltins: [SKILL_CREATOR_PLUGIN_ID],
          },
        }),
      );

      const overview = await getZCodePluginsOverview({
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      expect(overview.restorableBuiltins.map((p) => p.id)).toContain(SKILL_CREATOR_PLUGIN_ID);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps the ui component type on a suppressed bundled document plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-restorable-ui-"));
    const pluginStorageRoot = join(root, "plugins");
    const userConfigPath = join(root, "config.json");
    const documentsId = "documents@zcode-plugins-official";

    try {
      await writeFile(
        userConfigPath,
        JSON.stringify({ plugins: { enabled: true, suppressedBuiltins: [documentsId] } }),
      );
      const overview = await getZCodePluginsOverview({
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      // UI 合并时优先保留目录条目的 summary，所以目录条目与可恢复条目都必须带 "ui"。
      expect(
        overview.availablePlugins.find((plugin) => plugin.id === documentsId)?.componentTypes,
      ).toContain("ui");
      expect(
        overview.restorableBuiltins.find((plugin) => plugin.id === documentsId)?.componentTypes,
      ).toEqual(["ui"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("includes the merged ZCode official marketplace and Claude marketplace for empty storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-default-marketplace-"));

    try {
      const pluginStorageRoot = join(root, "plugins");
      const overview = await getZCodePluginsOverview({
        env: {},
        pluginStorageRoot,
        skipUserConfig: true,
        workingDirectory: root,
      });

      expect(overview.marketplaces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "zcode-plugins-official",
            isOfficial: true,
            name: "zcode-plugins-official",
            pluginCount: 16,
            source: {
              source: "url",
              url: "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
            },
          }),
          expect.objectContaining({
            id: "claude-plugins-official",
            isOfficial: true,
            name: "claude-plugins-official",
            pluginCount: 0,
            source: {
              repo: "anthropics/claude-plugins-official",
              source: "github",
            },
          }),
        ]),
      );
      expect(
        JSON.parse(await readFile(join(pluginStorageRoot, "known_marketplaces.json"), "utf8")),
      ).toMatchObject({
        marketplaces: [
          expect.objectContaining({
            id: "zcode-plugins-official",
          }),
          expect.objectContaining({
            id: "claude-plugins-official",
          }),
        ],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("installs from a known marketplace by lazy-loading its missing manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-lazy-marketplace-install-"));
    const pluginStorageRoot = join(root, "plugins");
    const marketplaceRoot = join(root, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "hello");

    try {
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
          plugins: [
            {
              name: "hello",
              source: "./plugins/hello",
              componentTypes: ["ui"],
              publisherType: "community",
            },
          ],
        }),
      );
      await writeTestFile(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({
          name: "hello",
          skills: "skills",
          mcpServers: { panel: { command: "node", args: ["panel.mjs"] } },
          ui: {
            surfaces: [
              {
                id: "panel",
                title: "Panel",
                server: "panel",
                resourceUri: "ui://hello/panel",
                availability: "session",
              },
            ],
          },
        }),
      );
      await writeTestFile(join(pluginRoot, "skills", "hello", "SKILL.md"), "# hello");
      await writeTestFile(join(pluginRoot, "agents", "judge.md"), "---\nname: judge\n---\n");

      const configPath = join(root, "config.json");
      const result = await installZCodeMarketplacePlugin({
        marketplace: "lazy-market",
        pluginName: "hello",
        pluginStorageRoot,
        userConfigPath: configPath,
        workingDirectory: root,
      });

      expect(result.diagnostics).toEqual([]);
      expect(result.dependencyClosure).toEqual(["hello@lazy-market"]);
      expect(result.installedPlugins[0]).toMatchObject({
        id: "hello@lazy-market",
        marketplace: "lazy-market",
        // 安装即默认启用：新装插件应直接 enabled，无需再手动开。
        enabled: true,
      });
      const overview = await getZCodePluginsOverview({
        pluginStorageRoot,
        userConfigPath: configPath,
        workingDirectory: root,
      });
      expect(overview.installedPlugins[0]?.componentTypes).toEqual(
        expect.arrayContaining(["agent", "skill", "mcp", "ui"]),
      );
      expect(
        overview.availablePlugins.find((plugin) => plugin.id === "hello@lazy-market"),
      ).toMatchObject({ componentTypes: ["ui"], listing: { publisherType: "community" } });
      await expect(
        readFile(
          join(pluginStorageRoot, "marketplaces", "lazy-market", "marketplace.json"),
          "utf8",
        ),
      ).resolves.toContain("lazy-market");
      // 默认启用应落到用户配置 enabledPlugins。
      const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
        plugins?: { enabledPlugins?: Record<string, boolean> };
      };
      expect(persisted.plugins?.enabledPlugins?.["hello@lazy-market"]).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("两个独立 CLI 同时安装到同一个 Host 时，缓存、安装记录和默认启用项均保留", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-processes-"));
    const pluginStorageRoot = join(root, "plugins");
    const userConfigPath = join(root, "config.json");
    const names = ["first", "second"];
    const archives = names.map((name) =>
      createStoredZip([
        {
          path: `${name}/.zcode-plugin/plugin.json`,
          content: JSON.stringify({ name, version: "1.0.0" }),
        },
      ]),
    );
    const firstDownload = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = createServer(async (req, res) => {
      const index = req.url === "/first.zip" ? 0 : 1;
      if (index === 0) {
        firstDownload.resolve();
        await release.promise;
      }
      res.end(archives[index]);
    });
    const workers: Promise<unknown>[] = [];
    try {
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing fixture port");
      await writeTestFile(
        join(pluginStorageRoot, "marketplaces", "fixture", "marketplace.json"),
        JSON.stringify({
          name: "fixture",
          plugins: names.map((name, i) => ({
            name,
            source: {
              source: "url",
              type: "zip",
              url: `http://127.0.0.1:${address.port}/${name}.zip`,
              sha256: hashBytes(archives[i]!),
            },
          })),
        }),
      );
      await Promise.all(names.map((name) => mkdir(join(root, name))));
      const install = (name: string) => {
        const run = promisify(execFile)(process.execPath, [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `const { installZCodeMarketplacePlugin } = await import(process.argv[1]);
          const options = JSON.parse(process.argv[2]);
          process.stdout.write("ready\\n");
          const result = await installZCodeMarketplacePlugin(options);
          if (result.installedPlugins.length !== 1) throw new Error(JSON.stringify(result));`,
          new URL("../src/plugins.ts", import.meta.url).href,
          JSON.stringify({
            pluginName: name,
            marketplace: "fixture",
            pluginStorageRoot,
            userConfigPath,
            workingDirectory: join(root, name),
          }),
        ]);
        workers.push(run);
        return run;
      };
      const first = install("first");
      await Promise.race([
        firstDownload.promise,
        first.then(() => {
          throw new Error("first installation did not fetch the archive");
        }),
      ]);
      const second = install("second");
      const ready = new Promise<void>((done) => second.child.stdout!.once("data", () => done()));
      await Promise.race([ready, second]);
      // 第一个 writer 已读库存；给第二个真实进程机会完成安装，再放行第一个下载。
      await Promise.race([second, delay(500)]);
      release.resolve();
      await Promise.all(workers);
      const state = JSON.parse(
        await readFile(join(pluginStorageRoot, "installed_plugins.json"), "utf8"),
      );
      expect(state.plugins.map((p: { id: string }) => p.id).sort()).toEqual(
        names.map((n) => `${n}@fixture`),
      );
      for (const record of state.plugins) {
        expect(
          JSON.parse(
            await readFile(join(record.installPath, ".zcode-plugin", "plugin.json"), "utf8"),
          ).name,
        ).toBe(record.name);
      }
      expect(JSON.parse(await readFile(userConfigPath, "utf8")).plugins.enabledPlugins).toEqual({
        "first@fixture": true,
        "second@fixture": true,
      });
    } finally {
      release.resolve();
      await Promise.allSettled(workers);
      await closeServer(server);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("installs and enables a marketplace plugin from a zip URL source through the facade", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-zip-marketplace-install-"));
    const pluginStorageRoot = join(root, "plugins");
    const marketplaceRoot = join(root, "marketplace");
    const configPath = join(root, "config.json");
    let server: Server | undefined;

    try {
      const zipBuffer = createStoredZip([
        {
          path: "hello-zip/.claude-plugin/plugin.json",
          content: JSON.stringify({
            name: "hello-zip",
            skills: "skills",
            version: "4.5.6",
          }),
        },
        {
          path: "hello-zip/skills/hello/SKILL.md",
          content: "# hello zip\n",
        },
        {
          path: "hello-zip/agents/judge.md",
          content: "---\nname: judge\n---\n",
        },
      ]);
      const fixture = await startZipFixtureServer({
        "/hello-zip.zip": zipBuffer,
      });
      server = fixture.server;
      await writeKnownMarketplaces(pluginStorageRoot, [
        {
          id: "zip-lazy-market",
          source: { source: "directory", path: marketplaceRoot },
          name: "zip-lazy-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 0,
        },
      ]);
      await writeTestFile(
        join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "zip-lazy-market",
          plugins: [
            {
              name: "hello-zip",
              source: {
                source: "url",
                type: "zip",
                url: `${fixture.baseUrl}/hello-zip.zip`,
                sha256: hashBytes(zipBuffer),
              },
            },
          ],
        }),
      );

      const result = await installZCodeMarketplacePlugin({
        marketplace: "zip-lazy-market",
        pluginName: "hello-zip",
        pluginStorageRoot,
        userConfigPath: configPath,
        workingDirectory: root,
      });

      expect(result.diagnostics).toEqual([]);
      expect(result.dependencyClosure).toEqual(["hello-zip@zip-lazy-market"]);
      expect(result.installedPlugins[0]).toMatchObject({
        enabled: true,
        id: "hello-zip@zip-lazy-market",
        marketplace: "zip-lazy-market",
        version: "4.5.6",
      });
      expect(result.installedPlugins[0]?.installPath).toContain(
        join("cache", "zip-lazy-market", "hello-zip", "4.5.6"),
      );
      expect(
        existsSync(join(result.installedPlugins[0]?.installPath ?? "", "agents", "judge.md")),
      ).toBe(true);

      const overviewResult = await getZCodePluginsOverview({
        pluginStorageRoot,
        userConfigPath: configPath,
        workingDirectory: root,
      });
      expect(
        overviewResult.installedPlugins.find((item) => item.id === "hello-zip@zip-lazy-market"),
      ).toMatchObject({
        componentTypes: expect.arrayContaining(["agent", "skill"]),
        enabled: true,
        version: "4.5.6",
      });
    } finally {
      await closeServer(server);
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each(["user", "workspace"] as const)(
    "preserves an explicit %s disable when installing a plugin",
    async (scope) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-reinstall-disabled-"));
      const pluginStorageRoot = join(root, "plugins");
      const marketplaceRoot = join(root, "marketplace");
      const pluginRoot = join(marketplaceRoot, "plugins", "hello");
      const configPath = join(root, "config.json");

      try {
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
            plugins: [{ name: "hello", source: "./plugins/hello" }],
          }),
        );
        await writeTestFile(
          join(pluginRoot, ".claude-plugin", "plugin.json"),
          JSON.stringify({ name: "hello", skills: "skills" }),
        );
        await writeTestFile(join(pluginRoot, "skills", "hello", "SKILL.md"), "# hello");
        // User 安装不能覆盖 User 或 Workspace 已有的禁用选择。
        const projectConfigPath = join(root, ".zcode", "config.json");
        const overridePath = scope === "user" ? configPath : projectConfigPath;
        await writeTestFile(
          overridePath,
          JSON.stringify({
            plugins: { enabledPlugins: { "hello@lazy-market": false } },
          }),
        );

        const result = await installZCodeMarketplacePlugin({
          marketplace: "lazy-market",
          pluginName: "hello",
          pluginStorageRoot,
          userConfigPath: configPath,
          workingDirectory: root,
        });

        expect(result.installedPlugins[0]?.id).toBe("hello@lazy-market");
        if (scope === "user") expect(result.installedPlugins[0]?.enabled).toBe(false);
        const { plugins } = await resolveZCodePlugins({
          pluginStorageRoot,
          projectConfigPath,
          userConfigPath: configPath,
          workingDirectory: root,
        });
        expect(plugins.find((plugin) => plugin.id === "hello@lazy-market")?.enabled).toBe(false);
        const persisted = JSON.parse(await readFile(overridePath, "utf8")) as {
          plugins?: { enabledPlugins?: Record<string, boolean> };
        };
        expect(persisted.plugins?.enabledPlugins?.["hello@lazy-market"]).toBe(false);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  it("thoroughly uninstalls a plugin and prunes its user config footprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-uninstall-"));
    const pluginStorageRoot = join(root, "plugins");
    const marketplaceRoot = join(root, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "hello");
    const configPath = join(root, "config.json");

    try {
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
          plugins: [{ name: "hello", source: "./plugins/hello" }],
        }),
      );
      await writeTestFile(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "hello", skills: "skills" }),
      );
      await writeTestFile(join(pluginRoot, "skills", "hello", "SKILL.md"), "# hello");

      const installed = await installZCodeMarketplacePlugin({
        marketplace: "lazy-market",
        pluginName: "hello",
        pluginStorageRoot,
        userConfigPath: configPath,
        workingDirectory: root,
      });
      const installPath = installed.installedPlugins[0]?.installPath ?? "";
      expect(existsSync(installPath)).toBe(true);

      // 预置 user config 里的启用标记/选项与运行期 data 目录，验证卸载会一并清掉。
      await writeTestFile(
        configPath,
        JSON.stringify({
          plugins: {
            enabledPlugins: {
              "hello@lazy-market": true,
              "keep@lazy-market": true,
            },
            options: { "hello@lazy-market": { foo: "bar" } },
          },
        }),
      );
      const dataDir = join(pluginStorageRoot, "data", "hello@lazy-market");
      await mkdir(dataDir, { recursive: true });
      await writeTestFile(join(dataDir, "generated-commands", "demo.md"), "# demo");

      const removed = await uninstallZCodeMarketplacePlugin({
        pluginId: "hello@lazy-market",
        pluginStorageRoot,
        userConfigPath: configPath,
        skipUserConfig: false,
        workingDirectory: root,
      });

      expect(removed?.id).toBe("hello@lazy-market");
      expect(existsSync(installPath)).toBe(false);
      expect(existsSync(dataDir)).toBe(false);

      const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
        plugins: {
          enabledPlugins: Record<string, boolean>;
          options: Record<string, unknown>;
        };
      };
      expect(parsed.plugins.enabledPlugins).toEqual({
        "keep@lazy-market": true,
      });
      expect(parsed.plugins.options).toEqual({});
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("treats an installed official-CDN cache entry as marketplace-owned during uninstall", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-uninstall-official-cdn-"));
    const pluginStorageRoot = join(root, "plugins");
    const userConfigPath = join(root, "config.json");
    const pluginId = "example-plugin@zcode-plugins-official";
    const installPath = join(
      pluginStorageRoot,
      "cache",
      "zcode-plugins-official",
      "example-plugin",
      "0.2.0",
    );

    try {
      await writeTestFile(
        join(installPath, ".zcode-plugin", "plugin.json"),
        JSON.stringify({
          name: "example-plugin",
          version: "0.2.0",
          skills: "skills",
        }),
      );
      await writeTestFile(join(installPath, "skills", "example", "SKILL.md"), "# example");
      await writeTestFile(
        join(pluginStorageRoot, "installed_plugins.json"),
        JSON.stringify({
          version: 1,
          plugins: [
            {
              id: pluginId,
              name: "example-plugin",
              marketplace: "zcode-plugins-official",
              version: "0.2.0",
              installPath,
              installedAt: "2026-07-15T00:00:00.000Z",
              updatedAt: "2026-07-15T00:00:00.000Z",
              scope: "user",
            },
          ],
        }),
      );
      await writeTestFile(
        userConfigPath,
        JSON.stringify({
          plugins: {
            enabledPlugins: { [pluginId]: true },
            options: { [pluginId]: { foo: "bar" } },
          },
        }),
      );

      const removed = await uninstallZCodeMarketplacePlugin({
        pluginId,
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });

      expect(removed?.id).toBe(pluginId);
      expect(existsSync(installPath)).toBe(false);
      const installedState = JSON.parse(
        await readFile(join(pluginStorageRoot, "installed_plugins.json"), "utf8"),
      );
      expect(installedState.plugins).toEqual([]);
      const config = JSON.parse(await readFile(userConfigPath, "utf8"));
      expect(config.plugins.suppressedBuiltins ?? []).not.toContain(pluginId);
      expect(config.plugins.enabledPlugins?.[pluginId]).toBeUndefined();
      expect(config.plugins.options?.[pluginId]).toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("clears stale built-in suppression while removing an installed marketplace record", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-uninstall-stale-suppression-"));
    const pluginStorageRoot = join(root, "plugins");
    const userConfigPath = join(root, "config.json");
    const pluginId = "example-plugin@zcode-plugins-official";
    const installPath = join(
      pluginStorageRoot,
      "cache",
      "zcode-plugins-official",
      "example-plugin",
      "0.2.0",
    );

    try {
      await writeTestFile(
        join(installPath, ".zcode-plugin", "plugin.json"),
        JSON.stringify({ name: "example-plugin", version: "0.2.0" }),
      );
      await writeTestFile(
        join(pluginStorageRoot, "installed_plugins.json"),
        JSON.stringify({
          version: 1,
          plugins: [
            {
              id: pluginId,
              name: "example-plugin",
              marketplace: "zcode-plugins-official",
              version: "0.2.0",
              installPath,
              installedAt: "2026-07-15T00:00:00.000Z",
              updatedAt: "2026-07-15T00:00:00.000Z",
              scope: "user",
            },
          ],
        }),
      );
      await writeTestFile(
        userConfigPath,
        JSON.stringify({ plugins: { suppressedBuiltins: [pluginId] } }),
      );

      await uninstallZCodeMarketplacePlugin({
        pluginId,
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });

      const config = JSON.parse(await readFile(userConfigPath, "utf8"));
      expect(config.plugins.suppressedBuiltins ?? []).not.toContain(pluginId);
      const installedState = JSON.parse(
        await readFile(join(pluginStorageRoot, "installed_plugins.json"), "utf8"),
      );
      expect(installedState.plugins).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uninstalls a built-in by suppressing it and purging config", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-uninstall-builtin-"));
    const pluginStorageRoot = join(root, "plugins");
    const userConfigPath = join(root, "config.json");

    try {
      await writeFile(
        userConfigPath,
        JSON.stringify({
          plugins: {
            enabled: true,
            enabledPlugins: { [SKILL_CREATOR_PLUGIN_ID]: true },
            options: { [SKILL_CREATOR_PLUGIN_ID]: { foo: "bar" } },
          },
        }),
      );

      // Seed first so its cache exists.
      await resolveZCodePlugins({
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      const cacheDir = join(pluginStorageRoot, OFFICIAL_SKILL_CREATOR_PLUGIN_CACHE_PATH);
      await stat(cacheDir);

      const removed = await uninstallZCodeMarketplacePlugin({
        pluginId: SKILL_CREATOR_PLUGIN_ID,
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      expect(removed?.id).toBe(SKILL_CREATOR_PLUGIN_ID);

      const config = JSON.parse(await readFile(userConfigPath, "utf8"));
      expect(config.plugins.suppressedBuiltins).toContain(SKILL_CREATOR_PLUGIN_ID);
      expect(config.plugins.enabledPlugins?.[SKILL_CREATOR_PLUGIN_ID]).toBeUndefined();
      expect(config.plugins.options?.[SKILL_CREATOR_PLUGIN_ID]).toBeUndefined();

      // Re-resolve: Runtime stays gone, but Catalog/cache remain readable for detail/restore.
      const outcome = await resolveZCodePlugins({
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      expect(outcome.plugins.find((p) => p.id === SKILL_CREATOR_PLUGIN_ID)).toBeUndefined();
      await expect(stat(cacheDir)).resolves.toBeDefined();

      const detail = await describeZCodePlugin({
        pluginName: "skill-creator",
        marketplace: "zcode-plugins-official",
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      expect(detail.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual(
        [],
      );
      expect(detail.components.length).toBeGreaterThan(0);

      // Double-uninstall is idempotent: an already-suppressed built-in is not resolved,
      // so it falls through to the marketplace path and returns null without throwing.
      const second = await uninstallZCodeMarketplacePlugin({
        pluginId: SKILL_CREATOR_PLUGIN_ID,
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      expect(second).toBeNull();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  // Finding #3: the in-session plugin facade caches config at construction time. Before the
  // fix it only refreshed enabledPlugins on uninstall, keeping the startup-time
  // suppressedBuiltins, so a built-in uninstalled via the facade re-appeared on the next
  // listPlugins() in the SAME process. The facade must also track suppressedBuiltins.
  it("keeps a built-in uninstalled within the same facade session", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-facade-uninstall-"));
    const pluginStorageRoot = join(root, "plugins");
    const userConfigPath = join(root, "config.json");

    try {
      await writeFile(userConfigPath, JSON.stringify({ plugins: { enabled: true } }));
      const configResult = createConfig({
        env: {},
        userConfigPath,
        workingDirectory: root,
      });
      const facade = createPluginFacadeForApp({
        configResult,
        options: { env: {}, pluginStorageRoot } as ZCodeAppOptions,
        workingDirectory: root,
      });

      const before = await facade.listPlugins();
      expect(before.plugins.find((item) => item.id === SKILL_CREATOR_PLUGIN_ID)).toBeDefined();

      const { removed } = await facade.uninstallPlugin(SKILL_CREATOR_PLUGIN_ID);
      expect(removed?.id).toBe(SKILL_CREATOR_PLUGIN_ID);

      // Same facade instance, subsequent list must not re-surface the uninstalled built-in.
      const after = await facade.listPlugins();
      expect(after.plugins.find((item) => item.id === SKILL_CREATOR_PLUGIN_ID)).toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each(["restore", "install", "prepare-failed"] as const)(
    "keeps suppression unchanged when %s cannot prepare plugins",
    async (entry) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-degraded-restore-"));
      const userConfigPath = join(root, "config.json");
      const before = JSON.stringify({
        plugins: { enabled: true, suppressedBuiltins: [SKILL_CREATOR_PLUGIN_ID] },
      });
      const pluginPreparation = createOfficialPluginPreparation(
        entry === "prepare-failed" ? undefined : { startupTimeoutMs: 0 },
      );
      try {
        if (entry === "prepare-failed")
          vi.spyOn(pluginPreparation, "prepare").mockRejectedValue(
            Object.assign(new Error("Plugin startup timed out"), {
              code: "ZCODE_PLUGIN_STARTUP_TIMEOUT",
            }),
          );
        else await pluginPreparation.resolvePlugins(() => new Promise(() => {}));
        await writeFile(userConfigPath, before);
        const options = {
          pluginPreparation,
          pluginStorageRoot: join(root, "plugins"),
          userConfigPath,
          workingDirectory: root,
        };
        const catalog = join(options.pluginStorageRoot, "marketplaces", "zcode-plugins-official");
        await mkdir(catalog, { recursive: true });
        await writeFile(
          join(catalog, "marketplace.json"),
          JSON.stringify({
            name: "zcode-plugins-official",
            plugins: [{ name: "skill-creator", source: "filesystem" }],
          }),
        );
        const restore =
          entry !== "install"
            ? restoreBuiltinPlugin({ ...options, pluginId: SKILL_CREATOR_PLUGIN_ID })
            : installZCodeMarketplacePlugin({
                ...options,
                marketplace: "zcode-plugins-official",
                pluginName: "skill-creator",
              });
        await expect(restore).rejects.toMatchObject({ code: "ZCODE_PLUGIN_STARTUP_TIMEOUT" });
        expect(await readFile(userConfigPath, "utf8")).toBe(before);
        expect(existsSync(join(options.pluginStorageRoot, "installed_plugins.json"))).toBe(false);
      } finally {
        await pluginPreparation.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("restores a suppressed built-in so it re-seeds on next resolve", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-restore-builtin-"));
    const pluginStorageRoot = join(root, "plugins");
    const userConfigPath = join(root, "config.json");

    try {
      await writeFile(
        userConfigPath,
        JSON.stringify({
          plugins: {
            enabled: true,
            suppressedBuiltins: [SKILL_CREATOR_PLUGIN_ID],
          },
        }),
      );

      // Suppressed: not present.
      let outcome = await resolveZCodePlugins({
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      expect(outcome.plugins.find((p) => p.id === SKILL_CREATOR_PLUGIN_ID)).toBeUndefined();

      await restoreBuiltinPlugin({
        pluginId: SKILL_CREATOR_PLUGIN_ID,
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });

      const config = JSON.parse(await readFile(userConfigPath, "utf8"));
      expect(config.plugins.suppressedBuiltins ?? []).not.toContain(SKILL_CREATOR_PLUGIN_ID);

      outcome = await resolveZCodePlugins({
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      expect(outcome.plugins.find((p) => p.id === SKILL_CREATOR_PLUGIN_ID)).toBeDefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("routes a direct install of a suppressed bundled plugin to restore without creating a marketplace record", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-install-bundled-restore-"));
    const pluginStorageRoot = join(root, "plugins");
    const userConfigPath = join(root, "config.json");

    try {
      await writeFile(
        userConfigPath,
        JSON.stringify({
          plugins: {
            enabled: true,
            suppressedBuiltins: [SKILL_CREATOR_PLUGIN_ID],
          },
        }),
      );

      // 先写入完整 Catalog/cache，模拟详情页仍可见但 Runtime 被抑制的状态。
      await resolveZCodePlugins({
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });

      const result = await installZCodeMarketplacePlugin({
        marketplace: "zcode-plugins-official",
        pluginName: "skill-creator",
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });

      expect(result.diagnostics).toEqual([]);
      expect(result.installedPlugins.map((plugin) => plugin.id)).toEqual([SKILL_CREATOR_PLUGIN_ID]);
      expect(existsSync(join(pluginStorageRoot, "installed_plugins.json"))).toBe(false);
      expect(JSON.parse(await readFile(userConfigPath, "utf8"))).not.toMatchObject({
        plugins: { suppressedBuiltins: [SKILL_CREATOR_PLUGIN_ID] },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("clears stale builtin suppression when an official CDN entry with the same id is installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-cdn-suppression-"));
    const pluginStorageRoot = join(root, "plugins");
    const userConfigPath = join(root, "config.json");
    const cdnSourceRoot = join(root, "cdn-documents");

    try {
      await writeFile(
        userConfigPath,
        JSON.stringify({
          plugins: {
            enabled: true,
            suppressedBuiltins: [DOCUMENTS_PLUGIN_ID],
          },
        }),
      );
      await mkdir(join(cdnSourceRoot, ".zcode-plugin"), { recursive: true });
      await writeFile(
        join(cdnSourceRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({
          name: "documents",
          version: "1.0.0",
          skills: "skills",
        }),
      );
      await mkdir(join(cdnSourceRoot, "skills", "documents"), {
        recursive: true,
      });
      await writeFile(
        join(cdnSourceRoot, "skills", "documents", "SKILL.md"),
        "# Document Skills\n",
      );

      await resolveZCodePlugins({
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      const manifestPath = join(
        pluginStorageRoot,
        "marketplaces",
        "zcode-plugins-official",
        "marketplace.json",
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        plugins: Array<Record<string, unknown>>;
      };
      const entry = manifest.plugins.find((plugin) => plugin.name === "documents");
      expect(entry).toBeDefined();
      entry!.source = { source: "directory", path: cdnSourceRoot };
      entry!.version = "1.0.0";
      await writeFile(manifestPath, JSON.stringify(manifest));

      const result = await installZCodeMarketplacePlugin({
        marketplace: "zcode-plugins-official",
        pluginName: "documents",
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      expect(result.diagnostics).toEqual([]);

      const config = JSON.parse(await readFile(userConfigPath, "utf8")) as {
        plugins?: { suppressedBuiltins?: string[] };
      };
      expect(config.plugins?.suppressedBuiltins ?? []).not.toContain(DOCUMENTS_PLUGIN_ID);
      expect(existsSync(join(pluginStorageRoot, "installed_plugins.json"))).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("returns null when uninstalling a plugin that is not installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-uninstall-missing-"));
    const pluginStorageRoot = join(root, "plugins");

    try {
      const removed = await uninstallZCodeMarketplacePlugin({
        pluginId: "missing@lazy-market",
        pluginStorageRoot,
        skipUserConfig: true,
        workingDirectory: root,
      });
      expect(removed).toBeNull();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("returns diagnostics when lazy marketplace refresh fails during validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-lazy-marketplace-offline-"));
    const pluginStorageRoot = join(root, "plugins");

    try {
      await writeKnownMarketplaces(pluginStorageRoot, [
        {
          id: "offline-market",
          source: {
            source: "directory",
            path: join(root, "missing-marketplace"),
          },
          name: "offline-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 0,
        },
      ]);

      const diagnostics = await validateZCodePlugin({
        marketplace: "offline-market",
        pluginName: "hello",
        pluginStorageRoot,
        workingDirectory: root,
      });

      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: "plugin_marketplace_invalid",
          pluginId: "hello@offline-market",
          severity: "error",
        }),
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("returns and persists marketplace refresh diagnostics while keeping the last snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-marketplace-refresh-failure-"));
    const pluginStorageRoot = join(root, "plugins");
    const snapshotRoot = join(pluginStorageRoot, "marketplaces", "offline-market");

    try {
      await mkdir(snapshotRoot, { recursive: true });
      await writeFile(
        join(snapshotRoot, "marketplace.json"),
        JSON.stringify({
          name: "offline-market",
          plugins: [{ name: "cached", source: "./cached" }],
        }),
      );
      await writeKnownMarketplaces(pluginStorageRoot, [
        {
          id: "offline-market",
          source: {
            source: "directory",
            path: join(root, "missing-marketplace"),
          },
          name: "offline-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-02T00:00:00.000Z",
          pluginCount: 1,
        },
      ]);

      const update = await updateZCodePluginMarketplace({
        marketplace: "offline-market",
        pluginStorageRoot,
        workingDirectory: root,
      });
      const overview = await getZCodePluginsOverview({
        pluginStorageRoot,
        skipUserConfig: true,
        workingDirectory: root,
      });

      expect(update.marketplaces).toEqual([]);
      expect(update.diagnostics).toEqual([
        expect.objectContaining({
          code: "plugin_marketplace_invalid",
          pluginId: "offline-market",
          severity: "error",
        }),
      ]);
      expect(overview.marketplaces.find((item) => item.id === "offline-market")).toMatchObject({
        lastUpdated: "2026-01-02T00:00:00.000Z",
        pluginCount: 1,
        refreshFailure: {
          code: "plugin_marketplace_invalid",
          failedAt: expect.any(String),
        },
      });
      expect(overview.availablePlugins).toContainEqual(
        expect.objectContaining({ id: "cached@offline-market" }),
      );
      expect(overview.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "plugin_marketplace_invalid",
          pluginId: "offline-market",
        }),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("returns plugin_git_unavailable for an install source that requires system Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-plugin-git-unavailable-"));
    const pluginStorageRoot = join(root, "plugins");
    const snapshotRoot = join(pluginStorageRoot, "marketplaces", "private-market");

    try {
      await mkdir(snapshotRoot, { recursive: true });
      await writeFile(
        join(snapshotRoot, "marketplace.json"),
        JSON.stringify({
          name: "private-market",
          plugins: [
            {
              name: "private-plugin",
              source: {
                source: "git",
                url: "ssh://git@example.test/private/plugin.git",
              },
            },
          ],
        }),
      );
      await writeKnownMarketplaces(pluginStorageRoot, [
        {
          id: "private-market",
          source: { source: "directory", path: join(root, "unused") },
          name: "private-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 1,
        },
      ]);
      vi.stubEnv("PATH", join(root, "no-system-git"));

      const result = await installZCodeMarketplacePlugin({
        marketplace: "private-market",
        pluginName: "private-plugin",
        pluginStorageRoot,
        skipUserConfig: true,
        workingDirectory: root,
      });

      expect(result.installedPlugins).toEqual([]);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "plugin_git_unavailable",
          pluginId: "private-plugin@private-market",
          severity: "error",
        }),
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("preserves hook executable mode when rebuilding an older filesystem version", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-plugin-mode-reseed-"));
    const entryRoot = join(root, "resources", "glm");
    const pluginStorageRoot = join(root, "plugins");
    // 用仍登记的官方插件（skill-creator）做载体；文件全是 fixture 伪造的，
    // 真实 skill-creator 是否带 hook 无关紧要——seed 逻辑按伪造目录 reseed。
    const pluginRoot = join(entryRoot, "packages", "skill-creator-plugin");
    const targetRoot = join(pluginStorageRoot, OFFICIAL_SKILL_CREATOR_PLUGIN_CACHE_PATH);
    const originalEntrypoint = process.argv[1];

    try {
      await writeTestFile(join(entryRoot, "zcode.cjs"), "");
      await writeTestFile(
        join(pluginRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({
          name: "skill-creator",
          skills: "skills",
          version: "0.1.0",
        }),
      );
      await writeTestFile(join(pluginRoot, "hooks", "hooks.json"), "{}");
      await writeExecutableTestFile(
        join(pluginRoot, "hooks", "run-hook.cmd"),
        "#!/usr/bin/env bash\n",
      );
      await writeTestFile(join(pluginRoot, "skills", "skill-creator", "SKILL.md"), "# skill");

      await writeTestFile(
        join(targetRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({ name: "skill-creator" }),
      );
      await writeTestFile(join(targetRoot, "hooks", "run-hook.cmd"), "#!/usr/bin/env bash\n");
      await writeTestFile(
        join(targetRoot, ".zcode-plugin-seed.json"),
        JSON.stringify({
          marketplace: "zcode-plugins-official",
          plugin: "skill-creator",
          pluginVersion: "0.0.0",
          source: "filesystem",
          version: 1,
        }),
      );
      expect((await stat(join(targetRoot, "hooks", "run-hook.cmd"))).mode & 0o111).toBe(0);

      process.argv[1] = join(entryRoot, "zcode.cjs");
      await resolveOfficialPluginRoots({ storageRoot: pluginStorageRoot });

      expect((await stat(join(targetRoot, "hooks", "run-hook.cmd"))).mode & 0o111).not.toBe(0);
    } finally {
      process.argv[1] = originalEntrypoint;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("projects restore legacy sessions skills and commands only when enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-restore-plugin-enabled-"));
    const configPath = join(root, "config.json");
    const pluginStorageRoot = join(root, "plugins");

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            enabledPlugins: {
              [RESTORE_LEGACY_SESSIONS_PLUGIN_ID]: true,
            },
          },
        }),
      );

      const outcome = await resolveZCodePlugins({
        env: {},
        pluginStorageRoot,
        userConfigPath: configPath,
        workingDirectory: root,
      });
      const plugin = outcome.plugins.find((item) => item.id === RESTORE_LEGACY_SESSIONS_PLUGIN_ID);
      const expectedRoot = join(
        pluginStorageRoot,
        OFFICIAL_RESTORE_LEGACY_SESSIONS_PLUGIN_CACHE_PATH,
      );

      expect(plugin).toMatchObject({
        commandRootCount: 1,
        declaredMcpServerNames: [],
        enabled: true,
        mcpServerNames: [],
        name: "restore-legacy-sessions",
        rootPath: expectedRoot,
        skillCount: 1,
        skillRootCount: 1,
      });
      expect(outcome.skillRoots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: join(expectedRoot, "skills"),
            scope: "system",
            source: "plugin",
          }),
        ]),
      );
      expect(outcome.commandRoots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: join(expectedRoot, "commands"),
            scope: "system",
            source: "plugin",
          }),
        ]),
      );
      expect(Object.keys(outcome.mcpServers)).not.toContain("restore-legacy-sessions");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("projects bundled iOS simulator skills, commands, and MCP when enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-plugins-enabled-"));
    const configPath = join(root, "config.json");
    const pluginStorageRoot = join(root, "plugins");

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            enabledPlugins: {
              [IOS_SIMULATOR_PLUGIN_ID]: true,
            },
          },
        }),
      );

      const outcome = await resolveZCodePlugins({
        env: {},
        pluginStorageRoot,
        userConfigPath: configPath,
        workingDirectory: root,
      });
      const plugin = outcome.plugins.find((item) => item.id === IOS_SIMULATOR_PLUGIN_ID);
      const server = outcome.mcpServers[IOS_SIMULATOR_MCP_ID];
      const expectedRoot = join(pluginStorageRoot, OFFICIAL_PLUGIN_CACHE_PATH);

      expect(plugin).toMatchObject({
        commandRootCount: 1,
        declaredMcpServerNames: ["ios-simulator"],
        enabled: true,
        mcpServerNames: [IOS_SIMULATOR_MCP_ID],
        rootPath: expectedRoot,
        skillCount: 1,
        skillRootCount: 1,
      });
      expect(server).toMatchObject({
        command: process.execPath,
        type: "stdio",
        cwd: root,
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          IOS_SIM_DEFAULT_DEVICE: "iPhone 16",
          IOS_SIM_UI_BACKEND: "auto",
        },
      });
      expect(server?.args?.at(-2)).toBe(ZCODE_PLUGIN_HOST_COMMAND);
      expect(server?.args?.at(-1)).toContain(
        join(
          "cache",
          "zcode-plugins-official",
          "ios-simulator",
          "0.1.0",
          "dist",
          "mcp",
          "server.js",
        ),
      );
      await expect(
        readFile(
          join(pluginStorageRoot, "marketplaces", "zcode-plugins-official", "marketplace.json"),
          "utf8",
        ),
      ).resolves.toContain(IOS_SIMULATOR_PLUGIN_ID.split("@")[0] ?? "ios-simulator");
      expect(existsSync(join(expectedRoot, ".zcode-plugin-seed.json"))).toBe(true);
      expect(existsSync(join(expectedRoot, "dist", "mcp", "server.js"))).toBe(
        existsSync(BUNDLED_PLUGIN_DIST_PATH),
      );
      expect(outcome.diagnostics).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "plugin_unsupported_component",
            pluginId: IOS_SIMULATOR_PLUGIN_ID,
          }),
        ]),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("projects bundled Android emulator skills, commands, and MCP when enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-plugins-android-enabled-"));
    const configPath = join(root, "config.json");
    const pluginStorageRoot = join(root, "plugins");

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            enabledPlugins: {
              [ANDROID_EMULATOR_PLUGIN_ID]: true,
            },
            options: {
              [ANDROID_EMULATOR_PLUGIN_ID]: {
                api_level: "36",
                default_avd: "Pixel_8",
              },
            },
          },
        }),
      );

      const outcome = await resolveZCodePlugins({
        env: {},
        pluginStorageRoot,
        userConfigPath: configPath,
        workingDirectory: root,
      });
      const plugin = outcome.plugins.find((item) => item.id === ANDROID_EMULATOR_PLUGIN_ID);
      const server = outcome.mcpServers[ANDROID_EMULATOR_MCP_ID];
      const expectedRoot = join(pluginStorageRoot, OFFICIAL_ANDROID_PLUGIN_CACHE_PATH);

      expect(plugin).toMatchObject({
        commandRootCount: 1,
        declaredMcpServerNames: ["android-emulator"],
        enabled: true,
        mcpServerNames: [ANDROID_EMULATOR_MCP_ID],
        rootPath: expectedRoot,
        skillCount: 1,
        skillRootCount: 1,
      });
      expect(server).toMatchObject({
        command: process.execPath,
        type: "stdio",
        cwd: root,
        env: {
          ANDROID_PLUGIN_API_LEVEL: "36",
          ANDROID_PLUGIN_DEFAULT_AVD: "Pixel_8",
          ELECTRON_RUN_AS_NODE: "1",
        },
      });
      for (const unusedEnv of [
        "ANDROID_PLUGIN_ROOT",
        "ANDROID_PLUGIN_DEFAULT_PROFILE",
        "ANDROID_PLUGIN_WINDOWS_JDK_WINGET_PACKAGE",
        "ANDROID_PLUGIN_CMDLINE_TOOLS_VERSION",
        "ANDROID_PLUGIN_CMDLINE_TOOLS_CHECKSUM",
        "ANDROID_PLUGIN_CMDLINE_TOOLS_CHECKSUM_ALGORITHM",
      ]) {
        expect(server?.env).not.toHaveProperty(unusedEnv);
      }
      expect(server?.args?.at(-2)).toBe(ZCODE_PLUGIN_HOST_COMMAND);
      expect(server?.args?.at(-1)).toContain(
        join(
          "cache",
          "zcode-plugins-official",
          "android-emulator",
          "0.1.1",
          "dist",
          "mcp",
          "server.js",
        ),
      );
      expect(existsSync(join(expectedRoot, ".zcode-plugin-seed.json"))).toBe(true);
      expect(existsSync(join(expectedRoot, "dist", "mcp", "server.js"))).toBe(
        existsSync(BUNDLED_ANDROID_PLUGIN_DIST_PATH),
      );
      expect(outcome.diagnostics).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "plugin_unsupported_component",
            pluginId: ANDROID_EMULATOR_PLUGIN_ID,
          }),
        ]),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("persists sensitive plugin options in the selected User or Workspace config", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-plugin-options-"));
    const userConfigPath = join(root, "user-config.json");
    const workspaceConfigPath = join(root, ".zcode", "config.json");
    const pluginStorageRoot = join(root, "plugins");
    const pluginRoot = join(root, "secret-plugin");
    const pluginId = "secret-plugin@inline";

    try {
      await writeTestFile(
        join(pluginRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({
          name: "secret-plugin",
          userConfig: {
            token: {
              sensitive: true,
              type: "string",
            },
            region: {
              type: "string",
            },
          },
        }),
      );
      await writeTestFile(
        userConfigPath,
        JSON.stringify({
          plugins: {
            dirs: [pluginRoot],
          },
        }),
      );

      await configureZCodePlugin({
        options: { region: "us-east-1" },
        pluginId,
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      await configureZCodePlugin({
        options: { token: "secret" },
        pluginId,
        pluginStorageRoot,
        projectConfigPath: workspaceConfigPath,
        scope: "workspace",
        userConfigPath,
        workingDirectory: root,
      });
      expect(JSON.parse(await readFile(userConfigPath, "utf8"))).toMatchObject({
        plugins: { dirs: [pluginRoot] },
      });
      const reloadedConfig = createConfig({
        env: {},
        projectConfigPath: workspaceConfigPath,
        userConfigPath,
        workingDirectory: root,
      });
      expect(reloadedConfig.sources.plugins.dirs).toEqual({
        user: [pluginRoot],
        workspace: [],
      });
      expect(reloadedConfig.config.plugins.dirs).toEqual([pluginRoot]);
      expect(
        (
          await resolveZCodePlugins({
            configResult: reloadedConfig,
            pluginStorageRoot,
            workingDirectory: root,
          })
        ).plugins.map((plugin) => plugin.id),
      ).toContain(pluginId);
      await configureZCodePlugin({
        options: { region: "eu-west-1" },
        pluginId,
        pluginStorageRoot,
        projectConfigPath: workspaceConfigPath,
        scope: "workspace",
        userConfigPath,
        workingDirectory: root,
      });
      await setZCodePluginEnabled({
        enabled: true,
        plugin: pluginId,
        pluginStorageRoot,
        projectConfigPath: workspaceConfigPath,
        scope: "workspace",
        userConfigPath,
        workingDirectory: root,
      });
      await configureZCodePlugin({
        clearOptionKeys: ["token"],
        options: {},
        pluginId,
        pluginStorageRoot,
        projectConfigPath: workspaceConfigPath,
        scope: "workspace",
        userConfigPath,
        workingDirectory: root,
      });

      const userConfig = JSON.parse(await readFile(userConfigPath, "utf8")) as {
        plugins?: { options?: Record<string, Record<string, unknown>> };
      };
      const workspaceConfig = JSON.parse(await readFile(workspaceConfigPath, "utf8")) as {
        plugins?: {
          enabledPlugins?: Record<string, boolean>;
          options?: Record<string, Record<string, unknown>>;
        };
      };
      expect(userConfig.plugins?.options?.[pluginId]?.region).toBe("us-east-1");
      expect(userConfig.plugins?.options?.[pluginId]?.token).toBeUndefined();
      expect(workspaceConfig.plugins?.enabledPlugins?.[pluginId]).toBe(true);
      expect(workspaceConfig.plugins?.options?.[pluginId]?.token).toBeUndefined();
      expect(workspaceConfig.plugins?.options?.[pluginId]?.region).toBe("eu-west-1");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("writes Workspace enablement without mutating User config", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-plugin-scope-"));
    const userConfigPath = join(root, "user-config.json");
    const workspaceConfigPath = join(root, ".zcode", "config.json");
    const pluginStorageRoot = join(root, "plugins");
    const pluginRoot = join(root, "workspace-plugin");
    const pluginId = "workspace-plugin@inline";

    try {
      await writeTestFile(
        join(pluginRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({ name: "workspace-plugin", userConfig: {} }),
      );
      await writeTestFile(userConfigPath, JSON.stringify({ plugins: { dirs: [pluginRoot] } }));
      await writeTestFile(
        join(root, "zcode.json"),
        JSON.stringify({
          mcp: {
            servers: { keep: { type: "http", url: "https://example.test" } },
          },
        }),
      );

      const result = await setZCodePluginEnabled({
        enabled: true,
        plugin: pluginId,
        pluginStorageRoot,
        scope: "workspace",
        userConfigPath,
        workingDirectory: root,
      });

      expect(result.enabled).toBe(true);
      expect(JSON.parse(await readFile(userConfigPath, "utf8"))).toEqual({
        plugins: { dirs: [pluginRoot] },
      });
      expect(JSON.parse(await readFile(workspaceConfigPath, "utf8"))).toEqual({
        plugins: { enabledPlugins: { [pluginId]: true } },
      });
      expect(JSON.parse(await readFile(join(root, "zcode.json"), "utf8"))).toEqual({
        mcp: {
          servers: { keep: { type: "http", url: "https://example.test" } },
        },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("writes nested Workspace plugin state to the Workspace-owned config", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-nested-plugin-scope-"));
    const repositoryRoot = join(root, "repository");
    const workspaceRoot = join(repositoryRoot, "packages", "app");
    const repositoryConfigPath = join(repositoryRoot, ".zcode", "config.json");
    const workspaceConfigPath = join(workspaceRoot, ".zcode", "config.json");
    const userConfigPath = join(root, "user-config.json");
    const pluginRoot = join(root, "workspace-plugin");
    const pluginId = "workspace-plugin@inline";

    try {
      await mkdir(join(repositoryRoot, ".git"), { recursive: true });
      await writeTestFile(
        join(pluginRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({ name: "workspace-plugin", userConfig: {} }),
      );
      await writeTestFile(userConfigPath, JSON.stringify({ plugins: { dirs: [pluginRoot] } }));
      await writeTestFile(
        repositoryConfigPath,
        JSON.stringify({ plugins: { enabledPlugins: { [pluginId]: false } } }),
      );
      await writeTestFile(
        workspaceConfigPath,
        JSON.stringify({
          plugins: { options: { [pluginId]: { region: "nested" } } },
        }),
      );

      await setZCodePluginEnabled({
        enabled: true,
        plugin: pluginId,
        pluginStorageRoot: join(root, "plugins"),
        scope: "workspace",
        userConfigPath,
        workingDirectory: workspaceRoot,
      });

      expect(JSON.parse(await readFile(repositoryConfigPath, "utf8"))).toEqual({
        plugins: { enabledPlugins: { [pluginId]: false } },
      });
      expect(JSON.parse(await readFile(workspaceConfigPath, "utf8"))).toEqual({
        plugins: {
          enabledPlugins: { [pluginId]: true },
          options: { [pluginId]: { region: "nested" } },
        },
      });
      const reloaded = createConfig({
        env: {},
        userConfigPath,
        workingDirectory: workspaceRoot,
      });
      expect(reloaded.config.plugins.enabledPlugins[pluginId]).toBe(true);
      expect(reloaded.sources.plugins.enabled[pluginId]).toBe("workspace");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("resets Workspace plugin keys so effective config inherits User", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-plugin-reset-"));
    const userConfigPath = join(root, "user-config.json");
    const workspaceConfigPath = join(root, ".zcode", "config.json");
    const pluginId = "workspace-plugin@inline";
    try {
      await writeTestFile(
        userConfigPath,
        JSON.stringify({
          plugins: {
            enabledPlugins: { [pluginId]: true },
            options: { [pluginId]: { label: "user" } },
          },
        }),
      );
      await writeTestFile(
        workspaceConfigPath,
        JSON.stringify({
          plugins: {
            enabledPlugins: { [pluginId]: false },
            options: { [pluginId]: { label: "workspace" } },
          },
        }),
      );

      await resetZCodePluginConfig({
        pluginId,
        scope: "workspace",
        projectConfigPath: workspaceConfigPath,
        userConfigPath,
        workingDirectory: root,
      });

      expect(JSON.parse(await readFile(workspaceConfigPath, "utf8"))).toEqual({
        plugins: {
          enabledPlugins: {},
          options: { [pluginId]: { label: "workspace" } },
        },
      });
      expect(JSON.parse(await readFile(userConfigPath, "utf8"))).toEqual({
        plugins: {
          enabledPlugins: { [pluginId]: true },
          options: { [pluginId]: { label: "user" } },
        },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps Marketplace default enablement in User config for a legacy Workspace scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-user-marketplace-"));
    const pluginStorageRoot = join(root, "plugins");
    const marketplaceRoot = join(root, "user-marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "workspace-demo");
    const userConfigPath = join(root, "user-config.json");
    const workspaceConfigPath = join(root, ".zcode", "config.json");
    const marketplaceId = "workspace-market";
    const pluginName = "workspace-demo";

    try {
      await writeTestFile(
        join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: marketplaceId,
          plugins: [
            {
              name: pluginName,
              source: "./plugins/workspace-demo",
              version: "1.0.0",
            },
          ],
        }),
      );
      await writeTestFile(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({
          name: pluginName,
          skills: "skills",
          version: "1.0.0",
        }),
      );
      await writeTestFile(join(pluginRoot, "skills", pluginName, "SKILL.md"), "# workspace demo");
      await writeTestFile(
        userConfigPath,
        JSON.stringify({
          plugins: {
            extraKnownMarketplaces: {
              [marketplaceId]: {
                source: { source: "directory", path: marketplaceRoot },
              },
            },
          },
        }),
      );

      const beforeRefresh = await getZCodePluginsOverview({
        env: {},
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      expect(beforeRefresh.marketplaces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: marketplaceId,
            pluginCount: 0,
            source: { source: "directory", path: marketplaceRoot },
          }),
        ]),
      );
      expect(beforeRefresh.availablePlugins).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: `${pluginName}@${marketplaceId}` })]),
      );
      expect(existsSync(join(pluginStorageRoot, "marketplaces", marketplaceId))).toBe(false);
      const knownBeforeRefresh = JSON.parse(
        await readFile(join(pluginStorageRoot, "known_marketplaces.json"), "utf8"),
      ) as { marketplaces: Array<{ id: string }> };
      expect(knownBeforeRefresh.marketplaces.some((item) => item.id === marketplaceId)).toBe(false);

      const dryRun = await installZCodeMarketplacePlugin({
        dryRun: true,
        env: {},
        marketplace: marketplaceId,
        pluginName,
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      expect(dryRun.diagnostics).toEqual([]);
      expect(existsSync(join(pluginStorageRoot, "marketplaces", marketplaceId))).toBe(false);

      const refreshed = await updateZCodePluginMarketplace({
        env: {},
        marketplace: marketplaceId,
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      expect(refreshed.diagnostics).toEqual([]);
      expect(refreshed.marketplaces).toEqual([
        expect.objectContaining({ id: marketplaceId, pluginCount: 1 }),
      ]);
      expect(
        existsSync(join(pluginStorageRoot, "marketplaces", marketplaceId, "marketplace.json")),
      ).toBe(true);

      const afterRefresh = await getZCodePluginsOverview({
        env: {},
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });
      expect(afterRefresh.availablePlugins).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: `${pluginName}@${marketplaceId}`,
            installed: false,
          }),
        ]),
      );

      const installed = await installZCodeMarketplacePlugin({
        env: {},
        marketplace: marketplaceId,
        pluginName,
        pluginStorageRoot,
        userConfigPath,
        scope: "workspace",
        workingDirectory: root,
      });
      expect(installed.diagnostics).toEqual([]);
      expect(installed.installedPlugins).toEqual([
        expect.objectContaining({
          id: `${pluginName}@${marketplaceId}`,
          // Package inventory and the default enablement are both Host/User state.
          scope: "user",
        }),
      ]);
      expect(JSON.parse(await readFile(userConfigPath, "utf8"))).toMatchObject({
        plugins: {
          enabledPlugins: { [`${pluginName}@${marketplaceId}`]: true },
          extraKnownMarketplaces: {
            [marketplaceId]: {
              source: { source: "directory", path: marketplaceRoot },
            },
          },
        },
      });
      expect(existsSync(workspaceConfigPath)).toBe(false);
      expect(
        JSON.parse(await readFile(join(pluginStorageRoot, "installed_plugins.json"), "utf8")),
      ).toMatchObject({
        plugins: [
          expect.objectContaining({
            id: `${pluginName}@${marketplaceId}`,
            scope: "user",
          }),
        ],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("ignores Marketplace declarations from Workspace config", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-ignore-workspace-marketplace-"));
    const marketplaceId = "workspace-market";
    try {
      await writeTestFile(
        join(root, ".zcode", "config.json"),
        JSON.stringify({
          plugins: {
            extraKnownMarketplaces: {
              [marketplaceId]: {
                source: {
                  source: "directory",
                  path: join(root, "marketplace"),
                },
              },
            },
          },
        }),
      );
      const configResult = createConfig({
        env: {},
        userConfigPath: join(root, "user-config.json"),
        workingDirectory: root,
      });
      expect(configResult.config.plugins?.extraKnownMarketplaces?.[marketplaceId]).toBeUndefined();
      const overview = await getZCodePluginsOverview({
        env: {},
        pluginStorageRoot: join(root, "plugins"),
        userConfigPath: join(root, "user-config.json"),
        workingDirectory: root,
      });
      expect(overview.marketplaces).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: marketplaceId })]),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("resolves User relative marketplace paths from the declaring config directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-user-marketplace-path-"));
    const userConfigPath = join(root, "user", "config.json");
    const workspacePath = join(root, "workspace");
    try {
      await writeTestFile(
        userConfigPath,
        JSON.stringify({
          plugins: {
            extraKnownMarketplaces: {
              "user-market": {
                source: { source: "directory", path: "./marketplace" },
              },
            },
          },
        }),
      );

      const overview = await getZCodePluginsOverview({
        env: {},
        pluginStorageRoot: join(root, "plugins"),
        userConfigPath,
        workingDirectory: workspacePath,
      });

      expect(overview.marketplaces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "user-market",
            source: {
              source: "directory",
              path: join(root, "user", "marketplace"),
            },
          }),
        ]),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps official marketplace projection when User declares a reserved id", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-reserved-marketplace-"));
    const pluginStorageRoot = join(root, "plugins");
    const userConfigPath = join(root, "user-config.json");
    try {
      await writeTestFile(
        userConfigPath,
        JSON.stringify({
          plugins: {
            extraKnownMarketplaces: {
              "zcode-plugins-official": {
                source: { source: "directory", path: "./untrusted-official" },
              },
            },
          },
        }),
      );

      const overview = await getZCodePluginsOverview({
        env: {},
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });

      expect(
        overview.marketplaces.find((marketplace) => marketplace.id === "zcode-plugins-official"),
      ).toMatchObject({
        pluginCount: 16,
        source: {
          source: "url",
          url: "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
        },
      });
      expect(overview.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "plugin_marketplace_declaration_reserved",
            pluginId: "zcode-plugins-official",
            severity: "warning",
          }),
        ]),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not repoint an existing Host marketplace from a Workspace declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-marketplace-repoint-"));
    const pluginStorageRoot = join(root, "plugins");
    const originalSource = join(root, "original-marketplace");
    const workspaceSource = join(root, "workspace-marketplace");
    const workspaceConfigPath = join(root, ".zcode", "config.json");
    const marketplaceId = "shared-market";
    try {
      await writeTestFile(
        join(workspaceSource, ".claude-plugin", "marketplace.json"),
        JSON.stringify({ name: marketplaceId, plugins: [] }),
      );
      await writeKnownMarketplaces(pluginStorageRoot, [
        {
          id: marketplaceId,
          source: { source: "directory", path: originalSource },
          name: marketplaceId,
          addedAt: "2026-08-19T00:00:00.000Z",
          pluginCount: 0,
        },
      ]);
      await writeTestFile(
        workspaceConfigPath,
        JSON.stringify({
          plugins: {
            extraKnownMarketplaces: {
              [marketplaceId]: {
                source: { source: "directory", path: workspaceSource },
              },
            },
          },
        }),
      );

      const result = await updateZCodePluginMarketplace({
        env: {},
        marketplace: marketplaceId,
        pluginStorageRoot,
        workingDirectory: root,
      });
      const persisted = JSON.parse(
        await readFile(join(pluginStorageRoot, "known_marketplaces.json"), "utf8"),
      ) as { marketplaces: Array<{ id: string; source: { path: string } }> };

      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "plugin_marketplace_invalid",
          pluginId: marketplaceId,
          severity: "error",
        }),
      ]);
      const installResult = await installZCodeMarketplacePlugin({
        env: {},
        marketplace: marketplaceId,
        pluginName: "demo",
        pluginStorageRoot,
        workingDirectory: root,
      });
      expect(installResult.diagnostics).toEqual([
        expect.objectContaining({
          code: "plugin_marketplace_invalid",
          pluginId: `demo@${marketplaceId}`,
          severity: "error",
        }),
      ]);
      expect(persisted.marketplaces.find((item) => item.id === marketplaceId)?.source.path).toBe(
        originalSource,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps refresh-all limited to already known marketplaces", () => {
    expect(
      resolveMarketplaceRefreshTargetIds({
        declaredIds: ["workspace-only", "known"],
        knownIds: ["known"],
      }),
    ).toEqual(["known"]);
    expect(
      resolveMarketplaceRefreshTargetIds({
        declaredIds: ["workspace-only"],
        knownIds: [],
        marketplace: "workspace-only",
      }),
    ).toEqual(["workspace-only"]);
  });

  it("propagates cancellation while refreshing a declared marketplace", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-marketplace-refresh-abort-"));
    const pluginStorageRoot = join(root, "plugins");
    const marketplaceRoot = join(root, "workspace-marketplace");
    const userConfigPath = join(root, "user-config.json");
    const marketplaceId = "workspace-refresh-abort";
    try {
      await writeTestFile(
        join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: marketplaceId,
          plugins: [],
        }),
      );
      await writeTestFile(
        userConfigPath,
        JSON.stringify({
          plugins: {
            extraKnownMarketplaces: {
              [marketplaceId]: {
                source: { source: "directory", path: marketplaceRoot },
              },
            },
          },
        }),
      );
      const controller = new AbortController();
      controller.abort();

      const result = await updateZCodePluginMarketplace({
        abortSignal: controller.signal,
        env: {},
        marketplace: marketplaceId,
        pluginStorageRoot,
        userConfigPath,
        workingDirectory: root,
      });

      expect(result.diagnostics).toEqual([expect.objectContaining({ severity: "error" })]);
      expect(existsSync(join(pluginStorageRoot, "marketplaces", marketplaceId))).toBe(false);
      // 已取消的请求连默认市场都不应登记；既没有缓存，也没有修改安装状态。
      expect(existsSync(join(pluginStorageRoot, "known_marketplaces.json"))).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("matches Workspace config paths case-insensitively on Windows", () => {
    expect(isWorkspacePluginConfigPath("C:\\repo\\.ZCODE\\CONFIG.JSON", "win32")).toBe(true);
    expect(isWorkspacePluginConfigPath("C:\\repo\\zcode.json", "win32")).toBe(false);
  });

  // Regression for c0120fa: the app-startup discovery path must default-enable
  // content-only official plugins (skill-creator) the same way the CLI subcommand
  // path does. Without forwarding the default-enabled set, `/skill skill-creator`
  // failed with "Skill not found" inside a session even though it was bundled.
  it("default-enables skill-creator through the app-startup plugin discovery path", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-startup-plugins-"));
    const pluginStorageRoot = join(root, "plugins");

    try {
      const configResult = createConfig({
        env: {},
        skipUserConfig: true,
        workingDirectory: root,
      });
      const outcome = await resolveStartupPlugins({
        cliStorageRoot: join(root, "cli"),
        configResult,
        env: {},
        options: { pluginStorageRoot } as ZCodeAppOptions,
        startupTimer: createNoopStartupTimer(),
        workingDirectory: root,
      });

      const plugin = outcome.plugins.find((item) => item.id === SKILL_CREATOR_PLUGIN_ID);
      const browserUsePlugin = outcome.plugins.find((item) => item.id === BROWSER_USE_PLUGIN_ID);
      const documentPlugin = outcome.plugins.find((item) => item.id === DOCUMENTS_PLUGIN_ID);
      expect(plugin).toMatchObject({
        enabled: true,
        name: "skill-creator",
        skillCount: 1,
        skillRootCount: 1,
      });
      // 0.2.0 起 documents 同时提供 docx 与 docx-viewer 两个 skill，并带查看面板的 MCP server。
      expect(documentPlugin).toMatchObject({
        enabled: true,
        mcpServerNames: ["plugin:documents:documents"],
        name: "documents",
        skillCount: 2,
        skillRootCount: 1,
      });
      // 回归原因：启动发现链路与 overview 使用同一份 browser-use 内置内容，
      // web-gui-tester 加入后这里也必须稳定报告两个 skill。
      expect(browserUsePlugin).toMatchObject({
        enabled: true,
        name: "browser-use",
        skillCount: 2,
        skillRootCount: 1,
      });
      expect(outcome.skillRoots.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

async function startZipFixtureServer(
  routes: Record<string, Buffer>,
): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const body = routes[pathname];
    if (!body) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-length": String(body.byteLength),
      "content-type": "application/zip",
    });
    response.end(body);
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("zip fixture server did not bind to a TCP port");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server || !server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

function createStoredZip(entries: Array<{ content?: string; path: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const data = Buffer.from(entry.content ?? "");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((entry.path.endsWith("/") ? 0o040755 : 0o100644) * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + data.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function writeTestFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function writeExecutableTestFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, { mode: 0o755 });
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

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
