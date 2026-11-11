import { encodeCustomModelValue } from "@zcode/shared";
import { TID_SETTINGS_BACK_BUTTON } from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  getSelectedUpstreamModelLabel,
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import { createCustomOpenAIChatCompletionsProvider } from "#e2e/helpers/custom-openai-provider";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import {
  E2E_REPLY_TOKEN,
  getV4ModelConfig,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const OPENROUTER_MODEL_ID = "nvidia/nemotron-3-ultra-550b-a55b:free";
const FALLBACK_THOUGHT_LEVEL = "disabled";
const PROVIDER_NAME_PREFIX = "OpenRouter Colon E2E";
let modelProviderReplayServer: Awaited<
  ReturnType<typeof startConversationModelProviderReplayServer>
> | null = null;

describe("OpenRouter 含冒号 modelId E2E", () => {
  before(async () => {
    modelProviderReplayServer = await startConversationModelProviderReplayServer(
      "conversation-session-openrouter-model-id-colon",
    );
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await modelProviderReplayServer?.stop();
    modelProviderReplayServer = null;
  });

  it("I62/P0-17: :free 后缀应贯穿草稿选择、V4 配置与首发请求", async function () {
    this.timeout(240000);

    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);

    const runId = Date.now();
    const providerName = `${PROVIDER_NAME_PREFIX} ${runId}`;
    const provider = await createCustomOpenAIChatCompletionsProvider({
      modelId: OPENROUTER_MODEL_ID,
      providerName,
    });
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15000,
      timeoutMsg: "设置页返回按钮没有出现",
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);

    await selectUpstreamProviderModelById(OPENROUTER_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: provider.id,
      providerName,
    });
    // 修复原因：产品要求切换到新模型后由用户显式选择思考档位，未选时发送键保持禁用；
    // 未知自定义模型只继承 Built-in 兜底的 disabled 档位。
    await selectUpstreamThoughtLevelValue(FALLBACK_THOUGHT_LEVEL);
    const expectedValue = encodeCustomModelValue(provider.id, OPENROUTER_MODEL_ID);
    const toolbar = await getSelectedUpstreamModelLabel();
    expect(toolbar.currentValue).toBe(expectedValue);

    const config = await getV4ModelConfig();
    expect(config).toMatchObject({
      model: OPENROUTER_MODEL_ID,
      provider: provider.id,
      source: "composer",
    });

    const marker = `E2E_OPENROUTER_MODEL_ID_COLON_${runId}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prompt);
    const capture = await waitForUpstreamNetworkCapture(marker);
    assertUpstreamRequestCapture(capture, {
      expectedText: prompt,
      model: OPENROUTER_MODEL_ID,
    });
    await waitForV4TimelineContaining(E2E_REPLY_TOKEN);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "OpenRouter 含冒号模型首轮没有完成",
      90000,
    );
  });
});
