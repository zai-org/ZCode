import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runElectronRecordingCommand, runWithTimeout } from "./electron-window-recorder-timeout.js";

export const ELECTRON_WINDOW_RECORDING_CAPTURE_MODE = "electron_capture_page";

const DEFAULT_CAPTURE_TIMEOUT_MS = 5_000;
const DEFAULT_ENCODE_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 45_000;
const MAX_RECORDING_TIMEOUT_MS = 5 * 60_000;

export interface ElectronWindowRecordingResult {
  captureError?: string;
  captureMode: typeof ELECTRON_WINDOW_RECORDING_CAPTURE_MODE;
  frameCount: number;
  videoPath: string;
}

export interface EncodeElectronWindowVideoInput {
  ffmpegPath: string;
  framePaths: string[];
  frameRate: number;
  outputPath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface StartElectronWindowRecordingOptions {
  browser?: WebdriverIO.Browser;
  captureFrame?: () => Promise<Buffer>;
  /** 单次 capturePage 请求的最大等待时间。 */
  captureTimeoutMs?: number;
  cleanupFrames?: boolean;
  encodeVideo?: (input: EncodeElectronWindowVideoInput) => Promise<void>;
  /** ffmpeg 或自定义编码器的最大等待时间。 */
  encodeTimeoutMs?: number;
  ffmpegPath?: string;
  frameDir?: string;
  frameIntervalMs?: number;
  outputPath?: string;
  /** 在返回录制 session 前先持续采集的时间，用于保留测试动作发生前的画面。 */
  preRollDurationMs?: number;
  /** stop() 从尾录制到编码完成的总预算。 */
  stopTimeoutMs?: number;
}

export interface StopElectronWindowRecordingOptions {
  /** 在测试结束后继续采集的时间，供失败证据保留异步 UI 收尾。 */
  tailDurationMs?: number;
  /** 覆盖 session 级 stop 总预算。 */
  timeoutMs?: number;
}

export interface ElectronWindowRecordingSession {
  captureMode: typeof ELECTRON_WINDOW_RECORDING_CAPTURE_MODE;
  discard: () => Promise<void>;
  stop: (options?: StopElectronWindowRecordingOptions) => Promise<ElectronWindowRecordingResult>;
  videoPath: string;
}

/** 录屏编码器默认路径；与 startElectronWindowRecording 的解析顺序一致。 */
export function resolveElectronRecordingFfmpegPath(ffmpegPath?: string): string {
  return ffmpegPath?.trim() || process.env.ZCODE_E2E_FFMPEG_PATH?.trim() || "ffmpeg";
}

/**
 * 判断录屏编码器可用：`ffmpeg -version` 必须在超时内以 0 退出。
 * 修复原因：正式用例在无 ffmpeg 的 runner 上会在 stop() 编码时报 spawn ENOENT，把只作证据的
 * 录屏失败记成行为失败；调用方先探测，不可用时跳过录屏并保留全部行为断言。
 * 只看 spawn 成功不够：能启动但损坏、错配或被策略拒绝的程序同样会在编码阶段失败，
 * 所以复用编码命令的执行器，按退出码、启动错误与超时统一判定。
 */
export async function isElectronRecordingEncoderAvailable(ffmpegPath?: string): Promise<boolean> {
  try {
    await runElectronRecordingCommand(
      resolveElectronRecordingFfmpegPath(ffmpegPath),
      ["-version"],
      {
        timeoutMs: 10_000,
      },
    );
    return true;
  } catch {
    return false;
  }
}

export async function startElectronWindowRecording(
  options: StartElectronWindowRecordingOptions = {},
): Promise<ElectronWindowRecordingSession> {
  const outputPath = resolveElectronRecordingOutputPath(options.outputPath);
  const frameDir = resolve(
    options.frameDir ?? join(tmpdir(), `zcode-electron-recording-${randomUUID()}`),
  );
  const frameIntervalMs = normalizeFrameIntervalMs(options.frameIntervalMs);
  const preRollDurationMs = normalizePreRollDurationMs(options.preRollDurationMs);
  const captureTimeoutMs = normalizeRecordingTimeoutMs(
    options.captureTimeoutMs,
    DEFAULT_CAPTURE_TIMEOUT_MS,
  );
  const encodeTimeoutMs = normalizeRecordingTimeoutMs(
    options.encodeTimeoutMs,
    DEFAULT_ENCODE_TIMEOUT_MS,
  );
  const configuredStopTimeoutMs = normalizeRecordingTimeoutMs(
    options.stopTimeoutMs,
    DEFAULT_STOP_TIMEOUT_MS,
  );
  const frameRate = Math.max(1, Math.round(1000 / frameIntervalMs));
  const ffmpegPath = resolveElectronRecordingFfmpegPath(options.ffmpegPath);
  const captureFrame = options.captureFrame ?? (() => captureElectronWindowFrame(options.browser));
  const encodeVideo = options.encodeVideo ?? encodeElectronWindowVideo;
  const cleanupFrames = options.cleanupFrames ?? true;
  const capturedFrames: Array<{ capturedAt: number; path: string }> = [];
  let startedAt = Date.now();
  let stopped = false;
  let pendingCapture: Promise<void> | null = null;
  let captureErrorCount = 0;
  let firstCaptureError: unknown;

  await mkdir(frameDir, { recursive: true });

  const captureOnce = async () => {
    if (stopped || pendingCapture) {
      return pendingCapture;
    }
    pendingCapture = (async () => {
      try {
        // 修复原因：窗口崩溃或 DevTools 断连时 capturePage 可能永不返回；单帧必须
        // 有独立上限，否则 discard/stop 会一直等待同一个 pendingCapture。
        const frame = await runWithTimeout(
          captureFrame,
          captureTimeoutMs,
          "Electron window frame capture",
        );
        if (stopped) {
          return;
        }
        const framePath = join(
          frameDir,
          `captured-${String(capturedFrames.length + 1).padStart(6, "0")}.png`,
        );
        await writeFile(framePath, frame);
        capturedFrames.push({ capturedAt: Date.now(), path: framePath });
      } catch (error) {
        firstCaptureError ??= error;
        captureErrorCount += 1;
      } finally {
        pendingCapture = null;
      }
    })();
    return pendingCapture;
  };

  await captureOnce();
  if (capturedFrames.length === 0) {
    throw asError(firstCaptureError, "Electron window recording could not capture the first frame");
  }
  startedAt = Date.now();

  const timer = setInterval(() => {
    void captureOnce();
  }, frameIntervalMs);

  if (preRollDurationMs > 0) {
    await waitFor(preRollDurationMs);
  }

  return {
    captureMode: ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
    videoPath: outputPath,
    async discard() {
      stopped = true;
      clearInterval(timer);
      const capture = pendingCapture;
      if (capture) {
        await runWithTimeout(
          () => capture,
          captureTimeoutMs,
          "Electron window pending capture discard",
        ).catch(() => undefined);
      }
      // 修复原因：失败录屏在 case 开始时先采帧，若通过 case 仍调用 stop 会无意义地
      // 启动 ffmpeg 编码。discard 只回收帧和可能残留的输出文件，避免通过用例产生视频。
      await Promise.all([
        rm(frameDir, { force: true, recursive: true }),
        rm(outputPath, { force: true }),
      ]);
    },
    async stop(stopOptions = {}) {
      const tailDurationMs = normalizeTailDurationMs(stopOptions.tailDurationMs);
      const stopTimeoutMs = normalizeRecordingTimeoutMs(
        stopOptions.timeoutMs,
        configuredStopTimeoutMs,
      );
      const stopController = new AbortController();

      try {
        return await runWithTimeout(
          async () => {
            if (tailDurationMs > 0) {
              await waitFor(tailDurationMs, stopController.signal);
            }
            await captureOnce();
            stopped = true;
            clearInterval(timer);
            const capture = pendingCapture;
            if (capture) {
              await capture;
            }
            if (capturedFrames.length === 0) {
              throw asError(firstCaptureError, "Electron window recording captured no frames");
            }
            // 修复原因：capturePage 是异步 CDP 请求，慢帧会被采样器跳过。之前编码器只按
            // 实际帧数计算时长，长 case 可能因只拿到首帧而被压缩为约 1 秒。按真实墙钟时间
            // 生成连续时间轴，缺失采样复用最近帧，才能使视频覆盖整个 case。
            const framePaths = await materializeRecordingTimeline({
              capturedFrames,
              frameDir,
              frameIntervalMs,
              startedAt,
              stoppedAt: Date.now(),
            });
            await mkdir(dirname(outputPath), { recursive: true });
            await runWithTimeout(
              () =>
                encodeVideo({
                  ffmpegPath,
                  framePaths: [...framePaths],
                  frameRate,
                  outputPath,
                  signal: stopController.signal,
                  timeoutMs: encodeTimeoutMs,
                }),
              encodeTimeoutMs,
              "Electron window video encoding",
              (error) => stopController.abort(error),
            );
            const outputStats = await stat(outputPath);
            if (outputStats.size <= 0) {
              throw new Error(`Electron window recording produced an empty video: ${outputPath}`);
            }
            if (cleanupFrames) {
              await rm(frameDir, { force: true, recursive: true });
            }
            return {
              captureError:
                captureErrorCount > 0
                  ? `${captureErrorCount} frame capture request(s) failed: ${asError(firstCaptureError, "unknown capture error").message}`
                  : undefined,
              captureMode: ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
              frameCount: framePaths.length,
              videoPath: outputPath,
            };
          },
          stopTimeoutMs,
          "Electron window recording stop",
          (error) => stopController.abort(error),
        );
      } finally {
        // 修复原因：总预算到期后即使底层 CDP promise 仍未 settle，也必须停止新采帧，
        // 让 WDIO afterTest 能继续进入资源清理和 summary 写入。
        stopped = true;
        clearInterval(timer);
      }
    },
  };
}

export function buildElectronRecordingFfmpegArgs(input: EncodeElectronWindowVideoInput): string[] {
  const firstFramePath = input.framePaths[0];
  if (!firstFramePath) {
    throw new Error("Electron window recording cannot encode without frames");
  }
  return [
    "-y",
    "-framerate",
    String(input.frameRate),
    "-i",
    join(dirname(firstFramePath), "frame-%06d.png"),
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    "yuv420p",
    "-deadline",
    "realtime",
    "-cpu-used",
    "5",
    input.outputPath,
  ];
}

async function captureElectronWindowFrame(
  maybeBrowser: WebdriverIO.Browser | undefined,
): Promise<Buffer> {
  const sessionBrowser =
    maybeBrowser ?? (globalThis as typeof globalThis & { browser?: WebdriverIO.Browser }).browser;
  if (!sessionBrowser?.electron) {
    throw new Error("Electron window recording requires a WDIO Electron browser session");
  }
  const pngBase64 = await sessionBrowser.electron.execute(async (electron) => {
    const windows = electron.BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed())
      .sort((left, right) => Number(right.isFocused()) - Number(left.isFocused()));
    const target = windows.find((win) => win.isVisible()) ?? windows[0];
    if (!target) {
      throw new Error("No Electron BrowserWindow is available for recording");
    }
    const image = await target.webContents.capturePage();
    if (image.isEmpty()) {
      throw new Error("Electron BrowserWindow capturePage returned an empty image");
    }
    return image.toPNG().toString("base64");
  });
  return Buffer.from(String(pngBase64), "base64");
}

async function encodeElectronWindowVideo(input: EncodeElectronWindowVideoInput): Promise<void> {
  await runElectronRecordingCommand(input.ffmpegPath, buildElectronRecordingFfmpegArgs(input), {
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
}

function normalizeFrameIntervalMs(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) {
    return 500;
  }
  return Math.max(100, Math.round(value));
}

function normalizeTailDurationMs(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) {
    return 0;
  }
  return Math.max(0, Math.min(10_000, Math.round(value)));
}

function normalizePreRollDurationMs(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) {
    return 0;
  }
  return Math.max(0, Math.min(10_000, Math.round(value)));
}

function normalizeRecordingTimeoutMs(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value) {
    return fallback;
  }
  return Math.max(1, Math.min(MAX_RECORDING_TIMEOUT_MS, Math.round(value)));
}

async function materializeRecordingTimeline(options: {
  capturedFrames: Array<{ capturedAt: number; path: string }>;
  frameDir: string;
  frameIntervalMs: number;
  startedAt: number;
  stoppedAt: number;
}): Promise<string[]> {
  const firstFrame = options.capturedFrames[0];
  if (!firstFrame) {
    throw new Error("Electron window recording lost the first captured frame");
  }
  const timelineDir = join(options.frameDir, "timeline");
  const durationMs = Math.max(0, options.stoppedAt - options.startedAt);
  const frameCount = Math.max(2, Math.ceil(durationMs / options.frameIntervalMs) + 1);
  const timelinePaths: string[] = [];
  let sourceIndex = 0;

  await mkdir(timelineDir, { recursive: true });
  for (let index = 0; index < frameCount; index += 1) {
    const timestamp = options.startedAt + index * options.frameIntervalMs;
    while (
      sourceIndex + 1 < options.capturedFrames.length &&
      (options.capturedFrames[sourceIndex + 1]?.capturedAt ?? Number.POSITIVE_INFINITY) <= timestamp
    ) {
      sourceIndex += 1;
    }
    const sourcePath = options.capturedFrames[sourceIndex]?.path ?? firstFrame.path;
    const timelinePath = join(timelineDir, `frame-${String(index + 1).padStart(6, "0")}.png`);
    await copyFile(sourcePath, timelinePath);
    timelinePaths.push(timelinePath);
  }
  return timelinePaths;
}

async function waitFor(durationMs: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolveWait, reject) => {
    if (signal?.aborted) {
      reject(asError(signal.reason, "Electron window recording wait aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolveWait();
    }, durationMs);
    const handleAbort = () => {
      clearTimeout(timer);
      reject(asError(signal?.reason, "Electron window recording wait aborted"));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function resolveElectronRecordingOutputPath(value: string | undefined): string {
  return resolve(
    value?.trim() ||
      process.env.CODEX_E2E_VIDEO_PATH?.trim() ||
      join(process.env.ZCODE_E2E_ARTIFACT_DIR?.trim() || process.cwd(), "electron-repro.webm"),
  );
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(value ? String(value) : fallback);
}
