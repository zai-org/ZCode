import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createE2EReporter, resolveWdioTestStatus } from "./e2e/reporting/e2e-reporting.js";
import { appendJsonLine, writeE2ESummary } from "./e2e/reporting/e2e-reporting-summary.js";
import type { TestResultLine } from "./e2e/reporting/e2e-reporting-types.js";

const tempDirs: string[] = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "e2e-summary-skipped-"));
  tempDirs.push(dir);
  return dir;
}

describe("e2e reporting summary skipped tests", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count WDIO skipped tests as failures", () => {
    const artifactDir = createTempDir();
    const testsPath = join(artifactDir, "test-results.ndjson");
    const summaryJsonPath = join(artifactDir, "summary.json");
    const summaryMdPath = join(artifactDir, "summary.md");

    appendJsonLine(testsPath, {
      capturedAt: "2026-07-09T00:00:00.000Z",
      durationMs: 0,
      fullTitle: "file tools POSIX executable bit",
      passed: false,
      status: "skipped",
      title: "file tools POSIX executable bit",
    } satisfies TestResultLine);
    appendJsonLine(testsPath, {
      capturedAt: "2026-07-09T00:00:01.000Z",
      durationMs: 100,
      fullTitle: "actual failing case",
      passed: false,
      status: "failed",
      title: "actual failing case",
      errorCategory: "assertion",
    } satisfies TestResultLine);
    appendJsonLine(testsPath, {
      capturedAt: "2026-07-09T00:00:02.000Z",
      durationMs: 50,
      fullTitle: "passing case",
      passed: true,
      status: "passed",
      title: "passing case",
    } satisfies TestResultLine);

    writeE2ESummary({
      artifactDir,
      containerE2E: false,
      containerSamplesPath: join(artifactDir, "container-samples.ndjson"),
      exitCode: 1,
      manifestPath: join(artifactDir, "manifest.json"),
      perfDir: join(artifactDir, "perf"),
      requestedSpecs: [],
      runId: "skipped-summary",
      startedAt: new Date("2026-07-09T00:00:00.000Z"),
      summaryJsonPath,
      summaryMdPath,
      testsPath,
    });

    const summary = JSON.parse(readFileSync(summaryJsonPath, "utf-8"));
    const summaryMd = readFileSync(summaryMdPath, "utf-8");

    expect(summary.tests.total).toBe(3);
    expect(summary.tests.passed).toBe(1);
    expect(summary.tests.failed).toBe(1);
    expect(summary.tests.skipped).toBe(1);
    expect(summary.stability.passRate).toBe(0.5);
    expect(summary.failureBreakdown.assertion).toBe(1);
    expect(summary.failureBreakdown.unknown).toBe(0);
    expect(summary.timing.caseDurationP50Ms).toBe(50);
    expect(summaryMd).toContain("- Skipped: `1`");
    expect(summaryMd).toContain("| SKIP | 0ms | file tools POSIX executable bit |");
  });

  it("treats legacy skipped rows without status as skipped", () => {
    const artifactDir = createTempDir();
    const testsPath = join(artifactDir, "test-results.ndjson");
    const summaryJsonPath = join(artifactDir, "summary.json");
    const summaryMdPath = join(artifactDir, "summary.md");

    appendJsonLine(testsPath, {
      capturedAt: "2026-07-09T00:00:00.000Z",
      durationMs: 0,
      errorCategory: "unknown",
      fullTitle: "Write 和 Edit 修改可执行脚本后应保留 POSIX 执行位",
      passed: false,
      title: "Write 和 Edit 修改可执行脚本后应保留 POSIX 执行位",
    });

    writeE2ESummary({
      artifactDir,
      containerE2E: false,
      containerSamplesPath: join(artifactDir, "container-samples.ndjson"),
      exitCode: 0,
      manifestPath: join(artifactDir, "manifest.json"),
      perfDir: join(artifactDir, "perf"),
      requestedSpecs: [],
      runId: "legacy-skipped-summary",
      startedAt: new Date("2026-07-09T00:00:00.000Z"),
      summaryJsonPath,
      summaryMdPath,
      testsPath,
    });

    const summary = JSON.parse(readFileSync(summaryJsonPath, "utf-8"));

    expect(summary.tests.total).toBe(1);
    expect(summary.tests.failed).toBe(0);
    expect(summary.tests.skipped).toBe(1);
    expect(summary.failureBreakdown.unknown).toBe(0);
  });

  it("resolves WDIO 9 afterTest results, which mark this.skip() only with skipped=true", () => {
    expect(resolveWdioTestStatus({ passed: false, skipped: true })).toBe("skipped");
    expect(resolveWdioTestStatus({ passed: true, skipped: false })).toBe("passed");
    expect(resolveWdioTestStatus({ passed: false, skipped: false })).toBe("failed");
    expect(resolveWdioTestStatus({ passed: false, status: "pending" })).toBe("pending");
  });

  it("writes skipped per-case rows that downstream runners can read without guessing", () => {
    const artifactDir = createTempDir();
    const previous = process.env.ZCODE_E2E_ARTIFACT_DIR;
    process.env.ZCODE_E2E_ARTIFACT_DIR = artifactDir;
    try {
      const reporter = createE2EReporter({
        containerE2E: false,
        desktopDir: artifactDir,
        repoRoot: process.cwd(),
        requestedSpecs: [],
      });
      // WDIO 9 对 Mocha this.skip() 传给 afterTest 的真实形状：没有 status，只有 skipped。
      reporter.recordTestResult(
        { title: "windows only case" },
        { duration: 1, passed: false, skipped: true },
      );
      reporter.recordTestResult(
        { title: "real failure" },
        { duration: 5, error: new Error("expected 1 to be 2"), passed: false, skipped: false },
      );
      const rows = readFileSync(join(artifactDir, "test-results.ndjson"), "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows[0]).toMatchObject({ passed: false, status: "skipped" });
      expect(rows[0].errorCategory).toBeUndefined();
      expect(rows[1]).toMatchObject({ passed: false, status: "failed" });
      expect(rows[1].errorCategory).toBeDefined();
    } finally {
      if (previous === undefined) delete process.env.ZCODE_E2E_ARTIFACT_DIR;
      else process.env.ZCODE_E2E_ARTIFACT_DIR = previous;
    }
  });
});
