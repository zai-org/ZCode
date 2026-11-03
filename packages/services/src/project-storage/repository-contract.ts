export interface ProjectRoot {
  rootPath: string;
  position: number;
  isPrimary: boolean;
}
export interface VirtualProject {
  /** 所属 Host 异步探测的只读投影，不写入项目数据库或远端入口缓存；旧 Server 可省略。 */
  primaryRootStatus?: "available" | "missing" | "unavailable";
  /** 旧 Server 的只读单 root 投影，不是本机持久化项目。 */
  legacySingleRoot?: true;
  /** 旧单 root 按所属 Host 规则派生的目录匹配值；不落库，不改变原 root、项目 ID 或任务 cwd。 */
  directoryMatchPath?: string;
  id: string;
  hostId: string;
  name: string;
  nameOverridden: boolean;
  roots: ProjectRoot[];
  position: number;
  pinned: boolean;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface ProjectTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}
export type ProjectTask = import("@zcode/shared").ZCodeTaskMeta & {
  projectId: string | null;
  hostId: string;
  pinned: boolean;
  archived: boolean;
};
export interface ProjectTree {
  legacySingleRoot?: true;
  projects: VirtualProject[];
  tasks: ProjectTask[];
  /** 仅显式请求时返回删除事实；离线缺席不能替代这些引用。 */
  deletedTasks?: Array<ProjectTaskRef & { hostId: string }>;
}

export const LEGACY_SINGLE_ROOT_PROJECT_PREFIX = "legacy-single-root:";
export interface SaveProjectInput {
  /** 显式本地单目录打开：同事务复用未删除项目或创建，不修改匹配项目。 */
  reuseExistingRoot?: boolean;
  id?: string;
  hostId?: string;
  name?: string;
  defaultName?: string;
  roots?: string[];
  primaryRoot?: string;
  pinned?: boolean;
  restoreProjectId?: string;
}
export interface ProjectDirectories {
  workspacePath: string;
  /** 远端装配层登记后的 attachment 身份；执行仍使用 workspacePath。 */
  workspaceIdentity?: string;
  additionalDirectories: string[];
  projectId: string | null;
}
export interface AutoArchiveInput {
  cutoff: number;
  activeTasks: readonly ProjectTaskRef[];
}

/** 项目组织态仓储契约；迁移与装配契约保留在 contract.ts，公开导入路径不变。 */
export interface ProjectRepositoryContract {
  /** CLI 首次分配时读取目录关联；软删项目及已移除 root 的历史任务仍保留项目归属。 */
  hasProjectWorkspace(workspace: { workspacePath: string; workspaceIdentity?: string }): boolean;

  /** 单事务纯按 CLI 最后活动时间筛选，置顶与 activeTasks 除外，仅写组织态；覆盖未归类 cwd。 */
  archiveInactive(input: AutoArchiveInput): ProjectTaskRef[];
  /** 可只取目录，并参与调用方已有的 SQLite 读快照。 */
  readTree(options?: {
    includeDeleted?: boolean;
    includeDeletedTasks?: boolean;
    includeTasks?: boolean;
  }): ProjectTree;
  saveProject(input: SaveProjectInput): VirtualProject;
  deleteProject(id: string): void;
  /** 在写事务内只为空项目初始化 root；并发编辑已添加的目录优先。 */
  initializeProjectRoot(id: string, path: string): VirtualProject;
  moveTask(input: { task: ProjectTaskRef; projectId: string; addMissingRoot?: boolean }): void;
  reorderProjects(ids: string[]): void;
  resolveSessionDirectories(task: ProjectTaskRef): ProjectDirectories;
  /** 普通创建在 CLI 首发前预留；fork 按 parentTaskId 在 ACK 返回前继承。无事实行不进入列表，重试不覆盖组织操作。 */
  reserveCreatedTask(
    input:
      | {
          task: Omit<ProjectTaskRef, "taskId"> & { taskId?: string };
          projectId: string | null;
          /** 创建身份回执；不承担 CLI 命令执行或 ACK 裁决。 */
          creationCommand?: { clientId: string; commandId: string };
          /** Host 已固化的执行目录；首次预留持久化，重试不改。undefined 为普通新建。 */
          additionalDirectories?: string[];
        }
      | { task: ProjectTaskRef; parentTaskId: string },
  ): ProjectDirectories & { taskId: string };
}
