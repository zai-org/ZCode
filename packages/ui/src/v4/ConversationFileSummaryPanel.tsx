import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, LoaderCircle, Undo2Icon } from "lucide-react";
import type {
  CommandAck,
  ConversationRowTarget,
  TurnHeaderRow,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";
import { TID_V4_FILE_SUMMARY_UNDO_LOCKED } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { buildChangeSummaryFilePreviewSource } from "@/messageChangeSummaryPreview.js";
import { OpenSplitButton } from "@/OpenSplitButton.js";
import { logger } from "@/logger.js";
import { collectGenUiSourcePaths, matchesGenUiSourcePath } from "@/gen-ui/contract.js";
import {
  ConversationFileRewindDialog,
  FileRewindLockedHint,
} from "@/v4/ConversationFileRewindDialog.js";
import type {
  ConversationFileChangesRequestOptions,
  ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";

type FileChangeItem = V4ConversationFileChangesResult["items"][number];

interface ConversationFileSummaryPanelProps {
  header: TurnHeaderRow;
  context: ConversationRowRenderContext;
  assistantText?: string;
}

function formatPatch(path: string, patches: FileChangeItem["patches"]): string {
  if (patches.length === 0) return "";
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const patch of patches) {
    lines.push(
      `@@ -${patch.oldStart},${patch.oldLines} +${patch.newStart},${patch.newLines} @@`,
      ...patch.lines,
    );
  }
  return lines.join("\n");
}

function openDiff(
  item: FileChangeItem,
  context: Pick<
    ConversationRowRenderContext,
    "workspacePath" | "workspaceIdentity" | "workspaceRemoteSessionId" | "onOpenCodeViewer"
  >,
) {
  const patch = formatPatch(item.path, item.patches);
  const { workspacePath, workspaceIdentity, workspaceRemoteSessionId, onOpenCodeViewer } = context;
  if (!patch || !onOpenCodeViewer) return;
  const relativePath = toWorkspaceRelativePath(workspacePath, item.path);
  onOpenCodeViewer({
    type: "patch",
    title: relativePath,
    path: item.path,
    patch,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
  });
}

export function ConversationFileSummaryPanel({
  header,
  context,
  assistantText = "",
}: ConversationFileSummaryPanelProps) {
  const { intl } = useZCodeIntl();
  const genUiSources = useMemo(() => collectGenUiSourcePaths(assistantText), [assistantText]);
  const filtersSources = genUiSources.length > 0;
  const [open, setOpen] = useState(false);
  const [loadedDetails, setLoadedDetails] = useState<{
    key: string;
    result: V4ConversationFileChangesResult | null;
  } | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [preview, setPreview] = useState<V4ConversationFileRewindPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cachePolicy: ConversationFileChangesRequestOptions["cachePolicy"] =
    header.state === "running" ? "in-flight" : "terminal";
  const fileChangesState = header.fileChanges?.state;
  // header 只有聚合值。按当前投影读取明细后过滤，不能把源文件行数从普通文件中猜着扣除。
  const requestKey = JSON.stringify([
    context.workspaceIdentity?.trim() || context.workspacePath,
    context.workspaceRemoteSessionId,
    context.sessionId,
    header.rowId,
    header.entityId,
    cachePolicy,
    header.fileChanges,
  ]);
  const settled = loadedDetails?.key === requestKey;
  const details = settled ? loadedDetails.result : null;
  const items = useMemo(
    () => details?.items.filter((item) => !matchesGenUiSourcePath(item.path, genUiSources)) ?? [],
    [details, genUiSources],
  );
  const summary =
    details && items.length !== details.items.length && header.fileChanges
      ? {
          ...header.fileChanges,
          files: items.length,
          additions: items.reduce((sum, item) => sum + (item.additions ?? 0), 0),
          deletions: items.reduce((sum, item) => sum + (item.deletions ?? 0), 0),
        }
      : header.fileChanges;

  const filesChangedLabel = intl.formatMessage(
    {
      id:
        summary?.files === 1
          ? "chat.changeSummary.filesChanged.one"
          : "chat.changeSummary.filesChanged.other",
    },
    { count: String(summary?.files ?? 0) },
  );
  const isReverted = summary?.state === "reverted";
  // 只有“本轮本来能撤销、只是被 session 锁住”才提示锁定原因；已撤销、运行时未就绪等不提示。
  const rewindLocked =
    context.fileRewindLocked === true && header.actions?.canRewindFiles === true && !isReverted;
  const canUndo =
    Boolean(context.applyFileRewind && context.previewFileRewind) &&
    header.actions?.canRewindFiles === true &&
    !isReverted;
  const target = useMemo<ConversationRowTarget | null>(
    () => (header.entityId ? { rowId: header.rowId, entityId: header.entityId } : null),
    [header.entityId, header.rowId],
  );
  const needsDetails = open || filtersSources;

  useEffect(() => {
    if (!needsDetails || !context.fetchFileChanges || !target) return;

    let disposed = false;
    // 运行中的 fileChanges 是某个 projection revision 的局部结果；turn
    // 进入终态后必须废弃局部 details，并用可持久缓存的终态策略重新读取。
    // requestKey 已同步隔离旧结果；同一摘要展开重读时保留已加载内容，避免卸载按钮丢失焦点。
    setLoadingDetails(true);
    void context
      .fetchFileChanges(target, {
        cachePolicy,
        fileChangesState,
      })
      .then(
        (result) => {
          if (disposed) return;
          setLoadedDetails({ key: requestKey, result });
          setLoadingDetails(false);
        },
        (loadError: unknown) => {
          if (disposed) return;
          logger.warn("[ConversationFileSummaryPanel] 读取文件变更详情失败", {
            error: loadError instanceof Error ? loadError.message : String(loadError),
            rowId: target.rowId,
          });
          setLoadedDetails({ key: requestKey, result: null });
          setLoadingDetails(false);
        },
      );

    return () => {
      disposed = true;
    };
  }, [
    cachePolicy,
    context.fetchFileChanges,
    fileChangesState,
    needsDetails,
    open,
    requestKey,
    target,
  ]);

  const handlePreviewRewind = useCallback(async () => {
    if (!context.previewFileRewind || !target) return;
    setDialogOpen(true);
    setPreviewLoading(true);
    setError(null);
    try {
      setPreview(await context.previewFileRewind(target));
    } catch {
      setError(intl.formatMessage({ id: "chat.changeSummary.rewindDialog.error" }));
    } finally {
      setPreviewLoading(false);
    }
  }, [context, intl, target]);

  const handleApply = useCallback(async () => {
    if (!context.applyFileRewind || !preview?.canApply || !target) return;
    setApplying(true);
    setError(null);
    try {
      const ack: CommandAck = await context.applyFileRewind(target);
      if (ack.status === "accepted" || ack.status === "duplicate") {
        setDialogOpen(false);
      } else {
        setError(
          ack.message ?? intl.formatMessage({ id: "chat.changeSummary.rewindDialog.error" }),
        );
      }
    } catch {
      setError(intl.formatMessage({ id: "chat.changeSummary.rewindDialog.error" }));
    } finally {
      setApplying(false);
    }
  }, [context, intl, preview?.canApply, target]);

  useEffect(() => {
    if (
      !details ||
      !header.fileChanges ||
      header.fileChanges.files <= 0 ||
      details.items.length > 0
    ) {
      return;
    }
    logger.warn("[ConversationFileSummaryPanel] 文件摘要详情为空", {
      expectedFiles: header.fileChanges.files,
      rowId: header.rowId,
      turnId: header.turnId,
    });
  }, [details, header.rowId, header.turnId, header.fileChanges]);

  // 在明细到达前不闪现源文件的聚合统计；读取失败后恢复原摘要，仍可展开重试。
  if (filtersSources && context.fetchFileChanges && target && !settled) return null;
  if (!summary || summary.files <= 0) return null;

  return (
    <>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="overflow-hidden rounded-xl border border-border bg-card shadow-none"
      >
        <div className="flex h-10 items-center justify-between gap-3 px-2 transition-colors hover:bg-hover">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left text-ui-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              aria-label={intl.formatMessage({
                id: open ? "chat.changeSummary.collapse" : "chat.changeSummary.expand",
              })}
            >
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 text-foreground-subtlest transition-transform",
                  open ? "rotate-90" : "rotate-0",
                )}
              />
              <span className="min-w-0 truncate font-medium">{filesChangedLabel}</span>
              <span className="shrink-0 tabular-nums">
                <span className="text-diff-added">+{summary.additions}</span>{" "}
                <span className="text-diff-removed">-{summary.deletions}</span>
              </span>
              {isReverted ? (
                <span className="shrink-0 rounded-sm bg-input px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "chat.changeSummary.reverted" })}
                </span>
              ) : null}
            </button>
          </CollapsibleTrigger>
          <FileRewindLockedHint
            locked={rewindLocked}
            triggerTestId={TID_V4_FILE_SUMMARY_UNDO_LOCKED}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!canUndo || previewLoading || applying}
              onClick={handlePreviewRewind}
              title={intl.formatMessage({ id: "chat.changeSummary.rewind" })}
            >
              {previewLoading || applying ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Undo2Icon />
              )}
              <span>{intl.formatMessage({ id: "chat.changeSummary.rewind" })}</span>
            </Button>
          </FileRewindLockedHint>
        </div>
        <CollapsibleContent>
          <div className="grid w-full border-t border-border">
            {loadingDetails ? (
              <div className="flex h-8 items-center gap-2 px-2 text-ui-base text-foreground-subtle">
                <LoaderCircle className="size-3.5 animate-spin" />
                {intl.formatMessage({
                  id: "chat.changeSummary.rewindDialog.loading",
                })}
              </div>
            ) : details && items.length === 0 ? (
              <div className="px-2 py-1.5 text-ui-base text-foreground-subtle">
                {intl.formatMessage({
                  id: "chat.changeSummary.diffUnavailable",
                })}
              </div>
            ) : (
              items.map((item) => {
                const relativePath = toWorkspaceRelativePath(context.workspacePath, item.path);
                const canReview = item.patches.length > 0 && Boolean(context.onOpenCodeViewer);
                const filePreviewSource = buildChangeSummaryFilePreviewSource({
                  path: item.path,
                  relativePath,
                  workspacePath: context.workspacePath,
                  workspaceIdentity: context.workspaceIdentity,
                  workspaceRemoteSessionId: context.workspaceRemoteSessionId,
                });
                return (
                  <div key={item.path} className="w-full bg-background/50 overflow-hidden">
                    <div
                      aria-disabled={!canReview}
                      className={cn(
                        "flex w-full items-center gap-1 px-2 py-2 text-left transition-colors",
                        canReview ? "cursor-pointer hover:bg-hover/30" : "cursor-default",
                      )}
                      onClick={() => openDiff(item, context)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        openDiff(item, context);
                      }}
                      role="button"
                      tabIndex={canReview ? 0 : -1}
                      title={item.path}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <div className="min-w-0 flex items-center">
                          <FileDisplayInline
                            path={item.path}
                            options={{
                              basePath: context.workspacePath,
                              showFilePath: true,
                              className: "inline-flex min-w-0 max-w-full items-center gap-1.5",
                              fileNameClassName:
                                "truncate text-ui-base font-medium text-foreground",
                              filePathClassName: "truncate text-ui-base text-foreground-subtlest",
                            }}
                          />
                        </div>
                        {/* 修复原因：writeCount 是撤销预检使用的操作轨迹，摘要行已经用 +/- 表达最终结果；
                            在这里展示会把内部操作次数误当成变更指标，因此只在撤销弹窗保留。 */}
                        <span className="flex shrink-0 items-center gap-2 tabular-nums text-ui-base">
                          {item.additions > 0 ? (
                            <span className="text-diff-added">+{item.additions}</span>
                          ) : null}
                          {item.deletions > 0 ? (
                            <span className="text-diff-removed">-{item.deletions}</span>
                          ) : null}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="default"
                          aria-label={intl.formatMessage({
                            id: "chat.changeSummary.review",
                          })}
                          title={intl.formatMessage({
                            id: "chat.changeSummary.review",
                          })}
                          disabled={!canReview}
                          className="h-7 gap-1.5 rounded-lg bg-input px-2 text-ui-base"
                          onClick={(event) => {
                            event.stopPropagation();
                            openDiff(item, context);
                          }}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <span>
                            {intl.formatMessage({
                              id: "chat.changeSummary.review",
                            })}
                          </span>
                        </Button>
                        <OpenSplitButton
                          target={{
                            type: "file",
                            path: item.path,
                            title: relativePath,
                            label: relativePath,
                            previewSource: filePreviewSource,
                          }}
                          onOpenCodeViewer={context.onOpenCodeViewer}
                          hideOpenWithMenu={context.compactForRemoteControl === true}
                          stopPropagation
                        />
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <ConversationFileRewindDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        preview={preview}
        previewLoading={previewLoading}
        applying={applying}
        error={error}
        onApply={handleApply}
        applyLocked={context.fileRewindLocked === true}
      />
    </>
  );
}
