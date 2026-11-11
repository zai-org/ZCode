import type { Event } from "@zcode/rpc";
import type {
  ManagedWorktreeCreation,
  ManagedWorktreeCreationSettlement,
  ManagedWorktreeEntry,
  ManagedWorktreeError,
  ManagedWorktreeStartRefs,
  RemoveManagedWorktreeResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "#src/descriptors.js";

export interface ManagedWorktreeGroup {
  sourceRoot: string;
  worktrees: ManagedWorktreeEntry[];
}

export interface ManagedWorktreeWorkspace {
  /** 任务所属 workspace（项目主目录）。 */
  workspacePath: string;
  workspaceIdentity?: string;
}

/** 启动创建的结果：成功时创建在后台进行，进度经 onDidChangeCreations 推送。 */
export type StartManagedWorktreeCreationResult =
  | { ok: true; creationId: string }
  | { ok: false; error: ManagedWorktreeError };

/**
 * 受管 worktree 的唯一管理者（docs/git/worktree.md §5.1）。仅本地桌面 Host。
 * worktree 事实 = git worktree list + 受管布局；任务归属 = tasks-index worktree_root；
 * 正在进行的创建 = 本服务内存中的创建记录。
 */
export interface IManagedWorktreeService {
  /**
   * 新建任务：在项目主目录所在仓库创建 worktree，再在项目 workspace 下创建会话并发送首条消息。
   * envelope 必须是带 firstInput 的 createSession；ref 为 null 时从主目录当前 HEAD 检出。
   */
  startNewTask(
    params: ManagedWorktreeWorkspace & {
      projectId: string;
      ref: string | null;
      envelope: CommandEnvelope;
    },
  ): Promise<StartManagedWorktreeCreationResult>;
  /** fork 到新 worktree：起点为父任务 cwd 的 HEAD；envelope 必须是 forkAssistant。 */
  forkToWorktree(
    params: ManagedWorktreeWorkspace & { envelope: CommandEnvelope },
  ): Promise<StartManagedWorktreeCreationResult>;
  /** 失败后重试：worktree 已建好时只重做会话创建，否则重新创建 worktree。 */
  retryCreation(params: { creationId: string }): Promise<void>;
  /** 失败后改在项目主目录创建会话并发送首条消息（只用于新建任务）。 */
  continueWithoutWorktree(params: { creationId: string }): Promise<void>;
  /** 失败后放弃：删除残留 worktree 与记录；新建任务的首条消息经 settlement 交还给草稿。 */
  dismissCreation(params: { creationId: string }): Promise<void>;
  listCreations(): Promise<ManagedWorktreeCreation[]>;
  /** 创建记录集合变化时推送完整列表（创建记录是唯一数据源，renderer 不推算）。 */
  onDidChangeCreations: Event<ManagedWorktreeCreation[]>;
  /** 一次创建结束（会话已启动或已放弃）。 */
  onDidSettleCreation: Event<ManagedWorktreeCreationSettlement>;

  listWorktrees(params: { projectId: string }): Promise<{ groups: ManagedWorktreeGroup[] }>;
  /** 占用检查通过后删除；force 只允许用于没有任务使用的残留 worktree（§3.11）。 */
  removeWorktree(params: {
    projectId: string;
    path: string;
    force?: boolean;
  }): Promise<RemoveManagedWorktreeResult>;
  /** 清理目录已被手动删除的登记。 */
  pruneWorktrees(params: { projectId: string; sourceRoot: string }): Promise<void>;
  /** worktree 模式下分支胶囊的候选（项目主目录所在仓库），不执行 fetch。 */
  listStartRefs(params: { projectId: string }): Promise<ManagedWorktreeStartRefs | null>;
  /**
   * 任务的 worktree 是否仍可用（目录存在且仍是受管 worktree）。删除后任务按
   * "工作区目录失效"规则只读（§3.12）；判断依据是任务的 worktree，不是 workspace。
   */
  isWorktreeAvailable(params: { worktreeRoot: string }): Promise<boolean>;
  /** workspace 的 CLI 是否支持会话 cwd 与 workspace 不同；不支持时 UI 禁用入口。 */
  supportsWorktreeCwd(params: ManagedWorktreeWorkspace): Promise<boolean>;
}

export const IManagedWorktreeService = createServiceDescriptor<IManagedWorktreeService>(
  ServiceChannels.ManagedWorktrees,
);
