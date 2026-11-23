/**
 * `JournalStorePort` 的 SQLite 实现（dwf_* 表）。
 *
 * 端口是同步的、仓储式的，正好贴合 node:sqlite 的 DatabaseSync——引擎因此不必为持久化
 * 引入异步缝隙，replay 的确定性也就不受存储实现影响。
 *
 * 与 @zcode/dynamic-workflow 的依赖方向：只 `import type`。端口属于领域包，本文件是它的
 * 一个 adapter；运行时不得从领域包取任何值（`implements` 在编译期被抹除）。
 *
 * 事务性不在端口面上：需要与 session 写入同原子的场景由 driver 用 `begin immediate` 组合。
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  ActorRecord,
  Caps,
  GetNodeOptions,
  JournalStorePort,
  ListActorsOptions,
  ListEventsOptions,
  ListNodesOptions,
  NodeKind,
  NodeRecord,
  RunEvent,
  RunRecord,
  RunSettlementRecord,
  RunStatus,
  StoredEvent,
} from "@zcode/dynamic-workflow";
import { encodeJson } from "../json.js";
// 产物读面自成一个模块：它只要一个 db 句柄，与 run/actor/node/event 的写入-读取无共享状态，
// 而它的两条查询各自带着一大段「为什么是这个取数源、这个排序、这个游标」的论证。
import {
  countTaggedReports,
  listArtifactItems,
  listArtifactRows,
  type DwfArtifactItem,
  type DwfArtifactItemsQuery,
} from "./dwf-journal-artifacts.js";
import { listEventPage, type DwfEventPageQuery } from "./dwf-journal-pages.js";
import {
  countNodeRows,
  getNodeRow,
  listActorRows,
  listEventRows,
  listNodeRows,
  sumResultBytes,
} from "./dwf-journal-reads.js";
import {
  decodeActor,
  decodeRun,
  encodeResultJson,
  encodeRunSettlement,
  type DwfActorRow,
  type DwfEventRow,
  type DwfWorldNodeRow,
  type DwfRunDetailRow,
  type DwfRunListItem,
  type DwfRunRow,
  type DwfRunSessionListItem,
} from "./dwf-journal-codecs.js";
import {
  countNodesByStatus,
  getRunRow,
  listRecentLogEvents,
  listRunLifeSpans,
  listRuns,
  listRunsByParentSession,
  listWorldNodes,
  type DwfListRunsQuery,
  type DwfNodeStatusCounts,
  type DwfRunIntrospectionQueries,
  type DwfRunLifeSpan,
} from "./dwf-journal-introspection.js";

export type { DwfArtifactItem, DwfArtifactItemsQuery } from "./dwf-journal-artifacts.js";
// run 内省读面（DwfRunIntrospectionQueries 及其 SQL）住在 dwf-journal-introspection.ts
//（max-lines 拆分）；类型仍从本文件导出，既有 importer 不必改路径。
export type {
  DwfListRunsQuery,
  DwfNodeStatusCounts,
  DwfRunIntrospectionQueries,
  DwfRunLifeSpan,
} from "./dwf-journal-introspection.js";

class SqliteDwfJournalStore implements JournalStorePort, DwfRunIntrospectionQueries {
  constructor(private readonly db: DatabaseSync) {}

  createRun(record: RunRecord): void {
    const now = Date.now();
    // 逻辑 → 物理（零迁移终态编码，见 dwf-journal-codecs.ts 文件头）。
    const settlement = encodeRunSettlement(record.status, record);
    try {
      this.db
        .prepare(
          `
          insert into dwf_run (
            id, parent_session_id, cwd, name, script_text, script_hash, tool_call_id,
            args_json, resumed_from, caps_max_concurrency,
            spent_tokens, status, failure_json, result_json, time_created, time_updated
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          record.runId,
          record.parentSessionId ?? null,
          record.cwd ?? null,
          // name 与 scriptText / cwd 同一条元数据路：只在建 run 这一刻写入，此后没有任何
          // 写入者碰它（updateRunStatus 刻意不列这一列）。
          record.name ?? null,
          record.scriptText ?? null,
          record.scriptHash ?? null,
          record.toolCallId ?? null,
          // 实参与 scriptText 同一条元数据路：只在建 run 这一刻写入，此后没有任何写入者
          // 碰它——resume 读回来重放的必须是被批准的那一份。
          encodeJson(record.args),
          // lineage 同属这条只写一次的元数据路：修订是 supersede，前驱行零触碰，
          // 所以「本 run 修订自谁」只有建 run 这一刻能写下。
          record.resumedFrom ?? null,
          // caps 与上面几列**不**同路：它不是只写一次的元数据。`updateRunCaps` 是这一列的第二个
          // 写入者——一次只改 `max_concurrency` 的修订就地作用在活着的 run 上，而 resume 沿用
          // 行里的值（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）。
          record.caps.maxConcurrency,
          record.spentTokens,
          settlement.status,
          settlement.failureJson,
          encodeResultJson(record.result),
          now,
          now,
        );
    } catch (error) {
      // 重复 run 是调用方的契约错误，值得一条能直接读懂的消息；其余失败（FK、磁盘、约束）原样上抛。
      if (this.getRun(record.runId) !== undefined) {
        throw new Error(`dwf journal: run already exists: ${record.runId}`, { cause: error });
      }
      throw error;
    }
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare("select * from dwf_run where id = ?").get(runId) as
      | DwfRunRow
      | undefined;
    return row ? decodeRun(row) : undefined;
  }

  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void {
    const now = Date.now();
    // 非终态 = 无 settlement：resume 把 run 翻回 running 时必须清掉上一世的 failure_json /
    // result_json——引擎的 resume 分支不带结算袋，「缺席键 = 不触碰」的终态语义会让孤儿收敛
    // 写下的 Interrupted 失败与 running 并存。矛盾的结算袋（非终态却携带 failure/result）
    // 同样按清空处理（契约测钉住，两实现同语义）。
    if (status === "pending" || status === "running") {
      const { changes } = this.db
        .prepare(
          `
          update dwf_run set
            status = ?,
            failure_json = null,
            result_json = null,
            time_updated = ?
          where id = ?
          `,
        )
        .run(status, now, runId);
      this.assertRunTouched(changes, runId);
      return;
    }
    // 终态与产物**一笔写**：分两条 UPDATE 会开出崩溃窗口，造出「completed 但 result_json
    // 为空」的 run——正是 0020 这一列要关死的损失类别。
    //
    // `failure_json` **整列改写**（不 coalesce）。第二个桌面实例的孤儿
    // 收敛在本进程引擎仍活着的 run 上写下 failed + Interrupted；引擎随后正常 completed，而
    // coalesce 让那份外来失败原样留了下来——行同时说「完成了」和「被打断了」。结算袋是那一刻
    // 失败的**全部真相**：stopped 恒写信封、errored 写它自己的失败（缺席即 NULL，那就是真相）、
    // completed 写 NULL。
    //
    // `result_json` 保留 coalesce：产物的语义是「缺席 = 不触碰」（契约用例「keeps an
    // already-settled artifact when a later write omits it」），一次不带产物的重复结算不该抹掉它。
    const encoded = encodeRunSettlement(status, settlement);
    const { changes } = this.db
      .prepare(
        `
        update dwf_run set
          status = ?,
          failure_json = ?,
          result_json = coalesce(?, result_json),
          time_updated = ?
        where id = ?
        `,
      )
      .run(encoded.status, encoded.failureJson, encodeResultJson(settlement?.result), now, runId);
    this.assertRunTouched(changes, runId);
  }

  updateRunUsage(runId: string, spentTokens: number): void {
    const { changes } = this.db
      .prepare("update dwf_run set spent_tokens = ?, time_updated = ? where id = ?")
      .run(spentTokens, Date.now(), runId);
    this.assertRunTouched(changes, runId);
  }

  /**
   * 本 run 并发上界的就地更新（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）。
   * 与 `updateRunUsage` 同族的窄写入：**只列 caps_max_concurrency**，状态、用量与结算信封
   * 都不在这条语句里——它们各有自己的写入路径，混进来就会让一次改上界顺手回退一个结算。
   * 零迁移：列早已存在，本方法只是它的第二个写入者。
   */
  updateRunCaps(runId: string, caps: Caps): void {
    const { changes } = this.db
      .prepare("update dwf_run set caps_max_concurrency = ?, time_updated = ? where id = ?")
      .run(caps.maxConcurrency, Date.now(), runId);
    this.assertRunTouched(changes, runId);
  }

  /**
   * 把**有效脚本**写回 run 行（docs/execution-engine.md「Holes」→「The engine's part」）。它是
   * `script_text` / `script_hash` 两列在 `createRun` 之后的第二个写入者：一次补全把留白的函数体
   * 接进脚本，此后 resume 拿行里的哈希对行里的文本，所以两列**必须同一条 UPDATE**——分两笔写会
   * 开出一个「文本是新的、哈希是旧的」的崩溃窗口，resume 撞上它就是 ScriptHashMismatch。
   * 与 `updateRunUsage` 同族的窄写入：状态、用量、上界与结算袋都不在这条语句里。零迁移：两列
   * 早已存在，本方法只是它们的第二个写入者。
   */
  updateRunScript(runId: string, scriptText: string, scriptHash: string): void {
    const { changes } = this.db
      .prepare("update dwf_run set script_text = ?, script_hash = ?, time_updated = ? where id = ?")
      .run(scriptText, scriptHash, Date.now(), runId);
    this.assertRunTouched(changes, runId);
  }

  /**
   * 某个父会话名下所有**非终态**的 run。刻意不在 `JournalStorePort` 上：引擎从不按父会话找
   * run，这条查询只服务于宿主侧的孤儿收敛——一个进程被杀掉的 run 会永远停在 `running`，
   * 由下一次同会话的 app 构造把它收敛掉（`bootstrap/src/app/dynamic-workflow-run-service.ts`，
   * 按能力探测调用本方法）。
   *
   * 本方法只出 SQL：终态集在这里是**索引友好的预筛**，判定权威留在 service 侧（它拿到记录后
   * 按自己的终态集再过一遍）。`parent_session_id` 必须入条件——不带它的清扫会把同进程兄弟
   * 会话**正在飞**的 run 标死（同一个 sqlite，各自独立的内存注册表）。SQL 的 `= ?` 天然不匹配
   * `NULL`，所以父会话缺席的行不属于任何会话，也就不会被任何一次收敛碰到。
   */
  listNonTerminalRuns(parentSessionId: string): RunRecord[] {
    // 物理终态集（failed / cancelled 是逻辑 errored / stopped 的落库形态，不迁移）。
    const rows = this.db
      .prepare(
        `
        select * from dwf_run
        where parent_session_id = ?
          and status not in ('completed', 'failed', 'cancelled')
        order by id
        `,
      )
      .all(parentSessionId) as unknown as DwfRunRow[];
    return rows.map(decodeRun);
  }

  // ---- 宿主侧 run 内省读面：SQL 与论证住在 dwf-journal-introspection.ts，这里只做委托。

  listRuns(query: DwfListRunsQuery): DwfRunListItem[] {
    return listRuns(this.db, query);
  }

  getRunRow(runId: string): DwfRunDetailRow | undefined {
    return getRunRow(this.db, runId);
  }

  countNodesByStatus(runId: string): DwfNodeStatusCounts {
    return countNodesByStatus(this.db, runId);
  }

  listRecentLogEvents(runId: string, limit: number): StoredEvent[] {
    return listRecentLogEvents(this.db, runId, limit);
  }

  listRunLifeSpans(runId: string): DwfRunLifeSpan[] {
    return listRunLifeSpans(this.db, runId);
  }

  /** 完整计数读面不受列表 limit 限制，且不加载脚本、节点或结果正文。 */
  getActivityHistory(
    parentSessionId: string,
  ): import("@zcode/contracts").DynamicWorkflowActivityHistory {
    const runs = this.db
      .prepare(`
      select r.id as runId, r.status,
        coalesce((select max(e.sequence) from dwf_event e where e.run_id = r.id), -1) as sequence
      from dwf_run r where r.parent_session_id = ?
    `)
      .all(parentSessionId) as Array<{ runId: string; status: string; sequence: number }>;
    const children = this.db
      .prepare(`
      select distinct a.session_id as sessionId from dwf_actor a
      join dwf_run r on r.id = a.run_id
      where r.parent_session_id = ? and a.session_id is not null
    `)
      .all(parentSessionId) as Array<{ sessionId: string }>;
    return { runs, childSessionIds: children.map((row) => row.sessionId) };
  }

  listRunsByParentSession(parentSessionId: string, limit: number): DwfRunSessionListItem[] {
    return listRunsByParentSession(this.db, parentSessionId, limit);
  }

  putActor(record: ActorRecord): void {
    const now = Date.now();
    this.db
      .prepare(
        `
        insert into dwf_actor (
          run_id, site_id, ordinal, name, persona_json, session_id, resolved_model,
          time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(run_id, site_id, ordinal) do update set
          name = excluded.name,
          persona_json = excluded.persona_json,
          session_id = excluded.session_id,
          resolved_model = excluded.resolved_model,
          time_updated = excluded.time_updated
        `,
      )
      .run(
        record.runId,
        record.siteId,
        record.ordinal,
        record.name ?? null,
        encodeJson(record.persona),
        record.sessionId ?? null,
        record.resolvedModel ?? null,
        now,
        now,
      );
  }

  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined {
    const row = this.db
      .prepare("select * from dwf_actor where run_id = ? and site_id = ? and ordinal = ?")
      .get(runId, siteId, ordinal) as DwfActorRow | undefined;
    return row ? decodeActor(row) : undefined;
  }

  listActors(runId: string, opts: ListActorsOptions): ActorRecord[] {
    return listActorRows(this.db, runId, opts);
  }

  putNode(record: NodeRecord): void {
    // 准入（running）→ 结算 → 统计回填都走同一条 upsert，键是 (run_id, site_id, ordinal)。
    const now = Date.now();
    this.db
      .prepare(
        `
        insert into dwf_node (
          run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq,
          input_hash, status, result_json, error_json, stats_json, message_boundary,
          artifact_id, input_json, time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(run_id, site_id, ordinal) do update set
          kind = excluded.kind,
          actor_site_id = excluded.actor_site_id,
          actor_ordinal = excluded.actor_ordinal,
          actor_seq = excluded.actor_seq,
          input_hash = excluded.input_hash,
          status = excluded.status,
          result_json = excluded.result_json,
          error_json = excluded.error_json,
          stats_json = excluded.stats_json,
          message_boundary = excluded.message_boundary,
          artifact_id = excluded.artifact_id,
          input_json = excluded.input_json,
          time_updated = excluded.time_updated
        `,
      )
      .run(
        record.runId,
        record.siteId,
        record.ordinal,
        record.kind,
        record.actorSiteId ?? null,
        record.actorOrdinal ?? null,
        record.actorSeq ?? null,
        record.inputHash,
        record.status,
        encodeResultJson(record.result),
        encodeJson(record.error),
        encodeJson(record.stats),
        // 与 stats_json 同族的 driver 补写列：upsert 整条替换，所以补写方必须先 getNode
        // 再把整条记录铺开重写（契约测钉住这个读改写形状）。
        record.messageBoundary ?? null,
        // 产物 id 与 kind 同属**引擎在两次写里都带着**的身份列（准入 running 与结算
        // completed/failed 写的是同一个 id）：upsert 整条替换，所以少写一次就等于把
        // 结算行的产物归属抹掉，那条发布在「本 run 有哪些产物」的读面上直接消失。
        record.artifactId ?? null,
        // 0030：有界输入与 kind / artifact_id 同属「引擎两次写都带着」的列——upsert 整条替换，
        // 结算漏写一次就把准入记下的 op / args 抹回 NULL。
        encodeJson(record.input),
        now,
        now,
      );
  }

  // ---- 节点 / 事件 / actor 的列表读：SQL 与论证住在 dwf-journal-reads.ts（读面选项全部下推）。

  getNode(
    runId: string,
    siteId: string,
    ordinal: number,
    opts?: GetNodeOptions,
  ): NodeRecord | undefined {
    return getNodeRow(this.db, runId, siteId, ordinal, opts);
  }

  listNodes(runId: string, opts: ListNodesOptions): NodeRecord[] {
    return listNodeRows(this.db, runId, opts);
  }

  countNodes(runId: string, kind: NodeKind): number {
    return countNodeRows(this.db, runId, kind);
  }

  sumResultBytes(runId: string, kind: NodeKind): number {
    return sumResultBytes(this.db, runId, kind);
  }

  listArtifactRows(runId: string): NodeRecord[] {
    return listArtifactRows(this.db, runId);
  }

  countTaggedReports(runId: string): ReadonlyMap<string, number> {
    return countTaggedReports(this.db, runId);
  }

  listWorldNodes(runId: string): DwfWorldNodeRow[] {
    return listWorldNodes(this.db, runId);
  }

  listArtifactItems(
    runId: string,
    artifactId: string,
    query: DwfArtifactItemsQuery,
  ): { items: DwfArtifactItem[]; hasMore: boolean } {
    return listArtifactItems(this.db, runId, artifactId, query);
  }

  listEventPage(
    runId: string,
    query: DwfEventPageQuery,
  ): { events: StoredEvent[]; hasMore: boolean } {
    return listEventPage(this.db, runId, query);
  }

  appendEvent(runId: string, event: RunEvent): StoredEvent {
    // 写进 time_created 的那一刻要原样回给调用方：读回这一行时 decodeEvent 给的是同一个数，
    // 追加路径却拿不到它，就会出现「刚写的事件没有时刻、读回来才有」这种两面不一致。
    const timeCreated = Date.now();
    // 序号分配与写入必须是同一条语句：MAX(sequence)+1 单独读一次再插入，会在多进程
    // （WAL 下 zcode 允许多个 Agent 共享同一个库）之间竞争出重复序号。
    const row = this.db
      .prepare(
        `
        insert into dwf_event (run_id, sequence, type, payload_json, time_created)
        values (
          ?,
          coalesce((select max(sequence) + 1 from dwf_event where run_id = ?), 0),
          ?, ?, ?
        )
        returning sequence
        `,
      )
      .get(runId, runId, event.type, JSON.stringify(event), timeCreated) as
      | Pick<DwfEventRow, "sequence">
      | undefined;
    if (row === undefined) {
      throw new Error(`dwf journal: event insert returned no sequence for run: ${runId}`);
    }
    return { sequence: row.sequence, event, timeCreated };
  }

  listEvents(runId: string, opts: ListEventsOptions): StoredEvent[] {
    return listEventRows(this.db, runId, opts);
  }

  /** UPDATE 影响 0 行即"未知 run"——SQLite 不会为此报错，必须显式检出并大声失败。 */
  private assertRunTouched(changes: number | bigint, runId: string): void {
    if (Number(changes) === 0) throw new Error(`dwf journal: unknown run: ${runId}`);
  }
}

/** 在既有 session 库上开一个 dwf journal 视图；表由 migration `0019_dwf_journal` 建立。 */
export function createDwfJournalStore(db: DatabaseSync): JournalStorePort {
  return new SqliteDwfJournalStore(db);
}
