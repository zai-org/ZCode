import { useCallback } from "react";
import { resolveModelProviderFamilyIdByProviderId } from "@zcode/shared";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useServices } from "@/hooks/useServices.js";
import { type CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";
import { resolveCodingPlanUpgradeProductsProviderId } from "@/settings/model-provider-section/codingPlanPricingCards.js";
import { normalizeCodingPlanProviderId } from "@/settings/model-provider-section/codingPlanPurchaseAuth.js";
import { useCodingPlanEntitlements } from "@/settings/model-provider-section/useCodingPlanEntitlements.js";
import {
  beginCodingPlanUpgradeLogin,
  resolvePendingCodingPlanUpgradeAfterLogin,
  type CodingPlanUpgradeDialogTarget,
} from "@/settings/codingPlanUpgradeLoginRecovery.js";
import { CodingPlanEmbeddedWebviewDialog } from "@/settings/CodingPlanEmbeddedWebviewDialog.js";
import { logger } from "@/logger.js";

export { isCodingPlanPurchaseAuthPending } from "@/settings/model-provider-section/codingPlanPurchaseAuth.js";
export {
  beginCodingPlanUpgradeLogin,
  resolvePendingCodingPlanUpgradeAfterLogin,
} from "@/settings/codingPlanUpgradeLoginRecovery.js";
export type { CodingPlanUpgradeDialogTarget } from "@/settings/codingPlanUpgradeLoginRecovery.js";

interface CodingPlanUpgradeDialogProps {
  target?: CodingPlanUpgradeDialogTarget;
  onClose: () => void;
  onOpenResult?: (opened: boolean) => void;
  // 兼容 CodingPlanUpgradeDialogProvider 现有契约。
  // 改造原因：购买/登录流程迁到官网 webview 内部后，App 不再需要「关闭弹窗去登录 → 成功后重开」
  // 的恢复链路；此 prop 当前不使用，保留签名避免改动 Provider。
  onReopen?: (target: CodingPlanUpgradeDialogTarget) => void;
}

// 完成刷新：官网页通过 window.zcodeBridge.notifyPurchaseComplete 回传购买成功后调用。
export async function refreshCodingPlanUpgradeCompletion(params: {
  productsProviderId: CodingPlanProviderId | null;
  providerId: CodingPlanProviderId | null;
  refreshCodingPlanEntitlements: () => Promise<unknown> | unknown;
  refreshProviderState: () => Promise<unknown> | unknown;
  refreshTeamPlanProducts?: () => Promise<unknown> | unknown;
}) {
  await Promise.all([
    params.refreshProviderState(),
    params.refreshCodingPlanEntitlements(),
    // Team Plan 连接项依赖 authenticated pricing/customer 项目快照。
    // 全局购买弹窗关闭前也必须刷新它，避免 Done 后仍看不到新团队项目。
    params.refreshTeamPlanProducts?.(),
  ]);
}

export async function closeAndRefreshCodingPlanUpgradeFromWebview(params: {
  onClose: () => void;
  refresh: () => Promise<unknown> | unknown;
  onRefreshError?: (error: unknown) => void;
}) {
  // 官网 webview 发回的完成信号语义是“关闭升级弹窗并刷新 provider”。
  // 关闭必须先发生，避免用户付款成功后还被弱网下的 provider/权益刷新阻塞在 webview 上。
  params.onClose();
  try {
    await params.refresh();
  } catch (error) {
    params.onRefreshError?.(error);
  }
}

export function CodingPlanUpgradeDialog({
  target,
  onClose,
  onOpenResult,
}: CodingPlanUpgradeDialogProps) {
  const { providerSettingsService, codingPlanSubscriptionService } = useServices();
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const { refresh: refreshCodingPlanEntitlements } = useCodingPlanEntitlements({
    providerSettingsView,
  });

  const providerId = normalizeCodingPlanProviderId(target?.providerId);
  const productsProviderId = providerId
    ? resolveCodingPlanUpgradeProductsProviderId(providerId)
    : null;
  const teamPlanFamily = productsProviderId
    ? resolveModelProviderFamilyIdByProviderId(productsProviderId)
    : null;
  const refreshProviderState = useCallback(
    () => providerSettingsService.refresh("coding-plan-purchase-complete"),
    [providerSettingsService],
  );
  // 官网页购买完成回传：webview 告诉 App 关闭升级弹窗，并在后台刷新当前 provider。
  const handlePurchaseComplete = useCallback(async () => {
    await closeAndRefreshCodingPlanUpgradeFromWebview({
      onClose,
      refresh: () =>
        refreshCodingPlanUpgradeCompletion({
          productsProviderId,
          providerId,
          refreshCodingPlanEntitlements,
          refreshProviderState,
          refreshTeamPlanProducts:
            teamPlanFamily !== null
              ? () =>
                  // 购买完成后会先关闭 webview 弹窗，弹窗内 hook 随即卸载。
                  // 这里直接走 service 拉取当前 family 的团队项目，避免刷新请求被卸载时序吞掉。
                  codingPlanSubscriptionService.getEnterprisePricing({
                    authenticated: true,
                    family: teamPlanFamily,
                  })
              : undefined,
        }),
      onRefreshError: (error) => {
        // 刷新失败不阻塞关闭：用户已付款成功，套餐会在下次自然刷新时更新。
        logger.warn("[CodingPlanUpgradeDialog] 购买完成后刷新状态失败", {
          providerId,
          productsProviderId,
          error,
        });
      },
    });
  }, [
    codingPlanSubscriptionService,
    onClose,
    productsProviderId,
    providerId,
    refreshCodingPlanEntitlements,
    refreshProviderState,
    teamPlanFamily,
  ]);

  if (!target || !providerId || !productsProviderId) {
    return null;
  }

  return (
    <CodingPlanEmbeddedWebviewDialog
      open
      onOpenResult={onOpenResult}
      providerId={providerId}
      funnelContext={target.funnelContext}
      audience={target.initialAudience}
      teamPlanKey={target.initialTeamPlanKey}
      onPurchaseComplete={handlePurchaseComplete}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    />
  );
}
