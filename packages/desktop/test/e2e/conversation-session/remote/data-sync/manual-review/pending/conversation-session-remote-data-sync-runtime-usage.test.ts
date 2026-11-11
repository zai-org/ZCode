import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  addMarketplaceSourceThroughAgent,
  createPluginLifecycleFixture,
  installMarketplacePluginThroughAgent,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  PLUGIN_LIFECYCLE_MCP_TOOL_NAME,
  PLUGIN_LIFECYCLE_NAME,
  PLUGIN_LIFECYCLE_RUNTIME_MARKER,
} from "#e2e/helpers/plugin-management-lifecycle";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  countUpstreamRequests,
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
  getUpstreamRequestToolNames,
  waitForUpstreamRequest,
  type UpstreamToolResultSnapshot,
} from "#e2e/helpers/conversation-session-network";
import { hasAssistantReplyForUserTurn } from "#e2e/helpers/conversation-turn-evidence";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  SSH_LIFECYCLE_MODEL_ID,
  SSH_LIFECYCLE_THOUGHT_LEVEL,
  SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  prepareSSHConnectionPage,
  readRemoteTabSnapshot,
  waitForRemoteTab,
  type SSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import {
  approveV4Permission,
  clickV4Stop,
  getV4Messages,
  hasV4PermissionDialog,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  V4_MAIN_PANE_ID,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

// DSYNC-17：推送内容在远端会话中的可用时机（docs/remote/data-sync.md「Seam ③：桌面 E2E」）。
// 模型请求经 SSH 反向隧道回到本机回放（先例 WPL-011）；用回放记录的模型请求判断远端 Agent 看到了什么，
// 再实际调用 MCP 工具、Skill、Agent 检查工具结果；钩子在远端 $HOME 追加标记行。
// 17-01 / 17-02 断言子智能体下一轮可用：远端 Host 与本机一样每轮提供子智能体配置（docs/subagent-runtime-refresh.md「远程 workspace」）。
// 17-01 另断言推送钩子会重建推送前打开的新建任务页，与本机设置页保存钩子一致（docs/remote/data-sync.md「钩子」）。
// 其他分类在现有 task 与推送前打开的新建任务页的期望未定义，只记录事实；17-03 断言新建 task 全部可用。
const CASE_MARKER = "E2E_DSYNC_17_RUNTIME_USAGE";
const TITLE_REQUEST = "Generate a concise title";
const REMOTE_HOME = "/home/dev";

const SKILL_NAME = "e2e-dsync-17-skill";
const SKILL_DESC = "E2E_DSYNC_17_SKILL_DESC";
const SKILL_BODY = "E2E_DSYNC_17_SKILL_BODY";
const AGENT_NAME = "e2e-dsync-17-agent";
const AGENT_DESC = "E2E_DSYNC_17_AGENT_DESC";
const AGENT_BODY = "E2E_DSYNC_17_AGENT_BODY";
const AGENT_DONE = "E2E_DSYNC_17_AGENT_DONE";
const COMMAND_NAME = "e2e-dsync-17-cmd";
const COMMAND_BODY = "E2E_DSYNC_17_COMMAND_BODY";
const MCP_SERVER = "e2e-dsync-17-mcp";
const MCP_TOOL = `mcp__${MCP_SERVER}__marker`;
const MCP_RESULT = "E2E_DSYNC_17_MCP_RESULT";
const INLINE_PLUGIN = "e2e-dsync-17-inline";
const INLINE_TOOL = `mcp__plugin_${INLINE_PLUGIN}_rt__marker`;
const INLINE_RESULT = "E2E_DSYNC_17_INLINE_RESULT";
const MARKET_RESULT = `${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_1.0.0`;
// 钩子只写文件、不写 stdout：stdout 会进入上下文，改变后续请求。
const HOOK_MARK = "E2E_DSYNC_17_HOOK";
const HOOK_LOG = "e2e-dsync-17-hooks.log";
const HOOK_COMMAND = `echo ${HOOK_MARK} >> "$HOME/${HOOK_LOG}"`;
// 远端 Core 的子智能体监听在文件稳定 1000ms 后读取、再合并 300ms 才发布快照（docs/subagent-runtime-refresh.md）。
// Core 的标准输出被 supervisor 丢弃，测试拿不到发布事件，只能从推送完成起等足规格的发布窗口再发下一轮。
const SUBAGENT_PUBLISH_WINDOW_MS = 3_000;
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/dsync-17-runtime-usage",
  "dsync-17",
);

interface LocalCliConfig {
  [key: string]: unknown;
  mcp?: { [key: string]: unknown; servers?: Record<string, unknown> };
  plugins?: { [key: string]: unknown; dirs?: string[]; enabledPlugins?: Record<string, boolean> };
}

interface StageFacts {
  skillListed: boolean;
  subagentListed: boolean;
  mcpTool: boolean;
  inlinePluginTool: boolean;
  marketplacePluginTool: boolean;
  hookFired: boolean;
}

/** 内联的 stdio MCP 服务器：远端容器没有系统 node，靠 Agent 把自带 node 放进 MCP 子进程的 PATH。 */
function mcpServerScript(serverName: string, result: string): string {
  return [
    'const rl = require("node:readline").createInterface({ input: process.stdin });',
    'const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");',
    'rl.on("line", (line) => {',
    "  let request;",
    "  try { request = JSON.parse(line); } catch { return; }",
    `  if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(serverName)}, version: "1.0.0" } } });`,
    '  if (request.method === "tools/list") return send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "marker", description: "Return the data sync runtime marker", inputSchema: { type: "object", properties: {} } }] } });',
    `  if (request.method === "tools/call") return send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: ${JSON.stringify(result)} }] } });`,
    '  if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result: {} });',
    "});",
  ].join("\n");
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

/** 本机准备六类内容：技能、子智能体、命令、MCP、钩子、inline 插件；config.json 读改写，保留已有字段。 */
async function writeLocalContent(homeDir: string): Promise<void> {
  const zcode = join(homeDir, ".zcode");
  await writeText(
    join(zcode, "skills", SKILL_NAME, "SKILL.md"),
    `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESC} data sync runtime skill\n---\n\n${SKILL_BODY}\n`,
  );
  await writeText(
    join(zcode, "agents", `${AGENT_NAME}.md`),
    `---\nname: ${AGENT_NAME}\ndescription: ${AGENT_DESC} data sync runtime subagent\ntools: [Read]\n---\n${AGENT_BODY} Reply exactly as the task asks.\n`,
  );
  await writeText(
    join(zcode, "commands", `${COMMAND_NAME}.md`),
    `---\ndescription: data sync runtime command\n---\n${COMMAND_BODY} $ARGUMENTS\n`,
  );
  const inlineDir = join(zcode, "plugins", INLINE_PLUGIN);
  await writeText(
    join(inlineDir, ".zcode-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: INLINE_PLUGIN,
        version: "1.0.0",
        description: "data sync runtime inline plugin",
        mcpServers: {
          rt: { type: "stdio", command: "node", args: ["${ZCODE_PLUGIN_ROOT}/server.cjs"] },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(inlineDir, "server.cjs"),
    `${mcpServerScript(INLINE_PLUGIN, INLINE_RESULT)}\n`,
  );

  const configPath = join(zcode, "cli", "config.json");
  const config = await readFile(configPath, "utf-8")
    .then((text) => JSON.parse(text) as LocalCliConfig)
    .catch((): LocalCliConfig => ({}));
  const plugins = config.plugins ?? {};
  await writeText(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        mcp: {
          ...config.mcp,
          servers: {
            ...config.mcp?.servers,
            [MCP_SERVER]: {
              command: "node",
              args: ["-e", mcpServerScript(MCP_SERVER, MCP_RESULT)],
            },
          },
        },
        hooks: {
          enabled: true,
          events: { UserPromptSubmit: [{ hooks: [{ type: "command", command: HOOK_COMMAND }] }] },
        },
        plugins: {
          ...plugins,
          dirs: [...(plugins.dirs ?? []), inlineDir],
          enabledPlugins: { ...plugins.enabledPlugins, [`${INLINE_PLUGIN}@inline`]: true },
        },
      },
      null,
      2,
    )}\n`,
  );
}

/** 从子智能体推送完成起等足远端监听的发布窗口；已经过去的时间不再等待。 */
async function waitForSubagentPublishWindow(pushedAt: number): Promise<void> {
  const remaining = SUBAGENT_PUBLISH_WINDOW_MS - (Date.now() - pushedAt);
  if (remaining > 0) await browser.pause(remaining);
}

/** 远端钩子标记行数：文件不存在时为 0。 */
async function countRemoteHookLines(container: string): Promise<number> {
  const { stdout } = await execInRemoteContainer(container, [
    "sh",
    "-c",
    'grep -c "$1" "$2" 2>/dev/null || true',
    "sh",
    HOOK_MARK,
    `${REMOTE_HOME}/${HOOK_LOG}`,
  ]);
  return Number.parseInt(stdout.trim() || "0", 10);
}

/** 本轮首个模型请求（排除标题请求）：请求体文本与工具名。 */
async function readTurnRequest(lastUserMarker: string, afterIndex: number) {
  const query = { lastUserMessageIncludes: [lastUserMarker], excludes: [TITLE_REQUEST] };
  const [request] = await getUpstreamRequestEvidence(query, { afterIndex });
  if (!request) throw new Error(`${CASE_MARKER}: 没有找到 ${lastUserMarker} 的模型请求`);
  return {
    body: JSON.stringify(request.requestJson),
    tools: await getUpstreamRequestToolNames(query),
  };
}

function factsFromRequest(
  request: { body: string; tools: string[] },
  hookFired: boolean,
): StageFacts {
  return {
    skillListed: request.body.includes(SKILL_DESC),
    subagentListed: request.body.includes(AGENT_DESC),
    mcpTool: request.tools.includes(MCP_TOOL),
    inlinePluginTool: request.tools.includes(INLINE_TOOL),
    marketplacePluginTool: request.tools.includes(PLUGIN_LIFECYCLE_MCP_TOOL_NAME),
    hookFired,
  };
}

async function waitForTurnReply(userMarker: string, reply: string): Promise<string> {
  await browser.waitUntil(
    async () => hasAssistantReplyForUserTurn(await getV4Messages(), userMarker, reply),
    {
      timeout: SSH_LIFECYCLE_TURN_TIMEOUT_MS,
      timeoutMsg: `${CASE_MARKER}: ${userMarker} 没有收到回复 ${reply}`,
    },
  );
  const state = await waitForV4ConversationState(
    (snapshot) =>
      Boolean(snapshot.taskId && snapshot.taskId !== "draft") &&
      snapshot.state === "idle" &&
      snapshot.queueCount === 0,
    `${CASE_MARKER}: ${userMarker} 完成后没有回到 idle`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  );
  return state.taskId!;
}

/** 探针轮次：只回复固定文本，返回本轮模型请求里可见的推送内容与钩子是否执行。 */
async function sendProbe(container: string, label: string) {
  const prompt = `${CASE_MARKER}_PROBE_${label}`;
  const reply = `DSYNC_17_PROBE_${label}_REPLY`;
  const hookBefore = await countRemoteHookLines(container);
  const start = await getUpstreamRequestRecordCount();
  await sendV4PromptAndWaitAccepted(
    `${prompt}: 只回复 ${reply}`,
    prompt,
    `${CASE_MARKER}: 探针 ${label} 没有被接受`,
  );
  await waitForUpstreamRequest(
    { lastUserMessageIncludes: [prompt] },
    `${CASE_MARKER}: 探针 ${label} 没有到达回放`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
    { afterIndex: start - 1 },
  );
  const taskId = await waitForTurnReply(prompt, reply);
  const request = await readTurnRequest(prompt, start - 1);
  const hookFired = (await countRemoteHookLines(container)) > hookBefore;
  return { taskId, facts: factsFromRequest(request, hookFired) };
}

/** 命令轮次：远端 CLI 展开 /命令 时，本轮请求含命令正文与参数。 */
async function sendCommandProbe(label: string): Promise<boolean> {
  const args = `E2E_DSYNC_17_CMD_${label}`;
  const start = await getUpstreamRequestRecordCount();
  await sendV4PromptAndWaitAccepted(
    `/${COMMAND_NAME} ${args}`,
    args,
    `${CASE_MARKER}: 命令 ${label} 没有被接受`,
  );
  await waitForUpstreamRequest(
    { lastUserMessageIncludes: [args] },
    `${CASE_MARKER}: 命令 ${label} 没有到达回放`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
    { afterIndex: start - 1 },
  );
  await waitForTurnReply(args, `DSYNC_17_CMD_${label}_REPLY`);
  return (await readTurnRequest(args, start - 1)).body.includes(`${COMMAND_BODY} ${args}`);
}

interface RunOutcome {
  exposed: boolean;
  timedOut: boolean;
  result: UpstreamToolResultSnapshot | null;
  remoteProcesses?: string;
}

/** 远端进程快照（pid、父 pid、存活秒数、命令行），用来判断各阶段是否同一个 Agent 进程。 */
async function readRemoteAgentProcesses(container: string): Promise<string[]> {
  return (await readRemoteProcesses(container))
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/\s+/gu, " ")
        .replace(/\/home\/dev\/\.zcode\/server\/releases\/[^ ]*\//gu, ""),
    )
    .filter(
      (line) =>
        line &&
        !/ (ps|sh|sleep|sshd: .*@notty|grep) /u.test(` ${line.split(" ").slice(3).join(" ")} `),
    );
}

/** 远端进程快照：工具卡住时用来判断 MCP 服务器进程是否还在。 */
async function readRemoteProcesses(container: string): Promise<string> {
  return (await execInRemoteContainer(container, ["ps", "-ww", "-eo", "pid,ppid,etimes,args"]))
    .stdout;
}

/**
 * 执行轮次：回放在工具暴露时调用工具，否则回复 NOT_EXPOSED。
 * 远端默认模式可能弹权限请求；期间只批准当前请求，直到本轮出现最终回复。
 * 工具卡住时记录远端进程、停止本轮，继续后面的执行轮次，最后统一断言。
 */
async function runTool(container: string, key: string, instruction: string): Promise<RunOutcome> {
  const prompt = `${CASE_MARKER}_RUN_${key}`;
  const done = `DSYNC_17_RUN_${key}_DONE`;
  const notExposed = `DSYNC_17_RUN_${key}_NOT_EXPOSED`;
  await sendV4PromptAndWaitAccepted(
    `${prompt}: ${instruction}`,
    prompt,
    `${CASE_MARKER}: ${key} 执行轮次没有被接受`,
  );
  const toolCallId = `call_dsync17_${key.toLowerCase()}`;
  let reply: string | null = null;
  const settled = await browser
    .waitUntil(
      async () => {
        if (await hasV4PermissionDialog()) await approveV4Permission();
        const messages = await getV4Messages();
        reply =
          [done, notExposed].find((text) => hasAssistantReplyForUserTurn(messages, prompt, text)) ??
          null;
        return reply !== null;
      },
      { timeout: 120_000 },
    )
    .then(
      () => true,
      () => false,
    );
  if (!settled) {
    const remoteProcesses = await readRemoteProcesses(container);
    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      `${CASE_MARKER}: ${key} 停止后没有回到 idle`,
      SSH_LIFECYCLE_TURN_TIMEOUT_MS,
    );
    return {
      exposed: true,
      timedOut: true,
      result: await getLatestUpstreamToolResultByToolCallId(toolCallId),
      remoteProcesses,
    };
  }
  await waitForTurnReply(prompt, reply!);
  return {
    exposed: reply === done,
    timedOut: false,
    result: await getLatestUpstreamToolResultByToolCallId(toolCallId),
  };
}

async function readRowByText(text: string) {
  return await browser.execute((needle) => {
    const row = [
      ...document.querySelectorAll<HTMLElement>('[data-testid^="remote-sync-row-"]'),
    ].find(
      (candidate) =>
        candidate.dataset.syncStatus !== undefined && candidate.textContent?.includes(needle),
    );
    return row ? { status: row.dataset.syncStatus ?? null, text: row.textContent ?? "" } : null;
  }, text);
}

/** 进入分类页，等列出的行都是「推送」，推送后等它们都变成「已同步」。 */
async function pushCategory(tab: string, rowTexts: string[], timeout = 120_000): Promise<void> {
  await clickTestIdByDom(`remote-sync-tab-${tab}`, {
    timeout: 60_000,
    timeoutMsg: `${CASE_MARKER}: 同步弹窗没有 ${tab} 分类`,
  });
  for (const text of rowTexts) {
    await browser.waitUntil(async () => (await readRowByText(text))?.status === "push", {
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: ${tab} 分类的 ${text} 没有显示为「推送」`,
    });
  }
  await clickTestIdByDom("remote-sync-push", {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: ${tab} 分类的推送按钮不可用`,
  });
  for (const text of rowTexts) {
    await browser.waitUntil(async () => (await readRowByText(text))?.status === "synced", {
      timeout,
      timeoutMsg: `${CASE_MARKER}: ${tab} 分类的 ${text} 推送后没有变为「已同步」`,
    });
  }
}

/** 设置 → 数据同步 → 唯一在线设备 → 打开同步弹窗。 */
async function openDataSyncDialog(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "dataSync"), {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 设置页没有数据同步分区`,
  });
  await waitForTestIdByDom("remote-sync-device-list", {
    timeout: 60_000,
    timeoutMsg: `${CASE_MARKER}: 数据同步页没有在线设备`,
  });
  await clickTestIdByDom("remote-sync-device-action");
  await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
}

/** 关闭同步弹窗和设置页，回到打开设置前的界面。 */
async function closeDataSyncDialogAndSettings(): Promise<void> {
  // 关闭按钮只在概览页底栏。
  await clickTestIdByDom("remote-sync-tab-overview", { timeout: 30_000 });
  await clickTestIdByDom("remote-sync-close", { timeout: 30_000 });
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 30_000 });
  await browser.waitUntil(
    async () => !(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed()),
    { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 设置页没有关闭` },
  );
}

async function readMainPaneSessionId(): Promise<string | null> {
  return await browser.execute(
    (paneTestId) =>
      document.querySelector(`[data-testid="${paneTestId}"]`)?.getAttribute("data-session-id") ??
      null,
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
  );
}

/** 在远程项目里打开新建任务页并选好模型：预热会话在这一步建好。 */
async function openRemoteDraft(task: SSHLifecycleTask, provider: SSHLifecycleProvider) {
  await startDraftFromProject(task.workspacePath, { workspaceIdentity: task.identity });
  await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
    includePlainModelFallback: false,
    providerId: provider.id,
    providerName: provider.name,
  });
  await selectUpstreamThoughtLevelValue(SSH_LIFECYCLE_THOUGHT_LEVEL);
  const tab = await readRemoteTabSnapshot(task.identity, task.workspacePath);
  expect(tab.activeWorkspaceIdentity).toBe(task.identity);
  expect(await readMainPaneSessionId()).toBe("draft");
}

describe(`${CASE_MARKER}: 推送内容在远端会话中的可用时机`, () => {
  let provider: SSHLifecycleProvider | null = null;
  let config: SSHRuntimeConfig;
  let container = "";
  let taskA: SSHLifecycleTask;
  let processesAfterTaskA: string[] = [];
  const facts: Record<string, unknown> = {};
  const record = (key: string, value: unknown) => {
    facts[key] = value;
    process.stdout.write(`[${CASE_MARKER}] ${key} ${JSON.stringify(value)}\n`);
  };

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    // 诊断：结束时容器会被删除，先把远端 ~/.zcode 下的日志尾部拷进工件。
    if (container) {
      const logs = await execInRemoteContainer(container, [
        "sh",
        "-c",
        'find "$HOME/.zcode" -maxdepth 5 \\( -name "*.jsonl" -o -name "*.log" -o -name "*.ndjson" \\) -size -50M | while read -r f; do echo "=== $f"; tail -n 2000 "$f"; done',
      ]).catch((error: unknown) => ({ stdout: String(error) }));
      await writeFile(join(artifactDir, "remote-logs.txt"), logs.stdout);
    }
    await writeFile(join(artifactDir, "runtime-usage.json"), `${JSON.stringify(facts, null, 2)}\n`);
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DSYNC-17-01 推送前打开的新建任务页：推送子智能体、MCP、命令后在该页发送，子智能体可见；另开一页推送钩子后发送，钩子执行", async function () {
    this.timeout(40 * 60_000);
    await prepareSSHConnectionPage(CASE_MARKER);
    const prepared = await prepareSSHLifecycle(CASE_MARKER);
    provider = prepared.provider;
    config = prepared.config;
    container = readRemoteDockerContainer(CASE_MARKER);

    await writeLocalContent(getE2EAppDataPaths().homeDir);
    const marketplace = await createPluginLifecycleFixture("1.0.0");
    await addMarketplaceSourceThroughAgent(marketplace.marketplaceRoot);
    await installMarketplacePluginThroughAgent(
      PLUGIN_LIFECYCLE_NAME,
      PLUGIN_LIFECYCLE_MARKETPLACE_ID,
    );

    const controlStart = await getUpstreamRequestRecordCount();
    taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config,
      label: "A",
      provider,
      workspacePath: config.workspacePaths[0],
    });
    // 对照：推送前远端什么都没有，证明各标记不会误判为可见。
    const control = factsFromRequest(
      await readTurnRequest(taskA.firstPrompt, controlStart - 1),
      (await countRemoteHookLines(container)) > 0,
    );
    record("control", control);
    expect(Object.values(control).some(Boolean)).toBe(false);
    record("taskALastTurnAt", new Date().toISOString());

    await openRemoteDraft(taskA, provider);
    processesAfterTaskA = await readRemoteAgentProcesses(container);
    record("agentsAfterTaskA", processesAfterTaskA);
    await openDataSyncDialog();
    await pushCategory("subagents", [AGENT_NAME]);
    const subagentPushedAt = Date.now();
    await pushCategory("mcp", [MCP_SERVER]);
    await pushCategory("commands", [COMMAND_NAME]);
    await closeDataSyncDialogAndSettings();
    // 回到推送前打开的新建任务页（仍是草稿，没有新建）。
    expect(await readMainPaneSessionId()).toBe("draft");

    record("agentsAfterFirstPush", await readRemoteAgentProcesses(container));
    await waitForSubagentPublishWindow(subagentPushedAt);
    record("draftProbeAfterSubagentPushMs", Date.now() - subagentPushedAt);
    const draft = await sendProbe(container, "DRAFT");
    record("draftTaskId", draft.taskId);
    const draftCommand = await sendCommandProbe("DRAFT");
    record("draftPrewarmedBeforePush", { ...draft.facts, commandExpanded: draftCommand });
    expect(draft.facts.subagentListed).toBe(true);

    // 钩子推送会重建预热会话（与本机设置页保存一致），所以单独用一个新建任务页：
    // 与上面同批推送时，重建后的会话也会读到 MCP，上面「MCP 推送不重建」的事实就测不到了。
    await openRemoteDraft(taskA, provider);
    await openDataSyncDialog();
    await pushCategory("hooks", [HOOK_MARK]);
    await closeDataSyncDialogAndSettings();
    expect(await readMainPaneSessionId()).toBe("draft");
    const hookDraft = await sendProbe(container, "HOOK_DRAFT");
    record("hookDraftPrewarmedBeforePush", hookDraft.facts);
    expect(hookDraft.facts.hookFired).toBe(true);
  });

  it("DSYNC-17-02 推送前已有的 task：推送后续发，子智能体可见并能运行，记录其他内容；按名字调用 Skill", async function () {
    this.timeout(30 * 60_000);
    await selectV4TaskById(taskA.taskId, 30_000);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: taskA.workspacePath,
      expectedRemoteSessionId: taskA.remoteSessionId,
    });
    record("existingFirstProbeAt", new Date().toISOString());
    const existing = await sendProbe(container, "EXISTING_1");
    expect(existing.taskId).toBe(taskA.taskId);
    const existingCommand = await sendCommandProbe("EXISTING");
    record("existingAfterFirstPush", { ...existing.facts, commandExpanded: existingCommand });

    await openDataSyncDialog();
    await pushCategory("skills", [SKILL_NAME]);
    await pushCategory("plugins", [INLINE_PLUGIN, PLUGIN_LIFECYCLE_MARKETPLACE_ID], 300_000);
    await closeDataSyncDialogAndSettings();
    await selectV4TaskById(taskA.taskId, 30_000);

    const existingAfterAll = await sendProbe(container, "EXISTING_2");
    expect(existingAfterAll.taskId).toBe(taskA.taskId);
    record("existingAfterAllPushes", existingAfterAll.facts);
    const skill = await runTool(
      container,
      "SKILL_EXISTING",
      `调用 Skill 工具加载 ${SKILL_NAME}，然后只回复 DSYNC_17_RUN_SKILL_EXISTING_DONE`,
    );
    record("existingSkillByName", {
      called: skill.exposed,
      isError: skill.result?.isError ?? null,
      bodyReturned: skill.result?.content.includes(SKILL_BODY) ?? false,
    });
    // 推送前已有的 task 不只是列出子智能体，还能按推送的定义真正运行它。
    const existingAgent = await runTool(
      container,
      "EXISTING_AGENT",
      `用 Agent 工具运行子智能体 ${AGENT_NAME}，然后只回复 DSYNC_17_RUN_EXISTING_AGENT_DONE`,
    );
    record("existingAgentRun", existingAgent);
    record("existingLastTurnAt", new Date().toISOString());
    record("agentsAfterTaskARuns", await readRemoteAgentProcesses(container));
    expect(existing.facts.subagentListed).toBe(true);
    expect(existingAgent.timedOut).toBe(false);
    expect(existingAgent.exposed).toBe(true);
    expect(existingAgent.result?.isError).toBe(false);
    expect(existingAgent.result?.content).toContain(AGENT_DONE);
  });

  it("DSYNC-17-03 推送后新建 task：六类内容都可见，MCP、插件 MCP、Skill、子智能体真正执行，钩子执行，命令展开", async function () {
    this.timeout(30 * 60_000);
    record("agentsBeforeTaskC", await readRemoteAgentProcesses(container));
    await openRemoteDraft(taskA, provider!);
    const fresh = await sendProbe(container, "NEW");
    const processesAfterTaskC = await readRemoteAgentProcesses(container);
    record("agentsAfterTaskCProbe", processesAfterTaskC);
    // 新建 task 不需要重启 Agent：task C 的用户 MCP 服务器挂在推送前就服务 task A 的同一个 Agent 进程下。
    const mcpServerParent = processesAfterTaskC
      .find((line) => line.includes(`"${MCP_SERVER}"`))
      ?.split(" ")[1];
    expect(processesAfterTaskA.some((line) => line.split(" ")[0] === mcpServerParent)).toBe(true);
    record("newTask", fresh.facts);
    expect(fresh.facts).toEqual({
      skillListed: true,
      subagentListed: true,
      mcpTool: true,
      inlinePluginTool: true,
      marketplacePluginTool: true,
      hookFired: true,
    });
    expect(await sendCommandProbe("NEW")).toBe(true);

    const mcp = await runTool(
      container,
      "MCP",
      `调用 ${MCP_TOOL} 一次，然后只回复 DSYNC_17_RUN_MCP_DONE`,
    );
    const inline = await runTool(
      container,
      "INLINE",
      `调用 ${INLINE_TOOL} 一次，然后只回复 DSYNC_17_RUN_INLINE_DONE`,
    );
    const market = await runTool(
      container,
      "MARKET",
      `调用 ${PLUGIN_LIFECYCLE_MCP_TOOL_NAME} 一次，然后只回复 DSYNC_17_RUN_MARKET_DONE`,
    );
    const skill = await runTool(
      container,
      "SKILL_NEW",
      `调用 Skill 工具加载 ${SKILL_NAME}，然后只回复 DSYNC_17_RUN_SKILL_NEW_DONE`,
    );
    const agent = await runTool(
      container,
      "AGENT",
      `用 Agent 工具运行子智能体 ${AGENT_NAME}，然后只回复 DSYNC_17_RUN_AGENT_DONE`,
    );
    const subagentRequests = await countUpstreamRequests({ includes: [AGENT_BODY] });
    record("newTaskRuns", {
      mcp,
      inline,
      market,
      skill: {
        ...skill,
        result: null,
        bodyReturned: skill.result?.content.includes(SKILL_BODY) ?? false,
      },
      agent,
      subagentRequests,
    });
    record("agentsAfterTaskCRuns", await readRemoteAgentProcesses(container));

    for (const run of [mcp, inline, market, skill, agent]) {
      expect(run.timedOut).toBe(false);
      expect(run.exposed).toBe(true);
      expect(run.result?.isError).toBe(false);
    }
    expect(mcp.result?.content.trim()).toBe(MCP_RESULT);
    expect(inline.result?.content.trim()).toBe(INLINE_RESULT);
    expect(market.result?.content.trim()).toBe(MARKET_RESULT);
    expect(skill.result?.content).toContain(SKILL_BODY);
    expect(agent.result?.content).toContain(AGENT_DONE);
    expect(subagentRequests).toBeGreaterThan(0);
  });
});
