import { readFile, writeFile } from "node:fs/promises";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { TID_LOGIN_TRIGGER } from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  seedCredentials,
  seedSettings,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { readCodingPlanUpgradeMockRequests } from "#e2e/helpers/coding-plan-upgrade-webview";
import { sendV4Prompt, switchV4Model, waitForV4Pane } from "#e2e/helpers/v4-conversation";

describe("Highspeed owner 页面占位并发", () => {
  after(async () => {
    await browser.execute(() => {
      const state = window as any;
      state.__restoreOwnerHealthyObserver?.();
      delete state.__restoreOwnerHealthyObserver;
      delete state.__ownerHealthyResults;
    });
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("旧会话null响应不能释放重登后的新查询占位", async function () {
    this.timeout(120_000);
    await seedCredentials("e2e-owner-old-primary");
    const { credentialsFile } = getE2EAppDataPaths();
    const credentials = JSON.parse(await readFile(credentialsFile, "utf8"));
    for (const key of Object.keys(credentials))
      if (key.startsWith("oauth:")) delete credentials[key];
    Object.assign(credentials, {
      "oauth:active_provider": "zai_cn",
      "oauth:session_revision": "owner-ui-old",
      "oauth:zai_cn:access_token": "e2e-owner-cn-upstream",
      "oauth:zai_cn:user_info": JSON.stringify({ user_id: "e2e-owner-user", name: "Owner User" }),
      "oauth:linked_bigmodel": JSON.stringify({
        userId: "e2e-owner-user",
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
    await switchV4Model(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      "GLM-5.3-Flash",
      "high",
    );
    const { baseUrls } = await readCodingPlanUpgradeMockRequests();
    const control = async (operation: string) =>
      Promise.all(
        baseUrls.map(async (base) => {
          const response = await fetch(`${base}/__e2e/coding-plan/${operation}`, {
            method: "POST",
          });
          if (!response.ok) throw new Error(`Owner fixture control failed: ${response.status}`);
        }),
      );
    const countHealthy = async () =>
      (await readCodingPlanUpgradeMockRequests()).requests.filter((request) =>
        request.path.endsWith("/healthy"),
      ).length;
    await browser.execute((id) => {
      const element = document.querySelector(`[data-testid="${id}"]`)!;
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
      ];
      while (fiber) {
        const value = fiber.memoizedProps?.value;
        const services = value?.oauthService ? value : fiber.memoizedProps?.services;
        if (services?.oauthService) {
          const state = window as any;
          state.__ownerHealthyResults = [];
          const originalService = services.highspeedCardService;
          state.__restoreOwnerHealthyObserver = () => {
            services.highspeedCardService = originalService;
          };
          // 仅观察真实RPC Promise，不替换结果、不写store；原服务在此隔离页面销毁时释放。
          services.highspeedCardService = new Proxy(services.highspeedCardService, {
            get(target, key) {
              const original = target[key];
              if (key !== "healthy") return original;
              return async (...args: unknown[]) => {
                try {
                  const result = await Reflect.apply(original, target, args);
                  state.__ownerHealthyResults.push(result === null ? "null" : "usage");
                  return result;
                } catch (error) {
                  state.__ownerHealthyResults.push("error");
                  throw error;
                }
              };
            },
          });
          return;
        }
        fiber = fiber.return;
      }
      throw new Error("Missing services for readonly Promise observer");
    }, TID_LOGIN_TRIGGER);
    await control("highspeed-owner-race");
    const before = await countHealthy();
    await sendV4Prompt("E2E_HIGHSPEED_OWNER_RACE: return a fixed short reply.");
    await waitForV4Pane(
      (pane) => !pane.canStop && pane.timelineText.includes("hs-owner-ui-done"),
      "Owner turn did not complete",
    );
    await browser.waitUntil(async () => (await countHealthy()) === before + 1, {
      timeout: 15_000,
      timeoutMsg: "页面未查询已到期卡",
    });
    // 真实Host OAuth完成发布同主体新会话事件；fixture不打开授权页或代接受法律条款。
    const relogin = await browser.execute(async (id) => {
      const element = document.querySelector(`[data-testid="${id}"]`)!;
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
      ];
      while (fiber) {
        const value = fiber.memoizedProps?.value;
        const services = value?.oauthService ? value : fiber.memoizedProps?.services;
        if (services?.oauthService) {
          await services.oauthService.startOAuthWithPolling("zai_cn");
          return services.oauthService.pollPendingOAuth();
        }
        fiber = fiber.return;
      }
      throw new Error("Missing OAuth RPC accessor");
    }, TID_LOGIN_TRIGGER);
    expect(relogin).toMatchObject({ kind: "session", userInfo: { id: "e2e-owner-user" } });
    await browser.waitUntil(async () => (await countHealthy()) === before + 2, {
      timeout: 5_000,
      timeoutMsg: "重登后未建立新查询占位",
    });
    await control("highspeed-release-one");
    // 真实旧RPC结果已到Renderer后再触发focus；绘制边界让本轮React effect完成。
    await browser.waitUntil(
      async () => browser.execute(() => (window as any).__ownerHealthyResults.includes("null")),
      { timeout: 5_000 },
    );
    await browser.execute(async () => {
      window.dispatchEvent(new Event("focus"));
      for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame);
    });
    expect(await countHealthy()).toBe(before + 2);
    await control("highspeed-release-one");
    // 读取真实SessionPane权威投影，不向UI store写入合成状态。
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const element = document.querySelector('[data-highspeed-status-tag="true"]');
          if (!element) return false;
          let fiber = (element as any)[
            Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
          ];
          while (fiber) {
            const rows = fiber.memoizedProps?.unit?.visibleUserInputs;
            if (rows?.some((row: any) => row.highspeed?.highspeedTps === 50)) return true;
            fiber = fiber.return;
          }
          return false;
        }),
      { timeout: 10_000, timeoutMsg: "新会话TPS没有写回真实transcript" },
    );
    expect(await countHealthy()).toBe(before + 2);
  });
});
