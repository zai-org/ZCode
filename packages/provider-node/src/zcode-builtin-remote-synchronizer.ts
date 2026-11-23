import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import type { NodeZCodeBuiltinProviderConfigSource } from "./zcode-builtin-provider-config-source.js";
import type { ZCodeBuiltinDownloadResult } from "./zcode-builtin-download.js";

const HOUR_MS = 60 * 60 * 1_000;
// 定时检查每 60 秒一次，相位会略早于到期时间；没有容差时配置 1 分钟会退化成每 2 分钟刷新。
const DUE_TOLERANCE_MS = 5_000;
// 下发地址不变时跳过 CDN，但仍按原有一小时节奏兜底重下，避免地址被原地覆盖后长期不更新。
const RELEASE_REDOWNLOAD_INTERVAL_MS = HOUR_MS;

export type ZCodeBuiltinRefreshResult =
  | "updated"
  | "unchanged"
  | "stale"
  | "missing"
  | "skipped"
  | "disposed";

export interface ZCodeBuiltinFetchReleaseOptions {
  /** 第一跳下发的地址等于它时，下载器不请求 CDN。 */
  readonly reuseUrl?: string;
}

export interface ZCodeBuiltinRemoteSynchronizerOptions {
  readonly source: NodeZCodeBuiltinProviderConfigSource;
  readonly controlFilePath: string;
  readonly resolveEndpointKey: () => string | Promise<string>;
  readonly fetchRelease: (
    endpointKey: string,
    signal: AbortSignal,
    options: ZCodeBuiltinFetchReleaseOptions,
  ) => Promise<ZCodeBuiltinDownloadResult>;
  readonly onRefreshResult?: (event: ZCodeBuiltinRefreshEvent) => void;
  readonly now?: () => number;
  readonly leaseDurationMs?: number;
  readonly failureBaseDelayMs?: number;
  readonly failureMaxDelayMs?: number;
}

export interface ZCodeBuiltinRefreshEvent {
  readonly result: ZCodeBuiltinRefreshResult;
  readonly reason?: "lease-held" | "not-due" | "endpoint-changed" | "release-url-unchanged";
  readonly revision?: number;
}

interface RefreshControl {
  readonly schemaVersion: 1;
  readonly endpointKey: string;
  readonly leaseId?: string;
  readonly leaseUntil: number;
  readonly nextEligibleAt: number;
  readonly failureCount: number;
  /** 上次成功下载的 CDN 地址与时间；缺失时下一轮按需下载，不参与 revision 判定。 */
  readonly releaseUrl?: string;
  readonly releaseDownloadedAt?: number;
}

type ReleaseRecord = Pick<RefreshControl, "releaseUrl" | "releaseDownloadedAt">;

/** 成功时 release 为 undefined 表示保留上次下载记录，null 表示服务端已撤销地址。 */
type LeaseOutcome =
  | {
      readonly kind: "success";
      readonly startedAt: number;
      readonly intervalMs: number;
      readonly release?: { readonly url: string; readonly downloadedAt: number } | null;
    }
  | { readonly kind: "failure" }
  | { readonly kind: "cancelled" };

/** Environment 共享控制文件合并多进程刷新；网络期间不持有文件锁。 */
export class ZCodeBuiltinRemoteSynchronizer {
  readonly #options: ZCodeBuiltinRemoteSynchronizerOptions;
  readonly #now: () => number;
  #inFlight: {
    readonly promise: Promise<ZCodeBuiltinRefreshResult>;
    readonly force: boolean;
  } | null = null;
  #queuedForce: Promise<ZCodeBuiltinRefreshResult> | null = null;
  #disposed = false;
  #abortController: AbortController | null = null;

  constructor(options: ZCodeBuiltinRemoteSynchronizerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  refresh(options: { readonly force?: boolean } = {}): Promise<ZCodeBuiltinRefreshResult> {
    if (this.#disposed) return Promise.resolve("disposed");
    const force = options.force === true;
    const inFlight = this.#inFlight;
    if (inFlight && (!force || inFlight.force)) return inFlight.promise;
    if (inFlight) {
      // Bug 根因：force 原先直接复用在途的普通刷新；普通刷新可能复用 URL 跳过 CDN，
      // 手动刷新就没有真正重下。改为等它结束后再强制刷新一次，并发的 force 共用这一次。
      const runQueued = () => {
        this.#queuedForce = null;
        return this.refresh({ force: true });
      };
      this.#queuedForce ??= inFlight.promise.then(runQueued, runQueued);
      return this.#queuedForce;
    }
    const controller = new AbortController();
    this.#abortController = controller;
    const promise = this.#refresh(force, controller.signal).finally(() => {
      if (this.#inFlight?.promise === promise) {
        this.#inFlight = null;
        this.#abortController = null;
      }
    });
    this.#inFlight = { promise, force };
    return promise;
  }

  dispose(): void {
    this.#disposed = true;
    this.#abortController?.abort();
  }

  async #refresh(force: boolean, signal: AbortSignal): Promise<ZCodeBuiltinRefreshResult> {
    const endpointKey = (await this.#options.resolveEndpointKey()).trim();
    if (this.#disposed) return "disposed";
    if (!endpointKey) throw new Error("ZCode Built-in 远端 Endpoint 不能为空");
    const leaseId = randomUUID();
    const acquired = await withFileLock(this.#options.controlFilePath, async () => {
      const now = this.#now();
      const current = await readControl(this.#options.controlFilePath);
      const sameEndpoint = current.endpointKey === endpointKey;
      if (sameEndpoint && current.leaseUntil > now) return "lease-held" as const;
      if (!force && sameEndpoint && current.nextEligibleAt - DUE_TOLERANCE_MS > now)
        return "not-due" as const;
      const release = sameEndpoint ? releaseRecord(current) : {};
      await writeControl(this.#options.controlFilePath, {
        schemaVersion: 1,
        endpointKey,
        leaseId,
        leaseUntil: now + (this.#options.leaseDurationMs ?? 30_000),
        nextEligibleAt: sameEndpoint ? current.nextEligibleAt : 0,
        failureCount: sameEndpoint ? current.failureCount : 0,
        ...release,
      });
      // 手动 force 用于排查与即时生效，必须真正重下 CDN。
      // Bug 根因：兜底重下原先不带容差，而本轮开始时间与上次下载时间来自同一个定时器相位；
      // 一小时间隔的到期轮次略早于一小时就仍复用 URL，再推迟一小时。两处到期判断用同一容差。
      const reusable =
        !force &&
        release.releaseUrl !== undefined &&
        release.releaseDownloadedAt !== undefined &&
        release.releaseDownloadedAt + RELEASE_REDOWNLOAD_INTERVAL_MS - DUE_TOLERANCE_MS > now;
      return { startedAt: now, reuseUrl: reusable ? release.releaseUrl : undefined };
    });
    if (typeof acquired === "string") {
      this.#report({ result: "skipped", reason: acquired });
      return "skipped";
    }

    try {
      signal.throwIfAborted();
      const fetched = await this.#options.fetchRelease(
        endpointKey,
        signal,
        acquired.reuseUrl ? { reuseUrl: acquired.reuseUrl } : {},
      );
      if (this.#disposed) {
        await this.#finishLease(endpointKey, leaseId, { kind: "cancelled" });
        return "disposed";
      }
      const currentEndpointKey = (await this.#options.resolveEndpointKey()).trim();
      signal.throwIfAborted();
      const success = { kind: "success", startedAt: acquired.startedAt } as const;
      if (currentEndpointKey !== endpointKey) {
        await this.#finishLease(endpointKey, leaseId, {
          ...success,
          intervalMs: fetched.refreshIntervalMs,
        });
        this.#report({ result: "skipped", reason: "endpoint-changed" });
        return "skipped";
      }
      if (fetched.kind === "not-modified") {
        await this.#finishLease(endpointKey, leaseId, {
          ...success,
          intervalMs: fetched.refreshIntervalMs,
        });
        this.#report({ result: "unchanged", reason: "release-url-unchanged" });
        return "unchanged";
      }
      if (fetched.kind === "missing") {
        await this.#finishLease(endpointKey, leaseId, {
          ...success,
          intervalMs: fetched.refreshIntervalMs,
          release: null,
        });
        this.#report({ result: "missing" });
        return "missing";
      }
      const result = await this.#options.source.applyRemoteRelease(fetched.release);
      await this.#finishLease(endpointKey, leaseId, {
        ...success,
        intervalMs: fetched.refreshIntervalMs,
        release: { url: fetched.url, downloadedAt: acquired.startedAt },
      });
      this.#report({ result, revision: fetched.release.revision });
      return result;
    } catch (error) {
      await this.#finishLease(endpointKey, leaseId, {
        kind: this.#disposed ? "cancelled" : "failure",
      });
      if (this.#disposed) return "disposed";
      throw error;
    }
  }

  #report(event: ZCodeBuiltinRefreshEvent): void {
    if (this.#disposed) return;
    try {
      this.#options.onRefreshResult?.(event);
    } catch {
      /* 日志不能把成功应用改成下载失败。 */
    }
  }

  async #finishLease(endpointKey: string, leaseId: string, outcome: LeaseOutcome): Promise<void> {
    await withFileLock(this.#options.controlFilePath, async () => {
      const current = await readControl(this.#options.controlFilePath);
      if (current.endpointKey !== endpointKey || current.leaseId !== leaseId) return;
      const now = this.#now();
      const failureCount =
        outcome.kind === "cancelled"
          ? current.failureCount
          : outcome.kind === "success"
            ? 0
            : current.failureCount + 1;
      // 成功从本轮开始计时，使下一轮落在同一检查相位；失败仍从结束时间按分钟指数退避。
      const nextEligibleAt =
        outcome.kind === "success"
          ? outcome.startedAt + outcome.intervalMs
          : outcome.kind === "cancelled"
            ? now
            : now +
              Math.min(
                (this.#options.failureBaseDelayMs ?? 60_000) * 2 ** Math.max(0, failureCount - 1),
                this.#options.failureMaxDelayMs ?? HOUR_MS,
              );
      const release =
        outcome.kind === "success" && outcome.release !== undefined
          ? outcome.release
            ? { releaseUrl: outcome.release.url, releaseDownloadedAt: outcome.release.downloadedAt }
            : {}
          : releaseRecord(current);
      await writeControl(this.#options.controlFilePath, {
        schemaVersion: 1,
        endpointKey,
        leaseUntil: 0,
        nextEligibleAt,
        failureCount,
        ...release,
      });
    });
  }
}

function releaseRecord(control: RefreshControl): ReleaseRecord {
  return control.releaseUrl !== undefined && control.releaseDownloadedAt !== undefined
    ? { releaseUrl: control.releaseUrl, releaseDownloadedAt: control.releaseDownloadedAt }
    : {};
}

async function readControl(filePath: string): Promise<RefreshControl> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return emptyControl();
    throw error;
  }
  try {
    const input = JSON.parse(raw) as unknown;
    return isRefreshControl(input) ? input : emptyControl();
  } catch {
    // 控制文件不是业务事实；进程崩溃留下的损坏内容在锁内重建，不能永久阻断刷新。
    return emptyControl();
  }
}

function emptyControl(): RefreshControl {
  return { schemaVersion: 1, endpointKey: "", leaseUntil: 0, nextEligibleAt: 0, failureCount: 0 };
}

function writeControl(filePath: string, control: RefreshControl): Promise<void> {
  return atomicWritePrivateTextFile(filePath, JSON.stringify(control, null, 2));
}

function isRefreshControl(input: unknown): input is RefreshControl {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return (
    value.schemaVersion === 1 &&
    typeof value.endpointKey === "string" &&
    (value.leaseId === undefined || typeof value.leaseId === "string") &&
    typeof value.leaseUntil === "number" &&
    typeof value.nextEligibleAt === "number" &&
    Number.isInteger(value.failureCount) &&
    (value.failureCount as number) >= 0 &&
    (value.releaseUrl === undefined || typeof value.releaseUrl === "string") &&
    (value.releaseDownloadedAt === undefined || typeof value.releaseDownloadedAt === "number")
  );
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
