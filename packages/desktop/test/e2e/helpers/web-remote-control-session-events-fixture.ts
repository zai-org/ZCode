import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createFakeRelayV2 } from "@zcode/shared/testing/fake-relay-v2";
import { CODING_PLAN_TEAM_MOCK_BASE_URL_ENV } from "#e2e/helpers/coding-plan-mock-env";

export const WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS = {
  "oauth:active_provider": "zai",
  "oauth:zai:access_token": "mock-token",
  "oauth:zai:user_info": JSON.stringify({
    id: "zcode-e2e-user",
    username: "ZCode E2E",
    displayName: "ZCode E2E",
  }),
  zcodejwttoken: "mock-token",
};

/** 单窗口真实 OAuth owner → RPC → renderer → Main 回归，只替换外部 relay。 */
export async function prepareWebRemoteControlSessionEventsFixture(options: {
  credentialsFile: string;
  settingsFile: string;
  workspacePath: string;
  webUrl?: string;
  mobilePush?: boolean;
  additionalRelayUsers?: Record<string, string>;
  /** 上次启用远控时的 workspace；缺省为启动后会恢复的 workspacePath。 */
  lastEnabledWorkspacePath?: string;
  regionalDesktop?: boolean;
}): Promise<() => Promise<void>> {
  let linkedProfileEnabled = false;
  const relay = await createFakeRelayV2({
    users: {
      "mock-token": "zcode-e2e-user",
      ...(options.regionalDesktop ? { "mobile-own-token": "zcode-e2e-user" } : {}),
      ...options.additionalRelayUsers,
    },
    onHttp: (call) => {
      if (call.path === "/__e2e/linked-profile") {
        linkedProfileEnabled = true;
        return { status: 200, body: { ok: true } };
      }
      if (linkedProfileEnabled && call.path === "/api/v1/oauth/profile")
        return {
          status: 200,
          body: {
            code: 0,
            data: {
              user: { user_id: "zcode-e2e-user", name: "ZCode E2E" },
              bigmodel: { customer_id: "associated-customer", access_token: "linked-refreshed" },
            },
          },
        };

      if (options.mobilePush && call.path === "/api/v1/remote/notification/status")
        return {
          status: 200,
          body: {
            code: 0,
            data: { protocol_version: 1, event_transport: "http", status: "available" },
          },
        };
      // 回执 event_id 必须回显请求里的事件，Main 才会把上报判为 accepted。
      if (
        options.mobilePush &&
        call.method === "POST" &&
        call.path === "/api/v1/remote/notification/events"
      ) {
        const event = (call.body as { event?: { event_id?: string } } | undefined)?.event;
        return {
          status: 200,
          body: { code: 0, msg: "", data: { event_id: event?.event_id, status: "accepted" } },
        };
      }
      if (options.mobilePush && call.path === "/__e2e/push")
        return {
          status: 200,
          body: {
            messages: relay.messages,
            queries: relay.httpCalls.filter((x) => x.path === "/api/v1/remote/notification/status")
              .length,
            // 仅记录通知上报；用于断言关闭开关期间不发请求、打开后只上报新事件。
            notifications: relay.httpCalls
              .filter((x) => x.method === "POST" && x.path === "/api/v1/remote/notification/events")
              .map((x) => x.body),
          },
        };
      if (call.path.startsWith("/api/v1/remote/")) return;
      // 完整工作区会读取推荐场景；配置对象不能冒充场景数组，否则真实首页渲染会崩溃。
      if (call.path === "/api/v1/client/scenes")
        return { status: 200, body: { code: 0, msg: "", data: [] } };
      if (options.webUrl && !call.path.includes("config"))
        return {
          status: 503,
          body: { code: 503, msg: "not configured in mobile file-navigation fixture" },
        };
      return {
        status: 200,
        body: {
          code: 0,
          data: { configs: {}, builtinModels: [], config_version: "session-events" },
        },
      };
    },
  });
  const envPatch = {
    // 账号后台请求也必须走 loopback；合成凭据发到默认业务 API 会触发401并提前登出。
    ...(options.webUrl ? { VITE_ZCODE_E2E_STORE_BRIDGE: "1" } : {}),
    ZAI_BUSINESS_BASE_URL: relay.httpUrl,
    // Bug 原因：Highspeed 等团队套餐用例也复用此手机夹具，团队 mock 已接管 BigModel 业务 API；
    // 无条件改指 relay 会让团队入口校验收到 503，模型菜单没有团队行。两者都是本地 loopback。
    ...(process.env[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV]
      ? {}
      : { BIGMODEL_API_BASE_URL: relay.httpUrl }),
    ZCODE_E2E_REMOTE_AUTH_GATE_URL: relay.httpUrl,
    ZCODE_BASE_URL: relay.httpUrl,
    ZCODE_ENDPOINT_ORIGIN: relay.httpUrl,
    ZCODE_TEST_BASE_URL: relay.httpUrl,
    ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: relay.wsUrl,
    ZCODE_WEB_REMOTE_CONTROL_URL: options.webUrl ?? `${relay.httpUrl}/remote/v4`,
  };
  const previous = Object.fromEntries(Object.keys(envPatch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, envPatch);
  const webPort = options.webUrl ? new URL(options.webUrl).port : undefined;
  // 手机入口与 desktop relay 必须连接同一个隔离服务，不能沿用开发服务器的线上代理。
  const web = options.webUrl
    ? spawn(
        process.execPath,
        [
          resolve(import.meta.dirname, "../../../scripts/e2e-mobile-web-server.mjs"),
          webPort || "5173",
        ],
        {
          cwd: resolve(import.meta.dirname, "../../../../../packages/web"),
          // 原因：wdio CLI 给 worker 注入 FORCE_COLOR="0"/"1"，picocolors 把任意非空值视为开启，
          // vite 会把端口染色成 `127.0.0.1:\x1b[1m5173`，下方就绪匹配永远失败，worker 无限等待。
          // NO_COLOR 优先于 FORCE_COLOR，保证就绪行是纯文本。
          env: { ...process.env, NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
    : undefined;
  if (web) {
    await new Promise<void>((resolveReady, reject) => {
      web.once("error", reject);
      web.once("exit", (code) =>
        reject(new Error(`Mobile Web fixture exited before ready: ${code}`)),
      );
      web.stdout.on("data", (chunk) => {
        const origin = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0];
        // Vite 的重载通知写 stdout；原来只读 ready 会丢失手机操作中断的来源。
        // 只保留开发服务器生命周期，不转发页面控制台中的业务或配对数据。
        for (const line of String(chunk).split("\n")) {
          if (line.includes("[vite]") && !line.includes("[console."))
            process.stderr.write(`[mobile-web-fixture] ${line}\n`);
        }
        if (!origin) return;
        // 独立夹具可能避开已占用端口，手机配对必须使用 Vite 实际监听的端口。
        process.env.ZCODE_WEB_REMOTE_CONTROL_URL = new URL(
          new URL(options.webUrl!).pathname,
          origin,
        ).href;
        resolveReady();
      });
      web.stderr.on("data", (chunk) => process.stderr.write(chunk));
    });
  }
  const desktopCredentials = options.regionalDesktop
    ? {
        "oauth:active_provider": "zai_cn",
        "oauth:session_revision": "cn-mobile-initial",
        "oauth:zai_cn:access_token": "cn-upstream-not-relay",
        "oauth:zai_cn:user_info": JSON.stringify({ user_id: "zcode-e2e-user", name: "ZCode E2E" }),
        "oauth:linked_bigmodel": JSON.stringify({
          userId: "zcode-e2e-user",
          customerId: "associated-customer",
          accessToken: "linked-before",
        }),
        zcodejwttoken: "mock-token",
      }
    : WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS;
  await writeFile(options.credentialsFile, JSON.stringify(desktopCredentials), { mode: 0o600 });
  const settings = JSON.parse(await readFile(options.settingsFile, "utf8"));
  await writeFile(
    options.settingsFile,
    JSON.stringify({
      ...settings,
      zcodeEndpointOrigin: relay.httpUrl,
      webRemoteControlLastEnabledContext: options.mobilePush
        ? undefined
        : { workspacePath: options.lastEnabledWorkspacePath ?? options.workspacePath },
    }),
  );
  return async () => {
    if (web && web.exitCode === null) {
      const exited = once(web, "exit");
      web.kill();
      await exited;
    }
    await relay.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
