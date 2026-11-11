// catalog E09（forkUsesEditedActiveBranch）验收（case catalog 战役）。
// 证据层 L3：edit 重跑替换分支 → fork 编辑后的 assistant → child 只含 active branch，
// 不带被 rewind 掉的旧 user/assistant 分支。历史对账链路 = rowId→messageId 翻译 +
// RewindTriggered 截断 + fork 复制 + child 冷订阅 transcript 合成 hydration（曾出过 bug 的面）。
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  clickFirstV4Fork,
  editFirstV4UserQuery,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Edit,
  waitForV4Fork,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("v4 catalog E09：fork 使用编辑后的 active branch", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("edit 重跑后 fork → child 只含编辑分支，不带旧分支", async () => {
    await prepareV4ConversationE2E();

    // 原始首轮
    await sendV4Prompt("E2E_V4_BRANCH_T1 原始问题");
    await waitForV4TimelineContaining("V4_BRANCH_T1_REPLY", 60000);
    const parent = await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null && !s.canStop,
      "首轮没有完成",
      45000,
    );
    const parentSessionId = parent.sessionId;

    // edit：行内 newText + Send → rewind 截断 + 重跑
    await waitForV4Edit();
    // D20：首轮 edit 的 branch cut 不能变成可绘制空帧；真实链路记录中间帧而非只看终态。
    await browser.execute(() => {
      const scope = window as typeof window & {
        __editFrames?: { at: number; hasRows: boolean; height: number }[];
        __editFrameRequest?: number;
      };
      scope.__editFrames = [];
      const sample = () => {
        const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
        scope.__editFrames!.push({
          at: performance.now(),
          hasRows: Boolean(timeline?.querySelector('[data-testid^="v4-row-"]')),
          height: timeline?.scrollHeight ?? 0,
        });
        scope.__editFrameRequest = requestAnimationFrame(sample);
      };
      sample();
    });
    try {
      await editFirstV4UserQuery("E2E_V4_BRANCH_EDITED 编辑后的问题");
      await waitForV4TimelineContaining("E2E_V4_BRANCH_EDITED", 30000);
      await waitForV4TimelineContaining("V4_BRANCH_EDITED_REPLY", 60000);
    } finally {
      const frames = await browser.execute(() => {
        const scope = window as typeof window & {
          __editFrames?: { at: number; hasRows: boolean; height: number }[];
          __editFrameRequest?: number;
        };
        cancelAnimationFrame(scope.__editFrameRequest!);
        const result = scope.__editFrames ?? [];
        delete scope.__editFrames;
        delete scope.__editFrameRequest;
        return result;
      });
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "edit-presentation-frames.json"),
        JSON.stringify(frames, null, 2),
      );
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.filter((frame) => !frame.hasRows)).toEqual([]);
    }
    const afterEdit = await getV4PaneSnapshot();
    expect(afterEdit.timelineText).not.toContain("V4_BRANCH_T1_REPLY");
    expect(afterEdit.timelineText).not.toContain("E2E_V4_BRANCH_T1");

    // fork 编辑后的 assistant 行
    await waitForV4Pane((s) => !s.canStop, "edit 重跑没有收口", 45000);
    await waitForV4Fork();
    expect(await clickFirstV4Fork()).toBe(true);

    const child = await waitForV4Pane(
      (s) => s.sessionId !== null && s.sessionId !== "draft" && s.sessionId !== parentSessionId,
      "fork 后 pane 没有切到 child session",
      60000,
    );
    expect(child.sessionId).not.toBe(parentSessionId);

    // child 历史 = 编辑后的 active branch；旧分支不得进入 child。
    // 注：rewind 合成 notice（rewoundPromptPreview）会引用被编辑掉的原 prompt 文本，
    // 这是 transcript 对 rewind 的记录、不是旧分支复活——强断言只看旧 assistant 回复
    // 与旧 user turn 是否作为真实轮次存在。
    await waitForV4TimelineContaining("V4_BRANCH_EDITED_REPLY", 30000);
    const childSnapshot = await getV4PaneSnapshot();
    expect(childSnapshot.timelineText).toContain("E2E_V4_BRANCH_EDITED");
    expect(childSnapshot.timelineText).not.toContain("V4_BRANCH_T1_REPLY");
  });
});
