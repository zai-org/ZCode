/**
 * workspace-plugin-declaration 对外契约：项目目录插件的声明摘要与发现准入。
 * 规格：docs/plugins/workspace-plugin-dir-trust.md。
 */
import type { PluginWorkspaceTrust, WorkspacePluginDiscovery } from "@zcode/contracts";

/** 读文本；文件不存在返回 undefined，其它错误向上抛。 */
export type WorkspacePluginTextReader = (path: string) => Promise<string | undefined>;

export interface WorkspacePluginDeclarationContract {
  /** 插件根相对工作区目录的键（`/` 分隔）；纯计算，无 IO。 */
  workspacePluginRootKey(workspaceRoot: string, rootPath: string): string;
  /**
   * 直接读磁盘检查一个项目插件目录并算声明摘要，供信任写入时重验。只读，不执行任何插件代码。
   * 目录里没有可用 manifest 时返回 undefined。
   */
  inspectWorkspacePluginRoot(input: {
    workspaceRoot: string;
    rootPath: string;
  }): Promise<{ pluginName: string; pluginRoot: string; declarationDigest: string } | undefined>;
}

export type { PluginWorkspaceTrust, WorkspacePluginDiscovery };
