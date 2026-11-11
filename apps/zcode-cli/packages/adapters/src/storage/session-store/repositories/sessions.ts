import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  SESSION_TASK_TYPES,
  type ClaimLegacySessionWorkspaceInput,
  type CreateSessionInput,
  type FileDiff,
  type ListSessionsInput,
  type RepairLegacyRemoteSessionWorkspaceInput,
  type RepairRemoteSessionPathsInput,
  type SessionId,
  type SessionInfo,
  type SessionRevert,
  type UpdateSessionInput,
  type SessionTaskType,
  type SessionDeletionSnapshot,
  type SessionDeletionReference,
} from "@zcode/contracts";
import { decodeSessionRow } from "../codecs.js";
import { encodeJson } from "../json.js";
import type { SessionRow } from "../rows.js";

export function createSession(db: DatabaseSync, input: CreateSessionInput): SessionInfo {
  const now = Date.now();
  const timeCreated = input.time?.created ?? now;
  const timeUpdated = input.time?.updated ?? timeCreated;

  db.prepare(
    `
      insert into session (
        id, project_id, workspace_id, parent_id, trace_id, task_type, slug, directory, path,
        title, title_source, title_message_id, version,
        share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
        revert, permission, time_created, time_updated, time_title_updated,
        time_compacting
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, null, ?, ?, ?, ?, null)
      on conflict(id) do update set
        project_id = excluded.project_id,
        workspace_id = excluded.workspace_id,
        parent_id = excluded.parent_id,
        trace_id = coalesce(session.trace_id, excluded.trace_id),
        task_type = excluded.task_type,
        slug = excluded.slug,
        directory = excluded.directory,
        path = excluded.path,
        title = excluded.title,
        title_source = excluded.title_source,
        title_message_id = excluded.title_message_id,
        version = excluded.version,
        share_url = excluded.share_url,
        permission = coalesce(excluded.permission, session.permission),
        time_title_updated = excluded.time_title_updated,
        time_updated = excluded.time_updated
      `,
  ).run(
    input.id,
    input.projectID,
    input.workspaceID ?? null,
    input.parentID ?? null,
    input.traceID ?? null,
    input.taskType ?? "interactive",
    input.slug,
    input.directory,
    input.path ?? null,
    input.title,
    input.titleSource ?? "first_input",
    input.titleMessageID ?? null,
    input.version,
    input.shareURL ?? null,
    encodeJson(input.permission),
    timeCreated,
    timeUpdated,
    input.titleSource || input.titleMessageID ? timeUpdated : null,
  );

  return mustGetSession(db, input.id);
}

export async function updateSession(
  db: DatabaseSync,
  input: UpdateSessionInput,
): Promise<SessionInfo> {
  const fields: string[] = [];
  const values: SQLInputValue[] = [];
  const set = (column: string, value: SQLInputValue | undefined) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`);
    values.push(value);
  };
  // Bug 根因：先读整行再 await 会用旧快照覆盖并发标题、权限和结果；只更新本次输入拥有的列。
  set("directory", input.directory);
  set("path", input.path);
  set("title", input.title);
  set("title_source", input.titleSource);
  set("title_message_id", input.titleMessageID);
  set("share_url", input.shareURL);
  set("last_outcome", input.lastOutcome);
  if (input.summary !== undefined) {
    set("summary_additions", input.summary?.additions ?? null);
    set("summary_deletions", input.summary?.deletions ?? null);
    set("summary_files", input.summary?.files ?? null);
    set("summary_diffs", encodeJson(input.summary?.diffs));
  }
  if (input.revert !== undefined) set("revert", encodeJson(input.revert));
  if (input.permission !== undefined) set("permission", encodeJson(input.permission));
  set("time_compacting", input.timeCompacting);
  if (
    input.title !== undefined ||
    input.titleSource !== undefined ||
    input.titleMessageID !== undefined
  ) {
    set("time_title_updated", Date.now());
  }
  // 标题及组织态不代表会话活动；活动时间只由消息/终态显式提交，且禁止回退。
  if (input.timeUpdated !== undefined) {
    fields.push("time_updated = max(time_updated, ?)");
    values.push(input.timeUpdated);
  }
  if (fields.length) {
    values.push(input.id);
    const sources = input.title !== undefined ? input.expectedTitleSources : undefined;
    const guard = sources?.length
      ? ` and coalesce(title_source, 'first_input') in (${sources.map(() => "?").join(",")})`
      : "";
    if (sources?.length) values.push(...sources);
    db.prepare(`update session set ${fields.join(",")} where id=?${guard}`).run(...values);
  }
  return mustGetSession(db, input.id);
}

export function softDeleteSession(
  db: DatabaseSync,
  sessionID: SessionId,
  timeDeleted: number,
): void {
  // 软删除保持幂等，并保留 message/part 及活动时间；旧 create/upsert 不能清除此字段。
  db.prepare("update session set time_deleted = coalesce(time_deleted, ?) where id = ?").run(
    timeDeleted,
    sessionID,
  );
}

/**
 * 只沿「附属会话」展开后代：subagent / workflow / 侧边问答的子会话随父会话存在。
 * fork 的 parent_id 也指向源会话，但它是用户可见的独立任务（可能已归入别的项目），
 * 删除源会话时绝不能连带删除；interactive / workflow_parent 同理不展开。
 */
const OWNED_CHILD_TASK_TYPES: readonly SessionTaskType[] = [
  "selection_side_chat",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
];
const SQL_ID_CHUNK = 400;

function chunked<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += SQL_ID_CHUNK)
    chunks.push(items.slice(index, index + SQL_ID_CHUNK));
  return chunks;
}

/** 每个根会话 → 根自身与全部附属后代；根不存在时返回空数组。 */
export function listOwnedSessionTrees(
  db: DatabaseSync,
  sessionIDs: readonly SessionId[],
): Map<SessionId, SessionId[]> {
  const exists = db.prepare("select 1 from session where id = ?");
  const children = db.prepare(
    `select id from session where parent_id = ? and task_type in (${OWNED_CHILD_TASK_TYPES.map(() => "?").join(",")})
     union select child_session_id as id from session_task_link where parent_session_id = ?`,
  );
  const trees = new Map<SessionId, SessionId[]>();
  for (const root of sessionIDs) {
    if (!exists.get(root)) {
      trees.set(root, []);
      continue;
    }
    const seen = new Set<SessionId>([root]);
    const queue = [root];
    while (queue.length) {
      const current = queue.shift()!;
      for (const row of children.all(current, ...OWNED_CHILD_TASK_TYPES, current) as Array<{
        id: SessionId;
      }>) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        queue.push(row.id);
      }
    }
    trees.set(root, [...seen]);
  }
  return trees;
}

const ARTIFACT_URI_SCHEME = "zcode-artifact://";
const ARTIFACT_URI_SESSION = /zcode-artifact:\/\/([^/"\\\s]+)\//g;

/**
 * 每个目标会话 → 仍引用其附件（`zcode-artifact://<目标>/…`）的其他未删除会话。
 * fork、回退与工作流转录按值复制 part，URI 仍指向源会话的附件目录；按 part 内容判定，
 * 不依赖 fork 谱系，任何复制路径都能覆盖。只在彻底删除时调用，一次全表扫描可接受。
 */
export function listArtifactReferrers(
  db: DatabaseSync,
  sessionIDs: readonly SessionId[],
): Map<SessionId, SessionId[]> {
  const targets = new Set<string>(sessionIDs);
  const referrers = new Map<SessionId, Set<SessionId>>();
  if (!targets.size) return new Map();
  const rows = db
    .prepare(
      `select p.session_id, p.data from part p join session s on s.id = p.session_id
       where s.time_deleted is null and instr(p.data, ?) > 0`,
    )
    .iterate(ARTIFACT_URI_SCHEME) as Iterable<{ session_id: SessionId; data: string }>;
  for (const row of rows) {
    for (const match of row.data.matchAll(ARTIFACT_URI_SESSION)) {
      const target = decodeURIComponent(match[1]!) as SessionId;
      if (target === row.session_id || !targets.has(target)) continue;
      referrers.set(target, (referrers.get(target) ?? new Set()).add(row.session_id));
    }
  }
  return new Map([...referrers].map(([target, ids]) => [target, [...ids]]));
}

/**
 * 彻底删除会话及其附属后代的全部行。message/part/todo/usage 等经外键级联；
 * input_history、dwf_run、workflow_run 对 session 没有级联外键，必须显式删除，否则留下孤儿行。
 * 调用方负责先删除会话文件：文件失败时不调用本函数，下次重试仍能按会话找到它们。
 */
export function purgeSessions(db: DatabaseSync, sessionIDs: readonly SessionId[]): void {
  const ids = [...new Set([...listOwnedSessionTrees(db, sessionIDs).values()].flat())];
  if (!ids.length) return;
  // foreign_keys 不能在事务内切换；启动时已打开，这里再保证一次级联生效。
  db.exec("pragma foreign_keys = on");
  db.exec("begin immediate");
  try {
    for (const chunk of chunked(ids)) {
      const marks = chunk.map(() => "?").join(",");
      db.prepare(`delete from input_history where session_id in (${marks})`).run(...chunk);
      db.prepare(`delete from dwf_run where parent_session_id in (${marks})`).run(...chunk);
      db.prepare(`delete from workflow_run where parent_session_id in (${marks})`).run(...chunk);
      db.prepare(`delete from session where id in (${marks})`).run(...chunk);
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function getSession(db: DatabaseSync, sessionID: SessionId): SessionInfo | null {
  const row = db.prepare("select * from session where id = ?").get(sessionID) as
    | SessionRow
    | undefined;
  return row ? decodeSessionRow(row) : null;
}

export async function listSessions(
  db: DatabaseSync,
  input: ListSessionsInput = {},
): Promise<SessionInfo[]> {
  const clauses: string[] = [
    "time_deleted is null",
    "not exists(select 1 from session_purge where session_id=session.id)",
  ];
  const values: SQLInputValue[] = [];

  if (input.projectID) {
    clauses.push("project_id = ?");
    values.push(input.projectID);
  }

  if (input.workspaceID !== undefined) {
    if (input.workspaceID === null) {
      clauses.push("workspace_id is null");
    } else {
      clauses.push("workspace_id = ?");
      values.push(input.workspaceID);
    }
  }

  if (input.directory) {
    clauses.push("directory = ?");
    values.push(input.directory);
  }

  if (input.path !== undefined) {
    if (input.path.length === 0) {
      clauses.push("(path is null or path = '')");
    } else {
      clauses.push("(path = ? or path like ?)");
      values.push(input.path, `${input.path}/%`);
    }
  }

  if (input.roots) {
    clauses.push("parent_id is null");
  }

  const taskTypes = normalizeSessionTaskTypes(input.taskTypes);
  if (taskTypes.length > 0) {
    clauses.push(`task_type in (${taskTypes.map(() => "?").join(", ")})`);
    values.push(...taskTypes);
  }

  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  const limitValue = input.limit && input.limit > 0 ? input.limit : undefined;
  const limit = limitValue === undefined ? "" : " limit ?";
  if (limitValue !== undefined) {
    values.push(limitValue);
  }
  const rows = db
    .prepare(`select * from session ${where} order by time_updated desc, id desc${limit}`)
    .all(...values) as unknown as SessionRow[];
  return rows.map(decodeSessionRow);
}

export function claimLegacySessionWorkspace(
  db: DatabaseSync,
  input: ClaimLegacySessionWorkspaceInput,
): number {
  const sessionIDs = [...new Set(input.sessionIDs)];
  if (sessionIDs.length === 0) return 0;
  // 3.3.6 的 SSH/WSL session 没有 workspace_id，3.4 sessions-index 又按完整
  // identity 严格查询，升级后历史任务全部不可见。这里只认 host tasks-index 给出的精确
  // taskId allowlist，并叠加实际目录和 NULL identity，不能退化成按路径批量认领。
  const result = db
    .prepare(
      `update session
       set workspace_id = ?
       where workspace_id is null
         and directory = ?
         and id in (${sessionIDs.map(() => "?").join(", ")})`,
    )
    .run(input.workspaceID, input.directory, ...sessionIDs);
  return Number(result.changes);
}

export function repairLegacyRemoteSessionWorkspace(
  db: DatabaseSync,
  input: RepairLegacyRemoteSessionWorkspaceInput,
): boolean {
  // 3.4.2 把 WSL identity 当成执行路径，生产路径还可能先被 path.resolve
  // 拼到真实 cwd 后落库。只按单 session 和完整旧目录精确迁移，禁止模糊搜索或批量认领。
  const result = db
    .prepare(
      `update session
       set project_id = ?, workspace_id = ?, directory = ?, path = ?
       where id = ?
         and workspace_id is null
         and directory = ?
         and (path is null or path = ?)`,
    )
    .run(
      input.projectID,
      input.workspaceID,
      input.workspacePath,
      input.workspacePath,
      input.sessionID,
      input.legacyWorkspaceDirectory,
      input.legacyWorkspaceDirectory,
    );
  return Number(result.changes) === 1;
}

export function repairRemoteSessionPaths(
  db: DatabaseSync,
  input: RepairRemoteSessionPathsInput,
): boolean {
  // 路径自愈曾复用全字段 updateSession，把读取快照中的标题、权限、回滚和
  // 归档状态覆盖到并发新值上。维护性迁移只能拥有路径字段，并用旧路径做 CAS。
  const result = db
    .prepare(
      `update session
       set directory = ?, path = ?, time_updated = max(time_updated, ?)
       where id = ?
         and workspace_id = ?
         and directory = ?
         and ((? is null and path is null) or path = ?)`,
    )
    .run(
      input.directory,
      input.path,
      input.timeUpdated,
      input.sessionID,
      input.workspaceID,
      input.expectedDirectory,
      input.expectedPath,
      input.expectedPath,
    );
  return Number(result.changes) === 1;
}

export async function setRevert(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  },
): Promise<void> {
  await updateSession(db, {
    id: input.sessionID,
    revert: input.revert,
    summary: input.summary
      ? {
          additions: input.summary.additions,
          deletions: input.summary.deletions,
          files: input.summary.files,
          diffs: input.summary.diffs,
        }
      : undefined,
  });
}

export async function clearRevert(db: DatabaseSync, sessionID: SessionId): Promise<void> {
  await updateSession(db, {
    id: sessionID,
    revert: null,
    summary: null,
  });
}

export function touchSession(db: DatabaseSync, sessionID: SessionId, timeUpdated: number): void {
  db.prepare("update session set time_updated = max(time_updated, ?) where id = ?").run(
    timeUpdated,
    sessionID,
  );
}

function normalizeSessionTaskTypes(taskTypes: readonly SessionTaskType[] | undefined): string[] {
  if (!taskTypes || taskTypes.length === 0) return [];
  const valid = new Set<string>(SESSION_TASK_TYPES);
  return [...new Set(taskTypes.filter((taskType) => valid.has(taskType)))];
}

function mustGetSession(db: DatabaseSync, sessionID: SessionId): SessionInfo {
  const session = getSession(db, sessionID);
  if (!session) {
    throw new Error(`Session not found after write: ${sessionID}`);
  }
  return session;
}

/** 所有进程共享删除屏障。进程存在但状态不明时保守拒绝，不用超时猜它已经退出。 */
export function inspectSessionDeletion(
  db: DatabaseSync,
  root: SessionId,
  ownerId: string,
): SessionDeletionSnapshot {
  const receipt = db
    .prepare(
      "select session_id,retained_artifacts,state from session_purge where root_id=? order by session_id",
    )
    .all(root) as Array<{ session_id: SessionId; retained_artifacts: string; state: string }>;
  const ids = receipt.length
    ? receipt.map((row) => row.session_id)
    : (listOwnedSessionTrees(db, [root]).get(root) ?? []);
  const inside = new Set<string>(ids);
  const forks: SessionDeletionSnapshot["forks"] = [];
  if (ids.length)
    for (const row of db
      .prepare(
        "select id as sessionId,title,parent_id from session where time_deleted is null order by id",
      )
      .iterate() as Iterable<{ sessionId: SessionId; title: string; parent_id: string | null }>) {
      if (row.parent_id && inside.has(row.parent_id) && !inside.has(row.sessionId))
        forks.push({ sessionId: row.sessionId, title: row.title });
    }
  const references = new Map<string, SessionDeletionReference>();
  // 引用可能藏在旧分支、输入队列、工具结果或工作流元数据，不能只按 fork 谱系查。
  const sources = [
    ["part", "session_id", "data"],
    ["message", "session_id", "data"],
    ["session_input", "session_id", "payload"],
    ["session_entry", "session_id", "data"],
    ["session", "id", "revert"],
    ["input_history", "session_id", "attachments"],
  ] as const;
  const queries = sources.map(
    ([table, id, data]) =>
      `select t.${id} as session_id,t.${data} as body,s.title from ${table} t join session s on s.id=t.${id} where s.time_deleted is null and instr(t.${data}, 'zcode-artifact://')>0`,
  );
  // 工作流 journal 里的产物不一定进入消息 part，必须沿 run 的会话归属检查。
  for (const [table, owner, columns] of [
    ["dwf_run", null, ["args_json", "result_json", "failure_json"]],
    ["workflow_run", null, ["args_json", "stats_json", "failure_json"]],
    ["dwf_node", "dwf_run", ["input_json", "result_json", "error_json"]],
    ["dwf_event", "dwf_run", ["payload_json"]],
    ["dwf_actor", "dwf_run", ["persona_json"]],
    ["workflow_activity", "workflow_run", ["prompt", "opts_json", "result_json", "error_json"]],
    ["workflow_event", "workflow_run", ["payload_json"]],
  ] as const) {
    const body = columns.map((column) => `coalesce(t.${column},'')`).join(" || ' ' || ");
    queries.push(
      `select s.id as session_id,${body} as body,s.title from ${table} t ${owner ? `join ${owner} r on r.id=t.run_id` : ""} join session s on s.id=${owner ? "r" : "t"}.parent_session_id where s.time_deleted is null and instr(${body},'zcode-artifact://')>0`,
    );
  }
  for (const query of queries) {
    const rows = db.prepare(query).iterate() as Iterable<{
      session_id: SessionId;
      body: string;
      title: string;
    }>;
    for (const row of rows) {
      if (inside.has(row.session_id)) continue;
      for (const match of row.body.matchAll(/zcode-artifact:\/\/([^/"\\\s]+)\/([^"\\\s/?#]+)/g)) {
        const sessionId = decodeURIComponent(match[1]!) as SessionId;
        const artifactId = decodeURIComponent(match[2]!);
        if (!inside.has(sessionId)) continue;
        const key = `${sessionId}/${artifactId}`;
        const entry = references.get(key) ?? { sessionId, artifactId, referrers: [] };
        if (!entry.referrers.some((ref) => ref.sessionId === row.session_id))
          entry.referrers.push({ sessionId: row.session_id, title: row.title });
        references.set(key, entry);
      }
    }
  }
  if (receipt.length)
    for (const row of receipt)
      for (const artifactId of JSON.parse(row.retained_artifacts) as string[]) {
        const key = `${row.session_id}/${artifactId}`;
        if (!references.has(key))
          references.set(key, { sessionId: row.session_id, artifactId, referrers: [] });
      }
  let foreignRuntime = false;
  const localRuntimeIds: SessionId[] = [];
  for (const row of db
    .prepare("select session_id,owner_id,process_id from session_runtime_presence")
    .all() as Array<{ session_id: string; owner_id: string; process_id: number }>) {
    if (!inside.has(row.session_id)) continue;
    if (row.owner_id === ownerId) {
      localRuntimeIds.push(row.session_id as SessionId);
      continue;
    }
    let alive = true;
    try {
      process.kill(row.process_id, 0);
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    if (alive) foreignRuntime = true;
    else
      db.prepare("delete from session_runtime_presence where session_id=? and owner_id=?").run(
        row.session_id,
        row.owner_id,
      );
  }
  const pendingWork =
    !receipt.length &&
    ids.some((id) =>
      Boolean(
        db
          .prepare("select 1 from session_input where session_id=? and status='admitted' limit 1")
          .get(id) ||
        db
          .prepare("select 1 from session_target where session_id=? and status='active' limit 1")
          .get(id),
      ),
    );
  const orderedReferences = [...references.values()].sort((a, b) =>
    `${a.sessionId}/${a.artifactId}`.localeCompare(`${b.sessionId}/${b.artifactId}`),
  );
  for (const ref of orderedReferences)
    ref.referrers.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const facts = ids.map((id) =>
    db.prepare("select id,time_updated,time_deleted from session where id=?").get(id),
  );
  const revision = createHash("sha256")
    .update(JSON.stringify({ ids, facts, forks, references: orderedReferences, pendingWork }))
    .digest("hex");
  const workspace =
    db
      .prepare("select directory as path,workspace_id as identity from session where id=?")
      .get(root) ??
    db
      .prepare(
        "select workspace_path as path,workspace_identity as identity from session_purge where session_id=?",
      )
      .get(root);
  return {
    workspacePath: workspace?.path as string | undefined,
    workspaceIdentity: (workspace?.identity ?? undefined) as string | undefined,
    revision,
    sessionIds: ids,
    forks,
    references: orderedReferences,
    foreignRuntime,
    localRuntimeIds,
    pendingWork,
    deleting: receipt.some((row) => row.state === "deleting"),
    completed: receipt.length > 0 && receipt.every((row) => row.state === "deleted"),
  };
}

export function beginSessionDeletion(
  db: DatabaseSync,
  root: SessionId,
  ownerId: string,
  revision: string,
  operationId: string,
  retained: Array<{ sessionId: SessionId; artifactId: string }>,
): void {
  db.exec("begin immediate");
  try {
    const snapshot = inspectSessionDeletion(db, root, ownerId);
    if (snapshot.foreignRuntime || snapshot.pendingWork)
      throw Object.assign(new Error("session-data.running"), { code: "running" });
    if (!snapshot.deleting && !snapshot.completed) {
      if (snapshot.revision !== revision || !snapshot.sessionIds.length)
        throw Object.assign(new Error("session-data.changed"), { code: "changed" });
      const insert = db.prepare(
        "insert into session_purge(session_id,root_id,operation_id,retained_artifacts,workspace_path,workspace_identity,state) values(?,?,?,?,?,?,'deleting')",
      );
      for (const id of snapshot.sessionIds)
        insert.run(
          id,
          root,
          operationId,
          JSON.stringify(
            retained.filter((ref) => ref.sessionId === id).map((ref) => ref.artifactId),
          ),
          snapshot.workspacePath ?? "",
          snapshot.workspaceIdentity ?? null,
        );
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function completeSessionDeletion(db: DatabaseSync, root: SessionId): void {
  // 文件已清理后才删除正文。凭据独立于 session，重启和旧 create/upsert 不能复活同一 ID。
  const ids = db
    .prepare("select session_id from session_purge where root_id=?")
    .all(root) as Array<{ session_id: SessionId }>;
  purgeSessions(
    db,
    ids.map((row) => row.session_id),
  );
  db.prepare("update session_purge set state='deleted' where root_id=?").run(root);
}
