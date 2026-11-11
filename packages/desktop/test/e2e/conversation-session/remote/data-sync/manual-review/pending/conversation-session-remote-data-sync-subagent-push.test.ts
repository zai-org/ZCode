import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_PROMPT_SUGGESTION_OPTION,
  TID_PROMPT_SUGGESTION_PANEL,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  execInRemoteContainer,
  readRemoteContainerFile,
  readRemoteDockerContainer,
  writeRemoteContainerFile,
} from "#e2e/helpers/remote-docker-target";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// DSYNC-09：设置 → 数据同步 → 设备 → 推送子智能体（docs/remote/data-sync.md「子智能体」）。
// 子智能体经新同步通道 user-config-sync 按原文件字节推送；远端断言用 docker exec 读容器内 ~/.zcode/agents。
const CASE_MARKER = "E2E_DSYNC_09_SUBAGENT_PUSH";
const AGENT_NAME = "E2E-DSync-Agent";
const AGENT_KEY = AGENT_NAME.toLowerCase();
const AGENT_FILE = "e2e-dsync-agent.md";
const REMOTE_AGENTS = "/home/dev/.zcode/agents";
const DEPENDENCY_SKILL = "e2e-dsync-skill";
const DEPENDENCY_MCP = "e2e-dsync-mcp";
const DEPENDENCY_HINT = `远端缺少 MCP：${DEPENDENCY_MCP}；远端缺少技能：${DEPENDENCY_SKILL}`;
// DSYNC-09-02：推送后已打开远程项目的斜杠（/）建议要出现新子智能体（R6）。两个名称都匹配同一个查询。
// 子智能体候选只在 / 面板（SlashCommandPlugin → useSubagents），@ 面板不列子智能体。
const SLASH_AGENT_NAME = "E2E-DSync-Slash";
const SLASH_AGENT_KEY = SLASH_AGENT_NAME.toLowerCase();
const SLASH_AGENT_FILE = "e2e-dsync-slash.md";
const SLASH_QUERY = "/E2E-DSync";

// DSYNC-09-03：内置智能体的模型覆盖（票 20）作为子智能体分类的条目推送。同步不校验远端 Provider，
// 用例只断言行状态与远端状态文件，Provider 不需要在远端存在。
const EXPLORE_KEY = "built-in:built-in:explore";
const GENERAL_KEY = "built-in:built-in:general-purpose";
const REMOTE_STATE_FILE = "/home/dev/.zcode/v2/agents-state.json";
const OVERRIDE_PROVIDER = "e2e-dsync-provider";
const EXPLORE_LOCAL = {
  providerId: OVERRIDE_PROVIDER,
  modelId: "e2e-dsync-explore-model",
  options: { reasoningLevel: "high" },
};
const GENERAL_LOCAL = { providerId: OVERRIDE_PROVIDER, modelId: "e2e-dsync-general-local" };
const GENERAL_REMOTE = {
  providerId: OVERRIDE_PROVIDER,
  modelId: "e2e-dsync-general-remote",
  options: { reasoningLevel: "low" },
};
const GENERAL_REMOTE_CHANGED = {
  providerId: OVERRIDE_PROVIDER,
  modelId: "e2e-dsync-general-changed",
};
// 远端已有的其他字段：推送只改 builtInModelSelectionOverrides 中选中的项，这些必须原样保留。
const REMOTE_OTHER_FIELDS = {
  disabledAgentIds: ["user:user:e2e-dsync-remote-only"],
  pluginAgentModelSelectionOverrides: {
    "plugin:e2e-dsync@example:reviewer": {
      providerId: OVERRIDE_PROVIDER,
      modelId: "e2e-dsync-plugin-model",
    },
  },
  "x-e2e-marker": CASE_MARKER,
};

// 带模型、工具、技能、MCP、记忆和一个未知字段：表单保存会丢掉未知字段，按原文件同步必须原样保留。
// 依赖提示（票 12）：e2e-dsync-skill / e2e-dsync-mcp 只在本机用户列表中，容器里没有，应提示；
// e2e-dsync-builtin 两端用户列表都没有（等同内置或插件提供），不提示。提示不影响勾选和推送。
const AGENT_CONTENT = [
  "---",
  `name: ${AGENT_NAME}`,
  "description: Reviews data sync changes",
  "model: account:example-provider/example-model",
  "thoughtLevel: high",
  "tools: [Read, Grep, Glob]",
  `skills: [${DEPENDENCY_SKILL}, e2e-dsync-builtin]`,
  `mcpServers: [${DEPENDENCY_MCP}, e2e-dsync-builtin]`,
  "memory: user",
  `x-e2e-marker: ${CASE_MARKER} # keep comment`,
  "---",
  "Review the change carefully.",
  "",
].join("\n");

/** 本机用户级技能与 MCP：子智能体引用的依赖在本机存在，远端缺少时才提示。 */
async function writeLocalDependencies(home: string): Promise<void> {
  const skillDir = join(home, ".zcode", "skills", DEPENDENCY_SKILL);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${DEPENDENCY_SKILL}\ndescription: dependency for data sync e2e\n---\nBody\n`,
  );
  const cliDir = join(home, ".zcode", "cli");
  await mkdir(cliDir, { recursive: true });
  await writeFile(
    join(cliDir, "config.json"),
    `${JSON.stringify(
      { mcp: { servers: { [DEPENDENCY_MCP]: { command: "node", args: ["-e", "0"] } } } },
      null,
      2,
    )}\n`,
  );
}

async function readRowState(key: string) {
  return await browser.execute((rowTestId) => {
    const row = document.querySelector<HTMLButtonElement>(`[data-testid="${rowTestId}"]`);
    return row
      ? {
          status: row.dataset.syncStatus ?? null,
          checked: row.getAttribute("aria-checked"),
          text: row.textContent ?? "",
        }
      : null;
  }, `remote-sync-row-${key}`);
}

async function readRowTargetModel(key: string) {
  return await browser.execute(
    (testId) => document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null,
    `remote-sync-row-target-model-${key}`,
  );
}

async function readRowError(key: string) {
  return await browser.execute(
    (testId) => document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null,
    `remote-sync-row-error-${key}`,
  );
}

async function writeLocalAgentState(home: string, state: unknown): Promise<void> {
  const stateDir = join(home, ".zcode", "v2");
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "agents-state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

async function readRemoteAgentState(container: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readRemoteContainerFile(container, REMOTE_STATE_FILE)) as Record<
    string,
    unknown
  >;
}

async function readRowHint(key: string) {
  return await browser.execute(
    (hintTestId) => document.querySelector(`[data-testid="${hintTestId}"]`)?.textContent ?? null,
    `remote-sync-row-hint-${key}`,
  );
}

async function waitForRowHint(key: string, hint: string, timeoutMsg: string) {
  await browser.waitUntil(async () => (await readRowHint(key)) === hint, {
    timeout: 60_000,
    timeoutMsg: `${CASE_MARKER}: ${timeoutMsg}`,
  });
}

/** 设置 → 数据同步 → 唯一在线设备 → 打开同步弹窗。 */
async function openDataSyncDialog(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "dataSync"), {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 设置页没有数据同步分区`,
  });
  await waitForTestIdByDom("remote-sync-device-list", {
    timeout: 60_000,
    timeoutMsg: `${CASE_MARKER}: 数据同步页没有在线设备`,
  });
  await clickTestIdByDom("remote-sync-device-action");
  await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
}

/** 关闭同步弹窗和设置页，回到当前（远程）tab。 */
async function closeDataSyncDialogAndSettings(): Promise<void> {
  // 关闭按钮只在概览页底栏。
  await clickTestIdByDom("remote-sync-tab-overview", { timeout: 30_000 });
  await clickTestIdByDom("remote-sync-close", { timeout: 30_000 });
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 30_000 });
  await browser.waitUntil(
    async () => !(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed()),
    { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 设置页没有关闭` },
  );
}

/** 输入框建议面板中子智能体候选的文字；面板未打开时返回 null。 */
async function readSubagentSuggestions(): Promise<string[] | null> {
  return await browser.execute(
    (panelTestId, optionPrefix) => {
      if (!document.querySelector(`[data-testid="${panelTestId}"]`)) return null;
      return Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${optionPrefix}-"]`))
        .filter((option) => (option.dataset.optionId ?? "").startsWith("subagent:"))
        .map((option) => option.textContent ?? "");
    },
    TID_PROMPT_SUGGESTION_PANEL,
    TID_PROMPT_SUGGESTION_OPTION,
  );
}

/** 在当前远程项目的输入框输入 / 查询，等待子智能体候选包含 name。 */
async function waitForSubagentSuggestion(name: string, timeoutMsg: string): Promise<string[]> {
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, SLASH_QUERY, {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 远程项目没有可输入的输入框`,
  });
  let suggestions: string[] | null = null;
  await browser
    .waitUntil(
      async () => {
        suggestions = await readSubagentSuggestions();
        return Boolean(suggestions?.some((text) => text.includes(name)));
      },
      { timeout: 30_000, interval: 500 },
    )
    .catch((error: unknown) => {
      throw new Error(`${CASE_MARKER}: ${timeoutMsg}；当前候选=${JSON.stringify(suggestions)}`, {
        cause: error,
      });
    });
  return suggestions ?? [];
}

async function waitForRowStatus(key: string, status: string, timeoutMsg: string) {
  await browser.waitUntil(async () => (await readRowState(key))?.status === status, {
    timeout: 60_000,
    timeoutMsg: `${CASE_MARKER}: ${timeoutMsg}`,
  });
  return (await readRowState(key))!;
}

describe(`${CASE_MARKER}: 数据同步页推送子智能体`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DSYNC-09-01 推送带模型和工具配置的子智能体，远端文件字节与本机一致", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];

    const localHome = getE2EAppDataPaths().homeDir;
    const localAgents = join(localHome, ".zcode", "agents");
    await mkdir(localAgents, { recursive: true });
    await writeFile(join(localAgents, AGENT_FILE), AGENT_CONTENT);
    await writeLocalDependencies(localHome);

    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await connectSSHWorkspace({ caseMarker: CASE_MARKER, config, workspacePath });

    await openDataSyncDialog();

    // 概览有子智能体一行；进入分类页后该项为「推送」且默认勾选。
    await waitForTestIdByDom("remote-sync-overview-subagents", {
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: 概览没有子智能体一行`,
    });
    await clickTestIdByDom("remote-sync-tab-subagents");
    const row = await waitForRowStatus(AGENT_KEY, "push", "本机子智能体没有显示为「推送」");
    expect(row.checked).toBe("true");
    expect(row.text).toContain(AGENT_NAME);
    // MCP、技能分类加载完成后，行内合并显示本机有、远端缺少的依赖；两端都没有的不提示。
    // 提示不改变行状态与默认勾选。
    await waitForRowHint(AGENT_KEY, DEPENDENCY_HINT, "子智能体没有显示缺失依赖提示");
    expect((await readRowState(AGENT_KEY))?.checked).toBe("true");

    await clickTestIdByDom("remote-sync-push", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 推送子智能体按钮不可用`,
    });
    await waitForRowStatus(AGENT_KEY, "synced", "推送后子智能体没有变为「已同步」");
    // 依赖仍未推送：提示保留，且没有阻止推送。
    expect(await readRowHint(AGENT_KEY)).toBe(DEPENDENCY_HINT);

    const local = await readFile(join(localAgents, AGENT_FILE), "utf-8");
    expect(await readRemoteContainerFile(container, `${REMOTE_AGENTS}/${AGENT_FILE}`)).toBe(local);
    expect(local).toBe(AGENT_CONTENT);
  });

  it("DSYNC-09-02 推送后，已打开的远程项目输入 / 能看到新子智能体", async function () {
    this.timeout(10 * 60_000);
    const localAgents = join(getE2EAppDataPaths().homeDir, ".zcode", "agents");
    await writeFile(
      join(localAgents, SLASH_AGENT_FILE),
      `---\nname: ${SLASH_AGENT_NAME}\ndescription: ${CASE_MARKER} slash\n---\nSlash prompt.\n`,
    );

    // 先让远程项目的 / 建议加载并缓存：09-01 推送的子智能体在列，新子智能体还没有。
    await closeDataSyncDialogAndSettings();
    const before = await waitForSubagentSuggestion(
      AGENT_NAME,
      "已打开的远程项目 / 建议没有 09-01 推送的子智能体",
    );
    expect(before.some((text) => text.includes(SLASH_AGENT_NAME))).toBe(false);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "");

    await openDataSyncDialog();
    await clickTestIdByDom("remote-sync-tab-subagents", { timeout: 60_000 });
    const row = await waitForRowStatus(SLASH_AGENT_KEY, "push", "新子智能体没有显示为「推送」");
    expect(row.checked).toBe("true");
    await clickTestIdByDom("remote-sync-push", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 推送子智能体按钮不可用`,
    });
    await waitForRowStatus(SLASH_AGENT_KEY, "synced", "推送后新子智能体没有变为「已同步」");

    // 不重开项目：同一个远程项目的 / 建议直接出现新子智能体。
    await closeDataSyncDialogAndSettings();
    await waitForSubagentSuggestion(SLASH_AGENT_NAME, "推送后远程项目 / 建议没有新子智能体");
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "");
  });

  it("DSYNC-09-03 推送内置子智能体的模型覆盖，只改选中的覆盖并保留远端其他字段", async function () {
    this.timeout(10 * 60_000);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const localHome = getE2EAppDataPaths().homeDir;
    await writeLocalAgentState(localHome, {
      disabledAgentIds: [],
      builtInModelSelectionOverrides: { Explore: EXPLORE_LOCAL, "general-purpose": GENERAL_LOCAL },
      pluginAgentModelSelectionOverrides: {},
    });
    await writeRemoteContainerFile(
      container,
      REMOTE_STATE_FILE,
      `${JSON.stringify(
        {
          ...REMOTE_OTHER_FIELDS,
          builtInModelSelectionOverrides: { "general-purpose": GENERAL_REMOTE },
        },
        null,
        2,
      )}\n`,
    );

    await openDataSyncDialog();
    await clickTestIdByDom("remote-sync-tab-subagents", { timeout: 60_000 });
    // 只在本机有覆盖：「推送」默认勾选，说明行是本机的模型和推理档位。
    const explore = await waitForRowStatus(EXPLORE_KEY, "push", "Explore 覆盖没有显示为「推送」");
    expect(explore.checked).toBe("true");
    expect(explore.text).toContain("Explore");
    expect(explore.text).toContain("内置 · 模型 e2e-dsync-explore-model · 推理档位 high");
    // 两端不同：「差异」默认不勾选，说明下方显示远端当前的模型。
    const general = await waitForRowStatus(
      GENERAL_KEY,
      "difference",
      "general-purpose 覆盖没有显示为「差异」",
    );
    expect(general.checked).toBe("false");
    expect(general.text).toContain("内置 · 模型 e2e-dsync-general-local");
    expect(await readRowTargetModel(GENERAL_KEY)).toBe(
      "远端：e2e-dsync-general-remote · 推理档位 low",
    );
    expect(await readRowTargetModel(EXPLORE_KEY)).toBeNull();

    // 列表加载后远端又改了 general-purpose：覆盖返回冲突、不写入，Explore 照常新建。
    await clickTestIdByDom(`remote-sync-row-${GENERAL_KEY}`);
    await browser.waitUntil(async () => (await readRowState(GENERAL_KEY))?.checked === "true", {
      timeout: 10_000,
      timeoutMsg: `${CASE_MARKER}: general-purpose 行没有被勾选`,
    });
    await writeRemoteContainerFile(
      container,
      REMOTE_STATE_FILE,
      `${JSON.stringify(
        {
          ...REMOTE_OTHER_FIELDS,
          builtInModelSelectionOverrides: { "general-purpose": GENERAL_REMOTE_CHANGED },
        },
        null,
        2,
      )}\n`,
    );
    await clickTestIdByDom("remote-sync-push", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 推送子智能体按钮不可用`,
    });
    await waitForRowStatus(EXPLORE_KEY, "synced", "推送后 Explore 覆盖没有变为「已同步」");
    await browser.waitUntil(
      async () => (await readRowError(GENERAL_KEY)) === "远端已变化，请刷新后重试",
      { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: general-purpose 没有提示远端已变化` },
    );
    let remote = await readRemoteAgentState(container);
    expect(remote.builtInModelSelectionOverrides).toEqual({
      Explore: EXPLORE_LOCAL,
      "general-purpose": GENERAL_REMOTE_CHANGED,
    });
    // 推送后列表重新加载：差异行显示远端新的模型。
    await browser.waitUntil(
      async () => (await readRowTargetModel(GENERAL_KEY)) === "远端：e2e-dsync-general-changed",
      { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: 差异行没有显示远端新的模型` },
    );

    // 推送后刷新保留失败项的勾选，直接再次推送即覆盖远端；两行都「已同步」，远端其他字段原样保留。
    expect((await readRowState(GENERAL_KEY))?.checked).toBe("true");
    await clickTestIdByDom("remote-sync-push", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 推送子智能体按钮不可用`,
    });
    await waitForRowStatus(GENERAL_KEY, "synced", "覆盖后 general-purpose 没有变为「已同步」");
    expect(await readRowTargetModel(GENERAL_KEY)).toBeNull();
    remote = await readRemoteAgentState(container);
    expect(remote.builtInModelSelectionOverrides).toEqual({
      Explore: EXPLORE_LOCAL,
      "general-purpose": GENERAL_LOCAL,
    });
    expect(remote.disabledAgentIds).toEqual(REMOTE_OTHER_FIELDS.disabledAgentIds);
    expect(remote.pluginAgentModelSelectionOverrides).toEqual(
      REMOTE_OTHER_FIELDS.pluginAgentModelSelectionOverrides,
    );
    expect(remote["x-e2e-marker"]).toBe(CASE_MARKER);

    // 本机清除 Explore 覆盖（继承默认）：重开弹窗后不再列出 Explore，远端的覆盖不变。
    await writeLocalAgentState(localHome, {
      disabledAgentIds: [],
      builtInModelSelectionOverrides: { "general-purpose": GENERAL_LOCAL },
      pluginAgentModelSelectionOverrides: {},
    });
    await closeDataSyncDialogAndSettings();
    await openDataSyncDialog();
    await clickTestIdByDom("remote-sync-tab-subagents", { timeout: 60_000 });
    await waitForRowStatus(
      GENERAL_KEY,
      "synced",
      "重开弹窗后 general-purpose 没有显示为「已同步」",
    );
    expect(await readRowState(EXPLORE_KEY)).toBeNull();
    remote = await readRemoteAgentState(container);
    expect(remote.builtInModelSelectionOverrides).toEqual({
      Explore: EXPLORE_LOCAL,
      "general-purpose": GENERAL_LOCAL,
    });
  });

  it("DSYNC-09-04 列表加载后远端出现覆盖或状态文件损坏：新建返回冲突、不覆盖远端的值；损坏时覆盖项失败、文件不变", async function () {
    this.timeout(10 * 60_000);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const localHome = getE2EAppDataPaths().homeDir;
    const remoteWith = (overrides: Record<string, unknown>) =>
      `${JSON.stringify({ ...REMOTE_OTHER_FIELDS, builtInModelSelectionOverrides: overrides }, null, 2)}\n`;
    // 接 09-03：本机两项覆盖都有，远端只有 general-purpose（两端一致）。
    await writeLocalAgentState(localHome, {
      disabledAgentIds: [],
      builtInModelSelectionOverrides: { Explore: EXPLORE_LOCAL, "general-purpose": GENERAL_LOCAL },
      pluginAgentModelSelectionOverrides: {},
    });
    await writeRemoteContainerFile(
      container,
      REMOTE_STATE_FILE,
      remoteWith({ "general-purpose": GENERAL_LOCAL }),
    );
    await closeDataSyncDialogAndSettings();
    await openDataSyncDialog();
    await clickTestIdByDom("remote-sync-tab-subagents", { timeout: 60_000 });
    expect(
      (await waitForRowStatus(EXPLORE_KEY, "push", "Explore 没有显示为「推送」")).checked,
    ).toBe("true");
    await waitForRowStatus(GENERAL_KEY, "synced", "general-purpose 没有显示为「已同步」");

    // 列表加载后远端出现 Explore 覆盖：新建（createOnly）返回冲突，不覆盖远端的值。
    const exploreRemote = { providerId: OVERRIDE_PROVIDER, modelId: "e2e-dsync-explore-remote" };
    await writeRemoteContainerFile(
      container,
      REMOTE_STATE_FILE,
      remoteWith({ "general-purpose": GENERAL_LOCAL, Explore: exploreRemote }),
    );
    await clickTestIdByDom("remote-sync-push", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 推送子智能体按钮不可用`,
    });
    await browser.waitUntil(
      async () => (await readRowError(EXPLORE_KEY)) === "远端已变化，请刷新后重试",
      { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: Explore 新建冲突没有提示远端已变化` },
    );
    // 按内容比较：现有状态文件迁移会按固定顺序（Explore、general-purpose）重排这个 map 并重写文件。
    const remote = await readRemoteAgentState(container);
    expect(remote.builtInModelSelectionOverrides).toEqual({
      "general-purpose": GENERAL_LOCAL,
      Explore: exploreRemote,
    });
    expect(remote.disabledAgentIds).toEqual(REMOTE_OTHER_FIELDS.disabledAgentIds);
    // 推送后刷新：远端已有 Explore 覆盖，该行变为「差异」并显示远端的模型。
    await waitForRowStatus(EXPLORE_KEY, "difference", "冲突后 Explore 没有变为「差异」");
    await browser.waitUntil(
      async () => (await readRowTargetModel(EXPLORE_KEY)) === "远端：e2e-dsync-explore-remote",
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 冲突后差异行没有显示远端的模型` },
    );

    // 远端状态文件损坏：列表按没有覆盖处理（两项都是「推送」）；推送时这些项失败，文件原样保留。
    const corrupt = "{ not json\n";
    await writeRemoteContainerFile(container, REMOTE_STATE_FILE, corrupt);
    await closeDataSyncDialogAndSettings();
    await openDataSyncDialog();
    await clickTestIdByDom("remote-sync-tab-subagents", { timeout: 60_000 });
    await waitForRowStatus(EXPLORE_KEY, "push", "状态文件损坏时 Explore 没有显示为「推送」");
    await waitForRowStatus(
      GENERAL_KEY,
      "push",
      "状态文件损坏时 general-purpose 没有显示为「推送」",
    );
    await clickTestIdByDom("remote-sync-push", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 推送子智能体按钮不可用`,
    });
    for (const key of [EXPLORE_KEY, GENERAL_KEY]) {
      await browser.waitUntil(
        async () => {
          const error = await readRowError(key);
          return Boolean(error?.startsWith("同步失败：") && error.includes("is not valid JSON"));
        },
        { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: ${key} 没有提示状态文件损坏` },
      );
    }
    expect(await readRemoteContainerFile(container, REMOTE_STATE_FILE)).toBe(corrupt);
    // 同一 runner 里后续 spec 共用容器：恢复为没有状态文件，避免远端子智能体一直走内置回退。
    await execInRemoteContainer(container, ["rm", "-f", REMOTE_STATE_FILE]);
  });
});
