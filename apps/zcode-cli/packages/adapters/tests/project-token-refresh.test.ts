import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpClientError, type HttpClientPort } from "@zcode/contracts";
import { createCodingPlanApiKeyResolver } from "../src/auth/coding-plan-api-key.js";

afterEach(() => vi.useRealTimers());

describe.each(["bigmodel", "zai"] as const)("%s PAT 临时刷新失败", (family) => {
  it.each([
    "network_error",
    "timeout",
    "cancelled",
    "egress_blocked",
    "invalid",
    429,
    503,
    403,
    404,
  ] as const)("%s 分类、并发与过期", async (failure) => {
    vi.useFakeTimers();
    const start = Date.now();
    let issues = 0;
    const request = vi.fn(async ({ url }: { url: string }) => {
      let data: unknown;
      let status = 200;
      if (url.endsWith("/api/auth/z/login"))
        data = { access_token: "business-jwt", expires_in: 3600 };
      else if (url.endsWith("getCustomerInfo"))
        data = { organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }] };
      else if (url.endsWith("api_keys")) data = [{ apiKey: "key", name: "zcode-api-key" }];
      else {
        issues++;
        if (issues > 1) {
          if (failure === "invalid")
            return { status: 200, body: new TextEncoder().encode("invalid secret JSON") };
          if (typeof failure === "string")
            throw createHttpClientError({ code: failure, message: "secret failure" });
          status = failure;
        }
        data = {
          accessToken: "old-pat",
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: start / 1000 + 600,
        };
      }
      return { status, body: new TextEncoder().encode(JSON.stringify({ code: "0", data })) };
    });
    const observe = vi.fn();
    const resolver = createCodingPlanApiKeyResolver({
      httpClient: { request } as unknown as HttpClientPort,
      observe,
    });
    const input = { family, accessToken: "oauth", accountIdentity: "user" };
    await expect(resolver.resolve(input)).resolves.toBe("old-pat");
    vi.setSystemTime(start + 481_000);
    if (["network_error", "timeout", 429, 503].includes(failure)) {
      await expect(
        Promise.all([resolver.resolve(input), resolver.resolve(input)]),
      ).resolves.toEqual(["old-pat", "old-pat"]);
      await resolver.resolve(input);
      expect(issues).toBe(2);
      expect(
        observe.mock.calls.filter(([event]) => event.code === "project_token_refresh_deferred"),
      ).toEqual([
        [
          {
            family,
            stage: "resolve",
            code: "project_token_refresh_deferred",
          },
        ],
      ]);
      vi.setSystemTime(start + 600_000);
    }
    // ZCT-2111046389485834240：最终失败保留固定类别；未分类的 HttpClientPort 错误仍归 request_failed。
    const expectedCode: Record<string, string> = {
      network_error: "project_token_network_error",
      timeout: "project_token_timeout",
      cancelled: "project_token_request_failed",
      egress_blocked: "project_token_request_failed",
      invalid: "project_token_invalid_response",
      429: "project_token_http_429",
      503: "project_token_http_503",
      403: "project_token_http_403",
      404: "project_token_invalid_response",
    };
    const rejection = expect(resolver.resolve(input)).rejects.toThrow(
      new RegExp(`^${expectedCode[String(failure)]}$`),
    );
    await vi.runAllTimersAsync();
    await rejection;
    expect(JSON.stringify(observe.mock.calls)).not.toMatch(/secret|old-pat|oauth|business-jwt/);
  });

  it.each([
    [481_000, "old-pat", 2],
    [599_000, "new-pat", 3],
  ] as const)("刷新从 %dms 开始时，按失败时的有效期处理", async (offset, expected, count) => {
    vi.useFakeTimers();
    const start = Date.now();
    let issues = 0;
    const request = vi.fn(async ({ url }: { url: string }) => {
      let data: unknown;
      if (url.endsWith("/api/auth/z/login"))
        data = { access_token: "business-jwt", expires_in: 3600 };
      else if (url.endsWith("getCustomerInfo"))
        data = { organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }] };
      else if (url.endsWith("api_keys")) data = [{ apiKey: "key", name: "zcode-api-key" }];
      else {
        issues++;
        if (issues === 2) {
          await new Promise((resolve) => setTimeout(resolve, 15_000));
          throw createHttpClientError({ code: "timeout", message: "synthetic timeout" });
        }
        data = {
          accessToken: issues === 1 ? "old-pat" : "new-pat",
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Date.now() / 1000 + 600,
        };
      }
      return { status: 200, body: new TextEncoder().encode(JSON.stringify({ code: 0, data })) };
    });
    const resolver = createCodingPlanApiKeyResolver({
      httpClient: { request } as unknown as HttpClientPort,
    });
    const input = { family, accessToken: "oauth", accountIdentity: "user" };
    await resolver.resolve(input);
    vi.setSystemTime(start + offset);
    let result: string | undefined;
    const pending = resolver.resolve(input).then((token) => {
      result = token;
    });
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(issues).toBe(count);
      await pending;
      expect(result).toBe(expected);
    } finally {
      await vi.runAllTimersAsync();
      await pending;
    }
  });
});
