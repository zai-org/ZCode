import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type {
  PluginDiscoverRequest,
  PluginManifest,
  PluginWorkspaceTrust,
  WorkspacePluginDiscovery,
} from "@zcode/contracts";
import { ZCODE_INLINE_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import { parsePluginManifest } from "../discovery/index.js";
import { resolveInside } from "../helpers.js";
import { STANDARD_HOOKS_PATH } from "../hook-sources.js";
import type { LoadedPlugin, PluginCandidate } from "../types.js";
import type { WorkspacePluginTextReader } from "./contract.js";

// ============================================================
// 项目目录插件的声明摘要（docs/plugins/workspace-plugin-dir-trust.md）。
// 摘要覆盖插件清单与 Hook/MCP 声明文件的原文；这些文件任一变化，用户域信任记录就不再命中，
// 插件回到「待信任」。脚本、技能正文等其它文件不进入摘要。
// 启动发现、打开会话里的实时目录与设置页信任写入共用本文件，保证三处对同一插件算出同一摘要。
// ============================================================

const DIGEST_VERSION = 1;
const MCP_DECLARATION_PATH = ".mcp.json";
/** 与插件发现相同的 manifest 查找顺序：第一个存在的生效。 */
const MANIFEST_PATHS = [
  join(".zcode-plugin", "plugin.json"),
  join(".claude-plugin", "plugin.json"),
  join(".codex-plugin", "plugin.json"),
];

export type { WorkspacePluginDeclarationContract, WorkspacePluginTextReader } from "./contract.js";

/** 插件根相对工作区目录的键，统一用 `/`；受管 worktree 与源仓库因此得到同一个键。 */
export function workspacePluginRootKey(workspaceRoot: string, rootPath: string): string {
  const key = relative(resolve(workspaceRoot), resolve(rootPath)).split(sep).join("/");
  return key === "" ? "." : key;
}

/**
 * 计算声明摘要。参与的文件：manifest、`hooks/hooks.json`、`.mcp.json`，以及 manifest 里
 * `hooks` / `mcpServers` 以路径形式引用的文件（越出插件根的路径与发现时一样被忽略）。
 * 内联在 manifest 里的 Hook/MCP 声明随 manifest 原文覆盖。缺失的文件记为 null，
 * 新增声明文件同样会改变摘要。
 */
export async function computeWorkspacePluginDeclarationDigest(input: {
  pluginRoot: string;
  rootPath: string;
  manifestPath: string;
  manifest: PluginManifest;
  readText: WorkspacePluginTextReader;
}): Promise<string> {
  const paths = new Set<string>([
    input.manifestPath,
    join(input.rootPath, STANDARD_HOOKS_PATH),
    join(input.rootPath, MCP_DECLARATION_PATH),
    ...referencedPaths(input.rootPath, input.manifest.hooks),
    ...referencedPaths(input.rootPath, input.manifest.mcpServers),
  ]);
  const files = await Promise.all(
    [...paths].map(async (path) => {
      const text = await input.readText(path);
      return {
        path: relative(input.rootPath, path).split(sep).join("/"),
        // 统一换行，避免同一份声明在不同 checkout 换行设置下摘要不同。
        text: text === undefined ? null : text.replace(/\r\n/gu, "\n"),
      };
    }),
  );
  // 修复原因（!3742 SG-03）：localeCompare 依赖进程 locale，同一插件在不同语言设置下摘要会不同。
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify({ version: DIGEST_VERSION, pluginRoot: input.pluginRoot, files }))
    .digest("hex");
}

/**
 * 直接读磁盘检查一个项目插件目录，供信任写入时重验摘要。
 * 目录里没有可用 manifest 时返回 undefined。
 */
export async function inspectWorkspacePluginRoot(input: {
  workspaceRoot: string;
  rootPath: string;
}): Promise<{ pluginName: string; pluginRoot: string; declarationDigest: string } | undefined> {
  const rootPath = resolve(input.rootPath);
  for (const relativePath of MANIFEST_PATHS) {
    const manifestPath = join(rootPath, relativePath);
    const text = await readTextIfExists(manifestPath);
    if (text === undefined) continue;
    let manifest: PluginManifest;
    try {
      manifest = parsePluginManifest(JSON.parse(text));
    } catch {
      // 与发现一致：第一个存在的 manifest 无效时插件不可用，不回退到下一个目录。
      return undefined;
    }
    const pluginRoot = workspacePluginRootKey(input.workspaceRoot, rootPath);
    return {
      pluginName: manifest.name,
      pluginRoot,
      declarationDigest: await computeWorkspacePluginDeclarationDigest({
        pluginRoot,
        rootPath,
        manifestPath,
        manifest,
        readText: readTextIfExists,
      }),
    };
  }
  return undefined;
}

/** 项目目录候选；用户已登记的同一目录按用户来源加载，不再要求项目信任。 */
export function candidatesOf(
  workspace: WorkspacePluginDiscovery | undefined,
  userCandidates: readonly PluginCandidate[],
): PluginCandidate[] {
  const userRoots = new Set(userCandidates.map((candidate) => candidate.rootPath));
  return [...new Set((workspace?.roots ?? []).map((root) => resolve(root)))]
    .filter((rootPath) => !userRoots.has(rootPath))
    .map((rootPath) => ({
      defaultEnabled: true,
      marketplace: ZCODE_INLINE_PLUGIN_MARKETPLACE,
      rootPath,
      source: "inline" as const,
      workspace: true,
    }));
}

/**
 * 项目目录插件的准入：摘要与 manifest 读自同一批发现材料，材料在本次发现中途变化时整体重建，
 * 所以准入判定的声明就是随后被解析执行的声明。
 */
export async function trustOf(
  request: Pick<PluginDiscoverRequest, "workspacePlugins" | "workingDirectory">,
  candidate: PluginCandidate,
  loaded: LoadedPlugin,
): Promise<PluginWorkspaceTrust | undefined> {
  if (!candidate.workspace) return undefined;
  const workspace = request.workspacePlugins;
  const pluginRoot = workspacePluginRootKey(
    workspace?.workspaceRoot ?? request.workingDirectory,
    loaded.rootPath,
  );
  const materials = loaded.materials;
  const declarationDigest = await computeWorkspacePluginDeclarationDigest({
    pluginRoot,
    rootPath: loaded.rootPath,
    manifestPath: loaded.manifestPath,
    manifest: loaded.manifest,
    readText: async (path) =>
      materials
        ? (await materials.fileExists(path))
          ? await materials.text(path)
          : undefined
        : readTextIfExists(path),
  });
  const trusted =
    workspace?.trusted.some(
      (record) =>
        record.pluginRoot === pluginRoot && record.declarationDigest === declarationDigest,
    ) ?? false;
  return { state: trusted ? "trusted" : "pending", pluginRoot, declarationDigest };
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

// 修复原因（!3742 CR-01）：MCP 加载按 mcpSourcesFromSpec 递归展开嵌套数组，这里曾只看一层，
// 嵌套数组引用的声明文件不进摘要，改动后插件不回到待信任。展开口径必须与加载一致。
function referencedPaths(rootPath: string, spec: unknown): string[] {
  if (Array.isArray(spec)) return spec.flatMap((item) => referencedPaths(rootPath, item));
  if (typeof spec !== "string") return [];
  const path = resolveInside(rootPath, spec);
  return path ? [path] : [];
}
