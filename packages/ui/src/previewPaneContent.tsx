import type { MarkdownSelectionTarget } from "@/lib/conversationSelectionReference.js";
/* eslint-disable max-lines -- PreviewPane 内容路由同时承载文本、图片、媒体、Office、PDF 和 PPTX 渲染。 */
import type { BundledTheme } from "shiki";
import { useMemo, type Ref, type SyntheticEvent, type UIEventHandler } from "react";
import type { FileBinaryPreview, FileMediaPreview, FileTextSlice } from "@zcode/shared";
import { inferCodeLanguage } from "@/lib/codeViewer.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodePreviewSettings } from "@/store/index.js";
import type { CodeCommentLabels } from "@/components/ui/code-viewer.js";
import { MarkdownPreviewContent } from "@/previewPaneMarkdownContent.js";
import { CodeContent } from "@/previewPaneCodeContent.js";
import { ImagePreviewContent, SvgPreviewContent } from "@/previewPaneImageContent.js";
import type { WorkspaceFileDragPayload } from "@/lib/workspaceFileDrag.js";
import { PreviewPaneMediaContent } from "@/previewPaneMediaContent.js";
import { PdfPreviewContent } from "@/previewPanePdfContent.js";
import { PptxPreviewContent } from "@/previewPanePptxContent.js";
import { PatchFallbackContent } from "@/previewPanePatchFallbackContent.js";
import { DiffViewer } from "@/components/ui/diff-viewer.js";
import type { PdfViewerLabels, PdfViewerSource } from "@/components/ui/pdf-viewer.js";
import type { PptxPreviewViewerLabels } from "@/components/ui/pptx-preview-viewer.js";
import type { CodeCommentPreview, CodeCommentRange } from "@/lib/codeCommentContext.js";
import type { Theme } from "@/useTheme.js";
import type { OfficeFilePreviewKind } from "@/lib/officeFilePreview.js";
import { PreviewPaneOfficeContent } from "@/previewPaneOfficeContent.js";
import type { PptxElementReferenceSource } from "@/lib/pptxElementReference.js";
import type { MediaCodeViewerSource, PptxReferencePreviewNavigation } from "@/lib/codeViewer.js";
import { resolveCodeReviewContentProjection } from "@/previewPaneCodeReview.js";

interface PreviewPaneContentProps {
  source: CodeViewerSource;
  filePreview: FileTextSlice | null;
  fileTooLarge: boolean;
  loadingInitial: boolean;
  loadingImagePreview: boolean;
  imagePreview: FileMediaPreview | null;
  imageFileReference?: WorkspaceFileDragPayload;
  loadImageDownloadSource?: () => Promise<string>;
  mediaSource: MediaCodeViewerSource | null;
  loadingMediaPreview: boolean;
  mediaPreviewUrl: string | null;
  onMediaError: (event: SyntheticEvent<HTMLMediaElement>) => void;
  onMediaLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => void;
  loadingPdfPreview: boolean;
  pdfViewerSource: PdfViewerSource | null;
  pdfViewerLabels: PdfViewerLabels;
  loadingOfficePreview: boolean;
  officePreview: FileBinaryPreview | null;
  officePreviewKind: OfficeFilePreviewKind | null;
  loadingPptxPreview: boolean;
  pptxPreviewData: ArrayBuffer | null;
  pptxViewerLabels: PptxPreviewViewerLabels;
  pptxReferenceSource: PptxElementReferenceSource | null;
  pptxReferenceNavigation: PptxReferencePreviewNavigation | null;
  pptxReferenceNavigationReady: boolean;
  error: string | null;
  codePreviewSettings: CodePreviewSettings;
  codeTheme: BundledTheme;
  resolvedTheme: "light" | "dark";
  /** 应用主题（store 耦合剥离）：透传给 markdown/mermaid 预览，缺省按 "system" 兜底。 */
  theme?: Theme;
  workspacePath?: string;
  onOpenBrowserUrl?: (url: string) => void;
  markdownSelectionTarget?: MarkdownSelectionTarget;
  markdownViewMode: "preview" | "code";
  svgViewMode: "preview" | "code";
  wrapLongLines: boolean;
  codeComments: readonly CodeCommentPreview[];
  enableCodeLineSelection?: boolean;
  enableCodeGutterUtility?: boolean;
  codeCommentLabels: CodeCommentLabels;
  onSubmitCodeComment?: (params: {
    range: CodeCommentRange;
    selectedText: string;
    comment: string;
  }) => void;
  onDeleteCodeComment?: (commentId: string) => void;
  onScroll?: UIEventHandler<HTMLDivElement>;
  scrollContainerRef?: Ref<HTMLDivElement>;
  appliedFocusRequestId?: string;
  onFocusRequestApplied?: (requestId: string) => void;
}

function isSvgPath(path?: string): boolean {
  return path?.toLowerCase().endsWith(".svg") ?? false;
}

export function getPreviewPaneErrorTextClass(
  error: string | null,
  fileMissingMessage: string,
): "text-destructive" | "text-foreground-subtlest" {
  return error === fileMissingMessage ? "text-foreground-subtlest" : "text-destructive";
}

/**
 * 文件链接行号段 → CodeViewer 定位与高亮的行号段。按文件行数截断：结束行超出末尾截到最后一行；
 * 起始行超出行数的段丢弃；全部丢弃时返回 null，预览照旧从开头显示，不报错
 * （docs/ui/preview-pane.md「带行号的文件链接」）。
 */
function resolveFileLinkFocusedRanges(
  lineRanges: readonly CodeCommentRange[] | undefined,
  content: string,
): CodeCommentRange[] | null {
  if (!lineRanges?.length) return null;
  // 起始行 ≥ 1、结束行 ≥ 起始行已在 buildFileLinkLineFocus 规整。
  // Bugfix：按 split 计行会把末尾换行后的空串也算一行（150 行文件得到 151），`:140-999` 被截到
  // 不存在的第 151 行，定位时找不到跨度终点行，预览不滚动。@pierre/diffs 不渲染末尾换行后的空行，这里同口径扣掉。
  const lines = content.split(/\r\n|\r|\n/);
  const lineCount =
    lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const ranges = lineRanges
    .filter(({ startLine }) => startLine <= lineCount)
    .map(({ startLine, endLine }) => ({ startLine, endLine: Math.min(endLine, lineCount) }));
  return ranges.length > 0 ? ranges : null;
}

export function PreviewPaneContent({
  source,
  filePreview,
  fileTooLarge,
  loadingInitial,
  loadingImagePreview,
  imagePreview,
  imageFileReference,
  loadImageDownloadSource,
  mediaSource,
  loadingMediaPreview,
  mediaPreviewUrl,
  onMediaError,
  onMediaLoadedMetadata,
  loadingPdfPreview,
  pdfViewerSource,
  pdfViewerLabels,
  loadingOfficePreview,
  officePreview,
  officePreviewKind,
  loadingPptxPreview,
  pptxPreviewData,
  pptxViewerLabels,
  pptxReferenceSource,
  pptxReferenceNavigation,
  pptxReferenceNavigationReady,
  error,
  codePreviewSettings,
  codeTheme,
  resolvedTheme,
  theme,
  workspacePath,
  onOpenBrowserUrl,
  markdownSelectionTarget,
  markdownViewMode,
  svgViewMode,
  wrapLongLines,
  codeComments,
  enableCodeLineSelection = false,
  enableCodeGutterUtility = false,
  codeCommentLabels,
  onSubmitCodeComment,
  onDeleteCodeComment,
  onScroll,
  scrollContainerRef,
  appliedFocusRequestId,
  onFocusRequestApplied,
}: PreviewPaneContentProps) {
  const { intl } = useZCodeIntl();
  const fileMissingMessage = intl.formatMessage({ id: "codeViewer.fileMissing" });
  const mediaLabels = {
    loading: intl.formatMessage({ id: "codeViewer.loadingMedia" }),
    unavailable: intl.formatMessage({ id: "codeViewer.mediaUnavailable" }),
    unsupported: intl.formatMessage({ id: "codeViewer.mediaUnsupported" }),
  };
  const multiFileDiffFiles = useMemo(() => {
    if (source.type !== "multi-file-diff") {
      return null;
    }

    // DiffViewer 是 memo 组件，预览 pane 父级滚动/加载状态刷新时，
    // JSX 内联 oldFile/newFile 会生成新对象并强制 diff 重新渲染。
    return {
      oldFile: {
        name: source.path ?? source.title,
        contents: source.beforeContent,
        cacheKey: `old:${source.path ?? source.title}:${source.beforeContent.length}:${source.beforeContent.slice(0, 100)}:${source.beforeContent.slice(-100)}`,
      },
      newFile: {
        name: source.path ?? source.title,
        contents: source.afterContent,
        cacheKey: `new:${source.path ?? source.title}:${source.afterContent.length}:${source.afterContent.slice(0, 100)}:${source.afterContent.slice(-100)}`,
      },
    };
  }, [
    source.type,
    source.type === "multi-file-diff" ? source.afterContent : null,
    source.type === "multi-file-diff" ? source.beforeContent : null,
    source.type === "multi-file-diff" ? source.path : null,
    source.type === "multi-file-diff" ? source.title : null,
  ]);

  if (source.type === "patch") {
    return (
      // 兜底分支：patch 既不是 markdown/code/image，但仍然需要独立渲染。
      <PatchFallbackContent
        patch={source.patch}
        codePreviewSettings={codePreviewSettings}
        resolvedTheme={resolvedTheme}
        sourcePath={source.path}
        sourceTitle={source.title}
      />
    );
  }

  if (source.type === "multi-file-diff" && multiFileDiffFiles) {
    return (
      <DiffViewer
        oldFile={multiFileDiffFiles.oldFile}
        newFile={multiFileDiffFiles.newFile}
        diffClassName="block"
        fontSizePx={codePreviewSettings.fontSizePx}
        lightTheme={codePreviewSettings.lightTheme}
        darkTheme={codePreviewSettings.darkTheme}
        themeType={resolvedTheme}
      />
    );
  }

  if (source.type === "text") {
    const isMarkdownSource = source.language === "markdown";
    const isSvgSource = isSvgPath(source.path);
    if (isMarkdownSource && markdownViewMode === "preview") {
      return (
        <MarkdownPreviewContent
          selectionTarget={markdownSelectionTarget}
          sourceKey={
            source.path ??
            JSON.stringify([source.title, source.type === "text" ? source.content : ""])
          }
          sourceTitle={source.path ?? source.title}
          sourcePath={source.path}
          content={source.content}
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenBrowserUrl={onOpenBrowserUrl}
        />
      );
    }

    if (isSvgSource && svgViewMode === "preview") {
      return (
        <SvgPreviewContent
          title={source.title}
          svgContent={source.content}
          fileReference={imageFileReference}
          sourcePath={source.path}
          loadDownloadSource={loadImageDownloadSource}
        />
      );
    }

    return (
      <CodeContent
        code={source.content}
        language={source.language}
        codePreviewSettings={codePreviewSettings}
        codeTheme={codeTheme}
        theme={theme}
        wrapLongLines={wrapLongLines}
        comments={codeComments}
        enableLineSelection={enableCodeLineSelection}
        enableGutterUtility={enableCodeGutterUtility}
        labels={codeCommentLabels}
        onSubmitCodeComment={onSubmitCodeComment}
        onDeleteCodeComment={onDeleteCodeComment}
        onScroll={onScroll}
        scrollContainerRef={scrollContainerRef}
      />
    );
  }

  if (source.type === "image") {
    if (loadingImagePreview || (!error && !imagePreview)) {
      return (
        <div className="p-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "codeViewer.loadingImage" })}
        </div>
      );
    }

    if (error || !imagePreview) {
      const errorMessage = error ?? intl.formatMessage({ id: "codeViewer.imageUnavailable" });
      return (
        <div
          className={`p-3 text-ui-base ${
            error ? getPreviewPaneErrorTextClass(error, fileMissingMessage) : "text-destructive"
          }`}
        >
          {errorMessage}
        </div>
      );
    }

    return (
      <ImagePreviewContent
        title={source.title}
        imageSource={`data:${imagePreview.mediaType};base64,${imagePreview.dataBase64}`}
        sourcePath={source.path}
        fileReference={imageFileReference}
      />
    );
  }

  if (source.type === "media" && mediaSource) {
    return (
      <PreviewPaneMediaContent
        error={error}
        labels={mediaLabels}
        loading={loadingMediaPreview}
        onMediaError={onMediaError}
        onMediaLoadedMetadata={onMediaLoadedMetadata}
        source={mediaSource}
        url={mediaPreviewUrl}
      />
    );
  }

  if (source.type === "pdf") {
    if (loadingPdfPreview || (!error && !pdfViewerSource)) {
      return (
        <div className="p-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "codeViewer.loadingPdf" })}
        </div>
      );
    }

    if (error || !pdfViewerSource) {
      const errorMessage = error ?? intl.formatMessage({ id: "codeViewer.pdfUnavailable" });
      return (
        <div
          className={`p-3 text-ui-base ${
            error ? getPreviewPaneErrorTextClass(error, fileMissingMessage) : "text-destructive"
          }`}
        >
          {errorMessage}
        </div>
      );
    }

    return <PdfPreviewContent source={pdfViewerSource} labels={pdfViewerLabels} />;
  }

  if (source.type === "file" && officePreviewKind) {
    return (
      <PreviewPaneOfficeContent
        error={error}
        kind={officePreviewKind}
        loading={loadingOfficePreview}
        onOpenBrowserUrl={onOpenBrowserUrl}
        preview={officePreview}
        resolvedTheme={resolvedTheme}
        sourcePath={source.path}
      />
    );
  }

  if (source.type === "pptx") {
    if (loadingPptxPreview || (!error && !pptxPreviewData)) {
      return (
        <div className="p-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "codeViewer.loadingPptx" })}
        </div>
      );
    }

    if (error || !pptxPreviewData) {
      const errorMessage = error ?? intl.formatMessage({ id: "codeViewer.pptxUnavailable" });
      return (
        <div
          className={`p-3 text-ui-base ${
            error ? getPreviewPaneErrorTextClass(error, fileMissingMessage) : "text-destructive"
          }`}
        >
          {errorMessage}
        </div>
      );
    }

    return (
      <PptxPreviewContent
        data={pptxPreviewData}
        labels={pptxViewerLabels}
        fileName={source.path}
        onOpenBrowserUrl={onOpenBrowserUrl}
        {...(pptxReferenceSource ? { referenceSource: pptxReferenceSource } : {})}
        {...(pptxReferenceNavigation ? { referenceNavigation: pptxReferenceNavigation } : {})}
        referenceNavigationReady={pptxReferenceNavigationReady}
      />
    );
  }

  if (loadingInitial && !filePreview) {
    return (
      <div className="p-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "codeViewer.loadingFile" })}
      </div>
    );
  }

  if (error && !filePreview) {
    return (
      <div
        className={`p-3 text-ui-base ${getPreviewPaneErrorTextClass(error, fileMissingMessage)}`}
      >
        {error}
      </div>
    );
  }

  if (fileTooLarge) {
    return (
      <div className="p-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "codeViewer.fileTooLarge" })}
      </div>
    );
  }

  if (!filePreview) {
    return null;
  }

  if (filePreview.isBinary) {
    return (
      <div className="p-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "codeViewer.binary" })}
      </div>
    );
  }

  if (filePreview.content.length === 0) {
    return (
      <div className="p-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "codeViewer.empty" })}
      </div>
    );
  }

  const fileLanguage = inferCodeLanguage(source.path, filePreview.content);
  const codeReviewProjection =
    source.type === "code-review"
      ? resolveCodeReviewContentProjection(source, filePreview.content)
      : null;
  // Bugfix：文件链接的行号曾在打开预览时被丢弃，CodeViewer 拿不到定位范围，总停在第 1 行。
  // 这里复用代码评审已有的 focusRequestId 定位触发；focusRequestId 每次点击都新生成，
  // 所以复用同文件 tab 时也会重新滚动。区间、多段的高亮与滚动规则由 CodeViewer 的 focusedLineRanges 处理。
  // Bugfix：focusRequestId 常驻 source，CodeViewer 重新挂载（切 tab、折叠侧栏、resize）或内容刷新时
  // 会再次定位，把用户滚到的位置冲回链接行。高亮只跟 lineRanges 走；定位只给尚未执行过的请求，
  // 执行过的由 tab 上的 appliedFocusRequestId 过滤（唯一来源在侧边面板状态，组件 ref 会随重新挂载丢失）。
  const fileLinkFocusedRanges =
    source.type === "file"
      ? resolveFileLinkFocusedRanges(source.lineRanges, filePreview.content)
      : null;
  const fileLinkFocusRequestId =
    source.type === "file" && source.focusRequestId !== appliedFocusRequestId
      ? source.focusRequestId
      : undefined;
  const isMarkdownFile = fileLanguage === "markdown";
  const isSvgFile = isSvgPath(source.path);
  if (source.type !== "code-review" && isMarkdownFile && markdownViewMode === "preview") {
    return (
      <MarkdownPreviewContent
        selectionTarget={markdownSelectionTarget}
        sourceKey={source.path ?? source.title}
        sourceTitle={source.path ?? source.title}
        sourcePath={source.path}
        content={filePreview.content}
        workspacePath={workspacePath}
        onOpenBrowserUrl={onOpenBrowserUrl}
      />
    );
  }

  if (source.type !== "code-review" && isSvgFile && svgViewMode === "preview") {
    return (
      <SvgPreviewContent
        title={source.title}
        svgContent={filePreview.content}
        fileReference={imageFileReference}
        sourcePath={source.path}
        loadDownloadSource={loadImageDownloadSource}
      />
    );
  }

  return (
    <CodeContent
      code={filePreview.content}
      language={fileLanguage}
      codePreviewSettings={codePreviewSettings}
      codeTheme={codeTheme}
      theme={theme}
      wrapLongLines={wrapLongLines}
      comments={codeReviewProjection?.inlineComments ?? codeComments}
      topComment={codeReviewProjection?.topComment}
      topCommentShowRange={false}
      topCommentNotice={
        codeReviewProjection?.targetLineOutOfRange
          ? intl.formatMessage({ id: "codeViewer.review.targetLineMissing" })
          : undefined
      }
      focusedRange={codeReviewProjection?.focusedRange}
      focusedLineRanges={fileLinkFocusedRanges}
      focusRequestId={
        source.type === "code-review"
          ? source.review.requestId
          : fileLinkFocusedRanges
            ? fileLinkFocusRequestId
            : undefined
      }
      onFocusRequestApplied={source.type === "file" ? onFocusRequestApplied : undefined}
      enableLineSelection={source.type === "code-review" ? false : enableCodeLineSelection}
      enableGutterUtility={source.type === "code-review" ? false : enableCodeGutterUtility}
      labels={codeCommentLabels}
      onSubmitCodeComment={source.type === "code-review" ? undefined : onSubmitCodeComment}
      onDeleteCodeComment={source.type === "code-review" ? undefined : onDeleteCodeComment}
      onScroll={onScroll}
      scrollContainerRef={scrollContainerRef}
    />
  );
}
