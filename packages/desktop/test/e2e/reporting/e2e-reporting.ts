/* eslint-disable max-lines -- E2E reporter 集中维护同一 run 的生命周期、结果、性能与覆盖率聚合，拆分会增加跨 hook 状态同步。 */
import { mkdirSync } from "node:fs";
import { arch, cpus, platform, release, totalmem, version } from "node:os";
import { resolve } from "node:path";
import {
  appendJsonLine,
  formatRunId,
  normalizeSpecs,
  sanitizeFilePart,
  writeE2ESummary,
  writeJson,
} from "./e2e-reporting-summary.js";
import type {
  CIMetadata,
  E2ELifecycleEvent,
  E2ERunScope,
  ErrorCategory,
  OSMetadata,
  ProcessMetricSample,
  TestResultLine,
  VersionsMetadata,
} from "./e2e-reporting-types.js";
import type { E2EFailureArtifactRefs } from "./e2e-failure-artifacts.js";
import { writeE2ECoverageHeatmap } from "./e2e-coverage-heatmap.js";
import { createE2EUICoverageCollector } from "./e2e-ui-coverage.js";
import { createE2ENodeCoverageCollector } from "./e2e-node-coverage.js";

interface E2EReporterOptions {
  repoRoot: string;
  desktopDir: string;
  requestedSpecs: string[];
  containerE2E: boolean;
}

interface WdioTestLike {
  file?: string;
  fullName?: string;
  fullTitle?: string;
  title: string;
  _currentRetry?: number;
  _retries?: number;
}

interface WdioTestResultLike {
  duration: number;
  error?: unknown;
  passed: boolean;
  /** WDIO 9 的 afterTest 用它表示 Mocha this.skip()；这时 passed=false 且没有 status。 */
  skipped?: boolean;
  status?: string;
}

/**
 * afterTest 结果的统一状态。
 *
 * Bug 原因：WDIO 9 对 this.skip() 只给 skipped=true、passed=false，不给 status；
 * 逐条结果因此只剩 passed=false，测试池等下游把平台专属的跳过当成失败。
 */
export function resolveWdioTestStatus(
  result: Pick<WdioTestResultLike, "passed" | "skipped" | "status">,
): string {
  if (result.skipped) return "skipped";
  return result.status ?? (result.passed ? "passed" : "failed");
}

export function isSkippedWdioStatus(status: string): boolean {
  return status === "skipped" || status === "pending";
}

function includesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

function isE2EInfraError(lower: string): boolean {
  return includesAny(lower, [
    "session not created",
    "econnrefused",
    "e2e-bridge-preflight",
    // 修复原因：ChromeDriver target 元数据仍可能显示 file://，但 renderer 的实际
    // document 已经是错误页；这属于 session/renderer 基建失效，不是产品断言。
    "chrome-error://chromewebdata/",
    "webdriver-page-handle-url-mismatch",
    "未找到可切换的工作区 renderer target",
    "chromedriver",
    "net::err_connection",
    "xvfb",
    "no such session",
    "enotfound",
    "socket hang up",
    "store-api-missing",
    "store-missing",
    "missing-e2e-store-bridge",
    "session-store-bridge-missing",
    "session-bridge-missing",
    "session-state-method-missing",
    "task-workspace-not-found",
    "注入失败",
    "seed failed",
    "默认工作区没有打开到可交互会话界面",
    "element could not be located",
  ]);
}

export function classifyError(error: string | undefined): ErrorCategory {
  if (!error) return "unknown";
  const lower = error.toLowerCase();

  // 修复原因：E2E helper / store bridge / workspace fixture 的前置失败过去会被
  // not found / selector 文案误归为 assertion，导致 CI 基础设施问题污染产品断言趋势。
  if (isE2EInfraError(lower)) {
    return "infra";
  }
  if (
    lower.includes("crashed") ||
    lower.includes("target closed") ||
    lower.includes("disconnected") ||
    lower.includes("renderer process") ||
    lower.includes("gpu process")
  ) {
    return "crash";
  }
  if (
    lower.includes("timeout") ||
    lower.includes("waituntil") ||
    lower.includes("timed out") ||
    lower.includes("wait until")
  ) {
    return "timeout";
  }
  if (
    lower.includes("expect") ||
    lower.includes("assert") ||
    lower.includes("tobetruthy") ||
    lower.includes("tobe(") ||
    lower.includes("toequal") ||
    lower.includes("tohave") ||
    lower.includes("not found") ||
    lower.includes("element could not be located")
  ) {
    return "assertion";
  }
  return "unknown";
}

function inferFeatureArea(file: string | undefined): string {
  if (!file) return "unknown";
  const normalized = file.replace(/\\/g, "/");

  const patterns: [RegExp, string][] = [
    [/conversation-session/, "conversation"],
    [/smoke/, "smoke"],
    [/container-boot/, "container"],
    [/upstream-provider/, "provider"],
    [/remote/, "remote"],
    [/settings/, "settings"],
    [/workspace/, "workspace"],
    [/agent/, "agent"],
    [/auth/, "auth"],
  ];

  for (const [pattern, area] of patterns) {
    if (pattern.test(normalized)) return area;
  }
  return "general";
}

function collectCIMetadata(): CIMetadata | undefined {
  if (!process.env.GITLAB_CI) return undefined;
  return {
    provider: "gitlab",
    pipelineId: process.env.CI_PIPELINE_ID,
    jobId: process.env.CI_JOB_ID,
    jobName: process.env.CI_JOB_NAME,
    commitSha: process.env.CI_COMMIT_SHA,
    branch: process.env.CI_COMMIT_REF_NAME,
    mrIid: process.env.CI_MERGE_REQUEST_IID,
    projectUrl: process.env.CI_PROJECT_URL,
    triggeredBy: process.env.CI_PIPELINE_SOURCE,
    startedAt: process.env.CI_JOB_STARTED_AT,
    runnerDescription: process.env.CI_RUNNER_DESCRIPTION,
  };
}

// 规格：docs/testing/e2e-failure-artifact-report-upload.md「运行类型」。manifest 是唯一数据源：
// Windows 全量由 Linux 汇总 job 上传，那里没有分片的 job 变量，上传时不能再读环境变量。
function readRunScope(): E2ERunScope | undefined {
  const value = process.env.ZCODE_E2E_RUN_SCOPE?.trim();
  return value === "full" || value === "incremental" ? value : undefined;
}

function collectOSMetadata(): OSMetadata {
  const p = platform();
  const osNames: Record<string, string> = {
    darwin: "macOS",
    win32: "Windows",
    linux: "Linux",
  };

  let displayServer: string | undefined;
  if (p === "linux") {
    displayServer = process.env.WAYLAND_DISPLAY
      ? "wayland"
      : process.env.DISPLAY
        ? "x11"
        : undefined;
  } else if (p === "darwin") {
    displayServer = "quartz";
  }

  return {
    name: osNames[p] ?? p,
    version: release(),
    // Bugfix（!3612 评审 CR-01）：Windows 全量结果改由 Linux 汇总 job 上传，上传机读不到运行机器的产品名，
    // windows_version 曾固定退回内核 build。产品名在运行机器上写入 manifest，上传方只读这里。
    // os.version() 在进程内读取（如 "Windows 11 Pro"），不随系统 locale 变化，不需要起 PowerShell。
    description: p === "win32" ? version() : undefined,
    displayServer,
  };
}

function collectVersionsMetadata(): VersionsMetadata {
  return {
    electron: process.versions.electron,
    chromium: process.versions.chrome,
  };
}

const DEFAULT_PROCESS_SAMPLE_INTERVAL_MS = 3000;

export function createE2EReporter(options: E2EReporterOptions) {
  const startedAt = new Date();
  const runId = sanitizeFilePart(process.env.ZCODE_E2E_RUN_ID?.trim() || formatRunId(startedAt));
  process.env.ZCODE_E2E_RUN_ID = runId;

  const artifactDir = resolve(
    process.env.ZCODE_E2E_ARTIFACT_DIR?.trim() ||
      resolve(options.desktopDir, ".e2e-artifacts", runId),
  );
  process.env.ZCODE_E2E_ARTIFACT_DIR = artifactDir;

  const perfDir = resolve(artifactDir, "perf");
  const testsPath = resolve(artifactDir, "test-results.ndjson");
  const lifecycleEventsPath = resolve(artifactDir, "lifecycle-events.ndjson");
  const manifestPath = resolve(artifactDir, "manifest.json");
  const summaryJsonPath = resolve(artifactDir, "summary.json");
  const summaryMdPath = resolve(artifactDir, "summary.md");
  const containerSamplesPath = resolve(perfDir, "container-samples.ndjson");
  const uiCoverage = createE2EUICoverageCollector({
    artifactDir,
    repoRoot: options.repoRoot,
  });
  const nodeCoverage = createE2ENodeCoverageCollector({
    artifactDir,
    desktopDir: options.desktopDir,
    repoRoot: options.repoRoot,
  });
  const processSampleIntervalMs = Number(
    process.env.ZCODE_E2E_PERF_SAMPLE_INTERVAL_MS ?? DEFAULT_PROCESS_SAMPLE_INTERVAL_MS,
  );
  let processSampleTimer: ReturnType<typeof setInterval> | null = null;
  let processSamplingActive = false;

  const ensureDirs = () => {
    mkdirSync(perfDir, { recursive: true });
  };

  const processSamplePath = () => {
    const workerId = sanitizeFilePart(process.env.ZCODE_E2E_WORKER_ID ?? "main");
    return resolve(perfDir, `process-samples-${workerId}.ndjson`);
  };

  const sampleProcessMetrics = async (sessionBrowser: WebdriverIO.Browser, specs: string[]) => {
    if (processSamplingActive) {
      return;
    }
    processSamplingActive = true;
    try {
      const workerId = process.env.ZCODE_E2E_WORKER_ID ?? "main";
      const sample = await sessionBrowser.electron.execute((electron) => {
        return {
          capturedAt: new Date().toISOString(),
          mainPid: process.pid,
          metrics: electron.app.getAppMetrics().map((metric) => ({
            cpuPercent: metric.cpu.percentCPUUsage,
            idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
            memoryPeakWorkingSetKb: metric.memory.peakWorkingSetSize,
            memoryPrivateBytes: metric.memory.privateBytes,
            memoryWorkingSetKb: metric.memory.workingSetSize,
            name: metric.name,
            pid: metric.pid,
            serviceName: metric.serviceName,
            type: metric.type,
          })),
          windows: electron.BrowserWindow.getAllWindows()
            .filter((win) => !win.isDestroyed())
            .map((win) => ({
              id: win.id,
              pid: win.webContents.getOSProcessId(),
              title: win.getTitle(),
              url: win.webContents.getURL(),
              visible: win.isVisible(),
            })),
        };
      });

      // Bugfix（2026-11-18 mac E2E）：App 重启/退出瞬间 electron.execute 可能返回 undefined 而不抛错，
      // 展开后只剩 specs/workerId 的半条样本会让汇总 .reduce 崩溃、整次运行写不出 summary.json。
      // 没有 metrics 就不是样本，记到采样错误里。
      if (!Array.isArray((sample as { metrics?: unknown } | undefined)?.metrics)) {
        throw new Error("process sample returned no metrics (app restarting or quitting)");
      }
      appendJsonLine(processSamplePath(), {
        ...(sample as Omit<ProcessMetricSample, "workerId" | "specs">),
        specs: normalizeSpecs(specs),
        workerId,
      } satisfies ProcessMetricSample);
    } catch (error) {
      appendJsonLine(resolve(perfDir, "process-sampling-errors.ndjson"), {
        capturedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        workerId: process.env.ZCODE_E2E_WORKER_ID ?? "main",
      });
    } finally {
      processSamplingActive = false;
    }
  };

  return {
    artifactDir,
    perfDir,
    runId,

    prepare(specs: string[]) {
      ensureDirs();
      uiCoverage.prepare();
      nodeCoverage.prepare();
      writeJson(manifestPath, {
        configuredSpecs: normalizeSpecs(specs),
        containerE2E: options.containerE2E,
        coverage: {
          cli: nodeCoverage.enabled,
          host: nodeCoverage.enabled,
          main: nodeCoverage.enabled,
          uiRenderer: uiCoverage.enabled,
        },
        desktopDir: options.desktopDir,
        environment: {
          arch: arch(),
          cpuModel: cpus()[0]?.model ?? "unknown",
          node: process.version,
          platform: platform(),
          totalMemoryBytes: totalmem(),
        },
        ci: collectCIMetadata(),
        os: collectOSMetadata(),
        versions: collectVersionsMetadata(),
        repoRoot: options.repoRoot,
        requestedSpecs: options.requestedSpecs,
        runId,
        runScope: readRunScope(),
        sampleIntervalMs: processSampleIntervalMs,
        startedAt: startedAt.toISOString(),
      });
    },

    beforeSession(cid: string, specs: string[]) {
      ensureDirs();
      process.env.ZCODE_E2E_WORKER_ID = cid;
      nodeCoverage.beforeSession();
      const runtimeLogDir = resolve(artifactDir, "runtime-logs", sanitizeFilePart(cid));
      // 修复原因：并行 WDIO worker 若共享同一个按日日志文件，失败 case 只能按时间猜测
      // 来源且会串入其他 worker。测试态将 desktop 与 agent 日志落到 worker 专属目录。
      process.env.ZCODE_E2E_RUNTIME_LOG_DIR = resolve(runtimeLogDir, "desktop");
      process.env.ZCODE_LOG_DIR = resolve(runtimeLogDir, "agent");
      appendJsonLine(resolve(artifactDir, "workers.ndjson"), {
        capturedAt: new Date().toISOString(),
        cid,
        specs: normalizeSpecs(specs),
      });
    },

    async startProcessSampling(sessionBrowser: WebdriverIO.Browser, specs: string[]) {
      // 修复原因：采样从 beforeTest 启动后，多 case 会重复进入这里；
      // 复用已有 timer，避免同一个 worker 写出多组重叠样本。
      if (processSampleTimer) {
        return;
      }
      ensureDirs();
      await sampleProcessMetrics(sessionBrowser, specs);
      processSampleTimer = setInterval(
        () => {
          void sampleProcessMetrics(sessionBrowser, specs);
        },
        Math.max(1000, processSampleIntervalMs),
      );
    },

    async startUICoverage(sessionBrowser: WebdriverIO.Browser) {
      await uiCoverage.start(sessionBrowser);
    },

    async stopProcessSampling(sessionBrowser: WebdriverIO.Browser, specs: string[]) {
      if (processSampleTimer) {
        clearInterval(processSampleTimer);
        processSampleTimer = null;
      }
      await sampleProcessMetrics(sessionBrowser, specs);
    },

    async stopUICoverage() {
      await uiCoverage.stop();
    },

    compactNodeCoverage() {
      nodeCoverage.compactRawCoverage();
    },

    async snapshotUICoverage() {
      await uiCoverage.snapshot();
    },

    recordTestResult(
      test: WdioTestLike,
      result: WdioTestResultLike,
      failureArtifacts?: E2EFailureArtifactRefs,
      collectionErrors: string[] = [],
    ) {
      ensureDirs();
      const errorMessage = result.error
        ? result.error instanceof Error
          ? result.error.message
          : String(result.error)
        : undefined;
      const errorStack =
        result.error instanceof Error ? result.error.stack?.slice(0, 2000) : undefined;
      const retryIndex = test._currentRetry ?? 0;
      const retryLimit = test._retries ?? 0;
      const status = resolveWdioTestStatus(result);
      const settled = result.passed || isSkippedWdioStatus(status);

      const allCollectionErrors = [
        ...(failureArtifacts?.collectionErrors ?? []),
        ...collectionErrors,
      ];
      try {
        // 同一 spec 内 reloadSession 不触发 worker 结束；重复 source map 曾堆满磁盘。
        // 复用按不可变文件增量归一化，保留 counters，不等待整个 spec 才压缩冗余映射。
        nodeCoverage.compactRawCoverage();
      } catch (error) {
        allCollectionErrors.push(
          `node coverage compaction: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      appendJsonLine(testsPath, {
        capturedAt: new Date().toISOString(),
        collectionErrors: allCollectionErrors.length > 0 ? allCollectionErrors : undefined,
        durationMs: result.duration,
        error: errorMessage,
        errorCategory: settled ? undefined : classifyError(errorMessage),
        errorStack: settled ? undefined : errorStack,
        failureArtifacts,
        featureArea: inferFeatureArea(test.file),
        file: test.file,
        fullTitle: test.fullTitle || test.fullName || test.title,
        passed: result.passed,
        passedOnRetry: result.passed && retryIndex > 0,
        retryIndex,
        retryLimit,
        status,
        title: test.title,
      } satisfies TestResultLine);
    },

    recordLifecycleEvent(event: E2ELifecycleEvent) {
      ensureDirs();
      appendJsonLine(lifecycleEventsPath, {
        ...event,
        specs: normalizeSpecs(event.specs),
      } satisfies E2ELifecycleEvent);
    },

    writeSummary(exitCode: number) {
      ensureDirs();
      const uiRenderer = uiCoverage.finalize();
      const node = nodeCoverage.finalize();
      const coverageSummaryPath = resolve(artifactDir, "coverage", "summary.json");
      const heatmap =
        uiRenderer || node
          ? writeE2ECoverageHeatmap({
              coverageDir: resolve(artifactDir, "coverage"),
              repoRoot: options.repoRoot,
            })
          : undefined;
      if (uiRenderer || node) {
        writeJson(coverageSummaryPath, {
          complete: Boolean(uiRenderer?.complete && node?.complete),
          enabled: true,
          generatedAt: new Date().toISOString(),
          heatmap,
          node,
          renderer: uiRenderer,
        });
      }
      writeE2ESummary({
        artifactDir,
        coverageSummaryPath,
        containerE2E: options.containerE2E,
        containerSamplesPath,
        exitCode,
        lifecycleEventsPath,
        manifestPath,
        perfDir,
        requestedSpecs: options.requestedSpecs,
        runId,
        startedAt,
        summaryJsonPath,
        summaryMdPath,
        testsPath,
      });
    },
  };
}
