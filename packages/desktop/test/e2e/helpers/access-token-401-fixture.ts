import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";

export async function prepareAccessToken401Fixture(options: {
  specs: string[];
  credentialsFile: string;
  settingsFile: string;
}): Promise<(() => Promise<void>) | null> {
  const sharedJwt = options.specs.some((spec) => spec.endsWith("jwt-401-auto-logout.test.ts"));
  const projectRecovery = options.specs.some((spec) =>
    spec.endsWith("project-location-decrypt-recovery.test.ts"),
  );
  if (
    !sharedJwt &&
    !projectRecovery &&
    !options.specs.some((spec) => spec.endsWith("access-token-401-auto-logout.test.ts"))
  )
    return null;

  const pending: ServerResponse[] = [];
  let businessRequestCount = 0;
  let rejected = false;
  let rejectionStatus = 401;
  let emptyRejection = false;
  const preserveSession = process.env.ZCODE_E2E_AUTH_VALIDATION_HEADER === "1";
  const ordinaryStatus = process.env.ZCODE_E2E_AUTH_EXPIRY_HTTP_STATUS === "200" ? 200 : 403;
  let ordinaryBusinessRequestCount = 0;
  let rawIdentityRequestCount = 0;
  let rejectedIdentityHeaderCount = 0;
  let locationRequests = 0;
  let tokenRequests = 0;
  let tokenAttempts = 0;
  let tokenRetryMode = false;
  let keyCreateRequests = 0;
  const tokenPaths: string[] = [];
  let loginCompletions = 0;
  let locationUnavailable = false;
  const provider =
    sharedJwt || preserveSession || process.env.ZCODE_E2E_AUTH_EXPIRY_PROVIDER === "zai"
      ? "zai"
      : "bigmodel";
  const rejectResponse = (response: ServerResponse) => {
    response.writeHead(rejectionStatus);
    response.end(emptyRejection ? "" : '{"code":401,"msg":"登录状态已过期","success":false}');
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    const path = url.pathname;
    response.setHeader("content-type", "application/json");
    if (path === "/__e2e/reject") {
      rejectionStatus = url.searchParams.get("status") === "200" ? 200 : 401;
      emptyRejection = url.searchParams.get("empty") === "1";
      rejected = true;
      for (const waiting of pending.splice(0)) {
        rejectResponse(waiting);
      }
      response.end("{}");
      return;
    }
    if (path === "/__e2e/status") {
      response.end(
        JSON.stringify({
          businessRequestCount,
          rejectionStatus,
          rejected,
          emptyRejection,
          ordinaryBusinessRequestCount,
          rawIdentityRequestCount,
          rejectedIdentityHeaderCount,
          locationRequests,
          tokenRequests,
          tokenAttempts,
          keyCreateRequests,
          tokenPaths,
          loginCompletions,
        }),
      );
      return;
    }
    if (projectRecovery) {
      if (path === "/__e2e/token-retry-once") {
        tokenRetryMode = true;
        tokenAttempts = 0;
        tokenPaths.length = 0;
        response.end("{}");
        return;
      }
      if (path === "/__e2e/location-unavailable" || path === "/__e2e/location-available") {
        locationUnavailable = path.endsWith("location-unavailable");
        response.end("{}");
        return;
      }
      let data: unknown;
      if (path === "/api/v1/client/scenes" || path === "/api/v1/marketing/touch") data = [];
      else if (path === "/api/biz/subscription/enterprise/v2/pricing") data = { productList: [] };
      else if (path === "/api/v1/oauth/cli/init")
        data = {
          authorize_url: "https://example.com/authorize?state=project-recovery",
          expires_at: Math.floor(Date.now() / 1000) + 300,
          flow_id: "project-recovery",
          poll_interval_sec: 1,
        };
      else if (path === "/api/v1/oauth/cli/poll/project-recovery") {
        loginCompletions++;
        data = {
          status: "ready",
          token: "e2e-distinct-zcode-jwt",
          user: { user_id: "e2e-user", name: "Fixture User" },
          bigmodel: { access_token: "e2e-business-access-token" },
        };
      } else if (path === "/api/biz/customer/getCustomerInfo") {
        locationRequests++;
        if (locationUnavailable) {
          response.writeHead(503);
          response.end(JSON.stringify({ code: 503 }));
          return;
        }
        data = {
          customerNumber: "e2e-user",
          organizations: [
            {
              organizationId: "org-e2e",
              projects: [{ projectId: "project-e2e", projectType: "1" }],
            },
          ],
        };
      } else if (path.endsWith("/api_keys")) {
        if (request.method === "POST") keyCreateRequests++;
        data = [{ apiKey: "key-e2e", name: "zcode-api-key" }];
      } else if (path.endsWith("/access_tokens")) {
        tokenRequests++;
        if (tokenRetryMode) {
          tokenPaths.push(path);
          tokenAttempts++;
          if (tokenAttempts === 1) {
            response.writeHead(503);
            response.end(JSON.stringify({ code: 503 }));
            return;
          }
        }
        data = {
          accessToken: "e2e-project-token",
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Date.now() / 1000 + 600,
        };
      } else if (path === "/api/biz/subscription/list")
        data = [
          {
            productId: "coding-pro-fixture",
            productName: "Coding Pro",
            status: "VALID",
            inCurrentPeriod: true,
          },
        ];
      else if (path === "/api/monitor/usage/quota/limit")
        data = {
          level: "pro",
          limits: [
            {
              type: "TIME_LIMIT",
              remaining: 5,
              percentage: 10,
              nextResetTime: Date.now() + 3600000,
            },
          ],
        };
      else if (path === "/api/v1/zcode-plan/billing/balance") data = { plans: [], balances: [] };
      if (data !== undefined) {
        response.end(JSON.stringify({ code: 0, data }));
        return;
      }
    }
    if (preserveSession && path === "/api/biz/customer/getCustomerInfo") {
      // PAT 资料读取和异常业务请求后的身份核验必须遵守同一个裸 token 契约。
      if (request.headers.authorization !== "e2e-business-access-token") {
        rejectedIdentityHeaderCount++;
        response.writeHead(401);
        response.end('{"code":401}');
      } else {
        if (ordinaryBusinessRequestCount > 0) rawIdentityRequestCount++;
        response.end(
          '{"code":200,"success":true,"data":{"customerNumber":"e2e-user","organizations":[{"organizationId":"org-e2e","organizationName":"Fixture Organization","projects":[{"projectId":"project-e2e","projectName":"Fixture Project","projectType":"1"}]}]}}',
        );
      }
      return;
    }
    if (preserveSession && path === "/api/oauth/userinfo") {
      response.end('{"code":200,"data":{"sub":"e2e-user","name":"Fixture User"}}');
      return;
    }
    if (
      preserveSession &&
      path.startsWith("/api/biz/") &&
      request.headers.authorization?.replace(/^Bearer\s+/i, "") === "e2e-business-access-token"
    ) {
      ordinaryBusinessRequestCount++;
      response.writeHead(ordinaryStatus);
      response.end("");
      return;
    }
    if (
      (sharedJwt && path === "/api/v1/zcode-plan/billing/balance") ||
      (!sharedJwt && path === "/api/biz/customer/getCustomerInfo")
    ) {
      // 只记录是否匹配合成登录凭据，避免 token 原文进入测试产物。
      if (
        request.headers.authorization?.replace(/^Bearer\s+/i, "") ===
        (sharedJwt ? "e2e-distinct-zcode-jwt" : "e2e-business-access-token")
      )
        businessRequestCount++;
      if (rejected) {
        rejectResponse(response);
      } else pending.push(response);
      return;
    }
    if (sharedJwt && path === "/api/biz/customer/getCustomerInfo") {
      response.end(
        JSON.stringify({
          code: 200,
          success: true,
          data: { user_id: "e2e-user", customerNumber: "e2e-user", name: "Fixture User" },
        }),
      );
      return;
    }
    // 其它控制面始终 200，保证失效提示只能来自上面的目标凭据请求。
    response.end(
      JSON.stringify({
        code: 0,
        data: { configs: {}, builtinModels: [], config_version: "oauth-401-fixture" },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OAuth fixture 缺少监听端口");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  // 用独立 origin 模拟业务域与 ZCode API，避免来源头和端点改写影响业务核验回归。
  const controlServer = preserveSession
    ? createServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            code: 0,
            data: { configs: {}, builtinModels: [], config_version: "oauth-401-fixture" },
          }),
        );
      })
    : null;
  let controlBaseUrl = baseUrl;
  if (controlServer) {
    controlServer.listen(0, "127.0.0.1");
    await once(controlServer, "listening");
    const controlAddress = controlServer.address();
    if (!controlAddress || typeof controlAddress === "string")
      throw new Error("OAuth control fixture 缺少监听端口");
    controlBaseUrl = `http://127.0.0.1:${controlAddress.port}`;
  }
  const envPatch = {
    ZCODE_E2E_ACCESS_TOKEN_401_URL: baseUrl,
    BIGMODEL_API_BASE_URL: baseUrl,
    BIGMODEL_OAUTH_USERINFO_URL: `${baseUrl}/api/biz/customer/getCustomerInfo`,
    ZAI_BUSINESS_BASE_URL: baseUrl,
    ZAI_OAUTH_USERINFO_URL: `${baseUrl}${preserveSession ? "/api/oauth/userinfo" : "/api/biz/customer/getCustomerInfo"}`,
    ZCODE_BASE_URL: controlBaseUrl,
    ZCODE_TEST_BASE_URL: controlBaseUrl,
    ZCODE_ENDPOINT_ORIGIN: controlBaseUrl,
  };
  const previous = Object.fromEntries(Object.keys(envPatch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, envPatch);
  await writeFile(
    options.credentialsFile,
    JSON.stringify({
      "oauth:active_provider": provider,
      [`oauth:${provider}:access_token`]: "e2e-business-access-token",
      [`oauth:${provider}:refresh_token`]: "e2e-refresh-token",
      [`oauth:${provider}:user_info`]: JSON.stringify(
        provider === "zai"
          ? { user_id: "e2e-user", name: "Fixture User" }
          : {
              id: "e2e-user",
              username: "Fixture User",
              displayName: "Fixture User",
              ...(projectRecovery ? { rawProfile: { zcodeProfileSchemaVersion: 2 } } : {}),
            },
      ),
      zcodejwttoken: "e2e-distinct-zcode-jwt",
      "bot:e2e:credential": "e2e-independent-bot-token",
      ...(projectRecovery
        ? {
            [`project-key-location:v1:${encodeURIComponent(JSON.stringify([baseUrl, "bigmodel", "e2e-user", null, 1, "non-team"]))}`]:
              "enc:v1:broken-project-location",
          }
        : {}),
    }),
    { mode: 0o600 },
  );
  const settings = JSON.parse(await readFile(options.settingsFile, "utf8"));
  await writeFile(
    options.settingsFile,
    JSON.stringify({
      ...settings,
      providerFamilyDomain: provider,
      providerFamilyConnectionSelections: { [provider]: { kind: "individual-coding-plan" } },
    }),
  );

  return async () => {
    if (preserveSession)
      console.info("[oauth-auth-fixture]", {
        ordinaryBusinessRequestCount,
        rawIdentityRequestCount,
        rejectedIdentityHeaderCount,
      });
    for (const response of pending.splice(0)) response.destroy();
    for (const fixtureServer of [server, controlServer]) {
      if (!fixtureServer) continue;
      const closed = new Promise<void>((resolve, reject) =>
        fixtureServer.close((error) => (error ? reject(error) : resolve())),
      );
      fixtureServer.closeAllConnections();
      await closed;
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
