import type { PreinstalledToolsState } from "@zcode/shared/preinstalled-tools";

/** Main 只持有进程句柄；业务快照由子进程查询，Host 不等待其初始化。 */
export interface PreinstalledToolsProcessHandle {
  getState(): Promise<PreinstalledToolsState>;
  dispose(): Promise<void>;
}
