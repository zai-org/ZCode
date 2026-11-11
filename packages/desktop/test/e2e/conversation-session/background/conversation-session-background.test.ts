import {
  assertIncomingMessage,
  assertTaskNotificationContents,
} from "#e2e/helpers/incoming-message-evidence";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  TID_CHAT_ASSISTANT_HISTORY_CONTENT,
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_CHAT_BACKGROUND_RESULT_TITLE,
  TID_CHAT_LOADING,
  TID_CHAT_MESSAGES,
  TID_CHAT_USER_MESSAGE,
  TID_V4_BACKGROUND_WORK_CANCEL,
  TID_V4_SESSION_PANE,
  TID_V4_TURN_NAVIGATOR_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { clearAppData, seedSettings } from "#e2e/helpers/desktop-app";
import {
  waitForCompactMarkerStatus,
  waitForCompactMarkerStatuses,
} from "#e2e/helpers/conversation-session-compact";
import {
  countUpstreamRequests,
  findFirstUpstreamRequestIndex,
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
  getLatestUpstreamToolResultByToolCallId,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  clickFirstQueueSendNow,
  waitForQueueOrderContaining,
} from "#e2e/helpers/conversation-session-queue";
import {
  expandToolCallDetails,
  listToolCallBlocks,
  waitForToolCallBlockByToolCallId,
  waitForToolCallBlockByToolName,
} from "#e2e/helpers/conversation-session-tool";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  assertVisibleV4UserMessagesNotContaining,
  clickV4Stop,
  getV4ConversationState,
  getV4Messages,
  getV4PaneSnapshot,
  openV4ComposerRunningBackgroundWorks,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4TimelineContaining,
  waitForV4UserMessageContaining,
  V4_MAIN_PANE_ID,
} from "#e2e/helpers/v4-conversation";
import {
  ensureToolCrossProductFullAccessMode,
  respondToToolCrossProductBlockers,
} from "#e2e/helpers/conversation-session-tool-cross-product";
import {
  beginConversationTelemetryCapture,
  checkpointConversationTelemetryCase,
  waitForConversationReportDelta,
  type ConversationTelemetryReport,
} from "#e2e/helpers/conversation-telemetry-parity-capture";

const BACKGROUND_E2E_TIMEOUT_MS = 240000;
const BACKGROUND_RUNTIME_ROOT = resolveE2ERuntimePath("conversation-session-background");
const BG14_PREVIEW_RELEASE_FILE = resolveE2ERuntimePath(
  "conversation-session-background",
  "bg14-preview-release",
);
const BG08_ROOT_PID_FILE = resolveE2ERuntimePath(
  "conversation-session-background",
  "bg08-root.pid",
);
const BG08_LAUNCHER_PID_FILE = resolveE2ERuntimePath(
  "conversation-session-background",
  "bg08-launcher.pid",
);
const BG08_WORKER_PID_FILE = resolveE2ERuntimePath(
  "conversation-session-background",
  "bg08-worker.pid",
);
const BG08_LAUNCHER_SCRIPT_FILE = resolveE2ERuntimePath(
  "conversation-session-background",
  "bg08-launcher.cjs",
);
const BG08_LAUNCHER_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'const { writeFileSync } = require("node:fs");',
  'writeFileSync(process.argv[2], String(process.pid) + "\\n");',
  'const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {',
  '  stdio: "ignore",',
  "});",
  'if (!worker.pid) throw new Error("BG08 worker did not start");',
  'writeFileSync(process.argv[3], String(worker.pid) + "\\n");',
  "setInterval(() => {}, 1000);",
].join("\n");
const BG21_RELEASE_FILE = resolveE2ERuntimePath(
  "conversation-session-background",
  "bg21-child-tool-release",
);
const BG38_STARTED_FILE = resolveE2ERuntimePath(
  "conversation-session-background",
  "bg38-bash-started",
);
const BACKGROUND_SEND_NOW_QUEUE_RELEASE_FILE = resolveE2ERuntimePath(
  "conversation-session-background",
  "background-send-now-queue-release",
);
const BACKGROUND_CHILD_TOOL_IDLE_RELEASE_FILE = resolveE2ERuntimePath(
  "conversation-session-background",
  "background-child-tool-idle-release",
);
const BACKGROUND_PARENT_ANCHOR_RELEASE_FILE = resolveE2ERuntimePath(
  "conversation-session-background",
  "background-parent-anchor-release",
);
const BACKGROUND_SWITCH_BACK_RELEASE_FILE = resolveE2ERuntimePath(
  "conversation-session-background",
  "background-switch-back-release",
);
const BACKGROUND_MIXED_FOREGROUND_RELEASE_FILE = resolveE2ERuntimePath(
  "conversation-session-background",
  "agent-composition-mixed-foreground-release",
);

interface BackgroundResultPresentationSnapshot {
  assistantText: string;
  historyContentCount: number;
  visibleHistoryContentCount: number;
  historyTriggerId: string | null;
  historyTriggerCount: number;
  historyExpanded: string | null;
  titleOutsideHistory: boolean;
  navigatorItemCount: number;
  title: string;
}

async function getBackgroundResultPresentation(
  expectedTitle: string,
): Promise<BackgroundResultPresentationSnapshot | null> {
  return browser.execute(
    (titleTestId, historyTriggerTestId, historyContentTestId, navigatorItemTestId, title) => {
      const titleNode = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${titleTestId}-"]`),
      ).find((node) => node.textContent?.trim() === title);
      const turn = titleNode?.closest<HTMLElement>("[data-turn-key]");
      if (!titleNode || !turn) return null;
      return {
        assistantText: turn.innerText,
        historyContentCount: turn.querySelectorAll(`[data-testid^="${historyContentTestId}-"]`)
          .length,
        visibleHistoryContentCount: Array.from(
          turn.querySelectorAll<HTMLElement>(`[data-testid^="${historyContentTestId}-"]`),
        ).filter(
          (node) =>
            node.getBoundingClientRect().height > 0 &&
            getComputedStyle(node).visibility !== "hidden",
        ).length,
        historyTriggerId:
          turn
            .querySelector(`[data-testid^="${historyTriggerTestId}-"]`)
            ?.getAttribute("data-testid") ?? null,
        historyTriggerCount: turn.querySelectorAll(`[data-testid^="${historyTriggerTestId}-"]`)
          .length,
        navigatorItemCount: document.querySelectorAll(`[data-testid^="${navigatorItemTestId}-"]`)
          .length,
        historyExpanded:
          turn
            .querySelector(`[data-testid^="${historyTriggerTestId}-"]`)
            ?.getAttribute("aria-expanded") ?? null,
        titleOutsideHistory: titleNode.closest('[data-slot="collapsible-content"]') === null,
        title: titleNode.textContent?.trim() ?? "",
      };
    },
    TID_CHAT_BACKGROUND_RESULT_TITLE,
    TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
    TID_CHAT_ASSISTANT_HISTORY_CONTENT,
    TID_V4_TURN_NAVIGATOR_ITEM,
    expectedTitle,
  );
}

async function waitForBackgroundResultPresentation(options: {
  assistantMarker: string;
  expectedTitle: string;
  failureLabel: string;
}): Promise<void> {
  let snapshot: BackgroundResultPresentationSnapshot | null = null;
  let titles: string[] = [];
  try {
    await browser.waitUntil(
      async () => {
        snapshot = await getBackgroundResultPresentation(options.expectedTitle);
        // 失败时带上页面里实际出现的结果轮标题，区分“标题不同”与“折叠状态不对”。
        titles = await browser.execute(
          (titleTestId) =>
            Array.from(
              document.querySelectorAll<HTMLElement>(`[data-testid^="${titleTestId}-"]`),
            ).map((node) => node.textContent?.trim() ?? ""),
          TID_CHAT_BACKGROUND_RESULT_TITLE,
        );
        return Boolean(
          snapshot &&
          snapshot.assistantText.includes(options.assistantMarker) &&
          snapshot.historyTriggerCount === 1 &&
          snapshot.historyExpanded === "false" &&
          snapshot.titleOutsideHistory &&
          snapshot.visibleHistoryContentCount === 0 &&
          snapshot.navigatorItemCount === 0,
        );
      },
      {
        timeout: 60000,
        timeoutMsg: `${options.failureLabel} 结果轮等待超时`,
      },
    );
  } catch (error) {
    throw new Error(
      `${options.failureLabel} 没有显示结构化标题、完成态折叠入口缺失，或被计入 turn navigator; titles=${JSON.stringify(titles)}; snapshot=${JSON.stringify(snapshot)}`,
      { cause: error },
    );
  }
  expect(snapshot).toMatchObject({
    visibleHistoryContentCount: 0,
    historyTriggerCount: 1,
    historyExpanded: "false",
    titleOutsideHistory: true,
    navigatorItemCount: 0,
    title: options.expectedTitle,
  });

  // 必须观察实际过程容器：仅检查触发器状态会漏掉内容仍可见的回归。
  const completed = await getBackgroundResultPresentation(options.expectedTitle);
  expect(completed?.historyTriggerId).toBeTruthy();
  const trigger = await $(`[data-testid="${completed!.historyTriggerId}"]`);
  for (const expanded of [true, false]) {
    await trigger.click();
    await browser.waitUntil(
      async () => {
        const current = await getBackgroundResultPresentation(options.expectedTitle);
        return Boolean(
          current &&
          current.historyExpanded === String(expanded) &&
          current.visibleHistoryContentCount === (expanded ? 1 : 0) &&
          (!expanded ||
            (current.historyContentCount === 1 &&
              current.assistantText.includes("background-history-visible"))) &&
          current.titleOutsideHistory &&
          current.assistantText.includes(options.assistantMarker),
        );
      },
      {
        timeout: 5000,
        timeoutMsg: `${options.failureLabel} 过程${expanded ? "展开" : "收起"}后内容可见性或最终结果不符合预期`,
      },
    );
  }
}

describe("会话区 Background Runtime Task E2E", () => {
  before(async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);
    await mkdir(BACKGROUND_RUNTIME_ROOT, { recursive: true });
    await writeFile(BG08_LAUNCHER_SCRIPT_FILE, BG08_LAUNCHER_SCRIPT, "utf-8");
    await removeBg08PidFiles();
    await seedSettings({ messageStreamShowTodos: true });
    await prepareV4ConversationE2E();
  });

  afterEach(async () => {
    // BG21 / send-now 的 child Bash 使用文件 barrier；失败收尾也要先释放，
    // 避免遗留后台进程。
    await Promise.all([
      writeFile(BG21_RELEASE_FILE, "release\n", "utf-8").catch(() => undefined),
      writeFile(BACKGROUND_SEND_NOW_QUEUE_RELEASE_FILE, "release\n", "utf-8").catch(
        () => undefined,
      ),
      writeFile(BACKGROUND_CHILD_TOOL_IDLE_RELEASE_FILE, "release\n", "utf-8").catch(
        () => undefined,
      ),
      writeFile(BACKGROUND_PARENT_ANCHOR_RELEASE_FILE, "release\n", "utf-8").catch(() => undefined),
      writeFile(BACKGROUND_SWITCH_BACK_RELEASE_FILE, "release\n", "utf-8").catch(() => undefined),
    ]);
    await stopIfBusy();
    await cleanupBg08ProcessTree();
    await rm(BG21_RELEASE_FILE, { force: true }).catch(() => undefined);
    await rm(BACKGROUND_SEND_NOW_QUEUE_RELEASE_FILE, { force: true }).catch(() => undefined);
    await rm(BACKGROUND_CHILD_TOOL_IDLE_RELEASE_FILE, { force: true }).catch(() => undefined);
    await rm(BACKGROUND_PARENT_ANCHOR_RELEASE_FILE, { force: true }).catch(() => undefined);
    await rm(BACKGROUND_SWITCH_BACK_RELEASE_FILE, { force: true }).catch(() => undefined);
    await rm(BG38_STARTED_FILE, { force: true }).catch(() => undefined);
    await removeBg08PidFiles();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(BACKGROUND_RUNTIME_ROOT, { force: true, recursive: true });
    await clearAppData();
  });

  it("background Agent 完成后通过 task-notification 唤醒父会话且不显示 synthetic user", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const prompt =
      "E2E_BACKGROUND_AGENT: Launch a background agent and summarize only after its notification.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      prompt,
      "E2E_BACKGROUND_AGENT",
      "background Agent prompt 没有被 composer 接受",
    );
    await waitForToolCallBlockByToolName("Agent", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_AGENT", "Async agent launched successfully"],
      },
      requestCountBefore,
      "background Agent launch tool result 没有进入父模型请求",
    );
    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: ["<task-notification>", "E2E_BACKGROUND_AGENT_CHILD_RESULT"],
      },
      launchIndex,
      "background Agent completion notification 没有进入父模型请求",
    );

    expect(notificationIndex).toBeGreaterThan(launchIndex);
    await waitForV4AssistantMessageContaining("background-agent-notification-consumed-ok");
    // Bug 根因：V4 completed turn 会把旧 Agent tool card 收进 timeline history；
    // 本 case 的主合同由 notification 请求顺序、独立结果轮和无 synthetic user 共同覆盖，
    // 不再重复依赖 legacy card 的瞬时展开状态。
    await waitForIdle("background Agent notification 后会话没有回到 idle");
    await waitForBackgroundResultPresentation({
      assistantMarker: "background-agent-notification-consumed-ok",
      expectedTitle: "Check background",
      failureLabel: "background Agent 独立结果轮",
    });
    await assertNoVisibleTaskNotification();

    await browser.refresh();
    await waitForBackgroundResultPresentation({
      assistantMarker: "background-agent-notification-consumed-ok",
      expectedTitle: "Check background",
      failureLabel: "background Agent 刷新恢复结果轮",
    });
  });

  it("background Bash 完成后复用同一 notification/wake 链路", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const capture = await beginBackgroundTelemetryCapture();
    const prompt =
      "E2E_BACKGROUND_BASH: Run a background Bash command and report after notification.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "background Bash prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_BASH");
    await waitForToolCallBlockByToolName("Bash", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_BASH", "Command running in background"],
      },
      requestCountBefore,
      "background Bash launch tool result 没有进入父模型请求",
    );
    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_BASH",
          "<task-notification>",
          "<tool-use-id>toolu_e2e_background_bash</tool-use-id>",
          "<status>completed</status>",
        ],
      },
      launchIndex,
      "background Bash completion notification 没有进入父模型请求",
    );

    expect(notificationIndex).toBeGreaterThan(launchIndex);
    await waitForV4AssistantMessageContaining("background-bash-notification-consumed-ok");
    await waitForIdle("background Bash notification 后会话没有回到 idle");
    await waitForBackgroundResultPresentation({
      assistantMarker: "background-bash-notification-consumed-ok",
      expectedTitle: "Print background marker",
      failureLabel: "background Bash 独立结果轮",
    });
    // 失败原因：完成后的 Bash 块收在 assistant history 里，waitForToolCallBlock 找不到时会
    // 主动展开 history；放在“结果轮默认收起”断言之前，就是测试自己把它展开了。
    // 必须先验证默认收起，再读块状态。
    const block = await waitForToolCallBlockByToolName("Bash", 30000);
    expect(block.status).not.toBe("running");
    await assertNoVisibleTaskNotification();
    const reports = await waitForConversationReportDelta(capture, {
      message_completion: 2,
    });
    assertMainCompletionAgentCompositions(reports, ["main_only", "main_only"]);
    assertMainCompletionMessageSources(reports, ["chat", "background_task"]);
  });

  it("background task running 时用户普通消息应直接发送而不是进入 queue", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const launchPrompt =
      "E2E_BACKGROUND_DIRECT_USER_PROMPT_SETUP: Start a long background Bash command and wait for my next message.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4Prompt(launchPrompt);
    await waitForV4ComposerText("", "background direct user prompt setup 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_DIRECT_USER_PROMPT_SETUP");
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_direct_user_prompt_bash", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_DIRECT_USER_PROMPT_SETUP", "Command running in background"],
      },
      requestCountBefore,
      "background direct user prompt setup 的 Bash launch result 没有进入父模型请求",
    );
    await waitForV4AssistantMessageContaining("background-direct-user-prompt-launched-ok");
    await waitForIdle("background direct user prompt setup 后父会话没有回到 idle");
    await waitForBackgroundTaskControlRow(
      "bash",
      "background direct user prompt bash sleep",
      "background direct user prompt Bash 没有出现在统一 background control UI",
    );

    const directPrompt =
      "E2E_BACKGROUND_DIRECT_USER_PROMPT: This message should be sent immediately while the background task is still running. Payload: E2E_BACKGROUND_DIRECT_USER_PROMPT_PAYLOAD.";
    await sendV4Prompt(directPrompt);
    await waitForV4ComposerText("", "background running 时用户新消息发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_DIRECT_USER_PROMPT_PAYLOAD");
    const directSnapshot = await getV4ConversationState();
    expect(directSnapshot.queueCount).toBe(0);

    const directPromptIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_DIRECT_USER_PROMPT",
          "E2E_BACKGROUND_DIRECT_USER_PROMPT_PAYLOAD",
        ],
        lastUserMessageIncludes: ["E2E_BACKGROUND_DIRECT_USER_PROMPT_PAYLOAD"],
      },
      launchIndex,
      "background running 时用户普通消息没有立即进入 provider request",
    );

    expect(directPromptIndex).toBeGreaterThan(launchIndex);
    await waitForV4AssistantMessageContaining("background-direct-user-prompt-received-ok");
    await waitForIdle("background running 时用户普通消息响应后会话没有回到 idle");
    await waitForBackgroundTaskControlRow(
      "bash",
      "background direct user prompt bash sleep",
      "用户普通消息完成后 background Bash control row 不应消失",
    );

    await clickStopBackgroundTaskControlRow("bash", "background direct user prompt bash sleep");
    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_DIRECT_USER_PROMPT_SETUP",
          "<task-notification>",
          "<tool-use-id>toolu_e2e_background_direct_user_prompt_bash</tool-use-id>",
          "<status>killed</status>",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      directPromptIndex,
      "background direct user prompt Bash stop notification 没有进入父模型请求",
    );

    expect(notificationIndex).toBeGreaterThan(directPromptIndex);
    await waitForV4AssistantMessageContaining("background-direct-user-prompt-bash-stopped-ok");
    await waitForNoBackgroundTaskControlRow(
      "bash",
      "background direct user prompt bash sleep",
      "被停止的 background direct user prompt Bash 仍显示为 running",
    );
    await waitForIdle("background direct user prompt Bash stop notification 后会话没有回到 idle");
    await assertNoVisibleTaskNotification();
  });

  it("background task running 且 main idle 时允许 compact，完成 notification 基于 compact 后上下文继续", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const prompt =
      "E2E_BACKGROUND_COMPACT_AFTER_IDLE: Start a background Bash, then stay idle while I compact the conversation.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      prompt,
      "E2E_BACKGROUND_COMPACT_AFTER_IDLE",
      "background compact setup prompt 没有被 composer 接受",
    );
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_compact_after_idle_bash", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_COMPACT_AFTER_IDLE", "Command running in background"],
      },
      requestCountBefore,
      "background compact Bash launch tool result 没有进入父模型请求",
    );
    await waitForV4AssistantMessageContaining("background-compact-launched-ok");
    await waitForIdle("background compact setup 后 main 没有回到 idle");
    await waitForBackgroundTaskControlRow(
      "bash",
      "background compact bash sleep",
      "background compact Bash 没有出现在统一 background control UI",
    );

    await sendV4Prompt("/compact");
    await waitForV4ComposerText("", "background running 时 /compact 发送后输入框没有清空");
    // Bug 根因：V4 compact row 会原位从 running 更新成 success，快速 replay 下
    // started 可能在 WDIO 首次轮询前就收口；completed 同样能证明命令已被 admission。
    const compactMarker = await waitForCompactMarkerStatuses(["started", "completed"], "manual");
    expect(compactMarker.inputId).toBeTruthy();
    if (compactMarker.status !== "completed") {
      await waitForCompactMarkerStatus("completed", "manual", compactMarker.inputId);
    }

    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "<task-notification>",
          "E2E_BACKGROUND_COMPACT_SUMMARY_MARKER",
          "toolu_e2e_background_compact_after_idle_bash",
          "<status>completed</status>",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      launchIndex,
      "background compact 后 completion notification 没有基于 compact 摘要进入父模型请求",
    );
    expect(notificationIndex).toBeGreaterThan(launchIndex);
    await waitForV4AssistantMessageContaining("background-compact-notification-consumed-ok");
    await waitForIdle("background compact notification 后会话没有回到 idle");
    await assertNoVisibleTaskNotification();
  });

  it("foreground long-running Bash timeout 后会转为 background，并在完成后从 UI 移除", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const prompt =
      "E2E_BACKGROUND_AUTO_TIMEOUT_BASH: Run an eligible foreground Bash command that should auto-background on timeout, then report after completion.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      prompt,
      "E2E_BACKGROUND_AUTO_TIMEOUT_BASH",
      "foreground Bash auto-background prompt 没有被 composer 接受",
    );
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_auto_timeout_bash", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        // 前台 Bash 超时转后台时，结果写明超时并给出后台任务 ID。
        includes: ["E2E_BACKGROUND_AUTO_TIMEOUT_BASH", "and was moved to the background (ID:"],
      },
      requestCountBefore,
      "foreground Bash timeout 后没有返回 backgrounded tool result",
    );
    await waitForBackgroundTaskControlRow(
      "bash",
      "auto timeout bash sleep",
      "auto-background Bash 没有出现在统一 background control UI",
    );

    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_AUTO_TIMEOUT_BASH",
          "<task-notification>",
          "<tool-use-id>toolu_e2e_background_auto_timeout_bash</tool-use-id>",
          "<status>completed</status>",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      launchIndex,
      "auto-background Bash completion notification 没有进入父模型请求",
    );

    expect(notificationIndex).toBeGreaterThan(launchIndex);
    await waitForV4AssistantMessageContaining("background-auto-timeout-bash-completed-ok");
    await waitForNoBackgroundTaskControlRow(
      "bash",
      "auto timeout bash sleep",
      "自然完成的 auto-background Bash 仍显示为 running",
    );
    await waitForIdle("auto-background Bash notification 后会话没有回到 idle");
    await assertNoVisibleTaskNotification();
  });

  it("explicit background Bash 越过 input timeout 后仍自然完成且只通知一次", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const prompt =
      "E2E_BG37_EXPLICIT_TIMEOUT: Start an explicit background Bash whose timeout is shorter than its runtime, then report after completion.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      prompt,
      "E2E_BG37_EXPLICIT_TIMEOUT",
      "BG37 prompt 没有被 composer 接受",
    );
    await waitForToolCallBlockByToolCallId("toolu_e2e_bg37_explicit_timeout", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BG37_EXPLICIT_TIMEOUT", "Command running in background"],
      },
      requestCountBefore,
      "BG37 explicit Bash 没有返回 background task ID",
    );
    const launchResult = await getLatestUpstreamToolResultByToolCallId(
      "toolu_e2e_bg37_explicit_timeout",
    );
    const outputPath = /Output is being written to: (.+?)\. You will be notified/u.exec(
      launchResult?.content ?? "",
    )?.[1];
    expect(outputPath).toBeTruthy();
    // 根因回归：后台 launch 成功不能代替实时落盘证据；在 DONE 之前读取同一路径。
    const runningOutput = await readFile(outputPath!, "utf8");
    expect(runningOutput).toContain("E2E_BG37_STARTED");
    expect(runningOutput).not.toContain("E2E_BG37_DONE");
    await waitForBackgroundTaskControlRow(
      "bash",
      "BG37 explicit timeout bash",
      "BG37 explicit Bash 没有出现在 background control UI",
    );
    await browser.pause(100);
    await waitForBackgroundTaskControlRow(
      "bash",
      "BG37 explicit timeout bash",
      "BG37 explicit Bash 越过 input timeout 后不应被终止",
    );

    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BG37_EXPLICIT_TIMEOUT",
          "<task-notification>",
          "<tool-use-id>toolu_e2e_bg37_explicit_timeout</tool-use-id>",
          "<status>completed</status>",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      launchIndex,
      "BG37 explicit Bash completion notification 没有进入父模型请求",
    );
    await waitForV4AssistantMessageContaining("bg37-explicit-timeout-completed-ok");
    expect(
      await countUpstreamRequests(
        {
          includes: [
            "<task-notification>",
            "<tool-use-id>toolu_e2e_bg37_explicit_timeout</tool-use-id>",
          ],
        },
        { afterIndex: launchIndex },
      ),
    ).toBe(1);
    expect(notificationIndex).toBeGreaterThan(launchIndex);
    await waitForNoBackgroundTaskControlRow(
      "bash",
      "BG37 explicit timeout bash",
      "BG37 completed Bash 仍显示为 running",
    );
    await waitForIdle("BG37 completion notification 后会话没有回到 idle");
    const completedOutput = await readFile(outputPath!, "utf8");
    expect(completedOutput).toContain("E2E_BG37_STARTED");
    expect(completedOutput).toContain("E2E_BG37_DONE");
  });

  it("explicit Bash commit 后停止 parent turn 不会终止后台进程", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await rm(BG38_STARTED_FILE, { force: true }).catch(() => undefined);
    await startNewBackgroundDraft();
    const prompt =
      "E2E_BG38_PARENT_ABORT: Start an explicit background Bash, keep the parent turn running, and let me stop that turn after the task starts.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      prompt,
      "E2E_BG38_PARENT_ABORT",
      "BG38 prompt 没有被 composer 接受",
    );
    await waitForToolCallBlockByToolCallId("toolu_e2e_bg38_parent_abort", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BG38_PARENT_ABORT", "Command running in background"],
      },
      requestCountBefore,
      "BG38 explicit Bash 没有完成 background commit",
    );
    await waitForBackgroundTaskControlRow(
      "bash",
      "BG38 parent abort bash",
      "BG38 committed Bash 没有出现在 background control UI",
    );
    let startedMarker = "";
    await browser.waitUntil(
      async () => {
        startedMarker = await readFile(BG38_STARTED_FILE, "utf-8").catch(() => "");
        return startedMarker.includes("E2E_BG38_STARTED");
      },
      {
        timeout: 30000,
        timeoutMsg: `BG38 Bash 没有写出 started marker; latest=${startedMarker}`,
      },
    );
    await waitForMainLoading("BG38 parent turn 在 stop 前没有保持 running");
    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming",
      "BG38 parent turn stop 后没有退出 streaming",
      30000,
    );
    await waitForBackgroundTaskControlRow(
      "bash",
      "BG38 parent abort bash",
      "BG38 parent turn stop 后后台 control row 不应消失",
    );

    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BG38_PARENT_ABORT",
          "<task-notification>",
          "<tool-use-id>toolu_e2e_bg38_parent_abort</tool-use-id>",
          "<status>completed</status>",
          "E2E_BG38_DONE",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      launchIndex,
      "BG38 parent abort 后 Bash 没有自然完成",
    );
    await waitForV4AssistantMessageContaining("bg38-parent-abort-background-completed-ok");
    expect(
      await countUpstreamRequests(
        {
          includes: [
            "<task-notification>",
            "<tool-use-id>toolu_e2e_bg38_parent_abort</tool-use-id>",
          ],
        },
        { afterIndex: launchIndex },
      ),
    ).toBe(1);
    expect(notificationIndex).toBeGreaterThan(launchIndex);
    await waitForNoBackgroundTaskControlRow(
      "bash",
      "BG38 parent abort bash",
      "BG38 completed Bash 留下 orphan control row",
    );
    await waitForIdle("BG38 completion notification 后会话没有回到 idle");
  });

  it("首 token 为 sleep 的 foreground Bash timeout 后不会转 background", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const prompt =
      "E2E_BG39_SLEEP_HARD_TIMEOUT: Run a foreground Bash whose first raw token is sleep with a timeout shorter than its runtime.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      prompt,
      "E2E_BG39_SLEEP_HARD_TIMEOUT",
      "BG39 prompt 没有被 composer 接受",
    );
    await waitForToolCallBlockByToolCallId("toolu_e2e_bg39_sleep_timeout", 60000);
    await respondToBackgroundBlockers();

    const completionIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BG39_SLEEP_HARD_TIMEOUT",
          "<error>Command was aborted before completion</error>",
        ],
        excludes: ["Command running in background"],
      },
      requestCountBefore,
      "BG39 sleep Bash 没有返回 foreground timeout 结果",
    );
    await waitForV4AssistantMessageContaining("bg39-sleep-hard-timeout-ok");
    await browser.pause(500);
    expect(
      await countUpstreamRequests(
        {
          includes: [
            "<task-notification>",
            "<tool-use-id>toolu_e2e_bg39_sleep_timeout</tool-use-id>",
          ],
        },
        { afterIndex: completionIndex },
      ),
    ).toBe(0);
    await waitForNoBackgroundTaskControlRow(
      "bash",
      "BG39 sleep hard timeout",
      "BG39 sleep Bash 不应生成 background control row",
    );
    await waitForIdle("BG39 foreground timeout 后会话没有回到 idle");
  });

  it("普通 foreground 长 Bash running 过程中仍显示底部 loading", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await rm(BG14_PREVIEW_RELEASE_FILE, { force: true });
    await startNewBackgroundDraft();
    const prompt =
      "E2E_FOREGROUND_LONG_BASH_LOADING: Run a normal foreground Bash command long enough to show loading, then report after completion.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      prompt,
      "E2E_FOREGROUND_LONG_BASH_LOADING",
      "foreground long Bash loading prompt 没有被 composer 接受",
    );
    await waitForToolCallBlockByToolCallId("toolu_e2e_foreground_long_bash_loading", 60000);
    await respondToBackgroundBlockers();
    await waitForMainLoading("普通 foreground 长 Bash running 时应显示底部 loading");

    try {
      const trigger = await $(
        '[data-testid="tool-summary-trigger-toolu_e2e_foreground_long_bash_loading"]',
      );
      if ((await trigger.getAttribute("aria-expanded")) === "true") await trigger.click();
      await browser.waitUntil(
        async () => !(await $('[data-testid^="bash-output-preview-"]').isExisting()),
        { timeout: 5000, timeoutMsg: "收起的 Bash 不应渲染运行输出" },
      );
      await trigger.click();
      await browser.waitUntil(
        async () => {
          const preview = await $('[data-testid="bash-output-preview-full"]');
          return (
            (await preview.isDisplayed()) && (await preview.getText()).includes("progress-line-30")
          );
        },
        { timeout: 10000, timeoutMsg: "Bash 展开预览未显示长文本" },
      );
      const full = await $('[data-testid="bash-output-preview-full"]');
      expect(await full.getText()).toContain("progress-line-30");
      expect(await full.getText()).toContain("progress-line-120");
      // 共享 renderer 保持预览换行，长输出不能使用单行截断样式。
      expect(
        await browser.execute(() => {
          const node = document.querySelector('[data-testid="bash-output-preview-full"]');
          return node instanceof HTMLElement && getComputedStyle(node).whiteSpace === "pre-wrap";
        }),
      ).toBe(true);
    } finally {
      await writeFile(BG14_PREVIEW_RELEASE_FILE, "release");
    }

    const completionIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_FOREGROUND_LONG_BASH_LOADING", "<persisted-output>"],
      },
      requestCountBefore,
      "foreground long Bash 完成后的 tool result 没有进入父模型请求",
    );

    expect(completionIndex).toBeGreaterThan(requestCountBefore);
    await waitForV4AssistantMessageContaining("foreground-long-bash-loading-completed-ok");
    await waitForIdle("foreground long Bash 完成后会话没有回到 idle");
    expect(await $('[data-testid="bash-output-preview-full"]').isExisting()).toBe(false);
    // turn 完成后工具进入已折叠的 assistant history；先按产品入口重新展开历史，再展开工具卡。
    await expandToolCallDetails("toolu_e2e_foreground_long_bash_loading");
    // 历史展开动画会先挂载节点再显示正文，等待实际输出，前台不再展示文件入口。
    const result = await $('[data-testid="bash-result-output"]');
    await browser.waitUntil(
      async () =>
        (await result.isDisplayed()) && (await result.getText()).includes("progress-line-1"),
      { timeout: 10000, timeoutMsg: "Bash 终态头部正文未显示" },
    );
    expect(await $('[data-testid="bash-output-notice"]').isExisting()).toBe(false);
    expect(await $('[data-testid="bash-output-file"]').isExisting()).toBe(false);
    expect(await result.getText()).not.toContain("E2E_FOREGROUND_LONG_BASH_DONE");
    expect(await result.getText()).not.toContain("<persisted-output>");
    // provider 保持原有小摘要和完整文件契约，Desktop 仅显示 Bash 的头部正文。
    const modelResult = await getLatestUpstreamToolResultByToolCallId(
      "toolu_e2e_foreground_long_bash_loading",
    );
    expect(modelResult?.content).toContain("<persisted-output>");
    expect(modelResult?.content).not.toContain("E2E_FOREGROUND_LONG_BASH_DONE");
    const outputPath = modelResult?.content.match(/Full output saved to: ([^\n]+)/)?.[1];
    if (!outputPath) throw new Error("Bash provider result is missing the retained output path");
    const output = await readFile(outputPath, "utf8");
    expect(Buffer.byteLength(output)).toBeGreaterThan(30000);
    expect(output).toContain("E2E_FOREGROUND_LONG_BASH_DONE");
  });

  it("background Bash 可以从统一 background control UI 停止", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const prompt =
      "E2E_BACKGROUND_CANCEL_BASH: Start a long background Bash command, wait for it to be stopped, then report the stop notification.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      prompt,
      "E2E_BACKGROUND_CANCEL_BASH",
      "background Bash cancel prompt 没有被 composer 接受",
    );
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_cancel_bash", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_CANCEL_BASH", "Command running in background"],
      },
      requestCountBefore,
      "background Bash cancel launch tool result 没有进入父模型请求",
    );
    await openV4ComposerRunningBackgroundWorks();
    await waitForBackgroundTaskControlRow(
      "bash",
      "background cancel bash process tree",
      "background Bash 没有出现在统一 background control UI",
    );

    const [launcherPid, workerPid] = await Promise.all([
      waitForRunningPidFile(BG08_LAUNCHER_PID_FILE, "BG08 launcher"),
      waitForRunningPidFile(BG08_WORKER_PID_FILE, "BG08 worker"),
    ]);
    let rootPid: number | null = null;
    if (process.platform !== "win32") {
      rootPid = await waitForRunningPidFile(BG08_ROOT_PID_FILE, "BG08 root Bash");
      const [rootProcessGroupId, launcherProcessGroupId, workerProcessGroupId] = await Promise.all([
        readPosixProcessGroupId(rootPid),
        readPosixProcessGroupId(launcherPid),
        readPosixProcessGroupId(workerPid),
      ]);
      // Bug 根因：Bash job control 会把 launcher/worker 放入根 shell 之外的 PGID；
      // 这里只验证真实构造成功，避免普通同组进程让杀树回归得到假阳性。
      expect(launcherProcessGroupId).not.toBe(rootProcessGroupId);
      expect(workerProcessGroupId).toBe(launcherProcessGroupId);
    }

    await clickStopBackgroundTaskControlRow("bash", "background cancel bash process tree");

    await waitForV4AssistantMessageContaining("background-cancel-bash-launched-ok");
    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_CANCEL_BASH",
          "<task-notification>",
          "<tool-use-id>toolu_e2e_background_cancel_bash</tool-use-id>",
          "<status>killed</status>",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      launchIndex,
      "background Bash stop notification 没有进入父模型请求",
    );

    expect(notificationIndex).toBeGreaterThan(launchIndex);
    await waitForV4AssistantMessageContaining("background-cancel-bash-stopped-ok");
    await waitForNoBackgroundTaskControlRow(
      "bash",
      "background cancel bash process tree",
      "被停止的 background Bash 仍显示为 running",
    );
    await Promise.all([
      rootPid === null ? Promise.resolve() : waitForProcessExit(rootPid, "BG08 root Bash"),
      waitForProcessExit(launcherPid, "BG08 launcher"),
      waitForProcessExit(workerPid, "BG08 worker"),
    ]);
    await waitForIdle("background Bash stop notification 后会话没有回到 idle");
    await assertNoVisibleTaskNotification();
  });

  it("background Agent 可以从统一 background control UI 停止", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const prompt =
      "E2E_BACKGROUND_CANCEL_AGENT: Start a long background Agent and stop it from the background control UI.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      prompt,
      "E2E_BACKGROUND_CANCEL_AGENT",
      "background Agent cancel prompt 没有被 composer 接受",
    );
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_cancel_agent", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_CANCEL_AGENT", "Async agent launched successfully"],
      },
      requestCountBefore,
      "background Agent cancel launch tool result 没有进入父模型请求",
    );
    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E background cancel agent",
      "background Agent 没有出现在统一 background control UI",
    );

    await clickStopBackgroundTaskControlRow("agent", "E2E background cancel agent");

    await waitForV4AssistantMessageContaining("background-cancel-agent-launched-ok");
    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_CANCEL_AGENT",
          "<task-notification>",
          "<tool-use-id>toolu_e2e_background_cancel_agent</tool-use-id>",
          // 停止状态词是 killed，summary 写明是用户停止的。
          "<status>killed</status>",
          "was stopped by user</summary>",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      launchIndex,
      "background Agent stop notification 没有进入父模型请求",
    );

    expect(notificationIndex).toBeGreaterThan(launchIndex);
    await waitForV4AssistantMessageContaining("background-cancel-agent-stopped-ok");
    await waitForNoBackgroundTaskControlRow(
      "agent",
      "E2E background cancel agent",
      "被停止的 background Agent 仍显示为 running",
    );
    await waitForIdle("background Agent stop notification 后会话没有回到 idle");
    await assertNoVisibleTaskNotification();
  });

  it("TaskStop tool 停止 background Agent 时复用同一 notification 链路", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const prompt =
      "E2E_BACKGROUND_TASKSTOP_AGENT: Start a background Agent, then use TaskStop on its task id and report after the stop notification.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      prompt,
      "E2E_BACKGROUND_TASKSTOP_AGENT",
      "TaskStop background Agent prompt 没有被 composer 接受",
    );
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_taskstop_agent", 60000);
    await respondToBackgroundBlockers();

    const taskStopIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_TASKSTOP_AGENT",
          "Async agent launched successfully",
          "agentId: agent_",
          "TaskStop",
        ],
      },
      requestCountBefore,
      "background Agent launch 后父模型没有调用 TaskStop",
    );
    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_TASKSTOP_AGENT",
          "Successfully stopped task:",
          "<task-notification>",
          "<tool-use-id>toolu_e2e_background_taskstop_agent</tool-use-id>",
          // 模型用 TaskStop 停止：summary 写明是 ZCode 停止的。
          "<status>killed</status>",
          "was stopped by ZCode</summary>",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      taskStopIndex,
      "TaskStop 后 background Agent stop notification 没有进入父模型请求",
    );

    expect(notificationIndex).toBeGreaterThan(taskStopIndex);
    await waitForV4AssistantMessageContaining("background-taskstop-agent-stopped-ok");
    await waitForIdle("TaskStop background Agent notification 后会话没有回到 idle");
    await assertNoVisibleTaskNotification();
  });

  it("background notification 会在 active tool-loop 下一轮模型请求前合流", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const prompt =
      "E2E_BACKGROUND_ACTIVE_LOOP_BASH: Start a quick background Bash and keep the tool loop active until it can report completion.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      prompt,
      "E2E_BACKGROUND_ACTIVE_LOOP_BASH",
      "active-loop background Bash prompt 没有被 composer 接受",
    );
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_active_loop_bash_bg", 60000);
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_active_loop_bash_wait", 60000);
    await respondToBackgroundBlockers();
    await respondToBackgroundBlockers();

    const activeLoopIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_ACTIVE_LOOP_BASH",
          "E2E_BACKGROUND_ACTIVE_LOOP_WAIT_DONE",
          "<task-notification>",
          "<tool-use-id>toolu_e2e_background_active_loop_bash_bg</tool-use-id>",
          "<status>completed</status>",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      requestCountBefore,
      "active-loop 后续模型请求没有同时包含 Bash tool result 和 task-notification",
    );

    expect(activeLoopIndex).toBeGreaterThan(requestCountBefore);
    expect(
      await countUpstreamRequests(
        {
          includes: ["E2E_BACKGROUND_ACTIVE_LOOP_BASH", "toolu_e2e_background_active_loop_bash_bg"],
          lastUserMessageExcludes: ["<task-notification>"],
        },
        { afterIndex: requestCountBefore },
      ),
    ).toBe(0);
    expect(
      await countUpstreamRequests(
        {
          includes: [
            "<task-notification>",
            "<tool-use-id>toolu_e2e_background_active_loop_bash_bg</tool-use-id>",
          ],
          lastUserMessageIncludes: ["<task-notification>"],
        },
        { afterIndex: requestCountBefore },
      ),
    ).toBe(1);
    await waitForV4AssistantMessageContaining("background-active-loop-notification-consumed-ok");
    await waitForIdle("active-loop background notification 后会话没有回到 idle");
    await assertNoVisibleTaskNotification();
  });

  it("goal verifier 会等 background notification 被消费后再验证", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const goal =
      '/goal E2E_BACKGROUND_GOAL: Finish only after consuming the background agent result and then reply with "upstream-e2e-ok".';
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4Prompt(goal);
    await waitForV4ComposerText("", "background goal /goal 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_GOAL");
    await waitForToolCallBlockByToolName("Agent", 60000);
    await respondToBackgroundBlockers();

    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: ["<task-notification>", "E2E_BACKGROUND_GOAL_CHILD_RESULT"],
      },
      requestCountBefore,
      "goal background Agent completion notification 没有进入父模型请求",
    );
    await waitForV4AssistantMessageContaining("E2E_BACKGROUND_GOAL_NOTIFICATION_CONSUMED");
    const verifierIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_GOAL", "Verify whether the active session goal"],
      },
      notificationIndex,
      "background notification 后没有触发 goal verifier",
    );

    expect(verifierIndex).toBeGreaterThan(notificationIndex);
    expect(
      await countUpstreamRequests(
        {
          includes: ["E2E_BACKGROUND_GOAL", "Verify whether the active session goal"],
        },
        { beforeIndex: notificationIndex },
      ),
    ).toBe(0);
    await waitForV4ConversationState(
      // Bug 根因：旧聊天根节点把已验证目标投影为 complete，V4 状态面板使用
      // verified 表达同一终态；转正用例必须兼容两套展示契约。
      (snapshot) => snapshot.targetStatus === "complete" || snapshot.targetStatus === "verified",
      "background goal verifier 没有把 target 标记为 complete/verified",
      90000,
    );
    await assertNoVisibleTaskNotification();
  });

  it("running background Agent 可以通过 SendMessage 收到 steer 消息", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const prompt =
      "E2E_BACKGROUND_SEND_MESSAGE: Launch a background agent, then send it a coordinator message while it is still running.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "background SendMessage prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_SEND_MESSAGE");
    await waitForToolCallBlockByToolName("Agent", 60000);
    await respondToBackgroundBlockers();

    // child prompt 不写出 payload：child 只收到 message，payload 在 child 请求里只能出现一次。
    const sendMessageIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_SEND_MESSAGE",
          "Async agent launched successfully",
          "agentId: agent_",
        ],
        excludes: ["sent to its active turn"],
      },
      requestCountBefore,
      "background Agent launch 后父模型没有调用 SendMessage",
    );
    const sendMessageResultIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_SEND_MESSAGE",
          "E2E_BACKGROUND_SEND_MESSAGE_PAYLOAD",
          "sent to its active turn",
        ],
      },
      sendMessageIndex,
      "background Agent SendMessage tool result 没有进入父模型请求",
    );
    const coordinatorQuery = {
      includes: ["E2E_BACKGROUND_SEND_MESSAGE_CHILD_BASH_DONE"],
      lastUserMessageIncludes: [
        "The coordinator sent a message while you were working:",
        "E2E_BACKGROUND_SEND_MESSAGE_PAYLOAD",
      ],
    };
    // 验收真实 wire；旧 debug 文件同时检查请求和响应且依赖 retention，不是稳定的 provider 合同。
    await waitForFirstRequestIndex(
      coordinatorQuery,
      requestCountBefore - 1,
      "running child 没有收到 coordinator 提示",
    );
    const coordinatorEvidence = await getUpstreamRequestEvidence(coordinatorQuery, {
      afterIndex: requestCountBefore - 1,
    });
    await assertIncomingMessage(coordinatorEvidence[0]!.requestJson, {
      presentation: "coordinator_steer",
      marker: "E2E_BACKGROUND_SEND_MESSAGE_PAYLOAD",
      role: "user",
      // summary 只用于 UI 预览，child 只收到 message。
      body: "E2E_BACKGROUND_SEND_MESSAGE_PAYLOAD",
    });
    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: ["<task-notification>", "E2E_BACKGROUND_SEND_MESSAGE_CHILD_RECEIVED"],
      },
      sendMessageResultIndex,
      "SendMessage 后 background Agent completion notification 没有进入父模型请求",
    );

    expect(sendMessageIndex).toBeGreaterThan(requestCountBefore);
    expect(sendMessageResultIndex).toBeGreaterThan(sendMessageIndex);
    expect(notificationIndex).toBeGreaterThan(sendMessageResultIndex);
    await waitForIdle("background SendMessage notification 后会话没有回到 idle");
    await assertNoVisibleTaskNotification();
  });

  it("foreground subagent 运行 child tool 时 main 仍会显示底部 loading", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const capture = await beginBackgroundTelemetryCapture();
    const prompt =
      "E2E_FOREGROUND_AGENT_CHILD_TOOL_STREAMING_STATUS: Launch a foreground agent that runs a visible child Bash tool while the parent conversation is still running.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "foreground child tool streaming prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_FOREGROUND_AGENT_CHILD_TOOL_STREAMING_STATUS");
    await waitForToolCallBlockByToolCallId("toolu_e2e_foreground_child_tool_agent", 60000);
    await respondToBackgroundBlockers();

    // Bug 根因：V4 明确把 child tool history 留在 child conversation topic，
    // 父 timeline 只保留 Agent 事实；main loading 应由前台父 Agent 生命周期维持。
    await waitForMainLoading("foreground subagent 运行 child tool 时应保持 main 底部 loading");
    await assertNoMainToolCallById(
      "toolu_e2e_foreground_child_tool_bash",
      "foreground child Bash 不应被镜像成 main timeline tool row",
    );

    const completionIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_FOREGROUND_AGENT_CHILD_TOOL_STREAMING_STATUS",
          "E2E_FOREGROUND_AGENT_CHILD_TOOL_DONE",
        ],
      },
      requestCountBefore,
      "foreground child tool Agent completion 没有进入父模型请求",
    );

    expect(completionIndex).toBeGreaterThan(requestCountBefore);
    await waitForV4AssistantMessageContaining("foreground-agent-child-tool-streaming-completed-ok");
    await waitForIdle("foreground child tool Agent completion 后会话没有回到 idle");
    const reports = await waitForConversationReportDelta(capture, {
      agent_step: 1,
      message_completion: 1,
    });
    assertMainCompletionAgentCompositions(reports, ["main_plus_fg"]);
    assertMainCompletionMessageSources(reports, ["chat"]);
  });

  it("同一 main turn 同时消费 foreground 和 background subagent 结果", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    await rm(BACKGROUND_MIXED_FOREGROUND_RELEASE_FILE, { force: true });
    const capture = await beginBackgroundTelemetryCapture();
    const prompt =
      "E2E_AGENT_COMPOSITION_MIXED: Launch one foreground Agent and one background Agent, then summarize both results.";
    const requestCountBefore = await getUpstreamRequestRecordCount();

    try {
      await sendV4Prompt(prompt);
      await waitForV4ComposerText("", "mixed agent composition prompt 发送后输入框没有清空");
      await waitForV4UserMessageContaining("E2E_AGENT_COMPOSITION_MIXED");
      await waitForToolCallBlockByToolCallId("toolu_e2e_composition_mixed_foreground", 60000);
      await waitForToolCallBlockByToolCallId("toolu_e2e_composition_mixed_background", 60000);
      await browser.waitUntil(
        async () => {
          const evidence = await getUpstreamRequestEvidence(
            {
              lastUserMessageIncludes: ["E2E_AGENT_COMPOSITION_MIXED_FOREGROUND_CHILD"],
            },
            { afterIndex: requestCountBefore },
          );
          return evidence.some(
            (record) =>
              record.fixtureId === "upstream-agent-composition-mixed-foreground-child" &&
              record.status === "complete",
          );
        },
        {
          timeout: 45000,
          timeoutMsg: "mixed agent composition foreground child 没有进入 Bash barrier",
        },
      );
      await respondToBackgroundBlockers();

      await browser.waitUntil(
        async () => {
          const evidence = await getUpstreamRequestEvidence(
            {
              lastUserMessageIncludes: ["E2E_AGENT_COMPOSITION_MIXED_BACKGROUND_CHILD"],
            },
            { afterIndex: requestCountBefore },
          );
          return evidence.some(
            (record) =>
              record.fixtureId === "upstream-agent-composition-mixed-background-child" &&
              record.status === "complete",
          );
        },
        {
          timeout: 45000,
          timeoutMsg: "mixed agent composition background child 没有完成 provider response",
        },
      );
      await writeFile(BACKGROUND_MIXED_FOREGROUND_RELEASE_FILE, "release\n", "utf-8");

      const mixedRequestIndex = await waitForFirstRequestIndex(
        {
          includes: [
            "E2E_AGENT_COMPOSITION_MIXED_FOREGROUND_DONE",
            "E2E_AGENT_COMPOSITION_MIXED_BACKGROUND_DONE",
            "<task-notification>",
          ],
          lastUserMessageIncludes: [
            "<task-notification>",
            "E2E_AGENT_COMPOSITION_MIXED_FOREGROUND_DONE",
          ],
        },
        requestCountBefore,
        "mixed agent composition 没有在同一 main request 消费 foreground 和 background 结果",
      );
      expect(mixedRequestIndex).toBeGreaterThan(requestCountBefore);

      await waitForV4AssistantMessageContaining("agent-composition-mixed-completed-ok");
      await waitForIdle("mixed agent composition 收口后会话没有回到 idle");
      const reports = await waitForConversationReportDelta(capture, {
        agent_step: 1,
        message_completion: 1,
      });
      assertMainCompletionAgentCompositions(reports, ["main_plus_fg_bg"]);
      assertMainCompletionMessageSources(reports, ["chat"]);
    } finally {
      await writeFile(BACKGROUND_MIXED_FOREGROUND_RELEASE_FILE, "release\n", "utf-8").catch(
        () => undefined,
      );
    }
  });

  it("background subagent 的 child tool 只留在 child conversation，idle main 不显示底部 loading", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const capture = await beginBackgroundTelemetryCapture();
    await rm(BACKGROUND_CHILD_TOOL_IDLE_RELEASE_FILE, { force: true });
    const prompt =
      "E2E_BACKGROUND_AGENT_CHILD_TOOL_IDLE_STATUS: Launch a background agent that runs a visible child Bash tool while the parent conversation is idle.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "background child tool idle prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_AGENT_CHILD_TOOL_IDLE_STATUS");
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_idle_child_tool_agent", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_AGENT_CHILD_TOOL_IDLE_STATUS",
          "Async agent launched successfully",
        ],
      },
      requestCountBefore,
      "background child tool idle Agent launch tool result 没有进入父模型请求",
    );
    await waitForV4AssistantMessageContaining("background-agent-child-tool-idle-launched-ok");
    await waitForIdle("background child tool idle launch 后父会话没有先回到 idle");
    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E background child tool idle",
      "background child tool idle Agent 没有出现在统一 background control UI",
    );
    await assertNoMainToolCallById(
      "toolu_e2e_background_idle_child_tool_bash",
      "background child Bash 不应被镜像成 main timeline tool row",
    );
    await assertNoMainFakeLoading(
      "background subagent child tool update 不应让 idle main 显示底部 loading",
    );
    await writeFile(BACKGROUND_CHILD_TOOL_IDLE_RELEASE_FILE, "release\n", "utf-8");

    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: ["<task-notification>", "E2E_BACKGROUND_AGENT_CHILD_TOOL_IDLE_DONE"],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      launchIndex,
      "background child tool idle Agent completion notification 没有进入父模型请求",
    );

    expect(notificationIndex).toBeGreaterThan(launchIndex);
    await waitForV4AssistantMessageContaining(
      "background-agent-child-tool-idle-notification-consumed-ok",
    );
    await waitForIdle("background child tool idle notification 后会话没有回到 idle");
    const { eventReport: reports } = await checkpointConversationTelemetryCase(capture, {
      caseId: "BG13-token-identity",
      minimumReportInventory: { agent_step: 1, message_completion: 2 },
      minimumArmsInventory: {},
      proof: ["child Bash + Agent usage owner", "new UUID v7 wake message"],
    });
    assertBackgroundToolStepTelemetry(reports, "toolu_e2e_background_idle_child_tool_bash");
    assertMainCompletionAgentCompositions(reports, ["main_only", "main_plus_bg"]);
    assertMainCompletionMessageSources(reports, ["chat", "background_subagent"]);
    await assertNoVisibleTaskNotification();
  });

  it("background subagent 的 child tool 不污染后续主回复且原 Agent 控制身份稳定", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const capture = await beginBackgroundTelemetryCapture();
    const prompt =
      "E2E_BACKGROUND_CHILD_TOOL_PARENT_ANCHOR: Launch a background agent whose child tool update arrives after my next main prompt has completed.";
    const followUpPrompt =
      "E2E_BACKGROUND_CHILD_TOOL_PARENT_ANCHOR_FOLLOWUP: This main prompt should complete before the background child Bash update arrives.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await rm(BACKGROUND_PARENT_ANCHOR_RELEASE_FILE, { force: true });

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "background parent anchor prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_CHILD_TOOL_PARENT_ANCHOR");
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_parent_anchor_agent", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_CHILD_TOOL_PARENT_ANCHOR", "Async agent launched successfully"],
      },
      requestCountBefore,
      "background parent anchor Agent launch tool result 没有进入父模型请求",
    );
    await waitForV4AssistantMessageContaining("background-child-tool-parent-anchor-launched-ok");
    await waitForIdle("background parent anchor launch 后父会话没有先回到 idle");
    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E background child tool parent anchor",
      "background parent anchor Agent 没有出现在统一 background control UI",
    );

    await sendV4Prompt(followUpPrompt);
    await waitForV4ComposerText("", "background parent anchor follow-up 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_CHILD_TOOL_PARENT_ANCHOR_FOLLOWUP");
    const followUpIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_CHILD_TOOL_PARENT_ANCHOR_FOLLOWUP"],
        lastUserMessageIncludes: ["E2E_BACKGROUND_CHILD_TOOL_PARENT_ANCHOR_FOLLOWUP"],
      },
      launchIndex,
      "background parent anchor follow-up 没有立即进入 provider request",
    );
    expect(followUpIndex).toBeGreaterThan(launchIndex);
    await waitForV4AssistantMessageContaining(
      "background-child-tool-parent-anchor-main-followup-ok",
    );

    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E background child tool parent anchor",
      "background child tool 到达后原 Agent 控制身份没有保持",
    );
    await assertNoMainToolCallById(
      "toolu_e2e_background_parent_anchor_child_bash",
      "background child Bash 不应污染后续 main timeline",
    );
    await writeFile(BACKGROUND_PARENT_ANCHOR_RELEASE_FILE, "release\n", "utf-8");
    await respondToBackgroundBlockers();

    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: ["<task-notification>", "E2E_BACKGROUND_CHILD_TOOL_PARENT_ANCHOR_CHILD_DONE"],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      followUpIndex,
      "background parent anchor Agent completion notification 没有进入父模型请求",
    );

    expect(notificationIndex).toBeGreaterThan(followUpIndex);
    await waitForV4AssistantMessageContaining(
      "background-child-tool-parent-anchor-notification-consumed-ok",
    );
    await waitForIdle("background parent anchor notification 后会话没有回到 idle");
    const { eventReport: reports } = await checkpointConversationTelemetryCase(capture, {
      caseId: "BG18-token-identity",
      minimumReportInventory: { agent_step: 1, message_completion: 3 },
      minimumArmsInventory: {},
      proof: [
        "child usage retains original launch identity after follow-up",
        "new UUID v7 wake message",
      ],
    });
    assertBackgroundToolStepTelemetry(reports, "toolu_e2e_background_parent_anchor_child_bash");
    assertMainCompletionAgentCompositions(reports, ["main_only", "main_only", "main_plus_bg"]);
    assertMainCompletionMessageSources(reports, ["chat", "chat", "background_subagent"]);
    await assertNoVisibleTaskNotification();
  });

  it("切换 session 期间完成的 background subagent 切回后应保留父 Agent 描述并收口", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const prompt =
      "E2E_BACKGROUND_CHILD_TOOL_SESSION_SWITCH: Launch a background agent whose child Bash completes while I am viewing another session.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await rm(BG21_RELEASE_FILE, { force: true });

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "background session switch prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_CHILD_TOOL_SESSION_SWITCH");
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_session_switch_agent", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_CHILD_TOOL_SESSION_SWITCH", "Async agent launched successfully"],
      },
      requestCountBefore,
      "background session switch Agent launch tool result 没有进入父模型请求",
    );
    await waitForV4AssistantMessageContaining("background-session-switch-launched-ok");
    const sessionSwitchSnapshot = await waitForIdle(
      "background session switch launch 后父会话没有先回到 idle",
    );
    const sourceTaskId = sessionSwitchSnapshot.taskId;
    if (!sourceTaskId) {
      throw new Error(
        `background session switch 缺少 source taskId: ${JSON.stringify(sessionSwitchSnapshot)}`,
      );
    }

    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E background session switch child tool",
      "background session switch Agent 没有出现在统一 background control UI",
    );
    await assertNoMainToolCallById(
      "toolu_e2e_background_session_switch_child_bash",
      "background session switch child Bash 不应进入 main timeline",
    );

    await startNewBackgroundDraft();
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === null && snapshot.sessionId === null,
      "background session switch 没有切到新草稿 task",
      30000,
    );
    await writeFile(BG21_RELEASE_FILE, "release\n", "utf-8");

    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: ["<task-notification>", "E2E_BACKGROUND_CHILD_TOOL_SESSION_SWITCH_CHILD_DONE"],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      launchIndex,
      "background session switch Agent completion notification 没有进入父模型请求",
    );
    expect(notificationIndex).toBeGreaterThan(launchIndex);

    await selectV4TaskById(sourceTaskId);
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === sourceTaskId,
      "background session switch 切回原 task 后 chat root 没有恢复到原 task",
      30000,
    );
    await waitForV4AssistantMessageContaining("background-session-switch-notification-consumed-ok");
    await waitForIdle("background session switch notification 后会话没有回到 idle");
    await waitForNoBackgroundTaskControlRow(
      "agent",
      "E2E background session switch child tool",
      "background session switch 切回后父 Agent control 没有收口",
    );
    // Bug 根因：V4 终态 Agent 事实由 timeline/subagent row 承载，不再写回 legacy
    // renderer ToolCallBlock；切回后的收口应验证当前 V4 timeline 与 control 消失。
    await waitForV4TimelineContaining("E2E background session switch child tool", 60000);
    expect((await getV4PaneSnapshot()).timelineText).not.toContain("Unknown");
    await assertNoMainToolCallById(
      "toolu_e2e_background_session_switch_child_bash",
      "background session switch 切回后不应把 child Bash 复活成 main row",
    );
    await assertNoVisibleTaskNotification();
  });

  it("切回 session 时 background subagent 仍 running，后续应继续收口父 Agent 状态", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const prompt =
      "E2E_BACKGROUND_CHILD_TOOL_SWITCH_BACK_RUNNING: Launch a background agent whose child Bash is still running when I switch back.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await rm(BACKGROUND_SWITCH_BACK_RELEASE_FILE, { force: true });

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "background switch-back-running prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_CHILD_TOOL_SWITCH_BACK_RUNNING");
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_switch_back_running_agent", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_CHILD_TOOL_SWITCH_BACK_RUNNING",
          "Async agent launched successfully",
        ],
      },
      requestCountBefore,
      "background switch-back-running Agent launch tool result 没有进入父模型请求",
    );
    await waitForV4AssistantMessageContaining("background-switch-back-running-launched-ok");
    const sourceSnapshot = await waitForIdle(
      "background switch-back-running launch 后父会话没有先回到 idle",
    );
    const sourceTaskId = sourceSnapshot.taskId;
    if (!sourceTaskId) {
      throw new Error(
        `background switch-back-running 缺少 source taskId: ${JSON.stringify(sourceSnapshot)}`,
      );
    }

    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E background switch back running child tool",
      "background switch-back-running Agent 没有出现在统一 background control UI",
    );
    await assertNoMainToolCallById(
      "toolu_e2e_background_switch_back_running_child_bash",
      "background switch-back-running child Bash 不应进入 main timeline",
    );

    await startNewBackgroundDraft();
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === null && snapshot.sessionId === null,
      "background switch-back-running 没有切到新草稿 task",
      30000,
    );

    await selectV4TaskById(sourceTaskId);
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === sourceTaskId,
      "background switch-back-running 切回原 task 后 chat root 没有恢复到原 task",
      30000,
    );
    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E background switch back running child tool",
      "background switch-back-running 切回后父 Agent running control 没有恢复",
    );
    await assertNoMainToolCallById(
      "toolu_e2e_background_switch_back_running_child_bash",
      "background switch-back-running 切回后不应把 child Bash 投影到 main timeline",
    );
    await writeFile(BACKGROUND_SWITCH_BACK_RELEASE_FILE, "release\n", "utf-8");

    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "<task-notification>",
          "E2E_BACKGROUND_CHILD_TOOL_SWITCH_BACK_RUNNING_CHILD_DONE",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      launchIndex,
      "background switch-back-running Agent completion notification 没有进入父模型请求",
    );
    expect(notificationIndex).toBeGreaterThan(launchIndex);
    await waitForV4AssistantMessageContaining(
      "background-switch-back-running-notification-consumed-ok",
    );
    await waitForIdle("background switch-back-running notification 后会话没有回到 idle");
    await waitForNoBackgroundTaskControlRow(
      "agent",
      "E2E background switch back running child tool",
      "background switch-back-running 完成后父 Agent control 没有收口",
    );
    await waitForV4TimelineContaining("E2E background switch back running child tool", 60000);
    expect((await getV4PaneSnapshot()).timelineText).not.toContain("Unknown");
    await assertNoMainToolCallById(
      "toolu_e2e_background_switch_back_running_child_bash",
      "background switch-back-running 完成后不应把 child Bash 复活成 main row",
    );
    await assertNoVisibleTaskNotification();
  });

  it("background-only running 时点击 queued prompt 立即发送不应 stop background task", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const prompt =
      "E2E_BACKGROUND_SEND_NOW_QUEUE: Launch a background agent with a visible child Bash tool, then wait.";
    const queuedPrompt =
      "E2E_BACKGROUND_SEND_NOW_QUEUE_PAYLOAD: This queued prompt should send now without stopping the background agent.";
    const holdPrompt =
      'E2E_HOLD_STREAM E2E_BACKGROUND_SEND_NOW_QUEUE_HOLD: Reply with exactly "upstream-e2e-ok" and no other text.';
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "background send-now queue prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_SEND_NOW_QUEUE");
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_send_now_queue_agent", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_SEND_NOW_QUEUE", "Async agent launched successfully"],
      },
      requestCountBefore,
      "background send-now queue Agent launch tool result 没有进入父模型请求",
    );
    await waitForV4AssistantMessageContaining("background-send-now-queue-launched-ok");
    await waitForIdle("background send-now queue launch 后父会话没有先回到 idle");
    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E background send now queue",
      "background send-now queue Agent 没有保持 running control",
    );
    await assertNoMainToolCallById(
      "toolu_e2e_background_send_now_queue_child_bash",
      "background send-now queue child Bash 不应进入 main timeline",
    );
    await assertNoMainFakeLoading(
      "background send-now queue child tool update 不应让 idle main 显示底部 loading",
    );

    // Bug 根因：旧 case 直接调用已删除的 renderer store enqueue API，构造的是
    // 产品 UI 无法到达的状态。现在先启动可停止的主 turn、真实排队，再 stop 进入
    // idle + paused queue；background Agent 仍 running，随后从队列点击“立即”。
    await sendV4Prompt(holdPrompt);
    await waitForV4ComposerText("", "background send-now hold prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_SEND_NOW_QUEUE_HOLD");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "background send-now hold prompt 没有进入 streaming",
      30000,
    );
    await sendV4Prompt(queuedPrompt);
    await waitForV4ComposerText("", "background send-now queued prompt 没有清空");
    const queuedBeforeSendNow = await waitForQueueOrderContaining(
      ["E2E_BACKGROUND_SEND_NOW_QUEUE_PAYLOAD"],
      "background-only running send-now 点击前没有形成 queued prompt",
    );
    expect(queuedBeforeSendNow[0]?.kind).toBe("text");

    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.state !== "streaming" && !snapshot.stopRequested && snapshot.queueCount === 1,
      "background send-now stop 后没有进入 background-only + paused queue",
      30000,
    );
    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E background send now queue",
      "background send-now stop main turn 后误停了 background Agent",
    );

    const sentNowItem = await clickFirstQueueSendNow();
    expect(sentNowItem.content).toContain("E2E_BACKGROUND_SEND_NOW_QUEUE_PAYLOAD");
    await browser.pause(80);
    const afterClickSnapshot = await getV4ConversationState();
    expect(afterClickSnapshot.stopRequested).toBe(false);

    const queuedPromptIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_SEND_NOW_QUEUE_PAYLOAD"],
        lastUserMessageIncludes: ["E2E_BACKGROUND_SEND_NOW_QUEUE_PAYLOAD"],
      },
      launchIndex,
      "background-only running 下 queued prompt 点击立即发送后没有直接进入 provider request",
    );

    expect(queuedPromptIndex).toBeGreaterThan(launchIndex);
    await waitForV4AssistantMessageContaining("background-send-now-queue-received-ok");
    // Bug 根因：固定 sleep 窗口在 25 条全量回放负载下可能先于 UI 断言结束，
    // 让用例偶发看不到 running control。点击“立即”完成后再释放 child，才能
    // 确保测试窗口由交互事件决定，而不是依赖机器速度。
    await writeFile(BACKGROUND_SEND_NOW_QUEUE_RELEASE_FILE, "release\n", "utf-8");
    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: ["<task-notification>", "E2E_BACKGROUND_SEND_NOW_QUEUE_CHILD_DONE"],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      queuedPromptIndex,
      "background send-now queue Agent completion notification 没有进入父模型请求",
    );

    expect(notificationIndex).toBeGreaterThan(queuedPromptIndex);
    await waitForV4AssistantMessageContaining("background-send-now-queue-notification-consumed-ok");
    await waitForIdle("background send-now queue notification 后会话没有回到 idle");
    await assertNoVisibleTaskNotification();
  });

  it("main turn 启动 background task 后结束时会继续 drain 已有 queue，后续 queued prompt 不丢失", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const backgroundLaunchPrompt =
      "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END: Start a background agent, but let me queue follow-up messages while this main turn is still running.";
    const queuedPromptTwo =
      "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q2: Q2 should queue while the background launch turn is still active.";
    const queuedPromptThree =
      "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q3: Q3 should queue behind Q2 while the background launch turn is still active.";
    const queuedPromptFour =
      "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q4: Q4 should queue behind Q3 while the background launch turn is still active.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    // Bug 根因：capture 的 afterIndex 使用最后一个数组下标；启动前记录数直接传入
    // 会漏掉本轮恰好落在 index=requestCountBefore 的首条请求，导致后续 queue drain
    // 证明在真实请求已完成时仍被报告为未命中。
    const lastRequestIndexBefore = requestCountBefore - 1;

    await sendV4Prompt(backgroundLaunchPrompt);
    await waitForV4ComposerText("", "background queue drain launch prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END");
    const backgroundPromptIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END"],
        lastUserMessageIncludes: ["E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END"],
      },
      lastRequestIndexBefore,
      "background launch prompt 没有进入 provider request",
    );
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_queue_drain_agent", 60000);
    await respondToBackgroundBlockers();
    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E background queue drain agent",
      "background queue drain Agent 没有出现在统一 background control UI",
    );
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "background queue drain launch ack delay 期间 main 没有保持 running",
      30000,
    );

    await sendV4Prompt(queuedPromptTwo);
    await waitForV4ComposerText("", "background queue drain Q2 入队后输入框没有清空");
    await waitForQueueOrderContaining(
      ["E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q2"],
      "background Agent running 且 launch ack 未结束时 Q2 没有进入 queue",
    );

    await sendV4Prompt(queuedPromptThree);
    await waitForV4ComposerText("", "background queue drain Q3 入队后输入框没有清空");
    await waitForQueueOrderContaining(
      [
        "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q2",
        "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q3",
      ],
      "background Agent running 且 launch ack 未结束时 Q2/Q3 queue 顺序不正确",
    );

    await sendV4Prompt(queuedPromptFour);
    await waitForV4ComposerText("", "background queue drain Q4 入队后输入框没有清空");
    await waitForQueueOrderContaining(
      [
        "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q2",
        "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q3",
        "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q4",
      ],
      "background Agent running 且 launch ack 未结束时 Q2/Q3/Q4 queue 顺序不正确",
    );

    await startVisibleUserMessageSampler();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END",
          "Async agent launched successfully",
        ],
      },
      backgroundPromptIndex,
      "background queue drain Agent launch tool result 没有进入父模型请求",
    );
    expect(launchIndex).toBeGreaterThan(backgroundPromptIndex);
    await waitForV4AssistantMessageContaining("background-queue-drain-launched-ok");

    const secondQueuedIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q2"],
        lastUserMessageIncludes: ["E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q2"],
      },
      launchIndex,
      "background prompt 完成后 Q2 没有继续 drain",
    );
    expect(secondQueuedIndex).toBeGreaterThan(launchIndex);
    await waitForVisibleUserMessagesContainingAll(
      ["E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q2"],
      "Q2 drain 后应渲染为可见 user message",
    );
    await waitForQueueOrderContaining(
      [
        "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q3",
        "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q4",
      ],
      "Q2 drain 期间 Q3/Q4 应仍留在 queue 中",
    );
    expect(
      await countUpstreamRequests(
        {
          includes: ["E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q4"],
          lastUserMessageIncludes: ["E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q4"],
        },
        { afterIndex: secondQueuedIndex },
      ),
    ).toBe(0);

    await waitForV4AssistantMessageContaining("background-queue-drain-first-ok");

    const thirdQueuedIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q3"],
        lastUserMessageIncludes: ["E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q3"],
      },
      secondQueuedIndex,
      "Q2 完成后 Q3 没有继续 drain",
    );
    expect(thirdQueuedIndex).toBeGreaterThan(secondQueuedIndex);
    await waitForVisibleUserMessagesContainingAll(
      [
        "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q2",
        "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q3",
      ],
      "Q3 drain 后 Q2/Q3 应同时保留在可见 user messages 中",
    );
    await waitForQueueOrderContaining(
      ["E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q4"],
      "Q3 drain 期间 Q4 应仍留在 queue 中",
    );
    expect(
      await countUpstreamRequests(
        {
          includes: ["E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q4"],
          lastUserMessageIncludes: ["E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q4"],
        },
        { afterIndex: thirdQueuedIndex },
      ),
    ).toBe(0);

    await waitForV4AssistantMessageContaining("background-queue-drain-second-ok");

    const fourthQueuedIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q4"],
        lastUserMessageIncludes: ["E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q4"],
      },
      thirdQueuedIndex,
      "Q3 完成后 Q4 没有继续 drain",
    );
    expect(fourthQueuedIndex).toBeGreaterThan(thirdQueuedIndex);
    await waitForVisibleUserMessagesContainingAll(
      [
        "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q2",
        "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q3",
        "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q4",
      ],
      "Q4 drain 后 Q2/Q3/Q4 应同时保留在可见 user messages 中",
    );
    assertVisibleUserMessageMarkersNeverDisappear(await stopVisibleUserMessageSampler(), [
      "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q2",
      "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q3",
      "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_Q4",
    ]);
    await waitForV4AssistantMessageContaining("background-queue-drain-third-ok");
    // 失败原因：child 回复原来是固定 30s 延迟，赌主线 launch ack/Q2/Q3/Q4 先跑完；慢机器上
    // Q3→Q4 的 drain 间隔（session snapshot 慢 3.8s）让 child 先完成，notification 排到 Q4 之前。
    // 改为受控流：Q4 回复完成后才放行 child，notification 必然在 Q4 之后，断言不再依赖时钟。
    await releaseControlledReplay("upstream-background-queue-drain-child-delayed-result");

    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: ["<task-notification>", "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_CHILD_DONE"],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      fourthQueuedIndex,
      "background queue drain Agent completion notification 没有进入父模型请求",
    );
    expect(notificationIndex).toBeGreaterThan(fourthQueuedIndex);
    await waitForV4AssistantMessageContaining("background-queue-drain-notification-consumed-ok");
    await waitForIdle("background queue drain notification 后会话没有回到 idle");
    await assertNoVisibleTaskNotification();
  });

  it("background subagent 内部 background Bash 完成后只做 child cleanup", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const prompt =
      "E2E_BACKGROUND_NESTED_BASH: Launch a background agent that starts a background Bash command and then finishes.";
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "nested background Bash prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_NESTED_BASH");
    await waitForToolCallBlockByToolName("Agent", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: ["E2E_BACKGROUND_NESTED_BASH", "Async agent launched successfully"],
      },
      requestCountBefore,
      "nested background Agent launch tool result 没有进入父模型请求",
    );
    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: ["<task-notification>", "E2E_BACKGROUND_NESTED_BASH_CHILD_DONE"],
      },
      launchIndex,
      "nested background Agent completion notification 没有进入父模型请求",
    );

    expect(notificationIndex).toBeGreaterThan(launchIndex);
    await waitForV4AssistantMessageContaining("background-nested-bash-notification-consumed-ok");
    await waitForIdle("nested background Agent notification 后会话没有回到 idle");
    await browser.pause(2500);
    // Bug 根因：TaskOutput 的工具 description 本身包含 `<task-notification>`；旧断言扫描
    // 整条 model-io JSONL，会把正常 child 首次请求里的工具 schema 与 Bash tool call ID
    // 拼成一次伪 wake。这里改查 provider 实际请求，并把通知限定在 latest user message；
    // 唯一 Bash tool call ID 与时间边界仍保留，真实的 sealed-child wake 仍会被准确捕获。
    const unexpectedChildWakeCount = await countUpstreamRequests(
      {
        includes: ["toolu_e2e_background_nested_child_bash"],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      { afterIndex: launchIndex },
    );
    if (unexpectedChildWakeCount > 0) {
      throw new Error(
        "sealed child runtime 不应被 nested background Bash completion 重新唤起; " +
          `count=${unexpectedChildWakeCount}`,
      );
    }
    expect(unexpectedChildWakeCount).toBe(0);
    expect(
      await countUpstreamRequests(
        {
          includes: ["<task-notification>", "E2E_BACKGROUND_NESTED_BASH_CHILD_DONE"],
          lastUserMessageIncludes: ["<task-notification>"],
        },
        { afterIndex: requestCountBefore },
      ),
    ).toBe(1);
    await assertNoVisibleTaskNotification();
  });

  it("partial runtime snapshot 不应清掉缺失的 running background control row", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4Prompt(
      "E2E_BACKGROUND_SNAPSHOT_CONTROL: Start two background Bash tasks. One should finish first while the other keeps running.",
    );
    await waitForV4ComposerText("", "BG23 prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_SNAPSHOT_CONTROL");
    await waitForToolCallBlockByToolCallId("toolu_e2e_bg23_bash_one", 60000);
    await waitForToolCallBlockByToolCallId("toolu_e2e_bg23_bash_two", 60000);
    await respondToBackgroundBlockers();
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_SNAPSHOT_CONTROL",
          "toolu_e2e_bg23_bash_one",
          "toolu_e2e_bg23_bash_two",
          "Command running in background",
        ],
      },
      requestCountBefore,
      "BG23 两个 background Bash launch result 没有进入父模型请求",
    );
    await waitForV4AssistantMessageContaining("background-snapshot-control-ready-ok");
    await waitForIdle("BG23 setup prompt 后会话没有回到 idle");
    await waitForBackgroundTaskControlRow(
      "bash",
      "E2E BG23 bash one",
      "BG23 初始第一个 Bash background control row 没有显示在右上角面板",
    );
    await waitForBackgroundTaskControlRow(
      "bash",
      "E2E BG23 bash two",
      "BG23 初始第二个 Bash background control row 没有显示在右上角面板",
    );

    const firstNotificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_SNAPSHOT_CONTROL",
          "<task-notification>",
          "<tool-use-id>toolu_e2e_bg23_bash_one</tool-use-id>",
          "<status>completed</status>",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      launchIndex,
      "BG23 第一个 background Bash completion notification 没有进入父模型请求",
    );
    expect(firstNotificationIndex).toBeGreaterThan(launchIndex);
    await waitForV4AssistantMessageContaining("background-snapshot-control-first-notification-ok");
    await waitForIdle("BG23 第一个 background Bash notification 后会话没有回到 idle");
    await waitForNoBackgroundTaskControlRow(
      "bash",
      "E2E BG23 bash one",
      "BG23 第一个 terminal Bash row 没有从右上角面板消失",
    );
    await waitForBackgroundTaskControlRow(
      "bash",
      "E2E BG23 bash two",
      "BG23 第一个 Bash 完成后第二个 running Bash row 被错误清掉",
    );

    await clickStopBackgroundTaskControlRow("bash", "E2E BG23 bash two");
    const stopNotificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_SNAPSHOT_CONTROL",
          "<task-notification>",
          "<tool-use-id>toolu_e2e_bg23_bash_two</tool-use-id>",
          "<status>killed</status>",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      firstNotificationIndex,
      "BG23 第二个 background Bash stop notification 没有进入父模型请求",
    );
    expect(stopNotificationIndex).toBeGreaterThan(firstNotificationIndex);
    await waitForV4AssistantMessageContaining("background-snapshot-control-second-stopped-ok");
    await waitForIdle("BG23 第二个 background Bash stop notification 后会话没有回到 idle");
    await waitForNoBackgroundTaskControlRow(
      "bash",
      "E2E BG23 bash two",
      "BG23 第二个 Bash stop 后 row 没有从右上角面板消失",
    );
  });

  it("background Agent notification 处理中不应清掉仍 running 的其它 Agent control row", async function () {
    this.timeout(BACKGROUND_E2E_TIMEOUT_MS);

    await startNewBackgroundDraft();
    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4Prompt(
      "E2E_BACKGROUND_AGENT_CONTROL_PRESERVE: Start one long-running background agent and three short-lived background agents. The three short-lived agents should finish before the long-running agent.",
    );
    await waitForV4ComposerText("", "BG24 prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_BACKGROUND_AGENT_CONTROL_PRESERVE");
    await waitForToolCallBlockByToolCallId("toolu_e2e_bg24_long_running_agent", 60000);
    await waitForToolCallBlockByToolCallId("toolu_e2e_bg24_short_lived_one_agent", 60000);
    await waitForToolCallBlockByToolCallId("toolu_e2e_bg24_short_lived_two_agent", 60000);
    await waitForToolCallBlockByToolCallId("toolu_e2e_bg24_short_lived_three_agent", 60000);
    await respondToBackgroundBlockers();

    const launchIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_AGENT_CONTROL_PRESERVE",
          "toolu_e2e_bg24_long_running_agent",
          "toolu_e2e_bg24_short_lived_one_agent",
          "toolu_e2e_bg24_short_lived_two_agent",
          "toolu_e2e_bg24_short_lived_three_agent",
          "Async agent launched successfully",
        ],
      },
      requestCountBefore,
      "BG24 四个 background Agent launch result 没有进入父模型请求",
    );
    await waitForV4AssistantMessageContaining("background-agent-control-preserve-ready-ok");
    const sourceSnapshot = await waitForIdle("BG24 setup prompt 后会话没有回到 idle");
    const sourceTaskId = sourceSnapshot.taskId;
    if (!sourceTaskId) {
      throw new Error(`BG24 setup 后缺少 source taskId: ${JSON.stringify(sourceSnapshot)}`);
    }
    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E BG24 long-running keepalive agent",
      "BG24 初始 long-running Agent background control row 没有显示在右上角面板",
    );
    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E BG24 short-lived three agent",
      "BG24 初始第三个 short-lived Agent background control row 没有显示在右上角面板",
    );

    const firstShortLivedNotificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_AGENT_CONTROL_PRESERVE",
          "<task-notification>",
          "<tool-use-id>toolu_e2e_bg24_short_lived_one_agent</tool-use-id>",
          "<status>completed</status>",
          "E2E_BG24_SHORT_LIVED_ONE_CHILD_DONE",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      launchIndex,
      "BG24 第一个 short-lived background Agent completion notification 没有进入父模型请求",
    );
    expect(firstShortLivedNotificationIndex).toBeGreaterThan(launchIndex);
    await waitForV4AssistantMessageContaining(
      "background-agent-control-preserve-short-lived-one-notification-ok",
    );
    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E BG24 long-running keepalive agent",
      "BG24 第一个 short-lived Agent 完成后 long-running running Agent row 被错误清掉",
    );
    await startBackgroundTaskControlPresenceProbe(
      "agent",
      "E2E BG24 long-running keepalive agent",
      sourceTaskId,
    );
    const secondShortLivedNotificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_AGENT_CONTROL_PRESERVE",
          "<task-notification>",
          "<tool-use-id>toolu_e2e_bg24_short_lived_two_agent</tool-use-id>",
          "<status>completed</status>",
          "E2E_BG24_SHORT_LIVED_TWO_CHILD_DONE",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      firstShortLivedNotificationIndex,
      "BG24 第二个 short-lived background Agent completion notification 没有进入父模型请求",
    );
    expect(secondShortLivedNotificationIndex).toBeGreaterThan(firstShortLivedNotificationIndex);

    await startNewBackgroundDraft();
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === null && snapshot.sessionId === null,
      "BG24 第二个 notification 处理中没有切到新草稿 task",
      30000,
    );
    await selectV4TaskById(sourceTaskId);
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === sourceTaskId,
      "BG24 第二个 notification 处理中切回原 task 后 chat root 没有恢复",
      30000,
    );
    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E BG24 long-running keepalive agent",
      "BG24 第二个 notification 处理中切回原 task 后 long-running running Agent row 没有恢复",
    );
    await waitForV4AssistantMessageContaining(
      "background-agent-control-preserve-short-lived-two-notification-ok",
    );
    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E BG24 long-running keepalive agent",
      "BG24 第二个 short-lived Agent 完成后 long-running running Agent row 被错误清掉",
    );

    const thirdShortLivedNotificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_AGENT_CONTROL_PRESERVE",
          "<task-notification>",
          "<tool-use-id>toolu_e2e_bg24_short_lived_three_agent</tool-use-id>",
          "<status>completed</status>",
          "E2E_BG24_SHORT_LIVED_THREE_CHILD_DONE",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      secondShortLivedNotificationIndex,
      "BG24 第三个 short-lived background Agent completion notification 没有进入父模型请求",
    );
    expect(thirdShortLivedNotificationIndex).toBeGreaterThan(secondShortLivedNotificationIndex);
    const afterTodoIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_AGENT_CONTROL_PRESERVE",
          "toolu_e2e_bg24_todo_write",
          "E2E_BG24_TODO_UPDATED",
        ],
      },
      thirdShortLivedNotificationIndex,
      "BG24 short-lived notification 中的 TodoWrite tool result 没有进入后续父模型请求",
    );
    expect(afterTodoIndex).toBeGreaterThan(thirdShortLivedNotificationIndex);
    await waitForV4AssistantMessageContaining(
      "background-agent-control-preserve-short-lived-notification-ok",
    );
    await waitForIdle("BG24 short-lived Agent notification 后会话没有回到 idle");
    const presenceProbe = await stopBackgroundTaskControlPresenceProbe();
    expect(presenceProbe.observedPresent).toBe(true);
    expect(presenceProbe.missingTransitions).toEqual([]);
    await waitForNoBackgroundTaskControlRow(
      "agent",
      "E2E BG24 short-lived three agent",
      "BG24 已完成的第三个 short-lived Agent row 没有从右上角面板消失",
    );
    await waitForBackgroundTaskControlRow(
      "agent",
      "E2E BG24 long-running keepalive agent",
      "BG24 short-lived Agent 完成后 long-running running Agent row 被错误清掉",
    );

    await clickStopBackgroundTaskControlRow("agent", "E2E BG24 long-running keepalive agent");
    const stopNotificationIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_BACKGROUND_AGENT_CONTROL_PRESERVE",
          "<task-notification>",
          "<tool-use-id>toolu_e2e_bg24_long_running_agent</tool-use-id>",
          "<status>killed</status>",
          "was stopped by user</summary>",
        ],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      thirdShortLivedNotificationIndex,
      "BG24 long-running background Agent stop notification 没有进入父模型请求",
    );
    expect(stopNotificationIndex).toBeGreaterThan(thirdShortLivedNotificationIndex);
    await waitForV4AssistantMessageContaining(
      "background-agent-control-preserve-long-running-stopped-ok",
    );
    await waitForIdle("BG24 long-running Agent stop notification 后会话没有回到 idle");
    await waitForNoBackgroundTaskControlRow(
      "agent",
      "E2E BG24 long-running keepalive agent",
      "BG24 stop 后 long-running Agent row 没有从右上角面板消失",
    );
  });
});

async function waitForFirstRequestIndex(
  query: Parameters<typeof waitForUpstreamRequest>[0],
  afterIndex: number,
  timeoutMsg: string,
) {
  await waitForUpstreamRequest(query, timeoutMsg, 45000, { afterIndex });
  const index = await findFirstUpstreamRequestIndex(query, { afterIndex });
  if (index === null) {
    throw new Error(`${timeoutMsg}; request disappeared after wait`);
  }
  if (
    query.includes?.includes("<task-notification>") ||
    query.lastUserMessageIncludes?.includes("<task-notification>")
  ) {
    const records = await getUpstreamRequestEvidence(query, {
      afterIndex: index - 1,
      beforeIndex: index + 1,
    });
    await assertTaskNotificationContents(records[0]!.requestJson, `background-request-${index}`);
  }
  return index;
}

async function waitForRunningPidFile(path: string, label: string): Promise<number> {
  let recordedPid: number | null = null;
  await browser.waitUntil(
    async () => {
      recordedPid = await readRecordedPid(path);
      return recordedPid !== null && isProcessAlive(recordedPid);
    },
    {
      timeout: 30000,
      timeoutMsg: `${label} 没有写入 fresh PID marker 或进程未保持运行`,
    },
  );
  return recordedPid!;
}

async function readRecordedPid(path: string): Promise<number | null> {
  const raw = await readFile(path, "utf-8").catch(() => "");
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readPosixProcessGroupId(pid: number): Promise<number> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile("ps", ["-o", "pgid=", "-p", String(pid)], (error, output) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(output);
    });
  });
  const processGroupId = Number(stdout.trim());
  if (!Number.isInteger(processGroupId) || processGroupId <= 1) {
    throw new Error(`无法读取 PID ${pid} 的 POSIX PGID: ${JSON.stringify(stdout)}`);
  }
  return processGroupId;
}

async function waitForProcessExit(pid: number, label: string): Promise<void> {
  await browser.waitUntil(() => !isProcessAlive(pid), {
    timeout: 15000,
    timeoutMsg: `${label} PID ${pid} 在 background stop 收口后仍存活`,
  });
}

async function cleanupBg08ProcessTree(): Promise<void> {
  const processFiles = [BG08_WORKER_PID_FILE, BG08_LAUNCHER_PID_FILE];
  if (process.platform !== "win32") {
    processFiles.push(BG08_ROOT_PID_FILE);
  }
  for (const path of processFiles) {
    const pid = await readRecordedPid(path);
    if (pid === null || !isProcessAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 测试收尾与进程自然退出存在竞争，已退出即视为完成。
    }
  }
}

async function removeBg08PidFiles(): Promise<void> {
  await Promise.all(
    [BG08_ROOT_PID_FILE, BG08_LAUNCHER_PID_FILE, BG08_WORKER_PID_FILE].map((path) =>
      rm(path, { force: true }).catch(() => undefined),
    ),
  );
}

async function waitForVisibleUserMessagesContainingAll(
  markers: readonly string[],
  timeoutMsg: string,
) {
  let latestMessages: Awaited<ReturnType<typeof getV4Messages>> = [];
  await browser.waitUntil(
    async () => {
      latestMessages = await getV4Messages("user");
      return markers.every((marker) =>
        latestMessages.some((message) => message.text.includes(marker)),
      );
    },
    {
      timeout: 60000,
      timeoutMsg: `${timeoutMsg}; visibleUserMessages=${JSON.stringify(
        latestMessages.map((message) => ({
          id: message.id,
          text: message.text.slice(0, 200),
        })),
      )}`,
    },
  );
}

type VisibleUserMessageSample = {
  at: number;
  messages: Array<{
    id: string | null;
    text: string;
  }>;
};

async function startVisibleUserMessageSampler() {
  await browser.execute(
    (messagesTestId: string, userMessagePrefix: string) => {
      type SamplerState = {
        intervalId: ReturnType<typeof setInterval>;
        samples: VisibleUserMessageSample[];
      };
      const sampleWindow = window as typeof window & {
        __zcodeBg17UserMessageSampler?: SamplerState;
      };
      if (sampleWindow.__zcodeBg17UserMessageSampler) {
        clearInterval(sampleWindow.__zcodeBg17UserMessageSampler.intervalId);
      }
      const collect = () => {
        const root = document.querySelector<HTMLElement>(`[data-testid="${messagesTestId}"]`);
        const messages = Array.from(
          root?.querySelectorAll<HTMLElement>(`[data-testid^="${userMessagePrefix}-"]`) ?? [],
        ).map((element) => ({
          id: element.getAttribute("data-message-id"),
          text: element.innerText.replace(/\u00a0/g, " ").trim(),
        }));
        sampleWindow.__zcodeBg17UserMessageSampler?.samples.push({
          at: Date.now(),
          messages,
        });
      };
      sampleWindow.__zcodeBg17UserMessageSampler = {
        intervalId: setInterval(collect, 50),
        samples: [],
      };
      collect();
    },
    TID_CHAT_MESSAGES,
    TID_CHAT_USER_MESSAGE,
  );
}

async function stopVisibleUserMessageSampler() {
  return await browser.execute(() => {
    const sampleWindow = window as typeof window & {
      __zcodeBg17UserMessageSampler?: {
        intervalId: ReturnType<typeof setInterval>;
        samples: VisibleUserMessageSample[];
      };
    };
    const sampler = sampleWindow.__zcodeBg17UserMessageSampler;
    if (!sampler) {
      return [] satisfies VisibleUserMessageSample[];
    }
    clearInterval(sampler.intervalId);
    delete sampleWindow.__zcodeBg17UserMessageSampler;
    return sampler.samples;
  });
}

function assertVisibleUserMessageMarkersNeverDisappear(
  samples: readonly VisibleUserMessageSample[],
  markers: readonly string[],
) {
  const seen = new Set<string>();
  const violations: Array<{
    marker: string;
    sampleIndex: number;
    at: number;
    messages: VisibleUserMessageSample["messages"];
  }> = [];
  for (const [sampleIndex, sample] of samples.entries()) {
    const presentMarkers = new Set(
      markers.filter((marker) => sample.messages.some((message) => message.text.includes(marker))),
    );
    for (const marker of presentMarkers) {
      seen.add(marker);
    }
    for (const marker of seen) {
      if (!presentMarkers.has(marker)) {
        violations.push({
          marker,
          sampleIndex,
          at: sample.at,
          messages: sample.messages,
        });
      }
    }
  }

  expect(violations).toEqual([]);
}

async function waitForIdle(timeoutMsg: string) {
  return waitForV4ConversationState(
    (snapshot) => snapshot.state !== "streaming" && !snapshot.stopRequested,
    timeoutMsg,
    90000,
  );
}

async function assertNoVisibleTaskNotification() {
  await assertVisibleV4UserMessagesNotContaining("<task-notification>");
  await assertVisibleV4UserMessagesNotContaining("E2E_BACKGROUND_AGENT_CHILD_RESULT");
  await assertVisibleV4UserMessagesNotContaining("E2E_BACKGROUND_GOAL_CHILD_RESULT");
  await assertVisibleV4UserMessagesNotContaining("E2E_BACKGROUND_SEND_MESSAGE_CHILD_RECEIVED");
  await assertVisibleV4UserMessagesNotContaining("E2E_BACKGROUND_AGENT_CHILD_TOOL_IDLE_DONE");
  await assertVisibleV4UserMessagesNotContaining("E2E_BACKGROUND_COMPACT_AFTER_IDLE_DONE");
  await assertVisibleV4UserMessagesNotContaining(
    "E2E_BACKGROUND_QUEUE_DRAIN_AFTER_MAIN_END_CHILD_DONE",
  );
  await assertVisibleV4UserMessagesNotContaining("E2E_BACKGROUND_NESTED_BASH_CHILD_DONE");
}

async function assertNoMainFakeLoading(timeoutMsg: string) {
  await browser.pause(600);
  const [snapshot, loadingTexts] = await Promise.all([
    getV4ConversationState(),
    getVisibleChatLoadingTexts(),
  ]);
  if (snapshot.state === "streaming" || loadingTexts.length > 0) {
    throw new Error(
      `${timeoutMsg}; state=${JSON.stringify(snapshot)}; loading=${JSON.stringify(loadingTexts)}`,
    );
  }
}

async function waitForMainLoading(timeoutMsg: string) {
  let latestSnapshot = await getV4ConversationState();
  let latestLoadingTexts: string[] = [];
  await browser.waitUntil(
    async () => {
      latestSnapshot = await getV4ConversationState();
      latestLoadingTexts = await getVisibleChatLoadingTexts();
      // Bugfix: Windows Electron 下 foreground Bash 有时只暴露 chat root streaming 状态，
      // 不稳定渲染旧的底部 loading 节点；这里验证主会话没有退成 background-only idle 即可。
      return latestSnapshot.state === "streaming";
    },
    {
      interval: 100,
      timeout: 5000,
      timeoutMsg: `${timeoutMsg}; latest=${JSON.stringify(
        latestSnapshot,
      )}; loading=${JSON.stringify(latestLoadingTexts)}`,
    },
  );
}

async function getVisibleChatLoadingTexts(): Promise<string[]> {
  return browser.execute((chatLoadingTestId) => {
    // display: contents 祖先没有布局盒但子元素仍可见，不能用祖先零尺寸判隐藏。
    const isElementVisible = (element: HTMLElement) =>
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    return Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid="${chatLoadingTestId}"]`),
    )
      .filter(isElementVisible)
      .map((element) => element.innerText.replace(/\u00a0/g, " ").trim());
  }, TID_CHAT_LOADING);
}

async function assertNoMainToolCallById(toolCallId: string, failureMessage: string) {
  const blocks = await listToolCallBlocks();
  const mirrored = blocks.filter((block) => block.toolCallId?.includes(toolCallId));
  if (mirrored.length > 0) {
    throw new Error(`${failureMessage}; mirrored=${JSON.stringify(mirrored)}`);
  }
}

async function beginBackgroundTelemetryCapture() {
  // 跨 case 复用采集器会混入中间用例的 completion，失败后游标也可能只推进一半。
  // 每条 case 从空 HTTP 调用记录和 ARMS 缓冲开始，保留精确数量断言。
  const capture = await beginConversationTelemetryCapture();
  await capture.telemetryFetch.mockClear();
  return capture;
}

async function startNewBackgroundDraft() {
  // Bash fixture 的相对路径属于夹具项目；全局新建会切到另一个 cwd，读不到 PID/释放文件。
  // 初始空草稿直接复用，避免准备步骤重复新建；已有任务仍走同一项目的新建入口。
  await prepareV4ConversationE2E({ skipProvider: true });
  // Bug 根因：suite 只在 before 设置 yolo，新草稿恢复默认 build 后 child Bash 会停在审批。
  // 生命周期用例在每次 draft admission 前固定前置；权限代理仍由独立 interaction spec 验证。
  await ensureToolCrossProductFullAccessMode();
}

async function respondToBackgroundBlockers() {
  // Full access 前置条件下正常路径没有 blocker；只做一次兼容探测，不能再固定等待
  // 3 秒，否则 4 秒 child Bash 会在 UI running 断言前结束，掩盖真实生命周期窗口。
  await respondToToolCrossProductBlockers();
}

type BackgroundTaskControlKind = "agent" | "bash";

interface BackgroundTaskControlRowSnapshot {
  buttonDisabled: boolean;
  kind: string | null;
  text: string;
  visible: boolean;
}

interface BackgroundTaskProjectionSnapshot {
  projectionSeq: string | null;
  runningSubagentIds: string | null;
  runningSubagentWorkIds: string | null;
  sessionId: string | null;
}

async function waitForBackgroundTaskControlRow(
  kind: BackgroundTaskControlKind,
  textIncludes: string,
  timeoutMsg: string,
) {
  let latest: BackgroundTaskControlRowSnapshot[] = [];
  let projection: BackgroundTaskProjectionSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      try {
        await openV4ComposerRunningBackgroundWorks();
      } catch (error) {
        projection = await getBackgroundTaskProjectionSnapshot();
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; projection=${JSON.stringify(projection)}`,
          { cause: error },
        );
      }
      latest = await getBackgroundTaskControlRows({ visibleOnly: false });
      return latest.some(
        (row) => row.visible && row.kind === kind && row.text.includes(textIncludes),
      );
    },
    {
      interval: 250,
      timeout: 30000,
      timeoutMsg: `${timeoutMsg}; latest=${JSON.stringify(latest)}; projection=${JSON.stringify(projection)}`,
    },
  );
}

async function getBackgroundTaskProjectionSnapshot(): Promise<BackgroundTaskProjectionSnapshot> {
  return browser.execute(
    (paneTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      return {
        projectionSeq: pane?.getAttribute("data-projection-seq") ?? null,
        runningSubagentIds: pane?.getAttribute("data-running-subagent-ids") ?? null,
        runningSubagentWorkIds: pane?.getAttribute("data-running-subagent-work-ids") ?? null,
        sessionId: pane?.getAttribute("data-session-id") ?? null,
      };
    },
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
  );
}

async function waitForNoBackgroundTaskControlRow(
  kind: BackgroundTaskControlKind,
  textIncludes: string,
  timeoutMsg: string,
) {
  let latest: BackgroundTaskControlRowSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      latest = await getBackgroundTaskControlRows({ visibleOnly: false });
      return !latest.some((row) => row.kind === kind && row.text.includes(textIncludes));
    },
    {
      interval: 250,
      timeout: 30000,
      timeoutMsg: `${timeoutMsg}; latest=${JSON.stringify(latest)}`,
    },
  );
}

interface BackgroundTaskControlPresenceProbeResult {
  missingTransitions: Array<{
    atMs: number;
    panelState: string | null;
    rows: string[];
    storeJobs: string[];
  }>;
  observedPresent: boolean;
}

async function startBackgroundTaskControlPresenceProbe(
  kind: BackgroundTaskControlKind,
  textIncludes: string,
  taskId: string,
) {
  await openV4ComposerRunningBackgroundWorks();
  await browser.execute(
    (expectedKind, expectedText, expectedTaskId, v4SessionPanePrefix) => {
      const probeKey = "__zcodeBackgroundTaskControlPresenceProbe";
      const probeWindow = window as typeof window & {
        __zcodeBackgroundTaskControlPresenceProbe?: {
          intervalId: number;
          missingTransitions: Array<{
            atMs: number;
            panelState: string | null;
            rows: string[];
            storeJobs: string[];
          }>;
          hasLeftTask: boolean;
          hasReturnedToTask: boolean;
          observedPresent: boolean;
          startedAt: number;
          wasPresent: boolean | null;
        };
      };
      const existing = probeWindow[probeKey];
      if (existing) {
        window.clearInterval(existing.intervalId);
      }
      const state: NonNullable<(typeof probeWindow)[typeof probeKey]> = {
        intervalId: 0,
        missingTransitions: [],
        hasLeftTask: false,
        hasReturnedToTask: false,
        observedPresent: false,
        startedAt: performance.now(),
        wasPresent: null,
      };
      // display: contents 祖先没有布局盒但子元素仍可见，不能用祖先零尺寸判隐藏。
      const isElementVisible = (element: HTMLElement) =>
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      const sample = () => {
        const legacyTaskId = document
          .querySelector<HTMLElement>('[data-testid="chat-view"]')
          ?.getAttribute("data-task-id");
        const v4SessionId = document
          .querySelector<HTMLElement>(`[data-testid="${v4SessionPanePrefix}-workspace-main"]`)
          ?.getAttribute("data-session-id");
        // Bug 根因：V4 无 legacy chat-view；presence probe 需要从主 pane
        // 读取 session id，否则切回目标 task 后仍会被误判成“尚未返回”。
        const activeTaskId =
          legacyTaskId || (v4SessionId && v4SessionId !== "draft" ? v4SessionId : null);
        if (activeTaskId !== expectedTaskId) {
          state.hasLeftTask = true;
          state.wasPresent = null;
          return;
        }
        if (state.hasLeftTask) {
          state.hasReturnedToTask = true;
        }
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>("[data-background-task-kind]"),
        );
        const present = rows.some(
          (row) =>
            row.getAttribute("data-background-task-kind") === expectedKind &&
            row.innerText.includes(expectedText) &&
            isElementVisible(row),
        );
        state.observedPresent ||= present;
        if (state.hasReturnedToTask && state.wasPresent === true && !present) {
          const store = (
            window as typeof window & {
              __zcodeSessionStoreE2E?: {
                getState: () => {
                  workspaces: Record<
                    string,
                    {
                      taskRuntimeByTaskId?: Record<
                        string,
                        {
                          backgroundTaskControls?: Array<{
                            jobId: string;
                            status: string;
                            title?: string;
                          }>;
                        }
                      >;
                    }
                  >;
                };
              };
            }
          ).__zcodeSessionStoreE2E;
          const taskRuntime = Object.values(store?.getState().workspaces ?? {})
            .map((workspace) => workspace.taskRuntimeByTaskId?.[expectedTaskId])
            .find(Boolean);
          state.missingTransitions.push({
            atMs: Math.round(performance.now() - state.startedAt),
            panelState:
              document
                .querySelector<HTMLElement>('[data-testid="chat-summary-panel"]')
                ?.getAttribute("data-state") ?? null,
            rows: rows.map((row) => row.innerText.replace(/\u00a0/g, " ").trim()),
            storeJobs: (taskRuntime?.backgroundTaskControls ?? []).map(
              (job) => `${job.jobId}:${job.status}:${job.title ?? ""}`,
            ),
          });
        }
        state.wasPresent = present;
      };
      sample();
      state.intervalId = window.setInterval(sample, 16);
      probeWindow[probeKey] = state;
    },
    kind,
    textIncludes,
    taskId,
    TID_V4_SESSION_PANE,
  );
}

async function stopBackgroundTaskControlPresenceProbe(): Promise<BackgroundTaskControlPresenceProbeResult> {
  return browser.execute(() => {
    const probeKey = "__zcodeBackgroundTaskControlPresenceProbe";
    const probeWindow = window as typeof window & {
      __zcodeBackgroundTaskControlPresenceProbe?: {
        intervalId: number;
        missingTransitions: BackgroundTaskControlPresenceProbeResult["missingTransitions"];
        observedPresent: boolean;
      };
    };
    const state = probeWindow[probeKey];
    if (!state) {
      return { missingTransitions: [], observedPresent: false };
    }
    window.clearInterval(state.intervalId);
    delete probeWindow[probeKey];
    return {
      missingTransitions: state.missingTransitions,
      observedPresent: state.observedPresent,
    };
  });
}

async function clickStopBackgroundTaskControlRow(
  kind: BackgroundTaskControlKind,
  textIncludes: string,
) {
  let latest:
    | { clicked: true; rows: [] }
    | { clicked: false; rows: BackgroundTaskControlRowSnapshot[] } = {
    clicked: false,
    rows: [],
  };
  await browser.waitUntil(
    async () => {
      await openV4ComposerRunningBackgroundWorks();
      latest = await browser.execute(
        (expectedKind, expectedText, cancelButtonPrefix) => {
          // display: contents 祖先没有布局盒但子元素仍可见，不能用祖先零尺寸判隐藏。
          const isElementVisible = (element: HTMLElement) =>
            element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
          const rows = Array.from(
            document.querySelectorAll<HTMLElement>("[data-background-task-kind]"),
          );
          const row = rows.find(
            (candidate) =>
              isElementVisible(candidate) &&
              candidate.getAttribute("data-background-task-kind") === expectedKind &&
              candidate.innerText.includes(expectedText),
          );
          // Bug 根因：V4 Agent 行的第一个 button 是透明的 child session 下钻入口，
          // 旧 helper 会误点详情而没有发出 stop。取消动作必须按专用 test id 定位。
          // Agent 行的停止按钮改为按 taskId/executionId 停止后，testid 是
          // `v4-running-subagent-stop`；终端行仍是 `v4-background-work-cancel-<workId>`。
          const button = row?.querySelector<HTMLButtonElement>(
            `[data-testid^="${cancelButtonPrefix}-"], [data-testid="v4-running-subagent-stop"]`,
          );
          if (!row || !button || button.disabled || !isElementVisible(button)) {
            return {
              clicked: false,
              rows: rows.map((candidate) => ({
                buttonDisabled:
                  candidate.querySelector<HTMLButtonElement>("button")?.disabled ?? false,
                kind: candidate.getAttribute("data-background-task-kind"),
                text: candidate.innerText.replace(/\u00a0/g, " ").trim(),
                visible: isElementVisible(candidate),
              })),
            };
          }
          button.click();
          return { clicked: true, rows: [] };
        },
        kind,
        textIncludes,
        TID_V4_BACKGROUND_WORK_CANCEL,
      );
      return latest.clicked;
    },
    {
      interval: 250,
      timeout: 30000,
      timeoutMsg: `没有点击到 background control stop button: ${JSON.stringify(latest)}`,
    },
  );
}

async function getBackgroundTaskControlRows({
  visibleOnly,
}: {
  visibleOnly: boolean;
}): Promise<BackgroundTaskControlRowSnapshot[]> {
  return browser.execute((filterVisible) => {
    // display: contents 祖先没有布局盒但子元素仍可见，不能用祖先零尺寸判隐藏。
    const isElementVisible = (element: HTMLElement) =>
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    return Array.from(document.querySelectorAll<HTMLElement>("[data-background-task-kind]"))
      .map((row) => ({
        buttonDisabled: row.querySelector<HTMLButtonElement>("button")?.disabled ?? false,
        kind: row.getAttribute("data-background-task-kind"),
        text: row.innerText.replace(/\u00a0/g, " ").trim(),
        visible: isElementVisible(row),
      }))
      .filter((row) => !filterVisible || row.visible);
  }, visibleOnly);
}

async function stopIfBusy() {
  const snapshot = await getV4ConversationState().catch(() => null);
  if (snapshot?.state !== "streaming" || snapshot.stopRequested) {
    return;
  }
  await browser.keys(["Escape"]).catch(() => undefined);
  await waitForV4ConversationState(
    (candidate) => candidate.state !== "streaming" || candidate.stopRequested,
    "background E2E 收尾时没有停止当前运行",
    30000,
  ).catch(() => undefined);
}

function assertBackgroundToolStepTelemetry(
  reports: ConversationTelemetryReport[],
  childToolCallId: string,
): void {
  const backgroundSteps = reports.filter(
    (report) =>
      report.element_name === "agent_step" &&
      (report.event_extra_detail as Record<string, unknown> | undefined)?.agent_role ===
        "background subagent",
  );
  expect(backgroundSteps).toHaveLength(2);

  const detail = backgroundSteps[0]?.event_extra_detail as Record<string, unknown> | undefined;
  expect(detail).toMatchObject({
    agent_role: "background subagent",
    step_type: "tool_call",
    status: "success",
    tool_name: "Bash",
    loop_index: "1",
    token_usage_scope: "",
    total_tokens: "0",
  });
  expect(typeof detail?.agent_id).toBe("string");
  expect(String(detail?.agent_id)).not.toHaveLength(0);
  expect(typeof detail?.model_name).toBe("string");
  expect(detail?.model_name).not.toBe("");
  expect(typeof detail?.model_provider).toBe("string");
  expect(detail?.model_provider).not.toBe("");
  expect(typeof detail?.provider_name).toBe("string");
  expect(detail?.provider_name).not.toBe("");
  expect(typeof backgroundSteps[0]?.message_id).toBe("string");
  expect(backgroundSteps[0]?.message_id).not.toBe("");
  expect(typeof backgroundSteps[0]?.talk_id).toBe("string");
  expect(backgroundSteps[0]?.talk_id).not.toBe("");
  expect(String(detail?.tool_call_id)).toBe(
    `tool_subagent_${String(detail?.agent_id)}_${childToolCallId}`,
  );
  // 两个 fixture child 请求各 input=128，tool_use output=16、最终 text output=12。
  // usage 只出现在收口 Agent step，不能复制到 child Bash，也不能串到后续 main turn。
  const aggregate = backgroundSteps[1]!;
  const aggregateDetail = aggregate.event_extra_detail as Record<string, unknown>;
  expect(aggregateDetail).toMatchObject({
    agent_role: "background subagent",
    agent_id: detail?.agent_id,
    step_type: "tool_call",
    tool_name: "Agent",
    status: "success",
    loop_index: "2",
    token_usage_scope: "subagent_requests",
    model_request_count: "2",
    input_tokens: "256",
    output_tokens: "28",
    total_tokens: "284",
    model_name: detail?.model_name,
    model_provider: detail?.model_provider,
    provider_name: detail?.provider_name,
  });
  expect(aggregateDetail.tool_call_id).toBe(
    `tool_subagent_${String(detail?.agent_id)}_${String(aggregateDetail.parent_tool_call_id)}`,
  );
  const completions = reports.filter((report) => report.element_name === "message_completion");
  expect(aggregate.message_id).toBe(completions[0]?.message_id);
  expect(aggregate.message_id).toBe(backgroundSteps[0]?.message_id);
  expect(reports.indexOf(aggregate)).toBeGreaterThan(reports.indexOf(completions[0]!));
  for (const completion of completions) {
    expect(completion.message_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      reports.filter(
        (report) =>
          report.element_name === "agent_step" &&
          report.message_id === completion.message_id &&
          !(report.event_extra_detail as Record<string, unknown>)?.agent_role,
      ).length,
    ).toBeGreaterThan(0);
  }
  expect(
    reports.filter(
      (report) =>
        report.element_name === "message_completion" &&
        ["child_session_id", "parent_tool_call_id"].some((key) =>
          Object.hasOwn(
            (report.event_extra_detail as Record<string, unknown> | undefined) ?? {},
            key,
          ),
        ),
    ),
  ).toHaveLength(0);
}

function assertMainCompletionAgentCompositions(
  reports: ConversationTelemetryReport[],
  expectedCompositions: string[],
): void {
  const completions = reports.filter((report) => report.element_name === "message_completion");
  expect(completions).toHaveLength(expectedCompositions.length);
  expect(
    completions.map(
      (report) =>
        (report.event_extra_detail as Record<string, unknown> | undefined)?.agent_composition,
    ),
  ).toEqual(expectedCompositions);

  const messageIds = completions.map((report) => String(report.message_id ?? ""));
  expect(messageIds.every((messageId) => messageId.length > 0)).toBe(true);
  expect(new Set(messageIds).size).toBe(messageIds.length);
}

function assertMainCompletionMessageSources(
  reports: ConversationTelemetryReport[],
  expectedSources: string[],
): void {
  const completions = reports.filter((report) => report.element_name === "message_completion");
  expect(completions).toHaveLength(expectedSources.length);
  expect(
    completions.map(
      (report) =>
        (report.event_extra_detail as Record<string, unknown> | undefined)?.message_source,
    ),
  ).toEqual(expectedSources);
}
