import { type AppToolSearchMode } from "@zcode/shared";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_TOOL_SEARCH_SELECT,
  TID_SETTINGS_TOOL_SEARCH_OPTION,
  TID_TASK_SETTINGS_BUTTON,
  TID_TOOL_SUMMARY_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getActiveWorkspacePath,
  readSettings,
} from "#e2e/helpers/desktop-app";
import { restartIntoWorkspaceRestoringPreferences } from "#e2e/helpers/model-provider-restart-runtime";
import {
  getV4PaneSnapshot,
  selectV4TaskById,
  switchV4Model,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  setupToolSearchDesktop,
  newToolSearchTask,
  toolSearchTurn,
  expectToolSearchDisabled,
  expectToolSearchLoaded,
  expectToolSearchUnloaded,
  expectToolResultPair,
  TOOLSEARCH_MODEL,
  TOOLSEARCH_PLAIN_PROVIDER,
  TOOLSEARCH_PLAN_PROVIDER,
} from "#e2e/helpers/toolsearch-desktop";
import {
  toolSearchBlocks,
  TOOLSEARCH_DEFERRED_TOOL,
  type ToolSearchRecord,
} from "#e2e/helpers/toolsearch-provider";
import { waitForFoldedToolCallBlockByToolCallId } from "#e2e/helpers/conversation-session-tool";

describe("ToolSearch Settings 的启动与恢复策略", () => {
  before(async () => setupToolSearchDesktop());
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("TS11: 三值设置、Auto provider 分支、Local 执行、热会话固定及冷恢复", async function () {
    this.timeout(360_000);
    await newToolSearchTask();
    await openSettings();
    expect(await browser.$(`[data-testid="${TID_SETTINGS_TOOL_SEARCH_SELECT}"]`).getText()).toMatch(
      /^(关闭|Off)$/u,
    );
    expect((await readSettings()).toolSearchMode ?? "off").toBe("off");
    const select = await browser.$(`[data-testid="${TID_SETTINGS_TOOL_SEARCH_SELECT}"]`);
    const notice = await select.$("./ancestor::div[contains(@class, 'border-t')][1]/div[last()]/p");
    await notice.scrollIntoView();
    await notice.waitForDisplayed({ timeout: 10_000 });
    expect(await notice.getText()).toMatch(
      /实验性功能。.*原生 ToolSearch.*缓存失效.*Token 用量|Experimental feature\..*native ToolSearch.*prompt caching.*token usage/u,
    );
    expect(await notice.getLocation("y")).toBeGreaterThanOrEqual(
      (await select.getLocation("y")) + (await select.getSize("height")),
    );
    await closeSettings();
    const [off] = await toolSearchTurn("E2E_TOOLSEARCH_SETTINGS_DEFAULT 检查默认模式。");
    expectToolSearchDisabled(off!);
    const offSession = (await getV4PaneSnapshot()).sessionId!;

    await setMode("auto", offSession);
    const [stillOff] = await toolSearchTurn("E2E_TOOLSEARCH_SETTINGS_ACTIVE 当前会话不热更新。");
    expectToolSearchDisabled(stillOff!);
    await newToolSearchTask();
    const native = await toolSearchTurn(
      `E2E_TOOLSEARCH_SETTINGS_SEARCH 搜索 ${TOOLSEARCH_DEFERRED_TOOL} 并读取。`,
    );
    expect(native).toHaveLength(3);
    expectToolSearchUnloaded(native[0]!);
    expectToolSearchLoaded(native[1]!);
    expectSuccessfulTodo(native[2]!);
    await expectSearchSummary();
    const autoSession = (await getV4PaneSnapshot()).sessionId!;

    await switchV4Model(TOOLSEARCH_PLAIN_PROVIDER, TOOLSEARCH_MODEL, "");
    const [autoLocal] = await toolSearchTurn(
      "E2E_TOOLSEARCH_SETTINGS_PLAIN 普通 provider 使用本地搜索。",
    );
    expectLocal(autoLocal!);
    expect(JSON.stringify(autoLocal!.requestJson.messages)).toContain("<functions>");
    await switchV4Model(TOOLSEARCH_PLAN_PROVIDER, TOOLSEARCH_MODEL, "");

    await setMode("local", autoSession);
    const [stillAuto] = await toolSearchTurn(
      "E2E_TOOLSEARCH_SETTINGS_ACTIVE_AUTO 当前策略仍为 Auto。",
    );
    expectToolSearchLoaded(stillAuto!);
    await newToolSearchTask();
    const local = await toolSearchTurn(
      "E2E_TOOLSEARCH_SETTINGS_SEARCH 搜索后通过包装入口记录完成。",
    );
    expect(local).toHaveLength(3);
    for (const request of local) {
      expectLocal(request);
      expect(request.requestJson.tools).toEqual(local[0]!.requestJson.tools);
    }
    expect(JSON.stringify(local[1]!.requestJson.messages)).toContain("<functions>");
    expectSuccessfulTodo(local[2]!);
    await expectSearchSummary();
    expect(toolSearchBlocks(local[2]!.requestJson)).toContainEqual(
      expect.objectContaining({
        type: "tool_use",
        id: "toolu_settings_todo",
        name: "DeferredToolCall",
        // 回传历史保持包装形态，目标名与 input 原样保留。
        input: { name: "TodoRead", input: {} },
      }),
    );
    const localSession = (await getV4PaneSnapshot()).sessionId!;

    await setMode("off", localSession);
    const [stillLocal] = await toolSearchTurn(
      "E2E_TOOLSEARCH_SETTINGS_ACTIVE_LOCAL 当前会话继续 Local。",
    );
    expectLocal(stillLocal!);
    // 新任务使用独立工作目录；冷恢复应等待当前目录，不能要求默认项目同时打开。
    const localWorkspacePath = await getActiveWorkspacePath();
    expect(localWorkspacePath).toBeTruthy();
    await restartIntoWorkspaceRestoringPreferences(localWorkspacePath!);
    await selectV4TaskById(localSession);
    await expectSearchSummary();
    const [coldOff] = await toolSearchTurn("E2E_TOOLSEARCH_SETTINGS_COLD_OFF 冷恢复读取 Off。");
    expectToolSearchDisabled(coldOff!);
    expectToolResultPair(coldOff!, "toolu_settings_search");
    expectToolResultPair(coldOff!, "toolu_settings_todo");
    expect(JSON.stringify(coldOff!.requestJson.messages)).not.toContain("<functions>");

    await setMode("auto", localSession);
    await restartIntoWorkspaceRestoringPreferences(localWorkspacePath!);
    await selectV4TaskById(localSession);
    const [coldAuto] = await toolSearchTurn("E2E_TOOLSEARCH_SETTINGS_COLD_AUTO 恢复真实搜索发现。");
    expectToolSearchLoaded(coldAuto!);
    expectToolResultPair(coldAuto!, "toolu_settings_search");
    expect(JSON.stringify(coldAuto!.requestJson.messages)).toContain('"type":"tool_reference"');
  });
});

async function expectSearchSummary() {
  const callId = "toolu_settings_search";
  // 搜索轮已结束；等卡片收进工作记录后再断言，避免拿到收起前即将卸载的节点。
  const snapshot = await waitForFoldedToolCallBlockByToolCallId(callId);
  expect(snapshot.text).toMatch(/搜索工具：TodoRead|Search tools: TodoRead/u);
  const block = await browser.$(`[data-testid="${snapshot.testId}"]`);
  const summary = await block.$(`[data-testid="${testId(TID_TOOL_SUMMARY_TRIGGER, callId)}"]`);
  expect(await summary.getAttribute("role")).not.toBe("button");
  expect(await summary.getAttribute("aria-expanded")).toBeNull();
  await summary.click();
  expect(await summary.getAttribute("aria-expanded")).toBeNull();
  expect(await block.$("pre").isExisting()).toBe(false);
  expect(await block.getText()).not.toMatch(/select:|max_results|Tool loaded\.|<functions>/u);
}

async function openSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"), { timeout: 15_000 });
  await browser
    .$(`[data-testid="${TID_SETTINGS_TOOL_SEARCH_SELECT}"]`)
    .waitForExist({ timeout: 15_000 });
}

async function closeSettings(sessionId?: string) {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
  await waitForV4Pane(
    (s) => (sessionId ? s.sessionId === sessionId : !!s.sessionId),
    "设置返回会话失败",
    30_000,
  );
}

async function setMode(mode: AppToolSearchMode, sessionId: string) {
  await openSettings();
  const select = await browser.$(`[data-testid="${TID_SETTINGS_TOOL_SEARCH_SELECT}"]`);
  await select.scrollIntoView();
  await select.click();
  const option = await browser.$(
    `[data-testid="${testId(TID_SETTINGS_TOOL_SEARCH_OPTION, mode)}"]`,
  );
  await option.waitForDisplayed({ timeout: 10_000 });
  await option.click();
  const labels = { auto: ["自动", "Auto"], local: ["本地", "Local"], off: ["关闭", "Off"] };
  await browser.waitUntil(
    async () =>
      (await readSettings()).toolSearchMode === mode &&
      labels[mode].includes(await select.getText()),
    { timeout: 15_000, timeoutMsg: `ToolSearch ${mode} 设置未完成保存或刷新` },
  );
  await closeSettings(sessionId);
}

function expectLocal(record: ToolSearchRecord) {
  expect(record.requestJson.tools?.some((tool) => tool.name === "LocalToolSearch")).toBe(true);
  expect(record.requestJson.tools?.some((tool) => tool.name === "ToolSearch")).toBe(false);
  expect(record.requestJson.tools?.some((tool) => tool.name === "DeferredToolCall")).toBe(true);
  expect(record.requestJson.tools?.some((tool) => tool.name === TOOLSEARCH_DEFERRED_TOOL)).toBe(
    false,
  );
  expect(record.requestJson.tools?.some((tool) => "defer_loading" in tool)).toBe(false);
  expect(record.requestHeaders["anthropic-beta"] ?? "").not.toContain("advanced-tool-use");
  expect(JSON.stringify(record.requestJson.messages)).not.toContain('"type":"tool_reference"');
}

function expectSuccessfulTodo(record: ToolSearchRecord) {
  expectToolResultPair(record, "toolu_settings_search");
  expectToolResultPair(record, "toolu_settings_todo");
  const result = toolSearchBlocks(record.requestJson).find(
    (block) => block.tool_use_id === "toolu_settings_todo",
  );
  expect(result).toBeDefined();
  expect(result?.is_error).not.toBe(true);
  // 新任务没有待办，TodoRead 的真实执行输出是空清单。
  expect(JSON.parse(String(result?.content))).toEqual({ todos: [] });
}
