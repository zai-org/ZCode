import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_MODEL_PROVIDER_IDS, type ProviderFamilyConnectionSelection } from "@zcode/shared";
import {
  TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
  TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_LOGIN_TRIGGER,
  TID_CHAT_CONTEXT_USAGE_TRIGGER,
  TID_SETTINGS_USAGE_TAB,
  TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_V4_MODEL_CONFIG,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  getE2EAppDataPaths,
  quitElectronAppGracefully,
  readModelProviders,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { waitForProviderConfigPolling } from "#e2e/helpers/provider-config-polling";
import { selectRegistryProviderModelById, UPSTREAM_MODEL } from "#e2e/helpers/upstream-provider";
import { seedPersistedModelSelection } from "#e2e/helpers/model-provider-restart";
import { sel } from "#e2e/helpers/selectors";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";

// 修复原因：WDIO 为每个 run 注入隔离 HOME，但 os.homedir() 在 Node 进程中不会
// 随环境变量动态变化。沿用 homedir() 会把场景设置和 provider seed 写到开发机的
// ~/.zcode，Electron 读取的却是本轮隔离 HOME；同时新版 Personal Config 文件名是
// provider_config.json，不是旧的 config.json。统一复用 desktop-app 的路径合同，确保
// 测试写入和应用读取的是同一份 fixture。
const E2E_APP_DATA_PATHS = getE2EAppDataPaths();
const E2E_STORAGE_ROOT = E2E_APP_DATA_PATHS.storageRoot;
const SETTINGS_FILE = join(E2E_APP_DATA_PATHS.appDataDir, "setting.json");
const CREDENTIALS_FILE = E2E_APP_DATA_PATHS.credentialsFile;
const TEAM_PLAN_KEY = "team:bigmodel:product-team-a:org-team-a:proj-team-a";
// 修复原因：Composer 团队行的分组 key 是完整连接身份（composerConnectionKey），
// 不是 registry-provider:<id>；用默认 key 选团队模型会在准备阶段找不到分组。
const TEAM_PLAN_GROUP_KEY = JSON.stringify([
  "bigmodel",
  "team-coding-plan",
  "product-team-a",
  "org-team-a",
  "proj-team-a",
]);
const PERSONAL_PLAN_KEY = "account:bigmodel-individual-coding-plan";
const PERSONAL_PLAN_CONNECTION_KEY = `coding-plan:${PERSONAL_PLAN_KEY}`;
const BIGMODEL_ACCOUNT_NAV_KEY = `preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`;
// 与本轮 Builtin catalog 一致；旧 GLM-5.2 已不在 Account Provider 的可选模型中。
const BIGMODEL_E2E_MODEL = "GLM-5.3";

type CodingPlanScenario = "personalOnly" | "teamOnly" | "both";
type CodingPlanFaultMode =
  | "none"
  | "optionalActivity"
  | "quotaBusinessFailure"
  | "quotaFailure"
  | "startBalance"
  | "startBalanceFailure"
  | "unavailableTeam"
  | "expiredTeam"
  | "twoTeams";
type CodingPlanResetScenario =
  | "none"
  | "emptyThenGrant"
  | "existingMultiple"
  | "fiveHourUse"
  | "multiFiveHourUse"
  | "multiFiveHourUseLagging"
  | "urgentOpportunity"
  | "weekToggle";

describe("Team Plan 设置与使用统计 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("CTP-13: Start balance 限流显示重试，恢复后展示套餐", async function () {
    this.timeout(120000);
    const evidenceDir =
      process.env.ZCODE_E2E_ARTIFACT_DIR || join(process.cwd(), ".e2e-artifacts", "coding-plan");
    await mkdir(evidenceDir, { recursive: true });
    await prepareScenario(
      "personalOnly",
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
      "startBalanceFailure",
    );
    await openModelProviderSettings();
    await clickVisibleTestIdByDom(
      testId(
        TID_MODEL_PROVIDER_NAV_ITEM,
        `coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`,
      ),
      {
        timeout: 10000,
        timeoutMsg: "BigModel 入口缺失",
      },
    );
    await assertBodyTextIncludesAny(["Retry", "重试"]);
    await assertBodyTextIncludesAny(["Fetch failed", "获取失败"]);
    await browser.saveScreenshot(join(evidenceDir, "coding-plan-start-failure.png"));
    await assertBodyTextExcludes([
      "Could not verify Coding Plan entitlement. Connect again and retry.",
      "暂时无法确认 Coding Plan 权益，请重新连接后再试。",
    ]);
    await setMockScenario("personalOnly", "startBalance");
    // 失败结果也有明确的一秒复用窗口；在窗口结束后验证用户重试恢复。
    await browser.pause(1000);
    await clickVisibleButtonByText(["Retry", "重试"]);
    // GLM-5-Turbo 已退役；恢复后按共享 Start balance 返回的当前模型断言。
    await assertBodyTextIncludes(["GLM-5.3"]);
    await browser.waitUntil(
      async () =>
        !(await browser.execute(() => document.body.innerText)).match(/Fetch failed|获取失败/),
      { timeout: 15000, timeoutMsg: "重试后失败状态未恢复" },
    );
    await browser.saveScreenshot(join(evidenceDir, "coding-plan-start-recovered.png"));
  });

  it("CTP-01: 登录后不进入设置页也应获取 Team Plan pricing", async function () {
    this.timeout(90000);

    await prepareScenario("both", TEAM_PLAN_KEY);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);

    await waitForMockRequest(
      (request) => request.path.endsWith("/subscription/enterprise/v2/pricing"),
      "未在不进入设置页时请求企业套餐 pricing",
    );
    await expect($(sel(TID_SETTINGS_PAGE))).not.toBeDisplayed();
  });

  it("CTP-02: 设置页连接方式应展示个人 Coding Plan 和 Team Plan", async function () {
    this.timeout(120000);

    await prepareScenario("both", PERSONAL_PLAN_KEY);
    await openModelProviderSettings();
    await clickVisibleTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, BIGMODEL_ACCOUNT_NAV_KEY), {
      timeout: 30000,
      timeoutMsg: "BigModel 供应商导航项没有出现",
    });
    await assertConnectionModeOptionsInclude([
      {
        key: PERSONAL_PLAN_CONNECTION_KEY,
        labels: ["Individual Plan", "个人套餐"],
      },
      { key: TEAM_PLAN_KEY, labels: ["Team Org"] },
    ]);

    await selectConnectionModeOptionByTestId(
      testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, TEAM_PLAN_KEY),
      "Team Org",
    );
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        const selection = settings.providerFamilyConnectionSelections?.bigmodel;
        return (
          selection?.kind === "team-coding-plan" &&
          selection.productId === "product-team-a" &&
          selection.organizationId === "org-team-a" &&
          selection.projectId === "proj-team-a"
        );
      },
      {
        timeout: 15000,
        timeoutMsg: "选择 Team Plan 后没有写入结构化 BigModel connection selection",
      },
    );
  });

  for (const empty of [false, true]) {
    it(`CTP-${empty ? 26 : 25}: 未登录${empty ? "无 Provider 直接打开设置" : "API 正常选择且无团队登录错误"}`, async function () {
      this.timeout(240000);
      await prepareScenario("both", PERSONAL_PLAN_KEY, "none", "none", "en-US", true);
      for (const width of [1100, 390]) {
        for (const theme of ["zai-light", "zai-dark"] as const) {
          const disabledProviders = await browser.execute(async (remove) => {
            const element = document.querySelector('[data-testid="v4-model-config"]')!;
            let fiber = (element as any)[
              Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
            ];
            let service: any;
            while (fiber && !service) {
              service =
                fiber.memoizedProps?.value?.providerSettingsService ??
                fiber.memoizedProps?.services?.providerSettingsService;
              fiber = fiber.return;
            }
            if (!service) throw new Error("ProviderSettingsService not found");
            const disabledProviders: { providerId: string; config: Record<string, unknown> }[] = [];
            if (remove) {
              const view = await service.getView();
              for (const provider of view.providers) {
                if (provider.effectiveConfig.access?.type !== "zhipu-account" && provider.enabled) {
                  await service.savePersonalProviderOverlay(
                    provider.providerId,
                    provider.personalConfig ?? {},
                    { enabled: false },
                  );
                  // 保存接口替换整个 Overlay，空对象会抹掉自定义 API 配置。
                  disabledProviders.push({
                    providerId: provider.providerId,
                    config: provider.personalConfig ?? {},
                  });
                }
              }
            }
            await service.refresh("e2e-logged-out-composer");
            return disabledProviders;
          }, empty);
          await setRendererViewport(width, 850);
          await setSettingsTheme(theme);
          if (empty) {
            await clickVisibleTestIdByDom(TID_CHAT_MODEL_SELECT_TRIGGER, { timeout: 15000 });
            await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
            expect(
              await browser.execute(
                () => document.querySelector("[data-composer-model-list]") === null,
              ),
            ).toBe(true);
            await clickVisibleTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15000 });
            // 空配置仅属于本次布局；恢复夹具，避免下一次启动被空配置引导接管。
            await browser.execute(async (providers) => {
              const element = document.querySelector('[data-testid="v4-model-config"]')!;
              let fiber = (element as any)[
                Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
              ];
              let service: any;
              while (fiber && !service) {
                service =
                  fiber.memoizedProps?.value?.providerSettingsService ??
                  fiber.memoizedProps?.services?.providerSettingsService;
                fiber = fiber.return;
              }
              if (!service) throw new Error("ProviderSettingsService not found");
              for (const provider of providers)
                await service.savePersonalProviderOverlay(provider.providerId, provider.config, {
                  enabled: true,
                });
            }, disabledProviders);
          } else {
            await selectRegistryProviderModelById(UPSTREAM_MODEL, {
              providerId: process.env.E2E_PROVIDER_ID,
            });
            await clickVisibleTestIdByDom(TID_CHAT_MODEL_SELECT_TRIGGER, { timeout: 15000 });
            expect(
              await browser.execute(
                () =>
                  document.querySelector("[data-composer-model-list]")?.textContent?.length ?? 0,
              ),
            ).toBeGreaterThan(0);
            expect(
              await browser.execute(() =>
                document.body.textContent?.includes("coding_plan_oauth_required"),
              ),
            ).toBe(false);
            await browser.keys("Escape");
          }
        }
      }
      await clearRendererViewport();
    });
  }

  it("CTP-30: 个人团队切换列表无横向溢出，保留纵向滚动", async function () {
    this.timeout(240000);
    try {
      for (const width of [1100, 390])
        for (const theme of ["zai-light", "zai-dark"] as const) {
          await prepareScenario("both", PERSONAL_PLAN_KEY);
          await setRendererViewport(width, 850);
          await setSettingsTheme(theme);
          await clickVisibleTestIdByDom(TID_CHAT_MODEL_SELECT_TRIGGER, { timeout: 15000 });
          await browser.execute(() => {
            const samples: { client: number; scroll: number }[] = [];
            const record = () => {
              for (const list of document.querySelectorAll<HTMLElement>(
                "[data-composer-provider-list]",
              ))
                if (list.getBoundingClientRect().width > 0)
                  samples.push({ client: list.clientWidth, scroll: list.scrollWidth });
            };
            const observer = new MutationObserver(record);
            observer.observe(document.body, { subtree: true, childList: true, attributes: true });
            Object.assign(window, {
              __providerWidthProbe: { samples, stop: () => observer.disconnect() },
            });
          });
          for (const [label, providerId] of [
            ["BigModel Team Org", BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan],
            ["BigModel Individual", BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan],
          ]) {
            await $('[data-testid="composer-provider-trigger"]').waitForClickable({
              timeout: 15000,
            });
            await $('[data-testid="composer-provider-trigger"]').click();
            const row = $('[aria-label="' + label + '"]');
            await row.waitForDisplayed({ timeout: 15000 });
            // 原因：负边距分隔线超出滚动列表 4px；实际布局尺寸才证明没有横向溢出。
            const geometry = await browser.execute(() => {
              const list = document.querySelector<HTMLElement>("[data-composer-provider-list]")!;
              const before = { client: list.clientWidth, scroll: list.scrollWidth };
              const style = list.getAttribute("style");
              // 当前目录可能只有两项；固定 96px 不产生溢出，无法验证纵向滚动。
              const rows = list.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
              if (rows.length < 2) throw new Error("滚动夹具至少需要两个 Provider");
              list.style.maxHeight = `${rows[0]!.getBoundingClientRect().height}px`;
              const vertical = list.scrollHeight > list.clientHeight;
              list.scrollTop = 10;
              const scrolled = list.scrollTop > 0;
              list.scrollTop = 0;
              if (style === null) list.removeAttribute("style");
              else list.setAttribute("style", style);
              return { ...before, vertical, scrolled };
            });
            expect(geometry.scroll).toBeLessThanOrEqual(geometry.client);
            expect(geometry.vertical && geometry.scrolled).toBe(true);
            await row.click();
            await browser.waitUntil(
              async () =>
                (await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-provider")) === providerId,
              { timeout: 15000 },
            );
          }
          const samples = await browser.execute(() => {
            const probe = (window as any).__providerWidthProbe;
            probe.stop();
            return probe.samples as { client: number; scroll: number }[];
          });
          await writeFile(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `provider-width-${width}-${theme}.json`),
            JSON.stringify(samples, null, 2),
          );
          expect(samples.length).toBeGreaterThan(0);
          expect(samples.every((sample) => sample.scroll <= sample.client)).toBe(true);
          await browser.keys("Escape");
        }
    } finally {
      await browser.execute(() => (window as any).__providerWidthProbe?.stop());
      await clearRendererViewport();
    }
  });

  it("CTP-27: 登录加载团队后登出，不保留旧组织目录", async function () {
    this.timeout(240000);
    try {
      for (const width of [1100, 390])
        for (const theme of ["zai-light", "zai-dark"] as const) {
          await prepareScenario("both", PERSONAL_PLAN_KEY);
          await setRendererViewport(width, 850);
          await setSettingsTheme(theme);
          await selectRegistryProviderModelById(UPSTREAM_MODEL, {
            providerId: process.env.E2E_PROVIDER_ID,
          });
          await clickVisibleTestIdByDom(TID_CHAT_MODEL_SELECT_TRIGGER, { timeout: 15000 });
          await $('[data-testid="composer-provider-trigger"]').click();
          await $('[aria-label="BigModel Team Org"]').waitForClickable({ timeout: 15000 });
          await $('[aria-label="BigModel Team Org"]').click();
          await browser.waitUntil(
            async () =>
              (await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-provider")) ===
              BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
            { timeout: 15000 },
          );
          await browser.keys("Escape");
          const usageTrigger = await $(sel(TID_CHAT_CONTEXT_USAGE_TRIGGER));
          await usageTrigger.waitForDisplayed({ timeout: 15000 });
          await usageTrigger.moveTo();
          await browser.waitUntil(
            async () =>
              (await readComposerTeamUsageSource())?.startsWith("team:bigmodel:") === true,
            { timeout: 15000, timeoutMsg: "团队用量来源未加载" },
          );
          await browser.keys("Escape");
          await clickVisibleTestIdByDom(TID_CHAT_MODEL_SELECT_TRIGGER, { timeout: 15000 });
          await $('[data-testid="composer-provider-trigger"]').click();
          await $('[aria-label="BigModel Team Org"]').waitForDisplayed({ timeout: 15000 });
          // 保持同一 Renderer 挂载：重启会抹掉内存缓存，不能验证登出清理边界。
          await installConnectionBoundaryProbe("logout");
          await browser.waitUntil(
            async () => !(await $('[aria-label="BigModel Team Org"]').isExisting()),
            { timeout: 15000, timeoutMsg: "登出后仍显示上一账号组织" },
          );
          await browser.keys("Escape");
          await browser.waitUntil(async () => (await readComposerTeamUsageSource()) === null, {
            timeout: 5000,
            timeoutMsg: "Provider 刷新前旧团队用量仍可见",
          });
          await browser.execute(async () => {
            await (window as any).__logoutBoundaryRelease();
          });
          await selectRegistryProviderModelById(UPSTREAM_MODEL, {
            providerId: process.env.E2E_PROVIDER_ID,
          });
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "logout-" + width + "-" + theme + ".png"),
          );
        }
    } finally {
      const diagnostic = await browser.execute(() => (window as any).__logoutBoundaryAuth?.());
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "logout-boundary.json"),
        JSON.stringify({ auth: diagnostic, source: await readComposerTeamUsageSource() }),
      );
      await browser.execute(async () => {
        await (window as any).__logoutBoundaryRelease?.();
      });
      await clearRendererViewport();
    }
  });

  for (const mode of ["cas", "mismatch", "refresh-failure"] as const) {
    it(
      "CTP-" +
        (mode === "cas" ? "28" : mode === "mismatch" ? "29" : "31") +
        ": " +
        mode +
        " 冲突解除锁并允许重试",
      async function () {
        this.timeout(120000);
        await prepareScenario(
          "both",
          mode === "refresh-failure" ? TEAM_PLAN_KEY : PERSONAL_PLAN_KEY,
          mode === "refresh-failure" ? "twoTeams" : "none",
        );
        const targetRow =
          mode === "refresh-failure"
            ? '[aria-label="BigModel Active Team"]'
            : '[aria-label="BigModel Team Org"]';
        await clickVisibleTestIdByDom(TID_CHAT_MODEL_SELECT_TRIGGER, { timeout: 15000 });
        await $('[data-testid="composer-provider-trigger"]').click();
        await $(targetRow).waitForClickable({ timeout: 15000 });
        await installConnectionBoundaryProbe(mode);
        try {
          // 端口替换触发真实目录重读；等待它结束，再从正常菜单发起被测命令。
          await browser.keys("Escape");
          await browser.keys("Escape");
          // SessionPane 是 memo owner；草稿编辑让它重新读取注入后的服务端口，不发送模型请求。
          await $(sel(TID_V4_COMPOSER_INPUT)).click();
          await browser.keys("E2E_CONNECTION_BOUNDARY");
          if (mode === "refresh-failure") {
            // 注入端口后的草稿重渲染会恢复默认 Provider；先用真实菜单建立 Team 起点，
            // 否则实际测成 API → Team 的首次读取失败，不是同 Provider 的展示刷新失败。
            await clickVisibleTestIdByDom(TID_CHAT_MODEL_SELECT_TRIGGER, { timeout: 15000 });
            await $('[data-testid="composer-provider-trigger"]').click();
            await $('[aria-label="BigModel Team Org"]').waitForClickable({ timeout: 15000 });
            await $('[aria-label="BigModel Team Org"]').click();
            await browser.waitUntil(
              async () =>
                (await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-provider")) ===
                BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
              { timeout: 15000, timeoutMsg: "起点未进入团队 Provider" },
            );
            // 本例要求旧 ready 已显示；仅 providerId 就绪时，能力仍可能在首次水合中。
            // 先等真实模型能力，避免把启动水合失败误当成“稳定连接的展示重读失败”。
            await browser.waitUntil(
              async () =>
                (await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-thought-levels"))
                  ?.split(",")
                  .includes("max") === true,
              { timeout: 15000, timeoutMsg: "起点团队模型能力尚未水合" },
            );
            await browser.keys("Escape");
            await browser.keys("Escape");
          }
          await clickVisibleTestIdByDom(TID_CHAT_MODEL_SELECT_TRIGGER, { timeout: 15000 });
          await $('[data-testid="composer-provider-trigger"]').waitForClickable({ timeout: 15000 });
          await $('[data-testid="composer-provider-trigger"]').click();
          await $(targetRow).waitForClickable({ timeout: 15000 });
          await browser.execute(() => (window as any).__connectionBoundaryProbe.arm());
          await $(targetRow).click();
          if (mode === "mismatch") {
            await browser.waitUntil(
              async () =>
                (await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-provider")) ===
                "e2e-upstream",
              { timeout: 15000, timeoutMsg: "展示 owner 未投影冲突选择" },
            );
            // 展示冲突会更换当前 Provider，根菜单可能因此重挂载；重开正常入口检查错误。
            await browser.keys("Escape");
            await browser.keys("Escape");
            await clickVisibleTestIdByDom(TID_CHAT_MODEL_SELECT_TRIGGER, { timeout: 15000 });
          }
          await $('[role="alert"]').waitForDisplayed({ timeout: 15000 });
          expect(await $('[data-testid="composer-provider-loading"]').isExisting()).toBe(false);
          const trace = await browser.execute(
            () => (window as any).__connectionBoundaryProbe.trace,
          );
          expect(trace.length).toBeGreaterThan(0);
          await writeFile(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "connection-" + mode + ".json"),
            JSON.stringify(trace, null, 2),
          );
          if (mode === "cas")
            expect((await readSettings()).providerFamilyConnectionSelections?.zai).toEqual({
              kind: "individual-coding-plan",
            });
        } finally {
          const diagnostics = await browser.execute(() => {
            const probe = (window as any).__connectionBoundaryProbe;
            const element = document.querySelector(
              '[data-testid="v4-model-config"]',
            ) as HTMLElement;
            return {
              trace: probe.trace,
              config: element?.dataset,
              alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(
                (e) => e.textContent,
              ),
            };
          });
          await writeFile(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "boundary-" + mode + ".json"),
            JSON.stringify(diagnostics, null, 2),
          );
          await browser.execute((mode) => {
            const probe = (window as any).__connectionBoundaryProbe;
            if (mode === "refresh-failure") probe.recover();
            else probe.restore();
          }, mode);
        }
        await browser.keys("Escape");
        await browser.keys("Escape");
        if (mode !== "refresh-failure") {
          await $(sel(TID_V4_COMPOSER_INPUT)).click();
          await browser.keys("E2E_CONNECTION_RETRY");
        }
        await clickVisibleTestIdByDom(TID_CHAT_MODEL_SELECT_TRIGGER, { timeout: 15000 });
        const trigger = $('[data-testid="composer-provider-trigger"]');
        await trigger.waitForClickable({ timeout: 15000 });
        await trigger.click();
        await $(targetRow).waitForClickable({ timeout: 15000 });
        await $(targetRow).click();
        await browser.waitUntil(
          async () =>
            (await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-provider")) ===
            BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
          { timeout: 15000 },
        );
        if (mode === "refresh-failure") {
          await browser.waitUntil(
            async () =>
              browser.execute(() =>
                (window as any).__connectionBoundaryProbe.trace.some(
                  (entry: any) => entry.phase === "obsolete-started",
                ),
              ),
            { timeout: 15000 },
          );
          await browser.execute(() => (window as any).__connectionBoundaryProbe.supersede());
          await browser.waitUntil(
            async () =>
              browser.execute(() =>
                (window as any).__connectionBoundaryProbe.trace.some(
                  (entry: any) => entry.phase === "presentation-recovered",
                ),
              ),
            { timeout: 15000 },
          );
          await browser.execute(() => (window as any).__connectionBoundaryProbe.rejectObsolete());
        }
        if (mode === "refresh-failure")
          await browser.waitUntil(
            async () =>
              browser.execute(() =>
                (window as any).__connectionBoundaryProbe.trace.some(
                  (entry: any) => entry.phase === "presentation-recovered",
                ),
              ),
            { timeout: 15000, timeoutMsg: "同连接重试没有请求展示重读" },
          );
        await browser.waitUntil(
          async () => !(await $('[data-testid="composer-provider-loading"]').isExisting()),
          { timeout: 15000 },
        );
        expect(await $('[role="alert"]').isExisting()).toBe(false);
        await browser.keys("Escape");
        if (mode === "refresh-failure") {
          const trace = await browser.execute(
            () => (window as any).__connectionBoundaryProbe.trace,
          );
          const recoveredAt = trace.findIndex((entry: any) => entry.phase === "fault-recovered");
          expect(
            trace.slice(recoveredAt + 1).some((entry: any) => entry.phase === "target-event"),
          ).toBe(false);
          // 冷启动目录刷新次数不是合同；恢复必须读取本次已同步的 revision，而非写死 2。
          const synchronized = trace.findLast(
            (entry: any) => entry.phase === "target-synchronized",
          );
          expect(synchronized).toBeDefined();
          expect(
            trace.some(
              (entry: any) =>
                entry.phase === "presentation-recovered" &&
                entry.revision === synchronized.revision,
            ),
          ).toBe(true);
          await writeFile(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "connection-retry-no-event.json"),
            JSON.stringify(trace, null, 2),
          );
          await browser.execute(() => (window as any).__connectionBoundaryProbe.restore());
        }
      },
    );
  }

  it("CTP-24: Composer 仅隐藏过期团队，其他有效团队可切换", async function () {
    this.timeout(240000);
    // 共用 Provider 的 availability 只描述当前团队；每个布局都从过期团队启动，验证真实切换。
    try {
      for (const width of [1100, 390]) {
        for (const theme of ["zai-light", "zai-dark"] as const) {
          await prepareScenario("both", TEAM_PLAN_KEY, "expiredTeam", "none", "en-US");
          const states = await browser.execute(async () => {
            const element = document.querySelector('[data-testid="v4-model-config"]')!;
            let fiber = (element as any)[
              Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
            ];
            let service: any;
            while (fiber && !service) {
              service =
                fiber.memoizedProps?.value?.providerSettingsService ??
                fiber.memoizedProps?.services?.providerSettingsService;
              fiber = fiber.return;
            }
            if (!service) throw new Error("ProviderSettingsService not found");
            const view = await service.refresh("e2e-expired-team");
            return view.providers.map((provider: any) => ({
              id: provider.providerId,
              state: provider.accountState?.availability,
            }));
          });
          expect(
            states.find(
              (provider: { id: string; state?: string }) =>
                provider.id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
            )?.state,
          ).toBe("unavailable");
          await setRendererViewport(width, 850);
          await setSettingsTheme(theme);
          const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
          await trigger.waitForClickable({ timeout: 30000 });
          await trigger.click();
          const connection = $('[data-testid="composer-provider-trigger"]');
          await connection.waitForDisplayed({ timeout: 15000 });
          await connection.click();
          await $("[data-composer-provider-list]").waitForDisplayed({ timeout: 10000 });
          expect(await $('[aria-label="BigModel Team Org"]').isExisting()).toBe(false);
          const activeTeam = $('[aria-label="BigModel Active Team"]');
          await activeTeam.waitForClickable({ timeout: 15000 }).catch(async (cause) => {
            const menu = await browser.execute(() => {
              const element = document.querySelector('[data-testid="v4-model-config"]')!;
              let fiber = (element as any)[
                Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
              ];
              while (fiber && !fiber.memoizedProps?.composerOptions) fiber = fiber.return;
              return {
                text: document.querySelector("[data-composer-provider-list]")?.textContent,
                groups: fiber?.memoizedProps?.composerOptions?.providerMenu?.groups?.map(
                  (g: any) => ({ key: g.key, badge: g.labelBadge }),
                ),
              };
            });
            throw new Error(`有效团队缺失：${JSON.stringify(menu)}`, { cause });
          });
          await activeTeam.click();
          await browser.waitUntil(
            async () => {
              const selection = (await readSettings()).providerFamilyConnectionSelections?.bigmodel;
              return (
                selection?.kind === "team-coding-plan" &&
                selection.organizationId === "org-team-b" &&
                selection.projectId === "proj-team-b"
              );
            },
            { timeout: 15000, timeoutMsg: "有效团队完整身份未写入" },
          );
          await browser.waitUntil(
            async () =>
              (await connection.getText()).includes("Active Team") &&
              (await connection.getAttribute("aria-busy")) !== "true",
            { timeout: 30000, timeoutMsg: "有效团队切换未完成" },
          );
          await browser.keys("Escape");
          await browser.keys("Escape");
        }
      }
    } finally {
      await clearRendererViewport();
    }
  });

  it("CTP-20: Composer 供应商列表直接展示团队，切换更新实际身份", async function () {
    this.timeout(120000);
    await prepareScenario("both", PERSONAL_PLAN_KEY, "unavailableTeam");
    // 独立回放不能依赖前序用例留下的草稿；连接设置不等于 Composer 选模意图。
    await selectRegistryProviderModelById(BIGMODEL_E2E_MODEL, {
      includePlainModelFallback: false,
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });
    const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
    await trigger.waitForClickable({ timeout: 30000 });
    await trigger.click();
    const connection = $('[data-testid="composer-provider-trigger"]');
    await connection.waitForDisplayed({ timeout: 15000 });
    expect(await $('[data-testid="composer-provider-trigger"]').getText()).toContain("BigModel");
    expect(await $('[data-testid="composer-connection-trigger"]').isExisting()).toBe(false);
    const slider = $('[data-testid="composer-thought-slider"]');
    await slider.waitForDisplayed({ timeout: 10000 });
    await slider.click();
    await browser.keys("Home");
    await browser.keys("ArrowRight");
    await browser.waitUntil(
      async () => Boolean(await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-thought")),
      { timeout: 10000 },
    );
    const chosenThought = await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-thought");
    await browser.execute(() => {
      const samples: unknown[] = [];
      const record = () => {
        const config = document.querySelector('[data-testid="v4-model-config"]');
        const slider = document.querySelector('[data-testid="composer-thought-slider"]');
        samples.push({
          at: performance.now(),
          provider: config?.getAttribute("data-provider"),
          thought: config?.getAttribute("data-thought"),
          levels: config?.getAttribute("data-thought-levels"),
          effort: slider?.getAttribute("aria-valuetext"),
          title: document.querySelector('[data-testid="composer-provider-trigger"]')?.textContent,
          loading: Boolean(document.querySelector('[data-testid="composer-provider-loading"]')),
          busy: document
            .querySelector('[data-testid="composer-provider-trigger"]')
            ?.getAttribute("aria-busy"),
        });
      };
      const observer = new MutationObserver(record);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      Object.assign(window, {
        __composerSwitchProbe: { samples, stop: () => observer.disconnect() },
      });
      record();
    });
    await connection.click();
    const team = $('[aria-label="BigModel Team Org"]');
    await team.waitForDisplayed({ timeout: 10000 });
    expect(await $('[aria-label="BigModel Unavailable Team"]').isExisting()).toBe(false);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "composer-connections-before.png"),
    );
    await team.click();
    await browser.waitUntil(
      async () =>
        (await readSettings()).providerFamilyConnectionSelections?.bigmodel?.kind ===
        "team-coding-plan",
      { timeout: 15000 },
    );
    await browser.waitUntil(
      async () =>
        (await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-provider")) ===
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      { timeout: 15000 },
    );
    expect(await trigger.getAttribute("aria-expanded")).toBe("true");
    await connection.waitForClickable({ timeout: 15000 });
    const samples = await browser.execute(() => {
      const probe = (
        window as unknown as { __composerSwitchProbe: { samples: unknown[]; stop: () => void } }
      ).__composerSwitchProbe;
      probe.stop();
      return probe.samples;
    });
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "composer-switch-state.json"),
      JSON.stringify(samples, null, 2),
    );
    expect(samples.some((sample) => (sample as { loading?: boolean }).loading)).toBe(true);
    expect(
      samples
        .filter((sample) => (sample as { loading?: boolean }).loading)
        .every((sample) => (sample as { busy?: string }).busy === "true"),
    ).toBe(true);
    expect(await $('[data-testid="composer-provider-loading"]').isExisting()).toBe(false);
    // 修复回归：只看最终值会漏掉重选模型触发的中间清空/控件收缩，检查整段 DOM 时序。
    expect(
      samples.every((sample) => {
        const state = sample as { thought?: string; effort?: string; levels?: string };
        return state.thought === chosenThought && Boolean(state.effort) && Boolean(state.levels);
      }),
    ).toBe(true);
    expect(await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-thought")).toBe(chosenThought);

    await connection.click();
    const selectedTeam = $('[aria-label="BigModel Team Org"]');
    await selectedTeam.waitForDisplayed({ timeout: 10000 });
    expect(await selectedTeam.getAttribute("aria-checked")).toBe("true");
    expect(await connection.getText()).toContain("Team Org");
    expect((await readSettings()).providerFamilyConnectionSelections?.bigmodel).toEqual({
      kind: "team-coding-plan",
      productId: "product-team-a",
      organizationId: "org-team-a",
      projectId: "proj-team-a",
    });
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "composer-connections-team.png"),
    );
    const personal = $(
      `[data-model-provider-key="registry-provider:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan}"]`,
    );
    await personal.click();
    await browser.waitUntil(
      async () =>
        (await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-provider")) ===
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      { timeout: 15000 },
    );
    await connection.waitForClickable({ timeout: 15000 });
    expect(await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-thought")).toBe(chosenThought);
    expect((await readSettings()).providerFamilyConnectionSelections?.bigmodel?.kind).toBe(
      "individual-coding-plan",
    );
    await browser.keys("Escape");
  });

  for (const locale of ["zh-CN", "en-US"] as const) {
    it(`CTP-23: 团队激活时补充个人入口使用当前语言 ${locale}`, async function () {
      this.timeout(120000);
      await prepareScenario("both", TEAM_PLAN_KEY, "none", "none", locale);
      const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
      await trigger.waitForClickable({ timeout: 30000 });
      await trigger.click();
      const connection = $('[data-testid="composer-provider-trigger"]');
      await connection.click();
      const personalLabel = locale === "zh-CN" ? "个人" : "Individual";
      await $(`[aria-label="BigModel ${personalLabel}"]`).waitForDisplayed({ timeout: 10000 });
      expect(await $('[aria-label="BigModel Team Org"]').isDisplayed()).toBe(true);
      if (locale === "zh-CN")
        expect(await $('[aria-label="BigModel Individual"]').isExisting()).toBe(false);
      await browser.keys("Escape");
      await browser.keys("Escape");
    });
  }

  for (const direction of ["personal-to-team", "team-to-personal"] as const) {
    it(`CTP-22: 经过普通 API 切换账号连接后思考完整 ${direction}`, async function () {
      this.timeout(120000);
      const toTeam = direction === "personal-to-team";
      await prepareScenario("both", toTeam ? PERSONAL_PLAN_KEY : TEAM_PLAN_KEY);
      await selectRegistryProviderModelById(BIGMODEL_E2E_MODEL, {
        includePlainModelFallback: false,
        providerId: toTeam
          ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
          : BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
        ...(toTeam ? {} : { providerGroupKey: TEAM_PLAN_GROUP_KEY }),
      });
      const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
      await trigger.waitForClickable({ timeout: 30000 });
      await trigger.click();
      const connection = $('[data-testid="composer-provider-trigger"]');
      await browser.execute(() => {
        let wasLoading = false;
        const read = () =>
          JSON.stringify({
            models: document.querySelector("[data-composer-model-list]")?.textContent,
            effort: document
              .querySelector('[data-testid="composer-thought-slider"]')
              ?.getAttribute("aria-valuetext"),
          });
        let previous = read();
        const probe = {
          count: 0,
          samples: [] as { loading: boolean; display: string; previous: string }[],
          stop: () => {},
        };
        const observer = new MutationObserver(() => {
          const loading = Boolean(
            document.querySelector('[data-testid="composer-provider-loading"]'),
          );
          if (loading && !wasLoading) probe.count++;
          const display = read();
          probe.samples.push({ loading, display, previous });
          if (!loading) previous = display;
          wasLoading = loading;
        });
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
        probe.stop = () => observer.disconnect();
        Object.assign(window, { __connectionLoadingProbe: probe });
      });
      await connection.click();
      // 使用 runner 注入的 Provider 身份，不依赖已移除的旧预设名称。
      await $(
        `[data-composer-provider-list] [data-model-provider-key="registry-provider:${process.env.E2E_PROVIDER_ID}"]`,
      ).click();
      await browser.waitUntil(
        async () =>
          !(await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-provider"))?.startsWith(
            "account:",
          ),
      );
      await connection.waitForClickable({ timeout: 15000 });
      expect(await browser.execute(() => (window as any).__connectionLoadingProbe.count)).toBe(1);
      await connection.click();
      await $(
        toTeam
          ? '[aria-label="BigModel Team Org"]'
          : `[data-model-provider-key="registry-provider:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan}"]`,
      ).click();
      await connection.waitForClickable({ timeout: 15000 });
      await browser.waitUntil(
        async () =>
          (await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-provider")) ===
          (toTeam
            ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
            : BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan),
        { timeout: 15000 },
      );
      expect(await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-thought")).not.toBe("");
      expect(
        await $('[data-testid="composer-thought-slider"]').getAttribute("aria-valuetext"),
      ).not.toContain("—");
      const probe = await browser.execute(() => {
        const probe = (window as any).__connectionLoadingProbe;
        probe.stop();
        return { count: probe.count, samples: probe.samples };
      });
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `connection-loading-${direction}.json`),
        JSON.stringify(probe, null, 2),
      );
      expect(probe.count).toBe(2);
      expect(await $('[role="alert"]').isExisting()).toBe(false);
      expect(
        probe.samples
          .filter((sample: any) => sample.loading)
          .every((sample: any) => sample.display === sample.previous),
      ).toBe(true);
      await browser.keys("Escape");
    });
  }

  for (const target of ["personal", "team"] as const) {
    it(`CTP-32: 经过普通 API 切回已生效连接不重写账号设置 ${target}`, async function () {
      // 根因（ZCT-2118278184274395136）：普通 API 不写套餐设置，切回时连接仍已生效；
      // 原实现仍保存一次（版本 +1），远程工作区因此再跑一轮 Provisioning 并等待它结束。
      this.timeout(120000);
      const toTeam = target === "team";
      const providerId = toTeam
        ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
        : BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
      await prepareScenario("both", toTeam ? TEAM_PLAN_KEY : PERSONAL_PLAN_KEY);
      await selectRegistryProviderModelById(BIGMODEL_E2E_MODEL, {
        includePlainModelFallback: false,
        providerId,
        ...(toTeam ? { providerGroupKey: TEAM_PLAN_GROUP_KEY } : {}),
      });
      const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
      await trigger.waitForClickable({ timeout: 30000 });
      await trigger.click();
      const connection = $('[data-testid="composer-provider-trigger"]');
      await connection.click();
      await $(
        `[data-composer-provider-list] [data-model-provider-key="registry-provider:${process.env.E2E_PROVIDER_ID}"]`,
      ).click();
      await browser.waitUntil(
        async () =>
          !(await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-provider"))?.startsWith(
            "account:",
          ),
        { timeout: 15000, timeoutMsg: "未切到普通 API" },
      );
      await connection.waitForClickable({ timeout: 15000 });
      // 普通 API 切换完成后再取基线；切回已生效连接不能产生新的设置写入。
      const before = await readSettings();
      await connection.click();
      await $(
        toTeam
          ? '[aria-label="BigModel Team Org"]'
          : `[data-model-provider-key="registry-provider:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan}"]`,
      ).click();
      await browser.waitUntil(
        async () =>
          (await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-provider")) === providerId,
        { timeout: 15000, timeoutMsg: "未切回套餐 Provider" },
      );
      await browser.waitUntil(
        async () => !(await $('[data-testid="composer-provider-loading"]').isExisting()),
        { timeout: 15000, timeoutMsg: "连接 loading 未结束" },
      );
      expect(await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-thought")).not.toBe("");
      expect(
        await $('[data-testid="composer-thought-slider"]').getAttribute("aria-valuetext"),
      ).not.toContain("—");
      expect(await $('[role="alert"]').isExisting()).toBe(false);
      const after = await readSettings();
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `connection-effective-${target}.json`),
        JSON.stringify(
          {
            before: {
              providerFamilyDomain: before.providerFamilyDomain,
              providerFamilyDomainUpdatedAt: before.providerFamilyDomainUpdatedAt,
              selections: before.providerFamilyConnectionSelections,
            },
            after: {
              providerFamilyDomain: after.providerFamilyDomain,
              providerFamilyDomainUpdatedAt: after.providerFamilyDomainUpdatedAt,
              selections: after.providerFamilyConnectionSelections,
            },
          },
          null,
          2,
        ),
      );
      expect(after.providerFamilyDomain).toBe("bigmodel");
      expect(after.providerFamilyConnectionSelections).toEqual(
        before.providerFamilyConnectionSelections,
      );
      expect(after.providerFamilyDomainUpdatedAt).toBe(before.providerFamilyDomainUpdatedAt);
      await browser.keys("Escape");
    });
  }

  it("CTP-33: 另一窗口已切到其他团队时，Composer 选该团队按共享设置生效", async function () {
    // 根因（CR-01）：每个窗口有独立 Window Host，另一窗口写入设置不会刷新本窗口的账号快照。
    // 快路径只比根/目标两份缓存，两份都停在旧团队时也判为已生效，用旧团队目录完成选模且不报错。
    this.timeout(120000);
    const teamProviderId = BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
    await prepareScenario("both", TEAM_PLAN_KEY, "twoTeams", "none", "en-US");
    await selectRegistryProviderModelById(BIGMODEL_E2E_MODEL, {
      includePlainModelFallback: false,
      providerId: teamProviderId,
      providerGroupKey: TEAM_PLAN_GROUP_KEY,
    });
    const teamA = await readProviderConnectionKey(teamProviderId);
    const written = await readSettings();
    // 模拟另一个窗口的 Window Host：只写共享设置文件，本窗口 Host 收不到设置更新事件。
    const updatedAt = Number(written.providerFamilyDomainUpdatedAt ?? 0) + 1;
    await writeSettings({
      providerFamilyConnectionSelections: {
        bigmodel: {
          kind: "team-coding-plan",
          productId: "product-team-a",
          organizationId: "org-team-b",
          projectId: "proj-team-b",
        },
      },
      providerFamilyDomainUpdatedAt: updatedAt,
    });
    // 前置条件：本窗口根 Host 仍是团队 A 的身份，用例才覆盖“缓存未按当前设置解析”。
    expect(await readProviderConnectionKey(teamProviderId)).toBe(teamA);
    const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
    await trigger.waitForClickable({ timeout: 30000 });
    await trigger.click();
    const connection = $('[data-testid="composer-provider-trigger"]');
    await connection.waitForClickable({ timeout: 15000 });
    expect(await connection.getText()).toContain("Team Org");
    await connection.click();
    const activeTeam = $('[aria-label="BigModel Active Team"]');
    await activeTeam.waitForClickable({ timeout: 15000 });
    await activeTeam.click();
    await browser.waitUntil(
      async () =>
        !(await $('[data-testid="composer-provider-loading"]').isExisting()) &&
        (await connection.getAttribute("aria-busy")) !== "true",
      { timeout: 30000, timeoutMsg: "连接 loading 未结束" },
    );
    const afterClick = await readProviderConnectionKey(teamProviderId);
    const teamB = await readProviderConnectionKey(teamProviderId, true);
    const after = await readSettings();
    const label = await connection.getText();
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "connection-other-window-team.json"),
      JSON.stringify(
        { teamA, afterClick, teamB, label, updatedAt: after.providerFamilyDomainUpdatedAt },
        null,
        2,
      ),
    );
    expect(teamB).not.toBe(teamA);
    expect(afterClick).toBe(teamB);
    expect(label).toContain("Active Team");
    expect(await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-provider")).toBe(teamProviderId);
    expect(await $('[role="alert"]').isExisting()).toBe(false);
    // 共享设置已是团队 B；本窗口按它生效即可，不需要再写一次。
    expect(after.providerFamilyConnectionSelections?.bigmodel).toMatchObject({
      organizationId: "org-team-b",
      projectId: "proj-team-b",
    });
    expect(after.providerFamilyDomainUpdatedAt).toBe(updatedAt);
    await browser.keys("Escape");
  });

  it("CTP-21: 调思考后解析未返回时选模型不能留下空档位", async function () {
    this.timeout(120000);
    await prepareScenario("both", PERSONAL_PLAN_KEY);
    const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
    await trigger.waitForClickable({ timeout: 30000 });
    await trigger.click();
    await $('[data-testid="composer-thought-slider"]').waitForDisplayed();
    // 挂起真实 Renderer -> Host 的下一次选择读取，确定性覆盖用户连续操作窗口。
    await browser.execute(() => {
      const element = document.querySelector('[data-testid="v4-model-config"]')!;
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
      ];
      let service: any;
      while (fiber && !service) {
        service =
          fiber.memoizedProps?.value?.modelSelectionService ??
          fiber.memoizedProps?.services?.modelSelectionService;
        fiber = fiber.return;
      }
      if (!service) throw new Error("ModelSelectionService not found");
      const original = service.getView.bind(service);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      service.getView = async (...args: any[]) => {
        await pending;
        return original(...args);
      };
      Object.assign(window, {
        __releaseSelectionRead: () => {
          service.getView = original;
          release();
        },
      });
    });
    try {
      const slider = $('[data-testid="composer-thought-slider"]');
      await slider.click();
      await browser.keys("Home");
      expect(await $('[data-testid="composer-provider-loading"]').isExisting()).toBe(false);
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "reasoning-read-menu.json"),
        JSON.stringify(
          await browser.execute(() => ({
            config: (document.querySelector('[data-testid="v4-model-config"]') as HTMLElement)
              ?.dataset,
            menu: Array.from(document.querySelectorAll('[role="menu"]')).map((e) => e.textContent),
          })),
          null,
          2,
        ),
      );
      const flash = (await $$('[data-composer-model-list] [role="menuitemradio"]'))[1]!;
      await flash.click();
      await browser.waitUntil(
        async () =>
          (await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-model")) === "GLM-5.3-Flash",
      );
      expect(await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-thought")).not.toBe("");
    } finally {
      await browser.execute(() => (window as any).__releaseSelectionRead());
    }
    await $('[data-testid="composer-thought-slider"]').waitForDisplayed();
    expect(await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-thought")).not.toBe("");
    await browser.keys("Escape");
  });

  for (const locale of ["zh-CN", "en-US"] as const) {
    it(`CTP-02B: 侧栏头像菜单应显示当前已确认的 Team Plan 标签（${locale}）`, async function () {
      this.timeout(120000);

      await prepareScenario("teamOnly", TEAM_PLAN_KEY, "none", "none", locale);
      await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);

      const profileTrigger = $(sel(TID_LOGIN_TRIGGER));
      await profileTrigger.waitForDisplayed({
        timeout: 30000,
        timeoutMsg: "侧栏头像入口没有出现",
      });
      // 英文 UI 的套餐标签为 Team；只断言徽标本身，避免用户名包含团队文字时误通过。
      const teamLabel = locale === "zh-CN" ? "团队" : "Team";
      // 套餐标签已移入头像菜单；不再从头像按钮的旧布局查找。
      await profileTrigger.click();
      // 侧栏提示已移到延迟 Tooltip，不再保留原生 title；限定套餐容器读取可见文字。
      const badge = $('[data-testid="profile-menu-plan"]');
      await badge.waitForDisplayed({ timeout: 30000 });
      await expect(badge).toHaveText(teamLabel);
      await browser.keys("Escape");
    });
  }

  it("CTP-03: 用户头像菜单应进入 Team Plan 使用统计并请求团队额度", async function () {
    this.timeout(120000);

    await prepareScenario("teamOnly", TEAM_PLAN_KEY);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);
    await openSidebarUsageStats();

    await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
    await clickUsageCodingPlanTab(TEAM_PLAN_KEY);
    await assertBodyTextIncludes(["Team Org", "90%"]);
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/usage/quota/limit") &&
        request.query.type === "2" &&
        request.headers["bigmodel-organization"] === "org-team-a" &&
        request.headers["bigmodel-project"] === "proj-team-a",
      "头像菜单未按 Team Plan 请求 quota/limit?type=2",
    );
  });

  it("CTP-CN-03: 中国区主登录通过关联身份查询团队权益", async function () {
    this.timeout(120000);
    await prepareScenario("teamOnly", TEAM_PLAN_KEY, "none", "none", undefined, false, true);
    await openUsageCodingPlanTab(TEAM_PLAN_KEY);
    await assertBodyTextIncludes(["Team Org", "90%"]);
    await waitForMockRequest(
      (request) =>
        request.headers["bigmodel-organization"] === "org-team-a" &&
        request.headers["bigmodel-project"] === "proj-team-a" &&
        (request.headers.authorization === "e2e-bigmodel-oauth-token" ||
          request.headers.authorization === "Bearer e2e-bigmodel-oauth-token"),
      "关联团队没有使用 BigModel 业务身份",
    );
  });

  it("CTP-04: 使用统计编程套餐应显示 Team Plan 额度、模型用量和工具用量", async function () {
    this.timeout(120000);

    await prepareScenario("teamOnly", TEAM_PLAN_KEY);
    await openUsageCodingPlanTab(TEAM_PLAN_KEY);

    await assertBodyTextIncludes(["Team Org", "90%", "glm-credit-e2e"]);
    await assertBodyTextIncludesAny(["Models", "模型"]);
    await clickVisibleButtonByText(["Tools", "工具"]);
    await assertBodyTextIncludes(["E2E Search MCP"]);
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/credit-usage/usage-detail") &&
        request.query.usageType === "MODEL" &&
        request.headers["bigmodel-organization"] === "org-team-a" &&
        request.headers["bigmodel-project"] === "proj-team-a",
      "使用统计未按 Team Plan 请求 MODEL credit detail",
    );
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/credit-usage/usage-detail") &&
        request.query.usageType === "MCP" &&
        request.headers["bigmodel-organization"] === "org-team-a" &&
        request.headers["bigmodel-project"] === "proj-team-a",
      "使用统计未按 Team Plan 请求 MCP credit detail",
    );
  });

  it("CTP-04B: 个人套餐应展示 credit activity、明细与性能数据", async function () {
    this.timeout(120000);

    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY);
    await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);

    await assertBodyTextIncludes(["glm-credit-e2e"]);
    await assertBodyTextIncludesAny(["Credits total", "积分总数"]);
    await clickVisibleButtonByText(["Tools", "工具"]);
    await assertBodyTextIncludes(["E2E Search MCP"]);
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/credit-usage/activity") &&
        request.query.type === "1" &&
        !request.headers["bigmodel-organization"] &&
        !request.headers["bigmodel-project"],
      "个人套餐没有请求隔离的 credit activity",
    );
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/credit-usage/usage-detail") &&
        request.query.usageType === "MODEL",
      "个人套餐没有请求 MODEL credit detail",
    );
    await waitForMockRequest(
      (request) => request.path.endsWith("/api/monitor/usage/model-performance-day"),
      "个人套餐没有请求 model performance",
    );
  });

  for (const locale of ["zh-CN", "en-US"] as const) {
    it(`CTP-05: 切换连接后可分别查看个人与团队用量来源（${locale}）`, async function () {
      this.timeout(180000);

      await prepareScenario("both", TEAM_PLAN_KEY, "none", "none", locale);
      await openModelProviderSettings();
      await clickVisibleTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, BIGMODEL_ACCOUNT_NAV_KEY), {
        timeout: 30000,
        timeoutMsg: "BigModel 供应商导航项没有出现",
      });
      await selectConnectionModeOptionByTestId(
        testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, PERSONAL_PLAN_CONNECTION_KEY),
        "个人 Coding Plan",
      );
      await waitForBigModelConnectionSelection("individual-coding-plan");
      await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);
      await assertBodyTextIncludes(["70%", "glm-credit-e2e"]);
      // 使用统计的个人页签是 Individual Plan，不是设置页左侧的 Coding Plan。
      const personalTab = $(sel(testId(TID_SETTINGS_USAGE_TAB, `codingPlan:${PERSONAL_PLAN_KEY}`)));
      await expect(personalTab).toHaveText(locale === "zh-CN" ? "个人套餐" : "Individual Plan");
      await expect(personalTab).toHaveAttribute("aria-pressed", "true");
      // 使用统计按账号展示全部来源；团队 tab 的名称不代表个人面板泄漏团队额度。
      const teamTab = $(sel(testId(TID_SETTINGS_USAGE_TAB, `codingPlan:${TEAM_PLAN_KEY}`)));
      // 个人额度先返回，团队来源随后异步加入；等待目标来源渲染后再校验未选中状态。
      await teamTab.waitForDisplayed({ timeout: 30_000 });
      await expect(teamTab).toHaveText("Team Org");
      await expect(teamTab).toHaveAttribute("aria-pressed", "false");

      await openModelProviderSettings();
      await clickVisibleTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, BIGMODEL_ACCOUNT_NAV_KEY), {
        timeout: 30000,
        timeoutMsg: "BigModel 供应商导航项没有出现",
      });
      await selectConnectionModeOptionByTestId(
        testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, TEAM_PLAN_KEY),
        "Team Org",
      );
      await waitForBigModelConnectionSelection("team-coding-plan");
      await openUsageCodingPlanTab(TEAM_PLAN_KEY);
      await assertBodyTextIncludes(["Team Org", "90%", "glm-credit-e2e"]);
    });
  }

  it("CTP-06: 启动恢复 OAuth 时应保留已选择的 Team Plan", async function () {
    this.timeout(120000);

    await prepareScenario("both", TEAM_PLAN_KEY);
    await waitForMockRequest(
      (request) => request.path.endsWith("/subscription/enterprise/v2/pricing"),
      "启动恢复 OAuth 时未请求企业套餐 pricing",
    );
    await browser.waitUntil(
      async () => {
        const selection = (await readSettings()).providerFamilyConnectionSelections?.bigmodel;
        return (
          selection?.kind === "team-coding-plan" &&
          selection.productId === "product-team-a" &&
          selection.organizationId === "org-team-a" &&
          selection.projectId === "proj-team-a"
        );
      },
      {
        timeout: 15000,
        timeoutMsg: "启动恢复 OAuth 后结构化 Team Plan selection 被覆盖",
      },
    );

    await openUsageCodingPlanTab(TEAM_PLAN_KEY);
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/usage/quota/limit") &&
        request.query.type === "2" &&
        request.headers["bigmodel-organization"] === "org-team-a" &&
        request.headers["bigmodel-project"] === "proj-team-a",
      "启动恢复 OAuth 后使用统计未继续按 Team Plan 请求 quota/limit?type=2",
    );
  });

  it("CTP-07: 切换 7d/30d 应重新请求不同日期窗口且保持当前来源", async function () {
    this.timeout(120000);

    await prepareScenario("both", TEAM_PLAN_KEY);
    await openUsageCodingPlanTab(TEAM_PLAN_KEY);
    await clickVisibleButtonByText(["30 days", "近 30 日"]);
    const thirtyDayRequest = await waitForLatestMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/credit-usage/usage-detail") &&
        request.query.usageType === "MODEL" &&
        request.query.type === "3" &&
        requestRangeDays(request) === 29,
      "切换 30d 后没有请求新的日期窗口",
    );

    expect(thirtyDayRequest.headers["bigmodel-organization"]).toBe("org-team-a");
    expect(thirtyDayRequest.headers["bigmodel-project"]).toBe("proj-team-a");
    expect(
      daysBetweenMonitorTimes(
        requireQueryValue(thirtyDayRequest, "startTime"),
        requireQueryValue(thirtyDayRequest, "endTime"),
      ),
    ).toBe(29);

    await clickVisibleButtonByText(["7 days", "近 7 日"]);
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/credit-usage/usage-detail") &&
        request.query.usageType === "MODEL" &&
        request.query.type === "3" &&
        requestRangeDays(request) === 6,
      "切回 7d 后没有恢复对应日期窗口",
    );
  });

  it("CTP-08: 窄窗口下 Usage tabs、range 与热力图仍可操作", async function () {
    this.timeout(120000);
    await setRendererViewport(430, 760);
    try {
      // 本 Case 只验证窄窗口交互，不额外绑定“个人 + Team 同时存在时启动恢复
      // 自动选择哪个套餐”的产品规则；使用单一个人权益保持夹具职责清晰。
      await prepareScenario("personalOnly", PERSONAL_PLAN_KEY);
      await setSettingsTheme("zai-dark");
      await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);
      await clickVisibleButtonByText(["30 days", "近 30 日"]);
      await assertBodyTextIncludes(["glm-credit-e2e"]);
      await assertBodyTextIncludesAny(["Token activity", "Token 活动"]);
    } finally {
      await setSettingsTheme("zai-light");
      await clearRendererViewport();
    }
  });

  it("CTP-09: activity 可选接口失败不拖垮 quota，刷新后恢复", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "optionalActivity");
    await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);

    await assertBodyTextIncludes(["70%", "glm-credit-e2e"]);
    await assertBodyTextExcludes(["350.7K", "35.1万", "35.1 万"]);
    await setMockScenario("personalOnly", "none");
    await clickVisibleButtonByText(["Refresh", "刷新"]);
    await assertBodyTextIncludesAny(["350.7K", "35.1万", "35.1 万"]);
    await waitForMockRequest(
      (request) => request.path.endsWith("/api/monitor/credit-usage/activity"),
      "activity 恢复后刷新没有重新请求",
    );
  });

  it("CTP-10: Context hover 应按 access freshness 展示同一额度快照", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY);
    await selectBigModelCodingPlanRuntime("individual-coding-plan");
    const trigger = await $(sel(TID_CHAT_CONTEXT_USAGE_TRIGGER));
    await trigger.waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "Context usage trigger 没有出现",
    });
    await trigger.moveTo();
    await assertBodyTextIncludes(["70%"]);
    await assertBodyTextIncludesAny(["5 hours", "5 小时"]);
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/monitor/usage/quota/limit") && request.query.type !== "2",
      "Context access 没有读取个人套餐 quota",
    );
  });

  for (const [scenario, planKey, width] of [
    ["personalOnly", PERSONAL_PLAN_KEY, 1200],
    ["teamOnly", TEAM_PLAN_KEY, 1200],
    ["personalOnly", PERSONAL_PLAN_KEY, 390],
    ["teamOnly", TEAM_PLAN_KEY, 390],
  ] as const) {
    it(`CTP-11: ${scenario} ${width}px quota 失败保留套餐入口，重新进入来源后恢复`, async function () {
      this.timeout(120000);
      await prepareScenario(scenario, planKey, "quotaBusinessFailure");
      await openUsageSection();
      await setRendererViewport(width, 900);
      // 订阅查询保持成功，quota 业务失败不能撤销权益，确认 tab 不消失；
      // 详情加载再切传输失败，覆盖 fatal 文案与后续恢复。
      await setMockScenario(scenario, "quotaFailure");
      await clickUsageCodingPlanTab(planKey);
      await assertBodyTextIncludesAny([
        "Unable to load usage stats",
        "无法读取用量统计。请稍后重试，或检查网络和供应商配置。",
      ]);
      await assertBodyTextExcludes(["350.7K", "35.1万", "35.1 万", "glm-credit-e2e"]);

      await setMockScenario(scenario, "none");
      await clickVisibleTestIdByDom(testId(TID_SETTINGS_USAGE_TAB, "app"), {
        timeout: 10000,
        timeoutMsg: "致命失败恢复时无法切换到 App Usage",
      });
      await clickUsageCodingPlanTab(planKey);
      await assertBodyTextIncludes([scenario === "teamOnly" ? "90%" : "70%", "glm-credit-e2e"]);
      await assertBodyTextIncludesAny(["350.7K", "35.1万", "35.1 万"]);
    });
  }

  it("QR-E2E-01: 空状态应调用 opportunity 并以强制 status 结果展示机会", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "emptyThenGrant");
    await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);

    await waitForMockRequest(
      (request) => request.path.endsWith("/api/v1/coding-plan/reset/opportunity"),
      "空 reset 状态没有触发 opportunity",
    );
    await waitForResetOpportunityCount(1);

    const resetPaths = (await readMockRequests())
      .map((request) => request.path)
      .filter((path) => path.includes("/api/v1/coding-plan/reset/"));
    const opportunityIndex = resetPaths.findIndex((path) => path.endsWith("/opportunity"));
    expect(opportunityIndex).toBeGreaterThan(0);
    expect(resetPaths.slice(opportunityIndex + 1).some((path) => path.endsWith("/status"))).toBe(
      true,
    );

    // QR-E2E-05：单机会徽标同样可点击并打开重置弹框（单机会不展示次数药丸，仅交互升级为按钮）。
    await clickResetOpportunityBadge();
    await assertBodyTextIncludesAny(["可重置额度", "Resettable quota"]);
    await assertBodyTextIncludesAny(["5 小时额度重置", "5-hour quota reset"]);
  });

  it("QR-E2E-02: 已有多类型机会时仍调用 opportunity，Dialog 只展示 status 权威数量", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "existingMultiple");
    await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);

    await waitForMockRequest(
      (request) => request.path.endsWith("/api/v1/coding-plan/reset/opportunity"),
      "已有 reset 机会时没有继续触发 scope opportunity",
    );
    await waitForResetOpportunityCount(3);
    await clickResetOpportunityBadge();
    await assertBodyTextIncludesAny(["可重置额度", "Resettable quota"]);
    await assertBodyTextIncludesAny(["5 小时额度重置", "5-hour quota reset"]);
    await assertBodyTextIncludesAny(["周额度重置", "Weekly quota reset"]);
    // 次数不再汇总到标题；FIVE_HOUR 持有 2 张机会，改由该行的次数药丸展示。
    await assertBodyTextIncludesAny(["2 次", "×2"]);
  });

  it("QR-E2E-09: Composer 应常驻展示首次机会提醒并在 hover 后收起", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "existingMultiple");
    await reloadRendererWithBigModelCodingPlanSelection();

    await waitForContextResetReminder("initial", ["3 次重置额度", "3 reset available"]);
    await assertContextReminderHiddenInSettings("initial");
    const trigger = await $(sel(TID_CHAT_CONTEXT_USAGE_TRIGGER));
    await trigger.moveTo();
    await browser.waitUntil(async () => !(await isContextResetReminderVisible("initial")), {
      timeout: 10000,
      timeoutMsg: "打开 Context 后首次 reset opportunity 提醒仍未收起",
    });
  });

  it("QR-E2E-10: 最早机会进入最后三分钟时应常驻展示临期提醒", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "urgentOpportunity");
    await reloadRendererWithBigModelCodingPlanSelection();

    await waitForContextResetReminder("urgent", ["重置额度过期", "Reset expires in"]);
    await assertContextReminderHiddenInSettings("urgent");
    const alarmAnimation = await browser.execute(() => {
      const icon = document.querySelector<HTMLElement>(
        '[data-context-reset-reminder="urgent"] .animate-zcode-alarm-ring',
      );
      return icon ? window.getComputedStyle(icon).animationName : null;
    });
    expect(alarmAnimation).toBe("zcode-alarm-ring");
  });

  it("QR-E2E-04: Composer Dialog 打开期间应保持 HoverCard 生命周期", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "existingMultiple");
    await selectBigModelCodingPlanRuntime("individual-coding-plan");

    const trigger = await $(sel(TID_CHAT_CONTEXT_USAGE_TRIGGER));
    await trigger.waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "Context usage trigger 没有出现",
    });
    await trigger.moveTo();
    await waitForResetOpportunityCount(3, '[data-slot="hover-card-content"]');
    await clickResetOpportunityBadge('[data-slot="hover-card-content"]');

    await browser.waitUntil(
      async () => {
        const state = await readQuotaResetOverlayState();
        return state.dialogVisible && state.hoverCardVisible;
      },
      {
        timeout: 10000,
        timeoutMsg: "重置 Dialog 打开后 Composer HoverCard 被提前卸载",
      },
    );

    await browser.keys("Escape");
    await browser.waitUntil(
      async () => {
        const state = await readQuotaResetOverlayState();
        return !state.dialogVisible && !state.hoverCardVisible;
      },
      {
        timeout: 10000,
        timeoutMsg: "关闭重置 Dialog 后 Composer HoverCard 没有一起收起",
      },
    );
  });

  it("QR-E2E-03: FIVE_HOUR use 必须等待 status used_at 后才完成", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "fiveHourUse");
    await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);
    await waitForResetOpportunityCount(2);
    await clickResetOpportunityBadge();

    let resetButton: WebdriverIO.Element | undefined;
    // 入场动画初帧的五小时按钮仍不可见；等待实际可见条件，不用一次采样判定功能缺失。
    await browser.waitUntil(
      async () => {
        resetButton = await findVisibleButtonByAriaLabels(
          ["重置 5 小时额度", "Reset 5-hour quota"],
          false,
          '[role="dialog"]',
        );
        return Boolean(resetButton);
      },
      { timeout: 10_000, timeoutMsg: "没有找到 FIVE_HOUR reset 按钮" },
    );
    if (!resetButton) throw new Error("没有找到 FIVE_HOUR reset 按钮");
    // 核销不可撤回：第一次点击只进入确认态，取消后不得发送 /use，确认后才核销。
    await resetButton.click();
    // 确认页带 fade-in 动画，刚切换时按钮 opacity≈0，isDisplayed 判为不可见；等动画结束再找「取消」。
    await browser.pause(500);
    const cancelButton = await findVisibleButtonByAriaLabels(
      ["取消", "Cancel"],
      true,
      '[role="dialog"]',
    );
    expect(await readFiveHourUseRequests()).toHaveLength(0);
    await cancelButton!.click();
    await browser.pause(500);
    expect(await readFiveHourUseRequests()).toHaveLength(0);
    await clickDialogFiveHourReset("取消确认后没有恢复 FIVE_HOUR reset 按钮");
    await waitForMockRequest(
      (request) =>
        request.path.endsWith("/api/v1/coding-plan/reset/use") &&
        isRecord(request.body) &&
        request.body.reset_type === "FIVE_HOUR",
      "五小时重置没有发送 reset_type=FIVE_HOUR",
    );
    // 双 JWT 契约：Authorization 传 Bearer zcode JWT，X-Bigmodel-Authorization 直传 MaaS JWT。
    const useRequest = (await readMockRequests()).find((request) =>
      request.path.endsWith("/api/v1/coding-plan/reset/use"),
    );
    expect(useRequest?.headers.authorization).toBe("Bearer e2e-zcode-jwt");
    expect(useRequest?.headers["x-bigmodel-authorization"]).toBe("e2e-bigmodel-oauth-token");
    // 时序约束：客户端 use 后的 status 确认重试窗口只有约 2.5 秒，confirm 前的每次检查
    // 必须是单次 execute 往返，不能逐按钮发 WebDriver 命令，否则慢机器上会先触发客户端
    // 失败分支，confirm 之后成功态永远不会出现。
    const processingState = await readDialogResetState();
    if (processingState.resetDisabled !== true || processingState.successVisible) {
      throw new Error(
        `status used_at 未确认前没有保持 processing: ${JSON.stringify(processingState)}`,
      );
    }

    await confirmResetUse();
    await browser.waitUntil(async () => (await readDialogResetState()).successVisible, {
      interval: 100,
      timeout: 10000,
      timeoutMsg: "status used_at 更新后没有显示成功状态",
    });
    await waitForMockRequest(
      (request) => request.path.endsWith("/api/v1/coding-plan/reset/history/read"),
      "确认 reset used_at 后没有上报 history/read",
    );
  });

  it("QR-E2E-14: 同类型多张机会核销一张后，弹框不重开即可展示并核销余下机会", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "multiFiveHourUse");
    await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);
    await waitForResetOpportunityCount(3);
    await clickResetOpportunityBadge();
    await assertBodyTextIncludesAny(["2 次", "×2"]);

    await clickDialogFiveHourReset("没有找到 FIVE_HOUR reset 按钮");
    await browser.waitUntil(async () => (await readFiveHourUseRequests()).length === 1, {
      timeout: 10000,
      timeoutMsg: "第一次五小时重置没有发送 /use",
    });

    // 回归点：成功反馈结束后该行留在弹框内，直接展示余下 1 张的真实倒计时并恢复可点击；
    // 旧实现在这里显示「0 分 0 秒后过期」，且再次点击被静默忽略，只能关闭重开弹框。
    await waitForDialogResetState(
      (state) =>
        state.resetDisabled === false &&
        !state.successVisible &&
        state.weekResetVisible &&
        state.resetRowText !== null &&
        !["2 次", "×2", "0 分 0 秒", "0m 0s"].some((text) => state.resetRowText?.includes(text)),
      "核销一张后余下机会没有在弹框内直接恢复为可核销",
    );

    await clickDialogFiveHourReset("核销一张后没有找到余下机会的 FIVE_HOUR reset 按钮");
    await browser.waitUntil(async () => (await readFiveHourUseRequests()).length === 2, {
      timeout: 10000,
      timeoutMsg: "余下机会的再次点击没有真实发送 /use",
    });
    const idempotencyKeys = (await readFiveHourUseRequests()).map((request) =>
      isRecord(request.body) ? request.body.idempotency_key : undefined,
    );
    expect(new Set(idempotencyKeys).size).toBe(2);

    // 机会耗尽后五小时行收起，周额度行不受影响、也不会被误核销。
    await waitForDialogResetState(
      (state) => state.resetDisabled === null && !state.successVisible && state.weekResetVisible,
      "五小时机会耗尽后该行没有收起",
    );
    expect(
      (await readMockRequests()).some(
        (request) =>
          request.path.endsWith("/api/v1/coding-plan/reset/use") &&
          isRecord(request.body) &&
          request.body.reset_type === "WEEK",
      ),
    ).toBe(false);
  });

  it("QR-E2E-15: 完成态再次核销时 status 仍是上一张 used_at，读到新 used_at 才确认成功", async function () {
    this.timeout(120000);
    // mock 让 /use 结果延迟 600ms 才在 /status 可见，窗口内 /status 仍返回上一张的 used_at。
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "multiFiveHourUseLagging");
    await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);
    await waitForResetOpportunityCount(3);
    await clickResetOpportunityBadge();
    await assertBodyTextIncludesAny(["2 次", "×2"]);

    await clickDialogFiveHourReset("没有找到 FIVE_HOUR reset 按钮");
    await browser.waitUntil(async () => (await readFiveHourUseRequests()).length === 1, {
      timeout: 10000,
      timeoutMsg: "第一次五小时重置没有发送 /use",
    });
    await waitForDialogResetState(
      (state) => state.resetDisabled === false && !state.successVisible && state.weekResetVisible,
      "第一次核销后余下机会没有恢复为可核销",
    );

    await clickDialogFiveHourReset("核销一张后没有找到余下机会的 FIVE_HOUR reset 按钮");
    await browser.waitUntil(async () => (await readFiveHourUseRequests()).length === 2, {
      timeout: 10000,
      timeoutMsg: "余下机会的再次点击没有真实发送 /use",
    });

    // 回归点：旧实现把滞后快照里上一张的 used_at 当作第二次成功，提前播放成功反馈后该行
    // 回到「余 1 张可点击」，直到下一次 60s 轮询才收起。修复后保持处理中，读到新 used_at 才完成。
    let revertedToClickable = false;
    await waitForDialogResetState((state) => {
      revertedToClickable ||= state.resetDisabled === false;
      return state.resetDisabled === null && !state.successVisible && state.weekResetVisible;
    }, "完成态再次核销后五小时行没有随机会耗尽收起");
    expect(revertedToClickable).toBe(false);
    expect(await readFiveHourUseRequests()).toHaveLength(2);
  });

  it("QR-E2E-16: 确认中的周机会失效后又出现，弹框保持列表，需重新点重置并重走防连点", async function () {
    this.timeout(120000);
    await prepareScenario("personalOnly", PERSONAL_PLAN_KEY, "none", "weekToggle");
    await openUsageCodingPlanTab(PERSONAL_PLAN_KEY);
    await waitForResetOpportunityCount(2);
    await clickResetOpportunityBadge();

    const weekResetButton = await findVisibleButtonByAriaLabels(
      ["重置周额度", "Reset weekly quota"],
      true,
      '[role="dialog"]',
    );
    await weekResetButton!.click();
    await waitForDialogResetState(
      (state) => state.weekConfirmVisible,
      "点击周额度重置后没有进入确认页",
    );

    // 周机会被别处核销：/status 不再返回 WEEK，FIVE_HOUR 保持弹框挂载。
    await setResetWeekAvailable(false);
    await triggerResetStatusRefresh();
    await waitForDialogResetState(
      (state) =>
        !state.weekConfirmVisible && !state.weekResetVisible && state.resetDisabled === false,
      "周机会失效后确认页没有退回列表",
    );

    // 周机会重新发放：回归点是弹框仍停在列表，不自动跳回旧确认页。
    await setResetWeekAvailable(true);
    await triggerResetStatusRefresh();
    await waitForDialogResetState(
      (state) => state.weekResetVisible && state.resetDisabled === false,
      "周机会恢复后列表没有重新展示周额度行",
    );
    await browser.pause(600);
    expect((await readDialogResetState()).weekConfirmVisible).toBe(false);
    expect(await readWeekUseRequests()).toHaveLength(0);

    // 重新点行内「重置」才进入确认页；同一事件循环内紧跟的确认点击落在 500ms 防连点窗口内，
    // 必须被忽略。单次 execute 完成两次点击，避免 WebDriver 往返耗时越过窗口。
    const guardedClick = await browser.execute(
      async (resetLabels: string[], confirmLabels: string[]) => {
        const find = (labels: string[]) =>
          Array.from(
            document
              .querySelector('[role="dialog"]')
              ?.querySelectorAll<HTMLButtonElement>("button") ?? [],
          ).find((button) => labels.includes(button.getAttribute("aria-label") ?? ""));
        const startedAt = performance.now();
        find(resetLabels)?.click();
        // 按真实耗时轮询等 React 提交确认页；只在距进入确认页 300ms 内点击，留足 500ms 防连点余量。
        // 渲染被阻塞超出安全窗口时不点击，交给外层断言带耗时明确失败，避免误发 /use。
        let confirm = find(confirmLabels);
        while (!confirm && performance.now() - startedAt < 300) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          confirm = find(confirmLabels);
        }
        const elapsedMs = Math.round(performance.now() - startedAt);
        if (!confirm || elapsedMs >= 300)
          return { clicked: false, found: Boolean(confirm), elapsedMs };
        confirm.click();
        return { clicked: true, found: true, elapsedMs };
      },
      ["重置周额度", "Reset weekly quota"],
      ["确认重置周额度", "Confirm weekly quota reset"],
    );
    if (!guardedClick.clicked) {
      throw new Error(`防连点窗口内未能点到确认按钮：${JSON.stringify(guardedClick)}`);
    }
    await browser.pause(300);
    expect(await readWeekUseRequests()).toHaveLength(0);

    await browser.pause(400);
    const weekConfirmButton = await findVisibleButtonByAriaLabels(
      ["确认重置周额度", "Confirm weekly quota reset"],
      true,
      '[role="dialog"]',
    );
    await weekConfirmButton!.click();
    await browser.waitUntil(async () => (await readWeekUseRequests()).length === 1, {
      timeout: 10000,
      timeoutMsg: "防连点窗口过后确认没有发送 WEEK /use",
    });
    expect(await readFiveHourUseRequests()).toHaveLength(0);
  });
});

async function prepareScenario(
  scenario: CodingPlanScenario,
  bigmodelSelectedKey: string,
  faultMode: CodingPlanFaultMode = "none",
  resetScenario: CodingPlanResetScenario = "none",
  locale?: "zh-CN" | "en-US",
  loggedOut = false,
  linkedChinaLogin = false,
) {
  // 修复原因：同一 spec 会连续切换个人/团队套餐场景。必须在旧 Electron 退出前清理
  // file:// origin 的 entitlement 缓存；退出后再执行 browser.execute 会被异常吞掉，
  // 上一场景的 Team 快照就会污染下一场景。
  await clearUsageEntitlementCache();
  // Bug 根因：旧 Electron/host 仍存活时直接改 setting.json，退出阶段的异步写回
  // 会把下一场景的夹具覆盖成上一场景。先等进程完整退出，再写持久化夹具，最后
  // 让 reloadSession 只负责创建新应用，场景边界才是确定的。
  await quitElectronAppGracefully();
  await setMockScenario(scenario, faultMode);
  await setResetMockScenario(resetScenario);
  await writeCredentials({
    "oauth:active_provider": "bigmodel",
    "oauth:bigmodel:access_token": "e2e-bigmodel-oauth-token",
    "oauth:bigmodel:user_info": JSON.stringify({
      displayName: "BigModel E2E",
      id: "bigmodel-e2e-user",
      username: "bigmodel-e2e-user",
    }),
    zcodejwttoken:
      resetScenario === "none" &&
      !faultMode.startsWith("startBalance") &&
      faultMode !== "expiredTeam"
        ? ""
        : "e2e-zcode-jwt",
  });
  if (linkedChinaLogin)
    await writeCredentials({
      "oauth:active_provider": "zai_cn",
      "oauth:session_revision": "e2e-cn-team-revision",
      "oauth:bigmodel:access_token": "",
      "oauth:bigmodel:user_info": "",
      "oauth:zai_cn:access_token": "e2e-cn-upstream-token",
      "oauth:zai_cn:user_info": JSON.stringify({
        user_id: "e2e-cn-team-user",
        name: "CN Team User",
      }),
      "oauth:linked_bigmodel": JSON.stringify({
        userId: "e2e-cn-team-user",
        customerId: "bigmodel-e2e-user",
        accessToken: "e2e-bigmodel-oauth-token",
      }),
      zcodejwttoken: "e2e-cn-team-zcode-jwt",
    });
  if (loggedOut)
    await writeCredentials({
      "oauth:active_provider": "",
      "oauth:bigmodel:access_token": "",
      "oauth:bigmodel:user_info": "",
      "oauth:zai:access_token": "",
      "oauth:zai:user_info": "",
      zcodejwttoken: "",
    });
  const connectionSelection = parseBigModelConnectionSelection(bigmodelSelectedKey);
  await writeSettings({
    ...(locale ? { locale, localePreference: locale } : {}),
    providerFamilyConnectionSelections: {
      bigmodel: connectionSelection,
    },
    providerFamilyDomain: "bigmodel",
    providerFamilyDomainMigrated: true,
    // Bug 根因：同一 spec 多次 reloadSession 会继承前一场景关闭时写回的 workspace。
    // Team Plan case 的 model-resolution seed 明确写 DEFAULT_WORKSPACE，因此启动入口也
    // 必须固定到同一个 project workspace，不能偶发落入 conversation workspace。
    lastWorkspaceSession: [
      {
        kind: "local",
        workspacePath: DEFAULT_WORKSPACE,
        workspacePurpose: "project",
      },
    ],
    lastActiveTabIndex: 0,
  });
  // 修复原因：Electron E2E 的 file:// renderer 直接 browser.refresh()
  // 偶发落到 chrome-error://chromewebdata，后续等待会每条 case 慢 30s。
  // 场景切换需要让 main/host 重新读取磁盘设置，因此使用 reloadSession 重建应用。
  await browser.reloadSession();
  // Escape 只临时关闭职业引导；重载 Renderer 会再次遮住 Composer。
  // 复用真实 Skip 流程完成隔离账号的引导，保证重载类 case 的前置状态持久化。
  await skipOccupationOnboardingIfPresent();
  await waitForDefaultWorkspaceReady(60000);
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);
  await closeTransientOverlays();
  await waitForProviderConfigPolling();
}

function parseBigModelConnectionSelection(selectedKey: string) {
  if (selectedKey === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan)
    return { kind: "start-plan" as const };
  const parts = selectedKey.split(":");
  if (parts[0] !== "team") {
    return { kind: "individual-coding-plan" as const };
  }
  const [, family, productId, organizationId, projectId] = parts;
  if (family !== "bigmodel" || !productId || !organizationId || !projectId) {
    throw new Error(`无效 Team Plan key: ${selectedKey}`);
  }
  return {
    kind: "team-coding-plan" as const,
    productId,
    organizationId,
    projectId,
  };
}

async function waitForBigModelConnectionSelection(
  kind: "individual-coding-plan" | "team-coding-plan",
) {
  await browser.waitUntil(
    async () => (await readSettings()).providerFamilyConnectionSelections?.bigmodel?.kind === kind,
    {
      timeout: 15000,
      timeoutMsg: `BigModel 连接方式没有收敛到 ${kind}`,
    },
  );
  await waitForProviderConfigPolling();
}

async function clearUsageEntitlementCache() {
  // 修复原因：本 spec 会在同一 file:// origin 内切换 personalOnly/teamOnly mock。
  // useUsageEntitlement 的短 TTL localStorage 缓存会保留上个场景的 no_plan，
  // 导致下一次打开 Usage 页时 Coding Plan tab 被误判为不存在。
  try {
    await browser.execute(() => {
      const prefix = "zcode:usage-entitlement:";
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith(prefix)) {
          window.localStorage.removeItem(key);
        }
      }
    });
  } catch {
    // reloadSession 前后偶发没有可执行 renderer；缓存清理失败不阻塞场景重建。
  }
}

async function openModelProviderSettings() {
  await closeTransientOverlays();
  await ensureSettingsPageOpen();
  await clickVisibleTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 10000,
    timeoutMsg: "设置页没有出现模型供应商分区入口",
  });
}

async function assertConnectionModeOptionsInclude(
  expectedOptions: Array<{ key: string; labels: string[] }>,
) {
  await openConnectionModeSelect();
  try {
    for (const expectedOption of expectedOptions) {
      const optionTestId = testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, expectedOption.key);
      const option = await $(sel(optionTestId));
      await option.waitForDisplayed({
        timeout: 10000,
        timeoutMsg: `没有找到连接方式选项: ${optionTestId}`,
      });
      const optionText = await option.getText();
      expect(expectedOption.labels.some((label) => optionText.includes(label))).toBe(true);
    }
  } finally {
    await browser.keys("Escape");
  }
}

async function selectConnectionModeOptionByTestId(optionTestId: string, labelForError: string) {
  await openConnectionModeSelect();
  const option = await $(sel(optionTestId));
  await option.waitForDisplayed({
    timeout: 10000,
    timeoutMsg: `没有找到连接方式选项: ${labelForError}`,
  });
  await option.click();
}

async function openConnectionModeSelect() {
  await clickVisibleTestIdByDom(TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER, {
    timeout: 10000,
    timeoutMsg: "连接方式选择器没有出现",
  });
}

async function openUsageCodingPlanTab(sourceId?: string) {
  await openUsageSection();
  await clickUsageCodingPlanTab(sourceId);
  await assertBodyTextIncludesAny(["剩余额度", "Quota remaining", "Quota Remaining"]);
}

async function openUsageSection() {
  await closeTransientOverlays();
  await ensureSettingsPageOpen();
  await clickVisibleTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "usage"), {
    timeout: 10000,
    timeoutMsg: "设置页没有出现使用统计分区入口",
  });
}

async function ensureSettingsPageOpen() {
  const settingsPage = $(sel(TID_SETTINGS_PAGE));
  if (!(await settingsPage.isDisplayed().catch(() => false))) {
    // Bug 根因：设置新架构会同时保留响应式导航的隐藏副本，旧 helper 取第一个
    // test-id 时可能点中不可见节点并关闭设置页，导致后续误报 Coding Plan tab 消失。
    await clickVisibleTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 10000,
      timeoutMsg: "没有找到设置入口按钮",
    });
    await settingsPage.waitForDisplayed({ timeout: 10000 });
  }
}

async function openSidebarUsageStats() {
  await closeTransientOverlays();
  await clickVisibleTestIdByDom(TID_LOGIN_TRIGGER, {
    timeout: 10000,
    timeoutMsg: "没有找到头像菜单入口",
  });
  await clickVisibleTestIdByDom(TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON, {
    timeout: 10000,
    timeoutMsg: "没有找到头像菜单里的使用统计入口",
  });
}

async function closeTransientOverlays() {
  await browser.keys("Escape");
  await browser.pause(100);
}

async function clickUsageCodingPlanTab(sourceId?: string) {
  // 修复原因：使用统计页从单个 "codingPlan" tab 改为按来源生成
  // "codingPlan:<sourceId>"，测试不能再写死旧 test id。
  const staticTabId = testId(TID_SETTINGS_USAGE_TAB, "codingPlan");
  const prefix = `${testId(TID_SETTINGS_USAGE_TAB, "codingPlan:")}`;
  const preferredTabId = sourceId ? testId(TID_SETTINGS_USAGE_TAB, `codingPlan:${sourceId}`) : null;
  let selectedTestId = "";
  try {
    await browser.waitUntil(
      async () => {
        selectedTestId = (await browser.execute(
          (legacyTestId, dynamicPrefix, targetTestId) => {
            const candidates = Array.from(
              document.querySelectorAll<HTMLElement>("[data-testid]"),
            ).filter((element) => {
              const current = element.dataset.testid ?? "";
              return current === legacyTestId || current.startsWith(dynamicPrefix);
            });
            // 修复原因：传入 sourceId 时验证的就是该套餐身份。旧 helper
            // 找不到目标时会静默点击第一个可见 tab，把“个人套餐缺失”伪装成
            // 后续 Team 数据断言失败。指定目标时必须精确命中。
            const ordered = targetTestId
              ? candidates.filter((element) => element.dataset.testid === targetTestId)
              : candidates;
            const visible = ordered.find((element) => {
              const style = window.getComputedStyle(element);
              return !(
                style.display === "none" ||
                style.visibility === "hidden" ||
                Number(style.opacity) === 0 ||
                element.getClientRects().length === 0 ||
                element.closest('[aria-hidden="true"], [hidden]')
              );
            });
            return visible?.dataset.testid ?? "";
          },
          staticTabId,
          prefix,
          preferredTabId,
        )) as string;
        return Boolean(selectedTestId);
      },
      {
        timeout: 30000,
        timeoutMsg: "设置页没有出现使用统计 Coding Plan tab",
      },
    );
    const tab = await $(sel(selectedTestId));
    await tab.click();
  } catch (error) {
    throw new Error(
      `设置页没有出现或无法激活 Coding Plan tab: ${selectedTestId}\n${await collectCodingPlanUsageDiagnostics()}`,
      { cause: error },
    );
  }
}

async function setRendererViewport(width: number, height: number) {
  await sendRendererEmulationCommand("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height,
    mobile: false,
    width,
  });
  await browser.waitUntil(
    async () => browser.execute((expectedWidth) => window.innerWidth === expectedWidth, width),
    { timeout: 10000, timeoutMsg: `renderer viewport 没有收敛到 ${width}px` },
  );
}

async function setSettingsTheme(theme: "zai-light" | "zai-dark") {
  const changed = await browser.execute((nextTheme) => {
    const actions = (window as typeof window & { __testActions?: Record<string, unknown> })
      .__testActions;
    const setTheme = actions?.setTheme;
    if (typeof setTheme !== "function") return false;
    (setTheme as (value: string) => void)(nextTheme);
    return true;
  }, theme);
  expect(changed).toBe(true);
}

async function clearRendererViewport() {
  await sendRendererEmulationCommand("Emulation.clearDeviceMetricsOverride");
}

async function sendRendererEmulationCommand(method: string, params: Record<string, unknown> = {}) {
  const sent = await browser.electron.execute(
    async (electron, command, commandParams) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
      );
      if (!window) return false;
      const devtools = window.webContents.debugger;
      if (!devtools.isAttached()) devtools.attach("1.3");
      await devtools.sendCommand(command, commandParams);
      return true;
    },
    method,
    params,
  );
  expect(sent).toBe(true);
}

async function collectCodingPlanUsageDiagnostics() {
  const providers = (await readModelProviders()).map((provider) => ({
    id: provider.id,
    enabled: provider.enabled,
    hasApiKey: provider.apiKey.trim().length > 0,
    systemDisabledReason: provider.systemDisabledReason ?? null,
  }));
  const requests = (await readMockRequests()).map((request) => ({
    path: request.path,
    query: request.query,
    organization: request.headers["bigmodel-organization"] ?? null,
    project: request.headers["bigmodel-project"] ?? null,
  }));
  return `诊断: ${JSON.stringify(
    {
      bodyText: (await getBodyText()).slice(0, 2000),
      providers,
      requests,
    },
    null,
    2,
  )}`;
}

async function clickVisibleTestIdByDom(
  currentTestId: string,
  { timeout = 10000, timeoutMsg = `页面没有可见的 test id: ${currentTestId}` } = {},
) {
  // 修复原因：头像菜单内容用了 forceMount，隐藏菜单项也会留在 DOM 里。
  // 这里必须等真正可见的菜单项再触发，否则会点到隐藏节点。
  let latestReason = "not-started";
  await browser.waitUntil(
    async () => {
      const result = (await browser.execute((targetTestId) => {
        function isVisible(element: HTMLElement) {
          const style = window.getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity) === 0
          ) {
            return false;
          }
          if (element.getClientRects().length === 0) {
            return false;
          }
          return !element.closest('[aria-hidden="true"], [hidden]');
        }

        function dispatchE2EActivation(element: HTMLElement) {
          element.focus();
          const pointerEventCtor = window.PointerEvent ?? MouseEvent;
          for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            const event =
              type.startsWith("pointer") && pointerEventCtor === window.PointerEvent
                ? new PointerEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    pointerId: 1,
                    pointerType: "mouse",
                    isPrimary: true,
                  })
                : new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                  });
            element.dispatchEvent(event);
          }
        }

        const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (item) => item.dataset.testid === targetTestId && isVisible(item),
        );
        if (!element) {
          return { clicked: false, reason: "missing-visible" };
        }
        const disabled =
          (element instanceof HTMLButtonElement ||
            element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement) &&
          element.disabled;
        if (disabled) {
          return { clicked: false, reason: "disabled" };
        }
        dispatchE2EActivation(element);
        return { clicked: true };
      }, currentTestId)) as { clicked: boolean; reason?: string };
      latestReason = result.reason ?? "clicked";
      return result.clicked;
    },
    {
      timeout,
      timeoutMsg: `${timeoutMsg}: ${latestReason}`,
    },
  );
}

async function selectBigModelCodingPlanRuntime(
  planKind: "individual-coding-plan" | "team-coding-plan" = "individual-coding-plan",
) {
  const providerId =
    planKind === "team-coding-plan"
      ? "account:bigmodel-team-coding-plan"
      : "account:bigmodel-individual-coding-plan";
  // Bug 根因：只写 selectedSupplierKey 只更新了供应商导航解析状态，并不会更新
  // Composer 的 Effective Model。Context 用量按真实 Effective Provider 判断套餐类型，
  // 因此测试必须和用户一样完成一次 Provider/Model 选择。
  await selectRegistryProviderModelById(BIGMODEL_E2E_MODEL, {
    includePlainModelFallback: false,
    providerId,
    providerName: "BigModel Coding Plan",
  });
}

async function reloadRendererWithBigModelCodingPlanSelection() {
  // Bug 根因：QR-09/10 验证的是 Renderer 首次挂载时的常驻提醒。通过模型菜单选择会
  // 产生提醒外部 pointerdown，从而按产品规则把刚出现的提醒标记为已读；在退出应用前
  // seed 又会被旧 Renderer 的关闭写回覆盖。直接写正式选择存储并只重载 Renderer，
  // 既使用真实 ModelSelection，又不引入测试专用运行时入口或额外 Host 重启。
  await seedPersistedModelSelection({
    modelId: BIGMODEL_E2E_MODEL,
    providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    reasoningLevel: "max",
  });
  await browser.execute(() => window.location.reload());
  await waitForDefaultWorkspaceReady(60000);
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);
  await waitForProviderConfigPolling();

  // Bug 根因：直接写 recent selection 只覆盖了草稿的持久化入口；如果当前
  // ModelSelectionView 尚未包含该 Account Provider，Composer 会按现有契约回退到
  // preferredSelection。先通过真实选择控件完成一次有效选择，再重载一次，验证的才是
  // 用户实际会走的 selection -> opportunity 链路，而不是测试专用的 localStorage 假设。
  await selectRegistryProviderModelById(BIGMODEL_E2E_MODEL, {
    includePlainModelFallback: false,
    providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    providerName: "BigModel Coding Plan",
  });
  await browser.execute(() => window.location.reload());
  await waitForDefaultWorkspaceReady(60000);
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);
  await waitForProviderConfigPolling();
}

async function setMockScenario(
  scenario: CodingPlanScenario,
  faultMode: CodingPlanFaultMode = "none",
) {
  const baseUrl = getMockBaseUrl();
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      faultMode,
      scenario,
      providerResponsive: faultMode.startsWith("startBalance"),
    }),
  });
  if (!response.ok) {
    throw new Error(`切换 Coding Plan mock scenario 失败: ${response.status}`);
  }
}

async function setResetMockScenario(resetScenario: CodingPlanResetScenario) {
  const response = await fetch(`${getMockBaseUrl()}/__e2e/coding-plan/reset-scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resetScenario }),
  });
  if (!response.ok) {
    throw new Error(`切换 Coding Plan reset mock scenario 失败: ${response.status}`);
  }
}

async function setResetWeekAvailable(available: boolean) {
  const response = await fetch(`${getMockBaseUrl()}/__e2e/coding-plan/reset-week-available`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ available }),
  });
  if (!response.ok) {
    throw new Error(`切换 Coding Plan WEEK 机会失败: ${response.status}`);
  }
}

/** reset 轮询间隔 5 分钟，用一次「隐藏 → 可见」让共享 Coordinator 立即重拉 /status。
 *  先等过 /status 的 1.5s 新鲜度缓存，否则可见后的刷新会复用旧快照。 */
async function triggerResetStatusRefresh() {
  await browser.pause(1600);
  await browser.execute(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    // 删除实例上的覆盖，恢复原型上的真实 getter（visible）。
    Reflect.deleteProperty(document, "visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function confirmResetUse() {
  const response = await fetch(`${getMockBaseUrl()}/__e2e/coding-plan/reset-confirm-use`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`确认 Coding Plan reset use 失败: ${response.status}`);
  }
}

async function waitForResetOpportunityCount(count: number, rootSelector?: string) {
  await browser.waitUntil(
    async () => {
      const labels = (await browser.execute((root: string | undefined) => {
        const scope = root ? document.querySelector(root) : document;
        return Array.from(
          scope?.querySelectorAll<HTMLElement>('[data-reset-opportunity="true"]') ?? [],
        )
          .filter((element) => {
            const style = window.getComputedStyle(element);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              element.getClientRects().length > 0
            );
          })
          .map((element) => element.innerText.trim());
      }, rootSelector)) as string[];
      return labels.some((label) => label.includes(String(count)));
    },
    {
      timeout: 10000,
      timeoutMsg: `没有展示 ${count} 次 reset opportunity`,
    },
  );
}

async function clickResetOpportunityBadge(rootSelector?: string) {
  const selector = rootSelector
    ? `${rootSelector} [data-reset-opportunity="true"]`
    : '[data-reset-opportunity="true"]';
  for (const badge of await $$(selector)) {
    if (await badge.isDisplayed()) {
      await badge.click();
      return;
    }
  }
  throw new Error("没有找到可点击的 reset opportunity 徽标");
}

async function isContextResetReminderVisible(phase: "initial" | "urgent") {
  return browser.execute((currentPhase) => {
    const element = document.querySelector<HTMLElement>(
      `[data-context-reset-reminder="${currentPhase}"]`,
    );
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getClientRects().length > 0
    );
  }, phase);
}

async function waitForContextResetReminder(phase: "initial" | "urgent", expectedTexts: string[]) {
  try {
    await browser.waitUntil(
      async () => {
        if (!(await isContextResetReminderVisible(phase))) return false;
        const text = (await browser.execute((currentPhase) => {
          return (
            document.querySelector<HTMLElement>(`[data-context-reset-reminder="${currentPhase}"]`)
              ?.innerText ?? ""
          );
        }, phase)) as string;
        return expectedTexts.some((expected) => text.includes(expected));
      },
      {
        timeout: 15000,
        timeoutMsg: `没有展示 ${phase} reset opportunity reminder`,
      },
    );
  } catch (error) {
    // Bug 调查：提醒缺失不能只留下一个 waitUntil 超时。机会接口、Context 触发器和
    // 实际 DOM 一并进入失败证据，才能区分“没有数据”和“已有机会但提醒被收起”。
    const reminderDiagnostics = await browser.execute(
      (contextTriggerTestId) => ({
        bodyText: document.body?.innerText?.slice(-2500) ?? "",
        contextTriggerVisible: Array.from(
          document.querySelectorAll<HTMLElement>(`[data-testid="${contextTriggerTestId}"]`),
        ).some((element) => element.getClientRects().length > 0),
        opportunityBadges: Array.from(
          document.querySelectorAll<HTMLElement>('[data-reset-opportunity="true"]'),
        ).map((element) => ({
          text: element.innerText,
          visible: element.getClientRects().length > 0,
        })),
        reminders: Array.from(
          document.querySelectorAll<HTMLElement>("[data-context-reset-reminder]"),
        ).map((element) => ({
          phase: element.dataset.contextResetReminder ?? null,
          text: element.innerText,
          visible: element.getClientRects().length > 0,
        })),
      }),
      TID_CHAT_CONTEXT_USAGE_TRIGGER,
    );
    const resetRequests = (await readMockRequests())
      .filter((request) => request.path.includes("/coding-plan/reset/"))
      .map((request) => ({ method: request.method, path: request.path }));
    throw new Error(
      `没有展示 ${phase} reset opportunity reminder\n诊断: ${JSON.stringify(
        { reminderDiagnostics, resetRequests },
        null,
        2,
      )}`,
      { cause: error },
    );
  }
}

async function readQuotaResetOverlayState() {
  return browser.execute(() => {
    const isVisible = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        element.getClientRects().length > 0
      );
    };
    return {
      dialogVisible: isVisible(document.querySelector('[role="dialog"]')),
      hoverCardVisible: isVisible(document.querySelector('[data-slot="hover-card-content"]')),
    };
  });
}

async function findVisibleButtonByAriaLabels(
  labels: string[],
  required = true,
  rootSelector?: string,
) {
  const selector = rootSelector ? `${rootSelector} button` : "button";
  for (const button of await $$(selector)) {
    if (!(await button.isDisplayed())) continue;
    const ariaLabel = await button.getAttribute("aria-label");
    if (ariaLabel && labels.includes(ariaLabel)) return button;
  }
  if (required) throw new Error(`找不到按钮: ${labels.join("/")}`);
  return undefined;
}

/** 单次 execute 往返读取弹框内 FIVE_HOUR 重置按钮与成功态；QR-E2E-03 的 confirm
 *  窗口只有约 2.5 秒，逐按钮 isDisplayed/getAttribute 的多次 WebDriver 往返会超窗。 */
async function readFiveHourUseRequests() {
  return (await readMockRequests()).filter(
    (request) =>
      request.path.endsWith("/api/v1/coding-plan/reset/use") &&
      isRecord(request.body) &&
      request.body.reset_type === "FIVE_HOUR",
  );
}

async function readWeekUseRequests() {
  return (await readMockRequests()).filter(
    (request) =>
      request.path.endsWith("/api/v1/coding-plan/reset/use") &&
      isRecord(request.body) &&
      request.body.reset_type === "WEEK",
  );
}

async function clickDialogFiveHourReset(missingMessage: string) {
  const button = await findVisibleButtonByAriaLabels(
    ["重置 5 小时额度", "Reset 5-hour quota"],
    false,
    '[role="dialog"]',
  );
  if (!button) throw new Error(missingMessage);
  await button.click();
  // 弹框内核销需要二次确认：第一次点击只展开确认，再点「确认重置」才发送 /use。
  // 确认态刚出现的 500ms 内会忽略确认点击（防连点穿透），这里等过这段时间再点。
  await browser.pause(600);
  const confirmButton = await findVisibleButtonByAriaLabels(
    ["确认重置 5 小时额度", "Confirm 5-hour quota reset"],
    false,
    '[role="dialog"]',
  );
  if (!confirmButton) throw new Error(`${missingMessage}（缺少确认按钮）`);
  await confirmButton.click();
}

async function readDialogResetState() {
  return browser.execute(
    (
      resetLabels: string[],
      successLabels: string[],
      weekResetLabels: string[],
      weekConfirmLabels: string[],
    ) => {
      const dialog = document.querySelector('[role="dialog"]');
      const buttons = dialog
        ? Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
        : [];
      const findByLabels = (candidates: string[]) =>
        buttons.find((button) => candidates.includes(button.getAttribute("aria-label") ?? "")) ??
        null;
      const resetButton = findByLabels(resetLabels);
      return {
        resetDisabled: resetButton ? resetButton.disabled : null,
        // 重置按钮与类型名、次数药丸、倒计时同处一个行容器，用于断言该行展示内容。
        resetRowText: resetButton?.parentElement?.innerText ?? null,
        successVisible: findByLabels(successLabels) !== null,
        weekResetVisible: findByLabels(weekResetLabels) !== null,
        weekConfirmVisible: findByLabels(weekConfirmLabels) !== null,
      };
    },
    ["重置 5 小时额度", "Reset 5-hour quota"],
    ["重置成功", "Reset successful"],
    ["重置周额度", "Reset weekly quota"],
    ["确认重置周额度", "Confirm weekly quota reset"],
  );
}

async function waitForDialogResetState(
  predicate: (state: Awaited<ReturnType<typeof readDialogResetState>>) => boolean,
  timeoutMsg: string,
) {
  let lastState: Awaited<ReturnType<typeof readDialogResetState>> | null = null;
  try {
    await browser.waitUntil(
      async () => {
        const state = await readDialogResetState();
        lastState = state;
        return predicate(state);
      },
      { interval: 100, timeout: 10000, timeoutMsg },
    );
  } catch (error) {
    throw new Error(`${timeoutMsg}: ${JSON.stringify(lastState)}`, { cause: error });
  }
}

async function waitForMockRequest(
  predicate: (request: MockRequest) => boolean,
  timeoutMsg: string,
) {
  await browser.waitUntil(async () => (await readMockRequests()).some(predicate), {
    timeout: 10000,
    timeoutMsg,
  });
}

async function waitForLatestMockRequest(
  predicate: (request: MockRequest) => boolean,
  timeoutMsg: string,
): Promise<MockRequest> {
  let match: MockRequest | undefined;
  await browser.waitUntil(
    async () => {
      match = (await readMockRequests()).findLast(predicate);
      return Boolean(match);
    },
    { timeout: 10000, timeoutMsg },
  );
  if (!match) {
    throw new Error(timeoutMsg);
  }
  return match;
}

async function clickVisibleButtonByText(labels: string[]): Promise<void> {
  for (const button of await $$("button")) {
    if ((await button.isDisplayed()) && labels.includes((await button.getText()).trim())) {
      await button.click();
      return;
    }
  }
  throw new Error(`找不到可见按钮: ${labels.join("/")}`);
}

function daysBetweenMonitorTimes(startTime: string, endTime: string): number {
  const start = Date.parse(startTime.replace(" ", "T") + "Z");
  const end = Date.parse(endTime.replace(" ", "T") + "Z");
  return Math.floor((end - start) / 86_400_000);
}

function requireQueryValue(request: MockRequest, key: string): string {
  const value = request.query[key];
  if (!value) {
    throw new Error(`mock request 缺少 query: ${key}`);
  }
  return value;
}

function requestRangeDays(request: MockRequest): number | null {
  const startTime = request.query.startTime;
  const endTime = request.query.endTime;
  return startTime && endTime ? daysBetweenMonitorTimes(startTime, endTime) : null;
}

/** 读取本窗口根 Host 中 Provider 的账号连接身份；refresh 时先按当前设置刷新。 */
async function readProviderConnectionKey(providerId: string, refresh = false) {
  return browser.execute(
    async (providerId: string, refresh: boolean) => {
      const element = document.querySelector('[data-testid="v4-model-config"]')!;
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
      ];
      let service: any;
      while (fiber && !service) {
        service =
          fiber.memoizedProps?.value?.providerSettingsService ??
          fiber.memoizedProps?.services?.providerSettingsService;
        fiber = fiber.return;
      }
      if (!service) throw new Error("ProviderSettingsService not found");
      const view = refresh ? await service.refresh("e2e-connection-key") : await service.getView();
      return view.providers.find((provider: any) => provider.providerId === providerId)
        ?.accountState?.connectionKey as string | undefined;
    },
    providerId,
    refresh,
  );
}

async function readMockRequests(): Promise<MockRequest[]> {
  const response = await fetch(`${getMockBaseUrl()}/__e2e/coding-plan/requests`);
  const payload = (await response.json()) as { requests?: MockRequest[] };
  return payload.requests ?? [];
}

function getMockBaseUrl() {
  const baseUrl = process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL?.trim();
  if (!baseUrl) {
    throw new Error("ZCODE_E2E_CODING_PLAN_MOCK_URL 未配置");
  }
  return baseUrl;
}

async function writeSettings(patch: Record<string, unknown>) {
  await mkdir(join(E2E_STORAGE_ROOT, "v2"), { recursive: true });
  const current = await readSettings();
  await writeFile(SETTINGS_FILE, JSON.stringify({ ...current, ...patch }, null, 2), "utf-8");
}

async function writeCredentials(patch: Record<string, unknown>) {
  await mkdir(join(E2E_STORAGE_ROOT, "v2"), { recursive: true });
  const current = await readJsonFile(CREDENTIALS_FILE);
  await writeFile(CREDENTIALS_FILE, JSON.stringify({ ...current, ...patch }, null, 2), "utf-8");
}

async function readSettings(): Promise<{
  providerFamilyConnectionSelections?: {
    bigmodel?: ProviderFamilyConnectionSelection;
    zai?: ProviderFamilyConnectionSelection;
  };
  [key: string]: unknown;
}> {
  try {
    return JSON.parse(await readFile(SETTINGS_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertBodyTextIncludes(values: string[]) {
  try {
    await browser.waitUntil(
      async () => {
        const bodyText = await getBodyText();
        return values.every((value) => bodyText.includes(value));
      },
      {
        timeout: 10000,
        timeoutMsg: `页面没有出现全部文本: ${values.join(" / ")}`,
      },
    );
  } catch (error) {
    throw new Error(
      `页面没有出现全部文本: ${values.join(" / ")}\n当前页面文本:\n${(await getBodyText()).slice(0, 2000)}`,
      { cause: error },
    );
  }
}

async function assertBodyTextIncludesAny(values: string[]) {
  try {
    await browser.waitUntil(
      async () => {
        const bodyText = await getBodyText();
        return values.some((value) => bodyText.includes(value));
      },
      {
        timeout: 10000,
        timeoutMsg: `页面没有出现任一文本: ${values.join(" / ")}`,
      },
    );
  } catch (error) {
    throw new Error(
      `页面没有出现任一文本: ${values.join(" / ")}\n当前页面文本:\n${(await getBodyText()).slice(0, 2000)}`,
      { cause: error },
    );
  }
}

async function assertBodyTextExcludes(values: string[]) {
  const bodyText = await getBodyText();
  for (const value of values) {
    expect(bodyText).not.toContain(value);
  }
}

function getBodyText() {
  return browser.execute(() => document.body?.innerText ?? "");
}

interface MockRequest {
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  method: string;
  path: string;
  query: Record<string, string>;
}

type ReminderNavigationWindow = Window & {
  __zcodeTabStoreE2E: {
    getState(): {
      activeTabId: string | null;
      openSettingsTab(): void;
      activateTab(id: string): void;
    };
  };
};

async function assertContextReminderHiddenInSettings(phase: "initial" | "urgent") {
  // 通过真实导航 store 切层，避免打开入口的 pointerdown 把提醒预先标已读，掩盖 Portal 泄漏。
  const workspaceTabId = await browser.execute(() => {
    const store = (window as unknown as ReminderNavigationWindow).__zcodeTabStoreE2E;
    const id = store.getState().activeTabId;
    store.getState().openSettingsTab();
    return id;
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 10000 });
  await browser.waitUntil(async () => !(await isContextResetReminderVisible(phase)), {
    timeout: 5000,
    timeoutMsg: "Composer 提醒穿透到设置页",
  });
  // 设置页点击不能消耗后台工作区的提醒状态。
  await browser.execute(() =>
    document
      .querySelector('[data-testid="settings-page"]')!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
  );
  await browser.execute(
    (id) =>
      (window as unknown as ReminderNavigationWindow).__zcodeTabStoreE2E
        .getState()
        .activateTab(id!),
    workspaceTabId,
  );
  await browser.waitUntil(async () => await isContextResetReminderVisible(phase), {
    timeout: 5000,
    timeoutMsg: "设置页点击误将 Composer 提醒标记为已读",
  });
}

// 读取真实展示组件的输入：保留 DOM 和 Host owner，只观察同一挂载树中的用量投影。
async function readComposerTeamUsageSource(): Promise<string | null> {
  return browser.execute(() => {
    const element = document.querySelector('[data-testid="v4-model-config"]');
    if (!element) return null;
    let fiber = (element as any)[
      Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
    ];
    while (fiber.return) fiber = fiber.return;
    // DOM 上的 Fiber 可指向 alternate；必须从 React 当前 root 读取已提交展示。
    const pending = [fiber.stateNode.current];
    while (pending.length) {
      const node = pending.pop();
      if (Object.hasOwn(node.memoizedProps ?? {}, "codingPlanUsageRemaining"))
        return node.memoizedProps.codingPlanUsageRemaining?.selectedProviderId ?? null;
      if (node.sibling) pending.push(node.sibling);
      if (node.child) pending.push(node.child);
    }
    return null;
  });
}

// 注入请求交错，不伪造设置落盘或替换生产菜单。所有修改在 finally 恢复。
async function installConnectionBoundaryProbe(
  mode: "logout" | "cas" | "mismatch" | "refresh-failure",
) {
  await browser.execute(async (mode) => {
    const element = document.querySelector('[data-testid="v4-model-config"]')!;
    let fiber = (element as any)[
      Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
    ];
    let services: any;
    let store: any;
    const accessors = new Set<any>();
    while (fiber) {
      const value = fiber.memoizedProps?.value;
      const candidate = value?.settingService ? value : fiber.memoizedProps?.services;
      if (candidate?.settingService) accessors.add(candidate);
      services ??= candidate;
      if (value?.getState && value.getState().setUser) store ??= value;
      fiber = fiber.return;
    }
    if (!services?.settingService) throw new Error("Workspace services not found");
    if (mode === "logout") {
      if (!store) throw new Error("Auth store not found");
      // 原因：刷新后断言会漏掉旧 Provider 与新 user 并存的窗口；先阻塞 refresh 再登出。
      const restorers: (() => void)[] = [];
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      for (const accessor of accessors) {
        const original = accessor.providerSettingsService;
        accessor.providerSettingsService = new Proxy(original, {
          get(target, prop) {
            if (prop !== "refresh") return Reflect.get(target, prop);
            return async (...args: any[]) => {
              await blocked;
              return target.refresh(...args);
            };
          },
        });
        restorers.push(() => {
          accessor.providerSettingsService = original;
        });
      }
      const suppressedRestores: unknown[] = [];
      // 测试屏障同时暂停旧凭据的恢复回执，保证断言窗口确实保持 user=null；不改生产鉴权流程。
      const pauseAuthRestore = store.subscribe((state: any) => {
        if (state.user) {
          suppressedRestores.push({ userId: state.user.id, authSessionSeq: state.authSessionSeq });
          state.setUser(null);
        }
      });
      (window as any).__logoutBoundaryRelease = async () => {
        pauseAuthRestore();
        restorers.forEach((restore) => restore());
        release();
        await services.oauthService.logoutAll();
        store.getState().setUser(null);
        await services.providerSettingsService.refresh("e2e-signed-out");
      };
      (window as any).__logoutBoundaryAuth = () => ({
        userId: store.getState().user?.id ?? null,
        authSessionSeq: store.getState().authSessionSeq,
      });
      store.getState().setUser(null);
      return;
    }
    const trace: unknown[] = [];
    let restore = () => {};
    const restorers: (() => void)[] = [];
    let injected = false;
    let armed = false;
    let recovered = false;
    let obsoleteStarted = false;
    let rejectObsolete!: (cause: Error) => void;
    const presentationListeners: ((candidate: any) => void)[] = [];
    let releasePresentation!: () => void;
    const synchronized = new Promise<void>((resolve) => {
      releasePresentation = resolve;
    });
    for (const accessor of accessors) {
      const key = mode === "cas" ? "settingService" : "modelSelectionService";
      const service = accessor[key];
      if (mode === "cas") {
        accessor[key] = new Proxy(service, {
          get(target, prop) {
            if (prop !== "update") return Reflect.get(target, prop);
            return async (patch: any, expected: any) => {
              if (armed && !injected && patch.providerFamilyConnectionSelections) {
                injected = true;
                const before = await service.get();
                await service.update(
                  {
                    providerFamilyConnectionSelections: {
                      ...before.providerFamilyConnectionSelections,
                      zai: { kind: "individual-coding-plan" },
                    },
                  },
                  {
                    providerFamilyDomain: before.providerFamilyDomain,
                    providerFamilyConnectionSelections: before.providerFamilyConnectionSelections,
                    providerFamilyDomainUpdatedAt: before.providerFamilyDomainUpdatedAt ?? 0,
                  },
                );
                trace.push({ phase: "concurrent-write", expected });
              }
              return service.update(patch, expected);
            };
          },
        });
      } else {
        accessor[key] = new Proxy(service, {
          get(target, prop) {
            if (mode === "refresh-failure" && prop === "onDidChange")
              return (listener: any) => {
                presentationListeners.push(listener);
                let delivered = false;
                return service.onDidChange((candidate: any) => {
                  // 每个订阅收到一次目标事件；不能由另一订阅抢先吞掉 Composer 的回执。
                  if (armed && delivered) return;
                  if (armed) {
                    delivered = true;
                    trace.push({ phase: "target-event", revision: candidate.revision });
                  }
                  listener(candidate);
                });
              };
            if (prop !== "getView") return Reflect.get(target, prop);
            return async (input: any) => {
              if (mode === "refresh-failure" && armed && input) {
                trace.push({ phase: "presentation-failed" });
                throw new Error("E2E presentation read failed");
              }
              if (mode === "refresh-failure" && recovered && input && !obsoleteStarted) {
                obsoleteStarted = true;
                trace.push({ phase: "obsolete-started" });
                return new Promise((_resolve, reject) => {
                  rejectObsolete = reject;
                });
              }
              const view = await service.getView(input);
              if (mode === "refresh-failure") {
                if (recovered && input)
                  trace.push({ phase: "presentation-recovered", revision: view.revision });
                if (armed) trace.push({ phase: "target-synchronized", revision: view.revision });
                return view;
              }
              if (!armed) return view;
              if (!input) {
                trace.push({ phase: "target-synchronized", revision: view.revision });
                releasePresentation();
                return view;
              }
              // 挂起展示读取直到连接同步完成，再读取同一 owner 的最新 revision；
              // 旧 ready 不属于本次回执，不能拿它伪造 ready+mismatch。
              await synchronized;
              const latest = await service.getView(input);
              trace.push({
                phase: "ready-mismatch",
                revision: latest.revision,
                original: latest.effectiveSelection,
              });
              return {
                ...latest,
                // 固定的 Flash 恰好可能是目标首选模型，不能保证冲突；回放另一有效 Provider 的选择。
                effectiveSelection: {
                  providerId: "e2e-upstream",
                  modelId: "deepseek-v4-flash",
                  options: { reasoningLevel: "disabled" },
                },
              };
            };
          },
        });
      }
      restorers.push(() => {
        accessor[key] = service;
      });
    }
    // RPC 方法 getter 不读取赋值；替换 accessor 的端口并重渲染，保持生产 RPC 和设置锁。
    if (!store) throw new Error("Auth store not found");
    store.getState().setUser({ ...store.getState().user });
    restore = () => {
      releasePresentation();
      restorers.forEach((restore) => restore());
      store.getState().setUser({ ...store.getState().user });
    };
    Object.assign(window, {
      __connectionBoundaryProbe: {
        trace,
        restore,
        recover: () => {
          armed = false;
          recovered = true;
          trace.push({ phase: "fault-recovered" });
        },
        supersede: async () => {
          const candidate = await Array.from(accessors)[0].modelSelectionService.getView();
          presentationListeners.forEach((listener) => listener(candidate));
        },
        rejectObsolete: () => {
          trace.push({ phase: "obsolete-failed" });
          rejectObsolete(new Error("E2E obsolete presentation failed"));
        },
        arm: () => {
          armed = true;
        },
      },
    });
  }, mode);
}
