import { isUnsafeWindowsUncPath } from "./bash-readonly-policy-argv-io.js";
import { OPTION_PATTERN, SED_SAFE_FLAGS } from "./bash-readonly-policy-flags-text.js";

const SED_QUIET_FLAGS = new Set(["-n", "--quiet", "--silent"]);
const SED_ZERO_TERMINATED_FLAGS = new Set(["-z", "--zero-terminated"]);
const SED_PRINT_COMMAND = /^(?:[1-9]\d*(?:,[1-9]\d*)?)?p$/u;
const SED_UNSUPPORTED_SCRIPT_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const SED_SUBSTITUTION_PREFIX = "s/";
const SED_SUBSTITUTION_FLAGS = /^[gpimIM]*[1-9]?[gpimIM]*$/u;
const SED_SUBSTITUTION_ESCAPES = new Set("/\\&123456789.^$*+?()[]{}|");
const SED_SUBSTITUTION_DELIMITERS = 2;

export function isSedInPlaceOption(word: string): boolean {
  return word.startsWith("-i") || word === "--in-place" || word.startsWith("--in-place=");
}

export function sedCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // 原先只排除 -i 和局部 w 语法，漏掉了脚本执行和替换写入；这里只接受完整的安全语法。
  // 复用 Bash AST 的 argv，避免再次拆分 shell 文本产生解析差异。
  let index = 0;
  let quiet = false;
  let zeroTerminated = false;
  for (; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      index += 1;
      break;
    }
    if (!arg.startsWith("-")) break;
    const flags = arg.startsWith("--") ? [arg] : [...arg.slice(1)].map((flag) => `-${flag}`);
    if (flags.length === 0 || flags.some((flag) => !Object.hasOwn(SED_SAFE_FLAGS, flag)))
      return true;
    quiet ||= flags.some((flag) => SED_QUIET_FLAGS.has(flag));
    zeroTerminated ||= flags.some((flag) => SED_ZERO_TERMINATED_FLAGS.has(flag));
  }

  const script = args[index];
  if (!script || SED_UNSUPPORTED_SCRIPT_CHARACTERS.test(script)) return true;
  const files = args.slice(index + 1);
  // GNU sed 会重排脚本后的选项；不能把后置 -e/-f/-i 当普通文件名跳过。
  if (files.some((file) => file.startsWith("-") && file !== "-")) return true;
  if (quiet && script.split(";").every((command) => SED_PRINT_COMMAND.test(command.trim()))) {
    return false;
  }
  return quiet || zeroTerminated || files.length > 0 || !isReadonlySedSubstitution(script);
}

function isReadonlySedSubstitution(script: string): boolean {
  if (!script.startsWith(SED_SUBSTITUTION_PREFIX) || script.includes(";")) return false;
  let delimiters = 0;
  let lastDelimiter = -1;
  for (let index = SED_SUBSTITUTION_PREFIX.length; index < script.length; index += 1) {
    const character = script[index];
    if (character === "\\") {
      index += 1;
      if (!SED_SUBSTITUTION_ESCAPES.has(script[index] ?? "")) return false;
    } else if (character === "/") {
      delimiters += 1;
      lastDelimiter = index;
    }
  }
  return (
    delimiters === SED_SUBSTITUTION_DELIMITERS &&
    SED_SUBSTITUTION_FLAGS.test(script.slice(lastDelimiter + 1))
  );
}

export function jqCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg) continue;
    if (isJqDangerousOption(arg)) return true;
    if (arg === "--") return jqFilterIsDangerous(args[index + 1] ?? "");
    if (arg === "--indent") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return jqFilterIsDangerous(arg);
  }
  return false;
}

function isJqDangerousOption(word: string): boolean {
  return (
    word === "-f" ||
    word.startsWith("-f") ||
    word === "-L" ||
    word.startsWith("-L") ||
    word === "--argfile" ||
    word.startsWith("--argfile=") ||
    word === "--from-file" ||
    word.startsWith("--from-file=") ||
    word === "--library-path" ||
    word.startsWith("--library-path=") ||
    word === "--rawfile" ||
    word.startsWith("--rawfile=") ||
    word === "--run-tests" ||
    word.startsWith("--run-tests=") ||
    word === "--slurpfile" ||
    word.startsWith("--slurpfile=")
  );
}

function jqFilterIsDangerous(filter: string): boolean {
  return (
    /\$ENV\b/.test(filter) ||
    /(^|[^A-Za-z0-9_$.])env(?=$|[^A-Za-z0-9_])/.test(filter) ||
    /(^|[^A-Za-z0-9_])(?:include|import)(?=$|[^A-Za-z0-9_])/.test(filter)
  );
}

export function dateCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  const valueFlags = new Set(["-d", "--date", "-r", "--reference", "--rfc-3339"]);
  for (let index = 0; index < args.length; ) {
    const arg = args[index] ?? "";
    if (arg.startsWith("--") && arg.includes("=")) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      index += valueFlags.has(arg) ? 2 : 1;
      continue;
    }
    if (!arg.startsWith("+")) return true;
    index += 1;
  }
  return false;
}

export function psCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return args.some((arg) => !arg.startsWith("-") && /^[a-zA-Z]*e[a-zA-Z]*$/.test(arg));
}

export function pyrightCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return args.some((arg) => arg === "--watch" || arg === "-w");
}

export function manCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  const aproposFlags = new Set(["-k", "-f", "--apropos", "--whatis"]);
  const valueFlags = new Set(["-S", "-s"]);
  let isApropos = false;
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-") && arg !== "-") {
      if (aproposFlags.has(arg)) isApropos = true;
      if (valueFlags.has(arg)) index += 1;
      continue;
    }
    afterDoubleDash = true;
    if (arg.includes("/")) return !isApropos;
  }
  return false;
}

export function lsofCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "+m" || arg.startsWith("+m")) return true;
    if (/^-[a-zA-Z]*i\S*@/.test(arg)) {
      const host = arg.slice(arg.indexOf("@") + 1).split(":")[0] ?? "";
      if (/[a-zA-Z]/.test(host)) return true;
    }
    if (/^-[a-zA-Z]*i$/.test(arg)) {
      const next = args[index + 1] ?? "";
      if (next.includes("@")) {
        const host = next.slice(next.indexOf("@") + 1).split(":")[0] ?? "";
        if (/[a-zA-Z]/.test(host)) return true;
      }
    }
  }
  return false;
}

const TPUT_DANGEROUS_CAPABILITIES = new Set([
  "clear",
  "flash",
  "if",
  "init",
  "iprog",
  "is1",
  "is2",
  "is3",
  "mc0",
  "mc4",
  "mc5",
  "mc5i",
  "mc5p",
  "pfkey",
  "pfloc",
  "pfx",
  "pfxl",
  "reset",
  "rf",
  "rmcup",
  "rs1",
  "rs2",
  "rs3",
  "smcup",
]);

export function tputCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; ) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      afterDoubleDash = true;
      index += 1;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      if (arg === "-S") return true;
      if (!arg.startsWith("--") && arg.length > 2 && arg.includes("S")) return true;
      index += arg === "-T" ? 2 : 1;
      continue;
    }
    if (TPUT_DANGEROUS_CAPABILITIES.has(arg)) return true;
    index += 1;
  }
  return false;
}

export function ssCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  const keywords =
    /^(dst|src|dport|sport|and|or|not|eq|ne|ge|le|gt|lt|autobound|state|exclude|dev|fwmark|cgroup)$/;
  const valueKeywords = /^(state|exclude|dport|sport|dev|fwmark|cgroup)$/;
  const valueFlags = /^(-f|--family|-A|--query|--socket)$/;
  const positional: string[] = [];
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      if (valueFlags.test(arg)) index += 1;
      continue;
    }
    positional.push(arg);
  }

  const tokens = positional
    .join(" ")
    .split(/[\s()=!<>&|,]+/)
    .filter(Boolean);
  let skipValue = false;
  for (const token of tokens) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (keywords.test(token)) {
      skipValue = valueKeywords.test(token);
      continue;
    }
    if (
      /[g-zG-Z]/.test(token) ||
      (/[a-fA-F]/.test(token) && (token.includes(".") || !token.includes(":")))
    )
      return true;
  }
  return false;
}

const TEST_NUMERIC_OPERATORS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
const TEST_SAFE_NUMBER = /^-?(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]+)$/;

export function testCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  if (
    args.some(
      (arg) => arg === "-v" || arg === "-R" || arg === "-a" || arg === "-o" || /\[/.test(arg),
    )
  )
    return true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (TEST_NUMERIC_OPERATORS.has(arg)) {
      for (const value of [args[index - 1], args[index + 1]]) {
        if (value !== undefined && !TEST_SAFE_NUMBER.test(value)) return true;
      }
    }
    if (arg === "-t") {
      const value = args[index + 1];
      if (value !== undefined && !TEST_SAFE_NUMBER.test(value)) return true;
    }
  }
  return false;
}

export const XARGS_TARGET_COMMANDS = new Set([
  "echo",
  "printf",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "head",
  "tail",
]);
const XARGS_VALUE_FLAGS = new Set(["-I", "-n", "-P", "-L", "-s", "-E", "-d"]);

export function xargsCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    let arg = args[index] ?? "";
    if (!arg) continue;
    if (arg === "--" && index + 1 < args.length) {
      index += 1;
      arg = args[index] ?? "";
    }
    if (arg.startsWith("-") && arg !== "-") {
      if (XARGS_VALUE_FLAGS.has(arg)) index += 1;
      continue;
    }
    return !XARGS_TARGET_COMMANDS.has(arg);
  }
  return false;
}

export function ghCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  for (const arg of args) {
    if (!arg) continue;
    let value = arg;
    if (arg.startsWith("-")) {
      const equalsIndex = arg.indexOf("=");
      if (equalsIndex === -1) continue;
      value = arg.slice(equalsIndex + 1);
      if (!value) continue;
    }
    if (!value.includes("/") && !value.includes("://") && !value.includes("@")) continue;
    if (value.includes("://") || value.includes("@")) return true;
    if ((value.match(/\//g) ?? []).length >= 2) return true;
  }
  return false;
}

const DOCKER_DANGEROUS_GLOBAL_FLAGS = [
  "-H",
  "-c",
  "--config",
  "--context",
  "--host",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
];
const DOCKER_DANGEROUS_SHORT_FLAGS = new Set(
  DOCKER_DANGEROUS_GLOBAL_FLAGS.filter((flag) => flag.length === 2).map((flag) => flag[1]),
);

export function dockerCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return hasDangerousDockerOption(args);
}

export function hasDangerousDockerOption(args: readonly string[]): boolean {
  return args.some((arg) => {
    if (
      DOCKER_DANGEROUS_GLOBAL_FLAGS.some(
        (flag) =>
          arg === flag ||
          arg.startsWith(`${flag}=`) ||
          (flag.length === 2 && arg.length > 2 && arg.startsWith(flag)),
      )
    )
      return true;
    const shortFlags = arg.match(/^-([A-Za-z]+)/)?.[1];
    if (shortFlags !== undefined && shortFlags.length >= 2) {
      for (const flag of shortFlags) {
        if (DOCKER_DANGEROUS_SHORT_FLAGS.has(flag)) return true;
      }
    }
    return false;
  });
}

const UNZIP_VALUE_FLAGS = new Set(["I", "O"]);
const UNZIP_LIST_MODE_FLAGS = new Set(["l", "t", "v"]);
// Info-ZIP 自己逐字解析选项：除字母外，`-`（否定后一个选项）、`:`、`^`、`$`、`/` 等也是选项字符，
// 而通用参数表只把 `-[A-Za-z0-9_-]` 开头的词当选项检查（`-:-l` 会被当成位置参数放过）。
// 所以 Info-ZIP 的每个 - 开头的词都在这里按字符白名单整体校验：只能由该模式允许的字母组成，
// -O/-I 之后的部分是字符集名。单独的 `-`、`--` 和任何其他字符都拒绝。
const UNZIP_OPTION_WORD = /^-(?=.)[Clqtv]*(?:[IO].*)?$/s;
const ZIPINFO_OPTION_WORD = /^-(?=.)[12CThlmstvz]*(?:[IO].*)?$/s;

function infoZipOptionsAreDangerous(args: readonly string[], optionWord: RegExp): boolean {
  return args.some((arg) => arg.startsWith("-") && !optionWord.test(arg));
}

export function zipinfoCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return infoZipOptionsAreDangerous(args, ZIPINFO_OPTION_WORD);
}

export function unzipCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  if (infoZipOptionsAreDangerous(args, UNZIP_OPTION_WORD)) return true;
  // 没有 -l/-v/-t 时 unzip 就是解压模式；-O/-I 的值可能贴在后面（-Olatin1），不能把值里的字母当参数。
  let hasListMode = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-") || arg.length < 2) continue;
    for (let offset = 1; offset < arg.length; offset += 1) {
      const flag = arg[offset] ?? "";
      if (UNZIP_VALUE_FLAGS.has(flag)) {
        if (offset === arg.length - 1) index += 1;
        break;
      }
      if (UNZIP_LIST_MODE_FLAGS.has(flag)) hasListMode = true;
    }
  }
  return !hasListMode;
}

const FINDSTR_VALUE_SWITCH = /^\/([acdfg]):(.*)$/is;

export function findstrCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // findstr 没有写文件的开关；/F: /G: /D: 会去读文件或目录，值是 UNC 路径时会访问网络共享。
  return args.some((arg) => {
    const match = FINDSTR_VALUE_SWITCH.exec(arg);
    if (!match || !/^[dfg]$/i.test(match[1] ?? "")) return false;
    return (match[2] ?? "").split(";").some(isUnsafeWindowsUncPath);
  });
}

export function whereCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // where.exe 只有 /R <目录>、/Q、/F、/T；其他 / 开头的词一律不认。
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("/")) continue;
    if (/^\/r$/i.test(arg)) {
      index += 1;
      continue;
    }
    if (!/^\/[fqt?]$/i.test(arg)) return true;
  }
  return false;
}

const XXD_VALUE_FLAGS = new Set([
  "-c",
  "-cols",
  "-g",
  "-groupsize",
  "-l",
  "-len",
  "-o",
  "-s",
  "-seek",
]);

export function xxdCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // xxd 在第一个文件名之后不再解析参数，紧跟的词会被当成输出文件，所以最多只允许一个位置参数。
  let positionals = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (positionals > 0) return true;
    if (arg === "--") return args.length - index - 1 > 1;
    if (arg.startsWith("-") && arg !== "-") {
      // 通用参数表不检查 `-:` 这类第二个字符不是字母数字的词，xxd 又按前缀识别参数，这里直接拒绝。
      if (!OPTION_PATTERN.test(arg)) return true;
      if (XXD_VALUE_FLAGS.has(arg)) index += 1;
      continue;
    }
    positionals += 1;
  }
  return false;
}

const TAR_NO_VALUE_SHORT_FLAGS = new Set(["J", "j", "t", "v", "z"]);
const TAR_NO_VALUE_LONG_FLAGS = new Set([
  "--bzip2",
  "--force-local",
  "--full-time",
  "--gunzip",
  "--gzip",
  "--list",
  "--no-wildcards",
  "--numeric-owner",
  "--ungzip",
  "--utc",
  "--verbose",
  "--wildcards",
  "--xz",
  "--zstd",
]);
const TAR_VALUE_LONG_FLAGS = new Set(["--exclude", "--file"]);

interface TarListState {
  archives: string[];
  forceLocal: boolean;
  list: boolean;
}

export function tarCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // 只放行列表模式（-t/--list）的白名单参数，其他模式和 --to-command、-I、-F、--rsh-command 等
  // 会执行程序的参数都不在名单里。GNU tar 把「冒号前没有 /」的归档名当成 host:path 远程归档
  // （会解析主机名并调用 rsh），Windows 盘符 D:\x.tar 也命中，所以带冒号的归档名必须配 --force-local。
  if (args.length === 1 && (args[0] === "--version" || args[0] === "--help")) return false;
  const state: TarListState = { archives: [], forceLocal: false, list: false };
  let index = 0;
  const first = args[0] ?? "";
  if (/^[A-Za-z]+$/.test(first)) {
    // 旧式写法 `tar tzf a.tgz`：首个词不带 -，需要值的字母按顺序取后面的词。
    index = 1;
    for (const flag of first) {
      if (TAR_NO_VALUE_SHORT_FLAGS.has(flag)) {
        markTarFlag(state, `-${flag}`);
        continue;
      }
      if (flag !== "f" || !acceptTarArchive(state, args[index])) return true;
      index += 1;
    }
  }
  for (; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const equalsIndex = arg.indexOf("=");
      const name = equalsIndex < 0 ? arg : arg.slice(0, equalsIndex);
      if (equalsIndex < 0 && TAR_NO_VALUE_LONG_FLAGS.has(name)) {
        markTarFlag(state, name);
        continue;
      }
      if (!TAR_VALUE_LONG_FLAGS.has(name)) return true;
      let value = arg.slice(equalsIndex + 1);
      if (equalsIndex < 0) {
        index += 1;
        value = args[index] ?? "";
        if (index >= args.length) return true;
      }
      if (name === "--file" && !acceptTarArchive(state, value)) return true;
      continue;
    }
    if (!arg.startsWith("-") || arg.length < 2) continue;
    for (let offset = 1; offset < arg.length; offset += 1) {
      const flag = arg[offset] ?? "";
      if (TAR_NO_VALUE_SHORT_FLAGS.has(flag)) {
        markTarFlag(state, `-${flag}`);
        continue;
      }
      if (flag !== "f") return true;
      const attached = arg.slice(offset + 1);
      if (!attached) index += 1;
      if (!acceptTarArchive(state, attached || args[index])) return true;
      break;
    }
  }
  if (!state.list || state.archives.length === 0) return true;
  return state.archives.some((archive) => archive.includes(":") && !state.forceLocal);
}

function markTarFlag(state: TarListState, flag: string): void {
  if (flag === "-t" || flag === "--list") state.list = true;
  if (flag === "--force-local") state.forceLocal = true;
}

function acceptTarArchive(state: TarListState, value: string | undefined): boolean {
  if (value === undefined || value === "" || (value.startsWith("-") && value !== "-")) return false;
  if (isUnsafeWindowsUncPath(value)) return false;
  state.archives.push(value);
  return true;
}

export * from "./bash-readonly-policy-git-callbacks.js";
