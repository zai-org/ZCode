// Agent bundle 的暂存动作：把 apps/zcode-cli/packages/cli/dist/zcode.cjs 放进
// bundled-agents/<平台>/glm，并写 meta。
//
// dev 与打包**必须**用同一份暂存实现。
// 只有打包链（prepare-agent-node-bundle.mjs）会暂存是不够的，dev 链
// （scripts/build-desktop-agent-cli.mjs）不会；而 dev 未打包时的 agent 二进制由
// desktopRuntimeEnv.ts 的 resolveBundledZCodeAgentBinaryPath() 解析，候选**只有**
// bundled-agents/，没有 cli/dist/。于是 dev 一直跑着上一次打包时留下的那份 ——
// 实测陈旧 3 天，任何 agent CLI 侧改动在 dev 里静默不生效，排查时会把「改动没生效」
// 误判成「代码没起作用」。两边共用这一份，dev 与打包不可能再各自漂移。
import { stageCredentialKeyring } from "../../../scripts/stage-credential-keyring.mjs";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const AGENT_BUNDLE_SOURCE_RELATIVE = "apps/zcode-cli/packages/cli/dist/zcode.cjs";

/**
 * 修复原因（2026-10-24 真机）：node_repl MCP server（含内联的 CUA agent runtime）
 * 不在 zcode.cjs 里 —— agent 从 ~/.zcode plugin cache 启动它。dev 的 zcode.cjs 是
 * 纯 esbuild bundle（无 SEA 资产），bootstrap 的 filesystem seed rootCandidates 又
 * 解析不到 apps/zcode-cli/packages/node-repl-host（cwd 是工作区不是仓库布局），
 * 于是 dev agent 只能消费 cache 现有内容；cache 的唯一写入者是生产版 agent 的
 * SEA seed（内嵌旧副本），agent 侧改动在 dev 里永远跑不上。
 * 与生产包布局对齐：把源码包 stage 到 glm/packages/node-repl-host，dev agent 的
 * entrypointDir + rootCandidates[0] 即可命中，每次 dev 启动 seed 都从这份最新
 * 构建刷新 cache（生产版翻写只影响它自己后续起的会话——node_repl server 进程
 * 加载代码后不受 cache 变化影响）。
 * 打包链（prepare-agent-node-bundle.mjs）随后会用更完整的 officialPluginPackages
 * 逻辑重 stage 同一目录，这里重复暂存同源内容无害。
 */
const STAGED_NODE_REPL_HOST_ENTRIES = [
  "dist",
  ".zcode-plugin",
  "package.json",
  "README.md",
  "scripts",
];

export function resolveAgentBundlePaths({ repoRoot, platformKey }) {
  const glmDir = resolve(repoRoot, "packages", "desktop", "bundled-agents", platformKey, "glm");
  return {
    cliBundlePath: resolve(repoRoot, AGENT_BUNDLE_SOURCE_RELATIVE),
    glmDir,
    stagedBundlePath: resolve(glmDir, "zcode.cjs"),
    stagedMetaPath: resolve(glmDir, ".node-bundle-meta.json"),
  };
}

/**
 * 干净重建 glm 目录再拷贝。清空是刻意的：electron-builder 整目录拷贝
 * bundled-agents/<平台>/glm → resources/glm，本地工作树里上一次构建残留的原生二进制
 * （zcode-agent / zcode-acp 等）和旧 meta 会被一并打进安装包（CI 干净检出不会有，本地会）。
 */
export async function stageAgentBundle({ repoRoot, platformKey, log = console.log }) {
  const { cliBundlePath, glmDir, stagedBundlePath, stagedMetaPath } = resolveAgentBundlePaths({
    repoRoot,
    platformKey,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[stage:agent-bundle] agent bundle 源产物不存在：${cliBundlePath}`);
  }
  rmSync(glmDir, { recursive: true, force: true });
  mkdirSync(glmDir, { recursive: true });
  copyFileSync(cliBundlePath, stagedBundlePath);
  const meta = {
    runtime: "electron-node",
    entry: "zcode.cjs",
    platform: platformKey,
    source: AGENT_BUNDLE_SOURCE_RELATIVE,
  };
  writeFileSync(stagedMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  // node-repl-host 暂存（见 STAGED_NODE_REPL_HOST_ENTRIES 注释）：dist 缺失说明调用方
  // 还没构建它（build-desktop-agent-cli 的 defaultBuildFilters 会先建再 stage），跳过
  // 并留给打包链报错，不在共享实现里重复校验。
  const nodeReplHostSource = resolve(repoRoot, "apps", "zcode-cli", "packages", "node-repl-host");
  const nodeReplHostTarget = resolve(glmDir, "packages", "node-repl-host");
  if (existsSync(resolve(nodeReplHostSource, "dist", "mcp", "server.js"))) {
    mkdirSync(nodeReplHostTarget, { recursive: true });
    for (const entry of STAGED_NODE_REPL_HOST_ENTRIES) {
      const sourcePath = resolve(nodeReplHostSource, entry);
      if (existsSync(sourcePath)) {
        cpSync(sourcePath, resolve(nodeReplHostTarget, entry), { recursive: true });
      }
    }
    log(`[stage:agent-bundle] staged node-repl-host runtime for dev self-seed`);
  }
  await stageCredentialKeyring({
    sourceRoot: resolve(repoRoot, "packages/shared"),
    targetRoot: glmDir,
    platformKey,
  });
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);
  return { stagedBundlePath, stagedMetaPath };
}
