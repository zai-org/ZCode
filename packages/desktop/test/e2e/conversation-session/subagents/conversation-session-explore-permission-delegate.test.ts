import { access, rm } from "node:fs/promises";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  getLatestUpstreamToolResultByToolCallId,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  clickV4Stop,
  denyV4PermissionWithFeedback,
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

const CASE = "conversation-session-explore-permission-delegate";
const PARENT_MARKER = "E2E_EXPLORE_PERMISSION_PARENT";
const CHILD_MARKER = "E2E_EXPLORE_PERMISSION_CHILD";
const SHOULD_NOT_RUN = "E2E_EXPLORE_PERMISSION_SHOULD_NOT_RUN";
const DENY_FEEDBACK = "E2E_EXPLORE_PERMISSION_DENY_FEEDBACK";
const CHILD_DONE = "E2E_EXPLORE_PERMISSION_CHILD_DONE";
const PARENT_DONE = "E2E_EXPLORE_PERMISSION_PARENT_DONE";
const AGENT_TOOL_CALL_ID = "toolu_e2e_explore_permission_agent";
const BASH_TOOL_CALL_ID = "toolu_e2e_explore_permission_bash";
const OUTPUT_FILE = resolveE2ERuntimePath(CASE, "output.txt");

// 修复原因：内置 Explore 曾固定以 yolo 运行，只靠 prompt 约束只读，提示注入后模型可经
// Agent(Explore) 在 build 父会话下免审批执行任意 Bash。现在 Explore 继承父会话模式，
// 非只读 Bash 必须先在父会话审批。
describe("会话区内置 Explore 权限继承 E2E", () => {
  afterEach(async () => {
    try {
      const snapshot = await getV4PaneSnapshot();
      if (snapshot.canStop) {
        await clickV4Stop();
        await waitForV4Pane(
          (current) => !current.canStop,
          "Explore 权限 case teardown 后仍处于运行态",
          30_000,
        );
      }
    } catch {
      // teardown 只负责隔离下一条 case，不覆盖原始断言失败。
    }
    await rm(resolveE2ERuntimePath(CASE), { recursive: true, force: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("T03: build 模式下 Explore 的非只读 Bash 先在父 task 审批，拒绝后不执行", async function () {
    this.timeout(180_000);

    await prepareV4ConversationE2E();
    await switchV4Mode("build");
    await browser.waitUntil(async () => (await getV4ConfigProjection()).mode === "build", {
      timeout: 30_000,
      timeoutMsg: "Explore 权限 case 没有切换到 mode=build",
    });

    const runId = Date.now();
    await sendV4Prompt(
      [
        `${PARENT_MARKER}_${runId}: Use the Agent tool with subagent_type "Explore".`,
        `Ask the child to trigger ${CHILD_MARKER} and run one Bash command.`,
        `After the child returns, reply with exactly ${PARENT_DONE}.`,
      ].join(" "),
    );
    await waitForV4TimelineContaining(`${PARENT_MARKER}_${runId}`, 30_000);

    const dockState = await waitForV4PermissionDialogInComposerDock(60_000);
    expect(dockState.inDock).toBe(true);
    const interaction = await readPermissionDock();
    expect(interaction?.originTitle).toContain("Explore");
    expect(interaction?.text).toContain(SHOULD_NOT_RUN);
    expect(await fileExists(OUTPUT_FILE)).toBe(false);

    expect(await denyV4PermissionWithFeedback(DENY_FEEDBACK)).toBe(true);

    await waitForUpstreamRequest(
      {
        includes: [CHILD_MARKER, BASH_TOOL_CALL_ID, DENY_FEEDBACK],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "Explore Bash 拒绝结果没有进入 child 下一次模型请求",
      60_000,
    );
    const result = await getLatestUpstreamToolResultByToolCallId(BASH_TOOL_CALL_ID);
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain(DENY_FEEDBACK);

    await waitForUpstreamRequest(
      {
        includes: [PARENT_MARKER, CHILD_DONE, AGENT_TOOL_CALL_ID],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "Explore 完成后父会话没有收到 Agent tool_result continuation",
      60_000,
    );
    await waitForV4AssistantMessageContaining(PARENT_DONE, 60_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "Explore 权限 case 完成后没有回到 idle",
      60_000,
    );
    expect(await fileExists(OUTPUT_FILE)).toBe(false);
  });
});

interface PermissionDockSnapshot {
  originTitle: string;
  text: string;
}

function readPermissionDock(): Promise<PermissionDockSnapshot | null> {
  return browser.execute(() => {
    const normalize = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
      (element) => {
        const label = normalize(element.getAttribute("aria-label"));
        return label === "Permission required" || label === "需要权限";
      },
    );
    const dock = listbox?.closest<HTMLElement>('[data-v4-composer-dock="true"]');
    const badge = dock?.querySelector<HTMLElement>('[data-interaction-origin-badge="subagent"]');
    if (!dock || !badge) return null;
    return {
      originTitle: normalize(badge.getAttribute("title")),
      text: normalize(dock.innerText || dock.textContent),
    };
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
