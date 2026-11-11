import { vi } from "vitest";
import { type HttpClientPort } from "@zcode/contracts";
import { createCodingPlanApiKeyResolver } from "../src/auth/coding-plan-api-key.js";
export function fixture(
  options: { jwtTtl?: number; expiresIn?: number; failures?: number[] } = {},
) {
  let logins = 0;
  let issues = 0;
  const failures = [...(options.failures ?? [])];
  const request = vi.fn(async (req: { url: string }) => {
    let body: unknown;
    let status = 200;
    if (req.url.endsWith("/api/auth/z/login")) {
      logins++;
      const claims = { exp: Date.now() / 1000 + (options.jwtTtl ?? 600), sub: String(logins) };
      const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
      body = {
        code: 200,
        data: {
          access_token: token,
          ...(options.expiresIn === undefined ? {} : { expires_in: options.expiresIn }),
        },
      };
    } else if (req.url.endsWith("/getCustomerInfo")) {
      body = {
        code: 200,
        data: {
          organizations: [
            {
              organizationId: "org",
              organizationName: "默认机构",
              projects: [{ projectId: "project", projectName: "默认项目" }],
            },
          ],
        },
      };
    } else if (req.url.endsWith("/api_keys")) {
      body = { code: 200, data: [{ apiKey: "key", name: "zcode-api-key" }] };
    } else {
      issues++;
      status = failures.shift() ?? 200;
      body = {
        code: status,
        data: {
          accessToken: `pat-${issues}`,
          tokenType: "Bearer",
          expiresIn: 1,
          expiresAt: Date.now() / 1000 + 1,
        },
      };
    }
    return { status, body: new TextEncoder().encode(JSON.stringify(body)) };
  });
  const resolver = createCodingPlanApiKeyResolver({
    httpClient: { request } as unknown as HttpClientPort,
  });
  const input = { family: "zai", accessToken: "oauth", accountIdentity: "user" } as const;
  return {
    resolve: () => resolver.resolve(input),
    clear: () => resolver.clear(),
    logins: () => logins,
    issues: () => issues,
    request,
  };
}
