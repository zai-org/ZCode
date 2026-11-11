import { TID_CHAT_MODEL_SELECT_TRIGGER, TID_SETTINGS_BACK_BUTTON } from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  waitForWorkspaceApp,
  type E2EModelProviderSnapshot,
} from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  getUpstreamProviderModelValues,
  getSelectedUpstreamModelLabel,
  getSelectedUpstreamThoughtLevelLabel,
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
import { createCustomOpenAIChatCompletionsProvider } from "#e2e/helpers/custom-openai-provider";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import { sel } from "#e2e/helpers/selectors";

const QWEN_MODEL = "qwen3.5-plus";
const KIMI_MODEL = "kimi-k2.6";
const ENABLED_LEVEL = "enabled";
const OFF_LEVEL = "disabled";
let modelProviderReplayServer: Awaited<
  ReturnType<typeof startConversationModelProviderReplayServer>
> | null = null;

describe("会话区 OpenAI-compatible 思考开关请求字段 E2E", () => {
  before(async () => {
    modelProviderReplayServer = await startConversationModelProviderReplayServer(
      "conversation-session-openai-compatible-thinking-toggle-request-shape",
    );
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await modelProviderReplayServer?.stop();
    modelProviderReplayServer = null;
  });

  it("I65: Qwen/Kimi custom provider 应生成各自的 direct thinking toggle", async function () {
    this.timeout(360000);

    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);

    const runId = Date.now();
    const qwenProvider = await createProvider(QWEN_MODEL, `Qwen Toggle E2E ${runId}`);
    await selectProviderModel(qwenProvider, QWEN_MODEL);
    // 表单不保存 reasoning metadata；首发先验证 Agent resolver 的 enabled 默认请求，
    // 会话投影建立后再验证 UI 档位并切换 off。
    await sendToggleRequest({
      assertRequest: (requestJson) => assertQwenRequest(requestJson, true),
      level: ENABLED_LEVEL,
      marker: `E2E_QWEN_THINKING_ENABLED_${runId}`,
      modelId: QWEN_MODEL,
      selectLevel: false,
    });
    await assertSelectedThoughtLevel(ENABLED_LEVEL);
    await sendToggleRequest({
      assertRequest: (requestJson) => assertQwenRequest(requestJson, false),
      level: OFF_LEVEL,
      marker: `E2E_QWEN_THINKING_DISABLED_${runId}`,
      modelId: QWEN_MODEL,
    });

    const kimiProvider = await createProvider(KIMI_MODEL, `Kimi Toggle E2E ${runId}`);
    await selectProviderModel(kimiProvider, KIMI_MODEL);
    await sendToggleRequest({
      assertRequest: (requestJson) => assertKimiRequest(requestJson, "enabled"),
      level: ENABLED_LEVEL,
      marker: `E2E_KIMI_THINKING_ENABLED_${runId}`,
      modelId: KIMI_MODEL,
    });
    await sendToggleRequest({
      assertRequest: (requestJson) => assertKimiRequest(requestJson, "disabled"),
      level: OFF_LEVEL,
      marker: `E2E_KIMI_THINKING_DISABLED_${runId}`,
      modelId: KIMI_MODEL,
    });
  });
});

async function createProvider(modelId: string, providerName: string) {
  const provider = await createCustomOpenAIChatCompletionsProvider({ modelId, providerName });
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "设置页返回按钮没有出现",
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
  return provider;
}

async function selectProviderModel(provider: E2EModelProviderSnapshot, modelId: string) {
  await selectUpstreamProviderModelById(modelId, {
    includePlainModelFallback: false,
    providerId: provider.id,
    providerName: provider.name,
  });

  const label = await getSelectedUpstreamModelLabel();
  const acceptedValues = getUpstreamProviderModelValues(modelId, {
    includePlainModelFallback: false,
    providerId: provider.id,
  });
  if (!acceptedValues.includes(label.currentValue)) {
    throw new Error(
      `聊天工具栏没有保留目标 custom provider 身份: ${JSON.stringify({
        acceptedValues,
        label,
        modelId,
        providerId: provider.id,
      })}`,
    );
  }
  await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).waitForDisplayed({ timeout: 15000 });
}

async function sendToggleRequest(input: {
  assertRequest: (requestJson: unknown) => void;
  level: string;
  marker: string;
  modelId: string;
  selectLevel?: boolean;
}) {
  if (input.selectLevel !== false) {
    await selectUpstreamThoughtLevelValue(input.level);
    await assertSelectedThoughtLevel(input.level);
  }

  const prompt = `${input.marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  await sendV4Prompt(prompt);
  await waitForV4ComposerText("", `${input.marker} 发送后输入框没有清空`);
  await waitForV4UserMessageContaining(input.marker);

  const record = await waitForUpstreamNetworkCapture(input.marker);
  assertUpstreamRequestCapture(record, {
    expectedText: prompt,
    model: input.modelId,
  });
  input.assertRequest(record.requestJson);

  await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    `${input.marker} 完成后没有回到 idle`,
    90000,
  );
}

async function assertSelectedThoughtLevel(expectedLevel: string) {
  // 思考档位已合并到模型菜单；下面仍校验实际选择值。
  await browser.waitUntil(
    async () => {
      const thoughtLabel = await getSelectedUpstreamThoughtLevelLabel();
      return [
        thoughtLabel.currentValue,
        thoughtLabel.ariaLabel,
        thoughtLabel.text,
        thoughtLabel.title,
      ]
        .map((value) => value.replace(/\s+/g, " ").trim().toLowerCase())
        .some((candidate) => candidate === expectedLevel);
    },
    {
      timeout: 15000,
      timeoutMsg: `当前思考档位没有稳定为 ${expectedLevel}`,
    },
  );
}

function assertQwenRequest(requestJson: unknown, enabled: boolean) {
  expect(readNestedBoolean(requestJson, ["enable_thinking"])).toBe(enabled);
  assertNoWrappedOrSiblingReasoning(requestJson, "thinking");
}

function assertKimiRequest(requestJson: unknown, type: "disabled" | "enabled") {
  expect(readNestedString(requestJson, ["thinking", "type"])).toBe(type);
  assertNoWrappedOrSiblingReasoning(requestJson, "enable_thinking");
}

function assertNoWrappedOrSiblingReasoning(requestJson: unknown, absentDirectKey: string) {
  expect(readNestedValue(requestJson, [absentDirectKey])).toBeUndefined();
  expect(readNestedValue(requestJson, ["reasoning_effort"])).toBeUndefined();
  expect(readNestedValue(requestJson, ["extra_body"])).toBeUndefined();
  expect(readNestedValue(requestJson, ["chat_template_kwargs"])).toBeUndefined();
}

function readNestedString(value: unknown, path: string[]) {
  const result = readNestedValue(value, path);
  return typeof result === "string" ? result : null;
}

function readNestedBoolean(value: unknown, path: string[]) {
  const result = readNestedValue(value, path);
  return typeof result === "boolean" ? result : null;
}

function readNestedValue(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
