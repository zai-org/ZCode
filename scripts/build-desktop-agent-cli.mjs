import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageAgentBundle } from "../packages/desktop/scripts/stage-agent-bundle.mjs";
import { runCommand } from "./spawn-command.mjs";

// adapters tsc 在内存受限机器上会 OOM（exit 134），给整条构建链路提高堆上限。
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : ""}--max-old-space-size=8192`;
import { stageDevCuaPluginRuntime } from "./stage-dev-cua-plugin-runtime.mjs";
import { resolveBuiltinProviderBuildEnvironment } from "./builtin-provider-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const useTurboBuild = process.env.ZCODE_DESKTOP_AGENT_BUILD_MODE === "turbo";
const useBootstrapWithRemoteBuild = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";
const pnpmRunEnv = {
  ...process.env,
  ZCODE_ENV: await resolveBuiltinProviderBuildEnvironment({ root: repoRoot }),
  // pnpm 11 的 verify-deps-before-run 会在 apps/zcode-cli 子 workspace
  // 执行每个 run 前触发 pnpm install；子 workspace 运行时依赖根仓库 @zcode/shared，
  // 自动 install 无法解析根 workspace 包，导致 dev:desktop:test 和 E2E onPrepare 失败。
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
};
// Bug 根因：filesystem plugin seed 若缺少 Sharp closure，会一直到 screenshot/zoom 才报错。
// 此脚本同时服务本地 Dev、prebuild、server CLI 和 packaged desktop agent；三条构建分支
// 都必须补齐同一份可复制 runtime。ZCODE_CUA_DEV_MODE 只传给 staging helper，不进入最终
// product/runtime 环境，因此这里描述的是 staging 输入，而不是产品运行模式。
const cuaPluginRuntimeStagingEnv = {
  ...process.env,
  ZCODE_CUA_DEV_MODE: "1",
};
// 修复原因：桌面 Agent 构建有普通 pnpm 和 bootstrap:with-remote 直跑 tsc 两条路径。
// 过去两条路径分别维护依赖顺序，新增 @zcode/telemetry 后只更新了 bootstrap 依赖，
// 干净 CI 中 telemetry/dist 尚不存在，bootstrap 会因无法解析类型入口而失败。
// 两条路径统一从这一份有序清单派生，避免后续新增 workspace 依赖时再次漂移。
const cliWorkspaceBuilds = [
  { packageName: "@zcode/shared-types", packageDir: "shared-types" },
  { packageName: "@zcode/contracts", packageDir: "contracts" },
  // dynamic-workflow 的 tsc 构建依赖 gitignored 的 libs.generated.ts，
  // 而 bare-tsc 路径（runBootstrapWithRemoteBuild）不会执行 package build script，
  // 所以需要先跑生成脚本；必须排在 @zcode/core 之前，core 依赖 dynamic-workflow。
  {
    packageName: "@zcode/dynamic-workflow",
    packageDir: "dynamic-workflow",
    prepareScript: "scripts/generate-libs.mjs",
  },
  // dynamic-workflow-runtime 的类型入口是 dist/index.d.ts，必须先于 bootstrap 构建。
  { packageName: "@zcode/dynamic-workflow-runtime", packageDir: "dynamic-workflow-runtime" },
  { packageName: "@zcode/core", packageDir: "core" },
  { packageName: "@zcode/adapters", packageDir: "adapters" },
  { packageName: "@zcode/i18n", packageDir: "i18n" },
  { packageName: "@zcode/telemetry", packageDir: "telemetry" },
  { packageName: "@zcode/bootstrap", packageDir: "bootstrap" },
];
// 官方插件 manifest 可以在 server.js 缺失时被 filesystem seed，直到 session
// 连接 MCP 才报错，造成“Helper ready 但 CUA 工具不存在”的半启动状态。所有普通 Dev 必需的
// 独立 MCP runtime 必须集中登记，并在构建后验证真实入口文件，再允许 Agent bundle 启动。
// Bug 原因：本脚本同时是 Source Server archive staging（stageCli.ts ensureAgentBundle）唯一的
// 插件构建入口。legacy prepare-prebuilds.mjs 删除后，android-emulator / ios-simulator 的
// dist/mcp/server.js 不再被任何远端构建步骤产出，而插件 dist 被 gitignore，干净 CI 会把缺 MCP
// 入口的插件打进 archive。凡 plugin.json 声明了 mcpServers 的官方插件都必须登记在此。
const requiredDevPluginRuntimeBuilds = [
  {
    packageName: "@zcode/android-emulator-plugin",
    artifactPath: "android-emulator-plugin/dist/mcp/server.js",
  },
  {
    packageName: "@zcode/ios-simulator-plugin",
    artifactPath: "ios-simulator-plugin/dist/mcp/server.js",
  },
  {
    // node_repl 宿主：Browser Use 与 Computer Use 共用，产物归属独立包。
    packageName: "@zcode/node-repl-host",
    artifactPath: "node-repl-host/dist/mcp/server.js",
  },
  {
    // browser-use 自己的 runtime 只剩 browser-client；宿主不再由它携带。
    packageName: "@zcode/browser-use-plugin",
    artifactPath: "browser-use-plugin/scripts/browser-client.mjs",
  },
  // 文档插件的查看面板 server 由 office-runtime 构建；dev 若不构建，面板入口可见但 MCP 启动失败。
  ...["documents", "pdf", "presentations", "spreadsheets"].map((name) => ({
    packageName: `@zcode/${name}-plugin`,
    artifactPath: `${name}-plugin/dist/server.mjs`,
  })),
  // Sites 面板的 MCP server 由插件自己构建；不构建时面板入口可见但 MCP 启动失败。
  { packageName: "@zcode/zcode-site-plugin", artifactPath: "zcode-site-plugin/dist/server.mjs" },
];
const defaultBuildFilters = [
  ...cliWorkspaceBuilds.map(({ packageName }) => packageName),
  ...requiredDevPluginRuntimeBuilds.map(({ packageName }) => packageName),
];

async function verifyRequiredDevPluginRuntimeArtifacts() {
  for (const runtime of requiredDevPluginRuntimeBuilds) {
    const artifactPath = resolve(repoRoot, "apps/zcode-cli/packages", runtime.artifactPath);
    try {
      await access(artifactPath);
    } catch (error) {
      throw new Error(
        `[build-desktop-agent-cli] ${runtime.packageName} build succeeded without required MCP runtime: ${artifactPath}`,
        { cause: error },
      );
    }
  }
}

/**
 * 把刚构建出的 agent bundle 暂存进 bundled-agents。
 *
 * 必须做：dev 未打包时 agent 二进制由 desktopRuntimeEnv.ts 的
 * resolveBundledZCodeAgentBinaryPath() 解析，候选**只有** bundled-agents/，没有
 * cli/dist/。只靠打包链暂存会让 dev 一直跑上一次打包留下的那份 —— 实测陈旧
 * 3 天，任何 agent CLI 侧改动在 dev 里静默不生效，把「改动没进去」伪装成「代码没作用」。
 * 实现与打包链共用 stage-agent-bundle.mjs，两边不可能再各自漂移。
 *
 * dev 只跑宿主平台，所以 platformKey 直接取 process；打包链的跨平台 target 由它自己解析。
 */
async function stageDevAgentBundle() {
  await stageAgentBundle({
    repoRoot,
    platformKey: `${process.platform}-${process.arch}`,
  });
}

function runBootstrapWithRemoteBuild() {
  // Bug 原因：bootstrap 过去把 dist/zcode.cjs 存在当作本轮已构建，源码变化后仍会
  // 把上一代 Agent 放进 Source Server archive。bootstrap 成功必须代表本轮真实重建。
  for (const { packageDir, prepareScript } of cliWorkspaceBuilds) {
    // bootstrap:with-remote 会在 remote assets 阶段构建 agent bundle。
    // 通过 pnpm 逐包执行 tsc 时会再走 shim/env node 层，低内存本地环境里容易长时间卡住。
    // 这里只有 bootstrap 专用环境变量生效，直接复用当前 Node 启动 TypeScript CLI。
    // bare tsc 绕过 package build script，所以带 prepareScript 的包（dynamic-workflow）
    // 必须先手动跑生成脚本补齐 gitignored 的 libs.generated.ts，否则 tsc 因缺文件报错。
    if (prepareScript) {
      runCommand(process.execPath, [prepareScript], {
        cwd: `apps/zcode-cli/packages/${packageDir}`,
        env: pnpmRunEnv,
        stdio: "inherit",
      });
    }
    runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
      cwd: `apps/zcode-cli/packages/${packageDir}`,
      env: pnpmRunEnv,
      stdio: "inherit",
    });
  }

  runCommand(process.execPath, ["scripts/build.mjs", "--desktop-agent"], {
    cwd: "apps/zcode-cli/packages/cli",
    env: pnpmRunEnv,
    stdio: "inherit",
  });
}

if (useBootstrapWithRemoteBuild) {
  runBootstrapWithRemoteBuild();
  await stageDevAgentBundle();
  stageDevCuaPluginRuntime({ env: cuaPluginRuntimeStagingEnv });
  process.exit(0);
}

if (!useTurboBuild) {
  // Linux 容器 demo 里没有仓库级 turbo 根，`turbo --cwd apps/zcode-cli`
  // 会把 apps/zcode-cli 当根目录，并拒绝 turbo.json 中指向 ../../packages/shared 的 inputs。
  // 同时 agent 子 workspace 不包含根 packages/shared，但 agent 包依赖 @zcode/shared。
  // 因此默认改用仓库根 workspace 的明确 pnpm 包顺序构建，避免 WDIO 前置构建卡在子 workspace 解析。
  for (const filter of defaultBuildFilters) {
    runCommand("pnpm", ["--filter", filter, "build"], {
      env: pnpmRunEnv,
      stdio: "inherit",
    });
  }

  await verifyRequiredDevPluginRuntimeArtifacts();
  runCommand("pnpm", ["--filter", "@zcode/cli", "build:desktop-agent"], {
    env: pnpmRunEnv,
    stdio: "inherit",
  });
  await stageDevAgentBundle();
  stageDevCuaPluginRuntime({ env: cuaPluginRuntimeStagingEnv });
  process.exit(0);
}

runCommand(
  "pnpm",
  [
    "exec",
    "turbo",
    "--skip-infer",
    "--cwd",
    "apps/zcode-cli",
    "run",
    "build:desktop-agent",
    "--filter=@zcode/cli",
  ],
  {
    env: pnpmRunEnv,
    stdio: "inherit",
  },
);
await stageDevAgentBundle();
stageDevCuaPluginRuntime({ env: cuaPluginRuntimeStagingEnv });
