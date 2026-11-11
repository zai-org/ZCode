import type { RemoteConnectionProgress } from "@/remote-connection-flow/contract.js";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AlertTriangleIcon, LoaderCircle } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveRemoteConnectionPhases } from "@/remote-connection/RemoteConnectionConnectingStep.js";
import { formatRemoteLinkRailTarget } from "@/remote-connection/RemoteLinkRail.js";
import { cn } from "@/components/lib/utils.js";

const ProgressContext = createContext<RemoteConnectionProgress | null>(null);
const PublishProgressContext = createContext<
  ((progress: RemoteConnectionProgress | null) => void) | null
>(null);

export function RemoteConnectionProgressProvider({ children }: { children: ReactNode }) {
  const [progress, publish] = useState<RemoteConnectionProgress | null>(null);
  // 发布方只订阅稳定的命令，不能订阅自己的显示结果；否则新日志引用会形成 render/effect 回环。
  return (
    <PublishProgressContext value={publish}>
      <ProgressContext value={progress}>{children}</ProgressContext>
    </PublishProgressContext>
  );
}
export function useRemoteConnectionProgress() {
  return useContext(ProgressContext);
}
export function usePublishRemoteConnectionProgress(progress: RemoteConnectionProgress | null) {
  const publish = useContext(PublishProgressContext);
  useEffect(() => {
    publish?.(progress);
  }, [publish, progress]);
  useEffect(() => () => publish?.(null), [publish]);
}

/**
 * 后台连接进度的唯一摘要：进度块与设置页设备行共用，避免两处各算一份阶段和百分比。
 * waiting 只在连接仍在进行且没有失败时成立，表示流程停下来等用户补充信息或确认。
 */
export function summarizeRemoteConnectionProgress(
  progress: Pick<
    RemoteConnectionProgress,
    "view" | "cancelled" | "ready" | "logs" | "workspacePath" | "error" | "waiting"
  >,
) {
  const phases = resolveRemoteConnectionPhases(progress.logs, {
    includeWorkspace: Boolean(progress.workspacePath),
  });
  const active =
    phases.find((phase) => phase.status === "active" || phase.status === "failed") ?? phases[0]!;
  const percent = Math.round(
    (phases.filter((phase) => phase.status === "complete").length / phases.length) * 100,
  );
  const progressing = progress.view === "connecting" && !progress.cancelled && !progress.ready;
  return {
    active,
    percent,
    progressing,
    waiting: progressing && progress.waiting && !progress.error,
  };
}

export function RemoteConnectionMinimizedProgress(props: RemoteConnectionProgress) {
  const { view, cancelled, target, name, error, reason, waiting, onResume, onCancel, ready } =
    props;
  const { intl } = useZCodeIntl();
  const { active, percent, progressing } = summarizeRemoteConnectionProgress(props);
  const device = name ?? (target ? formatRemoteLinkRailTarget(target) : "");
  const title = intl.formatMessage(
    {
      id: ready
        ? "remote.background.ready"
        : error
          ? "remote.minimized.failed"
          : cancelled
            ? "remote.connectionCancelled"
            : progressing
              ? "remote.minimized.connecting"
              : `remote.minimized.${view}`,
    },
    { device },
  );
  return (
    <div data-background-connection className="px-4 pb-3">
      <button
        type="button"
        data-testid="remote-connection-minimized"
        onClick={onResume}
        className={cn(
          "my-2 w-full rounded-lg border border-border p-2 text-left",
          error
            ? "bg-destructive-surface text-destructive-surface-foreground"
            : progressing
              ? "bg-progress-surface text-progress-surface-foreground"
              : "bg-surface text-foreground",
        )}
      >
        <span className="flex items-center gap-2 text-ui-sm font-medium">
          {error ? (
            <AlertTriangleIcon className="size-3.5 shrink-0" />
          ) : progressing ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
          ) : null}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {!error && progressing ? <span>{percent}%</span> : null}
        </span>
        <span className="mt-1 block break-words text-ui-sm">
          {(error ? `${error} · ${reason}` : "") ||
            intl.formatMessage({
              id: !progressing
                ? "remote.minimized.resume"
                : waiting
                  ? "remote.minimized.waiting"
                  : active.titleId,
            })}
        </span>
        {!error && progressing ? (
          <span
            role="progressbar"
            aria-label={title}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="mt-2 block h-1 overflow-hidden rounded-full bg-border"
          >
            <span
              className="block h-full bg-progress-surface-foreground"
              style={{ width: `${percent}%` }}
            />
          </span>
        ) : null}
        <span className="mt-1 block text-ui-sm underline">
          {intl.formatMessage({
            id: ready ? "remote.background.continue" : "remote.background.review",
          })}
        </span>
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="text-ui-sm text-foreground-subtle hover:text-foreground underline"
      >
        {intl.formatMessage({ id: ready ? "common.close" : "remote.background.cancel" })}
      </button>
    </div>
  );
}
