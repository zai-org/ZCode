import { TID_V4_COMPOSER_INPUT, TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import { clearAppData, waitForDefaultWorkspaceReady } from "#e2e/helpers/desktop-app";
import { V4_MAIN_PANE_ID } from "#e2e/helpers/v4-conversation";
import { sel } from "#e2e/helpers/selectors";

describe("桌面端 E2E smoke", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("默认启动后应进入可交互的工作区主界面", async () => {
    await waitForDefaultWorkspaceReady();

    // 修复原因：v4 硬切后 legacy chat-view/chat-input 已退出产品 DOM；
    // smoke 应验证单 pane 与 v4 composer，而不是已删除的兼容壳子。
    await expect($(sel(testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID)))).toBeDisplayed();
    await expect($(sel(TID_V4_COMPOSER_INPUT))).toBeDisplayed();
  });
});
