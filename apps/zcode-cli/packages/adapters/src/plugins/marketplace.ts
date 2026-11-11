import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginDiagnostic, PluginManifest, PluginStoreListing } from "@zcode/contracts";
import { isOfficialMarketplaceId, ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import { DEFAULT_PLUGIN_MARKETPLACES, sanitizeZCodeRuntimeEnv } from "@zcode/shared";
import { loadPluginMcpServerDefinitions, resolvePluginMcpServers } from "./mcp.js";
import {
  appendPluginSourceCleanupError,
  cleanupPluginSourceBestEffort,
  directoryExists,
  fileExists,
  isRecord,
  resolveInside,
  sanitizePluginId,
} from "./helpers.js";
import { enumeratePluginComponents, type PluginComponentGroup } from "./plugin-components.js";
import { applyNetworkEgressEnv } from "../network/subprocess-env.js";
import { createNodeWebFetchHttpClientAdapter } from "../http/index.js";
import { writeCdnOfficialMarketplacePartition } from "./official-marketplace.js";
import {
  isZipPluginUrlSource,
  readZipPluginSourceSha256,
  resolveZipPluginSource,
} from "./zip-source.js";
import {
  activateDirectoryAtomically,
  recoverAtomicTargetSync,
  readStandaloneAtomicFile,
  resolveAtomicReadPath,
  writeFileAtomically,
  type AtomicDirectoryActivation,
} from "./atomic-directory.js";
import {
  resolveGitHubArchiveSource,
  shouldFallbackGitHubArchiveToGit,
} from "./github-archive-source.js";
import {
  createArchiveFetchError,
  createGitUnavailableError,
  getPluginSourceDiagnosticCode,
  isCommandUnavailableError,
  PluginSourceMaterializationError,
} from "./source-errors.js";

const execFileAsync = promisify(execFile);
const KNOWN_MARKETPLACES_FILE = "known_marketplaces.json";
const INSTALLED_PLUGINS_FILE = "installed_plugins.json";
const MARKETPLACE_FILE = "marketplace.json";
const CLAUDE_OFFICIAL_MARKETPLACE = "claude-plugins-official";
const PLUGIN_ICON_SOURCES_FILE = "icon-sources.json";
const PLUGIN_ICON_ASSETS_BASE_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/assets/";
const PLUGIN_ICON_SOURCES_URL = `${PLUGIN_ICON_ASSETS_BASE_URL}${PLUGIN_ICON_SOURCES_FILE}`;
const MARKETPLACE_JSON_MAX_BYTES = 10 * 1024 * 1024;
const MARKETPLACE_JSON_MAX_REDIRECTS = 5;
const MARKETPLACE_JSON_TIMEOUT_MS = 180_000;
const claudeIconMigrationAttempts = new Set<string>();
const CLAUDE_MARKETPLACE_FILE = join(".claude-plugin", "marketplace.json");
const ZCODE_MANIFEST_PATH = join(".zcode-plugin", "plugin.json");
const CLAUDE_MANIFEST_PATH = join(".claude-plugin", "plugin.json");
const CODEX_MANIFEST_PATH = join(".codex-plugin", "plugin.json");
const DEFAULT_VERSION = "0.0.0";
const GIT_CLONE_MAX_ATTEMPTS = 3;
const GIT_COMMAND_TIMEOUT_MS = 90_000;
const GIT_CLONE_RETRY_DELAY_MS = 1_000;
const CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS = 30_000;
const MARKETPLACE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SOURCE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UNSUPPORTED_MANIFEST_FIELDS = ["channels", "lspServers", "outputStyles", "settings"] as const;

export type MarketplaceSource =
  | { source: "url"; headers?: Record<string, string>; url: string }
  | { path?: string; ref?: string; repo: string; source: "github"; sparsePaths?: string[] }
  | { path?: string; ref?: string; source: "git"; sparsePaths?: string[]; url: string }
  | { package: string; source: "npm" }
  | { source: "file"; path: string }
  | { source: "directory"; path: string }
  | { hostPattern: string; source: "hostPattern" }
  | { pathPattern: string; source: "pathPattern" }
  | { source: "settings"; marketplace: PluginMarketplaceManifest };

export interface PluginMarketplaceEntry {
  name: string;
  category?: string;
  description?: string;
  version?: string;
  source?: unknown;
  // 内置 official 插件 seed 时写入的缓存目录绝对路径（source 为 "filesystem"/"sea"）。
  // describe/解析时据此直接定位已落盘的插件根目录，无需把 source 当路径解析。
  cachePath?: string;
  dependencies?: string[];
  strict?: boolean;
  tags?: string[];
  // 商店信息（displayName/icon/hero/示例提示词/链接等展示元数据），从条目 raw 解析；
  // 全部可选，见 contracts PluginStoreListing。
  listing?: PluginStoreListing;
  raw: Record<string, unknown>;
}

export interface PluginMarketplaceManifest {
  name: string;
  description?: string;
  plugins: PluginMarketplaceEntry[];
  allowCrossMarketplaceDependenciesOn?: string[];
  pluginRoot?: string;
  // 商店「公开」分段 Featured 区的策展名单（插件 name，按序）；由目录 JSON 顶层 featured 字段远程控制。
  featured?: string[];
  raw: Record<string, unknown>;
}

export interface KnownMarketplaceRecord {
  id: string;
  source: MarketplaceSource;
  name: string;
  description?: string;
  addedAt: string;
  lastUpdated?: string;
  lastRefreshFailure?: MarketplaceRefreshFailure;
  pluginCount: number;
  /** 内部崩溃恢复代际；协议/UI 投影不暴露。 */
  cacheTransactionId?: string;
}

export interface MarketplaceRefreshFailure {
  code: PluginDiagnostic["code"];
  failedAt: string;
  message: string;
}

export interface InstalledPluginRecord {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  installPath: string;
  installedAt: string;
  updatedAt?: string;
  scope: "user" | "workspace";
  dependencies?: string[];
  source?: unknown;
  /** 内部崩溃恢复代际；协议/UI 投影不暴露。 */
  cacheTransactionId?: string;
}

interface PluginIconSourceRecord {
  name: string;
  icon: string;
  mimeType?: string;
  sha256?: string;
}

export interface InstalledPluginsState {
  version: 1;
  plugins: InstalledPluginRecord[];
}

export interface MarketplaceInstallResult {
  closure: string[];
  installed: InstalledPluginRecord[];
}

export interface PluginValidationDiagnostic {
  code: PluginDiagnostic["code"];
  message: string;
  path?: string;
  pluginId?: string;
  severity: PluginDiagnostic["severity"];
}

// 组件枚举的类型定义在 plugin-components.ts；这里再导出，保持 adapter barrel 的对外契约稳定。
export type {
  PluginComponentGroup,
  PluginComponentItem,
  PluginComponentKind,
} from "./plugin-components.js";

export interface DescribeMarketplacePluginResult {
  components: PluginComponentGroup[];
  diagnostics: PluginValidationDiagnostic[];
  // 插件包内 plugin.json 的展示性回退字段（作者/主页/版本）；商店信息缺失时详情页信息区用它兜底。
  metadata?: PluginManifestDisplayMetadata;
}

export interface PluginManifestDisplayMetadata {
  author?: string;
  authorUrl?: string;
  homepage?: string;
  version?: string;
}

export function buildMarketplaceGitEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = sanitizeZCodeRuntimeEnv(sourceEnv);
  // marketplace 安装会启动 Git 子进程，不能只依赖父进程继承的 shell 代理。
  // 这里统一从 ZCode 显式网络环境恢复 HTTP(S)/NO_PROXY/CA，避免安装按钮卡到协议超时。
  return applyNetworkEgressEnv(env, { sourceEnv });
}

function throwIfPluginOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createPluginOperationCancelledError();
  }
}

function createPluginOperationCancelledError(): Error {
  const error = new Error("Plugin operation cancelled");
  error.name = "AbortError";
  return error;
}

interface MarketplaceOperationSignalScope {
  cleanup: () => void;
  signal?: AbortSignal;
  timedOut: boolean;
  timeoutError: Error;
}

interface KnownMarketplaceActivation {
  finalize: () => void;
  rollback: () => Promise<void>;
}

// Claude 官方市场只提供可选目录，外部网络不可达时必须中止底层请求，不能拖住其他插件市场。
function createMarketplaceOperationSignalScope(
  trustedId: string | undefined,
  externalSignal?: AbortSignal,
): MarketplaceOperationSignalScope {
  if (trustedId !== CLAUDE_OFFICIAL_MARKETPLACE) {
    return {
      cleanup: () => {},
      signal: externalSignal,
      timedOut: false,
      timeoutError: new Error("Marketplace operation timed out"),
    };
  }

  const controller = new AbortController();
  const timeoutError = new Error(
    `Claude marketplace refresh timed out after ${CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS / 1000} seconds`,
  );
  timeoutError.name = "TimeoutError";
  const scope: MarketplaceOperationSignalScope = {
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortExternal);
    },
    signal: controller.signal,
    timedOut: false,
    timeoutError,
  };
  const abortExternal = (): void => {
    controller.abort(externalSignal?.reason);
  };
  const timeout = setTimeout(() => {
    scope.timedOut = true;
    controller.abort(timeoutError);
  }, CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS);

  if (externalSignal?.aborted) {
    abortExternal();
  } else {
    externalSignal?.addEventListener("abort", abortExternal, { once: true });
  }
  return scope;
}

interface LoadMarketplaceResult {
  cleanup?: () => Promise<void>;
  manifest: PluginMarketplaceManifest;
  sourceRoot?: string;
}

interface ResolvedPluginSourceRoot {
  cleanup?: () => Promise<void>;
  path: string;
}

interface CachedMarketplacePluginResult {
  activation?: AtomicDirectoryActivation;
  record: InstalledPluginRecord;
}

export async function parseMarketplaceSourceInput(input: string): Promise<MarketplaceSource> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Marketplace source is empty");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const { url, ref } = splitRef(trimmed);
    if (url.endsWith(".git") || url.includes("/_git/")) {
      return ref ? { source: "git", url, ref } : { source: "git", url };
    }
    const parsed = tryParseUrl(url);
    if (parsed && (parsed.hostname === "github.com" || parsed.hostname === "www.github.com")) {
      const match = parsed.pathname.match(/^\/([^/]+\/[^/]+?)(?:\/|\.git|$)/);
      if (match?.[1]) {
        const gitUrl = url.endsWith(".git") ? url : `${url}.git`;
        return ref ? { source: "git", url: gitUrl, ref } : { source: "git", url: gitUrl };
      }
    }
    return { source: "url", url };
  }

  if (isGitSshUrl(trimmed)) {
    const { url, ref } = splitRef(trimmed);
    return ref ? { source: "git", url, ref } : { source: "git", url };
  }

  const resolved = resolvePathInput(trimmed);
  if (resolved) {
    if (!existsSync(resolved))
      throw new Error(`Marketplace source path does not exist: ${resolved}`);
    if (fileExists(resolved)) {
      if (!resolved.endsWith(".json")) {
        throw new Error(`Marketplace file must be a .json file: ${resolved}`);
      }
      return { source: "file", path: resolved };
    }
    if (directoryExists(resolved)) return { source: "directory", path: resolved };
    throw new Error(`Marketplace source path is not a file or directory: ${resolved}`);
  }

  if (trimmed.includes("/") && !trimmed.includes(":")) {
    const { url: repo, ref } = splitGitHubShorthand(trimmed);
    return ref ? { source: "github", repo, ref } : { source: "github", repo };
  }

  throw new Error(`Unsupported marketplace source: ${input}`);
}

export function loadKnownMarketplacesSync(storageRoot: string): KnownMarketplaceRecord[] {
  const parsed = readJsonFileSync(join(storageRoot, KNOWN_MARKETPLACES_FILE));
  if (!isRecord(parsed)) return [];
  const value = parsed.marketplaces;
  if (Array.isArray(value)) return value.filter(isKnownMarketplaceRecord);
  if (isRecord(value)) return Object.values(value).filter(isKnownMarketplaceRecord);
  return [];
}

export async function ensureDefaultPluginMarketplaces(
  storageRoot: string,
): Promise<KnownMarketplaceRecord[]> {
  const known = loadKnownMarketplacesSync(storageRoot);
  const existingIds = new Set(known.map((record) => record.id));
  const now = new Date().toISOString();
  const missing = DEFAULT_PLUGIN_MARKETPLACES.filter(
    (marketplace) => !existingIds.has(marketplace.id),
  ).map(
    (marketplace): KnownMarketplaceRecord => ({
      id: marketplace.id,
      source: defaultMarketplaceSourceFromString(marketplace.source),
      name: marketplace.name,
      description: marketplace.description,
      addedAt: now,
      ...(marketplace.lastUpdated ? { lastUpdated: marketplace.lastUpdated } : {}),
      pluginCount: marketplace.pluginCount,
    }),
  );
  if (missing.length === 0) return known;
  const next = [...known, ...missing];
  // 热查询不持锁，首次登记也必须发布完整一代，不能让读者看见半份 JSON。
  await writeKnownMarketplaces(storageRoot, next);
  return next;
}

export async function ensureMarketplaceManifestAvailable(input: {
  marketplace: string;
  signal?: AbortSignal;
  storageRoot: string;
}): Promise<KnownMarketplaceRecord | null> {
  throwIfPluginOperationAborted(input.signal);
  await ensureDefaultPluginMarketplaces(input.storageRoot);
  if (loadMarketplaceManifestSync(input.storageRoot, input.marketplace)) {
    return (
      loadKnownMarketplacesSync(input.storageRoot).find(
        (record) => record.id === input.marketplace,
      ) ?? null
    );
  }
  const record = loadKnownMarketplacesSync(input.storageRoot).find(
    (item) => item.id === input.marketplace,
  );
  if (!record) return null;
  // 受信任的内部懒加载：用 known record 的规范 source 拉取，并以 record.id 作为 trustedId，
  // 使官方 id 只能由本来就是该官方 id 的记录刷新得到。
  return await addMarketplace({
    signal: input.signal,
    source: record.source,
    storageRoot: input.storageRoot,
    trustedId: record.id,
  });
}

export async function addMarketplace(input: {
  expectedId?: string;
  signal?: AbortSignal;
  source: MarketplaceSource;
  storageRoot: string;
  // 受信任的内部刷新传入正在刷新的 known record 规范 id。守卫只在 manifest 声明了官方 id
  // 且该 id 不等于本次刷新的 trustedId 时拒绝，避免来源在刷新过程中被改名冒用：
  //   - 用户侧新增（trustedId 缺失）声明官方 id → 拒绝；
  //   - 非官方市场日后把 manifest 改名成官方 id，刷新时 trustedId 不匹配 → 拒绝；
  // 非官方 manifest 名不受此约束，保持既有行为。
  trustedId?: string;
}): Promise<KnownMarketplaceRecord> {
  // persist:false 先只解析 manifest，不落盘——否则 marketplace 目录激活会用
  // 不可信 manifest.name 作为 target，先 rm 掉本地官方目录再 cp，等守卫抛错时
  // 官方 manifest 已被污染；守卫通过后才持久化。
  throwIfPluginOperationAborted(input.signal);
  const operationScope = createMarketplaceOperationSignalScope(input.trustedId, input.signal);
  const operationSignal = operationScope.signal;
  let loaded: LoadMarketplaceResult | undefined;
  let knownMarketplaceActivation: KnownMarketplaceActivation | undefined;
  let marketplaceActivation: AtomicDirectoryActivation | undefined;
  try {
    // Claude 官方目录与图标映射并行获取；图标只是展示增强，失败时会回退本地缓存或空映射。
    const iconSourcesPromise =
      input.trustedId === CLAUDE_OFFICIAL_MARKETPLACE
        ? loadClaudePluginIconSources(input.storageRoot, operationSignal)
        : null;
    loaded = await loadMarketplaceFromSource(input.source, input.storageRoot, {
      persist: false,
      signal: operationSignal,
    });
    throwIfPluginOperationAborted(operationSignal);
    if (isOfficialMarketplaceId(loaded.manifest.name) && loaded.manifest.name !== input.trustedId) {
      throw new Error(
        `Cannot add a marketplace named "${loaded.manifest.name}": that id is reserved for the official marketplace.`,
      );
    }
    if (input.expectedId && loaded.manifest.name !== input.expectedId) {
      throw new Error(
        `Marketplace declaration id mismatch: expected ${input.expectedId}, received ${loaded.manifest.name}`,
      );
    }
    if (
      input.trustedId === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE &&
      loaded.manifest.name !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE
    ) {
      throw new Error(
        `Official marketplace source must provide ${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}, received ${loaded.manifest.name}`,
      );
    }
    const iconSources = iconSourcesPromise ? await iconSourcesPromise : new Map<string, string>();
    const enrichedRaw =
      loaded.manifest.name === CLAUDE_OFFICIAL_MARKETPLACE
        ? applyClaudePluginIcons(loaded.manifest.raw, iconSources)
        : loaded.manifest.raw;
    const enrichedManifest = parseRequiredMarketplaceManifest(enrichedRaw);
    const persistedManifest =
      loaded.manifest.name === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE
        ? parseRequiredMarketplaceManifest(
            await writeCdnOfficialMarketplacePartition({
              manifest: loaded.manifest.raw,
              storageRoot: input.storageRoot,
            }),
          )
        : enrichedManifest;
    // 修复原因：旧流程先删 marketplace target 再复制 source，刷新失败会丢失最后成功快照。
    // source tree 与规范 manifest 在同一 staging 目录准备完毕后一次 rename 激活。
    if (loaded.sourceRoot) {
      marketplaceActivation = await stageMarketplaceDirectoryPlugins(
        loaded.sourceRoot,
        input.storageRoot,
        loaded.manifest.name,
        persistedManifest.raw,
        operationSignal,
      );
    } else if (loaded.manifest.name !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
      marketplaceActivation = await stageMarketplaceManifest(
        input.storageRoot,
        loaded.manifest.name,
        enrichedRaw,
        operationSignal,
      );
    }
    throwIfPluginOperationAborted(operationSignal);
    const now = new Date().toISOString();
    const record: KnownMarketplaceRecord = {
      id: loaded.manifest.name,
      source: input.source,
      name: loaded.manifest.name,
      ...(loaded.manifest.description ? { description: loaded.manifest.description } : {}),
      addedAt: now,
      lastUpdated: now,
      pluginCount: persistedManifest.plugins.length,
      ...(marketplaceActivation ? { cacheTransactionId: marketplaceActivation.transactionId } : {}),
    };
    knownMarketplaceActivation = await upsertKnownMarketplace(input.storageRoot, record);
    if (marketplaceActivation) {
      throwIfPluginOperationAborted(operationSignal);
    }
    // authority state 已落盘且 deadline 检查通过后才进入不可取消的提交尾声；
    // 先解除 timer，再清理 backup/marker，避免清理耗时把已提交事务反判成超时。
    operationScope.cleanup();
    await marketplaceActivation?.finalize();
    knownMarketplaceActivation.finalize();
    return record;
  } catch (error) {
    let rollbackError: unknown;
    try {
      await knownMarketplaceActivation?.rollback();
    } catch (currentRollbackError) {
      rollbackError = currentRollbackError;
    }
    try {
      if (rollbackError === undefined) {
        await marketplaceActivation?.rollback();
      } else {
        // authority 无法恢复时保留其指向的新 manifest，避免再次制造跨代状态。
        await marketplaceActivation?.finalize();
      }
    } catch (currentRollbackError) {
      rollbackError =
        rollbackError === undefined
          ? currentRollbackError
          : appendPluginSourceCleanupError(currentRollbackError, rollbackError);
    }
    const operationError = operationScope.timedOut
      ? (() => {
          const sourceDiagnosticCode = getPluginSourceDiagnosticCode(error);
          return sourceDiagnosticCode
            ? new PluginSourceMaterializationError(
                sourceDiagnosticCode,
                operationScope.timeoutError.message,
              )
            : operationScope.timeoutError;
        })()
      : error;
    throw appendPluginSourceCleanupError(operationError, rollbackError);
  } finally {
    await cleanupPluginSourceBestEffort(loaded?.cleanup);
    operationScope.cleanup();
  }
}

export function parsePluginIconSources(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const icon = typeof item.icon === "string" ? item.icon.trim() : "";
    const mimeType = typeof item.mimeType === "string" ? item.mimeType : undefined;
    const sha256 = typeof item.sha256 === "string" ? item.sha256 : undefined;
    if (!PLUGIN_NAME_PATTERN.test(name) || !isSafePluginIconPath(icon)) continue;
    if (mimeType !== undefined && mimeType !== "image/png") continue;
    if (sha256 !== undefined && !SOURCE_SHA256_PATTERN.test(sha256)) continue;
    result.set(name, new URL(icon, PLUGIN_ICON_ASSETS_BASE_URL).href);
  }
  return result;
}

export function applyClaudePluginIcons(
  manifest: Record<string, unknown>,
  iconByPluginName: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (!Array.isArray(manifest.plugins) || iconByPluginName.size === 0) return manifest;
  let changed = false;
  const plugins = manifest.plugins.map((plugin) => {
    if (!isRecord(plugin) || typeof plugin.name !== "string") return plugin;
    if (typeof plugin.icon === "string" && plugin.icon.trim().length > 0) return plugin;
    const icon = iconByPluginName.get(plugin.name);
    if (!icon) return plugin;
    changed = true;
    return { ...plugin, icon };
  });
  return changed ? { ...manifest, plugins } : manifest;
}

export async function enrichCachedClaudeMarketplaceIcons(
  storageRoot: string,
  withWriteLock: (write: () => Promise<void>) => Promise<void> = (write) => write(),
): Promise<void> {
  const attemptKey = resolve(storageRoot);
  if (claudeIconMigrationAttempts.has(attemptKey)) return;
  claudeIconMigrationAttempts.add(attemptKey);

  const manifest = loadMarketplaceManifestSync(storageRoot, CLAUDE_OFFICIAL_MARKETPLACE);
  if (!manifest) return;
  try {
    const iconSources = await loadClaudePluginIconSources(storageRoot);
    await withWriteLock(async () => {
      // 网络请求期间不持 plugin storage 锁；获得锁后必须重读，避免覆盖并发 marketplace 更新。
      const latest = loadMarketplaceManifestSync(storageRoot, CLAUDE_OFFICIAL_MARKETPLACE);
      if (!latest) return;
      const enriched = applyClaudePluginIcons(latest.raw, iconSources);
      if (enriched === latest.raw) return;
      // Bugfix：升级前已有 lastUpdated 的 catalog 不会触发 UI 自动刷新，导致新图标功能永远不可见。
      // 这里只回写展示增强字段，不重拉 marketplace，也不改变更新检测时间。
      await writeMarketplaceManifest(storageRoot, CLAUDE_OFFICIAL_MARKETPLACE, enriched);
    });
  } catch {
    // 存量图标迁移是 best-effort；失败不能让 plugins/overview 不可用，下次 Agent 启动可重试。
  }
}

function isSafePluginIconPath(icon: string): boolean {
  if (!icon.endsWith(".png") || icon.startsWith("/") || icon.includes("\\")) return false;
  const segments = icon.split("/");
  return segments.length >= 2 && segments.every((segment) => PLUGIN_NAME_PATTERN.test(segment));
}

async function loadClaudePluginIconSources(
  storageRoot: string,
  operationSignal?: AbortSignal,
): Promise<Map<string, string>> {
  const cachePath = join(storageRoot, PLUGIN_ICON_SOURCES_FILE);
  const cached = (): Map<string, string> => parsePluginIconSources(readJsonFileSync(cachePath));
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  operationSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 10_000);
  try {
    const response = await requestMarketplaceJson(
      PLUGIN_ICON_SOURCES_URL,
      undefined,
      controller.signal,
      10_000,
    );
    const value = response;
    const parsed = parsePluginIconSources(value);
    if (parsed.size === 0) return cached();
    // 缓存只保留产品需要的字段，不落盘素材源机器路径等 provenance 信息。
    const sanitized: PluginIconSourceRecord[] = [...parsed.entries()].map(([name, iconUrl]) => ({
      name,
      icon: new URL(iconUrl).pathname.slice(new URL(PLUGIN_ICON_ASSETS_BASE_URL).pathname.length),
      mimeType: "image/png",
    }));
    try {
      await writeJsonFile(cachePath, sanitized);
    } catch {
      // 图标缓存写入失败不影响本次 marketplace 主数据刷新。
    }
    return parsed;
  } catch {
    return cached();
  } finally {
    clearTimeout(timeout);
    operationSignal?.removeEventListener("abort", abort);
  }
}

async function requestMarketplaceJson(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = MARKETPLACE_JSON_TIMEOUT_MS,
): Promise<unknown> {
  const client = createNodeWebFetchHttpClientAdapter({
    env: process.env,
    maxResponseBytes: MARKETPLACE_JSON_MAX_BYTES,
    timeoutMs,
  });
  let currentHeaders = headers;
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount <= MARKETPLACE_JSON_MAX_REDIRECTS; redirectCount += 1) {
    const response = await client.request(
      {
        ...(currentHeaders ? { headers: currentHeaders } : {}),
        method: "GET",
        redirect: "manual",
        url: currentUrl,
      },
      { signal },
    );
    if (isMarketplaceJsonRedirectStatus(response.status)) {
      const location = response.headers.location;
      if (!location) {
        throw new Error(`Marketplace redirect is missing Location header: ${currentUrl}`);
      }
      const redirectUrl = new URL(location, currentUrl);
      // 代理/自定义 CA 分支的 http.request 不会执行 redirect:follow；
      // 这里统一有界跟随，并在跨 origin 时清理市场自定义 header，避免凭据泄露给 CDN。
      if (redirectUrl.origin !== new URL(currentUrl).origin) {
        currentHeaders = undefined;
      }
      currentUrl = redirectUrl.toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to fetch marketplace: ${response.status} ${response.statusText}`);
    }
    return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
  }
  throw new Error(`Marketplace fetch exceeded redirect limit: ${url}`);
}

function isMarketplaceJsonRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export async function updateMarketplace(input: {
  marketplace?: string;
  signal?: AbortSignal;
  storageRoot: string;
}): Promise<KnownMarketplaceRecord[]> {
  await ensureDefaultPluginMarketplaces(input.storageRoot);
  const known = loadKnownMarketplacesSync(input.storageRoot);
  const selected = input.marketplace
    ? known.filter((record) => record.id === input.marketplace)
    : known;
  if (input.marketplace && selected.length === 0) {
    throw new Error(`Marketplace not found: ${input.marketplace}`);
  }
  const updated: KnownMarketplaceRecord[] = [];
  for (const record of selected) {
    throwIfPluginOperationAborted(input.signal);

    // 受信任的刷新会重新拉取已知 marketplace 自带的 source；record.id 作为 trustedId，
    // 使官方 id 只能由原本就是该 id 的记录刷新得到。
    try {
      updated.push(
        await addMarketplace({
          signal: input.signal,
          source: record.source,
          storageRoot: input.storageRoot,
          trustedId: record.id,
        }),
      );
    } catch (error) {
      // 取消是当前 operation 的控制流，不是 Marketplace 健康状态；不得把 AbortError
      // 持久化成 refresh failure，避免后续普通商店页面误报官方源故障。
      if (input.signal?.aborted) throw error;
      const diagnostic = toValidationDiagnostic(error, record.id);
      await persistMarketplaceRefreshFailure(input.storageRoot, record.id, {
        code: diagnostic.code,
        failedAt: new Date().toISOString(),
        message: diagnostic.message,
      });
    }
  }
  return updated;
}

export async function removeMarketplace(input: {
  marketplace: string;
  storageRoot: string;
}): Promise<void> {
  const known = loadKnownMarketplacesSync(input.storageRoot).filter(
    (record) => record.id !== input.marketplace,
  );
  await writeKnownMarketplaces(input.storageRoot, known);
}

export function loadMarketplaceManifestSync(
  storageRoot: string,
  marketplace: string,
): PluginMarketplaceManifest | null {
  const manifestPath = getMarketplaceManifestPath(storageRoot, marketplace);
  // 崩溃残留先恢复；若 writer 仍活跃，则在权威 known state 落盘前读 backup，
  // 落盘后读新 target，避免 overview 看见跨代 manifest/summary。
  const readableDirectory = recoverAtomicTargetSync(dirname(manifestPath));
  const parsed = readJsonFileSync(join(readableDirectory, basename(manifestPath)));
  return parseMarketplaceManifest(parsed);
}

export function loadInstalledPluginsSync(storageRoot: string): InstalledPluginsState {
  const parsed = readJsonFileSync(join(storageRoot, INSTALLED_PLUGINS_FILE));
  return normalizeInstalledPluginsState(parsed);
}

export async function saveInstalledPlugins(
  storageRoot: string,
  state: InstalledPluginsState,
): Promise<void> {
  await writeJsonFile(join(storageRoot, INSTALLED_PLUGINS_FILE), state);
}

export function listInstalledPluginRecords(storageRoot: string): InstalledPluginRecord[] {
  return loadInstalledPluginsSync(storageRoot).plugins;
}

export function resolveInstalledPluginRoot(
  storageRoot: string,
  record: InstalledPluginRecord,
): string {
  const root =
    record.installPath ||
    getPluginCacheDir(storageRoot, record.marketplace, record.name, record.version);
  return recoverAtomicTargetSync(root);
}

export async function resolveInstalledPluginRootAsync(
  storageRoot: string,
  record: InstalledPluginRecord,
): Promise<string> {
  const root =
    record.installPath ||
    getPluginCacheDir(storageRoot, record.marketplace, record.name, record.version);
  return resolveAtomicReadPath(root);
}

export async function installMarketplacePlugin(input: {
  marketplace: string;
  name: string;
  signal?: AbortSignal;
  storageRoot: string;
  scope?: "user" | "workspace";
  allowCrossMarketplaces?: ReadonlySet<string>;
}): Promise<MarketplaceInstallResult> {
  await ensureMarketplaceManifestAvailable({
    marketplace: input.marketplace,
    signal: input.signal,
    storageRoot: input.storageRoot,
  });
  throwIfPluginOperationAborted(input.signal);
  const rootManifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
  const closure = resolveDependencyClosure({
    allowCrossMarketplaces:
      input.allowCrossMarketplaces ??
      new Set(rootManifest?.allowCrossMarketplaceDependenciesOn ?? []),
    marketplace: input.marketplace,
    name: input.name,
    storageRoot: input.storageRoot,
  });
  const state = loadInstalledPluginsSync(input.storageRoot);
  const installed: InstalledPluginRecord[] = [];
  const activations: AtomicDirectoryActivation[] = [];
  try {
    for (const pluginId of closure) {
      const { marketplace, name } = parsePluginId(pluginId);
      const manifest = loadMarketplaceManifestSync(input.storageRoot, marketplace);
      if (!manifest) throw new Error(`Marketplace not found: ${marketplace}`);
      const entry = manifest.plugins.find((plugin) => plugin.name === name);
      if (!entry) throw new Error(`Plugin not found: ${pluginId}`);
      const cached = await cacheMarketplacePlugin({
        entry,
        marketplace,
        signal: input.signal,
        scope: input.scope ?? "user",
        state,
        storageRoot: input.storageRoot,
      });
      installed.push(cached.record);
      if (cached.activation) activations.push(cached.activation);
    }
    throwIfPluginOperationAborted(input.signal);
    await saveInstalledPlugins(input.storageRoot, state);
  } catch (error) {
    let rollbackError: unknown;
    for (const activation of activations.reverse()) {
      try {
        await activation.rollback();
      } catch (currentRollbackError) {
        rollbackError ??= currentRollbackError;
      }
    }
    throw appendPluginSourceCleanupError(error, rollbackError);
  }
  for (const activation of activations) await activation.finalize();
  return { closure, installed };
}

export async function uninstallMarketplacePlugin(input: {
  pluginId: string;
  storageRoot: string;
  removeCache?: boolean;
  /** `zcode plugins uninstall --keep-data`：删安装缓存但保留 data/<plugin-id> 用户数据目录。 */
  keepData?: boolean;
}): Promise<InstalledPluginRecord | null> {
  const state = loadInstalledPluginsSync(input.storageRoot);
  const index = state.plugins.findIndex((record) => record.id === input.pluginId);
  if (index < 0) return null;
  const [removed] = state.plugins.splice(index, 1);
  await saveInstalledPlugins(input.storageRoot, state);
  if (removed && input.removeCache === true) {
    await rm(removed.installPath, { force: true, recursive: true });
    // 彻底卸载：data/<plugin-id> 是持久化的 per-plugin 目录（含 materialize 的 generated-commands）。
    // 按「卸载最后一份安装时一并删除」语义，保证重装是干净的。

    if (input.keepData !== true) {
      await rm(getPluginDataDir(input.storageRoot, removed.id), { force: true, recursive: true });
    }
  }
  return removed ?? null;
}

export async function validateMarketplacePlugin(input: {
  marketplace: string;
  name: string;
  storageRoot: string;
}): Promise<PluginValidationDiagnostic[]> {
  const diagnostics: PluginValidationDiagnostic[] = [];
  try {
    await ensureMarketplaceManifestAvailable({
      marketplace: input.marketplace,
      storageRoot: input.storageRoot,
    });
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error, `${input.name}@${input.marketplace}`));
    return diagnostics;
  }
  const manifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
  if (!manifest) {
    diagnostics.push({
      code: "plugin_marketplace_invalid",
      message: `Marketplace not found: ${input.marketplace}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return diagnostics;
  }
  const plugin = manifest.plugins.find((entry) => entry.name === input.name);
  if (!plugin) {
    diagnostics.push({
      code: "plugin_not_found",
      message: `Plugin not found: ${input.name}@${input.marketplace}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return diagnostics;
  }

  pushDependencyDiagnostics({
    diagnostics,
    marketplace: input.marketplace,
    name: input.name,
    storageRoot: input.storageRoot,
  });

  let resolved: ResolvedPluginSourceRoot | null = null;
  try {
    resolved = await resolvePluginSourceRoot({
      entry: plugin,
      marketplace: input.marketplace,
      storageRoot: input.storageRoot,
    });
    diagnostics.push(
      ...(await validatePluginRoot({
        entry: plugin,
        marketplace: input.marketplace,
        rootPath: resolved.path,
        storageRoot: input.storageRoot,
      })),
    );
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error, `${input.name}@${input.marketplace}`));
  } finally {
    await cleanupPluginSourceBestEffort(resolved?.cleanup);
  }
  return diagnostics;
}

/**
 * 按需枚举单个插件的组件「名称 + 描述」，供 marketplace 详情 UI 使用。
 * - 已安装插件：直接读本地缓存/安装目录，无需联网。
 * - 未安装候选：解析并按需临时 clone 插件源（finally 清理临时目录），参照 validateMarketplacePlugin。
 * 组件名称与描述来自组件目录的 frontmatter（command/agent 的 .md、skill 的 SKILL.md）、
 * 以及 manifest（hooks 事件名、mcpServers 名称、object 形式声明的 commands/agents）。
 * 任何一类组件读取失败都降级为「能拿到多少返回多少」+ 诊断，不抛断整个详情。
 */
export async function describeMarketplacePlugin(input: {
  marketplace: string;
  name: string;
  storageRoot: string;
  /** 只包住会写 known/manifest 的懒加载分支；其余只读路径不进锁。 */
  withWriteLock?: <T>(write: () => Promise<T>) => Promise<T>;
}): Promise<DescribeMarketplacePluginResult> {
  const diagnostics: PluginValidationDiagnostic[] = [];
  const pluginId = `${input.name}@${input.marketplace}`;

  // 已安装优先：本地目录无需 clone，速度快且离线可用。
  const installedRecord = loadInstalledPluginsSync(input.storageRoot).plugins.find(
    (record) => record.marketplace === input.marketplace && record.name === input.name,
  );
  if (installedRecord) {
    const rootPath = resolveInstalledPluginRoot(input.storageRoot, installedRecord);
    if (directoryExists(rootPath)) {
      const read = await readComponentsAtRoot({
        diagnostics,
        marketplace: input.marketplace,
        rootPath,
      });
      return {
        components: read.components,
        diagnostics,
        ...(read.metadata ? { metadata: read.metadata } : {}),
      };
    }
    // 安装记录存在但缓存缺失（被清理）——继续走源解析兜底，而不是直接报错。
  }

  let manifest: PluginMarketplaceManifest | null = null;
  try {
    manifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
    if (!manifest) {
      // Bugfix：describe 曾整体持 storage lock，安装下载期间所有详情都排在锁后。
      // 只有 manifest 缺失时才写 known/manifest，此时必须与安装、市场刷新串行。
      const withWriteLock = input.withWriteLock ?? ((write) => write());
      await withWriteLock(() =>
        ensureMarketplaceManifestAvailable({
          marketplace: input.marketplace,
          storageRoot: input.storageRoot,
        }),
      );
      manifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
    }
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error, pluginId));
    return { components: [], diagnostics };
  }
  if (!manifest) {
    diagnostics.push({
      code: "plugin_marketplace_invalid",
      message: `Marketplace not found: ${input.marketplace}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return { components: [], diagnostics };
  }
  const entry = manifest.plugins.find((candidate) => candidate.name === input.name);
  if (!entry) {
    diagnostics.push({
      code: "plugin_not_found",
      message: `Plugin not found: ${pluginId}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return { components: [], diagnostics };
  }

  let resolved: ResolvedPluginSourceRoot | null = null;
  try {
    resolved = await resolvePluginSourceRoot({
      entry,
      marketplace: input.marketplace,
      storageRoot: input.storageRoot,
    });
    const read = await readComponentsAtRoot({
      diagnostics,
      entry,
      marketplace: input.marketplace,
      rootPath: resolved.path,
    });
    return {
      components: read.components,
      diagnostics,
      ...(read.metadata ? { metadata: read.metadata } : {}),
    };
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error, pluginId));
    return { components: [], diagnostics };
  } finally {
    await cleanupPluginSourceBestEffort(resolved?.cleanup);
  }
}

/** 读插件根目录的 manifest（失败按 null 降级），再交给纯枚举器列出组件名称+描述。 */
async function readComponentsAtRoot(input: {
  diagnostics: PluginValidationDiagnostic[];
  entry?: PluginMarketplaceEntry;
  marketplace: string;
  rootPath: string;
}): Promise<{ components: PluginComponentGroup[]; metadata?: PluginManifestDisplayMetadata }> {
  let loadedManifest: { manifest: PluginManifest; manifestPath?: string } | null = null;
  try {
    loadedManifest = readPluginManifestFromRoot(
      input.rootPath,
      input.entry ?? { name: "__describe__", raw: {} },
    );
  } catch {
    // manifest 解析失败不致命：仍可按默认目录约定扫描组件。
    loadedManifest = null;
  }
  const loaded = loadedManifest
    ? {
        id: `${loadedManifest.manifest.name}@${input.marketplace}`,
        manifest: loadedManifest.manifest,
        manifestPath: loadedManifest.manifestPath ?? input.rootPath,
        marketplace: input.marketplace,
        rootPath: input.rootPath,
        source: "cache" as const,
      }
    : undefined;
  const components = await enumeratePluginComponents(
    input.rootPath,
    loadedManifest?.manifest ?? null,
    {
      diagnostics: input.diagnostics as PluginDiagnostic[],
      ...(loaded ? { loaded } : {}),
    },
  );
  const metadata = loadedManifest ? toManifestDisplayMetadata(loadedManifest.manifest) : undefined;
  return { components, ...(metadata ? { metadata } : {}) };
}

/** 抽取 plugin.json 里可展示的回退字段；一个都没有时返回 undefined。 */
function toManifestDisplayMetadata(
  manifest: PluginManifest,
): PluginManifestDisplayMetadata | undefined {
  const author = normalizeAuthorValue(manifest.author);
  const homepage =
    typeof manifest.homepage === "string" && manifest.homepage.trim().length > 0
      ? manifest.homepage
      : undefined;
  const metadata: PluginManifestDisplayMetadata = {
    ...(author?.name ? { author: author.name } : {}),
    ...(author?.url ? { authorUrl: author.url } : {}),
    ...(homepage ? { homepage } : {}),
    ...(manifest.version ? { version: manifest.version } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export async function validateMarketplaceSource(input: {
  expectedId?: string;
  pluginName?: string;
  signal?: AbortSignal;
  source: MarketplaceSource;
  storageRoot: string;
}): Promise<PluginValidationDiagnostic[]> {
  const diagnostics: PluginValidationDiagnostic[] = [];
  let loaded: LoadMarketplaceResult | null = null;
  try {
    loaded = await loadMarketplaceFromSource(input.source, input.storageRoot, {
      persist: false,
      signal: input.signal,
    });
    if (input.expectedId && loaded.manifest.name !== input.expectedId) {
      diagnostics.push({
        code: "plugin_marketplace_invalid",
        message:
          `Marketplace declaration id mismatch: expected ${input.expectedId}, ` +
          `received ${loaded.manifest.name}`,
        pluginId: input.expectedId,
        severity: "error",
      });
      return diagnostics;
    }
    if (loaded.manifest.plugins.length === 0) {
      diagnostics.push({
        code: "plugin_marketplace_invalid",
        message: `Marketplace has no plugins: ${loaded.manifest.name}`,
        severity: "warning",
      });
    }
    const entries = input.pluginName
      ? loaded.manifest.plugins.filter((entry) => entry.name === input.pluginName)
      : loaded.manifest.plugins;
    if (input.pluginName && entries.length === 0) {
      diagnostics.push({
        code: "plugin_not_found",
        message: `Plugin not found: ${input.pluginName}@${loaded.manifest.name}`,
        pluginId: `${input.pluginName}@${loaded.manifest.name}`,
        severity: "error",
      });
      return diagnostics;
    }
    for (const entry of entries) {
      diagnostics.push(
        ...validateMarketplaceEntryShape(entry, loaded.manifest.name, {
          includeEntryCompatibility: false,
        }),
      );
      pushDependencyDiagnosticsFromManifest({
        diagnostics,
        manifest: loaded.manifest,
        marketplace: loaded.manifest.name,
        name: entry.name,
        storageRoot: input.storageRoot,
      });
      const deferred = getMarketplaceSourceValidationDeferral(entry, loaded.manifest.name);
      if (deferred) {
        diagnostics.push(deferred);
        pushEntryCompatibilityDiagnostics({
          diagnostics,
          entry,
          marketplace: loaded.manifest.name,
        });
        continue;
      }
      let resolved: ResolvedPluginSourceRoot | null = null;
      try {
        resolved = await resolvePluginSourceRoot({
          entry,
          marketplace: loaded.manifest.name,
          manifest: loaded.manifest,
          signal: input.signal,
          sourceRoot: loaded.sourceRoot,
          storageRoot: input.storageRoot,
        });
        diagnostics.push(
          ...(await validatePluginRoot({
            entry,
            marketplace: loaded.manifest.name,
            rootPath: resolved.path,
            storageRoot: input.storageRoot,
          })),
        );
      } catch (error) {
        diagnostics.push(toValidationDiagnostic(error, `${entry.name}@${loaded.manifest.name}`));
        // validate source 是 dry-run, 但也必须给 UI 展示 marketplace 条目里声明的能力风险。
        // 当远端/相对 plugin source 暂时不可解析时, 仍基于 entry 原文输出 diagnostic-only 能力诊断。
        pushEntryCompatibilityDiagnostics({
          diagnostics,
          entry,
          marketplace: loaded.manifest.name,
        });
      } finally {
        await cleanupPluginSourceBestEffort(resolved?.cleanup);
      }
    }
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error));
  } finally {
    await cleanupPluginSourceBestEffort(loaded?.cleanup);
  }
  return diagnostics;
}

/**
 * 校验本地插件或 marketplace 路径，只读解析 manifest 并返回结构化诊断，不写入 storage。
 * 输入可以是目录或 manifest 文件；目录按 marketplace 优先、插件根目录其次的顺序识别。
 */
export async function validateLocalPluginPath(input: {
  path: string;
  signal?: AbortSignal;
  storageRoot: string;
}): Promise<PluginValidationDiagnostic[]> {
  const resolved = resolve(input.path);
  if (!existsSync(resolved)) {
    return [
      {
        code: "plugin_manifest_not_found",
        message: `Path does not exist: ${resolved}`,
        path: resolved,
        severity: "error",
      },
    ];
  }
  const rootPath = statSync(resolved).isDirectory()
    ? resolved
    : resolveManifestRootFromFile(resolved);
  if (findMarketplaceManifestPath(rootPath)) {
    return await validateMarketplaceSource({
      signal: input.signal,
      source: { source: "directory", path: rootPath },
      storageRoot: input.storageRoot,
    });
  }
  const manifestPath = findPluginManifestPath(rootPath);
  if (!manifestPath) {
    return [
      {
        code: "plugin_manifest_not_found",
        message: `Plugin manifest not found: ${rootPath}`,
        path: rootPath,
        severity: "error",
      },
    ];
  }
  let name = "";
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (isRecord(parsed) && typeof parsed.name === "string") name = parsed.name.trim();
  } catch (error) {
    return [
      {
        code: "plugin_manifest_invalid",
        message: error instanceof Error ? error.message : String(error),
        path: manifestPath,
        severity: "error",
      },
    ];
  }
  // 本地目录没有 marketplace 条目：用 manifest 自己的 name 合成一个 strict 条目，
  // 让 validatePluginRoot 走与已安装插件完全相同的 manifest/MCP 校验。
  return await validatePluginRoot({
    entry: { name: name || basename(rootPath), raw: {} },
    marketplace: "inline",
    rootPath,
    storageRoot: input.storageRoot,
  });
}

/** 用户传入 manifest 文件时，回推对应的插件根目录。 */
function resolveManifestRootFromFile(filePath: string): string {
  const dir = dirname(filePath);
  const dirName = basename(dir);
  return dirName.startsWith(".") && dirName.endsWith("-plugin") ? dirname(dir) : dir;
}

export function getMarketplaceManifestPath(storageRoot: string, marketplace: string): string {
  return join(storageRoot, "marketplaces", sanitizePluginId(marketplace), MARKETPLACE_FILE);
}

function resolveDependencyClosure(input: {
  allowCrossMarketplaces: ReadonlySet<string>;
  marketplace: string;
  name: string;
  storageRoot: string;
}): string[] {
  const rootId = `${input.name}@${input.marketplace}`;
  const closure: string[] = [];
  const visiting: string[] = [];
  const visited = new Set<string>();

  const walk = (pluginId: string, requiredBy: string): void => {
    const { marketplace, name } = parsePluginId(pluginId);
    if (marketplace !== input.marketplace && !input.allowCrossMarketplaces.has(marketplace)) {
      throw new Error(
        `Cross-marketplace dependency is blocked: ${pluginId} required by ${requiredBy}`,
      );
    }
    if (visiting.includes(pluginId)) {
      throw new Error(`Plugin dependency cycle: ${[...visiting, pluginId].join(" -> ")}`);
    }
    if (visited.has(pluginId)) return;
    const manifest = loadMarketplaceManifestSync(input.storageRoot, marketplace);
    if (!manifest) throw new Error(`Marketplace not found for dependency: ${marketplace}`);
    const entry = manifest.plugins.find((plugin) => plugin.name === name);
    if (!entry) throw new Error(`Dependency not found: ${pluginId} required by ${requiredBy}`);
    visiting.push(pluginId);
    for (const dependency of entry.dependencies ?? []) {
      walk(qualifyDependency(dependency, marketplace), pluginId);
    }
    visiting.pop();
    visited.add(pluginId);
    closure.push(pluginId);
  };

  walk(rootId, rootId);
  return closure;
}

async function cacheMarketplacePlugin(input: {
  entry: PluginMarketplaceEntry;
  marketplace: string;
  signal?: AbortSignal;
  scope: "user" | "workspace";
  state: InstalledPluginsState;
  storageRoot: string;
}): Promise<CachedMarketplacePluginResult> {
  throwIfPluginOperationAborted(input.signal);
  const sourceRoot = await resolvePluginSourceRoot({
    entry: input.entry,
    marketplace: input.marketplace,
    signal: input.signal,
    storageRoot: input.storageRoot,
  });
  let version: string;
  let target: string;
  let activation: AtomicDirectoryActivation | undefined;
  try {
    // 多顶层 ZIP 未显式 path 时 resolver 会回退到 extract root，
    // 原安装流程未在删除旧 cache 前校验 manifest，仍会写 installed record 并默认启用，最终 runtime
    // 无法 discover。ZIP 源必须先确认根目录可形成合法插件；strict:false 继续复用 synthetic manifest。
    if (isZipPluginUrlSource(input.entry.source)) {
      assertZipPluginInstallRoot(sourceRoot.path, input.entry, input.marketplace);
    }
    // 缓存目录的版本段与安装记录的 version 不能取自 marketplace 条目的
    // version 字段：git/url 源插件的条目通常不带 version，取了也只会兜底成
    // "0.0.0"，导致 Root path 落到 .../<name>/0.0.0；而 UI 展示读的是插件自带 plugin.json 里的
    // 真实版本，两者割裂。因此在 clone/拷贝后的源根目录上按加载器同样的规则解析真实
    // 版本（详见 resolveInstalledPluginVersion），让缓存路径段与安装记录、UI 展示版本一致。
    version = resolveInstalledPluginVersion(sourceRoot.path, input.entry);
    target = getPluginCacheDir(input.storageRoot, input.marketplace, input.entry.name, version);
    // 内置 filesystem/sea 插件的 cachePath 即缓存目录本身，源根目录可能与 target 相同；
    // 此时无需（也不能）先 rm 再自我拷贝，否则会把源删掉。
    if (resolve(sourceRoot.path) !== resolve(target)) {
      throwIfPluginOperationAborted(input.signal);
      activation = await activateDirectoryAtomically({
        authorityPath: join(input.storageRoot, INSTALLED_PLUGINS_FILE),
        prepare: async (stagedPath) => {
          await ensureMarketplaceEntryManifest({ entry: input.entry, target: stagedPath });
        },
        signal: input.signal,
        sourcePath: sourceRoot.path,
        targetPath: target,
      });
    }
    if (resolve(sourceRoot.path) === resolve(target)) {
      await ensureMarketplaceEntryManifest({ entry: input.entry, target });
    }
  } finally {
    // cache 已复制成功后，临时目录 cleanup 失败不能阻断 installed record 落盘。
    await cleanupPluginSourceBestEffort(sourceRoot.cleanup);
  }

  const now = new Date().toISOString();
  const record: InstalledPluginRecord = {
    id: `${input.entry.name}@${input.marketplace}`,
    name: input.entry.name,
    marketplace: input.marketplace,
    version,
    installPath: target,
    installedAt: now,
    updatedAt: now,
    scope: input.scope,
    ...(input.entry.dependencies ? { dependencies: input.entry.dependencies } : {}),
    ...(input.entry.source !== undefined ? { source: input.entry.source } : {}),
    ...(activation ? { cacheTransactionId: activation.transactionId } : {}),
  };
  const existingIndex = input.state.plugins.findIndex((plugin) => plugin.id === record.id);
  if (existingIndex >= 0) {
    const { cacheTransactionId: _previousCacheTransactionId, ...previousRecord } =
      input.state.plugins[existingIndex] ?? record;
    input.state.plugins[existingIndex] = {
      ...previousRecord,
      ...record,
      installedAt: previousRecord.installedAt ?? record.installedAt,
    };
  } else {
    input.state.plugins.push(record);
  }
  return { ...(activation ? { activation } : {}), record };
}

async function resolvePluginSourceRoot(input: {
  entry: PluginMarketplaceEntry;
  manifest?: PluginMarketplaceManifest;
  marketplace: string;
  signal?: AbortSignal;
  sourceRoot?: string;
  storageRoot: string;
}): Promise<ResolvedPluginSourceRoot> {
  throwIfPluginOperationAborted(input.signal);
  const source = input.entry.source;
  const marketplaceDir =
    input.sourceRoot ?? dirname(getMarketplaceManifestPath(input.storageRoot, input.marketplace));
  const manifest =
    input.manifest ?? loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
  const pluginBaseDir = resolveMarketplacePluginBaseDir(marketplaceDir, manifest);
  // 内置 official 插件 seed 到 marketplace.json 时 source 写的是裸 kind 字符串
  // "filesystem"/"sea"（见 bootstrap/app/bundled-plugins.ts writeOfficialMarketplace），
  // 原逻辑落到下面的 `typeof source === "string"` 分支，把 "filesystem" 当相对路径解析后抛
  // "Unsupported or missing plugin source: filesystem"，导致市场详情页对内置插件枚举不出组件。
  // 这类插件已落盘在 cachePath（缺失时按 cache/<marketplace>/<name>/<version> 兜底），直接定位即可。
  if (source === "filesystem" || source === "sea") {
    const cachePath = input.entry.cachePath;
    if (cachePath && directoryExists(cachePath)) return { path: cachePath };
    const computed = getPluginCacheDir(
      input.storageRoot,
      input.marketplace,
      input.entry.name,
      input.entry.version ?? DEFAULT_VERSION,
    );
    if (directoryExists(computed)) return { path: computed };
    throw new Error(
      `Bundled plugin cache directory missing: ${input.entry.name}@${input.marketplace}`,
    );
  }
  if (typeof source === "string") {
    const local = resolveInside(pluginBaseDir, source.replace(/^\.\//, ""));
    if (local && directoryExists(local)) return { path: local };
    const fallback = resolve(source);
    if (directoryExists(fallback)) return { path: fallback };
    throw new Error(`Unsupported or missing plugin source: ${source}`);
  }
  if (isRecord(source)) {
    const sourceKind = typeof source.source === "string" ? source.source : "";
    if (sourceKind === "directory") {
      const path = resolve(readRequiredPluginSourceString(source, "path", "directory path"));
      if (directoryExists(path)) return { path };
      throw new Error(`Plugin source directory does not exist: ${path}`);
    }
    if (sourceKind === "github") {
      const repo = readRequiredPluginSourceString(source, "repo", "GitHub repo");
      const url = `https://github.com/${repo}.git`;
      return resolveRepositoryPluginSource({
        path: typeof source.path === "string" ? source.path : undefined,
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url,
      });
    }
    if (sourceKind === "git") {
      return resolveRepositoryPluginSource({
        path: typeof source.path === "string" ? source.path : undefined,
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url: readRequiredPluginSourceString(source, "url", "Git URL"),
      });
    }
    if (sourceKind === "url") {
      const url = readRequiredPluginSourceString(source, "url", "URL");
      const sourceType = typeof source.type === "string" ? source.type : "";
      if (sourceType === "zip") {
        return resolveZipPluginSource({
          headers: readPluginSourceHeaders(source),
          path: readOptionalZipPluginSourcePath(source),
          sha256: readRequiredZipPluginSourceSha256(source),
          signal: input.signal,
          stripRoot: readOptionalZipPluginSourceStripRoot(source),
          url,
        });
      }
      if (sourceType && sourceType !== "git") {
        throw new UnsupportedPluginSourceError(`url:${sourceType}`);
      }
      return resolveRepositoryPluginSource({
        path: typeof source.path === "string" ? source.path : undefined,
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url,
      });
    }
    if (sourceKind === "git-subdir") {
      return resolveRepositoryPluginSource({
        path: readRequiredPluginSourceString(source, "path", "git-subdir path"),
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url: normalizeGitUrl(readRequiredPluginSourceString(source, "url", "git-subdir URL")),
      });
    }
    if (sourceKind === "npm" || sourceKind === "pip") {
      throw new UnsupportedPluginSourceError(sourceKind);
    }
    // 显式 object source 配置错误时不能降级到 marketplace 内同名目录，否则会安装错误来源。
    throw new Error(
      `Plugin source is invalid or unsupported for ${input.entry.name}@${input.marketplace}: ${sourceKind || "missing kind"}`,
    );
  }
  const localByName = join(pluginBaseDir, input.entry.name);
  if (directoryExists(localByName)) return { path: localByName };
  throw new Error(`Plugin source is not supported for ${input.entry.name}@${input.marketplace}`);
}

export function readPluginSourceSha(source: unknown): string | undefined {
  return readPluginSourceIdentityPin(source);
}

export function readPluginSourceIdentityPin(source: unknown): string | undefined {
  if (!isRecord(source)) return undefined;
  const zipSha256 = readZipPluginSourceSha256(source);
  if (zipSha256) return zipSha256;
  if (typeof source.sha === "string") return source.sha;

  // 兼容旧版及第三方 marketplace 的 source identity 写法。
  if (typeof source.commit === "string") return source.commit;
  return undefined;
}

function readRequiredZipPluginSourceSha256(source: Record<string, unknown>): string {
  if (typeof source.sha256 === "string") return source.sha256;
  throw new Error("Plugin zip source sha256 is required");
}

function readRequiredPluginSourceString(
  source: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = source[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Plugin ${label} source requires a non-empty ${field}`);
  }
  return value;
}

function readOptionalZipPluginSourcePath(source: Record<string, unknown>): string | undefined {
  if (source.path === undefined) return undefined;
  if (typeof source.path === "string") return source.path;
  throw new Error("Plugin zip source path must be a string");
}

function readOptionalZipPluginSourceStripRoot(
  source: Record<string, unknown>,
): boolean | undefined {
  if (source.stripRoot === undefined) return undefined;
  if (typeof source.stripRoot === "boolean") return source.stripRoot;
  throw new Error("Plugin zip source stripRoot must be a boolean");
}

function readPluginSourceHeaders(
  source: Record<string, unknown>,
): Record<string, string> | undefined {
  if (source.headers === undefined) return undefined;
  if (!isRecord(source.headers)) {
    throw new Error("Plugin zip source headers must be an object");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(source.headers)) {
    if (typeof value !== "string") {
      throw new Error(`Plugin zip source header must be a string: ${key}`);
    }
    headers[key] = value;
  }
  return headers;
}

async function resolveGitPluginSource(input: {
  path?: string;
  ref?: string;
  signal?: AbortSignal;
  sha?: string;
  url: string;
}): Promise<ResolvedPluginSourceRoot> {
  const dir = await clonePluginSource(input.url, input.ref, input.sha, input.signal);
  const cleanup = async (): Promise<void> => {
    await rm(dir, { force: true, recursive: true });
  };
  if (!input.path) return { cleanup, path: dir };
  throwIfPluginOperationAborted(input.signal);
  const subdir = resolveInside(dir, input.path);
  if (!subdir || !directoryExists(subdir)) {
    const primaryError = new Error(`Plugin source subdirectory does not exist: ${input.path}`);
    const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
    throw appendPluginSourceCleanupError(primaryError, cleanupError);
  }
  return { cleanup, path: subdir };
}

async function resolveRepositoryPluginSource(input: {
  path?: string;
  ref?: string;
  signal?: AbortSignal;
  sha?: string;
  url: string;
}): Promise<ResolvedPluginSourceRoot> {
  try {
    return await resolveGitHubArchiveSource({
      path: input.path,
      pin: input.sha ?? input.ref,
      signal: input.signal,
      url: input.url,
    });
  } catch (error) {
    if (!shouldFallbackGitHubArchiveToGit(error)) {
      throw createArchiveFetchError(input.url, error);
    }
  }
  return resolveGitPluginSource(input);
}

async function clonePluginSource(
  url: string,
  ref: string | undefined,
  sha?: string,
  signal?: AbortSignal,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-src-"));
  const args = ["clone"];
  if (!sha) args.push("--depth", "1");
  if (ref) args.push("--branch", ref);
  args.push(url, dir);
  try {
    await execGitCloneWithRetry(args, dir, signal);
    if (sha) await execGitCommand(["-C", dir, "checkout", sha], signal);
    return dir;
  } catch (error) {
    const cleanupError = await cleanupPluginSourceBestEffort(async () => {
      await rm(dir, { force: true, recursive: true });
    });
    throw appendPluginSourceCleanupError(error, cleanupError);
  }
}

function normalizeGitUrl(value: string): string {
  if (/^[^/]+\/[^/]+$/u.test(value) && !value.includes(":")) {
    return `https://github.com/${value}.git`;
  }
  return value;
}

function resolveMarketplacePluginBaseDir(
  marketplaceDir: string,
  manifest: PluginMarketplaceManifest | null,
): string {
  const pluginRoot = manifest?.pluginRoot;
  if (!pluginRoot) return marketplaceDir;
  const resolved = resolveInside(marketplaceDir, pluginRoot);
  return resolved && directoryExists(resolved) ? resolved : marketplaceDir;
}

async function ensureMarketplaceEntryManifest(input: {
  entry: PluginMarketplaceEntry;
  target: string;
}): Promise<void> {
  if (findPluginManifestPath(input.target)) return;
  if (input.entry.strict !== false) return;
  const manifestDir = join(input.target, ".claude-plugin");
  await mkdir(manifestDir, { recursive: true });
  await writeJsonFile(
    join(manifestDir, "plugin.json"),
    createManifestFromMarketplaceEntry(input.entry),
  );
}

function assertZipPluginInstallRoot(
  rootPath: string,
  entry: PluginMarketplaceEntry,
  marketplace: string,
): void {
  const loaded = readPluginManifestFromRoot(rootPath, entry);
  const pluginId = `${entry.name}@${marketplace}`;
  if (!loaded) {
    throw new Error(`Plugin manifest not found: ${pluginId}`);
  }
  if (loaded.manifest.name !== entry.name) {
    throw new Error(
      `Plugin manifest name '${loaded.manifest.name}' does not match marketplace entry '${entry.name}'`,
    );
  }
}

function createManifestFromMarketplaceEntry(
  entry: PluginMarketplaceEntry,
): Record<string, unknown> {
  const raw = { ...entry.raw };
  delete raw.source;
  delete raw.category;
  delete raw.tags;
  delete raw.strict;
  // 商店信息（Store Listing）是目录层展示元数据，不属于插件 manifest；
  // 合成 manifest 时剔除，避免污染 plugin.json 语义（author/homepage 是合法 manifest 字段，保留）。
  delete raw.displayName;
  delete raw.displayName_i18n;
  delete raw.description_i18n;
  delete raw.icon;
  delete raw.privacyPolicy;
  delete raw.termsOfService;
  delete raw.heroImage;
  delete raw.examplePrompts;
  delete raw.examplePrompts_i18n;
  delete raw.requiresPaidPlan;
  // 扩展摘要也是目录层的信息（docs/plugins/plugin-publishing.md §4.2），不是清单的 extension 键。
  delete raw.extensionSummary;
  return {
    ...raw,
    name: entry.name,
    version: entry.version ?? DEFAULT_VERSION,
  };
}

async function loadMarketplaceFromSource(
  source: MarketplaceSource,
  storageRoot: string,
  options: { persist: boolean; signal?: AbortSignal },
): Promise<LoadMarketplaceResult> {
  throwIfPluginOperationAborted(options.signal);
  switch (source.source) {
    case "settings":
      return { manifest: normalizeMarketplaceManifest(source.marketplace) };
    case "file": {
      const parsed = JSON.parse(await readFile(source.path, "utf8")) as unknown;
      return {
        manifest: parseRequiredMarketplaceManifest(parsed),
        sourceRoot: dirname(source.path),
      };
    }
    case "directory": {
      const file = findMarketplaceManifestPath(source.path);
      if (!file) throw new Error(`Marketplace manifest not found in directory: ${source.path}`);
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      const manifest = parseRequiredMarketplaceManifest(parsed);
      if (options.persist) {
        const activation = await stageMarketplaceDirectoryPlugins(
          source.path,
          storageRoot,
          manifest.name,
          manifest.raw,
          options.signal,
        );
        await activation.finalize();
      }
      return { manifest, sourceRoot: source.path };
    }
    case "url": {
      const parsed = await requestMarketplaceJson(source.url, source.headers, options.signal);
      return { manifest: parseRequiredMarketplaceManifest(parsed) };
    }
    case "github": {
      const resolved = await resolveRepositoryMarketplaceSource(
        `https://github.com/${source.repo}.git`,
        source.ref,
        source.sparsePaths,
        options.signal,
      );
      const cleanup = resolved.cleanup;
      try {
        const file = findMarketplaceManifestPath(resolved.path, source.path);
        if (!file) throw new Error(`Marketplace manifest not found in GitHub repo: ${source.repo}`);
        const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
        const manifest = parseRequiredMarketplaceManifest(parsed);
        if (options.persist) {
          const activation = await stageMarketplaceDirectoryPlugins(
            resolved.path,
            storageRoot,
            manifest.name,
            manifest.raw,
            options.signal,
          );
          await activation.finalize();
        }
        return { cleanup, manifest, sourceRoot: resolved.path };
      } catch (error) {
        const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
        throw appendPluginSourceCleanupError(error, cleanupError);
      }
    }
    case "git": {
      const resolved = await resolveRepositoryMarketplaceSource(
        source.url,
        source.ref,
        source.sparsePaths,
        options.signal,
      );
      const cleanup = resolved.cleanup;
      try {
        const file = findMarketplaceManifestPath(resolved.path, source.path);
        if (!file) throw new Error(`Marketplace manifest not found in git repo: ${source.url}`);
        const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
        const manifest = parseRequiredMarketplaceManifest(parsed);
        if (options.persist) {
          const activation = await stageMarketplaceDirectoryPlugins(
            resolved.path,
            storageRoot,
            manifest.name,
            manifest.raw,
            options.signal,
          );
          await activation.finalize();
        }
        return { cleanup, manifest, sourceRoot: resolved.path };
      } catch (error) {
        const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
        throw appendPluginSourceCleanupError(error, cleanupError);
      }
    }
    case "npm":
      throw new UnsupportedMarketplaceSourceError("npm");
    case "hostPattern":
      throw new UnsupportedMarketplaceSourceError("hostPattern");
    case "pathPattern":
      throw new UnsupportedMarketplaceSourceError("pathPattern");
  }
}

async function resolveRepositoryMarketplaceSource(
  url: string,
  ref: string | undefined,
  sparsePaths: string[] | undefined,
  signal?: AbortSignal,
): Promise<ResolvedPluginSourceRoot> {
  // sparsePaths 是既有 MarketplaceSource 契约。Archive 需要先下载整仓，
  // 会让原本能 sparse clone 的大仓库因下载上限失败；在 Archive 尚未实现等价投影前，
  // 显式保留系统 Git 的 sparse checkout 路由。
  if (!sparsePaths?.length) {
    try {
      return await resolveGitHubArchiveSource({ pin: ref, signal, url });
    } catch (error) {
      if (!shouldFallbackGitHubArchiveToGit(error)) {
        throw createArchiveFetchError(url, error);
      }
    }
  }
  const dir = await cloneMarketplaceSource(url, ref, sparsePaths, signal);
  return {
    cleanup: async () => {
      await rm(dir, { force: true, recursive: true });
    },
    path: dir,
  };
}

async function cloneMarketplaceSource(
  url: string,
  ref: string | undefined,
  sparsePaths: string[] | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-marketplace-src-"));
  const args = ["clone", "--depth", "1"];
  if (ref) args.push("--branch", ref);
  if (sparsePaths?.length) args.push("--filter=blob:none", "--sparse");
  args.push(url, dir);
  try {
    await execGitCloneWithRetry(args, dir, signal);
    if (sparsePaths?.length) {
      await execGitCommand(["-C", dir, "sparse-checkout", "set", ...sparsePaths], signal);
    }
    return dir;
  } catch (error) {
    await rm(dir, { force: true, recursive: true });
    throw error;
  }
}

async function execGitCloneWithRetry(
  args: string[],
  targetDir: string,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GIT_CLONE_MAX_ATTEMPTS; attempt += 1) {
    try {
      throwIfPluginOperationAborted(signal);
      if (attempt > 1) {
        await rm(targetDir, { force: true, recursive: true });
        await mkdir(targetDir, { recursive: true });
      }
      await execGitCommand(args, signal);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= GIT_CLONE_MAX_ATTEMPTS || !isRetryableGitCloneError(error)) {
        throw error;
      }
      // GitHub 偶发 RPC/recv timeout 会让官方 marketplace add 失败。
      // 仅对明确的网络型 clone 错误做短重试，避免掩盖权限、路径或仓库不存在等确定性错误。
      await delay(GIT_CLONE_RETRY_DELAY_MS * attempt, signal);
    }
  }
  throw lastError;
}

async function execGitCommand(args: string[], signal?: AbortSignal): Promise<void> {
  throwIfPluginOperationAborted(signal);
  try {
    // 显式二进制覆盖既支持非标准 Git 安装位置，也让跨进程 E2E 能把 Git 指向不存在的
    // 绝对路径，真实证明 Archive 主链路不依赖开发机上偶然存在的 Git。
    const gitBinary = process.env.ZCODE_GIT_BINARY?.trim() || "git";
    await execFileAsync(gitBinary, args, {
      env: buildMarketplaceGitEnv(),
      killSignal: "SIGTERM",
      maxBuffer: 1024 * 1024 * 10,
      signal,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    if (isCommandUnavailableError(error)) {
      const source = args.find(
        (arg) => arg.includes("://") || arg.startsWith("git@") || arg.startsWith("git+"),
      );
      throw createGitUnavailableError(source ?? args.at(-1) ?? "Git operation");
    }
    throw error;
  }
  throwIfPluginOperationAborted(signal);
}

function isRetryableGitCloneError(error: unknown): boolean {
  const output = getErrorOutput(error);
  return /RPC failed|Operation timed out|Recv failure|expected flush|early EOF|remote end hung up|HTTP\/2 stream|Connection reset|ETIMEDOUT|ECONNRESET|network timeout/iu.test(
    output,
  );
}

function getErrorOutput(error: unknown): string {
  if (!isRecord(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  const chunks = [
    error instanceof Error ? error.message : "",
    typeof error.stdout === "string" ? error.stdout : "",
    typeof error.stderr === "string" ? error.stderr : "",
  ];
  return chunks.filter(Boolean).join("\n");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal?.aborted) {
      rejectDelay(createPluginOperationCancelledError());
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleAbort = (): void => {
      cleanup();
      rejectDelay(createPluginOperationCancelledError());
    };
    timeout = setTimeout(() => {
      cleanup();
      resolveDelay();
    }, ms);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function stageMarketplaceDirectoryPlugins(
  sourceDir: string,
  storageRoot: string,
  marketplace: string,
  manifest: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AtomicDirectoryActivation> {
  throwIfPluginOperationAborted(signal);
  const targetDir = dirname(getMarketplaceManifestPath(storageRoot, marketplace));
  return activateDirectoryAtomically({
    authorityPath: join(storageRoot, KNOWN_MARKETPLACES_FILE),
    prepare: async (stagedPath) => {
      await writeJsonFile(join(stagedPath, MARKETPLACE_FILE), manifest);
    },
    signal,
    sourcePath: sourceDir,
    targetPath: targetDir,
  });
}

async function stageMarketplaceManifest(
  storageRoot: string,
  marketplace: string,
  manifest: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AtomicDirectoryActivation> {
  const targetDir = dirname(getMarketplaceManifestPath(storageRoot, marketplace));
  // URL/settings source 没有 sourceRoot；直接覆盖 manifest 时若写入期间
  // deadline 到达或 known state 落盘失败就无法回滚。prepare-only activation 让 manifest
  // 与 known_marketplaces.json 使用同一个 transactionId 提交，失败时继续读取上一代快照。
  return activateDirectoryAtomically({
    authorityPath: join(storageRoot, KNOWN_MARKETPLACES_FILE),
    prepare: async (stagedPath) => {
      await writeJsonFile(join(stagedPath, MARKETPLACE_FILE), manifest);
    },
    signal,
    targetPath: targetDir,
  });
}

async function writeMarketplaceManifest(
  storageRoot: string,
  marketplace: string,
  raw: Record<string, unknown>,
): Promise<void> {
  await writeJsonFile(getMarketplaceManifestPath(storageRoot, marketplace), raw);
}

async function upsertKnownMarketplace(
  storageRoot: string,
  record: KnownMarketplaceRecord,
): Promise<KnownMarketplaceActivation> {
  const known = loadKnownMarketplacesSync(storageRoot);
  const index = known.findIndex((item) => item.id === record.id);
  const previous = index >= 0 ? known[index] : undefined;
  if (index >= 0) {
    const {
      cacheTransactionId: _previousCacheTransactionId,
      lastRefreshFailure: _lastRefreshFailure,
      ...successfulPrevious
    } = previous ?? record;
    known[index] = {
      ...successfulPrevious,
      ...record,
      addedAt: previous?.addedAt ?? record.addedAt,
    };
  } else {
    known.push(record);
  }
  await writeKnownMarketplaces(storageRoot, known);
  let settled = false;
  return {
    finalize: () => {
      settled = true;
    },
    rollback: async () => {
      if (settled) return;
      const current = loadKnownMarketplacesSync(storageRoot);
      const currentIndex = current.findIndex((item) => item.id === record.id);
      const currentRecord = currentIndex >= 0 ? current[currentIndex] : undefined;
      if (
        !currentRecord ||
        currentRecord.lastUpdated !== record.lastUpdated ||
        currentRecord.cacheTransactionId !== record.cacheTransactionId
      ) {
        throw new Error(
          `Cannot roll back marketplace authority after concurrent update: ${record.id}`,
        );
      }
      if (previous) {
        current[currentIndex] = previous;
      } else {
        current.splice(currentIndex, 1);
      }
      await writeKnownMarketplaces(storageRoot, current);
      settled = true;
    },
  };
}

async function persistMarketplaceRefreshFailure(
  storageRoot: string,
  marketplace: string,
  failure: MarketplaceRefreshFailure,
): Promise<void> {
  const known = loadKnownMarketplacesSync(storageRoot);
  const index = known.findIndex((record) => record.id === marketplace);
  if (index < 0 || !known[index]) return;
  known[index] = { ...known[index], lastRefreshFailure: failure };
  await writeKnownMarketplaces(storageRoot, known);
}

async function writeKnownMarketplaces(
  storageRoot: string,
  marketplaces: KnownMarketplaceRecord[],
): Promise<void> {
  await writeJsonFile(join(storageRoot, KNOWN_MARKETPLACES_FILE), {
    version: 1,
    marketplaces,
  });
}

function defaultMarketplaceSourceFromString(source: string): MarketplaceSource {
  const trimmed = source.trim();
  if (/^[^/]+\/[^/]+(?:[#@].+)?$/u.test(trimmed) && !trimmed.includes(":")) {
    const { ref, url } = splitGitHubShorthand(trimmed);
    return ref ? { source: "github", repo: url, ref } : { source: "github", repo: url };
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return { source: "url", url: trimmed };
  }
  return { source: "url", url: trimmed };
}

function normalizeInstalledPluginsState(value: unknown): InstalledPluginsState {
  if (!isRecord(value)) return { version: 1, plugins: [] };
  const rawPlugins = value.plugins;
  if (isRecord(rawPlugins)) {
    return {
      version: 1,
      plugins: Object.entries(rawPlugins).flatMap(([pluginId, entry]) =>
        normalizeInstalledPluginRecordFromMap(pluginId, entry),
      ),
    };
  }
  const plugins = Array.isArray(rawPlugins) ? rawPlugins : [];
  return {
    version: 1,
    plugins: plugins.filter(isInstalledPluginRecord),
  };
}

function normalizeInstalledPluginRecordFromMap(
  pluginId: string,
  entry: unknown,
): InstalledPluginRecord[] {
  const entries = Array.isArray(entry) ? entry : [entry];
  return entries.flatMap((item): InstalledPluginRecord[] => {
    if (!isRecord(item)) return [];
    const installPath = typeof item.installPath === "string" ? item.installPath : "";
    if (!installPath) return [];
    let parsed: { marketplace: string; name: string };
    try {
      parsed = parsePluginId(pluginId);
    } catch {
      return [];
    }
    const scope = item.scope === "project" || item.scope === "local" ? "workspace" : "user";
    return [
      {
        id: pluginId,
        name: parsed.name,
        marketplace: parsed.marketplace,
        version: typeof item.version === "string" ? item.version : DEFAULT_VERSION,
        installPath,
        installedAt:
          typeof item.installedAt === "string" ? item.installedAt : new Date(0).toISOString(),
        ...(typeof item.lastUpdated === "string" ? { updatedAt: item.lastUpdated } : {}),
        scope,
      },
    ];
  });
}

function parseRequiredMarketplaceManifest(value: unknown): PluginMarketplaceManifest {
  const parsed = parseMarketplaceManifest(value);
  if (!parsed) throw new Error("Marketplace manifest is invalid");
  return parsed;
}

function parseMarketplaceManifest(value: unknown): PluginMarketplaceManifest | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!MARKETPLACE_NAME_PATTERN.test(name)) return null;
  const rawPlugins = value.plugins;
  const pluginEntries = Array.isArray(rawPlugins)
    ? rawPlugins
    : isRecord(rawPlugins)
      ? Object.entries(rawPlugins).map(([pluginName, plugin]) =>
          isRecord(plugin) ? { name: pluginName, ...plugin } : { name: pluginName },
        )
      : [];
  return normalizeMarketplaceManifest({
    ...value,
    name,
    plugins: pluginEntries,
  });
}

function normalizeMarketplaceManifest(
  value: PluginMarketplaceManifest | Record<string, unknown>,
): PluginMarketplaceManifest {
  if (isPluginMarketplaceManifest(value)) return value;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const plugins = Array.isArray(value.plugins)
    ? value.plugins
        .filter(isRecord)
        .map((entry): PluginMarketplaceEntry | null => {
          const name = typeof entry.name === "string" ? entry.name.trim() : "";
          if (name.length === 0) return null;
          const dependencies = Array.isArray(entry.dependencies)
            ? entry.dependencies
                .map(normalizeDependencyRef)
                .filter((item): item is string => item !== null)
            : undefined;
          const tags = Array.isArray(entry.tags)
            ? entry.tags.filter((item): item is string => typeof item === "string")
            : undefined;
          const listing = parseEntryStoreListing(entry);
          return {
            name,
            ...(typeof entry.category === "string" ? { category: entry.category } : {}),
            ...(typeof entry.description === "string" ? { description: entry.description } : {}),
            ...(typeof entry.version === "string" ? { version: entry.version } : {}),
            ...(entry.source !== undefined ? { source: entry.source } : {}),
            ...(typeof entry.cachePath === "string" ? { cachePath: entry.cachePath } : {}),
            ...(dependencies ? { dependencies } : {}),
            ...(typeof entry.strict === "boolean" ? { strict: entry.strict } : {}),
            ...(tags ? { tags } : {}),
            ...(listing ? { listing } : {}),
            raw: entry,
          };
        })
        .filter((entry): entry is PluginMarketplaceEntry => entry !== null)
    : [];
  const allowCrossMarketplaceDependenciesOn = Array.isArray(
    value.allowCrossMarketplaceDependenciesOn,
  )
    ? value.allowCrossMarketplaceDependenciesOn.filter(
        (item): item is string => typeof item === "string",
      )
    : undefined;
  // 目录顶层的 Featured 策展名单：仅接受非空字符串数组，去掉空白项。
  const featured = Array.isArray(value.featured)
    ? value.featured.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : undefined;
  return {
    name: String(value.name),
    ...(typeof value.description === "string"
      ? { description: value.description }
      : typeof metadata.description === "string"
        ? { description: metadata.description }
        : {}),
    plugins,
    ...(allowCrossMarketplaceDependenciesOn ? { allowCrossMarketplaceDependenciesOn } : {}),
    ...(typeof metadata.pluginRoot === "string" ? { pluginRoot: metadata.pluginRoot } : {}),
    ...(featured && featured.length > 0 ? { featured } : {}),
    raw: value,
  };
}

/**
 * 从目录条目解析可选的商店展示信息。兼容字符串或对象形式的 author、i18n map 和多值字段；
 * 解析不到有效内容时返回 undefined，避免给每个条目挂空对象。
 */
export function parseEntryStoreListing(
  entry: Record<string, unknown>,
): PluginStoreListing | undefined {
  const readString = (key: string): string | undefined => {
    const value = entry[key];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  };
  const readStringMap = (key: string): Record<string, string> | undefined => {
    const value = entry[key];
    if (!isRecord(value)) return undefined;
    const map: Record<string, string> = {};
    for (const [locale, text] of Object.entries(value)) {
      if (typeof text === "string") map[locale] = text;
    }
    return Object.keys(map).length > 0 ? map : undefined;
  };
  const readStringListMap = (key: string): Record<string, string[]> | undefined => {
    const value = entry[key];
    if (!isRecord(value)) return undefined;
    const map: Record<string, string[]> = {};
    for (const [locale, list] of Object.entries(value)) {
      if (!Array.isArray(list)) continue;
      const items = list.filter((item): item is string => typeof item === "string");
      if (items.length > 0) map[locale] = items;
    }
    return Object.keys(map).length > 0 ? map : undefined;
  };

  const listing: PluginStoreListing = {};
  if (entry.publisherType === "official" || entry.publisherType === "community") {
    listing.publisherType = entry.publisherType;
  }
  const displayName = readString("displayName");
  if (displayName) listing.displayName = displayName;
  const displayNameI18n = readStringMap("displayName_i18n");
  if (displayNameI18n) listing.displayNameI18n = displayNameI18n;
  const descriptionI18n = readStringMap("description_i18n");
  if (descriptionI18n) listing.descriptionI18n = descriptionI18n;
  for (const key of [
    "icon",
    "category",
    "homepage",
    "privacyPolicy",
    "termsOfService",
    "heroImage",
  ] as const) {
    const value = readString(key);
    if (value) listing[key] = value;
  }
  const author = normalizeAuthorValue(entry.author);
  if (author?.name) listing.author = author.name;
  if (author?.url) listing.authorUrl = author.url;
  const examplePrompts = Array.isArray(entry.examplePrompts)
    ? entry.examplePrompts.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : undefined;
  if (examplePrompts && examplePrompts.length > 0) listing.examplePrompts = examplePrompts;
  const examplePromptsI18n = readStringListMap("examplePrompts_i18n");
  if (examplePromptsI18n) listing.examplePromptsI18n = examplePromptsI18n;
  // 付费套餐提示只认显式布尔 true；字符串 "true"、1 等歧义写法一律按无需套餐处理，
  // 避免目录写错就给免费插件挂上付费提示。
  if (entry.requiresPaidPlan === true) listing.requiresPaidPlan = true;
  return Object.keys(listing).length > 0 ? listing : undefined;
}

/** 目录条目的扩展摘要（docs/plugins/plugin-publishing.md §4.2）。CLI 只透传，不判断兼容。 */
export interface PluginExtensionSummary {
  engines: { zcode: string };
  grants: string[];
}

/**
 * 从目录条目读扩展摘要：只认 engines.zcode 是非空字符串的条目，grants 只留字符串，其余键丢掉。
 * 协议字段是 strict 的，丢掉未知键才不会让 App 解析失败。范围格式不检查，由 App 判断。
 */
export function parseEntryExtensionSummary(
  entry: Record<string, unknown>,
): PluginExtensionSummary | undefined {
  const summary = entry.extensionSummary;
  if (!isRecord(summary) || !isRecord(summary.engines)) return undefined;
  const range = summary.engines.zcode;
  if (typeof range !== "string" || range.trim().length === 0) return undefined;
  const grants = Array.isArray(summary.grants)
    ? summary.grants.filter((grant): grant is string => typeof grant === "string")
    : [];
  return { engines: { zcode: range }, grants };
}

/** author 字段兼容 string 与 {name,url}（plugin.json 与目录条目共用此规则）。 */
export function normalizeAuthorValue(value: unknown): { name?: string; url?: string } | undefined {
  if (typeof value === "string") {
    const name = value.trim();
    return name.length > 0 ? { name } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (!name && !url) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(url ? { url } : {}),
  };
}

function normalizeDependencyRef(value: unknown): string | null {
  if (typeof value === "string") return value.replace(/@\^[^@]*$/u, "");
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) return null;
  const marketplace = typeof value.marketplace === "string" ? value.marketplace.trim() : "";
  return marketplace ? `${name}@${marketplace}` : name;
}

function findMarketplaceManifestPath(rootPath: string, explicitPath?: string): string | null {
  const candidates = [
    ...(explicitPath ? [explicitPath] : []),
    CLAUDE_MARKETPLACE_FILE,
    MARKETPLACE_FILE,
  ];
  for (const candidate of candidates) {
    const path = resolveInside(rootPath, candidate);
    if (path && fileExists(path)) return path;
  }
  return null;
}

function findPluginManifestPath(rootPath: string): string | null {
  for (const candidate of [ZCODE_MANIFEST_PATH, CLAUDE_MANIFEST_PATH, CODEX_MANIFEST_PATH]) {
    const path = join(rootPath, candidate);
    if (fileExists(path)) return path;
  }
  return null;
}

// 缓存路径段与安装记录的版本来源。优先取插件落盘 plugin.json 里的真实
// version（与加载器 readPluginManifestFromRoot/index.ts 展示版本同源），缺失时才回退到 marketplace
// 条目的 version，最后兜底 DEFAULT_VERSION。读取失败保持宽松回退，校验交给 validateMarketplacePlugin。
function resolveInstalledPluginVersion(rootPath: string, entry: PluginMarketplaceEntry): string {
  const manifestPath = findPluginManifestPath(rootPath);
  if (manifestPath) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
      if (
        isRecord(parsed) &&
        typeof parsed.version === "string" &&
        parsed.version.trim().length > 0
      ) {
        return parsed.version;
      }
    } catch {
      // 落到下方回退：manifest 不可读/非法时不应中断安装，版本以条目或默认值兜底。
    }
  }
  return entry.version ?? DEFAULT_VERSION;
}

function readPluginManifestFromRoot(
  rootPath: string,
  entry: PluginMarketplaceEntry,
): { manifest: PluginManifest; manifestPath?: string } | null {
  const manifestPath = findPluginManifestPath(rootPath);
  if (manifestPath) {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("Plugin manifest must be a JSON object");
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!PLUGIN_NAME_PATTERN.test(name)) throw new Error(`Invalid plugin name: ${name}`);
    return {
      manifest: {
        ...parsed,
        name,
        version: typeof parsed.version === "string" ? parsed.version : DEFAULT_VERSION,
      } as PluginManifest,
      manifestPath,
    };
  }
  if (entry.strict === false) {
    const rawManifest = createManifestFromMarketplaceEntry(entry);
    return {
      manifest: rawManifest as unknown as PluginManifest,
    };
  }
  return null;
}

async function validatePluginRoot(input: {
  entry: PluginMarketplaceEntry;
  marketplace: string;
  rootPath: string;
  storageRoot: string;
}): Promise<PluginValidationDiagnostic[]> {
  const diagnostics: PluginValidationDiagnostic[] = [];
  const pluginId = `${input.entry.name}@${input.marketplace}`;
  let loadedManifest: { manifest: PluginManifest; manifestPath?: string } | null = null;
  try {
    loadedManifest = readPluginManifestFromRoot(input.rootPath, input.entry);
  } catch (error) {
    diagnostics.push({
      code: "plugin_manifest_invalid",
      message: error instanceof Error ? error.message : String(error),
      path: input.rootPath,
      pluginId,
      severity: "error",
    });
    return diagnostics;
  }

  if (!loadedManifest) {
    diagnostics.push({
      code: "plugin_manifest_not_found",
      message: `Plugin manifest not found: ${pluginId}`,
      path: input.rootPath,
      pluginId,
      severity: "error",
    });
    return diagnostics;
  }

  const manifestPath = loadedManifest.manifestPath ?? input.rootPath;
  if (loadedManifest.manifest.name !== input.entry.name) {
    diagnostics.push({
      code: "plugin_manifest_invalid",
      message: `Plugin manifest name '${loadedManifest.manifest.name}' does not match marketplace entry '${input.entry.name}'`,
      path: manifestPath,
      pluginId,
      severity: "error",
    });
  }
  pushManifestCompatibilityDiagnostics({
    diagnostics,
    manifest: loadedManifest.manifest,
    manifestPath,
    pluginId,
    source: "cache",
  });
  await pushMcpValidationDiagnostics({
    diagnostics,
    manifest: loadedManifest.manifest,
    manifestPath,
    marketplace: input.marketplace,
    pluginId,
    rootPath: input.rootPath,
    storageRoot: input.storageRoot,
  });
  return diagnostics;
}

function pushManifestCompatibilityDiagnostics(input: {
  diagnostics: PluginValidationDiagnostic[];
  manifest: PluginManifest;
  manifestPath: string;
  pluginId: string;
  source: "cache" | "inline" | "official";
}): void {
  for (const key of UNSUPPORTED_MANIFEST_FIELDS) {
    if (key in input.manifest) {
      input.diagnostics.push({
        code: "plugin_unsupported_component",
        message: `Plugin component is diagnostic-only in this ZCode runtime: ${key}`,
        path: input.manifestPath,
        pluginId: input.pluginId,
        severity: "warning",
      });
    }
  }
  for (const [key, option] of Object.entries(input.manifest.userConfig ?? {})) {
    if (option.required === true && option.default === undefined) {
      input.diagnostics.push({
        code: "plugin_variable_missing",
        message: `Required plugin userConfig has no default and must be configured: ${key}`,
        path: input.manifestPath,
        pluginId: input.pluginId,
        severity: "warning",
      });
    }
  }
  if (containsMcpBundleSource(input.manifest.mcpServers)) {
    input.diagnostics.push({
      code: "plugin_marketplace_source_unsupported",
      message: "MCPB/DXT plugin bundles are recognized but not supported in this runtime",
      path: input.manifestPath,
      pluginId: input.pluginId,
      severity: "warning",
    });
  }
}

async function pushMcpValidationDiagnostics(input: {
  diagnostics: PluginValidationDiagnostic[];
  manifest: PluginManifest;
  manifestPath: string;
  marketplace: string;
  pluginId: string;
  rootPath: string;
  storageRoot: string;
}): Promise<void> {
  const diagnostics = input.diagnostics as PluginDiagnostic[];
  const loaded = {
    id: input.pluginId,
    manifest: input.manifest,
    manifestPath: input.manifestPath,
    marketplace: input.marketplace,
    rootPath: input.rootPath,
    source: "cache" as const,
  };
  const definitions = await loadPluginMcpServerDefinitions({ diagnostics, loaded });
  resolvePluginMcpServers({
    dataPath: join(input.storageRoot, "data", sanitizePluginId(input.pluginId)),
    definitions,
    diagnostics,
    env: {},
    loaded,
    options: {},
    workingDirectory: process.cwd(),
  });
}

function containsMcpBundleSource(value: unknown): boolean {
  if (typeof value === "string") return value.endsWith(".mcpb") || value.endsWith(".dxt");
  if (Array.isArray(value)) return value.some(containsMcpBundleSource);
  return false;
}

function validateMarketplaceEntryShape(
  entry: PluginMarketplaceEntry,
  marketplace: string,
  options: { includeEntryCompatibility?: boolean } = {},
): PluginValidationDiagnostic[] {
  const diagnostics: PluginValidationDiagnostic[] = [];
  const pluginId = `${entry.name}@${marketplace}`;
  if (entry.source === undefined) {
    diagnostics.push({
      code: "plugin_marketplace_invalid",
      message: `Plugin has no install source: ${pluginId}`,
      pluginId,
      severity: "error",
    });
  }
  if (isRecord(entry.source)) {
    const sourceKind = typeof entry.source.source === "string" ? entry.source.source : "";
    if (sourceKind === "npm" || sourceKind === "pip") {
      diagnostics.push({
        code: "plugin_marketplace_source_unsupported",
        message: `Plugin source is recognized but not supported in V1 install: ${sourceKind}`,
        pluginId,
        severity: "warning",
      });
    }
    if (sourceKind === "url") {
      const sourceType = typeof entry.source.type === "string" ? entry.source.type : "";
      if (sourceType && sourceType !== "git" && sourceType !== "zip") {
        diagnostics.push({
          code: "plugin_marketplace_source_unsupported",
          message: `Plugin URL source type is not supported: ${sourceType}`,
          pluginId,
          severity: "error",
        });
      }
      try {
        readRequiredPluginSourceString(entry.source, "url", "URL");
        if (sourceType === "zip") {
          const sha256 = readRequiredZipPluginSourceSha256(entry.source).toLowerCase();
          if (!SOURCE_SHA256_PATTERN.test(sha256)) {
            throw new Error("Plugin zip source sha256 must be a 64 character hex string");
          }
          readPluginSourceHeaders(entry.source);
          readOptionalZipPluginSourcePath(entry.source);
          readOptionalZipPluginSourceStripRoot(entry.source);
        }
      } catch (error) {
        diagnostics.push({
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          pluginId,
          severity: "error",
        });
      }
    }
  }
  if (options.includeEntryCompatibility !== false) {
    pushEntryCompatibilityDiagnostics({ diagnostics, entry, marketplace });
  }
  return diagnostics;
}

function pushEntryCompatibilityDiagnostics(input: {
  diagnostics: PluginValidationDiagnostic[];
  entry: PluginMarketplaceEntry;
  marketplace: string;
}): void {
  const pluginId = `${input.entry.name}@${input.marketplace}`;
  pushManifestCompatibilityDiagnostics({
    diagnostics: input.diagnostics,
    manifest: createManifestFromMarketplaceEntry(input.entry) as unknown as PluginManifest,
    manifestPath: pluginId,
    pluginId,
    source: "cache",
  });
}

function getMarketplaceSourceValidationDeferral(
  entry: PluginMarketplaceEntry,
  marketplace: string,
): PluginValidationDiagnostic | null {
  if (!isRecord(entry.source)) return null;
  const sourceKind = typeof entry.source.source === "string" ? entry.source.source : "";
  if (sourceKind === "url") {
    const sourceType = typeof entry.source.type === "string" ? entry.source.type : "";
    if (sourceType && sourceType !== "git" && sourceType !== "zip") return null;
  }
  if (!["github", "git", "url", "git-subdir"].includes(sourceKind)) return null;
  const pluginId = `${entry.name}@${marketplace}`;
  const sourceLabel =
    typeof entry.source.repo === "string"
      ? entry.source.repo
      : typeof entry.source.url === "string"
        ? entry.source.url
        : sourceKind;
  return {
    code: "plugin_validation_deferred",

    // 聚合市场可能包含大量外部 git source；市场级 validate 不逐个 clone，单插件安装或校验时
    // 再深扫目标 root，避免设置页被网络操作拖到协议超时。
    message: `Remote plugin source validation is deferred until install or single-plugin validate: ${sourceLabel}`,
    pluginId,
    severity: "warning",
  };
}

function pushDependencyDiagnosticsFromManifest(input: {
  diagnostics: PluginValidationDiagnostic[];
  manifest: PluginMarketplaceManifest;
  marketplace: string;
  name: string;
  storageRoot: string;
}): void {
  try {
    resolveDependencyClosureFromManifest({
      allowCrossMarketplaces: new Set(input.manifest.allowCrossMarketplaceDependenciesOn ?? []),
      marketplace: input.marketplace,
      manifest: input.manifest,
      name: input.name,
      storageRoot: input.storageRoot,
    });
  } catch (error) {
    input.diagnostics.push(toValidationDiagnostic(error, `${input.name}@${input.marketplace}`));
  }
}

function resolveDependencyClosureFromManifest(input: {
  allowCrossMarketplaces: ReadonlySet<string>;
  marketplace: string;
  manifest: PluginMarketplaceManifest;
  name: string;
  storageRoot: string;
}): string[] {
  const rootId = `${input.name}@${input.marketplace}`;
  const closure: string[] = [];
  const visiting: string[] = [];
  const visited = new Set<string>();

  const loadManifest = (marketplace: string): PluginMarketplaceManifest | null =>
    marketplace === input.marketplace
      ? input.manifest
      : loadMarketplaceManifestSync(input.storageRoot, marketplace);

  const walk = (pluginId: string, requiredBy: string): void => {
    const { marketplace, name } = parsePluginId(pluginId);
    if (marketplace !== input.marketplace && !input.allowCrossMarketplaces.has(marketplace)) {
      throw new Error(
        `Cross-marketplace dependency is blocked: ${pluginId} required by ${requiredBy}`,
      );
    }
    if (visiting.includes(pluginId)) {
      throw new Error(`Plugin dependency cycle: ${[...visiting, pluginId].join(" -> ")}`);
    }
    if (visited.has(pluginId)) return;

    const manifest = loadManifest(marketplace);
    if (!manifest) throw new Error(`Marketplace not found for dependency: ${marketplace}`);
    const entry = manifest.plugins.find((plugin) => plugin.name === name);
    if (!entry) throw new Error(`Dependency not found: ${pluginId} required by ${requiredBy}`);

    visiting.push(pluginId);
    for (const dependency of entry.dependencies ?? []) {
      walk(qualifyDependency(dependency, marketplace), pluginId);
    }
    visiting.pop();
    visited.add(pluginId);
    closure.push(pluginId);
  };

  walk(rootId, rootId);
  return closure;
}

function pushDependencyDiagnostics(input: {
  diagnostics: PluginValidationDiagnostic[];
  marketplace: string;
  name: string;
  storageRoot: string;
}): void {
  try {
    const rootManifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
    resolveDependencyClosure({
      allowCrossMarketplaces: new Set(rootManifest?.allowCrossMarketplaceDependenciesOn ?? []),
      marketplace: input.marketplace,
      name: input.name,
      storageRoot: input.storageRoot,
    });
  } catch (error) {
    input.diagnostics.push(toValidationDiagnostic(error, `${input.name}@${input.marketplace}`));
  }
}

function toValidationDiagnostic(error: unknown, pluginId?: string): PluginValidationDiagnostic {
  if (
    error instanceof UnsupportedMarketplaceSourceError ||
    error instanceof UnsupportedPluginSourceError
  ) {
    return {
      code: "plugin_marketplace_source_unsupported",
      message: error.message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  const sourceCode = getPluginSourceDiagnosticCode(error);
  if (sourceCode) {
    return {
      code: sourceCode,
      message: error instanceof Error ? error.message : String(error),
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Cross-marketplace dependency")) {
    return {
      code: "plugin_dependency_cross_marketplace",
      message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  if (message.includes("dependency cycle")) {
    return {
      code: "plugin_dependency_cycle",
      message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  if (
    message.includes("Dependency not found") ||
    message.includes("Marketplace not found for dependency")
  ) {
    return {
      code: "plugin_dependency_missing",
      message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  return {
    code: "plugin_marketplace_invalid",
    message,
    ...(pluginId ? { pluginId } : {}),
    severity: "error",
  };
}

class UnsupportedMarketplaceSourceError extends Error {
  constructor(source: string) {
    super(`Marketplace source is recognized but not supported in this runtime: ${source}`);
  }
}

class UnsupportedPluginSourceError extends Error {
  constructor(source: string) {
    super(`Plugin source is recognized but not supported in this runtime: ${source}`);
  }
}

function isPluginMarketplaceManifest(value: unknown): value is PluginMarketplaceManifest {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    Array.isArray(value.plugins) &&
    isRecord(value.raw)
  );
}

function readJsonFileSync(path: string): unknown {
  const readablePath = recoverAtomicTargetSync(path);
  try {
    return JSON.parse(readFileSync(readablePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

function getPluginCacheDir(
  storageRoot: string,
  marketplace: string,
  name: string,
  version: string,
): string {
  return join(
    storageRoot,
    "cache",
    sanitizePluginId(marketplace),
    sanitizePluginId(name),
    sanitizePluginId(version),
  );
}

export function getPluginDataDir(storageRoot: string, pluginId: string): string {
  // 与 NodePluginAdapter.discoverPlugins 的 dataPath 解析保持一致：<storageRoot>/data/<sanitized-id>。
  return join(storageRoot, "data", sanitizePluginId(pluginId));
}

function isKnownMarketplaceRecord(value: unknown): value is KnownMarketplaceRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.pluginCount === "number" &&
    isRecord(value.source)
  );
}

function isInstalledPluginRecord(value: unknown): value is InstalledPluginRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.marketplace === "string" &&
    typeof value.version === "string" &&
    typeof value.installPath === "string" &&
    typeof value.installedAt === "string" &&
    (value.scope === "user" || value.scope === "workspace")
  );
}

function parsePluginId(pluginId: string): { marketplace: string; name: string } {
  const at = pluginId.lastIndexOf("@");
  if (at <= 0 || at === pluginId.length - 1) {
    throw new Error(`Plugin id must use <name>@<marketplace>: ${pluginId}`);
  }
  return {
    name: pluginId.slice(0, at),
    marketplace: pluginId.slice(at + 1),
  };
}

function qualifyDependency(dependency: string, marketplace: string): string {
  return dependency.includes("@") ? dependency : `${dependency}@${marketplace}`;
}

function resolvePathInput(input: string): string | null {
  if (
    input.startsWith("./") ||
    input.startsWith("../") ||
    input.startsWith("/") ||
    input.startsWith("~") ||
    /^[a-zA-Z]:[/\\]/.test(input)
  ) {
    return input.startsWith("~") ? join(process.env.HOME ?? "", input.slice(1)) : resolve(input);
  }
  return null;
}

function splitRef(input: string): { ref?: string; url: string } {
  const index = input.lastIndexOf("#");
  if (index < 0) return { url: input };
  return { url: input.slice(0, index), ref: input.slice(index + 1) };
}

function splitGitHubShorthand(input: string): { ref?: string; url: string } {
  const hash = input.lastIndexOf("#");
  const at = input.lastIndexOf("@");
  const index = Math.max(hash, at);
  if (index <= 0) return { url: input };
  return { url: input.slice(0, index), ref: input.slice(index + 1) };
}

function isGitSshUrl(input: string): boolean {
  return /^[a-zA-Z0-9._-]+@[^:]+:.+/.test(input);
}

function tryParseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

export async function listInstalledPluginRecordsAsync(
  storageRoot: string,
): Promise<InstalledPluginRecord[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readStandaloneAtomicFile(join(storageRoot, INSTALLED_PLUGINS_FILE)));
  } catch {
    parsed = undefined;
  }
  return normalizeInstalledPluginsState(parsed).plugins;
}
