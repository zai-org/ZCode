import {
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_DOCKER_CONTAINER_INPUT,
  TID_REMOTE_KIND_DOCKER,
  TID_REMOTE_KIND_SERVER,
  TID_REMOTE_KIND_SSH,
  TID_REMOTE_KIND_WSL,
  TID_SERVER_URL_INPUT,
  TID_SETTINGS_PAGE,
  TID_SSH_DIALOG,
  TID_SSH_HOST_INPUT,
  TID_SSH_SUCCESS,
  TID_WSL_USER_INPUT,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByWebDriver } from "#e2e/helpers/desktop-app";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_REMOTE_KIND_DOUBLE_CLICK";
const dialogSelector = `[data-testid="${TID_SSH_DIALOG}"]`;
const kindCases = [
  { card: TID_REMOTE_KIND_SSH, field: TID_SSH_HOST_INPUT },
  { card: TID_REMOTE_KIND_SERVER, field: TID_SERVER_URL_INPUT },
  { card: TID_REMOTE_KIND_WSL, field: TID_WSL_USER_INPUT },
  { card: TID_REMOTE_KIND_DOCKER, field: TID_DOCKER_CONTAINER_INPUT },
];

describe(`${CASE_MARKER}: 远程连接新建入口`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("CWP20: 分类表单单击与双击切换不提交，取消返回聊天后可以重开", async function () {
    this.timeout(90_000);
    await skipOccupationOnboardingIfPresent();
    await prepareV4ConversationE2E({ skipProvider: true });
    await openFromChat();

    expect(await $(`[data-testid="${TID_REMOTE_KIND_SSH}"]`).isDisplayed()).toBe(true);
    expect(await $(`[data-testid="${TID_REMOTE_KIND_DOCKER}"]`).isDisplayed()).toBe(true);

    for (const { card, field } of kindCases) {
      if (!(await $(`[data-testid="${card}"]`).isExisting())) continue;

      await clickTestIdByWebDriver(card);
      await expectSettings(card, field);

      // 先访问另一类型再返回，确保新入口不复用上一份表单类型。
      const other = kindCases.find(
        (item) =>
          item.card ===
          (card === TID_REMOTE_KIND_SSH ? TID_REMOTE_KIND_DOCKER : TID_REMOTE_KIND_SSH),
      )!;
      await clickTestIdByWebDriver(other.card);
      await expectSettings(other.card, other.field);
      await $(`[data-testid="${card}"]`).doubleClick();
      await expectSettings(card, field);

      // 根因：聊天入口已直接打开设备管理分类表单，类型分段不会消失，也没有“返回列表”。
      // 用真实取消回到原聊天，再重开验证分段仍能双击切换，不借旧页面的定位点。
      await dialogAction("取消", "Cancel").click();
      await $(dialogSelector).waitForExist({ reverse: true });
      await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ reverse: true });
      await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).waitForClickable();
      await openFromChat();
      await $(`[data-testid="${card}"]`).doubleClick();
      await expectSettings(card, field);
    }
    await dialogAction("取消", "Cancel").click();
    await $(dialogSelector).waitForExist({ reverse: true });
  });
});

function dialogAction(zh: string, en: string) {
  return $(dialogSelector).$(`.//button[normalize-space(.)="${zh}" or normalize-space(.)="${en}"]`);
}

async function expectSettings(card: string, field: string) {
  await $(`[data-testid="${field}"]`).waitForDisplayed({
    timeout: 10_000,
    timeoutMsg: `${CASE_MARKER}: 未进入 ${field} 对应的配置页`,
  });
  expect(await $(`[data-testid="${TID_REMOTE_KIND_SSH}"]`).isDisplayed()).toBe(true);
  expect(await $(`[data-testid="${card}"]`).getAttribute("aria-pressed")).toBe("true");
  expect(await $(dialogSelector).$("nav").isExisting()).toBe(false);
  expect(await $(dialogSelector).$("form button[type='submit']").isEnabled()).toBe(true);
  expect(await $(dialogSelector).getAttribute("data-cwp20-submit-count")).toBe("0");
  expect(await $(dialogSelector).$('[data-testid="remote-connection-stages"]').isExisting()).toBe(
    false,
  );
  expect(await $(`[data-testid="${TID_SSH_SUCCESS}"]`).isExisting()).toBe(false);
}

async function openFromChat() {
  await clickTestIdByWebDriver(TID_COMPOSER_WORKSPACE_TRIGGER);
  await clickTestIdByWebDriver(TID_COMPOSER_REMOTE_CONNECTION);
  await $(dialogSelector).waitForDisplayed();
  await $(`[data-testid="${TID_SSH_HOST_INPUT}"]`).waitForDisplayed();
  // 记录真实提交事件；不能让空字段校验把双击误提交掩盖成“未连接”。
  await browser.execute((selector) => {
    const dialog = document.querySelector<HTMLElement>(selector);
    if (!dialog) throw new Error("Missing remote connection dialog");
    dialog.dataset.cwp20SubmitCount = "0";
    dialog.addEventListener("submit", () => {
      dialog.dataset.cwp20SubmitCount = String(Number(dialog.dataset.cwp20SubmitCount) + 1);
    });
  }, dialogSelector);
}
