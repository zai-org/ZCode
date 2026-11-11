import type { DatabaseSync } from "node:sqlite";

export const PROJECT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hosts (
 host_id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_json TEXT, membership_id TEXT,
 position INTEGER NOT NULL DEFAULT 0, last_connection_status TEXT, last_connection_error TEXT, last_opened_at INTEGER);
CREATE TABLE IF NOT EXISTS projects (
 project_id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(host_id), name TEXT NOT NULL,
 name_overridden INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
 pinned_at INTEGER, deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS project_roots (
 project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
 root_path TEXT NOT NULL, position INTEGER NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(project_id,root_path));
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_host_name ON projects(host_id,name) WHERE deleted=0;
CREATE TABLE IF NOT EXISTS remote_project_entries (
 entry_id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
 remote_project_id TEXT, cached_name TEXT NOT NULL, cached_roots_json TEXT NOT NULL DEFAULT '[]',
 legacy_workspace_json TEXT, last_synced_at INTEGER, UNIQUE(host_id,remote_project_id));
`;

/** 远端项目删除态缓存；在线刷新写入，离线回退读取，避免已删项目以缓存行复现。 */
export const REMOTE_ENTRY_DELETED_CACHE_SQL =
  "ALTER TABLE remote_project_entries ADD COLUMN cached_deleted INTEGER NOT NULL DEFAULT 0";

export const TASK_PROJECT_COLUMNS: Readonly<Record<string, string>> = {
  host_id: "TEXT",
  root_path: "TEXT",
  project_id: "TEXT",
  execution_directories: "TEXT",
  sort_order: "INTEGER",
  cli_title: "TEXT",
  handoff_pending: "INTEGER NOT NULL DEFAULT 0",
  cli_title_source: "TEXT",
  cli_created_at: "INTEGER",
  cli_updated_at: "INTEGER",
  cli_last_outcome: "TEXT",
  cli_deleted: "INTEGER",
};

export const PROJECT_MIGRATION_TABLES = [
  "tasks",
  "task_groups",
  "task_group_members",
  "task_group_view_node_orders",
  "task_group_workspace_bootstraps",
  "automations",
  "off_peak_tasks",
  "hosts",
  "projects",
  "project_roots",
  "remote_project_entries",
] as const;

export function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
  );
}

function ensureColumns(
  db: DatabaseSync,
  table: string,
  columns: Readonly<Record<string, string>>,
): void {
  if (!tableExists(db, table)) return;
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
  );
  for (const [column, definition] of Object.entries(columns)) {
    if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function addProjectSchema(db: DatabaseSync): void {
  db.exec(PROJECT_SCHEMA_SQL);
  ensureColumns(db, "hosts", { membership_id: "TEXT" });
  ensureColumns(db, "tasks", TASK_PROJECT_COLUMNS);
  for (const table of ["automations", "off_peak_tasks"]) {
    ensureColumns(db, table, {
      project_id: "TEXT",
      host_id: "TEXT",
      additional_directories: "TEXT",
    });
  }
  if (tableExists(db, "tasks"))
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id,archived,cli_updated_at DESC) WHERE deleted=0",
    );
}
/** 旧客户端没有预分配 ID；身份分配与任务预留必须共用事务，重启不能重新生成。 */
export const SESSION_CREATION_COMMANDS_SQL = `
CREATE TABLE IF NOT EXISTS session_creation_commands (
  workspace_key TEXT NOT NULL,
  client_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (workspace_key, client_id, command_id)
);`;

/**
 * 受管 worktree 任务的 worktree 根目录（docs/git/worktree.md §6.6.1）。只由 Host 在
 * reserveCreatedTask 时与 root_path 一起写入一次；NULL 表示不是 worktree 任务。
 * 部分索引供"哪些任务在用这个 worktree"精确匹配，旧行全部为 NULL，不需要回填。
 */
export const TASK_WORKTREE_ROOT_SQL = `
ALTER TABLE tasks ADD COLUMN worktree_root TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_host_worktree ON tasks(host_id, worktree_root) WHERE worktree_root IS NOT NULL;`;
