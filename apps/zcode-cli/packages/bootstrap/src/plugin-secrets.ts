// 敏感插件选项：读取时按配置层叠加私有文件，保存、重置、卸载时维护私有文件。
// 规格：docs/design/v2/plugin-compat.md「Sensitive Option Storage」。
// 文件 I/O 与 schema 在 adapters（plugin-secrets.adapter.ts）；这里只放规则。
import { dirname, join } from "node:path";
import {
  PLUGIN_SECRETS_FILE_NAME,
  getPluginSecretsForScope,
  readPluginOptionsFromFileConfig,
  readPluginSecretsFile,
  removePluginSecrets,
  setPluginSecrets,
  updatePluginOptionsInFileConfig,
  updatePluginSecretsFile,
  type ConfigResult,
  type PluginOptionLayer,
  type PluginSecretValue,
  type PluginSecretValues,
  type PluginSecretsFile,
  type PluginSecretsScope,
} from "@zcode/adapters/config";
import type { Logger, PluginDiagnostic, PluginMetadata } from "@zcode/contracts";

const PLUGIN_SECRETS_UNREADABLE_CODE = "plugin_secrets_unreadable";
const PLUGIN_SECRETS_UNREADABLE_MESSAGE =
  "Plugin secrets file is unreadable; sensitive plugin options are ignored until they are saved again";

type PluginOptionValues = Record<string, PluginSecretValue>;

/**
 * 私有文件与插件存储目录 `plugins/` 同级。默认就是 `<cli storage root>/plugin-secrets.json`；
 * 调用方覆盖插件存储目录（测试、嵌入）时文件跟着走，不会写进真实的用户目录。
 */
export function resolvePluginSecretsPath(pluginStorageRoot: string): string {
  return join(dirname(pluginStorageRoot), PLUGIN_SECRETS_FILE_NAME);
}

/** 读取私有文件并叠加到配置视图。读不出时按空处理，返回不含值的诊断。 */
export async function withPluginSecrets(
  configResult: ConfigResult,
  secretsPath: string,
  logger?: Pick<Logger, "warn">,
): Promise<{ configResult: ConfigResult; diagnostics: PluginDiagnostic[] }> {
  const read = await readPluginSecretsFile(secretsPath);
  if (read.status === "ok") {
    return { configResult: applyPluginSecrets(configResult, read.file), diagnostics: [] };
  }
  logger?.warn("Plugin secrets file is unreadable", {
    event: "plugins.secrets.unreadable",
    module: "bootstrap.plugins",
    path: secretsPath,
    reason: read.reason,
  });
  return {
    configResult: applyPluginSecrets(configResult, read.file),
    diagnostics: [
      {
        code: PLUGIN_SECRETS_UNREADABLE_CODE,
        message: PLUGIN_SECRETS_UNREADABLE_MESSAGE,
        path: secretsPath,
        severity: "error",
      },
    ],
  };
}

/**
 * 按层叠加：每个 scope 内私有文件优先于 config.json 的旧明文值，scope 之间的优先级不变
 * （user < 项目配置文件按发现顺序，最内层 workspace 最高）。
 *
 * 只重算私有文件里出现过的键，其余键沿用合并结果；重算只读原始层，所以对同一视图重复叠加
 * 结果不变。
 */
export function applyPluginSecrets(
  configResult: ConfigResult,
  file: PluginSecretsFile,
): ConfigResult {
  const layers: readonly PluginOptionLayer[] = configResult.sources.plugins.optionLayers ?? [];
  if (layers.length === 0) return configResult;
  const layerSecrets = layers.map((layer) => getPluginSecretsForScope(file, toSecretsScope(layer)));
  const touched = collectSecretKeys(layerSecrets);
  if (touched.size === 0) return configResult;

  const options = { ...configResult.config.plugins.options };
  const optionSources = { ...configResult.sources.plugins.options };
  for (const [pluginId, keys] of touched) {
    for (const key of keys) {
      const winner = resolveLayeredValue(layers, layerSecrets, pluginId, key);
      if (!winner) continue;
      options[pluginId] = { ...options[pluginId], [key]: winner.value };
      optionSources[pluginId] = { ...optionSources[pluginId], [key]: winner.scope };
    }
  }
  return {
    ...configResult,
    config: {
      ...configResult.config,
      plugins: { ...configResult.config.plugins, options },
    },
    sources: {
      ...configResult.sources,
      plugins: { ...configResult.sources.plugins, options: optionSources },
    },
  };
}

export interface SavePluginOptionsInput {
  clearOptionKeys: readonly string[];
  configPath: string;
  options: PluginOptionValues;
  plugin: Pick<PluginMetadata, "id" | "userConfig">;
  scope: PluginSecretsScope;
  secretsPath: string;
}

/**
 * configure 的写入：敏感键进私有文件，普通键进 config.json。
 *
 * - 迁移：该 scope 的 config.json 里按当前清单为敏感的旧明文键全部迁走，包括这次请求没带的键。
 *   UI 不回传敏感值，只保存普通键的请求里本来就没有已存的 secret；只迁请求里的键会让旧明文
 *   永远留在文件里。
 * - 先写私有文件，再改 config.json：第二步失败时两处都有值，读取以私有文件为准，不会丢值。
 * - 写普通键时同时删掉私有文件里的同名键：清单把敏感键改回普通后，旧的私有值不能盖住新写的值。
 */
export async function savePluginOptions(input: SavePluginOptionsInput): Promise<void> {
  const sensitiveKeys = collectSensitiveKeys(input.plugin);
  const clear = new Set(input.clearOptionKeys);
  const secretValues: PluginOptionValues = {};
  if (sensitiveKeys.size > 0) {
    const legacy = await readPluginOptionsFromFileConfig(input.configPath, input.plugin.id);
    for (const [key, value] of Object.entries(legacy)) {
      if (sensitiveKeys.has(key) && !clear.has(key)) secretValues[key] = value;
    }
  }
  const plainValues: PluginOptionValues = {};
  for (const [key, value] of Object.entries(input.options)) {
    if (sensitiveKeys.has(key)) secretValues[key] = value;
    else plainValues[key] = value;
  }

  const secretClearKeys = unique([...input.clearOptionKeys, ...Object.keys(plainValues)]);
  if (Object.keys(secretValues).length > 0 || secretClearKeys.length > 0) {
    await updatePluginSecretsFile(input.secretsPath, (file) =>
      setPluginSecrets(file, input.scope, input.plugin.id, secretValues, secretClearKeys),
    );
  }
  await updatePluginOptionsInFileConfig(
    input.configPath,
    input.plugin.id,
    plainValues,
    unique([...input.clearOptionKeys, ...Object.keys(secretValues)]),
  );
}

/** reset（user scope）与 uninstall 用：删除一个插件在指定 scope 或全部 scope 的私有值。 */
export async function removeStoredPluginSecrets(
  secretsPath: string,
  pluginId: string,
  scope: PluginSecretsScope | "all",
): Promise<void> {
  await updatePluginSecretsFile(secretsPath, (file) => removePluginSecrets(file, pluginId, scope));
}

function toSecretsScope(layer: PluginOptionLayer): PluginSecretsScope {
  return layer.scope === "workspace" && layer.workspaceRoot
    ? { kind: "workspace", root: layer.workspaceRoot }
    : { kind: "user" };
}

function collectSecretKeys(layerSecrets: readonly PluginSecretValues[]): Map<string, Set<string>> {
  const touched = new Map<string, Set<string>>();
  for (const secrets of layerSecrets) {
    for (const [pluginId, values] of Object.entries(secrets)) {
      const keys = touched.get(pluginId) ?? new Set<string>();
      for (const key of Object.keys(values)) keys.add(key);
      touched.set(pluginId, keys);
    }
  }
  return touched;
}

function resolveLayeredValue(
  layers: readonly PluginOptionLayer[],
  layerSecrets: readonly PluginSecretValues[],
  pluginId: string,
  key: string,
): { scope: PluginOptionLayer["scope"]; value: PluginSecretValue } | undefined {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (!layer) continue;
    const secret = layerSecrets[index]?.[pluginId]?.[key];
    if (secret !== undefined) return { scope: layer.scope, value: secret };
    const plain = layer.options[pluginId]?.[key];
    if (plain !== undefined) return { scope: layer.scope, value: plain };
  }
  return undefined;
}

function collectSensitiveKeys(plugin: Pick<PluginMetadata, "userConfig">): Set<string> {
  return new Set(
    Object.entries(plugin.userConfig ?? {})
      .filter(([, option]) => option.sensitive === true)
      .map(([key]) => key),
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
