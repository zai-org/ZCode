// M4 门禁：compact（v4 composer slash 命令 `/compact`）。
// 证据层 L3：首轮固定回复形成历史 → composer 输入 `/compact` → handleSendText 识别 slash →
// dispatchCommand("compact", baseRevision) → v4-bridge compactSession → CompactStarted/Completed
// 事件 → reducer onCompactLifecycle → timelineMarker compact/manual/success。
// 证明 slash 命令入口 + compact 全链路（命令面已桥接，仅补 UI 触发）。
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, setInputValueByTestIdDom } from "#e2e/helpers/desktop-app";
import {
  clickV4Send,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4CompactMarker,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("v4 M4 门禁：compact（/compact slash）", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("首轮完成 → /compact → 时间线出现 manual compact success marker", async () => {
    await prepareV4ConversationE2E();

    // 首轮：形成一段可被压缩的历史
    await sendV4Prompt("E2E_V4_COMPACT_SEED 请回复种子");
    await waitForV4TimelineContaining("V4_COMPACT_SEED_OK", 45000);
    await waitForV4Pane(
      (s) => !s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有回到空闲态",
      45000,
    );

    // composer 输入 /compact slash 命令并发送（不走 sendText，走 compact 命令）
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", {
      timeout: 15000,
      timeoutMsg: "composer 输入框没有出现",
    });
    await clickV4Send();

    // v4 投影产出结构化 marker；文案会随 locale 改变，不参与定位。
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90000);
  });
});
