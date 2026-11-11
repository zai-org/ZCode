// worktree 相关错误的本地化：只按结构化 code 选择文案，不解析 git 原始报错文本。
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

type ZCodeIntl = ReturnType<typeof useZCodeIntl>["intl"];

/** Host 抛出的错误前缀：任务行守卫 `project.worktree-*` 与编排服务 `worktree.*`。 */
const ERROR_PREFIXES = ["project.worktree-", "worktree."];
const KNOWN_CODES = new Set([
  "not-repository",
  "invalid-start-ref",
  "start-ref-missing-subdir",
  "bucket-exhausted",
  "worktree-dirty",
  "worktree-in-use",
  "not-managed",
  "local-only",
  "git-failed",
  "task-immovable",
  "unsupported-agent",
  "copy-failed",
  "session-failed",
  "carry-failed",
  "session-close-failed",
  "command-unconfirmed",
  "removing",
]);

/** 把 Host 抛出的 `project.worktree-<code>` 或结构化 code 映射为本地化提示。 */
export function formatManagedWorktreeError(intl: ZCodeIntl, error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const prefix = ERROR_PREFIXES.find((item) => message.startsWith(item));
  const code = prefix ? message.slice(prefix.length) : message;
  return KNOWN_CODES.has(code)
    ? intl.formatMessage({ id: `git.managedWorktree.error.${code}` })
    : intl.formatMessage({ id: "git.managedWorktree.error.generic" });
}
