import { UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL } from "#e2e/helpers/upstream-provider";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
  readUpstreamUsageFromCapture,
  waitForContextUsageFromCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";

const UPSTREAM_REPLY_TOKEN =
  process.env.E2E_PROVIDER_EXPECT_REPLY_TEXT?.trim() || "upstream-e2e-ok";
const UPSTREAM_REQUEST_PROMPT =
  process.env.E2E_PROVIDER_PROMPT?.trim() ||
  `Reply with exactly "${UPSTREAM_REPLY_TOKEN}" and no other text.`;

describe("桌面端 上游 Provider E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("应能在设置页配置 上游 并用新增模型发消息", async function () {
    this.timeout(120000);
    // 修复原因：beforeSession 重置 HOME 后会按当前 case 预置登录态；无条件点击欢迎页
    // 会让真实 smoke 在全量运行时误报缺少登录按钮。统一准备流程只在欢迎页真实存在时登录。
    await prepareV4ConversationE2E();

    // 修复原因：legacy chat-input 已被 V4 composer 替代；真实 provider smoke 必须走
    // 当前产品发送入口，否则会在请求发出前误报旧 DOM 不存在。
    await sendV4Prompt(UPSTREAM_REQUEST_PROMPT);

    const captureRecord = await waitForUpstreamNetworkCapture(UPSTREAM_REQUEST_PROMPT);
    assertUpstreamRequestCapture(captureRecord, {
      expectedText: UPSTREAM_REQUEST_PROMPT,
      model: UPSTREAM_MODEL,
    });
    if (UPSTREAM_THOUGHT_LEVEL) {
      assertUpstreamThoughtLevelCapture(captureRecord, UPSTREAM_THOUGHT_LEVEL);
    }
    await waitForV4AssistantMessageContaining(UPSTREAM_REPLY_TOKEN, 90000);
    await waitForContextUsageFromCapture(readUpstreamUsageFromCapture(captureRecord));
  });
});
