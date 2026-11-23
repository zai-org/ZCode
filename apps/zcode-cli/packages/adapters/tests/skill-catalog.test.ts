import fs from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SkillNotFoundError, type SkillLoadOutcome, type SkillRoot } from "@zcode/contracts";
import {
  createCatalogSkillPort,
  createSkillCatalogLoader,
  createSkillCatalogSource,
  createSkillCatalogSourceRegistry,
  type SkillCatalogSourceOptions,
} from "../src/skills/catalog.js";

interface Fixture {
  root: string;
  home: string;
  workspace: string;
  userConfig: string;
  projectConfig: string;
  plugins: string;
  options: SkillCatalogSourceOptions & { homeDirectory: string };
}

let fixture: Fixture;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-catalog-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const userConfig = join(home, ".zcode", "cli", "config.json");
  const plugins = join(home, ".zcode", "cli", "plugins");
  await mkdir(plugins, { recursive: true });
  await mkdir(join(home, ".zcode", "skills"), { recursive: true });
  await mkdir(join(workspace, ".git"), { recursive: true });
  const projectConfig = join(workspace, ".zcode", "config.json");
  fixture = {
    root,
    home,
    workspace,
    userConfig,
    projectConfig,
    plugins,
    options: {
      homeDirectory: home,
      workingDirectory: workspace,
      configPaths: [projectConfig, userConfig],
      userConfigPath: userConfig,
      pluginStorageRoot: plugins,
      pluginRoots: [],
      bundledRoots: [],
    },
  };
});

afterEach(() => rm(fixture.root, { recursive: true, force: true }));

async function writeSkill(directory: string, name: string, description = `${name} skill`) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody of ${name}\n`,
  );
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

function names(outcome: SkillLoadOutcome): string[] {
  return outcome.skills.map((skill) => skill.qualifiedName ?? skill.name).toSorted();
}

async function load(options: SkillCatalogSourceOptions & { homeDirectory: string }) {
  const loaded = await createSkillCatalogLoader(options).load();
  loaded.commit();
  return loaded;
}

async function installPlugin(name: string) {
  const plugin = join(fixture.root, "installed", name);
  await writeJson(join(plugin, ".zcode-plugin", "plugin.json"), { name });
  await writeSkill(join(plugin, "skills", "demo"), "demo");
  await writeJson(join(fixture.plugins, "installed_plugins.json"), {
    version: 1,
    plugins: [
      {
        id: `${name}@test`,
        name,
        marketplace: "test",
        version: "1.0.0",
        installPath: plugin,
        installedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        scope: "user",
      },
    ],
  });
  return plugin;
}

it("follows plugin enablement from the configuration and installation commit points", async () => {
  const plugin = await installPlugin("example");
  await writeJson(fixture.userConfig, { plugins: { enabledPlugins: { "example@test": true } } });
  const enabled = await load(fixture.options);
  expect(names(enabled.outcome)).toEqual(["example:demo"]);
  // 插件目录只由安装流程写入：只监听提交点，不监听插件 manifest 与 skill 目录。
  expect(enabled.files).toContain(join(fixture.plugins, "installed_plugins.json"));
  expect(enabled.files).toContain(fixture.userConfig);
  expect([...enabled.files].some((file) => file.startsWith(plugin))).toBe(false);
  expect([...enabled.directories!].some((directory) => directory.startsWith(plugin))).toBe(false);

  // 工作区配置优先于用户配置。
  await writeJson(fixture.projectConfig, {
    plugins: { enabledPlugins: { "example@test": false } },
  });
  expect(names((await load(fixture.options)).outcome)).toEqual([]);
  expect(
    names((await load({ ...fixture.options, excludedPluginIds: ["example@test"] })).outcome),
  ).toEqual([]);
});

it("reuses plugin names across reloads but follows a plugin renamed in place", async () => {
  const plugin = await installPlugin("example");
  await writeJson(fixture.userConfig, {
    plugins: { enabledPlugins: { "example@test": true, "renamed@test": true } },
  });
  const loader = createSkillCatalogLoader(fixture.options);
  const first = (await loader.load()).outcome;
  expect(names(first)).toEqual(["example:demo"]);

  // 名字查找从 skill 根向上走，根目录下的 manifest 先命中。缓存复用时不再查找，所以看不到它。
  const decoy = join(first.skills[0]!.rootPath, ".cursor-plugin", "plugin.json");
  await writeJson(decoy, { name: "decoy" });
  expect(names((await loader.load()).outcome)).toEqual(["example:demo"]);
  await rm(dirname(decoy), { recursive: true });

  // 同一路径改名：插件名缓存跨重读共用，键里的 pluginId 变化后必须重新读取。
  await writeJson(join(plugin, ".zcode-plugin", "plugin.json"), { name: "renamed" });
  expect(names((await loader.load()).outcome)).toEqual(["renamed:demo"]);
});

it("finds an installed plugin without installPath in its cache directory, like startup", async () => {
  const cached = join(fixture.plugins, "cache", "test", "example", "1.0.0");
  await writeJson(join(cached, ".zcode-plugin", "plugin.json"), { name: "example" });
  await writeSkill(join(cached, "skills", "demo"), "demo");
  await writeJson(join(fixture.plugins, "installed_plugins.json"), {
    version: 1,
    plugins: [
      {
        id: "example@test",
        name: "example",
        marketplace: "test",
        version: "1.0.0",
        installPath: "",
        installedAt: "2026-01-01T00:00:00Z",
        scope: "user",
      },
    ],
  });
  await writeJson(fixture.userConfig, { plugins: { enabledPlugins: { "example@test": true } } });
  // 修复前空路径被解析成进程 cwd，实时目录读不到这个插件，或读到 cwd 下的同名目录。
  const loaded = await load(fixture.options);
  expect(loaded.outcome.skills.map((skill) => [skill.qualifiedName, skill.path])).toEqual([
    ["example:demo", join(cached, "skills", "demo", "SKILL.md")],
  ]);
});

it("applies skill toggles from both configuration files and keeps project roots out", async () => {
  const user = join(fixture.home, ".zcode", "skills", "user-skill");
  const project = join(fixture.workspace, ".agents", "skills", "project-skill");
  const extra = join(fixture.root, "extra");
  await writeSkill(user, "user-skill");
  await writeSkill(project, "project-skill");
  await writeSkill(join(extra, "extra-skill"), "extra-skill");
  await writeJson(fixture.userConfig, { skills: { roots: [extra] } });
  // 项目配置只能写绝对路径的开关，不能加 skills.roots（与启动配置同一 scope）。
  await writeJson(fixture.projectConfig, { skills: { roots: [extra] } });
  expect(names((await load(fixture.options)).outcome)).toEqual([
    "extra-skill",
    "project-skill",
    "user-skill",
  ]);

  // 设置页写用户配置；工作区配置写绝对路径开关。两个来源分别生效。
  await writeJson(fixture.projectConfig, {});
  await writeJson(fixture.userConfig, {
    skills: { [join(user, "SKILL.md")]: { enable: false } },
  });
  expect(names((await load(fixture.options)).outcome)).toEqual(["project-skill"]);
  await writeJson(fixture.userConfig, {});
  await writeJson(fixture.projectConfig, {
    skills: { [join(project, "SKILL.md")]: { enable: false } },
  });
  expect(names((await load(fixture.options)).outcome)).toEqual(["user-skill"]);
  // 两个来源同时有开关时都生效：修复前项目层的开关整体替换了用户层的开关。
  await writeJson(fixture.userConfig, {
    skills: { [join(user, "SKILL.md")]: { enable: false } },
  });
  expect(names((await load(fixture.options)).outcome)).toEqual([]);
});

it("watches skill roots but not existing skills, plain subdirectories or bundled roots", async () => {
  const userRoot = join(fixture.home, ".agents", "skills");
  await writeSkill(join(userRoot, "alpha"), "alpha");
  await mkdir(join(userRoot, "pending"), { recursive: true });
  await mkdir(join(userRoot, ".hidden"), { recursive: true });
  const bundled = join(fixture.root, "bundled");
  await writeSkill(join(bundled, "builtin"), "builtin");
  await writeSkill(join(bundled, "workflow"), "workflow");
  const bundledRoot: SkillRoot = {
    path: bundled,
    priority: 1_000_000,
    scope: "system",
    source: "bundled",
  };
  const loaded = await load({
    ...fixture.options,
    bundledRoots: [bundledRoot],
    fixedDisabledPaths: [join(bundled, "workflow", "SKILL.md")],
  });
  expect(names(loaded.outcome)).toEqual(["alpha", "builtin"]);
  expect([...loaded.directories!].toSorted()).toEqual(
    [
      join(fixture.home, ".zcode", "skills"),
      userRoot,
      join(fixture.workspace, ".zcode", "skills"),
      join(fixture.workspace, ".agents", "skills"),
    ].toSorted(),
  );
  expect(loaded.files).toContain(join(userRoot, "SKILL.md"));
  // 已有 skill 的 SKILL.md 不监听：原地修改描述等下一次全量重读，数量与 skill 数无关。
  expect(loaded.files).not.toContain(join(userRoot, "alpha", "SKILL.md"));
  // 没有 SKILL.md 的子目录（例如分类目录）也不监听，否则监听数随目录数增长且永不撤销。
  expect(loaded.files).not.toContain(join(userRoot, "pending", "SKILL.md"));
  expect(loaded.files).not.toContain(join(userRoot, ".hidden", "SKILL.md"));
  expect([...loaded.files].some((file) => file.startsWith(bundled))).toBe(false);
});

it("publishes new and removed skill directories in an open source", async () => {
  const source = await createSkillCatalogSource(fixture.options);
  try {
    expect(names(source.getSnapshot())).toEqual([]);
    // 工作区还没有 .agents：锚点在工作区根，创建整条路径后被发现。
    await writeSkill(join(fixture.workspace, ".agents", "skills", "fresh"), "fresh");
    await vi.waitFor(() => expect(names(source.getSnapshot())).toEqual(["fresh"]), {
      timeout: 5_000,
    });
    await writeSkill(join(fixture.home, ".zcode", "skills", "second"), "second");
    await vi.waitFor(() => expect(names(source.getSnapshot())).toEqual(["fresh", "second"]), {
      timeout: 5_000,
    });
    await rm(join(fixture.workspace, ".agents", "skills", "fresh"), { recursive: true });
    await vi.waitFor(() => expect(names(source.getSnapshot())).toEqual(["second"]), {
      timeout: 5_000,
    });
  } finally {
    source.close();
  }
});

it("shares one entry for sessions with the same inputs", async () => {
  const registry = createSkillCatalogSourceRegistry();
  try {
    const first = await registry.acquire(fixture.options);
    const second = await registry.acquire({ ...fixture.options });
    expect(second.getSnapshot()).toBe(first.getSnapshot());
    first.close();
    first.close();
    second.close();
  } finally {
    registry.close();
  }
});

it("loads a skill written inside the debounce window by flushing once on a miss", async () => {
  const source = await createSkillCatalogSource(fixture.options);
  const port = createCatalogSkillPort(source);
  try {
    expect(await port.discoverSkills({ workingDirectory: fixture.workspace })).toBe(
      port.currentCatalog(),
    );
    await writeSkill(join(fixture.home, ".zcode", "skills", "just-written"), "just-written");
    const content = await port.loadSkill({
      name: "just-written",
      workingDirectory: fixture.workspace,
    });
    expect(content.content).toBe("body of just-written");
    expect(names(port.currentCatalog())).toEqual(["just-written"]);
    const missing = port.loadSkill({ name: "missing", workingDirectory: fixture.workspace });
    await expect(missing).rejects.toThrow("Skill not found: missing");
    // Skill tool 按错误类型转成模型文字，不解析 message。
    await expect(missing).rejects.toBeInstanceOf(SkillNotFoundError);
  } finally {
    port.close();
  }
});

it("reloads once when a listed skill file is gone and reports it as not found", async () => {
  const gone = join(fixture.home, ".zcode", "skills", "gone");
  await writeSkill(gone, "gone");
  const source = await createSkillCatalogSource(fixture.options);
  const port = createCatalogSkillPort(source);
  try {
    expect(names(port.currentCatalog())).toEqual(["gone"]);
    // 去抖窗口内快照仍列出它；修复前直接返回原始的 ENOENT 文件错误。
    await rm(gone, { recursive: true });
    await expect(
      port.loadSkill({ name: "gone", workingDirectory: fixture.workspace }),
    ).rejects.toThrow("Skill not found: gone");
    expect(names(port.currentCatalog())).toEqual([]);
  } finally {
    port.close();
  }
});

// 信任边界回归：插件目录不在监听范围，快照建立后插件文件被换成链接时没有重读。
// 修复前端口按快照路径直接读取，插件外文件的内容作为 skill 正文交给模型。
it.for(["file", "skill directory", "skills root"] as const)(
  "refuses a plugin skill whose %s became a link after the snapshot",
  async (form, ctx) => {
    const plugin = await installPlugin("example");
    await writeJson(fixture.userConfig, { plugins: { enabledPlugins: { "example@test": true } } });
    const outside = join(fixture.root, "outside");
    await writeSkill(join(outside, "demo"), "demo", "outside skill");
    const source = await createSkillCatalogSource(fixture.options);
    const port = createCatalogSkillPort(source);
    const request = { name: "example:demo", workingDirectory: fixture.workspace };
    // Windows 普通权限下创建目录 junction 不需要特权，文件链接会 EPERM。
    const directoryLink = process.platform === "win32" ? "junction" : "dir";
    try {
      expect((await port.loadSkill(request)).content).toBe("body of demo");
      const skills = join(plugin, "skills");
      if (form === "file") {
        await rm(join(skills, "demo", "SKILL.md"));
        try {
          await symlink(join(outside, "demo", "SKILL.md"), join(skills, "demo", "SKILL.md"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
          ctx.skip();
        }
      } else if (form === "skill directory") {
        await rename(join(skills, "demo"), join(fixture.root, "moved-demo"));
        await symlink(join(outside, "demo"), join(skills, "demo"), directoryLink);
      } else {
        await rename(skills, join(fixture.root, "moved-skills"));
        await symlink(outside, skills, directoryLink);
      }
      await expect(port.loadSkill(request)).rejects.toThrow("Skill not found: example:demo");
      expect(names(port.currentCatalog())).toEqual([]);
    } finally {
      port.close();
    }
  },
);

it("keeps loading a user skill that is a link", async () => {
  const target = join(fixture.root, "shared", "linked");
  await writeSkill(target, "linked");
  await symlink(
    target,
    join(fixture.home, ".zcode", "skills", "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const source = await createSkillCatalogSource(fixture.options);
  const port = createCatalogSkillPort(source);
  try {
    // 用户级 skill 支持用链接导入，不做插件的链接检查。
    const content = await port.loadSkill({ name: "linked", workingDirectory: fixture.workspace });
    expect(content.content).toBe("body of linked");
  } finally {
    port.close();
  }
});

it("stops a cancelled load before reloading the catalog", async () => {
  const flush = vi.fn(async () => {});
  const port = createCatalogSkillPort({
    getSnapshot: () => ({ skills: [], diagnostics: [], totalDiscovered: 0 }),
    flush,
    close: () => {},
  });
  const controller = new AbortController();
  controller.abort();
  // 未命中会触发全量重读；用户停止后不能再等重读结束。
  await expect(
    port.loadSkill(
      { name: "missing", workingDirectory: fixture.workspace },
      { signal: controller.signal },
    ),
  ).rejects.toThrow("Skill operation cancelled");
  expect(flush).not.toHaveBeenCalled();
});

it("keeps the system watch handle count independent of the number of skills", async () => {
  // chokidar 的 ESM 入口按名字导入 fs.watch；改写 CJS 导出后同步到 ESM 绑定，统计真实句柄。
  const original = fs.watch;
  let handles = 0;
  fs.watch = ((...args: Parameters<typeof fs.watch>) => {
    handles += 1;
    return original.apply(fs, args);
  }) as typeof fs.watch;
  syncBuiltinESMExports();
  const count = async (skills: number) => {
    const userRoot = join(fixture.home, ".agents", "skills");
    await rm(userRoot, { recursive: true, force: true });
    for (let index = 0; index < skills; index += 1)
      await writeSkill(join(userRoot, `skill-${index}`), `skill-${index}`);
    // 根目录里的普通文件不占句柄：只登记过的文件才通过过滤。
    await writeFile(join(userRoot, "README.md"), "notes");
    handles = 0;
    const source = await createSkillCatalogSource(fixture.options);
    const opened = handles;
    expect(source.getSnapshot().skills).toHaveLength(skills);
    source.close();
    return opened;
  };
  try {
    const few = await count(2);
    const many = await count(40);
    // 按 skill 监听（depth 1）时句柄随数量增长，实测 49 个 skill 约 100 个；这里每个根目录一个。
    expect(many).toBe(few);
    expect(few).toBeGreaterThan(0);
  } finally {
    fs.watch = original;
    syncBuiltinESMExports();
  }
});
