import type { SessionEvent } from "../events/session.events.js";
import type {
  PluginActivationStatus,
  SearchPluginsInput,
  SearchPluginsOutput,
  SuggestPluginInstallInput,
  SuggestPluginInstallOutput,
} from "../tools/plugin-discovery.js";

export interface PluginDiscoveryContext {
  sessionId: string;
  turnId?: string;
  toolCallId: string;
  traceId: string;
  signal: AbortSignal;
  emitEvent?: (event: SessionEvent) => Promise<void>;
}
export interface PluginDiscoveryPort {
  search(input: SearchPluginsInput, context: PluginDiscoveryContext): Promise<SearchPluginsOutput>;
  suggest(
    input: SuggestPluginInstallInput,
    context: PluginDiscoveryContext,
  ): Promise<SuggestPluginInstallOutput>;
}
/** 会话刷新由独立实现接入；没有注入时绝不能把安装完成当作工具已经可用。 */
export interface PluginActivationPort {
  activate(
    input: {
      sessionId: string;
      pluginId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
    },
    context: PluginDiscoveryContext,
  ): Promise<PluginActivationStatus>;
}
