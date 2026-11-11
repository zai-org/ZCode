/* eslint-disable max-lines -- SSH lifecycle case 共用 setup/teardown、身份与故障辅助逻辑，集中维护以保持同一安全边界。 */
import {
  clickRemoteHostConnect,
  projectSectionSelector,
  waitForProjectRowGone,
  waitForTaskRowInProject,
} from "./project-sidebar.js";
import { removeRemoteProjectEntryForRow } from "./remote-project-handoff-probe.js";
import { TID_TASK_SETTINGS_BUTTON } from "@zcode/shared/test-ids";
import {
  waitForWorkspaceApp,
  switchToWorkspaceRendererWindow,
  waitForTestIdByDom,
} from "./desktop-app.js";
import {
  seedCustomOpenAIChatCompletionsProvider,
  refreshSeededOpenAIProvidersThroughSettings,
  seedCustomAnthropicMessagesProvider,
} from "./custom-openai-provider.js";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "./upstream-provider.js";
import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "./conversation-session-network.js";
import {
  prepareV4ConversationE2E,
  getV4Messages,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "./v4-conversation.js";
import { hasAssistantReplyForUserTurn } from "./conversation-turn-evidence.js";
import {
  clickLastEnabledSSHDialogButton,
  createSSHReplayTunnel,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readHostProcesses,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
  runSSHCommand,
  selectSSHRemoteDirectory,
  ensureSSHProjectDirectoryStep,
  waitForRemoteTab,
  type ReplayTunnel,
  type SSHConnectionConfig,
  type SSHRuntimeConfig,
  SSH_WORKSPACE_READY_TIMEOUT_MS,
} from "./ssh-remote-p0.js";

export const SSH_LIFECYCLE_MODEL_ID = "e2e-ssh-remote-lifecycle-model";
/** lifecycle 自定义模型暴露思考档位选择器，回放 fixture 按不思考录制。 */
export const SSH_LIFECYCLE_THOUGHT_LEVEL = "disabled";
export const SSH_LIFECYCLE_TURN_TIMEOUT_MS = 2 * 60_000;
let followTurnSequence = 0;

export interface SSHLifecycleTask {
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

export interface SSHLifecycleProvider {
  id: string;
  name: string;
  tunnel: ReplayTunnel;
}

export interface SSHLifecycleProviderOptions {
  apiType?: "openai-chat-completions" | "anthropic-messages";
  tunnelUsername?: string;
  // 远端端口与本机 replay 端口一致时，同一 provider baseURL 本机也能直连；本地与远端都要发消息的 case 用。
  mirrorLocalPort?: boolean;
}

export async function createSSHLifecycleProvider(
  config: SSHConnectionConfig,
  caseMarker: string,
  options: SSHLifecycleProviderOptions = {},
): Promise<SSHLifecycleProvider> {
  const tunnel = await createSSHReplayTunnel(config, caseMarker, {
    ...(options.tunnelUsername ? { username: options.tunnelUsername } : {}),
    ...(options.mirrorLocalPort ? { mirrorLocalPort: true } : {}),
  });

  try {
    const provider =
      options.apiType === "anthropic-messages"
        ? await seedCustomAnthropicMessagesProvider({
            baseURL: `${tunnel.baseURL}/anthropic`,
            modelId: SSH_LIFECYCLE_MODEL_ID,
            providerId: `e2e-ssh-remote-lifecycle-${Date.now()}`,
            providerName: `SSH remote lifecycle ${Date.now()}`,
          })
        : await seedCustomOpenAIChatCompletionsProvider({
            baseURL: tunnel.baseURL,
            modelId: SSH_LIFECYCLE_MODEL_ID,
            providerId: `e2e-ssh-remote-lifecycle-${Date.now()}`,
            providerName: `SSH remote lifecycle ${Date.now()}`,
          });
    // 这里只准备本机模型；用例继续通过真实连接验证远端 Provisioning。
    // 显式刷新 Registry，避免依赖文件轮询延迟或重复测试设置页的新增表单。
    const beforeRefresh = await readRemoteTabSnapshot();
    await refreshSeededOpenAIProvidersThroughSettings([provider.name], {
      workspacePath: beforeRefresh.activeWorkspacePath,
    });
    return { ...provider, tunnel };
  } catch (error) {
    await tunnel.close();
    throw error;
  }
}

export async function connectSSHWorkspaceAndSendFirstTurn(options: {
  caseMarker: string;
  config: SSHConnectionConfig;
  provider: SSHLifecycleProvider;
  label: "A" | "B";
  workspacePath: string;
}): Promise<SSHLifecycleTask> {
  // 全局连接入口不依赖空草稿；避免为准备 SSH 额外创建本地目录和触发 workspace 切换。
  await openSSHRemoteDialog(options.caseMarker);
  await fillSSHPasswordSettings(options.config);
  await clickLastEnabledSSHDialogButton(options.caseMarker);
  await ensureSSHProjectDirectoryStep(options.config, options.caseMarker);
  await selectSSHRemoteDirectory(options.workspacePath, options.caseMarker);
  await waitForWorkspaceApp(options.workspacePath, SSH_WORKSPACE_READY_TIMEOUT_MS);

  const tab = await waitForRemoteTab({
    caseMarker: options.caseMarker,
    expectedPath: options.workspacePath,
  });
  expect(tab.remoteKind).toBe("ssh");
  expect(tab.remoteHost).toBe(options.config.host);
  expect(tab.secretPersistedInTab).toBe(false);
  if (!tab.remoteSessionId) {
    throw new Error(`${options.caseMarker}: workspace ${options.label} 缺少 remoteSessionId`);
  }
  if (!tab.workspaceIdentity) {
    throw new Error(`${options.caseMarker}: workspace ${options.label} 缺少稳定 workspaceIdentity`);
  }

  await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
    includePlainModelFallback: false,
    providerId: options.provider.id,
    providerName: options.provider.name,
  });
  // Bug 原因：产品要求切换到新模型后由用户显式选择思考档位，未选时发送键保持禁用；
  // 09-09 恢复 helper 时丢掉了这一步，首发在 sendV4Prompt 处等待发送键超时。
  await selectUpstreamThoughtLevelValue(SSH_LIFECYCLE_THOUGHT_LEVEL);
  // 根因：项目创建已打开远端草稿，再点全局“新建任务”会切到本地未分类目录并重置模型，
  // 甚至让回放通过掩盖错误执行归属。复用项目草稿，并在发送前核对权威 workspace identity。
  const draft = await readRemoteTabSnapshot(tab.workspaceIdentity, options.workspacePath);
  expect(draft.activeWorkspaceIdentity).toBe(tab.workspaceIdentity);
  expect(draft.activeWorkspacePath).toBe(options.workspacePath);

  // fixture contract 使用稳定的 case/label 标记；run 身份已由 E2E profile 隔离。
  const marker = options.caseMarker.startsWith("E2E_")
    ? `${options.caseMarker}_${options.label}`
    : `E2E_${options.caseMarker}_${options.label}`;
  const replyMarker = options.caseMarker.startsWith("E2E_")
    ? options.caseMarker.slice("E2E_".length)
    : options.caseMarker;
  const task = {
    firstPrompt: `${marker}_FIRST_PROMPT`,
    firstReply: `${replyMarker}_REPLY`,
    followPrompt: `${marker}_FOLLOW_PROMPT`,
    followReply: `${replyMarker}_REPLY`,
  };
  const requestStart = await getUpstreamRequestRecordCount();
  await sendV4PromptAndWaitAccepted(
    `${task.firstPrompt}: 只回复 ${task.firstReply}`,
    task.firstPrompt,
    `${options.caseMarker}: workspace ${options.label} 首发没有被接受`,
  );
  // 首回合只是准备历史。快速 replay 可以在 DOM 接受屏障之前已完成；业务 running 窗口
  // 由各 case 的 controlled-stream 单独验证，不能要求探针命中一个已经过去的瞬态。
  const running = await waitForV4ConversationState(
    (snapshot) => Boolean(snapshot.taskId && snapshot.taskId !== "draft"),
    `${options.caseMarker}: workspace ${options.label} 首发没有建立会话`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  );
  if (!running.taskId) {
    throw new Error(`${options.caseMarker}: workspace ${options.label} 首发没有 taskId`);
  }

  await waitForUpstreamRequest(
    { lastUserMessageIncludes: [task.firstPrompt] },
    `${options.caseMarker}: workspace ${options.label} 首发没有到达 provider`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
    { afterIndex: requestStart - 1 },
  );
  await waitForV4AssistantMessageContaining(task.firstReply, SSH_LIFECYCLE_TURN_TIMEOUT_MS);
  await waitForV4ConversationState(
    (snapshot) =>
      snapshot.taskId === running.taskId && snapshot.state === "idle" && snapshot.queueCount === 0,
    `${options.caseMarker}: workspace ${options.label} 首发没有回到 idle`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  );

  return {
    ...task,
    identity: tab.workspaceIdentity,
    label: options.label,
    remoteSessionId: tab.remoteSessionId,
    taskId: running.taskId,
    workspacePath: options.workspacePath,
  };
}

export async function sendSSHFollowTurn(
  task: SSHLifecycleTask,
  caseMarker: string,
  foreignPrompt?: string,
): Promise<void> {
  await selectV4TaskById(task.taskId, 30_000);
  await waitForRemoteTab({
    caseMarker,
    expectedIdentity: task.identity,
    expectedPath: task.workspacePath,
    expectedRemoteSessionId: task.remoteSessionId,
  });
  const requestStart = await getUpstreamRequestRecordCount();
  // 稳定 fixture 前缀保留；同一 worker 内给每次续发独立标记，避免历史回复满足等待。
  const followMarker = `${task.followPrompt}:turn-${++followTurnSequence}:`;
  const requestQuery = {
    excludes: ["CRITICAL: Respond with TEXT ONLY", ...(foreignPrompt ? [foreignPrompt] : [])],
    includes: [task.firstPrompt],
    lastUserMessageIncludes: [followMarker],
  };
  await sendV4PromptAndWaitAccepted(
    `${followMarker} 只回复 ${task.followReply}`,
    followMarker,
    `${caseMarker}: workspace ${task.label} 续发没有被接受`,
  );
  await waitForUpstreamRequest(
    requestQuery,
    `${caseMarker}: workspace ${task.label} 续发历史或目标 workspace 错误`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
    { afterIndex: requestStart - 1 },
  );
  await browser.waitUntil(
    async () => hasAssistantReplyForUserTurn(await getV4Messages(), followMarker, task.followReply),
    {
      timeout: SSH_LIFECYCLE_TURN_TIMEOUT_MS,
      timeoutMsg: `${caseMarker}: workspace ${task.label} 本次续发没有新 assistant 回复`,
    },
  );
  await waitForV4ConversationState(
    (snapshot) =>
      snapshot.taskId === task.taskId && snapshot.state === "idle" && snapshot.queueCount === 0,
    `${caseMarker}: workspace ${task.label} 续发没有回到 idle`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  );
  await browser.waitUntil(
    async () => {
      const requests = await getUpstreamRequestEvidence(requestQuery, {
        afterIndex: requestStart - 1,
      });
      return (
        requests.length === 1 &&
        requests[0]!.status === "complete" &&
        requests[0]!.statusCode === 200
      );
    },
    {
      timeout: 15_000,
      timeoutMsg: `${caseMarker}: workspace ${task.label} 续发不是一次完整成功的模型请求`,
    },
  );
}

/**
 * 从本机侧栏移除远端项目入口。对应旧「移除 SSH workspace」：
 * 虚拟项目下远端组织态留在远端，本机只移除入口与缓存，不触发远端删除。
 * 在线项目菜单不再提供该动作，这里直接调用本机入口服务。
 */
export async function removeRemoteProjectEntry(
  workspacePath: string,
  caseMarker: string,
): Promise<void> {
  await removeRemoteProjectEntryForRow(projectSectionSelector(workspacePath));
  await waitForProjectRowGone(workspacePath, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: 远端项目 ${workspacePath} 移除后仍在侧栏`,
  });
}

export type RemoteWorkspaceFaultOutcome = "retained-disconnected" | "self-healed";

export async function waitForRemoteWorkspaceFaultSettled(
  identity: string,
  caseMarker: string,
  staleSessionId: string | null,
  probeContext?: () => Promise<unknown>,
): Promise<RemoteWorkspaceFaultOutcome> {
  // 远端 server 挂掉后有两条都合法的路径：停在 disconnected 保留态等用户点重连，
  // 或者产品自己拉起新 server、换成新的 remoteSessionId。服务器上实测走的是后者
  // （现场 sessionsBeforeFault.A=9effdcc2…，超时时读到 9dcde31a…，远端 status.json
  // 已是新 pid + state:"ready"）。只认前者会把自愈误判成"没有进入断开态"。
  // 这条判定真正要守的是：故障之后绝不能继续沿用故障前的 session。
  let outcome: RemoteWorkspaceFaultOutcome | null = null;
  let lastProbe: unknown = "not-probed";
  await browser
    .waitUntil(
      async () => {
        try {
          const snapshot = await readRemoteTabSnapshot(identity);
          lastProbe = {
            workspaceIdentity: snapshot.workspaceIdentity,
            remoteSessionId: snapshot.remoteSessionId,
          };
          if (snapshot.workspaceIdentity !== identity) return false;
          if (snapshot.remoteSessionId === null) {
            outcome = "retained-disconnected";
            return true;
          }
          if (staleSessionId !== null && snapshot.remoteSessionId !== staleSessionId) {
            outcome = "self-healed";
            return true;
          }
          return false;
        } catch (error) {
          lastProbe = { error: error instanceof Error ? error.message : String(error) };
          return false;
        }
      },
      { timeout: SSH_WORKSPACE_READY_TIMEOUT_MS },
    )
    .catch(async (error: unknown) => {
      const context = probeContext
        ? await probeContext().catch((probeError: unknown) => ({
            probeError: probeError instanceof Error ? probeError.message : String(probeError),
          }))
        : null;
      throw new Error(
        `${caseMarker}: 远端 server 故障后既没有进入 disconnected 保留态、也没有换成新 session（stale=${staleSessionId ?? "unknown"}）；现场: ${JSON.stringify(lastProbe)}；补充: ${JSON.stringify(context)}`,
        { cause: error },
      );
    });
  if (outcome === null) {
    throw new Error(`${caseMarker}: 故障处理结果未判定`);
  }
  return outcome;
}

export async function waitForRemoteWorkspaceDisconnected(
  identity: string,
  caseMarker: string,
  // 超时后再取一次的补充事实（远端此刻还有没有 server 进程、故障前的 sessionId 是多少）。
  // 只有对比 sessionId 才能区分"产品没检测到断链"和"产品已经自愈重连（换了新 session）"。
  probeContext?: () => Promise<unknown>,
): Promise<void> {
  // 现场事实：这条判定把 readRemoteTabSnapshot 的异常整个吞掉，超时后无法区分
  // 「tab 还在但 remoteSessionId 没清空」（产品没检测到断链）和「tab 直接消失了」
  // （保留态本身没实现）。记录最后一次探测结果再抛。
  let lastProbe: unknown = "not-probed";
  await browser
    .waitUntil(
      async () => {
        try {
          const snapshot = await readRemoteTabSnapshot(identity);
          lastProbe = {
            workspaceIdentity: snapshot.workspaceIdentity,
            remoteSessionId: snapshot.remoteSessionId,
          };
          return snapshot.workspaceIdentity === identity && snapshot.remoteSessionId === null;
        } catch (error) {
          lastProbe = { error: error instanceof Error ? error.message : String(error) };
          return false;
        }
      },
      { timeout: SSH_WORKSPACE_READY_TIMEOUT_MS },
    )
    .catch(async (error: unknown) => {
      const context = probeContext
        ? await probeContext().catch((probeError: unknown) => ({
            probeError: probeError instanceof Error ? probeError.message : String(probeError),
          }))
        : null;
      throw new Error(
        `${caseMarker}: remote workspace 没有进入 disconnected 保留态（expected identity=${identity}）；现场: ${JSON.stringify(lastProbe)}；补充: ${JSON.stringify(context)}`,
        { cause: error },
      );
    });
}

/** 点击远端项目所属 host 分组的连接按钮；对应旧「重连 SSH workspace」。 */
export async function reconnectRemoteProjectHost(
  workspacePath: string,
  caseMarker: string,
): Promise<void> {
  await clickRemoteHostConnect(workspacePath, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: 远端项目 ${workspacePath} 没有显示可用的重连按钮`,
  });
}

export async function listRemoteZCodeServerPids(config: SSHConnectionConfig): Promise<number[]> {
  const result = await runSSHCommand(config, "ps -eo pid=,args=");
  if (result.code !== 0) {
    throw new Error(`读取远端 zcode-server PID 失败: ${result.stderr}`);
  }
  // 缺陷原因：这里原先匹配 `zcode-server.cjs`，而 3.12 的 release 布局早已把 daemon 换成
  // <release>/runtime/server-cli.js serve --supervisor（工作进程是 server-core.js）。旧名字
  // 在远端根本不存在，匹配结果恒为空数组，SSH-P0-LIFE-02 只会报 before=/current= 全空，
  // 看不出是探测失效而不是产品没起 server（2026-09-15 服务器全量实测）。
  // 只认 daemon 一个角色：core 由 daemon 拉起，若一并计入，「一次连接新增恰好一个」的
  // 合同就不成立了。
  return result.stdout
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+.*server-cli\.js\s+serve\b/u);
      return match ? [Number.parseInt(match[1]!, 10)] : [];
    })
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

// daemon 拉起的工作进程（server-core.js）。故障注入要连它一起停，否则 daemon 死了、
// core 还在服务已建立的会话，UI 根本不会进入断开态。
async function listRemoteServerCorePids(
  config: SSHConnectionConfig,
  parentPid?: number,
): Promise<number[]> {
  const result = await runSSHCommand(config, "ps -eo pid=,ppid=,args=");
  if (result.code !== 0) {
    throw new Error(`读取远端 zcode server core PID 失败: ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+.*server-core\.js\b/u);
      if (!match) return [];
      const pid = Number.parseInt(match[1]!, 10);
      const ppid = Number.parseInt(match[2]!, 10);
      if (parentPid !== undefined && ppid !== parentPid) return [];
      return [pid];
    })
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

export async function stopOwnedSSHServer(
  config: SSHConnectionConfig,
  beforePids: readonly number[],
  caseMarker: string,
): Promise<number> {
  const currentPids = await listRemoteZCodeServerPids(config);
  const owned = currentPids.filter((pid) => !beforePids.includes(pid));
  if (owned.length !== 1) {
    throw new Error(
      `${caseMarker}: 只允许终止本 case 新建的一个 zcode-server，before=${beforePids.join(",")}, current=${currentPids.join(",")}`,
    );
  }
  const pid = owned[0]!;
  // 缺陷原因：daemon 是 server-cli.js serve --supervisor，真正服务会话的是它拉起的
  // server-core.js。只 TERM daemon 时 core 继续服务已建立的会话，UI 不会进入断开保留态
  // （实测现场 remoteSessionId 始终是有效 id）。顺序必须是先停 daemon——它的职责就是把
  // 崩掉的 core 拉回来——再停 core，最后等两者都退出。
  const corePids = await listRemoteServerCorePids(config, pid);
  const result = await runSSHCommand(config, `kill -TERM -- ${pid}`);
  if (result.code !== 0) {
    throw new Error(`${caseMarker}: 终止远端 zcode-server ${pid} 失败: ${result.stderr}`);
  }
  if (corePids.length > 0) {
    await runSSHCommand(config, `kill -TERM -- ${corePids.join(" ")}`).catch(() => undefined);
  }
  await browser.waitUntil(
    async () => {
      const [daemons, cores] = await Promise.all([
        listRemoteZCodeServerPids(config),
        listRemoteServerCorePids(config),
      ]);
      return !daemons.includes(pid) && corePids.every((corePid) => !cores.includes(corePid));
    },
    {
      timeout: SSH_WORKSPACE_READY_TIMEOUT_MS,
      timeoutMsg: `${caseMarker}: 远端 zcode-server ${pid}（core=${corePids.join(",") || "none"}）没有退出`,
    },
  );
  return pid;
}

export async function waitForRendererAfterColdRestart(caseMarker: string): Promise<void> {
  // 冷重启必须复用 handle/target 交集校验；裸 CDP targetId 可能仍绑定过渡页。
  // 此处只等主界面可操作，不强制切换到本机项目，以保留远程恢复的验收状态。
  await switchToWorkspaceRendererWindow("", 60_000);
  await waitForTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 60_000,
    timeoutMsg: `${caseMarker}: cold restart 后主界面尚未就绪`,
  });
}

/** task 行必须恢复到其 workspace 对应的项目 section 内且无错误标记。 */
export async function readTaskRowInProject(
  task: SSHLifecycleTask,
  caseMarker: string,
): Promise<void> {
  await waitForTaskRowInProject(task.taskId, task.workspacePath, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: task ${task.label} 没有恢复到正确项目`,
  });
}

export async function prepareSSHLifecycle(
  caseMarker: string,
  options: SSHLifecycleProviderOptions = {},
): Promise<{
  config: SSHRuntimeConfig;
  initialHosts: Array<{ name: string; pid: number }>;
  provider: SSHLifecycleProvider;
}> {
  const config = readSSHRuntimeConfig(caseMarker);
  await prepareV4ConversationE2E({ skipProvider: true });
  const initialHosts = await readHostProcesses();
  expect(initialHosts).toHaveLength(1);
  const provider = await createSSHLifecycleProvider(config, caseMarker, options);
  return { config, initialHosts, provider };
}

export interface RemoteProcessIdentity {
  pid: number;
  ppid?: number;
  startTicks: number;
  cwd?: string;
}

export async function readRemoteCoreIdentity(
  config: SSHConnectionConfig,
  caseMarker: string,
): Promise<{
  pid: number;
  supervisorPid: number;
  startTicks: number;
  state: string;
  generation: number;
}> {
  const statusResult = await runSSHCommand(config, 'cat "$HOME/.zcode/server/run/status.json"');
  if (statusResult.code !== 0) {
    throw new Error(`${caseMarker}: 读取远端 Core status 失败: ${statusResult.stderr}`);
  }
  const status = JSON.parse(statusResult.stdout) as {
    pid?: number;
    state?: string;
    generation?: number;
  };
  const corePid = status.pid;
  if (typeof corePid !== "number" || !Number.isSafeInteger(corePid) || corePid <= 0) {
    throw new Error(`${caseMarker}: Core status 缺少有效 pid`);
  }
  const proc = await runSSHCommand(
    config,
    `pid=${corePid}; test -r /proc/$pid/stat && awk '{print $4" "$22}' /proc/$pid/stat`,
  );
  const [supervisorText, startTicksText] = proc.stdout.trim().split(/\s+/u);
  const supervisorPid = Number.parseInt(supervisorText ?? "", 10);
  const startTicks = Number.parseInt(startTicksText ?? "", 10);
  if (!Number.isSafeInteger(supervisorPid) || !Number.isSafeInteger(startTicks)) {
    throw new Error(`${caseMarker}: Core /proc identity 不完整: ${proc.stdout.trim()}`);
  }
  return {
    pid: corePid,
    supervisorPid,
    startTicks,
    state: status.state ?? "unknown",
    generation: status.generation ?? 0,
  };
}

export async function listRemoteAgentProcesses(
  config: SSHConnectionConfig,
): Promise<Array<RemoteProcessIdentity & { cwd: string }>> {
  // CLI 会把 argv 改名为 zcode-cli；旧的全文正则漏掉真 Agent，还会命中查询 shell。
  // 先按 Core 的直接子进程筛选，再读 /proc 身份，排除 SSH 命令和 Agent 派生插件。
  const corePids = new Set(await listRemoteServerCorePids(config));
  const processes = await runSSHCommand(config, "ps -eo pid=,ppid=,args=");
  if (processes.code !== 0) throw new Error(`读取远端进程失败: ${processes.stderr}`);
  const pids = processes.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    if (!match || !corePids.has(Number(match[2]))) return [];
    const command = match[3]!;
    return /^zcode-cli(?:\s|$)/u.test(command) || /\bapp-server\s+--stdio\b/u.test(command)
      ? [Number(match[1])]
      : [];
  });
  if (pids.length === 0) return [];
  const result = await runSSHCommand(
    config,
    `for pid in ${pids.join(" ")}; do ` +
      "ppid=$(ps -o ppid= -p \"$pid\" | tr -d ' '); " +
      "ticks=$(awk '{print $22}' /proc/$pid/stat 2>/dev/null); " +
      'cwd=$(readlink /proc/$pid/cwd 2>/dev/null); printf \'%s\\t%s\\t%s\\t%s\\n\' "$pid" "$ppid" "$ticks" "$cwd"; done',
  );
  if (result.code !== 0) throw new Error(`读取远端 Agent 进程失败: ${result.stderr}`);
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [pidText, ppidText, ticksText, ...cwdParts] = line.split("\t");
      const pid = Number.parseInt(pidText ?? "", 10);
      const startTicks = Number.parseInt(ticksText ?? "", 10);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(startTicks)) return [];
      const ppid = Number.parseInt(ppidText ?? "", 10);
      return [
        {
          pid,
          ...(Number.isSafeInteger(ppid) ? { ppid } : {}),
          startTicks,
          cwd: cwdParts.join("\t"),
        },
      ];
    });
}

export async function terminateRemoteProcess(
  config: SSHConnectionConfig,
  process: RemoteProcessIdentity,
  caseMarker: string,
): Promise<void> {
  const current = await runSSHCommand(
    config,
    `test -r /proc/${process.pid}/stat && awk '{print $22}' /proc/${process.pid}/stat || true`,
  );
  if (Number.parseInt(current.stdout.trim(), 10) !== process.startTicks) return;
  const killed = await runSSHCommand(config, `kill -TERM -- ${process.pid}`);
  if (killed.code !== 0)
    throw new Error(`${caseMarker}: 终止远端进程 ${process.pid} 失败: ${killed.stderr}`);
  await browser.waitUntil(
    async () =>
      (
        await runSSHCommand(
          config,
          `test -r /proc/${process.pid}/stat && awk '{print $22}' /proc/${process.pid}/stat || true`,
        )
      ).stdout.trim() !== String(process.startTicks),
    {
      timeout: SSH_WORKSPACE_READY_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `${caseMarker}: 远端进程 ${process.pid} 没有退出`,
    },
  );
}
