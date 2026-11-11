/* eslint-disable max-lines -- Edit 工具块同时维护单文件、多文件子块和 diff 预览引用稳定性；当前变更先保持同文件收口，避免为行数拆分引入展示回归。 */
import { PencilIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { getFileDisplayPath } from "@/lib/fileDisplay.js";
import type { ToolInlinePreview } from "@/lib/toolDisplay.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { EditInlineDiffContent } from "@/ToolCallBlocks/renderers/EditInlineDiffContent.js";
import {
  getEditKindLabelMessageId,
  renderDiffCount,
  renderJoinedFileChips,
  renderFileChip,
  type EditKindSource,
} from "../shared.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const EDIT_TOOL_ICON = <PencilIcon className="size-4 shrink-0 text-foreground-subtle" />;

const EDIT_SINGLE_LAYOUT = {
  canToggle: true,
  forceOpen: false,
} as const;

const EDIT_CHILD_LAYOUT = {
  canToggle: true,
  forceOpen: false,
} as const;

function isRawToolCallFailed(raw: unknown) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }

  const { status } = raw as { status?: unknown };
  return typeof status === "string" && status === "failed";
}

export function buildEditCodeViewerSource(
  summary: NonNullable<ToolCallBlockRenderContext["rawFileSummaries"]>[number],
): CodeViewerSource {
  if (!summary.patch) {
    return {
      type: "file",
      title: summary.fileName,
      path: summary.path,
    };
  }

  return {
    type: "patch",
    title: summary.fileName,
    // summary.filePath 是 fileDisplay 生成的目录展示路径，不是可打开的文件路径。
    // 传给 side pane 后会按目录解析图标，导致 .ts/.tsx diff tab 退回通用文件图标。
    path: summary.path,
    patch: summary.patch,
  };
}

function buildEditInlinePreview(
  summary: NonNullable<ToolCallBlockRenderContext["rawFileSummaries"]>[number] | null,
): ToolInlinePreview | undefined {
  if (!summary?.patch) {
    return undefined;
  }

  // edit 摘要层已经能从 rawFileSummaries 拿到单文件 patch，
  // 但展开区之前只认 displayModel.inlinePreview，导致卡片自动展开后看不到 diff preview。
  // 这里把当前文件的 patch 直接转成 content 里的 diff 块，避免 ToolCallBody 再次抢走这份预览。
  const source = buildEditCodeViewerSource(summary);
  if (source.type !== "patch") {
    return undefined;
  }

  return {
    type: "patch",
    source,
  };
}

export function EditToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, rawFileSummaries, isRunning, statusLabel, errorText, onOpenCodeViewer } =
    context;
  const { toolCall } = toolCallNode;
  const hasMultipleFiles = rawFileSummaries.length > 1;
  const isFailed =
    toolCall.status === "failed" || isRawToolCallFailed(toolCall.raw) || Boolean(errorText);
  const effectiveStatusLabel = isFailed
    ? intl.formatMessage({ id: "chat.toolCall.status.failed" })
    : statusLabel;
  const openFilePreview = useCallback(
    (summary: NonNullable<ToolCallBlockRenderContext["rawFileSummaries"]>[number]) => {
      if (!onOpenCodeViewer) {
        return;
      }

      onOpenCodeViewer(buildEditCodeViewerSource(summary));
    },
    [onOpenCodeViewer],
  );

  const primaryText = useMemo(
    () =>
      rawFileSummaries.length > 0
        ? renderJoinedFileChips(rawFileSummaries, {
            clickable: Boolean(onOpenCodeViewer),
            basePath: context.workspacePath,
            onClick: openFilePreview,
          })
        : null,
    [context.workspacePath, onOpenCodeViewer, openFilePreview, rawFileSummaries],
  );
  const totalChangeStat = useMemo(
    () =>
      rawFileSummaries.reduce(
        (acc, summary) => {
          if (!summary.changeStat) {
            return acc;
          }

          return {
            added: acc.added + summary.changeStat.added,
            removed: acc.removed + summary.changeStat.removed,
          };
        },
        { added: 0, removed: 0 },
      ),
    [rawFileSummaries],
  );
  const diffCount = useMemo(
    () =>
      renderDiffCount(totalChangeStat, {
        animateInitial: context.animateDiffCountOnMount,
      }),
    [context.animateDiffCountOnMount, totalChangeStat],
  );
  const kindLabel = intl.formatMessage({
    id: getEditKindLabelMessageId(
      rawFileSummaries.map((summary) => summary.operationKind),
      rawFileSummaries.map((summary) => summary.actionLabel),
      isRunning,
      {
        kind: toolCall.kind,
        title: toolCall.title,
        input: toolCall.input,
        output: toolCall.output,
        raw: toolCall.raw,
      } satisfies EditKindSource,
    ),
  });
  const layoutConfig = hasMultipleFiles
    ? {
        canToggle: true,
        forceOpen: false,
        autoOpen: false,
      }
    : EDIT_SINGLE_LAYOUT;
  const expandedPrimaryText = useMemo(
    () =>
      rawFileSummaries.length > 1 ? (
        <span>
          {intl.formatMessage(
            { id: "chat.toolCall.edit.multipleFiles" },
            { count: String(rawFileSummaries.length) },
          )}
        </span>
      ) : (
        primaryText
      ),
    [intl, primaryText, rawFileSummaries.length],
  );
  const singleFileInlinePreview = buildEditInlinePreview(
    rawFileSummaries.length === 1 ? (rawFileSummaries[0] ?? null) : null,
  );
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  const renderContent = useCallback(
    () =>
      rawFileSummaries.length === 0 ? (
        // Fallback for edit tools without raw file summaries (e.g., failed edits)
        <>
          <ToolCallBody
            childToolList={null}
            displayModel={context.displayModel}
            toolCall={toolCall}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
          <ToolSnapshotFieldNotice
            refs={toolCall.snapshotRefs ?? []}
            onLoadFullToolCallFields={
              handleLoadFullToolCallFields
                ? () => handleLoadFullToolCallFields(toolCall.toolId)
                : undefined
            }
          />
        </>
      ) : (
        <>
          {hasMultipleFiles ? (
            <div className="ml-2 space-y-2 border-border border-l pl-3.5 border-border">
              {/* 多文件 edit 的主体只展示一份总览，下面把每个文件拆成独立块，
              这样既能保留总 diff 预览，也能满足“每个文件一个 edit block”的展示。 */}
              {rawFileSummaries.map((summary, index) => (
                <EditFileSummaryBlock
                  key={`${summary.path}:${index}`}
                  summary={summary}
                  isRunning={isRunning}
                  statusLabel={effectiveStatusLabel}
                  errorText={errorText}
                  toolId={`${toolCall.toolId}:${index}`}
                  isFailed={isFailed}
                  onOpenCodeViewer={context.onOpenCodeViewer}
                  onOpenFileLink={context.onOpenFileLink}
                  onOpenBrowserUrl={context.onOpenBrowserUrl}
                  childToolList={null}
                  displayModel={context.displayModel}
                  toolCall={toolCall}
                  workspacePath={context.workspacePath}
                  theme={context.theme}
                  codePreviewSettings={context.codePreviewSettings}
                  animateDiffCountOnMount={context.animateDiffCountOnMount}
                  showIcon={false}
                  sourceLabel={context.sourceLabel}
                />
              ))}
              <ToolSnapshotFieldNotice
                refs={toolCall.snapshotRefs ?? []}
                onLoadFullToolCallFields={
                  handleLoadFullToolCallFields
                    ? () => handleLoadFullToolCallFields(toolCall.toolId)
                    : undefined
                }
              />
            </div>
          ) : (
            <div className="space-y-3">
              {singleFileInlinePreview?.type === "patch" ? (
                // edit 的 diff 预览需要直接挂在 content 里，避免 ToolCallBody 再次接管 inlinePreview
                // 后把单文件 patch 吃掉，导致展开后只剩输入/输出而看不到真正的变更内容。
                <EditInlineDiffContent
                  preview={singleFileInlinePreview.source}
                  theme={context.theme}
                  codePreviewSettings={context.codePreviewSettings}
                />
              ) : null}
              <ToolCallBody
                childToolList={context.childToolList}
                displayModel={context.displayModel}
                inlinePreviewOverride={
                  singleFileInlinePreview?.type === "patch" ? { type: "none" } : undefined
                }
                toolCall={toolCall}
                workspacePath={context.workspacePath}
                theme={context.theme}
                codePreviewSettings={context.codePreviewSettings}
                onOpenCodeViewer={context.onOpenCodeViewer}
                onOpenFileLink={context.onOpenFileLink}
                onOpenBrowserUrl={context.onOpenBrowserUrl}
              />
              <ToolSnapshotFieldNotice
                refs={toolCall.snapshotRefs ?? []}
                onLoadFullToolCallFields={
                  handleLoadFullToolCallFields
                    ? () => handleLoadFullToolCallFields(toolCall.toolId)
                    : undefined
                }
              />
            </div>
          )}
        </>
      ),
    [
      context.childToolList,
      context.codePreviewSettings,
      context.displayModel,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.sourceLabel,
      context.theme,
      context.workspacePath,
      effectiveStatusLabel,
      errorText,
      handleLoadFullToolCallFields,
      hasMultipleFiles,
      isFailed,
      isRunning,
      rawFileSummaries,
      singleFileInlinePreview,
      toolCall,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={EDIT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        // edit 的 diff 预览挂在 content 里；单文件和子文件如果不可展开，
        // 用户只能看到摘要行，无法在消息流里直接查看变更。
        {...layoutConfig}
        canToggle={!context.isOfficeMode && layoutConfig.canToggle}
        forceOpen={!context.isOfficeMode && layoutConfig.forceOpen}
        kindLabel={context.kindLabelOverride ?? kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        prioritizePrimaryText
        expandedPrimaryText={expandedPrimaryText}
        diffCount={context.isOfficeMode ? undefined : diffCount}
        hideDiffCountWhenOpen={hasMultipleFiles}
        statusLabel={effectiveStatusLabel}
        statusTooltip={isFailed ? errorText : undefined}
        showFailureStatus={isFailed}
        isRunning={isRunning}
        title={toolCall.title}
        renderContent={renderContent}
      />
      {/* <pre className="text-[8px]">{JSON.stringify(toolCall, null, 2)}</pre> */}
    </>
  );
}

function EditFileSummaryBlock({
  summary,
  isRunning,
  statusLabel,
  errorText,
  toolId,
  isFailed,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
  childToolList,
  displayModel,
  toolCall,
  workspacePath,
  theme,
  codePreviewSettings,
  showIcon = true,
  sourceLabel,
  animateDiffCountOnMount = false,
}: {
  summary: NonNullable<ToolCallBlockRenderContext["rawFileSummaries"]>[number];
  isRunning: boolean;
  statusLabel: string;
  errorText?: string;
  toolId: string;
  isFailed: boolean;
  onOpenCodeViewer?: ToolCallBlockRenderContext["onOpenCodeViewer"];
  onOpenFileLink?: ToolCallBlockRenderContext["onOpenFileLink"];
  onOpenBrowserUrl?: ToolCallBlockRenderContext["onOpenBrowserUrl"];
  childToolList: ToolCallBlockRenderContext["childToolList"];
  displayModel: ToolCallBlockRenderContext["displayModel"];
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"];
  workspacePath: string;
  theme?: ToolCallBlockRenderContext["theme"];
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  showIcon?: boolean;
  sourceLabel?: string;
  animateDiffCountOnMount?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const kindLabel = intl.formatMessage({
    id: getEditKindLabelMessageId([summary.operationKind], [summary.actionLabel], isRunning),
  });
  const inlinePreviewOverride = buildEditInlinePreview(summary);
  const openFilePreview = useCallback(() => {
    if (!onOpenCodeViewer) {
      return;
    }

    onOpenCodeViewer(buildEditCodeViewerSource(summary));
  }, [onOpenCodeViewer, summary]);
  const primaryText = useMemo(
    () =>
      renderFileChip({
        summary,
        clickable: Boolean(onOpenCodeViewer),
        basePath: workspacePath,
        onClick: openFilePreview,
      }),
    [onOpenCodeViewer, openFilePreview, summary, workspacePath],
  );
  const diffCount = useMemo(
    () =>
      renderDiffCount(summary.changeStat, {
        animateInitial: animateDiffCountOnMount,
      }),
    [animateDiffCountOnMount, summary.changeStat],
  );
  const title = useMemo(
    () => getFileDisplayPath(summary.filePath ?? summary.path, workspacePath),
    [summary.filePath, summary.path, workspacePath],
  );
  const renderContent = useCallback(
    () => (
      <div className="space-y-3">
        {inlinePreviewOverride?.type === "patch" ? (
          <EditInlineDiffContent
            preview={inlinePreviewOverride.source}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
          />
        ) : null}
        <ToolCallBody
          childToolList={childToolList}
          displayModel={displayModel}
          inlinePreviewOverride={
            inlinePreviewOverride?.type === "patch" ? { type: "none" } : undefined
          }
          toolCall={toolCall}
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenFileLink={onOpenFileLink}
          onOpenBrowserUrl={onOpenBrowserUrl}
        />
      </div>
    ),
    [
      childToolList,
      codePreviewSettings,
      displayModel,
      inlinePreviewOverride,
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
      theme,
      toolCall,
      workspacePath,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolId}
        icon={EDIT_TOOL_ICON}
        showIcon={showIcon !== false}
        // 多文件 edit 的每个子文件都有自己的 diff content，必须允许单独展开查看。
        {...EDIT_CHILD_LAYOUT}
        kindLabel={kindLabel}
        sourceLabel={sourceLabel}
        primaryText={primaryText}
        prioritizePrimaryText
        diffCount={diffCount}
        statusLabel={statusLabel}
        statusTooltip={isFailed ? errorText : undefined}
        showFailureStatus={isFailed}
        isRunning={isRunning}
        title={title}
        renderContent={renderContent}
      />
    </>
  );
}
