import {
  TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
  TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER,
  TID_MODEL_PROVIDER_NAV_ITEM,
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
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import { UPSTREAM_MODEL, UPSTREAM_PROVIDER_ID } from "#e2e/helpers/upstream-provider";
import {
  E2E_BIGMODEL_PLAN_PROVIDER_ID,
  E2E_BIGMODEL_START_PROVIDER_ID,
  E2E_PLAN_NON_DEFAULT_MODEL,
  readBigModelConnectionSelection,
  restartIntoWorkspace,
  seedBigModelConnectionSelection,
  seedBigModelOAuthCredential,
  seedPersistedModelSelection,
  seedReplayProvider,
  waitForSelectedModel,
} from "#e2e/helpers/model-provider-restart";
import { sel } from "#e2e/helpers/selectors";
import {
  E2E_REPLY_TOKEN,
  getV4ComposerText,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const BIGMODEL_ACCOUNT_NAV_KEY = `preset:${E2E_BIGMODEL_START_PROVIDER_ID}`;
const TEAM_PLAN_KEY = "team:bigmodel:product-team-a:org-team-a:proj-team-a";

describe("Model Settings Provider connection transition E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  beforeEach(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      id: UPSTREAM_PROVIDER_ID,
      models: [{ id: UPSTREAM_MODEL, reasoningLevel: { values: ["high", "max"], map: "{}" } }],
      name: "Upstream E2E",
    });
  });

  it("I29/MP-S01: 切换 Family 连接方式时保留 上游 草稿", async function () {
    this.timeout(180000);
    await seedPersistedModelSelection({
      modelId: UPSTREAM_MODEL,
      providerId: UPSTREAM_PROVIDER_ID,
      reasoningLevel: "max",
    });
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedBigModelConnectionSelection({
          kind: "individual-coding-plan",
        });
        await seedBigModelOAuthCredential();
      },
    });
    await waitForSelectedModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    const draftText = "E2E_MODEL_PROVIDER_TRANSITION_S01_DRAFT";
    await setV4ComposerText(draftText);

    await selectTeamPlanInSettings();
    await expectTeamPlanPersisted();
    await expectExternalDraftPreserved(draftText);
    await assertUpstreamRequest("E2E_MODEL_PROVIDER_TRANSITION_S01");
  });

  it("I30/MP-S02: 再次选择当前 Team Plan 仍保留 上游 草稿", async function () {
    this.timeout(180000);
    await seedPersistedModelSelection({
      modelId: UPSTREAM_MODEL,
      providerId: UPSTREAM_PROVIDER_ID,
      reasoningLevel: "max",
    });
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedTeamPlanSelection();
        await seedBigModelOAuthCredential();
      },
    });
    await waitForSelectedModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    const draftText = "E2E_MODEL_PROVIDER_TRANSITION_S02_DRAFT";
    await setV4ComposerText(draftText);

    await selectTeamPlanInSettings();
    await expectTeamPlanPersisted();
    await expectExternalDraftPreserved(draftText);
    await assertUpstreamRequest("E2E_MODEL_PROVIDER_TRANSITION_S02");
  });

  it("I31/MP-S03: Team Plan 设置页往返保留当前 Plan 内模型", async function () {
    this.timeout(180000);
    await seedPersistedModelSelection({
      modelId: E2E_PLAN_NON_DEFAULT_MODEL,
      providerId: E2E_BIGMODEL_PLAN_PROVIDER_ID,
      reasoningLevel: "max",
    });
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedTeamPlanSelection();
        await seedBigModelOAuthCredential();
      },
    });
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);

    await visitTeamPlanSettingsAndReturn();
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);
    await assertPlanRequest("E2E_MODEL_PROVIDER_TRANSITION_S03");
  });
});

async function seedTeamPlanSelection() {
  await seedBigModelConnectionSelection({
    kind: "team-coding-plan",
    productId: "product-team-a",
    organizationId: "org-team-a",
    projectId: "proj-team-a",
  });
}

async function selectTeamPlanInSettings() {
  await openTeamPlanSettings();
  await clickTestIdByDom(TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER, {
    timeout: 15000,
    timeoutMsg: "连接方式下拉框没有出现",
  });
  const option = await $(sel(testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, TEAM_PLAN_KEY)));
  await option.waitForDisplayed({ timeout: 30000, timeoutMsg: "Team Plan 连接方式没有出现" });
  await option.click();
  await returnFromModelProviderSettings();
}

async function visitTeamPlanSettingsAndReturn() {
  await openTeamPlanSettings();
  const trigger = await $(sel(TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER));
  await trigger.waitForDisplayed({ timeout: 15000, timeoutMsg: "连接方式下拉框没有出现" });
  await browser.waitUntil(async () => (await trigger.getText()).trim().length > 0, {
    timeout: 15000,
    timeoutMsg: "当前 Team Plan 连接方式没有完成展示",
  });
  await returnFromModelProviderSettings();
}

async function openTeamPlanSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15000 });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), { timeout: 15000 });
  // Bug 根因：按量 API 已在 Provider Template 切换中退出 Family 导航，旧 E2E
  // 仍把已删除的 bigmodel-api Concrete Provider 当作账号连接入口。Family 的设置
  // 身份始终由 Account Provider 承载，连接方式切换必须从该正式导航项进入。
  await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, BIGMODEL_ACCOUNT_NAV_KEY), {
    timeout: 30000,
    timeoutMsg: "BigModel Provider 导航项没有出现",
  });
}

async function returnFromModelProviderSettings() {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15000 });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
}

async function expectTeamPlanPersisted() {
  const selection = await readBigModelConnectionSelection();
  expect(selection).toEqual({
    kind: "team-coding-plan",
    productId: "product-team-a",
    organizationId: "org-team-a",
    projectId: "proj-team-a",
  });
}

async function expectExternalDraftPreserved(expectedDraftText: string) {
  // 连接选择允许短暂异步收敛；等待后同时验证外部模型和用户草稿均未被替换。
  await browser.pause(2000);
  await waitForSelectedModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
  await browser.waitUntil(async () => (await getV4ComposerText()) === expectedDraftText, {
    timeout: 15000,
    timeoutMsg: "Model Settings 往返后用户草稿文本没有保留",
  });
}

async function assertUpstreamRequest(marker: string) {
  const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  await sendV4Prompt(prompt);
  const capture = await waitForUpstreamNetworkCapture(marker);
  assertUpstreamRequestCapture(capture, { expectedText: prompt, model: UPSTREAM_MODEL });
  await waitForV4TimelineContaining(E2E_REPLY_TOKEN);
}

async function assertPlanRequest(marker: string) {
  const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  await sendV4Prompt(prompt);
  await waitForV4TimelineContaining(E2E_REPLY_TOKEN);
}
