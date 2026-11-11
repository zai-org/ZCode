import {
  TID_CHAT_TOOL_CALL_BLOCK,
  TID_CHAT_LOADING,
  TID_V4_COMPOSER_SEND,
  TID_V4_TIMELINE_LOAD_OLDER,
} from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getV4TimelineScrollState,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const PROMPT_MARKER = "E2E_UNREGISTERED_TOOL_COLD_SNAPSHOT";
const FINAL_MARKER = `${PROMPT_MARKER}_DONE`;
const SNAPSHOT_TAIL_ROW_COUNT = 60;

describe("O17/CHL09 未注册工具终态冷快照", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("HLP01/CHL09：同一 turn 被尾窗截断后自动补齐且保持终态", async function () {
    this.timeout(120000);

    await prepareV4ConversationE2E();
    await sendV4Prompt(`${PROMPT_MARKER} 构造未注册 Grep 工具批次并在 continuation 后结束`);
    await waitForV4TimelineContaining(FINAL_MARKER, 60000);

    const terminal = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null &&
        snapshot.sessionId !== "draft" &&
        !snapshot.canStop &&
        snapshot.timelineText.includes(FINAL_MARKER),
      "未注册工具批次完成后会话没有进入 terminal",
      60000,
    );
    if (!terminal.sessionId || terminal.sessionId === "draft") {
      throw new Error("terminal 会话缺少 session id");
    }
    const sessionId = terminal.sessionId;

    const liveRows = await getV4TimelineScrollState();
    expect(liveRows.totalRowCount).toBeGreaterThan(SNAPSHOT_TAIL_ROW_COUNT);
    expect(await readTerminalUiState()).toMatchObject({
      loadingCount: 0,
      sendButtonExists: true,
    });

    // 复现关键：renderer refresh 创建全新订阅，cold snapshot 只带最后 60 行；
    // 同一 turn 的 turnHeader 已在窗口外，不能让残留 tool row 重新推导为 running。
    await browser.refresh();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
      "refresh 后 pane 没有恢复已完成会话",
      60000,
    );
    // HLP01 回归合同：wire snapshot 仍只有 60-row tail，但 renderer 识别到首个
    // turn 缺 header 后必须无感补齐。旧实现会稳定停在 60 rows，并显示“加载更早”；
    // 用户只能靠额外反向滚动让虚拟列表重新对齐并看到 real-user query。
    await browser.waitUntil(
      async () => {
        const rows = await getV4TimelineScrollState();
        return (
          rows.totalRowCount > SNAPSHOT_TAIL_ROW_COUNT && rows.windowRowCount === rows.totalRowCount
        );
      },
      {
        timeout: 15000,
        timeoutMsg: "refresh 后同一 turn 的 60-row cold tail 没有自动补齐，仍需要手动或反向滚动",
      },
    );
    expect(
      await browser.execute(
        (testId) => Boolean(document.querySelector(`[data-testid="${testId}"]`)),
        TID_V4_TIMELINE_LOAD_OLDER,
      ),
    ).toBe(false);
    await waitForV4TimelineContaining(PROMPT_MARKER, 15000);
    await waitForV4TimelineContaining(FINAL_MARKER, 30000);
    await browser.pause(500);

    const restored = await readTerminalUiState();
    expect(restored.sendButtonExists).toBe(true);
    expect(restored.activeToolCount).toBe(0);
    expect(restored.loadingCount).toBe(0);
  });
});

function readTerminalUiState(): Promise<{
  activeToolCount: number;
  loadingCount: number;
  sendButtonExists: boolean;
}> {
  return browser.execute(
    (chatLoadingTestId, sendButtonTestId, toolCallBlockTestId) => {
      const sendButton = document.querySelector<HTMLButtonElement>(
        `[data-testid="${sendButtonTestId}"]`,
      );
      const toolSelector = `[data-testid^="${toolCallBlockTestId}-"]`;
      return {
        activeToolCount: document.querySelectorAll(
          `${toolSelector}[data-status="pending"],${toolSelector}[data-status="in_progress"]`,
        ).length,
        loadingCount: document.querySelectorAll(`[data-testid="${chatLoadingTestId}"]`).length,
        sendButtonExists: Boolean(sendButton),
      };
    },
    TID_CHAT_LOADING,
    TID_V4_COMPOSER_SEND,
    TID_CHAT_TOOL_CALL_BLOCK,
  );
}
