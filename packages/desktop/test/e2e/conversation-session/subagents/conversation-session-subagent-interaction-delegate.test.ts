import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import {
  approveV4Permission,
  clickV4Stop,
  getV4ConfigProjection,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4PermissionDialogInComposerDock,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const YOLO_PARENT_MARKER = "E2E_SUBAGENT_HITL_YOLO_PARENT";
const YOLO_CHILD_MARKER = "E2E_SUBAGENT_HITL_YOLO_CHILD";
const YOLO_QUESTION_MARKER = "E2E_SUBAGENT_HITL_YOLO_QUESTION";
const YOLO_ANSWER_MARKER = "E2E_SUBAGENT_HITL_YOLO_ANSWER";
const YOLO_CHILD_DONE = "E2E_SUBAGENT_HITL_YOLO_CHILD_DONE";
const YOLO_PARENT_DONE = "E2E_SUBAGENT_HITL_YOLO_PARENT_DONE";
const YOLO_AGENT_TOOL_CALL_ID = "toolu_e2e_subagent_hitl_yolo_agent";
const YOLO_ASK_TOOL_CALL_ID = "toolu_e2e_subagent_hitl_yolo_ask";

const PERMISSION_PARENT_MARKER = "E2E_SUBAGENT_HITL_PERMISSION_PARENT";
const PERMISSION_CHILD_MARKER = "E2E_SUBAGENT_HITL_PERMISSION_CHILD";
const PERMISSION_BASH_OUTPUT = "E2E_SUBAGENT_HITL_PERMISSION_BASH_OUTPUT";
const PERMISSION_CHILD_DONE = "E2E_SUBAGENT_HITL_PERMISSION_CHILD_DONE";
const PERMISSION_PARENT_DONE = "E2E_SUBAGENT_HITL_PERMISSION_PARENT_DONE";
const PERMISSION_AGENT_TOOL_CALL_ID = "toolu_e2e_subagent_hitl_permission_agent";
const PERMISSION_BASH_TOOL_CALL_ID = "toolu_e2e_subagent_hitl_permission_bash";

describe("会话区 subagent 人机交互代理 E2E", () => {
  afterEach(async () => {
    // 单条失败时先释放 child broker，避免仍在等待的 interaction 污染下一条 case。
    try {
      let snapshot = await getV4PaneSnapshot();
      if (snapshot.sessionId === "draft") {
        // 发送后 optimistic draft 会先渲染，真实 session 稍后才绑定；若断言恰好失败在
        // 这个窗口，必须等绑定完成再 stop，否则 child broker 会继续阻塞下一条 case。
        try {
          snapshot = await waitForV4Pane(
            (current) => current.sessionId !== "draft",
            "subagent interaction case teardown 等待真实 session 绑定超时",
            10_000,
          );
        } catch {
          // draft 从未启动时无需清理。
        }
      }
      if (snapshot.canStop) {
        await clickV4Stop();
        await waitForV4Pane(
          (snapshot) => !snapshot.canStop,
          "subagent interaction case teardown 后仍处于运行态",
          30_000,
        );
      }
    } catch {
      // teardown 只负责隔离下一条 case，不覆盖原始断言失败。
    }
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("T01: Full access 下 child AskUserQuestion 仍代理到父 task", async function () {
    this.timeout(180_000);

    await prepareConversationE2EInMode("yolo");

    const runId = Date.now();
    const prompt = [
      `${YOLO_PARENT_MARKER}_${runId}: Use the Agent tool with subagent_type "general-purpose".`,
      `Ask the child to trigger ${YOLO_CHILD_MARKER}, ask one question, and then finish.`,
      `After the child returns, reply with exactly ${YOLO_PARENT_DONE}.`,
    ].join(" ");
    const answer = `${YOLO_ANSWER_MARKER}_${runId}`;

    await sendV4Prompt(prompt);
    const parentPane = await waitForV4Pane(
      // Host 创建的正式 ID 使用 session_；前缀不是产品身份合同。
      (snapshot) => Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "subagent AskUserQuestion case 发送后没有绑定真实 session",
      30_000,
    );
    await waitForV4TimelineContaining(`${YOLO_PARENT_MARKER}_${runId}`, 30_000);

    // 回归原因：V4 以 parent ProductProjection.pendingInteractions 为权威，不能再读取
    // legacy taskUiByTaskId.elicitationRequest；父 pane 中的可见 dock 才是产品合同。
    const interaction = await waitForSubagentInteractionInParentDock(
      "elicitation",
      YOLO_QUESTION_MARKER,
      60_000,
    );
    expect(interaction.parentSessionId).toBe(parentPane.sessionId);
    expect(interaction.originTitle).toContain("general-purpose");

    await submitCustomElicitationAnswer(answer);
    await waitForInteractionClosed("elicitation", 30_000);

    await waitForUpstreamRequest(
      {
        includes: [answer, YOLO_CHILD_MARKER, YOLO_ASK_TOOL_CALL_ID],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "child AskUserQuestion 回答没有进入 child 下一次模型请求",
      60_000,
    );
    await waitForUpstreamRequest(
      {
        includes: [YOLO_PARENT_MARKER, YOLO_CHILD_DONE, YOLO_AGENT_TOOL_CALL_ID],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "child AskUserQuestion 完成后父会话没有收到 Agent tool_result continuation",
      60_000,
    );
    await waitForV4AssistantMessageContaining(YOLO_PARENT_DONE, 60_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "subagent AskUserQuestion delegate case 完成后没有回到 idle",
      60_000,
    );
  });

  it("T02: build 模式下 child Bash permission request 代理到父 task", async function () {
    this.timeout(180_000);

    await prepareConversationE2EInMode("build");

    const runId = Date.now();
    const prompt = [
      `${PERMISSION_PARENT_MARKER}_${runId}: Use the Agent tool with subagent_type "general-purpose".`,
      `Ask the child to trigger ${PERMISSION_CHILD_MARKER}, run one Bash command, and then finish.`,
      `After the child returns, reply with exactly ${PERMISSION_PARENT_DONE}.`,
    ].join(" ");

    await sendV4Prompt(prompt);
    const parentPane = await waitForV4Pane(
      (snapshot) => Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "subagent permission case 发送后没有绑定真实 session",
      30_000,
    );
    await waitForV4TimelineContaining(`${PERMISSION_PARENT_MARKER}_${runId}`, 30_000);

    const dockState = await waitForV4PermissionDialogInComposerDock(60_000);
    expect(dockState.inDock).toBe(true);
    expect(dockState.composerHidden).toBe(true);
    const interaction = await waitForSubagentInteractionInParentDock(
      "permission",
      PERMISSION_BASH_OUTPUT,
      60_000,
    );
    expect(interaction.parentSessionId).toBe(parentPane.sessionId);
    expect(interaction.originTitle).toContain("general-purpose");
    expect(await hasInteraction("elicitation")).toBe(false);

    expect(await approveV4Permission()).toBe(true);
    await waitForInteractionClosed("permission", 30_000);

    await waitForUpstreamRequest(
      {
        includes: [PERMISSION_CHILD_MARKER, PERMISSION_BASH_OUTPUT, PERMISSION_BASH_TOOL_CALL_ID],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "child Bash 允许后输出没有进入 child 下一次模型请求",
      60_000,
    );
    await waitForUpstreamRequest(
      {
        includes: [PERMISSION_PARENT_MARKER, PERMISSION_CHILD_DONE, PERMISSION_AGENT_TOOL_CALL_ID],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "child Bash 完成后父会话没有收到 Agent tool_result continuation",
      60_000,
    );
    await waitForV4AssistantMessageContaining(PERMISSION_PARENT_DONE, 60_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "subagent permission delegate case 完成后没有回到 idle",
      60_000,
    );
  });
});

type InteractionKind = "elicitation" | "permission";

interface InteractionDockSnapshot {
  parentSessionId: string | null;
  originTitle: string;
  text: string;
}

async function prepareConversationE2EInMode(mode: "build" | "yolo") {
  await prepareV4ConversationE2E();
  await switchV4Mode(mode);
  await browser.waitUntil(async () => (await getV4ConfigProjection()).mode === mode, {
    timeout: 30_000,
    timeoutMsg: `subagent interaction case 没有切换到 mode=${mode}`,
  });
}

async function waitForSubagentInteractionInParentDock(
  kind: InteractionKind,
  expectedText: string,
  timeoutMs: number,
): Promise<InteractionDockSnapshot> {
  let latest: InteractionDockSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await readInteractionDock(kind);
      return Boolean(
        latest?.parentSessionId && latest.originTitle && latest.text.includes(expectedText),
      );
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `父 task 没有出现带 subagent 来源的 ${kind} interaction; latest=${JSON.stringify(
        latest,
      )}`,
    },
  );
  const snapshot = await readInteractionDock(kind);
  if (!snapshot) {
    throw new Error(`等待完成后 ${kind} interaction 仍不存在`);
  }
  return snapshot;
}

function readInteractionDock(kind: InteractionKind): Promise<InteractionDockSnapshot | null> {
  return browser.execute((kindArg) => {
    const normalize = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    const anchor =
      kindArg === "elicitation"
        ? document.querySelector<HTMLElement>('[data-elicitation-dialog-body="true"]')
        : Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find((element) => {
            const label = normalize(element.getAttribute("aria-label"));
            return label === "Permission required" || label === "需要权限";
          });
    const dock = anchor?.closest<HTMLElement>('[data-v4-composer-dock="true"]');
    const pane = dock?.closest<HTMLElement>('[data-testid^="v4-session-pane-"]');
    const badge = dock?.querySelector<HTMLElement>('[data-interaction-origin-badge="subagent"]');
    if (!anchor || !dock || !pane || !badge) {
      return null;
    }
    return {
      parentSessionId: pane.getAttribute("data-session-id"),
      originTitle: normalize(badge.getAttribute("title")),
      text: normalize(dock.innerText || dock.textContent),
    };
  }, kind);
}

function hasInteraction(kind: InteractionKind): Promise<boolean> {
  return browser.execute((kindArg) => {
    if (kindArg === "elicitation") {
      return Boolean(document.querySelector<HTMLElement>('[data-elicitation-dialog-body="true"]'));
    }
    const normalize = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    return Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).some(
      (element) => {
        const label = normalize(element.getAttribute("aria-label"));
        return label === "Permission required" || label === "需要权限";
      },
    );
  }, kind);
}

async function waitForInteractionClosed(kind: InteractionKind, timeoutMs: number) {
  await browser.waitUntil(async () => !(await hasInteraction(kind)), {
    timeout: timeoutMs,
    timeoutMsg: `${kind} interaction 响应后没有从父 task 清除`,
  });
}

async function submitCustomElicitationAnswer(answer: string) {
  const input = await $('[data-elicitation-dialog-body="true"] textarea');
  await input.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: "AskUserQuestion 自定义回答输入框没有出现",
  });
  await input.setValue(answer);
  await browser.waitUntil(async () => (await input.getValue()) === answer, {
    timeout: 10_000,
    timeoutMsg: "AskUserQuestion 自定义回答没有写入输入框",
  });

  const submitButton = await $("//button[contains(., 'Submit') or contains(., '提交')]");
  await submitButton.waitForEnabled({
    timeout: 30_000,
    timeoutMsg: "AskUserQuestion 提交按钮没有启用",
  });
  await submitButton.click();
}
