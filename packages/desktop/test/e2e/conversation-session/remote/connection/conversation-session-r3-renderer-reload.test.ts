import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { countRendererReloadAcks } from "#e2e/helpers/remote-renderer-ready-evidence";
import { waitForV4Pane } from "#e2e/helpers/v4-conversation";
import { TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  readTaskRowInProject,
  readRemoteCoreIdentity,
  sendSSHFollowTurn,
  waitForRendererAfterColdRestart,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  readHostProcesses,
  readRemoteTabSnapshot,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_R3_RENDERER_RELOAD";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-renderer-reload",
);

async function readReadyCounts() {
  const directory = process.env.ZCODE_E2E_RUNTIME_LOG_DIR;
  if (!directory) throw new Error("缺少本 worker 的 Desktop 日志目录");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".log"));
  const counts = new Map<string, number>();
  // 分别解析日志，不能用拼接换行把一个文件尚未写完的尾行变成完整 ACK。
  for (const content of await Promise.all(
    files.map((name) => readFile(join(directory, name), "utf8")),
  )) {
    for (const [id, count] of countRendererReloadAcks(content)) {
      counts.set(id, (counts.get(id) ?? 0) + count);
    }
  }
  return counts;
}

async function selectReloadedTask(task: SSHLifecycleTask, facts: Record<string, unknown>) {
  facts[`beforeSelecting${task.label}`] = await readRemoteTabSnapshot(task.identity);
  const row = $(`[data-project-workspace-identity=${JSON.stringify(task.identity)}]`).$(
    `[data-testid=${JSON.stringify(testId(TID_TASK_ITEM, task.taskId))}]`,
  );
  await row.waitForDisplayed({ timeout: 30_000 });
  // 用真实指针并限定项目，复验全局 DOM click 未切换时是否命中了旧或隐藏的行。
  await row.click();
  try {
    await waitForV4Pane(
      (pane) => pane.sessionId === task.taskId,
      `${CASE_MARKER}: 真实点击 ${task.label} 未切换任务`,
    );
  } finally {
    facts[`afterSelecting${task.label}`] = {
      tab: await readRemoteTabSnapshot(task.identity),
      panes: await browser.execute(() =>
        [...document.querySelectorAll<HTMLElement>('[data-testid^="v4-session-pane-"]')].map(
          (pane) => ({
            id: pane.dataset.testid,
            sessionId: pane.dataset.sessionId,
            visible: pane.getClientRects().length > 0,
          }),
        ),
      ),
    };
  }
}

describe(`${CASE_MARKER}: 仅 renderer reload 时复用 Host 与物理连接`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "renderer-reload.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-REC-06 两个 opened workspace 下 renderer reload：Host/远端会话不换代，订阅与投影恢复，可继续对话", async function () {
    this.timeout(20 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, { tunnelUsername: "tunnel" });
    provider = prepared.provider;
    const [workspaceA, workspaceB] = prepared.config.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const taskB = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "B",
      provider,
      workspacePath: workspaceB,
    });
    const hostsBefore = await readHostProcesses();
    const coreBefore = await readRemoteCoreIdentity(prepared.config, CASE_MARKER);
    expect(taskA.remoteSessionId).not.toBe(taskB.remoteSessionId);
    const readyBefore = await readReadyCounts();

    // 只刷新 renderer（不是 Electron 冷重启）。
    const reloadStartedAt = Date.now();
    await browser.refresh();
    // 这里只等 Renderer 可操作；启动合同会选择本地项，不能空等远端 active 再吞掉超时。
    await waitForRendererAfterColdRestart(CASE_MARKER);
    facts.rendererReadyMs = Date.now() - reloadStartedAt;
    // 新项目模型的 tab store 是当前导航缓存，不能用缺少 inactive tab 误报端口未恢复。
    // 先验证两条旧 session 都已收到 Main 的有效 ready ACK，再沿实际任务入口验证相同 session 和历史。
    let readyAfter = new Map<string, number>();
    await browser.waitUntil(
      async () => {
        readyAfter = await readReadyCounts();
        return [taskA, taskB].every(
          (task) =>
            (readyAfter.get(task.remoteSessionId) ?? 0) >
            (readyBefore.get(task.remoteSessionId) ?? 0),
        );
      },
      {
        timeout: 60_000,
        interval: 250,
        timeoutMsg: `${CASE_MARKER}: 两个 workspace 未全部收到 renderer reload ready ACK`,
      },
    );
    facts.reloadReadyAcks = Object.fromEntries(readyAfter);
    await readTaskRowInProject(taskA, CASE_MARKER);
    await selectReloadedTask(taskA, facts);
    const tabA = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
      requireActive: false,
      timeoutMs: 60_000,
    });
    await readTaskRowInProject(taskB, CASE_MARKER);
    await selectReloadedTask(taskB, facts);
    const tabB = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskB.identity,
      expectedPath: workspaceB,
      requireActive: false,
      timeoutMs: 60_000,
    });
    facts.sessions = {
      A: { before: taskA.remoteSessionId, after: tabA.remoteSessionId },
      B: { before: taskB.remoteSessionId, after: tabB.remoteSessionId },
    };
    // Host 与物理连接复用：remoteSessionId 不换代、Host 进程不变、远端 Core 不变。
    expect(tabA.remoteSessionId).toBe(taskA.remoteSessionId);
    expect(tabB.remoteSessionId).toBe(taskB.remoteSessionId);
    expect(await readHostProcesses()).toEqual(hostsBefore);
    const coreAfter = await readRemoteCoreIdentity(prepared.config, CASE_MARKER);
    expect(coreAfter.pid).toBe(coreBefore.pid);
    expect(coreAfter.startTicks).toBe(coreBefore.startTicks);
    expect(coreAfter.generation).toBe(coreBefore.generation);
    expect((await readRemoteTabSnapshot(taskA.identity)).secretPersistedInTab).toBe(false);

    // 订阅/投影恢复：task 行仍在正确 workspace，续发历史正确且不串。
    await readTaskRowInProject(taskA, CASE_MARKER);
    await readTaskRowInProject(taskB, CASE_MARKER);
    await sendSSHFollowTurn(taskA, CASE_MARKER, taskB.firstPrompt);
    await sendSSHFollowTurn(taskB, CASE_MARKER, taskA.firstPrompt);
    facts.followTurnsAfterReload = true;
  });
});
