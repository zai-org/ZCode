import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";
import { inspectSessionDeletions } from "../src/storage/session-store/repositories/sessions.js";
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

/** 只统计引用扫描 SQL（含 zcode-artifact:// 的 13 条），其余 prepare 原样透传。 */
function countingReferenceScans(db: DatabaseSync) {
  const counter = { scans: 0 };
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (sql.includes("zcode-artifact://")) counter.scans++;
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, counter };
}

describe("批量删除预检", () => {
  async function batchSetup() {
    const root = await mkdtemp(join(tmpdir(), "permanent-delete-batch-"));
    roots.push(root);
    const dbPath = join(root, "db.sqlite");
    const store = await SqliteSessionStore.open({ dbPath });
    const db = new DatabaseSync(dbPath);
    const session = (id: string, parentID?: string, taskType = "interactive") =>
      store.createSession({
        id: id as SessionId,
        projectID: "project" as never,
        slug: id,
        directory: "/work/example",
        title: `标题-${id}`,
        version: "1",
        parentID: parentID as SessionId | undefined,
        taskType: taskType as never,
      });
    let seq = 0;
    const part = (sessionId: string, url: string) => {
      const id = `ref-${seq++}`;
      db.prepare(
        "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,1,1,'{}')",
      ).run(`${id}-m`, sessionId);
      db.prepare(
        "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,1,1,?)",
      ).run(id, `${id}-m`, sessionId, JSON.stringify({ url }));
    };
    return {
      store,
      db,
      session,
      part,
      close: () => {
        db.close();
        store.close();
      },
    };
  }

  it("批量与逐个预检结果完全一致：跨根引用、树内引用、fork、工作流 journal 与续删回执", async () => {
    const { store, db, session, part, close } = await batchSetup();
    try {
      await session("a");
      await session("a-child", "a", "subagent_child");
      await session("a-fork", "a", "fork");
      await session("b");
      await session("c");
      await session("d");
      await session("kept");
      // a 的产物被同批 b 引用：以 a 的视角 b 在树外，必须算外部引用。
      part("b", "zcode-artifact://a/shared");
      // 同一树内的引用随根删除，不算外部引用。
      part("a-child", "zcode-artifact://a/private");
      // b 的产物被 a 的附属会话引用；fork 也引用 a。
      part("a-child", "zcode-artifact://b/report");
      part("a-fork", "zcode-artifact://a/shared");
      // c 的产物只出现在保留会话的工作流 journal 里。
      db.exec(`INSERT INTO dwf_run(id,parent_session_id,caps_max_concurrency,status,time_created,time_updated) VALUES('run','kept',1,'completed',1,1);
        INSERT INTO dwf_event(run_id,sequence,type,payload_json,time_created) VALUES('run',1,'artifact','{"uri":"zcode-artifact://c/chart"}',1);`);
      // d 已进入删除中：回执里保留的附件即使没有引用方也要出现在 references。
      const fresh = await store.inspectSessionDeletion("d" as SessionId);
      await store.beginSessionDeletion("d" as SessionId, fresh.revision, "op", [
        { sessionId: "d" as SessionId, artifactId: "kept-file" },
      ]);
      const ids = ["a", "b", "c", "d", "missing"] as SessionId[];
      const single = [];
      for (const id of ids) single.push(await store.inspectSessionDeletion(id));
      const batch = await store.inspectSessionDeletions(ids.map((sessionId) => ({ sessionId })));
      expect(batch).toEqual(single);
      expect(batch[0]!.forks.map((fork) => fork.sessionId)).toEqual(["a-fork"]);
      expect(batch[0]!.references).toEqual([
        {
          sessionId: "a",
          artifactId: "shared",
          referrers: [
            { sessionId: "a-fork", title: "标题-a-fork" },
            { sessionId: "b", title: "标题-b" },
          ],
        },
      ]);
      expect(batch[1]!.references.map((ref) => ref.referrers[0]!.sessionId)).toEqual(["a-child"]);
      expect(batch[2]!.references.map((ref) => ref.referrers[0]!.sessionId)).toEqual(["kept"]);
      expect(batch[3]).toMatchObject({
        deleting: true,
        references: [{ sessionId: "d", artifactId: "kept-file", referrers: [] }],
      });
      expect(batch[4]!.sessionIds).toEqual([]);
      // 扫描判定相同时，批量与逐个结果也一致；回执里有保留附件的根仍会扫描。
      const flags = ids.map((sessionId, index) => ({
        sessionId,
        scanArtifactReferences: index % 2 === 0,
      }));
      const singleFlags = [];
      for (const target of flags)
        singleFlags.push(
          await store.inspectSessionDeletion(target.sessionId, {
            scanArtifactReferences: target.scanArtifactReferences,
          }),
        );
      expect(await store.inspectSessionDeletions(flags)).toEqual(singleFlags);
      // 重复目标各自独立计算。
      expect(
        await store.inspectSessionDeletions([
          { sessionId: "a" as SessionId },
          { sessionId: "a" as SessionId },
        ]),
      ).toEqual([single[0], single[0]]);
    } finally {
      close();
    }
  });

  it("无产物的根不执行引用扫描；写锁内复检沿用同一判定", async () => {
    const { store, db, session, part, close } = await batchSetup();
    try {
      await session("a");
      await session("b");
      part("b", "zcode-artifact://a/lost");
      const counted = countingReferenceScans(db);
      const skipped = inspectSessionDeletions(
        counted.db,
        [
          { root: "a" as SessionId, scanArtifactReferences: false },
          { root: "b" as SessionId, scanArtifactReferences: false },
        ],
        "owner",
      );
      expect(counted.counter.scans).toBe(0);
      // 产物文件不存在时不再列入保留附件（规格：只对实际存在产物文件的会话扫描）。
      expect(skipped[0]!.references).toEqual([]);
      const scanned = inspectSessionDeletions(counted.db, [{ root: "a" as SessionId }], "owner");
      expect(counted.counter.scans).toBe(13);
      expect(scanned[0]!.references.map((ref) => ref.artifactId)).toEqual(["lost"]);
      // 预检用 false 得到的 revision，写锁内必须用同一判定才能通过；用不同判定会被视为清单变化。
      await expect(
        store.beginSessionDeletion("a" as SessionId, skipped[0]!.revision, "op", []),
      ).rejects.toThrow("session-data.changed");
      await store.beginSessionDeletion("a" as SessionId, skipped[0]!.revision, "op", [], {
        scanArtifactReferences: false,
      });
      expect((await store.inspectSessionDeletion("a" as SessionId)).deleting).toBe(true);
    } finally {
      close();
    }
  });

  it("300 个会话整批只跑一轮引用 SQL，结果与逐个一致", async () => {
    const { store, db, session, part, close } = await batchSetup();
    try {
      const ids: SessionId[] = [];
      for (let index = 0; index < 300; index++) {
        const id = `s${String(index).padStart(3, "0")}`;
        await session(id);
        ids.push(id as SessionId);
      }
      // 每个会话引用下一个会话的产物，形成跨根引用链。
      for (let index = 0; index < 300; index++)
        part(ids[index]!, `zcode-artifact://${ids[(index + 1) % 300]}/file-${index}`);
      const counted = countingReferenceScans(db);
      let started = performance.now();
      const single = ids.map(
        (root) => inspectSessionDeletions(counted.db, [{ root }], "owner")[0]!,
      );
      const singleMs = performance.now() - started;
      expect(counted.counter.scans).toBe(300 * 13);
      counted.counter.scans = 0;
      started = performance.now();
      const batch = inspectSessionDeletions(
        counted.db,
        ids.map((root) => ({ root })),
        "owner",
      );
      const batchMs = performance.now() - started;
      expect(counted.counter.scans).toBe(13);
      expect(batch).toEqual(single);
      expect(batch[1]!.references[0]!.referrers).toEqual([
        { sessionId: "s000", title: "标题-s000" },
      ]);
      // 耗时只做记录，不作断言。
      console.info(
        `[permanent-deletion] 300 根逐个 ${singleMs.toFixed(1)}ms，整批 ${batchMs.toFixed(1)}ms`,
      );
    } finally {
      close();
    }
  });
});
