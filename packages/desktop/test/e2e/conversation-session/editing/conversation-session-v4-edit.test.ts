// PV4-11：stable compact 覆盖 latest user query 后，edit 仍在原 session 做 branch cut。
// compact summary 与旧回复退出 active branch，模型只收到编辑后的 intent，不创建 child，
// 不注入 rewind reminder；UI 与 cold transcript 都以 branch cut 为第一层权威。
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, setInputValueByTestIdDom } from "#e2e/helpers/desktop-app";
import {
  clickV4Send,
  editFirstV4UserQuery,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4CompactMarker,
  waitForV4Edit,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("PV4-11 compact-covered editUserQuery", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("compact 后 edit → 原 session branch cut，无旧分支和 reminder", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_EDIT_ORIGINAL 原始问题");
    await waitForV4TimelineContaining("V4_EDIT_ORIGINAL_REPLY", 60000);
    const original = await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null,
      "首发后没有绑定 session",
    );
    const originalSessionId = original.sessionId;

    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", {
      timeout: 15000,
      timeoutMsg: "composer 输入框没有出现",
    });
    await clickV4Send();
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90000);

    // UI history 不被 compact scope 截断；latest real-user row 仍可编辑。
    await waitForV4Edit();

    await editFirstV4UserQuery("E2E_V4_EDIT_NEWTEXT 编辑后的问题");

    // 编辑后：该轮被 newText 替换并重跑 → 新回复出现，原回复消失。
    await waitForV4TimelineContaining("V4_EDIT_NEW_REPLY", 60000);
    const finalSnapshot = await getV4PaneSnapshot();
    expect(finalSnapshot.sessionId).toBe(originalSessionId);
    expect(finalSnapshot.timelineText).toContain("V4_EDIT_NEW_REPLY");
    expect(finalSnapshot.timelineText).not.toContain("V4_EDIT_ORIGINAL_REPLY");
    expect(finalSnapshot.timelineText).not.toContain("E2E_V4_EDIT_ORIGINAL");
    expect(finalSnapshot.timelineText).not.toContain("Conversation rewind applied");
  });
});
