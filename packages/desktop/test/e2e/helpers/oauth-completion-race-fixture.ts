import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";

export async function prepareOAuthCompletionRaceFixture(
  specs: string[],
): Promise<(() => Promise<void>) | null> {
  const credentialRecovery = specs.some((spec) =>
    spec.endsWith("credential-store-recovery.test.ts"),
  );
  if (!credentialRecovery && !specs.some((spec) => spec.endsWith("oauth-completion-race.test.ts")))
    return null;
  let tokenResponse: ServerResponse | undefined;
  let tokenRequests = 0;
  let readyResponses = 0;
  let pollingEnabled = credentialRecovery;
  let clockMode: "backward" | "forward" | "expired-init" | null = null;
  let pollRequests = 0;
  let failPolling = false;
  let activeProvider = "zai";
  let cnReady = false;
  let businessExchanges = 0;
  let profileMode = "valid";
  let profileRequests = 0;
  let profileHeld = false;
  let globalSubjectProbe = false;
  let shortExpiry = false;
  let flowExpiresAtMs = 0;
  const profileWaiters: Array<() => void> = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    response.setHeader("content-type", "application/json");
    if (path === "/__e2e/status") {
      response.end(
        JSON.stringify({
          tokenRequests,
          readyResponses,
          pollRequests,
          activeProvider,
          businessExchanges,
          profileRequests,
        }),
      );
    } else if (path === "/__e2e/global-subject-probe") {
      globalSubjectProbe =
        new URL(request.url!, "http://fixture").searchParams.get("enabled") === "true";
      response.end("{}");
    } else if (path === "/__e2e/short-expiry") {
      shortExpiry = new URL(request.url!, "http://fixture").searchParams.get("enabled") === "true";
      response.end("{}");
    } else if (path === "/__e2e/profile-hold") {
      profileHeld = new URL(request.url!, "http://fixture").searchParams.get("held") === "true";
      if (!profileHeld) profileWaiters.splice(0).forEach((release) => release());
      response.end("{}");
    } else if (path === "/__e2e/profile-mode") {
      profileMode = new URL(request.url!, "http://fixture").searchParams.get("mode") ?? "valid";
      response.end("{}");
    } else if (path === "/api/v1/oauth/profile") {
      profileRequests++;
      if (profileHeld) await new Promise<void>((resolve) => profileWaiters.push(resolve));
      if (profileMode === "unauthorized") {
        response.writeHead(401);
        response.end(JSON.stringify({ code: 401 }));
      } else {
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              ...(profileMode.startsWith("linked")
                ? {
                    bigmodel: {
                      customer_id: "e2e-profile-customer",
                      access_token: "e2e-profile-linked-secret",
                    },
                  }
                : {}),
              user: {
                user_id: profileMode === "mismatch" ? "different-user" : "e2e-cn-zcode-user",
                name: "CN User",
              },
            },
          }),
        );
      }
    } else if (path === "/__e2e/cn-ready") {
      cnReady = new URL(request.url!, "http://fixture").searchParams.get("ready") !== "false";
      response.end("{}");
    } else if (path === "/__e2e/hold-poll") {
      pollingEnabled = false;
      response.end("{}");
    } else if (path.startsWith("/__e2e/clock/")) {
      const mode = path.split("/").at(-1);
      clockMode =
        mode === "backward" || mode === "forward" || mode === "expired-init" ? mode : null;
      response.end("{}");
    } else if (path === "/__e2e/enable-poll") {
      pollingEnabled = true;
      response.end("{}");
    } else if (path === "/__e2e/disable-poll") {
      pollingEnabled = false;
      failPolling = false;
      response.end("{}");
    } else if (path === "/__e2e/fail-poll") {
      pollingEnabled = true;
      failPolling = true;
      response.end("{}");
    } else if (path === "/__e2e/complete-token") {
      tokenResponse?.end(
        JSON.stringify({
          code: 0,
          data: {
            token: "cancelled-jwt",
            user: { user_id: "e2e-exchange-user", name: "Exchange User" },
            zai: { access_token: "cancelled-zai-oauth" },
            // 新关联字段和未来扩展都不能通过响应日志泄漏。这里只使用合成凭据。
            bigmodel: {
              customer_id: "e2e-associated-customer",
              access_token: "e2e-associated-bigmodel-secret",
            },
            extension: { secret: "e2e-response-extension-secret" },
          },
        }),
      );
      tokenResponse = undefined;
      response.end("{}");
    } else if (path === "/__e2e/fail-token") {
      tokenResponse?.writeHead(500);
      tokenResponse?.end('{"code":500,"msg":"controlled exchange failure"}');
      tokenResponse = undefined;
      response.end("{}");
    } else if (path === "/api/v1/oauth/cli/init") {
      let body = "";
      for await (const chunk of request) body += chunk;
      activeProvider = JSON.parse(body).provider;
      tokenRequests = 0;
      readyResponses = 0;
      pollRequests = 0;
      const expiresAt =
        Math.floor(Date.now() / 1000) + (clockMode === "expired-init" ? -1 : shortExpiry ? 4 : 300);
      flowExpiresAtMs = expiresAt * 1000;
      response.end(
        JSON.stringify({
          code: 0,
          data: {
            authorize_url:
              activeProvider === "zai_cn"
                ? "https://example.com/cn/authorize?state=e2e-race&client_id=e2e-cn-client&response_type=code&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback%2Fzai_cn"
                : "https://example.com/authorize?state=e2e-race&channel_id=desktop-launch",
            expires_at: expiresAt,
            flow_id: "e2e-race",
            poll_interval_sec: 1,
          },
        }),
      );
    } else if (path === "/api/v1/oauth/token") {
      tokenRequests++;
      tokenResponse = response;
    } else if (path === "/api/auth/z/login") {
      businessExchanges++;
      // Z.ai 轮询结果先经过业务 token 转换，桌面端落盘的是 /api/auth/z/login 返回的 token。
      response.end(JSON.stringify({ code: 0, data: { access_token: "e2e-race-business" } }));
    } else if (path === "/api/oauth/userinfo") {
      response.end(
        JSON.stringify({
          code: 0,
          data: {
            sub: globalSubjectProbe ? "global-upstream-subject" : "e2e-race-user",
            name: globalSubjectProbe ? "Updated Global Display" : "Race User",
          },
        }),
      );
    } else if (path === "/api/v1/oauth/cli/poll/e2e-race") {
      pollRequests++;
      if (shortExpiry && pollRequests === 1) {
        // 首个查询挂起到期限之后才返回，保证 Host 的本地期限定时器先清除 flow。
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, flowExpiresAtMs + 1_500 - Date.now())),
        );
        response.end('{"code":0,"data":{"status":"pending"}}');
        return;
      }
      if (clockMode) {
        if (pollRequests === 1) {
          response.setHeader(
            "x-e2e-clock-offset-ms",
            clockMode === "backward" ? -172800000 : 172800000,
          );
          response.end('{"code":0,"data":{"status":"pending"}}');
        } else {
          response.end(
            JSON.stringify({
              code: 0,
              data: {
                status: "ready",
                token: "e2e-clock-jwt",
                user: { user_id: "e2e-clock-user", name: "Clock User" },
                zai: { access_token: `e2e-clock-zai-${clockMode}` },
                // 旧 BigModel 主登录夹具没有关联身份；分区登录按关联账号合同校验 customer_id。
                bigmodel: {
                  customer_id: "e2e-clock-customer",
                  access_token: `e2e-clock-business-${clockMode}`,
                },
              },
            }),
          );
        }
        return;
      }
      if (activeProvider === "zai_cn") {
        response.end(
          JSON.stringify({
            code: 0,
            data: cnReady
              ? {
                  status: "ready",
                  token: "e2e-cn-zcode-jwt",
                  user: { user_id: "e2e-cn-zcode-user", name: "CN User" },
                  zai: { user_id: "e2e-zai-user", access_token: "e30.eyJleHAiOjF9.signature" },
                  bigmodel: {
                    customer_id: "e2e-linked-customer",
                    access_token: "e2e-linked-jwt-secret",
                  },
                }
              : { status: "pending" },
          }),
        );
      } else if (!pollingEnabled || (!tokenRequests && !credentialRecovery))
        response.end('{"code":0,"data":{"status":"pending"}}');
      else if (failPolling) {
        readyResponses++;
        response.end('{"code":0,"data":{"status":"failed"}}');
      } else {
        readyResponses++;
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              status: "ready",
              token: "e2e-race-jwt",
              user: { user_id: "e2e-race-user", name: "Race User" },
              zai: { access_token: "e2e-race-zai-oauth" },
            },
          }),
        );
      }
    } else {
      response.end(
        JSON.stringify({
          code: 0,
          data: { configs: {}, builtinModels: [], config_version: "oauth-race" },
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OAuth race fixture 缺少端口");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const envPatch = {
    ZCODE_E2E_OAUTH_RACE_URL: baseUrl,
    ZCODE_CREDENTIAL_SECRET: "oauth-completion-race-fixture",
    ZCODE_BASE_URL: baseUrl,
    ZCODE_TEST_BASE_URL: baseUrl,
    ZCODE_ENDPOINT_ORIGIN: baseUrl,
    BIGMODEL_API_BASE_URL: baseUrl,
    BIGMODEL_OAUTH_USERINFO_URL: `${baseUrl}/api/biz/customer/getCustomerInfo`,
    // 登录成功会触发套餐刷新；只覆盖换证 URL 仍会把合成 token 发往真实业务域。
    ZAI_BUSINESS_BASE_URL: baseUrl,
    ZAI_BUSINESS_LOGIN_URL: `${baseUrl}/api/auth/z/login`,
    ZAI_OAUTH_USERINFO_URL: `${baseUrl}/api/oauth/userinfo`,
  };
  const previous = Object.fromEntries(Object.keys(envPatch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, envPatch);
  return async () => {
    profileWaiters.splice(0).forEach((release) => release());
    tokenResponse?.destroy();
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
