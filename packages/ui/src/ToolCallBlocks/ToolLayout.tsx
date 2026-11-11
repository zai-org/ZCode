import { SummaryPreviewContext, SummaryIconOnlyContext } from "@/v4/conversationRowContext.js";
import { memo, useContext, type ReactNode, useEffect, useRef, useState } from "react";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { ToolSummaryRow, type ToolSummaryAction } from "@/ToolCallBlocks/ToolSummaryRow.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

const toolLayoutOpenState = new Map<string, boolean>();
// 内存诊断计数器：该表按 toolId 只增不减，先落日志。
uiMemoryDiagnosticsRegistry.register("toolLayout", () => ({ openState: toolLayoutOpenState.size }));
const TOOL_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS = 300;
const TOOL_CONTENT_SHELL_CLASSNAME = "text-popover-foreground outline-none";
const TOOL_CONTENT_SPACING_CLASSNAME = "pt-2";

interface ToolLayoutProps {
  toolId: string;
  persistOpenKey?: string;
  icon: ReactNode;
  showIcon?: boolean;
  canToggle?: boolean;
  forceOpen?: boolean;
  autoOpen?: boolean;
  autoCollapseOnComplete?: boolean;
  kindLabel: ReactNode;
  expandedKindLabel?: ReactNode;
  kindDetail?: ReactNode;
  expandedKindDetail?: ReactNode;
  sourceLabel?: ReactNode;
  primaryText: ReactNode;
  prioritizePrimaryText?: boolean;
  expandedPrimaryText?: ReactNode;
  secondaryText?: ReactNode;
  expandedSecondaryText?: ReactNode;
  animateSummaryContent?: boolean;
  disableSummaryContentAnimation?: boolean;
  summaryContentKey?: string;
  summaryContentRefreshVersion?: string;
  hideSecondaryTextWhenOpen?: boolean;
  diffCount?: ReactNode;
  hideDiffCountWhenOpen?: boolean;
  statusLabel?: ReactNode;
  statusTooltip?: ReactNode;
  /**
   * 状态词之前的指示物（如编译反馈行的空环灯），与状态词同显同隐。放在提示触发区之外：
   * 虚线下划线与悬停提示只属于词，灯不该被划线，也不该成为另一个悬停目标。
   */
  statusIndicator?: ReactNode;
  showStatusLabel?: boolean;
  showFailureStatus?: boolean;
  isRunning?: boolean;
  title?: string;
  expandedTitle?: string;
  content?: ReactNode;
  renderContent?: () => ReactNode;
  summaryAction?: ToolSummaryAction;
}

function ToolLayoutComponent({
  toolId,
  persistOpenKey,
  icon,
  showIcon = true,
  canToggle = true,
  forceOpen = false,
  autoOpen = false,
  autoCollapseOnComplete = false,
  kindLabel,
  expandedKindLabel,
  kindDetail,
  expandedKindDetail,
  sourceLabel,
  primaryText,
  prioritizePrimaryText = false,
  expandedPrimaryText,
  secondaryText,
  expandedSecondaryText,
  animateSummaryContent = false,
  disableSummaryContentAnimation = false,
  summaryContentKey,
  summaryContentRefreshVersion,
  hideSecondaryTextWhenOpen = false,
  diffCount,
  hideDiffCountWhenOpen = false,
  statusLabel,
  statusTooltip,
  statusIndicator,
  showStatusLabel = false,
  showFailureStatus = false,
  isRunning = false,
  title,
  expandedTitle,
  content,
  renderContent,
  summaryAction,
}: ToolLayoutProps) {
  const { intl } = useZCodeIntl();
  const resolvedPersistOpenKey = persistOpenKey ?? toolId;
  const [isOpen, setIsOpen] = useState(
    () => toolLayoutOpenState.get(resolvedPersistOpenKey) ?? false,
  );
  const hasSummaryAction = summaryAction !== undefined;
  const isExpanded = !hasSummaryAction && (forceOpen || (canToggle && isOpen));
  const [shouldRenderContent, setShouldRenderContent] = useState(isExpanded);
  const [isFailureTooltipCopied, setIsFailureTooltipCopied] = useState(false);
  const failureTooltipCopyResetRef = useRef<number | null>(null);
  const contentUnmountDelayRef = useRef<number | null>(null);
  const hasAutoOpenedRef = useRef(false);
  const previousIsRunningRef = useRef(isRunning);
  const shouldShowStatusLabel = (showStatusLabel || showFailureStatus) && statusLabel != null;
  const shouldRenderResolvedContent = !hasSummaryAction && (isExpanded || shouldRenderContent);
  const resolvedContent = shouldRenderResolvedContent
    ? (renderContent?.() ?? content ?? null)
    : null;
  const summaryPrimaryText =
    isExpanded && expandedPrimaryText != null ? expandedPrimaryText : primaryText;
  const summaryKindLabel = isExpanded && expandedKindLabel != null ? expandedKindLabel : kindLabel;
  const summaryKindDetail =
    isExpanded && expandedKindDetail !== undefined ? expandedKindDetail : kindDetail;
  const summarySecondaryText =
    isExpanded && expandedSecondaryText !== undefined
      ? expandedSecondaryText
      : isExpanded && hideSecondaryTextWhenOpen
        ? null
        : secondaryText;
  const summaryTitle = isExpanded && expandedTitle !== undefined ? expandedTitle : title;
  const resolvedSummaryContentKey =
    summaryContentKey ?? `${String(summaryTitle ?? "")}:${String(statusLabel ?? "")}`;
  const shouldShowDiffCount = diffCount != null && !(isExpanded && hideDiffCountWhenOpen);
  // toolcall 在流式期间数量多且持续更新，旋转 loading 图标会让
  // 动画长期占用渲染资源；运行态改由文案扫光和状态文字表达，图标保持静态。
  const summaryIcon = icon;
  // 运行态需要保留 kind 文案扫光，用来表达当前工具仍在进行中；
  // 非运行态统一使用次要色和普通字重，避免类别比动作正文更突出。
  const kindLabelClassName = cn(
    "font-normal whitespace-nowrap shrink-0",
    isRunning
      ? "animated-gradient-text animated-gradient-text-foreground"
      : "text-foreground-subtle",
  );

  useEffect(() => {
    const persistedOpen = toolLayoutOpenState.get(resolvedPersistOpenKey);
    setIsOpen(persistedOpen ?? false);
  }, [resolvedPersistOpenKey]);

  useEffect(() => {
    // edit/read 这类工具有“完成后默认自动展开”的需求，
    // 但 forceOpen 会把卡片彻底锁死成不可收起。
    // 这里改成一次性的 autoOpen：首次满足条件时自动展开一次，之后仍允许用户手动关闭。
    if (!autoOpen || hasAutoOpenedRef.current) {
      return;
    }

    toolLayoutOpenState.set(resolvedPersistOpenKey, true);
    setShouldRenderContent(true);
    setIsOpen(true);
    hasAutoOpenedRef.current = true;
  }, [autoOpen, resolvedPersistOpenKey]);

  useEffect(() => {
    const wasRunning = previousIsRunningRef.current;
    previousIsRunningRef.current = isRunning;

    // 子智能体在执行完成后，如果继续保持展开，会把一长串子工具明细永久摊开，
    // 聊天流里会迅速变得很长，也和“运行中自动展开、完成后回到摘要”这套交互不一致。
    // 这里只在 running -> completed 的边沿自动收起一次，不影响用户后续手动再次展开查看细节。
    if (autoCollapseOnComplete && !isRunning && wasRunning) {
      toolLayoutOpenState.set(resolvedPersistOpenKey, false);
      setIsOpen(false);
    }
  }, [autoCollapseOnComplete, isRunning, resolvedPersistOpenKey]);

  useEffect(() => {
    if (isExpanded) {
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
        contentUnmountDelayRef.current = null;
      }
      setShouldRenderContent(true);
      return;
    }

    if (!shouldRenderContent) {
      return;
    }

    // 收起工具详情时不能立刻卸载 children。
    // Radix 会在 closed 动画里读取 --radix-collapsible-content-height；
    // 如果子内容先被卸载，内层高度变量会消失并继承外层历史消息的高度，
    // 导致详情区域短暂撑成超高空白块，下面内容看起来像全部闪没了。
    contentUnmountDelayRef.current = window.setTimeout(() => {
      setShouldRenderContent(false);
      contentUnmountDelayRef.current = null;
    }, TOOL_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS);

    return () => {
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
        contentUnmountDelayRef.current = null;
      }
    };
  }, [isExpanded, shouldRenderContent]);

  useEffect(() => {
    return () => {
      if (failureTooltipCopyResetRef.current !== null) {
        window.clearTimeout(failureTooltipCopyResetRef.current);
      }
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
      }
    };
  }, []);

  const handleCopyFailureTooltip = () => {
    if (typeof statusTooltip !== "string" || statusTooltip.trim().length === 0) {
      return;
    }

    navigator.clipboard.writeText(statusTooltip).then(() => {
      setIsFailureTooltipCopied(true);
      if (failureTooltipCopyResetRef.current !== null) {
        window.clearTimeout(failureTooltipCopyResetRef.current);
      }
      failureTooltipCopyResetRef.current = window.setTimeout(() => {
        setIsFailureTooltipCopied(false);
        failureTooltipCopyResetRef.current = null;
      }, 1500);
    });
  };

  const statusWordNode =
    shouldShowStatusLabel && statusLabel != null ? (
      statusTooltip ? (
        // 失败态不再强制展开内容，错误详情改挂到状态文字 tooltip 上，
        // 这样 edit 卡片保持和成功态一致的展开逻辑，同时仍然能在 hover 时拿到报错原因。
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="whitespace-nowrap underline decoration-dotted underline-offset-2 cursor-help">
                {statusLabel}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" align="start" className="max-w-96">
              <div className="flex max-w-96 items-center gap-2">
                <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {statusTooltip}
                </span>
                {typeof statusTooltip === "string" && statusTooltip.trim().length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-md"
                    className="shrink-0"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      handleCopyFailureTooltip();
                    }}
                    title={intl.formatMessage({
                      id: isFailureTooltipCopied
                        ? "chat.toolCall.copyError.copied"
                        : "chat.toolCall.copyError",
                    })}
                    aria-label={intl.formatMessage({
                      id: isFailureTooltipCopied
                        ? "chat.toolCall.copyError.copied"
                        : "chat.toolCall.copyError",
                    })}
                  >
                    {isFailureTooltipCopied ? (
                      <CheckIcon className="size-3" />
                    ) : (
                      <CopyIcon className="size-3" />
                    )}
                  </Button>
                ) : null}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <span className="whitespace-nowrap">{statusLabel}</span>
      )
    ) : null;
  const statusNode =
    statusWordNode !== null && statusIndicator != null ? (
      <span className="inline-flex shrink-0 items-center gap-1.5">
        {statusIndicator}
        {statusWordNode}
      </span>
    ) : (
      statusWordNode
    );

  return (
    <Collapsible
      open={!hasSummaryAction && (forceOpen || (canToggle && isOpen))}
      onOpenChange={(open) => {
        if (hasSummaryAction || forceOpen) {
          return;
        }
        toolLayoutOpenState.set(resolvedPersistOpenKey, open);
        if (open) {
          setShouldRenderContent(true);
        }
        setIsOpen(open);
      }}
      className="w-full flex flex-col"
    >
      <ToolSummaryRow
        action={summaryAction}
        animateContent={animateSummaryContent}
        canToggle={canToggle}
        contentKey={resolvedSummaryContentKey}
        contentRefreshVersion={summaryContentRefreshVersion}
        diffCount={shouldShowDiffCount ? diffCount : undefined}
        disableContentAnimation={disableSummaryContentAnimation}
        forceOpen={forceOpen}
        icon={summaryIcon}
        isExpanded={isExpanded}
        kindDetail={summaryKindDetail}
        kindLabel={summaryKindLabel}
        kindLabelClassName={kindLabelClassName}
        primaryText={summaryPrimaryText}
        prioritizePrimaryText={prioritizePrimaryText}
        secondaryText={summarySecondaryText}
        showIcon={showIcon}
        sourceLabel={sourceLabel}
        statusNode={statusNode}
        title={summaryTitle}
        toggleAriaLabel={intl.formatMessage({
          id: isExpanded ? "chat.toolCall.collapseDetails" : "chat.toolCall.expandDetails",
        })}
        toolId={toolId}
      />
      {!hasSummaryAction && canToggle ? (
        <CollapsibleContent className={TOOL_CONTENT_SHELL_CLASSNAME}>
          {/* padding 直接挂在高度动画节点上时，主体归零后仍会停在 8px，
              直到延迟卸载切换 display:none 才瞬间消失。放入内部后会被外层 overflow
              随动画高度连续裁切到 0，保留原间距且不改变 300ms 的测量保护。 */}
          <div className={TOOL_CONTENT_SPACING_CLASSNAME}>{resolvedContent}</div>
        </CollapsibleContent>
      ) : !hasSummaryAction && forceOpen ? (
        <div className={cn(TOOL_CONTENT_SHELL_CLASSNAME, TOOL_CONTENT_SPACING_CLASSNAME)}>
          {resolvedContent}
        </div>
      ) : null}
    </Collapsible>
  );
}

export const ToolLayout = memo(function ToolLayoutWithPreview(props: ToolLayoutProps) {
  const preview = useContext(SummaryPreviewContext);
  const iconOnly = useContext(SummaryIconOnlyContext);
  // 统计图标直接复用原 renderer 的图标，不挂载摘要正文、详情或动画状态。
  if (iconOnly) return <>{props.icon}</>;
  // 分组头只展示原始摘要，不挂载详情、自动展开或写入原工具的展开记忆。
  return (
    <ToolLayoutComponent
      {...props}
      {...(preview
        ? {
            persistOpenKey: `summary-preview:${props.toolId}`,
            canToggle: false,
            forceOpen: false,
            autoOpen: false,
            autoCollapseOnComplete: false,
            summaryAction: undefined,
            content: undefined,
            renderContent: undefined,
            animateSummaryContent: false,
          }
        : {})}
    />
  );
});
ToolLayout.displayName = "ToolLayout";
