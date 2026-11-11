/* eslint-disable max-lines -- Composer 用量入口集中维护多来源状态、弹层和重置交互；本阶段只迁移 Account Access，不拆分既有 UI 结构。 */
import { type CodingPlanResetType } from "@zcode/shared";
import { LoaderCircle } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  type CodingPlanUsageRemainingEntitlement,
  type CodingPlanUsageAvailableProvider,
  resolveCodingPlanUsageRemainingState,
} from "@/CodingPlanUsageRemainingPanel.js";
import { cn } from "@/components/lib/utils.js";
import { LocalizedCodingPlanQuotaResetAction } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetAction.js";
import { CodingPlanUsageHeaderAction } from "@/chat-input-toolbar/CodingPlanUsageHeaderAction.js";
import { CodingPlanUsageNotice } from "@/chat-input-toolbar/CodingPlanUsageNotice.js";
import { CodingPlanQuotaResetOpportunity } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.js";
import { buildCodingPlanQuotaResetDialogConfig } from "@/components/coding-plan-quota-reset/buildCodingPlanQuotaResetDialogConfig.js";
import { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  findCodingPlanQuotaLimit,
  formatQuotaRemainingPercentage,
  formatQuotaResetTime,
  getQuotaRemainingPercentage,
  resolveMcpQuotaLimit,
} from "@/lib/codingPlanQuotaPresentation.js";
import {
  resolveCodingPlanQuotaResetActionCompletedAt,
  resolveCodingPlanQuotaResetLimit,
} from "@/lib/codingPlanQuotaResetUi.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import { resolveChatCodingPlanResetOpportunityBadge } from "@/chat-input-toolbar/codingPlanResetOpportunityBadge.js";
import { ChatCodingPlanMcpUsageMeter } from "@/chat-input-toolbar/ChatCodingPlanMcpUsageMeter.js";
import type { SidebarUsageCodingPlanSourceId } from "@/lib/sidebarUsageCodingPlanProviderPreference.js";

export type ChatCodingPlanUsageRemainingConfig = {
  availableProviders: CodingPlanUsageAvailableProvider[];
  entitlements: CodingPlanUsageRemainingEntitlement[];
  onAccess?: () => Promise<void> | void;
  refreshing?: boolean;
  modelProvidersLoading: boolean;
  onEntitlementRefresh?: () => void | Promise<void>;
  onProviderChange?: (providerId: SidebarUsageCodingPlanSourceId) => void;
  onUsageClick?: () => void;
  selectedProviderId?: SidebarUsageCodingPlanSourceId;
};

/** Composer 触发器 hover 展开面板后要求补播撒花的自动完成 used_at,按重置类型定位到对应额度条。
 *  五小时与周额度可能各自 arm,因此按类型分别记录,互不覆盖。 */
export type CodingPlanQuotaResetAutoConfettiArms = Record<CodingPlanResetType, number | null>;

export function hasChatCodingPlanUsageRemaining(
  config: ChatCodingPlanUsageRemainingConfig,
): boolean {
  return (
    Boolean(resolveCodingPlanUsageRemainingState(config)) ||
    // 按需刷新下首次打开可能还没有快照；仍需保留 Context trigger，
    // 否则用户没有 hover 入口可以发起第一次请求。
    Boolean(config.onAccess && config.entitlements.length > 0)
  );
}

export function shouldShowContextQuotaResetTime({
  availableWidth,
  contentWidth,
}: {
  availableWidth: number;
  contentWidth: number;
}): boolean {
  return availableWidth > 0 && contentWidth <= availableWidth;
}

function formatContextFiveHourResetTime({
  locale,
  value,
}: {
  locale: string;
  value: number | null | undefined;
}): string | undefined {
  if (!value) return undefined;
  const resetAt = new Date(value);
  if (Number.isNaN(resetAt.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(resetAt);
}

function ChatCodingPlanUsageMeter({
  color,
  label,
  action,
  percentage,
  resetTime,
  value,
}: {
  color: string;
  label: string;
  action?: ReactNode;
  percentage: number | null;
  resetTime?: string;
  value: string;
}) {
  const valueRowRef = useRef<HTMLDivElement>(null);
  const fullValueRef = useRef<HTMLSpanElement>(null);
  const [showResetTime, setShowResetTime] = useState(Boolean(resetTime));
  const boundedPercentage = Number.isFinite(percentage)
    ? Math.max(0, Math.min(100, percentage ?? 0))
    : 0;

  useLayoutEffect(() => {
    if (!resetTime) {
      setShowResetTime(false);
      return;
    }
    const measure = () => {
      const availableWidth = valueRowRef.current?.clientWidth ?? 0;
      const contentWidth = fullValueRef.current?.scrollWidth ?? 0;
      setShowResetTime(shouldShowContextQuotaResetTime({ availableWidth, contentWidth }));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (valueRowRef.current) observer?.observe(valueRowRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [resetTime, value]);

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="min-w-0 space-y-0.5 text-ui-sm">
        {/* min-h 与重置动作(h-5)对齐:没有动作的额度条也保持同高,避免同排数值/进度条错位。 */}
        <div className="flex min-h-5 min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-foreground-subtle">{label}</span>
          {action ? <span className="shrink-0">{action}</span> : null}
        </div>
        <div
          ref={valueRowRef}
          className="relative min-w-0 overflow-hidden whitespace-nowrap text-ui-sm tabular-nums"
        >
          <span className="font-mono text-foreground">{value}</span>
          {resetTime && showResetTime ? (
            <span className="text-ui-xs text-foreground-subtle">
              {" · "}
              {resetTime}
            </span>
          ) : null}
          {resetTime ? (
            <span
              ref={fullValueRef}
              aria-hidden="true"
              className="invisible absolute left-0 whitespace-nowrap"
            >
              <span className="font-mono">{value}</span>
              <span className="text-ui-xs"> · {resetTime}</span>
            </span>
          ) : null}
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
            boundedPercentage > 0 ? "min-w-1.5" : undefined,
          )}
          style={{ backgroundColor: color, width: `${boundedPercentage}%` }}
        />
      </div>
    </div>
  );
}

export function ChatCodingPlanUsageRemainingPanel({
  config,
  intl,
  locale,
  quotaResetDialogOpen,
  separated = false,
  autoCelebrateArm,
  onAutoCelebrated,
  onQuotaResetDialogOpenChange,
}: {
  config: ChatCodingPlanUsageRemainingConfig;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  quotaResetDialogOpen?: boolean;
  separated?: boolean;
  /** 自动/运营完成后,由 Composer 触发器在 hover 展开面板时要求补播撒花的自动完成 used_at(按类型)。 */
  autoCelebrateArm?: CodingPlanQuotaResetAutoConfettiArms | null;
  onAutoCelebrated?: (completedAt: number) => void;
  onQuotaResetDialogOpenChange?: (open: boolean) => void;
}) {
  const state = useMemo(() => resolveCodingPlanUsageRemainingState(config), [config]);
  const actionRefreshing = state?.loading || config.refreshing === true;
  const cachedUpdateError =
    Boolean(state?.visibleSnapshot) && Boolean(state?.displayedEntitlement?.error);
  const [uncontrolledQuotaResetDialogOpen, setUncontrolledQuotaResetDialogOpen] = useState(false);
  const resolvedQuotaResetDialogOpen = quotaResetDialogOpen ?? uncontrolledQuotaResetDialogOpen;
  const setQuotaResetDialogOpen =
    onQuotaResetDialogOpenChange ?? setUncontrolledQuotaResetDialogOpen;
  const resetUi = useCodingPlanQuotaResetUi({
    sourceKey: state?.displayedProviderId,
    preferredProviderId: state?.displayedEntitlement?.providerId,
    accountAccess: state?.displayedEntitlement?.accountAccess,
    onEntitlementRefresh: config.onEntitlementRefresh,
  });
  if (!state) {
    return null;
  }

  const planLevel = state.visibleSnapshot?.quota?.level ?? null;
  const remaining = state.visibleSnapshot?.remaining;
  const unavailableReason = state.visibleSnapshot?.unavailableReason;
  const limits = state.visibleSnapshot?.quota?.limits ?? [];
  const fiveHourTokenLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 3, 5),
    resetUi.entry,
  );
  const weeklyTokenLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 6),
    resetUi.week.entry,
  );
  const monthlyToolLimit = findCodingPlanQuotaLimit(limits, "TIME_LIMIT", 5, 1);
  const mcpQuotaLimit = resolveMcpQuotaLimit(state.visibleSnapshot);
  // 五小时与周机会合并为一个徽标,次数累加,倒计时取最早到期的一档。
  const opportunityBadge = resolveChatCodingPlanResetOpportunityBadge(state, resetUi);
  const fiveHourResetTime = fiveHourTokenLimit?.nextResetTime
    ? formatContextFiveHourResetTime({
        locale,
        value: fiveHourTokenLimit.nextResetTime,
      })
    : undefined;
  const weeklyResetTime = weeklyTokenLimit?.nextResetTime
    ? formatQuotaResetTime({
        locale,
        value: weeklyTokenLimit.nextResetTime,
        format: "date",
      })
    : undefined;
  const monthlyToolResetTime = monthlyToolLimit?.nextResetTime
    ? formatQuotaResetTime({
        locale,
        value: monthlyToolLimit.nextResetTime,
        format: "date",
      })
    : undefined;
  // MCP 额度按自然日重置，重置时刻恒为 00:00，展示时分没有信息量；
  // 与 Weekly / Tool calls 统一用日期口径。
  const mcpResetTime = mcpQuotaLimit?.nextResetTime
    ? formatQuotaResetTime({ locale, value: mcpQuotaLimit.nextResetTime, format: "date" })
    : undefined;
  const unavailableMessage =
    unavailableReason === "not_configured"
      ? intl.formatMessage({ id: "sidebar.usage.plan.notConfigured" })
      : unavailableReason === "not_authenticated"
        ? intl.formatMessage({ id: "sidebar.usage.plan.loginRequired" })
        : unavailableReason === "no_plan"
          ? intl.formatMessage({ id: "sidebar.usage.plan.noPlan" })
          : intl.formatMessage({ id: "sidebar.usage.plan.unavailable" });
  const unavailable = !state.loading && !remaining && limits.length === 0 && !planLevel;
  const quotaMeters = [
    fiveHourTokenLimit
      ? {
          color: "var(--color-usage-chart-1)",
          key: "fiveHour",
          label: intl.formatMessage({
            id: "sidebar.usage.plan.fiveHour",
          }),
          limit: fiveHourTokenLimit,
          resetTime: fiveHourResetTime,
        }
      : null,
    weeklyTokenLimit
      ? {
          color: "var(--color-usage-chart-2)",
          key: "weekly",
          label: intl.formatMessage({ id: "sidebar.usage.plan.weekly" }),
          limit: weeklyTokenLimit,
          resetTime: weeklyResetTime,
        }
      : null,
    monthlyToolLimit
      ? {
          color: "var(--color-usage-chart-3)",
          key: "monthlyTool",
          label: intl.formatMessage({
            id: "sidebar.usage.plan.toolCalls",
          }),
          limit: monthlyToolLimit,
          resetTime: monthlyToolResetTime,
        }
      : null,
    mcpQuotaLimit
      ? {
          color: "var(--color-usage-chart-5)",
          key: "mcp",
          label: intl.formatMessage({ id: "sidebar.usage.plan.mcp" }),
          limit: mcpQuotaLimit,
          resetTime: mcpResetTime,
        }
      : null,
  ].filter((meter): meter is NonNullable<typeof meter> => meter !== null);
  const primaryQuotaMeters = quotaMeters.filter((meter) => meter.key !== "mcp");
  const mcpQuotaMeter = quotaMeters.find((meter) => meter.key === "mcp");
  const quotaGridCount = Math.min(primaryQuotaMeters.length + (mcpQuotaMeter ? 1 : 0), 3);
  const quotaResetDialog = buildCodingPlanQuotaResetDialogConfig({
    fiveHourEnabled: Boolean(fiveHourTokenLimit),
    resetUi,
    usageItems: quotaMeters.map((meter) => ({
      color: meter.color,
      id: meter.key,
      label: meter.label,
      percentage: getQuotaRemainingPercentage(meter.limit),
      resetTime: meter.resetTime,
      value: formatQuotaRemainingPercentage(locale, meter.limit),
    })),
    weekEnabled: Boolean(weeklyTokenLimit),
  });

  return (
    <div className={separated ? "border-t border-border pt-2" : undefined}>
      <div className="flex min-w-0 items-center mb-2 gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "sidebar.usage.plan.title" })}
          </span>
          {(fiveHourTokenLimit && resetUi.entry) || (weeklyTokenLimit && resetUi.week.entry) ? (
            <CodingPlanQuotaResetOpportunity
              count={opportunityBadge.count}
              dialog={quotaResetDialog}
              dialogOpen={resolvedQuotaResetDialogOpen}
              expiresAt={opportunityBadge.expiresAt}
              placement="tooltip"
              visible={opportunityBadge.visible}
              onDialogOpenChange={setQuotaResetDialogOpen}
            />
          ) : null}
        </div>
        <CodingPlanUsageHeaderAction
          error={state.displayedEntitlement?.error}
          loading={actionRefreshing}
          openLabel={intl.formatMessage({ id: "sidebar.usage.plan.open" })}
          refreshingLabel={intl.formatMessage({
            id: "sidebar.usage.plan.refreshing",
          })}
          updatedLabel={intl.formatMessage({
            id: "sidebar.usage.plan.updated",
          })}
          warningLabel={
            cachedUpdateError
              ? intl.formatMessage({ id: "sidebar.usage.plan.updateFailed" })
              : undefined
          }
          onUsageClick={config.onUsageClick}
        />
      </div>
      <div className={cn("grid gap-2", getContextQuotaMeterGridClass(quotaGridCount))}>
        {state.loading && !state.visibleSnapshot ? (
          <div className="flex items-center gap-2 p-2 text-ui-base text-foreground-subtle">
            <LoaderCircle className="size-3.5 animate-spin" />
            {intl.formatMessage({ id: "sidebar.usage.plan.loading" })}
          </div>
        ) : state.displayedEntitlement?.error && !state.visibleSnapshot ? (
          <CodingPlanUsageNotice
            message={intl.formatMessage({
              id: "sidebar.usage.plan.updateFailed",
            })}
            refreshLabel={intl.formatMessage({
              id: "sidebar.usage.plan.refresh",
            })}
            onRefresh={config.onEntitlementRefresh}
          />
        ) : unavailable ? (
          <CodingPlanUsageNotice
            message={unavailableMessage}
            refreshLabel={intl.formatMessage({
              id: "sidebar.usage.plan.refresh",
            })}
            onRefresh={config.onEntitlementRefresh}
          />
        ) : (
          primaryQuotaMeters.map((meter) => (
            <ChatCodingPlanUsageMeter
              key={meter.key}
              color={meter.color}
              label={meter.label}
              action={
                // 额度标题旁入口只打开统一弹窗；真正核销由弹窗内对应类型按钮触发。
                meter.key === "fiveHour" &&
                resetUi.entry &&
                (resetUi.opportunityVisible ||
                  resetUi.processing ||
                  resetUi.entry.status === "completed") ? (
                  <LocalizedCodingPlanQuotaResetAction
                    autoCelebrateCompletedAt={autoCelebrateArm?.FIVE_HOUR ?? null}
                    completedAt={resolveCodingPlanQuotaResetActionCompletedAt(resetUi)}
                    processing={resetUi.processing}
                    onAutoCelebrated={onAutoCelebrated}
                    onOpenDialog={() => setQuotaResetDialogOpen(true)}
                  />
                ) : meter.key === "weekly" &&
                  resetUi.week.entry &&
                  (resetUi.week.opportunityVisible ||
                    resetUi.week.processing ||
                    resetUi.week.entry.status === "completed") ? (
                  <LocalizedCodingPlanQuotaResetAction
                    autoCelebrateCompletedAt={autoCelebrateArm?.WEEK ?? null}
                    completedAt={resolveCodingPlanQuotaResetActionCompletedAt(resetUi.week)}
                    processing={resetUi.week.processing}
                    resetType="WEEK"
                    onAutoCelebrated={onAutoCelebrated}
                    onOpenDialog={() => setQuotaResetDialogOpen(true)}
                  />
                ) : undefined
              }
              percentage={getQuotaRemainingPercentage(meter.limit)}
              resetTime={meter.resetTime}
              value={formatQuotaRemainingPercentage(locale, meter.limit)}
            />
          ))
        )}
        {mcpQuotaMeter ? (
          <ChatCodingPlanMcpUsageMeter
            color={mcpQuotaMeter.color}
            description={intl.formatMessage({
              id: "sidebar.usage.plan.zcodeMcpDescription",
            })}
            label={intl.formatMessage({ id: "sidebar.usage.plan.zcodeMcp" })}
            percentage={getQuotaRemainingPercentage(mcpQuotaMeter.limit)}
            primaryQuotaCount={primaryQuotaMeters.length}
            resetTime={mcpQuotaMeter.resetTime}
            value={formatQuotaRemainingPercentage(locale, mcpQuotaMeter.limit)}
          />
        ) : null}
      </div>
    </div>
  );
}
