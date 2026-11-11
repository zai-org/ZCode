import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_SETTINGS_BACK_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
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
import type { E2ENetworkCaptureRecord } from "#e2e/helpers/network-capture-proxy";
import { sel } from "#e2e/helpers/selectors";
import {
  getSelectedUpstreamModelLabel,
  openComposerProviderList,
  getUpstreamProviderModelValues,
  selectUpstreamProviderModelById,
  UPSTREAM_MODEL,
  waitForUpstreamModelSelected,
} from "#e2e/helpers/upstream-provider";
import {
  E2E_REPLY_TOKEN,
  getV4ConversationState,
  getV4DraftThoughtState,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { createCustomOpenAIChatCompletionsProvider } from "#e2e/helpers/custom-openai-provider";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";

const CASE_NAME = "conversation-session-same-model-draft-provider-identity";
const GLM52_MODEL = "glm-5.2";
const UPSTREAM_FLASH_MODEL = UPSTREAM_MODEL;

const SCENARIOS = [
  {
    basePath: "glm52-provider-identity",
    label: "GLM-5.2",
    markerPrefix: "GLM52_PROVIDER_IDENTITY",
    modelId: GLM52_MODEL,
    providerNamePrefix: "GLM 5.2 Provider Identity E2E",
  },
  {
    basePath: "upstream-flash-provider-identity",
    label: "DeepSeek V4 Flash",
    markerPrefix: "UPSTREAM_FLASH_PROVIDER_IDENTITY",
    modelId: UPSTREAM_FLASH_MODEL,
    providerNamePrefix: "Upstream Flash Provider Identity E2E",
  },
] as const;

type ScenarioConfig = (typeof SCENARIOS)[number];

interface ScenarioProvider {
  baseURL: string;
  provider: E2EModelProviderSnapshot;
}

interface ScenarioProviders {
  alternate: ScenarioProvider;
  primary: ScenarioProvider;
}

let modelProviderReplayServer: Awaited<
  ReturnType<typeof startConversationModelProviderReplayServer>
> | null = null;

describe("会话区同名模型草稿默认 provider 身份 E2E", () => {
  before(async () => {
    modelProviderReplayServer = await startConversationModelProviderReplayServer(CASE_NAME);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await modelProviderReplayServer?.stop();
    modelProviderReplayServer = null;
  });

  it("I22: 有 active session 时，草稿切到另一 provider 下同名模型不应回弹旧 provider", async function () {
    this.timeout(360000);

    const runId = Date.now();
    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);

    const providers = new Map<ScenarioConfig["markerPrefix"], ScenarioProviders>();
    for (const scenario of SCENARIOS) {
      providers.set(scenario.markerPrefix, await createScenarioProviders(scenario, runId));
    }
    await waitForEmptyDraft();

    for (const scenario of SCENARIOS) {
      const scenarioProviders = providers.get(scenario.markerPrefix);
      if (!scenarioProviders) {
        throw new Error(`缺少 ${scenario.label} provider 场景配置`);
      }
      await runSameModelProviderIdentityScenario(scenario, scenarioProviders, runId);
    }
  });
});

async function createScenarioProviders(
  scenario: ScenarioConfig,
  runId: number,
): Promise<ScenarioProviders> {
  const primaryBaseURL = buildProviderBaseURL(scenario, "primary", runId);
  const primaryProvider = await createCustomOpenAIChatCompletionsProvider({
    baseURL: primaryBaseURL,
    modelId: scenario.modelId,
    providerName: `${scenario.providerNamePrefix} Primary ${runId}`,
  });
  await returnFromSettings();

  const alternateBaseURL = buildProviderBaseURL(scenario, "alternate", runId);
  const alternateProvider = await createCustomOpenAIChatCompletionsProvider({
    baseURL: alternateBaseURL,
    modelId: scenario.modelId,
    providerName: `${scenario.providerNamePrefix} Alternate ${runId}`,
  });
  await returnFromSettings();

  return {
    alternate: {
      baseURL: alternateBaseURL,
      provider: alternateProvider,
    },
    primary: {
      baseURL: primaryBaseURL,
      provider: primaryProvider,
    },
  };
}

async function runSameModelProviderIdentityScenario(
  scenario: ScenarioConfig,
  providers: ScenarioProviders,
  runId: number,
) {
  await startDraftFromProject(DEFAULT_WORKSPACE);
  await waitForEmptyDraft();

  await selectProviderModel(scenario, providers.primary.provider);
  await assertSelectedProviderModel(scenario, providers.primary.provider, "primary session seed");

  const primaryPrompt = buildPrompt(`E2E_${scenario.markerPrefix}_PRIMARY_${runId}`);
  await sendV4Prompt(primaryPrompt.text);
  await waitForV4ComposerText("", `${scenario.label} primary 发送后输入框没有清空`);
  await waitForV4UserMessageContaining(primaryPrompt.marker);

  const primaryRecord = await waitForUpstreamNetworkCapture(primaryPrompt.marker);
  assertUpstreamRequestCapture(primaryRecord, {
    expectedText: primaryPrompt.text,
    model: scenario.modelId,
  });
  assertProviderRequestUrl(primaryRecord, providers.primary.baseURL, `${scenario.label} primary`);
  await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
  const activeSessionId = await waitForIdleSession(`${scenario.label} primary 没有完成`);

  await startDraftFromProject(DEFAULT_WORKSPACE);
  await waitForEmptyDraft();

  await selectProviderModel(scenario, providers.alternate.provider);
  await assertSelectedProviderModel(
    scenario,
    providers.alternate.provider,
    "alternate draft default",
  );
  await assertModelMenuSelectedProvider(
    scenario,
    providers.alternate.provider,
    providers.primary.provider,
  );
  await assertDraftConfigModelValue(scenario, providers.alternate.provider, activeSessionId);

  const alternatePrompt = buildPrompt(`E2E_${scenario.markerPrefix}_ALTERNATE_${runId}`);
  await sendV4Prompt(alternatePrompt.text);
  await waitForV4ComposerText("", `${scenario.label} alternate 发送后输入框没有清空`);
  await waitForV4UserMessageContaining(alternatePrompt.marker);

  const alternateRecord = await waitForUpstreamNetworkCapture(alternatePrompt.marker);
  assertUpstreamRequestCapture(alternateRecord, {
    expectedText: alternatePrompt.text,
    model: scenario.modelId,
  });
  assertProviderRequestUrl(
    alternateRecord,
    providers.alternate.baseURL,
    `${scenario.label} alternate`,
  );
  await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
  await waitForIdleSession(`${scenario.label} alternate 没有完成`);
}

async function selectProviderModel(scenario: ScenarioConfig, provider: E2EModelProviderSnapshot) {
  await selectUpstreamProviderModelById(scenario.modelId, {
    includePlainModelFallback: false,
    providerId: provider.id,
    providerName: provider.name,
  });
  await waitForUpstreamModelSelected(scenario.modelId, {
    includePlainModelFallback: false,
    providerId: provider.id,
  });
}

function buildPrompt(marker: string) {
  return {
    marker,
    text: `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
  };
}

function buildProviderBaseURL(
  scenario: ScenarioConfig,
  role: "alternate" | "primary",
  runId: number,
) {
  const replayBaseURL = modelProviderReplayServer?.baseUrl.replace(/\/+$/, "");
  if (!replayBaseURL) {
    throw new Error("replay server 尚未初始化，无法构造 provider Base URL");
  }
  return `${replayBaseURL}/${scenario.basePath}-${role}-${runId}`;
}

async function returnFromSettings() {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "设置页返回按钮没有出现",
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
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

async function assertSelectedProviderModel(
  scenario: ScenarioConfig,
  provider: E2EModelProviderSnapshot,
  phase: string,
) {
  const label = await getSelectedUpstreamModelLabel();
  const acceptedValues = getUpstreamProviderModelValues(scenario.modelId, {
    includePlainModelFallback: false,
    providerId: provider.id,
  });
  if (!acceptedValues.includes(label.currentValue)) {
    throw new Error(
      `${phase} 没有保留 ${scenario.label} provider 身份: ${JSON.stringify({
        acceptedValues,
        label,
        providerId: provider.id,
      })}`,
    );
  }
}

async function assertModelMenuSelectedProvider(
  scenario: ScenarioConfig,
  provider: E2EModelProviderSnapshot,
  previousProvider: E2EModelProviderSnapshot,
) {
  const acceptedValues = getUpstreamProviderModelValues(scenario.modelId, {
    includePlainModelFallback: false,
    providerId: provider.id,
  });
  const modelItemTestIds = acceptedValues.map((value) => testId(TID_CHAT_MODEL_SELECT_ITEM, value));
  const providerGroupTestId = testId(
    TID_CHAT_MODEL_SELECT_GROUP,
    `registry-provider:${provider.id}`,
  );
  const previousProviderGroupTestId = testId(
    TID_CHAT_MODEL_SELECT_GROUP,
    `registry-provider:${previousProvider.id}`,
  );

  const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await trigger.waitForClickable({
    timeout: 15000,
    timeoutMsg: "聊天工具栏模型列表按钮没有出现",
  });
  await trigger.click();

  try {
    await openComposerProviderList();
    await browser.waitUntil(
      async () => {
        const rootSnapshot = await collectModelMenuSelectionSnapshot({
          modelItemTestIds,
          previousProviderGroupTestId,
          providerGroupTestId,
        });
        if (!rootSnapshot.providerGroupSelected || rootSnapshot.previousProviderGroupSelected) {
          return false;
        }
        return true;
      },
      {
        timeout: 30000,
        timeoutMsg: `模型列表没有把 alternate provider 下的 ${scenario.label} 标为选中`,
      },
    );
    // 桌面子菜单不会因只读检查获得键盘焦点；Escape 会关掉整层，直接读取仍挂载的模型项。
    expect(
      (
        await collectModelMenuSelectionSnapshot({
          modelItemTestIds,
          previousProviderGroupTestId,
          providerGroupTestId,
        })
      ).targetItemSelected,
    ).toBe(true);
  } catch (error) {
    throw new Error(
      `模型列表没有保留 alternate ${scenario.label} provider 身份: ${JSON.stringify(
        {
          acceptedValues,
          previousProviderId: previousProvider.id,
          providerId: provider.id,
          snapshot: await collectModelMenuSelectionSnapshot({
            modelItemTestIds,
            previousProviderGroupTestId,
            providerGroupTestId,
          }),
        },
        null,
        2,
      )}`,
      { cause: error },
    );
  } finally {
    await browser.keys("Escape").catch(() => undefined);
  }
}

async function collectModelMenuSelectionSnapshot({
  modelItemTestIds,
  previousProviderGroupTestId,
  providerGroupTestId,
}: {
  modelItemTestIds: string[];
  previousProviderGroupTestId: string;
  providerGroupTestId: string;
}) {
  return browser.execute(
    (modelItemPrefix, targetItems, targetGroup, previousGroup, triggerTestId) => {
      const allItems = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${modelItemPrefix}-"]`),
      ).map((element) => ({
        checked: element.getAttribute("data-checked"),
        selected: element.getAttribute("data-model-option-selected"),
        testId: element.dataset.testid ?? "",
        text: element.innerText.trim(),
      }));
      const providerGroup = document.querySelector<HTMLElement>(`[data-testid="${targetGroup}"]`);
      const previousProviderGroup = document.querySelector<HTMLElement>(
        `[data-testid="${previousGroup}"]`,
      );
      const targetItemsSet = new Set(targetItems);
      const targetItemsInDom = allItems.filter((item) => targetItemsSet.has(item.testId));
      return {
        allSelectedItems: allItems.filter(
          (item) => item.selected === "true" || item.checked === "true",
        ),
        bodyText: document.body?.innerText?.slice(0, 1800) ?? "",
        previousProviderGroupExists: Boolean(previousProviderGroup),
        previousProviderGroupSelected:
          previousProviderGroup?.getAttribute("aria-checked") === "true",
        providerGroupExists: Boolean(providerGroup),
        providerGroupSelected: providerGroup?.getAttribute("aria-checked") === "true",
        targetItemSelected: targetItemsInDom.some(
          (item) => item.selected === "true" || item.checked === "true",
        ),
        targetItemsInDom,
        testIds: Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
          .slice(0, 180)
          .map((element) => element.dataset.testid ?? ""),
        triggerCurrentValue:
          document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`)?.dataset
            .modelCurrentValue ?? "",
      };
    },
    TID_CHAT_MODEL_SELECT_ITEM,
    modelItemTestIds,
    providerGroupTestId,
    previousProviderGroupTestId,
    TID_CHAT_MODEL_SELECT_TRIGGER,
  );
}

async function assertDraftConfigModelValue(
  scenario: ScenarioConfig,
  provider: E2EModelProviderSnapshot,
  previousSessionId: string,
) {
  // 草稿选择属于当前 pane；Recent 只在真实提交被接纳后更新，不能断言它随菜单点击变化。
  const state = await getV4ConversationState();
  const draft = await getV4DraftThoughtState(DEFAULT_WORKSPACE);
  expect(state.taskId).toBeNull();
  expect(state.sessionId).not.toBe(previousSessionId);
  expect(state.modelSwitchPending).toBe(false);
  expect(draft.model).toBe(scenario.modelId);
  expect(await $('[data-testid="v4-model-config"]').getAttribute("data-provider")).toBe(
    provider.id,
  );
}

function assertProviderRequestUrl(
  record: E2ENetworkCaptureRecord,
  expectedBaseURL: string,
  phase: string,
) {
  const normalizedBaseURL = expectedBaseURL.trim().replace(/\/+$/, "");
  const expectedPrefix = `${normalizedBaseURL}/`;
  if (record.url !== normalizedBaseURL && !record.url.startsWith(expectedPrefix)) {
    throw new Error(
      `${phase} 请求没有命中目标 provider Base URL: ${JSON.stringify(
        {
          expectedBaseURL: normalizedBaseURL,
          method: record.method,
          path: record.path,
          url: record.url,
        },
        null,
        2,
      )}`,
    );
  }
}
