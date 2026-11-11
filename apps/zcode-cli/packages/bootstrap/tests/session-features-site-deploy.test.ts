import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  ZCODE_OFFICIAL_ENDPOINT_ENV_KEY,
  ZCODE_OFFICIAL_ENDPOINT_TOKEN_ENV_KEY,
} from "@zcode/shared";
import {
  SESSION_ENTRY_SESSION_FEATURES,
  getCurrentModelInvocationContext,
  type ExecutionPort,
  type ExecutionRequest,
  type ExecutionResult,
  type ModelRequestSessionFeature,
} from "@zcode/contracts";
import { createOfficialCommandEndpoint } from "../src/official-command-endpoint/index.js";
import { createRegistryBackedTestApp as createZCodeApp } from "./helpers/registry-backed-test-app.js";

// docs/design/v2/model/session-features-header.md「Sites 部署标签的补充规则」的装配层：
// 真实的官方命令端点 + 假 zcode-server。假执行端口在收到部署命令时，像 zcode-site CLI 一样用请求 env
// 里的端点地址和 token 发 POST，验证 create-app 把端点回调接到会话的 site_deploy 标签。
const DEPLOY_COMMAND = "zcode-site deploy ./stage";
const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function startZCodeServer(status: number): Promise<string> {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: status === 200 ? 0 : 3610, msg: "", data: { id: "d-1" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function postDeployment(env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: env[ZCODE_OFFICIAL_ENDPOINT_ENV_KEY],
        path: "/api/v1/sites/s-1/deployments",
        method: "POST",
        headers: {
          Authorization: `Bearer ${env[ZCODE_OFFICIAL_ENDPOINT_TOKEN_ENV_KEY]}`,
          "Content-Type": "application/json",
          "Content-Length": "2",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

function completed(): ExecutionResult {
  const now = new Date();
  return {
    cancelled: false,
    completedAt: now,
    durationMs: 1,
    exitCode: 0,
    startedAt: now,
    status: "completed",
    stderr: { bytes: 0, text: "", truncated: false },
    stdout: { bytes: 2, text: "ok", truncated: false },
    timedOut: false,
  };
}

async function runScenario(upstreamStatus: number) {
  const root = await mkdtemp(join(tmpdir(), "zcode-site-deploy-feature-"));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
  cleanups.push(async () => sessionStore.close());
  const origin = await startZCodeServer(upstreamStatus);
  const endpoint = createOfficialCommandEndpoint({
    fetch: globalThis.fetch,
    resolveHeaders: async () => ({ ok: true, headers: { Authorization: "Bearer jwt" } }),
    resolveZCodeApiOrigin: () => origin,
  });
  cleanups.push(() => endpoint.close());

  const deployStatuses: number[] = [];
  const executionPort: ExecutionPort = {
    async run(request: ExecutionRequest) {
      if (JSON.stringify(request.command).includes(DEPLOY_COMMAND)) {
        deployStatuses.push(await postDeployment(request.env?.set ?? {}));
      }
      return completed();
    },
  };

  const seen: Array<readonly ModelRequestSessionFeature[] | undefined> = [];
  const app = await createZCodeApp({
    env: {},
    executionPort,
    officialCommandEnv: (sessionId, workspace, observer) =>
      endpoint.envForSession(sessionId, workspace, observer),
    modelExecutor: {
      async generateText() {
        seen.push(getCurrentModelInvocationContext()?.modelRequestSessionFeatures);
        if (seen.length === 1)
          return {
            finishReason: "tool-calls",
            text: "",
            usage: USAGE,
            toolCalls: [{ id: "deploy", name: "Bash", input: { command: DEPLOY_COMMAND } }],
          } as never;
        return { finishReason: "stop", text: "done", usage: USAGE } as never;
      },
    },
    runtimeConfig: {
      workingDirectory: root,
      mode: "yolo",
      bashShellSelection: { dialect: "posix", source: "auto-detected", display: { name: "bash" } },
    },
    sessionStore,
    skipUserConfig: true,
  });
  cleanups.push(() => app.close());

  await app.submitPrompt("deploy the site");
  await app.submitPrompt("thanks");
  const entries = await sessionStore.sessionEntries?.({
    sessionID: app.sessionId as never,
    type: SESSION_ENTRY_SESSION_FEATURES,
  });
  return { deployStatuses, seen, entries: (entries ?? []).map((entry) => entry.data) };
}

describe("官方命令端点收到创建部署时打 site_deploy", () => {
  it("不看结果：部署请求被上游拒绝（409），之后的请求同样带上 site_deploy，并写入 entry", async () => {
    const result = await runScenario(409);

    expect(result.deployStatuses).toEqual([409]);
    expect(result.seen).toEqual([undefined, ["site_deploy"], ["site_deploy"]]);
    expect(result.entries).toEqual([{ features: ["site_deploy"] }]);
  });
});
