import { ArrowUpRightIcon } from "lucide-react";
import { useMemo } from "react";
import { WORKFLOW_CARD_ICON } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";

/**
 * 已接进 run 的补全行（docs/dynamic-workflow/presentation.md「The fill row」）：「留白已补全 {name} {k} 个阶段 {m} 个子代理 ↗」。计数是这次补全**写下**的，不是整条 run 的；留白的类型不上界面。
 */
export interface WorkflowFillSummary {
  name: string;
  phases: number;
  agents: number;
}

export function WorkflowToolSummary({
  toolCallId,
  summary,
  onOpen,
  amend = false,
  fill,
}: {
  toolCallId: string;
  summary: WorkflowRunCardSummary;
  onOpen?: () => void;
  /** AmendWorkflow 发起行：种类词换成「工作流已调整」。 */
  amend?: boolean;
  /** FillWorkflowHole 行：留白词汇与补全的计数；在场时 `amend` 不看。 */
  fill?: WorkflowFillSummary;
}) {
  const { intl } = useZCodeIntl();
  // ToolLayout 是 memo 组件：primaryText 若是内联 JSX，每次渲染都会打破 memo（reactStableReferences 测试会拦下）。
  // 计数只说子代理；宿主没给子代理数时那一段留空，只剩 ↗。
  const agents = fill === undefined ? summary.agents : fill.agents;
  const primaryText = useMemo(
    () => (
      <span className="inline-flex min-w-0 items-center gap-2">
        {fill === undefined ? null : (
          <>
            <span className="min-w-0 truncate" data-testid="workflow-summary-hole-name">
              {fill.name}
            </span>
            <span data-testid="workflow-summary-hole-phases">
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.hole.phasesAdded" },
                { count: fill.phases },
              )}
            </span>
          </>
        )}
        <span
          data-testid="workflow-summary-agents"
          className="inline-flex items-center gap-2 text-foreground-subtlest"
        >
          {agents === undefined
            ? null
            : intl.formatMessage(
                {
                  id:
                    agents === 1
                      ? "chat.toolCall.workflow.card.agent"
                      : "chat.toolCall.workflow.card.agents",
                },
                { count: agents },
              )}
          {onOpen ? (
            <ArrowUpRightIcon
              data-summary-chevron
              aria-hidden
              className="size-4 shrink-0 text-foreground-subtle opacity-0 transition-opacity group-hover/tool-summary:opacity-100 group-focus-visible/tool-summary:opacity-100"
            />
          ) : null}
        </span>
      </span>
    ),
    [agents, fill, intl, onOpen],
  );
  const kindId =
    fill !== undefined
      ? "chat.toolCall.workflow.hole.filled"
      : amend
        ? "chat.toolCall.workflow.amend.amended"
        : "chat.toolCall.workflow.ran";
  return (
    <div
      data-testid="workflow-tool-summary"
      data-tool-call-id={toolCallId}
      data-workflow-run-id={summary.runId}
    >
      <ToolLayout
        toolId={toolCallId}
        icon={WORKFLOW_CARD_ICON}
        kindLabel={intl.formatMessage({ id: kindId })}
        canToggle={false}
        primaryText={primaryText}
        summaryAction={
          onOpen
            ? {
                ariaLabel: intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" }),
                onActivate: onOpen,
              }
            : undefined
        }
      />
    </div>
  );
}
