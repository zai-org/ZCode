import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  seedPersonalDefaultModelSelection,
  seedPersonalProviderConfig,
} from "./model-provider-restart-config.js";
import {
  loadToolSearchResponses,
  toolSearchResponseStage,
  type ToolSearchRequest,
} from "./toolsearch-provider.js";

export interface CliWireRequest {
  body: ToolSearchRequest;
  headers: Record<string, string | string[] | undefined>;
  fixtureId?: string;
}
export async function createToolSearchCliFixture(
  caseName: string,
  options: { modelIo?: boolean } = {},
) {
  const responses = await loadToolSearchResponses(caseName);
  const repoRoot = resolve(process.cwd(), "../..");
  const root = await mkdtemp(join(tmpdir(), "zcode-toolsearch-process-"));
  const workspace = join(root, "workspace");
  const configPath = join(root, ".zcode", "cli", "config.json");
  const personalPath = join(root, "provider.json");
  const requests: CliWireRequest[] = [];
  const active = new Set<ReturnType<typeof spawn>>();
  const runs: { args: string[]; code: number | null; stdout: string; stderr: string }[] = [];
  function reply(
    body: ToolSearchRequest,
    response: ServerResponse,
    stage = toolSearchResponseStage(body),
    end = true,
  ) {
    const fixture = responses.get(stage);
    const record = requests.find((item) => item.body === body);
    if (record) record.fixtureId = fixture.id;
    response.writeHead(fixture.response.statusCode, fixture.response.headers);
    if (end) response.end(fixture.response.body);
    else response.write(fixture.response.body);
  }
  let respond: (body: ToolSearchRequest, response: ServerResponse) => void = reply;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ToolSearchRequest;
    requests.push({ body, headers: request.headers });
    respond(body, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CLI fixture failed to listen");
  const port = address.port;
  await mkdir(workspace, { recursive: true });
  await mkdir(join(root, ".zcode", "cli"), { recursive: true });
  let config = {
    features: { memory: false, skill: false, mcp: false, subagent: false },
    permission: { mode: "yolo", allowedTools: [] as string[], disallowedTools: [] as string[] },
    storage: { dir: join(root, "storage"), sessionDbPath: join(root, "session.sqlite") },
  };
  await writeFile(configPath, JSON.stringify(config));
  async function select(
    apiFormat: "anthropic-messages" | "openai-chat-completions",
    properties: { supportsMidConversationSystem?: boolean } = {},
  ) {
    await seedPersonalProviderConfig(personalPath, {
      id: "toolsearch-process",
      label: "ToolSearch Process",
      apiFormat,
      apiKey: "test-only",
      baseURL: `http://127.0.0.1:${port}/v1`,
      models: [{ id: "test-toolsearch", ...properties }],
    });
    await seedPersonalDefaultModelSelection(personalPath, {
      providerId: "toolsearch-process",
      modelId: "test-toolsearch",
    });
  }
  // 修复原因：fixture 的 HOME/storage 是全新目录，CLI 首次启动要同步播种约 1100 个官方插件文件，Windows 上 30s+，
  // 而 wdio 的 Mocha 单 case 上限固定 120s（用例内 this.timeout 不生效），TUI/多轮 CLI 用例会被其截断。
  // 复用 wdio onPrepare 已预热的官方插件缓存模板（与桌面 E2E 的 HOME 预热同源），CLI 的 seed marker 命中后不再重写。
  const pluginCacheTemplate = join(
    resolve(
      process.cwd(),
      ".e2e-cache",
      process.env.ZCODE_E2E_RUN_ID ?? "",
      "official-plugin-cache-home",
    ),
    ".zcode",
    "cli",
    "plugins",
    "cache",
    "zcode-plugins-official",
  );
  if (process.env.ZCODE_E2E_RUN_ID && existsSync(pluginCacheTemplate)) {
    await cp(
      pluginCacheTemplate,
      join(root, "storage", "cli", "plugins", "cache", "zcode-plugins-official"),
      {
        recursive: true,
      },
    );
  }
  await select("anthropic-messages");
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    COMSPEC: process.env.COMSPEC,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: root,
    USERPROFILE: root,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: "test",
    ...(options.modelIo ? { ZCODE_RUNTIME_ENV: "development" } : {}),
    ZCODE_DATA_BASE_DIR: root,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(repoRoot, "config/provider/zcode-builtin.json"),
  };
  return {
    root,
    workspace,
    env,
    cliPath: join(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs"),
    requests,
    select,
    reply,
    setResponse(handler: typeof respond) {
      respond = handler;
    },
    async configure(patch: Record<string, unknown>) {
      config = { ...config, ...patch };
      await writeFile(configPath, JSON.stringify(config));
    },
    start(args: string[], outputFormat = "json") {
      // 全部用户路径指向隔离目录；仅继承执行工具所需 PATH，不复用用户 provider/凭据/代理。
      const child = spawn(
        process.execPath,
        [
          join(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs"),
          ...args,
          "--no-browser",
          "--output-format",
          outputFormat,
        ],
        {
          cwd: workspace,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
          killSignal: "SIGKILL",
        },
      );
      active.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const done = (async () => {
        // close 在 stdout/stderr 排空后触发，避免 exit 先到导致 JSON 尾部丢失。
        const [code] = (await once(child, "close")) as [number | null];
        active.delete(child);
        const result = { args, code, stdout, stderr };
        runs.push(result);
        return result;
      })();
      return { child, done, output: () => stdout };
    },
    async close() {
      await Promise.all(
        [...active].map(async (child) => {
          const exited = once(child, "close");
          child.kill("SIGKILL");
          await exited;
        }),
      );
      const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH;
      if (capturePath)
        await writeFile(
          `${capturePath}.${root.split("-").at(-1)}.cli.json`,
          JSON.stringify({ requests, runs }, null, 2),
        );
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}
