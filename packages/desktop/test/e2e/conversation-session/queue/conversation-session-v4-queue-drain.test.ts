// catalog C02（queueAutoDrain）+ queuedPromptMessagePreserved 验收（case catalog 战役）。
// 证据层 L3：running 中入队 → 当前流结束后 runtime 自动 drain 队首（同 turn 第二次
// roundtrip）→ 排队文本必须以可见 user row 落入 timeline（live 投影修复回归，
// 见 fix(protocol-v4) heldQueueDisposition/drained user row 提交），且回复出现、queue 清空。
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getV4QueueItems,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("v4 catalog C02：queue 自动消费与消息保留", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("running 中入队 → 自动 drain → 排队文本落为可见 user row + 回复出现", async () => {
    await prepareV4ConversationE2E();

    // 首轮 8s 慢流，留出入队窗口
    await sendV4Prompt("E2E_V4_DRAIN_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_DRAIN_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有进入 running（canStop）",
      45000,
    );

    // running 中入队一条（autoDrain 默认 true）
    await sendV4Prompt("E2E_V4_DRAIN_Q1 排队等答的问题");
    await waitForV4QueueCount(1, 30000);

    // 慢流结束后自动 drain：回复出现
    await waitForV4TimelineContaining("V4_DRAIN_Q1_REPLY", 60000);
    await waitForV4QueueCount(0, 15000);

    // queuedPromptMessagePreserved：被 drain 的排队文本必须留在可见历史（user row），
    // 不能从 queue 消失后只剩 assistant 回复。
    const snapshot = await waitForV4Pane(
      (s) => s.timelineText.includes("E2E_V4_DRAIN_Q1"),
      "drained 排队文本没有以可见 user row 落入 timeline",
      15000,
    );
    expect(snapshot.timelineText).toContain("V4_DRAIN_Q1_REPLY");
    expect(await getV4QueueItems()).toHaveLength(0);

    // 整轮收口
    await waitForV4Pane((s) => !s.canStop, "drain 后没有回到 idle", 45000);
  });
});
