import { XIcon, SquareIcon } from "lucide-react";
import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";
import { SUBAGENT_WORKFLOW_COLOR } from "@/lib/subagentColors.js";
import {
  agentColor as workflowAgentColor,
  WorkflowAgentFace,
} from "@/components/workflow-timeline/WorkflowAgentFace.js";
import { useCallback, useMemo, type ReactNode } from "react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { getLatestAgentChildSummaryFromChildren } from "@/ToolCallBlocks/renderers/explore.js";
import { AgentPromptSection } from "./agentPromptSection.js";
import {
  formatAgentMessage,
  getAgentColor,
  getAgentKindLabel,
  getAgentActivityContent,
  getAgentPrimaryText,
  getAgentPrompt,
  readBackgroundAgentInfo,
} from "./agentHelpers.js";

function AgentChildToolList({
  nestedToolRenderer,
  childToolCalls,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onLoadFullToolCallFields,
}: {
  nestedToolRenderer: ToolCallBlockRenderContext["nestedToolRenderer"];
  childToolCalls: ToolCallBlockRenderContext["toolCallNode"]["childToolCalls"];
  workspacePath: string;
  theme?: ToolCallBlockRenderContext["theme"];
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  onOpenCodeViewer?: ToolCallBlockRenderContext["onOpenCodeViewer"];
  onOpenFileLink?: ToolCallBlockRenderContext["onOpenFileLink"];
  onOpenBrowserUrl?: ToolCallBlockRenderContext["onOpenBrowserUrl"];
  onOpenAutomationsMain?: ToolCallBlockRenderContext["onOpenAutomationsMain"];
  onLoadFullToolCallFields?: ToolCallBlockRenderContext["onLoadFullToolCallFields"];
}) {
  if (childToolCalls.length === 0) {
    return null;
  }

  const ToolCallBlock = nestedToolRenderer;
  return (
    <div className="space-y-2">
      {childToolCalls.map((childToolCallNode) => (
        <ToolCallBlock
          key={childToolCallNode.toolCall.toolId}
          toolCallNode={childToolCallNode}
          depth={1}
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          showIcon={false}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenFileLink={onOpenFileLink}
          onOpenBrowserUrl={onOpenBrowserUrl}
          onOpenAutomationsMain={onOpenAutomationsMain}
          onLoadFullToolCallFields={onLoadFullToolCallFields}
          suppressSourceLabel
        />
      ))}
    </div>
  );
}

function AgentActivitySection({
  label,
  content,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  label: string;
  content: string;
  workspacePath: string;
  theme?: ToolCallBlockRenderContext["theme"];
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  onOpenCodeViewer?: ToolCallBlockRenderContext["onOpenCodeViewer"];
  onOpenFileLink?: ToolCallBlockRenderContext["onOpenFileLink"];
  onOpenBrowserUrl?: ToolCallBlockRenderContext["onOpenBrowserUrl"];
}) {
  return (
    <section className="space-y-2">
      <div className="rounded-lg border border-border bg-background-alt/40 flex flex-col">
        <h4 className="p-3 text-ui-base font-medium tracking-wide text-foreground-subtlest uppercase">
          {label}
        </h4>
        <div className="overflow-auto max-h-64" data-markdown-table-sticky-scrollbar="disabled">
          {/* Agent 活动内容同样可能包含长代码/路径，允许横向滚动避免窄屏截断。*/}
          <MessageResponse
            className="px-3 py-2 min-w-0 break-words text-ui-base [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            workspacePath={workspacePath}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            onOpenCodeViewer={onOpenCodeViewer}
            onOpenFileLink={onOpenFileLink}
            onOpenExternalUrl={onOpenBrowserUrl}
          >
            {content}
          </MessageResponse>
        </div>
      </div>
    </section>
  );
}

function BackgroundAgentProcessRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-2">
      <div className="text-foreground-subtlest">{label}</div>
      <div className="min-w-0 text-foreground-subtle">{children}</div>
    </div>
  );
}

function AgentNameText({ name }: { name: string }) {
  return (
    <span
      data-summary-preserve-color
      className="inline-flex max-w-36 items-center truncate text-ui-base font-normal leading-[1.5]"
      title={name}
    >
      {name.replace(/-/g, " ").replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())}
    </span>
  );
}

function BackgroundAgentProcessSection({
  outputFile,
  hasActivity,
  isRunning,
  status,
}: {
  outputFile?: string;
  hasActivity: boolean;
  isRunning: boolean;
  status: string | undefined;
}) {
  const { intl } = useZCodeIntl();
  const msg = (id: string, fallback: string) => formatAgentMessage(intl, id, fallback);
  const launchStatus =
    status === "failed"
      ? msg("chat.toolCall.agent.backgroundLaunchFailed", "启动失败")
      : status === "pending"
        ? msg("chat.toolCall.agent.backgroundLaunching", "启动中")
        : msg("chat.toolCall.agent.backgroundLaunched", "已启动");
  const launchStatusKind =
    status === "failed" ? "failed" : status === "pending" ? "pending" : "launched";
  const activityStatus = isRunning
    ? hasActivity
      ? msg("chat.toolCall.agent.backgroundActivityStreaming", "后台运行中，正在同步输出")
      : msg("chat.toolCall.agent.backgroundActivityRunningWaiting", "后台运行中，等待输出")
    : hasActivity
      ? msg("chat.toolCall.agent.backgroundActivityReceived", "已收到子智能体回传")
      : msg("chat.toolCall.agent.backgroundActivityWaiting", "等待子智能体回传");
  const activityStatusKind = isRunning
    ? hasActivity
      ? "streaming"
      : "running_waiting"
    : hasActivity
      ? "received"
      : "waiting";

  return (
    <section
      data-background-agent-activity-status={activityStatusKind}
      data-background-agent-launch-status={launchStatusKind}
      className="rounded-lg border border-border bg-background-alt/40 p-3 text-ui-base"
    >
      <div className="font-medium text-foreground-subtle">
        {msg("chat.toolCall.agent.backgroundProcess", "后台 Agent 过程")}
      </div>
      <div className="mt-2 space-y-2">
        <BackgroundAgentProcessRow label={msg("chat.toolCall.agent.backgroundLaunch", "启动")}>
          {launchStatus}
        </BackgroundAgentProcessRow>
        <BackgroundAgentProcessRow label={msg("chat.toolCall.agent.backgroundActivity", "活动")}>
          {activityStatus}
        </BackgroundAgentProcessRow>
        {outputFile ? (
          <BackgroundAgentProcessRow label={msg("chat.toolCall.agent.outputFile", "输出文件")}>
            <span className="block break-all rounded-md bg-background px-2 py-1 font-mono text-foreground-subtle">
              {outputFile}
            </span>
          </BackgroundAgentProcessRow>
        ) : null}
      </div>
    </section>
  );
}

export function AgentToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall, childToolCalls } = context.toolCallNode;
  const prompt = getAgentPrompt(toolCall);
  const fallbackLabel = formatAgentMessage(intl, "chat.toolCall.agent.fallback", "SubAgent");
  const primaryText = getAgentPrimaryText(toolCall, fallbackLabel);
  const agentName = getAgentKindLabel(toolCall, "", context.authoritativeAgentType);
  // 显式配置仍是身份色来源；未配置时按原始名称取 workflow 颜色，不能让选择器失效。
  const configuredColor =
    useToolPresentationCapabilities().agentColor?.(agentName) ?? getAgentColor(toolCall);
  const identityColor = configuredColor
    ? SUBAGENT_WORKFLOW_COLOR[configuredColor]
    : agentName
      ? workflowAgentColor(undefined, agentName)
      : undefined;
  // 通用中文占位名散列会命中红色，误导为异常；身份未就绪时用中性头像和正文色，不按翻译文案取色。
  const faceColor = identityColor ?? "var(--color-foreground-subtle)";
  // 头像只读取父工具状态；停止使用中性等待表情，不能误报为成功。
  const faceStatus =
    toolCall.status === "pending"
      ? "pending"
      : context.isRunning
        ? "running"
        : toolCall.status === "completed"
          ? "done"
          : toolCall.status === "failed"
            ? "failed"
            : "pending";
  // 使用块级 flex，避免 kindDetail 行盒的基线留白使头像与名称高于描述。
  const agentNameDetail = (
    <span
      className="flex items-center gap-2"
      style={{ color: identityColor ?? "var(--color-foreground)" }}
    >
      {context.showIcon !== false ? (
        <WorkflowAgentFace
          avatarIndex={undefined}
          name={agentName || fallbackLabel}
          color={faceColor}
          status={faceStatus}
          showCompletionMark={faceStatus === "done"}
          className="size-4 min-h-4! min-w-4!"
        />
      ) : null}
      <AgentNameText name={agentName || fallbackLabel} />
    </span>
  );
  // Agent 父块的完成/进行中边界只由父 Agent tool 决定。
  // 子 tool 是展开区明细，不能反向续住父块运行态，否则父 Agent completed 后
  // 仍会显示渐变和子工具摘要，和协议里的父工具生命周期不一致。
  const isAgentVisuallyRunning = context.isRunning;
  const collapsedChildSummary = isAgentVisuallyRunning
    ? getLatestAgentChildSummaryFromChildren(intl, childToolCalls, context, {
        includeChildActionKindLabel: true,
      })
    : null;
  const backgroundAgentInfo = readBackgroundAgentInfo(toolCall);
  const activityContent = getAgentActivityContent(toolCall);
  const activityThought = toolCall.thought?.trim();
  // Agent 块和它内部的子工具都已经通过层级表达了来源，
  // 继续显示子智能体来源 badge 会制造重复噪音。
  const sourceLabel = undefined;
  // 名称和摘要各自兜底会产生“SubAgent SubAgent”；等待时用状态替换重复摘要，并移除末尾重复状态。
  const hasDuplicateSummary = primaryText.trim() === (agentName || fallbackLabel).trim();
  const showPendingInSummary = hasDuplicateSummary && toolCall.status === "pending";
  const summaryText = hasDuplicateSummary
    ? showPendingInSummary
      ? context.statusLabel
      : ""
    : primaryText;
  const collapsedPrimaryText = useMemo(
    () =>
      summaryText ? <span className="truncate text-foreground-subtlest">{summaryText}</span> : null,
    [summaryText],
  );
  const expandedPrimaryText = collapsedPrimaryText;
  const summaryAction = useMemo(
    () =>
      context.agentSummaryAction
        ? {
            ...context.agentSummaryAction,
            ariaLabel: formatAgentMessage(
              intl,
              "chat.toolCall.agent.openInSidePane",
              "Open on the right",
            ),
          }
        : undefined,
    [context.agentSummaryAction, intl],
  );
  const renderContent = useCallback(
    () => (
      <div className="ml-2 space-y-3 border-border border-l pl-3.5">
        {backgroundAgentInfo ? (
          <BackgroundAgentProcessSection
            outputFile={backgroundAgentInfo.outputFile}
            hasActivity={Boolean(activityContent || activityThought)}
            isRunning={isAgentVisuallyRunning}
            status={toolCall.status}
          />
        ) : null}
        {prompt ? (
          <AgentPromptSection
            prompt={prompt}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        ) : null}
        {activityThought ? (
          <AgentActivitySection
            label={formatAgentMessage(intl, "chat.toolCall.agent.thought", "Agent thought")}
            content={activityThought}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        ) : null}
        {activityContent ? (
          <AgentActivitySection
            label={formatAgentMessage(intl, "chat.toolCall.agent.output", "Agent output")}
            content={activityContent}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        ) : null}
        <AgentChildToolList
          nestedToolRenderer={context.nestedToolRenderer}
          childToolCalls={childToolCalls}
          workspacePath={context.workspacePath}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenBrowserUrl={context.onOpenBrowserUrl}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
          onLoadFullToolCallFields={context.onLoadFullToolCallFields}
        />
      </div>
    ),
    [
      activityContent,
      activityThought,
      backgroundAgentInfo,
      childToolCalls,
      context.codePreviewSettings,
      context.onLoadFullToolCallFields,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.theme,
      context.workspacePath,
      intl,
      isAgentVisuallyRunning,
      prompt,
      toolCall.status,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={null}
        showIcon={false}
        canToggle={false}
        forceOpen={false}
        summaryAction={summaryAction}
        // 产品边界：Agent/Task 在父对话中只保留单行摘要；完整 child timeline 统一从
        // 右侧 tab / 手机抽屉查看，因此这里既不自动展开，也不提供手动展开入口。
        kindLabel={null}
        expandedKindLabel={null}
        kindDetail={agentNameDetail}
        expandedKindDetail={agentNameDetail}
        sourceLabel={sourceLabel}
        autoCollapseOnComplete
        prioritizePrimaryText
        primaryText={
          collapsedChildSummary ? (
            <span className="min-w-0 truncate text-foreground-subtlest">
              {collapsedChildSummary.primaryText}
            </span>
          ) : (
            collapsedPrimaryText
          )
        }
        expandedPrimaryText={expandedPrimaryText}
        secondaryText={
          collapsedChildSummary?.secondaryText ? (
            <span className="min-w-0 truncate text-foreground-subtlest">
              {collapsedChildSummary.secondaryText}
            </span>
          ) : undefined
        }
        expandedSecondaryText={null}
        animateSummaryContent
        disableSummaryContentAnimation={context.disableSummaryContentAnimation}
        summaryContentKey={
          collapsedChildSummary?.animationKey ?? `agent:${toolCall.toolId}:${primaryText}`
        }
        // 运行与完成由行首头像 / 勾区分；仅等待、失败、停止保留状态文字。
        showStatusLabel={!showPendingInSummary && faceStatus !== "running" && faceStatus !== "done"}
        statusIndicator={
          faceStatus === "failed" ? (
            <XIcon aria-hidden className="size-3.5" />
          ) : toolCall.status === "stopped" ? (
            <SquareIcon aria-hidden className="size-3.5" />
          ) : undefined
        }
        statusLabel={context.statusLabel}
        statusTooltip={toolCall.status === "failed" ? context.errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isAgentVisuallyRunning}
        title={collapsedChildSummary?.title ?? primaryText}
        expandedTitle={primaryText}
        renderContent={renderContent}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
