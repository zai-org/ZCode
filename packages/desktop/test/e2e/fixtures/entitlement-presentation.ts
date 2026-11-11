import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { buildProviderResponsiveStartBalance } from "./provider-family-responsive.js";

/** 专属展示夹具；不改变其他套餐 E2E 的默认响应。 */
export interface EntitlementPresentation {
  personal: "active" | "none";
  team: "active" | "none" | "expired" | "unassigned" | "failure";
  start: "active" | "none" | "expired" | "mixed" | "pending";
}

export function presentationResponse(path: string, state: EntitlementPresentation) {
  if (path === "/api/v1/client/configs") {
    const provider = BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
    return {
      code: 0,
      data: {
        configs: {
          startPlanPreview: {
            planId: "e2e-start-preview",
            name: "E2E_TRIAL_PROMO",
            entitlements: [
              {
                grantUnits: 8000000,
                meter: "model_usage",
                period: "daily",
                showName: "GLM-5.3",
                unitType: "token",
              },
            ],
          },
          codingPlanBillingDiscount: {
            "en-US": {
              cardTitle: "150% quota",
              cardBody: "Upgrade for 150% quota",
              badgeBody: "150% quota",
            },
          },
          codingPlanStaticProducts: {
            [provider]: [
              {
                productId: "personal-coding",
                productName: "Personal",
                priceCurrency: "CNY",
                priceUnit: "month",
                payAmount: 118,
              },
            ],
          },
          codingPlanStaticTeamProducts: {
            [provider]: [
              {
                productId: "product-team-a",
                productName: "Team",
                tier: "PRO",
                subscribeMode: "CONTINUOUS",
                subscribePeriod: "MONTHLY",
                purchaseMethodName: "Monthly",
                priceCurrency: "CNY",
                payAmount: 598,
              },
            ],
          },
        },
      },
    };
  }
  if (path === "/api/biz/subscription/enterprise/v2/pricing") {
    return {
      code: 200,
      data: {
        productList: [
          {
            productId: "product-team-a",
            productName: "Team",
            tier: "PRO",
            subscribeMode: "CONTINUOUS",
            subscribePeriod: "MONTHLY",
            purchaseMethodName: "Monthly",
            priceCurrency: "CNY",
            payAmount: 598,
            subscribed: true,
          },
        ],
      },
    };
  }
  if (path === "/api/biz/subscription/list") {
    return {
      code: 200,
      data:
        state.personal === "active"
          ? [
              {
                productId: "personal-coding",
                productName: "Coding Plan",
                inCurrentPeriod: true,
                status: "VALID",
              },
            ]
          : [],
    };
  }
  if (path === "/api/biz/team/subscribe/product/querySubscribeDetail") {
    if (state.team === "failure")
      return { code: 500, success: false, msg: "E2E_TEAM_ENTITLEMENT_FAILURE" };
    return {
      code: 200,
      success: true,
      data:
        state.team === "none"
          ? { hasSubscription: false }
          : {
              hasSubscription: true,
              status: state.team === "expired" ? "EXPIRED" : "EFFECTIVE",
              memberGrantStatus: state.team === "unassigned" ? "UNASSIGNED" : "VALID",
              productId: "product-team-a",
              productName: "Team Org",
              subscribeEndTime: "2027-08-25",
              subscribePeriod: "YEARLY",
            },
    };
  }
  if (path === "/api/v1/zcode-plan/billing/balance") {
    const result = buildProviderResponsiveStartBalance("GLM-5.3");
    if (state.start === "none")
      return { ...result, data: { ...result.data, plans: [], balances: [] } };
    if (state.start === "active") return result;
    const now = Math.floor(Date.now() / 1000);
    if (state.start === "pending") {
      // 待生效：套餐已存在（active）但权益 effective_at 在未来且暂无额度桶。
      // 账号侧会投影为 pending/entitled=false，设置页仍会读到同一份套餐详情。
      const pendingPlan = {
        ...result.data.plans[0],
        starts_at: now + 3600,
        ends_at: now + 86400,
        entitlements: [
          {
            entitlement_id: "e2e-pending-start-entitlement",
            effective_at: now + 3600,
            show_name: "GLM-5.3",
          },
        ],
      };
      return { ...result, data: { ...result.data, plans: [pendingPlan], balances: [] } };
    }
    const expiredPlan = {
      ...result.data.plans[0],
      plan_id: "e2e-expired-plan",
      name: "E2E_EXPIRED_PLAN",
      starts_at: now - 86400 * 3,
      ends_at: now - 86400,
    };
    const expiredBalance = {
      ...result.data.balances[0],
      plan_id: expiredPlan.plan_id,
      show_name: "E2E_EXPIRED_BALANCE",
      expires_at: now - 86400,
    };
    // JSON 时钟刻意仍在旧计划有效期内，HTTP Date 才是本轮权威时间。
    return {
      ...result,
      data: {
        server_time: now - 86400 * 2,
        plans: state.start === "mixed" ? [expiredPlan, ...result.data.plans] : [expiredPlan],
        balances:
          state.start === "mixed" ? [expiredBalance, ...result.data.balances] : [expiredBalance],
      },
    };
  }
  return undefined;
}
