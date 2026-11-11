import { useEffect } from "react";
import { useExtensionsService } from "@/extension-slots/adapters/useExtensionSlots.js";
import { getWorkbenchReporter } from "@/extension-slots/app/workbenchReporter.js";
import type { WorkbenchPaneReport } from "@/extension-slots/contract.js";

/**
 * 对话窗格登记自己的屏幕会话（docs/plugins/extension-host.md §3.4、§9）：会话、草稿、焦点或草稿所选模型
 * 变化时更新，卸载时注销。传 null 表示这个窗格不报告（只读观察视图、远程工作区等）。
 * 没有扩展门面（Web、手机远控）时什么都不做。
 */
export function useExtensionWorkbenchPane(entry: WorkbenchPaneReport | null): void {
  const service = useExtensionsService();
  // 以序列化值做依赖：同一内容的新对象不触发重新登记。
  const serialized = entry ? JSON.stringify(entry) : null;
  useEffect(() => {
    if (!service || !serialized) return;
    const parsed = JSON.parse(serialized) as WorkbenchPaneReport;
    const key = JSON.stringify([
      parsed.workspaceIdentity?.trim() || parsed.workspacePath,
      parsed.paneId,
    ]);
    return getWorkbenchReporter(service).set(key, parsed);
  }, [service, serialized]);
}
