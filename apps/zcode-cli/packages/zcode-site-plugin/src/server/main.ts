import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared/zcodeEndpoint";
import { createSitesApi } from "./api.ts";
import { createSitesServer } from "./server.ts";

const REQUEST_TIMEOUT_MS = 15_000;

// 官方插件宿主通过导出的 main 启动；导入时直接连接会被宿主判定为无效入口。
export async function main(): Promise<void> {
  // 宿主经 HTTP(S)_PROXY / NO_PROXY 把网络出口配置给子进程，内置 fetch 默认不读，要显式打开。
  // Node 24.14 起才有这个 API（桌面端内置的 Node 已满足），@types/node 24.12 还没有声明。
  (
    http as typeof http & { setGlobalProxyFromEnv?: () => void }
  ).setGlobalProxyFromEnv?.();
  const dist = dirname(fileURLToPath(import.meta.url));
  const pluginRoot = join(dist, "..");
  const manifest = JSON.parse(
    await readFile(join(pluginRoot, ".zcode-plugin", "plugin.json"), "utf8"),
  ) as { version: string };

  const server = createSitesServer({
    version: manifest.version,
    // 和宿主校验官方 MCP 目标时同一口径；目标不一致时宿主不会给身份头。
    api: createSitesApi({
      origin: resolveRuntimeZCodeEndpointOrigin(process.env),
      // 面板只在桌面端可用，桌面端总会设置它；插件自己的版本号不是 ZCode 版本，不拿来顶替。
      appVersion: process.env.ZCODE_APP_VERSION?.trim() ?? "",
      fetch: globalThis.fetch,
      timeoutMs: REQUEST_TIMEOUT_MS,
    }),
    panelPath: join(dist, "ui", "panel.html"),
    commandsDir: join(pluginRoot, "commands"),
  });

  let stopping = false;
  const close = () => {
    if (stopping) return;
    stopping = true;
    void server.close();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  process.stdin.once("end", close);
  await server.connect(new StdioServerTransport());
}

// 保留独立 Node 进程直接启动的用法。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
