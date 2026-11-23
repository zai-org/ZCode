import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { sel } from "#e2e/helpers/selectors";

export async function openModelProviderSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 15000,
    timeoutMsg: "设置页没有出现模型供应商分区入口",
  });
}

export async function assertNoRemoteModelProviderSyncAction() {
  const remoteSyncActionVisible = await browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>("button"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .some((element) => /同步到远端|Sync to remote/u.test(element.innerText.trim())),
  );

  expect(remoteSyncActionVisible).toBe(false);
}
