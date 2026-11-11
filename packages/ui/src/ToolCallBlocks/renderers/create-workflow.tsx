import { ChevronRightIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { WorkflowArtifactStrip } from "@/components/workflow-timeline/WorkflowArtifactStrip.js";
import type {
  TimelinePill,
  TimelineStation,
} from "@/components/workflow-timeline/timeline-model.js";
import { workflowCardDetail } from "@/components/workflow-timeline/timeline-summary.js";
import {
  WORKFLOW_CARD_ICON,
  WorkflowCardFooter,
  WorkflowCardHeader,
  WorkflowRunStatus,
  WorkflowStaticStatus,
  workflowRunKindMessageId,
} from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import { isAmendWorkflowToolCall } from "@/lib/workflowToolNames.js";
import {
  useWorkflowCardModel,
  useWorkflowHoleRow,
  useWorkflowRowPrimaryText,
} from "@/ToolCallBlocks/renderers/workflow-fill-row.js";
import {
  isPlainRecord,
  readWorkflowAmendTarget,
  readWorkflowCardKeptScript,
  readWorkflowKindMessageId,
  readWorkflowName,
  readWorkflowPrelaunchKindMessageId,
  readWorkflowRetuneCall,
  readWorkflowSaved,
  readWorkflowScript,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
export { readWorkflowKindMessageId } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  readFallbackOutputText,
  readWorkflowDisplay,
} from "@/ToolCallBlocks/renderers/createWorkflowDisplay.js";
import {
  WorkflowAmendsLine,
  WorkflowCardMetaLine,
} from "@/ToolCallBlocks/renderers/WorkflowCardMetaLine.js";
import { WorkflowDiagnosticsSection } from "@/ToolCallBlocks/renderers/workflow-diagnostics.js";
import {
  useWorkflowDraftRowSlots,
  WorkflowFeedbackContent,
} from "@/ToolCallBlocks/renderers/workflow-draft-row.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

/** 没有 display 时交给草稿槽位的空诊断：模块级常量，免得每次渲染一个新数组打穿记忆。 */
const NO_DIAGNOSTICS: readonly never[] = [];

/** 折叠状态按 toolId 记忆（与 ToolLayout 的 toolLayoutOpenState 同一模式）；默认展开。 */
const workflowCardOpenState = new Map<string, boolean>();

/**
 * 聊天区的 CreateWorkflow / AmendWorkflow 工具卡。
 *
 * 编写中使用不可展开的 ToolLayout，行下常驻草稿阶段线（站随脚本流式写出）；待确认使用可展开脚本的 ToolLayout；编不过是编译反馈行
 * （「工作流草稿 · 第 n 稿 · n 处待修正 未运行」，状态两词以 gap 分隔）——不是失败，什么都没跑。
 * v4 已关联 run 的上方行由 WorkflowToolSummary 承载。本组件保留旧宿主的运行卡渲染。
 *
 * AmendWorkflow 行走**同一个**渲染器（display kind 同为 `create_workflow`，图、草稿笔与诊断卡只有一份
 * 实现），只换修订词汇，并在卡体多一行「调整自 run X」——按工具名判，不看 family。
 */
export function CreateWorkflowToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const amend = isAmendWorkflowToolCall(toolCall);
  const amendTarget = amend ? readWorkflowAmendTarget(toolCall.input) : undefined;
  // 留白补全行（docs/dynamic-workflow/presentation.md「The fill row」）：同一个渲染器换留白词汇（workflow-fill-row.tsx）。
  const { fill, holeTarget, vocabulary } = useWorkflowHoleRow(toolCall, amend);

  const display = useMemo(() => readWorkflowDisplay(toolCall.raw), [toolCall.raw]);
  // 在途的词（docs/dynamic-workflow/concurrency.md）：只改并发上限的调用不写脚本、也不编译，
  // 「正在校验工作流」对它不成立。整行退成设置行是**结算之后**的事，由接线层按同一个入参形状裁
  // （ConversationRowView），这里只管在途这几个词。
  const retuning = amend && readWorkflowRetuneCall(toolCall.input) !== undefined;
  const scriptText = useMemo(() => readWorkflowScript(toolCall.input), [toolCall.input]);
  const workflowName = readWorkflowName(toolCall.input);
  const saved = useMemo(() => readWorkflowSaved(toolCall.input), [toolCall.input]);
  const fallbackOutputText = display ? null : readFallbackOutputText(toolCall.output);
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const name = fill
    ? (holeTarget?.name ?? holeTarget?.holeId ?? fallbackName)
    : (workflowName ?? fallbackName);

  const workflowRun = context.workflowRun;
  const run = workflowRun?.run;
  const hasCompileErrors = display?.ok === false;
  const showFailureStatus = hasCompileErrors || (!display && toolCall.status === "failed");
  const draft = context.workflowDraft;

  // 空图（脚本里一次 ask / files.* 都没有）不值得一条空轨道；有 step 才建模型。
  const graph =
    display?.causalityGraph !== undefined && display.causalityGraph.steps.length > 0
      ? display.causalityGraph
      : undefined;
  const v4Status = isPlainRecord(toolCall.raw) ? toolCall.raw.v4Status : undefined;
  const writing = context.isRunning && v4Status === "inputStreaming";
  // 沿用前驱脚本的修订：行上的入参是模型发出的
  // 那一份，`script` 与 `path` 都没有就是省略了脚本（`path` 修订不带 `script`，却是改过的脚本）
  // ——只在入参写完之后才这么说，流式中脚本可能还没到。缺脚本是这次
  // 调用的用意：lineage 行说「脚本不变」，「未提供脚本」的提示不出现。
  const keptScript = amend && !writing && readWorkflowCardKeptScript(toolCall);
  const inFlight = context.isRunning && workflowRun === undefined;
  const draftSlots = useWorkflowDraftRowSlots({
    draft,
    compileErrors: hasCompileErrors,
    inFlight,
    errorCount: display?.errorCount ?? 0,
    diagnostics: display?.diagnostics ?? NO_DIAGNOSTICS,
    saved: saved !== undefined,
  });

  // 有图按图（补全行收窄到补全那一截），流式中按草稿扫描；display 一到整个模型被替换。
  const model = useWorkflowCardModel({ graph, holeTarget, run, scriptText, writing });

  const [isOpen, setIsOpen] = useState(() => workflowCardOpenState.get(toolCall.toolId) ?? true);
  const forceOpen = context.forceOpen ?? false;
  const canToggle = context.canToggle ?? true;
  const expanded = forceOpen || !canToggle || isOpen;
  const handleToggle = useCallback(() => {
    setIsOpen((previous) => {
      workflowCardOpenState.set(toolCall.toolId, !previous);
      return !previous;
    });
  }, [toolCall.toolId]);
  const [scriptOpen, setScriptOpen] = useState(false);

  const onOpenWorkflowRun = context.onOpenWorkflowRun;
  const named = useMemo(() => (workflowName === undefined ? {} : { workflowName }), [workflowName]);
  const handleOpenRunDetails = useCallback(
    () => onOpenWorkflowRun?.(named),
    [onOpenWorkflowRun, named],
  );
  // 站头与「还有 n 个」那一行交出站 id：详情页落到这一站、把清单展开。
  const handleSelectStation = useCallback(
    (station: TimelineStation) => onOpenWorkflowRun?.({ ...named, phaseId: station.id }),
    [onOpenWorkflowRun, named],
  );
  const onResumeWorkflowRun = context.onResumeWorkflowRun;
  const handleResume = useCallback(() => {
    onResumeWorkflowRun?.(workflowName === undefined ? {} : { workflowName });
  }, [onResumeWorkflowRun, workflowName]);
  // 点一枚药丸直接开那个子代理的 transcript。卡片只交出槽位身份
  // （还没启动的药丸也可开，会话 id 有则随行），会话与 workspace 身份由宿主补齐。
  const onOpenWorkflowActor = context.onOpenWorkflowActor;
  const onOpenWorkflowWorkspace = context.onOpenWorkflowWorkspace;
  const onOpenWorkflowArtifact = context.onOpenWorkflowArtifact;
  const runId = workflowRun?.runId;
  // 脚本药丸：交出这一站的阶段 id，run 与会话
  // 身份由宿主绑定（与 onOpenWorkflowRun 同一条路）。
  const handleOpenWorkspace = useCallback(
    (pill: TimelinePill) => {
      const phaseId = pill.workspace?.phaseId;
      if (phaseId === undefined) return;
      onOpenWorkflowWorkspace?.({
        phaseId,
        ...(workflowName === undefined ? {} : { workflowName }),
      });
    },
    [onOpenWorkflowWorkspace, workflowName],
  );
  const handleOpenPill = useCallback(
    (pill: TimelinePill) => {
      const slot = pill.slot;
      if (runId === undefined || slot === undefined) return;
      const sessionId = pill.instance?.sessionId;
      const actorName = pill.runtimeName ?? pill.lane.name;
      onOpenWorkflowActor?.({
        ordinal: slot.ordinal,
        runId,
        siteId: slot.siteId,
        ...(sessionId === undefined ? {} : { actorSessionId: sessionId }),
        ...(actorName === undefined ? {} : { actorName }),
      });
    },
    [onOpenWorkflowActor, runId],
  );

  // ToolLayout 是 memo 组件：交给它的节点与回调必须引用稳定（reactStableReferences 守卫）。
  const diagnosticsPrimaryText = useWorkflowRowPrimaryText(fill, name);
  const renderDiagnosticsContent = useCallback(
    () => (
      <WorkflowFeedbackContent
        display={display}
        fallbackOutputText={fallbackOutputText}
        saved={saved !== undefined}
        scriptText={scriptText}
      />
    ),
    [display, fallbackOutputText, saved, scriptText],
  );

  const snapshotNotice = (
    <ToolSnapshotFieldNotice
      refs={toolCall.snapshotRefs ?? []}
      onLoadFullToolCallFields={
        context.onLoadFullToolCallFields
          ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
          : undefined
      }
    />
  );

  // 编不过：编译反馈行；无 display 且失败：失败摘要。handler 在编不过的路径上直接回诊断、不启动引擎，
  // 本来就不该有 run——即使宿主联接到了也留在反馈行，把「诊断优先」写死在这里而不是依赖调用方。
  // 启动前复用普通摘要：编写中不展示半截脚本，待确认可展开最终脚本。
  const prelaunch = workflowRun === undefined && (writing || v4Status === "pendingApproval");
  const summaryOnly = writing && !showFailureStatus;
  // 编写中的行不可展开，但草稿阶段线常驻在行下（不是展开内容，没有折叠入口）：
  // 站由笔逐字写出，display 一到整个模型换成分析器的站，这块随 writing 结束一起离场。
  const draftTimelineBlock =
    summaryOnly && model?.draft !== undefined ? (
      <div className="pt-2" data-testid="workflow-draft-timeline">
        <WorkflowTimeline className="py-1" model={model} />
      </div>
    ) : null;
  if (showFailureStatus || prelaunch) {
    return (
      <>
        <ToolLayout
          toolId={toolCall.toolId}
          icon={WORKFLOW_CARD_ICON}
          showIcon={context.showIcon !== false}
          canToggle={!summaryOnly && canToggle}
          forceOpen={!summaryOnly && forceOpen}
          kindLabel={
            context.kindLabelOverride ??
            intl.formatMessage({
              id: readWorkflowPrelaunchKindMessageId(
                {
                  compileErrors: hasCompileErrors,
                  failed: showFailureStatus,
                  writing,
                  revising: (draft?.ordinal ?? 1) >= 2,
                },
                vocabulary,
              ),
            })
          }
          sourceLabel={context.sourceLabel}
          primaryText={diagnosticsPrimaryText}
          // 稿号在展开后仍留在行上：它说的是「这是第几稿」，不是折叠时的摘要。
          secondaryText={draftSlots.secondaryText}
          statusLabel={draftSlots.statusLabel ?? context.statusLabel}
          statusIndicator={draftSlots.statusIndicator}
          statusTooltip={draftSlots.statusTooltip ?? context.errorText}
          showFailureStatus={showFailureStatus}
          // 待确认仍处于启动流程中，与编写态共用扫光，避免看起来已经结束。
          isRunning={showFailureStatus ? context.isRunning : prelaunch}
          title={toolCall.title}
          renderContent={summaryOnly ? undefined : renderDiagnosticsContent}
        />
        {draftTimelineBlock}
        {snapshotNotice}
      </>
    );
  }

  // 已联接 run 的种类词按 run 状态说（旧宿主的运行卡）；修订行在 run 出现之前用修订词汇。
  const kindId =
    workflowRun !== undefined
      ? workflowRunKindMessageId(workflowRun)
      : readWorkflowKindMessageId(toolCall.raw, context.isRunning, vocabulary, retuning);
  const kindText = context.kindLabelOverride ?? intl.formatMessage({ id: kindId });
  // 种类词按文案换（编写中 → 待确认 → 运行中）：换词动画由表头自己包，见 WorkflowCardHeader。
  const live = workflowRun !== undefined ? workflowRun.status === "running" : context.isRunning;
  const status =
    workflowRun !== undefined ? (
      <WorkflowRunStatus run={workflowRun} testId="workflow-card-status" />
    ) : display?.ok === true ? (
      <WorkflowStaticStatus word={intl.formatMessage({ id: "chat.toolCall.workflow.compiled" })} />
    ) : undefined;
  // 细节串与它的 tooltip（含子代理模型名）与 v4 轮尾摘要同一份实现。这条渲染路径拿不到会话的
  // 模型清单（工具卡一层不碰 store），自定义 provider 的名字因此查不到——按同一条兜底规则退回
  // 裸 modelId，绝不显示 providerId。
  const cardDetail = workflowCardDetail(intl.formatMessage.bind(intl), model, graph, run);
  // 校验中（在途、还没有图）从第 2 稿起在细节位写稿号，免得「正在修改 · 第 2 稿」→ 校验 → 反馈之间一闪而空。
  const headerDetail = cardDetail?.detail ?? draftSlots.inFlightOrdinalText;
  const terminal = run !== undefined && (run.status === "errored" || run.status === "stopped");
  const resume =
    workflowRun?.resumable === true && onResumeWorkflowRun !== undefined ? (
      <Button
        className="ml-auto"
        data-testid="workflow-card-resume"
        onClick={handleResume}
        size="sm"
        type="button"
        variant="outline"
      >
        <RotateCcwIcon className="size-3.5" />
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.resume" })}
      </Button>
    ) : undefined;
  const savedSourceLabel = intl.formatMessage({ id: "chat.permission.workflow.saved.badge" });
  const savedScopeProjectLabel = intl.formatMessage({
    id: "chat.permission.workflow.saved.scope.project",
  });
  const showScriptFold = workflowRun === undefined && !writing && scriptText !== undefined;

  return (
    <>
      <section
        aria-label={typeof kindText === "string" ? kindText : undefined}
        className="wf-motion flex w-full min-w-0 flex-col gap-2"
        data-testid="workflow-card"
        data-workflow-card-state={workflowRun?.status ?? (writing ? "writing" : "static")}
        {...(workflowRun === undefined
          ? {}
          : {
              "data-workflow-run-id": workflowRun.runId,
              "data-workflow-run-status": workflowRun.status,
            })}
      >
        <WorkflowCardHeader
          detail={headerDetail}
          {...(cardDetail?.title === undefined ? {} : { detailTitle: cardDetail.title })}
          expanded={expanded}
          kind={kindText}
          live={live}
          name={name}
          status={status}
          {...(onOpenWorkflowRun === undefined ? {} : { onOpenDetails: handleOpenRunDetails })}
          {...(forceOpen || !canToggle ? {} : { onToggle: handleToggle })}
        />

        {expanded ? (
          <div className="wf-unfold flex min-w-0 flex-col gap-2" data-testid="workflow-card-body">
            {amendTarget === undefined ? null : (
              <WorkflowAmendsLine runId={amendTarget} scriptInherited={keptScript} />
            )}
            {saved ? (
              <WorkflowCardMetaLine
                marker="saved-source"
                label={
                  saved.scope === "project"
                    ? `${savedSourceLabel} · ${savedScopeProjectLabel}`
                    : savedSourceLabel
                }
                value={saved.name}
                title={saved.path ?? saved.name}
              />
            ) : null}

            {model === undefined ? null : (
              <WorkflowTimeline
                className="py-1"
                model={model}
                {...(onOpenWorkflowRun === undefined
                  ? {}
                  : { onOpenMore: handleSelectStation, onSelectStation: handleSelectStation })}
                {...(onOpenWorkflowActor === undefined || run === undefined
                  ? {}
                  : { onOpenPill: handleOpenPill })}
                {...(onOpenWorkflowWorkspace === undefined || run === undefined
                  ? {}
                  : { onOpenWorkspace: handleOpenWorkspace })}
              />
            )}

            {/* 产物条（追记「产物药丸」）：run 交付了什么，≤ 3 枚 + N，全量在详情侧板。 */}
            {run?.artifacts !== undefined && run.artifacts.length > 0 ? (
              <WorkflowArtifactStrip
                artifacts={run.artifacts}
                className="px-1 pb-0.5"
                moreTestId="workflow-card-artifacts-more"
                pillTestId="workflow-card-artifact"
                testId="workflow-card-artifacts"
                {...(onOpenWorkflowArtifact === undefined
                  ? {}
                  : { onOpenArtifact: onOpenWorkflowArtifact })}
              />
            ) : null}

            {graph?.truncated === true ? (
              <p className="text-ui-xs text-foreground-subtlest">
                {intl.formatMessage({ id: "chat.toolCall.workflow.graph.truncated" })}
              </p>
            ) : null}

            {display && display.diagnostics.length > 0 ? (
              <WorkflowDiagnosticsSection
                count={display.errorCount}
                diagnostics={display.diagnostics}
                saved={saved !== undefined}
                truncated={display.truncated}
              />
            ) : null}

            {!display && fallbackOutputText ? (
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-panel px-3 py-2 font-mono text-ui-base text-foreground-subtle">
                {fallbackOutputText}
              </pre>
            ) : null}

            {!scriptText && !keptScript && !display && !fallbackOutputText && !context.isRunning ? (
              <p className="font-mono text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "chat.toolCall.workflow.noScript" })}
              </p>
            ) : null}

            {showScriptFold ? (
              // 没有 run 就没有详情页的 Script 区，脚本原文只能在这里读；默认收起，与确认窗同形。
              <Collapsible open={scriptOpen} onOpenChange={setScriptOpen}>
                <CollapsibleTrigger
                  className="flex min-w-0 items-center gap-1 rounded-md py-0.5 text-left text-ui-xs font-medium text-foreground-subtlest transition-colors hover:text-foreground-subtle"
                  data-testid="workflow-card-script-toggle"
                >
                  <ChevronRightIcon
                    className={cn(
                      "size-3.5 shrink-0 transition-transform",
                      scriptOpen && "rotate-90",
                    )}
                  />
                  <span className="min-w-0 truncate">
                    {intl.formatMessage({
                      id: scriptOpen
                        ? "chat.permission.workflow.hideScript"
                        : "chat.permission.workflow.showScript",
                    })}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-1.5">
                  <div className="max-h-72 overflow-auto">
                    <CodeBlock
                      code={scriptText}
                      language="typescript"
                      renderMermaid={false}
                      showLineNumbers
                    />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ) : null}
          </div>
        ) : null}

        {/* 页脚：展开时恒在；折叠时只有终态（失败 / 取消）留下——Resume 必须仍然够得着。 */}
        {/* 页脚曾是摘要行（子代理 · 步数 · token · 轮次 · 产物）；2026-09-09 起卡上只说阶段与
            子代理，都在表头——页脚只剩 Resume 的落点，没有 Resume 就没有页脚。 */}
        {resume !== undefined && run !== undefined && (expanded || terminal) ? (
          <WorkflowCardFooter status={run.status} trailing={resume} />
        ) : null}
      </section>
      {snapshotNotice}
    </>
  );
}
