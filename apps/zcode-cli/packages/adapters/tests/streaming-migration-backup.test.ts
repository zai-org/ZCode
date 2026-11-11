import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { sqliteMigrations } from "@zcode/shared/sqlite-migrations";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-streaming-backup-"));
  roots.push(root);
  return root;
}
function database() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}
async function migrate(db: DatabaseSync, root: string, sql = "UPDATE item SET value='changed'") {
  return sqliteMigrations.migrate(
    db,
    [{ id: "0001_change", appVersion: "test", sql, touchedTables: ["item"] }],
    {
      database: "cli",
      backupDirectories: [root],
      fallbackBackupDirectories: async () => [],
    },
  );
}
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("迁移备份的有界内存与恢复", () => {
  it("96 MiB 堆完成超过单字符串上限的表备份、重开和恢复", async () => {
    const root = await fixture();
    const { stdout } = await exec(
      process.execPath,
      [
        "--max-old-space-size=96",
        "--import",
        "tsx",
        fileURLToPath(new URL("./fixtures/streaming-migration-backup-process.ts", import.meta.url)),
        root,
      ],
      { timeout: 180_000, maxBuffer: 1024 * 1024 },
    );
    const report = JSON.parse(stdout.trim());
    console.info("streaming migration backup:", report);
    expect(report.bytes).toBeGreaterThan(report.maxStringLength);
    expect(report.rows).toBeGreaterThan(60_000);
    expect(report.maxRssKiB).toBeLessThan(384 * 1024);
  }, 190_000);

  it("新版哈希忽略行顺序，保留重复行，并在写原库前拒绝备份篡改", async () => {
    const hashes: string[] = [];
    for (const values of [
      ["a", "b", "a"],
      ["b", "a", "a"],
      ["a", "b"],
    ]) {
      const root = await fixture();
      const db = database();
      db.exec("CREATE TABLE item(value TEXT)");
      for (const value of values) db.prepare("INSERT INTO item VALUES (?)").run(value);
      const result = await migrate(db, root);
      const metadata = JSON.parse(await readFile(join(result.backupPath!, "backup.json"), "utf8"));
      expect(metadata.version).toBe(2);
      hashes.push(metadata.tables[0].hash);
      await sqliteMigrations.restore(db, result.backupPath!);
      expect(
        db
          .prepare("SELECT value FROM item ORDER BY value")
          .all()
          .map((r) => r.value),
      ).toEqual([...values].sort());
      const backup = new DatabaseSync(join(result.backupPath!, "tables.sqlite"));
      backup.exec("UPDATE item SET value='tampered' WHERE rowid=1");
      backup.close();
      await expect(sqliteMigrations.restore(db, result.backupPath!)).rejects.toThrow(
        "Backup row count/hash mismatch",
      );
      expect(
        db
          .prepare("SELECT value FROM item ORDER BY value")
          .all()
          .map((r) => r.value),
      ).toEqual([...values].sort());
    }
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
  });

  it("恢复旧版备份：UTF-16 排序、重复行、精确整数、BLOB、空值与新列默认值", async () => {
    const root = await fixture();
    const backupPath = join(root, "legacy");
    await mkdir(backupPath);
    const values: SQLInputValue[][] = [
      ["\uE000", null],
      ["😀", 9223372036854775807n],
      ['a"\\\n', new Uint8Array([0, 255])],
      ['a"\\\n', new Uint8Array([0, 255])],
      ["real", 1.25],
    ];
    const encoded = values
      .map((row) =>
        JSON.stringify(row, (_key, value: unknown) => {
          if (typeof value === "bigint") return { integer: value.toString() };
          if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString("hex") };
          return value;
        }),
      )
      .sort();
    const backup = new DatabaseSync(join(backupPath, "tables.sqlite"));
    backup.exec("CREATE TABLE item(value, detail)");
    for (const row of values) backup.prepare("INSERT INTO item VALUES (?, ?)").run(...row);
    backup.close();
    await writeFile(
      join(backupPath, "backup.json"),
      JSON.stringify({
        version: 1,
        database: "cli",
        migrations: ["0001_change"],
        tables: [
          {
            name: "item",
            columns: ["value", "detail"],
            rows: values.length,
            hash: createHash("sha256").update(JSON.stringify(encoded)).digest("hex"),
          },
        ],
      }),
    );
    const db = database();
    db.exec(
      "CREATE TABLE item(value, detail, added TEXT DEFAULT 'default'); CREATE TABLE schema_migration(id TEXT); INSERT INTO schema_migration VALUES ('0001_change'),('unknown'); INSERT INTO item(value) VALUES ('changed')",
    );
    await sqliteMigrations.restore(db, backupPath);
    const rows = db.prepare("SELECT value,detail FROM item");
    rows.setReadBigInts(true);
    expect(rows.all().map((r) => [r.value, r.detail])).toEqual(values);
    expect(db.prepare("SELECT DISTINCT added FROM item").all()).toEqual([{ added: "default" }]);
    expect(db.prepare("SELECT id FROM schema_migration").all()).toEqual([{ id: "unknown" }]);
  });

  it("迁移失败保留完整备份，原库回滚且不产生迁移记录", async () => {
    const root = await fixture();
    const db = database();
    db.exec("CREATE TABLE item(value TEXT); INSERT INTO item VALUES ('original')");
    await expect(
      migrate(db, root, "UPDATE item SET value='changed'; SELECT * FROM missing_table"),
    ).rejects.toThrow();
    expect(db.prepare("SELECT value FROM item").get()!.value).toBe("original");
    expect(db.isTransaction).toBe(false);
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name='schema_migration'").get(),
    ).toBeUndefined();
    const directories = await readdir(root);
    expect(directories).toHaveLength(1);
    const backup = new DatabaseSync(join(root, directories[0]!, "tables.sqlite"));
    try {
      expect(backup.prepare("SELECT value FROM item").get()!.value).toBe("original");
    } finally {
      backup.close();
    }
  });

  it("流式恢复保持类型和未备份子表，插入失败时原库完整回滚", async () => {
    const root = await fixture();
    const db = database();
    db.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE item(id INTEGER PRIMARY KEY, value); CREATE TABLE child(parent INTEGER REFERENCES item(id) ON DELETE CASCADE)",
    );
    const values: SQLInputValue[] = [
      null,
      9223372036854775807n,
      new Uint8Array([0, 255]),
      1.25,
      "正文",
    ];
    for (const [id, value] of values.entries())
      db.prepare("INSERT INTO item VALUES (?, ?)").run(id, value);
    db.exec("INSERT INTO child VALUES (0)");
    const result = await migrate(db, root);
    db.exec(
      "CREATE TRIGGER reject_restore BEFORE INSERT ON item WHEN NEW.id=2 BEGIN SELECT RAISE(ABORT, 'restore rejected'); END",
    );
    await expect(sqliteMigrations.restore(db, result.backupPath!)).rejects.toThrow(
      "restore rejected",
    );
    expect(db.prepare("SELECT count(*) AS n FROM item WHERE value='changed'").get()!.n).toBe(
      values.length,
    );
    expect(db.prepare("SELECT count(*) AS n FROM schema_migration").get()!.n).toBe(1);
    expect(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
    db.exec("DROP TRIGGER reject_restore");
    await sqliteMigrations.restore(db, result.backupPath!);
    const rows = db.prepare("SELECT value FROM item ORDER BY id");
    rows.setReadBigInts(true);
    expect(rows.all().map((row) => row.value)).toEqual(values);
    expect(db.prepare("SELECT parent FROM child").all()).toEqual([{ parent: 0 }]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
  });
});
