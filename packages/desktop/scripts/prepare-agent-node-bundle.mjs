#!/usr/bin/env node

// 桌面打包态的 agent 运行时资产：把 agent 的 JS bundle（zcode.cjs）放进 bundled-agents/<platform>/glm，
// 由 app 内置的 Electron Node runtime（ELECTRON_RUN_AS_NODE）执行，替代以前随包内置的独立 Node 二进制。
//
// 为什么这么做：
// - agent 没有任何原生 NAPI 插件（ripgrep 是 WASM，其余纯 JS），可直接跑在 Electron 的 Node 上；
// - Electron 41 内置 Node 24.x，与 zcode-cli 的目标运行时一致；
// - 单平台体积从 ~180MB 降到 ~16MB，且同一份 JS 跨平台通用；
// - app-server 命令路径不会加载 @zcode/tui，所以这里天然不打包 TUI。
//
// 远端（SSH/WSL/Docker）没有 Electron，由 Source Server archive 自带目标 Node，互不影响。

// 修复原因：bootstrap 清理旧插件 dist 时使用 rmSync，漏导入会在构建前抛出 ReferenceError。
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { stageAgentBundle } from "./stage-agent-bundle.mjs";
import {
  isSharpRequiredByComputerUse,
  stageSharpIntoBundledAgents,
} from "./sharp-package-assets.mjs";
import { stageKoffiIntoBundledAgents } from "./koffi-package-assets.mjs";
import { BUNDLED_NPM_VERSION, stageBundledNpm } from "./bundled-npm-assets.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const cliBundlePath = resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
const adaptersRoot = resolve(repoRoot, "apps/zcode-cli/packages/adapters");
const pnpmRunEnv = {
  ...process.env,
  // pnpm 11 会在 apps/zcode-cli 子 workspace 执行 run 前触发 install；
  // 子 workspace 不能解析根 workspace 的 @zcode/shared，Docker/web app 打包会因此卡在插件 runtime 构建。
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
};
const BROWSER_USE_PLUGIN_PACKAGE_NAME = "@zcode/browser-use-plugin";
const NODE_REPL_HOST_PACKAGE_NAME = "@zcode/node-repl-host";
const CUA_PLUGIN_PACKAGE_NAME = "@zcode/zcode-cua-plugin";

// 平台目录命名：darwin/win32/linux + x64/arm64，
// 支持 ZCODE_TARGET_OS / ZCODE_TARGET_ARCH 覆盖（交叉打包时由 CI 注入）。
function normalizePlatform(raw) {
  switch (raw) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      return raw;
  }
}

function normalizeArch(raw) {
  switch (raw) {
    case "x86_64":
    case "x64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return raw;
  }
}

const platform = normalizePlatform(process.env.ZCODE_TARGET_OS || "") || process.platform;
const arch = normalizeArch(process.env.ZCODE_TARGET_ARCH || "") || process.arch;
const platformKey = `${platform}-${arch}`;

const glmDir = resolve(desktopRoot, "bundled-agents", platformKey, "glm");
// zcode.cjs / .node-bundle-meta.json 的落点由 stage-agent-bundle.mjs 自己解析（同源）。
// node_repl 宿主抽成独立包
// @zcode/node-repl-host 之后，browser-use 不再产出 dist/mcp/server.js，CUA 资产
// （docs/computer-use.md、scripts/computer-use-client.mjs）也已归 @zcode/zcode-cua-plugin。
// 这份清单当时漏改，打包准备阶段照旧去 browser-use 要那三个文件，直接 missing runtime 挂掉。
// dev 链路走的是 scripts/build-desktop-agent-cli.mjs 的 requiredDevPluginRuntimeBuilds（那份改对了），
// 两份平行清单各自维护，所以 dev 测不出来 —— 权威归属见 bootstrap/official-plugin-definitions.ts。
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json 已暴露 recording lookup，桌面安装包不能复用缺少正文的 runtime。
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];
// 文档插件（documents / pdf / presentations / spreadsheets）的查看面板由共享包
// @zcode/office-runtime 构建进各插件 dist/；插件包自身没有 TypeScript 源码。
const officeViewerRuntimePaths = ["dist/server.mjs", "dist/ui/assets.json", "dist/ui/panel.html"];
const officialPluginPackages = [
  {
    packageName: "@zcode/android-emulator-plugin",
    relativePath: "apps/zcode-cli/packages/android-emulator-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build-mcp.mjs",
    stagedPath: "packages/android-emulator-plugin",
  },
  {
    packageName: "@zcode/documents-plugin",
    relativePath: "apps/zcode-cli/packages/documents-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: officeViewerRuntimePaths,
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/docx/SKILL.md",
      "skills/docx-viewer/SKILL.md",
    ],
    runtimeBuildScript: "../office-runtime/scripts/build.mjs",
    stagedPath: "packages/documents-plugin",
  },
  {
    packageName: "@zcode/image-search-plugin",
    relativePath: "apps/zcode-cli/packages/image-search-plugin",
    requiresRuntime: false,
    requiredSeedPaths: [".mcp.json"],
    stagedPath: "packages/image-search-plugin",
  },
  {
    packageName: "@zcode/pdf-plugin",
    relativePath: "apps/zcode-cli/packages/pdf-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: officeViewerRuntimePaths,
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/pdf/SKILL.md",
      "skills/pdf-viewer/SKILL.md",
    ],
    runtimeBuildScript: "../office-runtime/scripts/build.mjs",
    stagedPath: "packages/pdf-plugin",
  },
  {
    packageName: "@zcode/presentations-plugin",
    relativePath: "apps/zcode-cli/packages/presentations-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: officeViewerRuntimePaths,
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/pptx/SKILL.md",
      "skills/pptx-viewer/SKILL.md",
    ],
    runtimeBuildScript: "../office-runtime/scripts/build.mjs",
    stagedPath: "packages/presentations-plugin",
  },
  {
    packageName: "@zcode/spreadsheets-plugin",
    relativePath: "apps/zcode-cli/packages/spreadsheets-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: officeViewerRuntimePaths,
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/xlsx/SKILL.md",
      "skills/xlsx-viewer/SKILL.md",
    ],
    runtimeBuildScript: "../office-runtime/scripts/build.mjs",
    stagedPath: "packages/spreadsheets-plugin",
  },
  {
    packageName: "@zcode/visualize-plugin",
    relativePath: "apps/zcode-cli/packages/visualize-plugin",
    requiresRuntime: false,
    requiredSeedPaths: [
      "skills/visualize/SKILL.md",
      "skills/visualize/references/api.md",
      "skills/visualize/references/styles.md",
      "skills/visualize/tweak.md",
      "skills/visualize/LICENSE.md",
      "skills/visualize/scripts/render.py",
      "skills/visualize/assets/visualize.css",
      "skills/visualize/assets/visualize.html",
      "skills/visualize/assets/calendar.js",
      "skills/visualize/assets/runtime-manifest.json",
      "skills/visualize/scripts/vendor.py",
      "skills/visualize/assets/vendor/manifest.json",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js.LICENSE",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js.LICENSE",
      "skills/visualize/assets/vendor/lucide-1.17.0.js",
      "skills/visualize/assets/vendor/lucide-1.17.0.js.LICENSE",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js.LICENSE",
      "skills/visualize/widgets/calendar.md",
      "skills/visualize/examples/calendar.html",
      "skills/visualize/assets/standalone-host-bridge.js",
      "skills/visualize/assets/standalone-shell.js",
    ],
    requiredRuntimePaths: [],
    stagedPath: "packages/visualize-plugin",
  },
  {
    // browser-use 只携带自己的 client script 与 skill/docs；node_repl MCP runtime 归
    // @zcode/node-repl-host（见上方常量注释）。
    packageName: "@zcode/browser-use-plugin",
    relativePath: "apps/zcode-cli/packages/browser-use-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/browser-use-plugin",
  },
  {
    packageName: "@zcode/ios-simulator-plugin",
    relativePath: "apps/zcode-cli/packages/ios-simulator-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build-mcp.mjs",
    stagedPath: "packages/ios-simulator-plugin",
  },
  {
    // 修复原因：restore-legacy-sessions 已注册为官方插件，但 Electron 生产包只会拷贝
    // 这里列出的资源。漏掉它会导致用户生产包首次启动后 plugins list 里看不到该插件。
    packageName: "@zcode/restore-legacy-sessions-plugin",
    relativePath: "apps/zcode-cli/packages/restore-legacy-sessions-plugin",
    requiresRuntime: false,
    stagedPath: "packages/restore-legacy-sessions-plugin",
  },
  {
    packageName: "@zcode/skill-creator-plugin",
    relativePath: "apps/zcode-cli/packages/skill-creator-plugin",
    requiresRuntime: false,
    stagedPath: "packages/skill-creator-plugin",
  },
  {
    packageName: "@zcode/plugin-creator-plugin",
    relativePath: "apps/zcode-cli/packages/plugin-creator-plugin",
    requiresRuntime: false,
    stagedPath: "packages/plugin-creator-plugin",
  },
  {
    // 修复原因：zcode-guide 已注册为官方默认启用内容型插件（见 official-plugin-definitions.ts）。
    // Electron 生产包不是 SEA 路径，官方插件 seed 依赖这里 stage 的 resources/glm/packages/*-plugin；
    // 漏掉它会导致生产桌面包首启 seed 不到该插件，用户拿不到默认启用的配置指南技能。
    packageName: "@zcode/zcode-guide-plugin",
    relativePath: "apps/zcode-cli/packages/zcode-guide-plugin",
    requiresRuntime: false,
    stagedPath: "packages/zcode-guide-plugin",
  },
  {
    // ZCode Sites（默认开启）。漏 stage 会让生产桌面包里找不到它；Sites 面板的 MCP server 与页面由插件自己的
    // build 脚本构建进 dist/。
    packageName: "@zcode/zcode-site-plugin",
    relativePath: "apps/zcode-cli/packages/zcode-site-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/server.mjs", "dist/ui/panel.html"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/zcode-site-plugin",
  },
  {
    // node_repl 宿主：Browser Use 与 Computer Use 共用的 MCP runtime，本轮抽成独立包。
    // 它没有 listing（不进插件市场展示面），但生产包首启 seed 必须拿到它的 dist runtime，
    // 否则 bua/cua 任一开启时都会连不上 node_repl。
    packageName: "@zcode/node-repl-host",
    relativePath: "apps/zcode-cli/packages/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/node-repl-host",
  },
  {
    // CUA 插件只携带 SDK/skill/docs；node_repl MCP runtime 归 @zcode/node-repl-host。
    packageName: "@zcode/zcode-cua-plugin",
    relativePath: "apps/zcode-cli/packages/zcode-cua-plugin",
    requiresRuntime: false,
    stagedPath: "packages/zcode-cua-plugin",
  },
  {
    // design（默认启用内容型插件）：Electron 生产包靠这里 stage 的目录做首启 seed，漏掉它
    // 生产桌面包就没有设计技能。必需文件与 official-plugin-definitions.ts 的 requiredSeedPaths 一致。
    packageName: "@zcode/design-plugin",
    relativePath: "apps/zcode-cli/packages/design-plugin",
    requiresRuntime: false,
    requiredSeedPaths: [
      "skills/design/SKILL.md",
      "skills/design/references/catalog.md",
      "skills/design/references/check.md",
      "skills/design/references/create.md",
      "skills/design/references/design-system.md",
      "skills/design/references/interact.md",
      "skills/design/references/output.md",
      "skills/design/references/redesign.md",
      "skills/design/scripts/adapt-canvas.mjs",
      "skills/design/scripts/design-lint.mjs",
      "skills/design/scripts/design-tokens.mjs",
      "skills/design/scripts/import-design-system.mjs",
      "hooks/hooks.json",
      "hooks/run-hook.cmd",
      "hooks/design-rules",
    ],
    requiredRuntimePaths: [],
    stagedPath: "packages/design-plugin",
  },
  // superpowers 已从内置插件下线，改走 UI 推荐区按需安装；这里不再 stage 它的资源。
];
// 随 CLI 内置的技能包（不是插件）：bootstrap 的 resolveBundledSkillRoots 沿官方插件同款候选目录
// 在 zcode.cjs 旁找 packages/bundled-skills 并原地读取。漏 stage 它，桌面包的 /workflow 会展开成
// 「先加载 dynamic-workflows 技能」而技能不存在——这正是把它从可卸载的 zcode-guide 插件搬出来要修的事故形态。
const bundledSkillPack = {
  relativePath: "apps/zcode-cli/packages/bundled-skills",
  requiredPaths: [
    "skills/dynamic-workflows/SKILL.md",
    "skills/dynamic-workflows/patterns.md",
    "skills/dynamic-workflows/examples.md",
  ],
  stagedPath: "packages/bundled-skills",
  topLevelPaths: ["README.md", "skills"],
};
const includedOfficialPluginTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // Electron 生产资源复制有独立白名单，遗漏 agents 会让首启 filesystem seed 永久缺少子代理。
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  "scripts",
  "skills",
  "templates",
]);
const excludedOfficialPluginAssetNames = new Set([
  ".DS_Store",
  ".venv",
  "__pycache__",
  "node_modules",
]);

function shouldCopyOfficialPluginAsset(sourcePath) {
  const name = basename(sourcePath);
  return !excludedOfficialPluginAssetNames.has(name) && !name.endsWith(".pyc");
}
const isBootstrapWithRemote = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";

function buildCliBundle() {
  console.log("[prepare:agent-bundle] building zcode-cli app-server bundle ...");
  // 复用仓库根脚本（turbo build:desktop-agent --filter=@zcode/cli），命中缓存时几乎瞬时。
  runCommand(process.execPath, [resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs")], {
    cwd: repoRoot,
    env: pnpmRunEnv,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(
      `[prepare:agent-bundle] expected cli bundle missing after build: ${cliBundlePath}`,
    );
  }
}

function buildOfficialPluginRuntimes() {
  for (const plugin of officialPluginPackages) {
    if (!plugin.requiresRuntime) continue;
    console.log(`[prepare:agent-bundle] building ${plugin.packageName} runtime ...`);
    if (isBootstrapWithRemote) {
      buildOfficialPluginRuntimeForBootstrap(plugin);
      assertOfficialPluginRuntime(plugin);
      continue;
    }

    runCommand(
      "pnpm",
      ["--dir", resolve(repoRoot, "apps/zcode-cli"), "--filter", plugin.packageName, "build"],
      {
        cwd: repoRoot,
        env: pnpmRunEnv,
      },
    );
    assertOfficialPluginRuntime(plugin);
  }
}

function buildOfficialPluginRuntimeForBootstrap(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  // Bugfix: bootstrap:with-remote 会连续构建 remote assets 和桌面 agent bundle。
  // 通过 pnpm/filter 进入插件 build 时，tsc shim 在本地低内存环境中容易被 SIGKILL；
  // 这里仅在 bootstrap 开关下用当前 Node 直接执行等价 tsc + build-mcp，不改变插件自身 build 脚本。
  // Bug 原因：过去除 browser-use 外只要 dist 文件齐全就复用，源码变化后 bootstrap 仍会
  // 打包上一代插件 runtime；所有代码型官方插件都必须在本轮重建。
  rmSync(resolve(pluginRoot, "dist"), { recursive: true, force: true });
  // 文档插件没有自己的 tsconfig（源码在 office-runtime），直接跑 tsc 会因找不到工程配置失败；
  // 只有带 tsconfig 的插件才需要这一步。
  if (existsSync(resolve(pluginRoot, "tsconfig.json"))) {
    runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
      cwd: pluginRoot,
      env: process.env,
    });
  }
  runCommand(process.execPath, [plugin.runtimeBuildScript], {
    cwd: pluginRoot,
    env: process.env,
  });
}

function assertOfficialPluginRuntime(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  for (const relativePath of plugin.requiredRuntimePaths) {
    const runtimePath = resolve(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin runtime: ${runtimePath}`);
    }
  }
}

async function stageBundle() {
  // 实现已抽到 stage-agent-bundle.mjs：dev 链（scripts/build-desktop-agent-cli.mjs）
  // 必须用同一份，否则 dev 会继续跑上一次打包留下的陈旧 agent。
  await stageAgentBundle({ repoRoot, platformKey });
}

function stageOfficialPlugins() {
  for (const plugin of officialPluginPackages) {
    const sourceRoot = resolve(repoRoot, plugin.relativePath);
    const manifestPath = resolve(sourceRoot, ".zcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin manifest: ${manifestPath}`);
    }

    const targetRoot = resolve(glmDir, plugin.stagedPath);
    mkdirSync(targetRoot, { recursive: true });
    for (const entryName of includedOfficialPluginTopLevelPaths) {
      const sourcePath = resolve(sourceRoot, entryName);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, resolve(targetRoot, entryName), {
        recursive: true,
        filter: shouldCopyOfficialPluginAsset,
      });
    }
    for (const relativePath of plugin.requiredSeedPaths ?? []) {
      const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
      if (!existsSync(stagedAssetPath)) {
        throw new Error(
          `[prepare:agent-bundle] missing staged official plugin seed asset: ${stagedAssetPath}`,
        );
      }
    }
    console.log(`[prepare:agent-bundle] staged official plugin ${plugin.stagedPath}`);
  }
}

function stageBundledSkillPack() {
  const sourceRoot = resolve(repoRoot, bundledSkillPack.relativePath);
  const targetRoot = resolve(glmDir, bundledSkillPack.stagedPath);
  mkdirSync(targetRoot, { recursive: true });
  for (const entryName of bundledSkillPack.topLevelPaths) {
    const sourcePath = resolve(sourceRoot, entryName);
    if (!existsSync(sourcePath)) continue;
    cpSync(sourcePath, resolve(targetRoot, entryName), {
      recursive: true,
      filter: shouldCopyOfficialPluginAsset,
    });
  }
  for (const relativePath of bundledSkillPack.requiredPaths) {
    const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
    if (!existsSync(stagedAssetPath)) {
      throw new Error(
        `[prepare:agent-bundle] missing staged bundled skill asset: ${stagedAssetPath}`,
      );
    }
  }
  console.log(`[prepare:agent-bundle] staged bundled skill pack ${bundledSkillPack.stagedPath}`);
}

// stdio MCP 的 npm/npx 回退（用户没装 Node 时由 Electron Node 运行随包 npm）。
// tarball 按 sha512 缓存在 node_modules/.cache，重复打包不再下载。
async function stageBundledNpmRuntime() {
  const stagedRoot = await stageBundledNpm({
    cacheDir: resolve(repoRoot, "node_modules", ".cache", "zcode-bundled-npm"),
    glmDir,
  });
  console.log(`[prepare:agent-bundle] staged npm@${BUNDLED_NPM_VERSION} into ${stagedRoot}`);
}

function stageSharpForNodeReplPlugin() {
  if (!isSharpRequiredByComputerUse({ desktopPackageRoot: desktopRoot })) {
    console.log(
      "[prepare:agent-bundle] Computer Use package does not declare sharp, skip sharp staging",
    );
    return;
  }
  // `sharp` 仍然外部化——它包含无法内联的 native .node，运行时从**所在包**的 node_modules
  // 解析。2026-09-11 起 node_repl 宿主的 bundle 归 @zcode/node-repl-host，所以 sharp 必须
  // stage 到宿主目录，否则宿主里的 `import sharp` 在打包后的 app 里解析不到。
  // CUA screenshot / get_app_state 的 native 依赖仍要放进 CUA plugin 自己的 node_modules；
  // Browser Use 目录保留一份兼容 staging。三份 staging 都位于 plugin 子目录下，避免
  // electron-builder 过滤 extraResources 根目录的 node_modules。
  const pluginStagedDirs = [
    [NODE_REPL_HOST_PACKAGE_NAME, resolve(glmDir, "packages", "node-repl-host")],
    [BROWSER_USE_PLUGIN_PACKAGE_NAME, resolve(glmDir, "packages", "browser-use-plugin")],
    [CUA_PLUGIN_PACKAGE_NAME, resolve(glmDir, "packages", "zcode-cua-plugin")],
  ];
  for (const [packageName, pluginStagedDir] of pluginStagedDirs) {
    if (!existsSync(resolve(pluginStagedDir, ".zcode-plugin", "plugin.json"))) {
      console.log(`[prepare:agent-bundle] ${packageName} not staged, skip sharp staging`);
      continue;
    }
    stageSharpIntoBundledAgents({
      desktopPackageRoot: desktopRoot,
      glmDir: pluginStagedDir,
      targetPlatform: { os: platform, arch },
    });
    console.log(
      `[prepare:agent-bundle] staged sharp into ${resolve(pluginStagedDir, "node_modules")} (${platform}-${arch})`,
    );
  }
}

function stageKoffiForCuaPlugin() {
  const cuaPluginStagedDir = resolve(glmDir, "packages", "zcode-cua-plugin");
  if (!existsSync(resolve(cuaPluginStagedDir, ".zcode-plugin", "plugin.json"))) {
    console.log("[prepare:agent-bundle] zcode-cua-plugin not staged, skip koffi staging");
    return;
  }
  stageKoffiIntoBundledAgents({
    koffiPackageRoot: adaptersRoot,
    glmDir: cuaPluginStagedDir,
    targetPlatform: { os: platform, arch },
  });
  console.log(
    `[prepare:agent-bundle] staged koffi into ${resolve(cuaPluginStagedDir, "node_modules")} (${platform}-${arch})`,
  );
}

// 修复原因：Electron 生产包只带 resources/glm/zcode.cjs 时，app-server 进程的
// __dirname 附近没有官方插件目录，启动时 seed 找不到 source，用户侧不会自动得到内置插件。
// 这里把官方插件按 bootstrap 的 rootCandidates 期望放到 glm/packages/*-plugin，
// 让 Electron Node 运行 zcode.cjs 时复用同一套 filesystem seed 逻辑。
// browser-use runtime 的声明生成依赖 @zcode/core/dist。CI 干净检出没有该产物，
// 必须先构建 CLI 依赖，再构建官方插件；开发机残留的 dist 曾掩盖这个顺序问题。
buildCliBundle();
buildOfficialPluginRuntimes();
await stageBundle();
stageOfficialPlugins();
stageBundledSkillPack();
await stageBundledNpmRuntime();
stageKoffiForCuaPlugin();
stageSharpForNodeReplPlugin();
