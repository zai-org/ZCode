import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import {
  refreshSeededOpenAIProvidersThroughSettings,
  seedCustomOpenAIChatCompletionsProvider,
} from "#e2e/helpers/custom-openai-provider";
import { resolveSeededReplayBaseUrl } from "#e2e/helpers/custom-openai-provider-store";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";
import {
  beginConversationTelemetryCapture,
  waitForConversationReportInventory,
} from "#e2e/helpers/conversation-telemetry-parity-capture";
import {
  clickLastEnabledSSHDialogButton,
  createSSHReplayTunnel,
  readHostProcesses,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  openSSHSourceDirectory,
  runSSHCommand,
  selectSSHRemoteDirectory,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";
import { readProjectTaskRowState, type ProjectTaskRowState } from "#e2e/helpers/project-sidebar";

const CASE_MARKER = "R1_SSH_P0_01";
const PROMPT_MARKER = "E2E_SSH_REMOTE_P0";
const MODEL_ID = "e2e-ssh-remote-p0-model";
const WORKSPACE_READY_TIMEOUT_MS = 2 * 60_000;
const TURN_TIMEOUT_MS = 2 * 60_000;

interface SSHRuntimeConfig {
  host: string;
  password: string;
  port: number;
  username: string;
  workspacePaths: readonly [string, string];
}

interface RemoteTabSnapshot {
  activeWorkspaceIdentity: string | null;
  activeWorkspacePath: string | null;
  remoteHost: string | null;
  remoteKind: string | null;
  remoteSessionId: string | null;
  secretPersistedInTab: boolean;
  workspaceIdentity: string | null;
  workspacePath: string | null;
}

interface ReplayTunnel {
  baseURL: string;
  close(): Promise<void>;
}

interface TaskCase {
  firstPrompt: string;
  firstReply: string;
  followPrompt: string;
  followReply: string;
  identity: string;
  label: "A" | "B";
  remoteSessionId: string;
  taskId: string;
  workspacePath: string;
}

const runningRowMismatches: Array<{
  taskId: string;
  label: string;
  observed: ProjectTaskRowState;
}> = [];

describe(`${CASE_MARKER}: SSH remote workspace P0`, () => {
  let replayTunnel: ReplayTunnel | null = null;

  after(async () => {
    await replayTunnel?.close();
    replayTunnel = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R1-SSH-P0-01 在两个 SSH workspace 各自首发，并切回 task 续发", async function () {
    this.timeout(20 * 60_000);
    runningRowMismatches.length = 0;
    const config = readSSHRuntimeConfig();
    const [workspaceA, workspaceB] = config.workspacePaths;

    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    expect(initialHosts).toHaveLength(1);
    const telemetryCapture = await beginConversationTelemetryCapture();

    replayTunnel = await createReplayTunnel(config);
    const previousReplayBaseURL = process.env.E2E_PROVIDER_RUNTIME_BASE_URL;
    let provider: { id: string; name: string };
    process.env.E2E_PROVIDER_RUNTIME_BASE_URL = replayTunnel.baseURL;
    try {
      provider = await seedCustomOpenAIChatCompletionsProvider({
        modelId: MODEL_ID,
        providerId: "e2e-ssh-remote-p0-provider",
        providerName: "SSH Remote P0",
      });
      await refreshSeededOpenAIProvidersThroughSettings([provider.name]);
    } finally {
      if (previousReplayBaseURL === undefined) {
        delete process.env.E2E_PROVIDER_RUNTIME_BASE_URL;
      } else {
        process.env.E2E_PROVIDER_RUNTIME_BASE_URL = previousReplayBaseURL;
      }
    }

    const provisioningRecordsBeforeConnect = await readProvisioningRecordCount(config);
    const runtimeLogCursor = await captureRuntimeLogCursor();

    const taskA = await connectWorkspaceAndSendFirstTurn({
      config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const provisioningRecordsAfterFirstWorkspace = await waitForProvisioningRecordCountGreaterThan(
      config,
      provisioningRecordsBeforeConnect,
    );
    const taskB = await connectWorkspaceAndSendFirstTurn({
      config,
      label: "B",
      provider,
      workspacePath: workspaceB,
    });

    // 修复原因：Provisioning 的同步身份是 Remote Environment，不是 Workspace。
    // 同一 SSH Environment 打开第二个目录时必须复用已经完成的同步，不能再写一条记录。
    expect(await readProvisioningRecordCount(config)).toBe(provisioningRecordsAfterFirstWorkspace);

    expect(taskA.remoteSessionId).not.toBe(taskB.remoteSessionId);
    expect(await readHostProcesses()).toEqual(initialHosts);

    await switchTaskAndSendFollowTurn(taskA, taskB.firstPrompt);
    await switchTaskAndSendFollowTurn(taskB, taskA.firstPrompt);

    await assertTaskRow(taskA, { active: false, running: false });
    await assertTaskRow(taskB, { active: true, running: false });
    expect(await readHostProcesses()).toEqual(initialHosts);
    // Bug 回归（3.16.2 远程发送卡顿）：远程 workspace 曾把高速卡与闲时任务请求发到远端，
    // 远端没有这两个频道，每次发送先等满 Host ChannelServer 的 1000ms 未知频道超时。
    // 三者只在本地生效：worktree 创建记录也必须读 base Host，不能因切到远程任务而误发订阅。
    // 四次远程发送与期间的后台查询不得出现这些未知频道超时。
    expect(
      await runtimeLogCursor.newLines(
        /Unknown channel: (?:highspeed-card|off-peak-task|managed-worktrees)\b/u,
      ),
    ).toEqual([]);
    expect(await runtimeLogCursor.newLines(/getCurrentOwnerKey.*is not a function/u)).toEqual([]);

    const reports = await waitForConversationReportInventory(telemetryCapture, {
      agent_step: 4,
      message_completion: 4,
    });
    for (const task of [taskA, taskB]) {
      const taskReports = reports.filter((report) => report.talk_id === task.taskId);
      expect(taskReports.filter((report) => report.element_name === "agent_step")).toHaveLength(2);
      expect(
        taskReports.filter((report) => report.element_name === "message_completion"),
      ).toHaveLength(2);
      for (const report of taskReports.filter(
        (candidate) =>
          candidate.element_name === "agent_step" ||
          candidate.element_name === "message_completion",
      )) {
        // 遥测合同（docs/monitoring/conversation-telemetry-v4.md）：remote_kind 由稳定 workspace
        // identity 经 parseRemoteWorkspaceIdentity 解析，R3 Source Server 工作区的 identity kind 是
        // "server"（上方 waitForRemoteTab 亦按此断言）；SSH 只是物理线路，不是该字段的取值。
        expect(report.event_extra_detail).toMatchObject({
          workspace_kind: "remote",
          remote_kind: "server",
        });
      }
    }
    process.stdout.write(
      `[${CASE_MARKER}] telemetry ${JSON.stringify(
        [taskA, taskB].map((task) => {
          const taskReports = reports.filter((report) => report.talk_id === task.taskId);
          return {
            agentStepCount: taskReports.filter((report) => report.element_name === "agent_step")
              .length,
            completionCount: taskReports.filter(
              (report) => report.element_name === "message_completion",
            ).length,
            taskId: task.taskId,
          };
        }),
      )}\n`,
    );
    expect(runningRowMismatches).toEqual([]);
  });
});

/** 只看游标之后新增的 Host/Main 运行日志，避免把启动期的日志算进本次断言。 */
async function captureRuntimeLogCursor() {
  const root = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR!);
  const read = async () => {
    const names = (await readdir(root)).filter((name) => name.endsWith(".log"));
    return new Map(
      await Promise.all(
        names.map(async (name) => [name, await readFile(join(root, name), "utf8")] as const),
      ),
    );
  };
  const before = await read();
  return {
    async newLines(pattern: RegExp): Promise<string[]> {
      const after = await read();
      return [...after]
        .flatMap(([name, text]) => text.slice(before.get(name)?.length ?? 0).split("\n"))
        .filter((line) => pattern.test(line));
    },
  };
}

async function readProvisioningRecordCount(config: SSHRuntimeConfig): Promise<number> {
  const result = await runSSHCommand(
    config,
    'if [ -f "$HOME/.zcode/v2/runtime/provider/provisioning.json" ]; then cat "$HOME/.zcode/v2/runtime/provider/provisioning.json"; else printf \'{"records":[]}\'; fi',
  );
  if (result.code !== 0) {
    throw new Error(`${CASE_MARKER}: 读取远端 Provisioning 状态失败：${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout) as { records?: unknown };
  if (!Array.isArray(parsed.records)) {
    throw new Error(`${CASE_MARKER}: 远端 Provisioning 状态缺少 records`);
  }
  return parsed.records.length;
}

async function waitForProvisioningRecordCountGreaterThan(
  config: SSHRuntimeConfig,
  baseline: number,
): Promise<number> {
  let observed = baseline;
  await browser.waitUntil(
    async () => {
      observed = await readProvisioningRecordCount(config);
      return observed > baseline;
    },
    {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: `${CASE_MARKER}: 首个远端 Workspace 没有完成 Provisioning`,
    },
  );
  return observed;
}

function readSSHRuntimeConfig(): SSHRuntimeConfig {
  const host = requireSecretEnv("ZCODE_E2E_SSH_HOST");
  const username = requireSecretEnv("ZCODE_E2E_SSH_USERNAME");
  const password = requireSecretEnv("ZCODE_E2E_SSH_PASSWORD");
  const portText = process.env.ZCODE_E2E_SSH_PORT?.trim() || "22";
  const port = Number.parseInt(portText, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${CASE_MARKER}: ZCODE_E2E_SSH_PORT 必须是 1..65535 的整数`);
  }

  const workspacePaths = (
    process.env.ZCODE_E2E_SSH_WORKSPACE_PATHS?.split(",") ?? ["/root", "/home"]
  )
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    workspacePaths.length !== 2 ||
    workspacePaths.some((value) => !value.startsWith("/")) ||
    workspacePaths[0] === workspacePaths[1]
  ) {
    throw new Error(`${CASE_MARKER}: ZCODE_E2E_SSH_WORKSPACE_PATHS 必须是两个不同的绝对路径`);
  }

  return {
    host,
    password,
    port,
    username,
    workspacePaths: [workspacePaths[0]!, workspacePaths[1]!],
  };
}

function requireSecretEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${CASE_MARKER}: 缺少 ${name}`);
  }
  return value;
}

async function connectWorkspaceAndSendFirstTurn(options: {
  config: SSHRuntimeConfig;
  label: "A" | "B";
  provider: { id: string; name: string };
  workspacePath: string;
}): Promise<TaskCase> {
  // Bug 原因：本 spec 曾自带一份 SSH 向导轮询副本，只认独立 ConfirmDialog 的安装确认和
  // 目录页；产品已把安装确认内联到连接步骤（“安装并继续”），副本可能等满连接超时。
  // 统一复用 helpers/ssh-remote-p0.ts 的共享流程，与 connection-p0 / soak-dual 保持同一状态机。
  await openSSHRemoteDialog(CASE_MARKER);
  await fillSSHPasswordSettings(options.config);
  await clickLastEnabledSSHDialogButton(CASE_MARKER);
  const flow = await waitForSSHDirectoryStep(CASE_MARKER);
  if (flow === "closed") {
    // 向导已收起：从已注册设备行进入目录选择，追加 project workspace。
    await openSSHSourceDirectory(options.config, CASE_MARKER);
  }
  await selectSSHRemoteDirectory(options.workspacePath, CASE_MARKER);
  await waitForWorkspaceApp(options.workspacePath, WORKSPACE_READY_TIMEOUT_MS);
  const tab = await waitForRemoteTab({
    expectedPath: options.workspacePath,
  });
  expect(tab.remoteKind).toBe("ssh");
  expect(tab.remoteHost).toBe(options.config.host);
  expect(tab.secretPersistedInTab).toBe(false);
  if (!tab.remoteSessionId) {
    throw new Error(`${CASE_MARKER}: workspace ${options.label} 缺少 remoteSessionId`);
  }
  if (!tab.workspaceIdentity) {
    throw new Error(`${CASE_MARKER}: workspace ${options.label} 缺少稳定 workspaceIdentity`);
  }
  await assertRemoteComposerMounted();

  await selectUpstreamProviderModelById(MODEL_ID, {
    includePlainModelFallback: false,
    providerId: options.provider.id,
    providerName: options.provider.name,
  });
  // 项目创建已打开远程草稿；全局新建会切到本地未分类并丢失目标模型。
  await selectUpstreamThoughtLevelValue("disabled");
  const draft = await readRemoteTabSnapshot(tab.workspaceIdentity, options.workspacePath);
  expect(draft.activeWorkspaceIdentity).toBe(tab.workspaceIdentity);
  expect(draft.activeWorkspacePath).toBe(options.workspacePath);

  const firstPrompt = `${PROMPT_MARKER}_${options.label}_FIRST_PROMPT`;
  const firstReply = `${PROMPT_MARKER}_${options.label}_FIRST_REPLY`;
  const followPrompt = `${PROMPT_MARKER}_${options.label}_FOLLOW_PROMPT`;
  const followReply = `${PROMPT_MARKER}_${options.label}_FOLLOW_REPLY`;
  const requestStart = await getUpstreamRequestRecordCount();
  await sendV4PromptAndWaitAccepted(
    `${firstPrompt}: 只回复 ${firstReply}`,
    firstPrompt,
    `${options.label} 首发没有进入远端 task`,
  );
  const running = await waitForV4ConversationState(
    (snapshot) =>
      Boolean(snapshot.taskId && snapshot.taskId !== "draft") && snapshot.state === "streaming",
    `${options.label} 首发没有进入 running`,
    TURN_TIMEOUT_MS,
  );
  if (!running.taskId) {
    throw new Error(`${CASE_MARKER}: workspace ${options.label} 首发没有 taskId`);
  }
  const task: TaskCase = {
    firstPrompt,
    firstReply,
    followPrompt,
    followReply,
    identity: tab.workspaceIdentity,
    label: options.label,
    remoteSessionId: tab.remoteSessionId,
    taskId: running.taskId,
    workspacePath: options.workspacePath,
  };
  await assertTaskRow(task, { active: true, running: true });
  await releaseControlledReplay(`ssh-remote-p0-${task.label.toLowerCase()}-first`);
  await waitForUpstreamRequest(
    {
      lastUserMessageIncludes: [firstPrompt],
    },
    `${options.label} 首发请求没有到达 provider`,
    TURN_TIMEOUT_MS,
    { afterIndex: requestStart - 1 },
  );
  await waitForV4AssistantMessageContaining(firstReply, TURN_TIMEOUT_MS);
  await waitForV4ConversationState(
    (snapshot) =>
      snapshot.taskId === task.taskId && snapshot.state === "idle" && snapshot.queueCount === 0,
    `${options.label} 首发完成后没有回到 idle`,
    TURN_TIMEOUT_MS,
  );
  await assertTaskRow(task, { active: true, running: false });
  return task;
}

async function switchTaskAndSendFollowTurn(
  task: TaskCase,
  foreignFirstPrompt: string,
): Promise<void> {
  await selectV4TaskById(task.taskId, 30_000);
  await waitForRemoteTab({
    expectedIdentity: task.identity,
    expectedPath: task.workspacePath,
    expectedRemoteSessionId: task.remoteSessionId,
  });
  await assertRemoteComposerMounted();
  await assertTaskRow(task, { active: true, running: false });
  const requestStart = await getUpstreamRequestRecordCount();
  await sendV4PromptAndWaitAccepted(
    `${task.followPrompt}: 只回复 ${task.followReply}`,
    task.followPrompt,
    `${task.label} 续发没有进入原 task`,
  );
  await assertTaskRow(task, { active: true, running: true });
  await releaseControlledReplay(`ssh-remote-p0-${task.label.toLowerCase()}-follow`);
  await waitForUpstreamRequest(
    {
      excludes: [foreignFirstPrompt],
      includes: [task.firstPrompt],
      lastUserMessageIncludes: [task.followPrompt],
    },
    `${task.label} 续发请求没有携带本 task 历史，或混入另一 workspace`,
    TURN_TIMEOUT_MS,
    { afterIndex: requestStart - 1 },
  );
  await waitForV4AssistantMessageContaining(task.followReply, TURN_TIMEOUT_MS);
  await waitForV4ConversationState(
    (snapshot) =>
      snapshot.taskId === task.taskId && snapshot.state === "idle" && snapshot.queueCount === 0,
    `${task.label} 续发完成后没有回到 idle`,
    TURN_TIMEOUT_MS,
  );
  await assertTaskRow(task, { active: true, running: false });
}

async function assertRemoteComposerMounted(): Promise<void> {
  // Bug 回归：远程 Highspeed 占位实现漏掉 owner 查询，SessionPane 挂载即同步抛错。
  // 草稿和历史任务都必须实际渲染输入框，不能只凭远程 tab 注册成功判断聊天可用。
  await expect($(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)).toBeDisplayed();
  expect(await browser.execute(() => document.body.innerText)).not.toContain(
    "getCurrentOwnerKey is not a function",
  );
}

async function assertTaskRow(
  task: TaskCase,
  expected: { active: boolean; running: boolean },
): Promise<void> {
  let latest: ProjectTaskRowState | null = null;
  await browser
    .waitUntil(
      async () => {
        // 虚拟项目侧栏：task 行必须落在其 workspace 对应的项目 section 内。
        latest = await readProjectTaskRowState(task.taskId, task.workspacePath, task.identity);
        return (
          latest.exists &&
          latest.inProject &&
          latest.active === expected.active &&
          latest.running === expected.running &&
          !latest.error
        );
      },
      {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: `${CASE_MARKER}: task ${task.label} 列表状态不正确`,
      },
    )
    .catch((cause: unknown) => {
      // 运行图标缺失不应挡住历史隔离与遥测取证；严格保留末尾失败，不能放行归属或错误异常。
      if (
        expected.running &&
        latest?.exists &&
        latest.inProject &&
        latest.active === expected.active &&
        !latest.error &&
        !latest.running
      ) {
        runningRowMismatches.push({ taskId: task.taskId, label: task.label, observed: latest });
        process.stdout.write(
          `[${CASE_MARKER}] running-row-mismatch ${JSON.stringify(runningRowMismatches.at(-1))}\n`,
        );
        return;
      }
      throw new Error(
        `${CASE_MARKER}: task ${task.label} 列表状态不正确 expected=${JSON.stringify(expected)} latest=${JSON.stringify(latest)}`,
        { cause },
      );
    });
}

async function createReplayTunnel(config: SSHRuntimeConfig): Promise<ReplayTunnel> {
  return createSSHReplayTunnel(config, CASE_MARKER);
}

async function waitForRemoteTab(options: {
  expectedIdentity?: string;
  expectedPath: string;
  expectedRemoteSessionId?: string | null;
  timeoutMs?: number;
}): Promise<RemoteTabSnapshot> {
  let snapshot: RemoteTabSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        try {
          snapshot = await readRemoteTabSnapshot(options.expectedIdentity, options.expectedPath);
          const parsedIdentity = snapshot.workspaceIdentity
            ? parseRemoteWorkspaceIdentity(snapshot.workspaceIdentity)
            : null;
          const expectedIdentityMatches = options.expectedIdentity
            ? snapshot.workspaceIdentity === options.expectedIdentity
            : parsedIdentity?.kind === "server" &&
              parsedIdentity.workspacePath === options.expectedPath;
          return (
            snapshot.workspacePath === options.expectedPath &&
            snapshot.activeWorkspacePath === options.expectedPath &&
            expectedIdentityMatches &&
            snapshot.activeWorkspaceIdentity === snapshot.workspaceIdentity &&
            Boolean(snapshot.remoteSessionId) &&
            (!options.expectedRemoteSessionId ||
              snapshot.remoteSessionId === options.expectedRemoteSessionId)
          );
        } catch {
          return false;
        }
      },
      {
        timeout: options.timeoutMs ?? WORKSPACE_READY_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: `${CASE_MARKER}: remote tab identity/session 没有收敛`,
      },
    );
  } catch (error) {
    // Bug 定位需要区分“remote tab 丢失”和“reload 后错误恢复到 local active tab”；
    // snapshot 不包含凭据，可以安全进入 E2E 失败证据。
    throw new Error(
      `${CASE_MARKER}: remote tab identity/session 没有收敛，latest=${JSON.stringify(snapshot)}`,
      { cause: error },
    );
  }
  if (!snapshot) throw new Error(`${CASE_MARKER}: remote tab snapshot 缺失`);
  return snapshot;
}

function readRemoteTabSnapshot(
  expectedIdentity?: string,
  expectedPath?: string,
): Promise<RemoteTabSnapshot> {
  return browser.execute(
    (identity, workspacePath) => {
      type RemoteTab = {
        id: string;
        kind: string;
        remoteSessionId?: string;
        remoteTarget?: Record<string, unknown>;
        workspaceIdentity?: string;
        workspacePath?: string;
      };
      const store = (
        window as Window & {
          __zcodeTabStoreE2E?: {
            getState?: () => {
              activeTabId?: string | null;
              activeWorkspaceIdentity?: string | null;
              activeWorkspacePath?: string | null;
              tabs?: RemoteTab[];
            };
          };
        }
      ).__zcodeTabStoreE2E;
      const state = store?.getState?.();
      const matchingRemoteTab = state?.tabs?.find((tab) =>
        identity ? tab.workspaceIdentity === identity : tab.workspacePath === workspacePath,
      );
      const remoteTarget = matchingRemoteTab?.remoteTarget;
      return {
        activeWorkspaceIdentity: state?.activeWorkspaceIdentity ?? null,
        activeWorkspacePath: state?.activeWorkspacePath ?? null,
        remoteHost: typeof remoteTarget?.host === "string" ? remoteTarget.host : null,
        remoteKind: typeof remoteTarget?.kind === "string" ? remoteTarget.kind : null,
        remoteSessionId: matchingRemoteTab?.remoteSessionId ?? null,
        secretPersistedInTab: Boolean(
          remoteTarget && ("password" in remoteTarget || "privateKeyPassphrase" in remoteTarget),
        ),
        workspaceIdentity: matchingRemoteTab?.workspaceIdentity ?? null,
        workspacePath: matchingRemoteTab?.workspacePath ?? null,
      };
    },
    expectedIdentity ?? null,
    expectedPath ?? null,
  );
}
