import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface BashReadonlyRuntimeContext {
  workingDirectory?: string;
  workspaceRoot?: string;
}

export function analysisContainsGitCommand(
  commands: readonly { argv: readonly string[]; name: string }[],
): boolean {
  return commands.some((commandPart) => {
    const name = normalizedSimpleCommandName(commandPart.argv) ?? commandPart.name;
    return name === "git";
  });
}

export function analysisContainsGitAndDirectoryChange(
  commands: readonly { argv: readonly string[]; name: string }[],
): boolean {
  let hasGit = false;
  let hasDirectoryChange = false;
  for (const commandPart of commands) {
    const name = normalizedSimpleCommandName(commandPart.argv) ?? commandPart.name;
    hasGit ||= name === "git";
    hasDirectoryChange ||= name === "cd" || name === "pushd" || name === "popd";
  }

  // 因为 git 可能在目标目录加载 hooks/config；普通 `cd && grep/find` 仍可只读放行。
  return hasGit && hasDirectoryChange;
}

/** 任一简单命令会改 shell 的目录（cd / pushd / popd / chdir）。 */
export function analysisContainsDirectoryChange(
  commands: readonly { argv: readonly string[]; name: string }[],
): boolean {
  return commands.some((commandPart) => {
    const name = normalizedSimpleCommandName(commandPart.argv) ?? commandPart.name;
    return name === "cd" || name === "pushd" || name === "popd" || name === "chdir";
  });
}

function normalizedSimpleCommandName(argv: readonly string[]): string | undefined {
  let words = [...argv];
  for (;;) {
    if (words[0] === "command") {
      let index = 1;
      while (words[index] !== undefined && /^-p+$/.test(words[index] ?? "")) index += 1;
      if (words[index] === "--") index += 1;
      if (index >= words.length || words[index]?.startsWith("-")) return words[0];
      words = words.slice(index);
      continue;
    }
    if (words[0] === "builtin") {
      const index = words[1] === "--" ? 2 : 1;
      if (index >= words.length) return words[0];
      words = words.slice(index);
      continue;
    }
    if (words[0] === "noglob") {
      if (words.length <= 1) return words[0];
      words = words.slice(1);
      continue;
    }
    return words[0];
  }
}

type GitDirectoryState = "none" | "trusted" | "unsafe";

const MAX_GITDIR_FILE_BYTES = 32 * 1024;

export function isGitRuntimeContextUnsafe(
  context: BashReadonlyRuntimeContext | undefined,
): boolean {
  const cwd = context?.workingDirectory;
  if (!cwd) return false;

  const cwdCanonical = canonicalPath(cwd);
  if (!cwdCanonical) return true;

  const cwdDotGit = classifyDotGitDirectory(cwd, cwdCanonical);
  if (cwdDotGit === "trusted") return false;
  if (cwdDotGit === "unsafe") return true;

  let current = cwd;
  for (;;) {
    if (hasBareGitIndicators(current)) return true;

    const parent = dirname(current);
    if (parent === current) return false;

    const parentState = classifyDotGitDirectory(parent, cwdCanonical);
    if (parentState === "trusted") return false;
    if (parentState === "unsafe") return true;
    current = parent;
  }
}

function classifyDotGitDirectory(directory: string, cwdCanonical: string): GitDirectoryState {
  const dotGitPath = join(directory, ".git");
  try {
    const dotGitStat = lstatSync(dotGitPath);
    if (dotGitStat.isSymbolicLink()) {
      const target = readFileSystemLinkTarget(dotGitPath, directory);
      return target ? classifyGitDirTarget(target, cwdCanonical) : "unsafe";
    }
    if (dotGitStat.isFile()) {
      if (dotGitStat.size > MAX_GITDIR_FILE_BYTES) return "unsafe";
      const content = readFileSync(dotGitPath, "utf8");
      if (content.includes("\0")) return "unsafe";
      if (!content.startsWith("gitdir: ")) return "none";
      const targetText = content.slice("gitdir: ".length).replace(/[\r\n]+$/, "");
      return classifyGitDirTarget(
        isAbsolute(targetText) ? targetText : join(directory, targetText),
        cwdCanonical,
      );
    }
    if (dotGitStat.isDirectory()) return hasTrustedGitDirectory(dotGitPath) ? "trusted" : "none";
  } catch {
    return "none";
  }
  return "none";
}

function classifyGitDirTarget(target: string, cwdCanonical: string): GitDirectoryState {
  const targetCanonical = canonicalPath(target);
  if (!targetCanonical) return "unsafe";
  if (pathIsSameOrInside(targetCanonical, cwdCanonical)) return "unsafe";
  if (!pathHasGitSegment(targetCanonical)) return "unsafe";
  return hasValidGitHead(targetCanonical) ? "trusted" : "none";
}

function readFileSystemLinkTarget(path: string, directory: string): string | undefined {
  try {
    const target = readlinkSync(path);
    return isAbsolute(target) ? target : join(directory, target);
  } catch {
    return undefined;
  }
}

function hasTrustedGitDirectory(directory: string): boolean {
  if (!hasValidGitHead(directory)) return false;
  try {
    for (const child of ["objects", "refs"]) {
      const childPath = join(directory, child);
      if (!statSync(childPath).isDirectory()) return false;
      accessSync(childPath, constants.X_OK);
    }
    try {
      statSync(join(directory, "commondir"));
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

function hasValidGitHead(directory: string): boolean {
  try {
    const headPath = join(directory, "HEAD");
    const headStat = lstatSync(headPath);
    if (!headStat.isFile() || headStat.size > 4096) return false;
    const head = readFileSync(headPath, "utf8").slice(0, 255);
    return /^ref:[ \t]*refs\//.test(head) || /^[0-9a-f]{40}([0-9a-f]{24})?[ \t\n\r]*$/.test(head);
  } catch {
    return false;
  }
}

function hasBareGitIndicators(directory: string): boolean {
  const headPath = join(directory, "HEAD");
  try {
    const head = lstatSync(headPath);
    if (head.isFile() || head.isSymbolicLink()) return true;
  } catch {
    // 缺少 HEAD 不是裸仓库信号，继续检查 objects/refs。
  }
  return ["objects", "refs"].some((child) => pathExists(join(directory, child)));
}

function canonicalPath(path: string): string | undefined {
  try {
    return normalizeCanonicalPath(realpathSync.native(resolve(path)));
  } catch {
    return undefined;
  }
}

function normalizeCanonicalPath(path: string): string {
  return path.replace(/\\/g, "/").normalize("NFC").toLowerCase();
}

function pathIsSameOrInside(path: string, base: string): boolean {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return path === base || path.startsWith(normalizedBase);
}

function pathHasGitSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => segment.toLowerCase() === ".git");
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
