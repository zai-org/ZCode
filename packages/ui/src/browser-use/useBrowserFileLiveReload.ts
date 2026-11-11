import { useEffect, useRef, useState } from "react";
import type { IFileService, IFileWatcherService } from "@zcode/services";
import { browserPreviewSourceUrl, type FileWatchEvent } from "@zcode/shared";
import { getContainingDirectoryPath } from "@/lib/path.js";
import { safeWebviewCall } from "@/embeddedBrowserHelpers.js";
import { logger } from "@/logger.js";

// 内置浏览器 file:// 页面自动刷新（docs/browser-use/2026-11-03-browser-element-screenshot-and-live-reload-spec.md）。
// 只认页面实际加载过的本地资源：主 HTML + performance 资源清单里的 file:// URL。非递归监听这些资源所在的目录，
// 变化路径属于资源清单才刷新；watcher 合并了多个路径（不给 changedPath）时按 mtime/size 指纹核对。
// 修复原因：以前递归监听主 HTML 所在目录，在桌面这类大目录里别处的构建输出会让页面反复刷新。

/** Agent 一次改动常连写几个文件；合并成一次刷新 */
const LIVE_RELOAD_DEBOUNCE_MS = 300;
/** 依赖与版本库目录的变化与页面无关，且量大；不触发刷新 */
const IGNORED_PATH_SEGMENT_RE = /[\\/](?:node_modules|\.git)(?:[\\/]|$)/;
/** 资源清单与监听目录都有上限：页面引用再多，句柄和 stat 次数也有界 */
const MAX_TRACKED_RESOURCES = 200;
const MAX_WATCHED_DIRECTORIES = 16;

/**
 * 页面里读资源 URL。file:// 加载不进 Resource Timing（performance 清单为空），所以同时扫 DOM 引用
 * （link / script / img / source / video / audio / iframe / object）和同源样式表（含 @import 与 url(...)）；
 * performance 清单补上 fetch / XHR 等。结果在宿主侧去重、只留 file://、限量。
 */
const READ_RESOURCE_URLS_EXPRESSION = `(() => {
  const urls = [location.href, ...performance.getEntriesByType("resource").map((entry) => entry.name)];
  for (const element of document.querySelectorAll("link[href], script[src], img, source, video, audio, iframe[src], embed[src], object[data]")) {
    for (const value of [element.href, element.src, element.currentSrc, element.data, element.poster]) {
      if (typeof value === "string" && value) urls.push(value);
    }
  }
  const visit = (sheet, depth) => {
    if (!sheet || depth > 4 || urls.length > 2000) return;
    const base = sheet.href || location.href;
    if (sheet.href) urls.push(sheet.href);
    let rules;
    try { rules = sheet.cssRules; } catch { return; }
    for (const rule of rules) {
      if (rule.styleSheet) visit(rule.styleSheet, depth + 1);
      for (const match of rule.cssText.matchAll(/url\\(\\s*["']?([^"')]+)["']?\\s*\\)/g)) {
        try { urls.push(new URL(match[1], base).href); } catch {}
      }
    }
  };
  for (const sheet of document.styleSheets) visit(sheet, 0);
  return urls;
})()`;
/** load 后读资源清单；load 迟迟不来（挂起的子资源）时 5 秒后按已加载的读 */
const COLLECT_RESOURCES_SCRIPT = `new Promise((resolve) => {
  const collect = () => resolve(${READ_RESOURCE_URLS_EXPRESSION});
  if (document.readyState === "complete") collect();
  else { window.addEventListener("load", collect, { once: true }); setTimeout(collect, 5000); }
})`;
const READ_RESOURCES_NOW_SCRIPT = READ_RESOURCE_URLS_EXPRESSION;

const READ_SCROLL_SCRIPT = "({ x: window.scrollX, y: window.scrollY })";

function buildRestoreScrollScript(x: number, y: number): string {
  // dom-ready 时图片等子资源可能还没撑开页面高度，直接 scrollTo 会被截到较小的位置；等 load 后再滚。
  return `new Promise((resolve) => {
  const restore = () => { window.scrollTo(${x}, ${y}); resolve(true); };
  if (document.readyState === "complete") restore();
  else window.addEventListener("load", restore, { once: true });
})`;
}

/** file URL → 本机路径；不是 file URL 或无法解析时返回 null。Windows 盘符与 UNC 路径保持可被 fs.watch 接受。 */
export function fileUrlToLocalPath(url: string): string | null {
  let parsed: URL;
  try {
    // Bugfix：本机 HTML 改走 zcode-html:// 预览协议加载后（c3bb5e783a），地址栏状态与页面资源 URL 都是预览地址，
    // 这里只认 file:// 就一个路径都拿不到，自动刷新整个失效。先换回源 file:// 地址（file:// 原样返回）。
    parsed = new URL(browserPreviewSourceUrl(url));
  } catch {
    return null;
  }
  if (parsed.protocol !== "file:") return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (parsed.host) return `//${parsed.host}${pathname}`;
  // file:///C:/dir/a.html 的 pathname 是 /C:/dir/a.html
  return /^\/[a-zA-Z]:\//.test(pathname) ? pathname.slice(1) : pathname || null;
}

export function shouldLiveReloadForChange(changedPath: string | undefined): boolean {
  return !changedPath || !IGNORED_PATH_SEGMENT_RE.test(changedPath);
}

/** 比较用的路径键：分隔符统一成 /，不分大小写（Windows / macOS 默认卷都不分；Linux 上最多多刷一次） */
export function liveReloadPathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export interface LiveReloadResources {
  /** 路径键 → 本机路径；主 HTML 总在第一个 */
  paths: Map<string, string>;
  /** 路径键 → `mtimeMs:size`，stat 失败为 "missing"；watcher 给不出具体路径时据此核对 */
  fingerprints: Map<string, string>;
}

/** 主 HTML + 页面报告的资源 URL → 去重、限量的本机路径清单（只要 file://，忽略 http(s) / data: 等） */
export function collectLiveReloadResourcePaths(mainFilePath: string, urls: unknown): string[] {
  const result = new Map<string, string>([[liveReloadPathKey(mainFilePath), mainFilePath]]);
  if (Array.isArray(urls)) {
    for (const url of urls) {
      if (result.size >= MAX_TRACKED_RESOURCES) break;
      if (typeof url !== "string") continue;
      const path = fileUrlToLocalPath(url);
      if (path && shouldLiveReloadForChange(path)) result.set(liveReloadPathKey(path), path);
    }
  }
  return [...result.values()];
}

/** 资源所在目录（主 HTML 目录在前），去重、限量 */
export function resolveLiveReloadWatchDirectories(paths: readonly string[]): string[] {
  const directories = new Map<string, string>();
  for (const path of paths) {
    if (directories.size >= MAX_WATCHED_DIRECTORIES) break;
    const directory = getContainingDirectoryPath(path);
    if (directory) directories.set(liveReloadPathKey(directory), directory);
  }
  return [...directories.values()];
}

/** FNV-1a：给主 HTML 的内容一个短指纹 */
function hashContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * 资源指纹：mtime + size。主 HTML 再加内容哈希：外部写入同尺寸内容、mtime 又被保留或恢复时，
 * 只看元数据会当成没变、不刷新（!3450 CR-02）。主 HTML 读不出文字（非 UTF-8 等）时退回只看元数据。
 */
async function fingerprintPath(
  fileService: IFileService | undefined,
  path: string,
  withContent = false,
) {
  if (!fileService) return "unknown";
  try {
    const stat = await fileService.stat({ path });
    const meta = `${stat.mtimeMs ?? ""}:${stat.size ?? ""}`;
    if (!withContent) return meta;
    try {
      const { content } = await fileService.readDesignSourceFile({ path });
      return `${meta}:${hashContent(content)}`;
    } catch {
      return meta;
    }
  } catch {
    return "missing";
  }
}

export async function fingerprintLiveReloadResources(
  fileService: IFileService | undefined,
  paths: readonly string[],
): Promise<LiveReloadResources> {
  // 第一个是主 HTML
  const fingerprints = await Promise.all(
    paths.map((path, index) => fingerprintPath(fileService, path, index === 0)),
  );
  return {
    paths: new Map(paths.map((path) => [liveReloadPathKey(path), path])),
    fingerprints: new Map(
      paths.map((path, index) => [liveReloadPathKey(path), fingerprints[index]!]),
    ),
  };
}

/**
 * 这次目录变化是否动了页面资源。给了 changedPath 就直接查清单；没给（同一防抖窗口多个路径、
 * 平台没给文件名、目录被移走）时对该目录下的资源重新 stat，与加载时的指纹不同才算。
 */
export async function isLiveReloadResourceChange(
  event: FileWatchEvent,
  resources: LiveReloadResources,
  fileService: IFileService | undefined,
): Promise<boolean> {
  if (event.changedPath) {
    return (
      shouldLiveReloadForChange(event.changedPath) &&
      resources.paths.has(liveReloadPathKey(event.changedPath))
    );
  }
  // 拿不到 stat 时只能保守刷新
  if (!fileService) return true;
  const directoryKey = liveReloadPathKey(event.dirPath);
  const candidates = [...resources.paths].filter(([, path]) => {
    const directory = getContainingDirectoryPath(path);
    return directory !== null && liveReloadPathKey(directory) === directoryKey;
  });
  const mainKey = [...resources.paths.keys()][0];
  const current = await Promise.all(
    candidates.map(([key, path]) => fingerprintPath(fileService, path, key === mainKey)),
  );
  return candidates.some(([key], index) => resources.fingerprints.get(key) !== current[index]);
}

export interface BrowserLiveReloadWebview {
  reload(): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  addEventListener(type: "dom-ready", listener: () => void): void;
  removeEventListener(type: "dom-ready", listener: () => void): void;
}

function readScroll(value: unknown): { x: number; y: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)
    ? { x, y }
    : null;
}

/**
 * 只给人类用户的 tab 开（Agent tab 的页面状态由 Agent 控制，自动刷新会打断它的操作）。
 * 隐藏的 tab 只记下「有变化」，重新可见时再刷新一次，后台不反复 reload。
 * webview 被重建（webviewGeneration 变化）时 webview 引用随之变化，挂着的滚动恢复一并作废。
 * 每次页面 dom-ready（含自动刷新后）重新读资源清单与指纹，监听目录随之更新。
 */
export function useBrowserFileLiveReload({
  currentUrl,
  enabled,
  fileService,
  fileWatcherService,
  isOwnWrite,
  isVisible,
  webview,
}: {
  currentUrl: string;
  enabled: boolean;
  /** 主 HTML 的这次变化是不是设计工具自己写的（页面已经是写后的样子），是就不刷新 */
  isOwnWrite?: (path: string) => Promise<boolean>;
  fileService: IFileService | undefined;
  fileWatcherService: IFileWatcherService | undefined;
  isVisible: boolean;
  webview: BrowserLiveReloadWebview | null;
}): void {
  const filePath = enabled ? fileUrlToLocalPath(currentUrl) : null;
  const pendingRef = useRef(false);
  const reloadRef = useRef<() => void>(() => {});
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  const fileServiceRef = useRef(fileService);
  fileServiceRef.current = fileService;
  const isOwnWriteRef = useRef(isOwnWrite);
  isOwnWriteRef.current = isOwnWrite;
  const resourcesRef = useRef<LiveReloadResources | null>(null);
  /** 只读页面当前的资源路径，不 stat；用来认出页面 load 之后才 fetch / 懒加载的资源 */
  const readResourcePathsRef = useRef<() => Promise<string[]>>(async () => []);
  const [watchDirectories, setWatchDirectories] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!webview) {
      reloadRef.current = () => {};
      return;
    }
    let disposed = false;
    let restoreListener: (() => void) | null = null;
    const clearRestoreListener = () => {
      if (restoreListener) webview.removeEventListener("dom-ready", restoreListener);
      restoreListener = null;
    };
    reloadRef.current = () => {
      pendingRef.current = false;
      void webview
        .executeJavaScript(READ_SCROLL_SCRIPT)
        .catch(() => null)
        .then((value) => {
          if (disposed) return;
          const scroll = readScroll(value);
          clearRestoreListener();
          if (scroll && (scroll.x !== 0 || scroll.y !== 0)) {
            const listener = () => {
              clearRestoreListener();
              void webview
                .executeJavaScript(buildRestoreScrollScript(scroll.x, scroll.y))
                .catch(() => {});
            };
            restoreListener = listener;
            webview.addEventListener("dom-ready", listener);
          }
          safeWebviewCall(() => webview.reload(), undefined);
        });
    };
    return () => {
      disposed = true;
      clearRestoreListener();
      reloadRef.current = () => {};
    };
  }, [webview]);

  useEffect(() => {
    if (!webview || !filePath) {
      resourcesRef.current = null;
      readResourcePathsRef.current = async () => [];
      setWatchDirectories([]);
      return;
    }
    let disposed = false;
    let generation = 0;
    const apply = async (urls: unknown) => {
      const current = ++generation;
      const paths = collectLiveReloadResourcePaths(filePath, urls);
      const resources = await fingerprintLiveReloadResources(fileServiceRef.current, paths);
      if (disposed || current !== generation) return;
      resourcesRef.current = resources;
      const directories = resolveLiveReloadWatchDirectories(paths);
      setWatchDirectories((previous) =>
        previous.length === directories.length &&
        previous.every((directory, index) => directory === directories[index])
          ? previous
          : directories,
      );
    };
    const collect = () =>
      webview
        .executeJavaScript(COLLECT_RESOURCES_SCRIPT)
        .catch(() => null)
        .then((urls) => (disposed ? undefined : apply(urls)));
    // 页面还没报资源前先只认主 HTML
    void apply(null);
    void collect();
    const handleDomReady = () => void collect();
    webview.addEventListener("dom-ready", handleDomReady);
    readResourcePathsRef.current = () =>
      webview
        .executeJavaScript(READ_RESOURCES_NOW_SCRIPT)
        .catch(() => null)
        .then((urls) => collectLiveReloadResourcePaths(filePath, urls));
    return () => {
      disposed = true;
      webview.removeEventListener("dom-ready", handleDomReady);
      readResourcePathsRef.current = async () => [];
    };
  }, [filePath, webview]);

  useEffect(() => {
    if (watchDirectories.length === 0 || !fileWatcherService) return;
    let cancelled = false;
    const watcherIds: string[] = [];
    const subscriptions: { dispose(): void }[] = [];
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReload = () => {
      pendingRef.current = true;
      if (!isVisibleRef.current) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (!cancelled && isVisibleRef.current && pendingRef.current) reloadRef.current();
      }, LIVE_RELOAD_DEBOUNCE_MS);
    };
    const handleChange = async (event: FileWatchEvent) => {
      const resources = resourcesRef.current;
      if (!resources) return;
      if (await isLiveReloadResourceChange(event, resources, fileServiceRef.current)) {
        if (cancelled) return;
        const mainFilePath = [...resources.paths.values()][0];
        const mainKey = mainFilePath === undefined ? null : liveReloadPathKey(mainFilePath);
        // Bugfix（!3450 CR-01）：没有 changedPath 的合并事件（同一防抖窗口改了多个文件、tmp + rename）以前直接当成
        // 「主 HTML 变了」，主 HTML 又正好是自己写的那份，就把一起改了的 CSS / JS 也吞掉不刷新。
        // 现在重新算全部资源的指纹，只有「变的只有主 HTML、且是本 tab 自己写的」才跳过刷新。
        const refreshed = await fingerprintLiveReloadResources(fileServiceRef.current, [
          ...resources.paths.values(),
        ]);
        if (cancelled) return;
        const changedKeys = event.changedPath
          ? [liveReloadPathKey(event.changedPath)]
          : [...refreshed.fingerprints].flatMap(([key, fingerprint]) =>
              resources.fingerprints.get(key) === fingerprint ? [] : [key],
            );
        const onlyMainChanged =
          mainKey !== null && changedKeys.length > 0 && changedKeys.every((key) => key === mainKey);
        // 同一次写入的重复通知：主 HTML 的指纹（含内容哈希）和上次记下的一样，内容没变，不刷新也不再问是不是自写
        // （自写记录对上一次就消费掉，重复问会被当成外部改动）
        const mainFingerprint = mainKey === null ? undefined : refreshed.fingerprints.get(mainKey);
        if (
          onlyMainChanged &&
          mainKey !== null &&
          mainFingerprint !== undefined &&
          mainFingerprint !== "unknown" &&
          mainFingerprint !== "missing" &&
          mainFingerprint === resources.fingerprints.get(mainKey)
        ) {
          return;
        }
        if (mainFilePath && onlyMainChanged && (await isOwnWriteRef.current?.(mainFilePath))) {
          // 设计工具写回的改动：页面已经是这个样子，不刷新（选中和滚动位置不丢）。
          // 只把主 HTML 的指纹换成写后的（!3450 SG-01）：其他资源这时可能已被改、事件还没到，
          // 一起换掉会让那次改动在之后的比对里被当成「没变」。
          const fingerprint = refreshed.fingerprints.get(mainKey);
          if (!cancelled && resourcesRef.current === resources && fingerprint !== undefined) {
            const fingerprints = new Map(resources.fingerprints);
            fingerprints.set(mainKey, fingerprint);
            resourcesRef.current = { ...resources, fingerprints };
          }
          return;
        }
        if (!cancelled) scheduleReload();
        return;
      }
      // 资源目录里出现清单外的文件：可能是页面 load 后才请求的资源，读一次当前清单再判断。
      const changedPath = event.changedPath;
      if (!changedPath || cancelled || !shouldLiveReloadForChange(changedPath)) return;
      const changedKey = liveReloadPathKey(changedPath);
      const paths = await readResourcePathsRef.current();
      if (!cancelled && paths.some((path) => liveReloadPathKey(path) === changedKey)) {
        scheduleReload();
      }
    };

    for (const directory of watchDirectories) {
      void fileWatcherService
        .watch({ path: directory, recursive: false })
        .then(({ id }) => {
          if (cancelled) {
            void fileWatcherService.unwatch({ id });
            return;
          }
          watcherIds.push(id);
          subscriptions.push(
            fileWatcherService.onDynamicChange(id)((event) => void handleChange(event)),
          );
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          // 自动刷新只是便利功能；监听失败时页面照常可用，用户仍可手动刷新。
          logger.warn("[browser-use] 监听本地页面资源目录失败，该目录的自动刷新不可用", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const subscription of subscriptions) subscription.dispose();
      for (const id of watcherIds) void fileWatcherService.unwatch({ id }).catch(() => {});
    };
    // setWatchDirectories 在内容不变时保留旧数组，dom-ready 重读不会重建 watcher
  }, [watchDirectories, fileWatcherService]);

  useEffect(() => {
    pendingRef.current = false;
  }, [filePath]);

  useEffect(() => {
    if (isVisible && pendingRef.current) reloadRef.current();
  }, [isVisible]);
}
