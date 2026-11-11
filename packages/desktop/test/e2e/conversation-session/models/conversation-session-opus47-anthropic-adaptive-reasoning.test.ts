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

const OPUS47_ANTHROPIC_MODEL = "claude-opus-4-7";
const OPUS47_ANTHROPIC_PROVIDER_NAME_PREFIX = "Opus 4.7 Anthropic E2E";
const OPUS47_ANTHROPIC_MEDIUM_LEVEL = "medium";
const OPUS47_ANTHROPIC_MAX_LEVEL = "max";
const E2E_PROVIDER_RUNTIME_FILE = resolve(
  process.env.ZCODE_E2E_NETWORK_CAPTURE_DIR?.trim() ||
    resolve(homedir(), "..", ".e2e-network-capture"),
  "upstream-runtime.json",
);
let modelProviderReplayServer: Awaited<
  ReturnType<typeof startConversationModelProviderReplayServer>
> | null = null;

describe("会话区 Opus 4.7 Anthropic 思考档位请求字段 E2E", () => {
  before(async () => {
    modelProviderReplayServer = await startConversationModelProviderReplayServer(
      "conversation-session-opus47-anthropic-adaptive-reasoning",
    );
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await modelProviderReplayServer?.stop();
    modelProviderReplayServer = null;
  });

  it("I18: Opus 4.7 Anthropic medium/max 应生成对应 Anthropic adaptive 请求字段", async function () {
    this.timeout(240000);

    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);

    const runId = Date.now();
    const providerName = `${OPUS47_ANTHROPIC_PROVIDER_NAME_PREFIX} ${runId}`;
    const provider = await createCustomOpus47AnthropicProvider(providerName);

    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15000,
      timeoutMsg: "设置页返回按钮没有出现",
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);

    await selectUpstreamProviderModelById(OPUS47_ANTHROPIC_MODEL, {
      includePlainModelFallback: false,
      providerId: provider.id,
      providerName,
    });
    await assertSelectedOpus47AnthropicModel(provider);

    await selectUpstreamThoughtLevelValue(OPUS47_ANTHROPIC_MEDIUM_LEVEL);
    await assertSelectedThoughtLevel(OPUS47_ANTHROPIC_MEDIUM_LEVEL);

    const mediumMarker = `E2E_OPUS47_ANTHROPIC_REASONING_MEDIUM_${runId}`;
    const mediumPrompt = `${mediumMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(mediumPrompt);
    await waitForV4ComposerText("", "Opus 4.7 Anthropic medium 首发后输入框没有清空");
    await waitForV4UserMessageContaining(mediumMarker);

    const mediumRecord = await waitForUpstreamNetworkCapture(mediumMarker);
    assertUpstreamRequestCapture(mediumRecord, {
      expectedText: mediumPrompt,
      model: OPUS47_ANTHROPIC_MODEL,
    });
    assertOpus47AnthropicRequest(mediumRecord, OPUS47_ANTHROPIC_MEDIUM_LEVEL);

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "Opus 4.7 Anthropic medium 首轮完成后没有回到 idle",
      90000,
    );

    await selectUpstreamThoughtLevelValue(OPUS47_ANTHROPIC_MAX_LEVEL);
    await assertSelectedThoughtLevel(OPUS47_ANTHROPIC_MAX_LEVEL);

    const maxMarker = `E2E_OPUS47_ANTHROPIC_REASONING_MAX_${runId}`;
    const maxPrompt = `${maxMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(maxPrompt);
    await waitForV4ComposerText("", "Opus 4.7 Anthropic max 发送后输入框没有清空");
    await waitForV4UserMessageContaining(maxMarker);

    const maxRecord = await waitForUpstreamNetworkCapture(maxMarker);
    assertUpstreamRequestCapture(maxRecord, {
      expectedText: maxPrompt,
      model: OPUS47_ANTHROPIC_MODEL,
    });
    assertOpus47AnthropicRequest(maxRecord, OPUS47_ANTHROPIC_MAX_LEVEL);

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "Opus 4.7 Anthropic max 第二轮完成后没有回到 idle",
      90000,
    );
  });
});

async function createCustomOpus47AnthropicProvider(providerName: string) {
  const baseURL = await resolveSeededReplayBaseUrl();
  if (!baseURL) {
    throw new Error(
      "没有找到已 seed 的 replay provider Base URL，无法新增 Opus 4.7 Anthropic provider",
    );
  }

  await openModelProviderSettings();
  await createAndConfigurePersonalProvider({
    apiFormat: "anthropic-messages",
    apiKey: getUpstreamApiKey(),
    baseURL,
    providerName,
  });

  await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON, {
    timeout: 15000,
    timeoutMsg: "新增 Opus 4.7 Anthropic provider 添加模型按钮没有出现",
  });
  await addModelThroughMetadataDialog(OPUS47_ANTHROPIC_MODEL);

  return waitForCreatedOpus47AnthropicProvider(providerName, baseURL);
}

async function resolveSeededReplayBaseUrl() {
  const envBaseURL = process.env.E2E_PROVIDER_RUNTIME_BASE_URL?.trim();
  if (envBaseURL) {
    return resolveAnthropicReplayBaseUrlFromString(envBaseURL);
  }

  const runtimeBaseURL = await readAnthropicReplayBaseUrlFromRuntimeFile();
  if (runtimeBaseURL) {
    return runtimeBaseURL;
  }

  const providers = await readModelProviders();
  const replayProvider = providers.find(
    (provider) => provider.apiKey.trim() === getUpstreamApiKey(),
  );
  const providerBaseURL = resolveAnthropicReplayBaseUrl(replayProvider);
  if (providerBaseURL) {
    return providerBaseURL;
  }

  return "";
}

function resolveAnthropicReplayBaseUrl(provider: E2EModelProviderSnapshot | undefined) {
  const endpoint = provider?.endpoints;
  const anthropic = endpoint?.anthropic?.trim();
  if (anthropic) {
    return anthropic;
  }
  return resolveAnthropicReplayBaseUrlFromString(endpoint?.baseURL?.trim() ?? "");
}

function resolveAnthropicReplayBaseUrlFromString(baseURL: string) {
  if (!baseURL) {
    return "";
  }
  return baseURL.endsWith("/anthropic") ? baseURL : `${baseURL.replace(/\/+$/, "")}/anthropic`;
}

async function readAnthropicReplayBaseUrlFromRuntimeFile() {
  try {
    const json = JSON.parse(await readFile(E2E_PROVIDER_RUNTIME_FILE, "utf-8")) as {
      baseUrl?: string;
    };
    return resolveAnthropicReplayBaseUrlFromString(json.baseUrl ?? "");
  } catch {
    return "";
  }
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
      timeoutMsg: "新增 Opus 4.7 Anthropic provider 模型 metadata 弹窗没有出现",
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
    throw new Error("新增 Opus 4.7 Anthropic provider 模型 metadata 弹窗没有模型 ID 输入框");
  }

  const inputs = await $$('[role="dialog"] input');
  const modelInput = inputs[inputIndex];
  if (!modelInput) {
    throw new Error(`新增 Opus 4.7 Anthropic provider 模型 metadata 输入框索引失效: ${inputIndex}`);
  }
  await modelInput.waitForDisplayed({ timeout: 5000 });
  await modelInput.setValue(modelId);
  await browser.waitUntil(async () => (await modelInput.getValue()) === modelId, {
    timeout: 5000,
    timeoutMsg: `新增 Opus 4.7 Anthropic provider 模型 ID 没有写入输入框: ${modelId}`,
  });

  await configureProviderModelReasoning(
    ["medium", "max"],
    '{"thinking":{"type":"adaptive"},"output_config":{"effort":reasoningLevel}}',
  );
  await saveProviderModelMetadataDialog("Opus 4.7 Anthropic provider");
}

async function waitForCreatedOpus47AnthropicProvider(providerName: string, baseURL: string) {
  let latestProviders: E2EModelProviderSnapshot[] = [];
  try {
    await browser.waitUntil(
      async () => {
        latestProviders = await readModelProviders();
        const provider = latestProviders.find((candidate) => candidate.name === providerName);
        return Boolean(
          provider &&
          provider.apiFormat === "anthropic-messages" &&
          provider.defaultKind === "anthropic" &&
          provider.apiKey.trim() === getUpstreamApiKey() &&
          hasEndpoint(provider, baseURL) &&
          resolveE2EProviderRuntimeBaseUrl(provider) === baseURL &&
          hasModel(provider, OPUS47_ANTHROPIC_MODEL),
        );
      },
      {
        timeout: 30000,
        timeoutMsg: `新增 Opus 4.7 Anthropic provider 没有保存到本地配置: ${providerName}`,
      },
    );
  } catch (error) {
    // 诊断原因：保存 RPC 已成功但复合断言没有收敛；必须带回实际 provider 形态，
    // 才能区分持久化失败和 metadata/defaultKind 断言漂移。
    throw new Error(
      `新增 Opus 4.7 Anthropic provider 配置未收敛: ${JSON.stringify({
        baseURL,
        latestProviders,
        providerName,
      })}`,
      { cause: error },
    );
  }

  const provider = latestProviders.find((candidate) => candidate.name === providerName);
  if (!provider) {
    throw new Error(`新增 Opus 4.7 Anthropic provider 等待后仍不存在: ${providerName}`);
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

async function assertSelectedOpus47AnthropicModel(provider: E2EModelProviderSnapshot) {
  const label = await getSelectedUpstreamModelLabel();
  const acceptedValues = getUpstreamProviderModelValues(OPUS47_ANTHROPIC_MODEL, {
    includePlainModelFallback: false,
    providerId: provider.id,
  });
  if (!acceptedValues.includes(label.currentValue)) {
    throw new Error(
      `聊天工具栏当前模型没有保留 Opus 4.7 Anthropic provider 身份: ${JSON.stringify({
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
      `Opus 4.7 Anthropic 当前思考档位不是 ${expectedLevel}: ${JSON.stringify({
        candidates,
        thoughtLabel,
      })}`,
    );
  }
}

function assertOpus47AnthropicRequest(
  record: Awaited<ReturnType<typeof waitForUpstreamNetworkCapture>>,
  expectedLevel: string,
) {
  expect(record.path).toContain("/messages");
  expect(readNestedString(record.requestJson, ["thinking", "type"])).toBe("adaptive");
  expect(readNestedNumber(record.requestJson, ["thinking", "budget_tokens"])).toBe(null);
  expect(readNestedString(record.requestJson, ["output_config", "effort"])).toBe(expectedLevel);
  expect(readNestedString(record.requestJson, ["reasoning_effort"])).toBe(null);
  expect(readNestedString(record.requestJson, ["extra_body", "thinking", "type"])).toBe(null);
  expect(
    readNestedString(record.requestJson, [
      "extra_body",
      "chat_template_kwargs",
      "reasoning_effort",
    ]),
  ).toBe(null);
  expect(
    readNestedBoolean(record.requestJson, [
      "extra_body",
      "chat_template_kwargs",
      "enable_thinking",
    ]),
  ).toBe(null);
}

function readNestedString(value: unknown, path: string[]) {
  const result = readNestedValue(value, path);
  return typeof result === "string" ? result : null;
}

function readNestedBoolean(value: unknown, path: string[]) {
  const result = readNestedValue(value, path);
  return typeof result === "boolean" ? result : null;
}

function readNestedNumber(value: unknown, path: string[]) {
  const result = readNestedValue(value, path);
  return typeof result === "number" ? result : null;
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
