/**
 * workspace-plugin-trust 对外契约：项目目录插件信任记录的唯一 owner。
 * 规格：docs/plugins/workspace-plugin-dir-trust.md。
 */
import type { ConfigResult } from "@zcode/adapters/config";
import type { Logger, WorkspacePluginDiscovery } from "@zcode/contracts";

export type WorkspacePluginTrustReasonCode =
  | "workspace_plugin_declaration_changed"
  | "workspace_plugin_trust_unavailable";

export interface WorkspacePluginTrustTarget {
  workingDirectory: string;
  workspaceIdentity?: string;
  env?: Record<string, string | undefined>;
}

export interface WorkspacePluginTrustContract {
  /**
   * 读入项目候选目录与本工作区的信任记录，交给插件发现准入。只读；没有候选时返回 undefined。
   * 存储读不出时按没有信任处理（fail closed），只记 warn。
   */
  resolveWorkspacePluginDiscovery(
    input: WorkspacePluginTrustTarget & { configResult: ConfigResult; logger?: Logger },
  ): Promise<WorkspacePluginDiscovery | undefined>;
  /**
   * 写入或撤销一条信任，文件锁内完成并原子落盘后返回。信任时重读当前声明，摘要不一致返回
   * declaration_changed 且不写。幂等：同一插件根只保留最新一条记录。只影响之后新建的会话。
   */
  setWorkspacePluginTrust(
    input: WorkspacePluginTrustTarget & {
      pluginRoot: string;
      declarationDigest: string;
      trusted: boolean;
      userConfigPath?: string;
    },
  ): Promise<{ accepted: boolean; reasonCode?: WorkspacePluginTrustReasonCode }>;
}
