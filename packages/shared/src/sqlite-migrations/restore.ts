import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { BACKUP_DATABASE_FILE } from "./backup.js";
import { copyTable, hashTable, identifier } from "./table-snapshot.js";

const backupSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  database: z.string(),
  journalTable: z.enum(["schema_migration", "tasks_schema_migration"]).optional(),
  migrations: z.array(z.string()),
  tables: z.array(
    z.object({
      name: z.string(),
      columns: z.array(z.string()),
      rows: z.number().int().nonnegative(),
      hash: z.string(),
    }),
  ),
  skipped: z.literal("insufficient-space").optional(),
});

export async function restore(db: DatabaseSync, backupPath: string): Promise<void> {
  if (db.isTransaction) throw new Error("Restore requires an idle database connection");
  const metadata = backupSchema.parse(
    JSON.parse(await readFile(join(backupPath, "backup.json"), "utf8")),
  );
  if (metadata.skipped) throw new Error("Cannot restore a skipped backup");
  const backup = new DatabaseSync(join(backupPath, BACKUP_DATABASE_FILE), { readOnly: true });
  const foreignKeys = db.prepare("pragma foreign_keys").get()?.foreign_keys === 1;
  try {
    // 校验与复制共用备份库读快照，避免两次读取之间文件被修改；不在 JS 保留整表。
    backup.exec("pragma cache_size=-2048; begin");
    const tables = metadata.tables;
    for (const table of tables) {
      const snapshot = hashTable(backup, table, metadata.version);
      if (snapshot.rows !== table.rows || snapshot.hash !== table.hash)
        throw new Error(`Backup row count/hash mismatch: ${table.name}`);
    }
    // Bug 根因：session 被 message/part 级联引用。恢复不能在 foreign_keys=ON 时先删父表。
    db.exec("pragma foreign_keys=off; begin immediate");
    for (const table of tables) {
      const exists = db
        .prepare("select 1 from sqlite_master where type='table' and name=?")
        .get(table.name);
      if (exists) db.exec(`delete from ${identifier(table.name)}`);
    }
    for (const table of tables) copyTable(backup, db, table);
    if (db.prepare("pragma foreign_key_check").get())
      throw new Error("Restore foreign key check failed");
    for (const table of tables) {
      const restored = hashTable(db, table, metadata.version);
      if (restored.rows !== table.rows || restored.hash !== table.hash)
        throw new Error(`Restored row count/hash mismatch: ${table.name}`);
    }
    for (const id of metadata.migrations)
      db.prepare(
        `delete from ${identifier(metadata.journalTable ?? "schema_migration")} where id=?`,
      ).run(id);
    db.exec("commit");
  } catch (error) {
    if (db.isTransaction) db.exec("rollback");
    throw error;
  } finally {
    db.exec(`pragma foreign_keys=${foreignKeys ? "on" : "off"}`);
    backup.close();
  }
}
