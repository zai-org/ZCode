import { useState } from "react";
import type { ZCodePlanStep } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Plan,
  PlanAction,
  PlanContent,
  PlanDescription,
  PlanHeader,
  PlanTitle,
} from "@/components/ai-elements/plan.js";
import {
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
} from "@/components/ai-elements/queue.js";
import { ChevronsUpDownIcon, ListTodo, LoaderCircle } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "./components/lib/utils.js";

const todoStatusIndicatorClasses: Record<ZCodePlanStep["status"], string> = {
  pending: "text-foreground-subtlest",
  in_progress: "text-foreground",
  completed: "text-success",
};

const todoStatusContentClassesStreaming: Record<ZCodePlanStep["status"], string> = {
  pending: "text-foreground-subtle",
  in_progress: "animated-gradient-text",
  completed: "text-foreground-subtlest line-through",
};

// Bugfix: 任务停止/结束后 plan 可能还留着 in_progress 项，如果继续套 animated-gradient-text，
// 面板就会一直显示 loading 态。非运行期降级为普通文本，仅保留状态色。
const todoStatusContentClassesIdle: Record<ZCodePlanStep["status"], string> = {
  pending: "text-foreground-subtle",
  in_progress: "text-foreground",
  completed: "text-foreground-subtlest line-through",
};

export function TodoPanel({
  plan,
  isStreaming,
}: {
  plan: ZCodePlanStep[] | null;
  isStreaming: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [isOpen, setIsOpen] = useState(false);

  if (!plan || plan.length === 0) {
    return null;
  }

  const completedCount = plan.filter((step) => step.status === "completed").length;
  const isAllCompleted = completedCount === plan.length;
  // Bugfix: provider 可能先把 todo 全部标成 completed，再稍后才推 task_complete 清空 store。
  // 这段间隙继续展示“已完成 todo”会让用户误以为还有待处理事项，所以全完成后直接隐藏面板。
  if (isAllCompleted) {
    return null;
  }

  // Bugfix: 展开态之前会把 completed 项继续画出来，只是加删除线；完成项越多面板越长。
  // 这里仅保留未完成项，让 todo 面板专注显示还需要关注的后续工作。
  const visiblePlan = plan.filter((step) => step.status !== "completed");
  const activeStep =
    plan.find((step) => step.status === "in_progress") ??
    plan.find((step) => step.status !== "completed") ??
    plan[plan.length - 1];
  // Bugfix: loading 视觉只在任务真正运行期出现。task 已完成/失败/被停止时，
  // 即便 plan 仍残留 in_progress 项，也不再转菊花或做渐变动画。
  const showLoadingState = isStreaming && !isAllCompleted;
  const todoStatusContentClasses = isStreaming
    ? todoStatusContentClassesStreaming
    : todoStatusContentClassesIdle;
  const toggleLabel = intl.formatMessage({ id: "todo.panel.toggle" });
  const toggleOpen = () => setIsOpen((current) => !current);

  return (
    <Plan
      className="gap-0 overflow-hidden rounded-none border-0 bg-popover py-0"
      open={isOpen}
      onOpenChange={setIsOpen}
      isStreaming={isStreaming}
    >
      {/* 修复原因：PlanHeader 负责撑满布局，不能再承担点击展开，否则空白区域也会误触。
          展开逻辑收敛到内容宽度按钮和右侧图标按钮，保留键盘与读屏状态。 */}
      <PlanHeader className={cn("group flex items-center gap-3 px-4 !py-3", isOpen && "!pb-1")}>
        <div className="flex min-w-0 flex-1 items-center">
          <button
            type="button"
            aria-expanded={isOpen}
            className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-3 rounded-md p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
            onClick={toggleOpen}
          >
            {isOpen ? (
              <>
                <ListTodo className="size-4 shrink-0 text-foreground" />
                <PlanTitle className="min-w-0 truncate text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: "todo.panel.title" })}
                </PlanTitle>
                <PlanDescription className="shrink-0 text-ui-base font-mono text-foreground-subtlest">
                  {`${completedCount}/${plan.length}`}
                </PlanDescription>
              </>
            ) : showLoadingState ? (
              <>
                <LoaderCircle className="size-4 shrink-0 animate-spin text-foreground" />
                <PlanTitle className="animated-gradient-text min-w-0 truncate text-ui-base font-medium">
                  {activeStep?.title ?? intl.formatMessage({ id: "todo.panel.currentTask" })}
                </PlanTitle>
              </>
            ) : (
              <>
                <ListTodo className="size-4 shrink-0 text-foreground" />
                <PlanTitle className="min-w-0 truncate text-ui-base font-medium text-foreground">
                  {activeStep?.title ?? intl.formatMessage({ id: "todo.panel.currentTask" })}
                </PlanTitle>
              </>
            )}
            {!isOpen ? (
              <PlanDescription className="shrink-0 text-ui-base font-mono text-foreground-subtle">
                {`${completedCount}/${plan.length}`}
              </PlanDescription>
            ) : null}
          </button>
        </div>
        <PlanAction className="shrink-0">
          <ControlHintTooltip
            title={intl.formatMessage({
              id: isOpen ? "chat.longRunning.collapse" : "chat.longRunning.expand",
            })}
          >
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-expanded={isOpen}
              aria-label={toggleLabel}
              onClick={(event) => {
                event.stopPropagation();
                toggleOpen();
              }}
            >
              <ChevronsUpDownIcon className="size-4" />
              <span className="sr-only">{toggleLabel}</span>
            </Button>
          </ControlHintTooltip>
        </PlanAction>
      </PlanHeader>
      <PlanContent className="p-1">
        <QueueList className="mt-0">
          {visiblePlan.map((step) => (
            <QueueItem
              key={step.id}
              className="gap-0 w-full rounded-xl px-3 py-2 hover:bg-hover/30"
            >
              <div className="flex min-w-0 items-center gap-3">
                <QueueItemIndicator
                  className={todoStatusIndicatorClasses[step.status]}
                  status={step.status}
                />
                <QueueItemContent
                  className={`min-w-0 line-clamp-none ${todoStatusContentClasses[step.status]}`}
                  completed={false}
                >
                  {step.title}
                </QueueItemContent>
              </div>
            </QueueItem>
          ))}
        </QueueList>
      </PlanContent>
    </Plan>
  );
}
