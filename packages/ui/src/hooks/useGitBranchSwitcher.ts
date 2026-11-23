import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GitBranchMutationResult,
  GitLocalBranchListResult,
  GitRepositorySummary,
} from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import {
  buildGitBranchAutoCommitMessage,
  getPrimaryGitBranchIssue,
  resolveGitBranchIssueMessageId,
  resolveGitBranchSuccessMessageId,
  summarizeGitBranchIssuePaths,
} from "@/git-branch-switcher/display.js";
import {
  buildGitBranchSwitchAssistState,
  formatGitBranchIssuePathList,
  hasGitCommitIdentity,
  type GitBranchSwitchAssistDialogStep,
  type GitBranchSwitchAssistState,
} from "@/git-branch-switcher/switchAssist.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";

interface UseGitBranchSwitcherOptions {
  workspacePath: string;
  scopeKey?: string;
  // gitSummary 是 HEAD 的真实来源(由文件 watcher 实时回灌)。传入它的当前分支/HEAD 类型，
  // 用于在底层 HEAD 变化时丢弃可能过期的本地分支快照。
  currentBranchName: string | null;
  headRefType: GitRepositorySummary["headRefType"];
  onRefreshGit: () => void;
}

export function useGitBranchSwitcher({
  workspacePath,
  scopeKey = workspacePath,
  currentBranchName,
  headRefType,
  onRefreshGit,
}: UseGitBranchSwitcherOptions) {
  const { gitService } = useServices();
  const { intl, locale } = useZCodeIntl();
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const scope = useMemo(() => ({ scopeKey, workspacePath }), [scopeKey, workspacePath]);
  const activeScopeRef = useRef<object | null>(scope);
  activeScopeRef.current = scope;
  const isCurrentScope = useCallback(() => activeScopeRef.current === scope, [scope]);
  useEffect(() => {
    activeScopeRef.current = scope;
    return () => {
      if (activeScopeRef.current === scope) activeScopeRef.current = null;
    };
  }, [scope]);
  const [open, setOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [switchAssistStep, setSwitchAssistStep] = useState<GitBranchSwitchAssistDialogStep | null>(
    null,
  );
  const [switchAssistState, setSwitchAssistState] = useState<GitBranchSwitchAssistState | null>(
    null,
  );
  const [branchesResult, setBranchesResult] = useState<GitLocalBranchListResult | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);

  const [renderedScope, setRenderedScope] = useState(scope);
  if (renderedScope !== scope) {
    // 只重置 Git 状态，不能用包住会话内容的 key 重建 Composer；旧异步响应由 scope 身份拒收。
    setRenderedScope(scope);
    setOpen(false);
    setCreateDialogOpen(false);
    setCreateBranchName("");
    setCommitMessage("");
    setCommitError(null);
    setSwitchAssistStep(null);
    setSwitchAssistState(null);
    setBranchesResult(null);
    setLoadingBranches(false);
    setMutationPending(false);
  }

  const resetSwitchAssistState = useCallback(() => {
    setSwitchAssistStep(null);
    setSwitchAssistState(null);
    setCommitMessage("");
    setCommitError(null);
  }, []);

  const loadBranches = useCallback(async () => {
    setLoadingBranches(true);

    try {
      const nextResult = await gitService.getLocalBranches({ workspacePath });
      if (isCurrentScope()) setBranchesResult(nextResult);
    } catch (error: unknown) {
      if (!isCurrentScope()) return;
      const message = getErrorMessage(error);
      logger.warn("[GitBranchSwitcher] 读取本地分支失败", {
        workspacePath,
        error: message,
      });
      toast(
        intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
      );
    } finally {
      if (isCurrentScope()) setLoadingBranches(false);
    }
  }, [gitService, intl, workspacePath, isCurrentScope]);

  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    // 关键业务逻辑：gitSummary 的 HEAD 一旦变化(例如外部命令切分支、watcher 实时回灌)，
    // 就丢弃上一次展开下拉框时缓存的本地分支快照，让底部分支标签回落到 gitSummary.branchName。
    // 否则 branchesResult.currentBranchName 的旧值会长期遮挡真实分支名，出现“切了不变”。
    // 注意：这里只重置本地 UI state，不触发任何刷新 / RPC，避免重新引入 refresh<->watcher 自激回路。
    if (openRef.current) {
      // 下拉框展开时正展示实时列表，不清空以免列表闪烁；关闭后下次展开会通过 loadBranches 重新拉取。
      return;
    }
    setBranchesResult(null);
  }, [currentBranchName, headRefType]);

  useEffect(() => {
    if (!open) {
      return;
    }

    // 关键业务逻辑：分支列表每次展开都重新读取一次，避免切换成功后还复用上一次打开时的旧快照。
    void loadBranches();
  }, [loadBranches, open]);

  const notifyMutationFailure = useCallback(
    (result: GitBranchMutationResult) => {
      const issue = getPrimaryGitBranchIssue(result.issues);
      const messageId = resolveGitBranchIssueMessageId(issue);
      if (!issue) {
        toast(intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }));
        return;
      }

      if (messageId) {
        const { visiblePaths, remainingCount } = summarizeGitBranchIssuePaths(issue.paths);
        const extraPaths =
          remainingCount > 0
            ? intl.formatMessage(
                { id: "git.branchSwitcher.error.moreFiles" },
                { count: numberFormatter.format(remainingCount) },
              )
            : "";
        toast(
          intl.formatMessage(
            { id: messageId },
            {
              branchName: issue.detail ?? result.branchName ?? "",
              paths: formatGitBranchIssuePathList(locale, visiblePaths),
              extraPaths,
            },
          ),
        );
        return;
      }

      const fallbackMessage = issue.detail?.trim() || issue.message.trim();
      toast(
        fallbackMessage.length > 0
          ? fallbackMessage
          : intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }),
      );
    },
    [intl, locale, numberFormatter],
  );

  const prepareSwitchAssistState = useCallback(
    async (result: GitBranchMutationResult): Promise<boolean> => {
      const nextSwitchAssistState = await buildGitBranchSwitchAssistState({
        gitService,
        workspacePath,
        result,
      });
      if (!isCurrentScope()) return true;
      if (!nextSwitchAssistState) {
        return false;
      }

      // 关键业务逻辑：overwrite 型阻塞不再直接 toast，而是转成“失败卡片 -> 提交 -> 自动重试切换”流程。
      // 这样用户能先看见真正受影响的文件，再决定是否提交当前更改继续。
      setOpen(false);
      setCreateDialogOpen(false);
      setCommitError(null);
      setCommitMessage("");
      setSwitchAssistState(nextSwitchAssistState);
      setSwitchAssistStep("blocked");
      return true;
    },
    [gitService, workspacePath, isCurrentScope],
  );

  const handleMutationResult = useCallback(
    async (result: GitBranchMutationResult, actionLabel: string) => {
      if (!isCurrentScope()) return;
      if (!result.ok) {
        logger.warn("[GitBranchSwitcher] 分支变更被阻塞", {
          workspacePath,
          action: result.action,
          branchName: result.branchName,
          issues: result.issues.map((issue) => issue.code),
        });
        if (await prepareSwitchAssistState(result)) {
          return;
        }
        if (isCurrentScope()) notifyMutationFailure(result);
        return;
      }

      const successMessageId = resolveGitBranchSuccessMessageId(result);
      if (successMessageId && result.branchName) {
        toast(intl.formatMessage({ id: successMessageId }, { branchName: result.branchName }));
      }

      logger.info(`[GitBranchSwitcher] ${actionLabel}成功`, {
        workspacePath,
        branchName: result.branchName,
        action: result.action,
        didChange: result.didChange,
        created: result.created,
      });

      setOpen(false);
      setCreateDialogOpen(false);
      setCreateBranchName("");
      resetSwitchAssistState();
      setBranchesResult((current) =>
        current
          ? {
              ...current,
              currentBranchName: result.summary.branchName,
              headRefType: result.summary.headRefType,
              branches: current.branches.map((branch) => ({
                ...branch,
                isCurrent:
                  result.summary.branchName !== null && branch.name === result.summary.branchName,
              })),
            }
          : current,
      );
      // 关键业务逻辑：只有真正发生分支变更时才刷新全局 Git 状态。
      // 切到当前分支这类 no-op 已经是成功结果，但没必要再触发一轮额外重拉。
      if (result.didChange || result.created) {
        onRefreshGit();
      }
    },
    [
      intl,
      notifyMutationFailure,
      onRefreshGit,
      prepareSwitchAssistState,
      isCurrentScope,
      resetSwitchAssistState,
      workspacePath,
    ],
  );

  const switchBranch = useCallback(
    async (targetBranchName: string) => {
      setOpen(false);
      setMutationPending(true);

      try {
        const result = await gitService.switchBranch({
          workspacePath,
          targetBranchName,
        });
        await handleMutationResult(result, "切换分支");
      } catch (error: unknown) {
        if (!isCurrentScope()) return;
        const message = getErrorMessage(error);
        logger.warn("[GitBranchSwitcher] 切换分支请求失败", {
          workspacePath,
          targetBranchName,
          error: message,
        });
        toast(
          intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
        );
      } finally {
        if (isCurrentScope()) setMutationPending(false);
      }
    },
    [gitService, handleMutationResult, intl, workspacePath, isCurrentScope],
  );

  const createBranchAndSwitch = useCallback(async () => {
    const branchName = createBranchName.trim();
    if (branchName.length === 0) {
      toast(intl.formatMessage({ id: "git.branchSwitcher.error.invalidBranchName" }));
      return;
    }

    setMutationPending(true);

    try {
      const result = await gitService.createBranchAndSwitch({
        workspacePath,
        branchName,
      });
      await handleMutationResult(result, "创建并切换分支");
    } catch (error: unknown) {
      if (!isCurrentScope()) return;
      const message = getErrorMessage(error);
      logger.warn("[GitBranchSwitcher] 创建并切换分支请求失败", {
        workspacePath,
        branchName,
        error: message,
      });
      toast(
        intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
      );
    } finally {
      if (isCurrentScope()) setMutationPending(false);
    }
  }, [createBranchName, gitService, handleMutationResult, intl, workspacePath, isCurrentScope]);

  const openSwitchCommitDialog = useCallback(() => {
    setCommitError(null);
    setSwitchAssistStep("commit");
  }, []);

  const closeSwitchAssistDialog = useCallback(() => {
    resetSwitchAssistState();
  }, [resetSwitchAssistState]);

  const commitAndSwitchBranch = useCallback(async () => {
    if (!switchAssistState) {
      return;
    }

    if (!hasGitCommitIdentity(switchAssistState.identity)) {
      setCommitError(
        intl.formatMessage({
          id: "git.branchSwitcher.commitDialog.identityMissing",
        }),
      );
      return;
    }

    const nextCommitMessage =
      commitMessage.trim() || buildGitBranchAutoCommitMessage(switchAssistState.targetBranchName);

    setCommitError(null);
    setMutationPending(true);

    try {
      logger.info("[GitBranchSwitcher] 开始提交并重试切换分支", {
        workspacePath,
        targetBranchName: switchAssistState.targetBranchName,
        stagedPathCount: switchAssistState.stagePaths.length,
      });

      if (switchAssistState.stagePaths.length > 0) {
        await gitService.stagePaths({
          workspacePath,
          paths: switchAssistState.stagePaths,
        });
      }
      await gitService.commit({
        workspacePath,
        message: nextCommitMessage,
      });
      // 已确认的 Git 操作继续在来源目录完成；切走后不刷新新会话，也不把结果写回新 scope。
      if (isCurrentScope()) onRefreshGit();

      const result = await gitService.switchBranch({
        workspacePath,
        targetBranchName: switchAssistState.targetBranchName,
      });
      await handleMutationResult(result, "提交后切换分支");
    } catch (error: unknown) {
      if (!isCurrentScope()) return;
      const message = getErrorMessage(error);
      logger.warn("[GitBranchSwitcher] 提交并切换分支失败", {
        workspacePath,
        targetBranchName: switchAssistState.targetBranchName,
        error: message,
      });
      setCommitError(
        intl.formatMessage(
          { id: "git.branchSwitcher.commitDialog.error.requestFailed" },
          { error: message },
        ),
      );
    } finally {
      if (isCurrentScope()) setMutationPending(false);
    }
  }, [
    commitMessage,
    gitService,
    handleMutationResult,
    isCurrentScope,
    intl,
    onRefreshGit,
    switchAssistState,
    workspacePath,
  ]);

  return {
    open,
    setOpen,
    createDialogOpen,
    setCreateDialogOpen,
    createBranchName,
    setCreateBranchName,
    commitMessage,
    setCommitMessage,
    commitError,
    switchAssistStep,
    switchAssistState,
    branchesResult,
    loadingBranches,
    mutationPending,
    switchBranch,
    createBranchAndSwitch,
    openSwitchCommitDialog,
    closeSwitchAssistDialog,
    commitAndSwitchBranch,
  };
}
