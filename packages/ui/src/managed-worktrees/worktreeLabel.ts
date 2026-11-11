// worktree 显示名 `<仓库名> · <bucket>`（docs/git/worktree.md §3.7），只由任务的 worktree 根目录
// （tasks-index worktree_root）推导：受管布局为 <受管根>/<bucket>/<仓库名>。
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

type ZCodeIntl = ReturnType<typeof useZCodeIntl>["intl"];

export function formatWorktreeLabel(
  intl: ZCodeIntl,
  worktreeRoot: string | undefined,
): string | null {
  if (!worktreeRoot) return null;
  // Windows 路径与 POSIX 路径都按两种分隔符切分；结尾分隔符不影响结果。
  const segments = worktreeRoot.split(/[\\/]+/).filter(Boolean);
  const name = segments.at(-1);
  const bucket = segments.at(-2);
  return name && bucket
    ? intl.formatMessage({ id: "git.managedWorktree.name" }, { repo: name, bucket })
    : null;
}
