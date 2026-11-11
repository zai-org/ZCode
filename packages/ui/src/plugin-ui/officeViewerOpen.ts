import { pluginUiPages } from "@/plugin-ui/adapters/pluginUiPageRegistry.js";
import { logger } from "@/logger.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { decodeFilePathUriEscapes, isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";

/**
 * `.xlsx` 文件打开到内置查看面板的路由表：扩展名 → 插件 surface。
 * 这是 UI 层数据驱动的常量，排在插件清单声明的查看器（file.viewer）之前；两者在
 * hooks/useAppPanels.ts 的文件路由里合并（docs/plugins/extension-host.md §16.5），
 * 本模块不依赖 extension-slots。待开文档的排队与 open_document 投递两个来源共用。
 * 产品边界（入口范围、回退语义）见 docs/ui/office-file-preview.md 入口路由章节。
 */
const OFFICE_VIEWER_SURFACE_ROUTES = [
  {
    extensions: [".xlsx"],
    pluginId: "spreadsheets@zcode-plugins-official",
    surfaceId: "spreadsheets",
  },
] as const;

export type OfficeViewerSurfaceRoute = (typeof OFFICE_VIEWER_SURFACE_ROUTES)[number];

const OFFICE_VIEWER_ROUTE_BY_EXTENSION = new Map<string, OfficeViewerSurfaceRoute>(
  OFFICE_VIEWER_SURFACE_ROUTES.flatMap((route) =>
    route.extensions.map((extension) => [extension, route] as const),
  ),
);

export function matchOfficeViewerSurfaceRoute(path: string): OfficeViewerSurfaceRoute | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return OFFICE_VIEWER_ROUTE_BY_EXTENSION.get(path.slice(dot).toLowerCase()) ?? null;
}

/**
 * 严格把文件路径解析为工作区相对 posix 路径；路径不在工作区内（工作区外文件、
 * 跨工作区路径、`..` 越界）返回 null，绝不退化为文件名——open_document 以当前
 * 工作区为根解析，文件名退化会让工作区外的 report.xlsx 静默打开成工作区内同名
 * 的另一份文件（成功打开不触发回退，比报错更糟）。
 * 路径语义对齐 PreviewPane 读取链：URI 转义还原 + 相对路径 join 工作区。
 */
export function resolveOfficeViewerDocumentPath(params: {
  workspacePath: string;
  filePath: string;
}): string | null {
  const decoded = decodeFilePathUriEscapes(params.filePath.trim());
  if (!decoded || decoded.includes("\0")) return null;
  const absolute = isAbsoluteFilePath(decoded)
    ? decoded
    : joinFilePath(params.workspacePath, decoded);
  // 归一规则与 workspace-file-tree/model.ts 的 normalizeForRelativePath 一致：反斜杠统一、去尾斜杠。
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
  const workspace = normalize(params.workspacePath);
  const target = normalize(absolute);
  if (target === workspace) return null;
  if (!target.startsWith(`${workspace}/`)) return null;
  const relative = target.slice(workspace.length + 1);
  return relative.startsWith("../") || relative.includes("/../") ? null : relative;
}

/** 面板就绪等待上限；超时说明沙箱或插件 server 未起来，回退 Preview Pane 旧链路。 */
const OFFICE_VIEWER_PANEL_READY_TIMEOUT_MS = 30_000;
/** office 查看面板加载工作区文件的工具；server 侧按 workspace 相对路径解析并校验越界。 */
const OFFICE_VIEWER_OPEN_DOCUMENT_TOOL = "open_document";

interface OfficeViewerPendingOpen {
  seq: number;
  relativePath: string;
  source: CodeViewerSource;
  onFallback: () => void;
}

const pendingByTabId = new Map<string, OfficeViewerPendingOpen>();
const pendingListenersByTabId = new Map<string, Set<() => void>>();
let pendingSeq = 0;
/** 每个 tab 最近一次排队的序号；open_document 返回时已被更新的请求整体丢弃（成功不回投、失败不回退）。 */
const latestSeqByTabId = new Map<string, number>();

function notifyPendingListeners(tabId: string): void {
  for (const listener of pendingListenersByTabId.get(tabId) ?? []) listener();
}

/**
 * 记录「面板 tab 打开后要加载的文件」。面板侧在页面 running 时经
 * subscribeOfficeViewerPendingOpen 消费；超时未被消费则回退旧链路。
 */
export function queueOfficeViewerPendingOpen(params: {
  tabId: string;
  relativePath: string;
  source: CodeViewerSource;
  onFallback: () => void;
}): void {
  const seq = ++pendingSeq;
  pendingByTabId.set(params.tabId, {
    seq,
    relativePath: params.relativePath,
    source: params.source,
    onFallback: params.onFallback,
  });
  latestSeqByTabId.set(params.tabId, seq);
  // 超时后 seq 不匹配（已被消费或覆盖）则自然空转，无需额外取消。
  setTimeout(() => {
    const pending = pendingByTabId.get(params.tabId);
    if (!pending || pending.seq !== seq) return;
    pendingByTabId.delete(params.tabId);
    logger.warn("[office-viewer] 面板就绪超时，回退 Preview Pane 预览", {
      path: pending.relativePath,
    });
    pending.onFallback();
  }, OFFICE_VIEWER_PANEL_READY_TIMEOUT_MS);
  notifyPendingListeners(params.tabId);
}

/** 面板侧订阅本 tab 的待开文件；订阅时立即投递一次当前值。 */
export function subscribeOfficeViewerPendingOpen(tabId: string, listener: () => void): () => void {
  const listeners = pendingListenersByTabId.get(tabId) ?? new Set();
  listeners.add(listener);
  pendingListenersByTabId.set(tabId, listeners);
  listener();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) pendingListenersByTabId.delete(tabId);
  };
}

/**
 * 面板页面 running 后调用：以待开文件驱动 `open_document`，成功结果经面板
 * 通知通道回投（面板按既有快照逻辑加载，office-runtime 零改动）。
 * 页面未就绪时保留待开项，等下一次触发；返回是否发起了调用。
 */
export function deliverOfficeViewerDocumentIfReady(tabId: string, pageKey: string): boolean {
  const pending = pendingByTabId.get(tabId);
  if (!pending) return false;
  const page = pluginUiPages.get(pageKey);
  // notifyToolResult 在 attached 前会静默丢弃，必须等 phase=running。
  if (!page || page.snapshot().phase !== "running") return false;
  // 原子取走：重复触发（phase 抖动、重订阅）不会二次打开。
  pendingByTabId.delete(tabId);
  const { seq, relativePath, onFallback, source } = pending;
  void (async () => {
    try {
      const result = await page.callPanelTool(OFFICE_VIEWER_OPEN_DOCUMENT_TOOL, {
        path: relativePath,
      });
      if (latestSeqByTabId.get(tabId) !== seq) return;
      if (result.isError) {
        logger.warn("[office-viewer] open_document 失败，回退 Preview Pane 预览", {
          path: relativePath,
          source,
        });
        onFallback();
        return;
      }
      page.notifyPanelToolResult(result);
    } catch (error) {
      if (latestSeqByTabId.get(tabId) !== seq) return;
      logger.warn("[office-viewer] open_document 调用异常，回退 Preview Pane 预览", {
        path: relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
      onFallback();
    }
  })();
  return true;
}
