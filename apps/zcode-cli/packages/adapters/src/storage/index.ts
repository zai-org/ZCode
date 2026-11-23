// Storage adapters - EventStore, ArtifactStore, MemoryStore implementations

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ImageAttachmentPathPrimeRequest,
  MediaAttachmentPathPrimeRequest,
  MediaAttachmentPathEnsureRequest,
  MediaAttachmentPathResult,
  ToolBinaryArtifactWriteRequest,
  ToolArtifactStorePort,
  ToolArtifactReadRequest,
  ToolArtifactReadResult,
  ToolArtifactStatRequest,
  ToolArtifactStatResult,
  ToolArtifactWriteRequest,
  ToolArtifactWriteResult,
  ToolBinaryArtifactReadResult,
} from "@zcode/contracts";
import { maybeThrowStorageFsFault } from "./fs-fault-injection.js";

export * from "./session-store.js";
export * from "./session-data-files/index.js";

// 内存 event store 实现已下沉到 @zcode/contracts，
// 这里保持 `@zcode/adapters/storage` 的导出路径不变，避免调用方改 import。
export {
  InMemorySessionEventStore,
  createInMemorySessionEventStore,
  type InMemorySessionEventStoreOptions,
} from "@zcode/contracts";

export interface NodeToolArtifactStoreOptions {
  imageCacheRootDir: string;
  pdfCacheRootDir?: string;
  rootDir: string;
  videoCacheRootDir: string;
}

export class NodeToolArtifactStore implements ToolArtifactStorePort {
  private readonly imageCacheRootDir: string;
  private readonly pdfCacheRootDir: string;
  private readonly rootDir: string;
  private readonly videoCacheRootDir: string;
  private readonly mediaAttachmentPathFlights = new Map<
    string,
    Promise<MediaAttachmentPathResult>
  >();

  constructor(options: NodeToolArtifactStoreOptions) {
    this.imageCacheRootDir = options.imageCacheRootDir;
    this.rootDir = options.rootDir;
    this.pdfCacheRootDir = options.pdfCacheRootDir ?? join(dirname(options.rootDir), "pdf-cache");
    this.videoCacheRootDir = options.videoCacheRootDir;
  }

  async writeToolResultArtifact(
    request: ToolArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact write cancelled");
    }

    const artifactId = `tool-result-${crypto.randomUUID()}`;
    const contentType = request.contentType ?? "application/json";
    const extension = extensionForContentType(contentType);
    const sessionDir = join(this.rootDir, sanitizePathSegment(request.sessionId));
    const fileName = `${sanitizePathSegment(String(request.toolCallId))}-${artifactId}${extension}`;
    const path = join(sessionDir, fileName);

    maybeThrowStorageFsFault({ operation: "mkdir", path: sessionDir });
    await mkdir(sessionDir, { recursive: true });
    maybeThrowStorageFsFault({ operation: "writeFile", path });
    await writeFile(path, request.content, "utf8");

    return {
      id: artifactId,
      uri: `zcode-artifact://${encodeURIComponent(request.sessionId)}/${encodeURIComponent(artifactId)}`,
      path,
      bytes: Buffer.byteLength(request.content, "utf8"),
      contentType,
      createdAt: new Date(),
    };
  }

  async writeToolResultBinaryArtifact(
    request: ToolBinaryArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool binary artifact write cancelled");
    }

    const artifactId = `tool-result-${crypto.randomUUID()}`;
    const extension = normalizeArtifactExtension(
      request.extension ?? extensionForBinaryContentType(request.contentType),
    );
    const sessionDir = join(this.rootDir, sanitizePathSegment(request.sessionId));
    const fileName = `${sanitizePathSegment(String(request.toolCallId))}-${artifactId}${extension}`;
    const path = join(sessionDir, fileName);
    const content = Buffer.from(request.content);

    maybeThrowStorageFsFault({ operation: "mkdir", path: sessionDir });
    await mkdir(sessionDir, { recursive: true });
    maybeThrowStorageFsFault({ operation: "writeFile", path });
    await writeFile(path, content);

    return {
      id: artifactId,
      uri: `zcode-artifact://${encodeURIComponent(request.sessionId)}/${encodeURIComponent(artifactId)}`,
      path,
      bytes: content.byteLength,
      contentType: request.contentType,
      createdAt: new Date(),
    };
  }

  async readToolResultArtifact(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactReadResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact read cancelled");
    }

    const { path, contentType, bytes } = await this.readArtifactFile(request.uri);
    const content = isTextArtifactContentType(contentType)
      ? bytes.toString("utf8")
      : bytes.toString("base64");
    return {
      uri: request.uri,
      path,
      content,
      bytes: bytes.byteLength,
      contentType,
    };
  }

  /**
   * 直接读取原始字节，供 v4 分块查询和查看器使用，避免编解码改变内容。
   * contentType 仍按文件名推断，仅作兜底。
   */
  async readToolResultBinaryArtifact(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolBinaryArtifactReadResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact read cancelled");
    }
    const { path, contentType, bytes } = await this.readArtifactFile(request.uri);
    return { uri: request.uri, path, bytes: new Uint8Array(bytes), contentType };
  }

  /** 两条读回共用的定位 + 读文件：uri → 会话目录里含 artifactId 的那个文件。 */
  private async readArtifactFile(
    uri: string,
  ): Promise<{ path: string; contentType: string; bytes: Buffer }> {
    const { artifactId, sessionId } = parseArtifactUri(uri);
    const sessionDir = join(this.rootDir, sanitizePathSegment(sessionId));
    const entries = await readdir(sessionDir);
    const fileName = entries.find((entry) => entry.includes(artifactId));
    if (!fileName) {
      throw new Error(`Tool artifact not found: ${uri}`);
    }
    const path = join(sessionDir, fileName);
    return { path, contentType: contentTypeForFileName(fileName), bytes: await readFile(path) };
  }

  async statToolResultArtifact(
    request: ToolArtifactStatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactStatResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact stat cancelled");
    }
    const { artifactId, sessionId } = parseArtifactUri(request.uri);
    const sessionDir = join(this.rootDir, sanitizePathSegment(sessionId));
    const entries = await readdir(sessionDir);
    const fileName = entries.find((entry) => entry.includes(artifactId));
    if (!fileName) throw new Error(`Tool artifact not found: ${request.uri}`);
    const path = join(sessionDir, fileName);
    const artifactStat = await stat(path);
    const dataUrlPayloadBytes = await readDataUrlPayloadBytes(path, artifactStat.size);
    return {
      uri: request.uri,
      bytes: artifactStat.size,
      contentType: contentTypeForFileName(fileName),
      path,
      mtimeMs: artifactStat.mtimeMs,
      ...(dataUrlPayloadBytes === undefined ? {} : { dataUrlPayloadBytes }),
    };
  }

  primeImageAttachmentPath(
    request: ImageAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult> {
    return this.primeMediaAttachmentPath(request);
  }

  primeMediaAttachmentPath(
    request: MediaAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult> {
    return this.runMediaAttachmentPathFlight(request.uri, () =>
      this.writeDerivedMediaAttachment(request.uri, request.mediaType, Buffer.from(request.bytes)),
    );
  }

  ensureMediaAttachmentPath(
    request: MediaAttachmentPathEnsureRequest,
  ): Promise<MediaAttachmentPathResult> {
    return this.runMediaAttachmentPathFlight(request.uri, async () => {
      const requestedPath = derivedMediaAttachmentPath(
        this.imageCacheRootDir,
        this.pdfCacheRootDir,
        this.videoCacheRootDir,
        request.uri,
        request.mediaType,
      );
      if (!requestedPath) return { status: "unsupported" };
      if (await isRegularFile(requestedPath)) return { status: "ready", path: requestedPath };

      const artifact = await this.readToolResultArtifact({ uri: request.uri });
      const decoded = decodeMediaDataUrlArtifact(
        artifact.content,
        request.uri,
        mediaKindForContentType(request.mediaType)!,
      );
      if (mediaKindForContentType(decoded.mediaType) === "pdf" && !isPdfBytes(decoded.bytes)) {
        throw new Error(`Media attachment artifact is not a PDF: ${request.uri}`);
      }
      return this.writeDerivedMediaAttachment(request.uri, decoded.mediaType, decoded.bytes);
    });
  }

  private runMediaAttachmentPathFlight(
    uri: string,
    materialize: () => Promise<MediaAttachmentPathResult>,
  ): Promise<MediaAttachmentPathResult> {
    const inFlight = this.mediaAttachmentPathFlights.get(uri);
    if (inFlight) return inFlight;

    // paste 落盘与紧随其后的发送会并发进入物化；URI 级 singleflight
    // 保证发送等待同一写任务，不会对同一派生媒体重复落盘。
    let flight!: Promise<MediaAttachmentPathResult>;
    flight = materialize().finally(() => {
      if (this.mediaAttachmentPathFlights.get(uri) === flight) {
        this.mediaAttachmentPathFlights.delete(uri);
      }
    });
    this.mediaAttachmentPathFlights.set(uri, flight);
    return flight;
  }

  private async writeDerivedMediaAttachment(
    uri: string,
    mediaType: string,
    bytes: Buffer,
  ): Promise<MediaAttachmentPathResult> {
    const path = derivedMediaAttachmentPath(
      this.imageCacheRootDir,
      this.pdfCacheRootDir,
      this.videoCacheRootDir,
      uri,
      mediaType,
    );
    // 既有媒体处理链可接收派生缓存无法命名的格式。
    // 派生 path 是增强信息，不支持该 MIME 时应跳过，不能阻断原 media/base64 请求。
    if (!path) return { status: "unsupported" };
    if (await isRegularFile(path)) return { status: "ready", path };

    const sessionDir = dirname(path);
    const temporaryPath = `${path}.tmp-${randomUUID()}`;
    maybeThrowStorageFsFault({ operation: "mkdir", path: sessionDir });
    await mkdir(sessionDir, { recursive: true });
    try {
      maybeThrowStorageFsFault({ operation: "writeFile", path: temporaryPath });
      await writeFile(temporaryPath, bytes);
      maybeThrowStorageFsFault({ operation: "rename", path });
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return { status: "ready", path };
  }
}

export function createNodeToolArtifactStore(
  options: NodeToolArtifactStoreOptions,
): ToolArtifactStorePort {
  return new NodeToolArtifactStore(options);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function extensionForContentType(contentType: string): string {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (mime) {
    case "text/plain":
      return ".txt";
    case "text/markdown":
      return ".md";
    case "application/json":
      return ".json";
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "application/pdf":
      return ".pdf";
    default:
      return ".json";
  }
}

function extensionForBinaryContentType(contentType: string): string {
  const extension = extensionForContentType(contentType);
  return extension === ".json" && !contentType.toLowerCase().includes("json") ? ".bin" : extension;
}

function normalizeArtifactExtension(extension: string): string {
  const withDot = extension.startsWith(".") ? extension : `.${extension}`;
  const sanitized = withDot
    .replace(/[^a-zA-Z0-9.]/g, "")
    .slice(0, 16)
    .toLowerCase();
  return /^\.[a-z0-9]+$/.test(sanitized) ? sanitized : ".bin";
}

function contentTypeForFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".bin")) return "application/octet-stream";
  // dwf 产物按原扩展名落盘（`extension` 入参），推断表补齐它们。文本类给 text/*
  // （utf8 读回正确），办公文件与 svg 之外的未知二进制一律 octet-stream——**绝不**再让一个
  // 不认识的扩展名落到 application/json 走 utf8（那正是读回损坏的根因）。
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  // 文本写入的默认扩展名就是 .json（extensionForContentType 的 default），所以既有文件全部
  // 落在上面的分支里；到这里的只有按原扩展名落盘的二进制产物（.xlsx / .docx / .pptx …）。
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function isTextArtifactContentType(contentType: string): boolean {
  return contentType === "application/json" || contentType.startsWith("text/");
}

function isPdfBytes(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

type DerivedMediaKind = "image" | "video" | "pdf";

function derivedMediaAttachmentPath(
  imageCacheRootDir: string,
  pdfCacheRootDir: string,
  videoCacheRootDir: string,
  uri: string,
  mediaType: string,
): string | undefined {
  const { sessionId } = parseArtifactUri(uri);
  const kind = mediaKindForContentType(mediaType);
  const extension = extensionForDerivedMediaContentType(mediaType);
  if (!kind || !extension) return undefined;
  const cacheRootDir =
    kind === "image" ? imageCacheRootDir : kind === "video" ? videoCacheRootDir : pdfCacheRootDir;
  const uriHash = createHash("sha256").update(uri).digest("hex").slice(0, 32);
  return join(cacheRootDir, sanitizePathSegment(sessionId), `${kind}-${uriHash}${extension}`);
}

function mediaKindForContentType(mediaType: string): DerivedMediaKind | undefined {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized === "application/pdf") return "pdf";
  return undefined;
}

function extensionForDerivedMediaContentType(mediaType: string): string | undefined {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/webm":
      return ".webm";
    case "video/x-matroska":
      return ".mkv";
    case "video/x-m4v":
      return ".m4v";
    case "video/x-msvideo":
      return ".avi";
    case "application/pdf":
      return ".pdf";
    default:
      return undefined;
  }
}

function decodeMediaDataUrlArtifact(
  content: string,
  uri: string,
  expectedKind: DerivedMediaKind,
): { bytes: Buffer; mediaType: string } {
  const commaIndex = content.indexOf(",");
  const headerParts =
    content.slice(0, "data:".length).toLowerCase() === "data:" && commaIndex >= 0
      ? content.slice("data:".length, commaIndex).split(";")
      : [];
  const mediaType = headerParts.shift()?.trim();
  if (
    mediaKindForContentType(mediaType ?? "") !== expectedKind ||
    headerParts.at(-1)?.trim().toLowerCase() !== "base64" ||
    commaIndex < 0
  ) {
    throw new Error(`Media attachment artifact is not a base64 ${expectedKind} data URL: ${uri}`);
  }
  const bytes = Buffer.from(content.slice(commaIndex + 1), "base64");
  if (bytes.byteLength === 0) {
    throw new Error(`Media attachment artifact is empty: ${uri}`);
  }
  return { bytes, mediaType: mediaType! };
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseArtifactUri(uri: string): { artifactId: string; sessionId: string } {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (error) {
    throw new Error(`Invalid tool artifact URI: ${uri}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (parsed.protocol !== "zcode-artifact:") {
    throw new Error(`Unsupported tool artifact URI: ${uri}`);
  }

  const sessionId = decodeURIComponent(parsed.hostname);
  const artifactId = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!sessionId || !artifactId) {
    throw new Error(`Invalid tool artifact URI: ${uri}`);
  }

  return { artifactId, sessionId };
}
export * from "./workspace-hook-trust-store.js";

/** data URL 头部（`data:<mime>;base64,`）的最大读取长度；MIME 不会超过这个长度。 */
const DATA_URL_HEADER_MAX_BYTES = 512;
const DATA_URL_PREFIX = "data:";
const DATA_URL_BASE64_SUFFIX = ";base64";
const BASE64_QUANTUM_CHARS = 4;
const BASE64_QUANTUM_BYTES = 3;

/**
 * 只读头部与最后 2 个字节，按 base64 长度换算 data URL payload 的解码字节数，不加载正文。
 * Share 预检会并发 stat 多个附件；整段读入会让大附件同时占用内存。内容不是 base64 data URL 时返回 undefined。
 */
async function readDataUrlPayloadBytes(path: string, size: number): Promise<number | undefined> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(Math.min(size, DATA_URL_HEADER_MAX_BYTES));
    await handle.read(head, 0, head.length, 0);
    const headText = head.toString("latin1");
    const commaIndex = headText.indexOf(",");
    const header = commaIndex >= 0 ? headText.slice(0, commaIndex).toLowerCase() : "";
    const payloadLength = size - commaIndex - 1;
    if (
      !header.startsWith(DATA_URL_PREFIX) ||
      !header.endsWith(DATA_URL_BASE64_SUFFIX) ||
      payloadLength % BASE64_QUANTUM_CHARS !== 0
    ) {
      return undefined;
    }
    const tail = Buffer.alloc(Math.min(payloadLength, 2));
    await handle.read(tail, 0, tail.length, size - tail.length);
    const padding = tail.toString("latin1").split("").filter((char) => char === "=").length;
    return (payloadLength / BASE64_QUANTUM_CHARS) * BASE64_QUANTUM_BYTES - padding;
  } finally {
    await handle.close();
  }
}
