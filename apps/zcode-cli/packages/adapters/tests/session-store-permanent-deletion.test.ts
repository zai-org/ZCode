import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";
import { sqliteMigrations, type MigrationOptions } from "@zcode/shared/sqlite-migrations";
import type { SessionId } from "@zcode/contracts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("永久删除迁移兼容", () => {
  const migrationId = "0025_session_permanent_deletion";
  // 固定已发布 SQL 的摘要，防止测试夹具随实现一起变化而漏掉旧库 checksum 不兼容。
  const publishedChecksum = "608f3ea3aad458679a4b377968413575749f2231c88133765a088564fc20691e";

  function contentHashes(db: DatabaseSync) {
    return Object.fromEntries(
      db
        .prepare(
          "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name!='schema_migration' order by name",
        )
        .all()
        .map(({ name }) => {
          if (typeof name !== "string") throw new Error("Invalid table name");
          const rows = db.prepare(`select * from "${name.replaceAll('"', '""')}"`).all();
          return [
            name,
            createHash("sha256")
              .update(JSON.stringify(rows.map((row) => JSON.stringify(row)).sort()))
              .digest("hex"),
          ];
        }),
    );
  }

  async function legacyFixture() {
    const root = await mkdtemp(join(tmpdir(), "permanent-delete-migration-"));
    roots.push(root);
    const db = new DatabaseSync(join(root, "db.sqlite"));
    const options = {
      database: "cli",
      appliedAtColumn: "time_applied",
      backupDirectories: [join(root, "backup")],
    } satisfies MigrationOptions;
    try {
      // 旧版 025 直接执行 SQL；夹具必须绕过新增 apply，真实模拟已升级的数据库。
      await sqliteMigrations.migrate(
        db,
        SQLITE_MIGRATIONS.map((migration) =>
          migration.id === migrationId ? { ...migration, apply: undefined } : migration,
        ),
        options,
      );
      expect(
        db.prepare("select checksum from schema_migration where id=?").get(migrationId)?.checksum,
      ).toBe(publishedChecksum);
      db.exec(`
        insert into session(id,project_id,slug,directory,title,version,time_created,time_updated)
          values('kept','project','kept','/work/example','保留会话','1',1,1);
        insert into message(id,session_id,time_created,time_updated,data)
          values('message','kept',1,1,'{"text":"保留正文"}');
        insert into session_purge values('deleting','deleting','operation','["artifact"]','/work/example',null,'deleting');
        insert into session_purge values('deleted','deleted','operation','[]','/work/example',null,'deleted');
        insert into session_runtime_presence values('kept','owner',123);
      `);
      return { db, options };
    } catch (error) {
      db.close();
      throw error;
    }
  }

  it("已按旧 SQL 记账的数据库跳过 025，保留账本和全部数据", async () => {
    const { db, options } = await legacyFixture();
    try {
      const before = contentHashes(db);
      const journal = db.prepare("select * from schema_migration order by id").all();
      expect((await sqliteMigrations.migrate(db, SQLITE_MIGRATIONS, options)).applied).toEqual([]);
      expect(contentHashes(db)).toEqual(before);
      expect(db.prepare("select * from schema_migration order by id").all()).toEqual(journal);
    } finally {
      db.close();
    }
  });

  it.each([
    { name: "尚无 025 结构", keep: [] },
    { name: "只有删除凭据表", keep: ["session_purge"] },
    { name: "只有运行态表", keep: ["session_runtime_presence"] },
    {
      name: "已有两表及部分触发器",
      keep: ["session_purge", "session_runtime_presence", "session_purge_insert_guard"],
    },
    { name: "已有完整结构", keep: null },
  ])("未记账且$name时补齐结构，保留数据并恢复写入保护", async ({ keep }) => {
    const { db, options } = await legacyFixture();
    try {
      const schema = () =>
        db
          .prepare(
            "select type,name,tbl_name,sql from sqlite_master where sql is not null order by name",
          )
          .all();
      const expectedSchema = schema();
      if (keep) {
        const objects = db
          .prepare(
            "select type,name from sqlite_master where sql is not null and (name glob 'session_purge*' or name='session_runtime_presence') order by type='table',name",
          )
          .all();
        for (const { type, name } of objects) {
          if (typeof type !== "string" || typeof name !== "string")
            throw new Error("Invalid schema object");
          if (!keep.includes(name)) db.exec(`drop ${type} "${name}"`);
        }
      }
      db.prepare("delete from schema_migration where id=?").run(migrationId);
      const emptyHash = createHash("sha256").update("[]").digest("hex");
      const expectedContents = {
        session_purge: emptyHash,
        session_runtime_presence: emptyHash,
        ...contentHashes(db),
      };
      expect((await sqliteMigrations.migrate(db, SQLITE_MIGRATIONS, options)).applied).toEqual([
        migrationId,
      ]);
      expect(schema()).toEqual(expectedSchema);
      expect(contentHashes(db)).toEqual(expectedContents);
      expect(
        db.prepare("select checksum from schema_migration where id=?").get(migrationId)?.checksum,
      ).toBe(publishedChecksum);
      db.exec(
        "insert or ignore into session_purge values('deleted','deleted','operation','[]','/work/example',null,'deleted')",
      );
      expect(() =>
        db.exec("insert into session_runtime_presence values('deleted','owner',123)"),
      ).toThrow("session-data.deleting");
      expect(() =>
        db.exec(
          "insert into message(id,session_id,time_created,time_updated,data) values('late','deleted',1,1,'{}')",
        ),
      ).toThrow("session-data.deleting");
      const journal = db.prepare("select * from schema_migration order by id").all();
      expect((await sqliteMigrations.migrate(db, SQLITE_MIGRATIONS, options)).applied).toEqual([]);
      expect(db.prepare("select * from schema_migration order by id").all()).toEqual(journal);
    } finally {
      db.close();
    }
  });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "permanent-delete-"));
  roots.push(root);
  const store = await SqliteSessionStore.open({ dbPath: join(root, "db.sqlite") });
  const session = (id: string, parentID?: string, taskType = "interactive") =>
    store.createSession({
      id: id as SessionId,
      projectID: "project" as never,
      slug: id,
      directory: "/work/example",
      title: id,
      version: "1",
      parentID: parentID as SessionId | undefined,
      taskType: taskType as never,
    });
  await session("root");
  await session("child", "root", "subagent_child");
  await session("fork", "root", "fork");
  return { store, session };
}
describe("永久删除存储", () => {
  it("准入凭据阻止重建和运行态注册，删除 owned tree 但保留独立 fork", async () => {
    const { store, session } = await setup();
    try {
      const preview = await store.inspectSessionDeletion("root" as SessionId);
      expect(preview.sessionIds.sort()).toEqual(["child", "root"]);
      expect(preview.forks.map((f) => f.sessionId)).toEqual(["fork"]);
      await store.beginSessionDeletion("root" as SessionId, preview.revision, "operation", []);
      await expect(store.registerSessionRuntime("root" as SessionId)).rejects.toThrow(
        "session-data.deleting",
      );
      await store.completeSessionDeletion("root" as SessionId);
      expect(await store.getSession("root" as SessionId)).toBeNull();
      expect(await store.getSession("child" as SessionId)).toBeNull();
      expect(await store.getSession("fork" as SessionId)).not.toBeNull();
      await expect(session("root")).rejects.toThrow("session-data.deleting");
      await store.completeSessionDeletion("root" as SessionId);
    } finally {
      store.close();
    }
  });
  it("确认后出现新子会话时不接受旧计划", async () => {
    const { store, session } = await setup();
    try {
      const preview = await store.inspectSessionDeletion("root" as SessionId);
      await session("newchild", "root", "subagent_child");
      await expect(
        store.beginSessionDeletion("root" as SessionId, preview.revision, "operation", []),
      ).rejects.toThrow("session-data.changed");
      expect(await store.getSession("root" as SessionId)).not.toBeNull();
    } finally {
      store.close();
    }
  });
});
