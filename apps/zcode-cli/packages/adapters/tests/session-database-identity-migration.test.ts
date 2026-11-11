import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  runSqliteSessionMigrations,
  runSqliteSessionMigrationsAsync,
  type SqliteMigrationProgress,
} from "../src/storage/session-store/migration-runner.js";
import { runSessionDatabaseIdentityMigration } from "@zcode/shared/sqlite-migrations";
it("Source 记账失败回滚新表，Agent 与 Source 都拒绝已有 checksum 损坏", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL);
      CREATE TRIGGER reject_identity BEFORE INSERT ON schema_migration
      WHEN NEW.id='0024_session_database_identity'
      BEGIN SELECT RAISE(ABORT, 'injected identity ledger failure'); END;`);
    expect(() => runSessionDatabaseIdentityMigration(db)).toThrow(
      "injected identity ledger failure",
    );
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='zcode_database_identity'").get(),
    ).toBeUndefined();
    expect(db.prepare("SELECT * FROM schema_migration").all()).toEqual([]);
    db.exec("DROP TRIGGER reject_identity");
    runSessionDatabaseIdentityMigration(db);
    db.exec("UPDATE schema_migration SET checksum='broken'");
    expect(() => runSessionDatabaseIdentityMigration(db)).toThrow(/checksum mismatch/);
    await expect(runSqliteSessionMigrations(db, ":memory:")).rejects.toThrow(/checksum mismatch/);
    // Agent 更早的迁移也在同一事务内回滚，损坏记录不会被覆盖。
    expect(db.prepare("SELECT id, checksum FROM schema_migration").all()).toEqual([
      { id: "0024_session_database_identity", checksum: "broken" },
    ]);
  } finally {
    db.close();
  }
});

it("Agent 正式迁移接管已有 Source identity，不覆盖代际且重复打开不改账本", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE zcode_database_identity (scope TEXT PRIMARY KEY, identity TEXT NOT NULL);
      INSERT INTO zcode_database_identity VALUES ('session', 'existing-generation')`);
    await runSqliteSessionMigrations(db, ":memory:");
    expect(
      db.prepare("SELECT id FROM schema_migration WHERE id='0024_session_database_identity'").get(),
    ).toEqual({
      id: "0024_session_database_identity",
    });
    const ledger = db.prepare("SELECT * FROM schema_migration ORDER BY id").all();
    await runSqliteSessionMigrations(db, ":memory:");
    expect(db.prepare("SELECT * FROM schema_migration ORDER BY id").all()).toEqual(ledger);
    expect(db.prepare("SELECT identity FROM zcode_database_identity").get()).toEqual({
      identity: "existing-generation",
    });
  } finally {
    db.close();
  }
});

it("Agent/Source 共用应用原语，identity SQL 成功但记账失败时保留真实执行数量", async () => {
  const db = new DatabaseSync(":memory:");
  const states: SqliteMigrationProgress[] = [];
  try {
    await expect(
      runSqliteSessionMigrationsAsync(db, ":memory:", {
        onProgress: async (state) => {
          states.push(state);
          if (
            state.phase === "migrating" &&
            state.migrationId === "0024_session_database_identity"
          ) {
            db.exec(`CREATE TRIGGER reject_identity BEFORE INSERT ON schema_migration
              WHEN NEW.id='0024_session_database_identity'
              BEGIN SELECT RAISE(ABORT, 'injected identity ledger failure'); END;`);
          }
        },
      }),
    ).rejects.toMatchObject({ kind: "sql_failed", migrationId: "0024_session_database_identity" });
    expect(states.at(-1)).toMatchObject({
      phase: "failed",
      migration: { kind: "initialize", executedCount: 24, committedCount: 0 },
    });
    expect(db.isTransaction).toBe(false);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='zcode_database_identity'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migration'").get(),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});
