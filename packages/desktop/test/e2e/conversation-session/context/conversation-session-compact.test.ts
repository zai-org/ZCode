import { clearAppData } from "#e2e/helpers/desktop-app";
import { UPSTREAM_MODEL } from "#e2e/helpers/upstream-provider";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import {
  assertVisibleV4UserMessagesNotContaining,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ComposerText,
  waitForV4CompactMarker,
  waitForV4Pane,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const REPLY = "upstream-e2e-ok";
const COMPACT_REQUEST = "CRITICAL: Respond with TEXT ONLY";

describe("会话区 Compact E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("手动 /compact 展示 completed 横条并发起流式摘要请求", async function () {
    this.timeout(150000);
    await prepareV4ConversationE2E();
    await ensureReadonlyToolFixtureFile();
    // 旧用例使用已删除的 Chat DOM 且假定非流式摘要。当前 V4 入口与摘要协议均为流式；
    // 两轮真实 Read 历史确保压缩有可保留的尾轮，不能把合法 noop 当成成功压缩。
    for (const index of [1, 2]) {
      await sendV4Prompt(buildReadonlyToolPrompt(`E2E_COMPACT_INITIAL_${index}`));
      await waitForV4ComposerText("", "发送后输入框未清空");
      await waitForV4UserMessageContaining(`E2E_COMPACT_INITIAL_${index}`);
      await waitForV4Pane(
        (pane) => !pane.canStop && pane.timelineText.includes(REPLY),
        "只读工具前置轮次未完成",
        60000,
      );
    }
    await sendV4Prompt("/compact");
    await waitForV4ComposerText("", "/compact 发送后输入框未清空");
    const request = await waitForUpstreamNetworkCapture(COMPACT_REQUEST);
    assertUpstreamRequestCapture(request, { expectedText: COMPACT_REQUEST, model: UPSTREAM_MODEL });
    expect(request.requestJson).toMatchObject({ stream: true });
    expect(JSON.stringify(request.requestJson)).toContain(REPLY);
    // V4 以 timeline row 标识压缩结果，不再投影旧 Chat 的 operationId。
    await waitForV4CompactMarker({ origin: "manual", status: "success" });
    await assertVisibleV4UserMessagesNotContaining("/compact");
  });
});
