/* eslint-disable max-lines -- Coding Plan 用量视图集中维护来源选择、额度投影和重置入口；本阶段只迁移 Account Access，不拆分既有 UI 结构。 */
import type {
  UsageEntitlementSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  type OAuthProviderId,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { ChevronRightIcon, LoaderCircle } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  findCodingPlanQuotaLimit,
  formatQuotaRemainingPercentage,
  formatQuotaResetTime,
  resolveMcpQuotaLimit,
} from "@/lib/codingPlanQuotaPresentation.js";
import { renderOAuthProviderIcon } from "@/lib/oauthProviderIcon.js";
import type {
  SidebarUsageCodingPlanProviderId,
  SidebarUsageCodingPlanSourceId,
} from "@/lib/sidebarUsageCodingPlanProviderPreference.js";

export interface CodingPlanUsageRemainingEntitlement {
  sourceId?: SidebarUsageCodingPlanSourceId;
  providerId: SidebarUsageCodingPlanProviderId;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  label?: string;
  snapshot: UsageEntitlementSnapshot | null;
  loading: boolean;
  error: string | null;
}

export interface CodingPlanUsageAvailableProvider {
  providerId: SidebarUsageCodingPlanProviderId;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  label: string;
}

export interface CodingPlanUsageRemainingState {
  activeProviderId?: SidebarUsageCodingPlanSourceId;
  displayedEntitlement: CodingPlanUsageRemainingEntitlement | null;
  displayedProviderId?: SidebarUsageCodingPlanSourceId;
  hasAnyActiveCodingPlan: boolean;
  loading: boolean;
  providerEntitlements: CodingPlanUsageRemainingEntitlement[];
  tabProviders: CodingPlanUsageRemainingTabProvider[];
  visibleSnapshot: UsageEntitlementSnapshot | null;
}

interface CodingPlanUsageRemainingTabProvider {
  id: SidebarUsageCodingPlanSourceId;
  providerId: SidebarUsageCodingPlanProviderId;
  label: string;
}

function UsageLimitRow({
  label,
  value,
  resetTime,
}: {
  label: string;
  value: string;
  resetTime?: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-1.5">
      <div className="min-w-0 truncate text-ui-sm text-foreground">{label}</div>
      <div className="flex min-w-0 max-w-36 items-center gap-2 text-right text-ui-sm">
        <span className="min-w-0 truncate font-medium text-foreground">{value}</span>
        {resetTime ? (
          <span className="min-w-0 truncate text-foreground-subtle">{resetTime}</span>
        ) : null}
      </div>
    </div>
  );
}

function UsageDetailsButton({ label, onUsageClick }: { label: string; onUsageClick?: () => void }) {
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      aria-label={label}
      title={label}
      className="h-6 gap-0.5 px-0 text-ui-sm"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onUsageClick?.();
      }}
    >
      {label}
      <ChevronRightIcon className="size-3.5" />
    </Button>
  );
}

function resolveCodingPlanTabProviderIcon(providerId: string): OAuthProviderId {
  if (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan) {
    return ZAI_PROVIDER_ID;
  }
  return BIGMODEL_PROVIDER_ID;
}

function formatCodingPlanProviderTabAriaLabel(providerId: string): string {
  return providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
    ? "Z.ai Coding Plan"
    : "BigModel Coding Plan";
}

function getEntitlementSourceId(
  entitlement: Pick<CodingPlanUsageRemainingEntitlement, "providerId" | "sourceId">,
): SidebarUsageCodingPlanSourceId {
  return entitlement.sourceId ?? entitlement.providerId;
}

export function hasActiveCodingPlanSnapshot(
  snapshot: UsageEntitlementSnapshot | null,
  providerId: string,
): boolean {
  return (
    snapshot?.provider?.id === providerId &&
    snapshot.unavailableReason !== "no_plan" &&
    Boolean(snapshot.subscription?.details.length)
  );
}

export function resolveCodingPlanUsageRemainingState(params: {
  availableProviders: CodingPlanUsageAvailableProvider[];
  entitlements: CodingPlanUsageRemainingEntitlement[];
  modelProvidersLoading: boolean;
  selectedProviderId?: SidebarUsageCodingPlanSourceId;
}): CodingPlanUsageRemainingState | null {
  const providerEntitlements = params.entitlements.filter(
    (entitlement) =>
      getEntitlementSourceId(entitlement).startsWith("team:") ||
      params.availableProviders.some((provider) => provider.providerId === entitlement.providerId),
  );
  const selectedEntitlement = providerEntitlements.find(
    (entitlement) => getEntitlementSourceId(entitlement) === params.selectedProviderId,
  );
  const activeEntitlement =
    (selectedEntitlement &&
    hasActiveCodingPlanSnapshot(selectedEntitlement.snapshot, selectedEntitlement.providerId)
      ? selectedEntitlement
      : undefined) ??
    providerEntitlements.find((entitlement) =>
      hasActiveCodingPlanSnapshot(entitlement.snapshot, entitlement.providerId),
    );
  const displayedEntitlement =
    activeEntitlement ?? selectedEntitlement ?? providerEntitlements[0] ?? null;
  const activeProviderId = activeEntitlement
    ? getEntitlementSourceId(activeEntitlement)
    : undefined;
  const displayedProviderId = activeProviderId ?? params.selectedProviderId;
  const loading =
    params.modelProvidersLoading || providerEntitlements.some((entitlement) => entitlement.loading);
  const visibleSnapshot =
    displayedEntitlement &&
    hasActiveCodingPlanSnapshot(displayedEntitlement.snapshot, displayedEntitlement.providerId)
      ? displayedEntitlement.snapshot
      : null;
  const activeCodingPlanProviderIds = providerEntitlements
    .filter((entitlement) =>
      hasActiveCodingPlanSnapshot(entitlement.snapshot, entitlement.providerId),
    )
    .map((entitlement) => getEntitlementSourceId(entitlement));
  const hasAnyActiveCodingPlan = Boolean(activeEntitlement);
  const tabProviders = providerEntitlements
    .filter((entitlement) =>
      activeCodingPlanProviderIds.includes(getEntitlementSourceId(entitlement)),
    )
    .map((entitlement): CodingPlanUsageRemainingTabProvider => {
      const provider = params.availableProviders.find(
        (item) => item.providerId === entitlement.providerId,
      );
      return {
        id: getEntitlementSourceId(entitlement),
        providerId: entitlement.providerId,
        label:
          entitlement.label ??
          provider?.label ??
          formatCodingPlanProviderTabAriaLabel(entitlement.providerId),
      };
    });

  if (
    (!params.modelProvidersLoading && providerEntitlements.length === 0) ||
    (!loading && !hasAnyActiveCodingPlan)
  ) {
    return null;
  }

  return {
    activeProviderId,
    displayedEntitlement,
    displayedProviderId,
    hasAnyActiveCodingPlan,
    loading,
    providerEntitlements,
    tabProviders,
    visibleSnapshot,
  };
}

export function hasCodingPlanUsageRemainingPanel(params: {
  availableProviders: CodingPlanUsageAvailableProvider[];
  entitlements: CodingPlanUsageRemainingEntitlement[];
  modelProvidersLoading: boolean;
  selectedProviderId?: SidebarUsageCodingPlanSourceId;
}): boolean {
  return Boolean(resolveCodingPlanUsageRemainingState(params));
}

export function CodingPlanUsageRemainingPanel({
  availableProviders,
  audience,
  className,
  entitlements,
  modelProvidersLoading,
  onProviderChange,
  onUsageClick,
  selectedProviderId,
}: {
  availableProviders: CodingPlanUsageAvailableProvider[];
  audience?: "individual" | "team";
  className?: string;
  entitlements: CodingPlanUsageRemainingEntitlement[];
  modelProvidersLoading: boolean;
  onProviderChange?: (providerId: SidebarUsageCodingPlanSourceId) => void;
  onUsageClick?: () => void;
  selectedProviderId?: SidebarUsageCodingPlanSourceId;
}) {
  const { intl, locale } = useZCodeIntl();
  const state = useMemo(
    () =>
      resolveCodingPlanUsageRemainingState({
        availableProviders,
        entitlements,
        modelProvidersLoading,
        selectedProviderId,
      }),
    [availableProviders, entitlements, modelProvidersLoading, selectedProviderId],
  );

  if (!state) {
    return null;
  }

  const planLevel = state.visibleSnapshot?.quota?.level ?? null;
  const remaining = state.visibleSnapshot?.remaining;
  const unavailableReason = state.visibleSnapshot?.unavailableReason;
  const limits = state.visibleSnapshot?.quota?.limits ?? [];
  const fiveHourTokenLimit = findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 3, 5);
  const weeklyTokenLimit = findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 6);
  const monthlyToolLimit = findCodingPlanQuotaLimit(limits, "TIME_LIMIT", 5, 1);
  const mcpQuotaLimit = resolveMcpQuotaLimit(state.visibleSnapshot);
  const fiveHourResetTime = fiveHourTokenLimit?.nextResetTime
    ? formatQuotaResetTime({
        locale,
        value: fiveHourTokenLimit.nextResetTime,
        format: "dateTime",
        compactToday: true,
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
    ? formatQuotaResetTime({
        locale,
        value: mcpQuotaLimit.nextResetTime,
        format: "date",
      })
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

  return (
    <div className={className}>
      <div className="border-b border-border px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center">
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="min-w-0 truncate text-ui-base font-medium text-foreground">
                {intl.formatMessage({
                  id: "sidebar.usage.plan.codingPlanTitle",
                })}
              </div>
              {audience ? (
                <span className="shrink-0 rounded-full border border-border bg-surface px-2 py-0.5 text-ui-xs font-medium leading-none text-foreground-subtle">
                  {intl.formatMessage({
                    id:
                      audience === "team"
                        ? "sidebar.usage.plan.audienceTeam"
                        : "sidebar.usage.plan.audienceIndividual",
                  })}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* 修复原因：同一份 Usage Remaining 展示会出现在 sidebar 和输入框上下文菜单。
                详情入口必须由调用方传入，避免共享展示组件直接依赖 tab/store 导航。 */}
            {onUsageClick ? (
              <UsageDetailsButton
                label={intl.formatMessage({ id: "sidebar.usage.plan.open" })}
                onUsageClick={onUsageClick}
              />
            ) : null}
            {!audience && state.tabProviders.length > 1 && state.displayedProviderId ? (
              <div className="flex min-w-0 items-center rounded-lg bg-surface p-0.5">
                {state.tabProviders.map((provider) => {
                  const active = provider.id === state.displayedProviderId;
                  const label = provider.label;
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      aria-pressed={active}
                      aria-label={label}
                      title={label}
                      className={[
                        "flex size-6 items-center justify-center rounded-md",
                        active
                          ? "bg-card text-foreground shadow-sm"
                          : "text-foreground-subtle hover:bg-menu-hover hover:text-foreground",
                      ].join(" ")}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onProviderChange?.(provider.id);
                      }}
                    >
                      {renderOAuthProviderIcon(
                        resolveCodingPlanTabProviderIcon(provider.providerId),
                        "size-3.5",
                      )}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="px-3 py-2">
        {state.loading && !state.visibleSnapshot ? (
          <div className="flex items-center gap-2 p-2 text-ui-base text-foreground-subtle">
            <LoaderCircle className="size-3.5 animate-spin" />
            {intl.formatMessage({ id: "sidebar.usage.plan.loading" })}
          </div>
        ) : state.displayedEntitlement?.error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
            {state.displayedEntitlement.error}
          </div>
        ) : unavailable ? (
          <div className="p-2 text-ui-base leading-relaxed text-foreground-subtle">
            {unavailableMessage}
          </div>
        ) : (
          <>
            {fiveHourTokenLimit ? (
              <UsageLimitRow
                label={intl.formatMessage({
                  id: "sidebar.usage.plan.fiveHour",
                })}
                value={formatQuotaRemainingPercentage(locale, fiveHourTokenLimit)}
                resetTime={fiveHourResetTime}
              />
            ) : null}
            {weeklyTokenLimit ? (
              <UsageLimitRow
                label={intl.formatMessage({
                  id: "sidebar.usage.plan.weekly",
                })}
                value={formatQuotaRemainingPercentage(locale, weeklyTokenLimit)}
                resetTime={weeklyResetTime}
              />
            ) : null}
            {monthlyToolLimit ? (
              <UsageLimitRow
                label={intl.formatMessage({
                  id: "sidebar.usage.plan.toolCalls",
                })}
                value={formatQuotaRemainingPercentage(locale, monthlyToolLimit)}
                resetTime={monthlyToolResetTime}
              />
            ) : null}
            {mcpQuotaLimit ? (
              <UsageLimitRow
                label={intl.formatMessage({ id: "sidebar.usage.plan.mcp" })}
                value={formatQuotaRemainingPercentage(locale, mcpQuotaLimit)}
                resetTime={mcpResetTime}
              />
            ) : null}
          </>
        )}
      </div>
      {remaining?.isShow === false ? (
        <div className="border-t border-border px-3 py-2 text-ui-xs font-normal">
          {intl.formatMessage({ id: "sidebar.usage.plan.hidden" })}
        </div>
      ) : null}
    </div>
  );
}
