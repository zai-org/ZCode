import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeCustomModelValue, encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON,
  TID_MODEL_PROVIDER_MODEL_INPUT,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SUBAGENT_ROW,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  readAgentsState,
  readModelProvider,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  UPSTREAM_ALTERNATE_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
} from "#e2e/helpers/upstream-provider";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { sel } from "#e2e/helpers/selectors";
import { clickOpenScopeMenuOption } from "#e2e/helpers/settings-scope-menu";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const CASE_TIMEOUT_MS = 240_000;
const PRIMARY_MODEL = encodeCustomModelValue(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
const ALTERNATE_MODEL = encodeCustomModelValue(
  UPSTREAM_ALTERNATE_PROVIDER_ID,
  UPSTREAM_ALTERNATE_MODEL,
);
const USER_CREATED = {
  description: "User create reasoning persistence",
  model: PRIMARY_MODEL,
  name: "e2e-user-reasoning",
  systemPrompt: "Review user changes with the selected effort.",
  thoughtLevel: "high",
};
const USER_UPDATED = {
  description: "User edit reasoning persistence",
  model: ALTERNATE_MODEL,
  name: "e2e-user-reasoning-v2",
  systemPrompt: "Review updated user changes with the selected effort.",
  thoughtLevel: "high",
};
const WORKSPACE_CREATED = {
  description: "Workspace create reasoning persistence",
  model: ALTERNATE_MODEL,
  name: "e2e-workspace-reasoning",
  systemPrompt: "Review workspace changes with the selected effort.",
  thoughtLevel: "max",
};
const WORKSPACE_UPDATED = {
  description: "Workspace edit reasoning persistence",
  model: PRIMARY_MODEL,
  name: "e2e-workspace-reasoning-v2",
  systemPrompt: "Review updated workspace changes with the selected effort.",
  thoughtLevel: "high",
};
const USER_DEFAULT_UNTOUCHED = {
  description: "User catalog default remains implicit",
  model: PRIMARY_MODEL,
  name: "e2e-user-default-materialized",
  systemPrompt: "Materialize the catalog default reasoning level.",
};
const USER_REMOVED_MODEL = {
  description: "User removed model requires re-selection",
  model: PRIMARY_MODEL,
  name: "e2e-user-removed-model",
  systemPrompt: "Require selecting a model again without restoring its unavailable option.",
  thoughtLevel: "high",
};
const USER_AGENT_ROOT = join(resolveE2EStorageRoot(), "agents");
const PLUGIN_JUDGE_AGENT_NAME = "documents:visual-judge";
const PLUGIN_JUDGE_AGENT_ID = "plugin:documents@zcode-plugins-official:visual-judge";
const WORKSPACE_AGENT_ROOT = join(DEFAULT_WORKSPACE, ".zcode", "agents");
const SUBAGENT_FORM_SELECTOR = `form:has(input[type="text"]):has(${sel(
  TID_CHAT_MODEL_SELECT_TRIGGER,
)})`;

interface CustomAgentFixture {
  description: string;
  model: string;
  name: string;
  systemPrompt: string;
  thoughtLevel?: string;
}

describe("Settings subagent 创建/编辑文件持久化 E2E", () => {
  before(async function () {
    this.timeout(CASE_TIMEOUT_MS);

    // 模型选择控件和 Subagent 的 model overlay 都依赖已初始化的 Provider/Registry。
    await prepareV4ConversationE2E();
    await setRendererLocale("en-US");
    await openSubagentSettings();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SE-01: builtin、user 与 workspace 保存后写入精确 model/reasoning 配置", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await persistBuiltInOverrides();
    await createCustomAgent(USER_CREATED, USER_AGENT_ROOT);
    await editCustomAgent(USER_CREATED, USER_UPDATED, USER_AGENT_ROOT);

    await selectSubagentScope(DEFAULT_WORKSPACE);
    await createCustomAgent(WORKSPACE_CREATED, WORKSPACE_AGENT_ROOT);
    await editCustomAgent(WORKSPACE_CREATED, WORKSPACE_UPDATED, WORKSPACE_AGENT_ROOT);
  });

  it("SE-02: 切换模型时物化 catalog 默认档位", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await selectSubagentScope("user");

    const generalScope = sel(testId(TID_SUBAGENT_ROW, "general-purpose"));
    // 从已有显式覆盖切换到另一模型后，只观察默认档位，不触发 effort 控件。
    await selectModelInScope(generalScope, ALTERNATE_MODEL);
    await assertDisplayedThoughtLevel(generalScope, "Max");
    await waitForAgentsState(
      (state) =>
        readBuiltInModelValue(state, "general-purpose") === ALTERNATE_MODEL &&
        readBuiltInReasoningLevel(state, "general-purpose") === "max",
      "general-purpose 切换模型时没有物化 catalog 默认 effort",
    );

    await createCustomAgent(USER_DEFAULT_UNTOUCHED, USER_AGENT_ROOT);
  });

  it("SE-04: 内置官方插件 subagent 可见并按 agent id 持久化 model/effort 覆盖", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await selectSubagentScope("user");
    // 官方插件没有安装记录；真实 CLI seed 后，Settings 也必须发现相同的只读 profile。
    const judgeRowTestId = testId(TID_SUBAGENT_ROW, PLUGIN_JUDGE_AGENT_NAME);
    await waitForTestIdByDom(judgeRowTestId, {
      timeout: 30_000,
      timeoutMsg: "Settings 未列出 documents:visual-judge",
    });
    const cacheRoot = join(
      resolveE2EStorageRoot(),
      "cli",
      "plugins",
      "cache",
      "zcode-plugins-official",
      "documents",
    );
    const artifacts = await Promise.all(
      (await readdir(cacheRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = join(cacheRoot, entry.name, "agents", "visual-judge.md");
          return (await fileExists(path)) ? { path, content: await readFile(path, "utf8") } : null;
        }),
    );
    expect(artifacts.some(Boolean)).toBe(true);
    const scope = sel(judgeRowTestId);
    await selectModelInScope(scope, ALTERNATE_MODEL);
    const expectedSelection = {
      providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
      modelId: UPSTREAM_ALTERNATE_MODEL,
      options: { reasoningLevel: "max" },
    };
    await waitForAgentsState(
      (state) =>
        JSON.stringify(
          (state.pluginAgentModelSelectionOverrides as Record<string, unknown>)?.[
            PLUGIN_JUDGE_AGENT_ID
          ],
        ) === JSON.stringify(expectedSelection),
      "插件覆盖未完整保存或未使用新模型最高档",
    );
    // 改到非默认 high，避免只重复点击自动保存的 max 而冒充 effort 修改覆盖。
    await selectThoughtLevelInScope(scope, "high");
    expectedSelection.options.reasoningLevel = "high";
    await waitForAgentsState(
      (state) =>
        JSON.stringify(
          (state.pluginAgentModelSelectionOverrides as Record<string, unknown>)?.[
            PLUGIN_JUDGE_AGENT_ID
          ],
        ) === JSON.stringify(expectedSelection),
      "插件 effort 修改未保存",
    );
    const state = await readAgentsState();
    expect(state.pluginAgentModelOverrides).toBeUndefined();
    expect(state.pluginAgentThoughtLevelOverrides).toBeUndefined();
    await browser.execute(
      (id) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click(),
      judgeRowTestId,
    );
    expect(await $(SUBAGENT_FORM_SELECTOR).isExisting()).toBe(false);
    for (const artifact of artifacts) {
      if (artifact) expect(await readFile(artifact.path, "utf8")).toBe(artifact.content);
    }
  });

  it("SE-03: 删除已选模型后显示选择模型且不恢复候选", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await createCustomAgent(USER_REMOVED_MODEL, USER_AGENT_ROOT);
    const artifactPath = customAgentPath(USER_AGENT_ROOT, USER_REMOVED_MODEL.name);
    const artifactBeforeDelete = await readFile(artifactPath, "utf8");

    await deleteProviderModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    await openSubagentSettingsSection();
    await openCustomAgentForm(USER_REMOVED_MODEL.name);

    const form = $(SUBAGENT_FORM_SELECTOR);
    const modelTrigger = form.$(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
    const reasoningUnavailable = form.$('[data-subagent-thought-level-unavailable="true"]');
    const reasoningLoading = form.$('[data-subagent-thought-level-loading="true"]');
    await browser.waitUntil(
      async () =>
        (await modelTrigger.getAttribute("aria-label")) === "Select model" &&
        !(await form.$(sel(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER)).isExisting()) &&
        !(await reasoningUnavailable.isExisting()) &&
        !(await reasoningLoading.isExisting()),
      {
        timeout: 15_000,
        timeoutMsg: "已删除模型重新编辑时没有显示选择模型，或 reasoning effort 仍然可见",
      },
    );

    expect(await modelTrigger.getAttribute("data-model-current-value")).toBe(PRIMARY_MODEL);
    await modelTrigger.click();
    await $(
      sel(
        testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${UPSTREAM_ALTERNATE_PROVIDER_ID}`),
      ),
    ).waitForDisplayed({ timeout: 15_000 });
    expect(await $(sel(testId(TID_CHAT_MODEL_SELECT_ITEM, PRIMARY_MODEL))).isExisting()).toBe(
      false,
    );
    expect(await form.$('button[type="submit"]').isEnabled()).toBe(false);
    expect(await readFile(artifactPath, "utf8")).toBe(artifactBeforeDelete);
  });
});

async function openSubagentSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, {
    timeout: 15_000,
    timeoutMsg: "设置页没有渲染",
  });
  await openSubagentSettingsSection();
}

async function openSubagentSettingsSection() {
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "subagents"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有出现 subagents 分区入口",
  });
  await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, "general-purpose"));
  await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, "Explore"));
}

async function deleteProviderModel(providerId: string, modelId: string) {
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有出现模型供应商分区入口",
  });
  await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${providerId}`), {
    timeout: 15_000,
    timeoutMsg: `模型供应商导航没有出现 ${providerId}`,
  });

  const deleted = await browser.execute(
    (modelInputPrefix, deleteButtonPrefix, targetModelId) => {
      const input = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${modelInputPrefix}-"]`),
      ).find((candidate) => {
        const value =
          candidate instanceof HTMLInputElement ? candidate.value : candidate.textContent;
        return value?.trim() === targetModelId;
      });
      const inputTestId = input?.dataset.testid;
      const index = inputTestId?.slice(`${modelInputPrefix}-`.length);
      if (!index) return false;
      const deleteButton = document.querySelector<HTMLElement>(
        `[data-testid="${deleteButtonPrefix}-${index}"]`,
      );
      if (!deleteButton) return false;
      deleteButton.click();
      return true;
    },
    TID_MODEL_PROVIDER_MODEL_INPUT,
    TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON,
    modelId,
  );
  if (!deleted) {
    throw new Error(`没有找到待删除模型 ${providerId}/${modelId}`);
  }

  await browser.waitUntil(
    async () => {
      const provider = await readModelProvider(providerId);
      return Boolean(
        provider &&
        !provider.models.some((model) => {
          if (typeof model === "string") return model === modelId;
          return model.id === modelId && model.deleted !== true;
        }),
      );
    },
    {
      timeout: 15_000,
      timeoutMsg: `模型没有从供应商配置中删除 ${providerId}/${modelId}`,
    },
  );
}

async function persistBuiltInOverrides() {
  const generalScope = sel(testId(TID_SUBAGENT_ROW, "general-purpose"));
  const exploreScope = sel(testId(TID_SUBAGENT_ROW, "Explore"));

  await selectModelInScope(generalScope, PRIMARY_MODEL);
  await waitForAgentsState(
    (state) => readBuiltInModelValue(state, "general-purpose") === PRIMARY_MODEL,
    "general-purpose model 没有写入 agents-state.json",
  );
  // high 是非默认档；显式点击必须覆盖自动补全的 max，并形成持久化选择。
  await selectThoughtLevelInScope(generalScope, "high");
  await waitForAgentsState(
    (state) => readBuiltInReasoningLevel(state, "general-purpose") === "high",
    "general-purpose 显式默认 effort 没有写入 agents-state.json",
  );

  await selectModelInScope(exploreScope, ALTERNATE_MODEL);
  await waitForAgentsState(
    (state) => readBuiltInModelValue(state, "Explore") === ALTERNATE_MODEL,
    "Explore model 没有写入 agents-state.json",
  );
  // max 是另一个模型的 catalog 默认档，用不同模型覆盖同一回归边界。
  await selectThoughtLevelInScope(exploreScope, "max");
  await waitForAgentsState(
    (state) => readBuiltInReasoningLevel(state, "Explore") === "max",
    "Explore 显式默认 effort 没有写入 agents-state.json",
  );

  const finalState = await readAgentsState();
  expect(finalState.builtInModelSelectionOverrides).toEqual({
    Explore: {
      providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
      modelId: UPSTREAM_ALTERNATE_MODEL,
      options: { reasoningLevel: "max" },
    },
    "general-purpose": {
      providerId: UPSTREAM_PROVIDER_ID,
      modelId: UPSTREAM_MODEL,
      options: { reasoningLevel: "high" },
    },
  });
}

async function createCustomAgent(
  fixture: CustomAgentFixture,
  root: string,
  displayedThoughtLevel?: string,
) {
  const newButton = $('button[aria-label="New"]');
  await newButton.waitForClickable({
    timeout: 15_000,
    timeoutMsg: "Subagent New 按钮不可用",
  });
  await newButton.click();
  await $(SUBAGENT_FORM_SELECTOR).waitForDisplayed({
    timeout: 15_000,
    timeoutMsg: "Subagent 新建表单没有打开",
  });

  await fillCustomAgentForm(fixture);
  if (displayedThoughtLevel) {
    await assertDisplayedThoughtLevel(SUBAGENT_FORM_SELECTOR, displayedThoughtLevel);
  }
  await saveCustomAgentForm(fixture.name);
  await assertCustomAgentArtifact(root, fixture);
}

async function editCustomAgent(
  previous: CustomAgentFixture,
  next: CustomAgentFixture,
  root: string,
) {
  await openCustomAgentForm(previous.name);
  await fillCustomAgentForm(next);
  await saveCustomAgentForm(next.name);

  const previousPath = customAgentPath(root, previous.name);
  await browser.waitUntil(async () => !(await fileExists(previousPath)), {
    timeout: 15_000,
    timeoutMsg: `Subagent 重命名后旧文件仍存在: ${previousPath}`,
  });
  await assertCustomAgentArtifact(root, next);
}

async function openCustomAgentForm(name: string) {
  const rowTestId = testId(TID_SUBAGENT_ROW, name);
  await browser.waitUntil(
    () =>
      browser.execute((currentRowTestId) => {
        const row = document.querySelector<HTMLElement>(`[data-testid="${currentRowTestId}"]`);
        if (!row) return false;
        row.click();
        return true;
      }, rowTestId),
    {
      timeout: 15_000,
      timeoutMsg: `Subagent 行不可编辑: ${name}`,
    },
  );
  await $(SUBAGENT_FORM_SELECTOR).waitForDisplayed({
    timeout: 15_000,
    timeoutMsg: `Subagent 编辑表单没有打开: ${name}`,
  });
}

async function fillCustomAgentForm(fixture: CustomAgentFixture) {
  const form = $(SUBAGENT_FORM_SELECTOR);
  const textInputs = await form.$$('input[type="text"]');
  const nameInput = textInputs[0];
  const descriptionInput = textInputs[1];
  if (!nameInput || !descriptionInput) {
    throw new Error("Subagent 表单缺少名称或描述输入框");
  }
  await nameInput.setValue(fixture.name);
  await descriptionInput.setValue(fixture.description);
  await form.$("textarea").setValue(fixture.systemPrompt);

  await selectModelInScope(SUBAGENT_FORM_SELECTOR, fixture.model);
  if (fixture.thoughtLevel !== undefined) {
    await selectThoughtLevelInScope(SUBAGENT_FORM_SELECTOR, fixture.thoughtLevel);
  }
}

async function saveCustomAgentForm(name: string) {
  await $(SUBAGENT_FORM_SELECTOR).$('button[type="submit"]').click();
  await browser.waitUntil(async () => !(await $(SUBAGENT_FORM_SELECTOR).isExisting()), {
    timeout: 15_000,
    timeoutMsg: `Subagent 保存后表单没有关闭: ${name}`,
  });
  await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, name));
}

async function selectSubagentScope(scopeKey: string) {
  // 作用域标签包含设备名；使用稳定 key，避免显示文案变化导致菜单保持打开并污染后续用例。
  const trigger = $('[data-plugin-scope-trigger="true"]');
  await trigger.waitForClickable({ timeout: 15_000 });
  await trigger.click();
  await clickOpenScopeMenuOption(scopeKey, {
    timeoutMsg: `Subagent scope 菜单没有出现 ${scopeKey}`,
  });
  await browser.waitUntil(
    async () =>
      (await $('[data-plugin-scope-trigger="true"]').getAttribute("data-plugin-scope-key")) ===
      scopeKey,
    { timeout: 15_000, timeoutMsg: `Subagent scope 没有切换到 ${scopeKey}` },
  );
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
    { timeout: 15_000, timeoutMsg: `模型菜单没有出现 ${model}` },
  );
  await browser.execute((currentItemTestId) => {
    document.querySelector<HTMLElement>(`[data-testid="${currentItemTestId}"]`)?.click();
  }, itemTestId);
  await browser.waitUntil(
    async () => (await trigger.getAttribute("data-model-current-value")) === model,
    { timeout: 15_000, timeoutMsg: `模型控件没有切换到 ${model}` },
  );
}

async function selectThoughtLevelInScope(scope: string, thoughtLevel: string) {
  let selected = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const trigger = $(scope).$(sel(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER));
    await trigger.waitForClickable({
      timeout: 15_000,
      timeoutMsg: `reasoning effort 控件没有出现: ${scope}`,
    });
    await trigger.click();
    try {
      const item = $(sel(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, thoughtLevel)));
      await item.waitForClickable({ timeout: 3_000 });
      await item.click();
      selected = true;
      break;
    } catch {
      await browser.keys("Escape");
    }
  }
  if (!selected) {
    throw new Error(`reasoning effort 菜单没有出现 ${thoughtLevel}`);
  }
}

async function assertDisplayedThoughtLevel(scope: string, expectedLabel: string) {
  const trigger = $(scope).$(sel(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER));
  await trigger.waitForDisplayed({
    timeout: 15_000,
    timeoutMsg: `reasoning effort 默认档位没有出现: ${scope}`,
  });
  await browser.waitUntil(
    async () => (await trigger.getAttribute("aria-label")) === expectedLabel,
    {
      timeout: 15_000,
      timeoutMsg: `reasoning effort 没有展示 catalog 默认档位 ${expectedLabel}`,
    },
  );
}

async function assertCustomAgentArtifact(root: string, fixture: CustomAgentFixture) {
  const path = customAgentPath(root, fixture.name);
  const expected = expectedCustomAgentMarkdown(fixture);
  let latest = "";
  await browser.waitUntil(
    async () => {
      try {
        latest = await readFile(path, "utf8");
        return latest === expected;
      } catch {
        return false;
      }
    },
    {
      timeout: 15_000,
      timeoutMsg: `Subagent Markdown 与表单不一致: ${path}\n${latest}`,
    },
  );
  expect(latest).toBe(expected);
}

function expectedCustomAgentMarkdown(fixture: CustomAgentFixture) {
  const decoded = decodeCustomModelValue(fixture.model)!;
  return `---
name: "${fixture.name}"
description: "${fixture.description}"
color: yellow
model: ${decoded.providerId}/${decoded.modelName}
thoughtLevel: ${fixture.thoughtLevel ?? "max"}
injectAgentsMd: true
---

${fixture.systemPrompt}
`;
}

function customAgentPath(root: string, name: string) {
  return join(root, `${name.toLowerCase()}.md`);
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForAgentsState(
  predicate: (state: Record<string, unknown>) => boolean,
  timeoutMsg: string,
) {
  await browser.waitUntil(async () => predicate(await readAgentsState()), {
    timeout: 15_000,
    timeoutMsg,
  });
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

async function setRendererLocale(locale: "en-US") {
  const changed = await browser.execute((nextLocale) => {
    const actions = (window as typeof window & { __testActions?: Record<string, unknown> })
      .__testActions;
    const setLocale = actions?.setLocale;
    if (typeof setLocale !== "function") return false;
    (setLocale as (value: string) => void)(nextLocale);
    return true;
  }, locale);
  if (!changed) {
    throw new Error(`缺少 renderer locale test action: ${locale}`);
  }
}
