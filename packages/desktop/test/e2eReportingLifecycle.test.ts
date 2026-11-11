import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createE2EReporter } from "./e2e/reporting/e2e-reporting";
import type {
  E2ELifecycleEvent,
  E2ELifecycleSummary,
} from "./e2e/reporting/e2e-reporting-types.js";

const createdDirs: string[] = [];

async function createArtifactsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zcode-e2e-reporting-lifecycle-"));
  createdDirs.push(dir);
  return dir;
}

describe("desktop e2e reporting lifecycle", () => {
  afterEach(async () => {
    await Promise.all(
      createdDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
    );
  });

  it("compacts completed process coverage after each case instead of waiting for worker exit", async () => {
    const artifactsDir = await createArtifactsDir();
    const previous = {
      coverage: process.env.ZCODE_E2E_COVERAGE,
      artifacts: process.env.ZCODE_E2E_ARTIFACT_DIR,
    };
    process.env.ZCODE_E2E_COVERAGE = "1";
    process.env.ZCODE_E2E_ARTIFACT_DIR = artifactsDir;
    try {
      const reporter = createE2EReporter({
        containerE2E: false,
        desktopDir: artifactsDir,
        repoRoot: process.cwd(),
        requestedSpecs: [],
      });
      await reporter.prepare([]);
      const rawFile = path.join(artifactsDir, "coverage", "raw", "main", "coverage-123.json");
      await writeFile(rawFile, JSON.stringify({ result: [] }));
      reporter.recordTestResult({ title: "case after reload" }, { duration: 1, passed: true });
      const raw = JSON.parse(await readFile(rawFile, "utf8"));
      expect(raw["zcode-e2e-normalized-source-map-root"]).toBe(
        path.join(artifactsDir, "out", "main").replaceAll("\\", "/"),
      );
      expect(raw.result).toEqual([]);
      const result = JSON.parse(
        (await readFile(path.join(artifactsDir, "test-results.ndjson"), "utf8")).trim(),
      );
      expect(result.passed).toBe(true);
    } finally {
      for (const [name, value] of [
        ["ZCODE_E2E_COVERAGE", previous.coverage],
        ["ZCODE_E2E_ARTIFACT_DIR", previous.artifacts],
      ]) {
        if (value === undefined) delete process.env[name!];
        else process.env[name!] = value;
      }
    }
  });

  it("appends lifecycle ndjson and aggregates by phase", async () => {
    const artifactsDir = await createArtifactsDir();
    process.env.ZCODE_E2E_ARTIFACT_DIR = artifactsDir;
    const reporter = createE2EReporter({
      containerE2E: false,
      desktopDir: artifactsDir,
      repoRoot: process.cwd(),
      requestedSpecs: [],
    }) as {
      prepare: (specs: string[]) => Promise<void> | void;
      recordLifecycleEvent?: (event: E2ELifecycleEvent) => void;
      writeSummary: (exitCode: number) => Promise<void> | void;
    };

    await reporter.prepare([
      "./test/e2e/infrastructure/smoke/container-boot.test.ts",
      "./test/e2e/conversation-session/composer/conversation-session-first-send.test.ts",
    ]);

    expect(reporter.recordLifecycleEvent).toBeTypeOf("function");

    reporter.recordLifecycleEvent?.({
      completedAt: "2026-07-10T00:00:01.000Z",
      durationMs: 10,
      phase: "prepare",
      specs: ["./test/e2e/infrastructure/smoke/container-boot.test.ts"],
      startedAt: "2026-07-10T00:00:00.990Z",
    });
    reporter.recordLifecycleEvent?.({
      cid: "worker-1",
      completedAt: "2026-07-10T00:00:03.000Z",
      durationMs: 20,
      phase: "before-session",
      specs: ["./test/e2e/infrastructure/smoke/container-boot.test.ts"],
      startedAt: "2026-07-10T00:00:02.980Z",
    });
    reporter.recordLifecycleEvent?.({
      cid: "worker-1",
      completedAt: "2026-07-10T00:00:04.000Z",
      durationMs: 30,
      phase: "before-session",
      specs: ["./test/e2e/infrastructure/smoke/container-boot.test.ts"],
      startedAt: "2026-07-10T00:00:03.970Z",
    });
    reporter.recordLifecycleEvent?.({
      cid: "worker-1",
      completedAt: "2026-07-10T00:00:05.000Z",
      durationMs: 40,
      phase: "worker",
      specs: ["./test/e2e/infrastructure/smoke/container-boot.test.ts"],
      startedAt: "2026-07-10T00:00:04.960Z",
    });

    await reporter.writeSummary(0);

    const lifecycleEventsPath = path.join(artifactsDir, "lifecycle-events.ndjson");
    const summaryPath = path.join(artifactsDir, "summary.json");

    const lifecycleEvents = await readFile(lifecycleEventsPath, "utf8");
    expect(lifecycleEvents.trim().split("\n")).toHaveLength(4);

    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
      lifecycle?: E2ELifecycleSummary;
    };

    expect(summary.lifecycle?.byPhase?.prepare).toEqual({
      count: 1,
      p50Ms: 10,
      p95Ms: 10,
      totalMs: 10,
    });
    expect(summary.lifecycle?.byPhase?.["before-session"]).toEqual({
      count: 2,
      p50Ms: 20,
      p95Ms: 30,
      totalMs: 50,
    });
    expect(summary.lifecycle?.byPhase?.worker).toEqual({
      count: 1,
      p50Ms: 40,
      p95Ms: 40,
      totalMs: 40,
    });
  });

  it("keeps lifecycle events even when summary is never written", async () => {
    const artifactsDir = await createArtifactsDir();
    process.env.ZCODE_E2E_ARTIFACT_DIR = artifactsDir;
    const reporter = createE2EReporter({
      containerE2E: false,
      desktopDir: artifactsDir,
      repoRoot: process.cwd(),
      requestedSpecs: [],
    }) as {
      prepare: (specs: string[]) => Promise<void> | void;
      recordLifecycleEvent?: (event: {
        completedAt: string;
        durationMs: number;
        phase: "after";
        specs: string[];
        startedAt: string;
      }) => void;
    };

    await reporter.prepare(["./test/e2e/infrastructure/smoke/container-boot.test.ts"]);

    expect(reporter.recordLifecycleEvent).toBeTypeOf("function");

    reporter.recordLifecycleEvent?.({
      completedAt: "2026-07-10T00:00:05.000Z",
      durationMs: 40,
      phase: "after",
      specs: ["./test/e2e/infrastructure/smoke/container-boot.test.ts"],
      startedAt: "2026-07-10T00:00:04.960Z",
    });

    const lifecycleEvents = await readFile(
      path.join(artifactsDir, "lifecycle-events.ndjson"),
      "utf8",
    );

    expect(lifecycleEvents.trim().split("\n")).toHaveLength(1);
  });

  it("records bounded failure-artifact collection errors without replacing the test result", async () => {
    const artifactsDir = await createArtifactsDir();
    process.env.ZCODE_E2E_ARTIFACT_DIR = artifactsDir;
    const reporter = createE2EReporter({
      containerE2E: false,
      desktopDir: artifactsDir,
      repoRoot: process.cwd(),
      requestedSpecs: [],
    });
    await reporter.prepare(["./test/e2e/infrastructure/smoke/container-boot.test.ts"]);

    reporter.recordTestResult(
      { title: "keeps the original assertion" },
      {
        duration: 12,
        error: new Error("original assertion failed"),
        passed: false,
        status: "failed",
      },
      undefined,
      ["failure artifacts: collection timed out after 60000ms"],
    );

    const result = JSON.parse(
      (await readFile(path.join(artifactsDir, "test-results.ndjson"), "utf8")).trim(),
    ) as {
      collectionErrors?: string[];
      error?: string;
      passed: boolean;
    };
    expect(result).toMatchObject({
      collectionErrors: ["failure artifacts: collection timed out after 60000ms"],
      error: "original assertion failed",
      passed: false,
    });
  });
});
