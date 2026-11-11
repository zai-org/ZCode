import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
import type { CodingPlanBillingDiscountConfig } from "@zcode/shared";
import { ArrowLeftIcon, LoaderCircle, RocketIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  CodingPlanBillingDiscountBadgePill,
  CodingPlanBillingDiscountInfoDialog,
} from "@/CodingPlanBillingDiscount.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodingPlanLoginOptions } from "./codingPlanPricingCards.js";

export function CodingPlanStatusActions({
  providerName,
  isDisconnected,
  isUnavailable,
  isPurchased,
  loginLoading,
  loginButtonId,
  loginVisible,
  canDisconnectProvider,
  disconnectLoading,
  onLogin,
  onDisconnect,
}: {
  providerName: string;
  isDisconnected: boolean;
  isUnavailable: boolean;
  isPurchased: boolean;
  loginLoading?: boolean;
  loginButtonId: string;
  loginVisible: boolean;
  canDisconnectProvider: boolean;
  disconnectLoading?: boolean;
  onLogin?: (options?: CodingPlanLoginOptions) => void;
  onDisconnect?: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex shrink-0 flex-wrap justify-start gap-2">
      {loginVisible && (isDisconnected || isUnavailable) && onLogin ? (
        <Button type="button" size="lg" onClick={() => onLogin()} disabled={loginLoading}>
          {loginLoading ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          {intl.formatMessage({ id: loginButtonId }, { provider: providerName })}
        </Button>
      ) : null}
      {canDisconnectProvider && onDisconnect && !isPurchased ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={disconnectLoading}
          onClick={onDisconnect}
        >
          {disconnectLoading ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          {intl.formatMessage({
            id: "settings.modelProvider.codingPlan.disconnect",
          })}
        </Button>
      ) : null}
    </div>
  );
}

export function CodingPlanUpgradeAction({
  loginLoading,
  upgradePlansVisible,
  actionLabelId = "settings.modelProvider.codingPlan.upgrade",
  billingDiscountActive,
  billingDiscountConfig,
  onUpgradePlansVisibleChange,
}: {
  loginLoading?: boolean;
  upgradePlansVisible: boolean;
  actionLabelId?: string;
  billingDiscountActive?: boolean;
  billingDiscountConfig?: CodingPlanBillingDiscountConfig;
  onUpgradePlansVisibleChange: (visible: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const billingDiscountButtonActive = billingDiscountActive === true && !upgradePlansVisible;

  const upgradeButton = (
    <CodingPlanEntryButton
      bypassGate={upgradePlansVisible}
      type="button"
      size="lg"
      className={cn(
        billingDiscountButtonActive &&
          "button-gradient dark:bg-[#484A58] text-white hover:bg-transparent hover:opacity-90 dark:hover:bg-[#484A58] pr-[5px] rounded-full",
      )}
      onClick={() => {
        // 购买/升级入口必须先打开面板，OAuth 失效恢复由面板在用户选择
        // plan/周期后处理，避免点击 Upgrade 直接跳登录导致用户看不到购买流程。
        onUpgradePlansVisibleChange(!upgradePlansVisible);
      }}
      disabled={loginLoading}
    >
      {loginLoading ? (
        // Upgrade 可能先触发 OAuth 业务 token 刷新。
        // 等待期间只有 disabled 没有 spinner，用户会误以为点击没有响应。
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : upgradePlansVisible ? (
        <ArrowLeftIcon className="size-3.5" />
      ) : (
        <RocketIcon className="size-3.5" />
      )}
      {intl.formatMessage({
        id: upgradePlansVisible ? "settings.modelProvider.codingPlan.cancelUpgrade" : actionLabelId,
      })}
      {billingDiscountButtonActive ? (
        <CodingPlanBillingDiscountBadgePill
          config={billingDiscountConfig}
          iconVisible={false}
          variant="surface"
        />
      ) : null}
    </CodingPlanEntryButton>
  );

  if (!billingDiscountButtonActive) {
    return upgradeButton;
  }

  return (
    <div className="inline-flex shrink-0 items-center gap-1">
      {upgradeButton}
      <CodingPlanBillingDiscountInfoDialog config={billingDiscountConfig} />
    </div>
  );
}
