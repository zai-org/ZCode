import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { Logger } from "@zcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({
  afterWriteFile: undefined as ((path: string) => void) | undefined,
  failTemporaryRemoveOnce: undefined as string | undefined,
  watchedSourceRoot: undefined as string | undefined,
  sourcePayloadReads: [] as string[],
  sourceDirectoryReads: [] as string[],
  omitSeedManifest: false,
  fileFactsReads: 0,
  afterFileFacts: undefined as (() => Promise<void>) | undefined,
  afterBackupRename: undefined as (() => Promise<void>) | undefined,
  seedLockTargets: [] as string[],
  afterSeedLock: undefined as (() => void) | undefined,
  crossDeviceBackupTargetSuffix: undefined as string | undefined,
  crossDevicePromoteTargetSuffix: undefined as string | undefined,
  moveTargetSuffix: undefined as string | undefined,
  promoteCurrentTargetSuffix: undefined as string | undefined,
  promoteTargetSuffix: undefined as string | undefined,
  recoverBackupTargetSuffix: undefined as string | undefined,
  removeTargetSuffix: undefined as string | undefined,
  runtimeManifestNotFoundTargetSuffix: undefined as string | undefined,
  runtimeManifestTargetSuffix: undefined as string | undefined,
  seedLockHeldTargetSuffixes: [] as string[],
  seedLockObservedTimeoutsMs: [] as number[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async writeFile(...args: Parameters<typeof actual.writeFile>) {
      await actual.writeFile(...args);
      faults.afterWriteFile?.(String(args[0]));
    },
    async rm(...args: Parameters<typeof actual.rm>) {
      if (String(args[0]) === faults.failTemporaryRemoveOnce) {
        faults.failTemporaryRemoveOnce = undefined;
        throw Object.assign(new Error("temporary directory is busy"), { code: "EPERM" });
      }
      return actual.rm(...args);
    },
    async readFile(...args: Parameters<typeof actual.readFile>) {
      const path = String(args[0]);
      if (
        faults.watchedSourceRoot &&
        path.startsWith(faults.watchedSourceRoot + sep) &&
        !path.endsWith(join(".zcode-plugin", "plugin.json"))
      )
        faults.sourcePayloadReads.push(path);
      return actual.readFile(...args);
    },
    async readdir(...args: Parameters<typeof actual.readdir>) {
      const path = String(args[0]);
      if (
        faults.watchedSourceRoot &&
        (path === faults.watchedSourceRoot || path.startsWith(faults.watchedSourceRoot + sep))
      )
        faults.sourceDirectoryReads.push(path);
      return actual.readdir(...args);
    },
  };
});

vi.mock("../src/app/official-plugin-cache-fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app/official-plugin-cache-fs.js")>();
  return {
    ...actual,
    async collectOfficialPluginSourceFiles(
      ...args: Parameters<typeof actual.collectOfficialPluginSourceFiles>
    ) {
      const files = await actual.collectOfficialPluginSourceFiles(...args);
      // 模拟入口检查通过后，目录枚举前 manifest 消失；不能提交残缺版本 marker。
      return faults.omitSeedManifest && args[0] === faults.watchedSourceRoot
        ? files.filter((file) => file.path !== ".zcode-plugin/plugin.json")
        : files;
    },
    async readOfficialPluginFileFacts(paths: readonly string[]) {
      const facts = await actual.readOfficialPluginFileFacts(paths);
      faults.fileFactsReads += 1;
      await faults.afterFileFacts?.();
      return facts;
    },
    async removeOfficialPluginCacheDirectory(
      path: string,
      budget: Parameters<typeof actual.removeOfficialPluginCacheDirectory>[1],
    ): Promise<void> {
      if (faults.removeTargetSuffix && path.endsWith(faults.removeTargetSuffix)) {
        throw exhaustedErrno("EPERM");
      }
      await actual.removeOfficialPluginCacheDirectory(path, budget);
    },
    async renameOfficialPluginCachePath(
      fromPath: string,
      toPath: string,
      budget: ReturnType<typeof actual.createOfficialPluginCacheRetryBudget>,
    ): Promise<void> {
      if (
        faults.recoverBackupTargetSuffix &&
        fromPath === `${toPath}.backup` &&
        toPath.endsWith(faults.recoverBackupTargetSuffix)
      ) {
        throw errno("EOWNER");
      }
      // overlayfs（未启用 redirect_dir）拒绝 rename 位于镜像下层的目录，同一父目录内也返回 EXDEV；
      // 该错误不会因重试消失，与容器内复现到的内核行为一致。
      if (
        faults.crossDeviceBackupTargetSuffix &&
        fromPath.endsWith(faults.crossDeviceBackupTargetSuffix) &&
        toPath.startsWith(`${fromPath}.backup-`)
      ) {
        throw errno("EXDEV");
      }
      if (
        faults.crossDevicePromoteTargetSuffix &&
        fromPath.includes(".tmp-") &&
        toPath.endsWith(faults.crossDevicePromoteTargetSuffix)
      ) {
        throw errno("EXDEV");
      }
      if (
        faults.moveTargetSuffix &&
        fromPath.endsWith(faults.moveTargetSuffix) &&
        toPath.startsWith(`${fromPath}.backup-`)
      ) {
        await actual.removeOfficialPluginCacheDirectory(fromPath, budget);
        throw errno("ENOENT");
      }
      if (
        faults.promoteCurrentTargetSuffix &&
        fromPath.includes(".tmp-") &&
        toPath.endsWith(faults.promoteCurrentTargetSuffix)
      ) {
        await actual.renameOfficialPluginCachePath(fromPath, toPath, budget);
        throw errno("EEXIST");
      }
      if (
        faults.promoteTargetSuffix &&
        fromPath.includes(".tmp-") &&
        toPath.endsWith(faults.promoteTargetSuffix)
      ) {
        throw exhaustedErrno("EPERM");
      }
      await actual.renameOfficialPluginCachePath(fromPath, toPath, budget);
      if (toPath.startsWith(`${fromPath}.backup-`)) await faults.afterBackupRename?.();
    },
    async writeTextFileAtomicallyWithRetry(
      path: string,
      contents: string,
      budget: ReturnType<typeof actual.createOfficialPluginCacheRetryBudget>,
    ): Promise<void> {
      if (
        faults.runtimeManifestNotFoundTargetSuffix &&
        path.endsWith(faults.runtimeManifestNotFoundTargetSuffix)
      ) {
        throw errno("ENOENT");
      }
      if (faults.runtimeManifestTargetSuffix && path.endsWith(faults.runtimeManifestTargetSuffix)) {
        throw exhaustedErrno("EPERM");
      }
      await actual.writeTextFileAtomicallyWithRetry(path, contents, budget);
    },
  };
});

vi.mock("../src/app/official-plugin-seed-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app/official-plugin-seed-lock.js")>();
  return {
    ...actual,
    async withOfficialPluginSeedLock<T>(
      targetRoot: string,
      action: () => T,
      options?: Parameters<typeof actual.withOfficialPluginSeedLock>[2],
    ): Promise<T> {
      faults.seedLockTargets.push(targetRoot);
      if (!faults.seedLockHeldTargetSuffixes.some((suffix) => targetRoot.endsWith(suffix))) {
        const result = await actual.withOfficialPluginSeedLock(targetRoot, action, options);
        faults.afterSeedLock?.();
        return result;
      }
      faults.seedLockObservedTimeoutsMs.push(options?.timeoutMs ?? -1);
      // 只压缩等待参数并保留调用方预算上限（默认 15s 会拖垮测试），
      // 仍走真实锁竞争与真实超时错误。
      return await actual.withOfficialPluginSeedLock(targetRoot, action, {
        ...options,
        retryDelayMs: 1,
        timeoutMs: Math.min(10, options?.timeoutMs ?? 10),
      });
    },
  };
});

import {
  createOfficialPluginPreparation,
  resolveOfficialPluginRoots,
} from "../src/app/bundled-plugins.js";
import { OFFICIAL_PLUGIN_DEFINITIONS } from "../src/app/official-plugin-definitions.js";
import { resolveZCodePlugins } from "../src/plugins.js";

const OFFICIAL_CACHE_ROOT = join("cache", "zcode-plugins-official");
const BROWSER_CACHE_SUFFIX = join(OFFICIAL_CACHE_ROOT, "browser-use", "0.5.1");
const ANDROID_CACHE_SUFFIX = join(OFFICIAL_CACHE_ROOT, "android-emulator", "0.1.1");
const SKILL_CREATOR_CACHE_SUFFIX = join(OFFICIAL_CACHE_ROOT, "skill-creator", "0.1.0");
const ANDROID_MANIFEST_SUFFIX = join(ANDROID_CACHE_SUFFIX, ".zcode-plugin", "plugin.json");
const CUA_DEFINITION = OFFICIAL_PLUGIN_DEFINITIONS.find(({ name }) => name === "computer-use");
if (!CUA_DEFINITION) throw new Error("computer-use official plugin definition is missing");
const CUA_CACHE_SUFFIX = join(OFFICIAL_CACHE_ROOT, CUA_DEFINITION.name, CUA_DEFINITION.version);

describe("bundled official plugin cache resilience", () => {
  const cleanups: string[] = [];
  const originalEntrypoint = process.argv[1];

  afterEach(async () => {
    vi.useRealTimers();
    faults.afterWriteFile = undefined;
    faults.failTemporaryRemoveOnce = undefined;
    faults.watchedSourceRoot = undefined;
    faults.sourcePayloadReads = [];
    faults.sourceDirectoryReads = [];
    faults.omitSeedManifest = false;
    faults.fileFactsReads = 0;
    faults.afterFileFacts = undefined;
    faults.afterBackupRename = undefined;
    faults.seedLockTargets = [];
    faults.afterSeedLock = undefined;
    process.argv[1] = originalEntrypoint;
    faults.crossDeviceBackupTargetSuffix = undefined;
    faults.crossDevicePromoteTargetSuffix = undefined;
    faults.moveTargetSuffix = undefined;
    faults.promoteCurrentTargetSuffix = undefined;
    faults.promoteTargetSuffix = undefined;
    faults.recoverBackupTargetSuffix = undefined;
    faults.removeTargetSuffix = undefined;
    faults.runtimeManifestNotFoundTargetSuffix = undefined;
    faults.runtimeManifestTargetSuffix = undefined;
    faults.seedLockHeldTargetSuffixes = [];
    faults.seedLockObservedTimeoutsMs = [];
    await Promise.all(cleanups.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it.each([false, true])("keeps SEA payload hash validation (corrupt: %s)", async (corrupt) => {
    const storageRoot = await createStorageRoot(cleanups);
    const payloads: Record<string, string> = {
      ".zcode-plugin/plugin.json": JSON.stringify({ name: "skill-creator", version: "0.1.0" }),
      "skills/demo/SKILL.md": "# original SEA skill",
    };
    const files = Object.entries(payloads).map(([path, text]) => ({
      path,
      sha256: createHash("sha256").update(text).digest("hex"),
    }));
    const prefix = "zcode-official-plugins/zcode-plugins-official/skill-creator/0.1.0/";
    const getBuiltinModule = process.getBuiltinModule.bind(process);
    const builtin = vi.spyOn(process, "getBuiltinModule").mockImplementation((id) => {
      if (id !== "node:sea") return getBuiltinModule(id);
      return {
        isSea: () => true,
        getAsset: () =>
          JSON.stringify({
            version: 1,
            plugins: [
              {
                marketplace: "zcode-plugins-official",
                name: "skill-creator",
                version: "0.1.0",
                files,
              },
            ],
          }),
        getRawAsset: (key: string) => {
          const path = key.slice(prefix.length);
          const text = corrupt && path === "skills/demo/SKILL.md" ? "# corrupted" : payloads[path];
          return new Uint8Array(Buffer.from(text)).buffer;
        },
      };
    });
    try {
      const prepared = resolveOfficialPluginRoots({ storageRoot, logger: createLogger() });
      if (corrupt)
        await expect(prepared).rejects.toMatchObject({ code: "ZCODE_PLUGIN_SOURCES_CHANGED" });
      else await prepared;
      const marker = join(storageRoot, SKILL_CREATOR_CACHE_SUFFIX, ".zcode-plugin-seed.json");
      expect(existsSync(marker)).toBe(!corrupt);
      if (!corrupt)
        expect(JSON.parse(await readFile(marker, "utf8")).hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      builtin.mockRestore();
    }
  });

  it("shares a startup deadline and keeps timeout degradation until a new owner", async () => {
    vi.useFakeTimers();
    const preparation = createOfficialPluginPreparation({ startupTimeoutMs: 3_000 });
    const late = Promise.withResolvers<Awaited<ReturnType<typeof resolveZCodePlugins>>>();
    const success = {
      commandRoots: [],
      diagnostics: [],
      hooks: {},
      mcpServers: {},
      plugins: [],
      skillRoots: [],
    };
    const first = preparation.resolvePlugins(() => late.promise);
    await vi.advanceTimersByTimeAsync(2_900);
    const second = preparation.resolvePlugins(() => late.promise);
    await vi.advanceTimersByTimeAsync(100);
    for (const outcome of await Promise.all([first, second])) {
      expect(outcome).toMatchObject({
        ...success,
        diagnostics: [{ code: "plugin_startup_timeout", severity: "warning" }],
      });
    }
    expect(preparation.startupDegraded).toBe(true);
    expect(preparation.signal.aborted).toBe(true);
    late.resolve(success);
    preparation.invalidate();
    const unexpected = vi.fn(async () => success);
    await preparation.resolvePlugins(unexpected);
    expect(unexpected).not.toHaveBeenCalled();
    await preparation.dispose();
    const next = createOfficialPluginPreparation({ startupTimeoutMs: 3_000 });
    await expect(next.resolvePlugins(unexpected)).resolves.toEqual(success);
    expect(unexpected).toHaveBeenCalledOnce();
    expect(next.startupDegraded).toBe(false);
    const pending = next.resolvePlugins(() => new Promise(() => {}));
    const closed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await next.dispose();
    await closed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips discovery and fallback scans after seed exceeds the startup budget", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    vi.useFakeTimers();
    const preparation = createOfficialPluginPreparation({ startupTimeoutMs: 3_000 });
    const seed = Promise.withResolvers<[]>();
    const prepare = vi.spyOn(preparation, "prepare").mockImplementation(() => seed.promise);
    const discoverPlugins = vi.fn();
    const options = {
      pluginStorageRoot: storageRoot,
      workingDirectory: dirname(storageRoot),
      skipUserConfig: true,
      pluginPreparation: preparation,
      pluginDiscovery: { discoverPlugins },
    };
    const first = resolveZCodePlugins(options);
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await first).diagnostics).toEqual([
      expect.objectContaining({ code: "plugin_startup_timeout" }),
    ]);
    seed.reject(new Error("late seed failure"));
    await resolveZCodePlugins(options);
    expect(prepare).toHaveBeenCalledOnce();
    expect(discoverPlugins).not.toHaveBeenCalled();
    await preparation.dispose();
  });

  it("lets directory publication finish safely after the startup caller times out", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    await resolveOfficialPluginRoots({ storageRoot });
    const targetRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    await writeFile(join(targetRoot, ".zcode-plugin-seed.json"), "{}");
    vi.useFakeTimers();
    const moved = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    faults.afterBackupRename = async () => {
      faults.afterBackupRename = undefined;
      moved.resolve();
      await release.promise;
    };
    const preparation = createOfficialPluginPreparation({ startupTimeoutMs: 3_000 });
    const work = preparation.resolvePlugins(async () => {
      await resolveOfficialPluginRoots({ storageRoot, preparation });
      return {
        commandRoots: [],
        diagnostics: [],
        hooks: {},
        mcpServers: {},
        plugins: [],
        skillRoots: [],
      };
    });
    try {
      await moved.promise;
      await vi.advanceTimersByTimeAsync(3_000);
      expect((await work).diagnostics[0]?.code).toBe("plugin_startup_timeout");
      expect(existsSync(`${targetRoot}.seed-lock`)).toBe(true);
    } finally {
      release.resolve();
      await preparation.dispose();
    }
    expect(existsSync(join(targetRoot, ".zcode-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(`${targetRoot}.seed-lock`)).toBe(false);
    await expectNoSeedBackups(targetRoot);
  }, 15_000);

  it("reuses filesystem versions across fresh owners without scanning or hashing source payload", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    const fixture = await createVersionedSource(storageRoot);
    await resolveOfficialPluginRoots({ storageRoot });
    const targetRoot = join(storageRoot, SKILL_CREATOR_CACHE_SUFFIX);
    const markerPath = join(targetRoot, ".zcode-plugin-seed.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    await writeFile(markerPath, JSON.stringify({ ...marker, hash: "legacy-content-hash" }));
    await writeFile(fixture.payload, "same version, changed source");
    faults.sourcePayloadReads = [];
    faults.sourceDirectoryReads = [];

    await resolveOfficialPluginRoots({ storageRoot });

    expect(faults.sourcePayloadReads).toEqual([]);
    expect(faults.sourceDirectoryReads).toEqual([]);
    expect(await readFile(join(targetRoot, "skills", "demo", "SKILL.md"), "utf8")).toBe(
      "original source",
    );
    expect(JSON.parse(await readFile(markerPath, "utf8")).hash).toBe("legacy-content-hash");
  });

  it("reseeds the same filesystem version when its declared build identity changes", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    const fixture = await createVersionedSource(storageRoot);
    const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((item) => item.name === "skill-creator")!;
    const mutable = definition as { buildIdentityPath?: string };
    const identityPath = join(fixture.root, "dist", "build-identity.json");
    const targetRoot = join(storageRoot, SKILL_CREATOR_CACHE_SUFFIX);
    const markerPath = join(targetRoot, ".zcode-plugin-seed.json");
    const cachedPayload = () => readFile(join(targetRoot, "skills", "demo", "SKILL.md"), "utf8");
    mutable.buildIdentityPath = "dist/build-identity.json";
    try {
      await mkdir(dirname(identityPath), { recursive: true });
      await writeFile(identityPath, '{"cuaHelperBuildId":"pipeline-1"}\n');
      await resolveOfficialPluginRoots({ storageRoot });
      expect(JSON.parse(await readFile(markerPath, "utf8")).buildIdentity).toBe(
        '{"cuaHelperBuildId":"pipeline-1"}\n',
      );

      // 同一构建身份仍按版本规则复用：只读身份小文件，不读取源正文。
      await writeFile(fixture.payload, "same build, edited source");
      faults.sourcePayloadReads = [];
      await resolveOfficialPluginRoots({ storageRoot });
      expect(faults.sourcePayloadReads.length).toBeGreaterThan(0);
      expect(faults.sourcePayloadReads.every((path) => path === identityPath)).toBe(true);
      expect(await cachedPayload()).toBe("original source");

      // 桌面升级换了 Helper build id，版本号不变也必须重建。
      await writeFile(identityPath, '{"cuaHelperBuildId":"pipeline-2"}\n');
      await writeFile(fixture.payload, "pipeline 2 build");
      await resolveOfficialPluginRoots({ storageRoot });
      expect(await cachedPayload()).toBe("pipeline 2 build");
      expect(JSON.parse(await readFile(markerPath, "utf8")).buildIdentity).toBe(
        '{"cuaHelperBuildId":"pipeline-2"}\n',
      );

      // 旧客户端写入的 marker 没有构建身份，同样视为过期。
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      delete marker.buildIdentity;
      await writeFile(markerPath, JSON.stringify(marker));
      await writeFile(fixture.payload, "after legacy marker");
      await resolveOfficialPluginRoots({ storageRoot });
      expect(await cachedPayload()).toBe("after legacy marker");
    } finally {
      delete mutable.buildIdentityPath;
    }
  });

  it.each([false, true])(
    "cleans a cancelled seed without changing the old target (busy=%s)",
    async (busy) => {
      const storageRoot = await createStorageRoot(cleanups);
      await createVersionedSource(storageRoot);
      await resolveOfficialPluginRoots({ storageRoot });
      const targetRoot = join(storageRoot, SKILL_CREATOR_CACHE_SUFFIX);
      const markerPath = join(targetRoot, ".zcode-plugin-seed.json");
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      const staleMarker = JSON.stringify({ ...marker, pluginVersion: "0.0.0" });
      await writeFile(markerPath, staleMarker);
      const preparation = createOfficialPluginPreparation();
      let disposal: Promise<void> | undefined;
      faults.afterWriteFile = (path) => {
        if (disposal || !path.startsWith(`${targetRoot}.tmp-`)) return;
        // 写入第一份候选文件后中止，确保真实临时目录存在；取消与预算到期共用此 signal。
        if (busy)
          faults.failTemporaryRemoveOnce = path.slice(0, path.indexOf(sep, targetRoot.length));
        disposal = preparation.dispose();
      };
      try {
        await expect(
          resolveOfficialPluginRoots({ storageRoot, preparation }),
        ).rejects.toBeInstanceOf(Error);
        expect(preparation.signal.aborted).toBe(true);
        await disposal;
        expect(await readdir(dirname(targetRoot))).not.toEqual(
          expect.arrayContaining([expect.stringContaining(".tmp-")]),
        );
        expect(await readFile(markerPath, "utf8")).toBe(staleMarker);
        expect(await readFile(join(targetRoot, "skills", "demo", "SKILL.md"), "utf8")).toBe(
          "original source",
        );
      } finally {
        await preparation.dispose();
      }
    },
  );

  it("copies filesystem payload once when a version marker differs or is missing", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    const fixture = await createVersionedSource(storageRoot);
    await resolveOfficialPluginRoots({ storageRoot });
    const targetRoot = join(storageRoot, SKILL_CREATOR_CACHE_SUFFIX);
    const markerPath = join(targetRoot, ".zcode-plugin-seed.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    await writeFile(markerPath, JSON.stringify({ ...marker, pluginVersion: "0.0.0" }));
    for (const removeMarker of [false, true]) {
      if (removeMarker) await rm(markerPath);
      await writeFile(fixture.payload, `replacement ${removeMarker}`);
      faults.sourcePayloadReads = [];
      faults.sourceDirectoryReads = [];
      await resolveOfficialPluginRoots({ storageRoot });
      expect(faults.sourcePayloadReads).toEqual([fixture.payload]);
      expect(faults.sourceDirectoryReads.length).toBeGreaterThan(0);
      expect(await readFile(join(targetRoot, "skills", "demo", "SKILL.md"), "utf8")).toBe(
        `replacement ${removeMarker}`,
      );
      expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({
        pluginVersion: "0.1.0",
      });
      expect(JSON.parse(await readFile(markerPath, "utf8"))).not.toHaveProperty("hash");
    }
  });

  it("seeds a bumped filesystem version while preserving the previous version", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    const fixture = await createVersionedSource(storageRoot);
    await resolveOfficialPluginRoots({ storageRoot });
    const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((item) => item.name === "skill-creator")!;
    const previousVersion = definition.version;
    try {
      definition.version = "0.1.1";
      await writeFile(
        join(fixture.root, ".zcode-plugin", "plugin.json"),
        JSON.stringify({ name: definition.name, version: definition.version }),
      );
      await writeFile(fixture.payload, "new version");
      faults.sourcePayloadReads = [];
      await resolveOfficialPluginRoots({ storageRoot });
      expect(faults.sourcePayloadReads).toEqual([fixture.payload]);
      expect(
        await readFile(
          join(
            storageRoot,
            OFFICIAL_CACHE_ROOT,
            "skill-creator",
            "0.1.1",
            "skills",
            "demo",
            "SKILL.md",
          ),
          "utf8",
        ),
      ).toBe("new version");
      expect(
        await readFile(
          join(storageRoot, SKILL_CREATOR_CACHE_SUFFIX, "skills", "demo", "SKILL.md"),
          "utf8",
        ),
      ).toBe("original source");
    } finally {
      definition.version = previousVersion;
    }
  });

  it("does not publish a version marker for an incomplete staged filesystem source", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    await createVersionedSource(storageRoot);
    faults.omitSeedManifest = true;
    await expect(resolveOfficialPluginRoots({ storageRoot })).rejects.toMatchObject({
      code: "ZCODE_PLUGIN_SOURCES_CHANGED",
    });
    expect(
      existsSync(join(storageRoot, SKILL_CREATOR_CACHE_SUFFIX, ".zcode-plugin-seed.json")),
    ).toBe(false);
  });

  it("reuses only validated successful preparation and invalidates on cache loss or explicit refresh", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    const preparation = createOfficialPluginPreparation();
    try {
      await resolveOfficialPluginRoots({ storageRoot, preparation });
      expect(faults.seedLockTargets.length).toBeGreaterThan(0);
      faults.seedLockTargets = [];
      faults.fileFactsReads = 0;
      await resolveOfficialPluginRoots({ storageRoot, preparation });
      expect(faults.seedLockTargets).toEqual([]);
      expect(faults.fileFactsReads).toBe(2);
      process.argv[1] = join(storageRoot, "changed-cli-entry.cjs");
      await resolveOfficialPluginRoots({ storageRoot, preparation });
      expect(faults.seedLockTargets.length).toBeGreaterThan(0);
      faults.seedLockTargets = [];
      await rm(join(storageRoot, BROWSER_CACHE_SUFFIX, ".zcode-plugin-seed.json"));
      await resolveOfficialPluginRoots({ storageRoot, preparation });
      expect(faults.seedLockTargets.length).toBeGreaterThan(0);
      faults.seedLockTargets = [];
      preparation.invalidate();
      await resolveOfficialPluginRoots({ storageRoot, preparation });
      expect(faults.seedLockTargets.length).toBeGreaterThan(0);
    } finally {
      await preparation.dispose();
    }
    await expect(resolveOfficialPluginRoots({ storageRoot, preparation })).rejects.toMatchObject({
      name: "AbortError",
    });
  }, 15_000);

  it.each(["marker deletion", "manifest replacement"] as const)(
    "revalidates a cache hit against its original facts after %s",
    async (mutation) => {
      const storageRoot = await createStorageRoot(cleanups);
      const preparation = createOfficialPluginPreparation();
      const targetRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
      const markerPath = join(targetRoot, ".zcode-plugin-seed.json");
      const manifestPath = join(targetRoot, ".zcode-plugin", "plugin.json");
      try {
        await resolveOfficialPluginRoots({ storageRoot, preparation });
        const originalManifest = await readFile(manifestPath, "utf8");
        faults.seedLockTargets = [];
        faults.afterFileFacts = async () => {
          faults.afterFileFacts = undefined;
          // 首次检查已读到旧状态后再改盘，覆盖可复用判定与最终校验之间的窗口。
          if (mutation === "marker deletion") await rm(markerPath);
          else await writeFile(manifestPath, JSON.stringify({ name: "external-replacement" }));
        };

        await expect(resolveOfficialPluginRoots({ storageRoot, preparation })).resolves.toEqual([]);

        expect(faults.seedLockTargets).toContain(targetRoot);
        expect(existsSync(markerPath)).toBe(true);
        expect(await readFile(manifestPath, "utf8")).toBe(originalManifest);
      } finally {
        await preparation.dispose();
      }
    },
    15_000,
  );

  it("does not remember partial seed failure as successful preparation", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    const preparation = createOfficialPluginPreparation();
    faults.promoteTargetSuffix = BROWSER_CACHE_SUFFIX;
    try {
      await resolveOfficialPluginRoots({ storageRoot, preparation });
      faults.seedLockTargets = [];
      await resolveOfficialPluginRoots({ storageRoot, preparation });
      expect(faults.seedLockTargets.some((path) => path.endsWith(BROWSER_CACHE_SUFFIX))).toBe(true);
      faults.promoteTargetSuffix = undefined;
      await resolveOfficialPluginRoots({ storageRoot, preparation });
      expect(existsSync(join(storageRoot, BROWSER_CACHE_SUFFIX))).toBe(true);
    } finally {
      await preparation.dispose();
    }
  }, 15_000);

  it("discards in-flight preparation when its process owner closes", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    const preparation = createOfficialPluginPreparation();
    let disposed: Promise<void> | undefined;
    faults.afterSeedLock = () => {
      disposed = preparation.dispose();
      faults.afterSeedLock = undefined;
    };
    await expect(resolveOfficialPluginRoots({ storageRoot, preparation })).rejects.toMatchObject({
      name: "AbortError",
    });
    await disposed;
    expect(faults.seedLockTargets).toHaveLength(1);
  });

  it("bounds invalidation during preparation and allows a later retry", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    const preparation = createOfficialPluginPreparation();
    faults.afterSeedLock = () => preparation.invalidate();
    try {
      await expect(resolveOfficialPluginRoots({ storageRoot, preparation })).rejects.toMatchObject({
        code: "ZCODE_PLUGIN_SOURCES_CHANGED",
      });
      faults.afterSeedLock = undefined;
      await expect(resolveOfficialPluginRoots({ storageRoot, preparation })).resolves.toEqual([]);
    } finally {
      await preparation.dispose();
    }
  }, 15_000);

  it("degrades a persistent transient seed failure when the target is absent", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    const logger = createLogger();
    faults.promoteTargetSuffix = BROWSER_CACHE_SUFFIX;

    await expect(
      (async () => await resolveOfficialPluginRoots({ logger, storageRoot }))(),
    ).resolves.not.toBeInstanceOf(Error);

    expect(existsSync(join(storageRoot, BROWSER_CACHE_SUFFIX))).toBe(false);
    expect(existsSync(join(storageRoot, SKILL_CREATOR_CACHE_SUFFIX))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        attempts: 4,
        degraded: true,
        errorCode: "EPERM",
        operation: "seed_plugin",
        pluginId: "browser-use@zcode-plugins-official",
      }),
    );
  });

  it("keeps degraded cache diagnostics through the ordinary plugin resolver", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    const logger = createLogger();
    faults.promoteTargetSuffix = BROWSER_CACHE_SUFFIX;

    await expect(
      (async () =>
        await resolveZCodePlugins({
          logger,
          pluginStorageRoot: storageRoot,
          skipUserConfig: true,
          workingDirectory: dirname(storageRoot),
        }))(),
    ).resolves.not.toBeInstanceOf(Error);

    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        degraded: true,
        errorCode: "EPERM",
        pluginId: "browser-use@zcode-plugins-official",
      }),
    );
  });

  it("keeps a stale but usable target when promotion fails", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    await resolveOfficialPluginRoots({ storageRoot });
    const browserRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const markerPath = join(browserRoot, ".zcode-plugin-seed.json");
    const staleMarker = `${await readFile(markerPath, "utf8")}\n`;
    await writeFile(
      markerPath,
      staleMarker.replace('"pluginVersion": "', '"pluginVersion": "stale-'),
    );
    const logger = createLogger();
    faults.promoteTargetSuffix = BROWSER_CACHE_SUFFIX;

    await expect(
      (async () => await resolveOfficialPluginRoots({ logger, storageRoot }))(),
    ).resolves.not.toBeInstanceOf(Error);

    expect(existsSync(browserRoot)).toBe(true);
    expect(await readFile(markerPath, "utf8")).toContain('"pluginVersion": "stale-');
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        errorCode: "EPERM",
        operation: "seed_plugin",
        pluginId: "browser-use@zcode-plugins-official",
      }),
    );
  });

  it("falls back to a previous usable version when the new target cannot be promoted", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    expect(await resolveOfficialPluginRoots({ storageRoot })).toEqual([]);
    const currentRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const staleRoot = join(dirname(currentRoot), "0.2.1");
    await rename(currentRoot, staleRoot);
    faults.promoteTargetSuffix = BROWSER_CACHE_SUFFIX;

    const roots = await resolveOfficialPluginRoots({ storageRoot });

    expect(roots).toContain(staleRoot);
  });

  it("does not reactivate older Android code after a failed security update", async () => {
    const definition = OFFICIAL_PLUGIN_DEFINITIONS.find(({ name }) => name === "android-emulator");
    if (!definition) throw new Error("Android definition is missing");
    const storageRoot = await createStorageRoot(cleanups);
    await resolveOfficialPluginRoots({ storageRoot });
    const previousVersion = definition.version;
    const oldRoot = join(storageRoot, OFFICIAL_CACHE_ROOT, definition.name, previousVersion);
    try {
      definition.version = "0.1.2";
      faults.promoteTargetSuffix = join(OFFICIAL_CACHE_ROOT, definition.name, definition.version);
      const roots = await resolveOfficialPluginRoots({ storageRoot });
      expect(existsSync(oldRoot)).toBe(true);
      expect(roots).not.toContain(oldRoot);
    } finally {
      definition.version = previousVersion;
    }
  });

  it("degrades an incomplete seed source to a usable previous version instead of failing startup", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    expect(await resolveOfficialPluginRoots({ storageRoot })).toEqual([]);
    const currentRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const staleRoot = join(dirname(currentRoot), "0.2.1");
    await rename(currentRoot, staleRoot);
    await rm(join(storageRoot, SKILL_CREATOR_CACHE_SUFFIX), { force: true, recursive: true });
    // 入口目录旁只有一份缺 dist/docs/skills 的 browser-use 拷贝（升级中的桌面包、
    // 未构建 dist 的旧 checkout）；其余插件继续从真实 monorepo 源解析。
    const entrypointRoot = join(storageRoot, "stale-entrypoint");
    const incompletePluginRoot = join(entrypointRoot, "packages", "browser-use-plugin");
    await mkdir(join(incompletePluginRoot, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(incompletePluginRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "browser-use", version: "0.5.1" }),
    );
    process.argv[1] = join(entrypointRoot, "zcode.cjs");
    const logger = createLogger();

    let roots: string[] = [];
    await expect(
      (async () => {
        roots = await resolveOfficialPluginRoots({ logger, storageRoot });
      })(),
    ).resolves.not.toBeInstanceOf(Error);

    expect(roots).toContain(staleRoot);
    // 残缺源绝不能落成当前版本缓存（会永久命中版本），也不能拖垮其他插件的 seeding。
    expect(existsSync(currentRoot)).toBe(false);
    expect(existsSync(join(storageRoot, SKILL_CREATOR_CACHE_SUFFIX))).toBe(true);
    const marketplace = JSON.parse(
      await readFile(
        join(storageRoot, "marketplaces", "zcode-plugins-official", "marketplace.json"),
        "utf8",
      ),
    ) as { plugins: Array<{ name: string }> };
    expect(marketplace.plugins.some((plugin) => plugin.name === "browser-use")).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        degraded: true,
        errorCode: "ZCODE_PLUGIN_SEED_INCOMPLETE",
        // browser-use 不再携带 node_repl 宿主产物（那是 node-repl-host 的），
        // 它自己必需的运行时资产是 browser-client。
        missingSeedPaths: expect.arrayContaining(["scripts/browser-client.mjs"]),
        operation: "seed_plugin",
        pluginId: "browser-use@zcode-plugins-official",
      }),
    );
  });

  it("keeps session bootstrap alive when an incomplete seed source has no usable fallback cache", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    // 全新安装：storageRoot 从未 seed 过，也没有任何旧版本缓存可回退。
    const entrypointRoot = join(storageRoot, "fresh-install-entrypoint");
    const incompletePluginRoot = join(entrypointRoot, "packages", "browser-use-plugin");
    await mkdir(join(incompletePluginRoot, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(incompletePluginRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "browser-use", version: "0.5.1" }),
    );
    process.argv[1] = join(entrypointRoot, "zcode.cjs");
    const logger = createLogger();

    let outcome!: ReturnType<typeof resolveZCodePlugins>;
    await expect(
      (async () => {
        outcome = await resolveZCodePlugins({
          logger,
          pluginStorageRoot: storageRoot,
          skipUserConfig: true,
          workingDirectory: dirname(storageRoot),
        });
      })(),
    ).resolves.not.toBeInstanceOf(Error);

    // 降级终态之二：无可用旧缓存时该插件本次缺席（不写残缺缓存），只留 warning 级诊断，
    // 其余 defaultEnabled 插件与会话引导不受影响。
    expect(existsSync(join(storageRoot, BROWSER_CACHE_SUFFIX))).toBe(false);
    expect(
      outcome.plugins.find((plugin) => plugin.id === "browser-use@zcode-plugins-official"),
    ).toBeUndefined();
    const rootNotFound = outcome.diagnostics.filter(
      (diagnostic) => diagnostic.code === "plugin_root_not_found",
    );
    expect(rootNotFound).toEqual([
      expect.objectContaining({
        path: join(storageRoot, BROWSER_CACHE_SUFFIX),
        severity: "warning",
      }),
    ]);
    const documentSkills = outcome.plugins.find(
      (plugin) => plugin.id === "documents@zcode-plugins-official",
    );
    expect(documentSkills?.enabled).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        errorCode: "ZCODE_PLUGIN_SEED_INCOMPLETE",
        operation: "seed_plugin",
        pluginId: "browser-use@zcode-plugins-official",
      }),
    );
  });

  it("degrades a held seed lock to a usable previous version instead of failing startup", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    expect(await resolveOfficialPluginRoots({ storageRoot })).toEqual([]);
    const currentRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const staleRoot = join(dirname(currentRoot), "0.2.1");
    await rename(currentRoot, staleRoot);
    const lockRoot = `${currentRoot}.seed-lock`;
    await mkdir(lockRoot, { recursive: true });
    await writeFile(
      join(lockRoot, "owner.json"),
      JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid }),
    );
    const logger = createLogger();
    faults.seedLockHeldTargetSuffixes = [BROWSER_CACHE_SUFFIX];

    let roots: string[] = [];
    await expect(
      (async () => {
        roots = await resolveOfficialPluginRoots({ logger, storageRoot });
      })(),
    ).resolves.not.toBeInstanceOf(Error);

    expect(roots).toContain(staleRoot);
    // 锁属于「另一个进程」（owner 存活），降级方绝不能顺手删掉它。
    expect(existsSync(lockRoot)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        degraded: true,
        errorCode: "ZCODE_PLUGIN_SEED_LOCK_TIMEOUT",
        operation: "seed_plugin",
        pluginId: "browser-use@zcode-plugins-official",
      }),
    );
  });

  it("shares one seed lock wait budget across all plugins", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    expect(await resolveOfficialPluginRoots({ storageRoot })).toEqual([]);
    for (const cacheSuffix of [BROWSER_CACHE_SUFFIX, SKILL_CREATOR_CACHE_SUFFIX]) {
      const lockRoot = `${join(storageRoot, cacheSuffix)}.seed-lock`;
      await mkdir(lockRoot, { recursive: true });
      await writeFile(
        join(lockRoot, "owner.json"),
        JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid }),
      );
    }
    faults.seedLockHeldTargetSuffixes = [BROWSER_CACHE_SUFFIX, SKILL_CREATOR_CACHE_SUFFIX];

    await expect(
      (async () => await resolveOfficialPluginRoots({ storageRoot }))(),
    ).resolves.not.toBeInstanceOf(Error);

    // 两把被持有的锁必须共享同一截止时间：后一次调用拿到的剩余预算严格更小，
    // 而不是每个插件都重置成完整的 15s（否则成组遗留锁会让启动冻结 N×15s）。
    expect(faults.seedLockObservedTimeoutsMs).toHaveLength(2);
    const [firstBudgetMs, secondBudgetMs] = faults.seedLockObservedTimeoutsMs;
    expect(firstBudgetMs).toBeGreaterThan(0);
    expect(firstBudgetMs).toBeLessThanOrEqual(15_000);
    expect(secondBudgetMs).toBeLessThan(firstBudgetMs as number);
  });

  it("keeps an intact current cache discoverable when the seed lock times out", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    expect(await resolveOfficialPluginRoots({ storageRoot })).toEqual([]);
    // 当前版本目录保持完整（不 rename 成旧版本），只把锁交给「另一个存活进程」。
    const currentRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const lockRoot = `${currentRoot}.seed-lock`;
    await mkdir(lockRoot, { recursive: true });
    await writeFile(
      join(lockRoot, "owner.json"),
      JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid }),
    );
    const logger = createLogger();
    faults.seedLockHeldTargetSuffixes = [BROWSER_CACHE_SUFFIX];

    const outcome = await resolveZCodePlugins({
      logger,
      pluginStorageRoot: storageRoot,
      skipUserConfig: true,
      workingDirectory: dirname(storageRoot),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        errorCode: "ZCODE_PLUGIN_SEED_LOCK_TIMEOUT",
        operation: "seed_plugin",
        pluginId: "browser-use@zcode-plugins-official",
      }),
    );
    // 锁只保护 seed 写入，不保护读取：等锁超时不能让一份完整的当前缓存从 discovery 消失。
    // 该不变量依赖 bundled marketplace 分片在 seeding 循环之前写入且不按 seed 成败过滤；
    // 若未来把分片写入挪到循环之后，这条断言会失败。
    const browserPlugin = outcome.plugins.find(
      (plugin) => plugin.id === "browser-use@zcode-plugins-official",
    );
    expect(browserPlugin?.rootPath).toBe(currentRoot);
    expect(browserPlugin?.enabled).toBe(true);
    expect(
      outcome.diagnostics.filter((diagnostic) => diagnostic.code === "plugin_root_not_found"),
    ).toEqual([]);
  });

  it("does not mix an old zcode-cua cache with the current consumer contract", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    await resolveOfficialPluginRoots({ storageRoot });
    const currentRoot = join(storageRoot, CUA_CACHE_SUFFIX);
    const staleRoot = join(dirname(currentRoot), "0.5.9");
    await rename(currentRoot, staleRoot);
    faults.promoteTargetSuffix = CUA_CACHE_SUFFIX;

    const roots = await resolveOfficialPluginRoots({ storageRoot });

    expect(roots).not.toContain(staleRoot);
  });

  it("continues when another process moves the target after the existence check", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    await resolveOfficialPluginRoots({ storageRoot });
    const browserRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const markerPath = join(browserRoot, ".zcode-plugin-seed.json");
    const staleMarker = `${await readFile(markerPath, "utf8")}\n`;
    await writeFile(
      markerPath,
      staleMarker.replace('"pluginVersion": "', '"pluginVersion": "stale-'),
    );
    faults.moveTargetSuffix = BROWSER_CACHE_SUFFIX;

    await expect(
      (async () => await resolveOfficialPluginRoots({ storageRoot }))(),
    ).resolves.not.toBeInstanceOf(Error);
    expect(await readFile(markerPath, "utf8")).not.toContain('"pluginVersion": "stale-');

    faults.moveTargetSuffix = undefined;
    await expect(
      (async () => await resolveOfficialPluginRoots({ storageRoot }))(),
    ).resolves.not.toBeInstanceOf(Error);
    await expectNoSeedBackups(browserRoot);
  });

  it("replaces an overlay lower-layer target when moving it to backup returns EXDEV", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    await resolveOfficialPluginRoots({ storageRoot });
    const browserRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const markerPath = join(browserRoot, ".zcode-plugin-seed.json");
    const staleMarker = `${await readFile(markerPath, "utf8")}\n`;
    await writeFile(
      markerPath,
      staleMarker.replace('"pluginVersion": "', '"pluginVersion": "stale-'),
    );
    const logger = createLogger();
    faults.crossDeviceBackupTargetSuffix = BROWSER_CACHE_SUFFIX;

    await expect(
      (async () =>
        await resolveZCodePlugins({
          logger,
          pluginStorageRoot: storageRoot,
          skipUserConfig: true,
          workingDirectory: dirname(storageRoot),
        }))(),
    ).resolves.not.toBeInstanceOf(Error);

    // 镜像下层的旧缓存无法 rename 成 backup，但仍须被替换成当前内容，而不是每次启动都失败。
    expect(await readFile(markerPath, "utf8")).not.toContain('"pluginVersion": "stale-');
    expect(existsSync(join(browserRoot, ".zcode-plugin", "plugin.json"))).toBe(true);
    await expectNoSeedBackups(browserRoot);
    const siblings = await readdir(dirname(browserRoot));
    expect(siblings.filter((entry) => entry.includes(".tmp-"))).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({ pluginId: "browser-use@zcode-plugins-official" }),
    );
  });

  it("degrades a persistent EXDEV promotion to a usable previous version", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    expect(await resolveOfficialPluginRoots({ storageRoot })).toEqual([]);
    const currentRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const staleRoot = join(dirname(currentRoot), "0.2.1");
    await rename(currentRoot, staleRoot);
    const logger = createLogger();
    faults.crossDevicePromoteTargetSuffix = BROWSER_CACHE_SUFFIX;

    let roots: string[] = [];
    await expect(
      (async () => {
        roots = await resolveOfficialPluginRoots({ logger, storageRoot });
      })(),
    ).resolves.not.toBeInstanceOf(Error);

    expect(roots).toContain(staleRoot);
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        degraded: true,
        errorCode: "EXDEV",
        operation: "seed_plugin",
        pluginId: "browser-use@zcode-plugins-official",
      }),
    );
  });

  it("drops the seed marker before deleting an EXDEV target so an interrupted delete reseeds", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    await resolveOfficialPluginRoots({ storageRoot });
    const browserRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const markerPath = join(browserRoot, ".zcode-plugin-seed.json");
    const manifestPath = join(browserRoot, ".zcode-plugin", "plugin.json");
    // marker 仍是当前版本，但 manifest 已丢失：走「当前缓存不可用 → 重新 seed」分支。
    await rm(manifestPath, { force: true });
    faults.crossDeviceBackupTargetSuffix = BROWSER_CACHE_SUFFIX;
    // 删除旧 target 中途失败，模拟进程在删除窗口内退出。
    faults.removeTargetSuffix = BROWSER_CACHE_SUFFIX;

    await expect(
      (async () => await resolveOfficialPluginRoots({ logger: createLogger(), storageRoot }))(),
    ).resolves.not.toBeInstanceOf(Error);

    // marker 必须先于目录内容删除；否则残缺目录会带着当前版本被下次启动直接复用。
    expect(existsSync(markerPath)).toBe(false);

    faults.removeTargetSuffix = undefined;
    await expect(
      (async () => await resolveOfficialPluginRoots({ storageRoot }))(),
    ).resolves.not.toBeInstanceOf(Error);
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(markerPath)).toBe(true);
    await expectNoSeedBackups(browserRoot);
  });

  it("converges when another process completes the current seed during promotion", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    await resolveOfficialPluginRoots({ storageRoot });
    const browserRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const markerPath = join(browserRoot, ".zcode-plugin-seed.json");
    const staleMarker = `${await readFile(markerPath, "utf8")}\n`;
    await writeFile(
      markerPath,
      staleMarker.replace('"pluginVersion": "', '"pluginVersion": "stale-'),
    );
    faults.promoteCurrentTargetSuffix = BROWSER_CACHE_SUFFIX;

    await expect(
      (async () => await resolveOfficialPluginRoots({ storageRoot }))(),
    ).resolves.not.toBeInstanceOf(Error);

    expect(await readFile(markerPath, "utf8")).not.toContain('"pluginVersion": "stale-');
    await expectNoSeedBackups(browserRoot);
  });

  it("does not restore a fixed backup that may belong to an active replacement", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    await resolveOfficialPluginRoots({ storageRoot });
    const browserRoot = join(storageRoot, BROWSER_CACHE_SUFFIX);
    const backupRoot = `${browserRoot}.backup`;
    await rename(browserRoot, backupRoot);
    faults.recoverBackupTargetSuffix = BROWSER_CACHE_SUFFIX;

    await expect(
      (async () => await resolveOfficialPluginRoots({ storageRoot }))(),
    ).resolves.not.toBeInstanceOf(Error);

    expect(existsSync(browserRoot)).toBe(true);
    await expectNoSeedBackups(browserRoot);
  });

  it("keeps a current target usable when only runtime manifest refresh is locked", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    await resolveOfficialPluginRoots({ storageRoot });
    const logger = createLogger();
    process.argv[1] = join(storageRoot, "different-zcode.cjs");
    faults.runtimeManifestTargetSuffix = ANDROID_MANIFEST_SUFFIX;

    await expect(
      (async () => await resolveOfficialPluginRoots({ logger, storageRoot }))(),
    ).resolves.not.toBeInstanceOf(Error);

    expect(existsSync(join(storageRoot, ANDROID_CACHE_SUFFIX))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        degraded: true,
        operation: "seed_plugin",
        pluginId: "android-emulator@zcode-plugins-official",
      }),
    );
  });

  it("keeps a concurrent winner when runtime manifest temporary file disappears", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    await resolveOfficialPluginRoots({ storageRoot });
    const logger = createLogger();
    process.argv[1] = join(storageRoot, "different-zcode.cjs");
    faults.runtimeManifestNotFoundTargetSuffix = ANDROID_MANIFEST_SUFFIX;

    await expect(
      (async () => await resolveOfficialPluginRoots({ logger, storageRoot }))(),
    ).resolves.not.toBeInstanceOf(Error);

    expect(existsSync(join(storageRoot, ANDROID_CACHE_SUFFIX))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({
        degraded: true,
        errorCode: "ENOENT",
        operation: "seed_plugin",
        pluginId: "android-emulator@zcode-plugins-official",
      }),
    );
  });

  it("preserves suppressed plugin catalog/cache without attempting a Windows-locked deletion", async () => {
    const storageRoot = await createStorageRoot(cleanups);
    await resolveOfficialPluginRoots({ storageRoot });
    const logger = createLogger();
    faults.removeTargetSuffix = SKILL_CREATOR_CACHE_SUFFIX;

    await expect(
      (async () =>
        await resolveOfficialPluginRoots({
          logger,
          storageRoot,
          suppressedBuiltins: new Set(["skill-creator@zcode-plugins-official"]),
        }))(),
    ).resolves.not.toBeInstanceOf(Error);

    expect(existsSync(join(storageRoot, SKILL_CREATOR_CACHE_SUFFIX))).toBe(true);
    const marketplace = JSON.parse(
      await readFile(
        join(storageRoot, "marketplaces", "zcode-plugins-official", "marketplace.json"),
        "utf8",
      ),
    ) as { plugins: Array<{ name: string }> };
    // 现行契约：suppressedBuiltins 只控制 runtime discovery。catalog/cache 是恢复入口
    // 的不可变资产，不应触发删除；注入的 EPERM 因而不会被命中，也不产生降级告警。
    expect(marketplace.plugins.some((plugin) => plugin.name === "skill-creator")).toBe(true);
    expect(logger.warn).not.toHaveBeenCalledWith(
      "Official plugin cache operation degraded",
      expect.objectContaining({ operation: "remove_suppressed_plugin" }),
    );
  });
});

async function createStorageRoot(cleanups: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-plugin-cache-resilience-"));
  cleanups.push(root);
  return join(root, "plugins");
}

async function createVersionedSource(storageRoot: string) {
  const entrypointRoot = join(storageRoot, "versioned-source");
  const root = join(entrypointRoot, "packages", "skill-creator-plugin");
  await mkdir(join(root, ".zcode-plugin"), { recursive: true });
  await mkdir(join(root, "skills", "demo"), { recursive: true });
  await writeFile(
    join(root, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: "skill-creator", version: "0.1.0" }),
  );
  const payload = join(root, "skills", "demo", "SKILL.md");
  await writeFile(payload, "original source");
  process.argv[1] = join(entrypointRoot, "zcode.cjs");
  faults.watchedSourceRoot = root;
  return { root, payload };
}

async function expectNoSeedBackups(targetRoot: string): Promise<void> {
  const targetName = basename(targetRoot);
  const siblings = await readdir(dirname(targetRoot));
  expect(siblings.filter((entry) => entry.startsWith(`${targetName}.backup`))).toEqual([]);
}

function createLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return logger;
}

function exhaustedErrno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), {
    code,
    zcodeOfficialPluginCacheAttempts: 4,
  });
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
