import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_TASK_ITEM,
  testId,
  TID_V4_SESSION_PANE,
  TID_V4_RETRY_SUBSCRIBE,
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  TID_V4_STOP,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
} from "@zcode/shared/test-ids";
import { clearAppData, switchToWorkspaceRendererWindow } from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  getUpstreamRequestRecordCount,
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  listRemoteAgentProcesses,
  readRemoteCoreIdentity,
  terminateRemoteProcess,
  SSH_LIFECYCLE_MODEL_ID,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  seedCustomAnthropicMessagesProvider,
  refreshSeededOpenAIProvidersThroughSettings,
} from "#e2e/helpers/custom-openai-provider";
import {
  createSSHReplayTunnel,
  readHostProcesses,
  readRemoteTabSnapshot,
  waitForRemoteTab,
  readSSHRuntimeConfig,
  runSSHCommand,
} from "#e2e/helpers/ssh-remote-p0";
import {
  approveV4Permission,
  clickFirstV4Fork,
  waitForV4Fork,
  clickV4StopInPane,
  getV4ConfigProjection,
  getV4ConversationState,
  prepareV4ConversationE2E,
  scrollV4TimelineToTop,
  sendV4Prompt,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  switchV4Mode,
  waitForV4ConversationState,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_SUBAGENT";
// 远端用例前置：Server 启动时设置 ZCODE_DYNAMIC_WORKFLOW_MODE=alwaysOn；WDIO 也为本文件开启。
// 常驻 Server 不继承客户端环境；本用例验证会话归属，灰度另有专用用例。
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-subagent");
const REMOTE_RELEASE_DIR = "/home/dev/r3-workspace-a/.zcode-e2e/r3-subagent";
const REMOTE_RELEASE_FILE = `${REMOTE_RELEASE_DIR}/release-child`;

async function selectFullAccessMode(): Promise<void> {
  // 子会话的 Bash 工具需要免确认模式；与 subagent E2E 同一入口：composer 模式切换到 yolo。
  await switchV4Mode("yolo");
  await browser.waitUntil(async () => (await getV4ConfigProjection()).mode === "yolo", {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: composer 没有收敛到 Full access mode`,
  });
}

async function readPanes(): Promise<
  Array<{
    paneTestId: string | null;
    sessionId: string | null;
    canStop: boolean;
    runningSubagentIds: string[];
    projectionSeq: string;
    rowCount: number;
    subscriptionFailed: boolean;
  }>
> {
  return browser.execute(
    (paneTestId, stopTestId, retrySubscribeTestId) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${paneTestId}"]`)).map(
        (pane) => ({
          paneTestId: pane.getAttribute("data-testid"),
          sessionId: pane.getAttribute("data-session-id"),
          canStop: Boolean(pane.querySelector(`[data-testid="${stopTestId}"]`)),
          runningSubagentIds: (pane.dataset.runningSubagentIds ?? "").split(",").filter(Boolean),
          projectionSeq: pane.dataset.projectionSeq ?? "",
          rowCount: pane.querySelectorAll("[data-row-id]").length,
          subscriptionFailed: Boolean(
            pane.querySelector(`[data-testid="${retrySubscribeTestId}"]`),
          ),
        }),
      ),
    TID_V4_SESSION_PANE,
    TID_V4_STOP,
    TID_V4_RETRY_SUBSCRIBE,
  );
}

describe(`${CASE_MARKER}: 远端 Agent、工作流 actor 与辅助对话的项目归属`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "subagent.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-TASK-06 子会话与父 task 同 Source、独立 session；从 Agent 行打开子会话；父 task 停止后父/子状态收口；工作流 actor 可读、辅助对话可续发", async function () {
    this.timeout(30 * 60_000);
    expect(await browser.electron.execute(() => process.env.ZCODE_DYNAMIC_WORKFLOW_MODE)).toBe(
      "alwaysOn",
    );
    const prepared = { config: readSSHRuntimeConfig(CASE_MARKER) };
    await prepareV4ConversationE2E({ skipProvider: true });
    expect(await readHostProcesses()).toHaveLength(1);
    const tunnel = await createSSHReplayTunnel(prepared.config, CASE_MARKER, {
      username: "tunnel",
    });
    provider = { id: "", name: "", tunnel };
    Object.assign(
      provider,
      await seedCustomAnthropicMessagesProvider({
        baseURL: `${tunnel.baseURL}/anthropic`,
        modelId: SSH_LIFECYCLE_MODEL_ID,
        providerId: `e2e-ssh-remote-lifecycle-${Date.now()}`,
        providerName: "SSH workflow lifecycle",
      }),
    );
    // 主/子模型在同一次刷新、首连同步前配置，确保远端 Agent 启动时拥有完整 provider 配置。
    await seedCustomAnthropicMessagesProvider({
      baseURL: `${provider.tunnel.baseURL}/anthropic`,
      modelId: "GLM-5.3",
      providerId: "e2e-workflow-actors",
      providerName: "Workflow actors",
    });
    await refreshSeededOpenAIProvidersThroughSettings([provider.name, "Workflow actors"]);
    const [workspaceA] = prepared.config.workspacePaths;
    await runSSHCommand(
      prepared.config,
      `rm -rf "${REMOTE_RELEASE_DIR}"; mkdir -p "${REMOTE_RELEASE_DIR}"`,
    );
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    await selectFullAccessMode();

    // 父回合先真实 Bash cd 到子目录，再触发 Agent 工具 → 远端子会话（子会话执行等待远端 release 文件的 Bash）。
    const start = await getUpstreamRequestRecordCount();
    await sendV4Prompt(`${CASE_MARKER}_PARENT 启动子任务`);
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_PARENT`] },
      `${CASE_MARKER}: 父回合没有到达回放`,
      90_000,
      { afterIndex: start - 1 },
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: ["R3_PARENT_CD_DONE"] },
      `${CASE_MARKER}: 父会话没有完成 cd`,
      90_000,
      { afterIndex: start - 1 },
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: ["R3_SUBAGENT_CHILD_TASK"] },
      `${CASE_MARKER}: 子会话没有发起模型请求`,
      120_000,
      { afterIndex: start - 1 },
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: ["Async agent launched successfully"] },
      `${CASE_MARKER}: 父回合没有收到子 Agent 启动确认`,
      120_000,
      { afterIndex: start - 1 },
    );
    await waitForV4TimelineContaining("R3_SUBAGENT_PARENT_LAUNCHED", 90_000);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: 父回合没有收口`,
      90_000,
    );

    // 打开子会话：Agent 工具行折叠在“已工作 N 秒”组里，先展开该组，再点 Agent 行的"打开侧栏"入口 → 第二个 pane。
    let childSessionId = "";
    await browser
      .waitUntil(
        async () => {
          const result = await browser.execute(
            (prefix, historyTrigger) => {
              for (const trigger of Array.from(
                document.querySelectorAll<HTMLElement>(`[data-testid^="${historyTrigger}"]`),
              )) {
                if (
                  trigger.getAttribute("aria-expanded") !== "true" &&
                  trigger.getAttribute("data-history-open") !== "true"
                )
                  trigger.click();
              }
              const button = Array.from(
                document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`),
              ).find((b) => b.getClientRects().length);
              if (!button) return null;
              const id = (button.getAttribute("data-testid") ?? "").slice(prefix.length + 1);
              button.click();
              return id;
            },
            TID_V4_SUBAGENT_OPEN_SIDE_PANE,
            TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
          );
          if (result) childSessionId = result;
          return Boolean(result);
        },
        {
          timeout: 60_000,
          interval: 500,
          timeoutMsg: `${CASE_MARKER}: Agent 行没有出现打开子会话入口`,
        },
      )
      .catch(async (error) => {
        // 诊断：远端 session 的 Agent 行是否缺少 childSessionId 映射（入口依赖 subagentRow.childSessionId）。
        facts.agentRowDiagnostics = await browser.execute(() => {
          const pane = document.querySelector<HTMLElement>('[data-testid^="v4-session-pane"]');
          const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-row-id]"));
          return {
            rowCount: rows.length,
            rows: rows.map((row) => ({
              text: row.innerText.replace(/\s+/gu, " ").slice(0, 160),
              testIds: Array.from(row.querySelectorAll<HTMLElement>("[data-testid]"))
                .map((n) => n.dataset.testid ?? "")
                .slice(0, 12),
            })),
            paneTestIds: Array.from(
              new Set(
                Array.from(pane?.querySelectorAll<HTMLElement>("[data-testid]") ?? []).map((n) =>
                  (n.dataset.testid ?? "")
                    .replace(/-\d+$/u, "-N")
                    .replace(/sess_[a-z0-9-]+/u, "sess_X"),
                ),
              ),
            ).slice(0, 80),
            paneText: (pane?.innerText ?? "").replace(/\s+/gu, " ").slice(0, 1200),
            subagentTestIds: Array.from(
              document.querySelectorAll<HTMLElement>(
                "[data-testid*='subagent'], [data-testid*='agent']",
              ),
            ).map((n) => n.dataset.testid ?? ""),
          };
        });
        const remoteLog = await runSSHCommand(
          prepared.config,
          'F=$(ls -t ~/.zcode/cli/log/*.jsonl | head -n1); grep -c "\"Agent\"" "$F" || true; grep -o "\"event\":\"[a-z_.]*subagent[a-z_.]*\"" "$F" | sort | uniq -c | tail -n 8',
        );
        facts.remoteSubagentLog = remoteLog.stdout.trim().split("\n");
        throw error;
      });
    let panes = await readPanes();
    await browser.waitUntil(
      async () => {
        panes = await readPanes();
        // 旧断言只看面板已挂载，即使订阅报错也通过；必须确认 child 首帧和正文已加载。
        return panes.some(
          (pane) =>
            pane.sessionId === childSessionId &&
            pane.projectionSeq !== "" &&
            pane.rowCount > 0 &&
            !pane.subscriptionFailed,
        );
      },
      {
        timeout: 30_000,
        timeoutMsg: `${CASE_MARKER}: 子会话 pane 没有打开: ${JSON.stringify(panes)}`,
      },
    );
    facts.childOpened = { childSessionId, parent: taskA.taskId, panes };
    expect(childSessionId).not.toBe(taskA.taskId);
    expect(childSessionId.startsWith("sess_")).toBe(true);
    // 子会话属于同一 Source（同一 remote tab 下），远端 workspace Agent 仍只有一个。
    const tab = await readRemoteTabSnapshot(taskA.identity);
    expect(tab.remoteSessionId).toBe(taskA.remoteSessionId);
    // Agent 的 cwd 由 Server 启动方式决定；进程归属以 Core 的直接子进程为准。
    const allRemoteAgents = await listRemoteAgentProcesses(prepared.config);
    facts.remoteAllAgents = allRemoteAgents.map((agent) => ({
      pid: agent.pid,
      ppid: agent.ppid,
      startTicks: agent.startTicks,
      cwd: agent.cwd,
    }));
    const remoteAgents = allRemoteAgents.filter(
      (agent) => agent.cwd === workspaceA || agent.cwd.startsWith(`${workspaceA} `),
    );
    facts.remoteWorkspaceAgents = remoteAgents.map((agent) => ({ pid: agent.pid, cwd: agent.cwd }));
    expect(allRemoteAgents.length).toBeGreaterThanOrEqual(1);
    expect(allRemoteAgents.length).toBeLessThanOrEqual(2);
    // 子 pane 可以是只读视图，不能把“没有停止按钮”当成已完成。
    await browser.waitUntil(
      async () => {
        panes = await readPanes();
        return (
          panes
            .find((pane) => pane.sessionId === taskA.taskId)
            ?.runningSubagentIds.includes(childSessionId) ?? false
        );
      },
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 父投影没有跟踪运行中的子会话` },
    );
    facts.childRunningWhenOpened = true;

    // 子会话仍在运行（等待远端 release）：远端 Bash 进程存在。
    const waitingBash = await runSSHCommand(prepared.config, `pgrep -f "release-child" | wc -l`);
    facts.remoteChildBashWaiting = Number.parseInt(waitingBash.stdout.trim() || "0", 10);

    // 必须先证明父回合已 admitted 且正在执行，不能从上一轮 idle 直接跳过 Stop。
    const parent2Marker = `${CASE_MARKER}_PARENT2`;
    const parent2Start = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${parent2Marker} 再等等`,
      parent2Marker,
      `${CASE_MARKER}: 父续发未被接受`,
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [parent2Marker] },
      `${CASE_MARKER}: 父续发没有执行`,
      60_000,
      { afterIndex: parent2Start - 1 },
    );
    await waitForV4TimelineContaining("R3_SUBAGENT_PARENT2_STREAMING", 60_000);
    await waitForV4Pane(
      (pane) => pane.sessionId === taskA.taskId && pane.canStop,
      `${CASE_MARKER}: 父续发没有可停止的运行态`,
      30_000,
    );
    facts.parentBeforeStop = (await getV4ConversationState()).state;
    expect(facts.parentBeforeStop).toBe("streaming");
    await clickV4StopInPane("workspace-main");
    await waitForV4ConversationState(
      (state) => state.taskId === taskA.taskId && state.state === "idle",
      `${CASE_MARKER}: 父 task Stop 后没有收口`,
      60_000,
    );
    // 释放受控后台子任务，独立等待父投影确认它结束；不以固定 10 秒代替状态证据。
    await runSSHCommand(prepared.config, `touch "${REMOTE_RELEASE_FILE}"`);
    await browser.waitUntil(
      async () => {
        panes = await readPanes();
        const parent = panes.find((pane) => pane.sessionId === taskA.taskId);
        return Boolean(
          parent && !parent.canStop && !parent.runningSubagentIds.includes(childSessionId),
        );
      },
      { timeout: 90_000, timeoutMsg: `${CASE_MARKER}: 子任务释放后父/子状态没有收口` },
    );
    await waitForV4ConversationState(
      (state) => state.taskId === taskA.taskId && state.state === "idle",
      `${CASE_MARKER}: 后台结果收口后父会话仍在运行`,
      60_000,
    );
    const afterRelease = await runSSHCommand(prepared.config, `pgrep -f "release-child" | wc -l`);
    facts.afterParentStop = {
      panes,
      parentState: (await getV4ConversationState()).state,
      remoteChildBashWaiting: Number.parseInt(afterRelease.stdout.trim() || "0", 10),
    };
    expect(panes.every((pane) => !pane.canStop)).toBe(true);
    const childPane = $(`[data-session-id="${childSessionId}"]`);
    await browser.waitUntil(
      async () => (await childPane.getText()).includes("R3_SUBAGENT_CHILD_DONE"),
      {
        timeout: 60_000,
        timeoutMsg: `${CASE_MARKER}: 子会话完成后详情没有收到最终正文`,
      },
    );
    expect(await childPane.$(`[data-testid="${TID_V4_RETRY_SUBSCRIBE}"]`).isExisting()).toBe(false);

    // 同一远端项目里的工作流 actor 没有 tasks 行，必须沿真实 CLI 父链打开正文。
    await sendV4Prompt("/workflow E2E_R3_WORKFLOW_START");
    await approveV4Permission();
    await waitForV4TimelineContaining("R3_WORKFLOW_STARTED", 120_000);
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const pill = document.querySelector<HTMLElement>(
            '[data-testid="workflow-agent-pill"][data-agent-open="true"][data-agent-status="done"]',
          );
          if (!pill) return false;
          pill.click();
          return true;
        }),
      { timeout: 120_000, timeoutMsg: "工作流 actor 没有完成或没有详情入口" },
    );
    let actorSessionId = "";
    await browser.waitUntil(
      async () => {
        const actor = (await readPanes()).find((pane) => pane.sessionId?.startsWith("sess_dwf-"));
        actorSessionId = actor?.sessionId ?? "";
        return Boolean(actor?.projectionSeq && actor.rowCount > 0 && !actor.subscriptionFailed);
      },
      { timeout: 30_000, timeoutMsg: "远端工作流 actor 详情没有加载" },
    );
    const actorPane = $(`[data-session-id="${actorSessionId}"]`);
    expect(await actorPane.getText()).toContain("R3_WORKFLOW_CHILD_DONE");
    expect(await actorPane.$(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).isExisting()).toBe(false);
    const actorRequests = await getUpstreamRequestEvidence({
      lastUserMessageIncludes: ["E2E_R3_WORKFLOW_CHILD"],
    });
    expect(
      actorRequests.some(
        (request) => (request.requestJson as { model?: string })?.model === "GLM-5.3",
      ),
    ).toBe(true);
    facts.workflowActor = { actorSessionId, model: "GLM-5.3", panes: await readPanes() };

    // 辅助对话也继承项目，但保留用户输入；不能跟工作流一起被设为只读。
    await sendV4Prompt("/side E2E_R3_SIDE_CHAT");
    let sideSessionId = "";
    await browser.waitUntil(
      async () => {
        const pane = (await readPanes()).find(
          (entry) =>
            entry.sessionId !== taskA.taskId &&
            entry.sessionId !== childSessionId &&
            entry.sessionId !== actorSessionId &&
            Boolean(entry.projectionSeq) &&
            !entry.subscriptionFailed,
        );
        if (!pane?.paneTestId || !pane.sessionId) return false;
        sideSessionId = pane.sessionId;
        return (await $(`[data-session-id="${sideSessionId}"]`).getText()).includes(
          "R3_SIDE_CHAT_DONE",
        );
      },
      { timeout: 60_000, timeoutMsg: "远端辅助对话未打开或无法发送" },
    );
    // 辅助对话直接挂载 SessionPane，没有分屏的 pane shell；在真实输入框中键入续发。
    const sidePane = $(`[data-session-id="${sideSessionId}"]`);
    const sideInput = sidePane.$(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`);
    await browser.waitUntil(
      async () => (await sideInput.getAttribute("contenteditable")) === "true",
      { timeout: 15_000, timeoutMsg: "辅助对话输入框不可编辑" },
    );
    await sideInput.click();
    await browser.keys("E2E_R3_SIDE_FOLLOWUP");
    await browser.waitUntil(async () => (await sideInput.getText()) === "E2E_R3_SIDE_FOLLOWUP", {
      timeout: 15_000,
      timeoutMsg: "辅助对话续发内容没有进入输入框",
    });
    const sideSend = sidePane.$(`[data-testid="${TID_V4_COMPOSER_SEND}"]`);
    await sideSend.waitForClickable();
    await sideSend.click();
    await browser.waitUntil(
      async () =>
        (await $(`[data-session-id="${sideSessionId}"]`).getText()).includes(
          "R3_SIDE_FOLLOWUP_DONE",
        ),
      { timeout: 60_000, timeoutMsg: "辅助对话续发未完成" },
    );
    facts.selectionSideChat = { sideSessionId, panes: await readPanes() };
    // 原回归只打开热 child，漏掉进程重启后的反向设置请求。先终止真实远端 Agent，
    // 再重启桌面清空 renderer 缓存；仅挂载 pane 或保留旧正文不算冷恢复成功。
    const beforeRestart = await listRemoteAgentProcesses(prepared.config);
    expect(beforeRestart.length).toBeGreaterThan(0);
    const core = await readRemoteCoreIdentity(prepared.config, CASE_MARKER);
    expect(beforeRestart.every((process) => process.ppid === core.pid)).toBe(true);
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        // 桌面先退出，防止旧订阅在故障注入后立即重启 Agent，污染冷恢复前置。
        for (const process of beforeRestart) {
          await terminateRemoteProcess(prepared.config, process, CASE_MARKER);
        }
        expect(await listRemoteAgentProcesses(prepared.config)).toEqual([]);
      },
    });
    await switchToWorkspaceRendererWindow("", 60_000);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
    });
    await selectV4TaskById(taskA.taskId, 60_000);
    await waitForV4TimelineContaining("R3_SUBAGENT_PARENT_LAUNCHED", 90_000);
    // 重启默认停在底部，虚拟列表未挂载较早的 Agent 行；先滚到历史窗口再找详情入口。
    await scrollV4TimelineToTop();
    await browser.waitUntil(
      async () =>
        browser.execute(
          (prefix, historyTrigger, childId) => {
            for (const trigger of document.querySelectorAll<HTMLElement>(
              `[data-testid^="${historyTrigger}"]`,
            )) {
              if (
                trigger.getAttribute("aria-expanded") !== "true" &&
                trigger.getAttribute("data-history-open") !== "true"
              )
                trigger.click();
            }
            const button = document.querySelector<HTMLElement>(
              `[data-testid="${prefix}-${childId}"]`,
            );
            if (!button?.getClientRects().length) return false;
            button.click();
            return true;
          },
          TID_V4_SUBAGENT_OPEN_SIDE_PANE,
          TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
          childSessionId,
        ),
      {
        timeout: 30_000,
        timeoutMsg: "冷启后原子会话没有详情入口",
      },
    );
    await browser.waitUntil(
      async () => {
        const pane = (await readPanes()).find((entry) => entry.sessionId === childSessionId);
        return (
          Boolean(pane?.projectionSeq && pane.rowCount > 0 && !pane.subscriptionFailed) &&
          (await $(`[data-session-id="${childSessionId}"]`).getText()).includes(
            "R3_SUBAGENT_CHILD_DONE",
          )
        );
      },
      { timeout: 60_000, timeoutMsg: "远端 Agent 重启后原子会话没有恢复历史正文" },
    );
    const afterRestart = await listRemoteAgentProcesses(prepared.config);
    expect(afterRestart.length).toBeGreaterThan(0);
    expect(
      afterRestart.every((current) =>
        beforeRestart.every(
          (previous) => current.pid !== previous.pid || current.startTicks !== previous.startTicks,
        ),
      ),
    ).toBe(true);
    expect(
      await $(`[data-session-id="${childSessionId}"]`)
        .$(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
        .isExisting(),
    ).toBe(false);
    facts.coldResume = { beforeRestart, afterRestart, childSessionId, panes: await readPanes() };
    await browser.saveScreenshot(resolve(artifactDir, "cold-resume-child.png"));
    // fork ACK 只在 Host 归属可用后返回；先即时打开，再退出两端进程验证落库。
    await selectV4TaskById(taskA.taskId, 60_000);
    await waitForV4Fork(30_000);
    expect(await clickFirstV4Fork()).toBe(true);
    let forkId = "";
    await browser.waitUntil(
      async () => {
        const state = await getV4ConversationState();
        if (!state.taskId || state.taskId === "draft" || state.taskId === taskA.taskId)
          return false;
        forkId = state.taskId;
        return state.state === "idle";
      },
      { timeout: 60_000, timeoutMsg: "fork ACK 后新会话未能打开" },
    );
    await waitForV4TimelineContaining(taskA.firstPrompt, 60_000);
    const forkProcesses = await listRemoteAgentProcesses(prepared.config);
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        for (const process of forkProcesses)
          await terminateRemoteProcess(prepared.config, process, CASE_MARKER);
        expect(await listRemoteAgentProcesses(prepared.config)).toEqual([]);
      },
    });
    await switchToWorkspaceRendererWindow("", 60_000);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
    });
    await selectV4TaskById(forkId, 60_000);
    await waitForV4TimelineContaining(taskA.firstPrompt, 60_000);
    const reopenedForkProcesses = await listRemoteAgentProcesses(prepared.config);
    expect(reopenedForkProcesses.length).toBeGreaterThan(0);
    expect(
      reopenedForkProcesses.every((current) =>
        forkProcesses.every(
          (old) => current.pid !== old.pid || current.startTicks !== old.startTicks,
        ),
      ),
    ).toBe(true);
    facts.forkColdResume = {
      forkId,
      forkProcesses,
      reopenedForkProcesses,
      panes: await readPanes(),
    };

    await browser.saveScreenshot(resolve(artifactDir, "cold-resume-fork.png"));
    expect(await $(`[data-testid="${testId(TID_TASK_ITEM, taskA.taskId)}"]`).isExisting()).toBe(
      true,
    );
    for (const hiddenId of [childSessionId, actorSessionId, sideSessionId]) {
      expect(await $(`[data-testid="${testId(TID_TASK_ITEM, hiddenId)}"]`).isExisting()).toBe(
        false,
      );
    }
  });
});
