import type {
  PluginActivationStatus,
  PluginDiscoveryCandidate,
  PluginDiscoveryContext,
  PluginDiscoveryPort,
  SuggestPluginInstallOutput,
} from "@zcode/contracts";
import { isDiscoverableOfficialPlugin } from "@zcode/shared";
import { searchPluginCatalog } from "./search.js";

export interface PluginDiscoveryDependencies {
  list(): PluginDiscoveryCandidate[] | Promise<PluginDiscoveryCandidate[]>;
  resolve(pluginId: string): Promise<PluginDiscoveryCandidate | undefined>;
  refresh(options: { force: boolean; signal: AbortSignal }): Promise<{ stale: boolean }>;
  apply(
    plugin: PluginDiscoveryCandidate,
    context: PluginDiscoveryContext,
  ): Promise<boolean>;
  confirm(
    plugin: PluginDiscoveryCandidate,
    reason: string,
    context: PluginDiscoveryContext,
  ): Promise<boolean>;
  activate?(pluginId: string, context: PluginDiscoveryContext, changed: boolean): Promise<PluginActivationStatus>;
  readSkipped?(): Promise<ReadonlyMap<string, string | undefined>>;
}
export function createPluginDiscoveryPort(deps: PluginDiscoveryDependencies): PluginDiscoveryPort {
  const skipped = new Map<string, string | undefined>();
  // 同一工具调用的重复派发复用结果；不同调用仍需各自用户确认。
  const operations = new Map<string, Promise<SuggestPluginInstallOutput>>();
  async function suggest(
    input: Parameters<PluginDiscoveryPort["suggest"]>[0],
    context: PluginDiscoveryContext,
  ): Promise<SuggestPluginInstallOutput> {
    const { pluginId } = input;
    const outcome = (
      status: SuggestPluginInstallOutput["status"],
      message: string,
    ): SuggestPluginInstallOutput => ({ pluginId, status, message });
    context.signal.throwIfAborted();
    if (!isDiscoverableOfficialPlugin(pluginId))
      return outcome("unavailable", "Plugin is not a visible official marketplace entry.");
    const previous = skipped.has(pluginId) ? skipped : await deps.readSkipped?.();
    if (
      previous?.has(pluginId) &&
      !(input.reconsider === true && context.turnId && context.turnId !== previous.get(pluginId))
    ) {
      return outcome(
        "skipped",
        "The user skipped this plugin. Do not recommend it again unless a new user message explicitly asks to reconsider.",
      );
    }
    let plugin = await deps.resolve(pluginId);
    if (!plugin) {
      const refreshed = await deps.refresh({ force: false, signal: context.signal });
      if (refreshed.stale)
        return outcome("unavailable", "Official marketplace could not be refreshed.");
      plugin = await deps.resolve(pluginId);
    }
    if (!plugin)
      return outcome(
        "unavailable",
        "Plugin is absent from the official catalog or has conflicting identities.",
      );
    if (plugin.action === "none") {
      skipped.delete(pluginId);
      const activation = await activate(pluginId, context, false);
      return {
        ...outcome(
          "alreadyAvailable",
          "Plugin is installed and enabled; check activation before using it.",
        ),
        activation,
      };
    }
    const accepted = await deps.confirm(plugin, input.reason, context);
    context.signal.throwIfAborted();
    if (!accepted) {
      skipped.set(pluginId, context.turnId);
      return outcome(
        "skipped",
        "The user skipped installation. Continue without this plugin and do not repeat the recommendation.",
      );
    }
    // 确认期间目录、安装态或 Workspace 覆盖可能变化；必须重新可信解析后才执行。
    const refreshed = await deps.refresh({ force: true, signal: context.signal });
    context.signal.throwIfAborted();
    if (refreshed.stale)
      return outcome("unavailable", "Official marketplace refresh failed. Nothing was installed.");
    const current = await deps.resolve(pluginId);
    if (!current) return outcome("unavailable", "Plugin is no longer available.");
    if (
      current.action !== "none" &&
      (current.action !== plugin.action || current.scope !== plugin.scope)
    ) {
      return outcome(
        "unavailable",
        "Plugin state changed during confirmation. Request a new confirmation.",
      );
    }
    let changed: boolean;
    try {
      changed = current.action !== "none" && await deps.apply(current, context);
    } catch (error) {
      context.signal.throwIfAborted();
      return outcome(
        "failed",
        error instanceof Error ? error.message : "Plugin installation failed.",
      );
    }
    const activation = await activate(pluginId, context, changed);
    skipped.delete(pluginId);
    return {
      ...outcome(
        !changed ? "alreadyAvailable" : current.action === "enable" ? "enabled" : "installed",
        activation === "ready"
          ? "Plugin is ready in this session."
          : activation === "disabled"
            ? "Plugin is installed but disabled in this workspace. Enabling it requires separate confirmation."
            : activation === "needsConfiguration"
              ? "Plugin is installed. Complete configuration or authorization in plugin settings."
              : changed && deps.activate
                ? "Plugin is installed. The session will reload when accepted work finishes. Do not use the new capability in this turn."
                : "Plugin is installed. Its capability has not been verified in this session.",
      ),
      activation,
    };
  }
  async function activate(
    pluginId: string,
    context: PluginDiscoveryContext,
    changed: boolean,
  ): Promise<PluginActivationStatus> {
    if (!deps.activate) return "refreshRequired";
    try {
      return await deps.activate(pluginId, context, changed);
    } catch {
      return "failed";
    }
  }
  return {
    async search(input, context) {
      context.signal.throwIfAborted();
      const { stale } = await deps.refresh({ force: false, signal: context.signal });
      return searchPluginCatalog(await deps.list(), input, stale);
    },
    suggest(input, context) {
      const key = `${context.sessionId}:${context.toolCallId}`;
      const existing = operations.get(key);
      if (existing) return existing;
      const operation = suggest(input, context);
      operations.set(key, operation);
      // 工具结果由既有 Session 持久化；这里只保留有限数量的重复派发结果。
      if (operations.size > 128) operations.delete(operations.keys().next().value!);
      return operation;
    },
  };
}
