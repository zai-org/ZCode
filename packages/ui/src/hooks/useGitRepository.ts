/* eslint-disable max-lines */
import { createContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  ZCodePersistedFileChange,
  ZCodePersistedFileSnapshot,
  ZCodeTaskChangeSummary,
  GitBranchComparison,
  GitChangeSectionId,
  GitChangeSourceId,
  GitDiffResult,
  GitFileChange,
  GitIdentity,
  GitRepositorySummary,
} from "@zcode/shared";
import { buildTurnChangeSummary, toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { logger } from "@/logger.js";
import { shouldEnableWorkspaceRpc } from "@/lib/workspaceRpcAvailability.js";
import { useServices } from "@/hooks/useServices.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";

type GitRepositorySourceId = Extract<GitChangeSourceId, "unstaged" | "staged" | "branch">;

interface RepositoryDatasets {
  unstaged: GitPaneDataset;
  staged: GitPaneDataset;
  branch: GitPaneDataset;
}

const EMPTY_BRANCH_COMPARISON: GitBranchComparison = {
  baseRef: null,
  headRef: null,
  comparisonLabel: null,
  changes: [],
};

interface GitLiveDataRefreshInput {
  workspacePath: string;
  workspaceKey: string;
  includeExtendedData: boolean;
  refreshToken: string | number | boolean | null;
  workspaceRpcEnabled: boolean;
}

export interface GitPaneFileChange extends GitFileChange {
  diff: GitDiffResult | null;
}

export interface GitPaneSection {
  id: GitChangeSectionId;
  changes: GitPaneFileChange[];
}

export interface GitPaneDataset {
  id: GitChangeSourceId;
  readonly: boolean;
  sections: GitPaneSection[];
  comparisonLabel?: string | null;
  turnIndex?: number | null;
}

export interface GitPaneSourceOption {
  id: GitChangeSourceId;
  count: number;
  readonly: boolean;
  disabled: boolean;
  comparisonLabel?: string | null;
}

export interface GitPaneRepositoryState {
  workspaceKey: string;
  summary: GitRepositorySummary;
  identity: GitIdentity;
  placeholder: {
    enabled: boolean;
  };
  loading: boolean;
  error: string | null;
  revision: number;
  sourceOptions: GitPaneSourceOption[];
  datasets: Record<GitChangeSourceId, GitPaneDataset>;
}

// 复用 App 已订阅的仓库数据；状态栏不额外启动第二个 Git reader。
export const GitStatusRepositoryContext = createContext<{
  workspacePath: string;
  state: GitPaneRepositoryState;
  openChange: (path: string, source: "unstaged" | "staged") => void;
} | null>(null);

const SECTION_ORDER_BY_SOURCE: Record<GitRepositorySourceId, readonly GitChangeSectionId[]> = {
  unstaged: ["unstaged", "untracked", "conflicted"],
  staged: ["staged"],
  branch: ["branch"],
};

const EMPTY_IDENTITY: GitIdentity = {
  userName: null,
  userEmail: null,
  nameSource: null,
  emailSource: null,
  scopeLabel: null,
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

function sumSectionCount(sections: readonly GitPaneSection[]): number {
  return sections.reduce((count, section) => count + section.changes.length, 0);
}

function inferGitKind(added: number, removed: number): GitFileChange["kind"] {
  if (added > 0 && removed === 0) {
    return "added";
  }

  if (removed > 0 && added === 0) {
    return "deleted";
  }

  return "modified";
}

function createEmptySummary(workspacePath: string): GitRepositorySummary {
  return {
    workspacePath,
    repoRoot: workspacePath,
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName: null,
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: false,
    isRepository: false,
  };
}

function createEmptyDataset(id: GitChangeSourceId, readonly: boolean): GitPaneDataset {
  return {
    id,
    readonly,
    sections: [],
    comparisonLabel: null,
    turnIndex: null,
  };
}

function createEmptyDatasets(): Record<GitChangeSourceId, GitPaneDataset> {
  return {
    unstaged: createEmptyDataset("unstaged", false),
    staged: createEmptyDataset("staged", false),
    branch: createEmptyDataset("branch", true),
    "last-turn": createEmptyDataset("last-turn", true),
  };
}

function buildSourceOptions(
  datasets: Record<GitChangeSourceId, GitPaneDataset>,
): GitPaneSourceOption[] {
  return [
    {
      id: "unstaged",
      count: sumSectionCount(datasets.unstaged.sections),
      readonly: false,
      disabled: false,
    },
    {
      id: "staged",
      count: sumSectionCount(datasets.staged.sections),
      readonly: false,
      disabled: false,
    },
    {
      id: "branch",
      count: sumSectionCount(datasets.branch.sections),
      readonly: true,
      disabled: false,
      comparisonLabel: datasets.branch.comparisonLabel,
    },
    {
      id: "last-turn",
      count: sumSectionCount(datasets["last-turn"].sections),
      readonly: true,
      disabled: false,
    },
  ];
}

function createInitialState(
  workspacePath: string,
  options?: {
    workspaceKey?: string;
    loading?: boolean;
    error?: string | null;
    revision?: number;
  },
): GitPaneRepositoryState {
  const datasets = createEmptyDatasets();
  return {
    workspaceKey: options?.workspaceKey ?? workspacePath,
    summary: createEmptySummary(workspacePath),
    identity: EMPTY_IDENTITY,
    placeholder: {
      enabled: false,
    },
    loading: options?.loading ?? true,
    error: options?.error ?? null,
    revision: options?.revision ?? 0,
    sourceOptions: buildSourceOptions(datasets),
    datasets,
  };
}

function toPaneFileChange(
  change: GitFileChange,
  diff: GitDiffResult | null = null,
): GitPaneFileChange {
  return {
    ...change,
    diff,
  };
}

function buildSectionsForSource(
  sourceId: GitRepositorySourceId,
  changes: GitFileChange[],
): GitPaneSection[] {
  const grouped = new Map<GitChangeSectionId, GitPaneFileChange[]>();
  for (const change of changes) {
    const sectionChanges = grouped.get(change.section) ?? [];
    sectionChanges.push(toPaneFileChange(change));
    grouped.set(change.section, sectionChanges);
  }

  return SECTION_ORDER_BY_SOURCE[sourceId]
    .map((sectionId) => {
      const sectionChanges = grouped.get(sectionId);
      if (!sectionChanges || sectionChanges.length === 0) {
        return null;
      }

      sectionChanges.sort((left, right) =>
        left.workspaceRelativePath.localeCompare(right.workspaceRelativePath),
      );

      return {
        id: sectionId,
        changes: sectionChanges,
      };
    })
    .filter((section): section is GitPaneSection => Boolean(section));
}

function buildRepositoryDatasets(options: {
  unstagedChanges: GitFileChange[];
  stagedChanges: GitFileChange[];
  branchComparison: GitBranchComparison;
}): RepositoryDatasets {
  return {
    unstaged: {
      id: "unstaged",
      readonly: false,
      sections: buildSectionsForSource("unstaged", options.unstagedChanges),
    },
    staged: {
      id: "staged",
      readonly: false,
      sections: buildSectionsForSource("staged", options.stagedChanges),
    },
    branch: {
      id: "branch",
      readonly: true,
      sections: buildSectionsForSource("branch", options.branchComparison.changes),
      comparisonLabel: options.branchComparison.comparisonLabel,
    },
  };
}

function createLastTurnChange(
  workspacePath: string,
  snapshotByPath: Map<string, ZCodePersistedFileSnapshot>,
  file: ZCodeTaskChangeSummary["files"][number],
): GitPaneFileChange {
  const relativePath = toWorkspaceRelativePath(workspacePath, file.path);
  const snapshot = snapshotByPath.get(file.path);

  return {
    path: file.path,
    repoRelativePath: relativePath,
    workspaceRelativePath: relativePath,
    kind: inferGitKind(file.added, file.removed),
    section: "last-turn",
    added: file.added,
    removed: file.removed,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
    diff: {
      path: file.path,
      availability: snapshot ? "patch" : "unavailable",
      patch: null,
      beforeContent: snapshot?.beforeContent ?? null,
      afterContent: snapshot?.afterContent ?? null,
      summary: null,
    },
  };
}

function buildLastTurnDataset(options: {
  workspacePath: string;
  turnIndex: number | null;
  fileChange: ZCodePersistedFileChange | null;
  summary: ZCodeTaskChangeSummary | null;
}): GitPaneDataset {
  const snapshotByPath = new Map<string, ZCodePersistedFileSnapshot>(
    options.fileChange?.snapshots.map((snapshot) => [snapshot.path, snapshot]) ?? [],
  );

  return {
    id: "last-turn",
    readonly: true,
    turnIndex: options.turnIndex,
    // 关键业务逻辑：上一轮更改继续优先复用 ZCode Agent 已持久化的单轮文件快照，
    // 这样 Git pane 接入真实仓库数据后，agent 视角的只读审阅链路仍然保持独立稳定。
    sections: options.summary
      ? [
          {
            id: "last-turn",
            changes: options.summary.files.map((file) =>
              createLastTurnChange(options.workspacePath, snapshotByPath, file),
            ),
          },
        ]
      : [],
  };
}

export function shouldRefreshLiveGitData(
  previous: GitLiveDataRefreshInput | null,
  next: GitLiveDataRefreshInput,
): boolean {
  if (!next.workspaceRpcEnabled) {
    return false;
  }

  if (!previous || !previous.workspaceRpcEnabled) {
    return true;
  }

  if (previous.workspacePath !== next.workspacePath) {
    return true;
  }

  if (previous.workspaceKey !== next.workspaceKey) {
    return true;
  }

  if (previous.refreshToken !== next.refreshToken) {
    return true;
  }

  // 关键业务逻辑：Git pane 关闭时不应该因为“少拿 branch/identity”反向触发一轮真实 Git。
  // 只有从关闭 -> 打开时，才补拉扩展数据；task/last-turn 的切换则只走本地数据重组。
  return !previous.includeExtendedData && next.includeExtendedData;
}

export function useGitRepository(options: {
  workspacePath: string;
  activeTaskId: string | null;
  includeExtendedData?: boolean;
  refreshToken?: string | number | boolean | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
  workspaceIdentity?: string | null;
}): GitPaneRepositoryState {
  const {
    workspacePath,
    includeExtendedData = false,
    refreshToken = null,
    remoteSessionId: preferredRemoteSessionId = null,
    remoteTarget,
    workspaceIdentity = null,
  } = options;
  const { gitService } = useServices();
  const remoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const workspaceRpcEnabled = shouldEnableWorkspaceRpc({
    workspaceIdentity,
    remoteSessionId,
    remoteTarget,
  });
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  // store 收尾：per-turn 变更摘要 map（setPerTurnSummaries/setPerTurnFileChanges）
  // 的写入链路随旧 ChatView 流订阅删除，store 不再保存该派生态（删除前也恒为空）。
  // "last-turn" 数据集保留空态骨架，待 v4 投影的 per-turn 变更面接入后回填。
  const [repositoryState, setRepositoryState] = useState<GitPaneRepositoryState>(() =>
    createInitialState(workspacePath, { workspaceKey }),
  );
  const requestVersionRef = useRef(0);
  const lastLiveRefreshInputRef = useRef<GitLiveDataRefreshInput | null>(null);
  const lastFileChangeEntry = null;
  const lastSummaryEntry = null;

  useEffect(() => {
    const nextRefreshInput: GitLiveDataRefreshInput = {
      workspacePath,
      workspaceKey,
      includeExtendedData,
      refreshToken,
      workspaceRpcEnabled,
    };

    if (!workspaceRpcEnabled) {
      requestVersionRef.current += 1;
      lastLiveRefreshInputRef.current = nextRefreshInput;
      // 断连远端 workspace 可以展示 Git 面板空壳，但不能在 session 未恢复前
      // 主动查询远端 Git，否则会把断连代理错误放大成每次首屏挂载的日志噪音。
      setRepositoryState((current) =>
        createInitialState(workspacePath, {
          workspaceKey,
          loading: false,
          error: null,
          revision: current.revision,
        }),
      );
      return;
    }

    const shouldRefresh = shouldRefreshLiveGitData(
      lastLiveRefreshInputRef.current,
      nextRefreshInput,
    );
    lastLiveRefreshInputRef.current = nextRefreshInput;
    if (!shouldRefresh) {
      return;
    }

    let disposed = false;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    setRepositoryState((current) =>
      current.workspaceKey === workspaceKey
        ? {
            ...current,
            loading: true,
            error: null,
          }
        : createInitialState(workspacePath, { workspaceKey }),
    );

    // agent 写文件会触发 Git 自动刷新。这里不能拆成 summary/unstaged/staged
    // 三个 RPC，因为服务端每个 RPC 都会重新跑 git status，日志里会形成一轮一组三连。
    // 统一走 refresh，让一次状态快照产出 header 和 Git pane 需要的基础数据。
    const refreshPromise = gitService.refresh({
      workspacePath,
      includeIdentity: includeExtendedData,
      includeBranchComparison: includeExtendedData,
    });

    // 关键业务逻辑：header 常驻时只需要 summary + staged/unstaged 统计；
    // branch comparison 与 identity 只在真正展开 Git pane 后再拉取，避免首屏预取整套 Git pane 数据。
    void refreshPromise
      .then(({ summary, identity, unstagedChanges, stagedChanges, branchComparison }) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        const repositoryDatasets = buildRepositoryDatasets({
          unstagedChanges,
          stagedChanges,
          branchComparison: branchComparison ?? EMPTY_BRANCH_COMPARISON,
        });
        const datasets: Record<GitChangeSourceId, GitPaneDataset> = {
          ...repositoryDatasets,
          "last-turn": createEmptyDataset("last-turn", true),
        };

        setRepositoryState({
          workspaceKey,
          summary,
          identity: identity ?? EMPTY_IDENTITY,
          placeholder: {
            enabled: false,
          },
          loading: false,
          error: null,
          revision: requestVersion,
          sourceOptions: buildSourceOptions(datasets),
          datasets,
        });
      })
      .catch((error: unknown) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        const message = getErrorMessage(error);
        logger.warn("[useGitRepository] 读取 Git 仓库状态失败", {
          workspacePath,
          error: message,
        });
        setRepositoryState((current) => ({
          ...createInitialState(workspacePath, {
            workspaceKey,
            loading: false,
            error: message,
            revision: current.revision,
          }),
        }));
      });

    return () => {
      disposed = true;
    };
  }, [
    gitService,
    includeExtendedData,
    refreshToken,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    workspaceRpcEnabled,
  ]);

  return useMemo(() => {
    // useEffect 在 workspace 切换后的 commit 才会清理旧状态。render 阶段先按
    // workspaceKey 投影为空状态，避免旧机器的 Git 路径通过新远端 fileWatcherService 注册。
    const currentRepositoryState =
      repositoryState.workspaceKey === workspaceKey
        ? repositoryState
        : createInitialState(workspacePath, { workspaceKey });
    const datasets = {
      ...currentRepositoryState.datasets,
    };
    const lastTurnIndex = lastFileChangeEntry?.[0] ?? lastSummaryEntry?.[0] ?? null;
    const lastFileChange = lastFileChangeEntry?.[1] ?? null;
    const lastTurnSummary = buildTurnChangeSummary(lastFileChange) ?? lastSummaryEntry?.[1] ?? null;

    datasets["last-turn"] = buildLastTurnDataset({
      workspacePath,
      turnIndex: lastTurnIndex,
      fileChange: lastFileChange,
      summary: lastTurnSummary,
    });

    return {
      ...currentRepositoryState,
      sourceOptions: buildSourceOptions(datasets),
      datasets,
    };
  }, [lastFileChangeEntry, lastSummaryEntry, repositoryState, workspaceKey, workspacePath]);
}
