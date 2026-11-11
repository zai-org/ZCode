import {
  TID_CHAT_ASSISTANT_HISTORY_CONTENT,
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
} from "@zcode/shared/test-ids";

// 「已处理」折叠（ConversationTurnGroup 的 history 收纳）的读取约定，见 docs/ui/chat-virtual-scroll.md。
//
// 修复原因：最新一轮结束后不再换父节点重挂（f207b93cda），而是原地播放折叠的收起动画。
// 动画期间折叠内容（data-history-open="false"）仍在 DOM 里，动画结束才卸载。只用
// isExisting 判断「行已出现」时，会在收起途中拿到即将卸载的节点，随后读卡全部落空
// （容器实测：首轮轮询命中、300 ms 后节点消失且不再出现）。所以「出现」必须同时满足
// 不在收起中的折叠里；读卡的轮询里也要每轮补开收起的折叠。

/** 点开所有收起的「已处理」折叠，相当于用户逐个点开。 */
export async function openClosedHistoryFolds(): Promise<void> {
  await browser.execute((triggerPrefix: string) => {
    for (const trigger of document.querySelectorAll<HTMLElement>(
      `[data-testid^="${triggerPrefix}-"][data-history-open="false"]`,
    )) {
      trigger.click();
    }
  }, TID_CHAT_ASSISTANT_HISTORY_TRIGGER);
}

/** 选择器命中的节点在 DOM 中，且不在收起（或正在收起）的「已处理」折叠里。 */
export async function isOutsideClosedHistory(selector: string): Promise<boolean> {
  return browser.execute(
    (target: string, contentPrefix: string) => {
      const node = document.querySelector(target);
      return (
        node !== null &&
        node.closest(`[data-testid^="${contentPrefix}-"][data-history-open="false"]`) === null
      );
    },
    selector,
    TID_CHAT_ASSISTANT_HISTORY_CONTENT,
  );
}

/** 等节点出现在展开的折叠里或折叠外：每轮没找到就补开收起的折叠。 */
export async function revealOutsideClosedHistory(
  selector: string,
  timeoutMsg: string,
  timeout = 30_000,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      if (await isOutsideClosedHistory(selector)) return true;
      await openClosedHistoryFolds();
      return false;
    },
    { timeout, timeoutMsg },
  );
}
