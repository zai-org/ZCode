import { useMemo, type ReactNode } from "react";
import type { ToolCallCreateWorkflowDisplay } from "@zcode/shared/zcode-protocol-v4";
import { CodeBlock, CodeBlockHeader } from "@/components/ai-elements/code-block.js";
import { cn } from "@/components/lib/utils.js";
import { DRAFT_FEEDBACK_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowDraftPosition } from "@/ToolCallBlocks/shared.js";
import {
  formatWorkflowFeedbackTooltip,
  workflowDiagnosticLines,
} from "@/ToolCallBlocks/renderers/createWorkflowDisplay.js";
import {
  WorkflowDiagnosticsSection,
  workflowFeedbackLedeMessageId,
} from "@/ToolCallBlocks/renderers/workflow-diagnostics.js";

/**
 * 编译反馈行在 ToolLayout 各槽位里说的话。
 * 从 `create-workflow.tsx` 拆出（oxlint max-lines 400 门，同 `createWorkflowInput.ts` 先例）。
 *
 * 只用行已有的槽位——种类词、名字、细节、状态——不往对话里加新元素：上一轮通知重设计在真机里被判
 * 「花」，正是因为引入了新的视觉语法。
 */
interface WorkflowDraftRowSlots {
  /** 细节槽：「第 n 稿」。 */
  secondaryText: ReactNode | undefined;
  /** 状态词「n 处待修正 未运行」，编不过时才有。 */
  statusLabel: ReactNode | undefined;
  /** 状态词前的空环灯，编不过时才有。 */
  statusIndicator: ReactNode | undefined;
  /** 悬停提示：那句话 + 逐条诊断；编不过时才有。 */
  statusTooltip: string | undefined;
  /** 在途行（校验中的卡片表头）从第 2 稿起写在细节位的稿号文字。 */
  inFlightOrdinalText: string | undefined;
}

interface WorkflowDraftRowInput {
  draft: WorkflowDraftPosition | undefined;
  compileErrors: boolean;
  /** 在途行（编写、待确认）：第 2 稿起才编号，第 1 稿不预告还会有第 2 稿。 */
  inFlight: boolean;
  errorCount: number;
  diagnostics: readonly { line: number; column: number; message: string }[];
  saved: boolean;
}

export function useWorkflowDraftRowSlots({
  draft,
  compileErrors,
  inFlight,
  errorCount,
  diagnostics,
  saved,
}: WorkflowDraftRowInput): WorkflowDraftRowSlots {
  const { intl } = useZCodeIntl();
  const ordinal = workflowDraftOrdinalShown(draft, { compileErrors, inFlight });
  const inFlightOrdinal = workflowDraftOrdinalShown(draft, { compileErrors: false, inFlight });
  const inFlightOrdinalText =
    inFlightOrdinal === undefined
      ? undefined
      : intl.formatMessage(
          { id: "chat.toolCall.workflow.draftOrdinal" },
          { ordinal: String(inFlightOrdinal) },
        );
  const superseded = draft?.superseded === true;
  const lede = intl.formatMessage({ id: workflowFeedbackLedeMessageId(saved) });
  const words = compileErrors
    ? intl.formatMessage({ id: "chat.toolCall.workflow.toFix" }, { count: errorCount })
    : undefined;
  const notRun = intl.formatMessage({ id: "chat.toolCall.workflow.notRun" });

  // ToolLayout 是 memo 组件：交给它的节点必须按值记忆，否则每次父级渲染都会整行重渲染。
  const secondaryText = useMemo(
    () => (ordinal === undefined ? undefined : <WorkflowDraftOrdinal ordinal={ordinal} />),
    [ordinal],
  );
  const statusLabel = useMemo(
    () =>
      words === undefined ? undefined : (
        <span data-testid="workflow-draft-status" className="inline-flex items-center gap-2">
          <span>{words}</span>
          <span>{notRun}</span>
        </span>
      ),
    [words, notRun],
  );
  const statusIndicator = useMemo(
    () => (compileErrors ? <WorkflowDraftLamp superseded={superseded} /> : undefined),
    [compileErrors, superseded],
  );
  const statusTooltip = useMemo(
    () => (compileErrors ? formatWorkflowFeedbackTooltip(lede, diagnostics) : undefined),
    [compileErrors, diagnostics, lede],
  );
  return { secondaryText, statusLabel, statusIndicator, statusTooltip, inFlightOrdinalText };
}

/**
 * 反馈行展开后的内容：脚本（带行号，被诊断点名的行号着警示色）、编译反馈卡；没有 display 时退回
 * 纯文本输出。待确认行复用同一块（那时没有诊断，只有脚本）。
 */
export function WorkflowFeedbackContent({
  display,
  fallbackOutputText,
  saved,
  scriptText,
}: {
  display: ToolCallCreateWorkflowDisplay | null;
  fallbackOutputText: string | null;
  saved: boolean;
  scriptText: string | undefined;
}) {
  // 按内容记忆：display 不变就是同一个数组，代码块的注入样式不会跟着重建。
  const flaggedLines = useMemo(
    () => (display?.ok === false ? workflowDiagnosticLines(display.diagnostics) : undefined),
    [display],
  );
  return (
    <div className="mb-2 space-y-3">
      {scriptText ? (
        <div data-testid="workflow-script-codeblock">
          <CodeBlock
            className="border border-border bg-card"
            contentClassName="max-h-80 overflow-auto"
            code={scriptText}
            language="typescript"
            showLineNumbers
            {...(flaggedLines === undefined ? {} : { markedLines: flaggedLines })}
          >
            <CodeBlockHeader className="pl-3 pr-2 pt-2" language="typescript" />
          </CodeBlock>
        </div>
      ) : null}
      {display && display.diagnostics.length > 0 ? (
        <WorkflowDiagnosticsSection
          count={display.errorCount}
          diagnostics={display.diagnostics}
          saved={saved}
          truncated={display.truncated}
        />
      ) : null}
      {!display && fallbackOutputText ? (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-panel px-3 py-2 font-mono text-ui-base text-foreground-subtle">
          {fallbackOutputText}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * 细节槽里要不要写稿号：编不过的行总是写（宿主给了位置时）；在途行从第 2 稿起写。
 * 运行卡、启动摘要与确认窗不走这里，永远不带稿号。
 */
export function workflowDraftOrdinalShown(
  draft: WorkflowDraftPosition | undefined,
  phase: { compileErrors: boolean; inFlight: boolean },
): number | undefined {
  if (draft === undefined) return undefined;
  if (phase.compileErrors) return draft.ordinal;
  return phase.inFlight && draft.ordinal >= 2 ? draft.ordinal : undefined;
}

export function WorkflowDraftOrdinal({ ordinal }: { ordinal: number }) {
  const { intl } = useZCodeIntl();
  return (
    <span className="shrink-0 whitespace-nowrap tabular-nums" data-testid="workflow-draft-ordinal">
      {intl.formatMessage(
        { id: "chat.toolCall.workflow.draftOrdinal" },
        { ordinal: String(ordinal) },
      )}
    </span>
  );
}

/**
 * 空环灯：形状说「什么都没跑」，颜色说注意力是否还悬着（最新一稿警示色，有更新的一稿后褪成中性）。
 * `wf-lamp` 让颜色的变化走过渡，而不是一跳。
 */
export function WorkflowDraftLamp({ superseded }: { superseded: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "wf-lamp size-2 shrink-0 rounded-full",
        superseded ? DRAFT_FEEDBACK_DOT.settled : DRAFT_FEEDBACK_DOT.open,
      )}
      data-draft-lamp={superseded ? "settled" : "open"}
      data-testid="workflow-draft-lamp"
    />
  );
}
