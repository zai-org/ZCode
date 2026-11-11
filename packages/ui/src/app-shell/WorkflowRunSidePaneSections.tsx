// ============================================================
// WorkflowRunSidePane 的分区子组件（状态头 / 终态结果区）
// ============================================================
// 从 WorkflowRunSidePane.tsx 拆出（eslint max-lines 400 行门）：面板文件承载
// 数据装配与交互接线，本文件承载纯展示分区。props 全是烹熟的视图值——不接触
// 投影、lease 或命令通道。

import { workflowRunStopReasonMessageId } from "@/components/workflow-graph/run-status-presentation.js";
import { memo, type ReactNode } from "react";
import type { WorkflowRunSaveSlots } from "@/project-workflow/WorkflowRunSaveControls.js";
import {
  ArrowUpRightIcon,
  ListIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  SquareIcon,
} from "lucide-react";
import type { WorkflowRunState, WorkflowRunUsage } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { workflowRunResultView } from "@/app-shell/workflowRunPanel.js";
import { workflowRunConcurrencyChip } from "@/app-shell/workflowRunThrottle.js";
import { WorkflowRunStatus } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { RunHolesWaitingChip } from "@/components/workflow-timeline/WorkflowHoleParts.js";
import { WorkflowTruncatedNotice } from "@/components/workflow-timeline/WorkflowTruncatedNotice.js";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";

const formatCount = (value: number): string => value.toLocaleString();

/**
 * 摘要行的模型段：run 能配置时它也是一枚按钮（悬停下划线），打开同一个「配置」弹层、锚在它自己身上；
 * 否则就是一段带 tooltip 的字。
 */
function SubagentModelSegment({
  children,
  className,
  configureOpen,
  onConfigureFrom,
  title,
}: {
  children: ReactNode;
  className?: string;
  configureOpen: boolean;
  onConfigureFrom?: (element: HTMLElement) => void;
  title: string;
}) {
  if (onConfigureFrom === undefined) {
    return (
      <span className={className} data-testid="workflow-run-subagent-model" title={title}>
        {children}
      </span>
    );
  }
  return (
    <button
      aria-expanded={configureOpen}
      aria-haspopup="dialog"
      className={`${className ?? ""} cursor-pointer rounded-sm text-left underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40`}
      data-testid="workflow-run-subagent-model"
      onClick={(event) => onConfigureFrom(event.currentTarget)}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

/**
 * 状态头：第一行是名字与控件（Configure、
 * Resume、Stop），第二行是灯与状态词 + 并发芯片——三枚按钮挤在状态旁边太满，状态因此单独成行。
 * 其下是 lineage 行与与聊天卡页脚**同文案**的摘要行——同一个 run 在两个面上必须说同一句话。
 * 摘要行素材缺席（图不可得，建不出时间线）时退回既有的用量行。
 */
export const WorkflowRunStatusHeader = memo(function WorkflowRunStatusHeader({
  cancellable,
  configureOpen = false,
  onCancel,
  onConfigureFrom,
  onOpenSuccessor,
  onResume,
  rejection,
  resumable,
  run,
  saveSlots,
  subagentModel,
  summaryParts,
  title,
  usage,
}: {
  cancellable: boolean;
  /** 「配置」弹层此刻开着（Configure 钮与模型段的 aria-expanded）。 */
  configureOpen?: boolean;
  onCancel: () => void;
  /**
   * 打开「配置」弹层、锚在点中的那个元素上。缺席即这个 run 不能配置：没有 Configure 钮，模型段只是字。
   */
  onConfigureFrom?: (element: HTMLElement) => void;
  /** 最近一次 Stop / Resume 被拒的解释；`detail` 是 ACK 携带的诊断。 */
  rejection?: { text: string; detail?: string };
  /** 打开替代了本 run 的后继（`run.supersededBy`）；宿主解析不到后继时缺席，那一行是静态文字。 */
  onOpenSuccessor?: () => void;
  onResume: () => void;
  resumable: boolean;
  run: WorkflowRunState | undefined;
  /**
   * 「已保存」芯片与「保存」/「再次运行」（docs/dynamic-workflow/transcript-and-notifications.md
   * 「Saving the run, and running it again」）。同一个 run 在完成卡与这里必须说同一句话，所以两处
   * 用的是同一个控制器造出来的这两个节点，本组件只负责摆位置：动词排在 Stop 之前，芯片在第二行。
   * `null` / 缺席即没有服务上下文（那时一个控件都不画）。
   */
  saveSlots?: WorkflowRunSaveSlots | null;
  /**
   * 这次 run 的子代理模型：`name` 是屏幕上的词，`title` 里是强度与规范串
   * （docs/dynamic-workflow/presentation.md「The run pane」）。状态头第一行不再摆模型芯片——
   * 模型是第二行的第一个词，摘要行与退化的用量行都由它开头。缺席即没有可说的。
   */
  subagentModel?: { name: string; title: string };
  /** 摘要行各段（`workflowSummaryParts`）；缺席时退回用量行。 */
  summaryParts: readonly string[] | undefined;
  title: string;
  usage: WorkflowRunUsage | undefined;
}) {
  const { intl, locale } = useZCodeIntl();
  const saveChip = saveSlots?.leading ?? null;
  const saveVerb = saveSlots?.trailing ?? null;
  const cancelLabel = intl.formatMessage({ id: "chat.toolCall.workflow.run.cancel" });
  const resumeLabel = intl.formatMessage({ id: "chat.toolCall.workflow.run.resume" });
  // 并发芯片（docs/dynamic-workflow/concurrency.md「What the user sees」）：生效的界（共享 cap 与
  // 本 run 的界取小）被压在界之下、或 run 有自己的界，且 run 能配置时在场；冷却是一个 deadline，
  // 所以有冷却时走秒针，让它自己过期。
  const cooldownActive = run?.concurrency?.cooldownMs !== undefined;
  const now = useNowTicker(cooldownActive);
  const concurrency = workflowRunConcurrencyChip(run, now);
  // lineage 行（docs/dynamic-workflow/presentation.md「The run pane」状态头）：修订出来的 run 说它改自谁，
  // 被替代的 run 指向后继。两者互斥不成立（一个修订 run 也可能再被替代），所以各自一行。
  const resumedFrom = run?.resumedFrom;
  const supersededBy = run?.supersededBy;

  return (
    <div className="shrink-0 border-b border-border px-4 py-3">
      <div className="flex items-center gap-2">
        {/* 运行名是标识符：等宽排印（DESIGN.md 把 font-mono 留给技术值）。 */}
        <span className="min-w-0 flex-1 truncate font-mono text-ui-base font-medium text-foreground">
          {title}
        </span>
        {/* Configure 排在 Resume / Stop 之前：打开「配置」弹层，锚在这枚钮下。 */}
        {onConfigureFrom === undefined ? null : (
          <Button
            aria-expanded={configureOpen}
            aria-haspopup="dialog"
            data-testid="workflow-run-configure"
            onClick={(event) => onConfigureFrom(event.currentTarget)}
            size="sm"
            type="button"
            variant="outline"
          >
            <SlidersHorizontalIcon className="size-3.5" />
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.configure" })}
          </Button>
        )}
        {/* Resume 只在可恢复时渲染（谓词见 isWorkflowRunResumable）：按钮的存在本身就是能力门控。 */}
        {resumable ? (
          <ControlHintTooltip
            title={intl.formatMessage({ id: "chat.toolCall.workflow.run.resumeHint" })}
            side="bottom"
          >
            <Button
              aria-label={resumeLabel}
              data-testid="workflow-run-resume"
              onClick={onResume}
              size="sm"
              type="button"
              variant="outline"
            >
              <RotateCcwIcon className="size-3.5" />
              {resumeLabel}
            </Button>
          </ControlHintTooltip>
        ) : null}
        {/* 「保存」/「再次运行」排在 Stop 之前：与完成卡表头同一个次序——先是「留下它」，
            最后才是「停掉它」。 */}
        {saveVerb}
        {/* Stop 与卡上那枚钮同图标（实心方块）：同一个动作在两个面上不能长得不一样。可用时提示
            带第二行「停下的运行可以恢复」——动词从「取消」改过来之后，要在按下去之前就说清楚
            这不是丢弃；不可用时只剩那句为什么不可用，没有第二行可说。 */}
        <ControlHintTooltip
          title={
            cancellable
              ? cancelLabel
              : intl.formatMessage({ id: "chat.toolCall.workflow.run.cancelDisabled" })
          }
          side="bottom"
          {...(cancellable
            ? { description: intl.formatMessage({ id: "chat.toolCall.workflow.run.stopHint" }) }
            : {})}
        >
          <Button
            aria-label={cancelLabel}
            data-testid="workflow-run-cancel"
            disabled={!cancellable}
            onClick={onCancel}
            size="sm"
            type="button"
            variant="outline"
          >
            <SquareIcon className="size-3.5 fill-current" />
            {cancelLabel}
          </Button>
        </ControlHintTooltip>
      </div>
      {/* 第二行：灯与状态词 + 并发芯片。run 不在投影里时两者都没有，整行缺席。 */}
      {run === undefined && concurrency === undefined && saveChip === null ? null : (
        <div
          className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2"
          data-testid="workflow-run-status-row"
        >
          {run ? <WorkflowRunStatus run={run} testId="workflow-run-status" /> : null}
          {/* 「{n} 处留白待补全」（docs/dynamic-workflow/presentation.md「Holes on the timeline」）：与卡上同一枚芯片。 */}
          <RunHolesWaitingChip run={run} testId="workflow-run-holes" />
          {/* 芯片跟在状态词之后：第一行三枚按钮已经很满，而它本来也不是一个动作。 */}
          {saveChip}
          {/* 「最大并发数 4」：这次 run 最多能有几个子代理同时在飞——治理器把共享桶压到了本 run 的界
            之下，或者用户给这次 run 定了自己的上限（高于或低于默认）。run 快慢的原因就在这里，一眼可见。
            跑在默认上、或 run 已不能配置（完成 / 被替代）时整块缺席。
            与状态徽标同形（border+text）、活动色：这是运行时在调节，不是故障。 */}
          {concurrency === undefined ? null : (
            <span
              className="shrink-0 rounded-xs border border-warning/60 px-1.5 py-0.5 font-mono text-ui-xs leading-none text-warning"
              data-testid="workflow-run-concurrency"
            >
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.run.concurrency.label" },
                { cap: String(concurrency.cap) },
              )}
              {concurrency.cooldownUntil === undefined
                ? null
                : ` · ${intl.formatMessage(
                    { id: "chat.toolCall.workflow.run.concurrency.cooldown" },
                    { time: new Date(concurrency.cooldownUntil).toLocaleTimeString(locale) },
                  )}`}
            </span>
          )}
        </div>
      )}

      {/* 被拒的 Stop / Resume：一句话 + 可选诊断。warning 而非 destructive——什么都没发生，不是坏了。 */}
      {rejection === undefined ? null : (
        <div
          className="mt-1.5 text-ui-xs text-warning"
          data-testid="workflow-run-rejection"
          role="status"
        >
          <span>{rejection.text}</span>
          {rejection.detail === undefined ? null : (
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-ui-xs text-foreground-subtle">
              {rejection.detail}
            </pre>
          )}
        </div>
      )}

      {resumedFrom === undefined ? null : (
        <div
          className="mt-1.5 flex min-w-0 items-baseline gap-2 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-run-amends"
        >
          <span className="shrink-0">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.amends" })}
          </span>
          <span className="min-w-0 truncate font-mono" title={resumedFrom}>
            {resumedFrom}
          </span>
        </div>
      )}
      {supersededBy === undefined ? null : onOpenSuccessor === undefined ? (
        <div
          className="mt-1.5 flex min-w-0 items-baseline gap-2 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-run-superseded-by"
        >
          <span className="shrink-0">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.supersededBy" })}
          </span>
          <span className="min-w-0 truncate font-mono" title={supersededBy}>
            {supersededBy}
          </span>
        </div>
      ) : (
        <button
          className="mt-1.5 flex min-w-0 cursor-pointer items-baseline gap-2 rounded-md text-left text-ui-xs text-foreground-subtle outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          data-testid="workflow-run-superseded-by"
          onClick={onOpenSuccessor}
          type="button"
        >
          <span className="shrink-0">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.supersededBy" })}
          </span>
          <span className="min-w-0 truncate font-mono" title={supersededBy}>
            {supersededBy}
          </span>
          <ArrowUpRightIcon aria-hidden className="size-3 shrink-0 self-center" />
        </button>
      )}

      {summaryParts !== undefined ? (
        <div
          className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm text-foreground-subtle"
          data-testid="workflow-run-usage"
        >
          <ListIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
          {summaryParts.map((part, i) => (
            <span className="flex items-center gap-x-2 tabular-nums" key={i}>
              {i > 0 ? (
                <span aria-hidden className="text-foreground-subtlest">
                  ·
                </span>
              ) : null}
              {i === 0 && subagentModel !== undefined ? (
                <SubagentModelSegment
                  configureOpen={configureOpen}
                  title={subagentModel.title}
                  {...(onConfigureFrom === undefined ? {} : { onConfigureFrom })}
                >
                  {part}
                </SubagentModelSegment>
              ) : (
                <span>{part}</span>
              )}
            </span>
          ))}
        </div>
      ) : usage ? (
        // 用量是观察面，没有上限可做分母：一行「用量：N tokens · M 步」，不画进度轨
        <div
          className="mt-2 flex items-baseline justify-between gap-2"
          data-testid="workflow-run-usage"
        >
          {/* 图不可得时摘要行整条缺席，模型不能跟着一起消失——它是用户给这次 run 定下的条件，
              与有没有图无关。所以它在这里也开头，和摘要行同一个词、同一个 tooltip。 */}
          <span className="flex min-w-0 items-baseline gap-2">
            {subagentModel === undefined ? null : (
              <SubagentModelSegment
                className="min-w-0 truncate text-ui-xs text-foreground-subtle"
                configureOpen={configureOpen}
                title={subagentModel.title}
                {...(onConfigureFrom === undefined ? {} : { onConfigureFrom })}
              >
                {intl.formatMessage(
                  { id: "chat.toolCall.workflow.run.subagentModel.label" },
                  { model: subagentModel.name },
                )}
              </SubagentModelSegment>
            )}
            <span className="shrink-0 text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "chat.toolCall.workflow.run.usage.label" })}
            </span>
          </span>
          <span className="font-mono text-ui-xs tabular-nums text-foreground">
            {intl.formatMessage(
              { id: "chat.toolCall.workflow.run.usage.value" },
              { tokens: formatCount(usage.spentTokens), steps: usage.nodesUsed },
            )}
          </span>
        </div>
      ) : null}
      {/* 摘要行下的那一句「仅展示 n/m 步的详情」，与卡上同一份实现：脊柱列的是实例表留住的
          那些，行里的数却已经把表外的算进来了——这一行说的正是这个差额。 */}
      <WorkflowTruncatedNotice className="mt-1.5" run={run} testId="workflow-run-truncated" />
    </div>
  );
});

/** 终态区：不可追踪提示 / 完成产物预览 / 失败与取消的错误面板。非对应终态时各自缺席。 */
export const WorkflowRunResultSections = memo(function WorkflowRunResultSections({
  result,
}: {
  result: ReturnType<typeof workflowRunResultView>;
}) {
  const { intl } = useZCodeIntl();

  return (
    <>
      {/* run 不在投影里：淘汰或冷启动前的 CLI。措辞只说"实时状态没了"，不暗示 run 消失。 */}
      {result.kind === "absent" ? (
        <div
          className="shrink-0 border-b border-border px-4 py-3"
          data-testid="workflow-run-untracked"
        >
          <div className="text-ui-base text-foreground">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.untracked.title" })}
          </div>
          <p className="mt-1 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.untracked.body" })}
          </p>
        </div>
      ) : null}

      {/* 结果 / 失败面板 */}
      {result.kind === "completed" ? (
        <div
          className="shrink-0 border-b border-border px-4 py-3"
          data-testid="workflow-run-result"
        >
          <div className="text-ui-xs font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.result.title" })}
          </div>
          {result.preview === undefined ? (
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "chat.toolCall.workflow.run.result.completedHint" })}
            </p>
          ) : (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-xs text-foreground">
              {result.preview}
            </pre>
          )}
        </div>
      ) : null}

      {result.kind === "error" ? (
        <div
          className="shrink-0 border-b border-destructive/40 px-4 py-3"
          data-testid="workflow-run-error"
        >
          <div className="text-ui-xs font-medium text-destructive">
            {intl.formatMessage({
              id:
                result.status === "stopped"
                  ? "chat.toolCall.workflow.run.result.stoppedTitle"
                  : "chat.toolCall.workflow.run.result.erroredTitle",
            })}
            {result.status === "stopped" && result.stopReason ? (
              <span
                className="font-normal text-foreground-subtle"
                data-testid="workflow-run-stop-reason"
              >
                {" · "}
                {intl.formatMessage({ id: workflowRunStopReasonMessageId(result.stopReason) })}
              </span>
            ) : null}
          </div>
          {/*
            投影写进 `error` 的是 `WorkflowErrorJson.message`——product-projection.ts 的
            run-settled 分支只取 `.message`（`code` 被丢掉），而引擎那些 message 是人话短句：
            「run 已取消」「typed ask 结束时未提交结果」「节点数超过上限 100」。所以这里按
            正文排版而不是等宽代码块（DESIGN.md 把 font-mono 留给路径/命令/代码/标识符/
            终端数据）。保留 pre-wrap 是为了万一 message 带换行不被折叠掉。
            这里给不出 `code`，面板上也不再有第二个落点：事件日志区已经撤走（2026-09-04
            用户指令，见 docs/dynamic-workflow/presentation.md），结构化载荷只留在 journal 里
            ——它的读者是模型与 CLI，不是坐在这块面板前的人。
          */}
          <p
            className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-ui-base text-foreground"
            data-testid="workflow-run-error-message"
          >
            {result.message ??
              intl.formatMessage({ id: "chat.toolCall.workflow.run.result.noError" })}
          </p>
        </div>
      ) : null}
    </>
  );
});
