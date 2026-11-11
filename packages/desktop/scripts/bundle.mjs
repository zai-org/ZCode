#!/usr/bin/env node

/* eslint-disable max-lines */
// 该脚本聚合了打包入口、重试策略、计时与产物校验逻辑，短期内拆文件会影响 CI 稳定性。
// 先保留集中实现，后续再按“参数解析/构建执行/产物校验”拆分模块。

import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectRuntimeModuleClosureEntries } from "./runtime-dependency-closure.mjs";
import { resolveDesktopProductIdentity } from "./desktop-product-identity.mjs";
import {
  findDesktopNativePackageViolations,
  parseAsarListWithPackState,
} from "./desktop-native-package-policy.mjs";
import {
  resolveSpawnRuntimeOptions,
  runCommand,
  runCommandAndReadStdout,
} from "../../../scripts/spawn-command.mjs";
import { resolveIntranetDepsBaseUrl } from "../../../scripts/intranetDefaults.mjs";
import { stampMacosUpdateManifests } from "./macos-update-manifest.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(desktopRoot, "../..");
const requireFromBundle = createRequire(import.meta.url);
const asarCliPath = resolve(
  dirname(requireFromBundle.resolve("@electron/asar/package.json")),
  "bin",
  "asar.js",
);
const runtimeModuleLookupRoots = [
  desktopRoot,
  workspaceRoot,
  resolve(desktopRoot, "node_modules", ".pnpm", "node_modules"),
  resolve(workspaceRoot, "node_modules", ".pnpm", "node_modules"),
];
const pnpmCommand = "pnpm";
const DEFAULT_TARGET_OS = "mac";
const DEFAULT_TARGET_ARCH = "arm64";
const desktopDistDir = process.env.ZCODE_DESKTOP_DIST_DIR || "dist";
const desktopDistRoot = resolve(desktopRoot, desktopDistDir);
const desktopProductIdentity = resolveDesktopProductIdentity(process.env);

const osAliasMap = new Map([
  ["mac", "mac"],
  ["macos", "mac"],
  ["darwin", "mac"],
  ["osx", "mac"],
  ["win", "win"],
  ["windows", "win"],
  ["win32", "win"],
  ["linux", "linux"],
]);

const archAliasMap = new Map([
  ["x64", "x64"],
  ["amd64", "x64"],
  ["x86_64", "x64"],
  ["arm64", "arm64"],
  ["aarch64", "arm64"],
]);

const osBuilderFlagMap = {
  mac: "--mac",
  win: "--win",
  linux: "--linux",
};

const archBuilderFlagMap = {
  x64: "--x64",
  arm64: "--arm64",
};

const artifactExtensionsByOs = {
  mac: [".dmg", ".zip"],
  win: [".exe"],
  linux: [".AppImage", ".deb", ".rpm", ".pkg.tar.zst"],
};
const artifactArchHintsByArch = {
  x64: ["x64", "x86_64", "amd64"],
  arm64: ["arm64", "aarch64"],
};
const commandStdoutMaxBuffer = 64 * 1024 * 1024;
const requiredRuntimeModules = [
  "module-details-from-path",
  "pngjs",
  // Bugfix: telemetry 的 OTLP exporter 在启动阶段依赖 sdk-metrics；开发态 hoist 会掩盖
  // electron-builder 漏包。最终产物必须机械校验该闭包，禁止可生成但无法启动的安装包流出。
  "@opentelemetry/sdk-metrics",
  // 与 afterPack 注入名单同口径：校验 OTLP proto 导出链（exporter → otlp-transformer → protobufjs）完整进包，
  // 缺包产物在打包阶段直接失败，而不是等安装后启动崩溃。
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/exporter-metrics-otlp-proto",
  // Bugfix: @arms/rum-core 运行时会从 CJS 入口继续 require('@babel/runtime/helpers/*')。
  // 它把 @babel/runtime 挂在 peerDependencies，pnpm workspace 开发态通常能解析，
  // 但如果生产包没把该 peer 运行时带进 app.asar，已安装应用会在主进程启动阶段直接崩溃。
  // 这里把 @babel/runtime 纳入 bundle 后机械校验，防止坏包继续流出。
  "@babel/runtime",
  // services 里的代理探测会在运行时 require("undici")。
  // 如果这里只校验 pngjs/ssh2 依赖，打包链路就会放过“产物能生成但主进程启动即缺 undici”的坏包。
  // 这里把 undici 纳入机械校验，让 bundle 阶段就能把问题拦下来。
  "undici",
  // app 自签 CA 生成用 node-forge，它内部动态 require("crypto") 内联进 ESM main bundle 会崩，
  // 因此作为外部依赖保留；生产包必须显式校验 app.asar 中存在该包，避免漏打导致启动即崩。
  "node-forge",
  // Main 静态依赖 PKIjs；收集其完整闭包并校验产物，避免 pnpm 去重后漏包。
  "pkijs",
  // 与 tsup external 对齐，保留 ZIP 解包器的 CommonJS 运行时边界。
  "yauzl",
  // Bugfix: 飞书 SDK 为了避开 Electron ESM 动态 require 崩溃会作为外部依赖保留，
  // 生产包必须显式校验 app.asar 中存在该 scoped 包。
  "@larksuiteoapi/node-sdk",
  // 26.17.0 的 pnpm collector 仍可能漏掉 deduped 传递依赖；最终包从 updater 入口校验完整闭包。
  "electron-updater",
  // ssh2 的关键依赖链（asn1/bcrypt-pbkdf/tweetnacl）若缺失，
  // 连接远程 workspace 时会在 keyParser 阶段直接抛 MODULE_NOT_FOUND。
  // 这里把 ssh2 关键依赖链纳入机械校验，避免坏包流出。
  "asn1",
  "bcrypt-pbkdf",
  "tweetnacl",
];
const electronBuilderRetryCount = 3;
const electronBuilderRetryDelayMs = 5_000;
const electronBuilderHeartbeatIntervalMs = 30_000;
export const DEFAULT_ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";
export const NPMMIRROR_ELECTRON_BUILDER_BINARIES_MIRROR =
  "https://registry.npmmirror.com/-/binary/electron-builder-binaries/";
export const OFFICIAL_ELECTRON_BUILDER_BINARIES_MIRROR =
  "https://github.com/electron-userland/electron-builder-binaries/releases/download/";

function isMisconfiguredNpmMirrorElectronRuntimeMirror(mirror) {
  return mirror
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase()
    .includes("npmmirror.com/binaries/electron");
}

export function resolveElectronMirror(env = process.env) {
  const existingMirror =
    env.NPM_CONFIG_ELECTRON_MIRROR ||
    env.npm_config_electron_mirror ||
    env.npm_package_config_electron_mirror ||
    env.ELECTRON_MIRROR;
  if (existingMirror?.trim()) {
    return existingMirror.trim();
  }

  return DEFAULT_ELECTRON_MIRROR;
}

export function createElectronRuntimeMirrorEnv(mirror) {
  return {
    ZCODE_ELECTRON_RUNTIME_MIRROR: mirror,
    // @electron/get 的 Electron runtime 环境变量是全局读取的。
    // 如果传给 electron-builder 主进程，会覆盖 dmg-builder 等 generic artifact 的 mirrorOptions。
    ELECTRON_MIRROR: "",
    NPM_CONFIG_ELECTRON_MIRROR: "",
    npm_config_electron_mirror: "",
    npm_package_config_electron_mirror: "",
  };
}

function resolveDefaultElectronBuilderBinariesMirror(env = process.env) {
  // 修复：未配置内网依赖源时（例如开源构建）内网地址解析会抛错，打包直接失败；
  // 此时回退到 electron-builder 官方 release 下载地址。内部构建行为不变。
  try {
    return `${resolveIntranetDepsBaseUrl(env)}/electron-builder-binaries/`;
  } catch {
    return OFFICIAL_ELECTRON_BUILDER_BINARIES_MIRROR;
  }
}

export function resolveElectronBuilderBinariesMirror(env = process.env) {
  const existingMirror =
    env.NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR ||
    env.npm_config_electron_builder_binaries_mirror ||
    env.npm_package_config_electron_builder_binaries_mirror ||
    env.ELECTRON_BUILDER_BINARIES_MIRROR;
  if (existingMirror?.trim()) {
    if (isMisconfiguredNpmMirrorElectronRuntimeMirror(existingMirror)) {
      // electron-builder binaries mirror 若被配成 Electron runtime 镜像，
      // 两类资源目录结构不同，dmg-builder 会被拼到 runtime 目录下导致 404。
      return NPMMIRROR_ELECTRON_BUILDER_BINARIES_MIRROR;
    }

    return existingMirror.trim();
  }

  return resolveDefaultElectronBuilderBinariesMirror(env);
}

export function createElectronBuilderBinariesMirrorEnv(mirror) {
  return {
    // 26.17.0 默认拒绝非 localhost HTTP 工具镜像。只对明确的 HTTP builder 子进程放行，
    // HTTPS 时清空父环境中的宽松开关，避免扩大到其他下载链路。
    ELECTRON_BUILDER_BINARIES_ALLOW_HTTP: /^http:\/\//i.test(mirror.trim()) ? "true" : "",
    // electron-builder 的 DOWNLOAD_OVERRIDE_URL 优先级高于 mirror。
    // CI 若把它误配到 Electron runtime 目录，会完全绕过 mirror fallback 并继续 404。
    ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL: "",
    ELECTRON_BUILDER_BINARIES_MIRROR: mirror,
    NPM_CONFIG_ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL: "",
    NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR: mirror,
    npm_config_electron_builder_binaries_download_override_url: "",
    npm_config_electron_builder_binaries_mirror: mirror,
    npm_package_config_electron_builder_binaries_download_override_url: "",
    npm_package_config_electron_builder_binaries_mirror: mirror,
  };
}

export function createBundleProcessEnvs({ os, arch, electronMirror, electronBuilderMirror }) {
  const commonEnv = {
    ZCODE_TARGET_OS: os,
    ZCODE_TARGET_ARCH: arch,
    ...createElectronRuntimeMirrorEnv(electronMirror),
  };
  const clearedElectronBuilderEnv = createElectronBuilderBinariesMirrorEnv("");

  return {
    // 资产准备和常规编译不得继承 Builder 的 HTTP 授权或工具镜像。
    buildEnv: {
      ...commonEnv,
      ...clearedElectronBuilderEnv,
    },
    electronBuilderEnv: {
      ...commonEnv,
      ...createElectronBuilderBinariesMirrorEnv(electronBuilderMirror),
    },
  };
}

export function shouldFallbackElectronBuilderBinariesMirror(output, mirror, env = process.env) {
  const normalizedOutput = output.toLowerCase();
  const normalizedMirror = mirror.trim().replace(/\/+$/, "");
  const normalizedDefaultMirror = resolveDefaultElectronBuilderBinariesMirror(env).replace(
    /\/+$/,
    "",
  );
  const isMissingBuilderBinary =
    normalizedOutput.includes("status code 404") || normalizedOutput.includes("response code 404");
  const isDefaultDepsMirror = normalizedMirror === normalizedDefaultMirror;
  // 26.17 + @electron/get 的并发下载失败经 AsyncTaskManager 聚合后只剩通用
  // "HTTPError: Response code 404"，不再带完整镜像 URL；默认内网镜像缺新工具目录时
  // 必须仍可切公共镜像重试，否则要到 ZIP/DMG 阶段才以 Cannot cleanup 暴露。
  const isDefaultDepsMirrorMissing =
    isDefaultDepsMirror && normalizedOutput.includes("electron-builder-binaries/");
  const isDefaultDepsMirrorGenericTool404 = isDefaultDepsMirror && isMissingBuilderBinary;
  const isMisconfiguredNpmMirrorElectronRuntime =
    normalizedOutput.includes("npmmirror.com/binaries/electron/") &&
    !normalizedOutput.includes("electron-builder-binaries/");

  return (
    isMissingBuilderBinary &&
    (isDefaultDepsMirrorMissing ||
      isDefaultDepsMirrorGenericTool404 ||
      isMisconfiguredNpmMirrorElectronRuntime)
  );
}

export function resolveElectronBuilderBinariesFallbackMirror(output, mirror, env = process.env) {
  if (!shouldFallbackElectronBuilderBinariesMirror(output, mirror, env)) {
    return null;
  }

  // CI 曾把 ELECTRON_BUILDER_BINARIES_MIRROR 误配到 Electron runtime 镜像目录，
  // 该目录缺 dmg-builder/appimage/nsis 等 builder 辅助包。registry.npmmirror 的 binary
  // electron-builder-binaries 路径包含这些文件，优先用国内源避免 macOS 打包 cache miss。
  return NPMMIRROR_ELECTRON_BUILDER_BINARIES_MIRROR;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function artifactNameMatchesArch(fileName, archHint) {
  // 部分环境的安装包会在架构后追加后缀（如 mac-arm64_TEST.dmg）。
  // 体积审计必须接受 "_" 作为架构后的分隔符，否则包已生成但审计阶段会误报找不到产物。
  return new RegExp(`-${escapeRegExp(archHint.toLowerCase())}(?:[._-])`, "i").test(fileName);
}

function printHelp() {
  console.log(`桌面端打包脚本

用法:
  pnpm bundle:desktop
  pnpm bundle:desktop -- --os mac --arch x64
  pnpm bundle:desktop -- linux arm64

参数:
  --os, -o <mac|win|linux>     目标操作系统，默认 mac
  --arch, -a <x64|arm64>       目标 CPU 架构，默认 arm64
  --skip-prepare               跳过 prepare:runtime-assets
  --skip-build                 跳过 pnpm build
  --dry-run                    只打印最终命令，不执行打包
  -h, --help                   查看帮助

环境变量:
  ZCODE_TARGET_OS              与 --os 等价
  ZCODE_TARGET_ARCH            与 --arch 等价
`);
}

function normalizeOs(rawOs) {
  const normalizedOs = osAliasMap.get(rawOs.toLowerCase());
  if (!normalizedOs) {
    throw new Error(`不支持的目标操作系统: ${rawOs}`);
  }
  return normalizedOs;
}

function normalizeArch(rawArch) {
  const normalizedArch = archAliasMap.get(rawArch.toLowerCase());
  if (!normalizedArch) {
    throw new Error(`不支持的目标 CPU 架构: ${rawArch}`);
  }
  return normalizedArch;
}

function parseArgs(argv) {
  const options = {
    os: process.env.ZCODE_TARGET_OS ?? null,
    arch: process.env.ZCODE_TARGET_ARCH ?? null,
    skipPrepare: process.env.ZCODE_SKIP_PREPARE === "1",
    skipBuild: process.env.ZCODE_SKIP_BUILD === "1",
    dryRun: false,
    positionals: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--skip-prepare") {
      options.skipPrepare = true;
      continue;
    }

    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }

    if (arg === "-o" || arg === "--os") {
      options.os = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith("--os=")) {
      options.os = arg.slice("--os=".length);
      continue;
    }

    if (arg === "-a" || arg === "--arch") {
      options.arch = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith("--arch=")) {
      options.arch = arg.slice("--arch=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`不支持的参数: ${arg}`);
    }

    options.positionals.push(arg);
  }

  const positionalOs = options.positionals[0];
  const positionalArch = options.positionals[1];

  if (options.positionals.length > 2) {
    throw new Error(`参数过多: ${options.positionals.join(" ")}`);
  }

  const resolvedOs = normalizeOs(options.os ?? positionalOs ?? DEFAULT_TARGET_OS);
  const resolvedArch = normalizeArch(options.arch ?? positionalArch ?? DEFAULT_TARGET_ARCH);

  return {
    os: resolvedOs,
    arch: resolvedArch,
    skipPrepare: options.skipPrepare,
    skipBuild: options.skipBuild,
    dryRun: options.dryRun,
  };
}

function run(command, args, envPatch = {}) {
  console.log(`[bundle] > ${command} ${args.join(" ")}`);

  runCommand(command, args, {
    cwd: desktopRoot,
    env: {
      ...process.env,
      ...envPatch,
    },
  });
}

function findBuiltArtifact(os, arch) {
  const distRoot = desktopDistRoot;
  const extensions = artifactExtensionsByOs[os] ?? [];
  const candidates = [];

  const archHints = artifactArchHintsByArch[arch] ?? [arch];

  for (const entry of readdirSync(distRoot, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    const fullPath = join(distRoot, entry.name);
    const lowerName = entry.name.toLowerCase();
    const matchesExtension = extensions.some((extension) =>
      lowerName.endsWith(extension.toLowerCase()),
    );
    const matchesArch = archHints.some((archHint) => artifactNameMatchesArch(lowerName, archHint));

    if (!matchesExtension || !matchesArch) {
      continue;
    }

    candidates.push({
      path: fullPath,
      mtimeMs: statSync(fullPath).mtimeMs,
    });
  }

  if (candidates.length === 0) {
    throw new Error(`未找到 ${os}/${arch} 的打包产物文件，无法执行体积审计`);
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0].path;
}
function runAndReadStdout(command, args) {
  return runCommandAndReadStdout(command, args, {
    cwd: desktopRoot,
    env: process.env,
    // `asar list app.asar` 在当前桌面包里会输出大量文件路径，
    // Node.js spawnSync 默认 1MiB stdout 缓冲不够用，会直接 ENOBUFS。
    // 显式放大缓冲，避免“校验逻辑自身读输出失败”把正常打包误报成失败。
    maxBuffer: commandStdoutMaxBuffer,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function runTimedSync(label, fn) {
  const startMs = Date.now();
  console.log(`[ci][timer] ${label} start`);
  try {
    return fn();
  } finally {
    console.log(`[ci][timer] ${label} end duration_ms=${Date.now() - startMs}`);
  }
}

async function runTimedAsync(label, fn) {
  const startMs = Date.now();
  console.log(`[ci][timer] ${label} start`);
  try {
    return await fn();
  } finally {
    console.log(`[ci][timer] ${label} end duration_ms=${Date.now() - startMs}`);
  }
}

function shouldRetryElectronBuilderFailure(output) {
  const normalizedOutput = output.toLowerCase();
  const transientSignals = [
    "github.com/electron-userland/electron-builder-binaries/releases/download",
    "electron-builder-binaries/",
    "nsis-resources-",
    'get "https://',
    " eof",
    "read: connection reset by peer",
    "connection reset by peer",
    "connectex",
    "timed out",
    "timeout",
    "socket hang up",
    "unexpected end of file",
    "err_electron_builder_cannot_execute",
  ];

  return transientSignals.some((signal) => normalizedOutput.includes(signal));
}

async function runElectronBuilderWithRetry(args, envPatch) {
  const retryEnvPatch = { ...envPatch };
  let didFallbackElectronBuilderMirror = false;

  for (let attempt = 1; attempt <= electronBuilderRetryCount; attempt += 1) {
    console.log(
      `[bundle] > ${pnpmCommand} ${args.join(" ")} ${attempt > 1 ? `(retry ${attempt}/${electronBuilderRetryCount})` : ""}`.trim(),
    );

    const mergedEnv = {
      ...process.env,
      ...retryEnvPatch,
    };
    const result = await new Promise((resolvePromise) => {
      const child = spawn(pnpmCommand, args, {
        cwd: desktopRoot,
        env: mergedEnv,
        stdio: ["inherit", "pipe", "pipe"],
        // spawn-command 已经不再导出 resolveSpawnCommand，也不希望这里把 pnpm 再改写成 *.cmd。
        // 直接复用同一套 runtime 选项，让 Windows 仍通过 shell 解析 shim，避免 CI dry-run / 真打包在模块加载阶段崩掉。
        ...resolveSpawnRuntimeOptions(pnpmCommand),
      });

      let outputBuffer = "";
      const startedAt = Date.now();
      let lastOutputAt = startedAt;
      const heartbeatTimer = setInterval(() => {
        const now = Date.now();
        // macOS codesign 阶段会长时间没有 stdout/stderr，CI 看起来像“卡死”。
        // 周期性心跳日志用于确认进程仍在运行，并给出总耗时和静默时长。
        console.log(
          `[bundle][heartbeat] electron-builder running elapsed_ms=${now - startedAt} idle_ms=${now - lastOutputAt}`,
        );
      }, electronBuilderHeartbeatIntervalMs);
      const appendOutput = (chunk, writeFn) => {
        const text = chunk.toString();
        outputBuffer += text;
        lastOutputAt = Date.now();
        writeFn(text);
      };

      child.stdout?.on("data", (chunk) =>
        appendOutput(chunk, (text) => process.stdout.write(text)),
      );
      child.stderr?.on("data", (chunk) =>
        appendOutput(chunk, (text) => process.stderr.write(text)),
      );

      child.on("error", (error) => {
        clearInterval(heartbeatTimer);
        resolvePromise({
          status: null,
          error,
          combinedOutput: `${outputBuffer}\n${error.message}`,
        });
      });

      child.on("close", (status) => {
        clearInterval(heartbeatTimer);
        resolvePromise({
          status,
          error: null,
          combinedOutput: outputBuffer,
        });
      });
    });

    if (!result.error && result.status === 0) {
      return;
    }

    const failureOutput = [
      result.combinedOutput,
      result.error?.message,
      typeof result.status === "number"
        ? `${pnpmCommand} ${args.join(" ")} failed with code ${result.status}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const currentElectronBuilderMirror = retryEnvPatch.ELECTRON_BUILDER_BINARIES_MIRROR ?? "";
    const fallbackElectronBuilderMirror = resolveElectronBuilderBinariesFallbackMirror(
      failureOutput,
      currentElectronBuilderMirror,
      process.env,
    );
    if (
      attempt < electronBuilderRetryCount &&
      !didFallbackElectronBuilderMirror &&
      fallbackElectronBuilderMirror
    ) {
      // 自建镜像源可能漏同步新架构资源，
      // 或 CI 把 builder mirror 误配到 Electron runtime 镜像目录。404 不是构建代码错误，
      // 这里只对已知缺文件/误配镜像切到 registry.npmmirror，其他显式 mirror 仍保持用户配置。
      Object.assign(
        retryEnvPatch,
        createElectronBuilderBinariesMirrorEnv(fallbackElectronBuilderMirror),
      );
      didFallbackElectronBuilderMirror = true;
      console.warn(
        `[bundle] electron-builder 二进制镜像缺文件，切换到 registry.npmmirror 后重试 (${attempt}/${electronBuilderRetryCount})`,
      );
      await sleep(electronBuilderRetryDelayMs);
      continue;
    }

    const shouldRetry =
      attempt < electronBuilderRetryCount && shouldRetryElectronBuilderFailure(failureOutput);
    if (!shouldRetry) {
      if (result.error) {
        throw result.error;
      }

      throw new Error(
        `${pnpmCommand} ${args.join(" ")} failed with code ${result.status ?? "unknown"}`,
      );
    }

    // Windows 打包机偶发在下载 NSIS 资源时被 GitHub 连接中断，electron-builder 会把这类瞬时网络错误
    // 统一折叠成 ERR_ELECTRON_BUILDER_CANNOT_EXECUTE，导致流水线把可恢复抖动误判成配置失败。
    // 这里仅对下载类信号做有限次重试，既提高首轮 cache miss 时的稳定性，也避免把真实构建错误无限吞掉。
    console.warn(
      `[bundle] electron-builder 下载资源失败，${electronBuilderRetryDelayMs}ms 后重试 (${attempt}/${electronBuilderRetryCount})`,
    );
    await sleep(electronBuilderRetryDelayMs);
  }
}

function resolveAppAsarPath(os, arch) {
  if (os === "mac") {
    return resolve(
      desktopRoot,
      desktopDistDir,
      arch === "arm64" ? "mac-arm64" : "mac",
      `${desktopProductIdentity.productName}.app`,
      "Contents",
      "Resources",
      "app.asar",
    );
  }

  if (os === "win") {
    return resolve(
      desktopRoot,
      desktopDistDir,
      arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked",
      "resources",
      "app.asar",
    );
  }

  if (os === "linux") {
    return resolve(
      desktopRoot,
      desktopDistDir,
      arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked",
      "resources",
      "app.asar",
    );
  }

  throw new Error(`不支持的目标操作系统: ${os}`);
}

function verifyPackagedRuntimeDependencies(os, arch) {
  const appAsarPath = resolveAppAsarPath(os, arch);
  if (!existsSync(appAsarPath)) {
    throw new Error(`打包产物缺少 app.asar: ${appAsarPath}`);
  }

  // pnpm hoisted 依赖布局下，electron-builder 可能把运行时代码本体装进 app.asar，
  // 却漏掉它真正解析时仍要去根 node_modules 找的子依赖。
  // 之前这里漏过 module-details-from-path，这次又出现了 @fiahfy/icns 缺 pngjs，
  // 结果都是安装包能生成，但用户启动后主进程才因为 Cannot find module 崩溃。
  // 这里在 bundle 后做一次机械校验，避免坏包继续流出去。
  const asarEntriesWithPackState = parseAsarListWithPackState(
    // pnpm exec 会把 workspace engine warning 混进 stdout，严格的 asar 行解析会误判失败。
    // 直接执行锁定版本的 CLI，让 stdout 只包含 asar pack state，不靠放宽解析器吞掉未知输出。
    runAndReadStdout(process.execPath, [asarCliPath, "list", "--is-pack", appAsarPath]),
  );
  const asarEntries = asarEntriesWithPackState.map((entry) => entry.path);

  const targetPlatformKey = `${os === "mac" ? "darwin" : os === "win" ? "win32" : os}-${arch}`;
  const nativePackageViolations = findDesktopNativePackageViolations(
    asarEntriesWithPackState,
    targetPlatformKey,
  );
  if (nativePackageViolations.length > 0) {
    // afterPack 之外再对最终 unpacked 产物做一次机械校验，避免后续 hook 或 builder
    // 重新带入其他平台 native，或者把 unpack 文件又写回 app.asar payload。
    throw new Error(`打包产物包含越界 native 资源:\n- ${nativePackageViolations.join("\n- ")}`);
  }

  const runtimeModules = collectRuntimeModuleClosureEntries(
    requiredRuntimeModules,
    runtimeModuleLookupRoots,
  );
  const resolvableRuntimeModules = runtimeModules.filter((entry) => {
    if (!entry.sourceModulePath) {
      // afterPack 会按当前平台实际可解析依赖注入；bundle 校验也需保持同口径。
      // 否则在某些 CI 安装布局中会出现“注入阶段已跳过，但校验阶段仍硬失败”的误报。
      console.warn(
        `[bundle] runtime module not found in workspace, skip verify: ${entry.moduleName}; searched=${runtimeModuleLookupRoots
          .map((lookupRoot) => resolve(lookupRoot, "node_modules", entry.moduleName))
          .join(", ")}`,
      );
      return false;
    }
    return true;
  });

  for (const { moduleName } of resolvableRuntimeModules) {
    const moduleRoot = `/node_modules/${moduleName}`;
    // @electron/asar 在 Windows 下列目录时会通过 path.join 产出反斜杠路径，
    // 之前这里按 POSIX 路径做精确匹配，导致模块其实已经打进 app.asar，校验却仍然误报缺失。
    // 先统一归一化成正斜杠，避免 Windows 打包机被这道机械校验误伤。
    const hasModule = asarEntries.some(
      (entry) => entry === moduleRoot || entry.startsWith(`${moduleRoot}/`),
    );

    if (!hasModule) {
      // 校验也按依赖闭包展开，确保 afterPack 注入逻辑遗漏子依赖时能在 bundle 阶段直接失败。
      throw new Error(`打包产物缺少运行时依赖 ${moduleName}: ${appAsarPath}`);
    }
  }
}

async function main() {
  const { os, arch, skipPrepare, skipBuild, dryRun } = parseArgs(process.argv.slice(2));
  const buildArgs = [
    "exec",
    "electron-builder",
    "--config",
    "electron-builder.config.js",
    osBuilderFlagMap[os],
    archBuilderFlagMap[arch],
  ];

  console.log(`[bundle] target=${os}/${arch}`);
  console.log(`[bundle] skipPrepare=${skipPrepare} skipBuild=${skipBuild}`);

  const { buildEnv, electronBuilderEnv } = createBundleProcessEnvs({
    os,
    arch,
    electronMirror: resolveElectronMirror(),
    electronBuilderMirror: resolveElectronBuilderBinariesMirror(),
  });

  if (dryRun) {
    console.log(`[bundle] dry-run: ${pnpmCommand} ${buildArgs.join(" ")}`);
    process.exit(0);
  }

  if (!skipPrepare) {
    run(pnpmCommand, ["prepare:runtime-assets"], buildEnv);
  }

  if (!skipBuild) {
    run(pnpmCommand, ["build"], buildEnv);
  }

  await runTimedAsync("bundle:electron-builder", () =>
    runElectronBuilderWithRetry(buildArgs, electronBuilderEnv),
  );

  await stampMacosUpdateManifests({ outputDir: desktopDistRoot, platform: os });

  runTimedSync("bundle:verify-runtime-dependencies", () =>
    verifyPackagedRuntimeDependencies(os, arch),
  );

  const artifactPath = findBuiltArtifact(os, arch);
  runTimedSync("bundle:audit-bundle-size", () =>
    run(process.execPath, [
      resolve(desktopRoot, "scripts", "audit-bundle-size.mjs"),
      "--artifact-path",
      artifactPath,
    ]),
  );
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(`[bundle] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
