import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  V4_MAIN_PANE_ID,
  waitForV4UserMessageContaining,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

describe("草稿首发列表与详情同步", () => {
  for (const scope of ["global", "project"] as const) {
    it(`FSV05：${scope} 首次详情帧已有同一个选中的侧栏任务`, async function () {
      this.timeout(150_000);
      if (scope === "global") {
        await prepareV4ConversationE2E();
        // 通用准备固定在 fixture 项目；FSV05 的全局分支必须实际点击全局新建。
        await startNewV4Draft();
      }
      // 展开所属项目；折叠偏好不是本用例要改变的创建语义。
      const project = $('[data-project-name="ZCodeProject"]');
      let expectedProjectId: string | null = null;
      if (scope === "project") {
        await project.waitForDisplayed();
        expectedProjectId = await project.getAttribute("data-project-id");
        const trigger = project.$('[data-testid="virtual-project-toggle"]');
        if ((await trigger.getAttribute("aria-expanded")) === "false") await trigger.click();
        await trigger.moveTo();
        await project.$('[data-testid="virtual-project-create-task"]').click();
        await browser.waitUntil(
          async () =>
            (await $(
              `[data-testid="${testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID)}"]`,
            ).getAttribute("data-session-id")) === "draft",
        );
      }
      const paneId = testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID);
      await browser.execute((id) => {
        const before = new Set(
          [...document.querySelectorAll('[data-testid^="task-item-"]')].map((row) =>
            row.getAttribute("data-testid"),
          ),
        );
        const state = {
          done: false,
          frames: [] as Array<{
            sessionId: string;
            row: boolean;
            selected: boolean;
            newRows: number;
          }>,
        };
        (window as typeof window & { __firstSubmitEvidence?: typeof state }).__firstSubmitEvidence =
          state;
        const sample = () => {
          const sessionId =
            document.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-session-id") ??
            "draft";
          const row = document.querySelector<HTMLElement>(`[data-testid="task-item-${sessionId}"]`);
          state.frames.push({
            sessionId,
            row: Boolean(row && row.getBoundingClientRect().height > 0),
            newRows: [...document.querySelectorAll('[data-testid^="task-item-"]')].filter(
              (item) => !before.has(item.getAttribute("data-testid")),
            ).length,
            selected: Boolean(row?.classList.contains("bg-selected")),
          });
          if (sessionId !== "draft" && sessionId) state.done = true;
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, paneId);
      const marker = `E2E_FIRST_SUBMIT_VISIBILITY_${scope}`;
      await sendV4Prompt(`${marker}: Reply with exactly "deepseek-e2e-ok".`);
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            Boolean(
              (window as typeof window & { __firstSubmitEvidence?: { done: boolean } })
                .__firstSubmitEvidence?.done,
            ),
          ),
        { timeout: 30_000 },
      );
      const evidence = await browser.execute(
        () =>
          (
            window as typeof window & {
              __firstSubmitEvidence?: {
                frames: Array<{
                  sessionId: string;
                  row: boolean;
                  selected: boolean;
                  newRows: number;
                }>;
              };
            }
          ).__firstSubmitEvidence!,
      );
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `FSV05-${scope}-frames.json`),
        JSON.stringify(evidence, null, 2),
      );
      const firstDetail = evidence.frames.find(
        (frame) => frame.sessionId !== "draft" && frame.sessionId,
      );
      expect(firstDetail).toMatchObject({ row: true, selected: true });
      expect(
        evidence.frames
          .filter((frame) => frame.sessionId === "draft")
          .every((frame) => frame.newRows === 0),
      ).toBe(true);
      const db = new DatabaseSync(
        join(process.env.ZCODE_E2E_HOME_DIR!, ".zcode/v2/tasks-index.sqlite"),
        { readOnly: true },
      );
      try {
        const fact = db
          .prepare("SELECT project_id,cli_created_at,cli_title FROM tasks WHERE task_id=?")
          .get(firstDetail!.sessionId);
        expect(fact?.project_id).toBe(expectedProjectId);
        expect(Number(fact?.cli_created_at)).toBeGreaterThan(0);
        expect(
          String(fact?.cli_title).includes(marker) || fact?.cli_title === "First submit visibility",
        ).toBe(true);
      } finally {
        db.close();
      }
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `FSV05-${scope}-first-detail.png`),
      );
      await waitForV4UserMessageContaining(marker);
      await waitForV4AssistantMessageContaining("deepseek-e2e-ok");
      await waitForV4ConversationState((state) => state.state === "idle", "首发未完成", 60_000);
    });
  }
});
