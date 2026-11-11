// Hook Trust identity 唯一 resolver（docs/specs/workspace-hook-trust.md D23）。
// CLI snapshot builder 与 Host hooksService 必须调用同一实现，保证两侧 digest/identity parity。
// 只覆盖本地 ZCode 受管 worktree：严格校验通过才归一到源仓库，任何一步失败都退回自身路径，
// 即"不继承"，不会产生额外授权。
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isSamePath, parseManagedWorktreePath, resolveManagedWorktreeRoot } from "./layout.js";

/** 只读文件端口；CLI 侧由 adapter 注入，Host 侧用 node:fs/promises 适配。 */
export interface WorkspaceHookTrustIdentityFs {
  readFile(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  /** 返回 null 表示路径不存在。 */
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean } | null>;
}

export interface ResolveWorkspaceHookTrustIdentityInput {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 数据根目录（ZCODE_DATA_BASE_DIR 优先，否则 homedir）；受管根目录 = <dataBaseDir>/.zcode/worktrees。 */
  dataBaseDir: string;
}

const GITDIR_PREFIX = "gitdir:";
const WORKTREES_DIRNAME = "worktrees";
const GIT_DIRNAME = ".git";

export async function resolveWorkspaceHookTrustIdentity(
  input: ResolveWorkspaceHookTrustIdentityInput,
  fs: WorkspaceHookTrustIdentityFs,
): Promise<string> {
  const identity = input.workspaceIdentity?.trim();
  // 远程 workspace 的 identity 是隔离主体，原样返回，不做任何本地路径解析。
  if (identity) return identity;
  const fallback = input.workspacePath;
  try {
    const mapped = await resolveManagedWorktreeSourcePath(
      input.workspacePath,
      input.dataBaseDir,
      fs,
    );
    return mapped ?? fallback;
  } catch {
    // 校验过程中的任何 IO 异常都按"不继承"处理（fail closed to self）。
    return fallback;
  }
}

/**
 * 受管 worktree 内的路径 → 源仓库中对应路径；不是受管 worktree 或校验失败返回 null。
 * 暴露给 Host 侧需要同一判定的场景（例如 Settings 显示"继承自"）。
 */
export async function resolveManagedWorktreeSourcePath(
  workspacePath: string,
  dataBaseDir: string,
  fs: WorkspaceHookTrustIdentityFs,
): Promise<string | null> {
  const managedRoot = await fs.realpath(resolveManagedWorktreeRoot(dataBaseDir));
  const realWorkspace = await fs.realpath(workspacePath);
  const parts = parseManagedWorktreePath(managedRoot, realWorkspace);
  if (!parts) return null;

  // 1. <worktree 根>/.git 必须是普通文件，内容为 gitdir: <common>/worktrees/<id>
  const dotGit = join(parts.worktreeRoot, GIT_DIRNAME);
  const dotGitStat = await fs.stat(dotGit);
  if (!dotGitStat?.isFile) return null;
  const adminDir = await fs.realpath(
    resolveGitPointer(parts.worktreeRoot, await fs.readFile(dotGit), GITDIR_PREFIX),
  );
  const worktreesDir = dirname(adminDir);
  if (!isSamePath(join(dirname(worktreesDir), WORKTREES_DIRNAME), worktreesDir)) return null;
  const common = dirname(worktreesDir);

  // 2. 反向链接：<admin>/gitdir 必须指回这个 checkout 的 .git，防止任意目录冒充源仓库。
  const backlink = await fs.realpath(
    resolveGitPointer(adminDir, await fs.readFile(join(adminDir, "gitdir")), ""),
  );
  if (!isSamePath(backlink, await fs.realpath(dotGit))) return null;

  // 3. <admin>/commondir 解析后等于 common。
  const commondir = await fs.realpath(
    resolveGitPointer(adminDir, await fs.readFile(join(adminDir, "commondir")), ""),
  );
  if (!isSamePath(commondir, common)) return null;

  // 4. common 必须就是 <源仓库 toplevel>/.git 目录（非 bare，非嵌套）。
  const sourceRoot = dirname(common);
  const sourceDotGit = join(sourceRoot, GIT_DIRNAME);
  const sourceDotGitStat = await fs.stat(sourceDotGit);
  if (!sourceDotGitStat?.isDirectory) return null;
  if (!isSamePath(await fs.realpath(sourceDotGit), common)) return null;

  return parts.relativePath ? join(sourceRoot, parts.relativePath) : sourceRoot;
}

/** 解析 `.git` 文件 / admin 指针文件里的路径；相对路径按指针所在目录解析。 */
function resolveGitPointer(baseDir: string, content: string, prefix: string): string {
  const line = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const value = prefix ? (line.startsWith(prefix) ? line.slice(prefix.length).trim() : "") : line;
  if (!value) throw new Error("invalid git pointer file");
  return isAbsolute(value) ? value : resolve(baseDir, value);
}
