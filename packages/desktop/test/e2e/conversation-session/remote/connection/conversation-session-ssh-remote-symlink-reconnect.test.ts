import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  disconnectRemoteSource,
  requestRemoteProjectConnection,
} from "#e2e/helpers/remote-project-actions";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  waitForRendererAfterColdRestart,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  prepareSSHConnectionPage,
  readRemoteTabSnapshot,
  runSSHCommand,
  waitForRemoteTab,
  type SSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";
import {
  selectV4TaskById,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_SSH_P0_SYMLINK_RECONNECT";

describe(`${CASE_MARKER}: SSH symlink project path reconnect`, () => {
  let provider: SSHLifecycleProvider | null = null;
  let config: SSHRuntimeConfig | null = null;
  let caseRoot: string | null = null;

  after(async () => {
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    if (config && caseRoot) {
      await runSSHCommand(config, `rm -rf '${caseRoot}'`).catch(() => undefined);
    }
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-P0-LIFE-04 symlink 项目路径的手动重连与冷启动挂回都保持原路径", async function () {
    this.timeout(30 * 60_000);
    await prepareSSHConnectionPage(CASE_MARKER);
    const prepared = await prepareSSHLifecycle(CASE_MARKER);
    provider = prepared.provider;
    config = prepared.config;

    // 用户现场：项目根目录是 symlink（例如 /home/dev/projects/app → /data/projects/app），
    // 项目按 link 路径创建；重连若改用 realpath 会 bind 到另一个 identity。
    caseRoot = `${prepared.config.workspacePaths[0]}/e2e-symlink-reconnect`;
    const realPath = `${caseRoot}/real`;
    const linkPath = `${caseRoot}/link`;
    const setup = await runSSHCommand(
      prepared.config,
      `rm -rf '${caseRoot}' && mkdir -p '${realPath}' && ln -s '${realPath}' '${linkPath}' && readlink -f '${linkPath}'`,
    );
    expect(setup.code).toBe(0);
    const resolvedRealPath = setup.stdout.trim();
    expect(resolvedRealPath).not.toBe(linkPath);

    const task = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: linkPath,
    });
    const parsed = parseRemoteWorkspaceIdentity(task.identity);
    expect(parsed?.kind).toBe("server");
    expect(parsed?.workspacePath).toBe(linkPath);
    const sourceId = parsed?.kind === "server" ? parsed.sourceServerId : undefined;
    expect(sourceId).toBeTruthy();
    await selectTaskOrganizeMode(["项目", "Project"]);

    // 1. 原地重连：设置页断开后，项目菜单“连接”经 Renderer 重连 helper 挂回。
    await disconnectRemoteSource(sourceId!, CASE_MARKER, {
      workspaceIdentities: [task.identity],
    });
    await requestRemoteProjectConnection(task.identity, CASE_MARKER);
    const manual = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: task.identity,
      expectedPath: linkPath,
    });
    expect(manual.remoteSessionId).not.toBe(task.remoteSessionId);
    expect((await readRemoteTabSnapshot(undefined, resolvedRealPath)).workspacePath).toBeNull();
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === task.taskId,
      `${CASE_MARKER}: 原地重连没有保留原会话`,
      60_000,
    );
    await waitForV4AssistantMessageContaining(task.firstReply);

    // 2. 冷启动：Source 上线后的自动挂回同样走重连 helper，不能改写成 realpath。
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await waitForRendererAfterColdRestart(CASE_MARKER);
    const restored = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: task.identity,
      expectedPath: linkPath,
      requireActive: false,
    });
    expect(restored.remoteSessionId).not.toBe(manual.remoteSessionId);
    expect((await readRemoteTabSnapshot(undefined, resolvedRealPath)).workspacePath).toBeNull();
    await selectV4TaskById(task.taskId, 60_000);
    await waitForV4AssistantMessageContaining(task.firstReply);
  });
});
