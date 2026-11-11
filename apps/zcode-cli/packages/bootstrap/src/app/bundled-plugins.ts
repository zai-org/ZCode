import { createPluginStartupBudget } from "../plugin-startup-budget/index.js";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, realpath, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { writeBundledOfficialMarketplacePartition } from "@zcode/adapters";
import {
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE as OFFICIAL_PLUGIN_MARKETPLACE,
  type Logger,
  type PluginLoadOutcome,
} from "@zcode/contracts";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import {
  createOfficialPluginCacheRetryBudget,
  collectOfficialPluginSourceFiles,
  getOfficialPluginCacheRetryAttempts,
  isTransientOfficialPluginCacheFsError,
  type OfficialPluginCacheRetryBudget,
  removeOfficialPluginCacheDirectory,
  renameOfficialPluginCachePath,
  pathExists,
  readOfficialPluginBuildIdentity,
  readOfficialPluginFileFacts,
} from "./official-plugin-cache-fs.js";
import {
  OFFICIAL_PLUGIN_DEFINITIONS,
  type OfficialPluginDefinition,
} from "./official-plugin-definitions.js";
import {
  candidateBaseDirs,
  officialPluginHostPrefixArgs,
  writeOfficialPluginRuntimeManifest,
} from "./official-plugin-runtime.js";
import {
  isOfficialPluginSeedLockTimeoutError,
  withOfficialPluginSeedLock,
} from "./official-plugin-seed-lock.js";

const SEA_PLUGIN_ASSET_PREFIX = "zcode-official-plugins/";
const SEA_PLUGIN_MANIFEST_ASSET_KEY = `${SEA_PLUGIN_ASSET_PREFIX}manifest.json`;
const SEED_MARKER_FILE = ".zcode-plugin-seed.json";
const SEED_LOCK_TOTAL_BUDGET_MS = 15_000;

const includedTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // 官方内容插件新增 agents 后，filesystem seed 的顶层白名单未同步，目录被静默裁掉。
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  // Browser skill 会从官方插件根目录动态导入 scripts/browser-client.mjs。
  // filesystem seed 若漏掉 scripts，Dev 会连接 node_repl 成功却在首次 Browser Use 时导入失败。
  "scripts",
  "skills",
  "templates",
]);

interface OfficialPluginSeedFile {
  mode?: number;
  path: string;
  sha256?: string;
  sourcePath?: string;
}

interface OfficialPluginSeedPluginSource {
  definition: OfficialPluginDefinition;
  /** SEA 持有完整清单；filesystem 先登记 manifest，只有复制时才枚举。 */
  files: OfficialPluginSeedFile[];
  hash?: string;
  /** definition 声明 buildIdentityPath 时读取的构建身份；同版本下它变化也要重建。 */
  buildIdentity?: string;
  missingSeedPaths: string[];
  rootPath?: string;
}

interface OfficialPluginSeedSource {
  kind: "filesystem" | "sea";
  plugins: OfficialPluginSeedPluginSource[];
}

interface SeaOfficialPluginManifest {
  hash: string;
  plugins: Array<{
    files: OfficialPluginSeedFile[];
    marketplace: string;
    name: string;
    version: string;
  }>;
  version: 1;
}

type SeaModule = typeof import("node:sea");

const SOURCE_REBUILD_LIMIT = 3;
// admission 只提供资源互斥；成功描述由注入的进程 owner 持有，不放进会话或全局缓存。
const pendingSeeds = new Map<string, Promise<unknown>>();
interface PreparationInput {
  logger?: Logger;
  storageRoot: string;
}
export interface OfficialPluginPreparation {
  readonly signal: AbortSignal;
  readonly startupDegraded: boolean;
  resolvePlugins(resolve: () => Promise<PluginLoadOutcome>): Promise<PluginLoadOutcome>;
  prepare(input: PreparationInput): Promise<OfficialPluginDefinition[]>;
  invalidate(): void;
  dispose(): Promise<void>;
}

export function createOfficialPluginPreparation(options?: {
  startupTimeoutMs: number;
  onDegraded?: () => void;
}): OfficialPluginPreparation {
  const completed = new Map<string, { signature: string; facts: string }>();
  const pending = new Set<Promise<OfficialPluginDefinition[]>>();
  const controller = new AbortController();
  let revision = 0;
  const startup = options
    ? createPluginStartupBudget({
        timeoutMs: options.startupTimeoutMs,
        onTimeout(reason) {
          revision += 1;
          completed.clear();
          controller.abort(reason);
          options.onDegraded?.();
        },
      })
    : undefined;
  return {
    signal: controller.signal,
    get startupDegraded() {
      return startup?.degraded ?? false;
    },
    async resolvePlugins(resolve) {
      return startup ? await startup.resolvePlugins(resolve) : await resolve();
    },
    prepare(input) {
      if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
      const run = withSeedAdmission(input.storageRoot, async (key) => {
        let lockDeadlineAt: number | undefined;
        let lastSourceError: unknown;
        for (let attempt = 0; attempt < SOURCE_REBUILD_LIMIT; attempt += 1) {
          controller.signal.throwIfAborted();
          try {
            const startedRevision = revision;
            const source = await resolveSeedSource(controller.signal);
            controller.signal.throwIfAborted();
            if (!source) {
              completed.delete(key);
              return [];
            }
            const signature = preparationSignature(input.storageRoot, source);
            const paths = preparationPaths(input.storageRoot, source);
            const previous = completed.get(key);
            const facts = previous ? await readOfficialPluginFileFacts(paths) : undefined;
            const reusable =
              previous?.signature === signature && facts !== undefined && previous.facts === facts;
            completed.delete(key);
            lockDeadlineAt ??= Date.now() + SEED_LOCK_TOTAL_BUDGET_MS;
            const failedSeeds = reusable
              ? []
              : await prepareBundledOfficialPlugins(
                  input,
                  source,
                  controller.signal,
                  lockDeadlineAt,
                );
            controller.signal.throwIfAborted();
            // 命中时保留首次校验基准，避免把期间的外部改写误记为已准备成功。
            const preparedFacts = reusable ? facts : await readOfficialPluginFileFacts(paths);
            const current = await resolveSeedSource(controller.signal);
            controller.signal.throwIfAborted();
            // 必须在 admission 内复核；失效和持续外部改写不能让旧结果离开边界。
            if (
              startedRevision !== revision ||
              !current ||
              signature !== preparationSignature(input.storageRoot, current) ||
              preparedFacts !== (await readOfficialPluginFileFacts(paths))
            )
              continue;
            if (failedSeeds.length === 0 && preparedFacts !== undefined)
              completed.set(key, { signature, facts: preparedFacts });
            return failedSeeds;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ZCODE_PLUGIN_SOURCES_CHANGED")
              throw error;
            lastSourceError = error;
            continue;
          }
        }
        throw Object.assign(new Error("Plugin seed sources changed", { cause: lastSourceError }), {
          code: "ZCODE_PLUGIN_SOURCES_CHANGED",
        });
      });
      pending.add(run);
      void run.then(
        () => pending.delete(run),
        () => pending.delete(run),
      );
      return run;
    },
    invalidate() {
      revision += 1;
      completed.clear();
    },
    async dispose() {
      controller.abort();
      startup?.dispose(controller.signal.reason);
      completed.clear();
      await Promise.allSettled(pending);
    },
  };
}

async function withSeedAdmission<T>(
  storageRoot: string,
  operation: (key: string) => Promise<T>,
): Promise<T> {
  await mkdir(storageRoot, { recursive: true });
  const key = await realpath(storageRoot);
  const previous = pendingSeeds.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => operation(key));
  pendingSeeds.set(key, run);
  try {
    return await run;
  } finally {
    if (pendingSeeds.get(key) === run) pendingSeeds.delete(key);
  }
}

function preparationSignature(storageRoot: string, source: OfficialPluginSeedSource): string {
  return JSON.stringify([
    resolve(storageRoot),
    process.execPath,
    officialPluginHostPrefixArgs(),
    source.kind,
    source.plugins.map((plugin) => [
      plugin.definition.name,
      plugin.definition.version,
      plugin.rootPath,
      plugin.hash,
      plugin.buildIdentity,
      plugin.missingSeedPaths,
    ]),
  ]);
}

function preparationPaths(storageRoot: string, source: OfficialPluginSeedSource): string[] {
  return ["bundled-marketplace.json", "marketplace.json"]
    .map((name) => join(storageRoot, "marketplaces", OFFICIAL_PLUGIN_MARKETPLACE, name))
    .concat(
      source.plugins.flatMap((plugin) =>
        [
          SEED_MARKER_FILE,
          ".zcode-plugin/plugin.json",
          ...(plugin.definition.requiredSeedPaths ?? []),
        ].map((path) =>
          join(officialPluginCacheRoot(storageRoot, plugin.definition), ...path.split("/")),
        ),
      ),
    );
}

async function prepareBundledOfficialPlugins(
  input: PreparationInput,
  source: OfficialPluginSeedSource,
  signal?: AbortSignal,
  seedLockDeadlineAt = Date.now() + SEED_LOCK_TOTAL_BUDGET_MS,
): Promise<OfficialPluginDefinition[]> {
  signal?.throwIfAborted();
  // Catalog/cache 是内置插件的不可变产品资产；Runtime 是否加载由 discovery 的抑制态决定，
  // 不能在 seed 阶段删除或过滤，否则卸载后详情页无法读取组件，也无法恢复。
  await writeOfficialMarketplace(input.storageRoot, source);
  const retryBudget = createOfficialPluginCacheRetryBudget({ signal });
  // 等锁超时降级后循环会继续；若每个插件独立重置 15s 等待预算，成组遗留的
  // 锁会让启动同步冻结 N×15s。全部插件共享同一截止时间：无争用的锁仍瞬时获取（mkdir
  // 一次成功不查预算），预算耗尽后有争用的锁立即降级，seeding 总等待封顶 15s。
  const failedSeeds: OfficialPluginDefinition[] = [];
  for (const plugin of source.plugins) {
    signal?.throwIfAborted();
    const pluginId = `${plugin.definition.name}@${OFFICIAL_PLUGIN_MARKETPLACE}`;
    const targetRoot = officialPluginCacheRoot(input.storageRoot, plugin.definition);
    // 入口旁的插件拷贝可能与新定义错配（升级中的桌面包、旧 checkout 未构建 dist）。
    // 缺 requiredSeedPaths 时 seed 源解析曾直接抛错，一个残缺插件把全部插件连同会话恢复
    // 一起炸成 resumeFailed。残缺只作用于单插件：拒绝写缓存，按既有降级协议告警并回退到可用旧缓存。
    if (plugin.missingSeedPaths.length > 0) {
      warnCacheDegraded(input.logger, {
        error: Object.assign(
          new Error(
            `Bundled official plugin ${plugin.definition.name} is missing required seed assets: ${plugin.missingSeedPaths.join(", ")}`,
          ),
          { code: "ZCODE_PLUGIN_SEED_INCOMPLETE" },
        ),
        missingSeedPaths: plugin.missingSeedPaths,
        operation: "seed_plugin",
        pluginId,
        targetRoot,
      });
      failedSeeds.push(plugin.definition);
      continue;
    }
    try {
      await withOfficialPluginSeedLock(
        targetRoot,
        async () => {
          signal?.throwIfAborted();
          const manifestFile = plugin.files.find(
            (file) => file.path === ".zcode-plugin/plugin.json",
          );
          if (!manifestFile)
            throw new Error(`Bundled plugin manifest is missing: ${plugin.definition.name}`);
          const sourceManifestContents = (
            await readSeedFileBytes(source, plugin, manifestFile)
          ).toString("utf8");
          // 桌面会并发预热多个 workspace Agent；复制插件资源时，
          // 多进程会互删 target 并在 Windows rename 时触发 EPERM。拿锁后必须二次检查，
          // 让等待者直接复用首个进程已经提交的完整缓存。
          if (await isSeedCurrent(targetRoot, plugin)) {
            await cleanupLegacySeedBackup(targetRoot, retryBudget);
            const manifestWritten = await tryWriteOfficialPluginRuntimeManifest({
              sourceManifestContents,
              pluginName: plugin.definition.name,
              retryBudget,
              rootPath: targetRoot,
            });
            if (manifestWritten) return;
          }

          const temporaryRoot = `${targetRoot}.tmp-${process.pid}-${Date.now()}`;
          await removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
          await mkdir(temporaryRoot, { recursive: true });

          try {
            const files: OfficialPluginSeedFile[] =
              source.kind === "filesystem" && plugin.rootPath
                ? await collectOfficialPluginSourceFiles(
                    plugin.rootPath,
                    new Set([
                      ...includedTopLevelPaths,
                      ...(plugin.definition.runtimeTopLevelPaths ?? []),
                    ]),
                    signal,
                  )
                : plugin.files;
            for (const file of files) {
              signal?.throwIfAborted();
              const bytes = await readSeedFileBytes(source, plugin, file, signal);
              signal?.throwIfAborted();
              if (source.kind === "sea" && hashBytes(bytes) !== file.sha256) {
                throw Object.assign(
                  new Error(
                    `Bundled plugin asset hash mismatch: ${plugin.definition.name}/${file.path}`,
                  ),
                  { code: "ZCODE_PLUGIN_SOURCES_CHANGED" },
                );
              }
              const outputPath = join(temporaryRoot, ...file.path.split("/"));
              await mkdir(dirname(outputPath), { recursive: true });
              signal?.throwIfAborted();
              await writeFile(outputPath, bytes, { signal });
              signal?.throwIfAborted();
              await chmod(outputPath, modeForSeedFile(file.path, file.mode));
            }

            signal?.throwIfAborted();
            // 延后枚举后，源入口可能在检查与复制之间消失；不能给残缺目录写成功 marker。
            if (!(await isSeedUsable(temporaryRoot, plugin.definition))) {
              throw Object.assign(new Error("Plugin seed source became incomplete"), {
                code: "ZCODE_PLUGIN_SOURCES_CHANGED",
              });
            }
            await writeFile(
              join(temporaryRoot, SEED_MARKER_FILE),
              JSON.stringify(seedMarker(source, plugin), null, 2),
            );
            signal?.throwIfAborted();
            await replaceSeedRoot(temporaryRoot, targetRoot, plugin, retryBudget);
            signal?.throwIfAborted();
            await writeOfficialPluginRuntimeManifest({
              sourceManifestContents,
              pluginName: plugin.definition.name,
              retryBudget,
              rootPath: targetRoot,
            });
          } catch (error) {
            try {
              // 预算超时也必须清理候选目录；业务 signal 已中止时仍要执行 rm 和有界重试。
              const cleanupBudget = { ...retryBudget, signal: undefined, sleep: delay };
              await removeOfficialPluginCacheDirectory(temporaryRoot, cleanupBudget);
            } catch {
              // 临时目录清理失败不能覆盖真正的 seed 错误；目录名唯一，不会污染后续加载。
            }
            throw error;
          }
        },
        { signal, timeoutMs: Math.max(0, seedLockDeadlineAt - Date.now()) },
      );
    } catch (error) {
      if (
        isTransientOfficialPluginCacheFsError(error) ||
        // seed lock 等待超时只说明同版本缓存锁被别的进程持有或遗留（Windows 上
        // 删不掉的遗留锁 + PID 复用会让接管长期不触发）。seeding 只是刷新缓存，超时必须
        // 走既有降级协议回退到可用缓存并告警，不能把会话恢复整体炸成 resumeFailed。
        isOfficialPluginSeedLockTimeoutError(error) ||
        // overlay 下层目录的 EXDEV 不会因重试消失（不进重试集合）。删除后替换仍失败时，
        // 这次只是没能刷新缓存，必须降级回退到可用缓存，不能让会话恢复整体 resumeFailed。
        isCrossDeviceFsError(error) ||
        // 多个 workspace app 会并发 seed 同一份官方插件缓存。当前进程
        // 写 runtime manifest 时，并发赢家可能已经原子替换整个 targetRoot，连同本进程
        // 的临时文件一起移走，rename 因此返回 ENOENT。只在新 target 已由 marker 证明
        // 完整时降级；目标缺失或仍旧时继续抛错，不能掩盖真实缓存损坏。
        (isNotFoundFsError(error) && (await isSeedCurrent(targetRoot, plugin)))
      ) {
        warnCacheDegraded(input.logger, {
          error,
          operation: "seed_plugin",
          pluginId,
          targetRoot,
        });
        failedSeeds.push(plugin.definition);
        continue;
      }
      throw error;
    }
  }
  return failedSeeds;
}

async function tryWriteOfficialPluginRuntimeManifest(input: {
  sourceManifestContents: string;
  pluginName: string;
  retryBudget: OfficialPluginCacheRetryBudget;
  rootPath: string;
}): Promise<boolean> {
  try {
    await writeOfficialPluginRuntimeManifest(input);
    return true;
  } catch (error) {
    if (isTransientOfficialPluginCacheFsError(error)) throw error;
    return false;
  }
}

export async function resolveOfficialPluginRoots(input: {
  /** 旧调用方兼容参数；seed 与配置无关，抑制规则由 discovery 每次投影。 */
  env?: NodeJS.ProcessEnv;
  extraRoots?: string[];
  logger?: Logger;
  storageRoot: string;
  suppressedBuiltins?: ReadonlySet<string>;
  preparation?: OfficialPluginPreparation;
}): Promise<string[]> {
  const failedSeeds = await (input.preparation ?? createOfficialPluginPreparation()).prepare({
    logger: input.logger,
    storageRoot: input.storageRoot,
  });
  input.preparation?.signal.throwIfAborted();

  const fallbackRoots: string[] = [];
  for (const definition of failedSeeds) {
    // Android 0.1.0 可从工作区执行假工具；安全更新失败时不能重新激活旧缓存。
    if (definition.name === "android-emulator") continue;
    // CUA 的 frame contract 随 wrapper 与 producer 原子升级。加载旧版本
    // cache 会把旧 block 布局接到新 consumer 上；当前 cache 不可用时宁可不注册 CUA。
    if (`${definition.name}@${OFFICIAL_PLUGIN_MARKETPLACE}` === ZCODE_CUA_OFFICIAL_PLUGIN_ID) {
      continue;
    }
    const fallbackRoot = await findUsableOfficialPluginFallback(input.storageRoot, definition);
    if (fallbackRoot) fallbackRoots.push(fallbackRoot);
  }
  return [...new Set([...(input.extraRoots ?? []), ...fallbackRoots])];
}

async function resolveSeedSource(
  signal: AbortSignal,
): Promise<OfficialPluginSeedSource | undefined> {
  const seaSource = resolveSeaSeedSource();
  if (seaSource) return seaSource;
  try {
    return await resolveFilesystemSeedSource(signal);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw Object.assign(new Error("Plugin seed source disappeared", { cause: error }), {
        code: "ZCODE_PLUGIN_SOURCES_CHANGED",
      });
    throw error;
  }
}

function resolveSeaSeedSource(): OfficialPluginSeedSource | undefined {
  const sea = getSeaModule();
  if (!sea?.isSea()) return undefined;

  const manifest = readSeaManifest(sea);
  if (!manifest) return undefined;
  const plugins = OFFICIAL_PLUGIN_DEFINITIONS.flatMap((definition) => {
    const plugin = manifest.plugins.find(
      (item) =>
        item.marketplace === OFFICIAL_PLUGIN_MARKETPLACE &&
        item.name === definition.name &&
        item.version === definition.version,
    );
    if (!plugin) return [];
    return [
      {
        definition,
        files: plugin.files,
        hash: hashSeedFiles(plugin.files),
        missingSeedPaths: findMissingOfficialPluginSeedPaths(definition, plugin.files),
      },
    ];
  });
  if (plugins.length === 0) return undefined;

  return {
    kind: "sea",
    plugins,
  };
}

async function resolveFilesystemSeedSource(
  signal: AbortSignal,
): Promise<OfficialPluginSeedSource | undefined> {
  const plugins: OfficialPluginSeedPluginSource[] = [];
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    signal.throwIfAborted();
    const rootPath = await resolveFilesystemPluginRoot(definition, signal);
    if (!rootPath) continue;
    // Desktop 每次重开都全量读源文件算 SHA 会放大慢 IO；资源更新改由发布版本负责。
    const missingSeedPaths: string[] = [];
    for (const path of definition.requiredSeedPaths ?? []) {
      signal.throwIfAborted();
      if (!(await pathExists(join(rootPath, ...path.split("/"))))) missingSeedPaths.push(path);
    }
    plugins.push({
      definition,
      files: [
        {
          path: ".zcode-plugin/plugin.json",
          sourcePath: join(rootPath, ".zcode-plugin", "plugin.json"),
        },
      ],
      buildIdentity: await readOfficialPluginBuildIdentity(rootPath, definition, signal),
      missingSeedPaths,
      rootPath,
    });
  }
  if (plugins.length === 0) return undefined;
  return {
    kind: "filesystem",
    plugins,
  };
}

export function findMissingOfficialPluginSeedPaths(
  definition: Pick<OfficialPluginDefinition, "requiredSeedPaths">,
  files: ReadonlyArray<{ path: string }>,
): string[] {
  const availablePaths = new Set(files.map((file) => file.path));
  return (definition.requiredSeedPaths ?? []).filter(
    (requiredPath) => !availablePaths.has(requiredPath),
  );
}

function getSeaModule(): SeaModule | undefined {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea");
  } catch {
    return undefined;
  }
}

function readSeaManifest(sea: SeaModule): SeaOfficialPluginManifest | undefined {
  try {
    const raw = sea.getAsset(SEA_PLUGIN_MANIFEST_ASSET_KEY, "utf8");
    const manifest = JSON.parse(raw) as SeaOfficialPluginManifest;
    return manifest.version === 1 && Array.isArray(manifest.plugins) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

async function resolveFilesystemPluginRoot(
  definition: OfficialPluginDefinition,
  signal: AbortSignal,
): Promise<string | undefined> {
  for (const baseDir of candidateBaseDirs()) {
    for (const relativePath of definition.rootCandidates) {
      signal.throwIfAborted();
      const rootPath = resolve(baseDir, relativePath);
      if (await pathExists(join(rootPath, ".zcode-plugin", "plugin.json"))) return rootPath;
    }
  }
  return undefined;
}

async function readSeedFileBytes(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
  file: OfficialPluginSeedFile,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (source.kind === "filesystem" && file.sourcePath)
    return await readFile(file.sourcePath, { signal });
  const sea = getSeaModule();
  if (!sea?.isSea()) throw new Error("SEA plugin asset is unavailable outside SEA runtime.");
  return Buffer.from(
    sea.getRawAsset(
      `${SEA_PLUGIN_ASSET_PREFIX}${OFFICIAL_PLUGIN_MARKETPLACE}/${plugin.definition.name}/${plugin.definition.version}/${file.path}`,
    ),
  );
}

async function writeOfficialMarketplace(
  storageRoot: string,
  source: OfficialPluginSeedSource,
): Promise<void> {
  await writeBundledOfficialMarketplacePartition({
    manifest: {
      name: OFFICIAL_PLUGIN_MARKETPLACE,
      plugins: await Promise.all(
        source.plugins.map(async (plugin) => {
          // 商店信息（listing）与描述随目录条目下发：键名与 CDN 目录 schema 一致，
          // 由 adapter 的同一套 parseEntryStoreListing 解析，UI 才能给内置插件渲染
          // 显示名/分类/作者/示例提示词。描述取自插件包内 plugin.json（单一事实源）。
          const description = await readSeedPluginDescription(source, plugin);
          return {
            cachePath: officialPluginCacheRoot(storageRoot, plugin.definition),
            // 未安装/已卸载时商店读目录条目的 componentTypes 判断「UI 插件」；缺失会掉进分类分组。
            ...(plugin.definition.componentTypes
              ? { componentTypes: [...plugin.definition.componentTypes] }
              : {}),
            ...(description ? { description } : {}),
            name: plugin.definition.name,
            source: source.kind,
            version: plugin.definition.version,
            ...(plugin.definition.listing ?? {}),
          };
        }),
      ),
      version: 1,
    },
    storageRoot,
  });
}

/** 从 seed 文件集中读插件 plugin.json 的 description；读取/解析失败按 undefined 降级。 */
async function readSeedPluginDescription(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
): Promise<string | undefined> {
  const manifestFile = plugin.files.find((file) => file.path === ".zcode-plugin/plugin.json");
  if (!manifestFile) return undefined;
  try {
    const parsed = JSON.parse(
      (await readSeedFileBytes(source, plugin, manifestFile)).toString("utf8"),
    ) as {
      description?: unknown;
    };
    return typeof parsed.description === "string" && parsed.description.trim().length > 0
      ? parsed.description
      : undefined;
  } catch {
    return undefined;
  }
}

async function isSeedCurrent(
  targetRoot: string,
  plugin: OfficialPluginSeedPluginSource,
): Promise<boolean> {
  const markerPath = join(targetRoot, SEED_MARKER_FILE);
  if (!(await pathExists(markerPath))) return false;
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as ReturnType<typeof seedMarker>;
    return (
      // filesystem 以发布版本为准，兼容旧 marker 的 hash；SEA 继续验证内嵌资源摘要。
      (plugin.hash === undefined || marker.hash === plugin.hash) &&
      marker.pluginVersion === plugin.definition.version &&
      // 修复原因：node-repl-host 的 server.js 内嵌每条 CI 流水线不同的 CUA Helper build id，
      // 版本号却不变；只比版本会让桌面升级后继续用旧 build id，新 Helper 被拒绝安装。
      marker.buildIdentity === plugin.buildIdentity &&
      (await isSeedUsable(targetRoot, plugin.definition))
    );
  } catch {
    return false;
  }
}

/**
 * 旧版本缓存只要插件清单和运行所需文件完整，就可以继续服务当前会话。
 * marker hash 不匹配只表示需要升级，不能把一个可用的旧缓存当成启动失败。
 */
async function isSeedUsable(
  targetRoot: string,
  definition: OfficialPluginDefinition,
): Promise<boolean> {
  try {
    const manifest = JSON.parse(
      await readFile(join(targetRoot, ".zcode-plugin", "plugin.json"), "utf8"),
    ) as { name?: unknown };
    if (manifest.name !== definition.name) return false;
  } catch {
    return false;
  }

  for (const requiredPath of definition.requiredSeedPaths ?? []) {
    if (!(await pathExists(join(targetRoot, ...requiredPath.split("/"))))) return false;
  }
  return true;
}

async function findUsableOfficialPluginFallback(
  storageRoot: string,
  definition: OfficialPluginDefinition,
): Promise<string | undefined> {
  const targetRoot = officialPluginCacheRoot(storageRoot, definition);
  if (await isSeedUsable(targetRoot, definition)) return undefined;

  let entries;
  try {
    entries = await readdir(dirname(targetRoot), { withFileTypes: true });
  } catch (error) {
    if (isNotFoundFsError(error)) return undefined;
    throw error;
  }

  const candidates = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== definition.version &&
        !entry.name.includes(".backup") &&
        // 锁目录（含 .seed-lock.stale-*）与版本目录同级；超时降级后锁必然在场，
        // 不能依赖 isSeedUsable 的内容检查兜底，按名字直接排除。
        !entry.name.includes(".seed-lock") &&
        !entry.name.includes(".tmp-"),
    )
    .sort((left, right) =>
      right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: "base" }),
    )
    .map((entry) => join(dirname(targetRoot), entry.name));
  for (const rootPath of candidates) {
    if (await isSeedUsable(rootPath, definition)) return rootPath;
  }
  return undefined;
}

async function replaceSeedRoot(
  temporaryRoot: string,
  targetRoot: string,
  plugin: OfficialPluginSeedPluginSource,
  retryBudget: OfficialPluginCacheRetryBudget,
): Promise<void> {
  retryBudget.signal?.throwIfAborted();
  // 已移走旧目录后必须完成替换或回滚；超时调用方已降级，不能中止半个事务。
  retryBudget = { ...retryBudget, signal: undefined, sleep: delay };
  const backupRoot = createSeedBackupRoot(targetRoot);
  let movedTargetToBackup = false;
  await mkdir(dirname(targetRoot), { recursive: true });
  if (await pathExists(targetRoot)) {
    try {
      await renameOfficialPluginCachePath(targetRoot, backupRoot, retryBudget);
      movedTargetToBackup = true;
    } catch (error) {
      if (isCrossDeviceFsError(error)) {
        // Bug 原因：容器镜像若已带有插件缓存，旧 target 位于 overlayfs 下层；未启用
        // redirect_dir 时内核拒绝 rename 下层目录，同一父目录内也返回 EXDEV。旧逻辑把它
        // 当作致命错误上抛，每次启动/会话恢复都失败。下层目录只能删除不能改名，因此在
        // seed lock 内改为「先删 target 再 promote temp」；这条路径没有 backup 可回滚，
        // promote 失败时由降级协议回退到可用旧版本。先删 marker：删除中途退出时，
        // 残缺目录不会带着成功 marker 被下次启动当成完整缓存。
        await removeOfficialPluginCacheDirectory(join(targetRoot, SEED_MARKER_FILE), retryBudget);
        await removeOfficialPluginCacheDirectory(targetRoot, retryBudget);
      } else if (!isNotFoundFsError(error)) {
        // 官方插件缓存由桌面窗口、协议与 CLI 入口共享。existsSync 之后，
        // 另一个进程可能先移走 target；此处只收敛这个 TOCTOU 的 ENOENT，随后继续
        // promote 或由 isSeedCurrent 识别并发赢家，其他缺失错误仍保持原有 fatal 语义。
        throw error;
      }
    }
  }

  try {
    await renameOfficialPluginCachePath(temporaryRoot, targetRoot, retryBudget);
  } catch (error) {
    if (await isSeedCurrent(targetRoot, plugin)) {
      await removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
      if (movedTargetToBackup) {
        await removeOfficialPluginCacheDirectory(backupRoot, retryBudget);
      }
      await cleanupLegacySeedBackup(targetRoot, retryBudget);
      return;
    }
    if (movedTargetToBackup && !(await pathExists(targetRoot)) && (await pathExists(backupRoot))) {
      await renameOfficialPluginCachePath(backupRoot, targetRoot, retryBudget);
    }
    throw error;
  }

  if (movedTargetToBackup) {
    await removeOfficialPluginCacheDirectory(backupRoot, retryBudget);
  }
  await cleanupLegacySeedBackup(targetRoot, retryBudget);
}

async function cleanupLegacySeedBackup(
  targetRoot: string,
  retryBudget: OfficialPluginCacheRetryBudget,
): Promise<void> {
  const backupRoot = `${targetRoot}.backup`;
  if (!(await pathExists(backupRoot))) return;

  // 旧版固定 backup 没有事务归属，target 暂时缺失时可能属于另一个仍在
  // promote 的进程，不能把它恢复回去。仅在当前 seed 已确认可用后清理这个遗留目录。
  await removeOfficialPluginCacheDirectory(backupRoot, retryBudget);
}

function createSeedBackupRoot(targetRoot: string): string {
  // 固定 backup 会被并发启动进程共同当作 rollback 点；每次替换使用唯一目录，
  // catch 分支只恢复自己移动出的 target，避免一个进程窃取另一个进程的事务状态。
  return `${targetRoot}.backup-${process.pid}-${Date.now()}`;
}

function isNotFoundFsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    String((error as NodeJS.ErrnoException).code) === "ENOENT"
  );
}

function isCrossDeviceFsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    String((error as NodeJS.ErrnoException).code) === "EXDEV"
  );
}

function warnCacheDegraded(
  logger: Logger | undefined,
  input: {
    error: NodeJS.ErrnoException;
    missingSeedPaths?: readonly string[];
    operation: "remove_suppressed_plugin" | "seed_plugin";
    pluginId: string;
    targetRoot: string;
  },
): void {
  logger?.warn("Official plugin cache operation degraded", {
    attempts: getOfficialPluginCacheRetryAttempts(input.error),
    degraded: true,
    errorCode: input.error.code,
    ...(input.missingSeedPaths ? { missingSeedPaths: input.missingSeedPaths } : {}),
    module: "bootstrap.official_plugin_cache",
    operation: input.operation,
    pluginId: input.pluginId,
    targetRoot: input.targetRoot,
  });
}

function seedMarker(source: OfficialPluginSeedSource, plugin: OfficialPluginSeedPluginSource) {
  return {
    hash: plugin.hash,
    ...(plugin.buildIdentity === undefined ? {} : { buildIdentity: plugin.buildIdentity }),
    marketplace: OFFICIAL_PLUGIN_MARKETPLACE,
    plugin: plugin.definition.name,
    pluginVersion: plugin.definition.version,
    source: source.kind,
    version: 1,
  };
}

function officialPluginCacheRoot(
  storageRoot: string,
  definition: OfficialPluginDefinition,
): string {
  return join(
    storageRoot,
    "cache",
    OFFICIAL_PLUGIN_MARKETPLACE,
    definition.name,
    definition.version,
  );
}

function modeForSeedFile(filePath: string, sourceMode?: number): number {
  if (sourceMode !== undefined && (sourceMode & 0o111) !== 0) return 0o755;

  const normalizedPath = filePath.split(sep).join("/");
  // official plugin seed 会重写缓存文件权限。部分插件通过 polyglot shell wrapper
  // 直接执行 hook 脚本，若落盘成 0644 会 permission denied。这里保留源码执行位，
  // 并对 SEA/旧 manifest 缺少 mode 的 hook 脚本兜底。
  if (/(?:^|\/)dist\/mcp\/server\.js$/i.test(normalizedPath)) return 0o755;
  if (/^hooks\//u.test(normalizedPath) && !/\.(json|md|txt)$/iu.test(normalizedPath)) {
    return 0o755;
  }

  return 0o644;
}

function hashSeedFiles(files: OfficialPluginSeedFile[]): string {
  return hashBytes(
    JSON.stringify(
      files.map((file) => [file.path, file.sha256, modeForSeedFile(file.path, file.mode)]),
    ),
  );
}

function hashBytes(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export { candidateBaseDirs, bundleBaseDirs } from "./official-plugin-runtime.js";
