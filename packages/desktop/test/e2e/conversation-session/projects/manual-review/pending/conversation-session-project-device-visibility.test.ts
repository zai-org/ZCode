import { join } from "node:path";
import { TID_TASK_SETTINGS_BUTTON, TID_SETTINGS_SECTION_NAV, testId } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const toggleSelector = '[data-testid="hide-project-device-names"]';
async function openPreferences() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
  await $(toggleSelector).waitForDisplayed();
}
describe("E2E_PROJECT_DEVICE_VISIBILITY", () => {
  after(async () => {
    await clearAppData();
  });
  it("RDUX-HIDE-DEVICE 真实设置入口即时切换，刷新后保留并可恢复", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await openPreferences();
    expect(await $(toggleSelector).getAttribute("aria-checked")).toBe("false");
    await $(toggleSelector).click();
    expect(await $(toggleSelector).getAttribute("aria-checked")).toBe("true");
    await browser.refresh();
    if (!(await $(toggleSelector).isExisting())) await openPreferences();
    await $(toggleSelector).waitForDisplayed();
    expect(await $(toggleSelector).getAttribute("aria-checked")).toBe("true");
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "device-name-hidden.png"),
    );
    await $(toggleSelector).click();
    expect(await $(toggleSelector).getAttribute("aria-checked")).toBe("false");
    await browser.refresh();
    if (!(await $(toggleSelector).isExisting())) await openPreferences();
    await $(toggleSelector).waitForDisplayed();
    expect(await $(toggleSelector).getAttribute("aria-checked")).toBe("false");
  });
});
