import { useCallback, useMemo } from "react";
import { ChevronRightIcon, ExternalLinkIcon, SquareMousePointerIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockWrapButton,
} from "@/components/ai-elements/code-block.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cuaAppKeyToIconRequest } from "@/lib/cuaAppIconRequest.js";
import { buildNodeReplDisplayModel, type NodeReplDisplayModel } from "@/lib/nodeReplToolDisplay.js";
import { CuaAppSummaryIcon } from "@/ToolCallBlocks/renderers/cuaAppSummaryIcon.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { NodeReplImageGrid } from "@/ToolCallBlocks/renderers/nodeReplImageGrid.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const NODE_REPL_TOOL_ICON = <SquareMousePointerIcon className="size-4 shrink-0" />;

// Radix 会在浏览器工具及执行详情打开时立即测量高度；代码块默认的 200px 离屏占位
// 会让动画先展开过头再回落。两层内容都只在对应区域展开时挂载，使用真实布局不会损失长会话性能。
const COLLAPSIBLE_CODE_LAYOUT_STYLE = {
  containIntrinsicSize: "none",
  contentVisibility: "visible",
} as const;
const COMPACT_RESULT_MAX_LENGTH = 160;

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return false;
  }

  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function isCompactResult(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= COMPACT_RESULT_MAX_LENGTH &&
    !trimmed.includes("\n") &&
    !looksLikeJson(trimmed)
  );
}

function getSummary(
  model: NodeReplDisplayModel,
  status: string,
  isRunning: boolean,
  formatMessage: (id: string) => string,
): { title: string; status?: string; detail?: string } {
  const isFailed = status === "failed";
  const isDenied = status === "denied";
  const isStopped = status === "stopped";

  if (isDenied || isStopped) {
    return {
      title: formatMessage(
        isDenied ? "chat.toolCall.nodeRepl.denied" : "chat.toolCall.nodeRepl.stopped",
      ),
    };
  }

  if (model.operation === "reset") {
    return {
      title: formatMessage(
        isFailed
          ? "chat.toolCall.nodeRepl.resetFailed"
          : isRunning
            ? "chat.toolCall.nodeRepl.resetting"
            : "chat.toolCall.nodeRepl.reset",
      ),
    };
  }

  if (model.operation === "add-module-dir") {
    return {
      title: formatMessage(
        isFailed
          ? "chat.toolCall.nodeRepl.configureFailed"
          : isRunning
            ? "chat.toolCall.nodeRepl.configuring"
            : "chat.toolCall.nodeRepl.configured",
      ),
      detail: model.moduleDirectory,
    };
  }

  const fallbackTitle = formatMessage(
    isFailed
      ? "chat.toolCall.nodeRepl.failed"
      : isRunning
        ? "chat.toolCall.nodeRepl.processing"
        : "chat.toolCall.nodeRepl.finished",
  );
  return {
    title: model.userTitle ?? fallbackTitle,
    // 成功不重复显示状态；失败由 ToolLayout 的错误槽位显示，避免重复。
    status:
      model.userTitle && isRunning ? formatMessage("chat.toolCall.nodeRepl.processing") : undefined,
  };
}

function FriendlyCodeBlock({
  cardSurface = false,
  code,
  copyLabel,
  eagerLayout = false,
  label,
  language,
  wrapLabel,
}: {
  cardSurface?: boolean;
  code: string;
  copyLabel: string;
  eagerLayout?: boolean;
  label: string;
  language: string;
  wrapLabel: string;
}) {
  return (
    <CodeBlock
      className={cardSurface ? "bg-card" : undefined}
      code={code}
      enableSyntaxHighlighting={language !== "log"}
      language={language}
      renderMermaid={false}
      style={eagerLayout ? COLLAPSIBLE_CODE_LAYOUT_STYLE : undefined}
      wrapLongLines
    >
      <CodeBlockHeader className="pl-3 pr-2 pt-2">
        <CodeBlockTitle>
          <span className="text-ui-base font-medium text-foreground-subtle">{label}</span>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockWrapButton aria-label={wrapLabel} title={wrapLabel} />
          <CodeBlockCopyButton aria-label={copyLabel} title={copyLabel} />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
}

export function NodeReplToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const model = useMemo(() => buildNodeReplDisplayModel(toolCall), [toolCall]);
  const formatMessage = useCallback((id: string) => intl.formatMessage({ id }), [intl]);
  const summary = useMemo(
    () => getSummary(model, toolCall.status, context.isRunning, formatMessage),
    [context.isRunning, formatMessage, model, toolCall.status],
  );
  // Computer Use 的 cell 携带目标应用身份时，leading icon 换成该应用的真实图标 —— 连续
  // CUA 步骤据此一眼看出各步操作的是哪个 app。图标由平台服务按
  // locator 现取，取不到时保持 node_repl 自己的图标，不切换成另一个指针图形。
  const leadingIcon = useMemo(() => {
    if (!model.app) return NODE_REPL_TOOL_ICON;
    const iconRequest = cuaAppKeyToIconRequest(model.app.appKey);
    if (!iconRequest) return NODE_REPL_TOOL_ICON;
    return (
      <CuaAppSummaryIcon
        iconRequest={iconRequest}
        name={model.app.displayName ?? model.app.appKey}
        fallback={NODE_REPL_TOOL_ICON}
      />
    );
  }, [model.app]);
  const resultLabel = formatMessage("chat.toolCall.nodeRepl.result");
  const noResultLabel = formatMessage("chat.toolCall.nodeRepl.noResult");
  const detailsLabel = formatMessage("chat.toolCall.nodeRepl.details");
  const detailContentLabel = formatMessage("chat.toolCall.nodeRepl.detailContent");
  const technicalDetailsLabel = formatMessage("chat.toolCall.nodeRepl.technicalDetails");
  const copyResultLabel = formatMessage("chat.toolCall.nodeRepl.copyResult");
  const copyDetailsLabel = formatMessage("chat.toolCall.nodeRepl.copyDetails");
  const wrapLinesLabel = formatMessage("chat.toolCall.nodeRepl.wrapLines");
  const resultImageLabel = formatMessage("chat.toolCall.nodeRepl.resultImage");
  const fullResultLabel = model.persistedResult
    ? intl.formatMessage(
        { id: "chat.toolCall.nodeRepl.fullResult" },
        { size: model.persistedResult.sizeLabel },
      )
    : undefined;
  const visibleError =
    toolCall.status === "failed" ? (model.error?.summary ?? context.errorText) : undefined;
  const hasTechnicalDetails = Boolean(model.code || model.error?.stack);
  const hasVisibleResult = Boolean(
    visibleError || model.resultText || model.images.length > 0 || model.persistedResult,
  );
  const hasDetails =
    model.operation === "run"
      ? hasVisibleResult || hasTechnicalDetails
      : toolCall.status === "failed" && (hasVisibleResult || hasTechnicalDetails);
  const canToggle = context.canToggle ?? hasDetails;
  const summaryText = useMemo(
    () => (
      <span className="inline-flex min-w-0 items-center gap-2 font-normal text-foreground-subtle">
        <span className="min-w-0 truncate">{summary.title}</span>
        {summary.status ? (
          <span className="shrink-0 text-foreground-subtlest">{summary.status}</span>
        ) : null}
        {summary.detail ? (
          <code className="min-w-0 truncate font-mono text-foreground-subtlest">
            {summary.detail}
          </code>
        ) : null}
      </span>
    ),
    [summary.detail, summary.status, summary.title],
  );
  const renderContent = useCallback(
    () => (
      // ToolLayout 已提供展开间距，Node REPL 再叠加横向 padding 会让 BUA
      // 结果相对摘要行二次缩进，在窄屏消息流里尤其突兀。
      <div className="mb-2 space-y-3 py-1" data-testid="node-repl-expanded-content">
        {visibleError ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-base font-medium text-destructive">{resultLabel}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
              {visibleError}
            </p>
          </section>
        ) : model.resultText && isCompactResult(model.resultText) ? (
          // BUA 常返回 done、标题或 URL 等短结果，完整代码块的标题栏、边框和
          // 操作按钮会让内容重量远大于信息本身；短结果按普通次级正文展示。
          <p
            className="break-words rounded-xl border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
            data-testid="node-repl-result-surface"
          >
            {model.resultText.trim()}
          </p>
        ) : model.resultText ? (
          <div
            className="max-h-72 overflow-auto rounded-xl border border-border bg-card"
            data-testid="node-repl-result-surface"
          >
            <FriendlyCodeBlock
              cardSurface
              code={model.resultText}
              copyLabel={copyResultLabel}
              eagerLayout
              label={resultLabel}
              language={looksLikeJson(model.resultText) ? "json" : "log"}
              wrapLabel={wrapLinesLabel}
            />
          </div>
        ) : !context.isRunning && model.images.length === 0 ? (
          <p className="text-ui-base text-foreground-subtle">{noResultLabel}</p>
        ) : null}

        {model.images.length > 0 ? (
          <NodeReplImageGrid images={model.images} resultImageLabel={resultImageLabel} />
        ) : null}

        {model.persistedResult && fullResultLabel ? (
          <div className="flex flex-wrap items-center gap-2 text-ui-base text-foreground-subtle">
            <span>{fullResultLabel}</span>
            {context.onOpenCodeViewer ? (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="px-0"
                onClick={() =>
                  context.onOpenCodeViewer?.({
                    type: "file",
                    title: resultLabel,
                    path: model.persistedResult!.artifactPath,
                  })
                }
              >
                {formatMessage("chat.toolCall.nodeRepl.openFullResult")}
                <ExternalLinkIcon className="size-3" />
              </Button>
            ) : null}
          </div>
        ) : null}

        {hasTechnicalDetails ? (
          <Collapsible className="group/details">
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 text-foreground-subtlest hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground"
              >
                <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/details:rotate-90" />
                {detailsLabel}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-2 pt-2">
                {model.code ? (
                  <div
                    className="max-h-72 overflow-auto rounded-xl border border-border bg-card"
                    data-testid="node-repl-detail-surface"
                  >
                    <FriendlyCodeBlock
                      cardSurface
                      code={model.code}
                      copyLabel={copyDetailsLabel}
                      eagerLayout
                      label={detailContentLabel}
                      language="javascript"
                      wrapLabel={wrapLinesLabel}
                    />
                  </div>
                ) : null}
                {model.error?.stack ? (
                  <div
                    className="max-h-72 overflow-auto rounded-xl border border-border bg-card"
                    data-testid="node-repl-detail-surface"
                  >
                    <FriendlyCodeBlock
                      cardSurface
                      code={model.error.stack}
                      copyLabel={copyDetailsLabel}
                      eagerLayout
                      label={technicalDetailsLabel}
                      language="log"
                      wrapLabel={wrapLinesLabel}
                    />
                  </div>
                ) : null}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    ),
    [
      context.isRunning,
      context.onOpenCodeViewer,
      copyDetailsLabel,
      copyResultLabel,
      detailContentLabel,
      detailsLabel,
      formatMessage,
      fullResultLabel,
      hasTechnicalDetails,
      model,
      noResultLabel,
      resultImageLabel,
      resultLabel,
      technicalDetailsLabel,
      visibleError,
      wrapLinesLabel,
    ],
  );

  if (model.displaySource === "browser_turn_end") {
    return <NodeReplImageGrid images={model.images} resultImageLabel={resultImageLabel} />;
  }

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={leadingIcon}
        showIcon={context.showIcon !== false}
        canToggle={canToggle}
        forceOpen={context.forceOpen ?? false}
        kindLabel={null}
        sourceLabel={context.sourceLabel}
        primaryText={summaryText}
        statusLabel={formatMessage("chat.toolCall.nodeRepl.failed")}
        statusTooltip={visibleError}
        showFailureStatus={toolCall.status === "failed" && Boolean(model.userTitle)}
        isRunning={context.isRunning}
        title={summary.title}
        renderContent={hasDetails ? renderContent : undefined}
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
