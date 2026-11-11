// 敏感插件选项私有存储（docs/design/v2/plugin-compat.md「Sensitive Option Storage」测试 1–7）。
// 每个用例都用临时目录：插件存储目录在 <root>/plugins，私有文件因此落在 <root>/plugin-secrets.json；
// 协议 handler 只认 ~/.zcode，下面把 homedir 重定向到一次性目录，绝不触碰真实 HOME。
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const FAKE_HOME = await vi.hoisted(async () => {
  const [{ mkdtemp: makeTemp }, { tmpdir: osTmpdir }, { join: joinPath }] = await Promise.all([
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ]);
  return await makeTemp(joinPath(osTmpdir(), "zcode-plugin-secrets-home-"));
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => FAKE_HOME };
});

import { createConfig } from "@zcode/adapters/config";
import type { Logger } from "@zcode/contracts";
import { zcodePluginsListResultSchema } from "@zcode/shared";
import { resolveStartupPlugins } from "../src/app/startup-marks.js";
import type { ZCodeAppOptions } from "../src/app/types.js";
import {
  configureZCodePlugin,
  installZCodeMarketplacePlugin,
  resetZCodePluginConfig,
  resolveZCodePlugins,
  uninstallZCodeMarketplacePlugin,
} from "../src/plugins.js";
import { StartupTimer } from "../src/startup-logging.js";
import { configurePlugin, listPlugins } from "../src/zcode-protocol/plugins.js";
import { readPluginUserOptions } from "../src/zcode-protocol/plugin-user-options.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const PLUGIN_NAME = "secret-plugin";
const PLUGIN_ID = `${PLUGIN_NAME}@inline`;
const API_SERVER = `plugin:${PLUGIN_NAME}:api`;
const LEAKY_SERVER = `plugin:${PLUGIN_NAME}:leaky`;
const SECRETS_FILE = "plugin-secrets.json";
const PRIVATE_FILE_MODE = 0o600;
const FILE_MODE_MASK = 0o777;

afterAll(async () => {
  await rm(FAKE_HOME, { force: true, recursive: true });
});

describe("plugin sensitive option storage", () => {
  it("1. stores a configured sensitive key only in the private file", async () => {
    await withFixture(async (fixture) => {
      await configureZCodePlugin({
        ...fixture.userOptions(),
        options: { region: "eu", token: "s3cret-user" },
        pluginId: PLUGIN_ID,
      });

      expect(await readJson(fixture.secretsPath)).toEqual({
        version: 1,
        user: { [PLUGIN_ID]: { token: "s3cret-user" } },
        workspaces: {},
      });
      if (process.platform !== "win32") {
        expect((await stat(fixture.secretsPath)).mode & FILE_MODE_MASK).toBe(PRIVATE_FILE_MODE);
      }
      const userConfigText = await readFile(fixture.userConfigPath, "utf8");
      expect(userConfigText).not.toContain("s3cret-user");
      expect(JSON.parse(userConfigText).plugins.options[PLUGIN_ID]).toEqual({ region: "eu" });
    });
  });

  it("2. reads a legacy plain-text value and migrates it on the next save", async () => {
    await withFixture(async (fixture) => {
      await fixture.writeUserConfig({ [PLUGIN_ID]: { token: "legacy-secret" } });

      const before = await resolveZCodePlugins(fixture.userOptions());
      expect(authorizationHeader(before.mcpServers[API_SERVER])).toBe("Bearer legacy-secret");
      // 不在启动时迁移：只读解析不创建私有文件，也不改写 config.json。
      expect(existsSync(fixture.secretsPath)).toBe(false);
      expect(JSON.parse(await readFile(fixture.userConfigPath, "utf8")).plugins.options).toEqual({
        [PLUGIN_ID]: { token: "legacy-secret" },
      });

      // 只保存普通键：UI 不回传敏感值，旧明文仍要在这次保存里迁走。
      await configureZCodePlugin({
        ...fixture.userOptions(),
        options: { region: "eu" },
        pluginId: PLUGIN_ID,
      });

      expect((await readJson(fixture.secretsPath)).user).toEqual({
        [PLUGIN_ID]: { token: "legacy-secret" },
      });
      const userConfigText = await readFile(fixture.userConfigPath, "utf8");
      expect(userConfigText).not.toContain("legacy-secret");
      expect(JSON.parse(userConfigText).plugins.options[PLUGIN_ID]).toEqual({ region: "eu" });
      const after = await resolveZCodePlugins(fixture.userOptions());
      expect(authorizationHeader(after.mcpServers[API_SERVER])).toBe("Bearer legacy-secret");
    });
  });

  it("3. expands a private value in MCP secret sinks and still rejects other fields", async () => {
    await withFixture(async (fixture) => {
      // 值只在私有文件里，config.json 没有：证明运行时读的是私有文件。
      await writeTestFile(
        fixture.secretsPath,
        JSON.stringify({
          version: 1,
          user: { [PLUGIN_ID]: { token: "runtime-secret" } },
          workspaces: {},
        }),
      );

      const outcome = await resolveStartupPlugins({
        cliStorageRoot: fixture.root,
        configResult: createConfig({
          env: {},
          userConfigPath: fixture.userConfigPath,
          workingDirectory: fixture.root,
        }),
        env: {},
        options: { pluginStorageRoot: fixture.pluginStorageRoot } as ZCodeAppOptions,
        startupTimer: createNoopStartupTimer(),
        workingDirectory: fixture.root,
      });

      expect(authorizationHeader(outcome.mcpServers[API_SERVER])).toBe("Bearer runtime-secret");
      expect(outcome.mcpServers[LEAKY_SERVER]).toBeUndefined();
      expect(outcome.diagnostics).toContainEqual(
        expect.objectContaining({ code: "plugin_variable_missing", pluginId: PLUGIN_ID }),
      );
      expect(JSON.stringify(outcome.diagnostics)).not.toContain("runtime-secret");
    });
  });

  it("4. keys workspace secrets by workspace root and keeps the innermost workspace first", async () => {
    await withFixture(async (fixture) => {
      const repositoryRoot = join(fixture.root, "repository");
      const nestedRoot = join(repositoryRoot, "packages", "app");
      await mkdir(join(repositoryRoot, ".git"), { recursive: true });
      await mkdir(nestedRoot, { recursive: true });

      await configureZCodePlugin({
        ...fixture.userOptions(repositoryRoot),
        options: { token: "outer-secret" },
        pluginId: PLUGIN_ID,
        scope: "workspace",
      });
      await configureZCodePlugin({
        ...fixture.userOptions(nestedRoot),
        options: { token: "inner-secret" },
        pluginId: PLUGIN_ID,
        scope: "workspace",
      });

      expect((await readJson(fixture.secretsPath)).workspaces).toEqual({
        [repositoryRoot]: { [PLUGIN_ID]: { token: "outer-secret" } },
        [nestedRoot]: { [PLUGIN_ID]: { token: "inner-secret" } },
      });
      for (const workspaceRoot of [repositoryRoot, nestedRoot]) {
        const workspaceConfig = await readFile(
          join(workspaceRoot, ".zcode", "config.json"),
          "utf8",
        );
        expect(workspaceConfig).not.toMatch(/(outer|inner)-secret/u);
        expect(JSON.parse(workspaceConfig).plugins.options[PLUGIN_ID]).toEqual({});
      }

      const nested = await resolveZCodePlugins(fixture.userOptions(nestedRoot));
      expect(authorizationHeader(nested.mcpServers[API_SERVER])).toBe("Bearer inner-secret");
      const outer = await resolveZCodePlugins(fixture.userOptions(repositoryRoot));
      expect(authorizationHeader(outer.mcpServers[API_SERVER])).toBe("Bearer outer-secret");

      // 清掉最内层的值后回落到外层 workspace 的私有值。
      await configureZCodePlugin({
        ...fixture.userOptions(nestedRoot),
        clearOptionKeys: ["token"],
        options: {},
        pluginId: PLUGIN_ID,
        scope: "workspace",
      });
      const fallback = await resolveZCodePlugins(fixture.userOptions(nestedRoot));
      expect(authorizationHeader(fallback.mcpServers[API_SERVER])).toBe("Bearer outer-secret");
      expect((await readJson(fixture.secretsPath)).workspaces).toEqual({
        [repositoryRoot]: { [PLUGIN_ID]: { token: "outer-secret" } },
      });
    });
  });

  it("5. keeps plugins/list filtered and returns user values from plugins/readUserOptions", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-secrets-protocol-"));
    const userConfigPath = join(FAKE_HOME, ".zcode", "cli", "config.json");
    const secretsPath = join(FAKE_HOME, ".zcode", "cli", SECRETS_FILE);
    const pluginRoot = join(root, PLUGIN_NAME);
    const context = {} as ZCodeProtocolAgentServerContext;
    const workspace = { workspacePath: root, workspaceKey: root };
    try {
      await writePluginManifest(pluginRoot);
      await writeTestFile(userConfigPath, JSON.stringify({ plugins: { dirs: [pluginRoot] } }));

      await configurePlugin(context, {
        workspace,
        pluginId: PLUGIN_ID,
        options: { token: "protocol-secret" },
      });

      expect((await readJson(secretsPath)).user).toEqual({
        [PLUGIN_ID]: { token: "protocol-secret" },
      });
      const listed = zcodePluginsListResultSchema.parse(
        await listPlugins(context, { workspace, configScope: "user" }),
      );
      expect(JSON.stringify(listed)).not.toContain("protocol-secret");
      const plugin = listed.plugins.find((item) => item.id === PLUGIN_ID);
      // 迁进私有文件的键仍要报 scope，设置页的标记与清除按钮依赖它。
      expect(plugin?.optionSources).toMatchObject({ token: "user" });
      expect(plugin?.configuredOptions?.token).toBeUndefined();

      expect(await readPluginUserOptions(context, { pluginId: PLUGIN_ID })).toEqual({
        values: { region: "us", token: "protocol-secret" },
      });
      await expect(
        readPluginUserOptions(context, { pluginId: "missing@inline" }),
      ).rejects.toMatchObject({ code: -32602, data: { code: "plugin_not_found" } });
    } finally {
      await rm(join(FAKE_HOME, ".zcode"), { force: true, recursive: true });
      await rm(root, { force: true, recursive: true });
    }
  });

  it("6. removes private entries on reset and on uninstall", async () => {
    await withFixture(async (fixture) => {
      await configureZCodePlugin({
        ...fixture.userOptions(),
        options: { token: "user-secret" },
        pluginId: PLUGIN_ID,
      });
      await configureZCodePlugin({
        ...fixture.userOptions(),
        options: { token: "workspace-secret" },
        pluginId: PLUGIN_ID,
        scope: "workspace",
      });

      // workspace「恢复继承」只删启用覆盖，与 config.json 同语义：workspace 私有值保留。
      await resetZCodePluginConfig({
        ...fixture.userOptions(),
        pluginId: PLUGIN_ID,
        scope: "workspace",
      });
      expect((await readJson(fixture.secretsPath)).workspaces).toEqual({
        [fixture.root]: { [PLUGIN_ID]: { token: "workspace-secret" } },
      });
      await resetZCodePluginConfig({ ...fixture.userOptions(), pluginId: PLUGIN_ID });
      expect((await readJson(fixture.secretsPath)).user).toEqual({});

      const marketplacePluginId = "hello@lazy-market";
      await installMarketplacePlugin(fixture);
      await writeTestFile(
        fixture.secretsPath,
        JSON.stringify({
          version: 1,
          user: { [marketplacePluginId]: { token: "a" }, [PLUGIN_ID]: { token: "keep" } },
          workspaces: {
            [fixture.root]: { [marketplacePluginId]: { token: "b" } },
            [join(fixture.root, "other")]: {
              [marketplacePluginId]: { token: "c" },
              [PLUGIN_ID]: { token: "keep-too" },
            },
          },
        }),
      );

      const removed = await uninstallZCodeMarketplacePlugin({
        ...fixture.userOptions(),
        pluginId: marketplacePluginId,
      });

      expect(removed?.id).toBe(marketplacePluginId);
      expect(await readJson(fixture.secretsPath)).toEqual({
        version: 1,
        user: { [PLUGIN_ID]: { token: "keep" } },
        workspaces: { [join(fixture.root, "other")]: { [PLUGIN_ID]: { token: "keep-too" } } },
      });
    });
  });

  it("7. backs up a corrupt private file, treats it as empty and reports a value-free diagnostic", async () => {
    await withFixture(async (fixture) => {
      const corrupt = '{"version":1,"user":{"secret-plugin@inline":{"token":"corrupt-secret"';
      await writeTestFile(fixture.secretsPath, corrupt);

      const outcome = await resolveZCodePlugins(fixture.userOptions());

      const diagnostic = outcome.diagnostics.find(
        (item) => item.code === "plugin_secrets_unreadable",
      );
      expect(diagnostic).toMatchObject({ severity: "error" });
      expect(JSON.stringify(outcome.diagnostics)).not.toContain("corrupt-secret");
      // 按空处理：需要 token 的 server 按现有规则报缺值。
      expect(outcome.mcpServers[API_SERVER]).toBeUndefined();
      expect(outcome.diagnostics).toContainEqual(
        expect.objectContaining({ code: "plugin_variable_missing", pluginId: PLUGIN_ID }),
      );
      const backups = (await readdir(fixture.root)).filter((name) =>
        name.startsWith(`${SECRETS_FILE}.corrupt-`),
      );
      expect(backups).toHaveLength(1);
      expect(await readFile(join(fixture.root, backups[0] ?? ""), "utf8")).toBe(corrupt);

      // 下一次保存把损坏文件替换成有效内容，备份留着。
      await configureZCodePlugin({
        ...fixture.userOptions(),
        options: { token: "fresh-secret" },
        pluginId: PLUGIN_ID,
      });
      expect(await readJson(fixture.secretsPath)).toEqual({
        version: 1,
        user: { [PLUGIN_ID]: { token: "fresh-secret" } },
        workspaces: {},
      });
      expect(existsSync(join(fixture.root, backups[0] ?? ""))).toBe(true);
      const healed = await resolveZCodePlugins(fixture.userOptions());
      expect(healed.diagnostics.some((item) => item.code === "plugin_secrets_unreadable")).toBe(
        false,
      );
    });
  });
});

interface Fixture {
  root: string;
  pluginStorageRoot: string;
  secretsPath: string;
  userConfigPath: string;
  userOptions(workingDirectory?: string): {
    env: NodeJS.ProcessEnv;
    pluginStorageRoot: string;
    userConfigPath: string;
    workingDirectory: string;
  };
  writeUserConfig(options?: Record<string, Record<string, unknown>>): Promise<void>;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-plugin-secrets-"));
  const pluginRoot = join(root, PLUGIN_NAME);
  const userConfigPath = join(root, "user-config.json");
  const writeUserConfig = async (options?: Record<string, Record<string, unknown>>) =>
    writeTestFile(
      userConfigPath,
      JSON.stringify({ plugins: { dirs: [pluginRoot], ...(options ? { options } : {}) } }),
    );
  const fixture: Fixture = {
    root,
    pluginStorageRoot: join(root, "plugins"),
    secretsPath: join(root, SECRETS_FILE),
    userConfigPath,
    userOptions: (workingDirectory = root) => ({
      env: {},
      pluginStorageRoot: join(root, "plugins"),
      userConfigPath,
      workingDirectory,
    }),
    writeUserConfig,
  };
  try {
    await writePluginManifest(pluginRoot);
    await writeUserConfig();
    await run(fixture);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function writePluginManifest(pluginRoot: string): Promise<void> {
  await writeTestFile(
    join(pluginRoot, ".zcode-plugin", "plugin.json"),
    JSON.stringify({
      name: PLUGIN_NAME,
      userConfig: {
        token: { sensitive: true, type: "string" },
        region: { type: "string", default: "us" },
      },
      mcpServers: {
        // headers 是 secret sink：敏感值可以展开。
        api: {
          type: "http",
          url: "https://mcp.example.com/api",
          headers: { Authorization: "Bearer ${user_config.token}" },
        },
        // url 不是 secret sink：敏感值必须被拒绝，server 被单独禁用。
        leaky: { type: "http", url: "https://mcp.example.com/${user_config.token}" },
      },
    }),
  );
}

async function installMarketplacePlugin(fixture: Fixture): Promise<void> {
  const marketplaceRoot = join(fixture.root, "marketplace");
  await writeTestFile(
    join(fixture.pluginStorageRoot, "known_marketplaces.json"),
    JSON.stringify({
      version: 1,
      marketplaces: [
        {
          id: "lazy-market",
          source: { source: "directory", path: marketplaceRoot },
          name: "lazy-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 0,
        },
      ],
    }),
  );
  await writeTestFile(
    join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "lazy-market",
      plugins: [{ name: "hello", source: "./plugins/hello" }],
    }),
  );
  await writeTestFile(
    join(marketplaceRoot, "plugins", "hello", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "hello", userConfig: { token: { sensitive: true } } }),
  );
  await installZCodeMarketplacePlugin({
    ...fixture.userOptions(),
    marketplace: "lazy-market",
    pluginName: "hello",
  });
}

function authorizationHeader(server: unknown): string | undefined {
  if (!server || typeof server !== "object" || !("headers" in server)) return undefined;
  return (server as { headers?: Record<string, string> }).headers?.Authorization;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function writeTestFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

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
