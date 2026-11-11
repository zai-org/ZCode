/* 官方插件命令进程的代理端点（技术方案 5.8）：CLI 不持有凭证，端点按 session token 认出会话、
 * 只放行 Sites 接口、向 host 现取身份头后转发给 zcode-server。这里用真实的 UDS 和一个本地
 * 假 zcode-server 验证转发细节，凭证解析由 host 侧测试覆盖。 */
import { stat } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { dirname } from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  ZCODE_OFFICIAL_ENDPOINT_ENV_KEY,
  ZCODE_OFFICIAL_ENDPOINT_TOKEN_ENV_KEY,
} from "@zcode/shared";
import type { ExecutionPort, ExecutionRequest } from "@zcode/contracts";
import {
  supportsBackgroundTaskWaiter,
  supportsBashBackgroundLifecycle,
  type BackgroundTaskWaiterExecutionPort,
  type BashBackgroundLifecycleExecutionPort,
} from "@zcode/core";
import {
  createOfficialCommandEndpoint,
  withOfficialCommandEnv,
  type OfficialCommandEndpoint,
} from "../../src/official-command-endpoint/index.js";
import { createOfficialCommandAuthHeadersPort } from "../../src/zcode-protocol/official-mcp-auth-port.js";

const IDENTITY = { Authorization: "Bearer zcode-jwt", "X-Bigmodel-Authorization": "Bearer maas" };
const WORKSPACE_A = { workspacePath: "/w/a" };
const WORKSPACE_B = { workspacePath: "/w/b", workspaceIdentity: "remote:b" };

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer };

async function startUpstream(
  reply: (seen: Seen) => { status: number; body: string } = () => ({
    status: 200,
    body: JSON.stringify({ code: 0, msg: "success", data: { ok: true }, logid: "l" }),
  }),
): Promise<{ origin: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry = {
        body: Buffer.concat(chunks),
        headers: req.headers,
        method: req.method ?? "",
        url: req.url ?? "",
      };
      seen.push(entry);
      const { status, body } = reply(entry);
      res.writeHead(status, { "content-type": "application/json", "set-cookie": "a=b" }).end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${address.port}`, seen, server };
}

function call(
  env: Record<string, string>,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
    token?: string;
  } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const body = init.body;
    const req = request(
      {
        socketPath: env[ZCODE_OFFICIAL_ENDPOINT_ENV_KEY],
        path,
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${init.token ?? env[ZCODE_OFFICIAL_ENDPOINT_TOKEN_ENV_KEY]}`,
          ...(body !== undefined ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
          ...init.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
            status: res.statusCode ?? 0,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("official command endpoint", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  async function setup(
    options: {
      reply?: Parameters<typeof startUpstream>[0];
      resolveHeaders?: ReturnType<typeof vi.fn>;
      origin?: string;
    } = {},
  ) {
    const upstream = await startUpstream(options.reply);
    cleanups.push(() => new Promise((resolve) => upstream.server.close(() => resolve())));
    const resolveHeaders =
      options.resolveHeaders ?? vi.fn(async () => ({ ok: true as const, headers: IDENTITY }));
    const endpoint: OfficialCommandEndpoint = createOfficialCommandEndpoint({
      appVersion: "3.16.0",
      fetch: globalThis.fetch,
      resolveHeaders,
      resolveZCodeApiOrigin: () => options.origin ?? upstream.origin,
    });
    cleanups.push(() => endpoint.close());
    return { endpoint, resolveHeaders, upstream };
  }

  it("gives each session its own token on one private socket", async () => {
    const { endpoint } = await setup();
    const a = await endpoint.envForSession("session-a", WORKSPACE_A);
    const again = await endpoint.envForSession("session-a", WORKSPACE_A);
    const b = await endpoint.envForSession("session-b", WORKSPACE_B);

    expect(again).toEqual(a);
    expect(b[ZCODE_OFFICIAL_ENDPOINT_ENV_KEY]).toBe(a[ZCODE_OFFICIAL_ENDPOINT_ENV_KEY]);
    expect(b[ZCODE_OFFICIAL_ENDPOINT_TOKEN_ENV_KEY]).not.toBe(
      a[ZCODE_OFFICIAL_ENDPOINT_TOKEN_ENV_KEY],
    );
    if (process.platform !== "win32") {
      const dir = await stat(dirname(a[ZCODE_OFFICIAL_ENDPOINT_ENV_KEY]!));
      expect(dir.mode & 0o077).toBe(0);
    }
  });

  it("asks for identity with the workspace of the session that owns the token", async () => {
    const { endpoint, resolveHeaders } = await setup();
    const a = await endpoint.envForSession("session-a", WORKSPACE_A);
    const b = await endpoint.envForSession("session-b", WORKSPACE_B);

    expect((await call(b, "/api/v1/sites/usage")).status).toBe(200);
    expect((await call(a, "/api/v1/sites/usage")).status).toBe(200);

    expect(resolveHeaders.mock.calls.map(([input]) => input.workspace)).toEqual([
      WORKSPACE_B,
      WORKSPACE_A,
    ]);
  });

  it("rejects unknown tokens and paths outside the allowed prefix without asking for identity", async () => {
    const { endpoint, resolveHeaders, upstream } = await setup();
    const env = await endpoint.envForSession("session-a", WORKSPACE_A);

    const badToken = await call(env, "/api/v1/sites", { token: "forged" });
    expect(badToken.status).toBe(403);
    expect(badToken.headers["x-zcode-official-endpoint-error"]).toBe("invalid");

    for (const path of ["/api/v1/users/me", "/api/v1/sitesx", "/api/v1/sites/../mcp/usage", "/"]) {
      const res = await call(env, path);
      expect(res.status, path).toBe(403);
      expect(JSON.parse(res.body).code).toBe(2007);
    }
    expect(resolveHeaders).not.toHaveBeenCalled();
    expect(upstream.seen).toHaveLength(0);
  });

  it("replaces client credentials with the official identity and streams the body", async () => {
    const { endpoint, resolveHeaders, upstream } = await setup();
    const env = await endpoint.envForSession("session-a", WORKSPACE_A);
    const pkg = Buffer.alloc(3 * 1024 * 1024, 7);

    const res = await call(env, "/api/v1/sites/1/deployments/2/package?x=1", {
      body: pkg,
      headers: {
        "Content-Type": "application/gzip",
        Cookie: "c=d",
        "X-Bigmodel-Authorization": "Bearer forged",
        "X-ZCode-App-Version": "0.0.1",
        "X-Zcode-Plan": "max",
      },
      method: "PUT",
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ code: 0, data: { ok: true } });
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(resolveHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "zcode-site", targetOrigin: upstream.origin }),
    );
    const [seen] = upstream.seen;
    expect(seen!.method).toBe("PUT");
    expect(seen!.url).toBe("/api/v1/sites/1/deployments/2/package?x=1");
    expect(seen!.headers.authorization).toBe("Bearer zcode-jwt");
    expect(seen!.headers["x-bigmodel-authorization"]).toBe("Bearer maas");
    expect(seen!.headers["x-zcode-app-version"]).toBe("3.16.0");
    expect(seen!.headers["content-type"]).toBe("application/gzip");
    expect(seen!.headers["content-length"]).toBe(String(pkg.length));
    expect(seen!.headers["transfer-encoding"]).toBeUndefined();
    expect(seen!.headers.cookie).toBeUndefined();
    expect(seen!.headers["x-zcode-plan"]).toBeUndefined();
    expect(seen!.body.equals(pkg)).toBe(true);
  });

  it("answers 401 without identity and 2007 for other identity failures", async () => {
    const resolveHeaders = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "official_auth_unavailable" })
      .mockResolvedValueOnce({ ok: false, reason: "official_mcp_origin_untrusted" })
      .mockRejectedValueOnce(new Error("host gone"));
    const { endpoint, upstream } = await setup({ resolveHeaders });
    const env = await endpoint.envForSession("session-a", WORKSPACE_A);

    const signedOut = await call(env, "/api/v1/sites/usage");
    expect(signedOut.status).toBe(401);
    expect(signedOut.body).toBe("");
    const untrusted = await call(env, "/api/v1/sites/usage");
    expect(untrusted.status).toBe(502);
    expect(JSON.parse(untrusted.body).code).toBe(2007);
    expect((await call(env, "/api/v1/sites/usage")).status).toBe(401);
    expect(upstream.seen).toHaveLength(0);
  });

  it("marks an unreachable zcode-server as a network error", async () => {
    const { endpoint } = await setup({ origin: "http://127.0.0.1:1" });
    const env = await endpoint.envForSession("session-a", WORKSPACE_A);

    const res = await call(env, "/api/v1/sites/usage");
    expect(res.status).toBe(502);
    expect(res.headers["x-zcode-official-endpoint-error"]).toBe("network");
  });

  it("reports every deployment request to the observer of the token's session, whatever the result", async () => {
    const { endpoint } = await setup({
      reply: (seen) =>
        seen.url === "/api/v1/sites/busy/deployments"
          ? { status: 409, body: JSON.stringify({ code: 3610, msg: "busy", data: null }) }
          : { status: 200, body: JSON.stringify({ code: 0, msg: "success", data: {} }) },
    });
    const observerA = { onSiteDeploymentRequested: vi.fn() };
    const observerB = { onSiteDeploymentRequested: vi.fn() };
    const a = await endpoint.envForSession("session-a", WORKSPACE_A, observerA);
    await endpoint.envForSession("session-b", WORKSPACE_B, observerB);

    await call(a, "/api/v1/sites/s-1/deployments", { body: "{}", method: "POST" });
    const busy = await call(a, "/api/v1/sites/busy/deployments", { body: "{}", method: "POST" });

    expect(busy.status).toBe(409);
    expect(observerA.onSiteDeploymentRequested).toHaveBeenCalledTimes(2);
    expect(observerB.onSiteDeploymentRequested).not.toHaveBeenCalled();
  });

  it("does not report other Sites calls", async () => {
    const { endpoint, upstream } = await setup();
    const observer = { onSiteDeploymentRequested: vi.fn() };
    const env = await endpoint.envForSession("session-a", WORKSPACE_A, observer);

    await call(env, "/api/v1/sites/s-1/deployments");
    await call(env, "/api/v1/sites/s-1/deployments/d-1/package", { body: "x", method: "PUT" });
    await call(env, "/api/v1/sites", { body: "{}", method: "POST" });

    expect(upstream.seen).toHaveLength(3);
    expect(observer.onSiteDeploymentRequested).not.toHaveBeenCalled();
  });

  it("stops serving and removes the socket on close", async () => {
    const { endpoint } = await setup();
    const env = await endpoint.envForSession("session-a", WORKSPACE_A);
    await endpoint.close();

    await expect(call(env, "/api/v1/sites/usage")).rejects.toThrow();
    expect(await endpoint.envForSession("session-a", WORKSPACE_A)).toEqual({});
    if (process.platform !== "win32") {
      await expect(stat(dirname(env[ZCODE_OFFICIAL_ENDPOINT_ENV_KEY]!))).rejects.toThrow();
    }
  });
});

describe("withOfficialCommandEnv", () => {
  function fakePort() {
    const run = vi.fn(async (_request: ExecutionRequest) => ({}) as never);
    const start = vi.fn(async (_request: ExecutionRequest) => ({}) as never);
    const getBackgroundTask = vi.fn(async () => undefined);
    return { getBackgroundTask, run, start } satisfies ExecutionPort;
  }
  const request = (env?: ExecutionRequest["env"]): ExecutionRequest =>
    ({ command: { mode: "shell", command: "true" }, ...(env ? { env } : {}) }) as ExecutionRequest;

  it("adds the session endpoint env to foreground and background runs", async () => {
    const port = fakePort();
    const wrapped = withOfficialCommandEnv(port, async () => ({ ZCODE_OFFICIAL_ENDPOINT: "/s" }));

    await wrapped.run(request({ set: { A: "1", ZCODE_OFFICIAL_ENDPOINT: "/forged" } }));
    await wrapped.start!(request());
    await wrapped.run(request({ base: "empty" }));

    expect(port.run.mock.calls[0]![0].env).toEqual({
      set: { A: "1", ZCODE_OFFICIAL_ENDPOINT: "/s" },
    });
    expect(port.start.mock.calls[0]![0].env).toEqual({ set: { ZCODE_OFFICIAL_ENDPOINT: "/s" } });
    expect(port.run.mock.calls[1]![0].env).toEqual({ base: "empty" });
    expect(wrapped.getBackgroundTask).toBeDefined();
    expect(wrapped.cancelBackgroundTask).toBeUndefined();
    expect(supportsBashBackgroundLifecycle(wrapped)).toBe(false);
    expect(supportsBackgroundTaskWaiter(wrapped)).toBe(false);
  });

  const lifecycleModes = ["explicit", "auto_on_timeout"] as const;
  const backgroundOutcome = {
    kind: "backgrounded" as const,
    task: { taskId: "task-1", status: "running" as const, startedAt: new Date(0) },
  };

  it.each(lifecycleModes)(
    "preserves the %s Bash lifecycle and injects the session env",
    async (mode) => {
      const runBash = vi
        .fn<BashBackgroundLifecycleExecutionPort["runBashWithBackgroundLifecycle"]>()
        .mockResolvedValue(backgroundOutcome);
      const port = Object.freeze({ ...fakePort(), runBashWithBackgroundLifecycle: runBash });
      const endpointEnv = {
        ZCODE_OFFICIAL_ENDPOINT: "/session",
        ZCODE_OFFICIAL_ENDPOINT_TOKEN: "token",
      };
      const resolveEnv = vi.fn(async () => endpointEnv);
      const wrapped = withOfficialCommandEnv(port, resolveEnv);
      const originalRequest = request({ set: { A: "1", ZCODE_OFFICIAL_ENDPOINT: "/forged" } });
      const lifecycle = { mode };
      const options = { signal: new AbortController().signal, onEvent: vi.fn() };

      assert(
        supportsBashBackgroundLifecycle(wrapped),
        "environment wrapper lost the Bash lifecycle",
      );
      const result = await wrapped.runBashWithBackgroundLifecycle(
        originalRequest,
        lifecycle,
        options,
      );

      expect(result).toBe(backgroundOutcome);
      expect(runBash).toHaveBeenCalledTimes(1);
      expect(runBash.mock.contexts[0]).toBe(port);
      const [forwardedRequest, forwardedLifecycle, forwardedOptions] = runBash.mock.calls[0]!;
      expect(forwardedRequest).toEqual({
        ...originalRequest,
        env: { set: { A: "1", ...endpointEnv } },
      });
      expect(forwardedLifecycle).toBe(lifecycle);
      expect(forwardedOptions).toBe(options);
      expect(originalRequest.env?.set?.ZCODE_OFFICIAL_ENDPOINT).toBe("/forged");
      expect(resolveEnv).toHaveBeenCalledTimes(1);
      expect(port.run).not.toHaveBeenCalled();
      expect(port.start).not.toHaveBeenCalled();
    },
  );

  it.each(lifecycleModes)(
    "preserves a clean environment for the %s Bash lifecycle",
    async (mode) => {
      const runBash = vi
        .fn<BashBackgroundLifecycleExecutionPort["runBashWithBackgroundLifecycle"]>()
        .mockResolvedValue(backgroundOutcome);
      const resolveEnv = vi.fn(async () => ({ ZCODE_OFFICIAL_ENDPOINT: "/session" }));
      const port = { ...fakePort(), runBashWithBackgroundLifecycle: runBash };
      const wrapped = withOfficialCommandEnv(port, resolveEnv);
      const originalRequest = request({ base: "empty" });

      assert(supportsBashBackgroundLifecycle(wrapped));
      await wrapped.runBashWithBackgroundLifecycle(originalRequest, { mode });

      expect(runBash.mock.calls[0]![0]).toBe(originalRequest);
      expect(resolveEnv).not.toHaveBeenCalled();
    },
  );

  it("preserves lifecycle errors when the endpoint env is unavailable", async () => {
    const failure = new Error("execution failed");
    const runBash = vi
      .fn<BashBackgroundLifecycleExecutionPort["runBashWithBackgroundLifecycle"]>()
      .mockRejectedValue(failure);
    const resolveEnv = vi.fn().mockRejectedValue(new Error("listen failed"));
    const warn = vi.fn();
    const port = { ...fakePort(), runBashWithBackgroundLifecycle: runBash };
    const wrapped = withOfficialCommandEnv(port, resolveEnv, { warn });
    const originalRequest = request();

    assert(supportsBashBackgroundLifecycle(wrapped));
    await expect(
      wrapped.runBashWithBackgroundLifecycle(originalRequest, { mode: "explicit" }),
    ).rejects.toBe(failure);

    expect(runBash.mock.calls[0]![0]).toBe(originalRequest);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("preserves the background task waiter so tracking does not fall back to polling", async () => {
    const snapshot = {
      taskId: "task-1",
      status: "completed" as const,
      startedAt: new Date(0),
    };
    const waitForBackgroundTask = vi
      .fn<BackgroundTaskWaiterExecutionPort["waitForBackgroundTask"]>()
      .mockResolvedValue(snapshot);
    const port = Object.freeze({ ...fakePort(), waitForBackgroundTask });
    const wrapped = withOfficialCommandEnv(port, async () => ({
      ZCODE_OFFICIAL_ENDPOINT: "/session",
    }));
    const options = { signal: new AbortController().signal };

    assert(supportsBackgroundTaskWaiter(wrapped), "environment wrapper lost the background waiter");
    const result = await wrapped.waitForBackgroundTask("task-1", options);

    expect(result).toBe(snapshot);
    expect(waitForBackgroundTask).toHaveBeenCalledTimes(1);
    expect(waitForBackgroundTask.mock.contexts[0]).toBe(port);
    expect(waitForBackgroundTask.mock.calls[0]).toEqual(["task-1", options]);
  });

  it("still runs the command when the endpoint is unavailable", async () => {
    const port = fakePort();
    const warn = vi.fn();
    const wrapped = withOfficialCommandEnv(
      port,
      async () => {
        throw new Error("listen failed");
      },
      { warn },
    );

    await wrapped.run(request());
    expect(port.run.mock.calls[0]![0].env).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  // 回归：包装层曾只转发 run/start，丢掉 Bash 后台生命周期能力，Desktop 注入端点 env 后
  // run_in_background 的 Bash 全部报 "ExecutionPort does not support the Bash background lifecycle"。
  it("keeps the Bash background lifecycle and adds the endpoint env to it", async () => {
    const runBashWithBackgroundLifecycle = vi.fn(
      async (_request: ExecutionRequest, _lifecycle: { mode: string }) => ({}) as never,
    );
    const port = { ...fakePort(), runBashWithBackgroundLifecycle };
    const wrapped = withOfficialCommandEnv(port, async () => ({ ZCODE_OFFICIAL_ENDPOINT: "/s" }));

    const lifecycle = (wrapped as Partial<typeof port>).runBashWithBackgroundLifecycle;
    expect(lifecycle).toBeTypeOf("function");
    await lifecycle!(request(), { mode: "explicit" });

    expect(runBashWithBackgroundLifecycle.mock.calls[0]![0].env).toEqual({
      set: { ZCODE_OFFICIAL_ENDPOINT: "/s" },
    });
    expect(runBashWithBackgroundLifecycle.mock.calls[0]![1]).toEqual({ mode: "explicit" });
    const plain = withOfficialCommandEnv(fakePort(), async () => ({}));
    expect("runBashWithBackgroundLifecycle" in plain).toBe(false);
  });
});

describe("createOfficialCommandAuthHeadersPort", () => {
  const ask = (workspace: { workspacePath: string; workspaceIdentity?: string } = WORKSPACE_A) => ({
    pluginId: "zcode-site",
    targetOrigin: "https://zcode.test",
    workspace,
  });

  it("asks for plugin-command identity with the session workspace and without an mcpKey", async () => {
    const requestClient = vi.fn(async () => ({ ok: true as const, headers: IDENTITY }));
    const port = createOfficialCommandAuthHeadersPort({
      resolveContext: () => ({ requestClient }) as never,
    });

    await expect(port.resolveHeaders(ask())).resolves.toEqual({ ok: true, headers: IDENTITY });
    await port.resolveHeaders(ask(WORKSPACE_B));
    const params = (requestClient.mock.calls as unknown as [string, Record<string, unknown>][]).map(
      ([, value]) => value,
    );
    expect(params[0]).toMatchObject({
      consumer: "plugin-command",
      pluginId: "zcode-site",
      targetOrigin: "https://zcode.test",
      workspace: { workspaceKey: "/w/a", workspacePath: "/w/a" },
    });
    expect(params[0]).not.toHaveProperty("mcpKey");
    expect(params[1]).toMatchObject({
      workspace: { workspaceIdentity: "remote:b", workspaceKey: "remote:b", workspacePath: "/w/b" },
    });
  });

  it("is unavailable before the protocol server is ready or when the host fails", async () => {
    const before = createOfficialCommandAuthHeadersPort({ resolveContext: () => undefined });
    await expect(before.resolveHeaders(ask())).resolves.toEqual({
      ok: false,
      reason: "official_auth_unavailable",
    });

    const warn = vi.fn();
    const failing = createOfficialCommandAuthHeadersPort({
      logger: { warn },
      resolveContext: () =>
        ({
          requestClient: vi
            .fn()
            .mockRejectedValue(new Error("Request workspace is not owned by this CLI")),
        }) as never,
    });
    await expect(failing.resolveHeaders(ask())).resolves.toEqual({
      ok: false,
      reason: "official_auth_unavailable",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        error: "Request workspace is not owned by this CLI",
        event: "zcode_protocol.official_command_endpoint.auth_request_failed",
        workspaceKey: "/w/a",
      }),
    );
  });
});
