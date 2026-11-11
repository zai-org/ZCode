import { z } from "zod";
import { projectTokenSuccessCodeSchema } from "./project-access-token-response.js";
import { API_KEY_USAGE_SCENE } from "./api-key-usage-scene.js";
import {
  ProjectAccessTokenCache,
  ProjectAccessTokenError,
  ProjectAccessTokenHttpStatusError,
  projectAccessTokenRequestFailureCode,
  ProjectAccessTokenTransientError,
} from "./project-access-token.js";
import { ZCODE_VERSION } from "./version.js";
import { isCredentialDecryptError } from "./oauth.js";

const MAX_TOKEN_ISSUE_ATTEMPTS = 2;
const MIN_RATE_LIMIT_RETRY_DELAY_MS = 250;
const MAX_RATE_LIMIT_RETRY_DELAY_MS = 1_000;
const DEFAULT_ORGANIZATION_NAME = "默认机构";
const DEFAULT_PROJECT_NAME = "默认项目";
const customerSchema = z.object({
  organizations: z
    .array(
      z.object({
        organizationId: z.string(),
        organizationName: z.string().nullish(),
        projects: z
          .array(
            z.object({
              projectId: z.string(),
              projectName: z.string().nullish(),
              projectType: z.union([z.string(), z.number()]).nullish(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});
const keySchema = z.object({
  apiKey: z.string().trim().min(1),
  name: z.string().nullish(),
  keyType: z.number().nullish(),
});
const envelopeSchema = z.object({
  code: projectTokenSuccessCodeSchema,
  data: z.unknown(),
});

export interface ProjectAccessTokenInput {
  readonly rejectedProjectTokenFingerprint?: string;
  readonly origin: string;
  readonly family: "bigmodel" | "zai";
  readonly loginToken: string;
  readonly accountId: string;
  /** 保留各调用端既有项目选择；CLI 默认项目不排除团队类型。 */
  readonly personalProjectSelection?: "non-team" | "default";
  readonly team?: {
    readonly organizationId: string;
    readonly projectId: string;
  };
}

export interface ProjectAccessTokenMaterial {
  readonly token: string;
  readonly apiKeyId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

const locationSchema = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  apiKeyId: z.string().min(1),
});
type KeyLocation = z.infer<typeof locationSchema>;
interface LoginSession {
  token: string;
  generation: string;
  locations: Map<string, Promise<KeyLocation>>;
  cache: ProjectAccessTokenCache;
}

/** Host/CLI 各自持有实例；网络由已有 adapter 注入，凭据不进入配置或磁盘。 */
export class ProjectAccessTokenClient {
  readonly #sessions = new Map<string, LoginSession>();
  #generation = 0;

  constructor(
    private readonly options: {
      request(url: string, init: RequestInit): Promise<unknown>;
      observe?(event: { family: string; stage: "resolve"; code: string }): void;
      locationStore?: {
        load(key: string): Promise<string | null>;
        save(key: string, value: string, assertCurrent?: () => void): Promise<void>;
        delete(key: string, assertCurrent?: () => void): Promise<void>;
        recoverUnreadable?(key: string, assertCurrent: () => void): Promise<string | null>;
      };
      now?: () => number;
      random?: () => number;
    },
  ) {}

  clear(): void {
    for (const session of this.#sessions.values()) session.cache.clear();
    this.#sessions.clear();
  }

  async resolve(input: ProjectAccessTokenInput): Promise<ProjectAccessTokenMaterial> {
    const origin = new URL(input.origin).origin;
    const loginToken = input.loginToken.trim().replace(/^Bearer\s+/i, "");
    if (!loginToken || !input.accountId.trim()) throw new Error("project_token_login_required");
    const sessionKey = JSON.stringify([origin, input.family]);
    let session = this.#sessions.get(sessionKey);
    if (!session || session.token !== loginToken) {
      session?.cache.clear();
      session = {
        token: loginToken,
        generation: String(++this.#generation),
        locations: new Map(),
        cache: new ProjectAccessTokenCache({
          now: this.options.now,
          random: this.options.random,
          onRefreshDeferred: () =>
            this.options.observe?.({
              family: input.family,
              stage: "resolve",
              code: "project_token_refresh_deferred",
            }),
        }),
      };
      this.#sessions.set(sessionKey, session);
    }
    const current = session;
    const assertCurrent = () => {
      if (this.#sessions.get(sessionKey) !== current)
        throw new ProjectAccessTokenError("project_token_scope_invalidated");
    };
    const headers = {
      Authorization: `Bearer ${loginToken}`,
      "Content-Type": "application/json",
    };
    const request = async (url: string, init: RequestInit) => {
      assertCurrent();
      const result = await this.options.request(url, init);
      assertCurrent();
      return result;
    };
    try {
      const selection = input.team ? null : (input.personalProjectSelection ?? "non-team");
      const locationKey = JSON.stringify([input.accountId, input.team ?? null, selection]);
      const storageKey = `project-key-location:v1:${encodeURIComponent(JSON.stringify([origin, input.family, input.accountId, input.team ?? null, API_KEY_USAGE_SCENE.CODING_PLAN, selection]))}`;
      let pending = current.locations.get(locationKey);
      if (!pending) {
        pending = (async () => {
          let saved: string | null | undefined;
          try {
            saved = await this.options.locationStore?.load(storageKey);
          } catch (error) {
            // 异常分支也必须先校验代次；clear 后的迟到失败不得触发恢复副作用。
            assertCurrent();
            if (!isCredentialDecryptError(error) || !this.options.locationStore?.recoverUnreadable)
              throw error;
            // 恢复端口本身可能发生 IO 错误；先保留固定诊断，避免外层错误归一后丢失解密线索。
            this.options.observe?.({
              family: input.family,
              stage: "resolve",
              code: "project_token_location_unreadable",
            });
            // 位置是可重建缓存，不是登录事实。恢复端口在共享锁内重读并仅删除仍坏的记录。
            saved = await this.options.locationStore.recoverUnreadable(storageKey, assertCurrent);
            assertCurrent();
            this.options.observe?.({
              family: input.family,
              stage: "resolve",
              code: "project_token_location_recovery",
            });
          }
          assertCurrent();
          if (saved) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(saved);
            } catch {
              /* 损坏记录通过正常元数据流程重建。 */
            }
            const value = locationSchema.safeParse(parsed);
            if (
              value.success &&
              (!input.team ||
                (value.data.organizationId === input.team.organizationId &&
                  value.data.projectId === input.team.projectId))
            )
              return value.data;
          }
          const result = await this.#resolveLocation(input, origin, loginToken, request);
          assertCurrent();
          await this.options.locationStore?.save(storageKey, JSON.stringify(result), assertCurrent);
          assertCurrent();
          return result;
        })();
        current.locations.set(locationKey, pending);
        void pending.catch(() => {
          if (current.locations.get(locationKey) === pending) current.locations.delete(locationKey);
        });
      }
      const location = await pending;
      assertCurrent();
      const value = await current.cache.resolve(
        {
          origin,
          family: input.family,
          accountId: input.accountId,
          ...location,
          usageScene: API_KEY_USAGE_SCENE.CODING_PLAN,
          loginGeneration: current.generation,
        },
        async (hasValidFallback) => {
          let raw: unknown;
          // 首签临时失败曾直接终止整轮；仅在已知 Key ID 的同一 pending 内重试一次。
          // 不把查询/创建 Key 或 OAuth 纳入重试，失败后先核对代次，避免旧账号继续签发。
          for (let attempt = 1; ; attempt++) {
            try {
              raw = await request(
                `${keyListUrl(origin, location)}/${encodeURIComponent(location.apiKeyId)}/access_tokens`,
                {
                  method: "POST",
                  headers,
                  body: JSON.stringify({ clientType: "zcode", clientVersion: ZCODE_VERSION }),
                },
              );
              break;
            } catch (error) {
              assertCurrent();
              const failure =
                error instanceof ProjectAccessTokenTransientError ? error.failure : undefined;
              const retryable =
                failure?.kind === "network" ||
                failure?.kind === "timeout" ||
                (failure?.kind === "http" &&
                  (failure.status === 429 || (failure.status >= 500 && failure.status < 600)));
              // 提前刷新已有可用 PAT 时直接走同一 pending 的降级，避免多等一轮超时。
              if (attempt >= MAX_TOKEN_ISSUE_ATTEMPTS || !retryable || hasValidFallback())
                throw error;
              if (failure?.kind === "http" && failure.status === 429) {
                const requestedDelay = failure.retryAfterMs;
                if (requestedDelay !== undefined && requestedDelay > MAX_RATE_LIMIT_RETRY_DELAY_MS)
                  throw error;
                const minimumDelay = Math.max(
                  MIN_RATE_LIMIT_RETRY_DELAY_MS,
                  Number.isFinite(requestedDelay) ? requestedDelay! : 0,
                );
                const random = Math.max(0, Math.min(1, (this.options.random ?? Math.random)()));
                const delay =
                  minimumDelay +
                  Math.floor((MAX_RATE_LIMIT_RETRY_DELAY_MS - minimumDelay) * random);
                // 限流不能紧接着重复请求；长 Retry-After 不截短重试，交还上层处理。
                await new Promise((resolve) => setTimeout(resolve, delay));
                assertCurrent();
              }
              this.options.observe?.({
                family: input.family,
                stage: "resolve",
                code: "project_token_request_retry",
              });
            }
          }
          // 仅明确不存在才废弃 ID；权限/网络/开关错误不能触发创建或 Key 回退。
          if (raw && typeof raw === "object" && "code" in raw && raw.code === 404) {
            current.locations.delete(locationKey);
            await this.options.locationStore?.delete(storageKey, assertCurrent);
          }
          return raw;
        },
        input.rejectedProjectTokenFingerprint,
      );
      assertCurrent();
      if (!value.enabled) throw new Error("project_token_disabled");
      return { token: value.token, ...location };
    } catch (error) {
      // 上游错误体或网络异常可能携带凭据；只传播固定错误码，不保留原始 cause/message。
      // adapter 已结构化归类的请求失败按类别投影，其余未知异常仍归 request_failed。
      const code =
        error instanceof ProjectAccessTokenError
          ? error.code
          : error instanceof ProjectAccessTokenTransientError ||
              error instanceof ProjectAccessTokenHttpStatusError
            ? projectAccessTokenRequestFailureCode(error.failure)
            : error instanceof Error &&
                [
                  "project_token_disabled",
                  "project_token_project_unavailable",
                  "project_token_invalid_response",
                ].includes(error.message)
              ? error.message
              : "project_token_request_failed";
      this.options.observe?.({ family: input.family, stage: "resolve", code });
      throw new Error(code);
    }
  }

  async #resolveLocation(
    input: ProjectAccessTokenInput,
    origin: string,
    loginToken: string,
    request: (url: string, init: RequestInit) => Promise<unknown>,
  ): Promise<KeyLocation> {
    // customerInfo 要求裸业务 token；Bearer 格式拒绝会被误判为登录失效。
    const headers = {
      Authorization: loginToken,
      "Content-Type": "application/json",
    };
    const customer = customerSchema.safeParse(
      readData(
        await request(`${origin}/api/biz/customer/getCustomerInfo`, {
          method: "GET",
          headers,
        }),
      ),
    );
    if (!customer.success) throw new Error("project_token_invalid_response");
    const organizations = customer.data.organizations;
    let location = input.team;
    if (location) {
      if (
        !organizations.some(
          (org) =>
            org.organizationId.trim() === location!.organizationId.trim() &&
            org.projects.some((p) => p.projectId.trim() === location!.projectId.trim()),
        )
      )
        throw new Error("project_token_project_unavailable");
    } else {
      const personal =
        input.personalProjectSelection === "default"
          ? organizations
          : organizations
              .map((org) => ({
                ...org,
                projects: org.projects.filter((p) => String(p.projectType ?? "").trim() !== "2"),
              }))
              .filter((org) => org.organizationId && org.projects.length);
      const org =
        personal.find((org) => org.organizationName?.includes(DEFAULT_ORGANIZATION_NAME)) ??
        personal[0];
      const project =
        org?.projects.find((p) => p.projectName?.includes(DEFAULT_PROJECT_NAME)) ??
        org?.projects[0];
      if (!org?.organizationId || !project?.projectId)
        throw new Error("project_token_project_unavailable");
      location = {
        organizationId: org.organizationId,
        projectId: project.projectId,
      };
    }
    const url = keyListUrl(origin, location);
    const name = input.team ? "zcode-team-api-key" : "zcode-api-key";
    const keyHeaders = input.team
      ? {
          ...headers,
          Authorization: loginToken,
          "bigmodel-organization": location.organizationId,
          "bigmodel-project": location.projectId,
        }
      : {
          ...headers,
          // 个人 Key 管理保留既有格式，不能套用 customerInfo 的鉴权约定。
          Authorization: input.family === "zai" ? `Bearer ${loginToken}` : loginToken,
        };
    const list = z
      .array(z.unknown())
      .safeParse(readData(await request(url, { method: "GET", headers: keyHeaders })));
    if (!list.success) throw new Error("project_token_invalid_response");
    // 列表可能含无关坏条目。个人同名条目缺 ID 时禁止重复创建；团队只复用有效条目。
    const candidate = list.data.find((entry) => {
      if (!entry || typeof entry !== "object" || !("name" in entry) || entry.name !== name)
        return false;
      if (!input.team) return true;
      const parsed = keySchema.safeParse(entry);
      return parsed.success && parsed.data.keyType === 2;
    });
    const rawKey =
      candidate ??
      readData(
        await request(url, {
          method: "POST",
          headers: keyHeaders,
          body: JSON.stringify({
            name,
            ...(input.team ? { keyType: 2 } : {}),
            usageScene: API_KEY_USAGE_SCENE.CODING_PLAN,
          }),
        }),
      );
    const key = keySchema.safeParse(rawKey);
    if (!key.success || (input.team && (key.data.name !== name || key.data.keyType !== 2)))
      throw new Error("project_token_invalid_response");
    return { ...location, apiKeyId: key.data.apiKey };
  }
}

function keyListUrl(
  origin: string,
  location: { organizationId: string; projectId: string },
): string {
  return `${origin}/api/biz/v1/organization/${encodeURIComponent(location.organizationId)}/projects/${encodeURIComponent(location.projectId)}/api_keys`;
}

function readData(raw: unknown): unknown {
  const value = envelopeSchema.safeParse(raw);
  if (!value.success) throw new Error("project_token_invalid_response");
  return value.data.data;
}
