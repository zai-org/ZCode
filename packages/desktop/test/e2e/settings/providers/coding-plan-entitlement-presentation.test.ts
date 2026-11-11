import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  TID_MODEL_PROVIDER_ADD_MODEL_BUTTON,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  clickTestIdByDom,
  getE2EAppDataPaths,
  quitElectronAppGracefully,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import type { EntitlementPresentation } from "#e2e/fixtures/entitlement-presentation";

const paths = getE2EAppDataPaths();
const base = () => {
  const value = process.env.ZCODE_CODING_PLAN_TEAM_MOCK_BASE_URL;
  if (!value) throw new Error("missing business mock");
  return value;
};
const empty: EntitlementPresentation = {
  personal: "none",
  team: "none",
  start: "none",
};
async function scenario(presentation: EntitlementPresentation) {
  const response = await fetch(`${base()}/__e2e/coding-plan/scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: "both", presentation }),
  });
  if (!response.ok) throw new Error(`scenario failed: ${response.status}`);
}
async function prepare(
  state: EntitlementPresentation,
  selection: "personal" | "team" | "start",
  connected = true,
) {
  await browser.execute(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("zcode:usage-entitlement:")) localStorage.removeItem(key);
    }
  });
  await quitElectronAppGracefully();
  await scenario(state);
  await writeFile(
    paths.credentialsFile,
    JSON.stringify({
      "oauth:active_provider": connected ? "bigmodel" : "",
      "oauth:bigmodel:access_token": connected ? "e2e-bigmodel-oauth-token" : "",
      "oauth:bigmodel:user_info": connected
        ? JSON.stringify({
            id: "bigmodel-e2e-user",
            displayName: "BigModel E2E",
            username: "bigmodel-e2e-user",
          })
        : "",
      zcodejwttoken: connected ? "e2e-zcode-jwt" : "",
    }),
  );
  const file = join(paths.appDataDir, "setting.json");
  const settings = JSON.parse(await readFile(file, "utf8"));
  await writeFile(
    file,
    JSON.stringify({
      ...settings,
      locale: "en-US",
      localePreference: "en-US",
      providerFamilyDomain: "bigmodel",
      providerFamilyDomainMigrated: true,
      providerFamilyConnectionSelections: {
        bigmodel:
          selection === "team"
            ? {
                kind: "team-coding-plan",
                // 模拟保存的商品与当前订阅不同，但团队组织/项目未变的启动恢复。
                productId: "product-team-previous",
                organizationId: "org-team-a",
                projectId: "proj-team-a",
              }
            : {
                kind: selection === "start" ? "start-plan" : "individual-coding-plan",
              },
      },
      lastWorkspaceSession: [
        {
          kind: "local",
          workspacePath: DEFAULT_WORKSPACE,
          workspacePurpose: "project",
        },
      ],
      lastActiveTabIndex: 0,
    }),
  );
  await browser.reloadSession();
  await skipOccupationOnboardingIfPresent();
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);
  await browser.keys("Escape");
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
  const key = `${selection === "start" ? "coding-plan" : "preset"}:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`;
  await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, key));
}
async function textVisible(text: string, present = true) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (expected, wanted) => {
          const nodes = Array.from(document.querySelectorAll("body *"));
          const found = nodes.some(
            (node) =>
              Array.from(node.childNodes)
                .filter((child) => child.nodeType === Node.TEXT_NODE)
                .map((child) => child.textContent)
                .join(" ")
                .includes(expected) && node.getBoundingClientRect().width > 0,
          );
          return Boolean(found) === wanted;
        },
        text,
        present,
      ),
    { timeout: 20000, timeoutMsg: `${present ? "缺少" : "不应显示"}: ${text}` },
  );
}
async function models(present: boolean) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (wanted, id) => {
          const button = document.querySelector(`[data-testid="${id}"]`);
          return Boolean(button && button.getBoundingClientRect().width > 0) === wanted;
        },
        present,
        TID_MODEL_PROVIDER_ADD_MODEL_BUTTON,
      ),
    { timeout: 20000, timeoutMsg: `模型列表显隐错误: ${present}` },
  );
  await textVisible("Model list", present);
}
async function banners(present: boolean) {
  // 描述只属于购买横幅，避免和连接方式菜单里的同名选项混淆。
  await textVisible("dedicated Coding Plan quota", present);
  await textVisible("centralized billing", present);
  await textVisible("E2E_TRIAL_PROMO", false);
}
async function requests() {
  return (await (await fetch(`${base()}/__e2e/coding-plan/requests`)).json()).requests as Array<{
    path: string;
    headers: Record<string, string>;
  }>;
}

describe("套餐权益展示与购买入口", () => {
  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      console.log("[entitlement-presentation] visible page:", await $("body").getText());
      if (process.env.ZCODE_E2E_ARTIFACT_DIR)
        await browser.saveScreenshot(
          join(
            process.env.ZCODE_E2E_ARTIFACT_DIR,
            `${this.currentTest.title.replace(/[^a-zA-Z0-9-]/g, "_")}.png`,
          ),
        );
    }
  });
  after(async () => {
    await clearAppData();
  });
  it("CTP-14: 未连接只显示个人和团队购买入口", async function () {
    this.timeout(120000);
    await prepare(empty, "personal", false);
    await textVisible("Not connected");
    await textVisible("Connect to BigModel");
    await models(false);
    await banners(true);
  });
  it("CTP-15: 历史团队订阅不隐藏无权益账号的团队 banner", async function () {
    this.timeout(120000);
    await prepare({ ...empty, team: "expired" }, "personal");
    await textVisible("Not subscribed, enabled after subscription");
    await models(false);
    await banners(true);
    const subscriptions = (await requests()).filter((r) => r.path === "/api/biz/subscription/list");
    expect(subscriptions.length).toBeGreaterThan(0);
    // 账号 Provider 已使用短期项目 Token；旧长期 Key 不会再进入订阅请求。
    const tokens = subscriptions.map((request) =>
      request.headers.authorization?.replace(/^Bearer\s+/i, "").split("."),
    );
    expect(
      tokens.some((parts) => {
        if (parts?.length !== 3) return false;
        const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
        return claims.token_use === "project_access" && claims.api_key === "e2e-key";
      }),
    ).toBe(true);
  });
  for (const team of ["expired", "unassigned", "failure"] as const) {
    it(`CTP-16: 团队 ${team} 不误判为未登录`, async function () {
      this.timeout(120000);
      await prepare({ ...empty, team }, "team");
      await textVisible(
        team === "expired"
          ? "Team plan expired"
          : team === "unassigned"
            ? "Team plan not assigned"
            : "Fetch failed",
      );
      // 权益查询失败/检查中都不能把托管套餐渲染成可手动配置的模型区，
      // 只有重试后确认 purchased 才恢复模型列表。
      await models(false);
      await textVisible("Connect to BigModel", false);
      await textVisible("The selected connection is unavailable", false);
      const detail = (await requests()).filter((r) => r.path.endsWith("querySubscribeDetail"));
      expect(detail.length).toBeGreaterThan(0);
      expect(
        detail.some(
          (r) =>
            r.headers.authorization?.includes("e2e-bigmodel-oauth-token") &&
            r.headers["bigmodel-organization"] === "org-team-a" &&
            r.headers["bigmodel-project"] === "proj-team-a",
        ),
      ).toBe(true);
      if (team === "failure") {
        await scenario({ ...empty, team: "active" });
        await $("button=Retry").click();
        await models(true);
        await textVisible("Fetch failed", false);
        await textVisible("The selected connection is unavailable", false);
      }
    });
  }
  it("CTP-17: HTTP Date 判定过期，不展示旧余额与模型", async function () {
    this.timeout(120000);
    await prepare({ ...empty, start: "expired" }, "start");
    await textVisible("Start Plan expired");
    await textVisible("Today's balance", false);
    await textVisible("E2E_EXPIRED_BALANCE", false);
    await models(false);
    await banners(true);
  });
  it("CTP-18: 同时存在过期和有效 Start，仅显示有效计划", async function () {
    this.timeout(120000);
    await prepare({ ...empty, start: "mixed" }, "start");
    await textVisible("ZCode V3 Start Plan");
    await textVisible("Today's balance");
    await textVisible("E2E_EXPIRED_PLAN", false);
    await textVisible("E2E_EXPIRED_BALANCE", false);
    await models(true);
    await textVisible("Upgrade");
    await textVisible("150%");
  });
  it("CTP-20: Start 待生效只展示套餐卡，不展示模型列表", async function () {
    this.timeout(120000);
    // 待生效时账号权益 pending/entitled=false，但余额快照仍带套餐详情，
    // 不能因为 status=purchased 就渲染“没有配置模型、可添加模型”的配置区。
    await prepare({ ...empty, start: "pending" }, "start");
    await textVisible("ZCode V3 Start Plan");
    await textVisible("Pending");
    await textVisible("Today's balance", false);
    await models(false);
  });
  for (const paid of ["personal", "team"] as const) {
    it(`CTP-19: 有效 ${paid} 权益隐藏 Start 购买及升级入口`, async function () {
      this.timeout(120000);
      await prepare({ ...empty, start: "active", [paid]: "active" }, paid);
      // Start 是独立导航页；打开详情不改写 BigModel 已选的个人/团队连接身份。
      // 先确认付费连接可用，再切换详情，不能把未选定团队伪装成已确认的有效权益。
      await models(true);
      await clickTestIdByDom(
        testId(
          TID_MODEL_PROVIDER_NAV_ITEM,
          `coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`,
        ),
      );
      await textVisible("ZCode V3 Start Plan");
      await models(true);
      await banners(false);
      await textVisible("Upgrade", false);
      await textVisible("150%", false);
      await prepare({ ...empty, start: "expired", [paid]: "active" }, paid);
      await models(true);
      await clickTestIdByDom(
        testId(
          TID_MODEL_PROVIDER_NAV_ITEM,
          `coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`,
        ),
      );
      await textVisible("Start Plan expired");
      await models(false);
      await banners(false);
    });
  }
});
