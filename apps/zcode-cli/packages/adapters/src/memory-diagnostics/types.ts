import type { CliMemoryDiagnostic, CliMemoryReading } from "@zcode/shared";

export interface AllocationNode {
  id: number;
  selfSize: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  children: AllocationNode[];
}
export interface AllocationProfiler {
  /** 返回同步 Inspector 工作耗时，不包括 Promise continuation 的调度等待。 */
  start(): Promise<number>;
  read(): Promise<{ head: AllocationNode; durationMs: number }>;
  reset(): Promise<number>;
  dispose(): void;
}
export interface MemoryDiagnosticRecorder {
  start(): Promise<void>;
  sample(): Promise<void>;
  stop(): void;
}
export interface MemoryDiagnosticOptions {
  bundlePath: string;
  metadata(): Pick<
    CliMemoryDiagnostic,
    "instanceId" | "pid" | "version" | "commit" | "node" | "v8" | "bundleSha256"
  >;
  profiler: AllocationProfiler;
  readMemory(): Omit<CliMemoryReading, "at" | "counters">;
  readCounters(): Record<string, number>;
  write(record: CliMemoryDiagnostic): Promise<void>;
  now?(): number;
  measure?(): number;
}
