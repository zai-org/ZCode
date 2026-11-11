import {
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom, setInputValueByTestIdDom } from "#e2e/helpers/desktop-app";
import { openV4UserQueryEditInComposer } from "#e2e/helpers/v4-composer-edit";

type MessageAction = "edit" | "fork";
type MessageRole = "user" | "assistant";

// 原因：旧消息 helper 读取 chat-message-id；V4 动作使用 canonical rowId，
// 两者不能互换。定位同时限定主 pane、消息角色和正文，避免点到其他分屏的同名回复。
export function getV4MessageAction(role: MessageRole, action: MessageAction, text: string) {
  return browser.execute(
    (paneId, expectedRole, actionName, expectedText) => {
      const pane = document.querySelector(`[data-testid="${paneId}"]`);
      const message = Array.from(pane?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []).find(
        (row) =>
          row.classList.contains(`group/${expectedRole}-row`) &&
          row.innerText.replace(/\u00a0/g, " ").includes(expectedText),
      );
      const messageId = message?.getAttribute("data-row-id");
      if (!messageId) return null;
      const actionTestId = `v4-${actionName}-${messageId}`;
      const button = pane?.querySelector<HTMLButtonElement>(`[data-testid="${actionTestId}"]`);
      return {
        messageId,
        testId: actionTestId,
        exists: Boolean(button),
        disabled: button?.disabled ?? false,
        ariaDisabled: button?.getAttribute("aria-disabled") === "true",
      };
    },
    testId(TID_V4_SESSION_PANE, "workspace-main"),
    role,
    action,
    text,
  );
}

export async function waitForV4MessageAction(
  role: MessageRole,
  action: MessageAction,
  text: string,
) {
  const result: { latest: Awaited<ReturnType<typeof getV4MessageAction>> } = { latest: null };
  await browser.waitUntil(
    async () => {
      const latest = await getV4MessageAction(role, action, text);
      result.latest = latest;
      return Boolean(latest?.exists && !latest.disabled && !latest.ariaDisabled);
    },
    { timeout: 30000, timeoutMsg: `V4 ${role} 消息没有可用 ${action} 动作: ${text}` },
  );
  if (!result.latest) throw new Error(`V4 消息不存在: ${text}`);
  return result.latest;
}

/** 通过 composer 编辑态提交指定 user 消息：编辑态下的发送按钮路由到 editUserQuery。 */
export async function editV4UserMessageContaining(currentText: string, nextText: string) {
  const action = await waitForV4MessageAction("user", "edit", currentText);
  await openV4UserQueryEditInComposer(action.messageId);
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, nextText);
  await clickTestIdByDom(TID_V4_COMPOSER_SEND);
  return action;
}

export async function forkV4AssistantContaining(text: string) {
  const action = await waitForV4MessageAction("assistant", "fork", text);
  const button = await $(`[data-testid="${action.testId}"]`);
  await button.scrollIntoView();
  await button.moveTo();
  await button.click();
  return action;
}
