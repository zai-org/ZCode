/**
 * workspace-plugin-declaration 标准调用示例：信任写入前按磁盘当前内容重算摘要再比较。
 */
import type { WorkspacePluginDeclarationContract } from "./contract.js";

export async function exampleWorkspacePluginDeclaration(
  contract: WorkspacePluginDeclarationContract,
  reviewedDigest: string,
): Promise<boolean> {
  const current = await contract.inspectWorkspacePluginRoot({
    workspaceRoot: "/Users/dev/project",
    rootPath: "/Users/dev/project/plugins/demo",
  });
  return current?.declarationDigest === reviewedDigest;
}
