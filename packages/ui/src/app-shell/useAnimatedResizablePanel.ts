import { useEffect, useRef } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

export function useAnimatedResizablePanel({
  open,
  animateWidth = false,
  expandedSize,
  rememberExpandedSize = false,
  resizeOnInitialVisibleMount = true,
}: {
  open: boolean;
  animateWidth?: boolean;
  expandedSize?: string;
  rememberExpandedSize?: boolean;
  resizeOnInitialVisibleMount?: boolean;
}) {
  const panelRef = useRef<PanelImperativeHandle | null>(null);
  const panelElementRef = useRef<HTMLDivElement | null>(null);
  const expandedSizeRef = useRef(expandedSize);
  const hasHandledVisibilityRef = useRef(false);
  // 显隐仍由原开关派生；动画只管理临时样式，不维护第二份开关状态。
  const isVisible = open;

  useEffect(() => {
    expandedSizeRef.current = expandedSize;
  }, [expandedSize]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    if (!hasHandledVisibilityRef.current) {
      hasHandledVisibilityRef.current = true;
      if (isVisible && !resizeOnInitialVisibleMount) {
        // sidebar 的 PanelGroup 已通过 layoutId 持久化宽度。
        // 首次可见挂载时如果这里再 resize 到默认值，会覆盖用户上次拖拽保存的宽度。
        return;
      }
    }

    const element = panelElementRef.current;
    const transition =
      animateWidth && element && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? prepareWidthTransition(element)
        : undefined;
    // 仅开关启用尺寸过渡，避免窗口 resize 和拖拽也触发动画。
    // Panel 首次挂载时，react-resizable-panels 会在内部 effect 里注册约束。
    // 如果我们同一拍就立刻调用 collapse/expand，偶发会早于约束注册完成，触发
    // “Panel constraints not found” 崩溃。这里延后一帧，确保面板先完成注册再执行尺寸命令。
    const rafId = window.requestAnimationFrame(() => {
      const groupWidth =
        transition && element
          ? Array.from(
              element.parentElement!.querySelectorAll<HTMLElement>(":scope > [data-panel]"),
            ).reduce((width, panel) => width + panel.offsetWidth, 0)
          : 0;
      const previousSize = panel.getSize().asPercentage;
      if (isVisible) {
        const nextExpandedSize = expandedSizeRef.current;
        if (nextExpandedSize) {
          panel.resize(nextExpandedSize);
        } else {
          panel.expand();
        }
      } else {
        if (rememberExpandedSize) {
          const currentSize = panel.getSize().asPercentage;
          if (Number.isFinite(currentSize) && currentSize > 0) {
            expandedSizeRef.current = `${currentSize}%`;
          }
        }
        panel.collapse();
      }
      if (transition && element) {
        // getSize 的百分比是 Panel owner 的目标值，像素值却是动画中的 DOM 宽度。
        // 用目标比例锁住展开内容，避免收起或快速反向时 Tabs/终端先被挤压换行。
        const targetSize = isVisible ? panel.getSize().asPercentage : previousSize;
        element.style.setProperty(
          "--side-pane-content-width",
          `${(groupWidth * targetSize) / 100}px`,
        );
        transition.settle();
      }
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      transition?.dispose();
    };
  }, [animateWidth, isVisible, rememberExpandedSize, resizeOnInitialVisibleMount]);

  return {
    panelRef,
    panelElementRef,
    isVisible,
  };
}

const WIDTH_TRANSITION_CLASSES = [
  "transition-[flex-grow]",
  "duration-200",
  "ease-out",
  "motion-reduce:transition-none",
];

function prepareWidthTransition(element: HTMLElement) {
  let active = true;
  let frame = 0;
  element.classList.add(...WIDTH_TRANSITION_CLASSES);
  const dispose = () => {
    if (!active) return;
    active = false;
    window.cancelAnimationFrame(frame);
    element.classList.remove(...WIDTH_TRANSITION_CLASSES);
    element.style.removeProperty("--side-pane-content-width");
  };
  return {
    dispose,
    settle() {
      // 等 Panel 的目标布局提交后读取真实过渡；完成、取消和零变化都能清理，
      // 不靠 200ms 定时器猜测结束，旧动画的完成回调也不能清理新一轮样式。
      frame = window.requestAnimationFrame(() => {
        const animations = element
          .getAnimations()
          .filter(
            (animation) =>
              animation instanceof CSSTransition && animation.transitionProperty === "flex-grow",
          );
        void Promise.allSettled(animations.map((animation) => animation.finished)).then(dispose);
      });
    },
  };
}
