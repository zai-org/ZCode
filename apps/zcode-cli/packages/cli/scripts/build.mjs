import { chmod, readFile, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import sharedPackage from "../../../../../packages/shared/package.json" with { type: "json" };
import { stageBuiltinProviderConfig } from "../../../../../scripts/builtin-provider-config.mjs";
import { stageThirdPartyNotices } from "../../../../../scripts/third-party-notices.mjs";

const cliRoot = resolve(import.meta.dirname, "..");
const projectRoot = resolve(cliRoot, "../..");
const executableFileMode = 0o755;
const packageJsonFile = "package.json";
const rootPackageVersionError = "Root package.json must define a non-empty string version.";
const desktopAgentBuildFlag = "--desktop-agent";
export const resolveBuildExternal = () => [
  "@zcode/tui",
  "playwright-core",
  "koffi",
  "@napi-rs/keyring",
];

export const readZodBuildVersion = async () => {
  const sharedPackage = JSON.parse(
    await readFile(resolve(projectRoot, "../../packages/shared/package.json"), "utf8"),
  );
  const version = sharedPackage.dependencies?.zod;
  if (typeof version !== "string" || !/^4\.\d+\.\d+$/.test(version)) {
    throw new Error("packages/shared must pin one exact Zod v4 version.");
  }
  return version;
};

async function readZodPackage(file, cache) {
  for (
    let directory = dirname(file);
    directory !== dirname(directory);
    directory = dirname(directory)
  ) {
    if (basename(directory) !== "zod") continue;
    if (!cache.has(directory)) {
      cache.set(
        directory,
        readFile(resolve(directory, "package.json"), "utf8").then((text) => {
          const manifest = JSON.parse(text);
          if (manifest.name !== "zod" || typeof manifest.version !== "string") {
            throw new Error(`Invalid Zod package metadata: ${directory}`);
          }
          return { root: directory, version: manifest.version };
        }),
      );
    }
    return cache.get(directory);
  }
  return undefined;
}

function assertZodVersion(pkg, expectedV4Version) {
  if (pkg.version.startsWith("4.") && pkg.version !== expectedV4Version) {
    throw new Error(`Expected Zod v4 ${expectedV4Version}, found ${pkg.version}: ${pkg.root}`);
  }
}

export async function assertZodBundleIdentity(metafile, { workingDirectory, expectedV4Version }) {
  if (!metafile) throw new Error("Zod bundle validation requires an esbuild metafile.");
  const packages = new Map();
  const cache = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (!/(?:^|[/\\])zod[/\\]/.test(input)) continue;
    const pkg = await readZodPackage(resolve(workingDirectory, input), cache);
    if (!pkg) continue;
    assertZodVersion(pkg, expectedV4Version);
    const previous = packages.get(pkg.version);
    if (previous && previous !== pkg.root) {
      throw new Error(`Duplicate Zod ${pkg.version} in bundle: ${previous}, ${pkg.root}`);
    }
    packages.set(pkg.version, pkg.root);
  }
}

export function createZodDedupePlugin({ expectedV4Version }) {
  return {
    name: "zcode-zod-dedupe",
    setup(builder) {
      const packages = new Map();
      const cache = new Map();
      // hoisted 安装可能给多个消费者留下字节相同、路径不同的 Zod。
      // 必须先按原消费者解析版本和 exports，再归并安装根，不能把 v3 alias 成 v4。
      builder.onResolve({ filter: /^zod(?:\/|$)/ }, async (args) => {
        if (args.pluginData?.zcodeZodResolving) return;
        const resolved = await builder.resolve(args.path, {
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: { zcodeZodResolving: true },
        });
        if (resolved.errors.length || resolved.external) return resolved;
        const pkg = await readZodPackage(resolved.path, cache);
        if (!pkg) throw new Error(`Cannot identify resolved Zod package: ${resolved.path}`);
        assertZodVersion(pkg, expectedV4Version);
        if (!packages.has(pkg.version)) packages.set(pkg.version, pkg.root);
        return {
          ...resolved,
          // 保留 exports 已选出的子入口和 .js/.cjs，不能再用 require.resolve 改写条件。
          path: resolve(packages.get(pkg.version), relative(pkg.root, resolved.path)),
          pluginData: args.pluginData,
        };
      });
      builder.onEnd(async (result) => {
        if (result.errors.length) return;
        await assertZodBundleIdentity(result.metafile, {
          workingDirectory: builder.initialOptions.absWorkingDir ?? process.cwd(),
          expectedV4Version,
        });
      });
    },
  };
}

export const readRootPackageVersion = async ({ root = projectRoot } = {}) => {
  const packageJson = JSON.parse(await readFile(resolve(root, packageJsonFile), "utf8"));

  if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
    throw new Error(rootPackageVersionError);
  }

  return packageJson.version;
};

export const resolveBuildOptions = (args = [], env = process.env) => {
  const desktopAgent = args.includes(desktopAgentBuildFlag);
  const e2eCoverage = env.ZCODE_E2E_COVERAGE === "1";

  return {
    // desktop-agent 正常发布仍需压缩且不携带 map；E2E coverage
    // 专用构建必须保留原始符号和 source map，c8 才能回映到各 package 的 TS 源码。
    minify: desktopAgent && !e2eCoverage,
    sourcemap: e2eCoverage || !desktopAgent,
  };
};

export const resolveBuildAliases = ({
  cliDirectory = cliRoot,
  rootDirectory = projectRoot,
} = {}) => ({
  "@zcode/shared-types": resolve(cliDirectory, "../shared-types/dist/index.js"),
  // esbuild 会按前缀改写。曾多次漏加新子路径，导致入口文件被误当成目录；
  // 直接从包的公开 exports 派生，并将通用入口放在最后，避免两份清单漂移。
  ...Object.fromEntries(
    Object.entries(sharedPackage.exports)
      .sort(([a], [b]) => Number(a === ".") - Number(b === "."))
      .map(([subpath, target]) => [
        subpath === "." ? "@zcode/shared" : `@zcode/shared/${subpath.slice(2)}`,
        resolve(rootDirectory, "../../packages/shared", target),
      ]),
  ),
  "@zcode/core": resolve(cliDirectory, "../core/dist/index.js"),
});

export const buildCli = async ({
  cliDirectory = cliRoot,
  rootDirectory = projectRoot,
  minify = false,
  sourcemap = true,
  env = process.env,
  version = readRootPackageVersion({
    root: rootDirectory,
  }),
} = {}) => {
  const cliVersion = await version;
  const outfile = resolve(cliDirectory, "dist/zcode.cjs");
  const sourcemapFile = `${outfile}.map`;

  await stageBuiltinProviderConfig({
    root: resolve(rootDirectory, "../.."),
    directory: resolve(cliDirectory, "dist/provider"),
    env,
  });

  await build({
    banner: {
      js: "#!/usr/bin/env node",
    },
    bundle: true,
    define: {
      __CLI_VERSION__: JSON.stringify(cliVersion),
    },
    entryPoints: [resolve(cliDirectory, "src/main.ts")],
    // Ink 7 and yoga-layout use top-level await, so the CJS CLI bundle loads the TUI
    // through Node's native dynamic import path instead of forcing esbuild to lower it.
    // playwright-core 依赖运行时 package assets 与 require.resolve，相比内联 bundle 必须保持外置。
    // managed headless adapter 只在显式 --browser-use=headless 时延迟加载，不影响 app-server/普通 CLI。
    // koffi 会按当前平台动态 require 原生 `.node` 文件；内联会让 esbuild 遍历所有
    // 平台产物并直接报 "No loader is configured for .node"。运行时仍从依赖包加载，
    // SEA 资源由 build-sea 的 native asset 收集阶段单独处理。
    external: resolveBuildExternal(),
    format: "cjs",
    // 桌面 app 集成只内置 zcode.cjs，旧 desktop-agent 构建复用 CLI 调试产物，
    // 未压缩且会留下指向未随包复制的 sourcemap。桌面 agent 模式压缩 JS，同时保留
    // 函数/类名，避免依赖 name 的诊断与注册逻辑被 esbuild 标识符压缩影响。
    keepNames: minify,
    legalComments: "none",
    logLevel: "info",
    minify,
    metafile: true,
    plugins: [createZodDedupePlugin({ expectedV4Version: await readZodBuildVersion() })],
    outfile,
    platform: "node",
    sourcemap,
    // target 取所有承载运行时里最低的 Node 版本：桌面用 Electron 内置 Node 24，
    // 远端 SSH 复用已部署的独立 Node v22.16 跑同一份 zcode.cjs。降到 node22 保证这份产物
    // 在两端都不会用到目标运行时不支持的语法/特性。
    target: "node22",
    alias: resolveBuildAliases({ cliDirectory, rootDirectory }),
  });

  if (!sourcemap) {
    await rm(sourcemapFile, { force: true });
  }

  await chmod(outfile, executableFileMode);
  // zcode.cjs 内联了第三方代码；dist 旁的伴随声明供发行 CLI 与统一分发包（build-zcode）复制。
  await stageThirdPartyNotices(resolve(cliDirectory, "dist"), resolve(rootDirectory, "../.."));
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await buildCli(resolveBuildOptions(process.argv.slice(2)));
}
