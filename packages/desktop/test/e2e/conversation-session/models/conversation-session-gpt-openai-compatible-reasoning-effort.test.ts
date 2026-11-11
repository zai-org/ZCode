import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_MODEL_PROVIDER_ADD_MODEL_BUTTON,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  readModelProviders,
  resolveE2EProviderRuntimeBaseUrl,
  waitForWorkspaceApp,
  type E2EModelProviderSnapshot,
} from "#e2e/helpers/desktop-app";
import {
  configureProviderModelReasoning,
  saveProviderModelMetadataDialog,
} from "#e2e/helpers/provider-model-metadata-dialog";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  getUpstreamApiKey,
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
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import { createAndConfigurePersonalProvider } from "#e2e/helpers/personal-provider-settings";
import { sel } from "#e2e/helpers/selectors";

const GPT_OPENAI_MODEL = "gpt-5";
const GPT_OPENAI_PROVIDER_NAME_PREFIX = "GPT OpenAI-compatible E2E";
const GPT_OPENAI_LOW_LEVEL = "low";
const GPT_OPENAI_XHIGH_LEVEL = "xhigh";
const E2E_PROVIDER_RUNTIME_FILE = resolve(
  process.env.ZCODE_E2E_NETWORK_CAPTURE_DIR?.trim() ||
    resolve(homedir(), "..", ".e2e-network-capture"),
  "upstream-runtime.json",
);
let modelProviderReplayServer: Awaited<
  ReturnType<typeof startConversationModelProviderReplayServer>
> | null = null;

describe("会话区 GPT OpenAI-compatible 思考档位请求字段 E2E", () => {
  before(async () => {
    modelProviderReplayServer = await startConversationModelProviderReplayServer(
      "conversation-session-gpt-openai-compatible-reasoning-effort",
    );
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await modelProviderReplayServer?.stop();
    modelProviderReplayServer = null;
  });

  it("I17: GPT OpenAI-compatible low/xhigh 应只生成 reasoning_effort 请求字段", async function () {
    this.timeout(240000);

    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);

    const runId = Date.now();
    const providerName = `${GPT_OPENAI_PROVIDER_NAME_PREFIX} ${runId}`;
    const provider = await createCustomGptOpenAiProvider(providerName);

    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15000,
      timeoutMsg: "设置页返回按钮没有出现",
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);

    await selectUpstreamProviderModelById(GPT_OPENAI_MODEL, {
      includePlainModelFallback: false,
      providerId: provider.id,
      providerName,
    });
    await assertSelectedGptOpenAiModel(provider);

    await selectUpstreamThoughtLevelValue(GPT_OPENAI_LOW_LEVEL);
    await assertSelectedThoughtLevel(GPT_OPENAI_LOW_LEVEL);

    const lowMarker = `E2E_GPT_OPENAI_REASONING_LOW_${runId}`;
    const lowPrompt = `${lowMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(lowPrompt);
    await waitForV4ComposerText("", "GPT OpenAI-compatible low 首发后输入框没有清空");
    await waitForV4UserMessageContaining(lowMarker);

    const lowRecord = await waitForUpstreamNetworkCapture(lowMarker);
    assertUpstreamRequestCapture(lowRecord, {
      expectedText: lowPrompt,
      model: GPT_OPENAI_MODEL,
    });
    assertGptOpenAiRequest(lowRecord, GPT_OPENAI_LOW_LEVEL);

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "GPT OpenAI-compatible low 首轮完成后没有回到 idle",
      90000,
    );

    await selectUpstreamThoughtLevelValue(GPT_OPENAI_XHIGH_LEVEL);
    await assertSelectedThoughtLevel(GPT_OPENAI_XHIGH_LEVEL);

    const xhighMarker = `E2E_GPT_OPENAI_REASONING_XHIGH_${runId}`;
    const xhighPrompt = `${xhighMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(xhighPrompt);
    await waitForV4ComposerText("", "GPT OpenAI-compatible xhigh 发送后输入框没有清空");
    await waitForV4UserMessageContaining(xhighMarker);

    const xhighRecord = await waitForUpstreamNetworkCapture(xhighMarker);
    assertUpstreamRequestCapture(xhighRecord, {
      expectedText: xhighPrompt,
      model: GPT_OPENAI_MODEL,
    });
    assertGptOpenAiRequest(xhighRecord, GPT_OPENAI_XHIGH_LEVEL);

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "GPT OpenAI-compatible xhigh 第二轮完成后没有回到 idle",
      90000,
    );
  });
});

async function createCustomGptOpenAiProvider(providerName: string) {
  const baseURL = await resolveSeededReplayBaseUrl();
  if (!baseURL) {
    throw new Error(
      "没有找到已 seed 的 replay provider Base URL，无法新增 GPT OpenAI-compatible provider",
    );
  }

  await openModelProviderSettings();
  await createAndConfigurePersonalProvider({
    apiFormat: "openai-chat-completions",
    apiKey: getUpstreamApiKey(),
    baseURL,
    providerName,
  });

  await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON, {
    timeout: 15000,
    timeoutMsg: "新增 GPT OpenAI-compatible provider 添加模型按钮没有出现",
  });
  await addModelThroughMetadataDialog(GPT_OPENAI_MODEL);

  return waitForCreatedGptOpenAiProvider(providerName, baseURL);
}

async function resolveSeededReplayBaseUrl() {
  const envBaseURL = process.env.E2E_PROVIDER_RUNTIME_BASE_URL?.trim();
  if (envBaseURL) {
    return envBaseURL;
  }

  const runtimeBaseURL = await readReplayRootBaseUrlFromRuntimeFile();
  if (runtimeBaseURL) {
    return runtimeBaseURL;
  }

  const providers = await readModelProviders();
  const replayProvider = providers.find(
    (provider) => provider.apiKey.trim() === getUpstreamApiKey(),
  );
  const providerBaseURL = replayProvider?.endpoints.baseURL?.trim();
  if (providerBaseURL) {
    return providerBaseURL;
  }

  return "";
}

async function readReplayRootBaseUrlFromRuntimeFile() {
  try {
    const json = JSON.parse(await readFile(E2E_PROVIDER_RUNTIME_FILE, "utf-8")) as {
      baseUrl?: string;
    };
    return normalizeReplayRootBaseUrl(json.baseUrl ?? "");
  } catch {
    return "";
  }
}

function normalizeReplayRootBaseUrl(baseURL: string) {
  const trimmed = baseURL.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("/anthropic") ? trimmed.slice(0, -"/anthropic".length) : trimmed;
}

async function openModelProviderSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 15000,
    timeoutMsg: "设置页没有出现模型供应商分区入口",
  });
}

async function addModelThroughMetadataDialog(modelId: string) {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        return Boolean(dialog?.querySelector("input"));
      }),
    {
      timeout: 15000,
      timeoutMsg: "新增 GPT OpenAI-compatible provider 模型 metadata 弹窗没有出现",
    },
  );

  const inputIndex = await browser.execute(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) {
      return -1;
    }
    const inputs = Array.from(dialog.querySelectorAll<HTMLInputElement>("input"));
    return inputs.findIndex((input) => {
      const label = input.parentElement?.querySelector("label")?.textContent?.trim() ?? "";
      const placeholder = input.getAttribute("placeholder") ?? "";
      return [label, placeholder].some((text) => /^(模型 ID|Model ID)$/i.test(text.trim()));
    });
  });
  if (inputIndex < 0) {
    throw new Error("新增 GPT OpenAI-compatible provider 模型 metadata 弹窗没有模型 ID 输入框");
  }

  const inputs = await $$('[role="dialog"] input');
  const modelInput = inputs[inputIndex];
  if (!modelInput) {
    throw new Error(
      `新增 GPT OpenAI-compatible provider 模型 metadata 输入框索引失效: ${inputIndex}`,
    );
  }
  await modelInput.waitForDisplayed({ timeout: 5000 });
  await modelInput.setValue(modelId);
  await browser.waitUntil(async () => (await modelInput.getValue()) === modelId, {
    timeout: 5000,
    timeoutMsg: `新增 GPT OpenAI-compatible provider 模型 ID 没有写入输入框: ${modelId}`,
  });

  await configureProviderModelReasoning(["low", "xhigh"], '{"reasoning_effort":reasoningLevel}');
  await saveProviderModelMetadataDialog("GPT OpenAI-compatible provider");
}

async function waitForCreatedGptOpenAiProvider(providerName: string, baseURL: string) {
  let latestProviders: E2EModelProviderSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      latestProviders = await readModelProviders();
      const provider = latestProviders.find((candidate) => candidate.name === providerName);
      return Boolean(
        provider &&
        provider.apiFormat === "openai-chat-completions" &&
        provider.defaultKind === "openai-compatible" &&
        provider.apiKey.trim() === getUpstreamApiKey() &&
        hasEndpoint(provider, baseURL) &&
        resolveE2EProviderRuntimeBaseUrl(provider) === baseURL &&
        hasModel(provider, GPT_OPENAI_MODEL),
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `新增 GPT OpenAI-compatible provider 没有保存到本地配置: ${providerName}`,
    },
  );

  const provider = latestProviders.find((candidate) => candidate.name === providerName);
  if (!provider) {
    throw new Error(`新增 GPT OpenAI-compatible provider 等待后仍不存在: ${providerName}`);
  }
  return provider;
}

function hasEndpoint(provider: E2EModelProviderSnapshot, baseURL: string) {
  return Object.values(provider.endpoints ?? {}).some((value) => {
    if (typeof value !== "string") {
      return false;
    }
    return value.trim() === baseURL;
  });
}

function hasModel(provider: E2EModelProviderSnapshot, modelId: string) {
  return provider.models.some((model) =>
    typeof model === "string" ? model === modelId : model.id === modelId,
  );
}

async function assertSelectedGptOpenAiModel(provider: E2EModelProviderSnapshot) {
  const label = await getSelectedUpstreamModelLabel();
  const acceptedValues = getUpstreamProviderModelValues(GPT_OPENAI_MODEL, {
    includePlainModelFallback: false,
    providerId: provider.id,
  });
  if (!acceptedValues.includes(label.currentValue)) {
    throw new Error(
      `聊天工具栏当前模型没有保留 GPT OpenAI-compatible provider 身份: ${JSON.stringify({
        acceptedValues,
        label,
        providerId: provider.id,
      })}`,
    );
  }
  await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).waitForDisplayed({ timeout: 15000 });
}

async function assertSelectedThoughtLevel(expectedLevel: string) {
  const thoughtLabel = await getSelectedUpstreamThoughtLevelLabel();
  const candidates = [
    thoughtLabel.currentValue,
    thoughtLabel.ariaLabel,
    thoughtLabel.text,
    thoughtLabel.title,
  ].map((value) => value.replace(/\s+/g, " ").trim().toLowerCase());
  if (!candidates.some((candidate) => candidate === expectedLevel)) {
    throw new Error(
      `GPT OpenAI-compatible 当前思考档位不是 ${expectedLevel}: ${JSON.stringify({
        candidates,
        thoughtLabel,
      })}`,
    );
  }
}

function assertGptOpenAiRequest(
  record: Awaited<ReturnType<typeof waitForUpstreamNetworkCapture>>,
  expectedLevel: string,
) {
  expect(record.path).toContain("/chat/completions");
  expect(readNestedString(record.requestJson, ["reasoning_effort"])).toBe(expectedLevel);
  expect(readNestedValue(record.requestJson, ["extra_body"])).toBeUndefined();
  expect(readNestedValue(record.requestJson, ["thinking"])).toBeUndefined();
  expect(readNestedValue(record.requestJson, ["output_config"])).toBeUndefined();
  expect(readNestedValue(record.requestJson, ["chat_template_kwargs"])).toBeUndefined();
}

function readNestedString(value: unknown, path: string[]) {
  const result = readNestedValue(value, path);
  return typeof result === "string" ? result : null;
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
