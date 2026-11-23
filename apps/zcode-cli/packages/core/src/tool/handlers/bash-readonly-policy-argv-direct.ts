import { READONLY_ALLOW_ANY_ARG_COMMAND_PREFIXES } from "./bash-readonly-policy-commands.js";
import {
  hasDangerousDockerOption,
  tarCommandIsDangerous,
} from "./bash-readonly-policy-callbacks.js";

const FIND_WRITE_OPTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-files0-from",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-ok",
  "-okdir",
]);

export function isFindWriteOption(word: string): boolean {
  return FIND_WRITE_OPTIONS.has(word);
}

const FIND_VALUE_OPTIONS = new Set([
  "-Bmin",
  "-Bnewer",
  "-Btime",
  "-D",
  "-amin",
  "-anewer",
  "-atime",
  "-cmin",
  "-cnewer",
  "-context",
  "-ctime",
  "-f",
  "-flags",
  "-fstype",
  "-gid",
  "-group",
  "-ilname",
  "-iname",
  "-inum",
  "-ipath",
  "-iregex",
  "-iwholename",
  "-lname",
  "-links",
  "-maxdepth",
  "-mindepth",
  "-mmin",
  "-mnewer",
  "-mtime",
  "-name",
  "-newer",
  "-path",
  "-perm",
  "-printf",
  "-regex",
  "-regextype",
  "-samefile",
  "-size",
  "-type",
  "-used",
  "-user",
  "-wholename",
  "-xattrname",
  "-xtype",
  "-uid",
]);

export function evaluateDirectReadonlyArgv(argv: readonly string[]): boolean | undefined {
  if (argvMatchesAny(argv, READONLY_EXACT_ARGV_COMMANDS)) return true;
  if (argv[0] === "docker" && argvMatchesAnyPrefix(argv, READONLY_ALLOW_ANY_ARG_COMMAND_PREFIXES))
    return !hasDangerousDockerOption(argv);
  if (argv[0] === "printf") return isSafePrintfArgv(argv);
  if (argv[0] === "find") return isSafeFindArgv(argv);
  if (argv[0] === "tar") return !tarCommandIsDangerous("", argv.slice(1));
  // `command <程序>` 已由 stripSafeCommandWrappers 剥成 <程序> 本身判定；走到这里的只有带选项的形态。
  if (argv[0] === "command") return isCommandLookupArgv(argv);
  if (argv[0] === "history")
    return argv.length === 1 || (argv.length === 2 && /^\d+$/.test(argv[1] ?? ""));
  if (argv[0] === "arch")
    return argv.length === 1 || (argv.length === 2 && (argv[1] === "-h" || argv[1] === "--help"));
  if (argv[0] === "ifconfig")
    return argv.length === 1 || (argv.length === 2 && /^[a-zA-Z]/.test(argv[1] ?? ""));
  return undefined;
}

const READONLY_EXACT_ARGV_COMMANDS = [
  ["ip", "addr"],
  ["node", "-v"],
  ["node", "--version"],
  ["python", "--version"],
  ["python3", "--version"],
] as const;

function argvMatchesAny(
  argv: readonly string[],
  expectedCommands: readonly (readonly string[])[],
): boolean {
  return expectedCommands.some((expected) => {
    return argv.length === expected.length && expected.every((word, index) => argv[index] === word);
  });
}

function argvMatchesAnyPrefix(
  argv: readonly string[],
  expectedCommands: readonly (readonly string[])[],
): boolean {
  return expectedCommands.some((expected) => {
    return argv.length >= expected.length && expected.every((word, index) => argv[index] === word);
  });
}

function isSafePrintfArgv(argv: readonly string[]): boolean {
  if (argv[1]?.startsWith("-") && argv[1] !== "--") return false;
  const formatIndex = argv[1] === "--" ? 2 : 1;
  const format = argv[formatIndex] ?? "";
  if (format.includes("$")) return false;
  const normalizedFormat = format.replace(/%%/g, "");
  if (/%[^%a-zA-Z]*(?:hh|ll|[lLhqjzZt])?\\[0-7xX]/.test(normalizedFormat)) return false;
  if (/\\[uU]/.test(normalizedFormat)) return false;
  const numericFormat = /%[-+ 0#']*[0-9.*]*(?:hh|ll|[lLhqjzZt])?[diouxXeEfFgGaAn]/.test(
    normalizedFormat,
  );
  if (numericFormat || /%[^%a-zA-Z]*\*/.test(normalizedFormat)) {
    for (let index = formatIndex + 1; index < argv.length; index += 1) {
      const value = argv[index] ?? "";
      if (value.includes("[") || value.includes("`") || value.includes("$(")) return false;
      if (
        !/^[-+]?(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?)$/.test(
          value,
        )
      )
        return false;
    }
  }
  return true;
}

function isSafeFindArgv(argv: readonly string[]): boolean {
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index] ?? "";
    if (isFindWriteOption(word)) return false;
    if (FIND_VALUE_OPTIONS.has(word) || /^-newer[aBcm][aBcmt]$/.test(word)) {
      index += 1;
      continue;
    }
  }
  return true;
}

function isCommandLookupArgv(argv: readonly string[]): boolean {
  // 只放行 `command -v/-V <名字>`：只查询名字解析到哪里，不执行程序。
  let lookup = false;
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index] ?? "";
    if (word === "--" || !word.startsWith("-")) break;
    if (!/^-[pvV]+$/.test(word)) return false;
    lookup ||= /[vV]/.test(word);
  }
  return lookup;
}
