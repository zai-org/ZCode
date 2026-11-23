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
  let degradation: CliMemoryDiagnostic["sampler"]["degradation"];
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
  const degrade = (
    nextState: CliMemoryDiagnostic["sampler"]["state"],
    reason: NonNullable<typeof degradation>["reason"],
    durationMs = 0,
  ) => {
    state = nextState;
    // 纯指标轮次的耗时不能覆盖真正触发降级的现场，尤其是首次采样前的失败。
    degradation ??= { reason, at: now(), durationMs };
    disposeProfiler();
  };
  return {
    async start() {
      if (started || stopped) return;
      started = true;
      busy = true;
      try {
        const durationMs = await options.profiler.start();
        if (stopped) {
          disposeProfiler();
          return;
        }
        state = "active";
        windowStartedAt = now();
        if (durationMs > MAX_PROFILE_WORK_MS)
          degrade("budget-exceeded", "start-budget", durationMs);
      } catch {
        degrade("unsupported", "start-failed");
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
          degrade("budget-exceeded", "write-backpressure");
        }
        return;
      }
      busy = true;
      try {
        const began = measure();
        const memory = options.readMemory();
        samples.push({ at: now(), ...memory, counters: options.readCounters() });
        if (samples.length > CLI_MEMORY_MAX_SAMPLES) samples.shift();
        let durationMs = measure() - began;
        if (
          state === "active" &&
          memory.heapLimit > 0 &&
          memory.heapUsed >= memory.heapLimit * MAX_HEAP_USAGE_RATIO
        ) {
          // 接近堆上限时不再物化 profile，保留此前热点，避免取证本身触发最后一次大分配。
          degrade("budget-exceeded", "heap-pressure", durationMs);
        }
        if (state === "active") {
          try {
            const profile = await options.profiler.read();
            if (stopped) return;
            const projectionBegan = measure();
            const projected = projectAllocations(profile.head, options.bundlePath);
            durationMs += profile.durationMs + measure() - projectionBegan;
            if (projected) {
              // 有效投影已付出采集成本；即使本轮超预算，也保留这份证据再熔断，不能白采后丢弃。
              lastAllocations = projected;
              profileCapturedAt = now();
              profileWindowStartedAt = windowStartedAt;
            }
            if (!projected || durationMs > MAX_PROFILE_WORK_MS) {
              degrade(
                "budget-exceeded",
                projected ? "profile-budget" : "profile-node-limit",
                durationMs,
              );
            } else {
              if (now() - windowStartedAt >= MEMORY_PROFILE_WINDOW_MS) {
                durationMs += await options.profiler.reset();
                if (stopped) return;
                windowStartedAt = now();
              }
            }
          } catch {
            degrade("error", "profile-error", durationMs);
          }
        }
        if (stopped) return;
        if (state === "active" && durationMs > MAX_PROFILE_WORK_MS) {
          degrade("budget-exceeded", "profile-budget", durationMs);
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
            ...(degradation ? { degradation } : {}),
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
