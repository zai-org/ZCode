"use client";

import { createMermaidPlugin, type MermaidConfig } from "@streamdown/mermaid";
import { LoaderCircle } from "lucide-react";
import type { HTMLAttributes } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { Theme } from "@/useTheme.js";
import { resolveTheme } from "@/useTheme.js";

type MermaidRenderState =
  | {
      status: "loading";
    }
  | {
      status: "ready";
      svg: string;
    }
  | {
      status: "plaintext";
    };

export interface MermaidBlockProps extends HTMLAttributes<HTMLDivElement> {
  code: string;
  /**
   * 应用主题（store 耦合剥离）：由调用方从上层状态传入。
   * 默认 "system" 跟随操作系统，供旧调用点/待删代码兜底。
   */
  theme?: Theme;
  onOpenPreview?: () => void;
  onPreviewSvgChange?: (svg: string | null) => void;
}

const mermaidPlugin = createMermaidPlugin();
let mermaidRenderQueue = Promise.resolve();
const MERMAID_COLOR_CANVAS_SENTINEL = "#010203";

// Mermaid 底层的 khroma 解析器不支持 Tailwind v4 常见的 oklab/color-mix 结果。
// 先让浏览器解析主题 token，再通过 canvas 采样成传统 rgb/rgba，避免把现代 CSS 颜色直接传给 Mermaid。
// Web 远程控制的启动测试只提供了最小 document mock，SSR/预渲染环境也可能没有 DOM 工厂；
// 颜色归一化是增强能力，不能让 MessageResponse 的静态导入在这些环境中直接崩溃。
const canCreateDomElements =
  typeof document !== "undefined" && typeof document.createElement === "function";
const mermaidColorResolverEl: HTMLSpanElement | null = canCreateDomElements
  ? document.createElement("span")
  : null;
const mermaidColorNormalizeCtx: CanvasRenderingContext2D | null = (() => {
  if (!canCreateDomElements) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx) {
    ctx.globalCompositeOperation = "copy";
  }
  return ctx;
})();

function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const run = mermaidRenderQueue.then(task, task);
  mermaidRenderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function hashMermaidCode(code: string): string {
  let hash = 2166136261;
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function normalizeCssColorForMermaid(raw: string, fallback: string): string {
  if (!raw || !mermaidColorResolverEl || !mermaidColorNormalizeCtx || !document.body) {
    return raw || fallback;
  }

  try {
    document.body.appendChild(mermaidColorResolverEl);
    mermaidColorResolverEl.style.color = "";
    mermaidColorResolverEl.style.color = raw;
    const resolved = getComputedStyle(mermaidColorResolverEl).color;
    if (!resolved) {
      return fallback;
    }

    mermaidColorNormalizeCtx.clearRect(0, 0, 1, 1);
    mermaidColorNormalizeCtx.fillStyle = MERMAID_COLOR_CANVAS_SENTINEL;
    const sentinelFillStyle = mermaidColorNormalizeCtx.fillStyle;
    mermaidColorNormalizeCtx.fillStyle = resolved;
    // 如果 canvas 也不支持该颜色格式，fillStyle 会停在哨兵色，直接回退到 Mermaid 可解析的安全色。
    if (mermaidColorNormalizeCtx.fillStyle === sentinelFillStyle) {
      return fallback;
    }

    mermaidColorNormalizeCtx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = mermaidColorNormalizeCtx.getImageData(0, 0, 1, 1).data;
    const roundedAlpha = +(a / 255).toFixed(3);
    return roundedAlpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${roundedAlpha})`;
  } catch {
    return fallback;
  } finally {
    mermaidColorResolverEl.remove();
  }
}

function resolveCssColor(variableName: string, fallback: string): string {
  if (typeof document === "undefined" || !document.body) {
    return fallback;
  }

  const probe = document.createElement("span");
  probe.style.color = `var(${variableName})`;
  probe.style.pointerEvents = "none";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();

  return normalizeCssColorForMermaid(color, fallback);
}

function createMermaidConfig(resolvedTheme: "light" | "dark"): MermaidConfig {
  const background = resolveCssColor(
    "--color-card",
    resolvedTheme === "dark" ? "#18181b" : "#ffffff",
  );
  const surface = resolveCssColor(
    "--color-surface",
    resolvedTheme === "dark" ? "#27272a" : "#f4f4f5",
  );
  const accent = resolveCssColor(
    "--color-accent",
    resolvedTheme === "dark" ? "#1f2937" : "#f0f9ff",
  );
  const text = resolveCssColor(
    "--color-foreground",
    resolvedTheme === "dark" ? "#f4f4f5" : "#27272a",
  );
  const subtleText = resolveCssColor(
    "--color-foreground-subtle",
    resolvedTheme === "dark" ? "#a1a1aa" : "#52525b",
  );
  const border = resolveCssColor(
    "--color-border",
    resolvedTheme === "dark" ? "#3f3f46" : "#d4d4d8",
  );
  const rootStyle =
    typeof document === "undefined" ? null : getComputedStyle(document.documentElement);

  return {
    fontFamily:
      rootStyle?.getPropertyValue("--font-sans").trim() || "ui-sans-serif, system-ui, sans-serif",
    htmlLabels: false,
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: {
      actorBkg: background,
      actorBorder: border,
      actorTextColor: text,
      background: "transparent",
      clusterBkg: surface,
      clusterBorder: border,
      edgeLabelBackground: resolveCssColor("--color-background", background),
      fontSize: rootStyle?.getPropertyValue("--text-ui-base").trim() || "14px",
      lineColor: subtleText,
      mainBkg: surface,
      nodeBorder: border,
      nodeTextColor: text,
      noteBkgColor: accent,
      noteTextColor: text,
      primaryBorderColor: border,
      primaryColor: surface,
      primaryTextColor: text,
      secondaryBorderColor: border,
      secondaryColor: accent,
      secondaryTextColor: text,
      signalColor: subtleText,
      signalTextColor: text,
      tertiaryBorderColor: border,
      tertiaryColor: background,
      tertiaryTextColor: text,
      textColor: text,
    },
    // 默认边标签会从主色派生底色，与宿主表面不一致；只调整图表内默认样式，
    // 不使用 !important 覆盖源码的 style / classDef，也不改写菱形、圆形等节点。
    themeCSS: `
      .node text, .edgeLabel text { font-weight: 500; }
      .node rect.basic:not([rx]) { rx: var(--radius-md); ry: var(--radius-md); }
      .edgeLabel rect { opacity: 1; rx: var(--radius-sm); ry: var(--radius-sm); }
      .edge-thickness-normal { stroke-width: 1px; }
      .flowchart-link { stroke-linecap: round; stroke-linejoin: round; }
    `,
  };
}

function resolveBrowserTheme(theme: Theme): "light" | "dark" {
  if (typeof window === "undefined") {
    return theme === "dark" || theme === "zai-dark" ? "dark" : "light";
  }

  return resolveTheme(theme);
}

function useSystemThemeRevision(theme: Theme): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => setRevision((current) => current + 1);

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [theme]);

  return revision;
}

function normalizeMermaidRenderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MermaidBlock({
  code,
  className,
  theme = "system",
  onOpenPreview,
  onPreviewSvgChange,
  ...props
}: MermaidBlockProps) {
  const { intl } = useZCodeIntl();
  const systemThemeRevision = useSystemThemeRevision(theme);
  const renderIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const trimmedCode = code.trim();
  const resolvedTheme = resolveBrowserTheme(theme);
  const themeKey = `${theme}:${resolvedTheme}:${systemThemeRevision}`;
  const mermaidConfig = useMemo(
    () => createMermaidConfig(resolvedTheme),
    [resolvedTheme, themeKey],
  );
  const renderKey = useMemo(
    () => `${themeKey}:${hashMermaidCode(trimmedCode)}`,
    [themeKey, trimmedCode],
  );
  const [renderState, setRenderState] = useState<MermaidRenderState>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;

    if (!trimmedCode) {
      setRenderState({
        status: "plaintext",
      });
      onPreviewSvgChange?.(null);
      return;
    }

    setRenderState({ status: "loading" });
    onPreviewSvgChange?.(null);
    const renderId = `zcode-mermaid-${renderIdPrefix}-${hashMermaidCode(renderKey)}`;

    void enqueueMermaidRender(async () => {
      const renderer = mermaidPlugin.getMermaid(mermaidConfig);
      return renderer.render(renderId, trimmedCode);
    })
      .then(({ svg }) => {
        if (!cancelled) {
          setRenderState({ status: "ready", svg });
          onPreviewSvgChange?.(svg);
        }
      })
      .catch((error: unknown) => {
        const message = normalizeMermaidRenderError(error);
        logger.debug("[MermaidBlock] Mermaid 渲染失败", {
          error: message,
          codeLength: trimmedCode.length,
        });
        if (!cancelled) {
          // Mermaid 解析失败常见于模型流式输出未完成或用户粘贴了非标准语法。
          // 退回纯文本能保留内容可读，避免用错误面板打断聊天阅读。
          setRenderState({ status: "plaintext" });
          onPreviewSvgChange?.(null);
        }
      });

    return () => {
      cancelled = true;
      onPreviewSvgChange?.(null);
    };
  }, [intl, mermaidConfig, onPreviewSvgChange, renderIdPrefix, renderKey, trimmedCode]);

  return (
    <div
      className={cn("group/mermaid relative min-h-32 w-full", className)}
      data-mermaid-block=""
      {...props}
    >
      <div className="max-h-[420px] overflow-auto p-3 text-foreground">
        {renderState.status === "loading" ? (
          <div className="flex min-h-28 items-center justify-center gap-2 text-foreground-subtle text-ui-base">
            <LoaderCircle className="size-4 animate-spin" />
            <span>{intl.formatMessage({ id: "codeBlock.mermaid.loading" })}</span>
          </div>
        ) : null}
        {renderState.status === "plaintext" ? (
          <pre className="m-0 min-h-28 min-w-max bg-transparent font-mono text-foreground text-ui-base leading-relaxed">
            {code}
          </pre>
        ) : null}
        {renderState.status === "ready" ? (
          <div
            aria-label={intl.formatMessage({ id: "codeBlock.mermaid.ariaLabel" })}
            className="flex min-h-28 min-w-0 items-center justify-center select-text [&_svg]:h-auto [&_svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: renderState.svg }}
            onDoubleClick={onOpenPreview}
            role="img"
          />
        ) : null}
      </div>
    </div>
  );
}
