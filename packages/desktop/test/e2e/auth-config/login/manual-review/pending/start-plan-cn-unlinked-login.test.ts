import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_MODEL_PROVIDER_IDS as ids } from "@zcode/shared";
import {
  TID_LOGIN_TRIGGER,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_OAUTH_LOGIN_BUTTON,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  readSettings,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import {
  CN_UNLINKED_E2E_UPSTREAM_TOKEN,
  CN_UNLINKED_E2E_ZCODE_JWT,
  buildCnUnlinkedSessionCredentials,
} from "#e2e/helpers/start-plan-cn-unlinked-fixture";
import { selectRegistryProviderModelById } from "#e2e/helpers/upstream-provider";
import { getV4ModelConfig, prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

interface MockRequest {
  method: string;
  path: string;
  headers: { authorization?: string };
}

/**
 * AUTH-CN-START：国内入口（zai_cn）登录、从未注册 BigModel 的新账号。
 * 修复前 Start Plan 身份必须来自套餐家族材料：两个 Start 都判为未连接、显示“需要登录”，
 * 设置页同时出现两个 Start 入口。Start 是 ZCode 用户级权益，只需要 ZCode JWT。
 */
describe("AUTH-CN-START: 国内登录未关联 BigModel 时使用 Start Plan", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("CNS-01: 只显示 BigModel 的 Start，用 ZCode JWT 查询并可选择 Start 模型", async function () {
    this.timeout(240_000);
    const upstream = process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL;
    if (!upstream) throw new Error("Missing isolated account control plane");
    await prepareV4ConversationE2E({ skipProvider: true });
    // Start balance 返回有效体验套餐与 GLM-5.3 额度；同时清空控制面请求记录。
    const scenario = await fetch(`${upstream}/__e2e/coding-plan/scenario`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "both", providerResponsive: true }),
    });
    expect(scenario.ok).toBe(true);

    // 旧 Host 存活时写 seed 会与异步迁移/账号刷新竞争；退出屏障后再写本例数据。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        const { credentialsFile } = getE2EAppDataPaths();
        const credentials = JSON.parse(await readFile(credentialsFile, "utf8")) as Record<
          string,
          string
        >;
        for (const key of Object.keys(credentials)) {
          if (key.startsWith("oauth:") || key === "zcodejwttoken") delete credentials[key];
        }
        Object.assign(credentials, buildCnUnlinkedSessionCredentials());
        await writeFile(credentialsFile, JSON.stringify(credentials), "utf8");
        // 新账号没有任何已保存的套餐家族或连接选择。
        const settingsFile = join(getE2EAppDataPaths().appDataDir, "setting.json");
        const settings = JSON.parse(await readFile(settingsFile, "utf8")) as Record<
          string,
          unknown
        >;
        delete settings.providerFamilyDomain;
        delete settings.providerFamilyConnectionSelections;
        settings.providerFamilyDomainMigrated = true;
        await writeFile(settingsFile, JSON.stringify(settings), "utf8");
      },
    });

    // 已登录的国内账号重启后必须回到工作区，不能被启动门禁重新送回登录页。
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="onboarding-page"]').isExisting()) ||
        (await $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).isExisting()) ||
        (await $(`[data-testid="${TID_OAUTH_LOGIN_BUTTON}"]`).isDisplayed()),
      { timeout: 60_000, timeoutMsg: "重启后既没有工作区也没有登录页" },
    );
    expect(await $(`[data-testid="${TID_OAUTH_LOGIN_BUTTON}"]`).isDisplayed()).toBe(false);
    await skipOccupationOnboardingIfPresent();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);
    // 诊断证据：启动门禁依赖持久化的 providerFamilyDomain，记录本例启动后的真实值。
    await writeFile(
      await artifactPath("cn-unlinked-startup-settings.json"),
      JSON.stringify(
        {
          providerFamilyDomain: (await readSettings()).providerFamilyDomain ?? null,
          loginEntryVisible: await $(`[data-testid="${TID_OAUTH_LOGIN_BUTTON}"]`).isExisting(),
        },
        null,
        2,
      ),
    );

    // 前置条件：profile 已明确返回“无关联”，账号可用家族为空。
    await waitForMockRequest(
      upstream,
      (request) =>
        request.path === "/api/v1/oauth/profile" &&
        request.headers.authorization === `Bearer ${CN_UNLINKED_E2E_ZCODE_JWT}`,
      "启动后台补关联没有查询 profile",
    );
    const availability = await readAccountAvailability();
    expect(availability).toMatchObject({ loginProvider: "zai_cn", families: [] });

    // Host 账号状态：BigModel Start 可用且为当前；付费套餐仍要求关联材料。
    await browser.waitUntil(
      async () =>
        (await readAccountState(ids.bigmodelStartPlan))?.availability === "available" &&
        (await readAccountState(ids.bigmodelStartPlan))?.current === true,
      {
        timeout: 30_000,
        timeoutMsg: `BigModel Start 未变为可用当前项: ${JSON.stringify(
          await readAccountState(ids.bigmodelStartPlan),
        )}`,
      },
    );
    expect(await readAccountState(ids.zaiStartPlan)).toMatchObject({
      availability: "unavailable",
      unavailableReason: "not-connected",
    });
    expect(await readAccountState(ids.bigmodelIndividualCodingPlan)).toMatchObject({
      availability: "unavailable",
      unavailableReason: "not-connected",
    });

    // Start 只消费 ZCode JWT；中国区上游 OAuth token 不能出现在任何业务请求里。
    const requests = await readMockRequests(upstream);
    expect(
      requests.some(
        (request) =>
          request.path === "/api/v1/zcode-plan/billing/balance" &&
          request.headers.authorization === `Bearer ${CN_UNLINKED_E2E_ZCODE_JWT}`,
      ),
    ).toBe(true);
    expect(
      requests.filter((request) =>
        request.headers.authorization?.includes(CN_UNLINKED_E2E_UPSTREAM_TOKEN),
      ),
    ).toEqual([]);

    // 运行时鉴权：与模型调用相同，按 Provider 的静态 Start 访问约束解析当前凭据。
    const usage = await readStartUsageSnapshot(ids.bigmodelStartPlan);
    expect(usage.unavailableReason ?? null).toBeNull();

    // 设置页：智谱分组只出现一个 Start Plan（BigModel），不再要求登录。
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
    const bigmodelStartNav = testId(
      TID_MODEL_PROVIDER_NAV_ITEM,
      `coding-plan:${ids.bigmodelStartPlan}`,
    );
    const zaiStartNav = testId(TID_MODEL_PROVIDER_NAV_ITEM, `coding-plan:${ids.zaiStartPlan}`);
    await $(`[data-testid="${bigmodelStartNav}"]`).waitForDisplayed({ timeout: 15_000 });
    expect(await $(`[data-testid="${zaiStartNav}"]`).isExisting()).toBe(false);
    await clickTestIdByDom(bigmodelStartNav);
    expect(await $(`[data-testid="${TID_OAUTH_LOGIN_BUTTON}"]`).isExisting()).toBe(false);
    await browser.saveScreenshot(await artifactPath("cn-unlinked-start-plan-settings.png"));
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);

    // Composer：BigModel Start 模型可选择，选择结果精确落到 Start Provider。
    await selectRegistryProviderModelById("GLM-5.3", {
      providerId: ids.bigmodelStartPlan,
      includePlainModelFallback: false,
    });
    expect(await getV4ModelConfig()).toMatchObject({
      provider: ids.bigmodelStartPlan,
      model: "GLM-5.3",
    });
  });
});

async function artifactPath(name: string): Promise<string> {
  // 产物目录可能尚未创建；截图与诊断 JSON 写入前统一确保存在。
  const dir = join(
    process.env.ZCODE_E2E_ARTIFACT_DIR || join(process.cwd(), ".e2e-artifacts"),
    "start-plan-cn-unlinked",
  );
  await mkdir(dir, { recursive: true });
  return join(dir, name);
}

async function readMockRequests(upstream: string): Promise<MockRequest[]> {
  const response = await fetch(`${upstream}/__e2e/coding-plan/requests`);
  return ((await response.json()) as { requests: MockRequest[] }).requests;
}

async function waitForMockRequest(
  upstream: string,
  predicate: (request: MockRequest) => boolean,
  timeoutMsg: string,
): Promise<void> {
  await browser.waitUntil(async () => (await readMockRequests(upstream)).some(predicate), {
    timeout: 30_000,
    timeoutMsg,
  });
}

async function readAccountAvailability(): Promise<{
  loginProvider: string | null;
  families: string[];
} | null> {
  return browser.execute(async (id) => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (!element) return null;
    let fiber = (element as any)[
      Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
    ];
    while (fiber) {
      const value = fiber.memoizedProps?.value;
      const services = value?.oauthService ? value : fiber.memoizedProps?.services;
      if (services?.oauthService) return services.oauthService.getAccountAvailability();
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

async function readStartUsageSnapshot(providerId: string): Promise<{
  unavailableReason?: string | null;
}> {
  return browser.execute(
    async (id, targetProviderId) => {
      const element = document.querySelector(`[data-testid="${id}"]`)!;
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
      ];
      while (fiber) {
        const value = fiber.memoizedProps?.value;
        const services = value?.usageStatsService ? value : fiber.memoizedProps?.services;
        if (services?.usageStatsService) {
          const snapshot = await services.usageStatsService.getEntitlementSnapshot({
            preferredProviderId: targetProviderId,
            // 与 Provider 配置相同的静态约束；Host 必须按当前登录解析 Start 访问身份。
            accountAccess: { type: "zhipu-account", accountType: "bigmodel", mode: "start-plan" },
            includeSubscription: true,
            requirePreferredProvider: true,
          });
          return { unavailableReason: snapshot?.unavailableReason ?? null };
        }
        fiber = fiber.return;
      }
      throw new Error("Missing usage services");
    },
    TID_LOGIN_TRIGGER,
    providerId,
  );
}
