import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
/* eslint-disable max-lines -- Coding Plan/Start Plan 状态卡集中编排状态、动作和套餐区块，当前先保持同一文件避免拆散状态语义。 */
import {
  BIGMODEL_PROVIDER_ID,
  isStartPlanModelProviderId,
  resolveModelProviderFamilySpecByProviderId,
  type UsageEntitlementSubscriptionDetail,
  type UsageQuotaLimit,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import { InfoIcon, LoaderCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { logger } from "@/logger.js";
import { LocalizedCodingPlanQuotaResetAction } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetAction.js";
import { CodingPlanQuotaResetOpportunity } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.js";
import { buildCodingPlanQuotaResetDialogConfig } from "@/components/coding-plan-quota-reset/buildCodingPlanQuotaResetDialogConfig.js";
import {
  CodingPlanBillingDiscountBadge,
  useCodingPlanBillingDiscount,
} from "@/CodingPlanBillingDiscount.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import { formatQuotaResetTime, isSameLimitCategory } from "@/lib/codingPlanQuotaPresentation.js";
import {
  mergeCodingPlanQuotaResetOpportunityBadges,
  resolveCodingPlanQuotaResetActionCompletedAt,
  resolveCodingPlanQuotaResetLimit,
} from "@/lib/codingPlanQuotaResetUi.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
  type CodingPlanFunnelContext,
} from "@/lib/codingPlanFunnelTelemetry.js";
import {
  type CodingPlanStatus,
  type CodingPlanProviderId,
  type TeamPlanAvailabilityReason,
} from "./constants.js";
import type { CodingPlanStatusPanelViewState } from "./codingPlanStatusPanelViewState.js";
import { CodingPlanStatusMeta, StartPlanStatusMeta } from "./CodingPlanStatusMeta.js";
import { CodingPlanStatusActions, CodingPlanUpgradeAction } from "./CodingPlanStatusActions.js";
import type { CodingPlanLoginOptions } from "./codingPlanPricingCards.js";
import type { PurchaseAudience } from "./codingPlanEnterpriseTiers.js";
import { StartPlanCard } from "./StartPlanCard.js";
import { StartPlanQuotaStatusCard } from "./StartPlanQuotaStatusCard.js";
import { resolveStartPlanQuotaCardEntries } from "./StartPlanBalanceCard.js";
import { useStartPlanPreview } from "./useStartPlanPreview.js";
import {
  BigModelRegistrationHint,
  isBigModelUnregisteredAuthError,
} from "./BigModelRegistrationHint.js";
import { formatQuotaModelDisplayName } from "./quotaModelDisplayName.js";

const CODING_PLAN_USAGE_SUMMARY_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-usage-chart-4)",
] as const;

function PlanStatusCardSurface({
  planTitle,
  titleAccessory,
  statusMeta,
  trailingAction,
  usageContent,
}: {
  planTitle: string;
  titleAccessory?: ReactNode;
  statusMeta: ReactNode;
  trailingAction?: ReactNode;
  usageContent?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex min-w-0 items-center justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <h3 className="min-w-0 truncate text-ui-lg font-semibold leading-5 text-foreground">
              {planTitle}
            </h3>
            {titleAccessory}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {statusMeta}
          </div>
        </div>
        {trailingAction ? (
          <div className="shrink-0 max-sm:flex max-sm:w-full max-sm:[&>button]:w-full">
            {trailingAction}
          </div>
        ) : null}
      </div>
      {usageContent ? (
        <>
          <div className="my-4 border-t border-border" />
          {usageContent}
        </>
      ) : null}
    </div>
  );
}

export function ModelProviderLoadingCard({ loadingLabel }: { loadingLabel: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
      <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
        <LoaderCircle className="size-4 animate-spin" />
        <span>{loadingLabel}</span>
      </div>
    </div>
  );
}

export function PresetProviderPlaceholderCard({
  displayName,
  messageId = "settings.modelProvider.presetEmpty",
}: {
  displayName: string;
  messageId?: string;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="bg-background/50 rounded-2xl p-3">
      <div className="text-ui-lg font-semibold text-foreground">{displayName}</div>
      <div className="mt-1 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: messageId })}
      </div>
    </div>
  );
}

export function CodingPlanStatusPanel({
  providerId,
  providerName,
  status,
  viewState,
  loginLoading,
  disconnectLoading,
  purchaseUrl,
  planLevel,
  inactivePlanTitle,
  subscriptionRenewTime,
  subscriptionExpireTime,
  subscriptionDetails,
  quotaLimits = [],
  mcpQuotaLimit = null,
  authError,
  onOpenRegistration,
  onLogin,
  onRetry,
  reloginOnFailure = false,
  onOpenPurchase,
  onDisconnect,
  onOpenUpgradePlans,
  purchaseInitialAudience = "personal",
  loginActionPlacement = "inline",
  loginActionVisible = false,
  usageDetailsVisible = true,
  upgradeActionVisible = true,
  upgradePlansVisible: controlledUpgradePlansVisible,
  onUpgradePlansVisibleChange,
  startPlanPreviewVisible = true,
  statusLabelId,
  statusMessage,
  teamPlanAvailabilityReason,
  quotaResetSourceKey,
  quotaResetAccountAccess,
  onQuotaResetEntitlementRefresh,
}: {
  providerId: CodingPlanProviderId;
  providerName: string;
  status: CodingPlanStatus;
  viewState?: CodingPlanStatusPanelViewState;
  loginLoading?: boolean;
  disconnectLoading?: boolean;
  purchaseUrl?: string;
  planLevel?: string | null;
  inactivePlanTitle?: string | null;
  subscriptionRenewTime?: string | null;
  subscriptionExpireTime?: string | null;
  subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
  quotaLimits?: UsageQuotaLimit[];
  /** 官方 Server MCP 额度（服务端下发的总额度）。不在 quota.limits[] 里，由 nav item 单独透传。 */
  mcpQuotaLimit?: UsageQuotaLimit | null;
  authError?: string | null;
  onOpenRegistration?: () => void;
  onLogin?: (options?: CodingPlanLoginOptions) => number | void | Promise<void>;
  /** 凭据获取失败提供主动重新登录，不据此自动退出账号。 */
  reloginOnFailure?: boolean;
  /** Start 套餐获取失败沿用 Host 手动刷新，不强制重新登录。 */
  onRetry?: () => void;
  onOpenPurchase?: (url: string) => void;
  onDisconnect?: () => void;
  onOpenUpgradePlans?: (options: {
    initialAudience: PurchaseAudience;
    funnelContext: CodingPlanFunnelContext | null;
  }) => void;
  /** 原生面板移除后，Team 状态卡仍须把购买对象传给统一升级入口。 */
  purchaseInitialAudience?: PurchaseAudience;
  loginActionPlacement?: "inline" | "trailing";
  loginActionVisible?: boolean;
  usageDetailsVisible?: boolean;
  upgradeActionVisible?: boolean;
  upgradePlansVisible?: boolean;
  onUpgradePlansVisibleChange?: (visible: boolean) => void;
  startPlanPreviewVisible?: boolean;
  statusLabelId?: string;
  statusMessage?: string | null;
  teamPlanAvailabilityReason?: TeamPlanAvailabilityReason;
  /** Team Plan 必须传完整连接 key，避免与同 provider 的个人套餐共享重置状态。 */
  quotaResetSourceKey?: string;
  quotaResetAccountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  onQuotaResetEntitlementRefresh?: () => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const billingDiscount = useCodingPlanBillingDiscount();
  const [internalUpgradePlansVisible, setInternalUpgradePlansVisible] = useState(false);
  const [startPlanEntitlementRefreshing, setStartPlanEntitlementRefreshing] = useState(false);
  const upgradePlansVisible = controlledUpgradePlansVisible ?? internalUpgradePlansVisible;
  const setUpgradePlansVisible = onUpgradePlansVisibleChange ?? setInternalUpgradePlansVisible;
  const refreshStartPlanEntitlement = async () => {
    if (!onQuotaResetEntitlementRefresh || startPlanEntitlementRefreshing) {
      return;
    }
    setStartPlanEntitlementRefreshing(true);
    try {
      await onQuotaResetEntitlementRefresh();
    } catch (error) {
      // 额度桶可能在生效时间后仍短暂未就绪。刷新失败时必须保留按钮供重试，
      // 不能因为一次网络错误把“尚未同步”错误收敛成已完成。
      logger.warn("[ModelProviderSection] 刷新 Start Plan 权益失败", {
        error: error instanceof Error ? error.message : String(error),
        providerId,
      });
    } finally {
      setStartPlanEntitlementRefreshing(false);
    }
  };
  const effectiveViewState = viewState ?? {
    displayStatus: status,
    actionStatus: status,
    balanceStatus: status,
    loginLoading: loginLoading === true,
  };
  const isDisconnected = effectiveViewState.displayStatus === "disconnected";
  const isChecking = effectiveViewState.displayStatus === "checking";
  const isUnavailable = effectiveViewState.displayStatus === "unavailable";
  const isUnsupported = effectiveViewState.displayStatus === "unsupported";
  const isPurchased = effectiveViewState.displayStatus === "purchased";
  const isNotPurchased = effectiveViewState.displayStatus === "notPurchased";
  const actionIsDisconnected = effectiveViewState.actionStatus === "disconnected";
  const isStartPlanProvider = isStartPlanModelProviderId(providerId);
  const providerIcon =
    resolveModelProviderFamilySpecByProviderId(providerId)?.oauthProviderId ?? null;
  const canDisconnectProvider =
    !isStartPlanProvider &&
    Boolean(onDisconnect) &&
    !isDisconnected &&
    !isChecking &&
    !isUnavailable &&
    !isUnsupported;
  const loginButtonId = isStartPlanProvider
    ? isUnavailable
      ? "chat.error.action.relogin"
      : "settings.modelProvider.startPlan.login"
    : "settings.modelProvider.codingPlan.connect";
  const defaultStatusBadgeId = isUnsupported
    ? "settings.modelProvider.codingPlan.status.unsupported"
    : isDisconnected
      ? "settings.modelProvider.codingPlan.status.disconnected"
      : isChecking
        ? "settings.modelProvider.codingPlan.status.checking"
        : isUnavailable
          ? "settings.modelProvider.codingPlan.status.unavailable"
          : isPurchased
            ? "settings.modelProvider.codingPlan.status.purchased"
            : "settings.modelProvider.codingPlan.status.notPurchased";
  // 检查态可能仍携带上一轮团队错误；状态行只呈现当前检查状态，避免双图标和旧错误闪现。
  const statusBadgeId = isChecking
    ? defaultStatusBadgeId
    : (statusLabelId ??
      (isStartPlanProvider && isDisconnected
        ? "settings.modelProvider.startPlan.status.loginRequired"
        : isStartPlanProvider && isNotPurchased
          ? "settings.modelProvider.startPlan.status.noPlan"
          : defaultStatusBadgeId));
  const statusBadgeMessage = isChecking ? undefined : statusMessage?.trim();
  // 展示文案不是状态权威。Team Plan 交互只读取显式业务原因，
  // 避免 Project Key 错误被翻译 key 误判成“团队套餐未分配”。
  const teamPlanUnavailableStatusVisible =
    teamPlanAvailabilityReason === "not-allocated" || teamPlanAvailabilityReason === "expired";
  const teamPlanWarningVisible = !isChecking && teamPlanAvailabilityReason !== undefined;
  const recoverableUnavailable =
    effectiveViewState.actionStatus === "unavailable" && !teamPlanUnavailableStatusVisible;
  const reloginVisible = recoverableUnavailable && reloginOnFailure && Boolean(onLogin);
  const retryVisible =
    (recoverableUnavailable ||
      statusLabelId === "settings.modelProvider.codingPlan.status.unavailable") &&
    !reloginVisible &&
    Boolean(onRetry);
  const trailingLoginVisible =
    !reloginVisible &&
    !retryVisible &&
    loginActionVisible &&
    loginActionPlacement === "trailing" &&
    (actionIsDisconnected || recoverableUnavailable) &&
    Boolean(onLogin);
  const rawPlanLevel = planLevel?.trim() ?? "";
  const normalizedPlanLevel = rawPlanLevel.toUpperCase();
  const isMaxPlanLevel = isMaxCodingPlanLevel(rawPlanLevel);
  const displayPlanLevel = /^GLM[\s_-]+CODING\b/i.test(rawPlanLevel)
    ? formatQuotaModelDisplayName(rawPlanLevel)
    : normalizedPlanLevel;
  const canUpgrade =
    // Max 已是最高档但仍需要续期入口，不能因为不可升级就隐藏按钮。
    upgradeActionVisible && isPurchased && !isChecking && !isUnsupported;
  const canManageCodingPlan =
    !isDisconnected &&
    !isChecking &&
    !isUnsupported &&
    isPurchased &&
    Boolean(purchaseUrl) &&
    Boolean(onOpenPurchase);
  const disconnectedStartPlanPricingVisible =
    isStartPlanProvider && (isDisconnected || isNotPurchased);
  const startPlanCardVisible =
    startPlanPreviewVisible && disconnectedStartPlanPricingVisible && !upgradePlansVisible;
  const startPlanPreview = useStartPlanPreview({
    enabled: startPlanCardVisible,
  });
  const shouldShowBigModelRegistrationHint =
    isChecking &&
    providerIcon === BIGMODEL_PROVIDER_ID &&
    isBigModelUnregisteredAuthError(authError);
  const createSettingPlanCardFunnelContext = (eventText: string) =>
    createCodingPlanFunnelContext({
      providerId,
      // 修复原因：Start Plan 的升级入口与普通 Coding Plan 套餐卡属于不同链接方式，
      // 埋点必须单独标识，避免把 Start Plan 用户误归类为普通套餐卡来源。
      upgradeSource: isStartPlanProvider ? "setting_start_plan_card" : "setting_plan_card",
      eventRegion: "app.setting",
      eventText,
      entryPlanState: resolveCodingPlanEntryPlanState({
        displayStatus: effectiveViewState.displayStatus,
        providerId,
        planLevel,
      }),
    });
  const openUpgradePlans = (
    initialAudience: PurchaseAudience,
    nextFunnelContext: CodingPlanFunnelContext | null,
  ) => {
    if (onOpenUpgradePlans) {
      // Coding Plan 购买流程不应继续挂载在 Model Settings 内部；
      // 状态卡只负责发起意图，由弹窗 hook 承载购买面板。
      onOpenUpgradePlans({
        initialAudience,
        funnelContext: nextFunnelContext,
      });
      return;
    }
    setUpgradePlansVisible(true);
  };
  const upgradeAction = canUpgrade ? (
    <CodingPlanUpgradeAction
      loginLoading={effectiveViewState.loginLoading}
      upgradePlansVisible={upgradePlansVisible}
      actionLabelId={
        isMaxPlanLevel
          ? "settings.modelProvider.codingPlan.renew"
          : "settings.modelProvider.codingPlan.upgrade"
      }
      billingDiscountActive={isStartPlanProvider && billingDiscount.active}
      billingDiscountConfig={billingDiscount.config}
      onUpgradePlansVisibleChange={(visible) => {
        if (visible) {
          openUpgradePlans(
            purchaseInitialAudience,
            createSettingPlanCardFunnelContext(
              intl.formatMessage({
                id: isMaxPlanLevel
                  ? "settings.modelProvider.codingPlan.renew"
                  : "settings.modelProvider.codingPlan.upgrade",
              }),
            ),
          );
          return;
        }
        setUpgradePlansVisible(visible);
      }}
    />
  ) : null;
  const buyAction =
    !isStartPlanProvider && !canUpgrade && isNotPurchased && !isChecking && !isUnsupported ? (
      <CodingPlanEntryButton
        type="button"
        size="lg"
        // 未购买状态也可能正在等待权益接口返回；此时必须和 Upgrade
        // 按钮一样禁用，避免旧的 notPurchased 快照被提前提交为购买入口。
        disabled={effectiveViewState.loginLoading}
        onClick={() => {
          openUpgradePlans(
            purchaseInitialAudience,
            createSettingPlanCardFunnelContext(
              intl.formatMessage({
                id: "settings.modelProvider.codingPlan.subscribe",
              }),
            ),
          );
        }}
      >
        {/* 单卡同步可能晚于全局套餐查询；仅禁用会丢失等待反馈，和 Upgrade 保持一致。 */}
        {effectiveViewState.loginLoading ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : null}
        {intl.formatMessage({
          id: "settings.modelProvider.codingPlan.subscribe",
        })}
      </CodingPlanEntryButton>
    ) : null;
  const inlineDisconnectVisible = canDisconnectProvider && !isPurchased;
  const planTitle = resolveCodingPlanStatusCardTitle({
    isPurchased,
    isUnavailable,
    isStartPlanProvider,
    inactivePlanTitle,
    rawPlanLevel,
    displayPlanLevel,
    startPlanTitle: intl.formatMessage({
      id: "settings.modelProvider.planCard.startPlan",
    }),
    codingPlanTitle: intl.formatMessage({
      id: "settings.modelProvider.planCard.codingPlan",
    }),
  });
  const titleBillingDiscountVisible = !isStartPlanProvider && billingDiscount.active;
  const notPurchasedStatusLabel = isNotPurchased ? (
    <span className="flex w-fit items-center gap-1.5 text-foreground-subtle">
      <InfoIcon className="size-3 shrink-0" aria-hidden="true" />
      <span>{intl.formatMessage({ id: statusBadgeId })}</span>
    </span>
  ) : null;
  const startPlanEntries = resolveStartPlanQuotaCardEntries({
    plans: subscriptionDetails ?? [],
    limits: quotaLimits,
  });
  const statusMeta =
    isPurchased && isStartPlanProvider ? (
      // 产品语义:体验套餐用量卡片不展示「管理」「解绑」操作(免费套餐无管理页,
      // 登录态由 family 级连接方式管理),仅保留过期时间与右侧升级 Coding Plan 入口。
      <StartPlanStatusMeta
        expireTime={subscriptionExpireTime}
        entitlements={subscriptionDetails?.[0]?.entitlements}
        hasQuota={hasStartPlanEntitlementQuota(
          subscriptionDetails?.[0]?.entitlements,
          startPlanEntries[0]?.limits ?? quotaLimits,
        )}
        refreshing={startPlanEntitlementRefreshing}
        onRefresh={refreshStartPlanEntitlement}
      />
    ) : isPurchased ? (
      <CodingPlanStatusMeta
        renewTime={subscriptionRenewTime}
        expireTime={subscriptionExpireTime}
        manageLabel={
          canManageCodingPlan
            ? intl.formatMessage({
                id: "settings.modelProvider.codingPlan.manage",
              })
            : null
        }
        unlinkLabel={
          canDisconnectProvider
            ? intl.formatMessage({
                id: "settings.modelProvider.codingPlan.disconnect",
              })
            : null
        }
        unlinkLoading={disconnectLoading}
        onManage={
          canManageCodingPlan && purchaseUrl && onOpenPurchase
            ? () => onOpenPurchase(purchaseUrl)
            : undefined
        }
        onUnlink={canDisconnectProvider ? onDisconnect : undefined}
      />
    ) : shouldShowBigModelRegistrationHint ? (
      <BigModelRegistrationHint onOpenRegistration={onOpenRegistration} />
    ) : inlineDisconnectVisible ? (
      <CodingPlanStatusMeta
        statusLabel={notPurchasedStatusLabel ?? intl.formatMessage({ id: statusBadgeId })}
        unlinkLabel={intl.formatMessage({
          id: "settings.modelProvider.codingPlan.disconnect",
        })}
        unlinkLoading={disconnectLoading}
        onUnlink={onDisconnect}
      />
    ) : (
      <span
        className={
          teamPlanWarningVisible
            ? "flex w-fit items-center gap-1.5 text-ui-base text-warning"
            : "flex w-fit items-center gap-1.5 text-ui-base text-foreground-subtle"
        }
      >
        {isChecking ? <LoaderCircle className="size-3 animate-spin" /> : null}
        {isNotPurchased || teamPlanWarningVisible ? (
          <InfoIcon className="size-3 shrink-0" aria-hidden="true" />
        ) : null}
        {statusBadgeMessage || intl.formatMessage({ id: statusBadgeId })}
      </span>
    );
  const usageCardsVisible =
    usageDetailsVisible &&
    isPurchased &&
    (isStartPlanProvider || hasDisplayableCodingPlanUsageLimits(quotaLimits));
  // 同 family 已登录时默认登录动作只刷新；凭据失败后的主动恢复必须强制进入 OAuth。
  const trailingAction = reloginVisible ? (
    <Button
      type="button"
      size="lg"
      onClick={() => onLogin?.({ forceOAuth: true })}
      disabled={effectiveViewState.loginLoading}
    >
      {intl.formatMessage({ id: "login.expired.action" })}
    </Button>
  ) : retryVisible ? (
    <Button type="button" size="lg" onClick={onRetry} disabled={effectiveViewState.loginLoading}>
      {intl.formatMessage({ id: "common.retry" })}
    </Button>
  ) : trailingLoginVisible ? (
    <Button
      type="button"
      size="lg"
      onClick={() => onLogin?.()}
      disabled={effectiveViewState.loginLoading}
    >
      {effectiveViewState.loginLoading ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
      {intl.formatMessage({ id: loginButtonId }, { provider: providerName })}
    </Button>
  ) : upgradeAction ? (
    // 升级是 Plan Card 的主操作，和连接入口同属卡片级 action。
    // 放在标题旁会随标题换行抖动；放到右侧并使用同尺寸按钮，层级和位置都更稳定。
    upgradeAction
  ) : buyAction ? (
    buyAction
  ) : null;
  const statusContent = (
    <>
      {isPurchased && statusLabelId === "settings.modelProvider.codingPlan.status.unavailable" ? (
        <span className="text-ui-base text-warning">
          {intl.formatMessage({ id: statusLabelId })}
        </span>
      ) : null}
      {statusMeta}
      <CodingPlanStatusActions
        providerName={providerName}
        isDisconnected={actionIsDisconnected}
        isUnavailable={recoverableUnavailable}
        isPurchased={isPurchased}
        loginLoading={effectiveViewState.loginLoading}
        loginButtonId={loginButtonId}
        loginVisible={
          loginActionVisible && !trailingLoginVisible && !reloginVisible && !retryVisible
        }
        canDisconnectProvider={inlineDisconnectVisible ? false : canDisconnectProvider}
        disconnectLoading={disconnectLoading}
        onLogin={onLogin}
        onDisconnect={onDisconnect}
      />
    </>
  );
  const planCards =
    isStartPlanProvider && isPurchased && startPlanEntries.length > 0
      ? startPlanEntries.map(({ plan, limits: planLimits }, index) => (
          <PlanStatusCardSurface
            key={`${plan.productId}:${index}`}
            planTitle={plan.productName.trim() || planTitle}
            statusMeta={
              index === 0 ? (
                statusContent
              ) : (
                <StartPlanStatusMeta
                  expireTime={plan.expireTime}
                  entitlements={plan.entitlements}
                  hasQuota={hasStartPlanEntitlementQuota(plan.entitlements, planLimits)}
                  refreshing={startPlanEntitlementRefreshing}
                  onRefresh={refreshStartPlanEntitlement}
                />
              )
            }
            trailingAction={index === 0 ? trailingAction : undefined}
            usageContent={
              usageDetailsVisible &&
              (effectiveViewState.balanceStatus === "checking" || planLimits.length > 0) ? (
                <StartPlanQuotaStatusCard
                  isChecking={effectiveViewState.balanceStatus === "checking"}
                  limits={planLimits}
                  embedded
                />
              ) : undefined
            }
          />
        ))
      : [
          <PlanStatusCardSurface
            key="current-plan"
            planTitle={planTitle}
            titleAccessory={
              titleBillingDiscountVisible ? (
                <CodingPlanBillingDiscountBadge config={billingDiscount.config} size="compact" />
              ) : undefined
            }
            statusMeta={statusContent}
            trailingAction={trailingAction}
            usageContent={
              usageCardsVisible ? (
                isStartPlanProvider ? (
                  // 服务端契约保证 balances 只属于 active plans：purchased 快照必带套餐详情，
                  // 多卡路径必然可用。兜底分支（nav item 无套餐详情）不得把全量 quotaLimits
                  // 塞进单卡，否则无归属桶违背「无匹配 plan_id 的桶不得附着到任何卡片」的约定；
                  // 余额未落定时只保留查询占位。
                  effectiveViewState.balanceStatus === "checking" ? (
                    <StartPlanQuotaStatusCard
                      isChecking
                      limits={[]}
                      expireTime={subscriptionExpireTime}
                      embedded
                    />
                  ) : undefined
                ) : (
                  <CodingPlanUsageSummaryCards
                    limits={quotaLimits}
                    mcpQuotaLimit={mcpQuotaLimit}
                    sourceKey={quotaResetSourceKey ?? providerId}
                    preferredProviderId={providerId}
                    accountAccess={quotaResetAccountAccess}
                    onEntitlementRefresh={onQuotaResetEntitlementRefresh}
                  />
                )
              ) : undefined
            }
          />,
        ];

  return (
    <div className="space-y-3">
      {planCards}

      {startPlanCardVisible && !startPlanPreview.loading && startPlanPreview.preview ? (
        <StartPlanCard preview={startPlanPreview.preview} />
      ) : null}
    </div>
  );
}

export function hasStartPlanEntitlementQuota(
  entitlements: UsageEntitlementSubscriptionDetail["entitlements"],
  limits: readonly UsageQuotaLimit[],
): boolean {
  const entitlementIds = new Set(
    (entitlements ?? [])
      .map((entitlement) => entitlement.entitlementId.trim().toLowerCase())
      .filter(Boolean),
  );
  if (entitlementIds.size === 0) {
    return limits.length > 0;
  }
  return limits.some((limit) => entitlementIds.has(limit.type.trim().toLowerCase()));
}

export function resolveCodingPlanStatusCardTitle({
  isPurchased,
  isUnavailable = false,
  isStartPlanProvider,
  inactivePlanTitle,
  rawPlanLevel,
  displayPlanLevel,
  startPlanTitle,
  codingPlanTitle,
}: {
  isPurchased: boolean;
  isUnavailable?: boolean;
  isStartPlanProvider: boolean;
  inactivePlanTitle?: string | null;
  rawPlanLevel: string;
  displayPlanLevel: string;
  startPlanTitle: string;
  codingPlanTitle: string;
}): string {
  if (!isPurchased) {
    return inactivePlanTitle?.trim() || (isStartPlanProvider ? startPlanTitle : codingPlanTitle);
  }

  if (isStartPlanProvider) {
    // Start provider 偶尔会承载同品牌 paid Coding Plan 的权益快照。
    // 只有真实 Start 权益继续显示 Start Plan；否则必须露出后端权益名，避免付费用户看到免费套餐标题。
    return isStartPlanEntitlementName(rawPlanLevel)
      ? startPlanTitle
      : displayPlanLevel || startPlanTitle;
  }

  return displayPlanLevel || codingPlanTitle;
}

function isStartPlanEntitlementName(planLevel: string): boolean {
  const normalized = planLevel.trim().toLowerCase();
  return (
    normalized === "start" || normalized === "start plan" || normalized.endsWith(" start plan")
  );
}

function isMaxCodingPlanLevel(planLevel: string): boolean {
  return /(^|[\s_-])MAX($|[\s_-])/i.test(planLevel);
}

function CodingPlanUsageSummaryCards({
  limits,
  mcpQuotaLimit,
  sourceKey,
  preferredProviderId,
  accountAccess,
  onEntitlementRefresh,
}: {
  limits: UsageQuotaLimit[];
  mcpQuotaLimit: UsageQuotaLimit | null;
  sourceKey: string;
  preferredProviderId: string;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  onEntitlementRefresh?: () => void | Promise<void>;
}) {
  const { intl, locale } = useZCodeIntl();
  const [quotaResetDialogOpen, setQuotaResetDialogOpen] = useState(false);
  const resetUi = useCodingPlanQuotaResetUi({
    sourceKey,
    preferredProviderId,
    accountAccess,
    onEntitlementRefresh,
  });
  const fiveHourLimit = resolveCodingPlanQuotaResetLimit(
    findUsageLimit(limits, "TOKENS_LIMIT", 3, 5),
    resetUi.entry,
  );
  const weeklyLimit = resolveCodingPlanQuotaResetLimit(
    findUsageLimit(limits, "TOKENS_LIMIT", 6),
    resetUi.week.entry,
  );
  const standardCards = [
    createCodingPlanUsageSummaryCard({
      key: "fiveHour",
      label: intl.formatMessage({
        id: "settings.usage.entitlementFiveHourUsage",
      }),
      limit: fiveHourLimit ?? undefined,
      progressColor: CODING_PLAN_USAGE_SUMMARY_COLORS[0],
      resetTimeFormat: "dateTime",
    }),
    createCodingPlanUsageSummaryCard({
      key: "weekly",
      label: intl.formatMessage({
        id: "settings.usage.entitlementWeeklyUsage",
      }),
      limit: weeklyLimit ?? undefined,
      progressColor: CODING_PLAN_USAGE_SUMMARY_COLORS[1],
      resetTimeFormat: "date",
    }),
    createCodingPlanUsageSummaryCard({
      key: "monthlyTool",
      label: intl.formatMessage({
        id: "settings.usage.entitlementMonthlyMcpUsage",
      }),
      limit: findUsageLimit(limits, "TIME_LIMIT", 5, 1),
      progressColor: CODING_PLAN_USAGE_SUMMARY_COLORS[2],
      resetTimeFormat: "date",
    }),
    createCodingPlanUsageSummaryCard({
      key: "serverMcp",
      label: intl.formatMessage({
        id: "settings.usage.entitlementServerMcpUsage",
      }),
      limit: mcpQuotaLimit ?? undefined,
      progressColor: "var(--color-usage-chart-5)",
      // 官方 Server MCP 额度按自然日重置，重置时刻恒为 00:00，与其它额度卡统一用日期口径。
      resetTimeFormat: "date",
    }),
  ].filter((card): card is CodingPlanUsageSummaryCard => card !== null);
  const cards =
    standardCards.length > 0
      ? standardCards
      : limits
          .filter(isDisplayableUsageLimit)
          .slice(0, 3)
          .map((limit, index) => ({
            key: `generic-${index}`,
            label: resolveGenericUsageLimitLabel(limit, intl),
            limit,
            progressColor:
              CODING_PLAN_USAGE_SUMMARY_COLORS[index % CODING_PLAN_USAGE_SUMMARY_COLORS.length] ??
              CODING_PLAN_USAGE_SUMMARY_COLORS[0],
            resetTimeFormat: "date" as const,
          }));

  const fiveHourCardVisible = cards.some((card) => card.key === "fiveHour");
  const weeklyCardVisible = cards.some((card) => card.key === "weekly");
  // 五小时与周机会合并为一个徽标,次数累加,倒计时取最早到期的一档。
  // Bugfix：曾用「剩余 100% 则重置无收益」隐藏徽标与按钮。核销会把剩余改写成 100%，
  // 同类型余下的机会随即被藏掉，用户以为卡丢了。只要额度卡在且有可用机会就展示。
  const opportunityBadge = mergeCodingPlanQuotaResetOpportunityBadges([
    {
      count: resetUi.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.entry?.opportunityExpiresAt ?? null,
      visible: fiveHourCardVisible && resetUi.opportunityVisible,
    },
    {
      count: resetUi.week.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.week.entry?.opportunityExpiresAt ?? null,
      visible: weeklyCardVisible && resetUi.week.opportunityVisible,
    },
  ]);
  const quotaResetDialog = buildCodingPlanQuotaResetDialogConfig({
    fiveHourEnabled: Boolean(fiveHourLimit),
    resetUi,
    usageItems: cards.map((card) => {
      const percentage = resolveLimitRemainingPercentage(card.limit);
      return {
        color: card.progressColor,
        id: card.key,
        label: card.label,
        percentage,
        resetTime: formatQuotaResetTime({
          locale,
          value: card.limit.nextResetTime,
          format: card.resetTimeFormat,
          compactToday: card.resetTimeFormat === "dateTime",
        }),
        value: formatRemainingPercentage(locale, percentage),
      };
    }),
    weekEnabled: Boolean(weeklyLimit),
  });

  return (
    <div className="space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <h4 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.quotaTitle" })}
        </h4>
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
      <div className="flex w-full gap-2 max-sm:flex-col">
        {cards.map((card) => (
          <PlanUsageMetricCard
            key={card.key}
            action={
              // 额度标题旁入口只打开统一弹窗；真正核销由弹窗内对应类型按钮触发。
              // Bugfix：这里曾额外要求 opportunityBadge.count <= 1，多张机会时反而把
              // 卡上的重置入口藏掉（Usage 页已修，此处遗漏）。与 Usage 页口径对齐：
              // 有可用机会就展示，不因满额或多张隐藏。
              card.key === "fiveHour" &&
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
              ) : undefined
            }
            label={card.label}
            limit={card.limit}
            infoDescription={
              card.key === "serverMcp"
                ? intl.formatMessage({
                    id: "sidebar.usage.plan.zcodeMcpDescription",
                  })
                : undefined
            }
            progressColor={card.progressColor}
            resetTimeFormat={card.resetTimeFormat}
          />
        ))}
      </div>
    </div>
  );
}

interface CodingPlanUsageSummaryCard {
  key: string;
  label: string;
  limit: UsageQuotaLimit;
  progressColor: string;
  resetTimeFormat: "date" | "dateTime";
}

function createCodingPlanUsageSummaryCard(card: {
  key: string;
  label: string;
  limit: UsageQuotaLimit | undefined;
  progressColor: string;
  resetTimeFormat: "date" | "dateTime";
}): CodingPlanUsageSummaryCard | null {
  // Coding Plan 剩余额度展示必须和 sidebar/context 一样只展示接口真实返回的额度项。
  // 不能再用 limits[0]/[1]/[2] 兜底，否则 provider 详情会固定出现三张卡并和其它入口不一致。
  if (!card.limit) {
    return null;
  }
  return {
    key: card.key,
    label: card.label,
    limit: card.limit,
    progressColor: card.progressColor,
    resetTimeFormat: card.resetTimeFormat,
  };
}

function hasDisplayableCodingPlanUsageLimits(limits: UsageQuotaLimit[]): boolean {
  return Boolean(
    findUsageLimit(limits, "TOKENS_LIMIT", 3, 5) ||
    findUsageLimit(limits, "TOKENS_LIMIT", 6) ||
    findUsageLimit(limits, "TIME_LIMIT", 5, 1) ||
    limits.some(isDisplayableUsageLimit),
  );
}

function isDisplayableUsageLimit(limit: UsageQuotaLimit): boolean {
  return (
    typeof limit.percentage === "number" ||
    typeof limit.remaining === "number" ||
    typeof limit.currentValue === "number" ||
    typeof limit.usage === "number"
  );
}

function resolveGenericUsageLimitLabel(
  limit: UsageQuotaLimit,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  if (limit.type === "TIME_LIMIT") {
    return intl.formatMessage({
      id: "settings.usage.entitlementMonthlyMcpUsage",
    });
  }
  // Team Plan 的 quota limit 在测试环境可能不是个人 Coding Plan 的
  // TOKENS_LIMIT(3/5、6) 形态。此时仍应展示剩余额度，不能因为类型不在白名单就空白。
  return intl.formatMessage({
    id: "settings.modelProvider.planCard.usage.totalTokens",
  });
}

function PlanUsageMetricCard({
  action,
  infoDescription,
  label,
  limit,
  progressColor,
  resetTimeFormat,
}: {
  action?: ReactNode;
  infoDescription?: string;
  label?: string;
  limit?: UsageQuotaLimit;
  progressColor: string;
  resetTimeFormat: "date" | "dateTime";
}) {
  const { locale } = useZCodeIntl();
  const remainingPercentage = resolveLimitRemainingPercentage(limit);
  const progressPercentage = remainingPercentage ?? 0;
  const modelLabel = limit && limit.type !== "TIME_LIMIT" ? formatLimitModels(limit) : "";
  const resetTime = formatQuotaResetTime({
    locale,
    value: limit?.nextResetTime,
    format: resetTimeFormat,
    compactToday: resetTimeFormat === "dateTime",
  });

  return (
    <div className="min-w-0 flex-1 rounded-lg bg-surface p-3">
      {label ? (
        // 固定 24px 会让 20px 界面字号的 30px 行盒溢出；最小高度既保持默认对齐，也允许大字号撑高。
        <div className="flex min-h-6 min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">{label}</span>
          {infoDescription ? (
            <ControlHintTooltip title={infoDescription} standalone>
              <button
                type="button"
                aria-label={infoDescription}
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-foreground-subtle transition-colors hover:text-foreground"
                data-zcode-mcp-info="model-settings"
              >
                <InfoIcon className="size-3.5" aria-hidden="true" />
              </button>
            </ControlHintTooltip>
          ) : null}
          {action ? <span className="shrink-0">{action}</span> : null}
        </div>
      ) : null}
      {modelLabel ? (
        <div className={`truncate text-ui-xs text-foreground-subtle ${label ? "mt-1" : ""}`}>
          {modelLabel}
        </div>
      ) : null}
      <div className="mt-2 flex min-w-0 items-baseline gap-1.5">
        <span className="text-ui-lg font-semibold leading-none text-foreground">
          {formatRemainingPercentage(locale, remainingPercentage)}
        </span>
        {resetTime ? (
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{resetTime}</span>
        ) : null}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{
            width: `${progressPercentage}%`,
            backgroundColor: progressColor,
          }}
        />
      </div>
    </div>
  );
}

function findUsageLimit(
  limits: UsageQuotaLimit[],
  type: UsageQuotaLimit["type"],
  unit: number,
  number?: number,
): UsageQuotaLimit | undefined {
  return limits.find(
    (limit) =>
      // zai team plan 返回 CREDIT_LIMIT，bigmodel 返回 TOKENS_LIMIT，
      // unit/number 语义一致。用 isSameLimitCategory 让两者等价命中。
      isSameLimitCategory(limit.type, type) &&
      limit.unit === unit &&
      (number == null || limit.number === number),
  );
}

function resolveLimitRemainingPercentage(limit: UsageQuotaLimit | undefined): number | null {
  const usedPercentage = normalizeUsagePercentage(limit?.percentage);
  if (usedPercentage !== null) {
    // Coding Plan quota 接口的 percentage 是已用百分比，
    // Plan Card 属于“剩余额度”视图，需要和侧边栏剩余用量菜单一致反转展示。
    return Math.max(0, Math.min(100, 100 - usedPercentage));
  }
  const remaining = limit?.remaining;
  const total = limit?.number;
  if (
    typeof remaining === "number" &&
    Number.isFinite(remaining) &&
    typeof total === "number" &&
    Number.isFinite(total) &&
    total > 0
  ) {
    return Math.max(0, Math.min(100, (remaining / total) * 100));
  }
  return null;
}

function normalizeUsagePercentage(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, value));
}

function formatRemainingPercentage(locale: string, value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(Math.max(0, Math.min(100, value)))}%`;
}

function formatLimitModels(limit: UsageQuotaLimit): string {
  const modelNames = limit.usageDetails
    .map((detail) => {
      const displayName = detail.displayName?.trim();
      return formatQuotaModelDisplayName(displayName || formatModelCode(detail.modelCode.trim()));
    })
    .filter((modelName) => modelName.length > 0);
  return Array.from(new Set(modelNames)).join(" / ");
}

function formatModelCode(modelCode: string): string {
  const normalized = modelCode
    .replace(/^model:/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return normalized || modelCode;
}
