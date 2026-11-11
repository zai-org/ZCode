import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_SECONDARY_THOUGHT_LEVEL,
  UPSTREAM_THOUGHT_LEVEL,
  ensureUpstreamModelForE2E,
  getUpstreamProviderModelValues,
  getUpstreamThoughtLevelLabels,
  getSelectedUpstreamModelLabel,
  getSelectedUpstreamThoughtLevelLabel,
  selectUpstreamModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

interface ExpectedConfig {
  model: string;
  thoughtLevel: string;
}

const PRIMARY_CONFIG: ExpectedConfig = {
  model: UPSTREAM_MODEL,
  thoughtLevel: UPSTREAM_THOUGHT_LEVEL,
};
const SECONDARY_CONFIG: ExpectedConfig = {
  model: UPSTREAM_SECONDARY_MODEL,
  thoughtLevel: UPSTREAM_SECONDARY_THOUGHT_LEVEL,
};

describe("会话区模型供应商 session 隔离 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I12: A/B session 应分别保留 provider/model/thought 配置", async function () {
    this.timeout(260000);

    await prepareV4ConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    await waitForEmptyDraft();

    await selectExpectedConfig(PRIMARY_CONFIG);
    const runId = Date.now();
    const promptA = buildPrompt(`E2E_MODEL_PROVIDER_SESSION_ISOLATION_A_${runId}`);
    await sendPromptAndAssertConfig(promptA, PRIMARY_CONFIG, "A 首轮");
    const sessionA = await waitForIdleSession("A 首轮没有完成");

    await startNewV4Draft();
    await waitForEmptyDraft();
    await selectExpectedConfig(SECONDARY_CONFIG);
    const promptB = buildPrompt(`E2E_MODEL_PROVIDER_SESSION_ISOLATION_B_${runId}`);
    await sendPromptAndAssertConfig(promptB, SECONDARY_CONFIG, "B 首轮");
    const sessionB = await waitForIdleSession("B 首轮没有完成");
    expect(sessionB).not.toBe(sessionA);

    await selectV4TaskById(sessionA);
    await waitForSessionVisible(sessionA, "切回 A 后没有恢复 A session");
    await assertSelectedExpectedConfig(PRIMARY_CONFIG);
    const promptAFollow = buildPrompt(`E2E_MODEL_PROVIDER_SESSION_ISOLATION_A_FOLLOW_${runId}`);
    await sendPromptAndAssertConfig(promptAFollow, PRIMARY_CONFIG, "A follow-up");
    await waitForIdleSession("A follow-up 没有完成");

    await selectV4TaskById(sessionB);
    await waitForSessionVisible(sessionB, "切回 B 后没有恢复 B session");
    await assertSelectedExpectedConfig(SECONDARY_CONFIG);
    const promptBFollow = buildPrompt(`E2E_MODEL_PROVIDER_SESSION_ISOLATION_B_FOLLOW_${runId}`);
    await sendPromptAndAssertConfig(promptBFollow, SECONDARY_CONFIG, "B follow-up");
    await waitForIdleSession("B follow-up 没有完成");
  });
});

function buildPrompt(marker: string) {
  return `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

async function selectExpectedConfig(config: ExpectedConfig) {
  await selectUpstreamModelById(config.model, {
    includePlainModelFallback: false,
    providerId: UPSTREAM_PROVIDER_ID,
  });
  await selectUpstreamThoughtLevelValue(config.thoughtLevel);
  await assertSelectedExpectedConfig(config);
}

async function sendPromptAndAssertConfig(prompt: string, config: ExpectedConfig, label: string) {
  const marker = prompt.split(":")[0] ?? prompt;
  await sendV4Prompt(prompt);
  await waitForV4ComposerText("", `${label} 发送后输入框没有清空`);
  await waitForV4UserMessageContaining(marker);
  const record = await waitForUpstreamNetworkCapture(marker);
  assertUpstreamRequestCapture(record, {
    expectedText: prompt,
    model: config.model,
  });
  if (config.thoughtLevel) {
    assertUpstreamThoughtLevelCapture(record, config.thoughtLevel);
  }
}

async function assertSelectedExpectedConfig(config: ExpectedConfig) {
  const modelLabel = await getSelectedUpstreamModelLabel();
  const acceptedModelValues = getUpstreamProviderModelValues(config.model, {
    includePlainModelFallback: false,
    providerId: UPSTREAM_PROVIDER_ID,
  });
  const modelSelected =
    acceptedModelValues.includes(modelLabel.currentValue) ||
    modelLabel.text.includes(config.model) ||
    modelLabel.title.includes(config.model);
  if (!modelSelected) {
    throw new Error(
      `当前模型不是期望配置: ${JSON.stringify({
        acceptedModelValues,
        expected: config,
        modelLabel,
      })}`,
    );
  }

  if (!config.thoughtLevel) {
    return;
  }
  const thoughtLabel = await getSelectedUpstreamThoughtLevelLabel();
  const acceptedThoughtValues = [
    config.thoughtLevel,
    ...getUpstreamThoughtLevelLabels(config.thoughtLevel),
  ].map((value) => value.toLowerCase());
  const currentThoughtCandidates = [
    thoughtLabel.currentValue,
    thoughtLabel.ariaLabel,
    thoughtLabel.text,
    thoughtLabel.title,
  ].map((value) => value.replace(/\s+/g, " ").trim().toLowerCase());
  if (!currentThoughtCandidates.some((candidate) => acceptedThoughtValues.includes(candidate))) {
    throw new Error(
      `当前思考深度不是期望配置: ${JSON.stringify({
        acceptedThoughtValues,
        expected: config,
        thoughtLabel,
      })}`,
    );
  }
}

async function waitForEmptyDraft() {
  await waitForV4ConversationState(
    (snapshot) =>
      snapshot.state === "idle" &&
      snapshot.sessionId === null &&
      snapshot.taskId === null &&
      snapshot.queueCount === 0 &&
      !snapshot.modelSwitchPending,
    "没有进入空草稿态",
    30000,
  );
}

async function waitForSessionVisible(sessionId: string, timeoutMsg: string) {
  await waitForV4ConversationState(
    (snapshot) => snapshot.sessionId === sessionId && snapshot.state === "idle",
    timeoutMsg,
    30000,
  );
}

async function waitForIdleSession(timeoutMsg: string) {
  const snapshot = await waitForV4ConversationState(
    (candidate) =>
      candidate.state === "idle" && candidate.queueCount === 0 && Boolean(candidate.sessionId),
    timeoutMsg,
    90000,
  );
  if (!snapshot.sessionId) {
    throw new Error(`${timeoutMsg}: sessionId missing`);
  }
  return snapshot.sessionId;
}
