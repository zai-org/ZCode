import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  startElectronWindowRecording,
  type ElectronWindowRecordingSession,
} from "../helpers/electron-window-recorder.js";

const MAX_CASE_LOG_BYTES_PER_FILE = 10 * 1024 * 1024;
const DEFAULT_FAILURE_VIDEO_FRAME_INTERVAL_MS = 250;
const DEFAULT_FAILURE_VIDEO_PRE_ROLL_MS = 2_000;
const DEFAULT_FAILURE_VIDEO_TAIL_MS = 2_000;
const DEFAULT_FAILURE_VIDEO_CAPTURE_TIMEOUT_MS = 5_000;
const DEFAULT_FAILURE_VIDEO_ENCODE_TIMEOUT_MS = 30_000;
const DEFAULT_FAILURE_VIDEO_STOP_TIMEOUT_MS = 45_000;
const FAILURE_LOG_COLLECTION_TIMEOUT_MS = 5_000;
const FAILURE_MANIFEST_WRITE_TIMEOUT_MS = 2_000;

export interface E2EFailureArtifactTest {
  file?: string;
  fullName?: string;
  fullTitle?: string;
  title: string;
  _currentRetry?: number;
  _retries?: number;
}

export interface E2EFailureArtifactResult {
  duration: number;
  error?: unknown;
  errorCategory?: string;
  passed: boolean;
  status: string;
}

export interface E2EFailureArtifactRefs {
  caseId: string;
  caseManifest: string;
  collectionErrors?: string[];
  logsIndex: string;
  retryIndex: number;
  video?: string;
  workerId: string;
}

interface ActiveCaseCapture {
  caseDir: string;
  caseId: string;
  caseTitle: string;
  logOffsets: Map<string, number>;
  recorder?: ElectronWindowRecordingSession;
  recordingError?: string;
  retryIndex: number;
  startedAt: string;
  workerId: string;
}

export interface E2EFailureArtifactCollectorOptions {
  artifactDir: string;
  browser: WebdriverIO.Browser;
  enabled?: boolean;
  workerId?: string;
}

/**
 * 为失败 case 收集独立的日志增量和窗口视频。
 *
 * 同一个 WDIO worker 内的 Mocha case 串行执行，因此通过每个 runtime log 的 byte
 * offset 截取 case 时间窗是确定性的；跨 worker 则由运行时日志根目录隔离保证。
 */
export class E2EFailureArtifactCollector {
  private readonly activeCaptures = new Map<string, ActiveCaseCapture>();
  private readonly artifactDir: string;
  private readonly browser: WebdriverIO.Browser;
  private readonly enabled: boolean;
  private readonly workerId: string;

  constructor(options: E2EFailureArtifactCollectorOptions) {
    this.artifactDir = resolve(options.artifactDir);
    this.browser = options.browser;
    this.enabled = options.enabled ?? process.env.ZCODE_E2E_FAILURE_ARTIFACTS === "1";
    this.workerId = sanitizeFilePart(options.workerId ?? process.env.ZCODE_E2E_WORKER_ID ?? "main");
  }

  async start(test: E2EFailureArtifactTest): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const caseTitle = getCaseTitle(test);
    const retryIndex = test._currentRetry ?? 0;
    const activeKey = getActiveKey(caseTitle, retryIndex);
    const caseId = createCaseId(caseTitle);
    const caseDir = resolve(
      this.artifactDir,
      "failures",
      this.workerId,
      caseId,
      `attempt-${retryIndex}`,
    );
    const runtimeLogDir = resolve(this.artifactDir, "runtime-logs", this.workerId);
    const activeCapture: ActiveCaseCapture = {
      caseDir,
      caseId,
      caseTitle,
      logOffsets: await snapshotLogOffsets(runtimeLogDir),
      retryIndex,
      startedAt: new Date().toISOString(),
      workerId: this.workerId,
    };

    await mkdir(caseDir, { recursive: true });
    try {
      activeCapture.recorder = await startElectronWindowRecording({
        browser: this.browser,
        captureTimeoutMs: readTimeoutEnv(
          "ZCODE_E2E_FAILURE_VIDEO_CAPTURE_TIMEOUT_MS",
          DEFAULT_FAILURE_VIDEO_CAPTURE_TIMEOUT_MS,
        ),
        encodeTimeoutMs: readTimeoutEnv(
          "ZCODE_E2E_FAILURE_VIDEO_ENCODE_TIMEOUT_MS",
          DEFAULT_FAILURE_VIDEO_ENCODE_TIMEOUT_MS,
        ),
        frameDir: join(caseDir, "frames"),
        frameIntervalMs: readDurationEnv(
          "ZCODE_E2E_FAILURE_VIDEO_FRAME_INTERVAL_MS",
          DEFAULT_FAILURE_VIDEO_FRAME_INTERVAL_MS,
        ),
        outputPath: join(caseDir, "video.webm"),
        preRollDurationMs: readDurationEnv(
          "ZCODE_E2E_FAILURE_VIDEO_PRE_ROLL_MS",
          DEFAULT_FAILURE_VIDEO_PRE_ROLL_MS,
        ),
        stopTimeoutMs: readTimeoutEnv(
          "ZCODE_E2E_FAILURE_VIDEO_STOP_TIMEOUT_MS",
          DEFAULT_FAILURE_VIDEO_STOP_TIMEOUT_MS,
        ),
      });
    } catch (error) {
      // 修复原因：录制依赖 Electron capturePage；窗口崩溃时录制失败不能覆盖原始断言或崩溃结果。
      activeCapture.recordingError = toErrorMessage(error);
    }
    this.activeCaptures.set(activeKey, activeCapture);
  }

  async complete(
    test: E2EFailureArtifactTest,
    result: E2EFailureArtifactResult,
  ): Promise<E2EFailureArtifactRefs | undefined> {
    if (!this.enabled) {
      return undefined;
    }

    const caseTitle = getCaseTitle(test);
    const retryIndex = test._currentRetry ?? 0;
    const activeKey = getActiveKey(caseTitle, retryIndex);
    const activeCapture = this.activeCaptures.get(activeKey);
    this.activeCaptures.delete(activeKey);
    if (!activeCapture) {
      return undefined;
    }

    // 跳过的 case 没有失败可查；按失败保留会留下空视频和 passed=false 的 case.json。
    if (result.passed || result.status === "skipped" || result.status === "pending") {
      await activeCapture.recorder?.discard().catch(() => undefined);
      await rm(activeCapture.caseDir, { force: true, recursive: true });
      return undefined;
    }

    const collectionErrors = activeCapture.recordingError ? [activeCapture.recordingError] : [];
    let videoPath: string | undefined;
    try {
      const recordingResult = await activeCapture.recorder?.stop({
        tailDurationMs: readDurationEnv(
          "ZCODE_E2E_FAILURE_VIDEO_TAIL_MS",
          DEFAULT_FAILURE_VIDEO_TAIL_MS,
        ),
      });
      if (recordingResult) {
        videoPath = relative(this.artifactDir, recordingResult.videoPath);
        if (recordingResult.captureError) {
          collectionErrors.push(`video: ${recordingResult.captureError}`);
        }
      }
    } catch (error) {
      collectionErrors.push(`video: ${toErrorMessage(error)}`);
    }

    const logsDir = join(activeCapture.caseDir, "logs");
    let logFiles: Array<{ path: string; truncated: boolean }> = [];
    try {
      await runWithTimeout(
        async () => {
          await mkdir(logsDir, { recursive: true });
          logFiles = await materializeLogDeltas({
            afterRoot: resolve(this.artifactDir, "runtime-logs", activeCapture.workerId),
            beforeOffsets: activeCapture.logOffsets,
            outputDir: logsDir,
          });
          await writeFile(
            join(logsDir, "index.json"),
            `${JSON.stringify({ files: logFiles }, null, 2)}\n`,
            "utf-8",
          );
        },
        FAILURE_LOG_COLLECTION_TIMEOUT_MS,
        "case log collection",
      );
    } catch (error) {
      collectionErrors.push(`logs: ${toErrorMessage(error)}`);
    }

    const caseManifestPath = join(activeCapture.caseDir, "case.json");
    const caseManifest = {
      artifacts: {
        logsIndex: relative(this.artifactDir, join(logsDir, "index.json")),
        video: videoPath,
      },
      caseId: activeCapture.caseId,
      collectionErrors,
      completedAt: new Date().toISOString(),
      result: {
        durationMs: result.duration,
        error: result.error ? toErrorMessage(result.error) : undefined,
        errorCategory: result.errorCategory,
        passed: false,
        status: result.status,
      },
      retryIndex: activeCapture.retryIndex,
      retryLimit: test._retries ?? 0,
      spec: test.file,
      startedAt: activeCapture.startedAt,
      title: activeCapture.caseTitle,
      version: 1,
      workerId: activeCapture.workerId,
    };
    try {
      await runWithTimeout(
        () => writeFile(caseManifestPath, `${JSON.stringify(caseManifest, null, 2)}\n`, "utf-8"),
        FAILURE_MANIFEST_WRITE_TIMEOUT_MS,
        "case manifest write",
      );
    } catch (error) {
      // 修复原因：诊断文件系统异常也不能拖住 afterTest；错误随 test result 返回，
      // 即使 case.json 无法落盘，summary 仍能说明采集失败原因。
      collectionErrors.push(`manifest: ${toErrorMessage(error)}`);
    }

    return {
      caseId: activeCapture.caseId,
      caseManifest: relative(this.artifactDir, caseManifestPath),
      collectionErrors: collectionErrors.length > 0 ? collectionErrors : undefined,
      logsIndex: relative(this.artifactDir, join(logsDir, "index.json")),
      retryIndex: activeCapture.retryIndex,
      video: videoPath,
      workerId: activeCapture.workerId,
    };
  }
}

export async function snapshotLogOffsets(rootDir: string): Promise<Map<string, number>> {
  const offsets = new Map<string, number>();
  for (const filePath of await listRegularFiles(rootDir)) {
    offsets.set(relative(rootDir, filePath), (await stat(filePath)).size);
  }
  return offsets;
}

export async function materializeLogDeltas(options: {
  afterRoot: string;
  beforeOffsets: Map<string, number>;
  outputDir: string;
}): Promise<Array<{ path: string; truncated: boolean }>> {
  const results: Array<{ path: string; truncated: boolean }> = [];
  for (const filePath of await listRegularFiles(options.afterRoot)) {
    const fileStats = await stat(filePath);
    const relativePath = relative(options.afterRoot, filePath);
    const start = Math.min(options.beforeOffsets.get(relativePath) ?? 0, fileStats.size);
    const availableBytes = fileStats.size - start;
    if (availableBytes <= 0) {
      continue;
    }

    const copiedBytes = Math.min(availableBytes, MAX_CASE_LOG_BYTES_PER_FILE);
    const destination = resolve(options.outputDir, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await pipeline(
      createReadStream(filePath, { end: start + copiedBytes - 1, start }),
      createWriteStream(destination),
    );
    results.push({ path: relativePath, truncated: copiedBytes < availableBytes });
  }
  return results;
}

async function listRegularFiles(rootDir: string): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    const paths = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(rootDir, entry.name);
        if (entry.isDirectory()) {
          return listRegularFiles(entryPath);
        }
        return entry.isFile() ? [entryPath] : [];
      }),
    );
    return paths.flat();
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

function createCaseId(title: string): string {
  return createHash("sha256").update(title).digest("hex").slice(0, 16);
}

function getActiveKey(title: string, retryIndex: number): string {
  return `${title}\u0000${retryIndex}`;
}

function getCaseTitle(test: E2EFailureArtifactTest): string {
  return test.fullTitle || test.fullName || test.title;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 100) || "main";
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readDurationEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(10_000, value));
}

function readTimeoutEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(5 * 60_000, value));
}

async function runWithTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
