import type { Event, IDisposable } from "@zcode/rpc";
import type { ZCodePluginUserConfigOption } from "@zcode/shared";
import {
  ExtensionError,
  type ExtensionSettings,
  type ExtensionSettingsUpdate,
} from "@zcode/shared/extension-host";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { IPluginManagementService } from "#src/plugins/pluginManagement.js";
import type { PluginUserOptionsReader } from "#src/zcode-agent/pluginHostQueriesClient.js";

// 插件设置后端（docs/plugins/extension-host.md §16.7、§18.1 H1，① 调现有服务）：
// 能力 settings.get / settings.onDidChange / settings.update。
// - 值的 owner 是 CLI：读 plugins/readUserOptions（user 层有效值，含敏感值）。读取器只在 Window Host 进程内，
//   不在任何 RPC 频道上；这里只把调用方自己插件的值交出去（网关注入插件 id）。
// - 旧 CLI 没有 plugins/readUserOptions：从 plugins/list（user 视图）取非敏感值，整个 Window Host 只 warn 一次。
// - 变更信号来自插件管理服务的成功返回（configure / reset_config，user scope），不监听文件。
// - settings.update：按本插件的 userConfig 校验键与值类型，再经同一个插件管理服务写 user 层
//   （与设置页保存同一条路径）；成功信号照常触发 onDidChange。
// 日志里没有任何值，只有插件 id 与键数。

export interface SettingsBackendDeps {
  /** Window Host 进程内的读取器（getPluginUserOptionsReader）；没有时按旧 CLI 处理。 */
  reader: PluginUserOptionsReader | undefined;
  pluginManagement: Pick<IPluginManagementService, "listPlugins" | "configurePlugin">;
  /** 读用户级插件清单用的本地目录（与静态表同一个）。 */
  inventoryWorkspacePath: string;
  logger: Pick<ServiceLogger, "info" | "warn">;
}

export interface SettingsBackend {
  get(pluginId: string): Promise<ExtensionSettings>;
  /** 只推给该插件的订阅者；订阅后不推初始值。 */
  onDidChange(pluginId: string): Event<ExtensionSettings>;
  /** 写该插件的 user 层设置（§18.1 H1）。键不在 userConfig 里或值类型不符时抛 invalid-input。 */
  update(pluginId: string, input: ExtensionSettingsUpdate): Promise<undefined>;
  /** 该插件的 user 层设置保存或重置成功：有订阅者时读一次当前值并推送。按调用顺序串行。 */
  notifyChanged(pluginId: string): void;
  dispose(): void;
}

function describe(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const data = (error as { data?: { code?: unknown } }).data;
    if (typeof data?.code === "string") return data.code;
  }
  return error instanceof Error ? error.name : "unknown";
}

/** 值的类型按 userConfig 的选项类型：number 要数字，boolean 要布尔，其余（string、directory、file、未写）要字符串。 */
function matchesOptionType(
  option: ZCodePluginUserConfigOption,
  value: ExtensionSettings["values"][string],
): boolean {
  if (option.type === "number") return typeof value === "number";
  if (option.type === "boolean") return typeof value === "boolean";
  return typeof value === "string";
}

export function createSettingsBackend(deps: SettingsBackendDeps): SettingsBackend {
  const listeners = new Map<string, Set<(settings: ExtensionSettings) => void>>();
  let warnedUnsupported = false;
  let notifyChain: Promise<void> = Promise.resolve();
  let disposed = false;

  /** user 视图里的本插件（与静态表同一个清单目录）：清单默认值、userConfig 与非敏感的已配置值。 */
  const readPlugin = async (pluginId: string) => {
    const result = await deps.pluginManagement.listPlugins({
      workspacePath: deps.inventoryWorkspacePath,
      configScope: "user",
    });
    const plugin = result.plugins.find((candidate) => candidate.id === pluginId);
    if (!plugin) throw new ExtensionError("internal", `plugin is not installed: ${pluginId}`);
    return plugin;
  };

  /** 旧 CLI：清单默认值（非敏感键）⊕ configuredOptions（plugins/list 已过滤敏感值）。 */
  const readNonSensitive = async (pluginId: string): Promise<ExtensionSettings> => {
    const plugin = await readPlugin(pluginId);
    const values: ExtensionSettings["values"] = {};
    for (const [key, option] of Object.entries(plugin.userConfig ?? {})) {
      if (option.sensitive !== true && option.default !== undefined) values[key] = option.default;
    }
    return { values: { ...values, ...plugin.configuredOptions } };
  };

  const get = async (pluginId: string): Promise<ExtensionSettings> => {
    let result: Awaited<ReturnType<PluginUserOptionsReader["readPluginUserOptions"]>>;
    try {
      result = deps.reader
        ? await deps.reader.readPluginUserOptions({ pluginId })
        : { supported: false };
    } catch (error) {
      // 错误里只带插件 id 与错误码；CLI 的错误信息本身也不含值。
      deps.logger.warn(undefined, `settings read failed plugin=${pluginId} (${describe(error)})`);
      throw new ExtensionError("internal", `settings are not available: ${pluginId}`);
    }
    if (result.supported) return { values: result.values };
    if (!warnedUnsupported) {
      warnedUnsupported = true;
      deps.logger.warn(
        undefined,
        "plugins/readUserOptions is not supported by this CLI; settings.get returns non-sensitive values only",
      );
    }
    return readNonSensitive(pluginId);
  };

  const update = async (pluginId: string, input: ExtensionSettingsUpdate): Promise<undefined> => {
    const userConfig = (await readPlugin(pluginId)).userConfig ?? {};
    const values = input.values ?? {};
    const clear = input.clear ?? [];
    // CLI 不校验键是否属于清单（会原样写入），所以在这里按 userConfig 拒绝。信息只列键名，不带值。
    const unknown = [...new Set([...Object.keys(values), ...clear])].filter(
      (key) => !Object.hasOwn(userConfig, key),
    );
    if (unknown.length > 0) {
      throw new ExtensionError(
        "invalid-input",
        `settings.update: not in this plugin's userConfig: ${unknown.join(", ")}`,
      );
    }
    const mismatched = Object.entries(values)
      .filter(([key, value]) => !matchesOptionType(userConfig[key]!, value))
      .map(([key]) => key);
    if (mismatched.length > 0) {
      throw new ExtensionError(
        "invalid-input",
        `settings.update: value type does not match userConfig: ${mismatched.join(", ")}`,
      );
    }
    try {
      // 与设置页保存同一个服务与 scope：CLI 按清单把敏感键写进私有文件；成功信号触发 onDidChange。
      await deps.pluginManagement.configurePlugin({
        workspacePath: deps.inventoryWorkspacePath,
        pluginId,
        options: values,
        ...(clear.length > 0 ? { clearOptionKeys: clear } : {}),
        scope: "user",
      });
    } catch (error) {
      deps.logger.warn(undefined, `settings update failed plugin=${pluginId} (${describe(error)})`);
      throw new ExtensionError("internal", `settings could not be saved: ${pluginId}`);
    }
    deps.logger.info(
      undefined,
      `settings update plugin=${pluginId} keys=${Object.keys(values).length} cleared=${clear.length}`,
    );
    return undefined;
  };

  return {
    get,
    update,
    onDidChange: (pluginId) =>
      ((listener: (settings: ExtensionSettings) => void): IDisposable => {
        let set = listeners.get(pluginId);
        if (!set) {
          set = new Set();
          listeners.set(pluginId, set);
        }
        set.add(listener);
        return {
          dispose() {
            const current = listeners.get(pluginId);
            current?.delete(listener);
            if (current?.size === 0) listeners.delete(pluginId);
          },
        };
      }) satisfies Event<ExtensionSettings>,
    notifyChanged(pluginId) {
      if (disposed) return;
      // 串行：先读值再推，后一次排在前一次之后，订阅者最后收到的总是最新的值。
      notifyChain = notifyChain.then(async () => {
        const subscribers = listeners.get(pluginId);
        if (disposed || !subscribers?.size) {
          deps.logger.info(undefined, `settings changed plugin=${pluginId} subscribers=0`);
          return;
        }
        const settings = await get(pluginId).catch(() => null);
        if (!settings || disposed) return;
        const current = [...(listeners.get(pluginId) ?? [])];
        deps.logger.info(
          undefined,
          `settings changed plugin=${pluginId} keys=${Object.keys(settings.values).length} subscribers=${current.length}`,
        );
        for (const listener of current) listener(settings);
      });
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
