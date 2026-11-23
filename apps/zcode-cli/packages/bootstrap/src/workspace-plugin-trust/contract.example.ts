/**
 * workspace-plugin-trust 标准调用示例：设置页点「信任」时，用列表里展示的摘要写入信任。
 */
import type { WorkspacePluginTrustContract } from "./contract.js";

export async function exampleWorkspacePluginTrust(
  trust: WorkspacePluginTrustContract,
  shown: { pluginRoot: string; declarationDigest: string },
): Promise<boolean> {
  const result = await trust.setWorkspacePluginTrust({
    workingDirectory: "/Users/dev/project",
    pluginRoot: shown.pluginRoot,
    declarationDigest: shown.declarationDigest,
    trusted: true,
  });
  // declaration_changed 表示审核后声明又变了，调用方应重新拉取列表让用户再看一次。
  return result.accepted;
}
