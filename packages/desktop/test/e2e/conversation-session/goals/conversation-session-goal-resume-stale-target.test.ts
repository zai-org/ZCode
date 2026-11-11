import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { ServiceChannels } from "@zcode/shared";
import type { ProjectTree } from "@zcode/services";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  clickFirstQueueSendNow,
  waitForQueueContaining,
} from "#e2e/helpers/conversation-session-queue";
import {
  countUpstreamRequestsContainingAll,
  waitForUpstreamRequestContaining,
} from "#e2e/helpers/conversation-session-network";

const OBJECTIVE = "E2E_GOAL_RESUME_STALE_OBJECTIVE";
const QUEUED = "E2E_GOAL_RESUME_STALE_SEND_NOW";
const VERIFIER = "Verify whether the active session goal";

describe("会话区 Goal 恢复 stale target 复现", () => {
  afterEach(async () => {
    if ((await getV4PaneSnapshot()).canStop) await clickV4Stop();
    await restoreHandoffProbes();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("paused target 恢复后队列 item 点立即发送不能被 stale active task meta 卡住", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E();
    await sendV4Prompt(`/goal ${OBJECTIVE}: Reply with exactly "${E2E_REPLY_TOKEN}".`);
    await waitForUpstreamRequestContaining(OBJECTIVE);
    const active = await waitForV4ConversationState(
      (snapshot) =>
        Boolean(snapshot.taskId) &&
        snapshot.state === "streaming" &&
        snapshot.targetStatus === "active",
      "真实 Goal 没有进入 active streaming",
      45000,
    );
    const taskId = active.taskId!;
    // 旧用例写入已退役的 renderer queue，V4 从未收到该输入。这里由真实 Composer 入队。
    await sendV4Prompt(`${QUEUED}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`);
    await waitForQueueContaining(QUEUED);
    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.state === "idle" &&
        snapshot.targetStatus === "paused" &&
        snapshot.queueCount === 1,
      "Stop 没有暂停 Goal 并保留队列",
      30000,
    );
    await startNewV4Draft();
    // 故障只污染 App 的旧列表元数据；Agent 的 target 与 queue 保留真实 Stop 结果。
    writeStaleTaskTarget(taskId);
    await installHandoffRpcProbe();
    const stale = (
      await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree")
    ).tasks.find((task) => task.taskId === taskId);
    expect(stale?.target?.status).toBe("active");
    await selectV4TaskById(taskId);
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.taskId === taskId &&
        snapshot.targetStatus === "paused" &&
        snapshot.queueCount === 1 &&
        snapshot.state === "idle",
      "恢复没有采用后端 paused target 与队列",
      30000,
    );
    await waitForQueueContaining(QUEUED);
    const verifierBefore = await countUpstreamRequestsContainingAll([OBJECTIVE, VERIFIER]);
    const item = await clickFirstQueueSendNow();
    expect(item.content).toContain(QUEUED);
    await waitForUpstreamRequestContaining(QUEUED, 30000);
    await waitForV4UserMessageContaining(QUEUED);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.taskId === taskId && snapshot.queueCount === 0 && snapshot.state === "idle",
      "立即发送未完成或仍残留队列",
      30000,
    );
    expect(await countUpstreamRequestsContainingAll([OBJECTIVE, VERIFIER])).toBe(verifierBefore);
    expect(await countUpstreamRequestsContainingAll([QUEUED])).toBe(1);
  });
});

function writeStaleTaskTarget(taskId: string) {
  const db = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"));
  try {
    const row = db.prepare("SELECT meta_json FROM tasks WHERE task_id = ?").get(taskId) as
      | { meta_json: string }
      | undefined;
    if (!row) throw new Error(`缺少真实 tasks-index 行: ${taskId}`);
    const meta = JSON.parse(row.meta_json);
    if (!meta.target) throw new Error("Stop 后真实 task meta 未携带 Goal target");
    meta.target.status = "active";
    db.prepare("UPDATE tasks SET meta_json = ? WHERE task_id = ?").run(
      JSON.stringify(meta),
      taskId,
    );
  } finally {
    db.close();
  }
}
