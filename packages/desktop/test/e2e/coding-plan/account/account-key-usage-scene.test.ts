import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { readE2ECredentialValue } from "#e2e/helpers/desktop-app";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_LOGIN_TRIGGER,
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER,
  TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  clearAppData,
  getE2EAppDataPaths,
  DEFAULT_WORKSPACE,
  readModelProvider,
  readSettings,
  seedCredentials,
  seedSettings,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { resetCodingPlanUpgradeMockServer } from "#e2e/helpers/coding-plan-upgrade-mock-server";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import {
  waitForCodingPlanUpgradeMockRequest,
  readCodingPlanUpgradeMockRequests,
} from "#e2e/helpers/coding-plan-upgrade-webview";

// 复用已有账号 mock 数据；没有目标名称 Key，由真实 Host resolver 发起创建。
describe("PAT-KEY-E2E: 账号就绪时创建 Coding Plan Key", () => {
  afterEach(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BigModel 创建 Key 显式声明套餐用途，凭据不写入个人配置", async function () {
    this.timeout(90000);
    await skipOccupationOnboardingIfPresent();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await assertCreation("e2e-bigmodel-oauth-token");
    expect(
      (await readModelProvider(BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan))?.apiKey ??
        "",
    ).toBe("");
  });

  it("Z.AI 旧 Key 损坏但 OAuth 有效，重启直接换 Token 不要求重登", async function () {
    this.timeout(90000);
    // 旧 Host 存活时写 seed 会与异步迁移/账号刷新竞争；退出屏障后再写本例数据。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await seedCredentials("zai-webview-oauth-token");
        const { credentialsFile } = getE2EAppDataPaths();
        const credentials = JSON.parse(await readFile(credentialsFile, "utf8")) as Record<
          string,
          string
        >;
        const profile = JSON.parse((await readE2ECredentialValue("oauth:zai:user_info"))!) as {
          id: string;
        };
        const legacyKey = `account-provider:coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan}:account:${encodeURIComponent(profile.id)}:api-key`;
        credentials[legacyKey] = "enc:v1:broken-legacy-key";
        await writeFile(credentialsFile, JSON.stringify(credentials), "utf8");
        await seedSettings({
          providerFamilyConnectionSelections: {
            zai: { kind: "individual-coding-plan" },
            bigmodel: { kind: "individual-coding-plan" },
          },
          providerFamilyDomain: "zai",
          providerFamilyDomainMigrated: true,
          lastWorkspaceSession: [
            {
              kind: "local",
              workspacePath: DEFAULT_WORKSPACE,
              workspacePurpose: "project",
            },
          ],
          lastActiveTabIndex: 0,
        });
      },
    });
    await skipOccupationOnboardingIfPresent();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await assertCreation("Bearer zai-webview-oauth-token");
    const restored = JSON.parse(
      await readFile(getE2EAppDataPaths().credentialsFile, "utf8"),
    ) as Record<string, string>;
    expect(Object.values(restored)).toContain("enc:v1:broken-legacy-key");
    expect(await readE2ECredentialValue("oauth:zai:access_token")).toBe("zai-webview-oauth-token");
    expect(
      (await readModelProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan))?.apiKey ?? "",
    ).toBe("");
  });
  it("中国区主登录通过关联 BigModel JWT 获取套餐 Token", async function () {
    this.timeout(90000);
    const { credentialsFile } = getE2EAppDataPaths();
    const { baseUrls } = await readCodingPlanUpgradeMockRequests();
    await Promise.all(
      baseUrls.map((url) => resetCodingPlanUpgradeMockServer(url, "webview-refresh-provider")),
    );
    // 旧 Host 存活时写 seed 会与异步迁移/账号刷新竞争；退出屏障后再写本例数据。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await seedCredentials("zai-webview-oauth-token");
        const { credentialsFile } = getE2EAppDataPaths();
        const credentials = JSON.parse(await readFile(credentialsFile, "utf8"));
        for (const key of Object.keys(credentials)) {
          if (key.startsWith("oauth:")) delete credentials[key];
        }
        Object.assign(credentials, {
          "oauth:active_provider": "zai_cn",
          "oauth:session_revision": "e2e-linked-revision",
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
          providerFamilyDomain: "bigmodel",
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
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    expect(await readE2ECredentialValue("oauth:active_provider")).toBe("zai_cn");
    await assertCreation("e2e-linked-bigmodel-jwt");
    const entitlement = await browser.execute(
      async (triggerId, providerId) => {
        const element = document.querySelector(`[data-testid="${triggerId}"]`)!;
        let fiber = (element as any)[
          Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
        ];
        while (fiber) {
          const value = fiber.memoizedProps?.value;
          const services = value?.usageStatsService ? value : fiber.memoizedProps?.services;
          if (services?.usageStatsService)
            return services.usageStatsService.getEntitlementSnapshot({
              preferredProviderId: providerId,
              accountAccess: {
                type: "zhipu-account",
                family: "bigmodel",
                planKind: "individual-coding-plan",
              },
              includeSubscription: true,
              allowDisabledPreferredProvider: true,
              requirePreferredProvider: true,
              allowEnvApiKey: false,
            });
          fiber = fiber.return;
        }
        throw new Error("Missing entitlement RPC accessor");
      },
      TID_LOGIN_TRIGGER,
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    );
    expect(entitlement.mcpQuota).not.toBeNull();
    const mcp = (await readCodingPlanUpgradeMockRequests()).requests.find(
      (request) => request.path === "/api/v1/mcp/usage",
    );
    expect(mcp?.headers.authorization).toBe("Bearer e2e-cn-zcode-jwt");
    expect(mcp?.headers["x-bigmodel-authorization"]).toBe("Bearer e2e-linked-bigmodel-jwt");
    expect(mcp?.headers["bigmodel-target-type"]).toBe("PERSONAL");
    expect(mcp?.headers["x-coding-plan-api-key"]).toBeUndefined();
    const reset = await browser.execute(
      async (triggerId, providerId) => {
        const element = document.querySelector(`[data-testid="${triggerId}"]`)!;
        let fiber = (element as any)[
          Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
        ];
        while (fiber) {
          const value = fiber.memoizedProps?.value;
          const services = value?.usageStatsService ? value : fiber.memoizedProps?.services;
          if (services?.usageStatsService)
            return services.usageStatsService.getCodingPlanResetStatus({
              preferredProviderId: providerId,
              accountAccess: {
                type: "zhipu-account",
                family: "bigmodel",
                planKind: "individual-coding-plan",
              },
            });
          fiber = fiber.return;
        }
        throw new Error("Missing reset status RPC accessor");
      },
      TID_LOGIN_TRIGGER,
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    );
    expect(reset.hasUnreadHistory).toBe(false);
    const resetRequest = (await readCodingPlanUpgradeMockRequests()).requests.find(
      (request) => request.path === "/api/v1/coding-plan/reset/status",
    );
    expect(resetRequest?.headers.authorization).toBe("Bearer e2e-cn-zcode-jwt");
    expect(resetRequest?.headers["x-bigmodel-authorization"]).toBe("e2e-linked-bigmodel-jwt");
    const accelerated = await browser.execute(
      async (triggerId, providerId) => {
        const element = document.querySelector(`[data-testid="${triggerId}"]`)!;
        let fiber = (element as any)[
          Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
        ];
        while (fiber) {
          const value = fiber.memoizedProps?.value;
          const services = value?.offPeakTaskService ? value : fiber.memoizedProps?.services;
          if (services?.offPeakTaskService) {
            (window as any).__linkedAccelerationServices = services;
            const support = await services.offPeakTaskService.getCodingPlanSupport();
            if (!support.supported) return { support };
            const availability = await services.offPeakTaskService.getTakeNumberAvailability();
            const view = await services.modelSelectionService.getView();
            const provider = view.providers.find(
              (item: { providerId: string }) => item.providerId === providerId,
            );
            const result = await services.highspeedCardService.prepareTurn({
              taskId: "e2e-linked-highspeed-task",
              providerId,
              model: provider.models[0].modelId,
              waitBudgetMs: 10_000,
            });
            return {
              support,
              availability,
              kind: result.kind,
              ownerKey: result.card?.ownerKey,
              correctBusinessAuth:
                result.execution?.requestAuth.headers["X-Bigmodel-Authorization"] ===
                "Bearer e2e-linked-bigmodel-jwt",
              correctPrimaryAuth:
                result.execution?.requestAuth.headers.Authorization === "Bearer e2e-cn-zcode-jwt",
            };
          }
          fiber = fiber.return;
        }
        throw new Error("Missing accelerated services");
      },
      TID_LOGIN_TRIGGER,
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    );
    expect(accelerated).toMatchObject({
      support: { supported: true, providerFamily: "bigmodel" },
      availability: { canTakeNumber: true },
      kind: "accelerated",
      correctBusinessAuth: true,
      correctPrimaryAuth: true,
    });
    expect(accelerated.ownerKey).toMatch(/^v1:[a-f0-9]{64}$/);
    const healthyCount = async () =>
      (await readCodingPlanUpgradeMockRequests()).requests.filter((item) =>
        item.path.endsWith("/healthy"),
      ).length;
    const beforeHealthy = await healthyCount();
    const skippedHealthy = await browser.execute(async () => {
      const service = (window as any).__linkedAccelerationServices.highspeedCardService;
      return [
        await service.healthy("e2e-linked-highspeed"),
        await service.healthy("e2e-linked-highspeed", `v1:${"0".repeat(64)}`),
      ];
    });
    expect(skippedHealthy).toEqual([null, null]);
    expect(await healthyCount()).toBe(beforeHealthy);
    const privateAuthRejected = await browser.execute(async () => {
      const service = (window as any).__linkedAccelerationServices.highspeedCardService;
      for (const name of ["resolveHealthyIdentity", "resolveInferenceAuth"]) {
        try {
          await service[name]();
          return false;
        } catch (error) {
          if (!String(error).includes(`Method not found: ${name}`)) return false;
        }
      }
      return true;
    });
    expect(privateAuthRejected).toBe(true);
    const healthy = await browser.execute(async (ownerKey) => {
      const services = (window as any).__linkedAccelerationServices;
      const usage = await services.highspeedCardService.healthy("e2e-linked-highspeed", ownerKey);
      await services.credentialService.save(
        "oauth:session_revision",
        "e2e-healthy-same-user-relogin",
      );
      const afterRelogin = await services.highspeedCardService.healthy(
        "e2e-linked-highspeed",
        ownerKey,
      );
      const raw = await services.credentialService.load("oauth:zai_cn:user_info");
      await services.credentialService.save(
        "oauth:zai_cn:user_info",
        JSON.stringify({ user_id: "another-user", name: "Other" }),
      );
      const foreign = await services.highspeedCardService.healthy("e2e-linked-highspeed", ownerKey);
      await services.credentialService.save("oauth:zai_cn:user_info", raw);
      return { usage, afterRelogin, foreign };
    }, accelerated.ownerKey);
    expect(healthy).toMatchObject({
      usage: { completionTokens: 100 },
      afterRelogin: { completionTokens: 100 },
      foreign: null,
    });
    expect(await healthyCount()).toBe(beforeHealthy + 2);
    const { baseUrls: healthyBaseUrls } = await readCodingPlanUpgradeMockRequests();
    const holdHealthy = (held: boolean) =>
      Promise.all(
        healthyBaseUrls.map((url) =>
          fetch(`${url}/__e2e/coding-plan/highspeed-hold`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ held }),
          }),
        ),
      );
    await holdHealthy(true);
    await browser.execute((ownerKey) => {
      const state = window as any;
      state.__ownerHealthyPending = state.__linkedAccelerationServices.highspeedCardService.healthy(
        "e2e-linked-highspeed",
        ownerKey,
      );
    }, accelerated.ownerKey);
    await browser.waitUntil(async () => (await healthyCount()) === beforeHealthy + 3, {
      timeout: 10_000,
    });
    await browser.execute(async () =>
      (window as any).__linkedAccelerationServices.credentialService.save(
        "oauth:session_revision",
        "e2e-healthy-late-relogin",
      ),
    );
    await holdHealthy(false);
    expect(
      await browser.execute(async () => {
        const state = window as any;
        try {
          return await state.__ownerHealthyPending;
        } finally {
          delete state.__ownerHealthyPending;
        }
      }),
    ).toBeNull();

    const accelerationRequests = (await readCodingPlanUpgradeMockRequests()).requests;
    const offPeakRequest = accelerationRequests.find(
      (request) => request.path === "/api/v1/off-peak/ticket/availability",
    );
    expect(offPeakRequest?.headers.authorization).toBe("Bearer e2e-cn-zcode-jwt");
    expect(offPeakRequest?.headers["x-coding-plan-api-key"]).toBeTruthy();
    expect(offPeakRequest?.headers["x-coding-plan-api-key"]).not.toBe("e2e-linked-bigmodel-jwt");
    const drawRequest = accelerationRequests.find(
      (request) => request.path === "/api/v1/highspeed/draw",
    );
    expect(drawRequest?.headers["x-bigmodel-authorization"]).toBe("Bearer e2e-linked-bigmodel-jwt");
    const requests = (await readCodingPlanUpgradeMockRequests()).requests;
    expect(
      requests.some((request) => request.headers.authorization?.includes("e2e-cn-upstream-oauth")),
    ).toBe(false);
    // 同账号重登也必须让旧卡失效，不能仅比较两个未变化的 JWT。
    const reused = await browser.execute(async () => {
      const services = (window as any).__linkedAccelerationServices;
      await services.credentialService.save("oauth:session_revision", "e2e-highspeed-relogin");
      const view = await services.modelSelectionService.getView();
      const provider = view.providers.find(
        (item: any) => item.providerId.includes("bigmodel") && item.models.length,
      );
      const result = await services.highspeedCardService.prepareTurn({
        taskId: "e2e-linked-highspeed-task",
        providerId: provider.providerId,
        model: provider.models[0].modelId,
        waitBudgetMs: 10_000,
      });
      return { kind: result.kind, reason: result.reason, hasExecution: !!result.execution };
    });
    expect(reused).toEqual({ kind: "fallback", reason: "unavailable", hasExecution: false });
    const holdDraw = (held: boolean) =>
      Promise.all(
        baseUrls.map((url) =>
          fetch(`${url}/__e2e/coding-plan/highspeed-hold`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ held }),
          }),
        ),
      );
    await holdDraw(true);
    const drawsBefore = (await readCodingPlanUpgradeMockRequests()).requests.filter(
      (item) => item.path === "/api/v1/highspeed/draw",
    ).length;
    await browser.execute(() => {
      const state = window as any;
      state.__linkedLateDraw = (async () => {
        const services = state.__linkedAccelerationServices;
        const view = await services.modelSelectionService.getView();
        const provider = view.providers.find(
          (item: any) => item.providerId.includes("bigmodel") && item.models.length,
        );
        const result = await services.highspeedCardService.prepareTurn({
          taskId: "e2e-linked-highspeed-task",
          providerId: provider.providerId,
          model: provider.models[0].modelId,
          waitBudgetMs: 10_000,
        });
        return { kind: result.kind, reason: result.reason, hasExecution: !!result.execution };
      })();
    });
    await browser.waitUntil(
      async () =>
        (await readCodingPlanUpgradeMockRequests()).requests.filter(
          (item) => item.path === "/api/v1/highspeed/draw",
        ).length > drawsBefore,
      { timeout: 10_000 },
    );
    await browser.execute(async () =>
      (window as any).__linkedAccelerationServices.credentialService.save(
        "oauth:session_revision",
        "e2e-highspeed-late-relogin",
      ),
    );
    await holdDraw(false);
    const late = await browser.execute(async () => {
      const state = window as any;
      try {
        const result = await state.__linkedLateDraw;
        const snapshot =
          await state.__linkedAccelerationServices.highspeedCardService.getSnapshot();
        return { ...result, hasCard: !!snapshot.card };
      } finally {
        delete state.__linkedLateDraw;
        delete state.__linkedAccelerationServices;
      }
    });
    expect(late).toEqual({
      kind: "fallback",
      reason: "unavailable",
      hasExecution: false,
      hasCard: false,
    });
    const saved = JSON.parse(await readFile(credentialsFile, "utf8"));
    expect(await readE2ECredentialValue("oauth:active_provider")).toBe("zai_cn");
    expect(saved["oauth:bigmodel:access_token"]).toBeUndefined();
    const holdSubscriptions = (held: boolean) =>
      Promise.all(
        baseUrls.map((url) =>
          fetch(`${url}/__e2e/coding-plan/subscription-list-hold`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ held }),
          }),
        ),
      );
    const subscriptionCount = () =>
      readCodingPlanUpgradeMockRequests().then(
        ({ requests }) =>
          requests.filter((request) => request.path === "/api/biz/subscription/list").length,
      );
    await browser.execute(async (triggerId) => {
      const element = document.querySelector(`[data-testid="${triggerId}"]`)!;
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
      ];
      while (fiber) {
        const value = fiber.memoizedProps?.value;
        const services = value?.providerSettingsService ? value : fiber.memoizedProps?.services;
        if (services?.providerSettingsService) {
          const state = window as any;
          state.__accountRevisionCredential = services.credentialService;
          state.__accountRevisionSettings = services.providerSettingsService;
          await services.providerSettingsService.refresh("e2e-revision-baseline");
          return;
        }
        fiber = fiber.return;
      }
      throw new Error("Missing provider settings RPC accessor");
    }, TID_LOGIN_TRIGGER);
    const subscriptionsBefore = await subscriptionCount();
    await holdSubscriptions(true);
    await browser.execute(() => {
      const state = window as any;
      state.__accountRevisionRefresh = state.__accountRevisionSettings
        .refresh("e2e-same-identity-relogin")
        .then(
          () => false,
          () => true,
        );
    });
    await browser.waitUntil(async () => (await subscriptionCount()) > subscriptionsBefore, {
      timeout: 10_000,
    });
    // 模拟同账号同凭据重登：只有提交 revision 变化，不能靠 token 比较放过旧查询。
    await browser.execute(async () =>
      (window as any).__accountRevisionCredential.save(
        "oauth:session_revision",
        "e2e-relogin-revision",
      ),
    );
    await holdSubscriptions(false);
    expect(
      await browser.execute(async () => {
        const state = window as any;
        try {
          return await state.__accountRevisionRefresh;
        } finally {
          delete state.__accountRevisionRefresh;
          delete state.__accountRevisionCredential;
          delete state.__accountRevisionSettings;
        }
      }),
    ).toBe(true);
    await Promise.all(
      baseUrls.map((url) => resetCodingPlanUpgradeMockServer(url, "webview-refresh-provider")),
    );
    const mismatched = JSON.parse(await readFile(credentialsFile, "utf8"));
    mismatched["oauth:linked_bigmodel"] = JSON.stringify({
      userId: "another-zcode-user",
      customerId: "e2e-user",
      accessToken: "e2e-linked-bigmodel-jwt",
    });
    await writeFile(credentialsFile, JSON.stringify(mismatched), "utf8");
    const state = await browser.execute(
      async (triggerId, providerId) => {
        const element = document.querySelector(`[data-testid="${triggerId}"]`)!;
        let fiber = (element as any)[
          Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
        ];
        while (fiber) {
          const value = fiber.memoizedProps?.value;
          const services = value?.providerSettingsService ? value : fiber.memoizedProps?.services;
          if (services?.providerSettingsService) {
            const view = await services.providerSettingsService.refresh(
              "e2e-associated-owner-mismatch",
            );
            return view.providers.find(
              (provider: { providerId: string }) => provider.providerId === providerId,
            )?.accountState;
          }
          fiber = fiber.return;
        }
        throw new Error("Missing provider settings RPC accessor");
      },
      TID_LOGIN_TRIGGER,
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    );
    expect(state).toMatchObject({
      availability: "unavailable",
      unavailableReason: "not-connected",
    });
    expect(
      (await readCodingPlanUpgradeMockRequests()).requests.some((request) =>
        request.headers.authorization?.includes("e2e-linked-bigmodel-jwt"),
      ),
    ).toBe(false);
  });
  it("存量登录后台补关联，浏览两个套餐不改选择，明确选择才切换", async function () {
    this.timeout(90000);
    const { baseUrls } = await readCodingPlanUpgradeMockRequests();
    await Promise.all(
      baseUrls.map((url) => resetCodingPlanUpgradeMockServer(url, "webview-refresh-provider")),
    );
    await seedCredentials("zai-webview-oauth-token");
    const { credentialsFile } = getE2EAppDataPaths();
    const credentials = JSON.parse(await readFile(credentialsFile, "utf8"));
    delete credentials["oauth:linked_bigmodel"];
    credentials["oauth:zai:user_info"] = JSON.stringify({
      user_id: "e2e-association-user",
      name: "Associated User",
    });
    credentials.zcodejwttoken = "e2e-association-upgrade-jwt";
    await writeFile(credentialsFile, JSON.stringify(credentials), "utf8");
    const selections = {
      zai: { kind: "individual-coding-plan" as const },
      bigmodel: { kind: "individual-coding-plan" as const },
    };
    await seedSettings({
      providerFamilyDomain: undefined,
      providerFamilyDomainMigrated: true,
      providerFamilyConnectionSelections: selections,
      lastWorkspaceSession: [
        { kind: "local", workspacePath: DEFAULT_WORKSPACE, workspacePurpose: "project" },
      ],
      lastActiveTabIndex: 0,
    });
    await browser.reloadSession();
    await skipOccupationOnboardingIfPresent();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await browser.waitUntil(
      async () => {
        const state = await readSafeAccountAvailability();
        return state?.families?.includes("bigmodel") === true;
      },
      { timeout: 15_000, timeoutMsg: "存量 Z.ai 登录没有自动补齐关联" },
    );
    expect((await readSettings()).providerFamilyDomain).toBe("zai");
    expect((await readSettings()).providerFamilyConnectionSelections).toEqual(selections);
    await clickVisibleId(TID_TASK_SETTINGS_BUTTON);
    await clickVisibleId(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
    const zaiNav = testId(
      TID_MODEL_PROVIDER_NAV_ITEM,
      `preset:${BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan}`,
    );
    const bigmodelNav = testId(
      TID_MODEL_PROVIDER_NAV_ITEM,
      `preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`,
    );
    await clickVisibleId(bigmodelNav);
    expect((await readSettings()).providerFamilyDomain).toBe("zai");
    expect((await readSafeAccountAvailability())?.loginProvider).toBe("zai");
    await clickVisibleId(TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER);
    await clickVisibleId(
      testId(
        TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
        `coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan}`,
      ),
    );
    await browser.waitUntil(
      async () => (await readSettings()).providerFamilyDomain === "bigmodel",
      { timeout: 10_000 },
    );
    await clickVisibleId(zaiNav);
    expect((await readSettings()).providerFamilyDomain).toBe("bigmodel");
    expect((await readSafeAccountAvailability())?.loginProvider).toBe("zai");
    expect(
      (await readCodingPlanUpgradeMockRequests()).requests.some((request) =>
        /\/oauth\/(token|cli\/init)$/.test(request.path),
      ),
    ).toBe(false);
    const pricingCount = async () =>
      (await readCodingPlanUpgradeMockRequests()).requests.filter(
        (request) => request.path === "/api/biz/subscription/enterprise/v2/pricing",
      ).length;
    const heldCount = await pricingCount();
    await Promise.all(
      baseUrls.map((base) =>
        fetch(`${base}/__e2e/coding-plan/inventory-mode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "hold" }),
        }),
      ),
    );
    await browser.execute((triggerId) => {
      const element = document.querySelector(`[data-testid="${triggerId}"]`)!;
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
      ];
      while (fiber) {
        const value = fiber.memoizedProps?.value;
        const services = value?.codingPlanSubscriptionService
          ? value
          : fiber.memoizedProps?.services;
        if (services?.codingPlanSubscriptionService) {
          const state = window as any;
          state.__pricingRaceCredentials = services.credentialService;
          state.__pricingRace = services.codingPlanSubscriptionService
            .getEnterprisePricing({ authenticated: true, family: "bigmodel" })
            .then(
              () => false,
              () => true,
            );
          return;
        }
        fiber = fiber.return;
      }
      throw new Error("Missing pricing RPC accessor");
    }, TID_LOGIN_TRIGGER);
    await browser.waitUntil(async () => (await pricingCount()) > heldCount, { timeout: 10_000 });
    await browser.execute(async () =>
      (window as any).__pricingRaceCredentials.save(
        "oauth:session_revision",
        "e2e-pricing-next-session",
      ),
    );
    await Promise.all(
      baseUrls.map((base) =>
        fetch(`${base}/__e2e/coding-plan/inventory-mode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "ready" }),
        }),
      ),
    );
    expect(
      await browser.execute(async () => {
        const state = window as any;
        try {
          return await state.__pricingRace;
        } finally {
          delete state.__pricingRace;
          delete state.__pricingRaceCredentials;
        }
      }),
    ).toBe(true);
  });
  it("ASSOC-401: 关联拒绝后台刷新，不重放原请求或退出主登录", async function () {
    this.timeout(120000);
    await seedCredentials("zai-webview-oauth-token");
    const { credentialsFile } = getE2EAppDataPaths();
    const saved = JSON.parse(await readFile(credentialsFile, "utf8"));
    for (const key of Object.keys(saved)) if (key.startsWith("oauth:")) delete saved[key];
    Object.assign(saved, {
      "oauth:active_provider": "zai_cn",
      "oauth:session_revision": "e2e-expiring-revision",
      "oauth:zai_cn:access_token": "e2e-upstream-unused",
      "oauth:zai_cn:user_info": JSON.stringify({
        user_id: "e2e-expiring-user",
        name: "Associated",
      }),
      "oauth:linked_bigmodel": JSON.stringify({
        userId: "e2e-expiring-user",
        customerId: "e2e-user",
        accessToken: "e2e-expiring-business",
      }),
      zcodejwttoken: "e2e-expiring-primary",
    });
    await writeFile(credentialsFile, JSON.stringify(saved), "utf8");
    await seedSettings({
      providerFamilyDomain: "bigmodel",
      providerFamilyDomainMigrated: true,
      providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
      lastWorkspaceSession: [
        { kind: "local", workspacePath: DEFAULT_WORKSPACE, workspacePurpose: "project" },
      ],
      lastActiveTabIndex: 0,
    });
    await browser.reloadSession();
    await skipOccupationOnboardingIfPresent();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await browser.execute((id) => {
      const element = document.querySelector(`[data-testid="${id}"]`)!;
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
      ];
      while (fiber) {
        const value = fiber.memoizedProps?.value;
        const services = value?.oauthService ? value : fiber.memoizedProps?.services;
        if (services?.oauthService) {
          (window as any).__associated401Services = services;
          return;
        }
        fiber = fiber.return;
      }
      throw new Error("Missing OAuth accessor");
    }, TID_LOGIN_TRIGGER);
    const { baseUrls } = await readCodingPlanUpgradeMockRequests();
    const control = (mode: string, held: boolean, businessHeld = false) =>
      Promise.all(
        baseUrls.map((url) =>
          fetch(`${url}/__e2e/coding-plan/associated-auth`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode, held, businessHeld }),
          }),
        ),
      );
    const requests = () => readCodingPlanUpgradeMockRequests().then(({ requests }) => requests);
    const profiles = async () =>
      (await requests()).filter(
        (r) =>
          r.path === "/api/v1/oauth/profile" &&
          r.headers.authorization === "Bearer e2e-expiring-primary",
      ).length;
    const query = () =>
      browser.execute(async () => {
        try {
          await (
            window as any
          ).__associated401Services.codingPlanSubscriptionService.checkPendingOrders({
            providerId: "account:bigmodel-individual-coding-plan",
          });
          return true;
        } catch {
          return false;
        }
      });
    // 启动时的正常补全结束后才开始故障注入，不把初始 profile 当作拒绝恢复。
    await browser.waitUntil(async () => (await profiles()) > 0, { timeout: 10000 });
    const initial = await profiles();
    await control("forbidden", false);
    expect(await query()).toBe(false);
    await control("ok", false);
    expect(await query()).toBe(true);
    expect(await profiles()).toBe(initial);
    const logDir = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
    if (!logDir) throw new Error("缺少 E2E 日志目录");
    const recoveryCompletions = async () => {
      const logs = await Promise.all(
        (await readdir(logDir))
          .filter((file) => file.endsWith(".log"))
          .map((file) => readFile(join(logDir, file), "utf8")),
      );
      return logs.join("\n").split("associated OAuth rejection recovery completed").length - 1;
    };
    const completionsBefore = await recoveryCompletions();
    const oldRequestCount = (await requests()).filter(
      (r) => r.path === "/api/biz/pay/check-pending-orders",
    ).length;
    await control("unauthorized", false, true);
    await browser.execute(() => {
      const state = window as any;
      state.__heldAssociatedRequest = state.__associated401Services.codingPlanSubscriptionService
        .checkPendingOrders({ providerId: "account:bigmodel-individual-coding-plan" })
        .then(
          () => true,
          () => false,
        );
    });
    await browser.waitUntil(
      async () =>
        (await requests()).filter((r) => r.path === "/api/biz/pay/check-pending-orders").length >
        oldRequestCount,
      { timeout: 10000 },
    );
    await browser.execute(async () =>
      (window as any).__associated401Services.credentialService.save(
        "oauth:session_revision",
        "e2e-same-token-relogin",
      ),
    );
    await control("ok", false);
    expect(
      await browser.execute(async () => {
        const state = window as any;
        try {
          return await state.__heldAssociatedRequest;
        } finally {
          delete state.__heldAssociatedRequest;
        }
      }),
    ).toBe(false);
    // 等待旧响应的后台观察结束，避免零新增断言早于异步刷新。
    await browser.waitUntil(async () => (await recoveryCompletions()) > completionsBefore, {
      timeout: 10000,
    });
    expect(await profiles()).toBe(initial);
    await control("unauthorized", true);
    const before = (await requests()).filter(
      (r) => r.path === "/api/biz/pay/check-pending-orders",
    ).length;
    expect(await query()).toBe(false);
    await browser.waitUntil(async () => (await profiles()) === initial + 1, { timeout: 10000 });
    expect(
      (await requests()).filter((r) => r.path === "/api/biz/pay/check-pending-orders").length,
    ).toBe(before + 1);
    expect(await query()).toBe(false);
    expect(await profiles()).toBe(initial + 1);
    await control("ok", false);
    await browser.waitUntil(
      async () =>
        (
          await browser.execute(() =>
            (window as any).__associated401Services.oauthService.getAccountAvailability(),
          )
        ).sessionRevision !== "e2e-same-token-relogin",
      { timeout: 10000 },
    );
    expect(await query()).toBe(true);
    const last = (await requests())
      .filter((r) => r.path === "/api/biz/pay/check-pending-orders")
      .at(-1);
    expect(last?.headers.authorization).toBe("e2e-renewed-business");
    expect(
      (
        await browser.execute(() =>
          (window as any).__associated401Services.oauthService.getAccountAvailability(),
        )
      ).loginProvider,
    ).toBe("zai_cn");
    const beforeHeldProfile = await profiles();
    await control("json-unauthorized", true);
    expect(await query()).toBe(false);
    await browser.waitUntil(async () => (await profiles()) === beforeHeldProfile + 1, {
      timeout: 10000,
    });
    await browser.execute(() => {
      const state = window as any;
      // 加入已存在的后台刷新，作为旧结果处理完成的确定性屏障。
      state.__associatedRefreshJoin =
        state.__associated401Services.oauthService.refreshAccountProfile();
    });
    await browser.execute(async () =>
      (window as any).__associated401Services.oauthService.logoutAll(),
    );
    await control("ok", false);
    const afterLogout = await browser.execute(async () => {
      const state = window as any;
      try {
        return await state.__associatedRefreshJoin;
      } finally {
        delete state.__associatedRefreshJoin;
      }
    });
    expect(afterLogout.loginProvider).toBeNull();
    const after = JSON.parse(await readFile(credentialsFile, "utf8"));
    expect(after["oauth:active_provider"]).toBeUndefined();
    expect(after["oauth:linked_bigmodel"]).toBeUndefined();
    await browser.execute(() => {
      delete (window as any).__associated401Services;
    });
  });
  it("BigModel 资料补齐不改变 ZCode 主体", async function () {
    this.timeout(90_000);
    await seedCredentials("e2e-legacy-migration-primary");
    const { credentialsFile } = getE2EAppDataPaths();
    const credentials = JSON.parse(await readFile(credentialsFile, "utf8"));
    for (const key of Object.keys(credentials))
      if (key.startsWith("oauth:")) delete credentials[key];
    Object.assign(credentials, {
      "oauth:active_provider": "bigmodel",
      "oauth:session_revision": "legacy-migration-original",
      "oauth:bigmodel:access_token": "e2e-legacy-migration-business",
      "oauth:bigmodel:user_info": JSON.stringify({
        id: "e2e-canonical-zcode-subject",
        username: "Original User",
        displayName: "Original User",
      }),
    });
    await writeFile(credentialsFile, JSON.stringify(credentials));
    await seedSettings({
      lastWorkspaceSession: [
        { kind: "local", workspacePath: DEFAULT_WORKSPACE, workspacePurpose: "project" },
      ],
      lastActiveTabIndex: 0,
    });
    await browser.reloadSession();
    await skipOccupationOnboardingIfPresent();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    const readProfile = (validate = false) =>
      browser.execute(
        async (triggerId, shouldValidate) => {
          const element = document.querySelector(`[data-testid="${triggerId}"]`)!;
          let fiber = (element as any)[
            Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
          ];
          while (fiber) {
            const value = fiber.memoizedProps?.value;
            const services = value?.oauthService ? value : fiber.memoizedProps?.services;
            if (services?.oauthService)
              return shouldValidate
                ? services.oauthService.restoreSession()
                : services.oauthService.restoreCachedSession();
            fiber = fiber.return;
          }
          throw new Error("Missing OAuth accessor");
        },
        TID_LOGIN_TRIGGER,
        validate,
      );
    await browser.waitUntil(
      async () => (await readProfile())?.displayName === "Legacy Business Profile",
      { timeout: 15_000 },
    );
    expect((await readProfile())?.id).toBe("e2e-canonical-zcode-subject");
    expect((await readProfile(true))?.id).toBe("e2e-canonical-zcode-subject");
  });
  it("中国区直接退出自动清除套餐可用性投影", async function () {
    this.timeout(90_000);
    const { baseUrls } = await readCodingPlanUpgradeMockRequests();
    await Promise.all(
      baseUrls.map((url) => resetCodingPlanUpgradeMockServer(url, "webview-refresh-provider")),
    );
    await seedCredentials("e2e-cn-zcode-jwt");
    const { credentialsFile } = getE2EAppDataPaths();
    const credentials = JSON.parse(await readFile(credentialsFile, "utf8"));
    for (const key of Object.keys(credentials))
      if (key.startsWith("oauth:")) delete credentials[key];
    Object.assign(credentials, {
      "oauth:active_provider": "zai_cn",
      "oauth:session_revision": "cn-direct-logout",
      "oauth:zai_cn:access_token": "e2e-cn-upstream-oauth",
      "oauth:zai_cn:user_info": JSON.stringify({ user_id: "zcode-primary-user", name: "CN User" }),
      "oauth:linked_bigmodel": JSON.stringify({
        userId: "zcode-primary-user",
        customerId: "e2e-user",
        accessToken: "e2e-linked-bigmodel-jwt",
      }),
    });
    await writeFile(credentialsFile, JSON.stringify(credentials));
    await seedSettings({
      providerFamilyDomain: "bigmodel",
      providerFamilyDomainMigrated: true,
      providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
      lastWorkspaceSession: [
        { kind: "local", workspacePath: DEFAULT_WORKSPACE, workspacePurpose: "project" },
      ],
      lastActiveTabIndex: 0,
    });
    await browser.reloadSession();
    await skipOccupationOnboardingIfPresent();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    const state = await browser.execute(
      async (id, providerId) => {
        const element = document.querySelector(`[data-testid="${id}"]`)!;
        let fiber = (element as any)[
          Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
        ];
        while (fiber) {
          const value = fiber.memoizedProps?.value;
          const services = value?.oauthService ? value : fiber.memoizedProps?.services;
          if (services?.oauthService) {
            (window as any).__cnLogoutProviderSettings = services.providerSettingsService;
            const before = await services.providerSettingsService.refresh("e2e-cn-logout-baseline");
            await services.oauthService.logout();
            // 只读缓存投影，不能靠测试手动refresh掩盖退出通知遗漏。
            const after = await services.providerSettingsService.getView();
            return {
              before: before.providers.find((p: any) => p.providerId === providerId)?.accountState,
              after: after.providers.find((p: any) => p.providerId === providerId)?.accountState,
              login: await services.oauthService.getActiveProvider(),
            };
          }
          fiber = fiber.return;
        }
        throw new Error("Missing account services");
      },
      TID_LOGIN_TRIGGER,
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    );
    expect(state.before?.availability).toBe("available");
    expect(state.login).toBeNull();
    try {
      // AccountSource的订阅异步投影到Registry；等待只读结果，不由测试补发刷新。
      await browser.waitUntil(
        async () =>
          browser.execute(async (providerId) => {
            const view = await (window as any).__cnLogoutProviderSettings.getView();
            return (
              view.providers.find((provider: any) => provider.providerId === providerId)
                ?.accountState?.availability === "unavailable"
            );
          }, BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan),
        { timeout: 5_000, timeoutMsg: "退出后旧套餐投影未被撤销" },
      );
    } finally {
      await browser.execute(() => {
        delete (window as any).__cnLogoutProviderSettings;
      });
    }
  });
});

async function assertCreation(authorization: string) {
  await waitForCodingPlanUpgradeMockRequest(
    (request) =>
      request.method === "POST" &&
      request.path.endsWith("/organization/org-e2e/projects/proj-e2e/api_keys") &&
      request.headers.authorization === authorization &&
      request.keyCreation?.name === "zcode-api-key" &&
      request.keyCreation.usageScene === 1,
    "真实 Host 没有创建 usageScene=1 的套餐 Key",
  );
  await assertTokenIssuance(`Bearer ${authorization.replace(/^Bearer\s+/i, "")}`);
}

async function assertTokenIssuance(authorization: string) {
  await waitForCodingPlanUpgradeMockRequest(
    (request) =>
      request.method === "POST" &&
      request.path.endsWith("/access_tokens") &&
      request.headers.authorization === authorization,
    "Host 未使用登录 JWT 换取 Project Token",
  );
  const result = await readCodingPlanUpgradeMockRequests();
  expect(result.requests.some((request) => request.path.includes("/api_keys/copy/"))).toBe(false);
}

async function clickVisibleId(id: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      for (const node of await browser.$$(`[data-testid="${id}"]`)) {
        if (await node.isDisplayed()) {
          await node.click();
          return true;
        }
      }
      return false;
    },
    { timeout: 15_000, timeoutMsg: `未找到可见入口: ${id}` },
  );
}

async function readSafeAccountAvailability(): Promise<{
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
