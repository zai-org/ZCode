import { readFile, writeFile } from "node:fs/promises";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { TID_LOGIN_TRIGGER } from "@zcode/shared/test-ids";
import {
  clearAppData,
  getE2EAppDataPaths,
  DEFAULT_WORKSPACE,
  readModelProvider,
  seedCredentials,
  seedSettings,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import {
  openBigModelCodingPlanPersonalUpgradePanel,
  openZaiCodingPlanPersonalUpgradePanel,
} from "#e2e/helpers/coding-plan-upgrade";
import {
  readCodingPlanWebviewLocalStorage,
  readCodingPlanUpgradeMockRequests,
  triggerCodingPlanWebviewPurchaseComplete,
  waitForCodingPlanUpgradeMockRequest,
  waitForCodingPlanWebviewClosed,
  waitForCodingPlanWebviewDisplayed,
} from "#e2e/helpers/coding-plan-upgrade-webview";

describe("BigModel Coding Plan 官网 webview 支付完成 E2E", () => {
  afterEach(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("CPUW-01: webview 通知 App 关闭升级弹窗并刷新当前 provider", async function () {
    this.timeout(120000);

    const setInventoryMode = async (mode: "hold" | "fail" | "ready") => {
      const base =
        process.env.ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL ??
        process.env.BIGMODEL_TEST_API_BASE_URL;
      if (!base) throw new Error("Missing mock URL");
      const response = await fetch(`${base}/__e2e/coding-plan/inventory-mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      expect(response.ok).toBe(true);
    };
    await setInventoryMode("hold");
    await browser.refresh();
    const telemetryFetch = await browser.electron.mock("net", "fetch");
    await telemetryFetch.mockResolvedValue({ ok: true, status: 204 });
    await openBigModelCodingPlanPersonalUpgradePanel(async () => {
      const entry = () => $('[data-testid="sidebar-coding-plan-upgrade-button"]');
      await browser.waitUntil(async () => (await entry().getAttribute("data-disabled")) !== null, {
        timeout: 10000,
      });
      // 测试窗口沿用当前语言；英文专用断言会把正确的中文 loading/error 误判为业务失败。
      expect(await entry().getText()).toMatch(/Loading plans|正在查询套餐/);
      expect(await $('[data-testid="coding-plan-embedded-webview"]').isExisting()).toBe(false);
      await setInventoryMode("fail");
      await browser.waitUntil(
        async () => {
          if (!(await entry().isExisting()))
            await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).click();
          return /Retry|重试/.test(await entry().getText());
        },
        {
          timeout: 15000,
        },
      );
      await telemetryFetch.update();
      expect(
        telemetryFetch.mock.calls.filter(([, init]) =>
          String((init as { body?: string })?.body).includes("coding_plan_upgrade_ck"),
        ),
      ).toHaveLength(0);
      await setInventoryMode("ready");
      await entry().click();
      expect(await $('[data-testid="coding-plan-embedded-webview"]').isExisting()).toBe(false);
      await browser.waitUntil(
        async () => {
          if (!(await entry().isExisting()))
            await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).click();
          const label = await entry().getText();
          return !/Retry|重试|Loading plans|正在查询套餐/.test(label);
        },
        { timeout: 15000 },
      );
      await telemetryFetch.update();
      expect(
        telemetryFetch.mock.calls.filter(([, init]) =>
          String((init as { body?: string })?.body).includes("coding_plan_upgrade_ck"),
        ),
      ).toHaveLength(0);
    });
    await waitForCodingPlanWebviewDisplayed();

    const readEntryEvents = async () => {
      await telemetryFetch.update();
      return telemetryFetch.mock.calls.flatMap(([url, init]) => {
        if (!String(url).includes("/event/report")) return [];
        const body = (init as { body?: string } | undefined)?.body;
        if (!body) return [];
        const event = JSON.parse(body) as {
          element_name: string;
          event_extra_detail: Record<string, string>;
        };
        return event.element_name === "coding_plan_upgrade_ck" ? [event] : [];
      });
    };
    await browser.waitUntil(async () => (await readEntryEvents()).length === 1, {
      timeout: 10000,
      timeoutMsg: "购买入口没有通过 App net.fetch 上报一次",
    });
    const [entry] = await readEntryEvents();
    if (!entry) throw new Error("App 入口事件不存在");
    expect(entry.event_extra_detail.purchase_funnel_id).toBeTruthy();
    expect(entry.event_extra_detail.entry_plan_list).toBe(
      "coding_plan__personal_pro,start_plan__zcode_v3_start_plan",
    );
    await browser.waitUntil(
      async () => {
        const storage = await readCodingPlanWebviewLocalStorage([
          "zcode:coding-plan:report-context",
        ]);
        const context = JSON.parse(storage["zcode:coding-plan:report-context"] || "{}");
        return (
          context.purchase_funnel_id === entry.event_extra_detail.purchase_funnel_id &&
          context.purchase_entry_reporter === "app" &&
          (context.entry_plan_list ?? "") === entry.event_extra_detail.entry_plan_list
        );
      },
      { timeout: 10000, timeoutMsg: "App 上报字段与 WebView 注入上下文不一致" },
    );
    await browser.electron.execute((electron) => {
      const guest = electron.webContents
        .getAllWebContents()
        .find(
          (contents) =>
            contents.getType() === "webview" && contents.getURL().includes("coding-plan"),
        );
      if (!guest) throw new Error("购买 WebView 不存在");
      return new Promise<void>((resolve) => {
        guest.once("did-finish-load", () => resolve());
        guest.reload();
      });
    });
    await browser.waitUntil(
      async () => {
        const storage = await readCodingPlanWebviewLocalStorage([
          "zcode:coding-plan:report-context",
        ]);
        const context = JSON.parse(storage["zcode:coding-plan:report-context"] || "{}");
        return (
          context.purchase_entry_reporter === "app" &&
          context.purchase_funnel_id === entry.event_extra_detail.purchase_funnel_id
        );
      },
      { timeout: 10000 },
    );
    expect(await readEntryEvents()).toHaveLength(1);
    // 账号已迁到 Key ID 换 PAT；Copy Secret 已删除，有效 PAT 在购买刷新时允许复用。
    await waitForCodingPlanUpgradeMockRequest(
      (request) =>
        request.method === "POST" &&
        request.path ===
          "/api/biz/v1/organization/org-e2e/projects/proj-e2e/api_keys/bigmodel-personal-api-key/access_tokens" &&
        request.headers.authorization === "Bearer e2e-bigmodel-oauth-token",
      "账号初始化没有签发 BigModel PAT",
    );
    await completePurchaseAndWaitForRefresh("bigmodel");
    expect(
      (await readCodingPlanUpgradeMockRequests()).requests.some((request) =>
        request.path.includes("/copy/"),
      ),
    ).toBe(false);
    // PAT 由账号 owner 管理，不落盘到 Personal Provider Config。
    expect(
      (await readModelProvider(BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan))?.apiKey ??
        "",
    ).toBe("");
  });

  it("CPUW-CN: 国内关联账号购买只交接主 JWT，不泄漏上游及关联 token", async function () {
    this.timeout(120000);
    await seedCredentials("zai-webview-oauth-token");
    const { credentialsFile } = getE2EAppDataPaths();
    const saved = JSON.parse(await readFile(credentialsFile, "utf8"));
    for (const key of Object.keys(saved)) if (key.startsWith("oauth:")) delete saved[key];
    Object.assign(saved, {
      "oauth:active_provider": "zai_cn",
      "oauth:session_revision": "e2e-embedded-cn",
      "oauth:zai_cn:access_token": "e2e-cn-upstream-oauth",
      "oauth:zai_cn:user_info": JSON.stringify({ user_id: "e2e-cn-user", name: "CN" }),
      "oauth:linked_bigmodel": JSON.stringify({
        userId: "e2e-cn-user",
        customerId: "e2e-user",
        accessToken: "e2e-linked-bigmodel-jwt",
      }),
      zcodejwttoken: "e2e-cn-zcode-jwt",
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
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await openBigModelCodingPlanPersonalUpgradePanel();
    await waitForCodingPlanWebviewDisplayed();
    await browser.waitUntil(
      async () =>
        (await readCodingPlanWebviewLocalStorage(["oauth:active_provider"]))[
          "oauth:active_provider"
        ] === "zai_cn",
      { timeout: 10000 },
    );
    const storage = await readCodingPlanWebviewLocalStorage([
      "zcodejwttoken",
      "oauth:zai_cn:access_token",
      "oauth:bigmodel:access_token",
      "oauth:zai:access_token",
    ]);
    expect(storage).toEqual({
      zcodejwttoken: "e2e-cn-zcode-jwt",
      "oauth:zai_cn:access_token": null,
      "oauth:bigmodel:access_token": null,
      "oauth:zai:access_token": null,
    });
    // 模拟旧无 revision 的会话在异步读取期间被另一进程升级，旧 JWT 不能注入。
    await browser.execute(async (triggerId) => {
      const element = document.querySelector(`[data-testid="${triggerId}"]`)!;
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
      ];
      while (fiber) {
        const value = fiber.memoizedProps?.value;
        const services = value?.oauthService ? value : fiber.memoizedProps?.services;
        if (services?.oauthService) {
          await services.credentialService.delete("oauth:session_revision");
          const original = services.oauthService;
          const state: any = ((window as any).__embeddedSessionProbe = {
            services,
            original,
            captured: false,
            checked: false,
            release: null,
          });
          services.oauthService = new Proxy(original, {
            get(target, key) {
              if (key === "getWebsiteSession")
                return async () => {
                  const snapshot = await original.getWebsiteSession();
                  if (state.captured) return snapshot;
                  state.captured = true;
                  state.oldRevision = snapshot.sessionRevision;
                  await new Promise((resolve) => {
                    state.release = resolve;
                  });
                  return snapshot;
                };
              if (key === "getAccountAvailability")
                return async () => {
                  const result = await original.getAccountAvailability();
                  state.checked = true;
                  return result;
                };
              return Reflect.get(target, key);
            },
          });
          (window as any).__testActions.setTheme(
            document.documentElement.classList.contains("dark") ? "zai-light" : "zai-dark",
          );
          return;
        }
        fiber = fiber.return;
      }
      throw new Error("Missing OAuth accessor");
    }, TID_LOGIN_TRIGGER);
    try {
      await browser.waitUntil(
        () => browser.execute(() => (window as any).__embeddedSessionProbe.captured),
        { timeout: 10000 },
      );
      expect(
        await browser.execute(() => (window as any).__embeddedSessionProbe.oldRevision),
      ).toBeNull();
      await browser.execute(async () => {
        const state = (window as any).__embeddedSessionProbe;
        await state.services.credentialService.save(
          "oauth:session_revision",
          "e2e-upgraded-revision",
        );
        await state.services.credentialService.save("zcodejwttoken", "e2e-new-zcode-jwt");
        state.release();
      });
      await browser.waitUntil(
        () => browser.execute(() => (window as any).__embeddedSessionProbe.checked),
        { timeout: 10000 },
      );
      await browser.executeAsync((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      expect((await readCodingPlanWebviewLocalStorage(["zcodejwttoken"])).zcodejwttoken).not.toBe(
        "e2e-cn-zcode-jwt",
      );
      expect(await $('[data-testid="coding-plan-upgrade-surface"]').getText()).toMatch(
        /Couldn't sign you into the plan page|无法登录到套餐页/,
      );
    } finally {
      await browser.execute(() => {
        const state = (window as any).__embeddedSessionProbe;
        state.release?.();
        state.services.oauthService = state.original;
        delete (window as any).__embeddedSessionProbe;
      });
    }
    await triggerCodingPlanWebviewPurchaseComplete("bigmodel");
    await waitForCodingPlanWebviewClosed();
  });

  it("CPUW-03: Z.ai webview 通知 App 关闭升级弹窗并刷新当前 provider 与 Team Plan products", async function () {
    this.timeout(120000);

    await prepareZaiCodingPlanUpgradeState();
    await openZaiCodingPlanPersonalUpgradePanel();
    await waitForCodingPlanWebviewDisplayed();

    await waitForZaiWebviewCredentialsInjected();

    await completePurchaseAndWaitForRefresh("zai");
    // PAT 由账号 owner 管理，不落盘到 Personal Provider Config。
    expect(
      (await readModelProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan))?.apiKey ?? "",
    ).toBe("");
  });
});

async function completePurchaseAndWaitForRefresh(provider: "bigmodel" | "zai") {
  // 旧断言会命中启动请求；冻结边界后只读购买完成后的新增请求。
  const before = (await readCodingPlanUpgradeMockRequests()).requests;
  // 订阅接口使用已签发的 PAT，企业目录仍使用 OAuth，不能把两种凭据混作同一个断言。
  const subscriptionAuthorization = before.findLast(
    (request) => request.path === "/api/biz/subscription/list",
  )?.headers.authorization;
  expect(Boolean(subscriptionAuthorization)).toBe(true);
  await triggerCodingPlanWebviewPurchaseComplete(provider);
  await waitForCodingPlanWebviewClosed();
  const expectedToken =
    provider === "bigmodel" ? "e2e-bigmodel-oauth-token" : "zai-webview-oauth-token";
  await browser.waitUntil(
    async () => {
      const requests = (await readCodingPlanUpgradeMockRequests()).requests.slice(before.length);
      return ["/api/biz/subscription/list", "/api/biz/subscription/enterprise/v2/pricing"].every(
        (path) =>
          requests.some(
            (request) =>
              request.path === path &&
              request.headers.authorization ===
                (path.endsWith("/subscription/list") ? subscriptionAuthorization : expectedToken),
          ),
      );
    },
    { timeout: 30000, timeoutMsg: `${provider} 购买完成后未按当前账号刷新订阅与企业套餐` },
  );
}

async function prepareZaiCodingPlanUpgradeState() {
  await clearAppData();
  await seedCredentials("zai-webview-oauth-token");
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
  await browser.reloadSession();
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);
}

async function waitForZaiWebviewCredentialsInjected() {
  let latestStorage: Record<string, string | null> = {};
  await browser.waitUntil(
    async () => {
      latestStorage = await readCodingPlanWebviewLocalStorage([
        "oauth:zai:access_token",
        "zcodejwttoken",
        "oauth:bigmodel:access_token",
      ]);
      return (
        latestStorage["oauth:zai:access_token"] === "zai-webview-oauth-token" &&
        latestStorage.zcodejwttoken === "zai-webview-oauth-token" &&
        latestStorage["oauth:bigmodel:access_token"] === null
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `Z.ai credentials 没有注入到 Coding Plan webview localStorage: ${JSON.stringify(latestStorage)}`,
    },
  );
}
