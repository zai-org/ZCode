import { useEffect } from "react";
import { toZhOrEnLocale } from "@zcode/shared";
import { useStore } from "zustand";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { CloudContentDialog } from "@/components/cloud-content-dialog/CloudContentDialog.js";
import { MarketingFailureDialog } from "@/components/marketing-touch/MarketingFailureDialog.js";
import { adaptMarketingPopup } from "@/components/marketing-touch/marketingPopupAdapter.js";
import { marketingNavigation } from "@/lib/marketingNavigation.js";
import type { MarketingTouchController } from "@/components/marketing-touch/marketingTouchController.js";

export function MarketingDialogs({ controller }: { controller: MarketingTouchController }) {
  const state = useStore(controller.store);
  const openingUpgrade = useStore(
    marketingNavigation,
    (state) => state.request?.target.page === "upgrade",
  );
  const { locale, intl } = useZCodeIntl();
  const claimError = state.errorAction === "claim_zcode_plan" ? state.error : null;
  useEffect(() => {
    if (state.error && !claimError) {
      toast(state.error);
      controller.clearError();
    }
  }, [state.error, claimError, controller]);
  const dialog = state.dialog;
  const content = !dialog
    ? null
    : dialog.delivery.resource_position === "popup"
      ? dialog.delivery.popup
      : dialog.delivery.banner.success_popup;
  const payload =
    dialog && content
      ? adaptMarketingPopup(
          dialog.delivery.campaign_id,
          toZhOrEnLocale(locale),
          content,
          dialog.hero,
          intl.formatMessage({ id: "manualClaimPlan.claim.dialog.modelSettings" }),
        )
      : null;
  return (
    <>
      {claimError ? (
        <MarketingFailureDialog
          message={claimError}
          title={intl.formatMessage({ id: "manualClaimPlan.claim.failure.title" })}
          acknowledge={intl.formatMessage({ id: "manualClaimPlan.claim.dialog.acknowledge" })}
          onClose={() => controller.clearError()}
        />
      ) : null}
      {payload && content ? (
        <CloudContentDialog
          payload={payload}
          open={!openingUpgrade && !claimError}
          actionPending={state.pending}
          onClose={() => {
            void controller.closeDialog();
          }}
          labels={{
            actionFailed: intl.formatMessage({ id: "marketingTouch.failed" }),
            copySucceeded: intl.formatMessage({
              id: "manualClaimPlan.claim.share.copyTextSucceeded",
            }),
          }}
          handlers={{
            open_external: async (action) => {
              await controller.dialogAction({ type: "open_url", args: { url: action.url } });
            },
            claim_plan: async (action) => {
              await controller.dialogAction({
                type: "claim_zcode_plan",
                args: { plan_id: action.planId },
              });
            },
            copy_text: async (action) => {
              const result = await controller.dialogAction({
                type: "copy_text",
                args: { text: action.text },
              });
              if (result?.status !== "success") throw new Error("marketing_copy_failed");
            },
            navigate: async (_action, actionId) => {
              const button = content.buttons.find(
                (_button, index) => `button-${index}` === actionId,
              );
              if (button?.action.type !== "navigate")
                throw new Error("marketing_navigation_invalid");
              const result = await controller.dialogAction(button.action);
              if (result?.status !== "success") throw new Error("marketing_navigation_failed");
            },
          }}
        />
      ) : null}
    </>
  );
}
