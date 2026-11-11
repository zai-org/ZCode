import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { decodeCustomModelValue, encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER,
  TID_SUBAGENT_ROW,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  readAgentsState,
  waitForTestIdByDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
} from "#e2e/helpers/upstream-capture";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
} from "#e2e/helpers/network-capture-proxy";
import {
  UPSTREAM_ALTERNATE_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
  UPSTREAM_ALTERNATE_PROVIDER_NAME,
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
} from "#e2e/helpers/upstream-provider";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import {
  restartIntoWorkspacePreservingProfile,
  seedPersistedModelSelection,
} from "#e2e/helpers/model-provider-restart";
import { waitForProviderConfigPolling } from "#e2e/helpers/provider-config-polling";
import { sel } from "#e2e/helpers/selectors";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const OVERRIDE_MODEL_VALUE = encodeCustomModelValue(
  UPSTREAM_ALTERNATE_PROVIDER_ID,
  UPSTREAM_ALTERNATE_MODEL,
);
const PRIMARY_MODEL_VALUE = encodeCustomModelValue(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
const CUSTOM_AGENT_NAME = "e2e-reasoning-reviewer";
const CUSTOM_AGENT_PATH = join(resolveE2EStorageRoot(), "agents", `${CUSTOM_AGENT_NAME}.md`);
const SUBAGENT_FORM_SELECTOR = `form:has(input[type="text"]):has(${sel(TID_CHAT_MODEL_SELECT_TRIGGER)})`;
const INVALID_EFFORT = "invalid-e2e";
// Bug 根因：child 与 parent 档位相同时，忽略 profile 并错误继承 parent 的回归也会通过。
// 三类 child 都用 high，parent 与目标模型默认均为 max，确保继承或默认回退都会被请求断言捕获。
const GENERAL_EFFORT = "high";
const EXPLORE_EFFORT = "high";
const CUSTOM_EFFORT = "high";
const PARENT_EFFORT = "max";
const GENERAL_PARENT_MARKER = "E2E_BUILT_IN_SUBAGENT_GENERAL_PARENT";
const GENERAL_CHILD_MARKER = "E2E_BUILT_IN_SUBAGENT_GENERAL_CHILD";
const GENERAL_CHILD_REPLY_TOKEN = "E2E_BUILT_IN_SUBAGENT_GENERAL_CHILD_OK";
const GENERAL_FINAL_TOKEN = "built-in-general-subagent-model-override-done";
const EXPLORE_PARENT_MARKER = "E2E_BUILT_IN_SUBAGENT_EXPLORE_PARENT";
const EXPLORE_CHILD_MARKER = "E2E_BUILT_IN_SUBAGENT_EXPLORE_CHILD";
const EXPLORE_CHILD_REPLY_TOKEN = "E2E_BUILT_IN_SUBAGENT_EXPLORE_CHILD_OK";
const EXPLORE_FINAL_TOKEN = "built-in-explore-subagent-model-override-done";
const CUSTOM_PARENT_MARKER = "E2E_CUSTOM_SUBAGENT_REASONING_PARENT";
const CUSTOM_CHILD_MARKER = "E2E_CUSTOM_SUBAGENT_REASONING_CHILD";
const CUSTOM_CHILD_REPLY_TOKEN = "E2E_CUSTOM_SUBAGENT_REASONING_CHILD_OK";
const CUSTOM_FINAL_TOKEN = "custom-subagent-reasoning-override-done";
describe("Subagent 模型与 reasoning effort 覆盖 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I20: Settings 保存 builtin/custom effort 后冷启动进入 child provider 请求", async function () {
    this.timeout(300000);

    await prepareV4ConversationE2E({ skipProvider: true });
    await setRendererLocale("en-US");
    await configureSubagentReasoningOverrides();
    await seedPersistedModelSelection({
      modelId: UPSTREAM_MODEL,
      providerId: UPSTREAM_PROVIDER_ID,
      reasoningLevel: PARENT_EFFORT,
    });
    // Todo 88：冷启动前模拟真实旧存储，不能只测 UI 已写好的新版结构。
    const state = await readAgentsState();
    const { builtInModelSelectionOverrides: _newSelections, ...rest } = state;
    await writeFile(
      join(resolveE2EStorageRoot(), "v2", "agents-state.json"),
      JSON.stringify({
        ...rest,
        builtInModelOverrides: {
          "general-purpose": OVERRIDE_MODEL_VALUE,
          Explore: OVERRIDE_MODEL_VALUE,
        },
        builtInThoughtLevelOverrides: {
          "general-purpose": GENERAL_EFFORT,
          Explore: EXPLORE_EFFORT,
        },
      }),
    );
    const customProfile = await readFile(CUSTOM_AGENT_PATH, "utf8");
    expect(customProfile).not.toContain("modelSelection:");
    await restartIntoWorkspacePreservingProfile();
    expect(await readFile(CUSTOM_AGENT_PATH, "utf8")).toBe(customProfile);
    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForProviderConfigPolling();

    await runSubagentScenario({
      childMarker: GENERAL_CHILD_MARKER,
      childReplyToken: GENERAL_CHILD_REPLY_TOKEN,
      effort: GENERAL_EFFORT,
      finalToken: GENERAL_FINAL_TOKEN,
      parentMarker: GENERAL_PARENT_MARKER,
      subagentType: "general-purpose",
    });
    await assertInitialChildModelMarker("live");

    const sessionId = (await getV4PaneSnapshot()).sessionId;
    if (!sessionId || sessionId === "draft") {
      throw new Error(`内置 subagent 模型 case 没有真实 sessionId: ${sessionId ?? "null"}`);
    }
    await reloadAppAndRestoreV4Session(sessionId);
    await assertInitialChildModelMarker("cold");

    const exploreChildRecord = await runSubagentScenario({
      childMarker: EXPLORE_CHILD_MARKER,
      childReplyToken: EXPLORE_CHILD_REPLY_TOKEN,
      effort: EXPLORE_EFFORT,
      finalToken: EXPLORE_FINAL_TOKEN,
      parentMarker: EXPLORE_PARENT_MARKER,
      subagentType: "Explore",
    });

    expect(readToolNamesFromCapture(exploreChildRecord.requestJson)).toEqual([
      "Bash",
      "Read",
      "TodoWrite",
      "WebFetch",
      "RespondToCoordinator",
    ]);

    await runSubagentScenario({
      childMarker: CUSTOM_CHILD_MARKER,
      childReplyToken: CUSTOM_CHILD_REPLY_TOKEN,
      effort: CUSTOM_EFFORT,
      finalToken: CUSTOM_FINAL_TOKEN,
      parentMarker: CUSTOM_PARENT_MARKER,
      subagentType: CUSTOM_AGENT_NAME,
    });
  });
});

async function configureSubagentReasoningOverrides() {
  expect(await readAgentsState()).toMatchObject({
    builtInModelSelectionOverrides: {
      Explore: {
        providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
        modelId: UPSTREAM_ALTERNATE_MODEL,
        options: { reasoningLevel: INVALID_EFFORT },
      },
      "general-purpose": {
        providerId: UPSTREAM_PROVIDER_ID,
        modelId: UPSTREAM_MODEL,
      },
    },
  });
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, {
    timeout: 15000,
    timeoutMsg: "设置页没有渲染",
  });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "subagents"), {
    timeout: 15000,
    timeoutMsg: "设置页没有出现 subagents 分区入口",
  });
  await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, "general-purpose"));
  await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, "Explore"));
  await waitForTestIdByDom(testId(TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER, "general-purpose"));
  await waitForTestIdByDom(testId(TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER, "Explore"));
  await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, CUSTOM_AGENT_NAME));

  await expectBuiltInModelValues({
    Explore: OVERRIDE_MODEL_VALUE,
    "general-purpose": PRIMARY_MODEL_VALUE,
  });
  await waitForExploreInvalidEffortError(
    "Select a reasoning effort supported by this model",
    "英文",
  );
  await setRendererLocale("zh-CN");
  await waitForExploreInvalidEffortError("请选择当前模型支持的推理档位", "中文");
  await setRendererLocale("en-US");
  await waitForExploreInvalidEffortError(
    "Select a reasoning effort supported by this model",
    "英文恢复",
  );

  await selectThoughtLevelInScope(sel(testId(TID_SUBAGENT_ROW, "Explore")), EXPLORE_EFFORT);
  await waitForAgentsState(
    (state) => readBuiltInReasoningLevel(state, "Explore") === EXPLORE_EFFORT,
    "Explore 合法 effort 没有写入 agents-state.json",
  );

  await selectModelInScope(sel(testId(TID_SUBAGENT_ROW, "general-purpose")), OVERRIDE_MODEL_VALUE);
  await waitForAgentsState(
    (state) =>
      readBuiltInModelValue(state, "general-purpose") === OVERRIDE_MODEL_VALUE &&
      readBuiltInReasoningLevel(state, "general-purpose") === "max",
    "general-purpose 主动切换模型后没有使用目标最高档位",
  );
  await selectThoughtLevelInScope(sel(testId(TID_SUBAGENT_ROW, "general-purpose")), GENERAL_EFFORT);
  await waitForAgentsState(
    (state) => readBuiltInReasoningLevel(state, "general-purpose") === GENERAL_EFFORT,
    "general-purpose effort 没有写入 agents-state.json",
  );

  expect(await readAgentsState()).toMatchObject({
    builtInModelSelectionOverrides: {
      Explore: {
        providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
        modelId: UPSTREAM_ALTERNATE_MODEL,
        options: { reasoningLevel: EXPLORE_EFFORT },
      },
      "general-purpose": {
        providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
        modelId: UPSTREAM_ALTERNATE_MODEL,
        options: { reasoningLevel: GENERAL_EFFORT },
      },
    },
  });

  await configureCustomSubagentReasoningOverride();
  await assertSettingsLayoutAcrossThemes();

  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "设置页返回按钮没有出现",
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
}

async function setRendererLocale(locale: "en-US" | "zh-CN") {
  const changed = await browser.execute((nextLocale) => {
    const actions = (
      window as typeof window & {
        __testActions?: Record<string, unknown>;
      }
    ).__testActions;
    const setLocale = actions?.setLocale;
    if (typeof setLocale !== "function") return false;
    (setLocale as (value: string) => void)(nextLocale);
    return true;
  }, locale);
  if (!changed) {
    throw new Error(`I20 缺少 renderer locale test action: ${locale}`);
  }
  await browser.waitUntil(
    async () =>
      browser.execute((expectedLocale) => {
        const actions = (
          window as typeof window & {
            __testActions?: Record<string, unknown>;
          }
        ).__testActions;
        const getLocale = actions?.getLocale;
        return typeof getLocale === "function" && getLocale() === expectedLocale;
      }, locale),
    {
      timeout: 15_000,
      timeoutMsg: `I20 renderer locale 没有切换到 ${locale}`,
    },
  );
}

async function waitForExploreInvalidEffortError(expectedText: string, localeLabel: string) {
  await browser.waitUntil(
    async () =>
      (await $(sel(testId(TID_SUBAGENT_ROW, "Explore"))).getText()).includes(expectedText),
    {
      timeout: 15_000,
      timeoutMsg: `workspace catalog 就绪后 Explore 没有显示${localeLabel}无效 effort 错误`,
    },
  );
}

async function configureCustomSubagentReasoningOverride() {
  const initialMarkdown = await readFile(CUSTOM_AGENT_PATH, "utf8");
  expect(initialMarkdown).toContain(`model: ${OVERRIDE_MODEL_VALUE}`);
  expect(initialMarkdown).toContain(`thoughtLevel: ${INVALID_EFFORT}`);

  await openCustomAgentForm();
  const form = $(SUBAGENT_FORM_SELECTOR);
  expect(await form.getText()).toMatch(
    /Select a reasoning effort supported by this model|请选择当前模型支持的推理档位/u,
  );
  // 非法历史档位会禁用保存按钮；强行点击只会触发 WebDriver 拦截，不能证明产品拒绝保存。
  expect(await form.$('button[type="submit"]').isEnabled()).toBe(false);
  expect(await form.isDisplayed()).toBe(true);
  expect(await readFile(CUSTOM_AGENT_PATH, "utf8")).toBe(initialMarkdown);

  await selectThoughtLevelInScope(SUBAGENT_FORM_SELECTOR, EXPLORE_EFFORT);
  await saveCustomAgentForm();
  await waitForCustomMarkdown((content) => {
    const selection = readCustomAgentSelection(content);
    return selection?.model === OVERRIDE_MODEL_VALUE && selection.reasoningLevel === EXPLORE_EFFORT;
  }, "custom 合法 effort 没有写入 Markdown");

  await openCustomAgentForm();
  await selectModelInScope(SUBAGENT_FORM_SELECTOR, PRIMARY_MODEL_VALUE);
  await assertThoughtOptionsAndSelectInScope(
    SUBAGENT_FORM_SELECTOR,
    ["off", "low", "high", "max"],
    [],
    "high",
  );
  await saveCustomAgentForm();
  // Todo 88：主动切换先选最高档 max，随后用户显式改成 high 并保存。
  const defaultEffortMarkdown = await waitForCustomMarkdown((content) => {
    const selection = readCustomAgentSelection(content);
    return selection?.model === PRIMARY_MODEL_VALUE && selection.reasoningLevel === "high";
  }, "custom 重新确认默认 effort 后没有写入 Markdown");
  expect(defaultEffortMarkdown).toContain("thoughtLevel: high");
  expect(defaultEffortMarkdown).not.toContain("modelSelection:");

  await openCustomAgentForm();
  await selectModelInScope(SUBAGENT_FORM_SELECTOR, OVERRIDE_MODEL_VALUE);
  await assertThoughtOptionsAndSelectInScope(
    SUBAGENT_FORM_SELECTOR,
    ["off", "low", "high", "max"],
    [],
    CUSTOM_EFFORT,
  );
  await saveCustomAgentForm();
  const finalMarkdown = await waitForCustomMarkdown((content) => {
    const selection = readCustomAgentSelection(content);
    return selection?.model === OVERRIDE_MODEL_VALUE && selection.reasoningLevel === CUSTOM_EFFORT;
  }, "custom 最终 model + effort 没有写入 Markdown");
  expect(finalMarkdown).toContain(`thoughtLevel: ${CUSTOM_EFFORT}`);
  expect(finalMarkdown).not.toContain("modelSelection:");
}

async function openCustomAgentForm() {
  const rowTestId = testId(TID_SUBAGENT_ROW, CUSTOM_AGENT_NAME);
  await browser.waitUntil(
    async () =>
      browser.execute((currentRowTestId) => {
        const row = document.querySelector<HTMLElement>(`[data-testid="${currentRowTestId}"]`);
        // 保存后的刷新会保留行，但暂时移除 role 和编辑事件；存在不代表已经可编辑。
        if (!row || row.getAttribute("role") !== "button") return false;
        // 编辑入口由整行承载；行内带 title 的按钮是删除，不能按 button[title] 定位。
        row.click();
        return true;
      }, rowTestId),
    { timeout: 15000, timeoutMsg: "custom subagent 行不可编辑" },
  );
  await $(SUBAGENT_FORM_SELECTOR).waitForDisplayed({
    timeout: 15000,
    timeoutMsg: "custom subagent 编辑表单没有打开",
  });
}

async function saveCustomAgentForm() {
  await $(SUBAGENT_FORM_SELECTOR).$('button[type="submit"]').click();
  await browser.waitUntil(async () => !(await $(SUBAGENT_FORM_SELECTOR).isExisting()), {
    timeout: 15000,
    timeoutMsg: "custom subagent 保存后表单没有关闭",
  });
  await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, CUSTOM_AGENT_NAME));
}

async function selectModelInScope(scope: string, model: string) {
  const decodedModel = decodeCustomModelValue(model);
  if (!decodedModel) {
    throw new Error(`E2E 仅支持选择 custom provider 模型: ${model}`);
  }
  const itemTestId = testId(TID_CHAT_MODEL_SELECT_ITEM, model);
  const groupTestId = testId(
    TID_CHAT_MODEL_SELECT_GROUP,
    `registry-provider:${decodedModel.providerId}`,
  );
  const trigger = $(scope).$(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await trigger.waitForClickable({ timeout: 15000 });
  await trigger.click();
  try {
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
      { timeout: 15000, timeoutMsg: `模型菜单没有出现 ${model}` },
    );
  } catch (error) {
    const candidates = await browser.execute(
      (itemPrefix, groupPrefix) =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
          .filter((element) => {
            const value = element.dataset.testid ?? "";
            return value.startsWith(itemPrefix) || value.startsWith(groupPrefix);
          })
          .map((element) => ({
            testId: element.dataset.testid ?? "",
            text: element.innerText.replace(/\s+/gu, " ").trim(),
          })),
      testId(TID_CHAT_MODEL_SELECT_ITEM, ""),
      testId(TID_CHAT_MODEL_SELECT_GROUP, ""),
    );
    throw new Error(`模型菜单没有出现 ${model}，当前候选: ${JSON.stringify(candidates)}`, {
      cause: error,
    });
  }
  const itemVisible = await browser.execute(
    (currentItemTestId) => Boolean(document.querySelector(`[data-testid="${currentItemTestId}"]`)),
    itemTestId,
  );
  if (!itemVisible) {
    await browser.execute((currentGroupTestId) => {
      const group = document.querySelector<HTMLElement>(`[data-testid="${currentGroupTestId}"]`);
      if (!group) {
        return;
      }
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
    { timeout: 15000, timeoutMsg: `模型菜单没有出现 ${model}` },
  );
  await browser.execute((currentItemTestId) => {
    document.querySelector<HTMLElement>(`[data-testid="${currentItemTestId}"]`)?.click();
  }, itemTestId);
  await browser.waitUntil(
    async () => (await trigger.getAttribute("data-model-current-value")) === model,
    { timeout: 15000, timeoutMsg: `模型控件没有切换到 ${model}` },
  );
}

async function selectThoughtLevelInScope(scope: string, thoughtLevel: string) {
  let selected = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const trigger = $(scope).$(sel(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER));
    await trigger.waitForClickable({
      timeout: 15000,
      timeoutMsg: `reasoning effort 控件没有出现: ${scope}`,
    });
    await trigger.click();
    try {
      const item = $(sel(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, thoughtLevel)));
      await item.waitForClickable({ timeout: 3000 });
      await item.click();
      selected = true;
      break;
    } catch {
      // Radix 菜单可能在 portal 重挂载时吞掉一次打开动作，关闭后有限重试。
      await browser.keys("Escape");
    }
  }
  if (!selected) {
    throw new Error(`reasoning effort 菜单没有出现 ${thoughtLevel}`);
  }
  const expectedLabels: Record<string, string[]> = {
    high: ["High", "高"],
    low: ["Low", "低"],
    max: ["Max", "最高"],
  };
  await browser.waitUntil(
    async () => {
      const currentTrigger = $(scope).$(sel(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER));
      const label = await currentTrigger.getAttribute("aria-label");
      return (expectedLabels[thoughtLevel] ?? [thoughtLevel]).includes(label ?? "");
    },
    {
      timeout: 15000,
      timeoutMsg: `reasoning effort 控件没有切换到 ${thoughtLevel}`,
    },
  );
}

async function assertThoughtOptionsAndSelectInScope(
  scope: string,
  expected: string[],
  excluded: string[],
  thoughtLevel: string,
) {
  const trigger = $(scope).$(sel(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER));
  await trigger.waitForClickable({ timeout: 15000 });
  await trigger.click();
  for (const level of expected) {
    await $(sel(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, level))).waitForDisplayed({
      timeout: 15000,
      timeoutMsg: `目标模型没有展示 reasoning effort ${level}`,
    });
  }
  for (const level of excluded) {
    expect(await $(sel(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, level))).isExisting()).toBe(
      false,
    );
  }
  const item = $(sel(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, thoughtLevel)));
  await item.waitForClickable({ timeout: 15000 });
  await item.click();
}

async function expectBuiltInModelValues(expected: Record<string, string>) {
  const values = await browser.execute(
    (entries, triggerPrefix) =>
      Object.fromEntries(
        entries.map(([name]) => {
          const element = document.querySelector<HTMLElement>(
            `[data-testid="${triggerPrefix}-${name}"]`,
          );
          return [name, element?.dataset.modelCurrentValue ?? null];
        }),
      ),
    Object.entries(expected),
    TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER,
  );
  expect(values).toEqual(expected);
}

async function waitForAgentsState(
  predicate: (state: Record<string, unknown>) => boolean,
  timeoutMsg: string,
) {
  await browser.waitUntil(async () => predicate(await readAgentsState()), {
    timeout: 15000,
    timeoutMsg,
  });
}

function readBuiltInSelection(state: Record<string, unknown>, agentName: string) {
  const map = state.builtInModelSelectionOverrides;
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return null;
  }
  const value = (map as Record<string, unknown>)[agentName];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readBuiltInModelValue(state: Record<string, unknown>, agentName: string) {
  const selection = readBuiltInSelection(state, agentName);
  return typeof selection?.providerId === "string" && typeof selection.modelId === "string"
    ? encodeCustomModelValue(selection.providerId, selection.modelId)
    : null;
}

function readBuiltInReasoningLevel(state: Record<string, unknown>, agentName: string) {
  const options = readBuiltInSelection(state, agentName)?.options;
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  const reasoningLevel = (options as Record<string, unknown>).reasoningLevel;
  return typeof reasoningLevel === "string" ? reasoningLevel : null;
}

async function waitForCustomMarkdown(predicate: (content: string) => boolean, timeoutMsg: string) {
  let latest = "";
  await browser.waitUntil(
    async () => {
      latest = await readFile(CUSTOM_AGENT_PATH, "utf8");
      return predicate(latest);
    },
    { timeout: 15000, timeoutMsg },
  );
  return latest;
}

function parseCustomAgentFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match?.[1]) {
    return {};
  }
  const parsed = parseYaml(match[1]) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function readCustomAgentSelection(content: string) {
  const frontmatter = parseCustomAgentFrontmatter(content);
  const value = frontmatter.model;
  if (typeof value !== "string") return null;
  const separator = value.indexOf("/");
  const decoded = decodeCustomModelValue(value);
  const providerId = decoded?.providerId ?? value.slice(0, separator);
  const modelId = decoded?.modelName ?? value.slice(separator + 1);
  if (!providerId || !modelId) return null;
  return {
    model: encodeCustomModelValue(providerId, modelId),
    reasoningLevel:
      typeof frontmatter.thoughtLevel === "string" ? frontmatter.thoughtLevel : undefined,
  };
}

async function assertSettingsLayoutAcrossThemes() {
  await assertSubagentControlRowsFit();
  try {
    await setRendererViewport(390, 844);
    for (const theme of ["zai-light", "zai-dark"] as const) {
      await setSettingsTheme(theme);
      await assertSubagentControlRowsFit();
    }
  } finally {
    await clearRendererViewport();
  }
}

async function assertSubagentControlRowsFit() {
  const result = await browser.execute(
    (rowPrefix, modelPrefix, thoughtTrigger, names) =>
      names.map((name) => {
        const row = document.querySelector<HTMLElement>(`[data-testid="${rowPrefix}-${name}"]`);
        const model = row?.querySelector<HTMLElement>(`[data-testid="${modelPrefix}-${name}"]`);
        const thought = row?.querySelector<HTMLElement>(`[data-testid="${thoughtTrigger}"]`);
        const modelRect = model?.getBoundingClientRect();
        const thoughtRect = thought?.getBoundingClientRect();
        const overlaps = Boolean(
          modelRect &&
          thoughtRect &&
          modelRect.left < thoughtRect.right &&
          modelRect.right > thoughtRect.left &&
          modelRect.top < thoughtRect.bottom &&
          modelRect.bottom > thoughtRect.top,
        );
        return {
          hasModel: Boolean(modelRect),
          hasThought: Boolean(thoughtRect),
          horizontalOverflow: Boolean(row && row.scrollWidth > row.clientWidth + 1),
          name,
          overlaps,
        };
      }),
    TID_SUBAGENT_ROW,
    TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER,
    TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
    ["general-purpose", "Explore"],
  );
  expect(result).toEqual([
    {
      hasModel: true,
      hasThought: true,
      horizontalOverflow: false,
      name: "general-purpose",
      overlaps: false,
    },
    {
      hasModel: true,
      hasThought: true,
      horizontalOverflow: false,
      name: "Explore",
      overlaps: false,
    },
  ]);
}

async function setSettingsTheme(theme: "zai-light" | "zai-dark") {
  const changed = await browser.execute((nextTheme) => {
    const actions = (window as typeof window & { __testActions?: Record<string, unknown> })
      .__testActions;
    const setTheme = actions?.setTheme;
    if (typeof setTheme !== "function") {
      return false;
    }
    (setTheme as (value: string) => void)(nextTheme);
    return true;
  }, theme);
  expect(changed).toBe(true);
  await browser.pause(100);
}

async function setRendererViewport(width: number, height: number) {
  await sendRendererEmulationCommand("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height,
    mobile: false,
    width,
  });
  await browser.waitUntil(
    async () => browser.execute((expectedWidth) => window.innerWidth === expectedWidth, width),
    { timeout: 10000, timeoutMsg: `renderer viewport 没有收敛到 ${width}px` },
  );
}

async function clearRendererViewport() {
  await sendRendererEmulationCommand("Emulation.clearDeviceMetricsOverride");
}

async function sendRendererEmulationCommand(method: string, params: Record<string, unknown> = {}) {
  const sent = await browser.electron.execute(
    async (electron, command, commandParams) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
      );
      if (!window) return false;
      const devtools = window.webContents.debugger;
      if (!devtools.isAttached()) devtools.attach("1.3");
      await devtools.sendCommand(command, commandParams);
      return true;
    },
    method,
    params,
  );
  expect(sent).toBe(true);
}

async function assertInitialChildModelMarker(stage: "cold" | "live") {
  const agentBlock = await waitForToolCallBlockByToolName("Agent", 30000);
  const sidePaneAction = await $(`[data-testid="${agentBlock.testId}"]`).$(
    `[data-testid^="${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-"]`,
  );
  await sidePaneAction.waitForDisplayed({
    timeout: 15000,
    timeoutMsg: `${stage} child 没有右侧会话入口`,
  });
  const actionTestId = await sidePaneAction.getAttribute("data-testid");
  const childSessionId = actionTestId?.slice(`${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-`.length);
  if (!actionTestId || !childSessionId) {
    throw new Error(`${stage} child 会话入口缺少 session id`);
  }

  // Bug 原因：Agent 摘要完成或冷恢复后会重挂载，首次查询得到的 WebDriver element
  // 可能在 click 前已经失效。每次按稳定 test id 重新定位，并以目标 child pane 可见
  // 作为完成条件，避免把“没有打开侧栏”误报成“冷恢复丢失模型 marker”。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await browser.execute(
      (blockTestId, actionId) => {
        document
          .querySelector<HTMLElement>(`[data-testid="${blockTestId}"] [data-testid="${actionId}"]`)
          ?.click();
      },
      agentBlock.testId,
      actionTestId,
    );
    try {
      await browser.waitUntil(
        () =>
          browser.execute(
            (expectedChildSessionId) =>
              Array.from(
                document.querySelectorAll<HTMLElement>(
                  `[data-session-id="${expectedChildSessionId}"]`,
                ),
              ).some((pane) => pane.offsetParent !== null),
            childSessionId,
          ),
        {
          timeout: 10000,
          timeoutMsg: `${stage} child conversation 没有在右侧面板打开`,
        },
      );
      break;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }

  const expectedZh = `正在使用 ${UPSTREAM_ALTERNATE_PROVIDER_NAME}/${UPSTREAM_ALTERNATE_MODEL}`;
  const expectedEn = `Using ${UPSTREAM_ALTERNATE_PROVIDER_NAME}/${UPSTREAM_ALTERNATE_MODEL}`;
  // cold pane 默认恢复到底部；timeline 使用虚拟列表时，首轮顶部 marker 可能尚未挂载。
  // 断言的是持久化后的首个模型事实，因此先滚到目标 child timeline 顶部再读取 DOM。
  await browser.execute((expectedChildSessionId) => {
    const pane = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-session-id="${expectedChildSessionId}"]`),
    ).find((candidate) => candidate.offsetParent !== null);
    pane?.querySelector<HTMLElement>('[data-v4-timeline-scroll="true"]')?.scrollTo({ top: 0 });
  }, childSessionId);
  try {
    await browser.waitUntil(
      async () => {
        const markers = await readVisibleModelMarkers();
        return markers.some(
          (marker) =>
            (marker.text === expectedZh || marker.text === expectedEn) && !marker.hasSwitchArrow,
        );
      },
      {
        timeout: 30000,
        timeoutMsg: `${stage} child 没有以无切换箭头的精简文案展示初始模型 ${UPSTREAM_ALTERNATE_MODEL}`,
      },
    );
  } catch (error) {
    const markers = await readVisibleModelMarkers();
    throw new Error(`${String(error)}; visibleModelMarkers=${JSON.stringify(markers)}`);
  }
}

async function readVisibleModelMarkers() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-marker-type="modelChange"]')).map(
      (marker) => ({
        hasSwitchArrow: marker.querySelector(".lucide-arrow-right-left") !== null,
        sessionId: marker.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId ?? null,
        text: (marker.innerText ?? "").trim(),
      }),
    ),
  );
}

async function reloadAppAndRestoreV4Session(sessionId: string) {
  // Bug 原因：raw reloadSession 只重建 WebDriver 协议 session，旧 Electron/Host/CLI
  // 可能仍在内存中；使用进程退出屏障才能证明 marker 来自 transcript cold hydration。
  await reloadElectronSessionSafely(browser);
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);
  await selectV4TaskById(sessionId);
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId,
    `CLI cold restart 后没有恢复 session ${sessionId}`,
    60000,
  );
}

async function runSubagentScenario(input: {
  childMarker: string;
  childReplyToken: string;
  effort: string;
  finalToken: string;
  parentMarker: string;
  subagentType: string;
}) {
  const marker = `${input.parentMarker}_${Date.now()}`;
  const prompt =
    `${marker}: Use the Agent tool with subagent_type "${input.subagentType}". ` +
    `Ask it to reply with exactly "${input.childReplyToken}". ` +
    `After the subagent returns, reply with exactly "${input.finalToken}" and no other text.`;

  await sendV4PromptAndWaitAccepted(
    prompt,
    marker,
    `${input.subagentType} 首发没有被 composer 接受`,
  );

  const childRecord = await waitForChildSubagentRequestCapture(input.childMarker);
  assertUpstreamRequestCapture(childRecord, {
    expectedText: input.childMarker,
    model: UPSTREAM_ALTERNATE_MODEL,
  });
  assertUpstreamThoughtLevelCapture(childRecord, input.effort);

  const parentContinuationRecord = await waitForParentContinuationRequestCapture(
    input.childReplyToken,
  );
  assertUpstreamRequestCapture(parentContinuationRecord, {
    expectedText: input.childReplyToken,
    model: UPSTREAM_MODEL,
  });
  assertUpstreamThoughtLevelCapture(parentContinuationRecord, PARENT_EFFORT);

  await waitForV4AssistantMessageContaining(input.finalToken);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    `${input.subagentType} 模型覆盖 case 完成后没有回到 idle`,
    90000,
  );

  const agentBlock = await waitForToolCallBlockByToolName("Agent");
  expect(agentBlock.status).toBe("completed");
  return childRecord;
}

async function waitForChildSubagentRequestCapture(childMarker: string) {
  let latestArtifact: E2ENetworkCaptureArtifact | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latestArtifact = await readCaptureArtifact();
        return Boolean(findChildSubagentRequest(latestArtifact, childMarker));
      },
      {
        timeout: 30000,
        timeoutMsg: `没有捕获到内置 subagent child 请求: ${childMarker}`,
      },
    );
  } catch (error) {
    throw new Error(
      `没有捕获到内置 subagent child 请求\n${JSON.stringify(
        summarizeRequestsContaining(latestArtifact, childMarker),
        null,
        2,
      )}`,
      { cause: error },
    );
  }

  const record = findChildSubagentRequest(latestArtifact, childMarker);
  if (!record) {
    throw new Error("内置 subagent child 请求在等待完成后仍不存在");
  }
  return record;
}

async function waitForParentContinuationRequestCapture(childReplyToken: string) {
  let latestArtifact: E2ENetworkCaptureArtifact | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latestArtifact = await readCaptureArtifact();
        return Boolean(findParentContinuationRequest(latestArtifact, childReplyToken));
      },
      {
        timeout: 30000,
        timeoutMsg: `没有捕获到 parent continuation 请求: ${childReplyToken}`,
      },
    );
  } catch (error) {
    throw new Error(
      `没有捕获到 parent continuation 请求\n${JSON.stringify(
        summarizeRequestsContaining(latestArtifact, childReplyToken),
        null,
        2,
      )}`,
      { cause: error },
    );
  }

  const record = findParentContinuationRequest(latestArtifact, childReplyToken);
  if (!record) {
    throw new Error("parent continuation 请求在等待完成后仍不存在");
  }
  return record;
}

async function readCaptureArtifact(): Promise<E2ENetworkCaptureArtifact | null> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) {
    return null;
  }
  try {
    return JSON.parse(await readFile(capturePath, "utf-8")) as E2ENetworkCaptureArtifact;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function findChildSubagentRequest(artifact: E2ENetworkCaptureArtifact | null, childMarker: string) {
  return (
    artifact?.records.find(
      (record) =>
        isUpstreamMessageRequest(record) &&
        record.status === "complete" &&
        captureContainsText(record.requestJson, childMarker) &&
        readModelFromCapture(record.requestJson) === UPSTREAM_ALTERNATE_MODEL,
    ) ?? null
  );
}

function findParentContinuationRequest(
  artifact: E2ENetworkCaptureArtifact | null,
  childReplyToken: string,
) {
  return (
    artifact?.records.findLast(
      (record) =>
        isUpstreamMessageRequest(record) &&
        record.status === "complete" &&
        latestUserToolResultContainsText(record.requestJson, childReplyToken) &&
        readModelFromCapture(record.requestJson) === UPSTREAM_MODEL,
    ) ?? null
  );
}

function latestUserToolResultContainsText(requestJson: unknown, expectedText: string) {
  if (!requestJson || typeof requestJson !== "object") {
    return false;
  }
  const messages = (requestJson as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return false;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    if ((message as { role?: unknown }).role !== "user") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    // Bug 原因：父输入本身也包含 child 回复 token，只搜整段 request 会把 compact
    // 或首轮请求当成 continuation；这里要求 token 真正来自最新 user/tool_result。
    return (
      Array.isArray(content) &&
      content.some(
        (part) =>
          part !== null &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "tool_result" &&
          captureContainsText(part, expectedText),
      )
    );
  }
  return false;
}

function summarizeRequestsContaining(
  artifact: E2ENetworkCaptureArtifact | null,
  expectedText: string,
) {
  return {
    records:
      artifact?.records
        .filter((record) => captureContainsText(record.requestJson, expectedText))
        .map((record) => ({
          model: readModelFromCapture(record.requestJson),
          path: record.path,
          status: record.status,
          statusCode: record.statusCode,
          tools: readToolNamesFromCapture(record.requestJson),
        })) ?? [],
  };
}

function isUpstreamMessageRequest(record: E2ENetworkCaptureRecord) {
  return (
    record.method === "POST" &&
    (record.path.includes("/messages") || record.path.includes("/chat/completions"))
  );
}

function readModelFromCapture(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const model = (value as { model?: unknown }).model;
  return typeof model === "string" ? model : null;
}

function readToolNamesFromCapture(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const tools = (value as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
        return null;
      }
      const name = (tool as { name?: unknown }).name;
      return typeof name === "string" ? name : null;
    })
    .filter((name): name is string => Boolean(name));
}

function captureContainsText(value: unknown, expected: string): boolean {
  if (typeof value === "string") {
    return value.includes(expected);
  }
  if (Array.isArray(value)) {
    return value.some((item) => captureContainsText(item, expected));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some((child) => captureContainsText(child, expected));
}
