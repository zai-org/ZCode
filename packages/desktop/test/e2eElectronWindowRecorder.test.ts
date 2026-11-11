import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isElectronRecordingEncoderAvailable,
  startElectronWindowRecording,
} from "./e2e/helpers/electron-window-recorder.js";
import { runElectronRecordingCommand } from "./e2e/helpers/electron-window-recorder-timeout.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("Electron window recorder", () => {
  it("records renderer frames through Electron capturePage metadata", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-electron-recorder-"));
    tempDirs.push(tempDir);
    const outputPath = join(tempDir, "electron-repro.webm");
    const encodedFrameCounts: number[] = [];

    const session = await startElectronWindowRecording({
      captureFrame: async () => Buffer.from("fake-png-frame"),
      encodeVideo: async ({ framePaths, outputPath: encodedOutputPath }) => {
        encodedFrameCounts.push(framePaths.length);
        await readFile(framePaths[0]);
        await writeFile(encodedOutputPath, "fake-webm");
      },
      frameIntervalMs: 60_000,
      outputPath,
    });

    const result = await session.stop();

    expect(result.captureMode).toBe("electron_capture_page");
    expect(result.videoPath).toBe(outputPath);
    expect(result.frameCount).toBeGreaterThanOrEqual(2);
    expect(encodedFrameCounts).toEqual([result.frameCount]);
    await expect(readFile(outputPath, "utf8")).resolves.toBe("fake-webm");
  });

  it("discards passing-case frames without invoking the encoder", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-electron-recorder-"));
    tempDirs.push(tempDir);
    const outputPath = join(tempDir, "electron-repro.webm");
    const frameDir = join(tempDir, "frames");
    const encodeVideo = vi.fn();

    const session = await startElectronWindowRecording({
      captureFrame: async () => Buffer.from("fake-png-frame"),
      encodeVideo,
      frameDir,
      frameIntervalMs: 60_000,
      outputPath,
    });

    await session.discard();

    expect(encodeVideo).not.toHaveBeenCalled();
    await expect(access(frameDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("collects a pre-roll before allowing the case to start", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-electron-recorder-"));
    tempDirs.push(tempDir);
    const startedAt = Date.now();
    const session = await startElectronWindowRecording({
      captureFrame: async () => Buffer.from("fake-png-frame"),
      frameIntervalMs: 100,
      outputPath: join(tempDir, "electron-repro.webm"),
      preRollDurationMs: 120,
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    await session.discard();
  });

  it("keeps the video timeline aligned with the case when later captures are missed", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-electron-recorder-"));
    tempDirs.push(tempDir);
    const outputPath = join(tempDir, "electron-repro.webm");
    const encodedFrameCounts: number[] = [];
    let captureAttempts = 0;

    const session = await startElectronWindowRecording({
      captureFrame: async () => {
        captureAttempts += 1;
        if (captureAttempts === 1) {
          return Buffer.from("first-frame");
        }
        throw new Error("capturePage became unavailable");
      },
      encodeVideo: async ({ framePaths, outputPath: encodedOutputPath }) => {
        encodedFrameCounts.push(framePaths.length);
        await writeFile(encodedOutputPath, "fake-webm");
      },
      frameIntervalMs: 100,
      outputPath,
    });

    await new Promise((resolveWait) => setTimeout(resolveWait, 240));
    const result = await session.stop();

    expect(result.frameCount).toBeGreaterThanOrEqual(3);
    expect(encodedFrameCounts).toEqual([result.frameCount]);
    expect(result.captureError).toContain("capturePage became unavailable");
  });

  it("bounds a capturePage request that never settles", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-electron-recorder-"));
    tempDirs.push(tempDir);
    const startedAt = Date.now();

    await expect(
      startElectronWindowRecording({
        captureFrame: () => new Promise<Buffer>(() => undefined),
        captureTimeoutMs: 30,
        outputPath: join(tempDir, "electron-repro.webm"),
      }),
    ).rejects.toThrow("frame capture timed out after 30ms");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("bounds a custom encoder that never settles", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-electron-recorder-"));
    tempDirs.push(tempDir);
    const session = await startElectronWindowRecording({
      captureFrame: async () => Buffer.from("fake-png-frame"),
      encodeTimeoutMs: 30,
      encodeVideo: () => new Promise<void>(() => undefined),
      frameIntervalMs: 60_000,
      outputPath: join(tempDir, "electron-repro.webm"),
      stopTimeoutMs: 100,
    });

    await expect(session.stop()).rejects.toThrow("video encoding timed out after 30ms");
  });

  it("bounds the complete stop path even while tail recording", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-electron-recorder-"));
    tempDirs.push(tempDir);
    const session = await startElectronWindowRecording({
      captureFrame: async () => Buffer.from("fake-png-frame"),
      frameIntervalMs: 60_000,
      outputPath: join(tempDir, "electron-repro.webm"),
      stopTimeoutMs: 30,
    });

    await expect(session.stop({ tailDurationMs: 1_000 })).rejects.toThrow(
      "recording stop timed out after 30ms",
    );
  });

  it("reports a missing encoder instead of failing the case at stop time", async () => {
    // CI runner 没有 ffmpeg 时，录屏只是证据通道，调用方据此跳过录屏而不是让行为用例失败。
    await expect(
      isElectronRecordingEncoderAvailable(join(tmpdir(), "zcode-missing-ffmpeg-binary")),
    ).resolves.toBe(false);
  });

  it("treats an encoder whose -version exits non-zero as unavailable", async () => {
    // 回归：探测曾在 spawn 成功后立即返回 true；node 能启动但 `node -version` 以非零码退出，
    // 这类损坏或错配的编码器会在 stop() 编码时才失败，把证据通道问题记成行为失败。
    await expect(isElectronRecordingEncoderAvailable(process.execPath)).resolves.toBe(false);
  });

  it("kills a recording command that exceeds its timeout", async () => {
    await expect(
      runElectronRecordingCommand(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
        timeoutMs: 100,
      }),
    ).rejects.toThrow("timed out after 100ms");
  });
});
