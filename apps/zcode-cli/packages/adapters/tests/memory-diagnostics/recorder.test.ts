import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  createMemoryDiagnosticRecorder,
  writeMemoryDiagnostic,
} from "../../src/memory-diagnostics/index.js";
import {
  sanitizeCliMemoryDiagnostic,
  CLI_MEMORY_MAX_FILES,
  CLI_MEMORY_MAX_FILE_BYTES,
  type CliMemoryDiagnostic,
} from "@zcode/shared";

const profile = {
  head: {
    id: 1,
    selfSize: 0,
    callFrame: { functionName: "", url: "", lineNumber: 0, columnNumber: 0 },
    children: [
      {
        id: 2,
        selfSize: 2097152,
        callFrame: { functionName: "grow", url: "/app/zcode.cjs", lineNumber: 5, columnNumber: 32 },
        children: [],
      },
    ],
  },
  samples: [],
};
const metadata = {
  instanceId: "00000000-0000-4000-8000-000000000000",
  pid: 123,
  version: "3.18.1",
  commit: "abcdef01",
  node: "24.21.0",
  v8: "15.2",
  bundleSha256: "a".repeat(64),
};
function fixture(measure: () => number = () => 0, heapUsed = 50) {
  let now = 0;
  const profiler = {
    start: vi.fn(async () => {}),
    read: vi.fn(async () => profile),
    reset: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  const write = vi.fn(async (_record: CliMemoryDiagnostic) => {});
  const recorder = createMemoryDiagnosticRecorder({
    metadata: () => metadata,
    bundlePath: "/app/zcode.cjs",
    profiler,
    write,
    readMemory: () => ({
      rss: 100,
      heapUsed,
      heapTotal: 80,
      external: 20,
      arrayBuffers: 10,
      heapLimit: 200,
    }),
    readCounters: () => ({ sessions: 2 }),
    now: () => now,
    measure,
  });
  return {
    recorder,
    profiler,
    write,
    advance: (n: number) => {
      now += n;
    },
  };
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("bounded CLI memory evidence", () => {
  it("keeps bounded history, bundle locations and resets the V8 sampling window", async () => {
    const f = fixture();
    await f.recorder.start();
    for (let i = 0; i < 12; i++) {
      f.advance(15000);
      await f.recorder.sample();
    }
    const last = f.write.mock.calls.at(-1)![0];
    expect(last.samples).toHaveLength(8);
    expect(last.allocations[0]).toMatchObject({
      bytes: 2097152,
      stack: [{ name: "grow", line: 5, column: 32 }],
    });
    expect(JSON.stringify(last)).not.toContain("/app/");
    expect(f.profiler.reset).toHaveBeenCalledTimes(3);
    f.recorder.stop();
  });
  it("drops overlapping reads and ignores a profile that completes after stop", async () => {
    const f = fixture();
    await f.recorder.start();
    let resolve!: (value: typeof profile) => void;
    f.profiler.read.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = f.recorder.sample();
    await f.recorder.sample();
    f.recorder.stop();
    resolve(profile);
    await pending;
    expect(f.write).not.toHaveBeenCalled();
    expect(f.profiler.read).toHaveBeenCalledTimes(1);
    expect(f.profiler.dispose).toHaveBeenCalledTimes(1);
  });
  it("disables expensive profiling and keeps metrics after an oversized profile", async () => {
    const f = fixture();
    await f.recorder.start();
    f.profiler.read.mockResolvedValueOnce({
      ...profile,
      head: { ...profile.head, children: new Array(4100).fill(profile.head.children[0]) },
    });
    await f.recorder.sample();
    await f.recorder.sample();
    expect(f.profiler.read).toHaveBeenCalledTimes(1);
    expect(f.write.mock.calls.at(-1)![0].sampler.state).toBe("budget-exceeded");
    expect(f.write.mock.calls.at(-1)![0].samples).toHaveLength(2);
  });
  it("opens the performance circuit after a slow checkpoint", async () => {
    let elapsed = 0;
    const f = fixture(() => elapsed);
    await f.recorder.start();
    f.profiler.read.mockImplementationOnce(async () => {
      elapsed = 30;
      return profile;
    });
    await f.recorder.sample();
    await f.recorder.sample();
    expect(f.profiler.read).toHaveBeenCalledTimes(1);
    expect(f.write.mock.calls.at(-1)![0].sampler.state).toBe("budget-exceeded");
    f.recorder.stop();
  });
  it("does not materialize a profile when the heap is near its limit", async () => {
    const f = fixture(() => 0, 170);
    await f.recorder.start();
    await f.recorder.sample();
    expect(f.profiler.read).not.toHaveBeenCalled();
    expect(f.write.mock.calls[0]![0].sampler.state).toBe("budget-exceeded");
    expect(f.write.mock.calls[0]![0].samples[0].heapUsed).toBe(170);
    f.recorder.stop();
  });
  it("drops ticks while a write is pending instead of retaining a write queue", async () => {
    const f = fixture();
    await f.recorder.start();
    let finish!: () => void;
    f.write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.recorder.sample();
    await Promise.resolve();
    f.advance(60000);
    for (let i = 0; i < 50; i++) await f.recorder.sample();
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.profiler.read).toHaveBeenCalledTimes(1);
    expect(f.profiler.dispose).toHaveBeenCalledTimes(1);
    finish();
    await pending;
    f.recorder.stop();
  });
  it("retains external memory metrics when the inspector is unavailable", async () => {
    const f = fixture();
    f.profiler.start.mockRejectedValueOnce(new Error("unsupported"));
    await f.recorder.start();
    await f.recorder.sample();
    const record = f.write.mock.calls[0]![0];
    expect(record.sampler.state).toBe("unsupported");
    expect(record.samples[0].external).toBe(20);
    expect(record.allocations).toEqual([]);
    f.recorder.stop();
  });
  it("keeps the last useful allocation evidence after the profiler fails", async () => {
    const f = fixture();
    await f.recorder.start();
    f.advance(15000);
    await f.recorder.sample();
    f.profiler.read.mockRejectedValueOnce(new Error("inspector stopped"));
    f.advance(15000);
    await f.recorder.sample();
    const last = f.write.mock.calls.at(-1)![0];
    expect(last.sampler.state).toBe("error");
    expect(last.sampler.profileCapturedAt).toBe(15000);
    expect(last.timestamp).toBe(30000);
    expect(last.allocations[0].stack[0].name).toBe("grow");
    f.recorder.stop();
  });
  it("keeps useful numbers and strips unexpected content from uploaded records", async () => {
    const f = fixture();
    await f.recorder.start();
    await f.recorder.sample();
    const raw = {
      ...f.write.mock.calls[0]![0],
      prompt: "private",
      source: "private",
      environment: { token: "private" },
    };
    raw.allocations[0].stack[0].name = "/Users/private/token";
    const safe = sanitizeCliMemoryDiagnostic(raw)!;
    expect(JSON.stringify(safe)).not.toContain("private");
    expect(safe.allocations[0].stack[0].column).toBe(32);
  });
  it("caps retained files across restarts and removes abandoned temporary files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-memory-test-"));
    directories.push(directory);
    const f = fixture();
    await f.recorder.start();
    await f.recorder.sample();
    const record = f.write.mock.calls[0]![0];
    await writeFile(join(directory, ".memory-abandoned.tmp"), "old");
    for (let i = 0; i < 24; i++)
      await writeMemoryDiagnostic(directory, {
        ...record,
        instanceId: randomUUID(),
        timestamp: Date.now() + i,
      });
    const names = await readdir(directory);
    const files = names.filter((name) => name.endsWith(".jsonl"));
    expect(files).toHaveLength(CLI_MEMORY_MAX_FILES);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
    for (const name of files) {
      expect((await stat(join(directory, name))).size).toBeLessThanOrEqual(
        CLI_MEMORY_MAX_FILE_BYTES,
      );
      expect(
        sanitizeCliMemoryDiagnostic(JSON.parse(await readFile(join(directory, name), "utf8"))),
      ).not.toBeNull();
    }
    for (let i = 0; i < 12; i++) await writeMemoryDiagnostic(directory, record);
    const finalNames = await readdir(directory);
    expect(
      finalNames.filter((name) => name.endsWith("-" + record.instanceId + ".jsonl")).length,
    ).toBeLessThanOrEqual(2);
    expect(finalNames.filter((name) => name.endsWith(".jsonl")).length).toBeLessThanOrEqual(
      CLI_MEMORY_MAX_FILES,
    );
  });
});
