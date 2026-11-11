// Plugin Secrets Adapter - 敏感插件选项的私有文件（plugin-compat.md「Sensitive Option Storage」）。
//
// 只负责文件 I/O、schema 与纯数据变换；「哪些键敏感、读取时怎样叠加到配置层」由 bootstrap 决定。
// 任何错误信息与返回的诊断原因都不带值。

import { readFile } from "node:fs/promises";
import { resolve, win32 } from "node:path";
import { z } from "zod";
import { atomicWritePrivateTextFile, backupCorruptFile, withFileLock } from "@zcode/shared/node";

export const PLUGIN_SECRETS_FILE_NAME = "plugin-secrets.json";
const PLUGIN_SECRETS_FILE_VERSION = 1;
const JSON_INDENT = 2;
const WINDOWS_PLATFORM = "win32";

const pluginOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const pluginSecretValuesSchema = z.record(
  z.string(),
  z.record(z.string(), pluginOptionValueSchema),
);
const pluginSecretsFileSchema = z
  .object({
    version: z.literal(PLUGIN_SECRETS_FILE_VERSION),
    user: pluginSecretValuesSchema,
    workspaces: z.record(z.string(), pluginSecretValuesSchema),
  })
  .strict();

export type PluginSecretValue = z.infer<typeof pluginOptionValueSchema>;
/** pluginId → key → value。 */
export type PluginSecretValues = z.infer<typeof pluginSecretValuesSchema>;
export type PluginSecretsFile = z.infer<typeof pluginSecretsFileSchema>;
export type PluginSecretsScope = { kind: "user" } | { kind: "workspace"; root: string };

/** 读取结果：读不出时一律按空文件处理，原因只区分「损坏」与「I/O 失败」。 */
export type PluginSecretsReadResult =
  | { status: "ok"; file: PluginSecretsFile }
  | { status: "unreadable"; reason: "corrupt" | "io"; file: PluginSecretsFile };

export function createEmptyPluginSecretsFile(): PluginSecretsFile {
  return { version: PLUGIN_SECRETS_FILE_VERSION, user: {}, workspaces: {} };
}

/**
 * 插件配置路径与 workspace root 的比较键：Windows 不区分大小写、分隔符统一为 `/`。
 * workspace 配置路径匹配与私有文件的 workspace 键共用这一条规则。
 */
export function normalizePluginConfigPathForComparison(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== WINDOWS_PLATFORM) return resolve(path);
  return win32.resolve(path).replaceAll("\\", "/").toLowerCase();
}

/**
 * 读取路径（无锁）：写入是原子 rename，读者只会看到旧文件或新文件。
 * 损坏时先备份再按空处理；备份失败不影响读取（原文件仍在，下次写入前会再备份）。
 */
export async function readPluginSecretsFile(path: string): Promise<PluginSecretsReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { status: "ok", file: createEmptyPluginSecretsFile() };
    }
    return { status: "unreadable", reason: "io", file: createEmptyPluginSecretsFile() };
  }
  const parsed = parsePluginSecretsFile(raw);
  if (parsed) return { status: "ok", file: parsed };
  await backupCorruptFile(path).catch(() => undefined);
  return { status: "unreadable", reason: "corrupt", file: createEmptyPluginSecretsFile() };
}

/**
 * 在文件锁内读改写。损坏的文件先备份（失败则抛错，不覆盖读不出的证据）再按空处理；
 * 损坏以外的读取错误向上抛。内容不变且原文件有效时不写盘，避免为空操作创建文件。
 */
export async function updatePluginSecretsFile(
  path: string,
  mutate: (file: PluginSecretsFile) => PluginSecretsFile,
): Promise<void> {
  await withFileLock(path, async () => {
    const current = await readPluginSecretsFileForWrite(path);
    const next = prunePluginSecretsFile(mutate(current.file));
    if (!current.corrupt && JSON.stringify(next) === JSON.stringify(current.file)) return;
    await atomicWritePrivateTextFile(path, `${JSON.stringify(next, null, JSON_INDENT)}\n`);
  });
}

/** 某个 scope 下全部插件的私有值；workspace 按规范化后的 root 匹配。 */
export function getPluginSecretsForScope(
  file: PluginSecretsFile,
  scope: PluginSecretsScope,
): PluginSecretValues {
  if (scope.kind === "user") return file.user;
  const target = normalizePluginConfigPathForComparison(scope.root);
  const merged: PluginSecretValues = {};
  // 键按规范化比较，兼容手工编辑留下的大小写或分隔符差异。
  for (const [root, values] of Object.entries(file.workspaces)) {
    if (normalizePluginConfigPathForComparison(root) !== target) continue;
    for (const [pluginId, pluginValues] of Object.entries(values)) {
      merged[pluginId] = { ...merged[pluginId], ...pluginValues };
    }
  }
  return merged;
}

/** 写入一个插件在某个 scope 的私有值：先删 clearKeys，再写 values（与 config.json 的合并语义一致）。 */
export function setPluginSecrets(
  file: PluginSecretsFile,
  scope: PluginSecretsScope,
  pluginId: string,
  values: Record<string, PluginSecretValue>,
  clearKeys: readonly string[],
): PluginSecretsFile {
  const clear = new Set(clearKeys);
  const current = getPluginSecretsForScope(file, scope)[pluginId] ?? {};
  const nextPluginValues = {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => !clear.has(key))),
    ...values,
  };
  if (scope.kind === "user") {
    return { ...file, user: { ...file.user, [pluginId]: nextPluginValues } };
  }
  const target = normalizePluginConfigPathForComparison(scope.root);
  const scopeValues = { ...getPluginSecretsForScope(file, scope), [pluginId]: nextPluginValues };
  return {
    ...file,
    workspaces: {
      ...withoutWorkspaceRoot(file.workspaces, target),
      [target]: scopeValues,
    },
  };
}

/** 删除一个插件的私有值：指定 scope，或 `"all"`（user 与全部 workspaces，用于卸载）。 */
export function removePluginSecrets(
  file: PluginSecretsFile,
  pluginId: string,
  scope: PluginSecretsScope | "all",
): PluginSecretsFile {
  const removeFrom = (values: PluginSecretValues): PluginSecretValues =>
    Object.fromEntries(Object.entries(values).filter(([id]) => id !== pluginId));
  if (scope === "all") {
    return {
      ...file,
      user: removeFrom(file.user),
      workspaces: Object.fromEntries(
        Object.entries(file.workspaces).map(([root, values]) => [root, removeFrom(values)]),
      ),
    };
  }
  if (scope.kind === "user") return { ...file, user: removeFrom(file.user) };
  const target = normalizePluginConfigPathForComparison(scope.root);
  return {
    ...file,
    workspaces: Object.fromEntries(
      Object.entries(file.workspaces).map(([root, values]) => [
        root,
        normalizePluginConfigPathForComparison(root) === target ? removeFrom(values) : values,
      ]),
    ),
  };
}

function withoutWorkspaceRoot(
  workspaces: PluginSecretsFile["workspaces"],
  normalizedRoot: string,
): PluginSecretsFile["workspaces"] {
  return Object.fromEntries(
    Object.entries(workspaces).filter(
      ([root]) => normalizePluginConfigPathForComparison(root) !== normalizedRoot,
    ),
  );
}

/** 去掉空的插件条目与空的 workspace 条目，卸载或清除后不留空壳。 */
function prunePluginSecretsFile(file: PluginSecretsFile): PluginSecretsFile {
  const pruneValues = (values: PluginSecretValues): PluginSecretValues =>
    Object.fromEntries(
      Object.entries(values).filter(([, pluginValues]) => Object.keys(pluginValues).length > 0),
    );
  return {
    version: PLUGIN_SECRETS_FILE_VERSION,
    user: pruneValues(file.user),
    workspaces: Object.fromEntries(
      Object.entries(file.workspaces)
        .map(([root, values]) => [root, pruneValues(values)] as const)
        .filter(([, values]) => Object.keys(values).length > 0),
    ),
  };
}

async function readPluginSecretsFileForWrite(
  path: string,
): Promise<{ file: PluginSecretsFile; corrupt: boolean }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { file: createEmptyPluginSecretsFile(), corrupt: false };
    }
    throw error;
  }
  const parsed = parsePluginSecretsFile(raw);
  if (parsed) return { file: parsed, corrupt: false };
  await backupCorruptFile(path);
  return { file: createEmptyPluginSecretsFile(), corrupt: true };
}

function parsePluginSecretsFile(raw: string): PluginSecretsFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = pluginSecretsFileSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
