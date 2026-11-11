import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export interface ServerLayout {
  readonly dataBaseDir: string;
  readonly serverRoot: string;
  readonly releasesDir: string;
  readonly runDir: string;
  readonly currentFile: string;
  readonly pendingFile: string;
  readonly downgradeMarkerFile: string;
  readonly installFile: string;
  readonly componentsCacheDir: string;
  readonly stableBinDir: string;
  readonly statusFile: string;
  readonly ingressTokenFile: string;
  readonly lockFile: string;
  readonly controlEndpoint: string;
  readonly serviceDir: string;
  readonly uninstalledFile: string;
  readonly updateTransactionFile: string;
  readonly updateLockFile: string;
  /** Supervisor 写出第一份状态前失败时的诊断摘要；不参与任何状态判断（R2 §7.1）。 */
  readonly supervisorStartupFailureFile: string;
}

export function getDefaultServerDataRoot(): string {
  const configured = process.env.ZCODE_DATA_BASE_DIR?.trim();
  return join(configured || homedir(), ".zcode", "server");
}

export function resolveServerLayout(serverRoot = getDefaultServerDataRoot()): ServerLayout {
  const root = resolve(serverRoot);
  const runDir = join(root, "run");
  return {
    dataBaseDir: inferDataBaseDir(root),
    serverRoot: root,
    releasesDir: join(root, "releases"),
    runDir,
    currentFile: join(root, "current.json"),
    pendingFile: join(root, "pending.json"),
    downgradeMarkerFile: join(root, "downgrade.json"),
    installFile: join(root, "install.json"),
    componentsCacheDir: join(root, "cache", "components"),
    stableBinDir: join(root, "bin"),
    statusFile: join(runDir, "status.json"),
    ingressTokenFile: join(runDir, "ingress-token"),
    lockFile: join(runDir, "server.lock"),
    controlEndpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\zcode-server-${stablePathId(root)}`
        : join(runDir, "control.sock"),
    serviceDir: join(root, "service"),
    uninstalledFile: join(root, "uninstalled.json"),
    updateTransactionFile: join(root, "update-transaction.json"),
    updateLockFile: join(runDir, "update.lock"),
    supervisorStartupFailureFile: join(runDir, "supervisor-startup-failure.json"),
  };
}

export async function resolveCanonicalServerRoot(
  serverRoot = getDefaultServerDataRoot(),
): Promise<string> {
  // 安装前 server root 可能尚不存在；向上找到最近的存在祖先做 realpath，再拼回缺失段，
  // 这样既能收敛已有符号链接，也不会因为 ENOENT 让首次安装失效。
  let candidate = assertServerDataRoot(serverRoot);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(candidate);
      return resolve(canonical, ...missingSegments.reverse());
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

export async function resolveCanonicalServerLayout(
  serverRoot = getDefaultServerDataRoot(),
): Promise<ServerLayout> {
  return resolveServerLayout(await resolveCanonicalServerRoot(serverRoot));
}

function inferDataBaseDir(serverRoot: string): string {
  const parent = dirname(serverRoot);
  if (basename(serverRoot) === "server" && basename(parent) === ".zcode") {
    return dirname(parent);
  }
  // 非标准的显式 server root 仍保持隔离，不向其父目录扩散 Agent/SQLite 数据。
  return serverRoot;
}

export function stablePathId(pathValue: string): string {
  // Path is only used as a local endpoint name.  A short deterministic id avoids leaking
  // the full home path into a named pipe or service descriptor.
  let hash = 2166136261;
  for (const char of resolve(pathValue)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const root = normalize(resolve(rootPath));
  const candidate = normalize(resolve(candidatePath));
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.split(sep).includes(".."));
}

export interface UninstallTargetValidation {
  ok: boolean;
  reason?: "outside-server-root" | "home-directory" | "non-absolute";
  canonicalPath?: string;
}

export function validateUninstallTarget(
  serverRoot: string,
  target: string,
): UninstallTargetValidation {
  if (!isAbsolute(target)) {
    return { ok: false, reason: "non-absolute" };
  }
  const root = resolve(serverRoot);
  const canonicalPath = resolve(target);
  if (canonicalPath === resolve(homedir()) || canonicalPath === dirname(resolve(homedir()))) {
    return { ok: false, reason: "home-directory" };
  }
  if (!isPathWithin(root, canonicalPath)) {
    return { ok: false, reason: "outside-server-root", canonicalPath };
  }
  return { ok: true, canonicalPath };
}

export async function canonicalExistingPath(pathValue: string): Promise<string> {
  return await realpath(pathValue);
}

export function assertServerDataRoot(serverRoot: string): string {
  const resolved = resolve(serverRoot);
  if (!isAbsolute(resolved) || resolved === dirname(resolved)) {
    throw new Error("Invalid server data root");
  }
  return resolved;
}

export function serverDataRootFromBase(baseDir: string): string {
  return join(resolve(baseDir), ".zcode", "server");
}
