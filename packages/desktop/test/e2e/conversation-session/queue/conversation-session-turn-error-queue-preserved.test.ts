// N05 / NQ：普通主 turn 报错时，已 accepted 的 future queue 不得被清空。
// 证据层：上游 replay 500 + delay、V4 queue DOM 投影、task runtimeStatus、恢复请求。
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  waitForUpstreamNetworkCapture,
  waitForUpstreamNetworkRequestStarted,
} from "#e2e/helpers/upstream-capture";
import {
  clickV4PausedQueueResume,
  getV4ConversationState,
  getV4QueueAutoDrain,
  getV4QueueItems,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4PausedQueueBanner,
  waitForV4QueueCount,
} from "#e2e/helpers/v4-conversation";

const SOURCE_MARKER = "E2E_TURN_ERROR_QUEUE_SOURCE";
const QUEUED_MARKER = "E2E_TURN_ERROR_QUEUE_FOLLOWUP";
const RECOVERED_REPLY = "TURN_ERROR_QUEUE_RECOVERED";

describe("NQ：turn error 保留 future queue", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("主轮 500 失败后保留 queue，暂停自动消费并可继续 FIFO", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E();

    await sendV4Prompt(`${SOURCE_MARKER}: 触发一个可恢复的 provider error。`);
    await waitForUpstreamNetworkRequestStarted(SOURCE_MARKER);

    // replay fixture 在响应头前延迟，给 renderer 留出 running admission 窗口。
    await sendV4Prompt(`${QUEUED_MARKER}: 错误后按队首恢复。`);
    await waitForV4QueueCount(1);

    // runtimeStatus 在 renderer 侧会把 terminal error 收口为 idle；500 抓包是错误事实，
    // queueCount + paused banner 是本 case 的 UI 恢复契约。
    const failedRequest = await waitForUpstreamNetworkCapture(SOURCE_MARKER);
    expect(failedRequest.statusCode).toBe(500);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 1,
      "turn error 后没有收口或 queue 被清空",
      30000,
    );
    expect((await getV4QueueItems())[0]?.text).toContain(QUEUED_MARKER);
    expect(await getV4QueueAutoDrain()).toBe(false);
    await waitForV4PausedQueueBanner();

    // 错误终态不能自动发送；只有显式继续才允许消费队首。
    await clickV4PausedQueueResume();
    await waitForV4AssistantMessageContaining(RECOVERED_REPLY, 60000);
    await waitForV4QueueCount(0, 30000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.queueCount === 0 && snapshot.runtimeStatus !== "streaming",
      "继续后 queue 没有按 FIFO 消费到空",
      30000,
    );
    expect(await getV4ConversationState()).not.toMatchObject({ queueCount: 1 });
  });
});
