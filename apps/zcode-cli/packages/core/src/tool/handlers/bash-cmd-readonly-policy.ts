import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import type { ExecutionShellSelection } from "@zcode/contracts";
import type { ToolRuntimePermissionCapabilityContext } from "../types.js";
import { isGitRuntimeContextUnsafe } from "./bash-git-runtime-safety.js";
import {
  hasDangerousGitGlobalOption,
  isGitReadOnlyCommand,
} from "./bash-readonly-policy-argv-git.js";

// ============================================================
// 经 cmd.exe 执行的 Bash 命令的只读判定
// ============================================================
//
// Bash AST 不能证明 CMD 命令只读（`type # & python x.py` 在 Bash 里只剩 `type`），所以这里按
// CMD 语法单独判定，而且只接受「一条简单命令 + 白名单程序」：
// - 只在实际执行器是系统目录里的 cmd.exe 时适用：Windows 上 dialect=cmd 的 path，或
//   dialect=legacy-shell 回落的 ComSpec，realpath 后须等于 %SystemRoot%\System32\cmd.exe（或 SysWOW64）。
//   POSIX 的 legacy-shell 是 /bin/sh，不适用。
// - 整串只能由白名单字符组成。CMD 的命令连接、管道、重定向、转义、变量展开、分组、@ 回显、
//   引号、分隔符（, ; =）、换行都不在白名单里，所以按空格/制表符分词就是 CMD 和程序实际看到的 argv。
// - 外部程序（findstr/where/git）要防 Agent 可写目录里的同名程序：CMD 先搜当前目录再搜 PATH，
//   当前目录和 PATH 里位于工作区内的目录都不能有同名程序。
// - UNC、\??\ 前缀和设备名（CON、NUL、COM1…）一律拒绝：前者会触发网络认证，后者会挂住或读控制台。
// 判定宁可漏放、不可错放；判不了的一律返回 false，交回原来的审批 / Plan 拒绝。

export interface CmdReadonlyHost {
  platform: NodeJS.Platform | string;
  env: NodeJS.ProcessEnv;
  /** 解析 shell 可执行文件的真实路径（链接、短名）；不存在时返回 undefined。缺省用 realpathSync.native。 */
  realpath?: (path: string) => string | undefined;
}

const DEFAULT_HOST: CmdReadonlyHost = {
  get platform() {
    return process.platform;
  },
  get env() {
    return process.env;
  },
};

let hostOverrideForTest: CmdReadonlyHost | undefined;

/** 测试用：在非 Windows 机器上模拟 cmd.exe 执行环境。传 undefined 恢复默认。 */
export function setCmdReadonlyHostForTest(host: CmdReadonlyHost | undefined): void {
  hostOverrideForTest = host;
}

/** Node 只对匹配此正则的 shell 用 `/d /s /c "<command>"` 启动（lib/child_process.js normalizeSpawnArguments）。 */
const NODE_CMD_SHELL_PATTERN = /^(?:.*\\)?cmd(?:\.exe)?$/i;

/**
 * 外部程序只接受可打印 ASCII 的一个子集：非 ASCII 字符经 ANSI 代码页 best-fit 转换后可能变成
 * `"` 等元字符（例如全角引号），不同程序的命令行解析不一，统一拒绝。
 */
const EXTERNAL_COMMAND_CHARS = /^[A-Za-z0-9 \t._\-/\\:*?+~#[\]]*$/;
/** 内置命令在 cmd.exe 内部按 UTF-16 处理，额外允许字母和组合符号（例如中文文件名），不含数字类符号。 */
const BUILTIN_COMMAND_CHARS = /^[A-Za-z0-9 \t._\-/\\:*?+~#[\]\p{L}\p{M}]*$/u;

/** UNC（\\server、//server、混合斜杠）、\\?\ / \\.\ 设备命名空间和 \??\ NT 路径前缀。 */
const NETWORK_OR_NT_PATH_PATTERN = /[\\/]{2}|[\\/]\?\?[\\/]/;

const WINDOWS_DEVICE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  "CLOCK$",
  ...Array.from({ length: 10 }, (_, index) => `COM${index}`),
  ...Array.from({ length: 10 }, (_, index) => `LPT${index}`),
]);

type CmdCommandKind = "builtin" | "external";

interface CmdReadonlyCommand {
  kind: CmdCommandKind;
  /** 外部程序在目录里查找时的主名（不含扩展名），用于同名程序检查。 */
  lookupName?: string;
  isReadOnlyArgs(args: readonly string[], context: CmdReadonlyContext): boolean;
}

interface CmdReadonlyContext {
  workingDirectory?: string;
  workspaceRoot?: string;
}

const CMD_READONLY_COMMANDS = new Map<string, CmdReadonlyCommand>([
  // dir 的所有开关都只读（/p 等待按键时 stdin 是 NUL，会立即返回）。
  ["dir", { kind: "builtin", isReadOnlyArgs: () => true }],
  ["type", { kind: "builtin", isReadOnlyArgs: () => true }],
  // findstr 没有写文件的开关（/F、/G 只读取列表文件）；不带文件时读 stdin，执行端 stdin 为 NUL。
  ["findstr", { kind: "external", lookupName: "findstr", isReadOnlyArgs: () => true }],
  ["findstr.exe", { kind: "external", lookupName: "findstr", isReadOnlyArgs: () => true }],
  ["where", { kind: "external", lookupName: "where", isReadOnlyArgs: () => true }],
  ["where.exe", { kind: "external", lookupName: "where", isReadOnlyArgs: () => true }],
  ["git", { kind: "external", lookupName: "git", isReadOnlyArgs: isCmdGitReadOnly }],
  ["git.exe", { kind: "external", lookupName: "git", isReadOnlyArgs: isCmdGitReadOnly }],
]);

/**
 * 这次 Bash 调用是否会交给 cmd.exe（或无法确认的 ComSpec）执行：`cmd`，或 Windows 上回落到 ComSpec 的
 * `legacy-shell`。为 true 时 Bash AST 不能代表实际语法。POSIX 上的 `legacy-shell` 是 /bin/sh，不在此列。
 * 只给没有审批兜底的 Memory 策略用，让它在 /bin/sh 下维持修复前的 Bash AST 判定。前台（bash.ts）对所有
 * `legacy-shell` 都不给只读，有意更严；前台改用本函数会让 POSIX `legacy-shell` 开始免审批、Plan 下放行。
 */
export function mayExecuteThroughCmd(
  selection: ExecutionShellSelection | undefined,
  host: CmdReadonlyHost = activeHost(),
): boolean {
  if (selection?.dialect === "cmd") return true;
  return selection?.dialect === "legacy-shell" && host.platform === "win32";
}

/** 实际执行器是否为 cmd.exe（与 adapters/src/exec 的 shell 解析和 Node spawn 规则对齐）。 */
export function isCmdExecutedShellSelection(
  selection: ExecutionShellSelection | undefined,
  host: CmdReadonlyHost = activeHost(),
): boolean {
  if (host.platform !== "win32" || !selection) return false;
  if (selection.dialect === "cmd") {
    // 没有 path 的 cmd 选择不是 resolver 产出的形态，无法确认执行器，按非 CMD 处理。
    return selection.path !== undefined && isTrustedSystemCmd(selection.path, host);
  }
  if (selection.dialect === "legacy-shell") {
    // legacy-shell 在 Windows 上走 `shell: ComSpec ?? "cmd.exe"`；ComSpec 缺失时的裸名同样不信任。
    return isTrustedSystemCmd(readEnv(host.env, "ComSpec") ?? "cmd.exe", host);
  }
  return false;
}

/**
 * shell 必须就是系统目录里的 cmd.exe：文件名决定 Node 是否用 `/d /s /c`，但文件本身可能不是 CMD。
 * - 必须是带盘符的完整路径。裸名 `cmd.exe`（ComSpec 缺失时的回落）由 libuv 先在子进程 cwd、也就是
 *   工作区里查找，Agent 在 Edit 模式下免审批写入同名文件即可替换整个执行器。
 * - realpath（解析链接、短名）后必须等于 `%SystemRoot%\System32\cmd.exe` 或 `SysWOW64\cmd.exe`；
 *   SystemRoot 来自进程环境（缺失时用 windir），同样经 realpath。判不了就返回 false。
 */
function isTrustedSystemCmd(shellPath: string, host: CmdReadonlyHost): boolean {
  if (!NODE_CMD_SHELL_PATTERN.test(shellPath) || !WINDOWS_DRIVE_PATH.test(shellPath)) return false;
  const realpath = host.realpath ?? realpathNative;
  const shell = realpath(shellPath);
  const systemRootValue = readEnv(host.env, "SystemRoot") ?? readEnv(host.env, "windir");
  const systemRoot =
    systemRootValue && WINDOWS_DRIVE_PATH.test(systemRootValue)
      ? realpath(systemRootValue)
      : undefined;
  if (!shell || !systemRoot) return false;
  return ["System32", "SysWOW64"].some(
    (directory) =>
      win32.join(systemRoot, directory, "cmd.exe").toLowerCase() ===
      win32.normalize(shell).toLowerCase(),
  );
}

function realpathNative(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/**
 * dialect 为 cmd / legacy-shell 的 Bash 调用是否可以按只读处理。
 * 实际执行器不是 cmd.exe（例如 POSIX 的 legacy-shell）时一律返回 false，保持 !3566 的收紧。
 */
export function isCmdShellReadOnlyCommand(
  command: string,
  context: ToolRuntimePermissionCapabilityContext | undefined,
  host: CmdReadonlyHost = activeHost(),
): boolean {
  if (!isCmdExecutedShellSelection(context?.bashShellSelection, host)) return false;

  const words = command.split(/[ \t]+/).filter((word) => word.length > 0);
  const name = words[0];
  if (!name) return false;
  const policy = CMD_READONLY_COMMANDS.get(name.toLowerCase());
  if (!policy) return false;

  const allowedChars = policy.kind === "builtin" ? BUILTIN_COMMAND_CHARS : EXTERNAL_COMMAND_CHARS;
  if (!allowedChars.test(command)) return false;
  if (NETWORK_OR_NT_PATH_PATTERN.test(command)) return false;

  const args = words.slice(1);
  if (args.some(referencesWindowsDevice)) return false;

  const runtime: CmdReadonlyContext = {
    workingDirectory: context?.workingDirectory,
    workspaceRoot: context?.workspaceRoot,
  };
  if (policy.kind === "external") {
    if (!policy.lookupName) return false;
    if (!isExternalLookupSafe(name, policy.lookupName, runtime, host)) return false;
  }
  return policy.isReadOnlyArgs(args, runtime);
}

function activeHost(): CmdReadonlyHost {
  return hostOverrideForTest ?? DEFAULT_HOST;
}

function isCmdGitReadOnly(args: readonly string[], context: CmdReadonlyContext): boolean {
  // Git for Windows 按 MSVCRT 规则拆命令行：没有引号时反斜杠是字面量，空白分词与这里一致。
  // 通配符交给 git 自己展开也可能被 C 运行时预先展开成别的参数，统一拒绝。
  if (args.some((arg) => /[*?[\]]/.test(arg))) return false;
  const argv = ["git", ...args];
  if (hasDangerousGitGlobalOption(argv)) return false;
  if (!isGitReadOnlyCommand(argv)) return false;
  return !isGitRuntimeContextUnsafe(context);
}

/** 参数里任一路径分量（按 \ / : 切分）的主名是设备名就拒绝，例如 con、src\nul.txt、/g:con。 */
function referencesWindowsDevice(arg: string): boolean {
  return arg.split(/[\\/:]/).some((component) => {
    const stem = component.split(".")[0] ?? "";
    return WINDOWS_DEVICE_NAMES.has(stem.toUpperCase());
  });
}

/** PATHEXT 缺失时 cmd.exe 的默认值。 */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

/**
 * 防「Agent 可写目录里放了同名程序」。CMD 查找外部程序时先看当前目录（不依赖
 * NoDefaultCurrentDirectoryInExePath），再按 PATH 顺序；每个目录里尝试原名和 PATHEXT 的各扩展名。
 * - PATH 条目必须是带盘符的完整路径（`C:\…`）。相对条目、根相对条目（`\bin`）和盘符相对条目（`C:bin`）
 *   由 cmd.exe 按执行目录（及其盘符）解析，与本进程的解析基准可能不同；以 `\\` 或 `//` 开头的条目
 *   （UNC、`\\?\`、`\\.\` 设备命名空间、`\\localhost\C$` 别名）无法在不访问网络的前提下证明不指向工作区。
 *   这些都直接拒绝，与命令参数里「出现双斜杠即拒绝」一致。
 * - 要检查的目录：当前目录，以及 PATH 里位于工作区或当前目录之内的条目（例如从 npm script 启动时带上的
 *   `node_modules\.bin`、激活 venv 后的 `.venv\Scripts`）。Edit 模式下写工作区文件免审批，这些目录里的
 *   同名程序可以先被写进去再借只读命令执行，所以只要其中任一目录有候选文件就拒绝，不管它在 PATH 里的先后。
 * - 候选文件用 lstat 逐个探测，不枚举目录：大小写和 8.3 短名由文件系统按与 CMD 相同的规则匹配，
 *   成本也不随目录大小增长。capability 判定接口是同步的，所以这里只能用同步 IO。
 */
function isExternalLookupSafe(
  token: string,
  lookupName: string,
  context: CmdReadonlyContext,
  host: CmdReadonlyHost,
): boolean {
  const workingDirectory = context.workingDirectory;
  if (!workingDirectory) return false;
  const pathEntries = splitPathEntries(readEnv(host.env, "PATH"));
  if (!pathEntries.every(isDriveQualifiedPathEntry)) return false;

  const writableRoots = [workingDirectory, context.workspaceRoot]
    .filter((root): root is string => Boolean(root))
    .map((root) => canonicalDirectory(root) ?? resolve(root));
  const searchDirectories = [workingDirectory];
  for (const entry of pathEntries) {
    const directory = canonicalDirectory(entry);
    if (directory === undefined) continue;
    if (writableRoots.some((root) => isWithin(directory, root, host))) {
      searchDirectories.push(entry);
      continue;
    }
    // 盘符条目经 realpath 落到 UNC / 设备命名空间（映射盘、指向共享的 junction）时，
    // 文本比较无法证明它不指回工作区（例如 \\localhost\C$），判不了就拒绝。
    if (/^[\\/]{2}/.test(directory)) return false;
  }
  const candidates = executableCandidates(token, lookupName, readEnv(host.env, "PATHEXT"));
  return !searchDirectories.some((directory) =>
    candidates.some((name) => isExistingNonDirectory(join(directory, name))),
  );
}

function executableCandidates(
  token: string,
  lookupName: string,
  pathext: string | undefined,
): string[] {
  const extensions = (pathext || DEFAULT_PATHEXT)
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith("."));
  const lowerToken = token.toLowerCase();
  return [
    ...new Set([
      lookupName,
      lowerToken,
      ...extensions.map((extension) => `${lookupName}${extension}`),
      ...extensions.map((extension) => `${lowerToken}${extension}`),
    ]),
  ];
}

function isExistingNonDirectory(path: string): boolean {
  try {
    return !lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/** 本策略接受的 Windows PATH 条目：只有带盘符的完整路径（`C:\…`），不接受 UNC 和 `\\?\`、`\\.\` 前缀。 */
export function isDriveQualifiedWindowsPathEntry(entry: string): boolean {
  return WINDOWS_DRIVE_PATH.test(entry);
}

function isDriveQualifiedPathEntry(entry: string): boolean {
  if (isDriveQualifiedWindowsPathEntry(entry)) return true;
  // 只有测试会在非 Windows 进程里走到这里（host 模拟成 win32，目录在 POSIX 文件系统上）：按原生绝对路径处理。
  return process.platform !== "win32" && entry.startsWith("/") && !entry.startsWith("//");
}

function splitPathEntries(pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  return pathValue
    .split(";")
    .map((entry) => entry.trim().replaceAll('"', ""))
    .filter((entry) => entry.length > 0);
}

/** 解析符号链接 / junction 和短名；目录不存在时返回 undefined（里面没有可执行的文件）。 */
function canonicalDirectory(path: string): string | undefined {
  try {
    return realpathSync.native(resolve(path));
  } catch {
    return undefined;
  }
}

function isWithin(path: string, root: string, host: CmdReadonlyHost): boolean {
  const fold = (value: string) => (host.platform === "win32" ? value.toLowerCase() : value);
  const relation = relative(fold(root), fold(path));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const lowerKey = key.toLowerCase();
  const actualKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === lowerKey);
  return actualKey ? env[actualKey] : undefined;
}
