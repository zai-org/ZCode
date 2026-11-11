import { useBottomFollowingScroll } from "@/mentions/components/scrollMask.js";
import { useContext, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import { testId, TID_TOOL_SUMMARY_TRIGGER } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { QueuedSummaryContent } from "@/ToolCallBlocks/QueuedSummaryContent.js";

import {
  SummaryIconOnlyContext,
  SummaryPreviewContext,
  SummaryGroupBoundaryContext,
} from "@/v4/conversationRowContext.js";

export interface ToolSummaryAction {
  ariaLabel: string;
  onActivate: () => void;
  testId?: string;
}

export function handleToolSummaryActionKeyDown(
  event: Pick<KeyboardEvent<HTMLDivElement>, "key" | "preventDefault">,
  onActivate: () => void,
): boolean {
  if (event.key !== "Enter" && event.key !== " ") {
    return false;
  }

  event.preventDefault();
  onActivate();
  return true;
}

interface ToolSummaryRowProps {
  action?: ToolSummaryAction;
  animateContent: boolean;
  canToggle: boolean;
  contentKey: string;
  contentRefreshVersion?: string;
  diffCount?: ReactNode;
  disableContentAnimation: boolean;
  forceOpen: boolean;
  icon: ReactNode;
  isExpanded: boolean;
  kindDetail?: ReactNode;
  kindLabel: ReactNode;
  kindLabelClassName: string;
  primaryText: ReactNode;
  prioritizePrimaryText?: boolean;
  secondaryText?: ReactNode;
  showIcon: boolean;
  sourceLabel?: ReactNode;
  statusNode?: ReactNode;
  title?: string;
  toggleAriaLabel: string;
  toolId: string;
}

function SummaryLeadingContent({
  icon,
  kindDetail,
  kindLabel,
  kindLabelClassName,
  showIcon,
  sourceLabel,
  prioritizePrimaryText,
}: Pick<
  ToolSummaryRowProps,
  | "icon"
  | "kindDetail"
  | "kindLabel"
  | "kindLabelClassName"
  | "prioritizePrimaryText"
  | "showIcon"
  | "sourceLabel"
>) {
  // 收起的未闭合组头复用已完成工具摘要，扫光表达分组仍在继续，不改写工具状态。
  const preview = useContext(SummaryPreviewContext);
  return (
    <>
      {/* 图标槽直接拥有 hover 色，避免全局 SVG 选择器与图标自身的固定色类互相覆盖。 */}
      {showIcon ? (
        <span
          data-summary-leading-icon
          className="shrink-0 text-foreground-subtle [&_svg]:text-foreground-subtle group-hover/tool-summary:text-foreground group-hover/tool-summary:[&_svg]:text-foreground"
        >
          {icon}
        </span>
      ) : null}
      {kindLabel != null && kindLabel !== false && kindLabel !== "" ? (
        <span
          className={cn(
            "tool-summary-kind-label",
            kindLabelClassName,
            preview && "animated-gradient-text animated-gradient-text-foreground",
            prioritizePrimaryText && "@max-[360px]/conversation:hidden",
          )}
        >
          {kindLabel}
        </span>
      ) : null}
      {kindDetail ? <span className="min-w-0 shrink-0">{kindDetail}</span> : null}
      {sourceLabel ? (
        <span
          className={cn(
            "shrink-0 rounded border border-border bg-background-alt px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtlest",
            prioritizePrimaryText && "@max-[360px]/conversation:hidden",
          )}
        >
          {sourceLabel}
        </span>
      ) : null}
    </>
  );
}

function SummaryContent({
  animateContent,
  contentKey,
  contentRefreshVersion,
  diffCount,
  disableContentAnimation,
  isExpanded,
  primaryText,
  prioritizePrimaryText,
  secondaryText,
  statusNode,
}: Pick<
  ToolSummaryRowProps,
  | "animateContent"
  | "contentKey"
  | "contentRefreshVersion"
  | "diffCount"
  | "disableContentAnimation"
  | "isExpanded"
  | "primaryText"
  | "prioritizePrimaryText"
  | "secondaryText"
  | "statusNode"
>) {
  const hasSummaryContent = [primaryText, secondaryText, diffCount, statusNode].some(
    (node) => node != null && node !== false && node !== "",
  );

  // 展开态可能主动清空摘要，但渲染空 flex 容器的话，标题行的 gap
  // 会在“类别—空容器—箭头”之间计算两次，视觉上形成一块异常大的空白。
  if (!hasSummaryContent) {
    return null;
  }

  // 摘要字段统一由 gap 分隔，不插入装饰标点，也不改写工具或用户正文。
  return (
    <div
      className={cn(
        "tool-summary-content min-w-0 flex max-w-full items-center gap-2 font-normal text-foreground-subtle",
        prioritizePrimaryText && "flex-1 overflow-hidden",
      )}
    >
      <QueuedSummaryContent
        contentKey={contentKey}
        contentRefreshVersion={contentRefreshVersion}
        primaryText={primaryText}
        secondaryText={secondaryText}
        trailingText={diffCount}
        enabled={animateContent && !isExpanded}
        disableAnimation={disableContentAnimation}
      />
      {statusNode}
    </div>
  );
}

export function ToolSummaryRow(props: ToolSummaryRowProps) {
  const preview = useContext(SummaryPreviewContext);
  const { action, canToggle, forceOpen, isExpanded, title, toggleAriaLabel, toolId } = props;
  const sharedContent = (
    <>
      <SummaryLeadingContent {...props} />
      <SummaryContent {...props} />
    </>
  );

  if (preview) {
    return (
      <div className="summary-hover-text group/tool-summary flex min-w-0 max-w-full items-center gap-2 text-ui-base">
        {sharedContent}
      </div>
    );
  }

  if (action) {
    return (
      <div
        data-testid={action.testId ?? testId(TID_TOOL_SUMMARY_TRIGGER, toolId)}
        role="button"
        tabIndex={0}
        aria-label={action.ariaLabel}
        onClick={action.onActivate}
        onKeyDown={(event) => handleToolSummaryActionKeyDown(event, action.onActivate)}
        className="summary-hover-text group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
        title={title}
      >
        {sharedContent}
      </div>
    );
  }

  if (canToggle) {
    return (
      <CollapsibleTrigger asChild>
        <div
          data-testid={testId(TID_TOOL_SUMMARY_TRIGGER, toolId)}
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          aria-label={toggleAriaLabel}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") {
              return;
            }

            // 摘要内可能包含文件预览按钮，因此不能用满宽 button 包裹整行。
            // 保留 div trigger，并在这里补齐 Enter/Space 的展开能力。
            event.preventDefault();
            event.currentTarget.click();
          }}
          className="summary-hover-text group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          title={title}
        >
          {sharedContent}
          <ChevronRightIcon
            data-summary-chevron
            aria-hidden
            className={cn(
              "size-4 text-foreground-subtlest opacity-0 transition-transform transition-opacity duration-200 ease-out will-change-transform group-hover/tool-summary:opacity-100 shrink-0",
              isExpanded ? "rotate-90 opacity-100" : "rotate-0",
              forceOpen && "opacity-100",
            )}
          />
        </div>
      </CollapsibleTrigger>
    );
  }

  return (
    <div
      data-testid={testId(TID_TOOL_SUMMARY_TRIGGER, toolId)}
      className="summary-hover-text group/tool-summary cursor-default flex w-full items-center gap-2 text-left text-ui-base transition-colors focus-visible:outline-none"
      title={title}
    >
      {sharedContent}
    </div>
  );
}

/** 分组只持有展开状态；完整摘要继续由原始行 renderer 提供，避免复制工具文案和状态规则。 */
export function ConsecutiveSummaryGroup({
  summary,
  children,
  contentKey,
  refreshVersion,
  statistics,
  statisticsIcon,
  collapsedStatistics,
  lastRowId,
  hasActiveItem,
}: {
  summary: ReactNode;
  children: ReactNode;
  contentKey: string;
  refreshVersion: unknown;
  statistics: string;
  statisticsIcon?: ReactNode;
  collapsedStatistics?: ReactNode;
  lastRowId: number;
  hasActiveItem: boolean;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const scroll = useBottomFollowingScroll(open, children);
  const boundary = useContext(SummaryGroupBoundaryContext);
  // 工具暂时全部结束不代表结构闭合；只有整轮尾组可继续翻滚，后续边界立即封闭前组。
  const groupRunning = boundary.taskRunning && boundary.tailRowId === lastRowId;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="min-w-0"
      data-consecutive-summary-group
      data-group-running={groupRunning}
    >
      {/* 使用块级 flex，避免 inline-flex 的基线空隙抬高统计组头。 */}
      <CollapsibleTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          aria-expanded={open}
          aria-controls={contentId}
          data-summary-group-trigger
          aria-label={statistics}
          onKeyDown={(event) =>
            handleToolSummaryActionKeyDown(event, () => setOpen((value) => !value))
          }
          className="summary-hover-text group/tool-summary flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-2 text-ui-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
        >
          {/* 无活动项只是工具间隙；收起时保留末尾摘要，结构闭合后才切换统计。 */}
          {open || !groupRunning ? (
            <>
              <span
                data-summary-group-icon
                className="flex size-4 shrink-0 items-center justify-center text-foreground-subtle group-hover/tool-summary:text-foreground [&_svg]:size-4 [&_svg]:text-current"
              >
                <SummaryPreviewContext.Provider value={true}>
                  <SummaryIconOnlyContext.Provider value={true}>
                    {statisticsIcon ?? <BrainIcon className="size-4" />}
                  </SummaryIconOnlyContext.Provider>
                </SummaryPreviewContext.Provider>
              </span>
              <span
                // 统计文本允许收缩但不能换行，避免窄屏组头高度增加并挤动图标和箭头。
                className={cn(
                  "min-w-0 truncate text-foreground-subtle",
                  groupRunning &&
                    !hasActiveItem &&
                    "animated-gradient-text animated-gradient-text-foreground",
                )}
                data-summary-group-statistics
                title={statistics}
              >
                {open ? statistics : (collapsedStatistics ?? statistics)}
              </span>
            </>
          ) : (
            <div
              className="pointer-events-none flex min-w-0 items-center [&_button]:pointer-events-none"
              inert
            >
              {/* 翻滚组件是 inline-flex，块容器的行内基线会多出空隙，导致切换统计时上下抖动。 */}
              <SummaryPreviewContext.Provider value={true}>
                <QueuedSummaryContent
                  contentKey={contentKey}
                  contentRefreshVersion={refreshVersion}
                  primaryText={summary}
                  enabled={groupRunning}
                />
              </SummaryPreviewContext.Provider>
            </div>
          )}
          <ChevronRightIcon
            data-summary-chevron
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-foreground-subtlest opacity-0 transition-transform transition-opacity group-hover/tool-summary:opacity-100 group-focus-visible/tool-summary:opacity-100",
              open && "rotate-90",
            )}
          />
        </div>
      </CollapsibleTrigger>
      {/* 条件卸载会跳过收起动画，交由共享 Collapsible 的 Presence 管理生命周期。 */}
      <CollapsibleContent id={contentId}>
        <div
          ref={scroll.scrollRef}
          data-summary-group-scroll
          data-scroll-mask={scroll.maskData}
          onScroll={scroll.onScroll}
          style={scroll.maskStyle}
          // contain 会截断短内容和长内容边缘的滚动链；保留原生传递，让组内无可滚空间时滚动外层。
          className="mt-2 max-h-[calc(16lh+30*var(--spacing))] overflow-y-auto text-ui-base"
        >
          <div
            ref={scroll.contentRef}
            // 实体边框加 14px 内边距只有 23px，子文字会偏左；导线不占布局，8px + 16px 与组头文字严格对齐。
            // 组内思考原有导线与缩进会叠出第二层边界；由分组统一提供导线，正文与标题对齐，并收紧标题到正文的留白。
            className="relative ml-2 flex flex-col gap-2 pl-4 before:absolute before:inset-y-0 before:left-0 before:border-l before:border-border [&_[data-summary-leading-icon]]:hidden [&_[data-reasoning-content]>div>div]:pt-1 [&_[data-reasoning-scroll-mask]]:ml-0 [&_[data-reasoning-scroll-mask]]:border-l-0 [&_[data-reasoning-scroll-mask]]:pl-0"
            data-conversation-work-items="group"
          >
            {children}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
