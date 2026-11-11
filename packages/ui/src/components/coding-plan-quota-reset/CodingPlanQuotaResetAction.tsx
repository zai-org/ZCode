import { CheckIcon, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CodingPlanResetType } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { burstCodingPlanQuotaResetConfetti } from "@/lib/codingPlanQuotaResetConfetti.js";

const MANUAL_RESET_SUCCESS_DISPLAY_MS = 600;

type CodingPlanQuotaResetActionBehavior =
  | { onOpenDialog: () => void; onReset?: never }
  | { onOpenDialog?: never; onReset: () => Promise<void> };

export function LocalizedCodingPlanQuotaResetAction({
  completedAt,
  processing,
  onOpenDialog,
  onReset,
  autoCelebrateCompletedAt,
  onAutoCelebrated,
  resetType = "FIVE_HOUR",
}: {
  completedAt: number | null;
  processing: boolean;
  /** 自动/运营完成时由 Composer 触发器在 hover 展开面板后要求补播撒花的 used_at；手动重置为 null。 */
  autoCelebrateCompletedAt?: number | null;
  onAutoCelebrated?: (completedAt: number) => void;
  /** 五小时与周额度共用同一按钮组件，仅无障碍/处理中文案按类型区分。 */
  resetType?: CodingPlanResetType;
} & CodingPlanQuotaResetActionBehavior) {
  const { intl, locale } = useZCodeIntl();
  const completedTime = completedAt
    ? new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(completedAt)
    : null;

  return (
    <CodingPlanQuotaResetAction
      ariaLabel={intl.formatMessage({
        id:
          resetType === "WEEK"
            ? "codingPlan.quotaReset.resetAriaWeek"
            : "codingPlan.quotaReset.resetAria",
      })}
      autoCelebrateCompletedAt={autoCelebrateCompletedAt}
      completedAt={completedAt}
      completedLabel={intl.formatMessage({
        id: "codingPlan.quotaReset.completed",
      })}
      completedTooltipLabel={
        completedTime
          ? intl.formatMessage({ id: "codingPlan.quotaReset.completedAt" }, { time: completedTime })
          : undefined
      }
      processing={processing}
      processingLabel={intl.formatMessage({
        id:
          resetType === "WEEK"
            ? "codingPlan.quotaReset.processingWeek"
            : "codingPlan.quotaReset.processing",
      })}
      resetLabel={intl.formatMessage({ id: "codingPlan.quotaReset.reset" })}
      successLabel={intl.formatMessage({ id: "codingPlan.quotaReset.success" })}
      onAutoCelebrated={onAutoCelebrated}
      {...(onOpenDialog ? { onOpenDialog } : { onReset: onReset! })}
    />
  );
}

export function CodingPlanQuotaResetAction({
  ariaLabel,
  autoCelebrateCompletedAt,
  completedAt,
  completedLabel,
  completedTooltipLabel,
  processing,
  processingLabel,
  resetLabel,
  successLabel,
  onAutoCelebrated,
  onOpenDialog,
  onReset,
  onCelebrate = burstCodingPlanQuotaResetConfetti,
}: {
  ariaLabel: string;
  autoCelebrateCompletedAt?: number | null;
  completedAt: number | null;
  completedLabel: string;
  completedTooltipLabel?: string;
  processing: boolean;
  processingLabel: string;
  resetLabel: string;
  successLabel: string;
  onAutoCelebrated?: (completedAt: number) => void;
  onCelebrate?: (origin: HTMLElement) => void;
} & CodingPlanQuotaResetActionBehavior) {
  const [localProcessing, setLocalProcessing] = useState(false);
  const [successCompletedAt, setSuccessCompletedAt] = useState<number | null>(null);
  const previousCompletedAtRef = useRef(completedAt);
  const clickedOriginRef = useRef<HTMLElement | null>(null);
  const awaitingOwnCompletionRef = useRef(false);
  // 自动/运营完成时的“已重置”文案元素，用于从与手动重置相同的位置补播撒花。
  const completedTextRef = useRef<HTMLSpanElement | null>(null);
  const autoCelebratedCompletedAtRef = useRef<number | null>(null);
  const effectiveProcessing = processing || localProcessing;

  useEffect(() => {
    const previousCompletedAt = previousCompletedAtRef.current;
    previousCompletedAtRef.current = completedAt;
    if (
      completedAt === null ||
      completedAt === previousCompletedAt ||
      !awaitingOwnCompletionRef.current
    ) {
      return;
    }

    // 成功动效只能由服务端 used_at 驱动，不能在点击时用 Date.now() 乐观伪造完成。
    awaitingOwnCompletionRef.current = false;
    setSuccessCompletedAt(completedAt);
    if (clickedOriginRef.current) {
      onCelebrate(clickedOriginRef.current);
    }
  }, [completedAt, onCelebrate]);

  // 自动/运营重置：用户 hover 触发器展开面板后（Composer 传入 autoCelebrateCompletedAt），
  // 从“已重置”文案位置补播一次撒花。手动重置由上方点击分支撒花，此处不会命中（未 arm）。
  useEffect(() => {
    if (
      autoCelebrateCompletedAt == null ||
      completedAt === null ||
      autoCelebrateCompletedAt !== completedAt ||
      autoCelebratedCompletedAtRef.current === completedAt
    ) {
      return;
    }

    // 不能在浮层刚提交 DOM 时立即消费 arm：面板尚未完成挂载/定位就可能播放完动画。
    // 延后一帧确认锚点仍连接在文档中，且只有真正调用撒花后才标记已播放；关闭浮层会取消该帧。
    const frameId = window.requestAnimationFrame(() => {
      const origin = completedTextRef.current;
      if (!origin?.isConnected) {
        return;
      }
      onCelebrate(origin);
      autoCelebratedCompletedAtRef.current = completedAt;
      onAutoCelebrated?.(completedAt);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [autoCelebrateCompletedAt, completedAt, onAutoCelebrated, onCelebrate]);

  useEffect(() => {
    if (successCompletedAt === null) {
      return;
    }
    const timer = window.setTimeout(
      () => setSuccessCompletedAt(null),
      MANUAL_RESET_SUCCESS_DISPLAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [successCompletedAt]);

  const awaitingSuccessRender = Boolean(
    completedAt !== null &&
    awaitingOwnCompletionRef.current &&
    completedAt !== previousCompletedAtRef.current,
  );
  const showSuccess =
    completedAt !== null && (successCompletedAt === completedAt || awaitingSuccessRender);

  if (showSuccess) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label={successLabel}
        disabled
        className="rounded-md px-1 text-ui-sm text-success hover:text-success"
      >
        <CheckIcon
          className="size-3 animate-in zoom-in-75 motion-reduce:animate-none"
          aria-hidden="true"
        />
      </Button>
    );
  }

  if (completedAt !== null) {
    const completedText = (
      <span
        ref={completedTextRef}
        // min-h 与「重置」按钮的 xs 尺寸(h-5)一致:三种状态等高,避免完成态把
        // 所在额度条的标签行撑高,导致同排其他额度条的数值与进度条错位。
        className="inline-flex min-h-5 items-center text-ui-xs text-foreground-subtlest tabular-nums"
        tabIndex={completedTooltipLabel ? 0 : undefined}
      >
        {completedLabel}
      </span>
    );

    return completedTooltipLabel ? (
      <ControlHintTooltip title={completedTooltipLabel}>{completedText}</ControlHintTooltip>
    ) : (
      completedText
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-label={effectiveProcessing ? processingLabel : ariaLabel}
      disabled={effectiveProcessing}
      className="rounded-md bg-interaction-confirmation-surface px-1 text-ui-sm text-interaction-confirmation-foreground hover:bg-interaction-confirmation-surface hover:text-interaction-confirmation-foreground"
      onClick={(event) => {
        if (effectiveProcessing || completedAt) {
          return;
        }
        // 页面额度标题旁入口只负责打开统一弹窗；不预先进入 processing，也不直接核销机会。
        if (onOpenDialog) {
          onOpenDialog();
          return;
        }
        clickedOriginRef.current = event.currentTarget;
        awaitingOwnCompletionRef.current = true;
        setLocalProcessing(true);
        void onReset()
          .catch(() => {
            // 失败文案由联调 hook 统一 toast；Action 只负责恢复交互且不播放成功动效。
            awaitingOwnCompletionRef.current = false;
          })
          .finally(() => {
            setLocalProcessing(false);
          });
      }}
    >
      {effectiveProcessing ? (
        <LoaderCircle
          className="size-3 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        resetLabel
      )}
    </Button>
  );
}
