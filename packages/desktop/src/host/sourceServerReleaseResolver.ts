import { normalizeRemoteConnectionError } from "@zcode/shared";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  ZCODE_VERSION,
  normalizeRemoteAssetInstallMode,
  sourceServerReleaseDescriptorSchema,
  type RemoteTarget,
  type SourceServerReleaseArchive,
  type SourceServerReleaseDescriptor,
} from "@zcode/shared";
import {
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
} from "@zcode/server/remote/remoteAssetCdn.js";
import {
  resolveRemoteAssetFetch,
  type RemoteAssetNetworkPort,
} from "@zcode/server/remote/remoteAssetNetwork.js";
import { createUnsupportedRemotePlatformError } from "@zcode/server/remote/remotePlatformSupport.js";
import type {
  ServerReleaseAsset,
  SourceServerProbeResult,
  TransportContext,
} from "@zcode/server/source-server";
import type { WindowRemoteAssetDirs } from "./windowRemoteConnectionRegistry.js";

/** release 解析的调用方上下文：本机请求响应取消，本机下载按 `download` 阶段写进度（R3 §6.3）。 */
export interface SourceServerReleaseResolveOptions extends Pick<
  TransportContext,
  "signal" | "onLog"
> {
  metadataOnly?: boolean;
}

interface ResolvedDescriptor {
  descriptor: SourceServerReleaseDescriptor;
  releaseBases: string[];
}

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyArchive(path: string, archive: SourceServerReleaseArchive): Promise<boolean> {
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size !== archive.sizeBytes) return false;
  return (await sha256File(path)) === archive.sha256;
}

function readDescriptor(text: string): SourceServerReleaseDescriptor {
  const descriptor = sourceServerReleaseDescriptorSchema.parse(JSON.parse(text));
  if (descriptor.version !== ZCODE_VERSION) {
    throw new Error(
      `Source Server descriptor version mismatch: expected ${ZCODE_VERSION}, received ${descriptor.version}`,
    );
  }
  return descriptor;
}

function findArchive(
  descriptor: SourceServerReleaseDescriptor,
  target: string,
): SourceServerReleaseArchive {
  const archive = descriptor.archives.find((candidate) => candidate.target === target);
  if (!archive) throw new Error(`Source Server descriptor is missing target: ${target}`);
  return archive;
}

function resolveArchiveUrls(releaseBases: string[], archive: SourceServerReleaseArchive): string[] {
  const absolute = archive.urls.filter((url) => /^https?:\/\//u.test(url));
  const relative = archive.urls.filter((url) => !/^https?:\/\//u.test(url));
  return Array.from(
    new Set([...absolute, ...buildReleaseAssetUrlCandidates(releaseBases, relative)]),
  );
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function resolveLocalDescriptor(
  releaseDir: string,
  target: string,
): Promise<{ archive: SourceServerReleaseArchive; archivePath: string } | null> {
  const descriptorPath = join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
  if (!(await pathExists(descriptorPath))) return null;
  const descriptor = readDescriptor(await readFile(descriptorPath, "utf8"));
  const archive = findArchive(descriptor, target);
  const archivePath = join(releaseDir, archive.fileName);
  if (!(await verifyArchive(archivePath, archive))) {
    throw new Error(`Source Server local archive failed descriptor verification: ${archivePath}`);
  }
  return { archive, archivePath };
}

async function resolveRemoteDescriptor(
  remoteAssets: WindowRemoteAssetDirs,
  cacheRoot: string | null,
  remoteAssetNetwork?: RemoteAssetNetworkPort,
  signal?: AbortSignal,
): Promise<ResolvedDescriptor> {
  const releaseBases = buildReleaseBaseCandidates(
    remoteAssets.remoteCdnBaseUrls ??
      (remoteAssets.remoteCdnBaseUrl ? [remoteAssets.remoteCdnBaseUrl] : []),
    ZCODE_VERSION,
  );
  const descriptorUrls = buildReleaseAssetUrlCandidates(releaseBases, [
    SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  ]);
  const cachedDescriptorPath = cacheRoot
    ? join(cacheRoot, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME)
    : null;
  let lastError: unknown;
  const fetchImpl = resolveRemoteAssetFetch(remoteAssetNetwork);
  for (const url of descriptorUrls) {
    try {
      const response = await fetchImpl(url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const descriptor = readDescriptor(text);
      if (cachedDescriptorPath) await writeTextAtomic(cachedDescriptorPath, text);
      return { descriptor, releaseBases };
    } catch (error) {
      // 取消不是候选地址失败：不再尝试下一个地址，也不回退到缓存的 descriptor。
      signal?.throwIfAborted();
      lastError = error;
    }
  }
  if (cachedDescriptorPath && (await pathExists(cachedDescriptorPath))) {
    return {
      descriptor: readDescriptor(await readFile(cachedDescriptorPath, "utf8")),
      releaseBases,
    };
  }
  throw new Error("Unable to resolve Source Server release descriptor", { cause: lastError });
}

/** 本机下载进度：消息格式与上传进度一致，最多每 500 毫秒写一次，下载结束补 100%。 */
function createDownloadProgress(totalBytes: number, onLog: TransportContext["onLog"]) {
  const startedAt = Date.now();
  let receivedBytes = 0;
  // 第一条进度也等满 500 毫秒：只凭首个数据块算出的速度偏高，会让预计剩余时间失真。
  let reportedAt = startedAt;
  const report = () => {
    reportedAt = Date.now();
    const progress = totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : 0;
    const seconds = Math.max(0.001, (reportedAt - startedAt) / 1000);
    onLog?.({
      phase: "download",
      message: `download progress: ${(progress * 100).toFixed(1)}% (${(receivedBytes / 1048576).toFixed(1)}/${(totalBytes / 1048576).toFixed(1)} MB, ${(receivedBytes / 1048576 / seconds).toFixed(2)} MB/s)`,
      progress,
    });
  };
  return {
    add(bytes: number) {
      receivedBytes += bytes;
      if (Date.now() - reportedAt >= 500) report();
    },
    finish: report,
  };
}

async function downloadArchive(
  archive: SourceServerReleaseArchive,
  urls: string[],
  cacheRoot: string,
  remoteAssetNetwork?: RemoteAssetNetworkPort,
  { signal, onLog }: Pick<TransportContext, "signal" | "onLog"> = {},
): Promise<string> {
  await mkdir(cacheRoot, { recursive: true });
  const cached = join(cacheRoot, archive.fileName);
  if (await verifyArchive(cached, archive)) return cached;
  await rm(cached, { force: true });
  // Bug 原因（ZCT-2117527614209818624）：这里下载约 90MB archive 时不写日志、不接收取消信号。
  // 慢网下更新停在“Checking the remote device”几分钟，向导无法取消，只能等下载结束或网络超时。
  onLog?.({ phase: "download", message: `Downloading Source Server ${archive.version}` });
  let lastError: unknown;
  const fetchImpl = resolveRemoteAssetFetch(remoteAssetNetwork);
  for (const url of urls) {
    const temporary = `${cached}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const response = await fetchImpl(url, { signal });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const progress = createDownloadProgress(archive.sizeBytes, onLog);
      await pipeline(
        Readable.fromWeb(response.body as never),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            progress.add(chunk.length);
            yield chunk;
          }
        },
        createWriteStream(temporary, { mode: 0o600 }),
        { signal },
      );
      progress.finish();
      if (!(await verifyArchive(temporary, archive))) {
        throw new Error(`Source Server archive checksum mismatch: ${archive.fileName}`);
      }
      await rename(temporary, cached);
      return cached;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      // 取消不是候选地址失败：删除临时文件后直接结束，不再尝试下一个地址。
      signal?.throwIfAborted();
      lastError = error;
    }
  }
  throw new Error(`Unable to download Source Server release ${archive.fileName}`, {
    cause: lastError,
  });
}

export async function resolveSourceServerReleaseAsset(
  ...args: Parameters<typeof resolveReleaseAsset>
): Promise<ServerReleaseAsset> {
  try {
    return await resolveReleaseAsset(...args);
  } catch (error) {
    // Bug 原因：首次安装把窗口的连接信号传给 resolver 后，「取消连接」以无原因的 abort() 中止下载，
    // 抛出的是只读 DOMException；这里给它写 code 会抛 TypeError，取消被记成下载失败（unknown、error 级）。
    // 取消不是下载失败，原样抛出取消原因，由调用方按取消收口。
    args[4]?.signal?.throwIfAborted();
    const failure = normalizeRemoteConnectionError(error, "download");
    throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
  }
}

async function resolveReleaseAsset(
  probe: SourceServerProbeResult,
  remoteAssets: WindowRemoteAssetDirs,
  remoteTarget: Exclude<RemoteTarget, { kind: "server" }>,
  remoteAssetNetwork?: RemoteAssetNetworkPort,
  options: SourceServerReleaseResolveOptions = {},
): Promise<ServerReleaseAsset> {
  if (
    (probe.platform !== "linux" && probe.platform !== "darwin") ||
    (probe.arch !== "x64" && probe.arch !== "arm64")
  ) {
    // Bug 原因：英文拒绝信息没有公开码，又被下载阶段兜底成 remote-download-failed，
    // riscv64 等设备看到“下载失败”并被建议重试；平台不支持应使用专用码和中文原因。
    // Bug 原因：原因曾写成“Linux / macOS”，连接错误脱敏把空格后的裸 `/` 当作路径遮到行尾，
    // 用户只看到“只提供 Linux [redacted-path]”。脱敏无法区分路径与分隔符，列举改用顿号。
    throw createUnsupportedRemotePlatformError(
      `当前不支持 ${probe.platform}-${probe.arch} 设备：远程服务只提供 Linux、macOS 的 x64 与 arm64 版本`,
    );
  }
  const target = `${probe.platform}-${probe.arch}`;
  const installMode =
    remoteTarget.kind === "ssh"
      ? normalizeRemoteAssetInstallMode(remoteTarget.assetInstallMode)
      : "local-download-upload";
  const cacheRoot = remoteAssets.remoteCacheDir
    ? join(remoteAssets.remoteCacheDir, "source-server", ZCODE_VERSION)
    : null;

  if (
    remoteTarget.kind === "ssh" &&
    remoteAssets.sourceServerArtifactPolicy === "development-content-addressed"
  ) {
    if (!remoteAssets.mockCdnDir) {
      throw new Error(
        "Development Source Server release is unavailable; run pnpm bootstrap:with-remote",
      );
    }
    const releaseDir = join(remoteAssets.mockCdnDir, "releases", ZCODE_VERSION);
    const local = await resolveLocalDescriptor(releaseDir, target);
    if (!local) {
      // Bug 原因：开发态回退 CDN 会把 bootstrap 失败伪装成连接成功，并继续运行同版本旧代码。
      // 内容寻址开发策略只能消费本轮本地 descriptor/archive，缺失时必须明确失败。
      throw new Error(
        "Development Source Server release descriptor is unavailable; run pnpm bootstrap:with-remote",
      );
    }
    return {
      localArchivePath: local.archivePath,
      target,
      version: ZCODE_VERSION,
      sha256: local.archive.sha256,
      sizeBytes: local.archive.sizeBytes,
      urls: local.archive.urls,
    };
  }

  if (installMode === "local-download-upload") {
    // Bug 原因：开发态曾直接信任 gitignore 的 dist-release；同版本源码变化后仍会部署旧包。
    // 现在只接受本轮 staging 写入 mock-cdn 且通过 descriptor SHA/size 校验的本地产物。
    const localReleaseDirs = remoteAssets.mockCdnDir
      ? [join(remoteAssets.mockCdnDir, "releases", ZCODE_VERSION)]
      : [];
    for (const releaseDir of localReleaseDirs) {
      const local = await resolveLocalDescriptor(releaseDir, target);
      if (!local) continue;
      return {
        localArchivePath: local.archivePath,
        target,
        version: ZCODE_VERSION,
        sha256: local.archive.sha256,
        sizeBytes: local.archive.sizeBytes,
        urls: local.archive.urls,
      };
    }
  }

  const resolvedDescriptor = await resolveRemoteDescriptor(
    remoteAssets,
    cacheRoot,
    remoteAssetNetwork,
    options.signal,
  );
  const archive = findArchive(resolvedDescriptor.descriptor, target);
  const urls = resolveArchiveUrls(resolvedDescriptor.releaseBases, archive);
  if (installMode === "remote-download" || options.metadataOnly) {
    return {
      target,
      version: ZCODE_VERSION,
      sha256: archive.sha256,
      sizeBytes: archive.sizeBytes,
      urls,
    };
  }
  if (!cacheRoot)
    throw new Error(`Source Server release cache is unavailable: ${archive.fileName}`);
  return {
    localArchivePath: await downloadArchive(archive, urls, cacheRoot, remoteAssetNetwork, options),
    target,
    version: ZCODE_VERSION,
    sha256: archive.sha256,
    sizeBytes: archive.sizeBytes,
    urls,
  };
}
