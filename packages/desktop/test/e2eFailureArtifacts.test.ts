import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  E2EFailureArtifactCollector,
  materializeLogDeltas,
  snapshotLogOffsets,
} from "./e2e/reporting/e2e-failure-artifacts.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("E2E failure artifacts", () => {
  it("copies only log bytes emitted by the current case", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-e2e-failure-artifacts-"));
    tempDirs.push(tempDir);
    const runtimeLogs = join(tempDir, "runtime-logs");
    const outputDir = join(tempDir, "failure", "logs");
    const desktopLog = join(runtimeLogs, "desktop", "2026-07-13.log");
    const agentLog = join(runtimeLogs, "agent", "zcode-2026-07-13.jsonl");

    await mkdir(join(runtimeLogs, "desktop"), { recursive: true });
    await mkdir(join(runtimeLogs, "agent"), { recursive: true });
    await writeFile(desktopLog, "before-desktop\n", { encoding: "utf-8", flag: "w" });
    const offsets = await snapshotLogOffsets(runtimeLogs);
    await writeFile(desktopLog, "case-desktop\n", { encoding: "utf-8", flag: "a" });
    await writeFile(agentLog, "case-agent\n", { encoding: "utf-8", flag: "w" });

    const copied = await materializeLogDeltas({
      afterRoot: runtimeLogs,
      beforeOffsets: offsets,
      outputDir,
    });

    expect(copied).toEqual([
      { path: join("agent", "zcode-2026-07-13.jsonl"), truncated: false },
      { path: join("desktop", "2026-07-13.log"), truncated: false },
    ]);
    await expect(readFile(join(outputDir, "desktop", "2026-07-13.log"), "utf-8")).resolves.toBe(
      "case-desktop\n",
    );
    await expect(
      readFile(join(outputDir, "agent", "zcode-2026-07-13.jsonl"), "utf-8"),
    ).resolves.toBe("case-agent\n");
  });

  it("discards the capture of a skipped case instead of filing it as a failure", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-e2e-failure-artifacts-"));
    tempDirs.push(tempDir);
    // 录像依赖真实 Electron；假 browser 让录像失败并被记为采集错误，不影响跳过判定。
    const collector = new E2EFailureArtifactCollector({
      artifactDir: tempDir,
      browser: {} as WebdriverIO.Browser,
      enabled: true,
      workerId: "0-0",
    });
    const test = { title: "windows only case" };
    await collector.start(test);
    const refs = await collector.complete(test, {
      duration: 1,
      passed: false,
      status: "skipped",
    });
    expect(refs).toBeUndefined();
    const leftovers = await readdir(join(tempDir, "failures"), { recursive: true });
    expect(leftovers.filter((entry) => entry.includes("attempt-0"))).toEqual([]);
  });
});
