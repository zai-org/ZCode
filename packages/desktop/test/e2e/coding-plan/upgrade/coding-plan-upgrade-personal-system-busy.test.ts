import { clearAppData } from "#e2e/helpers/desktop-app";
import { openBigModelCodingPlanPersonalUpgradePanel } from "#e2e/helpers/coding-plan-upgrade";
import {
  waitForCodingPlanWebviewBodyTextIncludes,
  waitForCodingPlanWebviewDisplayed,
} from "#e2e/helpers/coding-plan-upgrade-webview";

describe("BigModel Coding Plan 升级页个人套餐系统繁忙 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("无 Coding 权益账号进入升级页且套餐接口系统繁忙时，个人套餐按钮显示订阅繁忙", async function () {
    this.timeout(120000);

    await openBigModelCodingPlanPersonalUpgradePanel();
    await waitForCodingPlanWebviewDisplayed();
    await waitForCodingPlanWebviewBodyTextIncludes(["订阅繁忙", "System busy"]);
  });
});
