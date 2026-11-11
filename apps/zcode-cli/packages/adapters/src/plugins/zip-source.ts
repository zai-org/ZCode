import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isHttpClientPortError } from "@zcode/contracts";
import * as yauzl from "yauzl";
import { createNodeWebFetchHttpClientAdapter } from "../http/index.js";
import {
  appendPluginSourceCleanupError,
  cleanupPluginSourceBestEffort,
  directoryExists,
  fileExists,
} from "./helpers.js";

const ZIP_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
const ZIP_EXTRACT_MAX_BYTES = 500 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 20_000;
const ZIP_MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;
const ZIP_MAX_REDIRECTS = 5;
const ZIP_DOWNLOAD_TIMEOUT_MS = 180_000;
const ZIP_TEMP_PREFIX = "zcode-plugin-zip-";
const ZIP_DENIED_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
]);
const ZIP_REQUIRED_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface ResolvedZipPluginSourceRoot {
  cleanup: () => Promise<void>;
  path: string;
}

export interface ResolveZipPluginSourceInput {
  headers?: Record<string, string>;
  path?: string;
  sha256: string;
  signal?: AbortSignal;
  stripRoot?: boolean;
  url: string;
}

export interface ResolveHttpZipSourceInput {
  headers?: Record<string, string>;
  path?: string;
  requireSingleRoot?: boolean;
  sha256?: string;
  signal?: AbortSignal;
  stripRoot?: boolean;
  url: string;
}

export class PluginZipDownloadError extends Error {
  readonly status?: number;
  readonly url: string;

  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = "PluginZipDownloadError";
    this.url = url;
    if (status !== undefined) this.status = status;
  }
}

interface ZipExtractResult {
  topLevelSegments: Set<string>;
}

type ZipEntryKind = "directory" | "file";

export async function resolveZipPluginSource(
  input: ResolveZipPluginSourceInput,
): Promise<ResolvedZipPluginSourceRoot> {
  validateZipSourceInput(input);
  const resolved = await resolveHttpZipSource({
    headers: input.headers,
    path: input.path,
    sha256: input.sha256,
    signal: input.signal,
    stripRoot: input.stripRoot,
    url: input.url,
  });
  return resolved;
}

export async function resolveHttpZipSource(
  input: ResolveHttpZipSourceInput,
): Promise<ResolvedZipPluginSourceRoot> {
  validateZipDownloadUrl(input.url);
  validateZipHeaders(input.headers);
  if (input.path !== undefined) normalizeZipRelativePath(input.path);
  if (input.sha256 !== undefined && !ZIP_REQUIRED_SHA256_PATTERN.test(input.sha256.toLowerCase())) {
    throw new Error("Plugin zip source sha256 must be a 64 character hex string");
  }
  const tempRoot = await mkdtemp(join(tmpdir(), ZIP_TEMP_PREFIX));
  const archivePath = join(tempRoot, "source.zip");
  const extractRoot = join(tempRoot, "extract");
  const cleanup = async (): Promise<void> => {
    await rm(tempRoot, { force: true, recursive: true });
  };

  try {
    throwIfAborted(input.signal);
    const zipBytes = await downloadZipArchive({
      headers: input.headers,
      signal: input.signal,
      url: input.url,
    });
    const actualSha256 = createHash("sha256").update(zipBytes).digest("hex");
    if (input.sha256 !== undefined && actualSha256 !== input.sha256.toLowerCase()) {
      throw new Error(
        `Plugin zip sha256 mismatch: expected=${input.sha256.toLowerCase()}, actual=${actualSha256}`,
      );
    }

    await writeFile(archivePath, zipBytes);
    const extracted = await extractZipArchive({
      archivePath,
      signal: input.signal,
      targetRoot: extractRoot,
    });
    const pluginRoot = resolveZipRoot({
      extractRoot,
      path: input.path,
      requireSingleRoot: input.requireSingleRoot,
      stripRoot: input.stripRoot,
      topLevelSegments: extracted.topLevelSegments,
    });
    return { cleanup, path: pluginRoot };
  } catch (error) {
    const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
    throw appendPluginSourceCleanupError(error, cleanupError);
  }
}

export function readZipPluginSourceSha256(source: unknown): string | undefined {
  if (!isZipPluginUrlSource(source)) return undefined;
  return source.sha256;
}

export function isZipPluginUrlSource(
  source: unknown,
): source is { source: "url"; type: "zip"; sha256: string; url: string } {
  return (
    typeof source === "object" &&
    source !== null &&
    !Array.isArray(source) &&
    "source" in source &&
    (source as { source?: unknown }).source === "url" &&
    (source as { type?: unknown }).type === "zip" &&
    typeof (source as { url?: unknown }).url === "string" &&
    typeof (source as { sha256?: unknown }).sha256 === "string"
  );
}

function validateZipSourceInput(input: ResolveZipPluginSourceInput): void {
  validateZipDownloadUrl(input.url);
  if (!ZIP_REQUIRED_SHA256_PATTERN.test(input.sha256.toLowerCase())) {
    throw new Error("Plugin zip source sha256 must be a 64 character hex string");
  }
  validateZipHeaders(input.headers);
  if (input.path !== undefined) {
    normalizeZipRelativePath(input.path);
  }
}

async function downloadZipArchive(input: {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  url: string;
}): Promise<Uint8Array> {
  // agent 会封存用户 shell 代理，ZIP 下载必须和其他应用层 fetch 一样读取 captured proxy fallback。
  const client = createNodeWebFetchHttpClientAdapter({
    env: process.env,
    maxResponseBytes: ZIP_DOWNLOAD_MAX_BYTES,
    timeoutMs: ZIP_DOWNLOAD_TIMEOUT_MS,
  });
  let currentUrl = input.url;
  let currentHeaders = input.headers;
  for (let redirectCount = 0; redirectCount <= ZIP_MAX_REDIRECTS; redirectCount += 1) {
    throwIfAborted(input.signal);
    validateZipDownloadUrl(currentUrl);
    const request = () =>
      client.request(
        {
          headers: currentHeaders,
          maxResponseBytes: ZIP_DOWNLOAD_MAX_BYTES,
          method: "GET",
          redirect: "manual",
          url: currentUrl,
        },
        { signal: input.signal },
      );
    const response = await request().catch(async (error: unknown) => {
      if (
        !isHttpClientPortError(error) ||
        (error.code !== "network_error" && error.code !== "proxy_error")
      )
        throw error;
      // 代理 TLS 握手或正文传输可能偶发断开；GET 尚未激活缓存，可安全重试一次。
      // 原生 fetch 比代理请求多包一层 cause；仅识别连接重置，不重试证书错误或取消。
      const cause =
        error.cause instanceof Error && error.cause.cause instanceof Error
          ? error.cause.cause
          : error.cause;
      if (
        !(cause instanceof Error) ||
        !("code" in cause) ||
        (cause.code !== "ECONNRESET" && cause.code !== "UND_ERR_SOCKET")
      )
        throw error;
      await delay(250, undefined, { signal: input.signal });
      return request();
    });

    if (isRedirectStatus(response.status)) {
      const location = response.headers.location;
      if (!location) {
        throw new Error(`Plugin zip download redirect is missing Location header: ${currentUrl}`);
      }
      const redirectUrl = new URL(location, currentUrl);
      // 跨 CDN origin 继续发送 marketplace 自定义 header 会把内部元数据泄露给跳转目标。
      if (redirectUrl.origin !== new URL(currentUrl).origin) {
        currentHeaders = undefined;
      }
      currentUrl = redirectUrl.toString();
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new PluginZipDownloadError(
        `Failed to download plugin zip: ${response.status} ${response.statusText}`,
        currentUrl,
        response.status,
      );
    }
    return response.body;
  }
  throw new Error(`Plugin zip download exceeded redirect limit: ${input.url}`);
}

async function extractZipArchive(input: {
  archivePath: string;
  signal?: AbortSignal;
  targetRoot: string;
}): Promise<ZipExtractResult> {
  const targetRoot = resolve(input.targetRoot);
  await mkdir(targetRoot, { recursive: true });
  const zipFile = await openZipFile(input.archivePath);
  const topLevelSegments = new Set<string>();
  let entryCount = 0;
  let extractedBytes = 0;

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const rejectOnce = (error: unknown): void => {
        zipFile.close();
        rejectPromise(error);
      };
      zipFile.once("error", rejectOnce);
      zipFile.once("end", () => {
        zipFile.removeListener("error", rejectOnce);
        resolvePromise();
      });
      zipFile.on("entry", (entry) => {
        void (async () => {
          try {
            throwIfAborted(input.signal);
            entryCount += 1;
            if (entryCount > ZIP_MAX_ENTRIES) {
              throw new Error(`Plugin zip has too many entries: ${entryCount}/${ZIP_MAX_ENTRIES}`);
            }

            const normalizedPath = normalizeZipRelativePath(entry.fileName);
            topLevelSegments.add(normalizedPath.split("/")[0] ?? normalizedPath);
            const targetPath = resolveZipPathWithin(targetRoot, normalizedPath);
            const kind = classifyZipEntry(entry);
            if (kind === "directory") {
              await mkdir(targetPath, { recursive: true });
              zipFile.readEntry();
              return;
            }

            if (entry.uncompressedSize > ZIP_MAX_SINGLE_FILE_BYTES) {
              throw new Error(`Plugin zip entry exceeds single file limit: ${entry.fileName}`);
            }
            const bytes = await readZipEntryBuffer(zipFile, entry, input.signal);
            extractedBytes += bytes.byteLength;
            if (extractedBytes > ZIP_EXTRACT_MAX_BYTES) {
              throw new Error(
                `Plugin zip extracted content exceeds limit: ${extractedBytes}/${ZIP_EXTRACT_MAX_BYTES}`,
              );
            }
            await mkdir(dirname(targetPath), { recursive: true });
            await writeFile(targetPath, bytes);
            zipFile.readEntry();
          } catch (error) {
            rejectOnce(error);
          }
        })();
      });
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }

  return { topLevelSegments };
}

function resolveZipRoot(input: {
  extractRoot: string;
  path?: string;
  requireSingleRoot?: boolean;
  stripRoot?: boolean;
  topLevelSegments: Set<string>;
}): string {
  const extractRoot = resolve(input.extractRoot);
  if (input.requireSingleRoot && input.topLevelSegments.size !== 1) {
    throw new Error(
      `Plugin zip must contain exactly one top-level directory: ${input.topLevelSegments.size}`,
    );
  }
  if (input.path !== undefined) {
    const requested = resolveZipPathWithin(extractRoot, normalizeZipRelativePath(input.path));
    if (!directoryExists(requested)) {
      throw new Error(`Plugin zip source subdirectory does not exist: ${input.path}`);
    }
    return requested;
  }

  if (hasPluginManifest(extractRoot)) {
    return extractRoot;
  }

  if (input.stripRoot !== false && input.topLevelSegments.size === 1) {
    const [segment] = [...input.topLevelSegments];
    if (segment) {
      const candidate = resolveZipPathWithin(extractRoot, segment);
      if (directoryExists(candidate)) return candidate;
    }
  }

  if (!directoryExists(extractRoot)) {
    throw new Error("Plugin zip did not extract a plugin root directory");
  }
  return extractRoot;
}

function hasPluginManifest(rootPath: string): boolean {
  return (
    fileExists(join(rootPath, ".zcode-plugin", "plugin.json")) ||
    fileExists(join(rootPath, ".claude-plugin", "plugin.json")) ||
    fileExists(join(rootPath, ".codex-plugin", "plugin.json"))
  );
}

function openZipFile(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      if (!zipFile) {
        rejectPromise(new Error("Failed to open plugin zip archive"));
        return;
      }
      resolvePromise(zipFile);
    });
  });
}

function readZipEntryBuffer(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      if (!stream) {
        rejectPromise(new Error(`Failed to read plugin zip entry: ${entry.fileName}`));
        return;
      }

      const chunks: Buffer[] = [];
      let bytesRead = 0;
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        stream.destroy(new Error("Plugin operation cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      stream.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesRead += buffer.byteLength;
        if (bytesRead > ZIP_MAX_SINGLE_FILE_BYTES) {
          stream.destroy(
            new Error(`Plugin zip entry exceeds single file limit: ${entry.fileName}`),
          );
          return;
        }
        chunks.push(buffer);
      });
      stream.once("error", (streamError) => {
        cleanup();
        rejectPromise(streamError);
      });
      stream.once("end", () => {
        cleanup();
        resolvePromise(Buffer.concat(chunks));
      });
    });
  });
}

function classifyZipEntry(entry: yauzl.Entry): ZipEntryKind {
  const isDirectoryByName = entry.fileName.endsWith("/");
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new Error(`Encrypted plugin zip entries are not supported: ${entry.fileName}`);
  }

  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (fileType === 0o120000) {
    throw new Error(`Plugin zip entry symlinks are not supported: ${entry.fileName}`);
  }
  if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
    throw new Error(`Unsupported plugin zip entry type: ${entry.fileName}`);
  }
  if (fileType === 0o040000 || isDirectoryByName) return "directory";
  return "file";
}

function normalizeZipRelativePath(path: string): string {
  if (path.includes("\0")) {
    throw new Error(`Unsafe plugin zip path: ${path}`);
  }
  const withoutTrailingSlash = path.replace(/\/+$/u, "");
  if (
    !withoutTrailingSlash ||
    path.includes("\\") ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    /^[a-zA-Z]:/u.test(path)
  ) {
    throw new Error(`Unsafe plugin zip path: ${path}`);
  }
  const parts = withoutTrailingSlash.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe plugin zip path: ${path}`);
  }
  return withoutTrailingSlash;
}

function resolveZipPathWithin(rootPath: string, relativePath: string): string {
  const root = resolve(rootPath);
  const target = resolve(root, ...relativePath.split("/"));
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Unsafe plugin zip path: ${relativePath}`);
  }
  return target;
}

function validateZipHeaders(headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const [key, value] of Object.entries(headers)) {
    if (ZIP_DENIED_HEADERS.has(key.toLowerCase())) {
      throw new Error(`Plugin zip source header is not allowed: ${key}`);
    }
    if (typeof value !== "string") {
      throw new Error(`Plugin zip source header must be a string: ${key}`);
    }
  }
}

function validateZipDownloadUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Plugin zip source URL is invalid: ${value}`);
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
  throw new Error(`Plugin zip source URL must be HTTPS: ${value}`);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    isIpv4LoopbackHost(normalized)
  );
}

function isIpv4LoopbackHost(hostname: string): boolean {
  const match = /^127(?:\.(\d{1,3})){3}$/u.exec(hostname);
  if (!match) return false;
  return hostname
    .split(".")
    .every((part) => Number.parseInt(part, 10) >= 0 && Number.parseInt(part, 10) <= 255);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("Plugin operation cancelled");
    error.name = "AbortError";
    throw error;
  }
}
