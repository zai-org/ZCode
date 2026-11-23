import {
  applySqliteSchemaMigration,
  ensureSqliteSchemaMigrationTable,
} from "@zcode/shared/sqlite-migrations";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";
/**
 * SQLite 版 JournalStorePort（dwf_* 表）的测试。
 *
 * 两层：共享契约套件（与内存实现同一份，来自 `@zcode/dynamic-workflow/testing`）+
 * 内存实现根本表达不了的 SQLite 专属语义——跨进程重开后记录还在、事件序号接着长、
 * run 删除级联清掉 actor/node/event。后者才是 roadmap step 8 的真正目的。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it, vi } from "vitest";
import type {
  ActorRecord,
  Caps,
  JournalStorePort,
  NodeRecord,
  RunRecord,
} from "@zcode/dynamic-workflow";
import { runJournalStoreContract } from "@zcode/dynamic-workflow/testing";
import type { DwfRunIntrospectionQueries, DwfRunSessionListItem } from "../src/storage/index.js";
import { createDwfJournalStore, createSqliteSessionStore } from "../src/storage/index.js";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";

const openDatabases: DatabaseSync[] = [];

/** 每次调用开一个全新的已迁移库；契约套件要求实现之间互不共享状态。 */
function openJournalDb(dbPath = ":memory:"): { db: DatabaseSync; journal: JournalStorePort } {
  const db = new DatabaseSync(dbPath);
  openDatabases.push(db);
  // Journal 同步工厂只装载冻结 schema；异步启动、备份与锁由迁移专用测试验证。
  db.exec("BEGIN IMMEDIATE");
  ensureSqliteSchemaMigrationTable(db);
  for (const migration of SQLITE_MIGRATIONS) applySqliteSchemaMigration(db, migration);
  db.exec("COMMIT");
  return { db, journal: createDwfJournalStore(db) };
}

afterAll(() => {
  for (const db of openDatabases) {
    try {
      db.close();
    } catch {
      // 测试用库；关闭失败不该掩盖真正的断言失败。
    }
  }
});

runJournalStoreContract(() => openJournalDb().journal);

const CAPS: Caps = { maxConcurrency: 4 };

const RUN: RunRecord = {
  runId: "dwf_run_1",
  parentSessionId: "ses_parent",
  cwd: "/repo",
  scriptText: "const planner = agent('planner');",
  scriptHash: "sha-1",
  caps: CAPS,
  spentTokens: 0,
  status: "running",
};

const ACTOR: ActorRecord = {
  runId: RUN.runId,
  siteId: "actor#1",
  ordinal: 1,
  name: "planner",
  persona: { name: "planner", system: "plan carefully" },
  sessionId: "ses_actor",
  // 冻结的 persona 与子代理实际跑的模型分列存放，两者都必须跨重开存活。
  resolvedModel: "anthropic/haiku",
};

const NODE: NodeRecord = {
  runId: RUN.runId,
  siteId: "ask#1",
  ordinal: 1,
  kind: "ask",
  actorSiteId: "actor#1",
  actorOrdinal: 1,
  actorSeq: 0,
  inputHash: "abc123",
  status: "completed",
  result: { plan: ["step one", "step two"], nested: { depth: 2 } },
  stats: { tokens: 120, toolCalls: 2, turns: 1 },
};

describe("SQLite dwf journal store", () => {
  it("survives closing and reopening the database file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-journal-"));
    const dbPath = join(tempRoot, "session.sqlite");

    try {
      const first = await createSqliteSessionStore({ dbPath });
      const journal = first.workflowJournalStore();
      journal.createRun(RUN);
      journal.putActor(ACTOR);
      journal.putNode(NODE);
      journal.appendEvent(RUN.runId, { type: "run-started", runId: RUN.runId, caps: CAPS });
      journal.appendEvent(RUN.runId, { type: "log", message: "before the crash" });
      // 结算前最后一次用量回写：resume 必须看到它，而不是从零重来。
      journal.updateRunUsage(RUN.runId, 120);
      first.close();

      const second = await createSqliteSessionStore({ dbPath });
      const resumed = second.workflowJournalStore();

      expect(resumed.getRun(RUN.runId)).toEqual({ ...RUN, spentTokens: 120 });
      expect(resumed.getActor(RUN.runId, "actor#1", 1)).toEqual(ACTOR);
      expect(resumed.getNode(RUN.runId, "ask#1", 1)).toEqual(NODE);
      expect(resumed.listActors(RUN.runId, { withPersona: true })).toEqual([ACTOR]);
      expect(resumed.listNodes(RUN.runId, { kinds: "all", withResult: true })).toEqual([NODE]);
      expect(
        resumed.listEvents(RUN.runId, { types: "all", reportItems: "all" }).map((e) => e.sequence),
      ).toEqual([0, 1]);

      // 事件序号跨重开继续增长（engine-assigned、monotonic across resumes）。
      // 断言用 toMatchObject：追加还会带回写入时刻（StoredEvent.timeCreated），而这条用例
      // 说的是序号，不是时钟——时钟由契约套件的 timeCreated 用例钉住。
      expect(
        resumed.appendEvent(RUN.runId, { type: "log", message: "after resume" }),
      ).toMatchObject({
        sequence: 2,
        event: { type: "log", message: "after resume" },
      });
      expect(
        resumed.listEvents(RUN.runId, { types: "all", reportItems: "all" }).at(-1)?.event,
      ).toEqual({
        type: "log",
        message: "after resume",
      });
      second.close();
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  // `caps_max_concurrency` 的第二个写入者（docs/dynamic-workflow/concurrency.md
  // 「Two bounds on a run」）。契约套件已经钉住读写语义；这里钉的是内存实现表达不了的两件事：
  // UPDATE 真的只列了这一列（其余列逐字不动），以及新值跨进程重开还在——resume 沿用的正是它。
  it("retunes caps_max_concurrency in place, touching no other column", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-journal-caps-"));
    const dbPath = join(tempRoot, "session.sqlite");
    try {
      const first = await createSqliteSessionStore({ dbPath });
      const journal = first.workflowJournalStore();
      journal.createRun(RUN);
      journal.updateRunUsage(RUN.runId, 120);
      journal.updateRunCaps(RUN.runId, { maxConcurrency: 2 });

      // 同一个库里，除 caps 之外的每一列都还是建 run 时的那一份。
      expect(journal.getRun(RUN.runId)).toEqual({
        ...RUN,
        caps: { maxConcurrency: 2 },
        spentTokens: 120,
      });
      first.close();

      const second = await createSqliteSessionStore({ dbPath });
      expect(second.workflowJournalStore().getRun(RUN.runId)?.caps).toEqual({ maxConcurrency: 2 });
      second.close();
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("cascades a run delete to its actors, nodes and events", async () => {
    const { db, journal } = openJournalDb();
    journal.createRun(RUN);
    journal.createRun({ ...RUN, runId: "dwf_run_2" });
    journal.putActor(ACTOR);
    journal.putNode(NODE);
    journal.appendEvent(RUN.runId, { type: "log", message: "doomed" });
    journal.putActor({ ...ACTOR, runId: "dwf_run_2" });

    db.prepare("delete from dwf_run where id = ?").run(RUN.runId);

    expect(journal.getRun(RUN.runId)).toBeUndefined();
    expect(journal.listActors(RUN.runId, { withPersona: true })).toEqual([]);
    expect(journal.listNodes(RUN.runId, { kinds: "all", withResult: true })).toEqual([]);
    expect(journal.listEvents(RUN.runId, { types: "all", reportItems: "all" })).toEqual([]);
    // 级联只吃掉被删 run 的行。
    expect(journal.listActors("dwf_run_2", { withPersona: true })).toHaveLength(1);
  });

  it("rejects an actor belonging to no run", async () => {
    // FK 是开着的（migration runner 设 pragma foreign_keys = on），孤儿写入必须当场失败，
    // 而不是留下一条永远读不回来的记录。孤儿事件与 null/absent result 的语义已由共享契约
    // 套件在两个实现上一起把关，这里只补 FK 本身确实生效这一点。
    const { journal } = openJournalDb();
    expect(() => journal.putActor({ ...ACTOR, runId: "ghost" })).toThrow();
  });

  it("run 产物跨重开数据库文件存活", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-result-"));
    const dbPath = join(tempRoot, "session.sqlite");

    try {
      const first = await createSqliteSessionStore({ dbPath });
      const journal = first.workflowJournalStore();
      journal.createRun(RUN);
      journal.updateRunStatus(RUN.runId, "completed", {
        result: { report: "done", steps: [1, 2, 3] },
      });
      first.close();

      // 桌面实测 bug 的持久化面：进程一退，产物必须仍能从 journal 读回来。
      const second = await createSqliteSessionStore({ dbPath });
      const resumed = second.workflowJournalStore().getRun(RUN.runId);
      expect(resumed?.status).toBe("completed");
      expect(resumed?.result).toEqual({ report: "done", steps: [1, 2, 3] });
      second.close();
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("result_json 为 NULL 的旧行解码不炸且 result 缺席", async () => {
    // 0020 之前落库的 run 行：列是新加的、值为 NULL。decodeRun 必须回一条没有 result 键的
    // 记录，而不是 undefined 值或抛错——否则升级后所有历史 run 都读不出来。
    const { db, journal } = openJournalDb();
    journal.createRun(RUN);
    db.prepare("update dwf_run set result_json = null where id = ?").run(RUN.runId);

    const record = journal.getRun(RUN.runId);
    expect(record).toEqual(RUN);
    expect("result" in (record ?? {})).toBe(false);
  });

  it("resolved_model 为 NULL 的旧行解码不炸且 resolvedModel 缺席", async () => {
    // 0023 之前落库的 actor 行（以及宿主还没解析过的行）：必须解成没有 resolvedModel 键的
    // 记录，而不是 undefined 值或抛错。persona 里的档位与这一列各自独立缺席。
    const { db, journal } = openJournalDb();
    journal.createRun(RUN);
    journal.putActor(ACTOR);
    db.prepare("update dwf_actor set resolved_model = null where run_id = ?").run(RUN.runId);

    const record = journal.getActor(RUN.runId, "actor#1", 1);
    expect(record).toEqual({ ...ACTOR, resolvedModel: undefined });
    expect("resolvedModel" in (record ?? {})).toBe(false);
    // persona 仍在 persona_json 里：模型记录丢了不等于身份丢了。
    expect(record?.persona?.system).toBe("plan carefully");
  });

  it("同键重写只换 resolved_model，persona 与 session_id 原样保留", async () => {
    // 生产里这正是 driver 侧 `journalActorResolvedModel` 的读改写形状：putActor 是整条替换，
    // 所以「只更新解析结果」必须由调用方带齐其余字段，而存储层要如实照写。
    const { journal } = openJournalDb();
    journal.createRun(RUN);
    journal.putActor(ACTOR);
    journal.putActor({ ...ACTOR, resolvedModel: "anthropic/sonnet" });

    expect(journal.getActor(RUN.runId, "actor#1", 1)).toEqual({
      ...ACTOR,
      resolvedModel: "anthropic/sonnet",
    });
    expect(journal.listActors(RUN.runId, { withPersona: true })).toHaveLength(1);
  });

  it("终态与产物一笔写：单条 UPDATE 同时落 status 与 result_json", async () => {
    // 分两笔写会造出「completed 但产物丢失」的崩溃窗口，正是本列要关死的损失类别。
    const { db, journal } = openJournalDb();
    journal.createRun(RUN);
    journal.updateRunStatus(RUN.runId, "completed", { result: "artifact text" });

    const row = db
      .prepare("select status, result_json from dwf_run where id = ?")
      .get(RUN.runId) as { result_json: string | null; status: string } | undefined;
    expect(row?.status).toBe("completed");
    expect(row?.result_json).toBe(JSON.stringify("artifact text"));
  });

  it("CHECK 仍然拒绝一个不存在的 kind", async () => {
    // 重建 CHECK 的意义在于它**还在拦**：放开一个值不等于把闸门拆了。
    const { journal } = openJournalDb();
    journal.createRun(RUN);
    expect(() =>
      journal.putNode({
        runId: RUN.runId,
        siteId: "bogus#1",
        ordinal: 1,
        kind: "made-up" as NodeRecord["kind"],
        inputHash: "h",
        status: "completed",
      }),
    ).toThrow();
  });

  // `kind` 的 CHECK 含 'world-run'（world.run 的 journal 化命令执行，docs/dynamic-workflow/authoring.md）。
  it('dwf_node 接受 kind:"world-run" 并原样回读', async () => {
    const { journal } = openJournalDb();
    journal.createRun(RUN);
    const worldRun: NodeRecord = {
      runId: RUN.runId,
      siteId: "world-read#3",
      ordinal: 2,
      kind: "world-run",
      inputHash: "h-run",
      status: "completed",
      result: { exitCode: 1, stdout: "", stderr: "proof failed" },
    };
    journal.putNode(worldRun);
    expect(journal.getNode(RUN.runId, "world-read#3", 2)).toEqual(worldRun);
  });

  it("dwf_node 带 input_json 列：有界输入原样回读，ask 行缺席", async () => {
    // 工作区 transcript 的「what ran」（docs/dynamic-workflow/transcript-and-notifications.md）。
    const { db, journal } = openJournalDb();
    journal.createRun(RUN);
    const worldRun: NodeRecord = {
      runId: RUN.runId,
      siteId: "world-read#4",
      ordinal: 1,
      kind: "world-run",
      inputHash: "h-in",
      input: { op: "run", args: ["pnpm", ["vitest", "run", "--changed"], { timeoutMs: 60_000 }] },
      status: "running",
    };
    journal.putNode(worldRun);
    expect(journal.getNode(RUN.runId, "world-read#4", 1)).toEqual(worldRun);
    // 结算是整条 upsert：input 必须随行回来，而不是被抹成 NULL。
    const settled: NodeRecord = {
      ...worldRun,
      status: "completed",
      result: { exitCode: 1, stdout: "FAIL", stderr: "" },
    };
    journal.putNode(settled);
    expect(journal.getNode(RUN.runId, "world-read#4", 1)).toEqual(settled);
    const column = db
      .prepare("select input_json from dwf_node where site_id = ?")
      .get("world-read#4") as { input_json: string | null };
    expect(JSON.parse(column.input_json ?? "null")).toEqual(worldRun.input);
    journal.putNode(NODE);
    const ask = journal.getNode(RUN.runId, NODE.siteId, NODE.ordinal);
    expect(ask !== undefined && "input" in ask).toBe(false);
  });

  it("input_json 为 NULL 的旧行解码不炸且 input 缺席", async () => {
    const { db, journal } = openJournalDb();
    journal.createRun(RUN);
    db.prepare(
      `insert into dwf_node (run_id, site_id, ordinal, kind, input_hash, status, result_json, time_created, time_updated)
       values (?, ?, ?, 'world-read', 'h', 'completed', ?, 1, 2)`,
    ).run(RUN.runId, "world-read#9", 1, JSON.stringify("file body"));
    const row = journal.getNode(RUN.runId, "world-read#9", 1);
    expect(row).toBeDefined();
    expect(row !== undefined && "input" in row).toBe(false);
    expect(row?.result).toBe("file body");
  });

  it("listWorldNodes 只回 world-read / world-run 行，按落库先后，带时间戳与正文字节数、不带正文", async () => {
    const { journal } = openJournalDb();
    const queries = journal as unknown as DwfRunIntrospectionQueries;
    journal.createRun(RUN);
    journal.putNode(NODE);
    journal.putNode({
      runId: RUN.runId,
      siteId: "world-read#2",
      ordinal: 1,
      kind: "world-read",
      inputHash: "a",
      input: { op: "read", args: ["src/x.ts"] },
      status: "completed",
      result: "export const x = 1;\n",
    });
    journal.putNode({
      runId: RUN.runId,
      siteId: "world-read#3",
      ordinal: 1,
      kind: "world-run",
      inputHash: "b",
      input: { op: "run", args: ["lake", ["build"]] },
      status: "running",
    });
    journal.putNode({
      runId: RUN.runId,
      siteId: "report#1",
      ordinal: 1,
      kind: "report",
      inputHash: "r",
      status: "completed",
      result: { finding: "x" },
    });
    const rows = queries.listWorldNodes(RUN.runId);
    expect(rows.map((row) => row.siteId)).toEqual(["world-read#2", "world-read#3"]);
    expect(rows[0]).toMatchObject({
      kind: "world-read",
      status: "completed",
      input: { op: "read", args: ["src/x.ts"] },
      resultBytes: JSON.stringify("export const x = 1;\n").length,
    });
    expect("result" in rows[0]!).toBe(false);
    expect(typeof rows[0]!.timeCreated).toBe("number");
    expect(typeof rows[0]!.timeUpdated).toBe("number");
    expect("resultBytes" in rows[1]!).toBe(false);
    expect(queries.listWorldNodes("dwfrun-unknown")).toEqual([]);
  });

  it("listWorldNodes 用 SQLite 的 JSON 函数在库内算摘要：数组计数、run 的 exitCode 与输出字节数", async () => {
    const { journal } = openJournalDb();
    const queries = journal as unknown as DwfRunIntrospectionQueries;
    journal.createRun(RUN);
    journal.putNode({
      runId: RUN.runId,
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-read",
      inputHash: "g",
      input: { op: "glob", args: ["src/**/*.ts"] },
      status: "completed",
      result: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    journal.putNode({
      runId: RUN.runId,
      siteId: "world-read#2",
      ordinal: 1,
      kind: "world-run",
      inputHash: "r",
      input: { op: "run", args: ["pnpm", ["test"]] },
      status: "completed",
      result: { exitCode: 1, stdout: "ok\n", stderr: "é" },
    });
    journal.putNode({
      runId: RUN.runId,
      siteId: "world-read#3",
      ordinal: 1,
      kind: "world-read",
      inputHash: "s",
      input: { op: "git-status", args: [] },
      status: "completed",
      result: " M src/a.ts\n",
    });
    journal.putNode({
      runId: RUN.runId,
      siteId: "world-read#4",
      ordinal: 1,
      kind: "world-run",
      inputHash: "f",
      input: { op: "run", args: ["false"] },
      status: "failed",
      error: { code: "DriverError", message: "boom" },
    });
    const rows = queries.listWorldNodes(RUN.runId);
    expect(rows[0]).toMatchObject({ resultCount: 3 });
    expect("exitCode" in rows[0]!).toBe(false);
    // stderr 是一个双字节字符：报的是 UTF-8 字节数，不是字符数。
    expect(rows[1]).toMatchObject({ exitCode: 1, stdoutBytes: 3, stderrBytes: 2 });
    expect("resultCount" in rows[1]!).toBe(false);
    // 字符串正文：既不是数组也不是对象，摘要列全部缺席，只有字节数。
    expect(rows[2]).toMatchObject({ resultBytes: JSON.stringify(" M src/a.ts\n").length });
    expect("resultCount" in rows[2]!).toBe(false);
    expect("exitCode" in rows[2]!).toBe(false);
    // 失败行没有正文：什么摘要都没有，只有 error。
    expect(rows[3]).toMatchObject({
      status: "failed",
      error: { code: "DriverError", message: "boom" },
    });
    expect("resultBytes" in rows[3]!).toBe(false);
    expect("exitCode" in rows[3]!).toBe(false);
  });

  // dwf_event 上的表达式索引不只要存在，还得**真的被用上**：它存在的全部理由是让看板取数
  // 不必扫完一条长 run 的整张事件表（那是最大的一张表）。查询计划变了这里就会响。
  it("dwf_event 的表达式索引真的服务于按 artifactId 取事件", async () => {
    const { db } = openJournalDb();
    const plan = (
      db
        .prepare(
          `explain query plan
           select sequence from dwf_event
           where run_id = ? and type = 'report' and json_extract(payload_json, '$.artifactId') = ?
           order by sequence`,
        )
        .all("run_1", "perf") as unknown as { detail: string }[]
    )
      .map((row) => row.detail)
      .join(" | ");
    expect(plan).toContain("dwf_event_artifact_idx");
  });
});

/**
 * 孤儿收敛的窄查询。刻意**不在** `JournalStorePort` 上：引擎从不按父会话找 run，这条查询
 * 只服务于宿主侧的收敛（`bootstrap/src/app/dynamic-workflow-run-service.ts` 构造时按能力
 * 探测调用它）。内存实现不提供它，所以它的语义只能在这里、对着真库钉住。
 */
interface DwfNonTerminalRunQuery {
  listNonTerminalRuns(parentSessionId: string): RunRecord[];
}

/**
 * 开一个带窄查询的 journal。这里用与宿主侧**同一种**能力探测：方法名一旦漂移，宿主的收敛
 * 会静默跳过（回到「孤儿 run 永远 running」那个 bug），所以在这里就要大声失败。
 */
function openSweepableJournal(): JournalStorePort & DwfNonTerminalRunQuery {
  const { journal } = openJournalDb();
  if (typeof (journal as Partial<DwfNonTerminalRunQuery>).listNonTerminalRuns !== "function") {
    throw new Error("sqlite dwf journal 缺少 listNonTerminalRuns：宿主侧的孤儿收敛会静默跳过");
  }
  return journal as JournalStorePort & DwfNonTerminalRunQuery;
}

describe("SQLite dwf journal store — listNonTerminalRuns", () => {
  const PARENT = "ses_sweep_parent";

  /** 预置一行 dwf_run（只关心父会话与状态）。 */
  function seed(
    journal: JournalStorePort,
    input: { runId: string; status: RunRecord["status"]; parentSessionId?: string },
  ): void {
    journal.createRun({
      runId: input.runId,
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      caps: CAPS,
      spentTokens: 0,
      status: input.status,
    });
  }

  it("只回本父会话的非终态行", async () => {
    const journal = openSweepableJournal();
    seed(journal, { parentSessionId: PARENT, runId: "run_running", status: "running" });
    seed(journal, { parentSessionId: PARENT, runId: "run_pending", status: "pending" });
    seed(journal, { parentSessionId: PARENT, runId: "run_completed", status: "completed" });
    seed(journal, { parentSessionId: PARENT, runId: "run_errored", status: "errored" });
    seed(journal, { parentSessionId: PARENT, runId: "run_stopped", status: "stopped" });
    // 兄弟会话正在飞的 run 与父会话缺席的行都不属于本会话——查全了就会把它们标死。
    seed(journal, { parentSessionId: "ses_other", runId: "run_sibling", status: "running" });
    seed(journal, { runId: "run_parentless", status: "running" });

    const rows = journal.listNonTerminalRuns(PARENT);

    expect(rows.map((row) => row.runId).sort()).toEqual(["run_pending", "run_running"]);
    // 回的是完整 RunRecord（同一个 decodeRun），收敛策略据 status 判断，不需要二次查询。
    expect(rows.every((row) => row.parentSessionId === PARENT)).toBe(true);
    expect(rows.find((row) => row.runId === "run_running")?.status).toBe("running");
  });

  it("收敛写入之后同一个查询返回空（幂等的 SQL 侧依据）", async () => {
    const journal = openSweepableJournal();
    seed(journal, { parentSessionId: PARENT, runId: "run_orphan", status: "running" });

    journal.updateRunStatus("run_orphan", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owning process exited" },
    });

    expect(journal.listNonTerminalRuns(PARENT)).toEqual([]);
  });

  it("未知父会话返回空数组", async () => {
    const journal = openSweepableJournal();
    seed(journal, { parentSessionId: PARENT, runId: "run_running", status: "running" });

    expect(journal.listNonTerminalRuns("ses_never_seen")).toEqual([]);
  });
});

/**
 * run 内省（`ListWorkflowRuns` / `GetWorkflowRun`）的宿主侧查询面。与 listNonTerminalRuns
 * 同款处理：引擎从不枚举 run，所以这些方法不进领域 `JournalStorePort`，内存实现也不提供它们——
 * 它们的语义只能在这里、对着真库钉住（docs/dynamic-workflow/launch.md
 * 的「枚举查询归属」行）。
 */
function openIntrospectableJournal(): {
  db: DatabaseSync;
  journal: JournalStorePort & DwfRunIntrospectionQueries;
} {
  const { db, journal } = openJournalDb();
  // 与宿主侧**同一种**能力探测：方法名一旦漂移，两个工具会静默降级成「本会话没有这个能力」，
  // 所以在这里就要大声失败。
  for (const method of [
    "listRuns",
    "getRunRow",
    "countNodesByStatus",
    "listRecentLogEvents",
    "listArtifactRows",
    "listArtifactItems",
    "countTaggedReports",
    "listEventPage",
    "listRunLifeSpans",
  ] as const) {
    if (typeof (journal as Partial<DwfRunIntrospectionQueries>)[method] !== "function") {
      throw new Error(`sqlite dwf journal 缺少 ${method}：run 内省工具会静默不可用`);
    }
  }
  return { db, journal: journal as JournalStorePort & DwfRunIntrospectionQueries };
}

/**
 * 预置一行 dwf_run。`timeUpdated` 必须能被显式钉住：createRun 写的是 Date.now()，同毫秒内
 * 建的多个 run 会拿到相同的时间戳，倒序断言就无从谈起。
 */
function seedRun(
  db: DatabaseSync,
  journal: JournalStorePort,
  input: {
    args?: Record<string, unknown>;
    cwd?: string;
    name?: string;
    parentSessionId?: string;
    result?: unknown;
    runId: string;
    scriptText?: string;
    status?: RunRecord["status"];
    timeUpdated?: number;
  },
): void {
  journal.createRun({
    runId: input.runId,
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.args === undefined ? {} : { args: input.args }),
    ...(input.scriptText === undefined ? {} : { scriptText: input.scriptText }),
    caps: CAPS,
    spentTokens: 0,
    status: input.status ?? "running",
  });
  if (input.result !== undefined) {
    journal.updateRunStatus(input.runId, input.status ?? "completed", { result: input.result });
  }
  if (input.timeUpdated !== undefined) {
    db.prepare("update dwf_run set time_updated = ? where id = ?").run(
      input.timeUpdated,
      input.runId,
    );
  }
}

describe("SQLite dwf journal store — dwf_run.name 与 cwd 索引", () => {
  it("dwf_run 带 name 列，且 dwf_run_cwd_idx 的形状正对枚举查询", async () => {
    const { db } = openJournalDb();
    const columns = (
      db.prepare("select name from pragma_table_info('dwf_run')").all() as unknown as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(columns).toContain("name");

    // 索引列序就是查询形状（cwd 等值 + time_updated 排序）：顺序反了索引就只能扫。
    const indexed = (
      db.prepare("select name from pragma_index_info('dwf_run_cwd_idx')").all() as unknown as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(indexed).toEqual(["cwd", "time_updated"]);
  });

  it("name 为 NULL 的旧行解码不炸且 name 缺席", async () => {
    // 0021 之前落库的 run 行：列是新加的、值为 NULL（不做回填）。decodeRun 必须回一条没有
    // name 键的记录，否则升级后所有历史 run 都读不出来。
    const { db, journal } = openJournalDb();
    journal.createRun(RUN);
    db.prepare("update dwf_run set name = null where id = ?").run(RUN.runId);

    const record = journal.getRun(RUN.runId);
    expect(record).toEqual(RUN);
    expect("name" in (record ?? {})).toBe(false);
  });
});

describe("SQLite dwf journal store — 基线形状", () => {
  // docs/dynamic-workflow/authoring.md：预算构造整体移除。基线 0019 直接以终态建表，这里钉住
  // 「两列不存在、用量列叫 spent_tokens」，以及老形状的 run 记录经 store 读回时 caps 只剩 maxConcurrency。
  it("dwf_run 没有节点上限 / 预算列，用量列叫 spent_tokens", async () => {
    const { db } = openJournalDb();
    const columns = (db.prepare("pragma table_info(dwf_run)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).not.toContain("caps_max_nodes");
    expect(columns).not.toContain("caps_budget_total");
    expect(columns).not.toContain("budget_spent");
    expect(columns).toContain("spent_tokens");

    db.prepare(
      `insert into dwf_run (id, caps_max_concurrency, spent_tokens, status, time_created, time_updated)
       values ('run_legacy', 8, 4242, 'completed', 1, 2)`,
    ).run();
    const journal = createDwfJournalStore(db);
    expect(journal.getRun("run_legacy")).toEqual({
      runId: "run_legacy",
      caps: { maxConcurrency: 8 },
      spentTokens: 4242,
      status: "completed",
    });
  });
});

describe("SQLite dwf journal store — listRuns", () => {
  const CWD = "/repo/project";

  it("只回本 cwd 的 run，按 time_updated 倒序", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_old", cwd: CWD, timeUpdated: 1_000 });
    seedRun(db, journal, { runId: "run_new", cwd: CWD, timeUpdated: 3_000 });
    seedRun(db, journal, { runId: "run_mid", cwd: CWD, timeUpdated: 2_000 });
    // 他项目的 run 与没有 cwd 的行都不属于本项目：查全了就把别人的 run 摆到模型面前。
    seedRun(db, journal, { runId: "run_other", cwd: "/repo/elsewhere", timeUpdated: 9_000 });
    seedRun(db, journal, { runId: "run_cwdless", timeUpdated: 9_000 });

    const rows = journal.listRuns({ cwd: CWD, limit: 20 });
    expect(rows.map((row) => row.runId)).toEqual(["run_new", "run_mid", "run_old"]);
  });

  it("cwd 是字面匹配，不做路径规范化", async () => {
    // 与 submit 写入同源（context.workingDirectory 原样落库、原样查询）。在读侧单方面
    // 规范化只会造出单侧不匹配。
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: CWD });

    expect(journal.listRuns({ cwd: `${CWD}/`, limit: 20 })).toEqual([]);
    expect(journal.listRuns({ cwd: CWD, limit: 20 })).toHaveLength(1);
  });

  it("limit 只截最新的那几条", async () => {
    const { db, journal } = openIntrospectableJournal();
    for (let i = 0; i < 5; i++) {
      seedRun(db, journal, { runId: `run_${i}`, cwd: CWD, timeUpdated: 1_000 + i });
    }

    expect(journal.listRuns({ cwd: CWD, limit: 2 }).map((row) => row.runId)).toEqual([
      "run_4",
      "run_3",
    ]);
    // 超出条数不补空位；limit 0 是空页而不是全量（`limit -1` 那个 SQLite 惯用法不适用这里）。
    expect(journal.listRuns({ cwd: CWD, limit: 50 })).toHaveLength(5);
    expect(journal.listRuns({ cwd: CWD, limit: 0 })).toEqual([]);
  });

  it("statuses 过滤到给定子集", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_running", cwd: CWD, status: "running" });
    seedRun(db, journal, { runId: "run_pending", cwd: CWD, status: "pending" });
    seedRun(db, journal, { runId: "run_completed", cwd: CWD, status: "completed" });
    seedRun(db, journal, { runId: "run_errored", cwd: CWD, status: "errored" });

    expect(
      journal
        .listRuns({ cwd: CWD, limit: 20, statuses: ["running", "pending"] })
        .map((row) => row.runId)
        .sort(),
    ).toEqual(["run_pending", "run_running"]);
    expect(journal.listRuns({ cwd: CWD, limit: 20, statuses: ["stopped"] })).toEqual([]);
    // 空集合就是「不匹配任何状态」，不是「不过滤」——后者会把过滤器静默取消掉。
    expect(journal.listRuns({ cwd: CWD, limit: 20, statuses: [] })).toEqual([]);
  });

  it("name 过滤下推到 SQL，且与 statuses 可叠加（GUI 中枢按工作流名归属运行历史）", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_a1", cwd: CWD, name: "release-check", timeUpdated: 3 });
    seedRun(db, journal, { runId: "run_a2", cwd: CWD, name: "release-check", timeUpdated: 1 });
    seedRun(db, journal, { runId: "run_b", cwd: CWD, name: "port-driver", timeUpdated: 2 });
    seedRun(db, journal, { runId: "run_nameless", cwd: CWD, timeUpdated: 9 });
    seedRun(db, journal, {
      runId: "run_a_failed",
      cwd: CWD,
      name: "release-check",
      status: "errored",
      timeUpdated: 5,
    });

    expect(
      journal.listRuns({ cwd: CWD, limit: 20, name: "release-check" }).map((row) => row.runId),
    ).toEqual(["run_a_failed", "run_a1", "run_a2"]);
    expect(
      journal
        .listRuns({ cwd: CWD, limit: 20, name: "release-check", statuses: ["errored"] })
        .map((row) => row.runId),
    ).toEqual(["run_a_failed"]);
    // 名字是字面等值；不存在的名字回空页，而不是退回「不过滤」。
    expect(journal.listRuns({ cwd: CWD, limit: 20, name: "nope" })).toEqual([]);
    // 不带 name 时行为不变（nameless 行也在）。
    expect(journal.listRuns({ cwd: CWD, limit: 20 })).toHaveLength(5);
  });

  it("cwd 缺省即跨所有项目枚举（全局工作流的运行历史跨 cwd），行带 cwd", async () => {
    // 全局工作流在不同项目里被发起，dwf_run.cwd 记的是各自实际运行的项目。`workflows/runs`
    // 的全局变体不按 cwd 过滤，把该名字在所有项目里的历史一并取出，行带 cwd 供 GUI 标项目
    // （docs/dynamic-workflow/launch.md「Data path」）。
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, {
      runId: "run_a",
      cwd: "/repo/one",
      name: "deep-research",
      timeUpdated: 3,
    });
    seedRun(db, journal, {
      runId: "run_b",
      cwd: "/repo/two",
      name: "deep-research",
      timeUpdated: 2,
    });
    seedRun(db, journal, { runId: "run_c", cwd: "/repo/one", name: "other", timeUpdated: 5 });
    seedRun(db, journal, { runId: "run_cwdless", name: "deep-research", timeUpdated: 1 });

    const rows = journal.listRuns({ name: "deep-research", limit: 20 });
    // 跨两个 cwd + 没有 cwd 的行，按 time_updated 倒序；别的名字不进来。
    expect(rows.map((row) => row.runId)).toEqual(["run_a", "run_b", "run_cwdless"]);
    const byId = new Map(rows.map((row) => [row.runId, row]));
    expect(byId.get("run_a")?.cwd).toBe("/repo/one");
    expect(byId.get("run_b")?.cwd).toBe("/repo/two");
    // cwd 为 NULL 的行不带 cwd 键（新列不回填，缺席可分辨）。
    expect(byId.get("run_cwdless") !== undefined && "cwd" in (byId.get("run_cwdless") ?? {})).toBe(
      false,
    );

    // 给了 cwd 就仍只回本项目那份（与全局变体互斥，行为逐字不变）。
    expect(
      journal.listRuns({ cwd: "/repo/one", limit: 20, name: "deep-research" }).map((r) => r.runId),
    ).toEqual(["run_a"]);
  });

  it("枚举行带 args（实参是小 JSON 袋，中枢的运行历史要展示它）；无实参的行键缺席", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, {
      runId: "run_args",
      cwd: CWD,
      name: "release-check",
      args: { target: "packages/ui", skipTests: false },
    });
    seedRun(db, journal, { runId: "run_bare", cwd: CWD, name: "release-check" });

    const byId = new Map(journal.listRuns({ cwd: CWD, limit: 20 }).map((row) => [row.runId, row]));
    expect(byId.get("run_args")?.args).toEqual({ target: "packages/ui", skipTests: false });
    expect(byId.get("run_bare")).not.toHaveProperty("args");
  });

  it("空结果回空数组", async () => {
    const { journal } = openIntrospectableJournal();
    expect(journal.listRuns({ cwd: "/never/seen", limit: 20 })).toEqual([]);
  });

  it("每行带齐下游合成真相所需的字段，但不驮 result/failure", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, {
      runId: "run_1",
      cwd: CWD,
      name: "nightly triage",
      parentSessionId: "ses_owner",
      scriptText: "const planner = agent('planner');",
      status: "completed",
      result: { big: "artifact" },
      timeUpdated: 4_242,
    });

    const [row] = journal.listRuns({ cwd: CWD, limit: 20 });
    expect(row).toMatchObject({
      runId: "run_1",
      name: "nightly triage",
      // parentSessionId 是 ownedByThisSession / possiblyInterrupted 的判据，scriptText 是
      // label 兜底的原料——两者缺一，下游就只能再查一遍。
      parentSessionId: "ses_owner",
      cwd: CWD,
      scriptText: "const planner = agent('planner');",
      status: "completed",
      spentTokens: 0,
      caps: CAPS,
      timeUpdated: 4_242,
    });
    expect(typeof row?.timeCreated).toBe("number");
    // 列表刻意轻：产物可以很大，一页 50 行全解出来等于把整库产物读进内存。
    expect(row !== undefined && "result" in row).toBe(false);
    expect(row !== undefined && "failure" in row).toBe(false);
  });

  it("name 缺席的行不带 name 键", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: CWD, scriptText: "log('hi');" });

    const [row] = journal.listRuns({ cwd: CWD, limit: 20 });
    expect(row !== undefined && "name" in row).toBe(false);
  });
});

describe("SQLite dwf journal store — getRunRow", () => {
  it("回完整记录 + journal 时间戳", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, {
      runId: "run_1",
      cwd: "/repo",
      name: "named run",
      status: "completed",
      result: { report: "done" },
      timeUpdated: 5_000,
    });

    const row = journal.getRunRow("run_1");
    // 时间戳直读 journal：RunRecord 本身不带时间，而详情页要报 createdAt / updatedAt。
    expect(row).toMatchObject({
      runId: "run_1",
      name: "named run",
      status: "completed",
      result: { report: "done" },
      timeUpdated: 5_000,
    });
    expect(typeof row?.timeCreated).toBe("number");
  });

  it("未知 runId 回 undefined", async () => {
    const { journal } = openIntrospectableJournal();
    expect(journal.getRunRow("nope")).toBeUndefined();
  });
});

describe("SQLite dwf journal store — countNodesByStatus", () => {
  /** 落一个节点（只关心 status 与归属 run）。 */
  function seedNode(
    journal: JournalStorePort,
    runId: string,
    siteId: string,
    ordinal: number,
    status: NodeRecord["status"],
  ): void {
    journal.putNode({ runId, siteId, ordinal, kind: "ask", inputHash: "h", status });
  }

  it("按三态计数，且只数本 run 的节点", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedRun(db, journal, { runId: "run_2", cwd: "/repo" });
    seedNode(journal, "run_1", "ask#1", 1, "completed");
    seedNode(journal, "run_1", "ask#1", 2, "completed");
    seedNode(journal, "run_1", "ask#2", 1, "running");
    seedNode(journal, "run_1", "ask#3", 1, "failed");
    seedNode(journal, "run_2", "ask#1", 1, "completed");

    expect(journal.countNodesByStatus("run_1")).toEqual({ running: 1, completed: 2, failed: 1 });
  });

  it("无节点（含未知 run）回三个 0，而不是缺键", async () => {
    // 下游要拿它直接算 nodesObserved；缺键会让「还没有节点」和「没有这个 run」都变成 NaN。
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });

    expect(journal.countNodesByStatus("run_1")).toEqual({ running: 0, completed: 0, failed: 0 });
    expect(journal.countNodesByStatus("nope")).toEqual({ running: 0, completed: 0, failed: 0 });
  });
});

describe("SQLite dwf journal store — listRecentLogEvents", () => {
  it("只取 log 事件的末 N 条，按时序回", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    journal.appendEvent("run_1", { type: "run-started", runId: "run_1", caps: CAPS });
    for (const message of ["l0", "l1", "l2", "l3"]) {
      journal.appendEvent("run_1", { type: "log", message });
      journal.appendEvent("run_1", {
        type: "usage-updated",
        spentTokens: 10,
      });
    }

    const tail = journal.listRecentLogEvents("run_1", 3);
    // 末 N 条按 sequence desc 取、再反转回时序：全量读进内存再筛是这条查询存在的反面。
    expect(
      tail.map((e) => (e.event.type === "log" ? e.event.message : `<${e.event.type}>`)),
    ).toEqual(["l1", "l2", "l3"]);
    // 序号是 journal 的真序号（log 之间夹着别的事件，所以不连续），不是重新编号的下标——
    // 下游拿它定位「叙事走到哪」。
    expect(tail.map((e) => e.sequence)).toEqual([3, 5, 7]);
  });

  it("limit 超过条数时给出全部 log 事件", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    journal.appendEvent("run_1", { type: "log", message: "only" });
    journal.appendEvent("run_1", { type: "run-settled", status: "completed" });

    expect(journal.listRecentLogEvents("run_1", 20).map((e) => e.event.type)).toEqual(["log"]);
  });

  it("没有 log 事件（含未知 run、limit 0）回空数组", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    journal.appendEvent("run_1", { type: "run-started", runId: "run_1", caps: CAPS });

    expect(journal.listRecentLogEvents("run_1", 20)).toEqual([]);
    expect(journal.listRecentLogEvents("nope", 20)).toEqual([]);
    expect(journal.listRecentLogEvents("run_1", 0)).toEqual([]);
  });

  it("按 runId 隔离", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedRun(db, journal, { runId: "run_2", cwd: "/repo" });
    journal.appendEvent("run_1", { type: "log", message: "mine" });
    journal.appendEvent("run_2", { type: "log", message: "theirs" });

    expect(
      journal
        .listRecentLogEvents("run_1", 20)
        .map((e) => (e.event.type === "log" ? e.event.message : "")),
    ).toEqual(["mine"]);
  });
});

describe("SQLite dwf journal store — listRunsByParentSession", () => {
  const PARENT = "ses_enum_parent";

  interface DwfRunEnumerationQuery {
    listRunsByParentSession(parentSessionId: string, limit: number): DwfRunSessionListItem[];
  }

  /** 能力探测同宿主侧（supportsRunEnumeration）：方法名漂移要在这里先红。 */
  function openEnumerableJournal(): JournalStorePort & DwfRunEnumerationQuery {
    const { journal } = openJournalDb();
    if (
      typeof (journal as Partial<DwfRunEnumerationQuery>).listRunsByParentSession !== "function"
    ) {
      throw new Error(
        "sqlite dwf journal 缺少 listRunsByParentSession：UI 的重启后发现面会静默为空",
      );
    }
    return journal as JournalStorePort & DwfRunEnumerationQuery;
  }

  function seed(
    journal: JournalStorePort,
    input: {
      runId: string;
      status: RunRecord["status"];
      parentSessionId?: string;
      toolCallId?: string;
    },
  ): void {
    journal.createRun({
      runId: input.runId,
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      caps: CAPS,
      spentTokens: 0,
      status: input.status,
    });
  }

  it("只回本父会话的行，完整解码（含 toolCallId 与 failure）", async () => {
    const journal = openEnumerableJournal();
    seed(journal, {
      parentSessionId: PARENT,
      runId: "run_a",
      status: "stopped",
      toolCallId: "call-a",
    });
    seed(journal, { parentSessionId: PARENT, runId: "run_b", status: "completed" });
    seed(journal, { parentSessionId: "ses_other", runId: "run_sibling", status: "running" });
    seed(journal, { runId: "run_parentless", status: "running" });
    journal.updateRunStatus("run_b", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owning process exited" },
    });

    const rows = journal.listRunsByParentSession(PARENT, 10);

    expect(rows.map((row) => row.runId).sort()).toEqual(["run_a", "run_b"]);
    expect(rows.find((row) => row.runId === "run_a")?.toolCallId).toBe("call-a");
    // 逻辑词汇原样回来：stopped + reason + 结构化失败（物理层是 cancelled + 信封）。
    expect(rows.find((row) => row.runId === "run_a")).toMatchObject({
      status: "stopped",
      stopReason: "user",
    });
    expect(rows.find((row) => row.runId === "run_b")).toMatchObject({
      status: "stopped",
      stopReason: "interrupted",
      failure: { code: "Interrupted" },
    });
  });

  it("最近更新在前，limit 截断在最旧一侧", async () => {
    const journal = openEnumerableJournal();
    seed(journal, { parentSessionId: PARENT, runId: "run_old", status: "completed" });
    seed(journal, { parentSessionId: PARENT, runId: "run_mid", status: "completed" });
    seed(journal, { parentSessionId: PARENT, runId: "run_new", status: "running" });
    // 让 time_updated 真正拉开（同一毫秒内 createRun 会并列）：更新最老那行，使它变最新。
    await new Promise((resolve) => setTimeout(resolve, 5));
    journal.updateRunUsage("run_old", 42);

    const rows = journal.listRunsByParentSession(PARENT, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.runId).toBe("run_old"); // 刚被触碰过 → 最近更新
  });

  it("未知父会话返回空数组；limit 0 返回空", async () => {
    const journal = openEnumerableJournal();
    seed(journal, { parentSessionId: PARENT, runId: "run_a", status: "running" });
    expect(journal.listRunsByParentSession("ses_never_seen", 10)).toEqual([]);
    expect(journal.listRunsByParentSession(PARENT, 0)).toEqual([]);
  });

  // 窄投影：枚举面报 updatedAt，所以行必须带 journal 时间戳（`RunRecord` 自己不带时间）。
  it("行带 journal 时间戳（createdAt/updatedAt 的来源）", async () => {
    const journal = openEnumerableJournal();
    seed(journal, { parentSessionId: PARENT, runId: "run_timed", status: "running" });

    const [row] = journal.listRunsByParentSession(PARENT, 10);

    expect(typeof row?.timeCreated).toBe("number");
    expect(typeof row?.timeUpdated).toBe("number");
    expect(row?.timeUpdated).toBeGreaterThanOrEqual(row?.timeCreated ?? 0);
    // 元数据列齐全（标签派生要 name/scriptText，归属要 parentSessionId）。
    expect(row).toMatchObject({ parentSessionId: PARENT, runId: "run_timed", status: "running" });
  });

  /**
   * `result_json` **不进这条查询的 SQL**。
   *
   * 断言必须打在 SQL 上而不是解码结果上：`decodeRunListItem` 本来就不读 result_json，所以
   * 把 select 改回 `select *` 之后行为**完全不变**（行里照样没有 `result` 键），只有内存代价
   * 会悄悄回来——一页 run 把每个产物一起读进内存。行为断言在这里是个假哨兵，实测过。
   *
   * 反过来 `failure_json` 必须在 SQL 里：resumable 的谓词依赖 failure.code（见下一个用例）。
   */
  it("枚举查询的 SQL 取 failure_json 而不取 result_json", async () => {
    const db = new DatabaseSync(":memory:");
    openDatabases.push(db);
    await runSqliteSessionMigrations(db, ":memory:");
    const prepared: string[] = [];
    // prepare 的旁路记录器：只为了看见这条查询真正发出的列清单。
    const recordingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (sql: string) => {
            prepared.push(sql);
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseSync;
    const journal = createDwfJournalStore(recordingDb) as JournalStorePort & DwfRunEnumerationQuery;
    seed(journal, { parentSessionId: PARENT, runId: "run_a", status: "running" });

    // 只看枚举查询自己发的 SQL（建行/迁移的语句当然会提到 result_json）。
    prepared.length = 0;
    journal.listRunsByParentSession(PARENT, 10);
    const sql = prepared.join("\n");

    expect(sql).toContain("failure_json");
    expect(sql).not.toContain("result_json");
    expect(sql).not.toMatch(/select\s+\*/i);
  });

  /** failure 必须活过窄投影：Interrupted 是 resume 门认可的可恢复形态。 */
  it("窄投影仍解出 failure（resumable 谓词的输入）", async () => {
    const journal = openEnumerableJournal();
    seed(journal, { parentSessionId: PARENT, runId: "run_dead", status: "running" });
    journal.updateRunStatus("run_dead", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owning process exited" },
    });

    const [row] = journal.listRunsByParentSession(PARENT, 10);

    expect(row?.failure).toEqual({ code: "Interrupted", message: "owning process exited" });
    expect(row?.stopReason).toBe("interrupted");
  });
});

/**
 * 用户面产物的两条宿主查询（docs/dynamic-workflow/authoring.md「Journal rows and events」）。
 * ⚠ 这里的 artifact 是脚本发布给用户看的交付物，不是 `RunSettlement.artifact`（顶层返回值）。
 *
 * 两条都刻意**不在** `JournalStorePort` 上（同 `listRuns` 的论证：引擎不做的事不该进领域端口），
 * 所以它们的语义只能在这里、对着真库钉住——内存实现根本不提供它们。
 */
describe("SQLite dwf journal store — listArtifactRows", () => {
  /** 落一条产物行（发布或声明）。 */
  function seedArtifact(
    journal: JournalStorePort,
    runId: string,
    siteId: string,
    ordinal: number,
    artifactId: string,
    record: Record<string, unknown> | undefined,
  ): void {
    journal.putNode({
      runId,
      siteId,
      ordinal,
      kind: "artifact",
      inputHash: `${siteId}@${ordinal}`,
      status: record === undefined ? "failed" : "completed",
      ...(record === undefined
        ? { error: { code: "ArtifactSourceMissing" as const, message: "缺文件" } }
        : { result: record }),
      artifactId,
    });
  }

  it("只回本 run 的产物行，按落库先后", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedRun(db, journal, { runId: "run_2", cwd: "/repo" });

    // 交错发布：同一个 id 的行**不**天然连续，所以排序只能是落库先后（版本的先后就是它）。
    seedArtifact(journal, "run_1", "artifact#1", 1, "perf", {
      id: "perf",
      kind: "chart",
      version: 1,
    });
    seedArtifact(journal, "run_1", "artifact#2", 1, "book", {
      id: "book",
      kind: "file",
      version: 1,
      bytes: 10,
    });
    seedArtifact(journal, "run_1", "artifact#2", 2, "book", {
      id: "book",
      kind: "file",
      version: 2,
      bytes: 20,
    });
    // 标签 report 与普通节点都不是产物行——混进来，读面会把每个数据点当成一个交付物。
    journal.putNode({
      runId: "run_1",
      siteId: "report#1",
      ordinal: 1,
      kind: "report",
      inputHash: "r",
      status: "completed",
      result: { round: 1 },
      artifactId: "perf",
    });
    journal.putNode({
      runId: "run_1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "k",
      status: "completed",
    });
    // 别的 run 的产物：查全了就把别人的交付物摆到这个 run 的卡片区。
    seedArtifact(journal, "run_2", "artifact#1", 1, "other", {
      id: "other",
      kind: "markdown",
      version: 1,
    });

    const rows = journal.listArtifactRows("run_1");
    expect(rows.map((row) => [row.siteId, row.ordinal, row.artifactId])).toEqual([
      ["artifact#1", 1, "perf"],
      ["artifact#2", 1, "book"],
      ["artifact#2", 2, "book"],
    ]);
    expect(rows[2]?.result).toEqual({ id: "book", kind: "file", version: 2, bytes: 20 });
  });

  it("失败的发布照样在结果里（带 error、无 result）", async () => {
    // 筛掉失败行等于让一个用户可见的失败在每张表面上都不存在。
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedArtifact(journal, "run_1", "artifact#1", 1, "book", undefined);

    const [row] = journal.listArtifactRows("run_1");
    expect(row?.status).toBe("failed");
    expect(row?.artifactId).toBe("book");
    expect(row?.error).toEqual({ code: "ArtifactSourceMissing", message: "缺文件" });
    expect(row !== undefined && "result" in row).toBe(false);
  });

  it("无产物（含未知 run）回空数组", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    expect(journal.listArtifactRows("run_1")).toEqual([]);
    expect(journal.listArtifactRows("nope")).toEqual([]);
  });
});

describe("SQLite dwf journal store — countTaggedReports", () => {
  it("counts tagged report rows per artifact id in SQL, ignoring untagged rows, other kinds and other runs", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedRun(db, journal, { runId: "run_2", cwd: "/repo" });
    const put = (
      runId: string,
      siteId: string,
      ordinal: number,
      extra: Partial<NodeRecord>,
    ): void =>
      journal.putNode({
        runId,
        siteId,
        ordinal,
        kind: "report",
        inputHash: `${siteId}@${ordinal}`,
        status: "completed",
        result: { big: "x".repeat(1024) },
        ...extra,
      });
    put("run_1", "report#1", 1, { artifactId: "perf" });
    put("run_1", "report#1", 2, { artifactId: "perf" });
    put("run_1", "report#2", 1, { artifactId: "queue" });
    put("run_1", "report#3", 1, {}); // 未打标签
    put("run_1", "artifact#1", 1, { kind: "artifact", artifactId: "perf" }); // 产物行不算
    put("run_2", "report#1", 1, { artifactId: "perf" }); // 别的 run

    expect(journal.countTaggedReports("run_1")).toEqual(
      new Map([
        ["perf", 2],
        ["queue", 1],
      ]),
    );
    expect(journal.countTaggedReports("nope")).toEqual(new Map());
  });
});

describe("SQLite dwf journal store — listArtifactItems", () => {
  /** 足够大的字节界：只想测条数 / 游标 / 筛选的用例用它，让字节界不参与。 */
  const ANY_BYTES = 1 << 30;

  /** 追加一条标签 report 事件，回它拿到的 sequence。 */
  function seedTaggedReport(
    journal: JournalStorePort,
    runId: string,
    siteId: string,
    ordinal: number,
    item: unknown,
    artifactId?: string,
  ): number {
    return journal.appendEvent(runId, {
      type: "report",
      instance: { siteId, ordinal },
      item,
      ...(artifactId === undefined ? {} : { artifactId }),
    }).sequence;
  }

  it("按 sequence 升序回该 id 的条目，带站点坐标与原值", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    const s0 = seedTaggedReport(journal, "run_1", "report#1", 1, { round: 1 }, "perf");
    const s1 = seedTaggedReport(journal, "run_1", "report#1", 2, { round: 2 }, "perf");

    expect(journal.listArtifactItems("run_1", "perf", { limit: 10, maxBytes: ANY_BYTES })).toEqual({
      items: [
        { sequence: s0, siteId: "report#1", ordinal: 1, item: { round: 1 } },
        { sequence: s1, siteId: "report#1", ordinal: 2, item: { round: 2 } },
      ],
      hasMore: false,
    });
  });

  it("排除未打标签的 report、别的 id、别种事件与别的 run", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedRun(db, journal, { runId: "run_2", cwd: "/repo" });
    seedTaggedReport(journal, "run_1", "report#1", 1, { mine: true }, "perf");
    // 未打标签：payload 里根本没有 artifactId 键，SQL 的 `= ?` 不匹配 NULL。
    seedTaggedReport(journal, "run_1", "report#2", 1, { untagged: true });
    seedTaggedReport(journal, "run_1", "report#3", 1, { other: true }, "queue");
    // 别种事件：`artifact-published` 的 id 藏在嵌套的 `artifact.id` 里，不是顶层 artifactId；
    // 但 type 过滤才是这条不变式的守门人（明天别的事件可能带顶层 artifactId）。
    journal.appendEvent("run_1", {
      type: "artifact-published",
      instance: { siteId: "artifact#1", ordinal: 1 },
      artifact: { id: "perf", kind: "chart", version: 1 },
    });
    journal.appendEvent("run_1", { type: "log", message: "perf" });
    seedTaggedReport(journal, "run_2", "report#1", 1, { crossRun: true }, "perf");

    const page = journal.listArtifactItems("run_1", "perf", { limit: 10, maxBytes: ANY_BYTES });
    expect(page.items.map((entry) => entry.item)).toEqual([{ mine: true }]);
    expect(page.hasMore).toBe(false);
  });

  it("afterSequence 是严格大于的游标", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    const s0 = seedTaggedReport(journal, "run_1", "report#1", 1, 1, "perf");
    // 中间夹一条别的事件：游标是 journal 的全局 sequence，不是「第几条产物条目」。
    journal.appendEvent("run_1", { type: "log", message: "between" });
    const s1 = seedTaggedReport(journal, "run_1", "report#1", 2, 2, "perf");

    const after = (afterSequence: number) =>
      journal.listArtifactItems("run_1", "perf", { afterSequence, limit: 10, maxBytes: ANY_BYTES });
    expect(after(s0).items.map((entry) => entry.sequence)).toEqual([s1]);
    expect(after(s1)).toEqual({ items: [], hasMore: false });
  });

  it("limit 逐字兑现，hasMore 由存储层判定：页之后还有没有条目", async () => {
    // 存储层不加自己的天花板，也不要调用方多取一条来猜：页尾后面那一行存在与否就是 hasMore。
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    for (let round = 0; round < 5; round += 1) {
      seedTaggedReport(journal, "run_1", "report#1", round + 1, round, "perf");
    }
    const page = (limit: number) =>
      journal.listArtifactItems("run_1", "perf", { limit, maxBytes: ANY_BYTES });

    expect(page(2)).toMatchObject({ hasMore: true });
    expect(page(2).items.map((entry) => entry.item)).toEqual([0, 1]);
    expect(page(4).hasMore).toBe(true);
    // 恰好取尽：不报 hasMore（不会让看板白翻一页空的）。
    expect(page(5)).toMatchObject({ hasMore: false });
    expect(page(5).items).toHaveLength(5);
    expect(page(99).items).toHaveLength(5);
  });

  it("字节界：再加一条就超界时收尾并报 hasMore，第一条总是带上", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    const pad = "x".repeat(1000);
    for (let round = 0; round < 4; round += 1) {
      seedTaggedReport(journal, "run_1", "report#1", round + 1, { round, pad }, "perf");
    }
    // 每条载荷约 1.1 KB：2.5 KB 的界放得下两条、放不下第三条。
    const first = journal.listArtifactItems("run_1", "perf", { limit: 10, maxBytes: 2500 });
    expect(first.items.map((entry) => (entry.item as { round: number }).round)).toEqual([0, 1]);
    expect(first.hasMore).toBe(true);
    // 续拉从页尾接上，不重不漏。
    const rest = journal.listArtifactItems("run_1", "perf", {
      afterSequence: first.items.at(-1)!.sequence,
      limit: 10,
      maxBytes: 2500,
    });
    expect(rest.items.map((entry) => (entry.item as { round: number }).round)).toEqual([2, 3]);
    expect(rest.hasMore).toBe(false);
    // 一条就超过界：它自成一页（否则翻页永远卡在这一条上），后面的照样报 hasMore。
    const tiny = journal.listArtifactItems("run_1", "perf", { limit: 10, maxBytes: 10 });
    expect(tiny.items).toHaveLength(1);
    expect(tiny.hasMore).toBe(true);
  });

  it("limit ≤ 0 是空页，未知 run / 未知 id 同样", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedTaggedReport(journal, "run_1", "report#1", 1, { round: 1 }, "perf");
    const empty = { items: [], hasMore: false };

    expect(journal.listArtifactItems("run_1", "perf", { limit: 0, maxBytes: ANY_BYTES })).toEqual(
      empty,
    );
    expect(journal.listArtifactItems("run_1", "perf", { limit: -1, maxBytes: ANY_BYTES })).toEqual(
      empty,
    );
    expect(journal.listArtifactItems("run_1", "nope", { limit: 10, maxBytes: ANY_BYTES })).toEqual(
      empty,
    );
    expect(journal.listArtifactItems("nope", "perf", { limit: 10, maxBytes: ANY_BYTES })).toEqual(
      empty,
    );
  });

  it("条目原值原样回来：null、标量与数组都不被加工", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedTaggedReport(journal, "run_1", "report#1", 1, null, "perf");
    seedTaggedReport(journal, "run_1", "report#1", 2, "文本", "perf");
    seedTaggedReport(journal, "run_1", "report#1", 3, [1, { two: true }], "perf");

    const page = journal.listArtifactItems("run_1", "perf", { limit: 10, maxBytes: ANY_BYTES });
    expect(page.items.map((e) => e.item)).toEqual([null, "文本", [1, { two: true }]]);
  });
});

describe("SQLite dwf journal store — listArtifactItems with fields", () => {
  const FIELD_VALUE_BYTES = 4096;

  function seed(journal: JournalStorePort, runId: string, items: unknown[]): void {
    items.forEach((item, index) =>
      journal.appendEvent(runId, {
        type: "report",
        instance: { siteId: "report#1", ordinal: index + 1 },
        item,
        artifactId: "perf",
      }),
    );
  }

  function readFields(
    journal: JournalStorePort & DwfRunIntrospectionQueries,
    paths: string[],
    page: { limit?: number; maxBytes?: number; afterSequence?: number } = {},
  ) {
    return journal.listArtifactItems("run_1", "perf", {
      limit: page.limit ?? 10,
      maxBytes: page.maxBytes ?? 1 << 30,
      ...(page.afterSequence === undefined ? {} : { afterSequence: page.afterSequence }),
      fields: { paths, maxValueBytes: FIELD_VALUE_BYTES },
    });
  }

  it("回点名的字段、不回整条 item；JSON 的 null 在表里，走不通的路径不在", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seed(journal, "run_1", [
      { round: 1, ok: true, timing: { ms: 12.5 }, note: null, big: "x".repeat(99) },
    ]);

    const page = readFields(journal, [
      "round",
      "ok",
      "timing.ms",
      "note",
      "missing",
      "round.deeper",
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.items).toEqual([
      {
        sequence: expect.any(Number),
        siteId: "report#1",
        ordinal: 1,
        fields: { round: 1, ok: true, "timing.ms": 12.5, note: null },
      },
    ]);
    expect(page.items[0]).not.toHaveProperty("item");
  });

  it("像整数的段在数组上是下标、在对象上是键，与渲染器的路径规则相同", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seed(journal, "run_1", [
      {
        rows: [{ v: 1 }, { v: 2 }],
        byKey: { "0": "zero", "01": "zero-one" },
        empty: { "": { b: 7 } },
      },
    ]);

    const [entry] = readFields(journal, [
      "rows.1.v",
      "rows.01.v", // Number("01") = 1：数组上仍是下标 1
      "rows.5.v", // 越界
      "rows.x", // 数组上的非整数段
      "byKey.0",
      "byKey.01",
      "empty..b", // 空段是一个空键
    ]).items;
    expect(entry?.fields).toEqual({
      "rows.1.v": 2,
      "rows.01.v": 2,
      "byKey.0": "zero",
      "byKey.01": "zero-one",
      "empty..b": 7,
    });
  });

  it("键里带引号与反斜杠照样取得到", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seed(journal, "run_1", [{ 'say"hi': 1, "back\\slash": 2, 中文: 3 }]);

    const [entry] = readFields(journal, ['say"hi', "back\\slash", "中文"]).items;
    expect(entry?.fields).toEqual({ 'say"hi': 1, "back\\slash": 2, 中文: 3 });
  });

  it("超过值的字节上界的值回成截短的字符串，一个大值不会整段进 JavaScript", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seed(journal, "run_1", [
      { text: "y".repeat(10_000), list: Array.from({ length: 2000 }, (_v, i) => i) },
    ]);

    const [entry] = readFields(journal, ["text", "list"]).items;
    expect(entry?.fields?.text).toBe(`${"y".repeat(1000)}…`);
    const list = entry?.fields?.list as string;
    expect(typeof list).toBe("string");
    expect(list.startsWith("[0,1,2,3")).toBe(true);
    expect(list).toHaveLength(1001);
  });

  it("页按取出的字段值计字节：大 item 里只取一个小字段时一页装得下很多条", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seed(
      journal,
      "run_1",
      Array.from({ length: 5 }, (_v, round) => ({ round, pad: "z".repeat(50_000) })),
    );

    // 整条 item 每条 50 KB，但只取 round：5 条远在 1 KB 之内。
    const small = readFields(journal, ["round"], { maxBytes: 1000 });
    expect(small.items.map((entry) => entry.fields?.round)).toEqual([0, 1, 2, 3, 4]);
    expect(small.hasMore).toBe(false);
    // 取 pad（每条截短到约 1 KB）时，同样的 2.5 KB 只装得下两条，并报 hasMore。
    const padded = readFields(journal, ["pad"], { maxBytes: 2500 });
    expect(padded.items).toHaveLength(2);
    expect(padded.hasMore).toBe(true);
    // 条数界与游标照常。
    const limited = readFields(journal, ["round"], { limit: 2 });
    expect(limited.items.map((entry) => entry.fields?.round)).toEqual([0, 1]);
    expect(limited.hasMore).toBe(true);
    const rest = readFields(journal, ["round"], { afterSequence: limited.items[1]!.sequence });
    expect(rest.items.map((entry) => entry.fields?.round)).toEqual([2, 3, 4]);
  });
});

describe("SQLite dwf journal store — listEventPage", () => {
  it("全部类型、item 原样，按条数分页并判定 hasMore", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    journal.appendEvent("run_1", { type: "log", message: "a" });
    journal.appendEvent("run_1", {
      type: "report",
      instance: { siteId: "report#1", ordinal: 1 },
      item: { finding: 1 },
    });
    journal.appendEvent("run_1", { type: "log", message: "b" });
    const all = journal.listEvents("run_1", { types: "all", reportItems: "all" });

    const first = journal.listEventPage("run_1", { limit: 2, maxBytes: 1 << 30 });
    expect(first.events).toEqual(all.slice(0, 2));
    expect(first.hasMore).toBe(true);
    const rest = journal.listEventPage("run_1", {
      afterSequence: first.events.at(-1)!.sequence,
      limit: 2,
      maxBytes: 1 << 30,
    });
    expect(rest).toEqual({ events: all.slice(2), hasMore: false });
  });

  it("字节界同看板条目：带大 item 的事件让页提前收尾，但每页至少一条", async () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      journal.appendEvent("run_1", {
        type: "report",
        instance: { siteId: "report#1", ordinal },
        item: "y".repeat(4096),
      });
    }
    const seen: number[] = [];
    let cursor: number | undefined;
    for (;;) {
      const page = journal.listEventPage("run_1", {
        ...(cursor === undefined ? {} : { afterSequence: cursor }),
        limit: 500,
        maxBytes: 5000,
      });
      expect(page.events).toHaveLength(1);
      seen.push(...page.events.map((stored) => stored.sequence));
      cursor = page.events.at(-1)!.sequence;
      if (!page.hasMore) break;
    }
    expect(seen).toHaveLength(3);
  });
});

// ————————————————————————————————————————————————————————————————
// 零迁移终态编码（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「The journal」）：物理列仍是旧五值，
// 逻辑 `errored` / `stopped{reason}` 只活在编解码里。下面这张表就是 spec 里用户复核过的那张。
// ————————————————————————————————————————————————————————————————
describe("SqliteDwfJournalStore 终态编码（零迁移）", () => {
  const PARENT = "ses_terminal";

  function insertPhysicalRow(
    db: DatabaseSync,
    runId: string,
    status: string,
    failureJson: string | null,
    timeUpdated = 1,
  ): void {
    db.prepare(
      `insert into dwf_run (id, parent_session_id, cwd, caps_max_concurrency, spent_tokens, status,
         failure_json, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, PARENT, "/repo", 4, 0, status, failureJson, 1, timeUpdated);
  }

  it("历史行按表解码：cancelled→stopped(user)，failed+Interrupted→stopped(interrupted)，其余 failed→errored", async () => {
    const { db, journal } = openIntrospectableJournal();
    insertPhysicalRow(db, "old_pending", "pending", null);
    insertPhysicalRow(db, "old_running", "running", null);
    insertPhysicalRow(db, "old_completed", "completed", null);
    insertPhysicalRow(db, "old_cancelled", "cancelled", null);
    insertPhysicalRow(
      db,
      "old_interrupted",
      "failed",
      JSON.stringify({ code: "Interrupted", message: "owning process exited" }),
    );
    insertPhysicalRow(
      db,
      "old_provider_crash",
      "failed",
      JSON.stringify({
        code: "DriverError",
        message: "Subagent turn failed",
        modelFailureReason: "rate_limited",
      }),
    );
    insertPhysicalRow(
      db,
      "old_script_error",
      "failed",
      JSON.stringify({ code: "DriverError", message: "boom" }),
    );
    insertPhysicalRow(
      db,
      "old_cap",
      "failed",
      JSON.stringify({ code: "ReportCapExceeded", message: "over" }),
    );
    insertPhysicalRow(db, "old_failed_bare", "failed", null);

    const statusOf = (runId: string) => {
      const record = journal.getRun(runId)!;
      return { status: record.status, stopReason: record.stopReason, code: record.failure?.code };
    };
    expect(statusOf("old_pending")).toEqual({
      status: "pending",
      stopReason: undefined,
      code: undefined,
    });
    expect(statusOf("old_running")).toEqual({
      status: "running",
      stopReason: undefined,
      code: undefined,
    });
    expect(statusOf("old_completed")).toEqual({
      status: "completed",
      stopReason: undefined,
      code: undefined,
    });
    expect(statusOf("old_cancelled")).toEqual({
      status: "stopped",
      stopReason: "user",
      code: undefined,
    });
    expect(statusOf("old_interrupted")).toEqual({
      status: "stopped",
      stopReason: "interrupted",
      code: "Interrupted",
    });
    // 第 6 行（用户复核裁决）：老的 provider 崩溃仍是 errored，不可 resume。
    expect(statusOf("old_provider_crash")).toEqual({
      status: "errored",
      stopReason: undefined,
      code: "DriverError",
    });
    expect(statusOf("old_script_error")).toEqual({
      status: "errored",
      stopReason: undefined,
      code: "DriverError",
    });
    expect(statusOf("old_cap")).toEqual({
      status: "errored",
      stopReason: undefined,
      code: "ReportCapExceeded",
    });
    expect(statusOf("old_failed_bare")).toEqual({
      status: "errored",
      stopReason: undefined,
      code: undefined,
    });
    // 缺席的键真的缺席（契约测的 toEqual 风格）。
    expect("stopReason" in journal.getRun("old_completed")!).toBe(false);
    expect("failure" in journal.getRun("old_cancelled")!).toBe(false);
  });

  it("新写入的 stopped 落成 cancelled + 信封，errored 落成 failed + 原样失败；往返逐字段相等", async () => {
    const { db, journal } = openIntrospectableJournal();
    for (const runId of ["s_user", "s_model", "s_provider", "s_interrupted", "e_script"]) {
      journal.createRun({
        runId,
        parentSessionId: PARENT,
        cwd: "/repo",
        caps: CAPS,
        spentTokens: 0,
        status: "running",
      });
    }
    journal.updateRunStatus("s_user", "stopped", { stopReason: "user" });
    journal.updateRunStatus("s_model", "stopped", { stopReason: "model" });
    const providerStop = {
      code: "ProviderStop" as const,
      message: "Sign-in to BigModel expired.",
      providerStop: {
        kind: "auth" as const,
        reason: "auth_failed",
        providerCode: "1006",
        subagent: "verify@2",
      },
    };
    journal.updateRunStatus("s_provider", "stopped", {
      stopReason: "provider",
      failure: providerStop,
    });
    journal.updateRunStatus("s_interrupted", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owning process exited" },
    });
    journal.updateRunStatus("e_script", "errored", {
      failure: { code: "DriverError", message: "boom" },
    });

    const physical = db
      .prepare(
        "select id, status, failure_json from dwf_run where parent_session_id = ? order by id",
      )
      .all(PARENT) as { id: string; status: string; failure_json: string | null }[];
    expect(physical.map((row) => [row.id, row.status])).toEqual([
      ["e_script", "failed"],
      ["s_interrupted", "cancelled"],
      ["s_model", "cancelled"],
      ["s_provider", "cancelled"],
      ["s_user", "cancelled"],
    ]);
    expect(JSON.parse(physical.find((row) => row.id === "s_user")!.failure_json!)).toEqual({
      stopReason: "user",
    });
    expect(JSON.parse(physical.find((row) => row.id === "s_provider")!.failure_json!)).toEqual({
      stopReason: "provider",
      error: providerStop,
    });
    expect(JSON.parse(physical.find((row) => row.id === "e_script")!.failure_json!)).toEqual({
      code: "DriverError",
      message: "boom",
    });

    expect(journal.getRun("s_user")).toMatchObject({ status: "stopped", stopReason: "user" });
    expect("failure" in journal.getRun("s_user")!).toBe(false);
    expect(journal.getRun("s_model")).toMatchObject({ status: "stopped", stopReason: "model" });
    expect(journal.getRun("s_provider")).toMatchObject({
      status: "stopped",
      stopReason: "provider",
      failure: providerStop,
    });
    expect(journal.getRun("s_interrupted")).toMatchObject({
      status: "stopped",
      stopReason: "interrupted",
    });
    expect(journal.getRun("e_script")).toMatchObject({
      status: "errored",
      failure: { code: "DriverError" },
    });
    expect("stopReason" in journal.getRun("e_script")!).toBe(false);
    // 物理终态集没变：非终态查询一条都不回。
    expect(journal.listNonTerminalRuns(PARENT)).toEqual([]);
    // resume 翻回 running 清掉信封（与契约套件同语义）。
    journal.updateRunStatus("s_provider", "running");
    expect(journal.getRun("s_provider")).toMatchObject({ status: "running" });
    expect("stopReason" in journal.getRun("s_provider")!).toBe(false);
  });

  it("statuses 过滤在 SQL 里分清 errored 与 stopped（共享物理 failed）", async () => {
    const { db, journal } = openIntrospectableJournal();
    insertPhysicalRow(db, "p_cancelled", "cancelled", null, 5);
    insertPhysicalRow(
      db,
      "p_interrupted",
      "failed",
      JSON.stringify({ code: "Interrupted", message: "x" }),
      4,
    );
    insertPhysicalRow(
      db,
      "p_errored",
      "failed",
      JSON.stringify({ code: "DriverError", message: "x" }),
      3,
    );
    insertPhysicalRow(db, "p_errored_bare", "failed", null, 2);
    insertPhysicalRow(db, "p_completed", "completed", null, 1);
    journal.createRun({
      runId: "n_stopped",
      parentSessionId: PARENT,
      cwd: "/repo",
      caps: CAPS,
      spentTokens: 0,
      status: "running",
    });
    journal.updateRunStatus("n_stopped", "stopped", { stopReason: "provider" });

    const ids = (statuses: RunRecord["status"][]) =>
      journal
        .listRuns({ cwd: "/repo", limit: 20, statuses })
        .map((row) => row.runId)
        .sort();
    expect(ids(["stopped"])).toEqual(["n_stopped", "p_cancelled", "p_interrupted"]);
    expect(ids(["errored"])).toEqual(["p_errored", "p_errored_bare"]);
    expect(ids(["completed", "errored"])).toEqual(["p_completed", "p_errored", "p_errored_bare"]);
    // limit 作用在过滤之后：errored 只有两条时 limit 1 回最近更新的那条，且不被 stopped 行挤占。
    expect(
      journal.listRuns({ cwd: "/repo", limit: 1, statuses: ["errored"] }).map((row) => row.runId),
    ).toEqual(["p_errored"]);
    // 枚举行带 stopReason（逻辑词汇），不带 failure（仍是窄投影）。
    const stopped = journal.listRuns({ cwd: "/repo", limit: 20, statuses: ["stopped"] });
    expect(stopped.find((row) => row.runId === "p_interrupted")).toMatchObject({
      stopReason: "interrupted",
    });
    expect(stopped.find((row) => row.runId === "n_stopped")).toMatchObject({
      stopReason: "provider",
    });
    expect(stopped.every((row) => !("failure" in row))).toBe(true);
  });
});

/**
 * 每一世的活动区间（完成卡的时长口径，
 * docs/dynamic-workflow/transcript-and-notifications.md「How long it took」）。
 *
 * 事件的时刻由 appendEvent 打 `Date.now()`，所以「一世持续了多久」在测试里只能事后钉：追加完
 * 事件再按 sequence 改写 `time_created`，模拟一条跑了几个小时、中间被重启打断的 run。改写的是
 * 这条读面唯一读的那一列，查询形状与真库上逐字相同。
 */
describe("SQLite dwf journal store — listRunLifeSpans", () => {
  const RUN_ID = "run_lives";

  /** 按 sequence 钉住某几条事件的时刻。 */
  function stampEvent(db: DatabaseSync, sequence: number, timeCreated: number): void {
    db.prepare("update dwf_event set time_created = ? where run_id = ? and sequence = ?").run(
      timeCreated,
      RUN_ID,
      sequence,
    );
  }

  function seedLifeRun(): {
    db: DatabaseSync;
    journal: JournalStorePort & DwfRunIntrospectionQueries;
  } {
    const { db, journal } = openIntrospectableJournal();
    journal.createRun({ runId: RUN_ID, caps: CAPS, spentTokens: 0, status: "running" });
    return { db, journal };
  }

  it("单世：从 run-started 到这一世最后一条事件", async () => {
    const { db, journal } = seedLifeRun();
    journal.appendEvent(RUN_ID, { type: "run-started", runId: RUN_ID, caps: CAPS });
    journal.appendEvent(RUN_ID, { type: "log", message: "工作中" });
    journal.appendEvent(RUN_ID, { type: "run-settled", status: "completed" });
    stampEvent(db, 0, 1_000);
    stampEvent(db, 1, 5_000);
    stampEvent(db, 2, 61_000);

    expect(journal.listRunLifeSpans(RUN_ID)).toEqual([
      { startedAt: 1_000, lastActivityAt: 61_000 },
    ]);
  });

  it("多世：每一世各算一段，世与世之间的空档不出现在任何一段里", async () => {
    const { db, journal } = seedLifeRun();
    // 第一世：跑了一小时后被重启打断（没有 run-settled）。
    journal.appendEvent(RUN_ID, { type: "run-started", runId: RUN_ID, caps: CAPS });
    journal.appendEvent(RUN_ID, { type: "log", message: "第一世的最后一次动作" });
    // 第二世：整个周末之后才 resume，两分钟后完成。
    journal.appendEvent(RUN_ID, { type: "run-started", runId: RUN_ID, caps: CAPS });
    journal.appendEvent(RUN_ID, { type: "log", message: "重放" });
    journal.appendEvent(RUN_ID, { type: "run-settled", status: "completed" });
    stampEvent(db, 0, 0);
    stampEvent(db, 1, 3_600_000);
    stampEvent(db, 2, 200_000_000);
    stampEvent(db, 3, 200_060_000);
    stampEvent(db, 4, 200_120_000);

    const spans = journal.listRunLifeSpans(RUN_ID);

    expect(spans).toEqual([
      { startedAt: 0, lastActivityAt: 3_600_000 },
      { startedAt: 200_000_000, lastActivityAt: 200_120_000 },
    ]);
    // 活动时长之和 = 1 小时 + 2 分钟；两世之间那段死时间（≈ 54 小时）不在其中。
    const activeMs = spans.reduce((sum, span) => sum + (span.lastActivityAt - span.startedAt), 0);
    expect(activeMs).toBe(3_600_000 + 120_000);
  });

  it("一世里只有 run-started 一条事件：区间退化成 0，不是 null", async () => {
    const { db, journal } = seedLifeRun();
    journal.appendEvent(RUN_ID, { type: "run-started", runId: RUN_ID, caps: CAPS });
    stampEvent(db, 0, 7_000);

    expect(journal.listRunLifeSpans(RUN_ID)).toEqual([{ startedAt: 7_000, lastActivityAt: 7_000 }]);
  });

  it("没有 run-started 的 run 与未知 run 都回空数组（无证据，不是 0 时长）", async () => {
    const { journal } = seedLifeRun();
    journal.appendEvent(RUN_ID, { type: "log", message: "只有日志" });

    expect(journal.listRunLifeSpans(RUN_ID)).toEqual([]);
    expect(journal.listRunLifeSpans("run_never_seen")).toEqual([]);
  });

  it("只看本 run 的事件：另一条 run 的世不混进来", async () => {
    const { db, journal } = seedLifeRun();
    journal.createRun({ runId: "run_other", caps: CAPS, spentTokens: 0, status: "running" });
    journal.appendEvent(RUN_ID, { type: "run-started", runId: RUN_ID, caps: CAPS });
    journal.appendEvent("run_other", { type: "run-started", runId: "run_other", caps: CAPS });
    journal.appendEvent("run_other", { type: "log", message: "别人的活" });
    stampEvent(db, 0, 10_000);
    db.prepare("update dwf_event set time_created = ? where run_id = 'run_other'").run(999_000);

    expect(journal.listRunLifeSpans(RUN_ID)).toEqual([
      { startedAt: 10_000, lastActivityAt: 10_000 },
    ]);
    expect(journal.listRunLifeSpans("run_other")).toEqual([
      { startedAt: 999_000, lastActivityAt: 999_000 },
    ]);
  });
});

// 计数查询不得复用带 limit 的目录，也不能跨父会话或加载结果正文。
it("reads complete lightweight workflow activity history beyond preview limits", () => {
  const { db, journal } = openJournalDb();
  for (let index = 0; index < 11; index++) {
    journal.createRun({
      ...RUN,
      runId: `history-${index}`,
      status: index < 9 ? "completed" : "stopped",
    });
  }
  journal.createRun({ ...RUN, runId: "foreign", parentSessionId: "another", status: "completed" });
  journal.putActor({ ...ACTOR, runId: "history-0" });
  const history = createDwfJournalStore(db) as JournalStorePort & {
    getActivityHistory(
      parentSessionId: string,
    ): import("@zcode/contracts").DynamicWorkflowActivityHistory;
  };
  const result = history.getActivityHistory(RUN.parentSessionId!);
  expect(result.runs).toHaveLength(11);
  expect(result.runs.filter((run) => run.status === "completed")).toHaveLength(9);
  expect(
    result.runs.every((run) => Object.keys(run).sort().join() === "runId,sequence,status"),
  ).toBe(true);
  expect(result.childSessionIds).toEqual([ACTOR.sessionId]);
});

it.each(["baseline", "upgrade"] as const)(
  "%s 活动历史查询只检索本会话，升级不改数据且重复打开幂等",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "dwf-parent-index-"));
    const dbPath = join(directory, "session.sqlite");
    const db = new DatabaseSync(dbPath);
    const migrationId = "0026_dwf_run_parent_session_index";
    try {
      if (mode === "baseline") {
        db.exec(
          await readFile(
            new URL("../src/storage/session-store/schema.baseline.sql", import.meta.url),
            "utf8",
          ),
        );
      } else {
        db.exec("BEGIN IMMEDIATE");
        ensureSqliteSchemaMigrationTable(db);
        for (const migration of SQLITE_MIGRATIONS.filter((item) => item.id < migrationId))
          applySqliteSchemaMigration(db, migration);
        db.exec("COMMIT");
      }
      const journal = createDwfJournalStore(db);
      const history = journal as JournalStorePort & {
        getActivityHistory(
          parent: string,
        ): import("@zcode/contracts").DynamicWorkflowActivityHistory;
      };
      journal.createRun(RUN);
      journal.putActor(ACTOR);
      journal.appendEvent(RUN.runId, { type: "run-started", runId: RUN.runId, caps: CAPS });
      const expected = history.getActivityHistory(RUN.parentSessionId!);
      // 无关会话远多于目标会话；断言查询计划而不是依赖机器速度的耗时阈值。
      db.exec("BEGIN");
      const insertRun = db.prepare(
        "INSERT INTO dwf_run(id,parent_session_id,caps_max_concurrency,status,time_created,time_updated) VALUES(?,?,1,'completed',1,1)",
      );
      const insertActor = db.prepare(
        "INSERT INTO dwf_actor(run_id,site_id,ordinal,session_id,time_created,time_updated) VALUES(?,'worker',?,?,1,1)",
      );
      for (let i = 0; i < 10_000; i++) {
        const runId = `unrelated-${i}`;
        insertRun.run(runId, "another-parent");
        for (let j = 0; j < 3; j++) insertActor.run(runId, j, `${runId}-${j}`);
      }
      db.exec("COMMIT");
      const rows = () =>
        ["dwf_run", "dwf_actor", "dwf_node", "dwf_event"].map((table) =>
          db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
        );
      const before = rows();
      if (mode === "upgrade") {
        await runSqliteSessionMigrations(db, dbPath);
        expect(rows()).toEqual(before);
        const record = db.prepare("SELECT * FROM schema_migration WHERE id=?").get(migrationId);
        expect(record).toBeDefined();
        await runSqliteSessionMigrations(db, dbPath);
        expect(db.prepare("SELECT * FROM schema_migration WHERE id=?").get(migrationId)).toEqual(
          record,
        );
        expect(rows()).toEqual(before);
      }
      const prepare = vi.spyOn(db, "prepare");
      const actual = history.getActivityHistory(RUN.parentSessionId!);
      const queries = prepare.mock.calls.map(([sql]) => sql);
      prepare.mockRestore();
      expect(actual).toEqual(expected);
      expect(queries).toHaveLength(2);
      const plans = queries.map((sql) =>
        db
          .prepare("EXPLAIN QUERY PLAN " + sql)
          .all(RUN.parentSessionId!)
          .map((row) => String(row.detail))
          .join("\n"),
      );
      for (const plan of plans) {
        expect(plan).toContain("SEARCH r USING INDEX dwf_run_parent_session_idx");
        expect(plan).not.toMatch(/SCAN [ra]\b/);
      }
      expect(plans[1]).toContain("SEARCH a USING INDEX dwf_actor_run_idx");
    } finally {
      db.close();
      await rm(directory, { force: true, recursive: true });
    }
  },
);
