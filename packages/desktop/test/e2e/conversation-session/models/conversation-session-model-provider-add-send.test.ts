import { readFile } from "node:fs/promises";
import {
  TID_CHAT_MODEL_SELECT_TRIGGER,
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
  getE2EAppDataPaths,
  readModelProviders,
  waitForWorkspaceApp,
  type E2EModelProviderSnapshot,
} from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import { resolveSeededReplayBaseUrl } from "#e2e/helpers/custom-openai-provider-store";
import { createAndConfigurePersonalProvider } from "#e2e/helpers/personal-provider-settings";
import {
  getUpstreamApiKey,
  getUpstreamProviderModelValues,
  getSelectedUpstreamModelLabel,
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import { sel } from "#e2e/helpers/selectors";
import { waitForProviderConfigPolling } from "#e2e/helpers/provider-config-polling";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

// Template 的模型成员 ID 与通用 replay Provider 不同，不能借用 UPSTREAM_MODEL。
const TEMPLATE_MODEL = "deepseek-flash";
const CATALOG_MAX_OUTPUT_TOKENS = 384_000;
const EDITED_MAX_OUTPUT_TOKENS = 64_000;
const EXPECTED_THOUGHT_LEVEL = "high";
const paths = getE2EAppDataPaths();

describe("会话区设置页新增模型供应商首发 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I08: 设置页从 Template 创建 Provider 后，聊天框应保留实例身份并首发", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);

    const runId = Date.now();
    const providerName = `Upstream E2E Added ${runId}`;
    const provider = await createCustomUpstreamProvider(providerName);

    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15000,
      timeoutMsg: "设置页返回按钮没有出现",
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);

    await selectUpstreamProviderModelById(TEMPLATE_MODEL, {
      includePlainModelFallback: false,
      providerId: provider.id,
      providerName,
    });
    await assertSelectedAddedProviderModel(provider);
    // Bug 原因：旧 case 直接断言 high，却没有执行对应用户操作，结果会随模型默认值变化。
    // 断言思考级别的 case 必须先显式选择目标档位，不能依赖产品默认配置。
    await selectUpstreamThoughtLevelValue(EXPECTED_THOUGHT_LEVEL);

    const marker = `E2E_MODEL_PROVIDER_ADD_SEND_${runId}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "新增 provider 首发后输入框没有清空");
    await waitForV4UserMessageContaining(marker);

    const captureRecord = await waitForUpstreamNetworkCapture(marker);
    assertUpstreamRequestCapture(captureRecord, {
      expectedText: prompt,
      model: TEMPLATE_MODEL,
    });
    assertUpstreamThoughtLevelCapture(captureRecord, EXPECTED_THOUGHT_LEVEL);
    expect(readRequestNumber(captureRecord.requestJson, "max_completion_tokens")).toBe(
      EDITED_MAX_OUTPUT_TOKENS,
    );

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "新增 provider 首轮完成后没有回到 idle",
      90000,
    );
  });
});

async function createCustomUpstreamProvider(providerName: string) {
  // 修复原因：WDIO coordinator 在启动 replay server 后写入的 env 不保证被全量并发
  // worker 稳定继承；共享 resolver 还会读取本轮 runtime 文件，避免单跑通过、全量失败。
  const baseURL = await resolveSeededReplayBaseUrl();
  if (!baseURL) {
    throw new Error("没有找到本轮 replay provider Base URL，无法通过设置页新增 provider");
  }

  await openModelProviderSettings();
  const firstProvider = await createAndConfigureTemplateProvider({
    baseURL,
    providerName: `${providerName} First`,
  });
  const provider = await createAndConfigureTemplateProvider({ baseURL, providerName });
  expect(provider.id).not.toBe(firstProvider.id);

  // Provider Template 已自带模型成员；只编辑目标实例的模型 Overlay，证明同一
  // Template 创建的两个 Personal Provider 保持独立身份和独立配置。
  await editModelMaxOutputTokens(CATALOG_MAX_OUTPUT_TOKENS, EDITED_MAX_OUTPUT_TOKENS);
  await restoreModelDefaults(EDITED_MAX_OUTPUT_TOKENS, CATALOG_MAX_OUTPUT_TOKENS);
  await editModelMaxOutputTokens(CATALOG_MAX_OUTPUT_TOKENS, EDITED_MAX_OUTPUT_TOKENS);
  expect(
    await hasPersonalMaxOutputOverride(firstProvider.id, TEMPLATE_MODEL, EDITED_MAX_OUTPUT_TOKENS),
  ).toBe(false);

  const savedProvider = await waitForCreatedProvider(
    providerName,
    baseURL,
    TEMPLATE_MODEL,
    EDITED_MAX_OUTPUT_TOKENS,
  );
  await waitForProviderConfigPolling();
  return savedProvider;
}

async function createAndConfigureTemplateProvider({
  baseURL,
  providerName,
}: {
  baseURL: string;
  providerName: string;
}) {
  await createAndConfigurePersonalProvider({
    apiFormat: "openai-chat-completions",
    apiKey: getUpstreamApiKey(),
    baseURL,
    providerName,
    templateId: "deepseek",
  });
  const provider = await waitForProviderByName(providerName, baseURL);
  // Bug 根因：Template 创建完成后，配置仓库的 polling 通知仍可能提交下一版 revision。
  // 连续创建或立即编辑模型时允许既有的 2 秒传播窗口，避免 E2E 把异步收尾误判为产品冲突。
  await waitForProviderConfigPolling();
  return provider;
}

async function waitForProviderByName(providerName: string, baseURL: string) {
  let provider: E2EModelProviderSnapshot | undefined;
  await browser.waitUntil(
    async () => {
      provider = (await readModelProviders()).find((candidate) => candidate.name === providerName);
      return Boolean(
        provider &&
        provider.apiKey.trim() === getUpstreamApiKey() &&
        provider.apiFormat === "openai-chat-completions" &&
        hasEndpoint(provider, baseURL),
      );
    },
    {
      timeout: 15_000,
      timeoutMsg: `Template Provider 没有保存到 Personal Config: ${providerName}`,
    },
  );
  if (!provider) throw new Error(`Template Provider 等待完成后仍不存在: ${providerName}`);
  return provider;
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

async function setMaxOutputTokensValue(value: number) {
  const inputIndex = await browser.execute(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    return Array.from(dialog?.querySelectorAll<HTMLInputElement>("input") ?? []).findIndex(
      (input) =>
        /^(最大输出 Token|Max output tokens)$/i.test(input.getAttribute("aria-label") ?? ""),
    );
  });
  if (inputIndex < 0) {
    throw new Error("模型 metadata 弹窗没有最大输出 Token 输入框");
  }
  const inputs = await $$('[role="dialog"] input');
  const input = inputs[inputIndex];
  if (!input || !(await input.isEnabled())) {
    throw new Error(`最大输出 Token 无法输入: ${input ? "disabled" : "missing-input"}`);
  }
  // 与模型 ID 一样使用真实键盘输入。直接改 DOM value 虽然视觉上会变化，但不会
  // 可靠更新 React draft，保存时会错误地继续继承 Catalog 默认值。
  await input.setValue(String(value));
  await browser.waitUntil(async () => (await input.getValue()) === String(value), {
    timeout: 5000,
    timeoutMsg: `最大输出 Token 没有更新为 ${value}`,
  });
}

async function clickModelMetadataSave() {
  const saveButtonIndex = await browser.execute(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    return Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).findIndex(
      (button) => {
        const text = button.innerText.replace(/\s+/g, " ").trim();
        return text === "保存" || text.startsWith("Save");
      },
    );
  });
  const buttons = await $$('[role="dialog"] button');
  const saveButton = buttons[saveButtonIndex];
  if (!saveButton || !(await saveButton.isEnabled())) {
    throw new Error("模型 metadata 弹窗没有可点击的保存按钮");
  }
  await saveButton.click();
  try {
    await browser.waitUntil(
      () => browser.execute(() => !document.querySelector<HTMLElement>('[role="dialog"]')),
      {
        timeout: 10000,
        timeoutMsg: "模型 metadata 弹窗保存后没有关闭",
      },
    );
  } catch (error) {
    const dialogText = await browser.execute(
      () => document.querySelector<HTMLElement>('[role="dialog"]')?.innerText ?? "",
    );
    throw new Error(`模型 metadata 弹窗保存失败: ${dialogText}`, { cause: error });
  }
}

async function readModelMetadataDialogSnapshot() {
  return browser.execute(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const inputs = Array.from(dialog?.querySelectorAll<HTMLInputElement>("input") ?? []);
    const maxOutputTokensInput = inputs.find((input) =>
      /^(最大输出 Token|Max output tokens)$/i.test(input.getAttribute("aria-label") ?? ""),
    );
    const contextWindowInput = inputs.find((input) => {
      const label = input.parentElement?.querySelector("label")?.textContent?.trim() ?? "";
      return /^(上下文窗口|Context window)$/i.test(label);
    });
    const saveButton = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (button) => {
        const text = button.innerText.replace(/\s+/g, " ").trim();
        return text === "保存" || text.startsWith("Save");
      },
    );
    return {
      contextWindowPlaceholder: contextWindowInput?.placeholder ?? null,
      contextWindowValue: contextWindowInput?.value ?? null,
      hasDialog: Boolean(dialog),
      // 成功横幅同样使用 role=status；这里只判断解析中的 aria-busy，不能把
      // “已为模型匹配到推荐配置”误判成持续 loading。
      loadingVisible: maxOutputTokensInput?.getAttribute("aria-busy") === "true",
      maxOutputTokensDisabled: maxOutputTokensInput?.disabled ?? null,
      maxOutputTokensPlaceholder: maxOutputTokensInput?.placeholder ?? null,
      maxOutputTokensValue: maxOutputTokensInput?.value ?? null,
      saveDisabled: saveButton?.disabled ?? null,
    };
  });
}

async function editModelMaxOutputTokens(currentValue: number, nextValue: number) {
  await openFirstModelMetadataDialog();

  const snapshot = await readModelMetadataDialogSnapshot();
  expect(snapshot.maxOutputTokensValue).toBe("");
  expect(snapshot.maxOutputTokensPlaceholder).toBe(String(currentValue));
  expect(snapshot.maxOutputTokensDisabled).toBe(false);
  expect(snapshot.loadingVisible).toBe(false);

  await setMaxOutputTokensValue(nextValue);
  await clickModelMetadataSave();
}

async function restoreModelDefaults(currentValue: number, inheritedValue: number) {
  await openFirstModelMetadataDialog();
  expect((await readModelMetadataDialogSnapshot()).maxOutputTokensValue).toBe(String(currentValue));
  // Todo 141 将恢复操作改名为重置表单；仍验证整份草稿恢复继承值并保存。
  const restored = await browser.execute(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const button = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (candidate) => /^(重置表单|Reset form)$/i.test(candidate.innerText.trim()),
    );
    if (!button || button.disabled) return false;
    button.click();
    return true;
  });
  if (!restored) throw new Error("Template 模型没有可用的重置表单按钮");
  await browser.waitUntil(
    async () => {
      const snapshot = await readModelMetadataDialogSnapshot();
      return (
        snapshot.maxOutputTokensValue === "" &&
        snapshot.maxOutputTokensPlaceholder === String(inheritedValue)
      );
    },
    {
      timeout: 10_000,
      timeoutMsg: "重置表单后没有回到 Provider Template 继承值",
    },
  );
  await clickModelMetadataSave();
}

async function openFirstModelMetadataDialog() {
  await browser.waitUntil(
    async () =>
      browser.execute(() =>
        Boolean(
          document.querySelector<HTMLButtonElement>(
            'button[aria-label="编辑模型配置"], button[aria-label="Edit model settings"]',
          ),
        ),
      ),
    {
      timeout: 15000,
      timeoutMsg: "新增 provider 保存后没有出现模型编辑按钮",
    },
  );
  await browser.execute(() => {
    document
      .querySelector<HTMLButtonElement>(
        'button[aria-label="编辑模型配置"], button[aria-label="Edit model settings"]',
      )
      ?.click();
  });
  await browser.waitUntil(
    () => browser.execute(() => Boolean(document.querySelector<HTMLElement>('[role="dialog"]'))),
    {
      timeout: 10000,
      timeoutMsg: "编辑模型 metadata 弹窗没有出现",
    },
  );
  const visibleInputModalities = await browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"] [data-model-input-modality]'),
    ).map((element) => element.dataset.modelInputModality),
  );
  expect(visibleInputModalities).toEqual(["text", "image", "video", "pdf"]);
}

async function waitForCreatedProvider(
  providerName: string,
  baseURL: string,
  modelId: string,
  maxOutputTokens: number,
) {
  let latestProviders: E2EModelProviderSnapshot[] = [];
  try {
    await browser.waitUntil(
      async () => {
        latestProviders = await readModelProviders();
        const provider = latestProviders.find((candidate) => candidate.name === providerName);
        return Boolean(
          provider &&
          provider.apiKey.trim() === getUpstreamApiKey() &&
          hasEndpoint(provider, baseURL) &&
          (await hasPersonalMaxOutputOverride(provider.id, modelId, maxOutputTokens)),
        );
      },
      {
        timeout: 10000,
        timeoutMsg: `新增 provider 没有保存到本地配置: ${providerName}`,
      },
    );
  } catch (error) {
    throw new Error(
      `新增 provider 落盘结果不符合预期: ${JSON.stringify(
        latestProviders.map((provider) => ({
          id: provider.id,
          name: provider.name,
          personalModelIds: provider.models.map((model) => model.id),
        })),
      )}`,
      { cause: error },
    );
  }

  const provider = latestProviders.find((candidate) => candidate.name === providerName);
  if (!provider) {
    throw new Error(`新增 provider 等待后仍不存在: ${providerName}`);
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

async function hasPersonalMaxOutputOverride(
  providerId: string,
  modelId: string,
  maxOutputTokens: number,
) {
  try {
    const parsed = JSON.parse(await readFile(paths.configFile, "utf-8")) as {
      config?: { modelConfigRules?: { providerModelRules?: unknown } };
    };
    // 当前配置文件将稀疏规则放在 config 内，根级旧结构会把已保存的 Overlay 读成缺失。
    const rules = parsed.config?.modelConfigRules?.providerModelRules;
    if (!Array.isArray(rules)) return false;
    return rules.some((rule) => {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
      const candidate = rule as Record<string, unknown>;
      const config = candidate.config;
      if (!config || typeof config !== "object" || Array.isArray(config)) return false;
      const optionSpecs = (config as Record<string, unknown>).optionSpecs;
      if (!optionSpecs || typeof optionSpecs !== "object" || Array.isArray(optionSpecs)) {
        return false;
      }
      const maxSpec = (optionSpecs as Record<string, unknown>).maxOutputTokens;
      return (
        // 序列化层由 providerModelRules 数组表达作用域，不再保存重复的 type 字段。
        candidate.providerId === providerId &&
        candidate.modelId === modelId &&
        Boolean(
          maxSpec &&
          typeof maxSpec === "object" &&
          !Array.isArray(maxSpec) &&
          (maxSpec as Record<string, unknown>).max === maxOutputTokens,
        )
      );
    });
  } catch {
    return false;
  }
}

function readRequestNumber(body: unknown, key: string): number | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

async function assertSelectedAddedProviderModel(provider: E2EModelProviderSnapshot) {
  const label = await getSelectedUpstreamModelLabel();
  const acceptedValues = getUpstreamProviderModelValues(TEMPLATE_MODEL, {
    includePlainModelFallback: false,
    providerId: provider.id,
  });
  if (!acceptedValues.includes(label.currentValue)) {
    throw new Error(
      `聊天工具栏当前模型没有保留新增 provider 身份: ${JSON.stringify({
        acceptedValues,
        label,
        providerId: provider.id,
      })}`,
    );
  }
  await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).waitForDisplayed({ timeout: 15000 });
}
