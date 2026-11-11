import type { ModelSelectionView } from "@zcode/provider";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  decodeCustomModelValue,
  encodeCustomModelValue,
} from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_LOGIN_API_KEY_SKIP_BUTTON,
  TID_LOGIN_TRIGGER,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_OAUTH_LOGIN_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SUBAGENT_ROW,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, waitForTestIdByDom } from "#e2e/helpers/desktop-app";
import { UPSTREAM_MODEL, UPSTREAM_PROVIDER_ID } from "#e2e/helpers/upstream-provider";
import { sel } from "#e2e/helpers/selectors";
import { dismissOccupationOnboarding } from "#e2e/helpers/occupation-onboarding";

const CASE_TIMEOUT_MS = 240_000;
const CUSTOM_MODEL = encodeCustomModelValue(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
// 登录后的目录以当前内置配置的 GLM-5.3 为准，旧 release payload 不再定义模型成员。
const CODING_PLAN_MODEL = encodeCustomModelValue(
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  "GLM-5.3",
);
const GENERAL_PURPOSE_SCOPE = sel(testId(TID_SUBAGENT_ROW, "general-purpose"));

interface ModelCatalogSnapshot {
  models: Array<{
    defaultThoughtLevel: string | null;
    providerId: string | null;
    thoughtLevels: string[] | null;
    value: string;
  }>;
  status: string | null;
}

describe("BigModel 登录后 Subagent runtime catalog 滞后", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("AUTH-04 / BSM-19: 登录后 Coding Plan reasoning effort 应立即可用", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    const openExternalMock = await browser.electron.mock("shell", "openExternal");
    await openExternalMock.mockResolvedValue(undefined);

    const loginSurface = await waitForInitialLoginSurface();
    if (loginSurface === "workspace") {
      await openSubagentSettings();
      const seededRuntime = await waitForModelCatalogSeeded();
      expect(findCatalogModel(seededRuntime, UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL)).not.toBeNull();
      expect(
        findCatalogModel(
          seededRuntime,
          BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          "GLM-5.3",
        ),
      ).toBeNull();
      const runtimeBeforeLogin = await waitForModelCatalogReady();
      expect(
        findCatalogModel(runtimeBeforeLogin, UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL),
      ).not.toBeNull();
      expect(
        findCatalogModel(
          runtimeBeforeLogin,
          BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          "GLM-5.3",
        ),
      ).toBeNull();
      await startBigModelLoginFromSettings();
    } else {
      // 登录页已收敛为 Z.ai 单入口，BigModel 只保留在设置页连接。
      // 未登录时先通过 API Key 表单的「暂时跳过」进入工作区，再从设置页发起 BigModel 连接。
      await clickTestIdByDom(TID_LOGIN_USE_API_KEY_BUTTON, {
        timeout: 20_000,
        timeoutMsg: "登录页没有展示 API Key 入口",
      });
      await clickTestIdByDom(TID_LOGIN_API_KEY_SKIP_BUTTON, {
        timeout: 20_000,
        timeoutMsg: "API Key 表单没有展示暂时跳过入口",
      });
      await startBigModelLoginFromSettings();
    }

    const authorizationUrl = await waitForBigModelAuthorizationUrl(openExternalMock);
    const state = new URL(authorizationUrl).searchParams.get("state");
    expect(state).toBeTruthy();
    await deliverOAuthCallback(`zcode://oauth/callback?state=${state}&authCode=e2e-auth-code`);

    await waitForTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 60_000,
      timeoutMsg: "BigModel OAuth callback 后没有进入已登录工作区",
    });

    await openSubagentSettings();
    const runtimeAfterOAuth = await waitForModelCatalogSeeded();
    expect(
      findCatalogModel(runtimeAfterOAuth, UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL),
    ).not.toBeNull();
    const runtimeBeforeSelection = await waitForModelCatalogReady();
    expect(findCatalogModel(runtimeBeforeSelection, UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL)).toEqual(
      expect.objectContaining({ thoughtLevels: expect.arrayContaining(["high", "max"]) }),
    );
    await selectModelInScope(GENERAL_PURPOSE_SCOPE, CUSTOM_MODEL);
    await waitForReasoningControl("supported");

    try {
      await selectModelInScope(GENERAL_PURPOSE_SCOPE, CODING_PLAN_MODEL);
    } catch (error) {
      const requests = await readCodingPlanMockRequests().catch(() => []);
      throw new Error(
        `登录后 Subagent 模型菜单没有 Coding Plan; requests=${JSON.stringify(requests)}`,
        { cause: error },
      );
    }

    try {
      await waitForReasoningControl("supported");
    } catch (error) {
      const runtime = await readModelCatalogSnapshot();
      throw new Error(
        `登录后 Coding Plan reasoning effort 应立即可用；modelSelectionView=${JSON.stringify(runtime)}`,
        { cause: error },
      );
    }

    const runtimeAfterSelection = await readModelCatalogSnapshot();
    expect(runtimeAfterSelection.status).toBe("ready");
    expect(
      findCatalogModel(
        runtimeAfterSelection,
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        "GLM-5.3",
      ),
    ).toEqual(expect.objectContaining({ thoughtLevels: expect.arrayContaining(["high", "max"]) }));
  });
});

async function readCodingPlanMockRequests(): Promise<unknown[]> {
  const baseUrl = process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL?.trim();
  if (!baseUrl) {
    return [];
  }
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/requests`);
  const payload = (await response.json()) as { requests?: unknown[] };
  return payload.requests ?? [];
}

async function waitForInitialLoginSurface(): Promise<"welcome" | "workspace"> {
  let latest: {
    body: string;
    hasLoginTrigger: boolean;
    hasOAuthButton: boolean;
    testIds: string[];
  } | null = null;
  await browser.waitUntil(
    async () => {
      // 隔离 HOME 首次启动会先显示职业引导，不能把它误判成登录页未加载。
      if (await $('[data-testid="onboarding-page"]').isExisting()) {
        await dismissOccupationOnboarding();
        return false;
      }
      latest = await browser.execute(
        (oauthLoginButtonId, loginTriggerId) => {
          const hasOAuthButton = Boolean(
            document.querySelector(`[data-testid="${oauthLoginButtonId}"]`),
          );
          const hasLoginTrigger = Boolean(
            document.querySelector(`[data-testid="${loginTriggerId}"]`),
          );
          const testIds = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
            .map((element) => element.dataset.testid ?? "")
            .filter(Boolean)
            .slice(0, 60);
          return {
            body: document.body.textContent?.replace(/\s+/g, " ").trim().slice(0, 800) ?? "",
            hasLoginTrigger,
            hasOAuthButton,
            testIds,
          };
        },
        TID_OAUTH_LOGIN_BUTTON,
        TID_LOGIN_TRIGGER,
      );
      return latest.hasOAuthButton || latest.hasLoginTrigger;
    },
    {
      timeout: 60_000,
      timeoutMsg: `冷启动没有进入登录页或工作区: ${JSON.stringify(latest)}`,
    },
  );

  const hasOAuthButton = await browser.execute((oauthLoginButtonId) => {
    return Boolean(document.querySelector(`[data-testid="${oauthLoginButtonId}"]`));
  }, TID_OAUTH_LOGIN_BUTTON);
  return hasOAuthButton ? "welcome" : "workspace";
}

async function startBigModelLoginFromSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 20_000,
    timeoutMsg: "未登录工作区没有展示设置入口",
  });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, {
    timeout: 20_000,
    timeoutMsg: "没有打开设置页",
  });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 20_000,
    timeoutMsg: "设置页没有模型供应商分区入口",
  });
  await clickTestIdByDom(
    testId(TID_MODEL_PROVIDER_NAV_ITEM, `preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`),
    {
      timeout: 20_000,
      timeoutMsg: "模型供应商设置没有 BigModel Coding Plan 入口",
    },
  );

  let latestButtons: string[] = [];
  await browser.waitUntil(
    async () => {
      const result = await browser.execute(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
        const labels = buttons
          .map((button) => button.textContent?.replace(/\s+/g, " ").trim() ?? "")
          .filter(Boolean);
        const connectButton = buttons.find((button) => {
          const label = button.textContent?.replace(/\s+/g, " ").trim() ?? "";
          return /BigModel/iu.test(label) && /Connect|连接/iu.test(label) && !button.disabled;
        });
        connectButton?.click();
        return { clicked: Boolean(connectButton), labels };
      });
      latestButtons = result.labels;
      return result.clicked;
    },
    {
      timeout: 30_000,
      timeoutMsg: `BigModel Coding Plan 未登录卡片没有连接按钮: ${latestButtons.join(" / ")}`,
    },
  );
}

async function waitForBigModelAuthorizationUrl(
  openExternalMock: Awaited<ReturnType<typeof browser.electron.mock>>,
): Promise<string> {
  let authorizationUrl = "";
  await browser.waitUntil(
    async () => {
      await openExternalMock.update();
      authorizationUrl =
        openExternalMock.mock.calls
          .map((call) => call[0])
          .find(
            (value): value is string =>
              typeof value === "string" && value.includes("/login?") && value.includes("state="),
          ) ?? "";
      return Boolean(authorizationUrl);
    },
    {
      timeout: 15_000,
      timeoutMsg: "点击 BigModel 登录后没有捕获 openExternal OAuth URL",
    },
  );
  return authorizationUrl;
}

async function deliverOAuthCallback(callbackUrl: string): Promise<void> {
  const delivered = await browser.electron.execute((electron, url) => {
    electron.app.emit(
      "open-url",
      {
        preventDefault() {},
      } as never,
      url,
    );
    return true;
  }, callbackUrl);
  expect(delivered).toBe(true);
}

async function openSubagentSettings(): Promise<void> {
  const settingsPageOpen = await browser.execute((settingsPageId) => {
    return Boolean(document.querySelector(`[data-testid="${settingsPageId}"]`));
  }, TID_SETTINGS_PAGE);
  if (!settingsPageOpen) {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "登录后没有找到设置入口",
    });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, {
      timeout: 15_000,
      timeoutMsg: "登录后设置页没有渲染",
    });
  }
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "subagents"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有 Subagents 分区入口",
  });
  await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, "general-purpose"), {
    timeout: 15_000,
    timeoutMsg: "Subagents 页面没有 general-purpose 行",
  });
}

async function waitForModelCatalogReady(): Promise<ModelCatalogSnapshot> {
  let latest: ModelCatalogSnapshot = { models: [], status: null };
  await browser.waitUntil(
    async () => {
      latest = await readModelCatalogSnapshot();
      return (
        latest.status === "ready" &&
        findCatalogModel(latest, UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL) !== null
      );
    },
    {
      timeout: 60_000,
      timeoutMsg: `Local Host Model Selection View 未就绪或缺少自定义模型: ${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

async function waitForModelCatalogSeeded(): Promise<ModelCatalogSnapshot> {
  let latest: ModelCatalogSnapshot = { models: [], status: null };
  await browser.waitUntil(
    async () => {
      latest = await readModelCatalogSnapshot();
      return findCatalogModel(latest, UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL) !== null;
    },
    {
      timeout: 60_000,
      timeoutMsg: `登录前 Local Host Model Selection View 快照缺少自定义模型: ${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

async function readModelCatalogSnapshot(): Promise<ModelCatalogSnapshot> {
  return browser.execute(
    (rowId) => {
      type Fiber = {
        memoizedProps?: {
          modelSelectionView?: ModelSelectionView;
          modelCatalogStatus?: "ready" | "loading" | "unavailable";
        };
        return?: Fiber;
      };
      const row = document.querySelector(`[data-testid="${rowId}"]`);
      if (!row) return { models: [], status: null };
      const fiberKey = Object.keys(row).find((key) => key.startsWith("__reactFiber$"));
      let fiber = fiberKey ? (row as unknown as Record<string, Fiber>)[fiberKey] : undefined;
      // Settings 已由 Local Host View 驱动；旧 workspace configOptions 不再承载模型目录。
      // 只读页面实际消费的 props，不再人为写入 ready，避免掩盖登录后的刷新问题。
      while (fiber) {
        const props = fiber.memoizedProps;
        if (props?.modelSelectionView) {
          return {
            models: props.modelSelectionView.providers.flatMap((provider) =>
              provider.models.map((model) => ({
                defaultThoughtLevel: null,
                providerId: provider.providerId,
                thoughtLevels: [...(model.config.optionSpecs.reasoningLevel?.values ?? [])],
                value: `${provider.providerId}/${model.modelId}`,
              })),
            ),
            status: props.modelCatalogStatus ?? null,
          };
        }
        fiber = fiber.return;
      }
      return { models: [], status: null };
    },
    testId(TID_SUBAGENT_ROW, "general-purpose"),
  );
}

function findCatalogModel(
  snapshot: ModelCatalogSnapshot,
  providerId: string,
  modelId: string,
): ModelCatalogSnapshot["models"][number] | null {
  return (
    snapshot.models.find(
      (model) =>
        model.providerId === providerId &&
        (model.value === `${providerId}/${modelId}` || model.value.endsWith(`/${modelId}`)),
    ) ?? null
  );
}

async function selectModelInScope(scope: string, model: string): Promise<void> {
  const decodedModel = decodeCustomModelValue(model);
  if (!decodedModel) {
    throw new Error(`无法解析 Subagent E2E 模型值: ${model}`);
  }
  const itemTestId = testId(TID_CHAT_MODEL_SELECT_ITEM, model);
  const groupTestId = testId(
    TID_CHAT_MODEL_SELECT_GROUP,
    `registry-provider:${decodedModel.providerId}`,
  );
  const trigger = $(scope).$(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await trigger.waitForClickable({ timeout: 15_000 });
  await trigger.click();

  await browser.waitUntil(
    () =>
      browser.execute(
        (currentItemTestId, currentGroupTestId) =>
          Boolean(
            document.querySelector(`[data-testid="${currentItemTestId}"]`) ||
            document.querySelector(`[data-testid="${currentGroupTestId}"]`),
          ),
        itemTestId,
        groupTestId,
      ),
    { timeout: 15_000, timeoutMsg: `模型菜单没有出现 ${model}` },
  );

  const itemVisible = await browser.execute(
    (currentItemTestId) => Boolean(document.querySelector(`[data-testid="${currentItemTestId}"]`)),
    itemTestId,
  );
  if (!itemVisible) {
    await browser.execute((currentGroupTestId) => {
      const group = document.querySelector<HTMLElement>(`[data-testid="${currentGroupTestId}"]`);
      if (!group) return;
      group.focus();
      for (const eventName of ["pointerenter", "mouseenter", "mousemove"] as const) {
        group.dispatchEvent(
          new MouseEvent(eventName, {
            bubbles: true,
            cancelable: true,
            view: window,
          }),
        );
      }
      group.click();
    }, groupTestId);
  }
  await browser.waitUntil(
    () =>
      browser.execute(
        (currentItemTestId) =>
          Boolean(document.querySelector(`[data-testid="${currentItemTestId}"]`)),
        itemTestId,
      ),
    { timeout: 15_000, timeoutMsg: `模型菜单没有展开到目标项 ${model}` },
  );
  await browser.execute((currentItemTestId) => {
    document.querySelector<HTMLElement>(`[data-testid="${currentItemTestId}"]`)?.click();
  }, itemTestId);
  await browser.waitUntil(
    async () => (await trigger.getAttribute("data-model-current-value")) === model,
    { timeout: 15_000, timeoutMsg: `Subagent 模型没有切换到 ${model}` },
  );
}

async function waitForReasoningControl(expected: "supported" | "unavailable"): Promise<string> {
  let latest = { label: "", loading: false, supported: false, unavailable: false };
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (scope, thoughtTriggerTestId) => {
          const row = document.querySelector<HTMLElement>(scope);
          const unavailable = row?.querySelector<HTMLElement>(
            '[data-subagent-thought-level-unavailable="true"]',
          );
          return {
            label: unavailable?.getAttribute("aria-label") ?? unavailable?.innerText.trim() ?? "",
            loading: Boolean(row?.querySelector('[data-subagent-thought-level-loading="true"]')),
            supported: Boolean(row?.querySelector(`[data-testid="${thoughtTriggerTestId}"]`)),
            unavailable: Boolean(unavailable),
          };
        },
        GENERAL_PURPOSE_SCOPE,
        TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
      );
      return expected === "supported"
        ? latest.supported && !latest.loading && !latest.unavailable
        : latest.unavailable && !latest.loading && !latest.supported;
    },
    {
      timeout: 15_000,
      timeoutMsg: `reasoning 控件没有进入 ${expected}: ${JSON.stringify(latest)}`,
    },
  );
  return latest.label;
}
