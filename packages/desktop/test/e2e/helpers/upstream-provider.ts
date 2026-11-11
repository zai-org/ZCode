/* eslint-disable max-lines -- Upstream E2E 初始化包含设置页、provider store、模型选择三段探针，集中维护方便失败诊断 */
import { selectCombinedComposerThoughtLevel } from "./composer-model-picker.js";
import { ZCODE_AGENT_PROVIDER, encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_CHAT_VIEW,
  TID_MODEL_PROVIDER_ADD_MODEL_BUTTON,
  TID_MODEL_PROVIDER_API_KEY_INPUT,
  TID_MODEL_PROVIDER_MODEL_INPUT,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_MODEL_CONFIG,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clickTestIdByDom,
  getE2EAppDataPaths,
  readModelProvider,
  readModelProviders,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
  waitForTestIdByDom,
  waitForWorkspaceApp,
  type E2EModelProviderSnapshot,
} from "./desktop-app.js";
import { sel } from "./selectors.js";
import { createAndConfigurePersonalProvider } from "./personal-provider-settings.js";
import { saveProviderModelMetadataDialog } from "./provider-model-metadata-dialog.js";
import { resolveUpstreamModels } from "./upstream-recorded-models.js";

export const UPSTREAM_PROVIDER_ID = process.env.E2E_PROVIDER_ID?.trim() || "e2e-upstream";
export const UPSTREAM_PROVIDER_NAV_KEY = `custom:${UPSTREAM_PROVIDER_ID}`;
export const UPSTREAM_ALTERNATE_PROVIDER_ID =
  process.env.E2E_PROVIDER_ALTERNATE_PROVIDER_ID?.trim() || "e2e-upstream-alt";
export const UPSTREAM_ALTERNATE_PROVIDER_NAME =
  process.env.E2E_PROVIDER_ALTERNATE_PROVIDER_NAME?.trim() || "Upstream E2E Alt";
// 模型名由 E2E_PROVIDER_MODEL / E2E_PROVIDER_SECONDARY_MODEL 控制，未设置时使用回放夹具的录制模型。
export const { model: UPSTREAM_MODEL, secondaryModel: UPSTREAM_SECONDARY_MODEL } =
  resolveUpstreamModels();
export const UPSTREAM_ALTERNATE_MODEL =
  process.env.E2E_PROVIDER_ALTERNATE_MODEL?.trim() || UPSTREAM_SECONDARY_MODEL;
export const UPSTREAM_PROVIDER_NAME = process.env.E2E_PROVIDER_NAME?.trim() || "Upstream";
export const UPSTREAM_THOUGHT_LEVEL = readUpstreamThoughtLevel();
export const UPSTREAM_SECONDARY_THOUGHT_LEVEL =
  process.env.E2E_PROVIDER_SECONDARY_THOUGHT_LEVEL?.trim() || "max";
const E2E_PROVIDER_REPLAY_API_KEY = "e2e-fixture-key";
const MODEL_SELECTION_RECENT_KEY_PREFIX = "zcode-model-selection-recent-v1";
const UPSTREAM_THOUGHT_LEVEL_MAX_ATTEMPTS = 8;
const UPSTREAM_THOUGHT_LEVEL_LABELS_BY_VALUE: Record<string, string[]> = {
  high: ["High", "高"],
  disabled: ["Disabled", "关闭"],
  enabled: ["Enabled", "开启"],
  max: ["Max", "最高"],
};
export const UPSTREAM_MODEL_VALUES = getUpstreamModelValues(UPSTREAM_MODEL);

function readUpstreamThoughtLevel() {
  if (process.env.E2E_PROVIDER_THOUGHT_LEVEL !== undefined) {
    return process.env.E2E_PROVIDER_THOUGHT_LEVEL.trim();
  }
  return process.env.E2E_PROVIDER_PRESET?.trim() === "glmhighspeed" ? "" : "high";
}

export function getUpstreamApiKey() {
  if (process.env.E2E_PROVIDER_CAPTURE_MODE !== "capture") {
    return E2E_PROVIDER_REPLAY_API_KEY;
  }

  const apiKey = process.env.E2E_PROVIDER_API_KEY?.trim();
  if (!apiKey || apiKey === "xxx") {
    // 修复原因：只有 capture 模式会访问真实 上游；采集 fixture 时不能用
    // placeholder，否则后续 replay 会固化一份失败响应。真实录制可切到 GLM highspeed
    // preset，但测试 helper 仍复用这组历史 env 名以保持旧 case 兼容。
    throw new Error("E2E_PROVIDER_HTTP_MODE=capture requires E2E_PROVIDER_API_KEY");
  }
  return apiKey;
}

interface EnsureUpstreamProviderOptions {
  /**
   * v4 竖切（M3）：旧 ChatInputToolbar 已删除，模型/思考深度选择 UI 尚未在 v4 pane 重建。
   * 此时依赖 seedUpstreamToolbarPreferences 的 localStorage 偏好 + CLI workspace catalog
   * 默认模型解析，跳过所有 toolbar 交互步骤。模型选择 UI 归 M4 后移除该开关。
   */
  skipToolbarSelection?: boolean;
}

export async function ensureUpstreamProviderForE2E(options: EnsureUpstreamProviderOptions = {}) {
  const upstreamApiKey = getUpstreamApiKey();

  await waitForDefaultWorkspaceReady(30000);
  await seedUpstreamToolbarPreferences();
  if (await hasSeededUpstreamProvider(upstreamApiKey)) {
    if (!options.skipToolbarSelection) {
      await selectUpstreamModel();
      await selectUpstreamThoughtLevel();
    }
    return;
  }

  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });

  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 15000,
    timeoutMsg: "设置页没有出现模型供应商分区入口",
  });

  if (!(await tryClickUpstreamProviderNavItem())) {
    const createdProvider = await createMissingUpstreamProvider();
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15000,
      timeoutMsg: "设置页返回按钮没有出现",
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await selectUpstreamProviderModelById(UPSTREAM_MODEL, {
      includePlainModelFallback: false,
      providerId: createdProvider.id,
      providerName: createdProvider.name,
    });
    await selectUpstreamThoughtLevel();
    return;
  }
  await waitForModelProviderNavSelected(UPSTREAM_PROVIDER_NAV_KEY);

  await setInputValueByTestIdDom(TID_MODEL_PROVIDER_API_KEY_INPUT, upstreamApiKey, {
    timeout: 15000,
    timeoutMsg: `${UPSTREAM_PROVIDER_NAME} provider API Key 输入框没有出现`,
  });
  await waitForUpstreamProviderSaved(
    (provider) => provider.apiKey.trim().length > 0,
    `${UPSTREAM_PROVIDER_NAME} API Key 没有保存到 e2e app data`,
  );

  const currentProvider = await readModelProvider(UPSTREAM_PROVIDER_ID);
  if (!currentProvider || !hasUpstreamModel(currentProvider, UPSTREAM_MODEL)) {
    await addUpstreamProviderModel(UPSTREAM_MODEL, currentProvider?.models.length ?? 0);
  }

  await waitForUpstreamProviderSaved(
    (provider) => hasUpstreamModel(provider, UPSTREAM_MODEL),
    `${UPSTREAM_PROVIDER_NAME} e2e 模型没有保存到 provider 配置`,
  );

  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "设置页返回按钮没有出现",
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);

  if (options.skipToolbarSelection) {
    return;
  }
  await selectUpstreamModel();
  if (UPSTREAM_THOUGHT_LEVEL) {
    await selectUpstreamThoughtLevel();
  }
}

async function hasSeededUpstreamProvider(apiKey: string) {
  const currentProvider = await readModelProvider(UPSTREAM_PROVIDER_ID);
  return Boolean(
    currentProvider &&
    currentProvider.enabled !== false &&
    currentProvider.apiKey.trim() === apiKey.trim() &&
    hasUpstreamModel(currentProvider, UPSTREAM_MODEL),
  );
}

async function tryClickUpstreamProviderNavItem() {
  const navTestId = testId(TID_MODEL_PROVIDER_NAV_ITEM, UPSTREAM_PROVIDER_NAV_KEY);
  return browser
    .waitUntil(
      async () => {
        const clicked = await browser.execute((currentTestId) => {
          const element = document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`);
          if (
            !element ||
            (element instanceof HTMLButtonElement &&
              (element.disabled || element.getAttribute("aria-disabled") === "true"))
          ) {
            return false;
          }
          element.click();
          return true;
        }, navTestId);
        if (clicked) {
          return true;
        }
        await browser.pause(150);
        return false;
      },
      {
        timeout: 5000,
        timeoutMsg: `设置页没有出现默认 ${UPSTREAM_PROVIDER_NAME} provider`,
      },
    )
    .then(() => true)
    .catch(() => false);
}

async function createMissingUpstreamProvider() {
  const baseURL = process.env.E2E_PROVIDER_RUNTIME_BASE_URL?.trim();
  if (!baseURL) {
    throw new Error("E2E_PROVIDER_RUNTIME_BASE_URL 未配置，无法通过设置页新增 replay provider");
  }

  await createAndConfigurePersonalProvider({
    apiKey: getUpstreamApiKey(),
    baseURL,
    providerName: UPSTREAM_PROVIDER_ID,
  });

  await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON, {
    timeout: 15000,
    timeoutMsg: "新增 provider 添加模型按钮没有出现",
  });
  await addUpstreamProviderModelThroughMetadataDialog(UPSTREAM_MODEL);
  await waitForMetadataDialogClosed("新增 provider 模型 metadata 弹窗保存后没有关闭");

  return waitForCreatedProvider(UPSTREAM_PROVIDER_ID, baseURL, UPSTREAM_MODEL);
}

async function seedUpstreamToolbarPreferences() {
  await browser.execute(
    (workspacePath, keyPrefix, providerId, modelId, thoughtLevel, appProvider) => {
      window.localStorage.setItem(
        `${keyPrefix}:${workspacePath}`,
        JSON.stringify({
          providerId,
          modelId,
          ...(thoughtLevel.trim() ? { options: { reasoningLevel: thoughtLevel.trim() } } : {}),
        }),
      );
      window.localStorage.setItem("zcode-last-agent-provider", appProvider);
    },
    DEFAULT_WORKSPACE,
    MODEL_SELECTION_RECENT_KEY_PREFIX,
    UPSTREAM_PROVIDER_ID,
    UPSTREAM_MODEL,
    UPSTREAM_THOUGHT_LEVEL,
    ZCODE_AGENT_PROVIDER,
  );
}

export async function ensureUpstreamModelForE2E(modelId: string) {
  const currentProvider = await readModelProvider(UPSTREAM_PROVIDER_ID);
  if (currentProvider && hasUpstreamModel(currentProvider, modelId)) {
    return;
  }

  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });

  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 15000,
    timeoutMsg: "设置页没有出现模型供应商分区入口",
  });
  await clickUpstreamProviderNavItem();
  await waitForModelProviderNavSelected(UPSTREAM_PROVIDER_NAV_KEY);

  const provider = await readModelProvider(UPSTREAM_PROVIDER_ID);
  await addUpstreamProviderModel(modelId, provider?.models.length ?? 0);

  await waitForUpstreamProviderSaved(
    (candidate) => hasUpstreamModel(candidate, modelId),
    `${UPSTREAM_PROVIDER_NAME} e2e 模型没有保存到 provider 配置: ${modelId}`,
  );

  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "设置页返回按钮没有出现",
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
}

function hasUpstreamModel(
  provider: NonNullable<Awaited<ReturnType<typeof readModelProvider>>>,
  modelId: string,
) {
  // 修复原因：v2 provider store 的 models 是 ModelProviderModelConfig 对象数组，
  // 旧 helper 只用 string includes，会把已经存在的模型误判为缺失。
  return provider.models.some((model) =>
    typeof model === "string" ? model === modelId : model.id === modelId,
  );
}

async function addUpstreamProviderModel(modelId: string, nextModelIndex: number) {
  await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON, {
    timeout: 15000,
    timeoutMsg: `${UPSTREAM_PROVIDER_NAME} provider 添加模型按钮没有出现`,
  });
  const modelInputTestId = testId(TID_MODEL_PROVIDER_MODEL_INPUT, String(nextModelIndex));
  const hasInlineInput = await waitForTestIdByDom(modelInputTestId, {
    timeout: 3000,
    timeoutMsg: `${UPSTREAM_PROVIDER_NAME} provider 新模型输入框没有出现`,
  })
    .then(() => true)
    .catch(() => false);

  if (hasInlineInput) {
    await setInputValueByTestIdDom(modelInputTestId, modelId, {
      timeout: 15000,
      timeoutMsg: `${UPSTREAM_PROVIDER_NAME} provider 新模型输入框没有出现`,
    });
    return;
  }

  // 修复原因：设置页新增模型已从内联空行改成 metadata 弹窗。
  // E2E helper 需要兼容新旧两种形态，否则只在新增第二模型/变体时失败。
  await addUpstreamProviderModelThroughMetadataDialog(modelId);
}

async function addUpstreamProviderModelThroughMetadataDialog(modelId: string) {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        return Boolean(dialog?.querySelector("input"));
      }),
    {
      timeout: 15000,
      timeoutMsg: `${UPSTREAM_PROVIDER_NAME} provider 新模型 metadata 弹窗没有出现`,
    },
  );

  const inputDiagnostics = await browser.execute(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) {
      return {
        inputCount: 0,
        reason: "dialog-missing",
        selectedInputIndex: -1,
      };
    }

    const inputs = Array.from(dialog.querySelectorAll<HTMLInputElement>("input"));
    const descriptors = inputs.map((input, index) => ({
      index,
      inputMode: input.getAttribute("inputmode") ?? "",
      label: input.parentElement?.querySelector("label")?.textContent?.trim() ?? "",
      placeholder: input.getAttribute("placeholder") ?? "",
      readOnly: input.readOnly,
      type: input.getAttribute("type") ?? "",
      value: input.value,
    }));
    const selectedInputIndex =
      descriptors.find((descriptor) =>
        [descriptor.label, descriptor.placeholder].some((text) =>
          /^(模型 ID|Model ID)$/i.test(text.trim()),
        ),
      )?.index ??
      descriptors.find((descriptor) => descriptor.inputMode !== "numeric" && !descriptor.readOnly)
        ?.index ??
      -1;
    return {
      descriptors,
      inputCount: inputs.length,
      reason: selectedInputIndex >= 0 ? "model-input-found" : "model-input-missing",
      selectedInputIndex,
    };
  });
  if (inputDiagnostics.selectedInputIndex < 0) {
    throw new Error(
      `${UPSTREAM_PROVIDER_NAME} provider 新模型 metadata 弹窗没有模型 ID 输入框: ${JSON.stringify(
        inputDiagnostics,
      )}`,
    );
  }

  const inputs = await $$('[role="dialog"] input');
  const modelInput = inputs[inputDiagnostics.selectedInputIndex];
  if (!modelInput) {
    throw new Error(
      `${UPSTREAM_PROVIDER_NAME} provider 新模型 metadata 弹窗输入框索引失效: ${JSON.stringify(
        inputDiagnostics,
      )}`,
    );
  }
  await modelInput.waitForDisplayed({ timeout: 5000 });
  await modelInput.setValue(modelId);
  await browser.waitUntil(async () => (await modelInput.getValue()) === modelId, {
    timeout: 5000,
    timeoutMsg: `${UPSTREAM_PROVIDER_NAME} provider 新模型 ID 没有写入输入框: ${modelId}`,
  });
  await saveProviderModelMetadataDialog(UPSTREAM_PROVIDER_NAME);
}

async function waitForMetadataDialogClosed(timeoutMsg: string) {
  await browser.waitUntil(
    () => browser.execute(() => !document.querySelector<HTMLElement>('[role="dialog"]')),
    {
      timeout: 10000,
      timeoutMsg,
    },
  );
}

async function waitForCreatedProvider(providerName: string, baseURL: string, modelId: string) {
  let latestProviders: E2EModelProviderSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      latestProviders = await readModelProviders();
      const provider = latestProviders.find((candidate) => candidate.name === providerName);
      return Boolean(
        provider &&
        provider.apiKey.trim() === getUpstreamApiKey() &&
        hasEndpoint(provider, baseURL) &&
        hasModel(provider, modelId),
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `新增 provider 没有保存到本地配置: ${providerName}`,
    },
  );

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

function hasModel(provider: E2EModelProviderSnapshot, modelId: string) {
  return provider.models.some((model) =>
    typeof model === "string" ? model === modelId : model.id === modelId,
  );
}

async function clickUpstreamProviderNavItem() {
  const navTestId = testId(TID_MODEL_PROVIDER_NAV_ITEM, UPSTREAM_PROVIDER_NAV_KEY);
  let latestReason = "not-started";
  try {
    await browser.waitUntil(
      async () => {
        const clicked = (await browser.execute((currentTestId) => {
          const element = document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`);
          if (!element) {
            return { clicked: false, reason: "missing" };
          }
          if (
            element instanceof HTMLButtonElement &&
            (element.disabled || element.getAttribute("aria-disabled") === "true")
          ) {
            return { clicked: false, reason: "disabled" };
          }
          element.click();
          return { clicked: true, reason: "clicked" };
        }, navTestId)) as { clicked: boolean; reason: string };
        latestReason = clicked.reason;
        if (clicked.clicked) {
          return true;
        }

        // 修复原因：设置页的 provider registry 来自 host 异步快照。
        // e2e 每个 session 都会重置 HOME，刚进设置页时左侧导航可能还在旧 section
        // 或 loading。周期性重新进入模型供应商页，避免把初始化窗口误报成业务失败。
        await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
          timeout: 2000,
          timeoutMsg: "设置页模型供应商分区入口不可点击",
        }).catch(() => undefined);
        await browser.pause(250);
        return false;
      },
      {
        timeout: 45000,
        timeoutMsg: `设置页没有出现默认 ${UPSTREAM_PROVIDER_NAME} provider`,
      },
    );
  } catch (error) {
    throw new Error(
      `设置页没有出现默认 ${UPSTREAM_PROVIDER_NAME} provider: ${latestReason}\n${JSON.stringify(
        await collectProviderNavDiagnostics(navTestId),
        null,
        2,
      )}`,
      { cause: error },
    );
  }
}

async function collectProviderNavDiagnostics(navTestId: string) {
  const providers = await readModelProviders();
  const appDataPaths = getE2EAppDataPaths();
  const dom = await browser.execute(
    (providerNavPrefix, expectedNavTestId, settingsPageTestId) => {
      const navItems = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${providerNavPrefix}-"]`),
      ).map((element) => ({
        ariaDisabled: element.getAttribute("aria-disabled"),
        ariaLabel: element.getAttribute("aria-label"),
        ariaSelected: element.getAttribute("aria-selected"),
        disabled: element instanceof HTMLButtonElement ? element.disabled : false,
        state: element.getAttribute("data-state"),
        testId: element.dataset.testid ?? "",
        text: element.innerText.trim(),
      }));
      return {
        bodyText: document.body?.innerText?.slice(0, 1600) ?? "",
        expectedExists: Boolean(document.querySelector(`[data-testid="${expectedNavTestId}"]`)),
        navItems,
        readyState: document.readyState,
        settingsVisible: Boolean(document.querySelector(`[data-testid="${settingsPageTestId}"]`)),
        testIds: Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
          .slice(0, 120)
          .map((element) => element.dataset.testid ?? ""),
        url: window.location.href,
      };
    },
    TID_MODEL_PROVIDER_NAV_ITEM,
    navTestId,
    TID_SETTINGS_PAGE,
  );

  return {
    appDataPaths,
    dom,
    providers: providers.map((provider) => ({
      apiKeyLength: provider.apiKey.trim().length,
      enabled: provider.enabled,
      id: provider.id,
      modelCount: provider.models.length,
      models: provider.models.map((model) => (typeof model === "string" ? model : model.id)),
      name: provider.name,
      source: provider.source,
    })),
  };
}

async function waitForModelProviderNavSelected(navKey: string) {
  const navTestId = testId(TID_MODEL_PROVIDER_NAV_ITEM, navKey);
  await browser.waitUntil(
    async () =>
      browser.execute((currentTestId) => {
        const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (item) => item.dataset.testid === currentTestId,
        );
        // 修复原因：模型供应商导航选中态是产品状态，不应依赖具体 CSS class。
        // UI 现在通过 aria-selected / data-state 暴露稳定协议，E2E 读取语义字段。
        return (
          element?.getAttribute("aria-selected") === "true" ||
          element?.getAttribute("data-state") === "selected"
        );
      }, navTestId),
    {
      timeout: 15000,
      timeoutMsg: `模型供应商导航没有选中 ${navKey}`,
    },
  );
}

export async function selectUpstreamModel() {
  await selectUpstreamModelById(UPSTREAM_MODEL);
}

export async function selectUpstreamModelById(
  modelId: string,
  options: SelectUpstreamProviderModelOptions = {},
) {
  await selectRegistryProviderModelById(modelId, {
    ...options,
    providerId: UPSTREAM_PROVIDER_ID,
    providerName: UPSTREAM_PROVIDER_NAME,
  });
}

interface SelectUpstreamProviderModelOptions {
  /** 团队行使用完整连接身份；普通 Provider 默认沿用 registry key。 */
  providerGroupKey?: string;
  afterModelItemClick?: () => Promise<boolean> | boolean;
  includePlainModelFallback?: boolean;
  providerId?: string;
  providerName?: string;
}

export async function selectRegistryProviderModelById(
  modelId: string,
  {
    afterModelItemClick,
    includePlainModelFallback = true,
    providerId = UPSTREAM_PROVIDER_ID,
    providerName = UPSTREAM_PROVIDER_NAME,
    providerGroupKey = `registry-provider:${providerId}`,
  }: SelectUpstreamProviderModelOptions = {},
) {
  const modelItemTestIds = getUpstreamProviderModelValues(modelId, {
    includePlainModelFallback,
    providerId,
  }).map((value) => testId(TID_CHAT_MODEL_SELECT_ITEM, value));
  const providerGroupTestIds = [testId(TID_CHAT_MODEL_SELECT_GROUP, providerGroupKey)];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
    await trigger.waitForClickable({ timeout: 30000 });
    if (
      !(await isUpstreamModelSelected(modelId, {
        includePlainModelFallback,
        providerId,
      }))
    ) {
      await trigger.click();
      try {
        await browser.waitUntil(
          async () =>
            // Bug 原因：catalog hydration 可能在菜单打开后把目标模型设为当前值，
            // 此时产品会卸载当前菜单项；已选中与菜单项出现都代表等待完成。
            (await isUpstreamModelSelected(modelId, {
              includePlainModelFallback,
              providerId,
            })) || openModelMenuUntilModelVisible(providerGroupTestIds, modelItemTestIds),
          {
            timeout: 45000,
            timeoutMsg: `聊天工具栏没有出现 ${providerName} e2e 模型选项`,
          },
        );
      } catch (error) {
        throw new Error(
          `聊天工具栏没有出现 ${providerName} e2e 模型选项: ${modelId}\n${JSON.stringify(
            await collectModelDropdownDiagnostics(modelItemTestIds, providerId),
            null,
            2,
          )}`,
          { cause: error },
        );
      }

      const clickedModelItem = await clickFirstExistingTestId(modelItemTestIds);
      if (!clickedModelItem) {
        if (
          await isUpstreamModelSelected(modelId, {
            includePlainModelFallback,
            providerId,
          })
        ) {
          await waitForModelSwitchIdle(`${providerName} 模型 ${modelId} 已选中但持久化没有完成`);
          if (
            await isUpstreamModelSelected(modelId, {
              includePlainModelFallback,
              providerId,
            })
          ) {
            return;
          }
        }
        // 修复原因：Radix Select 的下拉项在 portal 中会随 focus/scroll 重新挂载。
        // 等待阶段已经确认选项出现后，WebDriver 再次用 selector scroll/click 可能取到空元素。
        throw new Error(
          `${providerName} e2e 模型选项在等待后仍不存在: ${modelId}\n${JSON.stringify(
            await collectModelDropdownDiagnostics(modelItemTestIds, providerId),
            null,
            2,
          )}`,
        );
      }

      if (afterModelItemClick && (await afterModelItemClick())) {
        return;
      }

      await waitForUpstreamModelSelected(modelId, {
        includePlainModelFallback,
        providerId,
      });
      if (
        (await trigger.getAttribute("data-composer-combined-model")) === "true" &&
        (await trigger.getAttribute("aria-expanded")) === "true"
      )
        await browser.keys("Escape");
    }

    await waitForModelSwitchIdle(`${providerName} 模型 ${modelId} 切换持久化没有完成`);
    if (
      await isUpstreamModelSelected(modelId, {
        includePlainModelFallback,
        providerId,
      })
    ) {
      return;
    }
    await browser.pause(250);
  }

  throw new Error(
    `${providerName} 模型 ${modelId} 持久化后没有保持选中\n${JSON.stringify(
      await collectModelDropdownDiagnostics(modelItemTestIds, providerId),
      null,
      2,
    )}`,
  );
}

// 兼容现有 上游 场景的测试 helper 名称；跨 Provider 的新场景统一使用上面的
// Registry 命名，避免把通用模型选择能力误解成 上游 特化逻辑。
export const selectUpstreamProviderModelById = selectRegistryProviderModelById;

export async function waitForUpstreamModelSelected(
  modelId: string,
  options: {
    includePlainModelFallback?: boolean;
    providerId?: string;
  } = {},
) {
  await browser.waitUntil(async () => isUpstreamModelSelected(modelId, options), {
    timeout: 15000,
    timeoutMsg: `上游 模型没有切换到 ${modelId}`,
  });
}

async function isUpstreamModelSelected(
  modelId: string,
  {
    includePlainModelFallback = true,
    providerId = UPSTREAM_PROVIDER_ID,
  }: {
    includePlainModelFallback?: boolean;
    providerId?: string;
  } = {},
) {
  const expectedValues = getUpstreamProviderModelValues(modelId, {
    includePlainModelFallback,
    providerId,
  });
  return browser.execute(
    (triggerTestId, expectedModel, modelValues) => {
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
      const rawCurrentValue = trigger?.dataset.modelCurrentValue;
      const currentValue = rawCurrentValue?.trim() ?? "";
      if (currentValue && modelValues.includes(currentValue)) {
        return true;
      }
      // 修复原因：自定义模型已被选中时，Radix 二级菜单可能只展示 provider 分组，
      // 不再稳定挂载当前模型项。E2E 以工具栏当前选择作为最终语义，避免误判。
      // 只有组件根本没暴露 data-model-current-value 时才退回可见文本；属性存在但为空串是
      // 明确的「未选中 / 当前选择已失效」占位态（ModelConfigSelect 始终渲染该属性），此时
      // 触发器文本仍会显示失效的模型 id，按文本匹配会把「没选中」误判成「已选中」并跳过点击。
      return rawCurrentValue === undefined && (trigger?.innerText ?? "").includes(expectedModel);
    },
    TID_CHAT_MODEL_SELECT_TRIGGER,
    modelId,
    expectedValues,
  );
}

export function getSelectedUpstreamModelLabel() {
  return browser.execute((triggerTestId) => {
    const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
    return {
      ariaLabel: trigger?.getAttribute("aria-label") ?? "",
      currentValue: trigger?.dataset.modelCurrentValue ?? "",
      text: trigger?.innerText.trim() ?? "",
      title: trigger?.querySelector<HTMLElement>("[title]")?.getAttribute("title") ?? "",
    };
  }, TID_CHAT_MODEL_SELECT_TRIGGER);
}

export async function waitForModelSwitchIdle(timeoutMsg = "模型切换没有完成") {
  await browser.waitUntil(
    () =>
      browser.execute((chatViewTestId) => {
        const chatView = document.querySelector<HTMLElement>(`[data-testid="${chatViewTestId}"]`);
        return chatView?.dataset.modelSwitchPending !== "true";
      }, TID_CHAT_VIEW),
    {
      timeout: 30000,
      timeoutMsg,
    },
  );
}

export async function selectUpstreamThoughtLevel() {
  if (!UPSTREAM_THOUGHT_LEVEL) {
    return;
  }

  await selectUpstreamThoughtLevelValue(UPSTREAM_THOUGHT_LEVEL);
}

export async function selectUpstreamThoughtLevelValue(thoughtLevel: string) {
  if (!thoughtLevel) {
    return;
  }

  if (await selectCombinedComposerThoughtLevel(thoughtLevel)) {
    await waitForUpstreamThoughtLevelSelectedValue(thoughtLevel);
    return;
  }
  await waitForTestIdByDom(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER, {
    timeout: 45000,
    timeoutMsg: "聊天工具栏没有出现 上游 思考深度选择器",
  });
  if (await isUpstreamThoughtLevelSelected(thoughtLevel)) {
    await waitForModelSwitchIdle(`上游 思考深度 ${thoughtLevel} 已选中但持久化没有完成`);
    return;
  }

  const itemTestId = testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, thoughtLevel);

  for (let attempt = 0; attempt < UPSTREAM_THOUGHT_LEVEL_MAX_ATTEMPTS; attempt += 1) {
    await clickTestIdByDom(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER, {
      timeout: 15000,
      timeoutMsg: "聊天工具栏思考深度选择器不可点击",
    });
    await browser.pause(150);

    if (await hasUpstreamThoughtLevelItem(itemTestId)) {
      await clickTestIdByDom(itemTestId, {
        timeout: 15000,
        timeoutMsg: `聊天工具栏 ${thoughtLevel} 思考深度选项不可点击`,
      });
      await waitForUpstreamThoughtLevelSelected(
        thoughtLevel,
        `上游 思考深度没有切换到 ${thoughtLevel}`,
      );
      await waitForModelSwitchIdle(`上游 思考深度 ${thoughtLevel} 切换持久化没有完成`);
      return;
    }

    // 修复原因：小宽度/特定 toolbar 形态下思考深度是循环按钮，不会挂载
    // Radix SelectItem。此时一次 click 就是一次真实的用户切换动作。
    if (await isUpstreamThoughtLevelSelected(thoughtLevel)) {
      await waitForModelSwitchIdle(`上游 思考深度 ${thoughtLevel} 切换持久化没有完成`);
      return;
    }
  }

  throw new Error(
    `聊天工具栏无法切换到 ${thoughtLevel} 思考深度\n${JSON.stringify(
      await collectThoughtLevelDiagnostics(itemTestId),
      null,
      2,
    )}`,
  );
}

export async function waitForUpstreamThoughtLevelSelectedValue(thoughtLevel: string) {
  await waitForUpstreamThoughtLevelSelected(
    thoughtLevel,
    `上游 思考深度没有切换到 ${thoughtLevel}`,
  );
}

async function waitForUpstreamThoughtLevelSelected(thoughtLevel: string, timeoutMsg: string) {
  try {
    await browser.waitUntil(async () => isUpstreamThoughtLevelSelected(thoughtLevel), {
      timeout: 15000,
      timeoutMsg,
    });
  } catch (error) {
    throw new Error(
      `${timeoutMsg}\n${JSON.stringify(
        await collectThoughtLevelDiagnostics(
          testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, thoughtLevel),
        ),
        null,
        2,
      )}`,
      { cause: error },
    );
  }
}

async function isUpstreamThoughtLevelSelected(thoughtLevel: string) {
  return browser.execute(
    (triggerTestId, modelConfigTestId, expectedValue, expectedLabels, defaultWorkspace) => {
      const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
      const readCurrentThoughtLevel = () => {
        const e2eWindow = window as Window & {
          __zcodeSessionStoreE2E?: {
            getState: () => {
              getWorkspaceState?: (
                workspacePath: string,
                workspaceIdentity?: string,
              ) => {
                activeTaskId?: string | null;
                configOptions?: Array<{
                  category?: string;
                  currentValue?: unknown;
                  id?: string;
                  type?: string;
                }> | null;
                taskConfigOptionsByTaskId?: Record<
                  string,
                  Array<{
                    category?: string;
                    currentValue?: unknown;
                    id?: string;
                    type?: string;
                  }>
                >;
              };
            };
          };
        };
        const workspaceState = e2eWindow.__zcodeSessionStoreE2E
          ?.getState()
          .getWorkspaceState?.(defaultWorkspace);
        const readFromOptions = (
          options:
            | Array<{
                category?: string;
                currentValue?: unknown;
                id?: string;
                type?: string;
              }>
            | null
            | undefined,
        ) => {
          const option = (options ?? []).find(
            (candidate) =>
              (candidate.category ?? candidate.id) === "thought_level" &&
              candidate.type === "select",
          );
          return typeof option?.currentValue === "string" ? option.currentValue : "";
        };
        const activeTaskId = workspaceState?.activeTaskId ?? null;
        const taskValue =
          activeTaskId && workspaceState?.taskConfigOptionsByTaskId
            ? readFromOptions(workspaceState.taskConfigOptionsByTaskId[activeTaskId])
            : "";
        return taskValue || readFromOptions(workspaceState?.configOptions);
      };

      const v4CurrentValue = document
        .querySelector<HTMLElement>(`[data-testid="${modelConfigTestId}"]`)
        ?.dataset.thought?.trim();
      const currentValue = v4CurrentValue || readCurrentThoughtLevel();
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
      const expected = [expectedValue, ...expectedLabels].map(normalize);
      if (currentValue) {
        // 修复原因：Select 打开/动画期间 trigger 文本可能同时包含多个选项。
        // store 的 currentValue 才是首发请求会读取的真实思考深度。
        return expected.includes(normalize(currentValue));
      }

      const candidates = [
        trigger?.getAttribute("aria-label") ?? "",
        trigger?.innerText ?? "",
        trigger?.textContent ?? "",
      ].map(normalize);

      // 修复原因：产品语义是“当前思考深度已选中 high”，不是“某个下拉项存在”。
      // 这里读取 trigger 的可访问标签，兼容 select 与 cycle 两种 UI 形态。
      return candidates.some((value) => expected.includes(value));
    },
    TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
    TID_V4_MODEL_CONFIG,
    thoughtLevel,
    getUpstreamThoughtLevelLabels(thoughtLevel),
    DEFAULT_WORKSPACE,
  );
}

export function getSelectedUpstreamThoughtLevelLabel() {
  return browser.execute(
    (triggerTestId, modelConfigTestId, defaultWorkspace) => {
      const readCurrentValue = () => {
        const e2eWindow = window as Window & {
          __zcodeSessionStoreE2E?: {
            getState: () => {
              getWorkspaceState?: (
                workspacePath: string,
                workspaceIdentity?: string,
              ) => {
                activeTaskId?: string | null;
                configOptions?: Array<{
                  category?: string;
                  currentValue?: unknown;
                  id?: string;
                  type?: string;
                }> | null;
                taskConfigOptionsByTaskId?: Record<
                  string,
                  Array<{
                    category?: string;
                    currentValue?: unknown;
                    id?: string;
                    type?: string;
                  }>
                >;
              };
            };
          };
        };
        const workspaceState = e2eWindow.__zcodeSessionStoreE2E
          ?.getState()
          .getWorkspaceState?.(defaultWorkspace);
        const readFromOptions = (
          options:
            | Array<{
                category?: string;
                currentValue?: unknown;
                id?: string;
                type?: string;
              }>
            | null
            | undefined,
        ) => {
          const option = (options ?? []).find(
            (candidate) =>
              (candidate.category ?? candidate.id) === "thought_level" &&
              candidate.type === "select",
          );
          return typeof option?.currentValue === "string" ? option.currentValue : "";
        };
        const activeTaskId = workspaceState?.activeTaskId ?? null;
        const taskValue =
          activeTaskId && workspaceState?.taskConfigOptionsByTaskId
            ? readFromOptions(workspaceState.taskConfigOptionsByTaskId[activeTaskId])
            : "";
        return taskValue || readFromOptions(workspaceState?.configOptions);
      };

      const v4CurrentValue = document
        .querySelector<HTMLElement>(`[data-testid="${modelConfigTestId}"]`)
        ?.dataset.thought?.trim();
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
      return {
        ariaLabel: trigger?.getAttribute("aria-label") ?? "",
        // 修复原因：V4 投影已确认切换后，legacy store 可能仍保留上一档位；
        // 诊断 helper 必须与实际选择 helper 使用同一个权威事实源。
        currentValue: v4CurrentValue || readCurrentValue(),
        text: trigger?.innerText.trim() ?? "",
        title: trigger?.getAttribute("title") ?? "",
      };
    },
    TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
    TID_V4_MODEL_CONFIG,
    DEFAULT_WORKSPACE,
  );
}

function getUpstreamModelValues(modelId: string) {
  return getUpstreamProviderModelValues(modelId);
}

export function getUpstreamProviderModelValues(
  modelId: string,
  {
    includePlainModelFallback = true,
    providerId = UPSTREAM_PROVIDER_ID,
  }: {
    includePlainModelFallback?: boolean;
    providerId?: string;
  } = {},
) {
  const values = [`${providerId}/${modelId}`, encodeCustomModelValue(providerId, modelId)];
  if (includePlainModelFallback) {
    values.push(modelId);
  }
  return values;
}

export function getUpstreamThoughtLevelLabels(thoughtLevel: string) {
  return UPSTREAM_THOUGHT_LEVEL_LABELS_BY_VALUE[thoughtLevel] ?? [];
}

async function hasUpstreamThoughtLevelItem(itemTestId: string) {
  return browser.execute((currentTestId) => {
    return Boolean(document.querySelector(`[data-testid="${currentTestId}"]`));
  }, itemTestId);
}

async function waitForUpstreamProviderSaved(
  predicate: (provider: NonNullable<Awaited<ReturnType<typeof readModelProvider>>>) => boolean,
  timeoutMsg: string,
) {
  await browser.waitUntil(
    async () => {
      const provider = await readModelProvider(UPSTREAM_PROVIDER_ID);
      return Boolean(provider && predicate(provider));
    },
    {
      timeout: 15000,
      timeoutMsg,
    },
  );
}

/** 主模型菜单已打开时，展开真实 Provider 子菜单供候选与选择态断言。 */
export async function openComposerProviderList() {
  const trigger = $('[data-testid="composer-provider-trigger"]');
  await trigger.waitForClickable({ timeout: 15000 });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await $("[data-composer-provider-list]").waitForDisplayed({ timeout: 15000 });
}

async function openModelMenuUntilModelVisible(
  providerGroupTestIds: string[],
  modelItemTestIds: string[],
) {
  // 修复原因：模型菜单有两种形态：宽屏下可能按 provider 分组，窄屏/特定状态下会
  // 直接展开为模型项列表。用例的语义是“用户能选择目标模型”，不能强绑某一种菜单层级。
  if (await hasAnyExactTestId(modelItemTestIds)) {
    return true;
  }
  const combinedProvider = $('[data-testid="composer-provider-trigger"]');
  if (
    (await combinedProvider.isExisting()) &&
    (await combinedProvider.getAttribute("aria-expanded")) !== "true"
  ) {
    await combinedProvider.click();
  }
  for (const providerGroupTestId of providerGroupTestIds) {
    if (!(await hasExactTestId(providerGroupTestId))) {
      continue;
    }
    await openModelProviderGroup(providerGroupTestId);
    if (await hasAnyExactTestId(modelItemTestIds)) {
      return true;
    }
  }
  return false;
}

async function hasAnyExactTestId(testIds: string[]) {
  return browser.execute((currentTestIds) => {
    const existing = new Set(
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).map(
        (element) => element.dataset.testid ?? "",
      ),
    );
    return currentTestIds.some((currentTestId) => existing.has(currentTestId));
  }, testIds);
}

async function hasExactTestId(currentTestId: string) {
  return browser.execute((expectedTestId) => {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
      (element) => element.dataset.testid === expectedTestId,
    );
  }, currentTestId);
}

async function openModelProviderGroup(providerGroupTestId: string) {
  await waitForTestIdByDom(providerGroupTestId, {
    timeout: 15000,
    timeoutMsg: "聊天工具栏没有出现 上游 provider 分组",
  });
  // 修复原因：自定义 provider 模型在二级菜单里，不能只打开一级模型菜单后等待模型项。
  // 这里先触发 provider 子菜单，再用模型项 test id 判断是否可选。
  await browser.execute((currentTestId) => {
    const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === currentTestId,
    );
    if (!element) {
      return;
    }
    element.focus();
    for (const eventName of ["pointerenter", "mouseenter", "mousemove"] as const) {
      element.dispatchEvent(
        new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    }
    element.click();
  }, providerGroupTestId);
}

async function clickFirstExistingTestId(testIds: string[]) {
  return browser.execute((currentTestIds) => {
    for (const currentTestId of currentTestIds) {
      const element = document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`);
      if (element) {
        element.click();
        return {
          testId: currentTestId,
          text: element.innerText.trim(),
        };
      }
    }
    return null;
  }, testIds);
}

async function collectModelDropdownDiagnostics(
  attemptedTestIds: string[],
  providerId = UPSTREAM_PROVIDER_ID,
) {
  const provider = await readModelProvider(providerId);
  const dom = await browser.execute(
    (modelItemPrefix, triggerTestId, defaultWorkspace) => {
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
      const items = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${modelItemPrefix}"]`),
      ).map((element) => ({
        testId: element.dataset.testid ?? "",
        text: element.innerText.trim(),
        value: element.getAttribute("value"),
        selected: element.getAttribute("data-model-option-selected"),
        locked: element.getAttribute("data-model-option-locked"),
      }));
      const e2eWindow = window as Window & {
        __zcodeSessionStoreE2E?: {
          getState: () => {
            getWorkspaceState?: (
              workspacePath: string,
              workspaceIdentity?: string,
            ) => {
              activeTaskId?: string | null;
              configOptions?: Array<{
                category?: string;
                currentValue?: unknown;
                id?: string;
                options?: Array<{ value?: string; name?: string }>;
                type?: string;
              }> | null;
              configOptionsStatus?: string;
              draftSessionId?: string | null;
              isGhostSupplier?: boolean;
              modelSwitchPending?: boolean;
              modelSwitchRequestId?: string | null;
              modelSwitchStage?: string;
              selectedProvider?: string;
              selectedSupplierKey?: string;
              supplierMismatchReason?: string | null;
              taskConfigOptionsByTaskId?: Record<
                string,
                Array<{
                  category?: string;
                  currentValue?: unknown;
                  id?: string;
                  options?: Array<{ value?: string; name?: string }>;
                  type?: string;
                }>
              >;
            };
            workspaces?: Record<string, unknown>;
          };
        };
      };
      const storeState = e2eWindow.__zcodeSessionStoreE2E?.getState();
      const workspaceState = storeState?.getWorkspaceState?.(defaultWorkspace);
      const selectSummary = (
        options:
          | Array<{
              category?: string;
              currentValue?: unknown;
              id?: string;
              options?: Array<{ value?: string; name?: string }>;
              type?: string;
            }>
          | null
          | undefined,
      ) =>
        (options ?? [])
          .filter((option) =>
            ["model", "mode", "thought_level"].includes(option.category ?? option.id ?? ""),
          )
          .map((option) => ({
            category: option.category ?? null,
            currentValue:
              typeof option.currentValue === "string"
                ? option.currentValue
                : (option.currentValue ?? null),
            id: option.id ?? null,
            optionValues: (option.options ?? []).map((candidate) => candidate.value ?? ""),
            type: option.type ?? null,
          }));
      const activeTaskId = workspaceState?.activeTaskId ?? null;
      const taskConfigOptions =
        activeTaskId && workspaceState?.taskConfigOptionsByTaskId
          ? (workspaceState.taskConfigOptionsByTaskId[activeTaskId] ?? null)
          : null;

      return {
        bodyText: document.body?.innerText?.slice(0, 1200) ?? "",
        itemCount: items.length,
        items,
        store: workspaceState
          ? {
              activeTaskId,
              configOptions: selectSummary(workspaceState.configOptions),
              configOptionsStatus: workspaceState.configOptionsStatus ?? null,
              draftSessionId: workspaceState.draftSessionId ?? null,
              isGhostSupplier: workspaceState.isGhostSupplier ?? null,
              modelSwitchPending: workspaceState.modelSwitchPending ?? null,
              modelSwitchRequestId: workspaceState.modelSwitchRequestId ?? null,
              modelSwitchStage: workspaceState.modelSwitchStage ?? null,
              selectedProvider: workspaceState.selectedProvider ?? null,
              selectedSupplierKey: workspaceState.selectedSupplierKey ?? null,
              supplierMismatchReason: workspaceState.supplierMismatchReason ?? null,
              taskConfigOptions: selectSummary(taskConfigOptions),
              workspaceKeys: Object.keys(storeState?.workspaces ?? {}),
            }
          : {
              available: Boolean(storeState),
              reason: storeState ? "workspace-state-missing" : "store-bridge-missing",
              workspaceKeys: Object.keys(storeState?.workspaces ?? {}),
            },
        triggerText: trigger?.innerText.trim() ?? "",
        url: window.location.href,
      };
    },
    TID_CHAT_MODEL_SELECT_ITEM,
    TID_CHAT_MODEL_SELECT_TRIGGER,
    DEFAULT_WORKSPACE,
  );

  return {
    attemptedTestIds,
    dom,
    provider: provider
      ? {
          id: provider.id,
          name: provider.name,
          apiKeyLength: provider.apiKey.trim().length,
          enabled: provider.enabled,
          endpoints: provider.endpoints,
          models: provider.models,
          source: provider.source,
        }
      : null,
  };
}

async function collectThoughtLevelDiagnostics(attemptedTestId: string) {
  return browser.execute(
    (itemPrefix, triggerTestId, expectedItemTestId) => {
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
      const items = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${itemPrefix}"]`),
      ).map((element) => ({
        ariaDisabled: element.getAttribute("aria-disabled"),
        testId: element.dataset.testid ?? "",
        text: element.innerText.trim(),
        value: element.getAttribute("value"),
      }));

      return {
        attemptedTestId: expectedItemTestId,
        bodyText: document.body?.innerText?.slice(0, 1200) ?? "",
        itemCount: items.length,
        items,
        triggerAriaLabel: trigger?.getAttribute("aria-label") ?? "",
        triggerText: trigger?.innerText.trim() ?? "",
        url: window.location.href,
      };
    },
    TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
    TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
    attemptedTestId,
  );
}
