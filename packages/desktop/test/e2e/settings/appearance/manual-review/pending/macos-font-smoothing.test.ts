import { join } from "node:path";
import { TID_TASK_SETTINGS_BUTTON, TID_SETTINGS_SECTION_NAV, testId } from "@zcode/shared/test-ids";
import { waitForWorkspaceApp, DEFAULT_WORKSPACE, clickTestIdByDom } from "#e2e/helpers/desktop-app";

const toggle = () => $('[data-testid="font-smoothing-switch"]');
const smoothing = () =>
  browser.execute(() => getComputedStyle(document.body).getPropertyValue("-webkit-font-smoothing"));
async function openAppearance() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "appearance"));
}

describe("macOS 字体平滑", () => {
  it("默认灰度平滑，切换立即生效且重载保留", async function () {
    this.timeout(90_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await openAppearance();
    if (process.platform !== "darwin") {
      expect(await toggle().isExisting()).toBe(false);
      return;
    }
    await clickTestIdByDom("settings-search-open");
    await $('[data-testid="settings-search-input"]').setValue("Font smoothing");
    await $('[data-settings-search-result="settings.fontSmoothing"]').click();
    await toggle().waitForDisplayed();
    expect(await toggle().getAttribute("aria-checked")).toBe("true");
    expect(await smoothing()).toBe("antialiased");
    await browser.refresh();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    expect(await smoothing()).toBe("antialiased");
    await openAppearance();
    expect(await toggle().getAttribute("aria-checked")).toBe("true");
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "font-smoothing-enabled.png"),
    );
    await toggle().click();
    await browser.waitUntil(async () => (await smoothing()) === "auto");
    await browser.refresh();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    expect(await smoothing()).toBe("auto");
  });
});
