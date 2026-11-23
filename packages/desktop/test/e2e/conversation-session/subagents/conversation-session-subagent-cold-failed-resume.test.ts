import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  TID_CHAT_TOOL_CALL_BLOCK,
  TID_TASK_ITEM,
  TID_V4_ROW,
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  testId,
} from "@zcode/shared/test-ids";
import { releaseControlledReplay, waitForControlledReplay } from "#e2e/helpers/controlled-replay";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import {
  expandAssistantHistoriesWithContent,
  waitForFoldedToolCallBlockByToolCallId,
  waitForToolCallBlockByToolCallId,
} from "#e2e/helpers/conversation-session-tool";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart";
import {
  getV4ComposerBackgroundWorkCounts,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const PARENT = "E2E_SAT32_PARENT";
const PARENT_AFTER_FAILURE = "E2E_SAT32_PARENT_AFTER_FAILURE";
const RESUME = "E2E_SAT32_RESUME";
const CHILD_DONE = "E2E_SAT32_CHILD_DONE";
const RESUME_ACK = "E2E_SAT32_RESUME_ACK";
const NOTIFICATION_DONE = "E2E_SAT32_NOTIFICATION_DONE";
const AGENT_CALL = "toolu_e2e_sat32_agent";
const SEND_MESSAGE_CALL = "toolu_e2e_sat32_send_message";
const CHILD_RESUMED_FIXTURE = "subagent-cold-failed-resume-child-resumed";
const paths = getE2EAppDataPaths();

interface ChildEntry {
  childSessionId: string;
  inAgentCard: boolean;
}

// 回归 2026-11-10：前台 Agent 失败后 App 重启，registry 为空，SendMessage 原来找不到目标；
// 找回后 App 冷加载读不到失败 Agent 的 agentId，续接的运行在 SendMessage 那一轮另起一行。
describe("SAT32 失败的前台 Agent 冷恢复后续接", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SAT32: App 重启后 SendMessage 续接失败的 Agent，仍只有原 Agent 卡片", async function () {
    this.timeout(300000);
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();

    await sendV4PromptAndWaitAccepted(
      `${PARENT}: call Agent exactly once in the foreground, then finish.`,
      PARENT,
      "SAT32 首轮用户消息没有进入 timeline",
      90000,
    );
    await waitForV4AssistantMessageContaining(PARENT_AFTER_FAILURE, 90000);
    await waitForV4Pane((state) => !state.canStop, "SAT32 首轮没有收口", 30000);
    await waitForUpstreamRequest(
      { includes: [PARENT, AGENT_CALL, "agentId: agent_"] },
      "同步失败结果没有把 agentId 交给父模型",
      30000,
    );
    expect((await waitForToolCallBlockByToolCallId(AGENT_CALL, 30000)).status).toBe("failed");
    const parentId = (await getV4PaneSnapshot()).sessionId;
    if (!parentId) throw new Error("missing parent session");
    const [childId] = readChildIds(parentId);
    if (!childId) throw new Error("失败的 Agent 没有持久化 subagent_child");
    expect(await waitForChildEntries([childId], "实时失败卡片没有子会话入口")).toEqual([
      { childSessionId: childId, inAgentCard: true },
    ]);

    // 真正重启 CLI：registry 清空，父 timeline 只能从 transcript 冷加载。
    await restartIntoWorkspacePreservingProfile();
    const parent = $(`[data-testid="${testId(TID_TASK_ITEM, parentId)}"]`);
    await parent.waitForDisplayed({ timeout: 30000 });
    await parent.click();
    await waitForV4AssistantMessageContaining(PARENT_AFTER_FAILURE, 30000);
    // 修复点：冷加载从 part 上结构化的 agentId / childSessionId 恢复失败卡片的身份与子会话入口。
    expect(await waitForChildEntries([childId], "冷加载后失败卡片没有子会话入口")).toEqual([
      { childSessionId: childId, inAgentCard: true },
    ]);

    await sendV4PromptAndWaitAccepted(
      `${RESUME}: call SendMessage exactly once for the failed agent, then finish.`,
      RESUME,
      "SAT32 续接用户消息没有进入 timeline",
      90000,
    );
    await waitForV4AssistantMessageContaining(RESUME_ACK, 90000);
    // 卡片一出现就会被读到，要等父 turn 用正文收口、卡片收进工作记录后再读终态。
    expect((await waitForFoldedToolCallBlockByToolCallId(SEND_MESSAGE_CALL, 30000)).status).toBe(
      "completed",
    );

    // 续接进行中：child 的输出停在半途（受控流）。续接的 SubagentSpawned 与后台任务在同一批投影里，
    // 等 Composer 出现这一个运行中的 Agent，再检查它挂在原卡片上、没有另起裸 subagent 行。
    await waitForControlledReplay(CHILD_RESUMED_FIXTURE);
    await browser.waitUntil(
      async () => (await getV4ComposerBackgroundWorkCounts())?.subagentCount === 1,
      { timeout: 30000, timeoutMsg: "续接的 Agent 没有作为运行中的后台任务出现" },
    );
    expect(await waitForChildEntries([childId], "续接进行中子会话入口不唯一")).toEqual([
      { childSessionId: childId, inAgentCard: true },
    ]);
    expect(await readBareSubagentRowTexts()).toEqual([]);
    await releaseControlledReplay(CHILD_RESUMED_FIXTURE);

    await waitForV4AssistantMessageContaining(NOTIFICATION_DONE, 120000);
    await waitForV4Pane((state) => !state.canStop, "SAT32 完成通知轮没有收口", 30000);
    await waitForUpstreamRequest(
      { includes: [RESUME, CHILD_DONE, "<task-notification>", "<status>completed</status>"] },
      "续接运行的完成通知没有回到父模型",
      30000,
    );

    // 修复点：续接的运行回到原 Agent 卡片，不在 SendMessage 那一轮另起裸 subagent 行。
    expect(await waitForChildEntries([childId], "续接后子会话入口不唯一")).toEqual([
      { childSessionId: childId, inAgentCard: true },
    ]);
    expect(await readBareSubagentRowTexts()).toEqual([]);
    expect(readChildIds(parentId)).toEqual([childId]);
  });
});

function readChildIds(parentId: string): string[] {
  const db = new DatabaseSync(join(paths.storageRoot, "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    const rows = db
      .prepare("SELECT id FROM session WHERE parent_id = ? AND task_type = 'subagent_child'")
      .all(parentId) as { id: string }[];
    return rows.map((row) => row.id);
  } finally {
    db.close();
  }
}

/** 页面上全部子会话入口，以及它们是否在原 Agent 卡片里。 */
async function readChildEntries(): Promise<ChildEntry[]> {
  await expandAssistantHistoriesWithContent();
  return browser.execute(
    (prefix, agentCardTestId) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-"]`)).map(
        (element) => ({
          childSessionId: (element.getAttribute("data-testid") ?? "").slice(prefix.length + 1),
          inAgentCard: element.closest(`[data-testid="${agentCardTestId}"]`) !== null,
        }),
      ),
    TID_V4_SUBAGENT_OPEN_SIDE_PANE,
    testId(TID_CHAT_TOOL_CALL_BLOCK, AGENT_CALL),
  );
}

async function waitForChildEntries(
  childIds: readonly string[],
  timeoutMsg: string,
): Promise<ChildEntry[]> {
  let entries: ChildEntry[] = [];
  await browser
    .waitUntil(
      async () => {
        entries = await readChildEntries();
        return (
          entries.length === childIds.length &&
          entries.every((entry, index) => entry.childSessionId === childIds[index])
        );
      },
      { timeout: 30000, timeoutMsg },
    )
    .catch(() => undefined);
  return entries;
}

/**
 * 没有和 Agent 卡片配对的 subagent 行只渲染 `<类型> · <状态>` 摘要。
 * 状态取 SubagentRow.status 的取值（running / success / failed / cancelled）：
 * 原来写成 completed，完成后的裸行显示 `· success`，匹配不到，这个检查永远通过。
 */
async function readBareSubagentRowTexts(): Promise<string[]> {
  await expandAssistantHistoriesWithContent();
  return browser.execute(
    (rowPrefix) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${rowPrefix}-"]`))
        .map((element) => (element.textContent ?? "").trim())
        .filter((text) => /^\S+ · (running|success|failed|cancelled)\b/u.test(text)),
    TID_V4_ROW,
  );
}
