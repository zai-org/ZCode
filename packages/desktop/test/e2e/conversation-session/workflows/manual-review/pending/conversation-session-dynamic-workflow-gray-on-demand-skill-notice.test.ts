import {
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestToolNames,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { readDynamicWorkflowGrayMockStatus } from "#e2e/helpers/dynamic-workflow-gray";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

// 灰度档 onDemand 下的「工作流工具未激活」提示（docs/dynamic-workflow/launch.md「On demand: activation」
// 的「What the model is told」）。用户只用文字要求工作流时，模型看得到 `dynamic-workflows` 技能并会加载它，
// 而十个工作流工具还没注册；Skill 工具结果在这一刻带一段提示，让模型请用户发 `/workflow`。
//
// case-local 回放只决定模型回答（调 Skill、收尾文字）；灰度下发、技能加载、提示的有无和 `/workflow` 激活
// 都走产品链路，断言读的是真实发给模型的工具结果与工具面。文件名含 on-demand 片段以取得 `onDemand` 档。

/** 受灰度门管的十个工具（与 DWO-01～04 同一份名单）。 */
const WORKFLOW_TOOL_NAMES = [
  "CreateWorkflow",
  "AmendWorkflow",
  "SaveWorkflow",
  "ListSavedWorkflows",
  "EvalWorkflowSnippet",
  "ListWorkflowRuns",
  "GetWorkflowRun",
  "ResumeWorkflowRun",
  "ResolveWorkflowQuestion",
  "FillWorkflowHole",
];
const SKILL_CONTENT_OPEN_TAG = "<skill_content";
const WORKFLOW_COMMAND_TEXT = "/workflow";
const DEFERRED_SKILL_CALL_ID = "toolu_dwo_s1_skill";
const ACTIVATED_SKILL_CALL_ID = "toolu_dwo_s2_skill";
const DEFERRED_ASK_MARKER = "E2E_DWO_S1_ASK";
const ACTIVATED_ASK_MARKER = "E2E_DWO_S2_ASK";

/** 等这次 Skill 调用的结果随后续请求发给模型，返回结果里 `<skill_content>` 之前的部分。 */
async function readSkillResultPreamble(toolCallId: string): Promise<string> {
  await browser.waitUntil(
    async () => (await getLatestUpstreamToolResultByToolCallId(toolCallId)) !== null,
    { timeout: 60_000, timeoutMsg: `模型请求里没有 ${toolCallId} 的工具结果` },
  );
  const result = await getLatestUpstreamToolResultByToolCallId(toolCallId);
  if (!result) throw new Error(`没有读到 ${toolCallId} 的工具结果`);
  expect(result.isError).toBe(false);
  const wrapperIndex = result.content.indexOf(SKILL_CONTENT_OPEN_TAG);
  // 技能正文确实加载了：提示是加在正文之前，不是替换正文。
  expect(wrapperIndex).toBeGreaterThanOrEqual(0);
  return result.content.slice(0, wrapperIndex);
}

async function readWorkflowToolNames(askMarker: string): Promise<string[]> {
  const query = { lastUserMessageIncludes: [askMarker] };
  await waitForUpstreamRequest(query, `${askMarker}: 没有捕获到模型请求`);
  const names = await getUpstreamRequestToolNames(query);
  // 正向对照：请求确实带着工具面。
  expect(names).toContain("Skill");
  return names.filter((name) => WORKFLOW_TOOL_NAMES.includes(name));
}

describe("动态工作流灰度 · onDemand · 技能加载时的未激活提示", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWO-05 文字要求工作流：Skill 结果带 /workflow 提示且不激活；/workflow 之后再加载不带提示", async function () {
    this.timeout(240_000);

    const status = await readDynamicWorkflowGrayMockStatus();
    expect(status.scenario).toBe("onDemand");
    await browser.waitUntil(
      async () => (await readDynamicWorkflowGrayMockStatus()).configRequests > 0,
      { timeout: 60_000, timeoutMsg: "Host 没有向 case-local 配置网关请求 /client/configs" },
    );

    // 未激活：用户只用文字点名工作流，模型加载技能。
    await sendV4Prompt(`${DEFERRED_ASK_MARKER} 请使用工作流处理这件事。`);
    await waitForV4AssistantMessageContaining("E2E_DWO_S1_OK", 60_000);
    await waitForV4Pane((pane) => !pane.canStop, "未激活那一轮没有结束", 60_000);
    expect(await readSkillResultPreamble(DEFERRED_SKILL_CALL_ID)).toContain(WORKFLOW_COMMAND_TEXT);
    // 文字请求与加载技能都不是激活触发条件。
    expect(await readWorkflowToolNames(DEFERRED_ASK_MARKER)).toEqual([]);
    const { sessionId } = await getV4PaneSnapshot();
    if (!sessionId || sessionId === "draft") throw new Error("未激活那一轮没有真实 sessionId");

    // 同一会话按提示发 /workflow：工具面激活，再加载同一份技能不再带提示。
    await sendV4Prompt(`/workflow ${ACTIVATED_ASK_MARKER} 处理这件事`);
    await waitForV4AssistantMessageContaining("E2E_DWO_S2_OK", 60_000);
    await waitForV4Pane((pane) => !pane.canStop, "/workflow 那一轮没有结束", 60_000);
    expect((await getV4PaneSnapshot()).sessionId).toBe(sessionId);
    const activatedNames = await readWorkflowToolNames(ACTIVATED_ASK_MARKER);
    expect(WORKFLOW_TOOL_NAMES.filter((name) => !activatedNames.includes(name))).toEqual([]);
    expect(await readSkillResultPreamble(ACTIVATED_SKILL_CALL_ID)).toBe("");
  });
});
