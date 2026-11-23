import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TID_WORKSPACE_PATH } from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  SSH_LIFECYCLE_MODEL_ID,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  prepareSSHConnectionPage,
  readRemoteTabSnapshot,
  runSSHCommand,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";

const CASE_MARKER = "E2E_RPN_SAME_PATH_LOCAL_TASK";
const REPLY = "RPN_SAME_PATH_LOCAL_TASK_REPLY";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/rpn-same-path-local-task",
);

interface TabRow {
  id: string;
  workspacePath: string | null;
  workspaceIdentity: string | null;
  remoteSessionId: string | null;
}

function readTabs(): Promise<{
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  tabs: TabRow[];
}> {
  return browser.execute(() => {
    const state = (
      window as Window & {
        __zcodeTabStoreE2E?: {
          getState(): {
            activeWorkspacePath: string | null;
            activeWorkspaceIdentity: string | null;
            tabs: Array<{
              id: string;
              kind: string;
              workspacePath?: string;
              workspaceIdentity?: string;
              remoteSessionId?: string;
            }>;
          };
        };
      }
    ).__zcodeTabStoreE2E?.getState();
    if (!state) throw new Error("导航 store 未就绪");
    return {
      activeWorkspacePath: state.activeWorkspacePath,
      activeWorkspaceIdentity: state.activeWorkspaceIdentity,
      tabs: state.tabs
        .filter((tab) => tab.kind === "workspace")
        .map((tab) => ({
          id: tab.id,
          workspacePath: tab.workspacePath ?? null,
          workspaceIdentity: tab.workspaceIdentity ?? null,
          remoteSessionId: tab.remoteSessionId ?? null,
        })),
    };
  });
}

/** Header 的工作区按钮：远程 workspace 才渲染设备名，本地只显示文件夹图标。 */
function readHeaderWorkspace(): Promise<{ path: string | null; device: string | null }> {
  return browser.execute((testId) => {
    const button = document.querySelector(`[data-testid="${testId}"]`);
    return {
      path: button?.getAttribute("data-workspace-abs-path") ?? null,
      device: button?.querySelector("[data-workspace-device-name]")?.textContent ?? null,
    };
  }, TID_WORKSPACE_PATH);
}

async function sendLocalTurn(marker: string): Promise<string> {
  const start = await getUpstreamRequestRecordCount();
  await sendV4PromptAndWaitAccepted(
    `${marker} 只回复 ${REPLY}`,
    marker,
    `${CASE_MARKER}: ${marker} 未被接受`,
  );
  const running = await waitForV4ConversationState(
    (s) => Boolean(s.taskId && s.taskId !== "draft"),
    `${CASE_MARKER}: ${marker} 没有产生 task`,
    60_000,
  );
  await waitForUpstreamRequest(
    { lastUserMessageIncludes: [marker] },
    `${CASE_MARKER}: ${marker} 没有到达回放`,
    90_000,
    { afterIndex: start - 1 },
  );
  await waitForV4AssistantMessageContaining(REPLY, 90_000);
  await waitForV4ConversationState(
    (s) => s.taskId === running.taskId && s.state === "idle",
    `${CASE_MARKER}: ${marker} 没有收口`,
    90_000,
  );
  return running.taskId!;
}

/** 远端建出与本机 E2E 项目相同的绝对路径；非 root 账号经免密 sudo 创建后交还所有权。 */
async function createRemoteSamePath(config: SSHConnectionConfig, path: string): Promise<boolean> {
  const quoted = `'${path.replaceAll("'", "'\\''")}'`;
  const existed = await runSSHCommand(config, `test -e ${quoted}`);
  if (existed.code === 0) return false;
  const created = await runSSHCommand(
    config,
    `mkdir -p -- ${quoted} 2>/dev/null || { sudo -n mkdir -p -- ${quoted} && sudo -n chown "$(id -u):$(id -g)" -- ${quoted}; }`,
  );
  expect(created.code).toBe(0);
  return true;
}

describe(`${CASE_MARKER}: 本地与远程项目同路径时点击本地任务`, () => {
  let provider: SSHLifecycleProvider | null = null;
  let remoteCleanup: (() => Promise<unknown>) | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    facts.final = await readTabs().catch((error: unknown) => String(error));
    await writeFile(
      resolve(artifactDir, "same-path-local-task.json"),
      JSON.stringify(facts, null, 2),
    );
    await browser.saveScreenshot(resolve(artifactDir, "same-path-local-task.png"));
    await remoteCleanup?.().catch(() => undefined);
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("RPN-25 远程同路径 tab 在前时，点击本地任务打开本地任务，远程任务不受影响", async function () {
    this.timeout(20 * 60_000);
    await prepareSSHConnectionPage(CASE_MARKER);
    // 本地任务也要走同一个 replay provider；镜像端口让本机直接命中 baseURL。
    const prepared = await prepareSSHLifecycle(CASE_MARKER, {
      tunnelUsername: "tunnel",
      mirrorLocalPort: true,
    });
    provider = prepared.provider;

    // ① 本地项目先产生一个任务。
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: provider.id,
      providerName: provider.name,
    });
    await selectUpstreamThoughtLevelValue("disabled");
    const localTaskId = await sendLocalTurn(`${CASE_MARKER}_LOCAL`);
    expect((await readTabs()).activeWorkspaceIdentity).toBeNull();

    // ② 远端打开同一绝对路径的项目并产生任务；新 tab 排在本地 tab 前面。
    if (await createRemoteSamePath(prepared.config, DEFAULT_WORKSPACE)) {
      const quoted = `'${DEFAULT_WORKSPACE.replaceAll("'", "'\\''")}'`;
      remoteCleanup = () =>
        runSSHCommand(
          prepared.config,
          `rm -rf -- ${quoted} 2>/dev/null || sudo -n rm -rf -- ${quoted}`,
        );
    }
    const remoteTask = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: DEFAULT_WORKSPACE,
    });
    const before = await readTabs();
    facts.before = { localTaskId, remoteTask, tabs: before };
    const localIndex = before.tabs.findIndex(
      (tab) => tab.workspacePath === DEFAULT_WORKSPACE && !tab.workspaceIdentity,
    );
    const remoteIndex = before.tabs.findIndex(
      (tab) => tab.workspaceIdentity === remoteTask.identity,
    );
    // 前置条件：同路径远程 tab 排在本地 tab 之前，只按路径匹配就会先命中远程 tab。
    expect(localIndex).toBeGreaterThanOrEqual(0);
    expect(remoteIndex).toBeGreaterThanOrEqual(0);
    expect(remoteIndex).toBeLessThan(localIndex);
    expect(before.activeWorkspaceIdentity).toBe(remoteTask.identity);

    // ③ 点击本地任务：必须激活本地 tab 并打开本地任务。
    await selectV4TaskById(localTaskId, 30_000);
    const afterLocal = await readTabs();
    const headerLocal = await readHeaderWorkspace();
    facts.afterLocal = { ...afterLocal, header: headerLocal };
    expect(afterLocal.activeWorkspacePath).toBe(DEFAULT_WORKSPACE);
    expect(afterLocal.activeWorkspaceIdentity).toBeNull();
    // Header 也要按本地 tab 展示，不能沿用同路径远程 tab 的设备标记。
    expect(headerLocal).toEqual({ path: DEFAULT_WORKSPACE, device: null });
    const remoteAfterLocal = await readRemoteTabSnapshot(remoteTask.identity, DEFAULT_WORKSPACE);
    expect(remoteAfterLocal.remoteSessionId).toBe(remoteTask.remoteSessionId);

    // ④ 来回切换：远程任务仍打开远程 tab，再回到本地任务仍正确。
    await selectV4TaskById(remoteTask.taskId, 30_000);
    const afterRemote = await readTabs();
    const headerRemote = await readHeaderWorkspace();
    facts.afterRemote = { ...afterRemote, header: headerRemote };
    expect(afterRemote.activeWorkspaceIdentity).toBe(remoteTask.identity);
    expect(headerRemote.path).toBe(DEFAULT_WORKSPACE);
    expect(headerRemote.device).toBeTruthy();
    await selectV4TaskById(localTaskId, 30_000);
    const afterLocalAgain = await readTabs();
    const headerLocalAgain = await readHeaderWorkspace();
    facts.afterLocalAgain = { ...afterLocalAgain, header: headerLocalAgain };
    expect(afterLocalAgain.activeWorkspacePath).toBe(DEFAULT_WORKSPACE);
    expect(afterLocalAgain.activeWorkspaceIdentity).toBeNull();
    expect(headerLocalAgain).toEqual({ path: DEFAULT_WORKSPACE, device: null });
  });
});
