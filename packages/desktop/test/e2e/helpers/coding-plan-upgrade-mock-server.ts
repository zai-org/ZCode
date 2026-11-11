import { requestSecurityClientConfig } from "./request-security-edition/index.js";
/* eslint-disable max-lines -- E2E fixture server 需要集中维护 ZCode client config 与 BigModel 购买接口响应 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { createMarketingTouchFixture } from "./marketing-touch-fixture.js";
import { rewardsWebsiteFixture } from "./rewards-website-fixture.js";

export type CodingPlanUpgradeMockScenario =
  | "manual-claim-experience"
  | "personal-sold-out"
  | "personal-system-busy"
  | "webview-refresh-provider";

export interface CodingPlanUpgradeMockRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  keyCreation?: { name?: unknown; usageScene?: unknown };
}

export interface CodingPlanUpgradeMockServer {
  baseUrl: string;
  scenario: CodingPlanUpgradeMockScenario;
  stop(): Promise<void>;
}

interface CodingPlanUpgradeMockState {
  associatedAuthMode: "off" | "ok" | "unauthorized" | "json-unauthorized" | "forbidden";
  associatedProfileHeld: boolean;
  associatedBusinessHeld: boolean;
  associatedBusinessWaiters: Array<() => void>;
  associatedProfileWaiters: Array<() => void>;
  webviewMode: "hold" | "fail" | "ready";
  webviewWaiters: Array<() => void>;
  highspeedHeld: boolean;
  highspeedOwnerRace: boolean;
  highspeedLifetimeMs: number;
  highspeedWaiters: Array<() => void>;
  subscriptionListHeld: boolean;
  subscriptionListWaiters: Array<() => void>;
  customerInfoHeld: boolean;
  customerInfoWaiters: Array<() => void>;
  inventoryMode: "hold" | "fail" | "ready";
  inventoryWaiters: Array<() => void>;
  clientConfigPayload: CodingPlanClientConfigFixture;
  manualClaimBucketReady: boolean;
  manualClaimCompleted: boolean;
  manualClaimShouldFail: boolean;
  startPlanExpired: boolean;
  purchaseCompleted: boolean;
  scenario: CodingPlanUpgradeMockScenario;
}

const DEFAULT_FULL_E2E_SPEC_GLOB = "./test/e2e/**/*.test.ts";

export function resolveCodingPlanUpgradeMockScenario(
  specs: readonly string[],
): CodingPlanUpgradeMockScenario | null {
  if (specs.some((spec) => spec.includes("marketing-touch-"))) {
    return "manual-claim-experience";
  }
  if (specs.some((spec) => spec.includes("coding-plan-upgrade-personal-system-busy"))) {
    return "personal-system-busy";
  }
  if (specs.some((spec) => spec.includes("coding-plan-upgrade-personal-sold-out"))) {
    return "personal-sold-out";
  }
  if (
    specs.some(
      (spec) =>
        spec.includes("coding-plan-upgrade-webview-refresh-provider") ||
        spec.includes("account-key-usage-scene") ||
        spec.includes("highspeed-owner-ui-race.test.ts"),
    )
  ) {
    return "webview-refresh-provider";
  }
  return null;
}

export function shouldPrepareCodingPlanUpgradeMockForBuild(specs: readonly string[]): boolean {
  return (
    resolveCodingPlanUpgradeMockScenario(specs) !== null ||
    specs.some((spec) => spec.replace(/\\/gu, "/") === DEFAULT_FULL_E2E_SPEC_GLOB)
  );
}

export async function resetCodingPlanUpgradeMockServer(
  baseUrl: string,
  scenario: CodingPlanUpgradeMockScenario,
  options: { marketingTouch?: boolean } = {},
): Promise<void> {
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/reset`, {
    body: JSON.stringify({ scenario, marketingTouch: options.marketingTouch === true }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `Coding Plan E2E mock reset failed: ${response.status} ${await response.text()}`,
    );
  }
}

export async function startCodingPlanUpgradeMockServer(
  scenario: CodingPlanUpgradeMockScenario,
  options: { marketingTouch?: boolean } = {},
): Promise<CodingPlanUpgradeMockServer> {
  // 修复原因：pnpm filter 会把 E2E cwd 切到 packages/desktop，不能用 cwd 定位仓库级 fixture。
  const clientConfigFixtureUrl = new URL(
    "../fixtures/coding-plan-client-configs.json",
    import.meta.url,
  );
  const baseClientConfigPayload = JSON.parse(
    await readFile(clientConfigFixtureUrl, "utf8"),
  ) as CodingPlanClientConfigFixture;
  const requests: CodingPlanUpgradeMockRequest[] = [];
  const state = createCodingPlanUpgradeMockState(baseClientConfigPayload, scenario);
  // 同套餐场景也供旧测试复用，不能隐式注入需要 release 的营销领取暂停。
  let marketing = options.marketingTouch ? await createMarketingTouchFixture() : null;
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "POST" && pathname === "/__e2e/coding-plan/reset") {
        const payload = await readJsonBody<{ scenario?: unknown; marketingTouch?: boolean }>(
          request,
        );
        if (!isCodingPlanUpgradeMockScenario(payload.scenario)) {
          sendJson(response, { code: 400, msg: "Invalid Coding Plan E2E scenario" }, 400);
          return;
        }
        // 混合 suite 复用构建时的 origin；营销开关和投放也必须按 worker 重置，否则弹窗会遮挡购买入口。
        const nextMarketing = payload.marketingTouch ? await createMarketingTouchFixture() : null;
        marketing?.stop();
        marketing = nextMarketing;
        state.webviewWaiters.splice(0).forEach((release) => release());
        state.customerInfoWaiters.splice(0).forEach((release) => release());
        state.subscriptionListWaiters.splice(0).forEach((release) => release());
        state.highspeedWaiters.splice(0).forEach((release) => release());
        state.associatedProfileWaiters.splice(0).forEach((release) => release());
        state.associatedBusinessWaiters.splice(0).forEach((release) => release());
        state.inventoryWaiters.splice(0).forEach((release) => release());
        Object.assign(
          state,
          createCodingPlanUpgradeMockState(baseClientConfigPayload, payload.scenario),
        );
        requests.splice(0, requests.length);
        sendJson(response, { ok: true, scenario: state.scenario });
        return;
      }
      if (marketing && /^\/(cn|en)\/rewards$/.test(pathname)) {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(rewardsWebsiteFixture);
        return;
      }
      if (await marketing?.handle(request, response)) return;
      if (!marketing && pathname === "/api/v1/marketing/touch") {
        sendJson(response, {
          code: 0,
          data: {
            server_time: Math.floor(Date.now() / 1000),
            language: request.headers["x-client-language"] === "zh-CN" ? "zh-CN" : "en-US",
            deliveries: [],
          },
        });
        return;
      }
      await handleRequest(state, requests, request, response, marketing !== null);
    })().catch((error) => {
      if (!response.headersSent) {
        sendJson(response, { code: 500, msg: formatErrorMessage(error) }, 500);
        return;
      }
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Coding Plan E2E mock server did not bind to a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get scenario() {
      return state.scenario;
    },
    stop: async () => {
      marketing?.stop();
      state.webviewWaiters.splice(0).forEach((release) => release());
      state.customerInfoWaiters.splice(0).forEach((release) => release());
      state.subscriptionListWaiters.splice(0).forEach((release) => release());
      state.highspeedWaiters.splice(0).forEach((release) => release());
      state.associatedProfileWaiters.splice(0).forEach((release) => release());
      state.associatedBusinessWaiters.splice(0).forEach((release) => release());
      state.inventoryWaiters.splice(0).forEach((release) => release());
      server.close();
      await once(server, "close");
    },
  };
}

async function handleRequest(
  state: CodingPlanUpgradeMockState,
  requests: CodingPlanUpgradeMockRequest[],
  request: IncomingMessage,
  response: ServerResponse,
  marketingTouch: boolean,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/__e2e/coding-plan/webview-state") {
    sendJson(response, { pending: state.webviewWaiters.length });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/webview-mode") {
    const { mode } = await readJsonBody<{ mode: "hold" | "fail" | "ready" }>(request);
    state.webviewMode = mode;
    state.webviewWaiters.splice(0).forEach((release) => release());
    sendJson(response, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/associated-auth") {
    const body = await readJsonBody<{
      mode: CodingPlanUpgradeMockState["associatedAuthMode"];
      held: boolean;
      businessHeld?: boolean;
    }>(request);
    state.associatedAuthMode = body.mode;
    state.associatedProfileHeld = body.held;
    state.associatedBusinessHeld = body.businessHeld ?? false;
    if (!state.associatedBusinessHeld)
      state.associatedBusinessWaiters.splice(0).forEach((release) => release());
    if (!body.held) state.associatedProfileWaiters.splice(0).forEach((release) => release());
    sendJson(response, { ok: true });
    return;
  }
  if (
    request.method === "GET" &&
    url.pathname === "/api/biz/pay/check-pending-orders" &&
    state.associatedAuthMode !== "off"
  ) {
    recordRequest(requests, request, url);
    const status =
      state.associatedAuthMode === "unauthorized"
        ? 401
        : state.associatedAuthMode === "forbidden"
          ? 403
          : 200;
    const code = state.associatedAuthMode === "json-unauthorized" ? 401 : status;
    if (state.associatedBusinessHeld)
      await new Promise<void>((resolve) => state.associatedBusinessWaiters.push(resolve));
    sendJson(
      response,
      {
        code,
        msg: status === 200 ? "ok" : "rejected",
        data: status === 200 ? { hasPendingOrders: false } : null,
      },
      status,
    );
    return;
  }
  if (
    request.method === "GET" &&
    url.pathname === "/api/v1/oauth/profile" &&
    request.headers.authorization === "Bearer e2e-expiring-primary" &&
    state.associatedAuthMode !== "off"
  ) {
    recordRequest(requests, request, url);
    if (state.associatedProfileHeld)
      await new Promise<void>((resolve) => state.associatedProfileWaiters.push(resolve));
    sendJson(response, {
      code: 0,
      data: {
        user: { user_id: "e2e-expiring-user", name: "Associated" },
        bigmodel: { customer_id: "e2e-user", access_token: "e2e-renewed-business" },
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/__e2e/coding-plan/requests") {
    sendJson(response, { requests });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/subscription-list-hold") {
    const { held } = await readJsonBody<{ held: boolean }>(request);
    state.subscriptionListHeld = held;
    if (!held) state.subscriptionListWaiters.splice(0).forEach((release) => release());
    sendJson(response, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/highspeed-hold") {
    const { held } = await readJsonBody<{ held: boolean }>(request);
    state.highspeedHeld = held;
    if (!held) state.highspeedWaiters.splice(0).forEach((release) => release());
    sendJson(response, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/highspeed-owner-race") {
    state.highspeedOwnerRace = true;
    state.highspeedLifetimeMs = 5_000;
    state.highspeedHeld = true;
    // draw 正常返回，只挂起 healthy。按 FIFO 单独释放旧响应，保留新请求占位。
    sendJson(response, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/highspeed-release-one") {
    const release = state.highspeedWaiters.shift();
    release?.();
    sendJson(response, { released: !!release });
    return;
  }
  if (state.highspeedOwnerRace && url.pathname === "/api/v1/oauth/cli/init") {
    sendJson(response, {
      code: 0,
      data: {
        flow_id: "owner-ui-relogin",
        authorize_url: "https://example.com/authorize?state=owner-ui-relogin",
        expires_at: Math.floor(Date.now() / 1000) + 300,
        poll_interval_sec: 1,
      },
    });
    return;
  }
  if (state.highspeedOwnerRace && url.pathname === "/api/v1/oauth/cli/poll/owner-ui-relogin") {
    sendJson(response, {
      code: 0,
      data: {
        status: "ready",
        token: "e2e-owner-new-primary",
        user: { user_id: "e2e-owner-user", name: "Owner User" },
        zai: { access_token: "e2e-owner-cn-upstream" },
        bigmodel: { customer_id: "e2e-user", access_token: "e2e-linked-bigmodel-jwt" },
      },
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/customer-info-hold") {
    const { held } = await readJsonBody<{ held: boolean }>(request);
    state.customerInfoHeld = held;
    if (!held) state.customerInfoWaiters.splice(0).forEach((release) => release());
    sendJson(response, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/inventory-mode") {
    const { mode } = await readJsonBody<{ mode: "hold" | "fail" | "ready" }>(request);
    state.inventoryMode = mode;
    state.inventoryWaiters.splice(0).forEach((release) => release());
    sendJson(response, { ok: true });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/__e2e/coding-plan/manual-claim-failure" &&
    state.scenario === "manual-claim-experience"
  ) {
    state.manualClaimShouldFail = true;
    sendJson(response, { ok: true });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/__e2e/coding-plan/manual-claim-bucket-ready" &&
    state.scenario === "manual-claim-experience"
  ) {
    state.manualClaimBucketReady = true;
    sendJson(response, { ok: true });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/__e2e/coding-plan/manual-claim-next-window" &&
    state.scenario === "manual-claim-experience"
  ) {
    // Bug 原因：下一时段只重置 completed 会让失败用例的一次性开关泄漏到后续成功用例。
    state.manualClaimCompleted = false;
    state.manualClaimShouldFail = false;
    sendJson(response, { ok: true });
    return;
  }

  const recordedRequest = recordRequest(requests, request, url);

  if (
    request.method === "POST" &&
    url.pathname === "/__e2e/coding-plan/start-expired" &&
    state.scenario === "manual-claim-experience"
  ) {
    state.startPlanExpired = true;
    sendJson(response, { ok: true });
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/v1/zcode-plan/billing/preview" &&
    state.scenario === "manual-claim-experience"
  ) {
    sendJson(response, {
      code: 0,
      msg: "ok",
      data: {
        server_time: Math.floor(Date.now() / 1_000),
        plans: state.manualClaimCompleted
          ? []
          : [
              {
                plan_id: "weekend-plan-e2e",
                name: "ZCode Weekend Build",
                description: "Deterministic manual claim fixture",
                priority: 100,
                entitlements: [
                  {
                    entitlement_id: "weekend-glm-flash",
                    show_name: "GLM-5.3-Flash",
                    meter: "model_usage",
                    unit_type: "token",
                    capabilities: ["model:glm-5.3-flash"],
                    grant_units: 10_000_000_000,
                    period: "one_time",
                    priority: 10,
                  },
                ],
              },
            ],
      },
    });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/v1/zcode-plan/billing/claim" &&
    state.scenario === "manual-claim-experience"
  ) {
    if (state.manualClaimShouldFail) {
      state.manualClaimShouldFail = false;
      state.manualClaimCompleted = true;
      sendJson(response, { code: 1003, data: null, msg: "already claimed" });
      return;
    }
    state.manualClaimCompleted = true;
    const nowSeconds = Math.floor(Date.now() / 1_000);
    sendJson(response, {
      code: 0,
      msg: "ok",
      data: {
        server_time: nowSeconds,
        plan: {
          user_plan_id: "user-weekend-plan-e2e",
          plan_id: "weekend-plan-e2e",
          status: "active",
          starts_at: nowSeconds,
          ends_at: nowSeconds + 86_400,
          entitlements: [
            {
              entitlement_id: "weekend-glm-flash",
              show_name: "GLM-5.3-Flash",
              effective_at: nowSeconds + 3_600,
            },
          ],
        },
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/coding-plan") {
    if (state.webviewMode === "hold")
      await new Promise<void>((resolve) => state.webviewWaiters.push(resolve));
    if (state.webviewMode === "fail") {
      response.destroy();
      return;
    }
    sendHtml(response, buildCodingPlanWebviewFixtureHtml(state.scenario));
    return;
  }

  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/purchase-complete") {
    state.purchaseCompleted = true;
    sendJson(response, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v2/releases/latest") {
    sendJson(response, {
      code: 0,
      data: { config_version: "coding-plan-upgrade-e2e" },
      config_version: "coding-plan-upgrade-e2e",
    });
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/v1/oauth/profile" &&
    request.headers.authorization === "Bearer e2e-association-upgrade-jwt"
  ) {
    sendJson(response, {
      code: 0,
      data: {
        user: { user_id: "e2e-association-user", name: "Associated User" },
        bigmodel: { customer_id: "e2e-user", access_token: "e2e-associated-ui-bigmodel-jwt" },
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/client/configs") {
    sendJson(response, state.clientConfigPayload);
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/v1/zcode-plan/billing/balance" &&
    (state.scenario === "manual-claim-experience" || state.scenario === "webview-refresh-provider")
  ) {
    // Bug 原因：领取 fixture 只 mock 了旧 quota 接口；当前 Start 可用性以
    // billing/balance 为准，缺失时刷新会把刚写入的 Start selectedKey 收敛回 Individual。
    sendJson(
      response,
      state.startPlanExpired
        ? {
            code: 0,
            msg: "ok",
            data: {
              server_time: Math.floor(Date.now() / 1000),
              plans: [],
              balances: [],
            },
          }
        : buildManualClaimStartPlanBalance(
            state.manualClaimCompleted,
            state.manualClaimBucketReady,
          ),
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/biz/pay/batch-preview") {
    if (state.scenario === "personal-system-busy") {
      // 修复原因：系统繁忙是接口整体失败语义，不能伪造成商品售罄。
      // 服务层会把 WAF/HTML 类不可展示响应收敛成 coding_plan_system_busy，再交给 UI 本地化。
      sendJson(response, {
        code: 503,
        msg: "<html>request has been blocked</html>",
        data: null,
      });
      return;
    }
    const personalProducts =
      state.clientConfigPayload.data.configs.codingPlanStaticProducts[
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
      ] ?? [];
    sendJson(response, {
      code: 200,
      data: {
        isAuthenticated: true,
        isSubscribed: false,
        productList: personalProducts.map((product) => ({
          ...product,
          canPurchase: false,
          soldOut: true,
        })),
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/monitor/usage/quota/limit") {
    if (state.scenario === "webview-refresh-provider") {
      sendJson(response, { code: 200, data: { level: "pro", limits: [] } });
      return;
    }
    if (state.scenario === "manual-claim-experience") {
      const nowSeconds = Math.floor(Date.now() / 1_000);
      sendJson(response, {
        code: 0,
        msg: "ok",
        data: {
          plans: [
            {
              plan_id: "weekend-plan-e2e",
              name: "ZCode Weekend Build",
              status: "active",
              starts_at: nowSeconds,
              ends_at: nowSeconds + 86_400,
              entitlements: [{ meter: "model_usage", period: "one_time" }],
            },
          ],
          balances: [
            {
              plan_id: "weekend-plan-e2e",
              entitlement_id: "weekend-glm-flash",
              show_name: "GLM-5.3-Flash",
              capabilities: ["model:glm-5.3-flash"],
              total_units: 10_000_000_000,
              used_units: 0,
              remaining_units: 10_000_000_000,
              available_units: 10_000_000_000,
              expires_at: nowSeconds + 86_400,
            },
          ],
        },
      });
      return;
    }
    // 修复原因：sidebar 升级入口通过 entitlement 判断账号是已连接但未开通套餐；
    // mock 必须用 HTTP 200 承载业务 no_plan，否则 readApiJson 会提前抛错，
    // 购买面板会被当成不可用账号并跳过 batch-preview。
    sendJson(response, {
      code: 404,
      msg: "当前用户不存在coding plan",
      data: null,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/biz/subscription/list") {
    if (state.subscriptionListHeld)
      await new Promise<void>((resolve) => state.subscriptionListWaiters.push(resolve));
    sendJson(response, {
      code: 200,
      data:
        state.scenario === "webview-refresh-provider" ||
        (state.scenario === "manual-claim-experience" && state.manualClaimCompleted)
          ? [
              {
                productId: "glm-coding-pro-e2e",
                productName: "GLM Coding Pro",
                status: "VALID",
                inCurrentPeriod: true,
              },
            ]
          : [],
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/biz/customer/getCustomerInfo") {
    if (request.headers.authorization === "e2e-legacy-migration-business") {
      sendJson(response, {
        code: 200,
        data: { customerNumber: "e2e-business-customer", customerName: "Legacy Business Profile" },
      });
      return;
    }
    // 将单卡 provider 同步停在网络边界，验证全局查询已完成后的 Subscribe 加载反馈。
    if (state.customerInfoHeld) {
      await new Promise<void>((resolve) => state.customerInfoWaiters.push(resolve));
    }
    sendJson(response, {
      code: 200,
      data:
        state.purchaseCompleted ||
        // 营销升级先查询全部连接的权益；没有项目凭据会停在 unknown，无法打开升级页。
        // 只补可查询项目，不把“尚未领取”伪造成已有订阅。
        marketingTouch ||
        // 无套餐仍需可查询的项目凭据；空项目会让 Account State 变为 unknown，遮蔽订阅入口。
        state.scenario === "personal-sold-out" ||
        state.scenario === "personal-system-busy" ||
        // 当前账号服务通过组织/项目取得凭据；库存场景购买前已经拥有个人套餐，不能只伪造订阅列表。
        state.scenario === "webview-refresh-provider" ||
        (state.scenario === "manual-claim-experience" && state.manualClaimCompleted)
          ? {
              organizations: [
                {
                  organizationId: "org-e2e",
                  projects: [{ projectId: "proj-e2e", projectType: 0 }],
                },
              ],
            }
          : { organizations: [] },
    });
    return;
  }

  if (
    (request.method === "GET" || request.method === "POST") &&
    url.pathname === "/api/biz/v1/organization/org-e2e/projects/proj-e2e/api_keys"
  ) {
    if (request.method === "POST" && recordedRequest) {
      // 仅记录创建用途与名称，不把可能含凭据的任意请求体写入 E2E ledger。
      const { name, usageScene } = await readJsonBody<{
        name?: unknown;
        usageScene?: unknown;
      }>(request);
      recordedRequest.keyCreation = { name, usageScene };
    }
    sendJson(response, {
      code: 200,
      data: !state.purchaseCompleted
        ? request.method === "GET"
          ? [{ name: "zcode", apiKey: "bigmodel-personal-api-key" }]
          : { name: "zcode", apiKey: "bigmodel-personal-api-key" }
        : request.method === "GET"
          ? [{ name: "zcode", apiKey: "bigmodel-webview-refreshed-key" }]
          : { name: "zcode", apiKey: "bigmodel-webview-refreshed-key" },
    });
    return;
  }

  if (
    request.method === "POST" &&
    /^\/api\/biz\/v1\/organization\/org-e2e\/projects\/proj-e2e\/api_keys\/[^/]+\/access_tokens$/.test(
      url.pathname,
    )
  ) {
    const body = await readJsonBody<{ clientType?: string }>(request);
    if (body.clientType !== "zcode" || !request.headers.authorization?.startsWith("Bearer ")) {
      sendJson(response, { code: 400, msg: "invalid_token_request" });
      return;
    }
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${encode({ token_use: "project_access", api_key: "e2e-key", exp: Math.floor(Date.now() / 1000) + 600 })}.e2e-signature`;
    sendJson(response, {
      code: 200,
      data: {
        enable: true,
        accessToken: token,
        tokenType: "Bearer",
        expiresIn: 600,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      },
    });
    return;
  }

  if (
    request.method === "GET" &&
    (url.pathname ===
      "/api/biz/v1/organization/org-e2e/projects/proj-e2e/api_keys/copy/bigmodel-webview-refreshed-key" ||
      url.pathname ===
        "/api/biz/v1/organization/org-e2e/projects/proj-e2e/api_keys/copy/bigmodel-personal-api-key")
  ) {
    sendJson(response, {
      code: 200,
      // Bug 原因：Z.ai 的 resolver 需要 copy secret，但 BigModel 的 apiKey 本身已是
      // 完整凭据。fixture 若无条件返回 Z.ai secret，会把 BigModel key 错拼成 key.secret。
      data: {
        secretKey:
          request.headers.authorization === "Bearer zai-webview-oauth-token"
            ? "zai-webview-refreshed-secret"
            : "",
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/off-peak/ticket/availability") {
    sendJson(response, { can_take_number: true });
    return;
  }
  if (state.highspeedOwnerRace && url.pathname === "/api/monitor/usage/model-performance-day") {
    sendJson(response, { code: 200, data: { proMaxDecodeSpeed: [25] } });
    return;
  }
  if (
    request.method === "GET" &&
    url.pathname === "/api/v1/highspeed/e2e-linked-highspeed/healthy"
  ) {
    if (state.highspeedHeld)
      await new Promise<void>((resolve) => state.highspeedWaiters.push(resolve));
    sendJson(response, {
      code: 0,
      msg: "ok",
      data: {
        card_id: "e2e-linked-highspeed",
        prompt_tokens: 1,
        completion_tokens: 100,
        duration_seconds: 2,
      },
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/highspeed/draw") {
    const body = await readJsonBody<{ task_id: string; provider: string; model: string }>(request);
    if (state.highspeedHeld && !state.highspeedOwnerRace)
      await new Promise<void>((resolve) => state.highspeedWaiters.push(resolve));
    sendJson(response, {
      code: 0,
      msg: "ok",
      data: {
        card: {
          card_id: "e2e-linked-highspeed",
          task_id: body.task_id,
          provider: body.provider,
          model: body.model,
          issued_at: Date.now(),
          expires_at: Date.now() + state.highspeedLifetimeMs,
        },
        next_draw_at: Date.now() + 60_000,
      },
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/coding-plan/reset/status") {
    sendJson(response, {
      code: 0,
      data: {
        available_five_hour_resets: [],
        available_week_resets: [],
        latest_five_hour_reset_history: null,
        latest_week_reset_history: null,
        has_unread_history: false,
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/mcp/usage") {
    sendJson(response, {
      code: 0,
      data: {
        server_time: Math.floor(Date.now() / 1000),
        total_usage: { used: 1, limit: 100, remaining: 99 },
      },
    });
    return;
  }

  if (
    request.method === "GET" &&
    (url.pathname === "/api/biz/subscription/enterprise/v2/pricing" ||
      url.pathname === "/api/biz/campaign/partner/enterprise/pricing")
  ) {
    if (url.pathname === "/api/biz/subscription/enterprise/v2/pricing") {
      if (state.inventoryMode === "hold")
        await new Promise<void>((resolve) => state.inventoryWaiters.push(resolve));
      if (state.inventoryMode === "fail") {
        sendJson(response, { code: 503, msg: "inventory unavailable" }, 503);
        return;
      }
    }
    sendJson(response, { code: 200, data: { productList: [] } });
    return;
  }

  sendJson(
    response,
    {
      code: 404,
      msg: `Unhandled E2E mock path: ${request.method} ${url.pathname}`,
    },
    404,
  );
}

function createCodingPlanUpgradeMockState(
  basePayload: CodingPlanClientConfigFixture,
  scenario: CodingPlanUpgradeMockScenario,
): CodingPlanUpgradeMockState {
  const clientConfigPayload = structuredClone(basePayload);
  enrichClientConfigPayloadForUpgradeE2E(clientConfigPayload, scenario);
  return {
    clientConfigPayload,
    manualClaimBucketReady: false,
    manualClaimCompleted: false,
    manualClaimShouldFail: false,
    startPlanExpired: false,
    highspeedHeld: false,
    highspeedOwnerRace: false,
    highspeedLifetimeMs: 60_000,
    highspeedWaiters: [],
    associatedAuthMode: "off",
    associatedProfileHeld: false,
    associatedBusinessHeld: false,
    associatedBusinessWaiters: [],
    associatedProfileWaiters: [],
    subscriptionListHeld: false,
    subscriptionListWaiters: [],
    customerInfoHeld: false,
    customerInfoWaiters: [],
    inventoryMode: "ready",
    webviewMode: "ready",
    webviewWaiters: [],
    inventoryWaiters: [],
    purchaseCompleted: false,
    scenario,
  };
}

function buildManualClaimStartPlanBalance(claimed: boolean, newBucketReady: boolean) {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const oldPlanId = "zcode-v3-start-plan";
  const newPlanId = "weekend-plan-e2e";
  const oldPlan = {
    ends_at: nowSeconds + 4 * 86_400,
    entitlements: [
      {
        effective_at: 0,
        entitlement_id: "start-glm-turbo-e2e",
        show_name: "GLM-5-Turbo",
      },
    ],
    name: "ZCode V3 Start Plan",
    plan_id: oldPlanId,
    starts_at: nowSeconds - 86_400,
    status: "active",
  };
  const oldBalance = {
    available_units: 1_000_000_000,
    capabilities: ["model:glm-5-turbo"],
    entitlement_id: "start-glm-turbo-e2e",
    expires_at: nowSeconds + 4 * 86_400,
    plan_id: oldPlanId,
    remaining_units: 500_000_000,
    show_name: "GLM-5-Turbo",
    total_units: 1_000_000_000,
    used_units: 500_000_000,
  };
  const newPlan = {
    ends_at: nowSeconds + 86_400,
    entitlements: [
      {
        // 已到达排期时间但额度桶尚未生成，驱动设置页显示「刷新权益」。
        effective_at: nowSeconds - 60,
        entitlement_id: "weekend-glm-flash",
        show_name: "GLM-5.3-Flash",
      },
    ],
    name: "ZCode Weekend Build",
    plan_id: newPlanId,
    starts_at: nowSeconds - 60,
    status: "active",
  };
  const newBalance = {
    available_units: 10_000_000_000,
    capabilities: ["model:glm-5.3-flash"],
    entitlement_id: "weekend-glm-flash",
    expires_at: nowSeconds + 86_400,
    plan_id: newPlanId,
    remaining_units: 10_000_000_000,
    show_name: "GLM-5.3-Flash",
    total_units: 10_000_000_000,
    used_units: 0,
  };
  return {
    code: 0,
    data: {
      server_time: nowSeconds,
      balances: [oldBalance, ...(claimed && newBucketReady ? [newBalance] : [])],
      plans: [oldPlan, ...(claimed ? [newPlan] : [])],
    },
    msg: "ok",
    success: true,
  };
}

function isCodingPlanUpgradeMockScenario(value: unknown): value is CodingPlanUpgradeMockScenario {
  return (
    value === "manual-claim-experience" ||
    value === "personal-sold-out" ||
    value === "personal-system-busy" ||
    value === "webview-refresh-provider"
  );
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

interface CodingPlanClientConfigFixture {
  data: {
    builtinProviders?: Array<{
      id?: string;
      name?: string;
      schema?: string;
      baseUrl?: string;
      models?: string[];
    }>;
    builtinModels?: Array<{
      modelId: string;
      name?: string;
      contextWindow?: number;
      maxCompletionTokens?: number;
      priority?: number;
    }>;
    configs: {
      codingPlanStaticProducts: Partial<
        Record<
          string,
          Array<{
            productId: string;
            productName: string;
            priceUnit: "month" | "quarter" | "year";
            payAmount?: number;
          }>
        >
      >;
    };
  };
}

function enrichClientConfigPayloadForUpgradeE2E(
  payload: CodingPlanClientConfigFixture,
  scenario: CodingPlanUpgradeMockScenario,
) {
  if (scenario === "manual-claim-experience") {
    // Bug 原因：领取 fixture 需要同时下发 Individual 与 Start；且 BigModel OAuth
    // resolver 会从同 family 的远端列表选择首个 Anthropic provider，Individual 必须排在前面，
    // 否则会把 Start 模型错误复用到 Individual，无法覆盖真实切换链路。
    payload.data.builtinProviders = [
      {
        id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
        name: "BigModel - Coding Plan",
        schema: "anthropic",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        models: ["GLM-5.3-Flash"],
      },
      {
        id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
        name: "BigModel - Start Plan",
        schema: "anthropic",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        models: ["GLM-5.3-Flash", "GLM-5-Turbo"],
      },
    ];
    payload.data.builtinModels = [
      {
        modelId: "GLM-5-Turbo",
        name: "GLM-5-Turbo",
        contextWindow: 1_048_576,
        maxCompletionTokens: 131_072,
        priority: 101,
      },
      {
        modelId: "GLM-5.3-Flash",
        name: "GLM-5.3-Flash",
        contextWindow: 1_048_576,
        maxCompletionTokens: 131_072,
        priority: 100,
      },
    ];
    Object.assign(payload.data.configs, requestSecurityClientConfig());
    return;
  }
  if (scenario !== "webview-refresh-provider") {
    return;
  }
  payload.data.builtinProviders = [
    {
      id: "bigmodel",
      name: "BigModel - Coding Plan",
      schema: "anthropic",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      models: ["glm-5.1-highspeed"],
    },
    {
      id: "zai",
      name: "Z.ai - Coding Plan",
      schema: "anthropic",
      baseUrl: "https://api.z.ai/api/anthropic",
      models: ["glm-5.1-highspeed"],
    },
  ];
}

function buildCodingPlanWebviewFixtureHtml(scenario: CodingPlanUpgradeMockScenario): string {
  const label =
    scenario === "personal-system-busy"
      ? "System busy"
      : scenario === "personal-sold-out"
        ? "Sold out"
        : "Complete purchase";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Coding Plan E2E</title>
  </head>
  <body>
    <main data-testid="coding-plan-webview-fixture">
      <h1>Coding Plan E2E</h1>
      <button id="complete" type="button">${label}</button>
    </main>
    <script>
      document.getElementById("complete").addEventListener("click", async () => {
        await fetch("/__e2e/coding-plan/purchase-complete", {
          method: "POST",
          keepalive: true
        });
        window.zcodeBridge.notifyPurchaseComplete({
          provider: "bigmodel",
          timestamp: Date.now()
        });
      });
    </script>
  </body>
</html>`;
}

function recordRequest(
  requests: CodingPlanUpgradeMockRequest[],
  request: IncomingMessage,
  url: URL,
) {
  if (url.pathname === "/__e2e/coding-plan/requests") {
    return;
  }
  const recorded: CodingPlanUpgradeMockRequest = {
    method: request.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: Object.fromEntries(
      Object.entries(request.headers).flatMap(([key, value]) => {
        if (Array.isArray(value)) return [[key, value.join(",")]];
        return typeof value === "string" ? [[key, value]] : [];
      }),
    ),
  };
  requests.push(recorded);
  return recorded;
}

function sendHtml(response: ServerResponse, html: string) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

function sendJson(response: ServerResponse, payload: unknown, statusCode = 200) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}
