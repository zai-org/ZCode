import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { encodeCustomModelValue } from "@zcode/shared";
import {
  TID_AUTOMATION_CREATE_MANUALLY,
  TID_AUTOMATION_CREATE_MENU,
  TID_AUTOMATION_CARD,
  TID_AUTOMATION_FORM_PROMPT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATIONS_LIST,
  TID_AUTOMATIONS_OPEN,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_START_PLAN_RECOMMENDATION_DIALOG,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  E2E_BIGMODEL_PLAN_PROVIDER_ID,
  E2E_BIGMODEL_START_PROVIDER_ID,
  E2E_PLAN_DEFAULT_MODEL,
  E2E_PLAN_NON_DEFAULT_MODEL,
  seedBigModelOAuthCredential,
  seedBigModelConnectionSelection,
  seedBigModelStartPlanCredential,
  seedReplayProvider,
  waitForSelectedModel,
} from "#e2e/helpers/model-provider-restart";
import {
  prepareV4ConversationE2E,
  startNewV4Draft,
  setV4ComposerText,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import { sel } from "#e2e/helpers/selectors";

const PLAN_PROVIDER_ID = E2E_BIGMODEL_PLAN_PROVIDER_ID;
const PLAN_MODEL = "GLM-5.2";
const START_PROVIDER_ID = E2E_BIGMODEL_START_PROVIDER_ID;
const START_MODEL = "GLM-5.2";
const PLAN_MODEL_VALUE = encodeCustomModelValue(PLAN_PROVIDER_ID, PLAN_MODEL);
const START_MODEL_VALUE = encodeCustomModelValue(START_PROVIDER_ID, START_MODEL);
/**
 * 定时任务的模型选择是 task-local 记录，不能因为聊天默认计划改变而被重写。
 * 这里用服务端下发的 BigModel Coding/Start Plan provider，并从只读任务索引对账
 * 完整 providerId/modelId；运行时请求由已有 Cron E2E 覆盖。
 */
describe("Automation 在 Start/Coding Plan 间保存模型身份 E2E", () => {
  afterEach(async () => {
    await setCatalogMode("full").catch(() => undefined);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("F-AUTOMATION-004/F-AUTOMATION-005/F-AUTOMATION-006/F-PLAN-004/F-PLAN-008: 两种计划分别保存，任务记录不跟随默认值漂移", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E({ skipProvider: true });
    await seedBigModelOAuthCredential();
    await seedBigModelStartPlanCredential();
    await seedBigModelConnectionSelection({
      kind: "team-coding-plan",
      productId: "product-team-a",
      organizationId: "org-team-a",
      projectId: "proj-team-a",
    });
    await seedReplayProvider({
      id: PLAN_PROVIDER_ID,
      models: [PLAN_MODEL],
      name: "BigModel Coding Plan E2E",
    });
    await seedReplayProvider({
      id: START_PROVIDER_ID,
      models: [START_MODEL],
      name: "BigModel Start Plan E2E",
    });
    await restartCatalogWorkspace();
    // 先走正式 上游 provider 初始化，确保 Automation 表单的本地 Host
    // 已有可执行模型；随后再从真实下拉菜单切到两个 case-local 计划 provider。
    await prepareV4ConversationE2E();

    const codingTitle = `E2E_AUTOMATION_CODING_PLAN_${Date.now()}`;
    await createAutomation(codingTitle, "固定 Coding Plan 模型", PLAN_MODEL_VALUE);
    const codingRecord = await waitForAutomationModel(codingTitle);
    expect(codingRecord).toEqual({
      providerId: PLAN_PROVIDER_ID,
      modelId: PLAN_MODEL,
    });
    // 编辑与模型无关的 prompt 后重新读取持久化值，覆盖“保存其他字段不会
    // 清掉模型身份”的路径；先编辑第一张卡片，避免同时创建第二张卡片后列表排序
    // 让用户点击落到另一张任务上。
    await editAutomationPrompt(codingTitle, "只修改 prompt，不修改模型");
    expect(await readAutomationModel(codingTitle)).toEqual({
      providerId: PLAN_PROVIDER_ID,
      modelId: PLAN_MODEL,
    });

    // 两个计划 provider 都是真实模型菜单项；这里直接在 Automation 表单中切换，
    // 验证任务保存的是完整 providerId，而不是把同名 GLM-5.2 按当前聊天连接重写。
    // Family 连接选择与 Automation 的显式模型选择是两个正交事实；本 case 只验证
    // Automation 保存完整 Provider/Model 身份，避免把产品状态耦合成不可诊断的失败。
    const startTitle = `E2E_AUTOMATION_START_PLAN_${Date.now()}`;
    await createAutomation(startTitle, "固定 Start Plan 模型", START_MODEL_VALUE);
    const startRecord = await waitForAutomationModel(startTitle);
    expect(startRecord).toEqual({
      providerId: START_PROVIDER_ID,
      modelId: START_MODEL,
    });

    // 创建第二个任务并不会改写第一个任务；这是“同名模型按完整计划身份区分”的关键断言。
    expect(await readAutomationModel(codingTitle)).toEqual({
      providerId: PLAN_PROVIDER_ID,
      modelId: PLAN_MODEL,
    });

    // 同一个用户在聊天草稿中切换连接时，菜单必须保留完整 provider 身份，不能只按
    // 模型名称去重；Automation 的两个已保存值也必须继续保持不变。
    await startNewV4Draft();
    await selectAutomationModel(START_MODEL_VALUE);
    expect(
      await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).getAttribute("data-model-current-value"),
    ).toBe(START_MODEL_VALUE);
    await selectAutomationModel(PLAN_MODEL_VALUE);
    expect(
      await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).getAttribute("data-model-current-value"),
    ).toBe(PLAN_MODEL_VALUE);
    // 当前连接切回 Coding Plan 后，之前保存的 Start Plan 任务仍保留原身份；
    // 这也是任务等待期间套餐失效时“不静默改绑另一计划”的最小可观察边界。
    expect(await readAutomationModel(startTitle)).toEqual({
      providerId: START_PROVIDER_ID,
      modelId: START_MODEL,
    });
  });

  it("F-PLAN-005: 套餐目录暂时不可用时保留当前选择，恢复后仍可继续使用", async function () {
    this.timeout(220000);
    await prepareBigModelCatalogWorkspace(E2E_PLAN_DEFAULT_MODEL);
    await setCatalogMode("unavailable");
    await restartCatalogWorkspace();
    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, PLAN_MODEL);

    // 目录不可用期间只保留当前选择，不把草稿静默改成 上游；目录恢复后
    // 再重启一次，验证同一个选择仍可继续作为下一次发送的初始配置。
    await setCatalogMode("full");
    await restartCatalogWorkspace();
    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, PLAN_MODEL);
  });

  it("F-PLAN-006: 服务端只返回部分目录时不覆盖已有模型事实", async function () {
    this.timeout(220000);
    await prepareBigModelCatalogWorkspace(E2E_PLAN_NON_DEFAULT_MODEL);
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);
    await setCatalogMode("partial");
    await restartCatalogWorkspace();
    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);
  });
});

async function prepareBigModelCatalogWorkspace(model: string): Promise<void> {
  await prepareV4ConversationE2E({ skipProvider: true });
  // 目录冷恢复验证项目偏好；上一用例结束于全局草稿，先通过真实项目入口选定范围。
  await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
  await seedBigModelOAuthCredential();
  await seedBigModelConnectionSelection({
    kind: "team-coding-plan",
    productId: "product-team-a",
    organizationId: "org-team-a",
    projectId: "proj-team-a",
  });
  await seedReplayProvider({
    id: E2E_BIGMODEL_PLAN_PROVIDER_ID,
    models: [PLAN_MODEL, E2E_PLAN_NON_DEFAULT_MODEL],
    name: "BigModel Coding Plan E2E",
  });

  await setCatalogMode("full");
  await restartCatalogWorkspace();
  await prepareV4ConversationE2E({ skipProvider: true });
  await selectAutomationModel(encodeCustomModelValue(E2E_BIGMODEL_PLAN_PROVIDER_ID, model));
  // 当前合同只持久化有正文的项目草稿；旧 workspace Recent 键不再是此入口权威。
  // 经真实 Composer 写入正文，再只读核对草稿已落盘，冷启时不补写任何模型状态。
  const text = "E2E_PLAN_CATALOG_DRAFT";
  await setV4ComposerText(text);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (expectedText, providerId, modelId) => {
          return Object.entries(localStorage).some(([key, raw]) => {
            if (!key.startsWith("zcode-v4-composer-project-drafts:v1:")) return false;
            const value = JSON.parse(raw) as {
              scopes?: Record<
                string,
                {
                  text?: string;
                  modelSelection?: { providerId?: string; modelId?: string };
                }
              >;
            };
            return Object.values(value.scopes ?? {}).some(
              (draft) =>
                draft.text === expectedText &&
                draft.modelSelection?.providerId === providerId &&
                draft.modelSelection.modelId === modelId,
            );
          });
        },
        text,
        E2E_BIGMODEL_PLAN_PROVIDER_ID,
        model,
      ),
    {
      timeout: 15000,
      timeoutMsg: "项目草稿的正文和模型未持久化",
    },
  );
}

async function restartCatalogWorkspace(): Promise<void> {
  // 启动后的默认界面是全局草稿；目录恢复覆盖指定项目的偏好，不依赖旧的活动 tab 自动恢复。
  await reloadElectronSessionPreservingBrowserProfile(browser);
  await skipOccupationOnboardingIfPresent();
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === "draft" || Boolean(snapshot.sessionId),
    "目录冷启动后主 pane 未就绪",
  );
  await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
}

async function setCatalogMode(mode: "full" | "partial" | "unavailable"): Promise<void> {
  const baseUrl = process.env.ZCODE_CODING_PLAN_TEAM_MOCK_BASE_URL?.trim();
  if (!baseUrl) throw new Error("Coding Plan mock URL 未配置，无法切换模型目录状态");
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/catalog-mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error(`模型目录状态切换失败：${response.status}`);
}

async function createAutomation(title: string, prompt: string, modelValue: string): Promise<void> {
  await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeout: 15000 });
  await clickTestIdByWebDriver(TID_AUTOMATION_CREATE_MENU, { timeout: 15000 });
  await clickTestIdByDom(TID_AUTOMATION_CREATE_MANUALLY, { timeout: 15000 });
  await setInputValueByTestIdDom(TID_AUTOMATION_FORM_TITLE, title);
  await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, prompt);
  await clickTestIdByWebDriver(TID_AUTOMATION_SCHEDULE_ADD, { timeout: 15000 });
  await clickTestIdByDom(testId(TID_AUTOMATION_FREQUENCY_OPTION, "daily"), {
    timeout: 15000,
  });
  await selectAutomationModel(modelValue);
  await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, { timeout: 15000 });
  await finishAutomationSave();
}

async function finishAutomationSave(): Promise<void> {
  // 保存 Coding Plan 会触发体验套餐推荐；须走真实“不了”操作，才能验证原身份落盘。
  await browser.waitUntil(
    async () =>
      (await $(sel(TID_AUTOMATIONS_LIST)).isExisting()) ||
      (await $(sel(TID_START_PLAN_RECOMMENDATION_DIALOG)).isExisting()),
    { timeout: 30000, timeoutMsg: "Automation 保存既未返回列表，也未出现套餐推荐" },
  );
  const recommendation = $(sel(TID_START_PLAN_RECOMMENDATION_DIALOG));
  if (await recommendation.isExisting()) {
    await recommendation.$("button*=不了").click();
  }
  await waitForTestIdByDom(TID_AUTOMATIONS_LIST, {
    timeout: 30000,
    timeoutMsg: "Automation 保存后没有回到列表",
  });
}

async function selectAutomationModel(modelValue: string): Promise<void> {
  const decoded = decodeModelValue(modelValue);
  const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await trigger.waitForClickable({ timeout: 15000 });
  // 当前模型不会重复出现在菜单项里；Automation 新建表单继承聊天默认模型时，
  // 已命中目标就是有效的用户态结果，不应把“菜单里没有当前项”误判成失败。
  if ((await trigger.getAttribute("data-model-current-value")) === modelValue) {
    return;
  }
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await clickTestIdByWebDriver(TID_CHAT_MODEL_SELECT_TRIGGER, {
      timeout: 15000,
      timeoutMsg: "Automation 表单没有模型选择器",
    });
  }
  // Composer 合并控件先显示当前供应商的模型；再打开供应商层才能切到另一计划。
  const providerTrigger = $('[data-testid="composer-provider-trigger"]');
  if (
    (await providerTrigger.isExisting()) &&
    (await providerTrigger.getAttribute("aria-expanded")) !== "true"
  ) {
    await providerTrigger.click();
  }
  const itemTestId = testId(TID_CHAT_MODEL_SELECT_ITEM, modelValue);
  // Automation 使用 Registry 分组；Composer 的团队分组另含账号范围。
  // 两个入口都只定位同一 Provider，最终仍严格校验完整 model value。
  const groupTestIds = [
    testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${decoded.providerId}`),
  ];
  if (decoded.providerId === PLAN_PROVIDER_ID) {
    groupTestIds.push(
      testId(
        TID_CHAT_MODEL_SELECT_GROUP,
        JSON.stringify([
          "bigmodel",
          "team-coding-plan",
          "product-team-a",
          "org-team-a",
          "proj-team-a",
        ]),
      ),
    );
  }
  let visibleGroup: string | undefined;
  try {
    await browser.waitUntil(
      async () => {
        if ((await trigger.getAttribute("data-model-current-value")) === modelValue) return true;
        const visibleIds = await browser.execute(
          (itemId, groupIds) =>
            Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
              .filter(
                (element) =>
                  element.getClientRects().length > 0 &&
                  (element.dataset.testid === itemId ||
                    groupIds.includes(element.dataset.testid ?? "")),
              )
              .map((element) => element.dataset.testid),
          itemTestId,
          groupTestIds,
        );
        visibleGroup = groupTestIds.find((id) => visibleIds.includes(id));
        return visibleIds.length > 0;
      },
      { timeout: 30000, timeoutMsg: `模型菜单没有出现 ${modelValue}` },
    );
  } catch (error) {
    const menu = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="chat-model-select-"]'))
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({
          id: element.dataset.testid,
          text: element.innerText,
          value: element.getAttribute("data-model-current-value"),
        })),
    );
    throw new Error(`模型菜单没有出现 ${modelValue}; menu=${JSON.stringify(menu)}`, {
      cause: error,
    });
  }
  // 水合可能在菜单打开后完成；当前项被移出候选列表时不重复选择。
  if ((await trigger.getAttribute("data-model-current-value")) === modelValue) {
    await browser.keys("Escape");
    return;
  }
  if (!(await $(sel(itemTestId)).isDisplayed()) && visibleGroup) {
    await clickTestIdByDom(visibleGroup);
    await $(sel(itemTestId)).waitForDisplayed({ timeout: 15000 });
  }
  await $(sel(itemTestId)).click();
  await browser.waitUntil(
    async () =>
      (await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).getAttribute("data-model-current-value")) ===
      modelValue,
    { timeout: 15000, timeoutMsg: `Automation 模型没有切换到 ${modelValue}` },
  );
  // Composer 选模型后保留弹层以继续选档位；下一次独立选择前显式结束这一交互。
  await browser.keys("Escape");
  await browser.waitUntil(async () => (await trigger.getAttribute("aria-expanded")) !== "true", {
    timeout: 15000,
    timeoutMsg: "模型选择结束后弹层未关闭",
  });
}

function decodeModelValue(value: string): { providerId: string } {
  const encoded = value.slice("custom:".length);
  const separator = encoded.indexOf(":");
  return { providerId: decodeURIComponent(separator < 0 ? encoded : encoded.slice(0, separator)) };
}

async function editAutomationPrompt(title: string, prompt: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (cardTestId, expectedTitle) => {
          const card = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (element) =>
              element.dataset.testid === cardTestId && element.textContent?.includes(expectedTitle),
          );
          if (!card) return false;
          card.click();
          return true;
        },
        TID_AUTOMATION_CARD,
        title,
      ),
    { timeout: 30000, timeoutMsg: `没有打开 Automation 详情：${title}` },
  );
  await waitForTestIdByDom(TID_AUTOMATION_FORM_PROMPT, {
    timeout: 15000,
    timeoutMsg: "Automation 详情没有 prompt 输入框",
  });
  await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, prompt);
  await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, { timeout: 15000 });
  await finishAutomationSave();
}

async function waitForAutomationModel(title: string) {
  await browser.waitUntil(async () => (await readAutomationModel(title)) !== null, {
    timeout: 15000,
    timeoutMsg: `没有在任务索引中找到 ${title} 的模型配置`,
  });
  const model = await readAutomationModel(title);
  if (!model) throw new Error(`任务索引中的模型配置为空：${title}`);
  return model;
}

async function readAutomationModel(title: string) {
  const database = new DatabaseSync(join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT model_selection FROM automations WHERE title = ?")
      .get(title) as { model_selection: string | null } | undefined;
    if (!row?.model_selection) return null;
    const selection = JSON.parse(row.model_selection) as {
      modelId?: string;
      providerId?: string;
    };
    return selection.providerId && selection.modelId
      ? { modelId: selection.modelId, providerId: selection.providerId }
      : null;
  } finally {
    database.close();
  }
}
