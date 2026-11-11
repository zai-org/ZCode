import type { Locale } from "./protocol.js";

export type GitHeadRefType = "branch" | "detached";

export type GitChangeKind = "modified" | "added" | "deleted" | "renamed";

export type GitChangeSourceId = "unstaged" | "staged" | "branch" | "last-turn";

export type GitRepositoryChangeSourceId = Extract<
  GitChangeSourceId,
  "unstaged" | "staged" | "branch"
>;

export type GitChangeSectionId =
  | "staged"
  | "unstaged"
  | "untracked"
  | "conflicted"
  | "branch"
  | "last-turn";

export type GitDiffAvailability = "patch" | "binary" | "truncated" | "unavailable";

export type GitBranchMutationAction = "switch" | "create-and-switch";

export type GitBranchMutationIssueCode =
  | "invalid-branch-name"
  | "branch-already-exists"
  | "target-branch-not-found"
  | "tracked-changes-would-be-overwritten"
  | "untracked-changes-would-be-overwritten"
  | "conflicts-present"
  | "operation-in-progress"
  | "branch-in-other-worktree"
  | "unknown";

export interface GitRepositorySummary {
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  /** Git 元数据 watcher 边界；workspace 内容 watcher 由 UI 按 workspace Host 平台决定。 */
  autoRefreshWatchPaths: GitRepositoryAutoRefreshWatchPath[];
  branchName: string | null;
  trackingBranchName: string | null;
  headRefType: GitHeadRefType;
  ahead: number;
  behind: number;
  isDirty: boolean;
  isGitAvailable: boolean;
  isRepository: boolean;
}

export interface GitRepositoryAutoRefreshWatchPath {
  path: string;
  recursive: boolean;
}

export interface GitFileChange {
  path: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  x?: string;
  y?: string;
  kind: GitChangeKind;
  section: GitChangeSectionId;
  added: number;
  removed: number;
  isStaged: boolean;
  isUntracked: boolean;
  isConflicted: boolean;
}

export interface GitDiffRequest {
  path: string;
  staged?: boolean;
  sourceId?: GitChangeSourceId;
}

export interface GitDiffResult {
  path: string;
  availability: GitDiffAvailability;
  patch: string | null;
  beforeContent: string | null;
  afterContent: string | null;
  summary?: string | null;
}

export interface GitIdentity {
  userName: string | null;
  userEmail: string | null;
  nameSource: string | null;
  emailSource: string | null;
  scopeLabel?: string | null;
}

export interface GitRepositoryRequest {
  workspacePath: string;
}

export type GitCommitGraphRefKind = "branch" | "remote" | "tag" | "head";

export interface GitCommitGraphRef {
  name: string;
  kind: GitCommitGraphRefKind;
}

export interface GitCommitGraphCommit {
  hash: string;
  parents: string[];
  refs: GitCommitGraphRef[];
  subject: string;
  authorName: string | null;
  authoredAtMs: number | null;
}

export interface GitCommitGraphRequest extends GitRepositoryRequest {
  maxCount?: number;
  skip?: number;
}

export interface GitCommitGraphResult {
  commits: GitCommitGraphCommit[];
  hasMore: boolean;
}

export interface GitRefreshRequest extends GitRepositoryRequest {
  includeIdentity?: boolean;
  includeBranchComparison?: boolean;
}

export type GitWorkspaceRepositoryKind = "not-repository" | "main-tree" | "linked-worktree";

export interface GitWorkspaceRepositoryInfo {
  workspacePath: string;
  kind: GitWorkspaceRepositoryKind;
  isGitAvailable: boolean;
}

// ── 受管 worktree（docs/git/worktree.md）──
// 唯一事实源是 `git worktree list` + 受管目录布局；这里只描述读出的结果，不保存副本。

export type ManagedWorktreeState = "ok" | "missing";

export interface ManagedWorktreeInfo {
  /** worktree 根目录。 */
  path: string;
  /** 受管根目录下的 4 位 hex bucket。 */
  bucket: string;
  /** 源仓库 toplevel。 */
  sourceRoot: string;
  /** HEAD SHA；目录缺失时为 null。 */
  head: string | null;
  /** detached 时为 null。 */
  branchName: string | null;
  /** missing = git 仍登记但目录已不存在（prunable）。 */
  state: ManagedWorktreeState;
  /** 有未提交改动或未跟踪文件；目录缺失时为 null。 */
  dirty: boolean | null;
}

/** 管理弹窗中一行 worktree：git 事实 + 使用它的任务（docs/git/worktree.md §3.10）。 */
export interface ManagedWorktreeEntry extends ManagedWorktreeInfo {
  /** 正在被一条创建记录占用；此时不显示删除按钮。 */
  creating: boolean;
  tasks: ManagedWorktreeTaskRef[];
}

export interface ManagedWorktreeTaskRef {
  taskId: string;
  /** 任务所属 workspace（项目主目录），打开任务时使用。 */
  workspacePath: string;
  workspaceIdentity?: string;
  title: string;
  archived: boolean;
}

export type ManagedWorktreeErrorCode =
  | "not-repository"
  | "invalid-start-ref"
  | "start-ref-missing-subdir"
  | "bucket-exhausted"
  | "worktree-dirty"
  | "worktree-in-use"
  | "not-managed"
  | "local-only"
  | "git-failed"
  | "copy-failed"
  | "unsupported-agent"
  | "session-failed"
  | "carry-failed"
  | "session-close-failed";

export interface ManagedWorktreeError {
  code: ManagedWorktreeErrorCode;
  /** git stderr 摘要等诊断信息，只用于展示，不参与流程判断。 */
  detail?: string;
}

export interface ListManagedWorktreesRequest {
  /** 任意位于源仓库内的目录；服务会解析到 toplevel。 */
  sourcePath: string;
}

export interface ListManagedWorktreesResult {
  sourceRoot: string | null;
  worktrees: ManagedWorktreeInfo[];
}

export interface CreateManagedWorktreeRequest {
  /** 项目主目录；可以是仓库子目录（monorepo）。 */
  sourcePath: string;
  /** 起点 ref；缺省为 sourcePath 当前 HEAD。 */
  startRef?: string;
  /**
   * 带入 sourcePath 所在 checkout 的未提交改动（已暂存、未暂存、未被忽略的未跟踪文件），
   * 只用于 fork（docs/git/worktree.md §3.6）；与 startRef 互斥，起点固定为当前 HEAD。
   */
  carryChanges?: boolean;
}

export type CreateManagedWorktreeResult =
  | {
      ok: true;
      worktree: ManagedWorktreeInfo;
      /** 任务 cwd = worktree 根 + sourcePath 相对 toplevel 的路径。 */
      cwd: string;
    }
  | { ok: false; error: ManagedWorktreeError };

export interface RemoveManagedWorktreeRequest {
  path: string;
  /** 丢弃未提交改动（`git worktree remove --force`）；只用于没有任务使用的残留 worktree（§3.11）。 */
  force?: boolean;
}

export type RemoveManagedWorktreeResult = { ok: true } | { ok: false; error: ManagedWorktreeError };

export interface PruneWorktreesRequest {
  sourcePath: string;
}

export type ManagedWorktreeCreationKind = "new-task" | "fork";
export type ManagedWorktreeCreationPhase = "creating" | "starting-session" | "failed";

/**
 * 一次正在进行的 worktree 创建（docs/git/worktree.md §6.2）。只存在于 Host 内存，
 * 是创建阶段的唯一数据源；会话创建成功、放弃或"不使用 worktree"完成后删除。
 */
export interface ManagedWorktreeCreation {
  id: string;
  kind: ManagedWorktreeCreationKind;
  projectId: string;
  /** 所属 workspace（项目主目录）；任务创建在这个 workspace 下。 */
  workspacePath: string;
  phase: ManagedWorktreeCreationPhase;
  /** 起点；null = 源目录当前 HEAD。fork 时为父任务 cwd 的 HEAD。 */
  ref: string | null;
  /** bucket 预留后写入的 worktree 根目录。 */
  worktreePath: string | null;
  /** git 与拷贝输出，只保留末尾（MANAGED_WORKTREE_OUTPUT_LIMIT）。 */
  output: string;
  error: ManagedWorktreeError | null;
  /** 新建任务：首条消息正文，用于用户气泡与"放弃"后恢复草稿。fork 时为 null。 */
  promptText: string | null;
  /** fork 的父任务；新建任务为 null。 */
  parentSessionId: string | null;
  createdAt: number;
}

/** 创建结束时发布一次；renderer 据此切换到真实会话或恢复草稿。 */
export type ManagedWorktreeCreationSettlement =
  | { creationId: string; outcome: "session-started"; workspacePath: string; sessionId: string }
  | { creationId: string; outcome: "dismissed"; workspacePath: string; promptText: string | null };

export const MANAGED_WORKTREE_OUTPUT_LIMIT = 32 * 1024;

/** 新 worktree 起点候选（docs/git/worktree.md §3.2）；不执行 fetch，远端分支来自本地 remote-tracking ref。 */
export interface ManagedWorktreeStartRefs {
  /** 当前 HEAD；detached 时 branchName 为 null。仓库无提交时为 null。 */
  head: { sha: string; branchName: string | null } | null;
  localBranches: string[];
  /** 形如 origin/main；不含 <remote>/HEAD 符号引用。 */
  remoteBranches: string[];
}

export interface GitSwitchBranchRequest extends GitRepositoryRequest {
  targetBranchName: string;
}

export interface GitCreateBranchRequest extends GitRepositoryRequest {
  branchName: string;
  startPoint?: string;
}

export interface GitChangesRequest extends GitRepositoryRequest {
  sourceId: Extract<GitRepositoryChangeSourceId, "unstaged" | "staged">;
}

export interface GitIgnoredPathsRequest extends GitRepositoryRequest {
  paths: string[];
}

export interface GitDiffQuery extends GitRepositoryRequest, GitDiffRequest {}

export interface GitBranchComparison {
  baseRef: string | null;
  headRef: string | null;
  comparisonLabel: string | null;
  changes: GitFileChange[];
}

export interface GitLocalBranch {
  name: string;
  isCurrent: boolean;
  upstreamName: string | null;
  commitHash: string | null;
  commitTimestampMs: number | null;
}

export interface GitLocalBranchListResult {
  headRefType: GitHeadRefType;
  currentBranchName: string | null;
  branches: GitLocalBranch[];
}

export interface GitBranchMutationIssue {
  code: GitBranchMutationIssueCode;
  message: string;
  paths?: string[];
  detail?: string | null;
}

export interface GitBranchMutationResult {
  ok: boolean;
  action: GitBranchMutationAction;
  branchName: string | null;
  didChange: boolean;
  created: boolean;
  summary: GitRepositorySummary;
  issues: GitBranchMutationIssue[];
}

export interface GitPathMutationRequest extends GitRepositoryRequest {
  paths: string[];
}

export interface GitDiscardPathsRequest extends GitPathMutationRequest {
  staged?: boolean;
}

export interface GitCommitRequest extends GitRepositoryRequest {
  message: string;
  paths?: string[];
  stagedOnly?: boolean;
}

export interface GitCommitResult {
  commitHash: string;
  summary: GitRepositorySummary;
}

export interface GitGenerateCommitMessageRequest extends GitRepositoryRequest {
  workspaceIdentity?: string;
  locale?: Locale;
  includeUnstaged?: boolean;
  currentSessionFilePaths?: string[];
  conversationContext?: GitCommitMessageConversationContext;
}

export interface GitCommitMessageConversationContext {
  sessionId?: string;
  omittedMessageCount?: number;
  messages: GitCommitMessageConversationMessage[];
}

export interface GitCommitMessageConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GitGenerateCommitMessageResult {
  message: string;
  providerId: string;
  model: string;
}

export interface GitPushRequest extends GitRepositoryRequest {}

export interface GitPushResult {
  branchName: string | null;
  trackingBranchName: string | null;
  remoteName: string | null;
  setUpstream: boolean;
  summary: GitRepositorySummary;
}

export interface GitRefreshResult {
  summary: GitRepositorySummary;
  identity: GitIdentity | null;
  unstagedChanges: GitFileChange[];
  stagedChanges: GitFileChange[];
  branchComparison: GitBranchComparison | null;
}

export type GitCheckpointScope = "workspace";

export type GitCheckpointConflictReason =
  | "content-mismatch"
  | "missing-in-worktree"
  | "unexpected-file-in-worktree"
  | "type-mismatch";

export interface GitCheckpointMeta {
  checkpointId: string;
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  createdAt: number;
  refName: string;
  commitOid: string;
  scope: GitCheckpointScope;
}

export interface GitCheckpointRequest extends GitRepositoryRequest {
  checkpointId: string;
}

export interface GitCheckpointDiffQuery extends GitRepositoryRequest {
  fromCheckpointId: string;
  toCheckpointId: string;
}

export interface GitCheckpointFileDiff {
  path: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  originalPath?: string | null;
  kind: GitChangeKind;
  added: number;
  removed: number;
}

export interface GitCheckpointDiff {
  fromCheckpointId: string;
  toCheckpointId: string;
  files: GitCheckpointFileDiff[];
}

export interface GitCheckpointRestoreQuery extends GitCheckpointDiffQuery {
  force?: boolean;
}

export interface GitCheckpointConflict {
  path: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  reason: GitCheckpointConflictReason;
}

export interface GitCheckpointRestoreResult {
  success: boolean;
  conflicts?: GitCheckpointConflict[];
  restoredPaths?: string[];
}
