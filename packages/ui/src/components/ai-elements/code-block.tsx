/*
 * Derived from vercel/ai-elements (packages/elements/src/code-block.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { Button } from "../ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.js";
import { cn } from "../lib/utils.js";
import { CheckIcon, CopyIcon, Maximize2Icon, WrapTextIcon } from "lucide-react";
import type { ComponentProps, CSSProperties, HTMLAttributes } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BundledTheme } from "shiki";
import { CodeViewer } from "@/components/ui/code-viewer.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { isMermaidLanguage, shouldRenderMermaidCodeBlock } from "@/lib/mermaidLanguage.js";
import {
  getCurrentMermaidDocumentVisibility,
  resolveMermaidAutoRenderDecision,
} from "@/lib/mermaidRenderBudget.js";
import { MermaidBlock } from "@/components/ai-elements/mermaid-block.js";
import { DiagramPreviewDialog } from "@/components/ai-elements/diagram-preview-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { Theme } from "@/useTheme.js";

// Types
type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: string;
  enableSyntaxHighlighting?: boolean;
  showLineNumbers?: boolean;
  theme?: BundledTheme;
  /**
   * 应用主题（store 耦合剥离）：仅透传给 Mermaid 渲染分支；
   * `theme` 已被 shiki 高亮主题占用，故另起名 appTheme。缺省时 Mermaid 按 "system" 兜底。
   */
  appTheme?: Theme;
  wrapLongLines?: boolean;
  fontSizePx?: number;
  renderMermaid?: boolean;
  /** 正文独立限高，避免滚动时把 Header 的复制/换行按钮一起卷走。 */
  contentClassName?: string;
  /**
   * 行定位透传（CodeViewer 已实现滚动+高亮，CodeBlock 也一并暴露）：
   * focusedRange 高亮行区间，focusRequestId 变化时触发滚动到该区间。
   */
  focusedRange?: { startLine: number; endLine: number } | null;
  focusRequestId?: string;
  /** 行号着警示色的行（透传 CodeViewer `markedLines`），编译反馈卡标出被诊断指到的行。 */
  markedLines?: readonly number[];
};

interface CodeBlockContextType {
  code: string;
  renderingMermaid: boolean;
  mermaidPreviewAvailable: boolean;
  openMermaidPreview: () => void;
  toggleWrapLongLines: () => void;
  wrapLongLines: boolean;
}

const LANGUAGE_DISPLAY_FILE_BY_LANGUAGE: Record<string, string> = {
  bash: "script.sh",
  cjs: "index.cjs",
  css: "style.css",
  go: "main.go",
  html: "index.html",
  javascript: "index.js",
  js: "index.js",
  jsx: "component.jsx",
  json: "data.json",
  markdown: "README.md",
  md: "README.md",
  mermaid: "diagram.mmd",
  mmd: "diagram.mmd",
  mjs: "index.mjs",
  python: "main.py",
  py: "main.py",
  rs: "main.rs",
  rust: "main.rs",
  sh: "script.sh",
  shell: "script.sh",
  toml: "config.toml",
  ts: "index.ts",
  tsx: "component.tsx",
  typescript: "index.ts",
  yaml: "config.yaml",
  yml: "config.yml",
  zsh: "script.zsh",
};

function resolveCodeBlockDisplayFile(language: string, displayFile?: string) {
  const normalizedLanguage = language.trim().toLowerCase();
  return (
    displayFile ??
    LANGUAGE_DISPLAY_FILE_BY_LANGUAGE[normalizedLanguage] ??
    `code.${normalizedLanguage || "txt"}`
  );
}

function useDocumentVisibilityRevision(enabled: boolean): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    // 普通代码块数量和消息流同量级，不能为非 Mermaid 块批量注册页面可见性监听。
    if (!enabled) {
      return;
    }

    if (typeof document === "undefined" || typeof document.addEventListener !== "function") {
      return;
    }

    const handleVisibilityChange = () => {
      setRevision((current) => current + 1);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled]);

  return revision;
}

// Context
const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
  renderingMermaid: false,
  mermaidPreviewAvailable: false,
  openMermaidPreview: () => {},
  toggleWrapLongLines: () => {},
  wrapLongLines: false,
});

export const CodeBlockContainer = ({
  className,
  language,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { language: string }) => (
  <div
    className={cn(
      "group relative w-full overflow-hidden rounded-xl bg-background text-foreground",
      className,
    )}
    data-language={language}
    style={{
      containIntrinsicSize: "auto 200px",
      contentVisibility: "auto",
      ...style,
    }}
    {...props}
  />
);

export type CodeBlockHeaderProps = HTMLAttributes<HTMLDivElement> & {
  showWrapButton?: boolean;
  displayFile?: string;
  language?: string;
};

export const CodeBlockHeader = ({
  children,
  className,
  displayFile,
  language,
  showWrapButton = true,
  ...props
}: CodeBlockHeaderProps) => {
  const { renderingMermaid } = useContext(CodeBlockContext);
  const languageLabel = language?.trim() || "text";
  const descriptor = resolveFileDisplayDescriptor(
    resolveCodeBlockDisplayFile(languageLabel, displayFile),
  );

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-3 py-2 text-ui-base text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          {renderingMermaid ? null : (
            <CodeBlockTitle className="min-w-0">
              <FileDisplayIcon src={descriptor.fileIconSrc} size={16} className="shrink-0" />
              <CodeBlockFilename className="truncate lowercase">{languageLabel}</CodeBlockFilename>
            </CodeBlockTitle>
          )}
          <CodeBlockActions className="ml-auto">
            {isMermaidLanguage(languageLabel) ? (
              <CodeBlockMermaidPreviewButton />
            ) : showWrapButton ? (
              <CodeBlockWrapButton />
            ) : null}
            <CodeBlockCopyButton />
          </CodeBlockActions>
        </>
      )}
    </div>
  );
};

export const CodeBlockTitle = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex items-center gap-2", className)} {...props}>
    {children}
  </div>
);

export const CodeBlockFilename = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn("font-mono", className)} {...props}>
    {children}
  </span>
);

export const CodeBlockActions = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("-my-1 -mr-1 flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export const CodeBlock = ({
  code,
  enableSyntaxHighlighting = true,
  language,
  showLineNumbers = false,
  theme,
  appTheme,
  wrapLongLines = false,
  fontSizePx = 14,
  renderMermaid = true,
  focusedRange = null,
  focusRequestId,
  markedLines,
  className,
  children,
  contentClassName,
  ...props
}: CodeBlockProps) => {
  const { intl } = useZCodeIntl();
  const [isWrapped, setIsWrapped] = useState(wrapLongLines);
  const [mermaidPreviewSvg, setMermaidPreviewSvg] = useState<string | null>(null);
  const [mermaidPreviewOpen, setMermaidPreviewOpen] = useState(false);
  const canRenderMermaidCode = renderMermaid && shouldRenderMermaidCodeBlock(language, code);
  const documentVisibilityRevision = useDocumentVisibilityRevision(canRenderMermaidCode);
  const mermaidAutoRenderDecision = useMemo(() => {
    if (!canRenderMermaidCode) {
      return null;
    }

    return resolveMermaidAutoRenderDecision(code, {
      documentVisibilityState: getCurrentMermaidDocumentVisibility(),
    });
  }, [canRenderMermaidCode, code, documentVisibilityRevision]);
  const shouldRenderMermaid =
    canRenderMermaidCode && mermaidAutoRenderDecision?.shouldRender === true;

  useEffect(() => {
    setIsWrapped(wrapLongLines);
  }, [wrapLongLines]);

  const toggleWrapLongLines = useCallback(() => {
    setIsWrapped((current) => !current);
  }, []);

  const openMermaidPreview = useCallback(() => {
    setMermaidPreviewOpen(true);
  }, []);

  useEffect(() => {
    if (!shouldRenderMermaid) {
      setMermaidPreviewSvg(null);
      setMermaidPreviewOpen(false);
    }
  }, [shouldRenderMermaid]);

  useEffect(() => {
    if (!mermaidAutoRenderDecision || mermaidAutoRenderDecision.shouldRender) {
      return;
    }

    logger.debug("[CodeBlock] Mermaid 自动渲染跳过", {
      reason: mermaidAutoRenderDecision.reason,
      ...mermaidAutoRenderDecision.metrics,
    });
  }, [mermaidAutoRenderDecision]);

  const contextValue = useMemo(
    () => ({
      code,
      renderingMermaid: shouldRenderMermaid,
      mermaidPreviewAvailable: Boolean(mermaidPreviewSvg),
      openMermaidPreview,
      toggleWrapLongLines,
      wrapLongLines: isWrapped,
    }),
    [
      code,
      isWrapped,
      mermaidPreviewSvg,
      openMermaidPreview,
      shouldRenderMermaid,
      toggleWrapLongLines,
    ],
  );

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <CodeBlockContainer
        className={cn(
          className,
          // Mermaid 直接融入消息背景，不能继承普通代码块的底板。
          shouldRenderMermaid && "rounded-none border-0 bg-transparent",
        )}
        language={language}
        {...props}
      >
        {children}
        <div className={cn("p-2 pt-0 pb-3", contentClassName)}>
          {shouldRenderMermaid ? (
            <MermaidBlock
              code={code}
              theme={appTheme}
              onOpenPreview={openMermaidPreview}
              onPreviewSvgChange={setMermaidPreviewSvg}
              // className={cn(children ? "border-t border-border" : null)}
            />
          ) : (
            <CodeViewer
              code={code}
              enableSyntaxHighlighting={enableSyntaxHighlighting}
              language={language}
              showLineNumbers={showLineNumbers}
              theme={theme}
              wrapLongLines={isWrapped}
              focusedRange={focusedRange}
              focusRequestId={focusRequestId}
              markedLines={markedLines}
              className="bg-transparent"
              fontSizePx={fontSizePx}
              // markdown 代码块外层是 bg-card，但 CodeViewer 默认把 @pierre/diffs 背景设成 background。
              // 这里仅覆盖 markdown CodeBlock 入口，避免侧边栏文件预览的背景层级被一起改掉。
              style={
                {
                  "--diffs-bg": "var(--color-card)",
                  "--diffs-light-bg": "var(--color-card)",
                  "--diffs-dark-bg": "var(--color-card)",
                  "--diffs-gap-block": "0px",
                } as CSSProperties
              }
            />
          )}
        </div>
        {shouldRenderMermaid && mermaidPreviewSvg ? (
          <DiagramPreviewDialog
            open={mermaidPreviewOpen}
            onOpenChange={setMermaidPreviewOpen}
            svg={mermaidPreviewSvg}
            title={intl.formatMessage({ id: "codeBlock.mermaid.ariaLabel" })}
          />
        ) : null}
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  );
};

export type CodeBlockWrapButtonProps = ComponentProps<typeof Button>;

export const CodeBlockWrapButton = ({
  "aria-label": ariaLabel,
  children,
  className,
  onClick,
  title,
  ...props
}: CodeBlockWrapButtonProps) => {
  const { toggleWrapLongLines, wrapLongLines } = useContext(CodeBlockContext);
  const { intl } = useZCodeIntl();
  const label = title ?? intl.formatMessage({ id: "codeBlock.wrapLines" });

  return (
    <ControlHintTooltip title={label} side="top">
      <Button
        aria-label={ariaLabel ?? label}
        aria-pressed={wrapLongLines}
        className={cn("shrink-0", wrapLongLines && "bg-muted", className)}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) {
            toggleWrapLongLines();
          }
        }}
        size="icon-md"
        type="button"
        variant="ghost"
        {...props}
      >
        {children ?? <WrapTextIcon className="size-3.5" />}
      </Button>
    </ControlHintTooltip>
  );
};

export type CodeBlockMermaidPreviewButtonProps = ComponentProps<typeof Button>;

export const CodeBlockMermaidPreviewButton = ({
  "aria-label": ariaLabel,
  children,
  className,
  onClick,
  title,
  ...props
}: CodeBlockMermaidPreviewButtonProps) => {
  const { intl } = useZCodeIntl();
  const { mermaidPreviewAvailable, openMermaidPreview } = useContext(CodeBlockContext);
  const label = title ?? intl.formatMessage({ id: "codeBlock.mermaid.openPreview" });

  return (
    <ControlHintTooltip title={label} side="top">
      <Button
        aria-label={ariaLabel ?? label}
        className={cn("shrink-0", className)}
        disabled={!mermaidPreviewAvailable}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) {
            openMermaidPreview();
          }
        }}
        size="icon-md"
        type="button"
        variant="ghost"
        {...props}
      >
        {children ?? <Maximize2Icon className="size-3.5" />}
      </Button>
    </ControlHintTooltip>
  );
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  "aria-label": ariaLabel,
  onCopy,
  onError,
  title,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number>(0);
  const { code } = useContext(CodeBlockContext);
  const { intl } = useZCodeIntl();
  const label = title ?? intl.formatMessage({ id: "codeBlock.copyCode" });

  const copyToClipboard = useCallback(async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      if (!isCopied) {
        await navigator.clipboard.writeText(code);
        setIsCopied(true);
        onCopy?.();
        timeoutRef.current = window.setTimeout(() => setIsCopied(false), timeout);
      }
    } catch (error) {
      onError?.(error as Error);
    }
  }, [code, onCopy, onError, timeout, isCopied]);

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <ControlHintTooltip title={label} side="top">
      <Button
        aria-label={ariaLabel ?? label}
        className={cn("shrink-0", className)}
        onClick={copyToClipboard}
        size="icon-md"
        type="button"
        variant="ghost"
        {...props}
      >
        {children ?? <Icon className="size-3.5" />}
      </Button>
    </ControlHintTooltip>
  );
};

export type CodeBlockLanguageSelectorProps = ComponentProps<typeof Select>;

export const CodeBlockLanguageSelector = (props: CodeBlockLanguageSelectorProps) => (
  <Select {...props} />
);

export type CodeBlockLanguageSelectorTriggerProps = ComponentProps<typeof SelectTrigger>;

export const CodeBlockLanguageSelectorTrigger = ({
  className,
  ...props
}: CodeBlockLanguageSelectorTriggerProps) => (
  <SelectTrigger
    className={cn("h-7 border-none bg-transparent px-2 text-ui-base shadow-none", className)}
    size="sm"
    {...props}
  />
);

export type CodeBlockLanguageSelectorValueProps = ComponentProps<typeof SelectValue>;

export const CodeBlockLanguageSelectorValue = (props: CodeBlockLanguageSelectorValueProps) => (
  <SelectValue {...props} />
);

export type CodeBlockLanguageSelectorContentProps = ComponentProps<typeof SelectContent>;

export const CodeBlockLanguageSelectorContent = ({
  align = "end",
  ...props
}: CodeBlockLanguageSelectorContentProps) => <SelectContent align={align} {...props} />;

export type CodeBlockLanguageSelectorItemProps = ComponentProps<typeof SelectItem>;

export const CodeBlockLanguageSelectorItem = (props: CodeBlockLanguageSelectorItemProps) => (
  <SelectItem {...props} />
);
