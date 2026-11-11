import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as asyncFs from "node:fs/promises";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addMarketplace,
  applyClaudePluginIcons,
  createNodePluginAdapter,
  describeMarketplacePlugin,
  discoverNodePlugins,
  enrichCachedClaudeMarketplaceIcons,
  ensureDefaultPluginMarketplaces,
  installMarketplacePlugin,
  listInstalledPluginRecords,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  parsePluginIconSources,
  uninstallMarketplacePlugin,
  updateMarketplace,
  validateMarketplacePlugin,
  validateMarketplaceSource,
  writeBundledOfficialMarketplacePartition,
} from "../src/plugins/index.js";
import {
  activateDirectoryAtomically,
  recoverAtomicTargetSync,
  resolveAtomicReadPath,
  replaceDirectoryAtomically,
} from "../src/plugins/atomic-directory.js";
import { createArchiveFetchError } from "../src/plugins/source-errors.js";
import { enumeratePluginComponents } from "../src/plugins/plugin-components.js";
import {
  buildGitHubArchiveUrl,
  parsePublicGitHubRepositoryUrl,
} from "../src/plugins/github-archive-source.js";
import {
  listInstalledPluginRecordsAsync,
  buildMarketplaceGitEnv,
} from "../src/plugins/marketplace.js";
import { resolveZipPluginSource } from "../src/plugins/zip-source.js";
import {
  appendPluginSourceCleanupError,
  cleanupPluginSourceBestEffort,
  PluginMaterialCache,
} from "../src/plugins/helpers.js";
import { createNodeCustomCommandAdapter } from "../src/commands/index.js";
import { createNodeSkillAdapter } from "../src/skills/index.js";
import {
  ZCODE_AGENT_CA_CERT_ENV_KEY,
  ZCODE_HTTP_PROXY_ENV_KEY,
  ZCODE_NO_PROXY_ENV_KEY,
  ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY,
} from "@zcode/shared";

const execFileAsync = promisify(execFile);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    lstat: vi.fn(actual.lstat),
    stat: vi.fn(actual.stat),
    realpath: vi.fn(actual.realpath),
  };
});

describe("NodePluginAdapter", () => {
  it("shares concurrent path checks and reuses their type in Skill scanning", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-shared-path-check-"));
    const file = join(root, "SKILL.md");
    const cache = new PluginMaterialCache();
    try {
      await writeFile(file, "# first");
      const reader = cache.reader("scope");
      vi.mocked(asyncFs.stat).mockClear();
      vi.mocked(asyncFs.realpath).mockClear();
      await Promise.all(Array.from({ length: 8 }, () => reader.observe(file)));
      expect(vi.mocked(asyncFs.stat).mock.calls.filter(([path]) => path === file)).toHaveLength(1);
      expect(vi.mocked(asyncFs.realpath).mock.calls.filter(([path]) => path === file)).toHaveLength(
        1,
      );
      await reader.observe(root);
      vi.mocked(asyncFs.stat).mockClear();
      vi.mocked(asyncFs.lstat).mockClear();
      expect(await reader.skillFiles(root)).toEqual([file]);
      expect(asyncFs.stat).not.toHaveBeenCalled();
      expect(asyncFs.lstat).toHaveBeenCalledTimes(2);
      await writeFile(file, "# changed content");
      expect(await reader.validate()).toBe(false);
    } finally {
      cache.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses directory absence without probing each candidate and detects later creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-directory-absence-"));
    const cache = new PluginMaterialCache();
    try {
      const reader = cache.reader("scope");
      await reader.directory(root);
      vi.mocked(asyncFs.stat).mockClear();
      vi.mocked(asyncFs.realpath).mockClear();
      for (const name of [
        ".mcp.json",
        "hooks/hooks.json",
        ".claude-plugin/plugin.json",
        "skills",
        "agents",
      ]) {
        const path = join(root, name);
        expect(await reader.missing(path)).toBe(true);
        await expect(reader.json(path)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(asyncFs.stat).not.toHaveBeenCalled();
      expect(asyncFs.realpath).not.toHaveBeenCalled();
      expect(await reader.validate()).toBe(true);
      expect(vi.mocked(asyncFs.stat).mock.calls.map(([path]) => path)).toEqual([root]);
      await mkdir(join(root, "hooks"));
      await writeFile(join(root, "hooks", "hooks.json"), "{}");
      expect(await reader.validate()).toBe(false);
      const next = cache.reader("scope");
      await next.directory(root);
      expect(await next.json(join(root, "hooks", "hooks.json"))).toEqual({});
      const moved = `${root}-old`;
      try {
        await rename(root, moved);
        await mkdir(root);
        expect(await next.validate()).toBe(false);
        const replaced = cache.reader("scope");
        await replaced.directory(root);
        expect(await replaced.missing(join(root, "hooks", "hooks.json"))).toBe(true);
      } finally {
        await rm(moved, { recursive: true, force: true });
      }
    } finally {
      cache.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps real checks for case-equivalent and nonstandard directory entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-directory-case-"));
    const cache = new PluginMaterialCache();
    try {
      await mkdir(join(root, "SKILLS"));
      const reader = cache.reader("scope");
      await reader.directory(root);
      vi.mocked(asyncFs.stat).mockClear();
      await reader.directoryExists(join(root, "skills"));
      await reader.missing(join(root, "CUSTOM~1"));
      expect(vi.mocked(asyncFs.stat).mock.calls.map(([path]) => path)).toEqual([
        join(root, "skills"),
        join(root, "CUSTOM~1"),
      ]);
      await mkdir(join(root, "技能"));
      const uncertain = cache.reader("scope");
      await uncertain.directory(root);
      vi.mocked(asyncFs.stat).mockClear();
      await uncertain.missing(join(root, "hooks", "hooks.json"));
      expect(vi.mocked(asyncFs.stat).mock.calls.map(([path]) => path)).toEqual([
        join(root, "hooks", "hooks.json"),
      ]);
    } finally {
      cache.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to normal discovery when the plugin root cannot be listed", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-root-listing-denied-"));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const adapter = createNodePluginAdapter({ storageRoot: join(root, "storage") });
    try {
      await writePluginManifest(root, { name: "listing-denied", skills: ["./skill"] });
      await mkdir(join(root, "skill"));
      await writeFile(join(root, "skill", "SKILL.md"), "---\nname: kept\n---\nbody");
      vi.mocked(asyncFs.readdir).mockImplementation(async (...args) => {
        if (args[0] === root) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return actual.readdir(...args);
      });
      const result = await adapter.discoverPlugins({
        config: { dirs: [root], enabled: true, enabledPlugins: {}, options: {} },
        env: {},
        storageRoot: join(root, "storage"),
        workingDirectory: root,
      });
      expect(
        result.plugins.find((plugin) => plugin.id === "listing-denied@inline")?.skillCount,
      ).toBe(1);
      expect(vi.mocked(asyncFs.readdir).mock.calls.some(([path]) => path === root)).toBe(true);
    } finally {
      vi.mocked(asyncFs.readdir).mockReset();
      adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { skills: ["./entry"], expected: ["entry"] },
    { skills: "./entry", expected: ["entry"] },
    { skills: ["./entry", "./entry/child"], expected: ["child", "entry"] },
    { skills: [], expected: [] },
    { skills: "./collection", expected: ["collection-item"] },
    { skills: ["./collection", "./collection/item"], expected: ["collection-item"] },
    { skills: undefined, expected: ["default"] },
  ])("uses only declared Skill entries: $skills", async ({ skills, expected }) => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-declared-skills-"));
    const root = join(dir, "plugin");
    const storageRoot = join(dir, "storage");
    const adapter = createNodePluginAdapter({ storageRoot });
    try {
      await writePluginManifest(root, { name: "declared", skills });
      for (const [path, name] of [
        ["entry", "entry"],
        ["entry/child", "child"],
        ["collection/item", "collection-item"],
        ["skills/default", "default"],
      ]) {
        const skill = join(root, path!);
        await mkdir(skill, { recursive: true });
        await writeFile(
          join(skill, "SKILL.md"),
          `---\nname: ${name}\ndescription: demo\n---\nbody`,
        );
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        vi.mocked(asyncFs.readdir).mockClear();
        const outcome = await adapter.discoverPlugins({
          config: { dirs: [root], enabled: true, enabledPlugins: {}, options: {} },
          env: {},
          storageRoot,
          workingDirectory: dir,
        });
        const plugin = outcome.plugins.find((item) => item.id === "declared@inline");
        expect(plugin?.skillCount).toBe(expected.length);
        expect(componentNames(plugin?.components ?? [], "skill").sort()).toEqual(expected);
        const standalone = await enumeratePluginComponents(root, { name: "declared", skills });
        expect(componentNames(standalone, "skill").sort()).toEqual(expected);
        const runtime = await createNodeSkillAdapter().discoverSkills({
          roots: outcome.skillRoots,
          workingDirectory: dir,
        });
        expect(runtime.skills.map((skill) => skill.name).sort()).toEqual(expected);
        // 声明单技能后，不应再枚举附属目录；未声明默认根也不应被补扫。
        const reads = vi.mocked(asyncFs.readdir).mock.calls.map(([path]) => String(path));
        expect(reads).not.toContain(join(root, "entry"));
        if (skills !== undefined) expect(reads).not.toContain(join(root, "skills"));
      }
    } finally {
      adapter.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shares each Skill root scan across diagnostics, counts and component metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-scan-reuse-"));
    const root = join(directory, "plugin");
    await writePluginManifest(root, { name: "scan-reuse", skills: ["./skills"] });
    const files = ["first", "second"].map((name) => join(root, "skills", name, "SKILL.md"));
    for (const path of files) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "---\nname: duplicate-name\n---\nbody");
    }
    const adapter = createNodePluginAdapter({ storageRoot: join(directory, "storage") });
    const request = {
      storageRoot: join(directory, "storage"),
      workingDirectory: directory,
      config: {
        dirs: [root],
        enabled: true,
        enabledPlugins: {},
        options: {},
        suppressedBuiltins: [],
      },
    };
    try {
      for (let query = 0; query < 2; query += 1) {
        vi.mocked(asyncFs.lstat).mockClear();
        const result = await adapter.discoverPlugins(request);
        expect(result.plugins[0]?.skillCount).toBe(2);
        expect(
          result.plugins[0]?.components.find((group) => group.kind === "skill")?.items,
        ).toEqual([{ name: "duplicate-name" }]);
        for (const file of files)
          expect(
            vi.mocked(asyncFs.lstat).mock.calls.filter(([path]) => path === file),
          ).toHaveLength(1);
      }
    } finally {
      adapter.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("avoids reads for missing materials and detects later creation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-missing-material-"));
    const path = join(directory, "optional.json");
    const parentFile = join(directory, "not-a-directory");
    await writeFile(parentFile, "file");
    const nested = join(parentFile, "child.json");
    const cache = new PluginMaterialCache();
    try {
      const reader = cache.reader("scope");
      vi.mocked(asyncFs.readFile).mockClear();
      for (let i = 0; i < 2; i += 1) {
        await expect(reader.json(path)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(reader.json(nested)).rejects.toMatchObject({ code: "ENOTDIR" });
      }
      expect(
        vi.mocked(asyncFs.readFile).mock.calls.filter(([file]) => file === path || file === nested),
      ).toHaveLength(0);
      expect(await reader.validate()).toBe(true);
      await writeFile(path, '{"created":true}');
      expect(await reader.validate()).toBe(false);
      expect(await cache.reader("scope").json(path)).toEqual({ created: true });
    } finally {
      cache.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads component Markdown concurrently with a four-read owner limit and stable name precedence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-parallel-markdown-"));
    const root = join(directory, "plugin");
    const commandRoot = join(root, "commands");
    await mkdir(commandRoot, { recursive: true });
    for (let i = 0; i < 8; i += 1)
      await writeFile(
        join(commandRoot, `${i}.md`),
        `---\nname: ${i < 2 ? "duplicate" : `command-${i}`}\ndescription: file-${i}\n---\nbody`,
      );
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const first = Promise.withResolvers<void>();
    const rest = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    let completed = 0;
    vi.mocked(asyncFs.readFile).mockImplementation(async (...args) => {
      if (!String(args[0]).startsWith(commandRoot)) return actual.readFile(...args);
      active += 1;
      peak = Math.max(peak, active);
      try {
        await (String(args[0]).endsWith("0.md") ? first.promise : rest.promise);
        return await actual.readFile(...args);
      } finally {
        active -= 1;
        completed += 1;
      }
    });
    const cache = new PluginMaterialCache();
    const reads = ["a", "b"].map((scope) =>
      enumeratePluginComponents(root, null, {
        loaded: {
          id: "parallel@inline",
          manifest: { name: "parallel" },
          manifestPath: join(root, ".zcode-plugin/plugin.json"),
          rootPath: root,
          marketplace: "inline",
          source: "inline",
          materials: cache.reader(scope),
        },
      }),
    );
    const done = Promise.all(reads);
    try {
      await vi.waitFor(() => expect(active).toBe(4));
      expect(peak).toBe(4);
      rest.resolve();
      await vi.waitFor(() => expect(completed).toBeGreaterThan(0));
      first.resolve();
      const results = await done;
      expect(peak).toBe(4);
      expect(results[0]).toEqual(results[1]);
      expect(results[0].find((group) => group.kind === "command")?.items).toEqual([
        { name: "duplicate", description: "file-0" },
        ...[2, 3, 4, 5, 6, 7].map((i) => ({ name: `command-${i}`, description: `file-${i}` })),
      ]);
    } finally {
      first.resolve();
      rest.resolve();
      await Promise.allSettled(reads);
      cache.dispose();
      vi.mocked(asyncFs.readFile).mockReset();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["invalidate", "dispose"] as const)(
    "does not start queued material IO after %s",
    async (action) => {
      const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-read-limit-"));
      const paths = Array.from({ length: 9 }, (_, i) => join(directory, `${i}.json`));
      for (const path of paths) await writeFile(path, "{}");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const release = Promise.withResolvers<void>();
      let started = 0;
      vi.mocked(asyncFs.readFile).mockImplementation(async (...args) => {
        if (paths.includes(String(args[0]))) {
          started += 1;
          await release.promise;
        }
        return actual.readFile(...args);
      });
      const cache = new PluginMaterialCache();
      const reader = cache.reader("scope");
      const done = Promise.allSettled(paths.map((path) => reader.json(path)));
      try {
        await vi.waitFor(() => expect(started).toBe(4));
        cache[action]();
        release.resolve();
        const results = await done;
        expect(started).toBe(4);
        for (const result of results) {
          expect(result.status).toBe("rejected");
          if (result.status === "rejected")
            expect(result.reason).toMatchObject(
              action === "dispose"
                ? { name: "AbortError" }
                : { code: "ZCODE_PLUGIN_SOURCES_CHANGED" },
            );
        }
      } finally {
        release.resolve();
        await done;
        cache.dispose();
        vi.mocked(asyncFs.readFile).mockReset();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("shares concurrent Skill scans without sharing mutable results or link policies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-scan-policy-"));
    const root = join(directory, "real");
    await mkdir(root);
    const file = join(root, "SKILL.md");
    await writeFile(file, "# skill");
    const link = join(directory, "linked");
    await symlink(root, link, process.platform === "win32" ? "junction" : "dir");
    const cache = new PluginMaterialCache();
    try {
      const reader = cache.reader("scope");
      vi.mocked(asyncFs.lstat).mockClear();
      const [first, second] = await Promise.all([reader.skillFiles(root), reader.skillFiles(root)]);
      expect(first).toEqual([file]);
      first.length = 0;
      expect(second).toEqual([file]);
      expect(vi.mocked(asyncFs.lstat).mock.calls.filter(([path]) => path === file)).toHaveLength(1);
      expect(await reader.skillFiles(link)).toEqual([]);
      expect(await reader.skillFiles(link, true)).toEqual([join(link, "SKILL.md")]);
      cache.invalidate();
      await expect(reader.skillFiles(root)).rejects.toMatchObject({
        code: "ZCODE_PLUGIN_SOURCES_CHANGED",
      });
    } finally {
      cache.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases material read slots after IO and parse failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-failed-reads-"));
    const paths = Array.from({ length: 9 }, (_, i) => join(directory, `${i}.json`));
    for (const path of paths) await writeFile(path, path === paths[4] ? "{" : "{}");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(asyncFs.readFile).mockImplementation(async (...args) => {
      if (paths.slice(0, 4).includes(String(args[0])))
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      return actual.readFile(...args);
    });
    const cache = new PluginMaterialCache();
    try {
      const reader = cache.reader("scope");
      const results = await Promise.allSettled(paths.map((path) => reader.json(path)));
      expect(results.slice(0, 5).map((result) => result.status)).toEqual(Array(5).fill("rejected"));
      expect(results.slice(5).map((result) => result.status)).toEqual(Array(4).fill("fulfilled"));
      vi.mocked(asyncFs.readFile).mockReset();
      await writeFile(paths[4]!, "{}");
      expect(await Promise.all(paths.map((path) => cache.reader("scope").json(path)))).toEqual(
        paths.map(() => ({})),
      );
    } finally {
      cache.dispose();
      vi.mocked(asyncFs.readFile).mockReset();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses parsed materials across sequential queries but reprojects configuration and isolates scopes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-material-reuse-"));
    const root = join(directory, "plugin");
    const storageRoot = join(directory, "storage");
    await writePluginManifest(root, { name: "material-fixture", version: "1.0.0" });
    const skillFile = join(root, "skills", "one", "SKILL.md");
    await mkdir(join(root, "skills", "one"), { recursive: true });
    await writeFile(skillFile, "---\nname: one\ndescription: first\n---\nbody");
    const manifestPath = join(root, ".zcode-plugin", "plugin.json");
    const sources = new Set([manifestPath, skillFile]);
    const sourceReads = () =>
      vi
        .mocked(asyncFs.readFile)
        .mock.calls.filter(([path]) => typeof path === "string" && sources.has(path)).length;
    const adapter = createNodePluginAdapter({ storageRoot });
    const request = {
      storageRoot,
      workingDirectory: directory,
      workspaceIdentity: "workspace-a",
      remoteSessionId: "attachment-a",
      config: {
        dirs: [root],
        enabled: true,
        enabledPlugins: {},
        options: {},
        suppressedBuiltins: [],
      },
    };
    try {
      const first = await adapter.discoverPlugins(request);
      expect(first.plugins[0]?.name).toBe("material-fixture");
      first.plugins[0]!.name = "changed-by-caller";
      vi.mocked(asyncFs.readFile).mockClear();
      vi.mocked(asyncFs.readdir).mockClear();
      const second = await adapter.discoverPlugins({
        ...request,
        config: { ...request.config, enabledPlugins: { "material-fixture@inline": false } },
      });
      expect(second.plugins[0]?.name).toBe("material-fixture");
      expect(second.plugins[0]?.enabled).toBe(false);
      expect(sourceReads()).toBe(0);
      await adapter.discoverPlugins(request);
      expect(sourceReads()).toBe(0);
      expect(
        vi.mocked(asyncFs.readdir).mock.calls.filter(([path]) => path === join(root, "skills")),
      ).toEqual([]);
      await adapter.discoverPlugins({ ...request, workspaceIdentity: "workspace-b" });
      expect(sourceReads()).toBeGreaterThan(0);
      vi.mocked(asyncFs.readFile).mockClear();
      await adapter.discoverPlugins({ ...request, remoteSessionId: "attachment-b" });
      expect(sourceReads()).toBeGreaterThan(0);
      const before = await asyncFs.stat(manifestPath);
      await writePluginManifest(root, { name: "material-fixture", version: "2.0.0" });
      await asyncFs.utimes(manifestPath, before.atime, before.mtime);
      const refreshed = await adapter.discoverPlugins(request);
      expect(refreshed.plugins[0]?.version).toBe("2.0.0");
      await mkdir(join(root, "skills", "two"));
      await writeFile(join(root, "skills", "two", "SKILL.md"), "---\nname: two\n---\nbody");
      expect((await adapter.discoverPlugins(request)).plugins[0]?.skillCount).toBe(2);
    } finally {
      adapter.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("parses once and returns independent values while validating current file metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-parser-cache-"));
    const path = join(directory, "data.json");
    const cache = new PluginMaterialCache();
    const parse = vi.fn(JSON.parse);
    await writeFile(path, '{"value":1}');
    try {
      const first = await cache.reader("scope").parsed(path, "json", parse);
      first.value = 9;
      expect(await cache.reader("scope").parsed(path, "json", parse)).toEqual({ value: 1 });
      expect(parse).toHaveBeenCalledOnce();
      cache.invalidate();
      expect(await cache.reader("scope").parsed(path, "json", parse)).toEqual({ value: 1 });
      expect(parse).toHaveBeenCalledTimes(2);
      const inFlight = cache.reader("scope");
      await inFlight.json(path);
      await writeFile(path, '{"value":2}');
      expect(await inFlight.validate()).toBe(false);
      expect(await cache.reader("scope").json(path)).toEqual({ value: 2 });
    } finally {
      cache.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shares a read without letting one cancelled query abort another", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-shared-material-"));
    const root = join(directory, "plugin");
    await writePluginManifest(root, { name: "shared", version: "1.0.0" });
    const manifestPath = join(root, ".zcode-plugin", "plugin.json");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let reads = 0;
    vi.mocked(asyncFs.readFile).mockImplementation(async (...args) => {
      const bytes = await actual.readFile(...args);
      if (args[0] === manifestPath) {
        reads += 1;
        entered.resolve();
        await release.promise;
      }
      return bytes;
    });
    const adapter = createNodePluginAdapter({ storageRoot: join(directory, "storage") });
    const request = {
      storageRoot: join(directory, "storage"),
      workingDirectory: directory,
      config: {
        dirs: [root],
        enabled: true,
        enabledPlugins: {},
        options: {},
        suppressedBuiltins: [],
      },
    };
    const controller = new AbortController();
    const first = adapter.discoverPlugins(request, { signal: controller.signal });
    const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;
    const second = adapter.discoverPlugins(request);
    try {
      controller.abort();
      await cancelled;
      release.resolve();
      expect((await second).plugins[0]?.name).toBe("shared");
      expect(reads).toBe(1);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
      adapter.dispose();
      vi.mocked(asyncFs.readFile).mockReset();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("discards material read before a source change and rejects new queries after dispose", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-stale-material-"));
    const root = join(directory, "plugin");
    await writePluginManifest(root, { name: "changing", version: "1.0.0" });
    const manifestPath = join(root, ".zcode-plugin", "plugin.json");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let firstRead = true;
    vi.mocked(asyncFs.readFile).mockImplementation(async (...args) => {
      const bytes = await actual.readFile(...args);
      if (args[0] === manifestPath && firstRead) {
        firstRead = false;
        entered.resolve();
        await release.promise;
      }
      return bytes;
    });
    const adapter = createNodePluginAdapter({ storageRoot: join(directory, "storage") });
    const request = {
      storageRoot: join(directory, "storage"),
      workingDirectory: directory,
      config: {
        dirs: [root],
        enabled: true,
        enabledPlugins: {},
        options: {},
        suppressedBuiltins: [],
      },
    };
    const pending = adapter.discoverPlugins(request);
    try {
      await entered.promise;
      await writePluginManifest(root, { name: "changing", version: "2.0.0" });
      release.resolve();
      expect((await pending).plugins[0]?.version).toBe("2.0.0");
      adapter.dispose();
      await expect(adapter.discoverPlugins(request)).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      adapter.dispose();
      vi.mocked(asyncFs.readFile).mockReset();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["dispose", "invalidate"] as const)(
    "bounds in-flight %s without publishing a stale result",
    async (action) => {
      const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-owner-change-"));
      const root = join(directory, "plugin");
      await writePluginManifest(root, { name: "changing", version: "1.0.0" });
      const manifestPath = join(root, ".zcode-plugin", "plugin.json");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const adapter = createNodePluginAdapter({ storageRoot: join(directory, "storage") });
      let reads = 0;
      vi.mocked(asyncFs.readFile).mockImplementation(async (...args) => {
        const bytes = await actual.readFile(...args);
        if (args[0] === manifestPath) {
          reads += 1;
          adapter[action]();
        }
        return bytes;
      });
      try {
        await expect(
          adapter.discoverPlugins({
            storageRoot: join(directory, "storage"),
            workingDirectory: directory,
            config: {
              dirs: [root],
              enabled: true,
              enabledPlugins: {},
              options: {},
              suppressedBuiltins: [],
            },
          }),
        ).rejects.toMatchObject(
          action === "dispose" ? { name: "AbortError" } : { code: "ZCODE_PLUGIN_SOURCES_CHANGED" },
        );
        expect(reads).toBe(action === "dispose" ? 1 : 3);
      } finally {
        adapter.dispose();
        vi.mocked(asyncFs.readFile).mockReset();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("does not retain parse failures or materials above its byte budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-material-budget-"));
    const path = join(directory, "source.json");
    const cache = new PluginMaterialCache();
    try {
      await writeFile(path, "{");
      await expect(cache.reader("scope").json(path)).rejects.toBeInstanceOf(SyntaxError);
      await writeFile(path, '{"ready":true}');
      expect(await cache.reader("scope").json(path)).toEqual({ ready: true });
      await writeFile(path, "x".repeat(4 * 1024 * 1024 + 1));
      const parse = vi.fn((contents: string) => contents.length);
      await cache.reader("scope").parsed(path, "text", parse);
      await cache.reader("scope").parsed(path, "text", parse);
      expect(parse).toHaveBeenCalledTimes(2);
    } finally {
      cache.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for asynchronous manifest IO while unrelated work can run and avoids rewriting commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-async-discovery-"));
    const root = join(directory, "plugin");
    await writePluginManifest(root, {
      name: "async-fixture",
      version: "1.0.0",
      commands: { probe: { content: "# probe" } },
    });
    const manifestPath = join(root, ".zcode-plugin", "plugin.json");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalRead = (
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    ).readFile;
    let intercepted = false;
    const read = vi.spyOn(asyncFs, "readFile").mockImplementation(async (...args) => {
      if (args[0] === manifestPath) {
        intercepted = true;
        entered.resolve();
        await release.promise;
      }
      return originalRead(...args);
    });
    const request = {
      config: {
        dirs: [root],
        enabled: true,
        enabledPlugins: {},
        options: {},
        suppressedBuiltins: [],
      },
      storageRoot: join(directory, "storage"),
      workingDirectory: directory,
    };
    let settled = false;
    const pending = discoverNodePlugins(request).finally(() => {
      settled = true;
    });
    try {
      await Promise.race([entered.promise, pending]);
      expect(intercepted).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      release.resolve();
      const outcome = await pending;
      expect(outcome.plugins.map((plugin) => plugin.name)).toEqual(["async-fixture"]);
      const commandPath = join(outcome.commandRoots[0]!.path, "probe.md");
      const first = await asyncFs.stat(commandPath, { bigint: true });
      await discoverNodePlugins(request);
      const second = await asyncFs.stat(commandPath, { bigint: true });
      expect([second.ino, second.mtimeNs]).toEqual([first.ino, first.mtimeNs]);
    } finally {
      release.resolve();
      await pending;
      read.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains the first discovered agent source and rejects paths outside the plugin", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "zcode-agent-component-source-"));
    const root = join(temporaryRoot, "plugin");
    try {
      for (const directory of ["agents", "custom", "absolute"])
        await mkdir(join(root, directory), { recursive: true });
      const outside = join(temporaryRoot, "outside");
      await mkdir(outside);
      for (const directory of [outside, join(root, "absolute")]) {
        await writeFile(
          join(directory, "forbidden.md"),
          "---\nname: forbidden\ndescription: Must not load\n---\nForbidden prompt",
        );
      }
      await writeFile(
        join(root, "agents", "first.md"),
        "---\nname: reviewer\ndescription: Default\n---\nDefault prompt",
      );
      await writeFile(
        join(root, "custom", "duplicate.md"),
        "---\nname: reviewer\ndescription: Custom\n---\nCustom prompt",
      );
      await writeFile(
        join(root, "custom", "other.md"),
        "---\nname: researcher\ndescription: Research\n---\nResearch prompt",
      );
      const groups = await enumeratePluginComponents(root, {
        name: "fixture",
        agents: ["custom", "agents", "custom", "../outside", join(root, "absolute")],
      });
      expect(groups.find((group) => group.kind === "agent")?.items).toEqual([
        { name: "reviewer", description: "Default", path: join(root, "agents", "first.md") },
        { name: "researcher", description: "Research", path: join(root, "custom", "other.md") },
      ]);
      expect(
        (
          await enumeratePluginComponents(root, {
            name: "fixture",
            agents: { reviewer: { description: "Declared" } },
          })
        ).find((group) => group.kind === "agent")?.items,
      ).toEqual([{ name: "reviewer", description: "Declared" }]);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("validates icon source records and only fills missing Claude marketplace icons", () => {
    const icons = parsePluginIconSources([
      { name: "figma", icon: "figma/icon.png", mimeType: "image/png", sha256: "a".repeat(64) },
      { name: "unsafe", icon: "../unsafe.png", mimeType: "image/png" },
      { name: "svg", icon: "svg/icon.svg", mimeType: "image/svg+xml" },
    ]);
    expect(icons.get("figma")).toBe(
      "https://cdn-zcode.z.ai/zcode/official-plugin/assets/figma/icon.png",
    );
    expect(icons.has("unsafe")).toBe(false);
    expect(icons.has("svg")).toBe(false);

    const enriched = applyClaudePluginIcons(
      {
        name: "claude-plugins-official",
        plugins: [
          { name: "figma", source: "./figma" },
          { name: "existing", icon: "https://example.com/existing.png", source: "./existing" },
        ],
      },
      new Map([
        ["figma", icons.get("figma")!],
        ["existing", "https://cdn.example.com/replacement.png"],
      ]),
    );
    expect(enriched.plugins).toEqual([
      {
        name: "figma",
        icon: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/figma/icon.png",
        source: "./figma",
      },
      { name: "existing", icon: "https://example.com/existing.png", source: "./existing" },
    ]);
  });

  it("only classifies canonical public GitHub HTTPS repository URLs for Archive download", () => {
    expect(parsePublicGitHubRepositoryUrl("https://github.com/acme/plugins.git")).toEqual({
      owner: "acme",
      repo: "plugins",
    });
    expect(parsePublicGitHubRepositoryUrl("http://github.com/acme/plugins.git")).toBeNull();
    expect(parsePublicGitHubRepositoryUrl("https://token@github.com/acme/plugins.git")).toBeNull();
    expect(parsePublicGitHubRepositoryUrl("https://github.com/acme/plugins/tree/main")).toBeNull();
    expect(buildGitHubArchiveUrl({ owner: "acme", repo: "plugins" }, "feature/no-git")).toBe(
      "https://api.github.com/repos/acme/plugins/zipball/feature%2Fno-git",
    );
  });

  it("follows marketplace redirects through the configured system proxy without leaking headers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-marketplace-proxy-"));
    const storageRoot = join(dir, "storage");
    const proxyRequests: Array<{ token: string | undefined; url: string }> = [];
    const proxy = createServer((request, response) => {
      const url = request.url ?? "";
      proxyRequests.push({
        token: request.headers["x-marketplace-token"],
        url,
      });
      if (url === "http://marketplace.test/marketplace.json") {
        response.writeHead(302, {
          location: "http://cdn.test/marketplace-redirect.json",
        });
        response.end();
        return;
      }
      if (url === "http://cdn.test/marketplace-redirect.json") {
        response.writeHead(307, {
          location: "http://cdn.test/marketplace.json",
        });
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name: "proxy-market",
          plugins: [{ name: "proxied", source: "./proxied" }],
        }),
      );
    });

    try {
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "proxy-market",
          source: {
            source: "url",
            url: "http://marketplace.test/marketplace.json",
            headers: { "x-marketplace-token": "marketplace-secret" },
          },
          name: "proxy-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 0,
        },
      ]);
      vi.stubEnv("ZCODE_HTTP_PROXY", "");
      vi.stubEnv(
        ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY,
        JSON.stringify({ HTTP_PROXY: await listenServer(proxy) }),
      );

      const updated = await updateMarketplace({
        marketplace: "proxy-market",
        storageRoot,
      });

      expect(updated.map((record) => record.id)).toEqual(["proxy-market"]);
      expect(proxyRequests).toEqual([
        {
          token: "marketplace-secret",
          url: "http://marketplace.test/marketplace.json",
        },
        {
          token: undefined,
          url: "http://cdn.test/marketplace-redirect.json",
        },
        {
          token: undefined,
          url: "http://cdn.test/marketplace.json",
        },
      ]);
      expect(loadMarketplaceManifestSync(storageRoot, "proxy-market")?.plugins[0]?.name).toBe(
        "proxied",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("fetches and persists optional icons while refreshing the Claude official marketplace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-claude-icons-"));
    const storageRoot = join(dir, "storage");
    const sourceDir = join(dir, "claude-marketplace");
    try {
      await writeMarketplaceManifest(sourceDir, {
        name: "claude-plugins-official",
        plugins: [{ name: "figma", source: "./figma" }],
      });
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "zcode-plugins-official",
          source: {
            source: "settings",
            marketplace: {
              name: "zcode-plugins-official",
              plugins: [],
              raw: { name: "zcode-plugins-official", plugins: [] },
            },
          },
          name: "zcode-plugins-official",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 0,
        },
        {
          id: "claude-plugins-official",
          source: {
            source: "settings",
            marketplace: {
              name: "claude-plugins-official",
              plugins: [],
              raw: { name: "claude-plugins-official", plugins: [] },
            },
          },
          name: "claude-plugins-official",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 0,
        },
        {
          id: "claude-plugins-official",
          source: { source: "directory", path: sourceDir },
          name: "claude-plugins-official",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 1,
        },
      ]);
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify([{ name: "figma", icon: "figma/icon.png", mimeType: "image/png" }]),
              { status: 200 },
            ),
          ),
      );

      await updateMarketplace({ marketplace: "claude-plugins-official", storageRoot });

      expect(
        loadMarketplaceManifestSync(storageRoot, "claude-plugins-official")?.raw,
      ).toMatchObject({
        plugins: [
          {
            name: "figma",
            icon: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/figma/icon.png",
          },
        ],
      });
      const cached = JSON.parse(
        await readFile(join(storageRoot, "icon-sources.json"), "utf8"),
      ) as unknown;
      expect(cached).toEqual([{ name: "figma", icon: "figma/icon.png", mimeType: "image/png" }]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("enriches an existing Claude catalog without refreshing its marketplace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-existing-claude-icons-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(storageRoot, "marketplaces", "claude-plugins-official");
    try {
      await mkdir(marketplaceRoot, { recursive: true });
      await writeFile(
        join(marketplaceRoot, "marketplace.json"),
        JSON.stringify({
          name: "claude-plugins-official",
          plugins: [{ name: "figma", source: "./figma" }],
        }),
      );
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "claude-plugins-official",
          source: { source: "github", repo: "anthropics/claude-plugins-official" },
          name: "claude-plugins-official",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-02T00:00:00.000Z",
          pluginCount: 1,
        },
      ]);
      let resolveFetch!: (response: Response) => void;
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      let writeLockCalls = 0;
      const migration = enrichCachedClaudeMarketplaceIcons(storageRoot, async (write) => {
        writeLockCalls += 1;
        await write();
      });

      await Promise.resolve();
      expect(writeLockCalls).toBe(0);
      resolveFetch(
        new Response(
          JSON.stringify([{ name: "figma", icon: "figma/icon.png", mimeType: "image/png" }]),
          { status: 200 },
        ),
      );
      await migration;

      await enrichCachedClaudeMarketplaceIcons(storageRoot);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(writeLockCalls).toBe(1);
      expect(
        loadMarketplaceManifestSync(storageRoot, "claude-plugins-official")?.raw,
      ).toMatchObject({
        plugins: [
          {
            name: "figma",
            icon: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/figma/icon.png",
          },
        ],
      });
      expect(
        JSON.parse(await readFile(join(storageRoot, "known_marketplaces.json"), "utf8")),
      ).toMatchObject({
        marketplaces: [{ lastUpdated: "2026-01-02T00:00:00.000Z" }],
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("uses the cached icon mapping when the optional CDN request fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-cached-claude-icons-"));
    const storageRoot = join(dir, "storage");
    const sourceDir = join(dir, "claude-marketplace");
    try {
      await writeMarketplaceManifest(sourceDir, {
        name: "claude-plugins-official",
        plugins: [{ name: "figma", source: "./figma" }],
      });
      await mkdir(storageRoot, { recursive: true });
      await writeFile(
        join(storageRoot, "icon-sources.json"),
        JSON.stringify([{ name: "figma", icon: "figma/icon.png", mimeType: "image/png" }]),
      );
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "claude-plugins-official",
          source: { source: "directory", path: sourceDir },
          name: "claude-plugins-official",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 1,
        },
      ]);
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

      await updateMarketplace({ marketplace: "claude-plugins-official", storageRoot });

      expect(
        loadMarketplaceManifestSync(storageRoot, "claude-plugins-official")?.raw,
      ).toMatchObject({
        plugins: [
          {
            name: "figma",
            icon: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/figma/icon.png",
          },
        ],
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("injects explicit ZCode proxy env into marketplace Git commands", () => {
    const env = buildMarketplaceGitEnv({
      [ZCODE_AGENT_CA_CERT_ENV_KEY]: "/tmp/root-ca.pem",
      [ZCODE_HTTP_PROXY_ENV_KEY]: "127.0.0.1:7890",
      [ZCODE_NO_PROXY_ENV_KEY]: "localhost,127.0.0.1",
      PATH: "/usr/bin:/bin",
      http_proxy: "http://ambient-proxy:8080",
    });

    expect(env).toMatchObject({
      ALL_PROXY: "http://127.0.0.1:7890",
      CURL_CA_BUNDLE: "/tmp/root-ca.pem",
      GIT_SSL_CAINFO: "/tmp/root-ca.pem",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      HTTP_PROXY: "http://127.0.0.1:7890",
      NODE_EXTRA_CA_CERTS: "/tmp/root-ca.pem",
      NO_PROXY: "localhost,127.0.0.1",
      PATH: "/usr/bin:/bin",
      REQUESTS_CA_BUNDLE: "/tmp/root-ca.pem",
      SSL_CERT_FILE: "/tmp/root-ca.pem",
      all_proxy: "http://127.0.0.1:7890",
      http_proxy: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7890",
      no_proxy: "localhost,127.0.0.1",
    });
  });

  // Finding #4 (defense-in-depth): the lowest-level discovery adapter must drop official
  // candidates whose id is in config.suppressedBuiltins, even when their cache dirs still
  // exist on disk. scanOfficialCache walks EVERY version dir, so a stale old-version dir left
  // by an app upgrade (seeding only deletes the current version's targetRoot) used to
  // re-surface an uninstalled built-in. Suppression must not depend on physical deletion.
  it("suppresses official plugins from discovery even when stale cache version dirs exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-suppress-official-cache-"));
    const storageRoot = join(dir, "storage");
    const officialCacheRoot = join(storageRoot, "cache", "zcode-plugins-official");

    try {
      // Suppressed built-in seeded at TWO versions (mirrors an upgrade that left an old dir).
      for (const version of ["0.1.0", "0.2.0"]) {
        await writePluginManifest(join(officialCacheRoot, "skill-creator", version), {
          name: "skill-creator",
          version,
        });
      }
      // A different, NON-suppressed official built-in in the same cache must still appear.
      await writePluginManifest(join(officialCacheRoot, "document-skills", "0.1.0"), {
        name: "document-skills",
        version: "0.1.0",
      });

      const outcome = await discoverNodePlugins({
        config: {
          dirs: [],
          enabled: true,
          enabledPlugins: {},
          options: {},
          suppressedBuiltins: ["skill-creator@zcode-plugins-official"],
        },
        env: {},
        storageRoot,
        workingDirectory: join(dir, "workspace"),
      });

      expect(
        outcome.plugins.find((plugin) => plugin.id === "skill-creator@zcode-plugins-official"),
      ).toBeUndefined();
      expect(
        outcome.plugins.find((plugin) => plugin.id === "document-skills@zcode-plugins-official"),
      ).toMatchObject({ source: "official" });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("prefers the official marketplace cache path when stale plugin versions coexist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-current-official-cache-"));
    const storageRoot = join(dir, "storage");
    const pluginRoot = join(storageRoot, "cache", "zcode-plugins-official", "browser-use");
    const staleRoot = join(pluginRoot, "0.2.1");
    const currentRoot = join(pluginRoot, "0.4.1");

    try {
      // 真实升级现场会保留旧目录，bundled partition 必须继续只认当前发布版本。
      await writePluginManifest(staleRoot, {
        name: "browser-use",
        version: "0.2.1",
      });
      await writePluginManifest(currentRoot, {
        name: "browser-use",
        version: "0.4.1",
      });
      await writeBundledOfficialMarketplacePartition({
        manifest: {
          name: "zcode-plugins-official",
          plugins: [
            {
              cachePath: currentRoot,
              name: "browser-use",
              source: "filesystem",
              version: "0.4.1",
            },
          ],
        },
        storageRoot,
      });

      const outcome = await discoverNodePlugins({
        config: {
          dirs: [],
          enabled: true,
          enabledPlugins: {},
          options: {},
          suppressedBuiltins: [],
        },
        env: {},
        storageRoot,
        workingDirectory: join(dir, "workspace"),
      });

      expect(
        outcome.plugins.find((plugin) => plugin.id === "browser-use@zcode-plugins-official"),
      ).toMatchObject({
        rootPath: currentRoot,
        version: "0.4.1",
      });
      expect(
        outcome.diagnostics.filter(
          (diagnostic) =>
            diagnostic.code === "plugin_duplicate_id" &&
            diagnostic.pluginId === "browser-use@zcode-plugins-official",
        ),
      ).toHaveLength(0);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // Guard: suppression only targets official candidates. An inline/cache plugin whose id
  // collides with a suppressed string must NOT be dropped.
  it("does not suppress inline plugins that share a suppressed built-in's name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-suppress-inline-guard-"));
    const pluginRoot = join(dir, "skill-creator-inline");

    try {
      await writePluginManifest(pluginRoot, { name: "skill-creator" });

      const outcome = await discoverNodePlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
          // Same bare name, but the inline id is skill-creator@inline — different from the
          // official id, so the inline plugin must survive.
          suppressedBuiltins: ["skill-creator@zcode-plugins-official", "skill-creator@inline"],
        },
        env: {},
        storageRoot: join(dir, "storage"),
        workingDirectory: join(dir, "workspace"),
      });

      expect(outcome.plugins.find((plugin) => plugin.id === "skill-creator@inline")).toMatchObject({
        source: "inline",
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects an untrusted marketplace that impersonates an official id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-official-impersonate-"));
    const storageRoot = join(dir, "storage");

    try {
      // Both reserved ids must be protected via the untrusted (user-facing) path.
      // claude-plugins-official is a DEFAULT marketplace (always seeded as "known"),
      // so a known-state heuristic would never fire for it — the explicit trusted
      // flag is what closes that hole.
      for (const reservedId of ["zcode-plugins-official", "claude-plugins-official"]) {
        const sourceDir = join(dir, `evil-${reservedId}`);
        await writeMarketplaceManifest(sourceDir, { name: reservedId, plugins: [] });
        await expect(
          addMarketplace({ source: { source: "directory", path: sourceDir }, storageRoot }),
        ).rejects.toThrow(/official marketplace/i);
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not clobber the local official manifest dir when rejecting an impersonator", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-official-clobber-"));
    const storageRoot = join(dir, "storage");
    const sourceDir = join(dir, "evil");

    try {
      // Seed an existing local claude-plugins-official manifest dir with a sentinel.
      const officialDir = join(storageRoot, "marketplaces", "claude-plugins-official");
      await mkdir(officialDir, { recursive: true });
      await writeFile(
        join(officialDir, "marketplace.json"),
        JSON.stringify({ name: "claude-plugins-official", plugins: [] }),
      );
      await writeFile(join(officialDir, "SENTINEL"), "real-official");

      // Attacker source whose manifest impersonates the official id.
      await writeMarketplaceManifest(sourceDir, { name: "claude-plugins-official", plugins: [] });
      await expect(
        addMarketplace({ source: { source: "directory", path: sourceDir }, storageRoot }),
      ).rejects.toThrow(/official marketplace/i);

      // The guard must run BEFORE persistence: the original dir + sentinel survive intact.
      expect(await readFile(join(officialDir, "SENTINEL"), "utf8")).toBe("real-official");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // Review #2: a trusted refresh must NOT let a non-official known marketplace claim an official
  // id by renaming its manifest. trustedId pins the refresh to the record's own id, so an
  // official name coming from a record whose id is not that official id is rejected.
  it("records a failed trusted refresh when a non-official manifest renames to an official id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-official-rename-attack-"));
    const storageRoot = join(dir, "storage");
    const sourceDir = join(dir, "evil-source");

    try {
      // A user-added marketplace "evil" becomes known.
      await writeMarketplaceManifest(sourceDir, { name: "evil", plugins: [] });
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "evil",
          source: { source: "directory", path: sourceDir },
          name: "evil",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 0,
        },
      ]);

      // Later the attacker renames the source manifest to impersonate the official id.
      await writeMarketplaceManifest(sourceDir, { name: "claude-plugins-official", plugins: [] });

      // The trusted internal refresh must reject the official-id claim without aborting the
      // refresh envelope; the durable failure is surfaced by overview/protocol diagnostics.
      expect(await updateMarketplace({ marketplace: "evil", storageRoot })).toEqual([]);
      expect(
        loadKnownMarketplacesSync(storageRoot).find((record) => record.id === "evil")
          ?.lastRefreshFailure,
      ).toMatchObject({
        code: "plugin_marketplace_invalid",
        message: expect.stringMatching(/official marketplace/i),
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("seeds Claude official marketplace without overwriting an existing record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-default-marketplace-"));
    const storageRoot = join(dir, "storage");

    try {
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "claude-plugins-official",
          source: { source: "directory", path: join(dir, "custom-claude") },
          name: "claude-plugins-official",
          description: "Custom Claude mirror",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-02T00:00:00.000Z",
          pluginCount: 123,
        },
      ]);

      const known = await ensureDefaultPluginMarketplaces(storageRoot);

      // 默认市场现在有两个：claude-plugins-official（已有记录不被覆盖）+ 唯一 ZCode
      // 官方市场 zcode-plugins-official（缺失时补种）。
      expect(known).toHaveLength(2);
      const claude = known.find((record) => record.id === "claude-plugins-official");
      expect(claude).toMatchObject({
        description: "Custom Claude mirror",
        lastUpdated: "2026-01-02T00:00:00.000Z",
        pluginCount: 123,
        source: { source: "directory", path: join(dir, "custom-claude") },
      });
      expect(
        JSON.parse(await readFile(join(storageRoot, "known_marketplaces.json"), "utf8")),
      ).toMatchObject({
        marketplaces: [
          {
            description: "Custom Claude mirror",
            pluginCount: 123,
          },
          {
            id: "zcode-plugins-official",
          },
        ],
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("lazy-loads a known marketplace manifest before installing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-known-marketplace-install-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "hello");

    try {
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "lazy-market",
          source: { source: "directory", path: marketplaceRoot },
          name: "lazy-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 0,
        },
      ]);
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "lazy-market",
        plugins: [
          {
            name: "hello",
            source: "./plugins/hello",
          },
        ],
      });
      await writePluginManifest(pluginRoot, { name: "hello", skills: "skills" }, ".claude-plugin");
      await mkdir(join(pluginRoot, "skills", "hello"), { recursive: true });
      await writeFile(join(pluginRoot, "skills", "hello", "SKILL.md"), "# hello");

      const install = await installMarketplacePlugin({
        marketplace: "lazy-market",
        name: "hello",
        storageRoot,
      });

      expect(install.closure).toEqual(["hello@lazy-market"]);
      expect(install.installed[0]?.id).toBe("hello@lazy-market");
      expect(
        JSON.parse(
          await readFile(
            join(storageRoot, "marketplaces", "lazy-market", "marketplace.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ name: "lazy-market" });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // 扩展摘要只属于目录（docs/plugins/plugin-publishing.md §4.2）：没有 plugin.json 的条目合成清单时
  // 必须剔除，否则一份不完整的扩展信息会被当成清单内容。
  it("strips the catalog extension summary when it synthesizes a manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-synth-extension-summary-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "ext-entry");

    try {
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "ext-market",
          source: { source: "directory", path: marketplaceRoot },
          name: "ext-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 0,
        },
      ]);
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "ext-market",
        plugins: [
          {
            name: "ext-entry",
            source: "./plugins/ext-entry",
            strict: false,
            skills: "skills",
            displayName: "Ext Entry",
            componentTypes: ["extension"],
            extensionSummary: { engines: { zcode: "^1.4.0" }, grants: ["sessions.read"] },
          },
        ],
      });
      await mkdir(join(pluginRoot, "skills", "ext-entry"), { recursive: true });
      await writeFile(join(pluginRoot, "skills", "ext-entry", "SKILL.md"), "# ext");

      const install = await installMarketplacePlugin({
        marketplace: "ext-market",
        name: "ext-entry",
        storageRoot,
      });
      const installPath = install.installed[0]?.installPath;
      expect(installPath).toBeDefined();
      const manifest = JSON.parse(
        await readFile(join(installPath!, ".claude-plugin", "plugin.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(manifest).toMatchObject({ name: "ext-entry", skills: "skills" });
      expect(manifest).not.toHaveProperty("extensionSummary");
      expect(manifest).not.toHaveProperty("displayName");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("loads Claude-compatible local plugin components", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-"));
    const pluginRoot = join(dir, "ios-plugin");

    try {
      await writePluginManifest(pluginRoot, {
        commands: "commands",
        hooks: "hooks/hooks.json",
        name: "ios-dev",
        skills: "skills",
        userConfig: {
          default_device: {
            default: "iPhone 16",
            type: "string",
          },
        },
      });
      await mkdir(join(pluginRoot, "skills", "ios-dev"), { recursive: true });
      await mkdir(join(pluginRoot, "skills", "pdf-dev"), { recursive: true });
      await mkdir(join(pluginRoot, "commands"), { recursive: true });
      await mkdir(join(pluginRoot, "hooks"), { recursive: true });
      await writeFile(join(pluginRoot, "skills", "ios-dev", "SKILL.md"), "# skill");
      await writeFile(join(pluginRoot, "skills", "pdf-dev", "SKILL.md"), "# skill");
      await writeFile(join(pluginRoot, "commands", "ios-dev.md"), "# command");
      await writeFile(
        join(pluginRoot, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: "startup",
                hooks: [
                  {
                    type: "command",
                    command: '"${CLAUDE_PLUGIN_ROOT}/hooks/session-start"',
                  },
                ],
              },
            ],
          },
        }),
      );
      await writeFile(
        join(pluginRoot, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "ios-simulator": {
              command: "bun",
              args: ["${CLAUDE_PLUGIN_ROOT}/src/mcp/server.ts"],
              cwd: "${ZCODE_PROJECT_DIR}",
              env: {
                IOS_SIM_DEFAULT_DEVICE: "${user_config.default_device}",
                IOS_SIM_PLUGIN_DATA: "${ZCODE_PLUGIN_DATA}",
              },
            },
          },
        }),
      );

      const outcome = await createNodePluginAdapter({
        storageRoot: join(dir, "plugins"),
      }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {},
        storageRoot: join(dir, "plugins"),
        workingDirectory: join(dir, "workspace"),
      });

      expect(outcome.plugins[0]?.id).toBe("ios-dev@inline");
      expect(outcome.plugins[0]).toMatchObject({
        declaredMcpServerNames: ["ios-simulator"],
        hookDetails: [
          {
            command: '"${CLAUDE_PLUGIN_ROOT}/hooks/session-start"',
            event: "SessionStart",
            matcher: "startup",
            runnable: true,
            sourcePath: join(pluginRoot, "hooks", "hooks.json"),
            type: "command",
          },
        ],
        skillCount: 2,
        skillRootCount: 1,
      });
      expect(outcome.skillRoots[0]?.path).toBe(join(pluginRoot, "skills"));
      expect(outcome.commandRoots[0]?.path).toBe(join(pluginRoot, "commands"));
      const mcpKey = "plugin:ios-dev:ios-simulator";
      expect(outcome.mcpServers[mcpKey]).toMatchObject({
        command: "bun",
        cwd: join(dir, "workspace"),
        type: "stdio",
      });
      expect(outcome.mcpServers[mcpKey]?.env).toMatchObject({
        IOS_SIM_DEFAULT_DEVICE: "iPhone 16",
      });
      expect(outcome.hooks.SessionStart?.[0]?.hooks[0]).toMatchObject({
        command: '"${CLAUDE_PLUGIN_ROOT}/hooks/session-start"',
        plugin: {
          id: "ios-dev@inline",
          rootPath: pluginRoot,
        },
        type: "command",
      });

      const disabledOutcome = await createNodePluginAdapter({
        storageRoot: join(dir, "plugins"),
      }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: { "ios-dev@inline": false },
          options: {},
        },
        env: {},
        storageRoot: join(dir, "plugins"),
        workingDirectory: join(dir, "workspace"),
      });
      expect(disabledOutcome.hooks).toEqual({});
      expect(disabledOutcome.plugins[0]).toMatchObject({
        enabled: false,
        hookDetails: [
          {
            event: "SessionStart",
            runnable: true,
          },
        ],
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("loads representative Claude marketplace plugin layouts for skills, commands, and MCP servers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-triplet-marketplace-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const workingDirectory = join(dir, "workspace");
    const cases = claudeMarketplaceTripletFixtures();

    try {
      await mkdir(workingDirectory, { recursive: true });
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "claude-plugins-official",
        plugins: cases.map((fixture) => ({
          name: fixture.name,
          source: `./plugins/${fixture.name}`,
        })),
      });
      for (const fixture of cases) {
        await writeTripletPluginFixture(join(marketplaceRoot, "plugins", fixture.name), fixture);
      }

      // trusted: this fixture legitimately stands up the official catalog from a local dir,
      // mirroring the internal refresh path; the official-id lock only blocks untrusted adds.
      await addMarketplace({
        source: { source: "directory", path: marketplaceRoot },
        storageRoot,
        trustedId: "claude-plugins-official",
      });
      for (const fixture of cases) {
        const install = await installMarketplacePlugin({
          marketplace: "claude-plugins-official",
          name: fixture.name,
          storageRoot,
        });
        expect(install.installed[0]?.id).toBe(`${fixture.name}@claude-plugins-official`);
      }

      const outcome = await createNodePluginAdapter({ storageRoot }).discoverPlugins({
        config: {
          dirs: [],
          enabled: true,
          enabledPlugins: Object.fromEntries(
            cases.map((fixture) => [`${fixture.name}@claude-plugins-official`, true]),
          ),
          options: {},
        },
        env: {},
        storageRoot,
        workingDirectory,
      });

      expect(outcome.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual(
        [],
      );
      expect(outcome.plugins.filter((plugin) => plugin.enabled)).toHaveLength(cases.length);
      expect(outcome.skillRoots).toHaveLength(cases.length);
      expect(outcome.commandRoots).toHaveLength(cases.length);

      for (const fixture of cases) {
        const plugin = outcome.plugins.find(
          (candidate) => candidate.id === `${fixture.name}@claude-plugins-official`,
        );
        expect(plugin).toMatchObject({
          commandRootCount: 1,
          declaredMcpServerNames: [fixture.mcpServerName],
          enabled: true,
          skillCount: fixture.skillCount,
          skillRootCount: 1,
        });
        // 权威 components 随 list 下发：技能名应齐全且与 skillCount 一致（修复「只有数量没有名称」）。
        const skillNames = componentNames(plugin?.components ?? [], "skill");
        expect(skillNames).toHaveLength(fixture.skillCount);
        expect(skillNames).toContain(`${fixture.name}-skill-1`);
        expect(outcome.mcpServers[`plugin:${fixture.name}:${fixture.mcpServerName}`]).toMatchObject(
          {
            command: "node",
            env: {
              PLUGIN_DATA: expect.stringContaining(`${fixture.name}@claude-plugins-official`),
              PROJECT_DIR: workingDirectory,
            },
            type: "stdio",
          },
        );
      }

      const skillOutcome = await createNodeSkillAdapter().discoverSkills({
        roots: outcome.skillRoots,
        workingDirectory,
      });
      const commandOutcome = await createNodeCustomCommandAdapter().discoverCommands({
        roots: outcome.commandRoots,
        workingDirectory,
      });

      expect(skillOutcome.diagnostics).toEqual([]);
      expect(commandOutcome.diagnostics).toEqual([]);
      expect(skillOutcome.skills).toHaveLength(
        cases.reduce((total, fixture) => total + fixture.skillCount, 0),
      );
      expect(commandOutcome.commands).toHaveLength(
        cases.reduce((total, fixture) => total + fixture.commandCount, 0),
      );
      for (const fixture of cases) {
        expect(skillOutcome.skills.map((skill) => skill.name)).toContain(`${fixture.name}-skill-1`);
        expect(commandOutcome.commands.map((command) => command.name)).toContain(
          `${fixture.commandPrefix}:cmd01`,
        );
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("still projects authoritative skill component names for a DISABLED plugin", async () => {
    // 核心回归：停用插件过去走 emptyComponents() 使 skillCount=0，UI join 也拿不到名称，
    // 导致详情弹窗整个技能分组消失。现在 components 由插件根目录权威枚举，与启用态无关。
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-disabled-components-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const workingDirectory = join(dir, "workspace");
    const fixture: TripletPluginFixture = {
      commandCount: 2,
      commandPrefix: "superpowers",
      mcpServerName: "superpowers",
      name: "superpowers",
      skillCount: 14,
    };

    try {
      await mkdir(workingDirectory, { recursive: true });
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "claude-plugins-official",
        plugins: [{ name: fixture.name, source: `./plugins/${fixture.name}` }],
      });
      await writeTripletPluginFixture(join(marketplaceRoot, "plugins", fixture.name), fixture);
      await addMarketplace({
        source: { source: "directory", path: marketplaceRoot },
        storageRoot,
        trustedId: "claude-plugins-official",
      });
      await installMarketplacePlugin({
        marketplace: "claude-plugins-official",
        name: fixture.name,
        storageRoot,
      });

      const outcome = await createNodePluginAdapter({ storageRoot }).discoverPlugins({
        config: {
          dirs: [],
          enabled: true,
          // 显式停用该插件。
          enabledPlugins: { "superpowers@claude-plugins-official": false },
          options: {},
        },
        env: {},
        storageRoot,
        workingDirectory,
      });

      const plugin = outcome.plugins.find(
        (candidate) => candidate.id === "superpowers@claude-plugins-official",
      );
      expect(plugin?.enabled).toBe(false);
      // 停用：runtime 不注入技能根（skillCount=0、skillRootCount=0）……
      expect(plugin?.skillCount).toBe(0);
      expect(outcome.skillRoots).toHaveLength(0);
      // ……但 components 仍权威枚举出全部 14 个技能名，详情 UI 才能展示。
      const skillNames = componentNames(plugin?.components ?? [], "skill");
      expect(skillNames).toHaveLength(14);
      expect(skillNames).toContain("superpowers-skill-1");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("describes a bundled official plugin whose marketplace source is 'filesystem'", async () => {
    // Bugfix 回归：内置 official 插件 seed 时 source 写裸字符串 "filesystem"，describe 过去把它
    // 当路径解析后抛错，市场详情页对内置插件枚举不出组件。现在按 cachePath 直接定位缓存目录。
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-filesystem-describe-"));
    const storageRoot = join(dir, "storage");
    const cacheRoot = join(storageRoot, "cache", "zcode-plugins-official", "superpowers", "5.1.0");
    const marketplaceRoot = join(storageRoot, "marketplaces", "zcode-plugins-official");

    try {
      // 在缓存目录里铺一个含 manifest + 2 个技能的内置插件。
      await writePluginManifest(cacheRoot, {
        name: "superpowers",
        version: "5.1.0",
        skills: "skills",
      });
      for (const skillName of ["brainstorming", "writing-plans"]) {
        const skillDir = join(cacheRoot, "skills", skillName);
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          ["---", `name: ${skillName}`, `description: ${skillName} desc`, "---", "", "# body"].join(
            "\n",
          ),
        );
      }
      // seeded marketplace.json：source 为裸 "filesystem"，并带 cachePath（模拟 bundled-plugins 写入）。
      await mkdir(marketplaceRoot, { recursive: true });
      await writeFile(
        join(marketplaceRoot, "marketplace.json"),
        JSON.stringify({
          name: "zcode-plugins-official",
          version: 1,
          plugins: [
            { name: "superpowers", version: "5.1.0", source: "filesystem", cachePath: cacheRoot },
          ],
        }),
      );

      const result = await describeMarketplacePlugin({
        marketplace: "zcode-plugins-official",
        name: "superpowers",
        storageRoot,
      });

      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(componentNames(result.components, "skill").toSorted()).toEqual([
        "brainstorming",
        "writing-plans",
      ]);
      expect(componentDescription(result.components, "skill", "brainstorming")).toBe(
        "brainstorming desc",
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("describes MCP and hook components from loader-compatible convention files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-describe-components-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "airtable");

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "claude-plugins-official",
        plugins: [
          {
            name: "airtable",
            source: "./plugins/airtable",
          },
        ],
      });
      await writePluginManifest(
        pluginRoot,
        {
          hooks: {
            PreToolUse: [
              {
                hooks: [{ command: "echo pre", type: "command" }],
              },
            ],
          },
          name: "airtable",
          skills: "skills",
        },
        ".claude-plugin",
      );
      await mkdir(join(pluginRoot, "skills", "airtable-overview"), { recursive: true });
      await mkdir(join(pluginRoot, "hooks"), { recursive: true });
      await writeFile(
        join(pluginRoot, "skills", "airtable-overview", "SKILL.md"),
        [
          "---",
          "name: airtable-overview",
          // 用 `>` 折叠块标量覆盖回归：描述应折叠成完整句子，而不是只剩指示符 `>`。
          "description: >",
          "  Explains the Airtable data model and how",
          "  to query bases from the agent.",
          "---",
          "",
          "# Airtable overview",
        ].join("\n"),
      );
      await writeFile(
        join(pluginRoot, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [{ command: "echo stop", type: "command" }],
              },
            ],
          },
        }),
      );
      await writeFile(
        join(pluginRoot, ".mcp.json"),
        JSON.stringify({
          airtable: {
            type: "http",
            url: "https://mcp.airtable.test/mcp",
          },
        }),
      );
      await addMarketplace({
        source: { source: "directory", path: marketplaceRoot },
        storageRoot,
        trustedId: "claude-plugins-official",
      });

      const sourceDescribe = await describeMarketplacePlugin({
        marketplace: "claude-plugins-official",
        name: "airtable",
        storageRoot,
      });
      expect(componentNames(sourceDescribe.components, "skill")).toEqual(["airtable-overview"]);
      expect(componentDescription(sourceDescribe.components, "skill", "airtable-overview")).toBe(
        "Explains the Airtable data model and how to query bases from the agent.",
      );
      expect(componentNames(sourceDescribe.components, "hook")).toEqual(["Stop", "PreToolUse"]);
      expect(componentNames(sourceDescribe.components, "mcp")).toEqual(["airtable"]);

      await installMarketplacePlugin({
        marketplace: "claude-plugins-official",
        name: "airtable",
        storageRoot,
      });
      const cacheDescribe = await describeMarketplacePlugin({
        marketplace: "claude-plugins-official",
        name: "airtable",
        storageRoot,
      });
      expect(componentNames(cacheDescribe.components, "hook")).toEqual(["Stop", "PreToolUse"]);
      expect(componentNames(cacheDescribe.components, "mcp")).toEqual(["airtable"]);

      const outcome = await createNodePluginAdapter({ storageRoot }).discoverPlugins({
        config: {
          dirs: [],
          enabled: true,
          enabledPlugins: {
            "airtable@claude-plugins-official": true,
          },
          options: {},
        },
        env: {},
        storageRoot,
        workingDirectory: dir,
      });
      expect(componentNames(cacheDescribe.components, "mcp")).toEqual(
        outcome.plugins[0]?.declaredMcpServerNames,
      );
      expect(componentNames(cacheDescribe.components, "hook")).toEqual(
        outcome.plugins[0]?.hookDetails.map((hook) => hook.event),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("describes valid components when convention MCP config is invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-describe-invalid-mcp-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "broken-mcp");

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "broken-market",
        plugins: [{ name: "broken-mcp", source: "./plugins/broken-mcp" }],
      });
      await writePluginManifest(
        pluginRoot,
        { name: "broken-mcp", skills: "skills" },
        ".claude-plugin",
      );
      await mkdir(join(pluginRoot, "skills", "still-visible"), { recursive: true });
      await writeFile(join(pluginRoot, "skills", "still-visible", "SKILL.md"), "# skill");
      await writeFile(join(pluginRoot, ".mcp.json"), "{not-json");
      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });

      const result = await describeMarketplacePlugin({
        marketplace: "broken-market",
        name: "broken-mcp",
        storageRoot,
      });

      expect(componentNames(result.components, "skill")).toEqual(["still-visible"]);
      expect(componentNames(result.components, "mcp")).toEqual([]);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "plugin_mcp_read_failed",
          pluginId: "broken-mcp@broken-market",
        }),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("adds a Claude marketplace directory and installs relative plugin sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-marketplace-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "hello");
    const depRoot = join(marketplaceRoot, "plugins", "dep");

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "third-party",
        plugins: [
          {
            name: "hello",
            version: "1.2.3",
            source: "./plugins/hello",
            dependencies: ["dep"],
          },
          {
            name: "dep",
            version: "0.1.0",
            source: "./plugins/dep",
          },
        ],
      });
      await writePluginManifest(
        pluginRoot,
        {
          mcpServers: {
            local: {
              command: "node",
              args: ["${CLAUDE_PLUGIN_ROOT}/server.js"],
            },
          },
          name: "hello",
          skills: "skills",
        },
        ".claude-plugin",
      );
      await mkdir(join(pluginRoot, "skills", "hello"), { recursive: true });
      await writeFile(join(pluginRoot, "skills", "hello", "SKILL.md"), "# hello");
      await writePluginManifest(depRoot, { name: "dep" }, ".claude-plugin");

      const marketplace = await addMarketplace({
        source: { source: "directory", path: marketplaceRoot },
        storageRoot,
      });
      expect(marketplace.id).toBe("third-party");

      const validation = await validateMarketplacePlugin({
        marketplace: "third-party",
        name: "hello",
        storageRoot,
      });
      expect(validation.filter((item) => item.severity === "error")).toEqual([]);

      const install = await installMarketplacePlugin({
        marketplace: "third-party",
        name: "hello",
        storageRoot,
      });
      expect(install.closure).toEqual(["dep@third-party", "hello@third-party"]);
      expect(listInstalledPluginRecords(storageRoot).map((record) => record.id)).toEqual([
        "dep@third-party",
        "hello@third-party",
      ]);

      const outcome = await createNodePluginAdapter({ storageRoot }).discoverPlugins({
        config: {
          dirs: [],
          enabled: true,
          enabledPlugins: {
            "hello@third-party": true,
          },
          options: {},
        },
        env: {},
        storageRoot,
        workingDirectory: dir,
      });
      expect(outcome.plugins.find((plugin) => plugin.id === "hello@third-party")).toMatchObject({
        enabled: true,
        source: "cache",
      });
      expect(outcome.skillRoots[0]?.path).toContain(join("hello", "1.2.3", "skills"));
      expect(outcome.mcpServers["plugin:hello:local"]).toMatchObject({
        command: "node",
        type: "stdio",
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("installs Claude marketplace url sources that point at pinned plugin subdirectories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-marketplace-url-path-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const repoRoot = join(dir, "remote-plugin");
    const pluginRoot = join(repoRoot, "claude-plugin", "atomic-agents");

    try {
      await mkdir(repoRoot, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: repoRoot });
      await writePluginManifest(
        pluginRoot,
        {
          commands: "commands",
          name: "wrong-name",
        },
        ".claude-plugin",
      );
      await execFileAsync("git", ["add", "."], { cwd: repoRoot });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=ZCode Test",
          "-c",
          "user.email=zcode-test@example.com",
          "commit",
          "-m",
          "wrong plugin",
        ],
        { cwd: repoRoot },
      );
      await writePluginManifest(
        pluginRoot,
        {
          commands: "commands",
          name: "atomic-agents",
        },
        ".claude-plugin",
      );
      await mkdir(join(pluginRoot, "commands"), { recursive: true });
      await writeFile(join(pluginRoot, "commands", "agent.md"), "# agent");
      await execFileAsync("git", ["add", "."], { cwd: repoRoot });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=ZCode Test",
          "-c",
          "user.email=zcode-test@example.com",
          "commit",
          "-m",
          "test plugin",
        ],
        { cwd: repoRoot },
      );
      const pinnedCommit = (
        await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })
      ).stdout.trim();
      await writePluginManifest(
        pluginRoot,
        {
          commands: "commands",
          name: "wrong-name-after-pin",
        },
        ".claude-plugin",
      );
      await execFileAsync("git", ["add", "."], { cwd: repoRoot });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=ZCode Test",
          "-c",
          "user.email=zcode-test@example.com",
          "commit",
          "-m",
          "wrong plugin after pin",
        ],
        { cwd: repoRoot },
      );
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "official-like-url-path",
        plugins: [
          {
            name: "atomic-agents",
            source: {
              source: "url",
              url: repoRoot,
              path: "claude-plugin/atomic-agents",
              commit: pinnedCommit,
            },
          },
        ],
      });

      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });
      const diagnostics = await validateMarketplacePlugin({
        marketplace: "official-like-url-path",
        name: "atomic-agents",
        storageRoot,
      });
      expect(diagnostics.filter((item) => item.severity === "error")).toEqual([]);

      const install = await installMarketplacePlugin({
        marketplace: "official-like-url-path",
        name: "atomic-agents",
        storageRoot,
      });
      expect(install.installed[0]?.id).toBe("atomic-agents@official-like-url-path");

      const outcome = await createNodePluginAdapter({ storageRoot }).discoverPlugins({
        config: {
          dirs: [],
          enabled: true,
          enabledPlugins: {
            "atomic-agents@official-like-url-path": true,
          },
          options: {},
        },
        env: {},
        storageRoot,
        workingDirectory: dir,
      });
      expect(outcome.commandRoots[0]?.path).toContain(join("atomic-agents", "0.0.0", "commands"));
      const installedManifest = await readFile(
        join(
          storageRoot,
          "cache",
          "official-like-url-path",
          "atomic-agents",
          "0.0.0",
          ".claude-plugin",
          "plugin.json",
        ),
        "utf8",
      );
      expect(JSON.parse(installedManifest)).toMatchObject({ name: "atomic-agents" });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // Bugfix(插件版本 0.0.0)：git/url 源插件（如 superpowers）的 marketplace 条目通常不带 version，
  // 旧逻辑用 entry.version ?? "0.0.0" 拼缓存路径，导致 Root path 落到 .../<name>/0.0.0，而 UI 展示
  // 读插件自带 plugin.json 的真实版本（6.0.3），两者割裂。修复后缓存路径段与安装记录均取真实版本。
  it("uses the cloned plugin.json version for the cache path when the marketplace entry omits version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-version-from-manifest-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const repoRoot = join(dir, "remote-plugin");

    try {
      await mkdir(repoRoot, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: repoRoot });
      // 真实版本只存在于插件自带 manifest 里，marketplace 条目刻意不写 version。
      await writePluginManifest(
        repoRoot,
        { name: "superpowers", version: "6.0.3" },
        ".claude-plugin",
      );
      await execFileAsync("git", ["add", "."], { cwd: repoRoot });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=ZCode Test",
          "-c",
          "user.email=zcode-test@example.com",
          "commit",
          "-m",
          "superpowers plugin",
        ],
        { cwd: repoRoot },
      );
      const pinnedCommit = (
        await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })
      ).stdout.trim();

      await writeMarketplaceManifest(marketplaceRoot, {
        name: "claude-plugins-official",
        plugins: [
          {
            name: "superpowers",
            source: { source: "url", url: repoRoot, sha: pinnedCommit },
          },
        ],
      });

      await addMarketplace({
        source: { source: "directory", path: marketplaceRoot },
        storageRoot,
        trustedId: "claude-plugins-official",
      });
      const install = await installMarketplacePlugin({
        marketplace: "claude-plugins-official",
        name: "superpowers",
        storageRoot,
      });

      const record = install.installed.find(
        (item) => item.id === "superpowers@claude-plugins-official",
      );
      expect(record?.version).toBe("6.0.3");
      expect(record?.installPath).toContain(join("superpowers", "6.0.3"));
      expect(record?.installPath).not.toContain(join("superpowers", "0.0.0"));

      const installedManifest = await readFile(
        join(
          storageRoot,
          "cache",
          "claude-plugins-official",
          "superpowers",
          "6.0.3",
          ".claude-plugin",
          "plugin.json",
        ),
        "utf8",
      );
      expect(JSON.parse(installedManifest)).toMatchObject({
        name: "superpowers",
        version: "6.0.3",
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("installs a marketplace plugin from a real zip URL source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-marketplace-url-zip-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    let server: Server | undefined;

    try {
      const zipBuffer = createStoredZip([
        {
          path: "cdn-plugin-1.2.3/.claude-plugin/plugin.json",
          content: JSON.stringify({
            commands: "commands",
            name: "cdn-plugin",
            version: "1.2.3",
          }),
        },
        {
          path: "cdn-plugin-1.2.3/commands/deploy.md",
          content: [
            "---",
            "description: Deploy through CDN plugin",
            "allowed-tools: Bash",
            "---",
            "",
            "Run deploy with $ARGUMENTS.",
          ].join("\n"),
        },
      ]);
      const sha256 = sha256Buffer(zipBuffer);
      const fixture = await startZipFixtureServer({ "/cdn-plugin.zip": zipBuffer });
      server = fixture.server;

      await writeMarketplaceManifest(marketplaceRoot, {
        name: "cdn-market",
        plugins: [
          {
            name: "cdn-plugin",
            source: {
              source: "url",
              type: "zip",
              url: `${fixture.baseUrl}/cdn-plugin.zip`,
              sha256,
            },
          },
        ],
      });

      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });

      const diagnostics = await validateMarketplacePlugin({
        marketplace: "cdn-market",
        name: "cdn-plugin",
        storageRoot,
      });
      expect(diagnostics.filter((item) => item.severity === "error")).toEqual([]);

      const sourceDescribe = await describeMarketplacePlugin({
        marketplace: "cdn-market",
        name: "cdn-plugin",
        storageRoot,
      });
      expect(componentNames(sourceDescribe.components, "command")).toEqual(["deploy"]);

      const install = await installMarketplacePlugin({
        marketplace: "cdn-market",
        name: "cdn-plugin",
        storageRoot,
      });
      const record = install.installed.find((item) => item.id === "cdn-plugin@cdn-market");
      expect(record).toMatchObject({
        marketplace: "cdn-market",
        name: "cdn-plugin",
        version: "1.2.3",
      });
      expect(record?.installPath).toContain(join("cache", "cdn-market", "cdn-plugin", "1.2.3"));
      expect(record?.source).toMatchObject({ source: "url", type: "zip", sha256 });

      const outcome = await createNodePluginAdapter({ storageRoot }).discoverPlugins({
        config: {
          dirs: [],
          enabled: true,
          enabledPlugins: {
            "cdn-plugin@cdn-market": true,
          },
          options: {},
        },
        env: {},
        storageRoot,
        workingDirectory: dir,
      });
      expect(outcome.plugins.find((plugin) => plugin.id === "cdn-plugin@cdn-market")).toMatchObject(
        {
          version: "1.2.3",
        },
      );
      expect(outcome.commandRoots[0]?.path).toContain(join("cdn-plugin", "1.2.3", "commands"));
    } finally {
      await closeServer(server);
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not fall back to a local plugin when an explicit URL source is invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-invalid-url-source-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "invalid-url-market",
        plugins: [
          {
            name: "invalid-url-plugin",
            source: {
              source: "url",
              type: "zip",
              sha256: "0".repeat(64),
            },
          },
        ],
      });
      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });
      const localFallbackRoot = join(
        storageRoot,
        "marketplaces",
        "invalid-url-market",
        "invalid-url-plugin",
      );
      await writePluginManifest(localFallbackRoot, {
        name: "invalid-url-plugin",
        version: "1.0.0",
      });

      await expect(
        installMarketplacePlugin({
          marketplace: "invalid-url-market",
          name: "invalid-url-plugin",
          storageRoot,
        }),
      ).rejects.toThrow(/requires a non-empty url/u);
      expect(listInstalledPluginRecords(storageRoot)).toEqual([]);
      expect(existsSync(join(storageRoot, "cache", "invalid-url-market"))).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reports invalid zip source option shapes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-invalid-zip-shape-"));
    const marketplaceRoot = join(dir, "marketplace");

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "invalid-zip-shape-market",
        plugins: [
          {
            name: "invalid-headers",
            source: {
              headers: [],
              sha256: "0".repeat(64),
              source: "url",
              type: "zip",
              url: "https://cdn.example.com/plugin.zip",
            },
          },
          {
            name: "invalid-path",
            source: {
              path: 42,
              sha256: "0".repeat(64),
              source: "url",
              type: "zip",
              url: "https://cdn.example.com/plugin.zip",
            },
          },
          {
            name: "invalid-strip-root",
            source: {
              sha256: "0".repeat(64),
              source: "url",
              stripRoot: "true",
              type: "zip",
              url: "https://cdn.example.com/plugin.zip",
            },
          },
        ],
      });

      const diagnostics = await validateMarketplaceSource({
        source: { source: "directory", path: marketplaceRoot },
        storageRoot: join(dir, "storage"),
      });
      const errors = diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => diagnostic.message);
      expect(errors).toEqual(
        expect.arrayContaining([
          "Plugin zip source headers must be an object",
          "Plugin zip source path must be a string",
          "Plugin zip source stripRoot must be a boolean",
        ]),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("retries source cleanup without replacing the primary error", async () => {
    const cleanupError = new Error("temporary directory is locked");
    const cleanup = vi.fn(async () => {
      throw cleanupError;
    });

    const returnedCleanupError = await cleanupPluginSourceBestEffort(cleanup, [0, 0, 0]);
    const primaryError = new Error("Plugin zip sha256 mismatch");
    const combinedError = appendPluginSourceCleanupError(primaryError, returnedCleanupError);

    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(returnedCleanupError).toBe(cleanupError);
    expect(combinedError).toBe(primaryError);
    expect(primaryError.message).toContain("Plugin zip sha256 mismatch");
    expect(primaryError.message).toContain("plugin source cleanup also failed");
    expect(primaryError.message).toContain("temporary directory is locked");
  });

  it.each([
    { persistent: false, proxied: true },
    { persistent: true, proxied: true },
    { persistent: false, proxied: false },
    { persistent: true, proxied: false },
  ])(
    "retries a reset ZIP connection once ($persistent, proxy=$proxied)",
    async ({ persistent, proxied }) => {
      const zipBuffer = createStoredZip([
        {
          path: ".claude-plugin/plugin.json",
          content: JSON.stringify({ name: "reset-zip", version: "1.0.0" }),
        },
      ]);
      let requestCount = 0;
      const proxy = createServer((request, response) => {
        requestCount += 1;
        if (persistent || requestCount === 1) {
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { "content-type": "application/zip" });
        response.end(zipBuffer);
      });
      let resolved: Awaited<ReturnType<typeof resolveZipPluginSource>> | undefined;
      try {
        const proxyBaseUrl = await listenLoopbackServer(proxy);
        vi.stubEnv(ZCODE_HTTP_PROXY_ENV_KEY, proxied ? proxyBaseUrl : "");
        vi.stubEnv(ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY, "{}");
        vi.stubEnv(ZCODE_NO_PROXY_ENV_KEY, "");
        const download = resolveZipPluginSource({
          sha256: sha256Buffer(zipBuffer),
          url: proxied ? "http://127.0.0.2/reset.zip" : `${proxyBaseUrl}/reset.zip`,
        });
        if (persistent) {
          await expect(download).rejects.toMatchObject({
            code: proxied ? "proxy_error" : "network_error",
          });
        } else {
          resolved = await download;
          expect(
            JSON.parse(await readFile(join(resolved.path, ".claude-plugin/plugin.json"), "utf8")),
          ).toEqual({ name: "reset-zip", version: "1.0.0" });
        }
        expect(requestCount).toBe(2);
      } finally {
        await resolved?.cleanup();
        await closeServer(proxy);
      }
    },
  );

  it.each(["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "ENOTFOUND"])(
    "does not retry ZIP failures with code %s",
    async (code) => {
      const fetchMock = vi.fn().mockRejectedValue(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("download failed"), { code }),
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        resolveZipPluginSource({
          sha256: "0".repeat(64),
          url: "https://cdn.example.com/plugin.zip",
        }),
      ).rejects.toMatchObject({ code: "network_error" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("cancels ZIP download without retrying a reset connection", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      resolveZipPluginSource({
        sha256: "0".repeat(64),
        url: "https://cdn.example.com/plugin.zip",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("downloads a zip through captured user proxy env", async () => {
    const zipBuffer = createStoredZip([
      {
        path: ".claude-plugin/plugin.json",
        content: JSON.stringify({ name: "proxied-zip", version: "1.0.0" }),
      },
    ]);
    const proxyRequests: string[] = [];
    const proxy = createServer((request, response) => {
      proxyRequests.push(request.url ?? "");
      response.writeHead(200, {
        "content-length": String(zipBuffer.byteLength),
        "content-type": "application/zip",
      });
      response.end(zipBuffer);
    });
    let resolved: Awaited<ReturnType<typeof resolveZipPluginSource>> | undefined;

    try {
      const proxyBaseUrl = await listenLoopbackServer(proxy);
      vi.stubEnv(ZCODE_HTTP_PROXY_ENV_KEY, "");
      vi.stubEnv(ZCODE_NO_PROXY_ENV_KEY, "");
      vi.stubEnv(ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY, JSON.stringify({ HTTP_PROXY: proxyBaseUrl }));

      const sourceUrl = "http://127.0.0.2/captured-proxy.zip";
      resolved = await resolveZipPluginSource({
        sha256: sha256Buffer(zipBuffer),
        url: sourceUrl,
      });

      expect(existsSync(join(resolved.path, ".claude-plugin", "plugin.json"))).toBe(true);
      expect(proxyRequests).toEqual([sourceUrl]);
    } finally {
      await resolved?.cleanup();
      await closeServer(proxy);
    }
  });

  it("drops custom zip headers on cross-origin redirects", async () => {
    const zipBuffer = createStoredZip([
      {
        path: ".claude-plugin/plugin.json",
        content: JSON.stringify({ name: "redirected-zip", version: "1.0.0" }),
      },
    ]);
    let originHeader: string | undefined;
    let targetHeader: string | undefined;
    const target = createServer((request, response) => {
      targetHeader = request.headers["x-zcode-channel"] as string | undefined;
      response.writeHead(200, {
        "content-length": String(zipBuffer.byteLength),
        "content-type": "application/zip",
      });
      response.end(zipBuffer);
    });
    let origin: Server | undefined;
    let resolved: Awaited<ReturnType<typeof resolveZipPluginSource>> | undefined;

    try {
      const targetBaseUrl = await listenLoopbackServer(target);
      origin = createServer((request, response) => {
        originHeader = request.headers["x-zcode-channel"] as string | undefined;
        response.writeHead(302, { location: `${targetBaseUrl}/plugin.zip` });
        response.end();
      });
      const originBaseUrl = await listenLoopbackServer(origin);
      vi.stubEnv(ZCODE_NO_PROXY_ENV_KEY, "127.0.0.1");

      resolved = await resolveZipPluginSource({
        headers: { "x-zcode-channel": "internal" },
        sha256: sha256Buffer(zipBuffer),
        url: `${originBaseUrl}/redirect.zip`,
      });

      expect(originHeader).toBe("internal");
      expect(targetHeader).toBeUndefined();
    } finally {
      await resolved?.cleanup();
      await closeServer(origin);
      await closeServer(target);
    }
  });

  it("rejects a zip redirect to non-loopback HTTP", async () => {
    const origin = createServer((_request, response) => {
      response.writeHead(302, { location: "http://example.com/plugin.zip" });
      response.end();
    });

    try {
      const originBaseUrl = await listenLoopbackServer(origin);
      vi.stubEnv(ZCODE_NO_PROXY_ENV_KEY, "127.0.0.1");

      await expect(
        resolveZipPluginSource({
          sha256: "0".repeat(64),
          url: `${originBaseUrl}/redirect.zip`,
        }),
      ).rejects.toThrow(/must be HTTPS/u);
    } finally {
      await closeServer(origin);
    }
  });

  it("rejects a zip root without a manifest before replacing existing cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-marketplace-url-zip-root-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const existingCacheRoot = join(
      storageRoot,
      "cache",
      "invalid-root-market",
      "invalid-root",
      "1.0.0",
    );
    let server: Server | undefined;

    try {
      const zipBuffer = createStoredZip([
        {
          path: "bundle-a/README.md",
          content: "First top-level directory.",
        },
        {
          path: "bundle-b/.claude-plugin/plugin.json",
          content: JSON.stringify({ name: "invalid-root", version: "1.0.0" }),
        },
      ]);
      const fixture = await startZipFixtureServer({ "/invalid-root.zip": zipBuffer });
      server = fixture.server;

      await writeMarketplaceManifest(marketplaceRoot, {
        name: "invalid-root-market",
        plugins: [
          {
            name: "invalid-root",
            version: "1.0.0",
            source: {
              source: "url",
              type: "zip",
              url: `${fixture.baseUrl}/invalid-root.zip`,
              sha256: sha256Buffer(zipBuffer),
            },
          },
        ],
      });
      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });
      await mkdir(existingCacheRoot, { recursive: true });
      await writeFile(join(existingCacheRoot, "keep.txt"), "existing cache");

      await expect(
        installMarketplacePlugin({
          marketplace: "invalid-root-market",
          name: "invalid-root",
          storageRoot,
        }),
      ).rejects.toThrow("Plugin manifest not found: invalid-root@invalid-root-market");
      expect(await readFile(join(existingCacheRoot, "keep.txt"), "utf8")).toBe("existing cache");
      expect(listInstalledPluginRecords(storageRoot)).toEqual([]);
    } finally {
      await closeServer(server);
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects marketplace zip sources with mismatched sha256 without installing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-marketplace-url-zip-sha-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    let server: Server | undefined;

    try {
      const zipBuffer = createStoredZip([
        {
          path: ".claude-plugin/plugin.json",
          content: JSON.stringify({ name: "bad-zip", version: "1.0.0" }),
        },
      ]);
      const fixture = await startZipFixtureServer({ "/bad.zip": zipBuffer });
      server = fixture.server;

      await writeMarketplaceManifest(marketplaceRoot, {
        name: "bad-zip-market",
        plugins: [
          {
            name: "bad-zip",
            source: {
              source: "url",
              type: "zip",
              url: `${fixture.baseUrl}/bad.zip`,
              sha256: "0".repeat(64),
            },
          },
        ],
      });
      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });

      await expect(
        installMarketplacePlugin({
          marketplace: "bad-zip-market",
          name: "bad-zip",
          storageRoot,
        }),
      ).rejects.toThrow("sha256 mismatch");
      expect(listInstalledPluginRecords(storageRoot)).toEqual([]);
      expect(existsSync(join(storageRoot, "cache", "bad-zip-market", "bad-zip"))).toBe(false);
    } finally {
      await closeServer(server);
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects unsafe zip entry paths before cache materialization", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-marketplace-url-zip-slip-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    let server: Server | undefined;

    try {
      const zipBuffer = createStoredZip([
        {
          path: "../escape.txt",
          content: "escape",
        },
        {
          path: ".claude-plugin/plugin.json",
          content: JSON.stringify({ name: "zip-slip", version: "1.0.0" }),
        },
      ]);
      const fixture = await startZipFixtureServer({ "/slip.zip": zipBuffer });
      server = fixture.server;

      await writeMarketplaceManifest(marketplaceRoot, {
        name: "zip-slip-market",
        plugins: [
          {
            name: "zip-slip",
            source: {
              source: "url",
              type: "zip",
              url: `${fixture.baseUrl}/slip.zip`,
              sha256: sha256Buffer(zipBuffer),
            },
          },
        ],
      });
      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });

      await expect(
        installMarketplacePlugin({
          marketplace: "zip-slip-market",
          name: "zip-slip",
          storageRoot,
        }),
      ).rejects.toThrow(/Unsafe plugin zip path|invalid relative path/u);
      expect(listInstalledPluginRecords(storageRoot)).toEqual([]);
      expect(existsSync(join(storageRoot, "cache", "zip-slip-market", "zip-slip"))).toBe(false);
    } finally {
      await closeServer(server);
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("adds a public GitHub marketplace and installs its GitHub plugin without system Git", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-github-archive-no-git-"));
    const storageRoot = join(dir, "storage");
    const marketplaceArchive = createStoredZip([
      {
        path: "catalog-release/.claude-plugin/marketplace.json",
        content: JSON.stringify({
          name: "archive-market",
          plugins: [
            {
              name: "archive-plugin",
              source: {
                source: "github",
                repo: "acme/archive-plugin",
                sha: "abc123def456",
                path: "packages/archive-plugin",
              },
            },
          ],
        }),
      },
    ]);
    const pluginArchive = createStoredZip([
      {
        path: "archive-plugin-abc123/packages/archive-plugin/.claude-plugin/plugin.json",
        content: JSON.stringify({ name: "archive-plugin", version: "1.2.3" }),
      },
      {
        path: "archive-plugin-abc123/packages/archive-plugin/skills/demo/SKILL.md",
        content: "# demo",
      },
    ]);
    const requestedUrls: string[] = [];

    try {
      vi.stubEnv("PATH", join(dir, "no-system-git"));
      vi.stubEnv("HTTP_PROXY", "");
      vi.stubEnv("HTTPS_PROXY", "");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL | Request) => {
          const value = String(url);
          requestedUrls.push(value);
          const body = value.includes("/acme/archive-plugin/") ? pluginArchive : marketplaceArchive;
          return new Response(body, {
            headers: { "content-type": "application/zip" },
            status: 200,
          });
        }),
      );

      const marketplace = await addMarketplace({
        source: { source: "github", repo: "acme/catalog", ref: "release" },
        storageRoot,
      });
      const install = await installMarketplacePlugin({
        marketplace: "archive-market",
        name: "archive-plugin",
        storageRoot,
      });

      expect(marketplace.id).toBe("archive-market");
      expect(requestedUrls).toEqual([
        "https://api.github.com/repos/acme/catalog/zipball/release",
        "https://api.github.com/repos/acme/archive-plugin/zipball/abc123def456",
      ]);
      expect(install.installed[0]).toMatchObject({
        id: "archive-plugin@archive-market",
        version: "1.2.3",
      });
      expect(
        existsSync(join(install.installed[0]?.installPath ?? "", "skills", "demo", "SKILL.md")),
      ).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("preserves Git sparse checkout semantics for public GitHub marketplace sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-github-sparse-marketplace-"));
    const storageRoot = join(dir, "storage");
    const archive = createStoredZip([
      {
        path: "catalog-main/.claude-plugin/marketplace.json",
        content: JSON.stringify({ name: "sparse-market", plugins: [] }),
      },
    ]);
    const fetchMock = vi.fn(
      async () =>
        new Response(archive, { headers: { "content-type": "application/zip" }, status: 200 }),
    );

    try {
      vi.stubEnv("PATH", join(dir, "no-system-git"));
      vi.stubEnv("HTTP_PROXY", "");
      vi.stubEnv("HTTPS_PROXY", "");
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        addMarketplace({
          source: {
            source: "github",
            repo: "acme/sparse-catalog",
            sparsePaths: [".claude-plugin"],
          },
          storageRoot,
        }),
      ).rejects.toThrow(/System Git is required.*acme\/sparse-catalog.*Agent Host/u);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("falls back to Git when a plugin subdirectory inherits LFS attributes from an ancestor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-github-ancestor-lfs-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const archive = createStoredZip([
      {
        path: "lfs-plugin-main/packages/.gitattributes",
        content: "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      },
      {
        path: "lfs-plugin-main/packages/plugin/.claude-plugin/plugin.json",
        content: JSON.stringify({ name: "lfs-plugin", version: "1.0.0" }),
      },
      {
        path: "lfs-plugin-main/packages/plugin/model.bin",
        content:
          "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef\nsize 42\n",
      },
    ]);

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "ancestor-lfs-market",
        plugins: [
          {
            name: "lfs-plugin",
            source: {
              source: "github",
              repo: "acme/lfs-plugin",
              path: "packages/plugin",
            },
          },
        ],
      });
      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });
      vi.stubEnv("PATH", join(dir, "no-system-git"));
      vi.stubEnv("HTTP_PROXY", "");
      vi.stubEnv("HTTPS_PROXY", "");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(archive, {
              headers: { "content-type": "application/zip" },
              status: 200,
            }),
        ),
      );

      await expect(
        installMarketplacePlugin({
          marketplace: "ancestor-lfs-market",
          name: "lfs-plugin",
          storageRoot,
        }),
      ).rejects.toThrow(/System Git is required.*acme\/lfs-plugin.*Agent Host/u);
      expect(listInstalledPluginRecords(storageRoot)).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "git",
      {
        source: "git",
        url: "https://github.com/acme/source-variants.git",
        ref: "ignored-ref",
        sha: "pinned-sha",
        path: "packages/source-variant",
      },
    ],
    [
      "url:git",
      {
        source: "url",
        type: "git",
        url: "https://github.com/acme/source-variants.git",
        ref: "ignored-ref",
        commit: "pinned-sha",
        path: "packages/source-variant",
      },
    ],
    [
      "git-subdir",
      {
        source: "git-subdir",
        url: "acme/source-variants",
        ref: "ignored-ref",
        sha: "pinned-sha",
        path: "packages/source-variant",
      },
    ],
  ])(
    "materializes public GitHub %s plugin sources through the pinned Archive",
    async (_label, source) => {
      const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-github-source-variant-"));
      const storageRoot = join(dir, "storage");
      const marketplaceRoot = join(dir, "marketplace");
      const archive = createStoredZip([
        {
          path: "source-variants-pin/packages/source-variant/.claude-plugin/plugin.json",
          content: JSON.stringify({ name: "source-variant", version: "2.0.0" }),
        },
      ]);
      const fetchMock = vi.fn(
        async () =>
          new Response(archive, { headers: { "content-type": "application/zip" }, status: 200 }),
      );

      try {
        await writeMarketplaceManifest(marketplaceRoot, {
          name: "source-variant-market",
          plugins: [{ name: "source-variant", source }],
        });
        await addMarketplace({
          source: { source: "directory", path: marketplaceRoot },
          storageRoot,
        });
        vi.stubEnv("PATH", join(dir, "no-system-git"));
        vi.stubEnv("HTTP_PROXY", "");
        vi.stubEnv("HTTPS_PROXY", "");
        vi.stubGlobal("fetch", fetchMock);

        const install = await installMarketplacePlugin({
          marketplace: "source-variant-market",
          name: "source-variant",
          storageRoot,
        });

        expect(fetchMock).toHaveBeenCalledWith(
          "https://api.github.com/repos/acme/source-variants/zipball/pinned-sha",
          expect.anything(),
        );
        expect(install.installed[0]?.version).toBe("2.0.0");
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
  );

  it("returns an actionable error when a non-GitHub source requires unavailable system Git", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-system-git-unavailable-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "git-required-market",
        plugins: [
          {
            name: "private-plugin",
            source: {
              source: "git",
              url: "ssh://git@example.test/private/plugin.git",
            },
          },
        ],
      });
      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });
      vi.stubEnv("PATH", join(dir, "no-system-git"));

      await expect(
        installMarketplacePlugin({
          marketplace: "git-required-market",
          name: "private-plugin",
          storageRoot,
        }),
      ).rejects.toThrow(
        /System Git is required.*ssh:\/\/example\.test\/private\/plugin\.git.*Agent Host/u,
      );
      expect(listInstalledPluginRecords(storageRoot)).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("redacts Git URL credentials from unavailable and persisted refresh diagnostics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-git-credential-redaction-"));
    const storageRoot = join(dir, "storage");
    const credentialSource = "https://private-user:private-secret@example.test/plugins.git";
    try {
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "credential-market",
          source: { source: "git", url: credentialSource },
          name: "credential-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 0,
        },
      ]);
      vi.stubEnv("ZCODE_GIT_BINARY", join(dir, "missing-git"));

      expect(await updateMarketplace({ marketplace: "credential-market", storageRoot })).toEqual(
        [],
      );
      const message = loadKnownMarketplacesSync(storageRoot)[0]?.lastRefreshFailure?.message ?? "";
      expect(message).toContain("https://example.test/plugins.git");
      expect(message).not.toContain("private-user");
      expect(message).not.toContain("private-secret");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("redacts credentials from nested GitHub Archive failure messages", () => {
    const error = createArchiveFetchError(
      "https://source-user:source-secret@github.com/acme/plugin.git",
      new Error(
        "request to https://cause-user:cause-secret@codeload.github.com/acme/plugin/zip failed",
      ),
    );

    expect(error.message).toContain("https://github.com/acme/plugin.git");
    expect(error.message).toContain("https://codeload.github.com/acme/plugin/zip");
    expect(error.message).not.toMatch(/source-user|source-secret|cause-user|cause-secret/u);
    expect((error.cause as Error | undefined)?.message).not.toMatch(/cause-user|cause-secret/u);
  });

  it("does not fall back to system Git for a GitHub Archive server failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-github-archive-network-failure-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "archive-failure-market",
        plugins: [
          {
            name: "archive-failure",
            source: { source: "git", url: "https://github.com/acme/archive-failure.git" },
          },
        ],
      });
      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });
      vi.stubEnv("PATH", join(dir, "no-system-git"));
      vi.stubEnv("HTTP_PROXY", "");
      vi.stubEnv("HTTPS_PROXY", "");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("unavailable", { status: 503 })),
      );

      await expect(
        installMarketplacePlugin({
          marketplace: "archive-failure-market",
          name: "archive-failure",
          storageRoot,
        }),
      ).rejects.toThrow(/Failed to materialize public GitHub plugin source archive.*503/u);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("falls back from an anonymous GitHub 404 and explains when system Git is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-github-private-fallback-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "private-github-market",
        plugins: [
          {
            name: "private-github",
            source: { source: "github", repo: "acme/private-github" },
          },
        ],
      });
      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });
      vi.stubEnv("PATH", join(dir, "no-system-git"));
      vi.stubEnv("HTTP_PROXY", "");
      vi.stubEnv("HTTPS_PROXY", "");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("not found", { status: 404 })),
      );

      await expect(
        installMarketplacePlugin({
          marketplace: "private-github-market",
          name: "private-github",
          storageRoot,
        }),
      ).rejects.toThrow(
        /System Git is required.*https:\/\/github\.com\/acme\/private-github\.git/u,
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("isolates marketplace refresh failures and clears the persisted failure after recovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-marketplace-refresh-isolation-"));
    const storageRoot = join(dir, "storage");
    const goodSource = join(dir, "good-source");
    const badSource = join(dir, "bad-source");
    const oldBadSnapshot = join(storageRoot, "marketplaces", "bad-market");

    try {
      await writeMarketplaceManifest(goodSource, {
        name: "good-market",
        plugins: [{ name: "good-v2", source: "./good-v2" }],
      });
      await mkdir(oldBadSnapshot, { recursive: true });
      await writeFile(
        join(oldBadSnapshot, "marketplace.json"),
        JSON.stringify({ name: "bad-market", plugins: [{ name: "bad-v1", source: "./bad-v1" }] }),
      );
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "good-market",
          source: { source: "directory", path: goodSource },
          name: "good-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-01T00:00:00.000Z",
          pluginCount: 1,
        },
        {
          id: "bad-market",
          source: { source: "directory", path: badSource },
          name: "bad-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-01T00:00:00.000Z",
          pluginCount: 1,
        },
      ]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("[]", { status: 200 })),
      );

      const updated = await updateMarketplace({ storageRoot });

      expect(updated.map((record) => record.id)).toContain("good-market");
      expect(loadMarketplaceManifestSync(storageRoot, "bad-market")?.plugins[0]?.name).toBe(
        "bad-v1",
      );
      expect(
        loadKnownMarketplacesSync(storageRoot).find((record) => record.id === "bad-market")
          ?.lastRefreshFailure,
      ).toMatchObject({ code: "plugin_marketplace_invalid", failedAt: expect.any(String) });

      await writeMarketplaceManifest(badSource, {
        name: "bad-market",
        plugins: [{ name: "bad-v2", source: "./bad-v2" }],
      });
      await updateMarketplace({ marketplace: "bad-market", storageRoot });

      expect(loadMarketplaceManifestSync(storageRoot, "bad-market")?.plugins[0]?.name).toBe(
        "bad-v2",
      );
      expect(
        loadKnownMarketplacesSync(storageRoot).find((record) => record.id === "bad-market")
          ?.lastRefreshFailure,
      ).toBeUndefined();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not persist an operation cancellation as a marketplace refresh failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-marketplace-refresh-cancel-"));
    const storageRoot = join(dir, "storage");
    const controller = new AbortController();

    try {
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "cancelled-market",
          source: { source: "github", repo: "acme/cancelled-market" },
          name: "cancelled-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-01T00:00:00.000Z",
          pluginCount: 0,
        },
      ]);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              const signal = init?.signal;
              if (signal?.aborted) {
                reject(signal.reason);
                return;
              }
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        ),
      );

      const refresh = updateMarketplace({
        marketplace: "cancelled-market",
        signal: controller.signal,
        storageRoot,
      });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
      controller.abort();

      await expect(refresh).rejects.toBeDefined();
      expect(
        loadKnownMarketplacesSync(storageRoot).find((record) => record.id === "cancelled-market")
          ?.lastRefreshFailure,
      ).toBeUndefined();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps the previous Claude settings snapshot when timeout fires during manifest persistence", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-claude-settings-timeout-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(storageRoot, "marketplaces", "claude-plugins-official");

    try {
      await mkdir(marketplaceRoot, { recursive: true });
      await writeFile(
        join(marketplaceRoot, "marketplace.json"),
        JSON.stringify({
          name: "claude-plugins-official",
          plugins: [{ name: "cached", source: "./cached" }],
        }),
      );
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "claude-plugins-official",
          source: {
            source: "settings",
            marketplace: {
              name: "claude-plugins-official",
              plugins: [],
              raw: { name: "claude-plugins-official", plugins: [] },
            },
          },
          name: "claude-plugins-official",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-02T00:00:00.000Z",
          pluginCount: 1,
        },
      ]);
      for (const key of [
        ZCODE_HTTP_PROXY_ENV_KEY,
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        ZCODE_AGENT_CA_CERT_ENV_KEY,
        "NODE_EXTRA_CA_CERTS",
      ]) {
        vi.stubEnv(key, "");
      }
      vi.stubEnv(ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY, "{}");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("[]", { status: 200 })),
      );

      const freshRaw = {
        name: "claude-plugins-official",
        plugins: [{ name: "fresh", source: "./fresh" }],
        // 回归触发点：旧实现会在序列化 active manifest 时触发 deadline，但仍覆盖旧文件。
        toJSON: () => {
          vi.advanceTimersByTime(30_000);
          return {
            name: "claude-plugins-official",
            plugins: [{ name: "fresh", source: "./fresh" }],
          };
        },
      };

      await expect(
        addMarketplace({
          source: {
            source: "settings",
            marketplace: {
              name: "claude-plugins-official",
              plugins: [
                {
                  name: "fresh",
                  source: "./fresh",
                  raw: { name: "fresh", source: "./fresh" },
                },
              ],
              raw: freshRaw,
            },
          },
          storageRoot,
          trustedId: "claude-plugins-official",
        }),
      ).rejects.toThrow("30 seconds");

      expect(
        loadMarketplaceManifestSync(storageRoot, "claude-plugins-official")?.plugins[0]?.name,
      ).toBe("cached");
      expect(
        loadKnownMarketplacesSync(storageRoot).find(
          (record) => record.id === "claude-plugins-official",
        ),
      ).toMatchObject({
        lastUpdated: "2026-01-02T00:00:00.000Z",
        pluginCount: 1,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });

  it("rolls back a settings marketplace manifest when known state persistence fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-settings-known-state-failure-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(storageRoot, "marketplaces", "settings-market");

    try {
      await mkdir(marketplaceRoot, { recursive: true });
      await writeFile(
        join(marketplaceRoot, "marketplace.json"),
        JSON.stringify({
          name: "settings-market",
          plugins: [{ name: "cached", source: "./cached" }],
        }),
      );
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "settings-market",
          source: {
            source: "settings",
            marketplace: {
              name: "settings-market",
              plugins: [],
              raw: { name: "settings-market", plugins: [] },
            },
          },
          name: "settings-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-02T00:00:00.000Z",
          pluginCount: 1,
        },
      ]);

      let serializationCount = 0;
      const freshRaw = {
        name: "settings-market",
        plugins: [{ name: "fresh", source: "./fresh" }],
        toJSON: () => {
          serializationCount += 1;
          if (serializationCount === 2) {
            throw new Error("known state persistence failed");
          }
          return {
            name: "settings-market",
            plugins: [{ name: "fresh", source: "./fresh" }],
          };
        },
      };

      await expect(
        addMarketplace({
          source: {
            source: "settings",
            marketplace: {
              name: "settings-market",
              plugins: [
                {
                  name: "fresh",
                  source: "./fresh",
                  raw: { name: "fresh", source: "./fresh" },
                },
              ],
              raw: freshRaw,
            },
          },
          storageRoot,
        }),
      ).rejects.toThrow("known state persistence failed");

      expect(loadMarketplaceManifestSync(storageRoot, "settings-market")?.plugins[0]?.name).toBe(
        "cached",
      );
      expect(
        loadKnownMarketplacesSync(storageRoot).find((record) => record.id === "settings-market"),
      ).toMatchObject({
        lastUpdated: "2026-01-02T00:00:00.000Z",
        pluginCount: 1,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rolls back Claude manifest and known state when timeout fires during authority persistence", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-claude-authority-timeout-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(storageRoot, "marketplaces", "claude-plugins-official");

    try {
      await mkdir(marketplaceRoot, { recursive: true });
      await writeFile(
        join(marketplaceRoot, "marketplace.json"),
        JSON.stringify({
          name: "claude-plugins-official",
          plugins: [{ name: "cached", source: "./cached" }],
        }),
      );
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "claude-plugins-official",
          source: {
            source: "settings",
            marketplace: {
              name: "claude-plugins-official",
              plugins: [],
              raw: { name: "claude-plugins-official", plugins: [] },
            },
          },
          name: "claude-plugins-official",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-02T00:00:00.000Z",
          pluginCount: 1,
        },
      ]);
      for (const key of [
        ZCODE_HTTP_PROXY_ENV_KEY,
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        ZCODE_AGENT_CA_CERT_ENV_KEY,
        "NODE_EXTRA_CA_CERTS",
      ]) {
        vi.stubEnv(key, "");
      }
      vi.stubEnv(ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY, "{}");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("[]", { status: 200 })),
      );

      let serializationCount = 0;
      const freshRaw = {
        name: "claude-plugins-official",
        plugins: [{ name: "fresh", source: "./fresh" }],
        toJSON: () => {
          serializationCount += 1;
          // 第一次序列化 staging manifest，第二次序列化 authority state。
          if (serializationCount === 2) {
            vi.advanceTimersByTime(30_000);
          }
          return {
            name: "claude-plugins-official",
            plugins: [{ name: "fresh", source: "./fresh" }],
          };
        },
      };

      await expect(
        addMarketplace({
          source: {
            source: "settings",
            marketplace: {
              name: "claude-plugins-official",
              plugins: [
                {
                  name: "fresh",
                  source: "./fresh",
                  raw: { name: "fresh", source: "./fresh" },
                },
              ],
              raw: freshRaw,
            },
          },
          storageRoot,
          trustedId: "claude-plugins-official",
        }),
      ).rejects.toThrow("30 seconds");

      expect(
        loadMarketplaceManifestSync(storageRoot, "claude-plugins-official")?.plugins[0]?.name,
      ).toBe("cached");
      expect(
        loadKnownMarketplacesSync(storageRoot).find(
          (record) => record.id === "claude-plugins-official",
        ),
      ).toMatchObject({
        lastUpdated: "2026-01-02T00:00:00.000Z",
        pluginCount: 1,
      });
      expect(
        existsSync(join(storageRoot, "marketplaces", ".claude-plugins-official.transaction.json")),
      ).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });

  it("fails Claude marketplace refresh after 30 seconds without blocking other markets", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-claude-marketplace-timeout-"));
    const storageRoot = join(dir, "storage");
    const claudeSnapshot = join(storageRoot, "marketplaces", "claude-plugins-official");
    const goodSource = join(dir, "good-source");

    try {
      await mkdir(claudeSnapshot, { recursive: true });
      await writeFile(
        join(claudeSnapshot, "marketplace.json"),
        JSON.stringify({
          name: "claude-plugins-official",
          plugins: [{ name: "cached", source: "./cached" }],
        }),
      );
      await writeMarketplaceManifest(goodSource, {
        name: "good-market",
        plugins: [{ name: "good-v2", source: "./good-v2" }],
      });
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "claude-plugins-official",
          source: { source: "github", repo: "anthropics/claude-plugins-official" },
          name: "claude-plugins-official",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-02T00:00:00.000Z",
          pluginCount: 1,
        },
        {
          id: "good-market",
          source: { source: "directory", path: goodSource },
          name: "good-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-01T00:00:00.000Z",
          pluginCount: 1,
        },
        {
          id: "zcode-plugins-official",
          source: {
            source: "settings",
            marketplace: {
              name: "zcode-plugins-official",
              plugins: [],
              raw: { name: "zcode-plugins-official", plugins: [] },
            },
          },
          name: "zcode-plugins-official",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 0,
        },
      ]);

      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              const signal = init?.signal;
              if (signal?.aborted) {
                reject(signal.reason);
                return;
              }
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        ),
      );

      const refresh = updateMarketplace({ storageRoot });
      for (let turn = 0; turn < 10 && vi.mocked(fetch).mock.calls.length === 0; turn += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
      await vi.advanceTimersByTimeAsync(30_000);
      const updated = await refresh;

      expect(updated.map((record) => record.id)).toContain("good-market");
      expect(updated.map((record) => record.id)).not.toContain("claude-plugins-official");
      expect(
        loadMarketplaceManifestSync(storageRoot, "claude-plugins-official")?.plugins[0]?.name,
      ).toBe("cached");
      expect(
        loadKnownMarketplacesSync(storageRoot).find(
          (record) => record.id === "claude-plugins-official",
        )?.lastRefreshFailure,
      ).toMatchObject({
        code: "plugin_archive_fetch_failed",
        message: expect.stringContaining("30 seconds"),
      });
      expect(loadMarketplaceManifestSync(storageRoot, "good-market")?.plugins[0]?.name).toBe(
        "good-v2",
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });

  it("keeps the active directory when atomic staging cannot copy the replacement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-atomic-directory-"));
    const targetPath = join(dir, "active");
    try {
      await mkdir(targetPath, { recursive: true });
      await writeFile(join(targetPath, "keep.txt"), "v1");

      await expect(
        replaceDirectoryAtomically({
          sourcePath: join(dir, "missing-source"),
          targetPath,
        }),
      ).rejects.toThrow();

      expect(await readFile(join(targetPath, "keep.txt"), "utf8")).toBe("v1");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("recovers state files and marketplace directories left in the atomic commit window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-atomic-recovery-"));
    const storageRoot = join(dir, "storage");
    const installedPath = join(storageRoot, "installed_plugins.json");
    const marketplacePath = join(storageRoot, "marketplaces", "recover-market");
    try {
      await mkdir(marketplacePath, { recursive: true });
      await writeFile(
        installedPath,
        JSON.stringify({
          version: 1,
          plugins: [
            {
              id: "recover-plugin@recover-market",
              name: "recover-plugin",
              marketplace: "recover-market",
              version: "1.0.0",
              installPath: join(storageRoot, "cache", "recover-market", "recover-plugin", "1.0.0"),
              installedAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              scope: "user",
            },
          ],
        }),
      );
      await writeFile(
        join(marketplacePath, "marketplace.json"),
        JSON.stringify({
          name: "recover-market",
          plugins: [{ name: "recover-plugin", source: "./recover-plugin" }],
        }),
      );
      await rename(installedPath, join(storageRoot, ".installed_plugins.json.backup"));
      await rename(marketplacePath, join(storageRoot, "marketplaces", ".recover-market.backup"));

      expect(
        (await listInstalledPluginRecordsAsync(storageRoot)).map((record) => record.id),
      ).toEqual(["recover-plugin@recover-market"]);
      expect(listInstalledPluginRecords(storageRoot).map((record) => record.id)).toEqual([
        "recover-plugin@recover-market",
      ]);
      expect(loadMarketplaceManifestSync(storageRoot, "recover-market")?.name).toBe(
        "recover-market",
      );
      expect(existsSync(installedPath)).toBe(true);
      expect(existsSync(marketplacePath)).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not let a normal read recover an active directory transaction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-atomic-active-read-"));
    const authorityPath = join(dir, "installed_plugins.json");
    const sourcePath = join(dir, "source");
    const targetPath = join(dir, "active");
    try {
      await mkdir(sourcePath, { recursive: true });
      await mkdir(targetPath, { recursive: true });
      await writeFile(join(sourcePath, "version.txt"), "v2");
      await writeFile(join(targetPath, "version.txt"), "v1");
      await writeFile(authorityPath, JSON.stringify({ version: 1, plugins: [] }));

      const activation = await activateDirectoryAtomically({
        authorityPath,
        sourcePath,
        targetPath,
      });

      expect(
        await readFile(join(await resolveAtomicReadPath(targetPath), "version.txt"), "utf8"),
      ).toBe("v1");
      const readablePath = recoverAtomicTargetSync(targetPath);
      expect(await readFile(join(targetPath, "version.txt"), "utf8")).toBe("v2");
      expect(await readFile(join(readablePath, "version.txt"), "utf8")).toBe("v1");
      expect(existsSync(join(dir, ".active.backup"))).toBe(true);

      await activation.rollback();
      expect(await readFile(join(targetPath, "version.txt"), "utf8")).toBe("v1");

      const committedActivation = await activateDirectoryAtomically({
        authorityPath,
        sourcePath,
        targetPath,
      });
      await writeFile(
        authorityPath,
        JSON.stringify({
          version: 1,
          plugins: [{ cacheTransactionId: committedActivation.transactionId }],
        }),
      );
      expect(await resolveAtomicReadPath(targetPath)).toBe(targetPath);
      const committedReadablePath = recoverAtomicTargetSync(targetPath);
      expect(await readFile(join(committedReadablePath, "version.txt"), "utf8")).toBe("v2");
      expect(existsSync(join(dir, ".active.backup"))).toBe(true);
      await committedActivation.finalize();
      expect(existsSync(join(dir, ".active.backup"))).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects a concurrent activation for the same target without losing its rollback snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-atomic-concurrent-target-"));
    const authorityPath = join(dir, "installed_plugins.json");
    const firstSourcePath = join(dir, "source-first");
    const secondSourcePath = join(dir, "source-second");
    const targetPath = join(dir, "active");
    let firstActivation: Awaited<ReturnType<typeof activateDirectoryAtomically>> | undefined;

    try {
      await mkdir(firstSourcePath, { recursive: true });
      await mkdir(secondSourcePath, { recursive: true });
      await mkdir(targetPath, { recursive: true });
      await writeFile(join(firstSourcePath, "version.txt"), "v2");
      await writeFile(join(secondSourcePath, "version.txt"), "v3");
      await writeFile(join(targetPath, "version.txt"), "v1");
      await writeFile(authorityPath, JSON.stringify({ version: 1, plugins: [] }));

      firstActivation = await activateDirectoryAtomically({
        authorityPath,
        sourcePath: firstSourcePath,
        targetPath,
      });

      await expect(
        activateDirectoryAtomically({
          authorityPath,
          sourcePath: secondSourcePath,
          targetPath,
        }),
      ).rejects.toThrow("already active");

      expect(
        await readFile(join(await resolveAtomicReadPath(targetPath), "version.txt"), "utf8"),
      ).toBe("v1");
      const readablePath = recoverAtomicTargetSync(targetPath);
      expect(await readFile(join(targetPath, "version.txt"), "utf8")).toBe("v2");
      expect(await readFile(join(readablePath, "version.txt"), "utf8")).toBe("v1");
      expect(existsSync(join(dir, ".active.backup"))).toBe(true);
      expect(existsSync(join(dir, ".active.transaction.json"))).toBe(true);

      await firstActivation.rollback();
      firstActivation = undefined;
      expect(await readFile(join(targetPath, "version.txt"), "utf8")).toBe("v1");
      expect(existsSync(join(dir, ".active.backup"))).toBe(false);
      expect(existsSync(join(dir, ".active.transaction.json"))).toBe(false);
    } finally {
      await firstActivation?.rollback().catch(() => {});
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not overwrite an atomic transaction owned by another live process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-atomic-live-owner-"));
    const sourcePath = join(dir, "source");
    const targetPath = join(dir, "active");
    const transactionPath = join(dir, ".active.transaction.json");

    try {
      await mkdir(sourcePath, { recursive: true });
      await mkdir(targetPath, { recursive: true });
      await writeFile(join(sourcePath, "version.txt"), "v2");
      await writeFile(join(targetPath, "version.txt"), "v1");
      await writeFile(
        transactionPath,
        JSON.stringify({
          hadTarget: true,
          mode: "standalone",
          ownerId: "another-live-process",
          ownerPid: process.ppid,
          stageName: ".active.stage-other",
          transactionId: "live-transaction",
          version: 2,
        }),
      );

      await expect(
        activateDirectoryAtomically({
          sourcePath,
          targetPath,
        }),
      ).rejects.toThrow("already active");

      expect(await readFile(join(targetPath, "version.txt"), "utf8")).toBe("v1");
      expect(JSON.parse(await readFile(transactionPath, "utf8"))).toMatchObject({
        ownerId: "another-live-process",
        transactionId: "live-transaction",
      });
      expect(existsSync(join(dir, ".active.backup"))).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("recovers a coordinated directory according to the authority transaction generation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-atomic-generation-"));
    const authorityPath = join(dir, "installed_plugins.json");
    const targetPath = join(dir, "active");
    const backupPath = join(dir, ".active.backup");
    const transactionPath = join(dir, ".active.transaction.json");
    const transactionId = "dead-transaction";
    const writeTransaction = async (): Promise<void> => {
      await writeFile(
        transactionPath,
        JSON.stringify({
          authorityPath,
          hadTarget: true,
          mode: "coordinated",
          ownerId: "dead-owner",
          ownerPid: 999_999_999,
          stageName: ".active.stage-dead",
          transactionId,
          version: 2,
        }),
      );
    };
    try {
      await mkdir(targetPath, { recursive: true });
      await mkdir(backupPath, { recursive: true });
      await writeFile(join(targetPath, "version.txt"), "v2");
      await writeFile(join(backupPath, "version.txt"), "v1");
      await writeFile(authorityPath, JSON.stringify({ version: 1, plugins: [] }));
      await writeTransaction();

      // 已死亡事务：读取先按权威代际恢复，再返回稳定 target；未提交 → 回滚到 backup 的 v1。
      expect(await resolveAtomicReadPath(targetPath)).toBe(targetPath);
      expect(await readFile(join(targetPath, "version.txt"), "utf8")).toBe("v1");
      expect(existsSync(backupPath)).toBe(false);
      expect(existsSync(transactionPath)).toBe(false);

      await rm(targetPath, { force: true, recursive: true });
      await mkdir(targetPath, { recursive: true });
      await mkdir(backupPath, { recursive: true });
      await writeFile(join(targetPath, "version.txt"), "v2");
      await writeFile(join(backupPath, "version.txt"), "v1");
      await writeFile(
        authorityPath,
        JSON.stringify({
          version: 1,
          plugins: [{ cacheTransactionId: transactionId }],
        }),
      );
      await writeTransaction();

      // 已提交 → 保留 target 的 v2，清理 backup。
      expect(await resolveAtomicReadPath(targetPath)).toBe(targetPath);
      expect(await readFile(join(targetPath, "version.txt"), "utf8")).toBe("v2");
      expect(existsSync(backupPath)).toBe(false);
      recoverAtomicTargetSync(targetPath);
      expect(await readFile(join(targetPath, "version.txt"), "utf8")).toBe("v2");
      expect(existsSync(backupPath)).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rolls back earlier dependency cache activations when a later dependency install fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-install-transaction-rollback-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const rootSource = join(dir, "root-source");
    const goodSource = join(dir, "good-source");
    const badSource = join(dir, "bad-source");

    try {
      await writePluginManifest(rootSource, { name: "root", version: "1.0.0" }, ".claude-plugin");
      await writePluginManifest(goodSource, { name: "good", version: "1.0.0" }, ".claude-plugin");
      await writePluginManifest(badSource, { name: "bad", version: "1.0.0" }, ".claude-plugin");
      await writeFile(join(goodSource, "marker.txt"), "v1");
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "transaction-market",
        plugins: [
          {
            name: "root",
            dependencies: ["good", "bad"],
            source: { source: "directory", path: rootSource },
          },
          { name: "good", source: { source: "directory", path: goodSource } },
          { name: "bad", source: { source: "directory", path: badSource } },
        ],
      });
      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });
      await installMarketplacePlugin({
        marketplace: "transaction-market",
        name: "root",
        storageRoot,
      });
      const goodRecord = listInstalledPluginRecords(storageRoot).find(
        (record) => record.id === "good@transaction-market",
      );
      expect(await readFile(join(goodRecord?.installPath ?? "", "marker.txt"), "utf8")).toBe("v1");

      await writeFile(join(goodSource, "marker.txt"), "v2");
      await rm(badSource, { force: true, recursive: true });

      await expect(
        installMarketplacePlugin({
          marketplace: "transaction-market",
          name: "root",
          storageRoot,
        }),
      ).rejects.toThrow(/does not exist/u);
      expect(await readFile(join(goodRecord?.installPath ?? "", "marker.txt"), "utf8")).toBe("v1");
      expect(
        listInstalledPluginRecords(storageRoot).find(
          (record) => record.id === "good@transaction-market",
        ),
      ).toEqual(goodRecord);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("discovers an installed cache offline without system Git or source network access", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-offline-installed-cache-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "offline-plugin");

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "offline-cache-market",
        plugins: [{ name: "offline-plugin", source: "./plugins/offline-plugin" }],
      });
      await writePluginManifest(
        pluginRoot,
        { name: "offline-plugin", skills: "skills", version: "1.0.0" },
        ".claude-plugin",
      );
      await mkdir(join(pluginRoot, "skills", "offline"), { recursive: true });
      await writeFile(join(pluginRoot, "skills", "offline", "SKILL.md"), "# offline");
      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });
      await installMarketplacePlugin({
        marketplace: "offline-cache-market",
        name: "offline-plugin",
        storageRoot,
      });

      vi.stubEnv("PATH", join(dir, "no-system-git"));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Promise.reject(new Error("offline"))),
      );
      const outcome = await discoverNodePlugins({
        config: {
          dirs: [],
          enabled: true,
          enabledPlugins: { "offline-plugin@offline-cache-market": true },
          options: {},
        },
        env: {},
        storageRoot,
        workingDirectory: dir,
      });

      expect(outcome.plugins).toContainEqual(
        expect.objectContaining({
          id: "offline-plugin@offline-cache-market",
          source: "cache",
        }),
      );
      expect(outcome.skillRoots).toContainEqual(
        expect.objectContaining({ path: expect.stringContaining(join("offline-plugin", "1.0.0")) }),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("recovers a crashed cache replacement before discovery publishes runtime paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-crashed-cache-discovery-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "crash-plugin");
    const config = {
      dirs: [],
      enabled: true,
      enabledPlugins: { "crash-plugin@crash-market": true },
      options: {},
    };

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "crash-market",
        plugins: [{ name: "crash-plugin", source: "./plugins/crash-plugin" }],
      });
      await writePluginManifest(
        pluginRoot,
        { hooks: "hooks/hooks.json", name: "crash-plugin", skills: "skills", version: "1.0.0" },
        ".claude-plugin",
      );
      await mkdir(join(pluginRoot, "skills", "crash"), { recursive: true });
      await mkdir(join(pluginRoot, "hooks"), { recursive: true });
      await writeFile(join(pluginRoot, "skills", "crash", "SKILL.md"), "# crash");
      await writeFile(join(pluginRoot, "hooks", "session-start"), "echo start");
      await writeFile(
        join(pluginRoot, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { command: '"${CLAUDE_PLUGIN_ROOT}/hooks/session-start"', type: "command" },
                ],
              },
            ],
          },
        }),
      );
      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });
      await installMarketplacePlugin({
        marketplace: "crash-market",
        name: "crash-plugin",
        storageRoot,
      });
      const [record] = listInstalledPluginRecords(storageRoot);
      const cachePath = record!.installPath!;
      const cacheParent = join(cachePath, "..");
      const backupPath = join(cacheParent, ".1.0.0.backup");
      // 模拟替换在 target→backup 之后、staging→target 之前崩溃：target 缺失，只剩 backup 和死亡 owner 的 marker。
      await rename(cachePath, backupPath);
      await writeFile(
        join(cacheParent, ".1.0.0.transaction.json"),
        JSON.stringify({
          hadTarget: true,
          mode: "standalone",
          ownerId: "dead-owner",
          ownerPid: 999_999_999,
          stageName: ".1.0.0.stage-dead",
          transactionId: "dead-transaction",
          version: 2,
        }),
      );

      const outcome = await discoverNodePlugins({
        config,
        env: {},
        storageRoot,
        workingDirectory: dir,
      });

      // 发布给会话的是稳定 target，而不是会被后续恢复改名走的 backup。
      const skillRoot = outcome.skillRoots.find((root) => root.path.includes("crash-plugin"));
      expect(skillRoot?.path).toBe(join(cachePath, "skills"));
      const hook = outcome.hooks.SessionStart?.[0]?.hooks[0];
      expect(hook).toMatchObject({ plugin: { rootPath: cachePath } });
      expect(existsSync(backupPath)).toBe(false);
      expect(existsSync(join(cacheParent, ".1.0.0.transaction.json"))).toBe(false);

      // 会话持有路径期间打开详情，不能再把会话正在用的目录移走。
      await describeMarketplacePlugin({
        marketplace: "crash-market",
        name: "crash-plugin",
        storageRoot,
      });
      expect(await readFile(join(skillRoot!.path, "crash", "SKILL.md"), "utf8")).toBe("# crash");
      expect(
        await readFile(
          join(
            (hook as { plugin: { rootPath: string } }).plugin.rootPath,
            "hooks",
            "session-start",
          ),
          "utf8",
        ),
      ).toBe("echo start");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps reading the committed generation of a live replacement during discovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-live-cache-discovery-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "live-plugin");
    const nextSource = join(dir, "next-source");
    let activation: Awaited<ReturnType<typeof activateDirectoryAtomically>> | undefined;

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "live-market",
        plugins: [{ name: "live-plugin", source: "./plugins/live-plugin" }],
      });
      await writePluginManifest(
        pluginRoot,
        { name: "live-plugin", skills: "skills", version: "1.0.0" },
        ".claude-plugin",
      );
      await mkdir(join(pluginRoot, "skills", "live"), { recursive: true });
      await writeFile(join(pluginRoot, "skills", "live", "SKILL.md"), "# v1");
      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });
      await installMarketplacePlugin({
        marketplace: "live-market",
        name: "live-plugin",
        storageRoot,
      });
      const [record] = listInstalledPluginRecords(storageRoot);
      const cachePath = record!.installPath!;
      await cp(cachePath, nextSource, { recursive: true });
      await writeFile(join(nextSource, "skills", "live", "SKILL.md"), "# v2");

      // 同进程 writer 已激活但未 finalize：读者不能接管它的 backup。
      activation = await activateDirectoryAtomically({
        sourcePath: nextSource,
        targetPath: cachePath,
      });
      const outcome = await discoverNodePlugins({
        config: {
          dirs: [],
          enabled: true,
          enabledPlugins: { "live-plugin@live-market": true },
          options: {},
        },
        env: {},
        storageRoot,
        workingDirectory: dir,
      });

      const backupPath = join(cachePath, "..", ".1.0.0.backup");
      const skillRoot = outcome.skillRoots.find((root) => root.path.includes("live-plugin"));
      expect(skillRoot?.path).toBe(join(backupPath, "skills"));
      expect(existsSync(backupPath)).toBe(true);
      await activation.rollback();
      activation = undefined;
      expect(await readFile(join(cachePath, "skills", "live", "SKILL.md"), "utf8")).toBe("# v1");
    } finally {
      await activation?.rollback().catch(() => {});
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("materializes Claude command object mappings into custom command roots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-command-metadata-"));
    const pluginRoot = join(dir, "commands-plugin");

    try {
      await writePluginManifest(pluginRoot, {
        commands: {
          "from-file": {
            argumentHint: "[topic]",
            description: "Generated from a source file",
            source: "./extra-command.md",
          },
          inline: {
            allowedTools: ["Bash", "Read"],
            content: "# Inline command\n\nRun the inline command.",
            description: "Generated from inline content",
          },
        },
        name: "commands-plugin",
      });
      await writeFile(
        join(pluginRoot, "extra-command.md"),
        "# Source command\n\nRun the source command.",
      );

      const outcome = await createNodePluginAdapter({
        storageRoot: join(dir, "plugins"),
      }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {},
        storageRoot: join(dir, "plugins"),
        workingDirectory: dir,
      });
      const commands = await createNodeCustomCommandAdapter().discoverCommands({
        roots: outcome.commandRoots,
        workingDirectory: dir,
      });

      expect(commands.commands.map((command) => command.name)).toEqual(["from-file", "inline"]);
      expect(commands.commands.find((command) => command.name === "from-file")).toMatchObject({
        argumentHint: "[topic]",
        description: "Generated from a source file",
      });
      expect(commands.commands.find((command) => command.name === "inline")).toMatchObject({
        allowedTools: ["Bash", "Read"],
        description: "Generated from inline content",
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("dry-runs marketplace source validation against real plugin manifests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-marketplace-dry-run-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "risky");

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "dry-run-market",
        plugins: [
          {
            name: "risky",
            source: "./plugins/risky",
          },
        ],
      });
      await writePluginManifest(
        pluginRoot,
        {
          agents: "./agents/risky.md",
          hooks: "./hooks/hooks.json",
          mcpServers: {
            risky: {
              command: "node",
              env: {
                TOKEN: "${ZCODE_MISSING_TOKEN}",
              },
            },
          },
          name: "risky",
          userConfig: {
            api_key: {
              sensitive: true,
              type: "string",
            },
          },
        },
        ".claude-plugin",
      );

      const diagnostics = await validateMarketplaceSource({
        source: { source: "directory", path: marketplaceRoot },
        storageRoot,
      });

      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          code: "plugin_variable_missing",
          pluginId: "risky@dry-run-market",
        }),
      );
      expect(listInstalledPluginRecords(storageRoot)).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("defers remote plugin roots while validating marketplace sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-marketplace-remote-dry-run-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const localRoot = join(marketplaceRoot, "plugins", "local-risky");

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "official-like",
        plugins: [
          {
            name: "remote-git-subdir",
            source: {
              source: "git-subdir",
              url: join(dir, "missing-remote.git"),
              path: "plugins/remote-git-subdir",
              sha: "abc123",
            },
          },
          {
            name: "local-risky",
            source: "./plugins/local-risky",
          },
        ],
      });
      await writePluginManifest(
        localRoot,
        {
          hooks: "hooks/hooks.json",
          name: "local-risky",
        },
        ".claude-plugin",
      );

      const diagnostics = await validateMarketplaceSource({
        source: { source: "directory", path: marketplaceRoot },
        storageRoot,
      });

      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          code: "plugin_validation_deferred",
          pluginId: "remote-git-subdir@official-like",
          severity: "warning",
        }),
      );
      expect(diagnostics).not.toContainEqual(
        expect.objectContaining({
          code: "plugin_unsupported_component",
          pluginId: "local-risky@official-like",
        }),
      );
      expect(diagnostics).not.toContainEqual(
        expect.objectContaining({
          code: "plugin_marketplace_invalid",
          pluginId: "remote-git-subdir@official-like",
        }),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("runs Marketplace cache hooks from third-party marketplaces when enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-marketplace-hooks-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "hooked");

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "hook-market",
        plugins: [
          {
            name: "hooked",
            source: "./plugins/hooked",
          },
        ],
      });
      await writePluginManifest(
        pluginRoot,
        {
          hooks: "hooks/hooks.json",
          name: "hooked",
        },
        ".claude-plugin",
      );
      await mkdir(join(pluginRoot, "hooks"), { recursive: true });
      await writeFile(
        join(pluginRoot, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [{ command: "echo hooked", type: "command" }],
              },
            ],
          },
        }),
      );
      await addMarketplace({ source: { source: "directory", path: marketplaceRoot }, storageRoot });
      await installMarketplacePlugin({ marketplace: "hook-market", name: "hooked", storageRoot });

      const outcome = await createNodePluginAdapter({ storageRoot }).discoverPlugins({
        config: {
          dirs: [],
          enabled: true,
          enabledPlugins: {
            "hooked@hook-market": true,
          },
          options: {},
        },
        env: {},
        storageRoot,
        workingDirectory: dir,
      });
      // 三方 marketplace 插件 hook 现在默认放行（与内置/官方一致）。
      expect(outcome.hooks.SessionStart).toBeDefined();
      expect(outcome.plugins[0]?.hookDetails).toMatchObject([
        {
          command: "echo hooked",
          event: "SessionStart",
          runnable: true,
          type: "command",
        },
      ]);
      expect(outcome.diagnostics).not.toContainEqual(
        expect.objectContaining({
          code: "plugin_unsupported_component",
          pluginId: "hooked@hook-market",
        }),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("runs hooks from official Claude marketplace cache plugins when enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-marketplace-official-hooks-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "hookify");

    try {
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "claude-plugins-official",
        plugins: [
          {
            name: "hookify",
            source: "./plugins/hookify",
          },
        ],
      });
      await writePluginManifest(pluginRoot, { name: "hookify" }, ".claude-plugin");
      await mkdir(join(pluginRoot, "hooks"), { recursive: true });
      await writeFile(
        join(pluginRoot, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  {
                    command: 'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py"',
                    type: "command",
                  },
                ],
              },
            ],
          },
        }),
      );
      await addMarketplace({
        source: { source: "directory", path: marketplaceRoot },
        storageRoot,
        trustedId: "claude-plugins-official",
      });
      await installMarketplacePlugin({
        marketplace: "claude-plugins-official",
        name: "hookify",
        storageRoot,
      });

      const outcome = await createNodePluginAdapter({ storageRoot }).discoverPlugins({
        config: {
          dirs: [],
          enabled: true,
          enabledPlugins: {
            "hookify@claude-plugins-official": true,
          },
          options: {},
        },
        env: {},
        storageRoot,
        workingDirectory: dir,
      });
      expect(outcome.hooks.PreToolUse?.[0]?.hooks[0]).toMatchObject({
        command: 'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py"',
        plugin: {
          id: "hookify@claude-plugins-official",
          rootPath: expect.stringContaining(join("hookify", "0.0.0")),
        },
        type: "command",
      });
      expect(outcome.plugins[0]?.hookDetails).toMatchObject([
        {
          command: 'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py"',
          event: "PreToolUse",
          runnable: true,
          type: "command",
        },
      ]);
      expect(outcome.diagnostics).not.toContainEqual(
        expect.objectContaining({
          code: "plugin_unsupported_component",
          pluginId: "hookify@claude-plugins-official",
        }),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("disables an MCP server when a required ZCODE variable is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-env-"));
    const pluginRoot = join(dir, "env-plugin");

    try {
      await writePluginManifest(pluginRoot, {
        mcpServers: {
          local: {
            command: "node",
            env: {
              TOKEN: "${ZCODE_PLUGIN_TOKEN}",
            },
          },
        },
        name: "env-plugin",
      });

      const outcome = await createNodePluginAdapter({
        storageRoot: join(dir, "plugins"),
      }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {},
        storageRoot: join(dir, "plugins"),
        workingDirectory: dir,
      });

      expect(outcome.mcpServers).toEqual({});
      expect(outcome.plugins[0]?.declaredMcpServerNames).toEqual(["local"]);
      expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "plugin_variable_missing",
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("expands arbitrary process environment variables only in MCP secret sinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-secret-env-"));
    const pluginRoot = join(dir, "secret-env-plugin");

    try {
      await writePluginManifest(pluginRoot, {
        mcpServers: {
          local: {
            command: "node",
            args: ["${TOKEN_PLAN_API_TOKEN}"],
            env: {
              AUTHORIZATION: "Bearer ${TOKEN_PLAN_API_TOKEN}",
            },
          },
          remote: {
            type: "http",
            url: "https://mcp.example.test/${TOKEN_PLAN_API_TOKEN}",
            headers: {
              Authorization: "Bearer ${TOKEN_PLAN_API_TOKEN}",
            },
          },
        },
        name: "secret-env-plugin",
      });

      const outcome = await createNodePluginAdapter({
        storageRoot: join(dir, "plugins"),
      }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {
          TOKEN_PLAN_API_TOKEN: "secret-from-process-env",
        },
        storageRoot: join(dir, "plugins"),
        workingDirectory: dir,
      });

      expect(outcome.mcpServers["plugin:secret-env-plugin:local"]).toMatchObject({
        args: ["${TOKEN_PLAN_API_TOKEN}"],
        env: {
          AUTHORIZATION: "Bearer secret-from-process-env",
        },
      });
      expect(outcome.mcpServers["plugin:secret-env-plugin:remote"]).toMatchObject({
        headers: {
          Authorization: "Bearer secret-from-process-env",
        },
        url: "https://mcp.example.test/${TOKEN_PLAN_API_TOKEN}",
      });
      expect(outcome.diagnostics).not.toContainEqual(
        expect.objectContaining({ code: "plugin_variable_missing" }),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("disables an MCP server when an arbitrary secret environment variable is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-missing-secret-env-"));
    const pluginRoot = join(dir, "missing-secret-env-plugin");

    try {
      await writePluginManifest(pluginRoot, {
        mcpServers: {
          local: {
            command: "node",
            env: {
              TOKEN: "${TOKEN_PLAN_API_TOKEN}",
            },
          },
        },
        name: "missing-secret-env-plugin",
      });

      const outcome = await createNodePluginAdapter({
        storageRoot: join(dir, "plugins"),
      }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {},
        storageRoot: join(dir, "plugins"),
        workingDirectory: dir,
      });

      expect(outcome.mcpServers).toEqual({});
      expect(outcome.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "plugin_variable_missing",
          message: "Missing environment variable: TOKEN_PLAN_API_TOKEN",
        }),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("diagnoses MCP variables that require unavailable runtime contexts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-missing-context-"));
    const pluginRoot = join(dir, "missing-context-plugin");

    try {
      await writePluginManifest(pluginRoot, {
        mcpServers: {
          skillContext: {
            command: "node",
            args: ["${CLAUDE_SKILL_DIR}/server.js"],
          },
          sessionContext: {
            command: "node",
            env: {
              SESSION_ID: "${CLAUDE_SESSION_ID}",
            },
          },
        },
        name: "missing-context-plugin",
      });

      const outcome = await createNodePluginAdapter({
        storageRoot: join(dir, "plugins"),
      }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {},
        storageRoot: join(dir, "plugins"),
        workingDirectory: dir,
      });

      expect(outcome.mcpServers).toEqual({});
      expect(outcome.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "plugin_variable_missing",
            message: "Plugin variable requires a skill context: CLAUDE_SKILL_DIR",
          }),
          expect.objectContaining({
            code: "plugin_variable_missing",
            message: "Plugin variable requires a runtime session context: CLAUDE_SESSION_ID",
          }),
        ]),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("loads plugins that only provide a Claude manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-claude-plugin-"));
    const pluginRoot = join(dir, "claude-only");

    try {
      await writePluginManifest(pluginRoot, { name: "claude-only" }, ".claude-plugin");
      await mkdir(join(pluginRoot, "skills", "claude-only"), { recursive: true });
      await writeFile(join(pluginRoot, "skills", "claude-only", "SKILL.md"), "# skill");

      const outcome = await createNodePluginAdapter({
        storageRoot: join(dir, "plugins"),
      }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {},
        storageRoot: join(dir, "plugins"),
        workingDirectory: dir,
      });

      expect(outcome.plugins[0]?.id).toBe("claude-only@inline");
      expect(outcome.plugins[0]?.manifestPath).toBe(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
      );
      expect(outcome.skillRoots[0]?.path).toBe(join(pluginRoot, "skills"));
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("prefers Claude manifest over Codex manifest when no ZCode manifest exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-codex-plugin-"));
    const pluginRoot = join(dir, "multi-manifest");

    try {
      await writePluginManifest(pluginRoot, { name: "codex-name" }, ".codex-plugin");
      await writePluginManifest(pluginRoot, { name: "claude-name" }, ".claude-plugin");

      const outcome = await createNodePluginAdapter({
        storageRoot: join(dir, "plugins"),
      }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {},
        storageRoot: join(dir, "plugins"),
        workingDirectory: dir,
      });

      expect(outcome.plugins[0]?.id).toBe("claude-name@inline");
      expect(outcome.plugins[0]?.manifestPath).toBe(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("removes the record, cache, and data directory on thorough uninstall", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-uninstall-"));
    const storageRoot = join(dir, "storage");
    const marketplaceRoot = join(dir, "marketplace");
    const pluginRoot = join(marketplaceRoot, "plugins", "hello");

    try {
      await writeKnownMarketplaces(storageRoot, [
        {
          id: "uninstall-market",
          source: { source: "directory", path: marketplaceRoot },
          name: "uninstall-market",
          addedAt: "2026-01-01T00:00:00.000Z",
          pluginCount: 0,
        },
      ]);
      await writeMarketplaceManifest(marketplaceRoot, {
        name: "uninstall-market",
        plugins: [{ name: "hello", source: "./plugins/hello" }],
      });
      await writePluginManifest(pluginRoot, { name: "hello", skills: "skills" }, ".claude-plugin");
      await mkdir(join(pluginRoot, "skills", "hello"), { recursive: true });
      await writeFile(join(pluginRoot, "skills", "hello", "SKILL.md"), "# hello");

      const install = await installMarketplacePlugin({
        marketplace: "uninstall-market",
        name: "hello",
        storageRoot,
      });
      const record = install.installed[0];
      expect(record?.id).toBe("hello@uninstall-market");
      const installPath = record?.installPath ?? "";
      // 模拟运行期产生的 per-plugin data 目录（含 generated-commands）。
      const dataDir = join(storageRoot, "data", "hello@uninstall-market");
      await mkdir(join(dataDir, "generated-commands"), { recursive: true });
      await writeFile(join(dataDir, "generated-commands", "demo.md"), "# demo");
      expect(existsSync(installPath)).toBe(true);
      expect(existsSync(dataDir)).toBe(true);

      const removed = await uninstallMarketplacePlugin({
        pluginId: "hello@uninstall-market",
        removeCache: true,
        storageRoot,
      });

      expect(removed?.id).toBe("hello@uninstall-market");
      expect(listInstalledPluginRecords(storageRoot)).toHaveLength(0);
      expect(existsSync(installPath)).toBe(false);
      expect(existsSync(dataDir)).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("returns null and keeps state when uninstalling an unknown plugin id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-uninstall-missing-"));
    const storageRoot = join(dir, "storage");

    try {
      const removed = await uninstallMarketplacePlugin({
        pluginId: "missing@nowhere",
        removeCache: true,
        storageRoot,
      });
      expect(removed).toBeNull();
      expect(listInstalledPluginRecords(storageRoot)).toHaveLength(0);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // Bugfix 回归（差一层目录）：Claude 插件规范里 manifest skills 数组项指向「技能目录本身」
  // （项内直接是 SKILL.md），此前 ZCode 把每项当作技能根去项下找子目录，扫描恒为空。
  it("discovers skills for plugin manifest skills array entries pointing at skill directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-array-skills-"));
    const pluginRoot = join(dir, "mattpocock");
    const skillEntries = ["./skills/engineering/tdd", "./skills/productivity/writing"];

    try {
      await writePluginManifest(
        pluginRoot,
        { name: "mattpocock-skills", skills: skillEntries },
        ".claude-plugin",
      );
      for (const [index, entry] of skillEntries.entries()) {
        const skillName = entry.split("/").pop() ?? "";
        const skillDir = join(pluginRoot, entry);
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          [
            "---",
            `name: ${skillName}`,
            `description: array-entry skill ${index}`,
            "---",
            "",
            "# skill",
          ].join("\n"),
        );
      }

      const outcome = await createNodePluginAdapter({
        storageRoot: join(dir, "plugins"),
      }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {},
        storageRoot: join(dir, "plugins"),
        workingDirectory: join(dir, "workspace"),
      });

      const plugin = outcome.plugins.find((item) => item.id === "mattpocock-skills@inline");
      expect(plugin).toBeDefined();
      // 显式声明后只注册声明入口，不补扫默认 skills/。
      expect(plugin).toMatchObject({ skillCount: 2, skillRootCount: 2 });
      const skillNames = componentNames(plugin?.components ?? [], "skill").sort();
      expect(skillNames).toEqual(["tdd", "writing"]);

      const skillOutcome = await createNodeSkillAdapter().discoverSkills({
        roots: outcome.skillRoots,
        workingDirectory: join(dir, "workspace"),
      });
      expect(skillOutcome.skills).toHaveLength(2);
      // 插件技能带 pluginName 别名，供会话内以 <plugin>:<skill> 引用。
      expect(skillOutcome.skills.map((skill) => skill.qualifiedName).sort()).toEqual([
        "mattpocock-skills:tdd",
        "mattpocock-skills:writing",
      ]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // Bugfix 回归（评审跟进）：数组语义下两个声明项的叶子目录可能同名
  // （./skills/engineering/tdd 与 ./skills/productivity/tdd），组件清单此前在解析
  // frontmatter 之前按目录 basename 提前去重，会把第二个技能丢掉，与按路径去重的
  // 运行时发现结果（skillCount）不一致。必须解析 frontmatter 后按最终 name 去重。
  it("keeps same-named leaf skill directories from different declared roots in components", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-same-leaf-skills-"));
    const pluginRoot = join(dir, "same-leaf");
    const entries: Array<{ entry: string; name: string }> = [
      { entry: "./skills/engineering/tdd", name: "tdd" },
      { entry: "./skills/productivity/tdd", name: "tdd-productivity" },
    ];

    try {
      await writePluginManifest(
        pluginRoot,
        { name: "same-leaf", skills: entries.map((item) => item.entry) },
        ".claude-plugin",
      );
      for (const { entry, name } of entries) {
        const skillDir = join(pluginRoot, entry);
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          `---\nname: ${name}\ndescription: same leaf skill\n---\n\n# ${name}`,
        );
      }

      const outcome = await createNodePluginAdapter({
        storageRoot: join(dir, "plugins"),
      }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {},
        storageRoot: join(dir, "plugins"),
        workingDirectory: join(dir, "workspace"),
      });

      const plugin = outcome.plugins.find((item) => item.id === "same-leaf@inline");
      expect(plugin).toMatchObject({ skillCount: 2 });
      // 组件清单与 skillCount 口径一致：两个同名叶子目录（frontmatter name 不同）都在。
      expect(componentNames(plugin?.components ?? [], "skill").sort()).toEqual([
        "tdd",
        "tdd-productivity",
      ]);

      const skillOutcome = await createNodeSkillAdapter().discoverSkills({
        roots: outcome.skillRoots,
        workingDirectory: join(dir, "workspace"),
      });
      expect(skillOutcome.skills.map((skill) => skill.name).sort()).toEqual([
        "tdd",
        "tdd-productivity",
      ]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not add the default root alongside a declared skill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-overlap-skills-"));
    const pluginRoot = join(dir, "overlap");

    try {
      await writePluginManifest(
        pluginRoot,
        { name: "overlap", skills: ["./skills/foo"] },
        ".claude-plugin",
      );
      await mkdir(join(pluginRoot, "skills", "foo"), { recursive: true });
      await writeFile(
        join(pluginRoot, "skills", "foo", "SKILL.md"),
        "---\nname: foo\ndescription: overlap skill\n---\n\n# foo",
      );

      const outcome = await createNodePluginAdapter({
        storageRoot: join(dir, "plugins"),
      }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {},
        storageRoot: join(dir, "plugins"),
        workingDirectory: join(dir, "workspace"),
      });

      const plugin = outcome.plugins.find((item) => item.id === "overlap@inline");
      expect(plugin).toMatchObject({ skillCount: 1, skillRootCount: 1 });

      const skillOutcome = await createNodeSkillAdapter().discoverSkills({
        roots: outcome.skillRoots,
        workingDirectory: join(dir, "workspace"),
      });
      expect(skillOutcome.skills).toHaveLength(1);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // 信任边界回归（CR-01）：manifest skills 声明是插件提供的不可信输入。
  // resolveInside（helpers.ts）在词法层面拒绝绝对路径与 ../ 穿越（rel 以 .. 开头
  // 或含 ..${sep}），越界声明在 resolveComponentRoots 落成 plugin_component_path_invalid
  // error 诊断；本用例把该边界固定，防止后续重构 scanner 时重新引入路径穿越。
  it("rejects skills paths escaping the plugin root and keeps legitimate skills working", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-path-escape-"));
    const pluginRoot = join(dir, "plugin");
    // 插件根外的诱饵技能目录；若防线失效会被扫描进结果。
    const outsideSkill = join(dir, "outside-skill");
    const absoluteOutside = join(dir, "absolute-outside");

    try {
      await writePluginManifest(
        pluginRoot,
        {
          name: "path-escape",
          skills: ["../../outside-skill", absoluteOutside, "./skills/legit"],
        },
        ".claude-plugin",
      );
      await mkdir(outsideSkill, { recursive: true });
      await mkdir(absoluteOutside, { recursive: true });
      await writeFile(join(outsideSkill, "SKILL.md"), "---\nname: outside\n---\n# x");
      await writeFile(join(absoluteOutside, "SKILL.md"), "---\nname: absolute\n---\n# x");
      await mkdir(join(pluginRoot, "skills", "legit"), { recursive: true });
      await writeFile(
        join(pluginRoot, "skills", "legit", "SKILL.md"),
        "---\nname: legit\ndescription: legitimate skill\n---\n# legit",
      );

      const outcome = await createNodePluginAdapter({
        storageRoot: join(dir, "plugins"),
      }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {},
        storageRoot: join(dir, "plugins"),
        workingDirectory: join(dir, "workspace"),
      });

      // 越界声明（../ 穿越与绝对路径）被拒：error 诊断逐条可见，且不会误报成
      // plugin_skill_root_empty（resolveInside 返回 null 时告警逻辑直接跳过）。
      const invalid = outcome.diagnostics.filter(
        (diagnostic) => diagnostic.code === "plugin_component_path_invalid",
      );
      expect(invalid).toHaveLength(2);
      expect(invalid.every((diagnostic) => diagnostic.severity === "error")).toBe(true);
      expect(invalid.some((diagnostic) => diagnostic.message.includes("../../outside-skill"))).toBe(
        true,
      );
      expect(invalid.some((diagnostic) => diagnostic.message.includes(absoluteOutside))).toBe(true);
      expect(
        outcome.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "plugin_skill_root_empty" &&
            diagnostic.pluginId === "path-escape@inline",
        ),
      ).toBe(false);

      // 合法声明不受越界项影响：skillCount 只含 legit，越界技能不出现在发现结果。
      const plugin = outcome.plugins.find((item) => item.id === "path-escape@inline");
      expect(plugin).toMatchObject({ skillCount: 1 });

      const skillOutcome = await createNodeSkillAdapter().discoverSkills({
        roots: outcome.skillRoots,
        workingDirectory: join(dir, "workspace"),
      });
      expect(skillOutcome.skills.map((skill) => skill.name)).toEqual(["legit"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // 信任边界回归（文件级 symlink）：目录是真实目录但 SKILL.md 本身是指向插件根
  // 外文件的链接（如 skills/foo/SKILL.md -> ~/.aws/credentials），以及根自身
  // SKILL.md 是链接的形态。文件级与目录级走同一个 isSymbolicLinkSync（lstat）
  // 拒绝路径。Windows 普通权限下创建文件 symlink 会 EPERM，此时才跳过——
  // 开发者模式或管理员 CI 上本用例会真实执行，不整体按平台跳过。
  it("rejects file-level SKILL.md symlinks escaping the plugin root", async (ctx) => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-file-symlink-"));
    const pluginRoot = join(dir, "plugin");
    const outsideFile = join(dir, "outside-secret.md");

    try {
      await writePluginManifest(
        pluginRoot,
        {
          name: "file-symlink-escape",
          skills: ["./skills", "./bundle-root"],
        },
        ".claude-plugin",
      );
      await writeFile(outsideFile, "---\nname: leaked-secret\ndescription: x\n---\nleaked");
      // 形态 1：子目录是真实目录，其 SKILL.md 是指向外部的文件链接。
      // 第一个链接同时作为权限探针：EPERM（Windows 无 symlink 特权）才跳过，
      // 其余错误如实抛出；finally 保证临时目录清理。
      await mkdir(join(pluginRoot, "skills", "foo"), { recursive: true });
      try {
        await symlink(outsideFile, join(pluginRoot, "skills", "foo", "SKILL.md"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        ctx.skip();
        return;
      }
      // 形态 2：声明根（bundle-root）自身目录真实，SKILL.md 是外部文件链接。
      await mkdir(join(pluginRoot, "bundle-root"), { recursive: true });
      await symlink(outsideFile, join(pluginRoot, "bundle-root", "SKILL.md"));
      // 对照组：真实文件技能正常发现。
      await mkdir(join(pluginRoot, "skills", "legit"), { recursive: true });
      await writeFile(
        join(pluginRoot, "skills", "legit", "SKILL.md"),
        "---\nname: legit\ndescription: legitimate\n---\n# legit",
      );

      const outcome = await createNodePluginAdapter({
        storageRoot: join(dir, "plugins"),
      }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {},
        storageRoot: join(dir, "plugins"),
        workingDirectory: join(dir, "workspace"),
      });

      // 只有真实文件技能被计数；两个文件级链接形态都被剔除。
      const plugin = outcome.plugins.find((item) => item.id === "file-symlink-escape@inline");
      expect(plugin).toMatchObject({ skillCount: 1 });
      expect(componentNames(plugin?.components ?? [], "skill")).toEqual(["legit"]);

      const skillOutcome = await createNodeSkillAdapter().discoverSkills({
        roots: outcome.skillRoots,
        workingDirectory: join(dir, "workspace"),
      });
      expect(skillOutcome.skills.map((skill) => skill.name)).toEqual(["legit"]);
      // 泄密文件内容绝不出现在任何技能路径的加载结果里。
      expect(skillOutcome.skills.some((skill) => skill.path === outsideFile)).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // 信任边界回归（目录级 symlink/junction）：plugin-scope 扫描不跟随符号链接——
  //   skills/evil-link -> ../../outside-skill（子目录是逃逸链接）
  //   skills/linked-root -> ../../outside-skill（声明根本身是逃逸链接）
  // 两种形态都被剔除；声明根是链接时扫描为空，落入「没有任何技能」告警。
  // Windows 用 junction 创建（无需特权；lstat/Dirent 对 junction 同样报告
  // isSymbolicLink=true），CR-02 的 Windows 形态在本用例获得真实覆盖。
  it("strips symlink escapes from plugin skills and warns on escaping declared roots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-symlink-escape-"));
    const pluginRoot = join(dir, "plugin");
    const outsideSkill = join(dir, "outside-skill");

    try {
      await writePluginManifest(
        pluginRoot,
        {
          name: "symlink-escape",
          skills: ["./skills/linked-root", "./skills"],
        },
        ".claude-plugin",
      );
      await mkdir(outsideSkill, { recursive: true });
      await writeFile(
        join(outsideSkill, "SKILL.md"),
        "---\nname: escaped-skill\ndescription: must never load\n---\n# x",
      );
      // 形态 1：声明根本身是指向插件根外的链接（skills/ 需先存在）。
      // Windows 传 junction 类型（目录 symlink 需特权，junction 不需要；
      // POSIX 忽略该参数，行为为普通 symlink）。
      await mkdir(join(pluginRoot, "skills"), { recursive: true });
      await symlinkDir(outsideSkill, join(pluginRoot, "skills", "linked-root"));
      // 形态 2：默认 skills/ 根下的子目录是指向插件根外的链接。
      await symlinkDir(outsideSkill, join(pluginRoot, "skills", "evil-link"));

      const outcome = await createNodePluginAdapter({
        storageRoot: join(dir, "plugins"),
      }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {},
        storageRoot: join(dir, "plugins"),
        workingDirectory: join(dir, "workspace"),
      });

      // 逃逸技能不进计数、不进组件清单。
      const plugin = outcome.plugins.find((item) => item.id === "symlink-escape@inline");
      expect(plugin).toMatchObject({ skillCount: 0 });
      expect(componentNames(plugin?.components ?? [], "skill")).toEqual([]);

      // 声明根本身是链接 → 扫描为空，落入「没有任何技能」告警（词法路径存在，
      // 不误报 does not exist）。
      expect(
        outcome.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "plugin_skill_root_empty" &&
            diagnostic.pluginId === "symlink-escape@inline" &&
            diagnostic.message.includes("does not contain any skills") &&
            diagnostic.message.includes("skills/linked-root"),
        ),
      ).toBe(true);

      // 运行时发现同样剔除：逃逸技能不出现在 skill adapter 结果。
      const skillOutcome = await createNodeSkillAdapter().discoverSkills({
        roots: outcome.skillRoots,
        workingDirectory: join(dir, "workspace"),
      });
      expect(skillOutcome.skills.map((skill) => skill.name)).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // 去静默：manifest 显式声明的技能路径扫描为 0 个技能时必须发 warning（路径写进 message，
  // 因为协议 wire schema 不携带 path）；纯默认目录为空不告警；显式声明默认目录名同样算声明。
  it("warns when a declared skill path yields no skills", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-empty-skills-"));

    async function discover(pluginRoot: string, manifest: Record<string, unknown>) {
      await writePluginManifest(pluginRoot, manifest, ".claude-plugin");
      return await createNodePluginAdapter({ storageRoot: join(dir, "plugins") }).discoverPlugins({
        config: {
          dirs: [pluginRoot],
          enabled: true,
          enabledPlugins: {},
          options: {},
        },
        env: {},
        storageRoot: join(dir, "plugins"),
        workingDirectory: join(dir, "workspace"),
      });
    }

    try {
      // 场景 1：数组声明项目录存在但无 SKILL.md（分类目录，mattpocock 复现形态）。
      const missingRoot = join(dir, "declared-missing");
      await mkdir(join(missingRoot, "skills", "engineering"), { recursive: true });
      const missingOutcome = await discover(missingRoot, {
        name: "declared-missing",
        skills: ["./skills/engineering/tdd"],
      });
      const missingWarning = missingOutcome.diagnostics.find(
        (diagnostic) => diagnostic.code === "plugin_skill_root_empty",
      );
      expect(missingWarning).toMatchObject({
        pluginId: "declared-missing@inline",
        severity: "warning",
      });
      expect(missingWarning?.message).toContain("skills/engineering/tdd");

      // 场景 2：显式声明不存在的路径。
      const absentOutcome = await discover(join(dir, "declared-absent"), {
        name: "declared-absent",
        skills: "./skills/nowhere",
      });
      expect(
        absentOutcome.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "plugin_skill_root_empty" &&
            diagnostic.message.includes("skills/nowhere"),
        ),
      ).toBe(true);

      // 场景 3：纯默认目录为空（manifest 未声明 skills）不告警，避免空插件误报。
      const silentOutcome = await discover(join(dir, "default-only"), {
        name: "default-only",
      });
      expect(
        silentOutcome.diagnostics.every(
          (diagnostic) => diagnostic.code !== "plugin_skill_root_empty",
        ),
      ).toBe(true);

      // 场景 4：显式写默认目录名 "skills" 且目录为空——默认项会在 roots 里被去重合并，
      // 但声明集合独立计算，仍须告警。
      const explicitOutcome = await discover(join(dir, "explicit-default"), {
        name: "explicit-default",
        skills: "skills",
      });
      expect(
        explicitOutcome.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "plugin_skill_root_empty" &&
            diagnostic.pluginId === "explicit-default@inline",
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

function componentNames(
  components: Awaited<ReturnType<typeof describeMarketplacePlugin>>["components"],
  kind: "agent" | "command" | "skill" | "hook" | "mcp",
): string[] {
  return components.find((group) => group.kind === kind)?.items.map((item) => item.name) ?? [];
}

function componentDescription(
  components: Awaited<ReturnType<typeof describeMarketplacePlugin>>["components"],
  kind: "agent" | "command" | "skill" | "hook" | "mcp",
  name: string,
): string | undefined {
  return components.find((group) => group.kind === kind)?.items.find((item) => item.name === name)
    ?.description;
}

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
  const baseUrl = await listenLoopbackServer(server);
  return { baseUrl, server };
}

async function listenLoopbackServer(server: Server): Promise<string> {
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
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

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
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

/** 创建指向目录的链接：Windows 用 junction（无需特权），POSIX 忽略 type 参数。 */
async function symlinkDir(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : undefined);
}

async function writePluginManifest(
  pluginRoot: string,
  manifest: Record<string, unknown>,
  manifestDir = ".zcode-plugin",
): Promise<void> {
  await mkdir(join(pluginRoot, manifestDir), { recursive: true });
  await writeFile(join(pluginRoot, manifestDir, "plugin.json"), JSON.stringify(manifest));
}

async function writeMarketplaceManifest(
  marketplaceRoot: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await mkdir(join(marketplaceRoot, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
    JSON.stringify(manifest),
  );
}

async function writeKnownMarketplaces(
  storageRoot: string,
  marketplaces: Array<Record<string, unknown>>,
): Promise<void> {
  await mkdir(storageRoot, { recursive: true });
  await writeFile(
    join(storageRoot, "known_marketplaces.json"),
    JSON.stringify({ version: 1, marketplaces }),
  );
}

async function listenServer(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

interface TripletPluginFixture {
  commandCount: number;
  commandPrefix: string;
  manifestPaths?: boolean;
  mcpFileName?: ".mcp.json" | "mcp.json";
  mcpServerName: string;
  name: string;
  skillCount: number;
}

function claudeMarketplaceTripletFixtures(): TripletPluginFixture[] {
  return [
    {
      commandCount: 27,
      commandPrefix: "bigdata",
      mcpServerName: "bigdata",
      name: "bigdata-com",
      skillCount: 1,
    },
    {
      commandCount: 1,
      commandPrefix: "convex",
      manifestPaths: true,
      mcpServerName: "convex",
      name: "convex",
      skillCount: 2,
    },
    {
      commandCount: 4,
      commandPrefix: "logfire",
      manifestPaths: true,
      mcpFileName: "mcp.json",
      mcpServerName: "logfire",
      name: "logfire",
      skillCount: 3,
    },
  ];
}

async function writeTripletPluginFixture(
  pluginRoot: string,
  fixture: TripletPluginFixture,
): Promise<void> {
  const mcpFileName = fixture.mcpFileName ?? ".mcp.json";
  await writePluginManifest(
    pluginRoot,
    {
      ...(fixture.manifestPaths
        ? {
            commands: "./commands/",
            mcpServers: `./${mcpFileName}`,
            skills: "./skills/",
          }
        : {}),
      name: fixture.name,
      version: "1.0.0",
    },
    ".claude-plugin",
  );

  for (let index = 1; index <= fixture.skillCount; index += 1) {
    const skillName = `${fixture.name}-skill-${index}`;
    const skillDir = join(pluginRoot, "skills", skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        `name: ${skillName}`,
        `description: ${fixture.name} marketplace compatibility skill ${index}`,
        "---",
        "",
        `# ${skillName}`,
        "",
        "Validate plugin skill projection.",
      ].join("\n"),
    );
  }

  const commandDir = join(pluginRoot, "commands", fixture.commandPrefix);
  await mkdir(commandDir, { recursive: true });
  for (let index = 1; index <= fixture.commandCount; index += 1) {
    const commandName = `cmd${String(index).padStart(2, "0")}`;
    await writeFile(
      join(commandDir, `${commandName}.md`),
      [
        "---",
        `description: ${fixture.name} marketplace compatibility command ${index}`,
        "allowed-tools: Read, Bash",
        "---",
        "",
        `Run ${fixture.name} command ${index} with $ARGUMENTS.`,
      ].join("\n"),
    );
  }

  await writeFile(
    join(pluginRoot, mcpFileName),
    JSON.stringify({
      mcpServers: {
        [fixture.mcpServerName]: {
          args: ["${CLAUDE_PLUGIN_ROOT}/mcp/server.js"],
          command: "node",
          env: {
            PLUGIN_DATA: "${CLAUDE_PLUGIN_DATA}",
            PROJECT_DIR: "${ZCODE_PROJECT_DIR}",
          },
        },
      },
    }),
  );
}
