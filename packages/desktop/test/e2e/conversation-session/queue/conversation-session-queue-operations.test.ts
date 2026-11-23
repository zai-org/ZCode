import { setRendererViewport, clearRendererViewport } from "#e2e/helpers/renderer-viewport";
import { join } from "node:path";
import { releaseControlledReplay, waitForControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  approveV4Permission,
  waitForV4PermissionDialogInComposerDock,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  getV4ComposerText,
  setV4ComposerText,
  dragV4QueueItemOnto,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ConversationState,
  waitForV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import {
  clickQueueRemove,
  getQueueItems,
  waitForQueueCount,
  waitForQueueOrderContaining,
} from "#e2e/helpers/conversation-session-queue";
import { countUpstreamRequestsContaining } from "#e2e/helpers/conversation-session-network";
import {
  getV4QueueItemEditLock,
  openV4QueueItemEditInComposer,
  waitForV4ComposerEditClosed,
  waitForV4QueueItemEditLock,
} from "#e2e/helpers/v4-composer-edit";

describe("会话区 Held Queue 操作 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("held queue 编辑原位冻结，重排和删除其他项保留编辑内容，提交原地替换且不触发模型请求", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const runningPrompt = `E2E_SLOW_STREAM E2E_QUEUE_OPS_RUNNING_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(runningPrompt);
    await waitForV4ComposerText("", "held queue 操作首轮发送后输入框没有清空");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "held queue 操作首轮没有进入 streaming",
      30000,
    );

    const firstQueuedPrompt = `E2E_QUEUE_OPS_FIRST_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const secondQueuedPrompt = `E2E_QUEUE_OPS_SECOND_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const thirdQueuedPrompt = `E2E_QUEUE_OPS_THIRD_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

    await sendV4Prompt(firstQueuedPrompt);
    await waitForQueueCount(1);
    await sendV4Prompt(secondQueuedPrompt);
    await waitForQueueCount(2);
    await sendV4Prompt(thirdQueuedPrompt);
    let queue = await waitForQueueCount(3);
    expect(queue.map((item) => item.content)).toEqual([
      firstQueuedPrompt,
      secondQueuedPrompt,
      thirdQueuedPrompt,
    ]);

    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 3,
      "held queue 操作 stop 后没有保留 3 条队列",
      30000,
    );

    queue = await getQueueItems();
    const firstId = queue[0]?.id;
    const secondId = queue[1]?.id;
    const thirdId = queue[2]?.id;
    if (!firstId || !secondId || !thirdId) {
      throw new Error(`队列项 id 缺失: ${JSON.stringify(queue)}`);
    }

    const editedSecondPrompt = `E2E_QUEUE_OPS_SECOND_EDITED_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const editedRequestsBefore = await countUpstreamRequestsContaining(
      `E2E_QUEUE_OPS_SECOND_EDITED_${runId}`,
    );
    // 编辑时队列项原位冻结（docs/ui/composer-edit-mode.md），composer 载入原文。
    await openV4QueueItemEditInComposer(secondId);
    await waitForV4ComposerText(secondQueuedPrompt, "编辑态没有载入原文");
    queue = await waitForQueueCount(3);
    expect(queue.map((item) => item.id)).toEqual([firstId, secondId, thirdId]);
    // 编辑态在 lock ACK 后进入；editLock 随后经投影到达，需等待而不是读一次。
    await waitForV4QueueItemEditLock(secondId, (state) => state.locked, "编辑项没有显示编辑锁");
    await setV4ComposerText(editedSecondPrompt);
    expect(await countUpstreamRequestsContaining(`E2E_QUEUE_OPS_SECOND_EDITED_${runId}`)).toBe(
      editedRequestsBefore,
    );

    // 冻结项之外的项仍可重排；编辑内容不受影响。
    await dragV4QueueItemOnto(thirdId, firstId);
    queue = await waitForQueueOrderContaining(
      [`E2E_QUEUE_OPS_THIRD_${runId}`, `E2E_QUEUE_OPS_FIRST_${runId}`],
      "重排队列项后没有只改变 queue 顺序",
    );
    expect(queue.map((item) => item.id)).toEqual([thirdId, firstId, secondId]);
    expect(await getV4ComposerText()).toBe(editedSecondPrompt);

    const removedRequestsBefore = await countUpstreamRequestsContaining(
      `E2E_QUEUE_OPS_FIRST_${runId}`,
    );
    await clickQueueRemove(firstId);
    queue = await waitForQueueCount(2);
    expect(queue.map((item) => item.id)).toEqual([thirdId, secondId]);
    expect(queue.map((item) => item.content).join("\n")).not.toContain(
      `E2E_QUEUE_OPS_FIRST_${runId}`,
    );
    expect(await getV4ComposerText()).toBe(editedSecondPrompt);
    expect(await countUpstreamRequestsContaining(`E2E_QUEUE_OPS_FIRST_${runId}`)).toBe(
      removedRequestsBefore,
    );

    // 提交编辑：原地替换 second，ID 与位置不变；held queue 下不触发消费。
    await sendV4Prompt(editedSecondPrompt);
    await waitForV4ComposerEditClosed("held queue 编辑提交后没有退出编辑态", 30000);
    queue = await waitForQueueOrderContaining(
      [`E2E_QUEUE_OPS_THIRD_${runId}`, `E2E_QUEUE_OPS_SECOND_EDITED_${runId}`],
      "编辑提交后队列项没有原地替换",
    );
    expect(queue.map((item) => item.id)).toEqual([thirdId, secondId]);
    expect((await getV4QueueItemEditLock(secondId)).locked).toBe(false);
    await waitForV4ComposerText("", "编辑提交后没有恢复原草稿（空）");
    expect(await countUpstreamRequestsContaining(`E2E_QUEUE_OPS_SECOND_EDITED_${runId}`)).toBe(
      editedRequestsBefore,
    );
  });
  for (const kind of ["permission", "question"] as const) {
    it(`已有队列在 ${kind} 阻塞态仍可删除，宽窄视口均可见`, async function () {
      this.timeout(180000);
      await prepareV4ConversationE2E();
      const marker = `E2E_QUEUE_OPS_BLOCK_${kind.toUpperCase()}`;
      const fixtureId = `queue-block-${kind}`;
      await sendV4Prompt(marker);
      await waitForControlledReplay(fixtureId);
      await sendV4Prompt(`E2E_QUEUE_OPS_KEEP_${kind}`);
      await waitForQueueCount(1);
      await sendV4Prompt(`E2E_QUEUE_OPS_DELETE_${kind}`);
      const queue = await waitForQueueCount(2);
      await releaseControlledReplay(fixtureId);
      if (kind === "permission") {
        expect((await waitForV4PermissionDialogInComposerDock()).composerHidden).toBe(true);
      } else {
        await $('[data-elicitation-dialog-body="true"]').waitForDisplayed({ timeout: 30000 });
      }
      const queueElement = $('[data-testid="v4-queue"]');
      await queueElement.waitForDisplayed({ timeout: 10000 });
      try {
        await setRendererViewport(900, 900);
        await queueElement.waitForDisplayed();
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `${fixtureId}-narrow.png`),
        );
        const remove = $(`[data-testid="v4-queue-item-delete-${queue[1]!.id}"]`);
        await remove.waitForDisplayed();
        expect(await remove.isClickable()).toBe(true);
        expect(
          await browser.execute((id) => {
            const rect = document
              .querySelector(`[data-testid="v4-queue-item-delete-${id}"]`)
              ?.getBoundingClientRect();
            return Boolean(
              rect &&
              rect.left >= 0 &&
              rect.right <= innerWidth &&
              rect.top >= 0 &&
              rect.bottom <= innerHeight,
            );
          }, queue[1]!.id),
        ).toBe(true);
        await remove.click();
        expect((await waitForQueueCount(1))[0]!.id).toBe(queue[0]!.id);
      } finally {
        await clearRendererViewport();
      }
      // React 队列节点即使渲染 null 仍为真；记录真实父节点，检查最后一项删除后连同留白退出。
      await browser.execute(() => {
        document
          .querySelector('[data-testid="v4-queue"]')
          ?.parentElement?.setAttribute("data-e2e-queue-wrapper", "true");
      });
      await $(`[data-testid="v4-queue-item-delete-${queue[0]!.id}"]`).click();
      await waitForQueueCount(0);
      expect(await $('[data-e2e-queue-wrapper="true"]').isExisting()).toBe(false);
      if (kind === "permission") {
        expect(await approveV4Permission()).toBe(true);
      } else {
        await $('[data-elicitation-dialog-body="true"] textarea').setValue("Continue verification");
        const buttons = await $$('[data-elicitation-dialog-footer="true"] button');
        let submitted = false;
        for (const button of buttons) {
          if (/^(Submit|提交)$/.test((await button.getText()).trim())) {
            await button.click();
            submitted = true;
            break;
          }
        }
        expect(submitted).toBe(true);
      }
      await waitForQueueCount(0);
      await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN, 60000);
      expect(await countUpstreamRequestsContaining(`E2E_QUEUE_OPS_DELETE_${kind}`)).toBe(0);
    });
  }
});
