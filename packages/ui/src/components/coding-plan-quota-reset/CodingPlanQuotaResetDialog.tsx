import type { UIEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { CodingPlanResetType } from "@zcode/shared";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import { burstCodingPlanQuotaResetConfetti } from "@/lib/codingPlanQuotaResetConfetti.js";

const SUCCESS_DISPLAY_MS = 600;
// 确认页的「重置」与列表行的「重置」位置相近，连点会穿透；切到确认页后的这段时间内忽略确认点击。
const CONFIRM_ARM_DELAY_MS = 500;
const ROW_EXIT_MS = 820;

export interface CodingPlanQuotaResetDialogUsageItem {
  color: string;
  id: string;
  label: string;
  percentage: number | null;
  resetTime?: string;
  value: string;
}

export interface CodingPlanQuotaResetDialogResetItem {
  count: number;
  expiresAt: number | null;
  onReset: () => Promise<void>;
  processing?: boolean;
  resetType: CodingPlanResetType;
}

export interface CodingPlanQuotaResetDialogConfig {
  resetItems: CodingPlanQuotaResetDialogResetItem[];
  usageItems: CodingPlanQuotaResetDialogUsageItem[];
}

function getRemainingSeconds(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}

/**
 * 行是否仍持有可核销的机会；与 hasUsableCodingPlanQuotaResetOpportunity 同口径，
 * 只是不排除 processing——核销中的行要保留展示 loading。
 */
function isResetItemUsable(item: CodingPlanQuotaResetDialogResetItem, now: number): boolean {
  return item.count > 0 && item.expiresAt !== null && item.expiresAt > now;
}

export function formatCodingPlanQuotaResetCountdown(
  totalSeconds: number,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const values = {
    days: String(days),
    hours: String(hours),
    minutes: String(minutes),
    seconds: String(seconds),
  };
  if (days > 0) {
    return hours > 0
      ? formatMessage({ id: "codingPlan.quotaReset.countdown.daysHours" }, values)
      : formatMessage({ id: "codingPlan.quotaReset.countdown.daysOnly" }, values);
  }
  if (hours > 0) {
    return minutes > 0
      ? formatMessage({ id: "codingPlan.quotaReset.countdown.hoursMinutes" }, values)
      : formatMessage({ id: "codingPlan.quotaReset.countdown.hoursOnly" }, values);
  }
  return formatMessage({ id: "codingPlan.quotaReset.countdown.minutesSeconds" }, values);
}

function readScrollMasks(viewport: HTMLDivElement) {
  return {
    bottom: viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1,
    top: viewport.scrollTop > 1,
  };
}

function resetTypeLabelId(resetType: CodingPlanResetType) {
  return resetType === "WEEK"
    ? "codingPlan.quotaReset.dialog.week"
    : "codingPlan.quotaReset.dialog.fiveHour";
}

function resetTypeAriaId(resetType: CodingPlanResetType) {
  return resetType === "WEEK"
    ? "codingPlan.quotaReset.resetAriaWeek"
    : "codingPlan.quotaReset.resetAria";
}

function confirmTitleId(resetType: CodingPlanResetType) {
  return resetType === "WEEK"
    ? "codingPlan.quotaReset.confirmTitleWeek"
    : "codingPlan.quotaReset.confirmTitle";
}

// 弹框用量卡片 id 由三处入口统一为 fiveHour / weekly，确认页据此取当前剩余额度做前后对比。
function usageItemIdForResetType(resetType: CodingPlanResetType) {
  return resetType === "WEEK" ? "weekly" : "fiveHour";
}

function confirmTypeAriaId(resetType: CodingPlanResetType) {
  return resetType === "WEEK"
    ? "codingPlan.quotaReset.confirmAriaWeek"
    : "codingPlan.quotaReset.confirmAria";
}

export function CodingPlanQuotaResetDialog({
  config,
  open,
  onOpenChange,
}: {
  config: CodingPlanQuotaResetDialogConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  // Bugfix：核销不可撤回，曾经点一下「重置」就直接 /use，用户误触白白消耗机会（周重置卡尤甚）。
  // 现在点「重置」先切到确认页，展示将用掉哪次机会与额度变化，再点「重置」才核销；
  // 返回、Esc 或关闭弹框都不消耗。
  const [confirmingType, setConfirmingType] = useState<CodingPlanResetType | null>(null);
  const [resettingType, setResettingType] = useState<CodingPlanResetType | null>(null);
  const [successfulType, setSuccessfulType] = useState<CodingPlanResetType | null>(null);
  const [exitingType, setExitingType] = useState<CodingPlanResetType | null>(null);
  const [scrollMasks, setScrollMasks] = useState({ bottom: false, top: false });
  const resetListRef = useRef<HTMLDivElement>(null);
  const confirmArmedAtRef = useRef(0);
  // 确认页替换了列表，成功撒花要从对应行的「重置」按钮发出。
  const rowResetButtonRefs = useRef<Partial<Record<CodingPlanResetType, HTMLButtonElement | null>>>(
    {},
  );
  const timersRef = useRef<number[]>([]);
  const wasOpenRef = useRef(false);
  // 成功反馈结束时要按最新的 config 决定行去留，延时任务里的 item 是点击时的旧快照。
  const resetItemsRef = useRef(config.resetItems);

  useEffect(() => {
    resetItemsRef.current = config.resetItems;
  }, [config.resetItems]);

  useEffect(() => {
    if (open !== wasOpenRef.current) {
      // 成功反馈使用延时任务收起行；若用户中途关闭并重新打开，旧任务会污染新弹框状态。
      for (const timer of timersRef.current) window.clearTimeout(timer);
      timersRef.current = [];
    }
    if (open && !wasOpenRef.current) {
      setConfirmingType(null);
      setResettingType(null);
      setSuccessfulType(null);
      setExitingType(null);
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
    },
    [],
  );

  // Bugfix：弹框曾在本地另记一份「已核销张数」，与 entry 的机会余额形成两个数据源。
  // 完成态又把余额清零，核销一张后余下的行拿到空到期，渲染成「0 分 0 秒后过期」，
  // 重开弹框才被新 status 校正。现在 completed 如实携带余下机会，张数/到期/能否展示
  // 只读 config；动画中的行（点击 → 成功 → 收起）临时保留。
  const visibleResetItems = config.resetItems.filter(
    (item) =>
      isResetItemUsable(item, now) ||
      resettingType === item.resetType ||
      successfulType === item.resetType ||
      exitingType === item.resetType,
  );

  useEffect(() => {
    const viewport = resetListRef.current;
    if (viewport) setScrollMasks(readScrollMasks(viewport));
  }, [visibleResetItems.length]);

  const updateScrollMasks = (event: UIEvent<HTMLDivElement>) => {
    const next = readScrollMasks(event.currentTarget);
    setScrollMasks((current) =>
      current.top === next.top && current.bottom === next.bottom ? current : next,
    );
  };

  // 机会在确认期间过期、被其它入口用完或被其它入口发起核销（processing）时，确认页自动退回列表，
  // 由列表行展示进行中状态；否则确认按钮可点却被 resetLimit 静默忽略。本页自己的确认会先清掉
  // 确认类型再进入 processing，不受此判定影响。
  const confirmingItem =
    confirmingType === null
      ? null
      : (visibleResetItems.find(
          (item) =>
            item.resetType === confirmingType && !item.processing && isResetItemUsable(item, now),
        ) ?? null);
  // Bugfix：目标失效时只把 confirmingItem 派生为 null、confirmingType 仍残留，同类机会之后再出现
  // （弹框由另一类机会保持挂载）会自动跳回旧确认页，且沿用旧的进入时间，一点就核销。
  // 失效即清掉确认类型，回到列表；再进确认页只能点行内「重置」，那里会重新记录进入时间。
  // 用渲染期调整状态而非 effect，避免先提交一帧「类型残留」的中间态。
  if (confirmingType !== null && confirmingItem === null) {
    setConfirmingType(null);
  }
  const confirmingUsage = confirmingItem
    ? config.usageItems.find(
        (usage) => usage.id === usageItemIdForResetType(confirmingItem.resetType),
      )
    : undefined;

  const resetLimit = async (item: CodingPlanQuotaResetDialogResetItem) => {
    if (resettingType !== null || item.processing) return;
    setConfirmingType(null);
    setResettingType(item.resetType);
    try {
      await item.onReset();
      setSuccessfulType(item.resetType);
      const origin = rowResetButtonRefs.current[item.resetType];
      if (origin) burstCodingPlanQuotaResetConfetti(origin);
      // 成功反馈结束时按最新 config 决定去留：同类型仍有余下机会则留在原位恢复可点击
      // （张数与最早到期已由完成态携带），否则收起该行。onReset 在 status 对账写入后才
      // resolve，此时 config 已是核销后的读数。
      const settleTimer = window.setTimeout(() => {
        const latest = resetItemsRef.current.find(
          (candidate) => candidate.resetType === item.resetType,
        );
        if (latest && isResetItemUsable(latest, Date.now())) {
          setResettingType(null);
          setSuccessfulType(null);
          return;
        }
        setExitingType(item.resetType);
        const removeTimer = window.setTimeout(() => {
          setResettingType(null);
          setSuccessfulType(null);
          setExitingType(null);
        }, ROW_EXIT_MS - SUCCESS_DISPLAY_MS);
        timersRef.current.push(removeTimer);
      }, SUCCESS_DISPLAY_MS);
      timersRef.current.push(settleTimer);
    } catch {
      // 失败原因与 toast 由 useCodingPlanQuotaResetUi 统一处理；弹框只恢复可点击状态。
      setResettingType(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="w-[min(480px,calc(100vw-2rem))] max-w-none gap-5"
        onEscapeKeyDown={(event) => {
          // 确认页里 Esc 只退回列表，不直接关掉整个弹框。
          if (confirmingItem) {
            event.preventDefault();
            setConfirmingType(null);
          }
        }}
      >
        <div className="flex min-w-0 items-center gap-1.5 pr-8">
          {confirmingItem ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="-ml-1.5"
              aria-label={intl.formatMessage({ id: "codingPlan.quotaReset.dialog.back" })}
              onClick={() => setConfirmingType(null)}
            >
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
            </Button>
          ) : null}
          <DialogTitle className="min-w-0 truncate text-ui-lg font-medium text-foreground">
            {intl.formatMessage({
              id: confirmingItem
                ? confirmTitleId(confirmingItem.resetType)
                : "codingPlan.quotaReset.dialog.title",
            })}
          </DialogTitle>
        </div>

        {confirmingItem ? (
          <section className="flex flex-col gap-5 animate-in fade-in-0 duration-150 motion-reduce:animate-none">
            {confirmingUsage ? (
              <div className="rounded-lg bg-surface p-4">
                <div className="text-ui-sm text-foreground-subtle">{confirmingUsage.label}</div>
                <div className="mt-2 flex items-center gap-2 tabular-nums">
                  <span className="text-ui-lg font-semibold leading-none text-foreground-subtle">
                    {confirmingUsage.value}
                  </span>
                  <ArrowRightIcon className="size-4 text-foreground-subtlest" aria-hidden="true" />
                  <span className="text-ui-lg font-semibold leading-none text-foreground">
                    {new Intl.NumberFormat(locale, { style: "percent" }).format(1)}
                  </span>
                </div>
              </div>
            ) : null}
            {confirmingItem.expiresAt !== null ? (
              // 服务端 /use 总是核销最早到期的那次，写明到期日，让用户知道用掉的是哪次。
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: "codingPlan.quotaReset.dialog.confirmHint" },
                  {
                    date: new Intl.DateTimeFormat(locale, {
                      month: "long",
                      day: "numeric",
                    }).format(confirmingItem.expiresAt),
                  },
                )}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={intl.formatMessage({ id: "common.cancel" })}
                onClick={() => setConfirmingType(null)}
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                aria-label={intl.formatMessage({ id: confirmTypeAriaId(confirmingItem.resetType) })}
                className="bg-success text-success-foreground hover:bg-success/80"
                onClick={() => {
                  if (Date.now() - confirmArmedAtRef.current < CONFIRM_ARM_DELAY_MS) return;
                  void resetLimit(confirmingItem);
                }}
              >
                {intl.formatMessage({ id: "codingPlan.quotaReset.confirm" })}
              </Button>
            </div>
          </section>
        ) : (
          <>
            <section
              aria-label={intl.formatMessage({ id: "codingPlan.quotaReset.dialog.remaining" })}
            >
              <div
                className={`grid gap-2 ${getContextQuotaMeterGridClass(config.usageItems.length)} max-sm:grid-cols-1`}
              >
                {config.usageItems.map((item) => (
                  <div key={item.id} className="min-w-0 rounded-lg bg-surface p-3">
                    <div className="truncate text-ui-sm text-foreground-subtle">{item.label}</div>
                    <div className="mt-2 flex min-w-0 items-baseline gap-1.5">
                      <span className="text-ui-lg font-semibold leading-none text-foreground">
                        {item.value}
                      </span>
                      {item.resetTime ? (
                        <span className="min-w-0 truncate text-ui-xs text-foreground-subtle">
                          {item.resetTime}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background/50">
                      <div
                        className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
                        style={{
                          backgroundColor: item.color,
                          width: `${Math.max(0, Math.min(100, item.percentage ?? 0))}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {visibleResetItems.length > 0 ? (
              <section
                aria-label={intl.formatMessage({ id: "codingPlan.quotaReset.dialog.resettable" })}
              >
                <div className="relative">
                  <div
                    ref={resetListRef}
                    className="max-h-[262px] overflow-y-auto overscroll-contain pr-1"
                    onScroll={updateScrollMasks}
                  >
                    {visibleResetItems.map((item) => {
                      const success = successfulType === item.resetType;
                      const isExiting = exitingType === item.resetType;
                      const effectiveProcessing =
                        item.processing || resettingType === item.resetType;
                      // 同一类型可能持有多张机会，但服务端 /use 不支持指定核销哪一张，entry 只保留
                      // 张数与最早到期时刻（核销一张后由完成态携带余下的张数/到期）。多张时显式
                      // 标注张数与「最快」，避免用户把最早到期时间误读成全部机会的统一期限。
                      const hasMultipleOpportunities = item.count > 1;
                      return (
                        <div
                          key={item.resetType}
                          className={`grid min-w-0 transition-[grid-template-rows,opacity] duration-200 ease-out last:[&>div]:pb-0 motion-reduce:transition-none ${
                            isExiting
                              ? "pointer-events-none grid-rows-[0fr] opacity-0"
                              : "grid-rows-[1fr] opacity-100"
                          }`}
                        >
                          <div className="min-h-0 overflow-hidden pb-2">
                            <div className="flex min-w-0 items-center gap-3 rounded-lg bg-surface p-3 transition-colors hover:bg-surface-hover">
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate text-ui-base text-foreground">
                                    {intl.formatMessage({ id: resetTypeLabelId(item.resetType) })}
                                  </span>
                                  {hasMultipleOpportunities ? (
                                    <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-interaction-confirmation-surface px-1.5 text-ui-sm text-interaction-confirmation-foreground">
                                      {intl.formatMessage(
                                        { id: "codingPlan.quotaReset.dialog.itemCount" },
                                        { count: item.count },
                                      )}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle tabular-nums">
                                  {/* Bugfix：核销掉最后一张后行仍在播放成功/收起动画，此时没有到期时刻；
                                曾被当作 0 秒渲染成「0 分 0 秒后过期」。用不换行空格占位保持行高。 */}
                                  {item.expiresAt === null
                                    ? "\u00a0"
                                    : intl.formatMessage(
                                        {
                                          id: hasMultipleOpportunities
                                            ? "codingPlan.quotaReset.dialog.expiresInSoonest"
                                            : "codingPlan.quotaReset.dialog.expiresIn",
                                        },
                                        {
                                          time: formatCodingPlanQuotaResetCountdown(
                                            getRemainingSeconds(item.expiresAt, now),
                                            intl.formatMessage,
                                          ),
                                        },
                                      )}
                                </div>
                              </div>
                              <Button
                                ref={(node) => {
                                  rowResetButtonRefs.current[item.resetType] = node;
                                }}
                                type="button"
                                variant="default"
                                size="sm"
                                aria-label={
                                  success
                                    ? intl.formatMessage({ id: "codingPlan.quotaReset.success" })
                                    : intl.formatMessage({ id: resetTypeAriaId(item.resetType) })
                                }
                                className="bg-success text-success-foreground hover:bg-success/80"
                                disabled={Boolean(
                                  success ||
                                  effectiveProcessing ||
                                  (resettingType !== null && resettingType !== item.resetType),
                                )}
                                onClick={() => {
                                  confirmArmedAtRef.current = Date.now();
                                  setConfirmingType(item.resetType);
                                }}
                              >
                                {success ? (
                                  <>
                                    <CheckIcon className="size-3.5" aria-hidden="true" />
                                    {intl.formatMessage({ id: "codingPlan.quotaReset.completed" })}
                                  </>
                                ) : effectiveProcessing ? (
                                  <LoaderCircle
                                    className="size-3.5 animate-spin motion-reduce:animate-none"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  intl.formatMessage({ id: "codingPlan.quotaReset.reset" })
                                )}
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div
                    aria-hidden="true"
                    className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-popover to-transparent transition-opacity duration-150 ${
                      scrollMasks.top ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  <div
                    aria-hidden="true"
                    className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-popover to-transparent transition-opacity duration-150 ${
                      scrollMasks.bottom ? "opacity-100" : "opacity-0"
                    }`}
                  />
                </div>
              </section>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
