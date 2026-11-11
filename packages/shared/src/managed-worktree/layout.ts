// 受管 worktree 目录布局（docs/git/worktree.md §5.3）。
// 只做纯路径计算；"是否真的是受管 worktree"还要叠加 git worktree list 与 .git 反向链接校验，
// 由调用方（Git 服务 / Trust identity resolver）完成。
import { basename, isAbsolute, join, relative, sep } from "node:path";

/** 受管根目录相对数据根目录的路径段：<dataBaseDir>/.zcode/worktrees。 */
export const MANAGED_WORKTREE_HOME_SEGMENTS = [".zcode", "worktrees"] as const;

/** bucket 是 4 位小写 hex；位数同时用来控制 Windows 路径长度。 */
export const MANAGED_WORKTREE_BUCKET_LENGTH = 4;
const BUCKET_PATTERN = /^[0-9a-f]{4}$/;

/** macOS 上阻止 Spotlight 索引受管根目录的标记文件。 */
export const MANAGED_WORKTREE_SPOTLIGHT_MARKER = ".metadata_never_index";

export interface ManagedWorktreePathParts {
  managedRoot: string;
  bucket: string;
  /** worktree 目录名（= 源仓库 basename）。 */
  name: string;
  /** <managedRoot>/<bucket>/<name> */
  worktreeRoot: string;
  /** 输入路径相对 worktreeRoot 的部分；输入就是根目录时为空串。 */
  relativePath: string;
}

export function resolveManagedWorktreeRoot(dataBaseDir: string): string {
  return join(dataBaseDir, ...MANAGED_WORKTREE_HOME_SEGMENTS);
}

export function isManagedWorktreeBucket(value: string): boolean {
  return BUCKET_PATTERN.test(value);
}

/**
 * 判断两个已规范化的绝对路径是否指向同一位置。path.relative 在 win32 上按大小写不敏感比较，
 * 因此 Windows 的盘符/大小写差异不需要手写处理。
 */
export function isSamePath(left: string, right: string): boolean {
  return relative(left, right) === "";
}

/** candidate 是否位于 parent 之内（含相等）。 */
export function isPathInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * 解析 <managedRoot>/<bucket>/<name>[/<relativePath>]。不符合两级布局时返回 null。
 * 调用方应先对 managedRoot 与 candidatePath 做 realpath，避免 symlink 绕过。
 */
export function parseManagedWorktreePath(
  managedRoot: string,
  candidatePath: string,
): ManagedWorktreePathParts | null {
  if (!isPathInside(managedRoot, candidatePath)) return null;
  const rel = relative(managedRoot, candidatePath);
  if (rel === "") return null;
  const segments = rel.split(sep).filter((segment) => segment.length > 0);
  const [bucket, name, ...rest] = segments;
  if (!bucket || !name || !isManagedWorktreeBucket(bucket)) return null;
  return {
    managedRoot,
    bucket,
    name,
    worktreeRoot: join(managedRoot, bucket, name),
    relativePath: rest.join(sep),
  };
}

/** worktree 目录名取源仓库 toplevel 的 basename。 */
export function managedWorktreeDirectoryName(sourceRoot: string): string {
  return basename(sourceRoot);
}

/**
 * worktree 任务的附加目录候选（docs/git/worktree.md §2.1）：位于源仓库内的 root 映射为 worktree 中
 * 对应的路径，其他 root 原样保留，并去掉 cwd 本身。是否存在由调用方检查。
 * Bug 防护：附加目录缺省规则是"roots 减 cwd"，对 worktree 任务会把源仓库本身交给 Agent，
 * 破坏隔离；因此 worktree 任务必须用这份列表显式固化。
 */
export function mapProjectRootsIntoWorktree(
  roots: readonly string[],
  input: { sourceRoot: string; worktreeRoot: string; cwd: string },
): string[] {
  const mapped = roots.map((root) =>
    isPathInside(input.sourceRoot, root)
      ? join(input.worktreeRoot, relative(input.sourceRoot, root))
      : root,
  );
  return [...new Set(mapped)].filter((path) => !isSamePath(path, input.cwd));
}
