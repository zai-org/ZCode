import { useCallback, useEffect, useRef, useState } from "react";
import type { GitCommitGraphCommit } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { GitGraphPane } from "@/git-graph/GitGraphPane.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import { AlertCircleIcon, LoaderCircle, XIcon } from "lucide-react";

interface GitGraphDialogProps {
  open: boolean;
  workspacePath: string;
  onOpenChange: (nextOpen: boolean) => void;
}

const GIT_GRAPH_PAGE_SIZE = 50;

export function GitGraphDialog({ open, workspacePath, onOpenChange }: GitGraphDialogProps) {
  const { gitService } = useServices();
  const { intl } = useZCodeIntl();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [commits, setCommits] = useState<GitCommitGraphCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);

  const resetGraphState = useCallback(() => {
    setLoading(false);
    setLoadingMore(false);
    setRefreshing(false);
    loadingMoreRef.current = false;
    setErrorMessage(null);
  }, []);

  const loadInitialCommits = useCallback(async () => {
    setLoading(true);
    setLoadingMore(false);
    setRefreshing(false);
    loadingMoreRef.current = false;
    setErrorMessage(null);
    setCommits([]);
    setHasMore(false);
    setSelectedCommitHash(null);

    try {
      const result = await gitService.getCommitGraph({
        workspacePath,
        maxCount: GIT_GRAPH_PAGE_SIZE,
        skip: 0,
      });
      setCommits(result.commits);
      setHasMore(result.hasMore);
      setSelectedCommitHash(result.commits[0]?.hash ?? null);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitGraphDialog] 读取 Git Graph 失败", {
        workspacePath,
        error: message,
      });
      setErrorMessage(
        intl.formatMessage({ id: "gitGraph.error.requestFailed" }, { error: message }),
      );
    } finally {
      setLoading(false);
    }
  }, [gitService, intl, workspacePath]);

  useEffect(() => {
    if (!open) {
      return;
    }

    void loadInitialCommits();
  }, [loadInitialCommits, open]);

  const refreshCommits = useCallback(async () => {
    if (loading || loadingMore || refreshing) {
      return;
    }

    setRefreshing(true);
    setErrorMessage(null);

    try {
      const result = await gitService.getCommitGraph({
        workspacePath,
        maxCount: GIT_GRAPH_PAGE_SIZE,
        skip: 0,
      });
      setCommits(result.commits);
      setHasMore(result.hasMore);
      setSelectedCommitHash(result.commits[0]?.hash ?? null);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitGraphDialog] 刷新 Git Graph 失败", {
        workspacePath,
        error: message,
      });
      toast(intl.formatMessage({ id: "gitGraph.refreshFailed" }, { error: message }));
    } finally {
      setRefreshing(false);
    }
  }, [gitService, intl, loading, loadingMore, refreshing, workspacePath]);

  const loadMoreCommits = useCallback(async () => {
    if (loading || loadingMore || refreshing || loadingMoreRef.current || !hasMore) {
      return;
    }

    loadingMoreRef.current = true;
    setLoadingMore(true);
    setErrorMessage(null);

    try {
      const result = await gitService.getCommitGraph({
        workspacePath,
        maxCount: GIT_GRAPH_PAGE_SIZE,
        skip: commits.length,
      });
      setCommits((currentCommits) => [...currentCommits, ...result.commits]);
      setHasMore(result.hasMore);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitGraphDialog] 读取更多 Git Graph 失败", {
        workspacePath,
        loadedCommitCount: commits.length,
        error: message,
      });
      setErrorMessage(
        intl.formatMessage({ id: "gitGraph.error.requestFailed" }, { error: message }),
      );
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [commits.length, gitService, hasMore, intl, loading, loadingMore, refreshing, workspacePath]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          resetGraphState();
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="h-[min(78vh,720px)] max-w-5xl gap-0 overflow-hidden rounded-2xl p-0"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{intl.formatMessage({ id: "gitGraph.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "gitGraph.dialogDescription" })}
          </DialogDescription>
        </DialogHeader>
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "common.close" })}
            className="absolute right-2 top-2 z-30 bg-background/80 text-foreground-subtle hover:bg-hover hover:text-foreground [app-region:no-drag]"
          >
            <XIcon className="size-3.5" />
          </Button>
        </DialogClose>
        {loading ? (
          <div className="flex h-full items-center justify-center bg-background text-foreground-subtle">
            <LoaderCircle className="size-5 animate-spin" />
          </div>
        ) : errorMessage ? (
          <div className="flex h-full items-center justify-center bg-background p-6">
            <div className="max-w-md rounded-xl border border-border bg-card p-4 text-ui-base text-foreground">
              <div className="flex items-start gap-3">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                <p className="break-words text-foreground-subtle">{errorMessage}</p>
              </div>
            </div>
          </div>
        ) : (
          <GitGraphPane
            commits={commits}
            hasMore={hasMore}
            loadingMore={loadingMore}
            refreshing={refreshing}
            selectedCommitHash={selectedCommitHash}
            onSelectCommit={setSelectedCommitHash}
            onLoadMore={loadMoreCommits}
            onRefresh={refreshCommits}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
