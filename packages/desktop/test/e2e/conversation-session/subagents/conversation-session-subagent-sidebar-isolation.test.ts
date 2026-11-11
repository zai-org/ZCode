import { waitForToolCallBlockByToolCallId } from "#e2e/helpers/conversation-session-tool";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { TID_TASK_ITEM, TID_V4_SUBAGENT_OPEN_SIDE_PANE, testId } from "@zcode/shared/test-ids";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  getV4PaneSnapshot,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";

const PARENT = "E2E_SUBAGENT_SIDEBAR_PARENT";
const PARENT_DONE = "E2E_SUBAGENT_SIDEBAR_PARENT_DONE";
const CHILD_DONE = "E2E_SUBAGENT_SIDEBAR_CHILD_DONE";
const paths = getE2EAppDataPaths();

describe("子代理冷恢复主列表隔离", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SAT27/SAT28: 真正派发 child 后冷启，详情可读且主列表保持隐藏", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt(
      `${PARENT}: launch one general-purpose Agent to reply with E2E_SUBAGENT_SIDEBAR_CHILD_DONE, then report E2E_SUBAGENT_SIDEBAR_PARENT_DONE.`,
    );
    await waitForV4AssistantMessageContaining(PARENT_DONE, 90000);
    await waitForV4Pane((state) => !state.canStop, "父任务未完成", 30000);
    const parentId = (await getV4PaneSnapshot()).sessionId;
    if (!parentId) throw new Error("missing parent session");
    const childId = readChildId(parentId);
    await openChild();
    await assertChildIsolated(childId);

    // 真正重启 CLI 清空 detached publisher；打开历史详情必须恢复原身份。
    await restartIntoWorkspacePreservingProfile();
    const parent = $(`[data-testid="${testId(TID_TASK_ITEM, parentId)}"]`);
    await parent.waitForDisplayed({ timeout: 30000 });
    await parent.click();
    await waitForV4AssistantMessageContaining(PARENT_DONE, 30000);
    await openChild();
    await assertChildIsolated(childId);
    expect(readChildId(parentId)).toBe(childId);
  });
});

function readChildId(parentId: string): string {
  const db = new DatabaseSync(join(paths.storageRoot, "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare("SELECT id FROM session WHERE parent_id = ? AND task_type = 'subagent_child'")
      .get(parentId) as { id: string } | undefined;
    if (!row) throw new Error("Agent 没有持久化 subagent_child");
    return row.id;
  } finally {
    db.close();
  }
}

async function openChild() {
  const block = await waitForToolCallBlockByToolCallId("toolu_e2e_subagent_sidebar", 30000);
  const action = $(`[data-testid="${block.testId}"]`).$(
    `[data-testid^="${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-"]`,
  );
  await action.waitForDisplayed({ timeout: 30000 });
  await action.click();
}

async function assertChildIsolated(childId: string) {
  const child = $(`[data-session-id="${childId}"]`);
  await child.waitForDisplayed({ timeout: 30000 });
  await browser.waitUntil(async () => (await child.getText()).includes(CHILD_DONE), {
    timeout: 30000,
    timeoutMsg: "child 转录未恢复",
  });
  expect(await child.$('[contenteditable="true"]').isExisting()).toBe(false);
  expect(await $(`[data-testid="${testId(TID_TASK_ITEM, childId)}"]`).isExisting()).toBe(false);
  await browser.saveScreenshot(join(paths.storageRoot, "subagent-sidebar-isolation.png"));
}
