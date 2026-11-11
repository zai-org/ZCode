import type { DatabaseSync } from "node:sqlite";
import {
  resolveWorkspaceKey,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import { tableExists } from "#src/project-storage/schema.js";

export const HANDOFF_DELETE = 1;
export const HANDOFF_TITLE = 2;
export const HANDOFF_ORPHAN = 4;
export const OWNERSHIP_DECIDED = 8;

export function hostForWorkspace(workspaceKey: string): { hostId: string; kind: string } {
  const parsed = parseRemoteWorkspaceIdentity(workspaceKey);
  return {
    hostId: remoteHostIdFromWorkspaceIdentity(workspaceKey) ?? "local",
    kind: parsed?.kind ?? "local",
  };
}

export function ensureHost(db: DatabaseSync, workspaceKey: string, ownerHostId?: string): string {
  const { hostId, kind } = ownerHostId
    ? { hostId: ownerHostId, kind: ownerHostId === "local" ? "local" : "server" }
    : hostForWorkspace(workspaceKey);
  db.prepare(
    "INSERT OR IGNORE INTO hosts(host_id,kind,position) VALUES(?,?,(SELECT count(*) FROM hosts))",
  ).run(hostId, kind);
  return hostId;
}

export function uniqueRootProject(
  db: DatabaseSync,
  hostId: string,
  rootPath: string,
): string | null {
  const projects = db
    .prepare(`SELECT p.project_id FROM projects p JOIN project_roots r USING(project_id)
    WHERE p.host_id=? AND p.deleted=0 AND r.root_path=? LIMIT 2`)
    .all(hostId, rootPath) as { project_id: string }[];
  return projects.length === 1 ? projects[0]!.project_id : null;
}

/** 同一 workspace 的持久化父事实优先于目录匹配；父引用缺失时不能退回目录猜测。 */
function discoveredProject(
  db: DatabaseSync,
  row: {
    workspace_key: string;
    task_id: string;
    root_path: string;
    host_id: string;
    forked_from_task_id?: string | null;
  },
): string | null {
  if (row.forked_from_task_id) {
    const parent = db
      .prepare(`SELECT t.project_id FROM tasks t JOIN projects p USING(project_id)
      WHERE t.workspace_key=? AND t.task_id=? AND t.host_id=? AND t.root_path=?
      AND p.host_id=t.host_id AND t.deleted=0 AND coalesce(t.cli_deleted,0)=0
      AND (t.host_id='local' OR ((SELECT count(*) FROM project_roots WHERE project_id=p.project_id)=1
        AND EXISTS(SELECT 1 FROM project_roots WHERE project_id=p.project_id AND root_path=t.root_path)))`)
      .get(row.workspace_key, row.forked_from_task_id, row.host_id, row.root_path);
    return parent?.project_id ? String(parent.project_id) : null;
  }
  const project = uniqueRootProject(db, row.host_id, row.root_path);
  // 历史远端多 root 项目不符合当前打开门禁，不能把 NULL 修成另一个无效归属。
  if (
    project &&
    row.host_id !== "local" &&
    db.prepare("SELECT count(*) AS count FROM project_roots WHERE project_id=?").get(project)
      ?.count !== 1
  )
    return null;
  return project;
}

export const REMOTE_TASK_OWNERSHIP_MIGRATION =
  "remote NULL ownership v1: exact parent first, otherwise unique active root; preserve local and assigned rows";

/** 仅数据迁移：已启用远端项目门禁的 NULL 属于未完成交接，不是本地合法未归类。 */
export function repairRemoteTaskOwnership(db: DatabaseSync): void {
  if (!tableExists(db, "tasks")) return;
  // 嵌套 fork 的输入顺序不确定；每次只补 NULL，写入数为零即停止，不依赖时间或重试超时。
  let changed: number;
  do {
    changed = 0;
    const rows = db
      .prepare(`SELECT workspace_key,task_id,root_path,host_id,forked_from_task_id
      FROM tasks WHERE host_id<>'local' AND project_id IS NULL AND deleted=0 AND coalesce(cli_deleted,0)=0`)
      .all() as Array<{
      workspace_key: string;
      task_id: string;
      root_path: string;
      host_id: string;
      forked_from_task_id: string | null;
    }>;
    for (const row of rows) {
      const project = discoveredProject(db, row);
      if (project)
        changed += Number(
          db
            .prepare(`UPDATE tasks SET project_id=?,handoff_pending=handoff_pending | ?
        WHERE workspace_key=? AND task_id=? AND project_id IS NULL`)
            .run(project, OWNERSHIP_DECIDED, row.workspace_key, row.task_id).changes,
        );
    }
  } while (changed > 0);
}

export function initializeLegacyTaskIdentity(
  db: DatabaseSync,
  assignProject: boolean,
  ownerHostId?: string,
): void {
  if (!tableExists(db, "tasks")) return;
  const rows = db
    .prepare(
      "SELECT workspace_key,workspace_path,task_id,project_id FROM tasks WHERE host_id IS NULL",
    )
    .all() as {
    workspace_key: string;
    workspace_path: string;
    task_id: string;
    project_id: string | null;
  }[];
  const update = db.prepare(`UPDATE tasks SET host_id=?,root_path=workspace_path,project_id=?,
    cli_title=title,cli_title_source=CASE WHEN title_overridden=1 THEN 'custom' ELSE 'default' END,
    cli_created_at=created_at,cli_updated_at=updated_at,
    cli_last_outcome=CASE WHEN task_status='error' THEN 'error' WHEN task_status='interrupted' THEN 'interrupted' WHEN task_status='completed' THEN 'completed' ELSE NULL END,
    cli_deleted=0,handoff_pending=handoff_pending | ? | CASE WHEN deleted=1 THEN 1 ELSE 0 END | CASE WHEN title_overridden=1 THEN 2 ELSE 0 END
    WHERE workspace_key=? AND task_id=? AND host_id IS NULL`);
  for (const row of rows) {
    const hostId = ensureHost(db, row.workspace_key, ownerHostId);
    const projectId =
      row.project_id ?? (assignProject ? uniqueRootProject(db, hostId, row.workspace_path) : null);
    update.run(
      hostId,
      projectId,
      assignProject ? OWNERSHIP_DECIDED : 0,
      row.workspace_key,
      row.task_id,
    );
  }
}

function initializeLegacyDefinitions(db: DatabaseSync, ownerHostId?: string): void {
  for (const table of ["automations", "off_peak_tasks"]) {
    if (!tableExists(db, table)) continue;
    const rows = db
      .prepare(
        `SELECT DISTINCT workspace_key,workspace_path,project_id FROM ${table} WHERE host_id IS NULL`,
      )
      .all() as {
      workspace_key: string;
      workspace_path: string;
      project_id: string | null;
    }[];
    const update =
      db.prepare(`UPDATE ${table} SET host_id=?,project_id=?,additional_directories=coalesce(additional_directories,'[]')
      WHERE workspace_key=? AND workspace_path=? AND host_id IS NULL`);
    for (const row of rows) {
      const hostId = ensureHost(db, row.workspace_key, ownerHostId);
      // 原因：旧版本新增定义不会重跑 v3 migration；host_id 标识一次性交接，不能重算合法 NULL 归属。
      // 旧版只有 cwd，附加目录保持 []，不因当前项目 roots 扩大既有自动执行范围。
      update.run(
        hostId,
        row.project_id ?? uniqueRootProject(db, hostId, row.workspace_path),
        row.workspace_key,
        row.workspace_path,
      );
    }
  }
}

export function reconcileLegacy(db: DatabaseSync, ownerHostId?: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    // Bug 原因：同一台机器上本机桌面与 Source Server 共用 tasks-index；0005 按库只执行一次，
    // 只写入首个打开者的 host 行，后打开的 owner 新建项目触发 projects.host_id 外键失败。
    // 每次启动幂等补齐当前 owner 的 host 行；不改任务 host_id 与项目归属。
    ensureHost(db, "local", ownerHostId);
    initializeLegacyTaskIdentity(db, true, ownerHostId);
    initializeLegacyDefinitions(db, ownerHostId);
    if (tableExists(db, "tasks")) {
      db.exec(`UPDATE tasks SET handoff_pending=handoff_pending | ${HANDOFF_DELETE} WHERE deleted=1 AND coalesce(cli_deleted,0)=0;
        UPDATE tasks SET handoff_pending=handoff_pending | ${HANDOFF_TITLE}
        WHERE title_overridden=1 AND (coalesce(cli_title_source,'')<>'custom' OR coalesce(cli_title,'')<>title);`);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** 父任务运行在受管 worktree 中时，同目录 fork 子任务行要继承的位置（docs/git/worktree.md §3.6）。 */
export interface InheritedWorktreePlacement {
  rootPath: string;
  worktreeRoot: string;
  executionDirectories: string | null;
}

/**
 * 同目录 fork 子任务的 cwd 唯一来自父行。子任务行有两个首次写入点（CLI 首次上报、App Control
 * 分叉预留），两处都在各自写事务中调用这里；父任务不在 worktree 中时返回 null，沿用普通规则。
 * 附加目录一并继承，避免按项目 roots 推导时把源仓库交给 worktree 任务（I3）。
 */
export function readInheritedWorktreePlacement(
  db: DatabaseSync,
  parent: { workspaceKey: string; hostId: string; taskId: string },
): InheritedWorktreePlacement | null {
  const row = db
    .prepare(
      "SELECT root_path,worktree_root,execution_directories FROM tasks WHERE workspace_key=? AND task_id=? AND host_id=?",
    )
    .get(parent.workspaceKey, parent.taskId, parent.hostId) as
    | {
        root_path: string | null;
        worktree_root: string | null;
        execution_directories: string | null;
      }
    | undefined;
  if (!row || row.worktree_root === null || row.root_path === null) return null;
  return {
    rootPath: row.root_path,
    worktreeRoot: row.worktree_root,
    executionDirectories: row.execution_directories,
  };
}

/** 新版本插入身份和首次归属，不借旧列生成 CLI 事实。调用方与 INSERT 共用写事务。 */
export function admitTaskIdentity(
  db: DatabaseSync,
  task: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    forkedFromTaskId?: string;
  },
  ownerHostId?: string,
): void {
  const key = resolveWorkspaceKey(task);
  const hostId = ensureHost(db, key, ownerHostId);
  // 已接纳的归属（含 NULL）只由用户组织操作改变；重复事实不能重新继承父项目。
  const existing = db
    .prepare(
      "SELECT host_id,project_id,handoff_pending,forked_from_task_id FROM tasks WHERE workspace_key=? AND task_id=?",
    )
    .get(key, task.taskId) as
    | {
        host_id: string | null;
        project_id: string | null;
        handoff_pending: number;
        forked_from_task_id: string | null;
      }
    | undefined;
  if (!existing) return;
  if (existing.host_id != null) {
    // 已判定的 NULL 是用户组织态；只补齐同一远端 owner 尚未完成判定的历史交接。
    if (
      existing.host_id !== hostId ||
      hostId === "local" ||
      existing.project_id != null ||
      (existing.handoff_pending & OWNERSHIP_DECIDED) !== 0
    )
      return;
    const projectId = discoveredProject(db, {
      workspace_key: key,
      task_id: task.taskId,
      root_path: task.workspacePath,
      host_id: hostId,
      forked_from_task_id: existing.forked_from_task_id,
    });
    if (projectId)
      db.prepare(`UPDATE tasks SET project_id=?,handoff_pending=handoff_pending | ?
      WHERE workspace_key=? AND task_id=? AND host_id=? AND project_id IS NULL AND (handoff_pending & ?)=0`).run(
        projectId,
        OWNERSHIP_DECIDED,
        key,
        task.taskId,
        hostId,
        OWNERSHIP_DECIDED,
      );
    return;
  }

  let projectId: string | null;
  // 同目录 fork 的子会话与父会话共用 cwd；父任务在受管 worktree 中时，cwd 不等于 workspace_path。
  let worktreePlacement: InheritedWorktreePlacement | null = null;
  if (task.forkedFromTaskId) {
    // Bug 原因：共享 cwd 的项目不唯一，按 root 推断会丢失 fork 归属；父行是唯一事实源。
    // 与子行 INSERT 共用事务，限制同 Host/workspace；父归属不可用时回滚，不能固化为 NULL。
    const parent = db
      .prepare(`SELECT t.project_id,p.project_id AS resolved_project_id
      FROM tasks t LEFT JOIN projects p ON p.project_id=t.project_id AND p.host_id=t.host_id
      WHERE t.workspace_key=? AND t.task_id=? AND t.host_id=? AND (t.handoff_pending & ?)<>0`)
      .get(key, task.forkedFromTaskId, hostId, OWNERSHIP_DECIDED) as
      | { project_id: string | null; resolved_project_id: string | null }
      | undefined;
    if (!parent || (parent.project_id !== null && parent.resolved_project_id === null))
      throw new Error(`Fork parent ownership is unavailable: ${task.forkedFromTaskId}`);
    projectId = parent.project_id;
    // Bug 原因：子行曾一律写 root_path=workspace_path，worktree 任务"在当前 worktree 中分叉"
    // 的子任务 cwd 被记成项目主目录，Git 面板、终端、文件树都作用到主目录，删除 worktree 时也
    // 看不到它。CLI 中子会话的 directory 继承父会话，Host 的 cwd 同样从父行继承（worktree.md §3.6）。
    worktreePlacement = readInheritedWorktreePlacement(db, {
      workspaceKey: key,
      hostId,
      taskId: task.forkedFromTaskId,
    });
  } else {
    projectId = uniqueRootProject(db, hostId, task.workspacePath);
  }
  if (worktreePlacement) {
    db.prepare(
      "UPDATE tasks SET host_id=?,root_path=?,worktree_root=?,execution_directories=?,project_id=?,handoff_pending=handoff_pending | ? WHERE workspace_key=? AND task_id=? AND host_id IS NULL",
    ).run(
      hostId,
      worktreePlacement.rootPath,
      worktreePlacement.worktreeRoot,
      worktreePlacement.executionDirectories,
      projectId,
      OWNERSHIP_DECIDED,
      key,
      task.taskId,
    );
    return;
  }
  db.prepare(
    "UPDATE tasks SET host_id=?,root_path=workspace_path,project_id=?,handoff_pending=handoff_pending | ? WHERE workspace_key=? AND task_id=? AND host_id IS NULL",
  ).run(hostId, projectId, OWNERSHIP_DECIDED, key, task.taskId);
  if (task.forkedFromTaskId) {
    // 首次事实与 ACK 任一先到，都继承父任务已经固化的执行目录。
    db.prepare(`UPDATE tasks SET execution_directories=(SELECT execution_directories FROM tasks
      WHERE workspace_key=? AND task_id=? AND host_id=? AND root_path=?)
      WHERE workspace_key=? AND task_id=? AND execution_directories IS NULL`).run(
      key,
      task.forkedFromTaskId,
      hostId,
      task.workspacePath,
      key,
      task.taskId,
    );
  }
}
