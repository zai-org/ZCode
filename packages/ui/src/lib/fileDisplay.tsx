import { useEffect, useState, type ReactElement } from "react";
import { getPathLeaf, isAbsoluteFilePath } from "@/lib/path.js";
import {
  DEFAULT_FILE_ICON_NAME,
  normalizePath,
  trimTrailingSeparator,
  resolveIconName,
  getIconPalette,
  getIconLabel,
  buildInlineSvgDataUrl,
} from "@/lib/fileDisplayHelpers.js";

export const INLINE_FALLBACK_FILE_ICON_SRC =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><path d="M4.5 1.5h4.586L12.5 4.914V13a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 3.5 13V3A1.5 1.5 0 0 1 5 1.5Z" stroke="%2394A3B8" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.75V5h3.25" stroke="%2394A3B8" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  );
let defaultFileDisplayBasePath: string | null = null;

export interface FileDisplayDescriptor {
  fileIcon: string;
  fileIconSrc: string;
  fileName: string;
  filePath: string | null;
  normalizedPath: string;
}

export interface FileDisplayOptions {
  basePath?: string;
  kind?: "file" | "directory";
  showIcon?: boolean;
  showFilePath?: boolean;
  iconSize?: number;
  className?: string;
  fileNameClassName?: string;
  filePathClassName?: string;
}

export function setDefaultFileDisplayBasePath(basePath: string | null) {
  defaultFileDisplayBasePath = basePath;
}

function resolveMaterialIconBasePath(): string {
  const baseUrl =
    typeof import.meta !== "undefined" && typeof import.meta.env?.BASE_URL === "string"
      ? import.meta.env.BASE_URL
      : "/";

  // web 端 public 资源挂在根路径下，desktop 端则使用 file:// + base="./"。
  // 之前把图标路径写死成 /material-icons，Electron 会把它解析到磁盘根目录，导致 file icon 全部 404。
  // 这里统一基于运行时 base URL 生成资源路径，让 desktop/web 都命中各自的 public/material-icons。
  return `${baseUrl.replace(/\/?$/, "/")}material-icons`;
}

export function buildMaterialFileIconSrc(iconName: string): string {
  return `${resolveMaterialIconBasePath()}/${iconName}.svg`;
}

function buildIconSrc(iconName: string): string {
  return buildMaterialFileIconSrc(iconName);
}

export const FOLDER_FILE_ICON_SRC = buildMaterialFileIconSrc("folder");
export const DOCUMENT_FILE_ICON_SRC = buildMaterialFileIconSrc(DEFAULT_FILE_ICON_NAME);

function resolveFallbackFileIconSrc(currentSrc: string): string | null {
  const defaultIconSrc = DOCUMENT_FILE_ICON_SRC;
  if (currentSrc === INLINE_FALLBACK_FILE_ICON_SRC) {
    return null;
  }

  if (currentSrc === defaultIconSrc || currentSrc.endsWith("/document.svg")) {
    // 之前图标缺失最多只会回退到 document.svg。
    // 如果默认素材本身也不存在，界面上仍会出现破图。这里补第二层兜底，
    // 退回内置 data URL 图标，保证不同运行环境都至少有稳定占位。
    return INLINE_FALLBACK_FILE_ICON_SRC;
  }

  return defaultIconSrc;
}

function stripBasePath(path: string, basePath?: string): string {
  if (!basePath) {
    return path;
  }

  const normalizedPath = trimTrailingSeparator(normalizePath(path));
  const normalizedBasePath = trimTrailingSeparator(normalizePath(basePath));

  if (normalizedPath === normalizedBasePath) {
    return "";
  }

  if (normalizedPath.startsWith(`${normalizedBasePath}/`)) {
    return normalizedPath.slice(normalizedBasePath.length + 1);
  }

  return path;
}

function buildFilePath(path: string, fileName: string): string | null {
  const normalizedPath = normalizePath(path);

  if (!normalizedPath || normalizedPath === fileName) {
    return null;
  }

  const fileNameIndex = normalizedPath.lastIndexOf(`/${fileName}`);
  if (fileNameIndex === -1) {
    return null;
  }

  const directoryPath = normalizedPath.slice(0, fileNameIndex + 1);
  return directoryPath.length > 0 ? directoryPath : null;
}

export function resolveFileDisplayDescriptor(
  filePath: string,
  options: Pick<FileDisplayOptions, "basePath" | "kind"> = {},
): FileDisplayDescriptor {
  const normalizedPath = normalizePath(filePath);
  const fileName = getPathLeaf(normalizedPath);
  const effectiveBasePath = options.basePath ?? defaultFileDisplayBasePath ?? undefined;
  const relativePath = stripBasePath(normalizedPath, effectiveBasePath);
  const resolvedFilePath = buildFilePath(relativePath, fileName);
  const fileIcon = options.kind === "directory" ? "folder" : resolveIconName(fileName);

  return {
    fileIcon,
    fileIconSrc: buildIconSrc(fileIcon),
    fileName,
    filePath: resolvedFilePath,
    normalizedPath,
  };
}

export function createFileDisplayDom(
  filePath: string,
  options: FileDisplayOptions = {},
): HTMLSpanElement {
  const descriptor = resolveFileDisplayDescriptor(filePath, {
    basePath: options.basePath,
    kind: options.kind,
  });
  const container = document.createElement("span");
  container.className =
    options.className ?? "inline-flex max-w-full items-center gap-1.5 align-middle";

  if (options.showIcon !== false) {
    const icon = document.createElement("img");
    icon.src = descriptor.fileIconSrc;
    icon.alt = "";
    icon.width = options.iconSize ?? 14;
    icon.height = options.iconSize ?? 14;
    icon.className = "shrink-0";
    icon.setAttribute("aria-hidden", "true");
    icon.addEventListener("error", () => {
      const fallbackSrc = resolveFallbackFileIconSrc(icon.src);
      if (!fallbackSrc) {
        return;
      }
      icon.src = fallbackSrc;
    });
    container.append(icon);
  }

  const primary = document.createElement("span");
  primary.className = options.fileNameClassName ?? "truncate text-[0.95em] leading-[1.6]";
  primary.textContent = descriptor.fileName;
  container.append(primary);

  if (options.showFilePath && descriptor.filePath) {
    const secondary = document.createElement("span");
    secondary.className =
      options.filePathClassName ?? "truncate text-[0.85em] text-muted-foreground";
    secondary.textContent = descriptor.filePath;
    container.append(secondary);
  }

  return container;
}

export function FileDisplayInline({
  path,
  options,
}: {
  path: string;
  options?: FileDisplayOptions;
}): ReactElement {
  const descriptor = resolveFileDisplayDescriptor(path, {
    basePath: options?.basePath,
    kind: options?.kind,
  });
  const [fileIconSrc, setFileIconSrc] = useState(descriptor.fileIconSrc);

  useEffect(() => {
    // mention panel 会复用同一批列表项组件，之前这里只在首次渲染时初始化图标 src，
    // 过滤条件或可视区变化后 path 变了但 state 没重置，就会把上一行的图标串到下一行。
    // 这里在解析结果变化时同步重置，确保图标始终跟当前文件扩展名对应。
    setFileIconSrc(descriptor.fileIconSrc);
  }, [descriptor.fileIconSrc]);

  return (
    <span className={options?.className ?? "inline-flex max-w-full items-center gap-1 "}>
      {options?.showIcon !== false ? (
        <img
          src={fileIconSrc}
          alt=""
          width={options?.iconSize ?? 16}
          height={options?.iconSize ?? 16}
          className="shrink-0"
          aria-hidden="true"
          onError={() => {
            const fallbackSrc = resolveFallbackFileIconSrc(fileIconSrc);
            if (!fallbackSrc) {
              return;
            }
            setFileIconSrc(fallbackSrc);
          }}
        />
      ) : null}
      <span
        className={
          options?.fileNameClassName ?? "truncate text-ui-base font-medium text-foreground"
        }
      >
        {descriptor.fileName}
      </span>
      {options?.showFilePath && descriptor.filePath ? (
        <span
          className={options.filePathClassName ?? "truncate text-ui-base text-foreground-subtlest"}
        >
          {descriptor.filePath}
        </span>
      ) : null}
    </span>
  );
}

export function FileDisplayIcon({
  src,
  size = 16,
  className,
}: {
  src: string;
  size?: number;
  className?: string;
}): ReactElement {
  const [fileIconSrc, setFileIconSrc] = useState(src);

  useEffect(() => {
    // toolcall 列表项会复用同一套文件图标节点。
    // 如果这里只在首次渲染时保留旧 src，切到下一条文件记录后会把上一条 fallback 状态串过来。
    setFileIconSrc(src);
  }, [src]);

  return (
    <img
      src={fileIconSrc}
      alt=""
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      onError={() => {
        const fallbackSrc = resolveFallbackFileIconSrc(fileIconSrc);
        if (!fallbackSrc) {
          return;
        }
        setFileIconSrc(fallbackSrc);
      }}
    />
  );
}

export function getFileDisplayPath(filePath: string, basePath?: string): string {
  const normalizedPath = normalizePath(filePath);
  const pathWithoutBase = stripBasePath(normalizedPath, basePath);

  if (!pathWithoutBase) {
    return getPathLeaf(normalizedPath);
  }

  if (basePath || !isAbsoluteFilePath(pathWithoutBase)) {
    return pathWithoutBase;
  }

  return normalizedPath;
}
