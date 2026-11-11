import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity, providerProvisioningResultSchema } from "@zcode/shared";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  createSSHLifecycleProvider,
  SSH_LIFECYCLE_MODEL_ID,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  openSSHSourceDirectory,
  readDualSSHRuntimeConfig,
  readHostProcesses,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
  runSSHCommand,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  completeSSHProjectConnection,
  waitForSSHDirectoryStep,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import {
  getV4ConversationState,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_ENTRY_ATTRIBUTION";
const REPLY = "R3_ENTRY_ATTRIBUTION_REPLY";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-entry-attribution",
);

async function readProvisioningApplied(config: SSHConnectionConfig): Promise<number> {
  const result = await runSSHCommand(
    config,
    'cat "$HOME/.zcode/v2/runtime/provider/provisioning.json"',
  );
  // 旧路径不存在时 before/after 都变成 0，会让整个同步断言假通过。
  expect(result.code).toBe(0);
  const state: unknown = JSON.parse(result.stdout);
  if (
    !state ||
    typeof state !== "object" ||
    !("records" in state) ||
    !Array.isArray(state.records)
  ) {
    throw new Error(`${CASE_MARKER}: 远端 Provisioning journal 缺少 records`);
  }
  // journal 每项为 { syncId, result }；status 在 result 中，不能把真实成功记录误计为零。
  return state.records.filter((record) => {
    if (!record || typeof record !== "object" || !("result" in record)) {
      throw new Error(`${CASE_MARKER}: 远端 Provisioning record 缺少 result`);
    }
    const result = providerProvisioningResultSchema.parse(record.result);
    expect(result.syncId).toBe(record.syncId);
    return result.status === "applied";
  }).length;
}

async function readActiveDraftTarget(): Promise<{
  identity: string | null;
  path: string | null;
  sourceId: string | null;
}> {
  const active = await readRemoteTabSnapshot();
  const identity = active.activeWorkspaceIdentity;
  return {
    identity,
    path: active.activeWorkspacePath,
    sourceId: identity ? (parseRemoteWorkspaceIdentity(identity)?.sourceServerId ?? null) : null,
  };
}

async function sendAndResolve(marker: string): Promise<string> {
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

describe(`${CASE_MARKER}: 两个 Source 下全局新建/项目入口的目标归属与同 Environment 第二项目`, () => {
  let providerA: SSHLifecycleProvider | null = null;
  let providerB: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "entry-attribution.json"), JSON.stringify(facts, null, 2));
    await providerA?.tunnel.close().catch(() => undefined);
    await providerB?.tunnel.close().catch(() => undefined);
    providerA = null;
    providerB = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-ID-05/PRV-03 全局新建本地未分类任务、项目新建保持跨 Source 归属；同 Environment 第二项目共 lane 无第二首连写入", async function () {
    this.timeout(35 * 60_000);
    const dual = readDualSSHRuntimeConfig(CASE_MARKER);
    const [targetA, targetB] = dual.targets;
    const paths = readSSHRuntimeConfig(CASE_MARKER).workspacePaths;
    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    expect(initialHosts).toHaveLength(1);

    // Source A：有项目 a（含 task）。
    providerA = await createSSHLifecycleProvider(targetA, `${CASE_MARKER}_A`, {
      tunnelUsername: "tunnel",
    });
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: targetA,
      label: "A",
      provider: providerA,
      workspacePath: paths[0],
    });
    const sourceA = parseRemoteWorkspaceIdentity(taskA.identity)?.sourceServerId ?? "";
    expect(sourceA).toBeTruthy();

    // Source B：同路径独立项目。
    providerB = await createSSHLifecycleProvider(targetB, `${CASE_MARKER}_B`, {
      tunnelUsername: "tunnel",
    });
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(targetB);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    // B 是全新容器：首连必须经过“安装并继续”确认（inline 在 connecting 步骤），
    // 且 connect-and-chat 完成时向导整体收起。缺这一步时安装确认悬挂，B 的
    // conversation 永远打不开（0910 实锤：submit 后 300ms 出 install-required，无人点击）。
    await waitForSSHDirectoryStep(CASE_MARKER);
    const convB = await completeSSHProjectConnection(
      { ...targetB, workspacePaths: paths },
      CASE_MARKER,
    );
    const sourceB = parseRemoteWorkspaceIdentity(convB.workspaceIdentity!)?.sourceServerId ?? "";
    expect(sourceB).toBeTruthy();
    expect(sourceB).not.toBe(sourceA);
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: providerB.id,
      providerName: providerB.name,
    });
    await selectUpstreamThoughtLevelValue("disabled");
    const convBTask = await sendAndResolve(`${CASE_MARKER}_B_CONV`);
    facts.sources = {
      sourceA,
      sourceB,
      projectA: taskA.identity,
      conversationB: convB.workspaceIdentity,
    };
    const appliedBBefore = await readProvisioningApplied(targetB);
    expect(appliedBBefore).toBeGreaterThan(0);

    // ID-05 ①：未归类入口是本地对照；远程项目内新建必须显式选择 Source A 项目。
    await selectV4TaskById(taskA.taskId);
    // 左上角新建继承当前项目；任务分区加号明确创建本地未归类草稿。
    await $('[data-testid="virtual-project-new-task"]').click();
    await browser.waitUntil(async () => (await readActiveDraftTarget()).identity === null);
    const localDraft = await readActiveDraftTarget();
    facts.globalNewTaskDraft = localDraft;
    expect(localDraft.identity).toBeNull();
    expect(localDraft.sourceId).toBeNull();
    await startDraftFromProject(paths[0], { workspaceIdentity: taskA.identity });
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: providerA.id,
      providerName: providerA.name,
    });
    await selectUpstreamThoughtLevelValue("disabled");
    const globalDraft = await readActiveDraftTarget();
    facts.projectNewTaskDraft = globalDraft;
    expect(globalDraft.identity).toBe(taskA.identity);
    expect(globalDraft.path).toBe(paths[0]);
    const globalTask = await sendAndResolve(`${CASE_MARKER}_GLOBAL`);
    const globalTab = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: paths[0],
    });
    expect(globalTab.remoteSessionId).toBe(taskA.remoteSessionId);
    facts.projectNewTask = { taskId: globalTask, identity: globalTab.workspaceIdentity };

    // ID-05 ②：激活 B 后新建仍归属 B 项目，不能回落到 A 的同路径项目。
    await selectV4TaskById(convBTask);
    await startDraftFromProject(paths[0], { workspaceIdentity: convB.workspaceIdentity! });
    const devBDraft = await readActiveDraftTarget();
    facts.deviceBDraft = devBDraft;
    expect(devBDraft.sourceId).toBe(sourceB);
    expect(devBDraft.identity).toBe(convB.workspaceIdentity);
    expect(devBDraft.identity).not.toBe(taskA.identity);
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: providerB.id,
      providerName: providerB.name,
    });
    await selectUpstreamThoughtLevelValue("disabled");
    const devBTask = await sendAndResolve(`${CASE_MARKER}_DEVB`);
    const devBState = await getV4ConversationState();
    facts.deviceBTask = {
      taskId: devBTask,
      state: devBState.state,
      previousConversationTask: convBTask,
    };
    expect(devBTask).not.toBe(convBTask);
    const devBTab = await readRemoteTabSnapshot(convB.workspaceIdentity!);
    expect(devBTab.activeWorkspaceIdentity).toBe(convB.workspaceIdentity);

    // ID-05 ③：切回 A 后新建仍归属 A，复用其项目 attachment。
    await selectV4TaskById(taskA.taskId);
    await startDraftFromProject(paths[0], { workspaceIdentity: taskA.identity });
    const devADraft = await readActiveDraftTarget();
    facts.deviceADraft = devADraft;
    expect(devADraft.sourceId).toBe(sourceA);
    expect(devADraft.identity).toBe(taskA.identity);
    expect(parseRemoteWorkspaceIdentity(devADraft.identity ?? "")?.workspacePath ?? null).toBe(
      paths[0],
    );
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: providerA.id,
      providerName: providerA.name,
    });
    await selectUpstreamThoughtLevelValue("disabled");
    const devATask = await sendAndResolve(`${CASE_MARKER}_DEVA`);
    const devATab = await readRemoteTabSnapshot(devADraft.identity!);
    facts.deviceATask = {
      taskId: devATask,
      identity: devATab.workspaceIdentity,
      remoteSessionId: devATab.remoteSessionId,
      projectRemoteSessionId: taskA.remoteSessionId,
    };
    expect(devATab.remoteSessionId).toBeTruthy();
    expect(devATab.remoteSessionId).toBe(taskA.remoteSessionId);

    // PRV-03：Source B 已有 Environment（conversation 在线），打开第二项目 b → 共 lane，provisioning 不再写第二次首连。
    await openSSHSourceDirectory(targetB, CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(paths[1], CASE_MARKER);
    const projectB = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: paths[1],
      timeoutMs: 120_000,
    });
    expect(parseRemoteWorkspaceIdentity(projectB.workspaceIdentity!)?.sourceServerId).toBe(sourceB);
    await browser.pause(5_000);
    const appliedBAfter = await readProvisioningApplied(targetB);
    const coreB = await runSSHCommand(
      targetB,
      'tr -d "\\n " < "$HOME/.zcode/server/run/status.json" | cut -c1-200; pgrep -fc "app-server --stdio" || true',
    );
    facts.secondProjectOnB = {
      identity: projectB.workspaceIdentity,
      remoteSessionId: projectB.remoteSessionId,
      provisioningApplied: { before: appliedBBefore, after: appliedBAfter },
      remoteStatus: coreB.stdout.trim().split("\n"),
    };
    expect(appliedBAfter).toBe(appliedBBefore);
    expect(await readHostProcesses()).toEqual(initialHosts);
  });
});
