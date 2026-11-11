import { useContext } from "react";
import { SummaryIconOnlyContext } from "@/v4/conversationRowContext.js";
import { useToolPresentationHostCapabilities } from "@/hooks/useToolPresentationHostCapabilities.js";
import { ToolPresentationCapabilitiesProvider } from "@/ToolCallBlocks/presentationCapabilities.js";
import { memo, useMemo } from "react";
import { TID_CHAT_TOOL_CALL_BLOCK, testId } from "@zcode/shared/test-ids";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { mapToolStatus } from "@/lib/mapToolStatus.js";
import { buildToolDisplayModel } from "@/lib/toolDisplay.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import {
  getCompactToolCallStatusMessageId,
  isCompactToolCallRunningState,
} from "@/lib/toolCallSummary.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import * as PluginUi from "@/plugin-ui/index.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  readRawToolCallFileSummaries,
  type ToolCallBlockRenderContext,
} from "@/ToolCallBlocks/shared.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";

const NESTED_TOOLCALL_CONTAINER_CLASS =
  "ml-2 space-y-2 border-border border-l pl-3.5 border-border";

export function isAgentToolCall(toolCall: TaskChatToolCallTreeNode["toolCall"]): boolean {
  return resolveToolCallIdentity(toolCall).family === "agent";
}

function ToolCallBlockComponent({
  toolCallNode,
  depth = 0,
  workspacePath,
  theme,
  codePreviewSettings,
  showIcon = true,
  cuaAppIconClassName,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onOpenPlanDetail,
  pluginUi: providedPluginUi,
  onOpenWorkflowRun,
  onResumeWorkflowRun,
  onOpenWorkflowActor,
  onOpenWorkflowWorkspace,
  onOpenWorkflowArtifact,
  workflowRun,
  workflowDraft,
  onLoadFullToolCallFields,
  suppressSourceLabel = false,
  showTodoToolCalls = true,
  disableSummaryContentAnimation = false,
  animateDiffCountOnMount = false,
  agentSummaryAction,
  authoritativeAgentType,
}: {
  toolCallNode: TaskChatToolCallTreeNode;
  depth?: number;
  workspacePath: string;
  /** 应用主题（store 耦合剥离）：由宿主（v4 SessionPane 等）传入，缺省按 "system" 兜底。 */
  theme?: ToolCallBlockRenderContext["theme"];
  /** 代码预览设置（store 耦合剥离）：由宿主传入并保持引用稳定。 */
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  showIcon?: boolean;
  cuaAppIconClassName?: ToolCallBlockRenderContext["cuaAppIconClassName"];
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: (automationId?: string) => void;
  onOpenPlanDetail?: ToolCallBlockRenderContext["onOpenPlanDetail"];
  pluginUi?: ToolCallBlockRenderContext["pluginUi"];
  onOpenWorkflowRun?: ToolCallBlockRenderContext["onOpenWorkflowRun"];
  /** 工具卡页脚的 Resume；与 workflowRun 同样不向子工具卡透传。 */
  onResumeWorkflowRun?: ToolCallBlockRenderContext["onResumeWorkflowRun"];
  /** 药丸 → 子代理 transcript；同样不向子工具卡透传。 */
  onOpenWorkflowActor?: ToolCallBlockRenderContext["onOpenWorkflowActor"];
  /** 脚本药丸 → 脚本 transcript；同样不向子工具卡透传。 */
  onOpenWorkflowWorkspace?: ToolCallBlockRenderContext["onOpenWorkflowWorkspace"];
  /** 产物药丸 → 产物 tab；同样不向子工具卡透传。 */
  onOpenWorkflowArtifact?: ToolCallBlockRenderContext["onOpenWorkflowArtifact"];
  /**
   * 该工具调用联接到的 workflow run 摘要（宿主按 toolCallId 从 workflowRuns 投影解析）。
   * 刻意**不**向子工具卡透传：摘要是按 toolCallId 联接出来的，把父卡的 run 摘要传给
   * 一个不同 toolCallId 的子卡，画出来的就是别人的运行态。
   */
  workflowRun?: ToolCallBlockRenderContext["workflowRun"];
  /** 编译反馈的草稿位置（宿主按 toolCallId 从行窗口联接）；同 workflowRun，不向子工具卡透传。 */
  workflowDraft?: ToolCallBlockRenderContext["workflowDraft"];
  onLoadFullToolCallFields?: (toolId: string) => Promise<boolean | void> | boolean | void;
  suppressSourceLabel?: boolean;
  showTodoToolCalls?: boolean;
  disableSummaryContentAnimation?: boolean;
  animateDiffCountOnMount?: boolean;
  agentSummaryAction?: ToolCallBlockRenderContext["agentSummaryAction"];
  authoritativeAgentType?: ToolCallBlockRenderContext["authoritativeAgentType"];
}) {
  const presentationCapabilities = useToolPresentationHostCapabilities(workspacePath);
  const inheritedPluginUi = PluginUi.usePluginUiToolBinding(toolCallNode.toolCall.toolId);
  const pluginUi = providedPluginUi ?? inheritedPluginUi;
  const { toolCall, childToolCalls } = toolCallNode;
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  // 注意：下面的 early return 必须放在所有 hook 调用之后。
  // 之前这里在 useMemo 之前就 `return null`，导致当某个 toolCall 的
  // family 在 todo 与非 todo 之间切换（或 showTodoToolCalls 变化）时，
  // 本组件这次渲染执行的 hook 数量和上次不一致，React 会抛出
  // "Rendered fewer hooks than expected" 并导致整个聊天页面白屏崩溃。
  // 修复方式：把 early return 下移到所有 hook 之后，保证 hook 调用顺序稳定。
  const identity = resolveToolCallIdentity(toolCall);
  const toolState = mapToolStatus(toolCall.status);
  const displayModel = useMemo(
    () => buildToolDisplayModel(toolCall, workspacePath),
    [toolCall, workspacePath],
  );
  const rawFileSummaries = useMemo(
    () =>
      readRawToolCallFileSummaries(toolCall.raw, {
        toolName: toolCall.toolName,
        kind: toolCall.kind,
        title: toolCall.title,
        input: toolCall.input,
        output: toolCall.output,
        raw: toolCall.raw,
      }),
    [
      toolCall.input,
      toolCall.kind,
      toolCall.output,
      toolCall.raw,
      toolCall.title,
      toolCall.toolName,
    ],
  );
  const isRunning = isCompactToolCallRunningState(toolState);
  const statusLabel = intl.formatMessage({
    id: getCompactToolCallStatusMessageId(toolState, toolCall.status),
  });
  const errorText = getToolCallErrorText(toolCall);
  const isCurrentAgentToolCall = isAgentToolCall(toolCall);
  const isSubAgentToolCall = !isCurrentAgentToolCall && (depth > 0 || toolCall.parentToolUseId);
  const sourceLabel =
    !suppressSourceLabel && isSubAgentToolCall
      ? intl.formatMessage({ id: "chat.toolCall.source.subAgent" })
      : undefined;
  // 之前为了避免“双预览”把 onOpenCodeViewer 全局置空，
  // 会导致 edit/read 文件摘要失去点击能力，回归为“看得到文件名但不能点”。
  // 这里恢复透传，保持历史交互；是否做“避免双预览”应改为更细粒度开关，而不是一刀切禁用。
  const toolPreviewCodeViewer: ToolCallBlockRenderContext["onOpenCodeViewer"] = onOpenCodeViewer;

  const childToolList = useMemo(
    () =>
      childToolCalls.length > 0 ? (
        <div className={NESTED_TOOLCALL_CONTAINER_CLASS}>
          {childToolCalls.map((childToolCallNode) => (
            <ToolCallBlock
              key={childToolCallNode.toolCall.toolId}
              toolCallNode={childToolCallNode}
              depth={depth + 1}
              workspacePath={workspacePath}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              showIcon={showIcon}
              onOpenCodeViewer={toolPreviewCodeViewer}
              onOpenFileLink={onOpenFileLink}
              onOpenBrowserUrl={onOpenBrowserUrl}
              onOpenAutomationsMain={onOpenAutomationsMain}
              onOpenPlanDetail={onOpenPlanDetail}
              onOpenWorkflowRun={onOpenWorkflowRun}
              onLoadFullToolCallFields={onLoadFullToolCallFields}
              suppressSourceLabel={suppressSourceLabel}
              showTodoToolCalls={showTodoToolCalls}
              disableSummaryContentAnimation={disableSummaryContentAnimation}
              animateDiffCountOnMount={animateDiffCountOnMount}
            />
          ))}
        </div>
      ) : null,
    [
      childToolCalls,
      depth,
      onLoadFullToolCallFields,
      onOpenAutomationsMain,
      onOpenBrowserUrl,
      onOpenPlanDetail,
      onOpenFileLink,
      showIcon,
      showTodoToolCalls,
      suppressSourceLabel,
      theme,
      codePreviewSettings,
      toolPreviewCodeViewer,
      workspacePath,
    ],
  );

  const renderContext: ToolCallBlockRenderContext = useMemo(
    () => ({
      nestedToolRenderer: ToolCallBlock,
      isOfficeMode,
      toolCallNode,
      workspacePath,
      theme,
      codePreviewSettings,
      displayModel,
      viewerSource: displayModel.viewerSource,
      rawFileSummaries,
      isRunning,
      statusLabel,
      sourceLabel,
      errorText,
      childToolList,
      showIcon,
      cuaAppIconClassName,
      showTodoToolCalls,
      disableSummaryContentAnimation,
      animateDiffCountOnMount,
      agentSummaryAction,
      authoritativeAgentType,
      onOpenCodeViewer: toolPreviewCodeViewer,
      onOpenFileLink,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenPlanDetail,
      pluginUi,
      // onOpenWorkflowRun 之前只被透传给子工具卡，从未进过 renderContext，
      // 于是 CreateWorkflow renderer 永远收不到它——「打开详情页」的入口不是被埋深了，
      // 是根本没渲染过。run 态紧凑卡就挂在这个回调上，所以它必须在这里。
      onOpenWorkflowRun,
      onResumeWorkflowRun,
      onOpenWorkflowActor,
      onOpenWorkflowWorkspace,
      onOpenWorkflowArtifact,
      workflowRun,
      workflowDraft,
      onLoadFullToolCallFields,
    }),
    [
      isOfficeMode,
      agentSummaryAction,
      authoritativeAgentType,
      childToolList,
      codePreviewSettings,
      cuaAppIconClassName,
      displayModel,
      disableSummaryContentAnimation,
      animateDiffCountOnMount,
      errorText,
      isRunning,
      onLoadFullToolCallFields,
      onOpenAutomationsMain,
      onOpenBrowserUrl,
      onOpenPlanDetail,
      pluginUi,
      onOpenWorkflowRun,
      onResumeWorkflowRun,
      onOpenWorkflowActor,
      onOpenWorkflowWorkspace,
      onOpenWorkflowArtifact,
      onOpenFileLink,
      rawFileSummaries,
      showIcon,
      showTodoToolCalls,
      sourceLabel,
      statusLabel,
      suppressSourceLabel,
      theme,
      toolCallNode,
      toolPreviewCodeViewer,
      workflowRun,
      workflowDraft,
      workspacePath,
    ],
  );

  const iconOnly = useContext(SummaryIconOnlyContext);
  const ToolCallRenderer = useMemo(() => {
    const Renderer = resolveToolCallRenderer(renderContext);
    // 插件声明与 session 绑定已由宿主校验，不能再用通用 renderer 身份截断入口。
    // 没有合法插件声明时仍保持共同注册表的专用工具优先级。
    return PluginUi.shouldRenderPluginUi(renderContext) ? PluginUi.PluginUiToolCallBlock : Renderer;
  }, [renderContext]);
  // early return 必须在所有 hook 之后（见上方注释说明的崩溃原因）
  if (!showTodoToolCalls && identity.family === "todo") {
    return null;
  }
  // 图标投影不是另一条工具记录，不创建重复的工具身份与入场动画节点。
  if (iconOnly)
    return (
      <ToolPresentationCapabilitiesProvider value={presentationCapabilities}>
        <ToolCallRenderer {...renderContext} />
      </ToolPresentationCapabilitiesProvider>
    );
  return (
    <ToolPresentationCapabilitiesProvider value={presentationCapabilities}>
      <div
        className="w-full"
        data-testid={testId(TID_CHAT_TOOL_CALL_BLOCK, toolCall.toolId)}
        data-tool-call-id={toolCall.toolId}
        data-tool-name={toolCall.toolName ?? toolCall.kind ?? ""}
        data-status={toolCall.status}
      >
        <ToolCallRenderer {...renderContext} />
      </div>
    </ToolPresentationCapabilitiesProvider>
  );
}

export const ToolCallBlock = memo(ToolCallBlockComponent);
ToolCallBlock.displayName = "ToolCallBlock";
