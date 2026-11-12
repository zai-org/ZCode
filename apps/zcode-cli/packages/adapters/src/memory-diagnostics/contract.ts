export interface CliMemoryDiagnostics {
  /** 幂等停止采样；不等待写盘，不改变任务生命周期。 */
  stop(): void;
}
