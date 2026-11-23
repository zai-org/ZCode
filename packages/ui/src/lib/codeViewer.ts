/* eslint-disable max-lines -- codeViewer 集中维护文件、文本、图片和 diff 预览提取；本次只收敛 tool identity，不顺手拆文件以免扩大回归面。 */
import type { BundledLanguage } from "shiki";
import { createUuid, getMediaPreviewFormat, type MediaPreviewKind } from "@zcode/shared";
import type { TaskChatToolCall as ChatToolCall } from "@/lib/taskChatMessageTypes.js";
import type { CodeViewerWorkspaceScope } from "@/lib/codeViewerWorkspaceScope.js";
import type { MarkdownFileLinkLineRange } from "@/lib/markdownFileLink.js";
import {
  decodeFilePathUriEscapes,
  getPathLeaf,
  isAbsoluteFilePath,
  joinFilePath,
} from "@/lib/path.js";
import {
  buildUnifiedDiff,
  extractBeforeAfter,
  extractStructuredDiff,
} from "@/lib/toolDiffPreview.js";
import {
  isFileContentWriteToolCall,
  isFileDiffToolCall,
  resolveToolCallIdentity,
} from "@/lib/toolIdentity.js";

export { buildUnifiedDiff } from "@/lib/toolDiffPreview.js";

export const FILE_VIEWER_MAX_TEXT_BYTES = 256 * 1024;
export interface FileCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "file";
  title: string;
  path: string;
  /**
   * 打开后要定位并高亮的行号段（从 1 开始，起始行 ≥ 1、结束行 ≥ 起始行，尚未按文件行数截断）；
   * 来自 `a.ts:42`、`a.ts#L30-L35`、`a.ts:30-35,40-42` 这类文件链接。只由 buildFileLinkLineFocus 生成。
   */
  lineRanges?: readonly MarkdownFileLinkLineRange[];
  /**
   * 每次点击生成的定位请求 id。同一文件的预览 tab 会被复用，只靠 lineRanges 无法区分
   * 「再点一次同一行」；CodeViewer 以它变化作为重新滚动的触发，不用定时器兜底。
   */
  focusRequestId?: string;
}

/**
 * 文件链接的行号定位字段。Bugfix：链接解析出的行号曾在构造链接目标和打开预览时被丢弃，
 * 预览总停在第 1 行。所有「点文件链接打开预览」的入口统一经这里带上行号段和新的请求 id。
 * 这里只做与文件内容无关的规整：起始行小于 1 的段丢弃；结束行小于起始行（`:35-30`）按单行起始行处理。
 * 按文件行数截断在 previewPaneContent 里做（docs/ui/preview-pane.md「带行号的文件链接」）。
 */
export function buildFileLinkLineFocus(
  lineRanges: readonly MarkdownFileLinkLineRange[] | null | undefined,
): Pick<FileCodeViewerSource, "lineRanges" | "focusRequestId"> {
  const normalizedRanges = (lineRanges ?? [])
    .filter(({ startLine }) => Number.isInteger(startLine) && startLine >= 1)
    .map(({ startLine, endLine }) => ({
      startLine,
      endLine: Number.isInteger(endLine) && endLine >= startLine ? endLine : startLine,
    }));
  if (normalizedRanges.length === 0) return {};
  return { lineRanges: normalizedRanges, focusRequestId: createUuid() };
}

export interface CodeReviewAnchor {
  requestId: string;
  title: string;
  body: string;
  priority?: 0 | 1 | 2 | 3;
  startLine?: number;
  endLine?: number;
}

export interface CodeReviewCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "code-review";
  title: string;
  path: string;
  review: CodeReviewAnchor;
}

export interface TextCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "text";
  title: string;
  path?: string;
  content: string;
  language: BundledLanguage;
}

export interface PatchCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "patch";
  title: string;
  path?: string;
  patch: string;
}

export interface MultiFileDiffCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "multi-file-diff";
  title: string;
  path?: string;
  beforeContent: string;
  afterContent: string;
}
export interface ImageCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "image";
  title: string;
  path: string;
  mediaType: string;
}

export interface MediaCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "media";
  title: string;
  path: string;
  kind: MediaPreviewKind;
  mediaType: string;
  url?: string;
}

export interface PdfCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "pdf";
  title: string;
  path: string;
}

export interface PptxCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "pptx";
  title: string;
  path: string;
  referenceNavigation?: PptxReferencePreviewNavigation;
}

export interface PptxReferencePreviewNavigation {
  requestId: string;
  pageIndex: number;
  expectedSourceFingerprint: string;
}

export type CodeViewerSource =
  | FileCodeViewerSource
  | CodeReviewCodeViewerSource
  | TextCodeViewerSource
  | PatchCodeViewerSource
  | MultiFileDiffCodeViewerSource
  | ImageCodeViewerSource
  | MediaCodeViewerSource
  | PdfCodeViewerSource
  | PptxCodeViewerSource;

const EXTENSION_TO_LANGUAGE: Record<string, BundledLanguage> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  diff: "diff",
  go: "go",
  h: "c",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  mermaid: "mermaid",
  mmd: "mermaid",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  text: "log",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  txt: "log",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const IMAGE_EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeToolLabel(label: string, fallbackPath?: string) {
  const trimmedLabel = label.trim();
  if (trimmedLabel) {
    return trimmedLabel;
  }

  if (fallbackPath) {
    return getPathLeaf(fallbackPath);
  }

  return "Tool Preview";
}

function findStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return undefined;
}

function looksLikeDiff(text: string): boolean {
  return /^(diff --git|--- |\+\+\+ |@@ )/m.test(text);
}

function extractDiffText(value: unknown): string | undefined {
  if (typeof value === "string" && looksLikeDiff(value)) {
    return value;
  }

  return findStringField(value, ["diff", "patch", "unifiedDiff", "unified_diff"]);
}

function extractContentText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  return findStringField(value, [
    "content",
    "text",
    "fileContent",
    "contents",
    "code",
    "result",
    "value",
  ]);
}

function extractRawPath(value: unknown): string | undefined {
  return findStringField(value, [
    "path",
    "filePath",
    "file_path",
    "filename",
    "targetPath",
    "target_path",
    "targetFile",
    "target_file",
    "file",
  ]);
}

function buildTextPreview(
  title: string,
  path: string | undefined,
  content: string,
): TextCodeViewerSource {
  return {
    type: "text",
    title,
    path,
    content,
    language: inferCodeLanguage(path, content),
  };
}

function resolveViewerPath(rawPath: string | undefined, workspacePath: string) {
  if (!rawPath) {
    return undefined;
  }

  const decodedPath = decodeFilePathUriEscapes(rawPath);
  if (isAbsoluteFilePath(decodedPath)) {
    return decodedPath;
  }

  return joinFilePath(workspacePath, decodedPath);
}

export function inferCodeLanguage(path?: string, contentHint?: string): BundledLanguage {
  if (path) {
    const leaf = getPathLeaf(path);
    const extension = leaf.includes(".") ? leaf.split(".").pop()?.toLowerCase() : undefined;
    if (extension && EXTENSION_TO_LANGUAGE[extension]) {
      return EXTENSION_TO_LANGUAGE[extension];
    }
  }

  if (contentHint?.startsWith("#!/")) {
    if (contentHint.includes("python")) {
      return "python";
    }

    if (contentHint.includes("bash") || contentHint.includes("sh")) {
      return "bash";
    }
  }

  if (contentHint && looksLikeDiff(contentHint)) {
    return "diff";
  }

  return "log";
}

export function inferImageMediaType(path?: string): string | null {
  if (!path) {
    return null;
  }

  const leaf = getPathLeaf(path);
  const extension = leaf.includes(".") ? leaf.split(".").pop()?.toLowerCase() : undefined;
  if (!extension) {
    return null;
  }

  return IMAGE_EXTENSION_TO_MEDIA_TYPE[extension] ?? null;
}

export function inferMediaPreview(
  path?: string,
): Omit<MediaCodeViewerSource, "type" | "title" | "path"> | null {
  if (!path) return null;
  const format = getMediaPreviewFormat(path);
  return format ? { kind: format.kind, mediaType: format.mediaType } : null;
}

export function isImagePreviewPath(path?: string): boolean {
  return inferImageMediaType(path) !== null;
}

export function isPdfPreviewPath(path?: string): boolean {
  if (!path) {
    return false;
  }
  return getPathLeaf(path).toLowerCase().endsWith(".pdf");
}

export function isPptxPreviewPath(path?: string): boolean {
  if (!path) {
    return false;
  }
  return getPathLeaf(path).toLowerCase().endsWith(".pptx");
}

function isUsableDiffFileTarget(target: string | null | undefined): target is string {
  const trimmedTarget = target?.trim();
  return Boolean(trimmedTarget && trimmedTarget !== "/dev/null");
}

function unquoteDiffPath(path: string): string {
  const trimmedPath = path.trim();
  if (trimmedPath.length >= 2 && trimmedPath.startsWith('"') && trimmedPath.endsWith('"')) {
    return trimmedPath.slice(1, -1);
  }

  return trimmedPath;
}

function stripDiffPathPrefix(path: string): string {
  const unquotedPath = unquoteDiffPath(path);
  if (unquotedPath.startsWith("a/") || unquotedPath.startsWith("b/")) {
    return unquotedPath.slice(2);
  }

  return unquotedPath;
}

function parseDiffHeaderPath(headerValue: string): string | null {
  const trimmedValue = headerValue.trim();
  if (!trimmedValue) {
    return null;
  }

  if (trimmedValue.startsWith('"')) {
    const quotedPathMatch = trimmedValue.match(/^"((?:\\.|[^"\\])+)"/);
    return quotedPathMatch?.[1] ? stripDiffPathPrefix(quotedPathMatch[1]) : null;
  }

  const pathWithoutTimestamp = trimmedValue.split("\t", 1)[0]?.trim();
  return pathWithoutTimestamp ? stripDiffPathPrefix(pathWithoutTimestamp) : null;
}

function parseDiffGitLinePath(line: string): string | null {
  const gitPathMatch = line.match(
    /^diff --git (?:"((?:\\.|[^"\\])*)"|(\S+)) (?:"((?:\\.|[^"\\])*)"|(\S+))$/,
  );
  const nextPath = gitPathMatch?.[3] ?? gitPathMatch?.[4];
  const previousPath = gitPathMatch?.[1] ?? gitPathMatch?.[2];
  const normalizedNextPath = nextPath ? stripDiffPathPrefix(nextPath) : null;
  if (isUsableDiffFileTarget(normalizedNextPath)) {
    return normalizedNextPath;
  }

  const normalizedPreviousPath = previousPath ? stripDiffPathPrefix(previousPath) : null;
  return isUsableDiffFileTarget(normalizedPreviousPath) ? normalizedPreviousPath : null;
}

function getPatchHeaderFileTarget(patch: string): string | null {
  for (const line of patch.split(/\r?\n/)) {
    const diffGitTarget = parseDiffGitLinePath(line);
    if (diffGitTarget) {
      return diffGitTarget;
    }

    if (line.startsWith("+++ ")) {
      const nextFileTarget = parseDiffHeaderPath(line.slice(4));
      if (isUsableDiffFileTarget(nextFileTarget)) {
        return nextFileTarget;
      }
    }
  }

  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("--- ")) {
      continue;
    }

    const previousFileTarget = parseDiffHeaderPath(line.slice(4));
    if (isUsableDiffFileTarget(previousFileTarget)) {
      return previousFileTarget;
    }
  }

  return null;
}

export function getDiffSourceFileTarget(
  source: PatchCodeViewerSource | MultiFileDiffCodeViewerSource,
): string | null {
  if (isUsableDiffFileTarget(source.path)) {
    return source.path;
  }

  if (source.type === "patch") {
    return getPatchHeaderFileTarget(source.patch);
  }

  return null;
}

export function createDiffSourceFilePreviewSource(
  source: PatchCodeViewerSource | MultiFileDiffCodeViewerSource,
  fallbackWorkspacePath?: string,
): FileCodeViewerSource | null {
  const fileTarget = getDiffSourceFileTarget(source);
  if (!fileTarget) {
    return null;
  }

  const workspacePath = source.workspacePath ?? fallbackWorkspacePath;
  if (!isAbsoluteFilePath(fileTarget) && !workspacePath) {
    return null;
  }

  const path = resolveViewerPath(fileTarget, workspacePath ?? "");
  if (!path) {
    return null;
  }

  // diff tab 只保存 diff source；打开“原文件预览”时必须保留 workspace scope，
  // 否则远程 workspace 或手机远控会按本地路径边界去读文件。
  return {
    type: "file",
    title: getPathLeaf(path),
    path,
    ...(workspacePath ? { workspacePath } : {}),
    ...(source.workspaceIdentity ? { workspaceIdentity: source.workspaceIdentity } : {}),
    ...(source.workspaceRemoteSessionId
      ? { workspaceRemoteSessionId: source.workspaceRemoteSessionId }
      : {}),
  };
}

export function getToolCallCodePreview(
  toolCall: ChatToolCall,
  workspacePath: string,
): CodeViewerSource | null {
  // 结构化 diff 是工具结果的显式变更事实，优先于 input/output 中的全文预览。
  const structuredDiff = extractStructuredDiff(toolCall.raw);
  const resolvedPath = resolveViewerPath(
    structuredDiff?.path ?? extractRawPath(toolCall.input) ?? extractRawPath(toolCall.output),
    workspacePath,
  );
  const viewerTitle = normalizeToolLabel(toolCall.title ?? toolCall.kind, resolvedPath);
  const identity = resolveToolCallIdentity(toolCall);
  const isDiffTool = isFileDiffToolCall(toolCall, identity);
  const isReadTool = identity.family === "file-read";
  const isWriteTool = isFileContentWriteToolCall(toolCall, identity);

  if (structuredDiff) {
    const patch = buildUnifiedDiff(
      structuredDiff.oldText,
      structuredDiff.newText,
      resolvedPath ? getPathLeaf(resolvedPath) : "preview",
    );

    if (patch) {
      return {
        type: "patch",
        title: viewerTitle,
        path: resolvedPath,
        patch,
      };
    }

    return {
      ...buildTextPreview(viewerTitle, resolvedPath, structuredDiff.newText),
    };
  }

  const explicitPatch = extractDiffText(toolCall.output) ?? extractDiffText(toolCall.input);
  if (explicitPatch) {
    return {
      type: "patch",
      title: viewerTitle,
      path: resolvedPath,
      patch: explicitPatch,
    };
  }

  if (isDiffTool) {
    const beforeAfter = extractBeforeAfter(toolCall.input) ?? extractBeforeAfter(toolCall.output);
    if (beforeAfter) {
      const patch = buildUnifiedDiff(
        beforeAfter.before,
        beforeAfter.after,
        resolvedPath ? getPathLeaf(resolvedPath) : "preview",
      );

      if (patch) {
        return {
          type: "patch",
          title: viewerTitle,
          path: resolvedPath,
          patch,
        };
      }

      return {
        ...buildTextPreview(viewerTitle, resolvedPath, beforeAfter.after),
      };
    }
  }

  const preferredContent = isReadTool
    ? (extractContentText(toolCall.output) ?? extractContentText(toolCall.input))
    : isWriteTool
      ? (extractContentText(toolCall.input) ?? extractContentText(toolCall.output))
      : (extractContentText(toolCall.output) ?? extractContentText(toolCall.input));

  if (preferredContent) {
    return buildTextPreview(viewerTitle, resolvedPath, preferredContent);
  }

  if (
    resolvedPath &&
    (isDiffTool || isReadTool || isWriteTool) &&
    isImagePreviewPath(resolvedPath)
  ) {
    return {
      type: "image",
      title: viewerTitle,
      path: resolvedPath,
      mediaType: inferImageMediaType(resolvedPath) ?? "application/octet-stream",
    };
  }

  if (resolvedPath) {
    return {
      type: "file",
      title: viewerTitle,
      path: resolvedPath,
    };
  }

  return null;
}

export function getToolCallCodeContentPreview(
  toolCall: ChatToolCall,
  workspacePath: string,
): TextCodeViewerSource | null {
  const structuredDiff = extractStructuredDiff(toolCall.raw);
  const resolvedPath = resolveViewerPath(
    structuredDiff?.path ?? extractRawPath(toolCall.input) ?? extractRawPath(toolCall.output),
    workspacePath,
  );
  const viewerTitle = normalizeToolLabel(toolCall.title ?? toolCall.kind, resolvedPath);
  const identity = resolveToolCallIdentity(toolCall);
  const isDiffTool = isFileDiffToolCall(toolCall, identity);
  const isReadTool = identity.family === "file-read";
  const isWriteTool = isFileContentWriteToolCall(toolCall, identity);

  if (structuredDiff) {
    return buildTextPreview(viewerTitle, resolvedPath, structuredDiff.newText);
  }

  if (isDiffTool) {
    const beforeAfter = extractBeforeAfter(toolCall.input) ?? extractBeforeAfter(toolCall.output);
    if (beforeAfter) {
      return buildTextPreview(viewerTitle, resolvedPath, beforeAfter.after);
    }
  }

  const preferredContent = isReadTool
    ? (extractContentText(toolCall.output) ?? extractContentText(toolCall.input))
    : isWriteTool
      ? (extractContentText(toolCall.input) ?? extractContentText(toolCall.output))
      : (extractContentText(toolCall.output) ?? extractContentText(toolCall.input));

  if (!preferredContent) {
    return null;
  }

  return buildTextPreview(viewerTitle, resolvedPath, preferredContent);
}
