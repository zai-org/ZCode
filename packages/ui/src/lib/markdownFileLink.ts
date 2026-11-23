import { decodeFilePathUriEscapes, isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
import { stripBalancedAssistantPathQuotes } from "@/lib/assistantPathQuotes.js";

/** 文件链接里的一段行号（从 1 开始，原样保留写法里的起止行；校验与截断在打开预览时做）。 */
export interface MarkdownFileLinkLineRange {
  startLine: number;
  endLine: number;
}

interface ParsedMarkdownFileLink {
  path: string;
  /** 首段起始行；保留给只关心单行的调用方。行号信息的唯一来源是 lineRanges。 */
  lineNumber: number | null;
  columnNumber: number | null;
  /** `:42` → [42-42]；`:30-35`、`#L30-L35` → [30-35]；`:30,40-42` → [30-30, 40-42]。无行号时为空数组。 */
  lineRanges: MarkdownFileLinkLineRange[];
}

export interface MarkdownFileLinkResolveOptions {
  /** 当前 workspace Host 报告的用户 Home；Renderer 不自行读取本机 Home。 */
  homePath?: string;
}

const LINE_AND_COLUMN_SUFFIX_RE = /^(?<path>.+):(?<line>\d+):(?<column>\d+)$/;
// `:42`、`:30-35`、`:30,40`、`:30-35,40-42`：只在后缀整体由数字、`-`、`,` 组成时按行号解析，
// Windows 盘符 `C:/a.ts` 和其他含冒号的普通文件名不会命中。
const LINE_RANGES_SUFFIX_RE = /^(?<path>.+):(?<ranges>\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/;
// Bugfix：`#L30-L35` 曾只取起始行，结束行被丢，预览只高亮第 30 行；这里同时捕获结束行。
const HASH_LINE_SUFFIX_RE = /^(?<path>.+)#L(?<line>\d+)(?:-L?(?<endLine>\d+))?$/i;
const FILE_URL_PROTOCOL_RE = /^file:\/\//i;
const HARDEN_SAFE_WINDOWS_ABSOLUTE_PATH_RE = /^\/[a-zA-Z]:\//;
const COMMON_UNIX_ABSOLUTE_ROOT_SEGMENTS = new Set([
  "Applications",
  "Library",
  "System",
  "Users",
  "Volumes",
  "bin",
  "boot",
  "dev",
  "etc",
  "home",
  "lib",
  "lib64",
  "media",
  "mnt",
  "opt",
  "private",
  "proc",
  "root",
  "run",
  "sbin",
  "srv",
  "sys",
  "tmp",
  "usr",
  "var",
]);

function isWorkspaceRelativeFileHref(href: string): boolean {
  return href.startsWith("./");
}

function normalizeHomeRelativePath(path: string): string | null {
  if (path.startsWith("./~/") || path.startsWith("./~\\")) {
    return path.slice(2);
  }
  return /^~[\\/]/.test(path) ? path : null;
}

function isHomeRelativeFilePath(path: string): boolean {
  return normalizeHomeRelativePath(path) !== null;
}

function isUnsupportedNamedHomePath(path: string): boolean {
  return /^~[^\\/]+[\\/]/.test(path);
}

function resolveHomeRelativeFilePath(path: string, homePath: string | undefined): string | null {
  const homeRelativePath = normalizeHomeRelativePath(path);
  if (!homeRelativePath || !homePath || !isAbsoluteFilePath(homePath)) {
    return null;
  }

  const separator = homePath.includes("\\") && !homePath.includes("/") ? "\\" : "/";
  return joinFilePath(homePath, homeRelativePath.slice(2).replace(/[\\/]/g, separator));
}

function isBareWorkspaceRelativeFileHref(href: string): boolean {
  if (
    !href ||
    href.startsWith("/") ||
    href.startsWith("#") ||
    href.startsWith("../") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)
  ) {
    return false;
  }

  return href.includes("/") || href.includes("\\");
}

function isAbsoluteMarkdownFileHref(rawHref: string, normalizedHref: string): boolean {
  return (
    isAbsoluteFilePath(rawHref) ||
    isAbsoluteFilePath(normalizedHref) ||
    normalizedHref.startsWith("//")
  );
}

function isLikelyUnixAbsoluteFilePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return false;
  }

  const firstSegment = path.slice(1).split("/")[0];
  return Boolean(firstSegment && COMMON_UNIX_ABSOLUTE_ROOT_SEGMENTS.has(firstSegment));
}

function isPathInsideWorkspaceRoot(path: string, workspacePath: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedWorkspacePath = workspacePath.replace(/\\/g, "/").replace(/\/$/, "");
  return (
    normalizedPath === normalizedWorkspacePath ||
    normalizedPath.startsWith(`${normalizedWorkspacePath}/`)
  );
}

function parseFileUrlPath(path: string): string | null {
  if (!FILE_URL_PROTOCOL_RE.test(path)) {
    return null;
  }

  try {
    const url = new URL(path);
    if (url.protocol !== "file:") {
      return null;
    }

    const decodedPathname = decodeFilePathUriEscapes(url.pathname);
    if (/^\/[a-zA-Z]:\//.test(decodedPathname)) {
      return decodedPathname.slice(1);
    }

    if (url.hostname && url.hostname !== "localhost") {
      return `//${url.hostname}${decodedPathname}`;
    }

    return decodedPathname;
  } catch {
    return null;
  }
}

function normalizeMarkdownFilePath(path: string): string {
  return parseFileUrlPath(path) ?? decodeFilePathUriEscapes(path);
}

export function normalizeWorkspaceRelativeFilePath(relativePath: string): string | null {
  const segments: string[] = [];
  for (const segment of relativePath.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        // 只检查路径是否以 ../ 开头是不够的：嵌套回退会在拼接后逃逸 workspace。
        // 这里在 Renderer 发起 stat/checkFilesExist 前做跨平台词法归一，根目录下溢时直接拒绝。
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.join("/");
}

function resolveContainedWorkspaceRelativePath(
  workspacePath: string,
  relativePath: string,
): string | null {
  const normalizedRelativePath = normalizeWorkspaceRelativeFilePath(relativePath);
  if (normalizedRelativePath === null) return null;

  const separator = workspacePath.includes("\\") && !workspacePath.includes("/") ? "\\" : "/";
  return joinFilePath(workspacePath, normalizedRelativePath.replaceAll("/", separator));
}

function parseLineRangesSuffix(ranges: string): MarkdownFileLinkLineRange[] {
  return ranges.split(",").map((segment) => {
    const [start, end] = segment.split("-");
    const startLine = Number.parseInt(start!, 10);
    return { startLine, endLine: end === undefined ? startLine : Number.parseInt(end, 10) };
  });
}

function withLineRanges(
  path: string,
  lineRanges: MarkdownFileLinkLineRange[],
  columnNumber: number | null = null,
): ParsedMarkdownFileLink {
  return {
    path: normalizeMarkdownFilePath(path),
    lineNumber: lineRanges[0]?.startLine ?? null,
    columnNumber,
    lineRanges,
  };
}

export function parseMarkdownFileLinkTarget(href: string): ParsedMarkdownFileLink {
  // 只在路径归一化阶段解码一次；入口提前 decode 会让 `%2520` 变成 `%20`，
  // 再由 normalizeMarkdownFilePath 解码成空格，破坏文件名中的字面 percent-escape。
  const normalizedHref = stripBalancedAssistantPathQuotes(href).replace(/\\/g, "/");
  const withHashLineMatch = normalizedHref.match(HASH_LINE_SUFFIX_RE);
  if (withHashLineMatch?.groups) {
    const { path, line, endLine } = withHashLineMatch.groups;
    if (path && line) {
      const startLine = Number.parseInt(line, 10);
      return withLineRanges(path, [
        { startLine, endLine: endLine ? Number.parseInt(endLine, 10) : startLine },
      ]);
    }
  }

  const withLineAndColumnMatch = normalizedHref.match(LINE_AND_COLUMN_SUFFIX_RE);
  if (withLineAndColumnMatch?.groups) {
    const { path, line, column } = withLineAndColumnMatch.groups;
    if (path && line && column) {
      const startLine = Number.parseInt(line, 10);
      return withLineRanges(path, [{ startLine, endLine: startLine }], Number.parseInt(column, 10));
    }
  }

  // Bugfix：`a.ts:30-35` 曾不命中单行正则，整个 `a.ts:30-35` 被当成文件名，文件打不开。
  const withLineRangesMatch = normalizedHref.match(LINE_RANGES_SUFFIX_RE);
  if (withLineRangesMatch?.groups) {
    const { path, ranges } = withLineRangesMatch.groups;
    if (path && ranges) {
      return withLineRanges(path, parseLineRangesSuffix(ranges));
    }
  }

  return withLineRanges(normalizedHref, []);
}

export function resolveMarkdownFileLink(
  workspacePath: string | undefined,
  href: string,
  options: MarkdownFileLinkResolveOptions = {},
): ParsedMarkdownFileLink | null {
  // 聊天消息里的本地文件链接现在既可能是 `./src/app.ts` 这种工作区相对路径，
  // 也可能是 `/abs/path/app.ts:30` 这种绝对路径 + 行号。
  // 只看到前导 `/` 就当成 workspace 子路径会让绝对路径被再拼一次 workspace 前缀，
  // 同时 `:30` 也会混进文件名里。这里先拆掉可选行号，再把“相对路径”和“绝对路径”分开解析。
  const parsedTarget = parseMarkdownFileLinkTarget(href);

  if (isUnsupportedNamedHomePath(parsedTarget.path)) {
    return null;
  }

  const homePath = resolveHomeRelativeFilePath(parsedTarget.path, options.homePath);
  if (isHomeRelativeFilePath(parsedTarget.path)) {
    return homePath
      ? {
          ...parsedTarget,
          path: homePath,
        }
      : null;
  }

  if (HARDEN_SAFE_WINDOWS_ABSOLUTE_PATH_RE.test(parsedTarget.path)) {
    // `/C:/...` 只是在 Windows Markdown 渲染管线中绕过 harden 的内部格式。
    // 旧 guard 只把盘符 workspace 当成 Windows，遗漏统一路径工具已支持的 UNC。
    // Windows workspace 既可能是盘符也可能是反斜杠 UNC；以 `/` 开头的 Unix 路径仍须拒绝。
    if (!workspacePath || workspacePath.startsWith("/") || !isAbsoluteFilePath(workspacePath)) {
      return null;
    }
    return {
      ...parsedTarget,
      path: parsedTarget.path.slice(1),
    };
  }

  if (
    isWorkspaceRelativeFileHref(parsedTarget.path) ||
    isBareWorkspaceRelativeFileHref(parsedTarget.path)
  ) {
    if (!workspacePath) {
      return null;
    }

    const relativePath = isWorkspaceRelativeFileHref(parsedTarget.path)
      ? parsedTarget.path.slice(2)
      : parsedTarget.path;
    if (!relativePath) {
      return null;
    }

    const containedPath = resolveContainedWorkspaceRelativePath(workspacePath, relativePath);
    if (!containedPath) return null;

    return {
      ...parsedTarget,
      path: containedPath,
    };
  }

  if (
    workspacePath &&
    parsedTarget.path.startsWith("/") &&
    !isLikelyUnixAbsoluteFilePath(parsedTarget.path)
  ) {
    // 远程 workspace 常见 `/workspace`、`/repo` 这类非系统根目录。
    // 如果链接已经位于当前 workspace 内，不能再按 Markdown 根相对路径拼接一次。
    if (isPathInsideWorkspaceRoot(parsedTarget.path, workspacePath)) {
      return parsedTarget;
    }
    // Streamdown/rehype-harden 会把 `./flappy.html` 规范化成 `/flappy.html`。
    // 这里的前导 `/` 表示 markdown 根相对链接，不是系统根目录；否则会误去 stat `/flappy.html`。
    const containedPath = resolveContainedWorkspaceRelativePath(
      workspacePath,
      parsedTarget.path.slice(1),
    );
    if (!containedPath) return null;
    return {
      ...parsedTarget,
      path: containedPath,
    };
  }

  if (isAbsoluteMarkdownFileHref(href, parsedTarget.path)) {
    return parsedTarget;
  }

  return null;
}
