import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import { runSSHCommand } from "#e2e/helpers/ssh-remote-p0";
import {
  approveV4Permission,
  clickV4PausedQueueResume,
  clickV4QueueItemDelete,
  clickV4Stop,
  getLatestV4CommandAck,
  getV4ComposerText,
  getV4PaneSnapshot,
  getV4QueueAutoDrain,
  getV4QueueItems,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4Pane,
  waitForV4PausedQueueBanner,
  waitForV4PermissionDialogInComposerDock,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import {
  openV4QueueItemEditInComposer,
  waitForV4ComposerEditClosed,
} from "#e2e/helpers/v4-composer-edit";

const CASE_MARKER = "E2E_R3_TASK_CONTROL";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-task-control");
const REMOTE_PERMISSION_DIR = "/home/dev/r3-workspace-a/.zcode-e2e/r3-task-control";
const REMOTE_PERMISSION_FILE = `${REMOTE_PERMISSION_DIR}/permission-output.txt`;

describe(`${CASE_MARKER}: 远端 running 窗口内的 stop/queue 与权限阻塞`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "task-control.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-TASK-02/03 busy 入队、删除/编辑、stop 保留队列、resume FIFO 消费；权限在远端阻塞并执行", async function () {
    this.timeout(30 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, { apiType: "anthropic-messages" });
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    await runSSHCommand(prepared.config, `rm -rf "${REMOTE_PERMISSION_DIR}"`);
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });

    // 1. running 窗口由 fixture 闸门保持到 Stop，避免排队/编辑期间自然结束。
    const slowStart = await getUpstreamRequestRecordCount();
    await sendV4Prompt(`${CASE_MARKER}_SLOW 慢慢回答`);
    await waitForV4TimelineContaining("R3_TASK_STREAMING", 60_000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId === taskA.taskId,
      "远端 turn 没有进入 running",
      45_000,
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_SLOW`] },
      `${CASE_MARKER}: 慢流请求没有到达回放`,
      30_000,
      { afterIndex: slowStart - 1 },
    );

    // 2. busy 连续输入两条 → 入队 FIFO；来源 commandId 经 ACK 可见。
    await sendV4Prompt(`${CASE_MARKER}_Q1 第一条排队`);
    await waitForV4QueueCount(1, 30_000);
    await sendV4Prompt(`${CASE_MARKER}_Q2 第二条排队`);
    await waitForV4QueueCount(2, 30_000);
    let queue = await getV4QueueItems();
    expect(queue.map((item) => item.text.includes("_Q1"))).toEqual([true, false]);
    facts.queueAfterEnqueue = queue.map((item) => item.text.slice(0, 40));

    // 3. 删除 Q1 → 权威投影只剩 Q2；编辑 Q2 原位冻结，修改后原地替换 → queueItemId 不变。
    expect(await clickV4QueueItemDelete(queue[0]!.queueItemId)).toBe(true);
    await waitForV4QueueCount(1, 30_000);
    queue = await getV4QueueItems();
    expect(queue[0]!.text).toContain("_Q2");
    const q2Id = queue[0]!.queueItemId;
    // 编辑队列项：原位冻结并进入 composer 编辑态，发送走 editQueueItem 原地替换（ID 不变）。
    await openV4QueueItemEditInComposer(q2Id, 30_000);
    expect(await getV4QueueItems()).toHaveLength(1);
    await browser.waitUntil(async () => ((await getV4ComposerText()) ?? "").includes("_Q2"), {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 编辑态没有载入队列项原文`,
    });
    await sendV4Prompt(`${CASE_MARKER}_Q3 修改后重发`);
    await waitForV4ComposerEditClosed(`${CASE_MARKER}: editQueueItem 后没有退出编辑态`, 30_000);
    await browser.waitUntil(
      async () => ((await getV4QueueItems())[0]?.text ?? "").includes("_Q3"),
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 队列项没有原地替换为 Q3` },
    );
    queue = await getV4QueueItems();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.queueItemId).toBe(q2Id);
    facts.queueAckEdit = await getLatestV4CommandAck("editQueueItem").catch(() => null);

    // 4. stop：当前流收口、队列原样保留且 autoDrain=false、显示暂停提示；无丢失无重复。
    expect((await getV4PaneSnapshot()).canStop).toBe(true);
    await clickV4Stop();
    await waitForV4Pane((s) => !s.canStop, `${CASE_MARKER}: stop 后没有收口`, 30_000);
    await waitForV4PausedQueueBanner(30_000);
    expect(await getV4QueueAutoDrain()).toBe(false);
    queue = await getV4QueueItems();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.text).toContain("_Q3");
    facts.stopAck = await getLatestV4CommandAck("stop").catch(() => null);

    // 5. resume：按 FIFO 消费队首为新 turn，请求真实到达远端→回放；回到 idle 且队列为空。
    const resumeStart = await getUpstreamRequestRecordCount();
    await clickV4PausedQueueResume();
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_Q3`] },
      `${CASE_MARKER}: 队首消费请求没有到达回放`,
      60_000,
      { afterIndex: resumeStart - 1 },
    );
    await waitForV4AssistantMessageContaining("R3_TASK_Q_REPLY", 60_000);
    await waitForV4QueueCount(0, 30_000);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle" && s.queueCount === 0,
      `${CASE_MARKER}: 队列消费后没有回到 idle`,
      60_000,
    );

    // 6. TASK-03：Write 工具触发远端权限阻塞；允许后工具在远端真实执行并出终态文本。
    const permissionStart = await getUpstreamRequestRecordCount();
    await sendV4Prompt(`${CASE_MARKER}_PERMISSION 请写入文件 ${REMOTE_PERMISSION_FILE}`);
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_PERMISSION`] },
      `${CASE_MARKER}: 权限请求 turn 没有到达回放`,
      60_000,
      { afterIndex: permissionStart - 1 },
    );
    const dock = await waitForV4PermissionDialogInComposerDock(60_000);
    expect(dock.inDock).toBe(true);
    const beforeApprove = await runSSHCommand(
      prepared.config,
      `test -f "${REMOTE_PERMISSION_FILE}" && echo exists || echo absent`,
    );
    expect(beforeApprove.stdout.trim()).toBe("absent");
    expect(await approveV4Permission()).toBe(true);
    await waitForV4TimelineContaining("R3_TASK_PERMISSION_DONE", 90_000);
    const afterApprove = await runSSHCommand(prepared.config, `cat "${REMOTE_PERMISSION_FILE}"`);
    expect(afterApprove.stdout).toContain("R3_TASK_PERMISSION_RESULT");
    facts.permissionFileOnRemote = afterApprove.stdout.trim();
    facts.permissionAck = await getLatestV4CommandAck("resolveInteraction").catch(() => null);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: 权限 turn 没有回到 idle`,
      60_000,
    );
    const snapshot = await getV4PaneSnapshot();
    expect(snapshot.canStop).toBe(false);
  });
});
