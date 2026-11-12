/**
 * 进程内存本地诊断日志的共用纯逻辑。
 *
 * main / renderer / host / agent CLI 四类进程各自采样，但写盘门控、行格式和计数器注册表
 * 只有这一份实现，避免四处各写一套阈值。本文件不依赖 Node / DOM API。
 */

export type MemorySampleRole = "main" | "renderer" | "utility_host" | "agent_node";

export const CLI_MEMORY_DIAGNOSTIC_DIRECTORY = "memory-diagnostics";
export const CLI_MEMORY_MAX_FILES = 16;
export const CLI_MEMORY_MAX_FILE_BYTES = 64 * 1024;
export const CLI_MEMORY_MAX_SAMPLES = 8;
export const CLI_MEMORY_MAX_ALLOCATIONS = 32;
export const CLI_MEMORY_MAX_STACK_DEPTH = 8;
export const CLI_MEMORY_FILE_PATTERN = /^memory-[0-9]+-[a-f0-9-]{36}\.jsonl$/;
const CLI_MEMORY_COUNTER_KEYS = [
  "sessions",
  "eventRows",
  "eventEvicted",
  "eventTransientRetained",
  "v4.publishers",
  "v4.detachedLive",
  "v4.detachedTerminal",
  "v4.rawSeqStates",
  "v4.hydrations",
  "v4.historyOpenings",
  "v4.binaryCacheEntries",
  "v4.binaryCacheBytes",
] as const;
const CLI_MEMORY_FIELDS = [
  "rss",
  "heapUsed",
  "heapTotal",
  "external",
  "arrayBuffers",
  "heapLimit",
] as const;

export interface CliMemoryReading {
  at: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  heapLimit: number;
  counters: Record<string, number>;
}

export interface CliMemoryAllocation {
  bytes: number;
  stack: Array<{ name: string; line: number; column: number }>;
}

export interface CliMemoryDiagnostic {
  format: "zcode-cli-memory-v1";
  timestamp: number;
  instanceId: string;
  pid: number;
  version: string;
  commit: string;
  node: string;
  v8: string;
  bundleSha256: string;
  sampler: {
    state: "active" | "unsupported" | "budget-exceeded" | "error";
    intervalBytes: number;
    windowStartedAt: number;
    profileCapturedAt: number;
    durationMs: number;
  };
  samples: CliMemoryReading[];
  allocations: CliMemoryAllocation[];
}

/**
 * 诊断上传只投影计数与打包位置，不能用通用 stack/body 脱敏把有效分配证据整段抹掉。
 * 未知字段全部丢弃；不信任磁盘文件里的路径、源码、消息或环境变量。
 */
export function sanitizeCliMemoryDiagnostic(value: unknown): CliMemoryDiagnostic | null {
  const record = (candidate: unknown): Record<string, unknown> | null =>
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : null;
  const number = (candidate: unknown): number =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : 0;
  const token = (candidate: unknown): string =>
    typeof candidate === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(candidate) ? candidate : "";
  const raw = record(value);
  if (!raw || raw.format !== "zcode-cli-memory-v1" || !Array.isArray(raw.samples)) return null;
  const sampler = record(raw.sampler);
  if (
    !sampler ||
    !["active", "unsupported", "budget-exceeded", "error"].includes(String(sampler.state))
  )
    return null;
  const samples: CliMemoryReading[] = [];
  for (const item of raw.samples.slice(-CLI_MEMORY_MAX_SAMPLES)) {
    const row = record(item);
    if (!row) continue;
    const counters: Record<string, number> = {};
    const rawCounters = record(row.counters);
    for (const key of CLI_MEMORY_COUNTER_KEYS) {
      if (rawCounters && typeof rawCounters[key] === "number")
        counters[key] = number(rawCounters[key]);
    }
    const sample = { at: number(row.at), counters } as CliMemoryReading;
    for (const key of CLI_MEMORY_FIELDS) sample[key] = number(row[key]);
    samples.push(sample);
  }
  const allocations: CliMemoryAllocation[] = [];
  if (Array.isArray(raw.allocations)) {
    for (const item of raw.allocations.slice(0, CLI_MEMORY_MAX_ALLOCATIONS)) {
      const row = record(item);
      if (!row || !Array.isArray(row.stack)) continue;
      const stack: CliMemoryAllocation["stack"] = [];
      for (const itemFrame of row.stack.slice(-CLI_MEMORY_MAX_STACK_DEPTH)) {
        const frame = record(itemFrame);
        if (!frame) continue;
        stack.push({
          name:
            typeof frame.name === "string" && /^[a-zA-Z0-9_$.[\]<>-]{0,64}$/.test(frame.name)
              ? frame.name
              : "",
          line: number(frame.line),
          column: number(frame.column),
        });
      }
      allocations.push({ bytes: number(row.bytes), stack });
    }
  }
  return {
    format: "zcode-cli-memory-v1",
    timestamp: number(raw.timestamp),
    instanceId:
      typeof raw.instanceId === "string" && /^[a-f0-9-]{36}$/.test(raw.instanceId)
        ? raw.instanceId
        : "",
    pid: number(raw.pid),
    version: token(raw.version),
    commit: token(raw.commit),
    node: token(raw.node),
    v8: token(raw.v8),
    bundleSha256:
      typeof raw.bundleSha256 === "string" && /^[a-f0-9]{64}$/.test(raw.bundleSha256)
        ? raw.bundleSha256
        : "",
    sampler: {
      state: sampler.state as CliMemoryDiagnostic["sampler"]["state"],
      intervalBytes: number(sampler.intervalBytes),
      windowStartedAt: number(sampler.windowStartedAt),
      profileCapturedAt: number(sampler.profileCapturedAt),
      durationMs: number(sampler.durationMs),
    },
    samples,
    allocations,
  };
}

export type MemorySampleWriteReason = "first" | "changed" | "heartbeat";

export interface MemorySampleFields {
  rssKb?: number;
  heapUsedKb?: number;
  heapTotalKb?: number;
  externalKb?: number;
  arrayBuffersKb?: number;
}

export interface MemorySample extends MemorySampleFields {
  role: MemorySampleRole;
  /** `<provider>.<key>` → 数值；只允许纯读取得到的计数。 */
  counters: Record<string, number>;
}

export interface MemorySampleWriteGateOptions {
  /** heapUsedKb 相对上一次写盘值的变化比例阈值，默认 5%。 */
  heapDeltaRatio?: number;
  /**
   * rssKb / externalKb 相对上一次写盘值的变化比例阈值，默认 10%。
   * 真机上 host 进程 RSS 从 240MB 冲到 1.5GB、externalKb 冲到 1.3GB，而 heapUsed 几乎不动，
   * 只看 heap 的门控把这一分钟判成 heartbeat 静默丢掉；native / external 内存必须单独参与判定。
   */
  nativeDeltaRatio?: number;
  /** 无变化时的心跳间隔，默认 5 分钟。 */
  heartbeatMs?: number;
}

export interface MemorySampleWriteGate {
  /**
   * 判定本次样本是否写盘。返回非 null 时表示应写盘，并把该样本记为“上一次写盘值”。
   */
  evaluate(sample: MemorySample, nowMs: number): MemorySampleWriteReason | null;
}

export const MEMORY_SAMPLE_INTERVAL_MS = 60_000;
export const MEMORY_SAMPLE_HEAP_DELTA_RATIO = 0.05;
export const MEMORY_SAMPLE_NATIVE_DELTA_RATIO = 0.1;
export const MEMORY_SAMPLE_HEARTBEAT_MS = 300_000;

const MEMORY_FIELD_ORDER: readonly (keyof MemorySampleFields)[] = [
  "rssKb",
  "heapUsedKb",
  "heapTotalKb",
  "externalKb",
  "arrayBuffersKb",
];

function countersDiffer(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return true;
    }
  }
  return false;
}

function exceedsRatio(
  current: number | undefined,
  previous: number | undefined,
  ratio: number,
): boolean {
  return (
    current !== undefined &&
    previous !== undefined &&
    Math.abs(current - previous) > Math.max(previous, 1) * ratio
  );
}

export function createMemorySampleWriteGate(
  options: MemorySampleWriteGateOptions = {},
): MemorySampleWriteGate {
  const heapDeltaRatio = options.heapDeltaRatio ?? MEMORY_SAMPLE_HEAP_DELTA_RATIO;
  const nativeDeltaRatio = options.nativeDeltaRatio ?? MEMORY_SAMPLE_NATIVE_DELTA_RATIO;
  const heartbeatMs = options.heartbeatMs ?? MEMORY_SAMPLE_HEARTBEAT_MS;
  let lastWritten: MemorySample | undefined;
  let lastWrittenAt = 0;

  return {
    evaluate(sample, nowMs) {
      let reason: MemorySampleWriteReason | null = null;
      if (!lastWritten) {
        reason = "first";
      } else if (
        exceedsRatio(sample.heapUsedKb, lastWritten.heapUsedKb, heapDeltaRatio) ||
        exceedsRatio(sample.rssKb, lastWritten.rssKb, nativeDeltaRatio) ||
        exceedsRatio(sample.externalKb, lastWritten.externalKb, nativeDeltaRatio)
      ) {
        reason = "changed";
      } else if (countersDiffer(sample.counters, lastWritten.counters)) {
        reason = "changed";
      } else if (nowMs - lastWrittenAt >= heartbeatMs) {
        reason = "heartbeat";
      }
      if (reason) {
        lastWritten = { ...sample, counters: { ...sample.counters } };
        lastWrittenAt = nowMs;
      }
      return reason;
    },
  };
}

export function bytesToKb(bytes: number): number {
  return Math.round(bytes / 1024);
}

/** 把 Node `process.memoryUsage()` 的结果换算成 KB 字段；字段缺失时省略。 */
export function memoryUsageToSampleFields(usage: {
  rss?: number;
  heapUsed?: number;
  heapTotal?: number;
  external?: number;
  arrayBuffers?: number;
}): MemorySampleFields {
  const fields: MemorySampleFields = {};
  if (typeof usage.rss === "number") fields.rssKb = bytesToKb(usage.rss);
  if (typeof usage.heapUsed === "number") fields.heapUsedKb = bytesToKb(usage.heapUsed);
  if (typeof usage.heapTotal === "number") fields.heapTotalKb = bytesToKb(usage.heapTotal);
  if (typeof usage.external === "number") fields.externalKb = bytesToKb(usage.external);
  if (typeof usage.arrayBuffers === "number") {
    fields.arrayBuffersKb = bytesToKb(usage.arrayBuffers);
  }
  return fields;
}

/**
 * 单行 `key=value` 格式：固定内存字段在前，计数器按字典序在后，全部取整。
 * 例：`[memory] role=main reason=first rssKb=1 heapUsedKb=2 app.windows=1`
 */
export function formatMemorySampleLine(
  sample: MemorySample,
  reason: MemorySampleWriteReason,
): string {
  const parts = [`[memory]`, `role=${sample.role}`, `reason=${reason}`];
  for (const field of MEMORY_FIELD_ORDER) {
    const value = sample[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      parts.push(`${field}=${Math.round(value)}`);
    }
  }
  for (const key of Object.keys(sample.counters).sort()) {
    const value = sample.counters[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      parts.push(`${key}=${Math.round(value)}`);
    }
  }
  return parts.join(" ");
}

export type MemoryDiagnosticsProvider = () => Record<string, number>;

export interface MemoryDiagnosticsRegistry {
  /** 同名重复注册时后者覆盖前者；返回的 dispose 只在仍是自己时才移除。 */
  register(name: string, provider: MemoryDiagnosticsProvider): { dispose(): void };
  /** 逐个调用 provider，键以 `<name>.` 为前缀；单个 provider 抛错只跳过它自己。 */
  collect(): Record<string, number>;
}

export function createMemoryDiagnosticsRegistry(): MemoryDiagnosticsRegistry {
  const providers = new Map<string, MemoryDiagnosticsProvider>();
  return {
    register(name, provider) {
      providers.set(name, provider);
      return {
        dispose() {
          if (providers.get(name) === provider) {
            providers.delete(name);
          }
        },
      };
    },
    collect() {
      const result: Record<string, number> = {};
      for (const [name, provider] of providers) {
        try {
          for (const [key, value] of Object.entries(provider())) {
            if (typeof value === "number" && Number.isFinite(value)) {
              result[`${name}.${key}`] = value;
            }
          }
        } catch {
          // 诊断 provider 只做纯读取；任一 provider 异常不能影响其他计数器或业务。
        }
      }
      return result;
    },
  };
}
