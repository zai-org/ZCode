import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { Session } from "node:inspector";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getHeapStatistics } from "node:v8";
import { CLI_MEMORY_DIAGNOSTIC_DIRECTORY, ZCODE_COMMIT, ZCODE_VERSION } from "@zcode/shared";
import {
  createMemoryDiagnosticRecorder,
  MEMORY_DIAGNOSTIC_INTERVAL_MS,
  MEMORY_SAMPLE_INTERVAL_BYTES,
} from "./recorder.js";
import { writeMemoryDiagnostic } from "./storage.js";
import type { AllocationNode, AllocationProfiler } from "./types.js";
import type { CliMemoryDiagnostics } from "./contract.js";
export { createMemoryDiagnosticRecorder } from "./recorder.js";
export { writeMemoryDiagnostic } from "./storage.js";
export type { MemoryDiagnosticOptions, MemoryDiagnosticRecorder } from "./types.js";

const MAX_HASH_BYTES = 128 * 1024 * 1024;
const SAMPLING_STACK_DEPTH = 16;
function createProfiler(): AllocationProfiler {
  const session = new Session();
  const post = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise((res, rej) =>
      session.post(method, params, (error, result) => (error ? rej(error) : res(result as T))),
    );
  const start = () =>
    post<void>("HeapProfiler.startSampling", {
      samplingInterval: MEMORY_SAMPLE_INTERVAL_BYTES,
      stackDepth: SAMPLING_STACK_DEPTH,
      includeObjectsCollectedByMajorGC: false,
      includeObjectsCollectedByMinorGC: false,
    });
  return {
    async start() {
      session.connect();
      await start();
    },
    async read() {
      return (await post<{ profile: { head: AllocationNode } }>("HeapProfiler.getSamplingProfile"))
        .profile;
    },
    async reset() {
      // disable 清除采样状态，不使用 stopSampling 再复制一次完整 profile。
      await post("HeapProfiler.disable");
      await start();
    },
    dispose() {
      session.disconnect();
    },
  };
}

async function hashBundle(path: string): Promise<string> {
  if ((await stat(path)).size > MAX_HASH_BYTES) return "";
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > MAX_HASH_BYTES) return "";
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** app-server 的独立诊断资源；不依赖 renderer、网络或业务日志级别。 */
export function startCliMemoryDiagnostics(
  readCounters: () => Record<string, number>,
  options: { directory?: string } = {},
): CliMemoryDiagnostics {
  let bundlePath = resolve(process.argv[1] ?? "");
  const metadata = {
    instanceId: randomUUID(),
    pid: process.pid,
    version: ZCODE_VERSION,
    commit: ZCODE_COMMIT,
    node: process.versions.node,
    v8: process.versions.v8,
    bundleSha256: "",
  };
  const recorder = createMemoryDiagnosticRecorder({
    get bundlePath() {
      return bundlePath;
    },
    metadata: () => metadata,
    readCounters,
    profiler: createProfiler(),
    readMemory: () => ({
      ...process.memoryUsage(),
      heapLimit: getHeapStatistics().heap_size_limit,
    }),
    write: (record) =>
      writeMemoryDiagnostic(
        options.directory ?? join(homedir(), ".zcode", "cli", CLI_MEMORY_DIAGNOSTIC_DIRECTORY),
        record,
      ),
  });
  // 哈希流式读取，不复制 bundle 到 JS 堆，也不挡住协议 ready。
  // macOS 的 /var、/tmp 等别名与 V8 返回的真实路径不同，需异步归一化再匹配采样帧。
  void realpath(bundlePath).then(
    (path) => {
      bundlePath = path;
    },
    () => {},
  );
  void hashBundle(bundlePath).then(
    (hash) => {
      metadata.bundleSha256 = hash;
    },
    () => {},
  );
  void recorder.start();
  const timer = setInterval(() => {
    void recorder.sample();
  }, MEMORY_DIAGNOSTIC_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      recorder.stop();
    },
  };
}
