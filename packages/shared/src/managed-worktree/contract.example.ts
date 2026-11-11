import { stat, readFile, realpath } from "node:fs/promises";
import type { WorkspaceHookTrustIdentityFs } from "./contract.js";
import { resolveWorkspaceHookTrustIdentity } from "./index.js";

// 示例：Host 侧用 node:fs/promises 适配只读端口，求一个工作区的 Trust identity。
const nodeFs: WorkspaceHookTrustIdentityFs = {
  readFile: (path) => readFile(path, "utf8"),
  realpath: (path) => realpath(path),
  stat: async (path) => {
    const info = await stat(path).catch(() => null);
    return info ? { isFile: info.isFile(), isDirectory: info.isDirectory() } : null;
  },
};

export async function exampleTrustIdentity(workspacePath: string, dataBaseDir: string) {
  return await resolveWorkspaceHookTrustIdentity({ workspacePath, dataBaseDir }, nodeFs);
}
