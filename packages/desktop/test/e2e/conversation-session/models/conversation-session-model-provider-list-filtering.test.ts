import { encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  UPSTREAM_ALTERNATE_PROVIDER_ID,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_PROVIDER_NAME,
  getUpstreamProviderModelValues,
  getSelectedUpstreamModelLabel,
  openComposerProviderList,
  selectUpstreamProviderModelById,
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
import { sel } from "#e2e/helpers/selectors";

const FILTERED_PROVIDER_CASES = [
  { id: "e2e-hidden-provider", model: "hidden-provider-model" },
  { id: "e2e-hidden-disabled", model: "hidden-disabled-model" },
  { id: "e2e-hidden-no-key", model: "hidden-no-key-model" },
  { id: "e2e-hidden-no-endpoint", model: "hidden-no-endpoint-model" },
] as const;
const VISIBLE_PROVIDER_WITH_HIDDEN_MODEL = "e2e-visible-provider-hidden-model";
const VISIBLE_COMPANION_MODEL = "visible-companion-model";
const HIDDEN_MODEL = "hidden-model";
const BUILTIN_CONFLICT_PROVIDER_ID = "e2e-zai-template-provider";
const BUILTIN_CONFLICT_PROVIDER_NAME = "Z.ai Template Provider E2E";
const BUILTIN_CONFLICT_MODEL_ID = "glm-5.3";

describe("会话区模型供应商列表过滤 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I09: 聊天模型列表应只展示可用 provider/model，并可用可见模型首发", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);

    await assertModelListFiltering();
    await selectUpstreamProviderModelById(BUILTIN_CONFLICT_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: BUILTIN_CONFLICT_PROVIDER_ID,
      providerName: BUILTIN_CONFLICT_PROVIDER_NAME,
    });
    await assertSelectedProviderModel(BUILTIN_CONFLICT_PROVIDER_ID, BUILTIN_CONFLICT_MODEL_ID);

    const runId = Date.now();
    const marker = `E2E_MODEL_PROVIDER_LIST_FILTER_${runId}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "模型列表过滤 case 首发后输入框没有清空");
    await waitForV4UserMessageContaining(marker);

    const captureRecord = await waitForUpstreamNetworkCapture(marker);
    assertUpstreamRequestCapture(captureRecord, {
      expectedText: prompt,
      model: BUILTIN_CONFLICT_MODEL_ID,
    });
    if (!captureRecord.url.includes("/builtin-personal-conflict")) {
      throw new Error(
        `Built-in/Personal 重名冲突后的请求没有命中 Built-in Provider 的 Effective Endpoint: ${captureRecord.url}`,
      );
    }

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "模型列表过滤 case 首轮完成后没有回到 idle",
      90000,
    );
  });
});

async function assertModelListFiltering() {
  const primaryGroupTestId = providerGroupTestId(UPSTREAM_PROVIDER_ID);
  const alternateGroupTestId = providerGroupTestId(UPSTREAM_ALTERNATE_PROVIDER_ID);
  const builtinConflictGroupTestId = providerGroupTestId(BUILTIN_CONFLICT_PROVIDER_ID);
  const builtinConflictModelItemTestIds = modelItemTestIds(
    BUILTIN_CONFLICT_PROVIDER_ID,
    BUILTIN_CONFLICT_MODEL_ID,
  );
  const visibleProviderGroupTestId = providerGroupTestId(VISIBLE_PROVIDER_WITH_HIDDEN_MODEL);
  const visibleCompanionModelItemTestIds = modelItemTestIds(
    VISIBLE_PROVIDER_WITH_HIDDEN_MODEL,
    VISIBLE_COMPANION_MODEL,
  );
  const hiddenModelItemTestIds = modelItemTestIds(VISIBLE_PROVIDER_WITH_HIDDEN_MODEL, HIDDEN_MODEL);
  const filteredGroupTestIds = FILTERED_PROVIDER_CASES.map((item) => providerGroupTestId(item.id));
  const filteredProviderModelItemTestIds = FILTERED_PROVIDER_CASES.map((item) =>
    testId(TID_CHAT_MODEL_SELECT_ITEM, encodeCustomModelValue(item.id, item.model)),
  );

  const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await trigger.waitForClickable({
    timeout: 30000,
    timeoutMsg: "聊天工具栏模型列表按钮没有出现",
  });
  await trigger.click();

  try {
    // 合并菜单先展开 Provider 子菜单，选择后再检查该 Provider 的模型列表。
    await openComposerProviderList();
    const snapshot = () =>
      collectModelListFilterSnapshot({
        builtinConflictGroupTestId,
        builtinConflictModelItemTestIds,
        filteredGroupTestIds,
        filteredProviderModelItemTestIds,
        hiddenModelItemTestIds,
        primaryGroupTestId,
        visibleCompanionModelItemTestIds,
        visibleProviderGroupTestId,
        alternateGroupTestId,
      });
    await browser.waitUntil(
      async () => {
        const current = await snapshot();
        return (
          current.primaryGroupExists &&
          current.alternateGroupExists &&
          current.visibleProviderGroupExists &&
          current.builtinConflictGroupExists
        );
      },
      {
        timeout: 45000,
        timeoutMsg: `${UPSTREAM_PROVIDER_NAME} 可用 provider/model 没有出现在模型列表`,
      },
    );
    const rootSnapshot = await snapshot();
    await $(sel(visibleProviderGroupTestId)).click();
    await browser.waitUntil(async () => (await snapshot()).visibleCompanionModelItemExists, {
      timeout: 15000,
      timeoutMsg: "可见 Provider 的 companion model 未出现",
    });
    const visibleModelSnapshot = await snapshot();
    await openComposerProviderList();
    await $(sel(builtinConflictGroupTestId)).click();
    await browser.waitUntil(async () => (await snapshot()).builtinConflictModelItemExists, {
      timeout: 15000,
      timeoutMsg: "同名内置 Provider 的模型未出现",
    });
    const leakedGroups = rootSnapshot.filteredGroups.filter((item) => item.exists);
    const leakedItems = [
      ...rootSnapshot.filteredProviderItems.filter((item) => item.exists),
      ...visibleModelSnapshot.hiddenModelItems.filter((item) => item.exists),
    ];
    if (leakedGroups.length > 0 || leakedItems.length > 0) {
      throw new Error(
        `模型列表展示了不可用 provider/model: ${JSON.stringify(
          { leakedGroups, leakedItems, rootSnapshot, visibleModelSnapshot },
          null,
          2,
        )}`,
      );
    }
  } finally {
    await browser.keys("Escape").catch(() => undefined);
  }
}

async function assertSelectedProviderModel(providerId: string, modelId: string) {
  const label = await getSelectedUpstreamModelLabel();
  const acceptedValues = getUpstreamProviderModelValues(modelId, {
    includePlainModelFallback: false,
    providerId,
  });
  if (!acceptedValues.includes(label.currentValue)) {
    throw new Error(
      `当前选中模型没有保留 Built-in Provider 身份: ${JSON.stringify({
        acceptedValues,
        label,
        modelId,
        providerId,
      })}`,
    );
  }
}

function modelItemTestIds(providerId: string, modelId: string) {
  return getUpstreamProviderModelValues(modelId, {
    includePlainModelFallback: false,
    providerId,
  }).map((value) => testId(TID_CHAT_MODEL_SELECT_ITEM, value));
}

function providerGroupTestId(providerId: string) {
  return testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${providerId}`);
}

async function collectModelListFilterSnapshot({
  alternateGroupTestId,
  builtinConflictGroupTestId,
  builtinConflictModelItemTestIds,
  filteredGroupTestIds,
  filteredProviderModelItemTestIds,
  hiddenModelItemTestIds,
  primaryGroupTestId,
  visibleCompanionModelItemTestIds,
  visibleProviderGroupTestId,
}: {
  alternateGroupTestId: string;
  builtinConflictGroupTestId: string;
  builtinConflictModelItemTestIds: string[];
  filteredGroupTestIds: string[];
  filteredProviderModelItemTestIds: string[];
  hiddenModelItemTestIds: string[];
  primaryGroupTestId: string;
  visibleCompanionModelItemTestIds: string[];
  visibleProviderGroupTestId: string;
}) {
  return browser.execute(
    (
      primaryGroup,
      alternateGroup,
      visibleProviderGroup,
      visibleCompanionItems,
      builtinConflictGroup,
      builtinConflictItems,
      filteredGroups,
      filteredProviderItems,
      hiddenModelItems,
      triggerTestId,
    ) => {
      const exists = (currentTestId: string) =>
        Boolean(document.querySelector(`[data-testid="${currentTestId}"]`));
      return {
        alternateGroupExists: exists(alternateGroup),
        builtinConflictGroupExists: exists(builtinConflictGroup),
        builtinConflictModelItemExists: builtinConflictItems.some(exists),
        bodyText: document.body?.innerText?.slice(0, 1800) ?? "",
        filteredGroups: filteredGroups.map((item) => ({ exists: exists(item), testId: item })),
        filteredProviderItems: filteredProviderItems.map((item) => ({
          exists: exists(item),
          testId: item,
        })),
        hiddenModelItems: hiddenModelItems.map((item) => ({
          exists: exists(item),
          testId: item,
        })),
        primaryGroupExists: exists(primaryGroup),
        visibleCompanionModelItemExists: visibleCompanionItems.some(exists),
        visibleProviderGroupExists: exists(visibleProviderGroup),
        testIds: Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
          .slice(0, 180)
          .map((element) => element.dataset.testid ?? ""),
        triggerText:
          document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`)?.innerText ?? "",
      };
    },
    primaryGroupTestId,
    alternateGroupTestId,
    visibleProviderGroupTestId,
    visibleCompanionModelItemTestIds,
    builtinConflictGroupTestId,
    builtinConflictModelItemTestIds,
    filteredGroupTestIds,
    filteredProviderModelItemTestIds,
    hiddenModelItemTestIds,
    TID_CHAT_MODEL_SELECT_TRIGGER,
  );
}
