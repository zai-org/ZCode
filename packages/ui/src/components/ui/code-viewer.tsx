"use client";

import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  Ref,
} from "react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Trash2Icon } from "lucide-react";
import type { FileContents, LineAnnotation, SupportedLanguages } from "@pierre/diffs";
import { File, type FileOptions } from "@pierre/diffs/react";
import type { BundledTheme } from "shiki";

import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import type { CodeCommentPreview, CodeCommentRange } from "@/lib/codeCommentContext.js";
import { isDarkCodePreviewTheme } from "@/lib/codePreviewPreferences.js";
import { DIFFS_PREFERRED_HIGHLIGHTER } from "@/lib/diffsHighlighterEngine.js";
import {
  formatCommandShortcutLabel,
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "@/lib/keyboardShortcuts.js";

export interface CodeCommentLabels {
  addComment: string;
  addCommentTooltip: string;
  commentPlaceholder: string;
  submitComment: string;
  cancelComment: string;
  deleteComment: string;
  commentLine: string;
  commentRange: string;
}

export interface CodeViewerProps extends HTMLAttributes<HTMLDivElement> {
  code: string;
  enableSyntaxHighlighting?: boolean;
  language: string;
  showLineNumbers?: boolean;
  theme?: BundledTheme;
  wrapLongLines?: boolean;
  fontSizePx?: number;
  firstLineNumber?: number;
  comments?: readonly CodeCommentPreview[];
  topComment?: CodeCommentPreview | null;
  topCommentShowRange?: boolean;
  topCommentNotice?: string;
  focusedRange?: CodeCommentRange | null;
  /**
   * 文件链接定位的行号段（已按文件行数截断，按链接里的顺序）。与 focusedRange（代码评审）互斥使用：
   * 首段走 selectedLines，其余段经 unsafeCSS 注入同款选中样式；滚动时跨度（首段起始行到最大结束行）
   * 放得下就居中，放不下起始行置顶。同样由 focusRequestId 变化触发。
   */
  focusedLineRanges?: readonly CodeCommentRange[] | null;
  focusRequestId?: string;
  /**
   * 定位成功滚动后回报这次的 focusRequestId。文件链接用它让持有 tab 状态的一方记下「已定位」，
   * 之后重新挂载、内容刷新不再滚动；不能用组件内 ref 记，重新挂载会丢。代码评审不传，行为不变。
   */
  onFocusRequestApplied?: (requestId: string) => void;
  /**
   * 需要点名的行号（1 起，与 `firstLineNumber` 同一坐标）：只把这些行的**行号**染成警示色，
   * 代码本身不动。编译反馈卡用它标出被诊断指到的行。
   */
  markedLines?: readonly number[];
  enableLineSelection?: boolean;
  enableGutterUtility?: boolean;
  labels?: Partial<CodeCommentLabels>;
  onSubmitCodeComment?: (params: {
    range: CodeCommentRange;
    selectedText: string;
    comment: string;
  }) => void;
  onDeleteCodeComment?: (commentId: string) => void;
  scrollContainerRef?: Ref<HTMLDivElement>;
}

export function resolveCodeViewerColorScheme(theme?: BundledTheme): "light" | "dark" {
  if (!theme) {
    if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
      return "dark";
    }
    return "light";
  }

  return isDarkCodePreviewTheme(theme) ? "dark" : "light";
}

function setOptionalRefValue<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) {
    return;
  }

  if (typeof ref === "function") {
    ref(value);
    return;
  }

  (ref as { current: T | null }).current = value;
}

type CodeViewerAnnotationMetadata =
  | {
      kind: "comment";
      comment: CodeCommentPreview;
    }
  | {
      kind: "draft";
      range: CodeCommentRange;
    };

interface SelectedLineRange {
  start: number;
  end: number;
}

type CodeViewerStyle = CSSProperties & {
  "--code-comment-add-tooltip"?: string;
  "--diffs-bg"?: string;
  "--diffs-light-bg"?: string;
  "--diffs-dark-bg"?: string;
  "--diffs-font-family"?: string;
  "--diffs-font-size"?: string;
};

const DEFAULT_CODE_COMMENT_LABELS: CodeCommentLabels = {
  addComment: "Add comment",
  addCommentTooltip: "Click or drag to comment",
  commentPlaceholder: "Comment",
  submitComment: "Add comment",
  cancelComment: "Cancel",
  deleteComment: "Delete comment",
  commentLine: "Line {line}",
  commentRange: "Lines {startLine}-{endLine}",
};

const CODE_VIEWER_UNSAFE_CSS = [
  "[data-gutter-utility-slot]{left:auto;right:4px;justify-content:flex-end;align-items:center;}",
  "[data-utility-button]{margin-left:0;margin-right:0;}",
  "@media (hover:hover) and (pointer:fine){",
  "[data-utility-button]::after{content:var(--code-comment-add-tooltip);position:absolute;left:calc(100% + 6px);top:50%;transform:translateY(-50%);max-width:16rem;white-space:nowrap;pointer-events:none;opacity:0;z-index:5;border:1px solid var(--color-border);border-radius:8px;background:var(--color-tooltip);color:var(--color-tooltip-foreground);padding:4px 8px;font-family:var(--diffs-header-font-family,var(--diffs-header-font-fallback));font-size:12px;line-height:16px;box-shadow:0 4px 12px rgb(0 0 0 / 0.14);}",
  "[data-utility-button]:hover::after,[data-utility-button]:focus-visible::after{opacity:1;}",
  "}",
].join("");

/**
 * 被点名行号的着色规则。行号格是 @pierre/diffs 在 Shadow DOM 里画的 `[data-column-number="<行号>"]`，
 * 外层 class 进不去，只能随 unsafeCSS 注入；颜色走应用 token（自定义属性穿透 shadow root），
 * 深浅主题自动跟随。非正整数与重复值丢弃，空集合返回空串。
 */
export function codeViewerMarkedLinesCss(lines: readonly number[] | undefined): string {
  const unique = [...new Set(lines ?? [])].filter((line) => Number.isInteger(line) && line > 0);
  if (unique.length === 0) return "";
  const selector = unique.map((line) => `[data-column-number="${line}"]`).join(",");
  return `${selector}{color:var(--color-warning);}`;
}

/**
 * 文件链接多段高亮里第一段以外的行。@pierre/diffs 的 selectedLines 只支持一个连续区间，
 * 选中样式又只认它自己写在 Shadow DOM 里的 `[data-selected-line]` 属性；这里按行号点名，
 * 照抄 @pierre/diffs style.css 中 `[data-selected-line]` 规则设置的同一组变量，
 * 让代码底色、行号底色和行号文字色与第一段完全一致，深浅主题随其 light-dark() 自动跟随。
 * 升级 @pierre/diffs 时若选中规则变化需同步；MFL02 E2E 比对各段计算后的颜色，能发现漂移。
 * 选择器按行号点名，体积随行数线性增长；按段顺序累计（去重）最多点名
 * CODE_VIEWER_EXTRA_SELECTED_LINES_LIMIT 行，超出部分不注入高亮（docs/ui/preview-pane.md）。
 */
const CODE_VIEWER_EXTRA_SELECTED_LINES_LIMIT = 2000;

export function codeViewerExtraSelectedLinesCss(
  ranges: readonly CodeCommentRange[] | undefined,
): string {
  const lines = new Set<number>();
  for (const { startLine, endLine } of ranges ?? []) {
    for (let line = startLine; line <= endLine; line += 1) {
      if (lines.size >= CODE_VIEWER_EXTRA_SELECTED_LINES_LIMIT) break;
      lines.add(line);
    }
  }
  if (lines.size === 0) return "";
  const codeSelector = [...lines].map((line) => `[data-line="${line}"]`).join(",");
  const gutterSelector = [...lines].map((line) => `[data-column-number="${line}"]`).join(",");
  const selectedBackground =
    "--diffs-computed-selected-line-bg:light-dark(color-mix(in lab, var(--diffs-computed-diff-line-bg) var(--mix-selection-light), var(--diffs-selection-mix-target)),color-mix(in lab, var(--diffs-computed-diff-line-bg) var(--mix-selection-dark), var(--diffs-selection-mix-target)));--diffs-line-bg:var(--diffs-computed-selected-line-bg,inherit);";
  return [
    `:is(${codeSelector}):not([data-column-number]){--mix-selection-light:82%;--mix-selection-dark:75%;${selectedBackground}}`,
    `:is(${gutterSelector}){--mix-selection-light:75%;--mix-selection-dark:60%;--diffs-selection-mix-target:var(--diffs-bg-selection-number-override,var(--diffs-selection-base));${selectedBackground}color:var(--diffs-selection-number-fg);}`,
  ].join("");
}

function toCssString(value: string) {
  return JSON.stringify(value);
}

function hashCodeViewerContent(code: string): string {
  let hash = 5381;
  for (let index = 0; index < code.length; index += 1) {
    hash = (hash * 33) ^ code.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}

function readCodeCommentShortcutPlatformInfo(): KeyboardShortcutPlatformInfo {
  if (typeof navigator === "undefined") {
    return {};
  }

  return {
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  };
}

export function isCodeCommentSubmitShortcut(
  event: Pick<ReactKeyboardEvent<HTMLTextAreaElement>, "ctrlKey" | "key" | "metaKey">,
  platformInfo: KeyboardShortcutPlatformInfo = readCodeCommentShortcutPlatformInfo(),
) {
  if (event.key !== "Enter") {
    return false;
  }

  return isAppleKeyboardPlatform(platformInfo) ? event.metaKey : event.ctrlKey;
}

export function isCodeCommentCancelShortcut(
  event: Pick<ReactKeyboardEvent<HTMLTextAreaElement>, "key">,
) {
  return event.key === "Escape";
}

export function formatCodeCommentSubmitShortcutLabel(platformInfo?: KeyboardShortcutPlatformInfo) {
  return formatCommandShortcutLabel("↵", platformInfo);
}

export function formatCodeCommentCancelShortcutLabel() {
  return "Esc";
}

function patchCodeCommentUtilityButtons(root: ParentNode, label: string) {
  for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-utility-button]")) {
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}

function walkShadowRoots(root: ParentNode, callback: (root: ShadowRoot) => void) {
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (!element.shadowRoot) {
      continue;
    }

    callback(element.shadowRoot);
    walkShadowRoots(element.shadowRoot, callback);
  }
}

export function findCodeViewerLineElement(
  root: ParentNode,
  lineNumber: number,
): HTMLElement | null {
  const target = root.querySelector<HTMLElement>(`[data-line="${lineNumber}"]`);
  if (target) return target;

  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (!element.shadowRoot) continue;
    const shadowTarget = findCodeViewerLineElement(element.shadowRoot, lineNumber);
    if (shadowTarget) return shadowTarget;
  }
  return null;
}

export function findCodeViewerCommentElement(
  root: ParentNode,
  commentId: string,
): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>("[data-code-comment-id]")) {
    if (element.dataset.codeCommentId === commentId) {
      return element;
    }
  }

  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (!element.shadowRoot) continue;
    const shadowTarget = findCodeViewerCommentElement(element.shadowRoot, commentId);
    if (shadowTarget) return shadowTarget;
  }
  return null;
}

function createCodeViewerFile(params: {
  code: string;
  enableSyntaxHighlighting: boolean;
  language: string;
  theme?: BundledTheme;
}): FileContents {
  const lang = params.enableSyntaxHighlighting
    ? (params.language as SupportedLanguages)
    : ("text" as SupportedLanguages);
  const name = params.language ? `preview.${params.language}` : "preview.txt";
  const themeCacheKey = params.theme ?? "auto";

  return {
    name,
    contents: params.code,
    lang,
    // @pierre/diffs 会按 file.cacheKey 复用 token；旧 key 没带主题，导致同一 task 内
    // 切换 app light/dark 时继续命中旧高亮，只有切换 task 触发重建后才恢复。
    cacheKey: `${themeCacheKey}:${name}:${lang}:${params.code.length}:${hashCodeViewerContent(params.code)}`,
  };
}

function normalizeRange(range: CodeCommentRange): CodeCommentRange {
  return {
    startLine: Math.min(range.startLine, range.endLine),
    endLine: Math.max(range.startLine, range.endLine),
  };
}

function selectedRangeToCodeCommentRange(
  range: SelectedLineRange,
  firstLineNumber: number,
): CodeCommentRange {
  return normalizeRange({
    startLine: firstLineNumber + range.start - 1,
    endLine: firstLineNumber + range.end - 1,
  });
}

function codeCommentRangeToSelectedRange(
  range: CodeCommentRange,
  firstLineNumber: number,
): SelectedLineRange {
  const normalizedRange = normalizeRange(range);
  return {
    start: normalizedRange.startLine - firstLineNumber + 1,
    end: normalizedRange.endLine - firstLineNumber + 1,
  };
}

function getTextForLineRange(code: string, firstLineNumber: number, range: CodeCommentRange) {
  const lines = code.split("\n");
  const normalizedRange = normalizeRange(range);
  const startIndex = Math.max(normalizedRange.startLine - firstLineNumber, 0);
  const endIndex = Math.min(normalizedRange.endLine - firstLineNumber, lines.length - 1);
  if (startIndex > endIndex) {
    return "";
  }

  return lines.slice(startIndex, endIndex + 1).join("\n");
}

function formatCommentRange(labels: CodeCommentLabels, range: CodeCommentRange) {
  const normalizedRange = normalizeRange(range);
  if (normalizedRange.startLine === normalizedRange.endLine) {
    return labels.commentLine.replaceAll("{line}", String(normalizedRange.startLine));
  }

  return labels.commentRange
    .replaceAll("{startLine}", String(normalizedRange.startLine))
    .replaceAll("{endLine}", String(normalizedRange.endLine));
}

function CommentDraft({
  range,
  labels,
  value,
  onValueChange,
  onSubmit,
  onCancel,
}: {
  range: CodeCommentRange;
  labels: CodeCommentLabels;
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cancelShortcutLabel = formatCodeCommentCancelShortcutLabel();
  const cancelLabel = `${labels.cancelComment} (${cancelShortcutLabel})`;
  const submitShortcutLabel = formatCodeCommentSubmitShortcutLabel();
  const submitLabel = `${labels.submitComment} (${submitShortcutLabel})`;

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, []);

  return (
    <div className="m-2 rounded-lg border border-border bg-background p-3 font-sans shadow-sm">
      <div className="mb-2 text-ui-base text-foreground-subtle">
        {formatCommentRange(labels, range)}
      </div>
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (isCodeCommentSubmitShortcut(event)) {
            event.preventDefault();
            onSubmit();
            return;
          }

          if (!isCodeCommentCancelShortcut(event)) {
            return;
          }

          event.preventDefault();
          onCancel();
        }}
        placeholder={labels.commentPlaceholder}
        className="min-h-16 w-full resize-none rounded-lg border-input-border bg-input text-ui-base text-foreground placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 md:text-ui-base"
        rows={3}
        autoFocus
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          title={cancelLabel}
          aria-label={cancelLabel}
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
        <Button type="button" title={submitLabel} aria-label={submitLabel} onClick={onSubmit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

export function CodeCommentAnnotation({
  comment,
  labels,
  onDelete,
  showRange = true,
}: {
  comment: CodeCommentPreview;
  labels: CodeCommentLabels;
  onDelete?: (commentId: string) => void;
  showRange?: boolean;
}) {
  return (
    <div
      data-code-comment-id={comment.id}
      className="m-2 rounded-lg border border-border bg-background p-3 font-sans shadow-sm"
    >
      {showRange ? (
        <div className="mb-2 text-ui-base text-foreground-subtle">
          {formatCommentRange(labels, comment)}
        </div>
      ) : null}
      {comment.comment.trim() ? (
        <div className="whitespace-pre-wrap text-ui-base leading-relaxed text-foreground">
          {comment.comment}
        </div>
      ) : null}
      {onDelete ? (
        <div className="mt-2 flex items-center justify-end">
          <Button
            type="button"
            variant="ghost"
            className="text-foreground-subtle hover:text-foreground"
            title={labels.deleteComment}
            aria-label={labels.deleteComment}
            onClick={() => onDelete(comment.id)}
          >
            <Trash2Icon className="size-4" />
            {labels.deleteComment}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function CodeViewer({
  code,
  enableSyntaxHighlighting = true,
  language,
  showLineNumbers = true,
  theme,
  wrapLongLines = false,
  fontSizePx = 12,
  firstLineNumber = 1,
  comments = [],
  topComment = null,
  topCommentShowRange = true,
  topCommentNotice,
  focusedRange = null,
  focusedLineRanges = null,
  focusRequestId,
  onFocusRequestApplied,
  markedLines,
  enableLineSelection = false,
  enableGutterUtility = false,
  labels: labelOverrides,
  onSubmitCodeComment,
  onDeleteCodeComment,
  scrollContainerRef,
  className,
  style,
  ...props
}: CodeViewerProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const [activeDraftRange, setActiveDraftRange] = useState<CodeCommentRange | null>(null);
  const [draftText, setDraftText] = useState("");
  const canCreateComment = Boolean(onSubmitCodeComment);
  /* markdown 代码块也复用 CodeViewer。之前只关闭评论按钮但保留行 hover，
     会让只读代码看起来仍可进入评论交互；这里把官方交互开关收敛到评论能力上。 */
  const canUseCommentLineSelection = canCreateComment && enableLineSelection;
  const canUseCommentGutterUtility = canCreateComment && enableGutterUtility;
  const labels = useMemo(
    () => ({ ...DEFAULT_CODE_COMMENT_LABELS, ...labelOverrides }),
    [labelOverrides],
  );
  const file = useMemo(
    () =>
      createCodeViewerFile({
        code,
        enableSyntaxHighlighting,
        language,
        theme,
      }),
    [code, enableSyntaxHighlighting, language, theme],
  );
  const lineAnnotations = useMemo<LineAnnotation<CodeViewerAnnotationMetadata>[]>(() => {
    const annotations: LineAnnotation<CodeViewerAnnotationMetadata>[] = [];

    for (const comment of comments) {
      const lineNumber = normalizeRange(comment).endLine - firstLineNumber + 1;
      if (lineNumber < 1) {
        continue;
      }

      annotations.push({
        lineNumber,
        metadata: {
          kind: "comment",
          comment,
        },
      });
    }

    if (canCreateComment && activeDraftRange) {
      annotations.push({
        lineNumber: normalizeRange(activeDraftRange).endLine - firstLineNumber + 1,
        metadata: {
          kind: "draft",
          range: activeDraftRange,
        },
      });
    }

    return annotations;
  }, [activeDraftRange, canCreateComment, comments, firstLineNumber]);
  // 代码评审用 focusedRange；文件链接用 focusedLineRanges，首段走原生选中样式。
  // 用起止行原始值做依赖：调用方每次渲染都会给新的数组/对象，不该因此重设选中区间。
  const primaryFocusedStartLine = (focusedRange ?? focusedLineRanges?.[0])?.startLine;
  const primaryFocusedEndLine = (focusedRange ?? focusedLineRanges?.[0])?.endLine;
  const hasActiveDraft = canCreateComment && activeDraftRange !== null;
  const selectedLines = useMemo(() => {
    if (hasActiveDraft && activeDraftRange) {
      return codeCommentRangeToSelectedRange(activeDraftRange, firstLineNumber);
    }
    return primaryFocusedStartLine !== undefined && primaryFocusedEndLine !== undefined
      ? codeCommentRangeToSelectedRange(
          { startLine: primaryFocusedStartLine, endLine: primaryFocusedEndLine },
          firstLineNumber,
        )
      : null;
  }, [
    activeDraftRange,
    firstLineNumber,
    hasActiveDraft,
    primaryFocusedEndLine,
    primaryFocusedStartLine,
  ]);
  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      if (!canCreateComment || !range) {
        return;
      }

      setActiveDraftRange(selectedRangeToCodeCommentRange(range, firstLineNumber));
      setDraftText("");
    },
    [canCreateComment, firstLineNumber],
  );
  const handleGutterUtilitySelection = useCallback(
    (range: SelectedLineRange) => {
      if (!canCreateComment) {
        return;
      }

      setActiveDraftRange(selectedRangeToCodeCommentRange(range, firstLineNumber));
      setDraftText("");
    },
    [canCreateComment, firstLineNumber],
  );
  const handleSubmitDraft = useCallback(() => {
    if (!activeDraftRange) {
      return;
    }

    const selectedText = getTextForLineRange(code, firstLineNumber, activeDraftRange);
    if (!selectedText.trim()) {
      return;
    }

    onSubmitCodeComment?.({
      range: normalizeRange(activeDraftRange),
      selectedText,
      comment: draftText.trim(),
    });
    setActiveDraftRange(null);
    setDraftText("");
  }, [activeDraftRange, code, draftText, firstLineNumber, onSubmitCodeComment]);
  useEffect(() => {
    if (!canUseCommentGutterUtility || !viewerRef.current) {
      return;
    }

    const root = viewerRef.current;
    const observers: MutationObserver[] = [];
    const observedRoots = new WeakSet<Node>();
    let animationFrame = 0;

    const observeRoot = (target: ParentNode) => {
      if (observedRoots.has(target)) {
        return;
      }

      observedRoots.add(target);
      const observer = new MutationObserver(schedulePatch);
      observer.observe(target, { childList: true, subtree: true });
      observers.push(observer);
    };

    const patch = () => {
      patchCodeCommentUtilityButtons(root, labels.addCommentTooltip);
      walkShadowRoots(root, (shadowRoot) => {
        observeRoot(shadowRoot);
        patchCodeCommentUtilityButtons(shadowRoot, labels.addCommentTooltip);
      });
    };

    function schedulePatch() {
      if (animationFrame) {
        return;
      }

      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        patch();
      });
    }

    // @pierre/diffs 的内建 gutter button 由内部 InteractionManager 生成。
    // 这里只补充 title/aria-label，不接管渲染或 pointer 事件，避免破坏拖拽选择多行评论。
    observeRoot(root);
    patch();
    schedulePatch();

    return () => {
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
      }
      for (const observer of observers) {
        observer.disconnect();
      }
    };
  }, [canUseCommentGutterUtility, labels.addCommentTooltip]);
  const focusedStartLine = primaryFocusedStartLine;
  const focusedEndLine = primaryFocusedEndLine;
  // 文件链接的定位跨度终点：各段中最大的结束行；代码评审不设，保持只居中起始行的旧行为。
  const fileLinkSpanEndLine =
    !focusedRange && focusedLineRanges?.length
      ? Math.max(...focusedLineRanges.map((range) => range.endLine))
      : undefined;
  // 回调身份随父组件渲染变化，不应让定位 effect 重跑；用 effect event 读最新回调。
  const reportFocusRequestApplied = useEffectEvent((requestId: string) => {
    onFocusRequestApplied?.(requestId);
  });
  useEffect(() => {
    if (!focusRequestId || focusedStartLine === undefined || !viewerRef.current) {
      return;
    }

    let animationFrame = 0;
    let attempts = 0;
    const targetLine = focusedStartLine - firstLineNumber + 1;
    const scrollToFocusedLine = () => {
      const container = viewerRef.current;
      const line = viewerRef.current
        ? findCodeViewerLineElement(viewerRef.current, targetLine)
        : null;
      const comment =
        focusRequestId && viewerRef.current
          ? findCodeViewerCommentElement(viewerRef.current, focusRequestId)
          : null;
      if (container && comment) {
        const containerRect = container.getBoundingClientRect();
        const commentRect = comment.getBoundingClientRect();
        const horizontalScrollLeft = container.scrollLeft;
        const commentBottom = container.scrollTop + commentRect.bottom - containerRect.top;
        // 评论跟随代码滚动，但点击卡片时把评论底部放在可视区下沿，
        // 让目标行和其下评论同时出现；只写 scrollTop，避免 scrollIntoView 改变横向位置。
        container.scrollTop = Math.max(0, commentBottom - container.clientHeight + 12);
        container.scrollLeft = horizontalScrollLeft;
        return;
      }
      if (container && line && fileLinkSpanEndLine !== undefined) {
        const spanEnd = findCodeViewerLineElement(
          container,
          fileLinkSpanEndLine - firstLineNumber + 1,
        );
        if (spanEnd) {
          const containerRect = container.getBoundingClientRect();
          const horizontalScrollLeft = container.scrollLeft;
          const spanTop =
            container.scrollTop + line.getBoundingClientRect().top - containerRect.top;
          const spanHeight =
            spanEnd.getBoundingClientRect().bottom - line.getBoundingClientRect().top;
          // 文件链接区间/多段：整体放得下就居中；放不下时起始行置顶，保证从起始行开始读。
          // 单行时跨度就是一行，结果与旧的居中一致。
          container.scrollTop = Math.max(
            0,
            spanHeight <= container.clientHeight
              ? spanTop + spanHeight / 2 - container.clientHeight / 2
              : spanTop,
          );
          container.scrollLeft = horizontalScrollLeft;
          reportFocusRequestApplied(focusRequestId);
          return;
        }
      } else if (container && line) {
        const containerRect = container.getBoundingClientRect();
        const lineRect = line.getBoundingClientRect();
        const horizontalScrollLeft = container.scrollLeft;
        const lineCenter =
          container.scrollTop + lineRect.top - containerRect.top + lineRect.height / 2;
        container.scrollTop = Math.max(0, lineCenter - container.clientHeight / 2);
        container.scrollLeft = horizontalScrollLeft;
        reportFocusRequestApplied(focusRequestId);
        return;
      }

      attempts += 1;
      if (attempts < 45) {
        animationFrame = window.requestAnimationFrame(scrollToFocusedLine);
      }
    };

    // @pierre/diffs 的真实代码行位于异步创建的 Shadow DOM 中；仅传
    // selectedLines 会高亮但不会定位。requestId 变化时短暂重试，确保同 tab 新评论可滚动。
    animationFrame = window.requestAnimationFrame(scrollToFocusedLine);
    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [
    file.cacheKey,
    fileLinkSpanEndLine,
    firstLineNumber,
    focusedEndLine,
    focusedStartLine,
    focusRequestId,
  ]);
  // 依赖是 CSS 字符串（内容）而不是数组引用：调用方每次渲染给一个新数组时，options 不该跟着换（File 会重排）。
  const markedLinesCss = codeViewerMarkedLinesCss(markedLines);
  // 文件链接第一段以外的段。用户拖选写评论时选中样式让给草稿，这些段也一起撤掉，避免只剩部分段高亮。
  // 调用方每次渲染都给新数组；以序列化后的段内容做 memo 依赖，只在段变化时重新生成选择器。
  const extraSelectedRangesKey =
    focusedRange || hasActiveDraft
      ? ""
      : JSON.stringify(
          (focusedLineRanges ?? []).slice(1).map((range) => ({
            startLine: range.startLine - firstLineNumber + 1,
            endLine: range.endLine - firstLineNumber + 1,
          })),
        );
  const extraSelectedLinesCss = useMemo(
    () =>
      extraSelectedRangesKey
        ? codeViewerExtraSelectedLinesCss(JSON.parse(extraSelectedRangesKey) as CodeCommentRange[])
        : "",
    [extraSelectedRangesKey],
  );
  const options = useMemo<FileOptions<CodeViewerAnnotationMetadata>>(
    () => ({
      disableFileHeader: true,
      disableLineNumbers: !showLineNumbers,
      overflow: wrapLongLines ? "wrap" : "scroll",
      theme,
      preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
      enableLineSelection: canUseCommentLineSelection,
      enableGutterUtility: canUseCommentGutterUtility,
      lineHoverHighlight:
        canUseCommentLineSelection || canUseCommentGutterUtility ? "both" : "disabled",
      onLineSelectionEnd: handleLineSelectionEnd,
      // 自定义 renderGutterUtility 只能拿 hover 行，拖拽 comment + 时会退化成单行。
      // 使用 @pierre/diffs 的 gutter selection 回调，让点击和拖拽都走同一套 range 计算。
      onGutterUtilityClick: canUseCommentGutterUtility ? handleGutterUtilitySelection : undefined,
      // 内建 comment + 默认贴在行号右侧，用户拖拽时容易和代码起点混在一起。
      // 这里只调整 Shadow DOM 内 gutter utility 的位置，不接管 pointer 事件，避免破坏多行拖拽 range。
      unsafeCSS: CODE_VIEWER_UNSAFE_CSS + markedLinesCss + extraSelectedLinesCss,
    }),
    [
      canUseCommentGutterUtility,
      canUseCommentLineSelection,
      extraSelectedLinesCss,
      handleGutterUtilitySelection,
      handleLineSelectionEnd,
      markedLinesCss,
      showLineNumbers,
      theme,
      wrapLongLines,
    ],
  );
  const viewerStyle = useMemo<CodeViewerStyle>(
    () => ({
      // 手机远控页面可能是深色主题，但浏览器系统偏好仍是浅色。
      // @pierre/diffs 的 token 颜色依赖 color-scheme/light-dark()，必须跟随代码主题显式指定，
      // 否则 text 代码块会在深色卡片上渲染成浅色主题的深色文字，看起来像正文丢失。
      colorScheme: resolveCodeViewerColorScheme(theme),
      "--diffs-bg": "var(--color-background)",
      "--diffs-light-bg": "var(--color-background)",
      "--diffs-dark-bg": "var(--color-background)",
      // @pierre/diffs 在 Shadow DOM 内使用自己的等宽 fallback，Windows 中文会落到宋体。
      // 显式透传应用 token，让 Markdown code block、文件预览和 inline code 使用同一 CJK fallback。
      "--diffs-font-family": "var(--font-mono)",
      "--diffs-font-size": `${fontSizePx}px`,
      "--code-comment-add-tooltip": toCssString(
        canUseCommentGutterUtility ? labels.addCommentTooltip : "",
      ),
      ...style,
    }),
    [canUseCommentGutterUtility, fontSizePx, labels.addCommentTooltip, style, theme],
  );
  const assignCodeViewerScrollContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      viewerRef.current = node;
      setOptionalRefValue(scrollContainerRef, node);
    },
    [scrollContainerRef],
  );

  return (
    <div
      ref={assignCodeViewerScrollContainerRef}
      className={cn("h-full w-full overflow-auto", className)}
      data-language={language}
      style={viewerStyle}
      {...props}
    >
      {topCommentNotice ? (
        <div data-code-review-target-warning className="px-3 pt-3 text-ui-sm text-warning">
          {topCommentNotice}
        </div>
      ) : null}
      {topComment ? (
        <CodeCommentAnnotation
          comment={topComment}
          labels={labels}
          showRange={topCommentShowRange}
        />
      ) : null}
      <File
        key={file.cacheKey}
        file={file}
        options={options}
        lineAnnotations={lineAnnotations}
        selectedLines={selectedLines}
        className="min-h-full w-full"
        style={viewerStyle}
        renderAnnotation={(annotation) =>
          annotation.metadata.kind === "draft" ? (
            <CommentDraft
              range={annotation.metadata.range}
              labels={labels}
              value={draftText}
              onValueChange={setDraftText}
              onSubmit={handleSubmitDraft}
              onCancel={() => {
                setActiveDraftRange(null);
                setDraftText("");
              }}
            />
          ) : (
            <CodeCommentAnnotation
              comment={annotation.metadata.comment}
              labels={labels}
              onDelete={onDeleteCodeComment}
            />
          )
        }
      />
    </div>
  );
}
