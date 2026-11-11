import {
  TID_CHAT_ERROR_BANNER,
  TID_SETTINGS_BACK_BUTTON,
  TID_V4_COMPOSER_SEND,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  pinE2ELocale,
  readModelProviders,
  waitForWorkspaceApp,
  type E2EModelProviderSnapshot,
} from "#e2e/helpers/desktop-app";
import {
  createCustomOpenAIChatCompletionsProvider,
  refreshSeededOpenAIProvidersThroughSettings,
} from "#e2e/helpers/custom-openai-provider";
import { removeCustomProviderFromPersonalConfig } from "#e2e/helpers/custom-openai-provider-store";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import {
  getSelectedUpstreamModelLabel,
  getUpstreamProviderModelValues,
  selectUpstreamProviderModelById,
  waitForUpstreamModelSelected,
} from "#e2e/helpers/upstream-provider";
import {
  E2E_REPLY_TOKEN,
  getV4ConversationState,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

// 场景：会话常驻模型所属 Provider 从 Registry 下架（对应体验套餐到期 / 切账号）。
// 期望：界面给出「当前使用的模型已不可用」横幅、发送被阻止；重选可用模型后横幅消失、可以继续发送。
// Provider 下架用删除自定义 Provider + 设置页刷新模拟，不依赖账号套餐接口。
const CASE_NAME = "conversation-session-model-unavailable-reselect";
const MODEL_ID = "glm-5.2";
const UNAVAILABLE_BANNER_TEXT = "当前使用的模型已不可用";
// 与 case-local fixture 的 400 响应正文一致；用于区分历史投影错误横幅与模型失效横幅。
const PRIOR_ERROR_BANNER_TEXT = "synthetic prior failure before provider removal";
const DISMISS_BANNER_LABEL = "关闭错误提示";

let replay: Awaited<ReturnType<typeof startConversationModelProviderReplayServer>>;

describe("会话模型从 Registry 下架后提示重选 E2E", () => {
  before(async () => {
    replay = await startConversationModelProviderReplayServer(CASE_NAME);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await replay?.stop();
  });

  it("MUR01: Provider 下架后先显示模型失效横幅并阻止发送；横幅各自可关闭且关闭只绑定该选择；重选后恢复发送", async function () {
    this.timeout(360000);
    const runId = Date.now();
    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await pinE2ELocale("zh-CN");

    const stale = await createProvider("Stale Plan", `model-unavailable-stale-${runId}`, runId);
    const fallback = await createProvider(
      "Fallback Plan",
      `model-unavailable-fallback-${runId}`,
      runId,
    );
    const recovery = await createProvider(
      "Recovery Plan",
      `model-unavailable-recovery-${runId}`,
      runId,
    );

    // 1. 用即将下架的 Provider 建立会话。
    await selectProviderModel(stale);
    const primaryMarker = `E2E_MODEL_UNAVAILABLE_PRIMARY_${runId}`;
    await sendV4Prompt(buildPrompt(primaryMarker));
    await waitForV4ComposerText("", "首发后输入框没有清空");
    await waitForV4UserMessageContaining(primaryMarker);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    const sessionId = await waitForIdleSession("首发没有完成");

    // 1b. 下架前先留下一条不可重试 400 的历史投影错误（control.lastError），不关闭它。
    //     对应回归：关掉模型失效横幅后，历史投影错误横幅曾再也关不掉（关闭分支判断的是原始状态）。
    const priorErrorMarker = `E2E_MODEL_UNAVAILABLE_PRIOR_ERROR_${runId}`;
    await sendV4Prompt(buildPrompt(priorErrorMarker));
    await waitForV4UserMessageContaining(priorErrorMarker);
    await waitForBannerText(PRIOR_ERROR_BANNER_TEXT, "400 终态后没有显示投影错误横幅");
    await waitForIdleSession("400 终态后会话没有收口");

    // 2. Provider 从 Personal Config 删除并经设置页刷新 Registry，回到同一会话。
    await removeCustomProviderFromPersonalConfig(stale.id);
    await refreshSeededOpenAIProvidersThroughSettings([fallback.name, recovery.name]);
    await waitForV4ConversationState(
      (snapshot) => snapshot.sessionId === sessionId && snapshot.state === "idle",
      "刷新 Registry 后没有回到原会话",
      30000,
    );

    // 3. 模型失效横幅先于历史投影错误显示；输入正文后发送按钮仍被阻止（提交门禁与横幅同源）。
    await waitForBannerText(UNAVAILABLE_BANNER_TEXT, "Provider 下架后没有显示模型失效横幅");
    expect(await bannerContains(PRIOR_ERROR_BANNER_TEXT)).toBe(false);
    await setV4ComposerText(`E2E_MODEL_UNAVAILABLE_BLOCKED_${runId}`);
    await browser.waitUntil(async () => (await readSendButtonState()) === "disabled", {
      timeout: 15000,
      timeoutMsg: "模型失效后发送按钮仍可点击",
    });

    // 3b. 关闭模型失效横幅 → 轮到历史投影错误横幅；它也必须能关闭；两条都关掉后没有横幅，发送仍禁用。
    await dismissBanner();
    await waitForBannerText(PRIOR_ERROR_BANNER_TEXT, "关闭模型失效横幅后没有轮到历史投影错误横幅");
    expect(await bannerContains(UNAVAILABLE_BANNER_TEXT)).toBe(false);
    await dismissBanner();
    await browser.waitUntil(async () => (await countBanners()) === 0, {
      timeout: 15000,
      timeoutMsg: "关闭模型失效横幅后，历史投影错误横幅关不掉",
    });
    expect(await readSendButtonState()).toBe("disabled");

    // 3c. 同一失效选择下的普通目录刷新（revision 变化）不得让已关闭的横幅重新弹出。
    await refreshSeededOpenAIProvidersThroughSettings([fallback.name, recovery.name]);
    await waitForV4ConversationState(
      (snapshot) => snapshot.sessionId === sessionId && snapshot.state === "idle",
      "普通刷新后没有回到原会话",
      30000,
    );
    expect(await countBanners()).toBe(0);

    // 4. 重选仍可用的 Provider：不再弹出任何横幅、发送恢复，并真实完成一轮。
    await selectProviderModel(fallback);
    await browser.waitUntil(async () => (await countBanners()) === 0, {
      timeout: 15000,
      timeoutMsg: "重选可用模型后又弹出了横幅",
    });
    await browser.waitUntil(async () => (await readSendButtonState()) === "enabled", {
      timeout: 15000,
      timeoutMsg: "重选可用模型后发送按钮仍不可用",
    });
    const recoveredMarker = `E2E_MODEL_UNAVAILABLE_RECOVERED_${runId}`;
    await setV4ComposerText("");
    await sendV4Prompt(buildPrompt(recoveredMarker));
    await waitForV4UserMessageContaining(recoveredMarker);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForIdleSession("重选后发送没有完成");

    // 5. 关闭记录只绑定被关闭的那个选择：改选 B 后 B 也下架，横幅必须重新出现、发送再次禁用。
    //    对应回归：指纹曾只含失效原因，B 的横幅被 A 的关闭记录吞掉，静默阻塞重现。
    await removeCustomProviderFromPersonalConfig(fallback.id);
    await refreshSeededOpenAIProvidersThroughSettings([recovery.name]);
    await waitForV4ConversationState(
      (snapshot) => snapshot.sessionId === sessionId && snapshot.state === "idle",
      "下架第二个 Provider 后没有回到原会话",
      30000,
    );
    await waitForBannerText(
      UNAVAILABLE_BANNER_TEXT,
      "改选后的 Provider 再次下架时，失效横幅被之前的关闭记录吞掉",
    );
    await browser.waitUntil(async () => (await readSendButtonState()) === "disabled", {
      timeout: 15000,
      timeoutMsg: "第二个 Provider 下架后发送按钮仍可点击",
    });

    // 6. 再次重选可用 Provider：横幅消失、发送恢复并真实完成一轮。
    await selectProviderModel(recovery);
    await browser.waitUntil(async () => (await countBanners()) === 0, {
      timeout: 15000,
      timeoutMsg: "第二次重选可用模型后横幅没有消失",
    });
    const finalMarker = `E2E_MODEL_UNAVAILABLE_FINAL_${runId}`;
    await sendV4Prompt(buildPrompt(finalMarker));
    await waitForV4UserMessageContaining(finalMarker);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForIdleSession("第二次重选后发送没有完成");
  });
});

async function createProvider(label: string, basePath: string, runId: number) {
  const baseURL = `${replay.baseUrl.replace(/\/+$/, "")}/${basePath}`;
  const provider = await createCustomOpenAIChatCompletionsProvider({
    baseURL,
    modelId: MODEL_ID,
    providerName: `${label} E2E ${runId}`,
  });
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "设置页返回按钮没有出现",
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
  return provider;
}

async function selectProviderModel(provider: E2EModelProviderSnapshot) {
  await selectUpstreamProviderModelById(MODEL_ID, {
    includePlainModelFallback: false,
    providerId: provider.id,
    providerName: provider.name,
  });
  await waitForUpstreamModelSelected(MODEL_ID, {
    includePlainModelFallback: false,
    providerId: provider.id,
  });
  const label = await getSelectedUpstreamModelLabel();
  const accepted = getUpstreamProviderModelValues(MODEL_ID, {
    includePlainModelFallback: false,
    providerId: provider.id,
  });
  if (!accepted.includes(label.currentValue)) {
    throw new Error(`没有选中 ${provider.name}: ${JSON.stringify({ accepted, label })}`);
  }
}

function buildPrompt(marker: string) {
  return `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

async function waitForIdleSession(timeoutMsg: string) {
  const snapshot = await waitForV4ConversationState(
    (candidate) =>
      candidate.state === "idle" && candidate.queueCount === 0 && Boolean(candidate.sessionId),
    timeoutMsg,
    90000,
  );
  if (!snapshot.sessionId) throw new Error(`${timeoutMsg}: sessionId missing`);
  return snapshot.sessionId;
}

/** v4 发送按钮的真实可用态；按钮不存在时返回 missing，避免把「没渲染」误判成任一状态。 */
async function readSendButtonState() {
  return browser.execute((sendTestId) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
    if (!button) return "missing" as const;
    return button.disabled || button.getAttribute("aria-disabled") === "true"
      ? ("disabled" as const)
      : ("enabled" as const);
  }, TID_V4_COMPOSER_SEND);
}

async function countBanners() {
  return browser.execute(
    (bannerTestId) => document.querySelectorAll(`[data-testid="${bannerTestId}"]`).length,
    TID_CHAT_ERROR_BANNER,
  );
}

/** 点击当前横幅的关闭按钮（aria-label 固定为中文，前置 pinE2ELocale("zh-CN")）。 */
async function dismissBanner() {
  const clicked = await browser.execute(
    (bannerTestId, label) => {
      const banner = document.querySelector<HTMLElement>(`[data-testid="${bannerTestId}"]`);
      const button = banner?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      if (!button || button.disabled) return false;
      button.click();
      return true;
    },
    TID_CHAT_ERROR_BANNER,
    DISMISS_BANNER_LABEL,
  );
  if (!clicked) throw new Error("错误横幅上没有可点击的关闭按钮");
}

async function bannerContains(text: string) {
  return browser.execute(
    (bannerTestId, expected) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${bannerTestId}"]`)).some(
        (node) => (node.innerText ?? "").includes(expected),
      ),
    TID_CHAT_ERROR_BANNER,
    text,
  );
}

async function waitForBannerText(text: string, timeoutMsg: string) {
  try {
    await browser.waitUntil(() => bannerContains(text), { timeout: 30000, timeoutMsg });
  } catch (error) {
    // 失败时带上运行态证据：工具栏当前模型、横幅文本、Personal Config 里剩余的 Provider。
    const diagnostic = await browser.execute(() => ({
      banners: Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="chat-error-banner"]'),
      ).map((node) => node.innerText.slice(0, 300)),
      modelTrigger: document
        .querySelector<HTMLElement>('[data-testid="chat-model-select-trigger"]')
        ?.outerHTML.slice(0, 600),
      sendButton: document
        .querySelector<HTMLButtonElement>('[data-testid="v4-composer-send"]')
        ?.outerHTML.slice(0, 300),
    }));
    const providers = (await readModelProviders()).map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((model) => (typeof model === "string" ? model : model.id)),
    }));
    const conversation = await getV4ConversationState();
    throw new Error(`${timeoutMsg}; ${JSON.stringify({ conversation, diagnostic, providers })}`, {
      cause: error,
    });
  }
}
