import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  decodeCustomModelValue,
  encodeCustomModelValue,
  formatSubagentMarkdownModel,
} from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER,
  TID_SUBAGENT_ROW,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_MODEL_CONFIG,
  testId,
} from "@zcode/shared/test-ids";
import { selectCombinedComposerThoughtLevel } from "#e2e/helpers/composer-model-picker";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  readAgentsState,
  waitForTestIdByDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
} from "#e2e/helpers/network-capture-proxy";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  selectUpstreamProviderModelById,
} from "#e2e/helpers/upstream-provider";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import {
  restartIntoWorkspacePreservingProfile,
  seedPersistedModelSelection,
} from "#e2e/helpers/model-provider-restart";
import { sel } from "#e2e/helpers/selectors";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const PROVIDER_ID = "e2e-claude-runtime-catalog";
const PROVIDER_NAME = "Claude Runtime Catalog E2E";
const MODEL_ID = "claude-opus-4-8";
const MODEL_VALUE = encodeCustomModelValue(PROVIDER_ID, MODEL_ID);
const UPSTREAM_MODEL_VALUE = encodeCustomModelValue(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
// 选择器值是 `custom:provider:model`；落盘的 Markdown 用 provider/model，保存后按落盘格式断言。
const MARKDOWN_MODEL_VALUE = formatSubagentMarkdownModel({
  providerId: PROVIDER_ID,
  modelId: MODEL_ID,
});
const CUSTOM_AGENT_NAME = "e2e-claude-catalog-reviewer";
const CUSTOM_AGENT_PATH = join(resolveE2EStorageRoot(), "agents", `${CUSTOM_AGENT_NAME}.md`);
const SUBAGENT_FORM_SELECTOR = `form:has(input[type="text"]):has(${sel(TID_CHAT_MODEL_SELECT_TRIGGER)})`;
const THOUGHT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
// 档位表按低到高排列；最高档用于「主动选模型按最高档补全」的断言。
const HIGHEST_EFFORT = THOUGHT_LEVELS[THOUGHT_LEVELS.length - 1]!;
const INVALID_EFFORT = "invalid-e2e";
const PARENT_EFFORT = "low";
const GENERAL_EFFORT = "high";
const EXPLORE_EFFORT = "xhigh";
const CUSTOM_EFFORT = "medium";
const MODEL_OUTPUT_TOKEN_BUDGET = 32_000;
const REASONING_BUDGETS: Record<string, number> = {
  low: 4000,
  medium: 8000,
  high: 16000,
  xhigh: 31999,
};
const GENERAL_PARENT_MARKER = "E2E_CLAUDE_CATALOG_GENERAL_PARENT";
const GENERAL_CHILD_MARKER = "E2E_CLAUDE_CATALOG_GENERAL_CHILD";
const GENERAL_CHILD_REPLY_TOKEN = "E2E_CLAUDE_CATALOG_GENERAL_CHILD_OK";
const GENERAL_FINAL_TOKEN = "claude-catalog-general-done";
const EXPLORE_PARENT_MARKER = "E2E_CLAUDE_CATALOG_EXPLORE_PARENT";
const EXPLORE_CHILD_MARKER = "E2E_CLAUDE_CATALOG_EXPLORE_CHILD";
const EXPLORE_CHILD_REPLY_TOKEN = "E2E_CLAUDE_CATALOG_EXPLORE_CHILD_OK";
const EXPLORE_FINAL_TOKEN = "claude-catalog-explore-done";
const CUSTOM_PARENT_MARKER = "E2E_CLAUDE_CATALOG_CUSTOM_PARENT";
const CUSTOM_CHILD_MARKER = "E2E_CLAUDE_CATALOG_CUSTOM_CHILD";
const CUSTOM_CHILD_REPLY_TOKEN = "E2E_CLAUDE_CATALOG_CUSTOM_CHILD_OK";
const CUSTOM_FINAL_TOKEN = "claude-catalog-custom-done";

interface ModelIoRecord {
  error?: unknown;
  querySource?: unknown;
  request?: { body?: unknown };
  response?: unknown;
  sessionId?: unknown;
}

interface ModelIoMatch {
  body: Record<string, unknown>;
  sessionId: string;
}

describe("Subagent runtime reasoning catalog E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I68: Provider Registry 档位经 Settings 落盘并在三个 child 请求中生效", async function () {
    this.timeout(360000);

    await prepareV4ConversationE2E({ skipProvider: true });
    await selectUpstreamProviderModelById(MODEL_ID, {
      includePlainModelFallback: false,
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
    });
    await assertThoughtOptionsAndSelectInScope("body", THOUGHT_LEVELS, PARENT_EFFORT);

    await configureSubagentReasoningOverrides();
    await seedPersistedModelSelection({
      modelId: MODEL_ID,
      providerId: PROVIDER_ID,
      reasoningLevel: PARENT_EFFORT,
    });
    await restartIntoWorkspacePreservingProfile();
    await prepareV4ConversationE2E({ skipProvider: true });

    await runSubagentScenario({
      childMarker: GENERAL_CHILD_MARKER,
      childReplyToken: GENERAL_CHILD_REPLY_TOKEN,
      childEffort: GENERAL_EFFORT,
      finalToken: GENERAL_FINAL_TOKEN,
      parentMarker: GENERAL_PARENT_MARKER,
      subagentType: "general-purpose",
    });

    const exploreChildRecord = await runSubagentScenario({
      childMarker: EXPLORE_CHILD_MARKER,
      childReplyToken: EXPLORE_CHILD_REPLY_TOKEN,
      childEffort: EXPLORE_EFFORT,
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
      childEffort: CUSTOM_EFFORT,
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
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        options: { reasoningLevel: INVALID_EFFORT },
      },
      "general-purpose": {
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        options: { reasoningLevel: GENERAL_EFFORT },
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

  const generalScope = sel(testId(TID_SUBAGENT_ROW, "general-purpose"));
  await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, "general-purpose"));
  await assertThoughtOptionsAndSelectInScope(generalScope, THOUGHT_LEVELS, GENERAL_EFFORT);
  await assertNoGenericModelTooltip(generalScope);
  // 等 general-purpose 本行保存完整结束：先落盘，再等本行控件恢复可用。
  // 本行的写操作标记在写盘前设置、写后刷新结束的 finally 才移除，所以控件可用即保存与刷新都已完成；
  // 之后再操作 Explore，两行的写操作与刷新不重叠，不用固定等待。
  await waitForAgentsState(
    (state) => readBuiltInReasoningLevel(state, "general-purpose") === GENERAL_EFFORT,
    "general-purpose high effort 没有写入 agents-state.json",
  );
  await $(generalScope).$(sel(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER)).waitForEnabled({
    timeout: 15000,
    timeoutMsg: "general-purpose 保存后的列表刷新没有结束",
  });

  const exploreScope = sel(testId(TID_SUBAGENT_ROW, "Explore"));
  await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, "Explore"));
  expect(await $(exploreScope).getText()).toMatch(
    /Select a reasoning effort supported by this model|请选择当前模型支持的推理档位/u,
  );
  await assertThoughtLevelPlaceholder(exploreScope);
  await assertThoughtOptionsAndSelectInScope(exploreScope, THOUGHT_LEVELS, EXPLORE_EFFORT);
  await assertNoGenericModelTooltip(exploreScope);
  await waitForAgentsState(
    (state) => readBuiltInReasoningLevel(state, "Explore") === EXPLORE_EFFORT,
    "Explore xhigh effort 没有写入 agents-state.json",
  );

  await selectModelInScope(generalScope, UPSTREAM_MODEL_VALUE);
  // 主动选模型按 Registry 的最高档位补全并落盘（历史缺失/失效才留空等用户选）；
  // 上游模型的档位表由运行时 Registry 决定，这里断言「界面有值就落盘同一个值」这条不变量。
  const upstreamEffort = await waitForBuiltInEffortAfterModelSwitch(
    "general-purpose",
    UPSTREAM_MODEL_VALUE,
    "general-purpose 切换到上游模型后没有按 Registry 档位落盘",
  );
  await assertCurrentThoughtLabel(generalScope, upstreamEffort);
  await selectModelInScope(generalScope, MODEL_VALUE);
  await waitForAgentsState(
    (state) =>
      readBuiltInModelValue(state, "general-purpose") === MODEL_VALUE &&
      readBuiltInReasoningLevel(state, "general-purpose") === HIGHEST_EFFORT,
    "general-purpose 切回 Claude 后没有使用该模型最高档位，也不应恢复旧 effort",
  );
  await assertCurrentThoughtLabel(generalScope, HIGHEST_EFFORT);
  await selectThoughtLevelInScope(generalScope, GENERAL_EFFORT);
  await waitForAgentsState(
    (state) => readBuiltInReasoningLevel(state, "general-purpose") === GENERAL_EFFORT,
    "general-purpose high effort 没有写入 agents-state.json",
  );

  await configureCustomSubagentReasoningOverride();
  await assertBuiltInLayoutAcrossThemes();

  expect(await readAgentsState()).toMatchObject({
    builtInModelSelectionOverrides: {
      Explore: {
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        options: { reasoningLevel: EXPLORE_EFFORT },
      },
      "general-purpose": {
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        options: { reasoningLevel: GENERAL_EFFORT },
      },
    },
  });
  expect(parseCustomAgentFrontmatter(await readFile(CUSTOM_AGENT_PATH, "utf8"))).toMatchObject({
    model: MARKDOWN_MODEL_VALUE,
    thoughtLevel: CUSTOM_EFFORT,
  });

  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "设置页返回按钮没有出现",
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
}

async function configureCustomSubagentReasoningOverride() {
  const initialMarkdown = await readFile(CUSTOM_AGENT_PATH, "utf8");
  expect(initialMarkdown).toContain(`model: ${MODEL_VALUE}`);
  expect(initialMarkdown).toContain(`thoughtLevel: ${INVALID_EFFORT}`);

  await openCustomAgentForm();
  await assertThoughtLevelPlaceholder(SUBAGENT_FORM_SELECTOR);
  await assertNoGenericModelTooltip(SUBAGENT_FORM_SELECTOR);
  await assertCustomFormLayoutAcrossThemes();
  const form = $(SUBAGENT_FORM_SELECTOR);
  expect(await form.getText()).toMatch(
    /Select a reasoning effort supported by this model|请选择当前模型支持的推理档位/u,
  );
  // 非法历史档位会禁用保存按钮；强行点击只会触发 WebDriver 拦截，不能证明产品拒绝保存。
  expect(await form.$('button[type="submit"]').isEnabled()).toBe(false);
  expect(await form.isDisplayed()).toBe(true);
  expect(await readFile(CUSTOM_AGENT_PATH, "utf8")).toBe(initialMarkdown);

  await assertThoughtOptionsAndSelectInScope(SUBAGENT_FORM_SELECTOR, THOUGHT_LEVELS, CUSTOM_EFFORT);
  await saveCustomAgentForm();
  await waitForCustomMarkdown(
    (content) => parseCustomAgentFrontmatter(content).thoughtLevel === CUSTOM_EFFORT,
    "custom 合法 medium effort 没有写入 Markdown",
  );

  await openCustomAgentForm();
  await selectModelInScope(SUBAGENT_FORM_SELECTOR, UPSTREAM_MODEL_VALUE);
  await selectModelInScope(SUBAGENT_FORM_SELECTOR, MODEL_VALUE);
  await saveCustomAgentForm();
  // 与 builtin 行同一条口径：主动切换模型按该模型最高档位补全，不恢复切换前的旧 effort。
  const switchedMarkdown = await waitForCustomMarkdown((content) => {
    const frontmatter = parseCustomAgentFrontmatter(content);
    return (
      frontmatter.model === MARKDOWN_MODEL_VALUE && frontmatter.thoughtLevel === HIGHEST_EFFORT
    );
  }, "custom 切换模型后没有使用该模型最高档位");
  expect(switchedMarkdown).not.toContain(`thoughtLevel: ${CUSTOM_EFFORT}`);

  await openCustomAgentForm();
  await selectThoughtLevelInScope(SUBAGENT_FORM_SELECTOR, GENERAL_EFFORT);
  await selectThoughtLevelInScope(SUBAGENT_FORM_SELECTOR, CUSTOM_EFFORT);
  await saveCustomAgentForm();
  await waitForCustomMarkdown((content) => {
    const frontmatter = parseCustomAgentFrontmatter(content);
    return frontmatter.model === MARKDOWN_MODEL_VALUE && frontmatter.thoughtLevel === CUSTOM_EFFORT;
  }, "custom 最终 Claude model + medium effort 没有写入 Markdown");
}

async function openCustomAgentForm() {
  const rowTestId = testId(TID_SUBAGENT_ROW, CUSTOM_AGENT_NAME);
  await waitForTestIdByDom(rowTestId);
  await browser.waitUntil(
    async () =>
      browser.execute((currentRowTestId) => {
        const row = document.querySelector<HTMLElement>(`[data-testid="${currentRowTestId}"]`);
        if (!row) return false;
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
  if (!decodedModel) throw new Error(`E2E 仅支持选择 custom provider 模型: ${model}`);
  const itemTestId = testId(TID_CHAT_MODEL_SELECT_ITEM, model);
  const groupTestId = testId(
    TID_CHAT_MODEL_SELECT_GROUP,
    `registry-provider:${decodedModel.providerId}`,
  );
  const trigger = $(scope).$(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await trigger.waitForClickable({ timeout: 15000 });
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
    { timeout: 15000, timeoutMsg: `模型菜单没有出现 ${model}` },
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
          new MouseEvent(eventName, { bubbles: true, cancelable: true, view: window }),
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
    async () =>
      (await $(scope)
        .$(sel(TID_CHAT_MODEL_SELECT_TRIGGER))
        .getAttribute("data-model-current-value")) === model,
    { timeout: 15000, timeoutMsg: `模型控件没有切换到 ${model}` },
  );
}

async function assertThoughtOptionsAndSelectInScope(
  scope: string,
  levels: readonly string[],
  thoughtLevel: string,
) {
  if (scope === "body") {
    // 主输入框已合并模型和思考入口；Subagent 设置仍使用独立下拉框。
    await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).click();
    const slider = $('[data-testid="composer-thought-slider"]');
    await slider.waitForDisplayed({ timeout: 15000 });
    expect(JSON.parse((await slider.getAttribute("data-levels")) ?? "[]")).toEqual(levels);
    expect(await selectCombinedComposerThoughtLevel(thoughtLevel)).toBe(true);
    await expect($(sel(TID_V4_MODEL_CONFIG))).toHaveAttribute("data-thought", thoughtLevel);
    return;
  }
  const trigger = $(scope).$(sel(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER));
  await trigger.waitForClickable({
    timeout: 15000,
    timeoutMsg: `reasoning effort 控件没有出现: ${scope}`,
  });
  await trigger.click();
  for (const level of levels) {
    await $(sel(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, level))).waitForDisplayed({
      timeout: 15000,
      timeoutMsg: `reasoning effort 菜单没有出现 ${level}`,
    });
  }
  const item = $(sel(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, thoughtLevel)));
  await item.waitForClickable({ timeout: 15000 });
  await item.click();
  await assertCurrentThoughtLabel(scope, thoughtLevel);
}

async function selectThoughtLevelInScope(scope: string, thoughtLevel: string) {
  const trigger = $(scope).$(sel(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER));
  await trigger.waitForClickable({ timeout: 15000 });
  await trigger.click();
  const item = $(sel(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, thoughtLevel)));
  await item.waitForClickable({
    timeout: 15000,
    timeoutMsg: `reasoning effort 菜单没有出现 ${thoughtLevel}`,
  });
  await item.click();
  await assertCurrentThoughtLabel(scope, thoughtLevel);
}

async function assertCurrentThoughtLabel(scope: string, thoughtLevel: string) {
  const acceptedLabels: Record<string, string[]> = {
    low: ["low", "低"],
    medium: ["medium", "中"],
    high: ["high", "高"],
    xhigh: ["extra high", "极高"],
    // 修复原因：中文界面下 max 的 aria-label 是「最高」，旧表缺这一档只能匹配英文 max。
    max: ["max", "最高"],
  };
  await browser.waitUntil(
    async () => {
      const label = await $(scope)
        .$(sel(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER))
        .getAttribute("aria-label");
      return (acceptedLabels[thoughtLevel] ?? [thoughtLevel]).includes(
        (label ?? "").trim().toLowerCase(),
      );
    },
    { timeout: 15000, timeoutMsg: `reasoning effort 控件没有显示 ${thoughtLevel}` },
  );
}

/**
 * 非法历史 effort 的展示口径：Model Selection 把缺失和失效的 reasoning 统一按空值处理，
 * 控件显示占位、等用户重选，不回显磁盘上的原值。错误提示、保存禁用与原值不被改写由调用处断言。
 */
async function assertThoughtLevelPlaceholder(scope: string) {
  const placeholderLabels = ["select reasoning level", "选择思考档位"];
  await browser.waitUntil(
    async () => {
      const label = await $(scope)
        .$(sel(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER))
        .getAttribute("aria-label");
      return placeholderLabels.includes((label ?? "").trim().toLowerCase());
    },
    { timeout: 15000, timeoutMsg: "reasoning effort 控件没有显示待选择占位" },
  );
}

async function assertNoGenericModelTooltip(scope: string) {
  const trigger = $(scope).$(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await trigger.waitForDisplayed({ timeout: 15000 });
  expect((await trigger.getAttribute("aria-label"))?.trim().toLowerCase()).not.toBe("model");
  await trigger.moveTo();
  await browser.pause(700);
  const tooltipTexts = await browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="tooltip"]')).map((element) =>
      (element.innerText ?? "").trim(),
    ),
  );
  expect(tooltipTexts).not.toContain("Model");
  expect(tooltipTexts).not.toContain("模型");
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

/** 等到主动切换的模型落盘，并返回同时写入的档位；档位缺席视为未完成补全。 */
async function waitForBuiltInEffortAfterModelSwitch(
  agentName: string,
  modelValue: string,
  timeoutMsg: string,
): Promise<string> {
  await waitForAgentsState(
    (state) =>
      readBuiltInModelValue(state, agentName) === modelValue &&
      readBuiltInReasoningLevel(state, agentName) !== null,
    timeoutMsg,
  );
  const effort = readBuiltInReasoningLevel(await readAgentsState(), agentName);
  expect(effort).not.toBeNull();
  return effort!;
}

function readBuiltInSelection(state: Record<string, unknown>, agentName: string) {
  const map = state.builtInModelSelectionOverrides;
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
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
  try {
    await browser.waitUntil(
      async () => {
        latest = await readFile(CUSTOM_AGENT_PATH, "utf8");
        return predicate(latest);
      },
      { timeout: 15000, timeoutMsg },
    );
  } catch (error) {
    // 原文看着满足断言时，差异常在字段格式上（如 model 落盘为 provider/model）；带上解析结果直接比对。
    throw new Error(
      `${timeoutMsg}\n解析出的 frontmatter: ${JSON.stringify(parseCustomAgentFrontmatter(latest))}\n最后读取到的 Markdown:\n${latest}`,
      { cause: error },
    );
  }
  return latest;
}

function parseCustomAgentFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match?.[1]) return {};
  const parsed = parseYaml(match[1]) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

async function assertBuiltInLayoutAcrossThemes() {
  await assertBuiltInRowsFit();
  try {
    await setRendererViewport(390, 844);
    for (const theme of ["zai-light", "zai-dark"] as const) {
      await setSettingsTheme(theme);
      await assertBuiltInRowsFit();
    }
  } finally {
    await clearRendererViewport();
  }
}

async function assertBuiltInRowsFit() {
  const result = await browser.execute(
    (rowPrefix, modelPrefix, thoughtTrigger, names) =>
      names.map((name) => {
        const row = document.querySelector<HTMLElement>(`[data-testid="${rowPrefix}-${name}"]`);
        const model = row?.querySelector<HTMLElement>(`[data-testid="${modelPrefix}-${name}"]`);
        const thought = row?.querySelector<HTMLElement>(`[data-testid="${thoughtTrigger}"]`);
        const modelRect = model?.getBoundingClientRect();
        const thoughtRect = thought?.getBoundingClientRect();
        return {
          hasModel: Boolean(modelRect),
          hasThought: Boolean(thoughtRect),
          horizontalOverflow: Boolean(row && row.scrollWidth > row.clientWidth + 1),
          name,
          overlaps: Boolean(
            modelRect &&
            thoughtRect &&
            modelRect.left < thoughtRect.right &&
            modelRect.right > thoughtRect.left &&
            modelRect.top < thoughtRect.bottom &&
            modelRect.bottom > thoughtRect.top,
          ),
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

async function assertCustomFormLayoutAcrossThemes() {
  await assertCustomFormControlsFit();
  try {
    await setRendererViewport(390, 844);
    for (const theme of ["zai-light", "zai-dark"] as const) {
      await setSettingsTheme(theme);
      await assertCustomFormControlsFit();
    }
  } finally {
    await clearRendererViewport();
  }
}

async function assertCustomFormControlsFit() {
  const result = await browser.execute(
    (formSelector, modelTrigger, thoughtTrigger) => {
      const form = document.querySelector<HTMLElement>(formSelector);
      const model = form?.querySelector<HTMLElement>(`[data-testid="${modelTrigger}"]`);
      const thought = form?.querySelector<HTMLElement>(`[data-testid="${thoughtTrigger}"]`);
      const modelRect = model?.getBoundingClientRect();
      const thoughtRect = thought?.getBoundingClientRect();
      return {
        hasModel: Boolean(modelRect),
        hasThought: Boolean(thoughtRect),
        horizontalOverflow: Boolean(form && form.scrollWidth > form.clientWidth + 1),
        overlaps: Boolean(
          modelRect &&
          thoughtRect &&
          modelRect.left < thoughtRect.right &&
          modelRect.right > thoughtRect.left &&
          modelRect.top < thoughtRect.bottom &&
          modelRect.bottom > thoughtRect.top,
        ),
      };
    },
    SUBAGENT_FORM_SELECTOR,
    TID_CHAT_MODEL_SELECT_TRIGGER,
    TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  );
  expect(result).toEqual({
    hasModel: true,
    hasThought: true,
    horizontalOverflow: false,
    overlaps: false,
  });
}

async function setSettingsTheme(theme: "zai-light" | "zai-dark") {
  const changed = await browser.execute((nextTheme) => {
    const actions = (window as typeof window & { __testActions?: Record<string, unknown> })
      .__testActions;
    const setTheme = actions?.setTheme;
    if (typeof setTheme !== "function") return false;
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

async function runSubagentScenario(input: {
  childMarker: string;
  childReplyToken: string;
  childEffort: string;
  finalToken: string;
  parentMarker: string;
  subagentType: string;
}) {
  const parentMarker = `${input.parentMarker}_${Date.now()}`;
  const prompt =
    `${parentMarker}: Use the Agent tool with subagent_type "${input.subagentType}". ` +
    `Ask it to reply with exactly "${input.childReplyToken}". ` +
    `After the subagent returns, reply with exactly "${input.finalToken}" and no other text.`;

  await sendV4Prompt(prompt);
  await waitForV4ComposerText("", `${input.subagentType} 首发后输入框没有清空`);
  await waitForV4UserMessageContaining(parentMarker);
  const mainSessionId = (await getV4PaneSnapshot()).sessionId;
  if (!mainSessionId || mainSessionId === "draft") {
    throw new Error(`${input.subagentType} 没有真实 parent sessionId`);
  }

  const parentInitialRecord = await waitForParentInitialRequestCapture(parentMarker);
  assertClaudeReasoningRecord(parentInitialRecord, PARENT_EFFORT);
  const parentModelIo = await waitForSuccessfulModelIo({
    marker: parentMarker,
    sessionId: mainSessionId,
  });
  assertClaudeReasoningBody(parentModelIo.body, PARENT_EFFORT);
  expect(parentModelIo.sessionId).toBe(mainSessionId);

  const childRecord = await waitForChildSubagentRequestCapture(input.childMarker);
  assertClaudeReasoningRecord(childRecord, input.childEffort);
  const childModelIo = await waitForSuccessfulModelIo({
    marker: `${input.childMarker}:`,
    querySource: "subagent",
    sessionIdPrefix: "sess_subagent_",
  });
  assertClaudeReasoningBody(childModelIo.body, input.childEffort);
  expect(childModelIo.sessionId).toMatch(/^sess_subagent_/u);
  expect(childModelIo.sessionId).not.toBe(mainSessionId);

  const parentContinuationRecord = await waitForParentContinuationRequestCapture(
    input.childReplyToken,
  );
  assertClaudeReasoningRecord(parentContinuationRecord, PARENT_EFFORT);

  await waitForV4AssistantMessageContaining(input.finalToken);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    `${input.subagentType} runtime catalog case 完成后没有回到 idle`,
    90000,
  );
  const agentBlock = await waitForToolCallBlockByToolName("Agent");
  expect(agentBlock.status).toBe("completed");
  return childRecord;
}

function assertClaudeReasoningRecord(record: E2ENetworkCaptureRecord, effort: string) {
  expect(record.path).toContain("/messages");
  assertClaudeReasoningBody(asRecord(record.requestJson), effort);
}

function assertClaudeReasoningBody(body: Record<string, unknown>, effort: string) {
  expect(body.model).toBe(MODEL_ID);
  expect(body.max_tokens).toBe(expectedAnthropicMaxTokens(effort));
  expect(readNestedValue(body, ["thinking", "type"])).toBe("enabled");
  expect(readNestedValue(body, ["thinking", "budget_tokens"])).toBe(
    expectedAnthropicThinkingBudget(effort),
  );
  expect(readNestedValue(body, ["output_config", "effort"])).toBe(effort);
  expect(body.reasoning_effort).toBeUndefined();
}

function expectedAnthropicMaxTokens(effort: string): number {
  if (REASONING_BUDGETS[effort] === undefined) {
    throw new Error(`未知 Claude reasoning effort: ${effort}`);
  }
  // Bug 根因：失败日志里的 31,999 属于 thinking.budget_tokens，而不是
  // max_tokens。Anthropic 总输出上限仍保持 32K，只收敛内部思考预算来预留可见输出。
  return MODEL_OUTPUT_TOKEN_BUDGET;
}

function expectedAnthropicThinkingBudget(effort: string): number {
  const catalogBudget = REASONING_BUDGETS[effort];
  if (catalogBudget === undefined) {
    throw new Error(`未知 Claude reasoning effort: ${effort}`);
  }
  // Registry 只执行 Option Spec；夹具显式为可见输出保留 1 token，不依赖旧 catalog 补全。
  return catalogBudget;
}

async function waitForParentInitialRequestCapture(parentMarker: string) {
  return waitForCaptureRecord(
    (artifact) =>
      artifact?.records.find(
        (record) =>
          isMessageRequest(record) &&
          record.status === "complete" &&
          captureContainsText(record.requestJson, parentMarker) &&
          readModelFromCapture(record.requestJson) === MODEL_ID &&
          !captureContainsText(record.requestJson, "Generate a concise title") &&
          !latestUserMessageHasToolResult(record.requestJson),
      ) ?? null,
    `没有捕获到 parent 首轮请求: ${parentMarker}`,
  );
}

async function waitForChildSubagentRequestCapture(childMarker: string) {
  return waitForCaptureRecord(
    (artifact) =>
      artifact?.records.find(
        (record) =>
          isMessageRequest(record) &&
          record.status === "complete" &&
          captureContainsText(record.requestJson, `${childMarker}:`) &&
          readModelFromCapture(record.requestJson) === MODEL_ID,
      ) ?? null,
    `没有捕获到 child 请求: ${childMarker}`,
  );
}

async function waitForParentContinuationRequestCapture(childReplyToken: string) {
  return waitForCaptureRecord(
    (artifact) =>
      artifact?.records.findLast(
        (record) =>
          isMessageRequest(record) &&
          record.status === "complete" &&
          latestUserToolResultContainsText(record.requestJson, childReplyToken) &&
          readModelFromCapture(record.requestJson) === MODEL_ID,
      ) ?? null,
    `没有捕获到 parent continuation 请求: ${childReplyToken}`,
  );
}

async function waitForCaptureRecord(
  findRecord: (artifact: E2ENetworkCaptureArtifact | null) => E2ENetworkCaptureRecord | null,
  timeoutMsg: string,
): Promise<E2ENetworkCaptureRecord> {
  let matched: E2ENetworkCaptureRecord | null = null;
  await browser.waitUntil(
    async () => {
      matched = findRecord(await readCaptureArtifact());
      return Boolean(matched);
    },
    { timeout: 45000, timeoutMsg },
  );
  if (!matched) throw new Error(`${timeoutMsg}，等待完成后记录仍为空`);
  return matched as E2ENetworkCaptureRecord;
}

async function readCaptureArtifact(): Promise<E2ENetworkCaptureArtifact | null> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) return null;
  try {
    return JSON.parse(await readFile(capturePath, "utf8")) as E2ENetworkCaptureArtifact;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function waitForSuccessfulModelIo(input: {
  marker: string;
  querySource?: "main_turn" | "subagent";
  sessionId?: string;
  sessionIdPrefix?: string;
}): Promise<ModelIoMatch> {
  let matched: ModelIoMatch | null = null;
  await browser.waitUntil(
    async () => {
      for (const { line, record } of await readModelIoRecords()) {
        if (!line.includes(input.marker)) continue;
        if (
          record.error !== undefined ||
          record.response === undefined ||
          record.querySource !== (input.querySource ?? "main_turn") ||
          (input.sessionId !== undefined && record.sessionId !== input.sessionId) ||
          (input.sessionIdPrefix !== undefined &&
            (typeof record.sessionId !== "string" ||
              !record.sessionId.startsWith(input.sessionIdPrefix)))
        ) {
          continue;
        }
        const body = parseJsonObject(record.request?.body);
        if (!body || body.bodySource === "ai_sdk_options" || typeof record.sessionId !== "string") {
          continue;
        }
        matched = { body, sessionId: record.sessionId };
        return true;
      }
      return false;
    },
    { timeout: 45000, timeoutMsg: `没有找到成功的 model-io: ${input.marker}` },
  );
  if (!matched) throw new Error(`model-io 等待完成后仍为空: ${input.marker}`);
  return matched;
}

async function readModelIoRecords(): Promise<Array<{ line: string; record: ModelIoRecord }>> {
  const debugDir = join(resolveE2EStorageRoot(), "cli", "debug");
  const files = await readdir(debugDir).catch(() => []);
  const records: Array<{ line: string; record: ModelIoRecord }> = [];
  for (const file of files.filter(
    (name) => name.startsWith("model-io-") && name.endsWith(".jsonl"),
  )) {
    const content = await readFile(join(debugDir, file), "utf8").catch(() => "");
    for (const line of content.split("\n")) {
      const record = parseJsonObject(line) as ModelIoRecord | null;
      if (record) records.push({ line, record });
    }
  }
  return records;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parseJsonObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  const record = parseJsonObject(value);
  if (!record) throw new Error("provider capture requestJson 不是对象");
  return record;
}

function isMessageRequest(record: E2ENetworkCaptureRecord) {
  return record.method === "POST" && record.path.includes("/messages");
}

function readModelFromCapture(value: unknown) {
  const model = parseJsonObject(value)?.model;
  return typeof model === "string" ? model : null;
}

function latestUserMessageHasToolResult(requestJson: unknown) {
  const messages = parseJsonObject(requestJson)?.messages;
  if (!Array.isArray(messages)) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = parseJsonObject(messages[index]);
    if (message?.role !== "user") continue;
    return (
      Array.isArray(message.content) &&
      message.content.some((part) => parseJsonObject(part)?.type === "tool_result")
    );
  }
  return false;
}

function latestUserToolResultContainsText(requestJson: unknown, expectedText: string) {
  const messages = parseJsonObject(requestJson)?.messages;
  if (!Array.isArray(messages)) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = parseJsonObject(messages[index]);
    if (message?.role !== "user") continue;
    return (
      Array.isArray(message.content) &&
      message.content.some(
        (part) =>
          parseJsonObject(part)?.type === "tool_result" && captureContainsText(part, expectedText),
      )
    );
  }
  return false;
}

function readNestedValue(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    const record = parseJsonObject(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function readToolNamesFromCapture(value: unknown): string[] {
  const tools = parseJsonObject(value)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    const name = parseJsonObject(tool)?.name;
    return typeof name === "string" ? [name] : [];
  });
}

function captureContainsText(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value.includes(expected);
  if (Array.isArray(value)) return value.some((item) => captureContainsText(item, expected));
  const record = parseJsonObject(value);
  return record
    ? Object.values(record).some((child) => captureContainsText(child, expected))
    : false;
}
