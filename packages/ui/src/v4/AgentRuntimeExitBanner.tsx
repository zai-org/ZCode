import { memo, useCallback, useEffect, useState } from "react";
import type { ZCodeAgentRuntimeExitedEvent } from "@zcode/services";
import { resolveWorkspaceKey } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 当前 workspace 的后台 runtime（app-server）最近一次意外退出。
 *
 * 只是展示：进程崩溃时 CLI 来不及写下终态，回合、子代理的收口由重连后的 CLI 投影给出
 * （apps/zcode-cli/docs/design/v2/tool/07-subagent.md「上一代 runtime 遗留的 Agent」），这里不改写会话
 * 状态，只告诉用户发生了什么。手机远控的服务面没有该事件，不显示。
 */
export function useAgentRuntimeExitNotice(target: {
  workspacePath: string;
  workspaceIdentity?: string;
}): { exit: ZCodeAgentRuntimeExitedEvent | null; dismiss: () => void } {
  const { zcodeAgentService } = useServices();
  const [exit, setExit] = useState<ZCodeAgentRuntimeExitedEvent | null>(null);
  // 与 services 发布事件时同一个口径：identity 优先，否则路径。
  const workspaceKey = resolveWorkspaceKey(target);
  useEffect(() => {
    setExit(null);
    const subscription = zcodeAgentService.onAgentRuntimeExited?.((event) => {
      if (event.workspaceKey === workspaceKey) setExit(event);
    });
    return () => subscription?.dispose();
  }, [workspaceKey, zcodeAgentService]);
  const dismiss = useCallback(() => setExit(null), []);
  return { exit, dismiss };
}

export interface AgentRuntimeExitBannerProps {
  exit: ZCodeAgentRuntimeExitedEvent;
  onDismiss: () => void;
}

/**
 * 与 PendingCommandRecoveryBanner 同一种非阻断提示，只说明原因。重连失败时窗格换成订阅错误面板，
 * 横幅随它一起显示，「重新连接」用错误面板上的按钮，这里不再放第二个。
 */
export const AgentRuntimeExitBanner = memo(function AgentRuntimeExitBanner({
  exit,
  onDismiss,
}: AgentRuntimeExitBannerProps) {
  const { intl } = useZCodeIntl();
  return (
    <div
      role="status"
      data-testid="agent-runtime-exit-banner"
      data-exit-cause={exit.cause ?? "unknown"}
      className="mb-3 flex w-full shrink-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-ui-base text-foreground backdrop-blur-md"
    >
      <p className="min-w-0 flex-1">
        {intl.formatMessage({
          id:
            exit.cause === "native_out_of_memory"
              ? "chat.runtimeExit.outOfMemory"
              : "chat.runtimeExit.generic",
        })}
      </p>
      <button
        type="button"
        className="shrink-0 rounded-md px-2 py-1 text-foreground-subtle hover:bg-hover"
        onClick={onDismiss}
      >
        {intl.formatMessage({ id: "chat.runtimeExit.dismiss" })}
      </button>
    </div>
  );
});
