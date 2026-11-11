import { PenIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import type { TimelineFill, TimelineHole } from "@/components/workflow-timeline/timeline-holes.js";
import { workflowRunQuestionWaitedLabel } from "@/app-shell/workflowRunQuestions.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 侧板脊线上的留白零件（docs/dynamic-workflow/presentation.md「Holes on the timeline」的「The pane」）。
 * 从 WorkflowRunPhaseList.tsx 拆出（max-lines 门）。
 *
 * - 留白的节头：虚线灯（等待时警示色描边 + 3px 常亮光晕）落在主轨上；补全后名字后面是笔标。
 * - 等待中的节体：等了多久、「等待主代理补全」。提示全文不在投影里（它随通知走），这里不复述。
 * - 有阶段的补全：一行 24px 的标题站在它写下的第一节之前，笔（14px，底色盖住主轨）落在灯的位置，
 *   然后是名字。补全的几节**不缩进**（用户修订 2026-09-29：嵌套由框套框说出）；标题是这次补全的头，
 *   指针或焦点落在它上面时画出框（WorkflowRunFillFrames.tsx）。
 */

export function SpineHoleLamp({
  hole,
  pitch,
  track = 0,
}: {
  hole: TimelineHole;
  pitch: number;
  track?: number;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "wf-lamp absolute left-4 top-[13px] size-2.5 rounded-full border-[1.5px] border-dashed bg-background",
        hole.state === "waiting"
          ? "wf-lamp-hole-waiting border-warning"
          : "border-foreground-subtlest",
      )}
      data-lamp={`hole-${hole.state}`}
      data-testid="workflow-run-phase-lamp"
      style={track === 0 ? undefined : { left: 16 + pitch * track }}
    />
  );
}

/** 等待中的留白的节体（docs/dynamic-workflow/presentation.md「The pane」）：等了多久 + 「等待主代理补全」+ 主代理收到的提示语。 */
export function HoleWaitingBody({ hole, now }: { hole: TimelineHole; now: number }) {
  const { intl } = useZCodeIntl();
  const waited = workflowRunQuestionWaitedLabel(hole.since, now, (descriptor, values) =>
    intl.formatMessage(descriptor, values),
  );
  return (
    <div
      className="flex flex-col gap-1 pb-3 pr-3 text-ui-sm text-foreground-subtle"
      data-testid="workflow-run-hole-waiting"
    >
      <span className="text-warning">
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.hole.waitingFor" })}
        {waited === undefined ? null : ` · ${waited}`}
      </span>
      {hole.prompt === undefined ? null : (
        <p
          className="whitespace-pre-wrap break-words text-foreground"
          data-testid="workflow-run-hole-prompt"
        >
          {hole.prompt}
        </p>
      )}
    </div>
  );
}

/**
 * 补全的标题行：站在它写下的第一节之前。主轨从上到下穿过这一行，笔盖在轨上（底色遮住那一截）。
 * 它是框的图例：笔与名字都带底色，框的上缘从它们后面穿过。悬停只换字色、不铺底（铺了底，名字的
 * 底色就成了一块补丁）。点它与点节头同一条路（展开 / 落点由清单管）；tooltip 与卡上的头同一句。
 */
export function FillHeadingRow({
  fill,
  fresh = false,
  on = false,
  onSelect,
  textColumn,
}: {
  fill: TimelineFill;
  textColumn: { paddingLeft: number } | undefined;
  /** 它的框此刻画着。 */
  on?: boolean;
  /** 补全刚接进 run 的两秒：笔与名字染警示色。 */
  fresh?: boolean;
  onSelect?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  // 时间按界面语言格式化（不传 locale 会落到系统语言，例如中文系统 + 日语界面显示「下午3:00」）
  const time =
    fill.filledAt === undefined ? undefined : new Date(fill.filledAt).toLocaleTimeString(locale);
  const title = intl.formatMessage(
    {
      id:
        time === undefined
          ? "chat.toolCall.workflow.hole.head.title.untimed"
          : "chat.toolCall.workflow.hole.head.title",
    },
    { name: fill.name, time: time ?? "" },
  );
  const body = (
    <>
      <span
        aria-hidden
        className="absolute left-[14px] top-[5px] grid size-3.5 place-items-center bg-background"
      >
        <PenIcon className="size-3.5" />
      </span>
      <span className="min-w-0 truncate bg-background pr-1.5 text-ui-sm font-medium">
        {fill.name}
      </span>
    </>
  );
  const className = cn(
    "wf-fill-head relative flex h-6 w-full items-center gap-1.5 pl-[39px] pr-3 text-left outline-none",
    fresh ? "text-warning" : on ? "text-foreground" : "text-foreground-subtle",
  );
  const shared = {
    className,
    "data-fill-head": fill.holeId,
    "data-fill-heading": fill.holeId,
    "data-fill-on": on ? "true" : undefined,
    "data-testid": "workflow-run-fill-heading",
    style: textColumn,
    title,
  };
  return onSelect === undefined ? (
    <div {...shared}>{body}</div>
  ) : (
    <button
      {...shared}
      aria-label={intl.formatMessage(
        { id: "chat.toolCall.workflow.hole.open" },
        { name: fill.name },
      )}
      className={cn(
        className,
        "cursor-pointer hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
      onClick={onSelect}
      type="button"
    >
      {body}
    </button>
  );
}
