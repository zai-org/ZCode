import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
import { LoaderCircle, RocketIcon } from "lucide-react";
import type { UsageEntitlementSnapshot, UsageQuotaLimit } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import {
  CodingPlanBillingDiscountBadgePill,
  CodingPlanBillingDiscountInfoDialog,
  useCodingPlanBillingDiscount,
} from "@/CodingPlanBillingDiscount.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import { formatStartPlanBucketResetTime } from "@/lib/codingPlanQuotaPresentation.js";
import { formatQuotaModelDisplayName } from "@/settings/model-provider-section/quotaModelDisplayName.js";

export interface ChatStartPlanBalanceConfig {
  loading: boolean;
  /** hover 打开 context 面板时发起的静默 access 刷新（与 Coding Plan 段 onAccess 语义一致）。 */
  onAccess?: () => Promise<void> | void;
  onUpgradeClick?: () => void;
  /** hover 触发的本次刷新 promise 进行中；静默刷新不置 entitlement.loading，spinner 需要跟随它。 */
  refreshing?: boolean;
  snapshot: UsageEntitlementSnapshot | null;
}

function resolveLimitTotal(limit: UsageQuotaLimit): number {
  return limit.number ?? limit.unit ?? 0;
}

function resolveLimitRemaining(limit: UsageQuotaLimit): number {
  return limit.remaining ?? 0;
}

function formatStartPlanRemainingPercentage(ratio: number, locale: string): string {
  const boundedRatio = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  return new Intl.NumberFormat(locale || undefined, {
    maximumFractionDigits: 0,
    style: "percent",
  }).format(boundedRatio);
}

function formatModelCode(modelCode: string): string {
  const normalized = modelCode.replace(/^model:/i, "");
  if (normalized.toLowerCase() === "glm-5-turbo") {
    return "GLM-5Turbo";
  }
  return normalized.toUpperCase();
}

function formatLimitModels(limit: UsageQuotaLimit): string {
  const modelNames = limit.usageDetails
    .map((detail) => {
      const displayName = detail.displayName?.trim();
      return formatQuotaModelDisplayName(displayName || formatModelCode(detail.modelCode.trim()));
    })
    .filter((modelName) => modelName.length > 0);
  if (modelNames.length === 0) {
    return limit.type;
  }

  return modelNames.join(" / ");
}

function getVisibleStartPlanLimits(snapshot: UsageEntitlementSnapshot | null): UsageQuotaLimit[] {
  return (snapshot?.quota?.limits ?? []).filter((limit) => {
    const total = resolveLimitTotal(limit);
    const remaining = resolveLimitRemaining(limit);
    return total > 0 || remaining > 0;
  });
}

export function hasChatStartPlanBalance(config: ChatStartPlanBalanceConfig | undefined): boolean {
  if (!config) {
    return false;
  }
  return (
    config.loading ||
    getVisibleStartPlanLimits(config.snapshot).length > 0 ||
    // Start Plan 与 Coding Plan 连接方式互斥，hover 刷新入口不能只挂在 Coding Plan
    // 配置上；首次无缓存快照时本段（含触发器）不渲染，用户没有 hover 入口发起第一次余额请求。
    // onAccess 存在即视为可按需刷新，保留触发器（对齐 hasChatCodingPlanUsageRemaining 的兜底）。
    Boolean(config.onAccess)
  );
}

function ChatStartPlanBalanceMeter({ limit, locale }: { limit: UsageQuotaLimit; locale: string }) {
  const total = resolveLimitTotal(limit);
  const remaining = resolveLimitRemaining(limit);
  const remainingRatio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  // 桶刷新时间只来自本桶 expires_at（nextResetTime）；不再用套餐级 renewTime
  // 或全局聚合时间兜底，否则多套餐下会把同一时间复制进每个桶。
  const renewTime = formatStartPlanBucketResetTime(locale, limit.nextResetTime);

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="min-w-0 space-y-0.5 text-ui-sm">
        <div className="min-w-0 truncate text-foreground-subtle">{formatLimitModels(limit)}</div>
        <div className="min-w-0 text-ui-sm tabular-nums">
          <span className="font-mono text-foreground">
            {formatStartPlanRemainingPercentage(remainingRatio, locale)}
          </span>
          {renewTime ? <span className="text-foreground-subtle"> · {renewTime}</span> : null}
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
        {/* 修复原因：与 Coding Plan 额度条对齐，hover 静默刷新返回后宽度平滑过渡到新值，
            原先瞬间跳变导致"已刷新"完全无感；同时保留 motion-reduce 无障碍降级。 */}
        <div
          className="h-full rounded-full bg-success transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${remainingRatio * 100}%` }}
        />
      </div>
    </div>
  );
}

export function ChatStartPlanBalancePanel({
  config,
  intl,
  locale,
  separated = false,
}: {
  config: ChatStartPlanBalanceConfig;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  separated?: boolean;
}) {
  const billingDiscount = useCodingPlanBillingDiscount();
  const upgradeButtonHighlighted = billingDiscount.active === true;
  const limits = getVisibleStartPlanLimits(config.snapshot);

  if (!config.loading && limits.length === 0) {
    return null;
  }

  return (
    <div className={separated ? "border-t border-border pt-2" : undefined}>
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.modelProvider.startPlan.balance.title" })}
          </span>
          {config.loading || config.refreshing === true ? (
            // 静默 access 刷新有缓存快照时不会把 entitlement.loading 置 true，
            // spinner 还要跟随 hover 触发的本次 promise（refreshing），与 Coding Plan 段语义一致。
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
          ) : null}
        </div>
        {config.onUpgradeClick ? (
          <div className="inline-flex shrink-0 items-center gap-1">
            <CodingPlanEntryButton
              type="button"
              size="xs"
              className={cn(
                "h-6 shrink-0 gap-1 px-2 text-ui-sm",
                upgradeButtonHighlighted &&
                  "button-gradient rounded-full pr-[5px] text-white hover:bg-transparent hover:opacity-90 dark:bg-[#484A58] dark:hover:bg-[#484A58]",
              )}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                config.onUpgradeClick?.();
              }}
            >
              <RocketIcon className="size-3" />
              {intl.formatMessage({ id: "chat.quota.action.upgrade" })}
              {upgradeButtonHighlighted ? (
                <CodingPlanBillingDiscountBadgePill
                  config={billingDiscount.config}
                  iconVisible={false}
                  size="compact"
                  variant="surface"
                />
              ) : null}
            </CodingPlanEntryButton>
            {upgradeButtonHighlighted ? (
              <CodingPlanBillingDiscountInfoDialog config={billingDiscount.config} />
            ) : null}
          </div>
        ) : null}
      </div>
      <div className={cn("grid gap-2", getContextQuotaMeterGridClass(limits.length))}>
        {limits.map((limit) => (
          <ChatStartPlanBalanceMeter
            key={`${limit.type}:${formatLimitModels(limit)}`}
            limit={limit}
            locale={locale}
          />
        ))}
      </div>
    </div>
  );
}
