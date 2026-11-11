"use client";

import type {
  ComponentProps,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftFromLine,
  ArrowRightToLine,
  CopyIcon,
  DownloadIcon,
  Maximize2Icon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type MarkdownTableNodeProp = {
  node?: unknown;
};

type MarkdownTableEdgeShadowState = "none" | "left" | "right" | "both";

export type MarkdownTableRows = string[][];

type MarkdownTableFrameDistances = {
  leftDistance: number;
  maxLeftOffset: number;
  scrollbarWidth: number;
  rightDistance: number;
  maxViewportWidth: number;
};

type MarkdownTableVirtualScrollbarMetrics = {
  contentWidth: number;
  thumbLeft: number;
  thumbWidth: number;
};

type MarkdownTableObservedRect = {
  left: number;
  right: number;
  width: number;
};

const MARKDOWN_TABLE_ROOT_SELECTOR =
  '[data-markdown-table-layout-root="true"], [data-testid="chat-view"]';
const MARKDOWN_TABLE_STICKY_DISABLED_SELECTOR = '[data-markdown-table-sticky-scrollbar="disabled"]';
const MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR = '[data-v4-composer-dock="true"]';
const MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_SELECTOR =
  '[data-v4-back-to-bottom-anchor="composer-dock"] button';
const MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_GAP_PX = 8;
const MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX = 32;
const MARKDOWN_TABLE_CONTENT_PADDING_LG_PX = 16;
const MARKDOWN_TABLE_CONTENT_PADDING_MD_PX = 8;
const MARKDOWN_TABLE_STICKY_SCROLLBAR_HEIGHT_RATIO = 0.8;
const MARKDOWN_TABLE_LAYOUT_LEFT_INSET_PROPERTY = "--markdown-table-layout-left-inset";
const MARKDOWN_TABLE_LAYOUT_RIGHT_INSET_PROPERTY = "--markdown-table-layout-right-inset";

function normalizeTableCellText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function escapeCsvCell(value: string): string {
  // assistant markdown 属于不可信输入，CSV 被 Excel/Numbers/LibreOffice
  // 打开时会解释公式前缀。下载前统一把公式型单元格降级成纯文本。
  const safeValue = /^[\t\r\n]/u.test(value) || /^[\s]*[=+\-@]/u.test(value) ? `'${value}` : value;

  if (!/[",\r\n]/u.test(safeValue)) {
    return safeValue;
  }

  return `"${safeValue.replace(/"/g, '""')}"`;
}

export function buildMarkdownTableText(rows: MarkdownTableRows): string {
  if (rows.length === 0) {
    return "";
  }

  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => escapeMarkdownTableCell(row[index] ?? "")),
  );
  const header = normalizedRows[0] ?? [];
  const separator = Array.from({ length: columnCount }, () => "---");
  const body = normalizedRows.slice(1);

  return [header, separator, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

export function buildCsvTableText(rows: MarkdownTableRows): string {
  const csv = rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")).join("\r\n");
  // Blob 的 charset 不会写入文件字节，Excel 会把无 BOM 的 UTF-8 CSV
  // 按本地代码页解析，导致中文乱码；显式添加 UTF-8 BOM 让表格软件可靠识别编码。
  return `\uFEFF${csv}`;
}

function readRowsFromTable(table: HTMLTableElement | null): MarkdownTableRows {
  if (!table) {
    return [];
  }

  return Array.from(table.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.querySelectorAll("th,td")).map((cell) =>
        normalizeTableCellText(cell.textContent ?? ""),
      ),
    )
    .filter((row) => row.length > 0);
}

function resolveMarkdownTableRoot(
  frame: HTMLElement | null,
  fallbackRoot: HTMLElement | null,
): HTMLElement | null {
  // V4 删除旧 ChatView 后不再渲染 data-testid="chat-view"，表格会退回自身宽度，
  // 因而误判增强横向滚动没有收益。优先使用跨版本的显式布局边界，旧选择器只保留兼容。
  return frame?.closest<HTMLElement>(MARKDOWN_TABLE_ROOT_SELECTOR) ?? fallbackRoot;
}

function getMarkdownTableContentInlineInsetPx() {
  if (typeof window === "undefined") {
    return MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX;
  }

  // 表格宽度借用 ChatView root 右侧空间时，需要扣掉消息列本身的响应式右 padding。
  // 对应 ChatConversationContent 的 px-8 max-lg:px-4 max-md:px-2。
  if (window.innerWidth < 768) {
    return MARKDOWN_TABLE_CONTENT_PADDING_MD_PX;
  }

  if (window.innerWidth < 1024) {
    return MARKDOWN_TABLE_CONTENT_PADDING_LG_PX;
  }

  return MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX;
}

function getMarkdownTableRootInlineInsets(root: HTMLElement) {
  if (typeof window !== "undefined" && root.matches('[data-markdown-table-layout-root="true"]')) {
    return {
      leftInset: readCssPixelValue(root, MARKDOWN_TABLE_LAYOUT_LEFT_INSET_PROPERTY),
      rightInset: readCssPixelValue(root, MARKDOWN_TABLE_LAYOUT_RIGHT_INSET_PROPERTY),
    };
  }

  const legacyInset = getMarkdownTableContentInlineInsetPx();
  return { leftInset: legacyInset, rightInset: legacyInset };
}

function readMarkdownTableObservedRect(
  element: HTMLElement | null,
): MarkdownTableObservedRect | null {
  if (!element) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  return {
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    width: Math.round(rect.width),
  };
}

function isMarkdownTableObservedRectEqual(
  leftRect: MarkdownTableObservedRect | null,
  rightRect: MarkdownTableObservedRect | null,
) {
  return (
    leftRect?.left === rightRect?.left &&
    leftRect?.right === rightRect?.right &&
    leftRect?.width === rightRect?.width
  );
}

function readCssPixelValue(element: HTMLElement | null, propertyName: string) {
  if (!element || typeof window === "undefined") {
    return 0;
  }

  const value = window.getComputedStyle(element).getPropertyValue(propertyName);
  const parsedValue = Number.parseFloat(value);
  return Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 0;
}

function readMarkdownTableDockHeight(root: HTMLElement | null) {
  const legacyDockHeight = readCssPixelValue(root, "--chat-bottom-dock-height");
  if (legacyDockHeight > 0) return legacyDockHeight;

  // V4 composer dock 位于 timeline 滚动视口内部，但不再设置旧 ChatView 的
  // CSS 变量。直接读取真实 dock 高度，避免吸底滚动条被输入区覆盖。
  return (
    root
      ?.querySelector<HTMLElement>(MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR)
      ?.getBoundingClientRect().height ?? 0
  );
}

function readMarkdownTableBackToBottomClearance(root: HTMLElement | null) {
  const button = root?.querySelector<HTMLElement>(MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_SELECTOR);
  if (!button) return 0;

  return button.getBoundingClientRect().height + MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_GAP_PX;
}

function resolveMarkdownTableVerticalViewport(
  element: HTMLElement | null,
  fallbackRoot: HTMLElement | null,
): HTMLElement | null {
  if (typeof window === "undefined") {
    return fallbackRoot;
  }

  let currentElement = element?.parentElement ?? null;
  while (currentElement) {
    const style = window.getComputedStyle(currentElement);
    const canScrollY = /auto|scroll|overlay/u.test(style.overflowY);
    // 横向滚动 viewport 因 overflow-x-auto 可能让浏览器把 overflow-y 计算成 auto；
    // 如果不确认真的存在纵向滚动空间，短表格会把自身高度误当成可视区域高度，导致 80% 判定永远成立。
    const hasVerticalScrollRange = currentElement.scrollHeight > currentElement.clientHeight + 1;
    if (canScrollY && currentElement.clientHeight > 0 && hasVerticalScrollRange) {
      return currentElement;
    }
    currentElement = currentElement.parentElement;
  }

  return fallbackRoot;
}

export function resolveMarkdownTableStickyScrollbarMode({
  stickyScrollbarDisabled,
  viewportHeight,
  dockHeight,
  tableHeight,
}: {
  stickyScrollbarDisabled: boolean;
  viewportHeight: number;
  dockHeight: number;
  tableHeight: number;
}) {
  if (stickyScrollbarDisabled) {
    return false;
  }

  const visibleHeight = Math.max(0, viewportHeight - dockHeight);
  return (
    visibleHeight > 0 && tableHeight > visibleHeight * MARKDOWN_TABLE_STICKY_SCROLLBAR_HEIGHT_RATIO
  );
}

export function resolveMarkdownTableStickyScrollbarOffset({
  frameTop,
  frameBottom,
  scrollbarHeight,
  viewportBottom,
}: {
  frameTop: number;
  frameBottom: number;
  scrollbarHeight: number;
  viewportBottom: number;
}) {
  const minimumBottom = Math.min(frameBottom, frameTop + Math.max(0, scrollbarHeight));
  const pinnedBottom = Math.min(frameBottom, Math.max(minimumBottom, viewportBottom));
  return Math.min(0, pinnedBottom - frameBottom);
}

function shouldUseMarkdownTableStickyScrollbar({
  root,
  table,
}: {
  root: HTMLElement | null;
  table: HTMLTableElement | null;
}) {
  if (!table) {
    return false;
  }

  const viewport = resolveMarkdownTableVerticalViewport(table, root);
  const viewportHeight =
    viewport?.clientHeight ||
    viewport?.getBoundingClientRect().height ||
    (typeof window === "undefined" ? 0 : window.innerHeight);
  const dockHeight = readMarkdownTableDockHeight(root);
  const tableHeight = table.getBoundingClientRect().height;

  // subagent prompt/output 会继承会话 dock 高度；如果也启用 sticky，虚拟滚动条会在
  // 嵌套容器内错误上抬到表格中段。显式 opt-out 不依赖容器当前是否已经产生纵向 overflow。
  return resolveMarkdownTableStickyScrollbarMode({
    stickyScrollbarDisabled: table.closest(MARKDOWN_TABLE_STICKY_DISABLED_SELECTOR) !== null,
    viewportHeight,
    dockHeight,
    tableHeight,
  });
}

export function resolveMarkdownTableFrameDistances({
  frameWidth,
  frameLeft,
  frameRight,
  rootLeft,
  rootRight,
  leftInset = 0,
  rightInset = 0,
}: {
  frameWidth: number;
  frameLeft: number;
  frameRight: number;
  rootLeft: number;
  rootRight: number;
  leftInset?: number;
  rightInset?: number;
}): MarkdownTableFrameDistances {
  const leftDistance = Math.max(0, frameLeft - rootLeft);
  const rightDistance = Math.max(0, rootRight - frameRight);
  const maxLeftOffset = Math.max(0, leftDistance - leftInset);
  const scrollbarWidth = Math.max(0, frameWidth + rightDistance - rightInset);

  return {
    leftDistance,
    maxLeftOffset,
    scrollbarWidth,
    rightDistance,
    maxViewportWidth: scrollbarWidth,
  };
}

export function resolveMarkdownTableVirtualScrollbarMetrics({
  scrollLeft,
  scrollMax,
  tableWidth,
  trackWidth,
}: {
  scrollLeft: number;
  scrollMax: number;
  tableWidth: number;
  trackWidth: number;
}): MarkdownTableVirtualScrollbarMetrics {
  const safeTableWidth = Math.max(0, tableWidth);
  const safeTrackWidth = Math.max(0, trackWidth);
  const safeScrollMax = Math.max(0, scrollMax);
  const contentWidth = Math.max(safeTrackWidth, safeTableWidth);

  if (safeTrackWidth <= 0 || safeScrollMax <= 1 || safeTableWidth <= safeTrackWidth) {
    return {
      contentWidth: safeTrackWidth,
      thumbLeft: 0,
      thumbWidth: safeTrackWidth,
    };
  }

  const thumbWidth = Math.min(
    safeTrackWidth,
    Math.max(0, safeTrackWidth * (safeTrackWidth / safeTableWidth)),
  );
  const maxThumbLeft = Math.max(0, safeTrackWidth - thumbWidth);
  const thumbLeft = Math.min(
    maxThumbLeft,
    Math.max(0, Math.max(0, scrollLeft) * (safeTrackWidth / safeTableWidth)),
  );

  return {
    contentWidth,
    thumbLeft,
    thumbWidth,
  };
}

export function resolveMarkdownTableVirtualScrollMax({
  tableWidth,
  trackWidth,
}: {
  tableWidth: number;
  trackWidth: number;
}): number {
  return Math.max(0, tableWidth - trackWidth);
}

export type MarkdownTableProps = ComponentProps<"table"> & MarkdownTableNodeProp;

export function MarkdownTable({ className, children, node: _node, ...props }: MarkdownTableProps) {
  const { intl } = useZCodeIntl();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [expandedScrollEnabled, setExpandedScrollEnabled] = useState(false);
  const [canToggleExpandedScroll, setCanToggleExpandedScroll] = useState(false);
  const [edgeShadowState, setEdgeShadowState] = useState<MarkdownTableEdgeShadowState>("none");
  const [viewportMaxWidth, setViewportMaxWidth] = useState<string>("100%");
  const [scrollbarWidth, setScrollbarWidth] = useState<string>("100%");
  const [viewportLeftOffset, setViewportLeftOffset] = useState(0);
  const [virtualScrollbarSticky, setVirtualScrollbarSticky] = useState(false);
  const [virtualScrollbarVisible, setVirtualScrollbarVisible] = useState(false);
  const edgeShadowStateRef = useRef<MarkdownTableEdgeShadowState>("none");
  const expandedScrollEnabledRef = useRef(expandedScrollEnabled);
  const canToggleExpandedScrollRef = useRef(canToggleExpandedScroll);
  const viewportMaxWidthRef = useRef(viewportMaxWidth);
  const scrollbarWidthRef = useRef(scrollbarWidth);
  const viewportLeftOffsetRef = useRef(viewportLeftOffset);
  const virtualScrollbarStickyRef = useRef(virtualScrollbarSticky);
  const virtualScrollbarVisibleRef = useRef(virtualScrollbarVisible);
  const maxViewportLeftOffsetRef = useRef(0);
  const virtualScrollTrackWidthRef = useRef(0);
  const virtualScrollLeftRef = useRef(0);
  const virtualScrollThumbLeftRef = useRef(0);
  const virtualScrollThumbRef = useRef<HTMLDivElement | null>(null);
  const contentWidthRef = useRef<HTMLDivElement | null>(null);
  const widthMotionRef = useRef<ReturnType<typeof prepareTableWidthMotion> | null>(null);
  const isVirtualScrollbarDraggingRef = useRef(false);
  const virtualScrollbarDragOffsetRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const virtualScrollTrackRef = useRef<HTMLDivElement | null>(null);
  const virtualScrollbarWrapperRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const setNextEdgeShadowState = useCallback(
    (nextEdgeShadowState: MarkdownTableEdgeShadowState) => {
      if (edgeShadowStateRef.current === nextEdgeShadowState) {
        return;
      }

      edgeShadowStateRef.current = nextEdgeShadowState;
      setEdgeShadowState(nextEdgeShadowState);
    },
    [],
  );
  const commitExpandedScrollEnabled = useCallback((nextExpandedScrollEnabled: boolean) => {
    if (expandedScrollEnabledRef.current === nextExpandedScrollEnabled) {
      return;
    }

    expandedScrollEnabledRef.current = nextExpandedScrollEnabled;
    setExpandedScrollEnabled(nextExpandedScrollEnabled);
  }, []);
  const commitCanToggleExpandedScroll = useCallback((nextCanToggleExpandedScroll: boolean) => {
    if (canToggleExpandedScrollRef.current === nextCanToggleExpandedScroll) {
      return;
    }

    canToggleExpandedScrollRef.current = nextCanToggleExpandedScroll;
    setCanToggleExpandedScroll(nextCanToggleExpandedScroll);
  }, []);
  const commitViewportMaxWidth = useCallback((nextViewportMaxWidth: string) => {
    if (viewportMaxWidthRef.current === nextViewportMaxWidth) {
      return;
    }

    viewportMaxWidthRef.current = nextViewportMaxWidth;
    setViewportMaxWidth(nextViewportMaxWidth);
  }, []);
  const commitScrollbarWidth = useCallback((nextScrollbarWidth: string) => {
    if (scrollbarWidthRef.current === nextScrollbarWidth) {
      return;
    }

    scrollbarWidthRef.current = nextScrollbarWidth;
    setScrollbarWidth(nextScrollbarWidth);
  }, []);
  const commitViewportLeftOffset = useCallback((nextViewportLeftOffset: number) => {
    if (viewportLeftOffsetRef.current === nextViewportLeftOffset) {
      return;
    }

    // 横向借位必须与指针同步；模式动画尚未结束时开始滚动，也不能让宽度继续追赶。
    if (nextViewportLeftOffset > 0) widthMotionRef.current?.dispose();
    viewportLeftOffsetRef.current = nextViewportLeftOffset;
    setViewportLeftOffset(nextViewportLeftOffset);
  }, []);
  const commitVirtualScrollbarSticky = useCallback((nextVirtualScrollbarSticky: boolean) => {
    if (virtualScrollbarStickyRef.current === nextVirtualScrollbarSticky) {
      return;
    }

    virtualScrollbarStickyRef.current = nextVirtualScrollbarSticky;
    setVirtualScrollbarSticky(nextVirtualScrollbarSticky);
  }, []);
  const commitVirtualScrollbarVisible = useCallback((nextVirtualScrollbarVisible: boolean) => {
    if (virtualScrollbarVisibleRef.current === nextVirtualScrollbarVisible) {
      return;
    }

    virtualScrollbarVisibleRef.current = nextVirtualScrollbarVisible;
    setVirtualScrollbarVisible(nextVirtualScrollbarVisible);
  }, []);
  const commitVirtualScrollThumbStyle = useCallback(
    (nextStyle: { transform: string; width: string }) => {
      // thumb 几何每帧变化，但不改变表格业务状态；直接更新该节点，避免重渲染整张表及工具栏。
      const thumb = virtualScrollThumbRef.current;
      if (!thumb) return;
      if (thumb.style.width !== nextStyle.width) thumb.style.width = nextStyle.width;
      if (thumb.style.transform !== nextStyle.transform)
        thumb.style.transform = nextStyle.transform;
    },
    [],
  );
  const resolveTableWidth = useCallback((viewport: HTMLDivElement) => {
    return tableRef.current?.getBoundingClientRect().width ?? viewport.scrollWidth;
  }, []);
  const resolveVirtualScrollLayoutWidth = useCallback((viewport: HTMLDivElement) => {
    return virtualScrollTrackWidthRef.current || viewport.clientWidth;
  }, []);
  const resolveRenderedVirtualScrollTrackWidth = useCallback(
    (viewport: HTMLDivElement) => {
      const trackWidth = virtualScrollTrackRef.current?.getBoundingClientRect().width ?? 0;
      if (trackWidth > 0) {
        return trackWidth;
      }

      return resolveVirtualScrollLayoutWidth(viewport);
    },
    [resolveVirtualScrollLayoutWidth],
  );
  const resolveVirtualScrollMax = useCallback(
    (viewport: HTMLDivElement) => {
      // 虚拟滚动的总距离只应由 table 标签本身宽度减去滚动条槽宽决定；
      // 之前混入 viewportLeftOffset 后，向左借位会改变最大值，导致 thumb 和内容滚动进度不一致。
      // 条件挂载后的 DOM track 会使用 CSS 宽度；若它与未挂载时保存的浮点布局宽度精度不同，
      // 可见性会在同一阈值两侧往返。是否 overflow 必须始终读取同一轮稳定的布局槽宽。
      return resolveMarkdownTableVirtualScrollMax({
        tableWidth: resolveTableWidth(viewport),
        trackWidth: resolveVirtualScrollLayoutWidth(viewport),
      });
    },
    [resolveTableWidth, resolveVirtualScrollLayoutWidth],
  );
  const commitVirtualScrollLeft = useCallback(
    (nextVirtualScrollLeft: number) => {
      const viewport = scrollViewportRef.current;
      if (!viewport) {
        virtualScrollLeftRef.current = 0;
        return;
      }

      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      const clampedVirtualScrollLeft = Math.min(
        Math.max(0, nextVirtualScrollLeft),
        virtualScrollMax,
      );
      const nextViewportLeftOffset = Math.min(
        clampedVirtualScrollLeft,
        maxViewportLeftOffsetRef.current,
      );
      const nextViewportScrollLeft = clampedVirtualScrollLeft - nextViewportLeftOffset;

      virtualScrollLeftRef.current = clampedVirtualScrollLeft;
      commitViewportLeftOffset(nextViewportLeftOffset);
      viewport.scrollLeft = nextViewportScrollLeft;
    },
    [commitViewportLeftOffset, resolveVirtualScrollMax],
  );
  const syncVirtualScrollMetrics = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) {
      commitVirtualScrollbarVisible(false);
      commitVirtualScrollThumbStyle({
        transform: "translateX(0px)",
        width: "100%",
      });
      virtualScrollLeftRef.current = 0;
      virtualScrollThumbLeftRef.current = 0;
      return;
    }

    const virtualScrollMax = resolveVirtualScrollMax(viewport);
    // 虚拟滚动条只在表格宽度超过可视槽时有意义；小表格如果也渲染 pill，
    // 会误导用户以为还有横向内容可滚。
    commitVirtualScrollbarVisible(virtualScrollMax > 1);
    const nextVirtualScrollLeft = viewportLeftOffsetRef.current + viewport.scrollLeft;
    const clampedVirtualScrollLeft = Math.min(Math.max(0, nextVirtualScrollLeft), virtualScrollMax);
    if (clampedVirtualScrollLeft !== nextVirtualScrollLeft) {
      // 状态面板收起/展开或窗口 resize 会改变槽宽，旧的虚拟滚动位置可能越过新边界。
      // 这里立即回写统一入口，避免 thumb 到边界而内容还停在旧的 DOM scrollLeft。
      commitVirtualScrollLeft(clampedVirtualScrollLeft);
      return;
    }

    virtualScrollLeftRef.current = clampedVirtualScrollLeft;
    // 已渲染 track 的实际宽度只用于 thumb 比例和位置，不能反向决定 track 是否挂载。
    const virtualScrollViewportWidth = resolveRenderedVirtualScrollTrackWidth(viewport);
    const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
      scrollLeft: clampedVirtualScrollLeft,
      scrollMax: virtualScrollMax,
      tableWidth: resolveTableWidth(viewport),
      trackWidth: virtualScrollViewportWidth,
    });
    commitVirtualScrollThumbStyle({
      transform: `translateX(${Math.round(metrics.thumbLeft)}px)`,
      width: `${Math.ceil(metrics.thumbWidth)}px`,
    });
    virtualScrollThumbLeftRef.current = metrics.thumbLeft;
  }, [
    commitVirtualScrollLeft,
    commitVirtualScrollbarVisible,
    commitVirtualScrollThumbStyle,
    resolveTableWidth,
    resolveVirtualScrollMax,
    resolveRenderedVirtualScrollTrackWidth,
  ]);
  const measureViewportMaxWidth = useCallback(() => {
    const frame = frameRef.current;
    const root = resolveMarkdownTableRoot(frame, rootRef.current);
    if (!frame) {
      commitViewportMaxWidth("100%");
      commitScrollbarWidth("100%");
      commitCanToggleExpandedScroll(false);
      commitVirtualScrollbarVisible(false);
      commitVirtualScrollbarSticky(false);
      maxViewportLeftOffsetRef.current = 0;
      virtualScrollTrackWidthRef.current = 0;
      commitViewportLeftOffset(0);
      return;
    }

    const frameRect = frame.getBoundingClientRect();
    let maxLeftOffset = 0;
    let maxViewportWidth = frameRect.width;
    let measuredScrollbarWidth = frameRect.width;
    let expandedMaxLeftOffset = 0;
    let expandedScrollbarWidth = frameRect.width;

    if (root) {
      const rootRect = root.getBoundingClientRect();
      // V4 的扩展边界是完整 timeline 视口而非居中的消息内容列；显式根节点
      // 通过 CSS 变量提供响应式安全边距，旧根节点继续保留原兼容规则。
      const { leftInset, rightInset } = getMarkdownTableRootInlineInsets(root);
      const measuredDistances = resolveMarkdownTableFrameDistances({
        frameWidth: frameRect.width,
        frameLeft: frameRect.left,
        frameRight: frameRect.right,
        rootLeft: rootRect.left,
        rootRight: rootRect.right,
        leftInset,
        rightInset,
      });
      expandedMaxLeftOffset = measuredDistances.maxLeftOffset;
      expandedScrollbarWidth = measuredDistances.scrollbarWidth;

      if (expandedScrollEnabledRef.current) {
        maxLeftOffset = measuredDistances.maxLeftOffset;
        maxViewportWidth = measuredDistances.maxViewportWidth;
        measuredScrollbarWidth = measuredDistances.scrollbarWidth;
      }
    }

    const tableWidth = tableRef.current?.getBoundingClientRect().width ?? 0;
    const hasFrameHorizontalOverflow = tableWidth > frameRect.width + 1;
    const hasExpandedScrollBenefit =
      expandedScrollbarWidth > frameRect.width + 1 || expandedMaxLeftOffset > 1;
    // 开关只在普通 frame 宽度下确实横向溢出，并且增强模式能提供额外可视宽度或左借位时才有意义；
    // 已开启时仍保留按钮，让用户可以收回到普通滚动范围。
    commitCanToggleExpandedScroll(
      expandedScrollEnabledRef.current || (hasFrameHorizontalOverflow && hasExpandedScrollBenefit),
    );

    maxViewportLeftOffsetRef.current = maxLeftOffset;
    virtualScrollTrackWidthRef.current = measuredScrollbarWidth;
    // 普通模式由 CSS 跟随 frame，避免“读像素 → React 提交 → 再启动宽度过渡”的逐帧反馈。
    commitViewportMaxWidth(
      expandedScrollEnabledRef.current ? `${Math.ceil(maxViewportWidth)}px` : "100%",
    );
    // 向上取整会让已挂载 track 比用于 overflow 判断的槽宽最多多 1px，
    // 子像素 overflow 恰好靠近 1px 阈值时会导致 track 每帧挂载/卸载并扰动 timeline 高度。
    commitScrollbarWidth(expandedScrollEnabledRef.current ? `${measuredScrollbarWidth}px` : "100%");
    commitVirtualScrollbarSticky(
      shouldUseMarkdownTableStickyScrollbar({
        root,
        table: tableRef.current,
      }),
    );
    if (scrollViewportRef.current) {
      commitVirtualScrollLeft(virtualScrollLeftRef.current);
    } else {
      commitViewportLeftOffset(Math.min(viewportLeftOffsetRef.current, maxLeftOffset));
    }
    syncVirtualScrollMetrics();
  }, [
    commitScrollbarWidth,
    commitCanToggleExpandedScroll,
    commitVirtualScrollLeft,
    commitVirtualScrollbarSticky,
    commitVirtualScrollbarVisible,
    commitViewportLeftOffset,
    commitViewportMaxWidth,
    syncVirtualScrollMetrics,
  ]);

  const measureEdgeShadowState = useCallback(() => {
    const viewport = scrollViewportRef.current;
    const table = tableRef.current;
    if (!viewport || !table) {
      setNextEdgeShadowState("none");
      return;
    }

    const maxScrollLeft = resolveVirtualScrollMax(viewport);
    if (maxScrollLeft <= 1) {
      setNextEdgeShadowState("none");
      return;
    }

    const currentVirtualScrollLeft = viewportLeftOffsetRef.current + viewport.scrollLeft;
    // 向左借位只是把表格区域扩到左侧，不代表表格内容已经在滚动容器左边被遮住；
    // 左侧阴影只应该在真实内部 scrollLeft 产生后出现，右侧阴影继续按虚拟总进度判断。
    const hasHiddenLeft = viewport.scrollLeft > 1;
    const hasHiddenRight = currentVirtualScrollLeft < maxScrollLeft - 1;
    setNextEdgeShadowState(
      hasHiddenLeft && hasHiddenRight
        ? "both"
        : hasHiddenLeft
          ? "left"
          : hasHiddenRight
            ? "right"
            : "none",
    );
  }, [resolveVirtualScrollMax, setNextEdgeShadowState]);
  const latestMeasureEdgeShadowStateRef = useRef(measureEdgeShadowState);

  useEffect(() => {
    latestMeasureEdgeShadowStateRef.current = measureEdgeShadowState;
  });

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const root = resolveMarkdownTableRoot(frame, rootRef.current);
    const viewport = scrollViewportRef.current;
    const table = tableRef.current;
    if (!root || !frame || !viewport || !table) {
      commitViewportMaxWidth("100%");
      commitScrollbarWidth("100%");
      return;
    }

    // 表格 viewport 需要先按内容自然宽度排布，再最多扩展到当前 frame 宽度
    // 加上右侧可借用空间；直接 w-full 会丢失小表格按内容收缩的布局语义。
    let rafId: number | null = null;
    let rectWatchRafId: number | null = null;
    let rectWatchUntil = 0;
    let latestRootRect = readMarkdownTableObservedRect(root);
    let latestFrameRect = readMarkdownTableObservedRect(frame);
    const scheduleMeasure = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestRootRect = readMarkdownTableObservedRect(root);
        latestFrameRect = readMarkdownTableObservedRect(frame);
        measureViewportMaxWidth();
        latestMeasureEdgeShadowStateRef.current();
      });
    };
    const watchRectChanges = () => {
      rectWatchRafId = null;
      const nextRootRect = readMarkdownTableObservedRect(root);
      const nextFrameRect = readMarkdownTableObservedRect(frame);
      const rectChanged =
        !isMarkdownTableObservedRectEqual(latestRootRect, nextRootRect) ||
        !isMarkdownTableObservedRectEqual(latestFrameRect, nextFrameRect);

      if (rectChanged) {
        widthMotionRef.current?.dispose();
        // status panel 收起/展开可能只改变 chat root 的 left/right 位置，
        // ResizeObserver 不一定会触发；轮询 rect 签名能让左右借位和滚动槽宽跟随布局动画更新。
        latestRootRect = nextRootRect;
        latestFrameRect = nextFrameRect;
        scheduleMeasure();
      }

      if (performance.now() < rectWatchUntil) {
        rectWatchRafId = requestAnimationFrame(watchRectChanges);
      }
    };
    const scheduleMeasureAndWatchRect = () => {
      scheduleMeasure();
      rectWatchUntil = performance.now() + 800;
      if (rectWatchRafId === null) {
        rectWatchRafId = requestAnimationFrame(watchRectChanges);
      }
    };
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleMeasureAndWatchRect);
    mutationObserver?.observe(root, {
      attributeFilter: ["style"],
      attributes: true,
    });

    measureViewportMaxWidth();
    scheduleMeasureAndWatchRect();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleMeasureAndWatchRect);
      return () => {
        window.removeEventListener("resize", scheduleMeasureAndWatchRect);
        mutationObserver?.disconnect();
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (rectWatchRafId !== null) cancelAnimationFrame(rectWatchRafId);
      };
    }

    const resizeObserver = new ResizeObserver(scheduleMeasureAndWatchRect);
    resizeObserver.observe(root);
    resizeObserver.observe(frame);
    resizeObserver.observe(viewport);
    resizeObserver.observe(table);
    window.addEventListener("resize", scheduleMeasureAndWatchRect);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasureAndWatchRect);
      mutationObserver?.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (rectWatchRafId !== null) cancelAnimationFrame(rectWatchRafId);
    };
  }, [commitScrollbarWidth, commitViewportMaxWidth, measureViewportMaxWidth]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    const table = tableRef.current;
    if (!viewport || !table) {
      setNextEdgeShadowState("none");
      return;
    }

    const updateViewportLayout = () => {
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    };
    const updateEdgeShadowState = () => {
      syncVirtualScrollMetrics();
      latestMeasureEdgeShadowStateRef.current();
    };
    const handleWheel = (event: WheelEvent) => {
      const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (horizontalDelta === 0) {
        return;
      }

      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      if (virtualScrollMax <= 1) {
        return;
      }

      event.preventDefault();
      // 向左借位和表格内容滚动原来各自维护位置，边界处会互相覆盖导致无法回滚；
      // 现在统一用虚拟 scrollLeft 映射：先消耗 leftOffset，再把剩余量交给真实 viewport.scrollLeft。
      commitVirtualScrollLeft(virtualScrollLeftRef.current + horizontalDelta);
      updateViewportLayout();
    };

    // root/frame 的尺寸 observer 已统一更新宽度、thumb 和阴影；这里仅处理用户滚动，
    // 不再为同一 viewport/table 再建 observer 并排一轮重复测量。
    updateEdgeShadowState();
    viewport.addEventListener("scroll", updateEdgeShadowState, {
      passive: true,
    });
    viewport.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      viewport.removeEventListener("scroll", updateEdgeShadowState);
      viewport.removeEventListener("wheel", handleWheel);
    };
  }, [
    commitVirtualScrollLeft,
    measureViewportMaxWidth,
    resolveVirtualScrollMax,
    setNextEdgeShadowState,
    syncVirtualScrollMetrics,
  ]);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const table = tableRef.current;
    const wrapper = virtualScrollbarWrapperRef.current;
    const root = resolveMarkdownTableRoot(frame, rootRef.current);
    if (!frame || !table || !wrapper || !virtualScrollbarSticky) {
      if (wrapper) wrapper.style.transform = "";
      return;
    }

    const verticalViewport = resolveMarkdownTableVerticalViewport(table, root);
    if (!verticalViewport) return;

    let rafId: number | null = null;
    let observedDock: HTMLElement | null = null;
    const updateStickyOffset = () => {
      rafId = null;
      const frameRect = frame.getBoundingClientRect();
      const viewportRect = verticalViewport.getBoundingClientRect();
      const dockHeight = readMarkdownTableDockHeight(root);
      // 离底时“回到底部”按钮位于 composer dock 上方；只扣 dock 会让长表
      // sticky 滚动条与按钮占用同一条水平带，导致按钮被宽滚动槽遮挡。
      const backToBottomClearance = readMarkdownTableBackToBottomClearance(root);
      const offset = resolveMarkdownTableStickyScrollbarOffset({
        frameTop: frameRect.top,
        frameBottom: frameRect.bottom,
        scrollbarHeight: wrapper.getBoundingClientRect().height,
        viewportBottom: viewportRect.bottom - dockHeight - backToBottomClearance,
      });
      wrapper.style.transform = offset === 0 ? "" : `translateY(${Math.round(offset)}px)`;
    };
    const scheduleStickyOffset = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(updateStickyOffset);
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleStickyOffset);
    const syncDockObservation = () => {
      const nextDock =
        root?.querySelector<HTMLElement>(MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR) ?? null;
      // MutationObserver 也负责感知 dock 内回到底部按钮的挂载/卸载；即使 dock
      // 节点本身未变化也必须安排一次几何更新。
      if (nextDock === observedDock) {
        scheduleStickyOffset();
        return;
      }
      if (observedDock) resizeObserver?.unobserve(observedDock);
      observedDock = nextDock;
      if (observedDock) resizeObserver?.observe(observedDock);
      scheduleStickyOffset();
    };

    // V4 virtual row 使用 transform 定位，原生 sticky 会被 transformed ancestor
    // 限制在自然位置。改为跟随 timeline scroll 计算纵向补偿，且仍受当前表格上下边界约束。
    updateStickyOffset();
    verticalViewport.addEventListener("scroll", scheduleStickyOffset, { passive: true });
    window.addEventListener("resize", scheduleStickyOffset);
    resizeObserver?.observe(frame);
    resizeObserver?.observe(verticalViewport);
    syncDockObservation();
    // draft/空态切换会条件挂载或替换 V4 composer dock；只观察初始节点会让
    // 新 dock 的输入增高不再触发吸底重算，因此同时跟踪根节点的子树变化并重新绑定。
    const dockMutationObserver =
      typeof MutationObserver === "undefined" || !root
        ? null
        : new MutationObserver(syncDockObservation);
    if (dockMutationObserver && root) {
      dockMutationObserver.observe(root, { childList: true, subtree: true });
    }

    return () => {
      verticalViewport.removeEventListener("scroll", scheduleStickyOffset);
      window.removeEventListener("resize", scheduleStickyOffset);
      resizeObserver?.disconnect();
      dockMutationObserver?.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      wrapper.style.transform = "";
    };
  }, [virtualScrollbarSticky, virtualScrollbarVisible]);

  const getRows = useCallback(() => readRowsFromTable(tableRef.current), []);
  const commitVirtualScrollLeftFromClientX = useCallback(
    (clientX: number, thumbDragOffset: number | null = null) => {
      const track = virtualScrollTrackRef.current;
      const viewport = scrollViewportRef.current;
      if (!track || !viewport) return;

      const trackRect = track.getBoundingClientRect();
      const trackWidth = trackRect.width;
      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
        scrollLeft: virtualScrollLeftRef.current,
        scrollMax: virtualScrollMax,
        tableWidth: resolveTableWidth(viewport),
        trackWidth,
      });
      const maxThumbLeft = Math.max(0, trackWidth - metrics.thumbWidth);
      const rawThumbLeft =
        thumbDragOffset === null
          ? clientX - trackRect.left - metrics.thumbWidth / 2
          : clientX - trackRect.left - thumbDragOffset;
      const nextThumbLeft = Math.min(maxThumbLeft, Math.max(0, rawThumbLeft));
      const nextVirtualScrollLeft =
        maxThumbLeft <= 0 ? 0 : (nextThumbLeft / maxThumbLeft) * virtualScrollMax;

      commitVirtualScrollLeft(nextVirtualScrollLeft);
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    },
    [commitVirtualScrollLeft, measureViewportMaxWidth, resolveTableWidth, resolveVirtualScrollMax],
  );
  const handleVirtualScrollbarPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      isVirtualScrollbarDraggingRef.current = true;
      virtualScrollbarDragOffsetRef.current = null;
      event.currentTarget.setPointerCapture(event.pointerId);
      commitVirtualScrollLeftFromClientX(event.clientX);
    },
    [commitVirtualScrollLeftFromClientX],
  );
  const handleVirtualScrollbarPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isVirtualScrollbarDraggingRef.current) return;

      commitVirtualScrollLeftFromClientX(event.clientX, virtualScrollbarDragOffsetRef.current);
    },
    [commitVirtualScrollLeftFromClientX],
  );
  const handleVirtualScrollbarPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      isVirtualScrollbarDraggingRef.current = false;
      virtualScrollbarDragOffsetRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );
  const handleVirtualScrollbarThumbPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      const track = virtualScrollTrackRef.current;
      if (!track) return;

      const trackRect = track.getBoundingClientRect();
      isVirtualScrollbarDraggingRef.current = true;
      // thumb 是 track 的子元素，按住 thumb 时不能冒泡到 track 的点击跳转逻辑；
      // 记录指针在 thumb 内的位置，拖动时保持这个相对偏移，避免 thumb 突然居中跳动。
      virtualScrollbarDragOffsetRef.current = Math.max(
        0,
        event.clientX - trackRect.left - virtualScrollThumbLeftRef.current,
      );
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );
  const handleVirtualScrollbarThumbPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (!isVirtualScrollbarDraggingRef.current) return;

      commitVirtualScrollLeftFromClientX(event.clientX, virtualScrollbarDragOffsetRef.current);
    },
    [commitVirtualScrollLeftFromClientX],
  );
  const handleVirtualScrollbarThumbPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      handleVirtualScrollbarPointerEnd(event);
    },
    [handleVirtualScrollbarPointerEnd],
  );
  const handleVirtualScrollbarWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (horizontalDelta === 0) return;

      const viewport = scrollViewportRef.current;
      if (!viewport || resolveVirtualScrollMax(viewport) <= 1) return;

      event.preventDefault();
      commitVirtualScrollLeft(virtualScrollLeftRef.current + horizontalDelta);
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    },
    [commitVirtualScrollLeft, measureViewportMaxWidth, resolveVirtualScrollMax],
  );

  const handleCopyMarkdown = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(
        intl.formatMessage({ id: "markdownTable.copyFailed" }, { error: "clipboard-unavailable" }),
      );
      return;
    }

    try {
      await navigator.clipboard.writeText(buildMarkdownTableText(getRows()));
      toast(intl.formatMessage({ id: "markdownTable.copySucceeded" }));
    } catch (error) {
      toast(
        intl.formatMessage(
          { id: "markdownTable.copyFailed" },
          { error: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  }, [getRows, intl]);

  const handleDownloadCsv = useCallback(() => {
    if (
      typeof document === "undefined" ||
      typeof Blob === "undefined" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      toast(intl.formatMessage({ id: "markdownTable.downloadFailed" }));
      return;
    }

    const blob = new Blob([buildCsvTableText(getRows())], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "table.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [getRows, intl]);
  useEffect(() => () => widthMotionRef.current?.dispose(), []);

  const handleToggleExpandedScroll = useCallback(() => {
    widthMotionRef.current?.dispose();
    const motion = prepareTableWidthMotion(
      contentWidthRef.current,
      virtualScrollbarWrapperRef.current,
    );
    widthMotionRef.current = motion;
    const nextExpandedScrollEnabled = !expandedScrollEnabledRef.current;
    commitExpandedScrollEnabled(nextExpandedScrollEnabled);

    if (!nextExpandedScrollEnabled) {
      maxViewportLeftOffsetRef.current = 0;
      commitViewportLeftOffset(0);
      const viewport = scrollViewportRef.current;
      if (viewport) {
        // 从增强模式收回普通模式时，既有的虚拟滚动位置可能被左借位消耗；
        // 先清掉 leftOffset 再把同一个虚拟 scrollLeft 映射回真实 scrollLeft，避免表格内容跳回开头。
        viewport.scrollLeft = virtualScrollLeftRef.current;
      }
    }

    motion.measure(() => {
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    });
  }, [commitExpandedScrollEnabled, commitViewportLeftOffset, measureViewportMaxWidth]);

  const copyLabel = intl.formatMessage({ id: "markdownTable.copyMarkdown" });
  const downloadLabel = intl.formatMessage({ id: "markdownTable.downloadCsv" });
  const previewLabel = intl.formatMessage({ id: "markdownTable.openPreview" });
  const scrollModeLabel = intl.formatMessage({
    id: expandedScrollEnabled
      ? "markdownTable.collapseScrollMode"
      : "markdownTable.expandScrollMode",
  });
  const previewTitle = intl.formatMessage({ id: "markdownTable.previewTitle" });
  const previewDescription = intl.formatMessage({
    id: "markdownTable.previewDescription",
  });
  // viewportMaxWidth 是虚拟滚动槽宽，用来计算 virtualScrollMax 和 thumb；
  // 内容层本身会 translateX 向左借位，所以需要把借出去的宽度补回右侧，避免视觉右边界跟着左移。
  const contentViewportMaxWidth =
    viewportLeftOffset > 0
      ? `calc(${viewportMaxWidth} + ${Math.ceil(viewportLeftOffset)}px)`
      : viewportMaxWidth;

  // 尺寸跟随不能让复制/下载/预览工具反复重建；语言和模式变化仍更新这些控件。
  const toolbar = useMemo(
    () => (
      <div className="flex items-center justify-end gap-1" data-markdown-table-toolbar="">
        <MarkdownTableActionButton
          label={copyLabel}
          onClick={() => {
            void handleCopyMarkdown();
          }}
        >
          <CopyIcon className="size-3.5" />
        </MarkdownTableActionButton>
        <MarkdownTableActionButton label={downloadLabel} onClick={handleDownloadCsv}>
          <DownloadIcon className="size-3.5" />
        </MarkdownTableActionButton>
        <MarkdownTableActionButton label={previewLabel} onClick={() => setPreviewOpen(true)}>
          <Maximize2Icon className="size-3.5" />
        </MarkdownTableActionButton>
        {canToggleExpandedScroll ? (
          <MarkdownTableActionButton label={scrollModeLabel} onClick={handleToggleExpandedScroll}>
            {expandedScrollEnabled ? (
              <ArrowLeftFromLine className="size-3.5" />
            ) : (
              <ArrowRightToLine className="size-3.5" />
            )}
          </MarkdownTableActionButton>
        ) : null}
      </div>
    ),
    [
      canToggleExpandedScroll,
      copyLabel,
      downloadLabel,
      previewLabel,
      scrollModeLabel,
      expandedScrollEnabled,
      handleCopyMarkdown,
      handleDownloadCsv,
      handleToggleExpandedScroll,
    ],
  );

  return (
    <div ref={rootRef} className="my-0 flex min-w-0 flex-col gap-2">
      {toolbar}
      <div
        ref={frameRef}
        className="group/markdown-table-frame relative w-full"
        data-markdown-table-frame=""
        data-markdown-table-virtual-scroll-sticky={virtualScrollbarSticky ? "true" : "false"}
      >
        <div
          ref={contentWidthRef}
          className="min-w-full w-max transition-none ease-out motion-reduce:transition-none"
          style={{
            maxWidth: contentViewportMaxWidth,
            transform: viewportLeftOffset > 0 ? `translateX(-${viewportLeftOffset}px)` : undefined,
          }}
        >
          <div
            // 表格已有边缘阴影提示横向溢出，显示系统滚动条会在消息块底部产生额外视觉噪音；
            // 外层宽度容器按 frame 宽度 + rightDistance 计算最大宽度，滚动 viewport 只占满该容器。
            className="relative w-full overflow-hidden rounded-xl border border-border"
          >
            <div
              ref={scrollViewportRef}
              className="!scrollbar-hide w-full overflow-x-auto overflow-y-visible"
            >
              <table
                ref={tableRef}
                className={cn(
                  "w-max min-w-full border-separate border-spacing-0 text-ui-base",
                  className,
                )}
                {...props}
                data-streamdown="table"
              >
                {children}
              </table>
            </div>
            <MarkdownTableEdgeShadow side="left" state={edgeShadowState} />
            <MarkdownTableEdgeShadow side="right" state={edgeShadowState} />
          </div>
        </div>
        <div
          ref={virtualScrollbarWrapperRef}
          aria-hidden={!virtualScrollbarVisible}
          // V4 transformed virtual row 下 sticky 由 relative + translateY 模拟，
          // computed position 不能表达产品语义；显式状态供跨实现的 E2E 与可访问性诊断读取。
          data-markdown-table-virtual-scroll-sticky={virtualScrollbarSticky ? "true" : "false"}
          data-markdown-table-virtual-scroll-visible={virtualScrollbarVisible ? "true" : "false"}
          // 滚动条槽宽必须等于 frameRect.width + rightDistance 再扣掉消息列响应式右 padding；
          // 长表格需要在纵向阅读时也能横向滚动，sticky 底部要避让 composer 和底部面板。
          // overflow 测量变化时只切换可见性，保留节点和纵向占位，避免扰动 timeline 高度。
          style={{ width: scrollbarWidth }}
          className={cn(
            "pointer-events-none py-1 opacity-0 transition-opacity duration-200 ease-out motion-reduce:transition-none",
            virtualScrollbarVisible
              ? "visible group-hover/markdown-table-frame:pointer-events-auto group-hover/markdown-table-frame:opacity-100"
              : "invisible",
            virtualScrollbarSticky && "relative z-20",
          )}
        >
          <div
            ref={virtualScrollTrackRef}
            aria-hidden="true"
            className="mt-1 h-3.5 w-full touch-none rounded-full bg-foreground/3"
            data-markdown-table-virtual-scroll-track=""
            onPointerCancel={handleVirtualScrollbarPointerEnd}
            onPointerDown={handleVirtualScrollbarPointerDown}
            onPointerMove={handleVirtualScrollbarPointerMove}
            onPointerUp={handleVirtualScrollbarPointerEnd}
            onWheel={handleVirtualScrollbarWheel}
          >
            <div
              className="h-3 rounded-full bg-foreground/20 transition-colors hover:bg-foreground/40"
              onPointerCancel={handleVirtualScrollbarThumbPointerEnd}
              onPointerDown={handleVirtualScrollbarThumbPointerDown}
              onPointerMove={handleVirtualScrollbarThumbPointerMove}
              onPointerUp={handleVirtualScrollbarThumbPointerEnd}
              ref={virtualScrollThumbRef}
            />
          </div>
        </div>
      </div>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="flex max-h-[calc(100vh-2rem)] w-max max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-hidden rounded-2xl p-4 sm:max-h-[calc(100vh-8rem)] sm:max-w-[calc(100vw-8rem)] md:min-w-[640px] lg:min-w-[720px]">
          <DialogHeader className="pr-8">
            <DialogTitle>{previewTitle}</DialogTitle>
            <DialogDescription>{previewDescription}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-auto rounded-xl border border-border bg-background">
            <table
              className={cn(
                "w-max min-w-full border-separate border-spacing-0 text-ui-base [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background",
                className,
              )}
              {...props}
              data-streamdown="table-preview"
            >
              {children}
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 只有用户切换表格模式才增加尺寸过渡；外层 resize 跟随当前几何，不叠加追赶动画。 */
function prepareTableWidthMotion(content: HTMLElement | null, scrollbar: HTMLElement | null) {
  let active = true;
  let frame = 0;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced) {
    if (content) {
      content.style.transitionProperty = "max-width";
      content.style.transitionDuration = "200ms";
    }
    if (scrollbar) scrollbar.style.transitionProperty = "width, opacity";
  }
  const dispose = () => {
    if (!active) return;
    active = false;
    cancelAnimationFrame(frame);
    content?.style.removeProperty("transition-property");
    content?.style.removeProperty("transition-duration");
    scrollbar?.style.removeProperty("transition-property");
  };
  return {
    dispose,
    measure(update: () => void) {
      frame = requestAnimationFrame(() => {
        if (!active) return;
        update();
        frame = requestAnimationFrame(() => {
          const animations = [content, scrollbar]
            .flatMap((node) => node?.getAnimations() ?? [])
            .filter(
              (animation) =>
                animation instanceof CSSTransition &&
                /^(max-width|width)$/.test(animation.transitionProperty),
            );
          // 零尺寸差、减少动画、完成及取消都按真实生命周期清理，不用定时器猜结束。
          void Promise.allSettled(animations.map((animation) => animation.finished)).then(dispose);
        });
      });
    },
  };
}

function MarkdownTableEdgeShadow({
  side,
  state,
}: {
  side: "left" | "right";
  state: MarkdownTableEdgeShadowState;
}) {
  const visible = state === side || state === "both";
  if (!visible) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-y-0 z-10 w-6",
        side === "left"
          ? "left-0 rounded-l-xl shadow-[inset_12px_0_12px_-12px_color-mix(in_srgb,black_15%,transparent)]"
          : "right-0 rounded-r-xl shadow-[inset_-12px_0_12px_-12px_color-mix(in_srgb,black_15%,transparent)]",
      )}
      data-markdown-table-edge-shadow={side}
    />
  );
}

function MarkdownTableActionButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <ControlHintTooltip title={label}>
      <Button type="button" variant="ghost" size="icon-md" aria-label={label} onClick={onClick}>
        {children}
      </Button>
    </ControlHintTooltip>
  );
}

export type MarkdownTableHeaderProps = ComponentProps<"thead"> & MarkdownTableNodeProp;

export function MarkdownTableHeader({
  className,
  node: _node,
  ...props
}: MarkdownTableHeaderProps) {
  return <thead className={cn("", className)} {...props} />;
}

export type MarkdownTableBodyProps = ComponentProps<"tbody"> & MarkdownTableNodeProp;

export function MarkdownTableBody({ className, node: _node, ...props }: MarkdownTableBodyProps) {
  return <tbody className={cn("", className)} {...props} />;
}

export type MarkdownTableRowProps = ComponentProps<"tr"> & MarkdownTableNodeProp;

export function MarkdownTableRow({ className, node: _node, ...props }: MarkdownTableRowProps) {
  return (
    <tr
      className={cn("transition-colors last:[&>td]:border-b-0 hover:bg-hover/20", className)}
      {...props}
    />
  );
}

export type MarkdownTableHeadProps = ComponentProps<"th"> & MarkdownTableNodeProp;

export function MarkdownTableHead({ className, node: _node, ...props }: MarkdownTableHeadProps) {
  return (
    <th
      className={cn(
        "border-border border-b px-3 py-2 text-left font-normal text-foreground-subtlest min-w-16 max-w-md whitespace-normal break-words",
        className,
      )}
      {...props}
    />
  );
}

export type MarkdownTableCellProps = ComponentProps<"td"> & MarkdownTableNodeProp;

export function MarkdownTableCell({ className, node: _node, ...props }: MarkdownTableCellProps) {
  return (
    <td
      className={cn(
        "border-border border-b px-3 py-2 text-foreground align-top min-w-16 max-w-md whitespace-normal break-words",
        className,
      )}
      {...props}
    />
  );
}
