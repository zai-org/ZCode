import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { normalize } from "node:path";
import {
  CLI_MEMORY_MAX_ALLOCATIONS,
  CLI_MEMORY_MAX_SAMPLES,
  CLI_MEMORY_MAX_STACK_DEPTH,
  sanitizeCliMemoryDiagnostic,
  type CliMemoryAllocation,
  type CliMemoryDiagnostic,
  type CliMemoryReading,
} from "@zcode/shared";
import type { AllocationNode, MemoryDiagnosticOptions, MemoryDiagnosticRecorder } from "./types.js";

export const MEMORY_SAMPLE_INTERVAL_BYTES = 1024 * 1024;
export const MEMORY_DIAGNOSTIC_INTERVAL_MS = 15_000;
export const MEMORY_PROFILE_WINDOW_MS = 60_000;
const MAX_PROFILE_NODES = 4096;
const MAX_PROFILE_WORK_MS = 25;
const MAX_HEAP_USAGE_RATIO = 0.8;

function projectAllocations(
  head: AllocationNode,
  bundlePath: string,
): CliMemoryAllocation[] | null {
  const comparablePath = (path: string) =>
    process.platform === "win32" ? normalize(path).toLowerCase() : normalize(path);
  const expectedPath = comparablePath(bundlePath);
  const work: Array<{ node: AllocationNode; stack: CliMemoryAllocation["stack"] }> = [
    { node: head, stack: [] },
  ];
  const top: CliMemoryAllocation[] = [];
  let visited = 0;
  while (work.length) {
    if (++visited > MAX_PROFILE_NODES) return null;
    const { node, stack: previous } = work.pop()!;
    const frame = node.callFrame;
    let path = frame.url;
    if (path.startsWith("file:")) {
      try {
        path = fileURLToPath(path);
      } catch {
        path = "";
      }
    }
    // 只保留已知发布 bundle 的位置，eval、插件和用户脚本的名称/路径不能进入日志。
    const stack =
      comparablePath(path) === expectedPath
        ? [
            ...previous,
            { name: frame.functionName, line: frame.lineNumber, column: frame.columnNumber },
          ].slice(-CLI_MEMORY_MAX_STACK_DEPTH)
        : previous;
    if (node.selfSize > 0 && stack.length) {
      top.push({ bytes: node.selfSize, stack });
      top.sort((a, b) => b.bytes - a.bytes);
      if (top.length > CLI_MEMORY_MAX_ALLOCATIONS) top.pop();
    }
    // 不能先把巨大 children 全部复制到遍历栈，否则“有界投影”本身也会申请大块内存。
    if (visited + work.length + node.children.length > MAX_PROFILE_NODES) return null;
    for (const child of node.children) work.push({ node: child, stack });
  }
  return top;
}

export function createMemoryDiagnosticRecorder(
  options: MemoryDiagnosticOptions,
): MemoryDiagnosticRecorder {
  const now = options.now ?? Date.now;
  const measure = options.measure ?? (() => performance.now());
  let stopped = false;
  let busy = false;
  let started = false;
  let disposed = false;
  let state: CliMemoryDiagnostic["sampler"]["state"] = "unsupported";
  let windowStartedAt = 0;
  let profileCapturedAt = 0;
  let profileWindowStartedAt = 0;
  let lastAllocations: CliMemoryAllocation[] = [];
  const samples: CliMemoryReading[] = [];
  const disposeProfiler = () => {
    if (disposed) return;
    disposed = true;
    try {
      options.profiler.dispose();
    } catch {
      /* 诊断清理不能影响 runtime 退出。 */
    }
  };
  return {
    async start() {
      if (started || stopped) return;
      started = true;
      busy = true;
      try {
        const began = measure();
        await options.profiler.start();
        if (stopped) {
          disposeProfiler();
          return;
        }
        state = measure() - began > MAX_PROFILE_WORK_MS ? "budget-exceeded" : "active";
        windowStartedAt = now();
        if (state !== "active") disposeProfiler();
      } catch {
        disposeProfiler();
      } finally {
        busy = false;
      }
    },
    async sample() {
      // 磁盘慢、inspector 忙或正在退出时直接丢本轮，绝不叠加 promise 队列。
      if (stopped || !started) return;
      if (busy) {
        // 慢磁盘不能把 60 秒采样窗口无限拉长；忙时不排队，窗口到期直接释放 profiler。
        if (state === "active" && now() - windowStartedAt >= MEMORY_PROFILE_WINDOW_MS) {
          state = "budget-exceeded";
          disposeProfiler();
        }
        return;
      }
      busy = true;
      try {
        const began = measure();
        const memory = options.readMemory();
        samples.push({ at: now(), ...memory, counters: options.readCounters() });
        if (samples.length > CLI_MEMORY_MAX_SAMPLES) samples.shift();
        if (
          state === "active" &&
          memory.heapLimit > 0 &&
          memory.heapUsed >= memory.heapLimit * MAX_HEAP_USAGE_RATIO
        ) {
          // 接近堆上限时不再物化 profile，保留此前热点，避免取证本身触发最后一次大分配。
          state = "budget-exceeded";
          disposeProfiler();
        }
        if (state === "active") {
          try {
            const profile = await options.profiler.read();
            if (stopped) return;
            const projected = projectAllocations(profile.head, options.bundlePath);
            if (!projected || measure() - began > MAX_PROFILE_WORK_MS) {
              state = "budget-exceeded";
              disposeProfiler();
            } else {
              // 降级后仍带上最后一次有效热点，不能让后续纯指标记录把关键现场覆盖掉。
              lastAllocations = projected;
              profileCapturedAt = now();
              profileWindowStartedAt = windowStartedAt;
              if (now() - windowStartedAt >= MEMORY_PROFILE_WINDOW_MS) {
                await options.profiler.reset();
                if (stopped) return;
                windowStartedAt = now();
              }
            }
          } catch {
            state = "error";
            disposeProfiler();
          }
        }
        if (stopped) return;
        const durationMs = measure() - began;
        if (state === "active" && durationMs > MAX_PROFILE_WORK_MS) {
          state = "budget-exceeded";
          disposeProfiler();
        }
        const record = sanitizeCliMemoryDiagnostic({
          format: "zcode-cli-memory-v1",
          timestamp: now(),
          ...options.metadata(),
          sampler: {
            state,
            intervalBytes: MEMORY_SAMPLE_INTERVAL_BYTES,
            windowStartedAt: profileWindowStartedAt,
            profileCapturedAt,
            durationMs,
          },
          samples,
          allocations: lastAllocations,
        });
        if (record) await options.write(record);
      } catch {
        /* 只丢当前样本，不在 OOM 现场增加错误日志或重试。 */
      } finally {
        busy = false;
      }
    },
    stop() {
      stopped = true;
      disposeProfiler();
    },
  };
}
