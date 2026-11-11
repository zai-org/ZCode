// D19：保留更早轮的工具记录，再编辑最新用户消息，核对真实 provider 历史。
// 运行时指定 ZCODE_E2E_UPSTREAM_CONTEXT_WINDOW=128000，避免待审默认小窗口插入自动压缩。
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { getUpstreamRequestEvidence } from "#e2e/helpers/conversation-session-network";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  editFirstV4UserQuery,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Edit,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const fixtureRoot = resolveE2ERuntimePath("conversation-session-tool-history-order");

describe("D19 tool history order after latest-user edit", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("keeps earlier Bash/Read calls and results identical after edit", async function () {
    this.timeout(180000);
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(join(fixtureRoot, "read.txt"), "D19_READ_RESULT\n");
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt("E2E_TOOL_ORDER_SOURCE 按顺序声明 Bash 和 Read，然后回复。");
    await waitForV4TimelineContaining("D19_SOURCE_DONE", 60000);
    const initial = await waitForV4Pane(
      (state) => !state.canStop && Boolean(state.sessionId),
      "首轮未结束",
    );
    await sendV4Prompt("E2E_TOOL_ORDER_LATER 后续问题。");
    await waitForV4TimelineContaining("D19_LATER_DONE", 60000);
    await waitForV4Edit();
    await editFirstV4UserQuery("E2E_TOOL_ORDER_EDITED 编辑后续问题。");
    await waitForV4TimelineContaining("D19_EDITED_DONE", 60000);
    const final = await waitForV4Pane((state) => !state.canStop, "编辑重跑未结束");
    expect(final.sessionId).toBe(initial.sessionId);
    const evidence = await getUpstreamRequestEvidence({
      includes: ["E2E_TOOL_ORDER_SOURCE"],
      excludes: ["Generate a concise title"],
    });
    const historyFor = (fixtureId: string) => {
      const record = evidence.find((entry) => entry.fixtureId === fixtureId);
      expect(record).toBeDefined();
      expect(record!.status).toBe("complete");
      const body = record!.requestJson as { messages: Array<{ content: unknown }> };
      return (
        body.messages
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .filter((block: { type: string; id?: string; tool_use_id?: string }) =>
            ["toolu_d19_bash", "toolu_d19_read"].includes(block.id ?? block.tool_use_id ?? ""),
          )
          // 缓存断点随请求尾部移动，不属于工具历史；仍逐字段比较调用 ID、参数、结果和顺序。
          .map(({ cache_control: _cacheControl, ...block }) => block)
      );
    };
    const live = historyFor("d19-followup");
    expect(live.map((block) => block.id ?? block.tool_use_id)).toEqual([
      "toolu_d19_bash",
      "toolu_d19_read",
      "toolu_d19_bash",
      "toolu_d19_read",
    ]);
    expect(historyFor("d19-later")).toEqual(live);
    expect(historyFor("d19-edited")).toEqual(live);
    expect(final.timelineText).toContain("D19_SOURCE_DONE");
    expect(final.timelineText).not.toContain("D19_LATER_DONE");
  });
});
