import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { openProjectMenuAction, waitForProjectRowGone } from "#e2e/helpers/project-sidebar";
import { getPassiveAgentStartupWorkspacePaths } from "#e2e/helpers/passive-agent-startup-fixture";
import {
  openWorkspaceDraftFromSidebar,
  waitForRestoredProjects,
} from "#e2e/helpers/workspace-agent-warmup";
import { selectUpstreamModel, selectUpstreamThoughtLevel } from "#e2e/helpers/upstream-provider";
import {
  getV4PaneSnapshot,
  sendV4Prompt,
  waitForV4ComposerText,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";
import {
  collectProcessTreeByRootPids,
  listSystemProcesses,
} from "#e2e/helpers/e2e-process-cleanup";

const MARKER = "E2E_WORKSPACE_REMOVAL_RUNTIME_RELEASE";
const REPLY = "WRL_HISTORY_PRESERVED";

describe("项目软删除与应用退出 E2E", () => {
  after(async () => {
    await clearAppData();
  });

  it("WRL01: 删除项目保留会话，退出后释放进程树和目录占用", async function () {
    this.timeout(150000);
    const { homeDir } = getE2EAppDataPaths();
    const workspacePaths = getPassiveAgentStartupWorkspacePaths(homeDir, 2);
    const removable = workspacePaths[0];
    const active = workspacePaths[1];
    if (!removable || !active) throw new Error("WRL01: 缺少 workspace fixture");
    await writeFile(join(removable, "wrl-lock-probe.txt"), "runtime release probe", "utf8");
    await waitForWorkspaceApp(active, 30000);
    await waitForRestoredProjects(workspacePaths, 30000);
    await openWorkspaceDraftFromSidebar(removable);
    // 本例使用两个专用目录，不能调用强制等待默认 ZCodeProject 的通用准备入口。
    await selectUpstreamModel();
    await selectUpstreamThoughtLevel();
    await sendV4Prompt(`${MARKER}: reply exactly ${REPLY}`);
    await waitForV4ComposerText("", "WRL01 首发未接受");
    await waitForV4AssistantMessageContaining(REPLY);
    await waitForV4ConversationState((state) => state.state === "idle", "WRL01 历史未完成");
    const taskId = (await getV4PaneSnapshot()).sessionId;
    if (!taskId || taskId === "draft") throw new Error("WRL01: 未创建真实会话");

    // 当前删除只软删项目容器；旧用例立即要求 Agent 归零，混淆了容器和会话生命周期。
    await openProjectMenuAction(removable, "delete", { timeout: 30000 });
    await waitForProjectRowGone(removable, { timeout: 30000 });
    // 已完成任务删除项目无需确认，当前打开的会话内容仍应保持可读。
    await waitForV4AssistantMessageContaining(REPLY);
    expect((await getV4PaneSnapshot()).sessionId).toBe(taskId);

    const mainPid = await browser.electron.execute(() => process.pid);
    const treePids = collectProcessTreeByRootPids(await listSystemProcesses(), [mainPid]).map(
      (item) => item.pid,
    );
    expect(treePids).toContain(mainPid);
    await browser.electron.execute((electron) => electron.app.quit());
    // 运行时证据：Main 已退出却暂留 Z/<defunct>，直到 ChromeDriver DELETE session 回收。
    // kill(pid, 0) 会把僵尸进程当存活；它已无目录句柄，按真实进程状态等待，不能强杀转绿。
    await browser.waitUntil(
      async () => {
        const remaining = (await listSystemProcesses()).filter(
          (item) => treePids.includes(item.pid) && !item.command.endsWith("<defunct>"),
        );
        return remaining.length === 0;
      },
      { timeout: 15000, interval: 100, timeoutMsg: "WRL01: 应用退出后仍有活跃进程" },
    );
    if (process.platform !== "win32") {
      const state = await promisify(execFile)("ps", [
        "-p",
        treePids.join(","),
        "-o",
        "pid=,ppid=,stat=,command=",
      ]).then(
        (result) => result.stdout,
        () => "所有跟踪进程已被回收",
      );
      await writeFile(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "quit-process-state.txt"), state);
    }
    const renamed = `${removable}-renamed`;
    // 进程退出屏障之后只操作一次，禁止靠重命名重试掩盖资源未释放。
    await rename(removable, renamed);
    await rm(renamed, { recursive: true });
  });
});
