// Config Port Implementation - Scoped configuration with change notification

import {
  ConfigKey,
  type ConfigValue,
  type ConfigSource,
  type RuntimeConfig,
  type RuntimeConfigPatch,
  type Unsubscribe,
  type ConfigObserver,
  type ConfigPort,
  ConfigScope,
  DefaultRuntimeConfig as DefaultConfig,
} from "@zcode/contracts";

type Handler<K extends ConfigKey> = (value: ConfigValue<K>, prev: ConfigValue<K>) => void;
type AllHandler = (key: ConfigKey, value: unknown, prev: unknown) => void;

// ============================================================
// Config Store - Internal state
// ============================================================

interface ConfigEntry {
  value: unknown;
  sources: ConfigSource[];
}

class ConfigStore {
  private store = new Map<ConfigKey, ConfigEntry>();
  private observers: Map<ConfigKey, Set<Handler<any>>> = new Map();
  private allHandlers: Set<AllHandler> = new Set();

  constructor(initial?: RuntimeConfigPatch) {
    if (initial) {
      this.merge(initial, ConfigScope.System);
    }
  }

  get<K extends ConfigKey>(key: K): ConfigValue<K> | undefined {
    const entry = this.store.get(key);
    return entry?.value as ConfigValue<K>;
  }

  has(key: ConfigKey): boolean {
    return this.store.has(key);
  }

  set<K extends ConfigKey>(
    key: K,
    value: ConfigValue<K>,
    scope: ConfigScope,
    source?: string,
  ): void {
    const prev = this.get(key);
    const entry: ConfigEntry = {
      value,
      sources: [{ scope, key, value, path: source }],
    };
    this.store.set(key, entry);

    // Notify observers
    const handlers = this.observers.get(key);
    if (handlers) {
      handlers.forEach((handler) => handler(value, prev as ConfigValue<K>));
    }

    // Notify all-handlers
    this.allHandlers.forEach((handler) => handler(key, value, prev));
  }

  getSources(key: ConfigKey): ConfigSource[] {
    const entry = this.store.get(key);
    return entry?.sources ?? [];
  }

  merge(config: RuntimeConfigPatch, scope: ConfigScope): void {
    if (config.modelStream?.idleTimeoutMs !== undefined) {
      this.set(ConfigKey.ModelStreamIdleTimeout, config.modelStream.idleTimeoutMs, scope);
    }
    if (config.permission) {
      if (config.permission.mode) this.set(ConfigKey.PermissionMode, config.permission.mode, scope);
      if (config.permission.allowedTools)
        this.set(ConfigKey.PermissionAllowedTools, config.permission.allowedTools, scope);
      if (config.permission.disallowedTools)
        this.set(ConfigKey.PermissionDisallowedTools, config.permission.disallowedTools, scope);
      if (config.permission.autoApproveHighRisk !== undefined) {
        this.set(
          ConfigKey.PermissionAutoApproveHighRisk,
          config.permission.autoApproveHighRisk,
          scope,
        );
      }
      if (config.permission.allowMediumRiskInAuto !== undefined) {
        this.set(
          ConfigKey.PermissionAllowMediumRiskInAuto,
          config.permission.allowMediumRiskInAuto,
          scope,
        );
      }
    }
    if (config.storage) {
      if (config.storage.dir) this.set(ConfigKey.StorageDir, config.storage.dir, scope);
      if (config.storage.sessionDbPath)
        this.set(ConfigKey.StorageSessionDbPath, config.storage.sessionDbPath, scope);
    }
    if (config.network) {
      if (config.network.httpProxy !== undefined)
        this.set(ConfigKey.HttpProxy, config.network.httpProxy, scope);
      if (config.network.noProxy !== undefined)
        this.set(ConfigKey.NoProxy, config.network.noProxy, scope);
      if (config.network.caCertFile !== undefined)
        this.set(ConfigKey.CaCertFile, config.network.caCertFile, scope);
      if (config.network.timeout !== undefined)
        this.set(ConfigKey.HttpTimeout, config.network.timeout, scope);
    }
    if (config.features) {
      if (config.features.compact !== undefined)
        this.set(ConfigKey.FeatureCompact, config.features.compact, scope);
      if (config.features.rewind !== undefined)
        this.set(ConfigKey.FeatureRewind, config.features.rewind, scope);
      if (config.features.subagent !== undefined)
        this.set(ConfigKey.FeatureSubagent, config.features.subagent, scope);
      if (config.features.memory !== undefined)
        this.set(ConfigKey.FeatureMemory, config.features.memory, scope);
      if (config.features.skill !== undefined)
        this.set(ConfigKey.FeatureSkill, config.features.skill, scope);
      if (config.features.mcp !== undefined)
        this.set(ConfigKey.FeatureMcp, config.features.mcp, scope);
    }
    if (config.memory) {
      if (config.memory.use !== undefined) this.set(ConfigKey.MemoryUse, config.memory.use, scope);
    }
    if (config.mcp) {
      if (config.mcp.servers !== undefined)
        this.set(ConfigKey.McpServers, config.mcp.servers, scope);
    }
    if (config.plugins) {
      if (config.plugins.enabled !== undefined)
        this.set(ConfigKey.PluginsEnabled, config.plugins.enabled, scope);
      if (config.plugins.dirs !== undefined)
        this.set(ConfigKey.PluginsDirs, config.plugins.dirs, scope);
      if (config.plugins.enabledPlugins !== undefined) {
        this.set(ConfigKey.PluginsEnabledPlugins, config.plugins.enabledPlugins, scope);
      }
      if (config.plugins.extraKnownMarketplaces !== undefined) {
        this.set(
          ConfigKey.PluginsExtraKnownMarketplaces,
          config.plugins.extraKnownMarketplaces,
          scope,
        );
      }
      if (config.plugins.options !== undefined) {
        this.set(ConfigKey.PluginsOptions, config.plugins.options, scope);
      }
      if (config.plugins.suppressedBuiltins !== undefined) {
        this.set(ConfigKey.PluginsSuppressedBuiltins, config.plugins.suppressedBuiltins, scope);
      }
    }
    if (config.skills) {
      if (config.skills.enabled !== undefined)
        this.set(ConfigKey.SkillsEnabled, config.skills.enabled, scope);
      if (config.skills.includeInstructions !== undefined) {
        this.set(ConfigKey.SkillsIncludeInstructions, config.skills.includeInstructions, scope);
      }
      if (config.skills.metadataBudget !== undefined) {
        this.set(ConfigKey.SkillsMetadataBudget, config.skills.metadataBudget, scope);
      }
      if (config.skills.roots !== undefined)
        this.set(ConfigKey.SkillsRoots, config.skills.roots, scope);
    }
    if (config.skillOverrides !== undefined) {
      this.set(ConfigKey.SkillOverrides, config.skillOverrides, scope);
    }
    if (config.commandOverrides !== undefined) {
      this.set(ConfigKey.CommandOverrides, config.commandOverrides, scope);
    }
    if (config.logging) {
      if (config.logging.level) this.set(ConfigKey.LogLevel, config.logging.level, scope);
      if (config.logging.format !== undefined)
        this.set(ConfigKey.LogFormat, config.logging.format, scope);
    }
    if (config.toolConcurrency) {
      if (config.toolConcurrency.maxConcurrency !== undefined)
        this.set(ConfigKey.ToolConcurrencyMax, config.toolConcurrency.maxConcurrency, scope);
    }
    if (config.modelAnomalyGuard) {
      const previous = this.get(ConfigKey.ModelAnomalyGuard) ?? DefaultConfig.modelAnomalyGuard;
      this.set(
        ConfigKey.ModelAnomalyGuard,
        {
          ...previous,
          ...config.modelAnomalyGuard,
        },
        scope,
      );
    }
    if (config.hooks) {
      const previous = this.get(ConfigKey.Hooks) ?? DefaultConfig.hooks;
      this.set(
        ConfigKey.Hooks,
        {
          ...previous,
          ...config.hooks,
          events: config.hooks.events ?? previous.events,
        },
        scope,
      );
    }
    if (config.ui?.locale !== undefined) {
      this.set(ConfigKey.UiLocale, config.ui.locale, scope);
    }
    if (config.ui?.theme !== undefined) {
      this.set(ConfigKey.UiTheme, config.ui.theme, scope);
    }
  }

  subscribe<K extends ConfigKey>(key: K, handler: Handler<K>): Unsubscribe {
    if (!this.observers.has(key)) {
      this.observers.set(key, new Set());
    }
    this.observers.get(key)!.add(handler);

    return () => {
      this.observers.get(key)?.delete(handler);
    };
  }

  subscribeAll(handler: AllHandler): Unsubscribe {
    this.allHandlers.add(handler);
    return () => {
      this.allHandlers.delete(handler);
    };
  }
}

// ============================================================
// Config Port Implementation
// ============================================================

export class ConfigPortImpl implements ConfigPort {
  private store: ConfigStore;

  constructor(initial?: RuntimeConfigPatch) {
    this.store = new ConfigStore(initial ?? DefaultConfig);
  }

  get<K extends ConfigKey>(key: K): ConfigValue<K> {
    const value = this.store.get(key);
    if (value !== undefined) return value;

    // Fallback to default config
    const defaultValue = getDefaultValue(key) as ConfigValue<K> | undefined;
    if (defaultValue !== undefined) return defaultValue;

    throw new Error(`Config key not found: ${key}`);
  }

  getAll(): RuntimeConfig {
    return {
      modelStream: {
        idleTimeoutMs:
          this.store.get(ConfigKey.ModelStreamIdleTimeout) ??
          DefaultConfig.modelStream.idleTimeoutMs,
      },
      permission: {
        mode: this.get(ConfigKey.PermissionMode),
        allowedTools: this.get(ConfigKey.PermissionAllowedTools),
        disallowedTools: this.get(ConfigKey.PermissionDisallowedTools),
        autoApproveHighRisk: this.get(ConfigKey.PermissionAutoApproveHighRisk),
        allowMediumRiskInAuto: this.get(ConfigKey.PermissionAllowMediumRiskInAuto),
      },
      storage: {
        dir: this.store.get(ConfigKey.StorageDir) ?? DefaultConfig.storage.dir,
        sessionDbPath:
          this.store.get(ConfigKey.StorageSessionDbPath) ?? DefaultConfig.storage.sessionDbPath,
      },
      network: {
        httpProxy: this.store.get(ConfigKey.HttpProxy),
        noProxy: this.store.get(ConfigKey.NoProxy),
        caCertFile: this.store.get(ConfigKey.CaCertFile),
        timeout: this.store.get(ConfigKey.HttpTimeout) ?? DefaultConfig.network.timeout,
      },
      features: {
        compact: this.store.get(ConfigKey.FeatureCompact) ?? true,
        rewind: this.store.get(ConfigKey.FeatureRewind) ?? true,
        subagent: this.store.get(ConfigKey.FeatureSubagent) ?? true,
        memory: this.store.get(ConfigKey.FeatureMemory) ?? true,
        skill: this.store.get(ConfigKey.FeatureSkill) ?? true,
        mcp: this.store.get(ConfigKey.FeatureMcp) ?? true,
      },
      memory: {
        use: this.store.get(ConfigKey.MemoryUse) ?? DefaultConfig.memory.use,
      },
      mcp: {
        servers: this.store.get(ConfigKey.McpServers) ?? DefaultConfig.mcp.servers,
      },
      plugins: {
        dirs: this.store.get(ConfigKey.PluginsDirs) ?? DefaultConfig.plugins.dirs,
        enabled: this.store.get(ConfigKey.PluginsEnabled) ?? DefaultConfig.plugins.enabled,
        enabledPlugins:
          this.store.get(ConfigKey.PluginsEnabledPlugins) ?? DefaultConfig.plugins.enabledPlugins,
        extraKnownMarketplaces:
          this.store.get(ConfigKey.PluginsExtraKnownMarketplaces) ??
          DefaultConfig.plugins.extraKnownMarketplaces,
        options: this.store.get(ConfigKey.PluginsOptions) ?? DefaultConfig.plugins.options,
        suppressedBuiltins:
          this.store.get(ConfigKey.PluginsSuppressedBuiltins) ??
          DefaultConfig.plugins.suppressedBuiltins,
      },
      skills: {
        enabled: this.store.get(ConfigKey.SkillsEnabled) ?? true,
        includeInstructions: this.store.get(ConfigKey.SkillsIncludeInstructions) ?? true,
        metadataBudget:
          this.store.get(ConfigKey.SkillsMetadataBudget) ?? DefaultConfig.skills.metadataBudget,
        roots: this.store.get(ConfigKey.SkillsRoots) ?? DefaultConfig.skills.roots,
      },
      skillOverrides: this.store.get(ConfigKey.SkillOverrides) ?? DefaultConfig.skillOverrides,
      commandOverrides:
        this.store.get(ConfigKey.CommandOverrides) ?? DefaultConfig.commandOverrides,
      logging: {
        level: this.store.get(ConfigKey.LogLevel) ?? "info",
        format: this.store.get(ConfigKey.LogFormat) ?? DefaultConfig.logging.format,
      },
      toolConcurrency: {
        maxConcurrency:
          this.store.get(ConfigKey.ToolConcurrencyMax) ??
          DefaultConfig.toolConcurrency.maxConcurrency,
      },
      modelAnomalyGuard:
        this.store.get(ConfigKey.ModelAnomalyGuard) ?? DefaultConfig.modelAnomalyGuard,
      hooks: this.store.get(ConfigKey.Hooks) ?? DefaultConfig.hooks,
      ui: {
        locale: this.store.get(ConfigKey.UiLocale) ?? DefaultConfig.ui.locale,
        theme: this.store.get(ConfigKey.UiTheme) ?? DefaultConfig.ui.theme,
      },
    };
  }

  has(key: ConfigKey): boolean {
    return this.store.has(key) || hasDefaultValue(key);
  }

  set<K extends ConfigKey>(key: K, value: ConfigValue<K>): void {
    // Runtime changes are always session scope
    this.store.set(key, value, ConfigScope.Session);
  }

  observe(): ConfigObserver {
    return {
      subscribe: <K extends ConfigKey>(key: K, handler: Handler<K>) =>
        this.store.subscribe(key, handler),
      subscribeAll: (handler: AllHandler) => this.store.subscribeAll(handler),
    };
  }

  getSources(key: ConfigKey): ConfigSource[] {
    return this.store.getSources(key);
  }

  merge(config: RuntimeConfigPatch, scope: ConfigScope): void {
    this.store.merge(config, scope);
  }
}

// ============================================================
// Helpers
// ============================================================

function getDefaultValue(key: ConfigKey): unknown {
  const defaults = DefaultConfig;
  switch (key) {
    case ConfigKey.ModelStreamIdleTimeout:
      return defaults.modelStream.idleTimeoutMs;
    case ConfigKey.PermissionMode:
      return defaults.permission.mode;
    case ConfigKey.PermissionAllowedTools:
      return defaults.permission.allowedTools;
    case ConfigKey.PermissionDisallowedTools:
      return defaults.permission.disallowedTools;
    case ConfigKey.PermissionAutoApproveHighRisk:
      return defaults.permission.autoApproveHighRisk;
    case ConfigKey.PermissionAllowMediumRiskInAuto:
      return defaults.permission.allowMediumRiskInAuto;
    case ConfigKey.StorageDir:
      return defaults.storage.dir;
    case ConfigKey.StorageSessionDbPath:
      return defaults.storage.sessionDbPath;
    case ConfigKey.HttpProxy:
      return defaults.network.httpProxy;
    case ConfigKey.NoProxy:
      return defaults.network.noProxy;
    case ConfigKey.CaCertFile:
      return defaults.network.caCertFile;
    case ConfigKey.HttpTimeout:
      return defaults.network.timeout;
    case ConfigKey.FeatureCompact:
      return defaults.features.compact;
    case ConfigKey.FeatureRewind:
      return defaults.features.rewind;
    case ConfigKey.FeatureSubagent:
      return defaults.features.subagent;
    case ConfigKey.FeatureMemory:
      return defaults.features.memory;
    case ConfigKey.FeatureSkill:
      return defaults.features.skill;
    case ConfigKey.FeatureMcp:
      return defaults.features.mcp;
    case ConfigKey.MemoryUse:
      return defaults.memory.use;
    case ConfigKey.McpServers:
      return defaults.mcp.servers;
    case ConfigKey.PluginsEnabled:
      return defaults.plugins.enabled;
    case ConfigKey.PluginsDirs:
      return defaults.plugins.dirs;
    case ConfigKey.PluginsEnabledPlugins:
      return defaults.plugins.enabledPlugins;
    case ConfigKey.PluginsExtraKnownMarketplaces:
      return defaults.plugins.extraKnownMarketplaces;
    case ConfigKey.PluginsOptions:
      return defaults.plugins.options;
    case ConfigKey.PluginsSuppressedBuiltins:
      return defaults.plugins.suppressedBuiltins;
    case ConfigKey.SkillsEnabled:
      return defaults.skills.enabled;
    case ConfigKey.SkillsIncludeInstructions:
      return defaults.skills.includeInstructions;
    case ConfigKey.SkillsMetadataBudget:
      return defaults.skills.metadataBudget;
    case ConfigKey.SkillsRoots:
      return defaults.skills.roots;
    case ConfigKey.LogLevel:
      return defaults.logging.level;
    case ConfigKey.LogFormat:
      return defaults.logging.format;
    case ConfigKey.ToolConcurrencyMax:
      return defaults.toolConcurrency.maxConcurrency;
    case ConfigKey.ModelAnomalyGuard:
      return defaults.modelAnomalyGuard;
    case ConfigKey.Hooks:
      return defaults.hooks;
    case ConfigKey.UiLocale:
      return defaults.ui.locale;
    case ConfigKey.UiTheme:
      return defaults.ui.theme;
    default:
      return undefined;
  }
}

function hasDefaultValue(key: ConfigKey): boolean {
  return getDefaultValue(key) !== undefined;
}

// ============================================================
// Factory
// ============================================================

export function createConfigPort(initial?: RuntimeConfigPatch): ConfigPort {
  return new ConfigPortImpl(initial);
}

// Re-export adapters and factory
export {
  loadFileConfig,
  getDefaultConfigPath,
  hasDefaultConfigFile,
  resolvePath,
  updatePluginEnabledInFileConfig,
  enablePluginsByDefaultInFileConfig,
  removePluginEnabledFromFileConfig,
  updatePluginOptionsInFileConfig,
  readPluginOptionsFromFileConfig,
  removePluginFromFileConfig,
  addSuppressedBuiltinInFileConfig,
  removeSuppressedBuiltinInFileConfig,
  updateUiLocaleInFileConfig,
  type PluginEnabledPatchResult,
  type PluginOptionsPatchResult,
  type PluginRemovePatchResult,
  type SuppressedBuiltinPatchResult,
  type UiLocalePatchResult,
} from "./file-config.adapter.js";
export { parseEnvConfig, getToolConcurrencyConfig } from "./env-config.adapter.js";
export { ZCodeConfigFileSchema, type ZCodeConfigFile } from "./schema.js";
export { mergeConfigs, createPrioritizedConfig, getScopePriority } from "./config-merger.js";
export {
  classifyLocalSessionDirectory,
  createConfig,
  createConfigWithPluginMigrations,
  resolveWorkspaceHookTrustIdentityForWorkspace,
  resolveWorkspaceStorageDir,
  resolveZCodeDataBaseDir,
  type ConfigFactoryOptions,
  type ConfigResult,
  type PluginConfigScope,
  type PluginOptionLayer,
  type LocalSessionDirectoryRelation,
} from "./config-factory.js";
export {
  PLUGIN_SECRETS_FILE_NAME,
  createEmptyPluginSecretsFile,
  getPluginSecretsForScope,
  normalizePluginConfigPathForComparison,
  readPluginSecretsFile,
  removePluginSecrets,
  setPluginSecrets,
  updatePluginSecretsFile,
  type PluginSecretValue,
  type PluginSecretValues,
  type PluginSecretsFile,
  type PluginSecretsReadResult,
  type PluginSecretsScope,
} from "./plugin-secrets.adapter.js";
