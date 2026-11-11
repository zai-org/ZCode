import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

const SCROLL_MASK_EDGE_SIZE_PX = 24;
const SCROLL_MASK_THRESHOLD_PX = 1;

export interface ScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

export interface ScrollMaskState {
  showBottom: boolean;
  showTop: boolean;
}

export const EMPTY_SCROLL_MASK_STATE: ScrollMaskState = {
  showBottom: false,
  showTop: false,
};

export function resolveVerticalScrollMaskState({
  clientHeight,
  scrollHeight,
  scrollTop,
}: ScrollMetrics): ScrollMaskState {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  if (maxScrollTop <= SCROLL_MASK_THRESHOLD_PX) {
    return EMPTY_SCROLL_MASK_STATE;
  }

  return {
    showTop: scrollTop > SCROLL_MASK_THRESHOLD_PX,
    showBottom: scrollTop < maxScrollTop - SCROLL_MASK_THRESHOLD_PX,
  };
}

export function getVerticalScrollMaskStyle({
  showBottom,
  showTop,
}: ScrollMaskState): CSSProperties | undefined {
  if (!showTop && !showBottom) {
    return undefined;
  }

  const topStop = showTop
    ? `transparent 0px, black ${SCROLL_MASK_EDGE_SIZE_PX}px`
    : `black 0px, black ${SCROLL_MASK_EDGE_SIZE_PX}px`;
  const bottomStop = showBottom
    ? `black calc(100% - ${SCROLL_MASK_EDGE_SIZE_PX}px), transparent 100%`
    : `black calc(100% - ${SCROLL_MASK_EDGE_SIZE_PX}px), black 100%`;
  const maskImage = `linear-gradient(to bottom, ${topStop}, ${bottomStop})`;

  return {
    WebkitMaskImage: maskImage,
    maskImage,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskSize: "100% 100%",
    maskSize: "100% 100%",
  };
}

/** Thinking 与工具分组共用：容器拥有跟随状态，内容/容器变高时只在用户未离底时跟随。 */
export function useBottomFollowingScroll(active: boolean, contentVersion: unknown) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);
  const [mask, setMask] = useState<ScrollMaskState>(EMPTY_SCROLL_MASK_STATE);
  const updateMask = useCallback(() => {
    const el = scrollRef.current;
    const next = el ? resolveVerticalScrollMaskState(el) : EMPTY_SCROLL_MASK_STATE;
    setMask((previous) =>
      previous.showTop === next.showTop && previous.showBottom === next.showBottom
        ? previous
        : next,
    );
  }, []);
  const sync = useCallback(() => {
    const el = scrollRef.current;
    if (el && followingRef.current) el.scrollTop = el.scrollHeight;
    updateMask();
  }, [updateMask]);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    followingRef.current = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop) <= 2;
    updateMask();
  }, [updateMask]);
  useEffect(() => {
    if (!active) {
      followingRef.current = true;
      setMask(EMPTY_SCROLL_MASK_STATE);
      return;
    }
    sync();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [active, sync]);
  useEffect(() => {
    if (active) sync();
  }, [active, contentVersion, sync]);
  const maskData = mask.showTop
    ? mask.showBottom
      ? "both"
      : "top"
    : mask.showBottom
      ? "bottom"
      : "none";
  return { scrollRef, contentRef, onScroll, maskData, maskStyle: getVerticalScrollMaskStyle(mask) };
}
