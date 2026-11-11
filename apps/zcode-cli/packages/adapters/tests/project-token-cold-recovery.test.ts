import { projectAccessTokenRetryAfterMs } from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHttpClientError,
  type HttpClientPort,
  type HttpClientRequest,
} from "@zcode/contracts";
import { createCodingPlanApiKeyResolver } from "../src/auth/coding-plan-api-key.js";

type Reply = { status: number; data: unknown; headers?: Record<string, string> };
afterEach(() => vi.useRealTimers());
const success = (token = "synthetic-pat"): Reply => ({
  status: 200,
  data: {
    accessToken: token,
    tokenType: "Bearer",
    expiresIn: 600,
    expiresAt: Date.now() / 1000 + 600,
  },
});
const httpFailure = (status: number): Reply => ({
  status,
  data: { code: status, msg: "private-message" },
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture(
  issue: (attempt: number, request: HttpClientRequest) => Promise<Reply> | Reply,
  options: {
    create?: boolean;
    creationFailure?: boolean;
    metadataFailure?: boolean;
    businessFailure?: boolean;
  } = {},
) {
  let issues = 0;
  let creations = 0;
  const observe = vi.fn();
  const request = vi.fn(async (input: HttpClientRequest) => {
    let reply: Reply;
    if (input.url.endsWith("/api/auth/z/login")) {
      reply = options.businessFailure
        ? httpFailure(503)
        : { status: 200, data: { access_token: "business-jwt", expires_in: 3600 } };
    } else if (input.url.endsWith("getCustomerInfo")) {
      reply = options.metadataFailure
        ? httpFailure(503)
        : {
            status: 200,
            data: {
              organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }],
            },
          };
    } else if (input.url.endsWith("api_keys")) {
      if (input.method === "POST") {
        creations++;
        reply = options.creationFailure
          ? httpFailure(503)
          : { status: 200, data: { apiKey: "key", name: "zcode-api-key" } };
      } else
        reply = {
          status: 200,
          data: options.create ? [] : [{ apiKey: "key", name: "zcode-api-key" }],
        };
    } else reply = await issue(++issues, input);
    return {
      status: reply.status,
      headers: reply.headers,
      body: new TextEncoder().encode(
        JSON.stringify({ code: reply.status === 200 ? 0 : reply.status, data: reply.data }),
      ),
    };
  });
  const resolver = createCodingPlanApiKeyResolver({
    httpClient: { request } as unknown as HttpClientPort,
    observe,
  });
  return { resolver, observe, request, issues: () => issues, creations: () => creations };
}
const input = { family: "bigmodel" as const, accessToken: "oauth-a", accountIdentity: "account-a" };

describe("PAT 签发有界恢复", () => {
  it.each([undefined, "1", "invalid"])("429 Retry-After=%s 不立即重试", async (retryAfter) => {
    vi.useFakeTimers();
    const f = fixture((attempt) =>
      attempt === 1
        ? {
            ...httpFailure(429),
            headers: retryAfter === undefined ? undefined : { "Retry-After": retryAfter },
          }
        : success(),
    );
    const pending = f.resolver.resolve(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.issues()).toBe(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(f.issues()).toBe(1);
    await vi.advanceTimersByTimeAsync(751);
    await expect(pending).resolves.toBe("synthetic-pat");
    expect(f.issues()).toBe(2);
  });

  it("429 要求等待超过预算时保留错误，不提前发送", async () => {
    const f = fixture(() => ({ ...httpFailure(429), headers: { "retry-after": "60" } }));
    await expect(f.resolver.resolve(input)).rejects.toThrow("project_token_http_429");
    expect(f.issues()).toBe(1);
  });

  it("429 的 HTTP 日期在同一等待预算内生效", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Math.floor(Date.now() / 1000) * 1000);
    const retryAt = new Date(Date.now() + 1000).toUTCString();
    const f = fixture((attempt) =>
      attempt === 1 ? { ...httpFailure(429), headers: { "retry-after": retryAt } } : success(),
    );
    const pending = f.resolver.resolve(input);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.issues()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("synthetic-pat");
    expect(f.issues()).toBe(2);
  });

  it("429 等待期间 clear 不发送旧账号的第二次签发", async () => {
    vi.useFakeTimers();
    const f = fixture(() => httpFailure(429));
    const pending = f.resolver.resolve(input);
    const result = pending.then(
      (value) => value,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    f.resolver.clear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ message: "project_token_scope_invalidated" });
    expect(f.issues()).toBe(1);
  });

  it.each(["bigmodel", "zai"] as const)("%s 首次临时失败由并发调用共享一次重试", async (family) => {
    const f = fixture((attempt) => (attempt === 1 ? httpFailure(503) : success()), {
      create: true,
    });
    await expect(
      Promise.all([
        f.resolver.resolve({ ...input, family }),
        f.resolver.resolve({ ...input, family }),
      ]),
    ).resolves.toEqual(["synthetic-pat", "synthetic-pat"]);
    expect(f.issues()).toBe(2);
    expect(f.creations()).toBe(1);
    expect(f.observe).toHaveBeenCalledExactlyOnceWith({
      family,
      stage: "resolve",
      code: "project_token_request_retry",
    });
    expect(JSON.stringify(f.observe.mock.calls)).not.toContain("private-message");
  });

  it.each(["network_error", "timeout", 429, 503] as const)(
    "%s 只重试一次且保留最终分类",
    async (failure) => {
      const f = fixture(() => {
        if (typeof failure === "string")
          throw createHttpClientError({ code: failure, message: "private-message" });
        return httpFailure(failure);
      });
      const code =
        failure === "network_error"
          ? "network_error"
          : failure === "timeout"
            ? "timeout"
            : `http_${failure}`;
      await expect(f.resolver.resolve(input)).rejects.toThrow(`project_token_${code}`);
      expect(f.issues()).toBe(2);
      expect(
        f.observe.mock.calls.filter(([event]) => event.code === "project_token_request_retry"),
      ).toHaveLength(1);
    },
  );

  it.each([
    401,
    403,
    404,
    "cancelled",
    "egress_blocked",
    "invalid",
    "business",
    "unknown",
    "expired",
    "disabled",
  ] as const)("%s 不进入签发重试", async (failure) => {
    const f = fixture(() => {
      if (failure === "cancelled" || failure === "egress_blocked")
        throw createHttpClientError({ code: failure, message: "private-message" });
      if (failure === "unknown") throw new Error("timeout");
      if (failure === "expired")
        return {
          status: 200,
          data: {
            accessToken: "expired",
            tokenType: "Bearer",
            expiresIn: 600,
            expiresAt: Date.now() / 1000 - 1,
          },
        };
      if (failure === "disabled") return { status: 200, data: { enable: false } };
      if (failure === "invalid") return { status: 200, data: null };
      if (failure === "business") return { status: 200, data: { code: 503, msg: "denied" } };
      return httpFailure(failure);
    });
    await expect(f.resolver.resolve(input)).rejects.toThrow();
    expect(f.issues()).toBe(1);
    expect(
      f.observe.mock.calls.some(([event]) => event.code === "project_token_request_retry"),
    ).toBe(false);
  });

  it("Key 创建失败不重试或开始签发", async () => {
    const f = fixture(() => success(), { create: true, creationFailure: true });
    await expect(f.resolver.resolve(input)).rejects.toThrow("project_token_http_503");
    expect(f.creations()).toBe(1);
    expect(f.issues()).toBe(0);
  });

  it.each(["metadataFailure", "businessFailure"] as const)(
    "%s 不被签发重试扩大",
    async (failure) => {
      const f = fixture(() => success(), { [failure]: true });
      await expect(f.resolver.resolve({ ...input, family: "zai" })).rejects.toThrow();
      expect(f.issues()).toBe(0);
      expect(
        f.request.mock.calls.filter(([r]) =>
          r.url.endsWith(failure === "metadataFailure" ? "getCustomerInfo" : "/api/auth/z/login"),
        ),
      ).toHaveLength(1);
    },
  );

  it("第一次失败迟到于 clear 时不启动旧账号重试", async () => {
    const entered = deferred();
    const response = deferred();
    const f = fixture(async (attempt) => {
      if (attempt === 1) {
        entered.release();
        await response.promise;
        return httpFailure(503);
      }
      return success("new-pat");
    });
    const old = f.resolver.resolve(input);
    const rejected = expect(old).rejects.toThrow("project_token_scope_invalidated");
    await entered.promise;
    f.resolver.clear();
    await expect(
      f.resolver.resolve({ ...input, accessToken: "oauth-b", accountIdentity: "account-b" }),
    ).resolves.toBe("new-pat");
    response.release();
    await rejected;
    expect(f.issues()).toBe(2);
    expect(
      f.observe.mock.calls.some(([event]) => event.code === "project_token_request_retry"),
    ).toBe(false);
  });

  it("重试成功迟到于切账号时不污染新缓存", async () => {
    const entered = deferred();
    const response = deferred();
    const f = fixture(async (attempt) => {
      if (attempt === 1) return httpFailure(503);
      if (attempt === 2) {
        entered.release();
        await response.promise;
        return success("old-pat");
      }
      return success("new-pat");
    });
    const old = f.resolver.resolve(input);
    const rejected = expect(old).rejects.toThrow("project_token_scope_invalidated");
    await entered.promise;
    f.resolver.clear();
    const nextInput = { ...input, accessToken: "oauth-b", accountIdentity: "account-b" };
    await expect(f.resolver.resolve(nextInput)).resolves.toBe("new-pat");
    response.release();
    await rejected;
    await expect(f.resolver.resolve(nextInput)).resolves.toBe("new-pat");
    expect(f.issues()).toBe(3);
  });

  it("一个等待者取消不打断另一个等待者的签发重试", async () => {
    const entered = deferred();
    const response = deferred();
    const f = fixture(async (attempt) => {
      if (attempt === 1) {
        entered.release();
        await response.promise;
        return httpFailure(503);
      }
      return success();
    });
    const controller = new AbortController();
    const first = f.resolver.resolve(input, { signal: controller.signal });
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;
    const second = f.resolver.resolve(input);
    controller.abort();
    await rejected;
    response.release();
    await expect(second).resolves.toBe("synthetic-pat");
    expect(f.issues()).toBe(2);
  });
});

// 解析器由 Host 和 CLI 共用；保留 CLI 回归，避免恢复已退役的 App 业务单测。
describe("Retry-After 相对等待量", () => {
  const now = Date.UTC(2026, 10, 2, 0, 0, 0);
  const cases: Array<[string | null | undefined, number | undefined]> = [
    ["1", 1000],
    ["0.5", 500],
    [" 60 ", 60000],
    [new Date(now + 1000).toUTCString(), 1000],
    [new Date(now - 1000).toUTCString(), 0],
    ["invalid", undefined],
    ["", undefined],
    [null, undefined],
    [undefined, undefined],
  ];
  it.each(cases)("解析 %s", (input, expected) => {
    expect(projectAccessTokenRetryAfterMs(input, now)).toBe(expected);
  });
});
