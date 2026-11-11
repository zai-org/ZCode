import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import type { E2ENetworkCaptureRecord } from "#e2e/helpers/network-capture-proxy";
import {
  refreshSeededOpenAIProvidersThroughSettings,
  seedCustomOpenAIChatCompletionsProvider,
} from "#e2e/helpers/custom-openai-provider";
import {
  restartIntoWorkspacePreservingProfile,
  waitForSelectedModel,
} from "#e2e/helpers/model-provider-restart";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import {
  E2E_REPLY_TOKEN,
  getV4ModelConfig,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4ComposerText,
  switchV4Model,
  waitForV4ComposerSelectionReady,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const PROVIDER_ID = "e2e-provider-registry-prewarm";
const PROVIDER_NAME = "Provider Registry Prewarm E2E";
const MODEL_ID = "GLM-5.2";
let modelProviderReplayServer: Awaited<
  ReturnType<typeof startConversationModelProviderReplayServer>
> | null = null;

describe("草稿预热 process provider registry 就绪屏障 E2E", () => {
  before(async () => {
    modelProviderReplayServer = await startConversationModelProviderReplayServer(
      "conversation-session-provider-registry-prewarm",
    );
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await modelProviderReplayServer?.stop();
    modelProviderReplayServer = null;
  });

  it("I64/P0-18: 冷启动草稿 createSession 应等待 process registry 就绪", async function () {
    this.timeout(300000);

    await prepareV4ConversationE2E({ skipProvider: true });
    await seedCustomOpenAIChatCompletionsProvider({
      modelId: MODEL_ID,
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
    });
    await refreshSeededOpenAIProvidersThroughSettings([PROVIDER_NAME]);
    // 冷恢复 helper 恢复默认项目；选择必须写入同一项目的草稿，不能混用全局草稿目录。
    await startDraftFromProject(DEFAULT_WORKSPACE);
    // Recent seed 不能覆盖已初始化的持久草稿；通过真实选择器保存下次启动配置。
    await switchV4Model(PROVIDER_ID, MODEL_ID, "");

    // 仅改选项不会持久化草稿；非空正文是当前冷恢复合同的前置。
    await setV4ComposerText("E2E_PROVIDER_REGISTRY_PREWARM_DRAFT");
    await restartIntoWorkspacePreservingProfile();
    await waitForV4ComposerText("E2E_PROVIDER_REGISTRY_PREWARM_DRAFT", "冷恢复没有保留项目草稿");
    await waitForV4ComposerSelectionReady(60000);

    const config = await getV4ModelConfig();
    expect(config).toMatchObject({
      model: MODEL_ID,
      provider: PROVIDER_ID,
      source: "composer",
    });
    await waitForSelectedModel(PROVIDER_ID, MODEL_ID);
    // 预热和菜单修改不更新 Recent；此处以恢复的草稿及首发真实请求验证所选 Provider。

    const runId = Date.now();
    const marker = `E2E_PROVIDER_REGISTRY_PREWARM_${runId}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prompt);
    const capture = await waitForUpstreamNetworkCapture(marker);
    assertUpstreamRequestCapture(capture, {
      expectedText: prompt,
      model: MODEL_ID,
    });
    assertRequestUsesConfiguredProviderEndpoint(capture);
    await waitForV4TimelineContaining(E2E_REPLY_TOKEN);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "provider registry 冷启动首轮没有完成",
      90000,
    );
  });
});

function assertRequestUsesConfiguredProviderEndpoint(record: E2ENetworkCaptureRecord) {
  const expectedBaseURL = modelProviderReplayServer?.baseUrl.trim().replace(/\/+$/u, "");
  if (!expectedBaseURL) {
    throw new Error("provider registry prewarm replay server 尚未初始化");
  }
  if (record.url !== expectedBaseURL && !record.url.startsWith(`${expectedBaseURL}/`)) {
    throw new Error(
      `冷启动首个请求没有命中配置的 custom Provider Endpoint: ${JSON.stringify({
        expectedBaseURL,
        requestUrl: record.url,
      })}`,
    );
  }
}
