import { z } from "zod";
import { projectTokenSuccessCodeSchema } from "./project-access-token-response.js";
import type { ApiKeyCreationUsageScene } from "./api-key-usage-scene.js";

const SECOND_MS = 1_000;
const REFRESH_LEAD_MS = 120 * SECOND_MS;
const REFRESH_JITTER_MS = 60 * SECOND_MS;
const REFRESH_RETRY_BACKOFF_MS = 5 * SECOND_MS;

const responseSchema = z.preprocess(
  (raw) => {
    if (
      raw &&
      typeof raw === "object" &&
      "data" in raw &&
      raw.data &&
      typeof raw.data === "object" &&
      !("enable" in raw.data)
    ) {
      return { ...raw, data: { ...raw.data, enable: true } };
    }
    return raw;
  },
  z.object({
    code: projectTokenSuccessCodeSchema,
    data: z.discriminatedUnion("enable", [
      z.object({ enable: z.literal(false) }),
      z.object({
        enable: z.literal(true),
        accessToken: z.string().trim().min(1),
        tokenType: z.literal("Bearer"),
        expiresIn: z.number().finite().positive(),
        expiresAt: z.number().finite().positive(),
      }),
    ]),
  }),
);

export interface ProjectAccessTokenScope {
  readonly origin: string;
  readonly family: "bigmodel" | "zai";
  readonly accountId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly apiKeyId: string;
  readonly usageScene: ApiKeyCreationUsageScene;
  /** 登录生命周期标识，不能使用 Token 原文或短期 Token 的哈希。 */
  readonly loginGeneration: string;
}

export type ProjectAccessTokenResult =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly token: string;
      readonly expiresAt: number;
    };

export class ProjectAccessTokenError extends Error {
  constructor(readonly code: "project_token_invalid_response" | "project_token_scope_invalidated") {
    // 响应包含凭据；不把 zod issues、原始响应或 Token 放进异常/日志。
    super(code);
    this.name = "ProjectAccessTokenError";
  }
}

/**
 * I/O adapter 确认的请求失败类别；只保留类别与 HTTP 状态码，不携带原始响应、URL、Token 或 cause。
 * 失败码映射见 docs/model-provider-project-access-token.md「换证失败错误码」。
 */
export type ProjectAccessTokenRequestFailure =
  | { readonly kind: "network" }
  | { readonly kind: "timeout" }
  | { readonly kind: "http"; readonly status: number; readonly retryAfterMs?: number };

/** 只保留限流等待量，不把响应头原文带入错误或日志。 */
export function projectAccessTokenRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const milliseconds = Number(text) * SECOND_MS;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

/** I/O adapter 确认的临时故障；不携带原始响应、URL、Token 或 cause。 */
export class ProjectAccessTokenTransientError extends Error {
  constructor(readonly failure?: ProjectAccessTokenRequestFailure) {
    super("project_token_transient_failure");
    this.name = "ProjectAccessTokenTransientError";
  }
}

/** I/O adapter 确认的非临时 HTTP 状态（如 401/403）；只保留状态码，不触发旧 PAT 降级。 */
export class ProjectAccessTokenHttpStatusError extends Error {
  readonly failure: ProjectAccessTokenRequestFailure;

  constructor(status: number) {
    super("project_token_http_status");
    this.name = "ProjectAccessTokenHttpStatusError";
    this.failure = { kind: "http", status };
  }
}

/**
 * Bug 原因：换证 catch 曾把网络、超时、401/403/5xx 全部压成 project_token_request_failed，
 * 远端反馈（ZCT-2111046389485834240）只能看到同一个码，无法区分代理/断网与鉴权拒绝。
 * 这里只把结构化类别投影成固定码；状态码不是凭据，越界值仍回到未分类码。
 */
export function projectAccessTokenRequestFailureCode(
  failure: ProjectAccessTokenRequestFailure | undefined,
): string {
  if (failure?.kind === "network") return "project_token_network_error";
  if (failure?.kind === "timeout") return "project_token_timeout";
  if (
    failure?.kind === "http" &&
    Number.isInteger(failure.status) &&
    failure.status >= 100 &&
    failure.status <= 599
  )
    return `project_token_http_${failure.status}`;
  return "project_token_request_failed";
}

interface CacheEntry {
  fingerprint?: string;
  value?: Extract<ProjectAccessTokenResult, { enabled: true }>;
  refreshAt?: number;
  pending?: Promise<ProjectAccessTokenResult>;
}

/**
 * 账号鉴权 owner 的纯内存状态，不含网络、存储、定时器或全局单例。
 * Host 和 Standalone 分别持有实例；签发由其已有 I/O adapter 注入。
 */
export class ProjectAccessTokenCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #onRefreshDeferred?: () => void;

  constructor(
    options: { now?: () => number; random?: () => number; onRefreshDeferred?: () => void } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#onRefreshDeferred = options.onRefreshDeferred;
  }

  async resolve(
    scope: ProjectAccessTokenScope,
    issue: (hasValidFallback: () => boolean) => Promise<unknown>,
    rejectedFingerprint?: string,
  ): Promise<ProjectAccessTokenResult> {
    const key = scopeKey(scope);
    let entry = this.#entries.get(key);
    // 仅清理被拒绝的那一代 PAT；迟到的 401 不得废弃新凭据或打断正在进行的换证。
    if (rejectedFingerprint && entry?.fingerprint === rejectedFingerprint) {
      entry.value = undefined;
      entry.refreshAt = undefined;
    }
    if (entry?.pending) return entry.pending;
    if (entry?.value && this.#now() < Math.min(entry.refreshAt!, entry.value.expiresAt)) {
      return entry.value;
    }
    if (!entry) {
      entry = {};
      this.#entries.set(key, entry);
    }
    const current = entry;
    const startedAt = this.#now();
    // 延迟到微任务执行签发，先登记 pending，确保同步重入也只生成一个请求。
    const pending = Promise.resolve()
      .then(() => {
        // 退出可能先于签发微任务发生；此时连旧登录态的网络请求也不得发出。
        if (this.#entries.get(key) !== current) {
          throw new ProjectAccessTokenError("project_token_scope_invalidated");
        }
        // 是否能降级始终由缓存 owner 按当前有效期判断，不能冻结为请求开始时的布尔值。
        return issue(
          () =>
            this.#entries.get(key) === current &&
            current.value !== undefined &&
            this.#now() < current.value.expiresAt,
        );
      })
      .then(async (raw) => {
        if (this.#entries.get(key) !== current) {
          throw new ProjectAccessTokenError("project_token_scope_invalidated");
        }
        const response = responseSchema.safeParse(raw);
        if (!response.success) throw new ProjectAccessTokenError("project_token_invalid_response");
        const data = response.data.data;
        if (!data.enable) {
          this.#entries.delete(key);
          return Object.freeze({ enabled: false } as const);
        }
        // expiresIn 从发出签发请求时保守起算，不能把网络耗时变成额外有效期。
        const expiresAt = Math.min(
          data.expiresAt * SECOND_MS,
          startedAt + data.expiresIn * SECOND_MS,
        );
        if (!Number.isFinite(expiresAt) || expiresAt <= this.#now()) {
          throw new ProjectAccessTokenError("project_token_invalid_response");
        }
        const jitter = Math.max(0, Math.min(1, this.#random())) * REFRESH_JITTER_MS;
        const fingerprint = await projectAccessTokenFingerprint(data.accessToken);
        if (this.#entries.get(key) !== current)
          throw new ProjectAccessTokenError("project_token_scope_invalidated");
        current.fingerprint = fingerprint;
        current.value = Object.freeze({
          enabled: true,
          token: data.accessToken,
          expiresAt,
        });
        current.refreshAt = expiresAt - REFRESH_LEAD_MS - jitter;
        return current.value;
      })
      .catch((error: unknown) => {
        if (this.#entries.get(key) !== current)
          throw new ProjectAccessTokenError("project_token_scope_invalidated");
        // 只保留仍有效且未被 401 指纹清除的 PAT；认证拒绝和格式错误必须失败。
        // 降级属于同一个 pending，使所有并发调用获得一致结果，不延长原有效期。
        if (
          error instanceof ProjectAccessTokenTransientError &&
          current.value &&
          this.#now() < current.value.expiresAt
        ) {
          current.refreshAt = Math.min(
            this.#now() + REFRESH_RETRY_BACKOFF_MS,
            current.value.expiresAt,
          );
          this.#onRefreshDeferred?.();
          return current.value;
        }
        this.#entries.delete(key);
        throw error;
      })
      .finally(() => {
        if (current.pending === pending) current.pending = undefined;
      });
    current.pending = pending;
    return pending;
  }

  invalidate(scope: ProjectAccessTokenScope): void {
    this.#entries.delete(scopeKey(scope));
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** 仅用于拒绝某一代 PAT 的比较，不作为账号身份，也不传给模型上游。 */
export async function projectAccessTokenFingerprint(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function scopeKey(scope: ProjectAccessTokenScope): string {
  return JSON.stringify([
    scope.origin,
    scope.family,
    scope.accountId,
    scope.organizationId,
    scope.projectId,
    scope.apiKeyId,
    scope.usageScene,
    scope.loginGeneration,
  ]);
}
