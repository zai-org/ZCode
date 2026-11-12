import type { CliMemoryDiagnostic, CliMemoryReading } from "@zcode/shared";

export interface AllocationNode {
  id: number;
  selfSize: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  children: AllocationNode[];
}
export interface AllocationProfiler {
  start(): Promise<void>;
  read(): Promise<{ head: AllocationNode }>;
  reset(): Promise<void>;
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
