import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { prepareWebRemoteControlSessionEventsFixture } from "./web-remote-control-session-events-fixture.js";

/** 观测未登录门禁与远控401后的登录启动；不模拟认证成功。 */
export async function prepareWebRemoteControlAuthGateFixture(options: {
  specs: string[];
  credentialsFile: string;
  settingsFile: string;
  workspacePath: string;
  webUrl?: string;
}): Promise<(() => Promise<void>) | null> {
  if (
    options.specs.some(
      (spec) =>
        spec.endsWith("conversation-session-virtual-project-mobile.test.ts") ||
        spec.endsWith("conversation-session-composer-settlement.test.ts") ||
        spec.endsWith("conversation-session-switch-stability.test.ts") ||
        spec.endsWith("conversation-session-new-task-missing-root-mobile.test.ts") ||
        spec.endsWith("command-center-history-search.test.ts") ||
        spec.endsWith("conversation-session-web-remote-terminal.test.ts") ||
        spec.endsWith("conversation-session-runtime-restart.test.ts") ||
        spec.endsWith("conversation-session-shared-cli.test.ts") ||
        // 远程批量 runner 的 HOME 没有登录态；复用本地账号/relay，避免卡在配对链接门禁。
        spec.endsWith("conversation-session-r3-mobile.test.ts") ||
        spec.endsWith("conversation-session-r3-mobile-permission.test.ts") ||
        spec.endsWith("conversation-session-r3-soak-dual.test.ts") ||
        spec.endsWith("conversation-session-web-remote-project-directory.test.ts") ||
        spec.endsWith("conversation-session-remote-draft-prewarm.test.ts") ||
        spec.endsWith("conversation-session-web-remote-recovery.test.ts") ||
        spec.endsWith("conversation-session-web-remote-unread.test.ts") ||
        spec.endsWith("conversation-session-workspace-mcp-trust.test.ts") ||
        spec.endsWith("conversation-session-id-compatibility.test.ts") ||
        spec.endsWith("conversation-session-gen-ui-context.test.ts"),
    )
  )
    return prepareWebRemoteControlSessionEventsFixture({
      ...options,
      // 新回归使用独立端口；既有手机用例仍保留固定入口。
      webUrl:
        options.webUrl ??
        (options.specs.some(
          (spec) =>
            spec.endsWith("conversation-session-web-remote-terminal.test.ts") ||
            spec.endsWith("conversation-session-composer-settlement.test.ts") ||
            spec.endsWith("conversation-session-switch-stability.test.ts") ||
            spec.endsWith("conversation-session-runtime-restart.test.ts") ||
            spec.endsWith("conversation-session-shared-cli.test.ts") ||
            spec.endsWith("conversation-session-new-task-missing-root-mobile.test.ts"),
        )
          ? "http://127.0.0.1:0/remote/v4"
          : "http://127.0.0.1:5173/remote/v4"),
    });
  if (options.specs.some((spec) => spec.endsWith("mobile-event-push.test.ts")))
    return prepareWebRemoteControlSessionEventsFixture({ ...options, mobilePush: true });
  if (options.specs.some((spec) => spec.endsWith("web-remote-control-session-events.test.ts")))
    return prepareWebRemoteControlSessionEventsFixture(options);
  if (!options.specs.some((spec) => spec.endsWith("web-remote-control-auth-gate.test.ts")))
    return null;
  const evidence = { remoteHttp: 0, wsUpgrades: 0, oauthProviders: [] as string[] };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    response.setHeader("content-type", "application/json");
    if (path === "/__e2e/status") {
      response.end(JSON.stringify(evidence));
      return;
    }
    if (path.startsWith("/api/v1/remote/")) {
      evidence.remoteHttp += 1;
      response.writeHead(401);
      response.end('{"code":401}');
      return;
    }
    if (path === "/api/v1/oauth/cli/init") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { provider: string };
      evidence.oauthProviders.push(body.provider);
      response.end(
        JSON.stringify({
          code: 0,
          data: {
            authorize_url: "https://example.com/authorize?state=remote-auth-gate",
            expires_at: Math.floor(Date.now() / 1000) + 300,
            flow_id: "remote-auth-gate",
            poll_interval_sec: 1,
          },
        }),
      );
      return;
    }
    if (path === "/api/v1/oauth/cli/poll/remote-auth-gate") {
      response.end('{"code":0,"data":{"status":"pending"}}');
      return;
    }
    response.end(
      JSON.stringify({
        code: 0,
        data: { configs: {}, builtinModels: [], config_version: "auth-gate" },
      }),
    );
  });
  server.on("upgrade", (_request, socket) => {
    evidence.wsUpgrades += 1;
    socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("缺少远控门禁 fixture 端口");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const envPatch = {
    // 缓存账号会触发独立业务 API；必须同样隔离，避免合成凭据收到线上401并提前登出。
    ZAI_BUSINESS_BASE_URL: baseUrl,
    ZCODE_E2E_REMOTE_AUTH_GATE_URL: baseUrl,
    ZCODE_BASE_URL: baseUrl,
    ZCODE_ENDPOINT_ORIGIN: baseUrl,
    ZCODE_TEST_BASE_URL: baseUrl,
    ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: `${baseUrl.replace("http:", "ws:")}/api/v1/remote/ws2`,
    ZCODE_WEB_REMOTE_CONTROL_URL: `${baseUrl}/remote/v4`,
  };
  const previous = Object.fromEntries(Object.keys(envPatch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, envPatch);
  await writeFile(options.credentialsFile, "{}", { mode: 0o600 });
  const settings = JSON.parse(await readFile(options.settingsFile, "utf8"));
  await writeFile(
    options.settingsFile,
    JSON.stringify({
      ...settings,
      zcodeEndpointOrigin: baseUrl,
      webRemoteControlLastEnabledContext: { workspacePath: options.workspacePath },
    }),
  );
  return async () => {
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
