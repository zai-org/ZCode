import { setRendererViewport, clearRendererViewport } from "#e2e/helpers/renderer-viewport";
import { clearAppData, setInputValueByTestIdDom } from "#e2e/helpers/desktop-app";
import { resolveE2EToolPath } from "#e2e/helpers/e2e-runtime-paths";
import {
  getV4ComposerText,
  isV4ComposerFocused,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  addLifecycleMarketplaceThroughUi,
  assertPluginStoreFitsViewport,
  capturePluginManualReview,
  clickPluginControl,
  createPluginLifecycleFixture,
  getPluginControlText,
  getPluginOverview,
  hasPluginControl,
  installPluginThroughUi,
  openPluginManagementSettings,
  openPluginSettings,
  requirePluginManualReview,
  setPluginPresentation,
  waitForPluginControl,
  waitUntilPluginOverview,
} from "#e2e/helpers/plugin-management-lifecycle";

describe("PLM-LC-018/019/020 本地化与插件创建入口", () => {
  after(async () => {
    await clearRendererViewport();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("两处添加菜单分别创建真实 skill 草稿并保留来源添加与中文管理搜索", async function () {
    this.timeout(300000);
    requirePluginManualReview();
    const fixture = await createPluginLifecycleFixture();
    await openPluginSettings();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1440, height: 800 });
    await setRendererViewport(1440, 1000);
    await addLifecycleMarketplaceThroughUi(fixture);
    const countMarketCards = () =>
      browser.execute(
        (marketplace) =>
          [...document.querySelectorAll<HTMLElement>('[data-testid="plugin-store-card"]')].filter(
            (card) => card.dataset.pluginId?.endsWith(`@${marketplace}`),
          ).length,
        PLUGIN_LIFECYCLE_MARKETPLACE_ID,
      );
    expect(await countMarketCards()).toBe(8);
    await capturePluginManualReview("PLM-LC-001", "all-plugins-expanded");
    const groupKey = `marketplace:${PLUGIN_LIFECYCLE_MARKETPLACE_ID}`;
    await clickPluginControl("plugin-store-group-toggle", { groupKey });
    expect(await countMarketCards()).toBe(6);
    await clickPluginControl("plugin-store-group-toggle", { groupKey });
    expect(await countMarketCards()).toBe(8);
    await installPluginThroughUi(PLUGIN_LIFECYCLE_ID);
    for (const query of ["shengmingzhouqi", "SMZQ"]) {
      await setInputValueByTestIdDom("plugin-store-search", query);
      await waitForPluginControl("plugin-store-card", { pluginId: PLUGIN_LIFECYCLE_ID });
    }
    await setInputValueByTestIdDom("plugin-store-search", "");
    await openAddMenu("plugin-store-create");
    expect(await getPluginControlText("plugin-add-menu")).toContain("创建插件");
    expect(await getPluginControlText("plugin-add-menu")).not.toContain("录制");
    await clickPluginControl("plugin-create-menu-item");
    await expectCreatorDraft();
    await capturePluginManualReview("PLM-LC-019", "store-creator-draft");
    await openPluginManagementSettings();
    await clickPluginControl("settings-back-button");
    await expectCreatorDraft(false);
    await openPluginManagementSettings();
    await waitForPluginControl("plugin-settings-plugin-row", { pluginId: PLUGIN_LIFECYCLE_ID });
    expect(
      await getPluginControlText("plugin-settings-plugin-row", { pluginId: PLUGIN_LIFECYCLE_ID }),
    ).toContain("生命周期测试插件");
    for (const query of ["生命周期测试插件", "shengmingzhouqi", "smzq"]) {
      await setInputValueByTestIdDom("plugin-settings-search", query);
      await waitForPluginControl("plugin-settings-plugin-row", { pluginId: PLUGIN_LIFECYCLE_ID });
    }
    await setInputValueByTestIdDom("plugin-settings-search", "");
    await openAddMenu("plugin-settings-add");
    await clickPluginControl("plugin-create-menu-item");
    await expectCreatorDraft();
    await openPluginManagementSettings();
    await openAddMenu("plugin-settings-add");
    await clickPluginControl("plugin-store-add-source-menu-item");
    await waitForPluginControl("plugin-store-add-source-dialog");
    expect(
      await browser.execute(() => document.querySelector('[data-testid="settings-page"]') === null),
    ).toBe(true);
    const invalidSource = resolveE2EToolPath("plugin-creator", "missingmarketplace".repeat(8));
    await setInputValueByTestIdDom("plugin-store-add-source-input", invalidSource);
    await clickPluginControl("plugin-store-add-source-risk-acknowledgement");
    await clickPluginControl("plugin-store-add-source-submit");
    await waitForPluginControl("plugin-store-add-source-error");
    expect(
      await browser.execute(
        () =>
          document.querySelector<HTMLInputElement>('[data-testid="plugin-store-add-source-input"]')
            ?.value,
      ),
    ).toBe(invalidSource);
    await browser.keys("Escape");
    await clearRendererViewport();
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 480, height: 800 });
    await setRendererViewport(390, 844);
    // 添加来源失败后仍停留在默认公开分段；本地 fixture 属于个人来源，搜索只覆盖当前分段。
    await clickPluginControl("plugin-store-segment-personal");
    await setInputValueByTestIdDom("plugin-store-search", "smzq");
    await waitForPluginControl("plugin-store-card", { pluginId: PLUGIN_LIFECYCLE_ID });
    await openAddMenu("plugin-store-create");
    const text = await getPluginControlText("plugin-add-menu");
    expect(text).toContain("Create plugin");
    expect(text).toContain("Add plugin marketplace");
    await capturePluginManualReview("PLM-LC-020", "en-dark-narrow-add-menu");
    await assertPluginStoreFitsViewport();
    await browser.keys("Escape");
    for (const presentation of [
      { locale: "zh-CN" as const, theme: "zai-light" as const, width: 390 },
      { locale: "en-US" as const, theme: "zai-dark" as const, width: 1280 },
      { locale: "zh-CN" as const, theme: "zai-light" as const, width: 1280 },
    ]) {
      await clearRendererViewport();
      await setPluginPresentation({
        ...presentation,
        width: Math.max(480, presentation.width),
        height: 844,
      });
      await setRendererViewport(presentation.width, 844);
      // 长路径必须完整保留并换行，不能用截断或隐藏溢出来通过窄屏验收。
      expect(await getPluginControlText("plugin-store-error")).toContain(invalidSource);
      await assertPluginStoreFitsViewport();
      await capturePluginManualReview(
        "PLM-LC-020",
        `${presentation.locale}-${presentation.theme}-${presentation.width}-error`,
      );
    }
  });

  it("非官方市场必须确认风险才能添加，关闭后重新确认", async function () {
    this.timeout(120000);
    requirePluginManualReview();
    const fixture = await createPluginLifecycleFixture();
    await openPluginSettings();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1200, height: 800 });
    await openAddMenu("plugin-store-create");
    await clickPluginControl("plugin-store-add-source-menu-item");
    await waitForPluginControl("plugin-store-add-source-dialog");
    await setInputValueByTestIdDom("plugin-store-add-source-input", fixture.marketplaceRoot);
    const acknowledgement = browser.$(
      '[data-testid="plugin-store-add-source-risk-acknowledgement"]',
    );
    const submit = browser.$('[data-testid="plugin-store-add-source-submit"]');
    expect(await acknowledgement.getAttribute("aria-checked")).toBe("false");
    expect(await submit.isEnabled()).toBe(false);
    expect(await getPluginControlText("plugin-store-add-source-risk-warning")).toContain(
      "恶意插件",
    );
    await browser.$('[data-testid="plugin-store-add-source-input"]').click();
    await browser.keys("Enter");
    expect(
      (await getPluginOverview()).marketplaces.some(
        (marketplace) => marketplace.id === PLUGIN_LIFECYCLE_MARKETPLACE_ID,
      ),
    ).toBe(false);
    await clickPluginControl("plugin-store-add-source-risk-acknowledgement");
    expect(await submit.isEnabled()).toBe(true);
    await capturePluginManualReview("PLM-LC-020", "zh-light-risk-confirmation");
    await clickPluginControl("plugin-store-add-source-submit");
    await waitUntilPluginOverview(
      (overview) =>
        overview.marketplaces.some(
          (marketplace) => marketplace.id === PLUGIN_LIFECYCLE_MARKETPLACE_ID,
        ),
      "确认风险后未添加市场",
    );
    await browser.waitUntil(
      async () => !(await hasPluginControl("plugin-store-add-source-dialog")),
    );
    await openAddMenu("plugin-store-create");
    await clickPluginControl("plugin-store-add-source-menu-item");
    await waitForPluginControl("plugin-store-add-source-dialog");
    expect(await acknowledgement.getAttribute("aria-checked")).toBe("false");
    expect(await submit.isEnabled()).toBe(false);
    await clickPluginControl("plugin-store-add-source-risk-acknowledgement");
    await browser.keys("Escape");
    await openAddMenu("plugin-store-create");
    await clickPluginControl("plugin-store-add-source-menu-item");
    await waitForPluginControl("plugin-store-add-source-dialog");
    expect(await acknowledgement.getAttribute("aria-checked")).toBe("false");
  });
});
async function openAddMenu(testId: string) {
  await waitForPluginControl(testId);
  await browser.execute((id) => {
    document
      .querySelector<HTMLElement>(`[data-testid="${id}"]`)
      ?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
      );
  }, testId);
  await waitForPluginControl("plugin-add-menu");
  expect(
    await browser.execute(
      () => document.querySelectorAll('[data-testid="plugin-add-menu"] [role="menuitem"]').length,
    ),
  ).toBe(2);
}
async function expectCreatorDraft(checkFocus = true) {
  // 旧草稿仍挂载在设置页背后，必须先等创建请求真正关闭设置，避免读到上次草稿。
  await browser.waitUntil(
    async () => browser.execute(() => !document.querySelector('[data-testid="settings-page"]')),
    { timeout: 30000 },
  );
  await waitForV4Pane((s) => s.sessionId === "draft", "创建插件未进入新草稿");
  await browser.waitUntil(
    async () => (await getV4ComposerText())?.includes("$plugin-creator") === true,
    { timeout: 30000 },
  );
  const text = await getV4ComposerText();
  expect(text).toContain("/SKILL.md)");
  expect(text?.endsWith(" ")).toBe(true);
  if (checkFocus)
    await browser.waitUntil(isV4ComposerFocused, {
      timeout: 15000,
      timeoutMsg: "创建插件后输入框未获得焦点",
    });
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === "draft" && snapshot.rowCount === 0 && !snapshot.canStop,
    "创建入口自动发送了任务",
  );
}
