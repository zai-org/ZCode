import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  E2E_REPLY_TOKEN,
  assertVisibleV4UserMessagesNotContaining,
  clickV4Stop,
  editFirstV4UserQuery,
  getV4Messages,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForUpstreamRequestContaining } from "#e2e/helpers/conversation-session-network";
import { waitForQueueContaining, waitForQueueCount } from "#e2e/helpers/conversation-session-queue";

const PARTIAL = "E2E_INTERRUPTED_PARTIAL";

declare global {
  interface Window {
    __interruptedTurnIdentity?: { node: Element; turnId: string };
  }
}

describe("会话区 Interrupted Actions E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("interrupted 后允许 edit；空队列和 held queue 下 stopped assistant partial 均不可 fork", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E();
    // 原因：旧 Stop/Edit/Fork selector 已退役，且快速完成分支会直接跳过核心断言。
    // 回放在真实 partial 后保持连接；必须点击 V4 Stop，不能用自然完成替代 interrupted。
    const source = "E2E_INTERRUPTED_EDIT_SOURCE";
    await startPartial(source);
    await clickV4Stop();
    await waitForV4Pane((pane) => !pane.canStop, "Stop 没有收口当前轮");
    await assertStoppedTurnIdentity();
    await assertPartialCannotFork();
    const edited = "E2E_INTERRUPTED_EDIT_RERUN";
    expect((await getV4Messages("user")).at(-1)?.text).toContain(source);
    await editFirstV4UserQuery(edited);
    await waitForUpstreamRequestContaining(edited);
    await waitForV4UserMessageContaining(edited);
    await assertVisibleV4UserMessagesNotContaining(source);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4Pane((pane) => !pane.canStop, "编辑重跑没有完成");

    for (const held of [false, true]) {
      await startNewV4Draft();
      await startPartial(held ? "E2E_INTERRUPTED_NO_FORK_HELD" : "E2E_INTERRUPTED_NO_FORK_EMPTY");
      let queuedId: string | undefined;
      if (held) {
        await sendV4Prompt("E2E_INTERRUPTED_NO_FORK_HELD_QUEUE");
        await waitForQueueContaining("E2E_INTERRUPTED_NO_FORK_HELD_QUEUE");
        queuedId = (await waitForQueueCount(1))[0]?.id;
        expect(queuedId).toBeTruthy();
      }
      await clickV4Stop();
      await waitForV4Pane((pane) => !pane.canStop, "停止 partial 后没有收口");
      await assertStoppedTurnIdentity();
      await assertPartialCannotFork();
      const queue = await waitForQueueCount(held ? 1 : 0);
      if (held) {
        expect(queue[0]?.id).toBe(queuedId);
        expect(queue[0]?.content).toContain("E2E_INTERRUPTED_NO_FORK_HELD_QUEUE");
      }
    }
  });
});

async function startPartial(marker: string) {
  await sendV4Prompt(
    `E2E_SLOW_STREAM ${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
  );
  await waitForV4UserMessageContaining(marker);
  await waitForV4AssistantMessageContaining(PARTIAL);
  await waitForV4Pane((pane) => pane.canStop, "受控 partial 没有保持运行窗口");
  await browser.execute(() => {
    const node = document.querySelector('[data-v4-running-live-tail="true"]');
    const turnId = node?.getAttribute("data-turn-id");
    if (!node || !turnId) throw new Error("Stop 前没有运行中的轮次");
    window.__interruptedTurnIdentity = { node, turnId };
  });
}

async function assertStoppedTurnIdentity() {
  // Stop 曾把整轮迁到另一个父容器；只检查文本仍在会漏掉重挂及淡入闪空。
  // canStop 与消息终态可能分帧到达，必须等当前轮真正退出 running 再核对身份。
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const before = window.__interruptedTurnIdentity;
        if (!before) return false;
        const current = document.querySelector(
          `[data-v4-turn-unit][data-turn-id="${before.turnId}"]`,
        );
        return current !== null && current.getAttribute("data-v4-running-live-tail") !== "true";
      }),
    { timeout: 10000, timeoutMsg: "Stop 后当前轮尚未显示终态" },
  );
  const identity = await browser.execute(() => {
    const before = window.__interruptedTurnIdentity;
    if (!before) throw new Error("Stop 前未记录轮次身份");
    const current = document.querySelector(`[data-v4-turn-unit][data-turn-id="${before.turnId}"]`);
    return { sameNode: current === before.node, connected: before.node.isConnected };
  });
  expect(identity).toEqual({ sameNode: true, connected: true });
}

async function assertPartialCannotFork() {
  const partial = (await getV4Messages("assistant")).find((message) =>
    message.text.includes(PARTIAL),
  );
  expect(partial?.id).toBeTruthy();
  const enabled = await browser.execute((rowId) => {
    const row = document.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`);
    if (!row) throw new Error("partial 行不存在，不能证明禁止 fork");
    return Array.from(row.querySelectorAll<HTMLButtonElement>('[data-testid^="v4-fork-"]')).some(
      (button) => !button.disabled && button.getAttribute("aria-disabled") !== "true",
    );
  }, partial!.id);
  expect(enabled).toBe(false);
}
