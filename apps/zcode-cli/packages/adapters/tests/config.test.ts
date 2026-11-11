import { describe, expect, it, vi } from "vitest";
import type { Logger, LoggerFactory } from "@zcode/contracts";
import { withFileLock } from "@zcode/shared/node";
import {
  createConfig,
  createConfigWithPluginMigrations,
  resolveWorkspaceStorageDir,
  updateUiLocaleInFileConfig,
} from "../src/config/index.js";
import { parseEnvConfig } from "../src/config/env-config.adapter.js";
import {
  addSuppressedBuiltinInFileConfig,
  loadFileConfig,
  removePluginFromFileConfig,
  removeSuppressedBuiltinInFileConfig,
  updatePluginEnabledInFileConfig,
  updatePluginOptionsInFileConfig,
} from "../src/config/file-config.adapter.js";
import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

vi.mock("../src/config/file-config.adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/file-config.adapter.js")>();
  return { ...actual, loadFileConfig: vi.fn(actual.loadFileConfig) };
});
vi.mock("@zcode/shared/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zcode/shared/node")>();
  return { ...actual, withFileLock: vi.fn(actual.withFileLock) };
});

function captureConfigLogger() {
  const warn = vi.fn();
  const logger: Logger = { debug() {}, info() {}, error() {}, warn, child: () => logger };
  const loggerFactory: LoggerFactory = {
    createLogger: () => logger,
    withContext: () => logger,
    setLevel() {},
  };
  return { loggerFactory, warn };
}

describe("config adapters", () => {
  it("resets legacy visualize flags per config once and preserves later opt-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-visualize-migration-"));
    const userConfigPath = join(root, "user.json");
    const projectConfigPath = join(root, ".zcode", "config.json");
    const id = "visualize@zcode-plugins-official";
    const original = {
      keep: "unknown",
      plugins: { enabledPlugins: { [id]: true, "other@fixture": true } },
    };
    try {
      await mkdir(join(root, ".zcode"));
      await writeFile(userConfigPath, JSON.stringify(original));
      await writeFile(projectConfigPath, JSON.stringify(original));
      const options = { env: {}, userConfigPath, workingDirectory: root };
      const migrated = await createConfigWithPluginMigrations(options);
      expect(migrated.config.plugins.enabledPlugins[id]).toBe(false);
      for (const path of [userConfigPath, projectConfigPath]) {
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
          ...original,
          plugins: {
            visualizeDefaultOffMigrated: true,
            enabledPlugins: { [id]: false, "other@fixture": true },
          },
        });
      }
      await updatePluginEnabledInFileConfig(projectConfigPath, id, true);
      const bytes = await readFile(projectConfigPath, "utf8");
      const reloaded = await Promise.all(
        Array.from({ length: 4 }, () => createConfigWithPluginMigrations(options)),
      );
      expect(reloaded.every((result) => result.config.plugins.enabledPlugins[id])).toBe(true);
      expect(await readFile(projectConfigPath, "utf8")).toBe(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a first enable racing with migration and other config writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-visualize-race-"));
    const userConfigPath = join(root, "user.json");
    const id = "visualize@zcode-plugins-official";
    try {
      const options = { env: {}, userConfigPath };
      await createConfigWithPluginMigrations(options);
      await expect(readFile(userConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(
        userConfigPath,
        JSON.stringify({ plugins: { enabledPlugins: { [id]: true } } }),
      );
      await Promise.all([
        createConfigWithPluginMigrations(options),
        updatePluginEnabledInFileConfig(userConfigPath, id, true),
        updateUiLocaleInFileConfig(userConfigPath, "zh-CN"),
      ]);
      const result = await createConfigWithPluginMigrations(options);
      expect(result.config.plugins.enabledPlugins[id]).toBe(true);
      expect(result.config.ui.locale).toBe("zh-CN");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["rename", "lock"])(
    "continues with a disabled layer when migration %s fails",
    async (stage) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-visualize-write-failure-"));
      const userConfigPath = join(root, "user.json");
      const id = "visualize@zcode-plugins-official";
      const original = JSON.stringify({ plugins: { enabledPlugins: { [id]: true } } });
      const { loggerFactory, warn } = captureConfigLogger();
      const code = stage === "rename" ? "EACCES" : "ZCODE_FILE_LOCK_TIMEOUT";
      try {
        await writeFile(userConfigPath, original);
        const operation =
          stage === "rename" ? vi.mocked(fsPromises.rename) : vi.mocked(withFileLock);
        operation.mockRejectedValueOnce(Object.assign(new Error("migration blocked"), { code }));
        try {
          const result = await createConfigWithPluginMigrations({
            env: {},
            userConfigPath,
            loggerFactory,
          });
          expect(result.config.plugins.enabledPlugins[id]).toBe(false);
          expect(result.configPort.getAll().plugins.enabledPlugins[id]).toBe(false);
          expect(warn).toHaveBeenCalledExactlyOnceWith(
            expect.any(String),
            expect.objectContaining({ configPath: userConfigPath, errorCode: code }),
          );
        } finally {
          operation.mockRestore();
        }
        expect(await readFile(userConfigPath, "utf8")).toBe(original);
        expect(await readdir(root)).toEqual(["user.json"]);
        expect(
          (await createConfigWithPluginMigrations({ env: {}, userConfigPath })).config.plugins
            .enabledPlugins[id],
        ).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["user", "project", "ancestor", "explicit"])(
    "keeps scope priority when the %s migration fails",
    async (scope) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-visualize-layer-failure-"));
      const id = "visualize@zcode-plugins-official";
      const userConfigPath = join(root, "user.json");
      const parentPath = join(root, ".zcode", "config.json");
      const child = join(root, "child");
      const childPath = join(child, ".zcode", "config.json");
      const explicitPath = join(root, "explicit.json");
      const paths = {
        user: userConfigPath,
        project: parentPath,
        ancestor: parentPath,
        explicit: explicitPath,
      };
      const failedPath = paths[scope as keyof typeof paths];
      const config = (migrated: boolean) =>
        JSON.stringify({
          plugins: {
            ...(migrated ? { visualizeDefaultOffMigrated: true } : {}),
            enabledPlugins: { [id]: true, "other@fixture": true },
          },
        });
      const { loggerFactory, warn } = captureConfigLogger();
      try {
        await mkdir(join(root, ".git"));
        await mkdir(join(root, ".zcode"));
        await mkdir(join(child, ".zcode"), { recursive: true });
        await writeFile(userConfigPath, config(true));
        await writeFile(parentPath, config(true));
        if (scope === "ancestor") await writeFile(childPath, config(true));
        await writeFile(failedPath, config(false));
        vi.mocked(fsPromises.rename).mockRejectedValueOnce(
          Object.assign(new Error("read only"), { code: "EROFS" }),
        );
        try {
          const result = await createConfigWithPluginMigrations({
            env: {},
            userConfigPath,
            workingDirectory: scope === "ancestor" ? child : root,
            ...(scope === "explicit"
              ? {
                  projectConfigPath: explicitPath,
                  cliOverrides: { plugins: { enabledPlugins: { [id]: true } } },
                }
              : {}),
            loggerFactory,
          });
          expect(result.config.plugins.enabledPlugins[id]).toBe(scope !== "project");
          expect(result.config.plugins.enabledPlugins["other@fixture"]).toBe(true);
          expect(warn).toHaveBeenCalledExactlyOnceWith(
            expect.any(String),
            expect.objectContaining({ configPath: failedPath, errorCode: "EROFS" }),
          );
          expect(await readFile(failedPath, "utf8")).toBe(config(false));
        } finally {
          vi.mocked(fsPromises.rename).mockRestore();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("warns once when the same file is used by user and project scopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-visualize-shared-config-"));
    const userConfigPath = join(root, "config.json");
    const id = "visualize@zcode-plugins-official";
    const { loggerFactory, warn } = captureConfigLogger();
    try {
      await writeFile(
        userConfigPath,
        JSON.stringify({ plugins: { enabledPlugins: { [id]: true } } }),
      );
      vi.mocked(fsPromises.rename).mockRejectedValue(
        Object.assign(new Error("read only"), { code: "EROFS" }),
      );
      const result = await createConfigWithPluginMigrations({
        env: {},
        userConfigPath,
        projectConfigPath: userConfigPath,
        loggerFactory,
      });
      expect(result.config.plugins.enabledPlugins[id]).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(fsPromises.rename).mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["invalid", "unchanged", "migration"])(
    "reads config once and reports diagnostics once: %s",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-config-single-read-"));
      const userConfigPath = join(root, "user.json");
      const { loggerFactory, warn } = captureConfigLogger();
      try {
        await writeFile(
          userConfigPath,
          kind === "invalid"
            ? "{"
            : JSON.stringify({
                plugins: {
                  ...(kind === "unchanged" ? { visualizeDefaultOffMigrated: true } : {}),
                  enabledPlugins: { "visualize@zcode-plugins-official": true },
                },
                ...(kind === "migration"
                  ? { mcp: { servers: { broken: { type: "stdio", args: [] } } } }
                  : {}),
              }),
        );
        vi.mocked(loadFileConfig).mockClear();
        await createConfigWithPluginMigrations({ env: {}, userConfigPath, loggerFactory });
        expect(loadFileConfig).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(kind === "unchanged" ? 0 : 1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["zcode.json", ".zcode/config.json", "explicit-project.json"])(
    "restricts project runtime parameters while retaining extension settings in %s",
    async (fileName) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-project-runtime-boundary-"));
      const userPath = join(root, ".zcode", "cli", "config.json");
      const projectPath = join(root, fileName);
      const skillPath = join(root, "skills", "demo", "SKILL.md");
      const commandPath = join(root, "commands", "demo.md");
      const userConfig = {
        network: { httpProxy: "http://user.example:8080", caCertFile: join(root, "user-ca.pem") },
        storage: { dir: join(root, "user-storage"), sessionDbPath: join(root, "user.sqlite") },
        permission: { mode: "plan", autoApproveHighRisk: false },
        plugins: {
          dirs: [join(root, "installed-plugin")],
          enabledPlugins: { "demo@fixture": false },
        },
      };
      const projectConfig = {
        network: {
          httpProxy: "http://project.example:8080",
          caCertFile: "./repo-ca.pem",
          noProxy: "*",
          timeout: 1,
        },
        storage: { dir: "./fake-user-storage", sessionDbPath: "./fake-session.sqlite" },
        permission: { mode: "yolo", autoApproveHighRisk: true },
        modelStream: { idleTimeoutMs: 1 },
        features: { mcp: false, subagent: false, memory: false, skill: false },
        memory: { use: false },
        logging: { level: "error", format: "text" },
        ui: { locale: "zh-CN", theme: "light" },
        toolConcurrency: { maxConcurrency: 1 },
        modelAnomalyGuard: { toolCallWarningThreshold: 1 },
        skills: { enabled: false, roots: ["./extra-skills"], [skillPath]: { enable: false } },
        command: { [commandPath]: { enable: false } },
        plugins: {
          enabled: false,
          dirs: ["./fake-plugin"],
          suppressedBuiltins: ["builtin@fixture"],
          extraKnownMarketplaces: {
            fake: { source: { source: "directory", path: "./fake-market" } },
          },
          enabledPlugins: { "demo@fixture": true },
          options: { "demo@fixture": { format: "compact" } },
        },
        mcp: { servers: { demo: { type: "stdio", command: "node", cwd: "./tools" } } },
        hooks: {
          events: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo project-hook" }] }],
          },
        },
      };
      try {
        vi.stubEnv("HOME", root);
        vi.stubEnv("USERPROFILE", root);
        await mkdir(join(root, ".git"));
        await mkdir(join(root, ".zcode", "cli"), { recursive: true });
        await writeFile(userPath, JSON.stringify(userConfig));
        await writeFile(projectPath, JSON.stringify(projectConfig));
        const baseline = createConfig({ env: {}, userConfigPath: userPath });
        const result = createConfig({
          env: {},
          userConfigPath: userPath,
          workingDirectory: root,
          ...(fileName === "explicit-project.json" ? { projectConfigPath: projectPath } : {}),
        });
        for (const field of [
          "network",
          "storage",
          "permission",
          "modelStream",
          "features",
          "memory",
          "logging",
          "ui",
          "toolConcurrency",
          "modelAnomalyGuard",
          "skills",
        ] as const) {
          expect(result.config[field], field).toEqual(baseline.config[field]);
        }
        expect(result.config.plugins).toEqual({
          ...baseline.config.plugins,
          enabledPlugins: { "demo@fixture": true },
          options: { "demo@fixture": { format: "compact" } },
        });
        expect(result.config.mcp.servers.demo).toMatchObject({
          command: "node",
          cwd: join(root, "tools"),
        });
        expect(result.sources.mcp.serverSources.demo).toBe("project");
        expect(result.config.hooks).toEqual(baseline.config.hooks);
        expect(result.sources.project.workspaceHookSnapshot).toBeDefined();
        expect(result.config.skillOverrides[skillPath]).toEqual({ enable: false });
        expect(result.config.commandOverrides[commandPath]).toEqual({ enable: false });
        expect(result.sources.project.hasUiLocale).toBe(false);
        expect(result.sources.project.hasUiTheme).toBe(false);
        expect(resolveWorkspaceStorageDir({ env: {}, workingDirectory: root })).toBe(
          userConfig.storage.dir,
        );
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("ignores invalid project runtime fields before validating extension settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-project-runtime-invalid-"));
    const projectPath = join(root, "zcode.json");
    const skillPath = join(root, "SKILL.md");
    try {
      await mkdir(join(root, ".git"));
      await writeFile(
        projectPath,
        JSON.stringify({
          network: { caCertFile: 123 },
          storage: null,
          permission: { mode: "invalid" },
          skills: { enabled: "invalid", roots: 123, [skillPath]: { enable: false } },
          plugins: { dirs: 123, enabled: "invalid", enabledPlugins: { "demo@fixture": true } },
          mcp: { servers: { demo: { type: "http", url: "https://example.com/mcp" } } },
        }),
      );
      const result = createConfig({ env: {}, skipUserConfig: true, workingDirectory: root });
      expect(result.sources.project.loaded).toBe(true);
      expect(result.sources.project.diagnostics).toEqual([]);
      expect(result.config.network.caCertFile).toBeUndefined();
      expect(result.config.mcp.servers.demo).toMatchObject({ url: "https://example.com/mcp" });
      expect(result.config.plugins.enabledPlugins["demo@fixture"]).toBe(true);
      expect(result.config.skillOverrides[skillPath]).toEqual({ enable: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("migrates the legacy official CUA plugin id to the canonical id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-cua-identity-"));
    const configPath = join(dir, "config.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            enabledPlugins: {
              "zcode-cua@zcode-plugins-official": true,
              "computer-use@zcode-plugins-official": false,
            },
            suppressedBuiltins: [
              "zcode-cua@zcode-plugins-official",
              "computer-use@zcode-plugins-official",
            ],
            options: {
              "zcode-cua@zcode-plugins-official": { apiKey: "legacy-key" },
              "computer-use@zcode-plugins-official": { apiKey: "canonical-key" },
            },
          },
        }),
      );

      const loaded = loadFileConfig(configPath);

      expect(loaded.config.plugins?.enabledPlugins).toEqual({
        "computer-use@zcode-plugins-official": false,
      });
      expect(loaded.config.plugins?.suppressedBuiltins).toEqual([
        "computer-use@zcode-plugins-official",
      ]);
      expect(loaded.config.plugins?.options).toEqual({
        "computer-use@zcode-plugins-official": { apiKey: "canonical-key" },
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("persists the canonical CUA plugin id while loading legacy config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-cua-writeback-"));
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        plugins: {
          enabledPlugins: { "zcode-cua@zcode-plugins-official": true },
          suppressedBuiltins: ["zcode-cua@zcode-plugins-official"],
          options: {
            "zcode-cua@zcode-plugins-official": { apiKey: "legacy-key" },
          },
        },
      }),
    );

    loadFileConfig(path);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      plugins: {
        enabledPlugins: { "computer-use@zcode-plugins-official": true },
        suppressedBuiltins: ["computer-use@zcode-plugins-official"],
        options: {
          "computer-use@zcode-plugins-official": { apiKey: "legacy-key" },
        },
      },
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("writes canonical CUA ids when removing legacy config entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-cua-write-migration-"));
    const configPath = join(dir, "config.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            enabledPlugins: { "zcode-cua@zcode-plugins-official": true },
            suppressedBuiltins: ["zcode-cua@zcode-plugins-official"],
          },
        }),
      );

      expect(
        (
          await removeSuppressedBuiltinInFileConfig(
            configPath,
            "computer-use@zcode-plugins-official",
          )
        ).suppressed,
      ).toBe(false);
      expect(
        (await removePluginFromFileConfig(configPath, "computer-use@zcode-plugins-official"))
          .removedEnabled,
      ).toBe(true);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
        plugins: { enabledPlugins: {}, suppressedBuiltins: [], options: {} },
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("clears only explicitly selected Plugin option keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-plugin-option-clear-"));
    const configPath = join(dir, "config.json");
    const pluginId = "secret-plugin@fixture";

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            enabledPlugins: { [pluginId]: true },
            options: {
              [pluginId]: {
                token: "secret",
                region: "us-east-1",
              },
            },
          },
        }),
      );

      await updatePluginOptionsInFileConfig(configPath, pluginId, { region: "eu-west-1" }, [
        "token",
      ]);

      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
        plugins: {
          enabledPlugins: { [pluginId]: true },
          options: {
            [pluginId]: {
              region: "eu-west-1",
            },
          },
        },
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("deep merges Workspace Plugin enablement and options over User config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-workspace-plugins-"));
    const userPath = join(dir, "user.json");
    const workspacePath = join(dir, ".zcode", "config.json");

    try {
      await mkdir(join(dir, ".zcode"), { recursive: true });
      await writeFile(
        userPath,
        JSON.stringify({
          plugins: {
            dirs: [join(dir, "user-plugin")],
            enabledPlugins: {
              "workspace-plugin@fixture": true,
              "user-only@fixture": true,
            },
            options: {
              "workspace-plugin@fixture": {
                inherited: "user",
                overridden: "user",
              },
            },
          },
        }),
      );
      await writeFile(
        workspacePath,
        JSON.stringify({
          plugins: {
            dirs: ["./workspace-plugin", join(dir, "absolute-workspace-plugin")],
            enabledPlugins: {
              "workspace-plugin@fixture": false,
            },
            options: {
              "workspace-plugin@fixture": {
                overridden: "workspace",
                workspaceOnly: true,
              },
            },
          },
        }),
      );

      const result = createConfig({
        env: {},
        userConfigPath: userPath,
        projectConfigPath: workspacePath,
        workingDirectory: dir,
      });

      expect(result.config.plugins.enabledPlugins).toEqual({
        "workspace-plugin@fixture": false,
        "user-only@fixture": true,
      });
      expect(result.config.plugins.options).toEqual({
        "workspace-plugin@fixture": {
          inherited: "user",
          overridden: "workspace",
          workspaceOnly: true,
        },
      });
      expect(result.sources.project.paths).toEqual([workspacePath]);
      expect(result.sources.plugins.enabled).toEqual({
        "user-only@fixture": "user",
        "workspace-plugin@fixture": "workspace",
      });
      expect(result.sources.plugins.dirs).toEqual({
        user: [join(dir, "user-plugin")],
        workspace: [],
      });
      expect(result.config.plugins.dirs).toEqual([join(dir, "user-plugin")]);
      expect(result.sources.plugins.options).toEqual({
        "workspace-plugin@fixture": {
          inherited: "user",
          overridden: "workspace",
          workspaceOnly: "workspace",
        },
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it.each(["zcode.json", ".zcode/config.json", "explicit-project.json"])(
    "ignores plugin directories from project config %s",
    async (fileName) => {
      const dir = await mkdtemp(join(tmpdir(), "zcode-project-plugin-dirs-"));
      const projectConfigPath = join(dir, fileName);
      try {
        await mkdir(join(dir, ".git"));
        await mkdir(join(dir, ".zcode"));
        await writeFile(
          projectConfigPath,
          JSON.stringify({ plugins: { dirs: ["./plugin", join(dir, "absolute-plugin")] } }),
        );
        const result = createConfig({
          env: {},
          skipUserConfig: true,
          ...(fileName === "explicit-project.json"
            ? { projectConfigPath }
            : { workingDirectory: dir }),
        });
        expect(result.sources.project.loaded).toBe(true);
        expect(result.config.plugins.dirs).toEqual([]);
        expect(result.sources.plugins.dirs.workspace).toEqual([]);
        expect(JSON.parse(await readFile(projectConfigPath, "utf8")).plugins.dirs).toHaveLength(2);
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
  );

  it("keeps Marketplace declarations in the User config layer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-workspace-marketplaces-"));
    const userPath = join(dir, "user.json");
    const workspacePath = join(dir, "workspace.json");

    try {
      await writeFile(
        userPath,
        JSON.stringify({
          plugins: {
            extraKnownMarketplaces: {
              "shared-market": {
                source: { source: "github", repo: "example/user-market" },
              },
              "user-market": {
                source: { source: "url", url: "https://example.test/user-market.json" },
              },
            },
          },
        }),
      );
      await writeFile(
        workspacePath,
        JSON.stringify({
          plugins: {
            extraKnownMarketplaces: {
              "shared-market": {
                source: { source: "directory", path: "./workspace-market" },
              },
              "workspace-market": {
                source: { source: "file", path: "./workspace-market.json" },
              },
            },
          },
        }),
      );

      const result = createConfig({
        env: {},
        userConfigPath: userPath,
        projectConfigPath: workspacePath,
      });

      expect(result.config.plugins.extraKnownMarketplaces).toEqual({
        "shared-market": {
          source: { source: "github", repo: "example/user-market" },
        },
        "user-market": {
          source: { source: "url", url: "https://example.test/user-market.json" },
        },
      });
      expect(result.sources.plugins.marketplaces).toEqual({
        "shared-market": "user",
        "user-market": "user",
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("parses the supported ZCODE environment surface", () => {
    const config = parseEnvConfig({
      ZCODE_STORAGE_DIR: "/tmp/zcode",
      ZCODE_HTTP_PROXY: "http://127.0.0.1:7890",
      ZCODE_NO_PROXY: "localhost,127.0.0.1",
      ZCODE_AGENT_CA_CERT: "/tmp/zcode-ca.pem",
      ZCODE_HTTP_TIMEOUT: "1234",
      ZCODE_LOCALE: "zh-CN",
      ZCODE_LOG_FORMAT: "json",
    });

    expect(config.model).toBeUndefined();
    expect(config.storage?.dir).toBe("/tmp/zcode");
    expect(config.network?.httpProxy).toBe("http://127.0.0.1:7890");
    expect(config.network?.noProxy).toBe("localhost,127.0.0.1");
    expect(config.network?.caCertFile).toBe("/tmp/zcode-ca.pem");
    expect(config.network?.timeout).toBe(1234);
    expect(config.ui).toBeUndefined();
    expect(config.logging?.format).toBe("json");
    expect(config.logging?.level).toBeUndefined();
  });

  it("loads the supported memory config fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-memory-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          memory: {
            use: false,
          },
        }),
      );

      const loaded = loadFileConfig(path);
      const merged = createConfig({ env: {}, userConfigPath: path });

      expect(loaded.loaded).toBe(true);
      expect(loaded.config.memory).toEqual({
        use: false,
      });
      expect(merged.config.memory).toEqual({
        use: false,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("parses session database path environment overrides", () => {
    expect(
      parseEnvConfig({
        ZCODE_SESSION_DB_PATH: "/tmp/zcode/db/db.sqlite",
      }).storage?.sessionDbPath,
    ).toBe("/tmp/zcode/db/db.sqlite");
    expect(
      parseEnvConfig({
        ZCODE_SESSION_DB: "/tmp/zcode/legacy.sqlite",
      }).storage?.sessionDbPath,
    ).toBe("/tmp/zcode/legacy.sqlite");
  });

  it("loads no-proxy rules from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          network: {
            httpProxy: "http://127.0.0.1:7890",
            noProxy: "localhost,127.0.0.1",
            caCertFile: "/tmp/zcode-ca.pem",
          },
        }),
      );

      const merged = createConfig({ env: {}, userConfigPath: path });

      expect(merged.config.network.httpProxy).toBe("http://127.0.0.1:7890");
      expect(merged.config.network.noProxy).toBe("localhost,127.0.0.1");
      expect(merged.config.network.caCertFile).toBe("/tmp/zcode-ca.pem");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("ignores undeclared ZCODE environment switches", () => {
    const config = parseEnvConfig({
      ZCODE_LOG_LEVEL: "debug",
      ZCODE_UNDECLARED_FLAG: "1",
    });

    expect(config).toEqual({});
  });

  it("loads yolo mode from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(path, JSON.stringify({ permission: { mode: "yolo" } }));

      const result = loadFileConfig(path);

      expect(result.loaded).toBe(true);
      expect(result.config.permission?.mode).toBe("yolo");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("loads edit mode from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(path, JSON.stringify({ permission: { mode: "edit" } }));

      const result = loadFileConfig(path);

      expect(result.loaded).toBe(true);
      expect(result.config.permission?.mode).toBe("edit");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("loads skill/command enable overrides from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          skill: { "/abs/skills/demo/SKILL.md": { enable: false } },
          command: { "/abs/commands/demo.md": { enable: false } },
        }),
      );

      const result = loadFileConfig(path);
      const merged = createConfig({ env: {}, userConfigPath: path });

      expect(result.loaded).toBe(true);
      // JSON 的 skill/command 字段映射到 runtime 的 skillOverrides/commandOverrides
      expect(result.config.skillOverrides?.["/abs/skills/demo/SKILL.md"]?.enable).toBe(false);
      expect(result.config.commandOverrides?.["/abs/commands/demo.md"]?.enable).toBe(false);
      expect(merged.config.skillOverrides["/abs/skills/demo/SKILL.md"]?.enable).toBe(false);
      expect(merged.config.commandOverrides["/abs/commands/demo.md"]?.enable).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("parses plugins.suppressedBuiltins as a string array", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-suppressed-"));
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({ plugins: { suppressedBuiltins: ["skill-creator@zcode-plugins-official"] } }),
    );
    const loaded = loadFileConfig(path);
    expect(loaded.config.plugins.suppressedBuiltins).toEqual([
      "skill-creator@zcode-plugins-official",
    ]);
  });

  it("maps skills path enable entries to skill overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          skills: {
            enabled: true,
            roots: ["/abs/skills"],
            "/abs/skills/disabled/SKILL.md": { enable: false },
            "/abs/skills/enabled/SKILL.md": { enable: true },
          },
        }),
      );

      const result = loadFileConfig(path);
      const merged = createConfig({ env: {}, userConfigPath: path });

      expect(result.loaded).toBe(true);
      expect(result.config.skills).toEqual({
        enabled: true,
        roots: ["/abs/skills"],
      });
      expect(result.config.skillOverrides?.["/abs/skills/disabled/SKILL.md"]?.enable).toBe(false);
      expect(result.config.skillOverrides?.["/abs/skills/enabled/SKILL.md"]?.enable).toBe(true);
      expect(merged.config.skillOverrides["/abs/skills/disabled/SKILL.md"]?.enable).toBe(false);
      expect(merged.config.skillOverrides["/abs/skills/enabled/SKILL.md"]?.enable).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("loads top-level skills config from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          skills: {
            enabled: false,
            includeInstructions: false,
            metadataBudget: 1024,
            roots: ["/abs/skills"],
          },
        }),
      );

      const result = loadFileConfig(path);
      const merged = createConfig({ env: {}, userConfigPath: path });

      expect(result.loaded).toBe(true);
      expect(result.config.skills).toEqual({
        enabled: false,
        includeInstructions: false,
        metadataBudget: 1024,
        roots: ["/abs/skills"],
      });
      expect(merged.config.skills.enabled).toBe(false);
      expect(merged.config.skills.includeInstructions).toBe(false);
      expect(merged.config.skills.metadataBudget).toBe(1024);
      expect(merged.config.skills.roots).toEqual(["/abs/skills"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("loads UI locale from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(path, JSON.stringify({ ui: { locale: "zh-CN" } }));

      const result = loadFileConfig(path);
      const merged = createConfig({ env: {}, userConfigPath: path });

      expect(result.loaded).toBe(true);
      expect(result.config.ui?.locale).toBe("zh-CN");
      expect(merged.config.ui.locale).toBe("zh-CN");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("loads auto UI locale from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(path, JSON.stringify({ ui: { locale: "auto" } }));

      const result = loadFileConfig(path);
      const merged = createConfig({ env: {}, userConfigPath: path });

      expect(result.loaded).toBe(true);
      expect(result.config.ui?.locale).toBe("auto");
      expect(merged.config.ui.locale).toBe("auto");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("loads UI theme from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(path, JSON.stringify({ ui: { theme: "light" } }));

      const result = loadFileConfig(path);
      const merged = createConfig({ env: {}, userConfigPath: path });

      expect(result.loaded).toBe(true);
      expect(result.config.ui?.theme).toBe("light");
      expect(merged.config.ui.theme).toBe("light");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects unsupported UI theme values from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(path, JSON.stringify({ ui: { theme: "sepia" } }));

      const result = loadFileConfig(path);

      expect(result.loaded).toBe(false);
      expect(result.config.ui).toBeUndefined();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("patches UI locale while preserving unrelated config fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          model: {
            main: "openai/gpt-5.1",
          },
          permission: {
            mode: "plan",
          },
          ui: {
            density: "compact",
            locale: "en-US",
          },
        }),
      );

      const result = await updateUiLocaleInFileConfig(path, "zh-CN");
      const written = JSON.parse(await readFile(path, "utf-8"));

      expect(result).toEqual({
        locale: "zh-CN",
        path,
      });
      expect(written).toMatchObject({
        model: {
          main: "openai/gpt-5.1",
        },
        permission: {
          mode: "plan",
        },
        ui: {
          density: "compact",
          locale: "zh-CN",
        },
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("creates config files when patching UI locale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "nested", "config.json");

    try {
      await updateUiLocaleInFileConfig(path, "auto");
      const written = JSON.parse(await readFile(path, "utf-8"));

      expect(written).toEqual({
        ui: {
          locale: "auto",
        },
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects unsupported UI locale values from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(path, JSON.stringify({ ui: { locale: "fr-FR" } }));

      const result = loadFileConfig(path);

      expect(result.loaded).toBe(false);
      expect(result.config.ui).toBeUndefined();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("loads MCP server config from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          features: {
            mcp: true,
          },
          mcp: {
            servers: {
              local: {
                type: "stdio",
                command: "node",
                args: ["server.js"],
                cwd: ".",
                env: {
                  EXAMPLE: "1",
                },
              },
              remote: {
                type: "http",
                url: "https://example.com/mcp",
                headers: {
                  Authorization: "Bearer token",
                },
                oauth: {
                  type: "client_credentials",
                  clientId: "zcode-client",
                  clientSecret: "secret",
                  scope: "mcp:tools",
                },
                timeoutMs: 30000,
              },
              events: {
                type: "sse",
                url: "https://example.com/sse",
                oauth: {
                  type: "authorization_code",
                  clientName: "ZCode",
                  redirectPath: "/oauth/callback/mcp/figma",
                  scope: "mcp:connect",
                },
                enabled: false,
              },
            },
          },
        }),
      );

      const result = loadFileConfig(path);

      expect(result.loaded).toBe(true);
      expect(result.config.features?.mcp).toBe(true);
      expect(result.config.mcp?.servers?.local).toMatchObject({
        type: "stdio",
        command: "node",
        args: ["server.js"],
      });
      expect(result.config.mcp?.servers?.remote).toMatchObject({
        type: "http",
        url: "https://example.com/mcp",
        oauth: {
          type: "client_credentials",
          clientId: "zcode-client",
          clientSecret: "secret",
          scope: "mcp:tools",
        },
        timeoutMs: 30000,
      });
      expect(result.config.mcp?.servers?.events).toMatchObject({
        type: "sse",
        oauth: {
          type: "authorization_code",
          clientName: "ZCode",
          redirectPath: "/oauth/callback/mcp/figma",
          scope: "mcp:connect",
        },
        enabled: false,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps an MCP server disabled when legacy enable:false coexists with enabled:true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          mcp: {
            servers: {
              // 桌面端「停用」写入 enable:false，而外部导入/手工编辑的同一条配置里
              // 已经带着 enabled:true。禁用意图必须胜出。
              playwright: {
                type: "stdio",
                command: "npx",
                args: ["-y", "@playwright/mcp@latest"],
                enable: false,
                enabled: true,
              },
            },
          },
        }),
      );

      const result = loadFileConfig(path);

      expect(result.config.mcp?.servers?.playwright?.enabled).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps an MCP server disabled when enabled:false coexists with legacy enable:true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          mcp: {
            servers: {
              playwright: {
                type: "stdio",
                command: "npx",
                args: ["-y", "@playwright/mcp@latest"],
                enable: true,
                enabled: false,
              },
            },
          },
        }),
      );

      const result = loadFileConfig(path);

      expect(result.config.mcp?.servers?.playwright?.enabled).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps an MCP server enabled when both enable and enabled are true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          mcp: {
            servers: {
              playwright: {
                type: "stdio",
                command: "npx",
                args: ["-y", "@playwright/mcp@latest"],
                enable: true,
                enabled: true,
              },
            },
          },
        }),
      );

      const result = loadFileConfig(path);

      expect(result.config.mcp?.servers?.playwright?.enabled).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("preserves fresh HTTP MCP config without writing implicit OAuth", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          mcp: {
            servers: {
              notion: {
                type: "http",
                url: "https://mcp.notion.com/mcp",
                timeoutMs: 30000,
              },
            },
          },
        }),
      );

      const result = loadFileConfig(path);

      expect(result.loaded).toBe(true);
      expect(result.config.mcp?.servers?.notion).toMatchObject({
        type: "http",
        url: "https://mcp.notion.com/mcp",
        timeoutMs: 30000,
      });
      expect(result.config.mcp?.servers?.notion?.oauth).toBeUndefined();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("skips invalid MCP OAuth config without dropping unrelated config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          mcp: {
            servers: {
              broken: {
                type: "http",
                url: "https://example.com/mcp",
                oauth: {
                  type: "client_credentials",
                  clientId: "zcode-client",
                },
              },
            },
          },
          plugins: {
            enabled: true,
          },
        }),
      );

      const result = loadFileConfig(path);

      expect(result.loaded).toBe(true);
      expect(result.config.mcp?.servers).not.toHaveProperty("broken");
      expect(result.config.plugins?.enabled).toBe(true);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "config_mcp_server_invalid",
          path: "mcp.servers.broken",
          severity: "warning",
        }),
      ]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("normalizes app-managed MCP config aliases from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          mcp: {
            servers: {
              "figma-dev-mode-mcp-server": {
                type: "stdio",
                command: "npx",
                args: ["-y", "figma-developer-mcp"],
                enable: false,
              },
              "chrome-devtools": {
                command: "npx",
                args: ["-y", "chrome-devtools-mcp@latest"],
              },
              node_repl: {
                command: "/opt/tools/node_repl",
                args: [],
                timeout: 30,
                startup_timeout_sec: 120,
              },
            },
          },
        }),
      );

      const result = loadFileConfig(path);

      expect(result.loaded).toBe(true);
      expect(result.config.mcp?.servers?.["figma-dev-mode-mcp-server"]).toMatchObject({
        type: "stdio",
        command: "npx",
        enabled: false,
      });
      expect(result.config.mcp?.servers?.["figma-dev-mode-mcp-server"]).not.toHaveProperty(
        "enable",
      );
      expect(result.config.mcp?.servers?.["chrome-devtools"]).toMatchObject({
        type: "stdio",
        command: "npx",
        args: ["-y", "chrome-devtools-mcp@latest"],
      });
      expect(result.config.mcp?.servers?.node_repl).toMatchObject({
        type: "stdio",
        command: "/opt/tools/node_repl",
      });
      expect(result.config.mcp?.servers?.node_repl).not.toHaveProperty("timeout");
      expect(result.config.mcp?.servers?.node_repl).not.toHaveProperty("startup_timeout_sec");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("normalizes legacy MCP http_headers to runtime headers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          mcp: {
            servers: {
              web_search_prime: {
                type: "http",
                url: "https://bigmodel.example.test/mcp",
                http_headers: {
                  Authorization: "Bearer token",
                },
              },
            },
          },
        }),
      );

      const result = loadFileConfig(path);

      expect(result.loaded).toBe(true);
      expect(result.config.mcp?.servers?.web_search_prime).toMatchObject({
        type: "http",
        headers: {
          Authorization: "Bearer token",
        },
      });
      expect(result.config.mcp?.servers?.web_search_prime).not.toHaveProperty("http_headers");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("normalizes legacy MCP remote/environment fields without dropping plugins config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          mcp: {
            servers: {
              "GLM-Image-MCP": {
                enabled: true,
                environment: {
                  Z_AI_API_KEY: "test-key",
                  Z_AI_MODE: "ZHIPU",
                },
                command: "npx",
                args: ["-y", "@z_ai/mcp-server"],
                type: "stdio",
              },
              "GLM-WebReader-MCP": {
                enabled: true,
                headers: {
                  Authorization: "Bearer token",
                },
                type: "remote",
                url: "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
              },
            },
          },
          plugins: {
            enabledPlugins: {
              "superpowers@zcode-plugins-official": true,
              "skill-creator@zcode-plugins-official": false,
            },
          },
        }),
      );

      const result = loadFileConfig(path);
      const merged = createConfig({ env: {}, userConfigPath: path });

      expect(result.loaded).toBe(true);
      expect(result.diagnostics).toEqual([]);
      expect(result.config.mcp?.servers?.["GLM-Image-MCP"]).toMatchObject({
        type: "stdio",
        env: {
          Z_AI_API_KEY: "test-key",
          Z_AI_MODE: "ZHIPU",
        },
      });
      expect(result.config.mcp?.servers?.["GLM-Image-MCP"]).not.toHaveProperty("environment");
      expect(result.config.mcp?.servers?.["GLM-WebReader-MCP"]).toMatchObject({
        headers: {
          Authorization: "Bearer token",
        },
        type: "http",
        url: "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
      });
      expect(merged.config.plugins.enabledPlugins).toMatchObject({
        "skill-creator@zcode-plugins-official": false,
        "superpowers@zcode-plugins-official": true,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps non-MCP config when one MCP server is invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const logDir = join(dir, "log");
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          mcp: {
            servers: {
              valid: {
                type: "remote",
                url: "https://example.com/mcp",
              },
              broken: {
                type: "stdio",
                args: ["server.js"],
              },
            },
          },
          plugins: {
            enabledPlugins: {
              "android-emulator@zcode-plugins-official": true,
            },
          },
        }),
      );

      const result = loadFileConfig(path);
      const merged = createConfig({
        env: { ZCODE_LOG_DIR: logDir },
        userConfigPath: path,
      });

      expect(result.loaded).toBe(true);
      expect(result.config.mcp?.servers?.valid).toMatchObject({
        type: "http",
        url: "https://example.com/mcp",
      });
      expect(result.config.mcp?.servers).not.toHaveProperty("broken");
      expect(
        result.config.plugins?.enabledPlugins?.["android-emulator@zcode-plugins-official"],
      ).toBe(true);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "config_mcp_server_invalid",
          path: "mcp.servers.broken",
          severity: "warning",
        }),
      ]);
      expect(merged.sources.user.diagnostics).toEqual(result.diagnostics);
      expect(merged.config.plugins.enabledPlugins["android-emulator@zcode-plugins-official"]).toBe(
        true,
      );
      await expect(readLogEntries(logDir)).resolves.toEqual([
        expect.objectContaining({
          event: "config.mcp_server.skipped",
          level: "warn",
          message: "MCP server config skipped",
          module: "adapters.config",
          context: expect.objectContaining({
            configPath: path,
            configScope: "user",
            diagnosticCode: "config_mcp_server_invalid",
            diagnosticPath: "mcp.servers.broken",
          }),
        }),
      ]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reports invalid discovered project config diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-project-config-"));
    const logDir = join(root, "log");
    const projectConfigPath = join(root, "zcode.json");

    try {
      await mkdir(join(root, ".git"));
      await writeFile(
        projectConfigPath,
        JSON.stringify({
          hooks: {
            enabled: "invalid",
          },
        }),
      );

      const result = createConfig({
        env: { ZCODE_LOG_DIR: logDir },
        skipUserConfig: true,
        workingDirectory: root,
      });

      expect(result.sources.project.loaded).toBe(false);
      expect(result.sources.project.diagnostics).toEqual([
        expect.objectContaining({
          code: "config_file_invalid",
          message: expect.stringContaining("hooks.enabled: Invalid input: expected boolean"),
          severity: "error",
        }),
      ]);
      await expect(readLogEntries(logDir)).resolves.toEqual([
        expect.objectContaining({
          event: "config.file.invalid",
          level: "warn",
          message: "Config file failed to load",
          module: "adapters.config",
          context: expect.objectContaining({
            configPath: projectConfigPath,
            configScope: "project",
            diagnosticCode: "config_file_invalid",
          }),
        }),
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("discovers project MCP config from the worktree root", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-project-config-"));
    const cwd = join(root, "packages", "app");

    try {
      await mkdir(join(root, ".git"));
      await mkdir(cwd, { recursive: true });
      await writeFile(
        join(root, "zcode.json"),
        JSON.stringify({
          mcp: {
            servers: {
              project: {
                type: "stdio",
                command: "node",
                args: ["server.js"],
                cwd: "tools",
              },
            },
          },
        }),
      );

      const result = createConfig({
        env: {},
        skipUserConfig: true,
        workingDirectory: cwd,
      });

      expect(result.sources.project.loaded).toBe(true);
      expect(result.sources.project.paths).toEqual([join(root, "zcode.json")]);
      expect(result.sources.project.mcpServerNames).toEqual(["project"]);
      expect(result.config.mcp.servers.project).toMatchObject({
        type: "stdio",
        command: "node",
        cwd: join(root, "tools"),
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("merges project configs from root to cwd with nearest config winning", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-project-config-"));
    const cwd = join(root, "packages", "app");
    const cwdConfigDir = join(cwd, ".zcode");

    try {
      await mkdir(join(root, ".git"));
      await mkdir(cwdConfigDir, { recursive: true });
      await writeFile(
        join(root, "zcode.json"),
        JSON.stringify({
          mcp: {
            servers: {
              project: {
                type: "stdio",
                command: "root-server",
              },
            },
          },
        }),
      );
      await writeFile(
        join(cwdConfigDir, "config.json"),
        JSON.stringify({
          mcp: {
            servers: {
              project: {
                type: "stdio",
                command: "nearest-server",
              },
            },
          },
        }),
      );

      const result = createConfig({
        env: {},
        skipUserConfig: true,
        workingDirectory: cwd,
      });

      expect(result.sources.project.paths).toEqual([
        join(root, "zcode.json"),
        join(cwdConfigDir, "config.json"),
      ]);
      expect(result.config.mcp.servers.project).toMatchObject({
        type: "stdio",
        command: "nearest-server",
        cwd,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("lets user MCP servers override same-name project MCP servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-project-config-"));
    const userConfigPath = join(root, "home", "config.json");

    try {
      await mkdir(join(root, ".git"));
      await mkdir(join(root, "home"), { recursive: true });
      await writeFile(
        join(root, "zcode.json"),
        JSON.stringify({
          mcp: {
            servers: {
              projectOnly: {
                type: "stdio",
                command: "project-only-server",
              },
              shared: {
                type: "stdio",
                command: "project-server",
              },
            },
          },
        }),
      );
      await writeFile(
        userConfigPath,
        JSON.stringify({
          mcp: {
            servers: {
              shared: {
                type: "stdio",
                command: "user-server",
              },
              userOnly: {
                type: "stdio",
                command: "user-only-server",
              },
            },
          },
        }),
      );

      const result = createConfig({
        env: {},
        userConfigPath,
        workingDirectory: root,
      });

      expect(result.config.mcp.servers.shared).toMatchObject({
        type: "stdio",
        command: "user-server",
      });
      expect(result.config.mcp.servers.projectOnly).toMatchObject({
        command: "project-only-server",
      });
      expect(result.config.mcp.servers.userOnly).toMatchObject({
        command: "user-only-server",
      });
      expect(result.sources.user.mcpServerNames).toEqual(["shared", "userOnly"]);
      expect(result.sources.project.mcpServerNames.toSorted()).toEqual(["projectOnly", "shared"]);
      expect(result.sources.mcp.serverSources).toMatchObject({
        projectOnly: "project",
        shared: "user",
        userOnly: "user",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not scan project config above the worktree root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "zcode-project-config-"));
    const root = join(parent, "repo");
    const cwd = join(root, "packages", "app");

    try {
      await mkdir(join(root, ".git"), { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(
        join(parent, "zcode.json"),
        JSON.stringify({
          mcp: {
            servers: {
              parent: {
                type: "stdio",
                command: "parent-server",
              },
            },
          },
        }),
      );

      const result = createConfig({
        env: {},
        skipUserConfig: true,
        workingDirectory: cwd,
      });

      expect(result.sources.project.loaded).toBe(false);
      expect(result.config.mcp.servers.parent).toBeUndefined();
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("keeps CLI feature overrides above project MCP config", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-project-config-"));

    try {
      await mkdir(join(root, ".git"));
      await writeFile(
        join(root, "zcode.json"),
        JSON.stringify({
          features: {
            mcp: true,
          },
        }),
      );

      const result = createConfig({
        cliOverrides: {
          features: {
            mcp: false,
          },
        },
        env: {},
        skipUserConfig: true,
        workingDirectory: root,
      });

      expect(result.config.features.mcp).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("loads process hook config from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          hooks: {
            enabled: true,
            timeoutMs: 5000,
            maxOutputBytes: 8192,
            events: {
              PreToolUse: [
                {
                  matcher: "Bash",
                  hooks: [
                    {
                      type: "process",
                      command: "node",
                      args: ["hooks/pre-tool.js"],
                      enabled: false,
                      customFlag: "keep",
                    },
                  ],
                },
              ],
            },
          },
        }),
      );

      const result = loadFileConfig(path);

      expect(result.loaded).toBe(true);
      expect(result.config.hooks).toMatchObject({
        enabled: true,
        timeoutMs: 5000,
        maxOutputBytes: 8192,
      });
      expect(result.config.hooks?.events?.PreToolUse?.[0]?.hooks[0]).toMatchObject({
        type: "process",
        command: "node",
        args: ["hooks/pre-tool.js"],
        enabled: false,
        customFlag: "keep",
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("drops hooks from discovered project config files because project hooks are untrusted code", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-project-hooks-"));

    try {
      await mkdir(join(root, ".git"));
      await mkdir(join(root, ".zcode"), { recursive: true });
      await writeFile(
        join(root, "zcode.json"),
        JSON.stringify({
          hooks: {
            enabled: true,
            events: {
              SessionStart: [
                {
                  matcher: "startup",
                  hooks: [{ type: "command", command: "echo root-project-hook" }],
                },
              ],
            },
          },
        }),
      );
      await writeFile(
        join(root, ".zcode", "config.json"),
        JSON.stringify({
          hooks: {
            enabled: true,
            events: {
              SessionStart: [
                {
                  matcher: "startup",
                  hooks: [{ type: "command", command: "echo project-hook" }],
                },
              ],
            },
          },
        }),
      );

      const result = createConfig({
        env: {},
        skipUserConfig: true,
        workingDirectory: root,
      });

      expect(result.sources.project.loaded).toBe(true);
      expect(
        result.sources.project.diagnostics.filter(
          (diagnostic) => diagnostic.code === "config_project_hooks_pending_trust",
        ),
      ).toHaveLength(2);
      for (const configPath of [join(root, "zcode.json"), join(root, ".zcode", "config.json")]) {
        expect(result.sources.project.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "config_project_hooks_pending_trust",
            filePath: configPath,
            message: "Project hooks are pending workspace trust and remain blocked",
            path: "hooks",
            severity: "warning",
          }),
        );
      }
      expect(result.config.hooks.events.SessionStart).toBeUndefined();
      expect(result.config.hooks.enabled).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps user hooks while dropping untrusted project hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-user-project-hooks-"));
    const userConfigPath = join(root, "user-config.json");

    try {
      await mkdir(join(root, ".git"));
      await mkdir(join(root, ".zcode"), { recursive: true });
      await writeFile(
        userConfigPath,
        JSON.stringify({
          hooks: {
            enabled: true,
            events: {
              SessionStart: [
                {
                  matcher: "startup",
                  hooks: [{ type: "command", command: "echo user-hook" }],
                },
              ],
            },
          },
        }),
      );
      await writeFile(
        join(root, ".zcode", "config.json"),
        JSON.stringify({
          hooks: {
            enabled: true,
            events: {
              UserPromptSubmit: [
                {
                  matcher: "*",
                  hooks: [{ type: "command", command: "echo project-hook" }],
                },
              ],
            },
          },
        }),
      );

      const result = createConfig({
        env: {},
        userConfigPath,
        workingDirectory: root,
      });

      expect(result.sources.user.loaded).toBe(true);
      expect(result.sources.project.loaded).toBe(true);
      expect(result.sources.project.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "config_project_hooks_pending_trust",
          path: "hooks",
          severity: "warning",
        }),
      );
      expect(result.config.hooks.enabled).toBe(true);
      expect(result.config.hooks.events.SessionStart?.[0]?.hooks[0]).toMatchObject({
        type: "command",
        command: "echo user-hook",
        source: { kind: "user", path: userConfigPath },
      });
      expect(result.config.hooks.events.UserPromptSubmit).toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("loads model stream idle timeout config from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          modelStream: {
            idleTimeoutMs: 120000,
          },
        }),
      );

      const result = loadFileConfig(path);

      expect(result.loaded).toBe(true);
      expect(result.config.modelStream).toMatchObject({
        idleTimeoutMs: 120000,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("merges model stream idle timeout into runtime config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          modelStream: {
            idleTimeoutMs: 240000,
          },
        }),
      );

      const result = createConfig({ env: {}, userConfigPath: path });

      expect(result.config.modelStream.idleTimeoutMs).toBe(240000);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("loads model anomaly guard config from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          modelAnomalyGuard: {
            repeatedToolCallWarningThreshold: 4,
            maxBudgetWarningsPerTurn: 2,
          },
        }),
      );

      const result = loadFileConfig(path);

      expect(result.loaded).toBe(true);
      expect(result.config.modelAnomalyGuard).toMatchObject({
        repeatedToolCallWarningThreshold: 4,
        maxBudgetWarningsPerTurn: 2,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects unknown hook events from file config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          hooks: {
            enabled: true,
            events: {
              BeforeEverything: [
                {
                  hooks: [
                    {
                      type: "process",
                      command: "node",
                    },
                  ],
                },
              ],
            },
          },
        }),
      );

      const result = loadFileConfig(path);

      expect(result.loaded).toBe(false);
      expect(result.config).toEqual({});
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // Provider/Model 配置已归 Registry 管理；通用配置忽略退场字段，不得重新推导模型选择。
  it.each([
    { model: { provider: "example", model: "example-model", apiKey: "fixture" } },
    { model: { main: "example/main", lite: "example/lite" } },
    { model: "example/main", modelSmall: "example/small", smallModel: "example/small" },
    {
      provider: {
        example: {
          kind: "unsupported",
          npm: "fixture",
          models: { tiny: { limit: { context: "invalid" } } },
        },
      },
    },
    { modelCatalog: { overrides: { "example/model": { supportsReasoning: true } } } },
  ])(
    "ignores retired provider config while preserving active configuration: %j",
    async (legacy) => {
      const dir = await mkdtemp(join(tmpdir(), "zcode-config-retired-model-"));
      try {
        const path = join(dir, "config.json");
        await writeFile(path, JSON.stringify({ ...legacy, features: { memory: false } }));
        const result = loadFileConfig(path);
        expect(result.loaded).toBe(true);
        expect(result.config).toMatchObject({ features: { memory: false } });
        for (const key of ["model", "provider", "modelCatalog", "modelSmall", "smallModel"])
          expect(result.config).not.toHaveProperty(key);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("rejects invalid active configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-invalid-"));
    try {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ network: { timeout: "invalid" } }));
      const result = loadFileConfig(path);
      expect(result.loaded).toBe(false);
      expect(result.config).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes a plugin's enabled flag and options on uninstall while preserving others", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-plugin-remove-"));
    const configPath = join(dir, "config.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            enabledPlugins: {
              "hello@market": true,
              "keep@market": true,
            },
            options: {
              "hello@market": { default_device: "iPhone 16" },
              "keep@market": { foo: "bar" },
            },
          },
        }),
      );

      const result = await removePluginFromFileConfig(configPath, "hello@market");
      expect(result.removedEnabled).toBe(true);
      expect(result.removedOptions).toBe(true);

      const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
        plugins: {
          enabledPlugins: Record<string, boolean>;
          options: Record<string, unknown>;
        };
      };
      expect(parsed.plugins.enabledPlugins).toEqual({ "keep@market": true });
      expect(parsed.plugins.options).toEqual({ "keep@market": { foo: "bar" } });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("is a no-op when removing a plugin that has no config footprint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-plugin-remove-missing-"));
    const configPath = join(dir, "config.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify({ plugins: { enabledPlugins: { "keep@market": true } } }),
      );
      const before = await readFile(configPath, "utf8");

      const result = await removePluginFromFileConfig(configPath, "missing@market");
      expect(result.removedEnabled).toBe(false);
      expect(result.removedOptions).toBe(false);
      // 未命中任何键时不应改写文件内容。
      expect(await readFile(configPath, "utf8")).toBe(before);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("adds and removes a suppressed builtin id atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-config-suppress-patch-"));
    const path = join(dir, "config.json");
    const id = "skill-creator@zcode-plugins-official";

    const added = await addSuppressedBuiltinInFileConfig(path, id);
    expect(added.suppressed).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).plugins.suppressedBuiltins).toEqual([id]);

    // idempotent add
    await addSuppressedBuiltinInFileConfig(path, id);
    expect(JSON.parse(await readFile(path, "utf8")).plugins.suppressedBuiltins).toEqual([id]);

    const removed = await removeSuppressedBuiltinInFileConfig(path, id);
    expect(removed.suppressed).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8")).plugins.suppressedBuiltins).toEqual([]);
  });
});

async function readLogEntries(logDir: string): Promise<Array<Record<string, unknown>>> {
  const files = await readdir(logDir);
  expect(files).toHaveLength(1);
  const content = await readFile(join(logDir, files[0]!), "utf8");
  return content.trim().split("\n").map(JSON.parse) as Array<Record<string, unknown>>;
}
