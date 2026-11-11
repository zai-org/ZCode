import type { CSSProperties, ReactNode } from "react";
import {
  ArrowUpRightIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleXIcon,
  LoaderCircle,
  TerminalIcon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LaneClass, StepRunStatus } from "@/components/workflow-graph/types.js";
import { WorkflowAgentFace, agentColor } from "@/components/workflow-timeline/WorkflowAgentFace.js";

export { agentColor, avatarColor } from "@/components/workflow-timeline/WorkflowAgentFace.js";

/**
 * 子代理药丸：带色头像 +
 * 名字 + 右侧状态标记。卡片的站下与侧栏的行都是它——同一个特性只有一枚药丸。
 *
 * 头像是瓦片脸（`WorkflowAgentFace`）：机身色按代理编号取九色环，表情读 status。
 * 工作区没有身份，所以没有颜色，只有终端字形。`pending` 与无状态逐像素相同（不变式 3）：
 * 没有标记、名字用次淡色、脸睡着。
 *
 * 可打开（`open` 在场）时整枚药丸就是按钮：悬停四件事同时落地（底色抬一级、头像色相的
 * 内描边、头像放大加深、尾槽里 ↗ 顶替状态标记），点一下直接开那个子代理的 transcript。不可
 * 打开的药丸没有悬停态；`inertTitle` 说明为什么。
 *
 * 尾槽（`wf-pill-tail`）是状态标记与 ↗ 共用的一格 14px：两者叠在同一格里，悬停时标记缩出、
 * 箭头缩入。所以子代理药丸与脚本药丸的状态标记落在同一条右缘上——↗ 从不占自己的位置
 * （↗ 隐身时不能仍占位：否则子代理的标记会比工作区的偏左一格）。
 */

/** 车道字形：agent 车道是瓦片脸（编号定色、status 定表情），工作区 / 未解析车道是图标。 */
export function LaneGlyph({
  laneClass,
  className,
  avatarIndex,
  name,
  status,
}: {
  laneClass: LaneClass;
  className?: string;
  name: string;
  avatarIndex?: number | undefined;
  status?: StepRunStatus | undefined;
}) {
  if (laneClass === "agent") {
    return (
      <WorkflowAgentFace
        avatarIndex={avatarIndex}
        className={className}
        name={name}
        status={status}
        showCompletionMark={status === "done"}
      />
    );
  }
  const Glyph = laneClass === "workspace" ? TerminalIcon : CircleHelpIcon;
  return <Glyph aria-hidden className={className} />;
}

/** 状态标记：转圈 / 对勾 / 叉；`pending` 与 undefined 没有标记。状态变化时新标记弹入；可打开的药丸悬停时它让位给 ↗。 */
export function PillStatusMark({ status }: { status: StepRunStatus | undefined }) {
  const { intl } = useZCodeIntl();
  if (status === undefined || status === "pending") return null;
  const label = intl.formatMessage({ id: `chat.toolCall.workflow.graph.status.${status}` });
  return (
    <span
      aria-label={label}
      className={cn(
        "wf-mark flex size-3.5 shrink-0 items-center justify-center",
        // 运行圆环使用中性色，避免正常加载被读成警告。
        status === "running" && "text-foreground-subtle",
        status === "done" && "text-foreground-subtle",
        status === "failed" && "text-destructive",
      )}
      data-testid="workflow-pill-status"
      key={status}
      role="img"
      title={label}
    >
      {status === "running" ? (
        <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
      ) : status === "done" ? (
        <CircleCheckIcon aria-hidden className="size-3.5" />
      ) : (
        <CircleXIcon aria-hidden className="size-3.5" />
      )}
    </span>
  );
}

/** 药丸可打开时的接线：点击回调、无障碍标签、↗ 的 testid 与数据属性（侧栏行用它们钉住实例）。 */
export interface WorkflowAgentPillOpen {
  onOpen: () => void;
  label: string;
  testId?: string;
  data?: Record<`data-${string}`, string>;
}

export function WorkflowAgentPill({
  children,
  avatarIndex,
  className,
  enterDelayMs,
  inertTitle,
  laneClass,
  name,
  open,
  size = "md",
  status,
  title,
  trailing,
}: {
  avatarIndex?: number | undefined;
  /** 入场延迟（一列药丸依次落地，每枚错 30 ms）；缺席即立刻。 */
  enterDelayMs?: number;
  /** 已本地化的显示名（运行时名 > 车道显示名）。 */
  name: string;
  laneClass: LaneClass;
  status: StepRunStatus | undefined;
  title?: string;
  className?: string;
  /** 在场即整枚药丸是按钮（回调的存在即门控）。 */
  open?: WorkflowAgentPillOpen;
  /** 不可打开时的提示（「子代理启动后才有会话记录」）；缺席时退回 title / name。 */
  inertTitle?: string;
  /** 名字之后、状态标记之前的附属信息（侧栏行的活动与计数）。 */
  children?: ReactNode;
  /** 状态标记之后的控件。 */
  trailing?: ReactNode;
  /** `row`（24 px、静止时没有底色、悬停才成药丸）给侧板名单的两列；缺省 32 px。 */
  size?: "md" | "row";
}) {
  const { intl } = useZCodeIntl();
  const tinted = laneClass === "agent";
  const completedAgent = tinted && status === "done";
  // 有延迟的入场要 backwards 填充：等待期间保持起始帧，否则药丸先满显再闪一下重新进场。
  // 不用 both：forwards 会把 transform 留在元素上。
  const style = {
    ...(tinted ? { "--wf-avatar": agentColor(avatarIndex, name) } : {}),
    ...(enterDelayMs === undefined || enterDelayMs <= 0
      ? {}
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" as const }),
  } as CSSProperties;
  const settled = status !== undefined && status !== "pending";
  const hasMark = settled && !completedAgent;
  const hasTail = hasMark || open !== undefined;
  const Root = open === undefined ? "span" : "button";
  const body = (
    <>
      <LaneGlyph
        laneClass={laneClass}
        name={name}
        avatarIndex={avatarIndex}
        status={status}
        className={cn(
          "shrink-0",
          size === "row" ? "size-3.5" : "size-4",
          tinted ? "text-[var(--wf-avatar)]" : "text-foreground-subtle",
        )}
      />
      <span
        className={cn(
          "wf-pill-name min-w-0 flex-1 truncate",
          settled ? "text-foreground" : "text-foreground-subtle",
        )}
      >
        {name}
      </span>
      {children}
      {completedAgent ? (
        <span className="sr-only">
          {intl.formatMessage({ id: "chat.toolCall.workflow.graph.status.done" })}
        </span>
      ) : null}
      {hasTail ? (
        <span
          className="wf-pill-tail grid size-3.5 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1"
          data-testid="workflow-pill-tail"
        >
          {/* 代理完成勾已移到头像角标，末尾仅保留详情入口。 */}
          {hasMark ? <PillStatusMark status={status} /> : null}
          {open === undefined ? null : (
            <span
              aria-hidden
              className="wf-pill-go flex size-3.5 items-center justify-center text-foreground-subtlest"
              data-testid={open.testId ?? "workflow-pill-open"}
              {...open.data}
            >
              <ArrowUpRightIcon className="size-3.5" />
            </span>
          )}
        </span>
      ) : null}
      {trailing}
    </>
  );
  return (
    <Root
      aria-label={open?.label}
      className={cn(
        "wf-pill wf-agent-pill wf-arrive flex rounded-full min-w-0 items-center",
        size === "row"
          ? "h-6 gap-1.5 pl-1 pr-1.5 text-ui-sm"
          : "h-8 gap-2 bg-surface pl-2 pr-2.5 text-ui-sm",
        open !== undefined &&
          "wf-pill-open cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
      data-agent-open={open === undefined ? undefined : "true"}
      data-agent-status={status ?? "pending"}
      data-pill-size={size}
      data-testid="workflow-agent-pill"
      onClick={open?.onOpen}
      style={style}
      title={open === undefined ? (inertTitle ?? title ?? name) : (title ?? name)}
      {...(open === undefined ? {} : { type: "button" as const })}
    >
      {body}
    </Root>
  );
}
