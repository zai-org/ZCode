// 工作区里的内容和完整视图之间的两条线（spec：docs/ui/side-pane-full-view.md）。
// 浏览器、设计工具等在面板深处，拿不到 App 层的完整视图控制器：
// - 请求进入：发一个 window 事件，由 App 判断能不能进（支持完整视图、面板开着、还不在完整视图），不能就忽略；
// - 当前是否在完整视图：App 写入、内容侧订阅（设计面板只在完整视图里出，退出时收起）。
import { useSyncExternalStore } from "react";

export const SIDE_PANE_FULL_VIEW_ENTER_REQUEST_EVENT = "zcode:side-pane-full-view-enter-request";

export function requestSidePaneFullView(): void {
  window.dispatchEvent(new Event(SIDE_PANE_FULL_VIEW_ENTER_REQUEST_EVENT));
}

let fullViewActive = false;
const listeners = new Set<() => void>();

/** App 在完整视图开关变化时写入 */
export function setSidePaneFullViewActive(active: boolean): void {
  if (fullViewActive === active) return;
  fullViewActive = active;
  for (const listener of listeners) listener();
}

export function useSidePaneFullViewActive(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => fullViewActive,
    () => false,
  );
}
