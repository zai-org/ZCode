import assert from "node:assert/strict";
import { constants } from "node:buffer";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { sqliteMigrations } from "@zcode/shared/sqlite-migrations";

const root = process.argv[2]!;
const payload = "x".repeat(8192);
const rowCount = Math.ceil((constants.MAX_STRING_LENGTH + 1024 * 1024) / payload.length);
const path = join(root, "source.sqlite");
let db = new DatabaseSync(path);
try {
  db.exec("PRAGMA cache_size=-2048; CREATE TABLE part(id INTEGER PRIMARY KEY, data TEXT); BEGIN");
  const insert = db.prepare("INSERT INTO part VALUES (?, ?)");
  for (let id = 0; id < rowCount; id++) insert.run(id, payload);
  db.exec("COMMIT");
  const result = await sqliteMigrations.migrate(
    db,
    [
      {
        id: "0001_large",
        appVersion: "test",
        touchedTables: ["part"],
        sql: "UPDATE part SET data='migrated' WHERE id=0",
      },
    ],
    {
      database: "cli",
      backupDirectories: [join(root, "backup")],
      fallbackBackupDirectories: async () => [],
    },
  );
  assert.ok(result.backupPath);
  const metadata = JSON.parse(await readFile(join(result.backupPath, "backup.json"), "utf8"));
  assert.equal(metadata.version, 2);
  assert.equal(metadata.tables[0].rows, rowCount);
  assert.equal(db.prepare("SELECT data FROM part WHERE id=0").get()!.data, "migrated");
  db.close();
  db = new DatabaseSync(path);
  db.exec("PRAGMA cache_size=-2048");
  await sqliteMigrations.restore(db, result.backupPath);
  assert.equal(db.prepare("SELECT count(*) AS n FROM part").get()!.n, rowCount);
  assert.equal(db.prepare("SELECT count(*) AS n FROM part WHERE data<>?").get(payload)!.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migration").get()!.n, 0);
  console.log(
    JSON.stringify({
      rows: rowCount,
      bytes: rowCount * payload.length,
      maxStringLength: constants.MAX_STRING_LENGTH,
      maxRssKiB: process.resourceUsage().maxRSS,
    }),
  );
} finally {
  db.close();
}
