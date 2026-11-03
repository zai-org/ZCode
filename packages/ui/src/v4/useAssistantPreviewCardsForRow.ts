import { useEffect, useMemo, useState } from "react";
import type {
  AssistantTextRow,
  ConversationRowTarget,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  buildAssistantPreviewCardsFromReferences,
  extractAssistantFileReferences,
  type AssistantPreviewCard,
} from "@/lib/assistantPreviewCards.js";
import { logger } from "@/logger.js";
import { shouldResyncForStaleAuthority } from "@/v4/staleAuthorityRecovery.js";
import type {
  ConversationFileChangesRequestOptions,
  ConversationFileChangesState,
} from "@/v4/conversationRowContext.js";

interface UseAssistantPreviewCardsForAssistantTextRowParams {
  row?: AssistantTextRow;
  assistantTextRows: readonly AssistantTextRow[];
  latestAssistantTextRow?: AssistantTextRow;
  workspacePath: string;
  workspaceHomePath?: string;
  compactForRemoteControl?: boolean;
  fileChangesTarget: ConversationRowTarget | null;
  fileChangesState?: ConversationFileChangesState;
  fetchFileChanges?: (
    target: ConversationRowTarget,
    options: ConversationFileChangesRequestOptions,
  ) => Promise<V4ConversationFileChangesResult>;
}

interface LoadedChangedPaths {
  key: string;
  paths: readonly string[];
}

interface StaleRetryState {
  key: string;
  attempt: number;
}

const EMPTY_CHANGED_FILE_PATHS: readonly string[] = [];
const STALE_FILE_CHANGES_MAX_RETRIES = 3;
const STALE_FILE_CHANGES_RETRY_BASE_DELAY_MS = 150;

function joinAssistantTurnText(rows: readonly AssistantTextRow[]): string {
  return rows
    .map((row) => row.text)
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

export function useAssistantPreviewCardsForAssistantTextRow({
  row,
  assistantTextRows,
  latestAssistantTextRow,
  workspacePath,
  workspaceHomePath,
  compactForRemoteControl,
  fileChangesTarget,
  fileChangesState,
  fetchFileChanges,
}: UseAssistantPreviewCardsForAssistantTextRowParams): AssistantPreviewCard[] {
  const turnText = useMemo(() => joinAssistantTurnText(assistantTextRows), [assistantTextRows]);
  const canBuildCards =
    row !== undefined &&
    latestAssistantTextRow?.rowId === row.rowId &&
    (row.state === "complete" || row.state === "interrupted");
  const fileReferences = useMemo(
    () =>
      canBuildCards
        ? extractAssistantFileReferences(turnText, workspacePath, {
            homePath: workspaceHomePath,
          })
        : [],
    [canBuildCards, turnText, workspaceHomePath, workspacePath],
  );
  const needsFileChanges = fileReferences.some(
    (reference) =>
      reference.kind === "markdown" ||
      (reference.kind === "html" && compactForRemoteControl !== true),
  );
  const target = useMemo<ConversationRowTarget | null>(
    () =>
      fileChangesTarget
        ? {
            rowId: fileChangesTarget.rowId,
            entityId: fileChangesTarget.entityId,
          }
        : null,
    [fileChangesTarget?.entityId, fileChangesTarget?.rowId],
  );
  const requestKey = target
    ? `${target.rowId}:${target.entityId}:${fileChangesState ?? "unknown"}`
    : "";
  const [loadedChangedPaths, setLoadedChangedPaths] = useState<LoadedChangedPaths | null>(null);
  const [staleRetry, setStaleRetry] = useState<StaleRetryState | null>(null);
  const staleRetryAttempt = staleRetry?.key === requestKey ? staleRetry.attempt : 0;

  useEffect(() => {
    if (!needsFileChanges || !fetchFileChanges || !target) return;
    // rewind 后 header 的 reverted 状态是权威投影；无需等待详情 RPC，立即抑制 md/html。
    if (fileChangesState === "reverted") return;

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // V4 fileChanges 只接受 turnHeader；assistantText 仅用于正文和卡片锚点。
    // 先用空门控同步投影 Office/PDF；只有确实出现 md/html 时才读取本轮明细。
    void fetchFileChanges(target, {
      cachePolicy: "terminal",
      fileChangesState,
    }).then(
      (result) => {
        if (disposed) return;
        setLoadedChangedPaths({
          key: requestKey,
          paths: result.state === "reverted" ? [] : result.items.map((item) => item.path),
        });
      },
      (error: unknown) => {
        if (disposed) return;
        // Bug 根因：turn 刚 complete 时 projection revision 仍会被后续事件推进，查询带的
        // baseRevision 会被 Agent 判为 proto.staleRevision。requestKey 不含 revision，若这里
        // 记成空列表，本轮 md/html 卡片会一直被抑制；SessionPane 已删除失败缓存并触发
        // stale recovery，稍后用最新 revision 重查即可。
        if (
          shouldResyncForStaleAuthority(error) &&
          staleRetryAttempt < STALE_FILE_CHANGES_MAX_RETRIES
        ) {
          retryTimer = setTimeout(
            () => {
              setStaleRetry({ key: requestKey, attempt: staleRetryAttempt + 1 });
            },
            STALE_FILE_CHANGES_RETRY_BASE_DELAY_MS * (staleRetryAttempt + 1),
          );
          return;
        }
        logger.warn("[AssistantPreviewCards] 读取本轮文件变更失败，已抑制 Markdown/HTML 卡片", {
          error: error instanceof Error ? error.message : String(error),
          rowId: target.rowId,
        });
        setLoadedChangedPaths({ key: requestKey, paths: [] });
      },
    );

    return () => {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [fetchFileChanges, fileChangesState, needsFileChanges, requestKey, staleRetryAttempt, target]);

  const changedFilePaths =
    needsFileChanges && loadedChangedPaths?.key === requestKey
      ? loadedChangedPaths.paths
      : EMPTY_CHANGED_FILE_PATHS;

  return useMemo(
    () =>
      canBuildCards
        ? buildAssistantPreviewCardsFromReferences(turnText, workspacePath, fileReferences, {
            changedFilePaths,
            homePath: workspaceHomePath,
            suppressWebRemoteCards: compactForRemoteControl === true,
          })
        : [],
    [
      canBuildCards,
      changedFilePaths,
      compactForRemoteControl,
      fileReferences,
      turnText,
      workspaceHomePath,
      workspacePath,
    ],
  );
}
