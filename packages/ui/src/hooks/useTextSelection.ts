import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** 统一鼠标、键盘和触控选区的监听；作用域变化后旧选区不能路由到新任务。 */
export function useTextSelection<T>({
  rootRef,
  enabled,
  inspect,
  scopeKey,
  observeSelectionChange = false,
  repositionOnScroll = false,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  inspect: () => T | null;
  scopeKey: unknown;
  observeSelectionChange?: boolean;
  /**
   * 滚动时重新检查选区并更新位置，而不是关闭。对话时间线在回答输出时会自动跟随滚动
   * （位置不变也会派发 scroll），按“滚动即关闭”处理会让浮层刚出现就消失。
   * 选区滚出可视范围时由 inspect 返回 null 隐藏。
   */
  repositionOnScroll?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<{ scopeKey: unknown; value: T } | null>(null);
  const frameRef = useRef(0);
  // 用户主动关掉了浮层（Esc，或点了浮层里的动作）。
  // 问题原因：关闭只清掉浮层状态，页面上的选区还在。滚动改成“重新检查选区”以后，下一次滚动
  // 或容器尺寸变化又会读到同一个选区，把用户刚关掉的浮层弹回来。
  // 置位后，滚动和尺寸变化不再重开浮层；只有用户再次操作选区（鼠标、触控、键盘，或选区折叠）才复位。
  const dismissedRef = useRef(false);
  const hide = useCallback(() => {
    window.cancelAnimationFrame(frameRef.current);
    setSnapshot(null);
  }, []);
  const close = useCallback(() => {
    dismissedRef.current = true;
    hide();
  }, [hide]);
  useEffect(() => {
    dismissedRef.current = false;
    hide();
    const root = rootRef.current;
    if (!root || !enabled) return;
    const schedule = () => {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = window.requestAnimationFrame(() => {
        const value = inspect();
        setSnapshot(value ? { scopeKey, value } : null);
      });
    };
    /** 用户操作了选区：解除“已关闭”，按新的选区决定是否显示。 */
    const onUserSelect = () => {
      dismissedRef.current = false;
      schedule();
    };
    /** 位置可能变了：只更新已经显示（或因滚出可视范围而暂时隐藏）的浮层，不重开被用户关掉的。 */
    const reposition = () => {
      if (!dismissedRef.current) schedule();
    };
    const onKey = (event: KeyboardEvent) => (event.key === "Escape" ? close() : onUserSelect());
    const onSelection = () => {
      if (window.getSelection()?.isCollapsed) {
        dismissedRef.current = false;
        hide();
      } else if (observeSelectionChange) {
        onUserSelect();
      }
    };
    const onScroll = repositionOnScroll ? reposition : hide;
    root.addEventListener("mouseup", onUserSelect);
    root.addEventListener("touchend", onUserSelect, { passive: true });
    document.addEventListener("keyup", onKey);
    document.addEventListener("selectionchange", onSelection);
    root.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("resize", hide);
    // 打开/收起侧栏不会触发 window resize，也不一定触发 scroll，但时间线变窄后文字会重排，
    // 浮层停在原地就指错了位置；跟随选区的浮层在容器尺寸变化后同样重新定位。
    const resize =
      repositionOnScroll && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(reposition)
        : null;
    resize?.observe(root);
    return () => {
      resize?.disconnect();
      window.cancelAnimationFrame(frameRef.current);
      root.removeEventListener("mouseup", onUserSelect);
      root.removeEventListener("touchend", onUserSelect);
      document.removeEventListener("keyup", onKey);
      document.removeEventListener("selectionchange", onSelection);
      root.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
    };
  }, [
    close,
    enabled,
    hide,
    inspect,
    observeSelectionChange,
    repositionOnScroll,
    rootRef,
    scopeKey,
  ]);
  return {
    state: enabled && snapshot && snapshot.scopeKey === scopeKey ? snapshot.value : null,
    close,
  };
}
