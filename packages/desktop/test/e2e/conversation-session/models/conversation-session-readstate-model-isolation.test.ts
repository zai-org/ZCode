import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_SECONDARY_THOUGHT_LEVEL,
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
  getV4Messages,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4ComposerText,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_READSTATE_MODEL_ISOLATION";

describe("会话区 readState 不覆盖历史 session 模型 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I67: 新建草稿水合后切回非首个模型 session，续发请求仍使用该 session 模型", async function () {
    this.timeout(220000);

    await prepareV4ConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    await waitForEmptyDraft();

    await selectSecondaryConfig();

    const runId = Date.now();
    const firstPrompt = buildPrompt(`${CASE_MARKER}_FIRST_${runId}`);
    await sendPromptAndAssertSecondaryConfig(firstPrompt, "readState 隔离首轮");
    const sessionId = await waitForIdleSession("readState 隔离首轮没有完成");

    await startNewV4Draft();
    await waitForEmptyDraft();

    await selectV4TaskById(sessionId);
    await waitForSessionVisible(sessionId, "切回旧 session 后没有恢复 idle");
    await assertSelectedSecondaryConfig();

    const followPrompt = buildPrompt(`${CASE_MARKER}_FOLLOW_${runId}`);
    await sendPromptAndAssertSecondaryConfig(followPrompt, "readState 隔离 follow-up");
    await waitForIdleSession("readState 隔离 follow-up 没有完成");
  });
});

function buildPrompt(marker: string) {
  return `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

async function selectSecondaryConfig() {
  await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL, {
    includePlainModelFallback: false,
    providerId: UPSTREAM_PROVIDER_ID,
  });
  await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);
  await assertSelectedSecondaryConfig();
}

async function sendPromptAndAssertSecondaryConfig(prompt: string, label: string) {
  const marker = prompt.split(":")[0] ?? prompt;
  await sendV4Prompt(prompt);
  await waitForV4ComposerText("", `${label} 发送后输入框没有清空`);
  await waitForV4UserMessageContaining(marker);
  const record = await waitForUpstreamNetworkCapture(marker);
  assertUpstreamRequestCapture(record, {
    expectedText: prompt,
    model: UPSTREAM_SECONDARY_MODEL,
  });
  if (UPSTREAM_SECONDARY_THOUGHT_LEVEL) {
    assertUpstreamThoughtLevelCapture(record, UPSTREAM_SECONDARY_THOUGHT_LEVEL);
  }
}

async function assertSelectedSecondaryConfig() {
  const modelLabel = await getSelectedUpstreamModelLabel();
  const acceptedModelValues = getUpstreamProviderModelValues(UPSTREAM_SECONDARY_MODEL, {
    includePlainModelFallback: false,
    providerId: UPSTREAM_PROVIDER_ID,
  });
  const modelSelected =
    acceptedModelValues.includes(modelLabel.currentValue) ||
    modelLabel.text.includes(UPSTREAM_SECONDARY_MODEL) ||
    modelLabel.title.includes(UPSTREAM_SECONDARY_MODEL);
  if (!modelSelected) {
    throw new Error(
      `当前模型不是 readState 隔离 case 的 secondary 模型: ${JSON.stringify({
        acceptedModelValues,
        model: UPSTREAM_SECONDARY_MODEL,
        modelLabel,
      })}`,
    );
  }

  if (!UPSTREAM_SECONDARY_THOUGHT_LEVEL) {
    return;
  }
  const thoughtLabel = await getSelectedUpstreamThoughtLevelLabel();
  const acceptedThoughtValues = [
    UPSTREAM_SECONDARY_THOUGHT_LEVEL,
    ...getUpstreamThoughtLevelLabels(UPSTREAM_SECONDARY_THOUGHT_LEVEL),
  ].map((value) => value.toLowerCase());
  const currentThoughtCandidates = [
    thoughtLabel.currentValue,
    thoughtLabel.ariaLabel,
    thoughtLabel.text,
    thoughtLabel.title,
  ].map((value) => value.replace(/\s+/g, " ").trim().toLowerCase());
  if (!currentThoughtCandidates.some((candidate) => acceptedThoughtValues.includes(candidate))) {
    throw new Error(
      `当前思考深度不是 readState 隔离 case 的 secondary 配置: ${JSON.stringify({
        acceptedThoughtValues,
        thoughtLabel,
      })}`,
    );
  }
}

async function waitForEmptyDraft() {
  await waitForV4ConversationState(
    (snapshot) =>
      snapshot.state === "idle" &&
      (snapshot.sessionId === null || snapshot.sessionId === "draft") &&
      (snapshot.taskId === null || snapshot.taskId === "draft") &&
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
      candidate.state === "idle" &&
      candidate.queueCount === 0 &&
      Boolean(candidate.sessionId) &&
      candidate.sessionId !== "draft",
    timeoutMsg,
    90000,
  );
  if (!snapshot.sessionId || snapshot.sessionId === "draft") {
    throw new Error(`${timeoutMsg}: sessionId missing`);
  }
  return snapshot.sessionId;
}

async function waitForV4UserMessageContaining(marker: string) {
  await browser.waitUntil(
    async () => (await getV4Messages("user")).some((message) => message.text.includes(marker)),
    {
      timeout: 20000,
      timeoutMsg: `没有看到包含 ${marker} 的用户消息`,
    },
  );
}
