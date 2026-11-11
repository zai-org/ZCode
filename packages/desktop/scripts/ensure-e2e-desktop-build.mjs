import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const DESKTOP_DIR = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(DESKTOP_DIR, "../..");
const CACHE_DIR = resolve(DESKTOP_DIR, ".e2e-cache");
const STAMP_PATH = resolve(CACHE_DIR, "desktop-build-stamp.json");
const LOCK_PATH = resolve(CACHE_DIR, "desktop-build.lock");
const LOCK_OWNER_FILE = "owner.json";
const BUILD_LOCK_TIMEOUT_MS = 20 * 60_000;
const BUILD_LOCK_RETRY_MS = 100;
const MISSING_OWNER_GRACE_MS = 5_000;
const DEAD_OWNER_GRACE_MS = 10 * 60_000;
const SYNC_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export const E2E_DESKTOP_REQUIRED_OUTPUT_PATHS = [
  "out/main/index.js",
  "out/host/index.js",
  "out/scheduler/index.js",
  "out/extension-host/index.js",
  "out/preload/index.cjs",
  "out/preload/resourceManager.cjs",
  "out/renderer/index.html",
  "out/renderer/resource-manager.html",
];
const REQUIRED_OUTPUTS = E2E_DESKTOP_REQUIRED_OUTPUT_PATHS.map((path) =>
  resolve(DESKTOP_DIR, path),
);

export const DEFAULT_E2E_DESKTOP_BUILD_INPUTS = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "packages/desktop/scripts/build-metadata.mjs",
  "scripts/builtin-provider-config.mjs",
  "config/provider/zcode-builtin.json",
  "config/provider/zcode-builtin.test.json",
  "packages/provider-node/src/zcode-builtin-release.ts",
  "packages/desktop/scripts/run-production-build.mjs",
  "packages/desktop/tsconfig.json",
  "packages/desktop/tsconfig.host.json",
  "packages/desktop/tsconfig.main.json",
  "packages/desktop/tsconfig.preload.json",
  "packages/desktop/tsconfig.renderer.json",
  "packages/desktop/tsconfig.scheduler.json",
  "packages/desktop/tsconfig.extension-host.json",
  "packages/desktop/tsup.config.ts",
  "packages/desktop/vite.config.ts",
];

export const E2E_DESKTOP_BUILD_ENV_NAMES = [
  "CDN_DOMAIN",
  // Bugfix: tsup 会根据 CI 分支或 Tag 判断是否为正式发布构建；这些值必须参与缓存指纹，
  // 否则可能把未注入 Agent OTLP 配置的普通构建错误复用到发布场景。
  "CI",
  "CI_COMMIT_BRANCH",
  "CI_COMMIT_TAG",
  "NODE_ENV",
  "OSS_PATH_PREFIX",
  "VITE_CODING_PLAN_WEBVIEW_ORIGIN",
  // 邀请页地址被编译进 renderer，变化时必须使 E2E 构建缓存失效。
  "VITE_REWARDS_WEBVIEW_ORIGIN",
  "VITE_ZAI_OAUTH_CLIENT_ID",
  "VITE_ZAI_OAUTH_ORIGIN",
  "VITE_ZCODE_BASE_URL",
  "VITE_ZCODE_E2E_STORE_BRIDGE",
  "VITE_ZCODE_ENDPOINT_ORIGIN",
  "ZAI_BUSINESS_BASE_URL",
  "ZAI_BUSINESS_LOGIN_URL",
  "ZAI_OAUTH_CLIENT_ID",
  "ZAI_OAUTH_ORIGIN",
  "ZCODE_BASE_URL",
  "ZCODE_COMMIT",
  "ZCODE_CUA_HELPER_BUILD_ID",
  "ZCODE_ENDPOINT_ORIGIN",
  "ZCODE_ENV",
  "ZCODE_E2E_COVERAGE",
  "ZCODE_E2E_KEEP_BUILD_CACHE",
  "ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT",
  "ZCODE_PACKAGED_AGENT_OTEL_HEADERS",
  "ZCODE_PACKAGED_AGENT_OTEL_SERVICE_NAME",
  "ZCODE_PRODUCTION_BASE_URL",
  "ZCODE_TEST_BASE_URL",
];

const WORKSPACE_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/**
 * E2E 桌面包固定按 test 环境构建。
 *
 * bug 根因：从 ZCode 客户端拉起的 shell 里带有应用自身环境（实测 ZCODE_ENV=production、
 * ZCODE_BASE_URL=https://zcode.z.ai）。这些变量被 tsup 当作构建输入编译进 main/host 包，
 * 于是 `resolveZCodeEndpointOrigin` 走 production 分支、忽略 settings 里的 endpoint，
 * spec 用 fixture 起的本地 mock server 全部收不到请求，表现为大批配置类用例失败。
 * 构建前统一归一，runner 与本脚本共用同一结果；ZCODE_BASE_URL 等运行时变量也不能进入构建。
 */
export const E2E_DESKTOP_BUILD_INHERITED_ENV_NAMES = [
  "ZCODE_BASE_URL",
  "ZCODE_RUNTIME_ENV",
  "ZCODE_APP_VERSION",
  "ZCODE_BUILD_COMMIT_ID",
  "ZCODE_PROCESS_LABEL",
  "ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED",
  "ZCODE_CUA_BUNDLED_HELPER_APP_PATH",
  "ZCODE_CUA_LAUNCHER_PID",
];

export function normalizeE2EDesktopBuildEnv(env = process.env) {
  const normalized = { ...env, ZCODE_ENV: "test" };
  for (const name of E2E_DESKTOP_BUILD_INHERITED_ENV_NAMES) {
    delete normalized[name];
  }
  return normalized;
}

function listFiles(path) {
  if (!existsSync(path)) return [];
  const entries = readdirSync(path, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() ? listFiles(child) : entry.isFile() ? [child] : [];
  });
}

export function createE2EDesktopBuildFingerprint({
  env = process.env,
  gitHead = readGitHead(),
  inputPaths,
  repoRoot = REPO_ROOT,
} = {}) {
  const hash = createHash("sha256");
  hash.update(`gitHead\0${gitHead}\0`);
  for (const envName of E2E_DESKTOP_BUILD_ENV_NAMES) {
    const isSet = Object.hasOwn(env, envName) && env[envName] !== undefined;
    hash.update(`${envName}\0${isSet ? "set" : "unset"}\0${isSet ? env[envName] : ""}\0`);
  }
  const effectiveInputPaths = inputPaths ?? resolveE2EDesktopBuildInputPaths({ repoRoot });
  const files = effectiveInputPaths
    .flatMap((path) => {
      const absolutePath = resolve(repoRoot, path);
      return existsSync(absolutePath) && !readdirSafe(absolutePath)
        ? [absolutePath]
        : listFiles(absolutePath);
    })
    .sort((left, right) => left.localeCompare(right));
  for (const file of files) {
    hash.update(relative(repoRoot, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function resolveE2EDesktopBuildInputPaths({
  entryPackageName = "@zcode/desktop",
  repoRoot = REPO_ROOT,
} = {}) {
  const workspacePackages = readWorkspacePackages(repoRoot);
  const entryPackage = workspacePackages.get(entryPackageName);
  if (!entryPackage) {
    throw new Error(`Workspace package ${entryPackageName} was not found`);
  }

  const packageInputPaths = [];
  const pendingPackageNames = [entryPackageName];
  const visitedPackageNames = new Set();
  while (pendingPackageNames.length > 0) {
    const packageName = pendingPackageNames.shift();
    if (!packageName || visitedPackageNames.has(packageName)) continue;
    visitedPackageNames.add(packageName);

    const workspacePackage = workspacePackages.get(packageName);
    if (!workspacePackage) continue;
    packageInputPaths.push(workspacePackage.manifestPath, `${workspacePackage.directory}/src`);

    for (const field of WORKSPACE_DEPENDENCY_FIELDS) {
      for (const dependencyName of Object.keys(workspacePackage.manifest[field] ?? {})) {
        if (workspacePackages.has(dependencyName)) {
          pendingPackageNames.push(dependencyName);
        }
      }
    }
  }

  // Bug 根因：手写输入目录遗漏了 tsup noExternal 内联的 @zcode/server，导致同一
  // HEAD 下修改 server 仍可能命中旧 bundle。依赖图作为权威输入，新增 workspace
  // 依赖时无需再同步维护缓存白名单。
  return [...new Set([...DEFAULT_E2E_DESKTOP_BUILD_INPUTS, ...packageInputPaths])].sort();
}

function readWorkspacePackages(repoRoot) {
  const workspaceConfigPath = resolve(repoRoot, "pnpm-workspace.yaml");
  if (!existsSync(workspaceConfigPath)) return new Map();
  const workspaceConfig = parseYaml(readFileSync(workspaceConfigPath, "utf8"));
  const packagePatterns = Array.isArray(workspaceConfig?.packages) ? workspaceConfig.packages : [];
  const manifestPaths = packagePatterns
    .filter((pattern) => typeof pattern === "string" && !pattern.startsWith("!"))
    .flatMap((pattern) =>
      globSync(`${pattern.replace(/\/$/u, "")}/package.json`, { cwd: repoRoot }),
    )
    .map((path) => path.replaceAll("\\", "/"))
    .sort();
  const packages = new Map();
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, manifestPath), "utf8"));
    if (typeof manifest.name !== "string" || manifest.name.length === 0) continue;
    packages.set(manifest.name, {
      directory: manifestPath.slice(0, -"/package.json".length),
      manifest,
      manifestPath,
    });
  }
  return packages;
}

function readdirSafe(path) {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

function readGitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

export function isE2EDesktopBuildCacheHit({ fingerprint, stampPath, outputs }) {
  if (!outputs.every(isE2EDesktopBuildOutputReady) || !existsSync(stampPath)) return false;
  try {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
    return stamp.fingerprint === fingerprint;
  } catch {
    return false;
  }
}

export function ensureE2EDesktopBuild({
  buildDesktop,
  env = process.env,
  fingerprintOptions = {},
  lockOptions = {},
  lockPath = LOCK_PATH,
  outputs = REQUIRED_OUTPUTS,
  stampPath = STAMP_PATH,
} = {}) {
  return withE2EDesktopBuildLock({ ...lockOptions, lockPath }, () => {
    // Bug 根因：两个 full runner 会在锁外同时观察 miss，随后递归清理并重写同一个
    // packages/desktop/out。fingerprint 与 cache hit 必须在获得共享写锁后重新计算和检查。
    const buildEnv = normalizeE2EDesktopBuildEnv(env);
    const fingerprint = createE2EDesktopBuildFingerprint({ ...fingerprintOptions, env: buildEnv });
    const forceBuild = env.ZCODE_E2E_FORCE_DESKTOP_BUILD === "1";
    if (
      !forceBuild &&
      isE2EDesktopBuildCacheHit({
        fingerprint,
        outputs,
        stampPath,
      })
    ) {
      console.log(`[e2e-build-cache] hit ${fingerprint.slice(0, 12)}`);
      return { fingerprint, status: "hit" };
    }

    console.log(`[e2e-build-cache] miss ${fingerprint.slice(0, 12)}`);
    // 构建一旦开始，旧 stamp 就不再能证明共享 out 完整；即使后续失败时入口文件
    // 恰好已生成，也必须保持无 stamp，让下一位 lock owner 重新构建。
    rmSync(stampPath, { force: true });
    if (buildDesktop) {
      buildDesktop();
    } else {
      execFileSync("pnpm", ["--filter", "@zcode/desktop", "build:no-runtime-assets"], {
        cwd: REPO_ROOT,
        env: buildEnv,
        shell: process.platform === "win32",
        stdio: "inherit",
      });
    }
    validateE2EDesktopBuildOutputs(outputs);
    writeE2EDesktopBuildStampAtomic({ fingerprint, stampPath });
    return { fingerprint, status: "built" };
  });
}

export function validateE2EDesktopBuildOutputs(outputs) {
  const missingOutputs = outputs.filter((path) => !isE2EDesktopBuildOutputReady(path));
  if (missingOutputs.length > 0) {
    throw new Error(
      `Desktop E2E build is incomplete; missing required outputs:\n${missingOutputs.join("\n")}`,
    );
  }
}

function isE2EDesktopBuildOutputReady(path) {
  try {
    const output = statSync(path);
    return output.isFile() && output.size > 0;
  } catch {
    return false;
  }
}

export function writeE2EDesktopBuildStampAtomic({ fingerprint, stampPath }) {
  mkdirSync(dirname(stampPath), { recursive: true });
  const temporaryStampPath = `${stampPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporaryStampPath,
      `${JSON.stringify({ fingerprint, writtenAt: new Date().toISOString() }, null, 2)}\n`,
      { flag: "wx" },
    );
    renameSync(temporaryStampPath, stampPath);
  } finally {
    rmSync(temporaryStampPath, { force: true });
  }
}

export function withE2EDesktopBuildLock(
  {
    lockPath = LOCK_PATH,
    retryDelayMs = BUILD_LOCK_RETRY_MS,
    timeoutMs = BUILD_LOCK_TIMEOUT_MS,
  } = {},
  action,
) {
  const startedAt = Date.now();
  let announcedWait = false;
  let ownerToken;
  while (!ownerToken) {
    ownerToken = tryAcquireE2EDesktopBuildLock(lockPath);
    if (ownerToken) break;
    if (reclaimOrphanedE2EDesktopBuildLock(lockPath)) continue;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting ${timeoutMs}ms for Desktop E2E build lock: ${lockPath}`);
    }
    if (!announcedWait) {
      console.log(`[e2e-build-cache] waiting for shared build lock ${lockPath}`);
      announcedWait = true;
    }
    Atomics.wait(SYNC_WAIT_BUFFER, 0, 0, retryDelayMs);
  }

  try {
    const result = action();
    // 构建后的异步副本复制也必须持锁，否则另一 shard 重建 out 会混入不同 mock origin。
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).finally(() =>
        releaseE2EDesktopBuildLock(lockPath, ownerToken),
      );
    }
    releaseE2EDesktopBuildLock(lockPath, ownerToken);
    return result;
  } catch (error) {
    releaseE2EDesktopBuildLock(lockPath, ownerToken);
    throw error;
  }
}

function tryAcquireE2EDesktopBuildLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (error?.code === "EEXIST") return null;
    throw error;
  }

  const token = randomUUID();
  try {
    writeFileSync(
      resolve(lockPath, LOCK_OWNER_FILE),
      `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, token }, null, 2)}\n`,
      { flag: "wx" },
    );
    return token;
  } catch (error) {
    rmSync(lockPath, { force: true, recursive: true });
    throw error;
  }
}

function reclaimOrphanedE2EDesktopBuildLock(lockPath) {
  const owner = readE2EDesktopBuildLockOwner(lockPath);
  if (owner && isProcessAlive(owner.pid)) return false;
  if (owner) {
    const acquiredAtMs = Date.parse(owner.acquiredAt);
    if (Number.isFinite(acquiredAtMs) && Date.now() - acquiredAtMs < DEAD_OWNER_GRACE_MS) {
      return false;
    }
  } else {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < MISSING_OWNER_GRACE_MS) return false;
    } catch (error) {
      return error?.code === "ENOENT";
    }
  }

  const staleLockPath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, staleLockPath);
  } catch (error) {
    if (["EACCES", "EBUSY", "EEXIST", "ENOENT", "ENOTEMPTY", "EPERM"].includes(error?.code)) {
      return false;
    }
    throw error;
  }
  rmSync(staleLockPath, { force: true, recursive: true });
  console.warn(`[e2e-build-cache] reclaimed orphaned build lock ${lockPath}`);
  return true;
}

function readE2EDesktopBuildLockOwner(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(resolve(lockPath, LOCK_OWNER_FILE), "utf8"));
    return Number.isInteger(owner.pid) && typeof owner.token === "string" ? owner : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function releaseE2EDesktopBuildLock(lockPath, ownerToken) {
  const owner = readE2EDesktopBuildLockOwner(lockPath);
  if (owner?.token !== ownerToken) return;
  rmSync(lockPath, { force: true, recursive: true });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  ensureE2EDesktopBuild();
}
