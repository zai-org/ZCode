import type { ResourceUsageSnapshot } from "@zcode/shared";
import type { ResourceManagerAppProps } from "@/resource-manager/contract.js";

/** Desktop preload 注入既有快照查询与采样启停，不在 UI 重新归属进程。 */
export function resourceManagerExample(
  getSnapshot: () => Promise<ResourceUsageSnapshot>,
  setSamplingActive: (active: boolean) => void,
): ResourceManagerAppProps {
  return { getSnapshot, setSamplingActive, initialTab: "cpu" };
}
