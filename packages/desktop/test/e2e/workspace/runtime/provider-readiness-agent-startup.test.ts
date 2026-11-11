import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import { BUILTIN_PROVIDER_TEMPLATE_IDS, decodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_ERROR_BANNER,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_MODEL_PROVIDER_API_KEY_INPUT,
  TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON,
  TID_MODEL_PROVIDER_TEMPLATE_ITEM,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_LOGIN_API_KEY_SKIP_BUTTON,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_BACK_BUTTON,
  TID_TASK_ITEM,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  readModelProvider,
  readModelProviders,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  PROVIDER_READINESS_HISTORY_ASSISTANT_TEXT,
  PROVIDER_READINESS_HISTORY_SESSION_ID,
  PROVIDER_READINESS_HISTORY_TITLE,
  PROVIDER_READINESS_HISTORY_USER_TEXT,
} from "#e2e/helpers/provider-readiness-history-fixture";
import {
  selectV4TaskById,
  waitForV4ComposerText,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import {
  countAgentProcessRows,
  isMainRendererUrl,
  isResourceManagerUrl,
  openResourceManager,
  switchToElectronRendererTarget,
  waitForAgentProcessCount,
  waitForResourceManagerReady,
} from "#e2e/helpers/resource-manager";

const E2E_PROVIDER_API_KEY = "e2e-login-api-key";

describe("Provider/model readiness 只门禁模型执行", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I23/I24: 空配置只启动唯一只读 Agent，保存 API Key provider 后复用并水合草稿模型", async function () {
    this.timeout(120000);

    await waitForTestIdByDom(TID_LOGIN_USE_API_KEY_BUTTON, {
      timeout: 30000,
      timeoutMsg: "空 auth/provider 冷启动后没有展示 API Key 配置入口",
    });
    await clickTestIdByDom(TID_LOGIN_USE_API_KEY_BUTTON);
    await clickTestIdByDom(TID_LOGIN_API_KEY_SKIP_BUTTON, {
      timeout: 15000,
      timeoutMsg: "API Key 登录页没有可用的暂时跳过入口",
    });
    await waitForDefaultWorkspaceReady(30000);
    await waitForModelConfigMissingBanner();

    // 修复原因：只看 Process Monitor 只能证明 CLI 启动，不能证明用户真的拿到了历史。
    // fixture 同时预置 tasks-index membership 与 CLI session：前者负责侧栏 row，后者必须
    // 通过真实 sessions-index/conversation 只读订阅打开并展示正文。
    await waitForProviderReadinessHistory();
    await selectV4TaskById(PROVIDER_READINESS_HISTORY_SESSION_ID);
    await waitForV4TimelineContaining(PROVIDER_READINESS_HISTORY_USER_TEXT);
    await waitForV4TimelineContaining(PROVIDER_READINESS_HISTORY_ASSISTANT_TEXT);
    // 唯一只读 Agent 的前提是同一项目，不能新建到独立虚拟目录。
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    await waitForModelConfigMissingBanner();

    const blockedDraft = "这条草稿必须保留，不能进入 pending command";
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, blockedDraft, {
      timeout: 15000,
      timeoutMsg: "缺模型草稿页没有可输入的 composer",
    });
    // 当前模型门禁在按钮层禁发；等待可点击会在正确的拒绝状态超时。
    expect(await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isEnabled()).toBe(false);
    await waitForV4ComposerText(blockedDraft, "缺模型门禁没有保留 composer 原文");
    expect(
      await browser.execute(() => window.localStorage.getItem("zcode-v4-pending-commands:v1")),
    ).toBeNull();
    await waitForModelConfigMissingBanner();

    await openResourceManager();
    await switchToElectronRendererTarget(isResourceManagerUrl);
    await waitForResourceManagerReady();
    // 修复原因：sessions-index 是活动与详情的事实源。provider 未就绪时若完全禁止
    // workspace CLI 启动，已有 task-index row 也无法读取正文；这里只允许只读 topic，
    // 写路径仍由门禁拒绝。
    await waitForAgentProcessCount(1, { workspaceNameSuffix: "-zcodeproject" });

    await switchToElectronRendererTarget(isMainRendererUrl);
    await clickModelSettingsFromMissingBanner();
    const providerId = await createApiKeyProviderFromTemplate();
    await setInputValueByTestIdDom(TID_MODEL_PROVIDER_API_KEY_INPUT, E2E_PROVIDER_API_KEY, {
      timeout: 15000,
      timeoutMsg: "缺模型横幅没有打开 API Key provider 配置",
    });
    // API Key 在失焦时自动保存，不能等仍在编辑的草稿自行落盘。
    await browser.execute(
      (id) => document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)?.blur(),
      TID_MODEL_PROVIDER_API_KEY_INPUT,
    );
    const provider = await waitForSavedApiKeyProvider(providerId);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15000,
      timeoutMsg: "模型供应商设置页没有返回入口",
    });
    await waitForDefaultWorkspaceReady(30000);

    // Template 模型成员继承自 Registry，不复制进 Personal 的 personalModelIds。
    // 校验真实 Composer 选择的实例身份和非空模型，不能把 Personal 空模型列表当作未保存。
    await waitForHydratedDraftModel(provider.id);
    await waitForModelConfigMissingBannerCleared();
    // 修复原因：模型标签与横幅恢复不能证明提交门禁已解除；同时检查原文和按钮，
    // 防止设置页往返丢草稿或完整配置后仍禁发。只读此状态，不产生模型请求。
    await waitForV4ComposerText(blockedDraft, "保存 Provider 并返回后 composer 丢失原文");
    await browser.waitUntil(() => $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isEnabled(), {
      timeout: 15_000,
      timeoutMsg: "Provider 模型水合后发送按钮仍不可用",
    });
    expect(
      await browser.execute(() => window.localStorage.getItem("zcode-v4-pending-commands:v1")),
    ).toBeNull();

    await switchToElectronRendererTarget(isResourceManagerUrl);
    await waitForAgentProcessCount(1, { workspaceNameSuffix: "-zcodeproject" });

    // 修复原因：只读 sessions-index 已经启动 workspace CLI；provider 就绪只提升写能力，
    // 稳定窗口内仍只能有一个 Agent，防止 read→write 升级重复创建进程。
    await browser.pause(1500);
    expect(await countAgentProcessRows({ workspaceNameSuffix: "-zcodeproject" })).toBe(1);
  });
});

async function waitForProviderReadinessHistory() {
  const itemTestId = testId(TID_TASK_ITEM, PROVIDER_READINESS_HISTORY_SESSION_ID);
  await waitForTestIdByDom(itemTestId, {
    timeout: 30000,
    timeoutMsg: "provider 未就绪时预置 tasks-index 历史行没有出现在侧栏",
  });
  const title = await browser.execute((targetTestId) => {
    return document
      .querySelector<HTMLElement>(`[data-testid="${targetTestId}"]`)
      ?.innerText.replace(/\s+/g, " ")
      .trim();
  }, itemTestId);
  expect(title).toContain(PROVIDER_READINESS_HISTORY_TITLE);
}

async function clickModelSettingsFromMissingBanner() {
  await browser.waitUntil(
    () =>
      browser.execute((bannerTestId) => {
        const banner = document.querySelector<HTMLElement>(`[data-testid="${bannerTestId}"]`);
        const button = Array.from(banner?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
          (candidate) => candidate.querySelector("svg.lucide-settings"),
        );
        if (!button || button.disabled) return false;
        button.click();
        return true;
      }, TID_CHAT_ERROR_BANNER),
    {
      timeout: 15000,
      interval: 100,
      timeoutMsg: "缺模型横幅没有可用的模型配置入口",
    },
  );
}

async function createApiKeyProviderFromTemplate(): Promise<string> {
  // API Key 已从 Family 连接菜单迁移到 Template；每次创建都必须跟踪新的 Personal 身份。
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
  const existingIds = new Set((await readModelProviders()).map((provider) => provider.id));
  await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON);
  await clickTestIdByDom(
    testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel),
  );
  let providerId = "";
  await browser.waitUntil(
    async () => {
      providerId =
        (await readModelProviders()).find((provider) => !existingIds.has(provider.id))?.id ?? "";
      return Boolean(providerId);
    },
    { timeout: 15_000, timeoutMsg: "BigModel Template 没有创建 Personal Provider" },
  );
  await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${providerId}`));
  return providerId;
}

async function waitForSavedApiKeyProvider(providerId: string) {
  let latest = await readModelProvider(providerId);
  await browser.waitUntil(
    async () => {
      latest = await readModelProvider(providerId);
      const provider = latest;
      return provider?.apiKey === E2E_PROVIDER_API_KEY;
    },
    {
      timeout: 15000,
      interval: 250,
      timeoutMsg: "API Key 登录后没有保存结构可用的 BigModel provider/model",
    },
  );
  if (!latest) {
    throw new Error("API Key 登录后没有读取到 BigModel provider");
  }
  return latest;
}

async function waitForHydratedDraftModel(providerId: string) {
  await browser.waitUntil(
    async () => {
      const value = await browser.execute(
        (id) =>
          document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.dataset.modelCurrentValue ??
          "",
        TID_CHAT_MODEL_SELECT_TRIGGER,
      );
      // 主输入框仍使用共享 custom: 编码；不能把协议里的 provider/model 格式当作 UI 值。
      const selected = decodeCustomModelValue(value);
      return selected?.providerId === providerId && Boolean(selected.modelName);
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `等待中的 workspace 没有水合 Personal Provider ${providerId} 的模型`,
    },
  );
}

async function waitForModelConfigMissingBanner() {
  await waitForTestIdByDom(TID_CHAT_ERROR_BANNER, {
    timeout: 15000,
    timeoutMsg: "未配置模型的草稿首页没有展示 modelConfigMissing banner",
  });
  const errorCode = await browser.execute((testId) => {
    return document
      .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
      ?.getAttribute("data-error-code");
  }, TID_CHAT_ERROR_BANNER);
  expect(errorCode).toBe("model_config_missing");
}

async function waitForModelConfigMissingBannerCleared() {
  await browser.waitUntil(
    () =>
      browser.execute(
        (testId) => !document.querySelector(`[data-testid="${testId}"]`),
        TID_CHAT_ERROR_BANNER,
      ),
    {
      timeout: 15000,
      interval: 250,
      timeoutMsg: "草稿模型水合后 modelConfigMissing banner 没有清除",
    },
  );
}
