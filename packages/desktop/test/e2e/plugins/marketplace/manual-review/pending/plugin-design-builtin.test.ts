import type { Server } from "node:http";
import {
  TID_BROWSER_DESIGN_TOOLBAR,
  TID_BROWSER_ELEMENT_PICKER_BUTTON,
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_SIDE_PANE_TOGGLE,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { openFirstBrowserTab, readBrowserTabIds } from "#e2e/helpers/browser-side-pane";
import {
  closeFixtureServer,
  guestEval,
  navigateBrowser,
  selectGuestElement,
  startFixtureServer,
  waitForElementTokens,
} from "#e2e/helpers/browser-design-mode";
import {
  capturePluginManualReview,
  clickPluginControl,
  getPluginList,
  openPluginSettings,
  requirePluginManualReview,
  setPluginEnabledThroughUi,
  setPluginPresentation,
  waitForPluginCard,
  waitForPluginControl,
} from "#e2e/helpers/plugin-management-lifecycle";

const DESIGN_ID = "design@zcode-plugins-official";
const DIALOG = '[data-testid="browser-design-plugin-required"]';
let server: Server | null = null;
let origin = "";

describe("PLM-DESIGN-001 Design 默认关闭与选择元素安装引导", () => {
  before(async () => {
    ({ server, origin } = await startFixtureServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        '<!doctype html><html data-zcode-design><title>E2E Design gate</title><body><button id="target">E2E_DESIGN_TARGET</button></body></html>',
      );
    }));
  });
  after(async () => {
    await closeFixtureServer(server);
    await clearAppData();
  });

  it("未启用时提示且不点选，取消不跳转，确认进入 Design 详情并启用后可点选", async function () {
    this.timeout(240_000);
    requirePluginManualReview();
    await prepareV4ConversationE2E();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1280, height: 900 });
    const design = (await getPluginList()).plugins.find((plugin) => plugin.id === DESIGN_ID);
    expect(design?.enabled).toBe(false);
    await openFirstBrowserTab();
    const [tabId] = await readBrowserTabIds();
    if (!tabId) throw new Error("缺少 Browser tab");
    await navigateBrowser(origin, "E2E Design gate", origin);
    await clickTestIdByDom(TID_BROWSER_ELEMENT_PICKER_BUTTON);
    await $(DIALOG).waitForDisplayed();
    expect(
      await $(`[data-testid="${TID_BROWSER_ELEMENT_PICKER_BUTTON}"]`).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(await $(`[data-testid="${TID_BROWSER_DESIGN_TOOLBAR}"]`).isExisting()).toBe(false);
    await capturePluginManualReview("PLM-DESIGN-001", "design-required-dialog-zh-light");
    await browser.keys("Escape");
    await $(DIALOG).waitForDisplayed({ reverse: true });
    expect(
      await $(`[data-testid="${TID_BROWSER_ELEMENT_PICKER_BUTTON}"]`).getAttribute("aria-pressed"),
    ).toBe("false");
    await clickTestIdByDom(TID_BROWSER_ELEMENT_PICKER_BUTTON);
    await $(DIALOG).waitForDisplayed();
    await guestEval(origin, 'history.pushState({}, "", "/next")');
    await $(DIALOG).waitForDisplayed({ reverse: true });
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1280, height: 900 });
    await clickTestIdByDom(TID_BROWSER_ELEMENT_PICKER_BUTTON);
    await $(DIALOG).waitForDisplayed();
    await capturePluginManualReview("PLM-DESIGN-001", "design-required-dialog-en-dark");
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
    await waitForPluginControl("plugin-store-detail", { pluginId: DESIGN_ID }, 60_000);
    await capturePluginManualReview("PLM-DESIGN-001", "design-install-page");
    expect((await getPluginList()).plugins.find((plugin) => plugin.id === DESIGN_ID)?.enabled).toBe(
      false,
    );
    await setPluginEnabledThroughUi(DESIGN_ID, true);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await prepareV4ConversationE2E({ skipProvider: true });
    if (!(await $(`[data-side-pane-tab-id="${tabId}"]`).isDisplayed())) {
      await clickTestIdByDom(TID_SIDE_PANE_TOGGLE);
    }
    // 标签页包含关闭按钮；展开动画中不用坐标点击，直接激活已定位的标签，避免命中子按钮。
    const activated = await browser.execute((id) => {
      const tab = document.querySelector<HTMLElement>(`[data-side-pane-tab-id="${id}"]`);
      tab?.click();
      return Boolean(tab);
    }, tabId);
    expect(activated).toBe(true);
    await $(`[data-testid="${TID_BROWSER_DESIGN_TOOLBAR}"]`).waitForDisplayed({ timeout: 30_000 });
    await selectGuestElement(origin, "#target");
    await waitForElementTokens(1, "启用 Design 后点选应产生元素引用");
    expect(await $(DIALOG).isExisting()).toBe(false);
    await capturePluginManualReview("PLM-DESIGN-001", "design-enabled-selection");

    await openPluginSettings();
    await waitForPluginCard(DESIGN_ID, 60_000);
    await clickPluginControl("plugin-store-card", { pluginId: DESIGN_ID });
    await setPluginEnabledThroughUi(DESIGN_ID, false);
    await browser.waitUntil(
      async () => (await guestEval(origin, "typeof window.__zcodeDesignRuntime")) === "undefined",
      { timeout: 10_000, timeoutMsg: "停用后原页面的设计运行时应卸下" },
    );
  });
});
