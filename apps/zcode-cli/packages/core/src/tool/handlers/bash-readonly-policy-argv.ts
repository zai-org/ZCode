import type { BashCommandInvocation } from "./bash-command-parser.js";
import {
  READONLY_ALLOW_ANY_ARG_COMMANDS,
  READONLY_COMMAND_POLICIES,
  READONLY_MULTIWORD_COMMAND_POLICIES,
} from "./bash-readonly-policy-commands.js";
import { isSedInPlaceOption } from "./bash-readonly-policy-callbacks.js";
import {
  evaluateDirectReadonlyArgv,
  isFindWriteOption,
} from "./bash-readonly-policy-argv-direct.js";
import { isArgvAllowedByPolicy } from "./bash-readonly-policy-argv-flags.js";
import {
  hasDangerousGitGlobalOption,
  isGitReadOnlyCommand,
} from "./bash-readonly-policy-argv-git.js";
import {
  areEnvAssignmentsAllowed,
  areRedirectsAllowed,
  isUnsafeWindowsUncPath,
  stripSafeCommandWrappers,
} from "./bash-readonly-policy-argv-io.js";
import type { BashReadonlyCommandPolicy } from "./bash-readonly-policy-types.js";

// 这些命令的只读结论依赖展开后参数的形态和个数：未引用的通配符会在执行前展开成文件名，
// 文件名可以是 `--checkpoint-action=exec=...`（tar）、`-o`（iconv），或者多出一个位置参数
// 被 xxd 当成输出文件。策略只看得到展开前的 argv，所以这些命令带未引用通配符时一律不算只读；
// 引号里的模式（如 tar/unzip 的成员名 '*.md'）不受影响。
const GLOB_SENSITIVE_READONLY_COMMANDS = new Set(["iconv", "tar", "unzip", "xxd", "zipinfo"]);

export function evaluateBashReadonlyPolicy(
  commandPart: BashCommandInvocation,
): boolean | undefined {
  if (!areEnvAssignmentsAllowed(commandPart)) return false;
  if (!areRedirectsAllowed(commandPart)) return false;

  const argv = stripSafeCommandWrappers(commandPart.argv);
  if (argv.length === 0) return false;
  if (argv.some(isUnsafeWindowsUncPath)) return false;
  if (argv[0] === "git") return isGitReadOnlyCommand(argv);
  if (
    GLOB_SENSITIVE_READONLY_COMMANDS.has(argv[0] ?? "") &&
    commandPart.words.some((word) => word.hasUnquotedGlob)
  )
    return false;

  const directArgvResult = evaluateDirectReadonlyArgv(argv);
  if (directArgvResult !== undefined) return directArgvResult;

  const prefixPolicyResult = evaluateReadonlyPrefixPolicy(argv, commandPart.commandText);
  if (prefixPolicyResult !== undefined) return prefixPolicyResult;

  if (READONLY_ALLOW_ANY_ARG_COMMANDS.has(argv[0] ?? "")) return true;
  if (process.platform === "win32" && argv[0] === "xargs") return undefined;

  const policy = READONLY_COMMAND_POLICIES.get(argv[0] ?? "");
  if (!policy) return undefined;
  if (argv[0] === "cd" && argv.length > 2) return false;
  if (policy.additionalCommandIsDangerousCallback?.(commandPart.commandText, argv.slice(1)))
    return false;
  if (!isArgvAllowedByPolicy(argv, policy, argv[0] ?? "")) return false;
  if (policy.regex && !policy.regex.test(commandPart.commandText)) return false;
  return true;
}

export function hasKnownBashWriteOption(commandPart: BashCommandInvocation): boolean {
  const argv = stripSafeCommandWrappers(commandPart.argv);
  const commandName = argv[0];
  if (commandName === "sed") return argv.some(isSedInPlaceOption);
  if (commandName === "find") return argv.some(isFindWriteOption);
  if (commandName === "tree") return treeArgvHasOutputOption(argv);
  if (commandName === "git") return hasDangerousGitGlobalOption(argv);
  return false;
}

function evaluateReadonlyPrefixPolicy(
  argv: readonly string[],
  commandText: string,
): boolean | undefined {
  for (const [commandPrefix, policy] of sortedReadOnlyMultiwordPolicies()) {
    const prefixWords = commandPrefix.split(" ");
    if (!prefixWords.every((word, index) => argv[index] === word)) continue;
    const args = argv.slice(prefixWords.length);
    if (argsContainUnsafeSafeFlagText(args)) return false;
    if (policy.additionalCommandIsDangerousCallback?.(commandPrefix, args)) return false;
    if (!isArgvAllowedByPolicy(argv, policy, argv[0] ?? "", prefixWords.length)) return false;
    if (policy.regex && !policy.regex.test(commandText)) return false;
    return true;
  }
  return undefined;
}

let readOnlyMultiwordPoliciesByLength: Array<[string, BashReadonlyCommandPolicy]> | undefined;

function sortedReadOnlyMultiwordPolicies(): Array<[string, BashReadonlyCommandPolicy]> {
  readOnlyMultiwordPoliciesByLength ??= [...READONLY_MULTIWORD_COMMAND_POLICIES.entries()].sort(
    (left, right) => {
      return right[0].split(" ").length - left[0].split(" ").length;
    },
  );
  return readOnlyMultiwordPoliciesByLength;
}

function argsContainUnsafeSafeFlagText(args: readonly string[]): boolean {
  return args.some(
    (arg) => arg.includes("$") || (arg.includes("{") && (arg.includes(",") || arg.includes(".."))),
  );
}

function treeArgvHasOutputOption(argv: readonly string[]): boolean {
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index];
    if (!word) continue;
    if (word === "--") return false;
    if (word === "-o" || word === "--output" || word.startsWith("--output=")) return true;
    if (word.startsWith("-") && !word.startsWith("--") && word.slice(1).includes("o")) return true;
  }
  return false;
}
