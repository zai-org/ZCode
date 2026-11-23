import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm, statfs } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { HostApiNetworkTransport, createServiceLogger } from "@zcode/services/node";
import type {
  PreinstalledToolError,
  PreinstalledToolManifest,
} from "@zcode/shared/preinstalled-tools";

export class PreinstalledToolFailure extends Error {
  constructor(
    readonly kind: PreinstalledToolError,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PreinstalledToolFailure";
  }
}

/** 文件写入、解压或发布都可能耗尽磁盘，不能让外层阶段覆盖 ENOSPC。 */
export function classifyPreinstalledToolFailure(
  error: unknown,
  fallback: PreinstalledToolError,
): PreinstalledToolError {
  const pending = [error];
  const seen = new Set<unknown>();
  let kind = fallback;
  while (pending.length) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    if ("code" in current && current.code === "ENOSPC") return "disk-space";
    if (current instanceof PreinstalledToolFailure) kind = current.kind;
    if ("cause" in current) pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return kind;
}

export async function checkPreinstalledToolSpace(
  directory: string,
  manifest: PreinstalledToolManifest,
): Promise<void> {
  const space = await statfs(directory, { bigint: true });
  const needed = BigInt(manifest.archive.sizeBytes) + BigInt(manifest.installedSizeBytes);
  if (space.bavail * space.bsize < needed)
    throw new PreinstalledToolFailure("disk-space", "可用空间不足以同时容纳归档与展开文件");
}

const downloadErrorDepth = { network: 1, interrupted: 2, checksum: 3 } as const;

export async function downloadPreinstalledTool(options: {
  manifest: PreinstalledToolManifest;
  archive: string;
  signal: AbortSignal;
  createNetwork(): HostApiNetworkTransport;
  progress(bytes: number): void;
  phase(value: "downloading" | "verifying"): void;
  operationId: string;
  log: ReturnType<typeof createServiceLogger>;
}): Promise<void> {
  const { manifest, archive, signal } = options;
  const network = options.createNetwork();
  let deepest: PreinstalledToolFailure | undefined;
  try {
    for (const [candidate, url] of manifest.downloadUrls.entries()) {
      signal.throwIfAborted();
      options.phase("downloading");
      options.progress(0);
      let errorKind: PreinstalledToolError = "network";
      try {
        const response = await network.fetch(url, {
          signal,
          headers: { "accept-encoding": "identity" },
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(`下载响应不可用: ${response.status}`);
        }
        const hash = createHash("sha256");
        let downloaded = 0;
        errorKind = "interrupted";
        const progress = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            downloaded += chunk.length;
            if (downloaded > manifest.archive.sizeBytes) {
              // 超长内容是完整性错误，不是网络中断；流读取阶段也必须保留此分类。
              callback(new PreinstalledToolFailure("checksum", "下载大小超过清单"));
              return;
            }
            hash.update(chunk);
            options.progress(downloaded);
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
          progress,
          createWriteStream(archive, { flags: "wx" }),
          { signal },
        );
        errorKind = "checksum";
        options.phase("verifying");
        if (
          downloaded !== manifest.archive.sizeBytes ||
          hash.digest("hex") !== manifest.archive.sha256
        )
          throw new PreinstalledToolFailure("checksum", "资源大小或 SHA-256 不匹配");
        return;
      } catch (error) {
        if (signal.aborted) throw error;
        const kind = classifyPreinstalledToolFailure(error, errorKind);
        if (kind === "disk-space")
          throw new PreinstalledToolFailure(kind, "下载写入空间不足", { cause: error });
        const failure = new PreinstalledToolFailure(
          kind,
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
        options.log.warn(undefined, "下载候选失败", {
          operationId: options.operationId,
          resourceId: manifest.resourceId,
          candidate: candidate + 1,
          errorKind: kind,
          error: failure.message,
          causeCode: findCauseCode(error),
        });
        await rm(archive, { force: true });
        const rank = (value: PreinstalledToolError) =>
          downloadErrorDepth[value as keyof typeof downloadErrorDepth] ?? 0;
        if (!deepest || rank(kind) > rank(deepest.kind)) deepest = failure;
      }
    }
    throw deepest ?? new PreinstalledToolFailure("network", "没有可用的下载候选");
  } finally {
    // 适配器会缓存网络设置；每次准备独立持有，且响应体结束后才能释放连接池。
    if (signal.aborted) network.dispose();
    await network.disposeAndWait();
  }
}

function findCauseCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
