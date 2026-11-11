import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  UPSTREAM_ALTERNATE_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
  UPSTREAM_ALTERNATE_PROVIDER_NAME,
  UPSTREAM_THOUGHT_LEVEL,
  getUpstreamProviderModelValues,
  getSelectedUpstreamModelLabel,
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

describe("会话区跨 provider 模型切换 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I13: 选择 alternate provider 后请求应使用 alternate provider 的模型", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    await selectUpstreamProviderModelById(UPSTREAM_ALTERNATE_MODEL, {
      includePlainModelFallback: false,
      providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
      providerName: UPSTREAM_ALTERNATE_PROVIDER_NAME,
    });
    // 目标模型可能默认 max；请求 high 的断言必须由真实 UI 选择建立前置条件。
    if (UPSTREAM_THOUGHT_LEVEL) await selectUpstreamThoughtLevelValue(UPSTREAM_THOUGHT_LEVEL);
    await assertSelectedAlternateProviderModel();

    const runId = Date.now();
    const marker = `E2E_SAME_MODEL_PROVIDER_IDENTITY_${runId}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "跨 provider 模型切换 case 首发后输入框没有清空");
    await waitForV4UserMessageContaining(marker);
    await assertSelectedAlternateProviderModel();

    const record = await waitForUpstreamNetworkCapture(marker);
    assertUpstreamRequestCapture(record, {
      expectedText: prompt,
      model: UPSTREAM_ALTERNATE_MODEL,
    });
    if (UPSTREAM_THOUGHT_LEVEL) {
      assertUpstreamThoughtLevelCapture(record, UPSTREAM_THOUGHT_LEVEL);
    }

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "跨 provider 模型切换 case 首轮完成后没有回到 idle",
      90000,
    );
  });
});

async function assertSelectedAlternateProviderModel() {
  const label = await getSelectedUpstreamModelLabel();
  // 合并菜单的模型标签只显示模型；供应商身份由下面的复合 currentValue 严格验证。
  expect(label.title).toBe(UPSTREAM_ALTERNATE_MODEL);
  const acceptedValues = getUpstreamProviderModelValues(UPSTREAM_ALTERNATE_MODEL, {
    includePlainModelFallback: false,
    providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
  });
  if (!acceptedValues.includes(label.currentValue)) {
    throw new Error(
      `当前模型没有保留 alternate provider 身份和模型: ${JSON.stringify({
        acceptedValues,
        label,
        model: UPSTREAM_ALTERNATE_MODEL,
        providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
      })}`,
    );
  }
}
