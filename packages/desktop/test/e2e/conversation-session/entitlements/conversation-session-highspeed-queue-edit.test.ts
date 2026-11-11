import { TID_CHAT_ERROR_BANNER } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { prepareHighspeedDrawWorkspace } from "#e2e/helpers/highspeed-card";
import { E2E_BIGMODEL_PLAN_PROVIDER_ID } from "#e2e/helpers/model-provider-restart";
import {
  clickV4QueueItemDelete,
  clickV4Stop,
  getV4ComposerText,
  getV4ModelConfig,
  getV4QueueItems,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import {
  openV4QueueItemEditInComposer,
  waitForV4ComposerEditClosed,
} from "#e2e/helpers/v4-composer-edit";

const RUNNING_PROMPT = "E2E_HIGHSPEED_QUEUE_EDIT_SLOW keep running";
const QUEUED_PROMPT = "E2E_HIGHSPEED_QUEUE_EDIT_PENDING original";
const RESUBMITTED_PROMPT = "E2E_HIGHSPEED_QUEUE_EDIT_RESUBMITTED changed";
const RUNNING_REPLY_TOKEN = "HIGHSPEED_QUEUE_EDIT_STREAMING";
const INTERNAL_HIGHSPEED_PROVIDER = "account:bigmodel-highspeed-card";

// Host Mock 场景：hit-queue-edit（按 spec 文件注入，见 helpers/highspeed-mock-env.ts）。
describe("Highspeed queued prompt edit E2E", () => {
  afterEach(async () => {
    const queued = await getV4QueueItems();
    for (const item of queued) {
      await clickV4QueueItemDelete(item.queueItemId);
    }
    if (queued.length > 0) await waitForV4QueueCount(0, 30000);

    const pane = await waitForV4Pane(() => true, "无法读取 Highspeed queue pane");
    if (pane.canStop) {
      await clickV4Stop();
      await waitForV4Pane((snapshot) => !snapshot.canStop, "Highspeed queue 收尾 stop 未完成");
    }
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("HS-E2E-06: 编辑 Highspeed 队列输入时工具栏载入普通模型，修改后原地替换", async function () {
    this.timeout(180000);

    await prepareHighspeedDrawWorkspace();
    await sendV4Prompt(RUNNING_PROMPT);
    await waitForV4TimelineContaining(RUNNING_REPLY_TOKEN, 45000);
    await waitForV4Pane(
      (snapshot) => snapshot.canStop,
      "首轮 Highspeed 输入没有保持 running",
      45000,
    );

    await sendV4Prompt(QUEUED_PROMPT);
    await waitForV4QueueCount(1, 30000);
    const [queued] = await getV4QueueItems();
    expect(queued?.text).toContain(QUEUED_PROMPT);
    if (!queued) throw new Error("Highspeed 队列项不存在");

    await openV4QueueItemEditInComposer(queued.queueItemId);
    expect(await getV4QueueItems()).toHaveLength(1);
    await browser.waitUntil(async () => (await getV4ComposerText()) === QUEUED_PROMPT, {
      timeout: 30000,
      timeoutMsg: "Highspeed 队列项没有载入 Composer 编辑态",
    });

    // Bug 根因：旧 QueueItem 保存单轮 Highspeed Selection，编辑时把隐藏 Provider
    // 载入 Composer，会污染修改后提交的 fallback。工具栏只能载入队列项的普通模型。
    expect(await getV4ModelConfig()).toMatchObject({
      provider: E2E_BIGMODEL_PLAN_PROVIDER_ID,
    });

    await sendV4Prompt(RESUBMITTED_PROMPT);
    await waitForV4ComposerEditClosed("Highspeed 队列项编辑提交后没有退出编辑态", 30000);
    await browser.waitUntil(
      async () => ((await getV4QueueItems())[0]?.text ?? "").includes(RESUBMITTED_PROMPT),
      { timeout: 30000, timeoutMsg: "Highspeed 队列项没有原地替换" },
    );
    const [resubmitted] = await getV4QueueItems();
    expect(resubmitted?.queueItemId).toBe(queued.queueItemId);
    expect((await getV4ModelConfig()).provider).not.toBe(INTERNAL_HIGHSPEED_PROVIDER);

    const errorBanner = $(`[data-testid="${TID_CHAT_ERROR_BANNER}"]`);
    expect(await errorBanner.isExisting()).toBe(false);
    expect((await $("body").getText()).includes(INTERNAL_HIGHSPEED_PROVIDER)).toBe(false);
  });
});
