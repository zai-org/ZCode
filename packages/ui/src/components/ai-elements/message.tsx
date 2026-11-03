/*
 * Derived from vercel/ai-elements (packages/elements/src/message.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { Button } from "../ui/button.js";
import { ButtonGroup, ButtonGroupText } from "../ui/button-group.js";
import { cn } from "../lib/utils.js";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { EditorInfo, FileStat, OpenInEditorOptions } from "@zcode/shared";
import type { UIMessage } from "ai";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  PanelRightIcon,
} from "lucide-react";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import type {
  ComponentProps,
  ErrorInfo,
  HTMLAttributes,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
} from "react";
import {
  Component,
  createContext,
  forwardRef,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BundledTheme } from "shiki";
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown } from "streamdown";
import type { Pluggable, PluggableList } from "unified";
import { CodeBlock, CodeBlockHeader } from "@/components/ai-elements/code-block.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { MarkdownBlockquote } from "@/components/ai-elements/markdown-blockquote.js";
import {
  MarkdownListItem,
  MarkdownOrderedList,
  MarkdownUnorderedList,
} from "@/components/ai-elements/markdown-list.js";
import {
  MarkdownTable,
  MarkdownTableBody,
  MarkdownTableCell,
  MarkdownTableHead,
  MarkdownTableHeader,
  MarkdownTableRow,
} from "@/components/ai-elements/markdown-table.js";
import {
  MarkdownImage,
  MarkdownImageParagraph,
  normalizeConsecutiveMarkdownImageBlocks,
  type MarkdownImageProps,
} from "@/components/ai-elements/markdown-image.js";
import { STREAMDOWN_CONTROLS } from "@/components/ai-elements/streamdown-controls.js";
import { resolveMessageLinkOpenTarget } from "@/embeddedBrowserHelpers.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { persistLastSelectedEditorId } from "@/lib/editorPreference.js";
import {
  FileDisplayIcon,
  FOLDER_FILE_ICON_SRC,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import {
  normalizeWorkspaceRelativeFilePath,
  parseMarkdownFileLinkTarget,
  resolveMarkdownFileLink,
} from "@/lib/markdownFileLink.js";
import { stripBalancedAssistantPathQuotes } from "@/lib/assistantPathQuotes.js";
import { getPathLeaf } from "@/lib/path.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";
import { resolveWorkspaceEditorSelection } from "@/lib/workspaceEditorSelection.js";
import {
  getFileManagerLabel,
  sortInstalledEditorsForFileTree,
} from "@/workspace-file-tree/helpers.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useOptionalPlatform, usePlatform } from "@/hooks/usePlatform.js";
import { FileApplicationChoices, FileSaveAsMenuItem } from "@/file-menu/index.js";
import { useFileApplications } from "@/file-menu/index.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { Theme } from "@/useTheme.js";
import { createZCodeFileCitationRemarkPlugin } from "@/lib/zcodeFileCitationRemarkPlugin.js";
import { windowsFileLinkEscapeRemarkPlugin } from "@/lib/windowsFileLinkEscapeRemarkPlugin.js";
import { projectZCodeFileCitations } from "@/lib/zcodeFileCitation.js";
import { rewriteMarkdownArtifactImageSources } from "@zcode/shared";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-ui-base",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <ControlHintTooltip title={tooltip} side="bottom">
        {button}
      </ControlHintTooltip>
    );
  }

  return button;
};

interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(null);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error("MessageBranch components must be used within MessageBranch");
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch);
      onBranchChange?.(newBranch);
    },
    [onBranchChange],
  );

  const goToPrevious = useCallback(() => {
    const newBranch = currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const goToNext = useCallback(() => {
    const newBranch = currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious],
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div className={cn("grid w-full gap-2 [&>div]:pb-0", className)} {...props} />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({ children, ...props }: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children],
  );

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden",
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

export const MessageBranchSelector = ({ className, ...props }: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className,
      )}
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({ children, ...props }: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({ children, ...props }: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({ className, ...props }: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn("border-none bg-transparent text-muted-foreground shadow-none", className)}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = {
  /** 办公模式的正式回答固定换行，不覆盖用户保存的代码预览设置。 */
  forceCodeWrap?: boolean;
  className?: string;
  children?: ReactNode;
  dir?: "auto" | "ltr" | "rtl";
  streaming?: boolean;
  streamingAnimationKey?: string;
  workspacePath?: string;
  workspaceHomePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  sessionId?: string;
  readAttachment?: (params: {
    sessionId: string;
    ref: string;
  }) => Promise<{ bytes: Uint8Array; mediaType: string } | { url: string; mediaType: string }>;
  /**
   * 应用主题（store 耦合剥离）：决定代码块高亮取 light/dark 主题。
   * 由调用方从上层状态传入；默认 "system" 跟随操作系统，供待删旧调用点兜底。
   */
  theme?: Theme;
  /**
   * 代码预览设置（store 耦合剥离）：由调用方传入，需保持引用稳定。
   * 默认 DEFAULT_CODE_PREVIEW_SETTINGS。
   */
  codePreviewSettings?: CodePreviewSettings;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenExternalUrl?: (url: string) => void;
  /** 仅 Assistant 正文开启：把完整 zcode-file-citation 投影为现有文件链接。 */
  renderZCodeFileCitations?: boolean;
};

export interface MessageFileLinkTarget {
  path: string;
  label: string;
  /** 仅用于显式尾随斜杠的目录展示提示；打开第三方应用前必须重新 stat。 */
  pathKind?: NonNullable<OpenInEditorOptions["pathKind"]>;
  relativePath?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

// @streamdown/math 默认不解析 `$...$` 行内公式，导致客户消息里块级 `$$...$$`
// 能渲染而 `$c(\mathbf{r})$` 会原样显示；聊天消息需要兼容常见 Markdown/LaTeX 输出。
const messageMathPlugin = createMathPlugin({ singleDollarTextMath: true });

function disableSingleTilde(plugin: Pluggable): Pluggable {
  if (!Array.isArray(plugin)) {
    return typeof plugin === "function" ? [plugin, { singleTilde: false }] : plugin;
  }

  const [attacher, existingOptions] = plugin;
  return [
    attacher,
    {
      ...(typeof existingOptions === "object" && existingOptions !== null ? existingOptions : {}),
      singleTilde: false,
    },
  ];
}

const messageCjkRemarkPluginsAfter = cjk.remarkPluginsAfter.map((plugin) => {
  const attacher = Array.isArray(plugin) ? plugin[0] : plugin;
  return attacher === remarkCjkFriendlyGfmStrikethrough ? disableSingleTilde(plugin) : plugin;
});
const messageCjkPlugin: typeof cjk = {
  ...cjk,
  remarkPlugins: [...cjk.remarkPluginsBefore, ...messageCjkRemarkPluginsAfter],
  remarkPluginsAfter: messageCjkRemarkPluginsAfter,
};
const streamdownPlugins = { cjk: messageCjkPlugin, code, math: messageMathPlugin, mermaid };
const messageLinkSafety = { enabled: false } as const;
// `decoration-dashed` 会把原有的细圆点下划线绘制成短线段；这里只改变下划线的
// 出现时机，继续使用 `dotted` 保留原视觉形态。
const messageLinkClassName =
  "wrap-anywhere text-ui-base font-medium text-icon-blue no-underline decoration-dotted underline-offset-4 hover:underline";
// `items-center` 让 inline-flex 使用浏览器合成的基线，固定 top 偏移又会随平台字体产生漂移。
// 改为由文字子项提供真实 baseline；图标只在链接自身行盒内居中，桌面和移动 Web 共用同一语义。
const messageFileLinkClassName =
  "inline-flex max-w-full items-baseline gap-1 align-baseline text-icon-blue text-ui-base no-underline decoration-dotted underline-offset-4 hover:underline";
// Markdown 之前继承紧凑 UI 字号，正文、标题、链接和表格缺少独立的阅读层级。
// 这里显式定义字号层级，并让标题跟随 UI 字号 Token 缩放，确保聊天、预览和工具面板复用 MessageResponse 时保持一致。
const messageMarkdownHeadingClassNames = {
  h1: "mt-6 mb-4 text-ui-xl font-semibold",
  h2: "mt-6 mb-4 text-ui-lg font-semibold",
  h3: "mt-6 mb-4 text-ui-base font-semibold",
  h4: "mt-6 mb-4 text-ui-base font-semibold",
  h5: "mt-6 mb-4 text-ui-base font-medium",
  h6: "mt-6 mb-4 text-ui-base font-normal",
} as const;
const languageClassNamePattern = /(?:^|\s)language-([^\s]+)/;
const fileUrlProtocolPattern = /^file:\/\//i;
const windowsDriveAbsolutePathPattern = /^[a-zA-Z]:[\\/]/;
const knownExtensionlessFileNames = new Set([
  "dockerfile",
  "gemfile",
  "license",
  "makefile",
  "readme",
]);
const markdownFencePattern = /^(?: {0,3})(`{3,}|~{3,})/;
const likelyMathSyntaxPattern = /[\\{}^_=+\-*/<>|()[\]∇∂∫∑√∞≈≠≤≥±×÷πΠα-ωΑ-Ω]/u;
const texCommandPattern = /\\[A-Za-z]+/;
const simpleMathIdentifierPattern = /^(?:[A-Za-z]|[a-z][A-Za-z0-9]{1,2}|\d+(?:\.\d+)?)$/;
const compactCurrencyRangePrefixPattern = /^(?:\d[\d,]*(?:\.\d+)?|\.\d+)[+\-*/]$/;
const compactCurrencyAmountStartPattern = /^(?:\d|\.\d)/;

type MarkdownCodeProps = ComponentProps<"code"> & {
  node?: unknown;
  "data-block"?: unknown;
};
type MarkdownHeadingProps = ComponentProps<"h1"> & {
  node?: unknown;
};
type MarkdownStrongProps = ComponentProps<"strong"> & {
  node?: unknown;
};
type MessageStreamdownMode = "static" | "streaming";
type HastElementNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastElementNode[];
};
type MessageResponseBoundaryScope = {
  markdownLength: number;
  mode: MessageStreamdownMode;
  renderStreaming: boolean;
};

interface MessageResponseMarkdownBoundaryProps {
  children: ReactNode;
  className?: string;
  fallbackText: string;
  resetKey: string;
  scope: MessageResponseBoundaryScope;
}

interface MessageResponseMarkdownBoundaryState {
  error: Error | null;
}

function hashMarkdownCacheKey(markdown: string): string {
  let hash = 2166136261;
  for (let index = 0; index < markdown.length; index += 1) {
    hash ^= markdown.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${markdown.length}:${hash >>> 0}`;
}

function normalizeMarkdownRenderError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(typeof error === "string" ? error : "Unknown markdown render error");
}

function getMarkdownFence(line: string): { marker: string; length: number } | null {
  const match = markdownFencePattern.exec(line);

  if (!match) {
    return null;
  }

  const sequence = match[1] ?? "";
  return {
    marker: sequence[0] ?? "",
    length: sequence.length,
  };
}

function isEscapedMarkdownCharacter(text: string, index: number): boolean {
  let slashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashCount++;
  }

  return slashCount % 2 === 1;
}

function isSingleDollarDelimiter(text: string, index: number): boolean {
  return (
    text[index] === "$" &&
    text[index - 1] !== "$" &&
    text[index + 1] !== "$" &&
    !isEscapedMarkdownCharacter(text, index)
  );
}

function findClosingSingleDollarDelimiter(text: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index++) {
    if (isSingleDollarDelimiter(text, index)) {
      return index;
    }
  }

  return -1;
}

function isLikelySingleDollarMath(content: string): boolean {
  if (!content || content !== content.trim() || /[\r\n]/.test(content)) {
    return false;
  }

  if (texCommandPattern.test(content) || likelyMathSyntaxPattern.test(content)) {
    return true;
  }

  if (!/\s/.test(content) && simpleMathIdentifierPattern.test(content)) {
    return true;
  }

  return false;
}

function isLikelyCompactCurrencyRangeText(
  text: string,
  closingIndex: number,
  content: string,
): boolean {
  if (!compactCurrencyRangePrefixPattern.test(content)) {
    return false;
  }

  return compactCurrencyAmountStartPattern.test(text.slice(closingIndex + 1));
}

function normalizeSingleDollarMathInText(text: string): string {
  if (!text.includes("$")) {
    return text;
  }

  let output = "";

  for (let index = 0; index < text.length; index++) {
    if (!isSingleDollarDelimiter(text, index)) {
      output += text[index];
      continue;
    }

    const closingIndex = findClosingSingleDollarDelimiter(text, index + 1);

    if (closingIndex === -1) {
      output += text[index];
      continue;
    }

    const content = text.slice(index + 1, closingIndex);

    if (isLikelyCompactCurrencyRangeText(text, closingIndex, content)) {
      // `$5-$10` 这类紧凑价格区间的第二个 `$` 会被误当成公式闭合符。
      // 只转义当前 `$`，让整段继续按普通文本渲染并保留美元符号。
      output += "\\$";
      continue;
    }

    if (isLikelySingleDollarMath(content)) {
      output += text.slice(index, closingIndex + 1);
      index = closingIndex;
      continue;
    }

    // 开启 singleDollarTextMath 后，`$5 ... $10` / `$HOME ... $PATH`
    // 这类普通文本会被误当成公式。只转义当前 `$`，让后续 `$` 继续按原文本扫描。
    output += "\\$";
  }

  return output;
}

function normalizeSingleDollarMathOutsideInlineCode(line: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < line.length) {
    const codeStart = line.indexOf("`", cursor);

    if (codeStart === -1) {
      output += normalizeSingleDollarMathInText(line.slice(cursor));
      break;
    }

    output += normalizeSingleDollarMathInText(line.slice(cursor, codeStart));

    let codeFenceEnd = codeStart + 1;
    while (line[codeFenceEnd] === "`") {
      codeFenceEnd++;
    }

    const codeMarker = line.slice(codeStart, codeFenceEnd);
    const codeEnd = line.indexOf(codeMarker, codeFenceEnd);

    if (codeEnd === -1) {
      output += normalizeSingleDollarMathInText(line.slice(codeStart));
      break;
    }

    output += line.slice(codeStart, codeEnd + codeMarker.length);
    cursor = codeEnd + codeMarker.length;
  }

  return output;
}

function normalizeMessageSingleDollarMath(markdown: string): string {
  if (!markdown.includes("$")) {
    return markdown;
  }

  let output = "";
  let cursor = 0;
  let activeFence: { marker: string; length: number } | null = null;

  while (cursor < markdown.length) {
    const newlineIndex = markdown.indexOf("\n", cursor);
    const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex;
    const line = markdown.slice(cursor, lineEnd);
    const newline = newlineIndex === -1 ? "" : "\n";
    const fence = getMarkdownFence(line);

    if (activeFence) {
      output += line + newline;

      if (fence && fence.marker === activeFence.marker && fence.length >= activeFence.length) {
        activeFence = null;
      }
    } else {
      output += normalizeSingleDollarMathOutsideInlineCode(line) + newline;

      if (fence) {
        activeFence = fence;
      }
    }

    cursor = lineEnd + newline.length;
  }

  return output;
}

export function resolveMessageStreamdownMode(renderStreaming: boolean): MessageStreamdownMode {
  // 生产包里有用户命中 React #185，堆栈落在 MessageResponse -> Streamdown。
  // 之前完成态长消息也会为了分块缓存走 streaming mode，Streamdown 内部 block state
  // 在某些历史 markdown 上会反复同步状态。现在只有真实流式输出进入 streaming，
  // 历史/完成态内容固定走 static，避免重新挂载时再次参与更新循环。
  return renderStreaming ? "streaming" : "static";
}

class MessageResponseMarkdownBoundary extends Component<
  MessageResponseMarkdownBoundaryProps,
  MessageResponseMarkdownBoundaryState
> {
  state: MessageResponseMarkdownBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): MessageResponseMarkdownBoundaryState {
    return { error: normalizeMarkdownRenderError(error) };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    const normalizedError = normalizeMarkdownRenderError(error);
    logger.warn("[MessageResponse] markdown 渲染失败，已降级为纯文本", {
      errorName: normalizedError.name,
      errorMessage: normalizedError.message,
      componentStack: errorInfo.componentStack,
      markdownLength: this.props.scope.markdownLength,
      mode: this.props.scope.mode,
      renderStreaming: this.props.scope.renderStreaming,
    });
  }

  override componentDidUpdate(previousProps: MessageResponseMarkdownBoundaryProps) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override render() {
    if (this.state.error) {
      return (
        <div className={this.props.className}>
          {/* 单条 markdown 渲染异常时降级为纯文本，避免错误继续冒泡到会话区边界。*/}
          {this.props.fallbackText}
        </div>
      );
    }

    return this.props.children;
  }
}

function formatMarkdownFileLinkTargetHref(href: string): string {
  const parsedTarget = parseMarkdownFileLinkTarget(href);
  // Windows 盘符的 `C:` 会被 rehype-harden 当成未知 URI scheme，
  // 在自定义文件链接 renderer 运行前直接替换成 `[blocked]`。临时补成 `/C:/...`
  // 让安全层按普通 path 放行；resolveMarkdownFileLink 会在 Windows Host 上对称还原。
  const path = windowsDriveAbsolutePathPattern.test(parsedTarget.path)
    ? `/${parsedTarget.path.replaceAll("\\", "/")}`
    : fileUrlProtocolPattern.test(href)
      ? parsedTarget.path
      : parsedTarget.path.startsWith("./") ||
          parsedTarget.path.startsWith("/") ||
          parsedTarget.path.startsWith("#") ||
          parsedTarget.path.startsWith("../") ||
          /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(parsedTarget.path)
        ? parsedTarget.path
        : `./${parsedTarget.path}`;
  if (parsedTarget.lineNumber === null) {
    return path;
  }

  if (parsedTarget.columnNumber === null) {
    return `${path}:${parsedTarget.lineNumber}`;
  }

  return `${path}:${parsedTarget.lineNumber}:${parsedTarget.columnNumber}`;
}

function shouldRewriteMarkdownFileLinkHref(href: string): boolean {
  if (resolveMarkdownFileLink(undefined, href)) {
    return true;
  }

  const parsedTarget = parseMarkdownFileLinkTarget(href);
  return (
    Boolean(parsedTarget.path) &&
    !parsedTarget.path.startsWith("/") &&
    !parsedTarget.path.startsWith("#") &&
    !parsedTarget.path.startsWith("../") &&
    !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(parsedTarget.path) &&
    // 越界路径若先经过 rehype rewrite/harden，`..` 可能被 URL 归一后丢失，
    // 点击层就无法还原原始逃逸意图；必须在改写前复用相对路径词法边界校验。
    normalizeWorkspaceRelativeFilePath(parsedTarget.path) !== null &&
    // `[README.md](README.md)` 这类裸文件名链接以前不会在 harden 前改写，
    // Streamdown 会把它当成不安全链接渲染成 `[blocked]`。有扩展名的裸路径按工作区文件处理，
    // 先规整成 `./README.md`，再交给统一的文件链接打开逻辑解析。
    (parsedTarget.path.includes("/") ||
      parsedTarget.path.includes("\\") ||
      hasFileExtension(getPathLeaf(parsedTarget.path)))
  );
}

function rewriteLocalFileMarkdownTargetsRehypePlugin() {
  return (tree: HastElementNode) => {
    const visitNode = (node: HastElementNode) => {
      const targetProperty = node.tagName === "a" ? "href" : node.tagName === "img" ? "src" : null;
      if (
        node.type === "element" &&
        targetProperty &&
        typeof node.properties?.[targetProperty] === "string" &&
        shouldRewriteMarkdownFileLinkHref(node.properties[targetProperty])
      ) {
        // markdown 图片和链接一样会先经过 rehype-harden。`file://` 会被安全层硬拦，
        // 裸文件名又会被当成未知 URL；这里在 harden 前统一规整成本地路径/相对路径。
        node.properties[targetProperty] = formatMarkdownFileLinkTargetHref(
          node.properties[targetProperty],
        );
      }

      node.children?.forEach(visitNode);
    };

    visitNode(tree);
  };
}

const messageRehypePlugins: PluggableList = [
  rewriteLocalFileMarkdownTargetsRehypePlugin,
  ...Object.values(defaultRehypePlugins),
];

const messageDefaultRemarkPlugins: PluggableList = Object.entries(defaultRemarkPlugins).map(
  ([name, plugin]) => {
    if (name !== "gfm") {
      return plugin;
    }

    // remark-gfm 与 Streamdown CJK 删除线扩展都默认开启 singleTilde，
    // 后者还会覆盖前者的解析结果；两处必须同时关闭，才能让 `~text~` 按 GFM 规范保留原文。
    return disableSingleTilde(plugin);
  },
);

function resolveMessageCodeTheme(
  theme: Theme,
  codePreviewSettings: { lightTheme: BundledTheme; darkTheme: BundledTheme },
): BundledTheme {
  if (theme === "system" && typeof window !== "undefined") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? codePreviewSettings.darkTheme
      : codePreviewSettings.lightTheme;
  }

  return theme === "dark" || theme === "zai-dark"
    ? codePreviewSettings.darkTheme
    : codePreviewSettings.lightTheme;
}

export function buildMessageStreamdownRenderKey(params: {
  attachmentReaderEpoch?: number;
  codeBlockTheme: BundledTheme;
  fontSizePx: number;
  renderZCodeFileCitations?: boolean;
  sessionId?: string;
  workspacePath?: string;
  workspaceHomePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  wrapLongLines: boolean;
}): string {
  // streaming/static 只是解析模式，不应参与 React key；否则流式状态抖动会卸载
  // 整棵 markdown 子树，让已显示的正文重新触发淡入动画。
  return [
    params.sessionId ?? "",
    params.attachmentReaderEpoch ?? 0,
    params.codeBlockTheme,
    params.fontSizePx,
    params.wrapLongLines ? "wrap" : "scroll",
    params.renderZCodeFileCitations ? "citations" : "plain",
    params.workspacePath ?? "",
    params.workspaceHomePath ?? "",
    params.workspaceIdentity ?? "",
    params.workspaceRemoteSessionId ?? "",
  ].join(":");
}

const attachmentReaderEpochs = new WeakMap<
  NonNullable<MessageResponseProps["readAttachment"]>,
  number
>();
let nextAttachmentReaderEpoch = 1;

function getAttachmentReaderEpoch(readAttachment: MessageResponseProps["readAttachment"]): number {
  if (!readAttachment) return 0;
  const existing = attachmentReaderEpochs.get(readAttachment);
  if (existing !== undefined) return existing;
  const epoch = nextAttachmentReaderEpoch++;
  attachmentReaderEpochs.set(readAttachment, epoch);
  return epoch;
}

function getCodeLanguage(className?: string): string {
  return className?.match(languageClassNamePattern)?.[1] ?? "text";
}

function extractCodeText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }

  if (Array.isArray(children)) {
    return children.map(extractCodeText).join("");
  }

  if (isValidElement<{ children?: ReactNode }>(children)) {
    return extractCodeText(children.props.children);
  }

  return "";
}

function extractLinkLabelText(children: ReactNode): string {
  return extractCodeText(children).trim();
}

function hasFileExtension(pathLeaf: string): boolean {
  return /\.[^./\\]+$/.test(pathLeaf);
}

function isExplicitDirectoryMarkdownLink(path: string, href: string): boolean {
  const trimmedHref = href.trim();
  return /[\\/]$/.test(trimmedHref) || /[\\/]$/.test(path);
}

export function buildMessageFileLinkTarget(input: {
  href: string;
  label: string;
  path: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}): MessageFileLinkTarget {
  // 文件名是否带扩展名不能代表文件系统类型；env、hosts、config 等无扩展名文件
  // 过去会被误判为目录。这里只保留显式尾随斜杠作为图标提示，打开方式必须再 stat。
  const pathKind = isExplicitDirectoryMarkdownLink(input.path, input.href)
    ? ("directory" as const)
    : undefined;
  return {
    path: input.path,
    label: input.label,
    pathKind,
    relativePath: input.workspacePath
      ? getWorkspaceFileRelativePath(input.workspacePath, input.path)
      : input.label,
    workspacePath: input.workspacePath,
    workspaceIdentity: input.workspaceIdentity,
    workspaceRemoteSessionId: input.workspaceRemoteSessionId,
  };
}

export async function openMessageFileLinkInEditor({
  editorId,
  fileLink,
  openInEditor,
  remoteTarget,
  statFile,
}: {
  editorId: string;
  fileLink: MessageFileLinkTarget;
  openInEditor: (
    editorId: string,
    path: string,
    options: OpenInEditorOptions,
  ) => Promise<{ success: boolean; error?: string }>;
  remoteTarget?: OpenInEditorOptions["remoteTarget"];
  statFile: (params: { path: string }) => Promise<Pick<FileStat, "type">>;
}) {
  // Markdown 渲染层无法从名称可靠判断文件/目录。这里在动作发生时通过
  // 当前 workspace scope 的 file service 取真实类型，stat 失败时不会调用本机应用。
  const fileStat = await statFile({ path: fileLink.path });
  return openInEditor(editorId, fileLink.path, {
    pathKind: fileStat.type,
    remoteTarget,
    workspaceIdentity: fileLink.workspaceIdentity,
  });
}

function trimCodeFenceTrailingNewlines(codeText: string): string {
  return codeText.replace(/\n+$/, "");
}

function isExternalWebHref(href: string): boolean {
  try {
    const protocol = new URL(href).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

interface MessageExternalLinkProps extends ComponentProps<"button"> {
  href: string;
  onOpenExternalUrl: (url: string) => void;
}

function MessageExternalLink({
  children,
  className,
  href,
  onClick,
  onOpenExternalUrl,
  ...props
}: MessageExternalLinkProps) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const handleOpen = useCallback(
    (options: { forceExternal?: boolean; forceInApp?: boolean } = {}) => {
      // 交互语义：本机/私网白名单只决定左键单击的默认目标；右键的两个打开动作各自强制一个目标。
      // 菜单「打开」过去复用左键默认行为，公网链接（如飞书文档）两项都会跳系统浏览器。
      const target = resolveMessageLinkOpenTarget({ href, ...options });
      logger.debug("[MessageExternalLink] 打开 Markdown 外链", {
        forceExternal: Boolean(options.forceExternal),
        forceInApp: Boolean(options.forceInApp),
        href,
        target,
      });

      if (target === "app-browser" || !platform) {
        // Share/普通 Web 没有 Desktop PlatformProvider；仍交给调用方的安全 URL handler，
        // 避免 MessageResponse 因缺少宿主上下文整棵 Markdown 降级为纯文本。
        onOpenExternalUrl(href);
        return;
      }

      platform.openExternal(href);
    },
    [href, onOpenExternalUrl, platform],
  );
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) {
        return;
      }

      handleOpen({ forceExternal: event.metaKey || event.ctrlKey });
    },
    [handleOpen, onClick],
  );
  const handleCopyLink = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard-unavailable");
      }
      await navigator.clipboard.writeText(href);
    } catch (error) {
      logger.warn("[MessageExternalLink] 复制链接失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            messageLinkClassName,
            "cursor-pointer bg-transparent p-0 text-left",
            className,
          )}
          title={href}
          {...props}
          // markdown 外链之前被统一降级成 span，用户看得到链接却点不开。
          // 这里仍阻断原生 a 标签跳转，但不再把所有 http/https 都默认送进内置浏览器。
          onClick={handleClick}
        >
          {children}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {/* 通用“打开”无法说明目标；两个打开动作同组，用文案和图标区分内置与外部浏览器。 */}
        <ContextMenuItem onSelect={() => handleOpen({ forceInApp: true })}>
          <PanelRightIcon className="size-4" />
          <span>{intl.formatMessage({ id: "chat.message.link.openInZCode" })}</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleOpen({ forceExternal: true })}>
          <ExternalLinkIcon className="size-4" />
          <span>{intl.formatMessage({ id: "chat.previewCards.openExternal" })}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void handleCopyLink()}>
          <CopyIcon className="size-4" />
          <span>{intl.formatMessage({ id: "chat.previewCards.copyLink" })}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface MessageFileLinkButtonProps extends ComponentProps<"button"> {
  fileIconSrc: string;
  fileLink: MessageFileLinkTarget;
  onOpen: () => void;
}

const MessageFileLinkButton = forwardRef<HTMLButtonElement, MessageFileLinkButtonProps>(
  function MessageFileLinkButton(
    { children, className, fileIconSrc, fileLink, onOpen, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(messageFileLinkClassName, "cursor-pointer", className)}
        title={fileLink.path}
        onClick={onOpen}
        {...props}
      >
        <FileDisplayIcon src={fileIconSrc} size={16} className="ml-0.5 shrink-0 self-center" />
        <span className="min-w-0 self-baseline truncate">{children}</span>
      </button>
    );
  },
);

interface MessageFileLinkProps {
  className?: string;
  fileIconSrc: string;
  fileLink: MessageFileLinkTarget;
  onOpen: () => void;
}

function MessageFileLink(props: MessageFileLinkProps) {
  const services = useOptionalServices();
  if (!services)
    return <MessageFileLinkButton {...props}>{props.fileLink.label}</MessageFileLinkButton>;
  return <ScopedMessageFileLink {...props} />;
}

function ScopedMessageFileLink({ className, fileIconSrc, fileLink, onOpen }: MessageFileLinkProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const services = useWorkspaceServices(
    fileLink.workspacePath,
    fileLink.workspaceRemoteSessionId,
    fileLink.workspaceIdentity,
  );
  const [pathKind, setPathKind] = useState<"file" | "directory" | null>(null);
  const openInEditorContext = useWorkspaceOpenInEditorTarget({
    workspacePath: fileLink.workspacePath,
    workspaceIdentity: fileLink.workspaceIdentity,
    workspaceRemoteSessionId: fileLink.workspaceRemoteSessionId,
  });
  const isRemote = Boolean(
    fileLink.workspaceIdentity ||
    fileLink.workspaceRemoteSessionId ||
    openInEditorContext.isRemoteWorkspace,
  );
  // 与 OpenSplitButton 的「在 Finder / 资源管理器中打开」同源：本机或 WSL 才能定位，SSH 等远程不显示。
  const fileActions = useFileContextActions({
    canOpenLocalFileManager: Boolean(platform.canOpenLocalFiles),
    isRemoteWorkspace: isRemote,
    remoteTarget: openInEditorContext.remoteTarget,
    workspaceIdentity: fileLink.workspaceIdentity,
  });
  const canReveal = fileActions.canRevealInFileManager({ path: fileLink.path });
  const fileApplications = useFileApplications(
    { path: fileLink.path, pathKind: "file", workspaceIdentity: fileLink.workspaceIdentity },
    isRemote,
  );
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [loadingEditors, setLoadingEditors] = useState(false);
  const sortedEditors: Array<EditorInfo & { isDefault?: boolean }> = useMemo(
    () =>
      pathKind === "file" && !isRemote
        ? fileApplications.apps.map((app) => ({ ...app, iconDataUrl: app.iconDataUrl ?? "" }))
        : isRemote && !openInEditorContext.remoteTarget
          ? []
          : resolveWorkspaceEditorSelection({
              installedEditors: editors,
              selectedEditorId: null,
              remoteTarget: openInEditorContext.remoteTarget,
            }).availableEditors,
    [editors, openInEditorContext, pathKind, isRemote, fileApplications.apps],
  );
  const query = useRef(0);
  const queryKey = `${fileLink.path}\u0000${fileLink.workspaceIdentity ?? ""}\u0000${fileLink.workspaceRemoteSessionId ?? ""}`;
  const currentQueryKey = useRef(queryKey);
  currentQueryKey.current = queryKey;
  useEffect(() => {
    setPathKind(null);
    setEditors([]);
    setLoadingEditors(false);
    query.current += 1;
    return () => {
      query.current += 1;
    };
  }, [queryKey]);

  const loadEditors = useCallback(async () => {
    if (loadingEditors) return;
    const request = ++query.current;
    setLoadingEditors(true);
    try {
      const stat = await services.fileService.stat({ path: fileLink.path });
      if (request !== query.current || currentQueryKey.current !== queryKey) return;
      setPathKind(stat.type);
      if (stat.type === "file" && !isRemote) {
        await fileApplications.load();
        return;
      }
      const installedEditors = await platform.getInstalledEditors();
      if (request === query.current && currentQueryKey.current === queryKey)
        setEditors(installedEditors);
    } catch (error) {
      logger.warn("[MessageResponse] 获取 markdown 链接打开方式失败", {
        path: fileLink.path,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (request === query.current) setLoadingEditors(false);
    }
  }, [
    fileLink.path,
    loadingEditors,
    platform,
    services,
    isRemote,
    fileApplications.load,
    queryKey,
  ]);

  const hasDefaultShortcut =
    pathKind === "file" &&
    !isRemote &&
    Boolean(platform.canOpenLocalFiles && platform.openExternalFile);

  const handleOpenInEditor = (editor: EditorInfo) => {
    if (pathKind === "file" && !isRemote) {
      void fileApplications.open({ ...editor, isDefault: false });
      return;
    }
    if (!services) {
      logger.warn("[MessageResponse] 无法确认 markdown 链接文件类型", {
        editorId: editor.id,
        path: fileLink.path,
        error: "workspace-file-service-unavailable",
      });
      return;
    }

    persistLastSelectedEditorId(editor.id);
    void openMessageFileLinkInEditor({
      editorId: editor.id,
      fileLink,
      openInEditor: (editorId, path, options) => platform.openInEditor(editorId, path, options),
      remoteTarget: openInEditorContext.remoteTarget,
      statFile: (params) => services.fileService.stat(params),
    })
      .then((result) => {
        if (result.success) {
          return;
        }

        logger.warn("[MessageResponse] 第三方 App 打开 markdown 文件链接失败", {
          editorId: editor.id,
          path: fileLink.path,
          error: result.error ?? "unknown-error",
        });
      })
      .catch((error) => {
        logger.warn("[MessageResponse] 无法确认 markdown 链接文件类型", {
          editorId: editor.id,
          path: fileLink.path,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  return (
    <ContextMenu onOpenChange={(open) => open && void loadEditors()}>
      <ContextMenuTrigger asChild>
        <MessageFileLinkButton
          className={className}
          fileIconSrc={fileIconSrc}
          fileLink={fileLink}
          onOpen={onOpen}
        >
          {fileLink.label}
        </MessageFileLinkButton>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64 max-w-[calc(100vw-1rem)]">
        <ContextMenuItem onSelect={onOpen}>
          <PanelRightIcon aria-hidden="true" className="size-4" />
          {intl.formatMessage({ id: "common.open" })}
        </ContextMenuItem>
        {platform.canOpenLocalFiles && (!isRemote || openInEditorContext.remoteTarget) && (
          <FileApplicationChoices
            variant="context"
            applications={sortedEditors}
            loading={loadingEditors}
            onOpenDefault={
              hasDefaultShortcut ? () => void fileApplications.openDefault() : undefined
            }
            onSelect={handleOpenInEditor}
          />
        )}
        <ContextMenuSeparator />
        {canReveal && (
          <ContextMenuItem
            onSelect={() =>
              // 文件：打开所在目录并选中；目录：直接打开该目录。stat 未返回前按链接提示判断。
              void fileActions.revealFileInFileManager({
                path: fileLink.path,
                kind: (pathKind ?? fileLink.pathKind) === "directory" ? "directory" : "file",
              })
            }
          >
            <FolderOpenIcon className="size-4" />
            {getFileManagerLabel(intl)}
          </ContextMenuItem>
        )}
        {pathKind === "file" && (
          <FileSaveAsMenuItem
            variant="context"
            path={fileLink.path}
            workspacePath={fileLink.workspacePath}
            workspaceIdentity={fileLink.workspaceIdentity}
            workspaceRemoteSessionId={fileLink.workspaceRemoteSessionId}
          />
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => void fileActions.copyAbsolutePath({ path: fileLink.path })}
        >
          <CopyIcon className="size-4" />
          {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void fileActions.copyRelativePath({
              path: fileLink.path,
              relativePath: fileLink.relativePath ?? fileLink.label,
            })
          }
        >
          <CopyIcon className="size-4" />
          {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MessageMarkdownHeading({
  className,
  headingLevel,
  node: _node,
  ...props
}: MarkdownHeadingProps & {
  headingLevel: keyof typeof messageMarkdownHeadingClassNames;
}) {
  const headingClassName = cn(messageMarkdownHeadingClassNames[headingLevel], className);
  const dataStreamdown = `heading-${headingLevel.slice(1)}`;

  if (headingLevel === "h1") {
    return <h1 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
  }

  if (headingLevel === "h2") {
    return <h2 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
  }

  if (headingLevel === "h3") {
    return <h3 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
  }

  if (headingLevel === "h4") {
    return <h4 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
  }

  if (headingLevel === "h5") {
    return <h5 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
  }

  return <h6 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
}

export const messageResponsePropsAreEqual = (
  prevProps: Readonly<MessageResponseProps>,
  nextProps: Readonly<MessageResponseProps>,
): boolean =>
  prevProps.children === nextProps.children &&
  prevProps.forceCodeWrap === nextProps.forceCodeWrap &&
  nextProps.streaming === prevProps.streaming &&
  nextProps.streamingAnimationKey === prevProps.streamingAnimationKey &&
  nextProps.workspacePath === prevProps.workspacePath &&
  nextProps.workspaceHomePath === prevProps.workspaceHomePath &&
  nextProps.workspaceIdentity === prevProps.workspaceIdentity &&
  nextProps.workspaceRemoteSessionId === prevProps.workspaceRemoteSessionId &&
  nextProps.sessionId === prevProps.sessionId &&
  nextProps.readAttachment === prevProps.readAttachment &&
  nextProps.renderZCodeFileCitations === prevProps.renderZCodeFileCitations &&
  nextProps.theme === prevProps.theme &&
  nextProps.codePreviewSettings === prevProps.codePreviewSettings &&
  nextProps.onOpenCodeViewer === prevProps.onOpenCodeViewer &&
  nextProps.onOpenFileLink === prevProps.onOpenFileLink &&
  nextProps.onOpenExternalUrl === prevProps.onOpenExternalUrl;

export const MessageResponse = memo(
  ({
    className,
    streaming = false,
    forceCodeWrap = false,
    onOpenCodeViewer,
    onOpenFileLink,
    onOpenExternalUrl,
    renderZCodeFileCitations = false,
    workspacePath,
    workspaceHomePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    sessionId,
    readAttachment,
    theme = "system",
    codePreviewSettings = DEFAULT_CODE_PREVIEW_SETTINGS,
    children,
  }: MessageResponseProps) => {
    const wrapLongLines = forceCodeWrap || codePreviewSettings.wrapLongLines;
    const rawMarkdown = useMemo(() => extractCodeText(children), [children]);
    const renderStreaming = streaming;
    const projectedCitationMarkdown = useMemo(
      () =>
        renderZCodeFileCitations
          ? projectZCodeFileCitations(rawMarkdown, { streaming: renderStreaming }).visibleText
          : rawMarkdown,
      [rawMarkdown, renderStreaming, renderZCodeFileCitations],
    );
    const targetMarkdown = useMemo(
      () =>
        rewriteMarkdownArtifactImageSources(
          normalizeMessageSingleDollarMath(
            normalizeConsecutiveMarkdownImageBlocks(projectedCitationMarkdown),
          ),
        ),
      [projectedCitationMarkdown],
    );
    const streamdownMode = resolveMessageStreamdownMode(renderStreaming);
    const messageRemarkPlugins = useMemo<PluggableList>(
      () => [
        // 显式传 remarkPlugins 会覆盖 Streamdown 默认插件；
        // citation 必须和默认 GFM 插件一起传入，否则表格会退化成普通段落。
        ...messageDefaultRemarkPlugins,
        // Windows 绝对路径链接里的 `\.` 会在 remark 解析期被当成标点转义吃掉
        // rehype 阶段已经看不到原文。这条还原必须无条件生效，不能挂在 citation 开关下。
        windowsFileLinkEscapeRemarkPlugin,
        ...(renderZCodeFileCitations && workspacePath
          ? [createZCodeFileCitationRemarkPlugin(workspacePath, workspaceHomePath)]
          : []),
      ],
      [renderZCodeFileCitations, workspaceHomePath, workspacePath],
    );
    const responseClassName = cn(
      "size-full text-ui-base leading-[1.75] tracking-wide [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
      className,
    );
    const fallbackClassName = cn(responseClassName, "whitespace-pre-wrap break-words");
    const boundaryResetKey = useMemo(
      () =>
        renderStreaming
          ? `streaming:${streamdownMode}`
          : `${streamdownMode}:${renderZCodeFileCitations ? "citations" : "plain"}:${hashMarkdownCacheKey(targetMarkdown)}`,
      [renderStreaming, renderZCodeFileCitations, streamdownMode, targetMarkdown],
    );
    const boundaryScope = useMemo<MessageResponseBoundaryScope>(
      () => ({
        markdownLength: targetMarkdown.length,
        mode: streamdownMode,
        renderStreaming,
      }),
      [renderStreaming, streamdownMode, targetMarkdown.length],
    );
    const codeBlockTheme = useMemo(
      () => resolveMessageCodeTheme(theme, codePreviewSettings),
      [codePreviewSettings, theme],
    );
    const shikiTheme = useMemo(
      () =>
        [codePreviewSettings.lightTheme, codePreviewSettings.darkTheme] as [
          BundledTheme,
          BundledTheme,
        ],
      [codePreviewSettings.lightTheme, codePreviewSettings.darkTheme],
    );
    const streamdownRenderKey = useMemo(() => {
      return (
        buildMessageStreamdownRenderKey({
          attachmentReaderEpoch: getAttachmentReaderEpoch(readAttachment),
          codeBlockTheme,
          fontSizePx: codePreviewSettings.fontSizePx,
          renderZCodeFileCitations,
          sessionId,
          workspacePath,
          workspaceHomePath,
          workspaceIdentity,
          workspaceRemoteSessionId,
          wrapLongLines,
        }) + (forceCodeWrap ? ":wrap-locked" : "")
      );
    }, [
      codeBlockTheme,
      codePreviewSettings.fontSizePx,
      wrapLongLines,
      forceCodeWrap,
      renderZCodeFileCitations,
      readAttachment,
      sessionId,
      workspaceHomePath,
      workspacePath,
      workspaceIdentity,
      workspaceRemoteSessionId,
    ]);
    const messageComponents = useMemo(
      () => ({
        a: ({
          children,
          className: linkClassName,
          href,
          node: _node,
        }: ComponentProps<"a"> & { node?: unknown }) => {
          const resolvedHref =
            typeof href === "string" ? stripBalancedAssistantPathQuotes(href) : "";
          const fileLink = resolveMarkdownFileLink(workspacePath, resolvedHref, {
            homePath: workspaceHomePath,
          });

          if (fileLink && (onOpenFileLink || onOpenCodeViewer)) {
            const descriptor = resolveFileDisplayDescriptor(fileLink.path);
            const fileName = descriptor.fileName || getPathLeaf(fileLink.path);
            const labelText = extractLinkLabelText(children) || fileName;
            const fileLinkTarget = buildMessageFileLinkTarget({
              href: resolvedHref,
              path: fileLink.path,
              label: labelText,
              workspacePath,
              workspaceIdentity,
              workspaceRemoteSessionId,
            });
            const fileIconSrc =
              fileLinkTarget.pathKind === "directory"
                ? FOLDER_FILE_ICON_SRC
                : descriptor.fileIconSrc;
            return (
              <MessageFileLink
                className={linkClassName}
                fileIconSrc={fileIconSrc}
                fileLink={fileLinkTarget}
                onOpen={() => {
                  if (onOpenFileLink) {
                    onOpenFileLink(fileLinkTarget);
                    return;
                  }
                  onOpenCodeViewer?.({
                    type: "file",
                    title: getPathLeaf(fileLink.path),
                    path: fileLink.path,
                    workspacePath,
                    workspaceIdentity,
                    workspaceRemoteSessionId,
                  });
                }}
              />
            );
          }

          if (isExternalWebHref(resolvedHref) && onOpenExternalUrl) {
            return (
              <MessageExternalLink
                className={linkClassName}
                href={resolvedHref}
                onOpenExternalUrl={onOpenExternalUrl}
              >
                {children}
              </MessageExternalLink>
            );
          }

          return (
            <span
              className={cn(messageLinkClassName, linkClassName)}
              title={resolvedHref || undefined}
            >
              {children}
            </span>
          );
        },
        img: (imageProps: MarkdownImageProps) => (
          <MarkdownImage
            {...imageProps}
            workspacePath={workspacePath}
            workspaceHomePath={workspaceHomePath}
            sessionId={sessionId}
            readAttachment={readAttachment}
          />
        ),
        p: MarkdownImageParagraph,
        h1: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h1" />
        ),
        h2: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h2" />
        ),
        h3: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h3" />
        ),
        h4: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h4" />
        ),
        h5: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h5" />
        ),
        h6: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h6" />
        ),
        strong: ({
          className: strongClassName,
          node: _node,
          ...strongProps
        }: MarkdownStrongProps) => (
          <strong className={cn("font-medium", strongClassName)} {...strongProps} />
        ),
        code: ({
          children,
          className: codeClassName,
          node: _node,
          ...codeProps
        }: MarkdownCodeProps) => {
          const isBlockCode = "data-block" in codeProps;

          if (!isBlockCode) {
            return (
              <code
                className={cn(
                  "rounded-md bg-markdown-inline-code/50 mx-0.5 px-1.5 py-0.5 font-mono text-ui-sm",
                  codeClassName,
                )}
                {...codeProps}
              >
                {children}
              </code>
            );
          }

          const codeText = trimCodeFenceTrailingNewlines(extractCodeText(children));
          const language = getCodeLanguage(codeClassName);

          return (
            <CodeBlock
              className="my-4 border border-border bg-card"
              code={codeText}
              // 流式消息里的代码围栏会被 Streamdown 反复拆分/重挂载。
              // 高亮等消息完成后再启动，避免 async highlighter 和消息流更新叠加触发 React #185。
              enableSyntaxHighlighting={!renderStreaming}
              fontSizePx={codePreviewSettings.fontSizePx}
              language={language}
              renderMermaid={!renderStreaming}
              theme={codeBlockTheme}
              appTheme={theme}
              wrapLongLines={wrapLongLines}
            >
              <CodeBlockHeader
                className="pl-3 pr-2 pt-2"
                language={language}
                showWrapButton={!forceCodeWrap}
              />
            </CodeBlock>
          );
        },
        blockquote: MarkdownBlockquote,
        li: MarkdownListItem,
        ol: MarkdownOrderedList,
        table: MarkdownTable,
        tbody: MarkdownTableBody,
        td: MarkdownTableCell,
        th: MarkdownTableHead,
        thead: MarkdownTableHeader,
        tr: MarkdownTableRow,
        ul: MarkdownUnorderedList,
      }),
      [
        codeBlockTheme,
        codePreviewSettings.fontSizePx,
        wrapLongLines,
        forceCodeWrap,
        onOpenFileLink,
        onOpenCodeViewer,
        onOpenExternalUrl,
        readAttachment,
        renderStreaming,
        sessionId,
        theme,
        workspaceHomePath,
        workspacePath,
        workspaceIdentity,
        workspaceRemoteSessionId,
      ],
    );

    return (
      <MessageResponseMarkdownBoundary
        className={fallbackClassName}
        fallbackText={targetMarkdown}
        resetKey={boundaryResetKey}
        scope={boundaryScope}
      >
        <Streamdown
          key={streamdownRenderKey}
          className={responseClassName}
          // Streamdown 自身是 memo，比较函数不看 components。app light/dark 切换时
          // codeBlockTheme 只存在于自定义 code renderer 闭包里，若不改 key，当前 task 已挂载的
          // markdown 代码块不会重新执行 renderer；切换 task 触发重建后才会恢复正确主题。
          // Artifact reader/session 同样只存在于 img renderer 闭包里。权限上下文变化时必须重挂载
          // markdown 子树，释放旧 blob URL，并确保后续读取只使用当前会话的 reader。
          // 已结束消息之前也一直走 streaming mode，会触发 remend 对正文做“未闭合 markdown 补全”。
          // 遇到 `./src/**/*` 这类代码片段时，remend 会误判成未闭合粗体并在末尾补出 `**`。
          // 性能优化曾让长历史消息也启用 block streaming 模式复用分块缓存；虚拟滚动/懒渲染会
          // 频繁重挂载历史消息，生产上遇到部分 markdown 会在 Streamdown 内部触发 React #185。
          // 这里重新收敛为：只有真实流式输出走 streaming 解析，完成态一律 static。
          mode={streamdownMode}
          components={messageComponents}
          parseIncompleteMarkdown={streaming}
          // Streamdown 内置 code renderer 的 highlighted-body 会在代码高亮结果和 raw fallback
          // 之间反复 setState，部分历史消息恢复时会触发 React #185。这里保留 markdown 解析能力，
          // 但代码块改走本项目自己的稳定 CodeBlock 渲染器。
          // 说明：这里继续关掉 Streamdown 默认链接行为，统一改由上面的自定义 a 渲染器接管。
          // 这样工作区文件链接和 http/https 外链都能走我们自己的安全分流，其它协议仍保持不可点击。
          linkSafety={messageLinkSafety}
          plugins={streamdownPlugins}
          controls={STREAMDOWN_CONTROLS}
          // Streamdown 的 harden 插件会在自定义 a renderer 之前把 file:// 标成 [blocked]。
          // 这里先把 file URI 规整成本地路径 href，让后续 resolveMarkdownFileLink 统一走预览/文件树打开逻辑。
          rehypePlugins={messageRehypePlugins}
          remarkPlugins={messageRemarkPlugins}
          shikiTheme={shikiTheme}
          // markdown 正文流式淡入会在重渲染时让历史文本整段重新闪烁。
          // 这里保留 streaming 解析模式，但彻底关闭 Streamdown/正文 rehype 动画。
          animated={false}
          isAnimating={false}
        >
          {targetMarkdown}
        </Streamdown>
      </MessageResponseMarkdownBoundary>
    );
  },
  messageResponsePropsAreEqual,
);

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({ className, children, ...props }: MessageToolbarProps) => (
  <div className={cn("mt-4 flex w-full items-center justify-between gap-4", className)} {...props}>
    {children}
  </div>
);
