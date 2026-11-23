import { readFile, writeFile } from "node:fs/promises";
import { BUILTIN_MODEL_PROVIDER_IDS as ids } from "@zcode/shared";
import { TID_LOGIN_TRIGGER } from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  getE2EAppDataPaths,
  readSettings,
  seedCredentials,
  seedSettings,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { resetCodingPlanUpgradeMockServer } from "#e2e/helpers/coding-plan-upgrade-mock-server";
import {
  readCodingPlanUpgradeMockRequests,
  waitForCodingPlanUpgradeMockRequest,
  waitForCodingPlanWebviewDisplayed,
} from "#e2e/helpers/coding-plan-upgrade-webview";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { sel } from "#e2e/helpers/selectors";

const TID_SIDEBAR_CODING_PLAN_UPGRADE_BUTTON = "sidebar-coding-plan-upgrade-button";

/**
 * AUTH-CN-STALE-DOMAIN：未登录时在 API Key 页“跳过”选了 Z.ai，随后用国内入口（zai_cn）登录。
 * 用户反馈（Windows 3.18.2）：升级套餐页一直显示“正在等待 App 的登录信息”。
 * 根因：登录/启动恢复沿用账号用不了的 providerFamilyDomain=zai，账号套餐都不是当前连接，
 * 升级入口按 zai 回退打开 Z.ai 购买页；官网对 zai 页 + active_provider=zai_cn 固定判为缺少登录信息。
 */
describe("AUTH-CN-STALE-DOMAIN: 国内关联账号纠正登录前跳过写入的 Z.ai 运行域", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("CSD-01: 启动恢复把 domain 纠正为 bigmodel，套餐成为当前连接，升级打开 BigModel 购买页", async function () {
    this.timeout(180_000);
    const { baseUrls } = await readCodingPlanUpgradeMockRequests();
    // 无订阅场景：头像菜单没有可用套餐，只能按 family 回退，与用户现场一致。
    await Promise.all(
      baseUrls.map((url) => resetCodingPlanUpgradeMockServer(url, "personal-sold-out")),
    );

    // 旧 Host 存活时写 seed 会与异步迁移/账号刷新竞争；退出屏障后再写本例数据。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await seedCredentials("zai-webview-oauth-token");
        const { credentialsFile } = getE2EAppDataPaths();
        const credentials = JSON.parse(await readFile(credentialsFile, "utf8")) as Record<
          string,
          string
        >;
        for (const key of Object.keys(credentials)) {
          if (key.startsWith("oauth:") || key === "zcodejwttoken") delete credentials[key];
        }
        Object.assign(credentials, {
          "oauth:active_provider": "zai_cn",
          "oauth:session_revision": "e2e-stale-domain-revision",
          "oauth:zai_cn:access_token": "e2e-cn-upstream-oauth",
          "oauth:zai_cn:user_info": JSON.stringify({
            user_id: "zcode-primary-user",
            name: "CN User",
          }),
          "oauth:linked_bigmodel": JSON.stringify({
            userId: "zcode-primary-user",
            customerId: "e2e-user",
            accessToken: "e2e-linked-bigmodel-jwt",
          }),
          zcodejwttoken: "e2e-cn-zcode-jwt",
        });
        await writeFile(credentialsFile, JSON.stringify(credentials), "utf8");
        await seedSettings({
          // 登录前“跳过”写入的运行域；当前账号只有 BigModel 材料。
          providerFamilyDomain: "zai",
          providerFamilyDomainMigrated: true,
          providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
          lastWorkspaceSession: [
            { kind: "local", workspacePath: DEFAULT_WORKSPACE, workspacePurpose: "project" },
          ],
          lastActiveTabIndex: 0,
        });
      },
    });
    await skipOccupationOnboardingIfPresent();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);

    // 1. 运行域按账号可用 family 纠正，已保存的 BigModel 选择保留。
    await browser.waitUntil(
      async () => (await readSettings()).providerFamilyDomain === "bigmodel",
      {
        timeout: 30_000,
        timeoutMsg: `providerFamilyDomain 没有纠正为 bigmodel: ${JSON.stringify(
          (await readSettings()).providerFamilyDomain ?? null,
        )}`,
      },
    );
    expect((await readSettings()).providerFamilyConnectionSelections).toMatchObject({
      bigmodel: { kind: "individual-coding-plan" },
    });

    // 2. 账号套餐重新成为当前执行连接（修复前 domain=zai 时两者都是 current=false）。
    for (const providerId of [ids.bigmodelIndividualCodingPlan, ids.bigmodelStartPlan]) {
      await browser.waitUntil(async () => (await readAccountState(providerId))?.current === true, {
        timeout: 30_000,
        timeoutMsg: `${providerId} 没有成为当前连接: ${JSON.stringify(
          await readAccountState(providerId),
        )}`,
      });
    }

    // 3. 头像菜单升级打开 BigModel 购买页，而不是 Z.ai。
    // 前置：升级入口门禁未就绪时点击只会重试、不会打开购买页，先等它就绪并保留现场。
    await browser.waitUntil(async () => (await readUpgradeEntryGateStatus()) === "ready", {
      timeout: 30_000,
      timeoutMsg: `升级入口门禁未就绪: ${await readUpgradeEntryGateStatus()}；mock 请求: ${(
        await readCodingPlanUpgradeMockRequests()
      ).requests
        .map((request) => `${request.method} ${request.path}`)
        .join(" / ")}`,
    });
    const profileTrigger = await $(sel(TID_LOGIN_TRIGGER));
    await profileTrigger.waitForDisplayed({ timeout: 15_000, timeoutMsg: "没有找到头像菜单入口" });
    await profileTrigger.click();
    const upgrade = await $(sel(TID_SIDEBAR_CODING_PLAN_UPGRADE_BUTTON));
    await upgrade.waitForClickable({ timeout: 30_000, timeoutMsg: "头像菜单没有可点击的升级入口" });
    await upgrade.click();
    await waitForCodingPlanWebviewDisplayed();
    await waitForCodingPlanUpgradeMockRequest(
      (request) => request.path === "/coding-plan" && request.query.embedded === "app",
      "升级入口没有请求购买页",
    );
    const pageRequests = (await readCodingPlanUpgradeMockRequests()).requests.filter(
      (request) => request.path === "/coding-plan",
    );
    expect(pageRequests.map((request) => request.query.provider)).toEqual(
      pageRequests.map(() => "bigmodel"),
    );
  });

  it("CSD-02: 已保存选择的 domain 在关联失效后重启保持不变，不自动切到登录家族", async function () {
    this.timeout(120_000);
    const { baseUrls } = await readCodingPlanUpgradeMockRequests();
    await Promise.all(
      baseUrls.map((url) => resetCodingPlanUpgradeMockServer(url, "personal-sold-out")),
    );
    const selections = { bigmodel: { kind: "individual-coding-plan" as const } };
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        // Z.ai 主登录，用户曾明确选择 BigModel 个人套餐；关联材料已失效被清除，账号只剩 zai。
        await seedCredentials("zai-webview-oauth-token");
        await seedSettings({
          providerFamilyDomain: "bigmodel",
          providerFamilyDomainMigrated: true,
          providerFamilyConnectionSelections: selections,
          lastWorkspaceSession: [
            { kind: "local", workspacePath: DEFAULT_WORKSPACE, workspacePurpose: "project" },
          ],
          lastActiveTabIndex: 0,
        });
      },
    });
    await skipOccupationOnboardingIfPresent();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);
    // 启动对齐紧跟在后台补关联（profile 查询）之后执行；以它为锚点再观察完整窗口。
    await waitForCodingPlanUpgradeMockRequest(
      (request) => request.path === "/api/v1/oauth/profile",
      "启动后台补关联没有查询 profile",
    );
    // 负向断言：窗口内 domain 一旦改变即失败（修复前的实现会在这里切到 zai）。
    const changed = await browser
      .waitUntil(async () => (await readSettings()).providerFamilyDomain !== "bigmodel", {
        timeout: 15_000,
      })
      .then(() => true)
      .catch(() => false);
    const settings = await readSettings();
    expect({ changed, domain: settings.providerFamilyDomain ?? null }).toEqual({
      changed: false,
      domain: "bigmodel",
    });
    // 原选择意图保留，不替用户初始化另一家族的连接。
    expect(settings.providerFamilyConnectionSelections).toEqual(selections);
  });
});

async function readUpgradeEntryGateStatus(): Promise<string | null> {
  return browser.execute((id) => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (!element) return null;
    let fiber = (element as any)[
      Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
    ];
    while (fiber) {
      // CodingPlanUpgradeDialogProvider 的 context value 同时带 inventory 与 openCodingPlanUpgrade。
      const value = fiber.memoizedProps?.value;
      if (value?.inventory && value?.openCodingPlanUpgrade) return value.inventory.status;
      fiber = fiber.return;
    }
    return null;
  }, TID_LOGIN_TRIGGER);
}

async function readAccountState(providerId: string): Promise<{
  availability?: string;
  current?: boolean;
  unavailableReason?: string;
} | null> {
  return browser.execute(
    async (id, targetProviderId) => {
      const element = document.querySelector(`[data-testid="${id}"]`);
      if (!element) return null;
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
      ];
      while (fiber) {
        const value = fiber.memoizedProps?.value;
        const services = value?.providerSettingsService ? value : fiber.memoizedProps?.services;
        if (services?.providerSettingsService) {
          // 只读 Host 当前账号投影，不由测试补发刷新掩盖状态。
          const view = await services.providerSettingsService.getView();
          return (
            view.providers.find((provider: any) => provider.providerId === targetProviderId)
              ?.accountState ?? null
          );
        }
        fiber = fiber.return;
      }
      return null;
    },
    TID_LOGIN_TRIGGER,
    providerId,
  );
}
