import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  getActiveWorkspacePath,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_PROVIDER_NAME,
  UPSTREAM_THOUGHT_LEVEL,
  getUpstreamProviderModelValues,
  getSelectedUpstreamModelLabel,
  selectUpstreamModelById,
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

describe("会话区 上游 工作区首发冒烟 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I07: 启动打开工作区后，上游 模型列表、首发请求和回复应正确", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E();
    await assertDefaultWorkspaceOpened();
    await assertUpstreamModelListShowsTargetModel();
    await selectUpstreamModelById(UPSTREAM_MODEL);
    await assertSelectedUpstreamModel();

    const runId = Date.now();
    const marker = `E2E_UPSTREAM_WORKSPACE_SMOKE_${runId}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "Upstream workspace smoke 首发后输入框没有清空");
    await waitForV4UserMessageContaining(marker);

    const captureRecord = await waitForUpstreamNetworkCapture(marker);
    assertUpstreamRequestCapture(captureRecord, {
      expectedText: prompt,
      model: UPSTREAM_MODEL,
    });
    if (UPSTREAM_THOUGHT_LEVEL) {
      assertUpstreamThoughtLevelCapture(captureRecord, UPSTREAM_THOUGHT_LEVEL);
    }

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "Upstream workspace smoke 首轮完成后没有回到 idle",
      90000,
    );
  });
});

async function assertDefaultWorkspaceOpened() {
  // 修复原因：waitForWorkspaceApp 已同时兼容路径徽标和侧栏 workspace item。
  // 再额外强制侧栏 item 存在会在恢复/折叠慢帧里误报默认工作区未打开。
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);
  const activeWorkspacePath = await getActiveWorkspacePath();
  if (activeWorkspacePath !== null) {
    expect(activeWorkspacePath).toBe(DEFAULT_WORKSPACE);
  }
}

async function assertUpstreamModelListShowsTargetModel() {
  const modelItemTestIds = getUpstreamProviderModelValues(UPSTREAM_MODEL).map((value) =>
    testId(TID_CHAT_MODEL_SELECT_ITEM, value),
  );
  const providerGroupTestId = testId(
    TID_CHAT_MODEL_SELECT_GROUP,
    `registry-provider:${UPSTREAM_PROVIDER_ID}`,
  );

  const trigger = $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
  await trigger.waitForClickable({
    timeout: 30000,
    timeoutMsg: "聊天工具栏模型列表按钮没有出现",
  });
  await trigger.click();
  await browser.pause(150);

  try {
    await browser.waitUntil(
      async () => {
        if (await hasAnyExactTestId(modelItemTestIds)) {
          return true;
        }
        await clickExactTestIdIfPresent(providerGroupTestId);
        return hasAnyExactTestId(modelItemTestIds);
      },
      {
        timeout: 45000,
        timeoutMsg: `${UPSTREAM_PROVIDER_NAME} 模型列表没有展示目标模型: ${UPSTREAM_MODEL}`,
      },
    );
  } catch (error) {
    throw new Error(
      `${UPSTREAM_PROVIDER_NAME} 模型列表展示不正确\n${JSON.stringify(
        await collectModelListDiagnostics(modelItemTestIds, providerGroupTestId),
        null,
        2,
      )}`,
      { cause: error },
    );
  } finally {
    await browser.keys("Escape").catch(() => undefined);
  }
}

async function assertSelectedUpstreamModel() {
  const label = await getSelectedUpstreamModelLabel();
  const acceptedValues = getUpstreamProviderModelValues(UPSTREAM_MODEL);
  const selected =
    acceptedValues.includes(label.currentValue) ||
    label.text.includes(UPSTREAM_MODEL) ||
    label.title.includes(UPSTREAM_MODEL);
  if (!selected) {
    throw new Error(
      `当前选中模型不是目标 上游 模型: ${JSON.stringify({
        acceptedValues,
        label,
        model: UPSTREAM_MODEL,
      })}`,
    );
  }
}

async function hasAnyExactTestId(testIds: string[]) {
  return browser.execute(
    (currentTestIds) =>
      currentTestIds.some((currentTestId) =>
        Boolean(document.querySelector(`[data-testid="${currentTestId}"]`)),
      ),
    testIds,
  );
}

async function clickExactTestIdIfPresent(currentTestId: string) {
  return browser.execute((targetTestId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${targetTestId}"]`);
    if (!element) {
      return false;
    }
    element.click();
    return true;
  }, currentTestId);
}

async function collectModelListDiagnostics(
  modelItemTestIds: string[],
  providerGroupTestId: string,
) {
  return browser.execute(
    (itemTestIds, groupTestId, triggerTestId) => ({
      bodyText: document.body?.innerText?.slice(0, 1600) ?? "",
      expectedItems: itemTestIds.map((itemTestId) => ({
        exists: Boolean(document.querySelector(`[data-testid="${itemTestId}"]`)),
        testId: itemTestId,
      })),
      providerGroupExists: Boolean(document.querySelector(`[data-testid="${groupTestId}"]`)),
      testIds: Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
        .slice(0, 160)
        .map((element) => element.dataset.testid ?? ""),
      triggerText:
        document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`)?.innerText ?? "",
    }),
    modelItemTestIds,
    providerGroupTestId,
    TID_CHAT_MODEL_SELECT_TRIGGER,
  );
}
