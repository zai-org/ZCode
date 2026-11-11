import type { ReactNode } from "react";
import { Ban, ChevronRight, CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import { TID_WORKFLOW_RUN_ROW, type ZCodeSavedWorkflowRun } from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatDateTime } from "@/settings/automationFormat.js";
import { SavedWorkflowArtifactChips } from "@/settings/saved-workflows/SavedWorkflowArtifactChips.js";
import {
  formatSavedWorkflowRunArgs,
  formatSavedWorkflowTokens,
  savedWorkflowRunBadgeKind,
  savedWorkflowRunDurationMs,
} from "@/settings/saved-workflows/savedWorkflowRunHistory.js";

/** 详情页某一行运行记录对应的项目（全局工作流跨 cwd 时用；cwd 命中已打开项目才能「查看实例」）。 */
export interface SavedWorkflowRunProject {
  label: string;
  /** 完整 cwd 路径，挂在 title 上。 */
  title?: string;
  /** 该行 cwd 对应本地已打开项目 → 可「查看实例」。 */
  canOpen: boolean;
}

/** 详情页「运行历史」：journal 行（状态 / 时间 / 花费 / 实参），有归属字段的行可「查看实例」。 */
export function SavedWorkflowRunHistory({
  runs,
  now,
  canOpenRun,
  onOpenRun,
  onOpenArtifact,
  resolveRunProject,
}: {
  runs: readonly ZCodeSavedWorkflowRun[];
  now: number;
  canOpenRun: boolean;
  onOpenRun: (run: ZCodeSavedWorkflowRun) => void;
  /**
   * 产物 chip → `workflow-artifact` tab。
   * 缺席即 chips 只读。门比「查看实例」松一格：产物不需要 `toolCallId`。
   */
  onOpenArtifact?: (run: ZCodeSavedWorkflowRun, artifactId: string) => void;
  /** 传入即在每行渲染项目列（全局工作流跨项目历史）；「查看实例」还要该行 canOpen。 */
  resolveRunProject?: (run: ZCodeSavedWorkflowRun) => SavedWorkflowRunProject | null;
}) {
  const { intl } = useZCodeIntl();
  if (runs.length === 0) {
    return (
      <p className="text-ui-base text-foreground-subtlest">
        {intl.formatMessage({ id: "workflows.hub.history.empty" })}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border border-border">
        {runs.map((run, index) => {
          const kind = savedWorkflowRunBadgeKind(run.status);
          const project = resolveRunProject ? resolveRunProject(run) : null;
          const durationMs = savedWorkflowRunDurationMs(run, now);
          const totalSeconds = Math.round(durationMs / 1000);
          const minutes = Math.floor(totalSeconds / 60);
          const seconds = totalSeconds % 60;
          const duration =
            minutes > 0
              ? intl.formatMessage(
                  { id: "workflows.hub.time.duration.minutes" },
                  { minutes: String(minutes), seconds: String(seconds) },
                )
              : intl.formatMessage(
                  { id: "workflows.hub.time.duration.seconds" },
                  { seconds: String(seconds) },
                );
          const openable =
            canOpenRun &&
            Boolean(run.parentSessionId && run.toolCallId) &&
            (resolveRunProject ? (project?.canOpen ?? false) : true);
          // 产物 chip 的门：只要 `parentSessionId` 在场（老行可缺）+ 项目可打开。
          // `toolCallId` 不是条件——产物 tab 不回那条 CreateWorkflow 工具行。
          const artifactsOpenable =
            onOpenArtifact !== undefined &&
            Boolean(run.parentSessionId) &&
            (resolveRunProject ? (project?.canOpen ?? false) : true);
          const statusLabel = intl.formatMessage({ id: `workflows.hub.lastRun.${kind}` });
          let icon: ReactNode;
          let statusClass: string;
          switch (kind) {
            case "completed":
              icon = <CircleCheck className="size-4" strokeWidth={1.33} aria-hidden="true" />;
              statusClass = "text-success";
              break;
            case "errored":
              icon = <TriangleAlert className="size-4" strokeWidth={1.33} aria-hidden="true" />;
              statusClass = "text-destructive";
              break;
            case "running":
              icon = (
                <LoaderCircle
                  className="size-4 animate-spin"
                  strokeWidth={1.33}
                  aria-hidden="true"
                />
              );
              statusClass = "text-warning";
              break;
            default:
              icon = <Ban className="size-4" strokeWidth={1.33} aria-hidden="true" />;
              statusClass = "text-foreground-subtle";
          }
          return (
            <div
              key={run.runId}
              data-testid={testId(TID_WORKFLOW_RUN_ROW, run.runId)}
              className={cn(
                "grid grid-cols-[112px_minmax(0,1fr)_auto] items-center gap-4 px-3 py-2.5",
                index > 0 && "border-t border-border",
              )}
            >
              <span className={cn("inline-flex items-center gap-1.5 text-ui-base", statusClass)}>
                {icon}
                {statusLabel}
              </span>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-ui-base">
                <span className="text-foreground">{formatDateTime(run.createdAt)}</span>
                {resolveRunProject && project ? (
                  <span
                    data-workflow-run-project="true"
                    className="min-w-0 max-w-40 truncate text-foreground-subtle"
                    title={project.title ?? project.label}
                  >
                    {project.label}
                  </span>
                ) : null}
                <span className="text-foreground-subtle">
                  {duration} ·{" "}
                  {intl.formatMessage(
                    { id: "workflows.hub.history.tokens" },
                    { tokens: formatSavedWorkflowTokens(run.spentTokens) },
                  )}
                </span>
                {formatSavedWorkflowRunArgs(run.args).map((chip) => (
                  <span
                    key={chip}
                    className="rounded-xs border border-border px-1.5 py-0.5 font-mono text-ui-xs leading-none text-foreground-subtlest"
                  >
                    {chip}
                  </span>
                ))}
                {/*
                 * 这次运行交付的产物。
                 * ⚠ 术语：artifact = 脚本发布给用户看的产出，不是脚本的顶层返回值。
                 * 老行没有这个键（老 CLI 不发），整块因此缺席而不是画一个空位。
                 */}
                {run.artifacts === undefined ? null : (
                  <SavedWorkflowArtifactChips
                    artifacts={run.artifacts}
                    {...(artifactsOpenable
                      ? {
                          onOpenArtifact: (artifactId: string) => onOpenArtifact?.(run, artifactId),
                        }
                      : {})}
                  />
                )}
              </div>
              {openable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-icon="inline-end"
                  className="text-foreground-subtle"
                  onClick={() => onOpenRun(run)}
                >
                  {intl.formatMessage({ id: "workflows.hub.history.open" })}
                  <ChevronRight className="size-3" aria-hidden="true" />
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
            </div>
          );
        })}
      </div>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "workflows.hub.history.note" })}
      </p>
    </div>
  );
}
