import { expandAssistantHistoriesWithContent } from "#e2e/helpers/conversation-session-tool-diagnostics";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspace } from "#e2e/helpers/model-provider-restart";
import {
  editFirstV4UserQuery,
  getV4PaneSnapshot,
  selectV4TaskById,
  switchV4Model,
  waitForV4Edit,
  waitForV4Fork,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  readToolSearchRequests,
  TOOLSEARCH_TODO_CALL_ID,
  TOOLSEARCH_NOTICE,
} from "#e2e/helpers/toolsearch-provider";
import {
  compactToolSearchTask,
  expectToolResultPair,
  expectToolSearchDisabled,
  newToolSearchTask,
  setupToolSearchDesktop,
  TOOLSEARCH_MODEL,
  TOOLSEARCH_PLAIN_PROVIDER,
  TOOLSEARCH_PLAN_PROVIDER,
  toolSearchTurn,
} from "#e2e/helpers/toolsearch-desktop";

describe("ToolSearch provider、续写和历史生命周期", () => {
  before(async () => {
    await setupToolSearchDesktop();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("TS03: 同一 session 双向切 provider，默认持续关闭 ToolSearch", async function () {
    this.timeout(180_000);
    await newToolSearchTask();
    await toolSearchTurn("E2E_TOOLSEARCH_INITIAL 搜索 TodoRead 并执行。");
    const sessionId = (await getV4PaneSnapshot()).sessionId;
    await switchV4Model(TOOLSEARCH_PLAIN_PROVIDER, TOOLSEARCH_MODEL, "");
    const [off] = await toolSearchTurn("E2E_TOOLSEARCH_OFF 继续。");
    expectToolSearchDisabled(off!);
    expectToolResultPair(off!, TOOLSEARCH_TODO_CALL_ID);
    expect(JSON.stringify(off!.requestJson.messages)).not.toContain("tool_reference");
    await switchV4Model(TOOLSEARCH_PLAN_PROVIDER, TOOLSEARCH_MODEL, "");
    const [on] = await toolSearchTurn("E2E_TOOLSEARCH_ON 继续。");
    expectToolSearchDisabled(on!);
    expectToolResultPair(on!, TOOLSEARCH_TODO_CALL_ID);
    expect(JSON.stringify(on!.requestJson.messages)).not.toContain('"type":"tool_reference"');
    expect((await getV4PaneSnapshot()).sessionId).toBe(sessionId);
  });

  it("TS09: 默认关闭时三次 Continue 与冷恢复均不新增工具公告", async function () {
    this.timeout(120_000);
    await newToolSearchTask();
    const requests = await toolSearchTurn("E2E_TOOLSEARCH_CONTINUE 分三次续写后结束。");
    expect(requests).toHaveLength(4);
    for (const request of requests) expectToolSearchDisabled(request);
    const [next] = await toolSearchTurn("E2E_TOOLSEARCH_AFTER_CONTINUE 正常下一轮。");
    expectToolSearchDisabled(next!);
    const text = JSON.stringify(next!.requestJson.messages);
    expect(text).toContain("E2E_TOOLSEARCH_PARTIAL_1");
    expect(text).toContain("E2E_TOOLSEARCH_PARTIAL_3");
    expect(text).not.toContain("Output token limit hit. Resume directly");
    const sessionId = (await getV4PaneSnapshot()).sessionId!;
    await restartIntoWorkspace();
    await selectV4TaskById(sessionId);
    const [cold] = await toolSearchTurn("E2E_TOOLSEARCH_COLD_CONTINUE 检查续写的冷恢复。");
    expectToolSearchDisabled(cold!);
    const coldText = JSON.stringify(cold!.requestJson.messages);
    expect(coldText).toContain("E2E_TOOLSEARCH_PARTIAL_1");
    expect(coldText).toContain("E2E_TOOLSEARCH_PARTIAL_3");
    expect(coldText).not.toContain("Output token limit hit. Resume directly");
  });

  for (const disabledDuringCompact of [false, true]) {
    it(`TS04: ${disabledDuringCompact ? "普通 provider" : "Coding Plan"} 默认关闭期间 compact 后冷恢复`, async function () {
      this.timeout(240_000);
      await newToolSearchTask();
      await toolSearchTurn("E2E_TOOLSEARCH_INITIAL 搜索并执行后压缩。");
      const sessionId = (await getV4PaneSnapshot()).sessionId!;
      if (disabledDuringCompact)
        await switchV4Model(TOOLSEARCH_PLAIN_PROVIDER, TOOLSEARCH_MODEL, "");
      await compactToolSearchTask();
      const [after] = await toolSearchTurn("E2E_TOOLSEARCH_AFTER_COMPACT 核对压缩后的请求。");
      if (disabledDuringCompact) expectToolSearchDisabled(after!);
      else {
        expectToolSearchDisabled(after!);
      }
      // 摘要移走旧调用；默认关闭时仍按当前目录发送完整 schema。
      expect(JSON.stringify(after!.requestJson.messages)).not.toContain(TOOLSEARCH_TODO_CALL_ID);
      await restartIntoWorkspace();
      await selectV4TaskById(sessionId);
      await switchV4Model(TOOLSEARCH_PLAN_PROVIDER, TOOLSEARCH_MODEL, "");
      const cold = await toolSearchTurn("E2E_TOOLSEARCH_COLD_COMPACT 检查首请求。");
      expect(cold).toHaveLength(1);
      expectToolSearchDisabled(cold[0]!);
      expect(JSON.stringify(cold[0]!.requestJson.messages)).not.toContain(TOOLSEARCH_TODO_CALL_ID);
    });
  }

  it("TS05: 默认关闭时 fork 旧稳定轮不继承未来工具调用", async function () {
    this.timeout(180_000);
    await newToolSearchTask();
    await toolSearchTurn("E2E_TOOLSEARCH_SEED 尚未搜索的稳定轮。");
    const parentId = (await getV4PaneSnapshot()).sessionId!;
    await waitForV4Fork();
    const forkTestId = await browser.$('[data-testid^="v4-fork-"]').getAttribute("data-testid");
    await toolSearchTurn("E2E_TOOLSEARCH_INITIAL 现在搜索 TodoRead。");
    // 历史轮会折叠；“第一个可见按钮”可能属于最新轮，必须点预先记录的旧稳定轮。
    await expandAssistantHistoriesWithContent();
    const forkButton = await browser.$(`[data-testid="${forkTestId}"]`);
    await forkButton.$("..").moveTo();
    await forkButton.click();
    await waitForV4Pane(
      (s) => !!s.sessionId && s.sessionId !== "draft" && s.sessionId !== parentId,
      "fork 未切换到子分支",
      30_000,
    );
    const [child] = await toolSearchTurn("E2E_TOOLSEARCH_FORK 检查 fork 点工具池。");
    expectToolSearchDisabled(child!);
    await selectV4TaskById(parentId);
    const [parent] = await toolSearchTurn("E2E_TOOLSEARCH_AFTER_FORK 父分支检查。");
    expectToolSearchDisabled(parent!);
    expectToolResultPair(parent!, TOOLSEARCH_TODO_CALL_ID);
  });

  it("TS05: 默认关闭时编辑首轮不带回旧工具调用", async function () {
    this.timeout(120_000);
    await newToolSearchTask();
    await toolSearchTurn("E2E_TOOLSEARCH_INITIAL 原始搜索轮。");
    const before = (await readToolSearchRequests()).length;
    await waitForV4Edit();
    await editFirstV4UserQuery("E2E_TOOLSEARCH_EDITED 不搜索的新分支。");
    await browser.waitUntil(async () => (await readToolSearchRequests()).length > before, {
      timeout: 45_000,
    });
    await waitForV4Pane((s) => !s.canStop, "编辑重跑未结束", 30_000);
    const edited = (await readToolSearchRequests())[before]!;
    expectToolSearchDisabled(edited);
    expect(JSON.stringify(edited.requestJson.messages)).not.toContain(TOOLSEARCH_TODO_CALL_ID);
    expect(JSON.stringify(edited.requestJson.messages)).not.toContain(TOOLSEARCH_NOTICE);
  });
});
