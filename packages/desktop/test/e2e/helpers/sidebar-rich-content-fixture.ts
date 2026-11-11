import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { seedProviderReadinessHistoryFixture } from "#e2e/helpers/provider-readiness-history-fixture";

export const SIDEBAR_RICH_SESSION_ID = "sess_e2e_sidebar_rich_content";
const rowSchema = z.object({
  id: z.string(),
  time_created: z.number(),
  time_updated: z.number(),
  data: z.string(),
});
const snapshotSchema = z.object({
  message: z.array(rowSchema),
  part: z.array(rowSchema.extend({ message_id: z.string() })),
});

/** 只向尚未启动 Host 的隔离 HOME 播种；真实会话正文只读且不进入运行报告。 */
export async function seedSidebarRichContentFixture(options: {
  cliEntryPoint: string;
  e2eHomeDir: string;
  workspacePath: string;
}) {
  if (resolve(options.e2eHomeDir) === resolve(userInfo().homedir)) {
    throw new Error("侧栏性能夹具必须使用隔离 HOME");
  }
  const syntheticText = Array.from(
    { length: 7 },
    (_, index) =>
      `### Section ${index + 1}\n\n${"A long conversation with responsive paragraphs. 中文段落随侧栏宽度重新换行。".repeat(12)}\n\n| Item | Description | Status |\n| --- | --- | --- |\n${Array.from({ length: 24 }, (_, row) => `| ${index}-${row} | A detailed value for a wide Markdown table, with retained horizontal scrolling | completed |`).join("\n")}`,
  ).join("\n\n");
  await seedProviderReadinessHistoryFixture({
    ...options,
    history: {
      sessionId: SIDEBAR_RICH_SESSION_ID,
      title: "E2E_SIDEBAR_RICH_CONTENT",
      userText: "E2E_SIDEBAR_RICH_CONTENT Inspect this completed conversation.",
      assistantText: syntheticText,
      modelId: "missing-model",
      runtimeProviderId: "missing-provider",
      taskProviderId: "glm",
      assistantInputTokens: 100,
      assistantOutputTokens: 100,
    },
  });
  const source = process.env.ZCODE_SIDEBAR_HISTORY_SNAPSHOT;
  let metadata = { source: "synthetic", sha256: "", messages: 2, parts: 2 };
  if (source) {
    const bytes = await readFile(source);
    const snapshot = snapshotSchema.parse(JSON.parse(bytes.toString("utf8")));
    const messageIds = new Set(snapshot.message.map((message) => message.id));
    if (
      snapshot.message.length < 4 ||
      snapshot.part.some((part) => !messageIds.has(part.message_id))
    ) {
      throw new Error("会话副本缺少完整消息或 part 所属消息");
    }
    // node:sqlite 只有同步 API；仅在测试进程、Host 启动前写入离线副本。
    const db = new DatabaseSync(join(options.e2eHomeDir, ".zcode/cli/db/db.sqlite"));
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("DELETE FROM part WHERE session_id = ?").run(SIDEBAR_RICH_SESSION_ID);
      db.prepare("DELETE FROM message WHERE session_id = ?").run(SIDEBAR_RICH_SESSION_ID);
      const messageInsert = db.prepare(
        "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
      );
      for (const row of snapshot.message)
        messageInsert.run(
          row.id,
          SIDEBAR_RICH_SESSION_ID,
          row.time_created,
          row.time_updated,
          row.data,
        );
      const partInsert = db.prepare(
        "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
      );
      for (const row of snapshot.part)
        partInsert.run(
          row.id,
          row.message_id,
          SIDEBAR_RICH_SESSION_ID,
          row.time_created,
          row.time_updated,
          row.data,
        );
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    metadata = {
      source: "recorded-session",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      messages: snapshot.message.length,
      parts: snapshot.part.length,
    };
  }
  await writeFile(
    join(options.e2eHomeDir, "sidebar-rich-fixture.json"),
    JSON.stringify(metadata, null, 2),
  );
}
