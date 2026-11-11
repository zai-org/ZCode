import { SubagentCollectionIcon } from "@/components/workflow-timeline/WorkflowAgentFace.js";
import { memo, useMemo } from "react";
import { ActivityIcon, SquareTerminalIcon, Workflow } from "lucide-react";
import { TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER } from "@zcode/shared/test-ids";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface ComposerBackgroundWorkCounts {
  bashCount: number;
  workflowCount: number;
  subagentCount: number;
  totalCount: number;
}

export function getComposerBackgroundWorkCounts(
  backgroundWorks: readonly BackgroundWorkSummary[],
  runningSubagentCount = 0,
): ComposerBackgroundWorkCounts {
  let bashCount = 0;
  let workflowCount = 0;
  for (const work of backgroundWorks) {
    if (work.status !== "running") continue;
    if (work.kind === "bash") {
      bashCount += 1;
    } else if (work.kind === "workflow") {
      // workflow run 单独计数，不并入 bashCount。totalCount 汇总三类后台工作，
      // 确保只有 workflow run 时也显示 badge，用户仍能打开面板使用停止按钮。
      workflowCount += 1;
    }
  }
  const subagentCount = Math.max(0, runningSubagentCount);
  return {
    bashCount,
    workflowCount,
    subagentCount,
    totalCount: bashCount + workflowCount + subagentCount,
  };
}

export interface ConversationBackgroundWorkTriggerProps {
  backgroundWorks: readonly BackgroundWorkSummary[];
  runningSubagentCount?: number;
  onOpen?: () => void;
  /**
   * onOpen 的落点：
   * `"workflow-run"` 时 tooltip 说的是「打开工作流详情」，否则沿用按类型的「打开运行中的…」。
   * 判定归宿主（要 toolCallId 与宿主回调，徽标看不到），这里只如实自述。
   */
  openTarget?: "panel" | "workflow-run";
}

function ConversationBackgroundWorkTriggerImpl({
  backgroundWorks,
  runningSubagentCount = 0,
  onOpen,
  openTarget = "panel",
}: ConversationBackgroundWorkTriggerProps) {
  const { intl } = useZCodeIntl();
  const counts = useMemo(
    () => getComposerBackgroundWorkCounts(backgroundWorks, runningSubagentCount),
    [backgroundWorks, runningSubagentCount],
  );

  if (!onOpen || counts.totalCount === 0) return null;

  // 恰好一类时用该类文案，否则混合：三类两两组合各写一句会堆出六条同义 tooltip，
  // 而 badge 的作用只是「有实时活动，点开看」，不承担精确枚举。
  const activeKindCount = [counts.bashCount, counts.workflowCount, counts.subagentCount].filter(
    (count) => count > 0,
  ).length;
  const tooltip = intl.formatMessage({
    id:
      openTarget === "workflow-run"
        ? "chat.composer.backgroundWorks.tooltipWorkflowDetails"
        : activeKindCount > 1
          ? "chat.composer.backgroundWorks.tooltipMixed"
          : counts.bashCount > 0
            ? "chat.composer.backgroundWorks.tooltipTerminal"
            : counts.workflowCount > 0
              ? "chat.composer.backgroundWorks.tooltipWorkflow"
              : "chat.composer.backgroundWorks.tooltipAgent",
  });
  const ariaLabel = intl.formatMessage(
    { id: "chat.composer.backgroundWorks.ariaLabel" },
    {
      bashCount: String(counts.bashCount),
      workflowCount: String(counts.workflowCount),
      subagentCount: String(counts.subagentCount),
      count: String(counts.totalCount),
    },
  );

  return (
    <ControlHintTooltip title={tooltip}>
      <Button
        type="button"
        variant="ghost"
        size="default"
        data-testid={TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER}
        data-background-bash-count={counts.bashCount}
        data-background-workflow-count={counts.workflowCount}
        data-background-subagent-count={counts.subagentCount}
        data-background-total-count={counts.totalCount}
        data-background-open-target={openTarget}
        aria-label={ariaLabel}
        onClick={onOpen}
        className="rounded-lg px-1.5 text-ui-base text-[var(--color-foreground-subtle)] tabular-nums"
      >
        <span
          data-composer-background-layout="typed"
          className="inline-flex items-center gap-1 @max-[480px]/composer:hidden"
          aria-hidden
        >
          {/* 终端在前，保持 workflow 拆出之前的视觉次序不变；workflow 插在终端与智能体之间。 */}
          {counts.bashCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <SquareTerminalIcon className="size-3.5" />
              <span>{counts.bashCount}</span>
            </span>
          ) : null}
          {counts.workflowCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <Workflow className="size-3.5" />
              <span>{counts.workflowCount}</span>
            </span>
          ) : null}
          {counts.subagentCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              {/* 覆盖头像默认 20px 最小尺寸，与紧凑标签保持一致。 */}
              <SubagentCollectionIcon className="size-3.5 min-h-3.5! min-w-3.5!" />
              <span>{counts.subagentCount}</span>
            </span>
          ) : null}
        </span>
        <span
          data-composer-background-layout="compact"
          className="hidden items-center gap-0.5 @max-[480px]/composer:inline-flex"
          aria-hidden
        >
          <ActivityIcon className="size-3.5" />
          <span>{counts.totalCount}</span>
        </span>
      </Button>
    </ControlHintTooltip>
  );
}

export const ConversationBackgroundWorkTrigger = memo(ConversationBackgroundWorkTriggerImpl);
