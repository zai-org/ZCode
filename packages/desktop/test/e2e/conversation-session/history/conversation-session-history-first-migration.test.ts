import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TID_V4_COMPOSER_INPUT, TID_V4_COMPOSER_SEND } from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  setInputValueByTestIdDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import {
  selectV4TaskById,
  waitForV4TimelineContaining,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  HISTORY_FIRST_SESSION,
  HISTORY_FIRST_TEXT,
} from "#e2e/helpers/session-history-first-fixture";

const root = join(DEFAULT_WORKSPACE, ".zcode", "history-first-e2e");

describe("HF04：旧标题迁移与历史首帧边界", () => {
  after(async () => {
    await writeFile(join(root, "release"), "release").catch(() => undefined);
    await clearAppData();
  });

  it("先到的标题交接不阻塞历史，释放后只恢复一次并完成迁移", async function () {
    this.timeout(120_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    // 先观察迁移启动的 hook，再打开任务，确保不是订阅先到的普通历史场景。
    await browser.waitUntil(
      async () => (await readFile(join(root, "entered"), "utf8").catch(() => "")) === "entered",
      { timeout: 30_000, timeoutMsg: "旧标题交接没有启动冷恢复" },
    );
    const cli = new DatabaseSync(join(homedir(), ".zcode", "cli", "db", "db.sqlite"), {
      readOnly: true,
    });
    const host = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        cli.prepare("SELECT title FROM session WHERE id = ?").get(HISTORY_FIRST_SESSION)?.title,
      ).toBe("E2E_BEFORE_TITLE_HANDOFF");
      expect(
        Number(
          host
            .prepare("SELECT handoff_pending FROM tasks WHERE task_id = ?")
            .get(HISTORY_FIRST_SESSION)?.handoff_pending,
        ) & 2,
      ).toBe(2);
      await selectV4TaskById(HISTORY_FIRST_SESSION);
      await waitForV4TimelineContaining(HISTORY_FIRST_TEXT, 30_000);
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "E2E_HISTORY_FIRST_MIGRATION 保留草稿");
      expect(await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isEnabled()).toBe(false);
      await writeFile(join(root, "release"), "release");
      await browser.waitUntil(
        async () => await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isEnabled(),
        { timeout: 30_000, timeoutMsg: "迁移场景初始化未完成" },
      );
      await browser.waitUntil(
        () =>
          cli.prepare("SELECT title FROM session WHERE id = ?").get(HISTORY_FIRST_SESSION)
            ?.title === "E2E_HISTORY_FIRST" &&
          (Number(
            host
              .prepare("SELECT handoff_pending FROM tasks WHERE task_id = ?")
              .get(HISTORY_FIRST_SESSION)?.handoff_pending,
          ) &
            2) ===
            0,
        { timeout: 30_000, timeoutMsg: "标题或旧意图位没有完成交接" },
      );
      expect(await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).getText()).toContain("保留草稿");
      expect((await readFile(join(root, "attempts"), "utf8")).trim().split("\n")).toHaveLength(1);
      await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).click();
      await waitForV4AssistantMessageContaining("HISTORY_FIRST_MIGRATION_OK", 30_000);
    } finally {
      cli.close();
      host.close();
    }
  });
});
