import { mkdtemp, readdir, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionId, createToolCallId } from "@zcode/contracts";
import {
  createStorageFsFaultInjector,
  resetStorageFsFaultInjectorForTests,
  setStorageFsFaultInjectorForTests,
} from "../src/storage/fs-fault-injection.js";
import { createNodeToolArtifactStore } from "../src/storage/index.js";

describe("Node tool artifact store", () => {
  afterEach(() => {
    resetStorageFsFaultInjectorForTests();
  });

  it("persists tool result artifacts under a session directory", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(rootDir, "image-cache"),
      rootDir,
      videoCacheRootDir: join(rootDir, "video-cache"),
    });

    try {
      const result = await store.writeToolResultArtifact({
        sessionId: createSessionId("artifact-session"),
        toolCallId: createToolCallId("artifact-call"),
        toolName: "BigTool",
        content: "large output",
        contentType: "text/plain",
        retention: "session",
      });

      expect(result.uri).toContain("zcode-artifact://");
      expect(result.path).toBeDefined();
      expect(result.bytes).toBe(Buffer.byteLength("large output", "utf8"));
      await expect(readFile(result.path!, "utf8")).resolves.toBe("large output");

      const read = await store.readToolResultArtifact({ uri: result.uri });
      expect(read).toMatchObject({
        bytes: Buffer.byteLength("large output", "utf8"),
        content: "large output",
        contentType: "text/plain",
        uri: result.uri,
      });

      await expect(store.statToolResultArtifact!({ uri: result.uri })).resolves.toMatchObject({
        uri: result.uri,
        bytes: Buffer.byteLength("large output", "utf8"),
        contentType: "text/plain",
        path: result.path,
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  // 上传附件以 data URL 文本落盘；stat 必须给出解码后的字节数，且不读入整段正文。
  it("reports the decoded payload size of data URL artifacts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(rootDir, "image-cache"),
      rootDir,
      videoCacheRootDir: join(rootDir, "video-cache"),
    });
    const sessionId = createSessionId("artifact-session");

    try {
      // 3/4/5 字节分别对应 base64 无填充、两个 `=`、一个 `=`。
      for (const length of [3, 4, 5]) {
        const bytes = Buffer.from(Array.from({ length }, (_, index) => index + 1));
        const artifact = await store.writeToolResultArtifact({
          sessionId,
          toolCallId: createToolCallId(`data-url-${length}`),
          toolName: "prompt-attachment:upload",
          content: `data:image/png;base64,${bytes.toString("base64")}`,
          contentType: "text/plain",
          retention: "session",
        });
        await expect(
          store.statToolResultArtifact!({ uri: artifact.uri }),
        ).resolves.toMatchObject({ dataUrlPayloadBytes: length });
      }

      const plain = await store.writeToolResultArtifact({
        sessionId,
        toolCallId: createToolCallId("plain-text"),
        toolName: "BigTool",
        content: "large output",
        contentType: "text/plain",
        retention: "session",
      });
      const plainStat = await store.statToolResultArtifact!({ uri: plain.uri });
      expect(plainStat.dataUrlPayloadBytes).toBeUndefined();
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("injects fs faults before text artifact writes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(rootDir, "image-cache"),
      rootDir,
      videoCacheRootDir: join(rootDir, "video-cache"),
    });
    const sessionId = createSessionId("artifact-session");

    setStorageFsFaultInjectorForTests(
      createStorageFsFaultInjector([
        {
          id: "D05-artifact-write-enospc",
          code: "ENOSPC",
          operations: ["writeFile"],
          pathRegex: "tool-result-.*\\.txt$",
        },
      ]),
    );

    try {
      await expect(
        store.writeToolResultArtifact({
          sessionId,
          toolCallId: createToolCallId("artifact-call"),
          toolName: "BigTool",
          content: "large output",
          contentType: "text/plain",
          retention: "session",
        }),
      ).rejects.toMatchObject({
        code: "ENOSPC",
        syscall: "writeFile",
        zcodeFsFaultId: "D05-artifact-write-enospc",
      });

      await expect(readdir(join(rootDir, sessionId))).resolves.toEqual([]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("persists binary tool result artifacts without text encoding", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(rootDir, "image-cache"),
      rootDir,
      videoCacheRootDir: join(rootDir, "video-cache"),
    });
    const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);

    try {
      const result = await store.writeToolResultBinaryArtifact!({
        sessionId: createSessionId("artifact-session"),
        toolCallId: createToolCallId("artifact-call"),
        toolName: "McpScreenshot",
        content: pngBytes,
        contentType: "image/png",
        extension: ".png",
        retention: "session",
      });

      expect(result.path).toBeDefined();
      expect(result.path).toMatch(/\.png$/);
      expect(result.bytes).toBe(pngBytes.byteLength);
      expect(result.contentType).toBe("image/png");
      await expect(readFile(result.path!)).resolves.toEqual(Buffer.from(pngBytes));

      const read = await store.readToolResultArtifact({ uri: result.uri });
      expect(read).toMatchObject({
        bytes: pngBytes.byteLength,
        content: Buffer.from(pngBytes).toString("base64"),
        contentType: "image/png",
        uri: result.uri,
      });

      const rawBytes = Uint8Array.from([0x00, 0x01, 0x02, 0x03]);
      const rawResult = await store.writeToolResultBinaryArtifact!({
        sessionId: createSessionId("artifact-session"),
        toolCallId: createToolCallId("raw-call"),
        toolName: "RawBytes",
        content: rawBytes,
        contentType: "application/octet-stream",
        retention: "session",
      });

      expect(rawResult.path).toMatch(/\.bin$/);
      const rawRead = await store.readToolResultArtifact({ uri: rawResult.uri });
      expect(rawRead).toMatchObject({
        bytes: rawBytes.byteLength,
        content: Buffer.from(rawBytes).toString("base64"),
        contentType: "application/octet-stream",
        uri: rawResult.uri,
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  // Bug 根因（2026-09-04）：文本读回按文件名推 contentType，办公文件扩展名不在表里 → 当作
  // application/json 走 utf8 解码 → 字节损坏。二进制读回返回原始字节，不经任何编码。
  it("reads binary artifacts back as raw bytes regardless of extension", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(rootDir, "image-cache"),
      rootDir,
      videoCacheRootDir: join(rootDir, "video-cache"),
    });
    // 含无效 utf8 序列（0xff 0xfe）与 NUL：任何文本解码都会改写它。
    const xlsxLikeBytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0xc3, 0x28]);

    try {
      const written = await store.writeToolResultBinaryArtifact!({
        sessionId: createSessionId("artifact-session"),
        toolCallId: createToolCallId("dwfrun-1:artifact#1@1"),
        toolName: "CreateWorkflow",
        content: xlsxLikeBytes,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        extension: ".xlsx",
        retention: "project",
      });
      expect(written.path).toMatch(/\.xlsx$/);

      const read = await store.readToolResultBinaryArtifact!({ uri: written.uri });
      expect(Array.from(read.bytes)).toEqual(Array.from(xlsxLikeBytes));
      expect(read.uri).toBe(written.uri);
      expect(read.path).toBe(written.path);
      // 文件名推断只是兜底：办公扩展名给 octet-stream，绝不再给 application/json。
      expect(read.contentType).toBe("application/octet-stream");

      // 对照：文本读回在同一文件上的确会损坏（这是二进制读回存在的理由）。
      const text = await store.readToolResultArtifact({ uri: written.uri });
      expect(text.contentType).toBe("application/octet-stream");
      expect(text.content).toBe(Buffer.from(xlsxLikeBytes).toString("base64"));

      // 同一会话目录下不存在的 artifactId：定位失败要报「not found」，不是裸 ENOENT。
      await expect(
        store.readToolResultBinaryArtifact!({
          uri: written.uri.replace(/tool-result-[^/]+$/, "tool-result-missing"),
        }),
      ).rejects.toThrow(/not found/);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("primes one derived image path and rebuilds it from the durable data URL artifact", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const rootDir = join(tempRoot, "artifacts");
    const imageCacheRootDir = join(tempRoot, "image-cache");
    const store = createNodeToolArtifactStore({
      imageCacheRootDir,
      rootDir,
      videoCacheRootDir: join(tempRoot, "video-cache"),
    });
    const sessionId = createSessionId("artifact-image-cache");
    const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x01]);

    try {
      const artifact = await store.writeToolResultArtifact({
        sessionId,
        toolCallId: createToolCallId("prompt-image"),
        toolName: "prompt-attachment:upload",
        content: `data:image/png;base64,${Buffer.from(imageBytes).toString("base64")}`,
        contentType: "text/plain",
        retention: "session",
      });

      const primePromise = store.primeImageAttachmentPath!({
        bytes: imageBytes,
        mediaType: "image/png",
        uri: artifact.uri,
      });
      const ensurePromise = store.ensureMediaAttachmentPath!({
        mediaType: "image/png",
        uri: artifact.uri,
      });
      expect(ensurePromise).toBe(primePromise);
      const [primed, ensured] = await Promise.all([primePromise, ensurePromise]);
      if (primed.status !== "ready" || ensured.status !== "ready") {
        throw new Error("expected supported PNG image paths");
      }

      expect(dirname(artifact.path!)).toBe(join(rootDir, sessionId));
      expect(dirname(primed.path)).toBe(join(imageCacheRootDir, sessionId));
      expect(primed.path).toBe(ensured.path);
      expect(primed.path).toMatch(/\.png$/);
      await expect(readFile(primed.path)).resolves.toEqual(Buffer.from(imageBytes));
      expect(
        (await readdir(join(imageCacheRootDir, sessionId))).filter((name) => name.endsWith(".png")),
      ).toHaveLength(1);

      await unlink(primed.path);
      const rebuilt = await store.ensureMediaAttachmentPath!({
        mediaType: "image/png",
        uri: artifact.uri,
      });

      expect(rebuilt).toEqual({ status: "ready", path: primed.path });
      if (rebuilt.status !== "ready") throw new Error("expected rebuilt PNG image path");
      await expect(readFile(rebuilt.path)).resolves.toEqual(Buffer.from(imageBytes));
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("materializes one video path and rebuilds it from the durable data URL artifact", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const rootDir = join(tempRoot, "artifacts");
    const videoCacheRootDir = join(tempRoot, "video-cache");
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(tempRoot, "image-cache"),
      rootDir,
      videoCacheRootDir,
    });
    const sessionId = createSessionId("artifact-video-cache");
    const videoBytes = Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

    try {
      const artifact = await store.writeToolResultArtifact({
        sessionId,
        toolCallId: createToolCallId("prompt-video"),
        toolName: "prompt-attachment:upload",
        content: `data:video/mp4;base64,${Buffer.from(videoBytes).toString("base64")}`,
        contentType: "text/plain",
        retention: "session",
      });

      const first = store.ensureMediaAttachmentPath!({
        mediaType: "video/mp4",
        uri: artifact.uri,
      });
      const second = store.ensureMediaAttachmentPath!({
        mediaType: "video/mp4",
        uri: artifact.uri,
      });
      expect(second).toBe(first);
      const materialized = await first;
      if (materialized.status !== "ready") throw new Error("expected supported MP4 video path");

      expect(dirname(materialized.path)).toBe(join(videoCacheRootDir, sessionId));
      expect(materialized.path).toMatch(/\.mp4$/);
      await expect(readFile(materialized.path)).resolves.toEqual(Buffer.from(videoBytes));

      await unlink(materialized.path);
      const rebuilt = await store.ensureMediaAttachmentPath!({
        mediaType: "video/mp4",
        uri: artifact.uri,
      });

      expect(rebuilt).toEqual({ status: "ready", path: materialized.path });
      if (rebuilt.status !== "ready") throw new Error("expected rebuilt MP4 video path");
      await expect(readFile(rebuilt.path)).resolves.toEqual(Buffer.from(videoBytes));
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("materializes one PDF path and rebuilds it from the durable data URL artifact", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const rootDir = join(tempRoot, "artifacts");
    const pdfCacheRootDir = join(tempRoot, "pdf-cache");
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(tempRoot, "image-cache"),
      pdfCacheRootDir,
      rootDir,
      videoCacheRootDir: join(tempRoot, "video-cache"),
    });
    const sessionId = createSessionId("artifact-pdf-cache");
    const pdfBytes = Buffer.from("%PDF-1.7\\nbody");

    try {
      const artifact = await store.writeToolResultArtifact({
        sessionId,
        toolCallId: createToolCallId("prompt-pdf"),
        toolName: "prompt-attachment:pdf",
        content: `data:application/pdf;base64,${pdfBytes.toString("base64")}`,
        contentType: "text/plain",
        retention: "session",
      });

      const first = store.ensureMediaAttachmentPath!({
        mediaType: "application/pdf",
        uri: artifact.uri,
      });
      const second = store.ensureMediaAttachmentPath!({
        mediaType: "application/pdf",
        uri: artifact.uri,
      });
      expect(second).toBe(first);
      const materialized = await first;
      if (materialized.status !== "ready") throw new Error("expected supported PDF path");

      expect(dirname(materialized.path)).toBe(join(pdfCacheRootDir, sessionId));
      expect(materialized.path).toMatch(/\.pdf$/);
      await expect(readFile(materialized.path)).resolves.toEqual(pdfBytes);

      await unlink(materialized.path);
      const rebuilt = await store.ensureMediaAttachmentPath!({
        mediaType: "application/pdf",
        uri: artifact.uri,
      });

      expect(rebuilt).toEqual({ status: "ready", path: materialized.path });
      if (rebuilt.status !== "ready") throw new Error("expected rebuilt PDF path");
      await expect(readFile(rebuilt.path)).resolves.toEqual(pdfBytes);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("skips unsupported image cache media types without interrupting the attachment flow", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const imageCacheRootDir = join(rootDir, "image-cache");
    const store = createNodeToolArtifactStore({
      imageCacheRootDir,
      rootDir,
      videoCacheRootDir: join(rootDir, "video-cache"),
    });
    const sessionId = createSessionId("artifact-unsupported-image-cache");
    const imageBytes = Uint8Array.from([0x42, 0x4d, 0x01, 0x02]);

    try {
      const artifact = await store.writeToolResultArtifact({
        sessionId,
        toolCallId: createToolCallId("prompt-image"),
        toolName: "prompt-attachment:upload",
        content: `data:image/bmp;base64,${Buffer.from(imageBytes).toString("base64")}`,
        contentType: "text/plain",
        retention: "session",
      });

      const primePromise = store.primeImageAttachmentPath!({
        bytes: imageBytes,
        mediaType: "image/bmp",
        uri: artifact.uri,
      });
      const ensurePromise = store.ensureMediaAttachmentPath!({
        mediaType: "image/bmp",
        uri: artifact.uri,
      });

      expect(ensurePromise).toBe(primePromise);
      await expect(primePromise).resolves.toEqual({ status: "unsupported" });
      await expect(
        store.ensureMediaAttachmentPath!({
          mediaType: "image/bmp",
          uri: artifact.uri,
        }),
      ).resolves.toEqual({ status: "unsupported" });
      await expect(readdir(join(imageCacheRootDir, sessionId))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("injects fs faults before binary artifact directory creation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(rootDir, "image-cache"),
      rootDir,
      videoCacheRootDir: join(rootDir, "video-cache"),
    });
    const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

    setStorageFsFaultInjectorForTests(
      createStorageFsFaultInjector([
        {
          id: "D05-artifact-mkdir-eacces",
          code: "EACCES",
          operations: ["mkdir"],
          pathIncludes: rootDir,
        },
      ]),
    );

    try {
      await expect(
        store.writeToolResultBinaryArtifact!({
          sessionId: createSessionId("artifact-session"),
          toolCallId: createToolCallId("artifact-call"),
          toolName: "McpScreenshot",
          content: pngBytes,
          contentType: "image/png",
          extension: ".png",
          retention: "session",
        }),
      ).rejects.toMatchObject({
        code: "EACCES",
        syscall: "mkdir",
        zcodeFsFaultId: "D05-artifact-mkdir-eacces",
      });

      await expect(readdir(rootDir)).resolves.toEqual([]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});
