// File Config Adapter - Load and patch JSON configuration files

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { RuntimeConfigPatch, UiLocale } from "@zcode/contracts";
import { z } from "zod";
import { withFileLock } from "@zcode/shared/node";
import {
  CANONICAL_CUA_PLUGIN_ID,
  canonicalizePluginId,
  LEGACY_CUA_PLUGIN_ID,
  parseConfigFileToRuntimePatchWithDiagnostics,
  pluginIdAliases,
  type ConfigDiagnostic,
} from "./schema.js";

interface FileConfigOptions {
  baseDir?: string;
  configFileName?: string;
  scope?: "user" | "project";
}

export interface LoadedConfig {
  config: RuntimeConfigPatch;
  diagnostics: ConfigDiagnostic[];
  path: string;
  loaded: boolean;
  /** 已读取的旧开关需要异步迁移；只在加载快照中传递，不写入配置。 */
  pendingVisualizeMigration?: boolean;
}

export interface UiLocalePatchResult {
  locale: UiLocale;
  path: string;
}

export interface PluginEnabledPatchResult {
  enabled: boolean;
  path: string;
  pluginId: string;
}

export interface PluginOptionsPatchResult {
  clearedOptionKeys: string[];
  options: Record<string, string | number | boolean>;
  path: string;
  pluginId: string;
}

export interface PluginRemovePatchResult {
  path: string;
  pluginId: string;
  removedEnabled: boolean;
  removedOptions: boolean;
}

export const VISUALIZE_PLUGIN_ID = "visualize@zcode-plugins-official";
const VISUALIZE_MIGRATION_KEY = "visualizeDefaultOffMigrated";

const DEFAULT_CONFIG_FILE = "config.json";
const DEFAULT_BASE_DIR = "~/.zcode/cli";

/**
 * Resolve path with ~ expansion
 */
export function resolvePath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}

/**
 * Load configuration from a JSON file
 */
export function loadFileConfig(filePath?: string, options: FileConfigOptions = {}): LoadedConfig {
  const resolvedPath = filePath
    ? resolvePath(filePath)
    : join(
        resolvePath(options.baseDir ?? DEFAULT_BASE_DIR),
        options.configFileName ?? DEFAULT_CONFIG_FILE,
      );

  if (!existsSync(resolvedPath)) {
    return {
      config: {},
      diagnostics: [],
      path: resolvedPath,
      loaded: false,
    };
  }

  try {
    const content = readFileSync(resolvedPath, "utf-8");
    const parsed = JSON.parse(content);
    const migrated = migratePluginConfigInFile(parsed);
    if (migrated) {
      // 仅装载态归一化会让旧 key 永久留在磁盘，后续版本无法安全删除迁移逻辑。
      persistPluginConfigMigration(resolvedPath, migrated);
    }
    const result = parseConfigFileToRuntimePatchWithDiagnostics(parsed, options.scope);

    return {
      config: result.config,
      diagnostics: attachDiagnosticFilePath(result.diagnostics, resolvedPath),
      path: resolvedPath,
      loaded: true,
      ...(needsVisualizeMigration(parsed) ? { pendingVisualizeMigration: true } : {}),
    };
  } catch (error) {
    return {
      config: {},
      diagnostics: [createConfigFileInvalidDiagnostic(error, resolvedPath)],
      path: resolvedPath,
      loaded: false,
    };
  }
}

function migratePluginConfigInFile(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.plugins)) return undefined;
  const plugins = value.plugins;
  const nextPlugins = { ...plugins };
  let changed = false;

  if (isRecord(plugins.enabledPlugins)) {
    const enabledPlugins = { ...plugins.enabledPlugins };
    for (const [id, enabled] of Object.entries(plugins.enabledPlugins)) {
      if (id === LEGACY_CUA_PLUGIN_ID) {
        const canonicalId = CANONICAL_CUA_PLUGIN_ID;
        if (enabledPlugins[canonicalId] === undefined) enabledPlugins[canonicalId] = enabled;
        delete enabledPlugins[id];
        changed = true;
      }
    }
    if (changed) nextPlugins.enabledPlugins = enabledPlugins;
  }

  if (Array.isArray(plugins.suppressedBuiltins)) {
    const suppressedBuiltins = plugins.suppressedBuiltins.map((id) =>
      id === LEGACY_CUA_PLUGIN_ID ? CANONICAL_CUA_PLUGIN_ID : id,
    );
    if (JSON.stringify(suppressedBuiltins) !== JSON.stringify(plugins.suppressedBuiltins)) {
      nextPlugins.suppressedBuiltins = suppressedBuiltins;
      changed = true;
    }
  }

  if (isRecord(plugins.options)) {
    const options = { ...plugins.options };
    for (const [id, pluginOptions] of Object.entries(plugins.options)) {
      if (id === LEGACY_CUA_PLUGIN_ID) {
        const canonicalId = CANONICAL_CUA_PLUGIN_ID;
        if (options[canonicalId] === undefined) options[canonicalId] = pluginOptions;
        delete options[id];
        changed = true;
      }
    }
    if (changed) nextPlugins.options = options;
  }

  return changed ? { ...value, plugins: nextPlugins } : undefined;
}

function persistPluginConfigMigration(filePath: string, value: Record<string, unknown>): void {
  const tempPath = `${filePath}.migrate.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(tempPath, filePath);
  } catch {
    // 迁移写回是 best-effort 副作用，失败不能改变合法配置的装载语义。
    try {
      unlinkSync(tempPath);
    } catch {
      // 临时文件清理失败不影响当前配置装载。
    }
  }
}

function needsVisualizeMigration(parsed: unknown): boolean {
  if (!isRecord(parsed) || !isRecord(parsed.plugins)) return false;
  const plugins = parsed.plugins;
  const enabled = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  return (
    plugins[VISUALIZE_MIGRATION_KEY] !== true && typeof enabled[VISUALIZE_PLUGIN_ID] === "boolean"
  );
}

/** 只处理加载时发现的待迁移文件，返回锁内观察到的开关，避免沿用迁移前的旧值。 */
export async function migrateVisualizeDefaultOffInFileConfig(
  filePath: string,
): Promise<boolean | undefined> {
  const resolvedPath = resolvePath(filePath);
  return withFileLock(resolvedPath, async () => {
    // 只锁写入不能防止迟到的启动快照覆盖刚刚重新开启的值，必须在同一文件锁内重读。
    const current = await readJsonConfigFileOrEmpty(resolvedPath);
    if (needsVisualizeMigration(current)) {
      await atomicWriteJson(resolvedPath, patchPluginEnabled(current, VISUALIZE_PLUGIN_ID, false));
      return false;
    }
    const plugins = isRecord(current.plugins) ? current.plugins : {};
    const enabled = isRecord(plugins.enabledPlugins)
      ? plugins.enabledPlugins[VISUALIZE_PLUGIN_ID]
      : undefined;
    return typeof enabled === "boolean" ? enabled : undefined;
  });
}

function createConfigFileInvalidDiagnostic(error: unknown, filePath: string): ConfigDiagnostic {
  return {
    code: "config_file_invalid",
    filePath,
    message:
      error instanceof z.ZodError
        ? formatZodError(error)
        : error instanceof Error
          ? error.message
          : "Unable to parse config file.",
    severity: "error",
  };
}

function attachDiagnosticFilePath(
  diagnostics: ConfigDiagnostic[],
  filePath: string,
): ConfigDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    filePath: diagnostic.filePath ?? filePath,
  }));
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<config>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Patch only the UI locale selection in a JSON config file.
 */
export async function updateUiLocaleInFileConfig(
  filePath: string,
  locale: UiLocale,
): Promise<UiLocalePatchResult> {
  const resolvedPath = resolvePath(filePath);
  return withFileLock(resolvedPath, async () => {
    const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
    const next = patchUiLocale(parsed, locale);

    await atomicWriteJson(resolvedPath, next);
    return {
      locale,
      path: resolvedPath,
    };
  });
}

/**
 * Patch the user plugin enabled map without touching plugin installation state.
 */
export async function updatePluginEnabledInFileConfig(
  filePath: string,
  pluginId: string,
  enabled: boolean,
): Promise<PluginEnabledPatchResult> {
  const resolvedPath = resolvePath(filePath);
  return withFileLock(resolvedPath, async () => {
    const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
    const next = patchPluginEnabled(parsed, pluginId, enabled);

    await atomicWriteJson(resolvedPath, next);
    return {
      enabled,
      path: resolvedPath,
      pluginId,
    };
  });
}

/**
 * Mark freshly installed plugins as enabled by default, in a single atomic write.
 *
 * 设计：安装即默认启用（仅对本次安装的插件 + 其依赖闭包生效）。这里只对**用户配置里尚未显式声明**
 * 的 id 写入 `true`——若用户先前显式停用过（例如停用后重装），尊重其选择不覆盖；已是 true 的也跳过。
 * 一次性读改写，避免逐个 id 反复读写配置文件。返回真正被新置为启用的 id 列表，便于上层据此决定是否回写。
 */
export async function enablePluginsByDefaultInFileConfig(
  filePath: string,
  pluginIds: readonly string[],
): Promise<{ enabledIds: string[]; path: string }> {
  const resolvedPath = resolvePath(filePath);
  return withFileLock(resolvedPath, async () => {
    if (pluginIds.length === 0) {
      return { enabledIds: [], path: resolvedPath };
    }
    const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
    const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
    const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
    const enabledIds = pluginIds.filter(
      (id) => !Object.prototype.hasOwnProperty.call(enabledPlugins, id),
    );
    if (enabledIds.length === 0) {
      return { enabledIds: [], path: resolvedPath };
    }
    const next = {
      ...parsed,
      plugins: {
        ...plugins,
        ...(enabledIds.includes(VISUALIZE_PLUGIN_ID) ? { [VISUALIZE_MIGRATION_KEY]: true } : {}),
        enabledPlugins: {
          ...enabledPlugins,
          ...Object.fromEntries(enabledIds.map((id) => [id, true])),
        },
      },
    };
    await atomicWriteJson(resolvedPath, next);
    return { enabledIds, path: resolvedPath };
  });
}

/**
 * Patch plugin user options without touching plugin installation state.
 */
export async function updatePluginOptionsInFileConfig(
  filePath: string,
  pluginId: string,
  options: Record<string, string | number | boolean>,
  clearOptionKeys: string[] = [],
): Promise<PluginOptionsPatchResult> {
  const resolvedPath = resolvePath(filePath);
  return withFileLock(resolvedPath, async () => {
    const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
    const next = patchPluginOptions(parsed, pluginId, options, clearOptionKeys);

    await atomicWriteJson(resolvedPath, next);
    return {
      clearedOptionKeys: clearOptionKeys,
      options,
      path: resolvedPath,
      pluginId,
    };
  });
}

/**
 * 读取单个配置文件里某个插件的原始选项（不合并其它层）。
 *
 * 敏感选项迁移要知道「这个 scope 的 config.json 里有哪些旧明文值」；合并后的有效配置分不出
 * 值来自哪一层，所以这里直接读目标文件。文件不存在时返回空对象。
 */
export async function readPluginOptionsFromFileConfig(
  filePath: string,
  pluginId: string,
): Promise<Record<string, string | number | boolean>> {
  const parsed = await readJsonConfigFileOrEmpty(resolvePath(filePath));
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const options = isRecord(plugins.options) ? plugins.options : {};
  const canonicalPluginId = canonicalizePluginId(pluginId);
  const aliases = pluginIdAliases(canonicalPluginId);
  const legacyPluginId = aliases.length > 1 ? aliases[1] : undefined;
  const pluginOptions = isRecord(options[canonicalPluginId])
    ? options[canonicalPluginId]
    : legacyPluginId && isRecord(options[legacyPluginId])
      ? options[legacyPluginId]
      : {};
  return Object.fromEntries(
    Object.entries(pluginOptions).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean",
    ),
  );
}

/**
 * Remove a plugin's user config footprint when it is uninstalled.
 *
 * Uninstall is a thorough teardown, so it
 * must drop both the `plugins.enabledPlugins[id]` flag and any saved
 * `plugins.options[id]`. updatePluginEnabledInFileConfig/...Options can only set
 * values; deleting the keys needs its own patch so a reinstall starts clean.
 */
export async function removePluginFromFileConfig(
  filePath: string,
  pluginId: string,
): Promise<PluginRemovePatchResult> {
  const resolvedPath = resolvePath(filePath);
  return withFileLock(resolvedPath, async () => {
    const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
    const { next, removedEnabled, removedOptions } = patchPluginRemoved(parsed, pluginId);

    if (removedEnabled || removedOptions) {
      await atomicWriteJson(resolvedPath, next);
    }
    return {
      path: resolvedPath,
      pluginId,
      removedEnabled,
      removedOptions,
    };
  });
}

/**
 * 只删除 Plugin 的启用覆盖并保留 options。
 *
 * Workspace“恢复继承”是配置视图操作，只应删除 Workspace 的启用覆盖，不能误删
 * 单独保存的 Workspace options 或 secret。
 */
export async function removePluginEnabledFromFileConfig(
  filePath: string,
  pluginId: string,
): Promise<{ path: string; pluginId: string; removedEnabled: boolean }> {
  const resolvedPath = resolvePath(filePath);
  return withFileLock(resolvedPath, async () => {
    const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
    const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
    const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
    const aliases = pluginIdAliases(pluginId);
    const removedEnabled = aliases.some((id) =>
      Object.prototype.hasOwnProperty.call(enabledPlugins, id),
    );
    if (!removedEnabled) {
      return { path: resolvedPath, pluginId, removedEnabled: false };
    }

    const nextEnabled = { ...enabledPlugins };
    for (const id of aliases) delete nextEnabled[id];
    await atomicWriteJson(resolvedPath, {
      ...parsed,
      plugins: {
        ...plugins,
        enabledPlugins: nextEnabled,
      },
    });
    return { path: resolvedPath, pluginId, removedEnabled: true };
  });
}

export interface SuppressedBuiltinPatchResult {
  path: string;
  pluginId: string;
  suppressed: boolean;
}

/**
 * Persist that a built-in (official) plugin is uninstalled, so seeding skips it
 * across restarts and app upgrades. Idempotent. Stored in user config beside
 * enabledPlugins so it survives bundle re-seeds.
 */
export async function addSuppressedBuiltinInFileConfig(
  filePath: string,
  pluginId: string,
): Promise<SuppressedBuiltinPatchResult> {
  const resolvedPath = resolvePath(filePath);
  return withFileLock(resolvedPath, async () => {
    const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
    const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
    const canonicalPluginId = canonicalizePluginId(pluginId);
    const aliases = pluginIdAliases(canonicalPluginId);
    const current = Array.isArray(plugins.suppressedBuiltins)
      ? (plugins.suppressedBuiltins as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const retained = current.filter((id) => !aliases.includes(id));
    if (retained.length === current.length && current.includes(canonicalPluginId)) {
      return { path: resolvedPath, pluginId, suppressed: true };
    }
    const next = {
      ...parsed,
      plugins: { ...plugins, suppressedBuiltins: [...retained, canonicalPluginId] },
    };
    await atomicWriteJson(resolvedPath, next);
    return { path: resolvedPath, pluginId, suppressed: true };
  });
}

/**
 * Reverse of addSuppressedBuiltinInFileConfig: restore a built-in by dropping its
 * suppression marker. The seeder re-materializes it on the next resolve.
 */
export async function removeSuppressedBuiltinInFileConfig(
  filePath: string,
  pluginId: string,
): Promise<SuppressedBuiltinPatchResult> {
  const resolvedPath = resolvePath(filePath);
  return withFileLock(resolvedPath, async () => {
    const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
    const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
    const aliases = pluginIdAliases(pluginId);
    const current = Array.isArray(plugins.suppressedBuiltins)
      ? (plugins.suppressedBuiltins as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const nextSuppressedBuiltins = current.filter((id) => !aliases.includes(id));
    if (nextSuppressedBuiltins.length === current.length) {
      return { path: resolvedPath, pluginId, suppressed: false };
    }
    const next = {
      ...parsed,
      plugins: { ...plugins, suppressedBuiltins: nextSuppressedBuiltins },
    };
    await atomicWriteJson(resolvedPath, next);
    return { path: resolvedPath, pluginId, suppressed: false };
  });
}

/**
 * Get default config file path
 */
export function getDefaultConfigPath(): string {
  return join(resolvePath(DEFAULT_BASE_DIR), DEFAULT_CONFIG_FILE);
}

/**
 * Check if config file exists at default location
 */
export function hasDefaultConfigFile(): boolean {
  return existsSync(getDefaultConfigPath());
}

async function readJsonConfigFile(filePath: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    throw new Error(`Unable to read config file: ${filePath}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Unable to parse config file as JSON: ${filePath}`, { cause: error });
  }

  if (!isRecord(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${filePath}`);
  }

  return parsed;
}

async function readJsonConfigFileOrEmpty(filePath: string): Promise<Record<string, unknown>> {
  try {
    return await readJsonConfigFile(filePath);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (isNodeError(cause) && cause.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function patchUiLocale(parsed: Record<string, unknown>, locale: UiLocale): Record<string, unknown> {
  const currentUi = isRecord(parsed.ui) ? parsed.ui : {};

  return {
    ...parsed,
    ui: {
      ...currentUi,
      locale,
    },
  };
}

function patchPluginEnabled(
  parsed: Record<string, unknown>,
  pluginId: string,
  enabled: boolean,
): Record<string, unknown> {
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  const canonicalPluginId = canonicalizePluginId(pluginId);
  const nextEnabledPlugins = { ...enabledPlugins };
  for (const id of pluginIdAliases(canonicalPluginId)) delete nextEnabledPlugins[id];

  return {
    ...parsed,
    plugins: {
      ...plugins,
      ...(canonicalPluginId === VISUALIZE_PLUGIN_ID ? { [VISUALIZE_MIGRATION_KEY]: true } : {}),
      enabledPlugins: {
        ...nextEnabledPlugins,
        [canonicalPluginId]: enabled,
      },
    },
  };
}

function patchPluginOptions(
  parsed: Record<string, unknown>,
  pluginId: string,
  options: Record<string, string | number | boolean>,
  clearOptionKeys: string[],
): Record<string, unknown> {
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const currentOptions = isRecord(plugins.options) ? plugins.options : {};
  const canonicalPluginId = canonicalizePluginId(pluginId);
  const aliases = pluginIdAliases(canonicalPluginId);
  const legacyPluginId = aliases.length > 1 ? aliases[1] : undefined;
  const currentPluginOptions = isRecord(currentOptions[canonicalPluginId])
    ? currentOptions[canonicalPluginId]
    : legacyPluginId && isRecord(currentOptions[legacyPluginId])
      ? currentOptions[legacyPluginId]
      : {};
  const nextOptions = { ...currentOptions };
  for (const id of aliases) delete nextOptions[id];
  const clearedOptionKeySet = new Set(clearOptionKeys);
  const retainedPluginOptions = Object.fromEntries(
    Object.entries(currentPluginOptions).filter(([key]) => !clearedOptionKeySet.has(key)),
  );

  return {
    ...parsed,
    plugins: {
      ...plugins,
      options: {
        ...nextOptions,
        // 敏感字段按脱敏合同不会回传 UI，二次保存普通字段时请求中自然缺少
        // 已存 secret。这里按 option key 合并，避免整对象替换把同 scope 的密钥静默清空。
        // 显式清除走 clearOptionKeys，先删除指定键，再合并本次输入；不会连带删除启用状态
        // 或同插件的其他配置。
        [canonicalPluginId]: {
          ...retainedPluginOptions,
          ...options,
        },
      },
    },
  };
}

function patchPluginRemoved(
  parsed: Record<string, unknown>,
  pluginId: string,
): { next: Record<string, unknown>; removedEnabled: boolean; removedOptions: boolean } {
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  const options = isRecord(plugins.options) ? plugins.options : {};
  const aliases = pluginIdAliases(pluginId);
  const removedEnabled = aliases.some((id) => id in enabledPlugins);
  const removedOptions = aliases.some((id) => id in options);
  if (!removedEnabled && !removedOptions) {
    return { next: parsed, removedEnabled, removedOptions };
  }

  const nextEnabled = { ...enabledPlugins };
  for (const id of aliases) delete nextEnabled[id];
  const nextOptions = { ...options };
  for (const id of aliases) delete nextOptions[id];

  return {
    next: {
      ...parsed,
      plugins: {
        ...plugins,
        enabledPlugins: nextEnabled,
        options: nextOptions,
      },
    },
    removedEnabled,
    removedOptions,
  };
}

async function atomicWriteJson(filePath: string, value: Record<string, unknown>): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`,
  );
  const content = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await writeFile(tempPath, content, { mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(`Unable to write config file: ${filePath}`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
