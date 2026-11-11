import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AutomationRepo } from "@zcode/services/node";
import type { ZCodeAutomation, ZCodeAutomationCreateParams } from "@zcode/shared";

/** 使用真实任务库建立关联；日程远于验收窗口，不让后台 tick 改写对照数据。 */
export async function seedArchiveAutomations(target: { workspacePath?: string; taskId: string }) {
  const home = process.env.ZCODE_E2E_HOME_DIR;
  if (!home) throw new Error("archive automation fixture requires isolated E2E HOME");
  const database = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"), { readOnly: true });
  let workspacePath = target.workspacePath;
  try {
    if (!workspacePath) {
      const rows = database
        .prepare("SELECT workspace_path FROM tasks WHERE task_id=?")
        .all(target.taskId);
      expect(rows).toHaveLength(1);
      workspacePath = String(rows[0]!.workspace_path);
    }
  } finally {
    database.close();
  }
  const repo = new AutomationRepo(join(home, ".zcode/v2/tasks-index.sqlite"));
  const records: ZCodeAutomation[] = [];
  try {
    for (const kind of [
      "first",
      "second",
      "paused",
      "completed",
      "failed",
      "unbound",
      "other-identity",
    ]) {
      const input: ZCodeAutomationCreateParams = {
        title: `E2E_ARCHIVE_${kind}`,
        workspacePath,
        targetTaskId: kind === "unbound" ? undefined : target.taskId,
        workspaceIdentity: kind === "other-identity" ? "e2e:other-workspace" : undefined,
        cronExpr: "0 9 * * *",
        prompt: "E2E_ARCHIVE_SCHEDULE",
        recurring: true,
      };
      const record = await repo.create(input, { nextRunAt: Date.now() + 86_400_000 });
      if (kind === "paused" || kind === "completed" || kind === "failed")
        await repo.update(record.automationId, {}, { lifecycleStatus: kind });
      records.push((await repo.get(record.automationId))!);
    }
  } finally {
    repo.close();
  }
  return {
    async assertPaused() {
      try {
        for (const [index, before] of records.entries()) {
          const after = await repo.get(before.automationId);
          expect(after).not.toBeNull();
          const { updatedAt: _beforeTime, ...expected } = before;
          const { updatedAt: _afterTime, ...actual } = after!;
          expect(actual).toEqual(
            index < 2 ? { ...expected, enabled: false, lifecycleStatus: "paused" } : expected,
          );
        }
      } finally {
        repo.close();
      }
    },
  };
}
