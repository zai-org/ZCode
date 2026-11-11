import type { OAuthAccountMaterial } from "#src/oauth/repo/oauthCredentialRepo.js";
import { applyDynamicWorkflowUserMode, type ApiClient } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { ICodingPlanSubscriptionService } from "./codingPlanSubscription.js";
import { BigModelCodingPlanSubscriptionProvider } from "./bigmodelCodingPlanSubscriptionProvider.js";
import type { ModelSelectionView } from "@zcode/provider";
import { ZaiCodingPlanSubscriptionProvider } from "./zaiCodingPlanSubscriptionProvider.js";

interface CodingPlanSubscriptionServiceDependencies {
  apiClient: ApiClient;
  loadOAuthAccountMaterial: (family: "zai" | "bigmodel") => Promise<OAuthAccountMaterial | null>;
  credentialService: Pick<ICredentialService, "load">;
  resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
  /**
   * 用户在设置里选的动态工作流模式（launch.md「The user's choice」）。只有拥有设置权威的装配
   * （desktop 本地 Host、web/standalone server）注入；缺省时快照只含服务端的「提供」。
   */
  resolveDynamicWorkflowUserMode?: () => Promise<unknown>;
}

/**
 * 原 service 把所有调用直接绑定到单一 BigModelCodingPlanSubscriptionProvider，
 * zai family 没有独立的 Team Plan 定价来源（死代码）。
 *
 * zai 与 bigmodel Team Plan 全链路对称化：
 * 同时持有 bigmodel 和 zai 两个 provider 实例；enterprise 读路径（getEnterprisePricing）按
 * request.family 路由到对应实例；缺省 family 时保持 bigmodel，向后兼容既有调用点。
 *
 * 其余方法（购买/staticConfigs/preview 等）语义与 family 无关或已在 provider 内部按
 * request.providerId 动态路由，统一委托给 bigmodel provider 即可：
 *   - 企业购买闭环（balance/order/pending/cancel/continue/status）按产品决策仍只走 bigmodel 域。
 *   - staticConfigs 是平台级 client/configs，与 family 无关。
 *   - 购买类（Stripe/PayPal/preview/createSign 等）已通过 request.providerId 在 provider 内路由。
 */
export function createCodingPlanSubscriptionService(
  dependencies: CodingPlanSubscriptionServiceDependencies,
): ICodingPlanSubscriptionService {
  const bigmodelProvider = new BigModelCodingPlanSubscriptionProvider(dependencies);
  const zaiProvider = new ZaiCodingPlanSubscriptionProvider(dependencies);

  // 按 family 选择 enterprise 读路径 provider；缺省（含未指定 family 的历史调用）走 bigmodel。
  const resolveEnterprisePricingProvider = (
    family?: "bigmodel" | "zai",
  ): BigModelCodingPlanSubscriptionProvider => (family === "zai" ? zaiProvider : bigmodelProvider);

  return {
    batchPreview: (request) => bigmodelProvider.batchPreview(request),
    getStaticProducts: () => bigmodelProvider.getStaticProducts(),
    getStaticTeamProducts: () => bigmodelProvider.getStaticTeamProducts(),
    getStartPlanPreview: () => bigmodelProvider.getStartPlanPreview(),
    getManualClaimPlanPreviews: () => bigmodelProvider.getManualClaimPlanPreviews(),
    claimManualPlan: (request) => bigmodelProvider.claimManualPlan(request),
    getOffPeakClientConfig: (options) => bigmodelProvider.getOffPeakClientConfig(options),
    // 动态工作流灰度：与 client/configs 同源，
    // 因此和其它平台级配置一样固定走 bigmodel provider，与 family 无关。
    // 用户选择在这里套到「提供」上，renderer 读到的就是生效值；规则只写在 shared 的
    // applyDynamicWorkflowUserMode 里，renderer 不自己算。
    getDynamicWorkflowClientConfig: async (options) => {
      const offer = await bigmodelProvider.getDynamicWorkflowClientConfig(options);
      const resolveUserMode = dependencies.resolveDynamicWorkflowUserMode;
      return resolveUserMode ? applyDynamicWorkflowUserMode(offer, await resolveUserMode()) : offer;
    },
    getModelContextBudgetStrategy: () => bigmodelProvider.getModelContextBudgetStrategy(),
    getBillingDiscount: () => bigmodelProvider.getBillingDiscount(),
    getRequestVerificationConfig: () => bigmodelProvider.getRequestVerificationConfig(),
    getForceUpdateConfig: () => bigmodelProvider.getForceUpdateConfig(),
    productInfo: (request) => bigmodelProvider.productInfo(request),
    preview: (request) => bigmodelProvider.preview(request),
    createSign: (request) => bigmodelProvider.createSign(request),
    updateSign: (request) => bigmodelProvider.updateSign(request),
    checkPayment: (request) => bigmodelProvider.checkPayment(request),
    checkPendingOrders: (request) => bigmodelProvider.checkPendingOrders(request),
    queryStripeCards: (request) => bigmodelProvider.queryStripeCards(request),
    bindStripeCard: (request) => bigmodelProvider.bindStripeCard(request),
    unbindStripeCard: (request) => bigmodelProvider.unbindStripeCard(request),
    payStripe: (request) => bigmodelProvider.payStripe(request),
    checkPaypalSupport: (request) => bigmodelProvider.checkPaypalSupport(request),
    createPaypalSetupToken: (request) => bigmodelProvider.createPaypalSetupToken(request),
    subscribePaypal: (request) => bigmodelProvider.subscribePaypal(request),
    getEnterprisePricing: (request) =>
      resolveEnterprisePricingProvider(request?.family).getEnterprisePricing(request),
    getEnterpriseBalance: () => bigmodelProvider.getEnterpriseBalance(),
    calculateEnterpriseOrder: (request) => bigmodelProvider.calculateEnterpriseOrder(request),
    createEnterpriseOrder: (request) => bigmodelProvider.createEnterpriseOrder(request),
    getEnterprisePendingOrders: () => bigmodelProvider.getEnterprisePendingOrders(),
    cancelEnterpriseOrder: (request) => bigmodelProvider.cancelEnterpriseOrder(request),
    continueEnterpriseOrderPayment: (request) =>
      bigmodelProvider.continueEnterpriseOrderPayment(request),
    checkEnterpriseOrderStatus: (request) => bigmodelProvider.checkEnterpriseOrderStatus(request),
  };
}
