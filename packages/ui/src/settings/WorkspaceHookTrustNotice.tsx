import type { Hook } from "@zcode/shared";
import { CircleAlert } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 与 HooksList 行内 Trust 按钮保持同一判定，避免风险提示形成第二套审核状态。 */
export function requiresWorkspaceHookTrust(hook: Hook): boolean {
  return Boolean(hook.workspaceHook) && hook.workspaceHook?.trustState !== "trusted_persistent";
}

export function hasWorkspaceHooksRequiringReview(hooks: readonly Hook[]): boolean {
  return hooks.some(requiresWorkspaceHookTrust);
}

export function shouldShowWorkspaceHookTrustNotice({
  hooks,
  loadedWorkspaceKey,
  rpcReady,
  targetWorkspaceKey,
}: {
  hooks: readonly Hook[];
  loadedWorkspaceKey: string | null;
  rpcReady: boolean;
  targetWorkspaceKey: string | null;
}): boolean {
  // hooksStore 是单例，切换 workspace 后连接阶段仍可能保留上一个
  // workspace 的 hooks。只有当前 target 已就绪且快照 key 对得上时才允许显示安全提示，
  // 避免把 A 的风险归因到正在连接的 B。
  return (
    rpcReady &&
    targetWorkspaceKey !== null &&
    loadedWorkspaceKey === targetWorkspaceKey &&
    hasWorkspaceHooksRequiringReview(hooks)
  );
}

/**
 * 仅展示当前 scope 的风险说明；审核、导航与开关交互仍由既有组件负责。
 * worktreeSourcePath：设置页按受管 worktree 发现声明时，说明信任记录与源仓库共用（D23）。
 */
export function WorkspaceHookTrustNotice({
  hooks,
  worktreeSourcePath,
}: {
  hooks: readonly Hook[];
  worktreeSourcePath?: string;
}) {
  const { intl } = useZCodeIntl();

  if (!hasWorkspaceHooksRequiringReview(hooks)) return null;

  return (
    <div
      role="note"
      data-testid="workspace-hook-trust-notice"
      className="flex w-full items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-ui-base text-foreground"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1">
        <p>{intl.formatMessage({ id: "settings.hooks.review.notice" })}</p>
        {worktreeSourcePath ? (
          <p
            data-testid="workspace-hook-worktree-notice"
            className="break-words text-ui-sm text-foreground-subtle"
          >
            {intl.formatMessage(
              { id: "settings.hooks.review.worktreeNotice" },
              { path: worktreeSourcePath },
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}
