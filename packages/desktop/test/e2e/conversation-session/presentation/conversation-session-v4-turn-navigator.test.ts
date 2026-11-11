import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  clearAppData,
  restoreElectronRendererContentSize,
  setCurrentElectronRendererContentSize,
} from "#e2e/helpers/desktop-app";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  clickV4TurnNavigatorItemByIndex,
  focusV4TurnNavigatorItemByIndex,
  getV4TimelineScrollState,
  getV4TurnNavigatorState,
  hoverV4TurnNavigatorItemByIndex,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
  waitForV4TurnNavigator,
  waitForV4TurnNavigatorTooltip,
} from "#e2e/helpers/v4-conversation";

const CASE_NAME = "conversation-session-v4-turn-navigator";
const CASE_RUNTIME_ROOT = resolveE2ERuntimePath(CASE_NAME);
const TOOL_SECRET_FILE_PATH = resolveE2ERuntimePath(CASE_NAME, "tool-secret.txt");
const TOOL_SECRET_CONTENT = "TN_TOOL_SECRET_CONTENT";

let modelProviderReplayServer: Awaited<
  ReturnType<typeof startConversationModelProviderReplayServer>
> | null = null;

describe("v4 Conversation Turn Navigator", () => {
  before(async function () {
    this.timeout(240000);
    await mkdir(CASE_RUNTIME_ROOT, { recursive: true });
    await writeFile(TOOL_SECRET_FILE_PATH, `${TOOL_SECRET_CONTENT}\n`, "utf-8");
    modelProviderReplayServer = await startConversationModelProviderReplayServer(CASE_NAME);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(CASE_RUNTIME_ROOT, { force: true, recursive: true });
    await modelProviderReplayServer?.stop();
    modelProviderReplayServer = null;
  });

  it("TN01-TN03: shows a wide-screen query map, previews user queries, and jumps by bar", async function () {
    this.timeout(260000);
    await prepareV4ConversationE2E();
    const originalContentSize = await setCurrentElectronRendererContentSize(1280);

    try {
      await sendV4Prompt(
        "E2E_V4_TURN_NAV_1 TN_TOOL_BACKED_PROMPT: read the fixture, then summarize.",
      );
      await waitForV4TimelineContaining("TN_ASSISTANT_1_EXCERPT", 60000);
      await waitForV4Pane((snapshot) => !snapshot.canStop, "turn1 没有回到空闲态", 45000);
      await waitForV4TurnNavigator(
        (state) => !state.exists || !state.visible || state.itemCount < 2,
        "只有 1 个可导航 turn 时 navigator 不应显示",
      );

      await sendV4Prompt("E2E_V4_TURN_NAV_2: make the navigator visible.");
      await waitForV4TimelineContaining("TN_ASSISTANT_2_EXCERPT", 60000);
      await waitForV4Pane((snapshot) => !snapshot.canStop, "turn2 没有回到空闲态", 45000);
      await waitForV4TurnNavigator(
        (state) => state.visible && state.itemCount === 2,
        "2 个可导航 turn 且宽屏时 navigator 没有显示",
      );

      await sendV4Prompt("E2E_V4_TURN_NAV_3: add a scroll target.");
      await waitForV4TimelineContaining("TN_ASSISTANT_3_EXCERPT", 60000);
      await waitForV4Pane((snapshot) => !snapshot.canStop, "turn3 没有回到空闲态", 45000);
      await sendV4Prompt("E2E_V4_TURN_NAV_4: finish at the bottom.");
      await waitForV4TimelineContaining("TN_ASSISTANT_4_EXCERPT", 60000);
      await waitForV4Pane((snapshot) => !snapshot.canStop, "turn4 没有回到空闲态", 45000);
      const navigator = await waitForV4TurnNavigator(
        (state) => state.visible && state.itemCount >= 4,
        "4 个可导航 turn 后 navigator item 数量不足",
      );
      expect(navigator.items).toHaveLength(4);
      expect(navigator.composerLeftGutterPx).toBeGreaterThanOrEqual(64);
      expect(navigator.firstItemLeftOffsetPx).toBeLessThanOrEqual(32);
      expect(navigator.firstItemLeftOffsetPx).toBeGreaterThanOrEqual(0);
      expect(Math.abs(navigator.centerOffsetPx)).toBeLessThanOrEqual(24);
      const itemTopGaps = navigator.items
        .slice(1)
        .map((item, index) => item.top - navigator.items[index]!.top);
      expect(Math.min(...itemTopGaps)).toBeGreaterThanOrEqual(10);
      expect(Math.max(...itemTopGaps)).toBeLessThanOrEqual(12);
      for (let index = 1; index < navigator.items.length; index += 1) {
        const previous = navigator.items[index - 1]!;
        const current = navigator.items[index]!;
        expect(Math.abs(current.top - (previous.top + previous.height))).toBeLessThanOrEqual(1);
      }
      expect(
        navigator.items.every((item) => item.visualTone === "idle" && item.visualScale === 1),
      ).toBe(true);

      await focusV4TurnNavigatorItemByIndex(0);
      await hoverV4TurnNavigatorItemByIndex(0);
      await waitForV4TurnNavigator(
        (state) =>
          state.items[0]?.visualTone === "peak" &&
          state.items[0]?.visualColorTone === "focus" &&
          state.items[1]?.visualTone === "near" &&
          state.items[1]?.visualColorTone === "muted" &&
          state.items[2]?.visualTone === "mid" &&
          state.items[2]?.visualColorTone === "muted" &&
          Number(state.items[0]?.visualScale ?? 0) > Number(state.items[1]?.visualScale ?? 0) &&
          Number(state.items[1]?.visualScale ?? 0) > Number(state.items[2]?.visualScale ?? 0),
        "hover/focus 后 navigator 没有形成中心到邻近条递减的山峰效果",
        15000,
      );
      const tooltip = await waitForV4TurnNavigatorTooltip(
        (text) =>
          text.includes("E2E_V4_TURN_NAV_1") &&
          text.includes("TN_ASSISTANT_1_EXCERPT") &&
          !text.includes(TOOL_SECRET_CONTENT),
        "query navigator tooltip 没有展示 user+assistant 摘要，或泄露了工具正文",
      );
      expect(tooltip).not.toContain(TOOL_SECRET_CONTENT);

      const beforeClick = await getV4TurnNavigatorState();
      const targetUnitIndex = beforeClick.items[1]?.unitIndex;
      expect(typeof targetUnitIndex).toBe("number");
      await clickV4TurnNavigatorItemByIndex(1);
      await waitForV4TimelineContaining("TN_ASSISTANT_2_EXCERPT", 15000);
      await waitForV4TurnNavigator(
        (state) => state.items[1]?.active === true,
        "点击第二个 navigator bar 后 active highlight 没有更新",
        15000,
      );
      const scrolled = await getV4TimelineScrollState();
      expect(scrolled.following).toBe("false");

      // TN01 pane 级裁决：收窄 renderer 后 primary pane 的 composer 左侧已容不下
      // 48px rail + 16px 安全间距，navigator 必须隐藏；恢复宽度后重新显示。
      await setCurrentElectronRendererContentSize(820);
      const narrowPane = await waitForV4TurnNavigator(
        (state) => state.composerLeftGutterPx < 64 && (!state.exists || !state.visible),
        "primary pane 收窄后 navigator 没有隐藏",
        15000,
      );
      expect(narrowPane.paneWidthPx).toBeLessThan(864);

      await setCurrentElectronRendererContentSize(1280);
      const restoredPane = await waitForV4TurnNavigator(
        (state) => state.visible && state.itemCount === 4 && state.composerLeftGutterPx >= 64,
        "primary pane 恢复宽度后 navigator 没有恢复",
        15000,
      );
      expect(restoredPane.paneWidthPx).toBeGreaterThanOrEqual(864);
    } finally {
      await restoreElectronRendererContentSize(originalContentSize);
    }
  });
});
