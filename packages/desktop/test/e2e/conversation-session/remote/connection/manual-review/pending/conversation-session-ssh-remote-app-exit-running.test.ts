import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { resolveSeededReplayBaseUrl } from "#e2e/helpers/custom-openai-provider-store";
import { countUpstreamRequests } from "#e2e/helpers/conversation-session-network";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  readRemoteCoreIdentity,
  sendSSHFollowTurn,
  waitForRendererAfterColdRestart,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import { runSSHCommand, waitForRemoteTab } from "#e2e/helpers/ssh-remote-p0";
import {
  getV4Messages,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4ConversationState,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_SSH_APP_EXIT_RUNNING";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-app-exit-running",
);

describe(`${MARKER}: 完整退出 Desktop 后远端回合继续`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};
  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "app-exit-running.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("SSH-GUIDE-EXIT 旧 Main、Host 与 Renderer 全部退出期间回合完成，重开草稿后手动打开原任务且只执行一次", async function () {
    this.timeout(15 * 60_000);
    const prepared = await prepareSSHLifecycle(MARKER, {
      apiType: "anthropic-messages",
      tunnelUsername: "tunnel",
    });
    provider = prepared.provider;
    const task = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: MARKER,
      config: prepared.config,
      provider,
      label: "A",
      workspacePath: prepared.config.workspacePaths[0],
    });
    const coreBefore = await readRemoteCoreIdentity(prepared.config, MARKER);
    const replayBase = await resolveSeededReplayBaseUrl();
    if (!replayBase) throw new Error("缺少独立模型回放服务");
    const prompt = `${MARKER}_SLOW`;
    await sendV4Prompt(`${prompt} 请完成远程任务`);
    await waitForV4TimelineContaining("SSH_EXIT_STREAMING");
    await waitForV4Pane(
      (state) => state.canStop && state.sessionId === task.taskId,
      "远端回合没有进入运行中",
    );

    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        // 必须在旧 Electron 进程树退出后、新 Electron 启动前取证；不能用 renderer reload 代替关闭应用。
        facts.oldDesktopExitedAt = new Date().toISOString();
        // Server 控制命令直接位于根命令；误加 server 会落入旧 CLI，无法取得运行任务。
        const beforeRelease = await runSSHCommand(
          prepared.config,
          '"$HOME/.zcode/server/bin/zcode" running-tasks --json',
        );
        expect(beforeRelease.code).toBe(0);
        expect(beforeRelease.stdout).toContain(task.taskId);
        facts.runningWhileDesktopClosed = true;
        const release = await fetch(`${replayBase}/__e2e__/release/ssh-exit-slow`, {
          method: "POST",
          signal: AbortSignal.timeout(5000),
        });
        expect(release.status).toBe(204);
        const deadline = Date.now() + 90_000;
        let result = beforeRelease;
        do {
          result = await runSSHCommand(
            prepared.config,
            '"$HOME/.zcode/server/bin/zcode" running-tasks --json',
          );
          if (result.code === 0 && !result.stdout.includes(task.taskId)) break;
          await delay(200);
        } while (Date.now() < deadline);
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain(task.taskId);
        const coreAfter = await readRemoteCoreIdentity(prepared.config, MARKER);
        expect(coreAfter.pid).toBe(coreBefore.pid);
        expect(coreAfter.startTicks).toBe(coreBefore.startTicks);
        facts.completedWhileDesktopClosedAt = new Date().toISOString();
      },
    });
    await waitForRendererAfterColdRestart(MARKER);
    const tab = await waitForRemoteTab({
      caseMarker: MARKER,
      expectedIdentity: task.identity,
      expectedPath: task.workspacePath,
      timeoutMs: 180_000,
    });
    expect(tab.remoteSessionId).not.toBe(task.remoteSessionId);
    task.remoteSessionId = tab.remoteSessionId!;
    // 旧断言误把冷启动当作原地重连；冷启动进入草稿，历史由用户显式打开。
    await waitForV4Pane((state) => state.sessionId === "draft", "冷启动没有进入项目草稿");
    await selectV4TaskById(task.taskId, 60_000);
    await waitForV4TimelineContaining("SSH_EXIT_STREAMING");
    await waitForV4ConversationState(
      (state) => state.taskId === task.taskId && state.state === "idle",
      "重开后原任务没有恢复终态",
    );
    expect(
      (await getV4Messages("user")).filter((message) => message.text?.includes(prompt)),
    ).toHaveLength(1);
    expect(
      await countUpstreamRequests({
        lastUserMessageIncludes: [prompt],
        excludes: ["Generate a concise title"],
      }),
    ).toBe(1);
    await sendSSHFollowTurn(task, MARKER);
    facts.originalTaskContinued = task.taskId;
  });
});
