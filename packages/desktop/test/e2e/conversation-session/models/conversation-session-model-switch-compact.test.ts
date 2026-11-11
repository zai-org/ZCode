import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  UPSTREAM_MODEL,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_SECONDARY_THOUGHT_LEVEL,
  UPSTREAM_THOUGHT_LEVEL,
  selectUpstreamModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4CompactMarker,
  waitForV4ComposerText,
  waitForV4Pane,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_MODEL_SWITCH_COMPACT_SEED";
const COMPACT_REQUEST = "CRITICAL: Respond with TEXT ONLY";

describe("会话区模型切换与 Compact 交集 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("completed 后选择 secondary 再 /compact，摘要使用提交时的新模型", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E();
    await ensureReadonlyToolFixtureFile();
    await selectUpstreamModelById(UPSTREAM_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_THOUGHT_LEVEL);
    // 原因：旧 case 的单轮短文本可能合法 noop，旧 non-stream/operationId 也不属于 V4。
    // 用两轮真实 Read 保留可压缩历史；两模型均使用普通窗口，guard 另由专门用例验证。
    for (const index of [1, 2]) {
      const marker = `${MARKER}_${index}`;
      await sendV4Prompt(buildReadonlyToolPrompt(marker));
      await waitForV4ComposerText("", "准备历史后输入框未清空");
      await waitForV4UserMessageContaining(marker);
      await waitForV4Pane(
        (pane) => !pane.canStop && pane.timelineText.includes("upstream-e2e-ok"),
        "只读工具历史未完成",
        60000,
      );
    }
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    // 原因：旧 compact 丢掉 Composer 选择，导致菜单已选 secondary 但摘要仍用旧模型。
    // 不先发送普通消息，让抓包直接证明 compact 自身携带并使用新选择。
    await sendV4Prompt("/compact");
    await waitForV4ComposerText("", "/compact 发送后输入框未清空");
    const request = await waitForUpstreamNetworkCapture(COMPACT_REQUEST);
    assertUpstreamRequestCapture(request, {
      expectedText: COMPACT_REQUEST,
      model: UPSTREAM_SECONDARY_MODEL,
    });
    assertUpstreamThoughtLevelCapture(request, UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    expect(request.requestJson).toMatchObject({ stream: true });
    expect(request.responseHeaders["content-type"]).toContain("text/event-stream");
    expect(JSON.stringify(request.requestJson)).toContain(MARKER);
    await waitForV4CompactMarker({ origin: "manual", status: "success" });
  });
});
