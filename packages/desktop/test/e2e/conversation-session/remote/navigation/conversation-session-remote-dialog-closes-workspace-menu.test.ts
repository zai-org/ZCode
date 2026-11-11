import {
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_SSH_DIALOG,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByWebDriver } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

describe("会话区远程连接弹窗与工作区菜单互斥 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("CWP12: 从 composer 工作区菜单打开远程连接弹窗时关闭父菜单", async function () {
    this.timeout(90000);

    await prepareV4ConversationE2E({ skipProvider: true });
    await clickTestIdByWebDriver(TID_COMPOSER_WORKSPACE_TRIGGER, {
      timeout: 15000,
      timeoutMsg: "空草稿没有显示工作区菜单触发器",
    });
    await clickTestIdByWebDriver(TID_COMPOSER_REMOTE_CONNECTION, {
      timeout: 15000,
      timeoutMsg: "工作区菜单没有显示远程连接入口",
    });

    await browser.waitUntil(
      async () => {
        const snapshot = await readOverlaySnapshot();
        return (
          snapshot.remoteDialogVisible &&
          !snapshot.remoteMenuItemExists &&
          snapshot.workspaceMenuExpanded === "false"
        );
      },
      {
        timeout: 15000,
        timeoutMsg: "远程连接弹窗打开后，父工作区菜单没有关闭",
      },
    );

    expect(await readOverlaySnapshot()).toEqual({
      remoteDialogVisible: true,
      remoteMenuItemExists: false,
      workspaceMenuExpanded: "false",
    });
  });
});

function readOverlaySnapshot() {
  return browser.execute(
    (workspaceTriggerTestId, remoteMenuItemTestId, remoteDialogTestId) => {
      const workspaceTrigger = document.querySelector<HTMLElement>(
        `[data-testid="${workspaceTriggerTestId}"]`,
      );
      const remoteMenuItem = document.querySelector<HTMLElement>(
        `[data-testid="${remoteMenuItemTestId}"]`,
      );
      const remoteDialog = document.querySelector<HTMLElement>(
        `[data-testid="${remoteDialogTestId}"]`,
      );

      return {
        remoteDialogVisible:
          remoteDialog !== null &&
          remoteDialog.getClientRects().length > 0 &&
          getComputedStyle(remoteDialog).visibility !== "hidden",
        remoteMenuItemExists: remoteMenuItem !== null,
        workspaceMenuExpanded: workspaceTrigger?.getAttribute("aria-expanded") ?? null,
      };
    },
    TID_COMPOSER_WORKSPACE_TRIGGER,
    TID_COMPOSER_REMOTE_CONNECTION,
    TID_SSH_DIALOG,
  );
}
