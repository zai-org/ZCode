import type {
  NetworkCaptureBridge,
  ResourceUsageSnapshot,
  StorageManagementBridge,
} from "@zcode/shared";

export type ResourceManagerTab = "cpu" | "memory" | "storage" | "network";

/** 指标由 Host/Main 提供；UI 只持有展示快照和展开状态。 */
export interface ResourceManagerAppProps {
  /** 缺省表示桥接不可用；查询不启动 Agent、不改变业务状态。 */
  getSnapshot?: () => Promise<ResourceUsageSnapshot>;
  /** CPU/内存页启用，离开或卸载时停用并取消在途采样。 */
  setSamplingActive?: (active: boolean) => void;
  storage?: StorageManagementBridge;
  network?: NetworkCaptureBridge;
  refreshIntervalMs?: number;
  initialTab?: ResourceManagerTab;
}
