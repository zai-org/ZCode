// 随包 npm：桌面 agent 跑在 Electron Node 上，用户机器没装 Node 时，stdio MCP 的 npm/npx
// 回退到这里 stage 的 npm（规格：apps/zcode-cli/docs/design/v2/mcp-node-fallback.md）。
//
// 为什么下载 registry tarball 而不是加 pnpm 依赖：仓库用 node-linker=hoisted，npm 包的
// npm/npx bin 会被链接进根 node_modules/.bin，覆盖开发者自己的 npm（新 npm 还不支持仓库
// 锁定的 Node 小版本）。这里按固定版本 + registry sha512 下载并缓存，开发工具链不受影响。
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { downloadPrebuiltArchive } from "../../../scripts/prebuilt-binary-download.mjs";
import { extractPrebuiltArchive } from "../../../scripts/prebuilt-binary-extract.mjs";

// engines.node 必须接受 Electron 自带的 Node（Electron 44 = Node 24.21）；升级时同步更新摘要。
export const BUNDLED_NPM_VERSION = "12.2.0";
export const BUNDLED_NPM_INTEGRITY =
  "sha512-ZsJjKpTnlmSXOLLXiU1xDCzC4Wlok4IwZmh/aw2KUuXytU7q6qMv/cUT7MoeSf95Slwuw/lRXYefGzGCspHPNQ==";
/** 相对 glm 目录（zcode.cjs 所在目录）的位置；与 bootstrap mcp-node-fallback.ts 同一约定。 */
export const BUNDLED_NPM_STAGED_SEGMENTS = ["node-runtime", "npm"];
const NPM_REGISTRY_TARBALL_BASE = "https://registry.npmjs.org/npm/-/";
const NPM_TARBALL_PACKAGE_DIR = "package";
const NPM_REQUIRED_ENTRIES = ["bin/npm-cli.js", "bin/npx-cli.js"];
const NPM_RUN_SCRIPT_SPAWN_ARGS = [
  "node_modules",
  "@npmcli",
  "run-script",
  "lib",
  "make-spawn-args.js",
];
const NPM_RUN_SCRIPT_SPAWN_OPTIONS = `  const spawnOpts = {
    env: spawnEnv,
    stdioString,
    stdio,
    cwd: path,
    shell: scriptShell,
  }`;
const NPM_RUN_SCRIPT_HIDDEN_SPAWN_OPTIONS = `  const spawnOpts = {
    env: spawnEnv,
    stdioString,
    stdio,
    cwd: path,
    shell: scriptShell,
    // ZCode 修改：外层隐藏参数不递归；Electron Node 的 npm 子 shell 需单独隐藏空白窗口。
    windowsHide: process.platform === 'win32' && process.versions.electron !== undefined,
  }`;
// npm help 不受支持；去掉文档与 man 页省下约 3MB。
const EXCLUDED_TOP_LEVEL_ENTRIES = new Set(["docs", "man"]);
const SHA512_PREFIX = "sha512-";

export function bundledNpmTarballUrl(version) {
  return `${NPM_REGISTRY_TARBALL_BASE}npm-${version}.tgz`;
}

/**
 * 校验并缓存 tarball，解包后拷进 `<glmDir>/node-runtime/npm`。返回 stage 后的 npm 根目录。
 * download / extract 可注入，测试无需网络。
 */
export async function stageBundledNpm({
  cacheDir,
  download = downloadPrebuiltArchive,
  extract = extractPrebuiltArchive,
  glmDir,
  integrity = BUNDLED_NPM_INTEGRITY,
  version = BUNDLED_NPM_VERSION,
}) {
  const tarballPath = await ensureVerifiedTarball({ cacheDir, download, integrity, version });
  const workDir = await mkdtemp(join(tmpdir(), "zcode-bundled-npm-"));
  try {
    extract({ archiveExt: "tgz", archivePath: tarballPath, cwd: workDir, extractDir: workDir });
    const packageRoot = join(workDir, NPM_TARBALL_PACKAGE_DIR);
    await assertNpmEntries(packageRoot);
    await patchNpmRunScriptWindowsHide(packageRoot);
    const targetRoot = join(glmDir, ...BUNDLED_NPM_STAGED_SEGMENTS);
    await rm(targetRoot, { force: true, recursive: true });
    await cp(packageRoot, targetRoot, {
      filter: (source) => !isExcludedTopLevelEntry(packageRoot, source),
      recursive: true,
    });
    return targetRoot;
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

async function ensureVerifiedTarball({ cacheDir, download, integrity, version }) {
  const tarballPath = join(cacheDir, `npm-${version}.tgz`);
  if (await isTarballValid(tarballPath, integrity)) return tarballPath;

  await mkdir(cacheDir, { recursive: true });
  const temporaryPath = `${tarballPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await download(bundledNpmTarballUrl(version), temporaryPath);
    if (!(await isTarballValid(temporaryPath, integrity))) {
      throw new Error(`[bundled-npm] sha512 mismatch for npm@${version}`);
    }
    await rename(temporaryPath, tarballPath);
    return tarballPath;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function isTarballValid(tarballPath, integrity) {
  try {
    return (await sha512Integrity(tarballPath)) === integrity;
  } catch {
    return false;
  }
}

function sha512Integrity(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha512");
    createReadStream(path)
      .on("error", rejectPromise)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolvePromise(`${SHA512_PREFIX}${hash.digest("base64")}`));
  });
}

async function assertNpmEntries(packageRoot) {
  for (const entry of NPM_REQUIRED_ENTRIES) {
    const entryPath = join(packageRoot, ...entry.split("/"));
    try {
      await access(entryPath);
    } catch (error) {
      throw new Error(`[bundled-npm] missing npm entry ${entry} in ${packageRoot}`, {
        cause: error,
      });
    }
  }
}

async function patchNpmRunScriptWindowsHide(packageRoot) {
  const sourcePath = join(packageRoot, ...NPM_RUN_SCRIPT_SPAWN_ARGS);
  const source = await readFile(sourcePath, "utf8");
  if (source.split(NPM_RUN_SCRIPT_SPAWN_OPTIONS).length !== 2) {
    throw new Error(
      "[bundled-npm] expected one run-script spawn-options block; review the npm patch",
    );
  }
  await writeFile(
    sourcePath,
    source.replace(NPM_RUN_SCRIPT_SPAWN_OPTIONS, NPM_RUN_SCRIPT_HIDDEN_SPAWN_OPTIONS),
  );
}

function isExcludedTopLevelEntry(packageRoot, source) {
  const relativePath = relative(packageRoot, source);
  return !relativePath.includes(sep) && EXCLUDED_TOP_LEVEL_ENTRIES.has(basename(source));
}
