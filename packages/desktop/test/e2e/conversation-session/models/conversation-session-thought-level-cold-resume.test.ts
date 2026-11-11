import { clearAppData, readModelProviders, readSettings } from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  restartIntoWorkspace,
  restartIntoWorkspacePreservingProfile,
  seedReplayProvider,
} from "#e2e/helpers/model-provider-restart";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import {
  E2E_REPLY_TOKEN,
  getV4ModelConfig,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  switchV4Model,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const PROVIDER_ID = "e2e-glm52-cold-resume";
const MODEL_ID = "GLM-5.2";
const THOUGHT_LEVEL = "max";
let replayServer: Awaited<ReturnType<typeof startConversationModelProviderReplayServer>> | null =
  null;

describe("历史 session 思考深度冷恢复 E2E", () => {
  before(async () => {
    replayServer = await startConversationModelProviderReplayServer(
      "conversation-session-thought-level-cold-resume",
    );
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await replayServer?.stop();
    replayServer = null;
  });

  it("I63: Desktop/Host/CLI 冷重启后同一 completed task 仍保持 GLM-5.2 max", async function () {
    this.timeout(260000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      id: PROVIDER_ID,
      // 个人 Provider 不能依赖旧内建 GLM metadata 补齐；明确声明被验证的合法档位和 wire map。
      models: [
        {
          id: MODEL_ID,
          reasoningLevel: {
            values: ["high", "max"],
            map: '{"chat_template_kwargs":{"reasoning_effort":reasoningLevel}}',
          },
        },
      ],
      name: "GLM-5.2 Cold Resume E2E",
    });
    try {
      await restartIntoWorkspace();
    } catch (cause) {
      // 正式回放曾在准备阶段重启后进入欢迎页；先保留脱敏配置事实，区分 seed 丢失与启动门禁问题。
      const [providers, settings] = await Promise.all([readModelProviders(), readSettings()]);
      throw new Error(
        `I63 准备阶段重启失败: ${JSON.stringify({
          providerFamilyDomain: settings.providerFamilyDomain,
          providers: providers.map((provider) => ({
            id: provider.id,
            enabled: provider.enabled,
            apiKeyPresent: Boolean(provider.apiKey),
            systemDisabledReason: provider.systemDisabledReason,
            models: provider.models.map((model) => ({
              id: model.id,
              disabledReason: model.disabledReason,
            })),
          })),
        })}`,
        { cause },
      );
    }
    await prepareV4ConversationE2E({ skipProvider: true });
    // Recent 偏好不会覆盖已初始化草稿；首轮必须通过真实模型选择器建立会话配置。
    await switchV4Model(PROVIDER_ID, MODEL_ID, THOUGHT_LEVEL);
    await waitForModelConfig();

    const runId = Date.now();
    const seedMarker = `E2E_THOUGHT_COLD_RESUME_SEED_${runId}`;
    const seedPrompt = buildPrompt(seedMarker);
    await sendV4Prompt(seedPrompt);
    await waitForV4TimelineContaining(E2E_REPLY_TOKEN, 60000);
    const seedRequest = await waitForUpstreamNetworkCapture(seedMarker);
    assertUpstreamRequestCapture(seedRequest, { expectedText: seedPrompt, model: MODEL_ID });
    assertGlm52MaxRequest(seedRequest.requestJson);
    const completed = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "GLM-5.2 max 首轮没有完成",
      90000,
    );
    const sessionId = completed.sessionId;
    if (!sessionId || sessionId === "draft") throw new Error("completed sessionId missing");

    // browser.reloadSession 会完整重启 Electron、Host 与 CLI；renderer reload 不能代替这条边界。
    // 原因：直接 reloadSession 会换临时 userData；冷恢复必须保留并 flush 当前用户配置。
    await restartIntoWorkspacePreservingProfile();
    await selectV4TaskById(sessionId);
    await waitForModelConfig();

    const followMarker = `E2E_THOUGHT_COLD_RESUME_FOLLOW_${runId}`;
    const followPrompt = buildPrompt(followMarker);
    await sendV4Prompt(followPrompt);
    const followRequest = await waitForUpstreamNetworkCapture(followMarker);
    assertUpstreamRequestCapture(followRequest, { expectedText: followPrompt, model: MODEL_ID });
    assertGlm52MaxRequest(followRequest.requestJson);
    await waitForV4TimelineContaining(E2E_REPLY_TOKEN, 60000);
  });
});

function buildPrompt(marker: string) {
  return `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

async function waitForModelConfig() {
  let latest = await getV4ModelConfig();
  await browser.waitUntil(
    async () => {
      latest = await getV4ModelConfig();
      return (
        latest.provider === PROVIDER_ID &&
        latest.model === MODEL_ID &&
        latest.thought === THOUGHT_LEVEL
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `V4 历史配置没有恢复 GLM-5.2/max: ${JSON.stringify(latest)}`,
    },
  );
}

function assertGlm52MaxRequest(requestJson: unknown) {
  expect(readNested(requestJson, ["chat_template_kwargs", "reasoning_effort"])).toBe(THOUGHT_LEVEL);
  expect(readNested(requestJson, ["chat_template_kwargs", "enable_thinking"])).toBeUndefined();
  expect(readNested(requestJson, ["extra_body"])).toBeUndefined();
}

function readNested(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
