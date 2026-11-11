import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
  ZCODE_PLUGIN_HOST_COMMAND,
  type McpServerConfig,
} from "@zcode/contracts";
import { ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared";
import {
  createOfficialPluginCacheRetryBudget,
  type OfficialPluginCacheRetryBudget,
  writeTextFileAtomicallyWithRetry,
} from "./official-plugin-cache-fs.js";

type SeaModule = typeof import("node:sea");

const MCP_SERVER_RELATIVE_PATH = ["dist", "mcp", "server.js"] as const;

export function createBundledMcpRuntimeConfig(input: {
  cwd: string;
  env?: Record<string, string>;
  relativeServerPath?: readonly string[];
  rootPath: string;
  timeoutMs?: number;
}): McpServerConfig | undefined {
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return undefined;
  return {
    args: [
      ...hostPrefixArgs,
      join(input.rootPath, ...(input.relativeServerPath ?? MCP_SERVER_RELATIVE_PATH)),
    ],
    command: process.execPath,
    cwd: input.cwd,
    env: {
      ...input.env,
      // 桌面打包态 process.execPath 是 ZCode Helper；缺少 Node 模式会误进 Electron main。
      ELECTRON_RUN_AS_NODE: "1",
    },
    timeoutMs: input.timeoutMs,
    type: "stdio",
  };
}

interface OfficialRuntimeManifestInput {
  sourceManifestContents?: string;
  pluginName: string;
  retryBudget?: OfficialPluginCacheRetryBudget;
  rootPath: string;
}

export async function writeOfficialPluginRuntimeManifest(
  input: OfficialRuntimeManifestInput,
): Promise<void> {
  const manifestPath = join(input.rootPath, ".zcode-plugin", "plugin.json");
  const currentContents = await readFile(manifestPath, "utf8");
  // 缓存里的入口可能已被旧客户端覆盖，必须从内置原始 manifest 重新生成。
  const manifest = JSON.parse(input.sourceManifestContents ?? currentContents) as Record<
    string,
    unknown
  >;
  // skill-only / command-only 类型的 official plugin 不带 mcpServers，直接跳过 rewrite。
  // 之前这里无脑 asRecord(manifest.mcpServers) 会对 undefined 抛错，
  // 把 seed 流程整个阻断，连带 listZCodeSkills 拉不出 plugin skill。
  if (manifest.mcpServers === undefined) return;
  const mcpServers = asRecord(manifest.mcpServers);
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return;

  // 保留对其他历史 official plugin MCP 的通用重写；zcode-cua 当前是 skill/SDK-only，
  // 不会进入这个分支，也不会生成独立的 CUA MCP server。
  for (const [serverKey, serverRaw] of Object.entries(mcpServers)) {
    const mcpServer = asRecord(serverRaw);
    // HTTP/SSE 插件没有本地入口；按 stdio 校验会让 image-search 阻断整个会话初始化。
    if (mcpServer.type !== undefined && mcpServer.type !== "stdio") continue;
    const mcpServerEnv = isRecord(mcpServer.env) ? mcpServer.env : {};
    const serverArgs =
      input.sourceManifestContents === undefined
        ? [join(input.rootPath, ...MCP_SERVER_RELATIVE_PATH)]
        : mcpServer.args;
    if (
      !Array.isArray(serverArgs) ||
      !serverArgs.every((arg): arg is string => typeof arg === "string") ||
      serverArgs.length === 0
    ) {
      throw new Error("Official plugin manifest has invalid MCP server args.");
    }
    mcpServer.command = process.execPath;
    // 文档插件使用 dist/server.mjs；统一覆盖成 dist/mcp/server.js 会导致启动失败。
    mcpServer.args = [
      ...hostPrefixArgs,
      ...serverArgs.map((arg) => arg.replaceAll("${ZCODE_PLUGIN_ROOT}", input.rootPath)),
    ];
    mcpServer.env = {
      ...mcpServerEnv,
      // 桌面打包态的 process.execPath 是 ZCode Helper。
      // 官方插件 MCP server 缺少 Node 模式 env 时会误进 Electron main，触发 deep-link 注册等桌面副作用。
      ELECTRON_RUN_AS_NODE: "1",
      // 权威写入插件身份（pluginName@marketplace，来自本地 plugin registry，manifest/user env 不可覆盖）。
      // 其他 official plugin 仍带上不可伪造的 plugin identity；CUA broker 凭据由 shared
      // node_repl 的可信配置注入，不再写入独立 server。
      [ZCODE_PLUGIN_ID_ENV_KEY]: `${input.pluginName}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
    };
    mcpServers[serverKey] = mcpServer;
  }
  manifest.mcpServers = mcpServers;

  const nextContents = `${JSON.stringify(manifest, null, 2)}\n`;
  // 启动时无条件 rename 同内容的 plugin.json 会放大 Windows 杀毒/索引器
  // 的短暂文件占用。字节完全一致时不触碰文件；真正有更新时仍保持原子的失败语义。
  if (nextContents === currentContents) return;
  await writeTextFileAtomicallyWithRetry(
    manifestPath,
    nextContents,
    input.retryBudget ?? createOfficialPluginCacheRetryBudget(),
  );
}

export function officialPluginHostPrefixArgs(): string[] | undefined {
  if (isSeaRuntime()) return [ZCODE_PLUGIN_HOST_COMMAND];

  const entrypoint = process.argv[1];
  if (!entrypoint) return undefined;

  return [...process.execArgv, resolve(entrypoint), ZCODE_PLUGIN_HOST_COMMAND];
}

function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Official plugin manifest has invalid mcpServers.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 内置技能包（bundled-skills.ts）沿同一组候选目录定位，保证两类内置资产在每种运行布局下同进同出。 */
export function candidateBaseDirs(): string[] {
  // 修复原因：Electron app-server 运行在 resources/glm/zcode.cjs，官方插件资源也随桌面包
  // stage 到同级 packages/*-plugin。候选目录必须优先看入口文件目录，避免生产态退回到
  // monorepo-only 的 __dirname 查找假设。
  return [...bundleBaseDirs(), process.cwd()];
}

/** 入口文件目录与 bundle 自身目录，不含 cwd：随包运行时资产（如 npm）不能被工作区同名目录顶替。 */
export function bundleBaseDirs(): string[] {
  return [entrypointDir(), runtimeDir()].filter((dir): dir is string => typeof dir === "string");
}

function runtimeDir(): string | undefined {
  return typeof __dirname === "string" ? __dirname : undefined;
}

function entrypointDir(): string | undefined {
  return process.argv[1] ? dirname(process.argv[1]) : undefined;
}
