import { getGenUiOutputDirectory } from "@zcode/shared/node";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 会话的 Gen UI 输出目录；fork 时传子会话 id，取子会话自己的目录。
 * fork 到另一个 cwd（受管 worktree）时再传子会话的 workspace 路径：worktree 子会话的 workspace 路径
 * 就是它的 cwd，目录按 [workspace, sessionId] 计算，必须与子会话 runtime 自己算出的一致。
 */
export function resolveGenUiOutputDirectory(
  runtime: AgentRuntimeInternal,
  sessionId: string = runtime.sessionId,
  workspacePath: string = runtime.config.workspacePath ?? runtime.workspaceRoot,
): string | undefined {
  if (runtime.config.presentationSurface !== "zcode_desktop" || !runtime.config.genUiOutputRoot)
    return undefined;
  return getGenUiOutputDirectory(runtime.config.genUiOutputRoot, {
    workspacePath,
    workspaceIdentity: runtime.config.workspaceIdentity,
    sessionId,
  });
}

export async function ensureGenUiOutputDirectory(runtime: AgentRuntimeInternal): Promise<void> {
  const path = resolveGenUiOutputDirectory(runtime);
  if (!path) return;
  if (!runtime.fileSystemPort) throw new Error("Gen UI output requires FileSystemPort");
  // 只有成功创建后才向模型声明可写目录；失败不能静默落到 Git 工作区。
  await runtime.fileSystemPort.createDirectory({ path, trace: runtime.rootTraceContext });
}
