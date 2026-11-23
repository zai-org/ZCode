import {
  execFile as execFileCallback,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { windowsPathToGitBashPath } from "@zcode/contracts";
import type { ExecutionShellDialect } from "@zcode/contracts";
import type { StartupShellDialect } from "./bash-startup-script.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_TIMEOUT_MS = 10_000;
const SNAPSHOT_MAX_BUFFER_BYTES = 1_048_576;

export const DEFAULT_SHELL_INIT_SNAPSHOT_RETENTION_DAYS = 30;

type ShellInitSnapshotExecFile = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ShellInitSnapshotExecFile = async (file, args, options) => {
  const execFileAsync = promisify(execFileCallback);
  const result = await execFileAsync(file, args, options);
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
};

export type ShellInitSnapshotDialect = Extract<ExecutionShellDialect, "posix" | "git-bash">;
export type ShellInitSnapshotShellKind = "bash" | "zsh" | "sh";

export interface ShellInitSnapshot {
  path: string;
  shellPath: string;
}

export interface ShellInitSnapshotCleanupResult {
  deleted: number;
  errors: number;
}

export interface CleanupStaleShellInitSnapshotsOptions {
  now?: Date;
  retentionDays?: number;
  rootDir: string;
}

export interface ShellInitSnapshotRequest {
  env: NodeJS.ProcessEnv;
  rootDir: string;
  shellDialect: StartupShellDialect;
  shellPath: string;
}

export interface ShellInitSnapshotManagerOptions {
  execFile?: ShellInitSnapshotExecFile;
}

export function shellInitSnapshotsDir(rootDir: string): string {
  return join(rootDir, "shell-snapshots");
}

export class ShellInitSnapshotCleanupRegistry {
  private readonly paths = new Set<string>();

  register(snapshotPath: string): void {
    this.paths.add(snapshotPath);
  }

  async cleanupAll(): Promise<ShellInitSnapshotCleanupResult> {
    const paths = Array.from(this.paths);
    this.paths.clear();
    let deleted = 0;
    let errors = 0;

    for (const path of paths) {
      try {
        await unlink(path);
        deleted += 1;
      } catch (error) {
        if (isMissingFileError(error)) continue;
        errors += 1;
      }
    }

    return { deleted, errors };
  }
}

export class ShellInitSnapshotManager {
  private readonly cache = new Map<string, Promise<ShellInitSnapshot | undefined>>();
  private readonly cleanupRegistry = new ShellInitSnapshotCleanupRegistry();
  private readonly execFile: ShellInitSnapshotExecFile;

  constructor(options: ShellInitSnapshotManagerOptions = {}) {
    this.execFile = options.execFile ?? defaultExecFile;
  }

  getOrCreate(request: ShellInitSnapshotRequest): Promise<ShellInitSnapshot | undefined> {
    if (!supportsShellInitSnapshot(request.shellDialect) || request.shellPath.length === 0) {
      return Promise.resolve(undefined);
    }

    const snapshotRequest = {
      ...request,
      shellDialect: request.shellDialect,
    };
    const key = cacheKey(snapshotRequest);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const created = this.create(snapshotRequest).catch(() => undefined);
    this.cache.set(key, created);
    return created;
  }

  async cleanup(): Promise<ShellInitSnapshotCleanupResult> {
    return await this.cleanupRegistry.cleanupAll();
  }

  private async create(
    request: ShellInitSnapshotRequest & { shellDialect: ShellInitSnapshotDialect },
  ): Promise<ShellInitSnapshot | undefined> {
    const shellKind = detectShellKind(request.shellPath);
    const snapshotsDir = shellInitSnapshotsDir(request.rootDir);
    await mkdir(snapshotsDir, { recursive: true });

    const snapshotPath = join(snapshotsDir, createSnapshotFileName(shellKind));
    const snapshotShellPath =
      request.shellDialect === "git-bash"
        ? windowsPathToGitBashPath(snapshotPath)
        : snapshotPath;
    const configPath = detectShellInitConfigPath({
      env: request.env,
      shellPath: request.shellPath,
    });
    const pathValue = await this.resolveSnapshotPathValue(request);
    const creationScript = buildShellInitSnapshotCreationScript({
      configExists: existsSync(configPath),
      configPath,
      pathValue,
      shellKind,
      snapshotPath,
    });

    await this.execFile(request.shellPath, ["-c", "-l", creationScript], {
      encoding: "utf8",
      env: request.env,
      maxBuffer: SNAPSHOT_MAX_BUFFER_BYTES,
      timeout: SNAPSHOT_TIMEOUT_MS,
      windowsHide: true,
    });

    try {
      const snapshotStat = await stat(snapshotPath);
      if (!snapshotStat.isFile()) return undefined;
    } catch {
      return undefined;
    }

    const result: ShellInitSnapshot = {
      path: snapshotPath,
      shellPath: snapshotShellPath,
    };
    this.cleanupRegistry.register(result.path);
    return result;
  }

  private async resolveSnapshotPathValue(
    request: ShellInitSnapshotRequest & { shellDialect: ShellInitSnapshotDialect },
  ): Promise<string> {
    if (request.shellDialect !== "git-bash") return request.env.PATH ?? "";

    try {
      const result = await this.execFile(request.shellPath, ["-lc", 'echo "$PATH"'], {
        encoding: "utf8",
        env: request.env,
        maxBuffer: SNAPSHOT_MAX_BUFFER_BYTES,
        timeout: SNAPSHOT_TIMEOUT_MS,
        windowsHide: true,
      });
      return withPreinstalledBinFirst(result.stdout.trim(), request.env) || request.env.PATH || "";
    } catch {
      return request.env.PATH ?? "";
    }
  }
}

/** Agent PATH 第一项就是 Host 注入的预装入口目录；只有桌面 Host 注入变量时才成立。 */
function gitBashPreinstalledBin(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.ZCODE_PREINSTALLED_TOOLS_AVAILABLE) return undefined;
  // Windows 环境变量不区分大小写，普通对象里可能是 Path。
  const agentPath = Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1];
  const first = agentPath?.split(";")[0];
  return first ? windowsPathToGitBashPath(first) : undefined;
}

/**
 * 根因：Git Bash 登录 profile 把 ~/bin、/ucrt64/bin、/usr/bin 放到 <bin> 之前，Git 自带的 pdftotext
 * 因此抢先于预装入口。不能改用 Agent PATH，否则 System32 的 find、sort 会排到 /usr/bin 之前。
 */
function withPreinstalledBinFirst(loginPath: string, env: NodeJS.ProcessEnv): string {
  const bin = gitBashPreinstalledBin(env);
  if (!loginPath || !bin) return loginPath;
  const others = loginPath.split(":").filter((item) => item.toLowerCase() !== bin.toLowerCase());
  return [bin, ...others].join(":");
}

/** 没有快照时命令走登录 shell，同样要恢复入口目录的位置。 */
export function gitBashPreinstalledPathExport(env: NodeJS.ProcessEnv): string | undefined {
  const bin = gitBashPreinstalledBin(env);
  return bin ? `export PATH=${shellQuoteAlways(bin)}:"$PATH"` : undefined;
}

export async function cleanupStaleShellInitSnapshots(
  options: CleanupStaleShellInitSnapshotsOptions,
): Promise<ShellInitSnapshotCleanupResult> {
  const snapshotsDir = shellInitSnapshotsDir(options.rootDir);
  const retentionDays = options.retentionDays ?? DEFAULT_SHELL_INIT_SNAPSHOT_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const cutoffMs = now.getTime() - retentionDays * DAY_MS;
  const result: ShellInitSnapshotCleanupResult = { deleted: 0, errors: 0 };

  let entries;
  try {
    entries = await readdir(snapshotsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return result;
    return { deleted: 0, errors: 1 };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sh")) continue;

    const entryPath = join(snapshotsDir, entry.name);
    try {
      const fileStat = await stat(entryPath);
      if (fileStat.mtimeMs >= cutoffMs) continue;
      await unlink(entryPath);
      result.deleted += 1;
    } catch (error) {
      if (isMissingFileError(error)) continue;
      result.errors += 1;
    }
  }

  return result;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function supportsShellInitSnapshot(
  shellDialect: StartupShellDialect | undefined,
): shellDialect is ShellInitSnapshotDialect {
  return shellDialect === "posix" || shellDialect === "git-bash";
}

export function detectShellKind(shellPath: string): ShellInitSnapshotShellKind {
  const name = basename(shellPath).toLowerCase();
  if (name.includes("zsh")) return "zsh";
  if (name.includes("bash")) return "bash";
  return "sh";
}

export function detectShellInitConfigPath(input: {
  env: NodeJS.ProcessEnv;
  shellPath: string;
}): string {
  const home = input.env.HOME || input.env.USERPROFILE || "";
  const shellKind = detectShellKind(input.shellPath);
  if (shellKind === "zsh") return join(home, ".zshrc");
  if (shellKind === "bash") return join(home, ".bashrc");
  return join(home, ".profile");
}

export function buildShellInitSnapshotCreationScript(input: {
  configExists: boolean;
  configPath: string;
  pathValue?: string;
  shellKind: ShellInitSnapshotShellKind;
  snapshotPath: string;
}): string {
  const configSourceLine = input.configExists
    ? `source ${shellDoubleQuote(input.configPath)} < /dev/null`
    : "# No user config file to source";
  const exportLines = input.configExists
    ? snapshotExportLines(input.shellKind)
    : input.shellKind === "zsh"
      ? []
      : ['echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"'];

  return [
    `SNAPSHOT_FILE=${shellQuoteAlways(input.snapshotPath)}`,
    configSourceLine,
    "",
    "# First, create/clear the snapshot file",
    'echo "# Snapshot file" >| "$SNAPSHOT_FILE"',
    "",
    "# When this file is sourced, we first unalias to avoid conflicts",
    "# This is necessary because aliases get \"frozen\" inside function definitions at definition time,",
    "# which can cause unexpected behavior when functions use commands that conflict with aliases",
    'echo "# Unset all aliases to avoid conflicts with functions" >> "$SNAPSHOT_FILE"',
    'echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"',
    "",
    ...exportLines,
    ...pathExportLines(input.pathValue ?? ""),
    "",
    "# Exit silently on success, only report errors",
    'if [ ! -f "$SNAPSHOT_FILE" ]; then',
    '  echo "Error: Snapshot file was not created at $SNAPSHOT_FILE" >&2',
    "  exit 1",
    "fi",
  ].join("\n");
}

export async function revalidateShellInitSnapshotForExecution(
  result: ShellInitSnapshot | undefined,
): Promise<ShellInitSnapshot | undefined> {
  if (!result) return undefined;

  try {
    await access(result.path);
    return result;
  } catch {
    return undefined;
  }
}

function snapshotExportLines(shellKind: ShellInitSnapshotShellKind): string[] {
  const aliasLines = [
    'echo "# Aliases" >> "$SNAPSHOT_FILE"',
    "# Filter out winpty aliases on Windows to avoid \"stdin is not a tty\" errors",
    "# Git Bash automatically creates aliases like \"alias node='winpty node.exe'\" for",
    "# programs that need Win32 Console in mintty, but winpty fails when there's no TTY",
    'if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then',
    "  alias | grep -v \"='winpty \" | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> \"$SNAPSHOT_FILE\"",
    "else",
    "  alias | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> \"$SNAPSHOT_FILE\"",
    "fi",
  ];

  if (shellKind === "zsh") {
    return [
      'echo "# Functions" >> "$SNAPSHOT_FILE"',
      "",
      "# Force autoload all functions first",
      "typeset -f > /dev/null 2>&1",
      "",
      "# Now get user function names - filter completion functions (single underscore prefix)",
      "# but keep double-underscore helpers (e.g. __zsh_like_cd from mise, __pyenv_init)",
      "typeset +f | grep -vE '^_[^_]' | while read func; do",
      '  typeset -f "$func" >> "$SNAPSHOT_FILE"',
      "done",
      "",
      'echo "# Shell Options" >> "$SNAPSHOT_FILE"',
      "setopt | sed 's/^/setopt /' | head -n 1000 >> \"$SNAPSHOT_FILE\"",
      ...aliasLines,
    ];
  }

  return [
    'echo "# Functions" >> "$SNAPSHOT_FILE"',
    "",
    "# Force autoload all functions first",
    "declare -f > /dev/null 2>&1",
    "",
    "# Now get user function names - filter completion functions (single underscore prefix)",
    "# but keep double-underscore helpers (e.g. __zsh_like_cd from mise, __pyenv_init)",
    "declare -F | cut -d' ' -f3 | grep -vE '^_[^_]' | while read func; do",
    "  # Encode the function to base64, preserving all special characters",
    '  encoded_func=$(declare -f "$func" | base64 )',
    "  # Write the function definition to the snapshot",
    "  echo \"eval \\\"\\$(echo '$encoded_func' | base64 -d)\\\" > /dev/null 2>&1\" >> \"$SNAPSHOT_FILE\"",
    "done",
    "",
    'echo "# Shell Options" >> "$SNAPSHOT_FILE"',
    "shopt -p | head -n 1000 >> \"$SNAPSHOT_FILE\"",
    "set -o | grep \"on\" | awk '{print \"set -o \" $1}' | head -n 1000 >> \"$SNAPSHOT_FILE\"",
    'echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"',
    ...aliasLines,
  ];
}

function pathExportLines(pathValue: string): string[] {
  return [
    "",
    "# Add PATH to the file",
    "cat >> \"$SNAPSHOT_FILE\" << 'PATH_END_ZCODE_SHELL_INIT_SNAPSHOT'",
    `export PATH=${shellQuoteAlways(pathValue)}`,
    "PATH_END_ZCODE_SHELL_INIT_SNAPSHOT",
  ];
}

function createSnapshotFileName(shellKind: ShellInitSnapshotShellKind): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `snapshot-${shellKind}-${timestamp}-${random}.sh`;
}

function cacheKey(request: ShellInitSnapshotRequest): string {
  return [request.rootDir, request.shellDialect, request.shellPath].join(":");
}

function shellQuoteAlways(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellDoubleQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}
