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
  /** 任务所属 workspace；worktree 任务是项目主目录，不是 cwd。 */
  workspacePath: string;
  /** 任务 cwd；只在与 workspacePath 不同时出现（受管 worktree 任务，docs/git/worktree.md §6.6.1）。 */
  cwd?: string;
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

  /** 单事务按 CLI 最后活动时间筛选，置顶与 activeTasks 除外；归档并暂停绑定定时任务，覆盖未归类 cwd。 */
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
  /**
   * 只读按创建命令查回执，不带 workspace：重试时项目主目录可能已变，回执及其任务行是重试的唯一事实源。
   * 返回每条回执对应任务的目录（cwd 创建后不变）；无回执返回空数组；回执指向的任务已不存在时报错。
   */
  findCreationReceipts(input: {
    creationCommand: { clientId: string; commandId: string };
  }): Array<{ sessionId: string; directories: ProjectDirectories }>;
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
          /**
           * worktree 任务的 cwd 与 worktree 根目录（docs/git/worktree.md §6.6.1），必须同时出现；
           * task.workspacePath 仍是项目 workspace。只在首次预留时写入，之后不变。
           */
          cwd?: string;
          worktreeRoot?: string;
          /**
           * 同目录 fork 的父任务 ID（App Control 分叉预留）。父任务在受管 worktree 中时，子任务行在同一
           * 事务中继承父行的 cwd、worktree 根与附加目录（docs/git/worktree.md §3.6）。
           */
          forkedFromTaskId?: string;
        }
      | { task: ProjectTaskRef; parentTaskId: string },
  ): ProjectDirectories & { taskId: string };
  /** 任务行记录的 cwd（`root_path`）；没有这一行时返回 null，不回退为 workspace 路径。 */
  readTaskCwd(task: ProjectTaskRef): string | null;
  /**
   * 撤销一条尚无 CLI 事实的创建预留及其创建回执（worktree 创建失败后"放弃"或"不使用 worktree"，
   * docs/git/worktree.md §3.5）。released = 已撤销；absent = 没有这一行；kept = 行已有 CLI 事实
   * （会话已存在），不删除。
   */
  releaseReservedTask(input: { task: ProjectTaskRef }): "released" | "absent" | "kept";
  /**
   * 只读：本 Host 上运行在指定受管 worktree 中的未删除任务（按 worktree_root 精确匹配），
   * 用于管理弹窗的"使用它的任务"与删除前占用检查（docs/git/worktree.md §6.6.1）。
   */
  listTasksByWorktree(input: {
    worktreeRoot: string;
  }): Array<ProjectTaskRef & { projectId: string | null; title: string; archived: boolean }>;
}
