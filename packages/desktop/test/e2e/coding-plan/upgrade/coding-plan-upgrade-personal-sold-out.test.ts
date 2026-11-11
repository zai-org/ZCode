import { readFile } from "node:fs/promises";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_MODEL_PROVIDER_NAV_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import {
  clickTestIdByDom,
  clearAppData,
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import {
  waitForCodingPlanWebviewBodyTextIncludes,
  waitForCodingPlanWebviewDisplayed,
} from "#e2e/helpers/coding-plan-upgrade-webview";

describe("BigModel Coding Plan 升级页个人套餐售罄 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("无 Coding 权益账号进入升级页时，个人套餐按钮显示已售罄", async function () {
    this.timeout(120000);

    // 本地 mock 只接管 BigModel 账号；夹带另一个账号族会访问真实控制面并污染登录态。
    const credentialKeys = Object.keys(
      JSON.parse(await readFile(getE2EAppDataPaths().credentialsFile, "utf8")),
    );
    expect(credentialKeys).toContain("oauth:bigmodel:access_token");
    expect(credentialKeys.some((key) => key.startsWith("oauth:zai:"))).toBe(false);

    await waitForDefaultWorkspaceReady(30000);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
    // 品牌入口已迁到 Account ID，旧 API Key 模式已删除；沿当前订阅入口验证售罄。
    await clickTestIdByDom(
      testId(TID_MODEL_PROVIDER_NAV_ITEM, `preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`),
    );
    const subscribe = () =>
      $("//button[normalize-space(.)='Subscribe' or normalize-space(.)='订阅']");
    await subscribe().waitForClickable({ timeout: 30000 });
    expect(await $('[data-testid="coding-plan-embedded-webview"]').isExisting()).toBe(false);
    await subscribe().click();
    await waitForCodingPlanWebviewDisplayed();
    await waitForCodingPlanWebviewBodyTextIncludes(["已售罄", "Sold out"]);
  });
});
