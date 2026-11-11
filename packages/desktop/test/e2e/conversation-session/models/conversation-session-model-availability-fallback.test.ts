import { countUpstreamRequests } from "#e2e/helpers/conversation-session-network";
import {
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_V4_COMPOSER_SEND,
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
import {
  UPSTREAM_ALTERNATE_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  selectUpstreamProviderModelById,
} from "#e2e/helpers/upstream-provider";
import {
  readLastSelectedAgentConfig,
  restartIntoWorkspacePreservingProfile,
  seedPersistedModelSelection,
  seedReplayProvider,
  waitForSelectedModel,
} from "#e2e/helpers/model-provider-restart";
import { sel } from "#e2e/helpers/selectors";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  getV4ComposerText,
  startNewV4Draft,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("模型不可用时保留选择 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I56/MAF-01: idle session 禁用 Provider 后阻止发送，明确改选后恢复", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      // 回放使用 Messages 协议，不能用默认 Chat Completions 种子请求另一条路由。
      apiFormat: "anthropic-messages",
      id: UPSTREAM_PROVIDER_ID,
      // 修复原因：字符串模型只声明 disabled 档位，下面种入的 max 偏好会在冷启动时被拒绝，
      // 草稿没有合法档位，种子消息的发送按钮一直不可用。源模型声明与偏好一致的档位。
      models: [{ id: UPSTREAM_MODEL, reasoningLevel: { values: ["high", "max"], map: "{}" } }],
      name: "Upstream Fallback Source",
    });
    await seedReplayProvider({
      // 回放使用 Messages 协议，不能用默认 Chat Completions 种子请求另一条路由。
      apiFormat: "anthropic-messages",
      id: UPSTREAM_ALTERNATE_PROVIDER_ID,
      models: [UPSTREAM_ALTERNATE_MODEL],
      name: "Upstream Fallback Target",
    });
    await seedPersistedModelSelection({
      modelId: UPSTREAM_MODEL,
      providerId: UPSTREAM_PROVIDER_ID,
      reasoningLevel: "max",
    });
    // 完整重启必须保留浏览器 profile；只恢复模型偏好会丢失 API Key 登录模式。
    await restartIntoWorkspacePreservingProfile();
    await waitForSelectedModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);

    const seedMarker = `E2E_MODEL_FALLBACK_SEED_${Date.now()}`;
    await sendV4Prompt(`${seedMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`);
    await waitForV4TimelineContaining(E2E_REPLY_TOKEN);

    await assertDisabledSelectionAndSelectTarget("Upstream Fallback Target");

    const marker = `E2E_MODEL_FALLBACK_TARGET_${Date.now()}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prompt);
    const capture = await waitForUpstreamNetworkCapture(marker);
    assertUpstreamRequestCapture(capture, {
      expectedText: prompt,
      model: UPSTREAM_ALTERNATE_MODEL,
    });
    await waitForV4TimelineContaining(E2E_REPLY_TOKEN);
  });

  it("I61/MAF-02: 草稿禁用 Provider 后保留选择，明确改选后下一草稿继承", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      // 回放使用 Messages 协议，不能用默认 Chat Completions 种子请求另一条路由。
      apiFormat: "anthropic-messages",
      id: UPSTREAM_PROVIDER_ID,
      models: [UPSTREAM_MODEL],
      name: "Upstream Draft Fallback Source",
    });
    await seedReplayProvider({
      // 回放使用 Messages 协议，不能用默认 Chat Completions 种子请求另一条路由。
      apiFormat: "anthropic-messages",
      id: UPSTREAM_ALTERNATE_PROVIDER_ID,
      models: [UPSTREAM_ALTERNATE_MODEL],
      name: "Upstream Draft Fallback Target",
    });
    await seedPersistedModelSelection({
      modelId: UPSTREAM_MODEL,
      providerId: UPSTREAM_PROVIDER_ID,
      reasoningLevel: "max",
    });
    // 完整重启必须保留浏览器 profile；只恢复模型偏好会丢失 API Key 登录模式。
    await restartIntoWorkspacePreservingProfile();
    await waitForSelectedModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);

    await assertDisabledSelectionAndSelectTarget("Upstream Draft Fallback Target");

    const marker = `E2E_MODEL_FALLBACK_DRAFT_TARGET_${Date.now()}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prompt);
    const capture = await waitForUpstreamNetworkCapture(marker);
    assertUpstreamRequestCapture(capture, {
      expectedText: prompt,
      model: UPSTREAM_ALTERNATE_MODEL,
    });
    await waitForV4TimelineContaining(E2E_REPLY_TOKEN);

    await startNewV4Draft();
    await waitForSelectedModel(UPSTREAM_ALTERNATE_PROVIDER_ID, UPSTREAM_ALTERNATE_MODEL);
  });
});

async function disableProvider(providerId: string) {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15000 });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 15000,
  });
  await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${providerId}`), {
    timeout: 30000,
    timeoutMsg: `模型供应商导航没有出现 ${providerId}`,
  });
  // Provider 启停已改为有状态开关，旧的文字按钮定位不再对应实际设置入口。
  const toggle = $('[data-testid="model-provider-enabled-switch"]');
  await toggle.waitForClickable({ timeout: 15000 });
  expect(await toggle.getAttribute("aria-checked")).toBe("true");
  await toggle.click();
  await browser.waitUntil(async () => (await toggle.getAttribute("aria-checked")) === "false", {
    timeout: 15000,
    timeoutMsg: `模型供应商未停用: ${providerId}`,
  });
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15000 });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
}

async function assertDisabledSelectionAndSelectTarget(providerName: string) {
  const marker = `E2E_MODEL_UNAVAILABLE_UNSENT_${Date.now()}`;
  await setV4ComposerText(marker);
  await disableProvider(UPSTREAM_PROVIDER_ID);
  // 旧用例把静默 fallback 当作成功。当前契约保留用户选择，只有明确改选才恢复发送。
  await browser.waitUntil(async () => !(await $(sel(TID_V4_COMPOSER_SEND)).isEnabled()), {
    timeout: 15000,
    timeoutMsg: "禁用当前 Provider 后发送按钮仍可用",
  });
  expect(await getV4ComposerText()).toBe(marker);
  expect((await readLastSelectedAgentConfig())?.model).toContain(UPSTREAM_MODEL);
  expect(await countUpstreamRequests({ includes: [marker] })).toBe(0);
  await selectUpstreamProviderModelById(UPSTREAM_ALTERNATE_MODEL, {
    providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
    providerName,
  });
  await waitForSelectedModel(UPSTREAM_ALTERNATE_PROVIDER_ID, UPSTREAM_ALTERNATE_MODEL);
  expect(await getV4ComposerText()).toBe(marker);
  await $(sel(TID_V4_COMPOSER_SEND)).waitForEnabled({ timeout: 15000 });
}
