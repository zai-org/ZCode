import { TID_TASK_ITEM, TID_WORKSPACE_TITLE, testId } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const PROMPT_MARKER = "E2E_TITLE_SIDECAR_TIMEOUT";
const SKILL_LINK =
  "[$e2e-case-lifecycle](/Users/dev/workspace/z-code/.agents/skills/e2e-case-lifecycle/SKILL.md)";
const FINAL_TOKEN = "e2e-title-timeout-ok";
const GENERATED_TITLE = "e2e-case-lifecycle 技能说明";

describe("conversation session title generation timeout", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("消息以技能链接开头且标题 sidecar 慢于 15s 但小于 60s 时仍应回写任务标题", async function () {
    this.timeout(120000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = `${SKILL_LINK} ${PROMPT_MARKER}_${runId}: 请用一句话回答，并且最终回答必须只包含 ${FINAL_TOKEN}`;
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "标题超时 case 首发后输入框没有清空");
    await waitForV4UserMessageContaining(PROMPT_MARKER);

    const runningSnapshot = await waitForV4ConversationState(
      (snapshot) => Boolean(snapshot.sessionId || snapshot.taskId),
      "标题超时 case 首发后没有创建 task",
      30000,
    );
    const taskId = runningSnapshot.sessionId || runningSnapshot.taskId;
    if (!taskId) {
      throw new Error("标题超时 case 缺少 taskId，无法断言标题回写");
    }

    await waitForV4AssistantMessageContaining(FINAL_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "标题超时 case 主回复完成后没有回到 idle",
      90000,
    );

    // 运行录像已显示标题更新；旧 taskListCache 在 V4 中不再持有该任务，改查真实 Header 与侧栏。
    await waitForHeaderTitle(GENERATED_TITLE);
    await waitForTaskItemTitle(taskId, GENERATED_TITLE);
  });
});

async function waitForHeaderTitle(expectedTitle: string) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (titleTestId, title) => {
          const header = document.querySelector<HTMLElement>(`[data-testid="${titleTestId}"]`);
          return header?.innerText.includes(title) || header?.getAttribute("title") === title;
        },
        TID_WORKSPACE_TITLE,
        expectedTitle,
      ),
    {
      timeout: 70000,
      timeoutMsg: `WorkspaceHeader 没有展示生成标题: ${expectedTitle}`,
    },
  );
}

async function waitForTaskItemTitle(taskId: string, expectedTitle: string) {
  const taskItemTestId = testId(TID_TASK_ITEM, taskId);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (itemTestId, title) => {
          const item = document.querySelector<HTMLElement>(`[data-testid="${itemTestId}"]`);
          return item?.innerText.includes(title) ?? false;
        },
        taskItemTestId,
        expectedTitle,
      ),
    {
      timeout: 10000,
      timeoutMsg: `任务列表没有展示生成标题: ${expectedTitle}`,
    },
  );
}
