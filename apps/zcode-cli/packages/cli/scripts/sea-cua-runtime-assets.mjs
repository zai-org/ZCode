import { spawn } from "node:child_process";
import { cp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { readMachOArchs, readPeArchs } from "../../../../../scripts/native-binary-archs.mjs";
import { isRealComputerUseProducerInstalled } from "../../../../../packages/desktop/scripts/computer-use-producer.mjs";
import { stageSharpIntoBundledAgents } from "../../../../../packages/desktop/scripts/sharp-package-assets.mjs";
import { targetParts } from "./sea-targets.mjs";

export const CUA_SEA_TARGETS = Object.freeze(["darwin-arm64", "darwin-x64", "win-arm64", "win-x64"]);
export const CUA_SEA_ADDON_SEED_PATH = "native/ax_native.node";

const resolveRepositoryRoot = (root) => resolve(root, "..", "..");

/**
 * 规则见 apps/zcode-cli/docs/design/v2/cua-standalone-in-process-broker.md「发布物（SEA）」。
 * 返回 null 表示该 target 不内置 computer-use（开源占位 producer）。
 */
export async function collectCuaRuntimeFiles({
  root,
  stagingDirectory,
  target,
  addonPath,
  hostPlatform = process.platform,
  producerIsReal,
  readArchs,
  runNodeGyp,
  stageSharp,
}) {
  const repositoryRoot = resolveRepositoryRoot(root);
  const desktopPackageRoot = join(repositoryRoot, "packages", "desktop");
  const isReal = producerIsReal ?? (() => isRealComputerUseProducerInstalled({ desktopPackageRoot }));
  if (!isReal()) return null;

  const { arch, releasePlatform } = targetParts(target);
  const os = releasePlatform === "win" ? "win32" : releasePlatform;
  const cuaRoot = join(repositoryRoot, "packages", "zcode-cua");
  // 只有一份 build/Release 时，`--all` 的 darwin-x64 在 arm64 Mac 上必然架构不符；macOS 主机按 target 现编。
  const addon =
    addonPath ??
    (os === "darwin" && hostPlatform === "darwin"
      ? await buildAddon({
          arch,
          cuaRoot,
          runNodeGyp: runNodeGyp ?? defaultRunNodeGyp,
          workDirectory: join(stagingDirectory, "ax-native-build"),
        })
      : join(cuaRoot, "build", "Release", "ax_native.node"));
  const hint =
    os === hostPlatform
      ? `Run \`node-gyp rebuild --arch=${arch}\` in packages/zcode-cua.`
      : `It can only be built on ${os}; build the platforms this host supports, e.g. \`pnpm build:sea --darwin --linux\` on macOS.`;
  if (!existsSync(addon)) {
    throw new Error(`Missing ax_native.node for ${target} at ${addon}. ${hint}`);
  }
  const archs = (readArchs ?? (os === "win32" ? readPeArchs : readMachOArchs))(addon);
  if (!archs.includes(arch)) {
    throw new Error(
      `ax_native.node at ${addon} is ${archs.join(",") || "<unknown>"}, but SEA target ${target} needs ${arch}. ${hint}`,
    );
  }

  const sharpStaging = join(stagingDirectory, "sharp");
  await (stageSharp ?? defaultStageSharp)({ desktopPackageRoot, stagingDirectory: sharpStaging, os, arch });

  const files = [{ path: CUA_SEA_ADDON_SEED_PATH, sourcePath: addon }];
  for await (const sourcePath of walkFiles(join(sharpStaging, "node_modules"))) {
    files.push({
      path: ["node_modules", ...relative(join(sharpStaging, "node_modules"), sourcePath).split(sep)].join("/"),
      sourcePath,
    });
  }
  return files;
}

/**
 * 把 binding.gyp 与 src/native 复制到暂存目录再编译。不在 packages/zcode-cua 原地 rebuild：那份
 * build/Release 是桌面开发与 E2E 加载的主机架构 addon，`--all` 中途换成 x64 会让它们加载失败。
 */
async function buildAddon({ arch, cuaRoot, runNodeGyp, workDirectory }) {
  await rm(workDirectory, { force: true, recursive: true });
  await cp(join(cuaRoot, "binding.gyp"), join(workDirectory, "binding.gyp"));
  await cp(join(cuaRoot, "src", "native"), join(workDirectory, "src", "native"), { recursive: true });
  console.log(`[sea] building ax_native.node for ${arch} in ${workDirectory}`);
  await runNodeGyp({ args: ["rebuild", `--arch=${arch}`], cuaRoot, cwd: workDirectory });
  return join(workDirectory, "build", "Release", "ax_native.node");
}

function defaultRunNodeGyp({ args, cuaRoot, cwd }) {
  const requireFromCua = createRequire(join(cuaRoot, "package.json"));
  // binding.gyp 用 `node -p "require('node-addon-api').include"` 取头文件；暂存目录不在 zcode-cua 包内，
  // 用 NODE_PATH 指向 zcode-cua 解析到的 node_modules。
  const nodeModules = dirname(dirname(requireFromCua.resolve("node-addon-api")));
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [requireFromCua.resolve("node-gyp/bin/node-gyp.js"), ...args], {
      cwd,
      env: { ...process.env, NODE_PATH: nodeModules },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`node-gyp ${args.join(" ")} failed (${signal ?? code}) in ${cwd}`));
    });
  });
}

function defaultStageSharp({ desktopPackageRoot, stagingDirectory, os, arch }) {
  stageSharpIntoBundledAgents({
    desktopPackageRoot,
    glmDir: stagingDirectory,
    targetPlatform: { os, arch, key: `${os}-${arch}` },
  });
}

async function* walkFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) yield* walkFiles(fullPath);
    else if (entry.isFile()) yield fullPath;
  }
}
