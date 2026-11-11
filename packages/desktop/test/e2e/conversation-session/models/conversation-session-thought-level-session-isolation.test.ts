import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, setInputValueByTestIdDom } from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import { UPSTREAM_MODEL, UPSTREAM_PROVIDER_ID } from "#e2e/helpers/upstream-provider";
import {
  getV4ModelConfig,
  getV4ComposerText,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  switchV4Model,
  waitForV4ComposerSelectionReady,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import { isV4TurnCompleted } from "#e2e/helpers/v4-turn-completion";

// 修复原因：formal admission 禁止依赖整套 legacy conversation-session helper；
// 此 case 只需要稳定回复文本，因此把常量留在 case 内，避免重新引入旧测试栈。
const A_SEED_REPLY = "I55_A_SEED_DONE";
const B_SEED_REPLY = "I55_B_SEED_DONE";
const B_FOLLOW_REPLY = "I55_B_FOLLOW_DONE";
const A_FOLLOW_REPLY = "I55_A_FOLLOW_DONE";
const INITIAL_THOUGHT_LEVEL = "high";
const SESSION_A_THOUGHT_LEVEL = "max";

describe("会话区思考深度 session 隔离 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I55: 只修改 A 的思考深度后，B 的思考深度不应改变", async function () {
    this.timeout(260000);

    // 修复原因：V4 竖切已删除 legacy `chat-input` 和 ChatView 状态投影；继续调用
    // `prepareConversationE2E()` 会在业务步骤前超时，并在 teardown 阶段产生误导性的 CDP 报错。
    await prepareV4ConversationE2E();

    // 修复原因：provider 初始化只写入 high 偏好，不能保证 V4 草稿已经吸收该配置；
    // 直接首发可能继承上一轮的 max，导致用例在构造 I55 前置状态时误报。
    // 这里显式建立 catalog 已确认的 A/B=high 前置状态，待测动作仍只有后续 A→max。
    // Bug 根因：draft DOM 会先出现，pane 内 prewarm binding 仍可能在创建；此时立即切配置
    // 并点击发送，会撞上 binding 换代，UI 有乐观输入但 Agent 收不到 sendText。
    await waitForV4ComposerSelectionReady();
    await selectSharedModelAndThought(INITIAL_THOUGHT_LEVEL);
    const runId = Date.now();
    const promptASeed = buildPrompt(`E2E_THOUGHT_LEVEL_SESSION_ISOLATION_A_SEED_${runId}`);
    const sessionA = await sendPromptAndAssertThought(
      promptASeed,
      INITIAL_THOUGHT_LEVEL,
      A_SEED_REPLY,
      "A 首轮没有完成",
    );

    await startNewV4Draft();
    await waitForV4ComposerSelectionReady();
    await selectSharedModelAndThought(INITIAL_THOUGHT_LEVEL);
    const promptBSeed = buildPrompt(`E2E_THOUGHT_LEVEL_SESSION_ISOLATION_B_SEED_${runId}`);
    const sessionB = await sendPromptAndAssertThought(
      promptBSeed,
      INITIAL_THOUGHT_LEVEL,
      B_SEED_REPLY,
      "B 首轮没有完成",
    );
    expect(sessionB).not.toBe(sessionA);

    await selectV4TaskById(sessionA);
    await assertSelectedSharedModelAndThought(INITIAL_THOUGHT_LEVEL);
    // 空白 Composer 不持久化改选；隔离场景需保留非空草稿，才能验证 A 的选择恢复。
    const promptAFollow = buildPrompt(`E2E_THOUGHT_LEVEL_SESSION_ISOLATION_A_FOLLOW_${runId}`);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, promptAFollow);
    await selectSharedModelAndThought(SESSION_A_THOUGHT_LEVEL);

    await selectV4TaskById(sessionB);
    await assertSelectedSharedModelAndThought(INITIAL_THOUGHT_LEVEL);
    const promptBFollow = buildPrompt(`E2E_THOUGHT_LEVEL_SESSION_ISOLATION_B_FOLLOW_${runId}`);
    await sendPromptAndAssertThought(
      promptBFollow,
      INITIAL_THOUGHT_LEVEL,
      B_FOLLOW_REPLY,
      "B follow-up 没有完成",
    );

    await selectV4TaskById(sessionA);
    await assertSelectedSharedModelAndThought(SESSION_A_THOUGHT_LEVEL);
    expect(await getV4ComposerText()).toBe(promptAFollow);
    await sendPromptAndAssertThought(
      promptAFollow,
      SESSION_A_THOUGHT_LEVEL,
      A_FOLLOW_REPLY,
      "A follow-up 没有完成",
    );
  });
});

function buildPrompt(marker: string) {
  return `${marker}: Return the deterministic fixture reply for this marker.`;
}

async function selectSharedModelAndThought(thoughtLevel: string) {
  await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL, thoughtLevel);
  await assertSelectedSharedModelAndThought(thoughtLevel);
}

async function sendPromptAndAssertThought(
  prompt: string,
  thoughtLevel: string,
  expectedAssistantReply: string,
  timeoutMsg: string,
) {
  const marker = prompt.split(":")[0] ?? prompt;
  await sendV4Prompt(prompt);
  const record = await waitForUpstreamNetworkCapture(marker);
  assertUpstreamRequestCapture(record, {
    expectedText: prompt,
    model: UPSTREAM_MODEL,
  });
  assertUpstreamThoughtLevelCapture(record, thoughtLevel);
  return waitForCompletedSession(expectedAssistantReply, timeoutMsg);
}

async function assertSelectedSharedModelAndThought(thoughtLevel: string) {
  let latest = await getV4ModelConfig();
  await browser.waitUntil(
    async () => {
      latest = await getV4ModelConfig();
      return (
        latest.provider === UPSTREAM_PROVIDER_ID &&
        latest.model === UPSTREAM_MODEL &&
        latest.thought === thoughtLevel
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `v4 模型配置不是期望值: ${JSON.stringify({
        expected: {
          model: UPSTREAM_MODEL,
          provider: UPSTREAM_PROVIDER_ID,
          thought: thoughtLevel,
        },
        latest,
      })}`,
    },
  );
}

async function waitForCompletedSession(expectedAssistantReply: string, timeoutMsg: string) {
  const snapshot = await waitForV4Pane(
    (candidate) => isV4TurnCompleted(candidate, expectedAssistantReply),
    timeoutMsg,
    90000,
  );
  if (!snapshot.sessionId || snapshot.sessionId === "draft") {
    throw new Error(`${timeoutMsg}: sessionId missing`);
  }
  return snapshot.sessionId;
}
