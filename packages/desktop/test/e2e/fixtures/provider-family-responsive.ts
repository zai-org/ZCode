export const PROVIDER_RESPONSIVE_TEAM_NAME = "北京智谱华章科技股份有限公司";

// 用例专属业务数据：只提供有效体验权益，不发起真实购买或模型请求。
// GLM-5-Turbo 已退役，共享 Start balance 默认使用当前模型 GLM-5.3。
export function buildProviderResponsiveStartBalance(model = "GLM-5.3") {
  const now = Math.floor(Date.now() / 1000);
  const planId = "zcode-v3-start-plan";
  const entitlementId = "E2E_PROVIDER_RESPONSIVE_START";
  return {
    code: 0,
    success: true,
    msg: "ok",
    data: {
      server_time: now,
      plans: [
        {
          plan_id: planId,
          name: "ZCode V3 Start Plan",
          status: "active",
          starts_at: now - 86400,
          ends_at: now + 86400,
          entitlements: [{ entitlement_id: entitlementId, effective_at: 0, show_name: model }],
        },
      ],
      balances: [
        {
          plan_id: planId,
          entitlement_id: entitlementId,
          show_name: model,
          capabilities: [`model:${model.toLowerCase()}`],
          total_units: 1000000000,
          used_units: 0,
          remaining_units: 1000000000,
          available_units: 1000000000,
          expires_at: now + 86400,
        },
      ],
    },
  };
}
