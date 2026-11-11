/* eslint-disable max-lines -- Coding Plan usage 面板集中处理数据来源、额度卡片和用量图表，拆分会让账号级来源绑定状态更分散。 */
import { Fragment, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { resolveHourDigits } from "@/v4/messageTimeLabel.js";
import { Check, InfoIcon, RefreshCw } from "lucide-react";
import type {
  CodingPlanModelData,
  CodingPlanToolData,
  CodingPlanUsageDetailMetric,
  CodingPlanUsageDetailSubject,
  CodingPlanUsageRange,
  CodingPlanUsageSnapshot,
  UsageQuotaLimit,
  UsageQuotaSnapshot,
} from "@zcode/shared";
import { LocalizedCodingPlanQuotaResetAction } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetAction.js";
import { CodingPlanQuotaResetOpportunity } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.js";
import { buildCodingPlanQuotaResetDialogConfig } from "@/components/coding-plan-quota-reset/buildCodingPlanQuotaResetDialogConfig.js";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import { useCodingPlanUsageStats } from "@/hooks/useUsageStats.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";
import {
  findCodingPlanQuotaLimit,
  formatQuotaRemainingPercentage,
  formatQuotaResetTime,
  getQuotaRemainingPercentage,
  resolveMcpQuotaLimit,
} from "@/lib/codingPlanQuotaPresentation.js";
import {
  mergeCodingPlanQuotaResetOpportunityBadges,
  resolveCodingPlanQuotaResetActionCompletedAt,
  resolveCodingPlanQuotaResetLimit,
} from "@/lib/codingPlanQuotaResetUi.js";
import { UsageChartLoadBoundary } from "@/settings/usage-stats/UsageChartLoadBoundary.js";
import {
  buildCodingPlanModelLineChartSeries,
  buildCodingPlanToolLineChartSeries,
  buildCodingPlanUsageDetailLineChartSeries,
} from "@/settings/usage-stats/codingPlanUsageChartSeries.js";
import { UsageStatsErrorNotice } from "@/settings/usage-stats/UsageStatsErrorNotice.js";
import { UsageHeatmap } from "@/settings/usage-stats/UsageHeatmap.js";
import {
  USAGE_STATS_TABS_LIST_CLASS,
  USAGE_STATS_TABS_TRIGGER_CLASS,
  UsageEmptyState,
  formatCompactNumber,
  formatCompactTokenUsage,
  formatFullDay,
  formatSummaryCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import { formatAppUsageDuration } from "@/settings/usage-stats/AppUsagePanel.js";
import {
  buildCodingPlanUsageSources,
  type CodingPlanUsageSource,
} from "@/lib/codingPlanUsageSources.js";

export { buildCodingPlanUsageSources, type CodingPlanUsageSource };

/** Usage stats 独有的完整重置时刻格式；其它紧凑入口继续按各自规则展示。 */
export function formatUsageStatsQuotaResetTime(
  locale: string,
  value: number | null | undefined,
): string | undefined {
  return formatQuotaResetTime({ locale, value, format: "dateTime" });
}

// Recharts 会在模块初始化阶段触发 decimal.js-light 的 LN10 校验，
// 在 Electron Linux 容器里会阻断整个 renderer 启动。图表按需加载后，
// 普通启动和 e2e 首页不会被 Usage 页图表依赖影响，打开 Usage 时也由局部边界隔离。
const CodingPlanUsageLineChart = lazy(() =>
  import("@/settings/usage-stats/CodingPlanUsageLineChart.js").then((module) => ({
    default: module.CodingPlanUsageLineChart,
  })),
);
const CodingPlanUsageBarChart = lazy(() =>
  import("@/settings/usage-stats/CodingPlanUsageBarChart.js").then((module) => ({
    default: module.CodingPlanUsageBarChart,
  })),
);
const CODING_PLAN_DETAIL_SERIES_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-usage-chart-4)",
  "var(--color-usage-chart-5)",
  "var(--color-usage-chart-6)",
] as const;
const MAX_SELECTED_CODING_PLAN_DETAIL_SERIES = 3;
const CODING_PLAN_USAGE_TRENDS_SECTION_ID = "coding-plan-usage-trends";
const HIDDEN_CODING_PLAN_PROVIDER_NAMES = new Set(["BigModel - Coding Plan"]);
type CodingPlanUsageTrendRange = Extract<CodingPlanUsageRange, "7d" | "30d">;

export function CodingPlanUsagePanel({
  loadingSources,
  selectedSource,
  workspaceIdentity,
  workspacePath,
}: {
  loadingSources: boolean;
  selectedSource?: CodingPlanUsageSource | null;
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  const { intl } = useZCodeIntl();
  const [range, setRange] = useState<CodingPlanUsageTrendRange>("7d");
  void workspaceIdentity;
  void workspacePath;
  const effectiveSource = selectedSource ?? null;
  const effectiveProviderId = effectiveSource?.providerId;
  const effectiveSourceIsTeamPlan = Boolean(
    effectiveSource &&
    "planKind" in effectiveSource.accountAccess &&
    effectiveSource.accountAccess.planKind === "team-coding-plan",
  );
  const individualProviderFingerprint = effectiveSourceIsTeamPlan
    ? ""
    : effectiveSource?.accountAccess
      ? JSON.stringify([effectiveSource.providerId, effectiveSource.accountAccess])
      : "";
  const zaiEntitlement = useUsageEntitlement({
    // 原只按 zai providerId 启用，没区分个人/团队，team source 会被
    // 当成个人 zaiEntitlement 查询（缺 org/project）。加上 !effectiveSourceIsTeamPlan
    // 后，zai team source 改走 teamEntitlement 分支。
    enabled:
      !loadingSources &&
      effectiveProviderId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan &&
      Boolean(individualProviderFingerprint) &&
      !effectiveSourceIsTeamPlan,
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    accountAccess: effectiveSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      providerFingerprint: individualProviderFingerprint,
    }),
    refreshOnMount: false,
  });
  const bigmodelEntitlement = useUsageEntitlement({
    enabled:
      !loadingSources &&
      effectiveProviderId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan &&
      Boolean(individualProviderFingerprint) &&
      !effectiveSourceIsTeamPlan,
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: effectiveSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      providerFingerprint: individualProviderFingerprint,
    }),
    refreshOnMount: false,
  });
  const teamEntitlement = useUsageEntitlement({
    // 原硬绑 bigmodelCodingPlan providerId，zai team source 永远进不来。
    // 改为按 effectiveSourceIsTeamPlan 路由，providerId 按 effectiveSource 动态取，
    // zai team → zaiCodingPlan，bigmodel team → bigmodelCodingPlan。
    enabled: !loadingSources && effectiveSourceIsTeamPlan,
    includeSubscription: true,
    preferredProviderId:
      effectiveProviderId ?? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: effectiveSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: effectiveSource?.id,
    refreshOnMount: false,
  });
  // 原 zai providerId 一律走 zaiEntitlement（个人），把 team plan 漏掉。
  // 改为先判 team plan，命中走 teamEntitlement；否则按 providerId 走个人分支。
  const effectiveEntitlement = effectiveSourceIsTeamPlan
    ? teamEntitlement
    : effectiveProviderId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
      ? zaiEntitlement
      : bigmodelEntitlement;
  const effectiveEntitlementSnapshot = effectiveEntitlement.snapshot;
  const effectiveEntitlementRefresh = effectiveEntitlement.refresh;
  const handleResetEntitlementRefresh = useCallback(async () => {
    await effectiveEntitlementRefresh?.({ force: true, silent: true });
  }, [effectiveEntitlementRefresh]);
  const {
    snapshot,
    loading,
    error,
    refresh: refreshCodingPlanUsage,
  } = useCodingPlanUsageStats(range, {
    enabled: !loadingSources && Boolean(effectiveProviderId),
    preferredProviderId: effectiveProviderId,
    accountAccess: effectiveSource?.accountAccess,
    customStartDate: null,
    customEndDate: null,
  });
  const handleUsageStatsRefresh = useCallback(async () => {
    await Promise.all([
      refreshCodingPlanUsage({ force: true }),
      effectiveEntitlementRefresh?.({ force: true, silent: true }),
    ]);
  }, [effectiveEntitlementRefresh, refreshCodingPlanUsage]);
  useEffect(() => {
    if (!effectiveProviderId || !effectiveEntitlementRefresh) {
      return;
    }

    // Usage 页的 Quota Remaining 优先展示 entitlement quota。
    // 打开 Coding Plan Usage 页面时，如果只依赖共享 TTL，可能继续显示 sidebar/input 留下的旧快照。
    void effectiveEntitlementRefresh({ silent: true, reason: "access" });
  }, [effectiveEntitlementRefresh, effectiveProviderId]);

  if (loadingSources && !effectiveSource) {
    return (
      <UsageEmptyState
        title={intl.formatMessage({ id: "settings.usage.loadingTitle" })}
        description={intl.formatMessage({
          id: "settings.usage.codingPlanLoadingDescription",
        })}
      />
    );
  }

  if (!loadingSources && !effectiveSource) {
    return (
      <UsageEmptyState
        title={intl.formatMessage({
          id: "settings.usage.codingPlanCurrentConnectionTitle",
        })}
        description={intl.formatMessage({
          id: "settings.usage.codingPlanCurrentConnectionDescription",
        })}
      />
    );
  }

  return (
    <div className="space-y-5">
      {error ? <UsageStatsErrorNotice error={error} /> : null}

      {loading && !snapshot ? (
        // Coding Plan 来自供应商 monitor API，加载说明要和 App Usage 的本地统计区分。
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.loadingTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.codingPlanLoadingDescription",
          })}
        />
      ) : snapshot ? (
        <>
          <CodingPlanQuotaCards
            quota={effectiveEntitlementSnapshot?.quota ?? snapshot.quota}
            mcpQuotaLimit={resolveMcpQuotaLimit(effectiveEntitlementSnapshot)}
            generatedAt={snapshot.generatedAt}
            sourceKey={effectiveSource?.id}
            preferredProviderId={effectiveProviderId}
            accountAccess={effectiveSource?.accountAccess}
            onEntitlementRefresh={handleResetEntitlementRefresh}
            onUsageStatsRefresh={handleUsageStatsRefresh}
          />
          <CodingPlanActivitySection snapshot={snapshot} />
          <CodingPlanUsageTrendsSection
            range={range}
            snapshot={snapshot}
            onRangeChange={setRange}
          />
        </>
      ) : null}
    </div>
  );
}

export function resolveCodingPlanUsageProviderName({
  fallbackProviderName,
  snapshot,
  source,
}: {
  fallbackProviderName?: string;
  snapshot: CodingPlanUsageSnapshot | null;
  source: CodingPlanUsageSource | null;
}): string | undefined {
  // 修复原因：Team Plan 复用 BigModel Coding Plan provider，monitor 接口只知道通用 provider 名。
  // 使用统计必须按当前 Team 连接的展示 key 取团队项目名，不能继续识别已删除的 team-plan key。
  if (source?.id.startsWith("team:")) {
    return source.label || snapshot?.sourceProvider.name || fallbackProviderName;
  }
  const providerName = snapshot?.sourceProvider.name ?? source?.label ?? fallbackProviderName;
  return providerName && !HIDDEN_CODING_PLAN_PROVIDER_NAMES.has(providerName)
    ? providerName
    : undefined;
}

function CodingPlanRangeSelector({
  range,
  onRangeChange,
}: {
  range: CodingPlanUsageTrendRange;
  onRangeChange: (range: CodingPlanUsageTrendRange) => void;
}) {
  const options: CodingPlanUsageTrendRange[] = ["7d", "30d"];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedTabs
        value={range}
        options={options}
        labelIdPrefix="settings.usage.codingPlanRange"
        onChange={(value) => onRangeChange(value as CodingPlanUsageTrendRange)}
      />
    </div>
  );
}

function CodingPlanQuotaCards({
  quota,
  mcpQuotaLimit,
  generatedAt,
  sourceKey,
  preferredProviderId,
  accountAccess,
  onEntitlementRefresh,
  onUsageStatsRefresh,
}: {
  quota: UsageQuotaSnapshot | null;
  /** 官方 Server MCP 额度不在 quota.limits[] 里，由 entitlement 快照的独立字段传入。 */
  mcpQuotaLimit: UsageQuotaLimit | null;
  generatedAt: number;
  sourceKey: string | undefined;
  preferredProviderId: string | undefined;
  accountAccess:
    | import("@zcode/shared").ZCodeProviderAccountAccess
    | import("@zcode/shared").ZCodeAccountAccess
    | undefined;
  onEntitlementRefresh: () => void | Promise<void>;
  onUsageStatsRefresh: () => void | Promise<void>;
}) {
  const { intl, locale } = useZCodeIntl();
  const [quotaResetDialogOpen, setQuotaResetDialogOpen] = useState(false);
  const resetUi = useCodingPlanQuotaResetUi({
    sourceKey,
    preferredProviderId,
    accountAccess,
    onEntitlementRefresh,
  });
  const limits = quota?.limits ?? [];
  const fiveHourLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 3, 5),
    resetUi.entry,
  );
  const weeklyLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 6),
    resetUi.week.entry,
  );
  // 五小时与周机会合并为一个徽标,次数累加,倒计时取最早到期的一档。
  // Bugfix：曾用「剩余 100% 则重置无收益」隐藏徽标与按钮。核销会把剩余改写成 100%，
  // 同类型余下的机会随即被藏掉，用户以为卡丢了。只要额度存在且有可用机会就展示。
  const opportunityBadge = mergeCodingPlanQuotaResetOpportunityBadges([
    {
      count: resetUi.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.entry?.opportunityExpiresAt ?? null,
      visible: Boolean(fiveHourLimit) && resetUi.opportunityVisible,
    },
    {
      count: resetUi.week.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.week.entry?.opportunityExpiresAt ?? null,
      visible: Boolean(weeklyLimit) && resetUi.week.opportunityVisible,
    },
  ]);
  const cards = [
    {
      key: "fiveHour",
      label: intl.formatMessage({
        id: "settings.usage.entitlementFiveHourUsage",
      }),
      limit: fiveHourLimit,
      progressColor: "var(--color-usage-chart-1)",
    },
    {
      key: "weekly",
      label: intl.formatMessage({
        id: "settings.usage.entitlementWeeklyUsage",
      }),
      limit: weeklyLimit,
      progressColor: "var(--color-usage-chart-2)",
    },
    {
      key: "monthlyTool",
      label: intl.formatMessage({
        id: "settings.usage.entitlementMonthlyMcpUsage",
      }),
      limit: findCodingPlanQuotaLimit(limits, "TIME_LIMIT", 5, 1),
      progressColor: "var(--color-usage-chart-3)",
    },
    {
      key: "serverMcp",
      label: intl.formatMessage({
        id: "settings.usage.entitlementServerMcpUsage",
      }),
      limit: mcpQuotaLimit,
      progressColor: "var(--color-usage-chart-5)",
    },
  ].filter(
    (
      card,
    ): card is {
      key: string;
      label: string;
      limit: UsageQuotaLimit;
      progressColor: string;
    } => Boolean(card.limit),
  );

  if (cards.length === 0) {
    return null;
  }

  const fiveHourCardVisible = cards.some((card) => card.key === "fiveHour");
  const weeklyCardVisible = cards.some((card) => card.key === "weekly");
  const quotaResetDialog = buildCodingPlanQuotaResetDialogConfig({
    fiveHourEnabled: Boolean(fiveHourLimit),
    resetUi,
    usageItems: cards.map((card) => ({
      color: card.progressColor,
      id: card.key,
      label: card.label,
      percentage: getQuotaRemainingPercentage(card.limit),
      resetTime: formatUsageStatsQuotaResetTime(locale, card.limit.nextResetTime),
      value: formatQuotaRemainingPercentage(locale, card.limit),
    })),
    weekEnabled: Boolean(weeklyLimit),
  });

  // Quota remaining 的响应式只允许整组纵向或整组横向。
  // 额度项（最多 4 个：5 小时 / 每周 / MCP / Server MCP）不能在中间断点排成 n+1，
  // 否则信息组会被视觉拆散。
  const quotaCardsLayoutClass = "flex flex-col gap-3 lg:flex-row";

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="text-ui-lg font-medium text-foreground">
            {intl.formatMessage({ id: "settings.usage.quotaTitle" })}
          </h3>
          {(fiveHourCardVisible && resetUi.entry) || (weeklyCardVisible && resetUi.week.entry) ? (
            <CodingPlanQuotaResetOpportunity
              count={opportunityBadge.count}
              dialog={quotaResetDialog}
              dialogOpen={quotaResetDialogOpen}
              expiresAt={opportunityBadge.expiresAt}
              placement="inline"
              visible={opportunityBadge.visible}
              onDialogOpenChange={setQuotaResetDialogOpen}
            />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-ui-base text-foreground-subtle">
          <span>{formatCodingPlanRefreshTime(locale, intl, generatedAt)}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "settings.usage.refresh" })}
            onClick={() => {
              void onUsageStatsRefresh();
            }}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            <span className="sr-only">{intl.formatMessage({ id: "settings.usage.refresh" })}</span>
          </Button>
        </div>
      </div>
      <div className={quotaCardsLayoutClass}>
        {cards.map((card) => {
          const percentage = getQuotaRemainingPercentage(card.limit) ?? 0;
          const resetTime = formatUsageStatsQuotaResetTime(locale, card.limit.nextResetTime);
          return (
            <div key={card.key} className="min-w-0 flex-1 rounded-xl bg-surface/70 p-4">
              {/* min-h 与重置动作(h-5)对齐:没有动作的额度卡也保持同高,避免同排数值/进度条错位。 */}
              <div className="flex min-h-5 min-w-0 items-center gap-1">
                <span className="min-w-0 truncate text-ui-base text-foreground">{card.label}</span>
                {card.key === "serverMcp" ? (
                  <ControlHintTooltip
                    title={intl.formatMessage({
                      id: "sidebar.usage.plan.zcodeMcpDescription",
                    })}
                    standalone
                  >
                    <button
                      type="button"
                      aria-label={intl.formatMessage({
                        id: "sidebar.usage.plan.zcodeMcpDescription",
                      })}
                      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-foreground-subtle transition-colors hover:text-foreground"
                      data-zcode-mcp-info="usage-stats"
                    >
                      <InfoIcon className="size-3.5" aria-hidden="true" />
                    </button>
                  </ControlHintTooltip>
                ) : null}
                {/* 额度标题旁入口只打开统一弹窗；真正核销由弹窗内对应类型按钮触发。 */}
                {card.key === "fiveHour" &&
                resetUi.entry &&
                (resetUi.opportunityVisible ||
                  resetUi.processing ||
                  resetUi.entry.status === "completed") ? (
                  <LocalizedCodingPlanQuotaResetAction
                    completedAt={resolveCodingPlanQuotaResetActionCompletedAt(resetUi)}
                    processing={resetUi.processing}
                    onOpenDialog={() => setQuotaResetDialogOpen(true)}
                  />
                ) : card.key === "weekly" &&
                  resetUi.week.entry &&
                  (resetUi.week.opportunityVisible ||
                    resetUi.week.processing ||
                    resetUi.week.entry.status === "completed") ? (
                  <LocalizedCodingPlanQuotaResetAction
                    completedAt={resolveCodingPlanQuotaResetActionCompletedAt(resetUi.week)}
                    processing={resetUi.week.processing}
                    resetType="WEEK"
                    onOpenDialog={() => setQuotaResetDialogOpen(true)}
                  />
                ) : null}
              </div>
              <div className="mt-1 flex min-w-0 items-baseline gap-1.5">
                <span className="text-ui-xl font-semibold text-foreground">
                  {formatQuotaRemainingPercentage(locale, card.limit)}
                </span>
                {resetTime ? (
                  <span className="min-w-0 truncate text-ui-base text-foreground-subtle">
                    {resetTime}
                  </span>
                ) : null}
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-background">
                <div
                  className="min-w-2 h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
                  style={{
                    width: `${percentage}%`,
                    backgroundColor: card.progressColor,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CodingPlanUsageTrendsSection({
  range,
  snapshot,
  onRangeChange,
}: {
  range: CodingPlanUsageTrendRange;
  snapshot: CodingPlanUsageSnapshot;
  onRangeChange: (range: CodingPlanUsageTrendRange) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <section id={CODING_PLAN_USAGE_TRENDS_SECTION_ID} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.trendsTitle" })}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <CodingPlanRangeSelector range={range} onRangeChange={onRangeChange} />
        </div>
      </div>
      <CodingPlanUsageDetailSection snapshot={snapshot} />
      <CodingPlanHealthSection snapshot={snapshot} />
    </section>
  );
}

function CodingPlanActivitySection({ snapshot }: { snapshot: CodingPlanUsageSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const summary = snapshot.activity.summary;
  const items = [
    {
      label: intl.formatMessage({ id: "settings.usage.lifetimeTotalTokens" }),
      value: formatSummaryCompactTokenUsage(locale, summary.totalTokens),
    },
    {
      // 日期直接拼进标签会在窄卡片中被截断；固定标题保持可读，日期改由信息图标按需展示。
      label: intl.formatMessage({ id: "settings.usage.lifetimePeakTokens" }),
      peakDailyTokensDate: summary.peakDailyTokensDate,
      value: formatSummaryCompactTokenUsage(locale, summary.peakDailyTokens),
    },
    {
      // 修复回归：CodingPlanActivitySummary 只有 totalUsageDurationMs（累计使用时长），
      // longestSessionMs 是 App Usage 侧的字段，不能使用“最长聊天时长”标签。
      label: intl.formatMessage({ id: "settings.usage.totalUsageDuration" }),
      value: formatAppUsageDuration(summary.totalUsageDurationMs, intl),
    },
    {
      label: intl.formatMessage({ id: "settings.usage.currentStreak" }),
      value: `${formatCompactNumber(locale, summary.currentStreakDays)} ${intl.formatMessage({
        id: "settings.usage.duration.day",
      })}`,
    },
    {
      label: intl.formatMessage({ id: "settings.usage.longestStreak" }),
      value: `${formatCompactNumber(locale, summary.longestStreakDays)} ${intl.formatMessage({
        id: "settings.usage.duration.day",
      })}`,
    },
  ];

  return (
    <section className="space-y-4">
      <h3 className="text-ui-lg font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.activityTitle" })}
      </h3>
      <div className="flex flex-col overflow-hidden rounded-xl bg-surface sm:flex-row sm:items-center">
        {items.map((item, index) => (
          <Fragment key={item.label}>
            {index > 0 ? (
              <div aria-hidden="true" className="hidden h-7 w-px bg-border sm:block" />
            ) : null}
            <div className="min-w-0 flex-1 px-4 py-3 text-center">
              <div className="truncate text-ui-lg font-medium text-foreground">{item.value}</div>
              <div className="mt-1 flex min-w-0 items-center justify-center gap-1 text-ui-base text-foreground-subtle">
                <span className="min-w-0 truncate">{item.label}</span>
                {item.peakDailyTokensDate ? (
                  <ControlHintTooltip title={formatFullDay(locale, item.peakDailyTokensDate)}>
                    <span
                      className="inline-flex size-4 items-center justify-center"
                      tabIndex={0}
                      aria-label={formatFullDay(locale, item.peakDailyTokensDate)}
                    >
                      <InfoIcon className="size-3.5" aria-hidden="true" />
                    </span>
                  </ControlHintTooltip>
                ) : null}
              </div>
            </div>
          </Fragment>
        ))}
      </div>
      {snapshot.activity.heatmap.weeks.length ? (
        <UsageHeatmap
          locale={locale}
          intl={intl}
          weeks={snapshot.activity.heatmap.weeks}
          countMetric="tools"
        />
      ) : null}
    </section>
  );
}

function CodingPlanUsageDetailSection({ snapshot }: { snapshot: CodingPlanUsageSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const [metric, setMetric] = useState<CodingPlanUsageDetailMetric>("credits");
  const [subject, setSubject] = useState<CodingPlanUsageDetailSubject>("model");
  const [selectedSeriesNames, setSelectedSeriesNames] = useState<string[]>([]);
  const activeSummary = subject === "model" ? snapshot.detail.model : snapshot.detail.tool;
  const hasCreditUsageData = hasCodingPlanCreditUsageData({
    summary: activeSummary,
    modelDataList: snapshot.modelUsage.modelDataList,
    toolDataList: snapshot.toolUsage.toolDataList,
  });
  const showDetailSummary = shouldShowCodingPlanUsageDetailSummary({
    summary: activeSummary,
    modelDataList: subject === "model" ? snapshot.modelUsage.modelDataList : [],
    toolDataList: subject === "tool" ? snapshot.toolUsage.toolDataList : [],
  });
  const activeChartMeta =
    subject === "model"
      ? {
          granularity: snapshot.modelUsage.granularity,
          xTime: snapshot.modelUsage.xTime,
        }
      : {
          granularity: snapshot.toolUsage.granularity,
          xTime: snapshot.toolUsage.xTime,
        };
  const allSeries = useMemo(() => {
    const series = hasCreditUsageData
      ? buildCodingPlanUsageDetailLineChartSeries({
          metric,
          subject,
          modelDataList: snapshot.modelUsage.modelDataList,
          toolDataList: snapshot.toolUsage.toolDataList,
        })
      : subject === "model"
        ? buildCodingPlanModelLineChartSeries(snapshot.modelUsage.modelDataList)
        : buildCodingPlanToolLineChartSeries(snapshot.toolUsage.toolDataList);
    return series.map((item, index) => ({
      ...item,
      color:
        CODING_PLAN_DETAIL_SERIES_COLORS[index % CODING_PLAN_DETAIL_SERIES_COLORS.length] ??
        CODING_PLAN_DETAIL_SERIES_COLORS[0],
    }));
  }, [
    hasCreditUsageData,
    metric,
    snapshot.modelUsage.modelDataList,
    snapshot.toolUsage.toolDataList,
    subject,
  ]);
  const selectedSeriesNameSet = useMemo(() => new Set(selectedSeriesNames), [selectedSeriesNames]);
  const visibleSeries = useMemo(
    () => allSeries.filter((item) => selectedSeriesNameSet.has(item.name)),
    [allSeries, selectedSeriesNameSet],
  );
  const totalValue = visibleSeries.reduce(
    (sum, item) => sum + item.values.reduce((itemSum, value) => itemSum + value, 0),
    0,
  );
  const valueKind = hasCreditUsageData
    ? metric === "credits"
      ? "credit"
      : subject === "model"
        ? "token"
        : "count"
    : subject === "model"
      ? "token"
      : "count";
  const valueMetric = hasCreditUsageData ? metric : "usage";
  const detailUnit =
    valueKind === "token"
      ? intl.formatMessage({ id: "settings.usage.tokenUnit" })
      : valueKind === "credit"
        ? intl.formatMessage({ id: "settings.usage.creditUnit" })
        : null;

  useEffect(() => {
    setSelectedSeriesNames(
      allSeries.slice(0, MAX_SELECTED_CODING_PLAN_DETAIL_SERIES).map((item) => item.name),
    );
  }, [allSeries, hasCreditUsageData, metric, subject, snapshot.generatedAt]);

  const toggleSeries = useCallback((name: string) => {
    setSelectedSeriesNames((current) => {
      if (current.includes(name)) {
        if (current.length <= 1) {
          return current;
        }
        return current.filter((item) => item !== name);
      }
      if (current.length >= MAX_SELECTED_CODING_PLAN_DETAIL_SERIES) {
        return [...current.slice(1), name];
      }
      return [...current, name];
    });
  }, []);

  return (
    <section className="space-y-4">
      {showDetailSummary ? <CodingPlanUsageDetailSummary summary={activeSummary} /> : null}
      <div className="rounded-xl bg-surface/70 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {hasCreditUsageData ? (
            <>
              <SegmentedTabs
                value={metric}
                options={["credits", "usage"]}
                labelIdPrefix="settings.usage.codingPlanMetric"
                onChange={(value) => setMetric(value as CodingPlanUsageDetailMetric)}
              />
              <div aria-hidden="true" className="h-4 w-px bg-border" />
            </>
          ) : null}
          <SegmentedTabs
            value={subject}
            options={["model", "tool"]}
            labelIdPrefix="settings.usage.codingPlanSubject"
            onChange={(value) => setSubject(value as CodingPlanUsageDetailSubject)}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-ui-sm">
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-ui-sm"
            onClick={() =>
              setSelectedSeriesNames(
                allSeries.slice(0, MAX_SELECTED_CODING_PLAN_DETAIL_SERIES).map((item) => item.name),
              )
            }
          >
            <span className="truncate text-foreground-subtle">
              {intl.formatMessage({
                id: "settings.usage.codingPlanLegendTotal",
              })}
              :
            </span>
            <span className="flex items-baseline gap-1 text-foreground">
              <span className="font-mono font-medium">
                {formatCodingPlanDetailValue(locale, totalValue, valueMetric, subject)}
              </span>
              {detailUnit ? <span className="text-foreground-subtle">{detailUnit}</span> : null}
            </span>
          </button>
          {allSeries.slice(0, 8).map((item) => {
            const hidden = !selectedSeriesNameSet.has(item.name);
            const itemTotal = item.values.reduce((sum, value) => sum + value, 0);
            const seriesColor = item.color;
            return (
              <button
                key={item.name}
                type="button"
                aria-pressed={!hidden}
                className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-ui-sm"
                onClick={() => toggleSeries(item.name)}
              >
                <span
                  className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                    hidden ? "bg-input border-border text-transparent" : "text-primary-foreground"
                  }`}
                  style={{
                    backgroundColor: hidden ? undefined : seriesColor,
                    borderColor: hidden ? undefined : seriesColor,
                  }}
                >
                  <Check className="size-3" aria-hidden="true" />
                </span>
                <span className="truncate text-foreground-subtle">{item.name}:</span>
                <span className="flex items-baseline gap-1 text-foreground">
                  <span className="font-mono font-medium">
                    {formatCodingPlanDetailValue(locale, itemTotal, valueMetric, subject)}
                  </span>
                  {detailUnit ? <span className="text-foreground-subtle">{detailUnit}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-3">
          <UsageChartLoadBoundary
            scope="settings.usage.coding-plan-detail-chart"
            resetKeys={[
              snapshot.sourceProvider.id,
              snapshot.range,
              snapshot.rangeStartDate,
              snapshot.rangeEndDate,
              snapshot.generatedAt,
              metric,
              subject,
            ]}
            loadingDescription={intl.formatMessage({
              id: "settings.usage.codingPlanLoadingDescription",
            })}
          >
            <CodingPlanUsageBarChart
              xTime={activeChartMeta.xTime}
              granularity={activeChartMeta.granularity}
              emptyDescription={intl.formatMessage({
                id: "settings.usage.emptyDescription",
              })}
              series={visibleSeries}
              valueKind={valueKind}
            />
          </UsageChartLoadBoundary>
        </div>
      </div>
    </section>
  );
}

export function hasCodingPlanCreditUsageData({
  summary,
  modelDataList,
  toolDataList,
}: {
  summary: CodingPlanUsageSnapshot["detail"]["model"];
  modelDataList: CodingPlanModelData[];
  toolDataList: CodingPlanToolData[];
}): boolean {
  if (
    hasPositiveFiniteNumber(summary.totalCredits) ||
    hasPositiveFiniteNumber(summary.averageDailyCredits)
  ) {
    return true;
  }

  return (
    modelDataList.some(
      (item) =>
        hasPositiveFiniteNumber(item.totalCredits) ||
        hasPositiveFiniteSeries(item.creditsUsage) ||
        hasPositiveFiniteSeries(item.cachedInputCreditsUsage) ||
        hasPositiveFiniteSeries(item.uncachedInputCreditsUsage) ||
        hasPositiveFiniteSeries(item.outputCreditsUsage),
    ) ||
    toolDataList.some(
      (item) =>
        hasPositiveFiniteNumber(item.totalCredits) || hasPositiveFiniteSeries(item.creditsUsage),
    )
  );
}

export function shouldShowCodingPlanUsageDetailSummary({
  summary,
  modelDataList,
  toolDataList,
}: {
  summary: CodingPlanUsageSnapshot["detail"]["model"];
  modelDataList: CodingPlanModelData[];
  toolDataList: CodingPlanToolData[];
}): boolean {
  if (
    hasPositiveFiniteNumber(summary.totalCredits) ||
    hasPositiveFiniteNumber(summary.averageDailyCredits)
  ) {
    return true;
  }

  // 旧版 Coding Plan usage-detail 只有 token 用量时也可能返回 cache 命中率，
  // 但 BigModel 官网不展示积分摘要卡；只有真实 credits 数据才展示这组三卡。
  return hasCodingPlanCreditUsageData({ summary, modelDataList, toolDataList });
}

function hasPositiveFiniteNumber(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasPositiveFiniteSeries(values: number[] | undefined): boolean {
  return values?.some(hasPositiveFiniteNumber) === true;
}

function CodingPlanUsageDetailSummary({
  summary,
}: {
  summary: CodingPlanUsageSnapshot["detail"]["model"];
}) {
  const { intl, locale } = useZCodeIntl();
  const items = [
    {
      label: intl.formatMessage({ id: "settings.usage.cacheHitRate" }),
      trend: summary.cacheHitRateTrend,
      value: formatCodingPlanRate(locale, summary.cacheHitRate),
    },
    {
      label: intl.formatMessage({ id: "settings.usage.creditsTotal" }),
      trend: summary.totalCreditsTrend,
      value: formatCompactNumber(locale, summary.totalCredits),
    },
    {
      label: intl.formatMessage({ id: "settings.usage.averageDailyCredits" }),
      trend: summary.averageDailyCreditsTrend,
      value: formatCompactNumber(locale, summary.averageDailyCredits),
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="rounded-xl bg-surface/70 p-4">
          <div className="truncate text-ui-lg font-medium text-foreground">{item.value}</div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-ui-base text-foreground-subtle">
            <span className="min-w-0 truncate">{item.label}</span>
            {item.trend === null ? null : (
              <span
                className={`shrink-0 text-ui-base ${
                  item.trend < 0 ? "text-destructive" : "text-success"
                }`}
              >
                {formatCodingPlanTrend(locale, item.trend)}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function CodingPlanHealthSection({ snapshot }: { snapshot: CodingPlanUsageSnapshot }) {
  const { intl } = useZCodeIntl();
  const healthSeries = useMemo(
    () => [
      {
        name: intl.formatMessage({ id: "settings.usage.healthProMaxDecode" }),
        values: snapshot.health.proMaxDecodeSpeed,
      },
      {
        name: intl.formatMessage({ id: "settings.usage.healthLiteDecode" }),
        values: snapshot.health.liteDecodeSpeed,
      },
    ],
    [snapshot.health.liteDecodeSpeed, snapshot.health.proMaxDecodeSpeed, intl],
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.healthTitle" })}
        </h3>
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.usage.healthRange.7d" })}
        </span>
      </div>
      <div className="rounded-xl bg-surface/70 p-3">
        <UsageChartLoadBoundary
          scope="settings.usage.coding-plan-health-chart"
          resetKeys={[snapshot.sourceProvider.id, snapshot.generatedAt]}
          loadingDescription={intl.formatMessage({
            id: "settings.usage.codingPlanLoadingDescription",
          })}
        >
          <CodingPlanUsageLineChart
            xTime={snapshot.health.xTime}
            granularity="day"
            emptyDescription={intl.formatMessage({
              id: "settings.usage.emptyDescription",
            })}
            series={healthSeries}
            valueKind="speed"
          />
        </UsageChartLoadBoundary>
      </div>
    </section>
  );
}

function formatCodingPlanRate(locale: string, value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }
  const normalizedValue = value > 1 ? value / 100 : value;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
    style: "percent",
  }).format(normalizedValue);
}

function formatCodingPlanRefreshTime(
  locale: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  value: number,
): string {
  const time = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    // 12 小时制语言（ko/en）时不补零：「오후 5:00」而非「오후 05:00」。
    hour: resolveHourDigits(locale),
    minute: "2-digit",
  }).format(new Date(value));
  return intl.formatMessage({ id: "settings.usage.lastRefreshTime" }, { time });
}

function formatCodingPlanTrend(locale: string, value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
    style: "percent",
  }).format(Math.abs(value))}`;
}

function formatCodingPlanDetailValue(
  locale: string,
  value: number,
  metric: CodingPlanUsageDetailMetric,
  subject: CodingPlanUsageDetailSubject,
): string {
  if (metric === "credits") {
    return formatCompactNumber(locale, value);
  }
  if (subject === "model") {
    return formatCompactTokenUsage(locale, value);
  }
  return formatCompactNumber(locale, value);
}

function SegmentedTabs<T extends string>({
  value,
  options,
  labelIdPrefix,
  onChange,
}: {
  value: T;
  options: T[];
  labelIdPrefix: string;
  onChange: (value: T) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)}>
      <TabsList className={USAGE_STATS_TABS_LIST_CLASS}>
        {options.map((option) => (
          <TabsTrigger key={option} value={option} className={USAGE_STATS_TABS_TRIGGER_CLASS}>
            {intl.formatMessage({ id: `${labelIdPrefix}.${option}` })}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
